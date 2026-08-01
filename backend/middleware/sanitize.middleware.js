/**
 * sanitize.middleware.js — Input sanitization
 *
 * Runs on every request with a body, before any feature logic.
 * 1. Strips HTML tags (prevents XSS stored in DB)
 * 2. Trims whitespace
 * 3. Sets req.inputFlagged = true for inputs over 2000 chars
 *    (controllers check this and reject — prevents prompt injection)
 */
const sanitizeString = (str) =>
  typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : str;

const sanitizeObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  // Arrays are typeof 'object' in JS too — without this check, the
  // Object.fromEntries(Object.entries(...)) path below silently turns any
  // array (e.g. Resume Builder's education/skills/experience lists) into a
  // plain {'0': ..., '1': ...} object. Every array-typed field in every JSON
  // body, on every route, was being corrupted this way since this middleware
  // runs globally before all feature logic. Found 2026-07-22 while debugging
  // Resume Builder's Education/Skills sections always scoring 0% even when
  // fully filled in and successfully "saved".
  if (Array.isArray(obj)) {
    return obj.map((v) =>
      typeof v === 'string' ? sanitizeString(v) :
      typeof v === 'object' ? sanitizeObject(v) : v
    );
  }
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === 'string' ? sanitizeString(v) :
      typeof v === 'object' ? sanitizeObject(v) : v,
    ])
  );
};

const sanitizeMiddleware = (req, _res, next) => {
  if (req.body) {
    req.body = sanitizeObject(req.body);
    if (JSON.stringify(req.body).length > 2000) req.inputFlagged = true;
  }
  next();
};

module.exports = { sanitizeMiddleware };
