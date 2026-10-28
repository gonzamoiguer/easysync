# easysync

Plays local video files on several computers in exact sync, looping forever. Built for exhibitions: a black screen with no visible interface while it plays.

- One computer **creates** a room and gets a 4-character code. Its video length sets the loop.
- The others **join** with the code. Each one plays its own video. It can be the same file or a different one.
  - A video shorter than the host's shows black until the loop restarts.
  - A video longer than the host's is cut off when the loop restarts.
- Anyone can pause or scrub. Only the host can **reset**, which restarts everyone.
- Opening the site again restores the room and the video automatically.

User instructions are in [`public/help.html`](public/help.html), shown on the site as SETUP / HELP.

## Deploy (free, about 5 minutes, once)

You need a free Cloudflare account.

**Option A: from GitHub, no tools to install**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick this repo.
2. Keep the defaults: deploy command `npx wrangler deploy`. Then **Deploy**.
3. The site is now at `https://easysync.<your-account>.workers.dev`. Every push to the main branch redeploys it.

**Option B: from your computer** (needs Node.js)

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npm run deploy
```

## How sync works

The server never streams playback. It keeps a small schedule per room:

```
{ T0, D, hold, paused, pausedPos }   →   position(t) = ((t − T0) / 1000) mod D
```

1. **Clock.** Each computer measures its clock offset to the server with NTP-style pings: 8 on connect, then 4 every 3 minutes. It keeps the ping with the shortest round trip.
2. **Schedule.** Pause, play, seek and reset each produce a new schedule. Playback is held 1 s in the future so every computer can seek ahead of time and call `play()` at the same moment.
3. **Drift.** Each computer compares the frame on screen (`requestVideoFrameCallback`) with the schedule. Small errors are fixed by speeding up or slowing down by a few percent. Errors over 0.5 s cause a re-seek.
   - Each machine learns its own `play()` start delay and loop-restart delay, and stores them.
4. **Loops** need no network at all, so playback keeps going in sync if the Wi-Fi drops.

**Backend:** one Cloudflare Worker, plus one Durable Object per room using the WebSocket Hibernation API.
- Keepalive messages are answered without waking the room.
- A 10-screen room uses a few hundred billed requests a day. The free tier allows 100,000.
- Rooms with nobody connected for 7 days are deleted.

**Per-screen delay** (HUD, or the `[` and `]` keys) compensates for a slow TV or external speakers.

## Files

| path | what |
|---|---|
| `src/worker.js` | Worker + `Room` Durable Object |
| `src/room-logic.js` | room schedule logic (shared with the test server) |
| `public/app.js` | screens, session restore, HUD |
| `public/player.js` | sync engine |
| `public/link.js` | WebSocket + clock sync |
| `public/store.js`, `copy-worker.js` | remembering the video file (Chrome file handle, or an OPFS copy) |
| `test/dev-server.mjs` | local stand-in for the Worker, with optional simulated network jitter |

## Local testing

`npm run dev` runs the real Worker locally with wrangler.

Without wrangler, run the stand-in server instead. The second argument adds up to 30 ms of random network delay:

```bash
node test/dev-server.mjs 8787 30
```
