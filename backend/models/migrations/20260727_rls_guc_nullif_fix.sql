-- 20260727_rls_guc_nullif_fix.sql
-- Fixes a real bug in 20260726_rls_policies.sql, found via k6 load testing
-- on 2026-07-27: intermittent `invalid input syntax for type uuid: ""`
-- on POST /api/auth/login under concurrent traffic.
--
-- ROOT CAUSE: Postgres custom (placeholder) GUCs like app.current_college_id
-- do not have a true "never set" state once touched in a session. The FIRST
-- time `SET LOCAL app.current_college_id = '<uuid>'` runs on a pooled
-- connection (inside queryAsCollege's transaction), Postgres creates a
-- placeholder entry for that GUC on that connection. After the transaction
-- ends (commit or rollback), current_setting(..., true) on that SAME
-- connection reverts to '' (empty string) from then on — NOT NULL — because
-- once a placeholder GUC is first initialized, its baseline/reset value is
-- the empty string, not true NULL.
--
-- Our policies checked `current_setting(...) IS NULL OR college_id =
-- current_setting(...)::uuid`. On a connection that has NEVER been touched
-- by queryAsCollege, current_setting is genuinely NULL and the check passes.
-- But once ANY connection in the pool (max: 10) has serviced even one
-- queryAsCollege call, that connection is "poisoned": every later UNSCOPED
-- query on that same connection (e.g. login's first, deliberately unscoped
-- `SELECT ... FROM users WHERE email = $1`) sees current_setting = '',
-- IS NULL is false, and Postgres attempts ''::uuid — boom. This explains why
-- it was intermittent (depends which of the 10 connections gets picked) and
-- why it got worse over server uptime (more connections get "poisoned" as
-- they get reused).
--
-- FIX: treat '' the same as NULL using NULLIF, for every policy on every
-- table this affects (users, feature_usage, documents, sessions,
-- exam_attempts). No application code changes needed — this is a pure DB
-- policy fix.
--
-- Run on STAGING FIRST. Re-run the same 5-path test before production.

BEGIN;

-- ===== users =====
DROP POLICY IF EXISTS college_isolation_select ON users;
CREATE POLICY college_isolation_select ON users
  FOR SELECT
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

DROP POLICY IF EXISTS college_isolation_write ON users;
CREATE POLICY college_isolation_write ON users
  FOR INSERT WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

DROP POLICY IF EXISTS college_isolation_update ON users;
CREATE POLICY college_isolation_update ON users
  FOR UPDATE
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

DROP POLICY IF EXISTS college_isolation_delete ON users;
CREATE POLICY college_isolation_delete ON users
  FOR DELETE
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

-- ===== feature_usage =====
DROP POLICY IF EXISTS college_isolation_all ON feature_usage;
CREATE POLICY college_isolation_all ON feature_usage
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

-- ===== documents =====
DROP POLICY IF EXISTS college_isolation_all ON documents;
CREATE POLICY college_isolation_all ON documents
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

-- ===== sessions =====
DROP POLICY IF EXISTS college_isolation_all ON sessions;
CREATE POLICY college_isolation_all ON sessions
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

-- ===== exam_attempts =====
DROP POLICY IF EXISTS college_isolation_all ON exam_attempts;
CREATE POLICY college_isolation_all ON exam_attempts
  FOR ALL
  USING (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_college_id', true), '') IS NULL
    OR college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid
  );

COMMIT;

-- ===== Manual test after running this (do this on staging) =====
-- 1. psql into the DB as voxera_app (the RESTRICTED role, not voxera_admin —
--    voxera_admin is exempt from RLS via FORCE + being a member of
--    rds_superuser's data-access roles is irrelevant here, but voxera_admin
--    also OWNS these tables so it bypasses RLS regardless of FORCE. Testing
--    as voxera_admin will NOT reproduce the bug either way — you must
--    connect as voxera_app to see real policy behavior).
-- 2. BEGIN;
--    SELECT set_config('app.current_college_id', '<a real college uuid>', true);
--    SELECT * FROM users;   -- should show ONLY that college's students
--    COMMIT;
-- 3. -- Now, on the SAME connection/session (same psql session, do not
--    -- reconnect), run the unscoped query that used to break:
--    SELECT * FROM users;   -- BEFORE this fix: would throw
--    -- invalid input syntax for type uuid: "". AFTER this fix: should
--    -- return ALL colleges' students (unrestricted fallback), same as a
--    -- truly fresh connection would.
-- This step 3 is the actual regression test for the bug found via k6 load
-- testing on 2026-07-27 — a single query on a fresh connection was never
-- enough to reproduce it; it only shows up on a connection that has already
-- had the GUC set at least once before.
