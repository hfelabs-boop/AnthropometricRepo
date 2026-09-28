// Explore: a point-and-click query builder over the harmonized `subjects` table.
// Every question is compiled to one SQL statement (shown in the SQL tab) and run in sql.js.
import { h, $, $$, fmtInt, fmtNum, fmtFixed, describe, debounce, dataTable, toCSV, download, readHash, writeHash, toast } from "./util.js";
import { query, objects } from "./db.js";
import { histogram, scatter } from "./charts.js";

const DS_COLOR = { ansur_1988: "--s1", ansur_ii_2012: "--s2", asran_2015: "--s3", usaf_1967: "--s4" };
const DS_SHORT = { ansur_1988: "ANSUR 1988", ansur_ii_2012: "ANSUR II 2012", asran_2015: "ASRAN 2015", usaf_1967: "USAF 1967" };
const SEX_LABEL = { M: "Men", F: "Women" };
const SEX_COLOR = { M: "--s1", F: "--s2" };
const DEFAULT_COLS = ["stature", "mass", "bmi", "age", "sitting_height"];

const PRESETS = [
  { label: "Tallest women (≥ 1,750 mm)", state: { sex: "F", conds: [{ m: "stature", min: "1750", max: "" }], cols: ["stature", "mass", "bmi", "sitting_height"], group: "dataset", sub: "records", sort: { key: "stature", dir: -1 } } },
  { label: "Men with BMI ≥ 30, by survey", state: { sex: "M", conds: [{ m: "bmi", min: "30", max: "" }], cols: ["bmi", "mass", "waist_circumference", "chest_circumference"], group: "dataset", sub: "summary" } },
  { label: "Has men's stature changed since 1967?", state: { sex: "M", conds: [], cols: ["stature", "mass", "bmi"], group: "dataset", sub: "histogram", hist: "stature" } },
  { label: "Cockpit fit: sitting height 850–950 mm, buttock–knee ≤ 650 mm", state: { conds: [{ m: "sitting_height", min: "850", max: "950" }, { m: "buttock_knee_length", min: "", max: "650" }], cols: ["sitting_height", "buttock_knee_length", "stature", "thumbtip_reach"], group: "dataset,sex", sub: "summary" } },
  { label: "Hand sizes for glove sizing", state: { conds: [], cols: ["hand_length", "hand_breadth", "hand_circumference"], group: "sex", sub: "scatter", sx: "hand_length", sy: "hand_breadth" } },
  { label: "Head circumference for helmets", state: { conds: [], cols: ["head_circumference", "head_length", "head_breadth"], group: "dataset,sex", sub: "histogram", hist: "head_circumference" } },
  { label: "Stature vs body mass", state: { conds: [], cols: ["stature", "mass", "bmi"], group: "sex", sub: "scatter", sx: "stature", sy: "mass" } },
  { label: "Left-handed soldiers in ANSUR II", state: { ds: ["ansur_ii_2012"], cats: { handedness: ["Left"] }, conds: [], cols: ["stature", "mass", "hand_length"], group: "sex", sub: "summary" } },
];

export async function initExplore() {
  const [measures, datasets, branchRows, handRows] = await Promise.all([
    objects("SELECT * FROM measures ORDER BY sort"),
    objects("SELECT * FROM datasets"),
    objects("SELECT branch AS v, COUNT(*) AS n FROM subjects WHERE branch IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"),
    objects("SELECT handedness AS v, COUNT(*) AS n FROM subjects WHERE handedness IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"),
  ]);
  const M = Object.fromEntries(measures.map(m => [m.key, m]));
  const dsIds = datasets.map(d => d.id);
  const total = datasets.reduce((a, d) => a + d.n_subjects, 0);
  const avail = (key, ds) => key === "bmi" ? !!(M.stature[`src_${ds}`] && M.mass[`src_${ds}`]) : !!M[key]?.[`src_${ds}`];
  const catDefs = { branch: branchRows, handedness: handRows };
  const BRANCH_COLOR = Object.fromEntries(branchRows.map((b, i) => [b.v, `--s${(i % 8) + 1}`]));

  const fresh = () => ({ ds: [...dsIds], sex: "", conds: [], cats: { branch: [], handedness: [] }, cols: [...DEFAULT_COLS],
    group: "dataset", sub: "summary", hist: "stature", sx: "stature", sy: "mass", sort: null });
  let st = fresh();
  let result = null;

  // ---- URL state
  function loadFromHash() {
    const { view, params } = readHash();
    if (view !== "explore") return;
    const enc = params.get("s");
    if (enc) { try { st = { ...fresh(), ...JSON.parse(enc) }; } catch { /* ignore malformed links */ } }
    const ds = params.get("ds");
    if (ds && dsIds.includes(ds)) { st = fresh(); st.ds = [ds]; }
    const m = params.get("m");
    if (m && M[m]) { st = fresh(); st.hist = m; st.sub = "histogram"; if (!st.cols.includes(m)) st.cols = [m, ...st.cols].slice(0, 6); }
    st.cats = { branch: [], handedness: [], ...(st.cats || {}) };
  }
  const saveHash = () => { if (readHash().view === "explore") writeHash("explore", new URLSearchParams({ s: JSON.stringify(st) })); };

  // ---- sidebar controls
  const measureOptions = (selected, { includeBlank = false } = {}) => {
    const cats = [...new Set(measures.map(m => m.category))];
    return [includeBlank ? h("option", { value: "" }, "—") : null, ...cats.map(c => h("optgroup", { label: c },
      measures.filter(m => m.category === c).map(m => h("option", { value: m.key, selected: m.key === selected }, `${m.label} (${m.unit})`))))];
  };

  function renderSidebar() {
    $("#ex-datasets").replaceChildren(...datasets.map(d => h("label", { class: "ds-item" },
      h("input", { type: "checkbox", checked: st.ds.includes(d.id), onchange: e => {
        st.ds = e.target.checked ? [...new Set([...st.ds, d.id])] : st.ds.filter(x => x !== d.id); renderSidebar(); run(); } }),
      h("span", { class: "sw", style: { background: `var(${DS_COLOR[d.id]})` }, "aria-hidden": "true" }),
      h("span", { class: "lbl" }, DS_SHORT[d.id] || d.name), h("span", { class: "n" }, fmtInt(d.n_subjects)))));
    $$("#ex-sex button").forEach(b => { b.setAttribute("aria-pressed", b.dataset.v === st.sex); b.onclick = () => { st.sex = b.dataset.v; renderSidebar(); run(); }; });

    $("#ex-conds").replaceChildren(...st.conds.map((c, i) => {
      const missing = st.ds.filter(ds => !avail(c.m, ds)).map(ds => DS_SHORT[ds]);
      const u = M[c.m]?.unit || "";
      return h("div", { class: "cond" },
        h("select", { class: "input", "aria-label": "Measure", onchange: e => { c.m = e.target.value; run(); renderSidebar(); } }, measureOptions(c.m)),
        h("button", { class: "icon-btn x", type: "button", "aria-label": "Remove condition", onclick: () => { st.conds.splice(i, 1); run(); renderSidebar(); } }, "✕"),
        h("div", { class: "range-row" },
          h("input", { class: "input", type: "number", step: "any", placeholder: `min ${u}`, value: c.min, "aria-label": "Minimum",
            oninput: debounce(e => { c.min = e.target.value; run(); }, 300) }),
          h("span", {}, "to"),
          h("input", { class: "input", type: "number", step: "any", placeholder: `max ${u}`, value: c.max, "aria-label": "Maximum",
            oninput: debounce(e => { c.max = e.target.value; run(); }, 300) })),
        missing.length ? h("div", { class: "small", style: { gridColumn: "1 / 3", color: "var(--warn)" } },
          `Not measured in ${missing.join(", ")}, so those people are excluded.`) : null);
    }));

    $("#ex-cats").replaceChildren(...Object.entries(catDefs).map(([k, rows]) => h("div", { class: "field" },
      h("span", { class: "field-label" }, k === "branch" ? "Branch" : "Handedness"),
      rows.map(r => {
        const id = `ex-${k}-${r.v}`.replace(/\W+/g, "-");
        return h("label", { class: "check", for: id },
          h("input", { type: "checkbox", id, checked: st.cats[k].includes(r.v), onchange: e => {
            st.cats[k] = e.target.checked ? [...st.cats[k], r.v] : st.cats[k].filter(x => x !== r.v); run(); } }),
          h("span", { class: "lbl" }, r.v), h("span", { class: "n" }, fmtInt(r.n)));
      }),
      k === "handedness" ? h("p", { class: "small muted", style: { margin: "2px 0 0" } }, "Recorded in ANSUR II and USAF 1967 only.") : null)));

    renderColumns();
    $("#ex-group").value = st.group;
  }

  function renderColumns() {
    const f = ($("#ex-col-filter").value || "").toLowerCase();
    const cats = [...new Set(measures.map(m => m.category))];
    $("#ex-columns").replaceChildren(...cats.flatMap(c => {
      const ms = measures.filter(m => m.category === c && (!f || m.label.toLowerCase().includes(f)));
      if (!ms.length) return [];
      return [h("div", { class: "cat" }, c), ...ms.map(m => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: st.cols.includes(m.key), onchange: e => {
          st.cols = e.target.checked ? [...st.cols, m.key] : st.cols.filter(x => x !== m.key); run(); } }),
        h("span", { class: "lbl" }, m.label), h("span", { class: "n" }, m.unit)))];
    }));
  }
  $("#ex-col-filter").addEventListener("input", renderColumns);
  $("#ex-group").addEventListener("change", e => { st.group = e.target.value; run(); });
  $("#ex-add-cond").addEventListener("click", () => {
    const used = new Set(st.conds.map(c => c.m));
    st.conds.push({ m: ["stature", "mass", "bmi", "age", "sitting_height"].find(k => !used.has(k)) || "stature", min: "", max: "" });
    renderSidebar(); run();
    $$("#ex-conds .cond").at(-1)?.querySelector("input")?.focus();
  });
  $("#explore-reset").addEventListener("click", () => { st = fresh(); renderSidebar(); run(); });
  $$("#ex-subtabs .subtab").forEach(b => b.addEventListener("click", () => { st.sub = b.dataset.sub; renderBody(); saveHash(); }));
  $("#ex-export").addEventListener("click", () => {
    if (!result) return;
    download("anthropometry-query.csv", toCSV(result.columns, result.rows));
  });
  $("#ex-copy-link").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast("Copy the address bar to share"); }
  });
  $("#presets").replaceChildren(h("span", { class: "small muted", style: { alignSelf: "center", marginRight: "4px" } }, "Try:"),
    ...PRESETS.map(p => h("button", { class: "preset", type: "button", onclick: () => {
      st = { ...fresh(), ...structuredClone(p.state) };
      st.cats = { branch: [], handedness: [], ...(st.cats || {}) };
      renderSidebar(); run();
    } }, p.label)));

  // ---- SQL compilation
  const num = v => (v === "" || v == null || Number.isNaN(+v) ? null : +v);
  const lit = v => `'${String(v).replace(/'/g, "''")}'`;
  function compile() {
    const need = [...new Set([...st.cols, ...st.conds.map(c => c.m), st.hist, st.sx, st.sy].filter(k => M[k]))];
    const where = [];
    const ds = st.ds.filter(d => dsIds.includes(d));
    where.push(ds.length ? `dataset IN (${ds.map(lit).join(", ")})` : "0 = 1");
    if (st.sex) where.push(`sex = ${lit(st.sex)}`);
    for (const c of st.conds) {
      if (!M[c.m]) continue;
      const lo = num(c.min), hi = num(c.max);
      if (lo != null && hi != null) where.push(`${c.m} BETWEEN ${lo} AND ${hi}`);
      else if (lo != null) where.push(`${c.m} >= ${lo}`);
      else if (hi != null) where.push(`${c.m} <= ${hi}`);
    }
    for (const [k, vals] of Object.entries(st.cats)) if (vals.length) where.push(`${k} IN (${vals.map(lit).join(", ")})`);
    const cols = ["dataset", "source_id", "sex", "branch", "handedness", ...need];
    return {
      need,
      sql: `SELECT ${cols.join(", ")}\nFROM subjects\nWHERE ${where.join("\n  AND ")}\nORDER BY dataset, subject_key;`,
    };
  }

  // ---- run + render
  let runSeq = 0;
  async function run() {
    saveHash();
    const seq = ++runSeq;
    const { sql, need } = compile();
    const body = $("#ex-body");
    body.style.opacity = result ? ".55" : "1";
    try {
      const r = await query(sql);
      if (seq !== runSeq) return;
      result = { ...r, sql, need };
    } catch (e) {
      body.replaceChildren(h("div", { class: "notice error" }, String(e.message || e)));
      return;
    } finally { body.style.opacity = "1"; }
    const byDs = {};
    for (const row of result.rows) byDs[row[0]] = (byDs[row[0]] || 0) + 1;
    $("#ex-count").replaceChildren(`${fmtInt(result.rows.length)} people `, h("small", {}, `of ${fmtInt(total)}` +
      (Object.keys(byDs).length > 1 ? " · " + Object.entries(byDs).map(([d, n]) => `${DS_SHORT[d]} ${fmtInt(n)}`).join(" · ") : "")));
    renderBody();
  }

  const colIndex = k => result.columns.indexOf(k);
  function groupsOf(rows) {
    const keys = st.group ? st.group.split(",") : [];
    const map = new Map();
    for (const r of rows) {
      const parts = keys.map(k => r[colIndex(k)] ?? "Not recorded");
      const id = parts.join("|");
      if (!map.has(id)) {
        const label = keys.length ? keys.map((k, i) => k === "dataset" ? DS_SHORT[parts[i]] : k === "sex" ? SEX_LABEL[parts[i]] : parts[i]).join(" · ") : "All selected";
        let color = "--s1", dashed = false;
        if (keys[0] === "dataset") { color = DS_COLOR[parts[0]]; dashed = parts[1] === "F"; }
        else if (keys[0] === "sex") color = SEX_COLOR[parts[0]] || "--s3";
        else if (keys[0] === "branch") color = BRANCH_COLOR[parts[0]] || "--s8";
        map.set(id, { id, label, color, dashed, order: parts, rows: [] });
      }
      map.get(id).rows.push(r);
    }
    const dsOrder = k => dsIds.indexOf(k);
    return [...map.values()].sort((a, b) => {
      for (let i = 0; i < a.order.length; i++) {
        const x = a.order[i], y = b.order[i];
        const c = keys[i] === "dataset" ? dsOrder(x) - dsOrder(y)
          : keys[i] === "sex" ? "MF".indexOf(x) - "MF".indexOf(y) : String(x).localeCompare(String(y));
        if (c) return c;
      }
      return 0;
    });
  }

  function renderBody() {
    $$("#ex-subtabs .subtab").forEach(b => b.setAttribute("aria-selected", b.dataset.sub === st.sub));
    const body = $("#ex-body");
    if (!result) return;
    if (!result.rows.length && st.sub !== "query") {
      body.replaceChildren(h("div", { class: "empty" }, h("p", {}, "Nobody matches this question."),
        h("p", { class: "small" }, "Widen a range, remove a condition, or add surveys. Some measures are not recorded in every survey.")));
      return;
    }
    const views = { summary: renderSummary, records: renderRecords, histogram: renderHistogram, scatter: renderScatter, query: renderQuery };
    body.replaceChildren(views[st.sub]());
  }

  function renderSummary() {
    const groups = groupsOf(result.rows);
    const cols = ["Measure", "Group", "n", "Mean", "SD", "Min", "P5", "P25", "Median", "P75", "P95", "Max"];
    const rows = [];
    for (const k of st.cols.filter(k => M[k])) {
      const i = colIndex(k);
      for (const g of groups) {
        const d = describe(g.rows.map(r => r[i]));
        if (!d.n) continue;
        rows.push([`${M[k].label} (${M[k].unit})`, g.label, d.n, d.mean, d.sd, d.min, d.p5, d.p25, d.p50, d.p75, d.p95, d.max]);
      }
    }
    if (!st.cols.length) return h("div", { class: "empty" }, "Pick at least one column to show in the sidebar.");
    return h("div", {},
      h("p", { class: "small muted", style: { marginTop: 0 } }, "Percentiles use linear interpolation. People missing a measure are left out of that measure's statistics, so n can differ between rows. Click a column header to sort."),
      dataTable({ columns: cols, rows, numeric: new Set(cols.slice(2)), pageSize: 200, wrap: new Set(["Measure"]),
        cellRender: (c, v) => c === "n" ? fmtInt(v) : c === "Group" ? h("span", { style: { whiteSpace: "nowrap" } }, v)
          : typeof v === "number" ? fmtFixed(v, 1) : v }));
  }

  function renderRecords() {
    const keep = ["dataset", "source_id", "sex", "branch", "handedness", ...st.cols.filter(k => M[k])];
    const idx = keep.map(colIndex);
    const labels = { dataset: "Survey", source_id: "Subject", sex: "Sex", branch: "Branch", handedness: "Hand",
      ...Object.fromEntries(st.cols.filter(k => M[k]).map(k => [k, `${M[k].label} (${M[k].unit})`])) };
    const rows = result.rows.map(r => idx.map(i => r[i]));
    const sortCol = st.sort ? keep.indexOf(st.sort.key) : -1;
    return h("div", {},
      dataTable({ columns: keep, labels, rows, numeric: new Set(st.cols), pageSize: 50,
        sort: sortCol >= 0 ? { col: sortCol, dir: st.sort.dir } : null,
        onSort: s => { st.sort = { key: keep[s.col], dir: s.dir }; saveHash(); },
        cellRender: (c, v) => c === "dataset" ? DS_SHORT[v] : c === "sex" ? SEX_LABEL[v] || v : typeof v === "number" ? fmtNum(v, 2) : (v ?? "—") }),
      h("p", { class: "small muted" }, "Showing the columns chosen in the sidebar. ⤓ CSV exports every matching row with all queried measures."));
  }

  function measureSelect(value, onchange, label) {
    return h("div", { class: "field" }, h("label", {}, label),
      h("select", { class: "input", onchange: e => { onchange(e.target.value); } }, measureOptions(value)));
  }

  function renderHistogram() {
    const k = st.hist, i = colIndex(k), groups = groupsOf(result.rows);
    const series = groups.map(g => ({ ...g, values: g.rows.map(r => r[i]).filter(v => v != null) }));
    const stats = series.filter(g => g.values.length).map(g => { const d = describe(g.values); return [g.label, d.n, d.mean, d.sd, d.p5, d.p50, d.p95]; });
    return h("div", {},
      h("div", { class: "chart-controls" }, measureSelect(k, v => { st.hist = v; run(); }, "Measure")),
      histogram(series, { xLabel: M[k].label, unit: M[k].unit }),
      h("p", { class: "small muted" }, st.group.includes("sex") && st.group.includes("dataset") ? "Solid lines are men, dashed lines are women. " : "",
        "Each line shows the percentage of its group in each bin, so groups of different sizes compare fairly. Hover or use the arrow keys for values."),
      dataTable({ columns: ["Group", "n", "Mean", "SD", "P5", "Median", "P95"], rows: stats, numeric: new Set(["n", "Mean", "SD", "P5", "Median", "P95"]),
        pageSize: 50, cellRender: (c, v) => c === "n" ? fmtInt(v) : typeof v === "number" ? fmtFixed(v, 1) : v }));
  }

  function renderScatter() {
    const xi = colIndex(st.sx), yi = colIndex(st.sy), si = colIndex("source_id"), groups = groupsOf(result.rows);
    const series = groups.map(g => ({ ...g, points: g.rows.filter(r => r[xi] != null && r[yi] != null).map(r => [r[xi], r[yi], r[si]]) }));
    const fit = series.filter(g => g.points.length > 2).map(g => {
      const n = g.points.length, mx = g.points.reduce((a, p) => a + p[0], 0) / n, my = g.points.reduce((a, p) => a + p[1], 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of g.points) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      const b = sxy / sxx, a = my - b * mx, r = sxy / Math.sqrt(sxx * syy);
      return [g.label, n, r, r * r, b, a];
    });
    return h("div", {},
      h("div", { class: "chart-controls" },
        measureSelect(st.sx, v => { st.sx = v; run(); }, "X axis"),
        measureSelect(st.sy, v => { st.sy = v; run(); }, "Y axis"),
        h("button", { class: "btn", type: "button", style: { alignSelf: "end" }, onclick: () => { [st.sx, st.sy] = [st.sy, st.sx]; run(); } }, "⇄ Swap")),
      scatter(series, { xLabel: M[st.sx].label, yLabel: M[st.sy].label, xUnit: M[st.sx].unit, yUnit: M[st.sy].unit }),
      h("h3", { style: { fontSize: ".95rem", margin: "14px 0 6px" } }, `Linear fit: ${M[st.sy].label} = a + b × ${M[st.sx].label}`),
      dataTable({ columns: ["Group", "n", "r", "r²", "b (slope)", "a (intercept)"], rows: fit,
        numeric: new Set(["n", "r", "r²", "b (slope)", "a (intercept)"]), pageSize: 50,
        cellRender: (c, v) => c === "n" ? fmtInt(v) : typeof v === "number" ? fmtFixed(v, c === "a (intercept)" ? 1 : 3) : v }));
  }

  function renderQuery() {
    return h("div", {},
      h("p", { class: "small muted", style: { marginTop: 0 } }, "This is the exact query behind the current results. Edit it freely in the SQL console."),
      h("pre", { class: "sql" }, result.sql),
      h("div", { class: "toolbar", style: { marginTop: "8px" } },
        h("a", { class: "btn primary", href: `#/sql?q=${encodeURIComponent(result.sql)}` }, "Open in SQL console →"),
        h("button", { class: "btn", type: "button", onclick: async () => {
          try { await navigator.clipboard.writeText(result.sql); toast("SQL copied"); } catch { toast("Select the text to copy"); } } }, "Copy SQL")));
  }

  loadFromHash();
  renderSidebar();
  await run();
  return {
    onShow() {
      const before = JSON.stringify(st);
      loadFromHash();
      if (JSON.stringify(st) !== before) { renderSidebar(); run(); } else saveHash();
    },
  };
}
