/**
 * jobBoard.service.js
 * All API calls for the jobBoard feature go here.
 * Pages import from this file — never call api directly in a page component.
 */
import api from './api';

// filters: { state, type, govt, salaryMax, sort, page }
//   state    — a name from services/indianStates.js; server maps it to cities
//   salaryMax— annual rupees; the server ignores it at/above the slider's max
export const getJobs = (filters = {}) =>
  api.get('/api/jobs', { params: filters }).then((res) => res.data);

// { totalActive, newToday }
export const getJobStats = () =>
  api.get('/api/jobs/stats').then((res) => res.data);

/**
 * Records that a student clicked through to apply. Added 2026-07-28 for the
 * admin panel (_contracts/09-admin-panel.md).
 *
 * FIRE AND FORGET — deliberately. The caller must NOT await this, and the
 * .catch() below swallows every failure silently:
 *
 *   - The student is on their way to a vacancy. Analytics must never be
 *     between them and that link, not even for 80ms.
 *   - The server already always answers 204, even when its insert fails, so
 *     the only errors reachable here are network-level ones. An unhandled
 *     rejection from those would print a red error in the student's console
 *     for something that does not concern them.
 *
 * Returns nothing. There is no success signal to act on by design.
 */
export const trackApplyClick = (jobId) => {
  api.post(`/api/jobs/${jobId}/click`).catch(() => {});
};
