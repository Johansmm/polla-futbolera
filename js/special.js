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
    populateSelect(scorerPlayerSelect, players, "Choose a player");
    scorerPlayerSelect.disabled = players.length === 0;
  }

  populateSelect(championSelect, teamNames, "Choose a team");
  populateSelect(scorerTeamSelect, teamNames, "Choose a country");
  populateSelect(scorerPlayerSelect, [], "Choose a country first");
  scorerPlayerSelect.disabled = true;

  function syncCardState(select) {
    const card = select.closest(".pick-card");
    if (card) card.classList.toggle("has-value", Boolean(select.value));
  }

  scorerTeamSelect.addEventListener("change", () => {
    populateScorerPlayers(scorerTeamSelect.value);
    syncCardState(scorerTeamSelect);
  });

  // Any change after a save means the picks on screen are no longer the
  // picks that are stored — clear the stale "Saved" confirmation.
  for (const select of [championSelect, scorerTeamSelect, scorerPlayerSelect]) {
    select.addEventListener("change", () => {
      submitFeedback.hidden = true;
      syncCardState(select);
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

  for (const select of [championSelect, scorerTeamSelect, scorerPlayerSelect]) {
    syncCardState(select);
  }

  formEl.hidden = false;
}

function renderLocked(pick, deadlineNotConfigured) {
  lockedView.textContent = "";

  const kicker = document.createElement("p");
  kicker.className = "locked-kicker";
  kicker.textContent = deadlineNotConfigured ? "Picks not open" : "Deadline closed";

  const heading = document.createElement("h2");
  const copy = document.createElement("p");

  if (pick) {
    heading.textContent = "Your calls are locked in.";
    copy.textContent = "They will score automatically as the tournament unfolds.";

    const picks = document.createElement("div");
    picks.className = "locked-picks";
    for (const [labelText, value] of [
      ["Champion", pick.champion_pick],
      ["Top scorer", pick.top_scorer_pick],
    ]) {
      const item = document.createElement("div");
      const label = document.createElement("span");
      const strong = document.createElement("strong");
      label.textContent = labelText;
      strong.textContent = value;
      item.append(label, strong);
      picks.appendChild(item);
    }
    lockedView.append(kicker, heading, copy, picks);
  } else if (deadlineNotConfigured) {
    // No deadline configured means picks haven't opened yet (editing
    // fails closed) — very different from the user missing a deadline.
    heading.textContent = "The picks window is not open yet.";
    copy.textContent = "The organizer has not set the schedule. Check back once the knockout calendar is ready.";
    lockedView.append(kicker, heading, copy);
  } else {
    heading.textContent = "The deadline passed before you chose.";
    copy.textContent = "You can still follow every revealed pick and point on the standings page.";
    lockedView.append(kicker, heading, copy);
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
