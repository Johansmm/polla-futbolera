// Cloudflare Worker: proxies football-data.org for match data, with a KV
// cache shared across every concurrent client so a page full of clients
// loading the app at once doesn't each burn a separate call against the
// free-tier rate limit (10 calls/min).
//
// Bindings expected (see wrangler.toml):
//   MATCH_CACHE — KV namespace used as the cache (`wrangler kv namespace create`)
//   API_KEY     — secret, football-data.org API token (`wrangler secret put API_KEY`)
import { FOOTBALL_DATA_BASE_URL, COMPETITION_CODE } from "../../js/football-data-config.mjs";

// One upstream endpoint per route exposed to the client, plus this cache's
// TTL. A single fixed TTL per route (rather than branching per-match on
// live/finished/upcoming) keeps the cache key trivial — one entry per route,
// shared by every client — while still cutting real API calls to roughly
// 1/minute, well under the free tier's 10/min limit no matter how many
// clients have the page open at once.
export const ROUTES = {
  "/matches": { upstreamPath: "matches", ttlSeconds: 60 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function resolveRoute(pathname) {
  return ROUTES[pathname];
}

export function buildUpstreamUrl(upstreamPath) {
  return `${FOOTBALL_DATA_BASE_URL}/competitions/${COMPETITION_CODE}/${upstreamPath}`;
}

export function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

// cache/fetchUpstream are injected (rather than reaching for env.MATCH_CACHE
// and global fetch directly) so this can be unit-tested with fakes, no real
// KV namespace or network access needed.
export async function fetchFromCacheOrUpstream(route, apiKey, cache, fetchUpstream) {
  const cacheKey = route.upstreamPath;
  const cached = await cache.get(cacheKey);
  if (cached != null) {
    return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(buildUpstreamUrl(route.upstreamPath), {
      headers: { "X-Auth-Token": apiKey },
    });
  } catch (err) {
    // A network-level failure (DNS, timeout, connection reset) throws rather
    // than resolving to a Response, unlike a football-data.org error status —
    // caught here so callers still get a normal Response with CORS headers,
    // not an unhandled-exception 500 from the Workers runtime itself.
    return new Response(JSON.stringify({ error: `Upstream request failed: ${err.message}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = await upstreamRes.text();

  if (!upstreamRes.ok) {
    return new Response(body, { status: upstreamRes.status, headers: { "Content-Type": "application/json" } });
  }

  await cache.put(cacheKey, body, { expirationTtl: route.ttlSeconds });
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const { pathname } = new URL(request.url);
  const route = resolveRoute(pathname);
  if (!route) return withCors(new Response("Not found", { status: 404 }));
  if (request.method !== "GET") return withCors(new Response("Method not allowed", { status: 405 }));

  if (!env.API_KEY) {
    return withCors(new Response("Worker misconfigured: missing API_KEY secret", { status: 500 }));
  }

  const response = await fetchFromCacheOrUpstream(route, env.API_KEY, env.MATCH_CACHE, fetch);
  return withCors(response);
}

export default {
  fetch: handleRequest,
};
