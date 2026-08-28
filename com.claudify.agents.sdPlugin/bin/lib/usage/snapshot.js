/**
 * The shape every usage face draws from, and the bands that colour it.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * A snapshot is:
 *   { session: {usedPercent, resetAt}, weekly: {...}, status, updatedAt,
 *     stale, staleReason?, errorMessage?, thresholds }
 *
 * `usedPercent` is 0..100 or null when the endpoint did not say, and `resetAt`
 * is an ISO string or null. Both faces must survive either being null: this is
 * an unofficial endpoint and its fields come and go.
 */

export const DEFAULT_THRESHOLDS = { warning: 70, critical: 90 };

/** An unknown window, used for the error snapshots that have no numbers. */
const EMPTY_WINDOW = { usedPercent: null, resetAt: null };

/**
 * Which band one percentage falls in.
 *
 *   0..warning-1        ok
 *   warning..critical-1 warning
 *   critical..99        critical
 *   100                 limited
 */
export function statusForPercent(percent, thresholds = DEFAULT_THRESHOLDS) {
  if (percent >= 100) return 'limited';
  if (percent >= thresholds.critical) return 'critical';
  if (percent >= thresholds.warning) return 'warning';
  return 'ok';
}

const SEVERITY = {
  ok: 0,
  warning: 1,
  critical: 2,
  limited: 3,
  // The failure statuses are decided before this map is consulted; ranking them
  // above the bands means that if one ever does flow through, it still wins.
  stale: 4,
  wslAsleep: 4,
  auth: 5,
  rateLimited: 5,
  error: 5,
};

/**
 * The overall status of a key showing both windows: the worse of the two.
 * A window with no number is ignored; with neither, there is nothing to be
 * alarmed about and the caller decides whether an error applies instead.
 */
export function worstStatus(session, weekly, thresholds = DEFAULT_THRESHOLDS) {
  const statuses = [session, weekly]
    .filter((window) => window.usedPercent !== null)
    .map((window) => statusForPercent(window.usedPercent, thresholds));
  if (statuses.length === 0) return 'ok';
  return statuses.reduce((worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst));
}

/**
 * One window of the raw response. `utilization` is a percentage (86 means 86%),
 * not a fraction -- clamped and rounded here so no face has to think about it.
 */
function normalizeWindow(window) {
  const used = window?.utilization;
  return {
    usedPercent:
      typeof used === 'number' && Number.isFinite(used)
        ? Math.max(0, Math.min(100, Math.round(used)))
        : null,
    resetAt: typeof window?.resets_at === 'string' ? window.resets_at : null,
  };
}

/**
 * Raw `/api/oauth/usage` response to a snapshot. The endpoint returns many
 * sibling windows (seven_day_opus, seven_day_sonnet, ...) that are usually
 * null; only the two that are always populated are read.
 */
export function normalizeUsage(raw, thresholds = DEFAULT_THRESHOLDS, now = new Date()) {
  const session = normalizeWindow(raw?.five_hour);
  const weekly = normalizeWindow(raw?.seven_day);

  return {
    session,
    weekly,
    status: worstStatus(session, weekly, thresholds),
    updatedAt: now.toISOString(),
    stale: false,
    thresholds,
  };
}

/** A snapshot with no numbers, for the failures that happen before any arrive. */
export function emptySnapshot(status, { message, now = new Date(), thresholds } = {}) {
  return {
    session: { ...EMPTY_WINDOW },
    weekly: { ...EMPTY_WINDOW },
    status,
    updatedAt: now.toISOString(),
    stale: false,
    ...(message ? { errorMessage: message } : {}),
    ...(thresholds ? { thresholds } : {}),
  };
}
