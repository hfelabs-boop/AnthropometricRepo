// Helpers of the adversarial checks of site/js/human/body.js (tests/human3d/body.adversarial.*). Independent of body.test.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const POP_DIR = path.join(ROOT, "public/api/v1/populations");
export const DB_PATH = path.join(ROOT, "database/anthro.sqlite");
export const SCRATCH = "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad";
export const mm = (x) => x * 1000;

/** Every population file as [country, role, sex] (all 176 of them). */
export function allPopulations() {
  const out = [];
  for (const c of fs.readdirSync(POP_DIR).sort()) {
    if (!fs.statSync(path.join(POP_DIR, c)).isDirectory()) continue;
    for (const r of fs.readdirSync(path.join(POP_DIR, c)).sort()) {
      const d = path.join(POP_DIR, c, r);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d).sort()) if (/^[MF]\.json$/.test(f) || /^both\.json$/.test(f)) out.push([c, r, f.replace(".json", "")]);
    }
  }
  return out;
}
export const popProfile = (c, r, s, pct) => percentileProfile(JSON.parse(fs.readFileSync(path.join(POP_DIR, c, r, `${s}.json`), "utf8")), { percentile: pct });

/** Bones with the rest offsets from body.positions (what rig.js builds), identity rotations. */
export function makeBones(body) {
  const m = new Map();
  for (const j of JOINTS) {
    const b = new THREE.Bone(); b.name = j.id;
    const p = body.positions[j.id];
    if (j.parent) { const q = body.positions[j.parent]; b.position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]); m.get(j.parent).add(b); } else b.position.set(p[0], p[1], p[2]);
    m.set(j.id, b);
  }
  m.get("pelvis").updateMatrixWorld(true);
  return m;
}

/** Closed-manifold check of triangles [t0, t1): returns { bad (edges not used exactly once per direction), nonmanifold }. */
export function manifold(index, t0, t1) {
  const seen = new Map();
  for (let t = t0; t < t1; t++) for (let k = 0; k < 3; k++) {
    const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)];
    const key = a < b ? a * 4194304 + b : b * 4194304 + a;
    let e = seen.get(key); if (!e) seen.set(key, (e = [0, 0]));
    e[a < b ? 0 : 1]++;
  }
  let bad = 0;
  for (const e of seen.values()) if (e[0] !== 1 || e[1] !== 1) bad++;
  return bad;
}

/** Signed volume (positive = outward windings). */
export function volume(pos, index, t0 = 0, t1 = index.length / 3) {
  let v = 0;
  for (let t = t0; t < t1; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
  }
  return v;
}

/** Face normals and areas of the triangles [t0, t1) of a position array (any float array). */
export function faceNormals(pos, index, t0, t1) {
  const n = new Float64Array((t1 - t0) * 3), area = new Float64Array(t1 - t0);
  for (let t = t0; t < t1; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    area[t - t0] = 0.5 * l;
    if (l > 0) { n[(t - t0) * 3] = nx / l; n[(t - t0) * 3 + 1] = ny / l; n[(t - t0) * 3 + 2] = nz / l; }
  }
  return { n, area };
}

/** Sharp creases / folds: number of interior edges whose two faces make a dihedral angle with cos < cosMax (cos of the angle between face normals; < 0 = turned more than 90 degrees), and the worst cos. */
export function creases(pos, index, t0, t1, cosMax = 0) {
  const { n, area } = faceNormals(pos, index, t0, t1);
  const first = new Map();
  let count = 0, worst = 1, minArea = Infinity;
  for (let i = 0; i < area.length; i++) if (area[i] < minArea) minArea = area[i];
  for (let t = t0; t < t1; t++) for (let k = 0; k < 3; k++) {
    const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)], key = a < b ? a * 4194304 + b : b * 4194304 + a;
    const o = first.get(key);
    if (o === undefined) first.set(key, t);
    else {
      const i = (t - t0) * 3, j = (o - t0) * 3;
      if (area[t - t0] < 1e-12 || area[o - t0] < 1e-12) continue;
      const d = n[i] * n[j] + n[i + 1] * n[j + 1] + n[i + 2] * n[j + 2];
      if (d < worst) worst = d;
      if (d < cosMax) count++;
    }
  }
  return { count, worst, minArea };
}

/** Perimeter (m) and bounding box of the cross-section of triangles [t0, t1) with the plane y = y0. */
export function sliceY(pos, index, t0, t1, y0) {
  let per = 0, n = 0;
  const bb = { x: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  const P = [0, 0, 0, 0, 0, 0];
  for (let t = t0; t < t1; t++) {
    let m = 0;
    const v = [index[t * 3] * 3, index[t * 3 + 1] * 3, index[t * 3 + 2] * 3];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], ya = pos[a + 1] - y0, yb = pos[b + 1] - y0;
      if ((ya < 0) !== (yb < 0)) {
        const f = ya / (ya - yb);
        if (m < 2) { P[m * 3] = pos[a] + f * (pos[b] - pos[a]); P[m * 3 + 2] = pos[a + 2] + f * (pos[b + 2] - pos[a + 2]); }
        m++;
      }
    }
    if (m === 2) {
      per += Math.hypot(P[0] - P[3], P[2] - P[5]); n++;
      for (const o of [0, 3]) { bb.x = [Math.min(bb.x[0], P[o]), Math.max(bb.x[1], P[o])]; bb.z = [Math.min(bb.z[0], P[o + 2]), Math.max(bb.z[1], P[o + 2])]; }
    }
  }
  return { per, n, ...bb };
}

/** Bounding box of a vertex range. */
export function rangeBox(pos, v0, v1) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = v0; v < v1; v++) for (let k = 0; k < 3; k++) { const x = pos[v * 3 + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
  return { lo, hi };
}

// ---- CPU skinning (transcription of the vertex shader) ------------------------------------------------------------------------------
const TMP = new THREE.Matrix4();
export function boneMatrices(mesh) {
  const sk = mesh.skeleton, n = sk.bones.length, M = new Float64Array(n * 16);
  for (let i = 0; i < n; i++) { TMP.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]); M.set(TMP.elements, i * 16); }
  return M;
}
export function skinAll(mesh, M, out) {
  const geo = mesh.geometry, pos = geo.attributes.position.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, nv = pos.length / 3;
  out ??= new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k];
      if (w === 0) continue;
      const o = si[v * 4 + k] * 16;
      ax += w * (M[o] * x + M[o + 4] * y + M[o + 8] * z + M[o + 12]);
      ay += w * (M[o + 1] * x + M[o + 5] * y + M[o + 9] * z + M[o + 13]);
      az += w * (M[o + 2] * x + M[o + 6] * y + M[o + 10] * z + M[o + 14]);
    }
    out[v * 3] = ax; out[v * 3 + 1] = ay; out[v * 3 + 2] = az;
  }
  return out;
}

export { fitBody };
