import { reportError, stackOf } from './diagnostics.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const DEFAULT_MODELS = [
  'qwen/qwen3-coder',
  'deepseek/deepseek-chat-v3.1',
  'meta-llama/llama-3.1-405b-instruct:free',
  'moonshotai/kimi-k2:free',
  'tngtech/deepseek-r1t2-chimera:free',
];

function parseModelsList(raw) {
  const lines = (raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : DEFAULT_MODELS;
}

const SYSTEM_PROMPT = `
  Ты - эксперт-помощник по заполнению анкет при отклике на вакансию.

  КРИТИЧЕСКИЕ ТРЕБОВАНИЯ К ВЫВОДУ:
  1. Возвращай ТОЛЬКО чистый JSON без markdown блоков
  2. НЕ используй тройные обратные кавычки или любое форматирование
  3. Начинай с { и заканчивай }

  ОБЯЗАТЕЛЬНАЯ СТРУКТУРА:
  {
    "answers": [
      "текст ответа 1",
      "текст ответа 2",
      "текст ответа 3"
    ]
  }

  ПРАВИЛА:
  - Возвращай ответы в ТОЧНО ТОМ ЖЕ ПОРЯДКЕ, что и вопросы
  - Каждый ответ должен быть строкой
  - Если у вопроса указаны варианты ответа (строка "Варианты: ..."), ответ должен ДОСЛОВНО совпадать с текстом одного из вариантов
  - Если ни один вариант не подходит по смыслу — верни свободный текст ответа своими словами, не совпадающий ни с одним вариантом
  - Если у вопроса нет вариантов — отвечай свободным текстом
  - Ответы должны быть краткими и релевантными
  - Используй предоставленную легенду/справочную информацию для адаптации ответов
  - Следуй указаниям по стилю из пользовательского промпта
`;

// no JSON contract here on purpose — the questionnaire flow needs a strict, parseable shape because
// it maps answers back onto specific radio/checkbox DOM elements, but a chat reply is just inserted
// into a textarea as-is, so plain text keeps this whole path simpler
const CHAT_REPLY_SYSTEM_PROMPT = `
  Ты помогаешь соискателю отвечать на сообщение работодателя в чате на hh.ru.

  КРИТИЧЕСКИЕ ТРЕБОВАНИЯ К ВЫВОДУ:
  1. Возвращай ТОЛЬКО текст ответа — без вступлений, пояснений и комментариев от себя
  2. Не оборачивай ответ в кавычки и не используй markdown-разметку
  3. Следуй инструкциям пользователя ниже о том, что именно должно быть в ответе
`;

function parseJSONWithMultipleStrategies(rawResponse) {
  const strategies = [
    {
      name: 'Clean JSON',
      fn: (response) => JSON.parse(response),
    },
    {
      name: 'Remove markdown blocks',
      fn: (response) => {
        const cleaned = response
          .replace(/^```(?:json)?\s*/im, '')
          .replace(/```\s*$/m, '')
          .trim();
        return JSON.parse(cleaned);
      },
    },
    {
      name: 'Extract JSON with regex',
      fn: (response) => {
        const match = response.match(/\{[\s\S]*?\}(?=\s*(?:```|$))/m);
        if (!match) throw new Error('No JSON found');
        return JSON.parse(match[0]);
      },
    },
    {
      name: 'Extract between first and last braces',
      fn: (response) => {
        const firstBrace = response.indexOf('{');
        const lastBrace = response.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
          throw new Error('No valid JSON braces found');
        }
        const extracted = response.substring(firstBrace, lastBrace + 1);
        return JSON.parse(extracted);
      },
    },
    {
      name: 'Line-by-line reconstruction',
      fn: (response) => {
        const lines = response.split('\n');
        const startIdx = lines.findIndex((line) => line.trim().includes('{'));
        const endIdx = lines.findLastIndex((line) => line.trim().includes('}'));
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          throw new Error('No valid JSON structure found');
        }
        const reconstructed = lines.slice(startIdx, endIdx + 1).join('\n');
        return JSON.parse(reconstructed);
      },
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy.fn(rawResponse);

      if (!result.answers || !Array.isArray(result.answers)) {
        continue;
      }

      return {
        success: true,
        data: result,
        usedStrategy: strategy.name,
      };
    } catch (error) {
      continue;
    }
  }

  return {
    success: false,
    error: `All ${strategies.length} parsing strategies failed`,
    rawResponse: rawResponse.substring(0, 200) + '...',
  };
}

async function callOpenRouter({ apiKey, model, userPrompt, systemPrompt = SYSTEM_PROMPT }) {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorData}`,
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: {
        content: data.choices[0].message.content,
      },
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

function validateAnswers(answers, expectedCount) {
  if (!Array.isArray(answers)) {
    return false;
  }

  if (answers.length !== expectedCount) {
    return false;
  }

  for (const answer of answers) {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return false;
    }
  }

  return true;
}

// Shared by every LLM-backed feature (questionnaire answers, chat replies, whatever comes next):
// tries each configured model in order until one produces a response `parseResponse` accepts as
// usable, and only then stops — a model answering doesn't mean its answer is usable (bad JSON,
// wrong shape, empty text), so "the model responded" and "we got a result" are checked separately.
// What "usable" means is entirely up to the caller's `parseResponse`; this function only owns the
// fallback loop and the success/failure result shape, not any feature's response format.
async function tryModelsInOrder({ apiKey, models, systemPrompt, userPrompt, parseResponse, logLabel }) {
  for (const model of models) {
    const startTime = Date.now();
    const llmResult = await callOpenRouter({ apiKey, model, userPrompt, systemPrompt });
    const responseTime = Date.now() - startTime;

    if (!llmResult.success) {
      await reportError('llm', `${logLabel}: model ${model} failed: ${llmResult.error}`);
      continue;
    }

    const parsed = parseResponse(llmResult.data.content);
    if (!parsed) {
      await reportError('llm', `${logLabel}: model ${model} returned an unusable response`);
      continue;
    }

    return {
      success: true,
      data: parsed.data,
      metadata: { model, responseTime, usage: llmResult.metadata?.usage, ...parsed.metadata },
    };
  }

  const errorMsg = `All ${models.length} models failed (${logLabel})`;
  await reportError('llm', errorMsg);
  return { success: false, error: errorMsg };
}

export async function generateAnswers({ apiKey, legend, userPrompt, questions, modelsRaw }) {
  try {
    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'API key is required' };
    }

    if (!questions || questions.length === 0) {
      return { success: false, error: 'No questions provided' };
    }

    const questionsText = questions.map((q, idx) => `${idx + 1}. ${q}`).join('\n');

    const fullUserPrompt = `
      ЛЕГЕНДА/СПРАВОЧНАЯ ИНФОРМАЦИЯ:
      ${legend || 'Не предоставлена'}

      ИНСТРУКЦИИ ПО СТИЛЮ:
      ${userPrompt || 'Отвечай естественно и профессионально'}

      ВОПРОСЫ:
      ${questionsText}

      Верни JSON объект с массивом "answers", содержащим ${
        questions.length
      } ответов в том же порядке, что и вопросы выше.
    `.trim();

    return await tryModelsInOrder({
      apiKey,
      models: parseModelsList(modelsRaw),
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: fullUserPrompt,
      logLabel: 'questionnaire',
      parseResponse: (content) => {
        const parsedResult = parseJSONWithMultipleStrategies(content);
        if (!parsedResult.success) return null;
        if (!validateAnswers(parsedResult.data.answers, questions.length)) return null;
        return {
          data: { answers: parsedResult.data.answers },
          metadata: { parsingStrategy: parsedResult.usedStrategy },
        };
      },
    });
  } catch (error) {
    await reportError('llm', `unexpected error: ${error.message}`, stackOf(error));
    return { success: false, error: error.message };
  }
}

// free-text counterpart to generateAnswers, used to draft a reply to a single incoming chat message
// rather than fill a questionnaire — same model-fallback loop (via tryModelsInOrder), no JSON
// parsing/validation involved: any non-empty response is usable as-is
export async function generateChatReply({ apiKey, legend, chatPrompt, messageText, modelsRaw }) {
  try {
    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'API key is required' };
    }

    if (!messageText || !messageText.trim()) {
      return { success: false, error: 'No message text provided' };
    }

    const fullUserPrompt = `
      ЛЕГЕНДА/СПРАВОЧНАЯ ИНФОРМАЦИЯ:
      ${legend || 'Не предоставлена'}

      ИНСТРУКЦИИ:
      ${chatPrompt || 'Ответь на сообщение работодателя ниже.'}

      СООБЩЕНИЕ РАБОТОДАТЕЛЯ:
      ${messageText}
    `.trim();

    return await tryModelsInOrder({
      apiKey,
      models: parseModelsList(modelsRaw),
      systemPrompt: CHAT_REPLY_SYSTEM_PROMPT,
      userPrompt: fullUserPrompt,
      logLabel: 'chat reply',
      parseResponse: (content) => {
        const text = (content || '').trim();
        return text ? { data: { text } } : null;
      },
    });
  } catch (error) {
    await reportError('llm', `chat reply unexpected error: ${error.message}`, stackOf(error));
    return { success: false, error: error.message };
  }
}
