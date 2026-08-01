/**
 * jobScraper.worker.js — v3: three-source pipeline, every 2 days
 *
 * SOURCE 1 — DIRECT SCRAPE: the curated 785 sites in the job_sources table
 *            (implemented — see services/directScrape.service.js).
 * SOURCE 2 — PROVIDER APIs: SerpApi + JSearch + Adzuna + Apify.
 *            SerpApi is READY (SERPAPI_KEY). JSearch and Adzuna code was
 *            added 2026-07-27 (see services/providerApi.service.js header)
 *            but are waiting on real credentials — JSEARCH_API_KEY for
 *            JSearch, ADZUNA_APP_ID + ADZUNA_APP_KEY for Adzuna. Apify is
 *            plumbing-only, waiting on a chosen APIFY_ACTOR_ID. Each is
 *            independently guarded below so a missing key/actor cleanly
 *            skips that one provider with a log line, never a crash.
 * SOURCE 3 — LLM EXTRACT: raw HTML -> Gemini -> structured listing, only
 *            for job_sources rows with scrape_method='llm_extract'
 *            (implemented — see services/llmExtract.service.js). Hard
 *            capped at LLM_EXTRACT_MAX_PER_RUN per run (default 50).
 *
 * Students NEVER trigger external calls — they only read job_cache.
 *
 * CRITICAL RULES (contract 03, non-negotiable):
 *   P006 — INSERT new before DELETE expired. Never delete first.
 *   Row-level fault isolation — EACH source upserts in its own try/catch.
 *   One broken site out of 785 must not kill the whole run.
 *   Dedupe — dedupe_hash = md5(title+firm+apply_url), UNIQUE + ON CONFLICT
 *   DO NOTHING, so the same job found twice (e.g. direct scrape AND LLM
 *   extract both find it) enters job_cache once.
 *   expires_at = 72h (NOT 48h): cadence is 2 days; 48h expiry + one delayed
 *   run = empty job board.
 *   Auto-disable: a source is set is_active=false after 5 consecutive
 *   failures, logged to error_log for the Monday review — not silently
 *   retried forever.
 */

// Loads .env into process.env — this worker runs as its own standalone
// pm2 process, not through app.js, so nothing else guarantees .env has been
// read. Without this, DATABASE_URL/REDIS_URL/AWS/GEMINI env vars are
// silently undefined (found 2026-07-22 while debugging resumeAnalyzer.worker.js
// — same bug existed here). Matches otp.worker.js's existing pattern.
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { Worker, Queue } = require('bullmq');
const connection = require('../config/redisConnection');
const { scrapeSource } = require('../services/directScrape.service');
const { extractListingsFromSource } = require('../services/llmExtract.service');
const { fetchFromSerpApi, fetchFromJSearch, fetchFromAdzuna, fetchFromApify } = require('../services/providerApi.service');

// max: 10 — pool cap, deliberately HIGHER than the max:5 used everywhere else
// (2026-07-25 connection-pool sizing pass, decisions-log.md). This file's own
// DIRECT_SCRAPE_CONCURRENCY=8 genuinely opens up to 8 simultaneous
// connections during Stage 1 (runWithConcurrency) — capping this pool at 5
// would have throttled a working, intentional parallelism, not just idle
// waste. 10 preserves that behavior with a little headroom.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // matches auth.controller.js's proven-working pool
  max: 10,
});

const LLM_EXTRACT_MAX_PER_RUN = parseInt(process.env.LLM_EXTRACT_MAX_PER_RUN, 10) || 50;
const DIRECT_SCRAPE_CONCURRENCY = 8; // bounded parallel fetches within one run, not 785 sequential

const dedupeHash = (title, firm, applyUrl) =>
  crypto
    .createHash('md5')
    .update(`${(title || '').trim().toLowerCase()}|${(firm || '').trim().toLowerCase()}|${(applyUrl || '').trim().toLowerCase()}`)
    .digest('hex');

/** Tiny bounded-concurrency runner — no need for a new dependency for this. */
async function runWithConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]).catch((err) => ({ __error: err }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function upsertListings(client, listings, sourceType, sourceApi, sourceUrl) {
  let inserted = 0;
  for (const job of listings) {
    const hash = dedupeHash(job.title, job.firm, job.apply_url);
    const result = await client.query(
      `INSERT INTO job_cache
         (source_type, source_api, source_url, dedupe_hash, title, firm, location, job_type, apply_url, is_government, salary_text, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + INTERVAL '72 hours')
       ON CONFLICT (dedupe_hash) DO NOTHING`,
      [sourceType, sourceApi, sourceUrl, hash, job.title, job.firm, job.location, job.job_type, job.apply_url, job.is_government ?? null, job.salary_text ?? null]
    );
    if (result.rowCount > 0) inserted++;
  }
  return inserted;
}

async function markSourceResult(client, sourceId, status, resetFailCount) {
  if (resetFailCount) {
    await client.query(
      `UPDATE job_sources SET last_scraped_at = NOW(), last_status = $2, fail_count = 0 WHERE source_id = $1`,
      [sourceId, status]
    );
  } else {
    const { rows } = await client.query(
      `UPDATE job_sources
         SET last_scraped_at = NOW(), last_status = $2, fail_count = fail_count + 1
       WHERE source_id = $1
       RETURNING fail_count`,
      [sourceId, status]
    );
    const failCount = rows[0]?.fail_count ?? 0;
    if (failCount >= 5) {
      await client.query(`UPDATE job_sources SET is_active = FALSE WHERE source_id = $1`, [sourceId]);
      await client.query(
        `INSERT INTO error_log (college_id, endpoint, error_message, created_at) VALUES (NULL, $1, $2, NOW())`,
        ['job-scraper', `Source auto-disabled after 5 consecutive failures: source_id=${sourceId}`]
      );
    }
  }
}

async function runDirectScrapeStage() {
  const { rows: sources } = await pool.query(
    `SELECT source_id, name, url, category FROM job_sources WHERE is_active = TRUE AND scrape_method = 'direct'`
  );

  let totalInserted = 0;
  let ok = 0, failed = 0, empty = 0;

  await runWithConcurrency(sources, DIRECT_SCRAPE_CONCURRENCY, async (source) => {
    // Each source gets its own client + transaction — one dead site of 785
    // must not kill the whole run, and a failed upsert shouldn't leave a
    // half-written batch for that source.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const listings = await scrapeSource(source);
      const inserted = await upsertListings(client, listings, 'direct_scrape', null, source.url);
      await markSourceResult(client, source.source_id, listings.length > 0 ? 'ok' : 'empty', true);
      await client.query('COMMIT');
      totalInserted += inserted;
      if (listings.length > 0) ok++; else empty++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      try {
        await markSourceResult(pool, source.source_id, 'failed', false);
      } catch (_) { /* never let bookkeeping failure mask the real error below */ }
      console.error(`[job-scraper] direct scrape failed for ${source.name} (${source.url}):`, err.message);
      failed++;
    } finally {
      client.release();
    }
  });

  console.log(`[job-scraper] Stage 1 (direct): ${sources.length} sources — ok=${ok} empty=${empty} failed=${failed}, inserted=${totalInserted}`);
  return totalInserted;
}

async function runProviderApiStage() {
  // SerpApi (google_jobs) and Apify — each independently guarded (missing
  // key/actor = clean skip, logged, never a crash) and each upserted in its
  // own try/catch so one provider being down/erroring can't block the
  // other or Stages 1/3. Adzuna deliberately not wired up yet — only one of
  // its two required credentials (app_id + app_key) has been provided so
  // far (2026-07-22, see decisions-log.md).
  let totalInserted = 0;

  try {
    const { listings, queriesUsed } = await fetchFromSerpApi();
    if (listings.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await upsertListings(client, listings, 'provider_api', 'serpapi', null);
        await client.query('COMMIT');
        totalInserted += inserted;
        console.log(`[job-scraper] Stage 2 (SerpApi): ${queriesUsed} queries used, ${listings.length} results, ${inserted} new rows inserted.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[job-scraper] SerpApi upsert failed:', err.message);
      } finally {
        client.release();
      }
    } else if (queriesUsed > 0) {
      console.log(`[job-scraper] Stage 2 (SerpApi): ${queriesUsed} queries used, 0 results.`);
    }
  } catch (err) {
    console.error('[job-scraper] Stage 2 (SerpApi) failed unexpectedly:', err.message);
  }

  try {
    const { listings, actorRun } = await fetchFromApify();
    if (listings.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await upsertListings(client, listings, 'provider_api', 'apify', null);
        await client.query('COMMIT');
        totalInserted += inserted;
        console.log(`[job-scraper] Stage 2 (Apify): ${listings.length} results, ${inserted} new rows inserted.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[job-scraper] Apify upsert failed:', err.message);
      } finally {
        client.release();
      }
    } else if (actorRun) {
      console.log('[job-scraper] Stage 2 (Apify): actor ran, 0 usable results — check the field-name log line above and tune mapApifyItem() in providerApi.service.js.');
    }
  } catch (err) {
    console.error('[job-scraper] Stage 2 (Apify) failed unexpectedly:', err.message);
  }

  try {
    const { listings, queriesUsed } = await fetchFromJSearch();
    if (listings.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await upsertListings(client, listings, 'provider_api', 'jsearch', null);
        await client.query('COMMIT');
        totalInserted += inserted;
        console.log(`[job-scraper] Stage 2 (JSearch): ${queriesUsed} queries used, ${listings.length} results, ${inserted} new rows inserted.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[job-scraper] JSearch upsert failed:', err.message);
      } finally {
        client.release();
      }
    } else if (queriesUsed > 0) {
      console.log(`[job-scraper] Stage 2 (JSearch): ${queriesUsed} queries used, 0 results.`);
    }
  } catch (err) {
    console.error('[job-scraper] Stage 2 (JSearch) failed unexpectedly:', err.message);
  }

  try {
    const { listings, queriesUsed } = await fetchFromAdzuna();
    if (listings.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await upsertListings(client, listings, 'provider_api', 'adzuna', null);
        await client.query('COMMIT');
        totalInserted += inserted;
        console.log(`[job-scraper] Stage 2 (Adzuna): ${queriesUsed} queries used, ${listings.length} results, ${inserted} new rows inserted.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[job-scraper] Adzuna upsert failed:', err.message);
      } finally {
        client.release();
      }
    } else if (queriesUsed > 0) {
      console.log(`[job-scraper] Stage 2 (Adzuna): ${queriesUsed} queries used, 0 results.`);
    }
  } catch (err) {
    console.error('[job-scraper] Stage 2 (Adzuna) failed unexpectedly:', err.message);
  }

  return totalInserted;
}

async function runLlmExtractStage() {
  const { rows: sources } = await pool.query(
    `SELECT source_id, name, url, category FROM job_sources
     WHERE is_active = TRUE AND scrape_method = 'llm_extract'
     LIMIT $1`,
    [LLM_EXTRACT_MAX_PER_RUN]
  );

  if (sources.length === 0) {
    console.log('[job-scraper] Stage 3 (LLM extract): no sources currently flagged scrape_method=llm_extract — nothing to do.');
    return 0;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.log('[job-scraper] Stage 3 (LLM extract) skipped — GEMINI_API_KEY not set.');
    return 0;
  }

  let totalInserted = 0;
  let callsUsed = 0;

  for (const source of sources) {
    if (callsUsed >= LLM_EXTRACT_MAX_PER_RUN) {
      console.log(`[job-scraper] Stage 3 hit LLM_EXTRACT_MAX_PER_RUN=${LLM_EXTRACT_MAX_PER_RUN} — stopping early, not a bug.`);
      break;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { listings, tokensIn, tokensOut } = await extractListingsFromSource(source);
      callsUsed++;
      const inserted = await upsertListings(client, listings, 'llm_extract', 'gemini', source.url);
      await client.query(
        `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out, created_at)
         VALUES (NULL, NULL, 'job_board', $1, $2, $3, NOW())`,
        [process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
      );
      await markSourceResult(client, source.source_id, listings.length > 0 ? 'ok' : 'empty', true);
      await client.query('COMMIT');
      totalInserted += inserted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      try {
        await markSourceResult(pool, source.source_id, 'failed', false);
      } catch (_) { /* ignore bookkeeping failure */ }
      console.error(`[job-scraper] LLM extract failed for ${source.name} (${source.url}):`, err.message);
    } finally {
      client.release();
    }
  }

  console.log(`[job-scraper] Stage 3 (LLM extract): ${callsUsed} calls used (cap ${LLM_EXTRACT_MAX_PER_RUN}), inserted=${totalInserted}`);
  return totalInserted;
}

async function runExpiryCleanup(totalInsertedThisRun) {
  // P006 — insert-before-delete. If a run inserted nothing at all (e.g. every
  // source failed, or a bad deploy broke scraping), do NOT delete expired
  // rows — that would leave students with an empty board instead of
  // yesterday's (stale but real) listings.
  if (totalInsertedThisRun === 0) {
    console.log('[job-scraper] 0 rows inserted this run — skipping expiry cleanup so the board never goes empty.');
    return;
  }
  const { rowCount } = await pool.query(`DELETE FROM job_cache WHERE expires_at < NOW()`);
  console.log(`[job-scraper] Expiry cleanup: removed ${rowCount} expired rows.`);
}

async function runFullScrapeSweep() {
  console.log('[job-scraper] Run started at', new Date().toISOString());
  const stage1 = await runDirectScrapeStage();
  const stage2 = await runProviderApiStage();
  const stage3 = await runLlmExtractStage();
  const total = stage1 + stage2 + stage3;
  await runExpiryCleanup(total);
  console.log(`[job-scraper] Run complete. Total new rows inserted: ${total}`);
  return { inserted: total };
}

// v4 (2026-07-25): NO LONGER runs as an always-on pm2/BullMQ Worker process.
// This job only ever needs to run once every 2 days — keeping a full Node
// process + BullMQ Worker + Redis connection alive 24/7 to catch one
// scheduled firing was pure idle memory cost (~50-70MB, all day, every day)
// on a 1GB staging box. Now invoked as a one-shot script by system cron
// instead — see backend/scripts/runJobScraperOnce.js and
// _decisions/decisions-log.md (2026-07-25, "worker consolidation"). The
// BullMQ Worker/Queue path below is kept ONLY for local/manual testing
// (`node workers/jobScraper.worker.js` still works exactly as before) — it
// does not run as a side effect of require().
if (require.main === module) {
  const scrapeQueue = new Queue('job-scraper', { connection });
  const scheduleJobs = async () => {
    // Every 2 days at 00:30 UTC (~6am IST): pattern '30 0 */2 * *'
    await scrapeQueue.add('scrape', {}, { repeat: { pattern: '30 0 */2 * *' } });
  };
  const worker = new Worker(
    'job-scraper',
    async (_job) => runFullScrapeSweep(),
    {
      connection,
      // One 'scrape' job runs the whole sweep internally (bounded concurrency
      // inside runDirectScrapeStage/runLlmExtractStage) — this just caps how
      // many 'scrape' JOBS run at once, which should only ever be 1.
      concurrency: 1,
    }
  );

  worker.on('completed', (job, result) => console.log(`[job-scraper] job ${job.id} completed:`, result));
  worker.on('failed', (job, err) => console.error(`[job-scraper] job ${job?.id} failed:`, err.message));

  scheduleJobs().catch(console.error);
}

module.exports = { runFullScrapeSweep, runDirectScrapeStage, runProviderApiStage, runLlmExtractStage };
