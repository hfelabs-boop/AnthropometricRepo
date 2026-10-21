// Round 2: every editable row of many profiles: edit +/-4 %, build with the SAME call the shell would make once it passes overrides; the value must come out as typed (or be explained).
// node --import ./tests/human3d/register.mjs tests/human3d/profile-skeleton-panels.adversarial.r2.editsweep.mjs
import fs from "node:fs";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import * as P from "../../site/js/human/panels/profile.js";
const idx = JSON.parse(fs.readFileSync("public/api/v1/index.json"));
const pops = idx.populations.filter((_, i) => i % 9 === 0);
const profs = [["manual", anthro.manualProfile({ sex: "M", stature: 1755 })], ["manualF", anthro.manualProfile({ sex: "F", stature: 1550, mass: 52 })], ["manual-both-tall", anthro.manualProfile({ sex: "both", stature: 2100, mass: 140 })]];
for (const e of pops) { try { profs.push([`${e.country_id}/${e.role_id}/${e.sex}`, anthro.percentileProfile(JSON.parse(fs.readFileSync(`public/api/v1/populations/${e.country_id}/${e.role_id}/${e.sex}.json`)), { percentile: e.sex === "F" ? 90 : 10, meanStature: true })]); } catch {} }
const fit = (p) => fitBody(p, { form: p.form ?? P.defaultForm(p), overrides: p.overrides });
const problems = new Map(); const note = (k, m) => { const a = problems.get(k) ?? []; if (a.length < 4) a.push(m); problems.set(k, a); };
let n = 0, t0 = Date.now();
for (const [name, raw] of profs) {
  const base = P.finalizeProfile(raw, {}); let b0; try { b0 = fit(base); } catch (err) { note("fit0-throws", `${name}: ${err.message}`); continue; }
  for (const row of P.dimensionRows(b0, base)) {
    if (!["measure", "override"].includes(row.editability.kind)) continue;
    for (const f of [0.96, 1.04]) {
      const asked = row.kind === "kg" ? row.value * f : row.mm * f; n++;
      let p1; try { p1 = P.editDimension(base, row, asked); } catch (err) { note("edit-throws " + row.id, `${name} x${f}: ${err.message.slice(0, 90)}`); continue; }
      let b1; try { b1 = fit(p1); } catch (err) { note("fit-throws", `${name} ${row.id} x${f}: ${err.message}`); continue; }
      const d = b1.dims.find((x) => x.id === row.id), built = row.kind === "kg" ? d.value : d.value * 1000;
      if (!Number.isFinite(built)) note("NaN", `${name} ${row.id}`);
      const ex = P.explainEdit(row, asked, b1);
      const miss = Math.abs(built - asked) > Math.max(row.kind === "kg" ? 0.05 : 1, asked * 0.003);
      if (miss && !ex) note("silent-miss " + row.id, `${name} x${f}: asked ${asked.toFixed(1)} built ${built.toFixed(1)}`);
      if (P.unappliedOverrides(p1, b1).length) note("unapplied " + row.id, `${name} x${f}`);
      // revert restores the base body exactly
      const p2 = P.revertDimension(p1, P.dimensionRows(b1, p1).find((r) => r.id === row.id)); const b2 = fit(p2);
      const d2 = b2.dims.find((x) => x.id === row.id).value, d0 = b0.dims.find((x) => x.id === row.id).value;
      if (Math.abs(d2 - d0) > 1e-6 * Math.max(1, Math.abs(d0)) || P.countEdits(p2) !== 0) note("revert " + row.id, `${name}: ${d0} -> ${d2}, edits ${P.countEdits(p2)}`);
      if (p2.id !== base.id) note("revert-id " + row.id, `${name}: ${base.id} vs ${p2.id}`);
    }
  }
}
console.log(`${profs.length} profiles, ${n} edits, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [k, v] of problems) console.log("PROBLEM", k, "|", v.join(" | "));
