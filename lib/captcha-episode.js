// What happened during one captcha episode (the dialog up, through every wrong answer and new picture),
// kept as one record, picture by picture: when each appeared, what the model read, who typed and who
// pressed the button, with what text, and what hh.ru said. Written by the watcher (captcha-watcher.js) and
// the auto-solver (captcha-autosolve.js) as things happen; read once, when the episode ends, as the summary
// that goes to the diagnostic log. Free of any browser API so it can be tested on its own
// (captcha-episode.test.mjs); the clock is passed in for the same reason.
//
// Every time in a summary is milliseconds since the dialog first appeared.

export function createEpisode({ doc, seq, shownAt, now = Date.now }) {
  const pictures = new Map();
  const since = (at) => at - shownAt;

  function pictureOf(key) {
    if (!pictures.has(key)) {
      pictures.set(key, {
        key,
        seenMs: null, // the first moment the watcher saw this picture in the dialog
        readyMs: null, // the first moment it had finished loading
        firstKeystrokeMs: null, // the first key a person pressed in the field
        keystrokes: 0,
        model: [],
        submissions: [],
        renewedBy: null,
        handover: null,
      });
    }
    return pictures.get(key);
  }

  return {
    seen(key) {
      const picture = pictureOf(key);
      picture.seenMs ??= since(now());
    },

    ready(key) {
      const picture = pictureOf(key);
      picture.readyMs ??= since(now());
    },

    // how long the picture has been up, null when it was never seen
    pictureAgeMs(key) {
      const seenMs = pictures.get(key)?.seenMs;
      return seenMs === null || seenMs === undefined ? null : since(now()) - seenMs;
    },

    // a key pressed by a person; true for the first one on this picture
    typed(key) {
      const picture = pictureOf(key);
      picture.keystrokes += 1;
      if (picture.firstKeystrokeMs !== null) return false;
      picture.firstKeystrokeMs = since(now());
      return true;
    },

    // one model call about this picture: { attempt, answer, transcript, agrees, ms, costUsd, result }
    modelAnswered(key, info) {
      pictureOf(key).model.push({ ...info, atMs: since(now()) });
    },

    // The button pressed (or Enter) with `text` in the field. `by` is 'extension' or 'person'; a person
    // pressing the button over the model's own answer is told apart from one who typed their own.
    submitted(key, { by, text, via }) {
      const picture = pictureOf(key);
      const record = {
        by,
        via,
        text,
        textFromModel: picture.model.some((reading) => reading.answer === text),
        at: now(),
        atMs: since(now()),
        verdict: null,
        verdictMs: null,
      };
      picture.submissions.push(record);
      return record;
    },

    // hh.ru's verdict on the last submission of this picture that has none yet — 'accepted' or 'rejected';
    // returns it, or null when there is nothing left to judge
    verdict(key, verdict) {
      const record = pictures.get(key)?.submissions.findLast((submission) => submission.verdict === null);
      if (!record) return null;
      record.verdict = verdict;
      record.verdictMs = since(now());
      return record;
    },

    // a submission that has no verdict yet, whoever made it
    pendingSubmission(key) {
      return pictures.get(key)?.submissions.findLast((submission) => submission.verdict === null) ?? null;
    },

    // the auto-solver stopped on this picture and left it to a person
    handedOver(key, reason) {
      pictureOf(key).handover = { reason, atMs: since(now()) };
    },

    renewed(key, by) {
      pictureOf(key).renewedBy = by;
    },

    // `solvedBy`: 'auto' / 'person' / null while it is not known; `endedBy`: 'cleared' or what cut it short
    summary({ solvedBy, endedBy, vacancyId, flow }) {
      const list = [...pictures.values()];
      const submissions = list.flatMap((picture) => picture.submissions);
      const readings = list.flatMap((picture) => picture.model);

      return {
        doc,
        seq,
        vacancyId: vacancyId ?? null,
        flow,
        shownAt,
        heldMs: since(now()),
        solvedBy,
        endedBy,
        pictures: list.map(({ submissions: own, ...picture }) => ({
          ...picture,
          submissions: own.map(({ at, ...rest }) => rest),
        })),
        totals: {
          pictures: list.length,
          modelCalls: readings.length,
          // the prices are fractions of a cent: summed in whole millionths of a cent, not floating dust
          modelCostUsd: Math.round(readings.reduce((total, reading) => total + (reading.costUsd ?? 0), 0) * 1e8) / 1e8,
          submittedByExtension: submissions.filter((record) => record.by === 'extension').length,
          submittedByPerson: submissions.filter((record) => record.by === 'person').length,
          accepted: submissions.filter((record) => record.verdict === 'accepted').length,
          rejected: submissions.filter((record) => record.verdict === 'rejected').length,
          unresolved: submissions.filter((record) => record.verdict === null).length,
        },
      };
    },
  };
}
