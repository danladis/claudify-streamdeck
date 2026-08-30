import { StreamDeckClient } from './lib/protocol.js';
import { normalize, probeKey, resolveTransport } from './lib/settings.js';
import { probe } from './lib/probe.js';
import { summarize, errorHint } from './lib/classify.js';
import { ringFrames, spinFrameMs } from './lib/render.js';
import { clawdFrames, clawdFrameMs, pickRandomMove } from './lib/clawd.js';
import { FinishWatcher } from './lib/finished.js';
import { partyFrames, PARTY_FRAME_MS, PARTY_MS } from './lib/party.js';
import { agentViewCommand, focusTerminal, openInTerminal, runDetached } from './lib/launch.js';
import { barsFrames } from './lib/usage/bars.js';
import { gaugeFrames } from './lib/usage/gauge.js';
import { getUsage } from './lib/usage/provider.js';
import { normalize as normalizeUsage, thresholdsFor } from './lib/usage/settings.js';

/**
 * The two keys differ only in what they draw: both poll the same way, classify
 * the same way, and press the same way.
 *
 * `party` is the exception: a face may also have something it does for a moment
 * when an agent finishes, in front of whatever it was drawing. Only Clawd does
 * -- a ring that broke into confetti would stop being a gauge.
 */
const FACES = {
  'com.claudify.agents.count': { frames: ringFrames, frameMs: spinFrameMs },
  'com.claudify.agents.mascot': {
    frames: clawdFrames,
    frameMs: clawdFrameMs,
    party: { frames: partyFrames, frameMs: PARTY_FRAME_MS, ms: PARTY_MS },
  },
};

const DEFAULT_ACTION = 'com.claudify.agents.count';

/**
 * The usage keys are a different animal: they read Claude's own rate-limit
 * endpoint rather than probing for sessions, so they get their own key class.
 * Both faces are still just frames, which is why the drawing side looks the
 * same as above.
 */
const USAGE_FACES = {
  'com.claudify.agents.usage': barsFrames,
  'com.claudify.agents.usage-window': gaugeFrames,
};

/** Stream Deck passes its handshake as `-flag value` pairs. */
function parseLaunchArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('-')) args[argv[i].replace(/^-+/, '')] = argv[i + 1];
  }
  return args;
}

const launch = parseLaunchArgs(process.argv.slice(2));

let info = {};
try {
  info = JSON.parse(launch.info ?? '{}');
} catch {
  info = {};
}

const sd = new StreamDeckClient({
  port: launch.port,
  uuid: launch.pluginUUID,
  registerEvent: launch.registerEvent,
  info,
});

/** One key on the deck: its settings, its refresh timer, its last reading. */
class AgentKey {
  #timer = null;
  #destroyed = false;
  #generation = 0;
  #frames = null;
  #frameIndex = 0;
  #spinTimer = null;
  #frameMs = 0;
  #resolvedMove = null;
  #lastMove = null;
  #finishes = new FinishWatcher();
  #partyTimer = null;
  #partying = false;

  constructor(context, action, rawSettings) {
    this.context = context;
    this.action = FACES[action] ? action : DEFAULT_ACTION;
    this.face = FACES[this.action];
    this.settings = normalize(rawSettings);
    this.summary = null;
    this.claudeBin = '';
    // The key merely appearing -- dropped on the deck, a page switch, Stream
    // Deck itself relaunching -- is not a request; it must not wake WSL. See
    // probe()'s allowWake.
    this.refresh({ allowWake: false });
  }

  applySettings(rawSettings) {
    const next = normalize(rawSettings);
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    if (changed) this.refresh();
  }

  destroy() {
    this.#destroyed = true;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = null;
    clearTimeout(this.#partyTimer);
    this.#partyTimer = null;
    this.#partying = false;
    this.#stopSpinning();
  }

  #schedule() {
    if (this.#destroyed) return;
    clearTimeout(this.#timer);
    // A timer tick is passive, not a request: it must not be the reason a
    // stopped WSL distro starts back up. See probe()'s allowWake.
    this.#timer = setTimeout(() => this.refresh({ allowWake: false }), this.settings.interval * 1000);
    // A pending refresh should never be the reason the process stays alive.
    this.#timer.unref?.();
  }

  async refresh({ allowWake = true } = {}) {
    if (this.#destroyed) return;
    clearTimeout(this.#timer);

    // Settings can change mid-probe; stamp the run so a stale answer is dropped.
    this.#generation += 1;
    const generation = this.#generation;
    const settings = this.settings;

    const response = await probe(settings, probeKey(settings), { allowWake, log: (msg) => sd.log(msg) });
    if (this.#destroyed || generation !== this.#generation) return;

    const summary = summarize(response, { scope: settings.scope });
    if (summary.ok) this.claudeBin = summary.claude || this.claudeBin;

    this.summary = summary;
    this.render();
    this.pushToInspector();
    this.#schedule();

    // Only a face with a party has any use for the answer, and only when the
    // setting is on -- so the watcher is left unread otherwise, and switching
    // the setting back on starts from a fresh reading instead of firing over
    // everything that finished while nobody was looking.
    if (this.face.party && settings.celebrate) {
      const finished = this.#finishes.observe(summary);
      if (finished > 0) {
        sd.log(`[claude-agents] ${finished} agent(s) finished -- confetti`);
        this.#celebrate();
      }
    }
  }

  /**
   * A burst of confetti, then straight back to whatever the key was
   * showing. Nothing about the key's actual state changes here: the burst is
   * drawn in front of it, and the next render after it ends picks up the
   * current reading -- which by then may well have moved on again.
   */
  #celebrate() {
    if (this.#destroyed) return;

    clearTimeout(this.#partyTimer);
    this.#partying = true;
    // Start of the burst, at the burst's own pace: both the frame it is on and
    // the timer stepping through them belong to the face it is replacing.
    this.#frameIndex = 0;
    this.#stopSpinning();
    this.render();

    this.#partyTimer = setTimeout(() => {
      this.#partyTimer = null;
      this.#partying = false;
      this.#frameIndex = 0;
      this.#stopSpinning();
      this.render();
    }, this.face.party.ms);
    this.#partyTimer.unref?.();
  }

  /**
   * 'random' isn't a move clawd.js knows how to draw -- it means "pick one".
   * The pick is made here, once per spell of working, so the sequence and its
   * frame interval always agree and Clawd doesn't switch moves mid-dance.
   */
  #settingsForFace() {
    if (this.settings.clawdAnimation !== 'random') {
      this.#lastMove = null;
      return this.settings;
    }
    if (!(this.summary?.working > 0)) {
      // Idle between spells of work: forget the move so the next one is a
      // fresh pick, but remember what it was so that pick can't repeat it.
      if (this.#resolvedMove) this.#lastMove = this.#resolvedMove;
      this.#resolvedMove = null;
      return this.settings;
    }
    if (!this.#resolvedMove) this.#resolvedMove = pickRandomMove(this.#lastMove);
    return { ...this.settings, clawdAnimation: this.#resolvedMove };
  }

  render() {
    const summary = this.summary;
    if (!summary) return;

    const settings = this.#settingsForFace();
    // A poll landing mid-burst must not cut the party short: while it runs it
    // is what the key draws, whatever the reading underneath it now says.
    const party = this.#partying ? this.face.party : null;
    const frames = party ? party.frames(settings) : this.face.frames(summary, settings);
    // Keep the spinner where it is across a poll: only a change in frame count
    // means a different kind of face, and only then should it jump to the start.
    if (this.#frames?.length !== frames.length) this.#frameIndex = 0;
    this.#frames = frames;

    sd.setImage(this.context, frames[this.#frameIndex % frames.length]);

    // A change of speed or of animation changes the interval, and setInterval
    // will not take a new one -- so the timer is replaced rather than kept.
    const frameMs = party ? party.frameMs : this.face.frameMs(settings);
    if (frameMs !== this.#frameMs) this.#stopSpinning();
    this.#frameMs = frameMs;

    if (frames.length > 1 && this.settings.animate) this.#startSpinning();
    else this.#stopSpinning();
  }

  #startSpinning() {
    if (this.#spinTimer || this.#destroyed) return;
    this.#spinTimer = setInterval(() => {
      this.#frameIndex = (this.#frameIndex + 1) % this.#frames.length;
      sd.setImage(this.context, this.#frames[this.#frameIndex]);
    }, this.#frameMs);
    this.#spinTimer.unref?.();
  }

  #stopSpinning() {
    clearInterval(this.#spinTimer);
    this.#spinTimer = null;
  }

  pushToInspector() {
    const summary = this.summary;
    if (!summary) return;

    sd.sendToPropertyInspector(
      this.context,
      this.action,
      summary.ok
        ? {
            event: 'status',
            ok: true,
            total: summary.total,
            working: summary.working,
            blocked: summary.blocked,
            idle: summary.idle,
            claude: summary.claude,
            transport: resolveTransport(this.settings),
            agents: summary.agents.map((agent) => ({
              name: agent.name ?? '',
              cwd: agent.cwd ?? '',
              kind: agent.kind ?? '',
              state: agent.state,
              needs: agent.needs ?? '',
            })),
          }
        : {
            event: 'status',
            ok: false,
            error: summary.error,
            hint: errorHint(summary.error, summary.detail),
            transport: resolveTransport(this.settings),
          },
    );
  }

  /**
   * Session names, the ones most worth looking at first -- the order
   * focusTerminal should try them in when hunting for the right window.
   */
  #sessionNames() {
    const agents = this.summary?.ok ? this.summary.agents : [];
    const rank = { blocked: 0, working: 1, idle: 2 };
    return [...agents]
      .sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3))
      .map((agent) => agent.name)
      .filter(Boolean);
  }

  async press() {
    const { pressAction, customCommand } = this.settings;
    const names = this.#sessionNames();

    if (pressAction === 'focus') {
      const result = await focusTerminal(this.settings, names);
      if (!result.ok) {
        sd.showAlert(this.context);
        sd.log(`[claude-agents] could not raise a terminal: ${result.detail}`);
      } else {
        sd.log(`[claude-agents] ${result.detail}`);
      }
    } else if (pressAction === 'custom' && customCommand) {
      const result = this.settings.customInTerminal === false
        ? await runDetached(this.settings, customCommand)
        : await openInTerminal(this.settings, customCommand, names);
      if (!result.ok) {
        sd.showAlert(this.context);
        sd.log(`[claude-agents] custom command failed: ${result.detail}`);
      }
    } else if (pressAction === 'agentView') {
      const result = await openInTerminal(
        this.settings,
        agentViewCommand(this.settings, this.claudeBin),
        names,
      );
      if (!result.ok) {
        sd.showAlert(this.context);
        sd.log(`[claude-agents] could not open a terminal: ${result.detail}`);
      }
    }

    // Every press refreshes, whatever else it does.
    this.refresh();
  }
}

/**
 * One usage key: how much of a Claude rate-limit window is spent.
 *
 * Unlike an agent key there is nothing local to probe -- the numbers come from
 * Claude's own usage endpoint, behind a cache that every usage key shares. The
 * cache, not this class, decides whether a tick costs a request.
 */
class UsageKey {
  #timer = null;
  #destroyed = false;
  #generation = 0;

  constructor(context, action, rawSettings) {
    this.context = context;
    this.action = action;
    this.frames = USAGE_FACES[action] ?? barsFrames;
    this.settings = normalizeUsage(rawSettings);
    this.snapshot = null;
    // As on the agent keys: a key merely appearing is not a request, so it
    // must not be what starts a stopped WSL distro. See getUsage's allowWake.
    this.refresh({ allowWake: false });
  }

  applySettings(rawSettings) {
    const next = normalizeUsage(rawSettings);
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    // Even an unchanged tick has to redraw here: the thresholds, the window and
    // the date format all live in the face, not in the reading.
    if (changed) this.refresh();
  }

  destroy() {
    this.#destroyed = true;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * How long until the next redraw. Never longer than a minute when a countdown
   * is on screen, so 'in 3h 12m' does not sit there being wrong -- redrawing is
   * free, and the cache keeps the extra ticks off the network.
   */
  #tickMs() {
    const showsCountdown =
      this.action === 'com.claudify.agents.usage-window' &&
      (this.settings.resetInfo === 'countdown' || this.settings.resetInfo === 'both');
    const seconds = showsCountdown ? Math.min(this.settings.interval, 60) : this.settings.interval;
    return seconds * 1000;
  }

  #schedule() {
    if (this.#destroyed) return;
    clearTimeout(this.#timer);
    // A timer tick is passive too -- see the constructor.
    this.#timer = setTimeout(() => this.refresh({ allowWake: false }), this.#tickMs());
    // A pending refresh should never be the reason the process stays alive.
    this.#timer.unref?.();
  }

  async refresh({ force = false, allowWake = true } = {}) {
    if (this.#destroyed) return;
    clearTimeout(this.#timer);

    this.#generation += 1;
    const generation = this.#generation;
    const settings = this.settings;

    const snapshot = await getUsage({
      credentialsPath: settings.credentialsPath || undefined,
      thresholds: thresholdsFor(settings),
      ttlMs: settings.interval * 1000,
      force,
      allowWake,
      log: (message) => sd.log(message),
    });
    if (this.#destroyed || generation !== this.#generation) return;

    this.snapshot = snapshot;
    sd.log(`[claude-usage] status=${snapshot.status} stale=${snapshot.stale}`);
    this.render();
    this.pushToInspector();
    this.#schedule();
  }

  render() {
    if (!this.snapshot) return;
    sd.setImage(this.context, this.frames(this.snapshot, this.settings)[0]);
  }

  pushToInspector() {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    sd.sendToPropertyInspector(this.context, this.action, {
      event: 'usage',
      status: snapshot.status,
      stale: snapshot.stale,
      staleReason: snapshot.staleReason ?? '',
      session: snapshot.session,
      weekly: snapshot.weekly,
      updatedAt: snapshot.updatedAt,
      // Already sanitised: see the invariant in usage/errors.js.
      error: snapshot.errorMessage ?? '',
    });
  }

  /** A press is the one thing allowed to skip the cache's TTL. */
  press() {
    this.refresh({ force: true });
  }
}

const keys = new Map();

sd.on('willAppear', ({ context, action, payload }) => {
  keys.get(context)?.destroy();
  const Key = USAGE_FACES[action] ? UsageKey : AgentKey;
  keys.set(context, new Key(context, action, payload?.settings));
});

sd.on('willDisappear', ({ context }) => {
  keys.get(context)?.destroy();
  keys.delete(context);
});

sd.on('didReceiveSettings', ({ context, payload }) => {
  keys.get(context)?.applySettings(payload?.settings);
});

sd.on('keyDown', ({ context }) => {
  keys.get(context)?.press();
});

sd.on('propertyInspectorDidAppear', ({ context }) => {
  const key = keys.get(context);
  if (!key) return;
  key.pushToInspector();
  // Opening the settings panel is not a request for a fresh check either --
  // the panel's own "Refresh" button (sendToPlugin below) is. Otherwise every
  // glance at a key's settings would be enough to wake WSL.
  key.refresh({ allowWake: false });
});

sd.on('sendToPlugin', ({ context, payload }) => {
  // The panel's Refresh button is a request, so it is allowed to wake WSL.
  // force is the usage keys' word for "skip the TTL"; an agent key has no TTL
  // to skip and ignores it.
  if (payload?.command === 'refresh') {
    keys.get(context)?.refresh({ force: true, allowWake: true });
  }
});

sd.on('socketError', (err) => {
  process.stderr.write(`[claude-agents] socket error: ${err?.message}\n`);
});

sd.on('disconnected', () => process.exit(0));

process.on('uncaughtException', (err) => {
  sd.log(`[claude-agents] uncaught: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (err) => {
  sd.log(`[claude-agents] unhandled rejection: ${err?.stack ?? err}`);
});

sd.connect();
