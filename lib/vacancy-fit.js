import { callJev, JEV_MODEL } from './jev.js';
import { hashText } from './hash.js';

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

// What the person is likely to want first; every word of it is theirs to change
export const DEFAULT_FIT_PROMPT =
  'Хочет быть менеджером проекта или продукта в разработке софта: веб-сервисы, мобильные приложения, SaaS, ' +
  'внутренние платформы. Не подходит всё, что не про создание софтверного продукта: внедрение и сопровождение 1С, ' +
  'ERP и SAP, ИТ-сервис и ITSM внутри нефтегазовой, мебельной или любой другой не софтверной компании, колл-центры, ' +
  'маркетинг, SMM, продажи, стройка, производство, товары (обувь, одежда, БАДы, еда), логистика, мероприятия.';

export const DEFAULT_FIT_THRESHOLD = 0.5;

// Which question an answer belongs to: the model, the fixed part of the question and the person's own text. An
// answer given to another question says nothing about this one, so whatever carries a different fingerprint is
// not taken for an answer — after the prompt is edited, or an update brings a new model or wording.
export const fitFingerprint = (prompt) => hashText(`${JEV_MODEL}|${FIT_QUESTION}|${(prompt ?? '').trim()}`);

// Why a run with the classifier switched on cannot begin; an empty string when it can
export function fitSetupProblem(settings) {
  if (!settings.fitEnabled) return '';
  if (!settings.apiKey?.trim()) return 'Отбор по Jev включён, но не задан API-ключ OpenRouter.';
  if (!settings.fitPrompt?.trim()) return 'Отбор по Jev включён, но не задан промпт.';
  return '';
}

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

// One vacancy against the person's own prompt, in the shape a run needs: { success: true, probability, cost, ms }
// or { success: false, kind, error } with the kinds of judgeVacancy. A prompt that is not there fails the way a
// missing key does — every vacancy would fail with it, so 'unavailable'.
export async function rateVacancy({ apiKey, prompt, vacancy }) {
  if (!prompt?.trim()) return { success: false, kind: 'unavailable', error: 'The prompt is empty' };

  const result = await judgeVacancy({ apiKey, vacancy, prompts: { A: prompt } });
  if (!result.success) return { success: false, kind: result.kind, error: result.error };
  return {
    success: true,
    probability: result.probabilities.A,
    cost: result.metadata.cost,
    ms: result.metadata.responseTime,
  };
}
