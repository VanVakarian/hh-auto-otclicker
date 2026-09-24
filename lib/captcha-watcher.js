import { PauseReason, getSettings, addDiagnosticLogEntry } from './storage.js';
import { isVisible, sleep } from './dom.js';
import { randomDelayMs } from './pacing.js';
import { holdRun, releaseRun, ifStillRunning } from './run-control.js';
import { recentActivity } from './page-recorder.js';
import { reportWarning } from './diagnostics.js';
import { isContextInvalidated } from './extension-context.js';

// hh.ru's "Пройдите капчу" dialog (an ordinary modal-overlay, same as the response popup — its picture
// and input are the only parts that identify it)
const PICTURE_SELECTOR = '[data-qa="account-captcha-picture"]';
const INPUT_SELECTOR = '[data-qa="account-captcha-input"]';
const ERROR_SELECTOR = '[data-qa="account-captcha-error"]';
const MODAL_OVERLAY_SELECTOR = '[data-qa="modal-overlay"]';
const RESPONSE_SUBMIT_SELECTOR = '[data-qa="vacancy-response-submit-popup"]';

const POLL_MS = 500;
// a solved captcha leaves through a closing animation, and a wrong answer swaps the dialog for a fresh
// one — the run only resumes once the page has stayed clear this long
const CLEAR_SETTLE_MS = 1000;
const ACTIVITY_WINDOW_MS = 8000;

function isCaptchaVisible() {
  return [PICTURE_SELECTOR, INPUT_SELECTOR].some((selector) => isVisible(document.querySelector(selector)));
}

// What the dialog looks like right now, as one loggable line. `key` (the picture's id) tells one
// captcha from the next, `errorShown` is hh.ru's own "Неверный текст" state — together with the page
// activity log they show whether an error came from a wrong answer or arrived with the dialog.
function describeCaptcha() {
  const input = document.querySelector(INPUT_SELECTOR);
  const errorContainer = document.querySelector(ERROR_SELECTOR)?.closest('[aria-hidden]');
  const errorShown = errorContainer?.getAttribute('aria-hidden') === 'false';
  const responseSubmit = document.querySelector(RESPONSE_SUBMIT_SELECTOR);

  let key = 'none';
  try {
    key = new URL(document.querySelector(PICTURE_SELECTOR).src).searchParams.get('key')?.slice(0, 8) ?? 'none';
  } catch {
    // no picture (yet) — the input alone was enough to see the dialog
  }

  return (
    `key=${key} errorShown=${errorShown} inputInvalid=${input?.getAttribute('aria-invalid') === 'true'} ` +
    `inputLen=${input?.value.length ?? 'n/a'} overlays=${document.querySelectorAll(MODAL_OVERLAY_SELECTOR).length} ` +
    `responseSubmit=${responseSubmit ? (responseSubmit.disabled ? 'disabled' : 'enabled') : 'absent'}`
  );
}

// A captcha can appear on any page the bot works on, at any moment (typically right after a response
// click or a submit), and only a human can clear it. Instead of each flow learning to recognize it,
// the run is held for the whole document: every wait and every action in run-control's checkpoints
// stands still — with their timeouts frozen — until the captcha is gone, then the flow simply carries on
// from exactly where it was. The dialog appearing is caught by the observer (immediately, before any
// flow step can run against it); it disappearing is caught by polling, which doesn't depend on hh.ru
// removing the element rather than merely hiding it.
//
// Everything that helps explain a captcha afterwards goes to the diagnostic log: how it looked on
// arrival, every change while it was up (new picture, error), and what the page and the person did
// around it. Returns the check the shared observer calls on every DOM change.
export function captchaWatcher(module) {
  let holding = false;
  let sequence = 0; // captchas seen by this document — a repeat in a long-lived page is a pattern worth seeing
  let lastResumedAt = null;

  function log(level, message, context) {
    return ifStillRunning(() => addDiagnosticLogEntry({ at: Date.now(), level, module, message, context }));
  }

  // ends when the page has stayed clear long enough (settle + a human-sized beat before the bot moves
  // again — it must not jump the instant the dialog goes, which no person does either)
  async function waitUntilCleared(heldAt) {
    let shape = describeCaptcha();
    let attempts = 0;
    let clearSince = null;
    let resumeAfterMs = null;

    while (!isContextInvalidated()) {
      await sleep(POLL_MS);

      if (isCaptchaVisible()) {
        clearSince = null;
        resumeAfterMs = null;
        const now = describeCaptcha();
        if (now !== shape) {
          shape = now;
          attempts += 1;
          log('info', 'captcha changed while up', `${now} | ${recentActivity(ACTIVITY_WINDOW_MS)}`);
        }
        continue;
      }

      if (clearSince === null) {
        clearSince = Date.now();
        const settings = await getSettings();
        resumeAfterMs = CLEAR_SETTLE_MS + randomDelayMs(settings.delayMinSec, settings.delayMaxSec);
      }
      if (Date.now() - clearSince >= resumeAfterMs) {
        const heldMs = Date.now() - heldAt;
        log(
          'info',
          'captcha gone, run resumed',
          `heldMs=${heldMs} changes=${attempts} resumeDelayMs=${resumeAfterMs} | ` +
            recentActivity(heldMs + ACTIVITY_WINDOW_MS, 25),
        );
        return;
      }
    }
  }

  async function hold() {
    const heldAt = Date.now();
    sequence += 1;
    const sincePreviousS = lastResumedAt === null ? 'first' : Math.round((heldAt - lastResumedAt) / 1000);
    const navigationType = performance.getEntriesByType('navigation')[0]?.type ?? 'unknown';

    holding = true;
    holdRun(PauseReason.CAPTCHA);
    ifStillRunning(() =>
      reportWarning(
        module,
        'captcha shown, run paused until it is solved',
        `seq=${sequence} sincePreviousResumeS=${sincePreviousS} docAgeS=${Math.round(performance.now() / 1000)} ` +
          `nav=${navigationType} ${describeCaptcha()} | ${recentActivity(ACTIVITY_WINDOW_MS)}`,
      ),
    );

    await waitUntilCleared(heldAt);

    releaseRun(PauseReason.CAPTCHA);
    lastResumedAt = Date.now();
    holding = false;
  }

  function check() {
    if (!holding && isCaptchaVisible()) hold();
  }

  // a pause left behind by an earlier document of this run (the page navigated while it was up) is stale
  // until this page shows a captcha of its own
  releaseRun(PauseReason.CAPTCHA);
  check();
  return check;
}
