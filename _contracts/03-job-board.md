# Contract: Job Board (v2 — three-source pipeline)
**Status:** In Progress (Sources 1 + 3 built and locally verified; Source 2 — SerpApi built and locally verified with a mocked response, Apify plumbing built but gated on an actor ID, Adzuna not wired up — pending its second credential; nothing yet run on real staging internet)
**Week:** Week 3
**Daily Limit:** None for students (they only read job_cache). Scrape-time LLM extraction hard-capped at LLM_EXTRACT_MAX_PER_RUN (env var, default 50).
**Estimated Cost (350 students):** Student-facing cost is $0 (job_cache reads only). Scrape-time LLM (Source 3) at the gemini-3.1-flash-lite standard rate ($0.25/1M input, $1.50/1M output tokens): ~8K chars (~2K tokens) in + up to 1000 tokens out per call, 50 calls/run cap = ~100K in + 50K out tokens/run ≈ $0.10/run. At the 2-day cadence (~15 runs/month) ≈ **$1.50/month** for LLM extraction — negligible, but currently $0 sources are flagged `scrape_method='llm_extract'` so this stage is idle until a founder flags specific hard-to-parse sources for it. Source 2 (Apify) cost RECALCULATE once actor pricing + token are available.

---

## v4 — Source 2 wired up (2026-07-22)
- **SerpApi (Google Jobs engine) — READY.** `backend/services/providerApi.service.js`'s `fetchFromSerpApi()` runs a small fixed set of 6 legal job/internship search queries (SerpApi bills per search — deliberately not an open-ended sweep) and maps `jobs_results` into the standard listing shape. Gated on `SERPAPI_KEY` — clean skip + log line if unset. Verified locally against a mocked SerpApi response shape (real serpapi.com is unreachable from the build sandbox): correct internship/full-time detection, government-employer detection, salary passthrough, and listings with no apply link correctly dropped.
- **Apify — plumbing only, NOT enabled.** `fetchFromApify()` calls Apify's generic `run-sync-get-dataset-items` endpoint, but different Apify actors take different input JSON and return different field names — there's no safe generic default. Gated on a NEW env var `APIFY_ACTOR_ID` (which actor to run), separate from `APIFY_TOKEN` — until an actor is chosen, this logs "waiting on actor ID" and returns 0 rather than guessing and burning real Apify credits on probably-wrong results. `APIFY_ACTOR_INPUT` (JSON string) is optional, for whatever input shape the chosen actor needs. Once enabled, `mapApifyItem()` logs the first result's raw field names so the best-effort field-name matching (title/positionName/jobTitle, etc.) can be tightened for the actual actor chosen.
- **Adzuna — not wired up.** Adzuna requires TWO credentials (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY`) — only one 32-char key was provided (2026-07-22). Waiting on the founder to confirm/provide the App ID before this gets built.
- **`GET /api/jobs/stats`** (NEW) — `{ totalActive, newToday }`. `newToday` counts by `fetched_at >= IST midnight`, which is already de-duplicated for free: a job re-scraped tomorrow that matches an existing `dedupe_hash` never gets a new `fetched_at` (ON CONFLICT DO NOTHING in `upsertListings`), so it doesn't inflate "new today." Powers a line under the Job Board header in `JobBoardPage.jsx`.
- Included `is_government`/`salary_text` directly in `schema.sql`'s `job_cache` CREATE TABLE (previously only in the migration file) so a fresh DB provision matches what staging actually has.

## v3 — what's actually built (2026-07-21)
- **Source 1 — direct scrape:** implemented (`backend/services/directScrape.service.js`) — generic heuristic scraper (cheerio + keyword-matched anchor tags) against all 785 `job_sources` rows marked `scrape_method='direct'`. No per-site custom parsers (785 different sites); noisy sources will produce noisy candidates — sources that consistently don't work are exactly the ones to flag `llm_extract` for.
- **Source 3 — LLM extraction:** implemented (`backend/services/llmExtract.service.js` + `backend/services/gemini.service.js`), calls Gemini's native REST endpoint (`generativelanguage.googleapis.com/v1beta`) directly — deliberately NOT through any OpenAI-compatible SDK/shim, since that's the actual cause of the "AQ.-prefix key" 401 errors reported around the web, not the key itself. Only runs for sources explicitly flagged `scrape_method='llm_extract'` (currently 0 of 785 — all seeded as `direct`).
- **Source 2 — provider APIs (Apify etc.):** NOT implemented. `runProviderApiStage()` exists as a guarded no-op — skips cleanly and logs when `APIFY_TOKEN` is unset, so it doesn't block Sources 1/3. Waiting on the Apify token/link.
- **`GET /api/jobs`:** real query against `job_cache` (was a stub returning `{jobs:[]}`) — supports `city`, `type`, `govt`, `salary` filters and `page` (20/page), matches what `frontend/src/pages/JobBoardPage.jsx` already sends.
- Added migration `20260721_job_cache_govt_salary.sql` — `job_cache` was missing `is_government`/`salary_text` columns that both the frontend and this pipeline need (reverted along with the rest of an earlier backend attempt; re-added here as a proper migration, not a raw ALTER TABLE).
- Verified locally end-to-end against real Postgres + Redis (not just `node --check`): direct scrape of a mock HTML fixture, LLM extraction against a mock Gemini-shaped server (real generativelanguage.googleapis.com is unreachable from the build sandbox — verified the request/response contract instead), per-source fault isolation (one broken source doesn't kill the run), auto-disable at exactly 5 consecutive failures + `error_log` entry, dedupe (re-running inserts 0 new rows), and the LLM_EXTRACT_MAX_PER_RUN cap stopping the stage early.
- **NOT yet verified:** the real 785 sources against the real internet, and the real Gemini API with the real `AQ.`-prefixed key — neither is reachable from this build environment. First real test of both happens whenever this runs on staging.

## v2 Architecture (unchanged, replaces JSearch+SerpAPI-only design)
**Source 1 — Direct scrapers:** 785 curated sites (courts, NALSA, firms, portals) in the `job_sources` DB table. Refresh every 2 days.
**Source 2 — Provider APIs:** Apify actors + JSearch + SerpAPI + Adzuna.
**Source 3 — LLM extraction:** raw HTML → LLM → structured listing, only for sources marked `llm_extract`, hard-capped per run.

## Non-negotiable worker rules
- Insert-before-delete (P006)
- Per-source transaction + try/catch (one dead site of 721 ≠ dead run); auto-disable after 5 consecutive failures
- Dedupe across all three sources via `dedupe_hash` UNIQUE
- `expires_at = 72h` (cadence is 2 days; 48h expiry risks an empty board)
- Students NEVER trigger external calls

## Definition of Done
Students see a deduplicated, filterable list refreshed every 2 days from all three sources; a full-run failure leaves yesterday's jobs visible, never an empty board.

## API Endpoints
| Method | Path |
|---|---|
| GET | /api/jobs?city=&type=&govt=&salary=&page= |
| GET | /api/jobs/stats — { totalActive, newToday } |
| GET | /health/job-board (planned — UptimeRobot scrape-health check) |

## DB
job_sources (seeded, 785 rows), job_cache (+source_type, source_url, dedupe_hash, is_government, salary_text — latter two added in `20260721_job_cache_govt_salary.sql`), ai_usage_log

## Deploy blockers — needs a human with box/GitHub access, not code
1. **Env vars on staging's `.env`** (lives on the box, not in git — no remote exec access from this session to set it directly): `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.1-flash-lite`, `LLM_EXTRACT_MAX_PER_RUN` (default 50 if unset), `SERPAPI_KEY` (provided 2026-07-22 — ready to use), `APIFY_TOKEN` (provided 2026-07-22) + `APIFY_ACTOR_ID` (NOT yet provided — Apify stays a clean no-op until this is set), `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` (only one of the two provided so far — Adzuna not wired up yet).
2. **Run the migration** (`backend/models/migrations/20260721_job_cache_govt_salary.sql`) against staging RDS — staging first, per the college_id/migration rules, before this ships to production.
3. **Register a pm2 process for the worker.** Every other worker (`otp-worker` etc.) is started manually via SSH once, then just `pm2 reload`d on each deploy — the deploy workflow doesn't `pm2 start` new workers on its own. `jobScraper.worker.js` needs `pm2 start workers/jobScraper.worker.js --name job-scraper-worker && pm2 save` run once on staging, and ideally a `pm2 reload job-scraper-worker --update-env` line added to `.github/workflows/deploy-staging.yml` so future deploys keep it in sync (this session's GitHub token lacks the `workflow` scope needed to push that line itself).

## Open item
State filter for the 677 district-court sources (61 pages unfiltered is a known UX gap).

## Pre-Deploy Checklist
- [ ] Normal / [ ] Stupid / [ ] Access
- [ ] Limit — LLM-extract cap enforced (kill-switch test: mark 100 sources llm_extract, confirm run stops at cap)
- [ ] Cost — one full run's API + LLM cost measured on staging BEFORE production
