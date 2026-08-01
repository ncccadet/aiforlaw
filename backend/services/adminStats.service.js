/**
 * adminStats.service.js — every number the admin panel shows, in one place.
 *
 * See _contracts/09-admin-panel.md. Two things in here are worth understanding
 * before changing anything:
 *
 * 1. DAYS ARE IST DAYS, NOT UTC DAYS.
 *    Every student is in India. A "day" that rolls over at 05:30 IST would put
 *    a student's late-evening session into tomorrow's report and make the
 *    numbers unexplainable. Every query below bounds on
 *      [ date 00:00 IST , date+1 00:00 IST )
 *    expressed as `($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`, which
 *    Postgres converts to the correct absolute instant. The same convention is
 *    already used by jobBoard.controller.js's /stats endpoint.
 *
 * 2. feature_usage IS A DEAD TABLE — DO NOT READ IT.
 *    It exists in schema.sql and has RLS policies, but no code in the repo has
 *    ever written a row to it (verified 2026-07-27: every reference is a
 *    comment). Per-feature usage is therefore derived from the tables that
 *    features actually write: ai_usage_log, sessions, documents,
 *    exam_attempts, job_clicks, job_cache and news_cache. A query that reads
 *    feature_usage will return zero and look like a bug in the panel.
 */
const { pool } = require('../config/db');

// ── Cost constants ─────────────────────────────────────────────────────────
// Gemini pricing for the model in GEMINI_MODEL (gemini-3.1-flash-lite).
// Kept as one block so a price change is a one-line edit rather than a hunt
// through queries. Prices are per 1,000,000 tokens, in USD.
const USD_PER_M_INPUT  = 0.25;
const USD_PER_M_OUTPUT = 1.50;
// Not fetched live on purpose — a report must produce the same number every
// time it is generated. Override via env if the rate moves materially.
const USD_INR_RATE = parseFloat(process.env.USD_INR_RATE || '84');

/** Rupee cost of a token count. Rounded to 2dp only at the very end. */
function costInr(tokensIn, tokensOut) {
  const usd =
    (Number(tokensIn || 0) / 1_000_000) * USD_PER_M_INPUT +
    (Number(tokensOut || 0) / 1_000_000) * USD_PER_M_OUTPUT;
  return Math.round(usd * USD_INR_RATE * 100) / 100;
}

// Display names for the eight features, so the panel and the PDF never show a
// raw snake_case key to the founder.
const FEATURE_LABELS = {
  exam_prep:        'Exam Prep',
  resume_analyzer:  'Resume Analyzer',
  job_board:        'Job Board',
  drafting_lab:     'Drafting Lab',
  court_simulation: 'Court Simulation',
  ai_interviewer:   'AI Interviewer',
  resume_builder:   'Resume Builder',
  law_news:         'Law News',
};
const labelFor = (key) => FEATURE_LABELS[key] || key;

// IST day bounds as SQL fragments. $n is a DATE parameter.
const IST_START = (n) => `($${n}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
const IST_END   = (n) => `(($${n}::date + 1))::timestamp AT TIME ZONE 'Asia/Kolkata'`;

const int = (v) => parseInt(v, 10) || 0;

/**
 * Build the full metrics object for one IST date by aggregating the live
 * tables. This is what the nightly worker stores, and what the overview
 * endpoint calls directly when the requested date is today.
 *
 * @param {string} date - 'YYYY-MM-DD', interpreted as an IST calendar date.
 * @returns {Promise<object>} the metrics shape stored in daily_stats.metrics
 */
async function buildDailyMetrics(date) {
  const d = [date];

  // Run every aggregate concurrently. These are eight independent read-only
  // queries against indexed columns; serialising them would make the nightly
  // run and the live overview needlessly slow for no benefit.
  const [
    tokensRes,
    featureRes,
    jobsRes,
    clicksRes,
    topClickedRes,
    newsRes,
    headlinesRes,
    studentsRes,
    activeRes,
    errorsRes,
  ] = await Promise.all([
    // ── Tokens per feature ────────────────────────────────────────────────
    pool.query(
      // SUM(calls), not COUNT(*). One row is not one Gemini call: Exam Prep
      // writes ONE row for a 9-batch AIBE generation and ONE for an 8-question
      // SPPU grading. COUNT(*) reported 11 real calls as 3 on staging
      // (2026-07-28). The `calls` column defaults to 1, so every other feature
      // — all of which log one row per call — is unaffected.
      `SELECT feature_name,
              COALESCE(SUM(calls),0)      AS calls,
              COALESCE(SUM(tokens_in),0)  AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out
       FROM ai_usage_log
       WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
       GROUP BY feature_name
       ORDER BY 4 DESC`,
      d
    ),

    // ── Feature usage counts ──────────────────────────────────────────────
    // One query with UNION ALL rather than five round trips. Each branch
    // counts the artefact that feature actually produces:
    //   exam_prep        -> an attempt row
    //   sessions-based   -> a session row (drafting_lab / court_simulation /
    //                       ai_interviewer)
    //   documents-based  -> a document row (resume_builder / resume_analyzer)
    // job_board and law_news have no per-student artefact of their own; they
    // are filled in from the jobs/news blocks below so the founder still sees
    // all eight features in one list rather than six.
    pool.query(
      `SELECT 'exam_prep' AS feature_name, COUNT(*) AS count
         FROM exam_attempts
        WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
       UNION ALL
       SELECT feature_name, COUNT(*)
         FROM sessions
        WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
        GROUP BY feature_name
       UNION ALL
       SELECT feature_name, COUNT(*)
         FROM documents
        WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
        GROUP BY feature_name`,
      d
    ),

    // ── Jobs: new today + how many are live right now ─────────────────────
    // total_active is a point-in-time reading, not a daily total — it means
    // "listings live at the moment this snapshot ran". Worth keeping because
    // job_cache is emptied of expired rows every two days, so it cannot be
    // reconstructed afterwards.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE fetched_at >= ${IST_START(1)} AND fetched_at < ${IST_END(1)}) AS new_today,
         COUNT(*) FILTER (WHERE expires_at > NOW()) AS total_active
       FROM job_cache`,
      d
    ),

    // ── Apply clicks ──────────────────────────────────────────────────────
    pool.query(
      `SELECT COUNT(*) AS clicks, COUNT(DISTINCT user_id) AS unique_clickers
       FROM job_clicks
       WHERE clicked_at >= ${IST_START(1)} AND clicked_at < ${IST_END(1)}`,
      d
    ),

    pool.query(
      `SELECT COALESCE(job_title, '(untitled)') AS title,
              COALESCE(firm, '') AS firm,
              COUNT(*) AS clicks
       FROM job_clicks
       WHERE clicked_at >= ${IST_START(1)} AND clicked_at < ${IST_END(1)}
       GROUP BY 1, 2
       ORDER BY clicks DESC, title ASC
       LIMIT 10`,
      d
    ),

    // ── News counts ───────────────────────────────────────────────────────
    pool.query(
      `SELECT COUNT(*) AS new_today
       FROM news_cache
       WHERE fetched_at >= ${IST_START(1)} AND fetched_at < ${IST_END(1)}`,
      d
    ),

    // ── News headlines, one line each ─────────────────────────────────────
    // Reads daily_news_log FIRST (the preserved copy) and falls back to
    // news_cache only when nothing has been logged yet for that date — which
    // is the case for today, before tonight's snapshot runs. Without the
    // fallback, today's panel would show an empty news section all day.
    pool.query(
      `SELECT title, source_name, source_url, category, state_tag
         FROM daily_news_log
        WHERE log_date = $1::date
        ORDER BY title
        LIMIT 100`,
      d
    ),

    // ── Students: total on the platform + signed up today ─────────────────
    // role <> 'admin' everywhere: the founder's own account lives in the
    // "Voxera Internal" college and must never inflate a student count.
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE role <> 'admin') AS total,
         COUNT(*) FILTER (WHERE role <> 'admin'
                            AND created_at >= ${IST_START(1)}
                            AND created_at <  ${IST_END(1)}) AS new_today
       FROM users`,
      d
    ),

    // ── Active students ───────────────────────────────────────────────────
    // "Active" = did something that left a row anywhere today. UNION (not
    // UNION ALL) de-duplicates user_ids across the five sources, so a student
    // who used three features counts once.
    pool.query(
      `SELECT COUNT(*) AS active FROM (
         SELECT user_id FROM ai_usage_log
           WHERE user_id IS NOT NULL
             AND created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
         UNION
         SELECT user_id FROM sessions
           WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
         UNION
         SELECT user_id FROM documents
           WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
         UNION
         SELECT user_id FROM exam_attempts
           WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
         UNION
         SELECT user_id FROM job_clicks
           WHERE clicked_at >= ${IST_START(1)} AND clicked_at < ${IST_END(1)}
       ) AS active_users`,
      d
    ),

    // ── Errors ────────────────────────────────────────────────────────────
    pool.query(
      `SELECT COALESCE(endpoint, '(unknown)') AS endpoint, COUNT(*) AS count
       FROM error_log
       WHERE created_at >= ${IST_START(1)} AND created_at < ${IST_END(1)}
       GROUP BY 1
       ORDER BY count DESC
       LIMIT 20`,
      d
    ),
  ]);

  // ── Tokens ────────────────────────────────────────────────────────────────
  const byFeature = tokensRes.rows.map((r) => ({
    feature:   r.feature_name,
    label:     labelFor(r.feature_name),
    calls:     int(r.calls),
    tokensIn:  int(r.tokens_in),
    tokensOut: int(r.tokens_out),
    costInr:   costInr(r.tokens_in, r.tokens_out),
  }));
  const totalIn  = byFeature.reduce((s, f) => s + f.tokensIn, 0);
  const totalOut = byFeature.reduce((s, f) => s + f.tokensOut, 0);
  const calls    = byFeature.reduce((s, f) => s + f.calls, 0);

  // ── Jobs / news / clicks ──────────────────────────────────────────────────
  const jobsRow   = jobsRes.rows[0]    || {};
  const clicksRow = clicksRes.rows[0]  || {};
  const newsRow   = newsRes.rows[0]    || {};

  let headlines = headlinesRes.rows.map((r) => ({
    title:      r.title,
    sourceName: r.source_name,
    sourceUrl:  r.source_url,
    category:   r.category,
    stateTag:   r.state_tag,
  }));
  if (headlines.length === 0) {
    // Fallback for "today", before tonight's snapshot has logged anything.
    const live = await pool.query(
      `SELECT title, source_name, source_url, category, state_tag
         FROM news_cache
        WHERE fetched_at >= ${IST_START(1)} AND fetched_at < ${IST_END(1)}
        ORDER BY published_at DESC NULLS LAST
        LIMIT 100`,
      d
    );
    headlines = live.rows.map((r) => ({
      title:      r.title,
      sourceName: r.source_name,
      sourceUrl:  r.source_url,
      category:   r.category,
      stateTag:   r.state_tag,
    }));
  }

  // ── Feature counts, all eight, in the dashboard's own order ───────────────
  const counts = {};
  for (const r of featureRes.rows) counts[r.feature_name] = int(r.count);
  counts.job_board = int(clicksRow.clicks);            // clicks are the Job Board's usage signal
  counts.law_news  = int(newsRow.new_today);

  const features = Object.keys(FEATURE_LABELS).map((key) => ({
    feature: key,
    label:   labelFor(key),
    count:   counts[key] || 0,
  }));

  return {
    date,
    generatedAt: new Date().toISOString(),
    tokens: {
      totalIn,
      totalOut,
      calls,
      costInr: costInr(totalIn, totalOut),
      byFeature,
    },
    features,
    jobs: {
      newToday:       int(jobsRow.new_today),
      totalActive:    int(jobsRow.total_active),
      applyClicks:    int(clicksRow.clicks),
      uniqueClickers: int(clicksRow.unique_clickers),
      topClicked:     topClickedRes.rows.map((r) => ({
        title: r.title, firm: r.firm, clicks: int(r.clicks),
      })),
    },
    news: {
      newToday: int(newsRow.new_today),
      headlines,
    },
    students: {
      total:       int(studentsRes.rows[0]?.total),
      newToday:    int(studentsRes.rows[0]?.new_today),
      activeToday: int(activeRes.rows[0]?.active),
    },
    errors: {
      total:      errorsRes.rows.reduce((s, r) => s + int(r.count), 0),
      byEndpoint: errorsRes.rows.map((r) => ({ endpoint: r.endpoint, count: int(r.count) })),
    },
  };
}

/**
 * Read a stored snapshot. Returns null when none exists — which is the honest
 * answer for any date before this panel shipped, and the reason the API
 * returns 404 rather than a page of zeros that looks like a quiet day.
 */
async function getStoredDaily(date) {
  const { rows } = await pool.query(
    `SELECT metrics, generated_at FROM daily_stats
      WHERE stat_date = $1::date AND college_id IS NULL`,
    [date]
  );
  if (rows.length === 0) return null;
  return { ...rows[0].metrics, storedAt: rows[0].generated_at };
}

/**
 * Aggregate a month from its daily snapshots.
 *
 * Deliberately built from daily_stats rather than from the raw tables: the raw
 * tables no longer contain the month (job_cache is 72h, news_cache is 48h), so
 * re-aggregating from source would silently under-report. The daily snapshots
 * ARE the record.
 *
 * @param {string} month - 'YYYY-MM'
 */
async function buildMonthlyMetrics(month) {
  const firstDay = `${month}-01`;
  const { rows } = await pool.query(
    `SELECT stat_date, metrics FROM daily_stats
      WHERE college_id IS NULL
        AND stat_date >= $1::date
        AND stat_date <  ($1::date + INTERVAL '1 month')
      ORDER BY stat_date`,
    [firstDay]
  );
  if (rows.length === 0) return null;

  const days = rows.map((r) => ({ date: r.stat_date, m: r.metrics || {} }));

  // Sum tokens per feature across the month.
  const featureTotals = {};
  let totalIn = 0, totalOut = 0, totalCalls = 0;
  for (const { m } of days) {
    for (const f of m.tokens?.byFeature || []) {
      const t = (featureTotals[f.feature] ||= {
        feature: f.feature, label: f.label || f.feature, calls: 0, tokensIn: 0, tokensOut: 0,
      });
      t.calls     += f.calls     || 0;
      t.tokensIn  += f.tokensIn  || 0;
      t.tokensOut += f.tokensOut || 0;
    }
    totalIn    += m.tokens?.totalIn  || 0;
    totalOut   += m.tokens?.totalOut || 0;
    totalCalls += m.tokens?.calls    || 0;
  }
  const byFeature = Object.values(featureTotals)
    .map((t) => ({ ...t, costInr: costInr(t.tokensIn, t.tokensOut) }))
    .sort((a, b) => b.costInr - a.costInr);

  // Sum feature usage counts.
  const usageTotals = {};
  for (const { m } of days) {
    for (const f of m.features || []) {
      usageTotals[f.feature] = (usageTotals[f.feature] || 0) + (f.count || 0);
    }
  }
  const features = Object.keys(FEATURE_LABELS).map((key) => ({
    feature: key, label: labelFor(key), count: usageTotals[key] || 0,
  }));

  const sum = (path) => days.reduce((s, { m }) => {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), m);
    return s + (Number(v) || 0);
  }, 0);

  // Day-by-day table for the PDF, and the best/worst day lines.
  const daily = days.map(({ date, m }) => ({
    date:           typeof date === 'string' ? date : new Date(date).toISOString().slice(0, 10),
    costInr:        m.tokens?.costInr || 0,
    aiCalls:        m.tokens?.calls || 0,
    activeStudents: m.students?.activeToday || 0,
    applyClicks:    m.jobs?.applyClicks || 0,
  }));
  const busiest = daily.reduce((a, b) => (b.activeStudents > (a?.activeStudents ?? -1) ? b : a), null);
  const costliest = daily.reduce((a, b) => (b.costInr > (a?.costInr ?? -1) ? b : a), null);

  // Month-end student total is the LAST day's total, not a sum — "total
  // students" is a standing figure, not something that accumulates daily.
  const lastDay = days[days.length - 1].m;

  return {
    month,
    generatedAt: new Date().toISOString(),
    daysCovered: days.length,
    tokens: { totalIn, totalOut, calls: totalCalls, costInr: costInr(totalIn, totalOut), byFeature },
    features,
    jobs: {
      newListings:    sum('jobs.newToday'),
      applyClicks:    sum('jobs.applyClicks'),
    },
    news:  { articles: sum('news.newToday') },
    students: {
      total:       lastDay.students?.total || 0,
      newThisMonth: sum('students.newToday'),
      peakActive:  busiest ? busiest.activeStudents : 0,
    },
    errors: { total: sum('errors.total') },
    highlights: { busiestDay: busiest, costliestDay: costliest },
    daily,
  };
}

/** Last N days of headline figures, for the small trend table on the panel. */
async function getTrend(days = 30) {
  const { rows } = await pool.query(
    `SELECT stat_date, metrics FROM daily_stats
      WHERE college_id IS NULL
        AND stat_date > (CURRENT_DATE - $1::int)
      ORDER BY stat_date`,
    [days]
  );
  return rows.map((r) => ({
    date: new Date(r.stat_date).toISOString().slice(0, 10),
    costInr:        r.metrics?.tokens?.costInr || 0,
    aiCalls:        r.metrics?.tokens?.calls || 0,
    activeStudents: r.metrics?.students?.activeToday || 0,
  }));
}

module.exports = {
  buildDailyMetrics,
  buildMonthlyMetrics,
  getStoredDaily,
  getTrend,
  costInr,
  labelFor,
  FEATURE_LABELS,
  USD_PER_M_INPUT,
  USD_PER_M_OUTPUT,
  USD_INR_RATE,
};
