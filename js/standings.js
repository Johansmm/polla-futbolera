import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus, formatKickoff } from "./ui.js";
import { isPastDeadline, isMatchLocked, kickoffDate, findTeamForPlayer } from "./lock-logic.mjs";
import {
  scoreMatchBreakdown,
  calculateChampionPoints,
  calculateTopScorerPoints,
  finishedMatches,
  deriveChampion,
  deriveSemifinalists,
} from "./scoring-logic.mjs";
import { fetchSpecialPredictionsDeadline, fetchTeamRosters } from "./queries.js";

const PHASE_LABELS = {
  r16: "Round of 16",
  qf: "Quarterfinals",
  sf: "Semifinals",
  third_place: "Third Place",
  final: "Final",
};

const statusEl = document.getElementById("status");
const noteEl = document.getElementById("standings-note");
const tableEl = document.getElementById("standings-table");
const sectionsEl = document.getElementById("breakdown-sections");

async function fetchScoringConfig() {
  const res = await fetch("scoring_config.json");
  if (!res.ok) throw new Error("scoring_config.json not found");
  return res.json();
}

async function fetchUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => d.data());
}

async function fetchMatches() {
  const snap = await getDocs(query(collection(db, "matches"), orderBy("kickoff_at")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

  const finished = finishedMatches(matches);
  const finishedIds = new Set(finished.map((m) => m.id));
  // Only matches whose phase has a configured multiplier count toward
  // scoring — an unconfigured phase has no meaningful points to show.
  const scorableMatches = matches.filter(
    (match) => isMatchLocked(match) && scoringConfig.phase_multipliers[match.phase] != null
  );
  const predictionsByMatch = Object.fromEntries(
    await Promise.all(scorableMatches.map(async (match) => [match.id, await fetchPredictionsByMatch(match.id)]))
  );

  // false when unset: an unconfigured deadline must read as "not revealed"
  // here, or Firestore denies the special_predictions list query outright
  // (see firestore.rules' specialPredictionsDeadlinePassed(false)).
  const specialRevealed = isPastDeadline(specialDeadline, false);
  const specialPicks = specialRevealed ? await fetchSpecialPredictions() : {};

  const { champion, finalists } = deriveChampion(matches);
  const semifinalists = deriveSemifinalists(matches);
  const topScorer = tournamentResults?.top_scorer ?? null;

  const rows = users.map((user) => {
    let matchPoints = 0;
    let exactHits = 0;
    let predictionsSubmitted = 0;
    const matchBreakdown = [];

    for (const match of scorableMatches) {
      const prediction = predictionsByMatch[match.id]?.[user.user_id];
      if (prediction) predictionsSubmitted += 1;

      const { points, exactScoreHit } = scoreMatchBreakdown(
        prediction,
        match,
        finishedIds.has(match.id),
        scoringConfig.match_outcome_points,
        scoringConfig.phase_multipliers[match.phase]
      );

      if (points !== null) matchPoints += points;
      if (exactScoreHit) exactHits += 1;
      matchBreakdown.push({ match, prediction: prediction ?? null, points });
    }

    const pick = specialPicks[user.user_id];
    const championPoints =
      pick && champion
        ? calculateChampionPoints(pick.champion_pick, { champion, finalists }, scoringConfig.special_predictions.champion)
        : 0;

    const topScorerPoints =
      pick && topScorer
        ? calculateTopScorerPoints(
            pick.top_scorer_pick,
            {
              topScorer,
              top3Scorers: tournamentResults.top_3_scorers ?? [],
              pickTeam: findTeamForPlayer(rosters, pick.top_scorer_pick),
              semifinalists,
            },
            scoringConfig.special_predictions.top_scorer
          )
        : 0;

    return {
      name: user.name,
      matchPoints,
      championPoints,
      topScorerPoints,
      exactHits,
      predictionsSubmitted,
      total: matchPoints + championPoints + topScorerPoints,
      matchBreakdown,
      championPick: pick?.champion_pick ?? null,
      topScorerPick: pick?.top_scorer_pick ?? null,
    };
  });

  const averageTotal = rows.length ? rows.reduce((sum, row) => sum + row.total, 0) / rows.length : 0;
  rows.forEach((row) => {
    row.vsAverage = row.total - averageTotal;
  });

  rows.sort((a, b) => b.total - a.total || b.exactHits - a.exactHits || a.name.localeCompare(b.name));

  // Most recent kickoff first.
  const matchSections = [...scorableMatches]
    .sort((a, b) => kickoffDate(b) - kickoffDate(a))
    .map((match) => ({
      title: `${PHASE_LABELS[match.phase] ?? match.phase}: ${match.team_a ?? "?"} vs ${match.team_b ?? "?"} — ${formatKickoff(match)}`,
      entries: rows.map((row) => {
        const breakdown = row.matchBreakdown.find((b) => b.match.id === match.id);
        const prediction = breakdown?.prediction
          ? `${breakdown.prediction.predicted_score_a}-${breakdown.prediction.predicted_score_b}`
          : "—";
        return { name: row.name, prediction, points: breakdown?.points ?? null };
      }),
    }));

  const specialSections = specialRevealed
    ? [
        {
          title: "Champion pick",
          entries: rows.map((row) => ({ name: row.name, prediction: row.championPick ?? "—", points: row.championPoints })),
        },
        {
          title: "Top scorer pick",
          entries: rows.map((row) => ({
            name: row.name,
            prediction: row.topScorerPick ?? "—",
            points: row.topScorerPoints,
          })),
        },
      ]
    : [];

  return {
    rows,
    specialRevealed,
    championDecided: Boolean(champion),
    topScorerKnown: Boolean(topScorer),
    matchSections,
    specialSections,
    totalScorableMatches: scorableMatches.length,
  };
}

function pendingNote({ specialRevealed, championDecided, topScorerKnown }) {
  if (!specialRevealed) {
    return "Champion and top scorer picks are still hidden — they'll count once the pick deadline passes.";
  }
  const missing = [];
  if (!championDecided) missing.push("the champion hasn't been decided yet");
  if (!topScorerKnown) missing.push("the tournament top scorer hasn't been set yet");
  if (!missing.length) return null;
  return `Match points only for now — ${missing.join(" and ")}.`;
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

function renderTable(rows, totalScorableMatches) {
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>Predictions submitted</th>
        <th>Exact hits</th>
        <th>vs. Average (pts)</th>
        <th>Matches (pts)</th>
        <th>Special (pts)</th>
        <th>Total (pts)</th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement("tbody");
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${row.name}</td>
      <td>${row.predictionsSubmitted}/${totalScorableMatches}</td>
      <td>${row.exactHits}</td>
      <td class="${deltaClass(row.vsAverage)}">${formatDelta(row.vsAverage)}</td>
      <td>${row.matchPoints}</td>
      <td>${row.championPoints + row.topScorerPoints}</td>
      <td><strong>${row.total}</strong></td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tableEl.innerHTML = "";
  tableEl.appendChild(table);
  tableEl.hidden = false;
}

function renderSection({ title, entries }) {
  const section = document.createElement("details");
  section.className = "breakdown-section";

  const summary = document.createElement("summary");
  summary.textContent = title;
  section.appendChild(summary);

  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Name</th><th>Prediction</th><th>Points</th></tr></thead>";

  const tbody = document.createElement("tbody");
  entries.forEach(({ name, prediction, points }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${name}</td><td>${prediction}</td><td>${points === null ? "pending" : points}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);

  return section;
}

function renderSections(specialSections, matchSections) {
  sectionsEl.innerHTML = "";
  for (const section of [...specialSections, ...matchSections]) {
    sectionsEl.appendChild(renderSection(section));
  }
  sectionsEl.hidden = false;
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  let result;
  try {
    result = await computeStandings();
  } catch (err) {
    console.error(err);
    showStatus(statusEl, "Couldn't load the standings.", true);
    return;
  }

  statusEl.hidden = true;

  const note = pendingNote(result);
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  }

  renderTable(result.rows, result.totalScorableMatches);
  renderSections(result.specialSections, result.matchSections);
}

main();
