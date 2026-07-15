import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { resolveUserFromToken } from "./token-gate.js";
import { showStatus, showRetry, showSignedInName, formatKickoff, teamFlagImg } from "./ui.js";
import { isMatchLocked } from "./lock-logic.mjs";
import { fetchUserName, fetchMatches } from "./queries.js";

const PHASE_LABELS = {
  r16: "Round of 16",
  qf: "Quarterfinals",
  sf: "Semifinals",
  third_place: "Third Place",
  final: "Final",
};

const PHASE_CODES = {
  r16: "R16",
  qf: "QF",
  sf: "SF",
  third_place: "3P",
  final: "F",
};

const PHASE_NOTES = {
  r16: "The knockout run begins.",
  qf: "The field narrows.",
  sf: "One win from the final.",
  third_place: "The bronze-medal match.",
  final: "The trophy match.",
};

const PHASE_ORDER = ["r16", "qf", "sf", "third_place", "final"];

const statusEl = document.getElementById("status");
const formEl = document.getElementById("predictions-form");

// Match ids with edits not yet saved — each row saves individually, so
// leaving the page mid-entry silently discards anything typed but unsaved.
const dirtyMatches = new Set();

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

function teamLine(teamName, crestUrl, scoreHtml) {
  return `
    <div class="team-line">
      <span class="team-flag-slot">${teamFlagImg(crestUrl)}</span>
      <span class="team-name">${teamName ?? "To be decided"}</span>
      ${scoreHtml}
    </div>
  `;
}

function scoreInputHtml(cls, teamName, value) {
  return `<input
    type="number"
    class="${cls}"
    inputmode="numeric"
    pattern="[0-9]*"
    min="0"
    max="99"
    step="1"
    enterkeyhint="done"
    autocomplete="off"
    aria-label="${teamName ?? "Team"} goals"
    value="${value ?? ""}"
  />`;
}

function scoreTileHtml(value, extraClass = "") {
  return `<span class="score-tile ${extraClass}">${value ?? "–"}</span>`;
}

// A locked row is read-only history: the score tiles keep the scoreboard
// silhouette but recede, and once the real result is in, the row flips to
// reading as a result card (final score in the tiles, your pick in a note)
// so nobody has to visit the standings just to learn how a match ended.
function renderLockedRow(row, match, prediction) {
  const finished = match.real_score_a != null && match.real_score_b != null;

  const pill = finished
    ? '<span class="locked-label is-final">Final</span>'
    : '<span class="locked-label">Locked</span>';

  const tileA = finished ? match.real_score_a : prediction?.predicted_score_a;
  const tileB = finished ? match.real_score_b : prediction?.predicted_score_b;

  let note = "";
  if (finished) {
    note = prediction
      ? `Your pick: ${prediction.predicted_score_a}–${prediction.predicted_score_b}`
      : "You didn't predict this match";
  } else if (!prediction) {
    note = "No prediction saved";
  }

  row.classList.add("is-locked");
  row.innerHTML = `
    <div class="match-head">
      <span class="match-kickoff">${formatKickoff(match)}</span>
      ${pill}
    </div>
    <div class="match-scoreboard">
      ${teamLine(match.team_a, match.team_a_crest_url, scoreTileHtml(tileA, finished ? "is-final" : ""))}
      ${teamLine(match.team_b, match.team_b_crest_url, scoreTileHtml(tileB, finished ? "is-final" : ""))}
    </div>
    ${note ? `<div class="match-note">${note}</div>` : ""}
  `;
}

function renderMatchRow(match, prediction, userId) {
  const row = document.createElement("div");
  row.className = "match-row";

  if (isMatchLocked(match)) {
    renderLockedRow(row, match, prediction);
    return row;
  }

  row.innerHTML = `
    <div class="match-head">
      <span class="match-kickoff">${formatKickoff(match)}</span>
      <span class="match-state is-open">Open</span>
    </div>
    <div class="match-scoreboard">
      ${teamLine(match.team_a, match.team_a_crest_url, scoreInputHtml("score-a", match.team_a, prediction?.predicted_score_a))}
      ${teamLine(match.team_b, match.team_b_crest_url, scoreInputHtml("score-b", match.team_b, prediction?.predicted_score_b))}
    </div>
    <div class="match-actions">
      <div class="save-feedback" role="status" hidden></div>
      <button type="button" class="save-btn" aria-label="Save prediction for ${match.team_a ?? "?"} vs ${match.team_b ?? "?"}">Save score</button>
    </div>
  `;

  const scoreAInput = row.querySelector(".score-a");
  const scoreBInput = row.querySelector(".score-b");
  const saveBtn = row.querySelector(".save-btn");
  const feedback = row.querySelector(".save-feedback");

  let hideFeedbackTimer = null;
  // Last successfully stored values, as input strings — dirtiness is
  // "differs from what's saved", not "was ever typed in", so edits that
  // restore the saved score don't leave a stale warning behind.
  let savedA = prediction?.predicted_score_a?.toString() ?? "";
  let savedB = prediction?.predicted_score_b?.toString() ?? "";

  function refreshDirty() {
    clearTimeout(hideFeedbackTimer);
    feedback.hidden = true;
    // badInput: the box displays text (e.g. a stray "e") that doesn't
    // parse, so .value is "" and would wrongly compare as clean.
    const dirty =
      scoreAInput.validity.badInput ||
      scoreBInput.validity.badInput ||
      scoreAInput.value !== savedA ||
      scoreBInput.value !== savedB;
    row.classList.toggle("is-dirty", dirty);
    if (dirty) {
      dirtyMatches.add(match.id);
    } else {
      dirtyMatches.delete(match.id);
    }
  }

  function markSaved() {
    row.classList.remove("is-dirty");
    dirtyMatches.delete(match.id);
  }

  // Locks the row in place when a save is rejected because kickoff passed
  // while the tab sat open — the initial render only knows lock state as of
  // page load.
  function lockRowLate() {
    markSaved();
    scoreAInput.disabled = true;
    scoreBInput.disabled = true;
    row.classList.add("is-locked");
  }

  for (const input of [scoreAInput, scoreBInput]) {
    input.addEventListener("input", refreshDirty);
    input.addEventListener("keydown", (event) => {
      // Enter would otherwise be a silent no-op (the form has no submit
      // button) — make it save this row, matching the keyboard's Done key.
      if (event.key === "Enter") {
        event.preventDefault();
        saveBtn.click();
      }
    });
  }

  saveBtn.addEventListener("click", async () => {
    const rawA = scoreAInput.value.trim();
    const rawB = scoreBInput.value.trim();
    const predictedScoreA = Number(rawA);
    const predictedScoreB = Number(rawB);

    clearTimeout(hideFeedbackTimer);
    feedback.hidden = true;

    // The 0–99 bound mirrors the input's own min/max and keeps the value
    // in safe-integer range — Firestore's rules only accept ints, and an
    // out-of-range number would serialize as a double and be rejected
    // with the same error code as a locked match.
    if (
      rawA === "" ||
      rawB === "" ||
      !Number.isSafeInteger(predictedScoreA) ||
      !Number.isSafeInteger(predictedScoreB) ||
      predictedScoreA < 0 ||
      predictedScoreB < 0 ||
      predictedScoreA > 99 ||
      predictedScoreB > 99
    ) {
      showStatus(feedback, "Enter both scores as whole numbers between 0 and 99.", true);
      return;
    }

    let lockedDuringSave = false;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    // Freeze the row while the write is in flight — an edit typed mid-save
    // would otherwise be wiped from dirty-tracking when the save resolves.
    scoreAInput.disabled = true;
    scoreBInput.disabled = true;
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
      savedA = String(predictedScoreA);
      savedB = String(predictedScoreB);
      // Canonicalize the display (e.g. "03" -> "3") so it matches the
      // stored value dirtiness is compared against.
      scoreAInput.value = savedA;
      scoreBInput.value = savedB;
      markSaved();
      showStatus(feedback, "Score saved");
      hideFeedbackTimer = setTimeout(() => {
        feedback.hidden = true;
      }, 4000);
    } catch (err) {
      // Trust the server's verdict over the client clock and the match
      // object fetched at page load: an admin can lock a match early, and
      // a skewed device clock must not turn a network blip into a bogus
      // "locked" message.
      if (err?.code === "permission-denied") {
        lockedDuringSave = true;
        lockRowLate();
        showStatus(feedback, "This match is locked — predictions closed.", true);
      } else {
        showStatus(feedback, "Couldn't save — check your connection and try again.", true);
      }
    } finally {
      saveBtn.textContent = "Save score";
      saveBtn.disabled = lockedDuringSave;
      if (!lockedDuringSave) {
        scoreAInput.disabled = false;
        scoreBInput.disabled = false;
      }
    }
  });

  return row;
}

function renderPredictionOverview(matches) {
  const openMatches = matches.filter((match) => !isMatchLocked(match));
  const lockedMatches = matches.length - openMatches.length;
  const nextMatch = openMatches.reduce((next, match) => {
    if (!next) return match;
    return new Date(match.kickoff_at?.toDate?.() ?? match.kickoff_at) <
      new Date(next.kickoff_at?.toDate?.() ?? next.kickoff_at)
      ? match
      : next;
  }, null);

  const overview = document.createElement("section");
  overview.className = "prediction-overview";
  overview.setAttribute("aria-label", "Prediction progress");

  const progress = document.createElement("div");
  progress.className = "prediction-progress";
  for (const [value, label] of [
    [openMatches.length, "Open"],
    [lockedMatches, "Locked"],
    [matches.length, "Total"],
  ]) {
    const item = document.createElement("div");
    const number = document.createElement("strong");
    const caption = document.createElement("span");
    number.textContent = String(value);
    caption.textContent = label;
    item.append(number, caption);
    progress.appendChild(item);
  }

  const next = document.createElement("div");
  next.className = "next-deadline";
  const kicker = document.createElement("span");
  kicker.textContent = nextMatch ? "Next lock" : "Current status";
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  if (nextMatch) {
    title.textContent = `${nextMatch.team_a ?? "To be decided"} vs ${nextMatch.team_b ?? "To be decided"}`;
    detail.textContent = formatKickoff(nextMatch);
  } else {
    title.textContent = "Every listed match is locked";
    detail.textContent = "Review your saved calls by opening each phase.";
  }
  next.append(kicker, title, detail);
  overview.append(progress, next);
  return overview;
}

function renderForm(matches, predictions, userId) {
  formEl.innerHTML = "";
  const groups = groupByPhase(matches);

  formEl.appendChild(renderPredictionOverview(matches));

  for (const phase of PHASE_ORDER) {
    const phaseMatches = groups[phase];
    if (!phaseMatches?.length) continue;

    const section = document.createElement("section");
    section.className = "phase-section";
    section.dataset.phase = phase;

    const phaseHeader = document.createElement("header");
    phaseHeader.className = "phase-header";
    const phaseTitle = document.createElement("div");
    phaseTitle.className = "phase-title";
    const code = document.createElement("span");
    code.className = "phase-code";
    code.textContent = PHASE_CODES[phase] ?? phase;
    const titleCopy = document.createElement("div");
    const heading = document.createElement("h2");
    heading.textContent = PHASE_LABELS[phase] ?? phase;
    const note = document.createElement("p");
    note.textContent = PHASE_NOTES[phase] ?? "Tournament stage";
    titleCopy.append(heading, note);
    phaseTitle.append(code, titleCopy);

    const count = document.createElement("span");
    count.className = "phase-count";
    count.textContent = `${phaseMatches.length} ${phaseMatches.length === 1 ? "match" : "matches"}`;
    phaseHeader.append(phaseTitle, count);
    section.appendChild(phaseHeader);

    // A fully locked phase is history — collapse its rows so the first
    // thing on screen is always the next match that can still be
    // predicted. The phase header remains outside the disclosure, keeping
    // its h2 available to heading navigation.
    let rowContainer = document.createElement("div");
    rowContainer.className = "match-grid";
    if (phaseMatches.every(isMatchLocked)) {
      const details = document.createElement("details");
      details.className = "locked-rows";
      const summary = document.createElement("summary");
      summary.textContent =
        phaseMatches.length === 1 ? "Review the locked match" : `Review ${phaseMatches.length} locked matches`;
      details.appendChild(summary);
      section.appendChild(details);
      rowContainer = details;
    } else {
      section.appendChild(rowContainer);
    }

    for (const match of phaseMatches) {
      rowContainer.appendChild(renderMatchRow(match, predictions[match.id], userId));
    }

    formEl.appendChild(section);
  }

  formEl.hidden = false;
}

// The form has no submit button, so no browser should ever implicitly
// submit it — but if one did, the default GET navigation would strip
// ?token= and sign the user out mid-entry.
formEl.addEventListener("submit", (event) => event.preventDefault());

window.addEventListener("beforeunload", (event) => {
  if (dirtyMatches.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function main() {
  const userId = await resolveUserFromToken(statusEl);
  if (!userId) return;

  showStatus(statusEl, "Loading matches…");
  fetchUserName(userId)
    .then(showSignedInName)
    .catch(() => {});

  let matches;
  let predictions;
  try {
    // admin/seed.js seeds the whole competition, not just the phases this
    // pool plays, so most of what fetchMatches() returns is never rendered.
    // Narrowing here before fetchPredictions() below is what keeps that from
    // costing one Firestore read per unplayable fixture on every page load.
    matches = (await fetchMatches()).filter((match) => PHASE_ORDER.includes(match.phase));
    predictions = await fetchPredictions(userId, matches);
  } catch (err) {
    showRetry(statusEl, "Couldn't load the matches.", () => window.location.reload());
    return;
  }

  if (!matches.length) {
    showStatus(statusEl, "No matches to predict yet — check back once the bracket is set.");
    return;
  }

  statusEl.hidden = true;
  renderForm(matches, predictions, userId);
}

main();
