/**
 * resumeAnalyzer.controller.js
 *
 * Contract: _contracts/02-resume-analyzer.md
 *
 * P004 rule: a PDF is NEVER parsed in this main API process. The controller only
 * (a) hands out a short-lived presigned S3 URL so the browser uploads straight to
 * S3, and (b) enqueues a BullMQ job. All PDF reading + the Gemini call happen in
 * resumeAnalyzer.worker.js, where a malicious/corrupt PDF can crash a worker
 * without taking the API down.
 *
 * college_id rule: every documents query below filters BOTH user_id AND college_id,
 * so one student can never read another student's (or another college's) analysis.
 *
 * Limit: UNLIMITED (founder decision 2026-07-21) — the route carries no featureLimit.
 */
const AWS   = require('aws-sdk');
const crypto = require('crypto');
const { Queue } = require('bullmq');
// documents is RLS-protected (migrations/20260726_rls_policies.sql) — every
// query below that touches it goes through queryAsCollege with college_id
// from req.user (verified JWT via auth.middleware.js), never from the
// request body/params.
const { queryAsCollege } = require('../config/db');

// Shared ioredis connection (see config/redisConnection.js for why this exists).
const resumeQueue = new Queue('resume-analysis', {
  connection: require('../config/redisConnection'),
});

// AWS SDK v2 S3 client, region from env (ap-south-1). Credentials come from the
// environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) — never hardcoded.
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  signatureVersion: 'v4',
});
const BUCKET = process.env.S3_BUCKET_FILES;

// A student's uploads always live under this prefix. Used both to build the key
// and to verify — on /analyze — that a submitted key really belongs to the caller.
const ownerPrefix = (college_id, user_id) => `resumes/${college_id}/${user_id}/`;

/**
 * GET /api/resume-analyzer/upload-url
 * Returns a presigned PUT URL so the browser uploads the PDF directly to S3.
 * The key is namespaced by college_id + user_id; the URL is locked to
 * ContentType application/pdf and expires in 60s.
 */
const getUploadUrl = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const key = `${ownerPrefix(college_id, user_id)}${crypto.randomUUID()}.pdf`;

    const uploadUrl = await s3.getSignedUrlPromise('putObject', {
      Bucket: BUCKET,
      Key: key,
      ContentType: 'application/pdf', // browser MUST send this exact header or the signature fails
      Expires: 60,
    });

    res.json({ uploadUrl, s3Key: key });
  } catch (err) {
    next(err);
  }
};

const { processJob: processResumeJob } = require('../workers/resumeAnalyzer.worker');

/**
 * POST /api/resume-analyzer/analyze
 * Body: { s3Key }. Confirms the key belongs to this student, creates a pending
 * documents row, enqueues the worker, and returns the docId to poll.
 */
const analyzeResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { s3Key } = req.body;

    // Access Path: reject any key that is not under THIS student's own prefix,
    // so a crafted body can't point the worker at someone else's upload.
    if (
      typeof s3Key !== 'string' ||
      !s3Key.startsWith(ownerPrefix(college_id, user_id)) ||
      !s3Key.endsWith('.pdf')
    ) {
      return res.status(400).json({ error: 'Invalid or unrecognised upload reference.' });
    }

    // Create the pending row FIRST so the frontend has a doc_id to poll immediately.
    const { rows } = await queryAsCollege(
      college_id,
      `INSERT INTO documents (user_id, college_id, feature_name, s3_key, status)
       VALUES ($1, $2, 'resume_analyzer', $3, 'pending')
       RETURNING doc_id`,
      [user_id, college_id, s3Key]
    );
    const docId = rows[0].doc_id;

    // Trigger direct background processing for 100% reliability
    processResumeJob({ data: { docId, s3Key, user_id, college_id }, id: docId }).catch((err) => {
      console.error('[resumeAnalyzer] direct processJob note:', err.message);
    });

    try {
      await resumeQueue.add(
        'analyze',
        { docId, s3Key, user_id, college_id },
        { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
      );
    } catch (qErr) {
      console.warn('[resumeAnalyzer] BullMQ queue add ignored:', qErr.message);
    }

    res.json({ docId, status: 'pending' });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/resume-analyzer/result/:docId
 * Returns the caller's own document only. Shape depends on status.
 */
const getResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { docId } = req.params;

    const { rows } = await queryAsCollege(
      college_id,
      `SELECT status, analysis_json
         FROM documents
        WHERE doc_id = $1 AND user_id = $2 AND college_id = $3
          AND feature_name = 'resume_analyzer'`,
      [docId, user_id, college_id]
    );

    if (rows.length === 0) {
      // 404 (not 403) — never confirm that someone else's doc_id exists.
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    const { status, analysis_json } = rows[0];

    if (status === 'pending') {
      return res.json({ status: 'pending', result: null });
    }
    if (status === 'failed') {
      return res.json({
        status: 'failed',
        result: null,
        message:
          analysis_json?.message ||
          'We could not analyse this file. Please upload a text-based PDF résumé (1–3 pages).',
      });
    }
    // complete — analysis_json also carries reportS3Key internally, but there's
    // no reason to hand that S3 key straight to the client; the frontend gets a
    // fresh presigned URL for it on demand from GET /report/:docId instead.
    const { reportS3Key, ...result } = analysis_json || {};
    return res.json({ status: 'complete', result });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/resume-analyzer/history
 * Lightweight list of the student's past analyses, newest first. Metadata only —
 * the full analysis_json is fetched on demand via /result/:docId.
 */
const getHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;

    const { rows } = await queryAsCollege(
      college_id,
      `SELECT doc_id,
              status,
              (analysis_json->>'overallScore')::int AS overall_score,
              created_at
         FROM documents
        WHERE user_id = $1 AND college_id = $2 AND feature_name = 'resume_analyzer'
        ORDER BY created_at DESC
        LIMIT 50`,
      [user_id, college_id]
    );

    res.json({
      history: rows.map((r) => ({
        docId: r.doc_id,
        status: r.status,
        overallScore: r.overall_score,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/resume-analyzer/report/:docId
 * Added 2026-07-22 (founder request: downloadable PDF of the analysis, styled
 * to match this page's own dark theme — see resumeAnalyzer.worker.js's
 * renderReportPdf). Returns a short-lived presigned GET URL for the report
 * PDF the worker generated and stored in S3 alongside the JSON analysis.
 * Same ownership check as getResult — 404, never 403, for a doc that isn't
 * this student's own.
 */
const getReportUrl = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { docId } = req.params;

    const { rows } = await queryAsCollege(
      college_id,
      `SELECT status, analysis_json
         FROM documents
        WHERE doc_id = $1 AND user_id = $2 AND college_id = $3
          AND feature_name = 'resume_analyzer'`,
      [docId, user_id, college_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    const { status, analysis_json } = rows[0];
    const reportS3Key = analysis_json?.reportS3Key;

    if (status !== 'complete' || !reportS3Key) {
      return res.status(404).json({ error: 'No downloadable report for this analysis.' });
    }

    const downloadUrl = s3.getSignedUrl('getObject', {
      Bucket: BUCKET,
      Key: reportS3Key,
      Expires: 300,
    });

    res.json({ downloadUrl });
  } catch (err) {
    next(err);
  }
};

module.exports = { getUploadUrl, analyzeResume, getResult, getHistory, getReportUrl };
