// Perturb every editable dimension and compare the joints that move with JOINT_DIMS. node --import ./tests/human3d/register.mjs tests/human3d/profile-skeleton-panels.adversarial.mapping.mjs
import fs from "node:fs";
import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
const pop = (c, r, s, pc = 50) => anthro.percentileProfile(JSON.parse(fs.readFileSync(`public/api/v1/populations/${c}/${r}/${s}.json`)), { percentile: pc, meanStature: true });
const profs = { manualM: anthro.manualProfile({ sex: "M", stature: 1755, mass: 80 }), manualF: anthro.manualProfile({ sex: "F", stature: 1600, mass: 55 }), usaM: pop("united-states", "army", "M"), usaF: pop("united-states", "army", "F", 90) };
const under = new Map(), over = new Map();
for (const [pn, raw] of Object.entries(profs)) {
  const base = P.finalizeProfile(raw, {});
  const b0 = fitBody(base, { form: P.defaultForm(base) });
  const rows = P.dimensionRows(b0, base);
  for (const row of rows) {
    if (row.editability.kind !== "override" && row.editability.kind !== "measure") continue;
    if (row.id.startsWith("ring_") || row.id === "mass") continue;
    // perturb through the override channel regardless of kind (it exists for all but pure-derived)
    const mm = row.mm * 1.03;
    const prof = { ...base, overrides: { [row.id]: mm / 1000 } };
    let b1;
    try { b1 = fitBody(prof, { form: P.defaultForm(base), overrides: prof.overrides }); } catch (e) { console.log(pn, row.id, "fit threw", e.message); continue; }
    const d1 = b1.dims.find((d) => d.id === row.id).value;
    if (Math.abs(d1 - b0.dims.find((d) => d.id === row.id).value) < 1e-6) continue; // no effect (limited or undone)
    const moved = new Set();
    for (const j of JOINTS) {
      const o0 = b0.joints[j.id].offset, o1 = b1.joints[j.id].offset;
      if (Math.hypot(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]) > 1e-5) moved.add(j.id);
    }
    const claimed = new Set(S.dimensionJoints(row.id));
    for (const j of moved) if (!claimed.has(j)) { const k = `${row.id} -> ${j}`; under.set(k, (under.get(k) ?? 0) + 1); }
    // claimed as OWN dim (not "also") yet never moved
    for (const j of JOINTS) if (S.JOINT_DIMS[j.id].dims.includes(row.id) && !moved.has(j.id)) { const k = `${row.id} -> ${j.id} (primary)`; over.set(k, (over.get(k) ?? []).concat(pn)); }
  }
}
const byDim = new Map(); for (const k of under.keys()) { const [d, j] = k.split(" -> "); byDim.set(d, [...(byDim.get(d) ?? []), j]); }
for (const [d, js] of byDim) console.log("UNDER", d, "->", js.filter((j) => !/^(thumb|index|middle|ring|little)_/.test(j)).join(","), js.some((j) => /^(thumb|index|middle|ring|little)_/.test(j)) ? "+ finger joints" : "");
console.log("OVER-CLAIMED primary (listed as setting it but does not move):", [...over].map(([k, v]) => `${k} [${[...new Set(v)]}]`).join("; ") || "none");
