-- 20260728_admin_panel.sql
-- Admin Panel (founder analytics) — see _contracts/09-admin-panel.md
--
-- Adds four tables. Nothing here touches an existing table's structure, and
-- nothing is dropped or renamed, so this migration is safe to run on a live
-- database — but per the project rule it goes to STAGING FIRST regardless.
--
-- WHY THESE TABLES EXIST (the short version):
-- Two of the platform's background jobs physically DELETE history every day:
--   jobScraper.worker.js  -> DELETE FROM job_cache  WHERE expires_at < NOW()  (72h)
--   lawNews.worker.js     -> DELETE FROM news_cache WHERE expires_at < NOW()  (48h)
-- So "how many jobs were there last Tuesday" and "what news ran on the 3rd"
-- are unanswerable from the live tables. daily_stats and daily_news_log are
-- written by a nightly snapshot that runs BEFORE those cleanups (23:50 IST /
-- 18:20 UTC), which is the only reason daily and monthly reporting is
-- possible at all.
--
-- Run on STAGING FIRST. Verify with the queries at the bottom of this file.

BEGIN;

-- ===========================================================================
-- job_clicks — one row per "Apply" click on the Job Board.
-- ===========================================================================
-- This is genuinely new data: nothing in the platform recorded apply clicks
-- before today, so there is no history to backfill.
--
-- job_title / firm / apply_url are DENORMALISED ON PURPOSE. job_cache rows
-- are deleted after 72 hours, so a foreign key to job_cache(job_id) would
-- leave every click older than three days pointing at a row that no longer
-- exists — and ON DELETE CASCADE would silently erase the click history we
-- are building this table to keep. job_id is stored as a plain UUID with NO
-- foreign key constraint for exactly that reason. Copying the title and firm
-- at click time also means a report for last month shows the job as it was
-- described then, not as it might be re-scraped later.
CREATE TABLE IF NOT EXISTS job_clicks (
  click_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  college_id  UUID NOT NULL,          -- project rule: student data carries college_id
  job_id      UUID,                   -- deliberately NO FK — see comment above
  job_title   TEXT,
  firm        TEXT,
  apply_url   TEXT,
  clicked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The nightly snapshot and every report filter on a date range, so clicked_at
-- is the hot column. The (user_id, clicked_at) index answers "which students
-- were active today" without scanning the table.
CREATE INDEX IF NOT EXISTS idx_job_clicks_clicked  ON job_clicks(clicked_at);
CREATE INDEX IF NOT EXISTS idx_job_clicks_college  ON job_clicks(college_id);
CREATE INDEX IF NOT EXISTS idx_job_clicks_user_day ON job_clicks(user_id, clicked_at);

-- RLS: job_clicks holds per-student rows, so it gets the same treatment as
-- users/documents/sessions/exam_attempts/feature_usage.
--
-- NULLIF(..., '') is REQUIRED, not stylistic. See
-- 20260727_rls_guc_nullif_fix.sql: once any pooled connection has run
-- SET LOCAL app.current_college_id even once, current_setting() on that
-- connection returns '' (empty string) forever after instead of NULL, so a
-- plain "IS NULL" check fails and Postgres then tries ''::uuid and throws
-- `invalid input syntax for type uuid: ""`. That bug was found under k6 load
-- on 2026-07-27 and is intermittent by nature — do not "simplify" this away.
ALTER TABLE job_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_clicks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_all ON job_clicks;
CREATE POLICY college_isolation_all ON job_clicks
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

-- ===========================================================================
-- daily_stats — one immutable snapshot per day.
-- ===========================================================================
-- college_id IS NULL means "platform-wide roll-up" — that is the row the
-- admin panel reads. Per-college rows are written alongside it so a
-- per-college report can be added later without a migration or a backfill.
--
-- metrics is JSONB rather than 30 columns because the list of things worth
-- tracking will grow, and every new number would otherwise mean an ALTER
-- TABLE on a production database — which the project rules forbid doing
-- casually. The shape of that JSON is documented in
-- backend/services/adminStats.service.js, which is the only thing that
-- writes it.
--
-- UNIQUE(stat_date, college_id) + the ON CONFLICT upsert in the worker makes
-- a re-run for the same day idempotent: running the snapshot twice (a retried
-- cron, a manual catch-up) overwrites rather than duplicating.
CREATE TABLE IF NOT EXISTS daily_stats (
  stat_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date    DATE NOT NULL,
  college_id   UUID,                          -- NULL = platform-wide
  metrics      JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A partial unique index is needed as well as the plain one: in Postgres,
-- NULLs are never equal to each other, so UNIQUE(stat_date, college_id)
-- alone would happily allow twenty platform-wide rows for the same date.
-- The partial index below is what actually enforces "one platform-wide row
-- per day"; the first index covers the per-college rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_stats_date_college
  ON daily_stats(stat_date, college_id) WHERE college_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_stats_date_platform
  ON daily_stats(stat_date) WHERE college_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(stat_date DESC);

-- ===========================================================================
-- monthly_stats — one archive row per completed month.
-- ===========================================================================
-- stat_month is always the FIRST day of the month (2026-07-01 = July 2026),
-- so it can be a DATE and compared/sorted normally.
--
-- Daily rows are NOT deleted when a month is archived. The founder's database
-- rule is never destroy data, and a monthly total with no daily breakdown
-- behind it cannot be audited if a number ever looks wrong.
CREATE TABLE IF NOT EXISTS monthly_stats (
  stat_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_month   DATE NOT NULL,                 -- always day 1 of the month
  college_id   UUID,                          -- NULL = platform-wide
  metrics      JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_stats_month_college
  ON monthly_stats(stat_month, college_id) WHERE college_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_stats_month_platform
  ON monthly_stats(stat_month) WHERE college_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_monthly_stats_month ON monthly_stats(stat_month DESC);

-- ===========================================================================
-- daily_news_log — headlines preserved before news_cache is emptied.
-- ===========================================================================
-- The founder asked for "what news is there, in one line, every day". That is
-- impossible from news_cache alone, which keeps 48 hours. The nightly
-- snapshot copies the day's headlines here first.
--
-- No college_id: news is shared platform content, exactly like news_cache,
-- job_cache, exam_content and draft_templates. The college_id rule applies to
-- tables containing STUDENT data — this table has none.
--
-- UNIQUE(log_date, source_url) means re-running the snapshot for a day cannot
-- duplicate headlines, and an article that stays in the feed across two days
-- is logged once per day (which is correct — it genuinely was on the feed
-- both days).
CREATE TABLE IF NOT EXISTS daily_news_log (
  log_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_date     DATE NOT NULL,
  title        TEXT NOT NULL,
  source_name  TEXT,
  source_url   TEXT NOT NULL,
  category     TEXT,
  state_tag    TEXT,
  published_at TIMESTAMPTZ,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(log_date, source_url)
);

CREATE INDEX IF NOT EXISTS idx_daily_news_log_date ON daily_news_log(log_date DESC);

-- ===========================================================================
-- Grants — the app connects as the restricted role voxera_app, not the table
-- owner voxera_admin. Without these the new tables are invisible to the API.
-- ===========================================================================
-- Wrapped in a DO block so this migration still runs on a local/dev database
-- where the voxera_app role was never created (the load-test and staging
-- boxes have it; a fresh local one may not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxera_app') THEN
    GRANT SELECT, INSERT, UPDATE ON job_clicks, daily_stats, monthly_stats, daily_news_log TO voxera_app;
    -- No DELETE granted on purpose: nothing in this feature ever deletes a
    -- row, and not granting it means a bug cannot.
  END IF;
END
$$;

COMMIT;

-- ===========================================================================
-- Verify after running (on staging)
-- ===========================================================================
-- 1. Tables exist and are empty:
--      SELECT COUNT(*) FROM job_clicks;
--      SELECT COUNT(*) FROM daily_stats;
--      SELECT COUNT(*) FROM monthly_stats;
--      SELECT COUNT(*) FROM daily_news_log;
--
-- 2. The platform-wide uniqueness actually bites (this is the one that is
--    easy to get wrong, because a plain UNIQUE constraint would NOT catch it):
--      INSERT INTO daily_stats (stat_date, college_id, metrics) VALUES ('2026-01-01', NULL, '{}');
--      INSERT INTO daily_stats (stat_date, college_id, metrics) VALUES ('2026-01-01', NULL, '{}');
--      -- second insert MUST fail with a unique violation
--      DELETE FROM daily_stats WHERE stat_date = '2026-01-01';   -- clean up (owner only)
--
-- 3. RLS on job_clicks, connected as voxera_app (NOT voxera_admin — the owner
--    bypasses RLS, so testing as voxera_admin proves nothing):
--      BEGIN;
--      SELECT set_config('app.current_college_id', '<college A uuid>', true);
--      SELECT * FROM job_clicks;   -- only college A's clicks
--      COMMIT;
--      SELECT * FROM job_clicks;   -- unrestricted fallback, must NOT throw
--                                  -- "invalid input syntax for type uuid" —
--                                  -- that is the 2026-07-27 GUC bug regressing
