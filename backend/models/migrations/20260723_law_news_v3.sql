-- Law News v3 (_contracts/08-law-news-email.md) — real, fetched articles
-- instead of the v2 "AI invents the news" design. Same shape as Job Board's
-- job_sources/job_cache pair, since the risk (fabricated content/links) and
-- the fix (fetch real content first, only summarize what was actually
-- fetched) are identical.
--
-- news_queries — DB-driven search queries fed to Google News RSS search
-- (news.google.com/rss/search, no API key required, aggregates real
-- articles from thousands of publishers — this is what makes coverage
-- "the whole internet" rather than a small hand-picked site list, while
-- every article is still a real, real-linked, real-published piece).
-- Founders can add/remove queries without a deploy, same reasoning as
-- job_sources being DB-driven.
CREATE TABLE IF NOT EXISTS news_queries (
  query_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text  TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed queries — a starting set covering case law, legislative amendments,
-- and student-relevant legal-career news. Add more any time via INSERT, no
-- deploy needed.
INSERT INTO news_queries (query_text) VALUES
  ('Supreme Court of India judgment'),
  ('High Court India ruling'),
  ('Bharatiya Nyaya Sanhita amendment'),
  ('Bharatiya Nagarik Suraksha Sanhita'),
  ('new law India Parliament bill'),
  ('Bar Council of India'),
  ('law student India internship'),
  ('legal news India today')
ON CONFLICT (query_text) DO NOTHING;

-- news_cache — the actual fetched + AI-summarized articles served to
-- students. No college_id: news is shared platform-wide, same as job_cache.
-- expires_at default 48h (P006 insert-before-delete pattern from Job Board
-- applies here too — see lawNews.worker.js).
CREATE TABLE IF NOT EXISTS news_cache (
  news_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name  TEXT,               -- publisher name, from the RSS <source> tag
  source_url   TEXT NOT NULL,      -- the REAL article link — never invented
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,      -- AI-written short summary of the fetched snippet
  category     TEXT,               -- case | amendment | other (informational only)
  state_tag    TEXT,               -- an Indian state name, or 'National'
  dedupe_hash  TEXT UNIQUE,        -- md5(source_url) — same story from multiple queries collapses to one row
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours'
);
CREATE INDEX IF NOT EXISTS idx_news_expires ON news_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_news_state   ON news_cache(state_tag);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_cache(published_at DESC);
