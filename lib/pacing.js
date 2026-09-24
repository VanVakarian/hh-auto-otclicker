export function randomDelayMs(minSec, maxSec) {
  const min = Math.max(0, Number(minSec) || 0);
  const max = Math.max(min, Number(maxSec) || min);
  const seconds = min + Math.random() * (max - min);
  return Math.round(seconds * 1000);
}

const REACTION_MIN_SEC = 1;
const REACTION_MAX_SEC = 2;

// A person needs a moment to notice something that just appeared (a confirmation dialog, a popup they
// have decided to dismiss) before answering it. For places where the bot reacts to the page rather than
// to its own schedule — those have no user-set pause of their own, and must never answer instantly.
export function reactionDelayMs() {
  return randomDelayMs(REACTION_MIN_SEC, REACTION_MAX_SEC);
}
