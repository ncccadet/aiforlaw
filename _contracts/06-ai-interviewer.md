# Contract: AI Interviewer (v4 — amendment proposed 2026-07-28)
**Status:** v3 live on production. v4 amendment below is DRAFT — awaiting founder agreement. No code written until agreed.
**v3 Status:** In Progress (all 5 files built and locally verified — `node -c` on backend, `vite build` on frontend; NOT yet run against real staging Postgres/Redis/Gemini, since none are reachable from the build sandbox)
**Week:** Week 4
**Limit:** 16 sessions/MONTH (monthly Redis window via `featureLimitMonthly`, per-college staggered reset — matches Court Simulation's pattern; unchanged from v2)
**Estimated Cost (350 students):** Worst case (all 350 use all 16 sessions in a month, hard tier every time): 350 × 16 × (2000in + 3000out) tokens ≈ 11.2M in + 16.8M out tokens/month. At gemini-3.1-flash-lite ($0.25/1M in, $1.50/1M out) ≈ $2.80 + $25.20 ≈ **$28/month** for question generation, plus the summary call (3000in/1000out × 350×16 ≈ 16.8M in + 5.6M out ≈ $4.20 + $8.40 ≈ **$12.60/month**) → **≈$41/month worst case** (≈₹3,400/month at ₹83/$). Realistic usage (not every student maxes hard-tier 16x/month) will be far lower — flagged as worst-case ceiling, not an expected bill.

---

## v4 Amendment — Question Repetition Across Sessions (DRAFT, 2026-07-28)

### The problem, from production data (not theory)
Founder ran two `easy` / `General / Fresher` sessions on production (`sriyash@gmail.com`,
2026-07-27 and 2026-07-28) and reported "maximum questions are repeated". Pulling
`sessions.questions` for both confirms it. The wording differs every time; the
**skeleton is identical, slot for slot, in the same order**:

| # | Session 1 (27 Jul) | Session 2 (28 Jul) | Same slot? |
|---|---|---|---|
| 1 | Introduce yourself + journey through law school | Introduce yourself + why you chose law | yes |
| 2 | What motivated you to choose law / why our firm | Which practice areas interest you and why | yes |
| 3 | How do you stay updated on IPC/CrPC → BNS/BNSS | How do you stay updated on BNS/BNSS/BSA | yes (near-verbatim) |
| 4 | Describe a challenging internship situation | Describe a challenging academic project | yes |
| 5 | How do you prioritise under deadlines | How do you handle a task you don't know | yes |
| 6 | Most significant BNSS change to the arrest process | Primary objective of an FIR under BNSS | yes |
| 7 | Where do you see yourself in three years | Where do you see yourself in three to five years | yes (near-verbatim) |

So this is **not** a caching bug and not a storage bug. Questions are stored
correctly and permanently in `sessions.questions`; they are auditable at any time.

### Root cause
`buildPrompt()` in `backend/workers/aiInterviewer.worker.js` is **stateless**. Every
session sends a byte-identical prompt — same difficulty, same role, same instructions,
no knowledge of anything the student has already been asked. At `temperature: 0.7`
a model given an identical prompt converges on the same canonical answer set.

`easy` is the worst-affected tier because its brief is the narrowest: 6–7
foundational/behavioural questions for a fresher. There are only so many
"canonical" openers, and the model picks the same seven every time. `medium` and
`hard` have more room (8–12 questions, adversarial framing) so they diverge more,
but the same defect applies to them.

### The fix (agreed shape — one query, one prompt change, no architecture change)
At `/start`, before calling Gemini, read back this student's recent question sets
and pass them into the prompt as an explicit do-not-repeat list.

1. **New query in the worker** (or passed through from the controller), scoped
   to the student AND their college, per the `college_id` rule:
   ```sql
   SELECT questions
   FROM sessions
   WHERE user_id = $1
     AND college_id = $2
     AND feature_name = 'ai_interviewer'
     AND questions IS NOT NULL
   ORDER BY created_at DESC
   LIMIT 3;
   ```
   Three sessions, not all of them: a student on the 16/month limit would
   otherwise be sending ~112 prior questions into a 1500-token input cap by
   month-end. Three sessions is at most ~36 questions.
2. **Prompt addition** — appended only when prior questions exist:
   > The student has already been asked the following questions in previous
   > sessions. Do NOT repeat any of them, and do NOT ask a reworded version of
   > the same underlying question. Cover different ground:
   > `<numbered list of prior questions>`
3. **Hard truncation** — the prior-question block is capped at **400 tokens
   (1600 chars)**, sliced most-recent-first. This keeps `easy`/`medium` inside
   their existing 1500-token input cap with room to spare; the caps in the v3
   table are UNCHANGED.
4. **Temperature raised 0.7 → 0.95** for the question-generation call only.
   The summary call stays at its current temperature — scoring should be
   consistent, question generation should not.

### Cost impact
Input only, generation call only. Worst case +400 tokens × 350 students × 16
sessions = 2.24M extra input tokens/month = $0.56 ≈ **₹47/month**. No extra
Gemini calls. The one extra Postgres query per session is indexed on
`(user_id, feature_name)`.

### What this does NOT do
It does not guarantee zero repetition forever — after enough sessions the student
exhausts the genuinely distinct question space for a tier. It guarantees no
repetition against the **last 3 sessions**, which is what the founder actually
observed. If repetition is still visible after this ships, the next lever is
seeding the prompt with a rotating sub-topic (e.g. "focus this session on
professional-ethics scenarios") rather than growing the exclusion list.

### Definition of Done (v4)
Two consecutive `easy` sessions for the same student, same role, produce question
sets with **no shared slot** on the seven-point skeleton above — verified by
running two real sessions on staging and diffing `sessions.questions`, not by
inspecting the prompt.

### Files that change
| File | Change |
|---|---|
| backend/workers/aiInterviewer.worker.js | prior-questions query, prompt block, truncation, temperature |
| _contracts/06-ai-interviewer.md | this amendment |
| _decisions/decisions-log.md | one line |

No DB migration. No API change. No frontend change.

---

## v3 Changes vs v2 (2026-07-23 — built from founder voice brief + a partner-provided zip)
- **Unified architecture across all three tiers**: batch-generate the full question list in ONE Gemini call at `/start` (previously the design doc only said "8-10 questions... one call" without addressing tiers differently; a zip built in parallel had the hard tier adaptive/per-turn — that was NOT built, see decisions-log 2026-07-23).
- **Tier-specific question counts and token caps** (founder-dictated, exact):
  | Tier | Questions | Input cap | Output cap |
  |---|---|---|---|
  | Easy | 6-7 | 1500 tokens | 1000 tokens |
  | Medium | 8-10 | 1500 tokens | 2000 tokens |
  | Hard | 10-12 | 2000 tokens | 3000 tokens |
  | Final summary (any tier) | — | 3000 tokens | 1000 tokens |
- **TTS is browser-native** (`window.speechSynthesis`, best-available Indian-English voice per browser/OS) — supersedes v2's "third-party provider via `POST /tts`" line. No `/tts` route exists. See decisions-log for the real-world limitation this implies (voice can't be forced identical across every browser/OS).
- **STT is browser-native** (`SpeechRecognition`/`webkitSpeechRecognition`) — unchanged from v2.
- **Resume grounding** reuses an already-analyzed Resume Analyzer document (`documents.analysis_json`, feature_name='resume_analyzer', ownership-checked) — no new PDF-upload pipeline for this feature.
- **Role selector**: 8 founder-delegated "trending" roles (see `ROLES` in the controller) replace the free-text `filters` object.
- **Summary parameters**: `overallScore`, `legalUnderstanding`, `tonality`, `confidence`, `clarity`, `voiceLevel`, `speechPaceWpm`, `summary`, `strengths[]`, `improvements[]` (explicit "what to change").

## Definition of Done
Student enters their name, picks a role and difficulty tier, optionally selects an already-analyzed resume → receives that tier's full question list (generated once, in one Gemini call) → is asked each question via the browser's own voice, answers by voice (live-transcribed, editable, confirm/discard before submit) → after the last question, gets one summary call scoring legal understanding, tonality, confidence, clarity, voice level, with concrete "what to change" feedback.

## API Endpoints
| Method | Path | Notes |
|---|---|---|
| GET  | /api/ai-interviewer/options | tiers (with question-count ranges) + roles |
| POST | /api/ai-interviewer/start | {difficulty, role, resume_doc_id?} → 202 {sessionId, status:'preparing'} — monthly-limited |
| GET  | /api/ai-interviewer/session/:id | poll while worker generates questions; once active, full question list |
| POST | /api/ai-interviewer/answer | {session_id, index, answer, voiceLevel, durationSec, wordCount} — free, no Gemini call |
| POST | /api/ai-interviewer/finish | {session_id} → ONE summary Gemini call → result |
| GET  | /api/ai-interviewer/result/:id | the stored summary |

No `/tts` route — TTS is entirely client-side.

## DB
sessions (difficulty, filters.role, questions, resume_doc_id, turns, turn_count, status, summary, is_complete), documents (resume_analyzer, read-only here), ai_usage_log. No new migration needed — `schema.sql`'s `sessions` table already had every column this feature needs.

## Files
| File | Owner | Done? |
|------|-------|-------|
| frontend/src/pages/AIInterviewerPage.jsx | | [x] |
| frontend/src/services/aiInterviewer.service.js | | [x] |
| backend/routes/aiInterviewer.routes.js | | [x] |
| backend/controllers/aiInterviewer.controller.js | | [x] |
| backend/workers/aiInterviewer.worker.js | | [x] |

## Pre-Deploy Checklist
- [ ] Normal — full session with and without a resume, each tier
- [ ] Stupid — invalid difficulty, empty/whitespace answer, double-click Start, click mic before question finishes speaking (must stay disabled), no browser STT support (must fall back to manual typing)
- [ ] Access — attach another student's resume_doc_id → must silently proceed WITHOUT resume grounding (never leak existence, never 500); attach another student's session_id to /answer or /finish → 404
- [ ] Limit — 17th session in a month blocked; confirm monthly (not weekly) reset message
- [ ] Cost — ai_usage_log shows exactly 1 generation call + 1 summary call per completed session, no per-answer calls
