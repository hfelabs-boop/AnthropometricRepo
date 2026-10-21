import fs from "node:fs";
import * as anthro from "../../site/js/human/anthro.js";
import * as P from "../../site/js/human/panels/profile.js";
import { fitBody } from "../../site/js/human/fit.js";
const pop = JSON.parse(fs.readFileSync("public/api/v1/populations/united-states/army/F.json"));
let p = anthro.percentileProfile(pop, { percentile: 80, meanStature: true });
const body0 = fitBody(P.finalizeProfile(p), {});
const row = P.dimensionRows(body0, p).find((r) => r.id === "hand_length");
p = P.editDimension(p, row, 205, "mm");
const rows = P.dimensionRows(fitBody(p, {}), p);
for (const [kind, text] of [["json", anthro.profileToJSON(p)], ["csv", anthro.profileToCSV(p)]]) {
  const q = anthro.parseImport(text, `x.${kind}`);
  const diff = [];
  for (const [k, m] of Object.entries(p.measures)) { const n = q.measures[k]; if (!n) diff.push(`${k}: lost`); else if (Math.abs(n.value - m.value) > 1e-6 * Math.abs(m.value) + 1e-9) diff.push(`${k}: ${m.value} -> ${n.value}`); else if (n.status !== m.status) diff.push(`${k}: status ${m.status} -> ${n.status}`); }
  const b1 = fitBody(P.finalizeProfile(q), {}), b0 = fitBody(P.finalizeProfile(p), {});
  const dd = b0.dims.filter((d, i) => Math.abs(d.value - b1.dims[i].value) > 1e-6).map((d) => d.id);
  console.log(kind, "measure diffs:", diff.slice(0, 6), diff.length, "| dims differing after refit:", dd.slice(0, 8), "| sex", p.sex, q.sex, "| label", q.label, "| form", b0.form, b1.form);
}
