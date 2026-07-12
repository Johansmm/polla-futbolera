import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus, showRetry, showSignedInName } from "./ui.js";
import { isPastDeadline } from "./lock-logic.mjs";
import {
  fetchSpecialPredictionsDeadline,
  fetchUserName,
  fetchFirestoreMatches,
  fetchWorkerMatches,
} from "./queries.js";
import { mergeMatchData } from "./worker-matches.mjs";
import {
  selectScorableMatches,
  selectNewlyScorableMatches,
  hasMatchNeedingRefresh,
  computeStandingsFromData,
  PHASE_TAGS,
} from "./standings-logic.mjs";

const statusEl = document.getElementById("status");
const noteEl = document.getElementById("standings-note");
const tableEl = document.getElementById("standings-table");
const sectionsEl = document.getElementById("breakdown-sections");
const columnsHelpEl = document.getElementById("columns-help");
const scoringHelpEl = document.getElementById("scoring-help");

// Display-freshness only, not an API-consumption concern — the Worker's
// /matches route is shared-KV-cached for 60s (see README's "Cloudflare
// Worker match proxy"), so polling faster than that cache's own TTL just
// re-reads the same cached response most of the time anyway. Kept snappy
// (10s) since a live match is exactly when someone has the page open
// watching it update.
const POLL_INTERVAL_MS = 10_000;

async function fetchScoringConfig() {
  const res = await fetch("scoring_config.json");
  if (!res.ok) throw new Error("scoring_config.json not found");
  return res.json();
}

// Concise, general-purpose explanation of the match-points formula — values
// read from scoringConfig at render time (never hardcoded) so this can't
// drift from scoring_config.json. The champion/top scorer picks' own rules
// live in their respective breakdown sections instead (renderSection's
// `rules`, built alongside them in standings-logic.mjs), since that's where
// the reader is already looking at their own pick and points.
function buildScoringSummaryMarkup(scoringConfig) {
  const { match_outcome_points: outcome, phase_multipliers: multipliers } = scoringConfig;
  const examplePhase = "qf";
  const exampleMultiplier = multipliers[examplePhase];
  const examplePoints = outcome.exact_score * exampleMultiplier;

  const multiplierList = Object.entries(multipliers)
    .map(([phase, multiplier]) => `${PHASE_TAGS[phase] ?? phase} ×${multiplier}`)
    .join(", ");

  return `
    <p>Match points = outcome tier × phase multiplier. Example: you predict 2–1 and the ${PHASE_TAGS[examplePhase] ?? examplePhase} match ends 2–1 — exact score (${outcome.exact_score} pts) × the phase's ${exampleMultiplier}× multiplier = ${examplePoints} pts.</p>
    <ul>
      <li>Exact score: ${outcome.exact_score} pts</li>
      <li>Correct winner + correct goal difference (decisive matches only): ${outcome.correct_winner_and_difference} pts</li>
      <li>Correct winner, or a correctly predicted draw: ${outcome.correct_winner_or_draw} pts</li>
      <li>Anything else: ${outcome.miss} pts</li>
    </ul>
    <p>A correctly predicted draw never counts as "correct difference" — a draw's difference is always 0, not a meaningful "correct margin" the way it is for a decisive result, so it always falls to the tier below instead.</p>
    <p>Phase multipliers: ${multiplierList}.</p>
    <p>The champion and top scorer picks are scored separately — see their own rules in the "Champion picks" and "Top scorer picks" sections below.</p>
    <p>Ties in total points go to whoever has the most exact-score match predictions across the whole tournament.</p>
  `;
}

async function fetchUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => d.data());
}

// Predictions have no unconstrained list rule — only a per-match query
// (readable once that match's deadline passes, i.e. locked, per
// firestore.rules' matchDeadlinePassed) is allowed, so this is fetched once
// per scorable match rather than for the whole collection. A match is
// readable as soon as it locks, even before the admin enters a result.
async function fetchPredictionsByMatch(matchId) {
  const snap = await getDocs(query(collection(db, "predictions"), where("match_id", "==", matchId)));
  return Object.fromEntries(snap.docs.map((d) => [d.data().user_id, d.data()]));
}

async function fetchSpecialPredictions() {
  const snap = await getDocs(collection(db, "special_predictions"));
  return Object.fromEntries(snap.docs.map((d) => [d.data().user_id, d.data()]));
}

async function fetchTournamentResults() {
  const snap = await getDoc(doc(db, "config", "tournament_results"));
  return snap.exists() ? snap.data() : null;
}

// Only ever combines the Firestore skeleton (fetched once) with a fresh
// fetchWorkerMatches() call, never re-reading Firestore's matches
// collection — that's the whole point of state.firestoreMatches living in
// memory across poll ticks instead of being re-fetched.
function mergeWorkerMatches(firestoreMatches, workerMatches) {
  const workerMatchesById = new Map(workerMatches.map((m) => [m.id, m]));
  return firestoreMatches.map((match) => mergeMatchData(match, workerMatchesById));
}

// Everything that's fetched once on load and kept in memory for the poll
// loop to reuse, per the issue's "static inputs" list — nothing here changes
// often enough (or, for firestoreMatches, is even allowed by firestore.rules
// to be cheaply re-read) to justify a Firestore round-trip on every tick.
async function loadStaticData() {
  const [scoringConfig, users, specialDeadline, tournamentResults, firestoreMatches, workerData] = await Promise.all([
    fetchScoringConfig(),
    fetchUsers(),
    fetchSpecialPredictionsDeadline(),
    fetchTournamentResults(),
    fetchFirestoreMatches(),
    fetchWorkerMatches(),
  ]);

  const matches = mergeWorkerMatches(firestoreMatches, workerData.matches);
  const scorableMatches = selectScorableMatches(matches, scoringConfig);
  const predictionsByMatch = Object.fromEntries(
    await Promise.all(scorableMatches.map(async (match) => [match.id, await fetchPredictionsByMatch(match.id)]))
  );

  // false when unset: an unconfigured deadline must read as "not revealed"
  // here, or Firestore denies the special_predictions list query outright
  // (see firestore.rules' specialPredictionsDeadlinePassed(false)). Special
  // picks are only ever set once at tournament start (see CLAUDE.md), so
  // unlike matches/predictions this never needs a poll-time refresh.
  const specialRevealed = isPastDeadline(specialDeadline, false);
  const specialPicks = specialRevealed ? await fetchSpecialPredictions() : {};

  return {
    scoringConfig,
    users,
    tournamentResults,
    specialRevealed,
    specialPicks,
    firestoreMatches,
    matches,
    scorers: workerData.scorers,
    predictionsByMatch,
    fetchedPredictionIds: new Set(scorableMatches.map((m) => m.id)),
  };
}

function computeStandings(state) {
  return computeStandingsFromData({
    scoringConfig: state.scoringConfig,
    users: state.users,
    matches: state.matches,
    tournamentResults: state.tournamentResults,
    predictionsByMatch: state.predictionsByMatch,
    specialPicks: state.specialPicks,
    specialRevealed: state.specialRevealed,
    scorers: state.scorers,
  });
}

// One poll tick: skip entirely (no network calls at all) unless some match
// could plausibly have changed since the last tick — see
// hasMatchNeedingRefresh's doc comment. Mutates state in place so setInterval
// can just keep calling this with the same object.
async function refreshState(state) {
  if (!hasMatchNeedingRefresh(state.matches)) return false;

  const workerData = await fetchWorkerMatches();
  // An empty matches result means the Worker call itself failed (see
  // fetchWorkerMatches' doc comment) — keep the last-known-good merged
  // matches/scorers rather than overwriting real data with a blank skeleton.
  if (workerData.matches.length) {
    state.matches = mergeWorkerMatches(state.firestoreMatches, workerData.matches);
    state.scorers = workerData.scorers;
  }

  const newlyLocked = selectNewlyScorableMatches(state.matches, state.scoringConfig, state.fetchedPredictionIds);
  if (newlyLocked.length) {
    const entries = await Promise.all(
      newlyLocked.map(async (match) => [match.id, await fetchPredictionsByMatch(match.id)])
    );
    for (const [matchId, predictions] of entries) {
      state.predictionsByMatch[matchId] = predictions;
      state.fetchedPredictionIds.add(matchId);
    }
  }

  return true;
}

function pendingNote({
  specialRevealed,
  championDecided,
  championIsFinal,
  topScorerKnown,
  topScorerIsFinal,
  anyMatchLive,
}) {
  const notes = [];
  if (anyMatchLive) notes.push("Provisional standings — a match is in progress.");
  if (!specialRevealed) {
    notes.push("Champion and top scorer picks are still hidden — they'll count once the pick deadline passes.");
  } else {
    const missing = [];
    if (!championDecided) missing.push("the champion hasn't been decided yet");
    // Once a goal has been scored anywhere, topScorerKnown flips true and
    // top scorer points come from the Worker's live /scorers list instead —
    // "hasn't been set yet" no longer applies, but those points remain
    // provisional (see the note below) until the admin confirms the result.
    if (!topScorerKnown) missing.push("the tournament top scorer hasn't been set yet");
    if (missing.length) notes.push(`Match points only for now — ${missing.join(" and ")}.`);
    if (championDecided && !championIsFinal) {
      notes.push("Champion points are provisional — the Final is still being played.");
    }
    if (topScorerKnown && !topScorerIsFinal) {
      notes.push("Top scorer points are provisional — the tournament's official top scorer hasn't been confirmed yet.");
    }
  }
  return notes.length ? notes.join(" ") : null;
}

function formatDelta(value) {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : `${rounded}`; // negative already carries "-"; 0 needs no sign
}

function deltaClass(value) {
  const rounded = Math.round(value * 10) / 10;
  if (rounded > 0) return "delta-positive";
  if (rounded < 0) return "delta-negative";
  return "delta-neutral";
}

// Cells are built with textContent (not innerHTML) so nothing stored in
// Firestore — user names above all — can inject markup into the table.
function td(className, ...children) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.append(...children);
  return cell;
}

function renderTable(rows, totalScorableMatches, viewerId) {
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th class="num" aria-label="Rank">#</th>
        <th>Name</th>
        <th class="num" aria-label="Predictions submitted">Preds</th>
        <th class="num" aria-label="Exact scores hit">Exact</th>
        <th class="num" aria-label="Match points">Match pts</th>
        <th class="num" aria-label="Special picks points">Special</th>
        <th class="num">Total</th>
        <th class="num" aria-label="Points versus the group average">± Avg</th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (row.userId === viewerId) tr.classList.add("me-row");
    // Keyed to the computed rank, not the row position — ties share rank 1,
    // and every co-leader deserves the crown.
    if (row.rank === 1) tr.classList.add("leader-row");

    const nameCell = td("name-cell", row.name);
    if (row.userId === viewerId) {
      const you = document.createElement("span");
      you.className = "you-tag";
      you.textContent = " (you)";
      nameCell.appendChild(you);
    }

    const total = document.createElement("strong");
    total.textContent = String(row.total);

    tr.append(
      td("num", String(row.rank)),
      nameCell,
      td("num", `${row.predictionsSubmitted}/${totalScorableMatches}`),
      td("num", String(row.exactHits)),
      td("num", String(row.matchPoints)),
      td("num", String(row.championPoints + row.topScorerPoints)),
      td("num total-cell", total),
      td(`num ${deltaClass(row.vsAverage)}`, formatDelta(row.vsAverage))
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tableEl.innerHTML = "";
  tableEl.appendChild(table);
  tableEl.hidden = false;
  columnsHelpEl.hidden = false;
  scoringHelpEl.hidden = false;
}

function renderSection({ title, rules, entries }) {
  const section = document.createElement("details");
  section.className = "breakdown-section";

  const summary = document.createElement("summary");
  summary.innerHTML = title;
  section.appendChild(summary);

  if (rules) {
    const rulesEl = document.createElement("div");
    rulesEl.innerHTML = rules;
    section.appendChild(rulesEl);
  }

  const table = document.createElement("table");
  table.innerHTML = '<thead><tr><th>Name</th><th>Prediction</th><th class="num">Points</th></tr></thead>';

  const tbody = document.createElement("tbody");
  entries.forEach(({ name, prediction, points, top }) => {
    const tr = document.createElement("tr");
    if (top) tr.classList.add("match-leader-row");
    const pointsCell = td("num");
    if (points === null) {
      const pending = document.createElement("em");
      pending.className = "pending";
      pending.textContent = "pending";
      pointsCell.appendChild(pending);
    } else {
      pointsCell.textContent = String(points);
    }
    tr.append(td("", name), td("", prediction), pointsCell);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Scroll wrapper so an overlong name scrolls the table inside the card
  // instead of being clipped by the card's overflow:hidden corners.
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  scroll.appendChild(table);
  section.appendChild(scroll);

  return section;
}

function renderSections(specialSections, matchSections) {
  // Latest matches first — after every game this is what everyone opens
  // the page to check — with the one-time special picks after them.
  sectionsEl.innerHTML = "";
  const groups = [
    { heading: "Match by match", sections: matchSections },
    { heading: "Special picks", sections: specialSections },
  ];
  for (const { heading, sections } of groups) {
    if (!sections.length) continue;
    const h = document.createElement("h2");
    h.className = "sections-heading";
    h.textContent = heading;
    sectionsEl.appendChild(h);
    for (const section of sections) {
      sectionsEl.appendChild(renderSection(section));
    }
  }
  sectionsEl.hidden = false;
}

// Handles every possible computeStandings() outcome, including the two
// "nothing to show yet" cases — kept reachable from every poll tick (not
// just the initial load) so a page opened before the first kickoff
// transitions straight to the real table the moment that match locks,
// without needing a reload.
function renderResult(result, viewerId) {
  if (!result.rows.length) {
    showStatus(statusEl, "No players registered yet — ask the organizer.");
    return;
  }

  if (result.totalScorableMatches === 0 && !result.specialRevealed) {
    showStatus(statusEl, "Standings will appear once the first match kicks off — nothing is scored yet.");
    return;
  }

  statusEl.hidden = true;

  const note = pendingNote(result);
  noteEl.hidden = !note;
  if (note) noteEl.textContent = note;

  renderTable(result.rows, result.totalScorableMatches, viewerId);
  renderSections(result.specialSections, result.matchSections);
}

// result is plain, JSON-serializable data (scoring-logic.mjs's outputs are
// numbers/strings/booleans/plain objects throughout) — serializing it is a
// cheap way to skip a render when a poll tick's refresh didn't actually
// change anything, e.g. a live match's score hasn't moved since last tick.
function renderIfChanged(state, result, viewerId) {
  const key = JSON.stringify(result);
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;
  renderResult(result, viewerId);
}

function startPolling(state, viewerId) {
  setInterval(() => {
    refreshState(state)
      .then((refreshed) => {
        if (!refreshed) return;
        renderIfChanged(state, computeStandings(state), viewerId);
      })
      .catch((err) => console.error("standings poll failed", err));
  }, POLL_INTERVAL_MS);
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  showStatus(statusEl, "Loading standings…");
  fetchUserName(userId)
    .then(showSignedInName)
    .catch(() => {});

  let state;
  try {
    state = await loadStaticData();
  } catch (err) {
    console.error(err);
    showRetry(statusEl, "Couldn't load the standings.", () => window.location.reload());
    return;
  }

  scoringHelpEl.insertAdjacentHTML("beforeend", buildScoringSummaryMarkup(state.scoringConfig));

  state.lastRenderKey = null;
  renderIfChanged(state, computeStandings(state), userId);
  startPolling(state, userId);

  // A #scoring-help link from predict.html/special.html lands here before
  // this element's `hidden` attribute is cleared by the render above (the
  // browser resolves the URL fragment synchronously on load, well before
  // these async fetches resolve), so the initial jump silently does
  // nothing — open and scroll to it manually once it actually exists.
  if (location.hash === "#scoring-help" && !scoringHelpEl.hidden) {
    scoringHelpEl.open = true;
    scoringHelpEl.scrollIntoView();
  }
}

main();
