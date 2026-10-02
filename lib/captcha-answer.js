// What a model's reply to a captcha has to look like before anything is typed into hh.ru's dialog. Kept
// free of any extension API so it can be tested on its own (captcha-answer.test.mjs).
//
// hh.ru's captcha pictures carry one to three Russian words in lowercase. A reply that is anything else —
// Latin letters, digits, a sentence, an apology — is not a guess worth submitting: a wrong answer costs
// an attempt and looks like a bot, so such a reply is treated as no answer at all.

const ANSWER_MARKER = /ANSWER:\s*(.+)/gi;
const WORD = '[а-яё]+(?:-[а-яё]+)*';
const ANSWER_PATTERN = new RegExp(`^${WORD}(?: ${WORD}){0,3}$`);
const MAX_ANSWER_LENGTH = 60;

// The answer is the last "ANSWER: ..." line — the prompt asks for a letter-by-letter transcription first,
// so anything before the marker is working, not the result. null when there is no usable answer.
export function extractAnswer(content) {
  const marked = [...(content ?? '').matchAll(ANSWER_MARKER)].at(-1);
  if (!marked) return null;

  const answer = marked[1]
    .replace(/[`*"'«»“”]/g, '')
    .replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  return answer.length <= MAX_ANSWER_LENGTH && ANSWER_PATTERN.test(answer) ? answer : null;
}

const NOT_A_LETTER = /[^а-яё]/g;

// What the model read letter by letter before it wrote its answer, as bare lowercase letters; null when it
// wrote nothing of the kind. The log keeps it next to the answer: the two disagreeing means the model
// corrected its own reading toward a word it knew — the very thing the prompt forbids.
export function transcriptOf(content) {
  const text = content ?? '';
  const marked = [...text.matchAll(ANSWER_MARKER)].at(-1);
  const letters = (marked ? text.slice(0, marked.index) : '').toLowerCase().replace(NOT_A_LETTER, '');
  return letters === '' ? null : letters;
}

// whether the answer is what was transcribed: true/false, null when there was no transcription to compare with
export function agreesWithTranscript(transcript, answer) {
  if (transcript === null) return null;
  return transcript === answer.toLowerCase().replace(NOT_A_LETTER, '');
}
