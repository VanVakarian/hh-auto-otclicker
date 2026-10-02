// node --test bench/view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The smallest DOM the view needs: enough to build the tree and read its text back. What it checks is that
// the figures and the filters come out right, and that a vacancy's text can never turn into markup.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.vars = {};
    this.listeners = {};
    this.className = '';
    this.style = { setProperty: (key, value) => (this.vars[key] = value) };
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  get textContent() {
    return this.children.map((child) => (typeof child === 'object' ? child.textContent : String(child))).join(' ');
  }
  find(predicate, found = []) {
    for (const child of this.children) {
      if (typeof child !== 'object') continue;
      if (predicate(child)) found.push(child);
      child.find(predicate, found);
    }
    return found;
  }
  byClass(name) {
    return this.find((node) => node.className.split(' ').includes(name));
  }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag) };

const { renderRows, renderStats, renderToolbar } = await import('./view.js');

const card = (vacancyId, title, extra = {}) => ({
  vacancyId,
  title,
  company: 'Компания',
  location: 'Москва',
  experience: 'Опыт 3-6 лет',
  workFormat: 'Можно удалённо',
  responsibilities: '',
  requirements: '',
  responded: false,
  ...extra,
});

const answer = (a, b) => ({
  ok: true,
  probabilities: b === undefined ? { A: a } : { A: a, B: b },
  state: { title: 'x' },
  cost: 0.00002,
  inputTokens: 120,
  responseTime: 400,
  model: 'typesafe/jev-1.13-20260917',
});

const run = {
  startedAt: Date.UTC(2026, 9, 2, 12, 0),
  tabUrl: 'https://hh.ru/search/vacancy?text=pm',
  view: 'expanded',
  prompts: { A: 'хочу быть продакт-менеджером' },
  vacancies: [
    card('1', 'Growth Product Manager'),
    card('2', 'Руководитель проектов (чистые помещения)', { responded: true }),
    card('3', '<img src=x onerror=alert(1)>'),
    card('4', 'Менеджер проектов'),
  ],
  results: {
    1: answer(0.95),
    2: answer(0.05),
    3: answer(0.2),
    4: { ok: false, kind: 'transient', error: 'HTTP 429', state: { title: 'Менеджер проектов' } },
  },
};

const baseCtx = (overrides = {}) => ({
  run,
  vacancies: run.vacancies,
  prompts: run.prompts,
  threshold: 0.5,
  filter: 'all',
  sort: 'order',
  query: '',
  openIds: new Set(),
  onToggle() {},
  onFilter() {},
  onSort() {},
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
  await t.test('one row per vacancy, with its answer', () => {
    const root = rowsOf(baseCtx());
    assert.equal(root.byClass('vac').length, 4);
    const first = root.byClass('vac')[0].textContent;
    assert.match(first, /Growth Product Manager/);
    assert.match(first, /95%/);
  });

  await t.test('the stripe follows the verdict at the threshold', () => {
    const classes = rowsOf(baseCtx())
      .byClass('vac')
      .map((row) => row.className);
    assert.deepEqual(classes, ['vac vac_accept', 'vac vac_reject', 'vac vac_reject', 'vac vac_none']);
  });

  await t.test('the threshold moves the verdicts', () => {
    const classes = rowsOf(baseCtx({ threshold: 0.99 }))
      .byClass('vac')
      .map((row) => row.className);
    assert.deepEqual(classes.slice(0, 2), ['vac vac_reject', 'vac vac_reject']);
  });

  await t.test('a failed request shows as an error, not as a probability', () => {
    const fourth = rowsOf(baseCtx()).byClass('vac')[3];
    assert.equal(fourth.byClass('cell_error').length, 1);
  });

  await t.test('a vacancy text never becomes markup', () => {
    const third = rowsOf(baseCtx()).byClass('vac')[2];
    assert.match(third.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(third.find((node) => node.tag === 'img').length, 0);
  });

  await t.test('the filters', () => {
    assert.deepEqual(titlesOf(baseCtx({ filter: 'accept' })), ['Growth Product Manager']);
    assert.equal(titlesOf(baseCtx({ filter: 'reject' })).length, 2);
    assert.deepEqual(titlesOf(baseCtx({ filter: 'error' })), ['Менеджер проектов']);
    assert.equal(titlesOf(baseCtx({ filter: 'mixed' })).length, 0);
  });

  await t.test('the search', () => {
    assert.equal(titlesOf(baseCtx({ query: 'чистые' })).length, 1);
  });

  await t.test('the sorting by probability puts the unanswered last', () => {
    const high = titlesOf(baseCtx({ sort: 'high' }));
    assert.match(high[0], /Growth/);
    assert.equal(high.at(-1), 'Менеджер проектов');
    assert.match(titlesOf(baseCtx({ sort: 'low' }))[1], /Руководитель/);
  });

  await t.test('several prompts: an answer per prompt, named', () => {
    const twoPrompts = {
      ...run,
      prompts: { A: 'один', B: 'два' },
      vacancies: [run.vacancies[0]],
      results: { 1: answer(0.9, 0.3) },
    };
    const row = rowsOf(
      baseCtx({ run: twoPrompts, vacancies: twoPrompts.vacancies, prompts: twoPrompts.prompts }),
    ).byClass('vac')[0];
    assert.equal(row.byClass('cell').length, 2);
    assert.match(row.textContent, /Промпт A/);
    assert.match(row.className, /vac_mixed/);
  });

  await t.test('before a run: the cards and what would be sent, no verdicts', () => {
    const root = rowsOf(baseCtx({ run: null }));
    assert.equal(root.byClass('vac').length, 4);
    assert.equal(root.byClass('cell_empty').length, 4);
    assert.equal(root.byClass('vac_accept').length, 0);
  });

  await t.test('no cards at all', () => {
    assert.match(rowsOf(baseCtx({ vacancies: [] })).textContent, /Карточек нет/);
  });

  await t.test('nothing passes the filter', () => {
    assert.match(rowsOf(baseCtx({ filter: 'mixed' })).textContent, /Под фильтр ничего не попало/);
  });
});

test('renderToolbar', async (t) => {
  await t.test('counts per filter', () => {
    const root = new FakeNode('div');
    renderToolbar(root, baseCtx());
    const counts = root.byClass('seg-count').map((node) => node.textContent);
    assert.deepEqual(counts, ['4', '1', '2', '0', '1']);
  });
});

test('renderStats', async (t) => {
  const stats = (ctx = baseCtx()) => {
    const root = new FakeNode('div');
    renderStats(root, ctx);
    return root;
  };

  await t.test('the whole cost, the cost of a request, the requests', () => {
    const text = stats().textContent;
    assert.match(text, /Потрачено \$0\.00006 /); // 3 answered requests of $0.00002
    assert.match(text, /За запрос \$0\.00002/);
    assert.match(text, /Запросов 4 1 с ошибкой/);
  });

  await t.test('one summary card for one prompt', () => {
    assert.equal(stats().byClass('sum-card').length, 1);
  });

  await t.test('the split of the answers at the threshold', () => {
    const [big] = stats().byClass('sum-big');
    assert.match(big.textContent, /1 подходят/);
    assert.match(big.textContent, /2 нет/);
    assert.match(big.textContent, /1 ошибок/);
  });

  await t.test('no run, no figures', () => {
    assert.equal(stats(baseCtx({ run: null })).children.length, 0);
  });
});
