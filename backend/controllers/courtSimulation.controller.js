/**
 * courtSimulation.controller.js — v4 (first real build; was a TODO stub)
 * Contract: _contracts/05-court-simulation.md
 *
 * Flow:
 *   1. GET  /case-types                  → fields of law + positions each allows + levels
 *   2. POST /start {fieldOfLaw, position, level, studentName?}
 *        → monthly-limited (16/month, via featureLimitMonthly in routes); creates the
 *          session ('preparing'), enqueues the worker to generate the case brief
 *          (1,500 in / 1,500 out — same ceiling as a turn, founder spec).
 *   3. GET  /session/:id                 → poll while 'preparing'; once 'active', returns
 *          the brief + turn history so far.
 *   4. POST /turn {session_id, statement, voiceLevel?, durationSec?, wordCount?}
 *        → ONE Gemini call (1,500 in incl. full running context / 1,500 out — founder
 *          spec, "includes everything") → JUDGE remark (hard-clamped 100 words, "very,
 *          very small") + OPPOSITION rebuttal (clamped 250 words) + concluded flag.
 *          Student statement is hard-capped at 200 words server-side too.
 *        · Soft target: conclude by turn 11. Hard cap: turn 15 (forced).
 *   5. POST /finish {session_id}         → ONE judgment/feedback call (9,000 in / 1,200
 *          out — this build's own choice, see contract) → the judge's final judgment
 *          (≤120 words) + scored feedback (strengths/weaknesses/improvements/legal
 *          knowledge level, word-clamped to fit the founder's 500-600 word ceiling).
 *   6. GET  /result/:id                  → the stored judgment/feedback.
 *
 * Case generation runs in courtSimulation.worker.js (async), not inline here — see
 * contract for why. No refund-on-failure — matches Drafting Lab/AI Interviewer.
 */
const { Queue } = require('bullmq');
const { generateText } = require('../services/gemini.service');
// pool: still needed for ai_usage_log inserts below (that table has no RLS
// policy — see migrations/20260726_rls_policies.sql, only users/feature_usage/
// documents/sessions/exam_attempts got FORCE ROW LEVEL SECURITY — so routing
// it through queryAsCollege would add transaction overhead with no security
// benefit). Every `sessions` query DOES have RLS now, so those are switched to
// queryAsCollege(college_id, ...) below (college_id always comes from
// req.user, set by auth.middleware.js from the verified JWT).
const { pool, queryAsCollege } = require('../config/db');
const courtQueue = new Queue('court-simulation', { connection: require('../config/redisConnection') });

const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

// Founder spec (2026-07-24 voice brief), see contract for full reasoning.
const TURN_IN_CAP = 1500, TURN_OUT_CAP = 1500;
const FINISH_IN_CAP = 9000, FINISH_OUT_CAP = 1200; // this build's own choice — not founder-specified
const SOFT_CONCLUDE = 11;  // founder: "ending in ten to twelve" — midpoint
const HARD_CAP = 15;       // founder: "maximum twelve to fifteen... hard ceiling" — upper bound
const STUDENT_MAX_WORDS = 200; // founder: hard mic/statement stop at 200 words
const JUDGE_MAX_WORDS = 100;   // founder: judge's answer "stopped with hundred words"
const OPPOSITION_MAX_WORDS = 250; // not founder-specified — kept brisk toward the turn-11 soft target
const CHARS_PER_TOKEN = 4;
const cap = (text, tokenCap) => String(text || '').slice(0, tokenCap * CHARS_PER_TOKEN);
const clampWords = (text, n) => String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, n).join(' ');

// fieldOfLaw → label + allowed positions. Same 5 underlying options as the
// founder-partner's reference zip — covers "civil law" and "litigation law"
// (the two fields the founder named explicitly) without inventing a new
// taxonomy. Renamed in the UI to "Field of law" per the founder's wording.
const FIELDS = {
  civil_suit:       { label: 'Civil Law',                       positions: ['Plaintiff', 'Defendant'] },
  criminal_trial:   { label: 'Criminal Law',                    positions: ['Prosecution', 'Defence'] },
  bail_hearing:     { label: 'Bail Hearing',                    positions: ['Prosecution', 'Defence'] },
  writ_pil:         { label: 'Constitutional Law (Writ / PIL)', positions: ['Petitioner', 'Respondent (State)'] },
  contract_dispute: { label: 'Contract Dispute (Litigation)',   positions: ['Claimant', 'Respondent'] },
};

// Level — NEW, did not exist in the reference zip. Feeds case complexity
// (worker) and opposition toughness (turn prompt, below).
const LEVELS = ['easy', 'medium', 'hard'];

const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};

// Left as plain pool.query: ai_usage_log has no RLS policy (not one of the 5
// tables the 2026-07-26 migration protects), so this is a best-effort,
// fire-and-forget analytics write, not student-facing data access.
const logUsage = (user_id, college_id, model, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'court_simulation',$3,$4,$5)`,
    [user_id, college_id, model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

// sessions is RLS-protected — college_id here always comes from req.user
// (verified JWT via auth.middleware.js), never from the request body/params.
const loadOwnSession = async (id, user_id, college_id) => {
  const { rows } = await queryAsCollege(
    college_id,
    `SELECT * FROM sessions WHERE session_id=$1 AND user_id=$2 AND college_id=$3 AND feature_name='court_simulation'`,
    [id, user_id, college_id]
  );
  return rows[0] || null;
};

// ── 1. options ───────────────────────────────────────────────────────────────
const getCaseTypes = (_req, res) => {
  res.json({
    fields: Object.entries(FIELDS).map(([id, v]) => ({ id, label: v.label, positions: v.positions })),
    levels: LEVELS,
  });
};

// ── 2. start ─────────────────────────────────────────────────────────────────
const startSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const fieldOfLaw = String(req.body.fieldOfLaw || req.body.caseType || '');
    const def = FIELDS[fieldOfLaw];
    if (!def) return res.status(400).json({ error: 'Choose a valid field of law.' });

    const position = def.positions.includes(req.body.position) ? req.body.position : def.positions[0];
    const level = LEVELS.includes(req.body.level) ? req.body.level : 'medium';
    const studentName = String(req.body.studentName || '').trim().slice(0, 80) || null;

    const filters = { fieldOfLaw, fieldLabel: def.label, position, studentName };
    // college_id from req.user (verified JWT) — RLS-scoped insert into sessions.
    const { rows } = await queryAsCollege(
      college_id,
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, turns, turn_count, status)
       VALUES ($1,$2,'court_simulation',$3,$4,$5,'[]'::jsonb,0,'preparing') RETURNING session_id`,
      [user_id, college_id, fieldOfLaw, level, JSON.stringify(filters)]
    );
    const sessionId = rows[0].session_id;

    await courtQueue.add(
      'generate-case',
      { sessionId, fieldLabel: def.label, position, level, studentName, user_id, college_id, existingFilters: filters },
      { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
    );

    res.status(202).json({ sessionId, status: 'preparing', fieldOfLaw, label: def.label, position, level });
  } catch (err) { next(err); }
};

// ── 3. poll session ──────────────────────────────────────────────────────────
const getSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'preparing') return res.json({ status: 'preparing' });
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not prepare the case. Please try again.' });

    const f = s.filters || {};
    return res.json({
      status: s.status, // active | complete
      fieldOfLaw: f.fieldOfLaw, label: f.fieldLabel, position: f.position, level: s.difficulty,
      studentName: f.studentName || null,
      brief: f.brief || '',
      turns: s.turns || [],
      turnCount: s.turn_count,
      softConclude: SOFT_CONCLUDE, hardCap: HARD_CAP, maxWords: STUDENT_MAX_WORDS,
      disclaimer: DISCLAIMER,
    });
  } catch (err) { next(err); }
};

// ── 4. turn (student statement → judge remark + opposition statement) ────────
const takeTurn = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This simulation is not active.' });

    const statement = clampWords(req.body.statement, STUDENT_MAX_WORDS); // hard-cap server-side too
    if (statement.trim().length < 3) return res.status(400).json({ error: 'Please make your statement first.' });
    const voiceLevel = Math.max(0, Math.min(100, Number(req.body.voiceLevel) || 0));
    const durationSec = Math.max(0, Number(req.body.durationSec) || 0);
    const wordCount = Math.max(0, Number(req.body.wordCount) || statement.split(/\s+/).filter(Boolean).length);

    const f = s.filters || {};
    const level = s.difficulty || 'medium';
    const turns = s.turns || [];
    const forcedConclude = turns.length + 1 >= HARD_CAP;

    const LEVEL_TONE = {
      easy: 'The opposing counsel should be cooperative and straightforward — this is a student practicing the basics.',
      medium: 'The opposing counsel should push back realistically, testing the student’s argument fairly.',
      hard: 'The opposing counsel should be aggressive and sharp, citing sections/precedent-style reasoning, and the judge should be more exacting.',
    };

    // Running context, truncated so total input stays within the turn cap
    // (1,500 tokens — includes EVERYTHING per founder spec, so this history
    // is deliberately part of what gets sliced by cap() below, not exempt).
    const history = turns.map((t, i) =>
      `Turn ${i + 1}\nStudent (${f.position}): ${t.student}\nOpposition: ${t.opposition}\nJudge: ${t.judge}`
    ).join('\n\n');
    const prompt =
`You are running a mock Indian courtroom (${f.fieldLabel}). The STUDENT argues for the ${f.position}.
Difficulty: ${level}. ${LEVEL_TONE[level] || LEVEL_TONE.medium}
Case brief: ${f.brief}

Transcript so far:
${history || '(opening — no turns yet)'}

The student's new statement (${f.position}): "${statement}"

Respond as BOTH the OPPOSING COUNSEL and the JUDGE, using current Indian law (BNSS/BNS/BSA 2023) where relevant:
- "opposition": the opposing counsel's rebuttal, target ~150-200 words, forceful but fair (hard cap ${OPPOSITION_MAX_WORDS} words).
- "judge": a VERY SHORT interjection ONLY — 1-2 sentences, well under 50 words (hard cap ${JUDGE_MAX_WORDS} words).
  This is NOT the final judgment — never rule on the whole case here, just a brief procedural remark.
- "concluded": true only if the argument has reached a natural conclusion (aim to conclude by turn ${SOFT_CONCLUDE}).
${forcedConclude ? 'This is the FINAL turn — you MUST set "concluded": true and have the judge briefly close the hearing (still under 100 words, no verdict yet — the verdict comes separately).' : ''}
Return STRICT JSON only: { "opposition": "...", "judge": "...", "concluded": <bool> }`;

    let parsed, tin = 0, tout = 0, model;
    try {
      const out = await generateText({ prompt: cap(prompt, TURN_IN_CAP), maxOutputTokens: TURN_OUT_CAP, temperature: 0.7 });
      tin = out.tokensIn; tout = out.tokensOut; model = out.model;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, model, tin, tout);
      return res.status(502).json({ error: 'The court could not respond. Please try again.' });
    }
    logUsage(user_id, college_id, model, tin, tout);

    const opposition = clampWords(parsed.opposition, OPPOSITION_MAX_WORDS);
    const judge = clampWords(parsed.judge, JUDGE_MAX_WORDS);
    const concluded = forcedConclude || parsed.concluded === true;

    turns.push({ student: statement, opposition, judge, voiceLevel, durationSec, wordCount });
    // college_id already verified above via loadOwnSession's own college_id filter.
    await queryAsCollege(
      college_id,
      `UPDATE sessions SET turns=$2, turn_count=$3 WHERE session_id=$1`,
      [s.session_id, JSON.stringify(turns), turns.length]
    );

    res.json({ turnNumber: turns.length, opposition, judge, concluded, disclaimer: DISCLAIMER });
  } catch (err) { next(err); }
};

// ── 5. finish → ONE judgment + feedback call ──────────────────────────────────
const finishSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'complete' && s.summary) return res.json({ status: 'complete', result: JSON.parse(s.summary) });
    if (s.status !== 'active') return res.status(409).json({ error: 'This simulation is not active.' });

    const f = s.filters || {};
    const turns = s.turns || [];
    if (turns.length === 0) return res.status(400).json({ error: 'Argue at least one turn before finishing.' });

    const transcript = turns.map((t, i) =>
      `Turn ${i + 1}\nStudent (${f.position}): ${t.student}\nOpposition: ${t.opposition}\nJudge: ${t.judge}`
    ).join('\n\n');
    const prompt =
`You are the presiding judge AND a senior advocate evaluating a law student's performance in a mock
${f.fieldLabel} matter. The student argued for the ${f.position}. Case brief: ${f.brief}

Full transcript:
${transcript}

Return STRICT JSON only:
{
  "judgment": "<the JUDGE's final ruling on the case itself — who prevails and why, grounded in the
    transcript and current Indian law (BNSS/BNS/BSA 2023). Max 120 words. This is the FIRST time
    a verdict is given — nothing before this point in the session was a ruling.>",
  "verdict": "won|lost|split",
  "overallScore": <0-100>,
  "legalReasoning": <0-100>,
  "argumentation": <0-100>,
  "courtcraft": <0-100>,
  "clarity": <0-100>,
  "legalKnowledgeLevel": "<short assessment of the student's demonstrated legal knowledge, max 60 words>",
  "strengths": ["<short, specific, grounded in what the student actually said>", "..."],
  "weaknesses": ["<short, specific>", "..."],
  "improvements": ["<short, specific, actionable>", "..."]
}
Rules: judge the STUDENT's advocacy, not the AI opposition; ground every comment in the transcript,
never invent facts; up to 5 items each in strengths/weaknesses/improvements; keep the ENTIRE response
(judgment + legalKnowledgeLevel + all list items combined) under 600 words total — be concise.`;

    let parsed, tin = 0, tout = 0, model;
    try {
      const out = await generateText({ prompt: cap(prompt, FINISH_IN_CAP), maxOutputTokens: FINISH_OUT_CAP, temperature: 0.4 });
      tin = out.tokensIn; tout = out.tokensOut; model = out.model;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, model, tin, tout);
      return res.status(502).json({ error: 'Could not generate your judgment and feedback. Please try again.' });
    }
    logUsage(user_id, college_id, model, tin, tout);

    const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    // Word budget enforced per-field server-side (not left to model compliance)
    // — worst case 120+60+5*25+5*25+5*30 = 580 words, under the founder's
    // 500-600 word ceiling by design. See contract for the full breakdown.
    const listField = (arr, maxItems, maxWordsEach) =>
      Array.isArray(arr) ? arr.slice(0, maxItems).map((x) => clampWords(x, maxWordsEach)).filter(Boolean) : [];

    const result = {
      judgment: clampWords(parsed.judgment, 120),
      verdict: ['won', 'lost', 'split'].includes(parsed.verdict) ? parsed.verdict : 'split',
      overallScore: clampScore(parsed.overallScore),
      legalReasoning: clampScore(parsed.legalReasoning),
      argumentation: clampScore(parsed.argumentation),
      courtcraft: clampScore(parsed.courtcraft),
      clarity: clampScore(parsed.clarity),
      legalKnowledgeLevel: clampWords(parsed.legalKnowledgeLevel, 60),
      strengths: listField(parsed.strengths, 5, 25),
      weaknesses: listField(parsed.weaknesses, 5, 25),
      improvements: listField(parsed.improvements, 5, 30),
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

module.exports = { getCaseTypes, startSession, getSession, takeTurn, finishSession, getResult };
