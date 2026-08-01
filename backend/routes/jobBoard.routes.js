// jobBoard.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getJobs, getJobStats, trackApplyClick } = require('../controllers/jobBoard.controller');
// GET /api/jobs?city=Mumbai&type=internship
// Students NEVER hit external APIs — always reads job_cache table
router.get('/', authMiddleware, getJobs);
// GET /api/jobs/stats — total active + new-since-IST-midnight counts, for
// the "X new today" line on the Job Board page.
router.get('/stats', authMiddleware, getJobStats);
// POST /api/jobs/:jobId/click — records an apply click for the admin panel.
// Always 204, even on failure: tracking must never block a student from
// reaching a vacancy. See the controller for the full reasoning.
// NOTE: this must stay BELOW /stats — Express matches in order, and a
// parameterised path declared first would swallow literal paths.
router.post('/:jobId/click', authMiddleware, trackApplyClick);
module.exports = router;
