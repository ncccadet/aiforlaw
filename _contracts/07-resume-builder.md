# Contract: Resume Builder
**Status:** Done (built + integrated 2026-07-22, pending staging deploy + 5-path test)
**Week:** Week 4, Days 27–28
**Monthly Limit:** 50 builds/month per student (unchanged from the earlier "was 1/day" draft — see decisions-log 2026-07-21). AI Enhance (per-field rewrite) has NO monthly/daily limit — token-capped instead (1,500 input chars / 350 output tokens per call).
**Estimated Cost (350 students):**
- **Build:** one Gemini polish call per build (gemini-3.1-flash-lite, ~1,600 input tokens / 1,400 output tokens cap), capped at 50/student/month → worst case 350 × 50 = 17,500 calls/month. At $0.25/1M in + $1.50/1M out: ~17,500 × (1,600×$0.00000025 + 1,400×$0.0000015) ≈ 17,500 × $0.0025 ≈ **$44/month (~₹3,700/month) worst case**, realistically far lower since students won't all hit the cap.
- **AI Enhance:** uncapped, but tightly bounded per call (≤1,500 input chars ≈ 375 tokens, 350 output tokens) → ~$0.0006/call. Real exposure depends on usage volume — **recalculate after real staging usage data**, same caution as the monthly-limit features' burst-risk note.
- PDF render (pdfkit) + S3 storage: negligible, same as before (no headless browser, runs in the existing worker).

---

## Definition of Done
A logged-in student can fill out the Resume Builder form (autosaving as they type, with a live deterministic completeness bar — no AI cost), click AI Enhance on any free-text field to get a rewritten version, then click Build to enqueue one Gemini-polish + PDF-render job and download the finished PDF from any of 12 templates — gated at 50 builds/month per student via Redis, with `college_id` isolation enforced on every query.

## Ownership
| Role | Owner |
|------|-------|
| Frontend | (built as a complete page this session — see File Ownership Map) |
| Backend | (built as complete controller/routes/worker this session) |

## API Endpoints
| Method | Path | AI? | Limit |
|---|---|---|---|
| GET | /api/resume-builder/templates | No | none |
| GET | /api/resume-builder/photo-upload-url | No | none |
| POST | /api/resume-builder/draft | No | none (autosave) |
| GET | /api/resume-builder/draft | No | none |
| POST | /api/resume-builder/build | Yes (1 Gemini call) | 50/month via `featureLimitMonthly` |
| POST | /api/resume-builder/enhance | Yes (1 Gemini call) | none — 1,500 char in / 350 token out cap |
| GET | /api/resume-builder/result/:buildId | No | none |
| GET | /api/resume-builder/download | No | none |
| GET | /api/resume-builder/history | No | none — returns last 5 builds |

**History/retention:** every `/build` inserts a NEW `documents` row + a new, never-overwritten S3 object (`resumes/{college_id}/{user_id}/{doc_id}.pdf`) — so a student's full build history already exists permanently regardless of what happens on their own device. `/history` (added 2026-07-22, founder request) exposes the last 5 of that history with a fresh presigned download URL for each; `/download` is unchanged and still serves just the single most-recent build for callers that only need "the latest."

**No `/analyze` endpoint.** An earlier draft of this feature included a whole-draft "AI Analyze" button (instant score + tips, separate Gemini call). Removed 2026-07-22 per founder decision — the feature's only "live scorer" is the deterministic completeness bar (pure field-presence math, zero AI cost), not an AI one.

## File Ownership Map
| File | Owner | Done? |
|------|-------|-------|
| `frontend/src/pages/ResumeBuilderPage.jsx` | | [x] |
| `frontend/src/services/resumeBuilder.service.js` | | [x] |
| `backend/routes/resumeBuilder.routes.js` | | [x] |
| `backend/controllers/resumeBuilder.controller.js` | | [x] |
| `backend/workers/resumeBuilder.worker.js` | | [x] |
| `backend/config/resumeTemplates.js` | | [x] |

## DB
Uses the existing `documents` table (no migration needed — `doc_id`, `user_id`, `college_id`, `feature_name`, `template_type`, `s3_key`, `analysis_json`, `created_at` already cover this feature's needs). Two `feature_name` values distinguish rows: `resume_builder_draft` (one row per student, autosaved) and `resume_builder` (one row per finished build). Uses the existing `ai_usage_log` and `error_log` tables — no schema changes.

## Templates
12 pdfkit-rendered templates across 7 structurally distinct layout families (single-column with 5 theme variants, two-column sidebar, executive boxed, banner split, and 3 reference-design recreations) — see `backend/config/resumeTemplates.js` for the whitelist and `backend/workers/resumeBuilder.worker.js` for the render engine. All templates optionally show a student's uploaded photo (client → S3 direct upload, per project rule); none use fake skill-proficiency meters.

## Non-negotiables honored
- college_id isolation on every `documents`/`ai_usage_log` query.
- Photo uploads: client → S3 direct via presigned PUT, never through the API process.
- PDF generation happens in the BullMQ worker, never the main API process.
- Every AI response carries the "For educational purposes only. Verify with a qualified advocate." disclaimer (PDF footer + Enhance response).
- Gemini calls go through the shared `gemini.service.js` native REST client (not the `@google/generative-ai` SDK, not any OpenAI-compatible shim) — matches the project's standing decision on `AQ.`-prefixed key handling.
- No `.env` values hardcoded — `GEMINI_API_KEY`, `GEMINI_MODEL`, `S3_BUCKET_FILES`, `AWS_REGION` all read from `process.env`.

## Pre-Deploy Checklist
- [ ] Normal Path
- [ ] Stupid Path
- [ ] Access Path
- [ ] Limit Path (build cap at 50/month; Enhance's per-call token caps)
- [ ] Cost Path (real Gemini usage on staging before production)
