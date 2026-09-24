import { getRunState, saveRunState, addDiagnosticLogEntry } from './storage.js';
import { click } from './interaction.js';
import {
  isContextInvalidated,
  isContextInvalidatedError,
  haltOnContextInvalidated,
  onContextInvalidated,
} from './extension-context.js';

const CHAT_WIDGET_CLOSE_SELECTOR = '[data-qa="chatik-close-chatik"]';
const RESPONSE_ERROR_NOTIFICATION_SELECTOR = '[data-qa="vacancy-response-error-notification"]';
const DAILY_LIMIT_TEXT_HINT = 'не более 200 откликов';

async function ifStillRunning(action) {
  try {
    const runState = await getRunState();
    if (runState.status !== 'running') return;
    await action();
  } catch (error) {
    if (isContextInvalidatedError(error)) haltOnContextInvalidated();
    else throw error;
  }
}

// hh.ru's global chat widget can pop open on its own (e.g. an employer's auto-message that
// only accepts a button reply) while the bot is running — nothing here needs to read it, so
// it's simplest to just close it on sight rather than support answering it.
function watchForChatWidget() {
  let closing = false;
  const observer = new MutationObserver(async () => {
    if (isContextInvalidated() || closing) return;
    const closeButton = document.querySelector(CHAT_WIDGET_CLOSE_SELECTOR);
    if (!closeButton) return;

    closing = true;
    try {
      await ifStillRunning(() => click(closeButton));
    } finally {
      closing = false;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

// hh.ru enforces its own 200-responses/24h cap server-side and shows this snackbar instead of
// letting the response through — nothing left to try, so stop the run rather than keep clicking
// into a wall (and burning through delay/retry cycles for nothing)
function watchForDailyLimitNotification({ module, logPrefix }) {
  let triggered = false;
  const observer = new MutationObserver(async () => {
    if (isContextInvalidated() || triggered) return;
    const notification = document.querySelector(RESPONSE_ERROR_NOTIFICATION_SELECTOR);
    if (!notification?.textContent?.includes(DAILY_LIMIT_TEXT_HINT)) return;

    await ifStillRunning(async () => {
      triggered = true;
      console.warn(`${logPrefix} hh.ru daily response limit reached, stopping run`);
      await addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module,
        message: 'hh.ru daily response limit (200/24h) reached, run stopped automatically',
      });
      await saveRunState({ status: 'stopped' });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

// module — diagnostic-log module name, logPrefix — the emoji/tag prefix of that module's console output
export function startPageWatchers({ module, logPrefix }) {
  const observers = [watchForChatWidget(), watchForDailyLimitNotification({ module, logPrefix })];
  onContextInvalidated(() => observers.forEach((observer) => observer.disconnect()));
}
