// Shared page navigation: fills the <nav id="site-nav"> present on every
// token-gated page. Threading the token through every internal link happens
// in exactly one place here — each new link used to be a fresh chance to
// drop ?token= and dump the user on the missing-link error.
import { getTokenFromUrl } from "./token-gate.js";

export const REPO_URL = "https://github.com/Johansmm/polla-futbolera";

const PAGES = [
  { file: "predict.html", label: "Predictions" },
  { file: "special.html", label: "Special picks" },
  { file: "standings.html", label: "Standings" },
];

const token = getTokenFromUrl();

const brand = document.getElementById("site-brand");
if (brand && token) {
  brand.href = `predict.html?token=${encodeURIComponent(token)}`;
}

const header = document.querySelector(".page-header");
if (header) {
  const ghLink = document.createElement("a");
  ghLink.className = "repo-badge";
  ghLink.href = REPO_URL;
  ghLink.target = "_blank";
  ghLink.rel = "noopener noreferrer";
  ghLink.setAttribute("aria-label", "GitHub repository");
  ghLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 98 96" aria-hidden="true"><path fill="currentColor" d="M49 1a49 49 0 0 0-15.5 95.5c2.5.5 3.4-1 3.4-2.3v-8.1c-13.7 3-16.6-6.6-16.6-6.6-2.2-5.7-5.5-7.2-5.5-7.2-4.5-3 .3-3 .3-3 5 .4 7.6 5.1 7.6 5.1 4.4 7.6 11.6 5.4 14.4 4.1.4-3.2 1.7-5.4 3.1-6.6-11-1.2-22.5-5.5-22.5-24.5 0-5.4 1.9-9.8 5.1-13.3-.5-1.3-2.2-6.3.5-13 0 0 4.1-1.3 13.4 5a46.7 46.7 0 0 1 24.4 0c9.3-6.4 13.4-5 13.4-5 2.7 6.8 1 11.8.5 13 3.2 3.5 5.1 7.9 5.1 13.3 0 19-11.6 23.2-22.6 24.4 1.8 1.5 3.3 4.6 3.3 9.3v13.8c0 1.3.9 2.8 3.4 2.3A49 49 0 0 0 49 1z"/></svg>`;
  (header.querySelector(".header-tools") ?? header).appendChild(ghLink);
}

const footer = document.getElementById("site-footer");
if (footer) {
  const link = document.createElement("a");
  link.href = `${REPO_URL}/issues/new`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Report an issue ↗";
  footer.appendChild(link);
}

const nav = document.getElementById("site-nav");
if (nav) {
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

// Token-gated cross-page links outside the primary navigation (for example
// the scoring-guide links) opt into the same credential-preserving behavior.
if (token) {
  for (const link of document.querySelectorAll("[data-token-link]")) {
    const target = link.dataset.tokenLink;
    const [file, hash = ""] = target.split("#");
    link.href = `${file}?token=${encodeURIComponent(token)}${hash ? `#${hash}` : ""}`;
  }
}
