// A journal: an append-only list of entries `{ at, ... }`, optionally kept only for a fixed span of time.
// A journal itself has no size cap — a bot doing a few actions a second doesn't produce a volume that
// needs one; the total across all journals is kept inside the storage quota by the budget in storage.js,
// which uses `prune` with a shorter age, and `dropOldestHour` as the last resort.
//
// Storage shape: one chrome.storage.local key per hour, `<name>:<hour index>`, holding that hour's
// entries. Chosen over a single ever-growing list because a single list is rewritten whole on every
// append (and shipped whole, twice, to every onChanged listener):
//  - an append touches only the current hour's list, however long the journal has grown;
//  - expiry is deleting whole keys, no entry-by-entry filtering and no rewriting of what stays;
//  - reading "the last few hours" (today's response count, the on-screen feed) reads only those hours.
// The price is granularity: an hour expires as a whole, so a journal with a `maxAgeMs` holds between
// that and that plus one hour — "at least the last day" is the promise.

const HOUR_MS = 60 * 60 * 1000;

// maxAgeMs: how long entries are kept; the default keeps them forever
export function createJournal(name, { maxAgeMs = Infinity } = {}) {
  const hourOf = (at) => Math.floor(at / HOUR_MS);
  const keyOf = (hour) => `${name}:${hour}`;
  const hourOfKey = (key) => Number(key.slice(name.length + 1));

  async function hourKeys() {
    const keys = await chrome.storage.local.getKeys();
    return keys.filter((key) => key.startsWith(`${name}:`));
  }

  // appends of one context are chained: two racing read-modify-writes of the same hour would lose one
  let appending = Promise.resolve();
  let lastPrunedHour = null;

  async function appendNow(entry) {
    const key = keyOf(hourOf(entry.at));
    const list = (await chrome.storage.local.get(key))[key] ?? [];
    list.push(entry);
    await chrome.storage.local.set({ [key]: list });

    // expiry is checked once per hour per context — the first append into a new hour — not on every append
    const currentHour = hourOf(Date.now());
    if (lastPrunedHour !== currentHour) {
      lastPrunedHour = currentHour;
      await prune();
    }
  }

  function append(entry) {
    const result = appending.then(() => appendNow(entry));
    appending = result.catch(() => {});
    return result;
  }

  // `maxAgeMs` here overrides the journal's own — how the storage budget asks a journal to hold less
  async function prune({ maxAgeMs: keepMs = maxAgeMs } = {}) {
    const oldestKeptHour = hourOf(Date.now() - keepMs);
    const expired = (await hourKeys()).filter((key) => hourOfKey(key) < oldestKeptHour);
    if (expired.length > 0) await chrome.storage.local.remove(expired);
  }

  // the hour index of the oldest entries held, Infinity when the journal is empty
  async function oldestHour() {
    const hours = (await hourKeys()).map(hourOfKey);
    return hours.length > 0 ? Math.min(...hours) : Infinity;
  }

  async function dropOldestHour() {
    const hour = await oldestHour();
    if (hour !== Infinity) await chrome.storage.local.remove(keyOf(hour));
  }

  // Before the split into hours a journal lived whole under the bare `name` key. Its entries are dealt
  // into their hours, merged with whatever those hours already hold, and the old key is removed. Safe to
  // run any number of times, from any number of contexts at once: entries are merged by content, so a
  // second pass over the same old key adds nothing.
  async function migrateLegacy() {
    const legacy = (await chrome.storage.local.get(name))[name];
    if (legacy === undefined) return;

    if (Array.isArray(legacy) && legacy.length > 0) {
      const byHour = Map.groupBy(legacy, (entry) => hourOf(entry.at));
      const keys = [...byHour.keys()].map(keyOf);
      const existing = await chrome.storage.local.get(keys);

      const merged = {};
      for (const [hour, entries] of byHour) {
        const key = keyOf(hour);
        const seen = new Map();
        for (const entry of [...(existing[key] ?? []), ...entries]) seen.set(JSON.stringify(entry), entry);
        merged[key] = [...seen.values()].sort((a, b) => a.at - b.at);
      }
      await chrome.storage.local.set(merged);
    }
    await chrome.storage.local.remove(name);
  }

  // entries oldest first; `sinceMs` narrows the read to the hours that can contain anything that recent
  async function read({ sinceMs = maxAgeMs } = {}) {
    const firstHour = hourOf(Date.now() - sinceMs);
    const keys = (await hourKeys()).filter((key) => hourOfKey(key) >= firstHour);
    const stored = await chrome.storage.local.get(keys);
    // an hour can be pruned by another context between listing the keys and reading them
    return keys.flatMap((key) => stored[key] ?? []).sort((a, b) => a.at - b.at);
  }

  return { append, read, prune, oldestHour, dropOldestHour, migrateLegacy };
}

// whether a storage key belongs to the journal `name` (an hour of it, or its old single-key form)
export function isJournalKey(key, name) {
  return key === name || key.startsWith(`${name}:`);
}
