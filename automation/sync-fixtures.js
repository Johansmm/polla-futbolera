// Scheduled fixture/results sync (see .github/workflows/sync-fixtures.yml).
// Fetches ALL World Cup 2026 matches from football-data.org and writes
// fixture/result updates to Firestore, so `team_a`/`team_b`/`kickoff_at`/
// `real_score_a`/`real_score_b` no longer need to be entered by hand in
// admin/seed.js or the Firebase console (see GitHub issue #2).
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
// listed here (group stage, Round of 32 — the new 48-team stage before
// Round of 16 — etc.) is synced too, just with its raw API stage string
// left as `phase`; predict.js won't render it, so it's effectively inert,
// not hidden by filtering it out of the sync itself (see file header).
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
  return {
    real_score_a: apiMatch.score.fullTime.home,
    real_score_b: apiMatch.score.fullTime.away,
  };
}

function buildFixturePatch(apiMatch) {
  const patch = {
    phase: resolvePhase(apiMatch.stage),
    kickoffDate: new Date(apiMatch.utcDate),
  };
  if (apiMatch.homeTeam?.name) patch.team_a = apiMatch.homeTeam.name;
  if (apiMatch.awayTeam?.name) patch.team_b = apiMatch.awayTeam.name;
  return patch;
}

// candidates: [{ id, kickoffAt: Date, ... }] — matches Firestore doc shape
// loosely enough that findExistingMatch() below can pass mapped docs in
// directly, while tests can pass plain objects with no Firestore involved.
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

module.exports = {
  STAGE_TO_PHASE,
  MATCH_TOLERANCE_MS,
  resolvePhase,
  buildResultFields,
  buildFixturePatch,
  findMatchingDoc,
  generateMatchId,
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

  const findExistingMatch = async (phase, kickoffDate) => {
    const snap = await db.collection("matches").where("phase", "==", phase).get();
    const candidates = snap.docs
      .filter((doc) => doc.data().kickoff_at)
      .map((doc) => ({ id: doc.id, ref: doc.ref, kickoffAt: doc.data().kickoff_at.toDate() }));
    return findMatchingDoc(candidates, kickoffDate);
  };

  const syncFixture = async (apiMatch) => {
    const { phase, kickoffDate, team_a, team_b } = buildFixturePatch(apiMatch);

    const fixtureFields = { phase, kickoff_at: admin.firestore.Timestamp.fromDate(kickoffDate) };
    if (team_a) fixtureFields.team_a = team_a;
    if (team_b) fixtureFields.team_b = team_b;

    // Once the API marks a match finished, treat its score as authoritative
    // and overwrite real_score_a/b — this replaces manual result entry,
    // which is the whole point of this script (unlike admin/seed.js, which
    // deliberately never touches these fields once set).
    const resultFields = buildResultFields(apiMatch);

    const existing = await findExistingMatch(phase, kickoffDate);

    if (existing) {
      await existing.ref.set({ ...fixtureFields, ...resultFields }, { merge: true });
      return { matchId: existing.id, action: "updated" };
    }

    const phaseSnap = await db.collection("matches").where("phase", "==", phase).get();
    const matchId = generateMatchId(phase, new Set(phaseSnap.docs.map((d) => d.id)));

    await db.collection("matches").doc(matchId).set({
      match_id: matchId,
      team_a: null,
      team_b: null,
      real_score_a: null,
      real_score_b: null,
      locked: false,
      ...fixtureFields,
      ...resultFields,
    });

    return { matchId, action: "created" };
  };

  const main = async () => {
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
      const result = await syncFixture(apiMatch);
      console.log(JSON.stringify({ apiMatchId: apiMatch.id, ...result }));
    }
  };

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
