import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus, showRetry, showSignedInName, formatDateTime } from "./ui.js";
import { isPastDeadline, findTeamForPlayer } from "./lock-logic.mjs";
import { fetchSpecialPredictionsDeadline, fetchTeamRosters, fetchUserName } from "./queries.js";

const statusEl = document.getElementById("status");
const formEl = document.getElementById("special-form");
const deadlineHintEl = document.getElementById("deadline-hint");
const championSelect = document.getElementById("champion-select");
const scorerTeamSelect = document.getElementById("scorer-team-select");
const scorerPlayerSelect = document.getElementById("scorer-player-select");
const submitBtn = document.getElementById("submit-btn");
const submitFeedback = document.getElementById("submit-feedback");
const lockedView = document.getElementById("locked-view");

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
    populateSelect(scorerPlayerSelect, players, "Choose a player…");
    scorerPlayerSelect.disabled = players.length === 0;
  }

  populateSelect(championSelect, teamNames, "Choose a team…");
  populateSelect(scorerTeamSelect, teamNames, "Choose a country…");
  populateSelect(scorerPlayerSelect, [], "Choose a country first…");
  scorerPlayerSelect.disabled = true;

  scorerTeamSelect.addEventListener("change", () => populateScorerPlayers(scorerTeamSelect.value));

  // Any change after a save means the picks on screen are no longer the
  // picks that are stored — clear the stale "Saved" confirmation.
  for (const select of [championSelect, scorerTeamSelect, scorerPlayerSelect]) {
    select.addEventListener("change", () => {
      submitFeedback.hidden = true;
    });
  }

  if (existingPick) {
    championSelect.value = existingPick.champion_pick;

    const scorerTeam = findTeamForPlayer(rosters, existingPick.top_scorer_pick);
    if (scorerTeam) {
      scorerTeamSelect.value = scorerTeam;
      populateScorerPlayers(scorerTeam);
      scorerPlayerSelect.value = existingPick.top_scorer_pick;
    }

    submitBtn.textContent = "Update picks";
  }

  formEl.hidden = false;
}

function renderLocked(pick, deadlineNotConfigured) {
  if (pick) {
    lockedView.innerHTML = `
      <p>Your picks are locked in:</p>
      <p><strong>Champion:</strong> ${pick.champion_pick}</p>
      <p><strong>Top scorer:</strong> ${pick.top_scorer_pick}</p>
    `;
  } else if (deadlineNotConfigured) {
    // No deadline configured means picks haven't opened yet (editing
    // fails closed) — very different from the user missing a deadline.
    lockedView.innerHTML =
      "<p>Picks aren't open yet — the organizer hasn't set the schedule. Check back soon.</p>";
  } else {
    lockedView.innerHTML =
      "<p>Picks are locked — the deadline passed before you chose. You can still see everyone's picks on the standings page.</p>";
  }
  lockedView.hidden = false;
}

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  showStatus(statusEl, "Loading your picks…");
  fetchUserName(userId)
    .then(showSignedInName)
    .catch(() => {});

  let existingSnap;
  let deadline;
  try {
    [existingSnap, deadline] = await Promise.all([
      getDoc(doc(db, "special_predictions", userId)),
      fetchSpecialPredictionsDeadline(),
    ]);
  } catch (err) {
    showRetry(statusEl, "Couldn't load your picks.", () => window.location.reload());
    return;
  }

  const existingPick = existingSnap.exists() ? existingSnap.data() : null;

  if (isPastDeadline(deadline)) {
    statusEl.hidden = true;
    renderLocked(existingPick, deadline === null);
    return;
  }

  let rosters;
  try {
    rosters = (await fetchTeamRosters()).sort((a, b) => a.team.localeCompare(b.team));
  } catch (err) {
    showRetry(statusEl, "Couldn't load the teams.", () => window.location.reload());
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

  // The deadline is config-driven, so show the real date instead of prose
  // that could go stale — and spell it out in the viewer's own timezone.
  deadlineHintEl.textContent = `You can change your picks as often as you want until ${formatDateTime(deadline)}.`;
  deadlineHintEl.hidden = false;

  renderForm(rosters, existingPick);

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();

    const championPick = championSelect.value;
    const topScorerPick = scorerPlayerSelect.value;

    submitFeedback.classList.remove("error");
    submitFeedback.hidden = true;

    if (!championPick || !topScorerPick) {
      showStatus(submitFeedback, "Pick a champion and a top scorer before saving.", true);
      return;
    }

    let lockedDuringSave = false;
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await setDoc(doc(db, "special_predictions", userId), {
        user_id: userId,
        champion_pick: championPick,
        top_scorer_pick: topScorerPick,
        top_scorer_pick_team: scorerTeamSelect.value,
      });
      showStatus(
        submitFeedback,
        `Saved — champion: ${championPick}, top scorer: ${topScorerPick}. You can change your picks until ${formatDateTime(deadline)}.`
      );
    } catch (err) {
      // The deadline can pass while the tab sits open — the server rejects
      // the write, and a retry can never succeed, so don't present it as a
      // connection problem.
      if (err?.code === "permission-denied") {
        lockedDuringSave = true;
        for (const select of [championSelect, scorerTeamSelect, scorerPlayerSelect]) {
          select.disabled = true;
        }
        showStatus(submitFeedback, "The deadline has passed — picks are locked now.", true);
      } else {
        showStatus(submitFeedback, "Couldn't save — check your connection and try again.", true);
      }
    } finally {
      submitBtn.disabled = lockedDuringSave;
      submitBtn.textContent = "Update picks";
    }
  });
}

main();
