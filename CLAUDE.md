# World Cup 2026 Prediction Pool ("Polla") — Project Context

## Goal

Build a web app for a small private group of clients, based in different
European countries (relevant to `js/ui.js`'s time formatting — no single
fixed timezone to assume), to predict World Cup 2026 match scores from the
Round of 16 onward (Round of 16, Quarterfinals, Semifinals, Third Place,
Final). No real-money handling inside the app — the prize pool split is
managed separately by the organizer. The app only needs to track
predictions and, eventually, compute standings. The group's actual size
isn't a technical constraint anywhere in this design (Firestore, the
Worker's shared KV cache, and the client-side scoring/standings math all
scale well past a small group) — it's just the intended audience.

## Architecture

See `README.md`'s "How it works" section (sequence diagram included) for
the full request flow and "Project structure" for what's in each folder. In
short: `admin/seed.js` — run by Johan, the organizer and the app's only
admin — seeds a minimal `matches` skeleton
(`match_id`/`kickoff_at`/`source_match_id`) plus users/tokens/rosters; the
client merges that with live match data from a Cloudflare Worker proxying
football-data.org on every page load; predictions are written directly
client → Firestore, gated by `firestore.rules`. Nothing about a match's
teams/scores, and nothing about anyone's points, is ever stored — both are
computed at read time.

## Priority for MVP (do this first)

1. `users` collection/table + token-based login (see Auth below)
2. `matches` collection/table — fixture from Round of 16 to the Final
3. A simple form: user opens their unique link, sees pending matches, enters
   `predicted_score_a` / `predicted_score_b`
4. Auto-lock a match's predictions at kickoff time (no edits after)

Originally deprioritized, since built:
- ~~Scoring/points calculation~~ — `js/scoring-logic.mjs`, computed on the
  fly, never stored (see "Scoring rules" below).
- ~~Standings dashboard~~ — `standings.html` + `js/standings-logic.mjs`.
- ~~Automatic fixture/results fetching~~ — implemented via a Cloudflare
  Worker (`worker/`) proxying football-data.org, cron-free: the client
  (`js/worker-matches.mjs`) fetches match data straight from it on page
  load and merges it with Firestore's minimal `matches` collection
  (`match_id`/`kickoff_at`/`source_match_id` only). Stays 100% free — see
  `README.md`'s "Cloudflare Worker match proxy" section for setup. A GitHub
  Actions cron writing fixture/result data into Firestore directly used to
  do this job instead; removed once the Worker replaced it entirely.

Still deprioritized:
- Discord bot integration (planned as a second, parallel input channel
  later — same backend, same `user_id`, just another client)

## Tech stack decisions

- **Frontend**: static web app, hosted on GitHub Pages (or Vercel/Netlify)
- **Backend/DB**: Firebase (Firestore) — no server to maintain, generous free
  tier, browser talks directly to Firestore via SDK
- **Auth**: NOT Firebase Phone Auth (requires Blaze plan + per-SMS billing,
  not acceptable — must stay 100% free). Instead: per-user unique token in
  the URL (e.g. `https://<site>/predict?token=abc123`). No SMS, no email,
  no card required.
- Security rules (Firestore rules, not app code) must enforce:
  - A user can only write to their own predictions (matched by token → user_id)
  - Predictions from other users are hidden until the match's kickoff time
  - No writes allowed to a match's predictions once its `kickoff_at` has passed

## Code conventions

- Comments and docs should describe things generically rather than
  hardcoding facts specific to one tournament's format that could change or
  go stale later (e.g. say "every team" / "the expanded format" instead of
  "48 teams" / "the 48-team format"). World Cup 2026 added a Round of 32
  that didn't exist before; a future tournament could just as easily change
  team counts, phase names, or match counts again — comments shouldn't need
  editing just because a number like that changed.

## Data schema (Firestore collections)

### `users`
| Field | Type | Notes |
|---|---|---|
| `user_id` | string | Internal, permanent, never changes |
| `name` | string | Display name |
| `token` | string | Regenerable by admin without losing user's data — token is decoupled from user_id and predictions |
| `created_at` | timestamp | |

### `matches`
| Field | Type | Notes |
|---|---|---|
| `match_id` | string | e.g. `r16_01` — this project's own id, independent of whatever match-data source is behind the Worker; derived from the competition's phase + kickoff order (see `admin/seed.js`), never re-derived once assigned |
| `kickoff_at` | timestamp | Used to auto-lock predictions — the only reason this collection exists in Firestore at all, since security rules can't call external APIs |
| `source_match_id` | number | The match-data source's own id for this fixture (e.g. football-data.org's numeric match id), used to look up the corresponding entry in the Worker's response. Deliberately not named after the source itself — a future source change only means updating the value, not every reference to the field's name |

Everything else about a match — `phase`, `team_a`/`team_b`, crest URLs,
`real_score_a`/`real_score_b`, `live_score_a`/`live_score_b` — comes from
the Cloudflare Worker proxy at read time, merged in by
`js/worker-matches.mjs`; none of it is stored in Firestore. `locked` isn't
stored either: `firestore.rules`' `matchDeadlinePassed()` and
`js/lock-logic.mjs`'s `isMatchLocked()` both derive it purely from
`kickoff_at`.

### `predictions`
| Field | Type | Notes |
|---|---|---|
| `prediction_id` | string | |
| `user_id` | string | FK to users |
| `match_id` | string | FK to matches |
| `predicted_score_a` / `predicted_score_b` | number | Winner is DERIVED from this, not stored separately |

No `points_earned` field — points are computed on the fly by whatever reads
this data (see "Scoring rules" below), never precomputed/stored. Readable by
everyone once `matches.{match_id}` is locked, not just the owner (see
`firestore.rules`), which is what makes that live computation possible.

### `special_predictions` (one doc per user, set once at tournament start)
| Field | Type | Notes |
|---|---|---|
| `user_id` | string | |
| `champion_pick` | string | |
| `top_scorer_pick` | string | |
| `top_scorer_pick_team` | string | The picked player's national team, resolved from `team_rosters` and stored at save time (`special.html`'s two-step dropdown already knows it) so `standings.js` never has to re-fetch every team's roster just to check the `team_reaches_semifinal_or_final_bonus` |

No `champion_points`/`top_scorer_points` fields, same reasoning as
`predictions` above. Chosen via `special.html`, editable (create or update)
until `config/special_predictions.locked_after` — the group's agreed
deadline (the first Round of 16 kickoff, recomputed automatically by
`admin/seed.js` from whatever's currently in `matches`). Locked for editing
by default if that deadline hasn't been configured yet. Readable by everyone
once that same deadline has passed (defaults to hidden, not revealed, if the
deadline was never configured) — otherwise owner-only.

### `team_rosters` (doc id = team name, admin-seeded via `admin/seed.js`)
| Field | Type | Notes |
|---|---|---|
| `team` | string | Same team name string used as `matches.team_a`/`team_b` |
| `players` | array\<string\> | Full squad, from football-data.org |

Backs `special.html`'s champion/top-scorer dropdowns (real team/player names
instead of free text, so there's no typo/spelling mismatch when scoring
later). Read-only to clients, admin-only write, like every other reference
collection.

### `config` (small admin-set documents, doc id = purpose)
| Doc | Field | Notes |
|---|---|---|
| `special_predictions` | `locked_after` (timestamp) | See `special_predictions` above |
| `tournament_results` | `top_scorer` (string), `top_3_scorers` (array\<string\>) | Only needs setting if the live signal (see "Scoring rules" below) can't resolve the Golden Boot on its own — i.e. a goals tie at tournament end, where the real award goes by FIFA's tie-break (assists, then fewest minutes played), not raw goal count. If nobody's picks are affected by such a tie, this can be left unset for the whole tournament. Champion/finalists/semifinalists are *not* stored here; they're derived on the fly from the `final`/`sf` matches' real scores |

Read-only to clients, admin-only write, like every other reference
collection.

## Scoring rules (LOCKED with the group)

Stored in `scoring_config.json` at the repo root so weights stay tunable
without touching code:

```json
{
  "match_outcome_points": {
    "exact_score": 5,
    "correct_winner_and_difference": 3,
    "correct_winner_or_draw": 1,
    "miss": 0
  },
  "phase_multipliers": {
    "r16": 1,
    "qf": 1.5,
    "sf": 2,
    "third_place": 2,
    "final": 3
  },
  "special_predictions": {
    "champion": {
      "exact_champion": 8,
      "finalist": 3
    },
    "top_scorer": {
      "exact": 10,
      "top_3": 5,
      "team_reaches_semifinal_or_final_bonus": 3
    }
  }
}
```

Per-match formula — outcome tiers are mutually exclusive, the highest
applicable tier wins, they never stack:

```
points = outcome_points(prediction, match) * phase_multipliers[match.phase]
```

Where `outcome_points` is, in order: `exact_score` if the scoreline matches
exactly; else `correct_winner_and_difference` if the goal difference matches
and the match had a decisive winner (a correctly-predicted **draw** always
falls through to the tier below instead, regardless of the exact draw
score — a draw's difference is always 0, so it isn't a meaningful "correct
margin" the way it is for a decisive result); else `correct_winner_or_draw`
if just the winner (or draw) was right; else `miss`. `third_place` shares
`sf`'s multiplier — played the same week as the Final, but not the
tournament decider.

`champion_pick`/`top_scorer_pick` (in `special_predictions`, see schema
above) score independently of match phase — no multiplier applies:

- **Champion**: `exact_champion` if the pick matches the actual champion;
  `finalist` if the pick reached the Final but didn't win it; otherwise 0.
- **Top scorer**: `exact` for the exact tournament top scorer, `top_3` for
  landing in the top 3 without being exact, plus a
  `team_reaches_semifinal_or_final_bonus` **on top of** either of those two
  tiers (never on its own) if that player's team reached the Semifinal or
  Final.

Ties in total points are broken by whoever has the most exact-score
predictions across the whole tournament — computed the same way as the
points themselves, by comparing `predicted_score_a`/`b` to `real_score_a`/`b`
directly, not from a stored field.

**Computed on the fly, not stored anywhere.** `predictions` and
`special_predictions` intentionally have no `points_earned`/`champion_points`/
`top_scorer_points` fields (see their schemas above) — whoever displays
scores (the standings page) reads `matches` + `predictions` (both public
once a match is locked) and `special_predictions` (public once its deadline
has passed) directly and computes points itself using the pure functions in
`js/scoring-logic.mjs`, parameterized by `scoring_config.json`. This avoids
ever needing an admin step to "recalculate" anything, and there's no
derived data that can go stale relative to the raw predictions. Champion/
finalists/semifinalists are derived from the `final`/`sf` matches' real
scores at read time. While a match is in progress (a `live_score_a`/
`live_score_b` is set but `real_score_a`/`real_score_b` aren't yet), the
standings page shows provisional points sourced from the live score
instead, via `scoring-logic.mjs`'s `isMatchLive`/`effectiveScore` — never
stored, and superseded the moment the real score is set.

Top scorer points work the same way, but the live signal is the *normal*
case, not a stand-in for a step the admin is expected to take: the Worker's
`/matches` route also carries football-data.org's live goal-scorer list
(see "Cloudflare Worker match proxy" in `README.md`), and
`scoring-logic.mjs`'s `deriveTopScorers` derives the current leader(s) from
it directly — goals are unambiguous, so this is correct on its own for the
entire tournament in the common case. `config/tournament_results.top_scorer`
only needs setting for the one case the live goals-only signal can't
resolve: a goals tie among players any pick actually cares about at
tournament end, where the real Golden Boot goes by FIFA's tie-break
(assists, then fewest minutes played) — data `/scorers` doesn't carry. If
that never comes up, the field can stay unset all tournament and standings
still score correctly off the live signal alone.

## Explicitly rejected approaches (context for why, so we don't re-litigate)

- **Existing quiniela apps** (Prodefy, ProdeAI, Quiniela PRO, TusPorras, etc.):
  none support starting cleanly from Round of 16 only + all of (phase
  multiplier + champion pick + top scorer pick) together. Quiniela PRO and
  Piniela allow selecting which phases to include, closest fit, but still
  missing the full custom scoring formula.
- **WhatsApp bot (official Cloud API)**: sandbox test mode caps broadcasts at
  5 recipients (group is ~10 people), so it requires Meta business
  verification — too much overhead for this small a pool.
- **Superchat (WhatsApp BSP)**: free tier covers 30 contacts, but still
  requires Meta business verification underneath. Same overhead, not worth it.
- **whatsapp-web.js (unofficial)**: risk of Meta banning the number for
  automation — rejected.
- **Firebase Phone Auth (SMS)**: NOT free — requires Blaze (pay-as-you-go)
  plan and a linked card, plus per-SMS cost (higher in Europe). Rejected in
  favor of per-user token links.

## Not yet defined (decide during implementation, don't block on upfront spec)

- **Discord bot integration**: separate client writing to the same
  `predictions` collection — deferred until the web MVP is working.
