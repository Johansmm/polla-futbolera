import {
  signInAnonymously,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";

function waitForAuthUser() {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe();
        resolve(user);
      },
      reject
    );
  });
}

async function ensureAnonymousUser() {
  const existing = await waitForAuthUser();
  if (existing) return existing;
  const credential = await signInAnonymously(auth);
  return credential.user;
}

async function resolveUserIdFromToken(token) {
  const tokenSnap = await getDoc(doc(db, "tokens", token));
  if (!tokenSnap.exists()) return null;
  return tokenSnap.data().user_id;
}

async function bindDeviceToUser(authUid, userId, token) {
  const linkRef = doc(db, "auth_links", authUid);
  const linkSnap = await getDoc(linkRef);

  if (linkSnap.exists()) {
    return linkSnap.data().user_id;
  }

  try {
    await setDoc(linkRef, { user_id: userId, token });
    return userId;
  } catch (err) {
    // Two tabs racing to create the same binding doc — re-read and treat
    // "already exists" as success rather than a hard failure.
    const retrySnap = await getDoc(linkRef);
    if (!retrySnap.exists()) throw err;
    return retrySnap.data().user_id;
  }
}

/**
 * Resolves a URL token into a bound user_id: signs the browser in
 * anonymously (reusing the persisted session if one exists) and creates
 * the auth_links binding doc on first use.
 *
 * Returns:
 *   null                                     — token doesn't exist
 *   { conflict: true, boundUserId, ... }      — this device is already bound to someone else
 *   { conflict: false, userId }               — success
 */
export async function signInWithToken(token) {
  if (!token) return null;

  const user = await ensureAnonymousUser();
  const userId = await resolveUserIdFromToken(token);
  if (!userId) return null;

  const boundUserId = await bindDeviceToUser(user.uid, userId, token);

  if (boundUserId !== userId) {
    return { conflict: true, boundUserId, requestedUserId: userId };
  }

  return { conflict: false, userId };
}

/**
 * Signs out the current anonymous session and starts a fresh one, so this
 * device can be (re)bound to a different user_id — e.g. a shared computer
 * previously used by another friend.
 */
export async function switchAccount(token) {
  await signOut(auth);
  return signInWithToken(token);
}
