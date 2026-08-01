/**
 * examPrep.service.js — Exam Prep v3
 * Contract: _contracts/01-exam-prep.md
 * All Exam Prep API calls live here. Pages never call axios/fetch directly.
 */
import api from './api';

export const getStructure = () => api.get('/api/exam/structure');

// Resume an in-progress paper after a refresh or a closed tab. Does NOT consume
// one of the 30 monthly papers — that is the whole point of it existing.
export const getActive = () => api.get('/api/exam/active');

// AIBE (Bar Council) — 100 MCQs, 210 minutes.
export const aibeGenerate = () => api.post('/api/exam/aibe/generate');
export const aibeSubmit = (payload) => api.post('/api/exam/aibe/submit', payload); // {paperId, answers:[optionIndex|null]}

// SPPU (University) — 80-mark written paper, 180 minutes.
export const sppuGenerate = (payload) => api.post('/api/exam/sppu/generate', payload); // {program, year, semester, subject}
export const sppuSubmit = (payload) => api.post('/api/exam/sppu/submit', payload);     // {paperId, answers:[text]}

// Library — past question papers.
export const libraryList = (params) => api.get('/api/exam/library', { params });       // {program, year?, semester?}
export const libraryDownload = (id) => api.get(`/api/exam/library/${id}/download`);    // → {url}

// Score trend — pure SQL server-side, no AI.
export const getAnalytics = () => api.get('/api/exam/analytics');
