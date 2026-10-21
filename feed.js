'use strict';

const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA_NS = 'http://search.yahoo.com/mrss/';
const DAY = 24 * 60 * 60 * 1000;
const FEED_TTL = 15 * 60 * 1000;   // reuse a channel's results for 15 minutes
const MAX_WINDOW = 14 * DAY;       // longest time frame offered
const CONCURRENCY = 4;             // channels checked at once
const KEEP_STALE = 7 * DAY;        // keep last good results this long as a fallback
const RETRY_STATUSES = [404, 429, 500, 502, 503];

const DEFAULT_CHOICES = { folders: null, timeframe: '7', order: 'bookmark' };
const DEFAULT_SETTINGS = { theme: 'system', folderId: null, mutedWords: [] };

const $ = (sel) => document.querySelector(sel);
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

  const root = await findRoot();
  if (!root) {
    $('#folderList').innerHTML = '';
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
    $('#folderList').append(p, btn);
    showEmpty('Once you choose a folder, its subfolders will appear on the left.');
    $('#loadBtn').disabled = true;
    $('#refreshBtn').disabled = true;
    return;
  }

  $('#folderName').textContent = root.title;
  folders = flattenFolders(root);
  const choices = { ...DEFAULT_CHOICES, ...(await getLocal('lastChoices', {})) };
  renderFolders(choices.folders);
  setRadio('timeframe', choices.timeframe);
  setRadio('order', choices.order);

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

const folderBoxes = () => [...document.querySelectorAll('#folderList input[type="checkbox"]')];

function renderFolders(savedIds) {
  const list = $('#folderList');
  list.textContent = '';
  const saved = new Set(savedIds || []);
  for (const f of folders) {
    const label = document.createElement('label');
    label.className = 'check';
    label.style.paddingLeft = `${f.depth * 18}px`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = f.id;
    box.checked = saved.has(f.id);
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
  $('#selectAll').addEventListener('change', (e) => {
    for (const b of folderBoxes()) b.checked = e.target.checked;
    syncSelectAll();
  });
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

async function resolveId(ref, cache) {
  if (ref.kind === 'id') return ref.id;
  if (cache[ref.key]) return cache[ref.key];

  const res = await fetch(ref.page, { credentials: 'omit' });
  if (res.url.includes('consent.')) throw new Error('YouTube showed a cookie-consent page instead of the channel');
  if (!res.ok) throw new Error(res.status === 404 ? 'Channel not found (it may have been renamed or deleted)' : `YouTube returned error ${res.status}`);
  const html = await res.text();

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

/* ---------- fetching videos ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube's feed server has bouts of spurious 404/500 errors, so retry a couple of times.
async function fetchText(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt === 1 ? 800 : 2500);
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (r.ok) return r.text();
      last = new Error(`YouTube returned error ${r.status}`);
      last.status = r.status;
      if (!RETRY_STATUSES.includes(r.status)) break;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

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

// A real Short loads at /shorts/ID; anything else gets redirected to /watch.
async function isShort(id) {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: 'HEAD', redirect: 'manual', credentials: 'omit' });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function fetchFeed(channelId) {
  const cutoff = Date.now() - MAX_WINDOW;
  try {
    // "UULF" playlist = the channel's regular videos only: no Shorts, no livestreams.
    const parsed = parseFeed(await fetchText(
      `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${channelId.slice(2)}`));
    return { ts: Date.now(), filtered: true, channelName: parsed.channelName, videos: parsed.videos.filter((v) => v.published >= cutoff) };
  } catch {
    // Backup: full channel feed, checking each recent video for Shorts.
    const parsed = parseFeed(await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`));
    const kept = [];
    for (const v of parsed.videos) {
      if (v.published < cutoff || /#shorts?/i.test(v.title)) continue;
      if (!(await isShort(v.id))) kept.push(v);
    }
    return { ts: Date.now(), filtered: false, channelName: parsed.channelName, videos: kept };
  }
}

async function getVideos(channelId, feedCache, force) {
  const cached = feedCache[channelId];
  if (!force && cached && Date.now() - cached.ts < FEED_TTL) return cached;
  try {
    const fresh = await fetchFeed(channelId);
    feedCache[channelId] = fresh;
    return fresh;
  } catch (err) {
    // YouTube's feed is down: fall back to the last good result if there is one.
    if (cached) return { ...cached, stale: true };
    err.feedError = true;
    throw err;
  }
}

async function pool(items, limit, worker, onEach) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
      onEach();
    }
  });
  await Promise.all(runners);
}

/* ---------- main load ---------- */

async function load(force) {
  if (loading) return;
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
    const feedCache = await getLocal('feedCache', {});
    const results = new Array(channels.length);
    const failures = [];
    let done = 0;
    status(`Checking ${channels.length} channels…`);

    await pool(channels, CONCURRENCY, async (ch, i) => {
      try {
        const id = await resolveId(ch, idCache);
        results[i] = { ch, id, feed: await getVideos(id, feedCache, force) };
      } catch (err) {
        failures.push({ label: ch.label, url: ch.url, reason: err.message || 'Unknown error', feed: !!err.feedError });
      }
    }, () => status(`Checked ${++done} of ${channels.length} channels…`));

    for (const [k, v] of Object.entries(feedCache)) if (Date.now() - v.ts > KEEP_STALE) delete feedCache[k];
    await chrome.storage.local.set({ channelIds: idCache, feedCache });

    // Apply time frame and muted words.
    const cutoff = Date.now() - Number(timeframe) * DAY;
    const muted = (settings.mutedWords || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const videos = [];
    const quiet = [];
    const backupFiltered = [];
    const stale = [];
    const seenIds = new Set();
    let mutedCount = 0;
    let activeChannels = 0;

    for (const r of results) {
      if (!r || seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      const name = r.feed.channelName || r.ch.label;
      if (!r.feed.filtered) backupFiltered.push(name);
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
    renderReport({ quiet, failures, skipped, backupFiltered, mutedCount, stale, checked: channels.length });
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
    const thumb = document.createElement('a');
    thumb.className = 'thumb';
    thumb.href = watchUrl;
    thumb.target = '_blank';
    thumb.rel = 'noopener';
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
    const titleLink = document.createElement('a');
    titleLink.href = watchUrl;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = v.title;
    titleLink.title = v.title;
    title.append(titleLink);

    const channel = document.createElement('a');
    channel.className = 'channel';
    channel.href = `https://www.youtube.com/channel/${v.channelId}/videos`;
    channel.target = '_blank';
    channel.rel = 'noopener';
    channel.textContent = v.channelName;

    const when = document.createElement('p');
    when.className = 'when';
    when.textContent = (v.views != null && !Number.isNaN(v.views) ? `${compact.format(v.views)} views, ` : '') + timeAgo(v.published);

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
    const a = document.createElement('a');
    a.href = it.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = it.text;
    li.append(a);
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

function renderReport({ quiet, failures, skipped, backupFiltered, mutedCount, stale, checked }) {
  const report = $('#report');
  report.textContent = '';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const feedFailures = failures.filter((f) => f.feed).length + stale.length;
  const outage = feedFailures >= 3 && feedFailures >= checked / 2;
  if (outage) {
    const p = document.createElement('p');
    p.className = 'outage';
    p.textContent = "YouTube's feed server is returning errors right now. This happens from time to time and usually clears up within a few hours. Nothing is wrong with your bookmarks. Try Refresh later.";
    report.append(p);
  }
  if (stale.length) {
    const oldest = Math.min(...stale.map((s) => s.ts));
    const p = document.createElement('p');
    p.textContent = `Couldn't reach YouTube for ${plural(stale.length, 'channel')}, so ${stale.length === 1 ? 'its videos are' : 'their videos are'} from the last successful check (${timeAgo(oldest)}).`;
    report.append(p);
  }
  if (failures.length) {
    report.append(detailsBlock(`Couldn't check ${plural(failures.length, 'channel')}`,
      failures.map((f) => ({ text: f.label, href: f.url, reason: f.reason })), { problem: true, open: !outage }));
  }
  if (skipped.length) {
    report.append(detailsBlock(`${plural(skipped.length, 'bookmark')} in these folders ${skipped.length === 1 ? "isn't a channel link" : "aren't channel links"}`,
      skipped.map((s) => ({ text: s.label, href: s.url })), { problem: true }));
  }
  if (mutedCount) {
    const p = document.createElement('p');
    p.textContent = `Hid ${plural(mutedCount, 'video')} matching your muted words.`;
    report.append(p);
  }
  if (backupFiltered.length) {
    const p = document.createElement('p');
    p.textContent = `Shorts were filtered the slower way for ${plural(backupFiltered.length, 'channel')} (${backupFiltered.join(', ')}). A livestream replay from ${backupFiltered.length === 1 ? 'it' : 'these'} could still slip through.`;
    report.append(p);
  }
  if (quiet.length) {
    report.append(detailsBlock(`Nothing new from ${plural(quiet.length, 'channel')} in this time frame`,
      quiet.map((q) => ({ text: q.name, href: `https://www.youtube.com/channel/${q.id}/videos` }))));
  }
  report.hidden = !report.childElementCount;
}

init();
