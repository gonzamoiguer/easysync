// Playback engine. Each tick it works out where the video should be right
// now from the room schedule and the synced clock, then:
//   - pre-rolls (seek + pause) and starts play() at an exact clock time,
//   - nudges playbackRate to remove small drift,
//   - hard re-syncs on large errors,
//   - shows black when this file is shorter than the host's loop.
// No network traffic is needed for any of this, loops included.

const TICK_MS = 50;
const PREROLL_MS = 700; // lead time for a mid-cycle (re)start
const BOUNDARY_MS = 1500; // pre-roll window before a scheduled start
const HARD_SYNC_S = 0.5;
const DRIFT_ON_S = 0.02;
const DRIFT_OFF_S = 0.006;
const MAX_RATE_DELTA = 0.08;
const RATE_GAIN = 1; // rate offset per second of error: 50 ms off -> 5% faster/slower
const LOOP_LEAD_S = 3; // run slightly ahead this long before a native loop
const SAME_LENGTH_S = 0.05;

const mod = (a, n) => ((a % n) + n) % n;

export class Engine {
  constructor(video, link, { delayMs = 0, lag = 0.03, loopLag = 0.03 } = {}) {
    Object.assign(this, { video, link, delayMs, lag, loopLag });
    this.s = null;
    this.dur = 0;
    this.armed = null;
    this.err = null; // last measured error, seconds (+ = ahead)
    this.correcting = false;
    this.running = false;
    this.onBlocked = null;
    this.onLag = null; // (lag, loopLag) => persist learned values
    this.loopMeasured = false;
    this.pos = 0;
    video.addEventListener('loadedmetadata', () => {
      this.dur = video.duration;
      this.disarm();
    });
  }

  setState(s) {
    this.s = s;
    this.disarm();
    this.tick();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if ('requestVideoFrameCallback' in this.video) {
      const onFrame = (now, meta) => {
        if (!this.running) return;
        this.measure(meta.mediaTime, this.link.fromPerf(meta.expectedDisplayTime));
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
    }
    this.tick();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.disarm();
    this.video.pause();
    this.show(false);
  }

  // Schedule clock with this device's display/audio delay applied.
  t() {
    return this.link.now() - this.delayMs;
  }

  loops() {
    return this.s && Math.abs(this.dur - this.s.D) < SAME_LENGTH_S;
  }

  // Where playback should be at schedule time t.
  plan(t) {
    const s = this.s;
    if (!s || !s.D || !this.dur || !this.link.synced) return { kind: 'wait' };
    if (s.paused) return { kind: 'paused', pos: s.pausedPos };
    if (t < s.hold) return { kind: 'hold', pos: mod((s.hold - s.T0) / 1000, s.D), at: s.hold };
    const pos = mod((t - s.T0) / 1000, s.D);
    return { kind: 'play', pos, next: t + (s.D - pos) * 1000 };
  }

  show(on) {
    this.video.classList.toggle('on', on);
  }

  setRate(r) {
    if (Math.abs(this.video.playbackRate - r) > 0.002) this.video.playbackRate = r;
  }

  tick() {
    if (!this.running) return;
    const v = this.video;
    const t = this.t();
    const p = this.plan(t);

    if (this.armed) {
      // A scheduled start is pending or just fired; leave it alone for a moment.
      if (!this.armed.fired || t < this.armed.at + 300) return;
      this.armed = null;
    }

    if (p.kind === 'wait') {
      this.show(false);
      if (!v.paused) v.pause();
      return;
    }

    if (p.kind === 'paused') {
      const inside = p.pos < this.dur;
      this.show(inside);
      if (!v.paused) v.pause();
      this.setRate(1);
      if (inside && !v.seeking && Math.abs(v.currentTime - p.pos) > 0.03) v.currentTime = p.pos;
      return;
    }

    if (p.kind === 'hold') return this.arm(p.pos, p.at);

    // Playing.
    const loops = this.loops();
    v.loop = loops;
    if (!loops) {
      const endsAt = Math.min(this.dur, this.s.D);
      const toNext = p.next - t;
      if (p.pos >= endsAt - 0.02 || (this.dur > this.s.D && toNext < 300)) {
        // This file is over (or is longer than the loop): black until the cycle restarts.
        this.show(false);
        if (!v.paused) v.pause();
        if (toNext < BOUNDARY_MS) this.arm(0, p.next);
        return;
      }
    }

    if (v.paused) {
      const at = t + PREROLL_MS;
      return this.arm(this.plan(at).pos, at);
    }

    this.show(true);
    if (!('requestVideoFrameCallback' in v)) this.measure(v.currentTime, this.link.now());
    this.correct();
  }

  measure(mediaTime, serverTime) {
    if (this.video.paused || this.video.seeking) return;
    const p = this.plan(serverTime - this.delayMs);
    if (p.kind !== 'play') return;
    let err = mediaTime - p.pos;
    const loops = this.loops();
    if (loops) err = mod(err + this.s.D / 2, this.s.D) - this.s.D / 2;
    this.err = err;
    this.pos = p.pos;
    // The browser's own loop costs a few frames each time. Learn how much
    // from the error just after the wrap, and run that far ahead beforehand.
    if (loops && p.pos > 0.25 && p.pos < 0.6 && !this.loopMeasured && this.wrapped) {
      this.loopMeasured = true;
      this.wrapped = false;
      this.loopLag = Math.min(0.3, Math.max(0, this.loopLag - err * 0.5));
      this.onLag?.(this.lag, this.loopLag);
    }
    if (p.pos > this.s.D - 1) {
      this.wrapped = true;
      this.loopMeasured = false;
    }
    // Learn how late play() really starts on this machine, from a frame
    // shortly after a scheduled start.
    const a = this.armed;
    if (a?.fired && !a.measured && serverTime - this.delayMs > a.at + 150) {
      a.measured = true;
      this.lag = Math.min(0.25, Math.max(0, this.lag - err * 0.5));
      this.onLag?.(this.lag, this.loopLag);
    }
  }

  correct() {
    if (this.err === null) return;
    const ahead = this.loops() && this.s.D - this.pos < LOOP_LEAD_S ? this.loopLag : 0;
    const err = this.err - ahead;
    const a = Math.abs(err);
    if (a > HARD_SYNC_S) {
      this.err = null;
      const at = this.t() + PREROLL_MS;
      return this.arm(this.plan(at).pos, at);
    }
    if (a > DRIFT_ON_S || (this.correcting && a > DRIFT_OFF_S)) {
      this.correcting = true;
      const delta = Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, err * RATE_GAIN));
      this.setRate(1 - delta);
    } else {
      this.correcting = false;
      this.setRate(1);
    }
  }

  // Seek to pos now, paused, and call play() exactly at schedule time `at`.
  arm(pos, at) {
    const a = this.armed;
    if (a && a.at === at && Math.abs(a.pos - pos) < 1e-3) return;
    this.disarm();
    const v = this.video;
    const armed = (this.armed = { pos, at, fired: false });
    const inside = pos < this.dur;
    v.pause();
    this.setRate(1);
    this.err = null;
    this.correcting = false;
    if (inside) v.currentTime = Math.min(pos + this.lag, this.dur - 0.05);
    const fire = () => {
      if (this.armed !== armed) return;
      const left = at - this.t();
      if (left > 20) {
        armed.timer = setTimeout(fire, left - 15);
        return;
      }
      while (this.t() < at) {} // spin the last few ms for precision
      armed.fired = true;
      if (!inside) return;
      this.show(true);
      v.play().catch((e) => {
        if (e.name === 'NotAllowedError') this.onBlocked?.();
      });
    };
    fire();
  }

  disarm() {
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
  }
}
