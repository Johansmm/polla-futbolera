// Pure scoring logic — no network/Firestore calls, no stored/precomputed
// points anywhere. standings.js reads matches/predictions (public once a
// match's deadline passes) and special_predictions (public once
// specialPredictionsDeadlinePassed(false), see firestore.rules) directly,
// and calls these functions to compute everyone's points on the fly. Kept
// in its own dependency-free module (note the .mjs extension, same
// reasoning as lock-logic.mjs) so it can be unit-tested directly with
// node:test via dynamic import().
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

// A locked match without an admin-entered result yet has a publicly
// readable prediction (see firestore.rules' matchDeadlinePassed) but
// nothing to score against — that's "pending", distinct from a finished
// match with no submission at all, which is a genuine miss (0). Conflating
// the two would count an unscored match as a miss before the admin ever
// enters a result.
export function scoreMatchBreakdown(prediction, match, isFinished, matchOutcomePoints, phaseMultiplier) {
  if (!isFinished) {
    return { points: null, exactScoreHit: false };
  }
  if (!prediction) {
    return { points: 0, exactScoreHit: false };
  }
  const { outcomePoints, exactScoreHit } = scoreMatch(prediction, match, matchOutcomePoints);
  return { points: outcomePoints * phaseMultiplier, exactScoreHit };
}

// champion is null until the Final produces one (see deriveChampion) — the
// finalist tier still pays out in the meantime, so this is worth calling as
// soon as the Final has teams. Guards an unset pick explicitly, or a missing
// pick would match a null champion and score the top tier.
export function calculateChampionPoints(championPick, { champion, finalists }, championConfig) {
  if (!championPick) return 0;
  if (championPick === champion) return championConfig.exact_champion;
  if (finalists.includes(championPick)) return championConfig.finalist;
  return 0;
}

// pickTeam is the team the picked player belongs to, resolved once at
// special_predictions save time and stored on the pick as
// top_scorer_pick_team (js/special.js) — or null if unset (a pick made
// before that field existed).
//
// topScorer is either a string (the admin-set config/tournament_results.top_scorer,
// definitive) or an array (deriveTopScorers()'s live-derived leaders,
// provisional — possibly more than one name tied for the lead) — normalized
// to an array here so both cases share one inclusion check.
export function calculateTopScorerPoints(
  topScorerPick,
  { topScorer, top3Scorers, pickTeam, semifinalists },
  topScorerConfig
) {
  const topScorerNames = Array.isArray(topScorer) ? topScorer : [topScorer];

  let points = 0;
  if (topScorerNames.includes(topScorerPick)) {
    points = topScorerConfig.exact;
  } else if (top3Scorers.includes(topScorerPick)) {
    points = topScorerConfig.top_3;
  }

  if (points > 0 && pickTeam && semifinalists.includes(pickTeam)) {
    points += topScorerConfig.team_reaches_semifinal_or_final_bonus;
  }

  return points;
}

// Derives the tournament's current top scorer(s) from the Worker's live
// /scorers list — the provisional counterpart to config/tournament_results'
// admin-set, definitive top_scorer/top_3_scorers, used until that's set.
// leaders is everyone tied for the single highest goal count; top3 is
// everyone at or above the 3rd-highest *distinct* goal value, so a tie
// straddling that boundary expands the group instead of cutting it off
// arbitrarily (e.g. goal counts of 8/8/7/6 make top3 four players, not
// three, since only 8/7/6 are distinct values).
export function deriveTopScorers(scorers) {
  if (!scorers.length) return { leaders: [], top3: [] };

  const distinctGoals = [...new Set(scorers.map((s) => s.goals))].sort((a, b) => b - a);
  const maxGoals = distinctGoals[0];
  const top3Threshold = distinctGoals[Math.min(2, distinctGoals.length - 1)];

  return {
    leaders: scorers.filter((s) => s.goals === maxGoals).map((s) => s.name),
    top3: scorers.filter((s) => s.goals >= top3Threshold).map((s) => s.name),
  };
}

// A match is "live" once js/worker-matches.mjs has merged in a running
// score for it but no admin-entered final result yet — real_score_a/b
// always win once set.
export function isMatchLive(match) {
  return match.live_score_a != null && match.real_score_a == null;
}

// Swaps in the live score as a stand-in for real_score_a/b so the existing
// scoreMatch()/scoreMatchBreakdown() need no changes to compute provisional
// points. A no-op once real_score_a is set, or before the match has started.
export function effectiveScore(match) {
  return isMatchLive(match) ? { ...match, real_score_a: match.live_score_a, real_score_b: match.live_score_b } : match;
}

// Only matches with an admin-entered result count toward scoring — that's
// also always past that match's own deadline, so their predictions are
// guaranteed to be publicly readable by the time this runs.
export function finishedMatches(matches) {
  return matches.filter((m) => m.real_score_a != null && m.real_score_b != null);
}

// Champion/finalists aren't stored anywhere (see CLAUDE.md's schema notes)
// — derived from the final match's team_a/team_b (reaching the final) and
// who won it. championIsFinal tells callers (standings-logic.mjs) whether
// that champion is confirmed or still provisional.
//
// A *finished* Final is read from `winner` (js/worker-matches.mjs), never
// from real_score_a/b: those deliberately exclude shootout goals, so a Final
// settled on penalties is level on the scoreline the pool grades predictions
// against while still having a real champion.
//
// An *in-progress* Final has no winner yet, so a decisive live scoreline
// stands in provisionally — same as scoreMatchBreakdown already does for
// match points — and is superseded the moment the match finishes.
export function deriveChampion(matches) {
  const final = matches.find((m) => m.phase === "final");
  if (!final) return { champion: null, finalists: [], championIsFinal: false };

  const finalists = [final.team_a, final.team_b].filter(Boolean);
  const championIsFinal = final.real_score_a != null && final.real_score_b != null;

  // `winner` is set once the match is over and is the only signal that
  // survives a shootout, so it wins whenever it's there.
  const declaredWinner =
    final.winner === "a" ? final.team_a : final.winner === "b" ? final.team_b : null;
  if (declaredWinner) return { champion: declaredWinner, finalists, championIsFinal };

  // No declared winner: either the Final is still being played (a decisive
  // live scoreline stands in provisionally, same as scoreMatchBreakdown does
  // for match points), or it's over and level with the shootout not yet
  // reported — in which case there is genuinely no champion to name yet.
  const effective = effectiveScore(final);
  const decisive =
    effective.real_score_a != null && effective.real_score_b != null && effective.real_score_a !== effective.real_score_b;
  const champion = decisive ? (effective.real_score_a > effective.real_score_b ? final.team_a : final.team_b) : null;

  return { champion, finalists, championIsFinal };
}

// A team counts as a semifinalist just by appearing in an "sf"-phase match
// (win or lose) — used for the top-scorer bonus, not for who's still alive.
export function deriveSemifinalists(matches) {
  const teams = new Set();
  for (const match of matches) {
    if (match.phase !== "sf") continue;
    if (match.team_a) teams.add(match.team_a);
    if (match.team_b) teams.add(match.team_b);
  }
  return [...teams];
}
