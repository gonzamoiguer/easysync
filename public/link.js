// WebSocket link to the room + NTP-style clock sync against the server.
//
// Message budget per client: one hello, a burst of 8 pings on connect,
// 4 pings every 3 minutes, a 1-byte keepalive every 50 s (answered at the
// edge without waking the room), and whatever control actions people take.

const BURST_FIRST = 8;
const BURST_LATER = 4;
const RESYNC_MS = 3 * 60 * 1000;
const KEEPALIVE_MS = 50 * 1000;

export const localNow = () => performance.timeOrigin + performance.now();

export class Link {
  constructor({ room, id, host, onState, onPeers, onFatal, onStatus }) {
    Object.assign(this, { room, id, host, onState, onPeers, onFatal, onStatus });
    this.offset = null; // server time - local time, ms
    this.rtt = null;
    this.bestRtt = Infinity;
    this.lastAccepted = 0;
    this.burst = [];
    this.online = false;
    this.closed = false;
    this.retry = 0;
    this.queue = [];
    this.connect();
  }

  // Server clock estimate. Falls back to the local clock until the first sync.
  now() {
    return localNow() + (this.offset ?? 0);
  }

  // Converts a performance.now()-based timestamp to server time.
  fromPerf(t) {
    return performance.timeOrigin + t + (this.offset ?? 0);
  }

  get synced() {
    return this.offset !== null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws/${this.room}`));
    ws.onopen = () => {
      this.online = true;
      this.retry = 0;
      this.onStatus?.();
      ws.send(JSON.stringify({ t: 'hello', id: this.id, host: this.host }));
      this.queue.splice(0).forEach((msg) => this.send(msg));
      this.pingBurst(BURST_FIRST);
      this.stopTimers();
      this.timers = [
        setInterval(() => this.raw('k'), KEEPALIVE_MS),
        setInterval(() => this.pingBurst(BURST_LATER), RESYNC_MS),
      ];
    };
    ws.onmessage = (e) => {
      if (e.data === 'k') return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') this.pong(m);
      else if (m.t === 'state') this.onState?.(m.s);
      else if (m.t === 'peers') this.onPeers?.(m);
      else if (m.t === 'taken' || m.t === 'noroom') {
        this.closed = true;
        this.onFatal?.(m.t);
      }
    };
    ws.onclose = () => {
      this.online = false;
      this.stopTimers();
      this.onStatus?.();
      if (this.closed) return;
      const wait = Math.min(15000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), wait);
    };
  }

  close() {
    this.closed = true;
    this.stopTimers();
    this.ws?.close();
  }

  stopTimers() {
    (this.timers || []).forEach(clearInterval);
    this.timers = [];
  }

  raw(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  // Control messages wait for the connection if it is down.
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  pingBurst(n) {
    this.burst = [];
    this.burstSize = n;
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.raw(JSON.stringify({ t: 'ping', a: localNow() })), i * 120);
    }
  }

  pong({ a, s }) {
    const t1 = localNow();
    this.burst.push({ rtt: t1 - a, offset: s - (a + t1) / 2 });
    if (this.burst.length < this.burstSize) return;
    // The lowest round trip has the least queueing noise, so its midpoint
    // estimate is the most accurate one.
    const best = this.burst.reduce((x, y) => (y.rtt < x.rtt ? y : x));
    this.burst = [];
    const stale = localNow() - this.lastAccepted > 15 * 60 * 1000;
    // Skip bursts measured on a congested network unless we have nothing better.
    if (this.offset !== null && !stale && best.rtt > this.bestRtt * 2 + 20) return;
    this.bestRtt = Math.min(this.bestRtt, best.rtt);
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.lastAccepted = localNow();
    this.onStatus?.();
  }
}
