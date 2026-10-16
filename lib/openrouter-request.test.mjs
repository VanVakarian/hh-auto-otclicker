// node --test lib/openrouter-request.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRouterUrl, postToOpenRouter } from './openrouter-request.js';

test('openRouterUrl', async (t) => {
  const cases = [
    ['no proxy goes straight to OpenRouter', '', '/v1/chat/completions', 'https://openrouter.ai/api/v1/chat/completions'],
    ['an unset proxy is no proxy', undefined, '/alpha/decisions', 'https://openrouter.ai/api/alpha/decisions'],
    ['spaces only is no proxy', '   ', '/alpha/decisions', 'https://openrouter.ai/api/alpha/decisions'],
    ['a proxy takes the place of the host and /api', 'https://app.vslav.dev/or-x', '/v1/chat/completions', 'https://app.vslav.dev/or-x/v1/chat/completions'],
    ['slashes at the end of the proxy are dropped', ' https://app.vslav.dev/or-x// ', '/alpha/decisions', 'https://app.vslav.dev/or-x/alpha/decisions'],
  ];

  for (const [name, proxyUrl, path, expected] of cases) {
    await t.test(name, () => assert.equal(openRouterUrl(proxyUrl, path), expected));
  }
});

// stands in for the network: records the call, answers with whatever the test hands over (or fails like a network)
function mockFetch(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return calls;
}

const PROXY = 'https://app.vslav.dev/or-x';
const send = (proxyUrl) => postToOpenRouter({ proxyUrl, path: '/v1/chat/completions', apiKey: 'key', body: { a: 1 } });

test('postToOpenRouter', async (t) => {
  await t.test('sends the body with the key and returns the reply with its route', async (t) => {
    const calls = mockFetch(t, { ok: true, json: async () => ({ id: 'gen-1' }) });
    const result = await send(PROXY);

    assert.equal(calls[0].url, `${PROXY}/v1/chat/completions`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer key');
    assert.equal(calls[0].init.body, '{"a":1}');
    assert.deepEqual(result, { success: true, route: 'proxy', data: { id: 'gen-1' } });
  });

  // what the error line says is the whole point: the route, then who answered, so a log shows where it broke
  const failures = [
    ['nothing came back through the proxy', PROXY, new TypeError('Failed to fetch'), { error: 'proxy: no reply (Failed to fetch)' }],
    ['nothing came back straight', '', new TypeError('Failed to fetch'), { error: 'direct: no reply (Failed to fetch)' }],
    [
      "the proxy's nginx cannot reach OpenRouter",
      PROXY,
      { ok: false, status: 502, text: async () => '<html>\n<head><title>502 Bad Gateway</title></head>' },
      { status: 502, error: 'proxy: HTTP 502 from not OpenRouter: <html> <head><title>502 Bad Gateway</title></head>' },
    ],
    [
      'a wrong address of the proxy',
      PROXY,
      { ok: false, status: 405, text: async () => '<html><title>405 Not Allowed</title></html>' },
      { status: 405, error: 'proxy: HTTP 405 from not OpenRouter: <html><title>405 Not Allowed</title></html>' },
    ],
    [
      'OpenRouter refuses the key',
      PROXY,
      { ok: false, status: 401, text: async () => '{"error":{"message":"No auth","code":401}}' },
      { status: 401, error: 'proxy: HTTP 401 from OpenRouter: {"error":{"message":"No auth","code":401}}' },
    ],
    [
      'OpenRouter refuses straight',
      '',
      { ok: false, status: 402, text: async () => '{"error":{"message":"credits"}}' },
      { status: 402, error: 'direct: HTTP 402 from OpenRouter: {"error":{"message":"credits"}}' },
    ],
    [
      'a 200 that is not JSON',
      PROXY,
      { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } },
      { status: 200, error: "proxy: HTTP 200 but not JSON, not OpenRouter's reply" },
    ],
  ];

  for (const [name, proxyUrl, reply, expected] of failures) {
    await t.test(name, async (t) => {
      mockFetch(t, reply);
      assert.deepEqual(await send(proxyUrl), { success: false, ...expected });
    });
  }

  await t.test('a long page is cut', async (t) => {
    mockFetch(t, { ok: false, status: 500, text: async () => `<html>${'x'.repeat(5000)}` });
    const result = await send(PROXY);
    assert.ok(result.error.length < 400, result.error.length);
  });
});
