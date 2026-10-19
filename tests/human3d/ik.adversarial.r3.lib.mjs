// Third-round adversarial verification of site/js/human/ik.js: shared helpers. Own PRNG (xoshiro128**), own sampler, own limit check
// (clampAngles of skeleton.js is the oracle for "inside every range"), own forward kinematics through the rig scene graph.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, jointQuaternion } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import * as IK from "../../site/js/human/ik.js";

export { THREE, JOINTS, JOINT_BY_ID, REGIONS, IK, buildRig, fitBody, jointQuaternion, clampAngles };
export const ROOTDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function rng(seed) { // xoshiro128**, seeded by splitmix32
  let s = seed >>> 0;
  const sm = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  let a = sm(), b = sm(), c = sm(), d = sm();
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  return () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0, t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return r / 4294967296;
  };
}
export const uni = (r, a, b) => a + (b - a) * r();
export const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export function popBodies(filter = () => true, percentile = 50) {
  const out = [], base = path.join(ROOTDIR, "public/api/v1/populations");
  for (const c of fs.readdirSync(base).sort()) for (const role of fs.readdirSync(path.join(base, c)).sort()) for (const f of fs.readdirSync(path.join(base, c, role)).sort()) {
    if (!f.endsWith(".json") || f.includes("latest")) continue;
    const name = `${c}/${role}/${f.replace(".json", "")}`;
    if (!filter(name)) continue;
    try { out.push({ name, body: fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(base, c, role, f), "utf8")), { percentile })) }); } catch (e) { out.push({ name, error: e.message }); }
  }
  return out;
}
export async function realPeople(n = 8) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(ROOTDIR, "database", "anthro.sqlite"), { readOnly: true });
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const rows = [
    ...q("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY mass DESC LIMIT 2"),
    ...q("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY stature ASC LIMIT 2"),
    ...q("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY stature DESC LIMIT 2"),
    ...q("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY (subject_key * 40503) % 100003 LIMIT ?", n * 2),
  ];
  const out = [];
  for (const row of rows) { if (out.length >= n) break; try { out.push({ name: `person#${row.subject_key} ${row.stature}mm ${row.mass}kg`, body: fitBody(subjectProfile(row)) }); } catch { /* skip */ } }
  db.close();
  return out;
}

const cache = new WeakMap();
export function ctx(b) {
  let c = cache.get(b);
  if (!c) { c = { b, solver: IK.createSolver(b.body), _rig: null, get rig() { return this._rig ??= buildRig(b.body, { skeleton: false }); } }; cache.set(b, c); }
  return c;
}
export const standing = (s) => ({ root: { ...s.restRoot }, angles: {} });
export const ARM = (s) => [`clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `forearm_${s}`, `wrist_${s}`];
export const LEG = (s) => [`hip_${s}`, `knee_${s}`, `ankle_${s}`];

/** random in-ROM angles of a joint: uniform in the box of each DOF, then the swing vector scaled to the 180 cap */
export function randAngles(id, r, frac = 1) {
  const j = JOINT_BY_ID[id];
  const a = j.dof.map((d) => ((d.min + d.max) / 2) + (r() * 2 - 1) * ((d.max - d.min) / 2) * frac);
  return clampAngles(id, a).angles;
}
export const randPose = (ids, r, frac = 1) => Object.fromEntries(ids.map((id) => [id, randAngles(id, r, frac)]));

/** Problems of a result against the oracle: every joint equal to its clampAngles (ranges + 180 cap) to 1e-9, finite, right length; root finite. */
export function limitProblems(res, tol = 1e-9) {
  const out = [];
  for (const [id, a] of Object.entries(res.angles)) {
    const j = JOINT_BY_ID[id];
    if (!j) { out.push(`unknown joint ${id}`); continue; }
    if (a.length !== j.dof.length) { out.push(`${id}: length ${a.length}`); continue; }
    if (!a.every((v) => typeof v === "number" && Number.isFinite(v))) { out.push(`${id}: not finite ${a}`); continue; }
    const c = clampAngles(id, a).angles;
    for (let i = 0; i < a.length; i++) if (Math.abs(c[i] - a[i]) > tol) out.push(`${id}.${j.dof[i].key}=${a[i]} would clamp to ${c[i]}`);
  }
  for (const k of ["x", "y", "z", "heading", "flex", "lat", "rot"]) if (!Number.isFinite(res.root[k])) out.push(`root.${k}=${res.root[k]}`);
  for (const [k, v] of Object.entries(res.error)) if (!Number.isFinite(v)) out.push(`error.${k}=${v}`);
  if (!Number.isFinite(res.residual)) out.push(`residual ${res.residual}`);
  return out;
}

export function rigPoint(rig, pose, id) { rig.setPose(pose, { clamp: false }); return rig.landmarkWorld(id, new THREE.Vector3()); }
export const dist3 = (a, b) => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
export const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
export const clone = (o) => JSON.parse(JSON.stringify(o));

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
/** Largest rotation (degrees) of any joint between two poses (relative quaternion angle, not a difference of DOF numbers); optional filter of ids */
export function poseStep(a, b, only = null) {
  let worst = 0, wj = null;
  for (const id of Object.keys(b.angles)) {
    if (only && !only.includes(id)) continue;
    const j = JOINT_BY_ID[id];
    jointQuaternion(id, a.angles[id] ?? j.dof.map(() => 0), qa); jointQuaternion(id, b.angles[id], qb);
    const d = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * R2D;
    if (d > worst) { worst = d; wj = id; }
  }
  return { deg: worst, joint: wj };
}

/** Catmull-Rom through control points, resampled to n points uniformly in arc length (a smooth hand path of known speed) */
export function spline(ctrl, n = 200) {
  const dense = [], seg = ctrl.length - 1;
  const P = (i) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
  for (let s = 0; s < seg; s++) for (let k = 0; k < 60; k++) {
    const t = k / 60, p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
    dense.push([0, 1, 2].map((c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t ** 3)));
  }
  dense.push(P(seg));
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(...[0, 1, 2].map((c) => dense[i][c] - dense[i - 1][c])));
  const total = cum[cum.length - 1], pts = [];
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    let j = 1;
    while (j < cum.length - 1 && cum[j] < d) j++;
    const f = (d - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
    pts.push([0, 1, 2].map((c) => dense[j - 1][c] + f * (dense[j][c] - dense[j - 1][c])));
  }
  return { pts, length: total };
}
export const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
