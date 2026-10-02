import { matchesWordGroups } from './matching.js';

// The rules that decide for free whether the bot takes a card, in the order they are checked. The classifier's own
// step comes after them (fit-step.js), because it costs money.
export const SkipReason = {
  PROCESSED: 'processed', // already dealt with on this page
  BLACKLISTED: 'blacklisted',
  COMPANY: 'company',
  TITLE_STOP_WORD: 'title_stop_word',
};

// Why the card is passed over, or null when it is a candidate for a response. `rules` holds what the rules look
// at: the vacancies already processed on this page, the blacklisted ones, the word groups of the company blacklist
// and of the title stop words.
export function skipReasonOf(card, { processed, blockedIds, companyLines, titleStopWordLines }) {
  if (processed.has(card.vacancyId)) return SkipReason.PROCESSED;
  if (blockedIds.has(card.vacancyId)) return SkipReason.BLACKLISTED;
  if (matchesWordGroups(card.company, companyLines)) return SkipReason.COMPANY;
  if (matchesWordGroups(card.title, titleStopWordLines)) return SkipReason.TITLE_STOP_WORD;
  return null;
}
