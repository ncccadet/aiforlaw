// courtSimulation.routes.js — v4
// Contract: _contracts/05-court-simulation.md
// MONTHLY limit: 16 sessions/month (per-college staggered, featureLimitMonthly) — on
// /start only. Turns/finish within a started session are free. Token caps: case
// 1500/1500, turn 1500/1500 (founder spec, includes everything), finish 9000/1200
// (this build's own choice — see contract).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitMonthly } = require('../middleware/featureLimit.middleware');
const {
  getCaseTypes,
  startSession,
  getSession,
  takeTurn,
  finishSession,
  getResult,
} = require('../controllers/courtSimulation.controller');

router.get('/case-types',   authMiddleware, getCaseTypes);
router.post('/start',       authMiddleware, featureLimitMonthly('court_simulation', 16), startSession);
router.get('/session/:id',  authMiddleware, getSession);  // poll while status='preparing'
router.post('/turn',        authMiddleware, takeTurn);     // student statement → judge + opposition
router.post('/finish',      authMiddleware, finishSession);
router.get('/result/:id',   authMiddleware, getResult);

module.exports = router;
