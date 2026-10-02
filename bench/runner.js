const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `worker` is run over `items`, `concurrency` at a time, in order; once `signal` is aborted no new item is
// started (the ones in flight finish)
export async function runWithConcurrency(items, worker, { concurrency, signal }) {
  let next = 0;
  const lane = async () => {
    while (!signal.aborted && next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

// A 429 or a hiccup of the provider deserves another go after a pause that grows; anything else — a result,
// or a failure another attempt can't fix — is final
export async function judgeWithRetries(judge, params, { retries = 2, pauseMs = 1500, wait = sleep } = {}) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await wait(pauseMs * attempt);
    result = await judge(params);
    if (result.success || result.kind !== 'transient') return result;
  }
  return result;
}
