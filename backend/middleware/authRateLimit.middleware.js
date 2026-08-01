/**
 * authRateLimit.middleware.js — Level 3: per-EMAIL rate limiting.
 * Separate from rateLimit.middleware.js (per-IP, global) and
 * featureLimit.middleware.js (per-student AI usage caps).
 * Uses the same redis v4 client pattern as featureLimit.middleware.js.
 */
const { createClient } = require('redis');
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(console.error);

const makeAuthRateLimiter = ({ windowSeconds, max, keyPrefix }) => {
  return async (req, res, next) => {
    try {
      const email = (req.body?.email || '').toLowerCase().trim();
      if (!email) return next(); // let the controller handle missing email

      const redisKey = `ratelimit:${keyPrefix}:${email}`;
      const current = await redis.incr(redisKey);
      if (current === 1) await redis.expire(redisKey, windowSeconds);

      if (current > max) {
        return res.status(429).json({
          error: 'Too many attempts. Please try again later.',
          limit: max,
          used: current - 1
        });
      }

      next();
    } catch (err) { next(err); }
  };
};

// Login: 5 attempts / 15 min per email
const loginRateLimit = makeAuthRateLimiter({ windowSeconds: 15 * 60, max: 5, keyPrefix: 'login' });

// Forgot password: 3 requests / hour per email
const forgotPasswordRateLimit = makeAuthRateLimiter({ windowSeconds: 60 * 60, max: 3, keyPrefix: 'forgot' });

// Reset password: 5 attempts / 15 min per email
const resetPasswordRateLimit = makeAuthRateLimiter({ windowSeconds: 15 * 60, max: 5, keyPrefix: 'reset' });

module.exports = { loginRateLimit, forgotPasswordRateLimit, resetPasswordRateLimit };