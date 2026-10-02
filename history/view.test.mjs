// node --test history/view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNode, installFakeDom } from '../bench/fake-dom.mjs';

installFakeDom();

const { renderRows, renderToolbar } = await import('./view.js');

const entry = (at, vacancyId, title, probability, threshold = 0.5, extra = {}) => ({
  at,
  vacancyId,
  probability,
  threshold,
  cost: 0.00002,
  ms: 400,
  state: { title, company: 'Компания', location: 'Москва', ...extra },
});

const entries = [
  entry(1000, '1', 'Product Manager', 0.9),
  entry(2000, '2', 'Менеджер по продажам', 0.1),
  entry(3000, '3', '<img src=x onerror=alert(1)>', 0.4),
  entry(4000, '4', 'Руководитель проектов', 0.45, 0.4), // passed by the threshold of its time
];

const baseCtx = (overrides = {}) => ({
  entries,
  filter: 'all',
  query: '',
  openKeys: new Set(),
  onToggle() {},
  onFilter() {},
  onQuery() {},
  ...overrides,
});

const rowsOf = (ctx) => {
  const root = new FakeNode('div');
  renderRows(root, ctx);
  return root;
};

const titlesOf = (ctx) =>
  rowsOf(ctx)
    .byClass('vac-title')
    .map((node) => node.textContent);

test('renderRows', async (t) => {
  await t.test('the newest first', () => {
    assert.deepEqual(titlesOf(baseCtx()), [
      'Руководитель проектов',
      '<img src=x onerror=alert(1)>',
      'Менеджер по продажам',
      'Product Manager',
    ]);
  });

  await t.test('passed or rejected by the threshold the decision was made with', () => {
    const classes = rowsOf(baseCtx())
      .byClass('vac')
      .map((row) => row.className);
    assert.deepEqual(classes, ['vac vac_accept', 'vac vac_reject', 'vac vac_reject', 'vac vac_accept']);
  });

  await t.test('a card shows the percentage, the words of the decision and the fold with what was sent', () => {
    const [first] = rowsOf(baseCtx()).byClass('vac');
    assert.match(first.textContent, /45%/);
    assert.match(first.textContent, /пройдено/);
    assert.match(first.textContent, /Что отправлено и во сколько обошлось/);
    assert.match(first.textContent, /0,2 копейки · 400 мс/);
    assert.match(first.textContent, /company Компания/);
  });

  await t.test('a vacancy text never becomes markup', () => {
    const [, second] = rowsOf(baseCtx()).byClass('vac');
    assert.match(second.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(second.find((node) => node.tag === 'img').length, 0);
  });

  await t.test('the filters', () => {
    assert.equal(titlesOf(baseCtx({ filter: 'passed' })).length, 2);
    assert.deepEqual(titlesOf(baseCtx({ filter: 'rejected' })).length, 2);
  });

  await t.test('the search', () => {
    assert.deepEqual(titlesOf(baseCtx({ query: 'продаж' })), ['Менеджер по продажам']);
  });

  await t.test('a fold stays open when asked to', () => {
    const [first] = rowsOf(baseCtx({ openKeys: new Set([4000]) })).byClass('sent-details');
    assert.equal(first.attrs.open, '');
  });

  await t.test('no decisions yet', () => {
    assert.match(rowsOf(baseCtx({ entries: [] })).textContent, /Решений пока нет/);
  });

  await t.test('nothing passes the filter', () => {
    assert.match(rowsOf(baseCtx({ query: 'zzz' })).textContent, /Под фильтр ничего не попало/);
  });
});

test('renderToolbar counts per filter', () => {
  const root = new FakeNode('div');
  renderToolbar(root, baseCtx());
  assert.deepEqual(
    root.byClass('seg-count').map((node) => node.textContent),
    ['4', '2', '2'],
  );
});
