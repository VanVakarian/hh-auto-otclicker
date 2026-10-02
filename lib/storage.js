import { createJournal, isJournalKey } from './journal.js';
import { Stream } from './upload-core.js';

// DIAGNOSTIC_LOG and NAVIGATION_LOG are journal names, not storage keys: each journal lives under one
// key per hour, `<name>:<hour>` (see journal.js)
export const KEYS = {
  SETTINGS: 'hhaa_settings',
  RUN_STATE: 'hhaa_runState',
  RUN_PAUSE: 'hhaa_runPause',
  QUESTIONNAIRE_BLACKLIST: 'hhaa_questionnaireBlacklist',
  RESPONSE_LOG: 'hhaa_responseLog',
  DIAGNOSTIC_LOG: 'hhaa_diagnosticLog',
  NAVIGATION_LOG: 'hhaa_navigationLog',
  ANSWERS_LOG: 'hhaa_answersLog',
  SEARCHES: 'hhaa_searches',
  FIT_BENCH: 'hhaa_fitBench', // the vacancy-fit benchmark page: its prompts, threshold, last run and labels
  // sending diagnostics to the server (see uploader.js); these belong to this installation, see LOCAL_ONLY_KEYS
  INSTALL_ID: 'hhaa_installId',
  UPLOAD_CURSORS: 'hhaa_uploadCursors', // per stream: the position up to which everything is delivered
  UPLOAD_STATUS: 'hhaa_uploadStatus',
  UPLOAD_LOST: 'hhaa_uploadLost', // per stream: entries removed before delivery, told to the server with the next batch
  REJECTED_ARCHIVE: 'hhaa_rejectedArchive', // what the server refused or was never sent for its size
};

// What describes this installation and its delivery, not the person's data: left out of an export and
// untouched by an import — two browsers with the same id would be merged into one installation at the
// server, and a cursor from another browser would skip or repeat whatever it points at.
export const LOCAL_ONLY_KEYS = new Set([
  KEYS.INSTALL_ID,
  KEYS.UPLOAD_CURSORS,
  KEYS.UPLOAD_STATUS,
  KEYS.UPLOAD_LOST,
  KEYS.REJECTED_ARCHIVE,
]);

// every key this extension ever writes to chrome.storage.local uses this prefix — used to reject
// anything else on import instead of blindly writing arbitrary keys from a hand-edited file
const KEY_PREFIX = 'hhaa_';

export const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | assisted — assisted fills the questionnaire but waits for a human to approve the submit
  llmEnabled: true,
  apiKey: '',
  llmModelsRaw: '',
  captchaSolveEnabled: true, // solve hh.ru's captcha with a vision model (needs apiKey); off — wait for a person
  captchaModel: '', // empty = DEFAULT_CAPTCHA_MODEL of captcha-solver.js
  uploadKey: '', // the key for sending diagnostics to the server (see uploader.js); empty — nothing is sent
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
  stopReason: null, // a StopReason when the run ended by itself; null for a manual Stop
};

// Why a run stopped on its own — shown in the sidepanel, so a quiet stop never has to be guessed at
export const StopReason = {
  NO_MORE_VACANCIES: 'no_more_vacancies',
  DAILY_LIMIT: 'daily_limit',
  HH_DAILY_LIMIT: 'hh_daily_limit',
};

// Two kinds of log, kept differently on purpose. The response and answers logs are the user's own
// history (analytics over many days, answers to review before an interview), so they are kept for as
// long as there is room; the diagnostic and navigation logs are debugging aids whose value is "what
// just happened", so they expire by age: everything of the last day, and nothing older.
export const DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1000;

// While diagnostics are sent to the server (a key is set), a journal's entries are held until they are
// delivered: the age-based expiry does not touch what is newer than the stream's cursor. Only the storage
// budget below may remove them, and it says how many it took, so the server learns of the gap.
async function undeliveredFrom(stream) {
  const stored = await chrome.storage.local.get([KEYS.SETTINGS, KEYS.UPLOAD_CURSORS]);
  if (!stored[KEYS.SETTINGS]?.uploadKey?.trim()) return null;
  return stored[KEYS.UPLOAD_CURSORS]?.[stream]?.at ?? null;
}

const sentTo = (stream) => ({ retainFrom: () => undeliveredFrom(stream), onLost: (count) => addLost(stream, count) });

const responseJournal = createJournal(KEYS.RESPONSE_LOG, sentTo(Stream.RESPONSES));
const answersJournal = createJournal(KEYS.ANSWERS_LOG, sentTo(Stream.ANSWERS));
const diagnosticJournal = createJournal(KEYS.DIAGNOSTIC_LOG, {
  maxAgeMs: DIAGNOSTIC_RETENTION_MS,
  ...sentTo(Stream.DIAGNOSTICS),
});
const navigationJournal = createJournal(KEYS.NAVIGATION_LOG, {
  maxAgeMs: DIAGNOSTIC_RETENTION_MS,
  ...sentTo(Stream.NAVIGATION),
});
const historyJournals = [responseJournal, answersJournal];
const debugJournals = [diagnosticJournal, navigationJournal];
const journals = [...historyJournals, ...debugJournals];

// the journals that are sent, by the name of their stream
const journalsByStream = {
  [Stream.DIAGNOSTICS]: diagnosticJournal,
  [Stream.NAVIGATION]: navigationJournal,
  [Stream.RESPONSES]: responseJournal,
  [Stream.ANSWERS]: answersJournal,
};

export const SENT_JOURNAL_STREAMS = Object.keys(journalsByStream);

// entries oldest first with `fromMs <= at <= untilMs`, of the journal that makes up `stream`
export function readJournalRange(stream, range) {
  return journalsByStream[stream].readRange(range);
}

// how many entries each stream lost before they were delivered — told to the server with the stream's next batch
export async function getLost() {
  return (await chrome.storage.local.get(KEYS.UPLOAD_LOST))[KEYS.UPLOAD_LOST] ?? {};
}

export async function addLost(stream, count) {
  const lost = await getLost();
  lost[stream] = (lost[stream] ?? 0) + count;
  await chrome.storage.local.set({ [KEYS.UPLOAD_LOST]: lost });
}

// what was told to the server is no longer owed
export async function settleLost(stream, told) {
  const lost = await getLost();
  lost[stream] = Math.max(0, (lost[stream] ?? 0) - told);
  await chrome.storage.local.set({ [KEYS.UPLOAD_LOST]: lost });
}

// ---- one storage budget for every log ------------------------------------------------------
// chrome.storage.local holds 10 MB in total, and running out breaks everything at once (run state,
// settings). The logs are the only thing that grows, so ONE budget governs all of them — in bytes,
// measured, not estimated: an entry is anywhere from ~150 B (a response) to ~1.5 KB (a captcha's
// context), so a count of entries would be far too tight or far too loose. The high-water mark is 60%
// of the quota; the rest is headroom for the run state, settings and whatever is logged between checks.
//
// Over it, the debug journals' retention steps down a ladder — 24 h, 12 h, 6 h, 3 h, … — one halving at
// a time until the total fits. The ladder is walked from the top on every check instead of being
// remembered: each check simply keeps the longest step that fits, so there is no state to store, and
// no way for a one-off spike to leave retention cut short forever. A normal day (2–3 MB) never steps.
// Only if even an hour of debug entries doesn't fit — the user's own history is what fills the storage,
// months of it — the oldest history goes, oldest first, across both history logs.
const STORAGE_HIGH_WATER_BYTES = 6 * 1024 * 1024;
const MIN_RETENTION_MS = 60 * 60 * 1000; // journals expire by the hour, going below one means nothing
const BUDGET_CHECK_EVERY_APPENDS = 200; // between checks: at most this many entries of ~1.5 KB, well inside headroom

const bytesInUse = () => chrome.storage.local.getBytesInUse(null);
const hoursText = (ms) => `${Math.round((ms / 3600000) * 100) / 100}h`;

export async function enforceStorageBudget() {
  if ((await bytesInUse()) <= STORAGE_HIGH_WATER_BYTES) return;

  let retentionMs = DIAGNOSTIC_RETENTION_MS;
  while (retentionMs > MIN_RETENTION_MS && (await bytesInUse()) > STORAGE_HIGH_WATER_BYTES) {
    retentionMs /= 2;
    await Promise.all(debugJournals.map((journal) => journal.prune({ maxAgeMs: retentionMs, overrideHold: true })));
  }
  const message = `storage budget reached: debug logs cut to the last ${hoursText(retentionMs)}`;
  await diagnosticJournal.append({ at: Date.now(), level: 'warn', module: 'storage', message });

  while ((await bytesInUse()) > STORAGE_HIGH_WATER_BYTES) {
    const oldestHours = await Promise.all(historyJournals.map((journal) => journal.oldestHour()));
    if (oldestHours.every((hour) => hour === Infinity)) return;
    await historyJournals[oldestHours.indexOf(Math.min(...oldestHours))].dropOldestHour();
  }
}

let appendsSinceBudgetCheck = 0;

// every append goes through here, so the budget is checked as a side effect of the logging that grows it
function appendTo(journal, entry) {
  return journal.append(entry).then(() => {
    if (++appendsSinceBudgetCheck < BUDGET_CHECK_EVERY_APPENDS) return;
    appendsSinceBudgetCheck = 0;
    // housekeeping must not fail the flow that happened to write the entry it was triggered by; if it
    // fails it says so in the log (this module can't use diagnostics.js, which is built on top of it)
    enforceStorageBudget().catch((error) => {
      const message = `storage budget check failed: ${error.message}`;
      diagnosticJournal.append({ at: Date.now(), level: 'error', module: 'storage', message }).catch(() => {});
    });
  });
}

// Brings the journals in order: moves any still in their old single-key form into hours, drops what
// has aged out (on top of the once-an-hour check each journal does on its own appends, so a browser
// that sat idle for days doesn't carry the old entries until the next event happens), and checks the
// budget.
export async function maintainJournals() {
  await Promise.all(journals.map((journal) => journal.migrateLegacy()));
  await Promise.all(journals.map((journal) => journal.prune()));
  await enforceStorageBudget();
}

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
  await saveRunPause([]);
  await maintainJournals();
  return next;
}

// Why a running bot is standing still until a human (or the page) clears it. The bot never reads this —
// the page that observes the obstacle is the one that holds its own document, see run-control.js — it
// only tells the sidepanel and the badge that "running" currently means "waiting". It lives under its
// own key, not inside the run state, because the run state is rewritten whole by every flow step: one
// stale read-modify-write there would silently erase or resurrect a pause. Only meaningful while the
// run status is 'running'; whatever it holds after a stop is leftovers and gets reset by startRun.
// CAPTCHA_AUTO comes on top of CAPTCHA while the extension itself is solving the captcha: the panel then
// says it is being taken care of, and only a pause without it is one the person has to act on.
export const PauseReason = { CAPTCHA: 'captcha', CAPTCHA_AUTO: 'captcha_auto' };

export async function getRunPause() {
  const result = await chrome.storage.local.get(KEYS.RUN_PAUSE);
  return result[KEYS.RUN_PAUSE] || [];
}

export async function saveRunPause(reasons) {
  if (reasons.length > 0) await chrome.storage.local.set({ [KEYS.RUN_PAUSE]: reasons });
  else await chrome.storage.local.remove(KEYS.RUN_PAUSE);
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

// the single source of truth for "how many responses when" (daily count, rate windows); skips are
// logged too. Oldest first; `sinceMs` narrows the read to that recent a slice
export function getResponseLog(options) {
  return responseJournal.read(options);
}

export function addResponseLogEntry(entry) {
  return appendTo(responseJournal, entry);
}

const SUCCESS_RESULTS = new Set(['success_instant', 'success_popup', 'success_questionnaire']);

export function isSuccessResult(result) {
  return SUCCESS_RESULTS.has(result);
}

export async function countResponsesSince(sinceMs) {
  const list = await getResponseLog({ sinceMs: Date.now() - sinceMs });
  return list.filter((entry) => isSuccessResult(entry.result) && entry.at >= sinceMs).length;
}

export function getRespondedTodayCount() {
  return countResponsesSince(startOfTodayMs());
}

// oldest first; `sinceMs` narrows the read to that recent a slice (the on-screen feed doesn't need a day)
export function getDiagnosticLog(options) {
  return diagnosticJournal.read(options);
}

export function addDiagnosticLogEntry(entry) {
  return appendTo(diagnosticJournal, entry);
}

// 'info'-level breadcrumb — filtered out of the on-screen feed, kept in the downloaded report.
// The whole point is to be able to reconstruct exactly what the bot saw and decided at every
// fork, without having to reproduce the bug live to read console output.
// `data` is the same facts as fields of an object, for whoever analyses the log by program — the text
// in `context` is for reading by eye (an entry without fields simply has none).
export function addTraceEntry(module, message, context, data) {
  return addDiagnosticLogEntry({ at: Date.now(), level: 'info', module, message, context, data });
}

// every hh.ru main-frame navigation background.js sees, and whether it matched a content script —
// the direct record of "the tab landed on X and nothing was injected there", which is exactly what's
// needed to diagnose a run going silent on an unrecognized page
export function getNavigationLog(options) {
  return navigationJournal.read(options);
}

export function addNavigationLogEntry(entry) {
  return appendTo(navigationJournal, entry);
}

// what the LLM was asked, what it answered, and what actually got clicked/typed on the page —
// kept separately from the response log so it can be reviewed to tune stylePrompt/legend without
// digging through console output
export function getAnswersLog(options) {
  return answersJournal.read(options);
}

export function addAnswersLogEntry(entry) {
  return appendTo(answersJournal, entry);
}

// ---- full-state export / import ------------------------------------------------------------
// Moving the extension to another browser/computer means carrying over everything it has ever
// stored, not just the settings form — blacklist, every log, answers. chrome.storage.local.get(null)
// / .set(...) already operate on the whole store, so the envelope below is just versioning +
// validation wrapped around that, kept in one place so the sidepanel code doesn't have to know
// the storage shape.

const EXPORT_APP_ID = 'hh-auto-otclicker';
const EXPORT_KIND = 'full-state-export';
// 2: journals are stored one key per hour and `hhaa_searches` exists. A version 1 file is still
// accepted (its journals are single keys, migrated after the import); an extension that only knows
// version 1 refuses a version 2 file instead of importing it without the history it can't read
const EXPORT_VERSION = 2;

// the journals are stored as one key per hour, so they can't be listed by name — matched by prefix
// (an export from before that split carries each as one bare key, which is accepted and migrated)
const JOURNAL_NAMES = [KEYS.RESPONSE_LOG, KEYS.ANSWERS_LOG, KEYS.DIAGNOSTIC_LOG, KEYS.NAVIGATION_LOG];
const OBJECT_KEYS = new Set([KEYS.SETTINGS, KEYS.RUN_STATE]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// what the code reading each list relies on: a journal is ordered and bucketed by `at`, the blacklist
// is looked up by `vacancyId`, the searches list draws `text` and `chips`
const isJournalEntry = (entry) => isPlainObject(entry) && Number.isFinite(entry.at);
const isBlacklistEntry = (entry) => isPlainObject(entry) && entry.vacancyId !== undefined;
const isSearch = (search) =>
  isPlainObject(search) &&
  typeof search.query === 'string' &&
  typeof search.text === 'string' &&
  Array.isArray(search.chips);

function entryCheckOf(key) {
  if (key === KEYS.QUESTIONNAIRE_BLACKLIST) return isBlacklistEntry;
  if (key === KEYS.SEARCHES) return isSearch;
  if (JOURNAL_NAMES.some((name) => isJournalKey(key, name))) return isJournalEntry;
  return null;
}

// The section as the extension can use it: a list keeps the entries that pass their check, an object
// stays as it is (missing fields fall back to defaults when read). undefined — nothing of it is usable.
// A key this version doesn't know (written by a newer one) passes through untouched.
function sanitizeSection(key, value) {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  if (OBJECT_KEYS.has(key)) return isPlainObject(value) ? value : undefined;

  const isEntry = entryCheckOf(key);
  if (!isEntry) return value;
  return Array.isArray(value) ? value.filter(isEntry) : undefined;
}

export async function exportFullState() {
  const data = await chrome.storage.local.get(null);
  for (const key of LOCAL_ONLY_KEYS) delete data[key];
  return {
    app: EXPORT_APP_ID,
    kind: EXPORT_KIND,
    exportVersion: EXPORT_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    data,
  };
}

// the file as a whole: whether it is an export of this extension that this version can read at all.
// What is inside is not judged here — a bad section costs only itself, see importFullState
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

  return { valid: errors.length === 0, errors };
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
    stopReason: null,
  };
}

// Replaces the whole state with the file's. A broken file is refused; a broken part of a good file is
// left out and reported, so the rest still comes through: { imported, skipped, droppedEntries } — the
// keys written, the keys with nothing usable in them, and how many list entries failed their check.
// Throws when the file is refused, when nothing in it can be used, or when the write fails (the
// previous state is put back first) — the caller shows the message.
export async function importFullState(payload) {
  const { valid, errors } = validateFullStatePayload(payload);
  if (!valid) throw new Error(errors.join(' '));

  const data = {};
  const skipped = [];
  let droppedEntries = 0;
  for (const [key, value] of Object.entries(payload.data)) {
    if (key === KEYS.RUN_PAUSE) continue; // a pause belongs to a live page of a live run, never to an imported one
    if (LOCAL_ONLY_KEYS.has(key)) continue; // this installation's own, whatever a hand-edited file says

    const section = sanitizeSection(key, value);
    if (section === undefined) {
      skipped.push(key);
      continue;
    }
    if (Array.isArray(value)) droppedEntries += value.length - section.length;
    data[key] = section;
  }
  if (Object.keys(data).length === 0) throw new Error('В файле нет ни одного раздела, пригодного для импорта.');

  if (data[KEYS.RUN_STATE]) {
    data[KEYS.RUN_STATE] = sanitizeImportedRunState(data[KEYS.RUN_STATE]);
  }

  // chrome.storage.local.set only adds and overwrites, so what the file doesn't have is removed first:
  // nothing is left over from before, and the two states never add up against the quota. If the write
  // still fails, the old state goes back. This installation's own keys are not part of the state.
  const previous = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(
    Object.keys(previous).filter((key) => !(key in data) && !LOCAL_ONLY_KEYS.has(key)),
  );
  try {
    await chrome.storage.local.set(data);
  } catch (error) {
    await chrome.storage.local.set(previous);
    throw error;
  }

  await maintainJournals();
  return { imported: Object.keys(data), skipped, droppedEntries };
}
