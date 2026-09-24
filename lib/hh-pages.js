// What the extension knows about hh.ru's pages — the one place, shared by the service worker, the
// content scripts and the sidepanel.

// hh.ru redirects logged-in users to a regional subdomain (samara.hh.ru, spb.hh.ru, ...) instead of
// keeping them on the bare hh.ru host, so every pattern here has to allow an optional subdomain.
export const HH_HOST_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\//;
export const LIST_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/search\/vacancy/;
export const QUESTIONNAIRE_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/applicant\/vacancy_response/;
export const CHAT_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/chat/;

export const VACANCY_CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
