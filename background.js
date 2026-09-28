import { generateAnswers, generateChatReply } from './lib/llm.js';
import { solveCaptcha } from './lib/captcha-solver.js';
import {
  KEYS,
  addNavigationLogEntry,
  addTraceEntry,
  getRunState,
  getRunPause,
  maintainJournals,
  saveRunState,
  saveRunPause,
  PauseReason,
  addResponseLogEntry,
} from './lib/storage.js';
import { reportError, reportWarning, stackOf, installUncaughtErrorCapture } from './lib/diagnostics.js';
import { addCaptchaPicture } from './lib/captcha-store.js';
import { reactionDelayMs } from './lib/pacing.js';
import {
  LIST_URL_PATTERN,
  QUESTIONNAIRE_URL_PATTERN,
  CHAT_URL_PATTERN,
  CAPTCHA_PICTURE_SELECTOR,
  CAPTCHA_INPUT_SELECTOR,
} from './lib/hh-pages.js';

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

// the run state if the run is going and this tab, sitting on `url`, is a stray one — null otherwise
async function strayRunState(tabId, url) {
  const runState = await getRunState();
  if (runState.status !== 'running' || runState.tabId !== tabId || !runState.listUrl) return null;
  if (url === runState.listUrl) return null;
  return runState;
}

async function tabUrlOf(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return null; // the tab is gone
  }
}

// A stray page has no script of ours, so a captcha on it holds nothing — this looks for one from outside.
async function isCaptchaOnTab(tabId) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selectors) =>
        selectors.some((selector) => document.querySelector(selector)?.getBoundingClientRect().height > 0),
      args: [[CAPTCHA_PICTURE_SELECTOR, CAPTCHA_INPUT_SELECTOR]],
    });
    return Boolean(probe?.result);
  } catch {
    return false; // closed or not scriptable: nothing there to wait for
  }
}

const CAPTCHA_POLL_MS = 1000;
const CAPTCHA_GUARD_FILE = 'content-scripts/captcha-guard.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The way back to the list is a navigation like any other and never happens under a captcha: the run
// waits here (shown as paused, like a captcha the in-page watcher holds) until the person has solved it.
// Resolves to whether the recovery is still wanted — false when the run was stopped or the tab went
// somewhere else on its own meanwhile (the person solved the captcha and hh.ru moved on).
async function waitOutCaptcha(tabId, url) {
  if (!(await isCaptchaOnTab(tabId))) return true;

  const tabUrl = await tabUrlOf(tabId);
  await reportWarning(
    'background',
    'captcha on a page without the bot, return to list waits until it is solved',
    `url=${url} tabId=${tabId}`,
  );
  await saveRunPause([PauseReason.CAPTCHA]);

  // nothing of ours runs on this page, so nothing on it could answer the captcha — the guard is added
  // for that; if it can't load, the captcha is left to a person, as before
  const waitStartedAt = Date.now();
  const guardError = await injectModule(tabId, CAPTCHA_GUARD_FILE);
  if (guardError) {
    await reportError('background', `injection of ${CAPTCHA_GUARD_FILE} failed`, `tabId=${tabId} error=${guardError}`);
  } else {
    await addTraceEntry('background', 'captcha guard injected on a page without the bot', `tabId=${tabId} url=${url}`);
  }

  const stillWanted = async () => Boolean(await strayRunState(tabId, url)) && (await tabUrlOf(tabId)) === tabUrl;
  const ended = (outcome) =>
    addTraceEntry(
      'background',
      'captcha wait on a page without the bot ended',
      `${outcome} waitedMs=${Date.now() - waitStartedAt} tabId=${tabId}`,
    );

  for (;;) {
    await sleep(CAPTCHA_POLL_MS);
    if (!(await stillWanted())) {
      await ended('the run stopped or the tab went elsewhere, no return to the list');
      return false;
    }
    if (await isCaptchaOnTab(tabId)) continue;

    // a solved captcha leaves through an animation and a wrong answer brings a new one — the page has
    // to stay clear for a human-sized beat before the bot moves
    await sleep(reactionDelayMs());
    if (!(await stillWanted())) {
      await ended('the run stopped or the tab went elsewhere, no return to the list');
      return false;
    }
    if (!(await isCaptchaOnTab(tabId))) break;
  }

  await saveRunPause([]);
  await ended('the captcha is gone, returning to the list');
  return true;
}

async function recoverStrayTab(tabId, url) {
  if (recoveringTabs.has(tabId)) return;
  if (!(await strayRunState(tabId, url))) return;

  // the debounce window opens when the wait ends, not when it starts — a captcha can take minutes
  recoveringTabs.add(tabId);
  let wanted;
  try {
    wanted = await waitOutCaptcha(tabId, url);
  } finally {
    setTimeout(() => recoveringTabs.delete(tabId), 5000);
  }
  if (!wanted) return;
  const runState = await strayRunState(tabId, url);
  if (!runState) return;

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

// A captcha is answered (and paid for) only on the tab the run drives: on a tab a person is browsing by
// hand, it is theirs to solve. The page can't tell which tab it is, the sender can.
async function solveCaptchaForRun(payload, sender) {
  const runState = await getRunState();
  if (runState.status !== 'running' || runState.tabId !== sender.tab?.id) {
    return { success: false, kind: 'skipped', error: 'not the tab of a running run' };
  }
  return solveCaptcha(payload);
}

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

  if (message.type === 'HHAA_SOLVE_CAPTCHA') {
    solveCaptchaForRun(message.payload, sender)
      .then(sendResponse)
      .catch((error) => {
        reportError('background', `solveCaptcha threw: ${error.message}`, stackOf(error));
        sendResponse({ success: false, kind: 'transient', error: error.message });
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
