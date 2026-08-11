const RESULT_META = {
  success_instant: { icon: '✅', label: 'Мгновенный отклик' },
  success_popup: { icon: '✅', label: 'Отклик через попап' },
  success_questionnaire: { icon: '✅', label: 'Анкета отправлена' },
  skipped_company: { icon: '⏭', label: 'Пропущено — чёрный список компаний' },
  skipped_popup: { icon: '⏭', label: 'Попап пропущен' },
  skipped_questionnaire_no_llm: { icon: '⏭', label: 'Анкета пропущена — LLM выключен' },
  skipped_questionnaire_llm_failed: { icon: '⏭', label: 'Анкета пропущена — LLM не справился' },
  skipped_assisted: { icon: '⏭', label: 'Пропущено вручную (ассистент)' },
  uncertain_navigated_away: { icon: '❔', label: 'Неясно — клик увёл со списка' },
  error: { icon: '⚠️', label: 'Ошибка' },
};

export function resultMeta(result) {
  return RESULT_META[result] || { icon: '•', label: result };
}

const SUCCESS_RESULTS = new Set(['success_instant', 'success_popup', 'success_questionnaire']);

export function isSuccess(result) {
  return SUCCESS_RESULTS.has(result);
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateShort(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export function dayKey(ts) {
  return new Date(ts).toLocaleDateString('sv-SE');
}
