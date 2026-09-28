import { KEYS, getRunState } from '../lib/storage.js';
import { HH_HOST_PATTERN, LIST_URL_PATTERN } from '../lib/hh-pages.js';
import { getSearches, setSearchPinned, searchQueryOf, searchUrlOf } from '../lib/searches.js';
import { getActiveTab, onActiveTabChange } from './active-tab.js';

let els = {};
let renderId = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The search takes over the tab the user is on — never while a run is driving it — or opens in a new one
// when the active tab isn't hh.ru at all (it isn't ours to navigate away).
async function openSearch(search) {
  // the list was drawn for an idle bot, but a run may have started since
  if ((await getRunState()).status === 'running') return;

  const tab = await getActiveTab();
  const isOnHh = HH_HOST_PATTERN.test(tab?.url || '');
  const url = searchUrlOf(isOnHh ? new URL(tab.url).origin : 'https://hh.ru', search.query);

  if (isOnHh) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
}

function renderSearch(search, { locked, currentQuery }) {
  const item = element('li', `search-item${search.query === currentQuery ? ' current' : ''}`);

  const openButton = element('button', 'search-open');
  openButton.type = 'button';
  openButton.disabled = locked;
  openButton.title = search.text;
  openButton.append(element('span', `search-text${search.text ? '' : ' empty'}`, search.text || 'Без текста'));
  if (search.chips.length > 0) {
    const chips = element('span', 'search-chips');
    chips.append(...search.chips.map((label) => element('span', 'search-chip', label)));
    openButton.append(chips);
  }
  openButton.addEventListener('click', () => openSearch(search));

  const pinButton = element('button', `search-pin${search.pinned ? ' active' : ''}`, '📌');
  pinButton.type = 'button';
  pinButton.disabled = locked;
  pinButton.title = search.pinned ? 'Открепить' : 'Закрепить';
  pinButton.addEventListener('click', () => setSearchPinned(search.query, !search.pinned));

  item.append(openButton, pinButton);
  return item;
}

function renderList(searches, options) {
  const list = element('ul', `search-list${options.locked ? ' locked' : ''}`);
  list.append(...searches.map((search) => renderSearch(search, options)));
  return list;
}

function renderGroup(title, searches, options) {
  return [element('div', 'search-group-title', title), renderList(searches, options)];
}

// The list is rebuilt from scratch on every change, so whether the history is unfolded lives here, not in
// the DOM. Folded by default.
let isHistoryOpen = false;

function renderHistoryGroup(searches, options) {
  const details = element('details', 'search-history');
  details.open = isHistoryOpen;
  details.addEventListener('toggle', () => {
    isHistoryOpen = details.open;
  });
  details.append(
    element('summary', 'search-group-title search-group-title_toggle', 'Недавние'),
    renderList(searches, options),
  );
  return [details];
}

function queryOfListUrl(url) {
  return url && LIST_URL_PATTERN.test(url) ? searchQueryOf(url) : null;
}

// While a run is going the list shrinks to the one search it is running on, frozen: nothing in it reacts
// to the mouse or the keyboard. Once the run ends the whole list comes back.
async function render() {
  const id = ++renderId;
  const [searches, runState, tab] = await Promise.all([getSearches(), getRunState(), getActiveTab()]);
  if (id !== renderId) return; // a newer render has started meanwhile — it draws the current state

  if (runState.status === 'running') {
    const currentQuery = queryOfListUrl(runState.listUrl);
    const running = searches.filter((search) => search.query === currentQuery);
    els.list.replaceChildren(...(running.length > 0 ? [renderList(running, { locked: true, currentQuery })] : []));
    els.empty.hidden = true;
    els.card.hidden = running.length === 0;
    return;
  }

  const options = { locked: false, currentQuery: queryOfListUrl(tab?.url) };
  const pinned = searches.filter((search) => search.pinned);
  const history = searches.filter((search) => !search.pinned);

  els.list.replaceChildren(
    ...(pinned.length > 0 ? renderGroup('Закреплённые', pinned, options) : []),
    ...(history.length > 0 ? renderHistoryGroup(history, options) : []),
  );
  els.empty.hidden = searches.length > 0;
  els.card.hidden = false;
}

// the list is rebuilt from scratch, so it is rebuilt only when something it shows has changed — a click
// landing on a row that was replaced between the press and the release would be lost
function isRelevantChange(changes) {
  const runChange = changes[KEYS.RUN_STATE];
  const runStatusChanged = runChange && runChange.oldValue?.status !== runChange.newValue?.status;
  return Boolean(changes[KEYS.SEARCHES] || runStatusChanged);
}

export function initSearchesView() {
  els = {
    card: document.getElementById('searchesCard'),
    list: document.getElementById('searchesList'),
    empty: document.getElementById('searchesEmpty'),
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && isRelevantChange(changes)) render();
  });
  onActiveTabChange(render);

  render();
}
