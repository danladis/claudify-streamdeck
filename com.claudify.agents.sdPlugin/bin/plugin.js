import { StreamDeckClient } from './lib/protocol.js';
import { normalize, probeKey, resolveTransport } from './lib/settings.js';
import { probe } from './lib/probe.js';
import { summarize, errorHint } from './lib/classify.js';
import { ringFrames, spinFrameMs } from './lib/render.js';
import { clawdFrames, clawdFrameMs, pickRandomMove } from './lib/clawd.js';
import { agentViewCommand, focusTerminal, openInTerminal, runDetached } from './lib/launch.js';

/**
 * The two keys differ only in what they draw: both poll the same way, classify
 * the same way, and press the same way.
 */
const FACES = {
  'com.claudify.agents.count': { frames: ringFrames, frameMs: spinFrameMs },
  'com.claudify.agents.mascot': { frames: clawdFrames, frameMs: clawdFrameMs },
};

const DEFAULT_ACTION = 'com.claudify.agents.count';

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
    const frames = this.face.frames(summary, settings);
    // Keep the spinner where it is across a poll: only a change in frame count
    // means a different kind of face, and only then should it jump to the start.
    if (this.#frames?.length !== frames.length) this.#frameIndex = 0;
    this.#frames = frames;

    sd.setImage(this.context, frames[this.#frameIndex % frames.length]);

    // A change of speed or of animation changes the interval, and setInterval
    // will not take a new one -- so the timer is replaced rather than kept.
    const frameMs = this.face.frameMs(settings);
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

const keys = new Map();

sd.on('willAppear', ({ context, action, payload }) => {
  keys.get(context)?.destroy();
  keys.set(context, new AgentKey(context, action, payload?.settings));
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
  if (payload?.command === 'refresh') keys.get(context)?.refresh();
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
