import { KEYS } from '../lib/storage.js';

// What the person is likely to want first; every word of it is theirs to change on the page
const DEFAULT_PROMPT =
  'Хочет быть менеджером проекта или продукта в разработке софта: веб-сервисы, мобильные приложения, SaaS, ' +
  'внутренние платформы. Не подходит всё, что не про создание софтверного продукта: внедрение и сопровождение 1С, ' +
  'ERP и SAP, ИТ-сервис и ITSM внутри нефтегазовой, мебельной или любой другой не софтверной компании, колл-центры, ' +
  'маркетинг, SMM, продажи, стройка, производство, товары (обувь, одежда, БАДы, еда), логистика, мероприятия.';

// `prompts` and `threshold` are what the page asks and judges by; `run` is the last run (kept so a reload
// doesn't throw away what was paid for)
const DEFAULT_DOC = {
  prompts: [{ key: 'A', text: DEFAULT_PROMPT }],
  threshold: 0.5,
  run: null,
};

export async function loadBench() {
  const stored = (await chrome.storage.local.get(KEYS.FIT_BENCH))[KEYS.FIT_BENCH];
  return { ...structuredClone(DEFAULT_DOC), ...stored };
}

export function saveBench(doc) {
  return chrome.storage.local.set({ [KEYS.FIT_BENCH]: doc });
}
