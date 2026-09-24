// Chrome invalidates every chrome.* call in an already-loaded content script the moment the
// extension itself is reloaded/updated (routine during dev) — the tab keeps running old JS with
// no way back into the extension, and this is the one error message Chrome uses for that state.
export function isContextInvalidatedError(error) {
  return typeof error?.message === 'string' && error.message.includes('Extension context invalidated');
}

let invalidated = false;
const invalidationListeners = new Set();

export function isContextInvalidated() {
  return invalidated;
}

// each content script registers whatever it needs to stop (observers, poll timers, a console hint) —
// once the context is gone there is no recovery path short of reloading the page, so everything
// stops instead of retrying forever and re-failing on every single DOM mutation
export function onContextInvalidated(listener) {
  invalidationListeners.add(listener);
}

export function haltOnContextInvalidated() {
  if (invalidated) return;
  invalidated = true;
  invalidationListeners.forEach((listener) => listener());
}
