import { getSettings, saveSettings, getQuestionnaireBlacklist, clearQuestionnaireBlacklist } from '../lib/storage.js';

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
];

async function renderBlacklistCount() {
  const list = await getQuestionnaireBlacklist();
  document.getElementById('questionnaireBlacklistCount').textContent = String(list.length);
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

  await renderBlacklistCount();
}
