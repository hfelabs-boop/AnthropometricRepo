// Survey catalog: faceted filtering with live counts, sorting, cards/table views, URL state.
import { h, $, fmtInt, debounce, dataTable, toCSV, download, readHash, writeHash, compare } from "./util.js";

export const DATASET_OF_SURVEY = { "ansur-1988": "ansur_1988", "ansur-ii-2012": "ansur_ii_2012",
  "asran-2015": "asran_2015", "usaf-1967": "usaf_1967" };

const reportGroup = v => ({ "free": "Free", "open access journal": "Free", "paywalled": "Paywalled",
  "possibly paywalled": "Paywalled", "likely paywalled": "Paywalled", "restricted": "Restricted",
  "not found": "Not found online" }[v] || "Unconfirmed");
const licenceGroup = s => {
  const l = (s.licence || "").toLowerCase();
  if (l.includes("public") || l.includes("us government")) return "Public domain / US Gov";
  if (l.includes("cc by")) return "Creative Commons";
  if (l.includes("sae") || s.data_access === "commercial") return "Commercial";
  if (l.includes("restricted")) return "Restricted";
  return "Not stated";
};
const isPdf = u => /\.pdf($|\?)|\/pdfs?\/|\/download\//i.test(u);

function enrich(s) {
  const pdfs = (s.reports || []).filter(r => isPdf(r.url));
  return {
    ...s,
    _countries: (s.country || "Unknown").split(/;\s*/),
    _report: reportGroup(s.report_access),
    _licence: licenceGroup(s),
    _era: s.year_start ? `${Math.floor(s.year_start / 10) * 10}s` : "Unknown",
    _pdf: pdfs.length ? "Has a study PDF link" : "No PDF link",
    _data: s.data_access === "public" ? "Downloadable & in database" : ({ "not public": "Not public", commercial: "Commercial",
      restricted: "Restricted", "n/a": "Summary statistics only" }[s.data_access] || s.data_access),
    _text: [s.entry, s.id, s.country, s.service, ...(s.citations || []), s.notes, s.sample, s.dimensions,
      ...(s.reports || []).map(r => r.label)].join(" ").toLowerCase(),
  };
}

// Facet definitions: key, title, accessor (returns a value or array of values), initial visible count.
const FACETS = [
  { key: "data", title: "Individual-level data", get: s => s._data },
  { key: "report", title: "Study report access", get: s => s._report },
  { key: "pdf", title: "PDF availability", get: s => s._pdf },
  { key: "region", title: "Region", get: s => s.region },
  { key: "country", title: "Country", get: s => s._countries, show: 8 },
  { key: "service", title: "Service / population", get: s => s.service },
  { key: "sexes", title: "Sexes measured", get: s => ({ men: "Men only", women: "Women only", both: "Men and women", unknown: "Unknown" }[s.sexes]) },
  { key: "era", title: "Survey era", get: s => s._era, order: "alpha" },
  { key: "verification", title: "Verification", get: s => s.verification },
  { key: "licence", title: "Licence", get: s => s._licence },
];
const VER_RANK = { verified: 0, "partly verified": 1, "not verified": 2 };
const ACCESS_RANK = { public: 0, commercial: 1, "n/a": 2, restricted: 3, "not public": 4 };

const SORTS = {
  row: (a, b) => a.row - b.row,
  "year-desc": (a, b) => compare(a.year_start, b.year_start, -1) || a.row - b.row,
  "year-asc": (a, b) => compare(a.year_start, b.year_start, 1) || a.row - b.row,
  "n-desc": (a, b) => compare(a.n_total, b.n_total, -1) || a.row - b.row,
  name: (a, b) => a.entry.localeCompare(b.entry),
  verification: (a, b) => VER_RANK[a.verification] - VER_RANK[b.verification] || a.row - b.row,
  access: (a, b) => (ACCESS_RANK[a.data_access] ?? 9) - (ACCESS_RANK[b.data_access] ?? 9) || a.row - b.row,
};

export function initCatalog(catalog) {
  const surveys = catalog.surveys.map(enrich);
  const state = { q: "", sel: {}, sort: "row", view: "cards", nmin: "", y0: "", y1: "", expanded: new Set() };
  FACETS.forEach(f => { state.sel[f.key] = new Set(); });

  // ---- restore from URL
  const { params } = readHash();
  if (readHash().view === "catalog") {
    state.q = params.get("q") || "";
    state.sort = SORTS[params.get("sort")] ? params.get("sort") : "row";
    state.view = params.get("view") === "table" ? "table" : "cards";
    state.nmin = params.get("nmin") || ""; state.y0 = params.get("y0") || ""; state.y1 = params.get("y1") || "";
    FACETS.forEach(f => (params.get(f.key) || "").split("|").filter(Boolean).forEach(v => state.sel[f.key].add(v)));
  }

  // ---- stats strip
  const pub = surveys.filter(s => s.data_access === "public");
  $("#catalog-stats").replaceChildren(...[
    [surveys.length, "surveys catalogued"],
    [new Set(surveys.flatMap(s => s._countries)).size, "countries & groupings"],
    [surveys.filter(s => s._report === "Free").length, "with a free report"],
    [pub.length, "open datasets"],
    [pub.reduce((a, s) => a + (s.n_total || 0), 0), "people in the database"],
  ].map(([n, l]) => h("div", { class: "stat" }, h("b", {}, fmtInt(n)), h("span", {}, l))));

  const qInput = $("#catalog-q");
  qInput.value = state.q;
  qInput.addEventListener("input", debounce(() => { state.q = qInput.value; render(); }, 120));
  $("#catalog-sort").value = state.sort;
  $("#catalog-sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
  document.querySelectorAll("[data-catalog-view]").forEach(b => b.addEventListener("click", () => { state.view = b.dataset.catalogView; render(); }));
  $("#catalog-clear").addEventListener("click", () => {
    state.q = ""; qInput.value = ""; state.nmin = state.y0 = state.y1 = "";
    numbers.querySelectorAll("input").forEach(i => { i.value = ""; });
    FACETS.forEach(f => state.sel[f.key].clear());
    render();
  });
  $("#catalog-export").addEventListener("click", () => {
    const cols = ["row", "entry", "region", "country", "service", "sexes", "year_start", "n_total", "measured", "published",
      "sample", "dimensions", "data_access", "report_access", "licence", "verification", "citations", "report_urls", "notes"];
    const rows = filtered().map(s => cols.map(c => c === "citations" ? s.citations.join(" | ")
      : c === "report_urls" ? (s.reports || []).map(r => r.url).join(" | ") : s[c]));
    download("military-anthropometric-surveys.csv", toCSV(cols, rows));
  });

  function matches(s, skip) {
    if (state.q) {
      const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.every(t => s._text.includes(t))) return false;
    }
    if (state.nmin && !(s.n_total >= +state.nmin)) return false;
    if (state.y0 && !(s.year_start >= +state.y0)) return false;
    if (state.y1 && !(s.year_start <= +state.y1)) return false;
    for (const f of FACETS) {
      if (f.key === skip || !state.sel[f.key].size) continue;
      const v = [f.get(s)].flat();
      if (!v.some(x => state.sel[f.key].has(x))) return false;
    }
    return true;
  }
  const filtered = () => surveys.filter(s => matches(s)).sort(SORTS[state.sort]);

  // ---- facets (counts reflect all *other* active filters)
  const facetRoot = $("#catalog-facets");
  const showAll = new Set();
  const facetOpen = {};
  const topFacets = h("div"), bottomFacets = h("div");
  const numbers = h("details", { class: "facet", open: !!(state.nmin || state.y0 || state.y1) },
    h("summary", {}, "Year & sample size"),
    h("div", { class: "facet-body" },
      h("span", { class: "field-label" }, "First year of measuring"),
      h("div", { class: "range-row" },
        h("input", { class: "input", type: "number", placeholder: "from", value: state.y0, "aria-label": "From year",
          oninput: debounce(e => { state.y0 = e.target.value; render(); }, 250) }),
        h("span", {}, "–"),
        h("input", { class: "input", type: "number", placeholder: "to", value: state.y1, "aria-label": "To year",
          oninput: debounce(e => { state.y1 = e.target.value; render(); }, 250) })),
      h("span", { class: "field-label", style: { marginTop: "8px" } }, "Minimum sample size"),
      h("input", { class: "input", type: "number", min: 0, step: 100, placeholder: "e.g. 2000", value: state.nmin, "aria-label": "Minimum sample size",
        oninput: debounce(e => { state.nmin = e.target.value; render(); }, 250) }),
      h("p", { class: "small muted", style: { margin: "4px 0 0" } }, "Surveys with an unknown year or size are hidden when these are set.")));
  facetRoot.replaceChildren(topFacets, numbers, bottomFacets);
  function renderFacets() {
    const nodes = FACETS.map(f => {
      const counts = new Map();
      for (const s of surveys) for (const v of [f.get(s)].flat()) counts.set(v, (counts.get(v) || 0) + 0);
      for (const s of surveys) if (matches(s, f.key)) for (const v of [f.get(s)].flat()) counts.set(v, counts.get(v) + 1);
      let entries = [...counts];
      entries.sort(f.order === "alpha" ? (a, b) => (a[0] === "Unknown") - (b[0] === "Unknown") || a[0].localeCompare(b[0])
        : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const limit = showAll.has(f.key) ? Infinity : f.show || Infinity;
      const visible = entries.filter(([v], i) => i < limit || state.sel[f.key].has(v));
      const open = facetOpen[f.key] ?? (!["licence", "verification", "sexes", "era"].includes(f.key) || state.sel[f.key].size > 0);
      const d = h("details", { class: "facet", open, ontoggle: e => { facetOpen[f.key] = e.target.open; } },
        h("summary", {}, f.title + (state.sel[f.key].size ? ` (${state.sel[f.key].size})` : "")),
        h("div", { class: "facet-body" }, visible.map(([v, n]) => {
          const id = `f-${f.key}-${v}`.replace(/\W+/g, "-");
          const cb = h("input", { type: "checkbox", id, checked: state.sel[f.key].has(v),
            onchange: e => { e.target.checked ? state.sel[f.key].add(v) : state.sel[f.key].delete(v); render(); } });
          return h("label", { class: "check" + (n ? "" : " zero"), for: id }, cb, h("span", { class: "lbl", title: v }, v), h("span", { class: "n" }, n));
        }),
        entries.length > visible.length ? h("button", { class: "more-btn", type: "button", onclick: () => { showAll.add(f.key); renderFacets(); } }, `Show all ${entries.length}`) : null));
      return d;
    });
    topFacets.replaceChildren(...nodes.slice(0, 3));
    bottomFacets.replaceChildren(...nodes.slice(3));
  }

  function chips() {
    const list = [];
    if (state.q) list.push([`“${state.q}”`, () => { state.q = ""; qInput.value = ""; }]);
    FACETS.forEach(f => state.sel[f.key].forEach(v => list.push([`${f.title}: ${v}`, () => state.sel[f.key].delete(v)])));
    const clearNum = (k, i) => () => { state[k] = ""; numbers.querySelectorAll("input")[i].value = ""; };
    if (state.y0) list.push([`From ${state.y0}`, clearNum("y0", 0)]);
    if (state.y1) list.push([`To ${state.y1}`, clearNum("y1", 1)]);
    if (state.nmin) list.push([`n ≥ ${fmtInt(+state.nmin)}`, clearNum("nmin", 2)]);
    $("#catalog-chips").replaceChildren(...list.map(([label, off]) => h("span", { class: "chip" }, label,
      h("button", { type: "button", "aria-label": `Remove filter ${label}`, onclick: () => { off(); render(); } }, "×"))));
  }

  function tagsFor(s) {
    const dataCls = s.data_access === "public" ? "good" : s.data_access === "commercial" ? "warn" : "";
    const verCls = s.verification === "verified" ? "good" : s.verification === "partly verified" ? "warn" : "bad";
    return [
      h("span", { class: `tag ${dataCls}` }, s.data_access === "public" ? "● Open data" : `Data: ${s.data_access}`),
      h("span", { class: `tag ${s._report === "Free" ? "good" : ""}` }, `Report: ${s.report_access}`),
      h("span", { class: `tag ${verCls}` }, s.verification === "verified" ? "✓ verified" : s.verification === "partly verified" ? "◐ partly verified" : "○ not verified"),
      s.licence ? h("span", { class: "tag outline" }, s.licence) : null,
    ];
  }

  function card(s) {
    const facts = [["Measured", s.measured], ["Published", s.published], ["Sample", s.sample], ["Dimensions", s.dimensions]].filter(f => f[1]);
    const ds = DATASET_OF_SURVEY[s.id];
    const links = [...(s.reports || []).map(r => ({ ...r, kind: "Report" })), ...(s.data || []).map(d => ({ ...d, kind: "Data" }))];
    const open = state.expanded.has(s.id);
    return h("article", { class: "card" },
      h("div", { class: "card-head" },
        h("div", { class: "card-num", "aria-label": `Entry ${s.row}` }, s.row),
        h("div", { style: { minWidth: 0, flex: 1 } },
          h("h3", {}, s.entry),
          h("div", { class: "sub" }, [s.country, s.service, s.year_start ? `from ${s.year_start}` : null, s.n_total ? `n = ${fmtInt(s.n_total)}` : null].filter(Boolean).join(" · ")),
          h("div", { class: "tags" }, tagsFor(s)))),
      facts.length ? h("div", { class: "facts" }, facts.map(([k, v]) => h("div", {}, h("span", {}, k), v))) : null,
      h("details", { open, ontoggle: e => { e.target.open ? state.expanded.add(s.id) : state.expanded.delete(s.id); } },
        h("summary", {}, `Citations & ${links.length} link${links.length === 1 ? "" : "s"}`),
        s.citations.map(c => h("p", { class: "cite" }, c)),
        links.length ? h("ul", {}, links.map(l => {
          const href = l.url || l.local;
          return h("li", {}, h("span", { class: "tag outline" }, l.kind), " ", href ? h("a", { href, rel: "noopener", target: l.url ? "_blank" : null }, l.label) : l.label);
        })) : null,
        s.notes ? h("div", { class: "note" }, s.notes) : null),
      ds ? h("div", { class: "card-actions" },
        h("a", { class: "btn small primary", href: `#/explore?ds=${ds}` }, "Explore this data →"),
        h("a", { class: "btn small", href: `#/sql?q=${encodeURIComponent(`SELECT * FROM subjects WHERE dataset = '${ds}' LIMIT 100;`)}` }, "Query in SQL")) : null);
  }

  function table(list) {
    const cols = ["row", "entry", "country", "service", "year_start", "n_total", "data_access", "report_access", "verification"];
    const labels = { row: "#", entry: "Survey", country: "Country", service: "Service", year_start: "Year", n_total: "Sample",
      data_access: "Data", report_access: "Report", verification: "Verification" };
    return dataTable({ columns: cols, labels, rows: list.map(s => cols.map(c => s[c] ?? null)), numeric: new Set(["row", "year_start", "n_total"]),
      pageSize: 100, wrap: new Set(["entry"]),
      cellRender: (c, v, r) => c === "entry" ? h("a", { href: "#", onclick: e => {
        e.preventDefault(); state.view = "cards"; state.expanded.add(list.find(s => s.row === r[0]).id); render();
      } }, v) : c === "row" || c === "year_start" ? (v ?? "—") : typeof v === "number" ? fmtInt(v) : (v ?? "—") });
  }

  function render() {
    const list = filtered();
    $("#catalog-count").replaceChildren(`${list.length} survey${list.length === 1 ? "" : "s"} `, h("small", {}, `of ${surveys.length}`));
    document.querySelectorAll("[data-catalog-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.catalogView === state.view));
    const res = $("#catalog-results");
    if (!list.length) res.replaceChildren(h("div", { class: "empty" }, h("p", {}, "No surveys match these filters."),
      h("button", { class: "btn", type: "button", onclick: () => $("#catalog-clear").click() }, "Clear all filters")));
    else res.replaceChildren(state.view === "table" ? table(list) : h("div", { class: "cards" }, list.map(card)));
    renderFacets();
    chips();
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    FACETS.forEach(f => state.sel[f.key].size && p.set(f.key, [...state.sel[f.key]].join("|")));
    if (state.sort !== "row") p.set("sort", state.sort);
    if (state.view !== "cards") p.set("view", state.view);
    for (const k of ["nmin", "y0", "y1"]) if (state[k]) p.set(k, state[k]);
    if (readHash().view === "catalog") writeHash("catalog", p);
  }
  render();
}
