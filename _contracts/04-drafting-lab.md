# Contract: Drafting Lab (v3 — three-step learning flow, locked 2026-07-23)
**Status:** Draft — locked in conversation with founder, awaiting co-founder sign-off before code ships to staging
**Week:** Week 3
**Daily Limit:** 3/day — applies ONLY to Step 2+3 (AI case generation + AI scoring, one combined exercise). Step 1 (View & Learn) is unlimited, no AI, zero cost.
**Model:** `gemini-3.1-flash-lite` via the shared `backend/services/gemini.service.js` native REST client (never the `@google/generative-ai` SDK — see that file's header for why)
**Estimated Cost (350 students):** ~₹0.30 per completed exercise (2 Gemini calls) · worst case 350 × 3/day × 30 = 31,500 exercises/month ≈ **₹9,450/month**. Typical usage far lower — watch `ai_usage_log` against the ₹20,000 monthly alert.

---

## v3 — what changed and why (2026-07-23)
This replaces the v2 three-mode design (View / deterministic Practice / AI Case-Study-with-model-draft) with a three-**step** learning flow the founder designed directly. The old modes are gone, not layered on top of:

- **Dropped:** Mode 2's deterministic fill-blank-and-check-against-hidden-answer-key. Reason: the new flow's Step 3 (AI-judged structured drafting) fully replaces it — simpler to build, no answer-key content needed from founders, no "never send `answer_key` to the browser" cheating risk to guard against.
- **Dropped:** Mode 3's "AI generates a model draft to compare against." Reason (founder's call, and the right one): there is rarely one single "correct" legal draft, so a model-draft comparison invites copying rather than learning. A scored, lawyer-style critique teaches more than a diff against one AI's version of "correct."
- **Added:** Step 1 is no longer a flat "here's the template text" — it's real, sourced, multi-state specimens (Delhi + Maharashtra) PLUS a founder-authored "anatomy" explainer per draft type (what are this document's fixed parts and why), PLUS direct links to the original sources. See `backend/data/draftLibrary.data.js` for the compiled content (sourced 2026-07-23; every specimen is labeled with a confidence rating — HIGH / MODERATE / GENERIC FALLBACK — since not everything found was equally verifiable; nothing was invented to fill a gap).
- **Added:** Step 2's drafting environment is fixed, labeled fields (reusing Resume Builder's proven section-by-section UI pattern) rather than either a single free-text box or a new rich-text editor — deliberately not building a "Word-like editor," which would be a lot of new surface area for something that doesn't need it.
- **States covered:** Delhi + Maharashtra only for now (founder's explicit choice) — content is data-driven in `draftLibrary.data.js`, so adding a third state later is a content change, not a code change.

## The Three Steps
- **Step 1 — View & Learn (no AI, unlimited, $0):** student browses the 5 draft types; for each, sees real Delhi + Maharashtra specimens side by side, a structural "anatomy" breakdown (the fixed parts every draft of this type needs — e.g. cause title, parties, prayer, verification), and links to the original court/government sources.
- **Step 2 — Guided drafting practice (AI call #1):** student picks a draft type (+ difficulty), one Gemini call generates a fresh fact scenario, then the student fills it in through fixed labeled fields specific to that draft type (not one big free-text box) — the fields assemble into the final draft text server-side, the same `{{blank}}`-substitution approach the founder-provided zip already used for template rendering.
- **Step 3 — AI feedback (AI call #2, no model draft):** the assembled draft is scored like a senior advocate (15-20 years' experience framing) would critique a junior's first attempt: structural completeness, legal accuracy (current-law citations — BNSS/BNS/BSA, not CrPC/IPC/Evidence Act), clarity/drafting language, an overall score, a strengths list, and a concrete improvements list. No side-by-side model draft.

## Definition of Done
A student can (a) browse all 5 draft types' real Delhi + Maharashtra specimens and anatomy explainers with zero AI cost, (b) generate an AI case and fill it in through guided fields, and (c) get a scored, lawyer-style critique — one combined exercise per slot, 3/day, `college_id`-scoped throughout, with the educational disclaimer on every AI output.

## Token Limits (real API params)
| Call | Input cap | Output cap |
|------|-----------|------------|
| Call 1 — generate case | filters + system prompt (small) | **800** |
| Call 2 — score the assembled draft | the student's full draft, capped at **~3,500 tokens (~14,000 chars)** as a cost/abuse guard — far more than any real draft of these 5 types would ever need; anything longer is **rejected before enqueue/billing**, not silently truncated | **1,200** (≈600 words) |

## The 5 Draft Types (unchanged from v1/v2 scope)
`bail_application`, `anticipatory_bail`, `vakalatnama`, `legal_notice`, `affidavit` — the founder-provided zip's content for these 5 is the Step-2 template/blanks base; Step 1's library is new, separate content (see below).

## Step 1 Content Source — `backend/data/draftLibrary.data.js`
Hardcoded, founder-reviewable JS content (NOT database-driven) — a deliberate simplification vs the v1 ambition of a fully DB-driven template library: this is a small, fixed set (5 types × 2 states) unlikely to need frequent updates without a deploy, and the founder-provided zip's own templates already use this same hardcoded-in-code pattern. Revisit as DB-driven only if the type/state count grows significantly. Each entry:
```js
{
  template_type: 'vakalatnama',
  anatomy: [ { part: 'Cause title', why: '...' }, /* ... */ ],   // founder-authored, no AI
  specimens: {
    delhi: { confidence: 'HIGH', text: '...', sourceUrl: '...', sourceLabel: '...' },
    maharashtra: { confidence: 'GENERIC_FALLBACK', text: '...', sourceUrl: '...', sourceLabel: '...', note: 'why this is a fallback' },
  },
}
```
Confidence ratings sourced 2026-07-23 (web research, see `_decisions/decisions-log.md`): Delhi Vakalatnama = HIGH (official, full verbatim text); Maharashtra Vakalatnama = GENERIC_FALLBACK (official Bombay HC Form No. 5 is a scanned, non-OCR'able PDF — substituted with the standard Maharashtra/eCourts practice equivalent, clearly labeled as not certified identical to Form No. 5); both Affidavit specimens = HIGH (real Bombay HC OOCJ affidavits + real Delhi HC filed affidavit); both Bail Application specimens = MODERATE/MODERATE-HIGH (real court-anchored practice-course material, cites pre-BNSS CrPC numbering); both Anticipatory Bail specimens = MODERATE/MODERATE-HIGH (same caveat); Delhi Legal Notice = MODERATE-HIGH (real advocate/chamber address); Maharashtra Legal Notice = GENERIC_FALLBACK (confirmed no Maharashtra-specific specimen exists publicly — legal notices carry no court-prescribed or meaningfully state-specific format anywhere in India).

## API Endpoints
All routes behind `authMiddleware`. Base path `/api/drafting-lab`.

| Method | Path | AI? | Notes |
|---|---|---|---|
| GET  | /library | No | Step 1 content — all 5 types' anatomy + Delhi/Maharashtra specimens + source links |
| GET  | /options | No | draft types + difficulty for Step 2 |
| POST | /case-study | Yes (3/day) | body `{ template_type, difficulty }` → generates case (worker) → `{ docId, status:'preparing' }` |
| GET  | /case-study/result/:docId | No (poll) | → case facts + the fixed fields to fill for this template_type |
| POST | /case-study/submit | Yes (worker, Call 2) | body `{ doc_id, fields: {field_id: text} }` → assembles the draft server-side, enqueues scoring; rejects oversized assembled draft BEFORE billing |
| GET  | /case-study/score/:docId | No (poll) | → `{ score, structuralCompleteness, legalAccuracy, clarity, strengths[], improvements[], disclaimer }` |
| GET  | /history | No | student's past exercises (metadata) |

## Database Tables Used
- **`documents`** — `feature_name='drafting_lab_case'`; `analysis_json` holds `{template_type, difficulty, case, fields}` then `{score, structuralCompleteness, legalAccuracy, clarity, strengths, improvements}`; `status` (preparing|active|scoring|complete|failed). Every query filters `user_id` + `college_id`.
- **`ai_usage_log`** — one row per Gemini call → exactly 2 per completed exercise.
- No `draft_templates` table, no `answer_key`, no `prompt_versions` DB dependency for Step 1 — content lives in `draftLibrary.data.js` per the simplification above. `prompt_versions` may still back the two Gemini prompts if the project wants no-deploy prompt rollback (matches the pattern used elsewhere); TBD at build time.

## Files
| File | Owner | Done? |
|------|-------|-------|
| `frontend/src/pages/DraftingLabPage.jsx` | | [x] — Learn tab (Step 1) + Practice tab (Steps 2-3), built 2026-07-23 |
| `frontend/src/services/draftingLab.service.js` | | [x] |
| `backend/routes/draftingLab.routes.js` | | [x] |
| `backend/controllers/draftingLab.controller.js` | | [x] |
| `backend/workers/draftingLab.worker.js` | | [x] — SDK/model-id bugs fixed, no-refund-on-failure (matches Court Sim/AI Interviewer) |
| `backend/data/draftLibrary.data.js` (NEW — Step 1 content) | | [x] — real, sourced, confidence-labeled content for all 5 types x 2 states, compiled 2026-07-23 |
| `backend/models/migrations/20260723_drafting_lab_v3.sql` (NEW) | | [x] — adds `case_data`/`submission` to `sessions` |
| `backend/scripts/seedDraftLibraryPdfs.js` (NEW) | | [x] written; **not yet run** — needs to be run on staging/production (real internet + real AWS creds), see decisions-log 2026-07-23 |

## Pre-Deploy Checklist (5-Path Test — staging, two fake colleges)
Passed once already in a disposable local Postgres+Redis (mocked Gemini only) on 2026-07-23 — see decisions-log for details. Still needs a REAL run on staging with two fake colleges before production:
- [ ] **Normal** — browse Step 1 for all 5 types; complete one full Step 2→3 cycle per type; score + feedback renders with disclaimer.
- [ ] **Stupid** — empty fields, a 20,000-word paste into a field (rejected before billing), double-submit the same case, gibberish input.
- [ ] **Access** — poll another student's `docId` → 404; college_id isolation on every `sessions` query.
- [ ] **Limit** — 4th case-study of the day → 429; a failed generation/scoring call does not cost the daily slot (confirmed: no refund logic, matches Court Simulation's pattern).
- [ ] **Cost** — `ai_usage_log` shows exactly 2 calls per completed exercise, both within their token caps.
- [ ] **PDFs** — run `backend/scripts/seedDraftLibraryPdfs.js` against the real bucket, then confirm `/library`'s `pdfUrl`s actually open the right documents.
