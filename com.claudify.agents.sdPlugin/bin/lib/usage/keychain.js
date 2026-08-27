/**
 * Claude Code's credentials on macOS, which do not live in a file.
 *
 * Ported from an unmerged fix on stream-deck-ai-limits: PR #4 by darshjoshi and
 * PR #2 by khunjon, which arrived at the same design independently. Both are
 * contributions to an MIT repository; see THIRD-PARTY-NOTICES.md.
 *
 * On macOS the `claude` login flow stores its OAuth payload as a login-Keychain
 * item rather than writing ~/.claude/.credentials.json, so the file every other
 * platform reads never exists and the key sits on "Login Required" forever. The
 * item holds the *same* JSON, which is why the caller can parse either source
 * with one parser.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The generic-password service name Claude Code files its item under. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * An absolute path, not a bare name: /etc/paths puts /usr/local/bin ahead of
 * /usr/bin, so a PATH-resolved `security` could be shadowed by a planted binary
 * on Macs where that directory is user-writable -- and this call hands back an
 * OAuth token.
 */
const SECURITY_BIN = '/usr/bin/security';

/** Give up rather than stall a refresh if the Keychain prompts or hangs. */
const TIMEOUT_MS = 5000;

/** The blob is a few KB in practice; cap it so a pathological item cannot grow. */
const MAX_BYTES = 1024 * 1024;

/**
 * The credential blob as a raw JSON string, or null when there isn't one.
 *
 * Item missing, Keychain locked, access denied and no `security` binary all
 * mean the same thing here, so they collapse to null. The underlying error is
 * swallowed rather than wrapped on purpose: `security` echoes the item it
 * failed on, and that string ends up in a log.
 */
export async function readKeychainBlob() {
  try {
    const { stdout } = await execFileAsync(
      SECURITY_BIN,
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES },
    );
    const blob = stdout.trim();
    return blob.length > 0 ? blob : null;
  } catch {
    return null;
  }
}
