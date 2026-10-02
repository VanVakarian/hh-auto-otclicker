import {
  PauseReason,
  getSettings,
  saveSettings,
  getRunState,
  getRunPause,
  saveRunState,
  startRun,
  StopReason,
  getResponseLog,
  getDiagnosticLog,
  getNavigationLog,
  getRespondedTodayCount,
  getBlacklist,
  DIAGNOSTIC_RETENTION_MS,
} from '../lib/storage.js';
import { getCaptchaPictures, deleteCaptchaPictures } from '../lib/captcha-store.js';
import { getUploadStatus, getRejectedArchive } from '../lib/upload-store.js';
import { createZip } from '../lib/zip.js';
import { resultMeta, formatTime } from './format.js';
import { reportError } from '../lib/diagnostics.js';
import { formatRubles } from '../lib/money.js';
import { fitSetupProblem } from '../lib/vacancy-fit.js';
import { FIT_RATED_TRACE, FitAction } from '../lib/fit-step.js';
import { isFitRejection } from '../lib/blacklist-core.js';
import { classifyUrl } from '../lib/hh-pages.js';
import { getActiveTab, onActiveTabChange } from './active-tab.js';
import { checkListPage, probeTabPage } from './list-page.js';

const STATUS_LABELS = {
  idle: 'Ожидание',
  running: 'Работает',
  stopped: 'Остановлено',
  error: 'Ошибка',
};

// a run that ended by itself — what to tell the user instead of a silent "Остановлено"
const STOP_MESSAGES = {
  [StopReason.NO_MORE_VACANCIES]:
    'Подходящие вакансии закончились: на странице не осталось карточек для отклика, а кнопки следующей страницы нет даже после прокрутки до конца.',
  [StopReason.DAILY_LIMIT]: 'Достигнут дневной лимит откликов из настроек.',
  [StopReason.HH_DAILY_LIMIT]: 'hh.ru отказал в отклике: исчерпан его лимит (200 откликов за 24 часа).',
};

// "running" that stands still until something on the page is cleared — what to tell the person: to act, or
// that the extension is on it. A captcha the extension is solving carries both reasons, and that one wins:
// it is only a pause that needs the person once the auto-solve is off or has given up.
const PAUSE_VIEWS = {
  [PauseReason.CAPTCHA]: {
    title: 'Пауза — нужна ваша помощь',
    text: 'Введите капчу на странице hh.ru и нажмите «Отправить» — работа продолжится сама.',
  },
  [PauseReason.CAPTCHA_AUTO]: {
    title: 'Пауза — решаем капчу',
    text: 'Расширение решает капчу само, работа продолжится сама. Если не получится, здесь появится просьба ввести её вручную.',
  },
};
const UNKNOWN_PAUSE_VIEW = { title: 'Пауза', text: 'Ждём, пока страница снова станет доступна.' };

function pauseViewOf(pause) {
  const reason = pause.includes(PauseReason.CAPTCHA_AUTO) ? PauseReason.CAPTCHA_AUTO : pause[0];
  return PAUSE_VIEWS[reason] || UNKNOWN_PAUSE_VIEW;
}

let els = {};

// Whether the active tab is a page a run can begin on (see checkListPage) — the Start button follows it.
// Only Start's clicking is ever gated by this, never a run that is already going.
const GUARD_RECHECK_MS = 2000;
let startGuard = { ok: false, reason: '' };
let guardCheckId = 0;
let guardRecheckTimer = null;

async function refreshStartGuard() {
  clearTimeout(guardRecheckTimer);
  const checkId = ++guardCheckId;
  const guard = await checkListPage(await getActiveTab());
  if (checkId !== guardCheckId) return; // a newer check has started meanwhile — its answer is the current one

  startGuard = guard;
  if (guard.waiting) guardRecheckTimer = setTimeout(refreshStartGuard, GUARD_RECHECK_MS);
  await render();
}

function statusDotClass(status, isPaused) {
  if (isPaused) return 'paused';
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return '';
}

// the compact feed shows a few dozen latest events — it has no use for the whole retained day
const FEED_WINDOW_MS = 6 * 60 * 60 * 1000;

async function buildFeed() {
  const [responseLog, diagnosticLog] = await Promise.all([
    getResponseLog({ sinceMs: FEED_WINDOW_MS }),
    getDiagnosticLog({ sinceMs: FEED_WINDOW_MS }),
  ]);

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

  // what the classifier made of each vacancy it was asked about: a tick for one that suits, a cross for one that
  // doesn't — the one trace that is shown here, to see at a glance that the classifier is at work
  const fitItems = diagnosticLog
    .filter((entry) => entry.message === FIT_RATED_TRACE && entry.data)
    .map(({ at, data }) => {
      const fits = data.verdict === FitAction.RESPOND;
      const vacancy = `${data.company || 'компания не указана'} — ${data.title || 'вакансия'}`;
      const result = `${Math.round(data.probability * 100)}% — ${fits ? 'пройдено' : 'отклонено'}`;
      const text = `Отбор по Jev: ${vacancy}: ${result}`;
      return { at, icon: fits ? '✅' : '❌', text, warn: false, vacancyId: data.vacancyId };
    });

  return [...responseItems, ...diagnosticItems, ...fitItems].sort((a, b) => b.at - a.at).slice(0, 36);
}

// the feed is markup, and its texts are vacancies' and companies' own words
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
          <span>${escapeHtml(item.text)}</span>
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

// what the classifier has turned away since the run began: its rejections made after that
async function countRejectedByFitSince(startedAtMs) {
  const list = await getBlacklist();
  return list.filter((entry) => isFitRejection(entry) && entry.at >= startedAtMs).length;
}

async function render() {
  const [runState, pause, settings, respondedToday] = await Promise.all([
    getRunState(),
    getRunPause(),
    getSettings(),
    getRespondedTodayCount(),
  ]);

  // whatever a stopped run left in the pause record is leftovers, only a running run can be paused
  const isPaused = runState.status === 'running' && pause.length > 0;

  els.statusDot.className = `status-dot ${statusDotClass(runState.status, isPaused)}`;
  els.statusText.textContent = isPaused ? 'Пауза' : STATUS_LABELS[runState.status] || runState.status;

  els.pauseCard.hidden = !isPaused;
  if (isPaused) {
    const view = pauseViewOf(pause);
    els.pauseTitle.textContent = view.title;
    els.pauseText.textContent = view.text;
  }

  if (runState.status === 'error' && runState.lastError) {
    els.statusError.hidden = false;
    els.statusError.textContent = runState.lastError;
  } else {
    els.statusError.hidden = true;
  }

  const fitProblem = fitSetupProblem(settings);
  const rejectedByFit = settings.fitEnabled ? await countRejectedByFitSince(runState.startedAt ?? Infinity) : 0;

  let stopMessage = runState.status === 'stopped' ? STOP_MESSAGES[runState.stopReason] : null;
  if (stopMessage && runState.stopReason === StopReason.NO_MORE_VACANCIES && rejectedByFit > 0) {
    stopMessage += ` Отбором отклонено: ${rejectedByFit}.`;
  }
  els.statusNote.hidden = !stopMessage;
  if (stopMessage) els.statusNote.textContent = stopMessage;

  els.dailyCounter.textContent = String(respondedToday);

  if (runState.status === 'running' && runState.currentVacancyTitle) {
    els.currentVacancy.hidden = false;
    els.currentVacancy.textContent = `Сейчас: ${runState.currentVacancyTitle} — ${runState.currentVacancyCompany || ''}`;
  } else {
    els.currentVacancy.hidden = true;
  }

  const isRunning = runState.status === 'running';
  els.startBtn.hidden = isRunning;
  els.startBtn.disabled = !startGuard.ok || Boolean(fitProblem);
  els.stopBtn.hidden = !isRunning;

  els.fitLine.hidden = !(settings.fitEnabled && isRunning);
  els.fitLine.textContent = `Отбор: отклонено ${rejectedByFit}`;

  const llmHint =
    !settings.llmEnabled || !settings.apiKey?.trim()
      ? 'LLM выключен или не задан ключ — анкеты будут пропускаться и уходить в чёрный список.'
      : '';
  const fitPercent = Math.round(settings.fitThreshold * 100);
  const fitReady = settings.fitEnabled && !isRunning ? `Отбор по Jev включён, порог ${fitPercent}%.` : '';
  const fitHint = fitProblem || fitReady;
  els.startHint.textContent = [isRunning ? '' : startGuard.reason, fitHint, llmHint].filter(Boolean).join(' ');

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
  // the button's state may be a moment old — what counts is the page as it is at the click
  const tab = await getActiveTab();
  const guard = await checkListPage(tab);
  if (!guard.ok) {
    startGuard = guard;
    await render();
    return;
  }

  // the classifier can't be asked without its key and prompt — the button is disabled for that, this is the click's own check
  if (fitSetupProblem(await getSettings())) {
    await render();
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
    reportError('run-view', `failed to send decision to tab ${runState.tabId}: ${error.message}`);
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

// How the captchas of a run went, counted from the diagnostic entries the watcher and the auto-solver write
// (see the list at the top of lib/captcha-autosolve.js). Each episode is one `seq=N` story in `diagnostics`;
// this is only the tally, plus the hints for the ways the whole thing can silently not happen.
function captchaDiagnosis(entries) {
  const of = (message) => entries.filter((entry) => entry.message === message);
  const shown = of('captcha shown, run paused until it is solved');
  if (shown.length === 0) return [];

  const contextOf = (entry) => entry.context ?? '';
  const numbersOf = (list, name) =>
    list.map((entry) => Number(contextOf(entry).match(new RegExp(`${name}=([0-9.]+)`))?.[1])).filter(Number.isFinite);
  const sum = (numbers) => numbers.reduce((total, number) => total + number, 0);
  const countBy = (list, pick) =>
    Object.entries(
      list.reduce((counts, entry) => ({ ...counts, [pick(entry)]: (counts[pick(entry)] ?? 0) + 1 }), {}),
    )
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ×${count}`)
      .join('; ');

  const arrivedWithError = shown.filter((entry) => contextOf(entry).includes('errorShown=true')).length;
  const gone = of('captcha gone, run resumed');
  const solvedBy = (who) => gone.filter((entry) => contextOf(entry).includes(`solvedBy=${who}`)).length;
  const answers = of('captcha model answered');
  const results = countBy(answers, (entry) => contextOf(entry).match(/result=(\S+)/)?.[1] ?? '?');
  const handedOver = of('captcha auto-solve handed over to a person');
  const reasons = countBy(handedOver, (entry) => contextOf(entry).replace(/^seq=\d+ /, '').split(' | ')[0]);
  const accepted = of('captcha answer accepted').length;
  const rejected = of('captcha answer rejected').length;
  const times = numbersOf(answers, 'ms');
  const averageS = times.length > 0 ? (sum(times) / times.length / 1000).toFixed(1) : '-';

  const lines = [
    `Капч за прогон: ${shown.length}, из них появились уже с «Неверный текст»: ${arrivedWithError}. ` +
      `Решено расширением: ${solvedBy('auto')}, человеком: ${gone.length - solvedBy('auto')}. ` +
      'Каждая капча — одна история по её seq=N в diagnostics ("captcha shown" … "captcha gone").',
  ];

  if (answers.length > 0 || handedOver.length > 0) {
    lines.push(
      `Автоответчик: вызовов модели ${answers.length} (${results || 'нет'}), в среднем ${averageS} с, ` +
        `потрачено ${formatRubles(sum(numbersOf(answers, 'cost')))}. Отправлено ответов ${of('captcha answer submitted').length}: ` +
        `принято hh.ru ${accepted}, отклонено ${rejected} (по «captcha answer accepted/rejected»). ` +
        `Брошенных попыток: ${of('captcha attempt abandoned').length}. ` +
        `Передано человеку: ${handedOver.length}${reasons ? ` — причины: ${reasons}` : ''}.`,
    );
  }

  // what the people did themselves (the watcher writes it from the trusted events of the page)
  const typed = of('captcha person started typing').length;
  const pressed = of('captcha person submitted');
  if (typed + pressed.length > 0) {
    const overModel = pressed.filter((entry) => entry.data?.textFromModel).length;
    lines.push(
      `Человек: начал печатать на ${typed} картинках, нажал «Отправить» ${pressed.length} раз ` +
        `(с ответом модели в поле: ${overModel}); принято hh.ru ${of('captcha person answer accepted').length}, ` +
        `отклонено ${of('captcha person answer rejected').length}. Введённый текст — в записях ` +
        '"captcha person submitted" (поле text), картинки — в ZIP кнопки «Скачать капчи», имя файла содержит key.',
    );
  }

  const stalled = of('captcha auto-solve idle: nothing attempted yet').length;
  const slow = of('captcha auto-solve attempt is taking long').length;
  if (stalled + slow > 0) {
    lines.push(
      `Предупреждения автоответчика: простаивал без единой попытки — ${stalled}, попытка шла слишком долго — ${slow}. ` +
        'В записях указано состояние картинки/кнопок и фаза, на которой он завис.',
    );
  }

  const decided = of('captcha auto-solve started').length + of('captcha auto-solve not used').length;
  if (decided === 0) {
    lines.push(
      'Ни одна капча не дошла до автоответчика: нет ни "started", ни "not used" — решатель не запускался вовсе ' +
        '(старая версия расширения на странице? капча появилась вне запуска? ищите "captcha shown" без продолжения).',
    );
  }

  return lines;
}

// How the classifier went in a run, counted from the trace its step writes (see fitAllows in vacancy-list.js): an
// entry for every vacancy it asked about, one for each card it could not rate and one for each card it passed over
// on an earlier rejection. The vacancies themselves are in `diagnostics`, one entry each.
function fitDiagnosis(entries) {
  const of = (message) => entries.filter((entry) => entry.message === message);
  const rated = of(FIT_RATED_TRACE);
  const unrated = of('card not rated, passed over on this page');
  const known = of('skipping card: the classifier rejected it before');
  if (rated.length + unrated.length + known.length === 0) return [];

  const rejected = rated.filter((entry) => entry.data?.verdict === 'skip').length;
  const cost = rated.reduce((total, entry) => total + (entry.data?.cost ?? 0), 0);
  return [
    `Отбор по Jev: запросов ${rated.length} (отклонено ${rejected}, подходят ${rated.length - rejected}), ` +
      `пропущено по прежнему отказу без запроса ${known.length}, без оценки ${unrated.length}, ` +
      `потрачено ${formatRubles(cost)}. Каждая оценка — запись "card rated by the classifier" (поля data: ` +
      'vacancyId, probability, verdict, cost, ms), каждая неудача — "card not rated, passed over on this page".',
  ];
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
        'Модуль не исполнялся вообще, поэтому в diagnostics от него ничего нет.',
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

  if (runState.status === 'stopped' && runState.stopReason) {
    lines.push(
      `Прогон остановился сам (stopReason=${runState.stopReason}), не пользователем. Для "no_more_vacancies" ` +
        'состояние страницы в момент решения (карточки, пейджер, прокрутка) — в diagnostics, записи ' +
        '"waited at the end of the page" и "no pickable card and no next-page link, stopping".',
    );
  }

  if (runState.status === 'running' && runState.pendingVacancy) {
    lines.push(
      `На вкладке "в работе" вакансия ${runState.pendingVacancy.vacancyId} ("${runState.pendingVacancy.title}"), ` +
        'но выполнение до сюда дошло и не завершилось — клик был сделан, но ни один из ожидаемых исходов ' +
        '(анкета/попап/мгновенный отклик/возврат) не сработал и не записался в diagnostics/responses.',
    );
  }

  const lastNav = navigationLog[navigationLog.length - 1];
  if (lastNav && !lastNav.injectedFile) {
    lines.push(
      `Последняя навигация в navigation (${new Date(lastNav.at).toLocaleString('ru-RU')}, источник ${lastNav.source}) ` +
        `привела на "${lastNav.url}", куда НИЧЕГО не инжектировалось (injectedFile: null). Если это произошло уже после ` +
        'клика по отклику — вот прямое доказательство того, что и куда увело расширение.',
    );
  }

  const thisRun = diagnosticLog.filter((entry) => entry.at >= runState.startedAt);
  lines.push(...captchaDiagnosis(thisRun), ...fitDiagnosis(thisRun));

  if (lines.length === 0) {
    lines.push('Явных признаков зависания не найдено по имеющимся данным (статус/URL вкладки согласованы).');
  }

  return lines;
}

async function handleDownloadDiagnostics() {
  const [runState, runPause, settings, diagnosticLog, responseLog, navigationLog, uploadStatus, rejectedArchive] =
    await Promise.all([
      getRunState(),
      getRunPause(),
      getSettings(),
      getDiagnosticLog(),
      getResponseLog({ sinceMs: DIAGNOSTIC_RETENTION_MS }),
      getNavigationLog(),
      getUploadStatus(),
      getRejectedArchive(),
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
    runPause,
    activeTab,
    settings: {
      ...settings,
      apiKey: settings.apiKey ? '(задан)' : '(не задан)',
      uploadKey: settings.uploadKey ? '(задан)' : '(не задан)',
      legend: undefined,
    },
    // sending to the server: how it stands, and what the server refused or was never sent for its size
    upload: { status: uploadStatus, rejectedArchive },
    // everything the journals hold — the retained day, or a bit more — not a
    // sample of it; responses are read for the same window (that log itself reaches much further back)
    retentionHours: DIAGNOSTIC_RETENTION_MS / 3600000,
    responses: responseLog,
    diagnostics: diagnosticLog,
    navigation: navigationLog,
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

function flashLabel(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

// resolves true only when the browser reports the file fully written; false if it was cancelled or failed
async function downloadCompleted(url, filename) {
  const id = await chrome.downloads.download({ url, filename });
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (item.state !== 'in_progress') return item.state === 'complete';
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Every captcha picture the watcher has saved, as one ZIP of bare PNGs (oldest first) — nothing else in
// it. The pictures are deleted from the archive once the browser confirms the file is on disk, and only
// the ones that went into it: a captcha that arrives mid-download waits for the next zip. If the
// download fails or is cancelled they all stay.
async function handleDownloadCaptchas() {
  const pictures = await getCaptchaPictures();
  if (pictures.length === 0) {
    flashLabel(els.downloadCaptchasBtn, 'Капч пока нет');
    return;
  }

  const files = await Promise.all(
    // the first 8 characters of hh.ru's picture key are what the diagnostic log calls the picture (`key=`),
    // so a file can be matched to the entries about it
    pictures.map(async ({ key, blob }, index) => ({
      name: `captcha-${String(index + 1).padStart(3, '0')}-${key.slice(0, 8)}.png`,
      data: new Uint8Array(await blob.arrayBuffer()),
    })),
  );

  const url = URL.createObjectURL(createZip(files));
  try {
    if (!(await downloadCompleted(url, `hhaa-captchas-${Date.now()}.zip`))) {
      flashLabel(els.downloadCaptchasBtn, 'Не скачалось, капчи сохранены');
      return;
    }
  } catch (error) {
    await reportError('run-view', `captcha zip download failed: ${error.message}`);
    flashLabel(els.downloadCaptchasBtn, 'Не скачалось, капчи сохранены');
    return;
  } finally {
    URL.revokeObjectURL(url);
  }

  await deleteCaptchaPictures(pictures.map(({ key }) => key));
  flashLabel(els.downloadCaptchasBtn, `Скачано: ${pictures.length} ✓`);
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
    statusNote: document.getElementById('statusNote'),
    dailyCounter: document.getElementById('dailyCounter'),
    fitLine: document.getElementById('fitLine'),
    currentVacancy: document.getElementById('currentVacancy'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    startHint: document.getElementById('startHint'),
    eventFeed: document.getElementById('eventFeed'),
    downloadDiagnosticsBtn: document.getElementById('downloadDiagnosticsBtn'),
    downloadCaptchasBtn: document.getElementById('downloadCaptchasBtn'),
    modeAutoBtn: document.getElementById('modeAutoBtn'),
    modeAssistedBtn: document.getElementById('modeAssistedBtn'),
    modeHint: document.getElementById('modeHint'),
    pauseCard: document.getElementById('pauseCard'),
    pauseTitle: document.getElementById('pauseTitle'),
    pauseText: document.getElementById('pauseText'),
    approvalCard: document.getElementById('approvalCard'),
    approvalVacancy: document.getElementById('approvalVacancy'),
    approveSubmitBtn: document.getElementById('approveSubmitBtn'),
    approveSkipBtn: document.getElementById('approveSkipBtn'),
  };

  els.startBtn.addEventListener('click', handleStart);
  els.stopBtn.addEventListener('click', handleStop);
  els.downloadDiagnosticsBtn.addEventListener('click', handleDownloadDiagnostics);
  els.downloadCaptchasBtn.addEventListener('click', handleDownloadCaptchas);
  els.modeAutoBtn.addEventListener('click', () => handleModeChange('auto'));
  els.modeAssistedBtn.addEventListener('click', () => handleModeChange('assisted'));
  els.approveSubmitBtn.addEventListener('click', handleApproveSubmit);
  els.approveSkipBtn.addEventListener('click', handleApproveSkip);

  setupSelectionStopWordButton(els.eventFeed);

  onActiveTabChange(refreshStartGuard);
  render();
  refreshStartGuard();
}

export { render as renderRunView };
