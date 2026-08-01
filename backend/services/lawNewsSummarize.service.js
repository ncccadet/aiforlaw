/**
 * lawNewsSummarize.service.js — one Gemini call per REAL fetched article.
 * Contract: _contracts/08-law-news-email.md
 *
 * IMPORTANT: this function is only ever given an article that was already
 * fetched for real (title + snippet + real link) by lawNewsFetch.service.js.
 * It is never asked to originate news from its own knowledge — only to
 * summarize and tag what's in front of it. That distinction is the whole
 * fix for the old v2 design's hallucination risk.
 *
 * Token budget (founder-specified): 1,500 in / 220 out per article — plenty
 * for a short RSS snippet in, and enough out for a 2-3 sentence student-
 * facing summary plus a state/category tag, nothing more.
 */
const { generateText } = require('./gemini.service');

const IN_CAP_TOKENS = 1500;
const OUT_CAP_TOKENS = 220;
const CHARS_PER_TOKEN = 4;
const cap = (text, tokenCap) => String(text || '').slice(0, tokenCap * CHARS_PER_TOKEN);

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry',
  'Chandigarh', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu',
  'Lakshadweep',
];

function parseJson(text) {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
}

const buildPrompt = (article) =>
`You are summarizing ONE real news article for Indian law students. You are given the
article's real title and a snippet fetched from its actual RSS feed — do not add any facts,
dates, case names, or details beyond what's in this snippet. If the snippet is too thin to
summarize meaningfully, say so plainly rather than inventing detail.

Article title: ${article.title}
Publisher: ${article.sourceName || 'unknown'}
Fetched snippet: ${article.snippet || '(no snippet available)'}

Return STRICT JSON only:
{
  "summary": "<2-3 sentences, plain language, what a law student needs to know>",
  "category": "case" | "amendment" | "other",
  "stateTag": "<one of: ${INDIAN_STATES.join(', ')}, or National if not state-specific>"
}
Rules: base the summary ONLY on the title/snippet above; if a specific state/High Court is
named, use that state; if it's Supreme Court, Parliament, or not state-specific, use
"National". Keep the whole response within the output budget.`;

async function summarizeArticle(article) {
  const prompt = cap(buildPrompt(article), IN_CAP_TOKENS);
  const out = await generateText({ prompt, maxOutputTokens: OUT_CAP_TOKENS, temperature: 0.2 });
  const parsed = parseJson(out.text);

  return {
    summary: String(parsed.summary || '').slice(0, 800),
    category: ['case', 'amendment', 'other'].includes(parsed.category) ? parsed.category : 'other',
    stateTag: INDIAN_STATES.includes(parsed.stateTag) ? parsed.stateTag : 'National',
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    model: out.model,
  };
}

module.exports = { summarizeArticle, INDIAN_STATES };
