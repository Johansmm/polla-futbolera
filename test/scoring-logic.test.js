const test = require("node:test");
const assert = require("node:assert/strict");

// js/scoring-logic.mjs is a real ES module (note the extension) so it can
// be loaded here via dynamic import() even though this test file itself is
// CommonJS (per the root package.json).
let scoreMatch;
let calculateChampionPoints;
let calculateTopScorerPoints;
let findTeamForPlayer;

test.before(async () => {
  ({ scoreMatch, calculateChampionPoints, calculateTopScorerPoints, findTeamForPlayer } = await import(
    "../js/scoring-logic.mjs"
  ));
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

test("findTeamForPlayer finds the team owning a given player", () => {
  const rosters = [
    { team: "France", players: ["Kylian Mbappé"] },
    { team: "Argentina", players: ["Lionel Messi"] },
  ];
  assert.equal(findTeamForPlayer(rosters, "Lionel Messi"), "Argentina");
});

test("findTeamForPlayer returns null when no team has that player", () => {
  const rosters = [{ team: "France", players: ["Kylian Mbappé"] }];
  assert.equal(findTeamForPlayer(rosters, "Someone Else"), null);
});
