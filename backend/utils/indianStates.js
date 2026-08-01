/**
 * indianStates.js — state list + the cities that belong to each state.
 *
 * WHY THIS EXISTS
 * ---------------
 * Founder decision (2026-07-30): the Job Board's Location filter is a state
 * dropdown, not a free-text city box. But job_cache.location is whatever the
 * source site wrote — almost always a CITY ("Mumbai", "New Delhi", "Bengaluru,
 * Karnataka"), only sometimes a state. There is no `state` column on
 * job_cache and adding one would mean a migration plus a backfill pass over
 * the scraper, which is not worth it for a filter.
 *
 * So we translate in the other direction: the student picks "Maharashtra", and
 * we match any listing whose location text mentions Maharashtra OR any of its
 * major cities. One regex, one indexless scan of a table that holds at most a
 * few thousand live rows — cheap, and no schema change.
 *
 * The city lists are deliberately NOT exhaustive. They cover the places that
 * actually appear in legal-sector listings (High Court seats, NLU towns, tier-1
 * and tier-2 commercial centres). A city we have missed simply means that one
 * listing does not surface under its state — never a wrong result. Add cities
 * here as they show up in the data; no migration needed.
 *
 * Alternate spellings matter and are listed as separate entries (Bengaluru /
 * Bangalore, Gurugram / Gurgaon, Mumbai / Bombay) because sources are
 * inconsistent and we match on the raw text.
 */

// Ordered alphabetically — this is the order the dropdown shows.
const STATES = {
  'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Amaravati', 'Tirupati', 'Nellore'],
  'Arunachal Pradesh': ['Itanagar'],
  Assam: ['Guwahati', 'Dispur', 'Silchar', 'Dibrugarh', 'Jorhat'],
  Bihar: ['Patna', 'Gaya', 'Muzaffarpur', 'Bhagalpur', 'Darbhanga'],
  Chhattisgarh: ['Raipur', 'Bilaspur', 'Bhilai', 'Durg'],
  Goa: ['Panaji', 'Panjim', 'Margao', 'Vasco'],
  Gujarat: ['Ahmedabad', 'Amdavad', 'Surat', 'Vadodara', 'Baroda', 'Rajkot', 'Gandhinagar', 'Bhavnagar'],
  Haryana: ['Gurugram', 'Gurgaon', 'Faridabad', 'Panchkula', 'Sonipat', 'Karnal', 'Hisar', 'Ambala'],
  'Himachal Pradesh': ['Shimla', 'Dharamshala', 'Solan', 'Mandi'],
  Jharkhand: ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro'],
  Karnataka: ['Bengaluru', 'Bangalore', 'Mysuru', 'Mysore', 'Mangaluru', 'Mangalore', 'Hubli', 'Dharwad', 'Belgaum'],
  Kerala: ['Kochi', 'Cochin', 'Ernakulam', 'Thiruvananthapuram', 'Trivandrum', 'Kozhikode', 'Calicut', 'Thrissur'],
  'Madhya Pradesh': ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Ujjain'],
  Maharashtra: ['Mumbai', 'Bombay', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad', 'Thane', 'Navi Mumbai', 'Kolhapur', 'Solapur'],
  Manipur: ['Imphal'],
  Meghalaya: ['Shillong'],
  Mizoram: ['Aizawl'],
  Nagaland: ['Kohima', 'Dimapur'],
  Odisha: ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Puri', 'Sambalpur'],
  Punjab: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Mohali', 'Bathinda'],
  Rajasthan: ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Ajmer', 'Bikaner'],
  Sikkim: ['Gangtok'],
  'Tamil Nadu': ['Chennai', 'Madras', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Trichy', 'Salem'],
  Telangana: ['Hyderabad', 'Secunderabad', 'Warangal', 'Nizamabad'],
  Tripura: ['Agartala'],
  'Uttar Pradesh': ['Lucknow', 'Noida', 'Greater Noida', 'Ghaziabad', 'Kanpur', 'Allahabad', 'Prayagraj', 'Varanasi', 'Agra', 'Meerut'],
  Uttarakhand: ['Dehradun', 'Haridwar', 'Nainital', 'Roorkee'],
  'West Bengal': ['Kolkata', 'Calcutta', 'Howrah', 'Siliguri', 'Durgapur', 'Asansol'],

  // Union territories — students apply to these as freely as to states, so
  // they sit in the same list rather than a separate group.
  'Andaman & Nicobar Islands': ['Port Blair'],
  Chandigarh: ['Chandigarh'],
  'Dadra & Nagar Haveli and Daman & Diu': ['Silvassa', 'Daman', 'Diu'],
  Delhi: ['Delhi', 'New Delhi', 'Dwarka', 'Saket', 'Rohini'],
  'Jammu & Kashmir': ['Srinagar', 'Jammu'],
  Ladakh: ['Leh', 'Kargil'],
  Lakshadweep: ['Kavaratti'],
  Puducherry: ['Puducherry', 'Pondicherry'],
};

const STATE_NAMES = Object.keys(STATES);

/** Escape anything the caller sends before it becomes part of a POSIX regex. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Turn a state name into a POSIX regex that matches a listing's location text.
 *
 * Returns null for an unknown/blank state, which every caller treats as "no
 * location filter" — an unrecognised value must never silently return zero
 * jobs, and must never be interpolated into SQL.
 *
 * Word boundaries (\m ... \M in Postgres ARE) stop "Goa" matching "Goalpara"
 * and "Diu" matching "Dindigul".
 */
function locationRegexForState(state) {
  if (!state || !Object.prototype.hasOwnProperty.call(STATES, state)) return null;
  const terms = [state, ...STATES[state]].map(escapeRegex);
  return `\\m(${terms.join('|')})\\M`;
}

module.exports = { STATES, STATE_NAMES, locationRegexForState };
