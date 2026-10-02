// node --test lib/blacklist-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIT_REJECTED,
  FIT_REJECTION_TTL_MS,
  blockedIds,
  fitRejectionEntry,
  fitRejections,
  pruneBlacklist,
} from './blacklist-core.js';

const NOW = 1_800_000_000_000;
const card = { vacancyId: '7', title: 'PM', company: 'Acme' };
const rejection = (vacancyId, fingerprint, probability, at = NOW) =>
  fitRejectionEntry({ card: { ...card, vacancyId }, probability, fingerprint, now: at });
const manual = (vacancyId) => ({ vacancyId, title: 'T', company: 'C', reason: 'manual_skip', at: NOW });

test('fitRejectionEntry', () => {
  assert.deepEqual(fitRejectionEntry({ card, probability: 0.31, fingerprint: 'f1', now: NOW }), {
    vacancyId: '7',
    title: 'PM',
    company: 'Acme',
    reason: FIT_REJECTED,
    probability: 0.31,
    fingerprint: 'f1',
    at: NOW,
  });
});

test('blockedIds holds every reason but the classifier', () => {
  const ids = blockedIds([manual('1'), rejection('2', 'f1', 0.2), { ...manual('3'), reason: 'popup_has_questions' }]);
  assert.deepEqual([...ids].sort(), ['1', '3']);
});

test('fitRejections', async (t) => {
  await t.test('only what this question rejected, by vacancy', () => {
    const map = fitRejections([rejection('1', 'f1', 0.2), rejection('2', 'other', 0.1), manual('3')], 'f1');
    assert.deepEqual([...map.keys()], ['1']);
  });

  await t.test('the latest rejection of a vacancy wins', () => {
    const map = fitRejections([rejection('1', 'f1', 0.2, NOW - 10), rejection('1', 'f1', 0.4, NOW)], 'f1');
    assert.equal(map.get('1').probability, 0.4);
  });
});

test('pruneBlacklist', async (t) => {
  const prune = (entries) => pruneBlacklist(entries, { fingerprint: 'f1', now: NOW });

  await t.test('keeps the entries of the vacancy\'s own reasons whatever their age', () => {
    const old = { ...manual('1'), at: NOW - 10 * FIT_REJECTION_TTL_MS };
    assert.deepEqual(prune([old]), [old]);
  });

  await t.test('keeps a fresh rejection by the current question', () => {
    const entry = rejection('1', 'f1', 0.2, NOW - FIT_REJECTION_TTL_MS);
    assert.deepEqual(prune([entry]), [entry]);
  });

  await t.test('drops a rejection older than the term', () => {
    assert.deepEqual(prune([rejection('1', 'f1', 0.2, NOW - FIT_REJECTION_TTL_MS - 1)]), []);
  });

  await t.test('drops a rejection made by another question', () => {
    assert.deepEqual(prune([rejection('1', 'other', 0.2)]), []);
  });
});
