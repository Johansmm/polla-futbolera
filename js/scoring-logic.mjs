// Pure scoring logic — no network/Firestore calls, no stored/precomputed
// points anywhere. A future standings page reads matches/predictions
// (public once a match's deadline passes) and special_predictions (public
// once specialPredictionsDeadlinePassed(false), see firestore.rules) directly,
// and calls
// these functions to compute everyone's points on the fly. Kept in its own
// dependency-free module (note the .mjs extension, same reasoning as
// lock-logic.mjs) so it can be unit-tested directly with node:test via
// dynamic import().
//
// All functions take the relevant slice of scoring_config.json explicitly
// as a parameter rather than importing the file directly, so this stays a
// pure module usable from both a browser fetch() and a Node test.

// Outcome tiers are mutually exclusive — the highest applicable tier wins,
// they never stack. Returns both the points and whether it was an exact
// hit, since the tiebreaker (most exact scores) can't be reverse-engineered
// from the final points alone once phase multipliers are mixed in.
export function scoreMatch(prediction, match, matchOutcomePoints) {
  const { predicted_score_a: pa, predicted_score_b: pb } = prediction;
  const { real_score_a: ra, real_score_b: rb } = match;

  const exactScoreHit = pa === ra && pb === rb;
  if (exactScoreHit) {
    return { outcomePoints: matchOutcomePoints.exact_score, exactScoreHit: true };
  }

  const predictedDiff = pa - pb;
  const realDiff = ra - rb;
  const correctWinnerOrDraw = Math.sign(predictedDiff) === Math.sign(realDiff);

  if (!correctWinnerOrDraw) {
    return { outcomePoints: matchOutcomePoints.miss, exactScoreHit: false };
  }

  // "Correct winner + correct difference" only makes sense for a decisive
  // result — a draw always has a difference of 0, so a correctly-predicted
  // draw belongs in the lower tier below regardless of the exact scoreline,
  // not this one just because 0 === 0.
  const correctDecisiveMargin = realDiff !== 0 && predictedDiff === realDiff;

  const outcomePoints = correctDecisiveMargin
    ? matchOutcomePoints.correct_winner_and_difference
    : matchOutcomePoints.correct_winner_or_draw;

  return { outcomePoints, exactScoreHit: false };
}

export function calculateChampionPoints(championPick, { champion, finalists }, championConfig) {
  if (championPick === champion) return championConfig.exact_champion;
  if (finalists.includes(championPick)) return championConfig.finalist;
  return 0;
}

// pickTeam is the team the picked player belongs to (look up via
// findTeamForPlayer against team_rosters), or null if not found.
export function calculateTopScorerPoints(
  topScorerPick,
  { topScorer, top3Scorers, pickTeam, semifinalists },
  topScorerConfig
) {
  let points = 0;
  if (topScorerPick === topScorer) {
    points = topScorerConfig.exact;
  } else if (top3Scorers.includes(topScorerPick)) {
    points = topScorerConfig.top_3;
  }

  if (points > 0 && pickTeam && semifinalists.includes(pickTeam)) {
    points += topScorerConfig.team_reaches_semifinal_or_final_bonus;
  }

  return points;
}

export function findTeamForPlayer(rosters, player) {
  return rosters.find((r) => r.players.includes(player))?.team ?? null;
}
