/**
 * voices.js — the single source of truth for which browser TTS voices this
 * product is allowed to use, and what we call them in the UI.
 *
 * Founder decision (2026-07-29): stop auto-ranking whatever the device
 * happens to have installed. The old heuristic (rankEnglishVoices) scored
 * every en-* voice and picked a "best" one, which meant a student on a
 * Windows box with only 2010-era SAPI voices got something that sounded
 * ill, and no two devices sounded alike. Instead we now allow exactly TWO
 * named voices per platform — the ones we have actually listened to and
 * approved — and hide everything else from the picker.
 *
 *   Apple (iOS / iPadOS / macOS, all WebKit):
 *     "Rishi"    (en-IN)  → shown as "Rishi"
 *     "Samantha" (en-US)  → shown as "Samantha"
 *
 *   Android / Windows (Chrome's Google speech engine):
 *     "Google हिन्दी"      (hi-IN) → shown as "Ria"
 *     "Google US English" (en-US) → shown as "Rachel"
 *
 * We rename them because the raw OS names are meaningless to a law student
 * ("Google US English" is not a person) and because the Hindi voice's real
 * name is in Devanagari, which renders inconsistently in a <select>.
 *
 * Matching is done on the voice NAME, not the lang tag, because the same
 * lang tag is shared by many voices. Names are stable across OS versions;
 * these four have been checked on iOS 17+, macOS, Android 13+ and Windows
 * 10/11 Chrome.
 *
 * FALLBACK — deliberate and important. If a device has none of its own
 * platform's pair (Linux, Firefox with no speech-dispatcher voices, a
 * locked-down lab machine), we do NOT return an empty list and leave the
 * feature mute. We try the other platform's pair, and if that is also
 * absent we return an empty roster; callers must then speak with no
 * explicit `voice` set, which makes the browser use its own default. A
 * student always hears something.
 */

/**
 * Android needs different handling in two unrelated places (speech RATE below,
 * and microphone ownership in the two voice pages), so the check lives here
 * once rather than being re-derived in each page.
 *
 * "Android" in the UA string is present on Android Chrome, Samsung Internet,
 * Firefox for Android and every Chromium-based Android browser. We are not
 * feature-detecting because there is no feature to detect — the differences
 * are engine behaviour, not API presence.
 */
export const IS_ANDROID =
  typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');

const APPLE_IDS = ['rishi', 'samantha'];
const GOOGLE_IDS = ['ria', 'rachel'];

// The approved roster. `match` runs against a SpeechSynthesisVoice.
const ROSTER = [
  {
    id: 'rishi',
    display: 'Rishi',
    match: (v) => /\brishi\b/i.test(v.name),
  },
  {
    id: 'samantha',
    display: 'Samantha',
    match: (v) => /\bsamantha\b/i.test(v.name),
  },
  {
    // Chrome names this voice in Devanagari ("Google हिन्दी") on most builds
    // and "Google Hindi" on a few older ones, so match either spelling, and
    // require the hi-IN lang tag so we never catch a different Google voice.
    id: 'ria',
    display: 'Ria',
    match: (v) => /google/i.test(v.name) && (v.lang === 'hi-IN' || /हिन्दी|hindi/i.test(v.name)),
  },
  {
    id: 'rachel',
    display: 'Rachel',
    match: (v) => /google\s*us\s*english/i.test(v.name),
  },
];

// iPadOS 13+ reports itself as a Mac, which is fine here because Macs and
// iPads share the same approved pair. The Android check comes first because
// some Android WebViews put "Mac OS X" in their UA string.
function isApplePlatform() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return false;
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  if (/Macintosh|Mac OS X/i.test(ua)) return true;
  return false;
}

function findByIds(allVoices, ids) {
  return ids
    .map((id) => {
      const entry = ROSTER.find((r) => r.id === id);
      const voice = (allVoices || []).find((v) => entry.match(v));
      return voice ? { id: entry.id, display: entry.display, lang: voice.lang, voice } : null;
    })
    .filter(Boolean);
}

/**
 * Given the raw speechSynthesis.getVoices() list, return the approved
 * roster for THIS device — normally exactly two entries, in a stable order
 * (the first is the "primary" voice, e.g. the judge / the interviewer).
 *
 * Returns: [{ id, display, lang, voice }] — possibly empty, see FALLBACK.
 */
export function resolveApprovedVoices(allVoices) {
  if (!allVoices || !allVoices.length) return [];
  const own = isApplePlatform() ? APPLE_IDS : GOOGLE_IDS;
  const other = isApplePlatform() ? GOOGLE_IDS : APPLE_IDS;
  const mine = findByIds(allVoices, own);
  if (mine.length) return mine;
  // This device has none of its platform's approved voices — try the other
  // platform's pair before giving up (a Mac running Chrome, for instance,
  // exposes the Google voices too).
  return findByIds(allVoices, other);
}

/** Look up one approved entry by its stable id (used to restore a saved choice). */
export function findApprovedById(approved, id) {
  return (approved || []).find((a) => a.id === id) || null;
}

/**
 * Playback speed, YouTube-style (founder ask, 2026-07-29). Shared by AI
 * Interviewer and Court Simulation so a student learns one control, not two.
 *
 * 1x is the normal delivery speed, NOT the browser's raw default — see
 * `speechRate()` below.
 */
export const SPEECH_SPEEDS = [0.5, 1, 1.5, 2];
export const DEFAULT_SPEECH_SPEED = 1;

/**
 * Turn a chosen speed into a SpeechSynthesisUtterance.rate.
 *
 * `base` lets a caller keep two characters distinguishable (Court Simulation
 * runs the judge slightly quicker than opposing counsel) while both still
 * respond to the same student-facing speed control.
 *
 * The clamp matters: the Web Speech spec allows rate up to 10, but real
 * engines do not. Safari/iOS in particular refuses to go past roughly 2 and
 * some Android builds simply stop speaking above it, so we cap at 2 rather
 * than hand the engine a number that makes it go silent. Consequence to be
 * aware of, not a bug: on a voice with base > 1, the 1.5x and 2x settings can
 * sound very close, because both land on the ceiling.
 *
 * ANDROID (founder report, 2026-07-29: "whenever I said 2x, it's moving
 * faster, it's not normal"). Android's TTS engine applies `rate` far more
 * aggressively than desktop Chrome or iOS WebKit — the same numeric rate is
 * audibly much faster there, and at 2 combined with a base of 1.3 it is not
 * followable speech. So on Android we compress the whole curve and damp the
 * per-character base boost, giving a real but intelligible "fast" setting.
 */
export function speechRate(speed, base = 1) {
  const s = Number(speed) || DEFAULT_SPEECH_SPEED;
  if (IS_ANDROID) {
    const compressed = 1 + (s - 1) * 0.45;    // 0.5→0.78, 1→1, 1.5→1.23, 2→1.45
    const dampedBase = 1 + (base - 1) * 0.4;  // 1.3 → 1.12
    return Math.min(1.6, Math.max(0.6, compressed * dampedBase));
  }
  return Math.min(2, Math.max(0.5, s * base));
}
