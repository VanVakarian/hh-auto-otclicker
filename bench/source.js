import { VACANCY_CARD_SELECTOR } from '../lib/hh-pages.js';

// The benchmark page lives in a tab of its own and works on the search results open in ANOTHER tab: that
// tab stays loaded and scriptable while it is in the background, so the page can read its cards from here.

const LIST_TAB_MATCH = ['https://*.hh.ru/search/vacancy*'];

// the tab the person came from (`preferredTabId`) if it is still a search page, otherwise the search page
// they used last
export async function findListTab(preferredTabId) {
  const tabs = await chrome.tabs.query({ url: LIST_TAB_MATCH });
  return (
    tabs.find((tab) => tab.id === preferredTabId) ??
    tabs.toSorted((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ??
    null
  );
}

// Every card of the page, answered-to ones included, read by the same module the run uses: the script
// imports it from the extension, the cards come back as plain objects
export async function readCards(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (moduleUrl, cardSelector) => {
      const { readVacancyCard } = await import(moduleUrl);
      return Array.from(document.querySelectorAll(cardSelector), readVacancyCard);
    },
    args: [chrome.runtime.getURL('lib/vacancy-card.js'), VACANCY_CARD_SELECTOR],
  });
  return (injection?.result ?? []).filter((card) => card.vacancyId && card.title);
}

// hh.ru adds the two snippets to every card of its expanded view and to none of the compact one
export const viewOf = (cards) =>
  cards.some((card) => card.responsibilities || card.requirements) ? 'expanded' : 'compact';
