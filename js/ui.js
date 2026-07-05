import { kickoffDate } from "./lock-logic.mjs";

export function showStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
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
