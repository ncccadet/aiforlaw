# Contract: Resume Analyzer
**Status:** Done (built + integrated 2026-07-22 from founder-provided zip, adapted to fit architecture — pending staging deploy + 5-path test)
**Week:** Week 2, Days 12–13
**Daily Limit:** UNLIMITED (no per-student daily cap — founder decision 2026-07-21)
**Model:** `gemini-3.1-flash-lite` (Google) — one call per analysis, via the shared `gemini.service.js` native REST client
**Estimated Cost (350 students):** ~₹0.27 per analysis · uncapped monthly (see Cost Calculation & risk note)

---

## Definition of Done
> A logged-in student uploads a **PDF résumé (1–3 pages)** → it lands in S3 directly (never through the API) → a BullMQ worker validates it is a real, text-based résumé, extracts the text, makes ONE token-capped Gemini call, and stores structured feedback across **7 parameters** in the `documents` table → the student sees their scored feedback with the educational disclaimer, viewable anytime from history, all scoped to their own `college_id`. Non-résumé files, image-only PDFs, and documents over 3 pages are rejected with a clear message. The student can also download a styled PDF report of the analysis.

## Ownership
| Role | Owner |
|------|-------|
| Frontend | Founder (provided as a complete build; adapted 2026-07-22) |
| Backend | Founder (provided as a complete build; adapted 2026-07-22) |

## Daily AI Limit
- Max per student per day: **UNLIMITED** — `POST /analyze` carries **no** `featureLimit` middleware.
- Backstops that remain: global `rateLimitMiddleware` (100 req/min/IP) + every call logged to `ai_usage_log` for the daily cost review.
- **Cost risk (acknowledged):** with no per-student cap, monthly AI cost is unbounded. The route is written so `featureLimit('resume_analyzer', N)` can be re-added in one line if abuse appears.
- `app.js`'s dashboard `DASHBOARD_FEATURES` entry was found drifting from this (previously listed a 50/month cap left over from an earlier, superseded revision) — corrected 2026-07-22 to `cap: null` to match what the route actually enforces.

## Upload Validation (nothing but a résumé gets analyzed)
| Check | Where | Rule |
|-------|-------|------|
| File type | Client + Worker | Must be `application/pdf`; worker verifies the `%PDF` magic bytes (renamed `.exe`/`.jpg` rejected) |
| Sanitization / malware | Worker | Lightweight structural scan (no ClamAV daemon — founder decision, t3.micro/t3.small headroom): rejects any PDF containing `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, or `/RichMedia` markers, before parsing or sending anywhere |
| Page count | Worker (`extractPdfText`'s page count) | **1–3 pages**; 0 or >3 → rejected |
| Extractable text | Worker | Must contain real text (image-only/scanned PDFs with ~no text → rejected) |
| Is it a résumé? | Worker heuristic **+** model self-check | Résumé-signal keyword gate, then Gemini returns `isResume:false` for anything that is not a CV/résumé → rejected before scoring is shown |
| File size | Client | 10 KB – 5 MB |

## Token Limits
| Direction | Max Tokens | How it is enforced (never "ask the model nicely") |
|-----------|------------|----------------------------------------------------|
| Input | **3000** (PDF text) | Worker truncates extracted text to ~3000 tokens (~12000 chars) BEFORE the call; system prompt adds ~350 more |
| Output | **1500** | Passed as a real `maxOutputTokens: 1500` API parameter |

## The 7 Analysis Parameters (fixed set — the model must return exactly these seven)
1. **Structure & Formatting** — layout, length, consistency, ATS-friendliness
2. **Contact & Online Presence** — email/phone, LinkedIn, no unprofessional handles
3. **Education & Academic Record** — degree, marks/CGPA, publications, certifications
4. **Legal Experience & Internships** — internships under advocates/firms, moots, clerkships, legal-aid
5. **Skills & Competencies** — legal research, drafting, languages, tools (Manupatra/SCC Online)
6. **Achievements & Impact** — quantified results, action verbs, positions of responsibility
7. **Language, Grammar & Clarity** — spelling, tense consistency, concision, no fluff

Each parameter returns a `score` (0–100), `strengths[]`, and `improvements[]`. Worker also computes an `overallScore`.

## Key Design Decisions
1. **Polling by `doc_id`.** `POST /analyze` inserts a `documents` row (`analysis_json = NULL`, `status = 'pending'`), enqueues the job with that `doc_id`, returns `docId`. Worker UPDATEs the same row. Ownership check is `WHERE doc_id = $1 AND user_id = $2 AND college_id = $3`. Poll route is `/result/:docId`.
2. **New `status` column on `documents`** (`pending | complete | failed`) via migration `20260722_resume_analyzer_documents_status.sql` (DEFAULT `'complete'`, a no-op for every other `feature_name`); `schema.sql` updated in the same change.
3. **S3 direct upload** via presigned `PUT` (AWS SDK v2), 60 s expiry, key `resumes/{college_id}/{user_id}/{uuid}.pdf`, `ContentType: application/pdf`. Controller rejects any `s3Key` not under the caller's own prefix (Access Path).
4. **Gemini calls go through `gemini.service.js`** (the shared native REST client), not the founder-provided zip's `@google/generative-ai` SDK — same reasoning as every other AI feature in this codebase: avoids the SDK-shim class of `AQ.`-prefixed-key auth failures (see decisions-log, 2026-07-21). The zip's model id also had a typo (`gemini-3-1-flash-lite`); corrected to the real, verified-working `gemini-3.1-flash-lite`.
5. **PDF text extraction uses `pdfjs-dist` directly, not `pdf-parse`.** Testing found `pdf-parse`'s bundled pdf.js build (v1.10.100, ~2017) threw "bad XRef entry" on completely standard, valid PDFs from two different generators (pdfkit, ReportLab) — verified with `pdfinfo`/`pdftotext` that the files themselves were valid. `pdfjs-dist` (Mozilla's actively-maintained pdf.js) parsed every test file correctly. Same job (page count + text), no behavior change to the rest of the pipeline.
6. **Downloadable PDF report** (founder request, 2026-07-22): the worker renders a report PDF (pdfkit) styled to match this feature's own dark theme (black background, serif font, same button/border language as the on-screen results — NOT Resume Builder's paper-résumé theme, since this is a feedback report, not a résumé to print/hand to an employer). Stored in S3 at `resume-analyses/{college_id}/{user_id}/{docId}.pdf`, referenced via `analysis_json.reportS3Key` (never exposed directly to the client — `GET /report/:docId` hands out a fresh presigned URL). Report generation is best-effort: a rendering failure never fails the underlying analysis.
7. **New backend deps:** `pdfjs-dist`, `pdfkit` (already present). `ioredis` remains a transitive dependency via `bullmq`. No `@google/generative-ai` and no `pdf-parse` — deliberately not added, per points 4–5 above.
8. **Disclaimer** on every result and every report PDF: *"For educational purposes only. Verify with a qualified advocate."*

## API Endpoints
All routes behind `authMiddleware`. Base path: `/api/resume-analyzer`.

### GET /api/resume-analyzer/upload-url
**Response:** `{ "uploadUrl": "https://...", "s3Key": "resumes/{college_id}/{user_id}/{uuid}.pdf" }` · **Errors:** `401`, `500`

### POST /api/resume-analyzer/analyze
**Request:** `{ "s3Key": "resumes/{college_id}/{user_id}/{uuid}.pdf" }`
**Response:** `{ "docId": "uuid", "status": "pending" }` · **Errors:** `400` foreign/invalid s3Key, `401`, `500`

### GET /api/resume-analyzer/result/:docId
**Response (pending):** `{ "status": "pending", "result": null }`
**Response (failed):** `{ "status": "failed", "result": null, "message": "..." }`
**Response (complete):** `{ "status": "complete", "result": { "overallScore": 0-100, "summary": "...", "parameters": [ { "name": "...", "score": 0-100, "strengths": ["..."], "improvements": ["..."] } x7 ], "disclaimer": "..." } }` — note: `reportS3Key` is stripped from this response; it's internal-only.
**Errors:** `401`, `404` not owned by this student+college, `500`

### GET /api/resume-analyzer/history
**Response:** `{ "history": [ { "docId": "uuid", "status": "...", "overallScore": 0-100, "created_at": "ISO" } ] }` · **Errors:** `401`, `500`

### GET /api/resume-analyzer/report/:docId
**Added 2026-07-22** (founder request: downloadable PDF of the analysis).
**Response:** `{ "downloadUrl": "https://... (presigned, 5 min expiry)" }` · **Errors:** `401`, `404` not owned by this student+college OR no report was generated for this analysis, `500`

## File Ownership Map
| File | Owner | Done? |
|------|-------|-------|
| `frontend/src/pages/ResumeAnalyzerPage.jsx` | Founder-provided, adapted (added Download PDF button) | [x] |
| `frontend/src/services/resumeAnalyzer.service.js` | Founder-provided, adapted (added `getReportUrl`) | [x] |
| `backend/routes/resumeAnalyzer.routes.js` | Founder-provided, adapted (added `/report/:docId`) | [x] |
| `backend/controllers/resumeAnalyzer.controller.js` | Founder-provided, adapted (added `getReportUrl`, stripped `reportS3Key` from `/result`) | [x] |
| `backend/workers/resumeAnalyzer.worker.js` | Founder-provided, adapted (Gemini SDK→native REST, model id fix, `pdf-parse`→`pdfjs-dist`, malware-signal check, PDF report rendering) | [x] |
| `backend/models/migrations/20260722_resume_analyzer_documents_status.sql` | New (this session) | [x] |
| `backend/models/schema.sql` (add `status` to `documents`) | Updated (this session) | [x] |
| `backend/package.json` (add `pdfjs-dist`; NOT `pdf-parse`/`@google/generative-ai`) | Updated (this session) | [x] |
| `backend/app.js` (dashboard cap fixed to `null`; DASHBOARD_FEATURES comment corrected) | Updated (this session) | [x] |
| `frontend/src/pages/DashboardPage.jsx` (nav link) | Already present from an earlier step | [x] |

## Database Tables Used
- **`documents`** — READ/WRITE: `doc_id`, `user_id`, `college_id`, `feature_name='resume_analyzer'`, `s3_key`, `analysis_json` (includes `reportS3Key`, internal-only), `status`, `created_at`. Every query filters `college_id` + `user_id`.
- **`ai_usage_log`** — WRITE: `{ user_id, college_id, feature_name='resume_analyzer', model, tokens_in, tokens_out }` per call.
- **`error_log`** — WRITE via `errorHandler`.

## Cost Calculation
Per analysis: ~3350 input tokens (3000 PDF + ~350 prompt) + 1500 output tokens.
- Input: 3350 × $0.25 / 1,000,000 = $0.00084
- Output: 1500 × $1.50 / 1,000,000 = $0.00225
- **≈ $0.0031 ≈ ₹0.27 per analysis** (₹86/USD; `gemini-3.1-flash-lite` $0.25/1M in, $1.50/1M out)

No daily cap → **monthly cost = ₹0.27 × total analyses**, unbounded. Reference points: 350 students × 5/month ≈ ₹470/month; × 30/month ≈ ₹2,800/month. Watch `ai_usage_log` daily during the first two weeks against the ₹20,000 alert.

## Pre-Build Checklist
- [x] Founder specified requirements (2026-07-21, refined 2026-07-22 with the zip + voice notes)
- [x] Definition of Done written
- [x] Limit decision: unlimited (logged in decisions-log)
- [x] Token caps set (3000 in / 1500 out) enforced as real parameters
- [x] Sanitization approach decided (lightweight structural check, not ClamAV — founder choice)
- [x] Downloadable PDF report approach decided (server-rendered pdfkit, not client print — founder choice)

## Pre-Deploy Checklist (5-Path Test — STAGING, two fake colleges)
- [ ] **Normal Path** — 2-page PDF résumé → 7-parameter feedback + disclaimer + working Download PDF button; refresh re-fetches cached result (no new `ai_usage_log` row).
- [ ] **Stupid Path** — empty upload; `.jpg`/`.exe` renamed `.pdf`; 6-page PDF; image-only scan; a non-résumé PDF (e.g. an invoice); a PDF with embedded JavaScript/launch actions → each rejected with a clear `status='failed'` message, no crash.
- [ ] **Access Path** — College A student requests College B `docId` (both `/result/:docId` and `/report/:docId`) → `404`; POST an `s3Key` under another student's prefix → `400`.
- [ ] **Limit Path** — confirm unlimited: run 5 analyses back-to-back, all succeed (no `429`); global IP limiter still guards floods.
- [ ] **Cost Path** — `ai_usage_log` token totals ≈ 3350 in / ≤1500 out per call and match the Gemini dashboard.

Local verification already done this session (sandboxed Postgres + Redis + mocked S3/Gemini): all 7 pipeline scenarios pass (good résumé → complete; too many pages / no text / non-résumé / malicious / fake-PDF → failed with correct messages; cross-college access blocked), the report PDF renders correctly (validated via `pdfinfo`/`pdftotext`/`pdftoppm` — an overlap bug between the score number and summary text, a missing-glyph bug with the "→" arrow character, and a wasted blank extra page on multi-page reports were all found and fixed during this testing). Staging is still the first environment with the real Gemini key, real S3, and real Postgres/Redis.
