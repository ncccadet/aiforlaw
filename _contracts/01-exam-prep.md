# Contract: Exam Prep (v3.1 — full exam format, timed, AI-generated, split limits)
**Status:** In Progress (built 2026-07-28, deployed to staging — NOT production)
**Week:** Week 2 (rebuilt Week 4)
**Limit:** **15 AIBE + 15 SPPU papers per MONTH** per student — two separate Redis counters
(`featureLimitMonthly('exam_prep_aibe', 15)` and `featureLimitMonthly('exam_prep_sppu', 15)`),
atomic INCR, per-college staggered reset — same pattern as Court Simulation and AI Interviewer
**Estimated Cost (350 students):** see [Cost Analysis](#cost-analysis) — worst case **₹7,718/month**, realistic **≈₹2,058/month** (MEASURED on staging 2026-07-28, not estimated)

## v3.1 change (2026-07-28, founder decision)

The shared **30/month** of v3 is replaced by **15 + 15**. The total number of papers a student can
generate is unchanged; what changes is that they can no longer spend all of them on AIBE, which is
the expensive side (₹1.12 a paper vs ₹0.35 — measured). That makes the old worst case
arithmetically impossible and drops the ceiling from **₹11,729 to ₹7,718** — a **34% reduction**.

> **Note on the numbers below (2026-07-28).** Every figure in this section was originally an
> estimate. They have now been **replaced with measured values** from real staging runs logged in
> `ai_usage_log`. The estimates were high on both features — AIBE by 22%, SPPU by 37%. The founder
> goal was to halve the original ₹15,015 ceiling to ≈₹7,508; the measured ceiling is **₹7,718**,
> so that goal is met at 15 + 15 with no further cut to the AIBE counter.
It also fixes a fairness problem: under one shared pool, grinding Bar-exam mocks could leave a
student with no university papers for the semester they are actually sitting.

---

## v3 Changes vs v2 — and why v2 is void

v2 said *"Unlimited (still zero AI at query time)"* and *"₹0 at query time (model answers
pre-generated OFFLINE)"*. That design is dead. The founder's brief (2026-07-28) is a **live
AI-generated, full-length, timed exam**, which means real Gemini calls at request time and
therefore a real cost ceiling and a real limit. Every line of v2's cost and limit section is
superseded by this document.

| | v2 (void) | v3 (this contract) |
|---|---|---|
| Question source | pre-authored, cached | AI-generated live per paper |
| Length | arbitrary practice set | **full exam format** — AIBE 100 MCQ, SPPU 80 marks |
| Timer | none | **server-enforced**, 210 min (AIBE) / 180 min (SPPU) |
| Limit | unlimited | **15 AIBE + 15 SPPU per month** |
| Cost at query time | ₹0 | ₹1.12 (AIBE) / ₹0.35 (SPPU) per paper — measured |
| Library | not in v2 | browse + download past papers (S3) + official external sources |

---

## The three things a student can do

**A. AIBE (Bar Council) — full paper.** 100 multiple-choice questions across the official AIBE
subject weightage (19 subjects, weights summing to exactly 100), +1 per correct answer,
**no negative marking**, pass mark 45% (40% for SC/ST/PwD), **210-minute** timer. Auto-scored
deterministically on submit — **zero AI at grading time**. Correct answers never leave the server
until the paper is submitted.

**B. SPPU (University) — full 80-mark paper.** Pick program → year → semester → subject.
The paper follows the SPPU written-exam structure:

| Part | Questions | Marks each | Total | Answer length |
|---|---|---|---|---|
| A — Long answer | 3 | 15 | 45 | ≤300 words |
| B — Short notes | 2 | 10 | 20 | ≤200 words |
| C — Short answer | 3 | 5 | 15 | ≤120 words |
| **Total** | **8** | | **80** | |

(The remaining 20 marks of the SPPU 100 are internal assessment — not examinable here.)
**180-minute** timer. Each answer is AI-graded against a server-side marking scheme the student
never sees before submitting.

**C. Library.** Browse program → year → semester and download past question-paper PDFs
(catalogued in `exam_papers`, files in S3, presigned 120-second URLs), plus a curated list of
official/public sources where SPPU past papers can be downloaded directly.

Both exams are labelled in the UI: **"AI-generated practice paper — not an official exam paper."**
Every AI response carries: *"For educational purposes only. Verify with a qualified advocate."*

---

## Timer — server-enforced, not a client countdown

A countdown in React is a decoration; anyone can stop it. So:

- `POST /aibe/generate` and `POST /sppu/generate` stamp `started_at` and `expires_at` into the
  attempt row and return `expiresAt` (ISO) + `durationMin` to the client.
- The client renders the countdown from `expiresAt` (not from a local start time) and
  **auto-submits** whatever has been answered when it hits zero.
- `POST /*/submit` recomputes expiry server-side. A submission arriving after
  `expires_at + 120s` grace is **still graded and still saved** — losing a student's work to a
  network hiccup is worse than an untimed score — but the result is flagged `expired: true` and
  the UI says so. Timing is reported honestly, never enforced by destroying work.
- Elapsed time is stored on the attempt and shown in the summary.

## Resume / recovery

`GET /api/exam/active` returns the student's most recent unsubmitted, unexpired paper so a closed
tab or a refresh does not burn one of the student's monthly papers. The client offers to resume it.

---

## API Endpoints

| Method | Path | Middleware | Notes |
|---|---|---|---|
| GET  | /api/exam/structure | auth | AIBE weightage + SPPU program tree + library links + monthly usage |
| GET  | /api/exam/active | auth | resume an in-progress paper (no limit consumed) |
| POST | /api/exam/aibe/generate | auth + **monthly 15 (AIBE counter)** | 100 MCQs, batched Gemini calls → `{paperId, questions[], expiresAt}` |
| POST | /api/exam/aibe/submit | auth **(no limit)** | deterministic auto-score, zero AI |
| POST | /api/exam/sppu/generate | auth + **monthly 15 (SPPU counter)** | 8-question 80-mark paper → `{paperId, parts[], expiresAt}` |
| POST | /api/exam/sppu/submit | auth **(no limit)** | one AI grading call per answered question |
| GET  | /api/exam/library | auth | browse `exam_papers` |
| GET  | /api/exam/library/:id/download | auth | presigned S3 URL, 120s |
| GET  | /api/exam/analytics | auth | score trend from `exam_attempts` — pure SQL, zero AI |

**The limit middleware is on `generate` only, never on `submit`.** A student who has started a
paper must always be able to finish it, even if the month rolls over mid-exam.

---

## Data

- **`exam_attempts`** — has `college_id`, **is RLS-protected**. Every read and write goes through
  `queryAsCollege(req.user.college_id, ...)`. Never `pool.query`.
- **`exam_papers`** (migration `20260728_exam_prep_v3.sql`) — Library catalogue. Shared platform
  content, deliberately **no `college_id`** (past papers are identical for every college), same as
  `exam_content`. Read with plain `pool.query`.
- **`ai_usage_log`** — one row per paper generated and one per grading batch. No RLS policy on this
  table (fire-and-forget analytics), so plain `pool.query`, same as Drafting Lab.

Migration is idempotent, wrapped in `BEGIN/COMMIT`, no `ALTER TABLE` run by hand on any server.

---

## Model

The model is **never hardcoded**. All Gemini traffic goes through `generateText()` in
`backend/services/gemini.service.js`, which resolves `process.env.GEMINI_MODEL || DEFAULT_MODEL`.
The partner-provided draft hardcoded `'gemini-3-1-flash-lite'` (wrong separator — would 404) and
instantiated its own `GoogleGenerativeAI` client and its own `new Pool()`, bypassing `config/db.js`
and therefore RLS. All three removed. `finishReason === 'MAX_TOKENS'` is treated as a truncated
response and the batch is retried once at a smaller size, never silently trusted.

## Token caps

| Call | Max in | Max out |
|---|---|---|
| AIBE batch (≤13 questions) | 900 | 1,700 |
| SPPU paper generation | 900 | 2,400 |
| SPPU answer grading (per question) | 1,000 | 220 |

Student answers are truncated **server-side** to the per-part word cap before ever reaching Gemini,
so a student pasting a novel cannot inflate the bill.

---

## Cost Analysis

Gemini pricing $0.25 / 1M input, $1.50 / 1M output. USD→INR 84.

**All figures below are MEASURED**, from `ai_usage_log` rows produced by real staging runs on
2026-07-28 (rows 261–264). They are not estimates. The previous estimated figures are kept in the
right-hand column so the size of the error is on the record.

**One AIBE paper (100 MCQs).** 100 questions cannot come back in one call — ~11,000 output tokens
was the estimate, far past any sane single-response cap — so generation is **batched by subject
group**, 9 calls of ≤13 questions each.

| | Measured | Estimated | Error |
|---|---|---|---|
| Input tokens | 2,324 | 2,250 | +3% |
| Output tokens | 8,478 | 11,000 | −23% |
| **Cost per paper** | **₹1.12** | ₹1.43 | −22% |

Per batch that is 258 input against a 900 cap and 942 output against a 1,700 cap — every call ran
at roughly 55% of its ceiling, with **no truncation and no retry**. Grading is deterministic: **₹0**.

**One SPPU paper (8 questions, 80 marks).** Generation measured at 294 in / 886 out (two runs
agreed to within 3 tokens). Grading of a full 8-question paper measured at 1,345 in / 562 out with
short answers; with full-length answers the grading input roughly triples.

| | Measured | Estimated | Error |
|---|---|---|---|
| Generation | 294 in / 886 out | 300 in / 2,200 out | output −60% |
| Grading (8 Q) | ~4,000 in / ~1,200 out | 5,600 in / 1,200 out | −29% in |
| **Cost per full cycle** | **₹0.35** | ₹0.55 | −36% |

The generation output cap is 2,400 and actual use was 886 — 37% of it. The earlier estimate of
2,200 was close to the cap, which is what made the cap look tight when it was not.

**At 350 students, maxing both counters — 15 AIBE + 15 SPPU:**

| Scenario | Monthly cost | vs ₹20,000 ceiling |
|---|---|---|
| **Every student maxes both counters (the true ceiling)** | **₹7,718** | 39% of ceiling |
| Every student maxes AIBE only | ₹5,864 | 29% |
| Every student maxes SPPU only | ₹1,853 | 9% |
| **Realistic — 8 papers/student/month, 50/50** | **≈₹2,058** | 10% |

The split limit is what makes ₹7,718 the *ceiling* rather than a mid-case: under v3's shared 30 a
student could put all 30 into AIBE, and 350 students doing so cost ₹11,729 at measured rates. No
student can now generate more than 15 AIBE papers, so that scenario cannot occur at all.

₹7,718 against a ₹20,000 alert leaves roughly ₹12,300 for the other six AI features. If the Gemini
dashboard trends toward it, three further levers, in the order they should be pulled:

1. **Cache AIBE question banks.** AIBE questions are not student-specific — they are shared
   platform content. Generating a pool of ~600 questions once a week and serving randomised
   weighted 100-question subsets drops AIBE generation cost by ~95% (₹5,864 → under ₹300). This
   is the intended step 2, and it is why `exam_papers`/`exam_content` carry no `college_id`.
2. **Drop the AIBE counter further** — 15 → 8. Now measured as **unnecessary**: it was proposed to
   reach a ≈₹7,508 target that 15 + 15 already meets at ₹7,718. Kept here only as a lever if real
   usage exceeds projections.
3. **Drop both counters** to 10 + 10.

~~Split the limits~~ — done in v3.1 (15 + 15). This was lever 3 in v3 and has already been pulled.

Lever 1 is the right one and costs no student-visible quality. It is deliberately **not** in v3.1
because a cached bank needs a review/QA pass on the pooled questions before students see them.

**Cost observability (added 2026-07-28).** `ai_usage_log` now carries `calls` and `finish_reason`
(migration `20260728_ai_usage_calls.sql`). Before this, the admin panel counted *rows* as calls —
Exam Prep writes one row for a 9-call AIBE generation and one for an 8-call SPPU grading, so 11
real calls displayed as 3. Rupee and token figures were never affected. `finish_reason` makes
truncation visible after the fact: `MAX_TOKENS` on any row means an output cap needs raising.

**Budget alert:** the existing ₹20,000/month Gemini alert stands. Exam Prep must be watched daily
on the Gemini dashboard for the first two weeks after launch, per the project rules.

---

## Files

| File | Change |
|---|---|
| backend/models/migrations/20260728_exam_prep_v3.sql | NEW — `exam_papers` + attempt indexes |
| backend/controllers/examPrep.controller.js | REWRITTEN from stub |
| backend/routes/examPrep.routes.js | REWRITTEN — monthly limit on generate only |
| backend/app.js | dashboard card → `ai: true, cap: '30/month'` |
| frontend/src/pages/ExamPrepPage.jsx | REWRITTEN — full format, timer, portal theme |
| frontend/src/services/examPrep.service.js | REWRITTEN |
| _contracts/01-exam-prep.md | this (v2 → v3) |
| _decisions/decisions-log.md | one line |

---

## Definition of Done

A student opens Exam Prep, starts an AIBE paper, gets 100 questions across the official weightage
with a live 210-minute countdown, answers some, and either submits or is auto-submitted at zero —
then sees score, pass/fail against 45%, and a subject-by-subject breakdown with correct answers
revealed only after submission. The same student starts an SPPU paper for a real subject from their
own semester, gets a Part A/B/C 80-mark paper, writes answers under a 180-minute countdown, and
receives per-question marks with specific feedback. The 16th AIBE paper in a calendar month is
refused with a 429 **while a 16th SPPU paper is still allowed** — the two counters are independent.
A closed tab can be resumed without burning a paper.

## Pre-Deploy Checklist (5-path test — staging)

- [ ] **Normal** — full AIBE paper start → answer → submit → summary; full SPPU paper start → write → submit → graded summary; Library browse + download
- [ ] **Stupid** — submit with zero answers; submit the same paper twice (must 409); invalid program/semester/subject (must 400); 5,000-word answer (truncated server-side, not a 500); double-click Generate
- [ ] **Access** — another student's `paperId` on submit → 404, never a leak; another college's attempt invisible under RLS; the `correct` field must NOT appear in the generate response (view-source check)
- [ ] **Limit** — 16th AIBE generate in a month → 429; SPPU generate still works after AIBE is exhausted (and the reverse); submit still works after either limit is hit
- [ ] **Cost** — `ai_usage_log` shows ~9 rows per AIBE paper and 0 at grading; ~1 + 8 for SPPU; check the Gemini dashboard immediately after
