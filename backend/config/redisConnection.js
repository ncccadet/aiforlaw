/**
 * redisConnection.js — shared ioredis connection for all BullMQ Queues/Workers.
 *
 * Bug fix (2026-07-20): every Queue/Worker previously did
 * `{ connection: { url: process.env.REDIS_URL } }` — ioredis has no `url`
 * option, so it silently ignored REDIS_URL and fell back to its default,
 * 127.0.0.1:6379. This was invisible on staging (Redis genuinely runs on
 * localhost there) but broke completely against a real Redis host like
 * production's ElastiCache. Fix: build one real IORedis instance from the
 * URL and reuse it everywhere. maxRetriesPerRequest: null is required by
 * BullMQ for its blocking commands.
 */
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

module.exports = connection;