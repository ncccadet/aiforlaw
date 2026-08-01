/**
 * lawNewsFetch.service.js — Law News Source: real articles via Google News RSS search.
 * Contract: _contracts/08-law-news-email.md
 *
 * WHY GOOGLE NEWS RSS, NOT A HAND-PICKED SITE LIST: the founder explicitly
 * wants coverage of "everything on the internet," not a handful of curated
 * outlets. news.google.com/rss/search aggregates real articles from
 * thousands of publishers for a given query, no API key required. Every
 * item returned is a REAL article with a REAL link — this function never
 * invents anything; it only parses what Google News' RSS feed actually
 * returned. The AI (lawNewsSummarize.service.js) only ever summarizes an
 * already-fetched real item — it never originates the news itself, which
 * is what the OLD (v2) "AI invents the news" design got wrong.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 10000;
const MAX_ITEMS_PER_QUERY = 20;

// Overridable via env for testing only (e.g. pointing at a local mock RSS
// server) — defaults to the real Google News RSS search endpoint in every
// real environment, staging and production included. Same pattern as
// GEMINI_API_BASE in gemini.service.js.
const RSS_BASE = process.env.NEWS_RSS_BASE || 'https://news.google.com/rss/search';

/** Builds a Google News RSS search URL for a query, scoped to India/English
 * (hl/gl/ceid) so results are relevant to Indian law students. */
function rssUrlFor(queryText) {
  const q = encodeURIComponent(queryText);
  return `${RSS_BASE}?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
}

/** Google News RSS titles are formatted "Headline - Publisher Name" — split
 * that back into a clean headline + publisher for display, since the raw
 * title looks odd rendered whole on a card. */
function splitTitleAndSource(rawTitle) {
  const idx = rawTitle.lastIndexOf(' - ');
  if (idx === -1) return { title: rawTitle.trim(), sourceName: null };
  return { title: rawTitle.slice(0, idx).trim(), sourceName: rawTitle.slice(idx + 3).trim() };
}

async function fetchArticlesForQuery(queryText) {
  const url = rssUrlFor(queryText);
  const { data: xml } = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VoxeraForLawBot/1.0)' },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    if (items.length >= MAX_ITEMS_PER_QUERY) return false;
    const $el = $(el);
    const rawTitle = $el.find('title').first().text().trim();
    const link = $el.find('link').first().text().trim();
    const pubDateRaw = $el.find('pubDate').first().text().trim();
    const description = $el.find('description').first().text().trim();
    if (!rawTitle || !link) return;

    const { title, sourceName } = splitTitleAndSource(rawTitle);
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;

    items.push({
      title,
      sourceName: sourceName || $el.find('source').first().text().trim() || null,
      sourceUrl: link,
      // description is often itself an <a>-wrapped snippet — strip tags for
      // a plain-text snippet to hand to the summarizer.
      snippet: cheerio.load(description || '')('body').text().trim().slice(0, 2000),
      publishedAt: pubDate && !isNaN(pubDate.getTime()) ? pubDate : null,
    });
  });

  return items;
}

module.exports = { fetchArticlesForQuery };
