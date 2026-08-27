import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTransport } from './settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Whether the windows we would be raising are Windows windows. True under
 * Stream Deck on Windows, and also when the plugin is driven from a WSL shell
 * during development, where interop makes powershell.exe reachable.
 */
const WINDOWS_DESKTOP =
  process.platform === 'win32' ||
  (process.platform === 'linux' &&
    (existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ||
      existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late')));

/**
 * Fire and forget: nothing we launch should outlive-block the plugin.
 *
 * `hideWindow` must be false for anything meant to be seen. windowsHide sets
 * SW_HIDE, and a terminal started that way stays invisible -- worse, Windows
 * Terminal then keeps serving later `wt new-tab` calls from that hidden
 * instance, so every launch afterwards disappears into it too.
 */
function detach(file, args, { hideWindow = true, ...options } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: hideWindow,
        ...options,
      });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, detail: err.message }));
    child.unref();
    // spawn() reports ENOENT asynchronously, so give it a tick before
    // declaring success and moving on to the next candidate.
    setTimeout(() => resolve({ ok: true }), 150);
  });
}

async function firstThatStarts(candidates, options) {
  let last = { ok: false, detail: 'nothing to try' };
  for (const [file, args] of candidates) {
    last = await detach(file, args, options);
    if (last.ok) return last;
  }
  return last;
}

/**
 * Windows Terminal treats `;` as a tab separator, so any semicolon inside the
 * payload has to be escaped before it reaches wt.exe.
 */
const escapeForWt = (value) => value.replace(/;/g, '\\;');

function windowsTerminalCandidates(settings, shellCommand) {
  const distroArgs = settings.distro ? ['-d', settings.distro] : [];
  const wsl = ['wsl.exe', ...distroArgs, '--', 'bash', '-lc', shellCommand];

  return [
    // The lone `--` ends wt's own option parsing; without it wt would claim
    // wsl's `-d` as its --startingDirectory.
    ['wt.exe', ['new-tab', '--title', 'Claude agents', '--', ...wsl.map(escapeForWt)]],
    ['cmd.exe', ['/c', 'start', '', ...wsl]],
  ];
}

function unixTerminalCandidates(shellCommand) {
  if (process.platform === 'darwin') {
    const script = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [['osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate']]];
  }
  return [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', shellCommand]],
    ['gnome-terminal', ['--', 'bash', '-lc', shellCommand]],
    ['konsole', ['-e', 'bash', '-lc', shellCommand]],
    ['xterm', ['-e', 'bash', '-lc', shellCommand]],
  ];
}

/**
 * Open `shellCommand` in a visible terminal on whichever host runs Claude, then
 * raise it -- `wt new-tab` attaches to an existing window without focusing it,
 * so without this the tab lands somewhere behind whatever you were doing.
 */
export async function openInTerminal(settings, shellCommand, names = []) {
  const candidates =
    resolveTransport(settings) === 'wsl'
      ? windowsTerminalCandidates(settings, shellCommand)
      : unixTerminalCandidates(shellCommand);

  const result = await firstThatStarts(candidates, { hideWindow: false });
  if (!result.ok) return result;

  // Give the terminal a moment to put its window up before reaching for it.
  await new Promise((done) => setTimeout(done, 1200));
  await focusTerminal(settings, names);
  return result;
}

/* --------------------------------------------------------------- focus ---- */

const FOCUS_SCRIPT = readFileSync(join(HERE, 'focus.ps1'), 'utf8');

/** Single-quote a value for PowerShell. */
const psQuote = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

/**
 * Bring the terminal a session is running in to the front, launching nothing.
 *
 * `names` are the live session names: Windows Terminal puts the active tab's
 * title in its window title and Claude Code names a session after its task, so
 * a name match usually finds the right window. Any terminal window is the
 * fallback.
 */
export function focusTerminal(settings, names = []) {
  if (!(WINDOWS_DESKTOP || resolveTransport(settings) === 'wsl')) {
    if (process.platform === 'darwin') {
      return detach('osascript', ['-e', 'tell application "Terminal" to activate'], {
        hideWindow: false,
      });
    }
    // X11/Wayland activation is not portable enough to guess at.
    return Promise.resolve({ ok: false, detail: 'focusing is supported on Windows and macOS' });
  }

  const list = names.length ? `@(${names.map(psQuote).join(', ')})` : '@()';
  const script = FOCUS_SCRIPT.replaceAll('__NAMES__', list);
  if (script.includes('__NAMES__')) {
    return Promise.resolve({ ok: false, detail: 'focus.ps1 placeholder was not substituted' });
  }

  // -EncodedCommand takes UTF-16LE base64. It is the only form that survives
  // both the command line and the here-string inside the script; `-Command -`
  // mangles the here-string, and a file path breaks when the plugin is driven
  // from WSL.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }

    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    child.on('error', (err) => resolve({ ok: false, detail: err.message }));
    child.on('close', (code) => {
      const detail = Buffer.concat(out).toString('utf8').trim();
      // PowerShell's exit code does not reliably survive `-Command -`, so trust
      // the verdict the script prints rather than the code it exits with.
      const raised = /^raised:/m.exec(detail);
      resolve({
        ok: Boolean(raised),
        detail: raised ? raised.input.slice(raised.index).split(/\r?\n/)[0] : detail || `exit code ${code}`,
      });
    });
  });
}

/** Run `shellCommand` on the Claude host with no window and no output. */
export function runDetached(settings, shellCommand) {
  if (resolveTransport(settings) === 'wsl') {
    const distroArgs = settings.distro ? ['-d', settings.distro] : [];
    return detach('wsl.exe', [...distroArgs, '--', 'bash', '-lc', shellCommand]);
  }
  return detach('/bin/bash', ['-lc', shellCommand]);
}

/**
 * The interactive agent view. `claudeBin` comes from the last probe, so the
 * terminal uses the same binary the count was read from.
 */
export function agentViewCommand(settings, claudeBin) {
  const binary = settings.claudeBin || claudeBin || 'claude';
  const quoted = `'${binary.replace(/'/g, `'\\''`)}'`;
  const cd = settings.cwdFilter ? `cd '${settings.cwdFilter.replace(/'/g, `'\\''`)}' 2>/dev/null; ` : '';
  return `${cd}${quoted} agents`;
}
