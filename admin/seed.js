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

// Fill in team_a/team_b once the bracket is known; kickoff_at must always
// be a real timestamp so the auto-lock rule (request.time > kickoff_at)
// has something to compare against. Add every match through the Final here.
// Re-running this script is safe: existing matches only get their fixture
// fields (phase/teams/kickoff_at) refreshed — real_score_a, real_score_b and
// locked are left alone once a match has been created, so entering results
// via the console won't get wiped out by a later re-seed.
//
// kickoff_at is written in Central European time — use the "+02:00" offset
// (CEST, UTC+2), which covers the whole tournament window (late June through
// the Final in mid-July, before EU clocks fall back to CET/+01:00 in
// October). new Date(...) parses the offset correctly, so Firestore still
// stores the right absolute instant regardless of the offset used here.
const MATCHES = [
  { match_id: "r16_01", phase: "r16", team_a: "Canada", team_b: "Morocco", kickoff_at: "2026-07-04T19:00:00+02:00" },
  { match_id: "r16_02", phase: "r16", team_a: "Paraguay", team_b: "France", kickoff_at: "2026-07-04T23:00:00+02:00" },
  // ... add the remaining Round of 16, QF, SF, Third Place, Final matches.
];

// Add the ~10 friends here. Re-running this script is safe: it skips any
// user_id that already has a doc, so it never rotates an existing token.
// user_id must NOT contain underscores — firestore.rules derives the owner
// of a not-yet-created prediction from splitting the doc ID ("{user_id}_{match_id}")
// on "_", which only works if user_id itself has none.
const USERS = [
  { user_id: "johan", name: "Johan" },
  { user_id: "kevin", name: "Kevin" },
  // ... add the rest of the group here.
];

// Optional: if set, also seeds team_rosters (see seedTeamRosters() below) so
// the champion/top-scorer picks form has real team/player names to pick
// from. Get a free key from https://www.football-data.org/ — leave unset to
// skip that step entirely (matches/users/tokens still seed normally).
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMPETITION_CODE = "WC"; // FIFA World Cup, per football-data.org's docs

function generateToken() {
  return crypto.randomBytes(16).toString("base64url");
}

async function seedMatches() {
  let created = 0;
  let updated = 0;

  for (const match of MATCHES) {
    const ref = db.collection("matches").doc(match.match_id);
    const existing = await ref.get();

    const fixtureFields = {
      match_id: match.match_id,
      phase: match.phase,
      team_a: match.team_a,
      team_b: match.team_b,
      kickoff_at: admin.firestore.Timestamp.fromDate(new Date(match.kickoff_at)),
    };

    if (existing.exists) {
      // Update fixture fields only — never touch real_score_a / real_score_b /
      // locked here, since those may already have been set manually via the
      // Firebase console (entering a real result, or force-locking a match).
      await ref.set(fixtureFields, { merge: true });
      updated++;
    } else {
      await ref.set({
        ...fixtureFields,
        real_score_a: null,
        real_score_b: null,
        locked: false,
      });
      created++;
    }
  }

  console.log(`Matches: ${created} created, ${updated} updated (results/locked untouched).`);
}

// Champion/top-scorer picks (special_predictions) can be created or edited
// up until this deadline, per firestore.rules' specialPredictionsLocked().
// Derived from the actual `matches` collection (not just the MATCHES array
// above), so it stays correct even if some r16 matches were created by
// automation/sync-fixtures.js instead of this script.
async function seedSpecialPredictionsDeadline() {
  const snap = await db.collection("matches").where("phase", "==", "r16").get();
  const kickoffs = snap.docs
    .map((doc) => doc.data().kickoff_at)
    .filter(Boolean)
    .map((ts) => ts.toDate().getTime());

  if (!kickoffs.length) {
    console.log("No r16 matches with a kickoff_at yet — skipping special_predictions deadline.");
    return;
  }

  const earliest = new Date(Math.min(...kickoffs));

  await db.collection("config").doc("special_predictions").set({
    locked_after: admin.firestore.Timestamp.fromDate(earliest),
  });

  console.log(`special_predictions locks at ${earliest.toISOString()} (first r16 kickoff).`);
}

// Populates team_rosters/{team} so the special-predictions form (champion +
// top scorer picks, see GitHub issue #7) can build both dropdowns from real
// data instead of free text — no typos, no name-format mismatches. Fetches
// every World Cup 2026 team and its squad in a single API call (confirmed
// against the real API: /v4/competitions/WC/teams returns full squads on
// the free tier, no per-team requests needed).
async function seedTeamRosters() {
  if (!FOOTBALL_DATA_TOKEN) {
    console.log("FOOTBALL_DATA_TOKEN not set — skipping team_rosters seed.");
    return;
  }

  const res = await fetch(`https://api.football-data.org/v4/competitions/${COMPETITION_CODE}/teams`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
  });

  if (!res.ok) {
    throw new Error(`football-data.org request failed: ${res.status} ${await res.text()}`);
  }

  const { teams } = await res.json();
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
  await seedMatches();
  await seedSpecialPredictionsDeadline();
  await seedTeamRosters();
  await seedUsers();
  console.log("\nDone. Save the printed links now — tokens aren't printed again unless you add a brand-new user.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
