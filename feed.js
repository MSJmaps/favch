'use strict';

const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA_NS = 'http://search.yahoo.com/mrss/';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const FEED_TTL = 30 * MINUTE;        // "Load videos" reuses a channel's results this long
const REFRESH_MIN_AGE = 5 * MINUTE;  // "Refresh" skips channels checked more recently than this
const KEEP_STALE = 7 * DAY;          // last good results kept this long as a fallback
const MAX_WINDOW = 14 * DAY;         // longest time frame offered
const CONCURRENCY = 6;               // channels checked at once when things are healthy
const PAGE_CONCURRENCY = 2;          // channel pages are heavy, so at most this many at once
const TRIP_AFTER = 5;                // feed failures in a row before giving up on feeds for this load

const DEFAULT_CHOICES = { folders: null, timeframe: '7', order: 'bookmark' };
const DEFAULT_SETTINGS = { theme: 'system', folderId: null, mutedWords: [] };

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let folders = [];
let settings = { ...DEFAULT_SETTINGS };
let loading = false;

/* ---------- storage helpers ---------- */

async function getLocal(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}
const setLocal = (key, value) => chrome.storage.local.set({ [key]: value });

/* ---------- startup ---------- */

async function init() {
  const s = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      const before = settings.folderId;
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (settings.folderId !== before) location.reload();
    }
  });

  $('#loadBtn').addEventListener('click', () => load(false));
  $('#refreshBtn').addEventListener('click', () => load(true));
  $('#selectAll').addEventListener('change', (e) => {
    for (const b of folderBoxes()) b.checked = e.target.checked;
    syncSelectAll();
  });

  // Keep the folder list current when bookmarks change while this page is open.
  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
    chrome.bookmarks[ev].addListener(scheduleFolderRefresh);
  }

  const choices = { ...DEFAULT_CHOICES, ...(await getLocal('lastChoices', {})) };
  setRadio('timeframe', choices.timeframe);
  setRadio('order', choices.order);
  if (!(await refreshFolders(choices.folders))) return;

  if (choices.folders && choices.folders.length) load(false);
  else showEmpty('Pick one or more folders, then choose Load videos.');
}

/* ---------- bookmarks ---------- */

async function findRoot() {
  if (!settings.folderId) return null;
  try {
    const [tree] = await chrome.bookmarks.getSubTree(settings.folderId);
    return tree && !tree.url ? tree : null;
  } catch {
    return null;
  }
}

// Every folder inside the chosen folder, in bookmark order, with its depth for indenting.
// Bookmarks sitting loose in the chosen folder itself become an "Unsorted" entry.
function flattenFolders(root) {
  const out = [];
  const loose = (root.children || []).filter((n) => n.url);
  if (loose.length) out.push({ id: root.id, title: 'Unsorted', depth: 0, bookmarks: loose });
  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (child.url) continue;
      out.push({
        id: child.id,
        title: child.title || '(untitled folder)',
        depth,
        bookmarks: (child.children || []).filter((n) => n.url)
      });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

let folderTimer;
function scheduleFolderRefresh() {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => refreshFolders(), 300);
}

// Re-reads the bookmark tree. Keeps the current ticks unless given a list to restore.
async function refreshFolders(checkedIds) {
  const keep = new Set(checkedIds || folderBoxes().filter((b) => b.checked).map((b) => b.value));
  const root = await findRoot();
  if (!root) {
    showNoFolder();
    return false;
  }
  $('#folderName').textContent = root.title;
  folders = flattenFolders(root);
  renderFolders(keep);
  if (!loading) setBusy(false);
  return true;
}

function showNoFolder() {
  const list = $('#folderList');
  list.textContent = '';
  const p = document.createElement('p');
  p.className = 'folder-note';
  p.textContent = settings.folderId
    ? 'The folder you chose no longer exists. Pick another one in Settings.'
    : 'Choose the bookmark folder that holds your favorite channels.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary';
  btn.textContent = 'Choose a folder';
  btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  list.append(p, btn);
  $('#loadBtn').disabled = true;
  $('#refreshBtn').disabled = true;
  showEmpty('Once you choose a folder, its subfolders will appear on the left.');
}

const folderBoxes = () => [...document.querySelectorAll('#folderList input[type="checkbox"]')];

function renderFolders(checked) {
  const list = $('#folderList');
  const scroll = list.scrollTop;
  list.textContent = '';
  for (const f of folders) {
    const label = document.createElement('label');
    label.className = 'check';
    label.style.paddingLeft = `${f.depth * 18}px`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = f.id;
    box.checked = checked.has(f.id);
    box.addEventListener('change', syncSelectAll);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.title;
    name.title = f.title;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = f.bookmarks.length;
    label.append(box, name, count);
    list.append(label);
  }
  list.scrollTop = scroll;
  syncSelectAll();
}

function syncSelectAll() {
  const boxes = folderBoxes();
  const n = boxes.filter((b) => b.checked).length;
  const all = $('#selectAll');
  all.checked = n > 0 && n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}

function setRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (r) r.checked = true;
}
const getRadio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;

/* ---------- working out which channel a bookmark points to ---------- */

function channelRef(bookmark) {
  let u;
  try { u = new URL(bookmark.url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const video = (id) => (id ? { key: 'v:' + id, kind: 'video', page: `https://www.youtube.com/watch?v=${id}` } : null);

  if (host === 'youtu.be') return video(u.pathname.split('/')[1]);
  if (host !== 'youtube.com') return null;

  const [first, second] = u.pathname.split('/').filter(Boolean);
  if (!first) return null;
  if (first === 'channel' && /^UC[\w-]{22}$/.test(second || '')) return { key: second, kind: 'id', id: second };
  if (first.startsWith('@')) return { key: first.toLowerCase(), kind: 'page', page: `https://www.youtube.com/${first}` };
  if ((first === 'c' || first === 'user') && second) {
    return { key: `${first}/${second}`.toLowerCase(), kind: 'page', page: `https://www.youtube.com/${first}/${second}` };
  }
  if (first === 'watch') return video(u.searchParams.get('v'));
  if (['shorts', 'live', 'embed'].includes(first)) return video(second);
  if (['playlist', 'feed', 'results', 'channel', 'c', 'user', 'post', 'hashtag'].includes(first)) return null;
  // Old-style custom URL: youtube.com/SomeName
  return { key: first.toLowerCase(), kind: 'page', page: `https://www.youtube.com/${first}` };
}

async function resolveId(ref, cache, ctx) {
  if (ref.kind === 'id') return ref.id;
  if (cache[ref.key]) return cache[ref.key];

  const { text: html, url } = await ctx.pageLimit(() => fetchText(ref.page, { retries: 0 }))
    .catch((err) => { noteFailure(ctx, err); throw err; });
  if (url.includes('consent.')) throw new Error('YouTube showed a cookie-consent page instead of the channel');

  const patterns = ref.kind === 'video'
    ? [/itemprop="channelId" content="(UC[\w-]{22})"/, /"channelId":"(UC[\w-]{22})"/]
    : [
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
        /"externalId":"(UC[\w-]{22})"/,
        /itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/,
        /"browseId":"(UC[\w-]{22})"/
      ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) { cache[ref.key] = m[1]; return m[1]; }
  }
  throw new Error('Could not find the channel ID on its page');
}

/* ---------- talking to YouTube ---------- */

// Retries once, and only for errors that are usually momentary.
async function fetchText(url, { retries = 1 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 + Math.random() * 500);
    let r;
    try {
      r = await fetch(url, { credentials: 'omit' });
    } catch {
      last = new Error('Could not reach YouTube');
      continue;
    }
    if (r.ok) return { text: await r.text(), url: r.url };
    last = new Error(r.status === 404 ? 'Not found on YouTube (404)' : `YouTube returned error ${r.status}`);
    last.status = r.status;
    if (![500, 502, 503].includes(r.status)) break;
  }
  throw last;
}

function makeLimiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    while (active >= n) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function noteFailure(ctx, err) {
  ctx.troubled = true;
  if (err && err.status === 429) ctx.tripped = true;
}

/* Source 1: the channel's "regular videos only" feed (no Shorts, no livestreams). */

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The channel feed could not be read');
  const authorEl = doc.documentElement.getElementsByTagName('author')[0];
  const channelName = authorEl?.getElementsByTagName('name')[0]?.textContent || '';
  const videos = [...doc.getElementsByTagName('entry')].map((e) => {
    const stats = e.getElementsByTagNameNS(MEDIA_NS, 'statistics')[0];
    return {
      id: e.getElementsByTagNameNS(YT_NS, 'videoId')[0]?.textContent,
      title: e.getElementsByTagName('title')[0]?.textContent || '(untitled)',
      published: Date.parse(e.getElementsByTagName('published')[0]?.textContent),
      views: stats ? Number(stats.getAttribute('views')) : null
    };
  }).filter((v) => v.id && !Number.isNaN(v.published));
  return { channelName, videos };
}

async function fromFeed(channelId) {
  const { text } = await fetchText(`https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${channelId.slice(2)}`);
  const parsed = parseFeed(text);
  const cutoff = Date.now() - MAX_WINDOW;
  return { ts: Date.now(), source: 'feed', channelName: parsed.channelName, videos: parsed.videos.filter((v) => v.published >= cutoff) };
}

/* Source 2 (backup): the channel's Videos tab, which also leaves out Shorts and streams. */

const UNIT_MS = { second: 1000, minute: MINUTE, hour: 60 * MINUTE, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

function parseAgo(text, now) {
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text || '');
  if (!m) return null;
  return now - Number(m[1]) * UNIT_MS[m[2].toLowerCase()] + MINUTE;
}

function parseViews(text) {
  if (!text) return null;
  if (/no views/i.test(text)) return 0;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

function extractInitialData(html) {
  const m = /ytInitialData"?\]?\s*=\s*\{/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  const end = html.indexOf(';</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

const runsText = (t) => t?.simpleText || (t?.runs || []).map((r) => r.text).join('') || '';

const VIDEO_ID = /^[\w-]{11}$/;
const AGO_RE = /(?:Streamed |Premiered )?\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago/i;
const VIEWS_RE = /(?:[\d.,]+\s*[KMB]?|No) views?\b/i;

// Finds video entries in the page data, in page order. Rather than relying on one exact
// layout (YouTube changes it), it looks for any entry carrying a video ID plus a title,
// and reads the "3 days ago" and "12K views" text from anywhere inside that entry.
function collectVideos(data) {
  const out = [];
  const seen = new Set();
  const queue = [data];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (!node || typeof node !== 'object') continue;
    let id = null;
    if (typeof node.videoId === 'string' && VIDEO_ID.test(node.videoId) && node.title) id = node.videoId;
    else if (typeof node.contentId === 'string' && VIDEO_ID.test(node.contentId) && node.metadata) id = node.contentId;
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        const json = JSON.stringify(node);
        out.push({
          id,
          title: runsText(node.title) || node.title?.content || node.metadata?.lockupMetadataViewModel?.title?.content || '(untitled)',
          timeText: AGO_RE.exec(json)?.[0] || '',
          viewsText: VIEWS_RE.exec(json)?.[0] || '',
          upcoming: !!node.upcomingEventData || /"upcomingEventData"|Scheduled for|Premieres in/i.test(json)
        });
      }
      continue;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') queue.push(v);
  }
  return out;
}

async function fromVideosPage(channelId) {
  const { text, url } = await fetchText(`https://www.youtube.com/channel/${channelId}/videos?hl=en`, { retries: 0 });
  if (url.includes('consent.')) throw new Error('YouTube showed a cookie-consent page instead of the channel');
  const data = extractInitialData(text);
  if (!data) throw new Error("Couldn't read the channel's Videos page");
  const now = Date.now();
  const cutoff = now - MAX_WINDOW;
  const items = collectVideos(data);
  console.info('[FavCH] Videos page', channelId, `${items.length} entries found`, items.slice(0, 2));
  if (!items.length) throw new Error("Read the channel's Videos page but found no videos on it");
  if (!items.some((v) => parseAgo(v.timeText, now))) throw new Error("Read the channel's Videos page but couldn't read its upload dates");
  const videos = items
    .filter((v) => !v.upcoming && !/^streamed/i.test(v.timeText))
    .map((v) => ({ id: v.id, title: v.title, published: parseAgo(v.timeText, now), views: parseViews(v.viewsText), approx: true }))
    .filter((v) => v.published && v.published >= cutoff);
  return {
    ts: now,
    source: 'page',
    channelName: data.metadata?.channelMetadataRenderer?.title || '',
    videos
  };
}

/* Choosing a source for one channel. */

async function getVideos(channelId, feedCache, ctx) {
  const cached = feedCache[channelId];
  const age = cached ? Date.now() - cached.ts : Infinity;
  if (age < (ctx.force ? REFRESH_MIN_AGE : FEED_TTL)) return cached;

  let fresh = null;
  if (!ctx.tripped) {
    try {
      fresh = await fromFeed(channelId);
      ctx.feedFailsInARow = 0;
    } catch (err) {
      console.warn('[FavCH] Feed failed', channelId, err.status || err.message);
      noteFailure(ctx, err);
      if (++ctx.feedFailsInARow >= TRIP_AFTER) ctx.tripped = true;
    }
  }
  if (!fresh) {
    try {
      fresh = await ctx.pageLimit(() => fromVideosPage(channelId));
    } catch (err) {
      console.warn('[FavCH] Videos page failed', channelId, err.status || err.message);
      noteFailure(ctx, err);
      if (cached) return { ...cached, stale: true };
      err.feedError = true;
      throw err;
    }
  }
  feedCache[channelId] = fresh;
  return fresh;
}

async function pool(items, limit, worker, onEach, ctx) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      // Once YouTube starts complaining, slow down rather than pile on.
      if (ctx.troubled) await sleep(400 + Math.random() * 400);
      await worker(items[i], i);
      onEach();
    }
  });
  await Promise.all(runners);
}

/* ---------- main load ---------- */

async function load(force) {
  if (loading) return;
  if (!(await refreshFolders())) return;

  const selected = folderBoxes().filter((b) => b.checked).map((b) => b.value);
  const timeframe = getRadio('timeframe') || '7';
  const order = getRadio('order') || 'bookmark';
  await setLocal('lastChoices', { folders: selected, timeframe, order });

  if (!selected.length) {
    $('#grid').textContent = '';
    $('#report').hidden = true;
    showEmpty('Pick one or more folders, then choose Load videos.');
    status('');
    return;
  }

  loading = true;
  setBusy(true);
  try {
    // Collect channels in bookmark order, skipping duplicates.
    const chosen = new Set(selected);
    const channels = [];
    const seenKeys = new Set();
    const skipped = [];
    for (const f of folders) {
      if (!chosen.has(f.id)) continue;
      for (const b of f.bookmarks) {
        const ref = channelRef(b);
        if (!ref) { skipped.push({ label: b.title || b.url, url: b.url }); continue; }
        if (seenKeys.has(ref.key)) continue;
        seenKeys.add(ref.key);
        channels.push({ ...ref, label: b.title || b.url, url: b.url });
      }
    }

    const idCache = await getLocal('channelIds', {});
    const feedCache = await getLocal('videoCache', {});
    const ctx = { force, tripped: false, troubled: false, feedFailsInARow: 0, pageLimit: makeLimiter(PAGE_CONCURRENCY) };
    const results = new Array(channels.length);
    const failures = [];
    let done = 0;
    status(`Checking ${channels.length} channels…`);

    await pool(channels, CONCURRENCY, async (ch, i) => {
      try {
        const id = await resolveId(ch, idCache, ctx);
        results[i] = { ch, id, feed: await getVideos(id, feedCache, ctx) };
      } catch (err) {
        failures.push({ label: ch.label, url: ch.url, reason: err.message || 'Unknown error' });
      }
    }, () => status(`Checked ${++done} of ${channels.length} channels…`), ctx);

    for (const [k, v] of Object.entries(feedCache)) if (Date.now() - v.ts > KEEP_STALE) delete feedCache[k];
    await chrome.storage.local.set({ channelIds: idCache, videoCache: feedCache });

    // Apply time frame and muted words.
    const cutoff = Date.now() - Number(timeframe) * DAY;
    const muted = (settings.mutedWords || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const videos = [];
    const quiet = [];
    const fromPages = [];
    const stale = [];
    const seenIds = new Set();
    let mutedCount = 0;
    let activeChannels = 0;

    for (const r of results) {
      if (!r || seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      const name = r.feed.channelName || r.ch.label;
      if (r.feed.source === 'page') fromPages.push(name);
      if (r.feed.stale) stale.push({ name, ts: r.feed.ts });
      const kept = r.feed.videos
        .filter((v) => v.published >= cutoff)
        .sort((a, b) => b.published - a.published)
        .filter((v) => {
          const hit = muted.some((w) => v.title.toLowerCase().includes(w));
          if (hit) mutedCount++;
          return !hit;
        });
      if (!kept.length) { quiet.push({ name, id: r.id }); continue; }
      activeChannels++;
      for (const v of kept) videos.push({ ...v, channelName: name, channelId: r.id });
    }

    if (order === 'newest') videos.sort((a, b) => b.published - a.published);
    else if (order === 'random') shuffle(videos);

    renderGrid(videos);
    renderReport({ quiet, failures, skipped, mutedCount, stale, fromPages, checked: channels.length });
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    status(`${videos.length} ${videos.length === 1 ? 'video' : 'videos'} from ${activeChannels} ${activeChannels === 1 ? 'channel' : 'channels'}. Updated ${time}.`);
  } catch (err) {
    status(`Loading stopped: ${err.message}`);
  } finally {
    loading = false;
    setBusy(false);
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------- rendering ---------- */

function status(text) { $('#status').textContent = text; }

function setBusy(busy) {
  $('#loadBtn').disabled = busy;
  $('#refreshBtn').disabled = busy;
  $('#loadBtn').textContent = busy ? 'Loading…' : 'Load videos';
}

function showEmpty(text) {
  const e = $('#empty');
  e.textContent = text;
  e.hidden = false;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, secs] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${unit}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function link(href, className, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  if (className) a.className = className;
  if (text != null) a.textContent = text;
  return a;
}

function renderGrid(videos) {
  const grid = $('#grid');
  grid.textContent = '';
  if (!videos.length) {
    showEmpty('No new videos in this time frame. Try a longer time frame or more folders.');
    return;
  }
  $('#empty').hidden = true;

  const frag = document.createDocumentFragment();
  for (const v of videos) {
    const card = document.createElement('article');
    card.className = 'card';
    const watchUrl = `https://www.youtube.com/watch?v=${v.id}`;

    const thumb = link(watchUrl, 'thumb');
    thumb.tabIndex = -1;
    thumb.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.src = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    thumb.append(img);

    const title = document.createElement('h3');
    title.className = 'title';
    const titleLink = link(watchUrl, null, v.title);
    titleLink.title = v.title;
    title.append(titleLink);

    const channel = link(`https://www.youtube.com/channel/${v.channelId}/videos`, 'channel', v.channelName);

    const when = document.createElement('p');
    when.className = 'when';
    const views = v.views != null && !Number.isNaN(v.views) ? `${compact.format(v.views)} views, ` : '';
    when.textContent = views + (v.approx ? 'about ' : '') + timeAgo(v.published);

    card.append(thumb, title, channel, when);
    frag.append(card);
  }
  grid.append(frag);
}

function detailsBlock(summaryText, items, { problem = false, open = false } = {}) {
  const d = document.createElement('details');
  d.open = open;
  const s = document.createElement('summary');
  s.textContent = summaryText;
  if (problem) s.className = 'problem';
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    li.append(link(it.href, null, it.text));
    if (it.reason) {
      const r = document.createElement('span');
      r.className = 'reason';
      r.textContent = `: ${it.reason}`;
      li.append(r);
    }
    ul.append(li);
  }
  d.append(s, ul);
  return d;
}

function note(text, className) {
  const p = document.createElement('p');
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

function renderReport({ quiet, failures, skipped, mutedCount, stale, fromPages, checked }) {
  const report = $('#report');
  report.textContent = '';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const unreachable = failures.length + stale.length;
  const outage = unreachable >= 3 && unreachable >= checked / 2;
  if (outage) {
    report.append(note("YouTube isn't answering FavCH right now. This happens during YouTube outages, or after many reloads in a short time, and usually clears up within an hour or two. Nothing is wrong with your bookmarks.", 'outage'));
  }
  if (stale.length) {
    const oldest = Math.min(...stale.map((s) => s.ts));
    report.append(note(`Couldn't reach YouTube for ${plural(stale.length, 'channel')}, so ${stale.length === 1 ? 'its videos are' : 'their videos are'} from the last successful check (${timeAgo(oldest)}).`));
  }
  if (fromPages.length) {
    report.append(note(`${plural(fromPages.length, 'channel')} ${fromPages.length === 1 ? 'was' : 'were'} read from ${fromPages.length === 1 ? 'its' : 'their'} channel page because YouTube's feed didn't answer, so upload times for ${fromPages.length === 1 ? 'it' : 'them'} are approximate.`));
  }
  if (failures.length) {
    report.append(detailsBlock(`Couldn't check ${plural(failures.length, 'channel')}`,
      failures.map((f) => ({ text: f.label, href: f.url, reason: f.reason })), { problem: true, open: !outage }));
  }
  if (skipped.length) {
    report.append(detailsBlock(`${plural(skipped.length, 'bookmark')} in these folders ${skipped.length === 1 ? "isn't a channel link" : "aren't channel links"}`,
      skipped.map((s) => ({ text: s.label, href: s.url })), { problem: true }));
  }
  if (mutedCount) report.append(note(`Hid ${plural(mutedCount, 'video')} matching your muted words.`));
  if (quiet.length) {
    report.append(detailsBlock(`Nothing new from ${plural(quiet.length, 'channel')} in this time frame`,
      quiet.map((q) => ({ text: q.name, href: `https://www.youtube.com/channel/${q.id}/videos` }))));
  }
  report.hidden = !report.childElementCount;
}

init();
