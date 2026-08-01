/**
 * rateLimit.middleware.js — Level 1: abuse / DDoS protection.
 *
 * Level 2 (per-student daily AI limits) is in featureLimit.middleware.js.
 * Level 3 (per-EMAIL login attempt limits) is in authRateLimit.middleware.js.
 * All three must exist. They solve different problems.
 *
 * WHY THIS IS NOT SIMPLY "100 REQUESTS PER IP"
 * --------------------------------------------
 * It was, until 2026-07-30, and that would have broken the first college
 * demo. An entire class sits on one campus wifi, which means every student
 * leaves through the SAME public IP after NAT. Seventy students opening the
 * dashboard together is several hundred requests in one minute from what the
 * server sees as a single address — so the first dozen students would get in
 * and everyone after them would be told "Too many requests. Please slow
 * down." The software would look broken at precisely the worst moment, and
 * nothing in the logs would say "rate limit" to a non-engineer reading them.
 *
 * The fix is to count per STUDENT once we know who they are. A logged-in
 * student carries a signed accessToken cookie, so we verify it here and use
 * their user_id as the bucket key. Two students on the same wifi now have two
 * separate budgets, which is what "100 requests per minute" was always meant
 * to express.
 *
 * Requests we cannot attribute to a student — the login page itself, the
 * refresh endpoint, static asset fetches, and anything from an attacker — all
 * still fall back to the IP bucket. That bucket is deliberately generous
 * (ANON_MAX) because it is shared by a whole campus, and it is NOT what
 * protects the login form: brute-force protection is per-email in
 * authRateLimit.middleware.js (5 attempts / 15 min for one address, no matter
 * how many IPs it comes from), which a big anonymous bucket does not weaken.
 *
 * WHY jwt.verify AND NOT jwt.decode
 * ---------------------------------
 * decode() would let anyone hand us an unsigned token with a made-up user_id
 * and mint themselves a fresh rate-limit bucket per request — the limiter
 * would exist but stop anyone from ever hitting it. verify() costs one HMAC,
 * which is nothing next to the database call authMiddleware makes moments
 * later. A failed verification is not an error here: this middleware never
 * rejects anyone for a bad token, it just falls back to the IP bucket and
 * lets authMiddleware issue the actual 401.
 */
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// Per authenticated student, per minute. A student cannot realistically
// generate this from normal use — it is here to catch a runaway client loop
// or a stolen session being scripted, not to ration ordinary browsing.
const STUDENT_MAX = 120;

// Shared by every unauthenticated request from one public IP — i.e. a whole
// lecture hall arriving at the login page at once. Sized for a campus, not
// for one person.
const ANON_MAX = 600;

/**
 * IPv6 addresses are handed out a colossal block at a time, so keying on the
 * full address lets one client rotate through addresses for free. Collapse to
 * the /64 that a single subscriber actually gets. IPv4 is used as-is.
 */
function ipKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':') + '::/64';
}

/** The student's id when we can prove it, otherwise their (shared) IP. */
function resolveKey(req) {
  const token = req.cookies?.accessToken;
  if (token && process.env.JWT_ACCESS_SECRET) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      if (decoded?.user_id) return `u:${decoded.user_id}`;
    } catch {
      // Expired or forged — fall through to the IP bucket. authMiddleware
      // is the thing that says no; this middleware only counts.
    }
  }
  return `ip:${ipKey(req)}`;
}

const rateLimitMiddleware = rateLimit({
  windowMs: 60 * 1000,
  // express-rate-limit accepts a function here, so the same limiter can hold
  // a tight budget for one identified student and a loose one for a shared
  // campus address without needing two middlewares in the chain.
  max: (req) => (resolveKey(req).startsWith('u:') ? STUDENT_MAX : ANON_MAX),
  keyGenerator: resolveKey,
  standardHeaders: true,
  legacyHeaders: false,
  // NOTE: express-rate-limit 7.5.1 (the version pinned here) has no
  // `keyGeneratorIpFallback` validation and rejects it as an unknown option,
  // so there is nothing to silence — IPv6 normalisation is entirely ours, in
  // ipKey() above. If this package is ever upgraded and the server starts
  // logging an ERR_ERL_KEY_GEN_IPV6 warning, that is the option to add back.
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { rateLimitMiddleware };
