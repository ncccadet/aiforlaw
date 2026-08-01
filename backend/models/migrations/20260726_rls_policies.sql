-- 20260726_rls_policies.sql
-- Adds the actual Row Level Security POLICIES for the 5 tables that schema.sql
-- already turned RLS "on" for (users, feature_usage, documents, sessions,
-- exam_attempts). Enabling RLS with zero policies does NOT protect anything
-- by itself — Postgres also lets the table OWNER bypass RLS entirely unless
-- the table is explicitly told to FORCE it. Since the app's only DB user
-- (voxera_admin) is the same user that created these tables, it is the owner,
-- so up to now this second layer has been a no-op. This migration is what
-- actually turns it on.
--
-- HOW THIS WORKS (read this before running it):
--   Every policy checks a per-connection setting called app.current_college_id.
--     - If a real student/admin request sets this (e.g. "SET LOCAL
--       app.current_college_id = '<college uuid>'" at the start of a request,
--       using the college_id from the student's own JWT), Postgres will only
--       let that connection see/insert/update rows matching that college_id
--       — even if the application code forgot its own WHERE college_id = ...
--       clause. THIS is the real second layer of protection.
--     - If nothing sets it (an admin script, a migration, a background
--       worker connecting the normal way), the policy falls back to
--       unrestricted — because current_setting(..., true) returns NULL and
--       the OR clause passes. This keeps bulkImportStudents.js, this
--       migration file itself, and existing workers running without changes.
--
-- IMPORTANT — this migration alone does not "turn on" real enforcement for
-- students. The app must be updated to actually SET app.current_college_id
-- per request (from req.user.college_id, set by auth.middleware.js) for this
-- to do anything beyond a no-op fallback. See backend/config/db.js
-- (queryAsCollege helper) added alongside this migration, and the note at
-- the bottom of this file for what still needs wiring into each controller.
--
-- Run on STAGING FIRST. Test with two fake colleges before production.

BEGIN;

-- ===== users =====
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_select ON users;
CREATE POLICY college_isolation_select ON users
  FOR SELECT
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

DROP POLICY IF EXISTS college_isolation_write ON users;
CREATE POLICY college_isolation_write ON users
  FOR INSERT WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

DROP POLICY IF EXISTS college_isolation_update ON users;
CREATE POLICY college_isolation_update ON users
  FOR UPDATE
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

DROP POLICY IF EXISTS college_isolation_delete ON users;
CREATE POLICY college_isolation_delete ON users
  FOR DELETE
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

-- ===== feature_usage =====
ALTER TABLE feature_usage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_all ON feature_usage;
CREATE POLICY college_isolation_all ON feature_usage
  FOR ALL
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

-- ===== documents =====
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_all ON documents;
CREATE POLICY college_isolation_all ON documents
  FOR ALL
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

-- ===== sessions =====
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_all ON sessions;
CREATE POLICY college_isolation_all ON sessions
  FOR ALL
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

-- ===== exam_attempts =====
ALTER TABLE exam_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS college_isolation_all ON exam_attempts;
CREATE POLICY college_isolation_all ON exam_attempts
  FOR ALL
  USING (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_college_id', true) IS NULL
    OR college_id = current_setting('app.current_college_id', true)::uuid
  );

COMMIT;

-- ===== Manual test after running this (do this on staging) =====
-- 1. psql into the DB.
-- 2. SET app.current_college_id = '<college A uuid>';
--    SELECT * FROM users;   -- should show ONLY college A's students
-- 3. SET app.current_college_id = '<college B uuid>';
--    SELECT * FROM users;   -- should show ONLY college B's students
-- 4. RESET app.current_college_id;
--    SELECT * FROM users;   -- unrestricted (admin/no-context fallback) — expected
--
-- ===== Still needed for this to protect real student traffic =====
-- Nothing above changes app behavior yet by itself, because the Express app
-- currently never sets app.current_college_id. backend/config/db.js (new
-- file, added alongside this migration) exports queryAsCollege(collegeId,
-- sql, params) — a drop-in helper that opens one connection, does
-- SET LOCAL app.current_college_id, runs the query, and commits/releases.
-- Each controller's own `pool.query(...)` calls need to be switched to use
-- this helper (passing req.user.college_id from auth.middleware.js) for the
-- policies above to actually matter for live traffic. That controller-by-
-- controller change is the next step — ask before it's done everywhere at
-- once, since it touches every feature's controller file.
