export function showStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
}
