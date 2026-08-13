(function () {
  // background can inject this script twice for the same document (onCompleted + onHistoryStateUpdated racing)
  if (window.__hhaaListInjected) return;
  window.__hhaaListInjected = true;

  const SETTINGS_KEY = 'hhaa_settings';
  const RUN_STATE_KEY = 'hhaa_runState';
  const QUESTIONNAIRE_BLACKLIST_KEY = 'hhaa_questionnaireBlacklist';
  const RESPONSE_LOG_KEY = 'hhaa_responseLog';
  const DIAGNOSTIC_LOG_KEY = 'hhaa_diagnosticLog';

  const CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
  const RESPONSE_BUTTON_SELECTOR = '[data-qa="vacancy-serp__vacancy_response"]';
  const TITLE_SELECTOR = '[data-qa="serp-item__title-text"]';
  const EMPLOYER_SELECTOR = '[data-qa="vacancy-serp__vacancy-employer-text"]';
  const NEXT_PAGE_SELECTOR = '[data-qa="pager-next"]';

  // in-page "Отклик на вакансию" popup — hh.ru shows this instead of navigating when the only
  // extra requirement is a cover letter (no screening questions)
  const MODAL_OVERLAY_SELECTOR = '[data-qa="modal-overlay"]';
  const MODAL_CLOSE_SELECTOR = '[data-qa="response-popup-close"]';
  const MODAL_SUBMIT_SELECTOR = '[data-qa="vacancy-response-submit-popup"]';
  const MODAL_LETTER_INPUT_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
  const MODAL_TASK_BODY_SELECTOR = '[data-qa="task-body"]';
  // hh.ru refuses the response outright when the resume's own visibility setting excludes this
  // employer — no cover letter fixes that, it's a resume-settings issue, not a missing-letter one
  const RESUME_VISIBILITY_TEXT = 'видимость резюме';

  // hh.ru shows this confirmation (its own separate dialog, not the response popup's modal-overlay)
  // when the vacancy's country differs from the resume's — it blocks the response until confirmed
  const RELOCATION_WARNING_CONFIRM_SELECTOR = '[data-qa="relocation-warning-confirm"]';

  const CHAT_WIDGET_CLOSE_SELECTOR = '[data-qa="chatik-close-chatik"]';

  // hh.ru's global chat widget can pop open on its own (e.g. an employer's auto-message that
  // only accepts a button reply) while the bot is running — nothing here needs to read it, so
  // it's simplest to just close it on sight rather than support answering it.
  function watchForChatWidget() {
    const observer = new MutationObserver(async () => {
      const closeButton = document.querySelector(CHAT_WIDGET_CLOSE_SELECTOR);
      if (!closeButton) return;
      const runState = await getRunState();
      if (runState.status !== 'running') return;
      closeButton.click();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const RESPONSE_ERROR_NOTIFICATION_SELECTOR = '[data-qa="vacancy-response-error-notification"]';
  const DAILY_LIMIT_TEXT_HINT = 'не более 200 откликов';

  // hh.ru enforces its own 200-responses/24h cap server-side and shows this snackbar instead of
  // letting the response through — nothing left to try, so stop the run rather than keep clicking
  // into a wall (and burning through delay/retry cycles for nothing)
  function watchForDailyLimitNotification() {
    let triggered = false;
    const observer = new MutationObserver(async () => {
      if (triggered) return;
      const notification = document.querySelector(RESPONSE_ERROR_NOTIFICATION_SELECTOR);
      if (!notification?.textContent?.includes(DAILY_LIMIT_TEXT_HINT)) return;

      const runState = await getRunState();
      if (runState.status !== 'running') return;

      triggered = true;
      console.warn('📋 [list] hh.ru daily response limit reached, stopping run');
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module: 'list',
        message: 'hh.ru daily response limit (200/24h) reached, run stopped automatically',
      });
      await saveRunState({ status: 'stopped' });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, { timeout = 8000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function todayString() {
    return new Date().toLocaleDateString('sv-SE');
  }

  async function getSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return r[SETTINGS_KEY] || {};
  }

  async function getRunState() {
    const r = await chrome.storage.local.get(RUN_STATE_KEY);
    return r[RUN_STATE_KEY] || { status: 'idle' };
  }

  async function saveRunState(partial) {
    const current = await getRunState();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ [RUN_STATE_KEY]: next });
    return next;
  }

  async function addResponseLogEntry(entry) {
    const r = await chrome.storage.local.get(RESPONSE_LOG_KEY);
    const list = r[RESPONSE_LOG_KEY] || [];
    list.push(entry);
    if (list.length > 1000) list.splice(0, list.length - 1000);
    await chrome.storage.local.set({ [RESPONSE_LOG_KEY]: list });
  }

  async function addDiagnosticLogEntry(entry) {
    const r = await chrome.storage.local.get(DIAGNOSTIC_LOG_KEY);
    const list = r[DIAGNOSTIC_LOG_KEY] || [];
    list.push(entry);
    if (list.length > 1500) list.splice(0, list.length - 1500);
    await chrome.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: list });
  }

  // 'info'-level breadcrumb — filtered out of the on-screen feed, kept in the downloaded report.
  // The whole point is to be able to reconstruct exactly what the bot saw and decided at every
  // fork, without having to reproduce the bug live to read console output.
  function trace(message, context) {
    return addDiagnosticLogEntry({ at: Date.now(), level: 'info', module: 'list', message, context });
  }

  async function getQuestionnaireBlacklistIds() {
    const r = await chrome.storage.local.get(QUESTIONNAIRE_BLACKLIST_KEY);
    const list = r[QUESTIONNAIRE_BLACKLIST_KEY] || [];
    return new Set(list.map((e) => e.vacancyId));
  }

  async function addQuestionnaireBlacklistEntry(entry) {
    const r = await chrome.storage.local.get(QUESTIONNAIRE_BLACKLIST_KEY);
    const list = r[QUESTIONNAIRE_BLACKLIST_KEY] || [];
    list.push(entry);
    await chrome.storage.local.set({ [QUESTIONNAIRE_BLACKLIST_KEY]: list });
  }

  async function incrementRespondedToday() {
    const state = await getRunState();
    const today = todayString();
    const respondedToday = state.dateForCounter === today ? (state.respondedToday || 0) + 1 : 1;
    await saveRunState({ respondedToday, dateForCounter: today });
    return respondedToday;
  }

  // shared by the company blacklist and the vacancy-title stop words — both are "one group of
  // words per line" settings with the same matching rule, just checked against different text
  function normalizeWordGroups(raw) {
    return (raw || '')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).filter(Boolean));
  }

  // each line's words must ALL be present in the text — words don't need to be adjacent, so
  // "Администрация Самары" also matches "Администрация города Самары"
  function matchesWordGroups(text, wordGroups) {
    const normalized = (text || '').trim().toLowerCase();
    if (!normalized) return false;
    return wordGroups.some((words) => words.every((word) => normalized.includes(word)));
  }

  function randomDelayMs(minSec, maxSec) {
    const min = Math.max(0, Number(minSec) || 0);
    const max = Math.max(min, Number(maxSec) || min);
    const seconds = min + Math.random() * (max - min);
    return Math.round(seconds * 1000);
  }

  function extractVacancyId(href) {
    try {
      return new URL(href, location.origin).searchParams.get('vacancyId');
    } catch {
      return null;
    }
  }

  function fillNativeTextarea(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function readCard(cardEl) {
    const responseLink = cardEl.querySelector(RESPONSE_BUTTON_SELECTOR);
    if (!responseLink) return null;
    const vacancyId = extractVacancyId(responseLink.getAttribute('href') || '');
    if (!vacancyId) return null;
    const title = cardEl.querySelector(TITLE_SELECTOR)?.textContent?.trim() || '';
    const company = cardEl.querySelector(EMPLOYER_SELECTOR)?.textContent?.trim() || '';
    return { vacancyId, title, company, responseLink, cardEl };
  }

  function findResponseButtonByVacancyId(vacancyId) {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    for (const cardEl of cards) {
      const link = cardEl.querySelector(RESPONSE_BUTTON_SELECTOR);
      if (link && extractVacancyId(link.getAttribute('href') || '') === vacancyId) return link;
    }
    return null;
  }

  // hh.ru sometimes keeps the same button element after a successful instant response, just
  // relabels it ("Отклик отправлен" and similar) instead of removing it — checking presence alone
  // produced false "click didn't register" warnings, so the label is checked too.
  function isStillRespondable(vacancyId) {
    const link = findResponseButtonByVacancyId(vacancyId);
    if (!link) return false;
    const label = link.textContent?.trim().toLowerCase() || '';
    return label.includes('откликнуться');
  }

  async function pickNextCard(runState, settings) {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const blacklistIds = await getQuestionnaireBlacklistIds();
    const companyLines = normalizeWordGroups(settings.blacklistCompaniesRaw);
    const titleStopWordLines = normalizeWordGroups(settings.vacancyTitleStopWordsRaw);
    const processed = new Set(runState.processedVacancyIds || []);
    const initialSize = processed.size;
    let picked = null;

    for (const cardEl of cards) {
      const card = readCard(cardEl);
      if (!card || processed.has(card.vacancyId)) continue;

      if (blacklistIds.has(card.vacancyId)) {
        processed.add(card.vacancyId);
        await trace(
          'skipping card: already in questionnaire blacklist',
          `vacancyId=${card.vacancyId} title="${card.title}"`,
        );
        continue;
      }

      if (matchesWordGroups(card.company, companyLines)) {
        processed.add(card.vacancyId);
        await addResponseLogEntry({
          at: Date.now(),
          vacancyId: card.vacancyId,
          title: card.title,
          company: card.company,
          result: 'skipped_company',
        });
        continue;
      }

      if (matchesWordGroups(card.title, titleStopWordLines)) {
        processed.add(card.vacancyId);
        await addResponseLogEntry({
          at: Date.now(),
          vacancyId: card.vacancyId,
          title: card.title,
          company: card.company,
          result: 'skipped_title_stop_word',
        });
        continue;
      }

      picked = card;
      break;
    }

    if (processed.size !== initialSize) {
      await saveRunState({ processedVacancyIds: Array.from(processed) });
    }
    return picked;
  }

  async function markProcessed(vacancyId) {
    const runState = await getRunState();
    const processed = new Set(runState.processedVacancyIds || []);
    processed.add(vacancyId);
    await saveRunState({ processedVacancyIds: Array.from(processed) });
  }

  async function clearPendingVacancy() {
    await saveRunState({ pendingVacancy: null, currentVacancyTitle: null, currentVacancyCompany: null });
  }

  // hh.ru sometimes takes a response action to the vacancy's own /vacancy/<id> page instead of
  // staying on the list or going to /applicant/vacancy_response — that page has no injected script
  // (background.js only matches the list and the questionnaire), so without this the run would go
  // silent there forever. Whether the response itself actually went through can't be confirmed from
  // here, so it's logged as uncertain rather than a false success — driving back to the list is what
  // lets the run actually continue either way.
  async function recoverFromStrayNavigation(card, listUrl, source) {
    const strayUrl = location.href;
    console.warn(`📋 [list] ${source} left the list ("${strayUrl}") for "${card.title}", returning to list`);
    await addDiagnosticLogEntry({
      at: Date.now(),
      level: 'warn',
      module: 'list',
      message: `${source}: navigated away from list unexpectedly`,
      context: `vacancyId=${card.vacancyId} title="${card.title}" strayUrl=${strayUrl} listUrl=${listUrl}`,
    });
    await markProcessed(card.vacancyId);
    await addResponseLogEntry({
      at: Date.now(),
      vacancyId: card.vacancyId,
      title: card.title,
      company: card.company,
      result: 'uncertain_navigated_away',
    });
    await clearPendingVacancy();
    // replace, not a normal navigation — this is undoing an unwanted detour, not a step the user
    // took on purpose, so it shouldn't leave the stray page sitting in browser history either
    // (otherwise the back button would land right back on it instead of the real previous page)
    location.replace(listUrl);
  }

  async function waitForClickOutcome(vacancyId, { timeout = 6000, interval = 200 } = {}) {
    const start = Date.now();
    let relocationWarningConfirmed = false;

    while (Date.now() - start < timeout) {
      if (location.pathname.startsWith('/applicant/vacancy_response')) return 'navigated';
      if (document.querySelector(MODAL_OVERLAY_SELECTOR)) return 'modal';

      // "you're responding to a vacancy in another country" — a separate confirm dialog that blocks
      // everything else (navigation, the response popup) until "Все равно откликнуться" is clicked
      if (!relocationWarningConfirmed) {
        const relocationConfirm = document.querySelector(RELOCATION_WARNING_CONFIRM_SELECTOR);
        if (relocationConfirm) {
          relocationWarningConfirmed = true;
          await trace('relocation warning shown, confirming', `vacancyId=${vacancyId}`);
          relocationConfirm.click();
        }
      }

      // some vacancies redirect (SPA pushState, same script instance survives) to their own
      // /vacancy/<id> page and show the response popup there instead of on the list — the URL flips
      // before the popup renders, so leaving the list can't be treated as a dead end right away; keep
      // polling for the popup until the outer timeout, same as if we'd never left the list
      if (location.pathname.startsWith('/search/vacancy') && !isStillRespondable(vacancyId)) return 'instant';
      await sleep(interval);
    }
    return location.pathname.startsWith('/search/vacancy') ? 'unknown' : 'navigated_away';
  }

  async function skipModalResponse(card, reason) {
    await addQuestionnaireBlacklistEntry({
      vacancyId: card.vacancyId,
      title: card.title,
      company: card.company,
      reason,
      at: Date.now(),
    });
    await addResponseLogEntry({
      at: Date.now(),
      vacancyId: card.vacancyId,
      title: card.title,
      company: card.company,
      result: 'skipped_popup',
    });
    await markProcessed(card.vacancyId);
    await clearPendingVacancy();
  }

  // hh.ru shows this popup in place (no navigation) when a vacancy needs at most a cover letter,
  // no screening questions — full questionnaires still use the dedicated page.
  async function handleResponseModal(card) {
    const overlay = document.querySelector(MODAL_OVERLAY_SELECTOR);
    const closeButton = overlay?.querySelector(MODAL_CLOSE_SELECTOR);
    const submitButton = overlay?.querySelector(MODAL_SUBMIT_SELECTOR);

    await trace(
      'response popup opened',
      `vacancyId=${card.vacancyId} hasSubmitButton=${Boolean(submitButton)} hasTaskBody=${Boolean(overlay?.querySelector(MODAL_TASK_BODY_SELECTOR))} hasLetterInput=${Boolean(overlay?.querySelector(MODAL_LETTER_INPUT_SELECTOR))}`,
    );

    if (!submitButton) {
      console.warn(`📋 [list] response popup has no submit button, closing for "${card.title}"`);
      closeButton?.click();
      await skipModalResponse(card, 'popup_unrecognized');
      return;
    }

    if (overlay.querySelector(MODAL_TASK_BODY_SELECTOR)) {
      // a real questionnaire inside the popup isn't supported yet — bail out rather than submit blind
      console.log(`📋 [list] response popup has questions, skipping "${card.title}" (not supported inline)`);
      closeButton?.click();
      await skipModalResponse(card, 'popup_has_questions');
      return;
    }

    if (overlay.textContent.toLowerCase().includes(RESUME_VISIBILITY_TEXT)) {
      // detected up front instead of falling through the letter-fill path — filling a cover letter
      // and waiting for the button to unblock would never work here, it's not what's blocking it
      console.log(`📋 [list] response popup blocked by resume visibility settings, skipping "${card.title}"`);
      await trace('response popup blocked by resume visibility settings', `vacancyId=${card.vacancyId}`);
      closeButton?.click();
      await skipModalResponse(card, 'resume_visibility_blocked');
      return;
    }

    const settings = await getSettings();
    const letterTextarea = overlay.querySelector(MODAL_LETTER_INPUT_SELECTOR);

    if (letterTextarea) {
      const isRequired = submitButton.disabled;
      const haveLetterText = Boolean(settings.coverLetterText && settings.coverLetterText.trim());

      if (isRequired && !haveLetterText) {
        console.log(`📋 [list] response popup requires a cover letter we don't have, skipping "${card.title}"`);
        closeButton?.click();
        await skipModalResponse(card, 'cover_letter_required');
        return;
      }

      if (haveLetterText && (isRequired || settings.coverLetterEnabled)) {
        fillNativeTextarea(letterTextarea, settings.coverLetterText);
        await waitFor(() => !submitButton.disabled, { timeout: 1500 });
      }
    }

    if (submitButton.disabled) {
      console.warn(`📋 [list] response popup still blocked after fill, skipping "${card.title}"`);
      closeButton?.click();
      await skipModalResponse(card, 'popup_blocked');
      return;
    }

    // pause before submitting so the filled popup is actually visible for a moment, like a human
    // pausing to glance over the letter before hitting send, instead of an instant fill-then-submit
    await sleep(randomDelayMs(settings.delayMinSec, settings.delayMaxSec));
    await trace('response popup: clicking submit', `vacancyId=${card.vacancyId}`);
    submitButton.click();

    // a resolved waitFor with no captured result isn't proof of success — check whether the popup
    // actually closed before declaring the response sent
    const closed = await waitFor(() => !document.querySelector(MODAL_OVERLAY_SELECTOR), { timeout: 4000 });

    if (!closed) {
      console.warn(`📋 [list] response popup did not close after submit for "${card.title}", treating as failed`);
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module: 'list',
        message: 'popup did not close after submit',
        context: `vacancyId=${card.vacancyId} title="${card.title}"`,
      });
      closeButton?.click();
      await addResponseLogEntry({
        at: Date.now(),
        vacancyId: card.vacancyId,
        title: card.title,
        company: card.company,
        result: 'error',
      });
      await markProcessed(card.vacancyId);
      await clearPendingVacancy();
      return;
    }

    // the popup closing right after our own submit click is proof enough on its own — whether we're
    // still on the list or ended up on the vacancy's own /vacancy/<id> page (hh.ru shows this same
    // popup there too), the response went through; the caller returns to listUrl either way
    await markProcessed(card.vacancyId);
    await clearPendingVacancy();
    await addResponseLogEntry({
      at: Date.now(),
      vacancyId: card.vacancyId,
      title: card.title,
      company: card.company,
      result: 'success_popup',
    });
    await incrementRespondedToday();
    console.log(`📋 [list] responded via popup to "${card.title}"`);
  }

  async function processNextCard() {
    const runState = await getRunState();
    if (runState.status !== 'running') return;

    // safety net: whatever path got here (a redirect this script doesn't specifically recognize
    // yet, a hh.ru quirk, anything), operating on a DOM that isn't the list is worse than just
    // going back to the known-good list URL and letting the scan resume from there
    if (!location.pathname.startsWith('/search/vacancy')) {
      console.warn(`📋 [list] processNextCard running off the list page ("${location.href}"), returning to list`);
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module: 'list',
        message: 'processNextCard invoked off the list page',
        context: `url=${location.href} listUrl=${runState.listUrl}`,
      });
      if (runState.listUrl) {
        location.replace(runState.listUrl); // replace, same back-button reasoning as recoverFromStrayNavigation
      } else {
        await saveRunState({ status: 'error', lastError: 'off the list page with no listUrl to recover to' });
      }
      return;
    }

    const settings = await getSettings();
    const dailyLimit = Number(settings.dailyLimit) || 200;
    const respondedToday = runState.dateForCounter === todayString() ? runState.respondedToday || 0 : 0;

    if (respondedToday >= dailyLimit) {
      console.log(`📋 [list] daily limit reached (${dailyLimit}), stopping`);
      await trace('daily limit reached, stopping', `respondedToday=${respondedToday} dailyLimit=${dailyLimit}`);
      await saveRunState({ status: 'stopped' });
      return;
    }

    const cardsOnPage = document.querySelectorAll(CARD_SELECTOR).length;
    const card = await pickNextCard(runState, settings);

    if (!card) {
      const nextPageLink = document.querySelector(NEXT_PAGE_SELECTOR);
      if (!nextPageLink) {
        console.log('📋 [list] no more vacancies and no next page, stopping');
        await trace('no pickable card and no next-page link, stopping', `cardsOnPage=${cardsOnPage}`);
        await saveRunState({ status: 'stopped' });
        return;
      }
      await sleep(randomDelayMs(settings.delayMinSec, settings.delayMaxSec));
      const nextUrl = nextPageLink.href;
      console.log('📋 [list] page exhausted, moving to next page');
      await trace('page exhausted, moving to next page', `nextUrl=${nextUrl}`);
      await saveRunState({ listUrl: nextUrl, processedVacancyIds: [] });
      location.href = nextUrl;
      return;
    }

    await saveRunState({
      listUrl: location.href,
      pendingVacancy: { vacancyId: card.vacancyId, title: card.title, company: card.company },
      currentVacancyTitle: card.title,
      currentVacancyCompany: card.company,
      // a leftover true from a previous questionnaire wait (e.g. abandoned by a stray navigation
      // instead of an actual decision) would otherwise make the sidepanel show a stale approval
      // card for this brand-new, not-yet-filled vacancy
      awaitingApproval: false,
    });

    card.cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(1100); // let the smooth scroll settle before interacting, like a human would

    await sleep(randomDelayMs(settings.delayMinSec, settings.delayMaxSec));
    console.log(`📋 [list] responding to "${card.title}" (${card.company})`);
    await trace(
      'clicking response link',
      `vacancyId=${card.vacancyId} title="${card.title}" company="${card.company}"`,
    );
    const listUrl = location.href;
    card.responseLink.click();

    const outcome = await waitForClickOutcome(card.vacancyId);
    await trace('response click outcome', `vacancyId=${card.vacancyId} outcome=${outcome} url=${location.href}`);

    if (outcome === 'navigated') {
      // navigation to the questionnaire is underway — this script instance is about to be torn down
      return;
    }

    if (outcome === 'navigated_away') {
      await recoverFromStrayNavigation(card, listUrl, 'response click');
      return;
    }

    if (outcome === 'modal') {
      await handleResponseModal(card);
      // the popup can show up on the vacancy's own /vacancy/<id> page instead of the list (see
      // waitForClickOutcome) — head back to the list ourselves instead of falling into
      // processNextCard's off-list recovery path, which is meant for genuine anomalies
      if (location.pathname.startsWith('/search/vacancy')) {
        await processNextCard();
      } else {
        await trace('response popup handled off the list, returning', `vacancyId=${card.vacancyId}`);
        location.replace(listUrl);
      }
      return;
    }

    if (outcome === 'unknown') {
      console.warn(`📋 [list] response button still present after click for "${card.title}", skipping`);
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module: 'list',
        message: 'click did not appear to register',
        context: `vacancyId=${card.vacancyId} title="${card.title}"`,
      });
      await addResponseLogEntry({
        at: Date.now(),
        vacancyId: card.vacancyId,
        title: card.title,
        company: card.company,
        result: 'error',
      });
      await markProcessed(card.vacancyId);
      await processNextCard();
      return;
    }

    // outcome === 'instant'
    await markProcessed(card.vacancyId);
    await clearPendingVacancy();
    await addResponseLogEntry({
      at: Date.now(),
      vacancyId: card.vacancyId,
      title: card.title,
      company: card.company,
      result: 'success_instant',
    });
    await incrementRespondedToday();

    await processNextCard();
  }

  async function start() {
    try {
      const runState = await getRunState();
      if (runState.status !== 'running') return;

      console.log('📋 [list] starting scan');
      await waitFor(() => document.querySelector(CARD_SELECTOR));

      const foundCards = document.querySelectorAll(CARD_SELECTOR).length;
      await trace('scan started', `url=${location.href} cardsFound=${foundCards}`);

      if (!document.querySelector(CARD_SELECTOR)) {
        const message = 'Не нашли карточки вакансий на странице — возможно, изменилась вёрстка hh.ru';
        console.error(`📋 [list] ${message}`);
        await addDiagnosticLogEntry({
          at: Date.now(),
          level: 'error',
          module: 'list',
          message: 'vacancy cards not found',
          context: location.href,
        });
        await saveRunState({ status: 'error', lastError: message });
        return;
      }

      await processNextCard();
    } catch (error) {
      console.error(`📋 [list] fatal error: ${error.message}`);
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'error',
        module: 'list',
        message: error.message,
        context: location.href,
      });
      await saveRunState({ status: 'error', lastError: error.message });
    }
  }

  watchForChatWidget();
  watchForDailyLimitNotification();
  start();
})();
