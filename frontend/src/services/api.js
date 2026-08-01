/**
 * api.js — Shared axios instance
 *
 * withCredentials: true is REQUIRED for httpOnly cookies to be sent.
 * Without it, the auth cookie is stripped from every request.
 *
 * All service files import this — never create a second axios instance.
 */
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  withCredentials: true, // Critical: sends httpOnly cookie on every request
});

api.interceptors.request.use((config) => {
  try {
    const token = sessionStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {}
  return config;
});

/**
 * SILENT SESSION REFRESH
 * ----------------------
 * The access token lives 15 minutes (JWT_ACCESS_EXPIRES); the refresh token
 * lives 7 days (JWT_REFRESH_EXPIRES). Both are httpOnly cookies, so this file
 * can never read them — it can only react to the 401 the server returns once
 * the access token has expired.
 *
 * This interceptor used to do `window.location.href = '/login'` on ANY 401,
 * which meant a student who left a tab open for 15 minutes was thrown back to
 * the login screen mid-task, with no explanation, even though their 7-day
 * refresh token was still perfectly valid. That was reported as real feedback
 * and is what this code fixes: on a 401 we now quietly ask the server for a
 * fresh access token and replay the request that failed. The student sees
 * nothing at all.
 *
 * Login only reappears when it genuinely should: the refresh token itself has
 * expired (7 days), or the account was signed in on another device (the
 * server's single-device rule invalidates the old session).
 */

// Endpoints that must NEVER trigger a refresh-and-retry:
//  - /login, /forgot-password, /reset-password: a 401 here means "wrong
//    credentials", which the page itself must show the student. Retrying, or
//    redirecting, wipes that message off the screen before it can be read.
//  - /refresh: retrying a failed refresh with another refresh is an infinite loop.
//  - /logout: being logged out is the point.
const NO_REFRESH_PATHS = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
];

// One shared in-flight refresh. A dashboard can fire several requests at once;
// without this they would each POST /api/auth/refresh simultaneously, and the
// slower ones could race against the cookie the faster ones just replaced.
let refreshInFlight = null;

function goToLogin(reason) {
  // sessionStorage (not localStorage) and a plain message only — no token ever
  // touches browser storage. LoginPage already reads this key and displays it,
  // so the student is told why they are being asked to sign in again.
  try { sessionStorage.setItem('authRedirectReason', reason); } catch { /* private mode */ }
  if (window.location.pathname !== '/login') window.location.href = '/login';
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status = err.response?.status;
    const original = err.config;

    // Not an auth problem (or a network failure with no response) — pass it
    // through untouched so the page's own error handling still works.
    if (status !== 401 || !original) return Promise.reject(err);
    if (NO_REFRESH_PATHS.some((p) => (original.url || '').includes(p))) {
      return Promise.reject(err);
    }

    // Already retried once with a fresh token and still 401 — the session is
    // genuinely dead, stop here rather than looping.
    if (original._retriedAfterRefresh) {
      goToLogin('Your session has expired. Please sign in again.');
      return Promise.reject(err);
    }
    original._retriedAfterRefresh = true;

    try {
      if (!refreshInFlight) {
        refreshInFlight = api
          .post('/api/auth/refresh')
          .finally(() => { refreshInFlight = null; });
      }
      await refreshInFlight;
    } catch (refreshErr) {
      // The server distinguishes "your refresh token expired" from "you signed
      // in somewhere else". Passing that distinction on matters: the second one
      // looks like a bug to a student unless it is named.
      const serverReason = refreshErr.response?.data?.error;
      goToLogin(
        serverReason === 'Logged in on another device'
          ? 'You were signed out because this account was signed in on another device.'
          : 'Your session has expired. Please sign in again.'
      );
      return Promise.reject(err);
    }

    // Fresh accessToken cookie is set; replay the original request exactly.
    return api(original);
  }
);

export default api;
