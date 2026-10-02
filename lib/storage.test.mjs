// node --test lib/storage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// chrome.storage.local over a plain object: what the blacklist, the spend counter and the export need of it
function installFakeChrome(initial = {}) {
  const data = structuredClone(initial);
  const pick = (keys) => {
    if (keys == null) return structuredClone(data);
    const list = typeof keys === 'string' ? [keys] : keys;
    return structuredClone(Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]])));
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (items) => Object.assign(data, structuredClone(items)),
        remove: async (keys) => [].concat(keys).forEach((key) => delete data[key]),
        getKeys: async () => Object.keys(data),
        getBytesInUse: async () => JSON.stringify(data).length,
      },
    },
    runtime: { getManifest: () => ({ version: '0.0.0' }) },
  };
  return data;
}

const {
  KEYS,
  DEFAULT_SETTINGS,
  addBlacklistEntry,
  addFitSpend,
  getBlacklist,
  getFitSpend,
  importFullState,
  maintainStorage,
} = await import('./storage.js');
const { fitFingerprint } = await import('./vacancy-fit.js');
const { FIT_REJECTION_TTL_MS, fitRejectionEntry } = await import('./blacklist-core.js');

const LEGACY_KEY = 'hhaa_questionnaireBlacklist';
const card = { vacancyId: '7', title: 'PM', company: 'Acme' };
const questionnaireEntry = (vacancyId) => ({ vacancyId, title: 'T', company: 'C', reason: 'llm_failed', at: 1 });

test('the blacklist', async (t) => {
  await t.test('entries of every reason go into the one list', async () => {
    installFakeChrome();
    await addBlacklistEntry(questionnaireEntry('1'));
    await addBlacklistEntry(fitRejectionEntry({ card, probability: 0.2, fingerprint: 'f', now: 5 }));
    assert.deepEqual((await getBlacklist()).map((entry) => entry.reason), ['llm_failed', 'fit_rejected']);
  });

  await t.test('the old questionnaire list is carried over, ahead of what the new key has', async () => {
    const data = installFakeChrome({
      [LEGACY_KEY]: [questionnaireEntry('1')],
      [KEYS.VACANCY_BLACKLIST]: [questionnaireEntry('2')],
    });
    await maintainStorage();
    assert.deepEqual((await getBlacklist()).map((entry) => entry.vacancyId), ['1', '2']);
    assert.ok(!(LEGACY_KEY in data));
  });

  await t.test('maintenance drops the rejections that no longer count and keeps the rest', async () => {
    const fingerprint = fitFingerprint(DEFAULT_SETTINGS.fitPrompt);
    const now = Date.now();
    const rejection = (vacancyId, fp, at) =>
      fitRejectionEntry({ card: { ...card, vacancyId }, probability: 0.2, fingerprint: fp, now: at });
    installFakeChrome({
      [KEYS.VACANCY_BLACKLIST]: [
        questionnaireEntry('1'),
        rejection('2', fingerprint, now),
        rejection('3', 'another question', now),
        rejection('4', fingerprint, now - FIT_REJECTION_TTL_MS - 1000),
      ],
    });
    await maintainStorage();
    assert.deepEqual((await getBlacklist()).map((entry) => entry.vacancyId), ['1', '2']);
  });

  await t.test('an import of an old file brings its list to the current key', async () => {
    const data = installFakeChrome();
    const payload = {
      app: 'hh-auto-otclicker',
      kind: 'full-state-export',
      exportVersion: 2,
      data: { [LEGACY_KEY]: [questionnaireEntry('1'), { broken: true }] },
    };
    const { droppedEntries } = await importFullState(payload);
    assert.equal(droppedEntries, 1);
    assert.deepEqual((await getBlacklist()).map((entry) => entry.vacancyId), ['1']);
    assert.ok(!(LEGACY_KEY in data));
  });
});

test('the spend counter', async (t) => {
  await t.test('starts at nothing', async () => {
    installFakeChrome();
    assert.deepEqual(await getFitSpend(), { requests: 0, cost: 0 });
  });

  await t.test('counts every request and its price', async () => {
    installFakeChrome();
    await addFitSpend(0.00002);
    await addFitSpend(0.00003);
    const spend = await getFitSpend();
    assert.equal(spend.requests, 2);
    assert.ok(Math.abs(spend.cost - 0.00005) < 1e-12);
  });
});
