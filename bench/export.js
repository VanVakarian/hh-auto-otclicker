import { formatRubles } from '../lib/money.js';
import { JEV_MODEL } from '../lib/jev.js';
import { FIT_QUESTION, buildFitQuestions, isFit } from '../lib/vacancy-fit.js';
import { histogram, meanProbability, recordOf, summarizeCost, summarizePrompts } from './stats.js';

// The run as one Markdown file that stands on its own: a person (or a language model in a session that has
// never seen this project) can read it top to bottom and know the task, exactly what was asked, what came
// back and what it cost, and be asked for the one thing wanted — a better prompt.
//
// Markdown, not JSON: the vacancies are prose, the structure is shallow, and a model reads headings and
// fenced blocks as easily as it reads anything. What a machine would want of the same data is in the
// sections themselves — the questions are given as the JSON that went over the wire, the probabilities are
// raw (not only verdicts), so any threshold can be tried without the run.

const pct = (probability) => `${Math.round(probability * 100)}%`;

const fence = (text, language = '') => `\`\`\`${language}\n${text}\n\`\`\``;

// the state of a request as lines, in the order it was sent; a value never spans lines in the file
const stateLines = (state) =>
  Object.entries(state ?? {})
    .map(([key, value]) => `${key}: ${String(value).replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');

function distribution(probabilities) {
  const counts = histogram(probabilities, 10);
  return counts.map((count, index) => `${index * 10}–${(index + 1) * 10}%: ${count}`).join(' · ');
}

function vacancySection(run, vacancy, index, threshold) {
  const record = recordOf(run, vacancy.vacancyId);
  const keys = Object.keys(run.prompts);
  let answer = 'нет ответа (запрос не отправлялся)';
  if (record?.ok) {
    answer = keys
      .map((key) => {
        const probability = record.probabilities[key];
        return `${keys.length > 1 ? `${key}=` : ''}${pct(probability)} → ${isFit(probability, threshold) ? 'подходит' : 'не подходит'}`;
      })
      .join(' · ');
  }
  if (record && !record.ok) answer = `ОШИБКА: ${record.error}`;

  const note = vacancy.responded ? ' · на неё уже откликались' : '';
  return [
    `### ${index + 1}. ${vacancy.title} — ${vacancy.company}`,
    `id ${vacancy.vacancyId} · https://hh.ru/vacancy/${vacancy.vacancyId}${note}`,
    `Ответ модели: ${answer}`,
    fence(stateLines(record?.state), 'text'),
  ].join('\n');
}

export function buildExport(run, threshold) {
  const keys = Object.keys(run.prompts);
  const cost = summarizeCost(run);
  const questions = buildFitQuestions(run.prompts);
  const servedModel = Object.values(run.results).find((record) => record.ok)?.model ?? JEV_MODEL;
  const sorted = run.vacancies.toSorted(
    (a, b) => meanProbability(run, b.vacancyId) - meanProbability(run, a.vacancyId),
  );

  const sections = [
    '# Бенчмарк «подходит ли вакансия» — экспорт прогона',

    [
      '## 1. Задача',
      'Расширение для hh.ru автоматически откликается на вакансии из выдачи поиска. Чтобы не откликаться на неподходящие, ' +
        'каждую вакансию оценивает решающая модель Jev (TypeSafe, через OpenRouter). Это не языковая модель: она получает ' +
        'текст вакансии (`state`) и вопрос «да/нет» и возвращает только вероятность «да» (0–1) — без объяснений и рассуждений.',
      '',
      `- Вопрос к модели = фиксированное начало «${FIT_QUESTION}» + текст соискателя (промпт, ниже дословно).`,
      `- Вердикт: вероятность не ниже порога → «подходит». Порог на момент экспорта: **${pct(threshold)}**; он подбирается после прогона, поэтому ниже даны сырые вероятности.`,
      '- Модель видит только поля вакансии из карточки выдачи (блок под заголовком каждой вакансии) и текст вопроса — больше ничего.',
      '- Сниппеты `responsibilities` и `requirements` hh.ru обрезает (~130–190 символов, часто с «...»); полного описания вакансии нет. ' +
        'В compact-выдаче сниппетов нет совсем — тогда уходит только краткая карточка.',
      '- Отправляется всё, что есть в карточке; ничего не настраивается на ходу.',
    ].join('\n'),

    [
      '## 2. Прогон',
      `- Дата: ${new Date(run.startedAt).toISOString()}`,
      `- Страница поиска: ${run.tabUrl}`,
      `- Вид выдачи: ${run.view} (${run.view === 'expanded' ? 'со сниппетами' : 'без сниппетов'})`,
      `- Модель: ${servedModel}`,
      `- Вакансий: ${run.vacancies.length}; запросов: ${cost.requests}, из них с ошибкой: ${cost.failed}`,
      `- Стоимость: ${formatRubles(cost.cost)} всего, ${formatRubles(cost.avgCost)} за запрос; в среднем ${Math.round(cost.avgInputTokens)} входных токенов и ${Math.round(cost.avgResponseTime)} мс на запрос`,
    ].join('\n'),

    [
      '## 3. Промпты и вопросы — как отправлены',
      ...keys.flatMap((key) => [
        `### Промпт ${key}`,
        run.prompts[key]
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
        '',
        `Вопрос \`${key}\` в запросе (JSON):`,
        fence(JSON.stringify(questions[key], null, 2), 'json'),
      ]),
    ].join('\n'),

    [
      `## 4. Итог при пороге ${pct(threshold)}`,
      ...summarizePrompts(run, threshold).map(
        (summary) =>
          `- ${keys.length > 1 ? `Промпт ${summary.promptKey}: ` : ''}подходят ${summary.accepted}, не подходят ${summary.rejected}` +
          `${summary.failed ? `, ошибок ${summary.failed}` : ''}. Распределение вероятностей: ${distribution(summary.probabilities)}`,
      ),
    ].join('\n'),

    [
      '## 5. Вакансии — по убыванию вероятности',
      keys.length > 1 ? '(порядок — по среднему значению всех промптов)' : '',
      '',
      sorted.map((vacancy, index) => vacancySection(run, vacancy, index, threshold)).join('\n\n'),
    ].join('\n'),

    [
      '## 6. Что нужно от анализа',
      'Соискатель описал себя в промпте (раздел 3). Работа, о которой прошу:',
      '1. Прочитай каждую вакансию и сам реши, подходит ли она соискателю по его промпту. Сравни со своим решением и вердиктом модели; выпиши расхождения: ложные «подходит» и ложные «не подходит».',
      '2. Найди закономерности ошибок: какие слова, формулировки или поля вводят модель в заблуждение (например, название «Project Manager» при вакансии не про IT).',
      '3. Предложи 2–3 переформулировки промпта. Помни: модель не рассуждает и не исполняет инструкции, она оценивает, насколько описание вакансии соответствует тому, что сказано в вопросе, поэтому критерий лучше описывать признаками вакансии, а не командами.',
      '4. Предложи порог, при котором ошибок меньше всего на этих данных, и скажи, какая ошибка здесь дороже: пропустить подходящую вакансию или откликнуться на неподходящую.',
    ].join('\n'),
  ];

  return `${sections.join('\n\n')}\n`;
}
