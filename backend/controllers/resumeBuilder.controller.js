/**
 * resumeBuilder.controller.js
 *
 * Two-tier design:
 *   POST /draft  — free, unlimited, no AI. Autosaves the form and returns a
 *                  deterministic completeness percentage (pure field-presence
 *                  math, zero AI cost) so the frontend can animate the live
 *                  progress bar on every keystroke without touching Gemini.
 *   POST /build  — enqueues ONE BullMQ job (Gemini polish + pdfkit render +
 *                  S3 upload). Heavy work never runs in the main API process
 *                  (project non-negotiable) — see resumeBuilder.worker.js.
 *                  Gated at 50/month per student via featureLimitMonthly (see
 *                  resumeBuilder.routes.js) — matches _contracts/07-resume-builder.md.
 *
 * buildId == the BullMQ jobId == the eventual documents.doc_id. The worker is
 * handed this same UUID up front (via the `jobId` queue option) and uses it
 * as the primary key when it inserts the finished row, so /result/:buildId
 * can check job state AND look up the row with one shared identifier — no
 * placeholder "pending" row needs to exist in `documents` while the job runs.
 *
 * NOTE: this feature originally shipped with a third AI endpoint, /analyze
 * (whole-draft score + tips). Removed 2026-07-22 per founder decision — the
 * feature keeps only the deterministic completeness bar (this file's
 * calculateCompleteness, zero AI cost) as its "live scorer", plus the
 * per-field AI Enhance button below. See decisions-log.md.
 */
const crypto = require('crypto');
const { Queue } = require('bullmq');
const AWS = require('aws-sdk');
const { generateText } = require('../services/gemini.service');
// Data only, no side effects — safe to import here. NEVER require the worker
// file itself from a controller; it starts a live BullMQ Worker as a side
// effect of being loaded, which belongs in its own process, not the API's.
const { TEMPLATE_IDS, TEMPLATE_LABELS, DEFAULT_TEMPLATE_ID } = require('../config/resumeTemplates');
// documents is RLS-protected (migrations/20260726_rls_policies.sql) — queries
// against it below go through queryAsCollege with college_id from req.user
// (verified JWT via auth.middleware.js). pool is kept for the ai_usage_log
// insert in enhanceText, which has no RLS policy (fire-and-forget analytics).
const { pool, queryAsCollege } = require('../config/db');

const resumeBuilderQueue = new Queue('resume-builder', { connection: require('../config/redisConnection') });

// signatureVersion: 'v4' is required — ap-south-1 only supports SigV4
// presigned URLs. Without it the SDK falls back to an older signing style
// AWS rejects before CORS is even evaluated, which surfaces in the browser
// as a confusing "No Access-Control-Allow-Origin header" preflight failure
// on the photo-upload PUT, not as a signature error. Matches the working
// s3 client in resumeAnalyzer.controller.js.
const s3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: 'v4' });

const DRAFT_FEATURE = 'resume_builder_draft';
const BUILD_FEATURE = 'resume_builder';

// ── Completeness scoring — deterministic, zero AI cost. This IS the "live
// scorer" — no AI call backs it, so it can run on every keystroke for free.
// Weights match the reference template's own footer checklist (see contract):
// Personal Info 20 (required) · Education 25 (required) · Skills 25 (required)
// · Experience 20 (bonus) · Achievements 10 (bonus). Bar admissions, languages,
// and the profile summary are captured but never scored.
const WEIGHTS = { personal_info: 20, education: 25, skills: 25, experience: 20, achievements: 10 };
const COMPULSORY_SECTIONS = ['personal_info', 'education', 'skills'];

const isFilled = (v) => typeof v === 'string' && v.trim().length > 0;

// Best-effort ratio of required sub-fields filled across all entries in an
// array section (Education / Experience) — picks whichever single entry is
// most complete, so a student doesn't need every entry finished for credit.
const bestEntryRatio = (entries, requiredKeys) => {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let best = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const filledCount = requiredKeys.filter((k) => isFilled(entry[k])).length;
    best = Math.max(best, filledCount / requiredKeys.length);
  }
  return best;
};

const calculateCompleteness = (draft) => {
  const d = draft && typeof draft === 'object' ? draft : {};

  const personalInfoKeys = ['full_name', 'email', 'phone', 'target_field'];
  const personalInfo = d.personal_info && typeof d.personal_info === 'object' ? d.personal_info : {};
  const personalInfoRatio = personalInfoKeys.filter((k) => isFilled(personalInfo[k])).length / personalInfoKeys.length;

  const educationRatio = bestEntryRatio(d.education, ['institution', 'degree', 'year']);
  const experienceRatio = bestEntryRatio(d.experience, ['organization', 'role', 'duration']);

  const skills = d.skills && typeof d.skills === 'object' ? d.skills : {};
  const skillCount = Object.values(skills).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.filter((s) => isFilled(s)).length : 0),
    0
  );
  const skillsRatio = Math.min(skillCount, 3) / 3;

  const achievements = Array.isArray(d.achievements) ? d.achievements.filter((a) => isFilled(a)) : [];
  const achievementsRatio = achievements.length >= 1 ? 1 : 0;

  const scores = {
    personal_info: Math.round(personalInfoRatio * WEIGHTS.personal_info),
    education: Math.round(educationRatio * WEIGHTS.education),
    skills: Math.round(skillsRatio * WEIGHTS.skills),
    experience: Math.round(experienceRatio * WEIGHTS.experience),
    achievements: Math.round(achievementsRatio * WEIGHTS.achievements),
  };
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const canBuild = COMPULSORY_SECTIONS.every((section) => scores[section] === WEIGHTS[section]);

  return { total, ...scores, canBuild };
};

// Normalizes whatever the client sent into the shape we persist. Defensive
// against garbage/wrong-typed input (Stupid Path) — never throws, just drops
// anything malformed to a safe empty default instead of 500ing.
const normalizeDraft = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  return {
    personal_info: b.personal_info && typeof b.personal_info === 'object' ? b.personal_info : {},
    profile_summary: isFilled(b.profile_summary) ? b.profile_summary : '',
    education: Array.isArray(b.education) ? b.education.slice(0, 10) : [],
    experience: Array.isArray(b.experience) ? b.experience.slice(0, 10) : [],
    // Same entry shape as experience; unscored bonus section (like achievements
    // beyond the first) — capped to keep the AI-polish payload bounded.
    volunteer: Array.isArray(b.volunteer) ? b.volunteer.slice(0, 5) : [],
    skills: b.skills && typeof b.skills === 'object' ? b.skills : {},
    achievements: Array.isArray(b.achievements) ? b.achievements.slice(0, 20) : [],
    certifications: Array.isArray(b.certifications) ? b.certifications.slice(0, 15) : [],
    bar_admissions: Array.isArray(b.bar_admissions) ? b.bar_admissions.slice(0, 10) : [],
    languages: Array.isArray(b.languages) ? b.languages.slice(0, 10) : [],
  };
};

// ── POST /draft — autosave, free, unlimited ───────────────────────────────────
// Deliberately does NOT check req.inputFlagged: sanitize.middleware.js flags
// any request body over 2000 chars, but a genuinely filled-out resume draft
// (several education/experience entries, bullets, skills, achievements) will
// legitimately exceed that on completely normal use. Rejecting on that flag
// here would silently break autosave for exactly the well-filled-out resumes
// this feature exists to support (found during this integration — 2026-07-22).
// Real abuse is still bounded by express.json's 10kb body limit (app.js) and
// normalizeDraft's per-section array caps above.
const saveDraft = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const draft = normalizeDraft(req.body);
    const completeness = calculateCompleteness(draft);

    const { rows: existing } = await queryAsCollege(
      college_id,
      'SELECT doc_id FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    const analysisJson = { ...draft, completeness };

    if (existing.length > 0) {
      await queryAsCollege(college_id, 'UPDATE documents SET analysis_json = $1 WHERE doc_id = $2', [analysisJson, existing[0].doc_id]);
    } else {
      await queryAsCollege(
        college_id,
        `INSERT INTO documents (user_id, college_id, feature_name, template_type, s3_key, analysis_json)
         VALUES ($1, $2, $3, 'law_resume_v1', '', $4)`,
        [user_id, college_id, DRAFT_FEATURE, analysisJson]
      );
    }

    // canBuild lives INSIDE `completeness` — must match GET /draft's shape exactly
    // (that endpoint just re-serves the same stored object).
    res.json({
      completeness: {
        total: completeness.total,
        personal_info: completeness.personal_info,
        education: completeness.education,
        experience: completeness.experience,
        skills: completeness.skills,
        achievements: completeness.achievements,
        canBuild: completeness.canBuild,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /draft — resume where the student left off ────────────────────────────
const getDraft = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await queryAsCollege(
      college_id,
      'SELECT analysis_json FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    if (rows.length === 0) return res.json({ draft: null, completeness: calculateCompleteness(null) });

    const { completeness, ...draft } = rows[0].analysis_json;
    res.json({ draft, completeness });
  } catch (err) { next(err); }
};

// ── GET /templates — the whitelist the frontend picker renders from ──────────
const getTemplates = async (_req, res, next) => {
  try {
    res.json({ templates: TEMPLATE_IDS.map((id) => ({ id, label: TEMPLATE_LABELS[id] })), defaultTemplateId: DEFAULT_TEMPLATE_ID });
  } catch (err) { next(err); }
};

// ── POST /build — gated at 50/month via featureLimitMonthly (see routes) ─────
const buildResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;

    // Student picks a template at Build time (not up front) — same saved
    // draft can be rendered into any template without re-entering data.
    const requestedTemplateId = req.body?.template_id;
    if (requestedTemplateId !== undefined && !TEMPLATE_IDS.includes(requestedTemplateId)) {
      return res.status(400).json({ error: 'Unknown template_id.', validTemplateIds: TEMPLATE_IDS });
    }
    const templateId = requestedTemplateId || DEFAULT_TEMPLATE_ID;

    const { rows } = await queryAsCollege(
      college_id,
      'SELECT analysis_json FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No resume details saved yet. Fill out the form before building.' });
    }

    const { completeness, ...draft } = rows[0].analysis_json;
    const freshCompleteness = calculateCompleteness(draft); // never trust a stale stored value — recompute now

    if (!freshCompleteness.canBuild) {
      const missing = COMPULSORY_SECTIONS.filter((s) => freshCompleteness[s] < WEIGHTS[s]);
      return res.status(400).json({ error: 'Compulsory sections incomplete.', missing });
    }

    // ── Duplicate-build guard ────────────────────────────────────────────────
    // Independent of the monthly cap: a fast double-click (Stupid Path) or a
    // stuck frontend firing /build several times would otherwise enqueue
    // several distinct Gemini-polish + PDF-render jobs for the same student —
    // real cost and CPU for zero benefit (only the last result is ever shown),
    // and would burn through the monthly cap for no reason. Each jobId is a
    // fresh UUID, so BullMQ can't dedupe these on its own. Before enqueuing we
    // scan this student's own not-yet-finished jobs; if one is already in
    // flight we return it (202) so the frontend simply keeps polling the build
    // that's already running instead of starting another.
    const pendingJobs = await resumeBuilderQueue.getJobs(['active', 'waiting', 'delayed', 'paused']);
    const existing = pendingJobs.find(
      (j) => j?.data?.user_id === user_id && j?.data?.college_id === college_id
    );
    if (existing) {
      return res.status(202).json({ buildId: existing.id, status: 'processing' });
    }

    const buildId = crypto.randomUUID();
    await resumeBuilderQueue.add(
      'build',
      { doc_id: buildId, user_id, college_id, draft, template_id: templateId },
      { jobId: buildId }
    );

    res.status(202).json({ buildId, status: 'processing' });
  } catch (err) { next(err); }
};

// ── GET /photo-upload-url — presigned S3 PUT for the profile photo ────────────
// Matches the project's own rule that uploads go client → S3 directly, never
// through the API process. The frontend PUTs the raw file straight to this
// URL, then saves the returned photoKey into personal_info.photo_key on the
// next /draft autosave — the worker downloads it from S3 at build time.
const ALLOWED_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png'];
const ALLOWED_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png'];

const getPhotoUploadUrl = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const extRaw = (req.query.ext || 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const ext = ALLOWED_PHOTO_EXTENSIONS.includes(extRaw) ? extRaw : 'jpg';
    const contentType = ALLOWED_PHOTO_CONTENT_TYPES.includes(req.query.contentType) ? req.query.contentType : 'image/jpeg';

    // Fixed key per student (not per-upload) — a re-upload simply overwrites
    // the old photo in S3, so a rebuild always uses the latest one and no
    // orphaned photo objects accumulate per student over time.
    const photoKey = `resume-photos/${college_id}/${user_id}/photo.${ext}`;
    const uploadUrl = s3.getSignedUrl('putObject', {
      Bucket: process.env.S3_BUCKET_FILES,
      Key: photoKey,
      Expires: 120,
      ContentType: contentType,
    });

    res.json({ uploadUrl, photoKey });
  } catch (err) { next(err); }
};

// ── POST /enhance — per-field AI rewrite, no daily limit (founder decision) ──
// The in-form "AI Enhance" button: takes ONE free-text field's current value
// (profile summary, an experience/volunteer bullets box, achievements) and
// returns it rewritten into professional resume phrasing. No Redis gate —
// tightly bounded instead: input capped at 1,500 chars, output at 350
// tokens, one field per call. This is the ONLY unlimited AI surface on this
// feature; /build's internal polish step is gated by the monthly cap, and
// the whole-draft /analyze endpoint that used to sit alongside this was
// removed 2026-07-22 (founder decision — the deterministic completeness bar
// is the only "live scorer", no AI version of it).
const ENHANCE_MAX_INPUT_CHARS = 1500;
const ENHANCE_MAX_OUTPUT_TOKENS = 350;

const buildEnhancePrompt = (text) => (
  'Rewrite this law student resume text into concise, professional, action-verb-led phrasing. ' +
  'HARD RULES: do not invent facts, numbers, dates, employers, statutes, or achievements not present ' +
  'in the input. Preserve every specific the student wrote: statute/regulator names (SEBI, Companies ' +
  'Act 2013, GDPR, IBC) stay verbatim, every number (clients served, team size, memos drafted) stays, ' +
  'moot court levels and roles stay exactly as written. If the input is multiple lines, return the ' +
  'same number of lines or fewer, one polished point per line. ' +
  'Return ONLY valid JSON, no markdown fences: {"enhanced": string}. ' +
  `Input text:\n${text}`
);

const parseEnhanceJson = (text) => {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
};

const enhanceText = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { user_id, college_id } = req.user;

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text.length < 10) {
      return res.status(400).json({ error: 'Write a few words first — then AI Enhance can improve them.' });
    }
    if (text.length > ENHANCE_MAX_INPUT_CHARS) {
      return res.status(400).json({ error: `Text too long to enhance (max ${ENHANCE_MAX_INPUT_CHARS} characters). Split it up.` });
    }

    const { text: rawResponse, tokensIn, tokensOut } = await generateText({
      prompt: buildEnhancePrompt(text),
      maxOutputTokens: ENHANCE_MAX_OUTPUT_TOKENS,
      temperature: 0.35,
    });
    const parsed = parseEnhanceJson(rawResponse);
    const enhanced = typeof parsed.enhanced === 'string' && parsed.enhanced.trim() ? parsed.enhanced.trim() : text;

    // Usage logging is best-effort and must NEVER cost the student a
    // successful AI result — a transient DB hiccup on this INSERT should
    // never turn a perfectly good Gemini result into a 500. Left as plain
    // pool.query: ai_usage_log has no RLS policy (not one of the 5 tables
    // FORCE ROW LEVEL SECURITY was applied to).
    try {
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
         VALUES ($1, $2, 'resume_builder_enhance', $3, $4, $5)`,
        [user_id, college_id, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
      );
    } catch (logErr) {
      console.error('[resume_builder_enhance] ai_usage_log insert failed (non-fatal):', logErr);
    }

    // Every AI-generated response must carry the standard disclaimer
    // (project Security Non-Negotiable).
    res.json({ enhanced, note: 'AI-assisted rewrite for educational purposes only. Verify with a qualified advocate.' });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: 'Could not enhance right now — please try again.' });
    }
    next(err);
  }
};

// ── GET /result/:buildId — poll job + fetch the finished PDF's URL ────────────
const getBuildResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { buildId } = req.params;

    const job = await resumeBuilderQueue.getJob(buildId);
    if (!job) return res.status(404).json({ error: 'Build not found.' });

    // Access Path: this buildId exists, but does it belong to the caller?
    if (job.data.user_id !== user_id || job.data.college_id !== college_id) {
      return res.status(403).json({ error: 'Not authorized to view this build.' });
    }

    const state = await job.getState();

    if (state === 'completed') {
      const { rows } = await queryAsCollege(
        college_id,
        'SELECT s3_key FROM documents WHERE doc_id = $1 AND user_id = $2 AND college_id = $3 AND feature_name = $4',
        [buildId, user_id, college_id, BUILD_FEATURE]
      );
      if (rows.length === 0) {
        // Job flipped to completed a beat before its DB write committed — treat as still processing.
        return res.json({ status: 'processing' });
      }
      // No downloadUrl here (removed 2026-07-22, founder request) — the
      // immediate post-build "Download PDF" button was removed from the
      // frontend, so this endpoint only needs to report job status now.
      // The "My Resumes" history list (GET /history below) still has its
      // own downloadUrl per entry — untouched, unrelated to this endpoint.
      return res.json({ status: 'done' });
    }

    if (state === 'failed') {
      return res.json({ status: 'failed' });
    }

    res.json({ status: 'processing' });
  } catch (err) { next(err); }
};

// ── GET /download — most recent finished resume, no rebuild ───────────────────
const getResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await queryAsCollege(
      college_id,
      `SELECT s3_key FROM documents
       WHERE user_id = $1 AND college_id = $2 AND feature_name = $3
       ORDER BY created_at DESC LIMIT 1`,
      [user_id, college_id, BUILD_FEATURE]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'No resume built yet.' });

    const downloadUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.S3_BUCKET_FILES,
      Key: rows[0].s3_key,
      Expires: 300,
    });
    res.json({ downloadUrl });
  } catch (err) { next(err); }
};

// ── GET /history — a student's last 5 builds, each with its own download URL
// ─────────────────────────────────────────────────────────────────────────
// Every /build enqueues a fresh doc_id and INSERTs a new `documents` row
// (never UPDATEs/overwrites one) — so the full history of every resume a
// student has ever built already exists permanently in S3 and this table;
// nothing is lost if the student clears their own laptop, since the PDF was
// never stored there in the first place. This endpoint just exposes the
// last 5 of that history that already existed. Added 2026-07-22 (founder
// request) — getResume()/'/download' above is unchanged and still serves
// the single most-recent build for anything that only needs "the latest".
const HISTORY_LIMIT = 5;

const getResumeHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await queryAsCollege(
      college_id,
      `SELECT doc_id, template_type, s3_key, created_at FROM documents
       WHERE user_id = $1 AND college_id = $2 AND feature_name = $3
       ORDER BY created_at DESC LIMIT $4`,
      [user_id, college_id, BUILD_FEATURE, HISTORY_LIMIT]
    );

    const history = rows.map((row) => ({
      buildId: row.doc_id,
      templateId: row.template_type,
      templateLabel: TEMPLATE_LABELS[row.template_type] || row.template_type,
      createdAt: row.created_at,
      downloadUrl: s3.getSignedUrl('getObject', {
        Bucket: process.env.S3_BUCKET_FILES,
        Key: row.s3_key,
        Expires: 300,
      }),
    }));

    res.json({ history });
  } catch (err) { next(err); }
};

module.exports = { getTemplates, saveDraft, getDraft, buildResume, getBuildResult, getResume, getResumeHistory, getPhotoUploadUrl, enhanceText };
