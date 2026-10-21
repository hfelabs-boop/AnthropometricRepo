// Adversarial sweep of body.js over many fits (a script, not a test: it takes minutes).
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.sweep.mjs <subjects|pops> <shard> <nshards> <out.jsonl> [limit]
// One JSON line per fit with every metric; body.adversarial.summary.mjs aggregates them.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fitBody, ringPerimeter } from "../../site/js/human/fit.js";
import { subjectProfile } from "../../site/js/human/anthro.js";
import { buildSkin } from "../../site/js/human/body.js";
import { allPopulations, popProfile, makeBones, manifold, volume, creases, sliceY, rangeBox, DB_PATH } from "./body.adversarial.helpers.mjs";

const [mode, shardS, nShardS, outPath, limitS] = process.argv.slice(2);
const shard = +shardS, nShard = +nShardS, limit = limitS ? +limitS : Infinity;

function jobs() {
  if (mode === "pops") {
    const out = [];
    for (const [c, r, s] of allPopulations()) for (const pct of [5, 50, 95]) out.push({ label: `${c}/${r}/${s} P${pct}`, make: () => popProfile(c, r, s, pct) });
    return out;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("select * from subjects order by dataset, subject_key").all();
  return rows.map((r) => ({ label: `${r.dataset}#${r.subject_key}`, make: () => subjectProfile(r) }));
}

const GIRTHS = [ // [ring id, tube/part, measure key, tolerance]
  ["chest", "torso", "chest_circumference"], ["waist", "torso", "waist_circumference"], ["buttock", "torso", "buttock_circumference"],
  ["neck_mid", "torso", null], ["ua_biceps", "arm", "biceps_circumference_flexed"], ["fa_max", "arm", "forearm_circumference_flexed"],
  ["th_prox", "leg", "thigh_circumference"], ["sh_calf", "leg", "calf_circumference"], ["sh_ankle", "leg", "ankle_circumference"], ["th_knee", "leg", null],
];

function analyse(body, skin) {
  const geo = skin.mesh.geometry, pos = geo.attributes.position.array, idx = geo.index.array, nor = geo.attributes.normal.array;
  const si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, nv = pos.length / 3, parts = skin.mesh.userData.parts;
  const rec = { tri: idx.length / 3, vert: nv, ms: skin.stats.buildMs, problems: [] };
  const prob = (s) => rec.problems.push(s);
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]) || !Number.isFinite(nor[i])) { prob("nonfinite"); break; }
  for (let v = 0; v < nv; v++) {
    let s = 0;
    for (let k = 0; k < 4; k++) { const w = sw[v * 4 + k]; if (!(w >= 0)) prob("negweight"); s += w; if (w > 0 && si[v * 4 + k] >= 77) prob("badbone"); }
    if (Math.abs(s - 1) > 1e-6) { prob("wsum"); break; }
  }
  rec.crease = {}; rec.vol = {};
  for (const [name, p] of Object.entries(parts)) {
    const bad = manifold(idx, p.triStart, p.triEnd);
    if (bad) prob(`manifold:${name}:${bad}`);
    const vol = volume(pos, idx, p.triStart, p.triEnd);
    if (!(vol > 0)) prob(`negvol:${name}`);
    rec.vol[name] = vol;
    const c = creases(pos, idx, p.triStart, p.triEnd, 0);
    if (c.count) rec.crease[name] = c.count;
    if (c.minArea < 1e-10) prob(`degenerate:${name}`);
  }
  const total = volume(pos, idx);
  rec.volRatio = total / body.shape.volume.m3;
  const hb = rangeBox(pos, 0, nv);
  rec.statureErr = (hb.hi[1] - body.stature) * 1000; rec.soleErr = hb.lo[1] * 1000;
  // girths of the rings
  rec.girth = {};
  const tubeRings = (id, part) => {
    const T = body.shape.tubes;
    if (part === "torso") return [...T.torso.rings, ...T.neck.rings].find((r) => r.id === id);
    if (part === "arm") return [...T.upper_arm_L.rings, ...T.forearm_L.rings].find((r) => r.id === id);
    return [...T.thigh_L.rings, ...T.shank_L.rings].find((r) => r.id === id);
  };
  for (const [id, part, key] of GIRTHS) {
    const ring = tubeRings(id, part), P = parts[part === "torso" ? "torso" : part === "arm" ? "arm_L" : "leg_L"];
    if (!ring) continue;
    const s = sliceY(pos, idx, P.triStart, P.triEnd, ring.c[1]);
    const ringG = ringPerimeter(ring.rx, ring.rz, ring.n);
    rec.girth[id] = { mesh: s.per * 1000, ring: ringG * 1000, input: key && body.inputs?.[key] != null ? body.inputs[key] * 1000 : null, src: ring.src, n: s.n };
  }
  // breadths and depths
  const T = body.shape.tubes;
  const ring = (id) => T.torso.rings.find((r) => r.id === id);
  const sl = (id) => sliceY(pos, idx, parts.torso.triStart, parts.torso.triEnd, ring(id).c[1]);
  const ch = sl("chest"), bu = sl("buttock");
  rec.chestDepth = { mesh: (ch.z[1] - ch.z[0]) * 1000, input: body.inputs?.chest_depth != null ? body.inputs.chest_depth * 1000 : null };
  rec.chestBreadth = { mesh: (ch.x[1] - ch.x[0]) * 1000, input: body.inputs?.chest_breadth != null ? body.inputs.chest_breadth * 1000 : null };
  rec.hipBreadth = { mesh: (bu.x[1] - bu.x[0]) * 1000, input: body.inputs?.["other:hip_breadth"] != null ? body.inputs["other:hip_breadth"] * 1000 : null };
  const ar = rangeBox(pos, parts.arm_L.vertexStart, parts.arm_L.vertexEnd);
  rec.bideltoid = { mesh: 2 * ar.hi[0] * 1000, input: body.inputs?.bideltoid_breadth != null ? body.inputs.bideltoid_breadth * 1000 : null };
  // L/R overlap of the legs at the thigh and of the arms with the trunk at neutral
  const gap = (y) => {
    const a = sliceY(pos, idx, parts.leg_L.triStart, parts.leg_L.triEnd, y), b = sliceY(pos, idx, parts.leg_R.triStart, parts.leg_R.triEnd, y);
    return a.n && b.n ? (a.x[0] - b.x[1]) * 1000 : null;
  };
  const yh = body.positions.hip_L[1];
  rec.legGap = [yh - 0.04, yh - 0.12, yh - 0.25, yh - 0.4].map(gap);
  // foot, hand
  const ft = rangeBox(pos, parts.foot_L.vertexStart, parts.foot_L.vertexEnd);
  rec.foot = { len: (ft.hi[2] - ft.lo[2]) * 1000, input: body.d.foot_length * 1000, w: (ft.hi[0] - ft.lo[0]) * 1000, bin: body.inputs?.foot_breadth != null ? body.inputs.foot_breadth * 1000 : null };
  return rec;
}

const all = jobs();
const out = fs.openSync(outPath, "w");
let done = 0;
for (let i = shard; i < all.length && done < limit; i += nShard) {
  const job = all[i];
  done++;
  const rec = { label: job.label };
  try {
    const body = fitBody(job.make());
    rec.sex = body.form; rec.stature = body.stature; rec.mass = body.mass;
    const bones = makeBones(body);
    const hi = buildSkin(body, bones, { quality: "high" });
    Object.assign(rec, analyse(body, hi));
    hi.dispose();
    const lo = buildSkin(body, bones, { quality: "low" });
    const l = analyse(body, lo);
    rec.low = { tri: l.tri, vert: l.vert, problems: l.problems, ms: l.ms };
    lo.dispose();
  } catch (e) {
    rec.error = String(e && e.stack || e).slice(0, 400);
  }
  fs.writeSync(out, JSON.stringify(rec) + "\n");
}
fs.closeSync(out);
console.log(`shard ${shard}: ${done} fits`);
