import { KEYS, getSettings } from '../lib/storage.js';
import { clearRejectedArchive, getRejectedArchive, getUploadStatus } from '../lib/upload-store.js';
import { reportError, stackOf } from '../lib/diagnostics.js';
import { formatMoment } from './format.js';

// The panel's side of sending diagnostics to the server (the worker side is lib/uploader.js): the status
// line under the key, the "send now" button, the archive of what the server refused, and the indicator in
// the masthead. Everything shown is read from storage; the worker is only asked to send.

const PROBLEM_TEXTS = {
  unauthorized: 'Сервер не принял ключ: проверьте его (или на сервере не настроены ключи).',
  bad_key: 'Ключ выглядит неверно: нужны 24–128 латинских букв и цифр.',
  not_configured: 'Сервер не знает этот источник: бэк не выкачен или источник убран из его настроек.',
  bad_request: 'Сервер счёл запрос неверным. Это ошибка расширения, подробности в диагностике.',
  retry: 'Сервер не подтвердил доставку (нет сети или он недоступен). Повторим сами.',
  internal: 'Ошибка расширения при отправке, подробности в диагностике.',
};

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

// what the line under the key says, and what the masthead shows; `indicator` is null while sending is off
export function describeUpload({ keySet, status }) {
  if (!keySet) {
    return { text: 'Отправка выключена: ключ не введён.', kind: null, indicator: null };
  }
  if (status.lastAttemptAt === null) {
    return {
      text: 'Ключ задан, первая отправка скоро.',
      kind: null,
      indicator: { label: '● диагностика', kind: null, title: 'Диагностика отправляется на сервер' },
    };
  }

  const facts = [
    status.lastOkAt ? `Последняя успешная отправка: ${formatMoment(status.lastOkAt)}.` : 'Успешных отправок ещё не было.',
    `Ожидает отправки: ${status.pending}.`,
  ];
  if (status.volume) facts.push(`Сегодня отправлено: ${formatMegabytes(status.volume.bytes)}.`);
  if (status.notConfigured.includes('pictures')) {
    facts.push('Картинки капч не отправляются: на сервере для них нет источника.');
  }

  if (status.error) {
    const problem = PROBLEM_TEXTS[status.error.kind] ?? `Ошибка: ${status.error.kind}.`;
    return {
      text: [problem, ...facts].join(' '),
      kind: 'error',
      indicator: { label: '● не отправляется', kind: 'error', title: problem },
    };
  }
  return {
    text: ['Отправляется.', ...facts].join(' '),
    kind: 'success',
    indicator: { label: '● диагностика', kind: 'ok', title: facts.join(' ') },
  };
}

const els = {};

async function render() {
  const [settings, status, archive] = await Promise.all([getSettings(), getUploadStatus(), getRejectedArchive()]);
  const { text, kind, indicator } = describeUpload({ keySet: Boolean(settings.uploadKey.trim()), status });

  els.status.textContent = text;
  els.status.className = `data-transfer-status${kind ? ` data-transfer-status_${kind}` : ''}`;
  els.status.hidden = false;

  els.indicator.hidden = !indicator;
  if (indicator) {
    els.indicator.textContent = indicator.label;
    els.indicator.title = indicator.title;
    els.indicator.className = `upload-indicator${indicator.kind ? ` upload-indicator_${indicator.kind}` : ''}`;
  }

  const lost = archive.lost > 0 ? ` (ещё ${archive.lost} вытеснено)` : '';
  els.archiveCount.textContent = `${archive.entries.length}${lost}`;
  els.clearArchive.disabled = archive.entries.length === 0 && archive.lost === 0;
}

async function handleUploadNow() {
  els.uploadNow.disabled = true;
  els.status.textContent = 'Отправляем…';
  try {
    await chrome.runtime.sendMessage({ type: 'HHAA_UPLOAD_NOW' });
  } catch (error) {
    await reportError('settings', `upload now failed: ${error.message}`, stackOf(error));
  } finally {
    els.uploadNow.disabled = false;
    await render();
  }
}

async function handleClearArchive() {
  const confirmed = window.confirm(
    'Очистить архив? В нём события, которые сервер не принял; после очистки их не восстановить.',
  );
  if (!confirmed) return;
  await clearRejectedArchive();
  await render();
}

const WATCHED_KEYS = new Set([KEYS.UPLOAD_STATUS, KEYS.REJECTED_ARCHIVE, KEYS.SETTINGS]);

export function initUploadView() {
  els.status = document.getElementById('uploadStatus');
  els.indicator = document.getElementById('uploadIndicator');
  els.uploadNow = document.getElementById('uploadNowBtn');
  els.archiveCount = document.getElementById('rejectedArchiveCount');
  els.clearArchive = document.getElementById('clearRejectedBtn');

  els.uploadNow.addEventListener('click', handleUploadNow);
  els.clearArchive.addEventListener('click', handleClearArchive);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.keys(changes).some((key) => WATCHED_KEYS.has(key))) render();
  });

  return render();
}
