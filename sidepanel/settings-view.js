import {
  getSettings,
  saveSettings,
  getQuestionnaireBlacklist,
  clearQuestionnaireBlacklist,
  exportFullState,
  importFullState,
} from '../lib/storage.js';

const FIELD_MAP = [
  { id: 'llmEnabled', key: 'llmEnabled', kind: 'checkbox' },
  { id: 'apiKey', key: 'apiKey', kind: 'text' },
  { id: 'llmModels', key: 'llmModelsRaw', kind: 'text' },
  { id: 'legend', key: 'legend', kind: 'text' },
  { id: 'stylePrompt', key: 'stylePrompt', kind: 'text' },
  { id: 'dailyLimit', key: 'dailyLimit', kind: 'number' },
  { id: 'delayMinSec', key: 'delayMinSec', kind: 'number' },
  { id: 'delayMaxSec', key: 'delayMaxSec', kind: 'number' },
  { id: 'coverLetterEnabled', key: 'coverLetterEnabled', kind: 'checkbox' },
  { id: 'coverLetterText', key: 'coverLetterText', kind: 'text' },
  { id: 'blacklistCompanies', key: 'blacklistCompaniesRaw', kind: 'text' },
  { id: 'skipStopWords', key: 'skipStopWordsRaw', kind: 'text' },
  { id: 'vacancyTitleStopWords', key: 'vacancyTitleStopWordsRaw', kind: 'text' },
  { id: 'chatQuickMessages', key: 'chatQuickMessagesRaw', kind: 'text' },
  { id: 'chatSuggestedReplies', key: 'chatSuggestedRepliesRaw', kind: 'text' },
  { id: 'chatLlmPrompt', key: 'chatLlmPromptRaw', kind: 'text' },
];

async function renderBlacklistCount() {
  const list = await getQuestionnaireBlacklist();
  document.getElementById('questionnaireBlacklistCount').textContent = String(list.length);
}

// a file this large can't be a real export (chrome.storage.local's own quota is far smaller) —
// reject it before even trying to read/parse it
const MAX_IMPORT_FILE_SIZE_BYTES = 20 * 1024 * 1024;

function setDataTransferStatus(el, message, kind) {
  el.textContent = message;
  el.hidden = !message;
  el.className = `data-transfer-status${kind ? ` data-transfer-status_${kind}` : ''}`;
}

async function handleExportAll(button, statusEl) {
  const originalText = button.textContent;
  button.disabled = true;

  try {
    const payload = await exportFullState();
    const json = JSON.stringify(payload, null, 2);

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hhaa-full-export-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setDataTransferStatus(
      statusEl,
      `Экспортировано разделов: ${Object.keys(payload.data).length}.`,
      'success',
    );
    button.textContent = 'Экспортировано ✓';
  } catch (error) {
    console.error(`⚙️ [settings] export failed: ${error.message}`);
    setDataTransferStatus(statusEl, `Ошибка экспорта: ${error.message}`, 'error');
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1500);
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('не удалось прочитать файл'));
    reader.readAsText(file);
  });
}

async function handleImportFile(file, statusEl) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.json')) {
    setDataTransferStatus(statusEl, 'Нужен файл экспорта в формате .json.', 'error');
    return;
  }
  if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
    setDataTransferStatus(statusEl, 'Файл слишком большой — это точно экспорт из этого расширения?', 'error');
    return;
  }

  let text;
  try {
    text = await readFileAsText(file);
  } catch (error) {
    setDataTransferStatus(statusEl, `Не удалось прочитать файл: ${error.message}`, 'error');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    setDataTransferStatus(statusEl, 'Файл повреждён: это не валидный JSON.', 'error');
    return;
  }

  const confirmed = window.confirm(
    'Импорт полностью заменит текущие настройки, чёрный список и всю историю данными из файла. ' +
      'Отменить это действие будет нельзя. Продолжить?',
  );
  if (!confirmed) {
    setDataTransferStatus(statusEl, 'Импорт отменён.', null);
    return;
  }

  try {
    const importedKeys = await importFullState(payload);
    setDataTransferStatus(
      statusEl,
      `Импортировано разделов: ${importedKeys.length}. Перезагружаем панель…`,
      'success',
    );
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    console.error(`⚙️ [settings] import failed: ${error.message}`);
    setDataTransferStatus(statusEl, `Ошибка импорта: ${error.message}`, 'error');
  }
}

function setupDataTransfer() {
  const exportBtn = document.getElementById('exportAllBtn');
  const importBtn = document.getElementById('importAllBtn');
  const importFileInput = document.getElementById('importAllFileInput');
  const statusEl = document.getElementById('dataTransferStatus');

  exportBtn.addEventListener('click', () => handleExportAll(exportBtn, statusEl));
  importBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files?.[0];
    await handleImportFile(file, statusEl);
    importFileInput.value = ''; // clears the selection so picking the same file again still fires "change"
  });
}

export async function initSettingsView() {
  const settings = await getSettings();

  FIELD_MAP.forEach(({ id, key, kind }) => {
    const el = document.getElementById(id);
    if (kind === 'checkbox') {
      el.checked = Boolean(settings[key]);
    } else {
      el.value = settings[key] ?? '';
    }

    const eventName = kind === 'checkbox' ? 'change' : 'input';
    el.addEventListener(eventName, () => {
      const value = kind === 'checkbox' ? el.checked : kind === 'number' ? Number(el.value) : el.value;
      saveSettings({ [key]: value });
    });
  });

  const llmEnabledEl = document.getElementById('llmEnabled');
  const apiKeyEl = document.getElementById('apiKey');
  const syncLlmEnabledAvailability = () => {
    llmEnabledEl.disabled = !apiKeyEl.value.trim();
  };
  apiKeyEl.addEventListener('input', syncLlmEnabledAvailability);
  syncLlmEnabledAvailability();

  document.getElementById('resetBlacklistBtn').addEventListener('click', async () => {
    await clearQuestionnaireBlacklist();
    await renderBlacklistCount();
  });

  setupDataTransfer();

  await renderBlacklistCount();
}
