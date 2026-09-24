export const KEYS = {
  SETTINGS: 'hhaa_settings',
  RUN_STATE: 'hhaa_runState',
  QUESTIONNAIRE_BLACKLIST: 'hhaa_questionnaireBlacklist',
  RESPONSE_LOG: 'hhaa_responseLog',
  DIAGNOSTIC_LOG: 'hhaa_diagnosticLog',
  NAVIGATION_LOG: 'hhaa_navigationLog',
  ANSWERS_LOG: 'hhaa_answersLog',
};

// every key this extension ever writes to chrome.storage.local uses this prefix — used to reject
// anything else on import instead of blindly writing arbitrary keys from a hand-edited file
const KEY_PREFIX = 'hhaa_';

export const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | assisted — assisted fills the questionnaire but waits for a human to approve the submit
  llmEnabled: true,
  apiKey: '',
  llmModelsRaw: '',
  legend: '',
  stylePrompt: '',
  dailyLimit: 200,
  delayMinSec: 3,
  delayMaxSec: 7,
  coverLetterEnabled: false,
  coverLetterText: '',
  blacklistCompaniesRaw: '',
  skipStopWordsRaw: '',
  vacancyTitleStopWordsRaw: '',
  chatQuickMessagesRaw: '',
  chatSuggestedRepliesRaw: '',
  chatLlmPromptRaw: '',
};

export const DEFAULT_RUN_STATE = {
  status: 'idle', // idle | running | stopped | error
  tabId: null,
  listUrl: null,
  processedVacancyIds: [],
  pendingVacancy: null, // { vacancyId, title, company }
  currentVacancyTitle: null,
  currentVacancyCompany: null,
  awaitingApproval: false, // assisted mode: questionnaire filled, waiting on the sidepanel's Отправить/Пропустить
  startedAt: null,
  lastError: null,
};

// the response log is the single source of truth for "how many responses when" (daily count, rate
// windows) — skips are logged too, so the cap has to be large enough that a full day always fits
const RESPONSE_LOG_LIMIT = 3000;
const DIAGNOSTIC_LOG_LIMIT = 1500;
const NAVIGATION_LOG_LIMIT = 500;
const ANSWERS_LOG_LIMIT = 500;

export function startOfTodayMs() {
  return new Date().setHours(0, 0, 0, 0);
}

export async function getSettings() {
  const result = await chrome.storage.local.get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(result[KEYS.SETTINGS] || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  return next;
}

export async function getRunState() {
  const result = await chrome.storage.local.get(KEYS.RUN_STATE);
  return { ...DEFAULT_RUN_STATE, ...(result[KEYS.RUN_STATE] || {}) };
}

export async function saveRunState(partial) {
  const current = await getRunState();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [KEYS.RUN_STATE]: next });
  return next;
}

// a new run starts from the defaults, not from whatever the previous run left behind — every field
// added to the run state later resets here without anyone having to remember to list it
export async function startRun({ tabId, listUrl }) {
  const next = { ...DEFAULT_RUN_STATE, status: 'running', tabId, listUrl, startedAt: Date.now() };
  await chrome.storage.local.set({ [KEYS.RUN_STATE]: next });
  return next;
}

export async function getQuestionnaireBlacklist() {
  const result = await chrome.storage.local.get(KEYS.QUESTIONNAIRE_BLACKLIST);
  return result[KEYS.QUESTIONNAIRE_BLACKLIST] || [];
}

export async function addQuestionnaireBlacklistEntry(entry) {
  const list = await getQuestionnaireBlacklist();
  list.push(entry);
  await chrome.storage.local.set({ [KEYS.QUESTIONNAIRE_BLACKLIST]: list });
}

export async function clearQuestionnaireBlacklist() {
  await chrome.storage.local.set({ [KEYS.QUESTIONNAIRE_BLACKLIST]: [] });
}

export async function getResponseLog() {
  const result = await chrome.storage.local.get(KEYS.RESPONSE_LOG);
  return result[KEYS.RESPONSE_LOG] || [];
}

export async function addResponseLogEntry(entry) {
  const list = await getResponseLog();
  list.push(entry);
  if (list.length > RESPONSE_LOG_LIMIT) {
    list.splice(0, list.length - RESPONSE_LOG_LIMIT);
  }
  await chrome.storage.local.set({ [KEYS.RESPONSE_LOG]: list });
}

const SUCCESS_RESULTS = new Set(['success_instant', 'success_popup', 'success_questionnaire']);

export function isSuccessResult(result) {
  return SUCCESS_RESULTS.has(result);
}

export async function countResponsesSince(sinceMs) {
  const list = await getResponseLog();
  return list.filter((entry) => isSuccessResult(entry.result) && entry.at >= sinceMs).length;
}

export function getRespondedTodayCount() {
  return countResponsesSince(startOfTodayMs());
}

export async function getDiagnosticLog() {
  const result = await chrome.storage.local.get(KEYS.DIAGNOSTIC_LOG);
  return result[KEYS.DIAGNOSTIC_LOG] || [];
}

export async function addDiagnosticLogEntry(entry) {
  const list = await getDiagnosticLog();
  list.push(entry);
  if (list.length > DIAGNOSTIC_LOG_LIMIT) {
    list.splice(0, list.length - DIAGNOSTIC_LOG_LIMIT);
  }
  await chrome.storage.local.set({ [KEYS.DIAGNOSTIC_LOG]: list });
}

// 'info'-level breadcrumb — filtered out of the on-screen feed, kept in the downloaded report.
// The whole point is to be able to reconstruct exactly what the bot saw and decided at every
// fork, without having to reproduce the bug live to read console output.
export function addTraceEntry(module, message, context) {
  return addDiagnosticLogEntry({ at: Date.now(), level: 'info', module, message, context });
}

// every hh.ru main-frame navigation background.js sees, and whether it matched a content script —
// the direct record of "the tab landed on X and nothing was injected there", which is exactly what's
// needed to diagnose a run going silent on an unrecognized page
export async function getNavigationLog() {
  const result = await chrome.storage.local.get(KEYS.NAVIGATION_LOG);
  return result[KEYS.NAVIGATION_LOG] || [];
}

export async function addNavigationLogEntry(entry) {
  const list = await getNavigationLog();
  list.push(entry);
  if (list.length > NAVIGATION_LOG_LIMIT) {
    list.splice(0, list.length - NAVIGATION_LOG_LIMIT);
  }
  await chrome.storage.local.set({ [KEYS.NAVIGATION_LOG]: list });
}

// what the LLM was asked, what it answered, and what actually got clicked/typed on the page —
// kept separately from the response log so it survives independently of that log's own cap and
// can be reviewed to tune stylePrompt/legend without digging through console output
export async function getAnswersLog() {
  const result = await chrome.storage.local.get(KEYS.ANSWERS_LOG);
  return result[KEYS.ANSWERS_LOG] || [];
}

export async function addAnswersLogEntry(entry) {
  const list = await getAnswersLog();
  list.push(entry);
  if (list.length > ANSWERS_LOG_LIMIT) {
    list.splice(0, list.length - ANSWERS_LOG_LIMIT);
  }
  await chrome.storage.local.set({ [KEYS.ANSWERS_LOG]: list });
}

// ---- full-state export / import ------------------------------------------------------------
// Moving the extension to another browser/computer means carrying over everything it has ever
// stored, not just the settings form — blacklist, every log, answers. chrome.storage.local.get(null)
// / .set(...) already operate on the whole store, so the envelope below is just versioning +
// validation wrapped around that, kept in one place so the sidepanel code doesn't have to know
// the storage shape.

const EXPORT_APP_ID = 'hh-auto-otclicker';
const EXPORT_KIND = 'full-state-export';
const EXPORT_VERSION = 1;

const ARRAY_KEYS = new Set([
  KEYS.QUESTIONNAIRE_BLACKLIST,
  KEYS.RESPONSE_LOG,
  KEYS.DIAGNOSTIC_LOG,
  KEYS.NAVIGATION_LOG,
  KEYS.ANSWERS_LOG,
]);
const OBJECT_KEYS = new Set([KEYS.SETTINGS, KEYS.RUN_STATE]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function exportFullState() {
  const data = await chrome.storage.local.get(null);
  return {
    app: EXPORT_APP_ID,
    kind: EXPORT_KIND,
    exportVersion: EXPORT_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    data,
  };
}

// all-or-nothing check: a full list of every problem found, so a bad file is rejected in one shot
// instead of silently importing a partially-broken state one field at a time
export function validateFullStatePayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, errors: ['Файл повреждён: ожидался JSON-объект.'] };
  }

  const errors = [];
  if (payload.app !== EXPORT_APP_ID) {
    errors.push('Это не файл экспорта HH Auto Otclicker (не совпадает поле "app").');
  }
  if (payload.kind !== EXPORT_KIND) {
    errors.push('Неверный тип файла (не совпадает поле "kind").');
  }
  if (typeof payload.exportVersion !== 'number' || payload.exportVersion > EXPORT_VERSION) {
    errors.push(
      `Неподдерживаемая версия экспорта (${payload.exportVersion ?? 'отсутствует'}) — обновите расширение и повторите импорт.`,
    );
  }
  if (!isPlainObject(payload.data)) {
    errors.push('В файле отсутствует раздел с данными ("data").');
  }

  if (errors.length > 0) return { valid: false, errors };

  const dataKeys = Object.keys(payload.data);
  if (dataKeys.length === 0) {
    return { valid: false, errors: ['Файл не содержит ни одного раздела данных.'] };
  }

  for (const key of dataKeys) {
    if (!key.startsWith(KEY_PREFIX)) {
      errors.push(`Неизвестный ключ данных "${key}" — файл мог быть изменён вручную.`);
      continue;
    }
    const value = payload.data[key];
    if (ARRAY_KEYS.has(key) && !Array.isArray(value)) {
      errors.push(`Раздел "${key}" повреждён: ожидался список записей.`);
    }
    if (OBJECT_KEYS.has(key) && !isPlainObject(value)) {
      errors.push(`Раздел "${key}" повреждён: ожидался объект.`);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

// status/tabId/pendingVacancy describe a specific tab in a specific browser — carrying them over
// verbatim would leave the destination showing a phantom "running" state pointed at a tab that
// doesn't exist there.
function sanitizeImportedRunState(runState) {
  return {
    ...runState,
    status: 'stopped',
    tabId: null,
    pendingVacancy: null,
    currentVacancyTitle: null,
    currentVacancyCompany: null,
    awaitingApproval: false,
    lastError: null,
  };
}

// throws on any validation failure (message lists every problem found) — caller is expected to
// catch and show it, not to inspect a return value for success
export async function importFullState(payload) {
  const { valid, errors } = validateFullStatePayload(payload);
  if (!valid) throw new Error(errors.join(' '));

  const data = { ...payload.data };
  if (data[KEYS.RUN_STATE]) {
    data[KEYS.RUN_STATE] = sanitizeImportedRunState(data[KEYS.RUN_STATE]);
  }

  await chrome.storage.local.set(data);
  return Object.keys(data);
}
