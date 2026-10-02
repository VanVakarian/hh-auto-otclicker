import { formatRubles } from '../lib/money.js';
import { isFit } from '../lib/vacancy-fit.js';
import { chip, el, ms, probabilityCell, stateList } from '../lib/page-parts.js';

// The history of the classifier's decisions, drawn like the benchmark's list of vacancies: the same cards, the same
// bar with the threshold, and the card as it went to the model under a fold. Nothing here changes anything.

const PASSED_WORDS = { yes: 'пройдено', no: 'отклонено' };

const FILTERS = [
  ['all', 'Все'],
  ['passed', 'Пройдено'],
  ['rejected', 'Отклонено'],
];

// the decision as it was made: by the threshold of the time, not today's
const isPassed = (entry) => isFit(entry.probability, entry.threshold);

function historyRow(entry, ctx) {
  const passed = isPassed(entry);
  const { state } = entry;
  const facts = [state.company, state.location, state.experience, state.work_format].filter(Boolean);
  const verdict = passed ? 'accept' : 'reject';
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
            { href: `https://hh.ru/vacancy/${entry.vacancyId}`, target: '_blank', rel: 'noreferrer' },
            state.title,
          ),
        ),
        el(
          'div',
          { class: 'vac-facts' },
          facts.map((fact) => chip(fact)),
          chip(new Date(entry.at).toLocaleString('ru-RU'), 'chip_note'),
        ),
      ),
      el('span', { class: `verdict verdict_${verdict}` }, passed ? PASSED_WORDS.yes : PASSED_WORDS.no),
    ),
    el('div', { class: 'answers' }, probabilityCell(entry.probability, entry.threshold, PASSED_WORDS)),
    el(
      'details',
      {
        class: 'sent-details',
        open: ctx.openKeys.has(entry.at),
        ontoggle: (event) => ctx.onToggle(entry.at, event.target.open),
      },
      el('summary', {}, 'Что отправлено и во сколько обошлось'),
      el(
        'div',
        { class: 'sent' },
        el('div', { class: 'sent-head muted' }, `${formatRubles(entry.cost)} · ${ms(entry.ms)}`),
        stateList(state),
      ),
    ),
  );
}

function visibleEntries({ entries, filter, query }) {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((entry) => filter === 'all' || isPassed(entry) === (filter === 'passed'))
    .filter((entry) => !needle || `${entry.state.title} ${entry.state.company ?? ''}`.toLowerCase().includes(needle))
    .toReversed(); // stored oldest first, shown newest first
}

// the filter and the search live apart from the rows: typing in the search box redraws only the rows, so the box
// keeps its focus
export function renderToolbar(root, ctx) {
  const counts = { all: ctx.entries.length, passed: 0, rejected: 0 };
  for (const entry of ctx.entries) counts[isPassed(entry) ? 'passed' : 'rejected'] += 1;

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
            onclick: () => ctx.onFilter(id),
          },
          `${text} `,
          el('span', { class: 'seg-count' }, counts[id]),
        ),
      ),
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
  const shown = visibleEntries(ctx);
  const emptyText = ctx.entries.length
    ? 'Под фильтр ничего не попало'
    : 'Решений пока нет: они появятся, когда бот начнёт отбор';
  const empty = el('div', { class: 'empty' }, emptyText);
  root.replaceChildren(...(shown.length ? shown.map((entry) => historyRow(entry, ctx)) : [empty]));
}
