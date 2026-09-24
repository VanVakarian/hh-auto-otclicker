// The one door between the bot's flow code and the hh.ru page. Flow code says WHAT to do to an
// element — click it, scroll to it, fill it — and never HOW the events get produced: no coordinates,
// no event objects, nothing about whatever delivers them. Anything that touches the page on the
// bot's behalf goes through here, so the delivery mechanism can change without a single call site
// in the flows changing.

import { sleep } from './dom.js';
import { untilResumed } from './run-control.js';

const SCROLL_SETTLE_POLL_MS = 80;
const SCROLL_SETTLE_MAX_POLLS = 20;
const MIN_ACTION_GAP_MS = 1000;

// The target can't be acted on right now (not visible, covered by something else) — a flow may
// handle this, e.g. skip the vacancy through its existing "click did not register" path.
export class TargetUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetUnavailableError';
  }
}

// The channel that delivers input is unusable — fatal for the run, it stops with this as the reason.
export class InputChannelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputChannelError';
  }
}

// One action at a time: a measure-then-act pair must never be split by another action's events
// (hh.ru's chat widget, for one, gets closed from a MutationObserver that can fire at any moment).
// Every action also waits its turn while the run is held (a captcha on screen) — being the only door,
// this is what guarantees the bot never touches a page it has been told to leave alone.
//
// `spaced` actions (every click and every fill) are also never closer together than MIN_ACTION_GAP_MS,
// whatever the caller did or didn't wait for before them. Flows have their own human-sized pauses;
// this floor is the guarantee underneath: a reply that an LLM produced in 300 ms, a dialog that
// appeared and was answered in the same tick, two buttons found by one scan — none of it can turn into
// a burst of presses no hand could make. Longer is always fine, shorter never happens.
let queueTail = Promise.resolve();
let lastSpacedActionEndedAt = 0;

async function keepMinimumGap() {
  const wait = lastSpacedActionEndedAt + MIN_ACTION_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

function enqueue(action, { spaced = false } = {}) {
  const result = queueTail.then(async () => {
    if (spaced) await keepMinimumGap();
    // after the gap, not before: a hold that began while waiting must still stop the action
    await untilResumed();
    try {
      return await action();
    } finally {
      if (spaced) lastSpacedActionEndedAt = Date.now();
    }
  });
  queueTail = result.catch(() => {});
  return result;
}

// A person only acts on what they can see: anything the bot is about to click or fill is scrolled
// into the visible part of the page first (a smooth scroll, waited out until the element stops
// moving), so no call site has to remember to do it — and an element already in view costs nothing.
async function revealElement(element) {
  const { top, bottom } = element.getBoundingClientRect();
  if (top >= 0 && bottom <= window.innerHeight) return;

  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  let lastTop = null;
  for (let i = 0; i < SCROLL_SETTLE_MAX_POLLS; i++) {
    const currentTop = element.getBoundingClientRect().top;
    if (currentTop === lastTop) return;
    lastTop = currentTop;
    await sleep(SCROLL_SETTLE_POLL_MS);
  }
}

export function click(element) {
  return enqueue(
    async () => {
      await revealElement(element);
      element.click();
    },
    { spaced: true },
  );
}

export function scrollToElement(element) {
  return enqueue(() => element.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

// React-controlled textarea: the value has to arrive together with the events React listens for
export function fillText(element, text) {
  return enqueue(
    async () => {
      await revealElement(element);
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { spaced: true },
  );
}
