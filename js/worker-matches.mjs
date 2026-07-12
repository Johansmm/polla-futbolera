// Pure functions merging a Firestore match doc ({match_id, kickoff_at,
// source_match_id}) with its corresponding entry in the Cloudflare Worker's
// /matches response, so js/predict.js and js/standings.js see the same
// team_a/team_b/real_score_a/b/live_score_a/b/phase shape they always have.
// Firestore only ever holds the tournament's schedule plus a reference to
// which fixture this is in the match-data source — never what it's actually
// about, since security rules can't call external APIs to find out.
// Kept dependency-free (note the .mjs extension) so it can be unit-tested
// directly with node:test via dynamic import(), same as js/lock-logic.mjs —
// admin/seed.js also imports STAGE_TO_PHASE/resolvePhase from here directly
// rather than keeping its own copy, so the two never drift apart.

// Translates the data source's stage codes to this project's `phase`
// values. Any stage not listed here (group stage, the Round of 32 the
// expanded format adds before Round of 16, etc.) is passed through as-is —
// harmless, since js/predict.js only ever renders the phases it knows about.
export const STAGE_TO_PHASE = {
  LAST_16: "r16",
  QUARTER_FINALS: "qf",
  SEMI_FINALS: "sf",
  THIRD_PLACE: "third_place",
  FINAL: "final",
};

export function resolvePhase(stage) {
  return STAGE_TO_PHASE[stage] ?? stage;
}

// score.fullTime is regularTime + extraTime + penalties combined, so a
// shootout's goals would otherwise leak into the stored result — this
// pool's real_score_a/b should reflect the score through extra time only.
// The source omits regularTime entirely for a match decided in regular time
// (fullTime already is the regular-time score then), so that's the fallback.
export function buildResultFields(apiMatch) {
  if (apiMatch.status !== "FINISHED") return {};
  const { regularTime, extraTime, fullTime } = apiMatch.score;
  const base = regularTime ?? fullTime;
  return {
    real_score_a: base.home + (extraTime?.home ?? 0),
    real_score_b: base.away + (extraTime?.away ?? 0),
  };
}

// Which side actually won, as "a"/"b" (or null for a match that somehow
// finished level). Kept separate from real_score_a/b on purpose: a knockout
// tie is settled by a shootout, whose goals must stay *out* of the score the
// pool grades predictions against (see buildResultFields above) but are the
// only thing that says who went through. Without this, a Final decided on
// penalties would look like a draw with no winner at all — see
// scoring-logic.mjs's deriveChampion.
export function buildWinnerField(apiMatch) {
  if (apiMatch.status !== "FINISHED") return {};

  const { real_score_a: a, real_score_b: b } = buildResultFields(apiMatch);
  if (a !== b) return { winner: a > b ? "a" : "b" };

  const { penalties } = apiMatch.score;
  if (penalties?.home != null && penalties.home !== penalties.away) {
    return { winner: penalties.home > penalties.away ? "a" : "b" };
  }

  // A phase that allows draws (none of the ones this pool scores) — or a
  // shootout the source hasn't filled in yet.
  return { winner: null };
}

// live_score_a/b are a running score shown while a match is in progress,
// separate from real_score_a/b (the final result). Cleared back to null at
// FINISHED so a match's live/finished state stays inferable from these two
// fields alone.
export function buildLiveScoreFields(apiMatch) {
  if (apiMatch.status === "IN_PLAY" || apiMatch.status === "PAUSED") {
    return { live_score_a: apiMatch.score.fullTime.home, live_score_b: apiMatch.score.fullTime.away };
  }
  if (apiMatch.status === "FINISHED") {
    return { live_score_a: null, live_score_b: null };
  }
  return {};
}

// firestoreMatch's own match_id/kickoff_at/source_match_id always win over
// anything derived here — Firestore is authoritative for the fields
// security rules depend on; the source only ever supplies display data. If
// no corresponding source match is found (source_match_id not resolved yet,
// or the Worker call failed), returns firestoreMatch unchanged — no team,
// score, or phase fields, same as any other match still waiting on data.
// sourceMatchesById is a Map keyed by the source's own match id (built once
// per fetch by the caller), so this is an O(1) lookup rather than an O(n)
// scan repeated for every Firestore match.
export function mergeMatchData(firestoreMatch, sourceMatchesById) {
  const apiMatch = sourceMatchesById.get(firestoreMatch.source_match_id);
  if (!apiMatch) return { ...firestoreMatch };

  return {
    ...firestoreMatch,
    phase: resolvePhase(apiMatch.stage),
    team_a: apiMatch.homeTeam?.name ?? null,
    team_b: apiMatch.awayTeam?.name ?? null,
    team_a_crest_url: apiMatch.homeTeam?.crest ?? null,
    team_b_crest_url: apiMatch.awayTeam?.crest ?? null,
    ...buildResultFields(apiMatch),
    ...buildWinnerField(apiMatch),
    ...buildLiveScoreFields(apiMatch),
  };
}
