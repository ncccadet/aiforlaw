/**
 * app.js — Main Express application
 *
 * MIDDLEWARE ORDER (critical — do not change):
 * 1. cors + cookieParser + json body parser
 * 2. rateLimitMiddleware  — stops bots before any logic runs
 * 3. sanitizeMiddleware   — cleans inputs before any feature logic
 * 4. Feature routes
 * 5. errorHandler         — MUST be last; catches everything above
 */
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { Pool } = require('pg');
const { rateLimitMiddleware } = require('./middleware/rateLimit.middleware');
const { sanitizeMiddleware }  = require('./middleware/sanitize.middleware');
const { errorHandler }        = require('./middleware/errorHandler.middleware');
const { authMiddleware }      = require('./middleware/auth.middleware');
const { getDailyUsage, getWeeklyUsage, getMonthlyUsage } = require('./middleware/featureLimit.middleware');

const authRoutes            = require('./routes/auth.routes');
const examPrepRoutes        = require('./routes/examPrep.routes');
const resumeAnalyzerRoutes  = require('./routes/resumeAnalyzer.routes');
const jobBoardRoutes        = require('./routes/jobBoard.routes');
const draftingLabRoutes     = require('./routes/draftingLab.routes');
const courtSimulationRoutes = require('./routes/courtSimulation.routes');
const aiInterviewerRoutes   = require('./routes/aiInterviewer.routes');
const resumeBuilderRoutes   = require('./routes/resumeBuilder.routes');
const lawNewsRoutes         = require('./routes/lawNews.routes');

const app = express();

// Trust exactly one proxy hop (CloudFront, which sits directly in front of
// this EC2 instance — no ALB in this architecture). Without this,
// express-rate-limit refuses to trust the X-Forwarded-For header CloudFront
// sets on every request and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR — but
// worse than the noisy error, its default key generator then falls back to
// req.socket.remoteAddress, which for EVERY real student is CloudFront's own
// edge IP, not the student's. That means the 100 req/min "per IP" limit in
// rateLimit.middleware.js would actually be shared across ALL real students
// hitting the same CloudFront edge — a handful of concurrent students could
// trip each other's rate limit. Found via real browser traffic on
// 2026-07-27, right after the RLS/migration fixes landed. See
// decisions-log.md.
app.set('trust proxy', 1);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://jarvis-ai-staging-frontend.s3.ap-south-1.amazonaws.com',
  'http://jarvis-ai-staging-frontend.s3-website.ap-south-1.amazonaws.com',
  'http://43.205.232.96',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.includes('amazonaws.com')) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(rateLimitMiddleware); // Level 1: 100 req/min per IP
app.use(sanitizeMiddleware);  // Strip HTML, trim, flag large inputs

// Health check — no auth, used by UptimeRobot and ALB
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// GET /api/dashboard/summary — feeds DashboardPage.jsx's feature grid.
// Kept inline here rather than its own controller/route file on purpose —
// this is a thin read-only aggregation over data that already lives behind
// other features' own endpoints, not a new feature with its own contract.
//
// Caps below are read straight from each route file's own featureLimit(...)
// call (backend/routes/*.routes.js) — NOT re-declared from memory — so this
// can't silently drift from what actually gates a request:
//   drafting_lab      3/day     (draftingLab.routes.js, /case-study only — v3 combined
//                     Step2+3 exercise; reverted from the v2-era 50/month back to the
//                     founder-confirmed 3/day, 2026-07-23)
//   resume_builder    50/month  (resumeBuilder.routes.js — was 1/day)
//   court_simulation  16/month  (courtSimulation.routes.js — was 4/week)
//   ai_interviewer    16/month  (aiInterviewer.routes.js — was 4/week)
//   exam_prep, job_board, law_news, resume_analyzer — no per-student AI limit
//   → cap: null (resume_analyzer's /analyze route carries no featureLimit —
//   contract-confirmed UNLIMITED, see _contracts/02-resume-analyzer.md)
// ssl: rejectUnauthorized:false — matches auth.controller.js's pool (the one
// proven working on staging). RDS enforces/prefers SSL; without this option
// pg's connection attempt fails and every query on this pool throws before
// it ever runs, surfacing as a 500 here.
// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const dashboardPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const DASHBOARD_FEATURES = [
  // cap set 2026-07-28 (contract v3): Exam Prep is now live-AI, full-format and
  // timed, so it is ai:true with a hard MONTHLY limit — not per day. Students
  // revise in bursts before an exam, so a daily cap would be useless to them.
  //
  // Exam Prep is the only feature with TWO counters: 25 AIBE + 25 SPPU, gated
  // separately in examPrep.routes.js. `redisNames` (plural) sums them for this
  // one card, because the dashboard has room for a single usage bar per
  // feature. The bar therefore reads "n of 50 used this month" while the real
  // gate is 25 + 25 — the page itself shows the two numbers separately, which
  // is where a student who has exhausted one but not the other will look.
  { key: 'exam-prep',        name: 'Exam Prep',        path: '/exam-prep',        ai: true,  blurb: 'Full AIBE and university papers, timed and auto-graded. 25 Bar + 25 university a month.', cap: { max: 50, unit: 'month', redisNames: ['exam_prep_aibe', 'exam_prep_sppu'], window: 'monthly' } },
  // cap corrected 2026-07-22: this entry previously said 50/month, which
  // matched an earlier (2026-07-21) revision decision — but the actual
  // contract (_contracts/02-resume-analyzer.md, written the same day) settled
  // on UNLIMITED, and resumeAnalyzer.routes.js's /analyze route carries no
  // featureLimit middleware. This dashboard entry was drifting from what the
  // route actually enforces; fixed to match (contract wins per project rule).
  { key: 'resume-analyzer',  name: 'Resume Analyzer',  path: '/resume-analyzer',  ai: true,  blurb: 'Upload your resume and get a structured, section-wise review.', cap: null },
  { key: 'job-board',        name: 'Job Board',        path: '/jobs',             ai: false, blurb: 'Openings from courts, legal aid bodies and placement cells.', cap: null },
  { key: 'drafting-lab',     name: 'Drafting Lab',     path: '/drafting-lab',     ai: true,  blurb: 'Learn real Delhi & Maharashtra formats, then draft and get scored. 50 exercises a month.', cap: { max: 50, unit: 'month', redisName: 'drafting_lab', window: 'monthly' } },
  { key: 'court-simulation', name: 'Court Simulation', path: '/court-simulation', ai: true,  blurb: 'Argue a live case (up to 15 turns) against an AI bench and opposing counsel.', cap: { max: 16, unit: 'month', redisName: 'court_simulation', window: 'monthly' } },
  { key: 'ai-interviewer',   name: 'AI Interviewer',   path: '/ai-interviewer',   ai: true,  blurb: 'A spoken mock interview, question by question, at your pace.', cap: { max: 16, unit: 'month', redisName: 'ai_interviewer', window: 'monthly' } },
  // ai flipped false -> true 2026-07-22: /build now runs one Gemini polish
  // call per PDF (gated by the same 50/month cap below) and the form's AI
  // Enhance button calls Gemini per field (no Redis gate — token-capped in
  // the controller instead). No AI Analyze endpoint (removed, founder
  // decision) — the completeness bar shown in-app is deterministic, zero cost.
  { key: 'resume-builder',   name: 'Resume Builder',   path: '/resume-builder',   ai: true,  blurb: 'A guided form with AI-assisted polish that outputs a clean, formal PDF.', cap: { max: 50, unit: 'month', redisName: 'resume_builder', window: 'monthly' } },
  { key: 'law-news',         name: 'Law News',         path: '/law-news',         ai: false, blurb: 'Real cases, amendments & legal updates, refreshed daily from across the web.', cap: null },
];

app.get('/api/dashboard/summary', authMiddleware, async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;

    const { rows } = await dashboardPool.query(
      `SELECT u.email, c.name AS college_name
       FROM users u JOIN colleges c ON c.college_id = u.college_id
       WHERE u.user_id = $1`,
      [user_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const { email, college_name } = rows[0];

    const features = await Promise.all(DASHBOARD_FEATURES.map(async (f) => {
      if (!f.cap) return { key: f.key, name: f.name, path: f.path, ai: f.ai, blurb: f.blurb, cap: null, comingSoon: !!f.comingSoon };
      // A feature may be gated by more than one counter (Exam Prep: 15 AIBE +
      // 15 SPPU). Normalise to a list so the single-counter case stays a
      // one-element list rather than a separate code path.
      const names = f.cap.redisNames || [f.cap.redisName];
      const counts = await Promise.all(names.map((n) => (
        f.cap.window === 'monthly'
          ? getMonthlyUsage(user_id, college_id, n)
          : f.cap.window === 'weekly'
            ? getWeeklyUsage(user_id, college_id, n)
            : getDailyUsage(user_id, n)
      )));
      const used = counts.reduce((a, b) => a + (b || 0), 0);
      return { key: f.key, name: f.name, path: f.path, ai: f.ai, blurb: f.blurb, cap: { used: Math.min(used, f.cap.max), max: f.cap.max, unit: f.cap.unit } };
    }));

    res.json({
      // users has no `name` column — derive a display name from the email's
      // local part rather than inventing one. Not stored anywhere as fact,
      // display-only.
      student: {
        name: email.split('@')[0].split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        college: college_name,
      },
      features,
    });
  } catch (err) { next(err); }
});

app.use('/api/auth',             authRoutes);
app.use('/api/exam',             examPrepRoutes);
app.use('/api/resume-analyzer',  resumeAnalyzerRoutes);
app.use('/api/jobs',             jobBoardRoutes);
app.use('/api/drafting-lab',     draftingLabRoutes);
app.use('/api/court-simulation', courtSimulationRoutes);
app.use('/api/ai-interviewer',   aiInterviewerRoutes);
app.use('/api/resume-builder',   resumeBuilderRoutes);
app.use('/api/law-news',         lawNewsRoutes);

app.use(errorHandler); // MUST be last

// Start background BullMQ workers in app.js so every deployment automatically runs all feature workers
if (process.env.NODE_ENV !== 'test') {
  try {
    require('./workers/courtSimulation.worker');
    require('./workers/aiInterviewer.worker');
    require('./workers/draftingLab.worker');
    require('./workers/resumeAnalyzer.worker');
    require('./workers/resumeBuilder.worker');
    console.log('[app] Background workers initialized successfully');
  } catch (err) {
    console.error('[app] Worker initialization note:', err.message);
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Voxera backend on port ${PORT}`));
module.exports = app;
