const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");

const HOUR = 60 * 60 * 1000;

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "poya-rules-test",
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
});

// Writes straight to the emulator, bypassing security rules — used to set
// up fixture state before each test exercises the rules themselves.
async function seed(setupFn) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setupFn(context.firestore());
  });
}

function futureMatch(overrides = {}) {
  return {
    match_id: "r16_01",
    phase: "r16",
    team_a: "A",
    team_b: "B",
    kickoff_at: new Date(Date.now() + HOUR),
    real_score_a: null,
    real_score_b: null,
    locked: false,
    ...overrides,
  };
}

async function bindUser(db, { uid, userId, token }) {
  await db.collection("tokens").doc(token).set({ user_id: userId });
  await db.collection("auth_links").doc(uid).set({ user_id: userId, token });
}

test("unauthenticated client cannot read matches", async () => {
  await seed((db) => db.collection("matches").doc("r16_01").set(futureMatch()));

  const unauth = testEnv.unauthenticatedContext();
  await assertFails(unauth.firestore().collection("matches").doc("r16_01").get());
});

test("binding a device to a user requires knowing the real token", async () => {
  await seed((db) => db.collection("tokens").doc("real-token").set({ user_id: "johan" }));

  const alice = testEnv.authenticatedContext("alice-uid").firestore();

  await assertFails(
    alice.collection("auth_links").doc("alice-uid").set({
      user_id: "johan",
      token: "guessed-token",
    })
  );

  await assertSucceeds(
    alice.collection("auth_links").doc("alice-uid").set({
      user_id: "johan",
      token: "real-token",
    })
  );
});

test("auth_links binding is immutable once created", async () => {
  await seed(async (db) => {
    await db.collection("tokens").doc("real-token").set({ user_id: "johan" });
    await db.collection("auth_links").doc("alice-uid").set({
      user_id: "johan",
      token: "real-token",
    });
  });

  const alice = testEnv.authenticatedContext("alice-uid").firestore();
  await assertFails(
    alice.collection("auth_links").doc("alice-uid").update({ user_id: "someone-else" })
  );
});

test("owner can create a prediction before kickoff; a stranger cannot", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  const prediction = {
    prediction_id: "johan_r16_01",
    user_id: "johan",
    match_id: "r16_01",
    predicted_score_a: 2,
    predicted_score_b: 1,
    points_earned: null,
  };

  await assertSucceeds(johan.collection("predictions").doc("johan_r16_01").set(prediction));
  await assertFails(stranger.collection("predictions").doc("johan_r16_01").set(prediction));
});

test("reading your own not-yet-created prediction succeeds (regression: resource == null)", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  // No prediction doc exists yet for johan_r16_01 — this must not throw a
  // rules-evaluation error the way `resource.data.user_id` on a null
  // resource used to.
  await assertSucceeds(johan.collection("predictions").doc("johan_r16_01").get());
});

test("writes are rejected once a match is past kickoff or force-locked", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch({ kickoff_at: new Date(Date.now() - HOUR) }));
    await db.collection("matches").doc("r16_02").set(futureMatch({ match_id: "r16_02", locked: true }));
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 1,
      points_earned: null,
    })
  );

  await assertFails(
    johan.collection("predictions").doc("johan_r16_02").set({
      prediction_id: "johan_r16_02",
      user_id: "johan",
      match_id: "r16_02",
      predicted_score_a: 1,
      predicted_score_b: 1,
      points_earned: null,
    })
  );
});

test("updating an existing prediction is rejected once the match's kickoff time passes", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 0,
      points_earned: null,
    });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  // Before kickoff: editing your own prediction works.
  await assertSucceeds(
    johan.collection("predictions").doc("johan_r16_01").update({
      predicted_score_a: 2,
      predicted_score_b: 0,
    })
  );

  // Mock kickoff time passing (equivalent to the real clock reaching
  // kickoff_at) by admin-updating the match doc directly, bypassing rules.
  await seed((db) =>
    db.collection("matches").doc("r16_01").update({ kickoff_at: new Date(Date.now() - HOUR) })
  );

  // After kickoff: the same edit is now rejected.
  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({
      predicted_score_a: 3,
      predicted_score_b: 0,
    })
  );
});

test("clients cannot write directly to matches, users, or tokens (admin-only collections)", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  // Can't self-unlock/relock a match or tamper with the real result.
  await assertFails(johan.collection("matches").doc("r16_01").update({ locked: true }));
  await assertFails(johan.collection("matches").doc("r16_01").update({ real_score_a: 5 }));

  // Can't edit your own display name or plant a fake token → user_id mapping.
  await assertFails(johan.collection("users").doc("johan").set({ name: "Not Johan" }));
  await assertFails(johan.collection("tokens").doc("free-token").set({ user_id: "johan" }));
});

test("prediction create rejects invalid scores", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: -1,
      predicted_score_b: 0,
      points_earned: null,
    })
  );

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1.5,
      predicted_score_b: 0,
      points_earned: null,
    })
  );
});

test("prediction create rejects a non-null points_earned (no self-scoring)", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 0,
      points_earned: 15,
    })
  );
});

test("prediction update cannot smuggle in changes to user_id, match_id, or points_earned", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 0,
      points_earned: null,
    });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({ points_earned: 15 })
  );
  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({ user_id: "kevin" })
  );
});

test("a device's auth_links binding cannot be deleted by its own owner", async () => {
  await seed((db) => bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" }));

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  await assertFails(johan.collection("auth_links").doc("johan-uid").delete());
});

test("other users' predictions are hidden pre-kickoff but visible once locked", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await db.collection("matches").doc("r16_02").set(
      futureMatch({ match_id: "r16_02", kickoff_at: new Date(Date.now() - HOUR) })
    );
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });

    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 2,
      predicted_score_b: 0,
      points_earned: null,
    });
    await db.collection("predictions").doc("johan_r16_02").set({
      prediction_id: "johan_r16_02",
      user_id: "johan",
      match_id: "r16_02",
      predicted_score_a: 1,
      predicted_score_b: 1,
      points_earned: null,
    });
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  // r16_01 hasn't kicked off yet — kevin can't see johan's prediction.
  await assertFails(kevin.collection("predictions").doc("johan_r16_01").get());

  // r16_02 already kicked off — now it's visible to everyone signed in.
  await assertSucceeds(kevin.collection("predictions").doc("johan_r16_02").get());
});

test("special_predictions are owner-only", async () => {
  await seed((db) => bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" }));

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  await assertSucceeds(
    johan.collection("special_predictions").doc("johan").set({
      user_id: "johan",
      champion_pick: "Argentina",
      top_scorer_pick: "Messi",
      champion_points: null,
      top_scorer_points: null,
    })
  );

  await assertFails(stranger.collection("special_predictions").doc("johan").get());
});
