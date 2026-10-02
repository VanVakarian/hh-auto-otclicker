// node --test bench/export.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport } from './export.js';

const card = (vacancyId, title, extra = {}) => ({
  vacancyId,
  title,
  company: 'Компания',
  responded: false,
  ...extra,
});

const answer = (a, b, state) => ({
  ok: true,
  probabilities: b === undefined ? { A: a } : { A: a, B: b },
  state,
  cost: 0.00002,
  inputTokens: 120,
  responseTime: 400,
  model: 'typesafe/jev-1.13-20260917',
});

const run = {
  startedAt: Date.UTC(2026, 9, 2, 12, 0),
  tabUrl: 'https://hh.ru/search/vacancy?text=pm&enable_snippets=true',
  view: 'expanded',
  prompts: { A: 'хочу быть продакт-менеджером\nне хочу в продажи' },
  vacancies: [
    card('1', 'Руководитель проектов (чистые помещения)', { responded: true }),
    card('2', 'Growth Product Manager'),
    card('3', 'Продакт-менеджер'),
    card('4', 'Менеджер проектов'),
  ],
  results: {
    1: answer(0.08, undefined, { title: 'Руководитель проектов (чистые помещения)', company: 'Компания' }),
    2: answer(0.92, undefined, {
      title: 'Growth Product Manager',
      company: 'Компания',
      responsibilities: 'Анализировать воронку',
      requirements: 'A/B тесты\nаналитика',
    }),
    3: answer(0.5, undefined, { title: 'Продакт-менеджер' }),
    4: { ok: false, kind: 'transient', error: 'HTTP 429: slow down', state: { title: 'Менеджер проектов' } },
  },
};

const sectionOf = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `no section "${heading}"`);
  const level = heading.match(/^#+/)[0].length;
  const length = text.slice(start + 1).search(new RegExp(`\\n#{1,${level}} `)); // up to the next heading as high or higher
  return text.slice(start, length === -1 ? undefined : start + 1 + length);
};

test('buildExport', async (t) => {
  const text = buildExport(run, 0.8);

  await t.test('carries the sections in order', () => {
    const headings = [
      '## 1. Задача',
      '## 2. Прогон',
      '## 3. Промпты и вопросы',
      '## 4. Итог',
      '## 5. Вакансии',
      '## 6. Что нужно от анализа',
    ];
    const positions = headings.map((heading) => text.indexOf(heading));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(
      positions,
      positions.toSorted((a, b) => a - b),
    );
  });

  await t.test('the prompt is quoted verbatim, line by line', () => {
    const section = sectionOf(text, '## 3.');
    assert.match(section, /> хочу быть продакт-менеджером\n> не хочу в продажи/);
  });

  await t.test('the question is given as the JSON that was sent', () => {
    const section = sectionOf(text, '## 3.');
    assert.match(section, /"type": "noul"/);
    assert.match(section, /Подходит ли эта вакансия соискателю\? Соискатель: хочу быть/);
  });

  await t.test('the run: view, model, cost', () => {
    const section = sectionOf(text, '## 2.');
    assert.match(section, /2026-10-02T12:00:00\.000Z/);
    assert.match(section, /enable_snippets=true/);
    assert.match(section, /expanded \(со сниппетами\)/);
    assert.match(section, /typesafe\/jev-1\.13-20260917/);
    assert.match(section, /\$0\.00006 всего/);
    assert.match(section, /из них с ошибкой: 1/);
  });

  await t.test('the summary at the threshold', () => {
    const section = sectionOf(text, '## 4.');
    assert.match(section, /при пороге 80%/);
    assert.match(section, /подходят 1, не подходят 2, ошибок 1/);
    assert.match(section, /90–100%: 1/);
  });

  await t.test('vacancies go from the most to the least probable, errors last', () => {
    const titles = [...text.matchAll(/^### \d+\. (.+?) — /gm)].map((match) => match[1]);
    assert.deepEqual(titles, [
      'Growth Product Manager',
      'Продакт-менеджер',
      'Руководитель проектов (чистые помещения)',
      'Менеджер проектов',
    ]);
  });

  await t.test('a vacancy: verdict at the threshold, link, and the state as it was sent', () => {
    const section = sectionOf(text, '### 1. Growth Product Manager');
    assert.match(section, /Ответ модели: 92% → подходит/);
    assert.match(section, /https:\/\/hh\.ru\/vacancy\/2/);
    assert.match(section, /responsibilities: Анализировать воронку/);
    assert.match(section, /requirements: A\/B тесты аналитика/); // a value never spans lines
  });

  await t.test('a vacancy that was answered before is marked', () => {
    assert.match(sectionOf(text, '### 3. Руководитель проектов'), /на неё уже откликались/);
  });

  await t.test('a failed request is shown with its error', () => {
    assert.match(sectionOf(text, '### 4. Менеджер проектов'), /ОШИБКА: HTTP 429: slow down/);
  });

  await t.test('the threshold changes the verdicts, not the probabilities', () => {
    const lenient = buildExport(run, 0.4);
    assert.match(sectionOf(lenient, '### 2. Продакт-менеджер'), /50% → подходит/);
    assert.match(sectionOf(text, '### 2. Продакт-менеджер'), /50% → не подходит/);
  });

  await t.test('several prompts: each answer is named', () => {
    const twoPrompts = {
      ...run,
      prompts: { A: 'один', B: 'два' },
      results: { 2: answer(0.9, 0.3, { title: 'Growth Product Manager' }) },
      vacancies: [run.vacancies[1]],
    };
    const section = sectionOf(buildExport(twoPrompts, 0.5), '### 1. Growth Product Manager');
    assert.match(section, /A=90% → подходит · B=30% → не подходит/);
  });

  await t.test('a vacancy never asked is said so', () => {
    const stopped = { ...run, results: {} };
    assert.match(sectionOf(buildExport(stopped, 0.8), '### 1. '), /нет ответа \(запрос не отправлялся\)/);
  });

  await t.test('ends with the request to the analyst', () => {
    assert.match(sectionOf(text, '## 6.'), /ложные «подходит» и ложные «не подходит»/);
    assert.ok(text.endsWith('\n'));
  });
});
