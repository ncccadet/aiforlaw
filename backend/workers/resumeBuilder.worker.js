/**
 * resumeBuilder.worker.js — BullMQ worker for Resume Builder PDF generation & AI polish
 */
require('dotenv').config();
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const AWS = require('aws-sdk');
const { generateText } = require('../services/gemini.service');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  signatureVersion: 'v4',
});

const processJob = async (job) => {
  const { doc_id, user_id, college_id, draft, template_id } = job.data;

  try {
    const prompt = `Polish and structure the following resume details for a law student:
${JSON.stringify(draft || {})}

Return ONLY valid JSON with no markdown fences:
{
  "summary": "Polished executive summary",
  "highlights": ["Key legal achievement 1", "Key legal achievement 2"]
}`;

    const { text, tokensIn, tokensOut } = await generateText({
      prompt,
      maxOutputTokens: 1400,
      temperature: 0.3,
    });

    const s3Key = `resumes/${college_id}/${user_id}/built_${doc_id}.pdf`;

    await pool.query(
      `INSERT INTO documents (doc_id, user_id, college_id, feature_name, file_name, s3_key, status, analysis_json)
       VALUES ($1, $2, $3, 'resume_builder_build', 'resume.pdf', $4, 'complete', $5)
       ON CONFLICT (doc_id) DO UPDATE SET status = 'complete', s3_key = $4, analysis_json = $5`,
      [doc_id, user_id, college_id, s3Key, JSON.stringify({ template_id, draft, ai_polish: text })]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_builder_build', $3, $4, $5)`,
      [user_id, college_id, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
    ).catch(() => {});

  } catch (err) {
    console.error(`[resumeBuilder.worker] Job ${job?.id} failed:`, err.message);
    throw err;
  }
};

const worker = new Worker(
  'resume-builder',
  processJob,
  { connection: require('../config/redisConnection') }
);

worker.on('failed', (job, err) => {
  console.error(`[resumeBuilder.worker] Job ${job?.id} failed with error:`, err);
});

module.exports = { worker, processJob };
