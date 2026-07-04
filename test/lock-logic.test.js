const test = require("node:test");
const assert = require("node:assert/strict");

// js/lock-logic.mjs is a real ES module (note the extension) so it can be
// loaded here via dynamic import() even though this test file itself is
// CommonJS (per the root package.json).
let isMatchLocked;
let isPastDeadline;
let findTeamForPlayer;

test.before(async () => {
  ({ isMatchLocked, isPastDeadline, findTeamForPlayer } = await import("../js/lock-logic.mjs"));
});

const HOUR = 60 * 60 * 1000;

test("isMatchLocked is true when the locked flag is set, regardless of kickoff time", () => {
  assert.equal(isMatchLocked({ locked: true, kickoff_at: new Date(Date.now() + HOUR) }), true);
});

test("isMatchLocked is false before kickoff", () => {
  assert.equal(isMatchLocked({ locked: false, kickoff_at: new Date(Date.now() + HOUR) }), false);
});

test("isMatchLocked is true after kickoff", () => {
  assert.equal(isMatchLocked({ locked: false, kickoff_at: new Date(Date.now() - HOUR) }), true);
});

test("isMatchLocked treats kickoff exactly now as locked (boundary)", () => {
  const now = new Date();
  assert.equal(isMatchLocked({ locked: false, kickoff_at: now }), true);
});

test("isMatchLocked accepts a Firestore Timestamp-like object (.toDate())", () => {
  const timestampLike = { toDate: () => new Date(Date.now() - HOUR) };
  assert.equal(isMatchLocked({ locked: false, kickoff_at: timestampLike }), true);
});

test("isPastDeadline treats a missing deadline as already past by default", () => {
  assert.equal(isPastDeadline(null), true);
  assert.equal(isPastDeadline(undefined), true);
});

// standings.js needs the opposite default for a missing deadline (not
// revealed, matching firestore.rules' specialPredictionsDeadlinePassed(false))
// — this caught a real bug where reusing the default-true behavior made the
// client attempt a special_predictions read that Firestore denied outright.
test("isPastDeadline honors an explicit defaultIfUnset for a missing deadline", () => {
  assert.equal(isPastDeadline(null, false), false);
  assert.equal(isPastDeadline(undefined, false), false);
});

test("isPastDeadline is false before the deadline", () => {
  assert.equal(isPastDeadline(new Date(Date.now() + HOUR)), false);
});

test("isPastDeadline is true after the deadline", () => {
  assert.equal(isPastDeadline(new Date(Date.now() - HOUR)), true);
});

test("findTeamForPlayer finds the team owning a given player", () => {
  const rosters = [
    { team: "France", players: ["Kylian Mbappé", "Ousmane Dembélé"] },
    { team: "Argentina", players: ["Lionel Messi"] },
  ];
  assert.equal(findTeamForPlayer(rosters, "Lionel Messi"), "Argentina");
});

test("findTeamForPlayer returns null when no team has that player", () => {
  const rosters = [{ team: "France", players: ["Kylian Mbappé"] }];
  assert.equal(findTeamForPlayer(rosters, "Someone Else"), null);
});
