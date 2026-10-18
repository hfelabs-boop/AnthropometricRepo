// Shared fixtures of the adversarial tests of pose.js / proxies.js / postures.js (independent of pose.test.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { JOINTS, clampAngles } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POPS = path.join(ROOT, "public/api/v1/populations");

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function populationFiles() {
  const out = [];
  for (const c of fs.readdirSync(POPS)) for (const r of fs.readdirSync(path.join(POPS, c))) for (const f of fs.readdirSync(path.join(POPS, c, r))) {
    if (f.endsWith(".json") && !f.includes("latest")) out.push(path.join(POPS, c, r, f));
  }
  return out.sort();
}
export function popBody(file, percentile = 50) {
  return fitBody(percentileProfile(JSON.parse(fs.readFileSync(file)), { percentile, meanStature: true }));
}
export const army = (sex, percentile = 50) => popBody(path.join(POPS, "united-states/army", `${sex}.json`), percentile);

export async function realPeople(n = 200) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(ROOT, "database/anthro.sqlite"), { readOnly: true });
  const keys = db.prepare("SELECT subject_key FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY subject_key").all().map((r) => r.subject_key);
  const step = Math.max(1, Math.floor(keys.length / n)), out = [];
  for (let i = 0; i < keys.length && out.length < n; i += step) {
    const row = db.prepare("SELECT * FROM subjects WHERE subject_key = ?").get(keys[i]);
    out.push({ key: keys[i], body: fitBody(subjectProfile(row)) });
  }
  db.close();
  return out;
}

export function randomPose(rand, scale = 1, withRoot = true) {
  const angles = {};
  for (const j of JOINTS) {
    if (j.id === "pelvis") continue;
    const a = j.dof.map((d) => (d.min + rand() * (d.max - d.min)) * scale);
    angles[j.id] = clampAngles(j.id, a).angles;
  }
  const root = withRoot ? { heading: (rand() - 0.5) * 300, flex: (rand() - 0.5) * 120, lat: (rand() - 0.5) * 100, rot: (rand() - 0.5) * 100 } : { heading: 0, flex: 0, lat: 0, rot: 0 };
  return { root, angles };
}

export const kinOf = (body) => { const o = {}; for (const j of JOINTS) if (j.parent) o[j.id] = body.joints[j.id].offset; return new Kinematics(o); };
export const lmWorld = (body, kin, id) => kin.toWorld(body.landmarks[id].joint, body.landmarks[id].offset);

export const posture = (over) => ({ id: "adv-posture", name: "Adversarial posture", category: "Reference", tags: ["test"], description: "A posture written by the adversarial tests of the validator.", source: "illustrative", support: "feet", grips: { L: "relaxed", R: "relaxed" }, ...over });
