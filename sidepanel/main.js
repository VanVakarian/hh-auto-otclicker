import { initRunView, renderRunView } from './run-view.js';
import { initAnalyticsView, renderAnalyticsView } from './analytics-view.js';
import { initSettingsView } from './settings-view.js';
import { initUploadView } from './upload-view.js';
import { initSearchesView } from './searches-view.js';
import { initBenchLink } from './bench-link.js';
import { installUncaughtErrorCapture } from '../lib/diagnostics.js';

installUncaughtErrorCapture('sidepanel');

function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));

      if (btn.dataset.tab === 'analytics') renderAnalyticsView();
    });
  });
}

// the logs are stored one key per hour (see journal.js). The diagnostic log's 'info' entries (the bulk of
// it) never show in the feed — a change to it only matters when its newest entry is a warning or an error
function isFeedRelevantChange(key, change) {
  if (key.startsWith('hhaa_diagnosticLog:')) return change.newValue?.at(-1)?.level !== 'info';
  if (key.startsWith('hhaa_responseLog:')) return true;
  return key === 'hhaa_runState' || key === 'hhaa_runPause';
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (Object.entries(changes).some(([key, change]) => isFeedRelevantChange(key, change))) renderRunView();
});

initTabs();
initRunView();
initSearchesView();
initAnalyticsView();
initSettingsView();
initUploadView();
initBenchLink();
