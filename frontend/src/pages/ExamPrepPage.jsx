/**
 * ExamPrepPage.jsx — Exam Prep v3
 * Contract: _contracts/01-exam-prep.md
 *
 * Modes: home | aibe | sppu | library
 *
 * TIMER NOTE: the countdown is driven from the server's `expiresAt`, never from
 * a local start time. A local timer drifts when the tab is backgrounded and can
 * be trivially frozen; recomputing `expiresAt - now` every second is immune to
 * both. At zero we auto-submit whatever exists. The server is still the
 * authority — it re-checks expiry on submit — this is just so the student is not
 * surprised.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getStructure, getActive,
  aibeGenerate, aibeSubmit,
  sppuGenerate, sppuSubmit,
  libraryList, libraryDownload,
} from '../services/examPrep.service';

const err = (e) => e?.response?.data?.error || 'Something went wrong. Please try again.';
const wc = (s) => (String(s || '').trim() ? String(s).trim().split(/\s+/).length : 0);

/** Countdown from a server ISO timestamp. Fires onExpire exactly once. */
function useCountdown(expiresAt, onExpire) {
  const [left, setLeft] = useState(null);
  const fired = useRef(false);
  const cb = useRef(onExpire);
  cb.current = onExpire;

  useEffect(() => {
    if (!expiresAt) { setLeft(null); fired.current = false; return undefined; }
    fired.current = false;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      const s = Math.max(0, Math.floor(ms / 1000));
      setLeft(s);
      if (s === 0 && !fired.current) { fired.current = true; cb.current?.(); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return left;
}

const hhmmss = (s) => {
  if (s === null || s === undefined) return '--:--:--';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return [h, m, x].map((n) => String(n).padStart(2, '0')).join(':');
};

export default function ExamPrepPage() {
  const [mode, setMode] = useState('home');
  const [structure, setStructure] = useState(null);
  const [resumable, setResumable] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Live paper (either kind) and its result.
  const [paper, setPaper] = useState(null);     // {kind, paperId, expiresAt, questions[], ...}
  const [answers, setAnswers] = useState([]);
  const [result, setResult] = useState(null);
  const [qIdx, setQIdx] = useState(0);

  // SPPU picker
  const [program, setProgram] = useState('');
  const [sem, setSem] = useState('');
  const [subject, setSubject] = useState('');

  // Library
  const [lib, setLib] = useState(null);
  const [libProgram, setLibProgram] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, a] = await Promise.all([getStructure(), getActive()]);
        if (!alive) return;
        setStructure(s.data);
        if (a.data?.active) setResumable(a.data.active);
      } catch (e) { if (alive) setError(err(e)); }
    })();
    return () => { alive = false; };
  }, []);

  const submitting = useRef(false);

  const doSubmit = useCallback(async (auto = false) => {
    if (!paper || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const payload = { paperId: paper.paperId, answers };
      const r = paper.kind === 'aibe' ? await aibeSubmit(payload) : await sppuSubmit(payload);
      setResult({ ...r.data, autoSubmitted: auto });
      setPaper(null);
    } catch (e) {
      setError(err(e));
      submitting.current = false; // let them retry a failed submit
    } finally { setBusy(false); }
  }, [paper, answers]);

  const secsLeft = useCountdown(paper?.expiresAt, () => doSubmit(true));

  function startPaper(data, kind) {
    setPaper({ ...data, kind });
    setAnswers(new Array((data.questions || []).length).fill(kind === 'aibe' ? null : ''));
    setResult(null); setQIdx(0); setResumable(null);
    submitting.current = false;
  }

  async function onAibeGenerate() {
    setBusy(true); setError('');
    try { startPaper((await aibeGenerate()).data, 'aibe'); }
    catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  }

  async function onSppuGenerate() {
    if (!program || !sem || !subject) { setError('Choose a program, semester and subject first.'); return; }
    setBusy(true); setError('');
    try {
      startPaper((await sppuGenerate({ program, semester: Number(sem), subject })).data, 'sppu');
    } catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  }

  async function onLibrary(pid) {
    setLibProgram(pid); setBusy(true); setError('');
    try { setLib((await libraryList({ program: pid })).data); }
    catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  }

  async function onDownload(id) {
    try {
      const r = await libraryDownload(id);
      if (r.data?.url) window.open(r.data.url, '_blank', 'noopener');
    } catch (e) { setError(err(e)); }
  }

  function resume() {
    const a = resumable;
    setMode(a.kind);
    setPaper({ ...a });
    setAnswers(new Array((a.questions || []).length).fill(a.kind === 'aibe' ? null : ''));
    setResult(null); setQIdx(0); setResumable(null);
    submitting.current = false;
  }

  function leave() {
    setPaper(null); setResult(null); setAnswers([]); setError('');
    submitting.current = false;
    setMode('home');
  }

  const progs = structure?.sppu?.programs || [];
  const selProg = progs.find((p) => p.id === program);
  const semList = selProg ? Object.keys(selProg.sems || {}).map(Number).sort((a, b) => a - b) : [];
  const subjList = selProg && sem ? (selProg.sems?.[sem] || []) : [];

  const answeredCount = paper?.kind === 'aibe'
    ? answers.filter((x) => x !== null).length
    : answers.filter((x) => String(x || '').trim()).length;

  return (
    <div className="ex-root">
      <style>{STYLES}</style>
      <div className="ex-container">

        <header className="ex-header">
          <div>
            <h1 className="ex-title">Exam Prep</h1>
            <p className="ex-subtitle">
              {paper
                ? (paper.kind === 'aibe'
                    ? `AIBE — ${paper.total || paper.questions.length} questions`
                    : `${paper.subject} — ${paper.totalMarks} marks`)
                : 'Bar Council (AIBE) and university (SPPU) papers, in the real format.'}
            </p>
          </div>
          <div className="ex-headright">
            {paper && (
              <span className={`ex-timer ${secsLeft !== null && secsLeft < 300 ? 'low' : ''}`}>
                {hhmmss(secsLeft)}
              </span>
            )}
            {!paper && structure && (
              <span className="ex-badge">
                {structure.aibeMonthlyLimit} AIBE + {structure.sppuMonthlyLimit} university / month
              </span>
            )}
          </div>
        </header>

        {error && <div className="ex-card ex-error">{error}</div>}

        {/* ── resume prompt ──────────────────────────────────────────────── */}
        {!paper && !result && resumable && (
          <div className="ex-card">
            <h2 className="ex-h2">You have a paper in progress</h2>
            <p className="ex-muted">
              {resumable.kind === 'aibe' ? 'AIBE full paper' : `${resumable.subject} — SPPU`}
              {' · '}resuming does not use another of your monthly papers.
            </p>
            <div className="ex-row">
              <button className="ex-btn ex-primary" onClick={resume}>Resume paper</button>
              <button className="ex-btn ex-ghost" onClick={() => setResumable(null)}>Discard</button>
            </div>
          </div>
        )}

        {/* ── result summary ─────────────────────────────────────────────── */}
        {result && (
          <>
            {result.autoSubmitted && (
              <div className="ex-card ex-warn">
                Time ran out — your paper was submitted automatically with the answers you had.
              </div>
            )}
            {result.expired && !result.autoSubmitted && (
              <div className="ex-card ex-warn">
                This paper was submitted after the time limit. It has been graded in full, but the
                overtime is recorded.
              </div>
            )}

            <div className="ex-card">
              <h2 className="ex-h2">Summary</h2>
              {typeof result.scorePct === 'number' ? (
                <>
                  <div className="ex-score">{result.score}<span>/{result.total}</span></div>
                  <p className="ex-muted">
                    {result.scorePct}% · pass mark {result.passPct}%
                    {' '}({result.passReservedPct}% for SC/ST/PwD) ·{' '}
                    <strong className={result.passed ? 'ex-ok' : 'ex-bad'}>
                      {result.passed ? 'Passed' : 'Not passed'}
                    </strong>
                    {' · '}attempted {result.attempted} of {result.total}
                  </p>
                </>
              ) : (
                <>
                  <div className="ex-score">{result.awarded}<span>/{result.outOf}</span></div>
                  <p className="ex-muted">
                    {result.overallPct}% of the {result.gradedOutOf} marks that could be graded.
                  </p>
                </>
              )}
              <p className="ex-muted">Time taken: {hhmmss(result.elapsedSec)} of {result.durationMin} minutes.</p>
            </div>

            {result.bySubject && (
              <div className="ex-card">
                <h2 className="ex-h2">Subject breakdown</h2>
                <table className="ex-table">
                  <tbody>
                    {Object.entries(result.bySubject).map(([s, v]) => (
                      <tr key={s}>
                        <td>{s}</td>
                        <td className="ex-num">{v.correct}/{v.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.results?.map((r, i) => (
              <div className="ex-card" key={i}>
                <div className="ex-qhead">
                  <span className="ex-qnum">Q{i + 1}</span>
                  {r.marks !== undefined
                    ? <span className="ex-badge">Part {r.part} · {r.awarded === null ? '—' : r.awarded}/{r.marks}</span>
                    : <span className={`ex-badge ${r.isCorrect ? 'ok' : 'bad'}`}>{r.isCorrect ? 'Correct' : 'Wrong'}</span>}
                </div>
                <p className="ex-q">{r.q}</p>

                {r.options && (
                  <ol className="ex-opts">
                    {r.options.map((o, oi) => (
                      <li key={oi} className={oi === r.correct ? 'right' : (oi === r.chosen ? 'wrong' : '')}>{o}</li>
                    ))}
                  </ol>
                )}

                {r.yourAnswer !== undefined && (
                  <>
                    <p className="ex-label">Your answer</p>
                    <p className="ex-ans">{r.yourAnswer || <em className="ex-muted">Not answered.</em>}</p>
                    <p className="ex-label">Feedback</p>
                    <p className="ex-fb">{r.feedback}</p>
                    {r.modelPoints && (
                      <>
                        <p className="ex-label">What a full-marks answer covers</p>
                        <p className="ex-muted">{r.modelPoints}</p>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}

            <p className="ex-disclaimer">{result.disclaimer}</p>
            <button className="ex-btn ex-ghost" onClick={leave}>Back to Exam Prep</button>
          </>
        )}

        {/* ── live paper ─────────────────────────────────────────────────── */}
        {paper && !result && (
          <>
            <div className="ex-card ex-note">{paper.practiceNote}</div>

            {paper.kind === 'aibe' ? (
              <>
                <div className="ex-card">
                  <div className="ex-qhead">
                    <span className="ex-qnum">Question {qIdx + 1} of {paper.questions.length}</span>
                    <span className="ex-badge">{paper.questions[qIdx]?.subject}</span>
                  </div>
                  <p className="ex-q">{paper.questions[qIdx]?.q}</p>
                  <div className="ex-optlist">
                    {(paper.questions[qIdx]?.options || []).map((o, oi) => (
                      <button
                        key={oi}
                        type="button"
                        className={`ex-opt ${answers[qIdx] === oi ? 'sel' : ''}`}
                        onClick={() => setAnswers((a) => { const n = [...a]; n[qIdx] = (n[qIdx] === oi ? null : oi); return n; })}
                      >
                        <span className="ex-optkey">{'ABCD'[oi]}</span>{o}
                      </button>
                    ))}
                  </div>
                  <div className="ex-row">
                    <button className="ex-btn ex-ghost" disabled={qIdx === 0} onClick={() => setQIdx((i) => i - 1)}>Previous</button>
                    <button
                      className="ex-btn ex-ghost"
                      disabled={qIdx >= paper.questions.length - 1}
                      onClick={() => setQIdx((i) => i + 1)}
                    >Next</button>
                  </div>
                </div>

                <div className="ex-card">
                  <h2 className="ex-h2">Question palette — {answeredCount} of {paper.questions.length} answered</h2>
                  <div className="ex-palette">
                    {paper.questions.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`ex-pal ${answers[i] !== null ? 'done' : ''} ${i === qIdx ? 'cur' : ''}`}
                        onClick={() => setQIdx(i)}
                      >{i + 1}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              paper.questions.map((q, i) => (
                <div className="ex-card" key={i}>
                  <div className="ex-qhead">
                    <span className="ex-qnum">Q{i + 1} · Part {q.part}</span>
                    <span className="ex-badge">{q.marks} marks · max {q.maxWords} words</span>
                  </div>
                  <p className="ex-q">{q.q}</p>
                  <textarea
                    className="ex-input ex-textarea"
                    rows={8}
                    value={answers[i] || ''}
                    placeholder="Write your answer here…"
                    onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })}
                  />
                  <p className={`ex-count ${wc(answers[i]) > q.maxWords ? 'over' : ''}`}>
                    {wc(answers[i])} / {q.maxWords} words
                    {wc(answers[i]) > q.maxWords && ' — anything past the limit is not marked.'}
                  </p>
                </div>
              ))
            )}

            <div className="ex-card">
              <div className="ex-row">
                <button className="ex-btn ex-primary" disabled={busy} onClick={() => doSubmit(false)}>
                  {busy ? <span className="ex-spinner" /> : 'Submit paper'}
                </button>
                <button className="ex-btn ex-ghost" disabled={busy} onClick={leave}>Leave (paper is kept)</button>
              </div>
              <p className="ex-muted">
                {answeredCount} answered. When the timer reaches zero this paper is submitted automatically.
              </p>
            </div>
          </>
        )}

        {/* ── home ───────────────────────────────────────────────────────── */}
        {!paper && !result && mode === 'home' && structure && (
          <>
            <div className="ex-card">
              <h2 className="ex-h2">{structure.aibe.label}</h2>
              <p className="ex-muted">
                {structure.aibe.totalQuestions} multiple-choice questions across the official subject
                weightage · {structure.aibe.durationMin} minutes · no negative marking ·
                pass {structure.aibe.passGeneralPct}% ({structure.aibe.passReservedPct}% SC/ST/PwD).
              </p>
              <button className="ex-btn ex-primary" onClick={() => setMode('aibe')}>Open AIBE</button>
            </div>

            <div className="ex-card">
              <h2 className="ex-h2">{structure.sppu.label}</h2>
              <p className="ex-muted">
                Full {structure.sppu.totalMarks}-mark written paper — {structure.sppu.parts.map((p) => `Part ${p.part}: ${p.count}×${p.marks}`).join(', ')} ·
                {' '}{structure.sppu.durationMin} minutes · AI-graded with per-question feedback.
              </p>
              <button className="ex-btn ex-primary" onClick={() => setMode('sppu')}>Open University Exam</button>
            </div>

            <div className="ex-card">
              <h2 className="ex-h2">Library</h2>
              <p className="ex-muted">Past question papers and official sources.</p>
              <button className="ex-btn ex-primary" onClick={() => setMode('library')}>Open Library</button>
              <span className="ex-soon-tag">Coming soon</span>
            </div>
          </>
        )}

        {/* ── AIBE start ─────────────────────────────────────────────────── */}
        {!paper && !result && mode === 'aibe' && structure && (
          <>
            <div className="ex-card">
              <h2 className="ex-h2">Subject weightage</h2>
              <table className="ex-table">
                <tbody>
                  {structure.aibe.subjects.map((s) => (
                    <tr key={s.name}><td>{s.name}</td><td className="ex-num">{s.weight}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ex-card">
              <p className="ex-muted">
                Once you start, the {structure.aibe.durationMin}-minute timer runs on the server and
                cannot be paused. Generating a paper uses one of your {structure.aibeMonthlyLimit} AIBE
                papers this month. Your {structure.sppuMonthlyLimit} university papers are counted separately
                and are not affected.
              </p>
              <div className="ex-row">
                <button className="ex-btn ex-primary" disabled={busy} onClick={onAibeGenerate}>
                  {busy ? <span className="ex-spinner" /> : 'Start AIBE paper'}
                </button>
                <button className="ex-btn ex-ghost" disabled={busy} onClick={() => setMode('home')}>Back</button>
              </div>
              {busy && <p className="ex-muted">Building your paper — this takes about a minute.</p>}
            </div>
          </>
        )}

        {/* ── SPPU start ─────────────────────────────────────────────────── */}
        {!paper && !result && mode === 'sppu' && structure && (
          <>
            <div className="ex-card">
              <h2 className="ex-h2">Paper format</h2>
              <table className="ex-table">
                <thead><tr><th>Part</th><th>Questions</th><th className="ex-num">Marks</th><th className="ex-num">Words</th></tr></thead>
                <tbody>
                  {structure.sppu.parts.map((p) => (
                    <tr key={p.part}>
                      <td>{p.part} — {p.label}</td>
                      <td>{p.count}</td>
                      <td className="ex-num">{p.marks} each</td>
                      <td className="ex-num">≤{p.maxWords}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ex-card">
              <h2 className="ex-h2">Choose your paper</h2>
              <div className="ex-chips">
                {progs.map((p) => (
                  <button
                    key={p.id}
                    className={`ex-chip ${program === p.id ? 'sel' : ''}`}
                    onClick={() => { setProgram(p.id); setSem(''); setSubject(''); }}
                  >{p.label}</button>
                ))}
              </div>

              {selProg && (
                <>
                  <p className="ex-label">Semester</p>
                  <div className="ex-chips">
                    {semList.map((s) => (
                      <button
                        key={s}
                        className={`ex-chip ${Number(sem) === s ? 'sel' : ''}`}
                        onClick={() => { setSem(s); setSubject(''); }}
                      >Sem {s}</button>
                    ))}
                  </div>
                </>
              )}

              {sem && (
                <>
                  <p className="ex-label">Subject</p>
                  <div className="ex-chips">
                    {subjList.map((s) => (
                      <button key={s} className={`ex-chip ${subject === s ? 'sel' : ''}`} onClick={() => setSubject(s)}>{s}</button>
                    ))}
                  </div>
                </>
              )}

              <p className="ex-muted">
                The {structure.sppu.durationMin}-minute timer starts as soon as the paper is
                generated. This uses one of your {structure.sppuMonthlyLimit} university papers this
                month; your AIBE papers are counted separately.
              </p>
              <div className="ex-row">
                <button className="ex-btn ex-primary" disabled={busy || !subject} onClick={onSppuGenerate}>
                  {busy ? <span className="ex-spinner" /> : 'Start paper'}
                </button>
                <button className="ex-btn ex-ghost" disabled={busy} onClick={() => setMode('home')}>Back</button>
              </div>
            </div>
          </>
        )}

        {/* ── library ────────────────────────────────────────────────────── */}
        {/*
          COMING SOON — founder decision 2026-07-28. The PYQ links were not
          resolving to the right papers, so rather than ship a Library that
          sends students to the wrong document, the whole tab is held back.
          Nothing is rendered but the words: no program chips, no table, no
          official-source links. The backend routes (/library, /library/:id/
          download) are deliberately left in place and untouched — they are
          auth-gated and simply go uncalled, so restoring this view later is a
          matter of putting the markup back, with no server-side work.
        */}
        {!paper && !result && mode === 'library' && (
          <div className="ex-soon">
            <span className="ex-soon-text">COMING SOON</span>
            <button className="ex-btn ex-ghost" onClick={() => setMode('home')}>Back</button>
          </div>
        )}

        {!structure && !error && <div className="ex-card"><span className="ex-spinner" /></div>}

        {/* mode !== 'library' — the Coming Soon panel shows nothing but the words. */}
        {structure && !result && mode !== 'library' && <p className="ex-disclaimer">{structure.disclaimer}</p>}
      </div>
    </div>
  );
}

const STYLES = `
.ex-root{--bg:#0e0e0e;--surface:#1a1a1a;--surface-2:#242424;--border:#343434;--text:#ededed;--muted:#9a9a9a;--accent:#d8d8d8;--rec:#c96b6b;--ok:#7fbf7f;
  min-height:100vh;background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.ex-container{max-width:900px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.ex-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.ex-headright{display:flex;align-items:center;gap:10px;}
.ex-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.ex-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.ex-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;background:var(--surface);white-space:nowrap;}
.ex-badge.ok{color:var(--ok);border-color:#3d5a3d;}
.ex-badge.bad{color:#e6bcbc;border-color:#5a3a3a;}
.ex-timer{font-variant-numeric:tabular-nums;font-size:clamp(20px,4vw,28px);font-weight:700;border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:6px 14px;}
.ex-timer.low{color:var(--rec);border-color:#5a3a3a;}
.ex-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.ex-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.ex-error{color:#e6bcbc;border-color:#5a3a3a;}
.ex-warn{color:#e6d5bc;border-color:#5a4d3a;}
.ex-note{color:var(--muted);font-size:14px;padding:12px 16px;}
.ex-muted{color:var(--muted);font-size:14px;margin:8px 0;}
.ex-ok{color:var(--ok);}
.ex-bad{color:var(--rec);}
.ex-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 6px;}
.ex-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
.ex-chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;}
.ex-chip{font-family:inherit;font-size:15px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.ex-chip.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.ex-input{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:15px;padding:12px 14px;}
.ex-textarea{resize:vertical;line-height:1.6;}
.ex-count{color:var(--muted);font-size:12px;margin:6px 0 0;text-align:right;}
.ex-count.over{color:var(--rec);}
.ex-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.ex-btn:disabled{opacity:.5;cursor:not-allowed;}
.ex-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.ex-ghost{background:transparent;color:var(--text);}
.ex-small{padding:6px 14px;font-size:13px;}
.ex-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:ex-spin .8s linear infinite;display:inline-block;}
@keyframes ex-spin{to{transform:rotate(360deg);}}
.ex-qhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
.ex-qnum{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.08em;}
.ex-q{margin:0 0 14px;font-size:16px;}
.ex-optlist{display:flex;flex-direction:column;gap:8px;}
.ex-opt{font-family:inherit;font-size:15px;text-align:left;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;display:flex;gap:12px;}
.ex-opt.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.ex-optkey{opacity:.6;}
.ex-opts{margin:0;padding-left:20px;color:var(--muted);font-size:14px;}
.ex-opts li.right{color:var(--ok);font-weight:700;}
.ex-opts li.wrong{color:var(--rec);}
.ex-palette{display:flex;flex-wrap:wrap;gap:6px;}
.ex-pal{width:38px;height:34px;font-family:inherit;font-size:13px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);cursor:pointer;}
.ex-pal.done{background:var(--surface-2);color:var(--text);border-color:#5a5a5a;font-weight:700;}
.ex-pal.cur{outline:2px solid var(--accent);}
.ex-score{font-size:clamp(32px,7vw,48px);font-weight:700;}
.ex-score span{color:var(--muted);font-size:.5em;}
.ex-table{width:100%;border-collapse:collapse;font-size:14px;}
.ex-table th{text-align:left;color:var(--muted);font-weight:400;font-size:12px;text-transform:uppercase;letter-spacing:.08em;padding:6px 8px;border-bottom:1px solid var(--border);}
.ex-table td{padding:8px;border-bottom:1px solid var(--border);}
.ex-table tr:last-child td{border-bottom:none;}
.ex-num{text-align:right;font-variant-numeric:tabular-nums;}
.ex-ans{white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:14px;margin:0;}
.ex-fb{font-size:14px;margin:0;}
.ex-links{margin:0;padding-left:20px;font-size:14px;}
.ex-links a{color:var(--text);}
.ex-disclaimer{color:var(--muted);font-size:12px;font-style:italic;margin:24px 0 0;text-align:center;}

/* Coming Soon (Library, held back 2026-07-28). Deliberately NOT an .ex-card:
   no surface fill, no border, no padding chrome — pure black behind bold white
   text, in the same Georgia serif the rest of the portal uses (inherited, not
   redeclared, so it can never drift from the page font). min-height keeps the
   words vertically centred instead of hugging the header. */
.ex-soon{background:#000;min-height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;border-radius:14px;}
.ex-soon-text{color:#fff;font-weight:700;font-size:30px;letter-spacing:.14em;}
/* Small tag on the Library card on the home screen, so a student knows before
   clicking rather than after. */
.ex-soon-tag{display:inline-block;margin-left:10px;color:var(--muted);font-size:12px;font-style:italic;vertical-align:middle;}
`;
