// What the sidepanel needs to know about the tab the user is looking at: which it is, and when that changes.

const listeners = new Set();
let notifyTimer = null;

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

// a tab switch, a navigation and a window focus change arrive as bursts of events — one call per burst
function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => listeners.forEach((listener) => listener()), 150);
}

chrome.tabs.onActivated.addListener(notify);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status)) notify();
});
chrome.windows.onFocusChanged.addListener(notify);

// called when the active tab is another one, or the active tab went to another page
export function onActiveTabChange(listener) {
  listeners.add(listener);
}
