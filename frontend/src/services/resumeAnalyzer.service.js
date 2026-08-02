/**
 * resumeAnalyzer.service.js
 * All API calls for the Resume Analyzer feature. Pages import from here — never
 * call axios/fetch for our own API directly in a component.
 * Contract: _contracts/02-resume-analyzer.md
 */
import api from './api';

// Client-side guard rails (the worker re-validates everything server-side).
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MIN_FILE_BYTES = 100;             // 100 Bytes

/**
 * Validate the chosen file before we even ask for an upload URL.
 * Returns an error string, or null if the file looks OK.
 */
export const validateFile = (file) => {
  if (!file) return 'Please choose a PDF file.';
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) return 'Only PDF résumés are accepted.';
  if (file.size > MAX_FILE_BYTES) return 'That file is larger than 5 MB. Please upload a smaller PDF.';
  if (file.size < MIN_FILE_BYTES) return 'That file looks empty.';
  return null;
};

// 1. Ask our API for a short-lived presigned S3 PUT URL.
export const getUploadUrl = () => api.get('/api/resume-analyzer/upload-url');

// 2. Upload the PDF straight to S3 (NOT through our API — no auth cookie needed).
//    The Content-Type MUST match the one the presigned URL was signed with.
export const uploadToS3 = async (uploadUrl, file) => {
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    });
    if (res.ok) return null;
  } catch (e) {
    console.warn('[uploadToS3] Direct S3 upload failed, using backend upload fallback:', e.message);
  }

  // Fallback to backend raw upload endpoint if S3 direct upload is blocked by browser CORS
  const arrayBuffer = await file.arrayBuffer();
  const rawRes = await api.post('/api/resume-analyzer/upload-raw', arrayBuffer, {
    headers: { 'Content-Type': 'application/pdf' },
  });
  return rawRes.data;
};

// 3. Tell our API the upload is done → creates the pending analysis + enqueues the worker.
export const analyze = (s3Key) => api.post('/api/resume-analyzer/analyze', { s3Key });

// 4. Poll the result by doc_id.
export const getResult = (docId) => api.get(`/api/resume-analyzer/result/${docId}`);

// 5. List past analyses (metadata only).
export const getHistory = () => api.get('/api/resume-analyzer/history');

// 6. Get a fresh presigned download URL for the analysis's PDF report. Only
// valid once status is 'complete' and a report was actually generated (see
// resumeAnalyzer.worker.js's renderReportPdf — report generation is
// best-effort, so this can 404 even for a completed analysis in the rare case
// the PDF render itself failed).
export const getReportUrl = (docId) => api.get(`/api/resume-analyzer/report/${docId}`);
