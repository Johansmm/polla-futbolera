const test = require("node:test");
const assert = require("node:assert/strict");

// worker/src/index.mjs is a real ES module so it can be loaded here via
// dynamic import() even though this test file itself is CommonJS (per the
// root package.json) — same pattern as test/scoring-logic.test.js for
// js/scoring-logic.mjs.
let resolveRoute;
let buildUpstreamUrl;
let withCors;
let fetchFromCacheOrUpstream;
let handleRequest;

test.before(async () => {
  ({ resolveRoute, buildUpstreamUrl, withCors, fetchFromCacheOrUpstream, handleRequest } = await import(
    "../worker/src/index.mjs"
  ));
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

test("resolveRoute recognizes the exposed route and rejects anything else", () => {
  assert.deepEqual(resolveRoute("/matches"), { upstreamPath: "matches", ttlSeconds: 60 });
  assert.equal(resolveRoute("/scorers"), undefined);
  assert.equal(resolveRoute("/"), undefined);
});

test("buildUpstreamUrl points at the WC competition on football-data.org v4", () => {
  assert.equal(buildUpstreamUrl("matches"), "https://api.football-data.org/v4/competitions/WC/matches");
});

test("withCors preserves status and body while adding CORS headers", async () => {
  const original = new Response("hello", { status: 201, headers: { "Content-Type": "text/plain" } });
  const wrapped = withCors(original);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await wrapped.text(), "hello");
});

test("fetchFromCacheOrUpstream serves from cache without calling upstream on a hit", async () => {
  const cache = fakeCache({ matches: '{"cached":true}' });
  const fetchUpstream = async () => {
    throw new Error("should not be called on a cache hit");
  };
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(await res.text(), '{"cached":true}');
});

test("fetchFromCacheOrUpstream calls upstream and populates the cache on a miss", async () => {
  const cache = fakeCache();
  const calls = [];
  const fetchUpstream = async (url, opts) => {
    calls.push({ url, opts });
    return new Response('{"fresh":true}', { status: 200 });
  };
  const res = await fetchFromCacheOrUpstream(
    { upstreamPath: "matches", ttlSeconds: 60 },
    "test-api-key",
    cache,
    fetchUpstream
  );
  assert.equal(await res.text(), '{"fresh":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.football-data.org/v4/competitions/WC/matches");
  assert.equal(calls[0].opts.headers["X-Auth-Token"], "test-api-key");
  const shortTtlPut = cache.puts.find((p) => p.key === "matches");
  assert.equal(shortTtlPut.value, '{"fresh":true}');
  assert.equal(shortTtlPut.opts.expirationTtl, 60);
});

test("fetchFromCacheOrUpstream passes through a failed upstream response without caching it", async () => {
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
  const cache = fakeCache();
  const fetchUpstream = async () => new Response('{"fresh":true}', { status: 200 });
  await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(cache.puts.length, 2);
  assert.deepEqual(
    cache.puts.map((p) => p.key).sort(),
    ["matches", "matches:stale"]
  );
  const stalePut = cache.puts.find((p) => p.key === "matches:stale");
  assert.equal(stalePut.value, '{"fresh":true}');
  assert.equal(stalePut.opts, undefined);
});

test("fetchFromCacheOrUpstream falls back to stale data instead of erroring when the network call throws", async () => {
  const cache = fakeCache({ "matches:stale": '{"stale":true}' });
  const fetchUpstream = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.football-data.org");
  };
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"stale":true}');
  assert.equal(res.headers.get("X-Cache-Status"), "stale");
});

test("fetchFromCacheOrUpstream falls back to stale data instead of erroring on a failed upstream response", async () => {
  const cache = fakeCache({ "matches:stale": '{"stale":true}' });
  const fetchUpstream = async () => new Response('{"error":"rate limited"}', { status: 429 });
  const res = await fetchFromCacheOrUpstream({ upstreamPath: "matches", ttlSeconds: 60 }, "key", cache, fetchUpstream);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"stale":true}');
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
  const cache = fakeCache({ matches: '{"matches":[]}' });
  const res = await handleRequest(request, { API_KEY: "key", MATCH_CACHE: cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await res.text(), '{"matches":[]}');
});
