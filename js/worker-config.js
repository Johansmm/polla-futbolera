// Public Cloudflare Worker URL — not a secret (the Worker itself gates
// access to the match-data source via its own server-side secret, see
// worker/wrangler.toml).
export const WORKER_URL = "https://polla-match-proxy.jmejia-cloudflare.workers.dev";
