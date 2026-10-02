// node --test lib/fit-step.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FitAction, MAX_FAILURES_IN_A_ROW, UnavailableReason, createFitStep } from './fit-step.js';
import { fitRejectionEntry } from './blacklist-core.js';

const NOW = 1_800_000_000_000;
const card = { vacancyId: '7', title: 'Product Manager', company: 'Acme' };
const ok = (probability) => ({ success: true, probability, cost: 0.00002, ms: 480 });
const failure = (kind) => ({ success: false, kind, error: `${kind} failure` });

// a stand-in for the request: answers from the list one after another, remembers what it was asked about
function asker(...answers) {
  const asked = [];
  const ask = async (asked_card) => {
    asked.push(asked_card.vacancyId);
    return answers.length > 1 ? answers.shift() : answers[0];
  };
  return { ask, asked };
}

const judge = (step, { ask, rejections = new Map(), threshold = 0.5, vacancy = card } = {}) =>
  step({ card: vacancy, rejections, threshold, fingerprint: 'f1', ask, now: NOW });

const rejectionOf = (probability) =>
  new Map([['7', fitRejectionEntry({ card, probability, fingerprint: 'f1', now: NOW })]]);

test('a vacancy never asked about', async (t) => {
  await t.test('suits: respond, no entry, the price comes back', async () => {
    const { ask, asked } = asker(ok(0.8));
    const verdict = await judge(createFitStep(), { ask });
    assert.deepEqual(asked, ['7']);
    assert.deepEqual(verdict, { action: FitAction.RESPOND, probability: 0.8, cost: 0.00002, ms: 480, entry: null });
  });

  await t.test('does not suit: skip, with the entry for the blacklist', async () => {
    const verdict = await judge(createFitStep(), { ask: asker(ok(0.3)).ask });
    assert.equal(verdict.action, FitAction.SKIP);
    assert.equal(verdict.entry.probability, 0.3);
    assert.equal(verdict.entry.fingerprint, 'f1');
    assert.equal(verdict.entry.at, NOW);
  });

  await t.test('exactly the threshold suits', async () => {
    const verdict = await judge(createFitStep(), { ask: asker(ok(0.5)).ask });
    assert.equal(verdict.action, FitAction.RESPOND);
  });

  await t.test('a card without a title is not asked about and is no failure', async () => {
    const { ask, asked } = asker(ok(0.9));
    const step = createFitStep();
    for (let i = 0; i < MAX_FAILURES_IN_A_ROW + 1; i += 1) {
      const verdict = await judge(step, { ask, vacancy: { ...card, title: '' } });
      assert.deepEqual(verdict, { action: FitAction.UNRATED, reason: 'no title' });
    }
    assert.deepEqual(asked, []);
  });
});

test('a vacancy rejected before', async (t) => {
  await t.test('under the threshold: skip with no request and no new entry', async () => {
    const { ask, asked } = asker(ok(0.9));
    const verdict = await judge(createFitStep(), { ask, rejections: rejectionOf(0.3) });
    assert.deepEqual(verdict, { action: FitAction.SKIP, known: true });
    assert.deepEqual(asked, []);
  });

  await t.test('the threshold lowered under its probability: respond with no request', async () => {
    const { ask, asked } = asker(ok(0.9));
    const verdict = await judge(createFitStep(), { ask, rejections: rejectionOf(0.3), threshold: 0.3 });
    assert.deepEqual(verdict, { action: FitAction.RESPOND, known: true });
    assert.deepEqual(asked, []);
  });
});

test('failures', async (t) => {
  await t.test('a transient one passes the card over for this page', async () => {
    const verdict = await judge(createFitStep(), { ask: asker(failure('transient')).ask });
    assert.deepEqual(verdict, { action: FitAction.UNRATED, reason: 'transient', error: 'transient failure' });
  });

  await t.test('no answer at all is a transient failure', async () => {
    const verdict = await judge(createFitStep(), { ask: async () => undefined });
    assert.equal(verdict.reason, 'transient');
  });

  await t.test('an invalid request passes the card over and is not counted', async () => {
    const step = createFitStep();
    const { ask } = asker(failure('invalid'));
    for (let i = 0; i < MAX_FAILURES_IN_A_ROW + 1; i += 1) {
      assert.equal((await judge(step, { ask })).action, FitAction.UNRATED);
    }
  });

  await t.test('a refused key, balance or model makes the service unavailable at once', async () => {
    const verdict = await judge(createFitStep(), { ask: asker(failure('unavailable')).ask });
    assert.deepEqual(verdict, {
      action: FitAction.UNAVAILABLE,
      reason: UnavailableReason.SERVICE,
      error: 'unavailable failure',
    });
  });

  await t.test('the fifth failure in a row makes it unavailable', async () => {
    const step = createFitStep();
    const { ask } = asker(failure('transient'));
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i += 1) {
      assert.equal((await judge(step, { ask })).action, FitAction.UNRATED);
    }
    const verdict = await judge(step, { ask });
    assert.equal(verdict.action, FitAction.UNAVAILABLE);
    assert.equal(verdict.reason, UnavailableReason.UNRESPONSIVE);
  });

  await t.test('an answer in between starts the count over', async () => {
    const step = createFitStep();
    const bad = asker(failure('transient')).ask;
    const good = asker(ok(0.9)).ask;
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i += 1) await judge(step, { ask: bad });
    await judge(step, { ask: good });
    for (let i = 1; i < MAX_FAILURES_IN_A_ROW; i += 1) {
      assert.equal((await judge(step, { ask: bad })).action, FitAction.UNRATED);
    }
  });

  await t.test('a run that is not going gives a stop, not an error', async () => {
    const verdict = await judge(createFitStep(), { ask: asker(failure('skipped')).ask });
    assert.deepEqual(verdict, { action: FitAction.STOPPED });
  });
});
