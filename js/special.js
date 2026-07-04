import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus } from "./ui.js";
import { isPastDeadline, findTeamForPlayer } from "./lock-logic.mjs";

const statusEl = document.getElementById("status");
const formEl = document.getElementById("special-form");
const championSelect = document.getElementById("champion-select");
const scorerTeamSelect = document.getElementById("scorer-team-select");
const scorerPlayerSelect = document.getElementById("scorer-player-select");
const submitBtn = document.getElementById("submit-btn");
const submitFeedback = document.getElementById("submit-feedback");
const lockedView = document.getElementById("locked-view");

async function fetchRosters() {
  const snap = await getDocs(collection(db, "team_rosters"));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.team.localeCompare(b.team));
}

// null deadline (config/special_predictions doesn't exist yet) is treated
// as already locked, matching firestore.rules' fail-closed default.
async function fetchDeadline() {
  const snap = await getDoc(doc(db, "config", "special_predictions"));
  return snap.exists() ? snap.data().locked_after.toDate() : null;
}

function populateSelect(selectEl, options, placeholder) {
  selectEl.innerHTML = "";

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  selectEl.appendChild(placeholderOption);

  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }
}

function renderForm(rosters, existingPick) {
  const rostersByTeam = Object.fromEntries(rosters.map((r) => [r.team, r.players]));
  const teamNames = rosters.map((r) => r.team);

  function populateScorerPlayers(team) {
    const players = [...(rostersByTeam[team] ?? [])].sort();
    populateSelect(scorerPlayerSelect, players, "Choose a player...");
    scorerPlayerSelect.disabled = players.length === 0;
  }

  populateSelect(championSelect, teamNames, "Choose a team...");
  populateSelect(scorerTeamSelect, teamNames, "Choose a country...");
  populateSelect(scorerPlayerSelect, [], "Choose a country first...");
  scorerPlayerSelect.disabled = true;

  scorerTeamSelect.addEventListener("change", () => populateScorerPlayers(scorerTeamSelect.value));

  if (existingPick) {
    championSelect.value = existingPick.champion_pick;

    const scorerTeam = findTeamForPlayer(rosters, existingPick.top_scorer_pick);
    if (scorerTeam) {
      scorerTeamSelect.value = scorerTeam;
      populateScorerPlayers(scorerTeam);
      scorerPlayerSelect.value = existingPick.top_scorer_pick;
    }

    submitBtn.textContent = "Update prediction";
  }

  formEl.hidden = false;
}

function renderLocked(pick) {
  lockedView.innerHTML = pick
    ? `
      <p>The deadline to pick has closed.</p>
      <p><strong>Champion:</strong> ${pick.champion_pick}</p>
      <p><strong>Top scorer:</strong> ${pick.top_scorer_pick}</p>
    `
    : `<p>The deadline to pick a champion and top scorer has closed and you didn't make a pick in time.</p>`;
  lockedView.hidden = false;
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  let existingSnap;
  let deadline;
  try {
    [existingSnap, deadline] = await Promise.all([
      getDoc(doc(db, "special_predictions", userId)),
      fetchDeadline(),
    ]);
  } catch (err) {
    showStatus(statusEl, "Couldn't load your prediction.", true);
    return;
  }

  const existingPick = existingSnap.exists() ? existingSnap.data() : null;

  if (isPastDeadline(deadline)) {
    statusEl.hidden = true;
    renderLocked(existingPick);
    return;
  }

  let rosters;
  try {
    rosters = await fetchRosters();
  } catch (err) {
    showStatus(statusEl, "Couldn't load the teams.", true);
    return;
  }

  // An empty (not missing) team_rosters collection doesn't throw — Firestore
  // just returns zero docs — so this needs its own check, or the form would
  // render with two dropdowns that have no options at all.
  if (!rosters.length) {
    showStatus(statusEl, "Teams aren't available yet. Ask the organizer.", true);
    return;
  }

  statusEl.hidden = true;
  renderForm(rosters, existingPick);

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();

    const championPick = championSelect.value;
    const topScorerPick = scorerPlayerSelect.value;

    submitFeedback.classList.remove("error");

    if (!championPick || !topScorerPick) {
      showStatus(submitFeedback, "Pick a champion and a top scorer before saving.", true);
      return;
    }

    const confirmMessage = existingPick
      ? `Confirm the change?\n\nChampion: ${championPick}\nTop scorer: ${topScorerPick}`
      : `Confirm your prediction?\n\nChampion: ${championPick}\nTop scorer: ${topScorerPick}`;
    if (!window.confirm(confirmMessage)) return;

    submitBtn.disabled = true;
    try {
      await setDoc(doc(db, "special_predictions", userId), {
        user_id: userId,
        champion_pick: championPick,
        top_scorer_pick: topScorerPick,
      });
      showStatus(submitFeedback, "Saved. You can change it again until the first Round of 16 match kicks off.");
      submitBtn.textContent = "Update prediction";
    } catch (err) {
      showStatus(submitFeedback, "Couldn't save. Please try again.", true);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

main();
