/**
 * runLawNewsOnce.js — one-shot invocation of the daily law-news fetch, meant
 * to be triggered by SYSTEM CRON, not pm2.
 *
 * Why this exists (2026-07-25 "worker consolidation"): law-news only needs
 * to run once a day, but the old setup kept a full Node process + BullMQ
 * Worker + Redis connection alive 24/7 (via `pm2 start lawNews.worker.js`)
 * just to catch that one scheduled firing — pure idle memory cost, ~50-70MB
 * all day every day, on a 1GB staging box. This script does the same work
 * but as a plain process that starts, runs once, and exits — memory is only
 * held for the few minutes the run actually takes.
 *
 * Install on the server (crontab -e):
 *   0 1 * * * cd /home/ubuntu/voxera-law/backend && /usr/bin/node scripts/runLawNewsOnce.js >> /home/ubuntu/logs/law-news.log 2>&1
 * (matches the old BullMQ repeat pattern '0 1 * * *' — daily at 01:00 UTC)
 *
 * After this is installed and confirmed working, remove the old pm2 process:
 *   pm2 delete law-news-worker && pm2 save
 *
 * The BullMQ-based path in lawNews.worker.js still exists and still works
 * (`node workers/lawNews.worker.js`) for local/manual testing — this script
 * just calls the same underlying function directly, no queue involved.
 */
require('dotenv').config();
const { runFetchAndSummarize } = require('../workers/lawNews.worker');

(async () => {
  const startedAt = Date.now();
  try {
    await runFetchAndSummarize();
    console.log(`[runLawNewsOnce] Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
    process.exit(0);
  } catch (err) {
    console.error('[runLawNewsOnce] Run failed:', err);
    process.exit(1);
  }
})();
