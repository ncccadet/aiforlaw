/**
 * lawNews.controller.js — v3
 * Contract: _contracts/08-law-news-email.md
 *
 * getFeed        — GET /api/law-news/feed?state=<name|All India>
 *                   newest-first, only rows not yet expired (worker already
 *                   enforces 48h retention via expires_at + cleanup, but we
 *                   also filter here defensively in case cleanup lags).
 * getStates      — GET /api/law-news/states — dropdown source list, no
 *                   manual text entry per founder's explicit instruction.
 * getPreference / updatePreference — email-digest opt-in flag on users.
 *                   The actual daily email send is NOT built yet (deferred
 *                   by founder, "in two or three days" — decisions-log
 *                   2026-07-23); this just persists the preference so the
 *                   UI toggle has somewhere real to read/write.
 */
const { Pool } = require('pg');
const { INDIAN_STATES } = require('../services/lawNewsSummarize.service');

// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // matches auth.controller.js's proven-working pool
  max: 5,
});

const FEED_LIMIT = 100; // plenty for a 48h window at 30/day cap; simple safety bound, not a real constraint

const getFeed = async (req, res, next) => {
  try {
    const stateParam = (req.query.state || '').trim();
    const params = [];
    let where = `WHERE expires_at > NOW()`;
    if (stateParam && stateParam !== 'All India') {
      params.push(stateParam);
      where += ` AND state_tag = $${params.length}`;
    }
    params.push(FEED_LIMIT);
    const { rows } = await pool.query(
      `SELECT news_id, source_name, source_url, title, summary, category, state_tag, published_at, fetched_at
       FROM news_cache
       ${where}
       ORDER BY COALESCE(published_at, fetched_at) DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ items: rows });
  } catch (err) { next(err); }
};

const getStates = async (req, res, next) => {
  try {
    // "National" is the tag used for non-state-specific news (Supreme Court,
    // Parliament, etc.) — surfaced as "All India" in the dropdown, first,
    // alongside the real state list. No manual text entry anywhere.
    res.json({ states: ['All India', ...INDIAN_STATES] });
  } catch (err) { next(err); }
};

const getPreference = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT email_digest FROM users WHERE user_id = $1 AND college_id = $2`,
      [user_id, college_id]
    );
    res.json({ emailDigest: rows[0] ? rows[0].email_digest : true });
  } catch (err) { next(err); }
};

const updatePreference = async (req, res, next) => {
  try {
    const { emailDigest }         = req.body;
    const { user_id, college_id } = req.user;
    await pool.query(
      `UPDATE users SET email_digest = $1 WHERE user_id = $2 AND college_id = $3`,
      [!!emailDigest, user_id, college_id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

module.exports = { getFeed, getStates, getPreference, updatePreference };
