// Manually-triggered report (see .github/workflows/missing-predictions.yml):
// per user, lists which matches kicking off in the next 24 hours they're
// still missing a prediction for — one line per user, ready to paste into a
// nudge message — without opening the app or a PC (trigger the workflow
// from the GitHub mobile app/site).
//
// Deliberately never reads predicted_score_a/predicted_score_b: it only
// checks whether a predictions/{user_id}_{match_id} doc exists, never
// calls .data() on it, so there is no code path that could print a score.
const admin = require("firebase-admin");

const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
});

const db = admin.firestore();
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchUpcomingMatches() {
  const now = admin.firestore.Timestamp.fromDate(new Date());
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() + DAY_MS));

  const snap = await db
    .collection("matches")
    .where("kickoff_at", ">", now)
    .where("kickoff_at", "<=", cutoff)
    .get();

  return snap.docs;
}

async function fetchUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

function matchLabel(matchDoc) {
  const match = matchDoc.data();
  return `${match.team_a ?? "?"} vs ${match.team_b ?? "?"} (${matchDoc.id})`;
}

async function missingMatchesForUser(userId, matchDocs) {
  const missing = [];
  for (const matchDoc of matchDocs) {
    const predSnap = await db.collection("predictions").doc(`${userId}_${matchDoc.id}`).get();
    if (!predSnap.exists) missing.push(matchLabel(matchDoc));
  }
  return missing;
}

async function main() {
  const matchDocs = await fetchUpcomingMatches();

  if (!matchDocs.length) {
    console.log("No matches kicking off in the next 24 hours.");
    return;
  }

  const users = await fetchUsers();
  const lines = [];

  for (const user of users) {
    const missing = await missingMatchesForUser(user.id, matchDocs);
    if (missing.length) {
      lines.push(`* ${user.name}: ${missing.join(", ")}`);
    }
  }

  if (!lines.length) {
    console.log("Everyone has a prediction in for every match in the next 24 hours.");
    return;
  }

  console.log("Users with missing predictions in the next 24h:");
  for (const line of lines) {
    console.log(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
