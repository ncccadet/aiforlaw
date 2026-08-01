/**
 * aiInterviewer.service.js
 * All AI Interviewer API calls. Pages import from here — never call api directly.
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Speech is entirely browser-native (no backend audio):
 *   - STT: Web Speech API (SpeechRecognition) — implemented in the page.
 *   - TTS: window.speechSynthesis — implemented in the page.
 */
import api from './api';

export const getOptions    = ()          => api.get('/api/ai-interviewer/options');
export const startSession  = (payload)   => api.post('/api/ai-interviewer/start', payload); // {difficulty, role, resume_doc_id?}
export const getSession    = (sessionId) => api.get(`/api/ai-interviewer/session/${sessionId}`);
export const submitAnswer  = (payload)   => api.post('/api/ai-interviewer/answer', payload); // {session_id, index, answer, voiceLevel, durationSec, wordCount}
export const finishSession = (sessionId) => api.post('/api/ai-interviewer/finish', { session_id: sessionId });
export const getResult     = (sessionId) => api.get(`/api/ai-interviewer/result/${sessionId}`);
