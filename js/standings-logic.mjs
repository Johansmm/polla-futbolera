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
// fit a phone screen alongside two team names and flags. Also reused by
// standings.js's scoring rules explainer, so phase names stay consistent
// between the breakdown sections and the explanation of how they're scored.
export const PHASE_TAGS = {
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
// True for a match that has kicked off but has no result yet — covers both
// "about to go live" (still SCHEDULED per last fetch) and "already live"
// alike, since both need another Worker call to progress. Once every such
// match has a result, this goes false for good and the poll loop stops
// refetching entirely — nothing left that could change.
//
// A match whose phase this pool doesn't score (the competition's earlier
// rounds are seeded too, see admin/seed.js) can never change anything shown,
// so it doesn't keep the loop alive — otherwise a single postponed one would
// poll forever. A match with no phase *at all* still does, though: that means
// the Worker hasn't resolved it yet, and giving up on it would strand the
// page permanently on a Worker outage that later recovers.
export function hasMatchNeedingRefresh(matches, scoringConfig) {
  return matches.some(
    (match) =>
      isMatchLocked(match) &&
      match.real_score_a == null &&
      (match.phase == null || scoringConfig.phase_multipliers[match.phase] != null)
  );
}

// Shared by every breakdown section (match-by-match and special picks
// alike): highest points *within this section* — not the overall
// standings — win the crown (ties share it, same as .leader-row in the
// general table), and rows are ranked highest-points-first instead of
// staying in whatever order the overall standings put them in.
function rankEntries(rawEntries) {
  const maxPoints = rawEntries.reduce((max, e) => (e.points != null && e.points > max ? e.points : max), -Infinity);
  return rawEntries
    // A section where everyone scored 0 has no leader to crown — without
    // this, they'd all tie at the maximum and every row would get the crown.
    .map((e) => ({ ...e, top: maxPoints > 0 && e.points === maxPoints }))
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
  const { champion, finalists, championIsFinal } = deriveChampion(matches);
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
    // Deliberately not gated on `champion` being known: the finalist tier
    // only depends on the Final's line-up, so it pays out as soon as that's
    // set — and a Final settled on penalties has finalists and a champion
    // but no decisive scoreline at all (see deriveChampion).
    const championPoints = pick
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

  // Section-specific scoring rules, read from scoringConfig at render time
  // (never hardcoded) so they can't drift from scoring_config.json — shown
  // right in each special-picks section instead of the generic scoring-help
  // summary, since that's where the reader is already looking at their own
  // pick and points.
  const championConfig = scoringConfig.special_predictions.champion;
  const topScorerConfig = scoringConfig.special_predictions.top_scorer;

  const specialSections = specialRevealed
    ? [
        {
          title: '<span class="summary-title">Champion picks</span>',
          rules: `<p class="section-rules">Pick the eventual champion for <strong>${championConfig.exact_champion} pts</strong>; pick a finalist that doesn't win it for <strong>${championConfig.finalist} pts</strong>; anything else, 0.</p>`,
          entries: rankEntries(
            rows.map((row) => ({ name: row.name, prediction: row.championPick ?? "—", points: row.championPoints }))
          ),
        },
        {
          title: `
            <span class="summary-title">Top scorer picks</span>
            ${leaders.length ? `<span class="summary-sub">Current leader: ${leaders.join(", ")} (${leaderGoals} goals)</span>` : ""}
          `,
          rules: `<p class="section-rules">Pick the exact top scorer for <strong>${topScorerConfig.exact} pts</strong>, or land in the top 3 for <strong>${topScorerConfig.top_3} pts</strong>. Either way, add <strong>${topScorerConfig.team_reaches_semifinal_or_final_bonus} pts</strong> on top (never alone) if that player's team reached the Semifinal or Final.</p>`,
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
    // Champion points can already be scoring (the finalist tier) even with
    // no champion — standings.js's pendingNote needs to tell those apart.
    finalistsKnown: finalists.length > 0,
    championIsFinal,
    topScorerKnown: Boolean(topScorer),
    topScorerIsFinal,
    anyMatchLive,
    matchSections,
    specialSections,
    totalScorableMatches: scorableMatches.length,
    pointsEvolution: computePointsEvolution(rows, scorableMatches, specialRevealed, scoringConfig),
  };
}

// Short, position-in-phase axis labels (R1, R2, … QF1, QF2, … SF1, SF2,
// 3rd, F) — PHASE_TAGS' own values ("R16", "3rd place") are sized for a
// breakdown-section summary line, not a dozen-plus axis ticks squeezed side
// by side.
const AXIS_PHASE_ABBR = { r16: "R", qf: "QF", sf: "SF", third_place: "3rd", final: "F" };

// One running-total series per user, stepped across resolved *and*
// currently-live matches (issue #24 asked for resolved matches; a live
// one's provisional score already flows into row.matchBreakdown the same
// way finished ones do — see computeStandingsFromData — so leaving it out
// would make the chart lag a live-updating standings table by however long
// the match still has to run) in kickoff order — the x-axis is "matches
// resolved", not wall-clock time, since the tournament calendar is
// irregular. A locked-but-not-yet-live match's breakdown points are still
// null (pending), so it's excluded rather than freezing the line early.
// specialRevealed adds one trailing step for champion/top-scorer points,
// folded together since both reveal at the same instant.
//
// series is sorted by name rather than following `rows` (rank order) —
// rank reshuffles every time standings.js recomputes, and a chart whose
// line colors/positions shuffle along with it would be far harder to read
// than one with a stable, alphabetical order.
//
// Each series carries both `values` (the running total, for the cumulative
// view) and `stepPoints` (that step's own contribution, un-accumulated) —
// the latter is what surfaces "one big match carried their total" versus
// "steady every round" (the standings.js per-match chart view), which the
// cumulative total alone can't show since it only ever goes up.
//
// scoringConfig is only needed for each step's `maxPoints` — the
// standings.js heatmap view normalizes a cell's color intensity against
// that match's *theoretical* ceiling (exact score × phase multiplier)
// rather than the highest score anyone actually got, so a modest round
// where nobody did well doesn't get displayed as if someone maxed it out.
export function computePointsEvolution(rows, scorableMatches, specialRevealed, scoringConfig) {
  const relevant = scorableMatches
    .filter((match) => (match.real_score_a != null && match.real_score_b != null) || isMatchLive(match))
    .sort((a, b) => kickoffDate(a) - kickoffDate(b));

  // Numbered off *every* scorable match of that phase (not just the ones
  // with a step so far), so a match's number is stable — e.g. "QF2" doesn't
  // relabel itself once QF1 finally resolves.
  const phaseCounts = new Map();
  const phaseIndex = new Map();
  for (const match of [...scorableMatches].sort((a, b) => kickoffDate(a) - kickoffDate(b))) {
    const count = (phaseCounts.get(match.phase) ?? 0) + 1;
    phaseCounts.set(match.phase, count);
    phaseIndex.set(match.id, count);
  }

  const steps = relevant.map((match) => {
    const live = isMatchLive(match);
    const abbr = AXIS_PHASE_ABBR[match.phase] ?? match.phase ?? "?";
    const numbered = (phaseCounts.get(match.phase) ?? 1) > 1;
    return {
      matchId: match.id,
      phase: match.phase,
      shortLabel: `${abbr}${numbered ? phaseIndex.get(match.id) : ""}${live ? " \u{1F534}" : ""}`,
      label: `${PHASE_TAGS[match.phase] ?? match.phase} · ${match.team_a ?? "?"} vs ${match.team_b ?? "?"}${live ? " (Live)" : ""}`,
      maxPoints: scoringConfig.match_outcome_points.exact_score * (scoringConfig.phase_multipliers[match.phase] ?? 1),
    };
  });
  if (specialRevealed) {
    const { champion, top_scorer } = scoringConfig.special_predictions;
    steps.push({
      matchId: null,
      phase: "special",
      shortLabel: "SP",
      label: "Special picks",
      maxPoints: champion.exact_champion + top_scorer.exact + top_scorer.team_reaches_semifinal_or_final_bonus,
    });
  }

  const series = rows
    .map((row) => {
      let running = 0;
      const values = [];
      const stepPoints = relevant.map((match) => {
        const points = row.matchBreakdown[match.id]?.points ?? 0;
        running += points;
        values.push(running);
        return points;
      });
      if (specialRevealed) {
        const specialPoints = row.championPoints + row.topScorerPoints;
        running += specialPoints;
        values.push(running);
        stepPoints.push(specialPoints);
      }
      return { userId: row.userId, name: row.name, values, stepPoints };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // The group average at each step, mirroring the standings table's own
  // "± Avg" column (computeStandingsFromData's row.vsAverage) — plotted as
  // a reference line alongside every user's series in both chart views.
  const averageSeries = {
    values: steps.map((_, index) => averageAt(series, "values", index)),
    stepPoints: steps.map((_, index) => averageAt(series, "stepPoints", index)),
  };

  return { steps, series, average: averageSeries };
}

function averageAt(series, field, index) {
  if (!series.length) return 0;
  const sum = series.reduce((total, s) => total + s[field][index], 0);
  return Math.round((sum / series.length) * 10) / 10;
}
