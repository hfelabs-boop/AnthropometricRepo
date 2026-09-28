// SQL console: free-form SQLite queries with a schema browser, examples, sortable results and CSV export.
import { h, $, fmtInt, dataTable, toCSV, download, readHash, writeHash } from "./util.js";
import { exec, objects, query, databaseBytes } from "./db.js";

export const EXAMPLES = [
  ["Stature percentiles by survey & sex",
`-- Mean and spread of stature (mm) for each survey and sex
SELECT dataset, sex, COUNT(*) AS n,
       ROUND(AVG(stature)) AS mean_mm,
       MIN(stature) AS min_mm, MAX(stature) AS max_mm
FROM subjects
GROUP BY dataset, sex
ORDER BY dataset, sex;`],
  ["20 tallest people across all surveys",
`SELECT survey, sex, source_id, stature, mass, bmi
FROM people
ORDER BY stature DESC
LIMIT 20;`],
  ["BMI categories by survey (men)",
`SELECT dataset,
       CASE WHEN bmi < 18.5 THEN '1 underweight'
            WHEN bmi < 25 THEN '2 normal'
            WHEN bmi < 30 THEN '3 overweight'
            ELSE '4 obese' END AS bmi_class,
       COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY dataset), 1) AS pct
FROM subjects
WHERE sex = 'M' AND bmi IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;`],
  ["Which measures does each survey have?",
`SELECT key, label, unit,
       src_ansur_1988 IS NOT NULL AS ansur_1988,
       src_ansur_ii_2012 IS NOT NULL AS ansur_ii,
       src_asran_2015 IS NOT NULL AS asran,
       src_usaf_1967 IS NOT NULL AS usaf_1967
FROM measures ORDER BY sort;`],
  ["Cockpit accommodation (% fitting 3 limits)",
`-- Share of each group within example cockpit limits
SELECT dataset, sex, COUNT(*) AS n,
       ROUND(100.0 * AVG(sitting_height BETWEEN 850 AND 960
                     AND buttock_knee_length <= 660
                     AND thumbtip_reach >= 700), 1) AS pct_accommodated
FROM subjects
WHERE sitting_height IS NOT NULL AND buttock_knee_length IS NOT NULL AND thumbtip_reach IS NOT NULL
GROUP BY 1, 2;`],
  ["ANSUR II: original columns by branch",
`-- raw_* tables keep every original column, unchanged (weightkg is in hectograms)
SELECT Branch, Gender, COUNT(*) AS n,
       ROUND(AVG(stature)) AS stature_mm,
       ROUND(AVG(weightkg) / 10.0, 1) AS mass_kg
FROM raw_ansur_ii_2012
GROUP BY 1, 2 ORDER BY 1, 2;`],
  ["Surveys with free reports, newest first",
`SELECT row, entry, country, year_start, n_total, report_access
FROM surveys
WHERE report_access IN ('free', 'open access journal')
ORDER BY year_start DESC NULLS LAST;`],
  ["Report links for one survey",
`SELECT kind, label, COALESCE(url, local_path) AS link
FROM survey_links
WHERE survey_id = 'ansur-ii-2012';`],
];

export async function initSQL() {
  const editor = $("#sql-editor");
  const status = $("#sql-status");
  const out = $("#sql-results");
  let last = null;

  const fromHash = () => { const { view, params } = readHash(); return view === "sql" ? params.get("q") : null; };
  editor.value = fromHash() || EXAMPLES[0][1];

  $("#sql-examples").replaceChildren(...EXAMPLES.map(([label, sql]) => h("button", { type: "button", onclick: () => { editor.value = sql; run(); } }, label)));

  // Schema browser
  const tables = await objects("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  const counts = {};
  for (const t of tables) counts[t.name] = (await query(`SELECT COUNT(*) FROM "${t.name}"`)).rows[0][0];
  const insert = text => {
    const { selectionStart: a, selectionEnd: b, value } = editor;
    editor.value = value.slice(0, a) + text + value.slice(b);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = a + text.length;
  };
  $("#sql-schema").replaceChildren(...await Promise.all(tables.map(async t => {
    const cols = (await objects(`PRAGMA table_info("${t.name}")`)).map(c => c.name);
    const quoteIfNeeded = c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c}"`;
    return h("details", { open: t.name === "subjects" },
      h("summary", {}, t.name, " ", h("span", { class: "muted", style: { fontWeight: 400 } }, `${t.type === "view" ? "view · " : ""}${fmtInt(counts[t.name])} rows`)),
      h("ul", {}, h("li", {}, h("button", { type: "button", onclick: () => insert(`SELECT * FROM ${t.name} LIMIT 100;`) }, `SELECT * FROM ${t.name}…`)),
        cols.map(c => h("li", {}, h("button", { type: "button", title: `Insert ${c}`, onclick: () => insert(quoteIfNeeded(c)) }, c)))));
  })));

  async function run() {
    const sql = editor.value.trim();
    if (!sql) return;
    writeHash("sql", new URLSearchParams({ q: sql }));
    status.textContent = "Running…";
    const t0 = performance.now();
    try {
      const r = await exec(sql);
      const ms = Math.round(performance.now() - t0);
      last = r;
      $("#sql-export").disabled = !r.rows.length;
      status.textContent = `${fmtInt(r.rows.length)} row${r.rows.length === 1 ? "" : "s"} in ${ms} ms`;
      if (!r.columns.length) { out.replaceChildren(h("div", { class: "notice" }, "Statement ran. It returned no result set. Changes only affect your in-browser copy and are lost on reload.")); return; }
      const shown = r.rows.slice(0, 5000);
      const numeric = new Set(r.columns.filter((c, i) => shown.some(row => typeof row[i] === "number") && shown.every(row => row[i] == null || typeof row[i] === "number")));
      out.replaceChildren(
        r.rows.length > 5000 ? h("div", { class: "notice", style: { marginBottom: "8px" } }, `Showing the first 5,000 of ${fmtInt(r.rows.length)} rows. CSV export includes all rows.`) : "",
        dataTable({ columns: r.columns, rows: shown, numeric, pageSize: 100 }));
    } catch (e) {
      status.textContent = "Error";
      last = null;
      $("#sql-export").disabled = true;
      out.replaceChildren(h("div", { class: "notice error" }, String(e.message || e)));
    }
  }

  $("#sql-run").addEventListener("click", run);
  editor.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); insert("  "); }
  });
  $("#sql-export").addEventListener("click", () => last && download("query-result.csv", toCSV(last.columns, last.rows)));
  $("#db-download").addEventListener("click", async () => download("anthro.sqlite", new Blob([await databaseBytes()], { type: "application/vnd.sqlite3" })));

  await run();
  return {
    onShow() {
      const q = fromHash();
      if (q && q !== editor.value.trim()) { editor.value = q; run(); }
    },
  };
}
