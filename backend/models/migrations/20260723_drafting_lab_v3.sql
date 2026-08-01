-- Drafting Lab v3 (_contracts/04-drafting-lab.md) — Step 2/3 storage.
-- Reuses the `sessions` table (same table Court Simulation / AI Interviewer
-- already use for AI-generated exercise state) rather than `documents`,
-- because `documents.s3_key` is NOT NULL — it's built for "a file lives on
-- S3", and a drafting exercise has no per-user file, just JSON state. Two
-- narrowly-named columns added instead of overloading the generic
-- `questions`/`turns` columns AI Interviewer uses, since "case_data" /
-- "submission" read far more clearly for this feature than repurposed names.
--
-- case_data  — { template_type, case: { title, facts } } — written once by
--              the worker's 'generate-case' job (Call 1).
-- submission — { fields: {field_id: text}, assembledDraft } — written once
--              by the controller at POST /case-study/submit, before the
--              worker's 'score-draft' job (Call 2) runs. The score result
--              itself reuses the existing `summary` TEXT column (same as
--              AI Interviewer) — no new column needed for that.
--
-- Run on staging first, verify with `\d sessions`, then production.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS case_data  JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS submission JSONB;
