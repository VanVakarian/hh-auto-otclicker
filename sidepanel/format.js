const RESULT_META = {
  success_instant: { icon: '✅', label: 'Мгновенный отклик' },
  success_popup: { icon: '✅', label: 'Отклик через попап' },
  success_questionnaire: { icon: '✅', label: 'Анкета отправлена' },
  skipped_company: { icon: '⏭', label: 'Пропущено — чёрный список компаний' },
  skipped_title_stop_word: { icon: '⏭', label: 'Пропущено — стоп-слово в названии' },
  skipped_popup: { icon: '⏭', label: 'Попап пропущен' },
  skipped_questionnaire_no_llm: { icon: '⏭', label: 'Анкета пропущена — LLM выключен' },
  skipped_questionnaire_llm_failed: { icon: '⏭', label: 'Анкета пропущена — LLM не справился' },
  skipped_assisted: { icon: '⏭', label: 'Пропущено вручную (ассистент)' },
  skipped_stop_word: { icon: '⏭', label: 'Анкета пропущена — стоп-слово' },
  skipped_manual: { icon: '⏭', label: 'Пропущено вручную на странице' },
  skipped_cover_letter_required: { icon: '⏭', label: 'Анкета пропущена — нужно сопроводительное письмо' },
  uncertain_navigated_away: { icon: '❔', label: 'Неясно — клик увёл со списка' },
  error: { icon: '⚠️', label: 'Ошибка' },
};

export function resultMeta(result) {
  return RESULT_META[result] || { icon: '•', label: result };
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
