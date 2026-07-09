// Scheduled fixture/results sync, run by two independent jobs in
// .github/workflows/sync-fixtures.yml: full-sync (every 3h, unconditional —
// discovers newly-defined matches and team names as the bracket resolves)
// and fast-sync (every 5 min, but only calls the API when
// --only-if-pending sees a match awaiting a result — see hasPendingResult
// below). Both run the exact same sync: fetch ALL World Cup 2026 matches
// from football-data.org and write fixture/result updates to Firestore, so
// `team_a`/`team_b`/`kickoff_at`/`real_score_a`/`real_score_b` no longer
// need to be entered by hand in admin/seed.js or the Firebase console (see
// GitHub issue #2).
//
// Deliberately does NOT filter by stage (group stage, Round of 32, etc. are
// synced too, not just r16-onward) — relevance is already enforced elsewhere,
// so duplicating that filter here would just be the same rule in two places:
//   - firestore.rules denies any prediction write once kickoff_at has passed,
//     so an earlier-stage match synced mid-tournament is already unwritable.
//   - js/predict.js only ever renders matches whose `phase` is one of
//     r16/qf/sf/third_place/final (see PHASE_ORDER there) — anything else
//     (an untranslated stage, see STAGE_TO_PHASE below) is simply never shown.
//
// Required env vars (set as GitHub Secrets, never committed):
//   FOOTBALL_DATA_TOKEN        — API key from https://www.football-data.org/
//   FIREBASE_SERVICE_ACCOUNT_JSON — the full service account JSON, as one string
//
// NOTE: verify the exact competition code/endpoint against football-data.org's
// current docs when you set up the API key — "WC" (FIFA World Cup) and the
// stage names below match their documented schema at the time this was
// written, but API providers do change these over time.
const admin = require("firebase-admin");

const COMPETITION_CODE = "WC"; // FIFA World Cup, per football-data.org's docs

// Translates football-data.org's stage codes to this project's `phase`
// values (r16/qf/sf/third_place/final, per CLAUDE.md) so js/predict.js's
// PHASE_ORDER recognizes and displays them correctly. Any API stage NOT
// listed here (group stage, Round of 32 — the extra stage this expanded
// tournament format adds before Round of 16 — etc.) is synced too, just
// with its raw API stage string left as `phase`; predict.js won't render
// it, so it's effectively inert, not hidden by filtering it out of the
// sync itself (see file header).
//
// English round names count teams *entering* the round ("Round of 16" = 16
// teams play it); Spanish names count what fraction of the bracket remains
// *after* it ("octavos de final" = an eighth of the bracket, i.e. 8 matches,
// remain). So English "Round of 16" = Spanish "octavos" (our `r16`), NOT
// "dieciseisavos"/"16avos" — that confusing pair is Spanish for the newer
// Round of 32 stage, which has no `phase` value in this project at all.
//
// Confirmed against a real football-data.org response (2026-07-03): they use
// LAST_32 for Round of 32 and LAST_16 for Round of 16, so the mapping below
// is correct as written — see the PR discussion for the raw stage counts.
const STAGE_TO_PHASE = {
  LAST_16: "r16",
  QUARTER_FINALS: "qf",
  SEMI_FINALS: "sf",
  THIRD_PLACE: "third_place",
  FINAL: "final",
};

// How close an API match's kickoff time must be to an already-seeded match's
// kickoff_at to be considered "the same match" — generous enough to absorb
// timezone/rounding mismatches without ever spanning two real matches.
const MATCH_TOLERANCE_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure logic (no network/Firestore calls) — unit-tested directly in
// test/sync-fixtures.test.js without needing the emulator or any credentials.
// ---------------------------------------------------------------------------

function resolvePhase(stage) {
  return STAGE_TO_PHASE[stage] ?? stage;
}

function buildResultFields(apiMatch) {
  if (apiMatch.status !== "FINISHED") return {};
  // score.fullTime is regularTime + extraTime + penalties combined (per
  // football-data.org's v4 docs), so a shootout's goals would otherwise leak
  // into the stored result. This pool's real_score_a/b should reflect the
  // score through extra time only, excluding the shootout. The API omits
  // regularTime entirely for a match decided in regular time (duration
  // REGULAR) since it'd just duplicate fullTime — fullTime is the regular-time
  // score in that case, so it's the fallback rather than a second source.
  const { regularTime, extraTime, fullTime } = apiMatch.score;
  const base = regularTime ?? fullTime;
  return {
    real_score_a: base.home + (extraTime?.home ?? 0),
    real_score_b: base.away + (extraTime?.away ?? 0),
  };
}

// live_score_a/b are a running score shown while a match is in progress,
// entirely separate from real_score_a/b (the final result, set once at
// FINISHED and never touched here). Cleared back to null at FINISHED so a
// match's live/finished state stays inferable from these two fields alone.
function buildLiveScoreFields(apiMatch) {
  if (apiMatch.status === "IN_PLAY" || apiMatch.status === "PAUSED") {
    return { live_score_a: apiMatch.score.fullTime.home, live_score_b: apiMatch.score.fullTime.away };
  }
  if (apiMatch.status === "FINISHED") {
    return { live_score_a: null, live_score_b: null };
  }
  return {};
}

function buildFixturePatch(apiMatch) {
  const patch = {
    phase: resolvePhase(apiMatch.stage),
    kickoffDate: new Date(apiMatch.utcDate),
    // Backfills source_match_id onto matches this script already knows how
    // to find (by kickoff_at + phase) for docs seeded before admin/seed.js
    // started writing it directly — temporary, until this script is removed.
    source_match_id: apiMatch.id,
  };
  if (apiMatch.homeTeam?.name) patch.team_a = apiMatch.homeTeam.name;
  if (apiMatch.awayTeam?.name) patch.team_b = apiMatch.awayTeam.name;
  // football-data.org's Team object includes a crest/flag image URL — synced
  // alongside the name so the client can render a flag next to each team
  // without hardcoding a team-name-to-country lookup of its own.
  if (apiMatch.homeTeam?.crest) patch.team_a_crest_url = apiMatch.homeTeam.crest;
  if (apiMatch.awayTeam?.crest) patch.team_b_crest_url = apiMatch.awayTeam.crest;
  return patch;
}

// candidates: [{ id, kickoffAt: Date, ... }] — matches Firestore doc shape
// loosely enough that the I/O code below can pass mapped docs in directly,
// while tests can pass plain objects with no Firestore involved.
function findMatchingDoc(candidates, targetDate, toleranceMs = MATCH_TOLERANCE_MS) {
  const target = targetDate.getTime();
  return candidates.find((c) => Math.abs(c.kickoffAt.getTime() - target) < toleranceMs);
}

function generateMatchId(phase, takenIds) {
  let n = 1;
  let candidate;
  do {
    candidate = `${phase}_${String(n).padStart(2, "0")}`;
    n += 1;
  } while (takenIds.has(candidate));
  return candidate;
}

// matches: [{ kickoffAt: Date, real_score_a }] — Firestore doc data mapped
// loosely enough that the I/O code below can pass mapped docs in directly,
// while tests can pass plain objects with no Firestore involved. A match
// with no kickoffAt yet (not synced at all) can't be "pending" — there's
// nothing scheduled to check a result against.
function hasPendingResult(matches, now = new Date()) {
  return matches.some((m) => m.kickoffAt && m.kickoffAt.getTime() <= now.getTime() && m.real_score_a == null);
}

module.exports = {
  STAGE_TO_PHASE,
  MATCH_TOLERANCE_MS,
  resolvePhase,
  buildResultFields,
  buildLiveScoreFields,
  buildFixturePatch,
  findMatchingDoc,
  generateMatchId,
  hasPendingResult,
};

// ---------------------------------------------------------------------------
// I/O (network + Firestore) and script entry point — only runs when this
// file is executed directly (`node sync-fixtures.js`), not when required by
// the test suite, so importing the pure functions above never needs
// FOOTBALL_DATA_TOKEN/FIREBASE_SERVICE_ACCOUNT_JSON to be set.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
  const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  // Passed by sync-fixtures.yml's fast-sync job (every 5 min): skip the
  // football-data.org call entirely unless some match is actually awaiting
  // a result, so the frequent schedule stays cheap. full-sync (every 3h)
  // never passes this — it's the one job that still has to poll blindly,
  // since discovering a match nobody's ever synced before has no local
  // Firestore state to check against.
  const onlyIfPending = process.argv.includes("--only-if-pending");

  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error("Missing FOOTBALL_DATA_TOKEN env var");
  }
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
  });

  const db = admin.firestore();

  // Single read of the whole matches collection per run, reused for both
  // the --only-if-pending gate and the existing-match lookups in
  // syncFixture below. This used to be one Firestore query PER API fixture
  // (findExistingMatch, plus a second one when creating a new doc) — each
  // scanning every existing match sharing that phase, which for a phase
  // like group stage (~70+ matches) meant tens of thousands of document
  // reads in a single run. That was tolerable at 8 runs/day, but
  // fast-sync repeating it several times an hour blew through Firestore's
  // free-tier daily read quota. Reading the whole (much smaller) matches
  // collection once and matching in memory instead avoids that entirely.
  const fetchMatchDocs = async () => {
    const snap = await db.collection("matches").get();
    return snap.docs.map((doc) => ({
      id: doc.id,
      phase: doc.data().phase,
      kickoffAt: doc.data().kickoff_at ? doc.data().kickoff_at.toDate() : null,
      real_score_a: doc.data().real_score_a,
    }));
  };

  const fetchAllFixtures = async () => {
    const res = await fetch(`https://api.football-data.org/v4/competitions/${COMPETITION_CODE}/matches`, {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
    });

    if (!res.ok) {
      throw new Error(`football-data.org request failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();

    // Purely informational: tells you what raw stage strings the API
    // actually uses, so you can confirm STAGE_TO_PHASE's assumptions. These
    // matches are still synced below, just with an untranslated (and
    // therefore app-invisible) `phase` value.
    const unmappedStages = new Set(
      data.matches.map((m) => m.stage).filter((stage) => !STAGE_TO_PHASE[stage])
    );
    if (unmappedStages.size) {
      console.log(`Unmapped stage(s) seen (synced as-is, not shown in the app): ${[...unmappedStages].join(", ")}`);
    }

    return data.matches;
  };

  // matchDocs is the in-memory snapshot fetched once in main() — mutated in
  // place as matches are created below so a second same-phase fixture later
  // in the same run's loop sees it as taken, matching the old behavior
  // where a fresh Firestore query would have shown the same thing.
  const syncFixture = async (apiMatch, matchDocs) => {
    const { phase, kickoffDate, source_match_id, team_a, team_b, team_a_crest_url, team_b_crest_url } =
      buildFixturePatch(apiMatch);

    const fixtureFields = {
      phase,
      kickoff_at: admin.firestore.Timestamp.fromDate(kickoffDate),
      source_match_id,
    };
    if (team_a) fixtureFields.team_a = team_a;
    if (team_b) fixtureFields.team_b = team_b;
    if (team_a_crest_url) fixtureFields.team_a_crest_url = team_a_crest_url;
    if (team_b_crest_url) fixtureFields.team_b_crest_url = team_b_crest_url;

    // Once the API marks a match finished, treat its score as authoritative
    // and overwrite real_score_a/b — this replaces manual result entry,
    // which is the whole point of this script (unlike admin/seed.js, which
    // deliberately never touches these fields once set).
    const resultFields = buildResultFields(apiMatch);
    const liveScoreFields = buildLiveScoreFields(apiMatch);

    const phaseCandidates = matchDocs.filter((d) => d.phase === phase && d.kickoffAt);
    const existing = findMatchingDoc(phaseCandidates, kickoffDate);

    if (existing) {
      await db
        .collection("matches")
        .doc(existing.id)
        .set({ ...fixtureFields, ...resultFields, ...liveScoreFields }, { merge: true });
      return { matchId: existing.id, action: "updated" };
    }

    const takenIds = new Set(matchDocs.filter((d) => d.phase === phase).map((d) => d.id));
    const matchId = generateMatchId(phase, takenIds);

    await db.collection("matches").doc(matchId).set({
      match_id: matchId,
      team_a: null,
      team_b: null,
      team_a_crest_url: null,
      team_b_crest_url: null,
      real_score_a: null,
      real_score_b: null,
      live_score_a: null,
      live_score_b: null,
      locked: false,
      ...fixtureFields,
      ...resultFields,
      ...liveScoreFields,
    });

    matchDocs.push({ id: matchId, phase, kickoffAt: kickoffDate, real_score_a: resultFields.real_score_a ?? null });

    return { matchId, action: "created" };
  };

  const main = async () => {
    const matchDocs = await fetchMatchDocs();

    if (onlyIfPending && !hasPendingResult(matchDocs)) {
      console.log("No match awaiting a result — skipping the football-data.org call.");
      return;
    }

    const fixtures = await fetchAllFixtures();

    if (!fixtures.length) {
      console.log("No fixtures returned yet.");
      return;
    }

    for (const apiMatch of fixtures) {
      if (!apiMatch.utcDate) {
        console.log(`Skipping API match ${apiMatch.id}: no kickoff time yet.`);
        continue;
      }
      const result = await syncFixture(apiMatch, matchDocs);
      console.log(JSON.stringify({ apiMatchId: apiMatch.id, ...result }));
    }
  };

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
