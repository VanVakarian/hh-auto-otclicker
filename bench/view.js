import { isFit, buildVacancyState } from '../lib/vacancy-fit.js';
import {
  hasError,
  histogram,
  meanProbability,
  recordOf,
  summarizeCost,
  summarizePrompts,
  vacancyVerdict,
} from './stats.js';

// Everything on the page that comes from the outside — vacancy texts, error bodies — is put in as text, never
// as markup: `el` builds nodes, it does not parse HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'vars') for (const [key, val] of Object.entries(value)) node.style.setProperty(key, val);
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

const VERDICT_NAME = { accept: 'подходит', reject: 'не подходит', mixed: 'спорная', none: 'без оценки' };

const pct = (probability) => `${Math.round(probability * 100)}%`;
const usd = (cost) => `$${cost.toFixed(7).replace(/0+$/, '').replace(/\.$/, '') || '0'}`;
const ms = (value) => `${Math.round(value)} мс`;
const chip = (text, modifier = '') => el('span', { class: `chip ${modifier}`.trim() }, text);

// ---- the probability bar: filled to the probability, a tick at the threshold, green or red by which side -----

function probabilityBar(probability, threshold) {
  return el(
    'div',
    {
      class: `pbar ${isFit(probability, threshold) ? 'pbar_ok' : 'pbar_no'}`,
      vars: { '--p': `${probability * 100}%`, '--t': `${threshold * 100}%` },
      title: `${(probability * 100).toFixed(1)}%`,
    },
    el('div', { class: 'pbar-fill' }),
    el('div', { class: 'pbar-tick' }),
  );
}

// one answer: the percentage first, then what it means at this threshold, then the bar
function answerCell(record, promptKey, ctx, multiplePrompts) {
  const title = multiplePrompts
    ? el('div', { class: 'cell-prompt', title: ctx.prompts[promptKey] }, `Промпт ${promptKey}`)
    : null;
  if (!record) return el('div', { class: 'cell cell_empty' }, title, '—');
  if (!record.ok) return el('div', { class: 'cell cell_error', title: record.error }, title, '⚠ ошибка запроса');

  const probability = record.probabilities[promptKey];
  const fit = isFit(probability, ctx.threshold);
  return el(
    'div',
    { class: `cell ${fit ? 'cell_ok' : 'cell_no'}` },
    title,
    el('div', { class: 'cell-pct' }, pct(probability)),
    el('div', { class: 'cell-verdict' }, fit ? 'подходит' : 'не подходит'),
    probabilityBar(probability, ctx.threshold),
  );
}

// ---- a vacancy ---------------------------------------------------------------------------------------------

function stateList(state) {
  return el(
    'dl',
    { class: 'state' },
    Object.entries(state).flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)]),
  );
}

// exactly what went (or, before a run, will go) to the model, and what the answer cost
function sentDetails(vacancy, ctx) {
  const record = ctx.run ? recordOf(ctx.run, vacancy.vacancyId) : null;
  const state = record?.state ?? buildVacancyState(vacancy);
  let meta = 'ещё не отправлялось';
  if (record?.ok)
    meta = `${usd(record.cost)} · ${record.inputTokens} токенов · ${ms(record.responseTime)} · ${record.model}`;
  if (record && !record.ok) meta = `⚠ ${record.error}`;

  return el(
    'details',
    {
      class: 'sent-details',
      open: ctx.openIds.has(vacancy.vacancyId),
      ontoggle: (event) => ctx.onToggle(vacancy.vacancyId, event.target.open),
    },
    el('summary', {}, 'Что отправлено и во сколько обошлось'),
    el('div', { class: 'sent' }, el('div', { class: 'sent-head muted' }, meta), stateList(state)),
  );
}

function answersOf(vacancy, ctx) {
  const record = ctx.run ? recordOf(ctx.run, vacancy.vacancyId) : null;
  const promptKeys = Object.keys(ctx.prompts);
  return el(
    'div',
    { class: 'answers' },
    promptKeys.map((key) => answerCell(record, key, ctx, promptKeys.length > 1)),
  );
}

function vacancyRow(vacancy, ctx) {
  const verdict = ctx.run ? vacancyVerdict(ctx.run, vacancy.vacancyId, ctx.threshold) : 'none';
  const facts = [vacancy.company, vacancy.location, vacancy.experience, vacancy.workFormat].filter(Boolean);
  return el(
    'article',
    { class: `vac vac_${verdict}` },
    el(
      'header',
      { class: 'vac-head' },
      el(
        'div',
        { class: 'vac-title-block' },
        el(
          'h3',
          { class: 'vac-title' },
          el(
            'a',
            { href: `https://hh.ru/vacancy/${vacancy.vacancyId}`, target: '_blank', rel: 'noreferrer' },
            vacancy.title,
          ),
        ),
        el(
          'div',
          { class: 'vac-facts' },
          facts.map((fact) => chip(fact)),
          vacancy.responded ? chip('уже откликались', 'chip_note') : null,
        ),
      ),
      el('span', { class: `verdict verdict_${verdict}` }, VERDICT_NAME[verdict]),
    ),
    answersOf(vacancy, ctx),
    sentDetails(vacancy, ctx),
  );
}

// ---- the list with its filters ----------------------------------------------------------------------------

const FILTERS = [
  ['all', 'Все'],
  ['accept', 'Подходят'],
  ['reject', 'Не подходят'],
  ['mixed', 'Спорные'],
  ['error', 'С ошибкой'],
];

const SORTS = [
  ['order', 'в порядке выдачи'],
  ['high', 'сначала с высокой вероятностью'],
  ['low', 'сначала с низкой вероятностью'],
];

function visibleVacancies(ctx) {
  const { run, vacancies, filter, query, sort } = ctx;
  const needle = query.trim().toLowerCase();
  let shown = vacancies.filter(
    (vacancy) => !needle || `${vacancy.title} ${vacancy.company}`.toLowerCase().includes(needle),
  );

  if (run && filter !== 'all') {
    shown = shown.filter((vacancy) =>
      filter === 'error'
        ? hasError(run, vacancy.vacancyId)
        : vacancyVerdict(run, vacancy.vacancyId, ctx.threshold) === filter,
    );
  }
  if (run && sort !== 'order') {
    const direction = sort === 'high' ? -1 : 1;
    shown = shown.toSorted(
      (a, b) => direction * (meanProbability(run, a.vacancyId) - meanProbability(run, b.vacancyId)),
    );
  }
  return shown;
}

// the filters and the sorting live apart from the rows: typing in the search box redraws only the rows, so the
// box keeps its focus
export function renderToolbar(root, ctx) {
  const { run, vacancies } = ctx;
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, 0]));
  for (const { vacancyId } of vacancies) {
    counts.all += 1;
    if (!run) continue;
    counts[vacancyVerdict(run, vacancyId, ctx.threshold)] += 1;
    if (hasError(run, vacancyId)) counts.error += 1;
  }

  root.replaceChildren(
    el(
      'div',
      { class: 'seg' },
      FILTERS.map(([id, text]) =>
        el(
          'button',
          {
            type: 'button',
            class: `seg-btn ${ctx.filter === id ? 'seg-btn_on' : ''}`,
            disabled: !run && id !== 'all',
            onclick: () => ctx.onFilter(id),
          },
          `${text} `,
          el('span', { class: 'seg-count' }, counts[id]),
        ),
      ),
    ),
    el(
      'select',
      { class: 'select', disabled: !run, onchange: (event) => ctx.onSort(event.target.value) },
      SORTS.map(([value, text]) => el('option', { value, selected: ctx.sort === value }, text)),
    ),
    el('input', {
      class: 'search',
      type: 'search',
      placeholder: 'Поиск по названию и компании',
      value: ctx.query,
      oninput: (event) => ctx.onQuery(event.target.value),
    }),
  );
}

export function renderRows(root, ctx) {
  const shown = visibleVacancies(ctx);
  const empty = el('div', { class: 'empty' }, ctx.vacancies.length ? 'Под фильтр ничего не попало' : 'Карточек нет');
  root.replaceChildren(...(shown.length ? shown.map((vacancy) => vacancyRow(vacancy, ctx)) : [empty]));
}

// ---- the figures of a run ---------------------------------------------------------------------------------

const tile = (label, value, note) =>
  el(
    'div',
    { class: 'tile' },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value),
    note ? el('div', { class: 'tile-note' }, note) : null,
  );

function histogramOf(probabilities, threshold) {
  const counts = histogram(probabilities, 10);
  const peak = Math.max(1, ...counts);
  return el(
    'div',
    { class: 'hist', vars: { '--t': `${threshold * 100}%` } },
    counts.map((count, index) =>
      el('div', {
        class: `hist-bin ${(index + 0.5) / 10 >= threshold ? 'hist-bin_ok' : 'hist-bin_no'}`,
        vars: { '--h': `${(count / peak) * 100}%` },
        title: `${index * 10}–${(index + 1) * 10}%: ${count}`,
      }),
    ),
    el('div', { class: 'hist-tick' }),
  );
}

function promptCard(summary, total, multiplePrompts, threshold) {
  const answered = summary.accepted + summary.rejected;
  return el(
    'div',
    { class: 'sum-card' },
    el('div', { class: 'sum-title' }, el('b', {}, multiplePrompts ? `Промпт ${summary.promptKey}` : 'Ответы модели')),
    el(
      'div',
      { class: 'sum-big' },
      el('span', { class: 'ok-text' }, `${summary.accepted} подходят`),
      ' · ',
      el('span', { class: 'no-text' }, `${summary.rejected} нет`),
      summary.failed ? el('span', { class: 'warn-text' }, ` · ${summary.failed} ошибок`) : null,
    ),
    el(
      'div',
      { class: 'split' },
      el('div', { class: 'split-ok', vars: { '--w': `${(summary.accepted / total) * 100}%` } }),
      el('div', { class: 'split-no', vars: { '--w': `${(summary.rejected / total) * 100}%` } }),
    ),
    answered ? histogramOf(summary.probabilities, threshold) : null,
  );
}

export function renderStats(root, ctx) {
  const { run } = ctx;
  if (!run) return root.replaceChildren();

  const cost = summarizeCost(run);
  const summaries = summarizePrompts(run, ctx.threshold);
  const multiplePrompts = summaries.length > 1;
  const total = Math.max(1, run.vacancies.length);
  const servedModel = Object.values(run.results).find((record) => record.ok)?.model;
  const startedAt = new Date(run.startedAt).toLocaleString('ru-RU');

  root.replaceChildren(
    el(
      'div',
      { class: 'run-meta muted' },
      `Прогон от ${startedAt} · ${run.tabUrl}${servedModel ? ` · ${servedModel}` : ''}`,
    ),
    el(
      'div',
      { class: 'tiles' },
      tile('Потрачено', usd(cost.cost), 'за весь прогон'),
      tile('За запрос', usd(cost.avgCost), `${Math.round(cost.avgInputTokens)} токенов в среднем`),
      tile('Запросов', cost.requests, cost.failed ? `${cost.failed} с ошибкой` : 'без ошибок'),
      tile('Ответ', ms(cost.avgResponseTime), 'в среднем'),
      tile('Вакансий', run.vacancies.length, `вид выдачи: ${run.view}`),
    ),
    el('h2', { class: 'section-title' }, 'Как делятся ответы'),
    el(
      'div',
      { class: 'sum-grid' },
      summaries.map((summary) => promptCard(summary, total, multiplePrompts, ctx.threshold)),
    ),
  );
}
