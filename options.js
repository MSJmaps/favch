'use strict';

const DEFAULT_SETTINGS = { theme: 'system', folderId: null, mutedWords: [] };
let settings = { ...DEFAULT_SETTINGS };
let flashTimer;

function flash(text) {
  const el = document.getElementById('saved');
  el.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function save(patch, message = 'Saved.') {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set({ settings });
  flash(message);
}

// Every bookmark folder, shown as a path like "Bookmarks bar / Video / Favorites".
async function listFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, trail) => {
    for (const child of node.children || []) {
      if (child.url) continue;
      const path = [...trail, child.title || '(untitled)'];
      out.push({ id: child.id, path: path.join(' / ') });
      walk(child, path);
    }
  };
  walk(root, []);
  return out;
}

async function init() {
  const r = await chrome.storage.sync.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };

  const select = document.getElementById('folder');
  const folders = await listFolders();
  const placeholder = new Option('Choose a folder…', '');
  placeholder.disabled = true;
  select.append(placeholder);
  for (const f of folders) select.append(new Option(f.path, f.id));
  select.value = folders.some((f) => f.id === settings.folderId) ? settings.folderId : '';
  select.addEventListener('change', () => {
    save({ folderId: select.value }, 'Saved. Open FavCH from the toolbar to see your channels.');
  });

  const current = document.querySelector(`input[name="theme"][value="${settings.theme}"]`);
  if (current) current.checked = true;
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => save({ theme: input.value }));
  });

  const muted = document.getElementById('muted');
  muted.value = (settings.mutedWords || []).join('\n');
  let typing;
  muted.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      save({ mutedWords: muted.value.split('\n').map((w) => w.trim()).filter(Boolean) });
    }, 500);
  });

  document.getElementById('clearCache').addEventListener('click', async () => {
    await chrome.storage.local.remove(['channelIds', 'feedCache']);
    flash('Saved channel data cleared. The next load will look every channel up again.');
  });
}

init();
