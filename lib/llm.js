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

async function callOpenRouter({ apiKey, model, userPrompt }) {
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
          { role: 'system', content: SYSTEM_PROMPT },
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

export async function generateAnswers({ apiKey, legend, userPrompt, questions, modelsRaw }) {
  try {
    if (!apiKey || !apiKey.trim()) {
      return {
        success: false,
        error: 'API key is required',
      };
    }

    if (!questions || questions.length === 0) {
      return {
        success: false,
        error: 'No questions provided',
      };
    }

    const models = parseModelsList(modelsRaw);
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

    for (const model of models) {
      const startTime = Date.now();
      const llmResult = await callOpenRouter({
        apiKey,
        model,
        userPrompt: fullUserPrompt,
      });
      const responseTime = Date.now() - startTime;

      if (!llmResult.success) {
        console.error(`🤖 [llm] model ${model} failed: ${llmResult.error}`);
        continue;
      }

      const parsedResult = parseJSONWithMultipleStrategies(llmResult.data.content);

      if (!parsedResult.success) {
        console.error(`🤖 [llm] parse failed for ${model}: ${parsedResult.error}`);
        continue;
      }

      if (!validateAnswers(parsedResult.data.answers, questions.length)) {
        console.error(`🤖 [llm] invalid answers shape from ${model}, expected ${questions.length}`);
        continue;
      }

      return {
        success: true,
        data: {
          answers: parsedResult.data.answers,
        },
        metadata: {
          model,
          responseTime,
          parsingStrategy: parsedResult.usedStrategy,
          usage: llmResult.metadata?.usage,
        },
      };
    }

    const errorMsg = `All ${models.length} models failed to generate valid answers`;
    console.error(`🤖 [llm] ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  } catch (error) {
    console.error(`🤖 [llm] unexpected error: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}
