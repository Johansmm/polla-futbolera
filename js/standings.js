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
import { showStatus } from "./ui.js";
import { isPastDeadline, findTeamForPlayer } from "./lock-logic.mjs";
import {
  scoreMatch,
  calculateChampionPoints,
  calculateTopScorerPoints,
  finishedMatches,
  deriveChampion,
  deriveSemifinalists,
} from "./scoring-logic.mjs";
import { fetchSpecialPredictionsDeadline, fetchTeamRosters } from "./queries.js";

const statusEl = document.getElementById("status");
const noteEl = document.getElementById("standings-note");
const tableEl = document.getElementById("standings-table");

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
  const snap = await getDocs(collection(db, "matches"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Predictions have no unconstrained list rule — only a per-match query
// (readable once that match's deadline passes) is allowed, so this is
// fetched once per finished match rather than for the whole collection.
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
  const predictionsByMatch = Object.fromEntries(
    await Promise.all(finished.map(async (match) => [match.id, await fetchPredictionsByMatch(match.id)]))
  );

  const specialRevealed = isPastDeadline(specialDeadline);
  const specialPicks = specialRevealed ? await fetchSpecialPredictions() : {};

  const { champion, finalists } = deriveChampion(matches);
  const semifinalists = deriveSemifinalists(matches);
  const topScorer = tournamentResults?.top_scorer ?? null;

  const rows = users.map((user) => {
    let matchPoints = 0;
    let exactHits = 0;

    for (const match of finished) {
      const prediction = predictionsByMatch[match.id]?.[user.user_id];
      if (!prediction) continue; // no submission scores the same as a miss: 0

      const { outcomePoints, exactScoreHit } = scoreMatch(prediction, match, scoringConfig.match_outcome_points);
      matchPoints += outcomePoints * scoringConfig.phase_multipliers[match.phase];
      if (exactScoreHit) exactHits += 1;
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
      total: matchPoints + championPoints + topScorerPoints,
    };
  });

  rows.sort((a, b) => b.total - a.total || b.exactHits - a.exactHits || a.name.localeCompare(b.name));

  return { rows, specialRevealed, championDecided: Boolean(champion), topScorerKnown: Boolean(topScorer) };
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

function renderTable(rows) {
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>Matches</th>
        <th>Champion</th>
        <th>Top scorer</th>
        <th>Total</th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement("tbody");
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${row.name}</td>
      <td>${row.matchPoints}</td>
      <td>${row.championPoints}</td>
      <td>${row.topScorerPoints}</td>
      <td><strong>${row.total}</strong></td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tableEl.innerHTML = "";
  tableEl.appendChild(table);
  tableEl.hidden = false;
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  let result;
  try {
    result = await computeStandings();
  } catch (err) {
    showStatus(statusEl, "Couldn't load the standings.", true);
    return;
  }

  statusEl.hidden = true;

  const note = pendingNote(result);
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  }

  renderTable(result.rows);
}

main();
