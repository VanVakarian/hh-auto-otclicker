import {
  SENT_JOURNAL_STREAMS,
  addTraceEntry,
  getLost,
  getRunPause,
  getRunState,
  getSettings,
  readJournalRange,
  settleLost,
} from './storage.js';
import { getCaptchaPictures } from './captcha-store.js';
import { reportError, reportWarning } from './diagnostics.js';
import { hashText } from './hash.js';
import {
  addToRejectedArchive,
  ensureCursors,
  getCursor,
  getInstallId,
  getUploadStatus,
  saveCursor,
  saveUploadStatus,
} from './upload-store.js';
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  SETTLE_MS,
  Stream,
  addSentBytes,
  buildEvent,
  buildPictureEvents,
  buildRequestBody,
  buildStateSnapshot,
  byteLength,
  classifyStatus,
  eventFromEntry,
  isAfterCursor,
  isPlausibleKey,
  shrinkLimits,
  settleBatch,
  sizedEventsAfter,
  splitOversized,
  takeBatch,
  verifyAck,
} from './upload-core.js';

// Sends the diagnostics to the server (the backend's "ingest", plan 42) from the service worker: the
// journals after each stream's cursor, a snapshot of the state, and the captcha pictures. The contract and
// the rules of delivery are in plans/05; the decisions that need no browser are in upload-core.js.
//
// One cycle goes through the streams in turn. A batch counts as delivered only when the server's reply adds
// up (upload-core's verifyAck); then the cursor moves past it, what the server refused goes to the local
// archive, and the next batch follows. Anything else — no network, a 5xx, a reply that does not add up —
// leaves the cursor where it was and the whole thing is tried again at the next cycle.

const ORIGIN = 'https://app.vslav.dev';
// Two sources on the server: the logs, and the pictures (kept apart so the logs stay light to read and each
// has its own rotation). A route the server does not know answers 404.
const ROUTES = [
  { name: 'main', path: '/api/ingest/hh-auto-otclicker', streams: [...SENT_JOURNAL_STREAMS, Stream.STATE] },
  { name: 'pictures', path: '/api/ingest/hh-auto-otclicker-pictures', streams: [Stream.CAPTCHA_PICTURES] },
];
const CURSOR_STREAMS = [...SENT_JOURNAL_STREAMS, Stream.CAPTCHA_PICTURES];

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BATCHES_PER_CYCLE = 30; // a long backlog is worked through over several cycles
const PICTURES_PER_CYCLE = 20;

const failure = (kind, message) => ({ ok: false, kind, message });

// ---- what there is to send ------------------------------------------------------------------

async function collectJournal(session, stream) {
  const cursor = await getCursor(stream, session.now);
  const entries = await readJournalRange(stream, { fromMs: cursor.at, untilMs: session.ceiling });
  const events = entries.map((entry) => eventFromEntry(session.installId, stream, entry)).filter(Boolean);
  return { items: sizedEventsAfter(events, cursor), complete: true };
}

// The newest snapshot of the state, when it differs from the one the server has.
async function collectState(session) {
  const [runState, pause, settings, status] = await Promise.all([
    getRunState(),
    getRunPause(),
    getSettings(),
    getUploadStatus(),
  ]);
  const data = buildStateSnapshot({ version: chrome.runtime.getManifest().version, runState, pause, settings });
  const hash = hashText(JSON.stringify(data));
  if (hash === status.snapshotHash) return { items: [], complete: true };

  const { installId, now } = session;
  const event = buildEvent({ installId, stream: Stream.STATE, at: now, data, identity: hash });
  return { items: [{ event, bytes: byteLength(JSON.stringify(event)) }], complete: true, snapshotHash: hash };
}

// The oldest pictures the cursor has not passed, as events; `complete` — none was left for a later cycle.
async function collectPictures(session) {
  const cursor = await getCursor(Stream.CAPTCHA_PICTURES, session.now);
  const candidates = (await getCaptchaPictures()).filter(
    (picture) => picture.at >= cursor.at && picture.at <= session.ceiling,
  );

  const events = [];
  for (const picture of candidates.slice(0, PICTURES_PER_CYCLE)) {
    const { key, blob } = picture;
    events.push(
      ...buildPictureEvents({
        installId: session.installId,
        key,
        at: Math.floor(picture.at),
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: blob.type || 'image/png',
      }),
    );
  }
  return { items: sizedEventsAfter(events, cursor), complete: candidates.length <= PICTURES_PER_CYCLE };
}

function collect(session, stream) {
  if (stream === Stream.STATE) return collectState(session);
  if (stream === Stream.CAPTCHA_PICTURES) return collectPictures(session);
  return collectJournal(session, stream);
}

// ---- one request ----------------------------------------------------------------------------

async function post(session, route, events, dropped) {
  let response;
  try {
    response = await fetch(`${ORIGIN}${route.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': session.key, 'X-Client-ID': session.installId },
      body: JSON.stringify(buildRequestBody(events, dropped)),
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'retry', message: `no answer from the server: ${error.message}` };
  }

  const kind = classifyStatus(response.status);
  if (kind !== 'ok') return { kind, message: `HTTP ${response.status}` };
  try {
    return { kind: 'ok', body: await response.json() };
  } catch {
    return { kind: 'retry', message: 'the reply is not JSON' };
  }
}

const oversizedEntry = (item) => ({
  event: item.event,
  code: 'too_large_local',
  message: `${item.bytes} bytes, more than an event may be`,
});

// ---- a stream ---------------------------------------------------------------------------------

// Sends everything collected for the stream, batch after batch. Resolves to
// { ok: true, remaining } (what is left for a later cycle) or { ok: false, kind, message, remaining }.
async function deliver(session, route, stream, collected) {
  const cursorless = stream === Stream.STATE; // a snapshot is not a position in a journal
  let { sendable: queue, oversized } = splitOversized(collected);
  let limits = { maxEvents: MAX_BATCH_EVENTS, maxBytes: MAX_BATCH_BYTES };

  while (queue.length > 0) {
    if (session.batches >= MAX_BATCHES_PER_CYCLE) return { ok: true, remaining: queue.length };
    const { batch, rest, bytes } = takeBatch(queue, limits);
    const events = batch.map((item) => item.event);
    const dropped = (await getLost())[stream] ?? 0;

    const reply = await post(session, route, events, dropped);
    if (reply.kind === 'too_large') {
      if (batch.length === 1) {
        return { ...failure('bad_request', 'a single event was refused for its size'), remaining: queue.length };
      }
      limits = shrinkLimits(limits, batch.length);
      continue;
    }
    if (reply.kind !== 'ok') return { ...failure(reply.kind, reply.message), remaining: queue.length };

    const ack = verifyAck(reply.body, events.length);
    if (!ack.ok) return { ...failure('retry', ack.reason), remaining: queue.length };

    session.batches += 1;
    session.sentBytes += bytes;
    const { rejectedEntries, cursor } = settleBatch(events, ack.rejected);
    // the oversized events the cursor now passes are put aside with the rest
    const passed = oversized.filter((item) => !isAfterCursor(item.event, cursor));
    oversized = oversized.filter((item) => isAfterCursor(item.event, cursor));
    await addToRejectedArchive([...rejectedEntries, ...passed.map(oversizedEntry)]);
    if (!cursorless) await saveCursor(stream, cursor);
    if (dropped > 0) await settleLost(stream, dropped);
    queue = rest;
  }

  if (oversized.length > 0) {
    await addToRejectedArchive(oversized.map(oversizedEntry));
    const last = collected.at(-1).event;
    if (!cursorless) await saveCursor(stream, { at: last.at, id: last.id });
  }
  return { ok: true, remaining: 0 };
}

// ---- a cycle ----------------------------------------------------------------------------------

// Goes through the routes and streams once. Resolves to what the status should say about it.
async function sendEverything(session) {
  let pending = 0;
  let problem = null;
  const notConfigured = [];
  let snapshotHash;
  let picturesDeliveredBefore;

  for (const route of ROUTES) {
    let routeSkipped = false;
    for (const stream of route.streams) {
      const collected = await collect(session, stream);
      if (problem || routeSkipped) {
        pending += collected.items.length;
        continue;
      }

      const result = await deliver(session, route, stream, collected.items);
      pending += result.remaining;
      if (result.ok && stream === Stream.STATE && collected.snapshotHash) snapshotHash = collected.snapshotHash;
      if (result.ok && stream === Stream.CAPTCHA_PICTURES) {
        // every picture older than this has reached the server: all of them when nothing was left over
        picturesDeliveredBefore =
          result.remaining === 0 && collected.complete
            ? session.ceiling + 1
            : (await getCursor(Stream.CAPTCHA_PICTURES, session.now)).at;
      }
      if (result.ok) continue;

      if (result.kind === 'not_configured' && route.name !== 'main') {
        notConfigured.push(route.name); // this source is not set up on the server yet: the rest goes on
        routeSkipped = true;
      } else {
        problem = { kind: result.kind, message: result.message, route: route.name };
      }
    }
  }
  return { pending, problem, notConfigured, snapshotHash, picturesDeliveredBefore };
}

const PROBLEM_TEXTS = {
  unauthorized: 'the server did not accept the key (it is wrong, or the server has no keys set up)',
  not_configured: 'the server does not know this source',
  bad_request: 'the server found the request itself invalid',
  retry: 'the server did not confirm the delivery',
  bad_key: 'the key does not look like one (24-128 Latin letters and digits)',
  internal: 'the extension failed while sending',
};

// A change of state is written to the diagnostic log once; a cycle that fails the same way again is not —
// otherwise the log would grow from the very thing that is failing.
async function logTransition(previous, problem, outcome) {
  const kind = problem?.kind ?? null;
  if (kind === (previous.error?.kind ?? null)) return;

  if (problem) {
    const text = PROBLEM_TEXTS[kind] ?? kind;
    await reportWarning('upload', `sending diagnostics fails: ${text}`, `${problem.route ?? '-'}: ${problem.message}`, {
      kind,
      route: problem.route ?? null,
      detail: problem.message,
    });
  } else {
    await addTraceEntry('upload', 'sending diagnostics works again', `pending=${outcome.pending}`, {
      pending: outcome.pending,
    });
  }
}

async function cycle() {
  const settings = await getSettings();
  const key = settings.uploadKey.trim();
  if (!key) return getUploadStatus(); // switched off: the panel says so from the settings

  const now = Date.now();
  const previous = await getUploadStatus();
  let outcome = { pending: previous.pending, problem: null, notConfigured: previous.notConfigured };
  const session = {
    key,
    installId: await getInstallId(),
    now,
    ceiling: now - SETTLE_MS,
    batches: 0,
    sentBytes: 0,
  };

  try {
    if (isPlausibleKey(key)) {
      await ensureCursors(CURSOR_STREAMS, now);
      outcome = await sendEverything(session);
    } else {
      outcome.problem = { kind: 'bad_key', message: 'checked before sending' };
    }
  } catch (error) {
    outcome.problem = { kind: 'internal', message: error.message };
    await reportError('upload', `sending cycle failed: ${error.message}`);
  }

  const { problem } = outcome;
  const { volume, crossed } = addSentBytes(previous.volume, session.sentBytes, now);
  const status = await saveUploadStatus({
    lastAttemptAt: now,
    lastOkAt: problem ? previous.lastOkAt : Date.now(),
    error: problem ? { at: now, kind: problem.kind, message: problem.message, route: problem.route ?? null } : null,
    pending: outcome.pending,
    notConfigured: outcome.notConfigured,
    volume,
    ...(outcome.snapshotHash && { snapshotHash: outcome.snapshotHash }),
    ...(outcome.picturesDeliveredBefore !== undefined && { picturesDeliveredBefore: outcome.picturesDeliveredBefore }),
  });

  await logTransition(previous, problem, outcome);
  if (crossed) {
    await reportWarning(
      'upload',
      'more than the daily volume tripwire has been sent today: is something logging in a loop?',
      `bytesToday=${volume.bytes}`,
      { bytesToday: volume.bytes },
    );
  }
  return status;
}

// One cycle at a time: a second request while one is going gets the answer of the one that is.
let running = null;

export function uploadNow() {
  running ??= cycle()
    .catch(async (error) => {
      await reportError('upload', `sending cycle crashed: ${error.message}`);
      return getUploadStatus();
    })
    .finally(() => {
      running = null;
    });
  return running;
}
