// One-off / rerunnable local script (Admin SDK — bypasses all Firestore
// security rules, run this locally only, never deploy it as a live endpoint).
//
// Usage:
//   cd admin
//   npm install
//   node seed.js
const admin = require("firebase-admin");
const crypto = require("crypto");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Add the ~10 friends here. Re-running this script is safe: it skips any
// user_id that already has a doc, so it never rotates an existing token.
// user_id must NOT contain underscores — firestore.rules derives the owner
// of a not-yet-created prediction from splitting the doc ID ("{user_id}_{match_id}")
// on "_", which only works if user_id itself has none.
const USERS = [
  { user_id: "jmejia", name: "Johan Mejia" },
  // ... add the rest of the group here.
];

// Required — seedMatches() below fetches the competition's full fixture
// list to build the matches skeleton, and seedTeamRosters() uses the same
// token for team/player data. Get a free key from https://www.football-data.org/.
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMPETITION_CODE = "WC"; // FIFA World Cup, per football-data.org's docs

function generateMatchId(phase, takenIds) {
  let n = 1;
  let candidate;
  do {
    candidate = `${phase}_${String(n).padStart(2, "0")}`;
    n += 1;
  } while (takenIds.has(candidate));
  return candidate;
}

function generateToken() {
  return crypto.randomBytes(16).toString("base64url");
}

async function fetchFromFootballData(path) {
  const res = await fetch(`https://api.football-data.org/v4/competitions/${COMPETITION_CODE}/${path}`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
  });

  if (!res.ok) {
    throw new Error(`football-data.org request failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Only match_id, kickoff_at, and source_match_id (the competition's own id
// for this fixture) are stored — team names, crests, and scores come from
// the Cloudflare Worker proxy at read time instead (see
// js/worker-matches.mjs), which derives `phase` there too from the same raw
// `stage` value this function only uses transiently, to build a readable
// match_id; firestore.rules never needs phase, only kickoff_at.
//
// Deliberately does NOT filter by stage: every match in the competition
// (group stage, Round of 32, etc., not just what this pool tracks) gets a
// doc. Relevance is already enforced downstream — js/predict.js only
// renders phases it knows about, js/standings.js only scores phases with a
// configured multiplier in scoring_config.json — so filtering here too would
// just be the same rule in a second place.
//
// Safe to re-run: an existing match is found by source_match_id, not by
// re-deriving match_id, so it keeps its original match_id even if the API's
// response order changes between runs; only a fixture never seeded before
// gets a newly generated one.
async function seedMatches(resolvePhase) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error("FOOTBALL_DATA_TOKEN is required — get a free key from https://www.football-data.org/");
  }

  const fixtures = (await fetchFromFootballData("matches")).matches.filter((m) => m.utcDate);

  const existingSnap = await db.collection("matches").get();
  const existingIdBySourceId = new Map(existingSnap.docs.map((doc) => [doc.data().source_match_id, doc.id]));

  // Numbered in kickoff order within each phase, so match_id stays readable
  // ("r16_01" is whichever r16 match kicks off first) regardless of the
  // order football-data.org happens to return fixtures in.
  const sortedFixtures = [...fixtures].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  const takenIdsByPhase = new Map();
  for (const matchId of existingIdBySourceId.values()) {
    const phase = matchId.replace(/_\d+$/, "");
    if (!takenIdsByPhase.has(phase)) takenIdsByPhase.set(phase, new Set());
    takenIdsByPhase.get(phase).add(matchId);
  }

  const batch = db.batch();
  const seeded = [];
  let created = 0;
  let updated = 0;

  for (const apiMatch of sortedFixtures) {
    const phase = resolvePhase(apiMatch.stage);
    let matchId = existingIdBySourceId.get(apiMatch.id);

    if (matchId) {
      updated++;
    } else {
      const taken = takenIdsByPhase.get(phase) ?? new Set();
      matchId = generateMatchId(phase, taken);
      taken.add(matchId);
      takenIdsByPhase.set(phase, taken);
      created++;
    }

    const kickoffAt = new Date(apiMatch.utcDate);
    batch.set(db.collection("matches").doc(matchId), {
      match_id: matchId,
      kickoff_at: admin.firestore.Timestamp.fromDate(kickoffAt),
      source_match_id: apiMatch.id,
    });

    seeded.push({ matchId, phase, kickoffAt });
  }

  await batch.commit();
  console.log(`Matches: ${created} created, ${updated} updated (match_id + kickoff_at + source_match_id only).`);
  return seeded;
}

// Champion/top-scorer picks (special_predictions) can be created or edited
// up until this deadline, per firestore.rules' specialPredictionsDeadlinePassed().
// Takes seedMatches()'s in-memory result rather than querying Firestore —
// phase isn't a stored field (see seedMatches() above), so there'd be
// nothing to filter matches by if this queried the matches collection
// directly, and group-stage/Round-of-32 kickoffs (also seeded there,
// deliberately unfiltered) would otherwise pollute "earliest kickoff" with
// matches this pool never tracks.
async function seedSpecialPredictionsDeadline(seededMatches, trackedPhases) {
  const trackedKickoffs = seededMatches
    .filter((m) => trackedPhases.has(m.phase))
    .map((m) => m.kickoffAt.getTime());

  if (!trackedKickoffs.length) {
    console.log("No tracked-phase matches with a kickoff yet — skipping special_predictions deadline.");
    return;
  }

  const earliest = new Date(Math.min(...trackedKickoffs));

  await db.collection("config").doc("special_predictions").set({
    locked_after: admin.firestore.Timestamp.fromDate(earliest),
  });

  console.log(`special_predictions locks at ${earliest.toISOString()} (earliest kickoff among tracked phases).`);
}

// Populates team_rosters/{team} so the special-predictions form (champion +
// top scorer picks, see GitHub issue #7) can build both dropdowns from real
// data instead of free text — no typos, no name-format mismatches. Fetches
// every World Cup 2026 team and its squad in a single API call (confirmed
// against the real API: /v4/competitions/WC/teams returns full squads on
// the free tier, no per-team requests needed).
async function seedTeamRosters() {
  const { teams } = await fetchFromFootballData("teams");
  const batch = db.batch();

  for (const team of teams) {
    const ref = db.collection("team_rosters").doc(team.name);
    batch.set(ref, {
      team: team.name,
      players: (team.squad ?? []).map((p) => p.name),
    });
  }

  await batch.commit();
  console.log(`Seeded rosters for ${teams.length} teams.`);
}

async function seedUsers() {
  for (const user of USERS) {
    const userRef = db.collection("users").doc(user.user_id);
    const existing = await userRef.get();

    if (existing.exists) {
      console.log(`${user.name}: already seeded, skipping (token unchanged).`);
      continue;
    }

    const token = generateToken();

    await userRef.set({
      user_id: user.user_id,
      name: user.name,
      token,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("tokens").doc(token).set({ user_id: user.user_id });

    console.log(`${user.name}: predict.html?token=${token}`);
  }
}

async function main() {
  // js/worker-matches.mjs is a real ES module, loaded here via dynamic
  // import() even though this script itself is CommonJS — same pattern the
  // test suite uses to load js/*.mjs files. Keeps the stage/phase mapping
  // in one place instead of a second copy here that could drift from it.
  const { resolvePhase, STAGE_TO_PHASE } = await import("../js/worker-matches.mjs");
  const trackedPhases = new Set(Object.values(STAGE_TO_PHASE));

  const seededMatches = await seedMatches(resolvePhase);
  await seedSpecialPredictionsDeadline(seededMatches, trackedPhases);
  await seedTeamRosters();
  await seedUsers();
  console.log("\nDone. Save the printed links now — tokens aren't printed again unless you add a brand-new user.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
