/**
 * runJobScraperOnce.js — one-shot invocation of the job-board scrape sweep,
 * meant to be triggered by SYSTEM CRON, not pm2.
 *
 * Why this exists (2026-07-25 "worker consolidation"): job-scraper only
 * needs to run once every 2 days, but the old setup kept a full Node process
 * + BullMQ Worker + Redis connection alive 24/7 (via
 * `pm2 start jobScraper.worker.js`) just to catch that one scheduled firing
 * — pure idle memory cost, ~50-70MB all day every day, on a 1GB staging box.
 * This script does the same 3-stage sweep but as a plain process that
 * starts, runs once, and exits — memory is only held for the few minutes
 * the run actually takes.
 *
 * Install on the server via crontab -e — schedule: minute 30, hour 0, every
 * 2nd day-of-month, every month, any weekday (matches the old BullMQ repeat
 * pattern, run every 2 days at 00:30 UTC). NOTE: the literal cron line is
 * deliberately not written here with a bare asterisk-slash-2, since that
 * exact character sequence closes a JS block comment early. See the
 * decisions-log entry (2026-07-25, "worker consolidation") for the exact
 * line to paste into crontab.
 *
 * After this is installed and confirmed working, remove the old pm2 process:
 *   pm2 delete job-scraper-worker && pm2 save
 *
 * The BullMQ-based path in jobScraper.worker.js still exists and still works
 * (`node workers/jobScraper.worker.js`) for local/manual testing — this
 * script just calls the same underlying function directly, no queue involved.
 */
require('dotenv').config();
const { runFullScrapeSweep } = require('../workers/jobScraper.worker');

(async () => {
  const startedAt = Date.now();
  try {
    const result = await runFullScrapeSweep();
    console.log(`[runJobScraperOnce] Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. Inserted: ${result?.inserted ?? 'n/a'}`);
    process.exit(0);
  } catch (err) {
    console.error('[runJobScraperOnce] Run failed:', err);
    process.exit(1);
  }
})();
