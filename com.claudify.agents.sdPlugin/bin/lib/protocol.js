import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Thin wrapper over the Stream Deck plugin WebSocket protocol (SDK v2).
 *
 * Stream Deck launches the plugin with -port/-pluginUUID/-registerEvent/-info,
 * expects a registration frame, then speaks JSON both ways. Every inbound
 * message is re-emitted under its `event` name.
 */
export class StreamDeckClient extends EventEmitter {
  #ws = null;
  #queue = [];

  constructor({ port, uuid, registerEvent, info }) {
    super();
    this.port = port;
    this.uuid = uuid;
    this.registerEvent = registerEvent;
    this.info = info;
  }

  connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.#ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ event: this.registerEvent, uuid: this.uuid }));
      for (const payload of this.#queue.splice(0)) ws.send(payload);
      this.emit('connected');
    });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message?.event) this.emit(message.event, message);
      this.emit('message', message);
    });

    // Stream Deck closing the socket means the plugin was disabled or the app
    // is shutting down. Either way our lifetime is over.
    ws.on('close', () => this.emit('disconnected'));
    ws.on('error', (err) => this.emit('socketError', err));
    return this;
  }

  send(message) {
    const payload = JSON.stringify(message);
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(payload);
    else this.#queue.push(payload);
  }

  setImage(context, image, { target = 0, state } = {}) {
    this.send({
      event: 'setImage',
      context,
      payload: { image, target, ...(state != null ? { state } : {}) },
    });
  }

  setTitle(context, title, { target = 0 } = {}) {
    this.send({ event: 'setTitle', context, payload: { title, target } });
  }

  setSettings(context, settings) {
    this.send({ event: 'setSettings', context, payload: settings });
  }

  getSettings(context) {
    this.send({ event: 'getSettings', context });
  }

  sendToPropertyInspector(context, action, payload) {
    this.send({ event: 'sendToPropertyInspector', context, action, payload });
  }

  showAlert(context) {
    this.send({ event: 'showAlert', context });
  }

  showOk(context) {
    this.send({ event: 'showOk', context });
  }

  log(message) {
    this.send({ event: 'logMessage', payload: { message: String(message) } });
  }
}
