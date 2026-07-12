const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");

const HOUR = 60 * 60 * 1000;

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "polla-rules-test",
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

// No `locked` field — matchDeadlinePassed() derives locking purely from
// kickoff_at, so a real match doc never carries one.
function futureMatch(overrides = {}) {
  return {
    match_id: "r16_01",
    phase: "r16",
    team_a: "A",
    team_b: "B",
    kickoff_at: new Date(Date.now() + HOUR),
    real_score_a: null,
    real_score_b: null,
    ...overrides,
  };
}

async function bindUser(db, { uid, userId, token }) {
  await db.collection("tokens").doc(token).set({ user_id: userId });
  await db.collection("auth_links").doc(uid).set({ user_id: userId, token });
}

async function setSpecialPredictionsDeadline(db, date) {
  await db.collection("config").doc("special_predictions").set({ locked_after: date });
}

function samplePick(overrides = {}) {
  return {
    user_id: "johan",
    champion_pick: "Argentina",
    top_scorer_pick: "Messi",
    top_scorer_pick_team: "Argentina",
    ...overrides,
  };
}

test("unauthenticated client cannot read matches", async () => {
  await seed((db) => db.collection("matches").doc("r16_01").set(futureMatch()));

  const unauth = testEnv.unauthenticatedContext();
  await assertFails(unauth.firestore().collection("matches").doc("r16_01").get());
});

// Anonymous sign-in is open to anyone on the internet (the web app's Firebase
// config is public by design), so merely holding an auth uid must buy nothing:
// a client only becomes a player by presenting a real token, which is what
// creates its auth_links binding. Without this, any stranger could read the
// whole pool — including, before the token moved off the user doc, everyone's
// credentials.
test("a signed-in client that never presented a token can read nothing", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await db.collection("users").doc("johan").set({ user_id: "johan", name: "Johan" });
    await db.collection("team_rosters").doc("France").set({ team: "France", players: ["Kylian Mbappé"] });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
  });

  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  await assertFails(stranger.collection("matches").doc("r16_01").get());
  await assertFails(stranger.collection("users").doc("johan").get());
  await assertFails(stranger.collection("users").get());
  await assertFails(stranger.collection("team_rosters").doc("France").get());
  await assertFails(stranger.collection("config").doc("special_predictions").get());
});

// The standings page lists every player by name, so the users collection is
// readable by the whole pool — which is exactly why a token must never be
// stored on it. This pins the invariant that made that safe.
test("a player can list users, and user tokens are not reachable from any client", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await db.collection("users").doc("johan").set({ user_id: "johan", name: "Johan" });
    await db.collection("users").doc("kevin").set({ user_id: "kevin", name: "Kevin" });
    // Where the token actually lives now: admin-only, never client-readable.
    await db.collection("user_links").doc("kevin").set({ token: "kevin-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  const snap = await assertSucceeds(johan.collection("users").get());
  assert.equal(snap.size, 2);
  // Names, yes. Credentials, no — not on the doc, and not anywhere a client
  // can reach, so one player can never impersonate another.
  assert.ok(snap.docs.every((d) => d.data().token === undefined));

  await assertFails(johan.collection("user_links").doc("kevin").get());
  await assertFails(johan.collection("user_links").get());
  await assertFails(johan.collection("user_links").doc("johan").set({ token: "self-issued" }));
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

test("prediction create is rejected once a match's kickoff time has passed", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch({ kickoff_at: new Date(Date.now() - HOUR) }));
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
    })
  );
});

test("a match with no locked field at all still locks purely from kickoff_at", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertSucceeds(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 1,
    })
  );

  await seed((db) => db.collection("matches").doc("r16_01").update({ kickoff_at: new Date(Date.now() - HOUR) }));

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({
      predicted_score_a: 2,
      predicted_score_b: 2,
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
    })
  );

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1.5,
      predicted_score_b: 0,
    })
  );

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 100,
      predicted_score_b: 0,
    })
  );
});

test("prediction update rejects invalid scores", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 0,
    });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({ predicted_score_a: -1 })
  );
  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({ predicted_score_a: 100 })
  );
  await assertFails(
    johan.collection("predictions").doc("johan_r16_01").update({ predicted_score_a: 1.5 })
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

// The update rule has always constrained which keys can change; create used
// to be the hole through which extra fields could be parked on a doc the
// whole pool reads once the match locks.
test("prediction create cannot smuggle in fields outside the known schema", async () => {
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
      predicted_score_a: 2,
      predicted_score_b: 1,
      points_earned: 999,
    })
  );
});

// Create type-checks the picks; update must too, or a pick can be swapped
// for something create would never have accepted — and these get rendered
// into everyone's standings once revealed.
test("special_predictions update cannot swap a pick for a non-string", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(
    johan.collection("special_predictions").doc("johan").update({ champion_pick: 42 })
  );
  await assertFails(
    johan.collection("special_predictions").doc("johan").update({ top_scorer_pick: ["Messi"] })
  );
  // The legitimate edit still works.
  await assertSucceeds(
    johan.collection("special_predictions").doc("johan").update({ champion_pick: "Brazil" })
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
    });
    await db.collection("predictions").doc("johan_r16_02").set({
      prediction_id: "johan_r16_02",
      user_id: "johan",
      match_id: "r16_02",
      predicted_score_a: 1,
      predicted_score_b: 1,
    });
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  // r16_01 hasn't kicked off yet — kevin can't see johan's prediction.
  await assertFails(kevin.collection("predictions").doc("johan_r16_01").get());

  // r16_02 already kicked off — now it's visible to everyone signed in.
  await assertSucceeds(kevin.collection("predictions").doc("johan_r16_02").get());
});

// A standings page needs to fetch every user's prediction for a locked
// match in one query, not just its own — these confirm the `list` (query)
// case behaves the same as the single-doc `get()` case above. Firestore
// evaluates list rules against the query's *potential* result set, and
// matchDeadlinePassed(matchId) is the same value for every doc a
// `.where("match_id", "==", matchId)` query can possibly return.
//
// The querying user is a *different* player from the ones who made the
// predictions, which is the real point: matchDeadlinePassed(...) alone
// satisfies the read rule's `isOwner(...) || matchDeadlinePassed(...)`, so
// any player can read them once the match locks. seed() bypasses rules
// entirely, so no binding is needed to write the fixture docs.
test("a list query for a locked match's predictions returns every user's prediction", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(
      futureMatch({ kickoff_at: new Date(Date.now() - HOUR) })
    );
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });

    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 2,
      predicted_score_b: 0,
    });
    await db.collection("predictions").doc("kevin_r16_01").set({
      prediction_id: "kevin_r16_01",
      user_id: "kevin",
      match_id: "r16_01",
      predicted_score_a: 1,
      predicted_score_b: 1,
    });
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  const snap = await assertSucceeds(
    kevin.collection("predictions").where("match_id", "==", "r16_01").get()
  );
  assert.equal(snap.size, 2);
});

test("a list query for a not-yet-locked match's predictions is denied", async () => {
  await seed(async (db) => {
    await db.collection("matches").doc("r16_01").set(futureMatch());
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });

    await db.collection("predictions").doc("johan_r16_01").set({
      prediction_id: "johan_r16_01",
      user_id: "johan",
      match_id: "r16_01",
      predicted_score_a: 2,
      predicted_score_b: 0,
    });
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  await assertFails(kevin.collection("predictions").where("match_id", "==", "r16_01").get());
});

// Same reasoning for special_predictions: the standings page needs every
// user's champion/top-scorer pick in one unconstrained list query once the
// reveal deadline has passed, not just its own doc. Again, the querying
// stranger is deliberately never bound — specialPredictionsDeadlinePassed()
// alone must carry the read rule here.
test("a list query for special_predictions returns every pick once the reveal deadline passes", async () => {
  await seed(async (db) => {
    await setSpecialPredictionsDeadline(db, new Date(Date.now() - HOUR));
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });
    await db.collection("special_predictions").doc("johan").set(samplePick());
    await db.collection("special_predictions").doc("kevin").set(samplePick({ user_id: "kevin" }));
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  const snap = await assertSucceeds(kevin.collection("special_predictions").get());
  assert.equal(snap.size, 2);
});

test("a list query for special_predictions is denied before the reveal deadline", async () => {
  await seed(async (db) => {
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  await assertFails(kevin.collection("special_predictions").get());
});

test("special_predictions is hidden from others before the reveal deadline", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();

  await assertSucceeds(johan.collection("special_predictions").doc("johan").set(samplePick()));
  await assertFails(stranger.collection("special_predictions").doc("johan").get());
});

test("special_predictions becomes readable by every player once the reveal deadline passes", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await bindUser(db, { uid: "kevin-uid", userId: "kevin", token: "kevin-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() - HOUR));
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const kevin = testEnv.authenticatedContext("kevin-uid").firestore();

  // The standings page needs this to compute champion/top-scorer points for
  // every user, not just the signed-in one.
  await assertSucceeds(kevin.collection("special_predictions").doc("johan").get());

  // ...but "everyone" still means everyone *in the pool* — a signed-in
  // session that never presented a token is not a player.
  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();
  await assertFails(stranger.collection("special_predictions").doc("johan").get());
});

test("special_predictions stays hidden if no deadline has ever been configured", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    // Bypass the create rule directly (as the admin would via console/seed
    // script) so a pick can exist even with no config/special_predictions
    // doc — the reveal check must fail closed (hidden), not fail open.
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const stranger = testEnv.authenticatedContext("stranger-uid").firestore();
  await assertFails(stranger.collection("special_predictions").doc("johan").get());
});

test("special_predictions create fails by default when no deadline has been configured", async () => {
  await seed((db) => bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" }));

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(johan.collection("special_predictions").doc("johan").set(samplePick()));
});

test("special_predictions can be updated before the deadline but not after", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  // Before the deadline: changing your pick works.
  await assertSucceeds(
    johan.collection("special_predictions").doc("johan").update({ champion_pick: "Brazil" })
  );

  // Deadline passes (admin/seed.js would recompute this from the real
  // fixture; here we just move it into the past to simulate that).
  await seed((db) => setSpecialPredictionsDeadline(db, new Date(Date.now() - HOUR)));

  await assertFails(
    johan.collection("special_predictions").doc("johan").update({ champion_pick: "France" })
  );
});

test("special_predictions update can change top_scorer_pick_team alongside the pick itself", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
    await db.collection("special_predictions").doc("johan").set(samplePick());
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertSucceeds(
    johan
      .collection("special_predictions")
      .doc("johan")
      .update({ top_scorer_pick: "Mbappé", top_scorer_pick_team: "France" })
  );
});

test("special_predictions create fails when top_scorer_pick_team is missing", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const { top_scorer_pick_team, ...pickWithoutTeam } = samplePick();

  await assertFails(johan.collection("special_predictions").doc("johan").set(pickWithoutTeam));
});

test("special_predictions create fails once the deadline has passed", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() - HOUR));
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();

  await assertFails(johan.collection("special_predictions").doc("johan").set(samplePick()));
});

test("team_rosters is readable by a player but never writable by clients", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await db.collection("team_rosters").doc("France").set({ team: "France", players: ["Kylian Mbappé"] });
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const unauth = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(johan.collection("team_rosters").doc("France").get());
  await assertFails(unauth.collection("team_rosters").doc("France").get());
  await assertFails(
    johan.collection("team_rosters").doc("France").set({ team: "France", players: [] })
  );
});

test("config is readable by a player but never writable by clients", async () => {
  await seed(async (db) => {
    await bindUser(db, { uid: "johan-uid", userId: "johan", token: "johan-token" });
    await setSpecialPredictionsDeadline(db, new Date(Date.now() + HOUR));
  });

  const johan = testEnv.authenticatedContext("johan-uid").firestore();
  const unauth = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(johan.collection("config").doc("special_predictions").get());
  await assertFails(unauth.collection("config").doc("special_predictions").get());
  await assertFails(
    johan.collection("config").doc("special_predictions").set({ locked_after: new Date() })
  );
});
