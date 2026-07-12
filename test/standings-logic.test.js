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
let hasMatchNeedingRefresh;
let selectNewlyScorableMatches;

test.before(async () => {
  ({ mergeMatchData } = await import("../js/worker-matches.mjs"));
  ({ selectScorableMatches, computeStandingsFromData, hasMatchNeedingRefresh, selectNewlyScorableMatches } =
    await import("../js/standings-logic.mjs"));
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
    tournamentResults: null,
    predictionsByMatch,
    specialPicks,
    specialRevealed: true,
  });

  assert.equal(result.totalScorableMatches, 2);
  assert.equal(result.championDecided, true);
  assert.equal(result.championIsFinal, true);
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

// Each breakdown section (match-by-match and special picks alike) ranks by
// its own points, independent of the overall standings order — a user
// leading the general table can still trail in, say, the champion pick
// section, and that section must reflect its own leader, not the general
// table's.
test("specialSections rank entries by that section's own points, not the overall standings order, and flag the leader", () => {
  const { finishedR16, final } = buildScenario();
  const matches = [finishedR16, final];

  const users = [
    { user_id: "alice", name: "Alice" },
    { user_id: "bob", name: "Bob" },
  ];

  // Alice wins the overall table on match points alone; Bob barely scores
  // any match points but nails the champion and top scorer picks.
  const predictionsByMatch = {
    r16_01: {
      alice: { predicted_score_a: 2, predicted_score_b: 1 }, // exact
      bob: { predicted_score_a: 0, predicted_score_b: 2 }, // miss
    },
    final_01: {
      alice: { predicted_score_a: 2, predicted_score_b: 0 }, // exact
      bob: { predicted_score_a: 0, predicted_score_b: 2 }, // miss
    },
  };

  const specialPicks = {
    alice: { champion_pick: "Brazil", top_scorer_pick: "Mbappe" }, // finalist pick, top_3
    bob: { champion_pick: "Argentina", top_scorer_pick: "Messi" }, // exact champion, exact scorer
  };

  const scorers = [
    { name: "Messi", team: "Argentina", goals: 8 },
    { name: "Mbappe", team: "France", goals: 6 },
  ];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches,
    tournamentResults: null,
    predictionsByMatch,
    specialPicks,
    specialRevealed: true,
    scorers,
  });

  const alice = result.rows.find((r) => r.userId === "alice");
  const bob = result.rows.find((r) => r.userId === "bob");
  assert.ok(alice.total > bob.total); // Alice leads the overall table...
  assert.ok(bob.championPoints > alice.championPoints); // ...but Bob wins the champion pick...
  assert.ok(bob.topScorerPoints > alice.topScorerPoints); // ...and the top scorer pick.

  const [championSection, topScorerSection] = result.specialSections;

  assert.deepEqual(
    championSection.entries.map((e) => e.name),
    ["Bob", "Alice"]
  );
  assert.equal(championSection.entries[0].top, true);
  assert.equal(championSection.entries[1].top, false);

  assert.deepEqual(
    topScorerSection.entries.map((e) => e.name),
    ["Bob", "Alice"]
  );
  assert.equal(topScorerSection.entries[0].top, true);
  assert.equal(topScorerSection.entries[1].top, false);
});

test("computeStandingsFromData marks a scorable match with no prediction as a miss, not pending", () => {
  const { finishedR16 } = buildScenario();
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16],
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

test("computeStandingsFromData applies the semifinal/final bonus using the pick's stored top_scorer_pick_team", () => {
  const { finishedR16 } = buildScenario();
  // deriveSemifinalists only looks at phase/team_a/team_b — no need to run
  // this through mergeMatchData like the other fixtures above.
  const sfMatch = { id: "sf_01", phase: "sf", team_a: "Argentina", team_b: "Croatia" };
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16, sfMatch],
    tournamentResults: { top_scorer: "Lionel Messi", top_3_scorers: [] },
    predictionsByMatch: { r16_01: {} },
    specialPicks: { alice: { top_scorer_pick: "Lionel Messi", top_scorer_pick_team: "Argentina" } },
    specialRevealed: true,
  });

  const alice = result.rows[0];
  assert.equal(alice.topScorerPoints, 10 + 3); // exact (10) + team reached the semifinal (3)
  assert.equal(result.topScorerIsFinal, true);
});

// Live-derived top scorer points, sourced from the Worker's /scorers list,
// stand in as a provisional signal until config/tournament_results.top_scorer
// is set — issue #62.
test("computeStandingsFromData derives provisional top scorer points from the live scorers list when no admin result is set yet", () => {
  const { finishedR16 } = buildScenario();
  const sfMatch = { id: "sf_01", phase: "sf", team_a: "Argentina", team_b: "Croatia" };
  const users = [{ user_id: "alice", name: "Alice" }, { user_id: "bob", name: "Bob" }];

  const scorers = [
    { name: "Lionel Messi", team: "Argentina", goals: 8 },
    { name: "Kylian Mbappe", team: "France", goals: 7 },
  ];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16, sfMatch],
    tournamentResults: null,
    predictionsByMatch: { r16_01: {} },
    specialPicks: {
      alice: { top_scorer_pick: "Lionel Messi", top_scorer_pick_team: "Argentina" },
      bob: { top_scorer_pick: "Kylian Mbappe", top_scorer_pick_team: "France" },
    },
    specialRevealed: true,
    scorers,
  });

  assert.equal(result.topScorerIsFinal, false);
  assert.equal(result.topScorerKnown, true);

  const alice = result.rows.find((r) => r.userId === "alice");
  const bob = result.rows.find((r) => r.userId === "bob");
  assert.equal(alice.topScorerPoints, 10 + 3); // sole live leader (exact) + semifinal bonus
  // Only two distinct goal counts (8, 7) exist, so top3's threshold falls
  // back to the lower one — Mbappe (7 goals) lands in top3, not a miss.
  assert.equal(bob.topScorerPoints, 5); // top_3, no bonus — France isn't in this scenario's semifinalists

  assert.match(result.specialSections[1].title, /Current leader: Lionel Messi \(8 goals\)/);
});

// Live-derived champion points, sourced from the Final's live score, stand
// in as a provisional signal until the admin confirms the result — issue
// #64, the champion-pick counterpart to the top-scorer live test above.
test("computeStandingsFromData derives provisional champion points from the Final's live score", () => {
  const { finishedR16 } = buildScenario();
  const liveFinal = mergeMatchData(
    { id: "final_01", match_id: "final_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 3 },
    toSourceMap([
      {
        id: 3,
        stage: "FINAL",
        status: "IN_PLAY",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "Brazil", crest: null },
        score: { duration: "REGULAR", fullTime: { home: 1, away: 0 } },
      },
    ])
  );
  const users = [
    { user_id: "alice", name: "Alice" },
    { user_id: "bob", name: "Bob" },
  ];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16, liveFinal],
    tournamentResults: null,
    predictionsByMatch: { r16_01: {} },
    specialPicks: {
      alice: { champion_pick: "Argentina" },
      bob: { champion_pick: "Brazil" },
    },
    specialRevealed: true,
  });

  assert.equal(result.championDecided, true);
  assert.equal(result.championIsFinal, false);
  assert.equal(result.anyMatchLive, true);

  const alice = result.rows.find((r) => r.userId === "alice");
  const bob = result.rows.find((r) => r.userId === "bob");
  assert.equal(alice.championPoints, 8); // provisional exact champion
  assert.equal(bob.championPoints, 3); // still a finalist
});

test("computeStandingsFromData respects the admin-set top scorer once present, ignoring the live scorers list", () => {
  const { finishedR16 } = buildScenario();
  const users = [{ user_id: "alice", name: "Alice" }];

  const scorers = [{ name: "Kylian Mbappe", team: "France", goals: 8 }]; // live leader differs from the admin's final pick

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16],
    tournamentResults: { top_scorer: "Lionel Messi", top_3_scorers: [] },
    predictionsByMatch: { r16_01: {} },
    specialPicks: { alice: { top_scorer_pick: "Lionel Messi" } },
    specialRevealed: true,
    scorers,
  });

  assert.equal(result.topScorerIsFinal, true);
  assert.equal(result.rows[0].topScorerPoints, 10);
});

test("computeStandingsFromData reports no known top scorer before a single goal has been scored anywhere", () => {
  const { finishedR16 } = buildScenario();
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16],
    tournamentResults: null,
    predictionsByMatch: { r16_01: {} },
    specialPicks: { alice: { top_scorer_pick: "Lionel Messi" } },
    specialRevealed: true,
    scorers: [],
  });

  assert.equal(result.topScorerKnown, false);
  assert.equal(result.topScorerIsFinal, false);
  assert.equal(result.rows[0].topScorerPoints, 0);
});

// hasMatchNeedingRefresh backs standings.js's poll loop: a network-free
// check deciding whether a Worker refetch is even worth doing.
test("hasMatchNeedingRefresh is false when nothing has kicked off yet", () => {
  const { upcomingR16 } = buildScenario();
  assert.equal(hasMatchNeedingRefresh([upcomingR16]), false);
});

test("hasMatchNeedingRefresh is true for a match that's kicked off with no result yet", () => {
  const live = mergeMatchData(
    { id: "r16_03", match_id: "r16_03", kickoff_at: new Date(Date.now() - DAY), source_match_id: 4 },
    toSourceMap([
      {
        id: 4,
        stage: "LAST_16",
        status: "IN_PLAY",
        homeTeam: { name: "France", crest: null },
        awayTeam: { name: "Germany", crest: null },
        score: { fullTime: { home: 1, away: 0 } },
      },
    ])
  );
  assert.equal(hasMatchNeedingRefresh([live]), true);
});

test("hasMatchNeedingRefresh is false once every kicked-off match has a real score", () => {
  const { finishedR16 } = buildScenario();
  assert.equal(hasMatchNeedingRefresh([finishedR16]), false);
});

// selectNewlyScorableMatches backs the poll loop's one-time-per-match
// predictions fetch for matches that just crossed into "locked".
test("selectNewlyScorableMatches returns only scorable matches not already fetched", () => {
  const { finishedR16, upcomingR16, final } = buildScenario();
  const matches = [finishedR16, upcomingR16, final];
  const alreadyFetched = new Set(["r16_01"]);
  const newlyLocked = selectNewlyScorableMatches(matches, SCORING_CONFIG, alreadyFetched);
  assert.deepEqual(
    newlyLocked.map((m) => m.id),
    ["final_01"]
  );
});

test("selectNewlyScorableMatches returns nothing once everything scorable is already fetched", () => {
  const { finishedR16, final } = buildScenario();
  const alreadyFetched = new Set(["r16_01", "final_01"]);
  const newlyLocked = selectNewlyScorableMatches([finishedR16, final], SCORING_CONFIG, alreadyFetched);
  assert.deepEqual(newlyLocked, []);
});
