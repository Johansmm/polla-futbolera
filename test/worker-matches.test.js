const test = require("node:test");
const assert = require("node:assert/strict");

// js/worker-matches.mjs is a real ES module so it can be loaded here via
// dynamic import() even though this test file itself is CommonJS (per the
// root package.json) — same pattern as test/scoring-logic.test.js for
// js/scoring-logic.mjs.
let resolvePhase;
let buildResultFields;
let buildLiveScoreFields;
let mergeMatchData;

test.before(async () => {
  ({ resolvePhase, buildResultFields, buildLiveScoreFields, mergeMatchData } = await import(
    "../js/worker-matches.mjs"
  ));
});

// mergeMatchData takes a Map keyed by the source's own match id (see its
// own comment for why) — this builds one from a plain array of fixtures,
// the shape that's easiest to write test data as.
function toSourceMap(matches) {
  return new Map(matches.map((m) => [m.id, m]));
}

test("resolvePhase translates the five knockout stages this project cares about", () => {
  assert.equal(resolvePhase("LAST_16"), "r16");
  assert.equal(resolvePhase("QUARTER_FINALS"), "qf");
  assert.equal(resolvePhase("SEMI_FINALS"), "sf");
  assert.equal(resolvePhase("THIRD_PLACE"), "third_place");
  assert.equal(resolvePhase("FINAL"), "final");
});

test("resolvePhase passes unknown stages through as-is (group stage, Round of 32)", () => {
  assert.equal(resolvePhase("GROUP_STAGE"), "GROUP_STAGE");
  assert.equal(resolvePhase("LAST_32"), "LAST_32");
});

test("buildResultFields is empty until the match is finished", () => {
  assert.deepEqual(buildResultFields({ status: "SCHEDULED" }), {});
  assert.deepEqual(buildResultFields({ status: "IN_PLAY" }), {});
  assert.deepEqual(buildResultFields({ status: "PAUSED" }), {});
});

test("buildResultFields falls back to fullTime when regularTime is absent (regular-time finish)", () => {
  const apiMatch = {
    status: "FINISHED",
    score: { duration: "REGULAR", fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } },
  };
  assert.deepEqual(buildResultFields(apiMatch), { real_score_a: 2, real_score_b: 1 });
});

test("buildResultFields adds extra-time goals for a match decided in extra time", () => {
  const apiMatch = {
    status: "FINISHED",
    score: {
      duration: "EXTRA_TIME",
      fullTime: { home: 3, away: 2 },
      regularTime: { home: 2, away: 2 },
      extraTime: { home: 1, away: 0 },
    },
  };
  assert.deepEqual(buildResultFields(apiMatch), { real_score_a: 3, real_score_b: 2 });
});

test("buildResultFields excludes penalty-shootout goals from the stored result", () => {
  // football-data.org's own example: regularTime 1-1, extraTime 0-0, penalties 6-5 -> fullTime 7-6.
  const apiMatch = {
    status: "FINISHED",
    score: {
      duration: "PENALTY_SHOOTOUT",
      fullTime: { home: 7, away: 6 },
      regularTime: { home: 1, away: 1 },
      extraTime: { home: 0, away: 0 },
      penalties: { home: 6, away: 5 },
    },
  };
  assert.deepEqual(buildResultFields(apiMatch), { real_score_a: 1, real_score_b: 1 });
});

test("buildLiveScoreFields is empty before kickoff", () => {
  assert.deepEqual(buildLiveScoreFields({ status: "SCHEDULED" }), {});
});

test("buildLiveScoreFields extracts the running score while in play or paused", () => {
  const apiMatch = { status: "IN_PLAY", score: { fullTime: { home: 1, away: 0 } } };
  assert.deepEqual(buildLiveScoreFields(apiMatch), { live_score_a: 1, live_score_b: 0 });
  assert.deepEqual(buildLiveScoreFields({ ...apiMatch, status: "PAUSED" }), { live_score_a: 1, live_score_b: 0 });
});

test("buildLiveScoreFields clears the live score once the match is finished", () => {
  const apiMatch = { status: "FINISHED", score: { fullTime: { home: 2, away: 1 } } };
  assert.deepEqual(buildLiveScoreFields(apiMatch), { live_score_a: null, live_score_b: null });
});

test("mergeMatchData returns the Firestore match unchanged when no source match is found", () => {
  const firestoreMatch = { id: "r16_01", match_id: "r16_01", kickoff_at: "2026-07-04T19:00:00Z", source_match_id: 42 };
  assert.deepEqual(mergeMatchData(firestoreMatch, new Map()), firestoreMatch);
});

test("mergeMatchData merges team, crest, and phase fields for a scheduled match", () => {
  const firestoreMatch = { match_id: "r16_01", kickoff_at: "2026-07-04T19:00:00Z", source_match_id: 42 };
  const sourceMatches = toSourceMap([
    {
      id: 42,
      stage: "LAST_16",
      status: "SCHEDULED",
      homeTeam: { name: "Canada", crest: "https://crests/canada.svg" },
      awayTeam: { name: "Morocco", crest: "https://crests/morocco.svg" },
      score: { fullTime: { home: null, away: null } },
    },
  ]);

  assert.deepEqual(mergeMatchData(firestoreMatch, sourceMatches), {
    match_id: "r16_01",
    kickoff_at: "2026-07-04T19:00:00Z",
    source_match_id: 42,
    phase: "r16",
    team_a: "Canada",
    team_b: "Morocco",
    team_a_crest_url: "https://crests/canada.svg",
    team_b_crest_url: "https://crests/morocco.svg",
  });
});

test("mergeMatchData merges the live score for a match in progress", () => {
  const firestoreMatch = { match_id: "r16_01", kickoff_at: "2026-07-04T19:00:00Z", source_match_id: 42 };
  const sourceMatches = toSourceMap([
    {
      id: 42,
      stage: "LAST_16",
      status: "IN_PLAY",
      homeTeam: { name: "Canada", crest: null },
      awayTeam: { name: "Morocco", crest: null },
      score: { fullTime: { home: 1, away: 0 } },
    },
  ]);

  const merged = mergeMatchData(firestoreMatch, sourceMatches);
  assert.equal(merged.live_score_a, 1);
  assert.equal(merged.live_score_b, 0);
  assert.equal(merged.real_score_a, undefined);
});

test("mergeMatchData merges the final result for a finished match", () => {
  const firestoreMatch = { match_id: "r16_01", kickoff_at: "2026-07-04T19:00:00Z", source_match_id: 42 };
  const sourceMatches = toSourceMap([
    {
      id: 42,
      stage: "LAST_16",
      status: "FINISHED",
      homeTeam: { name: "Canada", crest: null },
      awayTeam: { name: "Morocco", crest: null },
      score: { duration: "REGULAR", fullTime: { home: 2, away: 1 } },
    },
  ]);

  const merged = mergeMatchData(firestoreMatch, sourceMatches);
  assert.equal(merged.real_score_a, 2);
  assert.equal(merged.real_score_b, 1);
  assert.equal(merged.live_score_a, null);
  assert.equal(merged.live_score_b, null);
});
