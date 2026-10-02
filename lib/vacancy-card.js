import {
  VACANCY_TITLE_SELECTOR,
  VACANCY_EMPLOYER_SELECTOR,
  VACANCY_TITLE_LINK_SELECTOR,
  VACANCY_ADDRESS_SELECTOR,
  VACANCY_EXPERIENCE_SELECTOR,
  VACANCY_WORK_FORMAT_SELECTOR,
  VACANCY_RESPONSIBILITY_SELECTOR,
  VACANCY_REQUIREMENT_SELECTOR,
  VACANCY_RESPONDED_SELECTOR,
} from './hh-pages.js';

const textOf = (el) => el?.textContent?.replace(/\s+/g, ' ').trim() || '';

// The one identifier of a vacancy everywhere (the blacklist, the processed list): the number in the link of its
// title, which every card has. A card's response button carries the same number in its own link.
export function vacancyIdOf(cardEl) {
  const href = cardEl.querySelector(VACANCY_TITLE_LINK_SELECTOR)?.getAttribute('href') || '';
  return href.match(/\/vacancy\/(\d+)/)?.[1] || null;
}

// What a search-result card says about its vacancy, read for any card — one already responded to as well.
// The list script and the benchmark read their cards with it, so both see a vacancy the same way.
//
// `responsibilities` and `requirements` are the two snippets hh.ru adds to every card in its expanded view
// (`enable_snippets=true` in the search URL); a card of the compact view has neither, and they come back
// empty. Each is cut off by hh.ru at about 130-190 characters, and the words the search matched sit in
// their own <span>s — textContent joins them back into plain text.
export function readVacancyCard(cardEl) {
  return {
    vacancyId: vacancyIdOf(cardEl),
    title: textOf(cardEl.querySelector(VACANCY_TITLE_SELECTOR)),
    company: textOf(cardEl.querySelector(VACANCY_EMPLOYER_SELECTOR)),
    location: textOf(cardEl.querySelector(VACANCY_ADDRESS_SELECTOR)),
    experience: textOf(cardEl.querySelector(VACANCY_EXPERIENCE_SELECTOR)),
    workFormat: textOf(cardEl.querySelector(VACANCY_WORK_FORMAT_SELECTOR)),
    responsibilities: textOf(cardEl.querySelector(VACANCY_RESPONSIBILITY_SELECTOR)),
    requirements: textOf(cardEl.querySelector(VACANCY_REQUIREMENT_SELECTOR)),
    responded: Boolean(cardEl.querySelector(VACANCY_RESPONDED_SELECTOR)),
  };
}
