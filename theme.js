'use strict';
// Applies the saved light/dark choice. "system" follows the OS/browser theme.
(function () {
  const apply = (theme) => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };
  chrome.storage.sync.get('settings').then((r) => apply(r.settings?.theme));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) apply(changes.settings.newValue?.theme);
  });
})();
