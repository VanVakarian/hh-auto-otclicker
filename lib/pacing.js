export function randomDelayMs(minSec, maxSec) {
  const min = Math.max(0, Number(minSec) || 0);
  const max = Math.max(min, Number(maxSec) || min);
  const seconds = min + Math.random() * (max - min);
  return Math.round(seconds * 1000);
}
