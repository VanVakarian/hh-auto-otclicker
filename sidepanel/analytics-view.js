import { getResponseLog, getAnswersLog, isSuccessResult } from '../lib/storage.js';
import { resultMeta, formatTime, formatDateShort, dayKey } from './format.js';

let els = {};

function computeStats(log) {
  const today = dayKey(Date.now());
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const stats = {
    today: 0,
    week: 0,
    allTime: 0,
    instant: 0,
    popup: 0,
    questionnaire: 0,
    skippedCompany: 0,
    skippedQuestionnaire: 0,
    errors: 0,
  };

  log.forEach((entry) => {
    if (isSuccessResult(entry.result)) {
      stats.allTime += 1;
      if (dayKey(entry.at) === today) stats.today += 1;
      if (entry.at >= weekAgo) stats.week += 1;
      if (entry.result === 'success_instant') stats.instant += 1;
      if (entry.result === 'success_popup') stats.popup += 1;
      if (entry.result === 'success_questionnaire') stats.questionnaire += 1;
    } else if (entry.result === 'skipped_company' || entry.result === 'skipped_title_stop_word') {
      stats.skippedCompany += 1;
    } else if (
      entry.result === 'skipped_questionnaire_no_llm' ||
      entry.result === 'skipped_questionnaire_llm_failed' ||
      entry.result === 'skipped_popup' ||
      entry.result === 'skipped_assisted' ||
      entry.result === 'skipped_stop_word' ||
      entry.result === 'skipped_manual'
    ) {
      stats.skippedQuestionnaire += 1;
    } else if (entry.result === 'error') {
      stats.errors += 1;
    }
  });

  return stats;
}

function buildLast7Days(log) {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const ts = Date.now() - i * 24 * 60 * 60 * 1000;
    days.push({ key: dayKey(ts), label: formatDateShort(ts), count: 0 });
  }
  const byKey = new Map(days.map((d) => [d.key, d]));

  log.forEach((entry) => {
    if (!isSuccessResult(entry.result)) return;
    const day = byKey.get(dayKey(entry.at));
    if (day) day.count += 1;
  });

  return days;
}

function renderStats(stats) {
  const tiles = [
    { value: stats.today, label: 'Сегодня' },
    { value: stats.week, label: 'За неделю' },
    { value: stats.allTime, label: 'Всего' },
    { value: stats.instant, label: 'Мгновенных' },
    { value: stats.popup, label: 'Через попап' },
    { value: stats.questionnaire, label: 'Анкет пройдено' },
    { value: stats.skippedQuestionnaire, label: 'Пропущено' },
    { value: stats.errors, label: 'Ошибок' },
  ];

  els.statsGrid.innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="value">${t.value}</div><div class="label">${t.label}</div></div>`)
    .join('');
}

function renderChart(days) {
  const max = Math.max(1, ...days.map((d) => d.count));

  els.barChart.innerHTML = days
    .map((d) => {
      const heightPct = Math.round((d.count / max) * 100);
      return `
        <div class="bar-col">
          <span class="bar-value">${d.count || ''}</span>
          <div class="bar" style="height:${Math.max(heightPct, d.count ? 4 : 0)}%"></div>
          <span class="bar-label">${d.label}</span>
        </div>
      `;
    })
    .join('');
}

function renderTable(log) {
  const rows = [...log].sort((a, b) => b.at - a.at).slice(0, 20);

  if (rows.length === 0) {
    els.logTable.querySelector('tbody').innerHTML = '';
    els.logTable.hidden = true;
    els.emptyState.hidden = false;
    return;
  }

  els.logTable.hidden = false;
  els.emptyState.hidden = true;

  els.logTable.querySelector('tbody').innerHTML = rows
    .map((entry) => {
      const meta = resultMeta(entry.result);
      return `
        <tr>
          <td class="log-time">${formatTime(entry.at)}</td>
          <td>
            <div class="log-title">${entry.title || '—'}</div>
            <div class="log-company">${entry.company || ''}</div>
          </td>
          <td>${meta.icon} ${meta.label}</td>
        </tr>
      `;
    })
    .join('');
}

// grouped by company (case-insensitive) so the downloaded file reads top-to-bottom the way someone
// scanning for "did I already talk to this company" would want, instead of chronological order
async function handleDownloadAnswers() {
  const answersLog = await getAnswersLog();
  const sorted = [...answersLog].sort((a, b) =>
    (a.company || '').localeCompare(b.company || '', 'ru', { sensitivity: 'base' }),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    totalQuestionnaires: sorted.length,
    questionnaires: sorted,
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hhaa-answers-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  els.downloadAnswersBtn.textContent = 'Скачано ✓';
  setTimeout(() => {
    els.downloadAnswersBtn.textContent = 'Скачать анкеты';
  }, 1500);
}

async function render() {
  const [log, answersLog] = await Promise.all([getResponseLog(), getAnswersLog()]);
  renderStats(computeStats(log));
  renderChart(buildLast7Days(log));
  renderTable(log);
  els.answersLogCount.textContent = answersLog.length;
}

export function initAnalyticsView() {
  els = {
    statsGrid: document.getElementById('statsGrid'),
    barChart: document.getElementById('barChart'),
    logTable: document.getElementById('logTable'),
    answersLogCount: document.getElementById('answersLogCount'),
    downloadAnswersBtn: document.getElementById('downloadAnswersBtn'),
  };

  els.emptyState = document.createElement('div');
  els.emptyState.className = 'empty-state';
  els.emptyState.textContent = 'Пока нет откликов — запустите прогон на вкладке «Запуск».';
  els.logTable.after(els.emptyState);
  els.emptyState.hidden = true;

  els.downloadAnswersBtn.addEventListener('click', handleDownloadAnswers);

  render();
}

export { render as renderAnalyticsView };
