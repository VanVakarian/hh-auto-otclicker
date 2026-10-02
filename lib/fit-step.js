import { isFit } from './vacancy-fit.js';
import { fitRejectionEntry } from './blacklist-core.js';

// The classifier's step of choosing a card: should the bot respond to this vacancy, judging by the model's idea
// of whether it suits the person. Knows neither the network nor the storage — the question goes out through `ask`,
// what the caller has to write comes back as data.

// The diagnostic trace the caller writes for every vacancy the classifier was asked about; its `data` is the
// vacancy's id, title and company, the probability, the verdict (a FitAction) and the price. The panel's feed
// and the report's summary are made from it.
export const FIT_RATED_TRACE = 'card rated by the classifier';

export const FitAction = {
  RESPOND: 'respond',
  SKIP: 'skip', // the vacancy does not suit; `entry` is what to add to the blacklist (not for a known rejection)
  UNRATED: 'unrated', // no verdict for this vacancy; the card is passed over for this page only
  STOPPED: 'stopped', // the run was stopped before the question was asked
  UNAVAILABLE: 'unavailable', // no card will be rated until something changes; the run has to stop
};

export const UnavailableReason = {
  SERVICE: 'service', // the key, the balance or the model is refused
  UNRESPONSIVE: 'unresponsive', // too many failures in a row
};

// The service is taken for down after this many failures with no answer in between: otherwise a run on a dead
// network would go through the whole search passing over every vacancy
export const MAX_FAILURES_IN_A_ROW = 5;

// `ask(card)` resolves to { success: true, probability, cost, ms } or { success: false, kind, error }, where `kind`
// is 'unavailable', 'invalid', 'transient' (the same question may work later) or 'skipped' (the run is not going).
//
// The returned function judges one card. `rejections` holds the classifier's earlier rejections by vacancy (see
// blacklist-core.js): a vacancy in there is not asked about again, the probability it was rejected with is judged
// by today's threshold. One vacancy not in there is one request; a vacancy that suits leaves no trace, the button
// of a vacancy responded to is gone from the page.
export function createFitStep() {
  let failuresInARow = 0;

  return async function judge({ card, rejections, threshold, fingerprint, ask, now = Date.now() }) {
    const known = rejections.get(card.vacancyId);
    if (known) {
      return { action: isFit(known.probability, threshold) ? FitAction.RESPOND : FitAction.SKIP, known: true };
    }

    // nothing to ask about, and not the service's fault
    if (!card.title) return { action: FitAction.UNRATED, reason: 'no title' };

    const answer = (await ask(card)) ?? { success: false, kind: 'transient', error: 'no answer' };

    if (answer.success) {
      failuresInARow = 0;
      const { probability, cost, ms } = answer;
      const fits = isFit(probability, threshold);
      return {
        action: fits ? FitAction.RESPOND : FitAction.SKIP,
        probability,
        cost,
        ms,
        entry: fits ? null : fitRejectionEntry({ card, probability, fingerprint, now }),
      };
    }

    if (answer.kind === 'skipped') return { action: FitAction.STOPPED };
    if (answer.kind === 'unavailable') {
      return { action: FitAction.UNAVAILABLE, reason: UnavailableReason.SERVICE, error: answer.error };
    }
    if (answer.kind === 'invalid') return { action: FitAction.UNRATED, reason: 'invalid', error: answer.error };

    failuresInARow += 1;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      return { action: FitAction.UNAVAILABLE, reason: UnavailableReason.UNRESPONSIVE, error: answer.error };
    }
    return { action: FitAction.UNRATED, reason: 'transient', error: answer.error };
  };
}
