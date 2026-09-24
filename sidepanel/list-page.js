import { LIST_URL_PATTERN, VACANCY_CARD_SELECTOR } from '../lib/hh-pages.js';

// What the page of a tab looks like right now — answers "no cards / captcha / blank page" without needing
// a content script to have run there at all. Best-effort: the tab may have been closed, or the extension
// may lack access to it right now.
export async function probeTabPage(tabId) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cardSelector) => ({
        readyState: document.readyState,
        cards: document.querySelectorAll(cardSelector).length,
        bodyHead: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
      }),
      args: [VACANCY_CARD_SELECTOR],
    });
    return probe.result;
  } catch (error) {
    return { note: `page probe failed: ${error.message}` };
  }
}

// Whether a run can begin on this tab: it has to be the vacancy search with vacancies on it — the very
// thing the bot looks for first thing on a page (an empty result or a half-loaded page fails the run
// right away). `waiting` — this is a search page whose vacancies aren't there (yet): hh.ru fills in its
// results after the tab reports "complete", so the caller keeps looking.
export async function checkListPage(tab) {
  if (!LIST_URL_PATTERN.test(tab?.url || '')) {
    return {
      ok: false,
      waiting: false,
      reason: 'Откройте страницу поиска вакансий на hh.ru в активной вкладке — тогда «Старт» станет доступен.',
    };
  }

  const page = await probeTabPage(tab.id);
  if (page.cards > 0) return { ok: true, waiting: false, reason: '' };

  return {
    ok: false,
    waiting: true,
    reason: 'На странице поиска не видно вакансий — задайте поиск с результатами или дождитесь загрузки страницы.',
  };
}
