import { saveRunState, StopReason } from './storage.js';
import { reportWarning } from './diagnostics.js';
import { click } from './interaction.js';
import { ifStillRunning, sleepUnlessStopped } from './run-control.js';
import { reactionDelayMs } from './pacing.js';
import { captchaWatcher } from './captcha-watcher.js';
import { startPageRecorder } from './page-recorder.js';
import { isContextInvalidated, onContextInvalidated } from './extension-context.js';

const CHAT_WIDGET_CLOSE_SELECTOR = '[data-qa="chatik-close-chatik"]';
const RESPONSE_ERROR_NOTIFICATION_SELECTOR = '[data-qa="vacancy-response-error-notification"]';
const MODAL_OVERLAY_SELECTOR = '[data-qa="modal-overlay"]';
const DAILY_LIMIT_TEXT_HINT = 'не более 200 откликов';

// Every watcher is a check function the shared observer calls on each DOM change; a check is cheap
// when there's nothing to react to, and guards itself against overlapping with its own previous run.

// hh.ru's global chat widget can pop open on its own (e.g. an employer's auto-message that
// only accepts a button reply) while the bot is running — nothing here needs to read it, so
// it's simplest to just close it on sight rather than support answering it.
function chatWidgetWatcher() {
  let closing = false;
  return async () => {
    if (closing) return;
    const closeButton = document.querySelector(CHAT_WIDGET_CLOSE_SELECTOR);
    if (!closeButton) return;

    closing = true;
    try {
      await ifStillRunning(async () => {
        // an auto-message popping up is dismissed after a beat, not in the instant it appears
        if (await sleepUnlessStopped(reactionDelayMs())) await click(closeButton);
      });
    } finally {
      closing = false;
    }
  };
}

function includesLimitHint(element) {
  // hh.ru mixes non-breaking spaces into its texts — collapse every kind before matching
  return Boolean(element?.textContent?.replace(/\s+/g, ' ').includes(DAILY_LIMIT_TEXT_HINT));
}

// hh.ru enforces its own 200-responses/24h cap server-side and refuses the response instead of
// letting it through — nothing left to try, so stop the run rather than keep clicking into a wall
// (and burning through delay/retry cycles for nothing). The refusal comes in two shapes: a snackbar,
// or a message inside the response popup itself that then stays open — the second one went unnoticed
// and the bot kept working through vacancies, logging each as an error.
function dailyLimitWatcher(module) {
  let triggered = false;
  return async () => {
    if (triggered) return;
    const notification = document.querySelector(RESPONSE_ERROR_NOTIFICATION_SELECTOR);
    const popups = Array.from(document.querySelectorAll(MODAL_OVERLAY_SELECTOR));
    if (!includesLimitHint(notification) && !popups.some(includesLimitHint)) return;

    await ifStillRunning(async () => {
      triggered = true;
      await reportWarning(module, 'hh.ru daily response limit (200/24h) reached, run stopped automatically');
      await saveRunState({ status: 'stopped', stopReason: StopReason.HH_DAILY_LIMIT });
    });
  };
}

// module — the diagnostic-log module name of the entry the watchers run for
export function startPageWatchers(module) {
  startPageRecorder();

  const checks = [chatWidgetWatcher(), dailyLimitWatcher(module), captchaWatcher(module)];
  const observer = new MutationObserver(() => {
    if (!isContextInvalidated()) checks.forEach((check) => check());
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onContextInvalidated(() => observer.disconnect());
}
