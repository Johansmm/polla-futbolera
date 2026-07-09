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
import { fetchSpecialPredictionsDeadline, fetchTeamRosters, fetchUserName, fetchMatches } from "./queries.js";
import { selectScorableMatches, computeStandingsFromData } from "./standings-logic.mjs";

const statusEl = document.getElementById("status");
const noteEl = document.getElementById("standings-note");
const tableEl = document.getElementById("standings-table");
const sectionsEl = document.getElementById("breakdown-sections");
const columnsHelpEl = document.getElementById("columns-help");

async function fetchScoringConfig() {
  const res = await fetch("scoring_config.json");
  if (!res.ok) throw new Error("scoring_config.json not found");
  return res.json();
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

async function computeStandings() {
  const [scoringConfig, users, matches, rosters, specialDeadline, tournamentResults] = await Promise.all([
    fetchScoringConfig(),
    fetchUsers(),
    fetchMatches(),
    fetchTeamRosters(),
    fetchSpecialPredictionsDeadline(),
    fetchTournamentResults(),
  ]);

  const scorableMatches = selectScorableMatches(matches, scoringConfig);
  const predictionsByMatch = Object.fromEntries(
    await Promise.all(scorableMatches.map(async (match) => [match.id, await fetchPredictionsByMatch(match.id)]))
  );

  // false when unset: an unconfigured deadline must read as "not revealed"
  // here, or Firestore denies the special_predictions list query outright
  // (see firestore.rules' specialPredictionsDeadlinePassed(false)).
  const specialRevealed = isPastDeadline(specialDeadline, false);
  const specialPicks = specialRevealed ? await fetchSpecialPredictions() : {};

  return computeStandingsFromData({
    scoringConfig,
    users,
    matches,
    rosters,
    tournamentResults,
    predictionsByMatch,
    specialPicks,
    specialRevealed,
  });
}

function pendingNote({ specialRevealed, championDecided, topScorerKnown, anyMatchLive }) {
  const notes = [];
  if (anyMatchLive) notes.push("Provisional standings — a match is in progress.");
  if (!specialRevealed) {
    notes.push("Champion and top scorer picks are still hidden — they'll count once the pick deadline passes.");
  } else {
    const missing = [];
    if (!championDecided) missing.push("the champion hasn't been decided yet");
    if (!topScorerKnown) missing.push("the tournament top scorer hasn't been set yet");
    if (missing.length) notes.push(`Match points only for now — ${missing.join(" and ")}.`);
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
}

function renderSection({ title, entries }) {
  const section = document.createElement("details");
  section.className = "breakdown-section";

  const summary = document.createElement("summary");
  summary.innerHTML = title;
  section.appendChild(summary);

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

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  showStatus(statusEl, "Loading standings…");
  fetchUserName(userId)
    .then(showSignedInName)
    .catch(() => {});

  let result;
  try {
    result = await computeStandings();
  } catch (err) {
    console.error(err);
    showRetry(statusEl, "Couldn't load the standings.", () => window.location.reload());
    return;
  }

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
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  }

  renderTable(result.rows, result.totalScorableMatches, userId);
  renderSections(result.specialSections, result.matchSections);
}

main();
