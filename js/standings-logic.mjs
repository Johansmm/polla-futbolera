// Pure standings computation — everything standings.js's computeStandings()
// does once its Firestore/Worker fetches resolve: building each user's row,
// ranking them, and grouping the match-by-match/special-picks breakdown
// sections. Kept dependency-free of Firebase (note the .mjs extension) so
// it can be unit-tested directly with node:test via dynamic import(), same
// as scoring-logic.mjs/lock-logic.mjs/worker-matches.mjs — standings.js
// itself can't be, since it imports the Firebase SDK from a CDN URL that
// Node's module resolution can't follow.
import { isMatchLocked, kickoffDate } from "./lock-logic.mjs";
import {
  scoreMatchBreakdown,
  calculateChampionPoints,
  calculateTopScorerPoints,
  deriveChampion,
  deriveSemifinalists,
  deriveTopScorers,
  isMatchLive,
  effectiveScore,
  finishedMatches,
} from "./scoring-logic.mjs";
import { teamFlagImg, formatKickoff } from "./ui.js";

// Compact phase tags for the per-match breakdown summaries, which have to
// fit a phone screen alongside two team names and flags.
const PHASE_TAGS = {
  r16: "R16",
  qf: "QF",
  sf: "SF",
  third_place: "3rd place",
  final: "Final",
};

// Only matches whose phase has a configured multiplier count toward
// scoring — an unconfigured phase has no meaningful points to show.
// Exported on its own: standings.js needs this list *before* it can fetch
// each scorable match's predictions, ahead of calling
// computeStandingsFromData() with everything else already resolved.
export function selectScorableMatches(matches, scoringConfig) {
  return matches.filter((match) => isMatchLocked(match) && scoringConfig.phase_multipliers[match.phase] != null);
}

// standings.js's poll loop calls this on every tick, cheap and network-free
// (just comparing already-loaded kickoff_at/real_score_a against Date.now()),
// to decide whether a Worker refetch could possibly change anything shown.
// True for a match that has kicked off but has no admin-entered result yet —
// covers both "about to go live" (still SCHEDULED per last fetch) and
// "already live" alike, since both need another Worker call to progress.
// Once every match's real_score_a is set, this goes false for good and the
// poll loop stops refetching entirely — nothing left that could change.
export function hasMatchNeedingRefresh(matches) {
  return matches.some((match) => isMatchLocked(match) && match.real_score_a == null);
}

// Shared by every breakdown section (match-by-match and special picks
// alike): highest points *within this section* — not the overall
// standings — win the crown (ties share it, same as .leader-row in the
// general table), and rows are ranked highest-points-first instead of
// staying in whatever order the overall standings put them in.
function rankEntries(rawEntries) {
  const maxPoints = rawEntries.reduce((max, e) => (e.points != null && e.points > max ? e.points : max), -Infinity);
  return rawEntries
    .map((e) => ({ ...e, top: e.points != null && e.points === maxPoints }))
    .sort((a, b) => {
      if (a.points == null && b.points == null) return a.name.localeCompare(b.name);
      if (a.points == null) return 1;
      if (b.points == null) return -1;
      return b.points - a.points || a.name.localeCompare(b.name);
    });
}

// Scorable matches the poll loop hasn't fetched predictions for yet —
// i.e. matches that crossed into "locked" (kickoff passed) since
// alreadyFetchedIds was last updated. Each of these needs exactly one
// predictions fetch, not one per tick: a locked match's predictions never
// change (see firestore.rules), only their visibility does, and that only
// flips once.
export function selectNewlyScorableMatches(matches, scoringConfig, alreadyFetchedIds) {
  return selectScorableMatches(matches, scoringConfig).filter((match) => !alreadyFetchedIds.has(match.id));
}

export function computeStandingsFromData({
  scoringConfig,
  users,
  matches,
  tournamentResults,
  predictionsByMatch,
  specialPicks,
  specialRevealed,
  scorers,
}) {
  const scorableMatches = selectScorableMatches(matches, scoringConfig);
  const finished = finishedMatches(matches);
  const finishedIds = new Set(finished.map((m) => m.id));

  const anyMatchLive = matches.some(isMatchLive);
  const { champion, finalists } = deriveChampion(matches);
  const semifinalists = deriveSemifinalists(matches);

  // config/tournament_results.top_scorer, once the admin sets it, is the
  // definitive, final answer. Until then, deriveTopScorers' live-derived
  // leaders (possibly tied, possibly none yet) stand in as a provisional
  // signal — topScorerIsFinal tells callers (standings.js's pendingNote)
  // which case they're looking at.
  const { leaders, top3 } = deriveTopScorers(scorers ?? []);
  const topScorerIsFinal = Boolean(tournamentResults?.top_scorer);
  const topScorer = topScorerIsFinal ? tournamentResults.top_scorer : leaders.length ? leaders : null;
  const top3Scorers = topScorerIsFinal ? (tournamentResults.top_3_scorers ?? []) : top3;
  // Goal count shared by every tied leader — used for the "Top scorer
  // picks" section's summary line below, same pattern as a match section's
  // kickoff/score summary-sub.
  const leaderGoals = leaders.length ? (scorers ?? []).find((s) => s.name === leaders[0])?.goals : null;

  // isMatchLive/effectiveScore only depend on the match itself, not on
  // which user's row is being built — computed once per match here rather
  // than once per (user, match) pair below, and reused again in
  // matchSections further down instead of a third recompute.
  const matchContext = new Map(
    scorableMatches.map((match) => [match.id, { live: isMatchLive(match), effective: effectiveScore(match) }])
  );

  const rows = users.map((user) => {
    let matchPoints = 0;
    let exactHits = 0;
    let predictionsSubmitted = 0;
    const matchBreakdown = {};

    for (const match of scorableMatches) {
      const prediction = predictionsByMatch[match.id]?.[user.user_id];
      if (prediction) predictionsSubmitted += 1;

      const { live, effective } = matchContext.get(match.id);
      const { points, exactScoreHit } = scoreMatchBreakdown(
        prediction,
        effective,
        finishedIds.has(match.id) || live,
        scoringConfig.match_outcome_points,
        scoringConfig.phase_multipliers[match.phase]
      );

      if (points !== null) matchPoints += points;
      if (exactScoreHit) exactHits += 1;
      matchBreakdown[match.id] = { match, prediction: prediction ?? null, points };
    }

    const pick = specialPicks[user.user_id];
    const championPoints =
      pick && champion
        ? calculateChampionPoints(pick.champion_pick, { champion, finalists }, scoringConfig.special_predictions.champion)
        : 0;

    const topScorerPoints =
      pick && topScorer
        ? calculateTopScorerPoints(
            pick.top_scorer_pick,
            {
              topScorer,
              top3Scorers,
              pickTeam: pick.top_scorer_pick_team ?? null,
              semifinalists,
            },
            scoringConfig.special_predictions.top_scorer
          )
        : 0;

    return {
      userId: user.user_id,
      name: user.name,
      matchPoints,
      championPoints,
      topScorerPoints,
      exactHits,
      predictionsSubmitted,
      total: matchPoints + championPoints + topScorerPoints,
      matchBreakdown,
      championPick: pick?.champion_pick ?? null,
      topScorerPick: pick?.top_scorer_pick ?? null,
    };
  });

  const averageTotal = rows.length ? rows.reduce((sum, row) => sum + row.total, 0) / rows.length : 0;
  rows.forEach((row) => {
    row.vsAverage = row.total - averageTotal;
  });

  rows.sort((a, b) => b.total - a.total || b.exactHits - a.exactHits || a.name.localeCompare(b.name));

  // Competition ranking ("1, 1, 3"): rows tied on both the total and the
  // exact-hits tiebreaker share a rank instead of asserting an ordering
  // that doesn't exist — the alphabetical sort above is display-only.
  rows.forEach((row, index) => {
    const prev = rows[index - 1];
    row.rank = prev && prev.total === row.total && prev.exactHits === row.exactHits ? prev.rank : index + 1;
  });

  // Most recent kickoff first.
  const matchSections = [...scorableMatches]
    .sort((a, b) => kickoffDate(b) - kickoffDate(a))
    .map((match) => {
      const { live } = matchContext.get(match.id);
      const scoreTag =
        match.real_score_a != null && match.real_score_b != null
          ? ` · Final ${match.real_score_a}–${match.real_score_b}`
          : live
            ? ` · Live ${match.live_score_a}–${match.live_score_b}`
            : "";
      const liveBadge = live ? ` <span class="live-badge">🔴 Live</span>` : "";

      const rawEntries = rows.map((row) => {
        const breakdown = row.matchBreakdown[match.id];
        const prediction = breakdown?.prediction
          ? `${breakdown.prediction.predicted_score_a}–${breakdown.prediction.predicted_score_b}`
          : "—";
        return { name: row.name, prediction, points: breakdown?.points ?? null };
      });
      const entries = rankEntries(rawEntries);

      return {
        title: `
          <span class="summary-title">${PHASE_TAGS[match.phase] ?? match.phase} · ${teamFlagImg(match.team_a_crest_url)} ${match.team_a ?? "?"} vs ${teamFlagImg(match.team_b_crest_url)} ${match.team_b ?? "?"}${liveBadge}</span>
          <span class="summary-sub">${formatKickoff(match)}${scoreTag}</span>
        `,
        entries,
      };
    });

  const specialSections = specialRevealed
    ? [
        {
          title: '<span class="summary-title">Champion picks</span>',
          entries: rankEntries(
            rows.map((row) => ({ name: row.name, prediction: row.championPick ?? "—", points: row.championPoints }))
          ),
        },
        {
          title: `
            <span class="summary-title">Top scorer picks</span>
            ${leaders.length ? `<span class="summary-sub">Current leader: ${leaders.join(", ")} (${leaderGoals} goals)</span>` : ""}
          `,
          entries: rankEntries(
            rows.map((row) => ({ name: row.name, prediction: row.topScorerPick ?? "—", points: row.topScorerPoints }))
          ),
        },
      ]
    : [];

  return {
    rows,
    specialRevealed,
    championDecided: Boolean(champion),
    topScorerKnown: Boolean(topScorer),
    topScorerIsFinal,
    anyMatchLive,
    matchSections,
    specialSections,
    totalScorableMatches: scorableMatches.length,
  };
}
