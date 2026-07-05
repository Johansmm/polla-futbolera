// Shared page navigation: fills the <nav id="site-nav"> present on every
// token-gated page. Threading the token through every internal link happens
// in exactly one place here — each new link used to be a fresh chance to
// drop ?token= and dump the user on the missing-link error.
import { getTokenFromUrl } from "./token-gate.js";

const PAGES = [
  { file: "predict.html", label: "My predictions" },
  { file: "special.html", label: "Champion & top scorer" },
  { file: "standings.html", label: "Standings" },
];

const nav = document.getElementById("site-nav");
if (nav) {
  const token = getTokenFromUrl();
  // Static hosts serve pages at both "/predict.html" and "/predict" —
  // compare without the extension so both spellings mark the right chip.
  const currentPage = (window.location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");

  for (const { file, label } of PAGES) {
    if (file.replace(/\.html$/, "") === currentPage) {
      const here = document.createElement("span");
      here.className = "nav-chip is-current";
      here.setAttribute("aria-current", "page");
      here.textContent = label;
      nav.appendChild(here);
    } else if (token) {
      // Without a token there's nothing useful to link to — every page
      // would just show the same missing-link error.
      const link = document.createElement("a");
      link.className = "nav-chip";
      link.href = `${file}?token=${encodeURIComponent(token)}`;
      link.textContent = label;
      nav.appendChild(link);
    }
  }
}
