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
    showStatus(statusEl, "Falta el token en el enlace. Usa el enlace personal que te compartió el organizador.", true);
    return null;
  }

  showStatus(statusEl, "Cargando...");

  let result;
  try {
    result = await signInWithToken(token);
  } catch (err) {
    showStatus(statusEl, "Error al iniciar sesión. Intenta recargar la página.", true);
    return null;
  }

  if (!result) {
    showStatus(statusEl, "Enlace inválido o expirado. Pide un enlace nuevo al organizador.", true);
    return null;
  }

  if (result.conflict) {
    showStatus(statusEl, "Este dispositivo ya está vinculado a otro usuario.");
    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.textContent = "No soy yo, usar mi propio enlace";
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
