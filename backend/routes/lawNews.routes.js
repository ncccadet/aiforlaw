// lawNews.routes.js — v3
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getFeed, getStates, getPreference, updatePreference } = require('../controllers/lawNews.controller');

// Feed is read-only, no AI cost per request (all summarizing happens once,
// daily, in the worker) — no featureLimit middleware needed, same reasoning
// as Job Board's browse endpoints.
router.get('/feed',   authMiddleware, getFeed);
router.get('/states', authMiddleware, getStates);

// Email digest preference (actual sending not built yet — see controller).
router.get('/preference', authMiddleware, getPreference);
router.put('/preference', authMiddleware, updatePreference);

module.exports = router;
