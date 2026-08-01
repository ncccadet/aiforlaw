// aiInterviewer.routes.js — v3
// MONTHLY limit: 16 sessions/month, per-college staggered reset (matches
// Court Simulation's pattern) — enforced on /start only. Answering/finishing
// a session already started is free. STT/TTS are entirely browser-native
// (Web Speech API + speechSynthesis) — no /tts proxy route, no audio ever
// reaches the server.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitMonthly } = require('../middleware/featureLimit.middleware');
const {
  getInterviewOptions,
  startInterview,
  getSession,
  submitAnswer,
  finishInterview,
  getResult,
} = require('../controllers/aiInterviewer.controller');

router.get('/options',      authMiddleware, getInterviewOptions);
router.post('/start',       authMiddleware, featureLimitMonthly('ai_interviewer', 16), startInterview);
router.get('/session/:id',  authMiddleware, getSession);   // poll while status='preparing'
router.post('/answer',      authMiddleware, submitAnswer);
router.post('/finish',      authMiddleware, finishInterview);
router.get('/result/:id',   authMiddleware, getResult);

module.exports = router;
