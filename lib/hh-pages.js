// What the extension knows about hh.ru's pages — the one place, shared by the service worker, the
// content scripts and the sidepanel.

// hh.ru redirects logged-in users to a regional subdomain (samara.hh.ru, spb.hh.ru, ...) instead of
// keeping them on the bare hh.ru host, so every pattern here has to allow an optional subdomain.
export const HH_HOST_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\//;
export const LIST_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/search\/vacancy/;
export const QUESTIONNAIRE_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/applicant\/vacancy_response/;
export const CHAT_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/chat/;

export const VACANCY_CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
export const NEXT_PAGE_SELECTOR = '[data-qa="pager-next"]';
// everything hh.ru calls a pager part (block, page links, next) — for diagnostics, never for decisions
export const PAGER_SELECTOR = '[data-qa^="pager"]';

// hh.ru's "Пройдите капчу" dialog: its picture and input are the only parts that identify it. Shared by the
// in-page watcher and the service worker, which has to look for the dialog on pages no script runs on.
export const CAPTCHA_PICTURE_SELECTOR = '[data-qa="account-captcha-picture"]';
export const CAPTCHA_INPUT_SELECTOR = '[data-qa="account-captcha-input"]';
// what the auto-solver needs on top: "Другой текст" asks for a new picture; the language button offers the
// OTHER language (its label is "English" while the picture is Russian); the dialog's own submit button has
// no data-qa, it is only found as the type="submit" button of the dialog that holds the input
export const CAPTCHA_RENEW_SELECTOR = '[data-qa="captcha-renew-text"]';
export const CAPTCHA_LANGUAGE_SELECTOR = '[data-qa="captcha-language"]';
export const CAPTCHA_DIALOG_SELECTOR = '[role="dialog"]';
