-- 20260728_exam_prep_v3.sql
-- Feature: Exam Prep v3 (contract _contracts/01-exam-prep.md)
--
-- Two things:
--   1. exam_papers — the Library catalogue of past question papers. The PDFs
--      themselves live in S3; this table is only the index students browse.
--      Shared platform content, so deliberately NO college_id: a 2024 SPPU
--      Law of Contract paper is the same document for every college. Same
--      reasoning as exam_content. Because there is no college_id there is also
--      no RLS policy on it, and it is read with plain pool.query.
--   2. An index on exam_attempts for the "resume my in-progress paper" lookup
--      (GET /api/exam/active), which filters by user and orders by created_at.
--      exam_attempts DOES have college_id and IS RLS-protected — every query
--      against it goes through queryAsCollege().
--
-- Idempotent; safe to re-run. Run on staging first, verify, then production.
--
-- RUN THIS AS voxera_admin, NOT voxera_app. voxera_app is the restricted role
-- the API connects as and it has no CREATE on schema public — running the
-- migration as voxera_app fails with "permission denied for schema public"
-- and rolls the whole thing back. The DATABASE_URL in backend/.env is the
-- voxera_app one, so it is the WRONG url for this file.

BEGIN;

CREATE TABLE IF NOT EXISTS exam_papers (
  paper_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program     TEXT NOT NULL,                 -- llb_3yr | ballb_5yr
  year        INT  NOT NULL,                 -- 1..3 (LLB) / 1..5 (BA LLB)
  semester    INT  NOT NULL,                 -- 1..6 / 1..10
  subject     TEXT NOT NULL,                 -- must match a subject in the program tree
  exam_year   INT,                           -- the calendar year the paper is FROM (e.g. 2024)
  title       TEXT NOT NULL,                 -- display title, e.g. "Law of Contract I — Nov 2024"
  s3_key      TEXT NOT NULL,                 -- PDF location in S3 (founders upload)
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_papers_browse
  ON exam_papers (program, year, semester)
  WHERE is_active;

-- Supports GET /api/exam/active (most recent attempt for one student) and the
-- analytics score-trend query, both of which are user-scoped and time-ordered.
CREATE INDEX IF NOT EXISTS idx_exam_attempts_user_recent
  ON exam_attempts (user_id, created_at DESC);

-- ===========================================================================
-- Grants — the API connects as the restricted role voxera_app, not the table
-- owner voxera_admin. Without this, exam_papers exists but is invisible to the
-- app and every Library request 500s. Same pattern as 20260728_admin_panel.sql.
-- ===========================================================================
-- SELECT only. Nothing in the Library feature writes to exam_papers — the
-- catalogue is populated by founders, not by student traffic — so not granting
-- INSERT/UPDATE/DELETE means a bug in a student-facing route cannot corrupt it.
--
-- DO block so this still runs on a local/dev database where voxera_app was
-- never created.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxera_app') THEN
    GRANT SELECT ON exam_papers TO voxera_app;
  END IF;
END
$$;

COMMIT;

-- ===========================================================================
-- Verify after running (as voxera_admin)
-- ===========================================================================
--   \d exam_papers                       -- table + idx_papers_browse present
--   \d exam_attempts                     -- idx_exam_attempts_user_recent present
--   SELECT COUNT(*) FROM exam_papers;    -- 0, the catalogue starts empty
--
-- Then, as voxera_app (the role the API actually uses), prove the grant works:
--   SELECT COUNT(*) FROM exam_papers;    -- must return 0, NOT "permission denied"
