// Pure timing/lookup logic shared by predict.js and special.js — kept in its
// own dependency-free module (note the .mjs extension) so it can be
// unit-tested directly with node:test via dynamic import(). Every other
// js/*.js file imports the Firebase SDK from a CDN URL, which Node's module
// resolution can't follow, so none of those can be loaded from a test.

// kickoff_at arrives as a Firestore Timestamp in the browser but a plain
// Date/ISO string in tests and in automation scripts that read it back —
// normalize both to a Date here so callers don't each re-derive this check.
export function kickoffDate(match) {
  return match.kickoff_at?.toDate ? match.kickoff_at.toDate() : new Date(match.kickoff_at);
}

export function isMatchLocked(match) {
  if (match.locked) return true;
  return Date.now() >= kickoffDate(match).getTime();
}

// Mirrors firestore.rules' specialPredictionsDeadlinePassed(defaultIfUnset):
// a missing deadline (config/special_predictions doesn't exist) can't be
// "past" or "not past" on its own, so callers must say what to assume.
// special.js gates editing and defaults to true (stay locked with no
// deadline configured, matching the rules' write-gate default) — passing
// no second argument preserves that. A caller gating what's *readable*
// (e.g. standings.js) must pass false instead, matching the rules' read-gate
// default, or Firestore will deny the read the client didn't expect to be
// denied.
export function isPastDeadline(deadline, defaultIfUnset = true) {
  return deadline ? Date.now() >= deadline.getTime() : defaultIfUnset;
}

export function findTeamForPlayer(rosters, player) {
  return rosters.find((r) => r.players.includes(player))?.team ?? null;
}
