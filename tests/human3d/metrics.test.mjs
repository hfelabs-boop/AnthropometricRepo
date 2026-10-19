// Tests of site/js/human/metrics.js (docs/human3d/METRICS.md): hand-computed cases on synthetic poses of fitted bodies, symmetry, invariance,
// all 176 population medians in 20+ poses, speed, allocation, the flags and the REBA bands, and the generated parts of the document.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/metrics.test.mjs"
// Regenerate the generated parts of docs/human3d/METRICS.md (the table of quantities and the table of neutral values) after a change:
//   UPDATE_DOCS=1 node --import ./tests/human3d/register.mjs --test "tests/human3d/metrics.test.mjs"
// The measured neutral values quoted in the assertions are those of the median US Army man (public/api/v1/populations/united-states/army/M.json, P50).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { JOINTS, clampAngles } from "../../site/js/human/skeleton.js";
import * as THREE from "three";
import { expandPosture, mirrorPose, clampPose, placePose, centerOfMass, landmarkPosition, solvePose } from "../../site/js/human/pose.js";
import { POSTURES } from "../../site/js/human/postures.js";
import { postureMetrics, metricKeys, metricsTable, METRIC_DEFS, ergonomicFlags, rebaInputs, REBA_BANDS, ISO_11226 } from "../../site/js/human/metrics.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POPS = path.join(ROOT, "public/api/v1/populations");
const DOC = path.join(ROOT, "docs/human3d/METRICS.md");
const popBody = (file, percentile = 50) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(file)), { percentile, meanStature: true }));
const army = (sex, percentile = 50) => popBody(path.join(POPS, "united-states/army", `${sex}.json`), percentile);
const man = army("M"), woman = army("F");

const near = (a, b, tol, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const posture = (p) => { const e = expandPosture(p); return { root: e.root, angles: e.angles }; };
const on = (body, pose, support = "feet") => postureMetrics(body, pose, placePose(body, pose, { support }));
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ---- the reference poses (valid angles, clamped anyway) ---------------------------------------------------------------------------------
const POSES = {
  neutral: {},
  "iso sitting": { joints: { hip_LR: [90], knee_LR: [90] } },
  "t-pose": { joints: { shoulder_LR: [0, 84] }, grips: { L: "open", R: "open" } },
  "arms forward": { joints: { shoulder_LR: [90] } },
  "arms overhead": { joints: { shoulder_LR: [170] } },
  "stoop 40": { root: { flex: 15 }, spine: { lumbar: [15, 0, 0], thoracic: [10, 0, 0] }, joints: { hip_LR: [15] } },
  "deep squat": { root: { flex: 20 }, joints: { hip_LR: [125], knee_LR: [140], ankle_LR: [30] }, spine: { lumbar: [10, 0, 0], thoracic: [15, 0, 0] } },
  "half kneeling": { joints: { hip_L: [95], knee_L: [95], hip_R: [10], knee_R: [120], ankle_R: [-30] } },
  supine: { root: { flex: -90 } },
  prone: { root: { flex: 90 } },
  "on the left side": { root: { lat: 90 } },
  "one leg": { joints: { hip_L: [60], knee_L: [90] } },
  "wide stance": { joints: { hip_LR: [0, 25, 0] } },
  "reclined 115": { root: { flex: -25 }, joints: { hip_LR: [90], knee_LR: [90] } },
  twist: { spine: { lumbar: [0, 0, 10], thoracic: [0, 0, 30] }, joints: { head: [0, 0, 8] } },
  "side bend": { spine: { lumbar: [0, 15, 0], thoracic: [0, 10, 0] }, joints: { head: [0, 6, 0] } },
  "looking up": { spine: { cervical: [-30, 0, 0] }, joints: { head: [-15], eye_LR: [20, 0] } },
  "looking down": { spine: { cervical: [30, 0, 0] }, joints: { head: [15], eye_LR: [-20, 0] } },
  "hands on head": { joints: { shoulder_LR: [150, 20, 0], elbow_LR: [120], wrist_LR: [20, 10], forearm_LR: [60] } },
  "heading 123": { root: { heading: 123, flex: 20, lat: 10 }, joints: { hip_R: [40], shoulder_L: [60, 30, 20], elbow_L: [90] } },
};
const reference = Object.entries(POSES).map(([name, p]) => [name, clampPose(posture(p)).pose]);

// ---- the shape of the output ----------------------------------------------------------------------------------------------------------
test("the keys of postureMetrics are metricKeys(), with the declared types", () => {
  const keys = metricKeys();
  assert.equal(new Set(keys).size, keys.length, "no duplicate key");
  assert.ok(keys.length > 70);
  const m = on(man, { root: {}, angles: {} });
  assert.deepEqual(Object.keys(m).sort(), [...keys].sort(), "the keys of the object are the keys of the definitions");
  for (const d of METRIC_DEFS) for (const k of d.sided ? [`${d.key}_L`, `${d.key}_R`] : [d.key]) {
    const x = m[k];
    if (x === null) continue;
    if (d.type === "bool") assert.equal(typeof x, "boolean", k);
    else if (d.type === "string") assert.equal(typeof x, "string", k);
    else assert.ok(typeof x === "number" && Number.isFinite(x), `${k} = ${x}`);
  }
  assert.ok(METRIC_DEFS.every((d) => d.def.length > 30 && d.label), "every quantity is defined");
  // every key the task lists exists
  for (const k of ["trunkInclination", "trunkFlexionRelativeToPelvis", "pelvisTilt", "lumbarFlexion", "thoracicFlexion", "neckInclination", "neckFlexion", "headTilt", "gazeElevation",
    "shoulderElevation_L", "upperArmInclination_R", "elbowAngle_L", "wristFlexion_L", "wristDeviation_R", "forearmPronation_L", "handHeightAboveFloor_R", "handToShoulderForward_L", "handReach_L",
    "reachFromAnkles_R", "handAboveShoulder_L", "handAboveHead_R", "hipAngle_L", "thighInclination_R", "kneeAngle_L", "shankInclination_R", "ankleAngle_L", "kneeHeight_R", "hipHeight",
    "pelvisHeight", "eyeHeight", "footSeparationMediolateral", "footSeparationAnteroposterior", "stanceWidth", "comHeight", "comOverBase", "legSupport", "seatHeight"]) assert.ok(keys.includes(k), k);
});

test("the output is reused with options.out, and a missing root is placed on the floor by the feet", () => {
  const pose = posture(POSES["iso sitting"]);
  const out = { stale: 1 };
  const m = postureMetrics(man, pose, placePose(man, pose, { support: "feet" }), { out });
  assert.equal(m, out);
  assert.ok(!("stale" in m) || m.stale === 1, "other keys are left alone");
  const m2 = postureMetrics(man, pose); // no root: feet on the floor
  assert.ok(Math.abs(m2.hipHeight - m.hipHeight) < 1e-9, "same placement as placePose with support feet");
  const m3 = postureMetrics(man, pose, { heading: 40 }); // an orientation without a position: placed
  near(wrap(m3.bodyHeading - 40), 0, 1e-9, "heading kept");
  near(m3.hipHeight, m.hipHeight, 1e-9, "placed on the floor");
  assert.throws(() => postureMetrics(man, { root: {}, angles: { bogus: [1] } }, { y: 0 }), /unknown joint/);
});

// ---- hand-computed cases --------------------------------------------------------------------------------------------------------------
test("standing neutral: upright trunk, straight legs, flat feet (measured values of the median man)", () => {
  const m = on(man, { root: {}, angles: {} });
  // trunk: C7/T1 is 5 mm behind the hip centres in the model's neutral spine (balanced posture): -0.5 degrees
  near(m.trunkInclination, 0, 1.5, "trunk inclination");
  near(m.trunkInclinationSide, 0, 1e-6); near(m.trunkInclinationTotal, 0, 1.5); near(m.thoraxInclination, 0, 1e-6);
  near(m.trunkLateralFlexion, 0, 1e-6); near(m.trunkTwist, 0, 1e-6); near(m.lumbarFlexion, 0, 1e-6); near(m.thoracicFlexion, 0, 1e-6);
  near(m.trunkFlexionRelativeToPelvis, 0, 1.5);
  // the pelvis of the model is tilted forward by 17 degrees (clinical standing values 5 to 15), the neck line 37 degrees (craniovertebral angle 53)
  near(m.pelvisTilt, 17, 4, "pelvic tilt"); near(m.neckInclination, 37, 6, "neck inclination");
  near(m.headInclination, 0, 1e-6); near(m.neckFlexion, 0, 1.5); near(m.headTilt, 0, 1e-6); near(m.gazeElevation, 0, 1e-6, "neutral gaze");
  // legs: hip 179.5; the model's neutral shank leans forward about the ankle (fit.js leanLegs, quiet standing): knee 174.3, ankle 84.3, shank -5.7
  near(m.hipAngle_L, 180, 3, "hip"); near(m.thighInclination_L, -90, 1e-6);
  near(m.kneeAngle_L, 180, 8, "knee"); near(m.ankleAngle_L, 90, 8, "ankle"); near(m.shankInclination_L, 0, 8, "shank");
  assert.ok(m.kneeAngle_L > 168 && m.ankleAngle_L < 90 && m.shankInclination_L < 0, "the lean is forward about the ankle");
  // arms hang: 3 to 14 degrees of rest abduction, straight elbow, hand below the hip
  near(m.upperArmInclination_L, 6.4, 8, "arm hangs"); assert.ok(m.upperArmInclination_L > 2 && m.shoulderAbduction_L > 2);
  near(m.elbowAngle_L, 180, 0.01); assert.ok(m.handHeightAboveFloor_L > 0.6 && m.handHeightAboveFloor_L < 0.9);
  assert.equal(m.handAboveShoulder_L, false); assert.equal(m.handAboveHead_R, false);
  // heights: the pelvis at hip height, the eye of a 1.76 m man at about 1.63 m, the sit bones 6 cm under the hip centres
  near(m.pelvisHeight, man.joints.pelvis.offset[1], 1e-6, "pelvis height is the pelvis joint's");
  near(m.eyeHeight, man.stature - 0.12, 0.03); near(m.pelvisHeight - m.seatHeight, 0.066, 0.02);
  assert.ok(m.comHeight > 0.5 * m.eyeHeight * 0.9 && m.comHeight < 0.65 * m.eyeHeight, `centre of mass height ${m.comHeight}`);
  // both feet down, the weight shared, the centre of mass inside the foot base
  assert.equal(m.legSupport, "both"); near(m.weightShareLeft, 0.5, 1e-6);
  assert.ok(m.comOverBase > 0.03 && m.comOverBase < 0.15, `balance margin ${m.comOverBase}`);
  near(m.footSeparationMediolateral, 2 * man.joints.hip_L.offset[0], 0.01); near(m.footSeparationAnteroposterior, 0, 1e-6);
  assert.ok(m.stanceWidth > m.footSeparationMediolateral && m.stanceWidth < 0.35 && m.stanceLength > 0.18 && m.stanceLength < 0.3);
  near(m.bodyHeading, 0, 1e-9);
});

test("the ISO 7250-1 seated posture: hips 90, thighs horizontal, knees 90 (the shank lean of the neutral pose included)", () => {
  const m = on(man, posture(POSES["iso sitting"]), "seat+feet");
  near(m.hipAngle_L, 90, 2, "hip"); near(m.hipAngle_R, 90, 2);
  near(m.thighInclination_L, 0, 1e-6, "thigh horizontal"); near(m.thighInclination_R, 0, 1e-6);
  near(m.kneeAngle_L, 90, 8, "knee");
  near(m.kneeAngle_L, on(man, { root: {}, angles: {} }).kneeAngle_L - 90, 1e-6, "the knee DOF of 90 removes 90 degrees from the neutral included angle");
  near(m.shankInclination_L, 0, 8, "lower leg about vertical"); near(m.ankleAngle_L, 90, 8, "ankle");
  near(m.trunkInclination, 0, 1.5);
  // the seat plane is the popliteal height of the body (pose.js seatHeightFor), 0.35 to 0.45 m; the thighs are horizontal at the knee top
  assert.ok(m.seatHeight > 0.35 && m.seatHeight < 0.47, `seat height ${m.seatHeight}`);
  near(m.pelvisHeight - m.seatHeight, 0.066, 0.02);
  assert.ok(m.comOverBase < -0.1, `the weight is behind the feet: ${m.comOverBase}`);
  // the seated eye height of ISO 7250-1: eye about 0.77 m above the seat for this man
  assert.ok(m.eyeHeight - m.seatHeight > 0.7 && m.eyeHeight - m.seatHeight < 0.85, `sitting eye height ${m.eyeHeight - m.seatHeight}`);
  // the seat plane given: the sit bones and the thighs join the base of support
  const p = posture(POSES["iso sitting"]), root = placePose(man, p, { support: "seat+feet" });
  const withSeat = postureMetrics(man, p, root, { seatHeight: m.seatHeight });
  assert.ok(withSeat.comOverBase > m.comOverBase + 0.1, `a seat adds base: ${m.comOverBase} -> ${withSeat.comOverBase}`);
});

test("trunk flexion: the chord, the thorax and the pieces (pelvis tilt, lumbar, thoracic)", () => {
  // pelvis 15 forward about the hips with the thighs kept vertical (hip +15), lumbar 15, thoracic 10: the thorax is inclined by the sum, 40 degrees
  const m = on(man, posture(POSES["stoop 40"]));
  near(m.thoraxInclination, 40, 0.01, "thorax = root.flex + lumbar + thoracic");
  near(m.lumbarFlexion, 15, 0.01); near(m.thoracicFlexion, 10, 0.01);
  near(m.thighInclination_L, -90, 0.01);
  // the chord from the hips to C7 turns by the pelvis tilt plus about half of the spine's bend (a curved spine), not by the sum
  assert.ok(m.trunkInclination > 15 + 0.3 * 25 && m.trunkInclination < 40, `chord ${m.trunkInclination}`);
  near(m.trunkInclination, 15 + 25 / 2, 4, "chord about the pelvis plus half the spine");
  near(m.trunkFlexionRelativeToPelvis, m.trunkInclination - 15, 0.6, "relative to the pelvis = the chord minus the pelvis tilt (to the neutral offset)");
  assert.ok(m.hipAngle_L < 180 - 20 && m.hipAngle_L > 180 - 40, `hip angle ${m.hipAngle_L}`);
  near(m.trunkInclinationTotal, m.trunkInclination, 1e-6); near(m.trunkInclinationSide, 0, 1e-6);
  // a pure hip hinge: pelvis 40 forward, spine straight: chord = pelvis tilt (to 0.5 degrees of neutral offset), thorax the same
  const h = on(man, posture({ root: { flex: 40 }, joints: { hip_LR: [40] } }));
  near(h.trunkInclination, 40, 1.5, "hip hinge chord"); near(h.thoraxInclination, 40, 1e-6); near(h.lumbarFlexion, 0, 1e-6); near(h.trunkFlexionRelativeToPelvis, 0, 1.5);
  near(h.pelvisTilt, m.pelvisTilt + 25, 1.0, "pelvic tilt follows root.flex");
  // lumbar alone, 30 degrees: lumbarFlexion is the posture's region total
  const l = on(man, posture({ spine: { lumbar: [30, 0, 0] } }));
  near(l.lumbarFlexion, 30, 0.01); near(l.thoracicFlexion, 0, 0.01); near(l.thoraxInclination, 30, 0.01);
  assert.ok(l.trunkInclination > 15 && l.trunkInclination < 25, `chord ${l.trunkInclination}: the lumbar bend turns the chord by about two thirds`);
  const th = on(man, posture({ spine: { thoracic: [30, 0, 0] } }));
  near(th.thoracicFlexion, 30, 0.01); near(th.lumbarFlexion, 0, 0.01); assert.ok(th.trunkInclination > 5 && th.trunkInclination < 12, `chord ${th.trunkInclination}: the thoracic bend is mostly above the chord's middle`);
  // extension is negative
  const e = on(man, posture({ spine: { lumbar: [-20, 0, 0] } }));
  near(e.lumbarFlexion, -20, 0.01); assert.ok(e.trunkInclination < 0);
});

test("trunk lateral flexion and twist, neck and head angles", () => {
  const t = on(man, posture(POSES.twist));
  near(t.trunkTwist, 40, 0.1, "lumbar 10 + thoracic 30 turn the thorax 40 to the left");
  near(t.neckTwist, 8, 0.5, "head turn 8 against the thorax"); near(t.trunkLateralFlexion, 0, 0.5);
  const s = on(man, posture(POSES["side bend"]));
  near(s.trunkLateralFlexion, 25, 0.2, "bent 25 to the left"); assert.ok(s.trunkInclinationSide > 8 && s.trunkInclinationSide < 25);
  near(s.headTilt, 25 + 6, 1, "head tilt in the world"); near(s.neckSideBend, 6, 0.5, "head against the thorax"); near(s.trunkTwist, 0, 0.5);
  const up = on(man, posture(POSES["looking up"])), down = on(man, posture(POSES["looking down"]));
  assert.ok(up.neckFlexion < -30 && down.neckFlexion > 30, `neck flexion ${up.neckFlexion} / ${down.neckFlexion}`);
  near(up.headInclination, -45, 0.01, "head: cervical -30 and nod -15"); near(down.headInclination, 45, 0.01);
  near(up.neckFlexion, up.headInclination - up.trunkInclination, 1e-9);
  // the gaze: head -45 up plus the eyes 20 up (a positive neck angle looks down)
  near(up.gazeElevation, 45 + 20, 0.5, "gaze up"); near(down.gazeElevation, -45 - 20, 0.5, "gaze down");
  assert.ok(up.neckInclination < on(man, { root: {}, angles: {} }).neckInclination && down.neckInclination > 50);
});

test("arm raised 90 degrees forward: elevation 90, the hand at shoulder height", () => {
  const m = on(man, posture(POSES["arms forward"]));
  for (const s of ["L", "R"]) {
    near(m[`shoulderElevation_${s}`], 90, 1.5, "elevation"); near(m[`upperArmInclination_${s}`], 90, 1e-6);
    near(m[`shoulderFlexion_${s}`], 90, 2); near(m[`upperArmInclinationSagittal_${s}`], 90, 1);
    near(m[`handHeightAboveFloor_${s}`], m[`shoulderHeight_${s}`], 0.005, "hand height equals shoulder height");
    near(m[`handToShoulderUp_${s}`], 0, 0.005);
    assert.equal(m[`handAboveShoulder_${s}`], false);
    assert.ok(m[`handToShoulderForward_${s}`] > 0.55 && m[`handToShoulderForward_${s}`] < 0.75, "forward reach is the arm plus the hand");
    near(m[`handReach_${s}`], Math.hypot(m[`handToShoulderForward_${s}`], m[`handToShoulderLateral_${s}`]), 1e-9);
    near(m[`elbowAngle_${s}`], 180, 0.01);
    assert.ok(m[`reachFromAnkles_${s}`] > m[`handReach_${s}`] - 0.01);
  }
  assert.ok(m.shoulderAbduction_L > 3 && m.shoulderAbduction_L < 16 && m.shoulderAbduction_R > 3, "the neutral arm's rest abduction");
  assert.ok(m.handToShoulderLateral_L > 0 && m.handToShoulderLateral_R < 0, "the left hand is left of the left shoulder");
  // t-pose: arms out 84 degrees from the hanging neutral arm (the arm is horizontal within a few degrees): lateral reach
  const t = on(man, posture(POSES["t-pose"]));
  near(t.upperArmInclination_L, 90, 7, "t-pose arm horizontal"); near(t.shoulderAbduction_L, 90, 7); near(t.shoulderFlexion_L, 0, 3);
  assert.ok(t.handToShoulderLateral_L > 0.55 && t.handToShoulderLateral_R < -0.55 && Math.abs(t.handToShoulderForward_L) < 0.1);
  // overhead: 170 degrees, the hand above the head, extension tests
  const o = on(man, posture(POSES["arms overhead"]));
  assert.ok(o.upperArmInclination_L > 150 && o.handAboveHead_L && o.handAboveShoulder_L && o.handAboveHeadBy_L > 0, JSON.stringify([o.upperArmInclination_L, o.handAboveHeadBy_L]));
  assert.ok(o.handHeightAboveFloor_L > man.stature, "above the head top");
  // an arm swung back: negative sagittal part
  const b = on(man, posture({ joints: { shoulder_L: [-40, 0, 0] } }));
  assert.ok(b.upperArmInclinationSagittal_L < -30 && b.shoulderFlexion_L < -30, `${b.upperArmInclinationSagittal_L}`);
  near(b.shoulderFlexion_R, on(man, { root: {}, angles: {} }).shoulderFlexion_R, 1e-9, "the right arm is untouched");
  // forearm, elbow and wrist are the DOF values
  const w = on(man, posture({ joints: { elbow_L: [90], forearm_L: [40], wrist_L: [20, -10], clavicle_L: [12, 0] } }));
  near(w.elbowAngle_L, 90, 1, "the hinge axis is not exactly perpendicular to the abducted arm"); near(w.forearmPronation_L, 40, 1e-9); near(w.wristFlexion_L, 20, 1e-9); near(w.wristDeviation_L, -10, 1e-9); near(w.shrug_L, 12, 1e-9);
  near(w.elbowAngle_R, 180, 0.01);
});

test("leg angles: knee, ankle, thigh and shank inclinations, heights", () => {
  const sq = on(man, posture(POSES["deep squat"]));
  const n = on(man, { root: {}, angles: {} });
  near(sq.kneeAngle_L, n.kneeAngle_L - 140, 1e-6, "knee included angle is the rest angle minus the flexion DOF");
  near(sq.hipAngle_L, 180 - (125 - 20) - sq.trunkInclination, 0.7, "hip angle: the thigh is 105 degrees from hanging (hip 125 less the 20 of the pelvis tilt) against the trunk chord");
  near(sq.ankleAngle_L, n.ankleAngle_L - 30, 1e-6, "ankle: dorsiflexion 30");
  near(sq.thighInclination_L, 125 - 20 - 90, 1e-6, "hip flexion 125 less the pelvis tilt of 20: the knee is 15 degrees above the hip");
  assert.ok(sq.kneeHeight_L > 0.3 && sq.kneeHeight_L < 0.6 && sq.pelvisHeight < 0.5, `${sq.kneeHeight_L} ${sq.pelvisHeight}`);
  assert.equal(sq.legSupport, "both");
  // a plantar-flexed foot: the ankle angle opens past 90
  const pf = on(man, posture({ joints: { ankle_L: [-40], hip_L: [40] } }));
  near(pf.ankleAngle_L, n.ankleAngle_L + 40, 1e-6);
  // knee height of a standing man is about 0.52 m (ISO 7250-1 knee height is sitting: here the top of the knee when standing)
  near(n.kneeHeight_L, 0.52, 0.06); near(n.hipHeight, 0.91, 0.05);
  // thigh raised 60 degrees forward of the vertical is 30 below the horizontal
  const th = on(man, posture({ joints: { hip_L: [60] } }));
  near(th.thighInclination_L, -30, 1e-6); near(th.thighInclination_R, -90, 1e-6);
  const high = on(man, posture({ joints: { hip_L: [110] } }));
  near(high.thighInclination_L, 20, 1e-6, "knee above the hip: positive");
  // a foot behind: kneeling on the heels has the shank horizontal and the foot behind the knee
  const heels = on(man, posture({ joints: { hip_LR: [100], knee_LR: [150] } }));
  assert.ok(heels.shankInclination_L < -50 && heels.kneeAngle_L < 40, `${heels.shankInclination_L} ${heels.kneeAngle_L}`);
});

test("supine, prone and on the side: the lying postures keep their angles finite and sensible", () => {
  const sup = on(man, posture(POSES.supine), "body"), pro = on(man, posture(POSES.prone), "body"), side = on(man, posture(POSES["on the left side"]), "body");
  near(sup.trunkInclination, -90, 1.5, "supine: the trunk points behind the facing direction"); near(sup.trunkInclinationTotal, 90, 1.5); near(sup.trunkInclinationSide, 0, 1e-6);
  near(pro.trunkInclination, 90, 1.5); near(pro.trunkInclinationSide, 0, 1e-6);
  near(side.trunkInclinationSide, 90, 1.5, "on the left side the trunk points to the figure's left"); near(side.trunkInclination, 0, 1.5);
  near(sup.gazeElevation, 90, 1e-6, "lying on the back looks up"); near(pro.gazeElevation, -90, 1e-6); near(side.gazeElevation, 0, 1e-6);
  near(sup.headInclination, -90, 1e-6); near(pro.headInclination, 90, 1e-6); near(side.headTilt, 90, 1e-6);
  near(sup.neckFlexion, on(man, { root: {}, angles: {} }).neckFlexion, 1e-6, "lying changes nothing relative to the trunk");
  // the body is low: every height under 0.4 m, the centre of mass at the height of the lying body
  for (const m of [sup, pro, side]) { assert.ok(m.pelvisHeight < 0.3 && m.eyeHeight < 0.3 && m.comHeight < 0.3, JSON.stringify([m.pelvisHeight, m.eyeHeight, m.comHeight])); assert.equal(m.legSupport, "none"); assert.equal(m.comOverBase, null); }
  near(sup.trunkFlexionRelativeToPelvis, 0, 1.5, "the spine is straight against the pelvis"); near(sup.lumbarFlexion, 0, 1e-6);
  near(sup.bodyHeading, 0, 1e-6); near(pro.bodyHeading, 0, 1e-6); near(side.bodyHeading, 0, 1e-6, "on the side the pelvis anterior axis gives the heading");
  assert.ok(sup.handToShoulderUp_L < 0.01 && sup.handToShoulderForward_L > 0.5);
});

test("weight on one leg: the raised foot carries nothing", () => {
  const m = on(man, posture(POSES["one leg"]));
  assert.equal(m.legSupport, "right"); near(m.weightShareLeft, 0, 1e-9);
  const r = on(man, mirrorPose(posture(POSES["one leg"])));
  assert.equal(r.legSupport, "left"); near(r.weightShareLeft, 1, 1e-9);
  // wide stance: both down, the stance is wider than the neutral one
  const w = on(man, posture(POSES["wide stance"]));
  const n = on(man, { root: {}, angles: {} });
  assert.ok(w.stanceWidth > n.stanceWidth && w.footSeparationMediolateral > n.footSeparationMediolateral + 0.3, `${w.stanceWidth} ${w.footSeparationMediolateral}`);
  assert.equal(w.legSupport, "both"); near(w.weightShareLeft, 0.5, 1e-6);
  // weight shifted by bending the trunk sideways: toward the side of the bend (statics: the centre of mass moves over that foot)
  const left = on(man, posture({ spine: { lumbar: [0, 25, 0], thoracic: [0, 20, 0] } })), right = on(man, posture({ spine: { lumbar: [0, -25, 0], thoracic: [0, -20, 0] } }));
  assert.ok(left.weightShareLeft > 0.65 && left.legSupport === "left", `${left.weightShareLeft}`);
  assert.ok(right.weightShareLeft < 0.35 && right.legSupport === "right", `${right.weightShareLeft}`);
  near(left.weightShareLeft + right.weightShareLeft, 1, 0.25);
  assert.ok(left.trunkInclinationSide > 10 && right.trunkInclinationSide < -10);
});

test("centre of mass height and balance margin agree with pose.js", () => {
  for (const [name, pose] of reference.slice(0, 8)) {
    const root = placePose(man, pose, { support: name === "supine" || name === "prone" ? "body" : "feet" });
    const m = postureMetrics(man, pose, root), c = centerOfMass(man, pose, root);
    near(m.comHeight, c.point.y, 1e-12, name);
  }
});

test("cross-check: the heights and distances agree with pose.js landmarkPosition", () => {
  const rand = rng(5);
  for (const pose of [...reference.map(([, p]) => p).slice(0, 10), ...Array.from({ length: 8 }, () => randomPose(rand))]) {
    const root = placePose(man, pose, { support: "feet" }), m = postureMetrics(man, pose, root);
    const P = (id) => landmarkPosition(man, pose, root, id), J = (id) => solvePose(man, pose, root).position(id);
    near(m.eyeHeight, P("eye_mid").y, 1e-12); near(m.hipHeight, (P("trochanterion_L").y + P("trochanterion_R").y) / 2, 1e-12);
    near(m.seatHeight, (P("ischial_L").y + P("ischial_R").y) / 2, 1e-12); near(m.kneeHeight_R, P("knee_top_R").y, 1e-12);
    near(m.handHeightAboveFloor_L, P("palm_centre_L").y, 1e-12); near(m.pelvisHeight, J("pelvis").y, 1e-12);
    near(m.shoulderHeight_R, J("shoulder_R").y, 1e-12);
    const palm = P("palm_centre_R"), sh = J("shoulder_R"), an = J("ankle_L").add(J("ankle_R")).multiplyScalar(0.5);
    near(m.handReach_R, Math.hypot(palm.x - sh.x, palm.z - sh.z), 1e-12); near(m.reachFromAnkles_R, Math.hypot(palm.x - an.x, palm.z - an.z), 1e-12);
    near(m.handToShoulderUp_R, palm.y - sh.y, 1e-12); near(m.handAboveHeadBy_R, palm.y - P("vertex").y, 1e-12);
    const k = J("knee_L"), h = J("hip_L"), a = J("ankle_L");
    near(m.kneeAngle_L, h.clone().sub(k).angleTo(a.clone().sub(k)) * 180 / Math.PI, 1e-6, "knee angle");
    near(m.thighInclination_L, Math.asin(k.clone().sub(h).normalize().y) * 180 / Math.PI, 1e-6, "thigh");
    const e = J("elbow_R"), w = J("wrist_R");
    near(m.elbowAngle_R, sh.clone().sub(e).angleTo(w.clone().sub(e)) * 180 / Math.PI, 1e-6, "elbow angle");
    near(m.upperArmInclination_R, e.clone().sub(sh).angleTo(new THREE.Vector3(0, -1, 0)) * 180 / Math.PI, 1e-6, "upper arm from the vertical");
  }
});

// ---- symmetry and invariance ----------------------------------------------------------------------------------------------------------
const NEGATED = new Set(["bodyHeading", "trunkInclinationSide", "trunkLateralFlexion", "trunkTwist", "headTilt", "neckSideBend", "neckTwist", "footSeparationAnteroposterior"]);
const NEGATED_SIDED = new Set(["handToShoulderLateral"]);
function randomPose(rand) {
  const angles = {};
  for (const j of JOINTS) {
    if (j.id === "pelvis") continue;
    if (/_(mcp|pip|dip|cmc|ip)_/.test(j.id) || j.id.startsWith("thumb")) continue;
    const a = j.dof.map((d) => (d.min + rand() * (d.max - d.min)) * 0.6);
    angles[j.id] = clampAngles(j.id, a).angles;
  }
  return { root: { heading: (rand() - 0.5) * 200, flex: (rand() - 0.5) * 50, lat: (rand() - 0.5) * 40, rot: (rand() - 0.5) * 40 }, angles };
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("mirror symmetry: the metrics of the mirrored pose are those of the original with the sides swapped", () => {
  const rand = rng(7);
  const poses = [...reference.map(([, p]) => p), ...Array.from({ length: 12 }, () => randomPose(rand))];
  for (const pose of poses) {
    const mir = mirrorPose(pose);
    const a = postureMetrics(man, pose, placePose(man, pose, { support: "feet" })), b = postureMetrics(man, mir, placePose(man, mir, { support: "feet" }));
    for (const d of METRIC_DEFS) {
      for (const k of d.sided ? [d.key + "_L", d.key + "_R"] : [d.key]) {
        const other = d.sided ? (k.endsWith("_L") ? `${d.key}_R` : `${d.key}_L`) : k;
        let want = a[other];
        if (typeof want === "number") {
          if (NEGATED.has(d.key) || (d.sided && NEGATED_SIDED.has(d.key))) want = -want;
          if (d.key === "weightShareLeft") want = 1 - want;
          const got = b[k];
          if (d.key === "bodyHeading") assert.ok(Math.abs(wrap(got - want)) < 1e-6, `${k}: ${got} vs ${want}`);
          else assert.ok(Math.abs(got - want) < 1e-6, `${k}: ${got} vs ${want}`);
        } else if (d.key === "legSupport") assert.equal(b[k], a[k] === "left" ? "right" : a[k] === "right" ? "left" : a[k], k);
        else assert.equal(b[k], want, k);
      }
    }
  }
});

test("invariance to the heading and the position of the body in the world", () => {
  const rand = rng(11);
  const poses = [...reference.map(([, p]) => p), ...Array.from({ length: 10 }, () => randomPose(rand))];
  for (const pose of poses) {
    const root = placePose(man, pose, { support: "feet" });
    const a = postureMetrics(man, pose, root);
    const moved = { ...root, heading: root.heading + 57, x: root.x + 1.3, z: root.z - 0.7 };
    const p2 = { ...pose, root: { ...pose.root, heading: (pose.root.heading ?? 0) + 57 } };
    const b = postureMetrics(man, p2, moved);
    for (const k of metricKeys()) {
      if (k === "bodyHeading") { near(wrap(b[k] - a[k] - 57), 0, 1e-6, k); continue; }
      if (typeof a[k] === "number") near(b[k], a[k], 1e-6, k); else assert.equal(b[k], a[k], k);
    }
  }
});

test("the same body model gives the same numbers whatever the form: woman, tall man, short woman", () => {
  for (const b of [woman, army("M", 95), army("F", 5)]) {
    const m = on(b, { root: {}, angles: {} });
    near(m.trunkInclination, 0, 2); near(m.headInclination, 0, 1e-6); near(m.hipAngle_L, 180, 3); near(m.elbowAngle_L, 180, 0.01);
    assert.equal(m.legSupport, "both"); assert.ok(m.comOverBase > 0);
  }
});

// ---- finiteness over the 176 population medians --------------------------------------------------------------------------------------
test("finite for all 176 population medians in 20 reference poses", () => {
  const files = [];
  for (const c of fs.readdirSync(POPS)) for (const r of fs.readdirSync(path.join(POPS, c))) for (const f of fs.readdirSync(path.join(POPS, c, r))) if (/^(M|F|both)\.json$/.test(f)) files.push(path.join(POPS, c, r, f));
  assert.equal(files.length, 176);
  assert.ok(reference.length >= 20);
  const keys = metricKeys();
  const neutral = { trunk: [], ankle: [], knee: [], arm: [] };
  let calls = 0;
  for (const f of files) {
    const b = popBody(f);
    for (const [name, pose] of reference) {
      const support = name === "supine" || name === "prone" || name === "on the left side" ? "body" : "feet";
      const m = postureMetrics(b, pose, placePose(b, pose, { support }));
      calls++;
      for (const k of keys) {
        const x = m[k];
        assert.ok(x !== undefined, `${path.basename(path.dirname(f))} ${name}: ${k} missing`);
        if (typeof x === "number") assert.ok(Number.isFinite(x), `${f} ${name}: ${k} = ${x}`);
        else assert.ok(x === null || typeof x === "boolean" || typeof x === "string", `${name} ${k} ${x}`);
      }
      // the angles stay in their ranges
      for (const k of keys) if (/(Angle|Inclination|Flexion|Tilt|Twist|Elevation)/.test(k) && typeof m[k] === "number" && !/^(thigh)/.test(k)) assert.ok(m[k] >= -180.0001 && m[k] <= 180.0001, `${name} ${k} ${m[k]}`);
      for (const k of keys) if (/^(shoulderElevation|elbowAngle|hipAngle|kneeAngle|ankleAngle|trunkInclinationTotal|upperArmInclination_)/.test(k) && typeof m[k] === "number") assert.ok(m[k] >= 0 && m[k] <= 180.0001, `${name} ${k} ${m[k]}`);
      if (name === "neutral") { neutral.trunk.push(m.trunkInclination); neutral.ankle.push(m.ankleAngle_L); neutral.knee.push(m.kneeAngle_L); neutral.arm.push(m.upperArmInclination_L); assert.equal(m.legSupport, "both"); }
    }
  }
  assert.equal(calls, 176 * reference.length);
  // the neutral standing pose of every population median: the trunk upright within 1.5 degrees, the lean about the ankle 3 to 8 degrees
  assert.ok(Math.min(...neutral.trunk) > -1.5 && Math.max(...neutral.trunk) < 1.5, `trunk ${Math.min(...neutral.trunk)} ${Math.max(...neutral.trunk)}`);
  assert.ok(Math.min(...neutral.ankle) > 80 && Math.max(...neutral.ankle) < 90, `ankle ${Math.min(...neutral.ankle)} ${Math.max(...neutral.ankle)}`);
  assert.ok(Math.min(...neutral.knee) > 170 && Math.max(...neutral.knee) < 180, `knee ${Math.min(...neutral.knee)} ${Math.max(...neutral.knee)}`);
});

test("finite for every posture of the library on the median man and woman, and for random poses", () => {
  for (const p of POSTURES) {
    let pose;
    try { const e = expandPosture(p); pose = { root: e.root, angles: e.angles }; } catch { continue; } // an invalid posture is the validator's business (postures.test.mjs)
    for (const b of [man, woman]) {
      const m = postureMetrics(b, pose, placePose(b, pose, { posture: p }));
      for (const k of metricKeys()) assert.ok(m[k] === null || typeof m[k] !== "number" || Number.isFinite(m[k]), `${p.id} ${k} = ${m[k]}`);
      assert.ok(ergonomicFlags(m).every((f) => Number.isFinite(f.value)), p.id);
      assert.ok(rebaInputs(m).trunk, p.id);
    }
  }
  const rand = rng(3);
  for (let i = 0; i < 200; i++) {
    const pose = randomPose(rand), m = postureMetrics(man, pose, placePose(man, pose, { support: "feet" }));
    for (const k of metricKeys()) assert.ok(m[k] === null || typeof m[k] !== "number" || Number.isFinite(m[k]), `random ${i} ${k} = ${m[k]}`);
    assert.ok(ergonomicFlags(m).length > 10);
  }
});

test("a body without masses or with missing landmarks gives null where it cannot know, and never throws", () => {
  const b = JSON.parse(JSON.stringify({ ...man, masses: undefined }));
  const m = on(b, { root: {}, angles: {} });
  assert.equal(m.comHeight, null); assert.equal(m.comOverBase, null); assert.equal(m.weightShareLeft, null);
  assert.equal(m.legSupport, null, "unknown without masses when a foot is down");
  near(m.trunkInclination, 0, 1.5);
  const noLm = { ...man, landmarks: Object.fromEntries(Object.entries(man.landmarks).filter(([id]) => !/^(palm_centre|ASIS|heel_sole|cervicale|vertex|knee_top|eye_mid|ischial|trochanterion)/.test(id))) };
  const n = postureMetrics(noLm, { root: {}, angles: {} }, { x: 0, y: 0.9, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
  for (const k of ["pelvisTilt", "neckInclination", "handHeightAboveFloor_L", "ankleAngle_L", "kneeHeight_L", "hipHeight", "eyeHeight", "seatHeight", "stanceWidth", "handAboveHeadBy_R"]) assert.equal(n[k], null, k);
  assert.equal(n.handAboveShoulder_L, false);
  assert.ok(Number.isFinite(n.trunkInclination) && Number.isFinite(n.elbowAngle_L));
  const s = syntheticBody(1.75, "male");
  const ms = on(s, posture(POSES["iso sitting"]), "seat+feet");
  near(ms.hipAngle_L, 90, 2);
});

// ---- speed and allocation -------------------------------------------------------------------------------------------------------------
test("speed: below 0.3 ms per call (the body is cached after the first call)", () => {
  const pose = reference.find(([n]) => n === "hands on head")[1], root = placePose(man, pose, { support: "feet" }), out = {};
  for (let i = 0; i < 500; i++) postureMetrics(man, pose, root, { out });
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const N = 2000, t = performance.now();
    for (let i = 0; i < N; i++) postureMetrics(man, pose, root, { out });
    best = Math.min(best, (performance.now() - t) / N);
  }
  console.log(`# postureMetrics: ${(best * 1000).toFixed(0)} microseconds per call`);
  assert.ok(best < 0.3, `${best} ms per call`);
  // without a root the body is placed first (placePose, about 0.1 ms more)
  let bestP = Infinity;
  for (let r = 0; r < 3; r++) { const N = 500, t = performance.now(); for (let i = 0; i < N; i++) postureMetrics(man, pose, undefined, { out }); bestP = Math.min(bestP, (performance.now() - t) / N); }
  assert.ok(bestP < 0.6, `placing: ${bestP} ms per call`);
});

test("no allocation explosion: 60,000 calls with options.out keep the heap flat", () => {
  const pose = reference.find(([n]) => n === "deep squat")[1], root = placePose(man, pose, { support: "feet" }), out = {};
  for (let i = 0; i < 2000; i++) postureMetrics(man, pose, root, { out });
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let peak = 0;
  for (let i = 0; i < 60000; i++) { postureMetrics(man, pose, root, { out }); if (i % 5000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - before); }
  if (global.gc) global.gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(peak < 96 * 1048576 && grown < 32 * 1048576, `heap grew ${(grown / 1048576).toFixed(1)} MB (peak ${(peak / 1048576).toFixed(1)} MB)`);
  // the per-body table is cached: a second body does not disturb the first
  const a = postureMetrics(man, pose, root), b = postureMetrics(woman, pose, placePose(woman, pose, { support: "feet" })), c = postureMetrics(man, pose, root);
  assert.deepEqual(a, c); assert.notEqual(a.eyeHeight, b.eyeHeight);
});

// ---- flags -----------------------------------------------------------------------------------------------------------------------------
const flagOf = (flags, id) => flags.find((f) => f.id === id);
test("ergonomicFlags: ISO 11226 limits at their edges", () => {
  const neutral = on(man, { root: {}, angles: {} });
  const fl = ergonomicFlags(neutral);
  assert.ok(fl.length >= 12 && fl.every((f) => ["ok", "caution", "high"].includes(f.severity)), "all flags have a severity");
  assert.deepEqual(fl.filter((f) => f.severity !== "ok").map((f) => f.id), [], "the neutral pose raises nothing");
  for (const f of fl) { assert.ok(f.id && f.label && f.note.includes("not a risk assessment") && Number.isFinite(f.value), f.id); assert.ok(f.note.length < 400, f.id); }
  const base = { ...neutral, trunkLateralFlexion: 0, trunkTwist: 0 };
  const trunk = (deg, o) => flagOf(ergonomicFlags({ ...base, trunkInclination: deg }, o), "trunk-inclination");
  assert.equal(trunk(0).severity, "ok"); assert.equal(trunk(20).severity, "ok", "up to 20 acceptable"); assert.equal(trunk(20.1).severity, "caution", "20 to 60 conditional");
  assert.equal(trunk(60).severity, "caution"); assert.equal(trunk(60.1).severity, "high", "over 60 not recommended");
  assert.equal(trunk(45, { trunkSupport: true }).severity, "ok", "full trunk support makes 20 to 60 acceptable");
  assert.equal(trunk(80, { trunkSupport: true }).severity, "high");
  assert.equal(trunk(-1).severity, "ok", "within the tolerance of the neutral");
  assert.equal(trunk(-10).severity, "caution", "backward: depends on support"); assert.equal(trunk(-10, { trunkSupport: true }).severity, "ok"); assert.equal(trunk(-10, { trunkSupport: false }).severity, "high");
  assert.match(trunk(45).note, /Table 2/); assert.match(trunk(70).note, /Table 1/);
  // symmetry
  const sym = (lat, tw) => flagOf(ergonomicFlags({ ...base, trunkLateralFlexion: lat, trunkTwist: tw }), "trunk-symmetry");
  assert.equal(sym(0, 0).severity, "ok"); assert.equal(sym(0, 11).severity, "caution"); assert.equal(sym(-25, 0).severity, "high");
  // head and neck
  const head = (deg, o) => flagOf(ergonomicFlags({ ...base, headInclination: deg }, o), "head-inclination");
  assert.equal(head(25).severity, "ok"); assert.equal(head(26).severity, "caution"); assert.equal(head(86).severity, "high"); assert.equal(head(-10).severity, "high");
  assert.equal(head(-10, { headSupport: true }).severity, "ok"); assert.equal(head(40, { trunkSupport: true }).severity, "ok");
  const neck = (deg) => flagOf(ergonomicFlags({ ...base, neckFlexion: deg }), "neck-flexion");
  assert.equal(neck(25).severity, "ok"); assert.equal(neck(30).severity, "caution"); assert.equal(neck(41).severity, "high"); assert.equal(neck(-10).severity, "caution");
  // upper arm
  const arm = (el, sag, o) => flagOf(ergonomicFlags({ ...base, upperArmInclination_L: el, upperArmInclinationSagittal_L: sag }, o), "upper-arm-elevation-L");
  assert.equal(arm(20, 20).severity, "ok"); assert.equal(arm(21, 21).severity, "caution"); assert.equal(arm(60, 60).severity, "caution"); assert.equal(arm(61, 61).severity, "high");
  assert.equal(arm(40, 40, { armSupport: true }).severity, "ok"); assert.equal(arm(40, 40, { armSupport: { L: false, R: true } }).severity, "caution"); assert.equal(arm(40, 40, { armSupport: { L: true } }).severity, "ok");
  assert.equal(arm(30, -30).severity, "high", "extension over 20 degrees"); assert.equal(arm(15, -15).severity, "ok");
  assert.match(arm(40, 40).note, /2\.5 min/);
  // elbow, wrist, knee
  const mm = (o) => ergonomicFlags({ ...base, ...o });
  assert.equal(flagOf(mm({ elbowAngle_L: 90, upperArmInclination_L: 40 }), "elbow-L").severity, "ok");
  assert.equal(flagOf(mm({ elbowAngle_L: 120, upperArmInclination_L: 40 }), "elbow-L").severity, "ok");
  assert.equal(flagOf(mm({ elbowAngle_L: 121, upperArmInclination_L: 40 }), "elbow-L").severity, "caution"); assert.equal(flagOf(mm({ elbowAngle_L: 79, upperArmInclination_L: 40 }), "elbow-L").severity, "caution");
  assert.equal(flagOf(mm({ elbowAngle_L: 180, upperArmInclination_L: 5 }), "elbow-L").severity, "ok", "a hanging arm is not scored");
  assert.equal(flagOf(mm({ wristFlexion_L: -15 }), "wrist-flexion-L").severity, "ok"); assert.equal(flagOf(mm({ wristFlexion_L: -16 }), "wrist-flexion-L").severity, "caution");
  assert.equal(flagOf(mm({ wristDeviation_L: 11 }), "wrist-deviation-L").severity, "caution");
  const knee = (ka, o) => flagOf(ergonomicFlags({ ...base, kneeAngle_L: ka, comOverBase: 0.05, ...o }), "knee-flexion-L");
  assert.equal(knee(150).severity, "ok"); assert.equal(knee(149).severity, "caution"); assert.equal(knee(120).severity, "caution"); assert.equal(knee(119).severity, "high");
  assert.equal(knee(90, { comOverBase: -0.2 }).severity, "ok", "seated: knee flexion not scored"); assert.equal(knee(90, { comOverBase: null }).severity, "ok");
  assert.equal(flagOf(ergonomicFlags({ ...base, kneeAngle_L: 90, comOverBase: -0.2 }, { seated: false }), "knee-flexion-L").severity, "high");
  // null metrics are left out
  assert.equal(flagOf(ergonomicFlags({ ...base, headInclination: null }), "head-inclination"), undefined);
  // the limits are data
  assert.equal(ISO_11226.trunk.acceptable, 20); assert.equal(ISO_11226.trunk.notRecommended, 60); assert.equal(ISO_11226.upperArm.notRecommended, 60);
});

test("ergonomicFlags on real postures", () => {
  const sev = (name, id, o, support = "feet") => flagOf(ergonomicFlags(on(man, posture(POSES[name]), support), o), id).severity;
  assert.equal(sev("iso sitting", "trunk-inclination", undefined, "seat+feet"), "ok");
  assert.deepEqual(ergonomicFlags(on(man, posture(POSES["iso sitting"]), "seat+feet")).filter((f) => f.severity !== "ok").map((f) => f.id), [], "ISO sitting: nothing raised (knees: seated)");
  const stoop = posture({ root: { flex: 45 }, joints: { hip_LR: [45] } });
  assert.equal(flagOf(ergonomicFlags(on(man, stoop)), "trunk-inclination").severity, "caution");
  assert.equal(flagOf(ergonomicFlags(on(man, posture({ root: { flex: 70 }, joints: { hip_LR: [70] } }))), "trunk-inclination").severity, "high");
  assert.equal(sev("arms forward", "upper-arm-elevation-L"), "high"); assert.equal(sev("arms overhead", "upper-arm-elevation-R"), "high");
  assert.equal(sev("arms forward", "upper-arm-elevation-L", { armSupport: true }), "high", "over 60 is not recommended even with support");
  assert.equal(sev("deep squat", "knee-flexion-L"), "high");
  assert.equal(sev("looking down", "head-inclination"), "caution"); assert.equal(sev("looking up", "head-inclination"), "high");
  assert.equal(sev("twist", "trunk-symmetry"), "high");
  assert.equal(sev("supine", "trunk-inclination", { trunkSupport: true }, "body"), "ok");
});

// ---- REBA bands ------------------------------------------------------------------------------------------------------------------------
test("rebaInputs: the angle bands at their edges, no scores", () => {
  const neutral = on(man, { root: {}, angles: {} });
  const r0 = rebaInputs(neutral);
  assert.equal(r0.trunk.bandIndex, 0); assert.equal(r0.neck.bandIndex, 0); assert.equal(r0.legs.support, "bilateral"); assert.equal(r0.legs.seated, false);
  assert.equal(r0.upperArm.L.bandIndex, 0); assert.equal(r0.lowerArm.L.bandIndex, 1, "a straight elbow is under 60 degrees of flexion"); assert.equal(r0.wrist.L.bandIndex, 0);
  assert.equal(r0.legs.L.bandIndex, 0); assert.ok(r0.source.includes("Hignett") && r0.source.includes("no scores"));
  assert.ok(!JSON.stringify(r0).includes('"score"'), "no score in the data");
  const base = { ...neutral };
  const t = (a) => rebaInputs({ ...base, trunkInclination: a }).trunk;
  assert.equal(t(0).bandIndex, 0); assert.equal(t(10).bandIndex, 1); assert.equal(t(20).bandIndex, 1); assert.equal(t(20.1).bandIndex, 2); assert.equal(t(60).bandIndex, 2); assert.equal(t(60.1).bandIndex, 3);
  assert.equal(t(-10).bandIndex, 1); assert.equal(t(-10).direction, "extension"); assert.equal(t(-21).bandIndex, 2, "extension over 20 scores like 20 to 60 flexion");
  const n = (a) => rebaInputs({ ...base, neckFlexion: a }).neck;
  assert.equal(n(0).bandIndex, 0); assert.equal(n(20).bandIndex, 0); assert.equal(n(20.1).bandIndex, 1); assert.equal(n(-10).bandIndex, 1); assert.equal(n(-10).direction, "extension");
  const u = (el, fl, ab = 0) => rebaInputs({ ...base, shoulderElevation_L: el, shoulderFlexion_L: fl, shoulderAbduction_L: ab }).upperArm.L;
  assert.equal(u(20, 20).bandIndex, 0); assert.equal(u(20.1, 20.1).bandIndex, 1); assert.equal(u(45, 45).bandIndex, 1); assert.equal(u(45.1, 45.1).bandIndex, 2);
  assert.equal(u(90, 90).bandIndex, 2); assert.equal(u(90.1, 90.1).bandIndex, 3);
  assert.equal(u(15, -15).bandIndex, 0); assert.equal(u(21, -21).bandIndex, 1); assert.equal(u(21, -21).direction, "extension"); assert.equal(u(50, -5, 49).direction, "flexion", "raised sideways is not extension");
  assert.equal(u(50, 10, 49).abducted, true); assert.equal(u(50, 10, 20).abducted, false);
  const l = (ea) => rebaInputs({ ...base, elbowAngle_L: ea }).lowerArm.L;
  assert.equal(l(120).bandIndex, 0); assert.equal(l(80).bandIndex, 0); assert.equal(l(79.9).bandIndex, 1); assert.equal(l(121).bandIndex, 1); assert.equal(l(79).bandIndex, 1); near(l(90).angle, 90, 1e-9);
  const w = (f, d = 0, p = 0) => rebaInputs({ ...base, wristFlexion_L: f, wristDeviation_L: d, forearmPronation_L: p }).wrist.L;
  assert.equal(w(15).bandIndex, 0); assert.equal(w(-15).bandIndex, 0); assert.equal(w(15.1).bandIndex, 1); assert.equal(w(-20).bandIndex, 1);
  assert.equal(w(0, 12).deviated, true); assert.equal(w(0, 5).deviated, false); assert.equal(w(0, 0, 60).twisted, true);
  const k = (ka, extra) => rebaInputs({ ...base, kneeAngle_L: ka, ...extra }).legs;
  assert.equal(k(151).L.bandIndex, 0); assert.equal(k(150).L.bandIndex, 1); assert.equal(k(120).L.bandIndex, 1); assert.equal(k(119).L.bandIndex, 2);
  assert.equal(k(100, { comOverBase: -0.3 }).support, "seated"); assert.equal(k(100, { comOverBase: -0.3 }).seated, true);
  assert.equal(rebaInputs({ ...base, legSupport: "left" }).legs.support, "unilateral"); assert.equal(rebaInputs({ ...base, legSupport: "none", comOverBase: null }).legs.support, "seated");
  assert.equal(rebaInputs({ ...base, legSupport: "none", comOverBase: 0.1 }).legs.support, "none");
  assert.equal(rebaInputs(base, { seated: true }).legs.support, "seated");
  // twist and side bend are flags at the documented thresholds
  const tw = rebaInputs({ ...base, trunkTwist: 12, trunkLateralFlexion: -3, neckTwist: 4, neckSideBend: 11 });
  assert.equal(tw.trunk.twisted, true); assert.equal(tw.trunk.sideBent, false); assert.equal(tw.neck.twisted, false); assert.equal(tw.neck.sideBent, true);
  // real postures
  const stoop = rebaInputs(on(man, posture(POSES["stoop 40"])));
  assert.equal(stoop.trunk.bandIndex, 2); assert.equal(stoop.trunk.direction, "flexion");
  const reach = rebaInputs(on(man, posture(POSES["arms forward"])));
  assert.equal(reach.upperArm.L.bandIndex, 2, "arm at 90 is in the 45 to 90 band"); assert.equal(reach.upperArm.L.supported, null);
  assert.equal(rebaInputs(on(man, posture(POSES["arms overhead"]))).upperArm.R.bandIndex, 3);
  const bands = REBA_BANDS;
  assert.equal(bands.trunk.length, 4); assert.equal(bands.neck.length, 2); assert.equal(bands.upperArm.length, 4); assert.equal(bands.lowerArm.length, 2); assert.equal(bands.wrist.length, 2); assert.equal(bands.legs.length, 3);
  assert.ok(Object.isFrozen(bands));
});

// ---- the document ----------------------------------------------------------------------------------------------------------------------
const NEUTRAL_KEYS = ["trunkInclination", "thoraxInclination", "trunkFlexionRelativeToPelvis", "pelvisTilt", "neckInclination", "headInclination", "gazeElevation", "shoulderElevation_L", "upperArmInclination_L", "elbowAngle_L",
  "hipAngle_L", "thighInclination_L", "kneeAngle_L", "shankInclination_L", "ankleAngle_L", "pelvisHeight", "hipHeight", "kneeHeight_L", "seatHeight", "eyeHeight", "shoulderHeight_L", "handHeightAboveFloor_L",
  "reachFromAnkles_L", "stanceWidth", "stanceLength", "comHeight", "comOverBase"];
const unitOf = (k) => METRIC_DEFS.find((d) => d.key === k.replace(/_[LR]$/, "")).type;
const fmtValue = (k, x) => (x === null ? "-" : (unitOf(k) === "m" ? x.toFixed(3) : x.toFixed(1)).replace(/^-(0\.0+)$/, "$1"));
function neutralTable() {
  const sit = posture(POSES["iso sitting"]);
  const a = on(man, { root: {}, angles: {} }), b = on(man, sit, "seat+feet");
  const rows = ["| Key | Unit | Standing (ISO 7250-1) | Seated (ISO 7250-1) |", "| --- | --- | --- | --- |"];
  for (const k of NEUTRAL_KEYS) rows.push(`| \`${k}\` | ${unitOf(k) === "m" ? "m" : "deg"} | ${fmtValue(k, a[k])} | ${fmtValue(k, b[k])} |`);
  return `${rows.join("\n")}\n`;
}
const block = (name) => new RegExp(`(<!-- ${name}:begin -->\\n)([\\s\\S]*?)(<!-- ${name}:end -->)`);
test("METRICS.md: the table of quantities is generated from the code (UPDATE_DOCS=1 regenerates it)", () => {
  let doc = fs.readFileSync(DOC, "utf8");
  for (const [name, text] of [["metrics-table", metricsTable()], ["neutral-values", neutralTable()]]) {
    assert.ok(block(name).test(doc), `METRICS.md has no <!-- ${name}:begin --> ... <!-- ${name}:end --> block`);
    if (process.env.UPDATE_DOCS) doc = doc.replace(block(name), (_, a, __, c) => `${a}${text}${c}`);
  }
  if (process.env.UPDATE_DOCS) fs.writeFileSync(DOC, doc);
  doc = fs.readFileSync(DOC, "utf8");
  assert.equal(doc.match(block("metrics-table"))[2], metricsTable(), "the table of quantities is out of date: UPDATE_DOCS=1 node --import ./tests/human3d/register.mjs --test tests/human3d/metrics.test.mjs");
  // every key of the code is in the document by name
  for (const d of METRIC_DEFS) assert.ok(doc.includes(`\`${d.key}`), d.key);
  // the neutral values: the numbers must still be those of the model (3 degrees / 3 cm: a regeneration is needed when the layout of the neutral pose changed)
  const fresh = neutralTable().split("\n").slice(2).filter(Boolean), have = doc.match(block("neutral-values"))[2].split("\n").slice(2).filter(Boolean);
  assert.equal(have.length, fresh.length, "the neutral value table lists other keys than the test");
  fresh.forEach((row, i) => {
    const a = row.split("|").map((c) => c.trim()), b = have[i].split("|").map((c) => c.trim());
    assert.equal(b[1], a[1], "key");
    for (const c of [3, 4]) near(Number(b[c]), Number(a[c]), a[2] === "m" ? 0.03 : 3, `neutral value ${a[1]} column ${c} (regenerate the document)`);
  });
});
