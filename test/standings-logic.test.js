const test = require("node:test");
const assert = require("node:assert/strict");

const DAY = 24 * 60 * 60 * 1000;

// js/standings-logic.mjs is a real ES module so it can be loaded here via
// dynamic import() even though this test file itself is CommonJS — same
// pattern as test/scoring-logic.test.js. standings.js itself can't be
// tested this way (it imports the Firebase SDK from a CDN URL), so this is
// the closest thing to an end-to-end test of "does standings computation
// still produce the same results" (issue #48) available without adding a
// browser-automation dependency this project doesn't otherwise need.
let mergeMatchData;
let selectScorableMatches;
let computeStandingsFromData;

test.before(async () => {
  ({ mergeMatchData } = await import("../js/worker-matches.mjs"));
  ({ selectScorableMatches, computeStandingsFromData } = await import("../js/standings-logic.mjs"));
});

const SCORING_CONFIG = {
  match_outcome_points: { exact_score: 5, correct_winner_and_difference: 3, correct_winner_or_draw: 1, miss: 0 },
  phase_multipliers: { r16: 1, final: 3 },
  special_predictions: {
    champion: { exact_champion: 8, finalist: 3 },
    top_scorer: { exact: 10, top_3: 5, team_reaches_semifinal_or_final_bonus: 3 },
  },
};

// mergeMatchData takes a Map keyed by the source's own match id — this
// builds one from a plain array of fixtures, the shape that's easiest to
// write test data as.
function toSourceMap(matches) {
  return new Map(matches.map((m) => [m.id, m]));
}

function buildScenario() {
  const finishedR16 = mergeMatchData(
    { id: "r16_01", match_id: "r16_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 1 },
    toSourceMap([
      {
        id: 1,
        stage: "LAST_16",
        status: "FINISHED",
        homeTeam: { name: "Canada", crest: null },
        awayTeam: { name: "Morocco", crest: null },
        score: { duration: "REGULAR", fullTime: { home: 2, away: 1 } },
      },
    ])
  );

  // Kickoff far in the future — not locked yet, so selectScorableMatches
  // must exclude it even though it has a configured multiplier.
  const upcomingR16 = mergeMatchData(
    { id: "r16_02", match_id: "r16_02", kickoff_at: new Date(Date.now() + 2 * DAY), source_match_id: 2 },
    toSourceMap([
      {
        id: 2,
        stage: "LAST_16",
        status: "SCHEDULED",
        homeTeam: { name: "Spain", crest: null },
        awayTeam: { name: "Japan", crest: null },
        score: { fullTime: { home: null, away: null } },
      },
    ])
  );

  const final = mergeMatchData(
    { id: "final_01", match_id: "final_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 3 },
    toSourceMap([
      {
        id: 3,
        stage: "FINAL",
        status: "FINISHED",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "Brazil", crest: null },
        score: { duration: "REGULAR", fullTime: { home: 2, away: 0 } },
      },
    ])
  );

  return { finishedR16, upcomingR16, final };
}

test("selectScorableMatches keeps only locked matches with a configured phase multiplier", () => {
  const { finishedR16, upcomingR16, final } = buildScenario();
  const scorable = selectScorableMatches([finishedR16, upcomingR16, final], SCORING_CONFIG);
  assert.deepEqual(
    scorable.map((m) => m.id),
    ["r16_01", "final_01"]
  );
});

test("computeStandingsFromData scores match and champion picks, ranks, and builds breakdown sections", () => {
  const { finishedR16, upcomingR16, final } = buildScenario();
  const matches = [finishedR16, upcomingR16, final];

  const users = [
    { user_id: "alice", name: "Alice" },
    { user_id: "bob", name: "Bob" },
  ];

  // Alice: exact score on r16 (5) + exact score on final, x3 multiplier (15) + exact champion (8) = 28.
  // Bob: correct winner/wrong margin on r16 (1) + same on final, x3 multiplier (3) + finalist pick (3) = 7.
  const predictionsByMatch = {
    r16_01: {
      alice: { predicted_score_a: 2, predicted_score_b: 1 },
      bob: { predicted_score_a: 3, predicted_score_b: 1 },
    },
    final_01: {
      alice: { predicted_score_a: 2, predicted_score_b: 0 },
      bob: { predicted_score_a: 1, predicted_score_b: 0 },
    },
  };

  const specialPicks = {
    alice: { champion_pick: "Argentina" },
    bob: { champion_pick: "Brazil" },
  };

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches,
    rosters: [],
    tournamentResults: null,
    predictionsByMatch,
    specialPicks,
    specialRevealed: true,
  });

  assert.equal(result.totalScorableMatches, 2);
  assert.equal(result.championDecided, true);
  assert.equal(result.anyMatchLive, false);

  const alice = result.rows.find((r) => r.userId === "alice");
  const bob = result.rows.find((r) => r.userId === "bob");

  assert.equal(alice.matchPoints, 5 + 3 * 5); // r16 exact (5) + final exact, x3 multiplier (15)
  assert.equal(alice.championPoints, 8);
  assert.equal(alice.total, 5 + 15 + 8);
  assert.equal(alice.exactHits, 2);

  assert.equal(bob.matchPoints, 1 + 3 * 1); // r16 correct-winner-wrong-margin (1) + final correct-winner-or-draw x3 (3)
  assert.equal(bob.championPoints, 3); // finalist, not champion
  assert.equal(bob.total, 1 + 3 + 3);

  assert.equal(result.rows[0].userId, "alice");
  assert.equal(result.rows[0].rank, 1);
  assert.equal(result.rows[1].rank, 2);

  const averageTotal = (alice.total + bob.total) / 2;
  assert.equal(alice.vsAverage, alice.total - averageTotal);

  assert.equal(result.matchSections.length, 2);
  assert.equal(result.specialSections.length, 2);
});

test("computeStandingsFromData marks a scorable match with no prediction as a miss, not pending", () => {
  const { finishedR16 } = buildScenario();
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16],
    rosters: [],
    tournamentResults: null,
    predictionsByMatch: { r16_01: {} },
    specialPicks: {},
    specialRevealed: false,
  });

  const alice = result.rows[0];
  assert.equal(alice.predictionsSubmitted, 0);
  assert.equal(alice.matchPoints, 0);
  assert.equal(alice.matchBreakdown.r16_01.points, 0);
  assert.equal(result.specialSections.length, 0);
});
