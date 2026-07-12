// Cloudflare Worker: proxies football-data.org for match data, with a KV
// cache shared across every concurrent client so a page full of clients
// loading the app at once doesn't each burn a separate call against the
// free-tier rate limit (10 calls/min).
//
// Bindings expected (see wrangler.toml):
//   MATCH_CACHE — KV namespace used as the cache (`wrangler kv namespace create`)
//   API_KEY     — secret, football-data.org API token (`wrangler secret put API_KEY`)
import { FOOTBALL_DATA_BASE_URL, COMPETITION_CODE } from "../../js/football-data-config.mjs";

// One primary upstream endpoint per route exposed to the client, plus this
// cache's TTL. A single fixed TTL per route (rather than branching per-match
// on live/finished/upcoming) keeps the cache key trivial — one entry per
// route, shared by every client — while still cutting real API calls to
// roughly 4/minute for the matches endpoint itself, well under the free
// tier's 10/min limit no matter how many clients have the page open at once.
// "/matches" also folds in the upstream /scorers endpoint (see
// fetchFromCacheOrUpstream/resolveScorers below) into the same single cached
// payload — that second upstream call only happens when a goal actually
// happened somewhere, so it barely adds to the call budget above.
export const ROUTES = {
  "/matches": { upstreamPath: "matches", ttlSeconds: 15 },
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

// A second, non-expiring key holding the last successful upstream response,
// kept alongside the short-TTL cache entry above so an upstream outage after
// that TTL expires can still be served something instead of a bare error.
function staleCacheKeyFor(cacheKey) {
  return `${cacheKey}:stale`;
}

// Falls back to the stale entry (if any) when a real upstream call fails;
// otherwise returns the error response callers would have gotten anyway.
// Marked with X-Cache-Status so a future client-side change could surface
// "data might be outdated" if wanted.
async function staleOrErrorResponse(cache, staleCacheKey, buildErrorResponse) {
  const stale = await cache.get(staleCacheKey);
  if (stale == null) return buildErrorResponse();
  return new Response(stale, {
    headers: { "Content-Type": "application/json", "X-Cache-Status": "stale" },
  });
}

// Sums goals across every match with a recorded score (scheduled fixtures
// contribute nothing) — used to detect whether a goal happened anywhere
// since the last cached snapshot, the signal that decides whether /scorers
// is worth a real upstream call.
export function totalGoals(matches) {
  return matches.reduce((sum, m) => {
    const fullTime = m.score?.fullTime;
    if (fullTime?.home == null || fullTime?.away == null) return sum;
    return sum + fullTime.home + fullTime.away;
  }, 0);
}

// football-data.org's /scorers shape -> this project's flat {name, team, goals}.
export function mapScorers(apiScorers) {
  return (apiScorers ?? []).map((s) => ({
    name: s.player?.name ?? null,
    team: s.team?.name ?? null,
    goals: s.goals,
  }));
}

// Network failure and a non-ok upstream status both throw here (unlike a
// bare fetch(), which only throws on the former) so both are handled by one
// catch at each call site — a non-ok response's status/body ride along on
// the error so the matches call site can still pass them through unchanged.
async function fetchUpstreamOrThrow(upstreamPath, apiKey, fetchUpstream) {
  const res = await fetchUpstream(buildUpstreamUrl(upstreamPath), {
    headers: { "X-Auth-Token": apiKey },
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Upstream ${upstreamPath} request failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Only refetches /scorers from upstream when goals moved since the previous
// snapshot (or there is no previous snapshot yet, i.e. first population) —
// reuses the previous snapshot's scorers otherwise. A failure fetching
// scorers specifically falls back to the previous snapshot's scorers (or
// none) rather than failing the whole /matches response — scorers is
// supplementary, unlike the matches data itself.
async function resolveScorers({ newTotalGoals, previousTotalGoals, previousScorers, apiKey, fetchUpstream }) {
  if (previousTotalGoals != null && previousTotalGoals === newTotalGoals) {
    return previousScorers;
  }
  try {
    const body = await fetchUpstreamOrThrow("scorers", apiKey, fetchUpstream);
    return mapScorers(JSON.parse(body).scorers);
  } catch {
    return previousScorers;
  }
}

// cache/fetchUpstream are injected (rather than reaching for env.MATCH_CACHE
// and global fetch directly) so this can be unit-tested with fakes, no real
// KV namespace or network access needed.
export async function fetchFromCacheOrUpstream(route, apiKey, cache, fetchUpstream) {
  const cacheKey = route.upstreamPath;
  const staleCacheKey = staleCacheKeyFor(cacheKey);
  const cached = await cache.get(cacheKey);
  if (cached != null) {
    return new Response(cached, { headers: { "Content-Type": "application/json" } });
  }

  let matchesBody;
  try {
    matchesBody = await fetchUpstreamOrThrow(route.upstreamPath, apiKey, fetchUpstream);
  } catch (err) {
    // A network-level failure (DNS, timeout, connection reset) has no
    // err.status, unlike a football-data.org error status — both end up
    // as a normal Response with CORS headers, not an unhandled-exception
    // 500 from the Workers runtime itself.
    if (err.status != null) {
      return staleOrErrorResponse(cache, staleCacheKey, () =>
        new Response(err.body, { status: err.status, headers: { "Content-Type": "application/json" } })
      );
    }
    return staleOrErrorResponse(cache, staleCacheKey, () =>
      new Response(JSON.stringify({ error: `Upstream request failed: ${err.message}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  const matches = JSON.parse(matchesBody).matches ?? [];
  const newTotalGoals = totalGoals(matches);

  // The non-expiring stale entry doubles as "the previous snapshot" here —
  // it always holds the last successful combined payload, whether or not
  // the short-TTL cache entry above it has expired.
  const staleRaw = await cache.get(staleCacheKey);
  const previousSnapshot = staleRaw ? JSON.parse(staleRaw) : null;
  const scorers = await resolveScorers({
    newTotalGoals,
    previousTotalGoals: previousSnapshot ? totalGoals(previousSnapshot.matches) : null,
    previousScorers: previousSnapshot?.scorers ?? [],
    apiKey,
    fetchUpstream,
  });

  const body = JSON.stringify({ matches, scorers });
  await cache.put(cacheKey, body, { expirationTtl: route.ttlSeconds });
  await cache.put(staleCacheKey, body);
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
