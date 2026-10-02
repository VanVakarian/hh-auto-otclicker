// node --test lib/vacancy-fit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVacancyState, buildFitQuestions, parseFitAnswers, isFit, judgeVacancy } from './vacancy-fit.js';

const vacancy = {
  title: 'Growth Product Manager',
  company: 'POFKARIO',
  location: '',
  experience: 'Опыт 3-6 лет',
  workFormat: 'Можно удалённо',
  responsibilities: 'Анализировать продуктовую воронку',
  requirements: '  ',
};

// stands in for the network: every call is recorded, the reply is whatever the test hands over
function mockFetch(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply;
  });
  return calls;
}

const okReply = (answers, usage = { input_tokens: 120, output_tokens: 8, cost: 0.000005 }) => ({
  ok: true,
  json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers, usage }),
});

test('buildVacancyState', async (t) => {
  await t.test('keeps the facts, renames workFormat, drops the empty ones', () => {
    assert.deepEqual(buildVacancyState(vacancy), {
      title: 'Growth Product Manager',
      company: 'POFKARIO',
      experience: 'Опыт 3-6 лет',
      work_format: 'Можно удалённо',
      responsibilities: 'Анализировать продуктовую воронку',
    });
  });

  await t.test('a card of the compact view has no snippets', () => {
    assert.deepEqual(buildVacancyState({ title: 'PM', responsibilities: '', requirements: '' }), { title: 'PM' });
  });
});

test('buildVacancyState sends what the card has', async (t) => {
  const compact = { ...vacancy, responsibilities: '', requirements: '' };
  const expanded = { ...vacancy, requirements: 'Опыт в Jira' };

  await t.test('a compact card: the facts of the card, no snippets', () => {
    assert.deepEqual(Object.keys(buildVacancyState(compact)), ['title', 'company', 'experience', 'work_format']);
  });
  await t.test('an expanded card: the same plus both snippets', () => {
    assert.deepEqual(Object.keys(buildVacancyState(expanded)), [
      'title',
      'company',
      'experience',
      'work_format',
      'responsibilities',
      'requirements',
    ]);
  });
  await t.test('what is not part of the decision is not sent', () => {
    const state = buildVacancyState({ ...expanded, vacancyId: '1', responded: true });
    assert.equal('vacancyId' in state || 'responded' in state, false);
  });
});

test('buildFitQuestions', async (t) => {
  await t.test('one noul question per prompt, under the prompt key', () => {
    const questions = buildFitQuestions({ strict: ' product менеджер IT ', loose: 'любой менеджер' });
    assert.deepEqual(Object.keys(questions), ['strict', 'loose']);
    assert.equal(questions.strict.type, 'noul');
    assert.equal(questions.strict.instructions, 'Подходит ли эта вакансия соискателю? Соискатель: product менеджер IT');
    assert.deepEqual(Object.keys(questions.strict.criteria), ['true', 'false']);
  });
});

test('parseFitAnswers', async (t) => {
  const cases = [
    ['one answer', { fit: { type: 'noul', noul: 0.87 } }, ['fit'], { fit: 0.87 }],
    ['two answers', { a: { noul: 0.1 }, b: { noul: 1 } }, ['a', 'b'], { a: 0.1, b: 1 }],
    ['the bounds are probabilities', { a: { noul: 0 } }, ['a'], { a: 0 }],
    ['an answer is missing', { a: { noul: 0.5 } }, ['a', 'b'], null],
    ['a choice answer is no noul', { a: { type: 'choice', choice: 'x' } }, ['a'], null],
    ['not a number', { a: { noul: '0.5' } }, ['a'], null],
    ['above one', { a: { noul: 1.2 } }, ['a'], null],
    ['below zero', { a: { noul: -0.1 } }, ['a'], null],
    ['no answers at all', undefined, ['a'], null],
  ];

  for (const [name, answers, keys, expected] of cases) {
    await t.test(name, () => assert.deepEqual(parseFitAnswers(answers, keys), expected));
  }
});

test('isFit', async (t) => {
  await t.test('the threshold itself fits', () => assert.equal(isFit(0.8, 0.8), true));
  await t.test('below it does not', () => assert.equal(isFit(0.79, 0.8), false));
});

test('judgeVacancy', async (t) => {
  await t.test('sends state and questions to the Decisions endpoint and returns probabilities', async (t) => {
    const calls = mockFetch(t, okReply({ fit: { type: 'noul', noul: 0.93 } }));
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { fit: 'product менеджер IT' } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer key');
    assert.equal(calls[0].body.model, 'typesafe/jev-1.13');
    assert.equal(calls[0].body.state.title, 'Growth Product Manager');
    assert.deepEqual(Object.keys(calls[0].body.questions), ['fit']);

    assert.equal(result.success, true);
    assert.deepEqual(result.request, { state: calls[0].body.state, questions: calls[0].body.questions });
    assert.deepEqual(result.probabilities, { fit: 0.93 });
    assert.equal(result.metadata.outputTokens, 8);
    assert.equal(result.metadata.model, 'typesafe/jev-1.13-20260917');
    assert.equal(result.metadata.cost, 0.000005);
    assert.equal(result.metadata.inputTokens, 120);
  });

  await t.test('several prompts are one request', async (t) => {
    const calls = mockFetch(t, okReply({ a: { noul: 0.9 }, b: { noul: 0.2 } }));
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { a: 'один', b: 'два' } });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.probabilities, { a: 0.9, b: 0.2 });
  });

  await t.test('no key: nothing is sent', async (t) => {
    const calls = mockFetch(t, okReply({}));
    const result = await judgeVacancy({ apiKey: ' ', vacancy, prompts: { fit: 'x' } });
    assert.deepEqual([result.success, result.kind, calls.length], [false, 'unavailable', 0]);
  });

  await t.test('an empty prompt: nothing is sent', async (t) => {
    const calls = mockFetch(t, okReply({}));
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { fit: '  ' } });
    assert.deepEqual([result.success, result.kind, calls.length], [false, 'invalid', 0]);
  });

  await t.test('no prompts: nothing is sent', async (t) => {
    const calls = mockFetch(t, okReply({}));
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: {} });
    assert.deepEqual([result.success, result.kind, calls.length], [false, 'invalid', 0]);
  });

  await t.test('a vacancy without a title: nothing is sent', async (t) => {
    const calls = mockFetch(t, okReply({}));
    const result = await judgeVacancy({ apiKey: 'key', vacancy: { ...vacancy, title: '' }, prompts: { fit: 'x' } });
    assert.deepEqual([result.success, result.kind, calls.length], [false, 'invalid', 0]);
  });

  for (const [status, kind] of [
    [401, 'unavailable'],
    [402, 'unavailable'],
    [404, 'unavailable'],
    [429, 'transient'],
    [524, 'transient'],
  ]) {
    await t.test(`HTTP ${status} is ${kind}`, async (t) => {
      mockFetch(t, { ok: false, status, text: async () => 'nope' });
      const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { fit: 'x' } });
      assert.deepEqual([result.success, result.kind], [false, kind]);
      assert.match(result.error, new RegExp(`HTTP ${status}`));
      assert.equal(result.request.state.title, 'Growth Product Manager');
    });
  }

  await t.test('a network failure is transient', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Failed to fetch');
    });
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { fit: 'x' } });
    assert.deepEqual([result.success, result.kind, result.error], [false, 'transient', 'Failed to fetch']);
  });

  await t.test('answers without a probability are transient', async (t) => {
    mockFetch(t, okReply({ fit: { type: 'choice', choice: 'yes' } }));
    const result = await judgeVacancy({ apiKey: 'key', vacancy, prompts: { fit: 'x' } });
    assert.deepEqual([result.success, result.kind], [false, 'transient']);
  });
});
