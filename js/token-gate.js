import { signInWithToken, switchAccount } from "./auth.js";
import { showStatus } from "./ui.js";

export function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("token");
}

/**
 * Resolves the URL token into a user_id, rendering status/error/conflict
 * messages into statusEl as needed. Returns the resolved user_id on
 * success, or null if the caller should stop (the reason is already shown
 * to the user in statusEl).
 */
export async function resolveUserFromToken(statusEl) {
  const token = getTokenFromUrl();

  if (!token) {
    showStatus(statusEl, "Missing token in the link. Use the personal link the organizer sent you.", true);
    return null;
  }

  showStatus(statusEl, "Loading...");

  let result;
  try {
    result = await signInWithToken(token);
  } catch (err) {
    showStatus(statusEl, "Error signing in. Try reloading the page.", true);
    return null;
  }

  if (!result) {
    showStatus(statusEl, "Invalid or expired link. Ask the organizer for a new one.", true);
    return null;
  }

  if (result.conflict) {
    showStatus(statusEl, "This device is already linked to a different user.");
    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.textContent = "Not me, use my own link";
    switchBtn.addEventListener("click", async () => {
      const retry = await switchAccount(token);
      if (retry && !retry.conflict) {
        window.location.reload();
      }
    });
    statusEl.appendChild(document.createElement("br"));
    statusEl.appendChild(switchBtn);
    return null;
  }

  statusEl.hidden = true;
  return result.userId;
}
