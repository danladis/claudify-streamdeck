/**
 * Credentials to a snapshot, in one call that never throws.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * A key always has a face to draw, so every failure along the way comes back as
 * a snapshot with a status instead of an exception. The cache in front of this
 * decides whether the pipeline runs at all.
 */
import { fetchUsage, refreshToken } from './api.js';
import { sharedCache } from './cache.js';
import { isExpired, readCredentials } from './credentials.js';
import { UnauthorizedError, authRequired } from './errors.js';
import { DEFAULT_THRESHOLDS, normalizeUsage } from './snapshot.js';

/** Real implementations, swapped out wholesale by the tests. */
const DEFAULT_DEPS = {
  readCredentials,
  refreshToken,
  fetchUsage,
  now: Date.now,
};

/**
 * One pass: read the credentials, refresh the token if it is spent, ask for the
 * numbers, normalize them. May throw a UsageError -- the cache turns that into
 * a face.
 */
async function runPipeline({ credentialsPath, thresholds, deps, log }) {
  const credentials = await deps.readCredentials(credentialsPath);

  let accessToken = credentials.accessToken;
  if (isExpired(credentials.expiresAt, undefined, deps.now())) {
    log('[claude-usage] token expired; refreshing');
    accessToken = (await deps.refreshToken(credentials.refreshToken)).accessToken;
  }

  let raw;
  try {
    raw = await deps.fetchUsage(accessToken);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;

    // The token can go stale between the expiry check and the request, so a
    // 401 buys exactly one refresh and one retry. A second 401 is a real
    // answer: this login is finished.
    log('[claude-usage] 401; refreshing and retrying once');
    const refreshed = await deps.refreshToken(credentials.refreshToken);
    try {
      raw = await deps.fetchUsage(refreshed.accessToken);
    } catch (retryErr) {
      if (retryErr instanceof UnauthorizedError) {
        throw authRequired('Claude session expired. Log in with Claude Code again.');
      }
      throw retryErr;
    }
  }

  return normalizeUsage(raw, thresholds, new Date(deps.now()));
}

/**
 * The current usage, from the cache when it is fresh enough.
 *
 * @param {object} options
 * @param {string} [options.credentialsPath] Override for a non-standard location.
 * @param {{warning: number, critical: number}} [options.thresholds]
 * @param {number} [options.ttlMs] How long a reading stays fresh.
 * @param {boolean} [options.force] A key press: skip the TTL, within reason.
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.deps] Test seam.
 * @returns {Promise<object>} Always a snapshot, never a rejection.
 */
export async function getUsage({
  credentialsPath,
  thresholds = DEFAULT_THRESHOLDS,
  ttlMs,
  force = false,
  log = () => {},
  cache = sharedCache(credentialsPath, ttlMs),
  deps: overrides,
} = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const snapshot = await cache.get(
    () => runPipeline({ credentialsPath, thresholds, deps, log }),
    { force },
  );
  // Thresholds are the key's, not the cache's: two keys can share a reading
  // while colouring it differently, so they are stamped on the way out.
  return { ...snapshot, thresholds };
}
