// Fuzz of body.js: random stature / mass / sex, random subsets of a real person's measures, random user overrides of the mapping table (dimensions and rings).
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.fuzz.mjs [count] [seed]
// Prints the failures (invalid geometry, non-finite values, folded triangles, budget) with the profile that produced them.
import { DatabaseSync } from "node:sqlite";
import { fitBody, DIM_DEFS } from "../../site/js/human/fit.js";
import { subjectProfile } from "../../site/js/human/anthro.js";
import { buildSkin } from "../../site/js/human/body.js";
import { makeBones, manifold, volume, creases, rangeBox, DB_PATH } from "./body.adversarial.helpers.mjs";

const N = +(process.argv[2] ?? 300);
let seed = +(process.argv[3] ?? 1);
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const uni = (a, b) => a + (b - a) * rnd();
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const subjects = db.prepare("select * from subjects").all();
const fails = [], stats = { n: 0, ms: [], tri: [], folds: {} };

function check(label, body, opts) {
  const bones = makeBones(body);
  for (const quality of ["high", "low"]) {
    let sk;
    try { sk = buildSkin(body, bones, { quality, ...opts }); } catch (e) { fails.push(`${label} ${quality}: THROW ${e.message}`); return; }
    const g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, sw = g.attributes.skinWeight.array;
    const bad = [];
    if (!pos.every(Number.isFinite) || !g.attributes.normal.array.every(Number.isFinite)) bad.push("nonfinite");
    for (const [name, p] of Object.entries(sk.mesh.userData.parts)) {
      const m = manifold(idx, p.triStart, p.triEnd); if (m) bad.push(`manifold ${name} ${m}`);
      const v = volume(pos, idx, p.triStart, p.triEnd); if (!(v > 0)) bad.push(`negvol ${name}`);
      const c = creases(pos, idx, p.triStart, p.triEnd, 0); if (c.count > (quality === "high" ? 20 : 20)) bad.push(`creases ${name} ${c.count}`);
      if (c.minArea < 1e-10) bad.push(`degenerate ${name}`);
    }
    for (let v = 0; v < sw.length / 4; v++) if (sw[v * 4] + sw[v * 4 + 1] + sw[v * 4 + 2] + sw[v * 4 + 3] !== 1) { bad.push("wsum"); break; }
    const bb = rangeBox(pos, 0, pos.length / 3);
    if (Math.abs(bb.hi[1] - body.stature) > 1e-3 || Math.abs(bb.lo[1]) > 1e-3) bad.push(`extent ${bb.hi[1].toFixed(4)} vs ${body.stature} lo ${bb.lo[1].toFixed(4)}`);
    if (quality === "low" && sk.stats.triangles >= 20000) bad.push(`low tris ${sk.stats.triangles}`);
    if (quality === "high" && sk.stats.triangles >= 90000) bad.push(`high tris ${sk.stats.triangles}`);
    stats.ms.push(sk.stats.buildMs); stats.tri.push(sk.stats.triangles); stats.n++;
    if (bad.length) fails.push(`${label} ${quality}: ${bad.join("; ")}`);
    sk.dispose();
  }
}

for (let i = 0; i < N; i++) {
  const kind = i % 4;
  const sub = subjects[Math.floor(rnd() * subjects.length)];
  let prof = subjectProfile(sub), label = `#${i} ${sub.dataset}:${sub.subject_key}`;
  const opts = {};
  if (kind === 0) { // random subset of the measures
    const keys = Object.keys(prof.measures), keep = new Set(["stature"]);
    for (const k of keys) if (rnd() < uni(0.05, 0.9)) keep.add(k);
    prof = { ...prof, measures: Object.fromEntries(Object.entries(prof.measures).filter(([k]) => keep.has(k))) };
    label += ` subset(${keep.size})`;
  } else if (kind === 1) { // stature / mass / sex only, extremes
    const st = uni(1300, 2300), bmi = uni(14, 55);
    prof = { id: "f", label: "f", sex: ["M", "F", "both"][Math.floor(rnd() * 3)], source: { kind: "manual" }, notes: [], measures: { stature: { value: st, unit: "mm" }, mass: { value: Math.min(300, Math.max(25, bmi * (st / 1000) ** 2)), unit: "kg" } } };
    label += ` ${prof.sex} ${st.toFixed(0)} mm ${prof.measures.mass.value.toFixed(0)} kg`;
  } else { // overrides of dimensions and rings
    opts.overrides = {};
    const body0 = fitBody(prof);
    const nOv = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < nOv; k++) {
      const d = body0.dims[Math.floor(rnd() * body0.dims.length)];
      if (d.unit !== "m" || d.id === "stature") continue;
      opts.overrides[d.id] = d.value * uni(kind === 2 ? 0.8 : 0.6, kind === 2 ? 1.2 : 1.5);
    }
    label += ` overrides ${JSON.stringify(Object.fromEntries(Object.entries(opts.overrides).map(([k, v]) => [k, +(v * 1000).toFixed(0)])))}`;
  }
  let body;
  try { body = fitBody(prof, opts); } catch (e) { fails.push(`${label}: fitBody threw`); continue; }
  check(label, body, {});
}
console.log(`${stats.n} builds, ms median ${stats.ms.sort((a, b) => a - b)[stats.ms.length >> 1]?.toFixed(1)} max ${stats.ms[stats.ms.length - 1]?.toFixed(1)}, tri max ${Math.max(...stats.tri)}`);
console.log(fails.length ? fails.slice(0, 60).join("\n") : "no failures");
console.log("failures", fails.length);
