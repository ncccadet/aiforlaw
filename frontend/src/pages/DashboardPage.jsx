// =====================================================================
// DashboardPage.jsx — Law AI student dashboard
// Theme  : charcoal / graphite / bone-grey, serif-led editorial look
// Fonts  : "Cormorant Garamond" (display) + "Lora" (body) via Google
//          Fonts, with Georgia/serif fallbacks if the CDN is blocked.
// Deps   : react, react-router-dom (already in the VFL stack).
//          No Tailwind, no UI library — styles are embedded so this
//          file drops in without touching the build config.
// Route  : mounted at "/" (see App.jsx) — the app's existing convention,
//          not "/dashboard".
//
// Backend: GET /api/dashboard/summary (backend/app.js — kept inline there
// rather than its own controller/route file, since it's a thin read-only
// aggregation over other features' own data, not a new feature with its
// own contract). Verified end-to-end against a real Postgres+Redis: login,
// 401-without-cookie, and real usage counts all checked before this went up.
// =====================================================================

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

const DASHBOARD_ENDPOINT = '/api/dashboard/summary';

// Static shell used only to render blurbs/order/paths instantly while the
// real usage numbers load — never used as a substitute for live cap data.
// If the API's `features` array is missing an entry, this blurb/path is
// the fallback so a partial API response doesn't break the whole card.
// Paths match App.jsx's actual routes exactly (job-board's real route is
// /jobs, not /job-board — checked against App.jsx, not guessed).
const FEATURE_META = {
  'exam-prep': { id: '01', name: 'Exam Prep', path: '/exam-prep', ai: false, blurb: 'Practice MCQs and long-form answers built from your syllabus.' },
  'resume-analyzer': { id: '02', name: 'Resume Analyzer', path: '/resume-analyzer', ai: true, blurb: 'Upload your resume and get a structured, section-wise review.' },
  'job-board': { id: '03', name: 'Job Board', path: '/jobs', ai: false, blurb: 'Openings from courts, legal aid bodies and placement cells.' },
  'drafting-lab': { id: '04', name: 'Drafting Lab', path: '/drafting-lab', ai: true, blurb: 'Study templates, practice fill-ins, and draft from case studies.' },
  'court-simulation': { id: '05', name: 'Court Simulation', path: '/court-simulation', ai: true, blurb: 'Argue a structured 8-turn matter against an AI bench.' },
  'ai-interviewer': { id: '06', name: 'AI Interviewer', path: '/ai-interviewer', ai: true, blurb: 'A spoken mock interview, question by question, at your pace.' },
  'resume-builder': { id: '07', name: 'Resume Builder', path: '/resume-builder', ai: false, blurb: 'A guided 20-section form that outputs a clean, formal PDF.' },
  'law-news': { id: '08', name: 'Law News', path: '/law-news', ai: false, blurb: 'Real cases, amendments & legal updates, refreshed daily from across the web.' },
};
const FEATURE_ORDER = Object.keys(FEATURE_META);

/**
 * Features held back from students regardless of what the API reports.
 *
 * resume-analyzer (2026-07-29): the browser's direct-to-S3 upload is being
 * refused before it reaches our API, so every student sees a failed upload.
 * Founder decision during the pilot: show it as "Coming soon" rather than let
 * students hit a broken feature. Remove the key here once the upload works —
 * no other change is needed, the feature itself is untouched.
 */
const FORCED_COMING_SOON = new Set(['resume-analyzer']);

// Greeting keyed to IST hours — the whole cohort is in one timezone.
function greetingForNow() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage() {
  const navigate = useNavigate();

  // status: "loading" | "ready" | "error"
  const [status, setStatus] = useState('loading');
  const [student, setStudent] = useState(null);
  const [features, setFeatures] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');

  // Staggered card entrance, only once data is actually on screen.
  const [mounted, setMounted] = useState(false);

  const loadDashboard = useCallback(async (signal) => {
    setStatus('loading');
    setErrorMessage('');
    try {
      // api.js already redirects to /login on 401 via its response
      // interceptor, so no special-case 401 handling is needed here.
      const res = await api.get(DASHBOARD_ENDPOINT, { signal });
      const data = res.data;

      if (!data || typeof data !== 'object' || !data.student) {
        throw new Error('Malformed dashboard response');
      }

      // Merge API usage data onto the known feature shell by key, so a
      // partial or reordered API payload can't break the layout — any
      // feature the API doesn't mention just renders as unlimited.
      const byKey = {};
      (Array.isArray(data.features) ? data.features : []).forEach((f) => {
        if (f && f.key) byKey[f.key] = f;
      });
      const merged = FEATURE_ORDER.map((key) => {
        const meta = FEATURE_META[key];
        const live = byKey[key] || {};
        return {
          key,
          id: meta.id,
          name: live.name || meta.name,
          path: live.path !== undefined ? live.path : meta.path,
          ai: typeof live.ai === 'boolean' ? live.ai : meta.ai,
          blurb: live.blurb || meta.blurb,
          cap: live.cap || null,
          // FORCED_COMING_SOON wins over whatever the API says, so a feature
          // can be pulled from the students' view by a frontend deploy alone,
          // without waiting on a backend change.
          comingSoon: FORCED_COMING_SOON.has(key) || !!live.comingSoon,
        };
      });

      setStudent({
        name: data.student.name || 'Student',
        college: data.student.college || '',
      });
      setFeatures(merged);
      setStatus('ready');
      requestAnimationFrame(() => setMounted(true));
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      setErrorMessage(
        "Couldn't load your dashboard. Check your connection and try again."
      );
      setStatus('error');
    }
  }, [navigate]);

  useEffect(() => {
    const controller = new AbortController();
    setMounted(false);
    loadDashboard(controller.signal);
    return () => controller.abort();
  }, [loadDashboard]);

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className={`vfl-dash ${mounted ? 'is-mounted' : ''}`}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Lora:ital,wght@0,400;0,500;1,400&display=swap');

        .vfl-dash {
          --ink:        #0d0d0f;   /* near-black page ground        */
          --coal:       #16161a;   /* card ground                   */
          --graphite:   #232329;   /* raised / hover surface        */
          --seam:       #2e2e35;   /* hairline borders              */
          --ash:        #8b8b93;   /* secondary text                */
          --bone:       #e8e6e1;   /* primary text, warm off-white  */
          --silver:     #c9c7c2;   /* headings' quieter companion   */

          --serif-display: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
          --serif-body:    'Lora', Georgia, serif;

          min-height: 100vh;
          background: var(--ink);
          color: var(--bone);
          font-family: var(--serif-body);
          -webkit-font-smoothing: antialiased;
        }

        /* ---------- shell ---------- */
        .vfl-shell {
          max-width: 1180px;
          margin: 0 auto;
          padding: 0 20px 72px;
        }

        /* ---------- top bar ---------- */
        .vfl-topbar {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 16px;
          padding: 26px 0 22px;
          border-bottom: 1px solid var(--seam);
        }
        .vfl-wordmark {
          font-family: var(--serif-display);
          font-size: 1.35rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--bone);
        }
        .vfl-wordmark em {
          font-style: italic;
          font-weight: 400;
          color: var(--ash);
        }
        .vfl-college {
          font-size: 0.78rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--ash);
          text-align: right;
        }

        /* ---------- greeting / hero ---------- */
        .vfl-hero {
          padding: 56px 0 44px;
          border-bottom: 1px solid var(--seam);
        }
        .vfl-date {
          font-size: 0.78rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--ash);
          margin: 0 0 14px;
        }
        .vfl-greeting {
          font-family: var(--serif-display);
          font-weight: 500;
          font-size: clamp(2.1rem, 5.5vw, 3.6rem);
          line-height: 1.08;
          margin: 0;
          color: var(--bone);
        }
        .vfl-greeting em {
          font-style: italic;
          color: var(--silver);
        }
        .vfl-sub {
          margin: 18px 0 0;
          max-width: 46ch;
          color: var(--ash);
          font-size: 1rem;
          line-height: 1.65;
        }

        /* ---------- section label ---------- */
        .vfl-section-label {
          display: flex;
          align-items: center;
          gap: 14px;
          margin: 40px 0 22px;
          color: var(--ash);
          font-size: 0.78rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .vfl-section-label::after {
          content: "";
          flex: 1;
          height: 1px;
          background: var(--seam);
        }

        /* ---------- feature grid ---------- */
        .vfl-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1px;                    /* hairline gutters via background */
          background: var(--seam);
          border: 1px solid var(--seam);
        }
        @media (max-width: 1024px) { .vfl-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 560px)  { .vfl-grid { grid-template-columns: 1fr; } }

        .vfl-card {
          background: var(--coal);
          padding: 26px 24px 24px;
          text-align: left;
          border: none;
          cursor: pointer;
          color: inherit;
          font-family: inherit;
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 190px;
          transition: background 220ms ease;
          opacity: 0;
          transform: translateY(10px);
        }
        .is-mounted .vfl-card {
          opacity: 1;
          transform: none;
          transition: background 220ms ease,
                      opacity 480ms ease var(--stagger, 0ms),
                      transform 480ms ease var(--stagger, 0ms);
        }
        .vfl-card:hover,
        .vfl-card:focus-visible { background: var(--graphite); }
        .vfl-card:focus-visible {
          outline: 1px solid var(--silver);
          outline-offset: -1px;
        }
        /* "Coming soon" cards used to be dimmed via opacity: 0.55 on the
           whole button. That works fine on paper, but a translucent
           fractional-width element gets GPU-layer-composited by Chromium,
           and on some renders (confirmed in a real browser, not just this
           dev build) it paints as two tiles with a visible seam partway
           across the card - looks like only half the card is dimmed.
           Fix: use flat, fully-opaque colors instead of alpha blending, so
           there's nothing for the compositor to tile unevenly. */
        .vfl-card.is-disabled {
          cursor: default;
          background: var(--ink);
        }
        .vfl-card.is-disabled:hover,
        .vfl-card.is-disabled:focus-visible { background: var(--ink); }
        .vfl-card.is-disabled .vfl-card-index { color: #5c5c63; }
        .vfl-card.is-disabled .vfl-tag { color: #5c5c63; border-color: var(--graphite); }
        .vfl-card.is-disabled .vfl-card-name { color: var(--ash); }
        .vfl-card.is-disabled .vfl-card-blurb { color: #5c5c63; }
        .vfl-card.is-disabled .vfl-card-limit { color: #5c5c63; border-top-color: var(--graphite); }
        .vfl-card.is-disabled .vfl-unlimited::before { background: #4a4a50; }

        .vfl-card-top {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        .vfl-card-index {
          font-family: var(--serif-display);
          font-style: italic;
          font-size: 0.95rem;
          color: var(--ash);
        }
        .vfl-tag {
          font-size: 0.62rem;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--ash);
          border: 1px solid var(--seam);
          padding: 3px 8px;
          border-radius: 999px;
        }
        .vfl-tag.is-ai { color: var(--silver); border-color: var(--ash); }

        .vfl-card-name {
          font-family: var(--serif-display);
          font-size: 1.45rem;
          font-weight: 500;
          line-height: 1.15;
          margin: 0;
          color: var(--bone);
        }
        .vfl-card-blurb {
          margin: 0;
          font-size: 0.88rem;
          line-height: 1.6;
          color: var(--ash);
          flex: 1;
        }
        .vfl-card-limit {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          font-size: 0.72rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ash);
          border-top: 1px solid var(--seam);
          padding-top: 12px;
        }
        .vfl-card:hover .vfl-card-limit { color: var(--silver); }

        /* ---------- usage meter ---------- */
        .vfl-usage-label { white-space: nowrap; }
        .vfl-usage-dots {
          display: flex;
          gap: 5px;
          flex-shrink: 0;
        }
        .vfl-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--seam);
          border: 1px solid var(--ash);
        }
        .vfl-dot.is-used {
          background: var(--silver);
          border-color: var(--silver);
        }
        .vfl-dot.is-last-used {
          background: var(--bone);
          border-color: var(--bone);
        }
        /* Dots work for small caps (1/day, 3/day...) but a dot-per-use
           literally doesn't fit once a cap hits double digits (16/month,
           50/month) — wraps and spills past the card edge. Above 10, show
           a proportional bar instead. */
        .vfl-usage-bar-track {
          width: 72px;
          height: 5px;
          border-radius: 3px;
          background: var(--seam);
          border: 1px solid var(--ash);
          overflow: hidden;
          flex-shrink: 0;
        }
        .vfl-usage-bar-fill {
          height: 100%;
          border-radius: 2px;
          background: var(--silver);
          transition: width 0.3s ease;
        }
        .vfl-usage-bar-fill.is-full { background: var(--bone); }
        .vfl-unlimited {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .vfl-unlimited::before {
          content: "";
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--ash);
        }
        .vfl-card:hover .vfl-unlimited::before { background: var(--silver); }

        /* ---------- loading skeleton ---------- */
        @keyframes vfl-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.75; } }
        .vfl-skel {
          background: var(--seam);
          border-radius: 3px;
          animation: vfl-pulse 1.6s ease-in-out infinite;
        }
        .vfl-skel-card {
          background: var(--coal);
          padding: 26px 24px 24px;
          min-height: 190px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        /* ---------- error state ---------- */
        .vfl-error {
          padding: 60px 20px;
          text-align: center;
          border: 1px solid var(--seam);
        }
        .vfl-error p {
          color: var(--ash);
          font-size: 0.95rem;
          margin: 0 0 20px;
        }
        .vfl-retry {
          font-family: var(--serif-body);
          background: transparent;
          color: var(--bone);
          border: 1px solid var(--ash);
          padding: 10px 22px;
          font-size: 0.8rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: border-color 180ms ease, color 180ms ease;
        }
        .vfl-retry:hover,
        .vfl-retry:focus-visible {
          border-color: var(--bone);
          color: var(--silver);
          outline: none;
        }

        /* ---------- footer ---------- */
        .vfl-foot {
          margin-top: 48px;
          padding-top: 20px;
          border-top: 1px solid var(--seam);
          display: flex;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          color: var(--ash);
          font-size: 0.78rem;
          line-height: 1.6;
        }
        .vfl-foot em { font-style: italic; }

        /* ---------- small screens ---------- */
        @media (max-width: 560px) {
          .vfl-topbar { flex-direction: column; align-items: flex-start; gap: 6px; }
          .vfl-college { text-align: left; }
          .vfl-hero { padding: 40px 0 32px; }
          .vfl-card { min-height: 0; }
        }

        /* ---------- accessibility: reduced motion ---------- */
        @media (prefers-reduced-motion: reduce) {
          .vfl-card, .is-mounted .vfl-card { transition: background 220ms ease; opacity: 1; transform: none; }
        }
      `}</style>

      <div className="vfl-shell">
        {/* top bar */}
        <header className="vfl-topbar">
          <div className="vfl-wordmark">
            Law <em>AI</em>
          </div>
          <div className="vfl-college">
            {status === 'ready' ? student.college : ''}
          </div>
        </header>

        {/* greeting */}
        <section className="vfl-hero">
          <p className="vfl-date">{today}</p>
          {status === 'ready' ? (
            <>
              <h1 className="vfl-greeting">
                {greetingForNow()}, <em>{student.name}.</em>
              </h1>
              <p className="vfl-sub">
                Your chambers for practice, drafting and preparation. Pick up
                where you left off, or open something new.
              </p>
            </>
          ) : status === 'loading' ? (
            <>
              <div className="vfl-skel" style={{ height: 40, width: '70%', marginBottom: 12 }} />
              <div className="vfl-skel" style={{ height: 16, width: '45%' }} />
            </>
          ) : (
            <h1 className="vfl-greeting">Welcome back.</h1>
          )}
        </section>

        {/* features */}
        <div className="vfl-section-label">Your tools</div>

        {status === 'error' && (
          <div className="vfl-error">
            <p>{errorMessage}</p>
            <button
              type="button"
              className="vfl-retry"
              onClick={() => loadDashboard()}
            >
              Retry
            </button>
          </div>
        )}

        {status === 'loading' && (
          <main className="vfl-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="vfl-skel-card" key={i}>
                <div className="vfl-skel" style={{ height: 12, width: '30%' }} />
                <div className="vfl-skel" style={{ height: 22, width: '70%' }} />
                <div className="vfl-skel" style={{ height: 12, width: '90%', marginTop: 'auto' }} />
              </div>
            ))}
          </main>
        )}

        {status === 'ready' && (
          <main className={`vfl-grid ${mounted ? 'is-mounted' : ''}`}>
            {features.map((f, i) => {
              const disabled = f.comingSoon || !f.path;
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`vfl-card${disabled ? ' is-disabled' : ''}`}
                  style={{ '--stagger': `${i * 60}ms` }}
                  onClick={() => { if (!disabled) navigate(f.path); }}
                  aria-disabled={disabled}
                  aria-label={disabled ? `${f.name} — coming soon` : `Open ${f.name}`}
                >
                  <div className="vfl-card-top">
                    <span className="vfl-card-index">No. {f.id}</span>
                    <span className={`vfl-tag ${f.ai ? 'is-ai' : ''}`}>
                      {disabled ? 'Coming soon' : f.ai ? 'AI assisted' : 'Reference'}
                    </span>
                  </div>
                  <h2 className="vfl-card-name">{f.name}</h2>
                  <p className="vfl-card-blurb">{f.blurb}</p>
                  <div className="vfl-card-limit">
                    {disabled ? (
                      <span className="vfl-unlimited">Not live yet</span>
                    ) : f.cap ? (
                      <>
                        <span className="vfl-usage-label">
                          {f.cap.used} of {f.cap.max} used this {f.cap.unit}
                        </span>
                        {f.cap.max > 10 ? (
                          <span className="vfl-usage-bar-track" aria-hidden="true">
                            <span
                              className={
                                'vfl-usage-bar-fill' + (f.cap.used >= f.cap.max ? ' is-full' : '')
                              }
                              style={{ width: `${Math.min(100, (f.cap.used / f.cap.max) * 100)}%` }}
                            />
                          </span>
                        ) : (
                          <span className="vfl-usage-dots" aria-hidden="true">
                            {Array.from({ length: f.cap.max }).map((_, dotIdx) => (
                              <span
                                key={dotIdx}
                                className={
                                  'vfl-dot' +
                                  (dotIdx < f.cap.used
                                    ? dotIdx === f.cap.used - 1
                                      ? ' is-last-used'
                                      : ' is-used'
                                    : '')
                                }
                              />
                            ))}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="vfl-unlimited">Unlimited access</span>
                    )}
                  </div>
                </button>
              );
            })}
          </main>
        )}

        {/* footer */}
        <footer className="vfl-foot">
          <span>
            <em>For educational purposes only. Verify with a qualified advocate.</em>
          </span>
          <span>Law AI · AIFORLAW</span>
        </footer>
      </div>
    </div>
  );
}
