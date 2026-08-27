#!/usr/bin/env node
/**
 * A stand-in for the Stream Deck app, so the plugin can be exercised without a
 * deck plugged in.
 *
 * Starts a WebSocket server, launches bin/plugin.js against it, replays the
 * handshake plus a willAppear, and prints everything the plugin sends back.
 * Any key image is decoded and written to build/preview/ as an .svg.
 *
 *   node scripts/simulate.mjs [--seconds 8] [--press] [--setting key=value]...
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PLUGIN_DIR = join(ROOT, 'com.claudify.agents.sdPlugin');
const PREVIEW_DIR = join(ROOT, 'build', 'preview');

// ws is CommonJS: the default export is the WebSocket class itself, with the
// server constructors hung off it.
const wsModule = await import(join(PLUGIN_DIR, 'bin', 'node_modules', 'ws', 'index.js'));
const WebSocketServer = (wsModule.default ?? wsModule).WebSocketServer;

function parseFlags(argv) {
  const flags = { seconds: 8, press: false, action: 'count', settings: {} };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seconds') flags.seconds = Number(argv[++i]);
    else if (argv[i] === '--press') flags.press = true;
    else if (argv[i] === '--action') flags.action = argv[++i];
    else if (argv[i] === '--setting') {
      const [key, ...rest] = String(argv[++i]).split('=');
      const value = rest.join('=');
      flags.settings[key] = value === 'true' ? true : value === 'false' ? false : value;
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
// The simulator runs on the same box as Claude, so skip the WSL hop by default.
const settings = { transport: 'local', ...flags.settings };

mkdirSync(PREVIEW_DIR, { recursive: true });

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((ready) => server.once('listening', ready));
const port = server.address().port;

const CONTEXT = 'simulated-key';
const ACTION = `com.claudify.agents.${flags.action}`;
// A spinning key pushes a frame every 80ms, so only distinct images are worth
// keeping -- that leaves exactly one revolution's worth on disk.
const seen = new Map();
let images = 0;

server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());

    if (message.event === 'registerPlugin') {
      console.log(`< registerPlugin uuid=${message.uuid}`);
      socket.send(
        JSON.stringify({
          event: 'willAppear',
          action: ACTION,
          context: CONTEXT,
          device: 'simulated-device',
          payload: { settings, coordinates: { column: 0, row: 0 }, isInMultiAction: false },
        }),
      );
      if (flags.press) {
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({ event: 'keyDown', action: ACTION, context: CONTEXT, payload: { settings } }),
            ),
          1500,
        );
      }
      return;
    }

    if (message.event === 'setImage') {
      images += 1;
      const uri = message.payload?.image ?? '';
      const base64 = uri.slice(uri.indexOf(',') + 1);
      const digest = createHash('sha1').update(base64).digest('hex');
      if (seen.has(digest)) return;

      const file = join(PREVIEW_DIR, `frame-${String(seen.size + 1).padStart(2, '0')}.svg`);
      seen.set(digest, file);
      writeFileSync(file, Buffer.from(base64, 'base64'));
      console.log(`< setImage -> ${file}`);
      return;
    }

    if (message.event === 'sendToPropertyInspector') {
      console.log(`< sendToPropertyInspector ${JSON.stringify(message.payload)}`);
      return;
    }

    console.log(`< ${message.event} ${JSON.stringify(message.payload ?? {})}`);
  });
});

const child = spawn(
  process.execPath,
  [
    join(PLUGIN_DIR, 'bin', 'plugin.js'),
    '-port',
    String(port),
    '-pluginUUID',
    'simulated-plugin',
    '-registerEvent',
    'registerPlugin',
    '-info',
    JSON.stringify({ application: { platform: process.platform, version: 'simulated' } }),
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

console.log(`simulator listening on ${port} as ${ACTION}, settings ${JSON.stringify(settings)}`);

setTimeout(() => {
  child.kill();
  server.close();
  console.log(`\n${images} setImage call(s), ${seen.size} distinct frame(s) in ${PREVIEW_DIR}`);
  process.exit(0);
}, flags.seconds * 1000);
