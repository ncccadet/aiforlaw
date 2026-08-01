/**
 * lawNews.worker.js — v3: daily real-article fetch + AI summary pipeline
 * Contract: _contracts/08-law-news-email.md
 *
 * Replaces the v2 "AI invents the news from its own knowledge, once a week"
 * design (a real hallucination/fake-link risk, flagged in that same
 * contract) with a fetch-then-summarize pipeline, the same shape as Job
 * Board's Source 1+3:
 *   1. Load active queries from news_queries (DB-driven, no deploy to add
 *      more coverage).
 *   2. For each query, fetch REAL articles via Google News RSS search
 *      (lawNewsFetch.service.js) — every item has a real title + real link.
 *   3. Dedupe by source_url (md5 hash) against both this run's own results
 *      and what's already cached — a story appearing under multiple
 *      queries, or already fetched yesterday and still live, is never
 *      re-summarized (saves cost, keeps ai_usage_log honest).
 *   4. Summarize up to NEWS_SUMMARIZE_MAX_PER_DAY (default 30) NEW articles
 *      via ONE Gemini call each (lawNewsSummarize.service.js — 1500 in /
 *      220 out), never more, regardless of how many queries/articles were
 *      found.
 *   5. Row-level fault isolation: one bad query or one article that fails
 *      to summarize never aborts the run (same pattern as Job Board).
 *   6. P006 (insert-before-delete): only run expiry cleanup if at least one
 *      row was inserted this run — a bad day never empties the feed.
 *
 * Runs daily at 1:00 UTC (~6:30am IST) — before students are typically
 * active. Run as its OWN process (not imported by app.js):
 *   pm2 start workers/lawNews.worker.js --name law-news-worker
 *
 * EMAIL DIGEST: deliberately NOT built yet — founder's explicit call, "in
 * two or three days" as a separate follow-on (see decisions-log 2026-07-23).
 * users.email_digest already exists and is wired up read/write via
 * lawNews.controller.js, ready for that later step.
 */
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');
const { Worker, Queue } = require('bullmq');
const { fetchArticlesForQuery } = require('../services/lawNewsFetch.service');
const { summarizeArticle } = require('../services/lawNewsSummarize.service');

// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });

const NEWS_SUMMARIZE_MAX_PER_DAY = parseInt(process.env.NEWS_SUMMARIZE_MAX_PER_DAY, 10) || 30;

const dedupeHash = (url) => crypto.createHash('md5').update(String(url || '').trim().toLowerCase()).digest('hex');

const logUsage = (model, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES (NULL, NULL, 'law_news', $1, $2, $3)`,
    [model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

async function runFetchAndSummarize() {
  const { rows: queries } = await pool.query(
    `SELECT query_id, query_text FROM news_queries WHERE is_active = TRUE`
  );
  if (queries.length === 0) {
    console.log('[law-news] No active queries in news_queries — nothing to do.');
    return;
  }

  // Gather real articles across all queries first, deduping in-memory by URL
  // (the same story routinely appears under several queries).
  const seenThisRun = new Map(); // dedupeHash -> article
  let queriesOk = 0, queriesFailed = 0;

  for (const q of queries) {
    try {
      const items = await fetchArticlesForQuery(q.query_text);
      for (const item of items) {
        const hash = dedupeHash(item.sourceUrl);
        if (!seenThisRun.has(hash)) seenThisRun.set(hash, item);
      }
      await pool.query(`UPDATE news_queries SET last_run_at = NOW() WHERE query_id = $1`, [q.query_id]);
      queriesOk++;
    } catch (err) {
      console.error(`[law-news] fetch failed for query "${q.query_text}":`, err.message);
      queriesFailed++;
    }
  }

  console.log(`[law-news] Fetched from ${queriesOk} queries (${queriesFailed} failed), ${seenThisRun.size} unique real articles found.`);

  // Skip articles already cached (still live, not expired) — never re-spend
  // a Gemini call summarizing something we already have.
  const allHashes = Array.from(seenThisRun.keys());
  const { rows: existing } = allHashes.length
    ? await pool.query(`SELECT dedupe_hash FROM news_cache WHERE dedupe_hash = ANY($1)`, [allHashes])
    : { rows: [] };
  const alreadyCached = new Set(existing.map((r) => r.dedupe_hash));

  const freshArticles = allHashes
    .filter((h) => !alreadyCached.has(h))
    .map((h) => seenThisRun.get(h));

  console.log(`[law-news] ${freshArticles.length} genuinely new articles (${alreadyCached.size} already cached, skipped).`);

  // Pacing between Gemini calls — found in real staging testing (2026-07-23)
  // that firing summarize calls back-to-back with zero delay blew through
  // Gemini's requests-per-minute limit (141/158 calls failed with 429 in one
  // real run). gemini.service.js now retries a 429 with backoff, but that
  // alone doesn't fix a sustained burst of 30 calls in a few seconds — so we
  // also pace calls here. 1.2s between calls keeps us under ~50 req/min,
  // comfortably below typical Gemini per-minute limits, while adding at most
  // ~36s total to a 30-call run (irrelevant for a once-daily background job).
  const PACE_MS = parseInt(process.env.NEWS_SUMMARIZE_PACE_MS, 10) || 1200;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let summarized = 0, failed = 0, inserted = 0;
  for (const article of freshArticles) {
    if (summarized >= NEWS_SUMMARIZE_MAX_PER_DAY) {
      console.log(`[law-news] Hit NEWS_SUMMARIZE_MAX_PER_DAY=${NEWS_SUMMARIZE_MAX_PER_DAY} — stopping early, not a bug.`);
      break;
    }
    if (summarized > 0) await sleep(PACE_MS);
    try {
      const result = await summarizeArticle(article);
      summarized++;
      if (result.tokensIn || result.tokensOut) logUsage(result.model, result.tokensIn, result.tokensOut);

      const hash = dedupeHash(article.sourceUrl);
      const { rowCount } = await pool.query(
        `INSERT INTO news_cache
           (source_name, source_url, title, summary, category, state_tag, dedupe_hash, published_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '48 hours')
         ON CONFLICT (dedupe_hash) DO NOTHING`,
        [article.sourceName, article.sourceUrl, article.title, result.summary, result.category, result.stateTag, hash, article.publishedAt]
      );
      if (rowCount > 0) inserted++;
    } catch (err) {
      console.error(`[law-news] summarize failed for "${article.title}":`, err.message);
      failed++;
    }
  }

  console.log(`[law-news] Summarized ${summarized} (${failed} failed), inserted ${inserted} new rows.`);

  // P006 — never delete expired rows on a run that inserted nothing; a bad
  // day (every query failing, or nothing new found) must not empty the feed.
  if (inserted === 0) {
    console.log('[law-news] 0 rows inserted this run — skipping expiry cleanup so the feed never goes empty.');
    return;
  }
  const { rowCount: expiredCount } = await pool.query(`DELETE FROM news_cache WHERE expires_at < NOW()`);
  console.log(`[law-news] Expiry cleanup: removed ${expiredCount} rows older than 48h.`);
}

// v4 (2026-07-25): NO LONGER runs as an always-on pm2/BullMQ Worker process.
// This job only ever needs to run once a day — keeping a full Node process +
// BullMQ Worker + Redis connection alive 24/7 to catch one scheduled firing
// was pure idle memory cost (~50-70MB, all day, every day) on a 1GB staging
// box. Now invoked as a one-shot script by system cron instead — see
// backend/scripts/runLawNewsOnce.js and _decisions/decisions-log.md
// (2026-07-25, "worker consolidation"). The BullMQ Worker/Queue path below is
// kept ONLY for local/manual testing (`node workers/lawNews.worker.js` still
// works exactly as before) — it does not run as a side effect of require().
if (require.main === module) {
  const newsQueue = new Queue('law-news', { connection: require('../config/redisConnection') });
  const scheduleJobs = async () => {
    await newsQueue.add('fetch-and-summarize', {}, { repeat: { pattern: '0 1 * * *' } });
  };
  const worker = new Worker('law-news', async (_job) => {
    await runFetchAndSummarize();
  }, { connection: require('../config/redisConnection') });

  worker.on('completed', (job) => console.log(`Law-news job ${job.id} done at ${new Date().toISOString()}`));
  worker.on('failed', (job, err) => console.error(`Law-news job ${job?.id} failed:`, err?.message));

  scheduleJobs().catch(console.error);
}

module.exports = { runFetchAndSummarize };
