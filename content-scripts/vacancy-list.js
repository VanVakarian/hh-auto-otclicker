import {
  getSettings,
  getRunState,
  saveRunState,
  getBlacklist,
  addBlacklistEntry,
  addFitSpend,
  addFitHistoryEntry,
  addResponseLogEntry,
  addTraceEntry,
  getRespondedTodayCount,
  StopReason,
} from '../lib/storage.js';
import { waitFor, isVisible } from '../lib/dom.js';
import { normalizeWordGroups } from '../lib/matching.js';
import { SkipReason, skipReasonOf } from '../lib/card-rules.js';
import { blockedIds, fitRejections } from '../lib/blacklist-core.js';
import {
  FIT_RATED_TRACE,
  FitAction,
  MAX_FAILURES_IN_A_ROW,
  UnavailableReason,
  createFitStep,
} from '../lib/fit-step.js';
import { fitHistoryEntry } from '../lib/fit-history.js';
import { fitFingerprint } from '../lib/vacancy-fit.js';
import { readVacancyCard, vacancyIdOf } from '../lib/vacancy-card.js';
import { randomDelayMs, reactionDelayMs } from '../lib/pacing.js';
import { sleepUnlessStopped, humanPause, isRunStoppedError, RunStoppedError } from '../lib/run-control.js';
import { click, scrollToElement, scrollToPageBottom, fillText, navigate } from '../lib/interaction.js';
import { startPageWatchers } from '../lib/page-watchers.js';
import { reportError, reportWarning, stackOf, installUncaughtErrorCapture } from '../lib/diagnostics.js';
import {
  isContextInvalidatedError,
  haltOnContextInvalidated,
  onContextInvalidated,
} from '../lib/extension-context.js';
import { VACANCY_CARD_SELECTOR, PAGER_SELECTOR, findNextPageLink } from '../lib/hh-pages.js';

const RESPONSE_BUTTON_SELECTOR = '[data-qa="vacancy-serp__vacancy_response"]';

// hh.ru renders a result page in stages — the first vacancies show up, the rest of them and the pager
// only later or once the page is scrolled to its end. "Nothing left to respond to and no next-page
// link" is therefore not a verdict until the end of the page has been visited and given this long
// to produce either more vacancies or the link.
const PAGE_END_ATTEMPTS = 3;
const PAGE_END_WAIT_MS = 3000;
const PAGER_DUMP_LIMIT = 12;

// in-page "Отклик на вакансию" popup — hh.ru shows this instead of navigating when the only
// extra requirement is a cover letter (no screening questions)
const MODAL_OVERLAY_SELECTOR = '[data-qa="modal-overlay"]';
const MODAL_CLOSE_SELECTOR = '[data-qa="response-popup-close"]';
const MODAL_SUBMIT_SELECTOR = '[data-qa="vacancy-response-submit-popup"]';
const MODAL_LETTER_INPUT_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
const MODAL_TASK_BODY_SELECTOR = '[data-qa="task-body"]';
// hh.ru refuses the response outright when the resume's own visibility setting excludes this
// employer — no cover letter fixes that, it's a resume-settings issue, not a missing-letter one.
// The warning block is always present in the popup's DOM (collapsed via max-height:0 when not
// applicable), so its text alone can't be used to detect the block — only its actual visibility can.
const RESUME_VISIBILITY_WARNING_SELECTOR = '[data-qa="hidden-resume-warning"]';

// hh.ru shows this confirmation (its own separate dialog, not the response popup's modal-overlay)
// when the vacancy's country differs from the resume's — it blocks the response until confirmed
const RELOCATION_WARNING_CONFIRM_SELECTOR = '[data-qa="relocation-warning-confirm"]';

const POST_RESPONSE_SETTLE_MS = 500;

const trace = (message, context, data) => addTraceEntry('list', message, context, data);

// A card the bot can respond to: everything the card says about its vacancy, plus the button and the element.
// A card that has no button (already responded to) or no vacancy to name is none.
function readCard(cardEl) {
  const responseLink = cardEl.querySelector(RESPONSE_BUTTON_SELECTOR);
  if (!responseLink) return null;
  const card = readVacancyCard(cardEl);
  if (!card.vacancyId) return null;
  return { ...card, responseLink, cardEl };
}

function findResponseButtonByVacancyId(vacancyId) {
  const cards = Array.from(document.querySelectorAll(VACANCY_CARD_SELECTOR));
  for (const cardEl of cards) {
    if (vacancyIdOf(cardEl) === vacancyId) return cardEl.querySelector(RESPONSE_BUTTON_SELECTOR);
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

// What passing a card over by a rule leaves behind: a skip by the person's own words is part of the history of
// responses, one by the blacklist only a trace
async function recordSkip(card, reason) {
  if (reason === SkipReason.BLACKLISTED) {
    await trace('skipping card: already in the blacklist', `vacancyId=${card.vacancyId} title="${card.title}"`);
    return;
  }
  const result = reason === SkipReason.COMPANY ? 'skipped_company' : 'skipped_title_stop_word';
  await addResponseLogEntry({
    at: Date.now(),
    vacancyId: card.vacancyId,
    title: card.title,
    company: card.company,
    result,
  });
}

const fitStep = createFitStep();

// The question goes to the worker, which holds the key and the network. Nothing is asked of a stopped run or under a
// captcha: the wait is the same door every pause of the bot goes through. A worker restarted by the browser
// mid-request, or one that never answers, is a failure to try again with the next card, not a verdict.
async function askClassifier(card) {
  if (!(await sleepUnlessStopped(0))) return { success: false, kind: 'skipped', error: 'the run was stopped' };

  const { responseLink, cardEl, ...vacancy } = card; // elements can't travel in a message
  try {
    return await chrome.runtime.sendMessage({ type: 'HHAA_RATE_VACANCY', payload: vacancy });
  } catch (error) {
    if (isContextInvalidatedError(error)) throw error;
    return { success: false, kind: 'transient', error: error.message };
  }
}

function unavailableMessage({ reason, error }) {
  const advice = 'Проверьте ключ и баланс OpenRouter или выключите отбор в настройках.';
  return reason === UnavailableReason.UNRESPONSIVE
    ? `Сервис отбора по Jev не отвечает (${MAX_FAILURES_IN_A_ROW} неудач подряд): ${error}. ${advice}`
    : `Отбор по Jev недоступен: ${error}. ${advice}`;
}

// Whether the bot responds to a card the free rules let through, by the classifier. What the answer has to leave
// behind is written here: its price, an entry of the history, a rejection in the blacklist, a trace of the request.
// A card that is not responded to is passed over on this page (it is marked processed by the caller).
async function fitAllows(card, fit) {
  const verdict = await fitStep({ card, ...fit, ask: askClassifier });

  if (verdict.action === FitAction.STOPPED) throw new RunStoppedError();
  if (verdict.action === FitAction.UNAVAILABLE) throw new Error(unavailableMessage(verdict));

  const { vacancyId, title } = card;
  if (verdict.action === FitAction.UNRATED) {
    const { reason, error = '' } = verdict;
    await trace('card not rated, passed over on this page', `vacancyId=${vacancyId} reason=${reason} error="${error}"`);
    return false;
  }

  if (verdict.known) {
    if (verdict.action === FitAction.SKIP) {
      await trace('skipping card: the classifier rejected it before', `vacancyId=${vacancyId} title="${title}"`);
    }
    return verdict.action === FitAction.RESPOND;
  }

  const { probability, cost, ms, entry } = verdict;
  const { company } = card;
  await addFitSpend(cost);
  await addFitHistoryEntry(
    fitHistoryEntry({ card, probability, threshold: fit.threshold, cost, ms, now: Date.now() }),
  );
  if (entry) await addBlacklistEntry(entry);
  await trace(
    FIT_RATED_TRACE,
    `vacancyId=${vacancyId} title="${title}" probability=${probability} verdict=${verdict.action} cost=${cost} ms=${ms}`,
    { vacancyId, title, company, probability, verdict: verdict.action, cost, ms },
  );
  return verdict.action === FitAction.RESPOND;
}

// what the classifier step looks at, or null while the classifier is off: then the blacklist's rejections are not
// even read, and the vacancies it once rejected are free to be responded to
function fitSetupOf(settings, blacklist) {
  if (!settings.fitEnabled) return null;
  const fingerprint = fitFingerprint(settings.fitPrompt);
  return { fingerprint, threshold: Number(settings.fitThreshold), rejections: fitRejections(blacklist, fingerprint) };
}

async function pickNextCard(runState, settings) {
  const cards = Array.from(document.querySelectorAll(VACANCY_CARD_SELECTOR));
  const blacklist = await getBlacklist();
  const rules = {
    processed: new Set(runState.processedVacancyIds || []),
    blockedIds: blockedIds(blacklist),
    companyLines: normalizeWordGroups(settings.blacklistCompaniesRaw),
    titleStopWordLines: normalizeWordGroups(settings.vacancyTitleStopWordsRaw),
  };
  const fit = fitSetupOf(settings, blacklist);
  const initialSize = rules.processed.size;
  let picked = null;

  for (const cardEl of cards) {
    const card = readCard(cardEl);
    if (!card) continue;

    const reason = skipReasonOf(card, rules);
    if (reason === SkipReason.PROCESSED) continue;
    if (reason) {
      rules.processed.add(card.vacancyId);
      await recordSkip(card, reason);
      continue;
    }

    if (fit && !(await fitAllows(card, fit))) {
      rules.processed.add(card.vacancyId);
      continue;
    }

    picked = card;
    break;
  }

  if (rules.processed.size !== initialSize) {
    await saveRunState({ processedVacancyIds: Array.from(rules.processed) });
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
  await reportWarning(
    'list',
    `${source}: navigated away from list unexpectedly`,
    `vacancyId=${card.vacancyId} title="${card.title}" strayUrl=${strayUrl} listUrl=${listUrl}`,
  );
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
  await navigate(listUrl, { replace: true });
}

async function waitForClickOutcome(vacancyId) {
  let relocationWarningConfirmed = false;

  const outcome = await waitFor(
    async () => {
      if (location.pathname.startsWith('/applicant/vacancy_response')) return 'navigated';
      if (document.querySelector(MODAL_OVERLAY_SELECTOR)) return 'modal';

      // "you're responding to a vacancy in another country" — a separate confirm dialog that blocks
      // everything else (navigation, the response popup) until "Все равно откликнуться" is clicked
      if (!relocationWarningConfirmed) {
        const relocationConfirm = document.querySelector(RELOCATION_WARNING_CONFIRM_SELECTOR);
        if (relocationConfirm) {
          relocationWarningConfirmed = true;
          await trace('relocation warning shown, confirming', `vacancyId=${vacancyId}`);
          // nobody confirms a dialog in the same instant it appears — this one has no pause of its own
          await humanPause(reactionDelayMs());
          await click(relocationConfirm);
        }
      }

      // some vacancies redirect (SPA pushState, same script instance survives) to their own
      // /vacancy/<id> page and show the response popup there instead of on the list — the URL flips
      // before the popup renders, so leaving the list can't be treated as a dead end right away; keep
      // polling for the popup until the outer timeout, same as if we'd never left the list
      if (location.pathname.startsWith('/search/vacancy') && !isStillRespondable(vacancyId)) return 'instant';
      return null;
    },
    { timeout: 6000, interval: 200 },
  );

  return outcome ?? (location.pathname.startsWith('/search/vacancy') ? 'unknown' : 'navigated_away');
}

// dismissing a popup is a reaction to having just looked at it, so it gets a person-sized beat first. A
// Stop only cuts that beat short — the popup is still closed, a stopped run must not leave it open.
async function closePopup(closeButton) {
  if (!closeButton) return;
  await sleepUnlessStopped(reactionDelayMs());
  await click(closeButton);
}

async function skipModalResponse(card, reason) {
  await addBlacklistEntry({
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
    await reportWarning('list', 'response popup has no submit button, closing', `title="${card.title}"`);
    await closePopup(closeButton);
    await skipModalResponse(card, 'popup_unrecognized');
    return;
  }

  if (overlay.querySelector(MODAL_TASK_BODY_SELECTOR)) {
    // a real questionnaire inside the popup isn't supported yet — bail out rather than submit blind
    console.log(`📋 [list] response popup has questions, skipping "${card.title}" (not supported inline)`);
    await closePopup(closeButton);
    await skipModalResponse(card, 'popup_has_questions');
    return;
  }

  if (isVisible(overlay.querySelector(RESUME_VISIBILITY_WARNING_SELECTOR))) {
    // detected up front instead of falling through the letter-fill path — filling a cover letter
    // and waiting for the button to unblock would never work here, it's not what's blocking it
    console.log(`📋 [list] response popup blocked by resume visibility settings, skipping "${card.title}"`);
    await trace('response popup blocked by resume visibility settings', `vacancyId=${card.vacancyId}`);
    await closePopup(closeButton);
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
      await closePopup(closeButton);
      await skipModalResponse(card, 'cover_letter_required');
      return;
    }

    if (haveLetterText && (isRequired || settings.coverLetterEnabled)) {
      await fillText(letterTextarea, settings.coverLetterText);
      await waitFor(() => !submitButton.disabled, { timeout: 1500 });
    }
  }

  if (submitButton.disabled) {
    await reportWarning('list', 'response popup still blocked after fill, skipping', `title="${card.title}"`);
    await closePopup(closeButton);
    await skipModalResponse(card, 'popup_blocked');
    return;
  }

  // pause before submitting so the filled popup is actually visible for a moment, like a human
  // pausing to glance over the letter before hitting send, instead of an instant fill-then-submit.
  // Interruptible so a Stop pressed during this pause skips the submit entirely rather than
  // waiting out the delay and sending a response after the user already asked to stop.
  if (!(await sleepUnlessStopped(randomDelayMs(settings.delayMinSec, settings.delayMaxSec)))) {
    await closePopup(closeButton);
    await clearPendingVacancy();
    return;
  }
  await trace('response popup: clicking submit', `vacancyId=${card.vacancyId}`);
  await click(submitButton);

  // a resolved waitFor with no captured result isn't proof of success — check whether the popup
  // actually closed before declaring the response sent
  const closed = await waitFor(() => !document.querySelector(MODAL_OVERLAY_SELECTOR), { timeout: 4000 });

  if (!closed) {
    // a watcher may have stopped the run meanwhile (the daily limit refusal shows up inside this very
    // popup) — then the popup staying open is that refusal, not a failed vacancy worth logging as one
    if ((await getRunState()).status !== 'running') {
      await closePopup(closeButton);
      await clearPendingVacancy();
      return;
    }
    // what the popup is showing right now is the only clue to why hh.ru didn't take the response
    // (validation error, captcha, a second confirmation) — captured before the popup gets closed
    const overlayText = overlay.innerText.slice(0, 300).replace(/\s+/g, ' ');
    await reportWarning(
      'list',
      'popup did not close after submit',
      `vacancyId=${card.vacancyId} title="${card.title}" submitDisabled=${submitButton.disabled} ` +
        `relocationDialog=${Boolean(document.querySelector(RELOCATION_WARNING_CONFIRM_SELECTOR))} overlayText="${overlayText}"`,
    );
    await closePopup(closeButton);
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
  console.log(`📋 [list] responded via popup to "${card.title}"`);
}

const countCards = () => document.querySelectorAll(VACANCY_CARD_SELECTOR).length;

function pageParamOf(href) {
  return new URL(href, location.origin).searchParams.get('page');
}

// One line with everything needed to judge afterwards why the bot considered the page finished: how far
// the list had rendered, what the pager held (hh.ru's own names first, then every link to any page in
// case they were renamed), where the page was scrolled to and how old the document was.
function describePage(processedCount) {
  const cards = Array.from(document.querySelectorAll(VACANCY_CARD_SELECTOR));
  const withButton = cards.filter((cardEl) => cardEl.querySelector(RESPONSE_BUTTON_SELECTOR)).length;
  const pager = Array.from(document.querySelectorAll(PAGER_SELECTOR))
    .slice(0, PAGER_DUMP_LIMIT)
    .map((el) => {
      const page = el.href ? `>page=${pageParamOf(el.href)}` : '';
      const current = el.getAttribute('aria-current') === 'true' ? '*' : '';
      return `${el.getAttribute('data-qa')}${page}${current}"${el.textContent.trim().slice(0, 12)}"`;
    });
  const pageLinks = new Set(Array.from(document.querySelectorAll('a[href*="page="]')).map((a) => pageParamOf(a.href)));
  const { scrollY, innerHeight } = window;

  return (
    `cards=${cards.length} withResponseButton=${withButton} processed=${processedCount} ` +
    `pager=[${pager.join(' ')}] pageLinks=[${[...pageLinks].join(',')}] ` +
    `scrollY=${Math.round(scrollY)} viewportH=${innerHeight} pageH=${document.documentElement.scrollHeight} ` +
    `sinceLoadMs=${Math.round(performance.now())} readyState=${document.readyState} title="${document.title.slice(0, 60)}"`
  );
}

// Visits the end of the page and waits there for whatever hh.ru still has to render — the next-page
// link or more vacancies — so the caller judges a finished page, not a half-drawn one.
async function waitForPageEnd(cardsBefore) {
  const hasNextPageLink = () => Boolean(findNextPageLink());
  const hasMoved = () => hasNextPageLink() || countCards() > cardsBefore;
  if (hasMoved()) return;

  const startedAt = Date.now();
  for (let attempt = 0; attempt < PAGE_END_ATTEMPTS && !hasMoved(); attempt++) {
    await scrollToPageBottom();
    await waitFor(hasMoved, { timeout: PAGE_END_WAIT_MS, interval: 250 });
  }

  const outcome = hasNextPageLink() ? 'next_page_appeared' : hasMoved() ? 'more_cards_appeared' : 'nothing_appeared';
  await trace(
    'waited at the end of the page',
    `outcome=${outcome} waitedMs=${Date.now() - startedAt} cards=${cardsBefore}->${countCards()}`,
  );
}

async function processNextCard() {
  const runState = await getRunState();
  if (runState.status !== 'running') return;

  // safety net: whatever path got here (a redirect this script doesn't specifically recognize
  // yet, a hh.ru quirk, anything), operating on a DOM that isn't the list is worse than just
  // going back to the known-good list URL and letting the scan resume from there
  if (!location.pathname.startsWith('/search/vacancy')) {
    await reportWarning(
      'list',
      'processNextCard invoked off the list page',
      `url=${location.href} listUrl=${runState.listUrl}`,
    );
    if (runState.listUrl) {
      await navigate(runState.listUrl, { replace: true }); // same back-button reasoning as recoverFromStrayNavigation
    } else {
      await saveRunState({ status: 'error', lastError: 'off the list page with no listUrl to recover to' });
    }
    return;
  }

  const settings = await getSettings();
  const dailyLimit = Number(settings.dailyLimit) || 200;
  const respondedToday = await getRespondedTodayCount();

  if (respondedToday >= dailyLimit) {
    console.log(`📋 [list] daily limit reached (${dailyLimit}), stopping`);
    await trace('daily limit reached, stopping', `respondedToday=${respondedToday} dailyLimit=${dailyLimit}`);
    await saveRunState({ status: 'stopped', stopReason: StopReason.DAILY_LIMIT });
    return;
  }

  // right after a response hh.ru animates an extra block into the card that was just answered, pushing
  // everything below it down — scrolling to the next card mid-animation would land on a spot that's
  // about to move, so the page gets a moment to finish first. Before the pick, not after: the card
  // is then chosen from the settled DOM, not from one that may still be re-rendering.
  if (!(await sleepUnlessStopped(POST_RESPONSE_SETTLE_MS))) return;

  const cardsOnPage = countCards();
  const card = await pickNextCard(runState, settings);

  if (!card) {
    await waitForPageEnd(cardsOnPage);
    if (countCards() > cardsOnPage) {
      await processNextCard(); // vacancies that hh.ru rendered while we waited
      return;
    }

    // a Stop pressed during the wait stays a plain Stop, not a "no more vacancies" verdict
    const currentRunState = await getRunState();
    if (currentRunState.status !== 'running') return;

    const nextPageLink = findNextPageLink();
    if (!nextPageLink) {
      console.log('📋 [list] no more vacancies and no next page, stopping');
      await trace(
        'no pickable card and no next-page link, stopping',
        describePage(currentRunState.processedVacancyIds.length),
      );
      await saveRunState({ status: 'stopped', stopReason: StopReason.NO_MORE_VACANCIES });
      return;
    }
    if (!(await sleepUnlessStopped(randomDelayMs(settings.delayMinSec, settings.delayMaxSec)))) return;
    const nextUrl = nextPageLink.href;
    console.log('📋 [list] page exhausted, moving to next page');
    await trace('page exhausted, moving to next page', `nextUrl=${nextUrl}`);
    await saveRunState({ listUrl: nextUrl, processedVacancyIds: [] });
    await navigate(nextUrl);
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

  await scrollToElement(card.cardEl);
  // let the smooth scroll settle before interacting, like a human would — interruptible so a Stop
  // pressed during this pause takes effect immediately instead of waiting out the full delay
  if (!(await sleepUnlessStopped(1100))) {
    await clearPendingVacancy();
    return;
  }

  if (!(await sleepUnlessStopped(randomDelayMs(settings.delayMinSec, settings.delayMaxSec)))) {
    await clearPendingVacancy();
    return;
  }
  console.log(`📋 [list] responding to "${card.title}" (${card.company})`);
  await trace('clicking response link', `vacancyId=${card.vacancyId} title="${card.title}" company="${card.company}"`);
  const listUrl = location.href;
  await click(card.responseLink);

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
      await navigate(listUrl, { replace: true });
    }
    return;
  }

  if (outcome === 'unknown') {
    await reportWarning(
      'list',
      'click did not appear to register',
      `vacancyId=${card.vacancyId} title="${card.title}"`,
    );
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

  await processNextCard();
}

async function start() {
  try {
    const runState = await getRunState();
    if (runState.status !== 'running') return;

    console.log('📋 [list] starting scan');
    // first proof in the report that the module actually executed (as opposed to failing to load)
    await trace('entry loaded', `readyState=${document.readyState} url=${location.href}`);
    await waitFor(() => document.querySelector(VACANCY_CARD_SELECTOR), { timeout: 8000, interval: 250 });

    await trace('scan started', `url=${location.href} ${describePage(runState.processedVacancyIds.length)}`);

    if (!document.querySelector(VACANCY_CARD_SELECTOR)) {
      const message = 'Не нашли карточки вакансий на странице — возможно, изменилась вёрстка hh.ru';
      await reportError(
        'list',
        'vacancy cards not found',
        `title="${document.title}" bodyHead="${document.body.innerText.slice(0, 200).replace(/\s+/g, ' ')}" url=${location.href}`,
      );
      await saveRunState({ status: 'error', lastError: message });
      return;
    }

    await processNextCard();
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      haltOnContextInvalidated();
      return;
    }
    // Stop pressed while held (a captcha on screen): same as every other stopped early-return here
    if (isRunStoppedError(error)) return;
    await reportError('list', `fatal error: ${error.message}`, `${location.href} ${stackOf(error)}`);
    await saveRunState({ status: 'error', lastError: error.message });
  }
}

onContextInvalidated(() => {
  // nothing can be written to the log from a dead context, and a warn here would sit on the Errors page
  console.log('📋 [list] extension was reloaded/updated — reload this page to restore the bot');
});
installUncaughtErrorCapture('list');
startPageWatchers('list');
start();
