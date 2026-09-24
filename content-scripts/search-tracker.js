import { recordSearchVisit, searchQueryOf } from '../lib/searches.js';
import { reportError, stackOf, installUncaughtErrorCapture } from '../lib/diagnostics.js';
import {
  isContextInvalidated,
  isContextInvalidatedError,
  haltOnContextInvalidated,
  onContextInvalidated,
} from '../lib/extension-context.js';

// Keeps the sidepanel's list of searches: whatever search the vacancy search page shows gets recorded
// there, whether the page was loaded or (hh.ru applies filters without a reload) rewritten in place.

const SEARCH_PATH = '/search/vacancy';

// The row of filter chips under the search box lists every filter the page offers; the applied ones are
// told apart by their delete button ("Опыт" is an empty slot, "От 3 до 6 лет" with a ✕ is a filter in use)
const CHIP_SELECTOR = '[data-qa="header-search-chips-container"] [data-qa="chip"]';
const CHIP_LABEL_SELECTOR = '[data-qa^="search-filter-"]';
const CHIP_DELETE_SELECTOR = '[data-qa="chip-delete-action"]';

// The page changes constantly, and a filter change lands in pieces (the URL first, the chips a moment
// later), so the DOM is looked at once per this period, not on every mutation. The first mutation starts
// the period: a page that never stops changing must not be able to postpone the look forever.
const CHECK_PERIOD_MS = 600;

function readChips() {
  return [...document.querySelectorAll(CHIP_SELECTOR)]
    .filter((chip) => chip.querySelector(CHIP_DELETE_SELECTOR))
    .map((chip) => chip.querySelector(CHIP_LABEL_SELECTOR)?.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// null when the page isn't a search: the script outlives the search page inside one document (hh.ru
// swaps pages without reloading), so this is asked every time
function readSearch() {
  if (location.pathname !== SEARCH_PATH) return null;

  const query = searchQueryOf(location.href);
  if (!query) return null;

  const text = new URL(location.href).searchParams.get('text') ?? '';
  return { query, text, chips: readChips() };
}

let lastRecorded = null;

async function recordCurrentSearch() {
  const search = readSearch();
  if (!search) return;

  const snapshot = JSON.stringify(search);
  if (snapshot === lastRecorded) return;
  lastRecorded = snapshot;

  try {
    await recordSearchVisit(search);
  } catch (error) {
    lastRecorded = null; // nothing was recorded — the next check tries again
    if (isContextInvalidatedError(error)) {
      haltOnContextInvalidated();
      return;
    }
    await reportError('search-tracker', `recording search failed: ${error.message}`, stackOf(error));
  }
}

let checkTimer = null;

function scheduleCheck() {
  checkTimer ??= setTimeout(() => {
    checkTimer = null;
    recordCurrentSearch();
  }, CHECK_PERIOD_MS);
}

installUncaughtErrorCapture('search-tracker');

const observer = new MutationObserver(() => {
  if (!isContextInvalidated()) scheduleCheck();
});
observer.observe(document.body, { childList: true, subtree: true });
onContextInvalidated(() => {
  observer.disconnect();
  clearTimeout(checkTimer);
});

scheduleCheck();
