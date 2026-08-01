// draftingLab.routes.js — v3: three-step flow (View & Learn / guided drafting / AI feedback)
// Contract: _contracts/04-drafting-lab.md
//
// Daily limit (3/day) applies ONLY to /case-study (Call 1 — starts the combined
// Step2+3 exercise). Everything downstream of an already-started exercise
// (result/submit/score) is free — a student who already spent a slot starting
// an exercise shouldn't be blocked from finishing it. Step 1 (/library,
// /options) carries no limit at all — no AI, unlimited, zero cost.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimit } = require('../middleware/featureLimit.middleware');
const {
  getLibrary, getOptions, startCaseStudy, getCaseResult, submitCaseStudy, getScore, getHistory,
} = require('../controllers/draftingLab.controller');

router.get('/library',                  authMiddleware, getLibrary);
router.get('/options',                  authMiddleware, getOptions);
router.post('/case-study',              authMiddleware, featureLimit('drafting_lab', 3), startCaseStudy);
router.get('/case-study/result/:docId', authMiddleware, getCaseResult);
router.post('/case-study/submit',       authMiddleware, submitCaseStudy);
router.get('/case-study/score/:docId',  authMiddleware, getScore);
router.get('/history',                  authMiddleware, getHistory);

module.exports = router;
