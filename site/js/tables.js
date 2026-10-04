// Tables: the sources whose tables were read into the repository, with how each was read and the values it contributed.
import { h, $, fmtInt, fmtNum, debounce, dataTable } from "./util.js";
import { objects } from "./db.js";

const HOW = { A: "Digital table, validated", B: "Scanned table (OCR), checked", C: "Web article text and tables", computed: "Computed from individual data" };
const SEX = { M: "men", F: "women", both: "mixed" };

export async function initTables() {
  const [sources, papers] = await Promise.all([
    objects(`SELECT source_id, MIN(population) AS population, MIN(origin) AS origin, GROUP_CONCAT(DISTINCT country) AS countries,
                    GROUP_CONCAT(DISTINCT sex) AS sexes, MIN(year_start) AS year, COUNT(*) AS n_values, COUNT(DISTINCT measure_key) AS n_measures, MIN(source_file) AS source_file
             FROM aggregates GROUP BY source_id ORDER BY n_values DESC`),
    objects("SELECT paper_id, title, local_file, open_copy_url FROM papers"),
  ]);
  const byFile = new Map(papers.filter(p => p.local_file).map(p => [p.local_file, p])), byId = new Map(papers.map(p => [p.paper_id, p]));
  const rows = sources.map(s => {
    const p = byFile.get(s.source_file) || byId.get(s.source_id);
    return { ...s, title: (p?.title || s.population || s.source_id).replace(/ \[original: .*\]$/, ""), url: p?.open_copy_url || "",
      countries: (s.countries || "").split(",").filter(Boolean).sort(), sexes: (s.sexes || "").split(",").filter(Boolean) };
  });
  const countries = [...new Set(rows.flatMap(r => r.countries))].sort();
  const root = $("#view-tables");
  const q = h("input", { class: "input", type: "search", placeholder: "Search title or country…", "aria-label": "Search sources", style: { maxWidth: "300px" } });
  const country = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Country" }, h("option", { value: "" }, "All countries"), countries.map(c => h("option", { value: c }, c)));
  const how = h("select", { class: "input", style: { width: "auto" }, "aria-label": "How it was read" }, h("option", { value: "" }, "Any method"), Object.entries(HOW).map(([v, t]) => h("option", { value: v }, t)));
  const box = h("div");
  const total = rows.reduce((a, r) => a + r.n_values, 0);
  root.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "Tables from the papers"),
      h("p", {}, `${rows.length} sources had their tables read into the database: ${fmtInt(total)} values in ${countries.length} countries, converted to millimetres, kilograms and years. `,
        "They feed ", h("a", { href: "#/compare" }, "By country & role"), ". Open a source to see the values it contributed.")),
    h("div", { class: "toolbar" }, q, country, how), box);

  function render() {
    const t = q.value.toLowerCase(), c = country.value, m = how.value;
    const list = rows.filter(r => (!t || `${r.title} ${r.countries.join(" ")}`.toLowerCase().includes(t)) && (!c || r.countries.includes(c)) && (!m || r.origin === m));
    box.replaceChildren(dataTable({
      columns: ["Source", "Countries", "Sexes", "From", "Values", "Measures", "How it was read"], numeric: new Set(["From", "Values", "Measures"]), pageSize: 50, wrap: new Set(["Source", "Countries"]),
      rows: list.map(r => [r, r.countries.join(", "), r.sexes.map(s => SEX[s] || s).join(", "), r.year, r.n_values, r.n_measures, HOW[r.origin] || r.origin]),
      cellRender: (col, v) => {
        if (col === "Source") {
          const det = h("details", {}, h("summary", { class: "small" }, "Show values"));
          let done = false;
          det.addEventListener("toggle", async () => {
            if (!det.open || done) return; done = true;
            const d = await objects("SELECT measure_label, sex, service_role, population, mean, sd, n FROM aggregates WHERE source_id = ? AND is_primary = 1 AND mean IS NOT NULL ORDER BY measure_label, sex LIMIT 400", [v.source_id]);
            det.append(v.n_values > 400 ? h("p", { class: "small muted" }, `Showing the first 400 of ${fmtInt(v.n_values)} values. Use the SQL console for the rest.`) : null, h("div", { class: "table-wrap", style: { maxHeight: "320px", overflow: "auto" } }, h("table", {},
              h("thead", {}, h("tr", {}, ["Measure", "Sex", "Group", "Mean", "SD", "n"].map(x => h("th", {}, x)))),
              h("tbody", {}, d.map(r => h("tr", {}, h("td", {}, r.measure_label), h("td", {}, SEX[r.sex] || r.sex), h("td", {}, r.service_role || r.population || ""),
                h("td", { class: "num" }, fmtNum(r.mean, 1)), h("td", { class: "num" }, r.sd == null ? "" : fmtNum(r.sd, 1)), h("td", { class: "num" }, r.n == null ? "" : fmtInt(r.n))))))));
          });
          return h("div", {}, v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.title) : v.title, det);
        }
        if (col === "Values" || col === "Measures") return fmtInt(v);
        return v ?? "—";
      } }));
  }
  q.addEventListener("input", debounce(render, 120));
  country.addEventListener("change", render);
  how.addEventListener("change", render);
  render();
}
