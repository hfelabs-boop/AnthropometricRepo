// Shared helpers of the adversarial IK checks (independent of ik.test.mjs: own sampler, own limit checker, own geometry).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, REGIONS } from "../../site/js/human/skeleton.js";
import * as IK from "../../site/js/human/ik.js";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export { THREE, JOINTS, JOINT_BY_ID, REGIONS, IK, fitBody };

// own PRNG (xorshift128+-ish via splitmix32), distinct from the author's mulberry32 sampler
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x21f0aaad); z = Math.imul(z ^ (z >>> 15), 0x735a2d97); return ((z ^ (z >>> 15)) >>> 0) / 4294967296; };
}
export const uni = (r, a, b) => a + (b - a) * r();

export function popBodies(filter = () => true) {
  const out = [];
  const base = path.join(ROOT, "public/api/v1/populations");
  for (const c of fs.readdirSync(base)) for (const role of fs.readdirSync(path.join(base, c))) {
    for (const f of fs.readdirSync(path.join(base, c, role))) {
      if (!f.endsWith(".json") || f.includes("latest")) continue;
      const name = `${c}/${role}/${f.replace(".json", "")}`;
      if (!filter(name)) continue;
      try {
        const pop = JSON.parse(fs.readFileSync(path.join(base, c, role, f), "utf8"));
        out.push({ name, body: fitBody(percentileProfile(pop, { percentile: 50 })) });
      } catch (e) { out.push({ name, error: e.message }); }
    }
  }
  return out;
}
export async function realPeople(n = 6) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(ROOT, "database", "anthro.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY (subject_key * 2654435761) % 1000003 LIMIT ?").all(n * 3);
  const extreme = db.prepare("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY mass DESC LIMIT 1").get();
  const small = db.prepare("SELECT * FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY stature ASC LIMIT 1").get();
  const out = [];
  for (const row of [extreme, small, ...rows]) {
    if (out.length >= n) break;
    try { out.push({ name: `person#${row.subject_key} ${row.stature}mm ${row.mass}kg`, body: fitBody(subjectProfile(row)) }); } catch { /* skip */ }
  }
  db.close();
  return out;
}

/** Independent limit check: range per DOF straight from JOINTS, swing length <= 180, finiteness. Returns problem strings. */
export function limitProblems(res, tol = 1e-6) {
  const out = [];
  for (const [id, a] of Object.entries(res.angles)) {
    const j = JOINT_BY_ID[id];
    if (!j) { out.push(`unknown joint ${id}`); continue; }
    if (a.length !== j.dof.length) out.push(`${id}: length ${a.length}`);
    let sw = 0;
    j.dof.forEach((d, i) => {
      const v = a[i];
      if (typeof v !== "number" || !Number.isFinite(v)) { out.push(`${id}.${d.key} not finite (${v})`); return; }
      if (v < d.min - tol || v > d.max + tol) out.push(`${id}.${d.key}=${v} outside [${d.min}, ${d.max}]`);
      if (d.role !== "twist") sw += v * v;
    });
    if (Math.sqrt(sw) > 180 + tol) out.push(`${id}: swing ${Math.sqrt(sw)} > 180`);
  }
  for (const k of ["x", "y", "z", "heading", "flex", "lat", "rot"]) if (!Number.isFinite(res.root[k])) out.push(`root.${k}=${res.root[k]}`);
  return out;
}

/** random in-ROM joint angles (uniform in the box, then cap radially at 180) */
export function randAngles(id, r, frac = 1) {
  const j = JOINT_BY_ID[id];
  const a = j.dof.map((d) => { const mid = (d.min + d.max) / 2, half = (d.max - d.min) / 2 * frac; return mid + (r() * 2 - 1) * half; });
  let s = 0; j.dof.forEach((d, i) => { if (d.role !== "twist") s += a[i] * a[i]; });
  s = Math.sqrt(s);
  if (s > 180) j.dof.forEach((d, i) => { if (d.role !== "twist") a[i] *= 180 / s; });
  return a;
}
export function randPose(ids, r, frac = 1) {
  const angles = {};
  for (const id of ids) angles[id] = randAngles(id, r, frac);
  return angles;
}
export const ARM = (s) => [`clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `forearm_${s}`, `wrist_${s}`];
export const LEG = (s) => [`hip_${s}`, `knee_${s}`, `ankle_${s}`];
export const NECK = [...REGIONS.cervical.joints, "head"];
export const standing = (solver) => ({ root: { ...solver.restRoot }, angles: {} });
export const wp = (solver, pose, lm) => solver.worldPoint(pose, lm);
export function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
