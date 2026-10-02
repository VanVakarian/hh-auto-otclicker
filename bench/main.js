import { getSettings, saveSettings } from '../lib/storage.js';
import { installUncaughtErrorCapture } from '../lib/diagnostics.js';
import { JEV_MODEL } from '../lib/jev.js';
import { buildFitQuestions, buildVacancyState, judgeVacancy } from '../lib/vacancy-fit.js';
import { findListTab, readCards, viewOf } from './source.js';
import { loadBench, saveBench } from './store.js';
import { judgeWithRetries, runWithConcurrency } from './runner.js';
import { buildExport } from './export.js';
import { el, renderRows, renderStats, renderToolbar } from './view.js';

installUncaughtErrorCapture('bench');

const CONCURRENCY = 5;
const SAVE_EVERY_ANSWERS = 10;
const MAX_PROMPTS = 5;
const PROMPT_KEYS = ['A', 'B', 'C', 'D', 'E'];

const $ = (id) => document.getElementById(id);
const preferredTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

let doc; // what is stored: prompts, threshold, the last run (see store.js)
let source = { tab: null, cards: [], view: null, error: null }; // the hh.ru tab the cards are read from
let running = null; // { abort, done, total } while a run goes
const ui = { filter: 'all', sort: 'order', query: '', openIds: new Set() };

// ---- saving ------------------------------------------------------------------------------------------------

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveBench(doc), 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  return saveBench(doc);
}

// ---- what a run is made of ---------------------------------------------------------------------------------

const currentPrompts = () =>
  Object.fromEntries(doc.prompts.filter(({ text }) => text.trim()).map(({ key, text }) => [key, text.trim()]));

function context() {
  const { run } = doc;
  return {
    run,
    vacancies: run ? run.vacancies : source.cards,
    prompts: run ? run.prompts : currentPrompts(),
    threshold: doc.threshold,
    ...ui,
    onToggle: (vacancyId, open) => (open ? ui.openIds.add(vacancyId) : ui.openIds.delete(vacancyId)),
    onFilter(filter) {
      ui.filter = filter;
      renderResults();
    },
    onSort(sort) {
      ui.sort = sort;
      renderResults();
    },
    onQuery(query) {
      ui.query = query;
      renderRows($('rows'), context());
    },
  };
}

// ---- drawing -----------------------------------------------------------------------------------------------

let frame = null;
function renderResults() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const ctx = context();
    renderStats($('stats'), ctx);
    renderToolbar($('toolbar'), ctx);
    renderRows($('rows'), ctx);
  });
}

function setNotice(text, kind = 'info') {
  const notice = $('notice');
  notice.hidden = !text;
  notice.textContent = text ?? '';
  notice.className = `notice notice_${kind}`;
}

function renderSource() {
  const { tab, cards, view, error } = source;
  const children = [];
  if (tab) {
    children.push(
      el('span', { class: 'source-title', title: tab.url }, `🔎 ${tab.title}`.slice(0, 70)),
      el('span', { class: 'chip' }, `${cards.length} карточек`),
    );
    if (view) {
      children.push(
        el(
          'span',
          { class: `chip ${view === 'expanded' ? 'chip_ok' : 'chip_warn'}` },
          view === 'expanded' ? 'expanded: сниппеты есть' : 'compact: сниппетов нет, уйдёт краткая карточка',
        ),
      );
    }
    children.push(
      el('button', { type: 'button', class: 'btn btn_ghost btn_small', onclick: showTab }, 'Показать вкладку'),
    );
  } else {
    children.push(el('span', { class: 'chip chip_warn' }, 'вкладка с поиском не найдена'));
  }
  children.push(el('button', { type: 'button', class: 'btn btn_small', onclick: reloadSource }, 'Перечитать'));
  $('source').replaceChildren(...children);

  if (error) setNotice(error, 'warn');
  else if (!running) setNotice(null);
}

function renderPrompts() {
  $('prompts').replaceChildren(
    ...doc.prompts.map((prompt) =>
      el(
        'div',
        { class: 'prompt' },
        el(
          'div',
          { class: 'prompt-head' },
          el('span', { class: 'prompt-key' }, `Промпт ${prompt.key}`),
          doc.prompts.length > 1
            ? el(
                'button',
                { type: 'button', class: 'btn btn_ghost btn_small', onclick: () => removePrompt(prompt.key) },
                'Убрать',
              )
            : null,
        ),
        el(
          'textarea',
          {
            class: 'textarea',
            rows: 3,
            placeholder: 'Кем вы хотите быть, что подходит и что нет',
            oninput: (event) => {
              prompt.text = event.target.value;
              saveSoon();
              renderControls();
            },
          },
          prompt.text,
        ),
      ),
    ),
  );
  $('addPromptBtn').hidden = doc.prompts.length >= MAX_PROMPTS;
}

// the exact body of a request, shown before anything is sent — the first card as it is, and the questions
function renderRequestPreview() {
  const [card] = source.cards;
  const request = {
    model: JEV_MODEL,
    state: card ? buildVacancyState(card) : '(нет карточек)',
    questions: buildFitQuestions(currentPrompts()),
  };
  $('requestPreview').textContent = JSON.stringify(request, null, 2);
}

function renderControls() {
  const requests = source.cards.length;
  const prompts = Object.keys(currentPrompts()).length;

  $('runBtn').disabled = Boolean(running) || requests === 0 || prompts === 0;
  $('runNote').textContent = requests
    ? `${requests} вакансий = ${requests} запросов, в каждом ${prompts} вопр.`
    : 'Нечего отправлять';
  $('stopBtn').hidden = !running;
  $('runBtn').hidden = Boolean(running);
  $('clearBtn').disabled = Boolean(running) || !doc.run;
  $('exportBtn').disabled = Boolean(running) || !doc.run;
  $('copyBtn').disabled = Boolean(running) || !doc.run;
  renderRequestPreview();
}

function renderThreshold() {
  $('threshold').value = Math.round(doc.threshold * 100);
  $('thresholdOut').textContent = `${Math.round(doc.threshold * 100)}%`;
}

function renderProgress() {
  $('progress').hidden = !running;
  if (running) $('progressFill').style.width = `${(running.done / running.total) * 100}%`;
}

// ---- actions -----------------------------------------------------------------------------------------------

async function reloadSource() {
  source = await loadSource();
  renderSource();
  renderControls();
  renderResults();
}

async function loadSource() {
  try {
    const tab = await findListTab(preferredTabId);
    if (!tab) {
      const error = 'Нет открытой вкладки с поиском на hh.ru. Откройте закреплённый поиск и нажмите «Перечитать».';
      return { tab: null, cards: [], view: null, error };
    }
    const cards = await readCards(tab.id);
    const error = cards.length
      ? null
      : 'На странице нет карточек вакансий. Дождитесь загрузки выдачи и нажмите «Перечитать».';
    return { tab, cards, view: cards.length ? viewOf(cards) : null, error };
  } catch (error) {
    return { tab: null, cards: [], view: null, error: `Не удалось прочитать вкладку: ${error.message}` };
  }
}

async function showTab() {
  await chrome.tabs.update(source.tab.id, { active: true });
  await chrome.windows.update(source.tab.windowId, { focused: true });
}

function removePrompt(key) {
  doc.prompts = doc.prompts.filter((prompt) => prompt.key !== key);
  saveSoon();
  renderPrompts();
  renderControls();
}

function addPrompt() {
  const key = PROMPT_KEYS.find((candidate) => !doc.prompts.some((prompt) => prompt.key === candidate));
  doc.prompts.push({ key, text: '' });
  saveSoon();
  renderPrompts();
  renderControls();
}

// what an answer leaves in the stored run: the request's state (what was sent) and what it cost
function recordFrom(result) {
  const state = result.request?.state;
  if (!result.success) return { ok: false, kind: result.kind, error: result.error, state };
  return { ok: true, probabilities: result.probabilities, state, ...result.metadata };
}

async function startRun() {
  const { apiKey } = await getSettings();
  if (!apiKey?.trim()) return setNotice('Нет API-ключа OpenRouter — введите его в настройках расширения.', 'error');

  const run = {
    startedAt: Date.now(),
    finishedAt: null,
    tabUrl: source.tab.url,
    view: source.view,
    prompts: currentPrompts(),
    vacancies: source.cards,
    results: {},
  };
  doc.run = run;
  running = { abort: new AbortController(), done: 0, total: run.vacancies.length };
  setNotice(null);
  renderControls();
  renderProgress();
  renderResults();

  let failure = null;
  await runWithConcurrency(
    run.vacancies,
    async (card) => {
      const result = await judgeWithRetries(judgeVacancy, { apiKey, vacancy: card, prompts: run.prompts });
      run.results[card.vacancyId] = recordFrom(result);
      if (!result.success && result.kind === 'unavailable') {
        failure = result.error;
        running.abort.abort();
      }
      running.done += 1;
      renderProgress();
      renderResults();
      if (running.done % SAVE_EVERY_ANSWERS === 0) saveSoon();
    },
    { concurrency: CONCURRENCY, signal: running.abort.signal },
  );

  const stopped = running.abort.signal.aborted;
  const { total } = running;
  run.finishedAt = Date.now();
  running = null;
  await saveNow();
  renderProgress();
  renderControls();
  renderResults();

  if (failure) setNotice(`Прогон прерван: ${failure}`, 'error');
  else if (stopped) setNotice('Остановлено — показано то, что успело прийти.', 'warn');
  else setNotice(`Готово: ${total} запросов.`, 'ok');
}

// The working values are the extension's settings: the prompt A and the threshold of this page become them, or
// the other way round. Nothing here moves them on its own.
function promptA() {
  return doc.prompts.find((prompt) => prompt.key === 'A') ?? doc.prompts[0];
}

async function makeWorking() {
  const text = promptA()?.text.trim();
  if (!text) return setNotice('Промпт A пуст — рабочим его не сделать.', 'error');
  await saveSettings({ fitPrompt: text, fitThreshold: doc.threshold });
  setNotice('Промпт A и порог стали рабочими.', 'ok');
}

async function takeWorking() {
  const { fitPrompt, fitThreshold } = await getSettings();
  doc.prompts = [{ key: 'A', text: fitPrompt }, ...doc.prompts.filter((prompt) => prompt.key !== 'A')];
  doc.threshold = fitThreshold;
  saveSoon();
  renderPrompts();
  renderThreshold();
  renderControls();
  renderResults();
  setNotice('Взяты рабочие промпт и порог.', 'ok');
}

async function clearRun() {
  doc.run = null;
  await saveNow();
  setNotice(null);
  renderControls();
  renderResults();
}

// ---- export ------------------------------------------------------------------------------------------------

const exportText = () => buildExport(doc.run, doc.threshold);

function downloadExport() {
  const stamp = new Date(doc.run.startedAt).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/markdown;charset=utf-8' }));
  el('a', { href: url, download: `fit-bench-${stamp}.md` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyExport() {
  await navigator.clipboard.writeText(exportText());
  setNotice('Экспорт скопирован в буфер обмена.', 'ok');
}

// ---- start -------------------------------------------------------------------------------------------------

function bindControls() {
  $('addPromptBtn').addEventListener('click', addPrompt);
  $('makeWorkingBtn').addEventListener('click', makeWorking);
  $('takeWorkingBtn').addEventListener('click', takeWorking);
  $('runBtn').addEventListener('click', startRun);
  $('stopBtn').addEventListener('click', () => running?.abort.abort());
  $('clearBtn').addEventListener('click', clearRun);
  $('exportBtn').addEventListener('click', downloadExport);
  $('copyBtn').addEventListener('click', copyExport);

  $('threshold').addEventListener('input', (event) => {
    doc.threshold = Number(event.target.value) / 100;
    saveSoon();
    renderThreshold();
    renderResults();
  });
}

doc = await loadBench();
bindControls();
renderPrompts();
renderThreshold();
await reloadSource();
