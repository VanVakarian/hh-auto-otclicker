// Jev — TypeSafe's decision model, served by OpenRouter through its own Decisions endpoint (alpha, so its
// shape may still change). It does not write text: it is given a `state` and typed questions, and answers
// each with probabilities. Same API key as the chat models, same host permission.
//
// Questions are a map `{ key: question }` and come back under the same keys. A `noul` question
// ({ type: 'noul', instructions, criteria: { true, false } }) is answered with `noul`, the probability of
// "true"; `choice` and `score` exist too and answer with `probabilities` / `score`.
//
// The path is not the one in OpenRouter's API reference page (/api/v1/api/alpha/decisions answers 404): the
// working one is /api/alpha/decisions, outside of /api/v1.
const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';

// pinned, so a benchmark stays comparable; `~typesafe/jev-latest` follows the newest release instead
export const JEV_MODEL = 'typesafe/jev-1.13';

// Same result shape as callOpenRouter: { success: true, data: { answers }, metadata: { model, usage } } or
// { success: false, status?, error }. `usage` carries input_tokens, output_tokens and cost in USD; the
// output is free, so the cost is the input alone.
export async function callJev({ apiKey, model = JEV_MODEL, state, questions, timeoutMs }) {
  try {
    const response = await fetch(JEV_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, state, questions }),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });

    if (!response.ok) {
      const errorData = await response.text();
      return {
        success: false,
        status: response.status,
        error: `HTTP ${response.status}: ${errorData}`,
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: { answers: data.answers },
      metadata: {
        model: data.model,
        usage: data.usage,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}
