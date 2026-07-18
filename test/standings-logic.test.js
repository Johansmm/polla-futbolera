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
let computePointsEvolution;
let hasMatchNeedingRefresh;
let selectNewlyScorableMatches;

test.before(async () => {
  ({ mergeMatchData } = await import("../js/worker-matches.mjs"));
  ({
    selectScorableMatches,
    computeStandingsFromData,
    computePointsEvolution,
    hasMatchNeedingRefresh,
    selectNewlyScorableMatches,
  } = await import("../js/standings-logic.mjs"));
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

  // Each special section's own scoring rules — read from scoringConfig at
  // render time, shown right next to that section's picks/points instead of
  // the generic scoring-help summary (issue #63).
  assert.match(championSection.rules, /8 pts/);
  assert.match(championSection.rules, /3 pts/);
  assert.match(topScorerSection.rules, /10 pts/);
  assert.match(topScorerSection.rules, /5 pts/);
  assert.match(topScorerSection.rules, /3 pts/);

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

// The end-to-end version of the deriveChampion penalty regression: a Final
// settled on penalties is level on real_score_a/b by design, which used to
// leave every player on 0 champion points — not just the champion tier, but
// the finalist tier with it, since the whole call was gated on a champion
// being known.
test("computeStandingsFromData scores a Final that was decided on penalties", () => {
  const penaltyFinal = mergeMatchData(
    { id: "final_01", match_id: "final_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 3 },
    toSourceMap([
      {
        id: 3,
        stage: "FINAL",
        status: "FINISHED",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "France", crest: null },
        score: {
          duration: "PENALTY_SHOOTOUT",
          fullTime: { home: 5, away: 3 },
          regularTime: { home: 1, away: 1 },
          extraTime: { home: 0, away: 0 },
          penalties: { home: 4, away: 2 },
        },
      },
    ])
  );

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users: [
      { user_id: "alice", name: "Alice" },
      { user_id: "bob", name: "Bob" },
    ],
    matches: [penaltyFinal],
    tournamentResults: null,
    predictionsByMatch: {},
    specialPicks: {
      alice: { champion_pick: "Argentina" }, // the actual (shootout) champion
      bob: { champion_pick: "France" }, // reached the Final, lost it
    },
    specialRevealed: true,
    scorers: [],
  });

  assert.equal(result.championDecided, true);
  assert.equal(result.championIsFinal, true);

  const alice = result.rows.find((r) => r.userId === "alice");
  const bob = result.rows.find((r) => r.userId === "bob");
  assert.equal(alice.championPoints, 8); // exact champion, despite the level scoreline
  assert.equal(bob.championPoints, 3); // finalist

  // The scoreline the pool grades predictions against still excludes the
  // shootout — a predicted 1-1 draw is an exact hit here.
  assert.equal(penaltyFinal.real_score_a, 1);
  assert.equal(penaltyFinal.real_score_b, 1);
});

// The finalist tier only depends on the Final's line-up, so it must pay out
// while the Final is still unplayed — it used to be suppressed entirely until
// a champion existed.
test("computeStandingsFromData awards finalist points before the Final is played", () => {
  const unplayedFinal = mergeMatchData(
    { id: "final_01", match_id: "final_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 3 },
    toSourceMap([
      {
        id: 3,
        stage: "FINAL",
        status: "SCHEDULED",
        homeTeam: { name: "Argentina", crest: null },
        awayTeam: { name: "France", crest: null },
        score: { fullTime: { home: null, away: null } },
      },
    ])
  );

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users: [{ user_id: "alice", name: "Alice" }],
    matches: [unplayedFinal],
    tournamentResults: null,
    predictionsByMatch: {},
    specialPicks: { alice: { champion_pick: "France" } },
    specialRevealed: true,
    scorers: [],
  });

  assert.equal(result.championDecided, false);
  assert.equal(result.finalistsKnown, true);
  assert.equal(result.rows[0].championPoints, 3);
});

// Everyone tying on 0 is not a five-way lead — the crown marks an actual
// best pick, so a section nobody scored in has no leader at all.
test("computeStandingsFromData crowns nobody in a section where everyone scored 0", () => {
  const { finishedR16 } = buildScenario(); // Canada 2-1 Morocco

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users: [
      { user_id: "alice", name: "Alice" },
      { user_id: "bob", name: "Bob" },
    ],
    matches: [finishedR16],
    tournamentResults: null,
    predictionsByMatch: {
      r16_01: {
        alice: { predicted_score_a: 0, predicted_score_b: 3 }, // wrong winner
        bob: { predicted_score_a: 1, predicted_score_b: 2 }, // wrong winner
      },
    },
    specialPicks: {},
    specialRevealed: false,
    scorers: [],
  });

  const [matchSection] = result.matchSections;
  assert.deepEqual(
    matchSection.entries.map((e) => e.points),
    [0, 0]
  );
  assert.ok(matchSection.entries.every((e) => e.top === false));
});

// computePointsEvolution (issue #24) — the running-total series behind the
// standings page's points-evolution chart.
test("computePointsEvolution steps through resolved matches in kickoff order, skipping a locked-but-unresolved one", () => {
  const { finishedR16, upcomingR16, final } = buildScenario();
  // finishedR16 kicked off before `final`; upcomingR16 is locked-but-unresolved
  // in a real scenario, but here it's still SCHEDULED (see buildScenario), so
  // it should be excluded from scorableMatches entirely regardless.
  const scorableMatches = selectScorableMatches([finishedR16, upcomingR16, final], SCORING_CONFIG);

  const users = [
    { user_id: "alice", name: "Alice" },
    { user_id: "bob", name: "Bob" },
  ];
  const predictionsByMatch = {
    r16_01: {
      alice: { predicted_score_a: 2, predicted_score_b: 1 }, // exact (5)
      bob: { predicted_score_a: 0, predicted_score_b: 0 }, // miss (0)
    },
    final_01: {
      alice: { predicted_score_a: 1, predicted_score_b: 0 }, // correct winner/wrong margin, x3 (3)
      bob: { predicted_score_a: 2, predicted_score_b: 0 }, // exact, x3 (15)
    },
  };

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16, upcomingR16, final],
    tournamentResults: null,
    predictionsByMatch,
    specialPicks: {},
    specialRevealed: false,
  });

  const evolution = computePointsEvolution(result.rows, scorableMatches, false, SCORING_CONFIG);
  assert.deepEqual(
    evolution.steps.map((s) => s.matchId),
    ["r16_01", "final_01"]
  );

  const alice = evolution.series.find((s) => s.name === "Alice");
  const bob = evolution.series.find((s) => s.name === "Bob");
  assert.deepEqual(alice.values, [5, 5 + 3]);
  assert.deepEqual(bob.values, [0, 0 + 15]);
  // stepPoints is each match's own contribution, un-accumulated — what the
  // standings page's "per match" chart view plots, since the cumulative
  // total alone can't show who had one match carry their whole score.
  assert.deepEqual(alice.stepPoints, [5, 3]);
  assert.deepEqual(bob.stepPoints, [0, 15]);

  // average mirrors computeStandingsFromData's row.vsAverage baseline — the
  // group mean at each step, for the chart's reference line.
  assert.deepEqual(evolution.average.values, [(5 + 0) / 2, (8 + 15) / 2]);
  assert.deepEqual(evolution.average.stepPoints, [(5 + 0) / 2, (3 + 15) / 2]);

  // maxPoints is the theoretical ceiling (exact score × phase multiplier),
  // not the highest score anyone actually got — the heatmap view normalizes
  // color intensity against this so a modest round doesn't display as if
  // someone maxed it out.
  assert.deepEqual(
    evolution.steps.map((s) => s.maxPoints),
    [5 * 1, 5 * 3]
  );
});

test("computePointsEvolution adds a trailing step for champion/top-scorer points once special picks are revealed", () => {
  const { finishedR16, final } = buildScenario();
  const scorableMatches = selectScorableMatches([finishedR16, final], SCORING_CONFIG);
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16, final],
    tournamentResults: null,
    predictionsByMatch: { r16_01: {}, final_01: {} },
    specialPicks: { alice: { champion_pick: "Argentina" } }, // exact champion (8)
    specialRevealed: true,
  });

  const evolution = computePointsEvolution(result.rows, scorableMatches, true, SCORING_CONFIG);
  assert.equal(evolution.steps.length, 3);
  assert.equal(evolution.steps.at(-1).label, "Special picks");

  const [alice] = evolution.series;
  assert.equal(alice.values.length, 3);
  assert.equal(alice.values.at(-1), alice.values.at(-2) + 8);
});

test("computePointsEvolution numbers axis labels per phase (R1, R2, …), stable regardless of resolve order", () => {
  const r16Match1 = mergeMatchData(
    { id: "r16_01", match_id: "r16_01", kickoff_at: new Date(Date.now() - 2 * DAY), source_match_id: 1 },
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
  // r16_02 kicked off after r16_01 but hasn't resolved yet — its axis
  // position must still be reserved as "R2", not silently skipped/relabeled
  // once it eventually finishes.
  const r16Match2 = mergeMatchData(
    { id: "r16_02", match_id: "r16_02", kickoff_at: new Date(Date.now() - DAY), source_match_id: 2 },
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
  const finalMatch = mergeMatchData(
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

  const matches = [r16Match1, r16Match2, finalMatch];
  const scorableMatches = selectScorableMatches(matches, SCORING_CONFIG);
  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users: [{ user_id: "alice", name: "Alice" }],
    matches,
    tournamentResults: null,
    predictionsByMatch: { r16_01: {}, final_01: {} },
    specialPicks: {},
    specialRevealed: false,
  });

  const evolution = computePointsEvolution(result.rows, scorableMatches, false, SCORING_CONFIG);
  // r16_02 is locked-but-unresolved (still SCHEDULED), so it contributes no
  // step of its own — but it still occupies "R2" in the counting, so
  // r16_01 stays "R1" rather than being renumbered once r16_02 resolves.
  assert.deepEqual(
    evolution.steps.map((s) => s.shortLabel),
    ["R1", "F"]
  );
});

test("computePointsEvolution includes a currently-live match as a step, using its provisional score", () => {
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
  const matches = [finishedR16, liveFinal];
  const scorableMatches = selectScorableMatches(matches, SCORING_CONFIG);
  const users = [{ user_id: "alice", name: "Alice" }];

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches,
    tournamentResults: null,
    predictionsByMatch: {
      r16_01: { alice: { predicted_score_a: 2, predicted_score_b: 1 } }, // exact (5)
      final_01: { alice: { predicted_score_a: 1, predicted_score_b: 0 } }, // exact vs. the live score, x3 (15)
    },
    specialPicks: {},
    specialRevealed: false,
  });

  const evolution = computePointsEvolution(result.rows, scorableMatches, false, SCORING_CONFIG);
  assert.deepEqual(
    evolution.steps.map((s) => s.matchId),
    ["r16_01", "final_01"]
  );
  assert.equal(evolution.steps[1].shortLabel, "F \u{1F534}");
  assert.match(evolution.steps[1].label, /\(Live\)$/);

  const [alice] = evolution.series;
  assert.deepEqual(alice.values, [5, 5 + 15]);
});

test("computePointsEvolution sorts series alphabetically by name, independent of the rows' rank order", () => {
  const { finishedR16 } = buildScenario();
  const scorableMatches = selectScorableMatches([finishedR16], SCORING_CONFIG);

  // Zoe outranks Alice on points, so `rows` (sorted by rank) lists Zoe
  // first — the chart's series order must not follow that.
  const users = [
    { user_id: "alice", name: "Alice" },
    { user_id: "zoe", name: "Zoe" },
  ];
  const predictionsByMatch = {
    r16_01: {
      alice: { predicted_score_a: 0, predicted_score_b: 0 }, // miss
      zoe: { predicted_score_a: 2, predicted_score_b: 1 }, // exact
    },
  };

  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users,
    matches: [finishedR16],
    tournamentResults: null,
    predictionsByMatch,
    specialPicks: {},
    specialRevealed: false,
  });
  assert.equal(result.rows[0].name, "Zoe"); // ranked first

  const evolution = computePointsEvolution(result.rows, scorableMatches, false, SCORING_CONFIG);
  assert.deepEqual(
    evolution.series.map((s) => s.name),
    ["Alice", "Zoe"]
  );
});

test("computePointsEvolution returns no steps when nothing has finished yet", () => {
  const { upcomingR16 } = buildScenario();
  const scorableMatches = selectScorableMatches([upcomingR16], SCORING_CONFIG);
  const result = computeStandingsFromData({
    scoringConfig: SCORING_CONFIG,
    users: [{ user_id: "alice", name: "Alice" }],
    matches: [upcomingR16],
    tournamentResults: null,
    predictionsByMatch: {},
    specialPicks: {},
    specialRevealed: false,
  });

  const evolution = computePointsEvolution(result.rows, scorableMatches, false, SCORING_CONFIG);
  assert.deepEqual(evolution.steps, []);
  assert.deepEqual(evolution.series[0].values, []);
});

// hasMatchNeedingRefresh backs standings.js's poll loop: a network-free
// check deciding whether a Worker refetch is even worth doing.
test("hasMatchNeedingRefresh is false when nothing has kicked off yet", () => {
  const { upcomingR16 } = buildScenario();
  assert.equal(hasMatchNeedingRefresh([upcomingR16], SCORING_CONFIG), false);
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
  assert.equal(hasMatchNeedingRefresh([live], SCORING_CONFIG), true);
});

test("hasMatchNeedingRefresh is false once every kicked-off match has a real score", () => {
  const { finishedR16 } = buildScenario();
  assert.equal(hasMatchNeedingRefresh([finishedR16], SCORING_CONFIG), false);
});

// admin/seed.js seeds the whole competition, so a phase this pool doesn't
// score can sit locked and result-less forever (a postponed group match, say)
// — it can't change anything on screen, so it must not keep the loop running.
test("hasMatchNeedingRefresh ignores a locked, result-less match in an unscored phase", () => {
  const groupMatch = mergeMatchData(
    { id: "GROUP_STAGE_01", match_id: "GROUP_STAGE_01", kickoff_at: new Date(Date.now() - DAY), source_match_id: 7 },
    toSourceMap([
      {
        id: 7,
        stage: "GROUP_STAGE",
        status: "POSTPONED",
        homeTeam: { name: "Qatar", crest: null },
        awayTeam: { name: "Ecuador", crest: null },
        score: { fullTime: { home: null, away: null } },
      },
    ])
  );
  assert.equal(hasMatchNeedingRefresh([groupMatch], SCORING_CONFIG), false);
});

// ...but a match the Worker hasn't resolved at all has no phase to judge it
// by, and giving up on it would strand the page for good on a Worker outage
// that later recovers.
test("hasMatchNeedingRefresh still refreshes a locked match the Worker hasn't resolved yet", () => {
  const unresolved = mergeMatchData(
    { id: "r16_09", match_id: "r16_09", kickoff_at: new Date(Date.now() - DAY), source_match_id: 99 },
    new Map()
  );
  assert.equal(unresolved.phase, undefined);
  assert.equal(hasMatchNeedingRefresh([unresolved], SCORING_CONFIG), true);
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
