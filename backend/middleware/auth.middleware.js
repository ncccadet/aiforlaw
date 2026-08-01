/**
 * auth.middleware.js — JWT verification + single-device enforcement.
 */
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md). This
// pool is hit on EVERY authenticated request (JWT verification), so 5 is
// deliberately not set any lower than the rest despite the high call volume
// — each check is a single fast indexed lookup, not a bottleneck.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const authMiddleware = async (req, res, next) => {
  let token = req.cookies?.accessToken;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const { rows } = await pool.query(
      'SELECT active_session_version FROM users WHERE user_id = $1',
      [decoded.user_id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (decoded.session_version !== rows[0].active_session_version) {
      return res.status(401).json({ error: 'Logged in on another device' });
    }

    req.user = { user_id: decoded.user_id, college_id: decoded.college_id, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authMiddleware };
