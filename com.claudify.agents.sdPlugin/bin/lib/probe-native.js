/**
 * The same snapshot probe.sh takes, taken by this process instead of a shell.
 *
 * The script exists because the `wsl` transport needs code running *inside* the
 * distro, where nothing of ours is installed -- piping sh a here-doc is the
 * only way in. For every other host the plugin is already a Node process on
 * the machine Claude runs on, so there is nothing to cross and no reason to
 * assume a POSIX shell: native Windows has no `sh` at all, which is what kept
 * that host unsupported.
 *
 * The two must agree on their output, so this returns the shape probe.js's
 * parseSections builds -- the same `error` names, the same tolerance for a job
 * state file caught mid-write -- and nothing downstream can tell which one ran.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';

const TIMEOUT_MS = 20_000;

/** `claude agents --json` answers in kilobytes; this is only a runaway guard. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * On Windows a name may carry any of three extensions, and which one we get
 * matters: a `.cmd` is a batch shim that Node cannot spawn directly, so `.exe`
 * anywhere on PATH is preferred to a `.cmd` anywhere. Hence extension-major
 * order rather than directory-major.
 */
const WINDOWS_NAMES = ['claude.exe', 'claude.cmd', 'claude.bat'];

/** Batch shims have to go through cmd.exe; see quoteForCmd. */
const needsShell = (binary, platform) =>
  platform === 'win32' && ['.cmd', '.bat'].includes(extname(binary).toLowerCase());

/**
 * Where to look when no explicit path was given.
 *
 * PATH comes first, as `command -v` does in the script, then the standard
 * install locations -- Stream Deck launches plugins with a PATH that need not
 * include either, and on Windows the native installer's directory is not on it
 * by default at all.
 */
function claudeCandidates({ platform, home, env }) {
  const pathDirs = String(env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);

  if (platform === 'win32') {
    const extra = [join(home, '.local', 'bin')];
    if (env.APPDATA) extra.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) extra.push(join(env.LOCALAPPDATA, 'Programs', 'claude'));
    // Extension-major: see WINDOWS_NAMES.
    return WINDOWS_NAMES.flatMap((name) => [...pathDirs, ...extra].map((dir) => join(dir, name)));
  }

  return [
    ...pathDirs.map((dir) => join(dir, 'claude')),
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

/**
 * Can we run this path?
 *
 * The execute bit is a POSIX notion. Windows decides by extension, and
 * `access(X_OK)` there succeeds for anything that exists -- including a
 * directory -- so ask whether it is a file instead.
 */
async function isRunnable(path, platform) {
  try {
    if (platform === 'win32') return (await stat(path)).isFile();
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The binary to run, or null.
 *
 * An explicit path is a promise, not a hint: if it is wrong, say so rather
 * than quietly counting agents from some other binary. The one liberty taken
 * is on Windows, where a path typed without its extension is still obviously
 * meant -- `...\bin\claude` becomes `...\bin\claude.exe` rather than an error.
 */
async function findClaude(settings, deps) {
  const { platform } = deps;
  const explicit = String(settings.claudeBin ?? '').trim();

  if (explicit) {
    if (await isRunnable(explicit, platform)) return explicit;
    if (platform === 'win32' && !extname(explicit)) {
      for (const ext of ['.exe', '.cmd', '.bat']) {
        if (await isRunnable(explicit + ext, platform)) return explicit + ext;
      }
    }
    return null;
  }

  for (const candidate of claudeCandidates(deps)) {
    if (await isRunnable(candidate, platform)) return candidate;
  }
  return null;
}

/**
 * Wrap a value for a cmd.exe command line.
 *
 * Only reached for a batch shim, and only ever given a filesystem path or the
 * literal `agents`. Double quotes cannot occur in a Windows path, so quoting
 * is enough for the spaces and ampersands that can -- but `%` can appear in a
 * directory name and cmd would expand `%FOO%` inside quotes regardless. That
 * is the shim's own hazard, not one this introduces, and it is why the search
 * order above works to avoid needing a shell in the first place.
 */
const quoteForCmd = (value) => `"${String(value).replace(/"/g, '')}"`;

/** Run `claude agents --json` and hand back the parsed array. */
function runAgents(binary, settings, { platform, home }) {
  const args = ['agents', '--json'];
  if (settings.cwdFilter) args.push('--cwd', settings.cwdFilter);

  const shell = needsShell(binary, platform);
  const options = {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The script runs from $HOME; match it, so a `claude` invoked here cannot
    // pick up project settings from wherever Stream Deck happened to start us.
    cwd: home,
  };

  return new Promise((resolve) => {
    let child;
    try {
      // With shell:true Node joins file and args *unquoted*, so the line has to
      // be built here and the args left empty.
      child = shell
        ? spawn([binary, ...args].map(quoteForCmd).join(' '), [], { ...options, shell: true })
        : spawn(binary, args, options);
    } catch (err) {
      resolve({ ok: false, error: 'spawn-failed', detail: err.message });
      return;
    }

    const out = [];
    const err = [];
    let size = 0;
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

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'bad-response', detail: 'the output never ended' });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => err.push(chunk));

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      finish({
        ok: false,
        error: missing ? 'claude-not-found' : 'spawn-failed',
        detail: missing ? `${binary} could not be run` : error.message,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      const stdout = Buffer.concat(out).toString('utf8').trim();

      // Matching the script: a non-zero exit and an empty answer are the same
      // complaint, because either way there is no reading to show.
      if (code !== 0 || !stdout) {
        finish({
          ok: false,
          error: 'agents-command-failed',
          exitCode: code ?? -1,
          claude: binary,
          detail: Buffer.concat(err).toString('utf8').trim().slice(0, 200),
        });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish({ ok: false, error: 'bad-response', detail: stdout.slice(0, 200) });
        return;
      }
      // parseSections is equally forgiving here: something that is not a list
      // of agents is no agents, not a failure.
      finish({ ok: true, agents: Array.isArray(parsed) ? parsed : [] });
    });
  });
}

/**
 * Which of the listed sessions live inside VS Code -- the pids probe.sh's
 * CLIENTS section would name, taken natively.
 *
 * On Linux the extension host stamps its children with VSCODE_* environment
 * variables and /proc keeps a copy. macOS has no /proc, but a single `ps`
 * snapshot gives the process tree, and a session whose ancestry runs through
 * the VS Code app is a VS Code session. Native Windows has neither cheap
 * answer, so its sessions stay unmarked -- the focus falls back to a terminal
 * there, exactly as it always has.
 */
async function findVscodePids(agents, { platform }) {
  const pids = agents.map((agent) => agent?.pid).filter((pid) => Number.isInteger(pid));
  if (pids.length === 0) return [];

  if (platform === 'linux') {
    const marked = [];
    for (const pid of pids) {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, 'utf8');
        if (environ.split('\0').some((entry) => entry.startsWith('VSCODE_'))) marked.push(pid);
      } catch {
        // Gone already, or not ours to read: then it is not marked, not fatal.
      }
    }
    return marked;
  }

  if (platform === 'darwin') {
    const table = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        resolve('');
        return;
      }
      const out = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
    });

    const processes = new Map();
    for (const line of table.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
    }

    const looksLikeVscode = (command) => /vscode|visual studio code|code helper/i.test(command);
    return pids.filter((pid) => {
      const seen = new Set();
      for (let at = pid; processes.has(at) && !seen.has(at); ) {
        seen.add(at);
        const { ppid, command } = processes.get(at);
        if (looksLikeVscode(command)) return true;
        at = ppid;
      }
      return false;
    });
  }

  return [];
}

/** The shape of a session id, matching what probe.sh's scrape accepts. */
const SESSION_ID = /^[0-9a-fA-F-]{36}$/;

/** How much of a transcript's tail is read looking for the current title. */
const TITLE_TAIL_BYTES = 65_536;

/** Every `aiTitle` in a chunk of transcript; the last one is the current one. */
const TITLE_PATTERN = /"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * The path Claude Code keeps a session's transcript at.
 *
 * Project directories are the session's cwd with every separator turned into a
 * dash, so the path is computable rather than searchable -- but only while that
 * rule holds, so a miss falls back to looking through the project directories
 * for the file named after the session.
 */
async function findTranscript(home, sessionId, cwd) {
  // A session id becomes a path segment, so it has to look like one -- the
  // shell probe only ever matches this shape and the two must agree. Anything
  // else is refused rather than joined: `..` in an id would walk out of the
  // projects directory and read whatever it landed on.
  if (!SESSION_ID.test(String(sessionId ?? ''))) return '';

  const projects = join(home, '.claude', 'projects');
  const direct = join(projects, String(cwd ?? '').replaceAll('/', '-'), `${sessionId}.jsonl`);
  try {
    await access(direct, constants.R_OK);
    return direct;
  } catch {
    // The encoding rule did not hold for this cwd; go looking.
  }

  let entries;
  try {
    entries = await readdir(projects);
  } catch {
    return '';
  }
  for (const entry of entries) {
    const candidate = join(projects, entry, `${sessionId}.jsonl`);
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Not this project.
    }
  }
  return '';
}

/**
 * What each session's terminal tab is called, keyed by session id.
 *
 * Claude Code titles the tab after the task and records that same string in the
 * transcript as `aiTitle`. Nothing else joins a session id to the title its tab
 * is showing: the session `name` is a different string (cwd-derived for
 * interactive sessions), and a window title only ever reflects the *active*
 * tab -- so without this a press can raise the right window and still leave you
 * on the wrong tab.
 *
 * Only the tail is read. The field is rewritten whenever the title changes and
 * a transcript grows without bound, so the last occurrence is the current
 * title and the first 64KB would be the stalest possible answer. A session too
 * new to have been titled has no entry, and the caller falls back to matching
 * on window title alone.
 */
async function readTitles(agents, home) {
  const titles = {};
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent?.sessionId) continue;
    const path = await findTranscript(home, agent.sessionId, agent.cwd);
    if (!path) continue;

    let handle;
    try {
      handle = await open(path, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, TITLE_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, size - length));

      const found = [...buffer.toString('utf8').matchAll(TITLE_PATTERN)];
      if (!found.length) continue;
      // The capture is still JSON-escaped -- the same bytes that were in the
      // file -- so let JSON undo it rather than guessing at the escapes.
      const title = JSON.parse(`"${found[found.length - 1][1]}"`);
      if (title) titles[agent.sessionId] = title;
    } catch {
      // Unreadable, mid-write, or not valid JSON after all: no title, no harm.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return titles;
}

/**
 * Every background job's state file.
 *
 * `claude agents --json` reports busy/idle but not *why* a background agent is
 * idle; the state file carries that. A file that will not read or will not
 * parse is dropped rather than fatal -- the same bargain the script's
 * per-section framing strikes, and for the same reason: one job caught
 * mid-write must not cost the whole reading.
 */
async function readJobs(home) {
  let entries;
  try {
    entries = await readdir(join(home, '.claude', 'jobs'));
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    try {
      jobs.push(JSON.parse(await readFile(join(home, '.claude', 'jobs', entry, 'state.json'), 'utf8')));
    } catch {
      // Not a job directory, or a file being written right now.
    }
  }
  return jobs;
}

/**
 * A snapshot of every live Claude Code session on this machine.
 *
 * @param settings Normalized key settings; only claudeBin and cwdFilter matter.
 * @param [log] Told which binary was picked, so "counting the wrong claude" is
 *   diagnosable from the log rather than only from the Property Inspector.
 * @param [deps] Test seam: the platform, the home directory and the
 *   environment, so a test never has to depend on the machine it runs on.
 * @returns the same shape probe.sh's output parses into -- never a rejection.
 */
export async function probeNative(settings, log = () => {}, deps = {}) {
  const resolved = {
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    env: deps.env ?? process.env,
  };

  const binary = await findClaude(settings, resolved);
  if (!binary) {
    return {
      ok: false,
      error: 'claude-not-found',
      detail: settings.claudeBin ? `${settings.claudeBin} is not there, or is not runnable` : '',
    };
  }
  log(`[claude-agents] using ${binary}`);

  const agents = await runAgents(binary, settings, resolved);
  if (!agents.ok) return agents;

  return {
    ok: true,
    claude: binary,
    agents: agents.agents,
    jobs: await readJobs(resolved.home),
    vscodePids: await findVscodePids(agents.agents, resolved),
    titles: await readTitles(agents.agents, resolved.home),
  };
}
