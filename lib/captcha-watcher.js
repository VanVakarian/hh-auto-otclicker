import { PauseReason, getSettings, addDiagnosticLogEntry } from './storage.js';
import { isVisible, sleep } from './dom.js';
import { randomDelayMs } from './pacing.js';
import { holdRun, releaseRun, ifStillRunning } from './run-control.js';
import { recentActivity } from './page-recorder.js';
import { reportWarning, reportError } from './diagnostics.js';
import { CAPTCHA_PICTURE_SELECTOR as PICTURE_SELECTOR, CAPTCHA_INPUT_SELECTOR as INPUT_SELECTOR } from './hh-pages.js';
import { pictureKey, readPicture, describeCaptcha } from './captcha-page.js';
import { createAutoSolver } from './captcha-autosolve.js';
import { isContextInvalidated, isContextInvalidatedError, haltOnContextInvalidated } from './extension-context.js';

const POLL_MS = 500;
// a solved captcha leaves through a closing animation, and a wrong answer swaps the dialog for a fresh
// one — the run only resumes once the page has stayed clear this long
const CLEAR_SETTLE_MS = 1000;
const ACTIVITY_WINDOW_MS = 8000;

function isCaptchaVisible() {
  return [PICTURE_SELECTOR, INPUT_SELECTOR].some((selector) => isVisible(document.querySelector(selector)));
}

// A captcha can appear on any page the bot works on, at any moment (typically right after a response
// click or a submit), and something other than the flow has to clear it. Instead of each flow learning to
// recognize it, the run is held for the whole document: every wait and every action in run-control's
// checkpoints stands still — with their timeouts frozen — until the captcha is gone, then the flow simply
// carries on from exactly where it was. The dialog appearing is caught by the observer (immediately,
// before any flow step can run against it); it disappearing is caught by polling, which doesn't depend on
// hh.ru removing the element rather than merely hiding it.
//
// What clears it is the auto-solver (captcha-autosolve.js) when it is switched on, a person otherwise or
// when the solver can't carry on: the watcher doesn't care who — it waits for the dialog to be gone.
//
// Everything that helps explain a captcha afterwards goes to the diagnostic log: how it looked on
// arrival, every change while it was up (new picture, error), and what the page and the person did
// around it. Returns the check the shared observer calls on every DOM change.
export function captchaWatcher(module) {
  let holding = false;
  let sequence = 0; // captchas seen by this document — a repeat in a long-lived page is a pattern worth seeing
  let lastResumedAt = null;
  let savedKey = null;

  // Every distinct picture goes to the background's picture archive (captcha-store.js) — raw material
  // for testing recognizers. Cheap when there is nothing new, so it is called on every poll; a picture
  // that hasn't finished loading yet is simply picked up by the next one. Never throws.
  async function savePicture() {
    const key = pictureKey();
    if (!key || key === savedKey) return;

    try {
      const picture = readPicture();
      if (!picture) return; // not loaded yet: the next poll tries again
      savedKey = key;
      await chrome.runtime.sendMessage({
        type: 'HHAA_SAVE_CAPTCHA',
        payload: { key, dataUrl: picture.dataUrl },
      });
    } catch (error) {
      savedKey = key; // a picture that failed once is not retried on every poll
      if (isContextInvalidatedError(error)) haltOnContextInvalidated();
      else await reportError(module, `saving captcha picture failed: ${error.message}`, `key=${key.slice(0, 8)}`);
    }
  }

  function log(level, message, context) {
    return ifStillRunning(() => addDiagnosticLogEntry({ at: Date.now(), level, module, message, context }));
  }

  // ends when the page has stayed clear long enough (settle + a human-sized beat before the bot moves
  // again — it must not jump the instant the dialog goes, which no person does either)
  async function waitUntilCleared(heldAt, autoSolver) {
    let shape = describeCaptcha();
    let attempts = 0;
    let clearSince = null;
    let resumeAfterMs = null;

    while (!isContextInvalidated()) {
      await sleep(POLL_MS);

      if (isCaptchaVisible()) {
        savePicture();
        autoSolver.tick();
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
        autoSolver.onCleared();
        log(
          'info',
          'captcha gone, run resumed',
          `seq=${sequence} heldMs=${heldMs} changes=${attempts} resumeDelayMs=${resumeAfterMs} ` +
            `solvedBy=${autoSolver.verdict()} auto: ${autoSolver.summary()} | ` +
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
    savePicture();
    ifStillRunning(() =>
      reportWarning(
        module,
        'captcha shown, run paused until it is solved',
        `seq=${sequence} sincePreviousResumeS=${sincePreviousS} docAgeS=${Math.round(performance.now() / 1000)} ` +
          `nav=${navigationType} ${describeCaptcha()} | ${recentActivity(ACTIVITY_WINDOW_MS)}`,
      ),
    );

    const autoSolver = createAutoSolver({ log, seq: sequence, shownAt: heldAt });
    await waitUntilCleared(heldAt, autoSolver);

    autoSolver.stop();
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
  releaseRun(PauseReason.CAPTCHA_AUTO);
  check();
  return check;
}
