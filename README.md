# Poya — World Cup 2026 Prediction Pool

Static site (no build step) + Firebase Firestore, for a private group predicting
match scores from the Round of 16 onward. See `CLAUDE.md` for full project context.

## Setup (one-time)

1. **Create the Firebase project**
   - [Firebase Console](https://console.firebase.google.com/) → Add project.
   - Build → Firestore Database → Create database (production mode).
   - Build → Authentication → Sign-in method → enable **Anonymous**.
   - Project Settings → General → Your apps → Add app → Web app. Skip "Also
     set up Firebase Hosting" (this project deploys via GitHub Pages, not
     Firebase Hosting). When asked how to add the SDK, choose **`<script>` tag**
     (not npm) — the frontend has no build step, and `js/firebase-init.js`
     already imports the SDK as ES modules straight from the
     `gstatic.com/firebasejs/...` CDN URLs, matching that option. Copy the
     `firebaseConfig` object shown into `js/firebase-config.js` (replace the
     `REPLACE_ME` values); you can ignore the rest of the install snippet.
   - Project Settings → Service accounts → Generate new private key. Save the
     downloaded file as `admin/serviceAccountKey.json` (this is gitignored —
     never commit it).
   - `.firebaserc` → replace `REPLACE_WITH_FIREBASE_PROJECT_ID` with your real
     Firebase project ID.

2. **Seed the fixture and users**
   - Edit `admin/seed.js`: fill in `MATCHES` (all matches from Round of 16 to
     the Final, with real `kickoff_at` timestamps once known) and `USERS`
     (the ~10 friends).
   - `cd admin && npm install && node seed.js`
   - The script prints each friend's `predict.html?token=...` link — save
     these, they aren't shown again unless you add a brand-new user later.
   - Optional: run it as `FOOTBALL_DATA_TOKEN=<your token> node seed.js`
     (free key from [football-data.org](https://www.football-data.org/)) to
     also seed `team_rosters/{team}` — every team's squad in one API call,
     backing the champion/top-scorer dropdowns on `special.html`.
     Without the token this step is skipped (logged), everything else still
     seeds normally. Only needs re-running if a squad changes materially
     (e.g. a late injury replacement).

3. **Deploy the security rules**
   - Requires the [Firebase CLI](https://firebase.google.com/docs/cli):
     `npm install -g firebase-tools`, then `firebase login`.
   - `firebase deploy --only firestore:rules`
   - This one-time manual run is only needed for the very first deploy.
     After that, `.github/workflows/ci.yml`'s `deploy-rules` job redeploys
     `firestore.rules` automatically on every push to `main` (once tests
     pass), using the same `FIREBASE_SERVICE_ACCOUNT_JSON` secret as the
     other automation workflows — no more remembering to run this by hand
     after merging a PR that touches the rules.
   - The service account behind that secret needs an extra IAM role beyond
     what the other automation workflows require: Firebase's default
     Admin SDK service account (`firebase-adminsdk-...@<project>.iam.gserviceaccount.com`,
     the one whose key you downloaded above) only has Admin SDK access
     (Firestore/Auth reads and writes) by default, not the
     `firebaserules.*` permissions the CLI needs to validate and publish
     rules. Deploying rules from CI fails with a `403` from
     `firebaserules.googleapis.com` until you grant that same service
     account the **Firebase Rules Admin** role (Google Cloud Console → IAM
     & Admin → IAM → find the `firebase-adminsdk-...` account → Edit →
     Add another role — search "rules"; if that specific role isn't
     offered, the broader **Firebase Admin** role also works, just with
     more access than strictly needed). This is a one-time grant tied to
     the service account itself, not the key — regenerating
     `admin/serviceAccountKey.json` later doesn't require repeating it.
     No billing plan or cost is involved; IAM role grants are free.

4. **Enable GitHub Pages**
   - Repo Settings → Pages → Source: "Deploy from a branch" → Branch: `main`,
     folder `/ (root)`.
   - The site will be served at `https://johansmm.github.io/polla-futbolera/`
     (the repo name, `polla-futbolera` — not the local folder name used
     during development).

## Local testing

Serve the repo root with any static file server (e.g. `npx serve .` or the
VS Code "Live Server" extension) and open `predict.html?token=<a seeded token>`.
Firebase config must already point at your real project — there's no
emulator/mocking layer for the MVP.

## Running tests

Security-rules tests run against the local Firestore emulator, which requires
a JRE (the emulator itself is a Java process — Node/npm alone aren't enough).

```
winget install EclipseAdoptium.Temurin.21.JRE   # one-time, if `java -version` fails
npm install                                      # root devDependencies (first time only)
cd automation && npm install && cd ..            # sync-fixtures.js's own dependency (first time only)
npm test
```

`node --test test/` auto-discovers every test file in the directory,
currently:

- `test/firestore.rules.test.js` — runs against `firestore.rules` via
  `@firebase/rules-unit-testing` (needs the emulator), covering:
  unauthenticated reads being denied, the token→`auth_links` binding
  requiring the real token, owners vs. strangers writing predictions, the
  auto-lock check (past `kickoff_at` or `locked: true`), other users'
  predictions staying hidden until a match kicks off, and
  `special_predictions` being editable only before its configured deadline.
- `test/sync-fixtures.test.js` — plain unit tests (no emulator, no
  credentials) for the pure decision logic in `automation/sync-fixtures.js`:
  stage-to-phase translation, the "is this match finished yet" check, and
  the kickoff-time tolerance window used to match an API fixture to an
  already-seeded `matches` doc.
- `test/lock-logic.test.js` — plain unit tests for `js/lock-logic.mjs`'s
  timing/lookup logic (`isMatchLocked`, `isPastDeadline`, `findTeamForPlayer`),
  shared by `predict.js`, `special.js`, and `standings.js`. Loaded via dynamic
  `import()` since it's a real ES module (`.mjs`) in an otherwise CommonJS
  test suite — the only `js/*.js` file with no CDN import, so the only one
  Node can load directly.
- `test/scoring-logic.test.js` — plain unit tests for `js/scoring-logic.mjs`'s
  pure scoring functions (`scoreMatch`, `calculateChampionPoints`,
  `calculateTopScorerPoints`), including the drawn-match edge case where a
  correctly-predicted draw must not be mistaken for "correct winner +
  correct difference" just because a draw's goal difference is always 0.
  Loaded the same way as `lock-logic.test.js` above, since this is also a
  real `.mjs` module.

GitHub Actions runs the same tests (plus a `node --check` syntax pass over
`js/*.js`, `admin/*.js`, and `automation/*.js`) on every pull request and
push to `main` — see `.github/workflows/ci.yml`. The Actions runner already
has Java preinstalled, so no extra setup is needed there. On push to `main`
specifically, a second job (`deploy-rules`) runs after tests pass and
redeploys `firestore.rules` automatically — see "Deploy the security rules"
above.

## Automatic fixture/results sync (optional)

`.github/workflows/sync-fixtures.yml` runs `automation/sync-fixtures.js` every
3 hours (and on-demand via the Actions tab), pulling **all** World Cup 2026
matches from [football-data.org](https://www.football-data.org/) and writing
`team_a`/`team_b`/`kickoff_at`/`real_score_a`/`real_score_b` to Firestore.
This replaces manual fixture/result entry once set up, but is optional —
everything still works via `admin/seed.js` + the Firebase console without it.

The sync deliberately doesn't filter by stage (group stage, and the Round of
32 that World Cup 2026's expanded format adds before Round of 16, get synced
too) — relevance is already enforced elsewhere, so filtering here would just
duplicate that logic:

- `firestore.rules` denies any prediction write once a match's `kickoff_at`
  has passed, so anything from an earlier stage synced mid-tournament is
  already unwritable.
- `js/predict.js` only ever renders matches whose `phase` is one of
  `r16`/`qf`/`sf`/`third_place`/`final` (its `PHASE_ORDER`); any other value
  is simply never shown, never something a user can pick to predict on.

`STAGE_TO_PHASE` in the script still translates football-data.org's stage
codes to those 5 values for the phases we care about — anything it doesn't
recognize gets synced with its raw API stage string as `phase` instead
(harmless: it just won't render). Before trusting the schedule, do one manual
run from the Actions tab and check the logs for any "Unmapped stage(s)" line —
that confirms whether football-data.org's naming matches what the script
assumes (see the comment above `STAGE_TO_PHASE` for the English/Spanish round-
naming mismatch this is guarding against: English "Round of 16" = Spanish
"octavos de final", *not* "dieciseisavos"/"16avos", which is actually the
newer Round of 32 stage).

To enable it, add these two **repo Secrets** (Settings → Secrets and variables
→ Actions → New repository secret):

- `FOOTBALL_DATA_TOKEN` — a free API key from football-data.org (sign up, then
  copy the key from your account dashboard). Verify their current docs for the
  exact competition code/plan coverage for the World Cup before relying on it.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the **entire contents** of your
  `admin/serviceAccountKey.json` as the secret value (same key used locally by
  `admin/seed.js`; this grants the workflow the same Admin SDK access). Also
  required by `.github/workflows/ci.yml`'s `deploy-rules` job (not optional —
  see the "Deploy the security rules" setup step above, including the extra
  IAM role that job needs beyond plain Admin SDK access), so set this up even
  if you don't want the fixture sync itself.

Matches are matched to existing `matches` docs by `phase` + kickoff time
(within a few hours' tolerance), not by team name, so pre-seeding a match's
`kickoff_at` via `admin/seed.js` before the teams are known still lets the
sync fill in `team_a`/`team_b` later. If no matching doc is found, it creates
one with an auto-generated `match_id`. Once football-data.org marks a match
`FINISHED`, its score is treated as authoritative and will overwrite
`real_score_a`/`real_score_b` on every run — so a manual correction in the
console could get reverted on the next sync; disable the workflow first if
you need a manual value to stick.

## Missing predictions report (manual)

`.github/workflows/missing-predictions.yml` runs `automation/missing-predictions.js`
on demand only (`workflow_dispatch` — no schedule) — trigger it from the
Actions tab, including from the GitHub mobile app, so you don't need your
computer on to check who still needs a nudge. Per user, lists which matches
kicking off in the next 24 hours they still have no `predictions` doc for,
plus their champion/top-scorer picks if that deadline also falls in the next
24 hours — one line per user, ready to paste into a nudge message. Each item
shows how much time is left before it locks (`HHhMMm`), e.g.:

```
Users with missing predictions in the next 24h:
* Hollwann Leon: Canada vs Morocco (r16_01, 05h17m), Champion pick (05h17m), Top scorer pick (05h17m)

(HHhMMm) = time left before that item locks.
```

It deliberately only checks whether a document/field **exists** — the script
never calls `.data()` on a `predictions` doc, and never reads the actual
values of `champion_pick`/`top_scorer_pick`, so there's no code path that
could print anyone's picks. You see who's missing something, never what
anyone picked.

Uses the same `FIREBASE_SERVICE_ACCOUNT_JSON` secret as the fixture sync — no
extra setup needed if that's already configured.

To run it locally instead of via Actions (using your local
`admin/serviceAccountKey.json` instead of the GitHub Secret):

```bash
# Git Bash
cd automation
FIREBASE_SERVICE_ACCOUNT_JSON="$(cat ../admin/serviceAccountKey.json)" node missing-predictions.js
```

```powershell
# PowerShell
cd automation
$env:FIREBASE_SERVICE_ACCOUNT_JSON = Get-Content ../admin/serviceAccountKey.json -Raw
node missing-predictions.js
```

## Admin workflows (ongoing)

- **Enter a real match result**: Firebase Console → Firestore → `matches/{match_id}`
  → set `real_score_a` / `real_score_b`.
- **Force-lock a match early**: same doc → set `locked: true`. Normally not
  needed — matches auto-lock once `kickoff_at` has passed (enforced server-side
  in `firestore.rules`, not by this stored field).
- **Regenerate a user's token** (e.g. they lost their link): in the Console,
  delete `tokens/{oldToken}`, create `tokens/{newToken} → { user_id }`, and
  update `users/{user_id}.token` to the new value. If the old link may have
  leaked to someone else, also delete that user's docs under `auth_links`
  (query by `user_id` in the Console) to force every device to re-bind.
- **Add a new user after launch**: add them to `USERS` in `admin/seed.js` and
  re-run `node seed.js` — existing users are skipped, so their tokens don't change.
- **Add or edit matches later** (e.g. the bracket for the next phase just got
  confirmed): add/edit entries in `MATCHES` in `admin/seed.js` and re-run
  `node seed.js`. Safe to re-run any time — new match_ids are created, and
  existing ones only get `phase`/`team_a`/`team_b`/`kickoff_at` refreshed;
  `real_score_a`, `real_score_b` and `locked` are never touched once a match
  already exists, so results you entered via the console are preserved.
- **The champion/top-scorer picks deadline** (`config/special_predictions.locked_after`)
  recomputes automatically every time `node seed.js` runs, from whatever the
  earliest Round of 16 `kickoff_at` is in `matches` at that moment — no
  manual date entry needed. If `matches` has no `r16` docs yet when you run
  it, this step is skipped (logged), and `special.html` stays locked by
  default (fail-closed) until it exists.
- **Fix a user's name or `user_id`**: `cd admin && node rename-user.js ...`
  - `node rename-user.js name <user_id> "New Name"` — just updates the
    cosmetic `name` field (shown in `seed.js` logs and the
    missing-predictions report). Doesn't touch tokens, predictions, or
    anything else.
  - `node rename-user.js id <old_id> <new_id> [new_name]` — renames the
    `user_id` itself everywhere it's referenced (`users`, `tokens`,
    `auth_links`, `predictions`, `special_predictions`), keeping the same
    token (so nobody's link breaks) and preserving every predicted score
    and pick. Everything is copied under the new id before anything is
    deleted from the old one, so a failure partway through leaves
    duplicated data, never lost data.
- **Points aren't calculated by an admin step at all** — there's nothing to
  run after entering a match's real score. `standings.html` reads
  `matches`/`predictions`/`special_predictions` directly and computes
  everyone's points on the fly using `js/scoring-logic.mjs` +
  `scoring_config.json`, so there's no `points_earned` field to recompute or
  go stale. The one manual step that *is* still needed: once the tournament
  top scorer is known (not tracked anywhere else in Firestore), set
  `config/tournament_results → { top_scorer: "...", top_3_scorers: ["...", "...", "..."] }`
  via the Console — champion/finalists/semifinalists are derived
  automatically from the `final`/`sf` matches instead.

## Project structure

```
index.html          landing page; redirects to predict.html?token=... if present
predict.html         main prediction form (score picks)
special.html         champion + top-scorer picks (editable until the deadline)
standings.html        leaderboard (points computed on read, no server step)
css/style.css
js/firebase-config.js  public Firebase web config (not a secret)
js/firebase-init.js    Firebase SDK init
js/auth.js             token -> user_id resolution + anonymous-auth binding
js/token-gate.js       shared token-resolution UI flow used by predict.js, special.js, and standings.js
js/ui.js               tiny shared DOM helper (showStatus)
js/queries.js          Firestore reads shared by special.js and standings.js (deadline, rosters)
js/lock-logic.mjs      shared timing/lookup logic (isMatchLocked, isPastDeadline, findTeamForPlayer)
js/scoring-logic.mjs   pure scoring functions (no stored points_earned — computed on read)
js/predict.js          predict.html page logic
js/special.js          special.html page logic
js/standings.js        standings.html page logic: fetches raw predictions/picks/results and
                        scores them client-side with js/scoring-logic.mjs
firestore.rules         security rules (see CLAUDE.md and the design notes therein)
admin/seed.js           local-only Admin SDK script: seeds matches, users, tokens, the
                        special_predictions deadline, and (optionally) team_rosters
admin/rename-user.js    local-only Admin SDK script: fixes a user's name or user_id
scoring_config.json         tunable point/multiplier weights, read by js/scoring-logic.mjs
test/firestore.rules.test.js   security-rules tests (run via `npm test`, needs the emulator)
test/lock-logic.test.js        unit tests for js/lock-logic.mjs (no emulator needed)
test/scoring-logic.test.js     unit tests for js/scoring-logic.mjs (no emulator needed)
.github/workflows/ci.yml               runs the test suite on every PR / push to main
automation/sync-fixtures.js            optional: auto-syncs fixtures/results from football-data.org
.github/workflows/sync-fixtures.yml    runs automation/sync-fixtures.js on a schedule
automation/missing-predictions.js          reports who's missing a pick for matches in the next 24h
.github/workflows/missing-predictions.yml  runs automation/missing-predictions.js on demand only
```

## How auth works without passwords, SMS, or a server

Each user gets a unique unguessable token in their URL. Firestore security
rules can't read URL params directly, so the client:

1. Signs in anonymously (free, no card required) to get a real `request.auth.uid`.
2. Looks up `tokens/{token}` to find the matching `user_id`.
3. Creates a one-time `auth_links/{auth_uid} → { user_id, token }` binding doc,
   which the security rules verify actually matches the real token before
   allowing it to be created.

From then on, rules use that binding to check "this browser can only write
this user's predictions." Multiple devices for the same person just create
independent binding docs — no coordination needed. See `firestore.rules` and
`CLAUDE.md` for the full design rationale.
