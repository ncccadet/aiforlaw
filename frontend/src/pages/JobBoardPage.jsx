/**
 * JobBoardPage.jsx
 * Same visual language as LoginPage.jsx: black background, frosted-glass
 * ("liquid glass") panels, Calisto MT serif font.
 *
 * FRONTEND ONLY, per explicit instruction — resume match % is a UI stub.
 * getJobs() calls the real (already-built) /api/jobs endpoint; if it 404s
 * or errors (backend piece was reverted separately), the page falls back
 * to sample jobs so the design can be reviewed without a live backend.
 * Resume matching has no backend endpoint yet — matchResume() below
 * computes a placeholder score locally and is clearly marked TODO.
 */
import { useEffect, useRef, useState } from 'react';
import { getJobs, getJobStats, trackApplyClick } from '../services/jobBoard.service';
import { INDIAN_STATES } from '../services/indianStates';

const FILTER_TABS = [
  { key: 'state', label: 'Location' },
  { key: 'type', label: 'Job Type' },
  { key: 'govt', label: 'Govt / Private' },
  { key: 'salary', label: 'Salary' },
  { key: 'sort', label: 'Sort' },
];

/**
 * Salary slider (founder ask, 2026-07-30 — "as we get in the standard
 * websites", 0 to about ten lakh, "up to that particular number").
 *
 * The figure is ANNUAL rupees, and the filter means "at most this much", so
 * the slider sitting at its maximum has to mean "any salary" rather than
 * "≤ 10 lakh" — otherwise the best-paying listings would vanish the moment a
 * student touched the control. SALARY_MAX is therefore both the top of the
 * track and the off switch, and the backend applies the same rule.
 *
 * Step is ₹25,000 because a 1-rupee step on a 10-lakh range makes the thumb
 * impossible to land on a round number with a finger.
 */
const SALARY_MAX = 1000000;
const SALARY_STEP = 25000;

/** ₹4,50,000 → "₹4.5 L". Indian grouping, not the browser's default en-US. */
function formatSalary(n) {
  if (n >= SALARY_MAX) return 'Any salary';
  if (n === 0) return 'Unpaid / ₹0';
  const lakh = n / 100000;
  return `Up to ₹${lakh % 1 === 0 ? lakh : lakh.toFixed(2).replace(/0$/, '')} L / year`;
}

const SAMPLE_JOBS = [
  // Locations carry the state as well as the city so the sample fallback can
  // answer a state filter without shipping the server's city→state table to
  // the browser. Real listings from job_cache are city-only; the server does
  // the mapping for those.
  { job_id: 's1', title: 'Legal Intern — Corporate Law', firm: 'Trilegal', location: 'Mumbai, Maharashtra', job_type: 'internship', is_government: false, salary_text: '₹15,000/month', apply_url: '#' },
  { job_id: 's2', title: 'Legal Officer', firm: 'NALSA', location: 'New Delhi, Delhi', job_type: 'full_time', is_government: true, salary_text: '₹8 LPA', apply_url: '#' },
  { job_id: 's3', title: 'Associate — Litigation', firm: 'Khaitan & Co.', location: 'Bengaluru, Karnataka', job_type: 'full_time', is_government: false, salary_text: 'Not disclosed', apply_url: '#' },
  { job_id: 's4', title: 'Judicial Clerkship Intern', firm: 'Delhi High Court', location: 'New Delhi, Delhi', job_type: 'internship', is_government: true, salary_text: 'Stipend: ₹10,000/month', apply_url: '#' },
  { job_id: 's5', title: 'Policy Research Intern', firm: 'Vidhi Centre for Legal Policy', location: 'New Delhi, Delhi', job_type: 'internship', is_government: false, salary_text: '₹12,000/month', apply_url: '#' },
];

/**
 * Mirror of the server's ANNUAL_SALARY_SQL (jobBoard.controller.js) in JS, for
 * the sample fallback only. Returns annual rupees, or null when the text does
 * not state a figure — 'Not disclosed' is null and is therefore filtered OUT
 * whenever a salary cap is set, exactly as the SQL does.
 */
function parseAnnualSalary(text) {
  const s = text || '';
  const m = s.match(/[0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/lpa|per annum|p\.a\.|\/ *(yr|year)|annually/i.test(s)) return n * 100000;
  if (/month|\/ *mo|p\.m\.|stipend/i.test(s)) return n * 12;
  return null;
}

/** Applies the same filters a real backend query would, to the local
 * SAMPLE_JOBS fallback. Without this, the filter tabs looked functional
 * (they opened, selections highlighted) but had zero effect on the list
 * whenever the API returned no jobs (the backend's job_cache pipeline
 * isn't live yet) — every filter combination showed all 5 sample jobs. */
function filterSampleJobs(filters) {
  return SAMPLE_JOBS.filter((j) => {
    if (filters.state && !j.location.toLowerCase().includes(filters.state.toLowerCase())) return false;
    if (filters.type && j.job_type !== filters.type) return false;
    if (filters.govt && String(j.is_government) !== filters.govt) return false;
    if (filters.salaryMax && filters.salaryMax < SALARY_MAX) {
      const annual = parseAnnualSalary(j.salary_text);
      if (annual === null || annual > filters.salaryMax) return false;
    }
    return true;
  });
}

/** TODO(backend): replace with a real POST /api/jobs/match-resume call once
 * a resume-parsing endpoint exists. For now, produces a stable-looking but
 * fake percentage per job so the UI/UX can be reviewed and approved first. */
function fakeMatchScore(job, resumeName) {
  let hash = 0;
  const str = (resumeName || '') + job.job_id;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return 55 + (hash % 41); // 55–95%, deterministic per resume+job pairing
}

export default function JobBoardPage() {
  const [filters, setFilters] = useState({ state: '', type: '', govt: '', salaryMax: SALARY_MAX, sort: 'newest', page: 1 });
  // The slider's live position while a finger/mouse is still down. Committing
  // to `filters` on every pixel of a drag would fire one API request per
  // pixel, so the thumb tracks this value and only writes to `filters` on
  // release (see the range input's onPointerUp/onKeyUp below).
  const [salaryDraft, setSalaryDraft] = useState(SALARY_MAX);
  const [openTab, setOpenTab] = useState(null);
  const [jobs, setJobs] = useState(SAMPLE_JOBS);
  const [total, setTotal] = useState(SAMPLE_JOBS.length);
  const [loading, setLoading] = useState(true);
  const [usingSample, setUsingSample] = useState(false);
  const [resumeName, setResumeName] = useState(null);
  const [matching, setMatching] = useState(false);
  const [scores, setScores] = useState({});
  // Real counts from job_cache — null while loading/unavailable, so the UI
  // can just not render the line rather than show a misleading "0 new
  // today" if the stats call fails (e.g. sample-data fallback mode).
  const [stats, setStats] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    getJobStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    getJobs(filters)
      .then((data) => {
        if (data.jobs && data.jobs.length > 0) {
          setJobs(data.jobs);
          setTotal(data.total || data.jobs.length);
          setUsingSample(false);
        } else {
          const filtered = filterSampleJobs(filters);
          setJobs(filtered);
          setTotal(filtered.length);
          setUsingSample(true);
        }
      })
      .catch(() => {
        const filtered = filterSampleJobs(filters);
        setJobs(filtered);
        setTotal(filtered.length);
        setUsingSample(true);
      })
      .finally(() => setLoading(false));
  }, [filters.state, filters.type, filters.govt, filters.salaryMax, filters.sort, filters.page]);

  // "Best match" sort only means something once a resume has been scored.
  // Derived at render time (not a separate state-setting effect) so it can
  // never race with the async getJobs() fetch above and get clobbered when
  // that promise resolves after this would have reordered `jobs` in place.
  const displayedJobs = filters.sort === 'match' && Object.keys(scores).length > 0
    ? [...jobs].sort((a, b) => (scores[b.job_id] ?? -1) - (scores[a.job_id] ?? -1))
    : jobs;

  const toggleTab = (key) => setOpenTab((cur) => (cur === key ? null : key));
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value, page: 1 }));

  const handleResumeUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setResumeName(file.name);
    setMatching(true);
    setScores({});
    // TODO(backend): upload `file` to a resume-match endpoint. Simulated
    // delay only so the loading state can be reviewed as part of the design.
    setTimeout(() => {
      const next = {};
      jobs.forEach((j) => { next[j.job_id] = fakeMatchScore(j, file.name); });
      setScores(next);
      setMatching(false);
    }, 900);
  };

  // Which tabs count as "in use". Written out one filter at a time on purpose:
  // the old version walked Object.values(filters) and skipped keys by index,
  // which silently broke as soon as a filter's default stopped being ''
  // (salaryMax defaults to SALARY_MAX, not empty).
  const isFilterActive = (key) => {
    if (key === 'sort') return filters.sort !== 'newest';
    if (key === 'salary') return filters.salaryMax < SALARY_MAX;
    return !!filters[key];
  };
  const activeCount = FILTER_TABS.filter((t) => isFilterActive(t.key)).length;

  const resetFilters = () => {
    setFilters({ state: '', type: '', govt: '', salaryMax: SALARY_MAX, sort: 'newest', page: 1 });
    setSalaryDraft(SALARY_MAX);
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <h1 style={styles.title}>Job Board</h1>
          <p style={styles.subtitle}>Curated legal jobs & internships, refreshed every 2 days</p>
          {stats && !usingSample && (
            <p style={styles.subtitle}>
              {stats.newToday > 0 ? `${stats.newToday} new today · ` : ''}{stats.totalActive} listings currently active
            </p>
          )}
        </header>

        {/* ---- Filter tabs ---- */}
        <div style={styles.tabBar}>
          {FILTER_TABS.map((tab) => {
            const isOpen = openTab === tab.key;
            const isActive = isFilterActive(tab.key);
            return (
              <button
                key={tab.key}
                onClick={() => toggleTab(tab.key)}
                style={{ ...styles.tab, ...(isOpen ? styles.tabOpen : {}), ...(isActive ? styles.tabActive : {}) }}
              >
                {tab.label}
                {isActive && <span style={styles.tabDot} />}
              </button>
            );
          })}
          {activeCount > 0 && (
            <button style={styles.clearBtn} onClick={resetFilters}>Clear all</button>
          )}
        </div>

        {/* ---- Open filter panel ---- */}
        {openTab && (
          <div style={styles.panel}>
            {openTab === 'state' && (
              // A <select>, not a text box: students were typing city names
              // that never matched, and the server can only reason about a
              // state it recognises. The native control is deliberate — it
              // gives the iOS wheel picker and Android's list for free, which
              // is far better on a phone than a custom dropdown.
              <select
                autoFocus
                style={styles.panelSelect}
                value={filters.state}
                onChange={(e) => setFilter('state', e.target.value)}
              >
                <option value="">All states</option>
                {INDIAN_STATES.map((s) => (
                  <option key={s} value={s} style={styles.option}>{s}</option>
                ))}
              </select>
            )}
            {openTab === 'type' && (
              <div style={styles.pillRow}>
                {[['', 'All'], ['internship', 'Internship'], ['full_time', 'Full-time']].map(([v, l]) => (
                  <button key={v} onClick={() => setFilter('type', v)} style={{ ...styles.pill, ...(filters.type === v ? styles.pillActive : {}) }}>{l}</button>
                ))}
              </div>
            )}
            {openTab === 'govt' && (
              <div style={styles.pillRow}>
                {[['', 'All'], ['true', 'Government'], ['false', 'Private']].map(([v, l]) => (
                  <button key={v} onClick={() => setFilter('govt', v)} style={{ ...styles.pill, ...(filters.govt === v ? styles.pillActive : {}) }}>{l}</button>
                ))}
              </div>
            )}
            {openTab === 'salary' && (
              <div>
                <div style={styles.sliderHead}>
                  <span style={styles.sliderValue}>{formatSalary(salaryDraft)}</span>
                  {salaryDraft < SALARY_MAX && (
                    <button
                      style={styles.clearBtn}
                      onClick={() => { setSalaryDraft(SALARY_MAX); setFilter('salaryMax', SALARY_MAX); }}
                    >Reset</button>
                  )}
                </div>
                <input
                  type="range"
                  min={0}
                  max={SALARY_MAX}
                  step={SALARY_STEP}
                  value={salaryDraft}
                  style={styles.slider}
                  // onChange keeps the label under the thumb, in the same
                  // frame as the drag. The filter itself is only committed on
                  // release, so one drag = one request, not forty.
                  onChange={(e) => setSalaryDraft(Number(e.target.value))}
                  onPointerUp={() => setFilter('salaryMax', salaryDraft)}
                  onTouchEnd={() => setFilter('salaryMax', salaryDraft)}
                  // Keyboard users never fire a pointer event — arrow keys
                  // move the thumb, so commit on key release too, or the
                  // control would be unusable without a mouse.
                  onKeyUp={() => setFilter('salaryMax', salaryDraft)}
                />
                <div style={styles.sliderScale}>
                  <span>₹0</span><span>₹5 L</span><span>₹10 L+</span>
                </div>
                <div style={styles.sliderNote}>
                  Annual figure. Monthly stipends are counted as twelve months. Listings that
                  don't state a salary are hidden while this filter is set.
                </div>
              </div>
            )}
            {openTab === 'sort' && (
              <div style={styles.pillRow}>
                {[['newest', 'Newest first'], ['match', 'Best match (needs resume)']].map(([v, l]) => (
                  <button key={v} onClick={() => setFilter('sort', v)} style={{ ...styles.pill, ...(filters.sort === v ? styles.pillActive : {}) }}>{l}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---- Resume match ---- */}
        <div style={styles.resumeCard}>
          <div>
            <div style={styles.resumeTitle}>Match jobs to your resume</div>
            <div style={styles.resumeSubtitle}>
              {resumeName ? `Using: ${resumeName}` : 'Upload a resume to see a suitability % on every listing below'}
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx" onChange={handleResumeUpload} style={{ display: 'none' }} />
          <button style={styles.uploadBtn} onClick={() => fileInputRef.current?.click()} disabled={matching}>
            {matching ? 'Analyzing…' : resumeName ? 'Replace resume' : 'Upload resume'}
          </button>
        </div>

        {usingSample && (
          <div style={styles.notice}>Showing sample listings — live data isn't available from this preview yet.</div>
        )}

        {/* ---- Job list ---- */}
        {loading ? (
          <div style={styles.empty}>Loading…</div>
        ) : displayedJobs.length === 0 ? (
          <div style={styles.empty}>No jobs match these filters right now.</div>
        ) : (
          <ul style={styles.list}>
            {displayedJobs.map((job) => {
              const score = scores[job.job_id];
              return (
                <li key={job.job_id} style={styles.card}>
                  <div style={styles.cardMain}>
                    <div style={styles.cardTitle}>{job.title}</div>
                    {job.firm && <div style={styles.cardFirm}>{job.firm}</div>}
                    <div style={styles.cardMeta}>
                      {[
                        job.location || 'Location not listed',
                        job.job_type === 'internship' ? 'Internship' : 'Full-time',
                        job.is_government !== null && job.is_government !== undefined
                          ? (job.is_government ? 'Government' : 'Private') : null,
                        job.salary_text || null,
                      ].filter(Boolean).map((text, i) => (
                        // Each "· value" is one span, not a separate divider span, so the
                        // separator travels with its value when the row wraps on narrow
                        // screens instead of dangling alone at the end of the line.
                        <span key={i}>{i > 0 && <span style={styles.metaDivider}>· </span>}{text}</span>
                      ))}
                    </div>
                    {/* onClick records the click for the admin panel and does
                        NOT preventDefault — the browser opens the vacancy in a
                        new tab exactly as it did before. trackApplyClick is
                        fire-and-forget and never throws, so nothing here can
                        stop the navigation. The server ignores non-UUID ids,
                        which is what SAMPLE_JOBS above ('s1'…) sends when the
                        backend is unreachable. */}
                    <a
                      href={job.apply_url}
                      target="_blank"
                      rel="noreferrer"
                      style={styles.applyLink}
                      onClick={() => trackApplyClick(job.job_id)}
                    >Apply →</a>
                  </div>
                  {score !== undefined && (
                    <div style={styles.matchBadge}>
                      <svg width="52" height="52" viewBox="0 0 52 52">
                        <circle cx="26" cy="26" r="22" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
                        <circle
                          cx="26" cy="26" r="22" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="4"
                          strokeDasharray={2 * Math.PI * 22}
                          strokeDashoffset={2 * Math.PI * 22 * (1 - score / 100)}
                          strokeLinecap="round"
                          transform="rotate(-90 26 26)"
                        />
                      </svg>
                      <span style={styles.matchPct}>{score}%</span>
                      <span style={styles.matchLabel}>match</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {total > 20 && (
          <div style={styles.pagination}>
            <button style={styles.pageBtn} disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>Prev</button>
            <span style={styles.pageLabel}>Page {filters.page} of {Math.max(1, Math.ceil(total / 20))}</span>
            <button style={styles.pageBtn} disabled={filters.page >= Math.ceil(total / 20)} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}

const glass = {
  background: 'rgba(255, 255, 255, 0.06)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
};

const styles = {
  page: {
    minHeight: '100vh',
    width: '100%',
    background: '#0a0a0a',
    fontFamily: "'Calisto MT', Georgia, serif",
    padding: '2.5rem 1.5rem',
    boxSizing: 'border-box',
  },
  container: { maxWidth: 880, margin: '0 auto' },
  header: { textAlign: 'center', marginBottom: '2rem' },
  title: { color: '#fff', fontSize: '2rem', margin: 0 },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: '0.95rem', marginTop: '0.5rem' },

  tabBar: { display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginBottom: '0.75rem' },
  tab: {
    ...glass,
    borderRadius: '999px',
    padding: '0.55rem 1.2rem',
    color: 'rgba(255,255,255,0.85)',
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    transition: 'transform 0.15s ease, background 0.2s ease',
  },
  tabOpen: { background: 'rgba(255,255,255,0.14)', transform: 'translateY(-1px)' },
  tabActive: { border: '1px solid rgba(255,255,255,0.4)' },
  tabDot: { width: 6, height: 6, borderRadius: '50%', background: '#7ee787', display: 'inline-block' },
  clearBtn: {
    background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)',
    fontSize: '0.85rem', fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline',
    padding: '0.55rem 0.4rem',
  },

  panel: { ...glass, borderRadius: '14px', padding: '1rem 1.2rem', marginBottom: '1.5rem', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' },
  // A native <select> renders its popup list using the OS palette, so the
  // option text must stay dark — hence styles.option below. Only the closed
  // control follows the page's glass theme.
  panelSelect: {
    width: '100%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', padding: '0.7rem 1rem', color: '#fff', fontSize: '0.95rem', fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
  },
  option: { background: '#141414', color: '#fff' },

  sliderHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.6rem' },
  sliderValue: { color: '#fff', fontSize: '1rem' },
  slider: { width: '100%', accentColor: '#fff', cursor: 'pointer', boxSizing: 'border-box' },
  sliderScale: {
    display: 'flex', justifyContent: 'space-between', color: 'rgba(255,255,255,0.4)',
    fontSize: '0.75rem', marginTop: '0.2rem',
  },
  sliderNote: { color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', marginTop: '0.7rem', lineHeight: 1.5 },

  pillRow: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  pill: {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '999px',
    padding: '0.5rem 1rem', color: 'rgba(255,255,255,0.8)', fontSize: '0.85rem', fontFamily: 'inherit', cursor: 'pointer',
  },
  pillActive: { background: 'rgba(255,255,255,0.9)', color: '#0a0a0a', fontWeight: 'bold' },

  resumeCard: {
    ...glass, borderRadius: '14px', padding: '1.2rem 1.4rem', marginBottom: '1.5rem',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
  },
  resumeTitle: { color: '#fff', fontSize: '1rem' },
  resumeSubtitle: { color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem', marginTop: '0.25rem' },
  uploadBtn: {
    padding: '0.7rem 1.4rem', borderRadius: '10px', border: 'none', background: 'rgba(255,255,255,0.9)',
    color: '#0a0a0a', fontSize: '0.9rem', fontWeight: 'bold', fontFamily: 'inherit', cursor: 'pointer',
  },

  notice: {
    color: 'rgba(255,255,255,0.45)', fontSize: '0.8rem', textAlign: 'center', marginBottom: '1rem', fontStyle: 'italic',
  },
  empty: { color: 'rgba(255,255,255,0.6)', textAlign: 'center', padding: '3rem 0' },

  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.9rem' },
  card: {
    ...glass, borderRadius: '14px', padding: '1.2rem 1.4rem', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)', transition: 'transform 0.15s ease, background 0.2s ease',
  },
  cardMain: { flex: 1, minWidth: 0 },
  cardTitle: { color: '#fff', fontSize: '1.05rem' },
  cardFirm: { color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem', marginTop: '0.2rem' },
  cardMeta: { color: 'rgba(255,255,255,0.5)', fontSize: '0.82rem', marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.4rem' },
  metaDivider: { opacity: 0.4 },
  applyLink: { color: '#9ecbff', fontSize: '0.85rem', textDecoration: 'none', marginTop: '0.6rem', display: 'inline-block' },

  matchBadge: { position: 'relative', width: 52, height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  matchPct: { position: 'absolute', color: '#fff', fontSize: '0.8rem', fontWeight: 'bold', top: 12 },
  matchLabel: { position: 'absolute', color: 'rgba(255,255,255,0.5)', fontSize: '0.55rem', bottom: 6 },

  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', marginTop: '2rem' },
  pageBtn: {
    ...glass, borderRadius: '999px', padding: '0.5rem 1.1rem', color: '#fff', fontFamily: 'inherit',
    fontSize: '0.85rem', cursor: 'pointer',
  },
  pageLabel: { color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem' },
};
