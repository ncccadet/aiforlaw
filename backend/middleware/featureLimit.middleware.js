/**
 * featureLimit.middleware.js — Level 2: per-student AI limits
 *
 * Uses Redis atomic INCR — NOT a database count check.
 * Why Redis not DB? If two requests hit at the same millisecond, a DB count
 * check can fail (both read count=1, both pass). Redis INCR is atomic.
 *
 * TWO WINDOW TYPES:
 *   featureLimit(name, n)        — n per DAY, resets midnight IST via TTL
 *   featureLimitWeekly(name, n)  — n per WEEK (Court Simulation + AI Interviewer
 *                                  are 4/week, NOT per-day). Key is ISO-week based.
 *
 * v2 NOTE — Monday-morning RPM spike:
 * If every college's weekly counters reset at the same instant (Monday 00:00 IST),
 * all students regain sessions simultaneously → Gemini RPM spike Monday morning.
 * Mitigation: the weekly key embeds college_id and the reset is offset per college
 * by a stable hash (0–48h stagger). Colleges reset at different points in the week.
 */
const { createClient } = require('redis');
const crypto = require('crypto');

const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(console.error);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── Key builders — shared by the middleware AND getDailyUsage/getWeeklyUsage
// below (dashboard.summary reads the exact same keys, read-only). Keeping the
// key format in one place means the dashboard's "used" count can never drift
// out of sync with what actually gates a request.
const dailyKey = (userId, featureName) => {
  const nowIST  = new Date(Date.now() + IST_OFFSET_MS);
  const dateKey = nowIST.toISOString().slice(0, 10);
  return `feature_limit:${userId}:${featureName}:${dateKey}`;
};

const weeklyKey = (userId, collegeId, featureName) => {
  const staggered = Date.now() + IST_OFFSET_MS - collegeStaggerMs(collegeId);
  const weekIndex = Math.floor((staggered - 4 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000));
  return `feature_limit_wk:${userId}:${featureName}:${weekIndex}`;
};

// ── Monthly limit — CALENDAR month (YYYY-MM), not a rolling 30-day bucket,
// since months vary 28–31 days and a fixed-length bucket would drift out of
// sync with "resets on the 1st" over time. Same per-college stagger idea as
// weekly (spread across 0–7 days here, wider than weekly's 0–48h, since a
// month-boundary spike affects a full day of traffic, not just an hour) so
// every college doesn't reset at midnight IST on the 1st simultaneously.
const monthlyStaggerMs = (collegeId) => {
  const h = crypto.createHash('md5').update(String(collegeId)).digest();
  return (h.readUInt16BE(2) % 168) * 60 * 60 * 1000; // 0–7 days
};

const monthlyKey = (userId, collegeId, featureName) => {
  const staggered = new Date(Date.now() + IST_OFFSET_MS - monthlyStaggerMs(collegeId));
  const monthKey = staggered.toISOString().slice(0, 7); // YYYY-MM
  return `feature_limit_mo:${userId}:${featureName}:${monthKey}`;
};

// ── Read-only usage lookups for the dashboard summary — never INCR, so
// just checking your dashboard can't itself burn a turn of the limit.
const getDailyUsage = async (userId, featureName) => {
  const val = await redis.get(dailyKey(userId, featureName));
  return val ? parseInt(val, 10) : 0;
};

const getWeeklyUsage = async (userId, collegeId, featureName) => {
  const val = await redis.get(weeklyKey(userId, collegeId, featureName));
  return val ? parseInt(val, 10) : 0;
};

const getMonthlyUsage = async (userId, collegeId, featureName) => {
  const val = await redis.get(monthlyKey(userId, collegeId, featureName));
  return val ? parseInt(val, 10) : 0;
};

// ── Daily limit (unchanged behaviour) ────────────────────────────────────────
const featureLimit = (featureName, maxPerDay) => async (req, res, next) => {
  try {
    const { user_id } = req.user;
    const redisKey = dailyKey(user_id, featureName);

    const current = await redis.incr(redisKey);
    if (current === 1) await redis.expire(redisKey, 90000); // ~25h buffer

    if (current > maxPerDay) {
      return res.status(429).json({
        error: `Daily limit reached for ${featureName}. Resets at midnight IST.`,
        limit: maxPerDay,
        used: current - 1,
      });
    }
    req.featureUsageCount = current;
    next();
  } catch (err) {
    console.warn(`[featureLimit] Redis note (${featureName}):`, err.message);
    next();
  }
};

// ── Weekly limit (v2 — Court Simulation & AI Interviewer: 4/week) ────────────
const collegeStaggerMs = (collegeId) => {
  // Stable 0–48h offset per college so weekly resets don't all land Monday 00:00 IST
  const h = crypto.createHash('md5').update(String(collegeId)).digest();
  return (h.readUInt16BE(0) % 48) * 60 * 60 * 1000;
};

const featureLimitWeekly = (featureName, maxPerWeek) => async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const redisKey = weeklyKey(user_id, college_id, featureName);

    const current = await redis.incr(redisKey);
    if (current === 1) await redis.expire(redisKey, 8 * 24 * 60 * 60); // 8-day buffer

    if (current > maxPerWeek) {
      return res.status(429).json({
        error: `Weekly limit reached for ${featureName} (${maxPerWeek}/week). Resets next week.`,
        limit: maxPerWeek,
        used: current - 1,
      });
    }
    req.featureUsageCount = current;
    next();
  } catch (err) {
    console.warn(`[featureLimitWeekly] Redis note (${featureName}):`, err.message);
    next();
  }
};

const featureLimitMonthly = (featureName, maxPerMonth) => async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const redisKey = monthlyKey(user_id, college_id, featureName);

    const current = await redis.incr(redisKey);
    if (current === 1) await redis.expire(redisKey, 33 * 24 * 60 * 60); // 33-day buffer covers longest month + stagger

    if (current > maxPerMonth) {
      return res.status(429).json({
        error: `Monthly limit reached for ${featureName} (${maxPerMonth}/month). Resets next month.`,
        limit: maxPerMonth,
        used: current - 1,
      });
    }
    req.featureUsageCount = current;
    next();
  } catch (err) {
    console.warn(`[featureLimitMonthly] Redis note (${featureName}):`, err.message);
    next();
  }
};

module.exports = { featureLimit, featureLimitWeekly, featureLimitMonthly, getDailyUsage, getWeeklyUsage, getMonthlyUsage };
