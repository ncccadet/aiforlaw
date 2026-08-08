/**
 * gemini.service.js — shared Gemini API client.
 *
 * IMPORTANT re: "AQ."-prefixed API keys (the format Google now issues by
 * default from AI Studio, vs the older "AIza..." format): these keys work
 * fine against Gemini's NATIVE REST endpoint (what this file calls). The
 * failures reported around AQ. keys (401 ACCESS_TOKEN_TYPE_UNSUPPORTED /
 * invalid_api_key) come from routing the key through an OpenAI-COMPATIBLE
 * endpoint or SDK shim instead — a different code path entirely. So: never
 * add an OpenAI-compatible client (e.g. pointing the `openai` npm package's
 * baseURL at Gemini) anywhere in this codebase. Always call
 * generativelanguage.googleapis.com/v1beta directly, as below.
 *
 * Auth: x-goog-api-key header (not a query-string ?key=, which ends up in
 * logs/proxies more often).
 *
 * Model + key come from env — GEMINI_API_KEY, GEMINI_MODEL. Never hardcode
 * either. GEMINI_MODEL defaults to gemini-3.1-flash-lite (the model this
 * project is contracted to use) if unset, so a missing env var fails loud
 * (auth error) rather than silently calling a different/pricier model.
 */
const axios = require('axios');

// Overridable via env for testing only (e.g. pointing at a local mock server
// that mimics Gemini's response shape) — defaults to the real endpoint in
// every real environment, staging and production included.
const GEMINI_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
// Confirmed working model IDs from the Gemini API v1beta (verified 2026-08-02).
// The originally configured 'gemini-3.1-flash-lite' does NOT exist — the correct
// name is 'gemini-3.1-flash-lite-preview'. Set this as default since the project
// was intended to use the 3.1 Flash Lite model family.
const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls Gemini's generateContent endpoint with a single text prompt.
 * Returns { text, tokensIn, tokensOut } on success.
 * Throws on any non-2xx response or network error — caller decides whether
 * that's fatal (e.g. student-facing feature) or skippable (e.g. one source
 * in a 785-source scrape run; never let one LLM call kill the whole run).
 *
 * 429 (rate limit) retry: found in real staging testing (2026-07-23) — Law
 * News's worker fired ~150 summarize calls back-to-back with zero pacing and
 * blew through Gemini's requests-per-minute limit, so 141/158 calls failed
 * with a plain "Request failed with status code 429" and were silently
 * skipped by the caller's per-item fault isolation. That's a real bug (most
 * of a day's genuinely-new articles never getting summarized), not a
 * one-off — any feature that ever fires several Gemini calls close together
 * would hit the same wall. Fixed HERE (not per-feature) so every caller
 * benefits: on a 429, wait (honoring the API's own Retry-After header if
 * present, else exponential backoff) and retry up to `retries429` times
 * before giving up. Non-429 errors are never retried — those are real
 * failures (bad key, bad prompt, network issue), not a pacing problem.
 */
async function generateText({ prompt, maxOutputTokens = 800, temperature = 0.2, timeoutMs = 15000, retries429 = 3 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — cannot call Gemini');
  }

  const requestedModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const modelsToTry = Array.from(new Set([
    requestedModel,
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-flash-lite-latest',
  ]));

  let lastErr;
  for (const model of modelsToTry) {
    const url = `${GEMINI_BASE}/models/${model}:generateContent`;
    for (let attempt = 0; attempt <= retries429; attempt++) {
      try {
        const response = await axios.post(
          url,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens, temperature },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            timeout: timeoutMs,
          }
        );

        const data = response.data;
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.map((p) => p.text).join('') || '';
        const tokensIn = data?.usageMetadata?.promptTokenCount || 0;
        const tokensOut = data?.usageMetadata?.candidatesTokenCount || 0;
        const finishReason = candidate?.finishReason;

        return { text, tokensIn, tokensOut, finishReason, model };
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        console.warn(`[gemini.service] Call failed for model ${model} (status ${status}):`, err.response?.data?.error?.message || err.message);

        // If 404 or 400 (model not found), break inner retry loop to try next model in modelsToTry
        if (status === 404 || status === 400) {
          break;
        }

        if (status !== 429 || attempt === retries429) {
          break;
        }
        const retryAfterHeader = err.response?.headers?.['retry-after'];
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        const backoffMs = retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : 1500 * Math.pow(2, attempt);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

module.exports = { generateText, DEFAULT_MODEL };
