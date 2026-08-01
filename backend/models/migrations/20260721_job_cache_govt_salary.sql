-- Migration: add is_government and salary_text to job_cache
-- Needed by the v3 Job Board pipeline (jobScraper.worker.js, jobBoard.controller.js):
--   is_government — powers the "Govt / Private" filter tab and the meta-row badge
--                   on JobBoardPage.jsx (frontend already expects this field —
--                   see SAMPLE_JOBS in JobBoardPage.jsx, built before this backend).
--   salary_text   — powers the "Salary" filter tab and the meta-row salary display.
-- Both nullable: a listing found by a source that can't determine either is still
-- a valid listing, just shown as "Location not listed" / no salary badge.

ALTER TABLE job_cache
  ADD COLUMN is_government BOOLEAN,
  ADD COLUMN salary_text   TEXT;
