import { generateAnswers, generateChatReply } from './lib/llm.js';
import {
  KEYS,
  addNavigationLogEntry,
  getRunState,
  getRunPause,
  maintainJournals,
  saveRunState,
  addResponseLogEntry,
} from './lib/storage.js';
import { reportError, reportWarning, stackOf, installUncaughtErrorCapture } from './lib/diagnostics.js';
import { addCaptchaPicture } from './lib/captcha-store.js';
import { LIST_URL_PATTERN, QUESTIONNAIRE_URL_PATTERN, CHAT_URL_PATTERN } from './lib/hh-pages.js';

installUncaughtErrorCapture('background');

chrome.runtime.onStartup.addListener(() => maintainJournals());

chrome.runtime.onInstalled.addListener(async () => {
  // an update can bring a new storage layout — the journals are brought to it right away
  maintainJournals();
  console.log('🧠 [background] installed, enabling side panel on action click');
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// What gets injected on which page. The `entry` drives the page for a run — if it can't load, a run can't
// proceed there. `extras` don't take part in a run: their failing to load is reported but never stops one.
const PAGE_SCRIPTS = [
  {
    pattern: LIST_URL_PATTERN,
    entry: 'content-scripts/vacancy-list.js',
    extras: ['content-scripts/search-tracker.js'],
  },
  { pattern: QUESTIONNAIRE_URL_PATTERN, entry: 'content-scripts/vacancy-questionnaire.js', extras: [] },
  { pattern: CHAT_URL_PATTERN, entry: 'content-scripts/chat-tools.js', extras: [] },
];

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

  await reportWarning(
    'background',
    'tab landed on unrecognized page while running (content script never had a chance to recover), forcing return to list',
    `url=${url} listUrl=${runState.listUrl} tabId=${tabId}`,
  );

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
    await reportError('background', `failed to navigate tab ${tabId} back to list: ${error.message}`);
  }
}

// a script that never loaded can't report anything itself, so the failure is surfaced from here:
// into the diagnostic log (and the sidepanel feed) always, and — for an entry — as a run error when this
// is the tab the run is driving: the run can't proceed on a page whose entry script isn't running
async function reportInjectionFailure(tabId, file, url, injectionError, { isEntry }) {
  await reportError(
    'background',
    `injection of ${file} failed`,
    `tabId=${tabId} url=${url} error=${injectionError} extensionUrl=${chrome.runtime.getURL('')}`,
  );

  if (!isEntry) return;

  const runState = await getRunState();
  if (runState.status === 'running' && runState.tabId === tabId) {
    await saveRunState({ status: 'error', lastError: `Не удалось загрузить ${file}: ${injectionError}` });
  }
}

// entries are ES modules sharing code with the rest of the extension — a content script can't be
// one directly, so a one-line stub imports it. A module runs once per document, which is also
// what makes the two racing injections (onCompleted + onHistoryStateUpdated) harmless.
// executeScript resolves fine even when the import inside the stub rejects (blocked resource,
// module top-level throw) — the stub has to hand the failure back as its result, otherwise
// the run just sits on "running" with a page nobody is driving.
// Resolves to the failure's description, or null when the module loaded.
async function injectModule(tabId, file) {
  try {
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
    return injection?.result ?? null;
  } catch (error) {
    return error.message;
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

  const page = PAGE_SCRIPTS.find(({ pattern }) => pattern.test(url));
  if (!page) {
    await addNavigationLogEntry({ at: Date.now(), tabId, url, source, injectedFile: null, injectionError: null });
    await recoverStrayTab(tabId, url);
    return;
  }

  // the entry goes first, and each file is logged on its own
  for (const file of [page.entry, ...page.extras]) {
    const injectionError = await injectModule(tabId, file);
    await addNavigationLogEntry({ at: Date.now(), tabId, url, source, injectedFile: file, injectionError });
    if (injectionError) {
      await reportInjectionFailure(tabId, file, url, injectionError, { isEntry: file === page.entry });
    }
  }
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
        reportError('background', `generateAnswers threw: ${error.message}`, stackOf(error));
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'HHAA_GENERATE_CHAT_REPLY') {
    generateChatReply(message.payload)
      .then(sendResponse)
      .catch((error) => {
        reportError('background', `generateChatReply threw: ${error.message}`, stackOf(error));
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // a message can't carry a Blob, so the picture arrives as a data URL and is stored as binary
  if (message.type === 'HHAA_SAVE_CAPTCHA') {
    const { key, dataUrl } = message.payload;
    fetch(dataUrl)
      .then((response) => response.blob())
      .then((blob) => addCaptchaPicture({ key, at: Date.now(), blob }))
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        reportError('background', `saving captcha picture failed: ${error.message}`, stackOf(error));
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  return false;
});

async function updateBadge() {
  const [runState, pause] = await Promise.all([getRunState(), getRunPause()]);

  if (runState.status === 'error') {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }

  // "running" that is standing still until a human clears something (a captcha) — the one state
  // where the user has to act, so it must not look like the green "all fine" dot
  if (runState.status === 'running' && pause.length > 0) {
    chrome.action.setBadgeText({ text: '||' });
    chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
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
  if (areaName !== 'local' || !(changes[KEYS.RUN_STATE] || changes[KEYS.RUN_PAUSE])) return;
  updateBadge();
});
