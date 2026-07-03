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

3. **Deploy the security rules**
   - Requires the [Firebase CLI](https://firebase.google.com/docs/cli):
     `npm install -g firebase-tools`, then `firebase login`.
   - `firebase deploy --only firestore:rules`
   - Whenever `firestore.rules` changes, re-run this — it's a separate step
     from deploying the website.

4. **Enable GitHub Pages**
   - Repo Settings → Pages → Source: "Deploy from a branch" → Branch: `main`,
     folder `/ (root)`.
   - The site will be served at `https://<username>.github.io/Polla/`.

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
npm test
```

This runs `test/firestore.rules.test.js` against `firestore.rules` via
`@firebase/rules-unit-testing`, covering: unauthenticated reads being denied,
the token→`auth_links` binding requiring the real token, owners vs. strangers
writing predictions, the auto-lock check (past `kickoff_at` or `locked: true`),
and other users' predictions staying hidden until a match kicks off.

GitHub Actions runs the same tests (plus a `node --check` syntax pass over
`js/*.js` and `admin/*.js`) on every pull request and push to `main` — see
`.github/workflows/ci.yml`. The Actions runner already has Java preinstalled,
so no extra setup is needed there.

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

## Project structure

```
index.html          landing page; redirects to predict.html?token=... if present
predict.html         main prediction form
css/style.css
js/firebase-config.js  public Firebase web config (not a secret)
js/firebase-init.js    Firebase SDK init
js/auth.js             token -> user_id resolution + anonymous-auth binding
js/predict.js          predict.html page logic
firestore.rules         security rules (see CLAUDE.md and the design notes therein)
admin/seed.js           local-only Admin SDK script: seeds matches, users, tokens
test/firestore.rules.test.js   security-rules tests (run via `npm test`, needs the emulator)
.github/workflows/ci.yml       runs the test suite on every PR / push to main
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
