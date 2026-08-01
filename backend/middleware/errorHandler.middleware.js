/**
 * errorHandler.middleware.js — Global error handler
 *
 * Must be registered LAST in app.js (after all routes).
 * Never exposes stack traces in production (aids attackers).
 * Logs to error_log table for Monday morning review.
 */
const { Pool } = require('pg');
// ssl option matches auth.controller.js's pool (proven working on staging) —
// without it this pool's own error_log write silently fails too, which is
// why no diagnostic row ever showed up for the dashboard 500s.
// max: 3 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md). Set
// lower than the others (3, not 5) since this pool is only touched when an
// error is actually being logged — inherently low, bursty volume, never the
// hot path.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const errorHandler = async (err, req, res, _next) => {
  const isDev = process.env.NODE_ENV === 'development';

  try {
    await pool.query(
      'INSERT INTO error_log (college_id, endpoint, error_message, created_at) VALUES ($1,$2,$3,NOW())',
      [req.user?.college_id || null, req.path, err.message]
    );
  } catch (_) { /* never let logging break the response */ }

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Something went wrong. Please try again.',
    ...(isDev && { stack: err.stack }),
  });
};

module.exports = { errorHandler };
