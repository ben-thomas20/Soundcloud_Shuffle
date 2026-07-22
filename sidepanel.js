'use strict';

const CACHE_KEY = 'likes';
const DEAD_KEY = 'dead';           // track ids that never actually start
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const PAGE_SIZE = 200;
const PAGE_DELAY_MS = 120;
const STALL_TIMEOUT_MS = 9000;      // never starts: no progress at all
const FREEZE_TIMEOUT_MS = 10000;    // started, then position stopped advancing
const MONITOR_INTERVAL_MS = 2000;
const STREAM_FAIL_GRACE_MS = 3000;  // after the embed 404s a track's stream

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setStatus = (s) => ($('status').textContent = s);
const log = (s) => {
  $('log').textContent = `${s}\n${$('log').textContent}`.slice(0, 2000);
};

const state = {
  queue: [],
  index: -1,
  widget: null,
  stallTimer: null,
  monitor: null,
  lastPos: 0,
  lastAdvanceAt: 0,
  playing: false,
  dead: new Set(),
  duration: 0,
};

// -----------------------------------------------------------------------
// Credentials, captured by the service worker
// -----------------------------------------------------------------------
async function getCreds() {
  const { token, clientId } = await chrome.storage.session.get(['token', 'clientId']);
  return token && clientId ? { token, clientId } : null;
}

// -----------------------------------------------------------------------
// API. host_permissions means no CORS preflight problems here.
// -----------------------------------------------------------------------
async function api(path, creds) {
  const u = new URL(path, 'https://api-v2.soundcloud.com');
  if (!u.searchParams.get('client_id')) u.searchParams.set('client_id', creds.clientId);

  const res = await fetch(u.toString(), { headers: { Authorization: creds.token } });
  if (res.status === 401) throw new Error('token expired, reload soundcloud.com');
  if (!res.ok) throw new Error(`api-v2 ${res.status}`);
  return res.json();
}

const trim = (t) => ({
  id: t.id,
  title: t.title,
  user: (t.user && t.user.username) || '',
  url: t.permalink_url,
  ok: t.streamable !== false && t.policy !== 'BLOCK',
});

async function fetchAllLikes(creds) {
  const me = await api('/me', creds);
  let next = `/users/${me.id}/track_likes?limit=${PAGE_SIZE}&offset=0&linked_partitioning=1`;
  const out = [];

  while (next) {
    const page = await api(next, creds);
    for (const entry of page.collection || []) {
      const t = entry.track || entry;
      if (t && t.kind === 'track' && t.permalink_url) out.push(trim(t));
    }
    setStatus(`fetched ${out.length}`);
    next = page.next_href || null;
    if (next) await sleep(PAGE_DELAY_MS);
  }
  return out;
}

// chrome.storage.local plus unlimitedStorage, so no need to worry about the
// 5MB ceiling that localStorage would impose on a large library.
async function readCache() {
  const { [CACHE_KEY]: c } = await chrome.storage.local.get(CACHE_KEY);
  if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
  return c.tracks;
}
const writeCache = (tracks) =>
  chrome.storage.local.set({ [CACHE_KEY]: { at: Date.now(), tracks } });

async function loadDead() {
  const { [DEAD_KEY]: d } = await chrome.storage.local.get(DEAD_KEY);
  state.dead = new Set(d || []);
}
function markDead(id) {
  state.dead.add(id);
  chrome.storage.local.set({ [DEAD_KEY]: [...state.dead] });
}

// -----------------------------------------------------------------------
// Shuffle
// -----------------------------------------------------------------------
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// -----------------------------------------------------------------------
// Now-playing UI
// -----------------------------------------------------------------------
const fmt = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const setPlayIcon = (playing) => $('play').classList.toggle('is-playing', playing);

// SoundCloud hands back a 100px "-large.jpg" artwork. The "-t500x500" variant
// is the largest square that is always present, which the crisp <img> and the
// hexdump backdrop both want.
const bigArtwork = (url) => (url ? url.replace(/-large\.(jpg|png)/, '-t500x500.$1') : null);

async function updateArtwork(sound) {
  const url =
    bigArtwork(sound && sound.artwork_url) ||
    (sound && sound.user && bigArtwork(sound.user.avatar_url)) ||
    null;

  const art = $('art');
  if (url) {
    art.src = url;
    art.style.opacity = '1';
  } else {
    art.removeAttribute('src');
    art.style.opacity = '0';
  }

  // Feed the same image to the animated backdrop. We fetch it as a blob so the
  // pixels become same-origin: drawing a raw cross-origin image into a canvas
  // and reading it back would taint the canvas. host_permissions covers
  // sndcdn, so this fetch is not blocked by CORS.
  if (url && window.AsciiBackground) {
    try {
      const res = await fetch(url);
      const bmp = await createImageBitmap(await res.blob());
      AsciiBackground.setSource(bmp);
    } catch (_) {
      // Keep whatever the backdrop was showing; it stays animated regardless.
    }
  }
}

// -----------------------------------------------------------------------
// Playback
// -----------------------------------------------------------------------
function clearStall() {
  if (state.stallTimer) clearTimeout(state.stallTimer);
  state.stallTimer = null;
}

function clearMonitor() {
  if (state.monitor) clearInterval(state.monitor);
  state.monitor = null;
}

function play(i) {
  if (i < 0 || i >= state.queue.length) {
    clearStall();
    clearMonitor();
    return;
  }
  state.index = i;
  const t = state.queue[i];

  $('title').textContent = t.title;
  $('artist').textContent = t.user;
  setStatus(`${i + 1} / ${state.queue.length}`);
  $('fill').style.width = '0%';
  $('cur').textContent = '0:00';
  $('dur').textContent = '0:00';
  state.duration = 0;
  state.lastPos = 0;
  state.lastAdvanceAt = Date.now();
  state.playing = false;

  clearStall();
  clearMonitor();

  // Watchdog 1 (never starts): Go+, geo-blocked, embed-disabled, and some
  // tracks whose HLS stream 404s in the embed just load and sit at position 0
  // with no ERROR event. Time them out and remember them so we pay the cost
  // once per track.
  state.stallTimer = setTimeout(() => {
    markDead(t.id);
    log(`skipped (no playback): ${t.title}`);
    play(state.index + 1);
  }, STALL_TIMEOUT_MS);

  // Watchdog 2 (freezes partway): a stream segment stalls after playback has
  // begun. Nothing fires FINISH, so without this the track hangs until skipped
  // by hand. We only watch while actually playing, and skip WITHOUT marking
  // dead, because a mid-stream stall is usually transient (the track is fine).
  state.monitor = setInterval(() => {
    if (!state.playing) return;
    if (Date.now() - state.lastAdvanceAt > FREEZE_TIMEOUT_MS) {
      log(`skipped (stalled): ${t.title}`);
      play(state.index + 1);
    }
  }, MONITOR_INTERVAL_MS);

  state.widget.load(t.url, {
    auto_play: true,
    show_comments: false,
    callback: () => {
      const E = SC.Widget.Events;
      [E.PLAY_PROGRESS, E.FINISH, E.ERROR, E.PLAY, E.PAUSE].forEach((e) =>
        state.widget.unbind(e)
      );

      // Progress is the liveness signal. Only real audio (position past 0)
      // cancels the start watchdog, so a stray position-0 tick emitted at load
      // can no longer disarm it. Any change in position (a normal tick or a
      // seek) counts as alive and refreshes the freeze monitor.
      state.widget.bind(E.PLAY_PROGRESS, (p) => {
        const pos = p.currentPosition || 0;
        if (pos > 0) clearStall();
        if (pos !== state.lastPos) {
          state.lastPos = pos;
          state.lastAdvanceAt = Date.now();
        }
        $('fill').style.width = `${(p.relativePosition || 0) * 100}%`;
        $('cur').textContent = fmt(pos);
      });
      state.widget.bind(E.FINISH, () => play(state.index + 1));
      state.widget.bind(E.ERROR, () => {
        markDead(t.id);
        play(state.index + 1);
      });
      // Track play/pause so the freeze monitor never fires during a manual
      // pause, and so resuming does not count the paused time as a stall.
      state.widget.bind(E.PLAY, () => {
        state.playing = true;
        state.lastAdvanceAt = Date.now();
        setPlayIcon(true);
      });
      state.widget.bind(E.PAUSE, () => {
        state.playing = false;
        setPlayIcon(false);
      });

      state.widget.getDuration((d) => {
        state.duration = d;
        $('dur').textContent = fmt(d);
      });
      state.widget.getCurrentSound((s) => updateArtwork(s));
      state.playing = true;
      setPlayIcon(true);
    },
  });
}

// The background service worker sees the embed's stream request 404 well before
// our stall timeout would fire. When it does, and it is the current track that
// has not actually started, give it a brief grace to fall back to another
// stream, then skip. Real progress (position past 0) cancels this via the
// PLAY_PROGRESS handler, so a track that recovers is never wrongly skipped.
function onStreamFail(trackId) {
  const t = state.queue[state.index];
  if (!t || t.id !== trackId || state.lastPos > 0) return;
  clearStall();
  state.stallTimer = setTimeout(() => {
    markDead(t.id);
    log(`skipped (no stream): ${t.title}`);
    play(state.index + 1);
  }, STREAM_FAIL_GRACE_MS);
}

// -----------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------
async function start(forceRefetch) {
  const creds = await getCreds();
  if (!creds) {
    setStatus('open soundcloud.com first');
    return;
  }

  let tracks = forceRefetch ? null : await readCache();
  if (!tracks) {
    setStatus('fetching...');
    try {
      tracks = await fetchAllLikes(creds);
    } catch (e) {
      setStatus('fetch failed');
      log(e.message);
      return;
    }
    await writeCache(tracks);
  }

  const playable = tracks.filter((t) => t.ok && !state.dead.has(t.id));
  log(`${playable.length} playable of ${tracks.length} liked`);
  state.queue = shuffled(playable);
  play(0);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'stream-fail') onStreamFail(msg.trackId);
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadDead();
  if (window.AsciiBackground) AsciiBackground.init($('bg'));
  state.widget = SC.Widget($('widget'));

  $('prev').onclick = () => play(state.index - 1);
  $('next').onclick = () => play(state.index + 1);
  $('play').onclick = () => {
    if (state.index >= 0) state.widget.toggle();
  };
  $('reshuffle').onclick = () => start(false);
  $('refetch').onclick = () => start(true);

  // Click anywhere on the bar to seek.
  $('bar').onclick = (e) => {
    if (!state.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    state.widget.seekTo(ratio * state.duration);
  };

  setStatus((await getCreds()) ? 'ready' : 'open soundcloud.com first');
});
