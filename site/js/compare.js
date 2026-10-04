// By country & role: aggregated statistics from the four open datasets plus every paper we extracted tables from.
// Three sub-views: ranking (dot plot + table), matrix (countries x measures heat table) and every population (traceable rows).
import { h, $, $$, fmtInt, fmtNum, fmtFixed, dataTable, toCSV, download, readHash, writeHash, toast, mixPercentiles } from "./util.js";
import { objects } from "./db.js";
import { dotplot } from "./charts.js";
import { bodyMap } from "./mannequin.js";

const SEX_COLOR = { M: "--s1", F: "--s2", both: "--s3" };
const SEX_LABEL = { M: "Men", F: "Women", both: "Mixed / not stated" };
const MATRIX_MEASURES = ["stature", "mass", "bmi", "sitting_height", "chest_circumference", "waist_circumference",
  "head_circumference", "hand_length", "foot_length", "buttock_knee_length"];

export async function initCompare() {
  const [measures, roll, papers] = await Promise.all([
    objects("SELECT * FROM measures ORDER BY sort"),
    objects("SELECT * FROM rollup"),
    objects("SELECT paper_id, title, open_copy_url, original_url, local_file, survey_id FROM papers"),
  ]);
  const M = Object.fromEntries(measures.map(m => [m.key, m]));
  const paperByFile = Object.fromEntries(papers.filter(p => p.local_file).map(p => [p.local_file, p]));
  const paperBySource = Object.fromEntries(papers.map(p => [p.paper_id, p]));
  // Labels for `other:` measures come from the data.
  const otherLabel = {};
  for (const r of roll) if (r.measure_key.startsWith("other:")) otherLabel[r.measure_key] = r.measure_label;
  const label = k => M[k]?.label || otherLabel[k] || k.replace(/^other:/, "").replace(/_/g, " ");
  const unitOf = k => M[k]?.unit || "mm";

  const fresh = () => ({ m: "stature", sex: "M", countries: [], roles: [], sub: "ranking", sort: "mean-desc", minN: 100, civilians: false, all: false, matrixRole: "", zoom: true, body: true, range: "pct" });
  let st = fresh();
  const { view, params } = readHash();
  if (view === "compare" && params.get("s")) { try { st = { ...fresh(), ...JSON.parse(params.get("s")) }; } catch { /* ignore */ } }
  const save = () => { if (readHash().view === "compare") writeHash("compare", new URLSearchParams({ s: JSON.stringify(st) })); };

  // measure choices: those with data, most widely covered first within category order
  const cover = {};
  for (const r of roll) (cover[r.measure_key] ||= new Set()).add(`${r.country}|${r.service_role}`);
  const measureKeys = Object.keys(cover).sort((a, b) => (M[a] ? 0 : 1) - (M[b] ? 0 : 1) || cover[b].size - cover[a].size || label(a).localeCompare(label(b)));
  const countries = [...new Set(roll.map(r => r.country))].sort();
  const roles = [...new Set(roll.map(r => r.service_role))].sort();
  const countCountry = Object.fromEntries(countries.map(c => [c, new Set(roll.filter(r => r.country === c).map(r => r.measure_key + r.sex + r.service_role)).size]));

  const root = $("#view-compare");
  root.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "By country & role"),
      h("p", {}, "Average body measurements of military populations, by country and role (service, aircrew, pilots, officers, recruits …). ",
        "Every number comes from a published survey. The ", h("b", {}, "ranking"), " and ", h("b", {}, "matrix"), " roll up the surveys for each country and role (weighted by sample size). ",
        "Switch to ", h("b", {}, "Every population"), " to see each source separately, with a link to the paper and page.")),
    h("div", { class: "layout" },
      h("aside", { class: "panel sidebar", id: "compare-sidebar", "aria-label": "Filters" },
        h("div", { class: "sidebar-head" }, h("h2", {}, "Filters"),
          h("div", {}, h("button", { class: "btn ghost small", id: "cmp-reset", type: "button" }, "Reset"),
            h("button", { class: "icon-btn only-mobile", "data-close-sidebar": "", type: "button", "aria-label": "Close" }, "✕"))),
        h("div", { id: "cmp-filters" })),
      h("div", { class: "panel", style: { minWidth: 0 } }, h("div", { class: "content-pad" },
        h("div", { class: "toolbar", style: { marginBottom: "6px" } },
          h("button", { class: "btn only-mobile", type: "button", "data-open-sidebar": "compare-sidebar" }, "☰ Filters"),
          h("div", { class: "result-count", id: "cmp-count", "aria-live": "polite" }), h("div", { class: "grow" }),
          h("button", { class: "btn", id: "cmp-body-toggle", type: "button", "aria-pressed": "true", title: "Show or hide the body map" }, "Body map: on"),
          h("button", { class: "btn", id: "cmp-share", type: "button" }, "🔗 Share"),
          h("button", { class: "btn", id: "cmp-export", type: "button" }, "⤓ CSV")),
        h("div", { class: "subtabs", role: "tablist", id: "cmp-subtabs" },
          [["ranking", "Ranking"], ["matrix", "Matrix"], ["detail", "Every population"]].map(([k, t]) =>
            h("button", { class: "subtab", role: "tab", "data-sub": k, "aria-selected": "false", onclick: () => { st.sub = k; render(); } }, t))),
        h("div", { id: "cmp-body" })))));

  let lastExport = null;

  function facetList(title, items, sel, onChange, open = true) {
    return h("details", { class: "facet", open },
      h("summary", {}, title + (sel.length ? ` (${sel.length})` : "")),
      h("div", { class: "facet-body" }, items.map(([v, n]) => {
        const id = `cmp-${title}-${v}`.replace(/\W+/g, "-");
        return h("label", { class: "check", for: id },
          h("input", { type: "checkbox", id, checked: sel.includes(v), onchange: e => { onChange(v, e.target.checked); } }),
          h("span", { class: "lbl", title: v }, v), h("span", { class: "n" }, n));
      })));
  }

  function renderFilters() {
    const f = $("#cmp-filters");
    const measureSel = h("select", { class: "input", "aria-label": "Measure", onchange: e => { st.m = e.target.value; render(); } },
      measureKeys.map(k => h("option", { value: k, selected: k === st.m }, `${label(k)}${M[k] ? "" : " (as published)"} [${cover[k].size}]`)));
    const inRoll = roll.filter(r => r.measure_key === st.m);
    const cCount = new Map(), rCount = new Map();
    for (const r of inRoll) { cCount.set(r.country, (cCount.get(r.country) || 0) + 1); rCount.set(r.service_role, (rCount.get(r.service_role) || 0) + 1); }
    f.replaceChildren(
      h("div", { class: "field" }, h("label", {}, "Measure"), measureSel,
        h("span", { class: "small muted" }, `Unit: ${unitOf(st.m)}. The number in brackets is how many country/role groups have it.`)),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Sex"),
        h("div", { class: "seg wrap", role: "group", "aria-label": "Sex" },
          [["M", "Men"], ["F", "Women"], ["both", "Mixed / not stated"], ["MF", "Men vs women"]].map(([v, t]) =>
            h("button", { type: "button", "aria-pressed": String(st.sex === v), onclick: () => { st.sex = v; render(); } }, t)))),
      facetList("Country", countries.filter(c => cCount.has(c) || st.countries.includes(c)).map(c => [c, cCount.get(c) || 0]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        st.countries, (v, on) => { st.countries = on ? [...st.countries, v] : st.countries.filter(x => x !== v); render(); }),
      facetList("Role", roles.filter(r => rCount.has(r) || st.roles.includes(r)).map(r => [r, rCount.get(r) || 0]).sort((a, b) => b[1] - a[1]),
        st.roles, (v, on) => { st.roles = on ? [...st.roles, v] : st.roles.filter(x => x !== v); render(); }),
      h("div", { class: "field", style: { marginTop: "8px" } }, h("label", { for: "cmp-minn" }, "Minimum people per group"),
        h("input", { class: "input", id: "cmp-minn", type: "number", min: 0, step: 50, value: st.minN, oninput: e => { st.minN = +e.target.value || 0; render(false); } })),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.civilians, onchange: e => { st.civilians = e.target.checked; render(); } }),
        h("span", { class: "lbl" }, "Include civilian reference samples"), h("span", { class: "n" }, "detail only")),
      h("p", { class: "small muted" }, "Roll-ups combine the surveys of one country and role. Surveys span 1940s–2020s, so a rolled-up mean mixes eras. Use ", h("i", {}, "Every population"), " to compare like with like."));
  }

  const passRoll = r => (!st.countries.length || st.countries.includes(r.country)) && (!st.roles.length || st.roles.includes(r.service_role)) && r.n_total >= st.minN;
  const sexes = () => (st.sex === "MF" ? ["M", "F"] : [st.sex]);

  // Mannequin card: the selected measure on a male / female body, with the n-weighted mean of the groups currently shown.
  function bodyCard(rows) {
    const figures = sexes().map(sx => {
      const rs = rows.filter(r => r.sex === sx && r.mean != null), w = r => r.n_total ?? r.n ?? 0, people = rs.reduce((a, r) => a + w(r), 0);
      const mean = !rs.length ? null : people ? rs.reduce((a, r) => a + r.mean * w(r), 0) / people : rs.reduce((a, r) => a + r.mean, 0) / rs.length;
      return { sex: sx, label: SEX_LABEL[sx], color: SEX_COLOR[sx], mean, people, groups: rs.length, pct: mixPercentiles(rs) };
    });
    if (!st.body) return null;
    return h("div", { class: "cmp-top-card" }, bodyMap({ key: st.m, label: label(st.m), unit: unitOf(st.m), figures, zoom: st.zoom, onZoom: () => { st.zoom = !st.zoom; render(false); } }));
  }
  const topClass = () => "cmp-top" + (!st.body ? " solo" : sexes().length > 1 ? " two" : "");

  function sortRows(rows) {
    const [k, d] = st.sort.split("-"), dir = d === "asc" ? 1 : -1;
    const get = { mean: r => r.mean, n: r => r.n_total, name: r => r.label, sd: r => r.sd, year: r => r.year_max }[k];
    return [...rows].sort((a, b) => (typeof get(a) === "string" ? get(a).localeCompare(get(b)) * dir : (get(a) - get(b)) * dir) || a.label.localeCompare(b.label));
  }

  const sortSelect = () => h("select", { class: "input", style: { width: "auto" }, "aria-label": "Sort", onchange: e => { st.sort = e.target.value; render(false); } },
    [["mean-desc", "Sort: highest mean first"], ["mean-asc", "Lowest mean first"], ["n-desc", "Largest sample first"], ["year-desc", "Newest survey first"], ["name-asc", "Name A–Z"]]
      .map(([v, t]) => h("option", { value: v, selected: v === st.sort }, t)));

  const rangeSelect = () => h("select", { class: "input", style: { width: "auto" }, "aria-label": "Range shown", onchange: e => { st.range = e.target.value; render(false); } },
    [["pct", "Range: 5th–95th percentile"], ["sd", "Range: ± 1 SD"]].map(([v, t]) => h("option", { value: v, selected: v === st.range }, t)));

  function rankingView() {
    const rows = sortRows(roll.filter(r => r.measure_key === st.m && sexes().includes(r.sex) && passRoll(r)).map(r => ({
      ...r, label: `${r.country} · ${r.service_role}${st.sex === "MF" ? ` (${r.sex})` : ""}`, color: SEX_COLOR[r.sex], n: r.n_total,
      extra: [["surveys", r.n_surveys], ["years", r.year_min === r.year_max ? r.year_min : `${r.year_min}–${r.year_max}`]],
    })));
    const basisOf = new Map(rows.map(r => [`${r.country}|${r.service_role}|${SEX_LABEL[r.sex]}`, r.pct_basis]));
    lastExport = () => toCSV(["country", "role", "sex", "measure", "unit", "people", "mean", "sd", "p5", "p50", "p95", "percentile_basis", "surveys", "mean_range_low", "mean_range_high", "first_year_min", "first_year_max", "sources"],
      rows.map(r => [r.country, r.service_role, r.sex, label(st.m), unitOf(st.m), r.n_total, r.mean, r.sd, r.p5, r.p50, r.p95, r.pct_basis, r.n_surveys, r.mean_min, r.mean_max, r.year_min, r.year_max, r.sources]));
    $("#cmp-count").replaceChildren(`${rows.length} group${rows.length === 1 ? "" : "s"} `, h("small", {}, `${label(st.m)} · ${sexes().map(s => SEX_LABEL[s]).join(" & ")}`));
    const shown = st.all ? rows : rows.slice(0, 40);
    const legend = st.sex === "MF" ? h("div", { class: "legend" }, ["M", "F"].map(s => h("span", { class: "key" }, h("span", { class: "swatch-dot", style: { background: `var(${SEX_COLOR[s]})` } }), SEX_LABEL[s]))) : "";
    const table = dataTable({
      columns: ["Country", "Role", "Sex", "People", "Mean", "SD", "P5", "P50", "P95", "Surveys", "First year", "Sources"], numeric: new Set(["People", "Mean", "SD", "P5", "P50", "P95", "Surveys"]), pageSize: 50,
      rows: rows.map(r => [r.country, r.service_role, SEX_LABEL[r.sex], r.n_total, r.mean, r.sd || null, r.p5, r.p50, r.p95, r.n_surveys, r.year_min === r.year_max ? String(r.year_min) : `${r.year_min}–${r.year_max}`, r.sources]),
      wrap: new Set(["Sources"]),
      cellRender: (c, v, row) => {
        if (c === "People" || c === "Surveys") return fmtInt(v);
        if (c === "Mean" || c === "SD") return fmtFixed(v, 1);
        if (c === "P5" || c === "P50" || c === "P95") {
          if (v == null) return "—";
          const est = basisOf.get(`${row[0]}|${row[1]}|${row[2]}`) !== "reported";
          return est ? h("span", { title: "Estimated: not reported by every source, so taken from mean and SD (normal approximation) where missing" }, `≈ ${fmtFixed(v, 1)}`) : fmtFixed(v, 1);
        }
        return c === "Sources" ? sourceLinks(String(v)) : (v ?? "—");
      } });
    return h("div", {},
      h("div", { class: "toolbar" }, sortSelect(), rangeSelect(),
        h("span", { class: "muted small" }, `${st.range === "sd" ? "Dot = mean, line = ± 1 SD." : "Dot = mean, tick = median (P50), line = 5th to 95th percentile."} ${rows.length > 40 && !st.all ? "Showing the first 40." : ""}`),
        rows.length > 40 ? h("button", { class: "btn small", type: "button", onclick: () => { st.all = !st.all; render(false); } }, st.all ? "Show top 40" : `Show all ${rows.length}`) : null),
      h("div", { class: topClass() }, bodyCard(rows), h("div", { style: { minWidth: 0 } }, legend, dotplot(shown, { unit: unitOf(st.m), measure: label(st.m), range: st.range }))),
      h("h3", { style: { fontSize: ".95rem", margin: "16px 0 6px" } }, "Table"),
      h("p", { class: "small muted", style: { margin: "0 0 6px" } }, "P5, P50 and P95 are the 5th, 50th (median) and 95th percentiles. A group made of several surveys combines them as a mixture weighted by sample size. ≈ marks values that are not reported by every source and were estimated from the mean and SD (normal approximation)."),
      table);
  }

  function sourceLinks(text) {
    const box = h("span", {});
    text.split("; ").forEach((sid, i) => {
      const p = papers.find(x => x.survey_id === sid && x.open_copy_url) || paperBySource[sid];
      if (i) box.append("; ");
      box.append(p ? h("a", { href: p.open_copy_url, target: "_blank", rel: "noopener", title: p.title }, sid) : sid);
    });
    return box;
  }

  function matrixView() {
    const sex = st.sex === "MF" ? "M" : st.sex;
    const keys = MATRIX_MEASURES.filter(k => cover[k]);
    const data = new Map();
    for (const r of roll) {
      if (r.sex !== sex || !keys.includes(r.measure_key) || !passRoll(r)) continue;
      if (st.matrixRole && r.service_role !== st.matrixRole) continue;
      const id = `${r.country}|${r.service_role}`;
      if (!data.has(id)) data.set(id, { country: r.country, role: r.service_role, n: 0, vals: {} });
      const d = data.get(id); d.vals[r.measure_key] = r; d.n = Math.max(d.n, r.n_total);
    }
    const rows = [...data.values()].filter(d => Object.keys(d.vals).length >= 2).sort((a, b) => a.country.localeCompare(b.country) || a.role.localeCompare(b.role));
    const col = {};
    for (const k of keys) { const v = rows.map(r => r.vals[k]?.mean).filter(x => x != null).sort((a, b) => a - b); col[k] = v; }
    const rank = (k, v) => { const a = col[k]; if (a.length < 2) return .5; let i = 0; while (i < a.length && a[i] < v) i++; return i / (a.length - 1); };
    lastExport = () => toCSV(["country", "role", "sex", ...keys.map(k => `${label(k)} (${unitOf(k)})`)], rows.map(r => [r.country, r.role, sex, ...keys.map(k => r.vals[k]?.mean ?? "")]));
    $("#cmp-count").replaceChildren(`${rows.length} group${rows.length === 1 ? "" : "s"} `, h("small", {}, `${SEX_LABEL[sex]} · ${keys.length} measures`));
    const shade = t => `color-mix(in srgb, var(--accent) ${Math.round(8 + t * 42)}%, var(--surface))`;
    const roleSel = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Role", onchange: e => { st.matrixRole = e.target.value; render(false); } },
      h("option", { value: "" }, "All roles"), roles.map(r => h("option", { value: r, selected: r === st.matrixRole }, r)));
    return h("div", {},
      h("div", { class: "toolbar" }, roleSel, h("span", { class: "muted small" }, "Shading is each column's rank from lowest (light) to highest (dark). Women: use the sex switch on the left.")),
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Country"), h("th", {}, "Role"), h("th", { class: "num" }, "People"), keys.map(k => h("th", { class: "num" }, label(k), h("div", { class: "small muted", style: { fontWeight: 400 } }, unitOf(k)))))),
        h("tbody", {}, rows.map(r => h("tr", {}, h("td", {}, r.country), h("td", {}, r.role), h("td", { class: "num" }, fmtInt(r.n)),
          keys.map(k => { const v = r.vals[k]; return h("td", { class: "num", style: v ? { background: shade(rank(k, v.mean)) } : {}, title: v ? `${v.n_surveys} survey(s), n=${fmtInt(v.n_total)}${v.p5 != null ? `; P5 ${fmtNum(v.p5, 1)}, P50 ${fmtNum(v.p50, 1)}, P95 ${fmtNum(v.p95, 1)}` : ""}` : "not available" }, v ? fmtNum(v.mean, 1) : "—"); }))))))
        : h("div", { class: "empty" }, "No groups with two or more of these measures for this selection."));
  }

  async function detailView() {
    const civ = st.civilians ? "" : "AND population_type != 'civilian'";
    const sexClause = st.sex === "MF" ? "AND sex IN ('M','F')" : `AND sex = '${st.sex}'`;
    const data = await objects(`SELECT * FROM aggregates WHERE measure_key = ? AND is_primary = 1 ${sexClause} ${civ} ORDER BY country, service_role, year_start`, [st.m]);
    const rows = data.filter(r => (!st.countries.length || st.countries.includes(r.country)) && (!st.roles.length || st.roles.includes(r.service_role)) && (r.n || 0) >= st.minN);
    const cols = ["Country", "Role", "Population", "Sex", "Year", "People", "Mean", "SD", "P5", "P50", "P95", "Source", "Quality"];
    const qual = { computed: "Computed from raw data", A: "A: tables parsed and checked", B: "B: OCR, passed consistency checks", C: "C: read from a web article" };
    lastExport = () => toCSV(["country", "role", "population", "sex", "year", "people", "mean", "sd", "p5", "p50", "p95", "source_id", "source_file", "page", "quality", "notes"],
      rows.map(r => [r.country, r.service_role, r.population, r.sex, r.year_start, r.n, r.mean, r.sd, r.p5, r.p50, r.p95, r.source_id, r.source_file, r.page, r.origin, r.notes]));
    $("#cmp-count").replaceChildren(`${fmtInt(rows.length)} population${rows.length === 1 ? "" : "s"} `, h("small", {}, `${label(st.m)} · ${sexes().map(s => SEX_LABEL[s]).join(" & ")}`));
    return h("div", {},
      h("div", { class: topClass() }, bodyCard(rows),
        h("p", { class: "small muted", style: { marginTop: 0 } }, "One row per population in each source. Where a survey appears in several sources, the best one is shown (computed from raw data, then checked tables, then OCR). Source links open the paper; the page number is where the table is. The body map shows the n-weighted mean of the populations listed.")),
      dataTable({ columns: cols, numeric: new Set(["Year", "People", "Mean", "SD", "P5", "P50", "P95"]), pageSize: 50, wrap: new Set(["Population"]),
        rows: rows.map(r => [r.country, r.service_role, r.population, SEX_LABEL[r.sex], r.year_start, r.n, r.mean, r.sd, r.p5, r.p50, r.p95, [r.source_id, r.source_file, r.page], r.origin]),
        cellRender: (c, v) => {
          if (c === "Year") return v ?? "—";
          if (c === "People") return v == null ? "—" : fmtInt(v);
          if (["Mean", "SD", "P5", "P50", "P95"].includes(c)) return fmtFixed(v, 1);
          if (c === "Source") {
            const [sid, file, page] = v, p = paperByFile[file];
            const href = p ? `${p.open_copy_url}${page ? `#page=${page}` : ""}` : /^https?:/.test(file) ? file : file.startsWith("data/") ? file : null;
            return href ? h("a", { href, target: file.startsWith("data/") ? null : "_blank", rel: "noopener" }, page ? `${sid}, p. ${page}` : sid) : sid;
          }
          if (c === "Quality") return h("span", { class: "tag " + (v === "computed" || v === "A" ? "good" : v === "B" ? "warn" : ""), title: qual[v] }, v === "computed" ? "raw data" : v);
          return v ?? "—";
        } }));
  }

  async function render(withFilters = true) {
    if (withFilters) renderFilters();
    const bt = $("#cmp-body-toggle");
    bt.setAttribute("aria-pressed", String(st.body)); bt.textContent = st.body ? "Body map: on" : "Body map: off";
    $$("#cmp-subtabs .subtab").forEach(b => b.setAttribute("aria-selected", b.dataset.sub === st.sub));
    save();
    const body = $("#cmp-body");
    body.replaceChildren(st.sub === "ranking" ? rankingView() : st.sub === "matrix" ? matrixView() : await detailView());
  }

  $("#cmp-body-toggle").addEventListener("click", () => { st.body = !st.body; render(false); });
  $("#cmp-reset").addEventListener("click", () => { st = fresh(); render(); });
  $("#cmp-share").addEventListener("click", async () => { try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast("Copy the address bar to share"); } });
  $("#cmp-export").addEventListener("click", () => lastExport && download("country-role-aggregates.csv", lastExport()));
  await render();
  return { onShow() { const { view, params } = readHash(); if (view === "compare" && params.get("s")) { try { st = { ...fresh(), ...JSON.parse(params.get("s")) }; render(); } catch { /* ignore */ } } } };
}
