'use strict';

// Clicking the toolbar icon opens the feed page.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'feed.html' });
});

// On first install, open Settings so the user can choose their folder.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
