import {
  KEYS,
  getSettings,
  getRunState,
  saveRunState,
  addBlacklistEntry,
  addResponseLogEntry,
  addAnswersLogEntry,
  addTraceEntry,
} from '../lib/storage.js';
import { waitFor, isVisible } from '../lib/dom.js';
import { normalizeStopWords, matchStopWord } from '../lib/matching.js';
import { randomDelayMs, reactionDelayMs } from '../lib/pacing.js';
import { sleepUnlessStopped, isRunStoppedError } from '../lib/run-control.js';
import { click, fillText, navigate } from '../lib/interaction.js';
import { startPageWatchers } from '../lib/page-watchers.js';
import { reportError, reportWarning, stackOf, installUncaughtErrorCapture } from '../lib/diagnostics.js';
import {
  isContextInvalidatedError,
  haltOnContextInvalidated,
  onContextInvalidated,
} from '../lib/extension-context.js';

const TASK_BODY_SELECTOR = '[data-qa="task-body"]';
const TEST_DESCRIPTION_SELECTOR = '[data-qa="test-description"]';
const QUESTION_SELECTOR = '[data-qa="task-question"]';
const CHOICE_INPUT_SELECTOR = 'input[type="radio"], input[type="checkbox"]';
const CELL_SELECTOR = 'label[data-qa="cell"]';
const CELL_TEXT_SELECTOR = '[data-qa="cell-text-content"]';
const LETTER_TEXTAREA_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
// unlike the in-list popup, this page doesn't disable the submit button up front for a required
// cover letter — it only reveals that via this validation error after a rejected submit
const LETTER_REQUIRED_ERROR_SELECTOR = '[data-qa="letter-required"]';
const SUBMIT_SELECTOR = '[data-qa="vacancy-response-submit-popup"]';
const SKIP_BUTTON_ID = 'hhaa-skip-vacancy-btn';
const FILL_BAR_ID = 'hhaa-manual-fill-bar';
const OPEN_OPTION_VALUE = 'open';

const trace = (message, context) => addTraceEntry('questionnaire', message, context);

async function clickSubmit() {
  const submitButton = document.querySelector(SUBMIT_SELECTOR);
  if (submitButton) await click(submitButton);
}

function extractQuestionBlocks() {
  const blocks = [];

  document.querySelectorAll(TASK_BODY_SELECTOR).forEach((taskBodyEl) => {
    const questionText = taskBodyEl.querySelector(QUESTION_SELECTOR)?.textContent?.trim() || '';
    if (!questionText) return;

    const choiceInputs = taskBodyEl.querySelectorAll(CHOICE_INPUT_SELECTOR);

    if (choiceInputs.length > 0) {
      // hh.ru doesn't mix radio and checkbox within one question, so the first input's type applies to all
      const inputType = choiceInputs[0].type;
      const options = [];
      let openInput = null;

      taskBodyEl.querySelectorAll(CELL_SELECTOR).forEach((cellEl) => {
        const input = cellEl.querySelector(CHOICE_INPUT_SELECTOR);
        if (!input) return;
        if (input.value === OPEN_OPTION_VALUE) {
          openInput = input;
          return;
        }
        const text = cellEl.querySelector(CELL_TEXT_SELECTOR)?.textContent?.trim() || '';
        if (text) options.push({ input, text });
      });

      blocks.push({ taskBodyEl, type: 'choice', inputType, questionText, options, openInput });
      return;
    }

    const textarea = taskBodyEl.querySelector('textarea');
    if (textarea && isVisible(textarea)) {
      blocks.push({ taskBodyEl, type: 'text', questionText, textarea });
      return;
    }

    reportWarning(
      'questionnaire',
      'question has no recognized answer input (not radio/checkbox/textarea)',
      `question="${questionText}"`,
    );
  });

  return blocks;
}

function formatQuestionForLLM(block) {
  if (block.type === 'text') return block.questionText;
  const optionsText = block.options.map((o) => o.text).join('; ');
  const multiHint =
    block.inputType === 'checkbox' ? ' (можно выбрать несколько — перечисли подходящие через "; ")' : '';
  return `${block.questionText}\nВарианты${multiHint}: ${optionsText}`;
}

// exact or substring match only — confident enough to trust without a fallback
function findConfidentOption(options, text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const exact = options.find((o) => o.text.trim().toLowerCase() === normalized);
  if (exact) return exact;

  return options.find((o) => {
    const optText = o.text.trim().toLowerCase();
    return optText.includes(normalized) || normalized.includes(optText);
  });
}

// word-overlap best guess — last resort so a question isn't left completely unanswered
// when there's no confident match and no "своё мнение" field to fall back to
function findFuzzyOption(options, text) {
  const words = new Set(text.trim().toLowerCase().split(/\s+/).filter(Boolean));
  if (words.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const option of options) {
    const optWords = option.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const score = optWords.filter((w) => words.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best;
}

// returns a human-readable description of what actually got clicked/typed, so the caller can
// record what was really submitted — not just what the LLM proposed — for later review
async function fillChoiceAnswer(block, answer) {
  const fragments =
    block.inputType === 'checkbox'
      ? answer
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [answer.trim()];

  const confident = fragments.map((f) => findConfidentOption(block.options, f)).filter(Boolean);
  if (confident.length > 0) {
    for (const option of confident) await click(option.input);
    return confident.map((option) => option.text).join('; ');
  }

  if (block.openInput) {
    await click(block.openInput);
    // the custom-answer textarea is hidden until "Свой вариант" is selected, so it must be located after the click
    const textarea = await waitFor(() => {
      const el = block.taskBodyEl.querySelector('textarea');
      return isVisible(el) ? el : null;
    });
    if (textarea) {
      await fillText(textarea, answer);
      return `Свой вариант: ${answer}`;
    }
    return null;
  }

  const fuzzy = fragments.map((f) => findFuzzyOption(block.options, f)).filter(Boolean);
  if (fuzzy.length > 0) {
    reportWarning('questionnaire', 'no exact match for the LLM answer, using closest guess', `question="${block.questionText}"`);
    for (const option of fuzzy) await click(option.input);
    return `≈ ${fuzzy.map((option) => option.text).join('; ')}`;
  }

  reportWarning('questionnaire', 'could not answer the question', `question="${block.questionText}"`);
  return null;
}

// shared by the automatic pipeline (run()) and the manual "заполнить ответы" button — asks the
// LLM for answers to every extracted block, using exactly the same request shape either way
function requestLLMAnswers(blocks, settings) {
  return chrome.runtime.sendMessage({
    type: 'HHAA_GENERATE_ANSWERS',
    payload: {
      apiKey: settings.apiKey,
      legend: settings.legend,
      userPrompt: settings.stylePrompt,
      questions: blocks.map(formatQuestionForLLM),
      modelsRaw: settings.llmModelsRaw,
    },
  });
}

// fills each block with its LLM answer and returns what was actually clicked/typed — same
// filling logic for both the automatic pipeline and the manual button
async function fillBlocksWithAnswers(blocks, answers) {
  const answerRecords = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const llmAnswer = answers[i];
    if (block.type === 'text') {
      await fillText(block.textarea, llmAnswer);
      answerRecords.push({ question: block.questionText, type: 'text', llmAnswer, selected: llmAnswer });
    } else {
      const selected = await fillChoiceAnswer(block, llmAnswer);
      answerRecords.push({ question: block.questionText, type: block.inputType, llmAnswer, selected });
    }
  }
  return answerRecords;
}

async function fillCoverLetter(letterText) {
  const textarea = await waitFor(() => {
    const el = document.querySelector(LETTER_TEXTAREA_SELECTOR);
    return isVisible(el) ? el : null;
  });

  if (!textarea) {
    await trace('cover letter textarea not found on page', `selector=${LETTER_TEXTAREA_SELECTOR}`);
    return;
  }

  await fillText(textarea, letterText);
}

// assisted mode: the questionnaire is already filled, waiting for the human to review/edit it on
// the page and hit Отправить/Пропустить in the sidepanel. Two ways this resolves: a message from
// the sidepanel (decision 'submit'/'skip'), or the run being stopped from under it (status leaves
// 'running') — abandoning the wait rather than hanging forever if the user just walks away.
function waitForApproval(vacancyId) {
  return new Promise((resolve) => {
    function cleanup() {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.storage.onChanged.removeListener(storageListener);
    }
    function messageListener(message) {
      if (message.type !== 'HHAA_QUESTIONNAIRE_DECISION' || message.vacancyId !== vacancyId) return;
      cleanup();
      resolve(message.decision);
    }
    function storageListener(changes, area) {
      if (area !== 'local' || !changes[KEYS.RUN_STATE]) return;
      if (changes[KEYS.RUN_STATE].newValue?.status !== 'running') {
        cleanup();
        resolve('stopped');
      }
    }
    chrome.runtime.onMessage.addListener(messageListener);
    chrome.storage.onChanged.addListener(storageListener);
  });
}

async function finishAndReturn({ vacancyId, listUrl }) {
  const runState = await getRunState();
  const processed = new Set(runState.processedVacancyIds || []);
  processed.add(vacancyId);
  await saveRunState({
    processedVacancyIds: Array.from(processed),
    pendingVacancy: null,
    currentVacancyTitle: null,
    currentVacancyCompany: null,
  });
  // replace, not a normal navigation — otherwise this questionnaire page (already submitted or
  // skipped, a dead end either way) stays in browser history and the back button lands on it
  // instead of the list page the user actually came from
  await navigate(listUrl, { replace: true });
}

const SKIP_REASON_RESULTS = {
  llm_disabled: 'skipped_questionnaire_no_llm',
  llm_failed: 'skipped_questionnaire_llm_failed',
  assisted_skipped: 'skipped_assisted',
  stop_word: 'skipped_stop_word',
  manual_skip: 'skipped_manual',
  cover_letter_required: 'skipped_cover_letter_required',
};

async function skipQuestionnaire({ vacancyId, title, company, listUrl, reason }) {
  await addBlacklistEntry({ vacancyId, title, company, reason, at: Date.now() });
  await addResponseLogEntry({
    at: Date.now(),
    vacancyId,
    title,
    company,
    result: SKIP_REASON_RESULTS[reason] || 'skipped_questionnaire_llm_failed',
  });
  console.log(`📝 [questionnaire] skipping "${title}" (${reason})`);
  await finishAndReturn({ vacancyId, listUrl });
}

// manual escape hatch, independent of run()'s own state machine: a real navigation
// (finishAndReturn -> navigate) kills this document's JS context outright, so whatever
// run() was doing (mid-LLM-call, waiting on approval, whatever) simply stops existing — no
// coordination with run() needed beyond that
function injectSkipButton({ vacancyId, title, company, listUrl }) {
  if (document.getElementById(SKIP_BUTTON_ID)) return;
  const submitButton = document.querySelector(SUBMIT_SELECTOR);
  if (!submitButton?.parentElement) return;

  const skipButton = document.createElement('button');
  skipButton.id = SKIP_BUTTON_ID;
  skipButton.type = 'button';
  skipButton.textContent = 'Автооткликер: пропустить вакансию';
  skipButton.style.cssText =
    'margin-left:12px;padding:12px 20px;background:#dc2626;color:#fff;border:none;' +
    'border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;';
  skipButton.addEventListener('click', () => {
    skipButton.disabled = true;
    skipButton.textContent = 'Пропускаем…';
    skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'manual_skip' }).catch((error) => {
      // Stop pressed while the run was held (a captcha on screen): the page stays as it is
      if (!isRunStoppedError(error)) throw error;
    });
  });

  submitButton.parentElement.appendChild(skipButton);
}

async function setupManualSkipButton() {
  const runState = await getRunState();
  if (runState.status !== 'running' || !runState.pendingVacancy) return;

  const settings = await getSettings();
  if (settings.mode !== 'assisted') return;

  const { vacancyId, title, company } = runState.pendingVacancy;

  await waitFor(() => document.querySelector(SUBMIT_SELECTOR));
  injectSkipButton({ vacancyId, title, company, listUrl: runState.listUrl });
}

// manual mode: the human opened this questionnaire themselves (bot not running) — offer the
// same LLM fill as the automatic pipeline via a button, leaving the actual review/submit to them
async function handleManualFillClick(button, bar) {
  const blocks = extractQuestionBlocks();
  if (blocks.length === 0) {
    button.textContent = 'Вопросы не найдены';
    return;
  }

  const settings = await getSettings();
  if (!(settings.llmEnabled && settings.apiKey && settings.apiKey.trim())) {
    button.textContent = 'LLM выключен или не задан ключ — см. настройки';
    return;
  }

  button.disabled = true;
  button.textContent = 'Заполняем…';

  const response = await requestLLMAnswers(blocks, settings);
  if (!response?.success) {
    button.disabled = false;
    button.textContent = 'Ошибка LLM — нажмите, чтобы повторить';
    return;
  }

  await fillBlocksWithAnswers(blocks, response.data.answers);

  button.textContent = 'Заполнено ✓';
  setTimeout(() => bar.remove(), 2000);
}

function injectManualFillButton() {
  if (document.getElementById(FILL_BAR_ID)) return;

  const bar = document.createElement('div');
  bar.id = FILL_BAR_ID;
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;justify-content:center;' +
    'padding:10px;background:#dc2626;box-shadow:0 2px 8px rgba(0,0,0,0.25);';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Автооткликер: заполнить ответы';
  button.style.cssText =
    'padding:10px 24px;background:#fff;color:#dc2626;border:none;border-radius:8px;' +
    'font-size:15px;font-weight:600;cursor:pointer;';
  button.addEventListener('click', () => handleManualFillClick(button, bar));

  bar.appendChild(button);
  document.body.prepend(bar);
}

// shown only when the bot isn't driving this page — if it's running, either the automatic
// pipeline already filled everything, or (assisted mode) it's mid-flow and will handle it itself
async function setupManualFillButton() {
  const runState = await getRunState();
  if (runState.status === 'running') return;

  await waitFor(() => document.querySelector(SUBMIT_SELECTOR));
  if (extractQuestionBlocks().length === 0) return;

  injectManualFillButton();
}

async function run() {
  const runState = await getRunState();
  if (runState.status !== 'running' || !runState.pendingVacancy) return;

  const { vacancyId, title, company } = runState.pendingVacancy;
  const listUrl = runState.listUrl;

  try {
    console.log(`📝 [questionnaire] processing "${title}" (${company})`);
    await trace('questionnaire page opened', `vacancyId=${vacancyId} url=${location.href}`);

    await waitFor(() => document.querySelector(SUBMIT_SELECTOR));
    if (!document.querySelector(SUBMIT_SELECTOR)) {
      throw new Error('submit button not found on questionnaire page');
    }

    const blocks = extractQuestionBlocks();
    const settings = await getSettings();
    const answerRecords = [];

    await trace(
      'question blocks extracted',
      `count=${blocks.length} types=${blocks.map((b) => b.type).join(',') || 'none'}`,
    );

    const stopWords = normalizeStopWords(settings.skipStopWordsRaw);
    if (stopWords.length > 0) {
      const testDescriptionText = document.querySelector(TEST_DESCRIPTION_SELECTOR)?.textContent || '';
      const questionsText = blocks.map((b) => b.questionText).join('\n');
      const matchedWord = matchStopWord(`${testDescriptionText}\n${questionsText}`, stopWords);
      if (matchedWord) {
        await trace('stop word matched, skipping', `word="${matchedWord}" vacancyId=${vacancyId}`);
        await skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'stop_word' });
        return;
      }
    }

    if (blocks.length > 0) {
      const llmAvailable = settings.llmEnabled && settings.apiKey && settings.apiKey.trim();

      if (!llmAvailable) {
        await trace('LLM unavailable (disabled or no API key), skipping questionnaire', `vacancyId=${vacancyId}`);
        await skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'llm_disabled' });
        return;
      }

      const llmStartedAt = Date.now();
      const response = await requestLLMAnswers(blocks, settings);
      await trace(
        'LLM response received',
        `success=${Boolean(response?.success)} tookMs=${Date.now() - llmStartedAt} error=${response?.error || 'none'}`,
      );

      if (!response?.success) {
        await skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'llm_failed' });
        return;
      }

      answerRecords.push(...(await fillBlocksWithAnswers(blocks, response.data.answers)));
    }

    let coverLetterSent = Boolean(
      settings.coverLetterEnabled && settings.coverLetterText && settings.coverLetterText.trim(),
    );
    if (coverLetterSent) {
      await fillCoverLetter(settings.coverLetterText);
    }

    if (settings.mode === 'assisted' && answerRecords.length > 0) {
      await trace('assisted mode: filled, waiting for human approval', `vacancyId=${vacancyId}`);
      // registers the listeners synchronously before the sidepanel could possibly show its
      // Отправить/Пропустить buttons — awaiting saveRunState first would leave a (tiny but real)
      // window where a message sent the instant the buttons appear could arrive before anything
      // is listening for it and be silently dropped
      const approvalPromise = waitForApproval(vacancyId);
      await saveRunState({ awaitingApproval: true });
      const decision = await approvalPromise;
      await saveRunState({ awaitingApproval: false });
      await trace('assisted mode: decision received', `vacancyId=${vacancyId} decision=${decision}`);

      if (decision === 'stopped') {
        // the user hit Стоп while this was waiting — leave the page exactly as-is for inspection,
        // same as every other status !== 'running' early-return in this extension
        return;
      }

      if (decision === 'skip') {
        await skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'assisted_skipped' });
        return;
      }
    }

    function submitConfirmed() {
      const button = document.querySelector(SUBMIT_SELECTOR);
      return !button || button.disabled || !location.pathname.startsWith('/applicant/vacancy_response');
    }

    // same human-pause reasoning as the popup path — a beat before submitting, not instant fill-then-send.
    // Interruptible so a Stop pressed during this pause skips the submit, same as the assisted-mode
    // decision === 'stopped' case above: leave the page as-is rather than sending after a stop.
    if (!(await sleepUnlessStopped(randomDelayMs(settings.delayMinSec, settings.delayMaxSec)))) return;
    await clickSubmit();

    // a fixed pause isn't proof the submit went through — wait for an actual state change
    // (button gone/disabled, or the page navigated away from the questionnaire)
    let confirmed = await waitFor(submitConfirmed, { timeout: 5000 });

    // a required cover letter we hadn't proactively filled (coverLetterEnabled off) only surfaces
    // here, as a rejected submit — mirrors the in-list popup's isRequired handling in vacancy-list.js,
    // just detected after the fact instead of up front via a disabled submit button
    if (!confirmed && !coverLetterSent && document.querySelector(LETTER_REQUIRED_ERROR_SELECTOR)) {
      const haveLetterText = Boolean(settings.coverLetterText && settings.coverLetterText.trim());

      if (!haveLetterText) {
        await trace('cover letter required but none configured, skipping', `vacancyId=${vacancyId}`);
        await skipQuestionnaire({ vacancyId, title, company, listUrl, reason: 'cover_letter_required' });
        return;
      }

      await trace('cover letter required, filling and retrying submit', `vacancyId=${vacancyId}`);
      await fillCoverLetter(settings.coverLetterText);
      coverLetterSent = true;

      if (!(await sleepUnlessStopped(randomDelayMs(settings.delayMinSec, settings.delayMaxSec)))) return;
      await clickSubmit();
      confirmed = await waitFor(submitConfirmed, { timeout: 5000 });
    }

    await trace('submit confirmation check', `confirmed=${Boolean(confirmed)} url=${location.href}`);

    if (answerRecords.length > 0) {
      await addAnswersLogEntry({
        at: Date.now(),
        vacancyId,
        vacancyUrl: `https://hh.ru/vacancy/${vacancyId}`,
        title,
        company,
        outcome: confirmed ? 'submitted' : 'unconfirmed',
        coverLetterSent,
        coverLetterText: coverLetterSent ? settings.coverLetterText : null,
        answers: answerRecords,
      });
    }

    if (!confirmed) {
      throw new Error('submit did not appear to complete — the questionnaire form is still showing');
    }

    await addResponseLogEntry({
      at: Date.now(),
      vacancyId,
      title,
      company,
      result: 'success_questionnaire',
    });
    console.log(`📝 [questionnaire] submitted "${title}"`);

    // A person looks at what the submit did before leaving. hh.ru answers a submit with a captcha a
    // moment after the form goes quiet — this beat is when that shows up, so the way back to the list
    // is never taken in the instant before it does. (The hold ends the pause at once: nothing moves
    // under a captcha.)
    if (!(await sleepUnlessStopped(reactionDelayMs()))) return;
    await finishAndReturn({ vacancyId, listUrl });
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      haltOnContextInvalidated();
      return;
    }
    // Stop pressed while held (a captcha on screen): leave the page as-is, like every other stop here
    if (isRunStoppedError(error)) return;
    await reportError(
      'questionnaire',
      `fatal error: ${error.message}`,
      `vacancyId=${vacancyId} url=${location.href} ${stackOf(error)}`,
    );
    // stay on the page instead of navigating away, so the failure can be inspected
    await saveRunState({ status: 'error', lastError: error.message });
  }
}

onContextInvalidated(() => {
  // nothing can be written to the log from a dead context, and a warn here would sit on the Errors page
  console.log('📝 [questionnaire] extension was reloaded/updated — reload this page to restore the bot');
});
installUncaughtErrorCapture('questionnaire');
startPageWatchers('questionnaire');
setupManualSkipButton();
setupManualFillButton();
run();
