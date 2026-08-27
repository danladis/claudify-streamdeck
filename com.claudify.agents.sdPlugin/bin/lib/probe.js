import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTransport } from './settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'probe.sh'), 'utf8');

const TIMEOUT_MS = 20_000;
const RUNNING_CHECK_TIMEOUT_MS = 5_000;

/** Single-quote a value for POSIX sh so it can be pasted into the script. */
function shellQuoteBody(value) {
  return String(value ?? '').replace(/'/g, `'\\''`);
}

function buildScript(settings) {
  return SCRIPT.replace('__CLAUDE_BIN__', shellQuoteBody(settings.claudeBin)).replace(
    '__CWD_FILTER__',
    shellQuoteBody(settings.cwdFilter),
  );
}

/**
 * wsl.exe writes its *own* diagnostics (bad distro name, WSL not installed) as
 * UTF-16LE -- on stdout, not stderr -- while the Linux process it hosts writes
 * plain UTF-8. Sniff for the interleaved NUL bytes so those messages stay
 * readable, and so a UTF-16 payload can be recognised as "wsl.exe complained"
 * rather than "the script returned junk".
 */
function decodeOutput(buffer) {
  if (buffer.length >= 4) {
    let nuls = 0;
    const sample = Math.min(buffer.length, 64);
    for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) nuls += 1;
    if (nuls > sample / 4) {
      return { text: buffer.toString('utf16le').replace(/\0/g, '').trim(), fromHost: true };
    }
  }
  return { text: buffer.toString('utf8').trim(), fromHost: false };
}

/**
 * The script answers with CLAUDIFY-<SECTION> markers, each followed by one JSON
 * document, so that a job state file caught mid-write costs only that job's
 * detail instead of the whole reading.
 *
 * @returns the snapshot, or null if this is not our script's output at all.
 */
export function parseSections(text) {
  const parts = text.split(/^CLAUDIFY-([A-Z]+)[ \t]*\r?$/m);
  if (parts.length < 3) return null;

  const snapshot = { ok: true, claude: '', agents: [], jobs: [] };

  for (let i = 1; i < parts.length; i += 2) {
    const section = parts[i];
    const body = (parts[i + 1] ?? '').trim();
    if (section === 'END' || !body) continue;

    let value;
    try {
      value = JSON.parse(body);
    } catch {
      // A malformed section is dropped, unless it is one we cannot do without.
      if (section === 'AGENTS' || section === 'ERROR') {
        return { ok: false, error: 'bad-response', detail: body.slice(0, 200) };
      }
      continue;
    }

    if (section === 'ERROR') return { ok: false, ...value };
    if (section === 'META') snapshot.claude = value.claude ?? '';
    else if (section === 'AGENTS') snapshot.agents = Array.isArray(value) ? value : [];
    else if (section === 'JOB') snapshot.jobs.push(value);
  }

  return snapshot;
}

// %SystemRoot% is passed through to child processes even when a launcher
// trims PATH, which a bare 'tasklist.exe' relies on and Stream Deck's own
// process launch has been seen to strip.
const TASKLIST = `${process.env.SystemRoot || process.env.windir || 'C:\\Windows'}\\System32\\tasklist.exe`;

/**
 * Is the WSL2 utility VM (`vmmem` / `vmmemWSL`) currently down?
 *
 * `wsl.exe` is not safe to use for this check at all: even `wsl --list
 * --verbose` talks to the VM stack and starts it back up if it was stopped --
 * the exact thing this check exists to avoid. `tasklist.exe` is a plain
 * Windows tool that only reads the process table, so it cannot itself wake
 * anything.
 *
 * This only tells us whether *some* WSL distro is running, not the specific
 * one this key watches -- good enough for the case that actually matters
 * (WSL is cold and a 30-second timer would otherwise never let it stay that
 * way). If a distro-less VM check says "running" but the target distro isn't,
 * the real probe below still has to start that one distro, which is a much
 * smaller, VM-already-warm operation than what this check is guarding against.
 *
 * The match has to be exact, not a prefix: Docker Desktop's container
 * isolation runs its own utility VM under a name like `vmmemCmZygote`, which
 * starts with "vmmem" too but has nothing to do with WSL and never stops on
 * its own. A prefix match treats that VM as "the WSL VM", so this check would
 * report "running" forever regardless of the actual WSL distro's state.
 *
 * @param {(msg: string) => void} [log] Told the reason whenever the check
 *   comes back inconclusive, so a check that silently fails open (see below)
 *   is not also silent about *why* -- that failure mode looks identical to
 *   "the feature does nothing" from the outside otherwise.
 * @returns true only when we positively know no WSL VM is up. Any doubt
 *   (parse failure, timeout, tasklist missing) resolves to false so the real
 *   probe still runs -- this check must never be the reason a working setup
 *   stops reporting.
 */
function isWslVmAsleep(log = () => {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(TASKLIST, ['/fo', 'csv', '/nh'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      log(`[wsl-check] could not start ${TASKLIST}: ${err.message}`);
      resolve(false);
      return;
    }

    const out = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      log(`[wsl-check] tasklist did not answer within ${RUNNING_CHECK_TIMEOUT_MS / 1000}s`);
      finish(false);
    }, RUNNING_CHECK_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', (err) => {
      log(`[wsl-check] ${TASKLIST} failed to run: ${err.message}`);
      finish(false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        log(`[wsl-check] tasklist exited ${code}`);
        finish(false);
        return;
      }
      const { text } = decodeOutput(Buffer.concat(out));
      if (!text) {
        log('[wsl-check] tasklist produced no output');
        finish(false);
        return;
      }
      finish(!/^"vmmem(?:WSL)?",/im.test(text));
    });
  });
}

function commandFor(settings) {
  if (resolveTransport(settings) === 'wsl') {
    const args = settings.distro ? ['-d', settings.distro] : [];
    // Feeding the script over stdin means no shell quoting has to survive the
    // Windows -> WSL command line.
    return { file: 'wsl.exe', args: [...args, '--', 'sh', '-s'] };
  }
  return { file: '/bin/sh', args: ['-s'] };
}

/** Run the snapshot script and return its parsed stdout. */
async function runScript(settings, allowWake, log = () => {}) {
  if (!allowWake && resolveTransport(settings) === 'wsl') {
    const asleep = await isWslVmAsleep(log);
    // Logged unconditionally, not just on the skip path, so the log proves
    // this check ran on every passive poll instead of only showing up when
    // it already agrees with what we expect.
    log(
      asleep
        ? '[wsl-check] no WSL VM running -- skipping this poll instead of starting one'
        : '[wsl-check] a WSL VM is running -- proceeding with the real probe',
    );
    if (asleep) return { ok: false, error: 'wsl-asleep', detail: 'no WSL VM is currently running' };
  }

  const { file, args } = commandFor(settings);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: 'spawn-failed', detail: err.message });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout', detail: `no answer within ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      finish({
        ok: false,
        error: missing ? 'host-unreachable' : 'spawn-failed',
        detail: missing ? `${file} not found` : error.message,
      });
    });

    child.on('close', (code) => {
      const stdout = decodeOutput(Buffer.concat(out));
      const stderr = decodeOutput(Buffer.concat(err));

      if (!stdout.text) {
        finish({
          ok: false,
          error: code === 0 ? 'empty-response' : 'host-unreachable',
          detail: stderr.text || `exit code ${code}`,
        });
        return;
      }

      const snapshot = parseSections(stdout.text);
      if (snapshot) {
        finish(snapshot);
        return;
      }

      // No section markers at all means stdout came from the launcher rather
      // than the script -- typically wsl.exe refusing to start the distro.
      finish({
        ok: false,
        error: stdout.fromHost ? 'host-unreachable' : 'bad-response',
        detail: stdout.text.slice(0, 200),
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(buildScript(settings));
  });
}

const inflight = new Map();

/**
 * Run a probe, collapsing concurrent requests that would return the same data.
 * Several keys watching the same host should cost one `claude agents` call.
 *
 * `allowWake: false` (the periodic timer's own polls) will not start a
 * stopped WSL distro just to find out it has nothing to report; an explicit
 * request -- a key press, a Property Inspector refresh -- passes true and
 * always runs the real probe. The two are cached separately so a passive poll
 * can never shadow a request the user is actively waiting on.
 */
export function probe(settings, key, { allowWake = true, log } = {}) {
  const cacheKey = `${key}|${allowWake ? 'wake' : 'nowake'}`;
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const pending = runScript(settings, allowWake, log).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, pending);
  return pending;
}
