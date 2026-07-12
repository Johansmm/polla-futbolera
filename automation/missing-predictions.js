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

// Firestore's matches collection holds no team names (see CLAUDE.md) — they
// come from the Cloudflare Worker at read time, exactly as the web app does
// it. Best-effort: a Worker hiccup just leaves the names blank rather than
// failing the whole report, since the match id alone still identifies the
// fixture.
async function fetchWorkerMatchesById(workerUrl) {
  try {
    const res = await fetch(`${workerUrl}/matches`);
    if (!res.ok) return new Map();
    const data = await res.json();
    return new Map((data.matches ?? []).map((m) => [m.id, m]));
  } catch {
    return new Map();
  }
}

// admin/seed.js builds every match_id as "{phase}_{NN}", so the phase is
// recoverable from the id alone. Only used as a fallback for the merged
// phase — which is what the app itself scores by — so that a Worker outage
// degrades the report's names but never its filtering.
function phaseFromMatchId(matchId) {
  return matchId.replace(/_\d+$/, "");
}

// Only the phases this pool actually tracks. admin/seed.js deliberately seeds
// the whole competition, group stage included, so without this the report
// would nag everyone about matches nobody is supposed to predict.
async function fetchUpcomingTrackedMatches(mergeMatchData, trackedPhases, workerUrl) {
  const now = admin.firestore.Timestamp.fromDate(new Date());
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() + DAY_MS));

  const snap = await db
    .collection("matches")
    .where("kickoff_at", ">", now)
    .where("kickoff_at", "<=", cutoff)
    .get();

  const workerMatchesById = await fetchWorkerMatchesById(workerUrl);

  return snap.docs
    .map((d) => mergeMatchData({ id: d.id, ...d.data() }, workerMatchesById))
    .filter((match) => trackedPhases.has(match.phase ?? phaseFromMatchId(match.id)));
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

function matchLabel(match) {
  const remaining = formatRemaining(match.kickoff_at.toDate());
  return `${match.team_a ?? "?"} vs ${match.team_b ?? "?"} (${match.id}, ${remaining})`;
}

async function missingItemsForUser(userId, matches, specialDeadline) {
  const items = [];

  for (const match of matches) {
    const predSnap = await db.collection("predictions").doc(`${userId}_${match.id}`).get();
    if (!predSnap.exists) items.push(matchLabel(match));
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
  // Real ES modules loaded from CommonJS via dynamic import(), the same
  // pattern admin/seed.js uses — so the stage/phase mapping and the Worker's
  // URL each stay in exactly one place instead of being copied here.
  const { mergeMatchData, STAGE_TO_PHASE } = await import("../js/worker-matches.mjs");
  const { WORKER_URL } = await import("../js/worker-config.js");
  const trackedPhases = new Set(Object.values(STAGE_TO_PHASE));

  const matches = await fetchUpcomingTrackedMatches(mergeMatchData, trackedPhases, WORKER_URL);
  const specialDeadline = await fetchSpecialPredictionsDeadlineDueSoon();

  if (!matches.length && !specialDeadline) {
    console.log("Nothing locking in the next 24 hours.");
    return;
  }

  const users = await fetchUsers();
  const lines = [];

  for (const user of users) {
    const items = await missingItemsForUser(user.id, matches, specialDeadline);
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
