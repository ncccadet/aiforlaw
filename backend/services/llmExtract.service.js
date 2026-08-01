/**
 * llmExtract.service.js — Source 3 of the Job Board pipeline.
 *
 * Only runs for job_sources rows with scrape_method='llm_extract' — sites
 * whose markup the generic directScrape.service.js heuristic can't parse
 * usefully (JS-rendered listings, inconsistent structure, etc.). Raw HTML
 * -> Gemini -> structured JSON. This is the ONLY AI usage anywhere in Job
 * Board, runs at scrape time (never per student), and is hard-capped per
 * run by LLM_EXTRACT_MAX_PER_RUN (contract default: 50) — enforced by the
 * caller (jobScraper.worker.js), not in here, so the cap is visible in one
 * place.
 */
const axios = require('axios');
const { generateText } = require('./gemini.service');

const MAX_HTML_CHARS = 8000; // bounds tokensIn cost — truncate, don't send full pages
const FETCH_TIMEOUT_MS = 10000;

function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .slice(0, MAX_HTML_CHARS);
}

/** Pulls the first {...} or [...] block out of a response that may be
 * wrapped in markdown code fences (```json ... ```) — Gemini does this
 * even when asked for raw JSON. */
function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in Gemini response');
  return raw.slice(start).trim();
}

async function extractListingsFromSource(source) {
  const { data: html } = await axios.get(source.url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VoxeraForLawBot/1.0)' },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const trimmed = stripToText(html);

  const prompt = `You extract legal job/internship listings from a webpage's raw HTML.
Return ONLY a JSON array (no prose, no markdown fences). Each element:
{"title": string, "firm": string|null, "location": string|null, "job_type": "internship"|"full_time", "is_government": boolean|null, "apply_url": string|null, "salary_text": string|null}
If there are no listings, return [].
Source page: ${source.url}
HTML (truncated):
${trimmed}`;

  const { text, tokensIn, tokensOut, finishReason } = await generateText({
    prompt,
    maxOutputTokens: 1000,
    temperature: 0,
  });

  let listings = [];
  try {
    const jsonText = extractJsonBlock(text);
    const parsed = JSON.parse(jsonText);
    listings = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`Gemini response wasn't parseable JSON: ${err.message}`);
  }

  // Defensive normalization — never trust an LLM to perfectly follow a schema.
  listings = listings
    .filter((j) => j && typeof j.title === 'string' && j.title.trim())
    .slice(0, 20)
    .map((j) => ({
      title: String(j.title).slice(0, 200),
      firm: j.firm ? String(j.firm).slice(0, 200) : source.name,
      location: j.location ? String(j.location).slice(0, 120) : null,
      job_type: j.job_type === 'internship' ? 'internship' : 'full_time',
      is_government: typeof j.is_government === 'boolean' ? j.is_government : null,
      apply_url: (() => {
        if (!j.apply_url) return source.url;
        try {
          return new URL(j.apply_url, source.url).href;
        } catch {
          return source.url;
        }
      })(),
      salary_text: j.salary_text ? String(j.salary_text).slice(0, 120) : null,
    }));

  return { listings, tokensIn, tokensOut, finishReason };
}

module.exports = { extractListingsFromSource };
