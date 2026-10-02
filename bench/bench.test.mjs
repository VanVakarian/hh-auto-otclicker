// node --test bench/bench.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithConcurrency, judgeWithRetries } from './runner.js';
import { vacancyVerdict, meanProbability, summarizePrompts, summarizeCost, histogram } from './stats.js';

test('runWithConcurrency', async (t) => {
  await t.test('runs every item, never more than `concurrency` at once', async () => {
    let running = 0;
    let peak = 0;
    const done = [];
    await runWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      async (item) => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        done.push(item);
      },
      { concurrency: 3, signal: new AbortController().signal },
    );
    assert.equal(peak, 3);
    assert.deepEqual(done.toSorted(), [1, 2, 3, 4, 5, 6, 7]);
  });

  await t.test('an aborted signal starts nothing more', async () => {
    const controller = new AbortController();
    const started = [];
    await runWithConcurrency(
      [1, 2, 3, 4, 5],
      async (item) => {
        started.push(item);
        if (item === 2) controller.abort();
      },
      { concurrency: 1, signal: controller.signal },
    );
    assert.deepEqual(started, [1, 2]);
  });

  await t.test('no items, no work', async () => {
    await runWithConcurrency([], async () => assert.fail('no item to run'), {
      concurrency: 5,
      signal: new AbortController().signal,
    });
  });
});

test('judgeWithRetries', async (t) => {
  const noWait = { wait: async () => {}, pauseMs: 0 };
  const sequence = (...results) => {
    const calls = [];
    const judge = async (params) => {
      calls.push(params);
      return results[Math.min(calls.length, results.length) - 1];
    };
    return { judge, calls };
  };

  await t.test('a result is final at once', async () => {
    const { judge, calls } = sequence({ success: true });
    assert.equal((await judgeWithRetries(judge, {}, noWait)).success, true);
    assert.equal(calls.length, 1);
  });

  await t.test('transient failures are retried until it works', async () => {
    const { judge, calls } = sequence({ success: false, kind: 'transient' }, { success: true });
    assert.equal((await judgeWithRetries(judge, {}, noWait)).success, true);
    assert.equal(calls.length, 2);
  });

  await t.test('transient failures give up after the retries', async () => {
    const { judge, calls } = sequence({ success: false, kind: 'transient' });
    assert.equal((await judgeWithRetries(judge, {}, { ...noWait, retries: 2 })).success, false);
    assert.equal(calls.length, 3);
  });

  for (const kind of ['unavailable', 'invalid']) {
    await t.test(`${kind} is not retried`, async () => {
      const { judge, calls } = sequence({ success: false, kind });
      await judgeWithRetries(judge, {}, noWait);
      assert.equal(calls.length, 1);
    });
  }

  await t.test('the pause grows with each attempt', async () => {
    const pauses = [];
    const { judge } = sequence({ success: false, kind: 'transient' });
    await judgeWithRetries(judge, {}, { retries: 2, pauseMs: 100, wait: async (ms) => pauses.push(ms) });
    assert.deepEqual(pauses, [100, 200]);
  });
});

// two prompts (A, B); a request carries both answers
const ok = (a, b) => ({
  ok: true,
  probabilities: { A: a, B: b },
  cost: 0.00002,
  inputTokens: 100,
  responseTime: 400,
});
const run = {
  prompts: { A: 'one', B: 'two' },
  vacancies: [{ vacancyId: '1' }, { vacancyId: '2' }, { vacancyId: '3' }, { vacancyId: '4' }, { vacancyId: '5' }],
  results: {
    1: ok(0.9, 0.8),
    2: ok(0.1, 0.2),
    3: ok(0.6, 0.4),
    4: { ok: false, kind: 'transient', error: 'x' },
    // 5 was never asked
  },
};

test('vacancyVerdict', async (t) => {
  await t.test('both prompts accept', () => assert.equal(vacancyVerdict(run, '1', 0.5), 'accept'));
  await t.test('both prompts reject', () => assert.equal(vacancyVerdict(run, '2', 0.5), 'reject'));
  await t.test('the prompts disagree', () => assert.equal(vacancyVerdict(run, '3', 0.5), 'mixed'));
  await t.test('a failure: no verdict', () => assert.equal(vacancyVerdict(run, '4', 0.5), 'none'));
  await t.test('never asked: no verdict', () => assert.equal(vacancyVerdict(run, '5', 0.5), 'none'));
  await t.test('the threshold moves the verdict', () => assert.equal(vacancyVerdict(run, '1', 0.99), 'reject'));
});

test('meanProbability', async (t) => {
  await t.test('the mean over the prompts', () => assert.ok(Math.abs(meanProbability(run, '3') - 0.5) < 1e-12));
  await t.test('no answer sorts last', () => {
    assert.equal(meanProbability(run, '4'), -1);
    assert.equal(meanProbability(run, '5'), -1);
  });
});

test('summarizePrompts', async (t) => {
  const find = (key, threshold = 0.5) => summarizePrompts(run, threshold).find((summary) => summary.promptKey === key);

  await t.test('splits the answers of a prompt at the threshold, counts failures', () => {
    const a = find('A');
    assert.deepEqual([a.accepted, a.rejected, a.failed], [2, 1, 1]);
    assert.deepEqual(a.probabilities, [0.9, 0.1, 0.6]);
  });

  await t.test('prompts are counted apart', () => {
    const b = find('B');
    assert.deepEqual([b.accepted, b.rejected, b.failed], [1, 2, 1]);
  });

  await t.test('a vacancy never asked is not counted', () => {
    const b = find('B');
    assert.equal(b.accepted + b.rejected + b.failed, 4);
  });

  await t.test('one entry per prompt', () => assert.equal(summarizePrompts(run, 0.5).length, 2));
});

test('summarizeCost', async (t) => {
  const cost = summarizeCost(run);

  await t.test('counts requests, failures and answers', () => {
    assert.deepEqual([cost.requests, cost.failed, cost.answered], [4, 1, 3]);
  });

  await t.test('costs only what was answered', () => {
    assert.ok(Math.abs(cost.cost - 0.00006) < 1e-12);
    assert.ok(Math.abs(cost.avgCost - 0.00002) < 1e-12);
    assert.equal(cost.avgInputTokens, 100);
    assert.equal(cost.avgResponseTime, 400);
  });

  await t.test('a run with no answers averages to zero', () => {
    const empty = summarizeCost({ ...run, results: {} });
    assert.deepEqual([empty.requests, empty.avgCost], [0, 0]);
  });
});

test('histogram', async (t) => {
  await t.test('counts per bin', () => {
    assert.deepEqual(histogram([0, 0.05, 0.1, 0.55, 0.99], 10), [2, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
  await t.test('1 falls into the last bin', () => assert.equal(histogram([1], 10)[9], 1));
  await t.test('nothing, nothing', () => assert.deepEqual(histogram([], 4), [0, 0, 0, 0]));
});
