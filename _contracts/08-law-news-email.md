# Contract: Law News (v3 — real fetch, daily, in-app feed)
**Status:** In Progress
**Week:** Week 3
**Daily cap:** `NEWS_SUMMARIZE_MAX_PER_DAY` = 30 Gemini calls/day (regardless of how many articles are found)
**Estimated Cost (350 students):** ~30 Gemini calls/day total (platform-wide, NOT per-student) — negligible vs. the ₹20,000/month ceiling

---

## v3 Change — why v2 was replaced
v2 ("AI-only source," weekly digest) had the AI *invent* news items from its own training
knowledge — no real fetch, no real link. That contract's own "Hallucination guard" section
flagged this as a real risk (fabricated cases/amendments, dead or fake links). Founder
explicitly rejected relying on this design further and asked for a real, running feature
instead (2026-07-23 voice instruction — see decisions-log).

v3 fixes this at the architecture level: the AI is **never** the source of a fact — it only
summarizes an article that was already fetched for real.

1. **Fetch (real, broad, no curated whitelist).** `news_queries` (DB table, no deploy needed
   to add/remove coverage) holds search queries (e.g. "Supreme Court of India judgment",
   "Bharatiya Nyaya Sanhita amendment"). Each query is run daily against **Google News RSS
   search** (`news.google.com/rss/search`, no API key) — this aggregates real articles from
   thousands of publishers, satisfying the founder's explicit "not just specific sources,
   everything internet" instruction, while every single result is still a real article with a
   real, working link (never invented).
2. **Dedupe.** Same story surfaced by multiple queries, or already cached from a prior day,
   collapses to one row via `dedupe_hash` (md5 of the article URL) — never double-summarized,
   never shown twice.
3. **Summarize (AI, bounded, fetched-content-only).** Each genuinely-new article is summarized
   by ONE Gemini call: **1,500 tokens in / 220 tokens out** (founder-specified input cap; 220
   out chosen as enough for a 2-3 sentence student-facing summary + category + state tag,
   nothing more — same reasoning as Drafting Lab's per-call caps). The prompt explicitly
   forbids adding any fact beyond the fetched title/snippet. Capped at
   `NEWS_SUMMARIZE_MAX_PER_DAY` (default 30) articles/day total, regardless of how many were
   found — cost is a flat daily ceiling, not a per-student multiplier (no AI cost is incurred
   per page view; students only ever read from `news_cache`).
4. **Serve.** Portal shows short AI summary + category + state tag, newest-first; a
   "Read full article →" link goes to the real `source_url` for the complete piece — exactly
   per founder's instruction ("first summary on the portal or short summary, and for brief a
   link directly go there").
5. **Retention.** `expires_at` defaults to NOW() + 48 hours (founder-selected during
   AskUserQuestion sign-off) — "old one should be kept for one two days, then gone." Cleanup
   only runs on a run that inserted ≥1 new row (P006 pattern from Job Board) — a bad day
   (every query failing, or nothing new) never empties the feed to zero.
6. **State filter — dropdown only, no manual entry (explicit founder instruction).**
   `GET /api/law-news/states` returns "All India" + all 28 states/UTs (`INDIAN_STATES` in
   `lawNewsSummarize.service.js`). AI tags each article with one of these (or "National" if
   not state-specific — Supreme Court, Parliament, etc.), validated server-side against the
   same list so a bad model output can never leak an invalid tag into the filter.
7. **Fault isolation.** One bad query (RSS fetch fails) or one bad article (Gemini call fails)
   never aborts the run — same row-level try/catch pattern as Job Board.

## Explicitly deferred (founder's own words, not built in this pass)
- **Email digest delivery** — "in two or three days" — a separate follow-on for both Law News
  and Job Board. `users.email_digest` (existing column) is already wired read/write via
  `GET/PUT /api/law-news/preference`, ready for that later step; no cron sends anything yet.

## Files
- [x] `backend/models/migrations/20260723_law_news_v3.sql` — `news_queries`, `news_cache`
- [x] `backend/models/schema.sql` — synced with the migration
- [x] `backend/services/lawNewsFetch.service.js` — Google News RSS fetch + parse
- [x] `backend/services/lawNewsSummarize.service.js` — one Gemini call/article, 1500in/220out,
      `INDIAN_STATES` constant
- [x] `backend/workers/lawNews.worker.js` — daily cron (01:00 UTC / ~6:30am IST), fetch → dedupe
      → summarize (capped) → insert → P006-safe cleanup
- [x] `backend/controllers/lawNews.controller.js` — `getFeed`, `getStates`, `getPreference`,
      `updatePreference`
- [x] `backend/routes/lawNews.routes.js` — `GET /feed`, `GET /states`, `GET/PUT /preference`
- [x] `frontend/src/services/lawNews.service.js`
- [x] `frontend/src/pages/LawNewsPage.jsx` — state dropdown, newest-first cards, email-digest
      toggle (UI only, matches Job Board's visual theme)
- [x] `backend/app.js` — dashboard entry now `path: '/law-news'`, `comingSoon` removed
- [x] `frontend/src/App.jsx`, `frontend/src/pages/DashboardPage.jsx` — route + nav wired

## Non-negotiables
- No college_id column needed — news is platform-wide, shared across all colleges (same as
  `job_cache`), not per-student data.
- `NEWS_SUMMARIZE_MAX_PER_DAY` must be set in staging/production `.env` (defaults to 30 if
  unset — safe default, but should be explicit).
- `GEMINI_API_KEY` / `GEMINI_MODEL` — same shared env vars as every other AI feature.

## Pre-Deploy Checklist (5-Path Test)
- [x] **Normal** — verified locally: mock RSS (8 queries → 9 unique real-shaped articles,
      1 deliberately duplicated across queries) → mock Gemini → `news_cache` populated
      correctly, dedupe collapsed the shared article to one row.
- [x] **Stupid** — re-ran the same fetch a second time: 0 new Gemini calls spent (all 9
      already cached), 0 rows deleted (P006 — cleanup skipped since 0 inserted).
- [ ] **Access** — N/A (no per-college or per-student data on this feature; nothing to leak
      between colleges). Confirm on staging that `/feed` requires auth (no anonymous access).
- [x] **Limit** — real staging run (2026-07-23) found 158 genuinely-new articles in one go
      (first-ever run, so nothing was cached yet) and correctly stopped inserting after the
      30/day cap — but only 17 of the first 30 attempts actually succeeded, because 141 calls
      hit Gemini's real per-minute rate limit (429) when fired with zero pacing between calls.
      **Fixed same day** — see "429 rate-limit bug" decisions-log entry below. Re-verify on
      staging that a large first run now gets all 30 through cleanly.
- [ ] **Cost** — check Gemini dashboard after the first few real staging runs; expect ~30
      calls/day flat, not per-student.
- [x] Local verification: migration applied to a disposable local Postgres, worker's
      `runFetchAndSummarize()` run twice against local mock RSS/Gemini servers (env-overridable
      via `NEWS_RSS_BASE` / `GEMINI_API_BASE`, same pattern as Drafting Lab), controller routes
      (`/feed`, `/states`, `/preference` get+put) tested via an Express harness with patched
      auth — all passed. Test-only files deleted before commit, verified via
      `git status --porcelain`.
- [ ] Real staging 2-college / real-network test still pending (this sandbox cannot reach
      Google News RSS or Gemini's real endpoint — same sandbox network constraint as prior
      features; verified locally with mocks instead, per established methodology).

## Deployment steps (staging, once pushed)
```
git pull
set -a; source .env; set +a
psql "$DATABASE_URL" -f backend/models/migrations/20260723_law_news_v3.sql
pm2 start backend/workers/lawNews.worker.js --name law-news-worker
pm2 save
pm2 restart voxera-backend
```
Add `NEWS_SUMMARIZE_MAX_PER_DAY=30` and `NEWS_SUMMARIZE_PACE_MS=1200` to staging's real `.env`
if not already present.
