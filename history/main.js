import { KEYS, getFitHistory } from '../lib/storage.js';
import { installUncaughtErrorCapture } from '../lib/diagnostics.js';
import { renderRows, renderToolbar } from './view.js';

installUncaughtErrorCapture('history');

const $ = (id) => document.getElementById(id);

let entries = [];
const ui = { filter: 'all', query: '', openKeys: new Set() };

const context = () => ({
  entries,
  ...ui,
  onToggle: (key, open) => (open ? ui.openKeys.add(key) : ui.openKeys.delete(key)),
  onFilter(filter) {
    ui.filter = filter;
    render();
  },
  onQuery(query) {
    ui.query = query;
    renderRows($('rows'), context());
  },
});

function render() {
  const ctx = context();
  renderToolbar($('toolbar'), ctx);
  renderRows($('rows'), ctx);
}

async function load() {
  entries = await getFitHistory();
  render();
}

// a run in another tab adds decisions while the page is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && KEYS.FIT_HISTORY in changes) load();
});

await load();
