/**
 * Failures the usage pipeline can hand to a key face.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * Invariant: a message here is shown in the Property Inspector and written to
 * Stream Deck's log, so it must never carry a token, an Authorization header or
 * the contents of the credentials file. Build them from fixed strings only.
 */

/** 'auth' | 'rateLimited' | 'error' -- the three failures a face can draw. */
export class UsageError extends Error {
  constructor(status, message, retryAfterMs) {
    super(message);
    this.name = 'UsageError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const authRequired = (message) => new UsageError('auth', message);
export const rateLimited = (message, retryAfterMs) =>
  new UsageError('rateLimited', message, retryAfterMs);
export const genericError = (message) => new UsageError('error', message);

export const isUsageError = (value) => value instanceof UsageError;

/**
 * A 401 from the usage endpoint. Distinct from UsageError because it is not a
 * verdict: the provider answers it with one token refresh and one retry, and
 * only a second 401 becomes 'auth'.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Usage request was unauthorized.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Parse a Retry-After header, in seconds, into milliseconds. Anything the
 * header cannot be read as a non-negative number is undefined -- the caller
 * falls back to its own backoff.
 */
export function parseRetryAfterMs(headerValue) {
  if (!headerValue) return undefined;
  const seconds = Number(String(headerValue).trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
