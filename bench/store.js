import { KEYS, getSettings } from '../lib/storage.js';

// `prompts` and `threshold` are what the page asks and judges by; `run` is the last run (kept so a reload
// doesn't throw away what was paid for). Until the page has values of its own, it starts from the working ones —
// the prompt and the threshold of the extension's settings, which are what a real run judges by.
export async function loadBench() {
  const [stored, settings] = await Promise.all([chrome.storage.local.get(KEYS.FIT_BENCH), getSettings()]);
  return {
    run: null,
    prompts: [{ key: 'A', text: settings.fitPrompt }],
    threshold: settings.fitThreshold,
    ...stored[KEYS.FIT_BENCH],
  };
}

export function saveBench(doc) {
  return chrome.storage.local.set({ [KEYS.FIT_BENCH]: doc });
}
