import { Link } from './link.js';
import { Engine } from './player.js';
import { pickVideo, loadVideo } from './store.js';
import { t } from './i18n.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const HUD_MS = 3000;

const video = document.getElementById('video');
const screenEl = document.getElementById('screen');
const hud = document.getElementById('hud');

// ---------- persisted session ----------

const clientId =
  localStorage.getItem('easysync-id') ||
  (localStorage.setItem('easysync-id', crypto.randomUUID()), localStorage.getItem('easysync-id'));

const store = {
  load: () => {
    try {
      return JSON.parse(localStorage.getItem('easysync-session'));
    } catch {
      return null;
    }
  },
  save: () => localStorage.setItem('easysync-session', JSON.stringify(S)),
  clear: () => localStorage.removeItem('easysync-session'),
};

let S = null; // { room, host, delay, lag, confirmed }
let link = null;
let engine = null;
let state = null;
let peers = { n: 0, h: false };
let running = false;
let fileName = '';
let objectUrl = null;
let wakeLock = null;

const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHABET[b % ALPHABET.length]).join('');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (name) => `<i class="ph-bold ph-${name}"></i>`;
const $ = (id) => document.getElementById(id);

function render(html) {
  screenEl.innerHTML = html;
}

// ---------- screens ----------

function home(error) {
  stopRoom();
  const inPlace = 'showOpenFilePicker' in window;
  render(`
    <div class="box">
      <div class="title">EASYSYNC</div>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <button id="create" class="wide">${icon('plus-square')}${t('create')}</button>
      <div class="separator"><div class="line"></div><span>${t('or')}</span><div class="line"></div></div>
      <form id="joinform" class="row">
        <input id="code" maxlength="4" placeholder="${t('code')}" autocomplete="off" spellcheck="false" autocapitalize="characters">
        <button>${icon('arrow-right')}${t('join')}</button>
      </form>
      ${inPlace ? '' : `<div class="dim">${t('tipChrome')}</div>`}
      <a class="dim" href="help.html">${t('help')}</a>
    </div>`);
  $('create').onclick = () => {
    S = { room: randomCode(), host: true, delay: 0, lag: 0.03, confirmed: false };
    enterRoom();
  };
  const code = $('code');
  code.oninput = () => {
    code.value = code.value
      .toUpperCase()
      .split('')
      .filter((c) => ALPHABET.includes(c))
      .join('');
  };
  $('joinform').onsubmit = (e) => {
    e.preventDefault();
    if (code.value.length !== 4) return code.focus();
    S = { room: code.value, host: false, delay: 0, lag: 0.03, confirmed: false };
    enterRoom();
  };
}

function roomLine() {
  return `${t('room')} ${S.room} · ${S.host ? t('host') : t('guest')}${fileName ? ' · ' + esc(fileName) : ''}`;
}

function pickScreen(error) {
  render(`
    <div class="box">
      <div class="title">${t('room')} <b>${S.room}</b></div>
      <div class="dim">${S.host ? t('hostNote') : t('guest')}</div>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <button id="pick" class="wide">${icon('file-video')}${t('pick')}</button>
      <div id="progress" class="bar" hidden><div></div></div>
      <div id="progresstext" class="dim" hidden></div>
      <button id="leave" class="wide">${icon('sign-out')}${t('leave')}</button>
    </div>`);
  $('leave').onclick = leave;
  $('pick').onclick = async () => {
    let file;
    try {
      file = await pickVideo((p) => {
        $('progress').hidden = $('progresstext').hidden = false;
        $('progress').firstElementChild.style.width = `${Math.round(p * 100)}%`;
        $('progresstext').textContent = t('saving', { p: Math.round(p * 100) });
      });
    } catch (e) {
      if (e.name !== 'AbortError') pickScreen(t('cantOpen'));
      return;
    }
    if (!(await useFile(file))) return;
    // A host picking a new video restarts the loop for everyone.
    if (S.host) link.send({ t: 'reset' });
    readyToStart();
  };
}

function gate(tip = true) {
  running = false;
  hideHud();
  const tips = { firefox: t('skipFirefox'), safari: t('skipSafari'), chrome: t('skipChrome') };
  const ua = navigator.userAgent;
  const which = /Firefox/.test(ua) ? 'firefox' : /Safari/.test(ua) && !/Chrome|Chromium/.test(ua) ? 'safari' : 'chrome';
  render(`
    <div class="gate" id="gate">
      <div class="title">${icon('play')} ${t('clickToStart')}</div>
      <div class="dim">${roomLine()}</div>
      ${tip ? `<div class="dim">${tips[which]}</div>` : ''}
    </div>`);
  $('gate').onclick = async () => {
    enterFullscreen();
    if (!video.src) {
      const r = await loadVideo(true);
      if (!r.file) return r.needsClick ? gate() : pickScreen(r.missing ? t('notFound', { name: r.missing }) : null);
      if (!(await useFile(r.file, r.name))) return;
    }
    run();
  };
}

// ---------- room lifecycle ----------

function enterRoom() {
  stopRoom();
  engine = new Engine(video, null, { delayMs: S.delay, lag: S.lag, loopLag: S.loopLag });
  engine.onBlocked = () => gate();
  engine.onLag = (lag, loopLag) => {
    S.lag = lag;
    S.loopLag = loopLag;
    store.save();
  };
  connect();
  prepareVideo();
}

function connect() {
  link = new Link({
    room: S.room,
    id: clientId,
    host: S.host,
    onState: (s) => {
      state = s;
      if (!S.confirmed) {
        S.confirmed = true;
        store.save();
      }
      syncDuration();
      engine.setState(s);
      updateHud();
    },
    onPeers: (p) => {
      peers = p;
      updateHud();
    },
    onStatus: updateHud,
    onFatal: (why) => {
      if (why === 'taken' && S.host && !S.confirmed) {
        // Random code collided with an existing room; try another.
        S.room = randomCode();
        link.close();
        connect();
        engine.link = link;
        return;
      }
      const room = S.room;
      store.clear();
      home(why === 'taken' ? t('taken', { room }) : t('noRoom', { room }));
    },
  });
  engine.link = link;
}

function stopRoom() {
  running = false;
  link?.close();
  engine?.stop();
  link = engine = state = null;
  peers = { n: 0, h: false };
  hideHud();
  releaseWake();
}

async function prepareVideo() {
  render('');
  const room = engine;
  const r = await loadVideo(false);
  if (engine !== room) return; // left the room (e.g. it doesn't exist) meanwhile
  if (r.file) {
    if ((await useFile(r.file, r.name)) && engine === room) readyToStart();
  } else if (r.needsClick) {
    gate();
  } else {
    pickScreen(r.missing ? t('notFound', { name: r.missing }) : null);
  }
}

// Loads a File into the <video>. Returns false (and shows the picker) if it can't play.
async function useFile(file, name = file.name) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  fileName = name;
  video.src = objectUrl;
  const ok = await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve(true);
    video.onerror = () => resolve(false);
  });
  video.onloadedmetadata = video.onerror = null;
  if (!ok || !(video.duration > 0) || !Number.isFinite(video.duration)) {
    video.removeAttribute('src');
    pickScreen(t('cantPlay', { name }));
    return false;
  }
  syncDuration();
  return true;
}

// The host's file length is the room's loop length.
function syncDuration() {
  if (S?.host && state && video.duration > 0 && Math.abs(state.D - video.duration) >= 0.001) {
    link.send({ t: 'dur', d: video.duration });
  }
}

async function readyToStart() {
  const room = engine;
  const autoplay = await canAutoplay();
  if (engine !== room) return;
  if (autoplay && isFullscreen()) run();
  else gate();
}

function run() {
  render('');
  running = true;
  engine.start();
  requestWake();
  document.body.classList.add('nocursor');
}

function leave() {
  store.clear();
  home();
}

// ---------- browser permissions ----------

async function canAutoplay() {
  if (navigator.getAutoplayPolicy) {
    try {
      return navigator.getAutoplayPolicy(video) === 'allowed';
    } catch {}
  }
  const volume = video.volume;
  video.volume = 0; // still counts as audible for autoplay rules, but silent
  try {
    await Promise.race([video.play(), new Promise((_, no) => setTimeout(no, 2000))]);
    return true;
  } catch {
    return false;
  } finally {
    video.pause();
    video.volume = volume;
  }
}

// There is no API to detect kiosk mode, but kiosk (or F11) means the window
// already covers the screen, which is what matters.
function isFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    matchMedia('(display-mode: fullscreen)').matches ||
    (window.screen.width - innerWidth < 2 && window.screen.height - innerHeight < 2)
  );
}

function enterFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) return;
  (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  } else enterFullscreen();
}

async function requestWake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible') requestWake();
});

// ---------- HUD ----------

let hudTimer = null;
let hudLoop = null;
let dragging = false;
let hovering = false;
let leaveArmed = false;

const fmt = (s) => {
  if (!Number.isFinite(s)) return '--:--.-';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function buildHud() {
  hud.innerHTML = `
    <div class="row">
      <span class="cell inv">ROOM <strong>${S.room}</strong></span>
      <span class="cell">${S.host ? 'HOST' : 'GUEST'}</span>
      <span class="cell" id="h-peers"></span>
      <span class="cell" id="h-net"></span>
      <span class="cell" id="h-err"></span>
    </div>
    <div class="row">
      <button id="h-play" title="PLAY / PAUSE (SPACE)"></button>
      <span class="cell" id="h-time"></span>
      <div class="scrub"><input type="range" id="h-seek" min="0" max="1000" step="1" value="0"></div>
      ${S.host ? `<button id="h-reset" title="RESTART EVERYONE (R)">${icon('skip-back')}RESET</button>` : ''}
    </div>
    <div class="row">
      <span class="cell">DELAY</span>
      <button id="h-dminus" title="[">-10</button>
      <span class="cell" id="h-delay"></span>
      <button id="h-dplus" title="]">+10</button>
      <button id="h-file">${icon('file-video')}VIDEO</button>
      <button id="h-fs" title="F">${icon('corners-out')}FULLSCREEN</button>
      <button id="h-leave">${icon('sign-out')}LEAVE</button>
    </div>`;
  hud.onpointerenter = () => (hovering = true);
  hud.onpointerleave = () => (hovering = false);
  $('h-play').onclick = togglePlay;
  if (S.host) $('h-reset').onclick = () => link.send({ t: 'reset' });
  $('h-dminus').onclick = () => nudgeDelay(-10);
  $('h-dplus').onclick = () => nudgeDelay(10);
  $('h-fs').onclick = toggleFullscreen;
  $('h-file').onclick = () => {
    running = false;
    engine.stop();
    hideHud();
    pickScreen();
  };
  $('h-leave').onclick = () => {
    if (leaveArmed) return leave();
    leaveArmed = true;
    $('h-leave').innerHTML = `${icon('warning')}CLICK AGAIN TO LEAVE`;
    setTimeout(() => {
      leaveArmed = false;
      if ($('h-leave')) $('h-leave').innerHTML = `${icon('sign-out')}LEAVE`;
    }, 3000);
  };
  const seek = $('h-seek');
  seek.onpointerdown = () => (dragging = true);
  seek.onpointerup = () => (dragging = false);
  seek.onchange = () => {
    dragging = false;
    if (state?.D) link.send({ t: 'seek', p: (seek.value / 1000) * state.D });
  };
}

function updateHud() {
  if (hud.hidden || !engine || !S) return;
  const peersEl = $('h-peers');
  if (!peersEl) return;
  peersEl.textContent = `${peers.n} ONLINE${peers.h || S.host ? '' : ' · HOST AWAY'}`;
  const net = $('h-net');
  net.classList.toggle('inv', !link?.online);
  net.textContent = !link?.online ? 'OFFLINE — KEEPS PLAYING' : link.synced ? `CLOCK ±${Math.ceil(link.rtt / 2)}MS` : 'SYNCING CLOCK';
  const p = engine.plan(engine.t());
  const visible = video.classList.contains('on');
  $('h-err').textContent =
    !visible ? 'BLACK' : engine.err === null || p.kind !== 'play' ? 'DRIFT --' : `DRIFT ${engine.err >= 0 ? '+' : ''}${Math.round(engine.err * 1000)}MS`;
  $('h-play').innerHTML = state?.paused ? `${icon('play')}PLAY` : `${icon('pause')}PAUSE`;
  const pos = p.kind === 'wait' ? 0 : p.pos;
  $('h-time').textContent = `${fmt(pos)} / ${fmt(state?.D || NaN)}`;
  if (!dragging && state?.D) $('h-seek').value = Math.round((pos / state.D) * 1000);
  $('h-delay').textContent = `${S.delay}MS`;
}

function showHud() {
  if (!running) return;
  if (hud.hidden) {
    buildHud();
    hud.hidden = false;
    document.body.classList.remove('nocursor');
    hudLoop = setInterval(updateHud, 200);
    updateHud();
  }
  clearTimeout(hudTimer);
  hudTimer = setTimeout(function hideLater() {
    if (hovering || dragging || leaveArmed) hudTimer = setTimeout(hideLater, HUD_MS);
    else hideHud();
  }, HUD_MS);
}

function hideHud() {
  clearTimeout(hudTimer);
  clearInterval(hudLoop);
  hud.hidden = true;
  hud.innerHTML = '';
  hovering = dragging = leaveArmed = false;
  if (running) document.body.classList.add('nocursor');
}

function togglePlay() {
  if (state) link.send({ t: state.paused ? 'play' : 'pause' });
}

function nudgeDelay(ms) {
  S.delay = Math.max(-2000, Math.min(2000, S.delay + ms));
  engine.delayMs = S.delay;
  engine.disarm();
  store.save();
  updateHud();
}

for (const ev of ['mousemove', 'pointerdown']) document.addEventListener(ev, showHud);

document.addEventListener('keydown', (e) => {
  if (!running || e.target.tagName === 'INPUT') return;
  showHud();
  const D = state?.D;
  const pos = () => engine.plan(engine.t()).pos ?? 0;
  if (e.code === 'Space') togglePlay();
  else if (e.code === 'ArrowLeft' && D) link.send({ t: 'seek', p: pos() - 5 });
  else if (e.code === 'ArrowRight' && D) link.send({ t: 'seek', p: pos() + 5 });
  else if (e.code === 'KeyR' && S.host) link.send({ t: 'reset' });
  else if (e.code === 'KeyF') toggleFullscreen();
  else if (e.code === 'BracketLeft') nudgeDelay(e.shiftKey ? -1 : -10);
  else if (e.code === 'BracketRight') nudgeDelay(e.shiftKey ? 1 : 10);
  else return;
  e.preventDefault();
});

// ---------- boot ----------

S = store.load();
if (S?.room) enterRoom();
else home();

// Read-only handle for debugging from the console.
window.easysync = {
  get link() {
    return link;
  },
  get engine() {
    return engine;
  },
};
