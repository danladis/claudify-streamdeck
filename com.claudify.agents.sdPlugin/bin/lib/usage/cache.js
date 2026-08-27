/**
 * One reading, shared by every key that wants it.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * The usage endpoint throttles hard -- roughly five requests per five minutes,
 * then 429 with a long Retry-After -- and a deck can easily have three keys
 * asking the same question. So the network call belongs to the cache, not to
 * the key: keys share a reading, concurrent asks collapse into one request, and
 * a failed refresh re-serves the last good numbers marked stale rather than
 * blanking the face.
 */
import { emptySnapshot } from './snapshot.js';
import { genericError, isUsageError } from './errors.js';

/** How long a reading stays fresh when the caller does not say. */
export const DEFAULT_TTL_MS = 60000;

/** How long to stay off the network after a 429 that named no usable delay. */
export const RATE_LIMIT_BACKOFF_MS = 5 * 60000;

/**
 * The floor on that backoff. This endpoint sometimes answers `Retry-After: 0`
 * while still throttling, so honouring 0 would walk straight into the next 429.
 */
export const MIN_RATE_LIMIT_BACKOFF_MS = 60000;

/**
 * The least time between two *forced* fetches, which is what a key press asks
 * for. Presses inside the window re-serve what is already held, so leaning on
 * the key cannot rate-limit the account.
 */
export const FORCE_MIN_INTERVAL_MS = 10000;

export class UsageCache {
  #ttlMs;
  #backoffMs;
  #forceMinIntervalMs;
  #now;

  #last = null;
  #lastFetchedAt = 0;
  /** The last *attempt*, won or lost -- what the force throttle is measured from. */
  #lastAttemptAt = 0;
  #inFlight = null;
  #rateLimitedUntil = 0;

  constructor({ ttlMs, rateLimitBackoffMs, forceMinIntervalMs, now } = {}) {
    this.#ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.#backoffMs = rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS;
    this.#forceMinIntervalMs = forceMinIntervalMs ?? FORCE_MIN_INTERVAL_MS;
    this.#now = now ?? Date.now;
  }

  /** The last good reading, if there is one, without going anywhere for it. */
  get lastSnapshot() {
    return this.#last;
  }

  async get(fetcher, { force = false } = {}) {
    const now = this.#now();
    const fresh = this.#last !== null && now - this.#lastFetchedAt < this.#ttlMs;

    if (fresh && !force) return this.#last;

    // Forced, but something was tried moments ago: hand back whatever is held,
    // good or stale. Measured from the last attempt rather than the last
    // success, so pressing a key while the endpoint is unhealthy cannot keep
    // hammering it -- which is exactly what would re-trigger the rate limit.
    if (force && now - this.#lastAttemptAt < this.#forceMinIntervalMs) {
      return this.#last ?? this.#staleOr(this.#errorSnapshot(genericError('No data yet.')), 'error');
    }

    // Inside a 429 backoff nothing touches the network, not even a press.
    if (now < this.#rateLimitedUntil) {
      return this.#staleOr(this.#rateLimitedSnapshot(), 'rateLimited');
    }

    // Someone else already started this fetch; wait on theirs.
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#runFetch(fetcher);
    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
  }

  async #runFetch(fetcher) {
    this.#lastAttemptAt = this.#now();
    try {
      const snapshot = await fetcher();
      this.#last = snapshot;
      this.#lastFetchedAt = this.#now();
      this.#rateLimitedUntil = 0;
      return snapshot;
    } catch (err) {
      if (isUsageError(err) && err.status === 'rateLimited') {
        // Honour a long Retry-After, never a short one (see MIN_ above), and
        // cap it so a wild value cannot freeze the key for hours.
        const requested = err.retryAfterMs;
        const backoff =
          typeof requested === 'number'
            ? Math.min(Math.max(requested, MIN_RATE_LIMIT_BACKOFF_MS), this.#backoffMs)
            : this.#backoffMs;
        this.#rateLimitedUntil = this.#now() + backoff;
        return this.#staleOr(this.#rateLimitedSnapshot(err.message), 'rateLimited');
      }
      return this.#staleOr(this.#errorSnapshot(err), 'error');
    }
  }

  /**
   * The last good reading, marked stale and carrying why -- or, when nothing
   * good was ever held, the failure itself. Real numbers an hour old beat an
   * error face: the limits move slowly, and the face says it is stale.
   */
  #staleOr(fallback, reason) {
    if (this.#last === null) return fallback;
    return {
      ...this.#last,
      status: 'stale',
      stale: true,
      staleReason: reason,
      updatedAt: new Date(this.#now()).toISOString(),
    };
  }

  #rateLimitedSnapshot(message) {
    return emptySnapshot('rateLimited', { message, now: new Date(this.#now()) });
  }

  #errorSnapshot(err) {
    const status = isUsageError(err) ? err.status : 'error';
    const message = isUsageError(err) ? err.message : 'Unexpected error.';
    return emptySnapshot(status, { message, now: new Date(this.#now()) });
  }
}

/**
 * Caches live for the process, keyed by whose credentials and how fresh.
 *
 * Sharing them across keys is the point: the last good reading and the 429
 * backoff then survive a page switch, a key being dragged about, or the
 * Property Inspector opening -- none of which should cost a request.
 */
const shared = new Map();

export function sharedCache(credentialsPath, ttlMs) {
  const id = `${credentialsPath ?? ''}|${ttlMs}`;
  let cache = shared.get(id);
  if (!cache) {
    cache = new UsageCache({ ttlMs });
    shared.set(id, cache);
  }
  return cache;
}
