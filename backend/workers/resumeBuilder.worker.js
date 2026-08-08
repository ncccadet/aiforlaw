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
  sslEnabled: true,
});

const PDFDocument = require('pdfkit');

const BUCKET = process.env.S3_BUCKET_FILES || 'aiforlaw-files-prod';

const renderPdfBuffer = (draft, templateId, aiPolishText) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const personal = draft?.personal_info || {};
      const fullName = personal.full_name || 'Advocate';
      const email = personal.email || '';
      const phone = personal.phone || '';

      // Header
      doc.fontSize(22).fillColor('#111827').text(fullName, { align: 'center' });
      if (email || phone) {
        doc.fontSize(10).fillColor('#4B5563').text(`${email}${email && phone ? ' | ' : ''}${phone}`, { align: 'center' });
      }
      doc.moveDown(1.5);

      // Profile Summary
      const summaryText = personal.summary || draft?.summary || aiPolishText;
      if (summaryText) {
        doc.fontSize(13).fillColor('#1D4ED8').text('PROFILE SUMMARY');
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E5E7EB').stroke();
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#374151').text(summaryText);
        doc.moveDown(1);
      }

      // Education
      if (Array.isArray(draft?.education) && draft.education.length > 0) {
        doc.fontSize(13).fillColor('#1D4ED8').text('EDUCATION');
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E5E7EB').stroke();
        doc.moveDown(0.5);
        draft.education.forEach((edu) => {
          if (!edu) return;
          doc.fontSize(11).fillColor('#111827').text(`${edu.degree || 'Law Degree'} — ${edu.institution || 'Law College'}`);
          if (edu.year) doc.fontSize(9).fillColor('#6B7280').text(`Graduation: ${edu.year}`);
          doc.moveDown(0.4);
        });
        doc.moveDown(0.8);
      }

      // Experience
      if (Array.isArray(draft?.experience) && draft.experience.length > 0) {
        doc.fontSize(13).fillColor('#1D4ED8').text('LEGAL EXPERIENCE');
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E5E7EB').stroke();
        doc.moveDown(0.5);
        draft.experience.forEach((exp) => {
          if (!exp) return;
          doc.fontSize(11).fillColor('#111827').text(`${exp.role || 'Associate / Intern'} — ${exp.organization || 'Law Firm'}`);
          if (exp.duration) doc.fontSize(9).fillColor('#6B7280').text(exp.duration);
          if (exp.details) doc.fontSize(10).fillColor('#374151').text(exp.details);
          doc.moveDown(0.4);
        });
        doc.moveDown(0.8);
      }

      // Skills
      if (draft?.skills && typeof draft.skills === 'object') {
        const skillList = Object.values(draft.skills).flat().filter((s) => typeof s === 'string' && s.trim());
        if (skillList.length > 0) {
          doc.fontSize(13).fillColor('#1D4ED8').text('SKILLS & AREAS OF PRACTICE');
          doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E5E7EB').stroke();
          doc.moveDown(0.5);
          doc.fontSize(10).fillColor('#374151').text(skillList.join(' • '));
          doc.moveDown(1);
        }
      }

      // Achievements
      if (Array.isArray(draft?.achievements) && draft.achievements.length > 0) {
        doc.fontSize(13).fillColor('#1D4ED8').text('ACHIEVEMENTS & MOOTS');
        doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E5E7EB').stroke();
        doc.moveDown(0.5);
        draft.achievements.forEach((ach) => {
          if (ach) doc.fontSize(10).fillColor('#374151').text(`• ${ach}`);
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

const processJob = async (job) => {
  const { doc_id, user_id, college_id, draft, template_id } = job.data;

  try {
    let aiPolishText = '';
    try {
      const prompt = `Polish and structure the following resume details for an Indian law student:
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
      aiPolishText = text || '';
      if (tokensIn || tokensOut) {
        await pool.query(
          `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
           VALUES ($1, $2, 'resume_builder_build', $3, $4, $5)`,
          [user_id, college_id, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
        ).catch(() => {});
      }
    } catch (e) {
      console.warn('[resumeBuilder.worker] Gemini polish note:', e.message);
    }

    const pdfBuffer = await renderPdfBuffer(draft, template_id, aiPolishText);
    const s3Key = `resumes/${college_id || 'unaffiliated'}/${user_id}/built_${doc_id}.pdf`;

    await s3.putObject({
      Bucket: BUCKET,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    }).promise();

    await pool.query(
      `INSERT INTO documents (doc_id, user_id, college_id, feature_name, file_name, s3_key, status, analysis_json)
       VALUES ($1, $2, $3, 'resume_builder', 'resume.pdf', $4, 'complete', $5)
       ON CONFLICT (doc_id) DO UPDATE SET status = 'complete', s3_key = $4, analysis_json = $5`,
      [doc_id, user_id, college_id, s3Key, JSON.stringify({ template_id, draft, ai_polish: aiPolishText })]
    );

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
