// resumeAnalyzer.routes.js
// Contract: _contracts/02-resume-analyzer.md
//
// Daily limit: UNLIMITED (founder decision 2026-07-21) — NO featureLimit here.
// The global rateLimitMiddleware (100 req/min/IP, applied in app.js) is the only
// flood guard. If abuse ever appears, re-add a cap in one line, e.g.:
//   const { featureLimit } = require('../middleware/featureLimit.middleware');
//   router.post('/analyze', authMiddleware, featureLimit('resume_analyzer', 20), analyzeResume);
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const {
  getUploadUrl,
  analyzeResume,
  getResult,
  getHistory,
  getReportUrl,
} = require('../controllers/resumeAnalyzer.controller');

router.get('/upload-url',     authMiddleware, getUploadUrl);
router.post('/analyze',       authMiddleware, analyzeResume);
router.get('/result/:docId',  authMiddleware, getResult);
router.get('/history',        authMiddleware, getHistory);
router.get('/report/:docId',  authMiddleware, getReportUrl); // presigned URL for the downloadable PDF report

module.exports = router;
