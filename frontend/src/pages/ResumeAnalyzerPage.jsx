/**
 * ResumeAnalyzerPage.jsx
 * Contract: _contracts/02-resume-analyzer.md
 *
 * Flow: pick PDF → validate → GET presigned URL → PUT to S3 → POST /analyze →
 *       poll GET /result/:docId until complete|failed → render 7-parameter feedback.
 * All API calls go through resumeAnalyzer.service.js (never axios/fetch here).
 *
 * Theme: black + grey, serif font, mobile-first responsive (works on iOS, Android,
 * Windows, tablets). All styling is in the scoped <style> block below so there is
 * no dependency on any CSS framework.
 *
 * 2026-07-22: added the "Download PDF" button (founder request) — calls
 * resumeAnalyzer.service.js's getReportUrl() for a fresh presigned S3 URL to the
 * report PDF the worker renders (same dark theme, see resumeAnalyzer.worker.js's
 * renderReportPdf) and opens it in a new tab.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  validateFile,
  getUploadUrl,
  uploadToS3,
  analyze,
  getResult,
  getHistory,
  getReportUrl,
} from '../services/resumeAnalyzer.service';

const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 90000;

const scoreLabel = (s) =>
  s >= 80 ? 'Strong' : s >= 60 ? 'Good' : s >= 40 ? 'Needs work' : 'Weak';

/**
 * Held back from students (2026-07-29). The dashboard card is already marked
 * "Coming soon" via FORCED_COMING_SOON in DashboardPage.jsx, but the route
 * still exists, so a student with a bookmark or a typed URL would otherwise
 * land on a feature whose upload fails. This gate closes that door.
 *
 * To bring the feature back: flip this to false AND remove 'resume-analyzer'
 * from FORCED_COMING_SOON. Nothing below has been changed or deleted.
 */
const COMING_SOON = true;

function ComingSoon() {
  return (
    <div className="ra-root">
      <div className="ra-container" style={{ textAlign: 'center', paddingTop: '18vh' }}>
        <h1 className="ra-title">Resume Analyzer</h1>
        <p className="ra-subtitle" style={{ marginBottom: 24 }}>Coming soon.</p>
        <p className="ra-subtitle">
          We&apos;re putting the finishing touches on this one. Every other feature is
          open — head back to your dashboard and carry on.
        </p>
        <a href="/dashboard" className="ra-btn" style={{ display: 'inline-block', marginTop: 28, textDecoration: 'none' }}>
          ← Back to dashboard
        </a>
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

export default function ResumeAnalyzerPage() {
  return COMING_SOON ? <ComingSoon /> : <ResumeAnalyzerFeature />;
}

// The real feature, untouched. Kept as its own component so the gate above is
// a plain swap rather than an early return before hooks (which would break the
// rules of hooks the moment COMING_SOON became dynamic).
function ResumeAnalyzerFeature() {
  const [file, setFile] = useState(null);
  const [clientError, setClientError] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | uploading | analyzing | done | failed
  const [failMessage, setFailMessage] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [currentDocId, setCurrentDocId] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const pollRef = useRef(null);
  const pollStartRef = useRef(0);
  const fileInputRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await getHistory();
      setHistory(data.history || []);
    } catch {
      /* history is non-critical — silent */
    }
  }, []);

  useEffect(() => {
    loadHistory();
    return stopPolling; // cleanup on unmount
  }, [loadHistory]);

  const onPick = (e) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    setClientError(f ? validateFile(f) || '' : '');
  };

  const reset = () => {
    stopPolling();
    setFile(null);
    setClientError('');
    setPhase('idle');
    setFailMessage('');
    setResult(null);
    setCurrentDocId(null);
    setDownloadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const beginPolling = (docId) => {
    stopPolling();
    pollStartRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setPhase('failed');
        setFailMessage('This is taking longer than expected. Please try again in a moment.');
        return;
      }
      try {
        const { data } = await getResult(docId);
        if (data.status === 'complete') {
          stopPolling();
          setResult(data.result);
          setPhase('done');
          loadHistory();
        } else if (data.status === 'failed') {
          stopPolling();
          setFailMessage(data.message || 'We could not analyse this file.');
          setPhase('failed');
        }
      } catch {
        stopPolling();
        setPhase('failed');
        setFailMessage('Something went wrong while checking your result. Please try again.');
      }
    }, POLL_MS);
  };

  const onAnalyze = async () => {
    const err = validateFile(file);
    if (err) {
      setClientError(err);
      return;
    }
    setClientError('');
    setResult(null);
    setFailMessage('');
    setDownloadError('');
    try {
      setPhase('uploading');
      const { data: presigned } = await getUploadUrl();
      await uploadToS3(presigned.uploadUrl, file);
      setPhase('analyzing');
      const { data: job } = await analyze(presigned.s3Key);
      setCurrentDocId(job.docId);
      beginPolling(job.docId);
    } catch (e) {
      setPhase('failed');
      setFailMessage(
        e?.response?.data?.error || e?.message || 'Upload failed. Please try again.'
      );
    }
  };

  const openResult = async (docId) => {
    setResult(null);
    setFailMessage('');
    setDownloadError('');
    setCurrentDocId(docId);
    setPhase('analyzing');
    try {
      const { data } = await getResult(docId);
      if (data.status === 'complete') {
        setResult(data.result);
        setPhase('done');
      } else if (data.status === 'failed') {
        setFailMessage(data.message || 'That analysis did not complete.');
        setPhase('failed');
      } else {
        beginPolling(docId);
      }
    } catch {
      setPhase('failed');
      setFailMessage('Could not open that analysis.');
    }
  };

  const onDownloadReport = async () => {
    if (!currentDocId || downloading) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const { data } = await getReportUrl(currentDocId);
      window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setDownloadError(
        e?.response?.data?.error || 'Could not prepare your download right now. Please try again.'
      );
    } finally {
      setDownloading(false);
    }
  };

  const busy = phase === 'uploading' || phase === 'analyzing';

  return (
    <div className="ra-root">
      <style>{RA_STYLES}</style>

      <div className="ra-container">
        <header className="ra-header">
          <div>
            <h1 className="ra-title">Résumé Analyzer</h1>
            <p className="ra-subtitle">
              Upload your law résumé (PDF, 1–3 pages). We score it across seven areas.
            </p>
          </div>
          <span className="ra-badge">Unlimited use</span>
        </header>

        {/* Upload card */}
        <section className="ra-card ra-upload">
          <label className="ra-drop" htmlFor="ra-file">
            <input
              id="ra-file"
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={onPick}
              className="ra-file-input"
              disabled={busy}
            />
            <span className="ra-drop-icon">⬆</span>
            <span className="ra-drop-main">{file ? file.name : 'Choose a PDF résumé'}</span>
            <span className="ra-drop-sub">
              {file
                ? `${(file.size / 1024).toFixed(0)} KB`
                : 'PDF only · 1–3 pages · max 5 MB'}
            </span>
          </label>

          {clientError && <p className="ra-error" role="alert">{clientError}</p>}

          <div className="ra-actions">
            <button
              className="ra-btn ra-btn-primary"
              onClick={onAnalyze}
              disabled={busy || !file || !!clientError}
            >
              {phase === 'uploading' ? 'Uploading…' : phase === 'analyzing' ? 'Analyzing…' : 'Analyze résumé'}
            </button>
            {(file || result || failMessage) && (
              <button className="ra-btn ra-btn-ghost" onClick={reset} disabled={busy}>
                Start over
              </button>
            )}
          </div>
        </section>

        {/* Progress */}
        {busy && (
          <section className="ra-card ra-status">
            <span className="ra-spinner" aria-hidden="true" />
            <span>
              {phase === 'uploading'
                ? 'Uploading your résumé securely…'
                : 'Reading and scoring your résumé…'}
            </span>
          </section>
        )}

        {/* Failure */}
        {phase === 'failed' && (
          <section className="ra-card ra-status ra-status-fail" role="alert">
            <span className="ra-fail-icon">!</span>
            <span>{failMessage}</span>
          </section>
        )}

        {/* Results */}
        {phase === 'done' && result && (
          <section className="ra-results">
            <div className="ra-card ra-overall">
              <div className="ra-overall-score">
                <span className="ra-overall-num">{result.overallScore}</span>
                <span className="ra-overall-den">/100</span>
              </div>
              <div className="ra-overall-body">
                <h2 className="ra-overall-label">{scoreLabel(result.overallScore)} résumé</h2>
                {result.summary && <p className="ra-overall-summary">{result.summary}</p>}
              </div>
              <div className="ra-overall-download">
                <button
                  className="ra-btn ra-btn-ghost ra-btn-download"
                  onClick={onDownloadReport}
                  disabled={downloading || !currentDocId}
                >
                  {downloading ? 'Preparing…' : '⬇ Download PDF'}
                </button>
              </div>
            </div>
            {downloadError && <p className="ra-error" role="alert">{downloadError}</p>}

            <div className="ra-grid">
              {result.parameters.map((p) => (
                <div className="ra-card ra-param" key={p.name}>
                  <div className="ra-param-head">
                    <h3 className="ra-param-name">{p.name}</h3>
                    <span className="ra-param-score">{p.score}</span>
                  </div>
                  <div className="ra-bar">
                    <div className="ra-bar-fill" style={{ width: `${p.score}%` }} />
                  </div>

                  {p.strengths?.length > 0 && (
                    <ul className="ra-list ra-list-good">
                      {p.strengths.map((s, i) => (
                        <li key={i}><span className="ra-mark">✓</span>{s}</li>
                      ))}
                    </ul>
                  )}
                  {p.improvements?.length > 0 && (
                    <ul className="ra-list ra-list-improve">
                      {p.improvements.map((s, i) => (
                        <li key={i}><span className="ra-mark">→</span>{s}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            <p className="ra-disclaimer">{result.disclaimer}</p>
          </section>
        )}

        {/* History */}
        {history.length > 0 && (
          <section className="ra-card ra-history">
            <h2 className="ra-history-title">Your past analyses</h2>
            <ul className="ra-history-list">
              {history.map((h) => (
                <li key={h.docId}>
                  <button
                    className="ra-history-item"
                    onClick={() => openResult(h.docId)}
                    disabled={busy}
                  >
                    <span className="ra-history-score">
                      {h.status === 'complete' && h.overallScore != null ? h.overallScore : '—'}
                    </span>
                    <span className="ra-history-meta">
                      <span className="ra-history-date">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                      <span className={`ra-history-status ra-hs-${h.status}`}>{h.status}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/* ── Scoped styles: black + grey, serif, fully responsive ─────────────────── */
const RA_STYLES = `
.ra-root {
  --bg: #090a0f; --surface: #12131a; --surface-2: #1c1e29; --border: rgba(212, 175, 55, 0.25);
  --text: #f8f5eb; --muted: #b8af94; --accent: #d4af37; --good: #ffd700; --improve: #c5a059;
  min-height: 100vh; background: radial-gradient(circle at 50% 10%, #15140f 0%, #07070a 70%); color: var(--text);
  font-family: 'Lora', Georgia, 'Times New Roman', 'Noto Serif', serif;
  -webkit-font-smoothing: antialiased; line-height: 1.5;
}
.ra-container { max-width: 960px; margin: 0 auto; padding: clamp(16px, 4vw, 40px); }
.ra-header {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  flex-wrap: wrap; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 20px;
}
.ra-title { font-size: clamp(24px, 5vw, 34px); margin: 0 0 6px; font-weight: 700; letter-spacing: .2px; }
.ra-subtitle { margin: 0; color: var(--muted); font-size: clamp(14px, 2.5vw, 16px); }
.ra-badge {
  border: 1px solid var(--border); color: var(--muted); border-radius: 999px;
  padding: 4px 12px; font-size: 12px; white-space: nowrap; background: var(--surface);
}
.ra-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: clamp(16px, 3vw, 24px); margin-bottom: 18px;
}
.ra-upload { display: flex; flex-direction: column; gap: 16px; }
.ra-drop {
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
  text-align: center; border: 1.5px dashed var(--border); border-radius: 12px;
  padding: clamp(24px, 6vw, 44px) 16px; cursor: pointer; transition: border-color .15s, background .15s;
  background: var(--surface-2);
}
.ra-drop:hover { border-color: var(--accent); }
.ra-file-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.ra-drop-icon { font-size: 26px; color: var(--muted); }
.ra-drop-main { font-size: clamp(15px, 3vw, 18px); word-break: break-word; }
.ra-drop-sub { font-size: 13px; color: var(--muted); }
.ra-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.ra-btn {
  font-family: inherit; font-size: 15px; border-radius: 10px; padding: 12px 22px;
  cursor: pointer; border: 1px solid var(--border); transition: opacity .15s, background .15s;
  flex: 1 1 auto; min-width: 140px;
}
.ra-btn:disabled { opacity: .5; cursor: not-allowed; }
.ra-btn-primary { background: var(--accent); color: #111; border-color: var(--accent); font-weight: 700; }
.ra-btn-primary:not(:disabled):hover { background: #fff; }
.ra-btn-ghost { background: transparent; color: var(--text); }
.ra-btn-ghost:not(:disabled):hover { background: var(--surface-2); }
.ra-btn-download { flex: none; min-width: 0; white-space: nowrap; }
.ra-error { color: #e0b4b4; margin: 0; font-size: 14px; }
.ra-status { display: flex; align-items: center; gap: 14px; color: var(--muted); }
.ra-status-fail { color: #e6bcbc; border-color: #5a3a3a; }
.ra-fail-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  border-radius: 50%; border: 1px solid currentColor; font-weight: 700; flex: none;
}
.ra-spinner {
  width: 22px; height: 22px; border-radius: 50%; flex: none;
  border: 2.5px solid var(--border); border-top-color: var(--accent);
  animation: ra-spin .8s linear infinite;
}
@keyframes ra-spin { to { transform: rotate(360deg); } }
.ra-overall { display: flex; align-items: center; gap: clamp(16px, 4vw, 28px); flex-wrap: wrap; }
.ra-overall-score { display: flex; align-items: baseline; }
.ra-overall-num { font-size: clamp(44px, 12vw, 68px); font-weight: 700; line-height: 1; }
.ra-overall-den { font-size: 20px; color: var(--muted); margin-left: 4px; }
.ra-overall-label { margin: 0 0 6px; font-size: clamp(18px, 3.5vw, 22px); }
.ra-overall-summary { margin: 0; color: var(--muted); }
.ra-overall-download { margin-left: auto; }
.ra-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 640px) { .ra-grid { grid-template-columns: 1fr 1fr; } }
.ra-param { margin-bottom: 0; }
.ra-param-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.ra-param-name { margin: 0; font-size: 16px; font-weight: 700; }
.ra-param-score { font-size: 20px; color: var(--accent); font-weight: 700; }
.ra-bar { height: 6px; background: var(--surface-2); border-radius: 999px; margin: 10px 0 14px; overflow: hidden; }
.ra-bar-fill { height: 100%; background: linear-gradient(90deg, #6f6f6f, #e2e2e2); border-radius: 999px; }
.ra-list { list-style: none; padding: 0; margin: 0 0 8px; }
.ra-list li { display: flex; gap: 8px; font-size: 14px; margin-bottom: 6px; color: var(--text); }
.ra-list-improve li { color: var(--muted); }
.ra-mark { flex: none; opacity: .8; }
.ra-list-good .ra-mark { color: var(--good); }
.ra-disclaimer {
  text-align: center; color: var(--muted); font-style: italic; font-size: 13px;
  border-top: 1px solid var(--border); padding-top: 16px; margin-top: 4px;
}
.ra-history-title { margin: 0 0 14px; font-size: 18px; }
.ra-history-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.ra-history-item {
  width: 100%; display: flex; align-items: center; gap: 14px; text-align: left; cursor: pointer;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; color: var(--text); font-family: inherit;
}
.ra-history-item:not(:disabled):hover { border-color: var(--accent); }
.ra-history-item:disabled { opacity: .6; cursor: not-allowed; }
.ra-history-score {
  font-size: 20px; font-weight: 700; width: 44px; text-align: center; flex: none; color: var(--accent);
}
.ra-history-meta { display: flex; flex-direction: column; gap: 2px; }
.ra-history-date { font-size: 14px; }
.ra-history-status { font-size: 12px; color: var(--muted); text-transform: capitalize; }
.ra-hs-failed { color: #d99a9a; }
.ra-hs-pending { color: #cbb58a; }
`;
