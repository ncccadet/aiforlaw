/**
 * jobBoard.controller.js
 * Queries job_cache ONLY. Students never hit external APIs.
 * Fixed cost: 2 API calls/day regardless of student traffic.
 */
const { Pool } = require('pg');
const { locationRegexForState } = require('../utils/indianStates');
// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // matches auth.controller.js's proven-working pool
  max: 5,
});

const PAGE_SIZE = 20; // matches frontend's Math.ceil(total / 20) in JobBoardPage.jsx

// Top of the frontend's salary slider (₹10,00,000/year). At the maximum the
// student is saying "any salary", so we drop the filter entirely instead of
// applying `<= 10 lakh` and quietly hiding the best-paying listings.
const SALARY_SLIDER_MAX = 1000000;

/**
 * SQL that turns job_cache.salary_text into an annual rupee figure.
 *
 * salary_text is free text straight from the source site — '₹15,000/month',
 * '₹8 LPA', 'Stipend: ₹10,000/month', 'Not disclosed'. There is no numeric
 * salary column, and adding one would need a migration plus a scraper change
 * plus a backfill, so we parse at query time instead. The table only ever
 * holds a few thousand live rows (72h TTL), so a per-row parse is nothing.
 *
 * How it reads: take the first number in the string, then decide the period
 * from the words around it. 'LPA'/'per annum' → the number is already in
 * lakhs, so ×100000. 'month'/'stipend' → ×12. Anything else (including 'Not
 * disclosed') yields NULL, and a NULL is excluded whenever the filter is on —
 * a student who asks for "up to ₹3 lakh" is asking a question we cannot answer
 * for an undisclosed salary, and showing it anyway would make the filter look
 * broken.
 *
 * The number pattern deliberately refuses a trailing '.' or ',' so that
 * '10,000.' cannot reach ::numeric and throw. Non-capturing groups are
 * required — substring(x from pattern) returns capture group 1 if one exists.
 */
const ANNUAL_SALARY_SQL = `
  CASE
    WHEN salary_text ~* '(lpa|per annum|p\\.a\\.|/ *(yr|year)|annually)'
      THEN NULLIF(replace(substring(salary_text from '[0-9]+(?:,[0-9]+)*(?:\\.[0-9]+)?'), ',', ''), '')::numeric * 100000
    WHEN salary_text ~* '(month|/ *mo|p\\.m\\.|stipend)'
      THEN NULLIF(replace(substring(salary_text from '[0-9]+(?:,[0-9]+)*(?:\\.[0-9]+)?'), ',', ''), '')::numeric * 12
    ELSE NULL
  END`;

const getJobs = async (req, res, next) => {
  try {
    const { state, type, govt } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    // govt comes in as the string 'true'/'false'/'' from the frontend filter
    // pill (see jobBoard.service.js) — normalize to a real boolean or null
    // (null = no filter) rather than comparing strings to a boolean column.
    const govtFilter = govt === 'true' ? true : govt === 'false' ? false : null;

    // Location is a state dropdown now. The regex is built from a fixed
    // server-side table (utils/indianStates.js) — an unknown state name gives
    // null, i.e. no filter, and nothing the client sends is ever interpolated
    // into the SQL string.
    const locationRegex = locationRegexForState(state);

    // salaryMax: annual rupees, "show me jobs paying up to this much".
    const salaryMaxRaw = parseInt(req.query.salaryMax, 10);
    const salaryMax =
      Number.isFinite(salaryMaxRaw) && salaryMaxRaw > 0 && salaryMaxRaw < SALARY_SLIDER_MAX
        ? salaryMaxRaw
        : null;

    // "Best match" sort is entirely client-side (it needs the student's own
    // resume, which never leaves the browser here — see JobBoardPage.jsx's
    // fakeMatchScore TODO) — the server only ever returns newest-first.
    // Window function COUNT(*) OVER() avoids a second round-trip for total.
    const { rows } = await pool.query(
      `SELECT job_id, title, firm, location, job_type, is_government, apply_url, salary_text, fetched_at,
              COUNT(*) OVER() AS total_count
       FROM job_cache
       WHERE expires_at > NOW()
         AND ($1::text IS NULL OR location ~* $1)
         AND ($2::text IS NULL OR job_type = $2)
         AND ($3::boolean IS NULL OR is_government = $3)
         AND ($4::numeric IS NULL OR (${ANNUAL_SALARY_SQL}) <= $4)
       ORDER BY fetched_at DESC
       LIMIT $5 OFFSET $6`,
      [locationRegex, type || null, govtFilter, salaryMax, PAGE_SIZE, offset]
    );

    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const jobs = rows.map(({ total_count, ...job }) => job);

    res.json({ jobs, total });
  } catch (err) { next(err); }
};

// ── GET /stats — total active listings + how many are new since IST midnight
// ───────────────────────────────────────────────────────────────────────────
// "New today" only means anything if it's actually the FIRST time we've seen
// a job, not just any row inserted today — a job scraped again tomorrow that
// dedupes against an existing dedupe_hash (ON CONFLICT DO NOTHING in
// upsertListings, jobScraper.worker.js) never gets a fresh fetched_at, so
// counting by fetched_at here is already de-duplicated for free. India-only
// audience — "today" is defined in IST, not server UTC, so the count doesn't
// flip over at 5:30am IST when the server's UTC day rolls over.
const getJobStats = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE expires_at > NOW()) AS total_active,
         COUNT(*) FILTER (
           WHERE expires_at > NOW()
             AND fetched_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
         ) AS new_today
       FROM job_cache`
    );
    res.json({
      totalActive: parseInt(rows[0].total_active, 10),
      newToday: parseInt(rows[0].new_today, 10),
    });
  } catch (err) { next(err); }
};

// ── POST /:jobId/click — record that a student clicked through to apply ────
// Added 2026-07-28 for the admin panel (_contracts/09-admin-panel.md). The
// founder asked to "verify how many students have clicked on the links to
// apply the job" — nothing recorded this before.
//
// TWO RULES THIS ENDPOINT LIVES BY:
//
// 1. It ALWAYS returns 204, even when the insert fails. Tracking is a
//    nice-to-have; a student reaching a job listing is not. If Postgres is
//    briefly unavailable, or the job_id doesn't parse, the student must still
//    get to the vacancy. The frontend does not await this call and opens the
//    apply URL regardless — so a 500 here would achieve nothing except noise
//    in error_log.
//
// 2. user_id and college_id come from the verified JWT (req.user, set by
//    authMiddleware), NEVER from the request body or a query param. Accepting
//    either from the client would let a student record clicks as somebody
//    else, or against another college.
//
// The title/firm/apply_url are copied from job_cache at click time and stored
// on the click row, because job_cache rows are deleted after 72 hours — see
// migrations/20260728_admin_panel.sql for the full reasoning.
const trackApplyClick = async (req, res) => {
  const { jobId } = req.params;
  const { user_id, college_id } = req.user;

  // Validate the shape before it reaches Postgres: a non-UUID would throw
  // `invalid input syntax for type uuid` and land in error_log for nothing.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(jobId || '')) return res.status(204).end();

  try {
    // One statement, no round trip to read the job first. The SELECT provides
    // the denormalised columns; if the job has already expired out of the
    // cache the sub-select yields NULLs and the click is still recorded — a
    // click on a stale listing is real information, not something to discard.
    await pool.query(
      `INSERT INTO job_clicks (user_id, college_id, job_id, job_title, firm, apply_url)
       SELECT $1, $2, $3::uuid,
              (SELECT title     FROM job_cache WHERE job_id = $3::uuid),
              (SELECT firm      FROM job_cache WHERE job_id = $3::uuid),
              (SELECT apply_url FROM job_cache WHERE job_id = $3::uuid)`,
      [user_id, college_id, jobId]
    );
  } catch (err) {
    // Logged, never surfaced. See rule 1 above.
    console.error('[job_board] apply-click tracking failed (non-fatal):', err.message);
  }

  res.status(204).end();
};

module.exports = { getJobs, getJobStats, trackApplyClick };
