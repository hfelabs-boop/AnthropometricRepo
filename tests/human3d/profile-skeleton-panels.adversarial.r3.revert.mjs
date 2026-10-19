// Every row that shows "Revert" (row.edited with an editor): does revertDimension change anything? Does it leave other rows edited that were only edited through it?
import fs from "node:fs";
import * as P from "../../site/js/human/panels/profile.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
const pop = (c, r, s, pc = 50) => anthro.percentileProfile(JSON.parse(fs.readFileSync(`public/api/v1/populations/${c}/${r}/${s}.json`)), { percentile: pc, meanStature: true });
const bases = { usaM: pop("united-states", "army", "M"), usaF: pop("united-states", "army", "F", 80), manual: anthro.manualProfile({ sex: "M", stature: 1750, mass: 80 }) };
const dead = new Set(), partial = new Set();
for (const [bn, raw] of Object.entries(bases)) {
  const base = P.finalizeProfile(raw, {});
  const b0 = fitBody(base, { form: P.defaultForm(base) });
  const rows0 = P.dimensionRows(b0, base);
  for (const target of rows0.filter((r) => ["measure", "override"].includes(r.editability.kind) && !r.id.startsWith("ring_") && r.id !== "shoulder_protraction")) {
    let p1;
    try { p1 = P.editDimension(base, target, (target.kind === "kg" ? target.value : target.mm) * 1.03); } catch { continue; }
    const b1 = fitBody(p1, { form: P.defaultForm(p1), overrides: p1.overrides });
    const rows1 = P.dimensionRows(b1, p1);
    for (const row of rows1.filter((r) => r.edited && ["measure", "override"].includes(r.editability.kind))) {
      const p2 = P.revertDimension(p1, row);
      const same = P.countEdits(p2) === P.countEdits(p1) && JSON.stringify(p2.overrides ?? {}) === JSON.stringify(p1.overrides ?? {});
      if (same) dead.add(`${bn}: edited ${target.id} -> row ${row.id} shows Revert but revert changes nothing`);
      else if (P.countEdits(p2) > 0) partial.add(`${bn}: edited ${target.id}; Revert on ${row.id} leaves ${P.countEdits(p2)} edit(s)`);
    }
    // revert all always clears
    if (P.countEdits(P.revertAll(p1)) !== 0) dead.add(`revertAll leaves edits after ${target.id}`);
    // after revert on the TARGET row itself the profile must equal base (id and measures)
    const p3 = P.revertDimension(p1, rows1.find((r) => r.id === target.id));
    if (p3.id !== base.id) dead.add(`${bn}: revert on the edited row ${target.id} does not restore the profile id (${p3.id} vs ${base.id})`);
  }
}
console.log([...dead].join("\n") || "no dead revert buttons");
console.log([...partial].slice(0, 20).join("\n") || "no partial reverts");
