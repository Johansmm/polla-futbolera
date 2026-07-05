import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus, formatKickoff, teamFlagImg } from "./ui.js";
import { isMatchLocked } from "./lock-logic.mjs";

const PHASE_LABELS = {
  r16: "Round of 16",
  qf: "Quarterfinals",
  sf: "Semifinals",
  third_place: "Third Place",
  final: "Final",
};

const PHASE_ORDER = ["r16", "qf", "sf", "third_place", "final"];

const statusEl = document.getElementById("status");
const formEl = document.getElementById("predictions-form");

async function fetchMatches() {
  const snap = await getDocs(query(collection(db, "matches"), orderBy("kickoff_at")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchPredictions(userId, matches) {
  const entries = await Promise.all(
    matches.map(async (match) => {
      const predSnap = await getDoc(doc(db, "predictions", `${userId}_${match.id}`));
      return [match.id, predSnap.exists() ? predSnap.data() : null];
    })
  );
  return Object.fromEntries(entries);
}

function groupByPhase(matches) {
  const groups = {};
  for (const match of matches) {
    if (!groups[match.phase]) groups[match.phase] = [];
    groups[match.phase].push(match);
  }
  return groups;
}

function renderMatchRow(match, prediction, userId) {
  const row = document.createElement("div");
  row.className = "match-row";

  const locked = isMatchLocked(match);

  row.innerHTML = `
    <div class="match-teams">
      ${teamFlagImg(match.team_a_crest_url, match.team_a)} ${match.team_a ?? "?"}
      vs
      ${teamFlagImg(match.team_b_crest_url, match.team_b)} ${match.team_b ?? "?"}
      <span class="match-kickoff">${formatKickoff(match)}</span>
    </div>
    <div class="match-inputs">
      <input type="number" min="0" class="score-a" value="${prediction?.predicted_score_a ?? ""}" ${locked ? "disabled" : ""} />
      <span>-</span>
      <input type="number" min="0" class="score-b" value="${prediction?.predicted_score_b ?? ""}" ${locked ? "disabled" : ""} />
      <button type="button" class="save-btn" ${locked ? "disabled" : ""}>Save</button>
    </div>
    ${locked ? '<div class="locked-label">Locked</div>' : ""}
    <div class="save-feedback" hidden></div>
  `;

  if (locked) return row;

  const scoreAInput = row.querySelector(".score-a");
  const scoreBInput = row.querySelector(".score-b");
  const saveBtn = row.querySelector(".save-btn");
  const feedback = row.querySelector(".save-feedback");

  saveBtn.addEventListener("click", async () => {
    const predictedScoreA = Number.parseInt(scoreAInput.value, 10);
    const predictedScoreB = Number.parseInt(scoreBInput.value, 10);

    feedback.classList.remove("error");

    if (
      Number.isNaN(predictedScoreA) ||
      Number.isNaN(predictedScoreB) ||
      predictedScoreA < 0 ||
      predictedScoreB < 0
    ) {
      feedback.textContent = "Enter a valid score.";
      feedback.classList.add("error");
      feedback.hidden = false;
      return;
    }

    saveBtn.disabled = true;
    try {
      await setDoc(
        doc(db, "predictions", `${userId}_${match.id}`),
        {
          prediction_id: `${userId}_${match.id}`,
          user_id: userId,
          match_id: match.id,
          predicted_score_a: predictedScoreA,
          predicted_score_b: predictedScoreB,
        },
        { merge: true }
      );
      feedback.textContent = "Saved.";
    } catch (err) {
      feedback.textContent = "Couldn't save (has the match already kicked off?).";
      feedback.classList.add("error");
    } finally {
      feedback.hidden = false;
      saveBtn.disabled = false;
    }
  });

  return row;
}

function renderForm(matches, predictions, userId) {
  formEl.innerHTML = "";
  const groups = groupByPhase(matches);

  for (const phase of PHASE_ORDER) {
    const phaseMatches = groups[phase];
    if (!phaseMatches?.length) continue;

    const section = document.createElement("section");
    section.className = "phase-section";

    const heading = document.createElement("h2");
    heading.textContent = PHASE_LABELS[phase] ?? phase;
    section.appendChild(heading);

    for (const match of phaseMatches) {
      section.appendChild(renderMatchRow(match, predictions[match.id], userId));
    }

    formEl.appendChild(section);
  }

  formEl.hidden = false;
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  try {
    const matches = await fetchMatches();
    const predictions = await fetchPredictions(userId, matches);
    statusEl.hidden = true;
    renderForm(matches, predictions, userId);
  } catch (err) {
    showStatus(statusEl, "Couldn't load the matches.", true);
  }
}

main();
