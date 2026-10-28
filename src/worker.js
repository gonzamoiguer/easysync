import { DurableObject } from 'cloudflare:workers';
import { newState, apply } from './room-logic.js';

// Static files in /public are served by Workers Static Assets before this
// worker runs, so the worker only sees /ws/<CODE> upgrades (and 404s).
const ROOM_PATH = /^\/ws\/([A-HJKMNP-Z2-9]{4})$/;
const EXPIRE_MS = 7 * 24 * 3600 * 1000;

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(ROOM_PATH);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
};

// One Durable Object per room. Uses the WebSocket Hibernation API so idle
// connections cost nothing; keepalives ("k") are answered by the runtime
// without waking the object.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('k', 'k'));
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('s')) ?? null;
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const now = Date.now();
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', a: m.a, s: now }));
      return;
    }
    if (m.t === 'hello') return this.hello(ws, m);

    const me = ws.deserializeAttachment();
    if (!me || !this.s) return;
    if (apply(this.s, m, me.host, now)) {
      await this.ctx.storage.put('s', this.s);
      this.broadcast({ t: 'state', s: this.s });
    }
  }

  async hello(ws, m) {
    const id = String(m.id || '').slice(0, 40);
    if (!id) return ws.close(1008, 'bad hello');
    if (m.host) {
      if (!this.s) {
        this.s = newState(id);
        await this.ctx.storage.put('s', this.s);
      } else if (this.s.hostId !== id) {
        ws.send(JSON.stringify({ t: 'taken' }));
        return ws.close(4001, 'taken');
      }
    } else if (!this.s) {
      ws.send(JSON.stringify({ t: 'noroom' }));
      return ws.close(4004, 'noroom');
    }
    ws.serializeAttachment({ id, host: !!m.host });
    await this.ctx.storage.deleteAlarm();
    ws.send(JSON.stringify({ t: 'state', s: this.s }));
    this.sendPeers();
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, 'bye');
    } catch {}
    this.sendPeers(ws);
    if (this.members(ws).length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  // Rooms with nobody connected for a week are forgotten.
  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.s = null;
    }
  }

  members(except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.deserializeAttachment());
  }

  sendPeers(except) {
    const list = this.members(except);
    const msg = { t: 'peers', n: list.length, h: list.some((w) => w.deserializeAttachment().host) };
    this.broadcast(msg, except);
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const w of this.members(except)) {
      try {
        w.send(data);
      } catch {}
    }
  }
}
