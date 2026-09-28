import { callOpenRouter } from './llm.js';
import { reportError, reportWarning } from './diagnostics.js';
import { extractAnswer } from './captcha-answer.js';

// Reads a captcha picture with a vision model. Runs in the service worker, like every other LLM call: the
// page only sends the picture and gets the answer back.

// Picked by benchmarking 13 vision models on 20 real hh.ru captchas: 19 of 20 exact with this prompt for a
// fraction of a cent per picture — the best result among the cheap models and the best price per solved
// captcha overall. Replaceable in the settings.
export const DEFAULT_CAPTCHA_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';

// The prompt is the one the benchmark validated: the letter-by-letter transcription before the answer is
// what lifted this model from 75-80% to 95%. In English on purpose — that is what was measured.
const PROMPT =
  'This is a CAPTCHA image with 1-3 Russian (Cyrillic) words written in a bold font along a curved arc over a noisy background. ' +
  'The words are random and do not form a meaningful phrase, so do not autocorrect. ' +
  'First transcribe the letters one by one in reading order along the arc, splitting words where the gaps are. ' +
  'Then, on the last line, write exactly: ANSWER: <the words in lowercase separated by a single space>';

const REQUEST_TIMEOUT_MS = 45_000;
const TRANSIENT_RETRIES = 1; // a network hiccup, a 429 or a 5xx deserves one more try, not a queue of them
const RETRY_PAUSE_MS = 1500;

// A rejected key, an account out of credits, a model that doesn't exist or takes no images: every captcha
// would fail the same way, so for a while none is even sent. A different key or model is a fresh start.
const UNAVAILABLE_STATUSES = new Set([400, 401, 402, 403, 404]);
const UNAVAILABLE_COOLDOWN_MS = 5 * 60 * 1000;
let unavailable = null; // { setup, until, error }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves to { success: true, answer, metadata } or { success: false, kind, error, metadata? }, where
// `kind` tells the page what to do about it:
//  - 'unavailable': nothing will work until the settings change — leave the captcha to a person;
//  - 'unusable': the model answered, but not with words worth typing — ask hh.ru for another picture;
//  - 'transient': it did not answer (network, provider) — the same picture may be tried again.
export async function solveCaptcha({ apiKey, model, dataUrl }) {
  if (!apiKey?.trim()) return { success: false, kind: 'unavailable', error: 'API key is required' };

  const usedModel = model?.trim() || DEFAULT_CAPTCHA_MODEL;
  const setup = `${apiKey}|${usedModel}`;
  if (unavailable?.setup === setup && Date.now() < unavailable.until) {
    return { success: false, kind: 'unavailable', error: unavailable.error };
  }

  // What every outcome reports, so a diagnostic entry can say what the call did without a guess: how many
  // requests went out and why the earlier ones didn't count, what the whole thing cost (a reply that came
  // back empty is paid for too), which model really answered, why it stopped, the tail of what it said.
  const startedAt = Date.now();
  const retryReasons = [];
  const metadata = { model: usedModel, calls: 0, cost: 0, servedModel: null, tokens: null, finishReason: null };
  const report = () => ({ ...metadata, responseTime: Date.now() - startedAt, retryReasons: retryReasons.join(' ; ') });
  let lastError = '';

  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_PAUSE_MS);
    metadata.calls += 1;

    const result = await callOpenRouter({
      apiKey,
      model: usedModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      // the settings the benchmark ran with; `usage.include` makes the reply carry what the call cost
      extraBody: { temperature: 0, max_tokens: 2000, reasoning: { effort: 'low' }, usage: { include: true } },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!result.success) {
      lastError = result.error;
      retryReasons.push(result.error.replace(/\s+/g, ' ').slice(0, 160));
      if (UNAVAILABLE_STATUSES.has(result.status)) {
        unavailable = { setup, until: Date.now() + UNAVAILABLE_COOLDOWN_MS, error: result.error };
        await reportError('captcha', 'solver unavailable, captchas are left to a person for a while', result.error);
        return { success: false, kind: 'unavailable', error: result.error, metadata: report() };
      }
      continue;
    }

    const { usage } = result.metadata;
    metadata.cost += usage?.cost ?? 0;
    metadata.servedModel = result.metadata.model ?? null;
    metadata.tokens = usage ? `${usage.prompt_tokens}/${usage.completion_tokens}` : null;
    metadata.finishReason = result.data.finishReason ?? null;

    const content = result.data.content;
    if (!content?.trim()) {
      // a reasoning model can spend its whole budget thinking; `finish=length` in the entry says so
      lastError = `empty response (finish=${metadata.finishReason})`;
      retryReasons.push(lastError);
      continue;
    }

    const reply = content.replace(/\s+/g, ' ').slice(-300);
    const answer = extractAnswer(content);
    if (!answer) {
      const error = `unusable response: ${reply.slice(-120)}`;
      await reportWarning('captcha', error, `model=${usedModel} finish=${metadata.finishReason}`);
      return { success: false, kind: 'unusable', error, metadata: { ...report(), reply } };
    }
    return { success: true, answer, metadata: { ...report(), reply } };
  }

  const failure = `solver failed after ${TRANSIENT_RETRIES + 1} tries: ${lastError}`;
  await reportError('captcha', failure, `model=${usedModel}`);
  return { success: false, kind: 'transient', error: lastError, metadata: report() };
}
