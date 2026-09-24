import { KEYS, getRunState } from './storage.js';

// Stop needs to interrupt the human-like pauses themselves, not just get checked once per
// vacancy — otherwise pressing Stop mid-pause still waits out the rest of that multi-second
// delay before anything reacts. The status is mirrored locally from storage change events, so a
// wait costs one timer instead of a storage read every few hundred milliseconds.

let running = null; // null until the first read resolves — a change event may land before it does
let firstRead = null;
const stopListeners = new Set();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[KEYS.RUN_STATE]) return;
  running = changes[KEYS.RUN_STATE].newValue?.status === 'running';
  if (!running) stopListeners.forEach((listener) => listener());
});

// Returns false the moment a stop is seen, so the caller can bail before taking the action the
// pause was leading up to (a click, a submit).
export async function sleepUnlessStopped(ms) {
  firstRead ??= getRunState().then((state) => {
    running ??= state.status === 'running';
  });
  await firstRead;
  if (!running) return false;

  return new Promise((resolve) => {
    const finish = (completed) => {
      clearTimeout(timer);
      stopListeners.delete(onStop);
      resolve(completed);
    };
    const onStop = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    stopListeners.add(onStop);
  });
}
