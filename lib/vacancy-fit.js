import { callJev } from './jev.js';

// "Does this vacancy suit the candidate?" asked of Jev about a card of the search results.
//
// The model returns a probability, not a verdict: turning it into one is `isFit` with a threshold, kept
// apart on purpose — the threshold is tuned after the answers are in, and moving it costs no request.

const REQUEST_TIMEOUT_MS = 20_000;

// A rejected key, an account out of credits, a model that doesn't exist: every vacancy would fail the same
// way, so a caller going through many of them should stop at the first (same set as the captcha solver's)
const UNAVAILABLE_STATUSES = new Set([400, 401, 402, 403, 404]);

// the fixed part of every question; the person's own text follows it
export const FIT_QUESTION = 'Подходит ли эта вакансия соискателю? Соискатель:';

const FIT_CRITERIA = {
  true: 'Вакансия подходит соискателю',
  false: 'Вакансия не подходит соискателю',
};

// What the model sees of a vacancy: everything its card holds, and nothing is chosen at run time. A card of
// the compact search view carries the title, company, place, experience and work format; one of the expanded
// view adds the two snippets (responsibilities, requirements) — that is what decides most cases, a title like
// "Project Manager" says little about whether the work is in IT. So whichever view the person has switched on
// is what gets sent: a compact card simply has no snippets. English keys, as the model is said to read English
// best; empty facts are left out rather than sent as blanks.
export function buildVacancyState({
  title,
  company,
  location,
  experience,
  workFormat,
  responsibilities,
  requirements,
}) {
  const facts = {
    title,
    company,
    location,
    experience,
    work_format: workFormat,
    responsibilities,
    requirements,
  };
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value?.trim()));
}

// `prompts` is `{ key: text }`, the text being what the person writes about themselves ("I want to be a
// project manager of an IT product, not a regional sales manager"). Several prompts go out in ONE request
// as several questions about the same vacancy, so prompt variants can be compared side by side for the
// price of one call.
export function buildFitQuestions(prompts) {
  return Object.fromEntries(
    Object.entries(prompts).map(([key, prompt]) => [
      key,
      {
        type: 'noul',
        instructions: `${FIT_QUESTION} ${prompt.trim()}`,
        criteria: FIT_CRITERIA,
      },
    ]),
  );
}

// { key: probability } for every key asked, or null when any answer is missing or not a probability
export function parseFitAnswers(answers, keys) {
  const probabilities = {};
  for (const key of keys) {
    const probability = answers?.[key]?.noul;
    if (typeof probability !== 'number' || probability < 0 || probability > 1) return null;
    probabilities[key] = probability;
  }
  return probabilities;
}

export const isFit = (probability, threshold) => probability >= threshold;

// Resolves to { success: true, probabilities: { key: probability }, request, metadata } or { success: false,
// kind, error, request? }, where `kind` is 'unavailable' (nothing will work until the key, balance or model
// changes), 'invalid' (the request itself is wrong) or 'transient' (the same request may be tried again).
// `request` is exactly what was sent ({ state, questions }); it is absent only when nothing was sent.
export async function judgeVacancy({ apiKey, vacancy, prompts }) {
  if (!apiKey?.trim()) return { success: false, kind: 'unavailable', error: 'API key is required' };

  const keys = Object.keys(prompts || {});
  if (keys.length === 0 || keys.some((key) => !prompts[key]?.trim())) {
    return { success: false, kind: 'invalid', error: 'A non-empty prompt is required' };
  }
  const state = buildVacancyState(vacancy);
  if (!state.title) return { success: false, kind: 'invalid', error: 'The vacancy has no title' };

  const request = { state, questions: buildFitQuestions(prompts) };
  const startedAt = Date.now();
  const result = await callJev({ apiKey, ...request, timeoutMs: REQUEST_TIMEOUT_MS });

  if (!result.success) {
    const kind = UNAVAILABLE_STATUSES.has(result.status) ? 'unavailable' : 'transient';
    return { success: false, kind, error: result.error, request };
  }

  const probabilities = parseFitAnswers(result.data.answers, keys);
  if (!probabilities) {
    return {
      success: false,
      kind: 'transient',
      error: `unusable answers: ${JSON.stringify(result.data.answers)}`,
      request,
    };
  }

  const { usage } = result.metadata;
  return {
    success: true,
    probabilities,
    request,
    metadata: {
      model: result.metadata.model,
      cost: usage?.cost ?? 0,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      responseTime: Date.now() - startedAt,
    },
  };
}
