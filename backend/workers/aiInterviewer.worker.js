/**
 * aiInterviewer.worker.js — BullMQ worker (batch question generation, ALL tiers)
 * Contract: _contracts/06-ai-interviewer.md
 *
 * v3 (2026-07-23): unified all three difficulty tiers onto ONE architecture —
 * generate the full question list for the session UP FRONT, in a single Gemini
 * call, then the student is asked those questions one by one, exactly as
 * described in the founders' voice brief. This replaces the founder-provided
 * zip's original design, which generated the HARD tier adaptively (one Gemini
 * call per turn) — that contradicted the stated flow and would have made hard
 * sessions far more expensive with no requested benefit. Decision logged in
 * _decisions/decisions-log.md.
 *
 * FLOW per job:
 *   1. Load tier config (question-count range + token caps), role, and an
 *      optional short resume-context string for the session.
 *   2. ONE Gemini call via the shared gemini.service.js native REST client
 *      (never the @google/generative-ai SDK — see gemini.service.js header
 *      for why: AQ.-prefixed keys fail through SDK/OpenAI-shim paths, not
 *      through the native REST endpoint) → JSON { questions: [...] }.
 *      Retries once on parse/empty failure.
 *   3. UPDATE sessions SET questions=$1, status='active'.
 *   4. Log tokens to ai_usage_log.
 *   5. On failure after retries: status='failed'. Per Court Simulation's
 *      established pattern, a failed session does NOT refund the monthly
 *      counter — a deliberate parity choice, not an oversight.
 *
 * Run as its OWN process (not imported by app.js):
 *   pm2 start workers/aiInterviewer.worker.js --name ai-interviewer-worker
 */
require('dotenv').config(); // must load before redisConnection / gemini.service read env at call time
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { generateText } = require('../services/gemini.service');

// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });

// Per-tier caps — exact founder spec (2026-07-23 voice brief).
const TIER = {
  easy:   { inCap: 1500, outCap: 1000, minQ: 6,  maxQ: 7  },
  medium: { inCap: 1500, outCap: 2000, minQ: 8,  maxQ: 10 },
  hard:   { inCap: 2000, outCap: 3000, minQ: 10, maxQ: 12 },
};
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
     VALUES ($1,$2,'ai_interviewer',$3,$4,$5)`,
    [user_id, college_id, model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

const buildPrompt = (difficulty, role, resumeContext, tier) =>
`You are conducting a mock legal-career interview for an Indian law student.
Difficulty: ${difficulty}. Target role: ${role}.
${resumeContext ? `Candidate resume summary (ground some questions in this): ${resumeContext}\n` : ''}
Generate between ${tier.minQ} and ${tier.maxQ} interview questions appropriate to the ${difficulty} level
(easy = foundational/behavioural; medium = applied legal reasoning; hard = adversarial, cross-examination-style,
tests depth under pressure). Order them from opening to deepest. Keep each question under 50 words.
Return STRICT JSON only: { "questions": ["<q1>", "<q2>", ...] }
Use current Indian law (BNSS/BNS/BSA 2023) where a statute is referenced. No preamble, JSON only.`;

const processJob = async (job) => {
  const { sessionId, difficulty, role, resumeContext, user_id, college_id } = job.data;
  const tier = TIER[difficulty] || TIER.medium;

  let questions, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = cap(buildPrompt(difficulty, role, resumeContext, tier), tier.inCap);
      const out = await generateText({ prompt, maxOutputTokens: tier.outCap, temperature: 0.7 });
      if (out.tokensIn || out.tokensOut) logUsage(user_id, college_id, out.model, out.tokensIn, out.tokensOut);
      const parsed = parseJson(out.text);
      questions = (parsed.questions || [])
        .map((q) => String(q || '').trim())
        .filter(Boolean)
        .slice(0, tier.maxQ);
      if (questions.length >= 1) break;
      questions = null;
    } catch (e) { lastErr = e; }
  }

  if (!questions || questions.length === 0) {
    await pool.query(`UPDATE sessions SET status='failed' WHERE session_id=$1 AND status='preparing'`, [sessionId]);
    throw lastErr || new Error('ai_interviewer: no questions generated');
  }

  await pool.query(
    `UPDATE sessions SET questions=$2, status='active' WHERE session_id=$1`,
    [sessionId, JSON.stringify(questions)]
  );
};

const worker = new Worker('ai-interviewer', processJob, { connection: require('../config/redisConnection') });
worker.on('completed', (job) => console.log(`AI-interviewer job ${job.id} done (session ${job.data.sessionId})`));
worker.on('failed', (job, err) => console.error(`AI-interviewer job ${job?.id} failed:`, err?.message));

module.exports = worker;
