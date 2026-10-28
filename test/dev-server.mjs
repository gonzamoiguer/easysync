// Local stand-in for the Cloudflare Worker, for testing without wrangler.
// Serves /public and implements the room protocol with the same room logic.
// Usage: node test/dev-server.mjs [port] [jitterMs]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newState, apply } from '../src/room-logic.js';

const PORT = Number(process.argv[2] || 8787);
const JITTER = Number(process.argv[3] || 0); // simulated one-way network delay, 0..JITTER ms
const ROOT = path.resolve(import.meta.dirname, '../public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const rooms = new Map(); // code -> { s, sockets:Set }

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket) => {
  const m = req.url.match(/^\/ws\/([A-HJKMNP-Z2-9]{4})$/);
  if (!m) return socket.destroy();
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const room = rooms.get(m[1]) ?? rooms.set(m[1], { s: null, sockets: new Set() }).get(m[1]);
  const conn = { socket, att: null, send: (o) => sendFrame(socket, typeof o === 'string' ? o : JSON.stringify(o)) };
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const f = readFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.size);
      if (f.op === 8) return close();
      if (f.op === 1) delay(() => onMessage(f.data.toString()));
    }
  });
  socket.on('close', close);
  socket.on('error', close);

  function close() {
    if (!room.sockets.delete(conn)) return;
    socket.destroy();
    peers();
  }
  function onMessage(raw) {
    const now = Date.now();
    if (raw === 'k') return delay(() => conn.send('k'));
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'ping') return delay(() => conn.send({ t: 'pong', a: msg.a, s: now }));
    if (msg.t === 'hello') {
      if (msg.host) {
        if (!room.s) room.s = newState(msg.id);
        else if (room.s.hostId !== msg.id) return conn.send({ t: 'taken' }), socket.end();
      } else if (!room.s) return conn.send({ t: 'noroom' }), socket.end();
      conn.att = { id: msg.id, host: !!msg.host };
      room.sockets.add(conn);
      conn.send({ t: 'state', s: room.s });
      return peers();
    }
    if (conn.att && room.s && apply(room.s, msg, conn.att.host, now)) broadcast({ t: 'state', s: room.s });
  }
  function peers() {
    const list = [...room.sockets];
    broadcast({ t: 'peers', n: list.length, h: list.some((c) => c.att.host) });
  }
  function broadcast(o) {
    for (const c of room.sockets) delay(() => c.send(o));
  }
});

const delay = (fn) => (JITTER ? setTimeout(fn, Math.random() * JITTER) : fn());

function readFrame(b) {
  if (b.length < 2) return null;
  const op = b[0] & 0x0f;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  const masked = b[1] & 0x80;
  const mask = masked ? b.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  const data = Buffer.from(b.subarray(off, off + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return { op, data, size: off + len };
}

function sendFrame(socket, text) {
  if (socket.destroyed) return;
  const data = Buffer.from(text);
  const head =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
  socket.write(Buffer.concat([head, data]));
}

server.listen(PORT, () => console.log(`easysync local: http://localhost:${PORT}  (jitter ${JITTER}ms)`));
