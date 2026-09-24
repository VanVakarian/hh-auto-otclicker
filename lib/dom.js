import { activeNow, untilResumed } from './run-control.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run-aware, like everything that waits on the bot's behalf: time the run spends held (a captcha on
// screen) doesn't count against the timeout, and the page is never judged while held — the predicate
// only runs when nothing is blocking, so it can't misread the blocker as an outcome. It may be async.
export async function waitFor(predicate, { timeout = 5000, interval = 200 } = {}) {
  const start = activeNow();
  while (activeNow() - start < timeout) {
    await untilResumed();
    const result = await predicate();
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

export function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}
