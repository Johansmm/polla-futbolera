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

// match_id, phase, and kickoff_at are stored — team/crest/score fields are
// dropped, since those come from the Cloudflare Worker proxy in front of
// football-data.org instead. `phase` stays for now: js/predict.js groups
// matches by it to render each phase's section, and js/standings.js uses it
// to look up that phase's scoring multiplier (scoring_config.json) — neither
// reads match data from the Worker yet, so there's nowhere client-side to
// derive it from in the meantime. A match missing `phase` doesn't just show
// blank like a missing team name would — predict.js never renders it at all,
// since its per-phase grouping only ever looks at the phases it knows about.
// Once the client reads match data from the Worker, it could derive `phase`
// itself from football-data.org's raw `stage` value (the same translation
// automation/sync-fixtures.js's STAGE_TO_PHASE does today, just running in
// the browser), and `phase` could drop from here too. kickoff_at must always
// be a real timestamp so the auto-lock rule (request.time > kickoff_at) has
// something to compare against; it's available from the published FIFA
// schedule before the tournament starts, so this collection never needs
// syncing again once seeded. Re-running this script is safe and idempotent:
// it just re-writes the same fields.
//
// kickoff_at is written in Central European time — use the "+02:00" offset
// (CEST, UTC+2), which covers the whole tournament window (late June through
// the Final in mid-July, before EU clocks fall back to CET/+01:00 in
// October). new Date(...) parses the offset correctly, so Firestore still
// stores the right absolute instant regardless of the offset used here.
const MATCHES = [
  { match_id: "r16_01", phase: "r16", kickoff_at: "2026-07-04T19:00:00+02:00" }, // Canada vs Morocco
  { match_id: "r16_02", phase: "r16", kickoff_at: "2026-07-04T23:00:00+02:00" }, // Paraguay vs France
  // ... add the remaining Round of 16, QF, SF, Third Place, Final matches.
];

// Add the ~10 friends here. Re-running this script is safe: it skips any
// user_id that already has a doc, so it never rotates an existing token.
// user_id must NOT contain underscores — firestore.rules derives the owner
// of a not-yet-created prediction from splitting the doc ID ("{user_id}_{match_id}")
// on "_", which only works if user_id itself has none.
const USERS = [
  { user_id: "jmejia", name: "Johan Mejia" },
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
  const batch = db.batch();

  for (const match of MATCHES) {
    const ref = db.collection("matches").doc(match.match_id);
    batch.set(ref, {
      match_id: match.match_id,
      phase: match.phase,
      kickoff_at: admin.firestore.Timestamp.fromDate(new Date(match.kickoff_at)),
    });
  }

  await batch.commit();
  console.log(`Matches: seeded ${MATCHES.length} (match_id + phase + kickoff_at only).`);
}

// Champion/top-scorer picks (special_predictions) can be created or edited
// up until this deadline, per firestore.rules' specialPredictionsDeadlinePassed().
// Looks up the current kickoff_at for exactly the match_ids in MATCHES above,
// rather than scanning the whole `matches` collection — other tools may sync
// extra matches this pool doesn't track into that same collection, and
// scoping to this pool's own match_ids avoids depending on any phase name or
// ordering to tell those apart.
async function seedSpecialPredictionsDeadline() {
  if (!MATCHES.length) {
    console.log("MATCHES is empty — skipping special_predictions deadline.");
    return;
  }

  const snap = await db
    .collection("matches")
    .where(admin.firestore.FieldPath.documentId(), "in", MATCHES.map((m) => m.match_id))
    .get();
  const kickoffs = snap.docs
    .map((doc) => doc.data().kickoff_at)
    .filter(Boolean)
    .map((ts) => ts.toDate().getTime());

  if (!kickoffs.length) {
    console.log("No matches with a kickoff_at yet — skipping special_predictions deadline.");
    return;
  }

  const earliest = new Date(Math.min(...kickoffs));

  await db.collection("config").doc("special_predictions").set({
    locked_after: admin.firestore.Timestamp.fromDate(earliest),
  });

  console.log(`special_predictions locks at ${earliest.toISOString()} (earliest kickoff among this pool's matches).`);
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
