// Deformation sweep: every posture of the library on several bodies, CPU skinning. A script (prints a table of the worst cases).
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.poses.mjs [json-out]
import fs from "node:fs";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { POSTURES } from "../../site/js/human/postures.js";
import { expandPosture } from "../../site/js/human/pose.js";
import { popProfile, boneMatrices, skinAll, volume, faceNormals, mm } from "./body.adversarial.helpers.mjs";

const P = (stature, sex, mass) => ({ id: `t${stature}${sex}${mass}`, label: "t", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: stature, unit: "mm" }, ...(mass ? { mass: { value: mass, unit: "kg" } } : {}) } });
export const BODIES = {
  man50: () => popProfile("united-states", "army", "M", 50), woman50: () => popProfile("united-states", "army", "F", 50),
  woman5: () => popProfile("united-states", "army", "F", 5), man95: () => popProfile("united-states", "army", "M", 95),
  heavy: () => P(1780, "M", 150), thin: () => P(1780, "M", 52), tall: () => P(2050, "M", 120), short: () => P(1450, "F", 42),
};

/** Per-posture metrics of the posed skin relative to the rest skin. */
export function measurePose(rig, skin, rest, restFace) {
  const mesh = skin.mesh, geo = mesh.geometry, idx = geo.index.array, parts = mesh.userData.parts;
  rig.group.updateMatrixWorld(true);
  const M = boneMatrices(mesh), posed = skinAll(mesh, M);
  const out = { nonfinite: 0, stretchMax: 0, stretchWhere: "", shrinkMin: 1e9, folded: 0, foldedPart: {}, volRatio: {}, maxEdgeLen: 0 };
  for (let i = 0; i < posed.length; i++) if (!Number.isFinite(posed[i])) out.nonfinite++;
  // names of parts by vertex
  const partOf = new Int16Array(posed.length / 3).fill(-1), names = Object.keys(parts);
  names.forEach((n, k) => { for (let v = parts[n].vertexStart; v < parts[n].vertexEnd; v++) partOf[v] = k; });
  const seen = new Set();
  for (let t = 0; t < idx.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + (k + 1) % 3], key = a < b ? a * 4194304 + b : b * 4194304 + a;
      if (seen.has(key)) continue; seen.add(key);
      const L0 = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
      const L1 = Math.hypot(posed[a * 3] - posed[b * 3], posed[a * 3 + 1] - posed[b * 3 + 1], posed[a * 3 + 2] - posed[b * 3 + 2]);
      if (L0 < 0.0015) continue;
      const r = L1 / L0;
      if (r > out.stretchMax) { out.stretchMax = r; out.stretchWhere = names[partOf[a]]; }
      if (r < out.shrinkMin) out.shrinkMin = r;
      if (L1 > out.maxEdgeLen) out.maxEdgeLen = L1;
    }
  }
  // folds: posed face normal against the rest face normal transformed by the blended rotation of the vertices
  const { n: pn } = faceNormals(posed, idx, 0, idx.length / 3);
  const si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, nrm = geo.attributes.normal.array;
  const sn = new Float64Array(posed.length);
  for (let v = 0; v < posed.length / 3; v++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k]; if (!w) continue;
      const o = si[v * 4 + k] * 16, nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      x += w * (M[o] * nx + M[o + 4] * ny + M[o + 8] * nz); y += w * (M[o + 1] * nx + M[o + 5] * ny + M[o + 9] * nz); z += w * (M[o + 2] * nx + M[o + 6] * ny + M[o + 10] * nz);
    }
    sn[v * 3] = x; sn[v * 3 + 1] = y; sn[v * 3 + 2] = z;
  }
  for (let t = 0; t < idx.length / 3; t++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += sn[idx[t * 3 + k] * 3]; y += sn[idx[t * 3 + k] * 3 + 1]; z += sn[idx[t * 3 + k] * 3 + 2]; }
    const l = Math.hypot(x, y, z) || 1, d = (pn[t * 3] * x + pn[t * 3 + 1] * y + pn[t * 3 + 2] * z) / l;
    if (d < -0.3 && restFace.area[t] > 1e-9) { out.folded++; const nm = names[partOf[idx[t * 3]]]; out.foldedPart[nm] = (out.foldedPart[nm] ?? 0) + 1; }
  }
  for (const n of names) if (!/_[LR]$/.test(n) || /^(arm|leg|foot)_/.test(n)) out.volRatio[n] = volume(posed, idx, parts[n].triStart, parts[n].triEnd);
  out.posed = posed;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = (process.env.BODIES ?? Object.keys(BODIES).join(",")).split(",");
  const rows = [];
  for (const name of which) {
    const body = fitBody(BODIES[name]()), h = {};
    const rig = buildRig(body, { skeleton: false, quality: "high", skinBuilder: (b, bones, o) => (h.skin = buildSkin(b, bones, o)) });
    const skin = h.skin, geo = skin.mesh.geometry, rest = Float64Array.from(geo.attributes.position.array);
    const restFace = faceNormals(rest, geo.index.array, 0, geo.index.array.length / 3);
    const restVol = {}; for (const [n, p] of Object.entries(skin.mesh.userData.parts)) restVol[n] = volume(rest, geo.index.array, p.triStart, p.triEnd);
    for (const p of POSTURES) {
      const ex = expandPosture(p);
      rig.setPose({ root: { ...ex.root, x: 0, y: 1, z: 0 }, angles: ex.angles }, { clamp: true });
      const m = measurePose(rig, skin, rest, restFace);
      let vmin = 9, vmax = 0, vp = "";
      for (const [n, v] of Object.entries(m.volRatio)) { const r = v / restVol[n]; if (r < vmin) { vmin = r; vp = n; } if (r > vmax) vmax = r; }
      rows.push({ body: name, id: p.id, nonfinite: m.nonfinite, stretch: m.stretchMax, stretchWhere: m.stretchWhere, shrink: m.shrinkMin, folded: m.folded, foldedPart: m.foldedPart, vmin, vmax, vp, maxEdge: m.maxEdgeLen });
    }
    rig.dispose();
    console.error(name, "done");
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(rows));
  const top = (f, n = 12) => rows.slice().sort((a, b) => f(b) - f(a)).slice(0, n);
  console.log("postures", POSTURES.length, "rows", rows.length, "nonfinite rows", rows.filter((r) => r.nonfinite).length);
  console.log("-- worst stretch (posed edge / rest edge)");
  for (const r of top((r) => r.stretch)) console.log(` ${r.stretch.toFixed(2)} ${r.body} ${r.id} in ${r.stretchWhere}`);
  console.log("-- worst shrink");
  for (const r of top((r) => -r.shrink)) console.log(` ${r.shrink.toFixed(3)} ${r.body} ${r.id}`);
  console.log("-- most folded triangles");
  for (const r of top((r) => r.folded)) console.log(` ${r.folded} ${r.body} ${r.id} ${JSON.stringify(r.foldedPart)}`);
  console.log("-- smallest part volume ratio");
  for (const r of top((r) => -r.vmin)) console.log(` ${r.vmin.toFixed(3)} ${r.vp} ${r.body} ${r.id}`);
  console.log("-- largest part volume ratio");
  for (const r of top((r) => r.vmax)) console.log(` ${r.vmax.toFixed(3)} ${r.body} ${r.id}`);
}
