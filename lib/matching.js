// shared by the company blacklist and the vacancy-title stop words — both are "one group of
// words per line" settings with the same matching rule, just checked against different text
export function normalizeWordGroups(raw) {
  return (raw || '')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).filter(Boolean));
}

// each line's words must ALL be present in the text — words don't need to be adjacent, so
// "Администрация Самары" also matches "Администрация города Самары"
export function matchesWordGroups(text, wordGroups) {
  const normalized = (text || '').trim().toLowerCase();
  if (!normalized) return false;
  return wordGroups.some((words) => words.every((word) => normalized.includes(word)));
}

export function normalizeStopWords(raw) {
  return (raw || '')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

// substring match against the questionnaire's own text — a stop word like "тестовое задание"
// or "задание:" catches the phrasing hh.ru employers use to hand out an actual external task,
// which the LLM would otherwise happily "answer" by hallucinating a plausible-looking link
export function matchStopWord(text, stopWords) {
  const normalized = (text || '').toLowerCase();
  return stopWords.find((word) => normalized.includes(word)) || null;
}
