import { kickoffDate } from "./lock-logic.mjs";

export function showStatus(el, message, isError = false) {
  el.classList.toggle("error", isError);
  // Unhide before writing: several of these elements are live regions
  // (role="status"), and content written while hidden is never announced.
  el.hidden = false;
  el.textContent = message;
}

// Error status plus a retry button — a visible button beats "try reloading
// the page" prose, especially inside chat-app webviews that hide the
// browser's own reload UI.
export function showRetry(el, message, onRetry) {
  showStatus(el, message, true);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Try again";
  btn.addEventListener("click", onRetry);
  el.appendChild(document.createElement("br"));
  el.appendChild(btn);
}

// Fills the #user-name line present on every token-gated page, so whoever
// opens a personal link can immediately tell whose predictions they're
// editing (wrong-person entries are invisible until standings reveal them).
export function showSignedInName(name) {
  const el = document.getElementById("user-name");
  if (!el || !name) return;

  el.textContent = "";
  const avatar = document.createElement("span");
  avatar.className = "profile-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = name.trim().charAt(0).toUpperCase();

  const copy = document.createElement("span");
  copy.className = "profile-copy";
  const label = document.createElement("small");
  label.textContent = "Playing as";
  const strong = document.createElement("strong");
  strong.textContent = name;
  copy.append(label, strong);
  el.append(avatar, copy);
  el.hidden = false;
}

// crestUrl comes from team_a_crest_url/team_b_crest_url, merged in at read
// time by js/worker-matches.mjs from the Worker's football-data.org
// response — there's no team-name-to-flag lookup of our own to keep in
// sync. Renders nothing (not a broken-image icon) for a team with no crest
// resolved yet. The team name is always adjacent text, so the flag is
// decorative: alt="" keeps screen readers from announcing every team
// twice, and the explicit width/height reserve the box before the image
// loads so rows don't shift.
export function teamFlagImg(crestUrl) {
  if (!crestUrl) return "";
  return `<img class="team-flag" src="${crestUrl}" alt="" width="28" height="20" loading="lazy" />`;
}

// Renders in the viewer's own browser timezone rather than a fixed one —
// the group is spread across different European countries (see CLAUDE.md),
// so there's no single "right" timezone to pick on their behalf. Appending
// timeZoneName spells out which offset that ended up being (e.g. "GMT+2"),
// since two group members can otherwise see the same match at what looks
// like a different time with no indication why.
export function formatDateTime(date) {
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function formatKickoff(match) {
  return formatDateTime(kickoffDate(match));
}
