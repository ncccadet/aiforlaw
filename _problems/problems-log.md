# Problems Log

Review every Monday morning. Check error_log table + API dashboards.

## Entry Format
```
## [Date] — [Feature] — [Title]
**Symptom:** What you saw
**Root Cause:** What caused it
**Fix Applied:** What you did
**Prevention:** How to stop recurrence
**Status:** Fixed | Monitoring | Open
```

---

## Pre-Logged Predicted Problems

### P001 — Works on Laptop, Breaks on AWS
**Symptom:** App works locally, throws errors on EC2
**Root Cause:** Server missing packages / wrong .env values
**Fix:** Ask Claude: "What environment differences could cause this?"
**Prevention:** Deploy empty skeleton in Week 1 Day 4
**Status:** Pre-logged

### P002 — New Code Breaks Old Feature
**Symptom:** Adding a feature breaks something that worked before
**Root Cause:** Claude built new feature without seeing existing code
**Fix:** Paste both files: "The app worked before I added this. Find what changed."
**Prevention:** Always paste project structure + contracts at start of every Claude conversation
**Status:** Pre-logged

### P003 — API Bill Spikes Unexpectedly
**Symptom:** Gemini or SerpAPI bill is 3x expected
**Root Cause:** Rate limit bug or heavy unexpected usage
**Fix:** Disable endpoint → check logs → fix limit → re-enable
**Prevention:** Set ₹20K budget alert Day 1. Check dashboards daily first 2 weeks
**Status:** Pre-logged

### P004 — Malicious PDF Crashes Parser
**Symptom:** Resume upload crashes the server
**Root Cause:** PDF processed in main API process
**Fix:** All PDF processing must go through BullMQ worker (already implemented)
**Prevention:** Never process PDFs in main API
**Status:** Pre-logged

### P005 — Rate Limit Race Condition
**Symptom:** Two simultaneous requests both pass the limit check
**Root Cause:** DB count check is not atomic
**Fix:** featureLimit.middleware.js uses Redis atomic INCR (already implemented)
**Prevention:** Never use DB query for rate limiting
**Status:** Pre-logged

### P006 — Job Board Empty After Worker Fail
**Symptom:** Students see zero jobs after scraper runs
**Root Cause:** Worker deleted cache before fetching; fetch failed
**Fix:** Sequence: fetch → validate → insert → delete expired (already in worker comments)
**Prevention:** Never delete before successful insert
**Status:** Pre-logged

### P007 — Email Goes to Wrong College Students
**Symptom:** College A students get College B emails
**Root Cause:** Missing WHERE college_id in email batch query
**Fix:** Batch emails PER COLLEGE in a loop (see lawNews.worker.js comments)
**Prevention:** Test with 2 fake colleges on staging before any production deploy
**Status:** Pre-logged

### P008 — Token in localStorage
**Symptom:** JWT stored in localStorage — visible to JavaScript
**Root Cause:** Developer used localStorage instead of httpOnly cookie
**Fix:** auth.middleware.js reads from req.cookies only (already implemented)
**Prevention:** Build auth once correctly in Week 1. Never revisit.
**Status:** Pre-logged

---

## v2 Predicted Problems (July 2026 feature revision) — pre-solved in scaffold

### P009 — Question Generation Fails Mid-Session (AI Interviewer)
**Symptom:** Student clicks start, spinner never ends; session stuck in 'preparing'
**Root Cause:** Worker's Gemini call fails or returns unparseable JSON for the 8–10 questions
**Fix Applied:** sessions.status column (preparing/active/failed) + worker validates 8≤n≤10, retries once, marks 'failed'; frontend polls and shows retry
**Prevention:** Never charge the weekly limit until status='active' — refund the Redis counter on 'failed' (implement DECR on failure)
**Status:** Pre-logged

### P010 — Job Board Empty Because 48h Expiry < 2-Day Cadence
**Symptom:** Board empty every few days for a few hours
**Root Cause:** expires_at (48h) shorter than the real gap between runs (48h+ when a run is delayed)
**Fix Applied:** expires_at default raised to 72h in schema v2
**Prevention:** Expiry must always exceed cadence by ≥50%
**Status:** Solved in scaffold

### P011 — One Dead Court Site Kills the Whole 721-Source Run
**Symptom:** Scraper log shows crash at source #212; nothing after it scraped
**Root Cause:** Single try/catch around the whole loop
**Fix Applied:** Per-source transaction + try/catch; job_sources.fail_count with auto-disable at 5
**Prevention:** Row-level fault isolation is a stated worker rule in contract 03
**Status:** Solved in scaffold

### P012 — Duplicate Jobs From Overlapping Sources
**Symptom:** Same internship listed 3x (direct scrape + Apify + JSearch all found it)
**Root Cause:** Three pipelines writing to one table with no dedup
**Fix Applied:** dedupe_hash (md5 of title+firm+apply_url) UNIQUE + ON CONFLICT DO NOTHING
**Prevention:** Any future 4th source must write through the same upsert
**Status:** Solved in scaffold

### P013 — LLM-Extract Runaway Bill (Job Board Source 3)
**Symptom:** Gemini bill spikes on scraper days
**Root Cause:** Scraper falls back to LLM extraction for hundreds of unparseable pages
**Fix Applied:** LLM_EXTRACT_MAX_PER_RUN hard cap (env, start 50) + every call logged to ai_usage_log
**Prevention:** A run needing 700 LLM calls is a scraper bug — fix the parser, don't raise the cap
**Status:** Pre-logged

### P014 — AI-Generated "News" Hallucinates Judgments
**Symptom:** Weekly digest cites a Supreme Court ruling that doesn't exist; law faculty notices
**Root Cause:** Law News v2 is AI-only sourced; models invent plausible legal news
**Fix Applied:** Prompt (versioned in prompt_versions) restricted to widely-reported, source-named items; disclaimer on digest
**Prevention:** Founders review first 4 digests before send; consider founder-first send permanently
**Status:** Pre-logged

### P015 — Monday-Morning RPM Spike From Weekly Limit Reset
**Symptom:** Gemini 429s every Monday ~9am as all students regain Court Sim/Interviewer sessions simultaneously
**Root Cause:** All weekly counters reset at the same instant
**Fix Applied:** featureLimitWeekly staggers reset boundary 0–48h per college (stable hash of college_id)
**Prevention:** Any future weekly-windowed feature must reuse featureLimitWeekly, not roll its own
**Status:** Solved in scaffold

### P016 — Answer Keys Leaked to the Browser
**Symptom:** Students score 100% on blanks/MCQs suspiciously fast
**Root Cause:** answer_key / correct_answer / model_answer included in the GET questions/template payload (view-source cheating)
**Fix Applied:** Controllers explicitly exclude these fields from all pre-submission responses
**Prevention:** Stupid Path test now includes a view-source check for both Exam Prep and Drafting Lab Mode 2
**Status:** Pre-logged

### P017 — TTS Provider Key Exposed / TTS Cost Unbounded
**Symptom:** TTS bill spikes; provider key found in frontend bundle
**Root Cause:** Calling TTS provider directly from the browser
**Fix Applied:** POST /api/ai-interviewer/tts server-side proxy; key in env only; text length capped; audio cached per question text
**Prevention:** Same proxy pattern for any future third-party media provider
**Status:** Pre-logged
