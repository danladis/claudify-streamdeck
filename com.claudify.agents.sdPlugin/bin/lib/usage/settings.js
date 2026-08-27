/**
 * Defaults and validation for the two usage keys.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * Separate from lib/settings.js because the agent keys and the usage keys share
 * no settings at all, and because the refresh floor here is a rate limit rather
 * than a matter of taste.
 */

/** Defaults for a freshly-dropped usage key. */
export const DEFAULTS = {
  /**
   * Seconds between refreshes. 120 keeps a steady state well clear of the
   * endpoint's limit; see MIN_INTERVAL.
   */
  interval: 120,
  /** Percentages at which a bar turns yellow, then orange. */
  warning: 70,
  critical: 90,
  /** Override for a credentials file in a non-standard place; blank means the usual one. */
  credentialsPath: '',
  /** Which window the single-window key shows: 'session' (5h) or 'weekly' (7d). */
  window: 'session',
  /** What sits under the percentage: 'dateTime' | 'countdown' | 'both' | 'none'. */
  resetInfo: 'dateTime',
  /** How that date reads: see formatResetTime. */
  dateFormat: 'dayMonth',
  /** Key background, shared with the agent keys: see BACKGROUNDS in canvas.js. */
  background: 'transparent',
};

/**
 * The floor on the refresh interval, and it is not arbitrary: the usage
 * endpoint starts answering 429 (Retry-After: 300) after about five requests in
 * five minutes. Polling faster than this reliably trips that and pins the key
 * on its last stale reading, which looks broken while being entirely our fault.
 */
export const MIN_INTERVAL = 60;

/** Generous ceiling, so a typo cannot switch a key off for a day. */
export const MAX_INTERVAL = 3600;

const WINDOWS = new Set(['session', 'weekly']);
const RESET_INFOS = new Set(['dateTime', 'countdown', 'both', 'none']);
const DATE_FORMATS = new Set(['dayMonth', 'isoShort', 'weekday']);
const BACKGROUNDS = new Set(['blue', 'gray', 'transparent']);

const str = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback);
const oneOf = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

const percent = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback;
};

/** Coerce whatever the Property Inspector saved into a complete, valid config. */
export function normalize(raw) {
  const settings = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const interval = Number(settings.interval);
  const warning = percent(settings.warning, DEFAULTS.warning);

  return {
    interval: Number.isFinite(interval)
      ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(interval)))
      : DEFAULTS.interval,
    warning,
    // A critical band below the warning band would colour bars in the wrong
    // order, so the two are kept in step rather than rejected.
    critical: Math.max(warning, percent(settings.critical, DEFAULTS.critical)),
    credentialsPath: str(settings.credentialsPath, DEFAULTS.credentialsPath),
    window: oneOf(settings.window, WINDOWS, DEFAULTS.window),
    resetInfo: oneOf(settings.resetInfo, RESET_INFOS, DEFAULTS.resetInfo),
    dateFormat: oneOf(settings.dateFormat, DATE_FORMATS, DEFAULTS.dateFormat),
    background: oneOf(settings.background, BACKGROUNDS, DEFAULTS.background),
  };
}

/** The thresholds in the shape snapshot.js wants. */
export const thresholdsFor = (settings) => ({
  warning: settings.warning,
  critical: settings.critical,
});
