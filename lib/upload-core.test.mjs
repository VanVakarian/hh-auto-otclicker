// node --test lib/upload-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashText } from './hash.js';
import {
  Stream,
  MAX_EVENT_BYTES,
  DAILY_VOLUME_WARN_BYTES,
  isPlausibleKey,
  buildEvent,
  eventFromEntry,
  compareEvents,
  isAfterCursor,
  startCursor,
  sizedEventsAfter,
  splitOversized,
  takeBatch,
  shrinkLimits,
  buildRequestBody,
  classifyStatus,
  verifyAck,
  settleBatch,
  appendToArchive,
  addSentBytes,
  buildStateSnapshot,
} from './upload-core.js';

const INSTALL = '0f8fad5b-d9cb-469f-a165-70867728950e';
const event = (at, id) => ({ at, id, stream: 'diagnostics', data: {} });
const sized = (bytes) => ({ event: event(1, 'x'), bytes });

test('hashText is stable and tells texts apart', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.match(hashText('капча'), /^[0-9a-f]{16}$/);
});

test('isPlausibleKey', async (t) => {
  const cases = [
    ['32 letters and digits', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF', true],
    ['24 is enough', 'a'.repeat(24), true],
    ['too short', 'a'.repeat(23), false],
    ['too long', 'a'.repeat(129), false],
    ['a space', `${'a'.repeat(30)} b`, false],
    ['cyrillic', 'а'.repeat(30), false],
    ['empty', '', false],
  ];
  for (const [name, key, expected] of cases) await t.test(name, () => assert.equal(isPlausibleKey(key), expected));
});

test('an event id is unique in the source, stable, and fits the server', () => {
  const entry = { at: 1790857580122, level: 'info', module: 'list', message: 'captcha shown' };
  const first = eventFromEntry(INSTALL, Stream.DIAGNOSTICS, entry);
  assert.deepEqual(first, eventFromEntry(INSTALL, Stream.DIAGNOSTICS, { ...entry }));
  assert.ok(first.id.length <= 128);
  assert.ok(first.id.startsWith(`${INSTALL}:diagnostics:1790857580122:`));
  assert.deepEqual(first.data, entry);
  assert.notEqual(first.id, eventFromEntry(INSTALL, Stream.DIAGNOSTICS, { ...entry, message: 'other' }).id);
  assert.notEqual(first.id, eventFromEntry(INSTALL, Stream.NAVIGATION, entry).id);
  assert.notEqual(first.id, eventFromEntry('another-install', Stream.DIAGNOSTICS, entry).id);
});

test('eventFromEntry refuses a time that is not a positive integer', async (t) => {
  const cases = [
    ['zero', 0, null],
    ['negative', -5, null],
    ['not a number', Number.NaN, null],
    ['a fraction is floored', 100.9, 100],
  ];
  for (const [name, at, expected] of cases) {
    await t.test(name, () => assert.equal(eventFromEntry(INSTALL, Stream.RESPONSES, { at })?.at ?? null, expected));
  }
});

test('events are ordered by time, then id; the cursor is a position in that order', () => {
  const ordered = [event(1, 'b'), event(2, 'a'), event(2, 'c'), event(3, 'a')];
  assert.deepEqual([...ordered].reverse().sort(compareEvents), ordered);

  const cursor = { at: 2, id: 'a' };
  assert.deepEqual(
    ordered.map((item) => isAfterCursor(item, cursor)),
    [false, false, true, true],
  );
  assert.equal(isAfterCursor(event(2, 'a'), cursor), false);
  assert.equal(isAfterCursor(event(2, 'a'), { at: 2, id: '' }), true);
});

test('startCursor is a day back and lets everything after it through', () => {
  const cursor = startCursor(100_000_000);
  assert.equal(cursor.at, 100_000_000 - 24 * 60 * 60 * 1000);
  assert.equal(isAfterCursor(event(cursor.at, 'any'), cursor), true);
});

test('sizedEventsAfter keeps what follows the cursor, in order, with sizes', () => {
  const items = sizedEventsAfter([event(3, 'a'), event(1, 'a'), event(2, 'z'), event(2, 'a')], { at: 2, id: 'a' });
  assert.deepEqual(
    items.map(({ event: item }) => `${item.at}${item.id}`),
    ['2z', '3a'],
  );
  assert.ok(items.every(({ bytes }) => bytes > 0));
});

test('splitOversized sets aside what the server would refuse for size', () => {
  const { sendable, oversized } = splitOversized([sized(10), sized(MAX_EVENT_BYTES), sized(MAX_EVENT_BYTES + 1)]);
  assert.equal(sendable.length, 2);
  assert.equal(oversized.length, 1);
});

test('takeBatch', async (t) => {
  const cases = [
    ['everything that fits', [sized(100), sized(100), sized(100)], { maxEvents: 10, maxBytes: 10_000 }, 3],
    ['the event count limit', [sized(10), sized(10), sized(10)], { maxEvents: 2, maxBytes: 10_000 }, 2],
    ['the size limit', [sized(300), sized(300), sized(300)], { maxEvents: 10, maxBytes: 800 }, 2],
    ['a first event larger than the limit still goes', [sized(5000), sized(1)], { maxEvents: 10, maxBytes: 100 }, 1],
    ['an empty queue', [], { maxEvents: 10, maxBytes: 100 }, 0],
  ];
  for (const [name, items, limits, expected] of cases) {
    await t.test(name, () => {
      const { batch, rest } = takeBatch(items, limits);
      assert.equal(batch.length, expected);
      assert.equal(rest.length, items.length - expected);
    });
  }
});

test('shrinkLimits halves and never goes below one event', () => {
  assert.deepEqual(shrinkLimits({ maxEvents: 1000, maxBytes: 400_000 }, 40), { maxEvents: 20, maxBytes: 200_000 });
  assert.equal(shrinkLimits({ maxEvents: 1000, maxBytes: 400_000 }, 1).maxEvents, 1);
});

test('buildRequestBody sends the lost count only when there is one', () => {
  assert.deepEqual(buildRequestBody([1], 0), { events: [1] });
  assert.deepEqual(buildRequestBody([1], 7), { events: [1], dropped: 7 });
});

test('classifyStatus', async (t) => {
  const cases = [
    [200, 'ok'],
    [401, 'unauthorized'],
    [404, 'not_configured'],
    [413, 'too_large'],
    [400, 'bad_request'],
    [500, 'retry'],
    [502, 'retry'],
    [403, 'retry'],
    [204, 'retry'],
  ];
  for (const [status, expected] of cases) {
    await t.test(String(status), () => assert.equal(classifyStatus(status), expected));
  }
});

test('verifyAck', async (t) => {
  const rejection = (index, code = 'bad_data') => ({ index, code, message: 'm' });
  const cases = [
    ['all stored', { received: 3, stored: 3, rejected: [] }, 3, true],
    ['some rejected', { received: 3, stored: 2, rejected: [rejection(1)] }, 3, true],
    ['all rejected', { received: 2, stored: 0, rejected: [rejection(0), rejection(1)] }, 2, true],
    ['received differs from sent', { received: 2, stored: 2, rejected: [] }, 3, false],
    ['stored and rejected do not add up', { received: 3, stored: 1, rejected: [rejection(0)] }, 3, false],
    ['rejection beyond the batch', { received: 2, stored: 1, rejected: [rejection(2)] }, 2, false],
    ['negative index', { received: 2, stored: 1, rejected: [rejection(-1)] }, 2, false],
    ['the same index twice', { received: 3, stored: 1, rejected: [rejection(0), rejection(0)] }, 3, false],
    ['rejected is null', { received: 1, stored: 1, rejected: null }, 1, false],
    ['no counts', {}, 1, false],
    ['not an object', null, 1, false],
    ['a rejection without a code', { received: 1, stored: 0, rejected: [{ index: 0 }] }, 1, false],
  ];
  for (const [name, body, sent, ok] of cases) await t.test(name, () => assert.equal(verifyAck(body, sent).ok, ok));
});

test('settleBatch moves the cursor past the batch and names the refused events', () => {
  const events = [event(1, 'a'), event(2, 'b'), event(2, 'c')];
  const { rejectedEntries, cursor } = settleBatch(events, [{ index: 1, code: 'bad_data', message: 'x' }]);
  assert.deepEqual(cursor, { at: 2, id: 'c' });
  assert.deepEqual(rejectedEntries, [{ event: events[1], code: 'bad_data', message: 'x' }]);
});

test('the rejected archive drops the oldest past its size and counts them', () => {
  const entry = (n) => ({ n, pad: 'x'.repeat(100) });
  const size = JSON.stringify(entry(1)).length;
  const roomForTwo = size * 2 + 10;

  const first = appendToArchive({ entries: [], lost: 0 }, [entry(1), entry(2)], roomForTwo);
  assert.deepEqual(first, { entries: [entry(1), entry(2)], lost: 0 });

  const second = appendToArchive(first, [entry(3)], roomForTwo);
  assert.deepEqual(second.entries.map(({ n }) => n), [2, 3]);
  assert.equal(second.lost, 1);

  const huge = appendToArchive({ entries: [], lost: 0 }, [{ pad: 'x'.repeat(5000) }], 100);
  assert.equal(huge.entries.length, 1, 'the newest entry is kept even when it alone is over the size');
});

test('addSentBytes counts per day and raises the tripwire once', () => {
  const noon = Date.UTC(2026, 9, 2, 12);
  const first = addSentBytes(undefined, 1000, noon);
  assert.deepEqual(first, { volume: { day: '2026-10-02', bytes: 1000, warned: false }, crossed: false });

  const crossing = addSentBytes(first.volume, DAILY_VOLUME_WARN_BYTES, noon);
  assert.equal(crossing.crossed, true);
  assert.equal(addSentBytes(crossing.volume, 10, noon).crossed, false);

  const nextDay = addSentBytes(crossing.volume, 5, noon + 24 * 60 * 60 * 1000);
  assert.deepEqual(nextDay.volume, { day: '2026-10-03', bytes: 5, warned: false });
});

test('only text streams are sent: no stream carries pictures', () => {
  assert.deepEqual(Object.values(Stream).sort(), ['answers', 'diagnostics', 'navigation', 'responses', 'state']);
});

test('the state snapshot holds no secret and no text of the person', () => {
  const settings = {
    mode: 'auto',
    llmEnabled: true,
    apiKey: 'sk-or-SECRET',
    uploadKey: 'UPLOADSECRETUPLOADSECRETUPLOAD',
    llmModelsRaw: 'a/b',
    captchaSolveEnabled: true,
    captchaModel: '',
    dailyLimit: 200,
    delayMinSec: 2,
    delayMaxSec: 5,
    coverLetterEnabled: true,
    coverLetterText: 'PRIVATE COVER LETTER',
    legend: 'PRIVATE LEGEND',
    stylePrompt: 'PRIVATE STYLE',
    chatLlmPromptRaw: 'PRIVATE CHAT PROMPT',
    blacklistCompaniesRaw: 'One\nTwo\n\nThree',
    skipStopWordsRaw: '',
    vacancyTitleStopWordsRaw: 'x',
    fitEnabled: true,
    fitThreshold: 0.4,
    fitPrompt: 'PRIVATE FIT PROMPT',
  };
  const runState = {
    status: 'running',
    stopReason: null,
    startedAt: 1,
    processedVacancyIds: ['1', '2'],
    awaitingApproval: false,
    lastError: null,
  };

  const snapshot = buildStateSnapshot({ version: '1.6.0', runState, pause: ['captcha'], settings });
  const json = JSON.stringify(snapshot);
  for (const secret of ['sk-or-SECRET', 'UPLOADSECRET', 'PRIVATE']) assert.ok(!json.includes(secret), secret);

  assert.equal(snapshot.run.processedCount, 2);
  assert.equal(snapshot.settings.hasApiKey, true);
  assert.equal(snapshot.settings.blacklistCompanies, 3);
  assert.equal(snapshot.settings.skipStopWords, 0);
  assert.equal(snapshot.settings.fitEnabled, true);
  assert.equal(snapshot.settings.fitThreshold, 0.4);
  assert.match(snapshot.settings.fingerprints.fitPrompt, /^[0-9a-f]{16}$/);
  assert.notEqual(snapshot.settings.fingerprints.legend, buildStateSnapshot({
    version: '1.6.0',
    runState,
    pause: [],
    settings: { ...settings, legend: 'changed' },
  }).settings.fingerprints.legend);
});
