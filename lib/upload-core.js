import { hashText } from './hash.js';

// The pure half of sending diagnostics to the server (the worker side is uploader.js): how a journal
// entry becomes an event, in what order and in which batches events go, how the server's reply is checked
// and what a confirmed batch moves. Kept free of any extension API so it can be tested on its own
// (upload-core.test.mjs). The contract it follows is the backend's plan 42 (the "ingest" contract v1).

// Stream names on the wire; the journals' names plus the one that is not a journal
export const Stream = {
  DIAGNOSTICS: 'diagnostics',
  NAVIGATION: 'navigation',
  RESPONSES: 'responses',
  ANSWERS: 'answers',
  STATE: 'state',
};

// The server's limits (plan 42) and ours, kept inside them
export const MAX_BATCH_EVENTS = 1000;
export const MAX_BATCH_BYTES = 400 * 1024; // the request limit is 512 KiB
export const MAX_EVENT_BYTES = 64 * 1024;
const BATCH_OVERHEAD_BYTES = 64; // `{"events":[],"dropped":N}` and the commas

// Entries land in storage from several contexts a moment after they happened: nothing newer than this is
// read, so an entry stamped before the cursor never turns up behind it
export const SETTLE_MS = 5000;
export const START_LOOKBACK_MS = 24 * 60 * 60 * 1000; // what is sent when sending is switched on

export const REJECTED_ARCHIVE_MAX_BYTES = 1_000_000;
export const DAILY_VOLUME_WARN_BYTES = 25 * 1024 * 1024; // a tripwire for a runaway log, not a limit

// the server accepts 24-128 letters and digits as a key; anything else is wrong before it is even sent
export const isPlausibleKey = (key) => /^[A-Za-z0-9]{24,128}$/.test(key);

const encoder = new TextEncoder();
export const byteLength = (text) => encoder.encode(text).length;

// ---- events ---------------------------------------------------------------------------------

// The id is unique in the source on its own (the server does not deduplicate; the reader collapses by id)
// and the same every time the same entry is sent again. `identity` is what tells two entries of the same
// stream and millisecond apart — by default the entry itself.
export function buildEvent({ installId, stream, at, data, identity = JSON.stringify(data) }) {
  return { id: `${installId}:${stream}:${at}:${hashText(identity)}`, stream, at, data };
}

// the entry of a journal as an event, or null for one that can't be one (a time that is not a positive integer)
export function eventFromEntry(installId, stream, entry) {
  const at = Math.floor(entry.at);
  if (!(at > 0)) return null;
  return buildEvent({ installId, stream, at, data: entry });
}

// The order events are sent in, and the cursor's meaning: everything up to a position in this order is
// delivered. Time first, the id breaks ties — so a batch can end anywhere, even between two events of the
// same millisecond.
export function compareEvents(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export const isAfterCursor = (event, cursor) =>
  event.at > cursor.at || (event.at === cursor.at && event.id > cursor.id);

export const startCursor = (now) => ({ at: now - START_LOOKBACK_MS, id: '' });

// the events after the cursor, in order, each with its size on the wire
export function sizedEventsAfter(events, cursor) {
  return events
    .filter((event) => isAfterCursor(event, cursor))
    .sort(compareEvents)
    .map((event) => ({ event, bytes: byteLength(JSON.stringify(event)) }));
}

// An event the server would refuse for its size is never sent: it would only come back as a rejection.
export function splitOversized(items) {
  return {
    sendable: items.filter((item) => item.bytes <= MAX_EVENT_BYTES),
    oversized: items.filter((item) => item.bytes > MAX_EVENT_BYTES),
  };
}

// The first events of the queue that fit one request. The first event always goes in, whatever its size
// (it is no larger than an event may be), so a queue always moves.
export function takeBatch(items, { maxEvents = MAX_BATCH_EVENTS, maxBytes = MAX_BATCH_BYTES } = {}) {
  let bytes = BATCH_OVERHEAD_BYTES;
  let count = 0;
  while (count < items.length && count < maxEvents) {
    const next = bytes + items[count].bytes + 1;
    if (count > 0 && next > maxBytes) break;
    bytes = next;
    count += 1;
  }
  return { batch: items.slice(0, count), rest: items.slice(count), bytes };
}

// after a 413: a smaller batch (never less than one event)
export function shrinkLimits(limits, batchLength) {
  return {
    maxEvents: Math.max(1, Math.floor(batchLength / 2)),
    maxBytes: Math.max(1, Math.floor(limits.maxBytes / 2)),
  };
}

export function buildRequestBody(events, dropped) {
  return dropped > 0 ? { events, dropped } : { events };
}

// ---- the server's reply ---------------------------------------------------------------------

// how the client reacts to a status: ok is read further, the rest decide what to do about the batch
export function classifyStatus(status) {
  if (status === 200) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_configured';
  if (status === 413) return 'too_large';
  if (status === 400) return 'bad_request';
  return 'retry'; // 5xx and anything unexpected: nothing is counted as delivered
}

// The reply is trusted only when it adds up: everything sent was received, and what was stored plus what
// was rejected is everything received, every rejection pointing at an event of this batch.
export function verifyAck(body, sentCount) {
  const { received, stored, rejected } = body ?? {};
  if (!Number.isInteger(received) || !Number.isInteger(stored) || !Array.isArray(rejected)) {
    return { ok: false, reason: 'the reply does not have received/stored/rejected' };
  }
  if (received !== sentCount) return { ok: false, reason: `the server received ${received} of ${sentCount}` };
  if (stored + rejected.length !== received) {
    return { ok: false, reason: `stored ${stored} + rejected ${rejected.length} is not received ${received}` };
  }

  const indexes = new Set();
  for (const item of rejected) {
    const valid =
      Number.isInteger(item?.index) &&
      item.index >= 0 &&
      item.index < sentCount &&
      !indexes.has(item.index) &&
      typeof item.code === 'string';
    if (!valid) return { ok: false, reason: 'a rejection does not point at an event of the batch' };
    indexes.add(item.index);
  }

  return {
    ok: true,
    stored,
    rejected: rejected.map(({ index, code, message }) => ({ index, code, message: String(message ?? '') })),
  };
}

// What a confirmed batch changes: the events the server refused (for the local archive) and the new cursor,
// just past the batch's last event.
export function settleBatch(events, rejected) {
  const last = events.at(-1);
  return {
    rejectedEntries: rejected.map(({ index, code, message }) => ({ event: events[index], code, message })),
    cursor: { at: last.at, id: last.id },
  };
}

// ---- the archive of rejected events --------------------------------------------------------

// Oldest go first when the archive outgrows its size; `lost` counts them so nothing vanishes unseen.
export function appendToArchive(archive, additions, maxBytes = REJECTED_ARCHIVE_MAX_BYTES) {
  const entries = [...archive.entries, ...additions];
  let bytes = entries.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
  let lost = archive.lost;
  while (bytes > maxBytes && entries.length > 1) {
    bytes -= JSON.stringify(entries.shift()).length;
    lost += 1;
  }
  return { entries, lost };
}

// ---- volume ---------------------------------------------------------------------------------

// What was sent today, and whether this send is the one that crossed the tripwire (once a day).
export function addSentBytes(volume, bytes, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const today = volume?.day === day ? volume : { day, bytes: 0, warned: false };
  const total = today.bytes + bytes;
  const crossed = !today.warned && total > DAILY_VOLUME_WARN_BYTES;
  return { volume: { day, bytes: total, warned: today.warned || crossed }, crossed };
}

// ---- the state snapshot ---------------------------------------------------------------------

const listLines = (raw) => (raw ?? '').split('\n').filter((line) => line.trim() !== '').length;

// What the state stream carries: how the extension was set up and what it was doing — never a secret and
// never a text of the person's (a prompt is only a fingerprint: it shows that it changed, not what it says).
export function buildStateSnapshot({ version, runState, pause, settings }) {
  return {
    version,
    run: {
      status: runState.status,
      stopReason: runState.stopReason,
      startedAt: runState.startedAt,
      processedCount: runState.processedVacancyIds.length,
      awaitingApproval: runState.awaitingApproval,
      lastError: runState.lastError,
    },
    pause,
    settings: {
      mode: settings.mode,
      llmEnabled: settings.llmEnabled,
      hasApiKey: Boolean(settings.apiKey?.trim()),
      llmModels: settings.llmModelsRaw,
      captchaSolveEnabled: settings.captchaSolveEnabled,
      captchaModel: settings.captchaModel,
      dailyLimit: settings.dailyLimit,
      delayMinSec: settings.delayMinSec,
      delayMaxSec: settings.delayMaxSec,
      coverLetterEnabled: settings.coverLetterEnabled,
      blacklistCompanies: listLines(settings.blacklistCompaniesRaw),
      skipStopWords: listLines(settings.skipStopWordsRaw),
      vacancyTitleStopWords: listLines(settings.vacancyTitleStopWordsRaw),
      fitEnabled: settings.fitEnabled,
      fitThreshold: settings.fitThreshold,
      fingerprints: {
        legend: hashText(settings.legend ?? ''),
        stylePrompt: hashText(settings.stylePrompt ?? ''),
        coverLetterText: hashText(settings.coverLetterText ?? ''),
        chatLlmPrompt: hashText(settings.chatLlmPromptRaw ?? ''),
        fitPrompt: hashText(settings.fitPrompt ?? ''),
      },
    },
  };
}
