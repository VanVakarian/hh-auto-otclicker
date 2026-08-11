import { initRunView, renderRunView } from './run-view.js';
import { initAnalyticsView, renderAnalyticsView } from './analytics-view.js';
import { initSettingsView } from './settings-view.js';

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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.hhaa_runState || changes.hhaa_responseLog || changes.hhaa_diagnosticLog) {
    renderRunView();
  }
});

initTabs();
initRunView();
initAnalyticsView();
initSettingsView();
