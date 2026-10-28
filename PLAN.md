# easysync — plan

Play local video files on several computers at exactly the same time. Built for exhibitions: black screen, no visible UI while playing, restores itself after a reboot.

## 1. Main idea: share a clock and a schedule, not a stream of playback updates

Sending "play now" messages can never give tight sync, because each one reaches each machine with a different delay. Instead:

1. **Every client measures its clock offset to the server**, the way NTP does.
2. **The host publishes a schedule** such as "position 0 starts at server time `T0`. Loop length is `D`."
3. **Each client works out its position on its own:** `pos = ((serverNow − T0) × rate) mod D`.

Once a client has the schedule, it needs **no more messages** to stay in sync, even across loops. The network is used only for:

- joining
- clock re-checks every few minutes
- control actions: pause, seek, reset

This keeps costs close to zero. It also keeps the show running if the Wi-Fi drops, because every machine already knows the schedule.

### Clock sync
- When a client connects, it sends about 8 `ping{t0}` messages. The server replies `pong{t0, ts}` and the client records `t1` on arrival.
- From each round trip: `rtt = t1 − t0` and `offset = ts − (t0 + t1)/2`. The client keeps the offset from the **lowest-RTT sample**, which is the most accurate.
- It repeats this with 3 pings every 5 minutes, because computer clocks drift (roughly 10–50 ppm).
- Expected accuracy is a few milliseconds when the clients are on the same Wi-Fi. A frame lasts 33–40 ms, so this is well under one frame.

### Accurate playback start
- **Pre-roll:** about 1.5 s before the start time, the client seeks to the start position, pauses, and waits for the `seeked` and `canplay` events.
- **Start:** it calls `play()` at the start time, using `setTimeout` for the coarse wait and `requestAnimationFrame` for the final few ms.
- **Drift loop, local only:** about 4 times a second the client compares the actual frame time (`requestVideoFrameCallback`'s `mediaTime`) with the expected position.
  - Error under 10 ms: nothing.
  - Error 10–500 ms: nudge `playbackRate` by about ±2% until it closes. The change is inaudible.
  - Error over 500 ms: hard seek.
- **Per-device offset:** a manual setting in ms, to compensate for display or audio output latency on that machine (for example a slow TV or Bluetooth speakers).

### Loops and black screen
- The host's video length `D` sets the cycle length.
- If a joined machine's video is **shorter**, it shows pure black after its video ends until the next cycle starts.
- If it is **longer**, it is cut off at the next cycle.
- Every cycle restart is calculated locally, so a loop sends no messages.

## 2. Room state, kept in a Durable Object

```
{ hostId, T0, D, rate: 1|0, pausedPos, version }
```
- `rate = 0` means paused at `pausedPos`. Playing again sets a new `T0 = now + 300ms − pausedPos`.
- **Any member** can send `pause`, `play`, or `seek(pos)`. The server applies the change, increments `version`, and broadcasts the new state.
- **Only the host** can send `reset`, which sets a new `T0 = now + lead` (lead is about 1 s) and position 0, and can set `D`.
- The server keeps no media and no per-frame data.

### Messages (JSON, small)
| dir | msg | when |
|---|---|---|
| C→S | `hello{room, role, clientId}` | connect |
| C↔S | `ping{t0}` / `pong{t0,ts}` | join, then every 5 min |
| C→S | `pause` / `play` / `seek{pos}` / `reset` / `setDuration{D}` | user action |
| S→C | `state{…}` | on join and after each change |

## 3. Local video file and auto-restore

- **Chrome / Edge:** pick the file with `showOpenFilePicker` and keep the file handle in IndexedDB. The file is read in place, so any size works. Chrome can grant read access "on every visit"; otherwise the CLICK TO START click re-grants it.
- **Firefox / Safari:** these have no file handles, so the app copies the file once into the Origin Private File System (OPFS), the site's private storage. A worker does the copy and shows a progress bar.
- `localStorage` saves `{room, role, clientId, offsetMs}`. Visiting the site again rejoins the room and starts playing on schedule.
- **Autoplay and fullscreen** both need a user click, unless the browser runs in kiosk mode. For exhibitions we document a launch command:
  ```
  chrome --kiosk --autoplay-policy=no-user-gesture-required https://easysync.<you>.workers.dev
  ```
  Outside kiosk mode, the restored session waits for a single click anywhere on a black screen, then goes fullscreen and plays.
- The Screen Wake Lock API keeps the display from sleeping.
- The cursor hides after 2 s without movement.

## 4. Screens

- **Home:** two options, `create` and `join`. Small white text on black, Phosphor icons.
- **Join:** a 4-character code field.
  - Codes use an alphabet without look-alike characters (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), which gives about 920k codes.
- **Pick video:** opens the file picker, then shows copy progress.
- **Player:** fullscreen black with no UI.
  - Moving the mouse or pressing a key shows a tiny overlay: room code, play/pause, scrub bar, reset (host only), sync offset in ms, and the number of connected peers. It fades after 3 s.
  - Keyboard: space for play/pause, arrow keys to seek, `R` to reset (host).

## 5. Stack and deployment (free tier)

- **One Cloudflare Worker**:
  - It serves the static front end through Workers Static Assets.
  - It routes `/ws/:room` to a **Durable Object per room**, using the **WebSocket Hibernation API**: idle sockets cost no compute time.
  - Durable Objects with SQLite storage are available on the Workers Free plan.
- **Front end:** plain JavaScript modules with no build step and no framework, plus `@phosphor-icons/web` from a CDN.
- **Tooling:** `wrangler`. Deploy with `npx wrangler deploy`, which gives a `*.workers.dev` URL. A custom domain is optional.
- **Cost estimate:** a 10-machine room uses roughly 10 × (8 + 3 per 5 min) pings, which is about 3.6k messages a day.
  - Durable Objects bill incoming WebSocket messages at a 20:1 ratio against requests, so this is under 200 billed requests a day.
  - The free tier allows 100k requests a day, so it stays **free**.
- Rooms expire after 7 days with no connections, using a Durable Object alarm.

## 6. Build order
1. Worker + Durable Object (room state, ping/pong, broadcast) and a test client page that shows the clock offset.
2. Player: scheduled start, drift correction, black screen after the video ends, looping.
3. OPFS storage and session restore.
4. Overlay controls: pause, seek, reset, offset.
5. Kiosk-mode setup notes, then a test on 2–3 machines. To measure sync, film all the screens playing a video with a frame counter and compare the counters.

## 7. Decisions (from Q&A)
- **Videos:** the same file or different files on each computer. The host's length sets the loop. Shorter files go black until the loop restarts; longer files are cut off.
- **Browsers:** Chrome and Edge are best: the file is read in place through a saved file handle. Firefox and Safari copy the file into OPFS once. The home screen recommends Chrome when it is missing.
- **Kiosk mode can't be detected directly.** Instead the app checks the two things that matter: the window already covers the screen, and autoplay with sound is allowed. If both are true it starts with no click. Otherwise it shows a full-screen CLICK TO START.
- **Loops:** forever, with no gap. The host loops on its own too.
- **Sound:** every computer plays its own video's sound.
- **Controls:** moving the mouse shows the HUD, a hard cut with no fade. It hides 3 s after the last movement. Brutalist black blocks, Datatype font, Phosphor bold icons.
- **Domain:** `*.workers.dev`.
