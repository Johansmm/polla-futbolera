const test = require("node:test");
const assert = require("node:assert/strict");

// worker/src/index.mjs is a real ES module so it can be loaded here via
// dynamic import() even though this test file itself is CommonJS (per the
// root package.json) — same pattern as test/scoring-logic.test.js for
// js/scoring-logic.mjs.
let resolveRoute;
let buildUpstreamUrl;
let withCors;
let totalGoals;
let mapScorers;
let fetchFromCacheOrUpstream;
let handleRequest;
let MATCH_CACHE_TTL_SECONDS;

test.before(async () => {
  ({ resolveRoute, buildUpstreamUrl, withCors, totalGoals, mapScorers, fetchFromCacheOrUpstream, handleRequest } =
    await import("../worker/src/index.mjs"));
  ({ MATCH_CACHE_TTL_SECONDS } = await import("../js/football-data-config.mjs"));
});

// A minimal in-memory stand-in for the MATCH_CACHE KV binding, so these
// tests need no real Cloudflare KV namespace.
function fakeCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      puts.push({ key, value, opts });
    },
    puts,
  };
}

// Routes fetchUpstream calls by the URL's trailing path segment ("matches"
// vs "scorers") so a single fake can stand in for both upstream endpoints.
function fakeUpstream({ matches, scorers, matchesStatus = 200, scorersStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith("/scorers")) {
      return new Response(JSON.stringify({ scorers: scorers ?? [] }), { status: scorersStatus });
    }
    return new Response(JSON.stringify({ matches: matches ?? [] }), { status: matchesStatus });
  };
  fn.calls = calls;
  return fn;
}

function matchWithGoals(home, away) {
  return { score: { fullTime: { home, away } } };
}

test("resolveRoute recognizes the exposed route and rejects anything else", () => {
  assert.deepEqual(resolveRoute("/matches"), { upstreamPath: "matches", ttlSeconds: MATCH_CACHE_TTL_SECONDS });
  assert.equal(resolveRoute("/scorers"), undefined);
  assert.equal(resolveRoute("/"), undefined);
});

test("buildUpstreamUrl points at the WC competition on football-data.org v4", () => {
  assert.equal(buildUpstreamUrl("matches"), "https://api.football-data.org/v4/competitions/WC/matches");
  assert.equal(buildUpstreamUrl("scorers"), "https://api.football-data.org/v4/competitions/WC/scorers");
});

test("withCors preserves status and body while adding CORS headers", async () => {
  const original = new Response("hello", { status: 201, headers: { "Content-Type": "text/plain" } });
  const wrapped = withCors(original);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await wrapped.text(), "hello");
});

test("totalGoals sums fullTime scores across matches, ignoring ones with no score yet", () => {
  const matches = [matchWithGoals(2, 1), matchWithGoals(0, 0), { score: { fullTime: { home: null, away: null } } }];
  assert.equal(totalGoals(matches), 3);
});

test("mapScorers flattens football-data.org's nested player/team shape", () => {
  const apiScorers = [
    { player: { name: "Kylian Mbappe" }, team: { name: "France" }, goals: 8 },
    { player: { name: "Lionel Messi" }, team: { name: "Argentina" }, goals: 7 },
  ];
  assert.deepEqual(mapScorers(apiScorers), [
    { name: "Kylian Mbappe", team: "France", goals: 8 },
    { name: "Lionel Messi", team: "Argentina", goals: 7 },
  ]);
});

test("mapScorers returns an empty list for a missing/undefined scorers field", () => {
  assert.deepEqual(mapScorers(undefined), []);
});

test("fetchFromCacheOrUpstream serves from cache without calling upstream on a hit", async () => {
  const cache = fakeCache({ matches: '{"matches":[],"scorers":[]}' });
  const fetchUpstream = async () => {
    throw new Error("should not be called on a cache hit");
  };
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(await res.text(), '{"matches":[],"scorers":[]}');
});

test("fetchFromCacheOrUpstream calls upstream and populates the cache on a miss, fetching scorers on first population", async () => {
  const upstream = fakeUpstream({
    matches: [matchWithGoals(1, 0)],
    scorers: [{ player: { name: "Mbappe" }, team: { name: "France" }, goals: 1 }],
  });
  const cache = fakeCache();
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "test-api-key", cache, upstream);

  const body = JSON.parse(await res.text());
  assert.deepEqual(body.matches, [matchWithGoals(1, 0)]);
  assert.deepEqual(body.scorers, [{ name: "Mbappe", team: "France", goals: 1 }]);

  assert.equal(upstream.calls.length, 2);
  assert.equal(upstream.calls[0].url, "https://api.football-data.org/v4/competitions/WC/matches");
  assert.equal(upstream.calls[0].opts.headers["X-Auth-Token"], "test-api-key");
  assert.equal(upstream.calls[1].url, "https://api.football-data.org/v4/competitions/WC/scorers");

  const shortTtlPut = cache.puts.find((p) => p.key === "matches");
  assert.equal(shortTtlPut.value, JSON.stringify(body));
  assert.equal(shortTtlPut.opts.expirationTtl, 60);
});

test("fetchFromCacheOrUpstream reuses the previous snapshot's scorers when total goals haven't changed", async () => {
  const previousSnapshot = JSON.stringify({
    matches: [matchWithGoals(1, 0)],
    scorers: [{ name: "Mbappe", team: "France", goals: 1 }],
  });
  const cache = fakeCache({ "matches:stale": previousSnapshot });
  const upstream = fakeUpstream({ matches: [matchWithGoals(1, 0)] }); // same total goals as before (1)

  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, upstream);
  const body = JSON.parse(await res.text());

  assert.deepEqual(body.scorers, [{ name: "Mbappe", team: "France", goals: 1 }]);
  // Only the matches endpoint was hit — scorers was reused, not refetched.
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, "https://api.football-data.org/v4/competitions/WC/matches");
});

test("fetchFromCacheOrUpstream refetches scorers once total goals change since the previous snapshot", async () => {
  const previousSnapshot = JSON.stringify({
    matches: [matchWithGoals(1, 0)],
    scorers: [{ name: "Mbappe", team: "France", goals: 1 }],
  });
  const cache = fakeCache({ "matches:stale": previousSnapshot });
  const upstream = fakeUpstream({
    matches: [matchWithGoals(2, 0)], // a new goal was scored — total goals moved from 1 to 2
    scorers: [{ player: { name: "Mbappe" }, team: { name: "France" }, goals: 2 }],
  });

  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, upstream);
  const body = JSON.parse(await res.text());

  assert.deepEqual(body.scorers, [{ name: "Mbappe", team: "France", goals: 2 }]);
  assert.equal(upstream.calls.length, 2);
});

test("fetchFromCacheOrUpstream falls back to the previous snapshot's scorers when the scorers refetch itself fails", async () => {
  const previousSnapshot = JSON.stringify({
    matches: [matchWithGoals(1, 0)],
    scorers: [{ name: "Mbappe", team: "France", goals: 1 }],
  });
  const cache = fakeCache({ "matches:stale": previousSnapshot });
  const upstream = fakeUpstream({ matches: [matchWithGoals(2, 0)], scorersStatus: 429 });

  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, upstream);
  const body = JSON.parse(await res.text());

  // Matches data still updates even though the supplementary scorers call failed.
  assert.deepEqual(body.matches, [matchWithGoals(2, 0)]);
  assert.deepEqual(body.scorers, [{ name: "Mbappe", team: "France", goals: 1 }]);
});

test("fetchFromCacheOrUpstream passes through a failed matches upstream response without caching it", async () => {
  const cache = fakeCache();
  const fetchUpstream = async () => new Response('{"error":"rate limited"}', { status: 429 });
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 429);
  assert.equal(cache.puts.length, 0);
});

test("fetchFromCacheOrUpstream returns a 502 with CORS-able JSON when the network call itself throws", async () => {
  const cache = fakeCache();
  const fetchUpstream = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.football-data.org");
  };
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 502);
  const body = JSON.parse(await res.text());
  assert.match(body.error, /ENOTFOUND/);
  assert.equal(cache.puts.length, 0);
});

test("fetchFromCacheOrUpstream populates the stale fallback key alongside the short-TTL cache on success", async () => {
  const upstream = fakeUpstream({ matches: [] });
  const cache = fakeCache();
  await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, upstream);
  assert.equal(cache.puts.length, 2);
  assert.deepEqual(
    cache.puts.map((p) => p.key).sort(),
    ["matches", "matches:stale"]
  );
  const stalePut = cache.puts.find((p) => p.key === "matches:stale");
  assert.equal(stalePut.value, JSON.stringify({ matches: [], scorers: [] }));
  assert.equal(stalePut.opts, undefined);
});

test("fetchFromCacheOrUpstream falls back to stale data instead of erroring when the network call throws", async () => {
  const cache = fakeCache({ "matches:stale": '{"matches":[],"scorers":[]}' });
  const fetchUpstream = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.football-data.org");
  };
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"matches":[],"scorers":[]}');
  assert.equal(res.headers.get("X-Cache-Status"), "stale");
});

test("fetchFromCacheOrUpstream falls back to stale data instead of erroring on a failed upstream response", async () => {
  const cache = fakeCache({ "matches:stale": '{"matches":[],"scorers":[]}' });
  const fetchUpstream = async () => new Response('{"error":"rate limited"}', { status: 429 });
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"matches":[],"scorers":[]}');
  assert.equal(res.headers.get("X-Cache-Status"), "stale");
});

test("handleRequest answers CORS preflight requests", async () => {
  const request = new Request("https://worker.example/matches", { method: "OPTIONS" });
  const res = await handleRequest(request, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleRequest 404s on an unrecognized path", async () => {
  const request = new Request("https://worker.example/unknown", { method: "GET" });
  const res = await handleRequest(request, { API_KEY: "key", MATCH_CACHE: fakeCache() });
  assert.equal(res.status, 404);
});

test("handleRequest 405s on a non-GET request to a known route", async () => {
  const request = new Request("https://worker.example/matches", { method: "POST" });
  const res = await handleRequest(request, { API_KEY: "key", MATCH_CACHE: fakeCache() });
  assert.equal(res.status, 405);
});

test("handleRequest 500s with a clear message when API_KEY isn't configured", async () => {
  const request = new Request("https://worker.example/matches", { method: "GET" });
  const res = await handleRequest(request, { MATCH_CACHE: fakeCache() });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /API_KEY/);
});

test("handleRequest serves a known route end to end on a cache hit", async () => {
  const request = new Request("https://worker.example/matches", { method: "GET" });
  const cache = fakeCache({ matches: '{"matches":[],"scorers":[]}' });
  const res = await handleRequest(request, { API_KEY: "key", MATCH_CACHE: cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await res.text(), '{"matches":[],"scorers":[]}');
});
