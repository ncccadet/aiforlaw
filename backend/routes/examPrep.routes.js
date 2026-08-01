/**
 * examPrep.routes.js — Exam Prep v3
 * Contract: _contracts/01-exam-prep.md
 *
 * THE LIMIT SITS ON /generate ONLY, NEVER ON /submit.
 * featureLimitMonthly increments Redis on every request that passes through it.
 * If it were on /submit too, a student would burn two of their 30 papers per
 * exam, and — worse — a student who hit the limit mid-paper could not hand in
 * three hours of work. Generation is what costs money; submission is what the
 * student is owed.
 *
 * Monthly (not daily) is founder-dictated, 2026-07-28: students revise in
 * bursts before an exam, not evenly across the month.
 *
 * SPLIT LIMITS — 15 AIBE + 15 SPPU, two separate Redis counters, replacing the
 * shared 30 (founder decision, 2026-07-28). Two reasons it is a split and not
 * just a smaller shared number:
 *   1. Cost. An AIBE paper costs Rs 1.43 and an SPPU cycle Rs 0.55. Under a
 *      shared 30 the worst case was every student spending all 30 on AIBE —
 *      Rs 15,015/month against a Rs 20,000 alert. Capping AIBE at 15 makes that
 *      arithmetically impossible: the ceiling is now Rs 10,395.
 *   2. Fairness. Grinding mocks for the Bar exam should not cost a student the
 *      university papers they need for their actual semester, or the reverse.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitMonthly } = require('../middleware/featureLimit.middleware');
const {
  getStructure,
  getActive,
  aibeGenerate, aibeSubmit,
  sppuGenerate, sppuSubmit,
  libraryList, libraryDownload,
  getAnalytics,
} = require('../controllers/examPrep.controller');

// Distinct Redis feature names => distinct counters. Renaming away from the old
// shared 'exam_prep' key also means nobody carries a part-used shared tally into
// the new scheme; everyone starts this month with a clean 15 and 15.
const aibeLimit = featureLimitMonthly('exam_prep_aibe', 15);
const sppuLimit = featureLimitMonthly('exam_prep_sppu', 15);

// Read-only: exam structure, and resuming a paper already paid for.
router.get('/structure', authMiddleware, getStructure);
router.get('/active',    authMiddleware, getActive);

// AIBE (Bar Council) — 100 MCQs, 210-minute timer.
router.post('/aibe/generate', authMiddleware, aibeLimit, aibeGenerate);
router.post('/aibe/submit',   authMiddleware, aibeSubmit);   // deterministic, zero AI

// SPPU (University) — 80-mark written paper, 180-minute timer.
router.post('/sppu/generate', authMiddleware, sppuLimit, sppuGenerate);
router.post('/sppu/submit',   authMiddleware, sppuSubmit);   // AI-graded

// Library — past question papers.
router.get('/library',              authMiddleware, libraryList);
router.get('/library/:id/download', authMiddleware, libraryDownload);

// Score trend — pure SQL, no AI.
router.get('/analytics', authMiddleware, getAnalytics);

module.exports = router;
