// Pure timing/lookup logic shared by predict.js and special.js — kept in its
// own dependency-free module (note the .mjs extension) so it can be
// unit-tested directly with node:test via dynamic import(). Every other
// js/*.js file imports the Firebase SDK from a CDN URL, which Node's module
// resolution can't follow, so none of those can be loaded from a test.

export function isMatchLocked(match) {
  if (match.locked) return true;
  const kickoff = match.kickoff_at?.toDate ? match.kickoff_at.toDate() : new Date(match.kickoff_at);
  return Date.now() >= kickoff.getTime();
}

// null/missing deadline is treated as already past — matches
// firestore.rules' specialPredictionsLocked() fail-closed default.
export function isPastDeadline(deadline) {
  return !deadline || Date.now() >= deadline.getTime();
}

export function findTeamForPlayer(rosters, player) {
  return rosters.find((r) => r.players.includes(player))?.team ?? null;
}
