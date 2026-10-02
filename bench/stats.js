import { isFit } from '../lib/vacancy-fit.js';

// A run, as the benchmark stores it:
//   { prompts: { key: text }, vacancies: [card], results: { [vacancyId]: record } }
// where a record is { ok: true, probabilities: { key: p }, state, cost, inputTokens, responseTime, ... } or
// { ok: false, kind, error, state }. Everything here derives from that and a threshold, so moving the
// threshold is a recount, never a new request.

export const recordOf = (run, vacancyId) => run.results[vacancyId] ?? null;

export const hasError = (run, vacancyId) => recordOf(run, vacancyId)?.ok === false;

// 'accept' or 'reject' when every prompt agrees, 'mixed' when they split, 'none' when there is no answer
export function vacancyVerdict(run, vacancyId, threshold) {
  const record = recordOf(run, vacancyId);
  if (!record?.ok) return 'none';
  const verdicts = Object.keys(run.prompts).map((key) => isFit(record.probabilities[key], threshold));
  if (verdicts.every(Boolean)) return 'accept';
  return verdicts.some(Boolean) ? 'mixed' : 'reject';
}

// the mean of a vacancy's probabilities over the prompts; -1 when there is no answer, so it sorts last
export function meanProbability(run, vacancyId) {
  const record = recordOf(run, vacancyId);
  if (!record?.ok) return -1;
  const values = Object.values(record.probabilities);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// One entry per prompt: how its answers split at the threshold
export function summarizePrompts(run, threshold) {
  return Object.keys(run.prompts).map((promptKey) => {
    const summary = { promptKey, accepted: 0, rejected: 0, failed: 0, probabilities: [] };
    for (const { vacancyId } of run.vacancies) {
      const record = recordOf(run, vacancyId);
      if (!record) continue;
      if (!record.ok) {
        summary.failed += 1;
        continue;
      }
      const probability = record.probabilities[promptKey];
      summary.probabilities.push(probability);
      if (isFit(probability, threshold)) summary.accepted += 1;
      else summary.rejected += 1;
    }
    return summary;
  });
}

// What the requests cost and how long they took. A request carries every prompt, so this is per vacancy.
export function summarizeCost(run) {
  const sum = { requests: 0, failed: 0, cost: 0, inputTokens: 0, responseTime: 0 };
  for (const { vacancyId } of run.vacancies) {
    const record = recordOf(run, vacancyId);
    if (!record) continue;
    sum.requests += 1;
    if (!record.ok) {
      sum.failed += 1;
      continue;
    }
    sum.cost += record.cost;
    sum.inputTokens += record.inputTokens ?? 0;
    sum.responseTime += record.responseTime;
  }
  const answered = sum.requests - sum.failed;
  return {
    ...sum,
    answered,
    avgCost: answered ? sum.cost / answered : 0,
    avgInputTokens: answered ? sum.inputTokens / answered : 0,
    avgResponseTime: answered ? sum.responseTime / answered : 0,
  };
}

// counts of probabilities per equal-width bin of [0, 1]; 1 itself belongs to the last bin
export function histogram(values, bins = 10) {
  const counts = new Array(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor(value * bins))] += 1;
  return counts;
}
