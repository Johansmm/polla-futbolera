const test = require("node:test");
const assert = require("node:assert/strict");

// js/scoring-logic.mjs is a real ES module (note the extension) so it can
// be loaded here via dynamic import() even though this test file itself is
// CommonJS (per the root package.json).
let scoreMatch;
let scoreMatchBreakdown;
let calculateChampionPoints;
let calculateTopScorerPoints;
let finishedMatches;
let deriveChampion;
let deriveSemifinalists;
let deriveTopScorers;
let isMatchLive;
let effectiveScore;

test.before(async () => {
  ({
    scoreMatch,
    scoreMatchBreakdown,
    calculateChampionPoints,
    calculateTopScorerPoints,
    finishedMatches,
    deriveChampion,
    deriveSemifinalists,
    deriveTopScorers,
    isMatchLive,
    effectiveScore,
  } = await import("../js/scoring-logic.mjs"));
});

const MATCH_OUTCOME_POINTS = {
  exact_score: 5,
  correct_winner_and_difference: 3,
  correct_winner_or_draw: 1,
  miss: 0,
};

const CHAMPION_CONFIG = { exact_champion: 8, finalist: 3 };
const TOP_SCORER_CONFIG = { exact: 10, top_3: 5, team_reaches_semifinal_or_final_bonus: 3 };

test("scoreMatch awards exact_score for a perfect match", () => {
  const result = scoreMatch(
    { predicted_score_a: 2, predicted_score_b: 1 },
    { real_score_a: 2, real_score_b: 1 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 5, exactScoreHit: true });
});

test("scoreMatch awards correct_winner_and_difference for the same margin, different score", () => {
  const result = scoreMatch(
    { predicted_score_a: 2, predicted_score_b: 1 },
    { real_score_a: 3, real_score_b: 2 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 3, exactScoreHit: false });
});

test("scoreMatch awards correct_winner_or_draw for the right winner, wrong margin", () => {
  const result = scoreMatch(
    { predicted_score_a: 1, predicted_score_b: 0 },
    { real_score_a: 3, real_score_b: 0 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 1, exactScoreHit: false });
});

test("scoreMatch awards correct_winner_or_draw for correctly predicting a draw", () => {
  const result = scoreMatch(
    { predicted_score_a: 1, predicted_score_b: 1 },
    { real_score_a: 2, real_score_b: 2 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 1, exactScoreHit: false });
});

test("scoreMatch awards miss for the wrong winner", () => {
  const result = scoreMatch(
    { predicted_score_a: 2, predicted_score_b: 0 },
    { real_score_a: 0, real_score_b: 1 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 0, exactScoreHit: false });
});

test("scoreMatch awards miss for predicting a draw when there wasn't one", () => {
  const result = scoreMatch(
    { predicted_score_a: 1, predicted_score_b: 1 },
    { real_score_a: 2, real_score_b: 1 },
    MATCH_OUTCOME_POINTS
  );
  assert.deepEqual(result, { outcomePoints: 0, exactScoreHit: false });
});

test("scoreMatchBreakdown marks an unfinished (locked, no result yet) match as pending, even with a submitted prediction", () => {
  const result = scoreMatchBreakdown(
    { predicted_score_a: 2, predicted_score_b: 1 },
    { real_score_a: null, real_score_b: null },
    false,
    MATCH_OUTCOME_POINTS,
    1
  );
  assert.deepEqual(result, { points: null, exactScoreHit: false });
});

test("scoreMatchBreakdown marks an unfinished match as pending even with no prediction submitted", () => {
  const result = scoreMatchBreakdown(
    null,
    { real_score_a: null, real_score_b: null },
    false,
    MATCH_OUTCOME_POINTS,
    1
  );
  assert.deepEqual(result, { points: null, exactScoreHit: false });
});

test("scoreMatchBreakdown scores a finished match with no submission as a miss (0), not pending", () => {
  const result = scoreMatchBreakdown(
    null,
    { real_score_a: 2, real_score_b: 1 },
    true,
    MATCH_OUTCOME_POINTS,
    1
  );
  assert.deepEqual(result, { points: 0, exactScoreHit: false });
});

test("scoreMatchBreakdown applies the phase multiplier to a finished match's outcome points", () => {
  const result = scoreMatchBreakdown(
    { predicted_score_a: 2, predicted_score_b: 1 },
    { real_score_a: 2, real_score_b: 1 },
    true,
    MATCH_OUTCOME_POINTS,
    2
  );
  assert.deepEqual(result, { points: 10, exactScoreHit: true }); // 5 (exact_score) * 2 (multiplier)
});

test("calculateChampionPoints awards exact_champion for the right pick", () => {
  const points = calculateChampionPoints(
    "Argentina",
    { champion: "Argentina", finalists: ["Argentina", "France"] },
    CHAMPION_CONFIG
  );
  assert.equal(points, 8);
});

test("calculateChampionPoints awards finalist for a runner-up pick", () => {
  const points = calculateChampionPoints(
    "France",
    { champion: "Argentina", finalists: ["Argentina", "France"] },
    CHAMPION_CONFIG
  );
  assert.equal(points, 3);
});

test("calculateChampionPoints awards nothing for a team that didn't reach the final", () => {
  const points = calculateChampionPoints(
    "Brazil",
    { champion: "Argentina", finalists: ["Argentina", "France"] },
    CHAMPION_CONFIG
  );
  assert.equal(points, 0);
});

test("calculateTopScorerPoints awards exact plus the team bonus", () => {
  const points = calculateTopScorerPoints(
    "Messi",
    {
      topScorer: "Messi",
      top3Scorers: ["Messi", "Mbappe", "Julian Alvarez"],
      pickTeam: "Argentina",
      semifinalists: ["Argentina", "France", "Croatia", "Morocco"],
    },
    TOP_SCORER_CONFIG
  );
  assert.equal(points, 13); // 10 exact + 3 team bonus
});

test("calculateTopScorerPoints awards top_3 without the bonus when the team didn't reach the semifinal", () => {
  const points = calculateTopScorerPoints(
    "Mbappe",
    {
      topScorer: "Messi",
      top3Scorers: ["Messi", "Mbappe", "Julian Alvarez"],
      pickTeam: "Poland",
      semifinalists: ["Argentina", "France", "Croatia", "Morocco"],
    },
    TOP_SCORER_CONFIG
  );
  assert.equal(points, 5);
});

test("calculateTopScorerPoints never awards the team bonus outside the top 3", () => {
  const points = calculateTopScorerPoints(
    "Random Player",
    {
      topScorer: "Messi",
      top3Scorers: ["Messi", "Mbappe", "Julian Alvarez"],
      pickTeam: "Argentina", // team reached the semifinal, but the pick itself missed entirely
      semifinalists: ["Argentina", "France", "Croatia", "Morocco"],
    },
    TOP_SCORER_CONFIG
  );
  assert.equal(points, 0);
});

test("calculateTopScorerPoints accepts an array of tied live-derived leaders, awarding exact for either one", () => {
  const context = {
    topScorer: ["Messi", "Mbappe"], // live-derived, tied for the lead
    top3Scorers: ["Messi", "Mbappe", "Julian Alvarez"],
    pickTeam: "France",
    semifinalists: ["Argentina", "France", "Croatia", "Morocco"],
  };
  assert.equal(calculateTopScorerPoints("Mbappe", context, TOP_SCORER_CONFIG), 10 + 3);
  assert.equal(calculateTopScorerPoints("Messi", { ...context, pickTeam: "Argentina" }, TOP_SCORER_CONFIG), 10 + 3);
});

test("deriveTopScorers returns no leaders/top3 with no scorers yet", () => {
  assert.deepEqual(deriveTopScorers([]), { leaders: [], top3: [] });
});

test("deriveTopScorers ties multiple players for the lead when their goal counts match", () => {
  const scorers = [
    { name: "Mbappe", team: "France", goals: 8 },
    { name: "Messi", team: "Argentina", goals: 8 },
    { name: "Julian Alvarez", team: "Argentina", goals: 6 },
  ];
  const { leaders, top3 } = deriveTopScorers(scorers);
  assert.deepEqual(new Set(leaders), new Set(["Mbappe", "Messi"]));
  assert.deepEqual(new Set(top3), new Set(["Mbappe", "Messi", "Julian Alvarez"]));
});

// Real-data shape from the issue: 8/8/7/6 goals across 4 players — only
// 8/7/6 are distinct values, so the 3rd-highest distinct value (6) admits
// all 4 players into top3 instead of arbitrarily cutting one at a tie.
test("deriveTopScorers expands top3 past 3 players when a tie straddles the 3rd-distinct-value boundary", () => {
  const scorers = [
    { name: "A", team: "T1", goals: 8 },
    { name: "B", team: "T2", goals: 8 },
    { name: "C", team: "T3", goals: 7 },
    { name: "D", team: "T4", goals: 6 },
    { name: "E", team: "T5", goals: 5 },
  ];
  const { leaders, top3 } = deriveTopScorers(scorers);
  assert.deepEqual(new Set(leaders), new Set(["A", "B"]));
  assert.deepEqual(new Set(top3), new Set(["A", "B", "C", "D"]));
});

test("deriveTopScorers' top3 includes everyone when fewer than 3 distinct goal counts exist", () => {
  const scorers = [
    { name: "A", team: "T1", goals: 3 },
    { name: "B", team: "T2", goals: 2 },
  ];
  const { top3 } = deriveTopScorers(scorers);
  assert.deepEqual(new Set(top3), new Set(["A", "B"]));
});

test("finishedMatches keeps only matches with both real scores set", () => {
  const matches = [
    { match_id: "r16_01", real_score_a: 2, real_score_b: 1 },
    { match_id: "r16_02", real_score_a: null, real_score_b: null },
    { match_id: "r16_03", real_score_a: 0, real_score_b: null },
  ];
  assert.deepEqual(
    finishedMatches(matches).map((m) => m.match_id),
    ["r16_01"]
  );
});

test("isMatchLive is true once a live score is set and the real score isn't", () => {
  assert.equal(isMatchLive({ live_score_a: 1, live_score_b: 0, real_score_a: null, real_score_b: null }), true);
});

test("isMatchLive is false before kickoff, with neither score set", () => {
  assert.equal(isMatchLive({ live_score_a: null, live_score_b: null, real_score_a: null, real_score_b: null }), false);
});

test("isMatchLive is false once the real score is set, even if a live score lingers", () => {
  assert.equal(isMatchLive({ live_score_a: 1, live_score_b: 0, real_score_a: 1, real_score_b: 0 }), false);
});

test("effectiveScore substitutes the live score for real_score_a/b while live", () => {
  const match = { team_a: "Argentina", team_b: "France", live_score_a: 1, live_score_b: 0, real_score_a: null, real_score_b: null };
  assert.deepEqual(effectiveScore(match), { ...match, real_score_a: 1, real_score_b: 0 });
});

test("effectiveScore passes the match through unchanged once finished or before kickoff", () => {
  const finished = { real_score_a: 2, real_score_b: 1, live_score_a: null, live_score_b: null };
  assert.deepEqual(effectiveScore(finished), finished);

  const notStarted = { real_score_a: null, real_score_b: null, live_score_a: null, live_score_b: null };
  assert.deepEqual(effectiveScore(notStarted), notStarted);
});

test("deriveChampion returns no champion when the final hasn't been played yet", () => {
  const matches = [{ phase: "final", team_a: "Argentina", team_b: "France", real_score_a: null, real_score_b: null }];
  assert.deepEqual(deriveChampion(matches), { champion: null, finalists: ["Argentina", "France"] });
});

test("deriveChampion declares the winner once the final has a decisive score", () => {
  const matches = [{ phase: "final", team_a: "Argentina", team_b: "France", real_score_a: 3, real_score_b: 0 }];
  assert.deepEqual(deriveChampion(matches), { champion: "Argentina", finalists: ["Argentina", "France"] });
});

// A drawn final score (e.g. still awaiting the penalty-shootout result to be
// recorded as the decisive number) must not be mistaken for team_a winning —
// same "0 diff isn't a real result" pitfall scoreMatch already guards against.
test("deriveChampion awards no champion when the final's real score is a draw", () => {
  const matches = [{ phase: "final", team_a: "Argentina", team_b: "France", real_score_a: 1, real_score_b: 1 }];
  assert.deepEqual(deriveChampion(matches), { champion: null, finalists: ["Argentina", "France"] });
});

test("deriveChampion returns no finalists when the final match doesn't exist yet", () => {
  assert.deepEqual(deriveChampion([{ phase: "sf", team_a: "Argentina", team_b: "Croatia" }]), {
    champion: null,
    finalists: [],
  });
});

test("deriveSemifinalists collects every team from sf-phase matches, deduplicated", () => {
  const matches = [
    { phase: "sf", team_a: "Argentina", team_b: "Croatia" },
    { phase: "sf", team_a: "France", team_b: "Morocco" },
    { phase: "final", team_a: "Argentina", team_b: "France" },
  ];
  assert.deepEqual(
    new Set(deriveSemifinalists(matches)),
    new Set(["Argentina", "Croatia", "France", "Morocco"])
  );
});

test("deriveSemifinalists ignores matches whose teams aren't known yet", () => {
  const matches = [{ phase: "sf", team_a: null, team_b: null }];
  assert.deepEqual(deriveSemifinalists(matches), []);
});
