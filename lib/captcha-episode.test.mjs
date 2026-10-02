// node --test lib/captcha-episode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEpisode } from './captcha-episode.js';

// a clock the test moves by hand
function episodeAt(shownAt = 1000) {
  const clock = { time: shownAt };
  const episode = createEpisode({ doc: 'd1', seq: 2, shownAt, now: () => clock.time });
  return { episode, at: (ms) => { clock.time = shownAt + ms; } };
}

test('an episode like the one at 04:40: rejected, a person presses the model\'s text, a person types their own', () => {
  const { episode, at } = episodeAt();

  episode.seen('A');
  at(500);
  episode.ready('A');
  at(2000);
  episode.modelAnswered('A', { attempt: 1, answer: 'пёкшемуся меха', transcript: 'пёкшемусямеха', agrees: true, ms: 2116, costUsd: 0.00007, result: 'answer' });
  at(5000);
  const first = episode.submitted('A', { by: 'extension', text: 'пёкшемуся меха', via: 'button' });
  assert.equal(first.textFromModel, true);
  at(5500);
  assert.equal(episode.verdict('A', 'rejected').verdict, 'rejected');

  episode.seen('B');
  at(9000);
  episode.modelAnswered('B', { attempt: 2, answer: 'объявления зёве', transcript: 'объявленийзёве', agrees: false, ms: 1317, costUsd: 0.00008, result: 'answer' });
  at(11000);
  const pressed = episode.submitted('B', { by: 'person', text: 'объявления зёве', via: 'button' });
  assert.equal(pressed.textFromModel, true, 'a person pressed the button over the model\'s answer');
  at(11500);
  episode.verdict('B', 'rejected');

  episode.seen('C');
  at(14000);
  assert.equal(episode.typed('C'), true);
  assert.equal(episode.typed('C'), false);
  at(16000);
  episode.handedOver('C', 'a person started typing (inputLen=7)');
  at(30000);
  const own = episode.submitted('C', { by: 'person', text: 'сбивая обнесёте', via: 'enter' });
  assert.equal(own.textFromModel, false);
  at(31000);
  episode.verdict('C', 'accepted');

  const summary = episode.summary({ solvedBy: 'person', endedBy: 'cleared', vacancyId: '137924605', flow: 'list' });
  assert.equal(summary.heldMs, 31000);
  assert.equal(summary.vacancyId, '137924605');
  assert.deepEqual(summary.totals, {
    pictures: 3,
    modelCalls: 2,
    modelCostUsd: 0.00015,
    submittedByExtension: 1,
    submittedByPerson: 2,
    accepted: 1,
    rejected: 2,
    unresolved: 0,
  });

  const [a, b, c] = summary.pictures;
  assert.deepEqual([a.seenMs, a.readyMs], [0, 500]);
  assert.equal(a.submissions[0].verdictMs, 5500);
  assert.equal(a.submissions[0].at, undefined, 'the epoch time stays out of the summary');
  assert.equal(b.model[0].agrees, false);
  assert.equal(c.firstKeystrokeMs, 14000);
  assert.equal(c.keystrokes, 2);
  assert.equal(c.handover.reason, 'a person started typing (inputLen=7)');
});

test('a verdict goes to the last submission that has none, and only once', () => {
  const { episode, at } = episodeAt();
  episode.seen('A');
  at(100);
  episode.submitted('A', { by: 'person', text: 'раз', via: 'button' });
  at(200);
  episode.submitted('A', { by: 'person', text: 'два', via: 'enter' });

  assert.equal(episode.verdict('A', 'rejected').text, 'два');
  assert.equal(episode.verdict('A', 'accepted').text, 'раз');
  assert.equal(episode.verdict('A', 'accepted'), null);
  assert.equal(episode.verdict('unknown', 'accepted'), null);
});

test('a submission without a verdict is reported as unresolved (the page left before hh.ru answered)', () => {
  const { episode, at } = episodeAt();
  episode.seen('A');
  at(4000);
  episode.submitted('A', { by: 'extension', text: 'татом прибудете', via: 'button' });
  assert.equal(episode.pendingSubmission('A').text, 'татом прибудете');

  at(4500);
  const summary = episode.summary({ solvedBy: null, endedBy: 'document_unloading', flow: 'questionnaire' });
  assert.equal(summary.totals.unresolved, 1);
  assert.equal(summary.endedBy, 'document_unloading');
  assert.equal(summary.vacancyId, null);
});

test('pictureAgeMs counts from the first sighting', () => {
  const { episode, at } = episodeAt();
  assert.equal(episode.pictureAgeMs('A'), null);
  at(1000);
  episode.seen('A');
  at(1800);
  episode.seen('A');
  assert.equal(episode.pictureAgeMs('A'), 800);
});

test('renewing a picture is recorded with who asked', () => {
  const { episode } = episodeAt();
  episode.renewed('A', 'person');
  assert.equal(episode.summary({ solvedBy: null, endedBy: 'cleared', flow: 'list' }).pictures[0].renewedBy, 'person');
});
