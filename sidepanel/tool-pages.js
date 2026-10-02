import { LIST_URL_PATTERN } from '../lib/hh-pages.js';
import { getRunState } from '../lib/storage.js';
import { getActiveTab } from './active-tab.js';

// The benchmark and the history are pages of their own: they have room for the figures. During a run the page
// opens in a window of its own, not in a tab of the window the bot works in — the tab with the search stays in
// front there, where the browser does not slow a hidden tab down; with no run it is an ordinary new tab.
async function openToolPage(path) {
  const url = chrome.runtime.getURL(path);
  if ((await getRunState()).status === 'running') await chrome.windows.create({ url });
  else await chrome.tabs.create({ url });
}

// The benchmark reads the cards of a search page and asks the model about them, which a tab can do just as well
// as the panel. It is told which tab the person is on, and finds a search page itself when that is not one.
export function initBenchLink() {
  document.getElementById('openBenchBtn').addEventListener('click', async () => {
    const tab = await getActiveTab();
    const onSearch = tab?.id != null && LIST_URL_PATTERN.test(tab.url || '');
    await openToolPage(`bench.html${onSearch ? `?tabId=${tab.id}` : ''}`);
  });
}

export function initHistoryLink() {
  document.getElementById('openHistoryBtn').addEventListener('click', () => openToolPage('history.html'));
}
