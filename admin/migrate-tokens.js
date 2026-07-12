// One-off security migration (Admin SDK — bypasses all Firestore security
// rules, run this locally only, never deploy it as a live endpoint).
//
// Usage:
//   cd admin
//   npm install
//   node migrate-tokens.js            # dry run — prints what it WOULD do, writes nothing
//   node migrate-tokens.js --apply    # actually performs the migration
//   node migrate-tokens.js --apply --rotate
//
// Earlier versions of admin/seed.js stored each player's login token as a field
// on their users/{user_id} doc. Every player can read that collection (the
// standings page lists everyone by name) and Firestore rules cannot hide a
// single field from a document read — so every player's credential was readable
// by every other player, and (until firestore.rules started requiring an
// auth_links binding) by any anonymous stranger who found the public Firebase
// config. The token IS the credential here, so that is full account takeover.
//
// This moves any token still on a user doc to the admin-only
// user_links/{user_id} and deletes the field. Nobody's link breaks: the token
// value itself doesn't change, and tokens/{token} — what login actually reads —
// is untouched.
//
// The same migration also runs as part of admin/seed.js, but seed.js re-fetches
// and rewrites the whole fixture list and every squad, which is far more than
// you want to touch just to close this. This script writes to nothing else.
//
// --rotate additionally issues each player a BRAND-NEW token and prints their
// new link. Use it if you believe the old tokens may already have been
// harvested while they were readable — moving a leaked token somewhere safe
// doesn't stop it from working. It invalidates every existing link, so you must
// re-send them. Devices stay bound (auth_links is keyed by user_id, not token),
// so nobody has to re-bind; they just need the new URL.
const admin = require("firebase-admin");
const crypto = require("crypto");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const ROTATE = process.argv.includes("--rotate");

// Same generator as admin/seed.js — 128 bits of CSPRNG entropy, so a token is
// unguessable even though tokens/{token} is gettable by anyone signed in.
function generateToken() {
  return crypto.randomBytes(16).toString("base64url");
}

// Idempotent: a user doc with no token field and an existing user_links entry is
// already migrated and reports as such, so this is safe to re-run (and safe to
// run after seed.js has already migrated some or all of them).
async function main() {
  if (!APPLY) {
    console.log("DRY RUN — nothing will be written. Re-run with --apply to perform the migration.\n");
  }
  if (ROTATE) {
    console.log("--rotate: every player will be issued a NEW token; their current links will stop working.\n");
  }

  const users = await db.collection("users").get();
  if (users.empty) {
    console.log("No users found — nothing to do.");
    return;
  }

  let exposed = 0;
  let alreadyClean = 0;
  const newLinks = [];

  for (const userDoc of users.docs) {
    const userId = userDoc.id;
    const legacyToken = userDoc.data().token;
    const linkSnap = await db.collection("user_links").doc(userId).get();

    if (legacyToken) exposed++;
    else alreadyClean++;

    // The token to end up on user_links: a fresh one if rotating, otherwise
    // whatever this user already has, wherever it currently lives.
    const currentToken = legacyToken ?? (linkSnap.exists ? linkSnap.data().token : null);
    if (!currentToken && !ROTATE) {
      console.log(`  ${userId}: no token anywhere — skipping (regenerate one with --rotate if this is wrong)`);
      continue;
    }
    const token = ROTATE ? generateToken() : currentToken;

    const actions = [];
    if (legacyToken) actions.push("strip token from users doc");
    if (!linkSnap.exists || linkSnap.data().token !== token) actions.push("write user_links");
    if (ROTATE) actions.push(`new token (revokes old link${currentToken ? "" : ", none existed"})`);

    console.log(`  ${userId}: ${actions.length ? actions.join(", ") : "already migrated, nothing to do"}`);

    if (!APPLY) continue;

    // Order matters: the token is safely in its new home (and the tokens/
    // lookup points at the user) BEFORE it's removed from the old one. A
    // failure partway through leaves a token readable-but-working, never a
    // player locked out of their own link.
    await db.collection("user_links").doc(userId).set({ token }, { merge: true });

    if (ROTATE) {
      await db.collection("tokens").doc(token).set({ user_id: userId });
      if (currentToken && currentToken !== token) {
        await db.collection("tokens").doc(currentToken).delete();
      }
      newLinks.push({ userId, token });
    }

    if (legacyToken) {
      await userDoc.ref.update({ token: admin.firestore.FieldValue.delete() });
    }
  }

  console.log(
    `\n${users.size} user(s): ${exposed} with an exposed token on their user doc, ${alreadyClean} already clean.`
  );

  if (!APPLY) {
    console.log("Dry run — nothing was written. Re-run with --apply.");
    return;
  }

  console.log("Done. No token is readable by any client now.");

  if (newLinks.length) {
    console.log("\nNEW LINKS — send these out; the old ones no longer work:\n");
    for (const { userId, token } of newLinks) {
      console.log(`  ${userId}: predict.html?token=${token}`);
    }
    console.log("\nSave these now — they aren't printed again (re-read them from user_links/{user_id}).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
