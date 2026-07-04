// Manually-triggered report (see .github/workflows/missing-predictions.yml):
// per user, lists which matches kicking off in the next 24 hours they're
// still missing a prediction for, plus the champion/top-scorer picks if
// that deadline also falls in the next 24 hours — one line per user, ready
// to paste into a nudge message — without opening the app or a PC (trigger
// the workflow from the GitHub mobile app/site). Each item shows how much
// time is left before it locks, as HHhMMm.
//
// Deliberately never reads predicted_score_a/predicted_score_b, or the
// values of champion_pick/top_scorer_pick: it only checks whether the
// relevant doc/field exists, never prints anyone's actual pick.
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

function formatRemaining(date) {
  const totalMinutes = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60000));
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}h${mm}m`;
}

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

// null if the deadline isn't set yet, or isn't within the next 24 hours —
// same "only surface it once it's actually close" rule as matches.
async function fetchSpecialPredictionsDeadlineDueSoon() {
  const snap = await db.collection("config").doc("special_predictions").get();
  if (!snap.exists) return null;

  const deadline = snap.data().locked_after.toDate();
  const dueSoon = deadline.getTime() > Date.now() && deadline.getTime() <= Date.now() + DAY_MS;
  return dueSoon ? deadline : null;
}

async function fetchUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

function matchLabel(matchDoc) {
  const match = matchDoc.data();
  const remaining = formatRemaining(match.kickoff_at.toDate());
  return `${match.team_a ?? "?"} vs ${match.team_b ?? "?"} (${matchDoc.id}, ${remaining})`;
}

async function missingItemsForUser(userId, matchDocs, specialDeadline) {
  const items = [];

  for (const matchDoc of matchDocs) {
    const predSnap = await db.collection("predictions").doc(`${userId}_${matchDoc.id}`).get();
    if (!predSnap.exists) items.push(matchLabel(matchDoc));
  }

  if (specialDeadline) {
    const remaining = formatRemaining(specialDeadline);
    const specialSnap = await db.collection("special_predictions").doc(userId).get();
    const special = specialSnap.exists ? specialSnap.data() : null;

    if (!special || special.champion_pick == null) {
      items.push(`Champion pick (${remaining})`);
    }
    if (!special || special.top_scorer_pick == null) {
      items.push(`Top scorer pick (${remaining})`);
    }
  }

  return items;
}

async function main() {
  const matchDocs = await fetchUpcomingMatches();
  const specialDeadline = await fetchSpecialPredictionsDeadlineDueSoon();

  if (!matchDocs.length && !specialDeadline) {
    console.log("Nothing locking in the next 24 hours.");
    return;
  }

  const users = await fetchUsers();
  const lines = [];

  for (const user of users) {
    const items = await missingItemsForUser(user.id, matchDocs, specialDeadline);
    if (items.length) {
      lines.push(`* ${user.name}: ${items.join(", ")}`);
    }
  }

  if (!lines.length) {
    console.log("Everyone is up to date for everything locking in the next 24 hours.");
    return;
  }

  console.log("Users with missing predictions in the next 24h:");
  for (const line of lines) {
    console.log(line);
  }
  console.log("\n(HHhMMm) = time left before that item locks.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
