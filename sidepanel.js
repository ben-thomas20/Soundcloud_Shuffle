'use strict';

const CACHE_KEY = 'likes';
const DEAD_KEY = 'dead';           // track ids that never actually start
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const PAGE_SIZE = 200;
const PAGE_DELAY_MS = 120;
const STALL_TIMEOUT_MS = 9000;

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

function play(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  const t = state.queue[i];

  $('title').textContent = t.title;
  $('artist').textContent = t.user;
  setStatus(`${i + 1} / ${state.queue.length}`);
  $('fill').style.width = '0%';
  $('cur').textContent = '0:00';
  $('dur').textContent = '0:00';
  state.duration = 0;

  clearStall();
  // Go+, geo-blocked and embed-disabled tracks often fire no ERROR event.
  // They just load and never start, so we time them out and remember them.
  state.stallTimer = setTimeout(() => {
    markDead(t.id);
    log(`skipped (no playback): ${t.title}`);
    play(state.index + 1);
  }, STALL_TIMEOUT_MS);

  state.widget.load(t.url, {
    auto_play: true,
    show_comments: false,
    callback: () => {
      const E = SC.Widget.Events;
      [E.PLAY_PROGRESS, E.FINISH, E.ERROR, E.PLAY, E.PAUSE].forEach((e) =>
        state.widget.unbind(e)
      );

      // The first PLAY_PROGRESS is our only reliable proof the track actually
      // started, so it doubles as the stall-timer cancel. Do not split the
      // cancel out of this handler or unplayable tracks will hang the player.
      state.widget.bind(E.PLAY_PROGRESS, (p) => {
        clearStall();
        $('fill').style.width = `${(p.relativePosition || 0) * 100}%`;
        $('cur').textContent = fmt(p.currentPosition);
      });
      state.widget.bind(E.FINISH, () => play(state.index + 1));
      state.widget.bind(E.ERROR, () => {
        markDead(t.id);
        play(state.index + 1);
      });
      state.widget.bind(E.PLAY, () => setPlayIcon(true));
      state.widget.bind(E.PAUSE, () => setPlayIcon(false));

      state.widget.getDuration((d) => {
        state.duration = d;
        $('dur').textContent = fmt(d);
      });
      state.widget.getCurrentSound((s) => updateArtwork(s));
      setPlayIcon(true);
    },
  });
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
