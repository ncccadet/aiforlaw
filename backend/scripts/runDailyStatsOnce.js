/**
 * runDailyStatsOnce.js — one-shot nightly snapshot, triggered by SYSTEM CRON.
 *
 * Follows the same pattern as runJobScraperOnce.js and runLawNewsOnce.js
 * (2026-07-25 "worker consolidation"): a plain process that starts, runs once,
 * and exits, rather than a pm2 process holding ~50-70MB idle all day to catch
 * one firing.
 *
 * Install on the server (crontab -e):
 *   20 18 * * * cd /home/ubuntu/voxera-law/backend && /usr/bin/node scripts/runDailyStatsOnce.js >> /home/ubuntu/logs/daily-stats.log 2>&1
 *
 * 18:20 UTC = 23:50 IST. That time is NOT arbitrary — see the header comment
 * in workers/dailyStats.worker.js. It must land before midnight IST (so it
 * snapshots the day that is ending) and before the job-scraper and law-news
 * cleanups that delete history at 00:30 and 01:00 UTC.
 *
 * Manual catch-up for a specific day:
 *   node scripts/runDailyStatsOnce.js 2026-07-28
 * Re-running is safe — every write is an upsert.
 */
require('dotenv').config();
const { runDailySnapshot } = require('../workers/dailyStats.worker');

(async () => {
  const startedAt = Date.now();
  const dateArg = process.argv[2];

  if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error(`[runDailyStatsOnce] Bad date "${dateArg}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }

  try {
    await runDailySnapshot(dateArg || undefined);
    console.log(`[runDailyStatsOnce] Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
    process.exit(0);
  } catch (err) {
    // Exit non-zero so cron's mail / the log makes a failure visible rather
    // than a silently missing day that is only noticed when a report is empty.
    console.error('[runDailyStatsOnce] Run failed:', err);
    process.exit(1);
  }
})();
