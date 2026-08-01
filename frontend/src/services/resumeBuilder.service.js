/**
 * resumeBuilder.service.js
 * All API calls for the resumeBuilder feature go here.
 * Pages import from this file — never call api directly in a page component.
 *
 * Build is gated at 50/month (see resumeBuilder.routes.js). saveDraft() is
 * free/unlimited and never an AI call. enhanceText() has no daily limit
 * (founder decision) but the backend caps input at 1,500 chars / output at
 * 350 tokens. There is deliberately no analyzeResume() here — an earlier
 * draft of this feature had a whole-draft "AI Analyze" call; removed
 * 2026-07-22 per founder decision in favor of the deterministic completeness
 * bar only (see ResumeBuilderPage.jsx's CompletenessBar, zero AI cost).
 */
import api from './api';

export const getTemplates = () =>
  api.get('/api/resume-builder/templates').then((res) => res.data);

export const getDraft = () =>
  api.get('/api/resume-builder/draft').then((res) => res.data);

export const saveDraft = (draft) =>
  api.post('/api/resume-builder/draft', draft).then((res) => res.data);

// Template is chosen at Build time, not up front — same saved draft can be
// rendered into any template without re-filling the form.
export const buildResume = (templateId) =>
  api.post('/api/resume-builder/build', { template_id: templateId }).then((res) => res.data);

export const getBuildResult = (buildId) =>
  api.get(`/api/resume-builder/result/${buildId}`).then((res) => res.data);

export const downloadResume = () =>
  api.get('/api/resume-builder/download').then((res) => res.data);

// Last 5 builds, each with its own download URL — every build is a
// permanent, separate S3 object + documents row (nothing is ever
// overwritten), so this history survives even if the student deletes their
// local download. Added 2026-07-22 (founder request).
export const getResumeHistory = () =>
  api.get('/api/resume-builder/history').then((res) => res.data);

// ── Profile photo — client → S3 direct upload (project rule: uploads never
// pass through the API process). Two-step: ask the backend for a short-lived
// presigned PUT URL, then PUT the raw file straight to S3 with plain fetch
// (NOT the `api` axios instance — this call goes to S3, not our backend, so
// it must not carry our auth cookie or JSON headers).
export const getPhotoUploadUrl = (file) => {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const contentType = file.type || 'image/jpeg';
  return api
    .get(`/api/resume-builder/photo-upload-url?ext=${encodeURIComponent(ext)}&contentType=${encodeURIComponent(contentType)}`)
    .then((res) => res.data);
};

export const uploadPhotoToS3 = async (file) => {
  const { uploadUrl, photoKey } = await getPhotoUploadUrl(file);
  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
  if (!putRes.ok) throw new Error('Photo upload failed.');
  return photoKey;
};

// Per-field "AI Enhance" button — sends ONE text box's current value, gets
// back a professionally rewritten version. No daily limit (founder
// decision); the backend caps input at 1,500 chars and output at 350 tokens.
export const enhanceText = (text) =>
  api.post('/api/resume-builder/enhance', { text }).then((res) => res.data);
