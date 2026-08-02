/**
 * courtSimulation.worker.js — BullMQ worker for Court Simulation case generation
 */
require('dotenv').config();
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { generateText } = require('../services/gemini.service');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const buildCasePrompt = (fieldLabel, position, level, studentName) => `
You are a senior advocate and judicial clerk in an Indian High Court.
Generate a realistic Indian legal case brief for a Court Simulation practice session.

Field of Law: ${fieldLabel}
Student's Position: ${position}
Difficulty Level: ${level}
Student Name: ${studentName || 'Advocate'}

Return ONLY valid JSON with no markdown fences:
{
  "title": "State / Petitioner v. Respondent - Brief Title",
  "facts": "Detailed summary of facts of the case (3-4 paragraphs), legal provisions involved (e.g. IPC/CrPC/CPC/Constitution/Contract Act), key points of dispute, and relevant precedents if applicable.",
  "judgeName": "Hon'ble Mr. Justice A.K. Sharma",
  "oppCounselName": "Adv. R.K. Mehta"
}
`;

const safeParseJson = (text) => {
  if (!text) return null;
  let str = String(text).trim();
  str = str.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const sObj = str.indexOf('{'), sArr = str.indexOf('[');
  let start = -1, end = -1;
  if (sObj !== -1 && (sArr === -1 || sObj < sArr)) {
    start = sObj; end = str.lastIndexOf('}');
  } else if (sArr !== -1) {
    start = sArr; end = str.lastIndexOf(']');
  }

  if (start === -1 || end === -1 || end <= start) return null;
  const snippet = str.slice(start, end + 1);

  try {
    return JSON.parse(snippet);
  } catch (e1) {
    try {
      const fixed = snippet.replace(/[\r\n\t]/g, (m) => (m === '\n' ? '\\n' : m === '\r' ? '\\r' : '\\t'));
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
};

const processJob = async (job) => {
  const { sessionId, fieldLabel, position, level, studentName, user_id, college_id, existingFilters } = job.data;

  try {
    const prompt = buildCasePrompt(fieldLabel, position, level, studentName);
    const { text, tokensIn, tokensOut } = await generateText({
      prompt,
      maxOutputTokens: 1500,
      temperature: 0.3,
    });

    const parsed = safeParseJson(text) || {};

    const updatedFilters = {
      ...(existingFilters || {}),
      brief: parsed.facts || text || 'Detailed case brief prepared for hearing.',
      title: parsed.title || `${fieldLabel} Matter`,
      judgeName: parsed.judgeName || 'Hon\'ble Bench',
      oppCounselName: parsed.oppCounselName || 'Opposing Counsel',
    };

    await pool.query(
      `UPDATE sessions SET status = 'active', filters = $1 WHERE session_id = $2`,
      [JSON.stringify(updatedFilters), sessionId]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'court_simulation', $3, $4, $5)`,
      [user_id, college_id, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
    ).catch(() => {});

  } catch (err) {
    console.error(`[courtSimulation.worker] Job ${job?.id} failed:`, err.message);
    await pool.query(
      `UPDATE sessions SET status = 'failed' WHERE session_id = $1 AND status = 'preparing'`,
      [sessionId]
    ).catch(() => {});
    throw err;
  }
};

const worker = new Worker(
  'court-simulation',
  processJob,
  { connection: require('../config/redisConnection') }
);

worker.on('failed', (job, err) => {
  console.error(`[courtSimulation.worker] Job ${job?.id} failed with error:`, err);
});

module.exports = { worker, processJob };
