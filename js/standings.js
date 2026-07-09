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
import { showStatus, showRetry, showSignedInName, formatKickoff, teamFlagImg } from "./ui.js";
import { isPastDeadline, isMatchLocked, kickoffDate, findTeamForPlayer } from "./lock-logic.mjs";
import {
  scoreMatchBreakdown,
  calculateChampionPoints,
  calculateTopScorerPoints,
  finishedMatches,
  deriveChampion,
  deriveSemifinalists,
  isMatchLive,
  effectiveScore,
} from "./scoring-logic.mjs";
import { fetchSpecialPredictionsDeadline, fetchTeamRosters, fetchUserName, fetchMatches } from "./queries.js";

const PHASE_LABELS = {
  r16: "Round of 16",
  qf: "Quarterfinals",
  sf: "Semifinals",
  third_place: "Third Place",
  final: "Final",
};

// Compact phase tags for the per-match breakdown summaries, which have to
// fit a phone screen alongside two team names and flags.
const PHASE_TAGS = {
  r16: "R16",
  qf: "QF",
  sf: "SF",
  third_place: "3rd place",
  final: "Final",
};

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

  const anyMatchLive = matches.some(isMatchLive);
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

      const live = isMatchLive(match);
      const { points, exactScoreHit } = scoreMatchBreakdown(
        prediction,
        effectiveScore(match),
        finishedIds.has(match.id) || live,
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
      userId: user.user_id,
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

  // Competition ranking ("1, 1, 3"): rows tied on both the total and the
  // exact-hits tiebreaker share a rank instead of asserting an ordering
  // that doesn't exist — the alphabetical sort above is display-only.
  rows.forEach((row, index) => {
    const prev = rows[index - 1];
    row.rank = prev && prev.total === row.total && prev.exactHits === row.exactHits ? prev.rank : index + 1;
  });

  // Most recent kickoff first.
  const matchSections = [...scorableMatches]
    .sort((a, b) => kickoffDate(b) - kickoffDate(a))
    .map((match) => {
      const live = isMatchLive(match);
      const scoreTag =
        match.real_score_a != null && match.real_score_b != null
          ? ` · Final ${match.real_score_a}–${match.real_score_b}`
          : live
            ? ` · Live ${match.live_score_a}–${match.live_score_b}`
            : "";
      const liveBadge = live ? ` <span class="live-badge">🔴 Live</span>` : "";

      const rawEntries = rows.map((row) => {
        const breakdown = row.matchBreakdown.find((b) => b.match.id === match.id);
        const prediction = breakdown?.prediction
          ? `${breakdown.prediction.predicted_score_a}–${breakdown.prediction.predicted_score_b}`
          : "—";
        return { name: row.name, prediction, points: breakdown?.points ?? null };
      });
      // Highest points for this specific match, not the overall standings —
      // ties share the crown, same as .leader-row in the general table.
      const maxPoints = rawEntries.reduce((max, e) => (e.points != null && e.points > max ? e.points : max), -Infinity);
      const entries = rawEntries
        .map((e) => ({ ...e, top: e.points != null && e.points === maxPoints }))
        .sort((a, b) => {
          if (a.points == null && b.points == null) return a.name.localeCompare(b.name);
          if (a.points == null) return 1;
          if (b.points == null) return -1;
          return b.points - a.points || a.name.localeCompare(b.name);
        });

      return {
        title: `
          <span class="summary-title">${PHASE_TAGS[match.phase] ?? match.phase} · ${teamFlagImg(match.team_a_crest_url)} ${match.team_a ?? "?"} vs ${teamFlagImg(match.team_b_crest_url)} ${match.team_b ?? "?"}${liveBadge}</span>
          <span class="summary-sub">${formatKickoff(match)}${scoreTag}</span>
        `,
        entries,
      };
    });

  const specialSections = specialRevealed
    ? [
        {
          title: '<span class="summary-title">Champion picks</span>',
          entries: rows.map((row) => ({ name: row.name, prediction: row.championPick ?? "—", points: row.championPoints })),
        },
        {
          title: '<span class="summary-title">Top scorer picks</span>',
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
    anyMatchLive,
    matchSections,
    specialSections,
    totalScorableMatches: scorableMatches.length,
  };
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
