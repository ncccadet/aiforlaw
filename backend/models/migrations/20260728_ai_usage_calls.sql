-- 20260728_ai_usage_calls.sql
-- Fix: the admin panel's "CALLS" column was counting ROWS in ai_usage_log, not
-- Gemini API calls.
--
-- Most features write one row per generateText() call, so row count == call
-- count and the panel was right by accident. Exam Prep is not like that: AIBE
-- generation makes 9 batched calls and SPPU submit makes up to 8 grading calls,
-- and each writes ONE row with the tokens summed. Measured on staging
-- 2026-07-28: 11 real calls were reported as 3.
--
-- That understates AIBE by 9:1 on the one screen a founder uses to watch spend.
-- Tokens and rupees were always correct — only the call count was wrong.
--
-- Two columns:
--   calls          how many Gemini calls this row represents. DEFAULT 1 so every
--                  existing row and every 1-call-per-row writer elsewhere in the
--                  codebase stays correct with no code change.
--   finish_reason  the finishReason of the last call in the row. Without it a
--                  truncated response (MAX_TOKENS) is invisible after the fact,
--                  so there is no way to answer "did we hit the output cap?"
--                  from data — which is exactly the question that came up on
--                  2026-07-28. NULL for historical rows.
--
-- Idempotent; safe to re-run. Staging first, verify, then production.
--
-- RUN THIS AS voxera_admin, NOT voxera_app. voxera_app cannot ALTER a table it
-- does not own. The DATABASE_URL in backend/.env is the voxera_app one, so it
-- is the WRONG url for this file.

BEGIN;

ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS calls INT NOT NULL DEFAULT 1;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS finish_reason TEXT;

-- No new grant needed: voxera_app already holds INSERT/SELECT on ai_usage_log
-- and in PostgreSQL a column added to an existing table inherits the table's
-- privileges. Stated explicitly because the exam_papers migration earlier the
-- same day DID need a grant, and the difference is CREATE TABLE vs ALTER TABLE.

COMMIT;

-- ===========================================================================
-- Verify after running
-- ===========================================================================
--   \d ai_usage_log
--     -> calls          | integer | not null default 1
--     -> finish_reason  | text    |
--
--   SELECT COUNT(*) FROM ai_usage_log WHERE calls IS NULL;   -- must be 0
--
-- Then as voxera_app (the role the API uses), prove it can still write:
--   SELECT id, calls, finish_reason FROM ai_usage_log ORDER BY id DESC LIMIT 5;
--
-- After the next AIBE paper is generated, the newest exam_prep row should show
-- calls = 9 (not 1) and finish_reason = 'STOP' (not 'MAX_TOKENS').
