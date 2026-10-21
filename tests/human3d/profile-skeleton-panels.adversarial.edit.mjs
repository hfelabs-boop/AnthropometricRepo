// Adversarial: edit every dimension row, refit, revert. node --import ./tests/human3d/register.mjs tests/human3d/profile-skeleton-panels.adversarial.edit.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import * as P from "../../site/js/human/panels/profile.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";

const DATA = path.resolve("public/api/v1");
const fetchJSON = async (url) => JSON.parse(fs.readFileSync(path.join(DATA, url.replace(/^api\/v1\//, "")), "utf8"));
const cat = JSON.parse(fs.readFileSync(path.join(DATA, "measures.json"), "utf8"));
anthro.setMeasureCatalog(cat);
const fit = (p) => fitBody(p, { form: p.form ?? P.defaultForm(p), overrides: p.overrides });
const out = [];
const rep = (m) => { out.push(m); console.log(m); };
const picks = [["united-states", "army", "M", 50], ["united-states", "army", "F", 95], ["germany", "army", "M", 5], ["finland", "army", "M", 50]];
const manual = anthro.manualProfile({ sex: "F", stature: 1620, mass: 58 });
const profiles = [["manual", manual]];
for (const [c, r, s, pc] of picks) {
  try { profiles.push([`${c}/${r}/${s}/P${pc}`, anthro.percentileProfile(JSON.parse(fs.readFileSync(path.join(DATA, `populations/${c}/${r}/${s}.json`))), { percentile: pc, meanStature: true })]); } catch (e) { rep(`skip ${c}/${r}/${s}: ${e.message}`); }
}
for (const [name, raw] of profiles) {
  const base = P.finalizeProfile(raw, {});
  const body0 = fit(base);
  const rows0 = P.dimensionRows(body0, base, cat);
  for (const row of rows0) {
    const ed = row.editability;
    if (ed.kind !== "measure" && ed.kind !== "override") continue;
    for (const f of [0.92, 1.08]) {
      const target = row.kind === "kg" ? row.value * f : row.mm * f;
      let p1;
      try { p1 = P.editDimension(base, row, target, row.kind === "kg" ? "kg" : "mm"); } catch (e) { rep(`${name} ${row.id} x${f}: editDimension threw ${e.message}`); continue; }
      let b1;
      try { b1 = fit(p1); } catch (e) { rep(`${name} ${row.id} x${f}: FIT THREW ${e.message}`); continue; }
      const d = b1.dims.find((x) => x.id === row.id);
      const got = row.kind === "kg" ? d.value : d.value * 1000;
      const err = Math.abs(got - target) / target;
      const [lo, hi] = row.band;
      const inBand = (lo == null || target / 1000 >= lo) && (hi == null || target / 1000 <= hi) || row.kind === "kg";
      if (err > 0.003 && inBand && !/limited|plausible|clamp/.test(d.note ?? "")) rep(`${name} ${row.id} (${ed.kind}) x${f}: asked ${target.toFixed(1)} got ${got.toFixed(1)} (${(err * 100).toFixed(1)} %) status ${d.status}; note: ${d.note}`);
      // the row must be marked edited, and the unapplied-check must be quiet
      const rows1 = P.dimensionRows(b1, p1, cat);
      const r1 = rows1.find((r) => r.id === row.id);
      if (!r1.edited) rep(`${name} ${row.id} x${f}: row NOT marked edited after edit`);
      const miss = P.verifyExtras(p1, b1);
      if (miss.length && inBand) rep(`${name} ${row.id} x${f}: verifyExtras says unapplied: ${miss} (dim note: ${d.note})`);
      // revert
      const p2 = P.revertDimension(p1, r1);
      if (p2.id !== base.id) rep(`${name} ${row.id} x${f}: revert id ${p2.id} != base ${base.id}`);
      try { assert.deepEqual(p2.measures, base.measures); } catch { rep(`${name} ${row.id} x${f}: revert measures differ`); }
      if (JSON.stringify(p2.overrides ?? {}) !== JSON.stringify(base.overrides ?? {})) rep(`${name} ${row.id} x${f}: revert overrides ${JSON.stringify(p2.overrides)}`);
      if (JSON.stringify(p2.notes) !== JSON.stringify(base.notes)) rep(`${name} ${row.id} x${f}: revert notes differ: ${JSON.stringify(p2.notes)} vs ${JSON.stringify(base.notes)}`);
      if (p2.label !== base.label) rep(`${name} ${row.id} x${f}: revert label ${p2.label} != ${base.label}`);
      const b2 = fit(p2);
      if (JSON.stringify(b2.dims.map((x) => x.value)) !== JSON.stringify(body0.dims.map((x) => x.value))) rep(`${name} ${row.id} x${f}: revert does not restore every dim value`);
    }
  }
  // derived/aliased rows: do other dims move unexpectedly when one is edited? count dims changed >1 mm
}
// double edit and revertAll
{
  const base = P.finalizeProfile(profiles[1][1], {});
  const rows = P.dimensionRows(fit(base), base, cat);
  let p = base;
  for (const id of ["hand_length", "femur_length", "upper_arm_length", "mass", "stature", "ring_waist"]) {
    const row = P.dimensionRows(fit(p), p, cat).find((r) => r.id === id);
    p = P.editDimension(p, row, row.kind === "kg" ? row.value * 1.05 : row.mm * 1.05, row.kind === "kg" ? "kg" : "mm");
  }
  const pa = P.revertAll(p);
  if (pa.id !== base.id) rep(`revertAll id ${pa.id} != ${base.id}`);
  if (JSON.stringify(pa.measures) !== JSON.stringify(base.measures)) rep("revertAll measures differ");
  if (JSON.stringify(pa.notes) !== JSON.stringify(base.notes)) rep("revertAll notes differ " + JSON.stringify(pa.notes));
  rep(`multi-edit id: ${p.id} label: ${p.label}`);
}
console.log(out.length ? `${out.length} findings` : "no findings");
