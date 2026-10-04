// Entry point: routing between views, theme toggle, mobile sidebars, lazy database init.
import { h, $, $$, readHash } from "./util.js";
import { initCatalog } from "./catalog.js";
import { loadDB } from "./db.js";
import { renderAbout } from "./about.js";

const VIEWS = ["catalog", "explore", "compare", "sql", "measures", "tables", "papers", "about"];
const inits = {};      // view -> Promise<{onShow?}>
let catalogData = null, papersData = [];

// Views that need the database start it lazily, but the download begins right away in the background.
const lazy = {
  explore: () => import("./explore.js").then(m => m.initExplore()),
  sql: () => import("./sqlconsole.js").then(m => m.initSQL()),
  measures: () => import("./measures.js").then(m => m.initMeasures()),
  compare: () => import("./compare.js").then(m => m.initCompare()),
  tables: () => import("./tables.js").then(m => m.initTables()),
  papers: () => import("./papers.js").then(m => m.initPapers()),
};

function dbError(view, e) {
  const target = { explore: "#ex-body", sql: "#sql-results", measures: "#measures-table", tables: "#view-tables", compare: "#view-compare", papers: "#view-papers" }[view];
  $(target)?.replaceChildren(h("div", { class: "notice error" }, `Could not load the database: ${e.message || e}`),
    h("button", { class: "btn", type: "button", style: { marginTop: "8px" }, onclick: () => { delete inits[view]; route(); } }, "Retry"));
}

async function route() {
  const { view: raw } = readHash();
  const view = VIEWS.includes(raw) ? raw : "catalog";
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  $$(".tab").forEach(t => { if (t.dataset.view === view) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
  closeSidebars();
  document.title = `${{ catalog: "Survey catalog", explore: "Explore data", compare: "By country & role", sql: "SQL console", measures: "Measures", tables: "Tables", papers: "Papers", about: "About" }[view]} · Military Anthropometric Surveys`;
  if (view === "catalog" && !inits.catalog) inits.catalog = Promise.resolve(initCatalog(catalogData, papersData));
  if (view === "about" && !inits.about) inits.about = Promise.resolve(renderAbout($("#view-about")));
  if (lazy[view]) {
    if (!inits[view]) inits[view] = lazy[view]().catch(e => { delete inits[view]; dbError(view, e); });
    else (await inits[view])?.onShow?.();
  }
}

// ---- theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem("theme", t) : localStorage.removeItem("theme"); } catch { /* storage unavailable */ }
}
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(cur === "dark" ? "light" : "dark");
});

// ---- mobile sidebars
const scrim = $("#scrim");
function closeSidebars() { $$(".sidebar.open").forEach(s => s.classList.remove("open")); scrim.hidden = true; }
document.addEventListener("click", e => {
  const open = e.target.closest("[data-open-sidebar]");
  if (open) { $(`#${open.dataset.openSidebar}`).classList.add("open"); scrim.hidden = false; }
  if (e.target.closest("[data-close-sidebar]") || e.target === scrim) closeSidebars();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSidebars(); });

// ---- boot
(async () => {
  try {
    catalogData = await (await fetch("catalog/surveys.json")).json();
    papersData = await fetch("catalog/papers.json").then(r => r.ok ? r.json() : []).catch(() => []);
  } catch (e) {
    $("#catalog-results").replaceChildren(h("div", { class: "notice error" }, `Could not load the catalog: ${e.message}`));
  }
  window.addEventListener("hashchange", route);
  await route();
  loadDB().catch(() => { /* surfaced when a database view opens */ });
})();
