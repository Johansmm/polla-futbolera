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
const MATCHES = [
  { match_id: "r16_01", phase: "r16", team_a: null, team_b: null, kickoff_at: "2026-06-28T18:00:00Z" },
  { match_id: "r16_02", phase: "r16", team_a: null, team_b: null, kickoff_at: "2026-06-28T21:00:00Z" },
  // ... add the remaining Round of 16, QF, SF, Third Place, Final matches.
];

// Add the ~10 friends here. Re-running this script is safe: it skips any
// user_id that already has a doc, so it never rotates an existing token.
// user_id must NOT contain underscores — firestore.rules derives the owner
// of a not-yet-created prediction from splitting the doc ID ("{user_id}_{match_id}")
// on "_", which only works if user_id itself has none.
const USERS = [
  { user_id: "johan", name: "Johan" },
  // ... add the rest of the group here.
];

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
  await seedUsers();
  console.log("\nDone. Save the printed links now — tokens aren't printed again unless you add a brand-new user.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
