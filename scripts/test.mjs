#!/usr/bin/env node
/** Unit tests for the pure parts: parsing, classification, key faces. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  'com.claudify.agents.sdPlugin',
  'bin',
  'lib',
);

const { parseSections } = await import(join(LIB, 'probe.js'));
const { probeNative } = await import(join(LIB, 'probe-native.js'));
const { agentViewCommand, focusTargets, nativeWindowsStartScript, nativeWindowsTerminalArgs } =
  await import(join(LIB, 'launch.js'));
const { isWslPath } = await import(join(LIB, 'wsl.js'));
const { summarize, errorHint } = await import(join(LIB, 'classify.js'));
const {
  viewFor,
  renderKey,
  ringFrames,
  THICKNESS,
  strokeFor,
  SPIN_PERIOD_MS,
  SPIN_FRAME_MS,
  spinFrameMs,
} = await import(join(LIB, 'render.js'));
const {
  clawdView,
  clawdFrames,
  clawdFrameMs,
  renderClawd,
  pickRandomMove,
  ANIMATIONS,
  DEFAULT_ANIMATION,
  DANCE,
  CLAWD_BODY,
  CLAWD_FRAME_MS,
} = await import(join(LIB, 'clawd.js'));
const { FinishWatcher } = await import(join(LIB, 'finished.js'));
const { partyFrames, PARTY_MS, PARTY_FRAME_MS } = await import(join(LIB, 'party.js'));
const { claudeMark } = await import(join(LIB, 'claudemark.js'));
const { readFileSync } = await import('node:fs');
const { CENTER, CORNER } = await import(join(LIB, 'canvas.js'));
const { normalize, probeKey, resolveTransport, SPEEDS, speedFactor } = await import(
  join(LIB, 'settings.js'),
);

const USAGE = join(LIB, 'usage');
const { statusForPercent, worstStatus, normalizeUsage, emptySnapshot } = await import(
  join(USAGE, 'snapshot.js'),
);
const { normalize: normalizeUsageSettings, MIN_INTERVAL, thresholdsFor } = await import(
  join(USAGE, 'settings.js'),
);
const { readCredentials, resolveCredentialsPath, isExpired } = await import(
  join(USAGE, 'credentials.js'),
);
const { UsageCache, MIN_RATE_LIMIT_BACKOFF_MS } = await import(join(USAGE, 'cache.js'));
const { getUsage } = await import(join(USAGE, 'provider.js'));
const { UnauthorizedError, authRequired, rateLimited, parseRetryAfterMs } = await import(
  join(USAGE, 'errors.js'),
);
const { renderBars } = await import(join(USAGE, 'bars.js'));
const { renderGauge } = await import(join(USAGE, 'gauge.js'));
const { formatResetTime, formatCountdown } = await import(join(USAGE, 'time.js'));
const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');

const agent = (over = {}) => ({
  pid: 1,
  cwd: '/repo',
  kind: 'interactive',
  sessionId: 's1',
  name: 'one',
  status: 'busy',
  ...over,
});

/* ------------------------------------------------------------- probe ---- */

test('parseSections reads a full snapshot', () => {
  const snapshot = parseSections(
    [
      'CLAUDIFY-META',
      '{"claude":"/bin/claude"}',
      'CLAUDIFY-AGENTS',
      JSON.stringify([agent()]),
      'CLAUDIFY-JOB',
      '{"sessionId":"s1","tempo":"blocked","needs":"approve the edit"}',
      'CLAUDIFY-END',
    ].join('\n'),
  );

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.claude, '/bin/claude');
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.jobs.length, 1);
});

test('a job file caught mid-write costs only that job', () => {
  const snapshot = parseSections(
    [
      'CLAUDIFY-META',
      '{"claude":"/bin/claude"}',
      'CLAUDIFY-AGENTS',
      JSON.stringify([agent(), agent({ sessionId: 's2' })]),
      'CLAUDIFY-JOB',
      '{"sessionId":"s1","tempo":"bloc',
      'CLAUDIFY-JOB',
      '{"sessionId":"s2","tempo":"blocked"}',
      'CLAUDIFY-END',
    ].join('\n'),
  );

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.agents.length, 2, 'the count survives');
  assert.deepEqual(
    snapshot.jobs.map((job) => job.sessionId),
    ['s2'],
    'only the torn job is dropped',
  );
});

test('parseSections surfaces the script error section', () => {
  const snapshot = parseSections('CLAUDIFY-ERROR\n{"error":"claude-not-found"}\n');
  assert.deepEqual(snapshot, { ok: false, error: 'claude-not-found' });
});

test('parseSections rejects output that is not ours', () => {
  assert.equal(parseSections('There is no distribution with the supplied name.'), null);
  assert.equal(parseSections(''), null);
});

test('parseSections tolerates CRLF from the Windows side', () => {
  const snapshot = parseSections('CLAUDIFY-META\r\n{"claude":"/c"}\r\nCLAUDIFY-AGENTS\r\n[]\r\n');
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.claude, '/c');
});

test('parseSections reads the CLIENTS section, and survives its absence', () => {
  const withClients = parseSections(
    [
      'CLAUDIFY-AGENTS',
      JSON.stringify([agent(), agent({ pid: 2, sessionId: 's2' })]),
      'CLAUDIFY-CLIENTS',
      '{"vscodePids":[2,"junk"]}',
      'CLAUDIFY-END',
    ].join('\n'),
  );
  assert.deepEqual(withClients.vscodePids, [2], 'integers only');

  const without = parseSections('CLAUDIFY-AGENTS\n[]\nCLAUDIFY-END\n');
  assert.deepEqual(without.vscodePids, [], 'an older script still parses');
});

/* ---------------------------------------------------------- classify ---- */

test('the probe names the VS Code pids and summarize stamps each agent', () => {
  const summary = summarize({
    ok: true,
    agents: [agent({ pid: 7 }), agent({ pid: 8, sessionId: 's2' })],
    jobs: [],
    vscodePids: [8],
  });
  assert.deepEqual(
    summary.agents.map((a) => a.client),
    ['terminal', 'vscode'],
  );

  const withoutSection = summarize({ ok: true, agents: [agent()], jobs: [] });
  assert.equal(withoutSection.agents[0].client, 'terminal', 'unknown means terminal');
});

test('focusTargets ranks who needs you and knows where each session lives', () => {
  const agents = [
    { name: 'idle-one', cwd: '/repo/idle', state: 'idle', client: 'terminal' },
    { name: 'editing', cwd: '/home/x/projects/webapp', state: 'blocked', client: 'vscode' },
    { name: 'churning', cwd: '/repo/work', state: 'working', client: 'terminal' },
  ];

  assert.deepEqual(focusTargets(agents), [
    // The blocked VS Code session first, found by its folder in a Code window.
    { title: 'webapp', process: 'Code*' },
    { title: 'churning', process: '' },
    { title: 'idle-one', process: '' },
    // Any VS Code window as the last resort, since a VS Code session is in play.
    { title: '', process: 'Code*' },
  ]);

  assert.deepEqual(
    focusTargets(agents, { only: 'vscode' }),
    [
      { title: 'webapp', process: 'Code*' },
      { title: '', process: 'Code*' },
    ],
    'the dedicated press ignores terminal sessions',
  );

  assert.deepEqual(
    focusTargets([agents[0]], { only: 'vscode' }),
    [{ title: '', process: 'Code*' }],
    'no VS Code session still lands in the editor rather than nowhere',
  );

  assert.deepEqual(
    focusTargets([agents[0], agents[2]]),
    [
      { title: 'churning', process: '' },
      { title: 'idle-one', process: '' },
    ],
    'terminal-only decks never reach for a Code window',
  );
});

test('busy counts as working, idle as idle', () => {
  const summary = summarize({
    ok: true,
    agents: [agent({ status: 'busy' }), agent({ sessionId: 's2', status: 'idle' })],
    jobs: [],
  });
  assert.deepEqual(
    [summary.total, summary.working, summary.blocked, summary.idle],
    [2, 1, 0, 0 + 1],
  );
});

test('an unknown waiting-ish status still reads as blocked', () => {
  for (const status of ['waiting', 'needs_input', 'BLOCKED', 'input_required']) {
    const summary = summarize({ ok: true, agents: [agent({ status })], jobs: [] });
    assert.equal(summary.blocked, 1, status);
  }
});

test('a job state file promotes an idle background agent to blocked', () => {
  const summary = summarize({
    ok: true,
    agents: [agent({ kind: 'bg', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'working', tempo: 'blocked', needs: 'send a prompt to start' }],
  });
  assert.equal(summary.blocked, 1);
  assert.equal(summary.agents[0].needs, 'send a prompt to start');
});

test('an agent parked between turns is idle, not blocked', () => {
  // A background agent that has answered and is awaiting the next prompt sits at
  // state:"blocked" with an idle tempo. That is normal conversational idleness --
  // reading it as "needs you" would turn every finished agent amber.
  const summary = summarize({
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle', state: 'blocked' })],
    jobs: [{ sessionId: 's1', state: 'blocked', tempo: 'idle', inFlight: { tasks: 0 } }],
  });
  assert.equal(summary.blocked, 0, 'not waiting on the human');
  assert.equal(summary.idle, 1);
});

test('a blocked tempo or a needs string does mean blocked', () => {
  const withTempo = summarize({
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'working', tempo: 'blocked' }],
  });
  assert.equal(withTempo.blocked, 1);

  // These are the real calls for a human: login, rate limits, usage limits.
  const withNeeds = summarize({
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'blocked', tempo: 'idle', needs: 'login required — run /login' }],
  });
  assert.equal(withNeeds.blocked, 1);
  assert.equal(withNeeds.agents[0].needs, 'login required — run /login');
});

test('a concluded background job does not count as an agent at all', () => {
  // The real case that prompted this: a job that already finished and reported
  // its result is bookkeeping, not something still "running".
  const response = {
    ok: true,
    agents: [
      agent({ sessionId: 's1', kind: 'background', status: 'busy' }),
      agent({ sessionId: 's2', kind: 'background', status: 'idle' }),
    ],
    jobs: [
      { sessionId: 's1', state: 'working', tempo: 'active' },
      { sessionId: 's2', state: 'done', tempo: 'idle' },
    ],
  };
  const summary = summarize(response, { scope: 'all' });
  assert.equal(summary.total, 1, 'the done job vanishes entirely');
  assert.equal(summary.working, 1);
  assert.equal(summary.idle, 0);
  assert.deepEqual(summary.agents.map((a) => a.sessionId), ['s1']);
});

test('a done job is reported as finished, on its way out of the count', () => {
  const summary = summarize({
    ok: true,
    agents: [
      agent({ sessionId: 's1', kind: 'background', status: 'idle' }),
      agent({ sessionId: 's2', kind: 'background', status: 'busy' }),
    ],
    jobs: [
      { sessionId: 's1', state: 'done', tempo: 'idle' },
      { sessionId: 's2', state: 'working', tempo: 'active' },
    ],
  });
  assert.deepEqual(summary.finished, ['s1'], 'the one that concluded, and only it');
  assert.equal(summary.total, 1, 'still not counted as an agent');
});

test('a failed job finishes nothing', () => {
  // Excluded from the count like a done one, but there is nothing to celebrate:
  // it must not turn up in `finished` either.
  const summary = summarize({
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'failed', tempo: 'idle' }],
  });
  assert.deepEqual(summary.finished, []);
});

test('a failed job is excluded the same way as a done one', () => {
  const response = {
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'failed', tempo: 'idle' }],
  };
  assert.equal(summarize(response, { scope: 'all' }).total, 0);
});

test('a mid-conversation idle session still counts -- only done/failed are dropped', () => {
  // The case fixed previously: state:"blocked" between turns, not finished.
  const response = {
    ok: true,
    agents: [agent({ kind: 'background', status: 'idle' })],
    jobs: [{ sessionId: 's1', state: 'blocked', tempo: 'idle' }],
  };
  const summary = summarize(response, { scope: 'all' });
  assert.equal(summary.total, 1);
  assert.equal(summary.idle, 1);
});

test('an interactive session has no job state, so it is never excluded', () => {
  const summary = summarize(
    { ok: true, agents: [agent({ kind: 'interactive', status: 'idle' })], jobs: [] },
    { scope: 'all' },
  );
  assert.equal(summary.total, 1);
  assert.equal(summary.idle, 1);
});

test("scope tracks whatever the CLI calls a background session", () => {
  // The CLI has already renamed this once, from 'bg' to 'background'.
  for (const kind of ['bg', 'background', 'cloud']) {
    const response = { ok: true, agents: [agent({ kind })], jobs: [] };
    assert.equal(summarize(response, { scope: 'bg' }).total, 1, kind);
    assert.equal(summarize(response, { scope: 'interactive' }).total, 0, kind);
  }
});

test('a busy agent is never downgraded to blocked by its job file', () => {
  const summary = summarize({
    ok: true,
    agents: [agent({ kind: 'bg', status: 'busy' })],
    jobs: [{ sessionId: 's1', tempo: 'blocked', needs: 'something stale' }],
  });
  assert.equal(summary.working, 1);
  assert.equal(summary.blocked, 0);
});

test('scope filters by session kind', () => {
  const response = {
    ok: true,
    agents: [agent({ kind: 'interactive' }), agent({ sessionId: 's2', kind: 'bg' })],
    jobs: [],
  };
  assert.equal(summarize(response, { scope: 'all' }).total, 2);
  assert.equal(summarize(response, { scope: 'bg' }).total, 1);
  assert.equal(summarize(response, { scope: 'interactive' }).total, 1);
});

test('a failed probe stays a failed summary', () => {
  const summary = summarize({ ok: false, error: 'timeout', detail: 'slow' });
  assert.equal(summary.ok, false);
  assert.equal(summary.error, 'timeout');
});

/* ------------------------------------------------------------ render ---- */

test('the key face matches the state it is given', () => {
  assert.deepEqual(viewFor({ ok: true, total: 0, working: 0, blocked: 0, idle: 0 }), {
    state: 'empty',
    value: '0',
  });

  const working = viewFor({ ok: true, total: 2, working: 1, blocked: 0, idle: 1 });
  assert.equal(working.state, 'working');
  assert.equal(working.value, '2');
  assert.equal(working.spin, true, 'working is the only face that moves');

  // Blocked wins over working: it is the one state worth interrupting for.
  const blocked = viewFor({ ok: true, total: 3, working: 2, blocked: 1, idle: 0 });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.value, '3');
  assert.ok(!blocked.spin, 'a blocked agent is not making progress, so it holds still');

  assert.equal(viewFor({ ok: true, total: 2, working: 0, blocked: 0, idle: 2 }).state, 'idle');
  assert.deepEqual(viewFor({ ok: false, error: 'timeout' }), { state: 'error', value: '!' });

  // A skipped poll (WSL deliberately left asleep) is not a failure worth
  // flagging red -- it reads the same as "nothing to report".
  assert.deepEqual(viewFor({ ok: false, error: 'wsl-asleep' }), { state: 'empty', value: '0' });
});

test('"only running" leaves the idle sessions out of the number', () => {
  const running = { countMode: 'running' };
  const mixed = { ok: true, total: 5, working: 2, blocked: 0, idle: 3 };

  assert.equal(viewFor(mixed).value, '5', 'the default still counts every session');
  assert.equal(viewFor(mixed, running).value, '2');
  assert.equal(viewFor(mixed, running).state, 'working');

  // An agent waiting on you has not finished, so it still counts as running --
  // and it still colours the key amber.
  const blocked = viewFor({ ok: true, total: 4, working: 1, blocked: 1, idle: 2 }, running);
  assert.equal(blocked.value, '2');
  assert.equal(blocked.state, 'blocked');

  // Nothing running with sessions still open reads as empty, not as an idle
  // count of 0: a bright white 0 would look like a reading.
  const allIdle = viewFor({ ok: true, total: 3, working: 0, blocked: 0, idle: 3 }, running);
  assert.deepEqual(allIdle, { state: 'empty', value: '0' });
  assert.equal(viewFor({ ok: true, total: 3, working: 0, blocked: 0, idle: 3 }).state, 'idle');

  // A broken probe says so whichever mode is on.
  assert.deepEqual(viewFor({ ok: false, error: 'timeout' }, running), { state: 'error', value: '!' });
});

test('the count mode reaches the drawn frames', () => {
  const summary = { ok: true, total: 4, working: 1, blocked: 0, idle: 3 };
  const [all] = ringFrames(summary, { animate: false });
  const [running] = ringFrames(summary, { animate: false, countMode: 'running' });
  assert.notEqual(all, running, 'the two modes draw different numbers');
});

test('the face carries no text but the number', () => {
  const svg = renderKey({ state: 'working', value: '2', spin: true });
  assert.equal(svg.match(/<text/g).length, 1);
  assert.match(svg, />2</);
  assert.ok(!/AGENTS|working|idle|blocked|no agents/.test(svg));
});

test('rendered SVG is well formed and escapes its text', () => {
  const svg = renderKey({ state: 'error', value: '<&>' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /&lt;&amp;&gt;/);
  assert.ok(!/[^&]&(?!(amp|lt|gt|quot|apos);)/.test(svg), 'no bare ampersands');
});

test('still faces draw a ring appropriate to their state', () => {
  // Blocked and error ring the whole circle; idle and empty show only the track.
  const strokes = (svg) => svg.match(/stroke="#[0-9a-f]{6}"/g) ?? [];
  assert.ok(renderKey({ state: 'blocked', value: '3' }).includes('stroke="#fbbf24"'));
  assert.ok(renderKey({ state: 'error', value: '!' }).includes('stroke="#f87171"'));
  // The card and the number are fills, so the ring's own track is the only
  // stroke a face that is not ringing has any business drawing.
  const TRACK = 'stroke="#242438"';
  assert.deepEqual(strokes(renderKey({ state: 'empty', value: '0' })), [TRACK]);
  assert.deepEqual(strokes(renderKey({ state: 'idle', value: '2' })), [TRACK]);
  assert.deepEqual(strokes(renderKey({ state: 'blocked', value: '3' })), [TRACK, 'stroke="#fbbf24"']);
});

test('the spinner is a partial arc that moves between frames', () => {
  const frames = ringFrames({ ok: true, total: 2, working: 2, blocked: 0, idle: 0 });
  assert.equal(frames.length, SPIN_PERIOD_MS / SPIN_FRAME_MS);
  assert.equal(new Set(frames).size, frames.length, 'every frame is distinct');

  const svg = renderKey({ state: 'working', value: '2', spin: true }, 0.25);
  assert.match(svg, /<path[^>]*stroke="#4ade80"/, 'an arc, not a full circle');
  assert.ok(!/<circle[^>]*stroke="#4ade80"/.test(svg));
});

test('the spinner completes exactly one turn over its frames', () => {
  const view = { state: 'working', value: '1', spin: true };
  // Phase 1 is a full revolution on from phase 0, so the two must be identical.
  assert.equal(renderKey(view, 0), renderKey(view, 1));
});

test('a still face renders as a single frame', () => {
  for (const summary of [
    { ok: true, total: 0, working: 0, blocked: 0, idle: 0 },
    { ok: true, total: 3, working: 1, blocked: 1, idle: 1 },
    { ok: false, error: 'timeout' },
  ]) {
    assert.equal(ringFrames(summary).length, 1);
  }
});

test('big counts shrink to stay inside the ring', () => {
  const sizeOf = (svg) => Number(svg.match(/font-size="(\d+)"/)[1]);
  assert.ok(sizeOf(renderKey({ state: 'idle', value: '999' })) <
            sizeOf(renderKey({ state: 'idle', value: '9' })));
});

/* ---------------------------------------------------------- settings ---- */

test('settings are clamped and defaulted', () => {
  assert.equal(normalize({ interval: 1 }).interval, 5);
  assert.equal(normalize({ interval: 99999 }).interval, 3600);
  assert.equal(normalize({ interval: 'nonsense' }).interval, 30);
  assert.equal(normalize({ scope: 'made-up' }).scope, 'all');
  assert.equal(normalize({}).countMode, 'all');
  assert.equal(normalize({ countMode: 'running' }).countMode, 'running');
  assert.equal(normalize({ countMode: 'made-up' }).countMode, 'all');
  assert.equal(normalize({ distro: '  Ubuntu  ' }).distro, 'Ubuntu');
  assert.equal(normalize(null).pressAction, 'focus');
  assert.equal(normalize({ pressAction: 'made-up' }).pressAction, 'focus');
  assert.equal(normalize({ pressAction: 'agentView' }).pressAction, 'agentView');
  assert.equal(normalize({}).speed, 'normal');
  assert.equal(normalize({ speed: 'ludicrous' }).speed, 'normal');
  assert.equal(normalize({ speed: 'slow' }).speed, 'slow');
  assert.equal(normalize({}).clawdAnimation, 'random');
  assert.equal(normalize({ clawdAnimation: 'breakdance' }).clawdAnimation, 'random');
  assert.equal(normalize({ clawdAnimation: 'scuttle' }).clawdAnimation, 'scuttle');
  assert.equal(normalize({ clawdAnimation: 'random' }).clawdAnimation, 'random');
});

test('a key saved under an old speed name keeps its pace', () => {
  // The names changed; what the user picked did not. Only 'crawl', 'brisk' and
  // 'frantic' can be migrated -- 'slow' is a name in both scales and means
  // something different in each, so it is read as the one that exists now.
  for (const [saved, expected] of [
    ['crawl', 'slow'],
    ['brisk', 'fast'],
    ['frantic', 'fast'],
  ]) {
    assert.equal(normalize({ speed: saved }).speed, expected, saved);
    assert.equal(speedFactor(normalize({ speed: saved }).speed), SPEEDS[expected]);
  }
});

test('transport auto resolves per platform', () => {
  assert.equal(resolveTransport(normalize({}), 'win32'), 'wsl');
  assert.equal(resolveTransport(normalize({}), 'darwin'), 'local');
  assert.equal(resolveTransport(normalize({ transport: 'local' }), 'win32'), 'local');
});

test('probe key ignores scope, since scope is applied after the probe', () => {
  assert.equal(
    probeKey(normalize({ scope: 'all', distro: 'Ubuntu' })),
    probeKey(normalize({ scope: 'bg', distro: 'Ubuntu' })),
  );
  assert.equal(
    probeKey(normalize({ countMode: 'all' })),
    probeKey(normalize({ countMode: 'running' })),
    'the count mode is a drawing choice, not a different reading',
  );
  assert.notEqual(probeKey(normalize({ distro: 'Ubuntu' })), probeKey(normalize({ distro: 'Debian' })));
});

/* -------------------------------------------------------------- ring look ---- */

test('the spinner covers a little under a third of the ring', () => {
  // Read the arc back out of the path: the chord between its endpoints fixes
  // the swept angle, so the length is checked rather than assumed.
  const svg = renderKey({ state: 'working', value: '2', spin: true }, 0);
  const [, x1, y1, , , , x2, y2] = svg
    .match(/M ([\d.]+) ([\d.]+) A ([\d.]+) ([\d.]+) 0 (\d) 1 ([\d.-]+) ([\d.-]+)/)
    .map(Number);
  const radius = 50;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  const turns = (2 * Math.asin(chord / (2 * radius))) / (Math.PI * 2);
  assert.ok(Math.abs(turns - 0.308) < 0.002, `swept ${turns.toFixed(3)} turns`);
});

test('thickness drives the stroke, and the default is the second-thinnest step up', () => {
  assert.equal(strokeFor(undefined), THICKNESS.normal);
  assert.equal(strokeFor('nonsense'), THICKNESS.normal);
  assert.equal(strokeFor('heavy'), THICKNESS.heavy);

  const strokeIn = (svg) => Number(svg.match(/stroke-width="([\d.]+)"[^>]*\/><circle|stroke-width="([\d.]+)"/)[1]);
  const thin = renderKey({ state: 'idle', value: '2' }, 0, { thickness: 'hairline' });
  const heavy = renderKey({ state: 'idle', value: '2' }, 0, { thickness: 'heavy' });
  assert.ok(thin.includes(`stroke-width="${THICKNESS.hairline}"`));
  assert.ok(heavy.includes(`stroke-width="${THICKNESS.heavy}"`));
  assert.ok(THICKNESS.hairline < THICKNESS.normal && THICKNESS.normal < THICKNESS.heavy);
});

test('the Claude mark clears the ring at every thickness', () => {
  const distance = Math.hypot(CORNER.x - CENTER, CORNER.y - CENTER);
  for (const stroke of Object.values(THICKNESS)) {
    const clearance = distance - CORNER.r - (50 + stroke / 2);
    assert.ok(clearance > 0, `stroke ${stroke} leaves ${clearance.toFixed(2)}px`);
  }
});

test('the mark is optional and changes nothing else', () => {
  const view = { state: 'working', value: '2', spin: true };
  const withMark = renderKey(view, 0.25, { showMark: true });
  const without = renderKey(view, 0.25, { showMark: false });
  assert.ok(withMark.includes('#d97757'));
  assert.ok(!without.includes('#d97757'));
  // Everything before the mark is byte-identical, so nothing else was resized
  // or moved to make room for it.
  const markStart = withMark.lastIndexOf('<path d="M', withMark.indexOf('fill="#d97757"'));
  assert.equal(without, `${withMark.slice(0, markStart)}</svg>`);
});

test('ring frames are cached per look, not shared across looks', () => {
  const summary = { ok: true, total: 2, working: 2, blocked: 0, idle: 0 };
  const normal = ringFrames(summary, { thickness: 'normal', showMark: true });
  const heavy = ringFrames(summary, { thickness: 'heavy', showMark: true });
  const bare = ringFrames(summary, { thickness: 'normal', showMark: false });
  assert.notEqual(normal[0], heavy[0]);
  assert.notEqual(normal[0], bare[0]);
  assert.equal(normal[0], ringFrames(summary, { thickness: 'normal', showMark: true })[0]);
});

/* ------------------------------------------------------------------ clawd ---- */

test('Clawd moves only while agents are working', () => {
  const working = { ok: true, total: 2, working: 1, blocked: 0, idle: 1 };
  const dancing = clawdView(working);
  assert.equal(dancing.state, 'working');
  assert.equal(dancing.sequence, ANIMATIONS[DEFAULT_ANIMATION].sequence, 'the wiggle by default');
  assert.equal(dancing.badge, null);
  // The setting picks the move; an unknown one falls back rather than freezing.
  assert.equal(clawdView(working, { clawdAnimation: 'jump' }).sequence, DANCE);
  assert.equal(
    clawdView(working, { clawdAnimation: 'breakdance' }).sequence,
    ANIMATIONS[DEFAULT_ANIMATION].sequence,
  );

  // Still means not progressing, the same rule as the ring key.
  const blocked = clawdView({ ok: true, total: 2, working: 1, blocked: 1, idle: 0 });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.sequence.length, 1);
  assert.equal(blocked.badge, '#fbbf24');

  assert.equal(clawdView({ ok: true, total: 0, working: 0, blocked: 0, idle: 0 }).state, 'empty');
  assert.equal(clawdView({ ok: true, total: 1, working: 0, blocked: 0, idle: 1 }).state, 'idle');
  assert.equal(clawdView({ ok: false, error: 'timeout' }).badge, '#f87171');
});

test("the jump is Claude Code's own sequence", () => {
  // crouch(2) + arms-up(3) + default(1), twice.
  assert.equal(DANCE.length, 12);
  assert.deepEqual(
    DANCE.map((frame) => frame.pose),
    [
      'default', 'default', 'arms-up', 'arms-up', 'arms-up', 'default',
      'default', 'default', 'arms-up', 'arms-up', 'arms-up', 'default',
    ],
  );
  // The puffs only show on the crouched frames.
  for (const frame of DANCE) {
    if (frame.poof) assert.ok(frame.offset > 0, 'a puff without a crouch');
  }
  assert.equal(CLAWD_FRAME_MS, 60, "Claude Code's frame interval");
});

test('clawdFrames yields the whole move, or one still frame', () => {
  const working = { ok: true, total: 1, working: 1, blocked: 0, idle: 0 };
  for (const [name, animation] of Object.entries(ANIMATIONS)) {
    assert.equal(
      clawdFrames(working, { animate: true, clawdAnimation: name }).length,
      animation.sequence.length,
      name,
    );
  }
  assert.equal(clawdFrames(working, { animate: false }).length, 1);
  assert.equal(clawdFrames({ ok: true, total: 0, working: 0, blocked: 0, idle: 0 }).length, 1);
  // Two moves must not share a cache entry, or a switch would show the old one.
  assert.notDeepEqual(
    clawdFrames(working, { animate: true, clawdAnimation: 'wiggle' }),
    clawdFrames(working, { animate: true, clawdAnimation: 'scuttle' }),
  );
});

test('pickRandomMove always lands on a real animation, and can dodge a repeat', () => {
  const names = new Set(Object.keys(ANIMATIONS));
  for (let i = 0; i < 50; i += 1) {
    assert.ok(names.has(pickRandomMove()));
  }
  for (const name of names) {
    for (let i = 0; i < 20; i += 1) {
      assert.notEqual(pickRandomMove(name), name);
    }
  }
});

test('every animation stays on the pixel grid and inside the card', () => {
  for (const [name, animation] of Object.entries(ANIMATIONS)) {
    assert.ok(animation.sequence.length > 1, `${name} needs more than one frame`);
    for (const frame of animation.sequence) {
      const svg = renderClawd(frame, { body: CLAWD_BODY });
      // The card's own two rects come first; the sprite follows.
      const rects = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)].slice(2);
      for (const [, x, , width] of rects) {
        assert.equal(Number(x) % 6, 0, `${name}: x=${x} off the grid`);
        assert.ok(Number(x) >= 3, `${name}: x=${x} past the card edge`);
        assert.ok(Number(x) + Number(width) <= 141, `${name}: x=${x} past the card edge`);
      }
    }
  }
});

test('speed scales every face, and never asks for an impossible frame rate', () => {
  assert.equal(speedFactor('made-up'), SPEEDS.normal, 'an unknown name runs at the default');
  // 'normal' stretches each face's authored pace rather than being it: the
  // sources these are taken from move quicker than a key on a desk should.
  assert.ok(SPEEDS.normal > 1, 'the default is a stretch, not a passthrough');
  assert.equal(clawdFrameMs({ clawdAnimation: 'jump' }), Math.round(CLAWD_FRAME_MS * SPEEDS.normal));
  assert.equal(spinFrameMs({}), Math.round(SPIN_FRAME_MS * SPEEDS.normal));

  for (const ms of [clawdFrameMs, spinFrameMs]) {
    assert.ok(ms({ speed: 'slow' }) > ms({ speed: 'normal' }), 'slow is slower');
    assert.ok(ms({ speed: 'fast' }) < ms({ speed: 'normal' }), 'fast is faster');
    for (const speed of Object.keys(SPEEDS)) assert.ok(ms({ speed }) >= 20, `${speed} too fast`);
  }
});

test('Clawd is drawn from block quadrants, in his own colour', () => {
  const svg = renderClawd({ pose: 'default', offset: 0, x: 0 }, { body: CLAWD_BODY });
  assert.ok(svg.includes(CLAWD_BODY), 'body colour');
  assert.ok(svg.includes('#000000'), 'the background that shapes his face');
  assert.ok(!svg.includes('<text'), 'no font is relied on');
  // Quadrants are 6 x 12, so every rect lands on the same half-cell grid --
  // not necessarily one rooted at the SVG's own origin, since Clawd's origin
  // is wherever centres him, but every rect the same fixed distance from it.
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)];
  assert.ok(rects.length > 20, `${rects.length} quadrant rects`);
  const sprite = rects.slice(2);
  const xMod = Number(sprite[0][1]) % 6;
  const yMod = Number(sprite[0][2]) % 12;
  for (const [, x, y] of sprite) {
    assert.equal(Number(x) % 6, xMod, `x=${x} off the grid`);
    assert.equal(Number(y) % 12, yMod, `y=${y} off the grid`);
  }
});

test('the poses actually differ from one another', () => {
  const poses = [
    'default',
    'look-left',
    'look-right',
    'arms-up',
    'peek-left',
    'peek-right',
    'claw-left',
    'claw-right',
  ];
  const drawn = poses.map((pose) => renderClawd({ pose, offset: 0, x: 0 }));
  assert.equal(new Set(drawn).size, poses.length);
});

test('a crouch drops Clawd by exactly one row and adds the puffs', () => {
  const up = renderClawd({ pose: 'default', offset: 0, x: 0 });
  const down = renderClawd({ pose: 'default', offset: 1, x: 0, poof: 'dot' });
  const firstSpriteY = (svg) => Number(svg.match(/<rect x="\d+" y="(\d+)" width="6"/)[1]);
  assert.equal(firstSpriteY(down) - firstSpriteY(up), 24, 'one cell height');
  assert.ok(down.includes('r="2.2"'), 'the puffs');
  assert.ok(!up.includes('r="2.2"'));
});

test('the Claude mark is a burst of twelve rays around a hub', () => {
  const mark = claudeMark(120, 24, 8);
  assert.equal((mark.match(/M /g) ?? []).length, 12);
  assert.match(mark, /<circle cx="120" cy="24"/);
  // Every point stays inside the mark's radius.
  for (const [, x, y] of mark.matchAll(/([\d.]+) ([\d.]+)/g)) {
    assert.ok(Math.hypot(Number(x) - 120, Number(y) - 24) <= 8.01, `${x},${y} outside`);
  }
});

/* ----------------------------------------------------------- finishing ---- */

/** A reading, as the watcher wants it: states by session, plus concluded jobs. */
const reading = (states, finished = []) => ({
  ok: true,
  agents: Object.entries(states).map(([sessionId, state]) => ({ sessionId, state })),
  finished,
});

test('the first reading only ever seeds the watcher', () => {
  const watcher = new FinishWatcher();
  // A deck starting up next to a pile of finished jobs is not an occasion.
  assert.equal(watcher.observe(reading({ s1: 'idle' }, ['s2'])), 0);
  assert.equal(watcher.observe(reading({ s1: 'idle' }, ['s2'])), 0, 'and nothing changed');
});

test('a finish is a session that stopped working, or a job that concluded', () => {
  const watcher = new FinishWatcher();
  watcher.observe(reading({ s1: 'working', s2: 'working', s3: 'blocked' }));
  assert.equal(
    watcher.observe(reading({ s1: 'idle', s2: 'working', s3: 'blocked' }, [])),
    1,
    'only s1 finished',
  );

  const jobs = new FinishWatcher();
  jobs.observe(reading({ s1: 'working' }));
  assert.equal(jobs.observe(reading({}, ['s1'])), 1, 'the job concluded');
  assert.equal(jobs.observe(reading({}, ['s1'])), 0, 'and it stays concluded, quietly');
});

test('nothing else counts as finishing', () => {
  const watcher = new FinishWatcher();
  watcher.observe(reading({ blockedOne: 'blocked', busy: 'working', gone: 'working' }));
  assert.equal(
    watcher.observe(reading({ blockedOne: 'idle', busy: 'working', fresh: 'idle' })),
    0,
    'giving up waiting, still working, and appearing out of nowhere are all not finishing',
  );
});

test('a session that vanishes never finished as far as anyone knows', () => {
  const watcher = new FinishWatcher();
  watcher.observe(reading({ s1: 'working' }));
  // A closed terminal, or a WSL distro that went away: it never said how it ended.
  assert.equal(watcher.observe(reading({})), 0);
});

test('a failed probe is not a reading, and does not end anything', () => {
  const watcher = new FinishWatcher();
  watcher.observe(reading({ s1: 'working' }));
  assert.equal(watcher.observe({ ok: false, error: 'wsl-asleep' }), 0);
  // The states it held on to are the ones from before the failure, so the
  // finish is still spotted when the reading comes back.
  assert.equal(watcher.observe(reading({ s1: 'idle' })), 1);
});

/* --------------------------------------------------------------- party ---- */

/** The frames of a burst, as SVG rather than as the data URIs the deck gets. */
const partySvgs = (settings = {}) =>
  partyFrames(settings).map((uri) =>
    Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8'),
  );

/** Every filled path in a frame, as [points, fill]. */
const paths = (svg) =>
  [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"\/>/g)].map(([, d, fill]) => [
    [...d.matchAll(/(?:M|L) (-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]),
    fill,
  ]);

const HORN_COLOURS = ['#f4b942', '#f87171'];
const isHorn = ([, fill]) => HORN_COLOURS.includes(fill);

test('the party lasts exactly as long as it says, however it is sliced', () => {
  const frames = partyFrames({});
  assert.equal(PARTY_MS, 2500);
  assert.equal(frames.length * PARTY_FRAME_MS, PARTY_MS);
  assert.equal(new Set(frames).size, frames.length, 'no frame is drawn twice');
});

test("the jump keeps the key's own speed, and the burst keeps its own length", () => {
  // A hop is a crouch that was not there on the frame before -- the puffs mark
  // one. Faster settings fit more of them into the same burst.
  const hops = (speed) => {
    let count = 0;
    let crouched = false;
    for (const svg of partySvgs({ speed })) {
      const now = svg.includes('#5c6070');
      if (now && !crouched) count += 1;
      crouched = now;
    }
    return count;
  };

  const bySpeed = Object.keys(SPEEDS).map(hops);
  for (let i = 1; i < bySpeed.length; i += 1) {
    // SPEEDS is ordered slowest first.
    assert.ok(bySpeed[i] > bySpeed[i - 1], `${bySpeed} is not ordered by speed`);
  }

  // What speed must not touch: the burst is the same length at every one of
  // them, because the key goes back to its real state when it ends.
  for (const speed of Object.keys(SPEEDS)) {
    assert.equal(partyFrames({ speed }).length * PARTY_FRAME_MS, PARTY_MS, speed);
  }
  // Which move the key is set to is not a speed: the party is always the jump.
  assert.deepEqual(partyFrames({ clawdAnimation: 'scuttle' }), partyFrames({}));
});

test('a key told not to animate still marks the moment, with one frame', () => {
  assert.equal(partyFrames({ animate: false }).length, 1);
  // Backgrounds, speeds and stillness must not share a cache entry.
  assert.notEqual(partyFrames({ background: 'blue' })[0], partyFrames({})[0]);
  assert.notEqual(partyFrames({ animate: false })[0], partyFrames({})[0]);
  assert.notDeepEqual(partyFrames({ speed: 'slow' }), partyFrames({ speed: 'fast' }));
  // A still frame has no pace to take from the setting.
  assert.deepEqual(partyFrames({ animate: false, speed: 'slow' }), partyFrames({ animate: false }));
});

test('the horn goes out and comes back, and stays inside the card', () => {
  const svgs = partySvgs();
  assert.ok(
    svgs.some((svg) => paths(svg).some(isHorn)),
    'the horn is blown',
  );
  assert.ok(
    svgs.some((svg) => svg.includes('stroke="#f4b942"')),
    'and rolled back up between blows',
  );

  for (const svg of svgs) {
    for (const [points] of paths(svg).filter(isHorn)) {
      for (const [x, y] of points) {
        assert.ok(x >= 3 && x <= 141, `horn x=${x} past the card edge`);
        assert.ok(y >= 3 && y <= 141, `horn y=${y} past the card edge`);
      }
    }
  }
});

test('the confetti rains down and is gone by the end', () => {
  const svgs = partySvgs();
  // Confetti falls in from above the key and leaves through the bottom, so only
  // its sideways drift is bounded -- and only loosely: a piece may clip an edge,
  // it just must not be drawn somewhere nobody can see it.
  const confetti = (svg) => paths(svg).filter((path) => !isHorn(path));
  const lowest = (svg) =>
    Math.max(...confetti(svg).flatMap(([points]) => points.map(([, y]) => y)), -20);

  assert.ok(lowest(svgs[3]) < lowest(svgs[10]), 'the rain comes down');
  assert.ok(lowest(svgs[10]) < lowest(svgs[20]), 'and keeps coming down');
  // Whatever is still in the air when the burst ends is at the very bottom, so
  // the key does not snap back to Clawd with confetti hanging over his head.
  const last = confetti(svgs[svgs.length - 1]).flatMap(([points]) => points.map(([, y]) => y));
  assert.ok(Math.min(...last) > 100, 'nothing left up top');

  for (const svg of svgs) {
    for (const [points] of confetti(svg)) {
      for (const [x] of points) assert.ok(x > -10 && x < 154, `a piece at x=${x} is off the key`);
    }
  }
});

/* ----------------------------------------------------------------- focus ---- */

test('focus.ps1 has exactly one substitution point, on the assignment', () => {
  // A second occurrence in a comment is what silently broke this once: the
  // non-global replace() patched the comment and left the assignment intact.
  const script = readFileSync(join(LIB, 'focus.ps1'), 'utf8');
  const hits = script.match(/__TARGETS__/g) ?? [];
  assert.equal(hits.length, 1, `${hits.length} placeholders`);
  assert.match(script, /^\$Targets = __TARGETS__$/m);
});

test('focus.ps1 reports a verdict on every path', () => {
  const script = readFileSync(join(LIB, 'focus.ps1'), 'utf8');
  // Success is judged by this line, not by PowerShell's exit code, which does
  // not survive reliably.
  assert.match(script, /Write-Output \("raised: "/);
  assert.match(script, /Write-Output \("failed: "/);
  assert.match(script, /Write-Output 'none'/);
});

test('nothing meant to be seen is spawned with windowsHide', () => {
  const launch = readFileSync(join(LIB, 'launch.js'), 'utf8');
  // windowsHide sets SW_HIDE; a terminal started that way never appears, and
  // Windows Terminal then serves later `wt new-tab` calls from that hidden
  // instance, so every subsequent launch vanishes into it too.
  assert.match(launch, /hideWindow = true/, 'hidden is the default for silent work');
  assert.match(
    launch,
    /firstThatStarts\([\s\S]{0,240}?\{ hideWindow: false \}/,
    'terminals are visible',
  );
});

test('on Windows itself, the window style says what is meant to be seen', () => {
  // The spawn is always a hidden PowerShell; what the user sees or does not see
  // is the style Start-Process gives the process it creates.
  const terminal = nativeWindowsStartScript(nativeWindowsTerminalArgs('claude agents'), 'Normal');
  assert.match(terminal, /-WindowStyle Normal/);
  assert.doesNotMatch(terminal, /Hidden/);

  const silent = nativeWindowsStartScript([['cmd.exe', '/s /c claude --bg x']], 'Hidden');
  assert.match(silent, /-WindowStyle Hidden/);

  // Success is judged by this line, not by PowerShell's exit code -- as in
  // focus.ps1, and for the same reason.
  assert.match(terminal, /Write-Output \('started: ' \+ \$attempt\.File\)/);
  assert.match(terminal, /Write-Output \('failed: ' \+ \$problem\)/);
});

test('a native Windows command line is never wrapped in another quote pair', () => {
  // cmd /s /c strips an outer pair and takes the rest verbatim, so leaving the
  // command unwrapped is what keeps its own quotes and its && intact.
  const command = 'cd /d "C:\\my repo" && "C:\\Users\\a b\\claude.exe" agents';
  const [[wtFile, wtArgs], [cmdFile, cmdArgs]] = nativeWindowsTerminalArgs(command);

  assert.equal(wtFile, 'wt.exe');
  assert.equal(wtArgs, `new-tab --title "Claude agents" -- cmd.exe /s /c ${command}`);
  assert.equal(cmdFile, 'cmd.exe');
  assert.equal(cmdArgs, `/s /c ${command}`);

  // Windows Terminal comes first, a bare console second.
  assert.match(
    nativeWindowsStartScript(nativeWindowsTerminalArgs(command), 'Normal'),
    /wt\.exe[\s\S]*cmd\.exe/,
  );

  // A semicolon would start a second wt tab, so only that line escapes it --
  // the bare cmd line must keep the character the user typed.
  const semi = nativeWindowsTerminalArgs('a & echo b; echo c');
  assert.ok(semi[0][1].endsWith('b\\; echo c'), semi[0][1]);
  assert.ok(semi[1][1].endsWith('b; echo c'), semi[1][1]);
});

test("a single quote in a command survives PowerShell's own quoting", () => {
  // The command is embedded in a single-quoted PowerShell string, so an
  // apostrophe -- in a folder name, say -- has to be doubled, or the script
  // stops parsing where the user's text begins.
  const script = nativeWindowsStartScript([['cmd.exe', 'cd /d "C:\\Bob\'s Repo"']], 'Hidden');
  assert.ok(script.includes(`Args = 'cd /d "C:\\Bob''s Repo"'`));
});

/* --------------------------------------------------------- usage bands ---- */

/** A believable reading, for the faces and the cache to chew on. */
const usageSnapshot = (over = {}) => ({
  session: { usedPercent: 42, resetAt: '2026-08-28T18:30:00.000Z' },
  weekly: { usedPercent: 68, resetAt: '2026-09-01T09:00:00.000Z' },
  status: 'ok',
  updatedAt: '2026-08-28T10:00:00.000Z',
  stale: false,
  thresholds: { warning: 70, critical: 90 },
  ...over,
});


test('a percentage falls in the band its thresholds put it in', () => {
  assert.equal(statusForPercent(0), 'ok');
  assert.equal(statusForPercent(69), 'ok');
  assert.equal(statusForPercent(70), 'warning');
  assert.equal(statusForPercent(89), 'warning');
  assert.equal(statusForPercent(90), 'critical');
  assert.equal(statusForPercent(99), 'critical');
  // 100 is its own band: spent is not merely critical.
  assert.equal(statusForPercent(100), 'limited');

  const strict = { warning: 30, critical: 50 };
  assert.equal(statusForPercent(31, strict), 'warning');
  assert.equal(statusForPercent(51, strict), 'critical');
});

test('the overall status is the worse window, and unknowns do not count', () => {
  const window = (usedPercent) => ({ usedPercent, resetAt: null });

  assert.equal(worstStatus(window(10), window(95)), 'critical');
  assert.equal(worstStatus(window(95), window(10)), 'critical');
  assert.equal(worstStatus(window(10), window(null)), 'ok');
  assert.equal(worstStatus(window(null), window(75)), 'warning');
  // Nothing known is not an alarm -- the caller decides if an error applies.
  assert.equal(worstStatus(window(null), window(null)), 'ok');
});

test('a raw response becomes a snapshot, and a broken one still does', () => {
  const snapshot = normalizeUsage({
    five_hour: { utilization: 42.4, resets_at: '2026-08-28T18:30:00.000Z' },
    seven_day: { utilization: 91.6, resets_at: '2026-09-01T09:00:00.000Z' },
  });

  assert.equal(snapshot.session.usedPercent, 42);
  assert.equal(snapshot.weekly.usedPercent, 92);
  assert.equal(snapshot.session.resetAt, '2026-08-28T18:30:00.000Z');
  assert.equal(snapshot.status, 'critical');
  assert.equal(snapshot.stale, false);

  // utilization is a percentage, not a fraction, and it is clamped either way.
  assert.equal(normalizeUsage({ five_hour: { utilization: 140 } }).session.usedPercent, 100);
  assert.equal(normalizeUsage({ five_hour: { utilization: -5 } }).session.usedPercent, 0);

  // The endpoint is unofficial: absent, null and nonsense fields all have to
  // land on null rather than throw.
  const empty = normalizeUsage({});
  assert.equal(empty.session.usedPercent, null);
  assert.equal(empty.weekly.resetAt, null);
  assert.equal(normalizeUsage({ five_hour: { utilization: 'lots' } }).session.usedPercent, null);
  assert.equal(normalizeUsage({ five_hour: null }).session.usedPercent, null);
});

/* ------------------------------------------------------ usage settings ---- */

test('usage settings are clamped, and the refresh floor is the rate limit', () => {
  const settings = normalizeUsageSettings({
    interval: 5,
    warning: 200,
    critical: -1,
    window: 'nonsense',
    background: 'chartreuse',
    credentialsPath: '  ',
  });

  // 5s would trip the endpoint's own throttle within a minute.
  assert.equal(settings.interval, MIN_INTERVAL);
  assert.equal(settings.warning, 100);
  // Critical can never sit below warning, or the bands would run backwards.
  assert.equal(settings.critical, 100);
  assert.equal(settings.window, 'session');
  assert.equal(settings.background, 'transparent');
  assert.equal(settings.credentialsPath, '');

  assert.equal(normalizeUsageSettings({ interval: 99999 }).interval, 3600);
  assert.equal(normalizeUsageSettings().interval, 120);
  assert.deepEqual(thresholdsFor(normalizeUsageSettings()), { warning: 70, critical: 90 });
});

test('the key defaults to a transparent background', () => {
  assert.equal(normalizeUsageSettings().background, 'transparent');
  const svg = renderBars(usageSnapshot(), { background: 'transparent' });
  assert.ok(!svg.includes('<rect width="144" height="144"'), 'no full-key fill');
  assert.ok(renderBars(usageSnapshot(), { background: 'blue' }).includes('<rect width="144" height="144"'));
});

/* --------------------------------------------------------- credentials ---- */

/** A home directory with nothing in it, so nothing reads the real account. */
async function withEmptyHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'claudify-home-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'FAKE_ACCESS_TOKEN',
    refreshToken: 'FAKE_REFRESH_TOKEN',
    expiresAt: 7258118400000,
  },
});

test('credentials come from the file the CLI wrote', async () => {
  await withEmptyHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), CREDENTIALS);

    const creds = await readCredentials(undefined, { home, platform: 'linux' });
    assert.equal(creds.accessToken, 'FAKE_ACCESS_TOKEN');
    assert.equal(creds.refreshToken, 'FAKE_REFRESH_TOKEN');
    assert.equal(creds.expiresAt, 7258118400000);
  });
});

test('on macOS a missing file falls through to the Keychain', async () => {
  await withEmptyHome(async (home) => {
    let asked = 0;
    const creds = await readCredentials(undefined, {
      home,
      platform: 'darwin',
      readBlob: async () => {
        asked += 1;
        return CREDENTIALS;
      },
    });
    assert.equal(asked, 1);
    assert.equal(creds.accessToken, 'FAKE_ACCESS_TOKEN');
  });
});

test('everywhere else a missing file is simply missing', async () => {
  await withEmptyHome(async (home) => {
    let asked = 0;
    await assert.rejects(
      readCredentials(undefined, {
        home,
        platform: 'win32',
        readBlob: async () => {
          asked += 1;
          return CREDENTIALS;
        },
      }),
      (err) => err.status === 'auth',
    );
    assert.equal(asked, 0, 'the Keychain is a macOS answer only');
  });
});

test('naming a credentials file opts out of the Keychain', async () => {
  await withEmptyHome(async (home) => {
    let asked = 0;
    // A path the user typed is taken at face value: a missing file there is a
    // mistake worth reporting, not a reason to read the real account instead.
    await assert.rejects(
      readCredentials(join(home, 'nowhere.json'), {
        home,
        platform: 'darwin',
        readBlob: async () => {
          asked += 1;
          return CREDENTIALS;
        },
      }),
      (err) => err.status === 'auth',
    );
    assert.equal(asked, 0);
  });
});

test('an empty Keychain, or credentials without a token, mean log in again', async () => {
  await withEmptyHome(async (home) => {
    await assert.rejects(
      readCredentials(undefined, { home, platform: 'darwin', readBlob: async () => null }),
      (err) => err.status === 'auth',
    );

    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
    await assert.rejects(
      readCredentials(undefined, { home, platform: 'linux' }),
      (err) => err.status === 'auth',
    );

    await writeFile(join(home, '.claude', '.credentials.json'), 'not json');
    await assert.rejects(
      readCredentials(undefined, { home, platform: 'linux' }),
      (err) => err.status === 'auth',
    );
  });
});

test('no failure message ever carries token material', async () => {
  await withEmptyHome(async (home) => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":1}}');

    const err = await readCredentials(undefined, { home, platform: 'linux' }).catch((e) => e);
    // These strings reach Stream Deck's log and the settings panel.
    assert.ok(!/FAKE|token":|Bearer/.test(err.message), err.message);
  });
});

test('an expiry within the skew counts as expired, and a missing one does not', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now + 5 * 60000, undefined, now), false);
  assert.equal(isExpired(now + 30000, undefined, now), true, 'inside the 60s skew');
  assert.equal(isExpired(now - 1, undefined, now), true);
  // Unknown expiry: let the endpoint decide, and let its 401 drive the refresh.
  assert.equal(isExpired(null, undefined, now), false);
});

test('a credentials path expands ~ but is otherwise taken as given', () => {
  assert.equal(resolveCredentialsPath('', '/home/x'), join('/home/x', '.claude', '.credentials.json'));
  assert.equal(resolveCredentialsPath('~/creds.json', '/home/x'), join('/home/x', 'creds.json'));
  assert.equal(resolveCredentialsPath('  ', '/home/x'), join('/home/x', '.claude', '.credentials.json'));
});

test('a credentials path pasted with quotes (Windows "Copy as path") is unwrapped', () => {
  assert.equal(
    resolveCredentialsPath('"\\\\wsl.localhost\\Ubuntu\\home\\x\\.claude\\.credentials.json"', '/home/x'),
    resolveCredentialsPath('\\\\wsl.localhost\\Ubuntu\\home\\x\\.claude\\.credentials.json', '/home/x'),
  );
  assert.equal(
    resolveCredentialsPath("'/home/x/creds.json'", '/home/x'),
    resolveCredentialsPath('/home/x/creds.json', '/home/x'),
  );
  // Quotes around nothing mean nothing was named.
  assert.equal(resolveCredentialsPath('""', '/home/x'), join('/home/x', '.claude', '.credentials.json'));
  // A lone quote is not a wrapped path; leave it to fail loudly as-is.
  assert.equal(resolveCredentialsPath('"', '/home/x'), resolve('"'));
});

/* --------------------------------------------------------- usage cache ---- */

/** A clock the test drives by hand, so backoffs can be waited out instantly. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test('a reading inside its TTL costs nothing, and a press skips the wait', async () => {
  const clock = fakeClock();
  const cache = new UsageCache({ ttlMs: 60000, now: clock.now, forceMinIntervalMs: 0 });
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return usageSnapshot({ session: { usedPercent: fetches, resetAt: null } });
  };

  await cache.get(fetcher);
  await cache.get(fetcher);
  assert.equal(fetches, 1, 'the second key shares the first key’s reading');

  await cache.get(fetcher, { force: true });
  assert.equal(fetches, 2, 'a press goes and looks');

  clock.advance(60001);
  await cache.get(fetcher);
  assert.equal(fetches, 3, 'and the TTL runs out on its own');
});

test('keys asking at once share one request', async () => {
  const cache = new UsageCache({ ttlMs: 60000 });
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const fetcher = async () => {
    fetches += 1;
    await gate;
    return usageSnapshot();
  };

  const all = Promise.all([cache.get(fetcher), cache.get(fetcher), cache.get(fetcher)]);
  release();
  await all;
  assert.equal(fetches, 1);
});

test('leaning on the key cannot turn into a flood of requests', async () => {
  const clock = fakeClock();
  const cache = new UsageCache({ ttlMs: 60000, forceMinIntervalMs: 10000, now: clock.now });
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return usageSnapshot();
  };

  await cache.get(fetcher, { force: true });
  await cache.get(fetcher, { force: true });
  await cache.get(fetcher, { force: true });
  assert.equal(fetches, 1, 'presses inside the window re-serve what is held');

  clock.advance(10001);
  await cache.get(fetcher, { force: true });
  assert.equal(fetches, 2);
});

test('a failed refresh keeps the last good numbers and says they are old', async () => {
  const clock = fakeClock();
  const cache = new UsageCache({ ttlMs: 1000, now: clock.now, forceMinIntervalMs: 0 });

  const good = await cache.get(async () => usageSnapshot());
  assert.equal(good.stale, false);

  clock.advance(2000);
  const stale = await cache.get(async () => {
    throw authRequired('Claude credentials not found.');
  });
  // Real numbers an hour old beat an error face: the limits move slowly, and
  // the face carries a marker saying the reading is stale.
  assert.equal(stale.stale, true);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.staleReason, 'error');
  assert.equal(stale.session.usedPercent, 42);
});

test('with nothing held yet, a failure is the face', async () => {
  const cache = new UsageCache({ ttlMs: 1000 });
  const snapshot = await cache.get(async () => {
    throw authRequired('Claude credentials not found.');
  });
  assert.equal(snapshot.status, 'auth');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.session.usedPercent, null);
});

test('a rate limit stops the network, and Retry-After: 0 does not restart it', async () => {
  const clock = fakeClock();
  const cache = new UsageCache({ ttlMs: 1000, now: clock.now, forceMinIntervalMs: 0 });
  let fetches = 0;

  const throttled = async () => {
    fetches += 1;
    // This endpoint really does answer 0 while still throttling.
    throw rateLimited('Claude usage rate limit reached.', 0);
  };

  await cache.get(throttled);
  assert.equal(fetches, 1);

  clock.advance(30000);
  await cache.get(throttled, { force: true });
  assert.equal(fetches, 1, 'still inside the floor, even for a press');

  clock.advance(MIN_RATE_LIMIT_BACKOFF_MS);
  await cache.get(throttled, { force: true });
  assert.equal(fetches, 2);
});

/* ------------------------------------------------------ usage pipeline ---- */

const fakeCredentials = { accessToken: 'A', refreshToken: 'R', expiresAt: null };

test('a spent token is refreshed before the request goes out', async () => {
  const cache = new UsageCache({ ttlMs: 0 });
  let refreshes = 0;
  let usedToken = '';

  await getUsage({
    cache,
    deps: {
      readCredentials: async () => ({ ...fakeCredentials, expiresAt: 500 }),
      refreshToken: async () => {
        refreshes += 1;
        return { accessToken: 'FRESH' };
      },
      fetchUsage: async (token) => {
        usedToken = token;
        return { five_hour: { utilization: 10 } };
      },
      now: () => 1000,
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(usedToken, 'FRESH');
});

test('a 401 buys one refresh and one retry, and a second 401 is the answer', async () => {
  const attempt = async (failures) => {
    let calls = 0;
    return getUsage({
      cache: new UsageCache({ ttlMs: 0 }),
      deps: {
        readCredentials: async () => fakeCredentials,
        refreshToken: async () => ({ accessToken: 'FRESH' }),
        fetchUsage: async () => {
          calls += 1;
          if (calls <= failures) throw new UnauthorizedError();
          return { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
        },
        now: () => 1000,
      },
    });
  };

  // The token can go stale between the expiry check and the request.
  assert.equal((await attempt(1)).status, 'ok');
  // Twice is not a race, it is a verdict.
  assert.equal((await attempt(2)).status, 'auth');
});

test('the pipeline never throws -- a key always has something to draw', async () => {
  const snapshot = await getUsage({
    cache: new UsageCache({ ttlMs: 0 }),
    deps: {
      readCredentials: async () => {
        throw new Error('something unforeseen');
      },
      now: () => 1000,
    },
  });
  assert.equal(snapshot.status, 'error');
});

/* --------------------------------------------------------- WSL-hosted ---- */

/** A path Windows resolves through the distro's own file server. */
const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\creds.json';

test('a UNC path into a distro is recognised, and a host path is not', () => {
  assert.equal(isWslPath(WSL_PATH), true);
  assert.equal(isWslPath('\\\\wsl$\\Ubuntu\\home\\me\\creds.json'), true, 'older builds');
  assert.equal(isWslPath('//wsl.localhost/Ubuntu/home/me/creds.json'), true, 'Windows takes these too');
  assert.equal(isWslPath('  \\\\WSL.LOCALHOST\\Ubuntu\\x  '), true);

  assert.equal(isWslPath('C:\\Users\\me\\creds.json'), false);
  assert.equal(isWslPath('/home/me/creds.json'), false);
  // A share that merely sounds alike is somebody else's server, not a distro.
  assert.equal(isWslPath('\\\\wslbackup\\share\\creds.json'), false);
  assert.equal(isWslPath(''), false);
  assert.equal(isWslPath(undefined), false);
});

test('a passive poll does not open a file that lives inside a stopped distro', async () => {
  let reads = 0;
  const snapshot = await getUsage({
    credentialsPath: WSL_PATH,
    allowWake: false,
    cache: new UsageCache({ ttlMs: 0 }),
    deps: {
      isWslVmAsleep: async () => true,
      readCredentials: async () => {
        reads += 1;
        return fakeCredentials;
      },
      now: () => 1000,
    },
  });

  // Opening the path is what would start WSL, so the test is that nothing did.
  assert.equal(reads, 0);
  assert.equal(snapshot.status, 'wslAsleep');
});

test('a press reads it anyway, and a running VM never stands in the way', async () => {
  const attempt = (options, asleep) =>
    getUsage({
      credentialsPath: WSL_PATH,
      cache: new UsageCache({ ttlMs: 0 }),
      deps: {
        isWslVmAsleep: async () => asleep,
        readCredentials: async () => fakeCredentials,
        fetchUsage: async () => ({ five_hour: { utilization: 10 } }),
        now: () => 1000,
      },
      ...options,
    });

  // A key press is a request: it is allowed to start the distro.
  assert.equal((await attempt({ force: true }, true)).status, 'ok');
  // WSL already up: there is nothing left to protect.
  assert.equal((await attempt({ allowWake: false }, false)).status, 'ok');
});

test('an auto-detected path never pays for a WSL check', async () => {
  let checks = 0;
  const snapshot = await getUsage({
    allowWake: false,
    cache: new UsageCache({ ttlMs: 0 }),
    deps: {
      isWslVmAsleep: async () => {
        checks += 1;
        return true;
      },
      readCredentials: async () => fakeCredentials,
      fetchUsage: async () => ({ five_hour: { utilization: 10 } }),
      now: () => 1000,
    },
  });

  assert.equal(checks, 0, 'the default path is on the host, never in a distro');
  assert.equal(snapshot.status, 'ok');
});

test('a skipped poll keeps the last good numbers and costs the next one nothing', async () => {
  const clock = fakeClock();
  const cache = new UsageCache({ ttlMs: 60000, now: clock.now });
  const deps = {
    isWslVmAsleep: async () => true,
    readCredentials: async () => fakeCredentials,
    fetchUsage: async () => ({ five_hour: { utilization: 42 } }),
    now: clock.now,
  };

  assert.equal((await getUsage({ credentialsPath: WSL_PATH, cache, deps })).session.usedPercent, 42);

  clock.advance(120000);
  const skipped = await getUsage({ credentialsPath: WSL_PATH, allowWake: false, cache, deps });
  assert.equal(skipped.status, 'stale');
  assert.equal(skipped.staleReason, 'wslAsleep');
  assert.equal(skipped.session.usedPercent, 42, 'real numbers stand until better ones arrive');

  // The skip was not an attempt, so the press right behind it -- with no time
  // passing at all -- is not held off by the force throttle.
  let fetches = 0;
  await getUsage({
    credentialsPath: WSL_PATH,
    force: true,
    cache,
    deps: {
      ...deps,
      fetchUsage: async () => {
        fetches += 1;
        return { five_hour: { utilization: 43 } };
      },
    },
  });
  assert.equal(fetches, 1);
});

test('a skipped poll and a spent login dim the key rather than replacing it', () => {
  // Neither is a broken reading, so neither takes the key over with a message:
  // the face keeps its shape and goes grey. See palette.js's isDimmed.
  for (const status of ['wslAsleep', 'auth']) {
    const snapshot = usageSnapshot({
      status,
      session: { usedPercent: null, resetAt: null },
      weekly: { usedPercent: null, resetAt: null },
    });

    for (const svg of [renderBars(snapshot), renderGauge(snapshot, { window: 'session' })]) {
      assert.match(svg, />--</, `${status}: the face keeps its shape, with nothing in it`);
      assert.ok(!svg.includes('#f87171'), `${status}: and does not cry error red`);
      assert.ok(!/>(WSL|Login|No Data)</.test(svg), `${status}: no message takes the key over`);
    }
  }
});

test('a Retry-After is read in seconds, and nonsense is ignored', () => {
  assert.equal(parseRetryAfterMs('300'), 300000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'), undefined);
  assert.equal(parseRetryAfterMs('-5'), undefined);
});

/* --------------------------------------------------------- usage faces ---- */

const rects = (svg) => [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);

test('the two-window face draws a bar per window, filled to its percentage', () => {
  const svg = renderBars(usageSnapshot());

  assert.ok(svg.startsWith('<svg'), 'well formed');
  assert.ok(svg.endsWith('</svg>'));
  assert.match(svg, />5H</);
  assert.match(svg, />7D</);
  assert.match(svg, />42%</);
  assert.match(svg, />68%</);

  // Track plus fill for each window, and the fill is proportional: the bar is
  // 120 wide, so 42% is 50 and 68% is 82.
  const widths = rects(svg)
    .map((rect) => rect.match(/width="(\d+)"/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.ok(widths.includes(50), 'the 5H fill');
  assert.ok(widths.includes(82), 'the 7D fill');
});

test('a bar is coloured by its own window, not by the worst of the two', () => {
  const svg = renderBars(
    usageSnapshot({
      session: { usedPercent: 5, resetAt: null },
      weekly: { usedPercent: 95, resetAt: null },
      status: 'critical',
    }),
  );
  // Green for the quiet window even while the other one is orange -- one spent
  // limit should not make the untouched one look spent too.
  assert.match(svg, /#4ade80/);
  assert.match(svg, /#fb923c/);
});

test('an empty window shows a dash, and 0% draws no stub of colour', () => {
  const svg = renderBars(
    usageSnapshot({ session: { usedPercent: null, resetAt: null }, weekly: { usedPercent: 0, resetAt: null } }),
  );
  assert.match(svg, />--</);
  // A rounded rect of zero width still paints its own corners.
  assert.ok(!svg.includes('width="0"'), 'no zero-width fill');
});

test('nothing in either window is an error, not a pair of empty bars', () => {
  const svg = renderBars(
    usageSnapshot({
      session: { usedPercent: null, resetAt: null },
      weekly: { usedPercent: null, resetAt: null },
    }),
  );
  assert.match(svg, />No Data</);
});

test('the failures each say what to do about them', () => {
  assert.match(renderBars(usageSnapshot({ status: 'rateLimited' })), />Rate</);
  assert.match(renderBars(usageSnapshot({ status: 'error' })), />Error</);
});

test('numbers that are no longer being confirmed are dimmed, not dotted', () => {
  const stale = usageSnapshot({ status: 'stale', stale: true, staleReason: 'wslAsleep' });

  const bars = renderBars(stale);
  assert.match(bars, />42%</, 'the last known numbers still show');
  assert.ok(!bars.includes('#4ade80'), 'but not in their band colour');
  assert.match(bars, /#4b5563/, 'they are greyed out instead');
  assert.ok(!bars.includes('<circle'), 'and nothing is flagged in the corner');

  const gauge = renderGauge(stale, { window: 'session', resetInfo: 'countdown' });
  assert.match(gauge, />42</);
  assert.ok(!gauge.includes('#4ade80'));

  assert.match(renderBars(usageSnapshot()), /#4ade80/, 'a fresh reading keeps its colours');
});

test('the ring fills three quarters of a turn at 100%, and is a stub at 1%', () => {
  const sweep = (svg) => {
    // Two arcs: the track, then the fill. Their end points say how far each ran.
    const paths = [...svg.matchAll(/<path d="M ([\d.]+) ([\d.]+) A/g)];
    return paths.length;
  };
  const full = renderGauge(usageSnapshot({ session: { usedPercent: 100, resetAt: null } }), {
    window: 'session',
    resetInfo: 'none',
  });
  assert.equal(sweep(full), 2, 'track and fill');
  assert.match(full, />100</);

  // At 0 the fill is omitted rather than drawn as a dot of colour.
  const empty = renderGauge(usageSnapshot({ session: { usedPercent: 0, resetAt: null } }), {
    window: 'session',
    resetInfo: 'none',
  });
  assert.equal(sweep(empty), 1, 'the track alone');
});

test('the single-window face shows the window it was pointed at', () => {
  const options = { window: 'weekly', resetInfo: 'none' };
  const svg = renderGauge(usageSnapshot(), options);
  assert.match(svg, />68</, 'the weekly number');
  assert.match(svg, />7D</);
  assert.ok(!svg.includes('>42<'), 'and not the session one');
});

test('the reset line follows the setting, and the ring makes room for it', () => {
  const now = new Date('2026-08-28T10:00:00.000Z');
  const at = (resetInfo) =>
    renderGauge(usageSnapshot(), { window: 'session', resetInfo, dateFormat: 'isoShort' }, now);

  assert.ok(!/<text[^>]*font-size="13"/.test(at('none')), 'nothing under the ring');
  assert.equal((at('dateTime').match(/font-size="13"/g) || []).length, 1);
  assert.equal((at('both').match(/font-size="13"/g) || []).length, 2);
  assert.match(at('countdown'), />in 8h 30m</);

  // Two lines push the ring up so the face stays optically centred.
  const centre = (svg) => Number(svg.match(/<path d="M [\d.]+ ([\d.]+) A/)[1]);
  assert.ok(centre(at('both')) < centre(at('none')));
});

/* ---------------------------------------------------------- reset time ---- */

test('a reset time reads the way the setting asks', () => {
  // Built from parts rather than a literal, so the test does not depend on the
  // timezone the suite happens to run in.
  const at = new Date(2026, 4, 31, 14, 6);
  const iso = at.toISOString();

  assert.equal(formatResetTime(iso, 'dayMonth'), '31 May, 14:06');
  assert.equal(formatResetTime(iso, 'isoShort'), '05/31 14:06');
  assert.equal(formatResetTime(iso, 'weekday'), 'Sun 14:06');

  // A missing or unparseable timestamp shows nothing, never 'Invalid Date'.
  assert.equal(formatResetTime(null), null);
  assert.equal(formatResetTime('whenever'), null);
});

test('a countdown coarsens as it lengthens, and bottoms out at now', () => {
  const now = new Date('2026-08-28T10:00:00.000Z');
  const inMs = (ms) => new Date(now.getTime() + ms).toISOString();

  assert.equal(formatCountdown(inMs(42 * 60000), now), '42m');
  assert.equal(formatCountdown(inMs(7 * 3600000 + 58 * 60000), now), '7h 58m');
  assert.equal(formatCountdown(inMs(2 * 86400000 + 3 * 3600000), now), '2d 3h');
  assert.equal(formatCountdown(inMs(-1), now), 'now');
  assert.equal(formatCountdown(null, now), null);
});

/* ------------------------------------------------- the native probe ---- */

/**
 * A stand-in for the claude CLI: prints what it was told to on stdout, exits
 * with the code it was told to, and records its own argv so the test can check
 * what the probe actually asked for.
 */
async function fakeClaude(dir, { stdout = '[]', exitCode = 0, name = 'claude' } = {}) {
  const path = join(dir, name);
  await writeFile(
    path,
    ['#!/bin/sh', `printf '%s\\n' "$@" > "${join(dir, 'argv')}"`, `cat <<'EOF'`, stdout, 'EOF', `exit ${exitCode}`].join('\n'),
    { mode: 0o755 },
  );
  return path;
}

/** A probe run that never touches the developer's own PATH or home directory. */
const runNative = (settings, home, over = {}) =>
  probeNative({ claudeBin: '', cwdFilter: '', ...settings }, () => {}, {
    platform: 'linux',
    home,
    env: { PATH: '' },
    ...over,
  });

test('the native probe reads agents and job files without a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    const bin = await fakeClaude(dir, {
      stdout: JSON.stringify([agent({ sessionId: 'a' }), agent({ sessionId: 'b', status: 'idle' })]),
    });
    await mkdir(join(dir, '.claude', 'jobs', 'one'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'jobs', 'one', 'state.json'),
      JSON.stringify({ sessionId: 'b', tempo: 'blocked' }),
    );

    const snapshot = await runNative({ claudeBin: bin }, dir);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.claude, bin);
    assert.equal(snapshot.agents.length, 2);
    assert.deepEqual(snapshot.jobs, [{ sessionId: 'b', tempo: 'blocked' }]);

    // The whole point: the same summary the shell script's output produces.
    const summary = summarize(snapshot);
    assert.equal(summary.total, 2);
    assert.equal(summary.blocked, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a job file caught mid-write costs only that job, natively too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    const bin = await fakeClaude(dir, { stdout: JSON.stringify([agent()]) });
    await mkdir(join(dir, '.claude', 'jobs', 'half'), { recursive: true });
    await writeFile(join(dir, '.claude', 'jobs', 'half', 'state.json'), '{"sessionId":');
    await mkdir(join(dir, '.claude', 'jobs', 'whole'), { recursive: true });
    await writeFile(join(dir, '.claude', 'jobs', 'whole', 'state.json'), '{"sessionId":"s1"}');

    const snapshot = await runNative({ claudeBin: bin }, dir);
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.jobs, [{ sessionId: 's1' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cwd filter reaches the CLI as --cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    const bin = await fakeClaude(dir);
    await runNative({ claudeBin: bin, cwdFilter: '/repo/with a space' }, dir);
    const argv = readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
    assert.deepEqual(argv, ['agents', '--json', '--cwd', '/repo/with a space']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit binary that is not there is an error, not a search', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    // A real claude sits in this very directory, and auto-detect would find it.
    const real = await fakeClaude(dir);
    const snapshot = await runNative({ claudeBin: join(dir, 'nope') }, dir, {
      env: { PATH: dir },
    });
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.error, 'claude-not-found');
    assert.match(snapshot.detail, /nope/);
    // Proof the fallback was available and deliberately not taken.
    assert.equal((await runNative({}, dir, { env: { PATH: dir } })).claude, real);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto-detect walks PATH, then the standard install locations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    await mkdir(join(dir, '.local', 'bin'), { recursive: true });
    const installed = await fakeClaude(join(dir, '.local', 'bin'));

    // Nothing on PATH: the home-directory candidate has to carry it.
    assert.equal((await runNative({}, dir)).claude, installed);

    // On PATH: that wins, as `command -v` does in the script.
    const onPath = await fakeClaude(dir);
    assert.equal((await runNative({}, dir, { env: { PATH: dir } })).claude, onPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing installed anywhere says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    const snapshot = await runNative({}, dir);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.error, 'claude-not-found');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing CLI reports the exit code, and junk output reports itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    const failing = await fakeClaude(dir, { stdout: '', exitCode: 3 });
    const failed = await runNative({ claudeBin: failing }, dir);
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'agents-command-failed');
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.claude, failing);

    const junk = join(dir, 'junk');
    await writeFile(junk, '#!/bin/sh\necho not json at all\n', { mode: 0o755 });
    const bad = await runNative({ claudeBin: junk }, dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'bad-response');
    assert.match(bad.detail, /not json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Windows path typed without its extension is still meant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    // Pretending to be Windows, where the extension decides which file is the
    // program and stat is the only runnable check there is.
    const exe = await fakeClaude(dir, { name: 'claude.exe' });
    const snapshot = await runNative({ claudeBin: join(dir, 'claude') }, dir, {
      platform: 'win32',
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.claude, exe);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .exe anywhere beats a .cmd anywhere, so no shell is needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    await mkdir(join(dir, 'shim'), { recursive: true });
    await mkdir(join(dir, 'real'), { recursive: true });
    await fakeClaude(join(dir, 'shim'), { name: 'claude.cmd' });
    const exe = await fakeClaude(join(dir, 'real'), { name: 'claude.exe' });

    const snapshot = await runNative({}, dir, {
      platform: 'win32',
      // The .cmd's directory comes first on PATH and still loses: the search is
      // extension-major precisely so a batch shim is the last resort.
      env: { PATH: [join(dir, 'shim'), join(dir, 'real')].join(':') },
    });
    assert.equal(snapshot.claude, exe);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a batch shim goes through a shell with its arguments intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudify-native-'));
  try {
    // Only a .cmd to be had, so the probe has to build a command line rather
    // than spawn the file. Running that line through this machine's own shell
    // is not cmd.exe, but it does prove the line parses and that a path with a
    // space in it survives being quoted into it.
    const cmd = await fakeClaude(dir, { name: 'claude.cmd' });
    const snapshot = await runNative({ claudeBin: cmd, cwdFilter: 'C:\\my repo' }, dir, {
      platform: 'win32',
    });
    assert.equal(snapshot.ok, true);
    assert.deepEqual(readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n'), [
      'agents',
      '--json',
      '--cwd',
      'C:\\my repo',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- host-shaped commands ---- */

test('the agent view is written in the shell language of its host', () => {
  const wsl = normalize({ transport: 'wsl', cwdFilter: "/repo/o'brien" });
  assert.equal(
    agentViewCommand(wsl, '/home/me/.local/bin/claude', 'win32'),
    `cd '/repo/o'\\''brien' 2>/dev/null; '/home/me/.local/bin/claude' agents`,
  );

  const native = normalize({ transport: 'local', cwdFilter: 'C:\\Code\\my repo' });
  assert.equal(
    agentViewCommand(native, 'C:\\Users\\me\\.local\\bin\\claude.exe', 'win32'),
    'cd /d "C:\\Code\\my repo" && "C:\\Users\\me\\.local\\bin\\claude.exe" agents',
  );

  // Same settings on a Mac are POSIX again: it is the host that decides.
  assert.equal(agentViewCommand(normalize({ transport: 'local' }), 'claude', 'darwin'), `'claude' agents`);
});

test('error hints name the host they are about', () => {
  assert.match(errorHint('host-unreachable', '', 'wsl'), /WSL is installed/);
  assert.match(errorHint('claude-not-found', '', 'wsl'), /inside WSL/);
  assert.match(errorHint('claude-not-found', '', 'local'), /on this machine/);
  // An unknown or absent transport still says something useful.
  assert.match(errorHint('claude-not-found', ''), /Claude binary/);
  assert.match(errorHint('bad-response', 'oops', 'local'), /^The probe returned.*\(oops\)$/);
});
