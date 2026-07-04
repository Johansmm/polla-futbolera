// One-off migration script (Admin SDK — bypasses all Firestore security
// rules, run this locally only, never deploy it as a live endpoint).
//
// Usage:
//   cd admin
//   node rename-user.js id <old_id> <new_id> [new_name]
//   node rename-user.js name <user_id> <new_name>
//
// "id" renames a user's user_id across every collection that references it
// (users, tokens, auth_links, predictions, special_predictions), while
// keeping their token and predictions/special_predictions data intact.
// Optionally also updates their display name at the same time. Order
// matters: everything is copied under the new id first, and only deleted
// from the old id at the very end — a failure partway through leaves
// duplicated data (recoverable), never lost data.
//
// "name" is the lighter-weight path for when the user_id itself doesn't
// need to change — name is purely cosmetic (shown in admin/seed.js logs
// and automation/missing-predictions.js's report), so this is just a
// single field update, no migration needed.
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function renameId(oldId, newId, newName) {
  if (newId.includes("_")) {
    console.error(`new_id "${newId}" can't contain "_" — firestore.rules splits prediction doc IDs on it.`);
    process.exit(1);
  }

  const oldUserRef = db.collection("users").doc(oldId);
  const oldUserSnap = await oldUserRef.get();
  if (!oldUserSnap.exists) {
    console.error(`No user found with id "${oldId}".`);
    process.exit(1);
  }

  const newUserRef = db.collection("users").doc(newId);
  if ((await newUserRef.get()).exists) {
    console.error(`A user with id "${newId}" already exists — pick a different new_id.`);
    process.exit(1);
  }

  const oldUser = oldUserSnap.data();
  const name = newName ?? oldUser.name;

  // 1. Copy the user doc under the new id.
  await newUserRef.set({ ...oldUser, user_id: newId, name });

  // 2. Point the existing token at the new id — the token value itself
  // doesn't change, so nobody's link breaks.
  if (oldUser.token) {
    await db.collection("tokens").doc(oldUser.token).update({ user_id: newId });
  }

  // 3. Re-point every auth_links binding (one per device) at the new id.
  const authLinksSnap = await db.collection("auth_links").where("user_id", "==", oldId).get();
  for (const doc of authLinksSnap.docs) {
    await doc.ref.update({ user_id: newId });
  }

  // 4. Copy each prediction under its new composite id, preserving the
  // predicted scores and points_earned untouched.
  const predictionsSnap = await db.collection("predictions").where("user_id", "==", oldId).get();
  for (const doc of predictionsSnap.docs) {
    const data = doc.data();
    const newPredictionId = `${newId}_${data.match_id}`;
    await db.collection("predictions").doc(newPredictionId).set({
      ...data,
      prediction_id: newPredictionId,
      user_id: newId,
    });
  }

  // 5. Copy special_predictions too, if the user made a pick.
  const specialSnap = await db.collection("special_predictions").doc(oldId).get();
  if (specialSnap.exists) {
    await db.collection("special_predictions").doc(newId).set({
      ...specialSnap.data(),
      user_id: newId,
    });
  }

  // 6. Only now that everything is safely copied, delete the old docs.
  for (const doc of predictionsSnap.docs) {
    await doc.ref.delete();
  }
  if (specialSnap.exists) {
    await specialSnap.ref.delete();
  }
  await oldUserRef.delete();

  console.log(`Renamed "${oldId}" -> "${newId}"${newName ? ` (name: "${name}")` : ""}.`);
  console.log(
    `Migrated ${authLinksSnap.size} device binding(s), ${predictionsSnap.size} prediction(s)` +
      `${specialSnap.exists ? ", and special_predictions" : ""}.`
  );
}

async function renameName(userId, newName) {
  const userRef = db.collection("users").doc(userId);
  if (!(await userRef.get()).exists) {
    console.error(`No user found with id "${userId}".`);
    process.exit(1);
  }

  await userRef.update({ name: newName });
  console.log(`"${userId}".name -> "${newName}".`);
}

function printUsageAndExit() {
  console.error("Usage:");
  console.error("  node rename-user.js id <old_id> <new_id> [new_name]");
  console.error("  node rename-user.js name <user_id> <new_name>");
  process.exit(1);
}

async function main() {
  const [, , mode, ...rest] = process.argv;

  if (mode === "id") {
    const [oldId, newId, newName] = rest;
    if (!oldId || !newId) printUsageAndExit();
    await renameId(oldId, newId, newName);
  } else if (mode === "name") {
    const [userId, newName] = rest;
    if (!userId || !newName) printUsageAndExit();
    await renameName(userId, newName);
  } else {
    printUsageAndExit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
