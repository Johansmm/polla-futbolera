// Firestore reads shared by more than one page — kept separate from
// special.js/standings.js so the duplicated query logic has one home
// instead of two copies that could drift out of sync.
import {
  collection,
  getDocs,
  getDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";

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
