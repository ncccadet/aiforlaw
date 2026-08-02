/**
 * CourtSimulationPage.jsx — v4.1 (was a placeholder stub; voice + case-overview fixes 2026-07-24)
 * Contract: _contracts/05-court-simulation.md
 *
 * Flow: name (optional) + field of law + position + level → generate case
 * (async — polls while 'preparing', same pattern as AI Interviewer/Drafting
 * Lab) → CASE OVERVIEW (full brief, student must actively continue past it —
 * founder: "student should get the overview of case before... first he has
 * to read that everything, every aspect... once he understood that, then
 * you ask him to enter [the courtroom]") → 3-panel courtroom (you = left,
 * judge = centre/raised, opposition = right). Each turn you make a
 * statement (voice or typed, hard-capped 200 words); the judge gives a very
 * short interjection and the opposing counsel rebuts. Soft target: conclude
 * by turn 11. Hard cap: 15. Then a judge's judgment + scored feedback.
 *
 * Mic: browser SpeechRecognition; hard-stops at 200 words (founder spec —
 * not a warn-then-buffer, a single hard stop) with an immediate popup.
 *
 * Voice (v4.2, founder decision 2026-07-29): the old "rank every installed
 * voice and pick the best" heuristic is GONE. We now offer exactly the two
 * approved voices for the student's platform — Rishi / Samantha on Apple,
 * Ria / Rachel on Android+Windows — from the shared roster in
 * services/voices.js. Judge takes the first, opposing counsel the second, so
 * the two characters still sound different; rate and pitch are also set per
 * role so they stay distinguishable even on a device that exposes only one
 * approved voice. Both remain manually overridable + testable on the setup
 * screen and are persisted per-browser by roster id.
 *
 * Speech pacing + interruption (v4.2, founder feedback: "sometimes they are
 * speaking too slow... people seem that they want to quit it or fast track
 * it"). Two things changed: delivery is faster across the board, and the
 * student is no longer forced to sit through it. While the court speaks the
 * mic is still locked (you may not talk over the bench), but a SKIP button
 * cuts the speech short and hands the floor straight back, and a QUIT button
 * leaves the hearing entirely without waiting for a judgment.
 * Theme: black/grey serif, responsive — matches the reference design.
 */
import { useEffect, useRef, useState } from 'react';
import { getCaseTypes, startSession, getSession, takeTurn, finishSession } from '../services/courtSimulation.service';
import { resolveApprovedVoices, findApprovedById, speechRate, SPEECH_SPEEDS, DEFAULT_SPEECH_SPEED, IS_ANDROID } from '../services/voices';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const MAX_WORDS = 200; // founder: hard stop at 200 words, no separate buffer tier
const POLL_MS = 2000;
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// Remembers a manually-picked voice per browser/device, per role. The stored
// value is now the roster id ('rishi' | 'samantha' | 'ria' | 'rachel'), not a
// raw "name::lang" key — the v4.1 keys are simply ignored on read, which
// harmlessly falls the student back to the default pairing.
const JUDGE_VOICE_KEY = 'vfl_court_sim_judge_voice_id';
const OPPOSITION_VOICE_KEY = 'vfl_court_sim_opposition_voice_id';

// Speech rate. Founder feedback: the bench and opposing counsel were "speaking
// too slow." These are the BASE rates at the student's 1x setting — the judge
// stays a touch quicker and lower than opposition so the two characters remain
// distinguishable by ear alone. The student's chosen speed (0.5x–2x) multiplies
// these; see speechRate() in services/voices.js.
const JUDGE_BASE_RATE = 1.3, OPP_BASE_RATE = 1.2;
const JUDGE_PITCH = 0.85, OPP_PITCH = 1.05;
const SPEED_KEY = 'vfl_court_sim_speech_speed';

export default function CourtSimulationPage() {
  const [phase, setPhase] = useState('setup'); // setup | preparing | overview | court | finishing | summary
  const [fields, setFields] = useState([]);
  const [levels, setLevels] = useState(['easy', 'medium', 'hard']);
  const [studentName, setStudentName] = useState('');
  const [fieldOfLaw, setFieldOfLaw] = useState('');
  const [positions, setPositions] = useState([]);
  const [position, setPosition] = useState('');
  const [level, setLevel] = useState('medium');
  const [error, setError] = useState('');
  const [voiceOptions, setVoiceOptions] = useState([]); // approved roster for this device
  const [judgeVoiceId, setJudgeVoiceId] = useState('');
  const [oppVoiceId, setOppVoiceId] = useState('');
  // Playback speed, remembered per browser. Read synchronously on first
  // render so a returning student never hears one line at the wrong speed
  // before their saved choice is applied.
  const [speed, setSpeed] = useState(() => {
    try { return Number(localStorage.getItem(SPEED_KEY)) || DEFAULT_SPEECH_SPEED; } catch { return DEFAULT_SPEECH_SPEED; }
  });

  const [sessionId, setSessionId] = useState('');
  const [label, setLabel] = useState('');
  const [brief, setBrief] = useState('');
  const [turnCount, setTurnCount] = useState(0);
  const [judgeText, setJudgeText] = useState('The court is in session. Counsel, make your opening statement.');
  const [oppText, setOppText] = useState('');
  const [statement, setStatement] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [warn, setWarn] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false); // court is speaking → student mic locked
  const [busy, setBusy] = useState(false);
  const [concluded, setConcluded] = useState(false);
  const [summary, setSummary] = useState(null);

  const streamRef = useRef(null), audioCtxRef = useRef(null), analyserRef = useRef(null), rafRef = useRef(null);
  const meterRef = useRef({ sum: 0, count: 0, avg: 0 });
  const recRef = useRef(null), recordingRef = useRef(false), startRef = useRef(0);
  const pollRef = useRef(null);
  const judgeVoiceRef = useRef(null), oppVoiceRef = useRef(null);
  // watchdogRef: the "unlock the mic even if onend never fires" timer, held
  // in a ref so skipSpeech() can clear it. skippedRef: set by skipSpeech so
  // the utterance queue stops advancing when cancel() fires onend early.
  const watchdogRef = useRef(null), skippedRef = useRef(false);
  // speakSequence() runs from inside a closure created when the court replies,
  // so it must read the CURRENT speed from a ref — otherwise a speed change
  // made mid-hearing wouldn't apply to the utterances still queued behind it.
  const speedRef = useRef(speed);
  // iOS Safari/WebKit (incl. Chrome-on-iOS, which Apple forces onto the
  // WebKit engine) only lets speechSynthesis.speak() actually produce audio
  // when it's called SYNCHRONOUSLY inside a direct user tap. Any speak()
  // call made after an `await` (e.g. after our awaited takeTurn()/
  // startSession() network calls) silently no-ops — no error, nothing heard
  // — which is exactly the bug reported on mobile: mic still locks with
  // "the court is speaking" but no audio ever plays. Firing ONE real
  // utterance synchronously inside the first tap "unlocks" speechSynthesis
  // for the rest of the page's life, including later async-triggered
  // speak() calls. Same proven pattern as AIInterviewerPage.jsx.
  const ttsUnlockedRef = useRef(false);

  useEffect(() => {
    getCaseTypes().then(({ data }) => { setFields(data.fields || []); setLevels(data.levels || ['easy', 'medium', 'hard']); })
      .catch(() => setError('Could not load fields of law.'));

    // Load the two approved voices for this device (see services/voices.js).
    // Judge takes the first of the pair, opposing counsel the second, so the
    // two characters never share a voice. Re-runs on 'voiceschanged' because
    // Chrome populates the voice list asynchronously after first paint.
    const loadVoices = () => {
      const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      if (!voices.length) return;
      const approved = resolveApprovedVoices(voices);
      setVoiceOptions(approved);
      if (!approved.length) return; // no approved voice here — speak with the browser default

      let savedOpp = null, savedJudge = null;
      try { savedOpp = localStorage.getItem(OPPOSITION_VOICE_KEY); savedJudge = localStorage.getItem(JUDGE_VOICE_KEY); } catch {}

      const judgeChosen = findApprovedById(approved, savedJudge) || approved[0];
      const oppChosen = findApprovedById(approved, savedOpp) || approved[1] || approved[0];

      judgeVoiceRef.current = judgeChosen.voice; setJudgeVoiceId(judgeChosen.id);
      oppVoiceRef.current = oppChosen.voice; setOppVoiceId(oppChosen.id);
    };
    loadVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = loadVoices;

    return cleanup;
  }, []);

  const cleanup = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    skippedRef.current = true; // stop any in-flight utterance queue from advancing
    try { recRef.current && recRef.current.stop(); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setAiSpeaking(false);
  };

  const wordCount = statement.trim().split(/\s+/).filter(Boolean).length;

  const pickField = (f) => { setFieldOfLaw(f.id); setPositions(f.positions); setPosition(f.positions[0]); };

  // Must be called SYNCHRONOUSLY inside a real tap/click, before any
  // `await` — see the ttsUnlockedRef comment above. A near-silent primer
  // utterance is enough to satisfy iOS/WebKit's "user gesture" gate; once
  // it fires, every later speak() call (even from async code) works.
  const unlockSpeechSynthesis = () => {
    if (ttsUnlockedRef.current || !window.speechSynthesis) return;
    ttsUnlockedRef.current = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0.01;
      window.speechSynthesis.speak(u);
    } catch {}
  };

  // Speak the judge then the opposition in sequence, each in ITS OWN voice.
  // While speaking, the mic is locked (aiSpeaking = true) so the student
  // cannot talk over the bench. A watchdog clears the lock even if a browser
  // fails to fire onend, so the student is never stuck unable to respond.
  // The watchdog handle lives in a ref (not a local const) because skipSpeech
  // below has to be able to clear it from outside this closure.
  const speakSequence = (items) => {
    const list = (items || []).filter((x) => x && x.text);
    if (!list.length) return;
    if (recordingRef.current) stopRec(); // stop the student mid-word if they were talking
    if (!window.speechSynthesis) return; // no TTS: don't lock the UI
    window.speechSynthesis.cancel();
    skippedRef.current = false;
    setAiSpeaking(true);
    const totalChars = list.reduce((a, x) => a + x.text.length, 0);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    // Divided by the speed, or the watchdog would cut a 0.5x reading off
    // halfway through and unlock the mic while the bench is still talking.
    const budgetMs = Math.min(180000, (totalChars * 70) / (speedRef.current || 1) + 4000);
    watchdogRef.current = setTimeout(() => { try { window.speechSynthesis.cancel(); } catch {} setAiSpeaking(false); }, budgetMs);
    let i = 0;
    const next = () => {
      // If the student pressed Skip, stop advancing through the queue —
      // cancel() fires onend for the utterance in flight, and without this
      // guard that would start the NEXT one instead of ending the sequence.
      if (skippedRef.current) return;
      if (i >= list.length) { clearTimeout(watchdogRef.current); watchdogRef.current = null; setAiSpeaking(false); return; }
      const { text, role } = list[i++];
      const isJudge = role === 'judge';
      const voice = isJudge ? judgeVoiceRef.current : oppVoiceRef.current;
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-IN';
      u.rate = speechRate(speedRef.current, isJudge ? JUDGE_BASE_RATE : OPP_BASE_RATE);
      u.pitch = isJudge ? JUDGE_PITCH : OPP_PITCH;
      u.onend = next; u.onerror = next;
      window.speechSynthesis.speak(u);
    };
    next();
  };

  // Skip — founder feedback: students want to "fast track it." Cuts the
  // court off mid-sentence and hands the floor straight back. The transcript
  // is already on screen in the two panels, so nothing is lost by skipping;
  // only the audio stops.
  const skipSpeech = () => {
    skippedRef.current = true;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    setAiSpeaking(false);
  };

  // Speed control (0.5x / 1x / 1.5x / 2x, like a video player). A rate is
  // baked into an utterance when it starts, so a change made while the court
  // is mid-sentence applies from the NEXT line onward — the student can press
  // Skip if they want the new speed to take effect immediately.
  const onSpeedChange = (s) => {
    setSpeed(s);
    speedRef.current = s;
    try { localStorage.setItem(SPEED_KEY, String(s)); } catch {}
  };

  // Lets a student pick either of the two approved voices for either role
  // (e.g. swap them, or put the same one on both). Persisted per-browser
  // per-role by roster id.
  const onVoiceChange = (role, id) => {
    const entry = findApprovedById(voiceOptions, id);
    if (!entry) return;
    if (role === 'judge') { judgeVoiceRef.current = entry.voice; setJudgeVoiceId(id); try { localStorage.setItem(JUDGE_VOICE_KEY, id); } catch {} }
    else { oppVoiceRef.current = entry.voice; setOppVoiceId(id); try { localStorage.setItem(OPPOSITION_VOICE_KEY, id); } catch {} }
  };
  const onTestVoice = (role) => {
    const sample = role === 'judge' ? 'Order in the court. Counsel, proceed.' : 'Your Honour, I object to that characterization of the facts.';
    speakSequence([{ text: sample, role }]);
  };

  // ── mic + voice meter ─────────────────────────────────────────────────────
  const ensureMic = async () => {
    if (streamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC(); const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      audioCtxRef.current = ctx; analyserRef.current = an;
      return true;
    } catch { setError('Microphone access is needed to speak. You can type your statement instead.'); return false; }
  };

  // Hand the microphone back to the OS. On Android this is not optional —
  // see startRec() below.
  const releaseMic = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setVoiceLevel(0);
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
  const meterTick = () => {
    const an = analyserRef.current; if (!an) return;
    const buf = new Uint8Array(an.fftSize); an.getByteTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    const level = Math.min(100, Math.round(Math.sqrt(s / buf.length) * 320));
    setVoiceLevel(level); meterRef.current.sum += level; meterRef.current.count += 1;
    rafRef.current = requestAnimationFrame(meterTick);
  };

  const startRec = async () => {
    if (wordCount >= MAX_WORDS || aiSpeaking) return; // can't speak while the court speaks
    startRef.current = startRef.current || Date.now();
    meterRef.current = { sum: 0, count: 0, avg: meterRef.current.avg || 0 };

    // ANDROID (founder report, 2026-07-29): "Speech Recognition and Synthesis
    // from Google cannot record now as Chrome is recording."
    //
    // On Android, SpeechRecognition is served by a SEPARATE system process
    // (Google's speech service) that demands exclusive access to the mic. Our
    // own getUserMedia stream — opened purely to drive the voice-level meter —
    // holds that lock, so rec.start() is refused with the message above and
    // the student's mic never listens. Desktop Chrome and iOS WebKit both
    // share the mic without complaint, which is exactly why the bug appeared
    // only on Android.
    //
    // Fix: on Android we give up the level meter (cosmetic) to get working
    // speech-to-text (essential) — release any stream we already hold and
    // never open one while recognition is running. Android Chrome prompts for
    // mic permission on rec.start() by itself, so we lose nothing but the bar.
    if (IS_ANDROID) {
      releaseMic();
    } else {
      if (!(await ensureMic())) return;
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      meterTick();
    }

    if (SR) {
      const rec = new SR();
      rec.lang = 'en-IN';
      rec.interimResults = true;
      // Android's recogniser ignores `continuous` and ends after each pause
      // anyway; asking for it there only produces spurious errors. onend
      // restarts it while the student is still holding the floor, which gives
      // continuous behaviour on every platform.
      rec.continuous = !IS_ANDROID;
      rec.onresult = (e) => {
        let fin = '';
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' ';
        if (fin) setStatement((prev) => {
          const merged = (prev ? prev + ' ' : '') + fin.trim();
          const words = merged.trim().split(/\s+/).filter(Boolean);
          // Hard stop at 200 words — founder spec: no separate warn-then-buffer
          // tier, the mic stops the instant the cap is hit and a popup shows.
          if (words.length >= MAX_WORDS) { setWarn(true); stopRec(); }
          return words.slice(0, MAX_WORDS).join(' ');
        });
      };
      // Restart on a small delay: Android refuses an immediate start() from
      // inside onend and throws InvalidStateError, which silently killed the
      // loop. A tick of breathing room makes the restart reliable everywhere.
      rec.onend = () => {
        if (!recordingRef.current) return;
        setTimeout(() => { if (recordingRef.current) { try { rec.start(); } catch {} } }, 250);
      };
      // Previously empty, so every recognition failure was invisible to the
      // student — they held the mic open and nothing happened. Only the two
      // terminal errors are worth surfacing; 'no-speech' and 'aborted' are
      // normal punctuation of a conversation and the restart above handles them.
      rec.onerror = (e) => {
        const err = e?.error;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          recordingRef.current = false; setRecording(false);
          setError('Your browser blocked the microphone. Allow mic access for this site, or type your statement instead.');
        } else if (err === 'audio-capture') {
          recordingRef.current = false; setRecording(false);
          setError('Another app is using the microphone. Close it and tap the mic again, or type your statement instead.');
        }
      };
      recRef.current = rec; recordingRef.current = true; try { rec.start(); } catch {}
    }
    setRecording(true);
  };
  const stopRec = () => {
    recordingRef.current = false; setRecording(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current); setVoiceLevel(0);
    try { recRef.current && recRef.current.stop(); } catch {}
    const { sum, count } = meterRef.current; if (count) meterRef.current.avg = Math.round(sum / count);
  };
  const toggleRec = () => (recording ? stopRec() : startRec());

  // ── flow ──────────────────────────────────────────────────────────────────
  // Founder feedback (2026-07-24): the student must actually READ the case
  // before entering the courtroom — "every aspect... once he understood
  // that, then you ask him to enter." So once the worker finishes generating
  // the brief, we land on a dedicated 'overview' phase (full brief, not the
  // small collapsed <details> the courtroom view uses), and ONLY move into
  // 'court' when the student explicitly confirms via onEnterCourtroom.
  const pollForCase = (sid) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await getSession(sid);
        if (data.status === 'active') {
          clearInterval(pollRef.current);
          setLabel(data.label); setBrief(data.brief);
          setPhase('overview');
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current); setPhase('setup');
          setError('Could not prepare the case. Please try again.');
        }
      } catch { clearInterval(pollRef.current); setPhase('setup'); setError('Connection problem. Please try again.'); }
    }, POLL_MS);
  };

  const onEnterCourtroom = () => {
    unlockSpeechSynthesis(); // direct tap, no prior await — safe to unlock here
    setTurnCount(0);
    setJudgeText(`The court is in session for this ${label}. Counsel for the ${position}, make your opening statement.`);
    setOppText(''); setStatement(''); setConcluded(false);
    setPhase('court');
  };

  const onStart = async () => {
    if (!fieldOfLaw) { setError('Choose a field of law.'); return; }
    unlockSpeechSynthesis(); // must run before the await below — see comment on ttsUnlockedRef
    setError(''); setBusy(true); setPhase('preparing');
    try {
      const { data } = await startSession({ fieldOfLaw, position, level, studentName: studentName.trim() || undefined });
      setSessionId(data.sessionId);
      pollForCase(data.sessionId);
    } catch (e) { setPhase('setup'); setError(e?.response?.data?.error || 'Could not start the hearing.'); }
    finally { setBusy(false); }
  };

  const onSubmitTurn = async () => {
    if (!statement.trim()) { setError('Make your statement first.'); return; }
    unlockSpeechSynthesis(); // must run before the await below — see comment on ttsUnlockedRef
    if (recording) stopRec();
    setError(''); setBusy(true);
    const durationSec = startRef.current ? Math.round((Date.now() - startRef.current) / 1000) : 0;
    try {
      const { data } = await takeTurn({
        session_id: sessionId, statement,
        voiceLevel: meterRef.current.avg || 0, durationSec, wordCount,
      });
      setJudgeText(data.judge); setOppText(data.opposition);
      setTurnCount(data.turnNumber); setStatement(''); setWarn(false);
      startRef.current = 0; meterRef.current.avg = 0;
      // The court speaks (judge first, in the judge's voice; then opposition,
      // in a distinct voice) — mic locked meanwhile.
      speakSequence([{ text: data.judge, role: 'judge' }, { text: data.opposition, role: 'opposition' }]);
      if (data.concluded) { setConcluded(true); await onFinish(); }
    } catch (e) { setError(e?.response?.data?.error || 'The court could not respond.'); }
    finally { setBusy(false); }
  };

  const onFinish = async () => {
    setPhase('finishing'); setBusy(true); cleanup();
    try { const { data } = await finishSession(sessionId); setSummary(data.result); setPhase('summary'); }
    catch (e) { setError(e?.response?.data?.error || 'Could not generate your judgment and feedback.'); setPhase('court'); }
    finally { setBusy(false); }
  };

  const restart = () => {
    cleanup(); setPhase('setup'); setSessionId(''); setSummary(null); setStatement(''); setError('');
    setFieldOfLaw(''); setPositions([]); setStudentName(''); setLevel('medium');
  };

  // Quit — generates a summary/judgment based on turns argued so far.
  // Even if the student leaves early, they still get performance feedback.
  const onQuit = async () => {
    if (!window.confirm('Leave this hearing? Your performance so far will be evaluated and a summary will be generated.')) return;
    await onFinish();
  };

  return (
    <div className="cs-root">
      <style>{STYLES}</style>
      <div className="cs-container">
        <header className="cs-header">
          <div>
            <h1 className="cs-title">Court Simulation</h1>
            <p className="cs-subtitle">Argue a live case against an AI bench and opposing counsel.</p>
          </div>
          <span className="cs-badge">16 sessions / month</span>
        </header>

        {error && <div className="cs-card cs-error" role="alert">{error}</div>}

        {/* SETUP */}
        {phase === 'setup' && (
          <section className="cs-card">
            <h2 className="cs-h2">Your name (optional)</h2>
            <input
              className="cs-input"
              placeholder="Used to personalize your case brief…"
              value={studentName}
              maxLength={80}
              onChange={(e) => setStudentName(e.target.value)}
            />

            <h2 className="cs-h2">Field of law</h2>
            <div className="cs-chips">
              {fields.map((f) => <button key={f.id} className={`cs-chip ${fieldOfLaw === f.id ? 'sel' : ''}`} onClick={() => pickField(f)}>{f.label}</button>)}
            </div>
            {positions.length > 0 && (
              <>
                <h2 className="cs-h2">Your position</h2>
                <div className="cs-chips">
                  {positions.map((p) => <button key={p} className={`cs-chip ${position === p ? 'sel' : ''}`} onClick={() => setPosition(p)}>{p}</button>)}
                </div>
              </>
            )}
            <h2 className="cs-h2">Level</h2>
            <div className="cs-chips">
              {levels.map((l) => <button key={l} className={`cs-chip ${level === l ? 'sel' : ''}`} onClick={() => setLevel(l)}>{LEVEL_LABEL[l] || l}</button>)}
            </div>

            {voiceOptions.length > 0 && (
              <>
                <h2 className="cs-h2">Voices</h2>
                <div className="cs-voice-row">
                  <div className="cs-voice-col">
                    <label className="cs-voice-label">⚖ Judge</label>
                    <select className="cs-input cs-select" value={judgeVoiceId} onChange={(e) => onVoiceChange('judge', e.target.value)}>
                      {voiceOptions.map((v) => <option key={v.id} value={v.id}>{v.display}</option>)}
                    </select>
                    <button className="cs-btn cs-ghost cs-small" onClick={() => onTestVoice('judge')}>🔊 Test</button>
                  </div>
                  <div className="cs-voice-col">
                    <label className="cs-voice-label">Opposing Counsel</label>
                    <select className="cs-input cs-select" value={oppVoiceId} onChange={(e) => onVoiceChange('opposition', e.target.value)}>
                      {voiceOptions.map((v) => <option key={v.id} value={v.id}>{v.display}</option>)}
                    </select>
                    <button className="cs-btn cs-ghost cs-small" onClick={() => onTestVoice('opposition')}>🔊 Test</button>
                  </div>
                </div>
                <p className="cs-voice-note">The bench and opposing counsel are set to different voices so you can tell them apart. Test both before you argue.</p>

                <h2 className="cs-h2">Speaking speed</h2>
                <div className="cs-chips">
                  {SPEECH_SPEEDS.map((s) => (
                    <button key={s} className={`cs-chip ${speed === s ? 'sel' : ''}`} onClick={() => onSpeedChange(s)}>{s}x</button>
                  ))}
                </div>
                <p className="cs-voice-note">You can change this during the hearing too.</p>
              </>
            )}

            <div className="cs-actions"><button className="cs-btn cs-primary" onClick={onStart} disabled={busy || !fieldOfLaw}>Generate case →</button></div>
          </section>
        )}

        {phase === 'preparing' && <section className="cs-card cs-status"><span className="cs-spinner" />Setting up the case…</section>}

        {/* CASE OVERVIEW — student must read the full brief before entering */}
        {phase === 'overview' && (
          <section className="cs-card cs-overview">
            <h2 className="cs-h2">Case brief — {label}</h2>
            <p className="cs-overview-sub">Read every aspect of this case before you enter the courtroom. You'll be arguing for the {position}.</p>
            <p className="cs-overview-text">{brief}</p>
            <div className="cs-actions"><button className="cs-btn cs-primary" onClick={onEnterCourtroom}>I've read the case — Enter courtroom →</button></div>
          </section>
        )}

        {/* COURTROOM */}
        {phase === 'court' && (
          <>
            <details className="cs-card cs-brief"><summary>Case brief — {label}</summary><p>{brief}</p></details>
            <div className="cs-turnbar">
              <span>Turn {turnCount} · aim to conclude by 11, hard cap 15 {concluded && '· concluded'}</span>
              {/* Speed is adjustable mid-hearing — a student shouldn't have to
                  abandon a case just because the bench reads too slowly. */}
              <span className="cs-speed">
                Speed
                {SPEECH_SPEEDS.map((s) => (
                  <button key={s} className={`cs-speed-btn ${speed === s ? 'sel' : ''}`} onClick={() => onSpeedChange(s)}>{s}x</button>
                ))}
              </span>
            </div>

            <div className="cs-arena">
              <div className="cs-panel cs-student">
                <div className="cs-panel-h">You — {position}</div>
                <textarea className="cs-textarea" rows={7} value={statement} disabled={busy || aiSpeaking}
                  placeholder={aiSpeaking ? 'The court is speaking…' : (SR ? 'Speak or type your statement…' : 'Type your statement…')}
                  onChange={(e) => { const w = e.target.value.trim().split(/\s+/).filter(Boolean); if (w.length >= MAX_WORDS) setWarn(true); setStatement(w.slice(0, MAX_WORDS).join(' ') + (e.target.value.endsWith(' ') && w.length < MAX_WORDS ? ' ' : '')); }} />
                <div className="cs-answer-tools">
                  <button className={`cs-btn ${recording ? 'cs-rec' : 'cs-primary'} cs-small`} onClick={toggleRec} disabled={busy || wordCount >= MAX_WORDS || aiSpeaking}>
                    {recording ? '⏹ Stop' : '🎤 Speak'}
                  </button>
                  <span className={`cs-wc ${wordCount >= MAX_WORDS ? 'over' : ''}`}>{wordCount}/{MAX_WORDS} words</span>
                  {recording && <div className="cs-meter"><div className="cs-meter-fill" style={{ width: `${voiceLevel}%` }} /></div>}
                </div>
                {aiSpeaking && (
                  <p className="cs-speaking">
                    🔊 The court is speaking — wait for your turn, counsel.
                    {/* Skip is the ONLY control enabled while the court speaks:
                        you may cut the bench short, but you may not talk over it. */}
                    <button className="cs-btn cs-ghost cs-small cs-skip" onClick={skipSpeech}>⏭ Skip</button>
                  </p>
                )}
                {warn && !aiSpeaking && <p className="cs-warn">⚖ 200-word limit reached — real courts don't let you talk too much, counsel.</p>}
                <div className="cs-actions">
                  <button className="cs-btn cs-primary" onClick={onSubmitTurn} disabled={busy || !statement.trim() || aiSpeaking}>{busy ? 'The court listens…' : 'Submit statement →'}</button>
                  <button className="cs-btn cs-ghost cs-small" onClick={onFinish} disabled={busy || aiSpeaking}>Rest my case</button>
                  {/* Quit stays enabled even mid-speech — a student who wants
                      out should never have to wait for the AI to finish. */}
                  <button className="cs-btn cs-ghost cs-small cs-quit" onClick={onQuit} disabled={busy}>Quit hearing</button>
                </div>
              </div>

              <div className="cs-panel cs-judge">
                <div className="cs-panel-h">⚖ The Bench</div>
                <p className="cs-speech">{judgeText}</p>
              </div>

              <div className="cs-panel cs-opp">
                <div className="cs-panel-h">Opposing Counsel</div>
                <p className="cs-speech">{oppText || 'Awaiting your statement…'}</p>
              </div>
            </div>
          </>
        )}

        {phase === 'finishing' && <section className="cs-card cs-status"><span className="cs-spinner" />The bench is preparing its judgment…</section>}

        {/* SUMMARY */}
        {phase === 'summary' && summary && (
          <section className="cs-results">
            <div className="cs-card cs-overall">
              <div className="cs-score"><span className="cs-score-n">{summary.overallScore}</span><span className="cs-score-d">/100</span></div>
              <div className="cs-overall-body">
                <span className={`cs-verdict cs-${summary.verdict}`}>{summary.verdict === 'won' ? 'Case won' : summary.verdict === 'lost' ? 'Case lost' : 'Split decision'}</span>
                <p className="cs-summary"><strong>The judge's judgment:</strong> {summary.judgment}</p>
              </div>
            </div>
            <div className="cs-card">
              <h2 className="cs-h2">Your advocacy</h2>
              <div className="cs-metrics">
                {[['Legal reasoning', summary.legalReasoning], ['Argumentation', summary.argumentation], ['Courtcraft', summary.courtcraft], ['Clarity', summary.clarity]].map(([k, v]) => (
                  <div key={k} className="cs-metric"><div className="cs-metric-h"><span>{k}</span><span className="cs-metric-v">{v}</span></div><div className="cs-bar"><div className="cs-bar-fill" style={{ width: `${v}%` }} /></div></div>
                ))}
              </div>
              {summary.legalKnowledgeLevel && <p className="cs-summary" style={{ marginTop: '14px' }}><strong>Legal knowledge:</strong> {summary.legalKnowledgeLevel}</p>}
            </div>
            {(summary.strengths?.length > 0 || summary.weaknesses?.length > 0 || summary.improvements?.length > 0) && (
              <div className="cs-card">
                <h2 className="cs-h2">Feedback</h2>
                {summary.strengths?.length > 0 && (
                  <div className="cs-fb"><div className="cs-fb-a">Strengths</div>{summary.strengths.map((x, i) => <div key={i} className="cs-fb-c">• {x}</div>)}</div>
                )}
                {summary.weaknesses?.length > 0 && (
                  <div className="cs-fb"><div className="cs-fb-a">Weaknesses</div>{summary.weaknesses.map((x, i) => <div key={i} className="cs-fb-c">• {x}</div>)}</div>
                )}
                {summary.improvements?.length > 0 && (
                  <div className="cs-fb"><div className="cs-fb-a">What to improve</div>{summary.improvements.map((x, i) => <div key={i} className="cs-fb-c">• {x}</div>)}</div>
                )}
              </div>
            )}
            <p className="cs-disclaimer">{summary.disclaimer}</p>
            <div className="cs-actions"><button className="cs-btn cs-primary" onClick={restart}>New case →</button></div>
          </section>
        )}
      </div>
    </div>
  );
}

const STYLES = `
.cs-root{--bg:#090a0f;--surface:rgba(18, 19, 26, 0.88);--surface-2:rgba(28, 30, 42, 0.95);--border:rgba(212, 175, 55, 0.32);--text:#f8f5eb;--muted:#b8af94;--accent:#d4af37;--rec:#e57373;--judge:#ffd700;
  min-height:100vh;background:radial-gradient(ellipse at 50% 10%, #1e1a10 0%, #06070a 70%);color:var(--text);font-family:'Lora',Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.cs-container{max-width:1080px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.cs-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.cs-title{font-size:clamp(24px,5vw,36px);margin:0 0 6px;font-weight:700;background:linear-gradient(135deg, #FFF1C5 0%, #D4AF37 50%, #AA771C 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 2px 10px rgba(212, 175, 55, 0.3));}
.cs-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.cs-badge{border:1px solid var(--border);color:var(--judge);border-radius:999px;padding:4px 14px;font-size:12px;white-space:nowrap;background:rgba(212, 175, 55, 0.1);box-shadow:0 0 10px rgba(212, 175, 55, 0.1);}
.cs-card{background:var(--surface);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--border);border-radius:16px;padding:clamp(18px,3.5vw,28px);margin-bottom:20px;box-shadow:0 12px 35px rgba(0,0,0,0.8), 0 0 20px rgba(212, 175, 55, 0.08);}
.cs-h2{font-size:17px;margin:0 0 12px;font-weight:700;color:#FFF1C5;}
.cs-error{color:#e6bcbc;border-color:#5a3a3a;}
.cs-input{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:inherit;font-size:14.5px;padding:12px 14px;margin-bottom:18px;}
.cs-input:focus{outline:none;border-color:var(--accent);}
.cs-voice-row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:8px;}
@media(min-width:640px){.cs-voice-row{grid-template-columns:1fr 1fr;}}
.cs-voice-col{display:flex;flex-direction:column;gap:6px;}
.cs-voice-label{font-size:12px;color:var(--muted);font-weight:700;}
.cs-select{margin-bottom:0;cursor:pointer;}
.cs-voice-note{color:var(--muted);font-size:12.5px;font-style:italic;margin:0 0 18px;}
.cs-overview-sub{color:var(--muted);font-size:14px;margin:0 0 14px;}
.cs-overview-text{font-size:15.5px;line-height:1.7;white-space:pre-wrap;margin:0 0 18px;}
.cs-chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;}
.cs-chip{font-family:inherit;font-size:15px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;transition:border-color .2s, transform .15s;}
.cs-chip.sel{background:linear-gradient(135deg, #FFF1C5 0%, #D4AF37 50%, #AA771C 100%);color:#07070a;border-color:#D4AF37;font-weight:700;box-shadow:0 4px 15px rgba(212, 175, 55, 0.3);}
.cs-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;}
.cs-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);transition:transform .15s, box-shadow .15s;}
.cs-btn:disabled{opacity:.5;cursor:not-allowed;}
.cs-primary{background:linear-gradient(135deg, #FFF1C5 0%, #D4AF37 50%, #AA771C 100%);color:#07070a;border-color:#D4AF37;font-weight:700;box-shadow:0 4px 20px rgba(212, 175, 55, 0.35);}
.cs-ghost{background:transparent;color:var(--text);}
.cs-small{padding:9px 14px;font-size:13px;}
.cs-rec{background:var(--rec);color:#fff;border-color:var(--rec);font-weight:700;}
.cs-status{display:flex;align-items:center;gap:12px;color:var(--muted);}
.cs-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:cs-spin .8s linear infinite;}
@keyframes cs-spin{to{transform:rotate(360deg);}}
.cs-brief{color:var(--muted);}
.cs-brief summary{cursor:pointer;font-weight:700;color:var(--text);}
.cs-brief p{margin:10px 0 0;}
.cs-turnbar{color:var(--muted);font-size:13px;margin:0 0 34px;display:flex;justify-content:center;align-items:center;gap:16px;flex-wrap:wrap;text-align:center;}
.cs-speed{display:inline-flex;align-items:center;gap:6px;}
.cs-speed-btn{font-family:inherit;font-size:12px;padding:3px 9px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);color:var(--muted);cursor:pointer;}
.cs-speed-btn.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.cs-arena{display:grid;grid-template-columns:1fr;gap:16px;align-items:start;}
@media(min-width:860px){.cs-arena{grid-template-columns:1fr 1.15fr 1fr;}}
.cs-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
.cs-panel-h{font-weight:700;font-size:14px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.cs-judge{border-color:#5a4f34;background:#191712;}
.cs-judge .cs-panel-h{color:var(--judge);}
@media(min-width:860px){.cs-judge{margin-top:-22px;box-shadow:0 6px 24px rgba(0,0,0,.4);}}
.cs-opp .cs-panel-h{color:#c99a9a;}
.cs-speech{margin:0;font-size:14.5px;white-space:pre-wrap;max-height:340px;overflow:auto;}
.cs-textarea{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:Georgia,serif;font-size:14.5px;line-height:1.6;padding:12px;resize:vertical;}
.cs-textarea:focus{outline:none;border-color:var(--accent);}
.cs-answer-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0;}
.cs-wc{font-size:12px;color:var(--muted);}
.cs-wc.over{color:#e6bcbc;}
.cs-meter{flex:1;min-width:80px;height:7px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.cs-meter-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);transition:width .1s;}
.cs-warn{color:#e0c68a;font-size:13px;margin:0 0 8px;}
.cs-speaking{color:var(--judge);font-size:13px;margin:0 0 8px;font-weight:700;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.cs-skip{padding:5px 12px;font-size:12px;border-color:var(--judge);color:var(--judge);}
.cs-quit{border-color:#5a3a3a;color:#e6bcbc;}
.cs-overall{display:flex;align-items:center;gap:24px;flex-wrap:wrap;}
.cs-score{display:flex;align-items:baseline;}
.cs-score-n{font-size:clamp(40px,11vw,60px);font-weight:700;line-height:1;}
.cs-score-d{font-size:18px;color:var(--muted);margin-left:4px;}
.cs-overall-body{flex:1;min-width:220px;}
.cs-verdict{display:inline-block;font-size:12px;padding:3px 12px;border-radius:999px;border:1px solid var(--border);margin-bottom:8px;}
.cs-won{color:#bfe3bf;border-color:#3f5f3f;}
.cs-lost{color:#e6bcbc;border-color:#5a3a3a;}
.cs-split{color:#e0c68a;border-color:#5a4f34;}
.cs-summary{margin:0;color:var(--muted);}
.cs-metrics{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:640px){.cs-metrics{grid-template-columns:1fr 1fr;}}
.cs-metric-h{display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;}
.cs-metric-v{color:var(--accent);font-weight:700;}
.cs-bar{height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.cs-bar-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);}
.cs-fb{border-top:1px solid var(--border);padding:12px 0;}
.cs-fb:first-of-type{border-top:none;}
.cs-fb-a{font-weight:700;font-size:14px;margin-bottom:4px;}
.cs-fb-c{color:var(--muted);font-size:14px;margin:2px 0;}
.cs-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}
`;
