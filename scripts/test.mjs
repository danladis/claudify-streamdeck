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
const { summarize } = await import(join(LIB, 'classify.js'));
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
const { claudeMark } = await import(join(LIB, 'claudemark.js'));
const { readFileSync } = await import('node:fs');
const { CENTER, CORNER } = await import(join(LIB, 'canvas.js'));
const { normalize, probeKey, resolveTransport, SPEEDS, speedFactor } = await import(
  join(LIB, 'settings.js'),
);

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

/* ---------------------------------------------------------- classify ---- */

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
  const strokes = (svg) => svg.match(/stroke="#[0-9a-f]{6}"/g);
  assert.ok(renderKey({ state: 'blocked', value: '3' }).includes('stroke="#fbbf24"'));
  assert.ok(renderKey({ state: 'error', value: '!' }).includes('stroke="#f87171"'));
  assert.equal(strokes(renderKey({ state: 'empty', value: '0' })).length, 2, 'card edge + track only');
  assert.equal(strokes(renderKey({ state: 'idle', value: '2' })).length, 2);
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
  assert.equal(normalize({ distro: '  Ubuntu  ' }).distro, 'Ubuntu');
  assert.equal(normalize(null).pressAction, 'focus');
  assert.equal(normalize({ pressAction: 'made-up' }).pressAction, 'focus');
  assert.equal(normalize({ pressAction: 'agentView' }).pressAction, 'agentView');
  assert.equal(normalize({}).speed, 'normal');
  assert.equal(normalize({ speed: 'ludicrous' }).speed, 'normal');
  assert.equal(normalize({ speed: 'crawl' }).speed, 'crawl');
  assert.equal(normalize({}).clawdAnimation, 'wiggle');
  assert.equal(normalize({ clawdAnimation: 'breakdance' }).clawdAnimation, 'wiggle');
  assert.equal(normalize({ clawdAnimation: 'scuttle' }).clawdAnimation, 'scuttle');
  assert.equal(normalize({ clawdAnimation: 'random' }).clawdAnimation, 'random');
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
  assert.equal(speedFactor('normal'), 1);
  assert.equal(speedFactor('made-up'), 1);
  assert.equal(clawdFrameMs({ clawdAnimation: 'jump' }), CLAWD_FRAME_MS);
  assert.equal(spinFrameMs({}), SPIN_FRAME_MS);

  for (const ms of [clawdFrameMs, spinFrameMs]) {
    assert.ok(ms({ speed: 'crawl' }) > ms({ speed: 'normal' }), 'crawl is slower');
    assert.ok(ms({ speed: 'frantic' }) < ms({ speed: 'normal' }), 'frantic is faster');
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

/* ----------------------------------------------------------------- focus ---- */

test('focus.ps1 has exactly one substitution point, on the assignment', () => {
  // A second occurrence in a comment is what silently broke this once: the
  // non-global replace() patched the comment and left the assignment intact.
  const script = readFileSync(join(LIB, 'focus.ps1'), 'utf8');
  const hits = script.match(/__NAMES__/g) ?? [];
  assert.equal(hits.length, 1, `${hits.length} placeholders`);
  assert.match(script, /^\$Names = __NAMES__$/m);
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
  assert.match(launch, /firstThatStarts\(candidates, \{ hideWindow: false \}\)/, 'terminals are visible');
});
