import { KEYS } from './storage.js';
import { appendToArchive, startCursor } from './upload-core.js';

// What sending diagnostics to the server keeps in chrome.storage.local (the uploader writes, the sidepanel
// reads). All of it belongs to this installation and stays out of an export (see LOCAL_ONLY_KEYS).

// random, made on first use, never carried to another browser
export async function getInstallId() {
  const stored = (await chrome.storage.local.get(KEYS.INSTALL_ID))[KEYS.INSTALL_ID];
  if (stored) return stored;
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ [KEYS.INSTALL_ID]: installId });
  return installId;
}

// ---- cursors: per stream, the position up to which everything is delivered or put aside ------

async function readCursors() {
  return (await chrome.storage.local.get(KEYS.UPLOAD_CURSORS))[KEYS.UPLOAD_CURSORS] ?? {};
}

// a stream that has none yet starts a day back (what is older is not worth sending)
export async function getCursor(stream, now = Date.now()) {
  return (await readCursors())[stream] ?? startCursor(now);
}

// Written the moment sending is first on, not at the first delivery: the hold on the journals starts at
// the cursor, so without one nothing would be held until the first batch went.
export async function ensureCursors(streams, now = Date.now()) {
  const cursors = await readCursors();
  const missing = streams.filter((stream) => !cursors[stream]);
  if (missing.length === 0) return;
  for (const stream of missing) cursors[stream] = startCursor(now);
  await chrome.storage.local.set({ [KEYS.UPLOAD_CURSORS]: cursors });
}

export async function saveCursor(stream, cursor) {
  const cursors = await readCursors();
  cursors[stream] = cursor;
  await chrome.storage.local.set({ [KEYS.UPLOAD_CURSORS]: cursors });
}

// ---- status: what the panel shows ------------------------------------------------------------

export const DEFAULT_UPLOAD_STATUS = {
  lastAttemptAt: null,
  lastOkAt: null,
  error: null, // { at, kind, message } of the last cycle, null when it went well
  pending: 0, // events not delivered yet
  volume: null, // { day, bytes, warned } — what was sent today
  snapshotHash: null, // the state snapshot the server has
};

export async function getUploadStatus() {
  const stored = (await chrome.storage.local.get(KEYS.UPLOAD_STATUS))[KEYS.UPLOAD_STATUS];
  return { ...DEFAULT_UPLOAD_STATUS, ...(stored ?? {}) };
}

export async function saveUploadStatus(partial) {
  const next = { ...(await getUploadStatus()), ...partial };
  await chrome.storage.local.set({ [KEYS.UPLOAD_STATUS]: next });
  return next;
}

// ---- the archive of events the server refused, or that were never sent for their size -----------

export async function getRejectedArchive() {
  return (await chrome.storage.local.get(KEYS.REJECTED_ARCHIVE))[KEYS.REJECTED_ARCHIVE] ?? { entries: [], lost: 0 };
}

// `additions`: { event, code, message } — stamped here with when they were put aside
export async function addToRejectedArchive(additions) {
  if (additions.length === 0) return;
  const archivedAt = Date.now();
  const next = appendToArchive(
    await getRejectedArchive(),
    additions.map((addition) => ({ archivedAt, ...addition })),
  );
  await chrome.storage.local.set({ [KEYS.REJECTED_ARCHIVE]: next });
}

export function clearRejectedArchive() {
  return chrome.storage.local.remove(KEYS.REJECTED_ARCHIVE);
}
