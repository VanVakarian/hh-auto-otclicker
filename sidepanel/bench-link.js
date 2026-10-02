import { LIST_URL_PATTERN } from '../lib/hh-pages.js';
import { getActiveTab } from './active-tab.js';

// The benchmark is a page of its own in a new tab (bench.html): it reads the cards of a search page and asks
// the model about them, which a tab can do just as well as the panel — and with room for the figures. It is
// told which tab the person is on, and finds a search page itself when that is not one.
export function initBenchLink() {
  document.getElementById('openBenchBtn').addEventListener('click', async () => {
    const tab = await getActiveTab();
    const onSearch = tab?.id != null && LIST_URL_PATTERN.test(tab.url || '');
    chrome.tabs.create({ url: chrome.runtime.getURL(`bench.html${onSearch ? `?tabId=${tab.id}` : ''}`) });
  });
}
