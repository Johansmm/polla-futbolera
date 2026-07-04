const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePhase,
  buildResultFields,
  buildFixturePatch,
  findMatchingDoc,
  generateMatchId,
  hasPendingResult,
} = require("../automation/sync-fixtures.js");

test("resolvePhase translates the five knockout stages this project cares about", () => {
  assert.equal(resolvePhase("LAST_16"), "r16");
  assert.equal(resolvePhase("QUARTER_FINALS"), "qf");
  assert.equal(resolvePhase("SEMI_FINALS"), "sf");
  assert.equal(resolvePhase("THIRD_PLACE"), "third_place");
  assert.equal(resolvePhase("FINAL"), "final");
});

test("resolvePhase passes unknown stages through as-is (group stage, Round of 32)", () => {
  assert.equal(resolvePhase("GROUP_STAGE"), "GROUP_STAGE");
  assert.equal(resolvePhase("LAST_32"), "LAST_32");
});

test("buildResultFields is empty until the match is finished", () => {
  assert.deepEqual(buildResultFields({ status: "SCHEDULED" }), {});
  assert.deepEqual(buildResultFields({ status: "IN_PLAY" }), {});
  assert.deepEqual(buildResultFields({ status: "PAUSED" }), {});
});

test("buildResultFields extracts the full-time score once finished", () => {
  const apiMatch = { status: "FINISHED", score: { fullTime: { home: 2, away: 1 } } };
  assert.deepEqual(buildResultFields(apiMatch), { real_score_a: 2, real_score_b: 1 });
});

test("buildFixturePatch maps stage, kickoff date, and both team names", () => {
  const apiMatch = {
    stage: "QUARTER_FINALS",
    utcDate: "2026-07-10T18:00:00Z",
    homeTeam: { name: "Brazil" },
    awayTeam: { name: "France" },
  };

  const patch = buildFixturePatch(apiMatch);

  assert.equal(patch.phase, "qf");
  assert.equal(patch.kickoffDate.toISOString(), "2026-07-10T18:00:00.000Z");
  assert.equal(patch.team_a, "Brazil");
  assert.equal(patch.team_b, "France");
});

test("buildFixturePatch omits team fields when the API hasn't resolved them yet", () => {
  const apiMatch = { stage: "LAST_16", utcDate: "2026-07-04T19:00:00Z", homeTeam: null, awayTeam: null };

  const patch = buildFixturePatch(apiMatch);

  assert.equal("team_a" in patch, false);
  assert.equal("team_b" in patch, false);
});

test("findMatchingDoc matches a candidate within the tolerance window", () => {
  const target = new Date("2026-07-10T18:00:00Z");
  const candidates = [
    { id: "qf_01", kickoffAt: new Date("2026-07-10T19:30:00Z") }, // 1.5h off — inside 3h
    { id: "qf_02", kickoffAt: new Date("2026-07-11T18:00:00Z") }, // 24h off
  ];

  assert.equal(findMatchingDoc(candidates, target).id, "qf_01");
});

test("findMatchingDoc returns undefined when nothing is close enough", () => {
  const target = new Date("2026-07-10T18:00:00Z");
  const candidates = [{ id: "qf_02", kickoffAt: new Date("2026-07-11T18:00:00Z") }];

  assert.equal(findMatchingDoc(candidates, target), undefined);
});

test("findMatchingDoc respects a custom tolerance", () => {
  const target = new Date("2026-07-10T18:00:00Z");
  const candidates = [{ id: "qf_01", kickoffAt: new Date("2026-07-10T19:30:00Z") }]; // 1.5h gap

  assert.equal(findMatchingDoc(candidates, target, 60 * 60 * 1000), undefined); // 1h tolerance
});

test("generateMatchId picks the next free suffix in a phase", () => {
  assert.equal(generateMatchId("qf", new Set()), "qf_01");
  assert.equal(generateMatchId("qf", new Set(["qf_01"])), "qf_02");
  assert.equal(generateMatchId("qf", new Set(["qf_01", "qf_02"])), "qf_03");
});

test("generateMatchId fills a gap left by a previously deleted match", () => {
  assert.equal(generateMatchId("qf", new Set(["qf_01", "qf_03"])), "qf_02");
});

test("hasPendingResult is true once kickoff has passed with no result yet", () => {
  const now = new Date("2026-07-10T20:00:00Z");
  const matches = [{ kickoffAt: new Date("2026-07-10T18:00:00Z"), real_score_a: null }];
  assert.equal(hasPendingResult(matches, now), true);
});

test("hasPendingResult is false once the result has been recorded", () => {
  const now = new Date("2026-07-10T20:00:00Z");
  const matches = [{ kickoffAt: new Date("2026-07-10T18:00:00Z"), real_score_a: 2 }];
  assert.equal(hasPendingResult(matches, now), false);
});

test("hasPendingResult is false before kickoff, even with no result yet", () => {
  const now = new Date("2026-07-10T20:00:00Z");
  const matches = [{ kickoffAt: new Date("2026-07-11T18:00:00Z"), real_score_a: null }];
  assert.equal(hasPendingResult(matches, now), false);
});

test("hasPendingResult ignores matches with no kickoff time synced yet", () => {
  const now = new Date("2026-07-10T20:00:00Z");
  assert.equal(hasPendingResult([{ kickoffAt: null, real_score_a: null }], now), false);
});

test("hasPendingResult is true if any match in the list is pending", () => {
  const now = new Date("2026-07-10T20:00:00Z");
  const matches = [
    { kickoffAt: new Date("2026-07-09T18:00:00Z"), real_score_a: 1 }, // already resolved
    { kickoffAt: new Date("2026-07-10T18:00:00Z"), real_score_a: null }, // pending
    { kickoffAt: new Date("2026-07-11T18:00:00Z"), real_score_a: null }, // not kicked off yet
  ];
  assert.equal(hasPendingResult(matches, now), true);
});
