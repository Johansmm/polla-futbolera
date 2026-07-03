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
- Automatic fixture/results fetching (replacing manual entry via
  `admin/seed.js` and the Firebase console): a scheduled GitHub Action
  hitting a free football data API (e.g. football-data.org, API-Football),
  writing fixture/result updates to Firestore via the Admin SDK (service
  account key stored as a GitHub Secret). Stays 100% free since the cron
  runs on GitHub, not Firebase — no Blaze/Cloud Functions needed. Deferred
  because it adds an external dependency (API rate limits, mapping API team
  names to our `match_id` scheme) and isn't needed to validate the MVP with
  the group; revisit after manual entry has been tested end-to-end.

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
| `points_earned` | number\|null | Calculated after match closes (later phase) |

### `special_predictions` (one doc per user, set once at tournament start)
| Field | Type | Notes |
|---|---|---|
| `user_id` | string | |
| `champion_pick` | string | |
| `top_scorer_pick` | string | |
| `champion_points` | number\|null | |
| `top_scorer_points` | number\|null | |

## Scoring rules (design finalized, NOT yet locked with the group — keep flexible)

Store in a single config file (e.g. `scoring_config.json`) so weights can be
tuned without touching code. Current placeholder values (Johan wants to
negotiate final numbers with friends before locking):

```json
{
  "base_points": {
    "exact_score": 3,
    "correct_winner": 1
  },
  "phase_multipliers": {
    "r16": 1,
    "qf": 2,
    "sf": 3,
    "third_place": 3,
    "final": 4
  },
  "special_predictions": {
    "champion": 15,
    "top_scorer": 10
  }
}
```

Formula per match:
```
points = (exact_score_hit ? base_points.exact_score : 0
        + correct_winner_hit ? base_points.correct_winner : 0)
        * phase_multipliers[match.phase]
```

`correct_winner_hit` is derived by comparing `predicted_score_a` vs
`predicted_score_b` (no separate stored field for the pick).

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
