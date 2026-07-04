# World Cup 2026 Prediction Pool ("Poya") — Project Context

## Goal

Build a web app for a private group of ~10 friends to predict World Cup 2026
match scores from the Round of 16 onward (Round of 16, Quarterfinals,
Semifinals, Third Place, Final). No real-money handling inside the app — the
prize pool split is managed separately by the organizer. The app only needs
to track predictions and, eventually, compute standings.

## Priority for MVP (do this first)

1. `users` collection/table + token-based login (see Auth below)
2. `matches` collection/table — fixture from Round of 16 to the Final
3. A simple form: user opens their unique link, sees pending matches, enters
   `predicted_score_a` / `predicted_score_b`
4. Auto-lock a match's predictions at kickoff time (no edits after)

Explicitly deprioritized for now (build later, don't block on this):
- Scoring/points calculation
- Standings dashboard
- Discord bot integration (planned as a second, parallel input channel later
  — same backend, same `user_id`, just another client)
- ~~Automatic fixture/results fetching~~ — implemented (optional, doesn't
  block manual entry) in `automation/sync-fixtures.js` +
  `.github/workflows/sync-fixtures.yml`: a scheduled GitHub Action hitting
  football-data.org, writing fixture/result updates to Firestore via the
  Admin SDK (service account key stored as a GitHub Secret). Stays 100% free
  since the cron runs on GitHub, not Firebase — no Blaze/Cloud Functions
  needed. See [issue #2](https://github.com/Johansmm/polla-futbolera/issues/2)
  for the rationale and `README.md`'s "Automatic fixture/results sync"
  section for setup.

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
  - No writes allowed to a match after `locked = true`

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
| `match_id` | string | e.g. `r16_01` |
| `phase` | string | `r16`, `qf`, `sf`, `third_place`, `final` |
| `team_a` / `team_b` | string | Filled in once bracket is known |
| `kickoff_at` | timestamp | Used to auto-lock predictions |
| `real_score_a` / `real_score_b` | number\|null | Filled by admin after the match |
| `locked` | boolean | Auto-true after kickoff |

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
| `tournament_results` | `top_scorer` (string), `top_3_scorers` (array\<string\>) | Set by admin once known — nothing else in Firestore tracks individual goals. Champion/finalists/semifinalists are *not* stored here; they're derived on the fly from the `final`/`sf` matches' real scores |

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
scores at read time; the tournament top scorer/top-3 aren't tracked
anywhere else in Firestore, so an admin sets those once in
`config/tournament_results` when known.

## Explicitly rejected approaches (context for why, so we don't re-litigate)

- **Existing quiniela apps** (Prodefy, ProdeAI, Quiniela PRO, TusPorras, etc.):
  none support starting cleanly from Round of 16 only + all of (phase
  multiplier + champion pick + top scorer pick) together. Quiniela PRO and
  Piniela allow selecting which phases to include, closest fit, but still
  missing the full custom scoring formula.
- **WhatsApp bot (official Cloud API)**: sandbox test mode caps broadcasts at
  5 recipients (group is ~10 people), so it requires Meta business
  verification — too much overhead for a friends' pool.
- **Superchat (WhatsApp BSP)**: free tier covers 30 contacts, but still
  requires Meta business verification underneath. Same overhead, not worth it.
- **whatsapp-web.js (unofficial)**: risk of Meta banning the number for
  automation — rejected.
- **Firebase Phone Auth (SMS)**: NOT free — requires Blaze (pay-as-you-go)
  plan and a linked card, plus per-SMS cost (higher in Europe). Rejected in
  favor of per-user token links.

## Not yet defined (decide during implementation, don't block on upfront spec)

- **Prediction UI**: layout of the screen where a user enters their score
  for each pending match. Group by phase? One match per screen or a list?
- **Dashboard/standings**: what it shows (simple ranking table vs. also
  per-phase breakdown, history, charts) and whether it's public to all users
  at all times or only unlocked progressively.
- **Admin panel**: how Johan will load the real fixture (team_a/team_b once
  brackets are known), enter real match results, and generate/regenerate
  user tokens. Could be a protected view in the same app, or direct edits in
  the Firestore console — decide based on how often this needs to happen.
- **Deploy**: repo structure, Firebase project setup, GitHub Pages config.
- **Discord bot integration**: separate client writing to the same
  `predictions` collection — deferred until the web MVP is working.

## Group context

- ~10 friends, based in different European countries
- Organizer (Johan) acts as admin: creates users, generates/regenerates
  tokens, enters real match results after each game
- No in-app money handling — prize split (1st/2nd/3rd) happens outside the app
