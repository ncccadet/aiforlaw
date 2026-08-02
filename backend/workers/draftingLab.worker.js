/**
 * draftingLab.worker.js — v3 (BullMQ worker, two job types on one queue)
 * Contract: _contracts/04-drafting-lab.md
 *
 * Fixes carried over from every other AI feature this session: routes Gemini
 * calls through the shared gemini.service.js native REST client (never the
 * @google/generative-ai SDK — see that file's header for why AQ.-prefixed
 * keys fail through SDK/OpenAI-shim paths but work fine on the native REST
 * endpoint), and never hardcodes a model id (gemini.service.js defaults to
 * the real `gemini-3.1-flash-lite`, not the founder-provided zip's invalid
 * `gemini-3-1-flash-lite`).
 *
 * Two job types on the 'drafting-lab' queue:
 *   'generate-case' (Call 1) — one Gemini call → { title, facts } for the
 *      chosen draft type. Output cap 800 tokens (contract).
 *   'score-draft'   (Call 2) — one Gemini call → lawyer-style critique of
 *      the assembled draft. Input capped ~3,500 tokens (already enforced
 *      server-side before enqueue, in the controller); output cap 1,200
 *      tokens (~600 words, contract). No model draft generated — a scored
 *      critique only.
 *
 * On failure (either call, after retries): status='failed'. No refund of the
 * daily slot — matches Court Simulation's / AI Interviewer's no-refund
 * pattern (this was the contract's "confirm at build time" open item;
 * resolved here for consistency, replacing the founder-provided zip's
 * one-off manual `redis.decr` refund logic).
 *
 * Run as its OWN process (not imported by app.js):
 *   pm2 start workers/draftingLab.worker.js --name drafting-lab-worker
 */
require('dotenv').config(); // must load before redisConnection / gemini.service read env at call time
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { generateText } = require('../services/gemini.service');

// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });

const CASE_OUT_CAP = 800;
const SCORE_IN_CAP = 3500;   // tokens — matches the ~14,000 char guard already enforced in the controller
const SCORE_OUT_CAP = 1200;  // ~600 words (contract)
const CHARS_PER_TOKEN = 4;
const cap = (text, tokenCap) => String(text || '').slice(0, tokenCap * CHARS_PER_TOKEN);

const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};

const logUsage = (user_id, college_id, model, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'drafting_lab',$3,$4,$5)`,
    [user_id, college_id, model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

// ── Call 1 — generate a fresh fact scenario for the chosen draft type ───────
// Gemini kept defaulting to the same accused name ("Arjun Mehra") across
// separate runs regardless of temperature — a known LLM behavior (a few
// names/scenarios dominate the model's own distribution for a given prompt
// shape). Rather than hope raising temperature fixes it, we FORCE variety
// server-side: pick a random name/city/offence combination here and require
// the model to use exactly that combination, so repeats are structurally
// impossible rather than merely unlikely.
const ACCUSED_NAMES = [
  'Arjun Mehra', 'Rahul Verma', 'Priya Nair', 'Sanjay Iyer', 'Neha Kapoor',
  'Vikram Rathore', 'Ananya Desai', 'Karan Malhotra', 'Ritu Chawla', 'Amit Bhatt',
  'Sneha Pillai', 'Rohan Gupta', 'Kavita Menon', 'Deepak Joshi', 'Meera Shetty',
  'Aditya Saxena', 'Pooja Reddy', 'Nikhil Bansal', 'Divya Krishnan', 'Manish Tiwari',
];
const CITIES = [
  'Delhi', 'Mumbai', 'Bengaluru', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata',
  'Ahmedabad', 'Jaipur', 'Lucknow', 'Chandigarh', 'Kochi',
];
const OFFENCE_CONTEXTS = [
  'an online investment/cryptocurrency fraud', 'a cheque-bounce/loan default dispute',
  'a workplace altercation resulting in injury', 'a road-rage/motor accident dispute',
  'a rental/tenancy fraud', 'a forged-document/property dispute',
  'an online marketplace scam', 'a domestic dispute with property implications',
  'a business partnership breach of trust', 'a social-media defamation complaint',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const buildCasePrompt = (label, seed) =>
`You are a law-school drafting instructor in India. Generate ONE realistic, self-contained
fact scenario (a "case") that a student will use to draft a ${label}. Use current codes
(BNSS/BNS/BSA 2023) where relevant, never the older CrPC/IPC/Evidence Act section numbers.
Include concrete details the student will need to fill in the draft: party names, dates,
place/court, FIR/case numbers or amounts as applicable.

MANDATORY — use exactly these seed values so cases vary across different runs (never
substitute a different name or city, even if a different one seems more natural to you):
- Accused's name: ${seed.name}
- City / place: ${seed.city}
- General nature of the dispute: ${seed.context}

Return STRICT JSON only:
{ "title": "<short case title>", "facts": "<8-12 sentences of concrete facts>" }

Do NOT write the draft itself. Use only fictional persons. Keep well under ${CASE_OUT_CAP} tokens.`;

const runGenerateCase = async (job) => {
  const { sessionId, label, user_id, college_id } = job.data;
  const seed = { name: pick(ACCUSED_NAMES), city: pick(CITIES), context: pick(OFFENCE_CONTEXTS) };

  let parsed, tin = 0, tout = 0, model, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await generateText({ prompt: buildCasePrompt(label, seed), maxOutputTokens: CASE_OUT_CAP, temperature: 0.7 });
      tin = out.tokensIn; tout = out.tokensOut; model = out.model;
      parsed = parseJson(out.text);
      break;
    } catch (e) { lastErr = e; }
  }
  if (tin || tout) logUsage(user_id, college_id, model, tin, tout);

  if (!parsed) {
    await pool.query(`UPDATE sessions SET status='failed' WHERE session_id=$1 AND status='preparing'`, [sessionId]);
    throw lastErr || new Error('drafting_lab: unparseable model output (generate-case)');
  }

  const caseObj = {
    title: String(parsed.title || 'Practice case').slice(0, 200),
    facts: String(parsed.facts || '').slice(0, 4000),
  };
  await pool.query(
    `UPDATE sessions SET case_data=$2, status='active' WHERE session_id=$1`,
    [sessionId, JSON.stringify({ case: caseObj })]
  );
};

// ── Call 2 — score the student's assembled draft like a senior advocate ────
// IMPORTANT: the model is shown the student's RAW field-by-field answers
// SEPARATELY from the fixed template boilerplate, and is explicitly told to
// only credit the student for their own answers — never for the surrounding
// template text every student's draft shares. This also lets it reliably
// call out gibberish/placeholder answers instead of finding polite things to
// say about text that isn't a real attempt (a real bug found in testing:
// scoring only the merged document let the model praise fixed boilerplate
// like the heading/statute citation as if the student had written it).
const buildScorePrompt = (templateType, fieldAnswers, assembledDraft) => {
  const answersBlock = fieldAnswers
    .map((f) => `- ${f.label}: "${f.value || '(left blank)'}"`)
    .join('\n');

  return `You are a senior advocate with 15-20 years of litigation experience in India, reviewing a
law student's first attempt at drafting a "${templateType.replace(/_/g, ' ')}".

CRITICAL — read this carefully: the fixed headings, standard clauses, and boilerplate wording
below are the SAME for every student's draft of this type — they are pre-written template text,
NOT something this student wrote. Do NOT praise or give credit for anything in the fixed
template text. Only judge the student on the specific answers they typed into each field, listed
below separately.

THE STUDENT'S OWN ANSWERS (this is the ONLY part you may credit them for):
${answersBlock}

FOR CONTEXT ONLY — the full assembled document (template + the answers above merged in):
"""
${assembledDraft}
"""

GIBBERISH CHECK (do this first): if most of the student's answers above are random keystrokes,
single meaningless words, or clearly not a genuine attempt to answer the question asked (e.g.
"gfd", "hjgjjn", "jknml,k" instead of an actual court name, date, or legal ground) — this is NOT
a real draft to critique politely. In that case: set overallScore, structuralCompleteness,
legalAccuracy, and clarity all in the 0-15 range, leave "strengths" as an EMPTY array (do not
invent strengths for nonsense — praising boilerplate structure the student didn't write is a
bug, not a courtesy), and make "improvements" explicitly say the fields need real substantive
answers, naming which fields were left as placeholder/gibberish text.

If the answers ARE a genuine attempt, judge normally: what's structurally missing, what's
legally inaccurate (flag any citation to the OLD CrPC/IPC/Evidence Act section numbers —
current law is BNSS/BNS/BSA 2023), and what's unclear or unprofessionally worded — but every
"strength" must point to something the student specifically wrote in their own answers, never
to fixed template text.

Return STRICT JSON only:
{
  "overallScore": <0-100>,
  "structuralCompleteness": <0-100>,
  "legalAccuracy": <0-100>,
  "clarity": <0-100>,
  "strengths": ["<short, specific, must reference the student's own answer text>", "..."],
  "improvements": [ { "area": "<short>", "suggestion": "<specific, actionable change>" } ]
}
Rules: base every score on the student's own answers, never invent facts; be specific and
constructive, not generic; up to 6 items each in "strengths" and "improvements" (0 items is
correct for "strengths" when the input is gibberish); keep the whole response within the
output budget.`;
};

const runScoreDraft = async (job) => {
  const { sessionId, template_type, assembledDraft, fields, blanksSpec, user_id, college_id } = job.data;
  const fieldAnswers = (blanksSpec || []).map((b) => ({ label: b.label, value: (fields || {})[b.id] }));

  let parsed, tin = 0, tout = 0, model, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = cap(buildScorePrompt(template_type, fieldAnswers, assembledDraft), SCORE_IN_CAP);
      const out = await generateText({ prompt, maxOutputTokens: SCORE_OUT_CAP, temperature: 0.3 });
      tin = out.tokensIn; tout = out.tokensOut; model = out.model;
      parsed = parseJson(out.text);
      break;
    } catch (e) { lastErr = e; }
  }
  if (tin || tout) logUsage(user_id, college_id, model, tin, tout);

  if (!parsed) {
    await pool.query(`UPDATE sessions SET status='failed' WHERE session_id=$1`, [sessionId]);
    throw lastErr || new Error('drafting_lab: unparseable model output (score-draft)');
  }

  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const result = {
    overallScore: clamp(parsed.overallScore),
    structuralCompleteness: clamp(parsed.structuralCompleteness),
    legalAccuracy: clamp(parsed.legalAccuracy),
    clarity: clamp(parsed.clarity),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6).map((x) => String(x || '').slice(0, 200)) : [],
    improvements: Array.isArray(parsed.improvements)
      ? parsed.improvements.slice(0, 6).map((f) => ({ area: String(f.area || '').slice(0, 80), suggestion: String(f.suggestion || '').slice(0, 400) }))
      : [],
    disclaimer: 'For educational purposes only. Verify with a qualified advocate.',
  };

  await pool.query(
    `UPDATE sessions SET status='complete', is_complete=TRUE, summary=$2 WHERE session_id=$1`,
    [sessionId, JSON.stringify(result)]
  );
};

const processJob = (job) => {
  if (job.name === 'generate-case') return runGenerateCase(job);
  if (job.name === 'score-draft') return runScoreDraft(job);
  throw new Error(`drafting_lab: unknown job type "${job.name}"`);
};

const worker = new Worker('drafting-lab', processJob, { connection: require('../config/redisConnection') });
worker.on('completed', (job) => console.log(`Drafting-lab job ${job.id} (${job.name}) done (session ${job.data.sessionId})`));
worker.on('failed', (job, err) => console.error(`Drafting-lab job ${job?.id} (${job?.name}) failed:`, err?.message));

module.exports = worker;
