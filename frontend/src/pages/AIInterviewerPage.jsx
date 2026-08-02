/**
 * AIInterviewerPage.jsx — v3
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Flow: name → role → difficulty tier → optional resume → "Start Interview"
 * → interview room (chat UI, one question at a time, mic fixed at bottom)
 * → summary.
 *
 * Voice, per the founders' spec:
 *   - TTS: the BROWSER'S OWN built-in voice (window.speechSynthesis) — never
 *     a third-party provider. As of v3.1 (founder decision 2026-07-29) the
 *     old "rank every installed voice" heuristic is GONE: the picker now
 *     offers only the two approved voices for the student's platform —
 *     Rishi / Samantha on Apple, Ria / Rachel on Android+Windows — from the
 *     shared roster in services/voices.js, which is also what Court
 *     Simulation uses. Real-world limitation (documented in the contract,
 *     not hidden here): the Web Speech API only exposes whatever voices the
 *     browser/OS shipped, so a device carrying none of the approved four
 *     falls back to the browser's own default rather than going mute.
 *   - STT: window.SpeechRecognition / webkitSpeechRecognition (browser-native,
 *     already this app's established pattern elsewhere).
 *
 * Mic button is disabled until the current question's TTS playback finishes.
 * Tap to start listening (live transcript fills the box as you speak); tap
 * again to stop — a checkmark (submit) and a cross (discard & retry) then
 * appear, and the transcribed text stays editable until you confirm.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { getOptions, startSession, getSession, submitAnswer, finishSession } from '../services/aiInterviewer.service';
import { getHistory as getResumeHistory } from '../services/resumeAnalyzer.service';
import { resolveApprovedVoices, findApprovedById, speechRate, SPEECH_SPEEDS, DEFAULT_SPEECH_SPEED, IS_ANDROID } from '../services/voices';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const POLL_MS = 2000;
// Persists just enough to resume an in-progress interview after an accidental
// refresh (common on mobile) — a session already burned one of the 16
// monthly slots, so losing it silently on refresh is worse than resuming it.
const SESSION_STORAGE_KEY = 'vfl_ai_interviewer_session';
// Remembers a manually-picked voice per browser/device. The stored value is
// the roster id ('rishi' | 'samantha' | 'ria' | 'rachel'), not the old raw
// "name::lang" key — hence the new key name; a stale v3 value simply fails to
// resolve and the student falls back to the default first voice.
const VOICE_STORAGE_KEY = 'vfl_ai_interviewer_voice_id';
// Playback speed (0.5x / 1x / 1.5x / 2x), same control as Court Simulation.
const SPEED_KEY = 'vfl_ai_interviewer_speech_speed';

export default function AIInterviewerPage() {
  const [phase, setPhase] = useState('setup'); // setup | preparing | room | finishing | summary
  const [error, setError] = useState('');

  // setup fields
  const [name, setName] = useState('');
  const [roles, setRoles] = useState([]);
  const [role, setRole] = useState('');
  const [difficulty, setDifficulty] = useState('easy');
  const [tierInfo, setTierInfo] = useState([]);
  const [resumes, setResumes] = useState([]);
  const [resumeDocId, setResumeDocId] = useState('');
  const [voiceOptions, setVoiceOptions] = useState([]); // approved roster for this device
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [speed, setSpeed] = useState(() => {
    try { return Number(localStorage.getItem(SPEED_KEY)) || DEFAULT_SPEECH_SPEED; } catch { return DEFAULT_SPEECH_SPEED; }
  });

  // room state
  const [sessionId, setSessionId] = useState('');
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [chat, setChat] = useState([]); // [{type:'q'|'a', text}]
  const [speaking, setSpeaking] = useState(false);       // TTS in progress → mic disabled
  const [micState, setMicState] = useState('idle');      // idle | listening | review
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);

  const voiceRef = useRef(null);
  // speak() is a useCallback with no deps, so it must read the current speed
  // from a ref rather than closing over the state value.
  const speedRef = useRef(speed);
  const recognitionRef = useRef(null);
  const listeningRef = useRef(false);
  const answerStartRef = useRef(0);
  const metricsRef = useRef({ words: 0, sec: 0, voiceLevel: 0 });
  const pollRef = useRef(null);
  const chatEndRef = useRef(null);

  // voice-level metering (Web Audio API) — real mic amplitude, not a guess
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const meterAccumRef = useRef({ sum: 0, count: 0 });
  const speakWatchdogRef = useRef(null);
  const ttsUnlockedRef = useRef(false);

  // ── load options + resume history + pick a voice ──────────────────────────
  useEffect(() => {
    getOptions().then(({ data }) => {
      setRoles(data.roles || []);
      setRole((data.roles || [])[0] || '');
      setTierInfo(data.difficulties || []);
    }).catch(() => {});
    getResumeHistory().then(({ data }) => {
      setResumes((data.history || []).filter((h) => h.status === 'complete'));
    }).catch(() => {});

    const loadVoice = () => {
      const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      if (!voices.length) return;
      const approved = resolveApprovedVoices(voices);
      setVoiceOptions(approved);
      if (!approved.length) return; // none of the four here — use the browser default

      let saved = null;
      try { saved = localStorage.getItem(VOICE_STORAGE_KEY); } catch {}
      const chosen = findApprovedById(approved, saved) || approved[0];
      voiceRef.current = chosen.voice;
      setSelectedVoiceId(chosen.id);
    };
    loadVoice();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = loadVoice;

    // Resume an interview that was already started before a refresh, rather
    // than silently orphaning it (it already used one of the 16/month slots).
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
      if (saved?.sessionId) {
        setSessionId(saved.sessionId);
        setDifficulty(saved.difficulty || 'easy');
        setRole(saved.role || '');
        setPhase('preparing');
        resumeExistingSession(saved.sessionId);
      }
    } catch { /* corrupt/absent storage — just start fresh via 'setup' */ }

    return () => { cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat, micState]);

  const cleanup = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (speakWatchdogRef.current) clearTimeout(speakWatchdogRef.current);
    try { recognitionRef.current && recognitionRef.current.stop(); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  // iOS Safari/WebKit (including Chrome-on-iOS, which is required by Apple to
  // use Safari's engine) only allows speechSynthesis.speak() to actually
  // produce sound when it's called synchronously inside a direct user tap —
  // any call made later (e.g. after an awaited fetch, or from a setInterval
  // callback) silently no-ops with no error. Once ONE utterance has
  // successfully been triggered directly from a tap, the page stays
  // "unlocked" for the rest of its lifetime, so we fire a near-silent
  // primer utterance on the very first tap of "Start Interview" (a real
  // button click, before any await runs) to unlock audio for every question
  // spoken afterwards, including ones triggered from async code.
  const unlockSpeechSynthesis = () => {
    if (ttsUnlockedRef.current || !window.speechSynthesis) return;
    ttsUnlockedRef.current = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0.01;
      window.speechSynthesis.speak(u);
    } catch {}
  };

  // ── voice-level metering ────────────────────────────────────────────────
  const ensureMicStream = async () => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioCtxRef.current = ctx; analyserRef.current = analyser;
    } catch {}
    return stream;
  };

  const startMeter = () => {
    meterAccumRef.current = { sum: 0, count: 0 };
    const analyser = analyserRef.current;
    if (!analyser) return;
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(100, Math.round(rms * 320)); // scale RMS → 0-100
      meterAccumRef.current.sum += level; meterAccumRef.current.count += 1;
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // Hand the microphone back to the OS. On Android this is not optional —
  // see startListening() below.
  const releaseMicStream = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  };

  const stopMeter = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const { sum, count } = meterAccumRef.current;
    return count ? Math.round(sum / count) : 0;
  };

  // ── TTS ─────────────────────────────────────────────────────────────────
  // The mic is disabled while `speaking` is true, so a browser where TTS
  // silently fails (iOS WebKit not unlocked, no voices installed, etc.) must
  // never leave `speaking` stuck true forever — that would permanently lock
  // the mic with no way to answer. A watchdog timeout (estimated speaking
  // duration + a generous buffer) always clears it even if onend/onerror
  // never fire, which is a known WebKit failure mode, not a hypothetical one.
  const speak = useCallback((text) => {
    if (speakWatchdogRef.current) { clearTimeout(speakWatchdogRef.current); speakWatchdogRef.current = null; }
    if (!window.speechSynthesis || !text) { setSpeaking(false); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) u.voice = voiceRef.current;
    u.lang = voiceRef.current?.lang || 'en-IN';
    u.rate = speechRate(speedRef.current);
    setSpeaking(true);
    const clearSpeaking = () => {
      setSpeaking(false);
      if (speakWatchdogRef.current) { clearTimeout(speakWatchdogRef.current); speakWatchdogRef.current = null; }
    };
    u.onend = clearSpeaking;
    u.onerror = clearSpeaking;
    window.speechSynthesis.speak(u);
    // ~14 chars/sec at rate 1 is a safe lower bound for reading speed; divided
    // by the chosen speed so a 0.5x reading isn't cut off, +5s buffer covers
    // slow voices, then force-unlock the mic regardless.
    const estimatedMs = Math.max(2500, Math.round((text.length / 14 / (speedRef.current || 1)) * 1000) + 5000);
    speakWatchdogRef.current = setTimeout(clearSpeaking, estimatedMs);
  }, []);

  // Lets a student choose between the two approved voices for their device.
  // Persisted per-browser by roster id so the choice sticks.
  const onVoiceChange = (id) => {
    const entry = findApprovedById(voiceOptions, id);
    if (!entry) return;
    setSelectedVoiceId(id);
    voiceRef.current = entry.voice;
    try { localStorage.setItem(VOICE_STORAGE_KEY, id); } catch {}
  };

  // Speed control. A rate is fixed once an utterance starts, so a change made
  // while the interviewer is mid-question applies from the next question on.
  const onSpeedChange = (s) => {
    setSpeed(s);
    speedRef.current = s;
    try { localStorage.setItem(SPEED_KEY, String(s)); } catch {}
  };

  const onTestVoice = () => {
    unlockSpeechSynthesis();
    speak("Hello, I'll be asking your interview questions today. This is a quick voice test.");
  };

  // ── STT ─────────────────────────────────────────────────────────────────
  const startListening = async () => {
    setTranscript('');

    // ANDROID (founder report, 2026-07-29): "Speech Recognition and Synthesis
    // from Google cannot record now as Chrome is recording."
    //
    // On Android, SpeechRecognition runs in a SEPARATE system process
    // (Google's speech service) that demands exclusive access to the mic. The
    // getUserMedia stream we open purely to drive the voice-level meter holds
    // that lock, so rec.start() is refused with the message above and the mic
    // never listens. Desktop Chrome and iOS WebKit share the mic without
    // complaint — which is exactly why this only ever broke on Android.
    //
    // Fix: on Android give up the level meter (cosmetic) to get working
    // speech-to-text (essential). Android Chrome prompts for mic permission on
    // rec.start() itself, so nothing is lost but the level bar. The answer's
    // voiceLevel metric simply reports 0 there.
    if (IS_ANDROID) {
      releaseMicStream();
      meterAccumRef.current = { sum: 0, count: 0 };
    } else {
      try { await ensureMicStream(); startMeter(); } catch { /* mic permission denied — voice level stays 0, STT below may still work or also fail */ }
    }

    if (!SR) { setMicState('review'); return; } // no browser STT — fall back to manual typing
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    // Android's recogniser ends after each pause regardless of `continuous`;
    // asking for it there only produces spurious errors. onend restarts it
    // while the student is still answering, which gives continuous behaviour
    // on every platform.
    rec.continuous = !IS_ANDROID;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + ' ';
        else interim += t;
      }
      setTranscript((finalText + interim).trim());
    };
    // Restart on a small delay: Android throws InvalidStateError on an
    // immediate start() from inside onend, which silently killed the loop and
    // left the student talking to a dead mic.
    rec.onend = () => {
      if (!listeningRef.current) return;
      setTimeout(() => { if (listeningRef.current) { try { rec.start(); } catch {} } }, 250);
    };
    // This was empty, so every recognition failure was invisible — the student
    // held the mic open and nothing happened, with no idea why. 'no-speech'
    // and 'aborted' are normal punctuation of an answer and the restart above
    // covers them; only the terminal errors are worth showing.
    rec.onerror = (e) => {
      const err = e?.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        listeningRef.current = false;
        setError('Your browser blocked the microphone. Allow mic access for this site, or type your answer instead.');
        setMicState('review');
      } else if (err === 'audio-capture') {
        listeningRef.current = false;
        setError('Another app is using the microphone. Close it and tap the mic again, or type your answer instead.');
        setMicState('review');
      }
    };
    recognitionRef.current = rec;
    listeningRef.current = true;
    answerStartRef.current = Date.now();
    setMicState('listening');
    try { rec.start(); } catch { setMicState('review'); }
  };

  const stopListening = () => {
    listeningRef.current = false;
    try { recognitionRef.current && recognitionRef.current.stop(); } catch {}
    const avgVoiceLevel = stopMeter();
    const sec = Math.max(1, Math.round((Date.now() - answerStartRef.current) / 1000));
    metricsRef.current = { words: transcript.trim().split(/\s+/).filter(Boolean).length, sec, voiceLevel: avgVoiceLevel };
    setMicState('review');
  };

  const onMicClick = () => {
    if (speaking || busy) return;
    if (micState === 'idle') startListening();
    else if (micState === 'listening') stopListening();
  };

  const discardAnswer = () => {
    setTranscript('');
    setMicState('idle');
  };

  // ── flow ────────────────────────────────────────────────────────────────
  const askQuestion = (list, i) => {
    setIdx(i);
    setChat((c) => [...c, { type: 'q', text: list[i] }]);
    setTranscript(''); setMicState('idle');
    speak(list[i]);
  };

  const onBeginInterview = async () => {
    unlockSpeechSynthesis(); // must run synchronously inside this tap, before any await — see unlockSpeechSynthesis()
    if (!name.trim()) { setError('Please enter your name.'); return; }
    setBusy(true); setError('');
    try {
      const { data } = await startSession({ difficulty, role, resume_doc_id: resumeDocId || undefined });
      setSessionId(data.sessionId);
      setPhase('preparing');
      try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ sessionId: data.sessionId, difficulty, role })); } catch {}
      pollForQuestions(data.sessionId);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not start the interview.');
    } finally { setBusy(false); }
  };

  // Resumes an interview that was already 'preparing'/'active' before a page
  // refresh. We don't have the old chat transcript back (it wasn't persisted
  // client-side), so we just re-enter at the current turn — the student sees
  // the current/next question rather than losing the session entirely.
  const resumeExistingSession = async (sid) => {
    try {
      const { data } = await getSession(sid);
      if (data.status === 'preparing') { pollForQuestions(sid); return; }
      if (data.status === 'active') {
        const qs = data.questions || [];
        const resumeIdx = Math.min(data.turnCount || 0, Math.max(0, qs.length - 1));
        setQuestions(qs);
        setChat([]);
        setPhase('room');
        if (qs.length > 0) askQuestion(qs, resumeIdx);
        else { setPhase('setup'); try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {} }
        return;
      }
      // failed / complete / not found — nothing to resume, start fresh
      try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
      setPhase('setup');
    } catch {
      try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
      setPhase('setup');
    }
  };

  const pollForQuestions = (sid) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await getSession(sid);
        if (data.status === 'active') {
          clearInterval(pollRef.current);
          const qs = data.questions || [];
          setQuestions(qs);
          setChat([]);
          setPhase('room');
          askQuestion(qs, 0);
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current); setPhase('setup');
          setError('Could not prepare your interview. Please try again.');
        }
      } catch { clearInterval(pollRef.current); setPhase('setup'); setError('Connection problem. Please try again.'); }
    }, POLL_MS);
  };

  const onConfirmAnswer = async () => {
    const answer = transcript.trim();
    if (!answer || busy) return;
    setBusy(true); setError('');
    setChat((c) => [...c, { type: 'a', text: answer }]);
    const { words, sec, voiceLevel } = metricsRef.current;
    try {
      const { data } = await submitAnswer({
        session_id: sessionId, index: idx, answer,
        voiceLevel, durationSec: sec, wordCount: words,
      });
      setTranscript(''); setMicState('idle');
      if (data.done) { await onFinish(); return; }
      askQuestion(questions, idx + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not submit your answer.');
    } finally { setBusy(false); }
  };

  const onFinish = async () => {
    setPhase('finishing'); setBusy(true); setError('');
    try {
      const { data } = await finishSession(sessionId);
      setSummary(data.result); setPhase('summary');
      try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
      cleanup();
    } catch (e) {
      // Stay on 'finishing' with the error + a Retry button — reverting to
      // 'room' here would strand the student with no next question to show
      // (every question was already answered) and no way forward.
      setError(e?.response?.data?.error || 'Could not generate your summary. Please try again.');
    } finally { setBusy(false); }
  };

  const restart = () => {
    cleanup();
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
    setPhase('setup'); setSessionId(''); setQuestions([]); setIdx(0);
    setChat([]); setSummary(null); setError(''); setTranscript(''); setMicState('idle');
  };

  return (
    <div className="iv-root">
      <style>{STYLES}</style>

      {phase === 'setup' && (
        <div className="iv-container">
          <header className="iv-header">
            <div>
              <h1 className="iv-title">AI Interviewer</h1>
              <p className="iv-subtitle">A live mock legal interview, question by question, at your pace.</p>
            </div>
            <span className="iv-badge">16 interviews / month</span>
          </header>

          {error && <div className="iv-card iv-error" role="alert">{error}</div>}

          <section className="iv-card">
            <h2 className="iv-h2">Your name</h2>
            <input className="iv-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your name" />

            <h2 className="iv-h2" style={{ marginTop: 20 }}>Role you're preparing for</h2>
            <div className="iv-chips">
              {roles.map((r) => <button key={r} className={`iv-chip ${role === r ? 'sel' : ''}`} onClick={() => setRole(r)}>{r}</button>)}
            </div>

            <h2 className="iv-h2" style={{ marginTop: 20 }}>Difficulty</h2>
            <div className="iv-chips">
              {tierInfo.map((t) => (
                <button key={t.id} className={`iv-chip ${difficulty === t.id ? 'sel' : ''}`} onClick={() => setDifficulty(t.id)}>
                  {t.id[0].toUpperCase() + t.id.slice(1)} <span className="iv-chip-sub">({t.questionRange} Qs)</span>
                </button>
              ))}
            </div>

            <h2 className="iv-h2" style={{ marginTop: 20 }}>Resume (optional)</h2>
            {resumes.length > 0 ? (
              <select className="iv-input" value={resumeDocId} onChange={(e) => setResumeDocId(e.target.value)}>
                <option value="">Don't use a resume</option>
                {resumes.map((r) => <option key={r.docId} value={r.docId}>Analyzed resume — {new Date(r.created_at).toLocaleDateString()}</option>)}
              </select>
            ) : (
              <p className="iv-muted">Analyze a resume first (Resume Analyzer) to have the interviewer ground questions in it — optional.</p>
            )}

            {voiceOptions.length > 0 && (
              <>
                <h2 className="iv-h2" style={{ marginTop: 20 }}>Interviewer's voice</h2>
                <p className="iv-muted" style={{ marginBottom: 10 }}>
                  Pick the interviewer you'd like to hear, and test it before you begin.
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <select className="iv-input" style={{ flex: 1, minWidth: 200 }} value={selectedVoiceId} onChange={(e) => onVoiceChange(e.target.value)}>
                    {voiceOptions.map((v) => (
                      <option key={v.id} value={v.id}>{v.display}</option>
                    ))}
                  </select>
                  <button type="button" className="iv-btn iv-ghost" onClick={onTestVoice}>🔊 Test</button>
                </div>

                <h2 className="iv-h2" style={{ marginTop: 20 }}>Speaking speed</h2>
                <p className="iv-muted" style={{ marginBottom: 10 }}>You can change this during the interview too.</p>
                <div className="iv-chips">
                  {SPEECH_SPEEDS.map((s) => (
                    <button key={s} type="button" className={`iv-chip ${speed === s ? 'sel' : ''}`} onClick={() => onSpeedChange(s)}>{s}x</button>
                  ))}
                </div>
              </>
            )}

            {!SR && <p className="iv-muted" style={{ marginTop: 12 }}>Note: your browser doesn't support speech-to-text; you'll be able to type your answers instead.</p>}

            <div className="iv-actions">
              <button className="iv-btn iv-primary" onClick={onBeginInterview} disabled={busy}>
                {busy ? 'Starting…' : 'Start Interview →'}
              </button>
            </div>
          </section>
        </div>
      )}

      {phase === 'preparing' && (
        <div className="iv-container iv-center">
          <span className="iv-spinner" /><p className="iv-muted">Preparing your {difficulty} interview…</p>
        </div>
      )}

      {(phase === 'room' || phase === 'finishing') && (
        <div className="iv-room">
          <div className="iv-room-header">
            <span>Question {Math.min(idx + 1, questions.length)} of {questions.length}</span>
            {/* Speed stays adjustable during the interview, not just at setup. */}
            <span className="iv-speed">
              {SPEECH_SPEEDS.map((s) => (
                <button key={s} className={`iv-speed-btn ${speed === s ? 'sel' : ''}`} onClick={() => onSpeedChange(s)}>{s}x</button>
              ))}
            </span>
            <span className="iv-muted">{role} · {difficulty}</span>
          </div>

          <div className="iv-chat">
            {chat.map((m, i) => (
              <div key={i} className={`iv-bubble ${m.type === 'q' ? 'iv-bubble-q' : 'iv-bubble-a'}`}>
                {m.type === 'q' && <div className="iv-bubble-label">Interviewer</div>}
                {m.text}
              </div>
            ))}
            {phase === 'finishing' && !error && (
              <div className="iv-bubble iv-bubble-q"><span className="iv-spinner iv-spinner-sm" /> Analysing your interview…</div>
            )}
            {error && (
              <div className="iv-card iv-error" style={{ marginTop: 8 }}>
                {error}
                {phase === 'finishing' && (
                  <div className="iv-actions" style={{ marginTop: 10 }}>
                    <button className="iv-btn iv-primary" onClick={onFinish} disabled={busy}>{busy ? 'Retrying…' : 'Retry →'}</button>
                  </div>
                )}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {phase === 'room' && (
            <div className="iv-micbar">
              {micState !== 'idle' && (
                <div className="iv-transcript-box">
                  <textarea
                    className="iv-transcript"
                    rows={3}
                    value={transcript}
                    placeholder={micState === 'listening' ? 'Listening… speak your answer.' : 'Edit your answer if needed.'}
                    onChange={(e) => setTranscript(e.target.value)}
                    readOnly={micState === 'listening'}
                  />
                </div>
              )}
              <div className="iv-mic-row">
                {micState === 'review' ? (
                  <>
                    <button className="iv-round iv-round-x" onClick={discardAnswer} disabled={busy} title="Discard & retry">✕</button>
                    <button className="iv-round iv-round-check" onClick={onConfirmAnswer} disabled={busy || !transcript.trim()} title="Confirm & submit">✓</button>
                  </>
                ) : (
                  <>
                    {micState === 'idle' && (
                      <button
                        className="iv-round iv-round-repeat"
                        onClick={() => { unlockSpeechSynthesis(); speak(questions[idx]); }}
                        disabled={busy}
                        title="Repeat the question out loud"
                      >
                        🔊
                      </button>
                    )}
                    <button
                      className={`iv-round ${micState === 'listening' ? 'iv-round-rec' : 'iv-round-mic'}`}
                      onClick={onMicClick}
                      disabled={speaking || busy}
                      title={speaking ? 'Wait for the question to finish' : micState === 'listening' ? 'Stop' : 'Tap to answer'}
                    >
                      {micState === 'listening' ? '⏹' : '🎤'}
                    </button>
                  </>
                )}
              </div>
              <p className="iv-muted iv-mic-hint">
                {speaking ? 'Listen to the question…' : micState === 'listening' ? "Tap ⏹ when you're done speaking." : micState === 'review' ? 'Edit if needed, then confirm ✓ or discard ✕.' : "Tap the mic to answer. Didn't hear it? Tap 🔊 to replay."}
              </p>
            </div>
          )}
        </div>
      )}

      {phase === 'summary' && summary && (
        <div className="iv-container">
          <section className="iv-results">
            <div className="iv-card iv-overall">
              <div className="iv-score"><span className="iv-score-n">{summary.overallScore}</span><span className="iv-score-d">/100</span></div>
              <p className="iv-summary">{summary.summary}</p>
            </div>
            <div className="iv-card">
              <h2 className="iv-h2">Your metrics</h2>
              <div className="iv-metrics">
                {[['Legal understanding', summary.legalUnderstanding], ['Tonality', summary.tonality], ['Confidence', summary.confidence], ['Clarity', summary.clarity]].map(([k, v]) => (
                  <div key={k} className="iv-metric">
                    <div className="iv-metric-head"><span>{k}</span><span className="iv-metric-v">{v}</span></div>
                    <div className="iv-bar"><div className="iv-bar-fill" style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
              <p className="iv-muted" style={{ marginTop: 12 }}>Voice level: <strong>{summary.voiceLevel}</strong> · Speaking pace: <strong>{summary.speechPaceWpm} wpm</strong></p>
            </div>
            {summary.strengths?.length > 0 && (
              <div className="iv-card">
                <h2 className="iv-h2">Strengths</h2>
                <ul className="iv-list">{summary.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {summary.improvements?.length > 0 && (
              <div className="iv-card">
                <h2 className="iv-h2">What to change</h2>
                {summary.improvements.map((f, i) => (
                  <div key={i} className="iv-fb"><div className="iv-fb-area">{f.area}</div><div className="iv-fb-comment">{f.suggestion}</div></div>
                ))}
              </div>
            )}
            <p className="iv-disclaimer">{summary.disclaimer}</p>
            <div className="iv-actions"><button className="iv-btn iv-primary" onClick={restart}>New interview →</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

const STYLES = `
.iv-root{--bg:#090a0f;--surface:#12131a;--surface-2:#1c1e29;--border:rgba(212, 175, 55, 0.25);--text:#f8f5eb;--muted:#b8af94;--accent:#d4af37;--rec:#e57373;--ok:#81c784;
  min-height:100vh;background:radial-gradient(circle at 50% 10%, #15140f 0%, #07070a 70%);color:var(--text);font-family:'Lora',Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.iv-container{max-width:900px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.iv-center{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:14px;}
.iv-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.iv-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.iv-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.iv-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap;background:var(--surface);}
.iv-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.iv-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.iv-error{color:#e6bcbc;border-color:#5a3a3a;}
.iv-chips{display:flex;gap:10px;flex-wrap:wrap;}
.iv-chip{font-family:inherit;font-size:15px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.iv-chip.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.iv-chip-sub{opacity:.7;font-size:12px;}
.iv-muted{color:var(--muted);font-size:14px;}
.iv-input{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:15px;padding:12px 14px;}
.iv-input:focus{outline:none;border-color:var(--accent);}
.iv-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;}
.iv-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.iv-btn:disabled{opacity:.5;cursor:not-allowed;}
.iv-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.iv-ghost{background:transparent;color:var(--text);}
.iv-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:iv-spin .8s linear infinite;display:inline-block;}
.iv-spinner-sm{width:14px;height:14px;border-width:2px;vertical-align:middle;margin-right:8px;}
@keyframes iv-spin{to{transform:rotate(360deg);}}

.iv-room{display:flex;flex-direction:column;height:100vh;max-width:900px;margin:0 auto;}
.iv-room-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:16px clamp(16px,4vw,32px);border-bottom:1px solid var(--border);font-size:14px;}
.iv-speed{display:inline-flex;align-items:center;gap:6px;}
.iv-speed-btn{font-family:inherit;font-size:12px;padding:3px 9px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);cursor:pointer;}
.iv-speed-btn.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.iv-chat{flex:1;overflow-y:auto;padding:16px clamp(16px,4vw,32px);display:flex;flex-direction:column;gap:14px;}
.iv-bubble{max-width:80%;padding:14px 16px;border-radius:14px;font-size:15px;line-height:1.55;}
.iv-bubble-q{align-self:flex-start;background:var(--surface);border:1px solid var(--border);}
.iv-bubble-a{align-self:flex-end;background:var(--accent);color:#111;font-weight:500;}
.iv-bubble-label{font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
.iv-micbar{border-top:1px solid var(--border);padding:14px clamp(16px,4vw,32px) 22px;background:var(--bg);}
.iv-transcript-box{margin-bottom:12px;}
.iv-transcript{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:15px;line-height:1.5;padding:12px 14px;resize:vertical;}
.iv-transcript:focus{outline:none;border-color:var(--accent);}
.iv-mic-row{display:flex;justify-content:center;gap:20px;}
.iv-round{width:56px;height:56px;border-radius:50%;border:1px solid var(--border);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.iv-round:disabled{opacity:.4;cursor:not-allowed;}
.iv-round-mic{background:var(--accent);color:#111;}
.iv-round-rec{background:var(--rec);color:#fff;border-color:var(--rec);animation:iv-pulse 1.4s ease-in-out infinite;}
@keyframes iv-pulse{0%,100%{box-shadow:0 0 0 0 rgba(201,107,107,.5);}50%{box-shadow:0 0 0 10px rgba(201,107,107,0);}}
.iv-round-x{background:var(--surface-2);color:var(--rec);border-color:var(--rec);}
.iv-round-check{background:var(--ok);color:#0e2a0e;border-color:var(--ok);font-weight:700;}
.iv-round-repeat{width:44px;height:44px;font-size:18px;background:var(--surface-2);color:var(--text);align-self:center;}
.iv-mic-hint{text-align:center;margin-top:10px;}

.iv-overall{display:flex;align-items:center;gap:24px;flex-wrap:wrap;}
.iv-score{display:flex;align-items:baseline;}
.iv-score-n{font-size:clamp(40px,11vw,60px);font-weight:700;line-height:1;}
.iv-score-d{font-size:18px;color:var(--muted);margin-left:4px;}
.iv-summary{margin:0;color:var(--muted);flex:1;min-width:220px;}
.iv-metrics{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:640px){.iv-metrics{grid-template-columns:1fr 1fr;}}
.iv-metric-head{display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;}
.iv-metric-v{color:var(--accent);font-weight:700;}
.iv-bar{height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.iv-bar-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);}
.iv-list{margin:0;padding-left:18px;color:var(--muted);font-size:14px;}
.iv-list li{margin-bottom:6px;}
.iv-fb{border-top:1px solid var(--border);padding:12px 0;}
.iv-fb:first-of-type{border-top:none;}
.iv-fb-area{font-weight:700;font-size:14px;margin-bottom:4px;}
.iv-fb-comment{color:var(--muted);font-size:14px;}
.iv-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}
`;
