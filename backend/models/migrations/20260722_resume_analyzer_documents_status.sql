-- Adds `status` to `documents`, required for Resume Analyzer's pending/complete/
-- failed polling flow (see _contracts/02-resume-analyzer.md). The controller
-- inserts a 'pending' row the instant a file is queued so the frontend has a
-- doc_id to poll immediately; the worker updates the same row to 'complete' or
-- 'failed' once it's done.
--
-- Every other feature that uses `documents` (resume_builder, resume_builder_draft,
-- job_board, etc.) never had a pending/failed state — it inserts once, already
-- finished. The DEFAULT 'complete' makes this column a no-op for all of them.
--
-- Run on staging first, verify with `\d documents` that the column exists and
-- existing rows show status='complete', then production (never a manual
-- ALTER TABLE in production — see project's Database Rules).

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete';

-- Partial index: the only status value anyone ever queries by is 'pending'
-- (nothing currently does this on a hot path, but a future admin/ops query
-- like "how many analyses are stuck pending" benefits from not scanning the
-- whole table).
CREATE INDEX IF NOT EXISTS idx_docs_status_pending ON documents(status) WHERE status = 'pending';
