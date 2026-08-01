// resumeBuilder.routes.js
//
// /build is the only AI-gated route (50/month via featureLimitMonthly,
// unchanged from the original stub-era limit — see _contracts/07-resume-builder.md).
// /enhance has no Redis gate (founder decision: unlimited but tightly
// token-capped in the controller, 1,500 input chars / 350 output tokens).
// There is deliberately no /analyze route — an earlier draft of this feature
// had a whole-draft "AI Analyze" endpoint; removed 2026-07-22 per founder
// decision in favor of the deterministic completeness bar only (zero AI cost).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitMonthly } = require('../middleware/featureLimit.middleware');
const { getTemplates, saveDraft, getDraft, buildResume, getBuildResult, getResume, getResumeHistory, getPhotoUploadUrl, enhanceText } = require('../controllers/resumeBuilder.controller');

router.get('/templates',         authMiddleware, getTemplates);
router.get('/photo-upload-url',  authMiddleware, getPhotoUploadUrl);
router.post('/draft',            authMiddleware, saveDraft);
router.get('/draft',             authMiddleware, getDraft);
router.post('/build',            authMiddleware, featureLimitMonthly('resume_builder', 50), buildResume);
router.post('/enhance',          authMiddleware, enhanceText); // no featureLimit — token-capped in controller instead
router.get('/result/:buildId',   authMiddleware, getBuildResult);
router.get('/download',          authMiddleware, getResume);
router.get('/history',           authMiddleware, getResumeHistory); // last 5 builds, each with its own download URL

module.exports = router;
