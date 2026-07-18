import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import Chart from "https://esm.sh/chart.js@4.4.9/auto";
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
const leaderboardEl = document.getElementById("leaderboard-stage");
const pointsEvolutionEl = document.getElementById("points-evolution");
const chartCardEl = document.getElementById("points-evolution-card");
const pointsEvolutionCanvas = document.getElementById("points-evolution-canvas");
const heatmapEl = document.getElementById("points-evolution-heatmap");
const chartEmptyEl = document.getElementById("points-evolution-empty");
const phaseFilterEl = document.getElementById("phase-filter");
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
  if (!hasMatchNeedingRefresh(state.matches, state.scoringConfig)) return false;

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
  finalistsKnown,
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
    // Keyed to finalistsKnown, not championDecided: the champion pick starts
    // scoring (its finalist tier) as soon as the Final has a line-up, well
    // before anyone has won it — so "match points only" stops being true then.
    if (!finalistsKnown) missing.push("the finalists aren't known yet");
    // Once a goal has been scored anywhere, topScorerKnown flips true and
    // top scorer points come from the Worker's live /scorers list instead —
    // "hasn't been set yet" no longer applies, but those points remain
    // provisional (see the note below) until the admin confirms the result.
    if (!topScorerKnown) missing.push("the tournament top scorer hasn't been set yet");
    if (missing.length) notes.push(`Match points only for now — ${missing.join(" and ")}.`);
    if (finalistsKnown && !championDecided) {
      notes.push("Only the finalist tier counts so far — the Final hasn't produced a champion yet.");
    }
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

function renderLeaderboard(rows, totalScorableMatches, viewerId) {
  leaderboardEl.textContent = "";

  const heading = document.createElement("div");
  heading.className = "leaderboard-heading";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Front runners";
  const title = document.createElement("h2");
  title.textContent = "The race right now";
  heading.append(eyebrow, title);

  const cards = document.createElement("div");
  cards.className = "leaderboard-cards";
  for (const row of rows.slice(0, 3)) {
    const card = document.createElement("article");
    card.className = "leaderboard-card";
    if (row.rank === 1) card.classList.add("is-leader");
    if (row.userId === viewerId) card.classList.add("is-viewer");

    const cardTop = document.createElement("div");
    cardTop.className = "leaderboard-card-top";
    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = row.rank === 1 ? "Leader" : `Rank ${row.rank}`;
    cardTop.appendChild(rank);
    if (row.userId === viewerId) {
      const you = document.createElement("span");
      you.className = "leaderboard-you";
      you.textContent = "You";
      cardTop.appendChild(you);
    }

    const name = document.createElement("h3");
    name.textContent = row.name;
    const score = document.createElement("p");
    score.className = "leaderboard-score";
    const number = document.createElement("strong");
    number.textContent = String(row.total);
    const unit = document.createElement("span");
    unit.textContent = "points";
    score.append(number, unit);

    const meta = document.createElement("p");
    meta.className = "leaderboard-meta";
    meta.textContent = `${row.exactHits} exact · ${row.predictionsSubmitted}/${totalScorableMatches} predicted`;
    card.append(cardTop, name, score, meta);
    cards.appendChild(card);
  }

  leaderboardEl.append(heading, cards);
  leaderboardEl.hidden = false;
}

// Evenly spread hues via the golden angle, rather than a fixed-size
// palette — the group's actual size isn't a technical constraint anywhere
// in this design (see CLAUDE.md), so any number of players still gets
// visually distinct line colors. alpha lets the leader's fill gradient
// reuse the same hue as its line instead of a second, hardcoded color.
function seriesColor(index, alpha = 1) {
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 65% 45% / ${alpha})`;
}

function chartThemeColors() {
  const rootStyle = getComputedStyle(document.documentElement);
  const cssVar = (name) => rootStyle.getPropertyValue(name).trim();
  return {
    ink: cssVar("--ink"),
    inkFaint: cssVar("--ink-faint"),
    inkSoft: cssVar("--ink-soft"),
    lineSoft: cssVar("--line-soft"),
  };
}

// Shared by both chart views — a dashed, neutral reference line rather than
// another hue from seriesColor's palette, so it reads as "the baseline"
// (mirroring the standings table's own "± Avg" column) instead of
// competing with the players' own lines/bars for attention.
function averageDatasetOptions() {
  const { inkSoft } = chartThemeColors();
  return {
    label: "Average",
    borderColor: inkSoft,
    borderDash: [6, 4],
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 3,
    fill: false,
  };
}

// Shared by every chart view below — everything except the data/type
// itself (legend, tooltip title resolved from `steps` rather than the
// short axis tick, theme colors, reduced-motion). beginAtZero is false only
// for the "vs Average" view, whose values are a deviation that can go
// negative — forcing the axis to start at 0 there would clip anyone below
// the average clean off the chart.
function baseChartOptions(steps, { beginAtZero = true } = {}) {
  const { ink, inkFaint, lineSoft } = chartThemeColors();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reducedMotion ? false : undefined,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          color: ink,
          usePointStyle: true,
          boxWidth: 8,
          font: { family: "Spline Sans", size: 11 },
          // Chart.js's default legend list follows each dataset's `order`
          // (used above purely for draw depth — the viewer's/average's
          // line drawn on top), so without this override the legend itself
          // reshuffles between the two chart views even though the
          // underlying `datasets` array is built in the same stable order
          // (alphabetical, "Average" last) both times. Re-sort back to
          // that array order so the legend reads the same regardless of
          // which view (or who's the viewer) is showing.
          generateLabels: (chart) =>
            Chart.defaults.plugins.legend.labels.generateLabels(chart).sort((a, b) => a.datasetIndex - b.datasetIndex),
        },
      },
      // The full match description (team names + phase, "(Live)" suffix
      // included) lives in the tooltip title instead of the short axis
      // label — cramming it onto the axis itself wouldn't fit next to a
      // dozen other tick labels.
      tooltip: {
        callbacks: { title: (items) => steps[items[0].dataIndex].label },
      },
    },
    scales: {
      x: {
        ticks: { color: inkFaint, maxRotation: 0, font: { size: 10 } },
        grid: { color: lineSoft },
      },
      y: {
        beginAtZero,
        ticks: { color: inkFaint, font: { size: 10 } },
        grid: { color: lineSoft },
      },
    },
  };
}

// Running totals, one line per user — the headline view: who's leading and
// by how much, as of each resolved match.
function buildCumulativeChart(steps, series, viewerId, average) {
  let leaderIndex = 0;
  series.forEach((s, index) => {
    if (s.values.at(-1) > series[leaderIndex].values.at(-1)) leaderIndex = index;
  });

  const datasets = series.map((s, index) => {
    const isViewer = s.userId === viewerId;
    return {
      label: isViewer ? `${s.name} (you)` : s.name,
      data: s.values,
      borderColor: seriesColor(index),
      backgroundColor: seriesColor(index),
      tension: 0.35,
      pointRadius: 2.5,
      pointHoverRadius: 5,
      borderWidth: isViewer ? 3.5 : 1.75,
      // Drawn last (on top of every other line) so the viewer can always
      // find themselves, regardless of alphabetical position.
      order: isViewer ? 0 : 1,
      fill: index === leaderIndex ? "origin" : false,
    };
  });

  // Fixed height rather than the canvas's current clientHeight: the chart
  // can render on the very tick that flips `hidden` off, before layout has
  // given the canvas real dimensions, and createLinearGradient needs a
  // height up front — this only has to roughly match .chart-card's CSS
  // height for the fade to look right.
  const gradient = pointsEvolutionCanvas.getContext("2d").createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, seriesColor(leaderIndex, 0.3));
  gradient.addColorStop(1, seriesColor(leaderIndex, 0));
  datasets[leaderIndex].backgroundColor = gradient;

  datasets.push({ ...averageDatasetOptions(), data: average.values, tension: 0.35, order: 2 });

  return new Chart(pointsEvolutionCanvas, {
    type: "line",
    data: { labels: steps.map((s) => s.shortLabel), datasets },
    options: baseChartOptions(steps),
  });
}

// Cumulative totals re-based to the group average — the same running
// totals as buildCumulativeChart, but plotted as each user's gap to the
// average at that step instead of their raw total. Answers "who's ahead of
// the pack and by how much" without needing to mentally subtract two
// lines. average re-based to itself is always exactly 0, so that dataset
// becomes a flat zero line here — the chart's baseline rather than a
// second copy of the same reference.
function buildVsAverageChart(steps, series, viewerId, average) {
  const datasets = series.map((s, index) => {
    const isViewer = s.userId === viewerId;
    const deviation = s.values.map((v, i) => Math.round((v - average.values[i]) * 10) / 10);
    return {
      label: isViewer ? `${s.name} (you)` : s.name,
      data: deviation,
      borderColor: seriesColor(index),
      backgroundColor: seriesColor(index),
      tension: 0.35,
      pointRadius: 2.5,
      pointHoverRadius: 5,
      borderWidth: isViewer ? 3.5 : 1.75,
      order: isViewer ? 0 : 1,
      fill: false,
    };
  });

  datasets.push({ ...averageDatasetOptions(), data: steps.map(() => 0), tension: 0, pointRadius: 0, order: 2 });

  const options = baseChartOptions(steps, { beginAtZero: false });
  // "+3" reads clearer than "3" for a value that's explicitly a gap above
  // or below the average — matches the standings table's own "± Avg"
  // column formatting (standings.js's formatDelta).
  options.plugins.tooltip.callbacks.label = (item) => `${item.dataset.label}: ${item.parsed.y > 0 ? "+" : ""}${item.parsed.y}`;

  return new Chart(pointsEvolutionCanvas, {
    type: "line",
    data: { labels: steps.map((s) => s.shortLabel), datasets },
    options,
  });
}

// Un-accumulated points per match, one bar per user per match (grouped, not
// stacked) — surfaces the volatility the cumulative view can't (it only
// ever goes up): who's contributing steadily each round versus who had one
// match carry their whole total. Deliberately not stacked: a stacked bar's
// total height is the *group's combined* points, which reads as if a
// single player scored that much — grouped bars keep each bar's height
// tied to one player's own points, capped at whatever that match's outcome
// tiers/phase multiplier can actually award.
function buildPerMatchChart(steps, series, viewerId, average) {
  const datasets = series.map((s, index) => {
    const isViewer = s.userId === viewerId;
    return {
      label: isViewer ? `${s.name} (you)` : s.name,
      data: s.stepPoints,
      backgroundColor: seriesColor(index, isViewer ? 0.95 : 0.75),
      borderColor: isViewer ? seriesColor(index) : "transparent",
      borderWidth: isViewer ? 2 : 0,
      borderRadius: 3,
      order: 2,
    };
  });

  // Mixed chart: a line dataset overlaid on a bar chart, same as
  // buildCumulativeChart's reference line — Chart.js supports per-dataset
  // `type` for exactly this. order: 1 (lower than the bars' 2) keeps it
  // drawn on top instead of hidden behind them.
  datasets.push({ ...averageDatasetOptions(), type: "line", data: average.stepPoints, tension: 0.3, order: 1 });

  return new Chart(pointsEvolutionCanvas, {
    type: "bar",
    data: { labels: steps.map((s) => s.shortLabel), datasets },
    options: baseChartOptions(steps),
  });
}

// One row per user, one column per match — the same stepPoints as the
// per-match bar chart, but a grid scales to any number of players without
// squeezing bar widths (issue feedback: too many bars once the pool grows).
// Cell intensity is normalized against that match's *theoretical* ceiling
// (step.maxPoints, from scoring_config.json's outcome tiers × phase
// multiplier) rather than the best score anyone actually got that round —
// otherwise a round where everyone missed would render its best (mediocre)
// score as if it were a perfect one. Not Chart.js: it has no built-in
// matrix/heatmap chart type, and pulling in a second charting plugin for
// one view isn't worth it — a plain table gets the same result with less
// code.
function renderHeatmap(steps, series, viewerId, average) {
  heatmapEl.textContent = "";

  const table = document.createElement("table");
  table.className = "heatmap-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th")); // corner cell, above the row labels
  for (const step of steps) {
    const th = document.createElement("th");
    th.textContent = step.shortLabel;
    th.title = step.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  function addRow(label, isViewer, stepPoints, colorFor) {
    const tr = document.createElement("tr");
    tr.className = "heatmap-row";
    const th = document.createElement("th");
    th.textContent = label;
    if (isViewer) {
      const you = document.createElement("span");
      you.className = "you-tag";
      you.textContent = "(you)";
      th.appendChild(you);
    }
    tr.appendChild(th);

    stepPoints.forEach((points, stepIndex) => {
      const step = steps[stepIndex];
      const clamped = step.maxPoints > 0 ? Math.min(Math.max(points / step.maxPoints, 0), 1) : 0;
      const td = document.createElement("td");
      td.className = "heatmap-cell";
      td.style.backgroundColor = colorFor(clamped);
      const rounded = Math.round(points * 10) / 10;
      td.textContent = String(rounded);
      td.title = `${label} — ${step.label}: ${rounded} pt${rounded === 1 ? "" : "s"}`;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  series.forEach((s, index) => {
    // A 0-point cell still gets a faint tint (alpha's floor) so every cell
    // reads as part of the grid, not a missing one.
    addRow(s.name, s.userId === viewerId, s.stepPoints, (clamped) => seriesColor(index, 0.12 + clamped * 0.78));
  });

  // Styled distinctly (grayscale, see .is-average) rather than another hue
  // — it's a reference baseline, not another player.
  addRow("Average", false, average.stepPoints, (clamped) => `hsl(0 0% 50% / ${0.1 + clamped * 0.6})`);
  tbody.lastElementChild.classList.add("is-average");

  table.appendChild(tbody);
  heatmapEl.appendChild(table);
}

let pointsChart = null;
let chartType = "cumulative"; // "cumulative" | "per-match" — toggled by the buttons below.
// Cached so the toggle buttons/phase filter can re-render without needing a
// fresh computeStandings() call — both are pure client-side redraws.
let lastPointsEvolution = { steps: [], series: [] };
let lastViewerId = null;

// Which phases (plus the synthetic "special" step) are currently shown —
// null until the first real data arrives, at which point every phase seen
// starts active. A Set rather than re-deriving from `steps` each time, so a
// phase the visitor deliberately hid stays hidden as later matches resolve.
let activePhases = null;
const knownPhaseKeys = new Set();

function ensurePhaseState(phaseKeys) {
  for (const key of phaseKeys) {
    if (knownPhaseKeys.has(key)) continue;
    knownPhaseKeys.add(key);
    (activePhases ??= new Set()).add(key);
  }
}

function renderPhaseFilter(phases) {
  if (phases.length < 2) {
    phaseFilterEl.hidden = true;
    phaseFilterEl.textContent = "";
    return;
  }
  phaseFilterEl.hidden = false;
  phaseFilterEl.textContent = "";
  for (const { key, label } of phases) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "phase-filter-btn";
    if (activePhases.has(key)) btn.classList.add("is-active");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      // Keep at least one phase active — an empty filter would just blank
      // the chart with no way back short of reloading the page.
      if (activePhases.has(key) && activePhases.size === 1) return;
      if (activePhases.has(key)) activePhases.delete(key);
      else activePhases.add(key);
      renderPointsEvolution(lastPointsEvolution, lastViewerId);
    });
    phaseFilterEl.appendChild(btn);
  }
}

const chartToggleButtons = document.querySelectorAll(".chart-toggle-btn");
chartToggleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.chart === chartType) return;
    chartType = btn.dataset.chart;
    chartToggleButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    renderPointsEvolution(lastPointsEvolution, lastViewerId);
  });
});

// series is already sorted alphabetically by standings-logic.mjs, not by
// rank — rank reshuffles every poll tick, and shuffling colors/order along
// with it would make either chart view far harder to read than a stable
// order.
function renderPointsEvolution(pointsEvolution, viewerId) {
  lastPointsEvolution = pointsEvolution;
  lastViewerId = viewerId;
  const { steps, series, average } = pointsEvolution;

  // A single step has nothing to trace a trend across — hide rather than
  // show a chart that's just one column of dots/bars.
  if (steps.length < 2 || !series.length) {
    pointsEvolutionEl.hidden = true;
    pointsChart?.destroy();
    pointsChart = null;
    return;
  }
  pointsEvolutionEl.hidden = false;

  const phaseKeys = [...new Set(steps.map((s) => s.phase))];
  ensurePhaseState(phaseKeys);
  renderPhaseFilter(phaseKeys.map((key) => ({ key, label: key === "special" ? "Special picks" : (PHASE_TAGS[key] ?? key) })));

  const visibleIndices = steps.map((_, index) => index).filter((index) => activePhases.has(steps[index].phase));
  const filteredSteps = visibleIndices.map((index) => steps[index]);
  const filteredSeries = series.map((s) => ({
    ...s,
    values: visibleIndices.map((index) => s.values[index]),
    stepPoints: visibleIndices.map((index) => s.stepPoints[index]),
  }));
  const filteredAverage = {
    values: visibleIndices.map((index) => average.values[index]),
    stepPoints: visibleIndices.map((index) => average.stepPoints[index]),
  };

  // Always destroyed and rebuilt rather than updated in place — the two
  // Chart.js views are different `type`s (line vs. bar), which `.update()`
  // doesn't support switching between, and a rebuild is cheap at the poll
  // loop's 10s cadence (or a toggle/filter click) anyway.
  pointsChart?.destroy();
  pointsChart = null;

  if (filteredSteps.length < 2) {
    chartEmptyEl.hidden = false;
    pointsEvolutionCanvas.hidden = true;
    heatmapEl.hidden = true;
    chartCardEl.classList.remove("is-heatmap");
    return;
  }
  chartEmptyEl.hidden = true;

  if (chartType === "heatmap") {
    pointsEvolutionCanvas.hidden = true;
    chartCardEl.classList.add("is-heatmap");
    heatmapEl.hidden = false;
    renderHeatmap(filteredSteps, filteredSeries, viewerId, filteredAverage);
    return;
  }

  chartCardEl.classList.remove("is-heatmap");
  heatmapEl.hidden = true;
  pointsEvolutionCanvas.hidden = false;

  const builder = { cumulative: buildCumulativeChart, "per-match": buildPerMatchChart, "vs-average": buildVsAverageChart }[
    chartType
  ];
  pointsChart = builder(filteredSteps, filteredSeries, viewerId, filteredAverage);
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

  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = "Complete prediction pool standings";
  table.prepend(caption);

  const scrollHint = document.createElement("p");
  scrollHint.className = "table-swipe-hint";
  scrollHint.textContent = "Swipe to see every column →";

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
  tableEl.append(scrollHint, table);
  tableEl.hidden = false;
  renderLeaderboard(rows, totalScorableMatches, viewerId);
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
    leaderboardEl.hidden = true;
    renderPointsEvolution({ steps: [], series: [] }, viewerId);
    tableEl.hidden = true;
    sectionsEl.hidden = true;
    showStatus(statusEl, "No players registered yet — ask the organizer.");
    return;
  }

  if (result.totalScorableMatches === 0 && !result.specialRevealed) {
    leaderboardEl.hidden = true;
    renderPointsEvolution({ steps: [], series: [] }, viewerId);
    tableEl.hidden = true;
    sectionsEl.hidden = true;
    showStatus(statusEl, "Standings will appear once the first match kicks off — nothing is scored yet.");
    return;
  }

  statusEl.hidden = true;

  const note = pendingNote(result);
  noteEl.hidden = !note;
  if (note) noteEl.textContent = note;

  renderTable(result.rows, result.totalScorableMatches, viewerId);
  renderPointsEvolution(result.pointsEvolution, viewerId);
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
