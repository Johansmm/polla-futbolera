const test = require("node:test");
const assert = require("node:assert/strict");

// Covers issue #48: js/scoring-logic.mjs itself never changed (it's still
// tested in isolation in test/scoring-logic.test.js with hand-built match
// objects) — what needed verifying is that a match produced by
// js/worker-matches.mjs's mergeMatchData() (real football-data.org response
// shape in, this project's internal shape out) feeds scoring-logic.mjs
// correctly end to end, with no adapter code in between.
let mergeMatchData;
let scoreMatchBreakdown;
let isMatchLive;
let effectiveScore;
let finishedMatches;
let deriveChampion;
let deriveSemifinalists;

test.before(async () => {
  ({ mergeMatchData } = await import("../js/worker-matches.mjs"));
  ({ scoreMatchBreakdown, isMatchLive, effectiveScore, finishedMatches, deriveChampion, deriveSemifinalists } =
    await import("../js/scoring-logic.mjs"));
});

const MATCH_OUTCOME_POINTS = {
  exact_score: 5,
  correct_winner_and_difference: 3,
  correct_winner_or_draw: 1,
  miss: 0,
};

// mergeMatchData takes a Map keyed by the source's own match id — this
// builds one from a plain array of fixtures, the shape that's easiest to
// write test data as.
function toSourceMap(matches) {
  return new Map(matches.map((m) => [m.id, m]));
}

test("a finished match merged from the Worker scores an exact hit correctly", () => {
  const firestoreMatch = {
    id: "r16_01",
    match_id: "r16_01",
    kickoff_at: new Date("2026-07-04T19:00:00Z"),
    source_match_id: 498001,
  };
  const sourceMatches = toSourceMap([
    {
      id: 498001,
      stage: "LAST_16",
      status: "FINISHED",
      homeTeam: { name: "Canada", crest: null },
      awayTeam: { name: "Morocco", crest: null },
      score: { duration: "REGULAR", fullTime: { home: 2, away: 1 } },
    },
  ]);

  const match = mergeMatchData(firestoreMatch, sourceMatches);
  assert.equal(match.phase, "r16");
  assert.equal(match.team_a, "Canada");
  assert.equal(match.team_b, "Morocco");
  assert.equal(match.real_score_a, 2);
  assert.equal(match.real_score_b, 1);
  assert.equal(isMatchLive(match), false);
  assert.deepEqual(finishedMatches([match]), [match]);

  const prediction = { predicted_score_a: 2, predicted_score_b: 1 };
  const { points, exactScoreHit } = scoreMatchBreakdown(
    prediction,
    effectiveScore(match),
    true,
    MATCH_OUTCOME_POINTS,
    1 // r16 multiplier
  );

  assert.equal(points, 5);
  assert.equal(exactScoreHit, true);
});

test("a live match merged from the Worker sources provisional points from the live score", () => {
  const firestoreMatch = {
    id: "r16_02",
    match_id: "r16_02",
    kickoff_at: new Date("2026-07-04T19:00:00Z"),
    source_match_id: 498002,
  };
  const sourceMatches = toSourceMap([
    {
      id: 498002,
      stage: "LAST_16",
      status: "IN_PLAY",
      homeTeam: { name: "Paraguay", crest: null },
      awayTeam: { name: "France", crest: null },
      score: { fullTime: { home: 1, away: 0 } },
    },
  ]);

  const match = mergeMatchData(firestoreMatch, sourceMatches);
  assert.equal(match.live_score_a, 1);
  assert.equal(match.live_score_b, 0);
  assert.equal(match.real_score_a, undefined);
  assert.equal(isMatchLive(match), true);
  assert.deepEqual(finishedMatches([match]), []);

  const prediction = { predicted_score_a: 1, predicted_score_b: 0 };
  const { points, exactScoreHit } = scoreMatchBreakdown(
    prediction,
    effectiveScore(match),
    isMatchLive(match),
    MATCH_OUTCOME_POINTS,
    1
  );

  assert.equal(points, 5);
  assert.equal(exactScoreHit, true);
});

test("a scheduled match merged from the Worker is pending, not a miss", () => {
  const firestoreMatch = {
    id: "r16_03",
    match_id: "r16_03",
    kickoff_at: new Date("2026-07-05T19:00:00Z"),
    source_match_id: 498003,
  };
  const sourceMatches = toSourceMap([
    {
      id: 498003,
      stage: "LAST_16",
      status: "SCHEDULED",
      homeTeam: { name: "Spain", crest: null },
      awayTeam: { name: "Japan", crest: null },
      score: { fullTime: { home: null, away: null } },
    },
  ]);

  const match = mergeMatchData(firestoreMatch, sourceMatches);
  assert.equal(isMatchLive(match), false);
  assert.deepEqual(finishedMatches([match]), []);

  const { points } = scoreMatchBreakdown(
    { predicted_score_a: 1, predicted_score_b: 0 },
    effectiveScore(match),
    false, // not locked/finished yet
    MATCH_OUTCOME_POINTS,
    1
  );

  assert.equal(points, null);
});

test("deriveChampion and deriveSemifinalists work off Worker-merged team names", () => {
  const final = mergeMatchData(
    { match_id: "final_01", source_match_id: 1 },
    toSourceMap([
      {
        id: 1,
        stage: "FINAL",
        status: "FINISHED",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "Brazil", crest: null },
        score: { duration: "REGULAR", fullTime: { home: 2, away: 0 } },
      },
    ])
  );
  const semifinal = mergeMatchData(
    { match_id: "sf_01", source_match_id: 2 },
    toSourceMap([
      {
        id: 2,
        stage: "SEMI_FINALS",
        status: "FINISHED",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "France", crest: null },
        score: { duration: "REGULAR", fullTime: { home: 3, away: 1 } },
      },
    ])
  );

  const matches = [final, semifinal];
  assert.deepEqual(deriveChampion(matches), { champion: "Argentina", finalists: ["Argentina", "Brazil"] });
  assert.deepEqual(deriveSemifinalists(matches), ["Argentina", "France"]);
});
