/**
 * providerApi.service.js — Source 2 of the Job Board pipeline (provider APIs).
 *
 * Four providers wired up so far:
 *
 *   SerpApi (Google Jobs engine) — READY. Runs a small, fixed set of legal
 *   job/internship search queries against SerpApi's google_jobs engine and
 *   maps results into the same listing shape directScrape.service.js and
 *   llmExtract.service.js already use. Gated on SERPAPI_KEY — a clean skip
 *   with a log line if unset, same pattern as every other guarded stage.
 *
 *   JSearch (RapidAPI) — READY, code added 2026-07-27, waiting on a real
 *   key. Aggregates Google for Jobs + LinkedIn + Indeed + Glassdoor +
 *   ZipRecruiter into one API, covers India (country=in). Free tier is
 *   200 requests/month — this file uses the same small fixed query set as
 *   SerpApi (6 queries/run, every 2 days = ~90/month), comfortably inside
 *   that free tier. Gated on JSEARCH_API_KEY (a RapidAPI key) — sign up at
 *   rapidapi.com, subscribe to the JSearch API (free plan), the key is the
 *   same for every RapidAPI-hosted API you subscribe to under that account.
 *
 *   Adzuna — READY, code added 2026-07-27, waiting on real credentials.
 *   Covers 12 countries including India (country code "in"). Requires TWO
 *   credentials (app_id AND app_key) — sign up at
 *   https://developer.adzuna.com/signup, both come from the same
 *   registration. Gated on BOTH ADZUNA_APP_ID and ADZUNA_APP_KEY being set.
 *
 *   Apify — PLUMBING ONLY, NOT ENABLED. Apify runs actors, and different
 *   actors take completely different input JSON and return completely
 *   different field names (title vs positionName vs jobTitle, etc.). There
 *   is no safe generic default here — running the wrong actor blind burns
 *   real Apify credits for probably-wrong results. Gated on APIFY_ACTOR_ID
 *   (which actor to run) — until that's set, this stage logs a clear
 *   "waiting on actor ID" message and returns 0, same as the SERPAPI_KEY
 *   gate. APIFY_TOKEN alone is not sufficient to run this stage.
 *
 * Each provider call is independently try/caught by the caller
 * (jobScraper.worker.js's runProviderApiStage) — one provider being down
 * or erroring must not block the others, same fault-isolation rule as
 * Source 1's per-site isolation.
 */
const axios = require('axios');

const FETCH_TIMEOUT_MS = 15000;

// Small, fixed query set — SerpApi bills per search, so this is deliberately
// short rather than an open-ended sweep. Broad enough to cover what a law
// student would actually look for; can grow later once real cost/yield data
// comes in from a few runs.
const SERPAPI_QUERIES = [
  'law internship India',
  'legal associate jobs India',
  'paralegal jobs India',
  'litigation associate jobs India',
  'legal counsel jobs India',
  'law clerk India',
];

const GOVT_FIRM_PATTERN = /(government|govt\.?|ministry|high court|supreme court|district court|puc|public sector|psu|municipal|state\s+bar|bar\s+council)/i;
const INTERNSHIP_PATTERN = /intern(ship)?/i;

function normalizeJobType(scheduleType, title) {
  if (INTERNSHIP_PATTERN.test(title || '')) return 'internship';
  if (/intern/i.test(scheduleType || '')) return 'internship';
  if (/part[-\s]?time/i.test(scheduleType || '')) return 'part_time';
  return 'full_time';
}

/** Maps one SerpApi google_jobs "jobs_results" entry to our listing shape. */
function mapSerpApiJob(item) {
  const applyUrl = item.apply_options?.[0]?.link || item.share_link || null;
  if (!applyUrl) return null; // no way for a student to actually apply — drop it

  return {
    title: (item.title || '').slice(0, 160),
    firm: item.company_name || null,
    location: item.location || null,
    job_type: normalizeJobType(item.detected_extensions?.schedule_type, item.title),
    apply_url: applyUrl,
    is_government: GOVT_FIRM_PATTERN.test(item.company_name || '') || GOVT_FIRM_PATTERN.test(item.location || ''),
    salary_text: item.detected_extensions?.salary || null,
  };
}

async function fetchFromSerpApi() {
  if (!process.env.SERPAPI_KEY) {
    console.log('[job-scraper] Source 2 (SerpApi) skipped — SERPAPI_KEY not set.');
    return { listings: [], queriesUsed: 0 };
  }

  const listings = [];
  let queriesUsed = 0;

  for (const q of SERPAPI_QUERIES) {
    try {
      const { data } = await axios.get('https://serpapi.com/search.json', {
        timeout: FETCH_TIMEOUT_MS,
        params: {
          engine: 'google_jobs',
          q,
          location: 'India',
          hl: 'en',
          api_key: process.env.SERPAPI_KEY,
        },
      });
      queriesUsed++;
      const results = Array.isArray(data?.jobs_results) ? data.jobs_results : [];
      for (const item of results) {
        const mapped = mapSerpApiJob(item);
        if (mapped) listings.push(mapped);
      }
    } catch (err) {
      // One bad query must not kill the other five — same row-level fault
      // isolation rule as Source 1's per-site scraping.
      console.error(`[job-scraper] SerpApi query failed ("${q}"):`, err.message);
    }
  }

  return { listings, queriesUsed };
}

/** Maps one JSearch "data[]" entry to our listing shape. JSearch's field
 * names come straight from its own schema (job_title, employer_name, etc.),
 * not shared with SerpApi's, so this gets its own mapper rather than reusing
 * mapSerpApiJob. */
function mapJSearchJob(item) {
  const applyUrl = item.job_apply_link || item.job_google_link || null;
  if (!applyUrl) return null; // same rule as SerpApi — no apply link, drop it

  const employmentType = item.job_employment_type || '';
  let jobType = 'full_time';
  if (/intern/i.test(employmentType) || INTERNSHIP_PATTERN.test(item.job_title || '')) jobType = 'internship';
  else if (/part/i.test(employmentType)) jobType = 'part_time';

  const location = [item.job_city, item.job_state, item.job_country].filter(Boolean).join(', ') || null;

  let salaryText = null;
  if (item.job_min_salary || item.job_max_salary) {
    const currency = item.job_salary_currency || '';
    const period = item.job_salary_period ? `/${item.job_salary_period.toLowerCase()}` : '';
    salaryText = item.job_min_salary && item.job_max_salary
      ? `${currency}${item.job_min_salary}-${item.job_max_salary}${period}`
      : `${currency}${item.job_min_salary || item.job_max_salary}${period}`;
  }

  return {
    title: (item.job_title || '').slice(0, 160),
    firm: item.employer_name || null,
    location,
    job_type: jobType,
    apply_url: applyUrl,
    is_government: GOVT_FIRM_PATTERN.test(item.employer_name || '') || GOVT_FIRM_PATTERN.test(location || ''),
    salary_text: salaryText,
  };
}

async function fetchFromJSearch() {
  if (!process.env.JSEARCH_API_KEY) {
    console.log('[job-scraper] Source 2 (JSearch) skipped — JSEARCH_API_KEY not set.');
    return { listings: [], queriesUsed: 0 };
  }

  const listings = [];
  let queriesUsed = 0;

  // Same fixed query set as SerpApi, deliberately — JSearch's free tier is
  // 200 requests/month, and this file runs every 2 days (~15 runs/month), so
  // 6 queries/run = ~90/month, comfortably inside the free tier with room to
  // spare. Grow this only after checking real usage against the RapidAPI
  // dashboard.
  for (const q of SERPAPI_QUERIES) {
    try {
      const { data } = await axios.get('https://jsearch.p.rapidapi.com/search', {
        timeout: FETCH_TIMEOUT_MS,
        params: { query: q, country: 'in', num_pages: '1' },
        headers: {
          'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      });
      queriesUsed++;
      const results = Array.isArray(data?.data) ? data.data : [];
      for (const item of results) {
        const mapped = mapJSearchJob(item);
        if (mapped) listings.push(mapped);
      }
    } catch (err) {
      // Same row-level fault isolation rule as every other source — one bad
      // query must not kill the rest.
      console.error(`[job-scraper] JSearch query failed ("${q}"):`, err.message);
    }
  }

  return { listings, queriesUsed };
}

/** Maps one Adzuna "results[]" entry to our listing shape. Adzuna's own
 * field names (company.display_name, location.display_name, contract_time)
 * are nested one level deeper than SerpApi's/JSearch's flat shape. */
function mapAdzunaJob(item) {
  const applyUrl = item.redirect_url || null;
  if (!applyUrl) return null;

  const title = item.title || '';
  const firm = item.company?.display_name || null;
  const location = item.location?.display_name || null;

  let jobType = 'full_time';
  if (INTERNSHIP_PATTERN.test(title)) jobType = 'internship';
  else if (item.contract_time === 'part_time') jobType = 'part_time';

  let salaryText = null;
  if (item.salary_min || item.salary_max) {
    salaryText = item.salary_min && item.salary_max
      ? `₹${Math.round(item.salary_min)}-${Math.round(item.salary_max)}`
      : `₹${Math.round(item.salary_min || item.salary_max)}`;
  }

  return {
    title: title.slice(0, 160),
    firm,
    location,
    job_type: jobType,
    apply_url: applyUrl,
    is_government: GOVT_FIRM_PATTERN.test(firm || '') || GOVT_FIRM_PATTERN.test(location || ''),
    salary_text: salaryText,
  };
}

async function fetchFromAdzuna() {
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) {
    console.log('[job-scraper] Source 2 (Adzuna) skipped — ADZUNA_APP_ID and/or ADZUNA_APP_KEY not set.');
    return { listings: [], queriesUsed: 0 };
  }

  const listings = [];
  let queriesUsed = 0;

  // Same fixed query set and reasoning as SerpApi/JSearch — Adzuna bills
  // per-call above its free allowance too, so this stays deliberately small
  // rather than an open-ended sweep.
  for (const q of SERPAPI_QUERIES) {
    try {
      const { data } = await axios.get('https://api.adzuna.com/v1/api/jobs/in/search/1', {
        timeout: FETCH_TIMEOUT_MS,
        params: {
          app_id: process.env.ADZUNA_APP_ID,
          app_key: process.env.ADZUNA_APP_KEY,
          what: q,
          'content-type': 'application/json',
        },
      });
      queriesUsed++;
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const item of results) {
        const mapped = mapAdzunaJob(item);
        if (mapped) listings.push(mapped);
      }
    } catch (err) {
      console.error(`[job-scraper] Adzuna query failed ("${q}"):`, err.message);
    }
  }

  return { listings, queriesUsed };
}

/** Best-effort field matcher — different Apify actors name fields
 * differently (title/positionName/jobTitle, company/companyName, etc.).
 * Tries the common variants; logs what it actually saw on the first item
 * so the mapping can be tightened once a real actor is chosen. */
function mapApifyItem(item, isFirst) {
  const title = item.title || item.positionName || item.jobTitle || item.job_title;
  const firm = item.company || item.companyName || item.company_name || item.employer;
  const applyUrl = item.url || item.link || item.applyUrl || item.apply_url || item.jobUrl;

  if (isFirst) {
    console.log('[job-scraper] Apify first item field names (for tuning mapApifyItem):', Object.keys(item));
  }

  if (!title || !applyUrl) return null;

  return {
    title: String(title).slice(0, 160),
    firm: firm || null,
    location: item.location || item.jobLocation || null,
    job_type: normalizeJobType(item.scheduleType, title),
    apply_url: applyUrl,
    is_government: GOVT_FIRM_PATTERN.test(String(firm || '')),
    salary_text: item.salary || item.salaryText || null,
  };
}

async function fetchFromApify() {
  if (!process.env.APIFY_TOKEN) {
    console.log('[job-scraper] Source 2 (Apify) skipped — APIFY_TOKEN not set.');
    return { listings: [], actorRun: false };
  }
  if (!process.env.APIFY_ACTOR_ID) {
    // Deliberately NOT guessing a default actor here — different actors take
    // different input JSON and return different field shapes; running one
    // blind spends real Apify credits on probably-wrong results. Set
    // APIFY_ACTOR_ID (and optionally APIFY_ACTOR_INPUT as a JSON string) in
    // .env once a specific actor is chosen.
    console.log('[job-scraper] Source 2 (Apify) skipped — APIFY_TOKEN present but APIFY_ACTOR_ID not set. Pick an Apify actor first (see providerApi.service.js header comment).');
    return { listings: [], actorRun: false };
  }

  let input = {};
  if (process.env.APIFY_ACTOR_INPUT) {
    try {
      input = JSON.parse(process.env.APIFY_ACTOR_INPUT);
    } catch (err) {
      console.error('[job-scraper] APIFY_ACTOR_INPUT is not valid JSON — running actor with empty input instead:', err.message);
    }
  }

  try {
    const { data } = await axios.post(
      `https://api.apify.com/v2/acts/${encodeURIComponent(process.env.APIFY_ACTOR_ID)}/run-sync-get-dataset-items`,
      input,
      {
        timeout: 120000, // actor runs can genuinely take a while — this is a real scrape, not a lookup
        params: { token: process.env.APIFY_TOKEN },
      }
    );
    const items = Array.isArray(data) ? data : [];
    const listings = items
      .map((item, i) => mapApifyItem(item, i === 0))
      .filter(Boolean);
    return { listings, actorRun: true };
  } catch (err) {
    console.error('[job-scraper] Apify actor run failed:', err.message);
    return { listings: [], actorRun: true };
  }
}

module.exports = { fetchFromSerpApi, fetchFromJSearch, fetchFromAdzuna, fetchFromApify, SERPAPI_QUERIES };
