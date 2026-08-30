/**
 * Turn a raw probe response into the three numbers the key actually shows.
 *
 * `claude agents --json` reports a coarse status per session (today: busy /
 * idle). The vocabulary has room to grow, so match generously rather than
 * switching on an exact pair of strings.
 */
const WORKING = new Set(['busy', 'working', 'running', 'active', 'thinking', 'streaming']);
const BLOCKED = new Set([
  'waiting',
  'blocked',
  'needs_input',
  'needs-input',
  'needsinput',
  'input_required',
  'awaiting_input',
  'permission',
  'prompt',
  'paused',
]);

const normalizeStatus = (status) => String(status ?? '').trim().toLowerCase().replace(/\s+/g, '_');

// Newer CLIs also put a `state` on each agent. Do NOT feed it to the matchers
// above: it is the lifecycle phase, and its "blocked" means "parked at a human
// checkpoint" rather than "stuck". See jobIsBlocked for the distinction.

/**
 * Does this background job's own state file say it is stuck waiting on a human?
 *
 * Only `tempo` and `needs` answer that. A job carries two different notions of
 * blocked and they must not be conflated:
 *
 *   tempo  active | blocked | idle          -- what it is doing right now
 *   state  working | blocked | done | failed | idle
 *                                          -- where it sits in its lifecycle
 *
 * `state: "blocked"` only means the job is parked at a human checkpoint, which
 * for a conversational agent is the normal state between turns -- an agent that
 * has answered you and is waiting for your next message is idle, not stuck.
 * Reading it as "needs you" turns every finished background agent amber.
 *
 * `needs` is the genuine article: login required, rate limited, usage limit
 * reached, API error. Those want a human.
 */
function jobIsBlocked(job) {
  if (!job) return false;
  if (String(job.tempo ?? '').toLowerCase() === 'blocked') return true;
  return typeof job.needs === 'string' && job.needs.trim().length > 0;
}

function inScope(agent, scope) {
  if (scope === 'all') return true;
  const interactive = agent.kind === 'interactive';
  return scope === 'interactive' ? interactive : !interactive;
}

/**
 * Has this background job already concluded -- `state: "done"` or `"failed"`?
 *
 * `claude agents --json` keeps listing a background session for a while after
 * its work is finished, because the process behind it (the shell holding its
 * terminal open) hasn't exited yet. That entry is bookkeeping, not an agent:
 * it already reported its result and nothing further will happen. Counting it
 * inflates the total with sessions that are not "running" in any sense the key
 * is meant to convey, and given enough uncleaned terminals the count would
 * drift upward independent of anything actually happening.
 *
 * Interactive sessions never carry a job `state` -- they have no finish line,
 * only open or closed -- so this only ever excludes background agents.
 */
function jobConcluded(job) {
  return Boolean(job) && ['done', 'failed'].includes(String(job.state ?? '').toLowerCase());
}

/**
 * @returns {{ok: true, total: number, working: number, blocked: number, idle: number,
 *            agents: object[], finished: string[]}}
 *          on success, or {ok: false, error, detail} when the probe failed.
 */
export function summarize(response, { scope = 'all' } = {}) {
  if (!response || response.ok === false) {
    return {
      ok: false,
      error: response?.error ?? 'unknown',
      detail: response?.detail ?? '',
    };
  }

  const jobsBySession = new Map();
  for (const job of Array.isArray(response.jobs) ? response.jobs : []) {
    if (job?.sessionId) jobsBySession.set(job.sessionId, job);
  }

  const agents = [];
  // The sessions jobConcluded drops, kept as bare ids for anyone watching for
  // the moment a job ends -- but only the ones that ended in success. A failed
  // job is left out entirely: it is neither running nor worth celebrating.
  const finished = [];
  for (const agent of Array.isArray(response.agents) ? response.agents : []) {
    if (!agent || typeof agent !== 'object') continue;
    if (!inScope(agent, scope)) continue;

    const job = jobsBySession.get(agent.sessionId);
    if (jobConcluded(job)) {
      if (agent.sessionId && String(job.state).toLowerCase() === 'done') finished.push(agent.sessionId);
      continue;
    }

    const status = normalizeStatus(agent.status);

    let state;
    if (WORKING.has(status)) state = 'working';
    else if (BLOCKED.has(status)) state = 'blocked';
    else if (jobIsBlocked(job)) state = 'blocked';
    else state = 'idle';

    agents.push({
      ...agent,
      state,
      needs: typeof job?.needs === 'string' ? job.needs.trim() : '',
    });
  }

  const count = (state) => agents.filter((agent) => agent.state === state).length;

  return {
    ok: true,
    claude: response.claude ?? '',
    total: agents.length,
    working: count('working'),
    blocked: count('blocked'),
    idle: count('idle'),
    agents,
    finished,
  };
}

const ERROR_HINTS = {
  'claude-not-found':
    'The claude binary was not found. Set an explicit path in "Claude binary" (for example /home/you/.local/bin/claude).',
  'agents-command-failed': '`claude agents --json` exited non-zero. Try running it yourself in a shell.',
  'host-unreachable': 'Could not start the shell. On Windows, check that WSL is installed and the distro name is right.',
  'spawn-failed': 'Could not start the shell process.',
  timeout: 'The host did not answer in time. A cold WSL distro can take a while on the first call.',
  'bad-response': 'The probe returned something that was not JSON.',
  'empty-response': 'The probe returned nothing at all.',
  'wsl-asleep':
    'WSL is not running, so this poll skipped it rather than starting it back up. Press the key, or open the Property Inspector, for a real check.',
};

export function errorHint(error, detail) {
  const hint = ERROR_HINTS[error] ?? 'Unexpected failure.';
  return detail ? `${hint} (${detail})` : hint;
}
