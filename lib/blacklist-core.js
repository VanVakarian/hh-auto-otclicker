// The vacancy blacklist: one list of `{ vacancyId, title, company, reason, at }` — the vacancies the bot does not
// take. Pure functions over its entries; where the list lives is storage.js.
//
// A reason is either about the vacancy itself (a questionnaire the bot can't answer, a popup it can't pass, a
// manual skip) — such an entry holds for good — or the classifier's rejection. A rejection is a verdict as of
// today's settings, so it is kept with what it was made by and how sure the model was (`fingerprint`,
// `probability`), and counts only while the question is the same and the probability is still under the threshold.

export const FIT_REJECTED = 'fit_rejected';

// By then the vacancy is closed, and asking again costs a fraction of a kopeck
export const FIT_REJECTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const isFitRejection = (entry) => entry.reason === FIT_REJECTED;

export function fitRejectionEntry({ card, probability, fingerprint, now }) {
  return {
    vacancyId: card.vacancyId,
    title: card.title,
    company: card.company,
    reason: FIT_REJECTED,
    probability,
    fingerprint,
    at: now,
  };
}

// the vacancies that are out whatever the classifier thinks of them
export const blockedIds = (entries) =>
  new Set(entries.filter((entry) => !isFitRejection(entry)).map((entry) => entry.vacancyId));

// the rejections made by this very question, by vacancy; the latest of a vacancy's wins
export function fitRejections(entries, fingerprint) {
  const byVacancy = new Map();
  for (const entry of entries) {
    if (isFitRejection(entry) && entry.fingerprint === fingerprint) byVacancy.set(entry.vacancyId, entry);
  }
  return byVacancy;
}

// What stays in the list: every entry of the vacancy's own reasons, and of the classifier's rejections the fresh ones
// made by the current question
export function pruneBlacklist(entries, { fingerprint, now }) {
  return entries.filter(
    (entry) =>
      !isFitRejection(entry) || (entry.fingerprint === fingerprint && now - entry.at <= FIT_REJECTION_TTL_MS),
  );
}
