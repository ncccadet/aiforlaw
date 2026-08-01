# Contract: Court Simulation (v4.1 — voice + case-overview fixes)
**Status:** In Progress
**Week:** Week 4
**Limit:** 16 sessions/month (`featureLimitMonthly`, per-college staggered reset — unchanged from v3)
**Token ceilings (founder spec, 2026-07-24 voice brief):** case generation 1,500 in / 1,500 out ·
per-turn 1,500 in / 1,500 out (includes EVERYTHING sent to the model that call — system prompt,
full running context/history, case brief, the student's new statement) · hard cap 15 turns/session
(soft target: aim to conclude by turn 10-12) · student mic/statement hard-stops at 200 words ·
judge's per-turn remark hard-stops at 100 words · final feedback capped at 500-600 words total
across its prose fields (numeric scores don't count against this).

---

## v4 — replaces the v2/v3 draft entirely (first real build)
The repo's Court Simulation backend was a TODO stub until today — v2/v3 above were planning
notes, never implemented. The founder's partner supplied a working reference implementation
(zip, 2026-07-24) which this build adapts, NOT copies verbatim — three deliberate departures
from the zip, all to match this platform's already-established patterns from Drafting Lab and
AI Interviewer (built earlier this week):

1. **Case generation moved to an async BullMQ worker**, not generated inline inside `POST /start`
   as the zip did. Inline generation blocks the HTTP request for however long Gemini takes and
   risks a timeout under load; every other AI-generates-then-student-interacts feature on this
   platform (AI Interviewer's question batch, Drafting Lab's case study) already uses
   `session status: 'preparing' → worker generates → 'active'`, polled via `GET /session/:id`.
   Court Simulation now follows the same shape for consistency and reliability.
2. **Gemini calls go through the shared `gemini.service.js`** (native REST client), not the zip's
   `@google/generative-ai` SDK — standing platform rule (SDK/OpenAI-compatible shims break
   `AQ.`-prefixed API keys; the native REST endpoint doesn't). Also fixes the zip's hardcoded
   invalid model id `gemini-3-1-flash-lite` (a typo — real id has dots, not dashes) by simply
   never hardcoding it; `gemini.service.js`'s own `GEMINI_MODEL` env var / verified default
   handles this.
3. **No refund-on-failure.** The zip had a custom `redis.decr`-based refund of the weekly slot
   if case generation failed. Dropped — matches the established no-refund pattern already used
   by Drafting Lab and AI Interviewer (simpler, consistent); a failed 'preparing' session just
   doesn't refund the monthly counter, same as those two.

## Token ceilings — founder-specified vs. this build's own reasoned additions
The founder gave exact numbers for turn and case-gen calls; the summary/judgment call's caps
were NOT given a number and are this build's own choice, documented here rather than guessed
silently:
- **Case generation:** 1,500 in / 1,500 out — founder-specified ("case generation should be also
  same [as turn]").
- **Per turn:** 1,500 in / 1,500 out — founder-specified, explicitly "includes everything."
- **Finish/judgment/feedback call: 9,000 in / 1,200 out — NOT founder-specified, this build's
  own choice.** Reasoning: this is the one call that must see the ENTIRE transcript at once
  (up to 15 turns × ~500 words/turn ≈ 9,600 tokens worst case) to judge the whole argument, so
  it structurally needs a bigger input cap than a single turn; 1,200 out comfortably fits the
  founder's separately-stated 500-600 WORD ceiling on the feedback content (≈650-800 tokens)
  plus JSON structure and the numeric score fields.

## Turn/word ceilings (founder-specified, enforced server-side, not just prompted)
- Student statement: hard-stops the mic/textarea at **200 words** (was going to be 300, founder
  corrected mid-sentence to 200 — see decisions-log). A warning shows the moment the cap is hit.
- Judge's per-turn remark: prompted to be "very, very small" and hard-clamped server-side to
  **100 words** (founder: "when you answer, it should be stopped with hundred words").
- Opposing counsel's per-turn rebuttal: **no founder number given.** This build targets ~150-200
  words in the prompt and hard-clamps at 250 words server-side — a reasoned choice to keep
  exchanges brisk toward the 10-12-turn soft-conclude target, while leaving generous headroom
  under the 1,500-token turn output ceiling (a cost ceiling, not a target length — same
  reasoning already applied to AI Interviewer's per-tier caps).
- Turn count: **soft target 11** (founder: "ending in ten to twelve," midpoint used), **hard cap
  15** (founder: "maximum twelve to fifteen turns per session... this is the hard ceiling" —
  upper bound used as the true ceiling). On turn 15, the model is forced to conclude.
- Final feedback: judgment prose ≤120 words, legal-knowledge assessment ≤60 words, up to 5 items
  each in strengths/weaknesses/improvements at ≤25-30 words apiece — sums to ≤580 words worst
  case, under the founder's 500-600 word ceiling by design (word-clamped per field server-side,
  not left to the model's own compliance).

## Setup flow (new — did not exist in the stub or the zip)
1. **Student's name** (optional, free text) — personalizes the generated case brief.
2. **Field of law** (was "case type" in the zip; kept the same 5 underlying options — Civil,
   Criminal Trial, Bail Hearing, Constitutional/Writ-PIL, Contract Dispute/Litigation — since
   they already cover "civil law" and "litigation law," the two fields the founder named
   explicitly, without inventing a new taxonomy under time pressure).
3. **Position** (existing, depends on field of law — e.g. Prosecution/Defence).
4. **Level** (NEW — easy / medium / hard). Did not exist in the zip at all. Feeds into both case
   complexity (easy = single clear issue; medium = layered facts with genuine ambiguity; hard =
   multiple intertwined issues) and the opposition's toughness in the turn prompt (harder =
   more aggressive rebuttals, judge more exacting). Reuses `sessions.difficulty` — the same
   column AI Interviewer already uses for its easy/medium/hard tiers.
5. Generate Case → enter the courtroom.

## Judge/judgment structure (founder-specified)
- **During the session**, the judge's per-turn remarks are brief interjections only — never a
  verdict.
- **Only at the end** does the judge deliver the actual judgment (`result.judgment`, prose,
  ≤120 words) — "so everyone could get what the result [is]."
- **Separately**, a feedback/analysis block on fixed parameters: strengths (pros), weaknesses
  (cons), improvements (what to improve), and `legalKnowledgeLevel` (how much legal knowledge
  the student demonstrated) — plus numeric scores (overallScore, legalReasoning, argumentation,
  courtcraft, clarity) for the same at-a-glance UI pattern already used by Drafting Lab/AI
  Interviewer. Numeric fields don't count against the 500-600 word ceiling.

## Non-negotiables (unchanged)
- `college_id` filters every session query (`loadOwnSession` ownership check, same pattern as
  every other AI feature).
- Every AI response carries the standard disclaimer.
- 16/month limit, `featureLimitMonthly`, double-protected (Redis + this feature doesn't need a
  second DB check beyond ownership, since the limit gate is entirely on `/start`, same as AI
  Interviewer).

## v4.1 — real staging feedback fixes (2026-07-24, same day)
Founder tested on staging and found two real UX gaps, plus asked a clarifying question about a
paste of live output — all addressed same day, no code contradicts these:
1. **Judge and opposing counsel spoke in the same voice.** Fixed: `CourtSimulationPage.jsx` now
   auto-picks TWO DISTINCT voices (same quality-first ranking heuristic already established for
   AI Interviewer — prefers Online/Natural/Neural/Google-tagged voices over untagged legacy
   ones). Founder specifically asked for AI Interviewer's "Google India Hindi" voice for
   opposing counsel — `pickOppositionVoice()` actively prefers a Google-branded, Hindi-tagged
   voice where the device has one. **Honest limitation, not hidden:** that exact voice is a
   Windows-Chrome-specific Web Speech API voice; iOS/Android/Mac register an entirely different
   list under WebKit, so identical voices across platforms/phone/laptop is not achievable — same
   constraint already documented for AI Interviewer. The judge always gets a different voice
   object than opposition where more than one exists, plus different pitch/rate as a fallback
   differentiator so the two are audibly distinct even on a single-voice device. Both are
   manually overridable + testable on the setup screen, persisted per-browser.
2. **No case-overview step before entering the courtroom.** Founder: "student should get the
   overview of case before... he has to read that everything, every aspect... once he
   understood that, then you ask him to enter." Fixed: a new `'overview'` phase now sits between
   case generation finishing and the courtroom — shows the full brief (not the small collapsed
   `<details>` the courtroom view still keeps for quick reference), with an explicit "I've read
   the case — Enter courtroom" button the student must click. Only then does `onEnterCourtroom`
   set up the opening judge line and move to `'court'`.

## Files
- [x] `backend/workers/courtSimulation.worker.js` — NEW. Case generation (async, mirrors
      `aiInterviewer.worker.js`).
- [x] `backend/controllers/courtSimulation.controller.js` — full rewrite (was a TODO stub).
- [x] `backend/routes/courtSimulation.routes.js` — adds `/session/:id`, `/finish`, `/result/:id`
      (the stub only had `/case-types`, `/start`, `/turn`).
- [x] `frontend/src/services/courtSimulation.service.js` — full rewrite (was empty TODO).
- [x] `frontend/src/pages/CourtSimulationPage.jsx` — full rewrite (was a placeholder stub).
- [x] `backend/app.js` — `DASHBOARD_FEATURES` blurb updated (was "8-turn," now reflects the real
      10-12 soft / 15 hard range).
- No DB migration needed — `sessions.difficulty`/`filters`/`turns`/`questions`/`summary` already
  exist (added for AI Interviewer/Drafting Lab) and cover everything this feature needs.

## Pre-Deploy Checklist (5-Path Test)
- [x] Normal — verified locally against a mock Gemini server: case generated via the async
      worker, a full turn cycle (student statement → judge + opposition), finish → judgment +
      scored feedback, result endpoint returns the same stored result.
- [x] Stupid — mock Gemini deliberately violated every length instruction (300-word judge,
      400-word opposition, 400-word student statement, 200-word judgment, 150-word legal-
      knowledge, 10-item arrays); every server-side clamp caught it and produced compliant
      output regardless of model behavior.
- [x] Access — cross-user session access confirmed to return 404 (never leaks existence), same
      pattern as every other AI feature. Real two-fake-college test still needs to run on
      staging (this sandbox only has one test college locally).
- [x] Limit — forced conclusion at turn 15 confirmed locally (fast-forwarded a session to turn
      14 via direct DB write, turn 15 correctly forced `concluded: true` regardless of model
      output). The 17th-session-blocked check reuses `featureLimitMonthly`, already proven
      working for AI Interviewer/Resume Builder — not re-tested here, low risk since unchanged.
- [ ] Cost — `ai_usage_log` totals vs. this contract's per-call caps, checked after first real
      staging sessions with a real Gemini key.
- [x] Case-generation failure path — mock Gemini taken down mid-test; session correctly landed
      on `status: 'failed'` within a few polls rather than hanging, confirming no refund logic
      exists to break (matches the no-refund-on-failure design decision above).
