// What the extension knows about hh.ru's pages — the one place, shared by the service worker, the
// content scripts and the sidepanel.

// hh.ru redirects logged-in users to a regional subdomain (samara.hh.ru, spb.hh.ru, ...) instead of
// keeping them on the bare hh.ru host, so every pattern here has to allow an optional subdomain.
export const HH_HOST_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\//;
export const LIST_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/search\/vacancy/;
export const QUESTIONNAIRE_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/applicant\/vacancy_response/;
export const CHAT_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/chat/;

// what kind of page an address is, for the places that only report it: the report of a run, the log of a captcha
export function classifyUrl(url) {
  if (typeof url !== 'string') return 'unknown';
  if (LIST_URL_PATTERN.test(url)) return 'list';
  if (QUESTIONNAIRE_URL_PATTERN.test(url)) return 'questionnaire';
  if (HH_HOST_PATTERN.test(url)) return 'other_hh_page';
  return 'non_hh_page';
}

export const VACANCY_CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
// parts of a search-result card (see vacancy-card.js); the two snippets exist only in the expanded view
export const VACANCY_TITLE_SELECTOR = '[data-qa="serp-item__title-text"]';
export const VACANCY_TITLE_LINK_SELECTOR = '[data-qa="serp-item__title"]';
export const VACANCY_EMPLOYER_SELECTOR = '[data-qa="vacancy-serp__vacancy-employer-text"]';
export const VACANCY_ADDRESS_SELECTOR = '[data-qa="vacancy-serp__vacancy-address"]';
export const VACANCY_EXPERIENCE_SELECTOR = '[data-qa^="vacancy-serp__vacancy-work-experience"]';
export const VACANCY_WORK_FORMAT_SELECTOR = '[data-qa^="vacancy-label-work-schedule"]';
export const VACANCY_RESPONSIBILITY_SELECTOR = '[data-qa="vacancy-serp__vacancy_snippet_responsibility"]';
export const VACANCY_REQUIREMENT_SELECTOR = '[data-qa="vacancy-serp__vacancy_snippet_requirement"]';
export const VACANCY_RESPONDED_SELECTOR = '[data-qa="vacancy-serp__vacancy_responded"]';
const NEXT_PAGE_BUTTON_SELECTOR = '[data-qa="pager-next"]';
const PAGER_PAGE_SELECTOR = '[data-qa="pager-page"]';
// everything hh.ru calls a pager part (block, page links, next) — for diagnostics, never for decisions
export const PAGER_SELECTOR = '[data-qa^="pager"]';

// The link to the next result page, or null on the last one. Some pagers have a next button; others
// ("...-without-navigation-buttons") hold only the numbered links with the current one marked by
// aria-current — there the next page is the link right after it.
export function findNextPageLink(root = document) {
  const nextButton = root.querySelector(NEXT_PAGE_BUTTON_SELECTOR);
  if (nextButton) return nextButton;

  const pageLinks = Array.from(root.querySelectorAll(PAGER_PAGE_SELECTOR));
  const currentIndex = pageLinks.findIndex((link) => link.getAttribute('aria-current') === 'true');
  return currentIndex === -1 ? null : (pageLinks[currentIndex + 1] ?? null);
}

// hh.ru's "Пройдите капчу" dialog: its picture and input are the only parts that identify it. Shared by the
// in-page watcher and the service worker, which has to look for the dialog on pages no script runs on.
// hh.ru serves its pages in several template variants (per account, per experiment), so each part is also
// found by what it IS when the data-qa is missing: the picture by its address, the input by its name.
export const CAPTCHA_PICTURE_SELECTOR = '[data-qa="account-captcha-picture"], img[src*="/captcha/picture"]';
export const CAPTCHA_INPUT_SELECTOR = '[data-qa="account-captcha-input"], input[name="captchaText"]';
// what the auto-solver needs on top: "Другой текст" asks for a new picture; the language button offers the
// OTHER language (its label is "English" while the picture is Russian); the dialog's own submit button has
// no data-qa, it is only found as the type="submit" button of the dialog that holds the input
export const CAPTCHA_RENEW_SELECTOR = '[data-qa="captcha-renew-text"]';
export const CAPTCHA_LANGUAGE_SELECTOR = '[data-qa="captcha-language"]';
// the dialog around the input: the nearest of hh.ru's modal, its overlay, or a plain form
export const CAPTCHA_DIALOG_SELECTOR = '[role="dialog"], [data-qa="modal-overlay"], form';
// where the dialog's submit button is looked for, in this order: the usual one, then the modal's footer
export const CAPTCHA_SUBMIT_SELECTORS = ['button[type="submit"]', '[data-qa="modal-footer"] button:last-of-type'];
