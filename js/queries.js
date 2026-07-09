// Firestore reads shared by more than one page — kept separate from
// special.js/standings.js so the duplicated query logic has one home
// instead of two copies that could drift out of sync.
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { mergeMatchData } from "./worker-matches.mjs";
import { WORKER_URL } from "./worker-config.js";

// null (config/special_predictions doesn't exist yet) means "no deadline
// configured" to callers — see lock-logic.mjs's isPastDeadline fail-closed
// note for how that's interpreted.
export async function fetchSpecialPredictionsDeadline() {
  const snap = await getDoc(doc(db, "config", "special_predictions"));
  return snap.exists() ? snap.data().locked_after.toDate() : null;
}

export async function fetchTeamRosters() {
  const snap = await getDocs(collection(db, "team_rosters"));
  return snap.docs.map((d) => d.data());
}

export async function fetchUserName(userId) {
  const snap = await getDoc(doc(db, "users", userId));
  return snap.exists() ? snap.data().name : null;
}

async function fetchFirestoreMatches() {
  const snap = await getDocs(query(collection(db, "matches"), orderBy("kickoff_at")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Failures here (network, Worker down) resolve to an empty list rather than
// throwing — team names/scores just stay blank, same as a match whose
// source_match_id hasn't resolved yet. Predictions/standings don't depend on
// the Worker at all, so a hiccup here shouldn't block the rest of the page.
async function fetchWorkerMatches() {
  try {
    const res = await fetch(`${WORKER_URL}/matches`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.matches ?? [];
  } catch {
    return [];
  }
}

export async function fetchMatches() {
  const [firestoreMatches, workerMatches] = await Promise.all([fetchFirestoreMatches(), fetchWorkerMatches()]);
  // Built once and reused for every Firestore match, rather than making
  // mergeMatchData scan the whole Worker response again each time.
  const workerMatchesById = new Map(workerMatches.map((m) => [m.id, m]));
  return firestoreMatches.map((match) => mergeMatchData(match, workerMatchesById));
}
