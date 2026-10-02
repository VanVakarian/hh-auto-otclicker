import { buildVacancyState } from './vacancy-fit.js';

// The history of the classifier's decisions: one entry per vacancy it was asked about, whichever way it went — the
// blacklist remembers only the rejections, and only for as long as they count. Kept to be read by a person (the
// history page), so an entry holds what is needed to see the decision afresh: the answer, the threshold it was
// judged by, and the card as it went to the model (`state`, see buildVacancyState). Whether it passed is not stored:
// it is the probability against that threshold.

// A card is about a kilobyte, so this is half a megabyte at most
export const FIT_HISTORY_LIMIT = 500;

export function fitHistoryEntry({ card, probability, threshold, cost, ms, now }) {
  return { at: now, vacancyId: card.vacancyId, probability, threshold, cost, ms, state: buildVacancyState(card) };
}

// the entries oldest first, the newest last; what is over the limit is the oldest and goes
export const appendFitHistory = (entries, entry) => [...entries, entry].slice(-FIT_HISTORY_LIMIT);
