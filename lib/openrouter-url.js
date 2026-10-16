// Where a request to OpenRouter goes. OpenRouter's API lives under /api: the chat endpoints under /api/v1, the
// Decisions endpoint under /api/alpha. With a proxy set (settings → openRouterProxyUrl) the same paths go to its
// address instead, and the proxy forwards /v1/... and /alpha/... to openrouter.ai/api/... — see the server's notes.
const DIRECT_URL = 'https://openrouter.ai/api';

export function openRouterUrl(proxyUrl, path) {
  const base = proxyUrl?.trim().replace(/\/+$/, '') || DIRECT_URL;
  return `${base}${path}`;
}
