// Measures dictionary: every harmonized measure, where it comes from, and quick stats per survey.
import { h, $, fmtNum, fmtInt, dataTable } from "./util.js";
import { objects } from "./db.js";

const DS = [["ansur_1988", "ANSUR 88"], ["ansur_ii_2012", "ANSUR II"], ["asran_2015", "ASRAN"], ["usaf_1967", "USAF 67"]];

export async function initMeasures() {
  const measures = await objects("SELECT * FROM measures ORDER BY sort");
  // Count and mean per measure, per sex, in one pass.
  const agg = measures.map(m => `COUNT(${m.key}) AS "${m.key}__n", AVG(${m.key}) AS "${m.key}__mean"`).join(", ");
  const bySex = Object.fromEntries((await objects(`SELECT sex, ${agg} FROM subjects GROUP BY sex`)).map(r => [r.sex, r]));
  const perDs = Object.fromEntries((await objects(`SELECT dataset, ${measures.map(m => `COUNT(${m.key}) AS "${m.key}"`).join(", ")} FROM subjects GROUP BY dataset`)).map(r => [r.dataset, r]));

  const catSel = $("#measures-cat");
  [...new Set(measures.map(m => m.category))].forEach(c => catSel.append(h("option", { value: c }, c)));
  const qIn = $("#measures-q");

  function render() {
    const q = qIn.value.toLowerCase(), cat = catSel.value;
    const list = measures.filter(m => (!cat || m.category === cat) && (!q || `${m.label} ${m.key} ${m.category}`.toLowerCase().includes(q)));
    const cols = ["Measure", "Category", "Unit", ...DS.map(d => d[1]), "People", "Mean (men)", "Mean (women)", "SQL column"];
    const rows = list.map(m => [m.label, m.category, m.unit, ...DS.map(([id]) => perDs[id]?.[m.key] || 0),
      (bySex.M?.[`${m.key}__n`] || 0) + (bySex.F?.[`${m.key}__n`] || 0), bySex.M?.[`${m.key}__mean`], bySex.F?.[`${m.key}__mean`], m.key]);
    const byLabel = Object.fromEntries(measures.map(m => [m.label, m]));
    $("#measures-table").replaceChildren(
      dataTable({ columns: cols, rows, numeric: new Set([...DS.map(d => d[1]), "People", "Mean (men)", "Mean (women)"]), pageSize: 100, wrap: new Set(["Measure"]),
        cellRender: (c, v, r) => {
          if (c === "Measure") {
            const m = byLabel[v];
            return h("span", {}, h("a", { href: `#/explore?m=${m.key}` }, v), m.note ? h("div", { class: "small muted" }, m.note) : null);
          }
          if (DS.some(d => d[1] === c)) return v ? h("span", { class: "avail yes", title: `${fmtInt(v)} people` }, `✓ ${fmtInt(v)}`) : h("span", { class: "avail no", "aria-label": "not measured" }, "—");
          if (c === "SQL column") return h("code", {}, v);
          if (c === "People") return fmtInt(v);
          return typeof v === "number" ? fmtNum(v, 1) : (v ?? "—");
        } }),
      h("p", { class: "small muted" }, "Survey columns show how many people have each measure. Click a measure to open its distribution in Explore data. Source column names for each survey are in the ", h("code", {}, "measures"), " table (SQL console)."));
  }
  qIn.addEventListener("input", render);
  catSel.addEventListener("change", render);
  render();
}
