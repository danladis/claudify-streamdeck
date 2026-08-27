/**
 * The two endpoints this plugin talks to, and nothing else.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov).
 * See THIRD-PARTY-NOTICES.md.
 *
 * Both are the ones the Claude Code CLI itself uses, and both are unofficial:
 * they are not documented, not versioned for third parties, and may change or
 * vanish without notice. Every failure here is turned into a UsageError with a
 * message safe to log -- never a response body, never a header.
 */
import { authRequired, genericError, parseRetryAfterMs, rateLimited, UnauthorizedError } from './errors.js';

/** Unofficial. The same request Claude Code makes to draw its own /usage. */
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** Unofficial. Where the CLI exchanges a refresh token. */
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

/**
 * The public client id baked into the distributed `claude` binary. Not a
 * secret: it identifies the CLI as a public OAuth client, not the user.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Run a fetch under a timeout, mapping the two ways it can fail to network
 * language. The signal is built here so the timer is always cleared.
 */
async function fetchWithTimeout(url, init, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw genericError(aborted ? `${what} timed out.` : `${what} network error.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the raw usage response for a token the caller believes is good.
 *
 * @throws {UnauthorizedError} on 401, so the provider can refresh and retry once.
 * @throws {UsageError} 'rateLimited' on 429, 'auth' on 403, 'error' otherwise.
 */
export async function fetchUsage(accessToken) {
  const response = await fetchWithTimeout(
    USAGE_ENDPOINT,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    },
    'Usage request',
  );

  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 403) {
    throw authRequired('Claude refused the usage request. Log in with Claude Code again.');
  }
  if (response.status === 429) {
    throw rateLimited(
      'Claude usage rate limit reached.',
      parseRetryAfterMs(response.headers.get('retry-after')),
    );
  }
  if (!response.ok) throw genericError(`Usage request failed (HTTP ${response.status}).`);

  try {
    return await response.json();
  } catch {
    throw genericError('Usage response was not valid JSON.');
  }
}

/**
 * Trade a refresh token for a fresh access token. The result is held in memory
 * only -- the user's credentials file is never rewritten, so the CLI stays the
 * single writer of its own store.
 *
 * @throws {UsageError} 'auth' when the refresh token is missing or rejected
 *   (only a re-login fixes that), 'error' on anything transient.
 */
export async function refreshToken(refreshTokenValue) {
  if (!refreshTokenValue) {
    throw authRequired('No refresh token available. Log in with Claude Code again.');
  }

  const response = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: CLIENT_ID,
      }),
    },
    'Token refresh',
  );

  // 400/401/403 all mean the same thing for a refresh: this token is done.
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw authRequired('Claude session expired. Log in with Claude Code again.');
  }
  if (!response.ok) throw genericError(`Token refresh failed (HTTP ${response.status}).`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw genericError('Token refresh returned an unexpected response.');
  }

  const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
  if (!accessToken) throw genericError('Token refresh response had no access token.');

  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: expiresIn !== null ? Date.now() + expiresIn * 1000 : null,
  };
}
