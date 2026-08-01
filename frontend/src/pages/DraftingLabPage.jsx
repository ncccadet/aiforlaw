/**
 * DraftingLabPage.jsx — v3: three-step learning flow
 * Contract: _contracts/04-drafting-lab.md
 *
 * Tab 1 — Learn (Step 1, no AI, unlimited): real Delhi + Maharashtra
 *   specimens per draft type, an anatomy breakdown, source links, and a
 *   "view PDF" link wherever a real stored PDF exists.
 * Tab 2 — Practice (Steps 2+3, 3/day combined): pick a draft type → AI
 *   generates a case → fill fixed labeled fields (resume-builder-style,
 *   not one big free-text box) → submit → AI scores it like a senior
 *   advocate reviewing a junior's first draft. No model draft shown.
 *
 * Theme carried over from v2: black/grey serif, mobile-responsive.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getLibrary, getOptions, startCaseStudy, getCaseResult, submitCaseStudy, getScore,
} from '../services/draftingLab.service';

const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 90000;

const CONFIDENCE_LABEL = {
  HIGH: 'Verified — real, state-specific document',
  MODERATE: 'Genuine practice material — see note',
  MODERATE_HIGH: 'Genuine practice material — see note',
  GENERIC_FALLBACK: 'No real state-specific version exists — generic fallback',
};
const CONFIDENCE_COLOR = {
  HIGH: '#4caf6b',
  MODERATE: '#d4a53a',
  MODERATE_HIGH: '#d4a53a',
  GENERIC_FALLBACK: '#c85c5c',
};

export default function DraftingLabPage() {
  const [tab, setTab] = useState('learn'); // learn | practice

  return (
    <div className="dl-root">
      <style>{STYLES}</style>
      <div className="dl-container">
        <header className="dl-header">
          <div>
            <h1 className="dl-title">Drafting Lab</h1>
            <p className="dl-subtitle">Learn real formats, then draft and get scored like a junior under a senior advocate.</p>
          </div>
          <span className="dl-badge">Practice: 3 exercises / day</span>
        </header>

        <div className="dl-tabs">
          <button className={`dl-tab ${tab === 'learn' ? 'on' : ''}`} onClick={() => setTab('learn')}>1 · Learn</button>
          <button className={`dl-tab ${tab === 'practice' ? 'on' : ''}`} onClick={() => setTab('practice')}>2-3 · Practice &amp; Feedback</button>
        </div>

        {tab === 'learn' ? <LearnTab /> : <PracticeTab />}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TAB 1 — Learn (Step 1: real specimens + anatomy, no AI, unlimited)
// ────────────────────────────────────────────────────────────────────────────
function LearnTab() {
  const [library, setLibrary] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getLibrary()
      .then(({ data }) => { setLibrary(data.library || []); setSelected(data.library?.[0]?.template_type || null); })
      .catch(() => setError('Could not load the draft library.'));
  }, []);

  const entry = library.find((e) => e.template_type === selected);

  return (
    <section>
      {error && <div className="dl-card dl-error">{error}</div>}
      <div className="dl-types">
        {library.map((e) => (
          <button key={e.template_type} className={`dl-type ${selected === e.template_type ? 'sel' : ''}`} onClick={() => setSelected(e.template_type)}>
            {e.label}
          </button>
        ))}
      </div>

      {entry && (
        <>
          <section className="dl-card">
            <h2 className="dl-h2">Anatomy — what every {entry.label} needs</h2>
            {entry.anatomy.map((a, i) => (
              <div key={i} className="dl-anatomy-row">
                <strong>{a.part}</strong>
                <p>{a.why}</p>
              </div>
            ))}
          </section>

          <div className="dl-grid2">
            {['delhi', 'maharashtra'].map((state) => {
              const s = entry.specimens[state];
              if (!s) return null;
              return (
                <section className="dl-card" key={state}>
                  <div className="dl-fill-head">
                    <h2 className="dl-h2">{state === 'delhi' ? 'Delhi' : 'Maharashtra'}</h2>
                    <span className="dl-conf-badge" style={{ color: CONFIDENCE_COLOR[s.confidence] }}>
                      {CONFIDENCE_LABEL[s.confidence] || s.confidence}
                    </span>
                  </div>
                  <pre className="dl-pre">{s.text}</pre>
                  {s.note && <p className="dl-note">{s.note}</p>}
                  <div className="dl-links">
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.sourceLabel} →</a>
                    {s.pdfUrl && <a href={s.pdfUrl} target="_blank" rel="noreferrer">View real PDF →</a>}
                    {s.scannedOfficialPdfUrl && <a href={s.scannedOfficialPdfUrl} target="_blank" rel="noreferrer">View official scanned form →</a>}
                    {s.supportingPdfUrl && <a href={s.supportingPdfUrl} target="_blank" rel="noreferrer">View supporting rules PDF →</a>}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TAB 2 — Practice & Feedback (Steps 2+3: AI case → guided fields → AI score)
// ────────────────────────────────────────────────────────────────────────────
function PracticeTab() {
  const [types, setTypes] = useState([]);
  const [templateType, setTemplateType] = useState('');
  const [phase, setPhase] = useState('choose'); // choose | generating | fill | scoring | scored
  const [docId, setDocId] = useState(null);
  const [label, setLabel] = useState('');
  const [caseObj, setCaseObj] = useState(null);
  const [fields, setFields] = useState([]);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const pollRef = useRef(null);
  const pollStartRef = useRef(0);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => {
    getOptions().then(({ data }) => setTypes(data.types || [])).catch(() => setError('Could not load draft types.'));
    return stopPolling;
  }, []);

  const beginCasePolling = useCallback((id) => {
    stopPolling();
    pollStartRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling(); setPhase('choose'); setError('This is taking too long. Please try again.');
        return;
      }
      try {
        const { data } = await getCaseResult(id);
        if (data.status === 'active') {
          stopPolling();
          setLabel(data.label); setCaseObj(data.case); setFields(data.fields || []); setAnswers({}); setPhase('fill');
        } else if (data.status === 'failed') {
          stopPolling(); setPhase('choose'); setError(data.message || 'Could not generate a case.');
        }
      } catch { stopPolling(); setPhase('choose'); setError('Could not fetch your case.'); }
    }, POLL_MS);
  }, []);

  const beginScorePolling = useCallback((id) => {
    stopPolling();
    pollStartRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling(); setPhase('fill'); setError('Scoring is taking too long. Please try again.');
        return;
      }
      try {
        const { data } = await getScore(id);
        if (data.status === 'complete') {
          stopPolling(); setResult(data.result); setPhase('scored');
        } else if (data.status === 'failed') {
          stopPolling(); setPhase('fill'); setError(data.message || 'Could not score your draft.');
        }
      } catch { stopPolling(); setPhase('fill'); setError('Could not fetch your score.'); }
    }, POLL_MS);
  }, []);

  const onGenerate = async () => {
    if (!templateType) { setError('Please choose a draft type.'); return; }
    setError(''); setPhase('generating'); setCaseObj(null); setResult(null);
    try {
      const { data } = await startCaseStudy({ template_type: templateType });
      setDocId(data.docId);
      beginCasePolling(data.docId);
    } catch (e) {
      setPhase('choose');
      setError(e?.response?.data?.error || 'Could not start. Please try again.');
    }
  };

  const setAnswer = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));

  const onSubmit = async () => {
    setError(''); setPhase('scoring');
    try {
      const { data } = await submitCaseStudy({ doc_id: docId, fields: answers });
      beginScorePolling(data.docId);
    } catch (e) {
      setPhase('fill');
      setError(e?.response?.data?.error || 'Could not submit your draft. Please try again.');
    }
  };

  const startOver = () => {
    stopPolling(); setPhase('choose'); setDocId(null); setCaseObj(null); setAnswers({}); setResult(null); setError('');
  };

  const filledCount = fields.filter((f) => (answers[f.id] || '').trim()).length;

  return (
    <section>
      {error && <div className="dl-card dl-error" role="alert">{error}</div>}

      {(phase === 'choose' || phase === 'generating') && (
        <section className="dl-card">
          <h2 className="dl-h2">Choose the draft you want to practise</h2>
          <div className="dl-types">
            {types.map((t) => (
              <button key={t.id} className={`dl-type ${templateType === t.id ? 'sel' : ''}`}
                      onClick={() => setTemplateType(t.id)} disabled={phase === 'generating'}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="dl-actions">
            <button className="dl-btn dl-primary" onClick={onGenerate} disabled={phase === 'generating' || !templateType}>
              {phase === 'generating' ? 'Generating case…' : 'Generate case →'}
            </button>
          </div>
          {phase === 'generating' && <div className="dl-status"><span className="dl-spinner" />Preparing a case for you…</div>}
        </section>
      )}

      {phase === 'fill' && (
        <>
          {caseObj && (
            <section className="dl-card dl-case">
              <h2 className="dl-h2">{caseObj.title}</h2>
              <p className="dl-case-facts">{caseObj.facts}</p>
              <p className="dl-case-task"><strong>Your task:</strong> read the facts above and fill in the fields of the {label} below.</p>
            </section>
          )}

          <section className="dl-card">
            <div className="dl-fill-head">
              <h2 className="dl-h2">Fill in the fields</h2>
              <span className="dl-muted">{filledCount}/{fields.length}</span>
            </div>
            {fields.map((f) => (
              <div key={f.id} className="dl-field">
                <label className="dl-flabel" htmlFor={`f-${f.id}`}>{f.label}</label>
                {['facts', 'statements', 'grounds', 'apprehension_grounds', 'demand', 'purpose', 'prayer', 'subject'].includes(f.id)
                  ? <textarea id={`f-${f.id}`} className="dl-input dl-ta" rows={2} value={answers[f.id] || ''} placeholder={f.hint} onChange={(e) => setAnswer(f.id, e.target.value)} />
                  : <input id={`f-${f.id}`} className="dl-input" value={answers[f.id] || ''} placeholder={f.hint} onChange={(e) => setAnswer(f.id, e.target.value)} />}
              </div>
            ))}
            <div className="dl-actions">
              <button className="dl-btn dl-primary" onClick={onSubmit} disabled={filledCount === 0}>Submit for feedback →</button>
              <button className="dl-btn dl-ghost" onClick={startOver}>← Choose another draft</button>
            </div>
          </section>
        </>
      )}

      {phase === 'scoring' && (
        <section className="dl-card">
          <div className="dl-status"><span className="dl-spinner" />A senior advocate is reviewing your draft…</div>
        </section>
      )}

      {phase === 'scored' && result && (
        <>
          <section className="dl-card dl-score">
            <h2 className="dl-h2">Overall score: {result.overallScore}/100</h2>
            <div className="dl-subscores">
              <span>Structural completeness: {result.structuralCompleteness}/100</span>
              <span>Legal accuracy: {result.legalAccuracy}/100</span>
              <span>Clarity: {result.clarity}/100</span>
            </div>
          </section>

          <div className="dl-grid2">
            <section className="dl-card">
              <h2 className="dl-h2">Strengths</h2>
              <ul className="dl-list">
                {result.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </section>
            <section className="dl-card">
              <h2 className="dl-h2">Improvements</h2>
              <ul className="dl-list">
                {result.improvements.map((f, i) => <li key={i}><strong>{f.area}:</strong> {f.suggestion}</li>)}
              </ul>
            </section>
          </div>

          <p className="dl-disclaimer">{result.disclaimer}</p>
          <div className="dl-actions"><button className="dl-btn dl-ghost" onClick={startOver}>← Practise another draft</button></div>
        </>
      )}
    </section>
  );
}

const STYLES = `
.dl-root{--bg:#0e0e0e;--surface:#1a1a1a;--surface-2:#242424;--border:#343434;--text:#ededed;--muted:#9a9a9a;--accent:#d8d8d8;
  min-height:100vh;background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.dl-container{max-width:1000px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.dl-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.dl-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.dl-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.dl-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap;background:var(--surface);}
/* The two tab labels ("2-3 · Practice & Feedback") are wider than a 360px
   phone, and this row had no wrap — so the second tab ran off the right edge
   and pushed a horizontal scrollbar onto the whole page, which is what made
   every screen below it look misaligned. Wrapping, and letting each tab take
   an equal share of the row, keeps both on screen at any width. */
.dl-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;}
.dl-tab{flex:1 1 auto;font-family:inherit;font-size:14px;padding:8px 16px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--muted);cursor:pointer;}
.dl-tab.on{color:var(--text);border-color:var(--accent);background:var(--surface-2);}
.dl-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.dl-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.dl-error{color:#e6bcbc;border-color:#5a3a3a;}
.dl-types{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:18px;}
@media(min-width:640px){.dl-types{grid-template-columns:1fr 1fr;}}
.dl-type{font-family:inherit;font-size:15px;text-align:left;padding:14px 16px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.dl-type.sel{border-color:var(--accent);background:#2c2c2c;}
.dl-type:disabled{opacity:.5;cursor:not-allowed;}
.dl-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;}
.dl-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.dl-btn:disabled{opacity:.5;cursor:not-allowed;}
.dl-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.dl-ghost{background:transparent;color:var(--text);}
.dl-status{display:flex;align-items:center;gap:12px;color:var(--muted);margin-top:14px;}
.dl-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:dl-spin .8s linear infinite;}
@keyframes dl-spin{to{transform:rotate(360deg);}}
.dl-case{border-left:3px solid var(--accent);}
.dl-case-facts{color:var(--text);margin:0 0 10px;}
.dl-case-task{color:var(--muted);margin:0;}
.dl-grid2{display:grid;grid-template-columns:1fr;gap:18px;}
@media(min-width:820px){.dl-grid2{grid-template-columns:1fr 1fr;}}
.dl-fill-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;}
.dl-fill-head .dl-h2{margin:0;}
.dl-field{margin-bottom:12px;}
.dl-flabel{display:block;font-size:13px;color:var(--muted);margin-bottom:4px;}
.dl-input{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:Georgia,serif;font-size:14px;padding:10px 12px;}
.dl-input:focus{outline:none;border-color:var(--accent);}
.dl-ta{resize:vertical;line-height:1.5;}
.dl-pre{white-space:pre-wrap;word-break:break-word;font-family:Georgia,serif;font-size:13px;color:var(--text);margin:0 0 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:14px;max-height:420px;overflow:auto;}
.dl-muted{color:var(--muted);font-size:13px;}
.dl-note{color:var(--muted);font-style:italic;font-size:13px;margin:0 0 10px;}
.dl-links{display:flex;flex-direction:column;gap:6px;}
.dl-links a{color:var(--accent);font-size:13px;text-decoration:underline;}
.dl-anatomy-row{margin-bottom:10px;}
.dl-anatomy-row strong{display:block;font-size:14px;margin-bottom:2px;}
.dl-anatomy-row p{margin:0;color:var(--muted);font-size:13.5px;}
.dl-conf-badge{font-size:12px;font-weight:700;}
.dl-score{text-align:center;}
.dl-subscores{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;color:var(--muted);font-size:13.5px;margin-top:8px;}
.dl-list{margin:0;padding-left:18px;color:var(--text);font-size:14px;}
.dl-list li{margin-bottom:8px;}
.dl-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}

/* ── Phones (founder report, 2026-07-29: "UI in the phone is fucked up") ──
   Everything above was written desktop-first with only two breakpoints (640
   and 820), so on a real handset the page had several separate problems at
   once. Each rule below fixes one of them.

   Nothing here changes the desktop layout — the whole block is inside a
   max-width query. */
@media (max-width: 600px) {
  /* A page-level horizontal scroll makes every card look off-centre even
     when the card itself is fine. Belt-and-braces against any single wide
     child (a long unbroken case citation, a wide <pre>). */
  .dl-root { overflow-x: hidden; }

  /* Wrapping alone wasn't enough: side by side, "2-3 · Practice & Feedback"
     is squeezed so hard the label is unreadable. On a phone the two tabs get
     a full-width row each, so both labels are fully legible. */
  .dl-tabs { flex-direction: column; }
  .dl-tab { width: 100%; text-align: center; padding: 12px 16px; font-size: 15px; }

  /* space-between threw the "Drafting Lab" title and the badge to opposite
     ends of a narrow row, leaving a ragged gap between them. Stacked and
     left-aligned reads correctly at phone width. */
  .dl-header { flex-direction: column; align-items: flex-start; gap: 10px; }

  /* iOS Safari auto-zooms the whole page when a focused input's font-size is
     below 16px, and never zooms back out — so tapping the first field left
     the student on a permanently magnified, half-off-screen page. This is the
     single biggest cause of the "mismatched" look on iPhone. 16px exactly is
     the documented threshold. */
  .dl-input { font-size: 16px; }

  /* Two buttons of 22px side-padding do not fit side by side on a 360px
     screen; they wrapped into a lopsided stack with one full-width and one
     short. Full-width for both, in reading order. */
  .dl-actions { flex-direction: column; align-items: stretch; }
  .dl-btn { width: 100%; padding: 12px 16px; text-align: center; }

  /* The field-count ("3 of 8 filled") was being squeezed onto the same line
     as the heading and truncating. */
  .dl-fill-head { flex-direction: column; align-items: flex-start; gap: 4px; }

  /* Four sub-scores in one centred row collapsed into an uneven two-and-two
     block. A fixed two-column grid keeps them aligned. */
  .dl-subscores { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; text-align: center; }

  /* A generated draft is long; 420px of it on a phone is most of the screen
     and buries the buttons underneath. */
  .dl-pre { max-height: 260px; font-size: 14px; }
}
`;
