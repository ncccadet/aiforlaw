/**
 * auth.controller.js
 * Tokens in httpOnly cookies. Expiry from .env (JWT_ACCESS_EXPIRES / JWT_REFRESH_EXPIRES).
 * Single-device enforced via active_session_version.
 */
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { Queue } = require('bullmq');
// pool: still needed for the ONE genuinely unscoped case in this file — looking
// a user up by email alone, before we know which college they belong to (see
// `login`, `forgotPassword`, `resetPassword` below). queryAsCollege is used for
// every query below that, once college_id is known, so RLS (added 2026-07-26,
// migrations/20260726_rls_policies.sql) actually protects this controller's
// per-user queries — not just the app-code college_id filters that were
// already here.
const { pool, queryAsCollege } = require('../config/db');
const otpQueue = new Queue('send-otp-email', { connection: require('../config/redisConnection') });

const msFromExpiry = (expiry) => {
  // Converts '15m' / '7d' style strings from .env into milliseconds for cookie maxAge
  const value = parseInt(expiry, 10);
  if (expiry.endsWith('m')) return value * 60 * 1000;
  if (expiry.endsWith('d')) return value * 24 * 60 * 60 * 1000;
  if (expiry.endsWith('h')) return value * 60 * 60 * 1000;
  return value * 1000; // assume seconds
};

const ACCESS_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'strict', maxAge: msFromExpiry(process.env.JWT_ACCESS_EXPIRES) };
const REFRESH_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'strict', maxAge: msFromExpiry(process.env.JWT_REFRESH_EXPIRES) };

const signAccessToken = (payload) => jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: process.env.JWT_ACCESS_EXPIRES });
const signRefreshToken = (payload) => jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES });
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Unscoped on purpose: we don't know which college this email belongs to
    // yet — that's the whole point of this query. RLS falls back to
    // unrestricted when app.current_college_id isn't set, so this still works
    // correctly; every query below this point DOES know college_id and is
    // scoped via queryAsCollege.
    const { rows } = await pool.query(
      'SELECT user_id, college_id, email, hashed_password, role FROM users WHERE email = $1',
      [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const passwordMatches = await bcrypt.compare(password, user.hashed_password);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const { rows: versionRows } = await queryAsCollege(
      user.college_id,
      'UPDATE users SET active_session_version = active_session_version + 1 WHERE user_id = $1 RETURNING active_session_version',
      [user.user_id]
    );
    const sessionVersion = versionRows[0].active_session_version;

    const payload = { user_id: user.user_id, college_id: user.college_id, role: user.role, session_version: sessionVersion };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res
      .cookie('accessToken', accessToken, ACCESS_COOKIE_OPTS)
      .cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTS)
      .json({ user: { user_id: user.user_id, email: user.email, college_id: user.college_id, role: user.role } });
  } catch (err) { next(err); }
};

const logout = async (req, res, next) => {
  try {
    res.clearCookie('accessToken').clearCookie('refreshToken').json({ ok: true });
  } catch (err) { next(err); }
};

const refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { rows } = await queryAsCollege(
      decoded.college_id,
      'SELECT active_session_version FROM users WHERE user_id = $1',
      [decoded.user_id]
    );
    if (rows.length === 0 || decoded.session_version !== rows[0].active_session_version) {
      return res.status(401).json({ error: 'Logged in on another device' });
    }

    const payload = { user_id: decoded.user_id, college_id: decoded.college_id, role: decoded.role, session_version: decoded.session_version };
    const accessToken = signAccessToken(payload);

    res.cookie('accessToken', accessToken, ACCESS_COOKIE_OPTS).json({ ok: true });
  } catch (err) { next(err); }
};

const me = async (req, res, next) => {
  try {
    const { rows } = await queryAsCollege(
      req.user.college_id,
      'SELECT user_id, email, college_id, role, created_at FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const GENERIC_RESPONSE = { message: 'If that email exists, an OTP has been sent' };
    // Unscoped on purpose, same reason as login: college_id isn't known until
    // we find the user by email.
    const { rows } = await pool.query('SELECT user_id, college_id FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(200).json(GENERIC_RESPONSE);

    const { user_id: userId, college_id: collegeId } = rows[0];
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);

    await queryAsCollege(
      collegeId,
      `INSERT INTO password_resets (user_id, otp_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`,
      [userId, otpHash]
    );

    await otpQueue.add('send-otp-email', { email, otp });
    res.status(200).json(GENERIC_RESPONSE);
  } catch (err) { next(err); }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required' });
    }

    const GENERIC_ERROR = { error: 'Invalid or expired code' };
    // Unscoped on purpose, same reason as login/forgotPassword.
    const { rows: userRows } = await pool.query('SELECT user_id, college_id FROM users WHERE email = $1', [email]);
    if (userRows.length === 0) return res.status(400).json(GENERIC_ERROR);
    const { user_id: userId, college_id: collegeId } = userRows[0];

    const { rows: resetRows } = await queryAsCollege(
      collegeId,
      `SELECT reset_id, otp_hash FROM password_resets
       WHERE user_id = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (resetRows.length === 0) return res.status(400).json(GENERIC_ERROR);

    const { reset_id, otp_hash } = resetRows[0];
    const otpMatches = await bcrypt.compare(otp, otp_hash);
    if (!otpMatches) return res.status(400).json(GENERIC_ERROR);

    const newHash = await bcrypt.hash(newPassword, 10);
    await queryAsCollege(
      collegeId,
      'UPDATE users SET hashed_password = $1, active_session_version = active_session_version + 1 WHERE user_id = $2',
      [newHash, userId]
    );
    await queryAsCollege(collegeId, 'UPDATE password_resets SET used = true WHERE reset_id = $1', [reset_id]);

    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
};

module.exports = { login, logout, refresh, me, forgotPassword, resetPassword };
