// Shared config for talking to football-data.org — the one place
// admin/seed.js and the Cloudflare Worker (worker/src/index.mjs) both read
// these from, instead of each keeping its own copy that could drift apart.
// Verify against football-data.org's current docs if the tournament format
// changes.
export const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";
export const COMPETITION_CODE = "WC"; // FIFA World Cup
