// node --test lib/openrouter-url.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRouterUrl } from './openrouter-url.js';

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
