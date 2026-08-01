-- 20260712_v2_feature_revision.sql
-- NOTE: No database is provisioned yet, so schema.sql was edited directly for
-- this revision. This migration exists so the change is on record and so any
-- local DB created from the OLD schema.sql can be brought forward.
-- Once ANY shared environment (staging/production) exists, ALL future changes
-- go through migration files only — never direct schema.sql edits.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS difficulty    TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS filters       JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS questions     JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS resume_doc_id UUID REFERENCES documents(doc_id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active';

ALTER TABLE job_cache ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'provider_api';
ALTER TABLE job_cache ADD COLUMN IF NOT EXISTS source_url  TEXT;
ALTER TABLE job_cache ADD COLUMN IF NOT EXISTS dedupe_hash TEXT UNIQUE;
ALTER TABLE job_cache ALTER COLUMN source_api DROP NOT NULL;
ALTER TABLE job_cache ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '72 hours';

ALTER TABLE exam_content ADD COLUMN IF NOT EXISTS question_format TEXT NOT NULL DEFAULT 'mcq';
ALTER TABLE exam_content ADD COLUMN IF NOT EXISTS model_answer    TEXT;
ALTER TABLE exam_content ADD COLUMN IF NOT EXISTS content_source  TEXT NOT NULL DEFAULT 'pyq';
ALTER TABLE exam_content ALTER COLUMN options_json   DROP NOT NULL;
ALTER TABLE exam_content ALTER COLUMN correct_answer DROP NOT NULL;
ALTER TABLE exam_content ALTER COLUMN explanation    DROP NOT NULL;

-- New tables: job_sources, exam_attempts, draft_templates, prompt_versions, ai_usage_log
-- (definitions identical to schema.sql v2 — copy from there when running on an old DB)
