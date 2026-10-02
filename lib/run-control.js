import { KEYS, addTraceEntry, getRunState, saveRunPause } from './storage.js';
import { isContextInvalidatedError, haltOnContextInvalidated } from './extension-context.js';
import { reportError } from './diagnostics.js';

// Whether the bot may act on this page right now — the one place that answers it.
//
// Two things can say "not now". Stop: the run status in storage stops being 'running'; it's mirrored
// here from storage change events, so a wait costs one timer instead of a storage read every few
// hundred milliseconds, and a Stop interrupts even a multi-second pause instantly. Hold: something on
// THIS page that only a human can clear (a captcha) — the watcher that sees it takes a hold on the
// document and the same watcher releases it. A hold is a fact about this document, not run state, so it
// takes effect in the very tick the page changed, with no storage round trip a flow step could slip
// through; the pause shown in the sidepanel is published from it, never the other way around.
//
// Everything that waits or acts on the bot's behalf goes through one of the checkpoints below (the
// interaction door — clicks, fills, scrolls and navigate, the only way the bot leaves a page — plus
// waitFor and sleepUnlessStopped), so no flow has to remember to ask. The one thing outside this
// document's reach is a page without our scripts: the service worker's stray-tab recovery waits on
// its own (background.js).

let running = null; // null until the first read resolves — a change event may land before it does
let firstRead = null;
const holds = new Set();
const changeListeners = new Set(); // called whenever `running` or `holds` changes
let heldSince = null;
let heldTotalMs = 0;

// The run was stopped while this wait was blocked by a hold. Flows treat it like any other "stopped"
// early return: unwind quietly, the page stays as it is.
export class RunStoppedError extends Error {
  constructor() {
    super('run stopped while waiting');
    this.name = 'RunStoppedError';
  }
}

export function isRunStoppedError(error) {
  return error instanceof RunStoppedError;
}

function statusKnown() {
  firstRead ??= getRunState().then((state) => {
    running ??= state.status === 'running';
  });
  return firstRead;
}

function notifyChange() {
  [...changeListeners].forEach((listener) => listener());
}

function nextChange() {
  return new Promise((resolve) => {
    const listener = () => {
      changeListeners.delete(listener);
      resolve();
    };
    changeListeners.add(listener);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[KEYS.RUN_STATE]) return;
  const wasRunning = running;
  running = changes[KEYS.RUN_STATE].newValue?.status === 'running';
  if (running !== wasRunning) notifyChange();
});

// what the sidepanel and the badge show — informational only, so it's coalesced through a chain and
// always written from the holds as they are at write time; nothing here is ever read back to decide
// anything. Skipped when no run is going: a person browsing by hand who meets a captcha isn't a pause.
let publishing = Promise.resolve();

function publishPause() {
  publishing = publishing
    .then(async () => {
      await statusKnown();
      if (running) await saveRunPause([...holds]);
    })
    .catch((error) => {
      if (isContextInvalidatedError(error)) haltOnContextInvalidated();
      else reportError('run-control', `failed to publish pause: ${error.message}`);
    });
}

// The start and the end of every hold, whatever held: a stretch of the run where nothing happened has either
// a hold here to explain it or none — which says it was something else.
function logHold(message, context, data) {
  ifStillRunning(() => addTraceEntry('run-control', message, context, data)).catch(() => {});
}

function onHoldsChanged() {
  if (holds.size > 0 && heldSince === null) {
    heldSince = Date.now();
    const reasons = [...holds];
    logHold('run held', `reasons=${reasons.join(',')} page=${location.pathname}`, { reasons, page: location.pathname });
  } else if (holds.size === 0 && heldSince !== null) {
    const heldMs = Date.now() - heldSince;
    heldTotalMs += heldMs;
    heldSince = null;
    logHold('run released', `heldMs=${heldMs} page=${location.pathname}`, { heldMs, page: location.pathname });
  }
  notifyChange();
  publishPause();
}

// for code that reacts to the page from outside the flows (watchers): runs `action` only while a run is
// going, and lets a Stop that lands mid-action pass quietly
export async function ifStillRunning(action) {
  try {
    const runState = await getRunState();
    if (runState.status !== 'running') return;
    await action();
  } catch (error) {
    if (isContextInvalidatedError(error)) haltOnContextInvalidated();
    else if (!isRunStoppedError(error)) throw error;
  }
}

export function holdRun(reason) {
  holds.add(reason);
  onHoldsChanged();
}

export function releaseRun(reason) {
  holds.delete(reason);
  onHoldsChanged();
}

// A clock that stands still while the run is held. Timeouts measured on it never expire because a
// human took their time with a captcha — a plain Date.now() deadline would, and the flow would
// declare its vacancy failed under the very dialog it was waiting out.
export function activeNow() {
  return (heldSince ?? Date.now()) - heldTotalMs;
}

// sleepUnlessStopped for places nested too deep to bail out with a return value (inside a poll
// predicate, say): a Stop unwinds as RunStoppedError instead, so what follows the pause never happens
export async function humanPause(ms) {
  if (!(await sleepUnlessStopped(ms))) throw new RunStoppedError();
}

// Resolves at once unless this document is held during a run; then resolves when every hold is gone.
// A person driving the page by hand (no run going) is never blocked. Throws RunStoppedError when the
// run is stopped while blocked: whatever the caller was about to do must not happen after a Stop.
export async function untilResumed() {
  if (holds.size === 0) return;
  await statusKnown();
  if (!running) return;

  while (holds.size > 0) {
    await nextChange();
    if (!running) throw new RunStoppedError();
  }
}

// Stop needs to interrupt the human-like pauses themselves, not just get checked once per
// vacancy — otherwise pressing Stop mid-pause still waits out the rest of that multi-second
// delay before anything reacts.
//
// Returns false the moment a stop is seen, so the caller can bail before taking the action the
// pause was leading up to (a click, a submit). The pause is wall-clock time: if a hold appeared while
// it ran, the wait carries on until the hold is gone, so what follows never happens under a captcha.
export async function sleepUnlessStopped(ms) {
  await statusKnown();
  if (!running) return false;

  const completed = await new Promise((resolve) => {
    const finish = (done) => {
      clearTimeout(timer);
      changeListeners.delete(onChange);
      resolve(done);
    };
    const onChange = () => {
      if (!running) finish(false);
    };
    const timer = setTimeout(() => finish(true), ms);
    changeListeners.add(onChange);
  });
  if (!completed) return false;

  try {
    await untilResumed();
    return true;
  } catch (error) {
    if (isRunStoppedError(error)) return false;
    throw error;
  }
}
