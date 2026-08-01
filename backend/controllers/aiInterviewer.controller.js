/**
 * aiInterviewer.controller.js — v3
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Flow (all three difficulty tiers use the SAME architecture):
 *   1. GET  /options                       → tiers, roles, per-tier question counts
 *   2. POST /start {difficulty, role, resume_doc_id?}
 *        → monthly-limited (16/month, via featureLimitMonthly in routes);
 *          creates the session ('preparing'), enqueues the worker to batch-
 *          generate that tier's full question list in ONE Gemini call.
 *   3. GET  /session/:id                   → poll while 'preparing'; once
 *          'active', returns the full question list. Questions are asked
 *          one by one entirely on the frontend (browser TTS/STT) — no per-
 *          question network round trip is needed to ask a question.
 *   4. POST /answer {session_id, index, answer, voiceLevel, durationSec, wordCount}
 *          → records the answer + voice metrics. No Gemini call here — all
 *          scoring happens once, at /finish.
 *   5. POST /finish {session_id}           → ONE summary Gemini call →
 *          legalUnderstanding, tonality, confidence, clarity, voiceLevel,
 *          improvements. status 'complete'.
 *   6. GET  /result/:id                    → the stored summary.
 *
 * STT + TTS are entirely browser-native (Web Speech API SpeechRecognition +
 * window.speechSynthesis) — no backend audio, no third-party voice provider,
 * no /tts route. This intentionally supersedes this contract's original
 * "third-party TTS via POST /tts" line (v2) — see _decisions/decisions-log.md,
 * 2026-07-23: browser TTS/STT is $0 cost and was the founders' explicit ask;
 * the real-world tradeoff (Web Speech API voice availability/quality varies
 * by browser and OS, so "identical voice everywhere" cannot be guaranteed —
 * only "best available Indian-English voice per device") is flagged there.
 *
 * college_id filters every sessions/documents query. Optional resume grounding
 * reuses an ALREADY-ANALYZED Resume Analyzer document (documents.analysis_json)
 * rather than building a second PDF-upload pipeline in this feature — keeps
 * this build to the checklist the founders asked for ("do it in one go").
 */
const { Queue } = require('bullmq');
const { generateText } = require('../services/gemini.service');
// pool: kept for ai_usage_log inserts only (no RLS policy on that table — see
// migrations/20260726_rls_policies.sql; only users/feature_usage/documents/
// sessions/exam_attempts got FORCE ROW LEVEL SECURITY). sessions and documents
// queries below are RLS-protected, so those go through queryAsCollege with
// college_id from req.user (verified JWT via auth.middleware.js).
const { pool, queryAsCollege } = require('../config/db');
const interviewQueue = new Queue('ai-interviewer', { connection: require('../config/redisConnection') });

const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

// Tier config mirrors aiInterviewer.worker.js exactly — keep both in sync.
const TIER = {
  easy:   { inCap: 1500, outCap: 1000, minQ: 6,  maxQ: 7  },
  medium: { inCap: 1500, outCap: 2000, minQ: 8,  maxQ: 10 },
  hard:   { inCap: 2000, outCap: 3000, minQ: 10, maxQ: 12 },
};
// Founder spec: the final summary call is capped separately ("the hard
// ceiling") — in 3000 / out 1000, regardless of interview tier.
const SUMMARY_IN_CAP = 3000;
const SUMMARY_OUT_CAP = 1000;
const CHARS_PER_TOKEN = 4;
const cap = (text, tokenCap) => String(text || '').slice(0, tokenCap * CHARS_PER_TOKEN);

// "Trending roles in the market" — reflects the kinds of legal-career paths
// Voxera's law-student audience is realistically interviewing for in 2026.
const ROLES = [
  'General / Fresher',
  'Litigation Associate',
  'Corporate Law Associate',
  'Judiciary (PCS-J)',
  'In-house Counsel / Startup Legal',
  'Intellectual Property (IPR)',
  'Legal Compliance & Regulatory',
  'Legal Process Outsourcing (LPO)',
];

const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};

// Left as plain pool.query: ai_usage_log has no RLS policy (fire-and-forget
// analytics write, not one of the 5 RLS-protected tables).
const logUsage = (user_id, college_id, model, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'ai_interviewer',$3,$4,$5)`,
    [user_id, college_id, model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

// ── ownership helper ─────────────────────────────────────────────────────────
// sessions is RLS-protected — college_id is always req.user.college_id.
const loadOwnSession = async (id, user_id, college_id) => {
  const { rows } = await queryAsCollege(
    college_id,
    `SELECT * FROM sessions WHERE session_id=$1 AND user_id=$2 AND college_id=$3 AND feature_name='ai_interviewer'`,
    [id, user_id, college_id]
  );
  return rows[0] || null;
};

// Fetches a short resume-context string from an already-analyzed Resume
// Analyzer document. Ownership-checked (user_id + college_id) — never trusts
// a raw doc_id. Returns null (not 403) if the doc doesn't belong to this
// student or isn't a completed resume_analyzer document — same "404, never
// leak existence" pattern used elsewhere in this codebase; the caller here
// just silently proceeds without resume grounding rather than failing the
// whole interview over an optional field.
const loadResumeContext = async (resume_doc_id, user_id, college_id) => {
  if (!resume_doc_id) return null;
  // documents is RLS-protected — college_id is req.user.college_id.
  const { rows } = await queryAsCollege(
    college_id,
    `SELECT analysis_json FROM documents
      WHERE doc_id=$1 AND user_id=$2 AND college_id=$3
        AND feature_name='resume_analyzer' AND status='complete'`,
    [resume_doc_id, user_id, college_id]
  );
  const analysis = rows[0]?.analysis_json;
  if (!analysis || analysis.isResume === false) return null;
  return String(analysis.summary || '').slice(0, 600) || null;
};

// ── 1. options ───────────────────────────────────────────────────────────────
const getInterviewOptions = (_req, res) => {
  res.json({
    difficulties: Object.keys(TIER).map((k) => ({
      id: k,
      questionRange: `${TIER[k].minQ}-${TIER[k].maxQ}`,
    })),
    roles: ROLES,
  });
};

// ── 2. start ─────────────────────────────────────────────────────────────────
const startInterview = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const difficulty = String(req.body.difficulty || '');
    const role = ROLES.includes(req.body.role) ? req.body.role : ROLES[0];
    const resume_doc_id = req.body.resume_doc_id || null;

    if (!TIER[difficulty]) {
      return res.status(400).json({ error: 'difficulty must be easy | medium | hard' });
    }

    const resumeContext = await loadResumeContext(resume_doc_id, user_id, college_id);

    // college_id from req.user — RLS-scoped insert into sessions.
    const { rows } = await queryAsCollege(
      college_id,
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, resume_doc_id, status)
       VALUES ($1,$2,'ai_interviewer','interview',$3,$4,$5,'preparing') RETURNING session_id`,
      [user_id, college_id, difficulty, JSON.stringify({ role }), resumeContext ? resume_doc_id : null]
    );
    const sessionId = rows[0].session_id;

    await interviewQueue.add(
      'generate-questions',
      { sessionId, difficulty, role, resumeContext, user_id, college_id },
      { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
    );

    res.status(202).json({ sessionId, status: 'preparing', difficulty, role });
  } catch (err) { next(err); }
};

// ── 3. poll session ──────────────────────────────────────────────────────────
const getSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });

    if (s.status === 'preparing') return res.json({ status: 'preparing' });
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not prepare your interview. Please try again.' });

    return res.json({
      status: s.status, // active | complete
      difficulty: s.difficulty,
      role: s.filters?.role || ROLES[0],
      questions: s.questions || [],
      turnCount: s.turn_count,
      disclaimer: DISCLAIMER,
    });
  } catch (err) { next(err); }
};

// ── 4. answer (records answer + voice metrics; no Gemini call — scored at /finish) ─
const submitAnswer = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { session_id, index } = req.body;
    const answer = String(req.body.answer || '').slice(0, 4000);
    const voiceLevel = Math.max(0, Math.min(100, Number(req.body.voiceLevel) || 0));
    const durationSec = Math.max(0, Number(req.body.durationSec) || 0);
    const wordCount = Math.max(0, Number(req.body.wordCount) || answer.trim().split(/\s+/).filter(Boolean).length);

    const s = await loadOwnSession(session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This interview is not active.' });

    const questions = s.questions || [];
    const turns = s.turns || [];
    const qIndex = Number.isInteger(index) ? index : turns.length;
    const qText = questions[qIndex] || '';
    turns.push({ q: qText, a: answer, voiceLevel, durationSec, wordCount });

    const done = turns.length >= questions.length;

    // college_id already ownership-verified above via loadOwnSession.
    await queryAsCollege(
      college_id,
      `UPDATE sessions SET turns=$2, turn_count=$3 WHERE session_id=$1`,
      [session_id, JSON.stringify(turns), turns.length]
    );

    res.json({ recorded: true, questionIndex: turns.length, done, disclaimer: DISCLAIMER });
  } catch (err) { next(err); }
};

// ── 5. finish → ONE summary call ────────────────────────────────────────────
const finishInterview = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'complete' && s.summary) return res.json({ status: 'complete', result: JSON.parse(s.summary) });
    if (s.status !== 'active') return res.status(409).json({ error: 'This interview is not active.' });

    const turns = s.turns || [];
    if (turns.length === 0) return res.status(400).json({ error: 'Answer at least one question before finishing.' });

    const levels = turns.map((t) => t.voiceLevel || 0);
    const avgVoice = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
    const voiceLabel = avgVoice < 30 ? 'low' : avgVoice > 75 ? 'loud' : 'balanced';
    const totalWords = turns.reduce((a, t) => a + (t.wordCount || 0), 0);
    const totalSec = turns.reduce((a, t) => a + (t.durationSec || 0), 0);
    const wpm = totalSec > 0 ? Math.round((totalWords / totalSec) * 60) : 0;

    const transcript = turns.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a || '(no answer)'}`).join('\n\n');
    const prompt =
`You are an expert legal-interview coach evaluating a ${s.difficulty} mock interview for an Indian law
student targeting the "${s.filters?.role || 'General'}" role.
Measured speech metrics: average voice level ${avgVoice}/100 (${voiceLabel}), speaking pace ~${wpm} words/min.

Transcript:
${transcript}

Judge the student on these parameters and return STRICT JSON only:
{
  "overallScore": <0-100>,
  "legalUnderstanding": <0-100>,   // conceptual/legal correctness and depth of the answers
  "tonality": <0-100>,             // professionalism, tone, composure appropriate to an interview
  "confidence": <0-100>,
  "clarity": <0-100>,
  "voiceLevel": "low|balanced|loud",
  "summary": "<2-3 sentence overall assessment>",
  "strengths": ["<short, specific>", "..."],
  "improvements": [ { "area": "<short>", "suggestion": "<specific change the student should make>" } ]
}
Rules: set voiceLevel to "${voiceLabel}"; base every score on the actual transcript, never invent facts;
be specific and constructive; up to 6 items in "improvements" and "strengths"; keep within the output budget.`;

    let parsed, tin = 0, tout = 0, model;
    try {
      const out = await generateText({ prompt: cap(prompt, SUMMARY_IN_CAP), maxOutputTokens: SUMMARY_OUT_CAP, temperature: 0.4 });
      tin = out.tokensIn; tout = out.tokensOut; model = out.model;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, model, tin, tout);
      return res.status(502).json({ error: 'Could not generate your summary. Please try again.' });
    }
    logUsage(user_id, college_id, model, tin, tout);

    const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    const result = {
      overallScore: clamp(parsed.overallScore),
      legalUnderstanding: clamp(parsed.legalUnderstanding),
      tonality: clamp(parsed.tonality),
      confidence: clamp(parsed.confidence),
      clarity: clamp(parsed.clarity),
      voiceLevel: ['low', 'balanced', 'loud'].includes(parsed.voiceLevel) ? parsed.voiceLevel : voiceLabel,
      speechPaceWpm: wpm,
      summary: String(parsed.summary || '').slice(0, 800),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6).map((x) => String(x || '').slice(0, 200)) : [],
      improvements: Array.isArray(parsed.improvements)
        ? parsed.improvements.slice(0, 6).map((f) => ({ area: String(f.area || '').slice(0, 80), suggestion: String(f.suggestion || '').slice(0, 400) }))
        : [],
      disclaimer: DISCLAIMER,
    };

    await queryAsCollege(
      college_id,
      `UPDATE sessions SET status='complete', is_complete=TRUE, summary=$2 WHERE session_id=$1`,
      [s.session_id, JSON.stringify(result)]
    );

    res.json({ status: 'complete', result });
  } catch (err) { next(err); }
};

// ── 6. result ────────────────────────────────────────────────────────────────
const getResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    if (s.status !== 'complete' || !s.summary) return res.json({ status: s.status });
    res.json({ status: 'complete', result: JSON.parse(s.summary) });
  } catch (err) { next(err); }
};

module.exports = { getInterviewOptions, startInterview, getSession, submitAnswer, finishInterview, getResult };
