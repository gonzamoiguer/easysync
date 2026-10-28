// Pure room state logic, shared by the Durable Object and the local test server.
//
// The room never streams playback. It stores a schedule and every client
// derives its own position from a synced clock:
//   pos(t) = ((t - T0) / 1000) mod D        for t >= hold
// While paused, everyone sits at pausedPos. After any change (reset, play,
// seek) playback holds until `hold` so all clients have time to pre-roll.

export const LEAD_MS = 1000;

export function newState(hostId) {
  return { hostId, D: 0, T0: 0, hold: 0, paused: false, pausedPos: 0, v: 0 };
}

const mod = (a, n) => ((a % n) + n) % n;

export function posAt(s, now) {
  if (!s.D) return 0;
  if (s.paused) return s.pausedPos;
  return mod((Math.max(now, s.hold) - s.T0) / 1000, s.D);
}

function restart(s, pos, now) {
  s.paused = false;
  s.hold = now + LEAD_MS;
  s.T0 = s.hold - pos * 1000;
}

// Applies a client command. Returns true when the state changed.
export function apply(s, cmd, isHost, now) {
  switch (cmd.t) {
    case 'dur': {
      const d = Number(cmd.d);
      if (!isHost || !(d > 0) || Math.abs(d - s.D) < 0.001) return false;
      s.D = d;
      restart(s, 0, now);
      break;
    }
    case 'reset':
      if (!isHost || !s.D) return false;
      restart(s, 0, now);
      break;
    case 'pause':
      if (!s.D || s.paused) return false;
      s.pausedPos = posAt(s, now);
      s.paused = true;
      break;
    case 'play':
      if (!s.D || !s.paused) return false;
      restart(s, s.pausedPos, now);
      break;
    case 'seek': {
      const p = Number(cmd.p);
      if (!s.D || !Number.isFinite(p)) return false;
      const pos = mod(p, s.D);
      if (s.paused) s.pausedPos = pos;
      else restart(s, pos, now);
      break;
    }
    default:
      return false;
  }
  s.v++;
  return true;
}
