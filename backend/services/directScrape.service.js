/**
 * directScrape.service.js — Source 1 of the Job Board pipeline.
 *
 * Generic best-effort scraper for the 785 curated sites in job_sources.
 * There is no per-site custom parser here (785 different sites, no shared
 * markup) — this is a first-pass heuristic: pull every <a> whose visible
 * text looks like a job/internship listing, from anywhere on the page.
 * That means noisy sources will produce noisy/irrelevant candidates and
 * clean sources will produce clean ones — expected for a v1 generic
 * scraper. Sources that consistently produce nothing useful are exactly
 * the ones a founder should flag scrape_method='llm_extract' for (Source 3
 * picks up where this generic heuristic can't cope with the markup).
 */
const axios = require('axios');
const cheerio = require('cheerio');

const LISTING_KEYWORDS =
  /(internship|intern\b|vacan(cy|cies)|recruit(ment)?|hiring|job\s*opening|associate|clerkship|walk-?in|apply\s*now|career|paralegal|legal\s*officer)/i;

// Found 2026-07-22 (founder report): the curated 785 sites are law-related
// domains (courts, law firms, NALSA-type portals), but their general
// recruitment/vacancy notices routinely bundle non-legal support-staff
// postings — driver, peon, sweeper, general clerk, security guard — right
// alongside actual legal roles, all under the same generic terms
// (vacancy/recruitment/hiring) LISTING_KEYWORDS above already matches on.
// A law student has no use for a "Driver" posting just because it appeared
// on a district court's recruitment page. This is a second gate, AFTER
// LISTING_KEYWORDS: if the text names one of these clearly non-legal
// support roles AND doesn't ALSO contain an explicit legal qualifier
// (e.g. "Law Clerk" survives — bare "Junior Clerk" doesn't), drop it.
const NON_LEGAL_ROLE_PATTERN =
  /\b(driver|peon|sweeper|cook|helper|electrician|plumber|mechanic|security\s*guard|watchman|gardener|housekeeping|receptionist|data\s*entry\s*operator|delivery\s*(boy|executive)|conductor|attender|sanitary\s*worker|multi[-\s]?tasking\s*staff|\bmts\b|stenographer|clerk)\b/i;
// Deliberately does NOT include bare "court" — nearly every posting on these
// curated court-website sources mentions "District Court"/"High Court" as the
// institution name, which would reinstate non-legal roles (a driver or
// stenographer posting on a court's own site) just because the site itself
// is a court. "judicial" is included instead, since that's role language
// ("Judicial Clerk"), not institution language.
const LEGAL_QUALIFIER_PATTERN =
  /(legal|law\b|advocate|litigation|judicial|paralegal|counsel|compliance|contract\s*review)/i;

const MAX_CANDIDATES_PER_SOURCE = 15;
const FETCH_TIMEOUT_MS = 10000; // tight — one hanging gov site can't stall the whole run

async function scrapeSource(source) {
  const { data: html } = await axios.get(source.url, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    headers: {
      // Many gov/court sites block the default axios UA outright.
      'User-Agent':
        'Mozilla/5.0 (compatible; VoxeraForLawBot/1.0; +https://vfl.aifortech.in/about-bot)',
      Accept: 'text/html,application/xhtml+xml',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const $ = cheerio.load(html);
  const seenUrls = new Set();
  const candidates = [];

  $('a').each((_, el) => {
    if (candidates.length >= MAX_CANDIDATES_PER_SOURCE) return false; // cheerio: false stops .each early

    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6 || text.length > 160) return;
    if (!LISTING_KEYWORDS.test(text)) return;
    if (NON_LEGAL_ROLE_PATTERN.test(text) && !LEGAL_QUALIFIER_PATTERN.test(text)) return;

    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, source.url).href;
    } catch {
      return; // malformed href — skip, don't kill the whole source over one bad link
    }

    if (seenUrls.has(absoluteUrl)) return;
    seenUrls.add(absoluteUrl);

    const isGovernment = source.category === 'court' || source.category === 'government';

    candidates.push({
      title: text.slice(0, 160),
      firm: source.name,
      location: null, // generic scraper can't reliably infer this — left null, shown as "Location not listed"
      job_type: /intern/i.test(text) ? 'internship' : 'full_time',
      is_government: isGovernment,
      apply_url: absoluteUrl,
      salary_text: null,
    });
  });

  return candidates;
}

module.exports = { scrapeSource, LISTING_KEYWORDS, NON_LEGAL_ROLE_PATTERN, LEGAL_QUALIFIER_PATTERN, MAX_CANDIDATES_PER_SOURCE };
