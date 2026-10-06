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
// this is what guarantees the bot never touches a page it has been told to leave alone. Leaving the page
// is one of those actions (navigate): the flow's next page must never be reached from under a captcha.
//
// `spaced` actions (every click and every fill) are also never closer together than MIN_ACTION_GAP_MS,
// whatever the caller did or didn't wait for before them. Flows have their own human-sized pauses;
// this floor is the guarantee underneath: a reply that an LLM produced in 300 ms, a dialog that
// appeared and was answered in the same tick, two buttons found by one scan — none of it can turn into
// a burst of presses no hand could make. Longer is always fine, shorter never happens.
//
// The one exception to the hold is the captcha's own auto-solver (`underHold`): the hold is waiting for
// exactly what it does. Its actions run on a queue of their own, because the main one can be parked
// inside an action that is waiting for the hold to end — anything queued behind that would never run.
// The two queues share the minimum gap, so the floor holds for the bot as a whole.
let queueTail = Promise.resolve();
let underHoldQueueTail = Promise.resolve();
let lastSpacedActionEndedAt = 0;

async function keepMinimumGap() {
  const wait = lastSpacedActionEndedAt + MIN_ACTION_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

function enqueue(action, { spaced = false, underHold = false } = {}) {
  const previous = underHold ? underHoldQueueTail : queueTail;
  const result = previous.then(async () => {
    if (spaced) await keepMinimumGap();
    // after the gap, not before: a hold that began while waiting must still stop the action
    if (!underHold) await untilResumed();
    try {
      return await action();
    } finally {
      if (spaced) lastSpacedActionEndedAt = Date.now();
    }
  });
  const settled = result.catch(() => {});
  if (underHold) underHoldQueueTail = settled;
  else queueTail = settled;
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

export function click(element, { underHold = false } = {}) {
  return enqueue(
    async () => {
      await revealElement(element);
      element.click();
    },
    { spaced: true, underHold },
  );
}

export function scrollToElement(element) {
  return enqueue(() => element.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

// hh.ru fills in the rest of a list (more vacancies, the pager) as the page is scrolled to its end
export function scrollToPageBottom() {
  return enqueue(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
}

// The only way the bot changes the page's URL. A navigation destroys this document — and with it the
// hold that stood between the bot and the captcha — so it has to be decided while nothing holds the run,
// not merely started from a flow that was running a moment ago. `replace` keeps a dead end (a submitted
// questionnaire, a stray detour) out of the browser history.
export function navigate(url, { replace = false } = {}) {
  return enqueue(() => (replace ? location.replace(url) : location.assign(url)));
}

// Reloads the page: what a person does when hh.ru's dialog stops answering. Like navigate it destroys this
// document, so it is only ever the captcha solver's (`underHold`) — nothing else may leave a held page.
export function reloadPage({ underHold = false } = {}) {
  return enqueue(() => location.reload(), { spaced: true, underHold });
}

// React-controlled field: the value has to arrive together with the events React listens for. React
// remembers the last value it saw in a setter of its own on the element; assigning `element.value` goes
// through that one, so the following `input` event looks like "nothing changed" and is ignored. The setter
// of the element's prototype bypasses it, which makes the change visible to React.
function setValue(element, text) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, text);
}

export function fillText(element, text, { underHold = false } = {}) {
  return enqueue(
    async () => {
      await revealElement(element);
      setValue(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { spaced: true, underHold },
  );
}
