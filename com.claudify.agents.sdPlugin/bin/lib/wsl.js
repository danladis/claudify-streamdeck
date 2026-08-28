/**
 * Everything that has to know whether WSL is awake -- and how to ask without
 * waking it.
 *
 * Both the agent keys (which run their probe through `wsl.exe`) and the usage
 * keys (which may read a credentials file living inside a distro) poll on a
 * timer. A poll must never be the reason a stopped distro starts back up, so
 * they share one check and one decoder.
 */
import { spawn } from 'node:child_process';

const RUNNING_CHECK_TIMEOUT_MS = 5_000;

/**
 * wsl.exe writes its *own* diagnostics (bad distro name, WSL not installed) as
 * UTF-16LE -- on stdout, not stderr -- while the Linux process it hosts writes
 * plain UTF-8. Sniff for the interleaved NUL bytes so those messages stay
 * readable, and so a UTF-16 payload can be recognised as "wsl.exe complained"
 * rather than "the script returned junk".
 */
export function decodeOutput(buffer) {
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
 * Does this path live inside a WSL distro rather than on Windows itself?
 *
 * Windows reaches a distro's filesystem over UNC: `\\wsl.localhost\Ubuntu\...`
 * on current builds, `\\wsl$\Ubuntu\...` on older ones. Either way, opening
 * such a path goes through the 9P server *inside* the distro, which means the
 * plain `readFile` behind it starts WSL if it is stopped -- the same accident
 * the agent keys already guard against.
 *
 * Forward slashes are accepted too: Windows takes `//wsl.localhost/...` just
 * as happily, and someone typing a path into the Property Inspector may well
 * write it that way.
 */
export function isWslPath(value) {
  return /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]/i.test(String(value ?? '').trim());
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
 * one a key cares about -- good enough for the case that actually matters
 * (WSL is cold and a 30-second timer would otherwise never let it stay that
 * way). If a distro-less VM check says "running" but the target distro isn't,
 * the real work still has to start that one distro, which is a much smaller,
 * VM-already-warm operation than what this check is guarding against.
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
 *   work still runs -- this check must never be the reason a working setup
 *   stops reporting.
 */
export function isWslVmAsleep(log = () => {}) {
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
