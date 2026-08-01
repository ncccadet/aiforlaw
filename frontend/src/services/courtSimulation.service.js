/**
 * courtSimulation.service.js
 * All Court Simulation API calls. Pages import from here — never call api directly.
 * Contract: _contracts/05-court-simulation.md
 * Speech is browser-native (SpeechRecognition / speechSynthesis) — handled in the page.
 */
import api from './api';

export const getCaseTypes  = ()          => api.get('/api/court-simulation/case-types');
export const startSession  = (payload)   => api.post('/api/court-simulation/start', payload); // {fieldOfLaw, position, level, studentName}
export const getSession    = (sessionId) => api.get(`/api/court-simulation/session/${sessionId}`);
export const takeTurn      = (payload)   => api.post('/api/court-simulation/turn', payload);   // {session_id, statement, voiceLevel, durationSec, wordCount}
export const finishSession = (sessionId) => api.post('/api/court-simulation/finish', { session_id: sessionId });
export const getResult     = (sessionId) => api.get(`/api/court-simulation/result/${sessionId}`);
