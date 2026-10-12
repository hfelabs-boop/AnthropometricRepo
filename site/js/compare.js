// By country & role: aggregated statistics from the four open datasets plus every paper we extracted tables from.
// Four sub-views: design values (P5/P50/P95 of one country and role: body charts and a table ready to paste into slides),
// ranking (dot plot + table), matrix (countries x measures heat table) and every population (traceable rows).
import { h, $, $$, fmtInt, fmtNum, fmtFixed, dataTable, toCSV, download, readHash, writeHash, toast, mixPercentiles, rowDist } from "./util.js";
import { objects } from "./db.js";
import { dotplot } from "./charts.js";
import { bodyMap, valueCard } from "./mannequin.js";
import { categoryOf, categoryOrder } from "./measurecat.js";

const SEX_COLOR = { M: "--s1", F: "--s2", both: "--s3" };
const SEX_LABEL = { M: "Men", F: "Women", both: "Mixed / not stated" };
const PCTS = [["p5", "P5"], ["p50", "P50"], ["p95", "P95"]];
const PCT_LABEL = Object.fromEntries(PCTS);
const REL = { high: "High", medium: "Medium", low: "Low" };
const REL_TAG = { high: "good", medium: "warn", low: "bad" };
const REL_OK = { high: ["high"], medium: ["high", "medium"], all: ["high", "medium", "low"] };
// Standard error of a normal sample's 5th or 95th percentile is about 2.107 SD / sqrt(n); times 1.96 for 95% confidence.
const PCT_CI = 1.96 * 2.107;
const MATRIX_MEASURES = ["stature", "mass", "bmi", "sitting_height", "chest_circumference", "waist_circumference",
  "head_circumference", "hand_length", "foot_length", "buttock_knee_length"];

export async function initCompare() {
  const [measures, roll, papers, surveys] = await Promise.all([
    objects("SELECT * FROM measures ORDER BY sort"),
    objects("SELECT * FROM rollup"),
    objects("SELECT paper_id, title, open_copy_url, original_url, local_file, survey_id FROM papers"),
    // One entry per survey population (subgroups of a survey left out), for picking a single survey in the design view.
    objects(`SELECT country, service_role, survey_group, MIN(population) AS population, MIN(year_start) AS year, MAX(n) AS n
      FROM aggregates WHERE is_primary = 1 AND population_type != 'civilian' AND survey_group NOT LIKE '%#sub%' AND mean IS NOT NULL
      GROUP BY country, service_role, survey_group`),
  ]);
  const M = Object.fromEntries(measures.map(m => [m.key, m]));
  const paperByFile = Object.fromEntries(papers.filter(p => p.local_file).map(p => [p.local_file, p]));
  const paperBySource = Object.fromEntries(papers.map(p => [p.paper_id, p]));
  // Labels for `other:` measures come from the data.
  const otherLabel = {};
  for (const r of roll) if (r.measure_key.startsWith("other:")) otherLabel[r.measure_key] = r.measure_label;
  const label = k => M[k]?.label || otherLabel[k] || k.replace(/^other:/, "").replace(/_/g, " ");
  const unitOf = k => M[k]?.unit || "mm";

  const fresh = () => ({ sub: "design", country: "United States", role: "Army", m: "stature", cat: "", pct: "p95", sex: "M", rel: "medium", scope: "category", survey: "",
    sort: "mean-desc", minN: 0, civilians: false, all: false, zoom: true, dzoom: false, body: true, range: "pct" });
  let st = fresh();
  const { view, params } = readHash();
  if (view === "compare" && params.get("s")) { try { st = { ...fresh(), ...JSON.parse(params.get("s")) }; } catch { /* ignore */ } }
  const save = () => { if (readHash().view === "compare") writeHash("compare", new URLSearchParams({ s: JSON.stringify(st) })); };

  // measure choices: those with data, most widely covered first within category order
  const cover = {};
  for (const r of roll) (cover[r.measure_key] ||= new Set()).add(`${r.country}|${r.service_role}`);
  const measureKeys = Object.keys(cover).sort((a, b) => (M[a] ? 0 : 1) - (M[b] ? 0 : 1) || cover[b].size - cover[a].size || label(a).localeCompare(label(b)));
  const catOf = k => categoryOf(k, M[k]?.category);
  const catNames = categoryOrder([...new Set(measureKeys.map(catOf))]);
  const catCount = Object.fromEntries(catNames.map(c => [c, measureKeys.filter(k => catOf(k) === c).length]));
  const searchText = k => `${label(k)} ${k.replace(/^other:/, "").replace(/_/g, " ")} ${catOf(k)}`.toLowerCase();
  const searchIndex = new Map(measureKeys.map(k => [k, searchText(k)]));
  let measureQuery = "";
  const countries = [...new Set(roll.map(r => r.country))].sort();
  const rolesOf = new Map();  // country -> Map(role -> Set(measure keys))
  for (const r of roll) {
    const byRole = rolesOf.get(r.country) || rolesOf.set(r.country, new Map()).get(r.country);
    (byRole.get(r.service_role) || byRole.set(r.service_role, new Set()).get(r.service_role)).add(r.measure_key);
  }
  const allRoles = new Map();
  for (const m of rolesOf.values()) for (const [role, ks] of m) { const a = allRoles.get(role) || allRoles.set(role, new Set()).get(role); ks.forEach(k => a.add(k)); }
  const relOK = r => REL_OK[st.rel].includes(r.reliability);
  const inScope = r => (!st.country || r.country === st.country) && (!st.role || r.service_role === st.role);
  const where = () => `${st.country || "All countries"} · ${st.role || "All roles"}`;
  const surveysOf = (c, role) => surveys.filter(x => x.country === c && x.service_role === role)
    .sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || (b.n ?? 0) - (a.n ?? 0) || a.population.localeCompare(b.population));
  const surveyName = x => `${x.population}${x.year ? ` (${x.year})` : ""}`;
  // Rows of the one survey chosen in the design view, shaped like roll-up rows (percentiles from the row's own distribution).
  const surveyCache = new Map();
  let surveyData = null;
  async function loadSurvey() {
    const key = `${st.country}|${st.role}|${st.survey}`;
    if (!surveyCache.has(key)) {
      const data = await objects("SELECT * FROM aggregates WHERE country = ? AND service_role = ? AND survey_group = ? AND is_primary = 1 AND mean IS NOT NULL", [st.country, st.role, st.survey]);
      const best = new Map();
      for (const r of data) { const k = `${r.measure_key}|${r.sex}`; if (!best.has(k) || (r.n || 0) > (best.get(k).n || 0)) best.set(k, r); }
      surveyCache.set(key, [...best.values()].map(r => {
        const d = rowDist(r);
        return { ...r, n_total: r.n, p5: d ? d.a : null, p50: d ? d.m : null, p95: d ? d.c : null, pct_basis: !d ? "" : d.reported ? "reported" : "estimated",
          sources: r.source_id, year_min: r.year_start, year_max: r.year_start, n_surveys: 1 };
      }));
    }
    return surveyCache.get(key);
  }

  const root = $("#view-compare");
  root.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "By country & role"),
      h("p", {}, "Body measurements of military populations, by country and role (army, air force, aircrew, pilots, recruits …). ",
        "Choose a country, a role and a measure: ", h("b", {}, "Design values"), " gives the 5th, 50th and 95th percentiles with body charts and a table ready to paste into slides. ",
        h("b", {}, "Ranking"), " and ", h("b", {}, "Matrix"), " compare groups; ", h("b", {}, "Every population"), " lists each source with a link to the paper and page.")),
    h("div", { class: "layout" },
      h("aside", { class: "panel sidebar", id: "compare-sidebar", "aria-label": "Filters" },
        h("div", { class: "sidebar-head" }, h("h2", {}, "Filters"),
          h("div", {}, h("button", { class: "btn ghost small", id: "cmp-reset", type: "button" }, "Reset"),
            h("button", { class: "icon-btn only-mobile", "data-close-sidebar": "", type: "button", "aria-label": "Close" }, "✕"))),
        h("div", { id: "cmp-filters" })),
      h("div", { class: "panel", style: { minWidth: 0 } }, h("div", { class: "content-pad" },
        h("div", { class: "cmp-title" }, h("span", { class: "small muted" }, "Survey population"), h("h2", { id: "cmp-title" })),
        h("div", { class: "toolbar", style: { marginBottom: "6px" } },
          h("button", { class: "btn only-mobile", type: "button", "data-open-sidebar": "compare-sidebar" }, "☰ Filters"),
          h("div", { class: "result-count", id: "cmp-count", "aria-live": "polite" }), h("div", { class: "grow" }),
          h("button", { class: "btn", id: "cmp-body-toggle", type: "button", "aria-pressed": "true", title: "Show or hide the body map" }, "Body map: on"),
          h("button", { class: "btn", id: "cmp-share", type: "button" }, "🔗 Share"),
          h("button", { class: "btn", id: "cmp-export", type: "button" }, "⤓ CSV")),
        h("div", { class: "subtabs", role: "tablist", id: "cmp-subtabs" },
          [["design", "Design values"], ["ranking", "Ranking"], ["matrix", "Matrix"], ["detail", "Every population"]].map(([k, t]) =>
            h("button", { class: "subtab", role: "tab", "data-sub": k, "aria-selected": "false", onclick: () => { st.sub = k; render(); } }, t))),
        h("div", { id: "cmp-body" })))));

  let lastExport = null;

  // Measure picker: pick a category, type to search any word of the name, then click a result. Enter takes the top match.
  function measurePicker() {
    const MAX = 300;
    let active = 0, shown = [];
    // Measures with data for the chosen country and role (and the reliability filter): groups and sexes per measure.
    const scoped = new Map();
    for (const r of surveyData || roll) {
      if ((!surveyData && !inScope(r)) || !relOK(r)) continue;
      const e = scoped.get(r.measure_key) || scoped.set(r.measure_key, { groups: new Set(), sexes: new Set() }).get(r.measure_key);
      e.groups.add(`${r.country}|${r.service_role}`); e.sexes.add(r.sex);
    }
    const one = st.country && st.role;
    const badge = k => { const e = scoped.get(k); return one ? ["M", "F", "both"].filter(x => e.sexes.has(x)).map(x => ({ M: "M", F: "F", both: "mixed" }[x])).join(" ") : e.groups.size; };
    const keys = measureKeys.filter(k => scoped.has(k));
    const input = h("input", { class: "input", type: "search", placeholder: `Search ${keys.length} measures…`, "aria-label": "Search measures",
      autocomplete: "off", value: measureQuery });
    const catSel = h("select", { class: "input", "aria-label": "Measure category" },
      h("option", { value: "" }, `All categories (${keys.length})`),
      catNames.map(c => [c, keys.filter(k => catOf(k) === c).length]).filter(([, n]) => n).map(([c, n]) => h("option", { value: c, selected: c === st.cat }, `${c} (${n})`)));
    const list = h("div", { class: "mpick-list", role: "listbox", "aria-label": "Measures" });
    const count = h("div", { class: "small muted", "aria-live": "polite" });
    const pick = k => { st.m = k; render(); };
    const refresh = () => {
      const terms = measureQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = keys.filter(k => (!st.cat || catOf(k) === st.cat) && terms.every(t => searchIndex.get(k).includes(t)));
      if (!st.cat) hits.sort((a, b) => catNames.indexOf(catOf(a)) - catNames.indexOf(catOf(b)));
      shown = hits.slice(0, MAX); active = Math.min(active, Math.max(0, shown.length - 1));
      count.textContent = `${hits.length === keys.length ? hits.length : `${hits.length} of ${keys.length}`} measures with data for ${$("#cmp-title")?.textContent || where()}${hits.length > MAX ? `, showing the first ${MAX}` : ""}`;
      const rows = [];
      shown.forEach((k, i) => {
        if (!st.cat && (i === 0 || catOf(shown[i - 1]) !== catOf(k))) rows.push(h("div", { class: "mpick-cat", role: "presentation" }, catOf(k)));
        rows.push(h("button", { type: "button", role: "option", class: "mpick-opt" + (i === active ? " active" : ""), "aria-selected": String(k === st.m), "data-k": k,
          title: `${label(k)} · ${unitOf(k)} · ${one ? `sexes: ${badge(k)}` : `${badge(k)} country/role groups`}`, onclick: () => pick(k) },
          h("span", { class: "mpick-name" }, label(k)), h("span", { class: "mpick-n" }, badge(k))));
      });
      list.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty small", style: { padding: "10px" } }, keys.length ? "No measure matches. Try one word, or choose All categories." : `No measures with data for ${where()} at this reliability level.`)]));
    };
    const move = d => {
      if (!shown.length) return;
      active = (active + d + shown.length) % shown.length;
      list.querySelectorAll(".mpick-opt").forEach((b, i) => b.classList.toggle("active", i === active));
      list.querySelectorAll(".mpick-opt")[active]?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => { measureQuery = input.value; active = 0; refresh(); });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active]); }
    });
    catSel.addEventListener("change", () => { st.cat = catSel.value; active = 0; save(); refresh(); });
    refresh();
    return h("div", { class: "field mpick" }, h("label", {}, "3. Measure"),
      h("div", { class: "mpick-sel" }, h("b", {}, label(st.m)), h("span", { class: "small muted" }, ` ${catOf(st.m)} · ${unitOf(st.m)}${M[st.m] ? "" : " · as published"}`),
        scoped.has(st.m) ? null : h("div", { class: "small", style: { color: "var(--warn)" } }, `No data for ${where()} at this reliability level. Pick another measure.`)),
      catSel, input, count, list,
      h("span", { class: "small muted" }, `Type any words of the name (waist, hand breadth, skinfold). ${one ? "The letters show which sexes have data." : "The number is how many country/role groups have the measure."}`));
  }

  const seg = (labelText, items, value, onPick, wrap = true) => h("div", { class: "field" }, h("span", { class: "field-label" }, labelText),
    h("div", { class: "seg" + (wrap ? " wrap" : ""), role: "group", "aria-label": labelText.replace(/^\d+\. /, "") },
      items.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(value === v), onclick: () => onPick(v) }, t))));

  function surveyField() {
    const list = surveysOf(st.country, st.role);
    if (list.length < 2) return list.length ? h("p", { class: "small muted", style: { margin: "-4px 0 10px" } }, `Survey: ${surveyName(list[0])}`) : null;
    return h("div", { class: "field" }, h("label", { for: "cmp-survey" }, "Survey"),
      h("select", { class: "input", id: "cmp-survey", onchange: e => { st.survey = e.target.value; render(); } },
        h("option", { value: "" }, `All ${list.length} surveys combined`),
        list.map(x => h("option", { value: x.survey_group, selected: x.survey_group === st.survey }, `${x.year ?? "year not given"} · ${x.population}${x.n ? ` (n ${fmtInt(x.n)})` : ""}`))),
      st.survey ? null : h("span", { class: "small muted" }, "Combined values pool surveys from different years. Pick one survey to use it on its own."));
  }

  function renderFilters() {
    const f = $("#cmp-filters");
    const roleMap = st.country ? rolesOf.get(st.country) || new Map() : allRoles;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const design = st.sub === "design";
    f.replaceChildren(
      h("div", { class: "field" }, h("label", { for: "cmp-country" }, "1. Country"),
        h("select", { class: "input", id: "cmp-country", onchange: e => { st.country = e.target.value; st.survey = ""; if (st.role && !(st.country ? rolesOf.get(st.country) : allRoles).has(st.role)) st.role = ""; render(); } },
          h("option", { value: "" }, `All countries (${countries.length})`),
          countries.map(c => h("option", { value: c, selected: c === st.country }, `${c} (${plural(rolesOf.get(c).size, "role")})`)))),
      h("div", { class: "field" }, h("label", { for: "cmp-role" }, "2. Role"),
        h("select", { class: "input", id: "cmp-role", onchange: e => { st.role = e.target.value; st.survey = ""; render(); } },
          h("option", { value: "" }, design && st.country ? "Choose a role…" : "All roles"),
          [...roleMap].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([r, ks]) => h("option", { value: r, selected: r === st.role }, `${r} (${plural(ks.size, "measure")})`)))),
      design && st.country && st.role ? surveyField() : null,
      measurePicker(),
      design ? seg("4. Percentile", PCTS, st.pct, v => { st.pct = v; render(); }, false) : null,
      seg(design ? "5. Sex" : "4. Sex", [["M", "Men"], ["F", "Women"], ["both", "Mixed / not stated"], ["MF", "Men and women"]], st.sex, v => { st.sex = v; render(); }),
      h("div", { class: "field" }, h("label", { for: "cmp-rel" }, "Reliability"),
        h("select", { class: "input", id: "cmp-rel", onchange: e => { st.rel = e.target.value; render(); } },
          [["high", "High only"], ["medium", "High and medium"], ["all", "All, including low"]].map(([v, t]) => h("option", { value: v, selected: v === st.rel }, t))),
        h("details", { class: "small muted" }, h("summary", {}, "What the levels mean"),
          h("p", { style: { margin: "4px 0" } }, h("b", {}, "High: "), "every source is raw data, a checked digital table or an official defence document; the percentiles are reported by the source; 100 people or more."),
          h("p", { style: { margin: "4px 0" } }, h("b", {}, "Medium: "), "OCR of a published paper, percentiles estimated from the mean and SD (marked ≈), or 30 to 99 people."),
          h("p", { style: { margin: "4px 0" } }, h("b", {}, "Low: "), "values read from a web article without the consistency checks, fewer than 30 people, or no percentiles and no SD. Check the source before using them."))),
      h("details", { class: "facet" }, h("summary", {}, "More filters"),
        h("div", { class: "facet-body" },
          h("div", { class: "field" }, h("label", { for: "cmp-minn" }, "Minimum people per group"),
            h("input", { class: "input", id: "cmp-minn", type: "number", min: 0, step: 50, value: st.minN, oninput: e => { st.minN = +e.target.value || 0; render(false); } })),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.civilians, onchange: e => { st.civilians = e.target.checked; render(); } }),
            h("span", { class: "lbl" }, "Include civilian reference samples"), h("span", { class: "n" }, "every population only")))),
      h("p", { class: "small muted" }, "Values for one country and role combine its surveys, weighted by sample size. Surveys span the 1940s to the 2020s; use ", h("i", {}, "Every population"), " to see each survey on its own."));
  }

  const passRoll = r => inScope(r) && r.n_total >= st.minN && relOK(r);
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

  // Reliability tag: "High" / "Medium" / "Low" with the reasons in the tooltip.
  const relTag = (grade, note) => {
    const k = Object.keys(REL).find(x => REL[x] === grade || x === grade);
    return k ? h("span", { class: `tag ${REL_TAG[k]}`, title: `${REL[k]} reliability${note ? `: ${note}` : ""}` }, REL[k]) : "—";
  };
  const clearScope = () => st.country || st.role ? h("button", { class: "btn small", type: "button", onclick: () => { st.country = ""; st.role = ""; render(); } }, `Showing ${where()} only · show all`) : null;

  function rankingView() {
    const rows = sortRows(roll.filter(r => r.measure_key === st.m && sexes().includes(r.sex) && passRoll(r)).map(r => ({
      ...r, label: `${r.country} · ${r.service_role}${st.sex === "MF" ? ` (${r.sex})` : ""}`, color: SEX_COLOR[r.sex], n: r.n_total,
      extra: [["surveys", r.n_surveys], ["years", r.year_min === r.year_max ? r.year_min : `${r.year_min}–${r.year_max}`]],
    })));
    const basisOf = new Map(rows.map(r => [`${r.country}|${r.service_role}|${SEX_LABEL[r.sex]}`, r.pct_basis]));
    lastExport = () => toCSV(["country", "role", "sex", "measure", "unit", "people", "mean", "sd", "p5", "p50", "p95", "percentile_basis", "reliability", "reliability_note", "official_documents", "official_share", "surveys", "mean_range_low", "mean_range_high", "first_year_min", "first_year_max", "sources"],
      rows.map(r => [r.country, r.service_role, r.sex, label(st.m), unitOf(st.m), r.n_total, r.mean, r.sd, r.p5, r.p50, r.p95, r.pct_basis, r.reliability, r.reliability_note, r.official_docs, r.official_share, r.n_surveys, r.mean_min, r.mean_max, r.year_min, r.year_max, r.sources]));
    $("#cmp-count").replaceChildren(`${rows.length} group${rows.length === 1 ? "" : "s"} `, h("small", {}, `${label(st.m)} · ${sexes().map(s => SEX_LABEL[s]).join(" & ")}`));
    const shown = st.all ? rows : rows.slice(0, 40);
    const legend = st.sex === "MF" ? h("div", { class: "legend" }, ["M", "F"].map(s => h("span", { class: "key" }, h("span", { class: "swatch-dot", style: { background: `var(${SEX_COLOR[s]})` } }), SEX_LABEL[s]))) : "";
    const table = dataTable({
      columns: ["Country", "Role", "Sex", "People", "Mean", "SD", "P5", "P50", "P95", "Reliability", "Official documents", "Surveys", "First year", "Sources"], numeric: new Set(["People", "Mean", "SD", "P5", "P50", "P95", "Surveys"]), pageSize: 50,
      rows: rows.map(r => [r.country, r.service_role, SEX_LABEL[r.sex], r.n_total, r.mean, r.sd || null, r.p5, r.p50, r.p95, `${REL[r.reliability]}|${r.reliability_note}`, r.official_docs ? r.official_docs + (r.official_share < 1 ? ` (${Math.round(r.official_share * 100)}%)` : "") : null, r.n_surveys, r.year_min === r.year_max ? String(r.year_min) : `${r.year_min}–${r.year_max}`, r.sources]),
      wrap: new Set(["Sources"]),
      cellRender: (c, v, row) => {
        if (c === "People" || c === "Surveys") return fmtInt(v);
        if (c === "Mean" || c === "SD") return fmtFixed(v, 1);
        if (c === "P5" || c === "P50" || c === "P95") {
          if (v == null) return "—";
          const est = basisOf.get(`${row[0]}|${row[1]}|${row[2]}`) !== "reported";
          return est ? h("span", { title: "Estimated: not reported by every source, so taken from mean and SD (normal approximation) where missing" }, `≈ ${fmtFixed(v, 1)}`) : fmtFixed(v, 1);
        }
        if (c === "Official documents") return v ? h("span", { title: "Official defence or standards document(s) the survey data come from. A percentage means only that share of the people comes from them; the rest comes from other sources." }, v) : "—";
        if (c === "Reliability") return relTag(...v.split("|"));
        return c === "Sources" ? sourceLinks(String(v)) : (v ?? "—");
      } });
    return h("div", {},
      h("div", { class: "toolbar" }, sortSelect(), rangeSelect(), clearScope(),
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
    return h("div", {},
      h("div", { class: "toolbar" }, clearScope(), h("span", { class: "muted small" }, "Mean of each group. Shading is each column's rank from lowest (light) to highest (dark). Women: use the sex switch on the left.")),
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
    const rows = data.filter(r => inScope(r) && (r.n || 0) >= st.minN && relOK(r));
    const officialInfo = new Map(rows.filter(r => r.official_doc).map(r => [r.official_doc, { body: r.official_body, basis: r.official_basis }]));
    const cols = ["Country", "Role", "Population", "Sex", "Year", "People", "Mean", "SD", "P5", "P50", "P95", "Source", "Official document", "Quality", "Reliability"];
    const qual = { computed: "Computed from raw data", A: "A: tables parsed and checked", B: "B: OCR, passed consistency checks", C: "C: read from a web article" };
    lastExport = () => toCSV(["country", "role", "population", "sex", "year", "people", "mean", "sd", "p5", "p50", "p95", "source_id", "source_file", "page", "official_document", "official_body", "official_basis", "quality", "reliability", "reliability_note", "notes"],
      rows.map(r => [r.country, r.service_role, r.population, r.sex, r.year_start, r.n, r.mean, r.sd, r.p5, r.p50, r.p95, r.source_id, r.source_file, r.page, r.official_doc, r.official_body, r.official_basis, r.origin, r.reliability, r.reliability_note, r.notes]));
    $("#cmp-count").replaceChildren(`${fmtInt(rows.length)} population${rows.length === 1 ? "" : "s"} `, h("small", {}, `${label(st.m)} · ${sexes().map(s => SEX_LABEL[s]).join(" & ")}`));
    return h("div", {},
      h("div", { class: "toolbar" }, clearScope()),
      h("div", { class: topClass() }, bodyCard(rows),
        h("p", { class: "small muted", style: { marginTop: 0 } }, "One row per population in each source. Where a survey appears in several sources, the best one is shown (computed from raw data, then checked tables, then OCR). Source links open the paper; the page number is where the table is. The body map shows the n-weighted mean of the populations listed.")),
      dataTable({ columns: cols, numeric: new Set(["Year", "People", "Mean", "SD", "P5", "P50", "P95"]), pageSize: 50, wrap: new Set(["Population"]),
        rows: rows.map(r => [r.country, r.service_role, r.population, SEX_LABEL[r.sex], r.year_start, r.n, r.mean, r.sd, r.p5, r.p50, r.p95, [r.source_id, r.source_file, r.page], r.official_doc || null, r.origin, `${REL[r.reliability]}|${r.reliability_note}`]),
        cellRender: (c, v) => {
          if (c === "Year") return v ?? "—";
          if (c === "People") return v == null ? "—" : fmtInt(v);
          if (["Mean", "SD", "P5", "P50", "P95"].includes(c)) return fmtFixed(v, 1);
          if (c === "Source") {
            const [sid, file, page] = v, p = paperByFile[file];
            const href = p ? `${p.open_copy_url}${page ? `#page=${page}` : ""}` : /^https?:/.test(file) ? file : file.startsWith("data/") ? file : null;
            return href ? h("a", { href, target: file.startsWith("data/") ? null : "_blank", rel: "noopener" }, page ? `${sid}, p. ${page}` : sid) : sid;
          }
          if (c === "Official document") { const o = officialInfo.get(v); return v ? h("span", { title: o ? `${o.body}. ${o.basis === "survey microdata" ? "Computed from this survey's public individual-level data" : "Values read from the document's tables"}.` : "" }, v) : "—"; }
          if (c === "Reliability") return relTag(...v.split("|"));
          if (c === "Quality") return h("span", { class: "tag " + (v === "computed" || v === "A" ? "good" : v === "B" ? "warn" : ""), title: qual[v] }, v === "computed" ? "raw data" : v);
          return v ?? "—";
        } }));
  }

  // Design values: P5 / P50 / P95 of one country and role. Two body charts (one percentile for men and women; the three
  // percentiles of one sex) and a table with only the percentiles, ready to paste into slides.
  const fmtD = (v, unit) => v == null ? "—" : unit === "mm" ? fmtInt(Math.round(v)) : fmtFixed(v, 1);
  const approx = r => r.pct_basis !== "reported";

  function chooser(text, items, onPick) {
    return h("div", { class: "cmp-choose" }, h("p", {}, text),
      h("div", { class: "cmp-choose-list" }, items.map(([v, sub]) => h("button", { class: "btn", type: "button", onclick: () => onPick(v) },
        h("b", {}, v), h("span", { class: "small muted" }, sub)))));
  }

  function designView() {
    lastExport = null;
    $("#cmp-count").replaceChildren();
    if (!st.country) {
      const rank = countries.map(c => [c, roll.filter(r => r.country === c && relOK(r)).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
      return chooser("Choose a country in the sidebar, or here:", rank.map(([c, n]) => [c, `${n} values`]), c => { st.country = c; st.role = ""; render(); });
    }
    if (!st.role) {
      const rs = [...(rolesOf.get(st.country) || [])].map(([role]) => {
        const g = roll.filter(r => r.country === st.country && r.service_role === role);
        return [role, g.filter(relOK).length, g.length ? Math.round(100 * g.filter(r => r.reliability === "high").length / g.length) : 0];
      }).sort((a, b) => b[1] - a[1]);
      return chooser(`Choose the role (survey population) for ${st.country}:`, rs.map(([role, n, hi]) => [role, `${n} values · ${hi}% high reliability`]), role => { st.role = role; render(); });
    }
    const grp = new Map((surveyData || roll.filter(r => r.country === st.country && r.service_role === st.role)).map(r => [`${r.measure_key}|${r.sex}`, r]));
    const get = (k, sx) => { const r = grp.get(`${k}|${sx}`); return r && relOK(r) ? r : null; };
    const unit = unitOf(st.m), name = label(st.m);

    // What the selected measure rests on: sources, people, reliability and how precise P5 / P95 are.
    const selRows = ["M", "F", "both"].map(sx => grp.get(`${st.m}|${sx}`)).filter(Boolean);
    const years = selRows.flatMap(r => [r.year_min, r.year_max]).filter(Boolean);
    const info = selRows.length ? h("div", { class: "cmp-design-info" },
      h("span", {}, h("b", {}, name), ` · ${unit}`),
      ...selRows.map(r => h("span", { class: "cmp-relitem" }, `${SEX_LABEL[r.sex]}: n ${r.n_total ? fmtInt(r.n_total) : "not given"} `, relTag(r.reliability, r.reliability_note),
        r.sd && r.n_total ? h("span", { class: "small muted", title: "95% confidence half-width of the 5th and 95th percentiles from the sample size (normal approximation)" }, ` P5/P95 ±${fmtD(PCT_CI * r.sd / Math.sqrt(r.n_total), unit)} ${unit}`) : null)),
      h("span", { class: "small muted" }, `Sources: ${[...new Set(selRows.flatMap(r => r.sources.split("; ")))].join("; ")}${years.length ? ` · measured ${Math.min(...years)}${Math.max(...years) !== Math.min(...years) ? `–${Math.max(...years)}` : ""}` : ""}`,
        !st.survey && Math.max(...selRows.map(r => r.n_surveys || 1)) > 1 ? ` · combines ${Math.max(...selRows.map(r => r.n_surveys || 1))} surveys; pick one in the sidebar to use it on its own` : ""))
      : h("div", { class: "notice" }, `No data for ${name} in ${where()}. Pick another measure in the sidebar.`);

    // Body charts.
    const fig = (id, sx, head, r, p) => ({ id, sex: sx, head, color: SEX_COLOR[sx], value: r ? r[p] : null, approx: r ? approx(r) : false,
      sub: r ? `${PCT_LABEL[p]}${r.n_total ? ` · n ${fmtInt(r.n_total)}` : ""}` : grp.get(`${st.m}|${sx}`) ? "Hidden: below the reliability filter" : "" });
    const aSexes = ["M", "F"].some(sx => grp.get(`${st.m}|${sx}`)) ? ["M", "F"] : ["both"];
    const cardSexes = st.sex === "MF" ? ["M", "F"] : [st.sex];
    const onZoom = () => { st.dzoom = !st.dzoom; render(false); };
    const cards = !st.body || !selRows.length ? null : h("div", { class: "cmp-design-cards" },
      h("div", { style: { flex: `${aSexes.length} 1 ${aSexes.length * 130}px`, minWidth: 0 } }, valueCard({ key: st.m, label: name, unit, zoom: st.dzoom, onZoom,
        title: `${PCT_LABEL[st.pct]} · ${aSexes.map(sx => SEX_LABEL[sx].toLowerCase()).join(" and ").replace(/^./, c => c.toUpperCase())}`,
        figures: aSexes.map(sx => fig(`a${sx}`, sx, SEX_LABEL[sx], get(st.m, sx), st.pct)) })),
      ...cardSexes.map(sx => h("div", { style: { flex: "3 1 390px", minWidth: 0 } }, valueCard({ key: st.m, label: name, unit, zoom: st.dzoom, onZoom,
        title: `${SEX_LABEL[sx]} · P5, P50 and P95`,
        figures: PCTS.map(([p, l]) => fig(`b${sx}${p}`, sx, `${l} ${SEX_LABEL[sx].toLowerCase()}`, get(st.m, sx), p)) }))));

    // Table: measure, unit and the percentiles only.
    const tSexes = st.sex === "MF" ? ["M", "F"] : [st.sex];
    const cat = catOf(st.m);
    const scopeKeys = st.scope === "measure" ? [st.m] : st.scope === "category" ? measureKeys.filter(k => catOf(k) === cat)
      : [...measureKeys].sort((a, b) => catNames.indexOf(catOf(a)) - catNames.indexOf(catOf(b)));
    const has = k => tSexes.some(sx => grp.has(`${k}|${sx}`));
    const rows = scopeKeys.filter(k => tSexes.some(sx => get(k, sx)));
    const hidden = scopeKeys.filter(k => has(k) && !rows.includes(k)).length;
    const catTotal = measureKeys.filter(k => catOf(k) === cat && has(k)).length, allTotal = measureKeys.filter(has).length;
    const cell = (r, p) => r && r[p] != null ? `${approx(r) ? "≈ " : ""}${fmtD(r[p], unitOf(r.measure_key))}` : "—";
    const head2 = tSexes.flatMap(sx => PCTS.map(([p, l]) => [sx, p, l]));
    const groupRows = st.scope === "all";
    const table = h("table", { class: "data dtable" },
      h("thead", {},
        h("tr", {}, h("th", { rowspan: 2 }, "Measure"), h("th", { rowspan: 2 }, "Unit"), tSexes.map(sx => h("th", { colspan: 3, class: "num grp" }, SEX_LABEL[sx]))),
        h("tr", {}, head2.map(([, p, l]) => h("th", { class: "num" + (p === st.pct ? " sel" : "") }, l)))),
      h("tbody", {}, rows.flatMap((k, i) => [
        groupRows && (i === 0 || catOf(rows[i - 1]) !== catOf(k)) ? h("tr", { class: "cat" }, h("td", { colspan: 2 + head2.length }, catOf(k))) : null,
        h("tr", { class: k === st.m ? "cur" : "" },
          h("td", {}, h("button", { type: "button", class: "linklike", title: "Show this measure on the body charts", onclick: () => { st.m = k; render(); } }, label(k))),
          h("td", {}, unitOf(k)),
          head2.map(([sx, p]) => h("td", { class: "num" + (p === st.pct ? " sel" : "") }, cell(get(k, sx), p))))]).filter(Boolean)));

    // Clipboard copy: a plain table (HTML for slides and documents, tab-separated text for spreadsheets).
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const css = 'style="border:1px solid #808080;padding:3pt 6pt;font-family:Arial,sans-serif;font-size:11pt"';
    const th = (t, extra = "") => `<th ${css}${extra}>${esc(t)}</th>`, td = (t, right) => `<td ${css.replace('"', `"text-align:${right ? "right" : "left"};`)}>${esc(t)}</td>`;
    const copyHTML = () => `<table style="border-collapse:collapse"><thead><tr>${th("Measure", ' rowspan="2"')}${th("Unit", ' rowspan="2"')}${tSexes.map(sx => th(SEX_LABEL[sx], ' colspan="3"')).join("")}</tr>`
      + `<tr>${head2.map(([, , l]) => th(l)).join("")}</tr></thead><tbody>`
      + rows.map(k => `<tr>${td(label(k))}${td(unitOf(k))}${head2.map(([sx, p]) => td(cell(get(k, sx), p), true)).join("")}</tr>`).join("") + "</tbody></table>";
    const copyText = () => [["Measure", "Unit", ...head2.map(([sx, , l]) => `${SEX_LABEL[sx]} ${l}`)], ...rows.map(k => [label(k), unitOf(k), ...head2.map(([sx, p]) => cell(get(k, sx), p))])]
      .map(r => r.join("\t")).join("\n");
    const copy = async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([copyHTML()], { type: "text/html" }), "text/plain": new Blob([copyText()], { type: "text/plain" }) })]);
        toast("Table copied. Paste it into PowerPoint, Word or Excel.");
      } catch {
        try { await navigator.clipboard.writeText(copyText()); toast("Table copied as text"); } catch { toast("Select the table and copy it"); }
      }
    };
    lastExport = () => toCSV(["measure", "unit", ...head2.map(([sx, , l]) => `${SEX_LABEL[sx]} ${l}`), "reliability", "sources"],
      rows.map(k => [label(k), unitOf(k), ...head2.map(([sx, p]) => get(k, sx)?.[p] ?? ""),
        tSexes.map(sx => get(k, sx)).filter(Boolean).map(r => `${SEX_LABEL[r.sex]}: ${REL[r.reliability]}`).join("; "),
        [...new Set(tSexes.map(sx => get(k, sx)).filter(Boolean).flatMap(r => r.sources.split("; ")))].join("; ")]));
    const sources = [...new Set(rows.flatMap(k => tSexes.map(sx => get(k, sx)).filter(Boolean).flatMap(r => r.sources.split("; "))))];
    $("#cmp-count").replaceChildren(`${rows.length} measure${rows.length === 1 ? "" : "s"} `, h("small", {}, `${where()} · ${tSexes.map(sx => SEX_LABEL[sx]).join(" & ")}`));

    return h("div", {},
      info, cards,
      h("div", { class: "toolbar", style: { margin: "16px 0 8px" } },
        h("h3", { style: { fontSize: ".95rem", margin: 0 } }, "Design table"),
        h("div", { class: "seg", role: "group", "aria-label": "Rows" },
          [["measure", "This measure"], ["category", `${cat} (${catTotal})`], ["all", `All measures (${allTotal})`]].map(([v, t]) =>
            h("button", { type: "button", "aria-pressed": String(st.scope === v), onclick: () => { st.scope = v; render(false); } }, t))),
        h("div", { class: "grow" }),
        h("button", { class: "btn primary", type: "button", disabled: !rows.length, onclick: copy, title: "Copy the table to paste into slides or a document" }, "Copy table")),
      rows.length ? h("div", { class: "table-wrap" }, table) : h("div", { class: "empty" }, `No ${st.scope === "measure" ? "values" : "measures"} for ${where()} at this reliability level.`),
      h("p", { class: "small muted", style: { margin: "8px 0 0" } },
        `P5, P50 and P95 are the 5th, 50th (median) and 95th percentiles${tSexes.length > 1 ? "" : ` of ${SEX_LABEL[tSexes[0]].toLowerCase()}`}. ≈ marks values estimated from the mean and SD (normal approximation). `,
        `Only ${st.rel === "high" ? "high" : st.rel === "medium" ? "high and medium" : "all"} reliability data are listed${hidden ? `; ${hidden} measure${hidden === 1 ? " is" : "s are"} hidden by the reliability filter` : ""}. `,
        sources.length ? `Sources: ${sources.join("; ")}.` : ""));
  }

  async function render(withFilters = true) {
    if (st.survey && !surveysOf(st.country, st.role).some(x => x.survey_group === st.survey)) st.survey = "";
    surveyData = st.sub === "design" && st.country && st.role && st.survey ? await loadSurvey() : null;
    const sv = surveyData && surveys.find(x => x.country === st.country && x.service_role === st.role && x.survey_group === st.survey);
    $("#cmp-title").textContent = where() + (sv ? ` · ${surveyName(sv)}` : "");
    if (withFilters) renderFilters();
    const bt = $("#cmp-body-toggle");
    bt.setAttribute("aria-pressed", String(st.body)); bt.textContent = st.body ? "Body map: on" : "Body map: off";
    $$("#cmp-subtabs .subtab").forEach(b => b.setAttribute("aria-selected", b.dataset.sub === st.sub));
    save();
    const body = $("#cmp-body");
    body.replaceChildren(st.sub === "design" ? designView() : st.sub === "ranking" ? rankingView() : st.sub === "matrix" ? matrixView() : await detailView());
  }

  $("#cmp-body-toggle").addEventListener("click", () => { st.body = !st.body; render(false); });
  $("#cmp-reset").addEventListener("click", () => { st = fresh(); measureQuery = ""; render(); });
  $("#cmp-share").addEventListener("click", async () => { try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast("Copy the address bar to share"); } });
  $("#cmp-export").addEventListener("click", () => lastExport && download("country-role-aggregates.csv", lastExport()));
  await render();
  return { onShow() { const { view, params } = readHash(); if (view === "compare" && params.get("s")) { try { st = { ...fresh(), ...JSON.parse(params.get("s")) }; render(); } catch { /* ignore */ } } } };
}
