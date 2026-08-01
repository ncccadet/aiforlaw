/**
 * draftingLab.service.js — v3: three-step flow
 * Step 1 View & Learn (library) · Step 2 guided drafting (case + fields) · Step 3 AI feedback
 * All API calls go through here — pages never call `api` directly.
 * Contract: _contracts/04-drafting-lab.md
 */
import api from './api';

export const getLibrary       = ()        => api.get('/api/drafting-lab/library');
export const getOptions       = ()        => api.get('/api/drafting-lab/options');
export const startCaseStudy   = (payload) => api.post('/api/drafting-lab/case-study', payload); // {template_type} — counts against 3/day
export const getCaseResult    = (docId)   => api.get(`/api/drafting-lab/case-study/result/${docId}`);
export const submitCaseStudy  = (payload) => api.post('/api/drafting-lab/case-study/submit', payload); // {doc_id, fields}
export const getScore         = (docId)   => api.get(`/api/drafting-lab/case-study/score/${docId}`);
export const getHistory       = ()        => api.get('/api/drafting-lab/history');
