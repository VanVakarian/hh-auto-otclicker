// The one way a request reaches OpenRouter, whether straight or through the proxy on the owner's server
// (settings → openRouterProxyUrl). OpenRouter's API lives under /api: the chat endpoints under /api/v1, the
// Decisions endpoint under /api/alpha. With a proxy set the same paths go to its address instead, and the proxy
// forwards /v1/... and /alpha/... to openrouter.ai/api/... — see the server's notes.
const DIRECT_URL = 'https://openrouter.ai/api';
const REPLY_EXCERPT_LENGTH = 300;

export function openRouterUrl(proxyUrl, path) {
  const base = proxyUrl?.trim().replace(/\/+$/, '') || DIRECT_URL;
  return `${base}${path}`;
}

const routeOf = (proxyUrl) => (proxyUrl?.trim() ? 'proxy' : 'direct');

const excerpt = (text) => text.replace(/\s+/g, ' ').trim().slice(0, REPLY_EXCERPT_LENGTH);

// OpenRouter answers errors with JSON; anything else (nginx's page, a wrong address, a block page) did not come
// from it. That one fact is what tells a failure of the road from a failure of the account, the key or the model.
function failedReply(route, status, text) {
  const source = text.trimStart().startsWith('{') ? 'OpenRouter' : 'not OpenRouter';
  return { success: false, status, error: `${route}: HTTP ${status} from ${source}: ${excerpt(text)}` };
}

// A failure is one line that says where it broke, and the route goes first:
//   `direct: no reply (...)` / `proxy: no reply (...)` — nothing came back: no network, the address is not reachable
//     or blocked, or the timeout;
//   `proxy: HTTP 502 from not OpenRouter: <html>...` — the proxy's nginx answered itself: it can't reach OpenRouter
//     (5xx), or the address is wrong (404, 405);
//   `proxy: HTTP 401 from OpenRouter: {...}` — OpenRouter itself said no: the key, the credits, the model, the limit.
// Resolves to { success: true, data } or { success: false, status?, error }.
export async function postToOpenRouter({ proxyUrl, path, apiKey, body, timeoutMs }) {
  const route = routeOf(proxyUrl);
  try {
    const response = await fetch(openRouterUrl(proxyUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });

    if (!response.ok) return failedReply(route, response.status, await response.text());

    try {
      return { success: true, route, data: await response.json() };
    } catch {
      const error = `${route}: HTTP ${response.status} but not JSON, not OpenRouter's reply`;
      return { success: false, status: response.status, error };
    }
  } catch (error) {
    return { success: false, error: `${route}: no reply (${error.message})` };
  }
}
