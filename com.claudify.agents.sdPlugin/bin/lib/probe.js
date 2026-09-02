import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeNative } from './probe-native.js';
import { resolveTransport } from './settings.js';
import { decodeOutput, isWslVmAsleep } from './wsl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, 'probe.sh'), 'utf8');

const TIMEOUT_MS = 20_000;

/** Single-quote a value for POSIX sh so it can be pasted into the script. */
function shellQuoteBody(value) {
  return String(value ?? '').replace(/'/g, `'\\''`);
}

function buildScript(settings) {
  // The replacements go in through functions on purpose. A string replacement
  // gives `$&`, `$'` and friends their special meaning *in the replacement*,
  // and both of these are free text from a key's settings -- which a shared
  // Stream Deck profile carries with it. A `$'` splices the rest of the script
  // back in, reopening the quoting shellQuoteBody had just closed and leaving
  // the tail of the value running as commands inside WSL. Quoting the value
  // correctly cannot help; it is String.replace undoing the quoting after the
  // fact. A function replacement is taken literally.
  return SCRIPT.replace('__CLAUDE_BIN__', () => shellQuoteBody(settings.claudeBin)).replace(
    '__CWD_FILTER__',
    () => shellQuoteBody(settings.cwdFilter),
  );
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

  const snapshot = { ok: true, claude: '', agents: [], jobs: [], vscodePids: [], titles: {} };

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
    else if (section === 'CLIENTS') {
      snapshot.vscodePids = (Array.isArray(value?.vscodePids) ? value.vscodePids : []).filter(
        (pid) => Number.isInteger(pid),
      );
    } else if (section === 'TITLES') {
      // A title is only ever used to find a window or a tab, so anything that
      // is not a non-empty string is worth nothing and is dropped here rather
      // than checked again at every use.
      for (const [sessionId, title] of Object.entries(value?.titles ?? {})) {
        if (typeof title === 'string' && title) snapshot.titles[sessionId] = title;
      }
    }
  }

  return snapshot;
}

/**
 * The script only crosses into WSL. Every other host is this machine, where the
 * plugin can take the snapshot itself -- see probe-native.js.
 */
function commandFor(settings) {
  const args = settings.distro ? ['-d', settings.distro] : [];
  // Feeding the script over stdin means no shell quoting has to survive the
  // Windows -> WSL command line.
  return { file: 'wsl.exe', args: [...args, '--', 'sh', '-s'] };
}

/** Take the snapshot, however this host has to be reached. */
async function runScript(settings, allowWake, log = () => {}) {
  if (resolveTransport(settings) !== 'wsl') return probeNative(settings, log);

  if (!allowWake) {
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
