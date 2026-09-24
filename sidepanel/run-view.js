import {
  getSettings,
  saveSettings,
  getRunState,
  saveRunState,
  startRun,
  getResponseLog,
  getDiagnosticLog,
  getNavigationLog,
  getRespondedTodayCount,
} from '../lib/storage.js';
import { resultMeta, formatTime } from './format.js';

// hh.ru redirects logged-in users to a regional subdomain (samara.hh.ru, spb.hh.ru, ...) instead of
// keeping them on the bare hh.ru host, so every pattern here has to allow an optional subdomain.
const LIST_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/search\/vacancy/;
const QUESTIONNAIRE_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/applicant\/vacancy_response/;
const HH_HOST_PATTERN = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\//;

const STATUS_LABELS = {
  idle: 'Ожидание',
  running: 'Работает',
  stopped: 'Остановлено',
  error: 'Ошибка',
};

let els = {};

function statusDotClass(status) {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return '';
}

async function buildFeed() {
  const [responseLog, diagnosticLog] = await Promise.all([getResponseLog(), getDiagnosticLog()]);

  const responseItems = responseLog.map((entry) => {
    const meta = resultMeta(entry.result);
    return {
      at: entry.at,
      icon: meta.icon,
      text: `${entry.title || 'Вакансия'} — ${meta.label}`,
      warn: entry.result === 'error',
      vacancyId: entry.vacancyId || null,
    };
  });

  // 'info'-level entries are a debug trace for the downloaded report, not something worth
  // surfacing in this compact feed — only warn/error are actual events worth a glance here
  const diagnosticItems = diagnosticLog
    .filter((entry) => entry.level !== 'info')
    .map((entry) => ({
      at: entry.at,
      icon: '⚠️',
      text: entry.message,
      warn: true,
    }));

  return [...responseItems, ...diagnosticItems].sort((a, b) => b.at - a.at).slice(0, 36);
}

function renderFeed(items) {
  if (items.length === 0) {
    els.eventFeed.innerHTML = '<li class="empty">Пока нет событий</li>';
    return;
  }

  els.eventFeed.innerHTML = items
    .map(
      (item) => `
        <li class="event-item ${item.warn ? 'warn' : ''}">
          <span class="icon">${item.icon}</span>
          <span class="time">${formatTime(item.at)}</span>
          <span>${item.text}</span>
          ${
            item.vacancyId
              ? `<a class="event-link"
                    href="https://hh.ru/vacancy/${item.vacancyId}"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Открыть вакансию">🔗</a>`
              : ''
          }
        </li>
      `,
    )
    .join('');
}

async function render() {
  const [runState, settings, respondedToday] = await Promise.all([
    getRunState(),
    getSettings(),
    getRespondedTodayCount(),
  ]);

  els.statusDot.className = `status-dot ${statusDotClass(runState.status)}`;
  els.statusText.textContent = STATUS_LABELS[runState.status] || runState.status;

  if (runState.status === 'error' && runState.lastError) {
    els.statusError.hidden = false;
    els.statusError.textContent = runState.lastError;
  } else {
    els.statusError.hidden = true;
  }

  els.dailyCounter.textContent = String(respondedToday);

  if (runState.status === 'running' && runState.currentVacancyTitle) {
    els.currentVacancy.hidden = false;
    els.currentVacancy.textContent = `Сейчас: ${runState.currentVacancyTitle} — ${runState.currentVacancyCompany || ''}`;
  } else {
    els.currentVacancy.hidden = true;
  }

  const isRunning = runState.status === 'running';
  els.startBtn.hidden = isRunning;
  els.stopBtn.hidden = !isRunning;

  els.startHint.textContent =
    !settings.llmEnabled || !settings.apiKey?.trim()
      ? 'LLM выключен или не задан ключ — анкеты будут пропускаться и уходить в анкетный чёрный список.'
      : '';

  const isAssisted = settings.mode === 'assisted';
  els.modeAutoBtn.classList.toggle('active', !isAssisted);
  els.modeAssistedBtn.classList.toggle('active', isAssisted);
  els.modeHint.textContent = isAssisted
    ? 'Бот заполняет анкету и ждёт — проверьте на странице hh.ru и подтвердите здесь.'
    : 'Бот заполняет и сразу отправляет анкеты без остановки.';

  const awaitingApproval = isRunning && runState.awaitingApproval && runState.pendingVacancy;
  els.approvalCard.hidden = !awaitingApproval;
  if (awaitingApproval) {
    els.approvalVacancy.textContent = `${runState.pendingVacancy.title} — ${runState.pendingVacancy.company}`;
  }

  renderFeed(await buildFeed());
}

async function handleStart() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!LIST_URL_PATTERN.test(tab?.url || '')) {
    els.startHint.textContent = 'Откройте страницу поиска вакансий на hh.ru в активной вкладке и нажмите «Старт».';
    return;
  }

  await startRun({ tabId: tab.id, listUrl: tab.url });

  await chrome.tabs.reload(tab.id);
  await render();
}

async function handleStop() {
  await saveRunState({ status: 'stopped' });
  await render();
}

async function handleModeChange(mode) {
  await saveSettings({ mode });
  await render();
}

// content script is on runState.tabId, still on the questionnaire page waiting in waitForApproval() —
// best-effort since the tab could have been closed or navigated away out from under the wait
async function sendQuestionnaireDecision(decision) {
  const runState = await getRunState();
  if (!runState.tabId || !runState.pendingVacancy) return;

  try {
    await chrome.tabs.sendMessage(runState.tabId, {
      type: 'HHAA_QUESTIONNAIRE_DECISION',
      vacancyId: runState.pendingVacancy.vacancyId,
      decision,
    });
  } catch (error) {
    console.error(`🖥️ [run-view] failed to send decision to tab ${runState.tabId}: ${error.message}`);
  }

  await render();
}

async function handleApproveSubmit() {
  await sendQuestionnaireDecision('submit');
}

async function handleApproveSkip() {
  await sendQuestionnaireDecision('skip');
}

// best-effort — the tab may have been closed, or the extension may lack access to it right now;
// either way that's itself diagnostic information, not a reason to fail the whole report
async function getActiveTabSnapshot(tabId) {
  if (!tabId) return { note: 'runState.tabId not set' };
  try {
    const tab = await chrome.tabs.get(tabId);
    return { id: tab.id, url: tab.url, status: tab.status, title: tab.title, page: await probeTabPage(tabId) };
  } catch (error) {
    return { note: `chrome.tabs.get(${tabId}) failed: ${error.message}` };
  }
}

// what the page itself looks like right now — answers "no cards / captcha / blank page" without
// needing the content script to have run at all. The selector mirrors CARD_SELECTOR in vacancy-list.js.
async function probeTabPage(tabId) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        readyState: document.readyState,
        cards: document.querySelectorAll('[data-qa="vacancy-serp__vacancy"]').length,
        bodyHead: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
      }),
    });
    return probe.result;
  } catch (error) {
    return { note: `page probe failed: ${error.message}` };
  }
}

function classifyUrl(url) {
  if (typeof url !== 'string') return 'unknown';
  if (LIST_URL_PATTERN.test(url)) return 'list';
  if (QUESTIONNAIRE_URL_PATTERN.test(url)) return 'questionnaire';
  if (HH_HOST_PATTERN.test(url)) return 'other_hh_page';
  return 'non_hh_page';
}

// plain-language read of "is this run stuck, and why" — cross-referencing runState against the
// tab's actual current URL is what actually answers that question; the rest of the report is the
// evidence backing this verdict up
function buildDiagnosis(runState, activeTab, navigationLog, diagnosticLog) {
  const lines = [];
  const tabUrlClass = classifyUrl(activeTab?.url);

  const runNavigation = navigationLog.filter(
    (entry) => entry.tabId === runState.tabId && entry.at >= runState.startedAt,
  );
  const failedInjection = runNavigation.find((entry) => entry.injectionError);
  if (runState.status !== 'idle' && failedInjection) {
    lines.push(
      `ЗАГРУЗКА СКРИПТА НЕ УДАЛАСЬ: ${failedInjection.injectedFile} на "${failedInjection.url}" — ${failedInjection.injectionError}. ` +
        'Модуль не исполнялся вообще, поэтому в recentDiagnostics от него ничего нет.',
    );
  }

  // 'entry loaded' (list) / 'questionnaire page opened' are the first thing each entry writes — their
  // absence after a successful injection means the module was pulled in but never got as far as running
  const ENTRY_TRACES = ['entry loaded', 'questionnaire page opened'];
  const entryRan = diagnosticLog.some(
    (entry) => entry.at >= runState.startedAt && ENTRY_TRACES.includes(entry.message),
  );
  const injectedOk = runNavigation.some((entry) => entry.injectedFile && !entry.injectionError);
  if (runState.status === 'running' && injectedOk && !entryRan && Date.now() - runState.startedAt > 10000) {
    lines.push(
      'Скрипт инжектнут без ошибок, но с момента старта нет ни одной записи "entry loaded" — модуль загружен, ' +
        'но не дошёл до выполнения (или статус в хранилище не "running" на момент его запуска). См. activeTab.page.',
    );
  }

  if (runState.status === 'running' && tabUrlClass === 'list' && activeTab.page?.cards === 0) {
    lines.push(
      `На странице вкладки 0 карточек вакансий (readyState=${activeTab.page.readyState}, начало текста: "${activeTab.page.bodyHead}") — ` +
        'возможна капча/антибот-страница или изменилась вёрстка.',
    );
  }

  if (runState.status === 'running' && tabUrlClass === 'other_hh_page') {
    lines.push(
      `СТОП: статус "running", но вкладка сейчас на "${activeTab.url}" — это не страница списка вакансий и не анкета. ` +
        `background.js инжектит content-scripts только на URL вида /search/vacancy* и /applicant/vacancy_response* ` +
        `(см. injectForNavigation в background.js) — на этой странице ни один скрипт не запускается, поэтому расширение ` +
        `не "зависло", а физически ничего не выполняет. Обычно это значит: клик по отклику увёл на страницу самой ` +
        `вакансии (или другой неожиданный редирект hh.ru) вместо анкеты/попапа/остатка на списке.`,
    );
  } else if (runState.status === 'running' && tabUrlClass === 'non_hh_page') {
    lines.push(
      `СТОП: статус "running", но вкладка сейчас не на hh.ru ("${activeTab.url}") — скрипты не запускаются нигде.`,
    );
  } else if (runState.status === 'running' && !activeTab?.url) {
    lines.push(
      'СТОП: статус "running", но не удалось прочитать URL вкладки — см. activeTab.note ниже (вкладка закрыта?).',
    );
  }

  if (runState.status === 'running' && runState.pendingVacancy) {
    lines.push(
      `На вкладке "в работе" вакансия ${runState.pendingVacancy.vacancyId} ("${runState.pendingVacancy.title}"), ` +
        'но выполнение до сюда дошло и не завершилось — клик был сделан, но ни один из ожидаемых исходов ' +
        '(анкета/попап/мгновенный отклик/возврат) не сработал и не записался в recentDiagnostics/recentResponses.',
    );
  }

  const lastNav = navigationLog[navigationLog.length - 1];
  if (lastNav && !lastNav.injectedFile) {
    lines.push(
      `Последняя навигация в hhaa_navigationLog (${new Date(lastNav.at).toLocaleString('ru-RU')}, источник ${lastNav.source}) ` +
        `привела на "${lastNav.url}", куда НИЧЕГО не инжектировалось (injectedFile: null). Если это произошло уже после ` +
        'клика по отклику — вот прямое доказательство того, что и куда увело расширение.',
    );
  }

  if (lines.length === 0) {
    lines.push('Явных признаков зависания не найдено по имеющимся данным (статус/URL вкладки согласованы).');
  }

  return lines;
}

async function handleDownloadDiagnostics() {
  const [runState, settings, diagnosticLog, responseLog, navigationLog] = await Promise.all([
    getRunState(),
    getSettings(),
    getDiagnosticLog(),
    getResponseLog(),
    getNavigationLog(),
  ]);

  const activeTab = await getActiveTabSnapshot(runState.tabId);

  const report = {
    extensionVersion: chrome.runtime.getManifest().version,
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    extensionUrl: chrome.runtime.getURL(''),
    webAccessibleResources: chrome.runtime.getManifest().web_accessible_resources,
    diagnosis: buildDiagnosis(runState, activeTab, navigationLog, diagnosticLog),
    runState,
    activeTab,
    settings: { ...settings, apiKey: settings.apiKey ? '(задан)' : '(не задан)', legend: undefined },
    recentResponses: responseLog.slice(-50),
    recentDiagnostics: diagnosticLog.slice(-400),
    recentNavigation: navigationLog.slice(-200),
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hhaa-diagnostics-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // give the download a moment to actually start before revoking

  els.downloadDiagnosticsBtn.textContent = 'Скачано ✓';
  setTimeout(() => {
    els.downloadDiagnosticsBtn.textContent = 'Скачать диагностику';
  }, 1500);
}

// strips whitespace AND leading/trailing punctuation together (a stray ", " or "." grabbed by an
// imprecise selection shouldn't end up as its own stop-word line)
const EDGE_JUNK = /^[\s.,;:!?"'«»()\-–—]+|[\s.,;:!?"'«»()\-–—]+$/g;

function trimStopWordSelection(text) {
  return (text || '').replace(EDGE_JUNK, '');
}

async function addVacancyTitleStopWord(word) {
  const settings = await getSettings();
  const lines = (settings.vacancyTitleStopWordsRaw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.some((line) => line.toLowerCase() === word.toLowerCase())) return;

  lines.push(word);
  const next = lines.join('\n');
  await saveSettings({ vacancyTitleStopWordsRaw: next });

  // the settings tab's textarea lives in the same document (tabs are just CSS-toggled) — keep it
  // in sync even when that tab isn't the one currently showing
  const textarea = document.getElementById('vacancyTitleStopWords');
  if (textarea) textarea.value = next;
}

// lets the user select vacancy title text straight out of the event feed and one-click it into
// the "стоп-слова в названии" list instead of retyping it in settings
function setupSelectionStopWordButton(feedEl) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'selection-stopword-btn';
  button.textContent = 'Добавить в стоп-слова';
  button.hidden = true;
  document.body.appendChild(button);

  function hideButton() {
    button.hidden = true;
  }

  // mousedown (not click) fires before the browser clears the selection on a plain click elsewhere
  document.addEventListener('mousedown', (event) => {
    if (event.target !== button) hideButton();
  });

  document.addEventListener('mouseup', (event) => {
    if (event.target === button) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || selection.isCollapsed || !feedEl.contains(selection.anchorNode)) {
      hideButton();
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    button.style.left = `${rect.left + rect.width / 2}px`;
    button.style.top = `${Math.max(8, rect.top - 8)}px`;
    button.hidden = false;
  });

  // keeps the selection alive through the click (a plain click would otherwise collapse it first)
  button.addEventListener('mousedown', (event) => event.preventDefault());

  button.addEventListener('click', async () => {
    const selection = window.getSelection();
    const trimmed = trimStopWordSelection(selection?.toString());
    hideButton();
    selection?.removeAllRanges();
    if (trimmed) await addVacancyTitleStopWord(trimmed);
  });
}

export function initRunView() {
  els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    statusError: document.getElementById('statusError'),
    dailyCounter: document.getElementById('dailyCounter'),
    currentVacancy: document.getElementById('currentVacancy'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    startHint: document.getElementById('startHint'),
    eventFeed: document.getElementById('eventFeed'),
    downloadDiagnosticsBtn: document.getElementById('downloadDiagnosticsBtn'),
    modeAutoBtn: document.getElementById('modeAutoBtn'),
    modeAssistedBtn: document.getElementById('modeAssistedBtn'),
    modeHint: document.getElementById('modeHint'),
    approvalCard: document.getElementById('approvalCard'),
    approvalVacancy: document.getElementById('approvalVacancy'),
    approveSubmitBtn: document.getElementById('approveSubmitBtn'),
    approveSkipBtn: document.getElementById('approveSkipBtn'),
  };

  els.startBtn.addEventListener('click', handleStart);
  els.stopBtn.addEventListener('click', handleStop);
  els.downloadDiagnosticsBtn.addEventListener('click', handleDownloadDiagnostics);
  els.modeAutoBtn.addEventListener('click', () => handleModeChange('auto'));
  els.modeAssistedBtn.addEventListener('click', () => handleModeChange('assisted'));
  els.approveSubmitBtn.addEventListener('click', handleApproveSubmit);
  els.approveSkipBtn.addEventListener('click', handleApproveSkip);

  setupSelectionStopWordButton(els.eventFeed);

  render();
}

export { render as renderRunView };
