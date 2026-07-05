import { signInWithToken, switchAccount } from "./auth.js";
import { showStatus } from "./ui.js";
import { fetchUserName } from "./queries.js";

export function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("token");
}

/**
 * Resolves the URL token into a user_id, rendering status/error/conflict
 * messages into statusEl as needed. Returns the resolved user_id on
 * success, or null if the caller should stop (the reason is already shown
 * to the user in statusEl).
 *
 * On success statusEl is deliberately left visible (still "Loading…") —
 * the caller is about to fetch its own data and owns updating/hiding the
 * status once its content is rendered, so the page is never blank while
 * the real data loads.
 */
export async function resolveUserFromToken(statusEl) {
  const token = getTokenFromUrl();

  if (!token) {
    showStatus(
      statusEl,
      "This link is incomplete — open the personal link the organizer sent you, exactly as you received it.",
      true
    );
    return null;
  }

  showStatus(statusEl, "Loading…");

  let result;
  try {
    result = await signInWithToken(token);
  } catch (err) {
    showStatus(statusEl, "Couldn't sign you in. Check your connection and reload the page.", true);
    return null;
  }

  if (!result) {
    showStatus(statusEl, "This link isn't valid anymore. Ask the organizer for a fresh one.", true);
    return null;
  }

  if (result.conflict) {
    await renderConflict(statusEl, result, token);
    return null;
  }

  return result.userId;
}

async function renderConflict(statusEl, result, token) {
  let boundName = null;
  try {
    boundName = await fetchUserName(result.boundUserId);
  } catch (err) {
    // The name is a nicety; the conflict message works without it.
  }

  const message = boundName
    ? `This device is signed in as ${boundName}, but this link belongs to someone else.`
    : "This device is signed in as another player, but this link belongs to someone else.";

  const switchBtn = document.createElement("button");
  switchBtn.type = "button";
  switchBtn.textContent = "Switch to this link's account";

  // showStatus replaces statusEl's content, so the button is (re)appended
  // after every message — including after a failed switch, so the user can
  // simply try again instead of being left with a dead message. Re-rendering
  // detaches the button mid-interaction, which drops keyboard focus to
  // <body> — restoreFocus puts it back on the failure paths.
  function render(text, { isError = false, restoreFocus = false } = {}) {
    showStatus(statusEl, text, isError);
    switchBtn.disabled = false;
    switchBtn.textContent = "Switch to this link's account";
    statusEl.appendChild(document.createElement("br"));
    statusEl.appendChild(switchBtn);
    if (restoreFocus) switchBtn.focus();
  }

  switchBtn.addEventListener("click", async () => {
    switchBtn.disabled = true;
    switchBtn.textContent = "Switching…";
    try {
      const retry = await switchAccount(token);
      if (retry && !retry.conflict) {
        window.location.reload();
        return;
      }
      render(
        retry
          ? "This device is still linked to another player — ask the organizer for help."
          : "This link isn't valid anymore. Ask the organizer for a fresh one.",
        { isError: true, restoreFocus: true }
      );
    } catch (err) {
      render("Couldn't switch accounts. Check your connection and try again.", {
        isError: true,
        restoreFocus: true,
      });
    }
  });

  render(message);
}
