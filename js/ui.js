import { kickoffDate } from "./lock-logic.mjs";

export function showStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
}

// crestUrl comes straight from matches.team_a_crest_url/team_b_crest_url,
// synced by automation/sync-fixtures.js from football-data.org — there's no
// team-name-to-flag lookup of our own to keep in sync. Renders nothing (not
// a broken-image icon) for a team with no crest synced yet.
export function teamFlagImg(crestUrl, teamName) {
  if (!crestUrl) return "";
  return `<img class="team-flag" src="${crestUrl}" alt="${teamName ?? ""}" />`;
}

// Renders in the viewer's own browser timezone rather than a fixed one —
// the group is spread across different European countries (see CLAUDE.md),
// so there's no single "right" timezone to pick on their behalf. Appending
// timeZoneName spells out which offset that ended up being (e.g. "GMT+2"),
// since two group members can otherwise see the same match at what looks
// like a different time with no indication why.
export function formatKickoff(match) {
  return kickoffDate(match).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
