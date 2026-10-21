// Segment strain for the skeleton colouring: each body segment scored from the angle bands of REBA (Hignett and McAtamney 2000) and, for the neck,
// RULA (McAtamney and Corlett 1993), and given a colour level: "low" (green), "medium" (yellow), "high" (red). Pure: reads metrics.js only, no DOM.
//
//   segmentStrain(metrics, options?) -> { trunk, neck, upperArm_L, upperArm_R, lowerArm_L, lowerArm_R, wrist_L, wrist_R, legs_L, legs_R }
//        each { label, score, max, level, why }; options: { seated } as in metrics.js rebaInputs
//   segmentOfBone(boneDef) -> the segment key that colours a skeleton.js BONES entry
//   boneLevels(strain) -> { boneId: level } for every bone of skeleton.js BONES
//
// Segment scores (the posture part of the worksheets, before their tables combine them; load, coupling and activity are not known to the model):
//   trunk      REBA: 1 upright, 2 for 0-20 degrees of flexion or extension, 3 for 20-60 or extension past 20, 4 past 60; +1 twisted or side bent
//   neck       RULA: 1 for 0-10 degrees of flexion, 2 for 10-20, 3 past 20, 4 in extension; +1 twisted, +1 side bent
//   upper arm  REBA / RULA: 1 within 20 degrees of hanging, 2 for 20-45 or extension past 20, 3 for 45-90, 4 past 90; +1 abducted, +1 shoulder raised
//   lower arm  REBA / RULA: 1 for 60-100 degrees of elbow flexion, 2 outside it (an arm hanging within 20 degrees scores 1: it is at rest, not working)
//   wrist      REBA: 1 within 15 degrees, 2 past it; +1 deviated or twisted
//   legs       REBA: 1 on both feet or seated, 2 on one foot or on neither; +1 for 30-60 degrees of knee flexion, +2 past 60 (not when seated)
// Colour levels: the lowest score (two lowest for trunk, neck and upper arm) is low, the next one medium, anything higher high. The modifiers that
// REBA states without a number (twisted, side bent, abducted, raised, deviated) use the thresholds of metrics.js REBA_BANDS.approx.
import { rebaInputs } from "./metrics.js";

export const STRAIN_LEVELS = Object.freeze(["low", "medium", "high"]);
export const STRAIN_COLORS = Object.freeze({ low: 0x22a55b, medium: 0xf2b705, high: 0xe5484d });

const levelOf = (score, lowMax, mediumMax) => (score == null ? null : score <= lowMax ? "low" : score <= mediumMax ? "medium" : "high");
const seg = (label, score, max, lowMax, mediumMax, why) => ({ label, score, max, level: levelOf(score, lowMax, mediumMax), why });
const deg = (x) => (x == null ? "?" : `${Math.round(x)} degrees`);

/** Score and colour level of every segment for a posture's metrics (metrics.js postureMetrics). */
export function segmentStrain(metrics, options) {
  const r = rebaInputs(metrics, options);
  const out = {};
  {
    const t = r.trunk, mod = t.twisted || t.sideBent ? 1 : 0;
    const score = t.bandIndex == null ? null : t.bandIndex + 1 + mod;
    out.trunk = seg("Trunk", score, 5, 2, 3, `${t.direction === "extension" ? "extension" : "flexion"} ${deg(Math.abs(t.angle ?? 0))}${t.twisted ? ", twisted" : ""}${t.sideBent ? ", side bent" : ""} (REBA trunk ${score ?? "?"})`);
  }
  {
    const n = r.neck, a = n.angle;
    const base = a == null ? null : a < -2 ? 4 : a <= 10 ? 1 : a <= 20 ? 2 : 3;
    const score = base == null ? null : base + (n.twisted ? 1 : 0) + (n.sideBent ? 1 : 0);
    out.neck = seg("Neck and head", score, 6, 2, 3, `${a != null && a < -2 ? "extension" : "flexion"} ${deg(Math.abs(a ?? 0))}${n.twisted ? ", twisted" : ""}${n.sideBent ? ", side bent" : ""} (RULA neck ${score ?? "?"})`);
  }
  for (const s of ["L", "R"]) {
    const side = s === "L" ? "left" : "right";
    const u = r.upperArm[s];
    const us = u.bandIndex == null ? null : u.bandIndex + 1 + (u.abducted ? 1 : 0) + (u.shoulderRaised ? 1 : 0);
    out[`upperArm_${s}`] = seg(`Upper arm (${side})`, us, 6, 2, 3, `${u.direction} ${deg(Math.abs(u.angle ?? 0))}${u.abducted ? ", abducted" : ""}${u.shoulderRaised ? ", shoulder raised" : ""} (REBA upper arm ${us ?? "?"})`);
    const l = r.lowerArm[s], resting = u.bandIndex === 0;
    const ls = l.bandIndex == null ? null : resting ? 1 : l.bandIndex + 1;
    out[`lowerArm_${s}`] = seg(`Lower arm (${side})`, ls, 2, 1, 2, resting ? `elbow flexion ${deg(l.angle)}, the arm hangs at rest` : `elbow flexion ${deg(l.angle)} (REBA lower arm ${ls ?? "?"})`);
    const w = r.wrist[s];
    const ws = w.bandIndex == null ? null : w.bandIndex + 1 + (w.deviated || w.twisted ? 1 : 0);
    out[`wrist_${s}`] = seg(`Wrist and hand (${side})`, ws, 3, 1, 2, `${(w.angle ?? 0) < 0 ? "extension" : "flexion"} ${deg(Math.abs(w.angle ?? 0))}${w.deviated ? ", deviated" : ""}${w.twisted ? ", twisted" : ""} (REBA wrist ${ws ?? "?"})`);
    const lg = r.legs, k = lg[s];
    const base = lg.seated || lg.support === "bilateral" ? 1 : 2;
    const add = lg.seated || k.bandIndex == null ? 0 : k.bandIndex;
    const ks = k.flexion == null && !lg.seated ? null : base + add;
    out[`legs_${s}`] = seg(`Leg (${side})`, ks, 4, 1, 2, lg.seated ? "seated" : `${lg.support === "bilateral" ? "on both feet" : lg.support === "unilateral" ? "on one foot" : "not on the feet"}, knee flexion ${deg(k.flexion)} (REBA legs ${ks ?? "?"})`);
  }
  return out;
}

/** The segment whose colour a skeleton.js BONES entry takes. */
export function segmentOfBone(def) {
  const j = def.joint, s = def.side ?? (j.endsWith("_L") ? "L" : j.endsWith("_R") ? "R" : null);
  if (/^C\d$/.test(j) || j === "head" || j === "jaw" || j.startsWith("eye")) return "neck";
  if (j === "pelvis" || /^[LT]\d+$/.test(j)) return "trunk";
  if (j.startsWith("clavicle") || j.startsWith("shoulder")) return `upperArm_${s}`;
  if (j.startsWith("elbow") || j.startsWith("forearm")) return `lowerArm_${s}`;
  if (/^(hip|knee|ankle|mtp)_/.test(j)) return `legs_${s}`;
  return `wrist_${s}`; // wrist, metacarpals and fingers
}

/** { boneId: "low" | "medium" | "high" | null } for every bone, from a segmentStrain result. */
export function boneLevels(strain, bones) {
  const out = {};
  for (const b of bones) out[b.id] = strain[segmentOfBone(b)]?.level ?? null;
  return out;
}
