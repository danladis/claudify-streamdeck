/** Defaults for a freshly-dropped key. */
export const DEFAULTS = {
  /** 'auto' picks wsl on Windows, local elsewhere. */
  transport: 'auto',
  /** WSL distribution name; empty means "the default distro". */
  distro: '',
  /** Explicit path to the claude binary; empty means auto-detect. */
  claudeBin: '',
  /** Only count sessions started under this directory; empty means all. */
  cwdFilter: '',
  /** 'all' | 'bg' | 'interactive' */
  scope: 'all',
  /** What the number on the ring key means: see COUNT_MODES. */
  countMode: 'all',
  /** Seconds between refreshes. */
  interval: 30,
  /** Spin the ring, or set Clawd moving, while agents are working. */
  animate: true,
  /** How fast either face animates: see SPEEDS. */
  speed: 'normal',
  /** Which move Clawd makes on the mascot key: see ANIMATIONS in clawd.js. */
  clawdAnimation: 'random',
  /**
   * Let Clawd throw a party -- horn and confetti, for PARTY_MS -- each time an
   * agent finishes its work. Mascot key only; the ring has nowhere to put it.
   */
  celebrate: true,
  /** Ring stroke weight: see THICKNESS in render.js. */
  thickness: 'normal',
  /** Show the Claude mark in the top-right corner of the ring key. */
  showMark: true,
  /** Key background, shared by both faces: see BACKGROUNDS in canvas.js. */
  background: 'transparent',
  /** 'focus' | 'agentView' | 'refresh' | 'custom' */
  pressAction: 'focus',
  /** Shell command for pressAction 'custom', run on the Claude-side host. */
  customCommand: '',
  /** Show the custom command in a terminal window instead of running it silently. */
  customInTerminal: true,
};

/**
 * Animation speed, as a multiplier on each face's own frame interval. Higher is
 * slower: a face's base pace is what its author picked, and this stretches or
 * squeezes it.
 *
 * 'normal' is not 1, and that is the point: every face was written at the pace
 * its own source moves at -- Claude Code's 60ms jump, a 1.2s revolution -- and
 * on a key, sitting on a desk in the corner of your eye, that reads as
 * agitated. The default stretches all of it, and the three settings are one
 * step either side of that.
 */
export const SPEEDS = {
  slow: 2.6,
  normal: 1.6,
  // A nudge rather than a different animal: 1.6 / 1.23 is 30% more frames a
  // second than 'normal', which is enough to read as livelier without the key
  // turning into something that pulls your eye off what you were doing.
  fast: 1.23,
};

export const speedFactor = (name) => SPEEDS[name] ?? SPEEDS.normal;

/**
 * Speeds that used to have other names, so a key saved under one keeps the pace
 * it was set to instead of silently falling back to the default. 'slow' is
 * deliberately absent: it is a live name now, and there is no telling an old
 * saved 'slow' from one picked today -- so the name wins and that one key gets
 * slower.
 */
const RENAMED_SPEEDS = { crawl: 'slow', brisk: 'fast', frantic: 'fast' };

/**
 * Clawd's moves, named here so settings can be validated without importing the
 * drawing code. clawd.js owns what each one looks like. 'random' isn't a move
 * of its own -- it tells plugin.js to pick a fresh one each time Clawd starts.
 */
const CLAWD_ANIMATIONS = new Set(['wiggle', 'scuttle', 'shimmy', 'wave', 'jump', 'random']);

const TRANSPORTS = new Set(['auto', 'wsl', 'local']);
const SCOPES = new Set(['all', 'bg', 'interactive']);

/**
 * What the ring key's number counts.
 *
 *   all      every session in scope, idle ones included -- the default, and
 *            the only honest answer to "how many Claude sessions are open".
 *   running  only the sessions that are not idle: working, plus the ones
 *            parked waiting on you. A session you have finished with but left
 *            open is not doing anything, and this mode does not count it.
 *
 * Only the ring key draws a number, so this setting does nothing on the mascot.
 */
const COUNT_MODES = new Set(['all', 'running']);
const PRESS_ACTIONS = new Set(['focus', 'agentView', 'refresh', 'custom']);
const THICKNESSES = new Set(['hairline', 'thin', 'normal', 'thick', 'heavy']);
const BACKGROUNDS = new Set(['blue', 'gray', 'transparent']);

const str = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback);
const oneOf = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

/** Coerce whatever the Property Inspector saved into a complete, valid config. */
export function normalize(raw) {
  const settings = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const interval = Number(settings.interval);

  return {
    transport: oneOf(settings.transport, TRANSPORTS, DEFAULTS.transport),
    distro: str(settings.distro, DEFAULTS.distro),
    claudeBin: str(settings.claudeBin, DEFAULTS.claudeBin),
    cwdFilter: str(settings.cwdFilter, DEFAULTS.cwdFilter),
    scope: oneOf(settings.scope, SCOPES, DEFAULTS.scope),
    countMode: oneOf(settings.countMode, COUNT_MODES, DEFAULTS.countMode),
    // Under 5s just hammers the CLI for no benefit; over an hour is
    // indistinguishable from "off".
    interval: Number.isFinite(interval)
      ? Math.min(3600, Math.max(5, Math.round(interval)))
      : DEFAULTS.interval,
    animate: settings.animate !== false,
    speed: oneOf(
      RENAMED_SPEEDS[settings.speed] ?? settings.speed,
      new Set(Object.keys(SPEEDS)),
      DEFAULTS.speed,
    ),
    clawdAnimation: oneOf(settings.clawdAnimation, CLAWD_ANIMATIONS, DEFAULTS.clawdAnimation),
    celebrate: settings.celebrate !== false,
    thickness: oneOf(settings.thickness, THICKNESSES, DEFAULTS.thickness),
    showMark: settings.showMark !== false,
    background: oneOf(settings.background, BACKGROUNDS, DEFAULTS.background),
    pressAction: oneOf(settings.pressAction, PRESS_ACTIONS, DEFAULTS.pressAction),
    customCommand: str(settings.customCommand, DEFAULTS.customCommand),
    customInTerminal: settings.customInTerminal !== false,
  };
}

/** Which host we actually talk to, once 'auto' is resolved. */
export function resolveTransport(settings, platform = process.platform) {
  if (settings.transport !== 'auto') return settings.transport;
  return platform === 'win32' ? 'wsl' : 'local';
}

/**
 * Two keys sharing this signature produce identical probe results, so a single
 * run can satisfy both.
 */
export function probeKey(settings) {
  return [
    resolveTransport(settings),
    settings.distro,
    settings.claudeBin,
    settings.cwdFilter,
  ].join(' ');
}
