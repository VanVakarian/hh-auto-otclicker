import { PauseReason, getSettings, getRunState, addDiagnosticLogEntry } from './storage.js';
import { isVisible, sleep } from './dom.js';
import { randomDelayMs } from './pacing.js';
import { holdRun, releaseRun, ifStillRunning } from './run-control.js';
import { recentActivity } from './page-recorder.js';
import { reportWarning, reportError } from './diagnostics.js';
import {
  CAPTCHA_PICTURE_SELECTOR as PICTURE_SELECTOR,
  CAPTCHA_INPUT_SELECTOR as INPUT_SELECTOR,
  CAPTCHA_RENEW_SELECTOR,
  CAPTCHA_LANGUAGE_SELECTOR,
  classifyUrl,
} from './hh-pages.js';
import { pictureKey, readPicture, submitButton, captchaState, describeCaptcha } from './captcha-page.js';
import { createAutoSolver } from './captcha-autosolve.js';
import { createEpisode } from './captcha-episode.js';
import { isContextInvalidated, isContextInvalidatedError, haltOnContextInvalidated } from './extension-context.js';

const POLL_MS = 500;
// a solved captcha leaves through a closing animation, and a wrong answer swaps the dialog for a fresh
// one — the run only resumes once the page has stayed clear this long
const CLEAR_SETTLE_MS = 1000;
const ACTIVITY_WINDOW_MS = 8000;
// what led to the dialog (the click, the submit, the request hh.ru answered with it) is further back than
// what happens in it
const SHOWN_ACTIVITY_WINDOW_MS = 30_000;
const ACTIVITY_LINES = 120;

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
// around it. The log goes to a server and is read by program: each entry carries its facts as `data`
// fields next to the text, and each entry of an episode says which document (`doc`) and which captcha of
// it (`seq`) it belongs to. Besides the solver's own entries the watcher writes:
//   captcha shown                        the dialog appeared: which vacancy and page, the tab's state, the dialog
//   captcha person started typing        the first key a person pressed on a picture, and how soon after it came
//   captcha person submitted             a person pressed the button or Enter: the text in the field, whether it
//                                        is the model's own answer
//   captcha person answer accepted/rejected   hh.ru's verdict on that
//   captcha person asked for another picture / switched the language
//   captcha gone                         the dialog is gone and the run resumes: who solved it, the totals
//   captcha episode summary              the whole episode as one record, picture by picture (captcha-episode.js)
//   captcha episode interrupted          the page left while the dialog was up (best effort: a page that is
//                                        going away may not manage to write); the worker's navigation entry
//                                        carries the run's pause, which does not depend on the page
// Returns the check the shared observer calls on every DOM change.
export function captchaWatcher(module) {
  const doc = Math.random().toString(36).slice(2, 8); // `seq` starts over in every page: this tells the pages apart
  let holding = false;
  let sequence = 0; // captchas seen by this document — a repeat in a long-lived page is a pattern worth seeing
  let lastResumedAt = null;
  let savedKey = null;

  // Every distinct picture goes to the background's picture archive (captcha-store.js) — raw material
  // for testing recognizers, and what the uploader sends to the server. Cheap when there is nothing new,
  // so it is called on every poll; a picture that hasn't finished loading yet is simply picked up by the
  // next one. Never throws.
  async function savePicture(episode) {
    const key = pictureKey();
    if (!key || key === savedKey) return;

    try {
      const picture = readPicture();
      if (!picture) return; // not loaded yet: the next poll tries again
      savedKey = key;
      episode.ready(key);
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

  function log(level, message, context, data) {
    const entry = { at: Date.now(), level, module, message, context, data: { doc, ...data } };
    return ifStillRunning(() => addDiagnosticLogEntry(entry));
  }

  // What a person does in the dialog, as far as the page can tell: only trusted events are theirs — what the
  // extension does to the page (its clicks and fills) is not trusted. Nothing here changes what the solver
  // does; it only writes down. Verdicts on the submissions of the episode are given through `settle`, for
  // the extension's own as well (the episode keeps them all).
  function watchPerson({ episode, autoSolver, seq, heldAt }) {
    const short = (key) => key?.slice(0, 8) ?? 'none';
    const note = (level, message, context, data) =>
      log(level, message, `seq=${seq} ${context}`, { seq, ...data });

    const onInput = (event) => {
      if (!event.isTrusted || !event.target?.matches?.(INPUT_SELECTOR)) return;
      const key = pictureKey();
      if (!key || !episode.typed(key)) return; // only the first key of a picture is written down
      note('info', 'captcha person started typing', `key=${short(key)} inputLen=${event.target.value.length}`, {
        key,
        sincePictureMs: episode.pictureAgeMs(key),
        sinceShownMs: Date.now() - heldAt,
        inputLen: event.target.value.length,
        solverPhase: autoSolver.phase(),
        solverFinished: autoSolver.isFinished(),
      });
    };

    const personSubmitted = (via) => {
      const key = pictureKey();
      const input = document.querySelector(INPUT_SELECTOR);
      if (!key || !input) return;
      const text = input.value;
      const record = episode.submitted(key, { by: 'person', text, via });
      note(
        'info',
        'captcha person submitted',
        `key=${short(key)} via=${via} text="${text}" fromModel=${record.textFromModel} | ${describeCaptcha()}`,
        {
          key,
          via,
          text,
          textFromModel: record.textFromModel,
          sincePictureMs: episode.pictureAgeMs(key),
          sinceShownMs: Date.now() - heldAt,
          solverPhase: autoSolver.phase(),
          dialog: captchaState(),
        },
      );
    };

    const onClick = (event) => {
      const button = event.isTrusted ? event.target?.closest?.('button') : null;
      if (!button) return;
      const key = pictureKey();
      if (button === submitButton()) {
        personSubmitted('button');
      } else if (button.matches(CAPTCHA_RENEW_SELECTOR)) {
        if (key) episode.renewed(key, 'person');
        note('info', 'captcha person asked for another picture', `key=${short(key)}`, {
          key,
          sincePictureMs: key ? episode.pictureAgeMs(key) : null,
          solverPhase: autoSolver.phase(),
        });
      } else if (button.matches(CAPTCHA_LANGUAGE_SELECTOR)) {
        note('info', 'captcha person switched the language', `key=${short(key)}`, {
          key,
          button: button.textContent.trim(),
        });
      }
    };

    const onKeydown = (event) => {
      if (event.isTrusted && event.key === 'Enter' && event.target?.matches?.(INPUT_SELECTOR)) personSubmitted('enter');
    };

    document.addEventListener('input', onInput, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);

    return {
      // hh.ru's verdict on what was sent for this picture (by anyone); only a person's is written here, the
      // solver writes its own
      settle(key, verdict) {
        const record = episode.verdict(key, verdict);
        if (record?.by !== 'person') return;
        note('info', `captcha person answer ${verdict}`, `key=${short(key)} text="${record.text}"`, {
          key,
          text: record.text,
          textFromModel: record.textFromModel,
          reactionMs: Date.now() - record.at,
        });
      },
      stop() {
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeydown, true);
      },
    };
  }

  // ends when the page has stayed clear long enough (settle + a human-sized beat before the bot moves
  // again — it must not jump the instant the dialog goes, which no person does either)
  async function waitUntilCleared({ heldAt, autoSolver, episode, person }) {
    let shape = describeCaptcha();
    let attempts = 0;
    let clearSince = null;
    let resumeAfterMs = null;
    let lastKey = null;

    // a new picture while a submission is waiting for its verdict is hh.ru's "no" to it
    const trackPicture = () => {
      const key = pictureKey();
      if (!key || key === lastKey) return;
      if (lastKey) person.settle(lastKey, 'rejected');
      lastKey = key;
      episode.seen(key);
    };
    trackPicture();

    while (!isContextInvalidated()) {
      await sleep(POLL_MS);

      if (isCaptchaVisible()) {
        savePicture(episode);
        trackPicture();
        autoSolver.tick();
        clearSince = null;
        resumeAfterMs = null;
        const now = describeCaptcha();
        if (now !== shape) {
          shape = now;
          attempts += 1;
          log('info', 'captcha changed while up', `${now} | ${recentActivity(ACTIVITY_WINDOW_MS)}`, {
            seq: sequence,
            ...captchaState(),
          });
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
        if (lastKey) person.settle(lastKey, 'accepted'); // gone for good: what was sent last was accepted
        const solved = autoSolver.outcome();
        log(
          'info',
          'captcha gone, run resumed',
          `seq=${sequence} heldMs=${heldMs} changes=${attempts} resumeDelayMs=${resumeAfterMs} ` +
            `solvedBy=${autoSolver.verdict()} auto: ${autoSolver.summary()} | ` +
            recentActivity(heldMs + ACTIVITY_WINDOW_MS, ACTIVITY_LINES),
          {
            seq: sequence,
            heldMs,
            changes: attempts,
            resumeDelayMs: resumeAfterMs,
            solvedBy: solved.by,
            solvedWhy: solved.why,
            auto: autoSolver.counters(),
          },
        );
        return;
      }
    }
  }

  async function hold() {
    const heldAt = Date.now();
    sequence += 1;
    const seq = sequence;
    const sincePreviousS = lastResumedAt === null ? 'first' : Math.round((heldAt - lastResumedAt) / 1000);
    const navigationType = performance.getEntriesByType('navigation')[0]?.type ?? 'unknown';
    const flow = classifyUrl(location.href);

    holding = true;
    holdRun(PauseReason.CAPTCHA);

    const episode = createEpisode({ doc, seq, shownAt: heldAt });
    savePicture(episode);
    let vacancyId = null;
    let runWasGoing = false; // whether the entries below are written at all: a person browsing by hand is not the run's business
    ifStillRunning(async () => {
      runWasGoing = true;
      vacancyId = (await getRunState()).pendingVacancy?.vacancyId ?? null;
      await reportWarning(
        module,
        'captcha shown, run paused until it is solved',
        `seq=${seq} sincePreviousResumeS=${sincePreviousS} docAgeS=${Math.round(performance.now() / 1000)} ` +
          `nav=${navigationType} ${describeCaptcha()} vacancyId=${vacancyId ?? '-'} flow=${flow} | ` +
          recentActivity(SHOWN_ACTIVITY_WINDOW_MS, ACTIVITY_LINES),
        {
          doc,
          seq,
          vacancyId,
          flow,
          tab: { visibility: document.visibilityState, focused: document.hasFocus() },
          nav: navigationType,
          docAgeS: Math.round(performance.now() / 1000),
          sincePreviousResumeS: sincePreviousS,
          ...captchaState(),
        },
      );
    });

    const autoSolver = createAutoSolver({ log, seq, shownAt: heldAt, episode });
    const person = watchPerson({ episode, autoSolver, seq, heldAt });

    // The page may leave while the dialog is up (hh.ru moves on after an accepted answer, the worker sends
    // the tab back to the list): the episode is written down as far as it got. Best effort, see above.
    const onPageHide = () => {
      if (!runWasGoing) return;
      const summary = episode.summary({ solvedBy: null, endedBy: 'document_unloading', vacancyId, flow });
      addDiagnosticLogEntry({
        at: Date.now(),
        level: 'warn',
        module,
        message: 'captcha episode interrupted: the page is leaving',
        context: `seq=${seq} dialogUp=${isCaptchaVisible()} heldMs=${summary.heldMs}`,
        data: { ...summary, dialogUp: isCaptchaVisible(), auto: autoSolver.counters() },
      }).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);

    await waitUntilCleared({ heldAt, autoSolver, episode, person });

    window.removeEventListener('pagehide', onPageHide);
    person.stop();
    autoSolver.stop();
    const summary = episode.summary({ solvedBy: autoSolver.outcome().by, endedBy: 'cleared', vacancyId, flow });
    log(
      'info',
      'captcha episode summary',
      `seq=${seq} pictures=${summary.totals.pictures} extension=${summary.totals.submittedByExtension} ` +
        `person=${summary.totals.submittedByPerson} accepted=${summary.totals.accepted} ` +
        `rejected=${summary.totals.rejected} solvedBy=${summary.solvedBy}`,
      summary,
    );
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
