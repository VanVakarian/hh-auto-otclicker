import { PauseReason, getRunState, getSettings } from './storage.js';
import { CAPTCHA_PICTURE_SELECTOR, CAPTCHA_INPUT_SELECTOR, CAPTCHA_RENEW_SELECTOR } from './hh-pages.js';
import {
  pictureKey,
  readPicture,
  submitButton,
  isRussianCaptcha,
  isErrorShown,
  captchaState,
  describeCaptcha,
  describeDialogControls,
  describePicture,
} from './captcha-page.js';
import { click, fillText } from './interaction.js';
import { holdRun, releaseRun } from './run-control.js';
import { recentActivity } from './page-recorder.js';
import { isVisible, sleep } from './dom.js';
import { reactionDelayMs } from './pacing.js';
import { reportError } from './diagnostics.js';
import { isContextInvalidatedError, haltOnContextInvalidated } from './extension-context.js';

// Answers hh.ru's captcha on the bot's behalf. The watcher (captcha-watcher.js) has already held the run for
// the whole document; this is what it does meanwhile, and it hands the captcha over to the person the
// moment it can't carry on — from then on the situation is exactly what it was before auto-solving existed.
//
// One solver lives for one captcha episode (the dialog up, through any wrong answers and new pictures).
// The watcher calls `tick()` on every poll; the solver decides whether there is something to do:
//  - each picture is answered at most once, and an episode makes at most MAX_ATTEMPTS answers — a captcha
//    the model can't read is not worth an unbounded stream of wrong answers;
//  - it acts like a person would: a beat to look at the picture, a beat to check the typed text;
//  - a person always wins: text they started typing, a captcha they solved or swapped meanwhile, a Stop —
//    each ends the solver's part at once, nothing is typed or pressed over them;
//  - it never acts outside a run: someone browsing by hand who meets a captcha is not the bot's business.
//
// DIAGNOSTICS. The rule is that whatever happened to a captcha can be read from the diagnostic log alone,
// including what the solver did NOT do and why. Every entry of an episode carries `seq=N` (the watcher's
// "captcha shown" entry has the same number), so an episode is one story:
//   captcha shown                          the watcher: the dialog appeared (page state, recent activity)
//   captcha auto-solve not used            switched off / no key — the reason nothing will happen
//   captcha auto-solve started             first attempt begins (configured model, page state)
//   captcha model answered                 every model call, whatever came back: answer or failure, the model
//                                          that really answered, calls made, tokens, cost, the tail of its reply
//   captcha model gave no usable answer    the reply was no words worth typing: another picture is requested
//   captcha attempt abandoned              an attempt dropped because the page or the run changed under it
//                                          (a warn when the model call had already been paid for)
//   captcha answer submitted               the answer typed and the button pressed, with the attempt's timeline
//   captcha answer rejected / accepted     hh.ru's verdict on it: a new picture came / the dialog went away
//   captcha auto-solve handed over         the solver stopped and a person has it: the reason, the dialog's
//                                          buttons and recent page activity to explain it
//   captcha auto-solve idle / taking long  watchdogs: the solver has not started / an attempt is stuck
//   captcha gone                           the watcher: who solved it (`solvedBy`) and the episode's totals
// Next to these the watcher writes what a person did (it knows only what the page shows: trusted events) and
// one summary of the whole episode — see captcha-watcher.js. Everything is permanent on purpose: the entry
// that would have explained a failure months from now is exactly the one somebody would have removed as
// "temporary". Diagnostics go to a server now, so the entries carry `data` — the same facts as fields.

const MAX_ATTEMPTS = 3;
// hh.ru answers a submitted answer within moments (the dialog closes, or a new picture replaces it); the
// same picture standing this long means the answer never took
const NO_REACTION_MS = 20_000;
const SUBMIT_ENABLE_WAIT_MS = 3000;
const SUBMIT_ENABLE_POLL_MS = 200;
const TRANSIENT_FAILURE_PAUSE_MS = 2000;
// watchdogs: a solver that has done nothing this long after the dialog came up, an attempt that has been
// running this long — each is logged once, the situation itself is left to run its course
const IDLE_WARN_MS = 10_000;
const STUCK_ATTEMPT_MS = 90_000;
const ACTIVITY_WINDOW_MS = 8000;

// `log(level, message, context, data)` writes to the diagnostic log (the watcher's, so entries carry its
// module); `seq` numbers the episode as the watcher does, `shownAt` is when the dialog appeared. `episode`
// (captcha-episode.js) is where the facts about the pictures are kept for the episode's summary; `data` of
// an entry is the same facts as fields, for analysis by program (the text is for the eye).
export function createAutoSolver({ log, seq, shownAt, episode }) {
  let attempts = 0;
  let submitted = 0;
  let accepted = 0;
  let rejected = 0;
  let abandoned = 0;
  let cost = 0;
  let busy = false;
  let engaged = false; // an attempt has begun at least once
  let finished = false; // the person has it from here
  let endedBy = null; // why the solver stopped acting, when it did
  let solving = false; // whether the panel is told "the extension is on it"
  let pending = null; // what was last sent to hh.ru: { key, answer, at } — answer is null for "another picture"
  let lastAnswer = null;
  let firstTickAt = null;
  let idleLogged = false;
  let stuckLogged = false;
  let attemptStartedAt = 0;
  let phase = 'idle';
  let phases = []; // { name, ms } — each phase with the moment it began, in ms from the attempt's start

  const counters = () => ({ attempts, submitted, accepted, rejected, abandoned, costUsd: cost });
  const stats = () =>
    `attempts=${attempts} submitted=${submitted} accepted=${accepted} rejected=${rejected} ` +
    `abandoned=${abandoned} cost=$${cost.toFixed(5)} sinceShownMs=${Date.now() - shownAt}`;

  // where the attempt's time went
  const enter = (name) => {
    phase = name;
    phases.push({ name, ms: Date.now() - attemptStartedAt });
  };
  const timeline = () => {
    const now = Date.now() - attemptStartedAt;
    return phases.length > 0 ? `${phases.map(({ name, ms }) => `${name}@${ms}`).join(' ')} now@${now}` : 'no attempt';
  };
  const timelineData = () => ({
    ...Object.fromEntries(phases.map(({ name, ms }) => [name, ms])),
    nowMs: Date.now() - attemptStartedAt,
  });

  const say = (level, message, context = '', data = {}) => {
    const line = `seq=${seq} ${context}`.trim();
    console.log(`🧩 [captcha] ${message} (${line})`);
    return log(level, message, line, { seq, ...data });
  };

  const startSolving = () => {
    if (solving) return;
    solving = true;
    holdRun(PauseReason.CAPTCHA_AUTO);
  };

  const finish = (reason) => {
    finished = true;
    endedBy ??= reason;
    if (!solving) return;
    solving = false;
    releaseRun(PauseReason.CAPTCHA_AUTO);
  };

  // the solver stops acting; everything that helps explain why goes with the entry
  const giveUp = (reason, level = 'warn') => {
    const controls = describeDialogControls();
    const activity = recentActivity(ACTIVITY_WINDOW_MS);
    say(
      level,
      'captcha auto-solve handed over to a person',
      `${reason} | ${stats()} | t: ${timeline()} | ${describeCaptcha()} | ${controls} | ${activity}`,
      { reason, ...counters(), phase, timeline: timelineData(), dialog: captchaState(), controls, activity },
    );
    const key = pictureKey();
    if (key) episode.handedOver(key, reason);
    finish(reason);
  };

  const notUsed = (reason) => {
    say('info', 'captcha auto-solve not used', reason, { reason });
    finish(reason);
  };

  // an attempt dropped without a verdict on the captcha; a warn when the model call had cost money
  const abandon = (reason, { paid }) => {
    abandoned += 1;
    say(paid ? 'warn' : 'info', 'captcha attempt abandoned', `${reason} | ${stats()} | t: ${timeline()}`, {
      reason,
      paid,
      ...counters(),
      phase,
      timeline: timelineData(),
    });
  };

  const isRunning = async () => (await getRunState()).status === 'running';

  const isDialogUp = () =>
    [CAPTCHA_PICTURE_SELECTOR, CAPTCHA_INPUT_SELECTOR].every((selector) => isVisible(document.querySelector(selector)));

  // why the picture the solver is working on is no longer its to answer; null while it is
  const currentProblem = (key) => {
    if (finished) return 'the solver was ended meanwhile';
    if (!isDialogUp()) return 'the dialog closed';
    if (pictureKey() !== key) return 'the picture was swapped';
    return null;
  };

  async function requestSolution(settings, dataUrl) {
    try {
      return await chrome.runtime.sendMessage({
        type: 'HHAA_SOLVE_CAPTCHA',
        payload: { apiKey: settings.apiKey, model: settings.captchaModel, dataUrl },
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) haltOnContextInvalidated();
      // the service worker went away mid-request, or nothing answered: a failure to try again, not a verdict
      return { success: false, kind: 'transient', error: error.message };
    }
  }

  // one entry per model call, whatever came back — the ledger of what was sent, answered and paid for
  function logModelAnswer(response, picture, key) {
    const meta = response?.metadata ?? {};
    const result = response?.success ? 'answer' : (response?.kind ?? 'none');
    const level = response?.success || response?.kind === 'unusable' ? 'info' : 'warn';
    const failure = (response?.error ?? 'no response').replace(/\s+/g, ' ').slice(0, 200);
    const image = `${picture.width}x${picture.height}/${Math.round(picture.dataUrl.length / 1024)}KB`;
    const extras = [
      response?.success ? '' : `error="${failure}"`,
      meta.retryReasons ? `retried: ${meta.retryReasons}` : '',
      meta.reply ? `reply="${meta.reply}"` : '',
    ];
    say(
      level,
      'captcha model answered',
      `attempt=${attempts} result=${result} answer=${response?.answer ?? '-'} model=${meta.model ?? '-'} ` +
        `served=${meta.servedModel ?? '-'} calls=${meta.calls ?? '-'} ms=${meta.responseTime ?? '-'} ` +
        `tokens=${meta.tokens ?? '-'} finish=${meta.finishReason ?? '-'} cost=${meta.cost ?? 'n/a'} ` +
        `key=${key.slice(0, 8)} img=${image} ` +
        extras.filter(Boolean).join(' '),
      {
        attempt: attempts,
        key,
        result,
        answer: response?.answer ?? null,
        transcript: meta.transcript ?? null, // what the model read letter by letter
        agrees: meta.agrees ?? null, // whether its answer kept to that reading
        model: meta.model ?? null,
        servedModel: meta.servedModel ?? null,
        provider: meta.provider ?? null,
        generationId: meta.generationId ?? null,
        promptId: meta.promptId ?? null,
        calls: meta.calls ?? null,
        ms: meta.responseTime ?? null,
        tokens: meta.tokens ?? null,
        finishReason: meta.finishReason ?? null,
        costUsd: meta.cost ?? null,
        image: { width: picture.width, height: picture.height, kb: Math.round(picture.dataUrl.length / 1024) },
        reply: meta.reply ?? null,
        retryReasons: meta.retryReasons || null,
        error: response?.success ? null : failure,
      },
    );
    episode.modelAnswered(key, {
      attempt: attempts,
      answer: response?.answer ?? null,
      transcript: meta.transcript ?? null,
      agrees: meta.agrees ?? null,
      ms: meta.responseTime ?? null,
      costUsd: meta.cost ?? 0,
      result,
    });
  }

  // hh.ru's "Другой текст": a fresh picture instead of typing something the model wasn't sure about
  async function askForAnotherPicture(key, reason) {
    const renewButton = document.querySelector(CAPTCHA_RENEW_SELECTOR);
    if (attempts >= MAX_ATTEMPTS || !isVisible(renewButton)) {
      return giveUp(`no usable answer (${reason}) and no fresh picture to try`);
    }
    say('info', 'captcha model gave no usable answer, asking for another picture', `${reason} | ${stats()}`, {
      reason,
      key,
      ...counters(),
    });
    episode.renewed(key, 'extension');
    await click(renewButton, { underHold: true });
    pending = { key, answer: null, at: Date.now() }; // the old picture may stay up a moment: never sent twice
  }

  async function waitForEnabledSubmit() {
    for (let waited = 0; waited <= SUBMIT_ENABLE_WAIT_MS; waited += SUBMIT_ENABLE_POLL_MS) {
      const button = submitButton();
      if (button && !button.disabled) return button;
      await sleep(SUBMIT_ENABLE_POLL_MS);
    }
    return null;
  }

  async function attempt(key) {
    const settings = await getSettings();
    if (!settings.captchaSolveEnabled) return notUsed('switched off in settings');
    if (!settings.apiKey?.trim()) return notUsed('no API key in settings');
    if (!(await isRunning())) return finish('no run is going'); // nothing to log: this is a person's own browsing
    if (attempts >= MAX_ATTEMPTS) return giveUp(`${MAX_ATTEMPTS} attempts made`);
    if (!isRussianCaptcha()) return giveUp('the captcha is not in Russian', 'info');

    let picture;
    try {
      picture = readPicture();
    } catch (error) {
      return giveUp(`the picture can't be exported: ${error.message}`);
    }
    if (picture?.key !== key) return; // still loading: the next tick tries again

    attempts += 1;
    engaged = true;
    attemptStartedAt = Date.now();
    phases = [];
    stuckLogged = false;
    startSolving();
    if (attempts === 1) {
      const model = settings.captchaModel?.trim() || 'default';
      say('info', 'captcha auto-solve started', `model=${model} ${describeCaptcha()}`, {
        model,
        dialog: captchaState(),
        pictureAgeMs: episode.pictureAgeMs(key),
      });
    }

    enter('look');
    await sleep(reactionDelayMs()); // a person needs a moment to look at the picture
    let problem = currentProblem(key);
    if (problem) return abandon(problem, { paid: false });

    enter('model');
    const response = await requestSolution(settings, picture.dataUrl);
    cost += response?.metadata?.cost ?? 0;
    logModelAnswer(response, picture, key);
    const paid = (response?.metadata?.cost ?? 0) > 0;

    // solved, closed or swapped by a person while the model was looking, or the run was stopped
    problem = currentProblem(key);
    if (problem) return abandon(problem, { paid });
    if (!(await isRunning())) return giveUp('the run was stopped', 'info');

    if (!response?.success) {
      const error = response?.error ?? 'no response';
      if (response?.kind === 'unusable') return askForAnotherPicture(key, error);
      if (response?.kind === 'transient' || !response?.kind) {
        return sleep(TRANSIENT_FAILURE_PAUSE_MS); // nothing sent to hh.ru: the next tick tries this picture again
      }
      return giveUp(`${response.kind}: ${error}`, response.kind === 'unavailable' ? 'warn' : 'info');
    }

    enter('fill');
    const input = document.querySelector(CAPTCHA_INPUT_SELECTOR);
    if (!isVisible(input)) return giveUp('the input vanished');
    // text of the previous, wrong answer may still stand in the field — only something else is a person's
    if (input.value !== '' && input.value !== lastAnswer) {
      return giveUp(`a person started typing (inputLen=${input.value.length})`, 'info');
    }
    await fillText(input, response.answer, { underHold: true });

    enter('check');
    await sleep(reactionDelayMs()); // a person checks what they typed before pressing the button
    problem = currentProblem(key);
    if (problem) return abandon(problem, { paid });
    if (!(await isRunning())) return giveUp('the run was stopped', 'info');
    const typed = document.querySelector(CAPTCHA_INPUT_SELECTOR)?.value;
    if (typed !== response.answer) {
      return giveUp(`the field did not keep the answer (typed="${typed}", expected="${response.answer}")`);
    }

    enter('press');
    const button = await waitForEnabledSubmit();
    if (!button) return giveUp('no enabled submit button in the captcha dialog');
    problem = currentProblem(key);
    if (problem) return abandon(problem, { paid });

    await click(button, { underHold: true });
    enter('sent');
    pending = { key, answer: response.answer, at: Date.now() };
    lastAnswer = response.answer;
    submitted += 1;
    episode.submitted(key, { by: 'extension', text: response.answer, via: 'button' });
    say(
      'info',
      'captcha answer submitted',
      `key=${key.slice(0, 8)} answer="${response.answer}" ${stats()} t: ${timeline()} | ${describeCaptcha()}`,
      {
        key,
        answer: response.answer,
        attempt: attempts,
        ...counters(),
        timeline: timelineData(),
        pictureAgeMs: episode.pictureAgeMs(key),
        dialog: captchaState(),
      },
    );
  }

  // hh.ru's reaction to the last thing sent: a new picture where the answer was is a rejection
  function settlePending(newKey) {
    const previous = pending;
    pending = null;
    if (!previous.answer) return;
    rejected += 1;
    const activity = recentActivity(ACTIVITY_WINDOW_MS);
    say(
      'info',
      'captcha answer rejected',
      `answer="${previous.answer}" reactionMs=${Date.now() - previous.at} newKey=${newKey.slice(0, 8)} ` +
        `errorShown=${isErrorShown()} ${stats()} | ${activity}`,
      {
        key: previous.key,
        answer: previous.answer,
        reactionMs: Date.now() - previous.at,
        newKey,
        errorShown: isErrorShown(),
        ...counters(),
        activity,
      },
    );
  }

  // the watchdogs only say something is off; they change nothing
  function watchIdle() {
    if (engaged || idleLogged || Date.now() - firstTickAt < IDLE_WARN_MS) return;
    idleLogged = true;
    const inputVisible = isVisible(document.querySelector(CAPTCHA_INPUT_SELECTOR));
    const controls = describeDialogControls();
    say(
      'warn',
      'captcha auto-solve idle: nothing attempted yet',
      `${describePicture()} inputVisible=${inputVisible} ${controls} ${stats()}`,
      { picture: describePicture(), inputVisible, controls, ...counters() },
    );
  }

  function watchAttempt() {
    if (stuckLogged || Date.now() - attemptStartedAt < STUCK_ATTEMPT_MS) return;
    stuckLogged = true;
    say('warn', 'captcha auto-solve attempt is taking long', `phase=${phase} ${stats()} t: ${timeline()}`, {
      phase,
      ...counters(),
      timeline: timelineData(),
    });
  }

  // Never throws: called on every poll of the watcher, without awaiting.
  async function tick() {
    if (finished) return;
    firstTickAt ??= Date.now();
    if (busy) return watchAttempt();

    const key = pictureKey();
    if (!key || !isDialogUp()) return watchIdle(); // the dialog is still being put together

    if (pending && key === pending.key) {
      if (Date.now() - pending.at > NO_REACTION_MS) {
        const what = pending.answer ? 'the answer was sent' : 'another picture was asked for';
        giveUp(`the same picture stayed up ${NO_REACTION_MS}ms after ${what}`);
      }
      return;
    }
    if (pending) settlePending(key);
    watchIdle();

    busy = true;
    try {
      await attempt(key);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        haltOnContextInvalidated();
      } else {
        await reportError('captcha', `auto-solve failed: ${error.message}`, `seq=${seq} ${stats()} t: ${timeline()}`);
        giveUp(`unexpected error: ${error.message}`, 'error');
      }
    } finally {
      busy = false;
    }
  }

  // The dialog has been gone long enough for the run to resume: an answer sent last was accepted.
  function onCleared() {
    if (pending?.answer && !finished) {
      accepted += 1;
      const activity = recentActivity(ACTIVITY_WINDOW_MS);
      say(
        'info',
        'captcha answer accepted',
        `answer="${pending.answer}" reactionMs=${Date.now() - pending.at} ${stats()} | ${activity}`,
        { key: pending.key, answer: pending.answer, reactionMs: Date.now() - pending.at, ...counters(), activity },
      );
    }
    pending = null;
  }

  // who cleared the captcha, as far as the solver can tell
  const outcome = () => {
    if (endedBy) return { by: 'person', why: endedBy };
    return submitted > 0 ? { by: 'auto', why: null } : { by: 'person', why: 'the solver never acted' };
  };
  const verdict = () => {
    const { by, why } = outcome();
    return why ? `${by} (${why})` : by;
  };

  return {
    tick,
    onCleared,
    verdict,
    outcome,
    counters,
    summary: stats,
    phase: () => phase,
    isFinished: () => finished,
    stop: () => finish('the captcha went away'),
  };
}
