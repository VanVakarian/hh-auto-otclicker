// The captcha pictures the watcher has met, as PNG blobs in IndexedDB. Not chrome.storage.local: that
// is a JSON store whose quota the logs share (see storage.js), and binary data would only cost it
// base64 bloat and a trip through every onChanged listener. Written by the background worker, read by
// the sidepanel — both live in the extension's own origin, so they see the same database.

const DB_NAME = 'hhaa_captchas';
const STORE = 'pictures';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// resolves with the result of the request `action` returns (if any) once the whole transaction has committed
async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// keyed by hh.ru's own picture key, so a picture seen twice is stored once
export function addCaptchaPicture({ key, at, blob }) {
  return withStore('readwrite', (store) => store.put({ key, at, blob }));
}

// oldest first
export async function getCaptchaPictures() {
  const pictures = await withStore('readonly', (store) => store.getAll());
  return pictures.sort((a, b) => a.at - b.at);
}

// only the given pictures: whatever arrived after they were read stays
export function deleteCaptchaPictures(keys) {
  return withStore('readwrite', (store) => {
    for (const key of keys) store.delete(key);
  });
}
