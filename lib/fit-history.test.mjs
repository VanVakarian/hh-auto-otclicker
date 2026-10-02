// node --test lib/fit-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIT_HISTORY_LIMIT, appendFitHistory, fitHistoryEntry } from './fit-history.js';

const card = { vacancyId: '7', title: 'PM', company: 'Acme', location: '', requirements: 'Опыт от 3 лет' };

test('fitHistoryEntry keeps the answer, the threshold and the card as it went to the model', () => {
  const entry = fitHistoryEntry({ card, probability: 0.62, threshold: 0.5, cost: 0.00002, ms: 410, now: 1000 });
  assert.deepEqual(entry, {
    at: 1000,
    vacancyId: '7',
    probability: 0.62,
    threshold: 0.5,
    cost: 0.00002,
    ms: 410,
    state: { title: 'PM', company: 'Acme', requirements: 'Опыт от 3 лет' },
  });
});

test('appendFitHistory adds at the end and forgets the oldest over the limit', () => {
  assert.deepEqual(appendFitHistory([{ at: 1 }], { at: 2 }), [{ at: 1 }, { at: 2 }]);

  const full = Array.from({ length: FIT_HISTORY_LIMIT }, (_, index) => ({ at: index }));
  const next = appendFitHistory(full, { at: FIT_HISTORY_LIMIT });
  assert.equal(next.length, FIT_HISTORY_LIMIT);
  assert.equal(next[0].at, 1);
  assert.equal(next.at(-1).at, FIT_HISTORY_LIMIT);
});
