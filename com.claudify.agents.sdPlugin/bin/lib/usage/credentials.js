/**
 * The OAuth credentials Claude Code already wrote when you logged in.
 *
 * Ported from stream-deck-ai-limits (MIT, (c) 2026 David Utyuganov), with the
 * macOS Keychain fallback from its unmerged PRs #4 (darshjoshi) and #2
 * (khunjon). See THIRD-PARTY-NOTICES.md.
 *
 * Nothing here is written back: the plugin reads the tokens, holds them in
 * memory for the length of a request, and never rewrites the user's file. A
 * refreshed token lives only until the process ends.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { authRequired } from './errors.js';
import { readKeychainBlob } from './keychain.js';

/** Where the official login flow puts the file, on the platforms that have one. */
export const defaultCredentialsPath = (home = homedir()) =>
  join(home, '.claude', '.credentials.json');

/**
 * Windows' "Copy as path" wraps the path in double quotes, and people paste it
 * that way; a shell habit does the same with single quotes. Take one matching
 * pair off -- a lone or mismatched quote is left alone to fail loudly.
 */
function unquote(value) {
  const quoted =
    value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]);
  return quoted ? value.slice(1, -1).trim() : value;
}

/**
 * Expand a user-supplied path, including a leading ~; blank means "the default".
 * `home` is a parameter rather than a call so a test can point it at a temp
 * directory and never read the developer's own account.
 */
export function resolveCredentialsPath(customPath, home = homedir()) {
  const trimmed = unquote(typeof customPath === 'string' ? customPath.trim() : '');
  if (!trimmed) return defaultCredentialsPath(home);
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(home, trimmed.slice(1));
  }
  return resolve(trimmed);
}

/**
 * Read and parse the credentials.
 *
 * Normally that is ~/.claude/.credentials.json. On macOS the file does not
 * exist -- Claude Code keeps the identical JSON in the login Keychain -- so a
 * missing *default* path there falls through to the Keychain before giving up.
 *
 * An explicit path from the Property Inspector is taken at face value: if the
 * user named a file, a missing file is an error, not an invitation to go
 * looking somewhere else. Otherwise a typo would silently read the real account
 * and look like it worked.
 *
 * The `deps` seam keeps the platform, the home directory and the Keychain
 * reader injectable, so the fallback is testable on a machine that has neither
 * -- and so a test can never touch the real account.
 *
 * @throws {UsageError} status 'auth' when the credentials are missing,
 *   unreadable, malformed, or carry no access token. Messages never include
 *   token material.
 */
export async function readCredentials(customPath, deps = {}) {
  const { platform = process.platform, readBlob = readKeychainBlob, home = homedir() } = deps;
  const filePath = resolveCredentialsPath(customPath, home);
  const usingDefault =
    !(typeof customPath === 'string' && unquote(customPath.trim()));

  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw authRequired('Could not read the Claude credentials file.');

    const blob = usingDefault && platform === 'darwin' ? await readBlob() : null;
    if (blob === null) {
      throw authRequired('Claude credentials not found. Log in with Claude Code first.');
    }
    contents = blob;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw authRequired('Claude credentials are not valid JSON.');
  }

  const oauth = parsed?.claudeAiOauth;
  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
  if (!accessToken) throw authRequired('Claude credentials have no access token.');

  return {
    accessToken,
    refreshToken: typeof oauth?.refreshToken === 'string' ? oauth.refreshToken : null,
    expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
  };
}

/** Treat a token expiring within the next minute as already expired. */
export const EXPIRY_SKEW_MS = 60000;

/**
 * Whether the access token needs refreshing before it is used. An absent expiry
 * is not expired: let the endpoint decide, and let its 401 drive the refresh.
 */
export function isExpired(expiresAt, skewMs = EXPIRY_SKEW_MS, now = Date.now()) {
  if (expiresAt === null || expiresAt === undefined) return false;
  return expiresAt - skewMs <= now;
}
