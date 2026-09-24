import { generateAnswers, generateChatReply } from './lib/llm.js';
import {
  KEYS,
  addNavigationLogEntry,
  getRunState,
  saveRunState,
  addResponseLogEntry,
  addDiagnosticLogEntry,
} from './lib/storage.js';

chrome.runtime.onInstalled.addListener(async () => {
  console.log('🧠 [background] installed, enabling side panel on action click');
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// hh.ru redirects logged-in users to a regional subdomain (samara.hh.ru, spb.hh.ru, ...) instead of
// keeping them on the bare hh.ru host, so every pattern here has to allow an optional subdomain.
const LIST_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/search\/vacancy/;
const QUESTIONNAIRE_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/applicant\/vacancy_response/;
const CHAT_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/chat/;

// A hard (non-SPA) navigation kills a content script's JS context outright the instant it commits —
// no error, no catch, whatever was mid-`await` just stops existing. That means self-recovery code
// living inside vacancy-list.js/vacancy-questionnaire.js can only ever save a run when the stray
// navigation was an SPA pushState (context survives). When hh.ru instead does a real navigation
// (e.g. after a response/questionnaire submit landing on the vacancy's own /vacancy/<id> page),
// nothing in-page can run there ever again — background.js's service worker is the only thing not
// tied to that tab's document lifecycle, so it's the one place a recovery is actually guaranteed.
// onCompleted and onHistoryStateUpdated both fire for the same real navigation — without this guard
// a single stray landing gets "recovered" twice (double diagnostic entry, double tabs.update racing
// each other). Lives only for this service worker's lifetime, which is fine: it's a debounce, not
// state that needs to survive a worker restart.
const recoveringTabs = new Set();

async function recoverStrayTab(tabId, url) {
  if (recoveringTabs.has(tabId)) return;

  const runState = await getRunState();
  if (runState.status !== 'running' || runState.tabId !== tabId || !runState.listUrl) return;
  if (url === runState.listUrl) return;

  recoveringTabs.add(tabId);
  setTimeout(() => recoveringTabs.delete(tabId), 5000);

  console.warn(
    `🧠 [background] tab ${tabId} landed on "${url}" with no matching content script while running, recovering`,
  );

  await addDiagnosticLogEntry({
    at: Date.now(),
    level: 'warn',
    module: 'background',
    message:
      'tab landed on unrecognized page while running (content script never had a chance to recover), forcing return to list',
    context: `url=${url} listUrl=${runState.listUrl} tabId=${tabId}`,
  });

  const pending = runState.pendingVacancy;
  if (pending) {
    const processed = new Set(runState.processedVacancyIds || []);
    processed.add(pending.vacancyId);
    await saveRunState({
      processedVacancyIds: Array.from(processed),
      pendingVacancy: null,
      currentVacancyTitle: null,
      currentVacancyCompany: null,
    });
    await addResponseLogEntry({
      at: Date.now(),
      vacancyId: pending.vacancyId,
      title: pending.title,
      company: pending.company,
      result: 'uncertain_navigated_away',
    });
  }

  try {
    await chrome.tabs.update(tabId, { url: runState.listUrl });
  } catch (error) {
    console.error(`🧠 [background] failed to navigate tab ${tabId} back to list: ${error.message}`);
  }
}

// a script that never loaded can't report anything itself, so the failure is surfaced from here:
// into the diagnostic log (and the sidepanel feed) always, and as a run error when this is the tab
// the run is driving — the run can't proceed on a page whose entry script isn't running
async function failRunOnInjectionError(tabId, file, url, injectionError) {
  console.error(`🧠 [background] injection of ${file} into tab ${tabId} failed: ${injectionError}`);
  await addDiagnosticLogEntry({
    at: Date.now(),
    level: 'error',
    module: 'background',
    message: `injection of ${file} failed`,
    context: `tabId=${tabId} url=${url} error=${injectionError} extensionUrl=${chrome.runtime.getURL('')}`,
  });

  const runState = await getRunState();
  if (runState.status === 'running' && runState.tabId === tabId) {
    await saveRunState({ status: 'error', lastError: `Не удалось загрузить ${file}: ${injectionError}` });
  }
}

// hh.ru is a SPA: the "Откликнуться" click can be a pushState navigation with no document
// reload, which static manifest content_scripts never re-run for. Inject programmatically on
// every real and history-API navigation instead, so the right script always runs.
//
// Every one of these events is also logged to hhaa_navigationLog (source, url, which file got
// injected or null) — this is the ground truth for diagnosing a run that goes silent: a run state
// stuck on "running" with a URL that matched neither pattern here means the tab landed somewhere
// content-scripts/*.js was never even asked to run, which no amount of in-page logging can show.
async function injectForNavigation({ tabId, url, frameId }, source) {
  if (frameId !== 0) return;

  let file = null;
  if (LIST_URL_PATTERN.test(url)) file = 'content-scripts/vacancy-list.js';
  else if (QUESTIONNAIRE_URL_PATTERN.test(url)) file = 'content-scripts/vacancy-questionnaire.js';
  else if (CHAT_URL_PATTERN.test(url)) file = 'content-scripts/chat-tools.js';

  let injectionError = null;
  if (file) {
    try {
      // entries are ES modules sharing code with the rest of the extension — a content script can't be
      // one directly, so a one-line stub imports it. A module runs once per document, which is also
      // what makes the two racing injections (onCompleted + onHistoryStateUpdated) harmless.
      // executeScript resolves fine even when the import inside the stub rejects (blocked resource,
      // module top-level throw) — the stub has to hand the failure back as its result, otherwise
      // the run just sits on "running" with a page nobody is driving
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (path) => {
          try {
            await import(chrome.runtime.getURL(path));
            return null;
          } catch (error) {
            return `${error.name}: ${error.message}`;
          }
        },
        args: [file],
      });
      injectionError = injection?.result ?? null;
    } catch (error) {
      injectionError = error.message;
    }
  }

  await addNavigationLogEntry({ at: Date.now(), tabId, url, source, injectedFile: file, injectionError });

  if (injectionError) await failRunOnInjectionError(tabId, file, url, injectionError);

  if (!file) await recoverStrayTab(tabId, url);
}

const HH_RU_FILTER = { url: [{ hostEquals: 'hh.ru' }, { hostSuffix: '.hh.ru' }] };

chrome.webNavigation.onCompleted.addListener((details) => injectForNavigation(details, 'onCompleted'), HH_RU_FILTER);
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => injectForNavigation(details, 'onHistoryStateUpdated'),
  HH_RU_FILTER,
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HHAA_GENERATE_ANSWERS') {
    generateAnswers(message.payload)
      .then(sendResponse)
      .catch((error) => {
        console.error(`🧠 [background] generateAnswers threw: ${error.message}`);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'HHAA_GENERATE_CHAT_REPLY') {
    generateChatReply(message.payload)
      .then(sendResponse)
      .catch((error) => {
        console.error(`🧠 [background] generateChatReply threw: ${error.message}`);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  return false;
});

function updateBadge(runState) {
  if (!runState) return;

  if (runState.status === 'error') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }

  if (runState.status === 'running') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    return;
  }

  chrome.action.setBadgeText({ text: '' });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[KEYS.RUN_STATE]) return;
  updateBadge(changes[KEYS.RUN_STATE].newValue);
});
