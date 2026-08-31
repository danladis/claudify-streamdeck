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
 * Is Claude running on Windows itself, rather than in a distro?
 *
 * Distinct from WINDOWS_DESKTOP, which asks whose *windows* these are: under
 * the `wsl` transport the terminal is a Windows window running a Linux shell,
 * so the two answers differ and each caller wants a different one.
 */
const isNativeWindows = (settings, platform = process.platform) =>
  platform === 'win32' && resolveTransport(settings, platform) !== 'wsl';

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
  // Native Windows cannot go through the candidate list at all -- see
  // nativeWindowsStartScript for why its command line needs a different ride.
  const result = isNativeWindows(settings)
    ? await startNativeWindowsTerminal(shellCommand)
    : await firstThatStarts(
        resolveTransport(settings) === 'wsl'
          ? windowsTerminalCandidates(settings, shellCommand)
          : unixTerminalCandidates(shellCommand),
        { hideWindow: false },
      );
  if (!result.ok) return result;

  // Give the terminal a moment to put its window up before reaching for it.
  await new Promise((done) => setTimeout(done, 1200));
  await focusTerminal(settings, names);
  return result;
}

/* --------------------------------------------------- powershell errand ---- */

/** Single-quote a value for PowerShell. */
const psQuote = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

/**
 * Run a PowerShell script and believe the verdict it prints.
 *
 * -EncodedCommand takes UTF-16LE base64. It is the only form that survives both
 * the command line and a here-string inside the script; `-Command -` mangles
 * the here-string, and a file path breaks when the plugin is driven from WSL.
 *
 * @param marker The word the script prints, followed by a colon, when it
 *   succeeded. PowerShell's exit code does not reliably survive the trip, so
 *   that line is the only thing worth trusting.
 */
function runPowerShell(script, marker) {
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
      const verdict = new RegExp(`^${marker}:`, 'm').exec(detail);
      resolve({
        ok: Boolean(verdict),
        detail: verdict
          ? verdict.input.slice(verdict.index).split(/\r?\n/)[0]
          : detail || `exit code ${code}`,
      });
    });
  });
}

/* -------------------------------------------- Windows, without a distro ---- */

/**
 * A PowerShell script that starts the first of `attempts` that will start, and
 * prints `started: <file>` when one does.
 *
 * Spawning is not an option here, and this is the reason: a native command line
 * carries double quotes -- a Windows path with a space in it has no other
 * option -- and Node escapes those with backslashes when it quotes an argument.
 * That is the C runtime's convention, not cmd's, so cmd receives
 * `\"C:\Program Files\"` and complains that the filename syntax is wrong. Given
 * one argument *string*, `Start-Process` passes it as the command line
 * untouched, and handing the script over as base64 means nothing has to survive
 * a command line at all -- the same trick focusTerminal relies on.
 *
 * PowerShell does the falling back too, because it has to: a spawn of
 * powershell succeeds whether or not the wt.exe inside it does, so
 * firstThatStarts out here could not tell.
 *
 * @param attempts [file, argumentLine] pairs, best first.
 * @param windowStyle 'Normal' for something meant to be seen, 'Hidden' for the
 *   silent errands -- the equivalent of detach's hideWindow, except that the
 *   window belongs to a process Start-Process creates rather than to our child.
 */
export function nativeWindowsStartScript(attempts, windowStyle) {
  const list = attempts
    .map(([file, args]) => `@{ File = ${psQuote(file)}; Args = ${psQuote(args)} }`)
    .join(',\n  ');

  return `$problem = 'nothing to try'
foreach ($attempt in @(
  ${list}
)) {
  try {
    Start-Process -FilePath $attempt.File -ArgumentList $attempt.Args -WindowStyle ${windowStyle} -ErrorAction Stop
    Write-Output ('started: ' + $attempt.File)
    exit 0
  } catch {
    $problem = $attempt.File + ': ' + $_.Exception.Message
  }
}
Write-Output ('failed: ' + $problem)
exit 1`;
}

/**
 * The argument lines that open `shellCommand` in a window, best first.
 *
 * Neither line may wrap the command in another quote pair: `cmd /s /c` strips an
 * *outer* pair and takes the rest verbatim, which is what keeps the command's
 * own quotes and its `&&` intact. Wrapping it would hand cmd's quote-parity
 * rules a string the user typed.
 */
export function nativeWindowsTerminalArgs(shellCommand) {
  return [
    // The lone `--` ends wt's own option parsing and hands it the rest as a
    // command line; an unescaped `;` would start a second tab.
    ['wt.exe', `new-tab --title "Claude agents" -- cmd.exe /s /c ${escapeForWt(shellCommand)}`],
    ['cmd.exe', `/s /c ${shellCommand}`],
  ];
}

/** Open a terminal on Windows itself. Start-Process gives a console app a
 * console of its own, which is the whole point -- a detached spawn on Windows
 * gets none and runs invisibly. */
function startNativeWindowsTerminal(shellCommand) {
  return runPowerShell(nativeWindowsStartScript(nativeWindowsTerminalArgs(shellCommand), 'Normal'), 'started');
}

/** Run `shellCommand` on Windows itself with nothing to see. */
function runNativeWindowsDetached(shellCommand) {
  return runPowerShell(
    nativeWindowsStartScript([['cmd.exe', `/s /c ${shellCommand}`]], 'Hidden'),
    'started',
  );
}

/* --------------------------------------------------------------- focus ---- */

const FOCUS_SCRIPT = readFileSync(join(HERE, 'focus.ps1'), 'utf8');

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

  return runPowerShell(script, 'raised');
}

/** Run `shellCommand` on the Claude host with no window and no output. */
export function runDetached(settings, shellCommand) {
  if (resolveTransport(settings) === 'wsl') {
    const distroArgs = settings.distro ? ['-d', settings.distro] : [];
    return detach('wsl.exe', [...distroArgs, '--', 'bash', '-lc', shellCommand]);
  }
  // Not a spawn, for the same reason the terminal is not one: see
  // nativeWindowsStartScript.
  if (isNativeWindows(settings)) return runNativeWindowsDetached(shellCommand);
  return detach('/bin/bash', ['-lc', shellCommand]);
}

/**
 * The interactive agent view, in the shell language of whichever host will run
 * it. `claudeBin` comes from the last probe, so the terminal uses the same
 * binary the count was read from.
 *
 * `platform` is a parameter so the Windows form can be tested from anywhere.
 */
export function agentViewCommand(settings, claudeBin, platform = process.platform) {
  const binary = settings.claudeBin || claudeBin || 'claude';

  if (isNativeWindows(settings, platform)) {
    // A double quote cannot occur in a Windows path, so quoting is all the
    // escaping a path needs. `cd /d` is required to cross drives, and `&&`
    // rather than `;` so a bad folder does not run claude in the wrong place --
    // cmd has no equivalent of the POSIX branch's `2>/dev/null` shrug.
    const quote = (value) => `"${value.replace(/"/g, '')}"`;
    const cd = settings.cwdFilter ? `cd /d ${quote(settings.cwdFilter)} && ` : '';
    return `${cd}${quote(binary)} agents`;
  }

  const quoted = `'${binary.replace(/'/g, `'\\''`)}'`;
  const cd = settings.cwdFilter ? `cd '${settings.cwdFilter.replace(/'/g, `'\\''`)}' 2>/dev/null; ` : '';
  return `${cd}${quoted} agents`;
}
