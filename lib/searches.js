import { KEYS } from './storage.js';

// The vacancy search page keeps the whole search in its URL, so a search here is that URL's query string
// plus what the page shows for it: the query text and the chips of the applied filters (read by
// search-tracker.js). One list, newest first: pinned searches stay until unpinned, the rest are a history
// where a new search pushes out the oldest. { query, text, chips, pinned }
export const HISTORY_LIMIT = 10;

// hh.ru adds these depending on where the user came from or which page of the results this is — they
// don't change what is searched, so they must not make one search look like several
function isIgnoredParam(name) {
  return name === 'page' || name === 'L_save_area' || name.startsWith('hhtm');
}

// The identity of a search: its URL query without the noise, in a stable order
export function searchQueryOf(url) {
  const params = new URL(url).searchParams;
  for (const name of [...params.keys()]) {
    if (isIgnoredParam(name)) params.delete(name);
  }
  params.sort();
  return params.toString();
}

// `origin` is the host the user is on (a regional subdomain or the bare hh.ru) — a search isn't tied to one
export function searchUrlOf(origin, query) {
  return `${origin}/search/vacancy?${query}`;
}

function trimHistory(list) {
  let historyCount = 0;
  return list.filter((search) => search.pinned || ++historyCount <= HISTORY_LIMIT);
}

// a visit moves a search to the top of the history, or refreshes what is shown for a pinned one in place
export function withVisitedSearch(list, visit) {
  const known = list.find((search) => search.query === visit.query);
  if (known?.pinned) return list.map((search) => (search === known ? { ...known, ...visit } : search));

  const others = list.filter((search) => search !== known);
  return trimHistory([{ ...visit, pinned: false }, ...others]);
}

// pinning puts a search on top of the pinned ones, unpinning on top of the history
export function withPinned(list, query, pinned) {
  const known = list.find((search) => search.query === query);
  if (!known || known.pinned === pinned) return list;

  const others = list.filter((search) => search !== known);
  return trimHistory([{ ...known, pinned }, ...others]);
}

export async function getSearches() {
  const result = await chrome.storage.local.get(KEYS.SEARCHES);
  return result[KEYS.SEARCHES] || [];
}

async function updateSearches(change) {
  const current = await getSearches();
  const next = change(current);
  // an unchanged list isn't written: every write wakes up every listener in every open sidepanel
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  await chrome.storage.local.set({ [KEYS.SEARCHES]: next });
}

export function recordSearchVisit(visit) {
  return updateSearches((list) => withVisitedSearch(list, visit));
}

export function setSearchPinned(query, pinned) {
  return updateSearches((list) => withPinned(list, query, pinned));
}
