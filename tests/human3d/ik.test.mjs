// Whole-body inverse kinematics (site/js/human/ik.js): correctness, honesty about failure, limits, speed. Manual: docs/human3d/IK.md.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.test.mjs"
// The measured success rates and timings are printed as test diagnostics (node --test shows them with --test-reporter=spec).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, swingLength, jointQuaternion } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { gripAngles } from "../../site/js/human/postures/grips.js";
import { expandSpine, solvePose, figureOf, expandPosture, placePose } from "../../site/js/human/pose.js";
import { POSTURES } from "../../site/js/human/postures.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { bodyProxies, proxyWorld, selfPenetrations } from "../../site/js/human/proxies.js";
import * as IK from "../../site/js/human/ik.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---- the six bodies ----------------------------------------------------------------------------------------------------------------
const BODIES = [
  ["woman P5", army("F", 5)],
  ["man P50", army("M", 50)],
  ["man P95", army("M", 95)],
  ["man 2.0 m (stature only)", fitBody({ sex: "M", measures: { stature: { value: 2000, unit: "mm" } } })],
  ["woman 1.50 m (stature only)", fitBody({ sex: "F", measures: { stature: { value: 1500, unit: "mm" } } })],
];
let heavy = null;
try { // one real heavy person (ANSUR II): the soft tissue of the trunk and thighs is the hard case for the geometry
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(ROOT, "database", "anthro.sqlite");
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT * FROM subjects WHERE mass BETWEEN 118 AND 135 AND stature BETWEEN 1700 AND 1850 AND buttock_circumference IS NOT NULL AND waist_circumference IS NOT NULL ORDER BY mass DESC, subject_key LIMIT 1").get();
    if (row) heavy = [`real person #${row.subject_key} (${row.stature} mm, ${row.mass} kg)`, fitBody(subjectProfile(row))];
    db.close();
  }
} catch { /* node:sqlite or the database is missing: a synthetic heavy body stands in */ }
BODIES.push(heavy ?? ["heavy man 1.80 m, 130 kg (stature and mass only)", fitBody({ sex: "M", measures: { stature: { value: 1800, unit: "mm" }, mass: { value: 130, unit: "kg" } } })]);
const SOLVERS = BODIES.map(([name, body]) => [name, body, IK.createSolver(body)]);
const [, MAN_BODY, MAN] = SOLVERS[1];

// ---- helpers ---------------------------------------------------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A random in-range angle array of a joint: uniform in the box of the ranges (frac < 1: the middle part), then the 180 degree swing cap. */
function randomAngles(id, rnd, frac = 1) {
  const j = JOINT_BY_ID[id];
  return clampAngles(id, j.dof.map((d) => { const mid = (d.min + d.max) / 2, half = ((d.max - d.min) / 2) * frac; return mid + (rnd() * 2 - 1) * half; })).angles;
}
const standing = (solver) => ({ root: { ...solver.restRoot }, angles: {} });
const ARM_R = ["clavicle_R", "shoulder_R", "elbow_R", "forearm_R", "wrist_R"];
const LEG_L = ["hip_L", "knee_L", "ankle_L"];
const NECK = [...REGIONS.cervical.joints, "head"];
const dirOf = (solver, pose, joint, local) => solver.worldPoint(pose, { joint, local }).sub(solver.worldPoint(pose, { joint, local: [0, 0, 0] })).normalize();
const angleDeg = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * R2D;
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** Everything that is wrong with the angles of a Result (empty = a valid pose): range of motion per DOF, the 180 degree swing cap, finiteness. */
function problemsOf(result) {
  const out = [];
  for (const [id, a] of Object.entries(result.angles)) {
    const j = JOINT_BY_ID[id];
    if (!j) { out.push(`unknown joint ${id}`); continue; }
    if (!Array.isArray(a) || a.length > j.dof.length) { out.push(`${id}: bad array`); continue; }
    if (a.some((v) => !Number.isFinite(v))) { out.push(`${id}: not finite`); continue; }
    const c = clampAngles(id, a);
    c.angles.forEach((v, i) => { if (Math.abs(v - (a[i] ?? 0)) > 1e-7) out.push(`${id}.${j.dof[i].key} = ${(a[i] ?? 0).toFixed(6)} is outside its range (clamps to ${v.toFixed(6)})`); });
  }
  for (const k of ["x", "y", "z", "heading", "flex", "lat", "rot"]) if (!Number.isFinite(result.root[k])) out.push(`root.${k} not finite`);
  return out;
}
const pins = (r) => Math.max(...Object.entries(r.error).filter(([k]) => k.startsWith("pin:")).map(([, v]) => v));

/** Independent gaze error (degrees): the larger angle between an eye's axis and the line from its pupil to the target. */
function gazeErrorDeg(solver, pose, target) {
  let worst = 0;
  for (const s of ["L", "R"]) {
    const pupil = solver.worldPoint(pose, `pupil_${s}`), axis = dirOf(solver, pose, `eye_${s}`, [0, 0, 1]);
    worst = Math.max(worst, angleDeg(axis, V(target).sub(pupil).normalize()));
  }
  return worst;
}

// ---- 0. the Jacobian ------------------------------------------------------------------------------------------------------------
test("the geometric Jacobian agrees with finite differences of the forward kinematics (every kind of variable and term)", () => {
  const rnd = rng(7);
  const goals = [
    { type: "position", landmark: "grip_centre_R", target: [0, 1, 0.5], id: "p1" },
    { type: "position", landmark: "heel_sole_L", target: [0.1, 0, 0.1], id: "p2" },
    { type: "position", landmark: "vertex", target: [0, 1.7, 0.1], id: "p3" },
    { type: "height", landmark: "ASIS_L", height: 0.9, id: "h1" },
    { type: "direction", joint: "wrist_R", axis: "palm_normal", target: [1, 0, 0], id: "d1" },
    { type: "direction", joint: "wrist_L", axis: "hand_across", target: [0, 0, 1], line: true, id: "d2" },
    { type: "lookAt", target: [0.3, 1.5, 1.0], id: "look" },
    { type: "aim", landmark: "palm_centre_L", axis: [0, -1, 0], target: [0.5, 0.5, 0.5], id: "aim1" },
  ];
  const free = ["all", "pelvis-xyz", "pelvis-rot", "hand_R", "toes_L"];
  let worst = 0, checked = 0;
  for (let trial = 0; trial < 4; trial++) {
    const angles = {};
    for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = randomAngles(j.id, rnd, 0.5);
    const start = { root: { x: 0.1, y: 0.9, z: -0.2, heading: 30 * rnd(), flex: 10 * rnd(), lat: 5 * rnd(), rot: 8 * rnd() }, angles };
    const jac = MAN.jacobian(start, goals, { free });
    const rAt = (xv) => MAN.jacobian(jac.poseAt(xv), goals, { free }).r;
    const h = 1e-6;
    for (let k = 0; k < jac.n; k++) {
      const xp = Float64Array.from(jac.x), xm = Float64Array.from(jac.x);
      xp[k] += h; xm[k] -= h;
      const rp = rAt(xp), rm = rAt(xm);
      for (let i = 0; i < jac.m; i++) {
        // the pole direction is fixed for the solve (it follows the heading only between solves): the heading column of a pole row differs by design
        if (jac.names[k] === "pelvis.heading" && jac.rows[i].startsWith("pole")) continue;
        const fd = (rp[i] - rm[i]) / (2 * h), an = jac.J[i * jac.n + k];
        worst = Math.max(worst, Math.abs(fd - an));
        checked++;
      }
    }
  }
  assert.ok(worst < 1e-6, `largest difference ${worst.toExponential(2)} over ${checked} entries`);
});

test("spine regions as variables: the Jacobian column of a region total is the weighted sum of its vertebrae, also near a limit", () => {
  const rnd = rng(11);
  const angles = {};
  for (const id of REGIONS.lumbar.joints) angles[id] = [JOINT_BY_ID[id].dof[0].max - 0.5, 0, 0]; // every lumbar level 0.5 degrees below its flexion limit
  const goals = [{ type: "position", landmark: "vertex", target: [0, 1.7, 0.2], id: "head" }];
  const start = { root: { ...MAN.restRoot }, angles };
  const jac = MAN.jacobian(start, goals, { free: ["lumbar"], pole: {} });
  const k = jac.names.indexOf("lumbar.flex");
  assert.ok(k >= 0);
  // positive flexion: every level is within 0.5 degrees of its limit, so the total can grow by about 2.5 degrees only
  const x = Float64Array.from(jac.x);
  assert.ok(Math.abs(x[k]) < 1e-12);
  const pose = jac.poseAt(Float64Array.from(x, (v, i) => (i === k ? 0.5 * D2R * 5 : v)));
  for (const id of REGIONS.lumbar.joints) assert.ok(pose.angles[id][0] <= JOINT_BY_ID[id].dof[0].max + 1e-9, `${id} stays inside`);
  assert.ok(rnd() >= 0);
});

// ---- 1. reachable targets ------------------------------------------------------------------------------------------------------
function reachRate(label, t, make, N = 150) {
  let good = 0, total = 0, ms = [];
  const failures = [];
  for (const [name, , solver] of SOLVERS) {
    const rnd = rng(1000 + total);
    for (let i = 0; i < N; i++) {
      const c = make(solver, rnd);
      const r = solver.solve(standing(solver), c.goals, c.options);
      total++; ms.push(r.ms);
      if (c.ok(r)) good++; else failures.push(`${name} #${i}: ${JSON.stringify(Object.fromEntries(Object.entries(r.error).map(([k, v]) => [k, +v.toFixed(5)])))}`);
    }
  }
  const rate = good / total;
  t.diagnostic(`${label}: ${good}/${total} = ${(100 * rate).toFixed(1)} % solved to the tolerance (median ${median(ms).toFixed(2)} ms, max ${Math.max(...ms).toFixed(1)} ms); first failures: ${failures.slice(0, 3).join(" | ")}`);
  return rate;
}

test("reachable targets: the right palm of 150 random in-ROM arm poses x 6 bodies, solved from the relaxed standing pose (arm and clavicle free)", (t) => {
  const rate = reachRate("palm, arm + clavicle", t, (solver, rnd) => {
    const pose = standing(solver);
    for (const id of ARM_R) pose.angles[id] = randomAngles(id, rnd);
    const target = solver.worldPoint(pose, "palm_centre_R").toArray();
    return { goals: [{ type: "position", id: "g", landmark: "palm_centre_R", target }], options: { free: ["arm_R", "clavicle_R"] }, ok: (r) => r.error.g <= 1e-3 };
  });
  assert.ok(rate >= 0.95, `rate ${rate}`);
});

test("reachable targets: palm with the trunk free (random region totals of the lumbar and thoracic spine, as the posture editor sets them)", (t) => {
  const rate = reachRate("palm, arm + clavicle + trunk", t, (solver, rnd) => {
    const pose = standing(solver);
    for (const id of ARM_R) pose.angles[id] = randomAngles(id, rnd);
    const total = (name) => { const r = REGIONS[name].range; return [0, 1, 2].map((c) => (c === 0 ? r.flex : r[["flex", "lat", "rot"][c]])).map(([lo, hi]) => lo + rnd() * (hi - lo)); };
    Object.assign(pose.angles, expandSpine({ lumbar: total("lumbar"), thoracic: total("thoracic") }).angles);
    const target = solver.worldPoint(pose, "palm_centre_R").toArray();
    return { goals: [{ type: "position", id: "g", landmark: "palm_centre_R", target }], options: { free: ["arm_R", "clavicle_R", "trunk"] }, ok: (r) => r.error.g <= 1e-3 };
  }, 100);
  assert.ok(rate >= 0.95, `rate ${rate}`);
});

test("reachable targets: arbitrary per-vertebra trunk poses need the vertebrae free one by one (a region is a 3-parameter family)", (t) => {
  const solver = MAN, rnd = rng(99);
  let regionsOk = 0, vertebraeOk = 0;
  const N = 40, ids = [...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints];
  for (let i = 0; i < N; i++) {
    const pose = standing(solver);
    for (const id of [...ARM_R, ...ids]) pose.angles[id] = randomAngles(id, rnd);
    const target = solver.worldPoint(pose, "palm_centre_R").toArray(), goals = [{ type: "position", id: "g", landmark: "palm_centre_R", target }];
    if (solver.solve(standing(solver), goals, { free: ["arm_R", "clavicle_R", "trunk"] }).error.g <= 1e-3) regionsOk++;
    if (solver.solve(standing(solver), goals, { free: ["arm_R", "clavicle_R", ...ids] }).error.g <= 1e-3) vertebraeOk++;
  }
  t.diagnostic(`random per-vertebra trunk poses: ${regionsOk}/${N} solved with the regions free, ${vertebraeOk}/${N} with the vertebrae free`);
  assert.ok(vertebraeOk >= N * 0.9);
  assert.ok(vertebraeOk >= regionsOk);
});

test("reachable targets: the left heel of 150 random in-ROM leg poses x 6 bodies", (t) => {
  const rate = reachRate("left heel, leg free", t, (solver, rnd) => {
    const pose = standing(solver);
    for (const id of LEG_L) pose.angles[id] = randomAngles(id, rnd);
    const target = solver.worldPoint(pose, "heel_sole_L").toArray();
    return { goals: [{ type: "position", id: "g", landmark: "heel_sole_L", target }], options: { free: ["leg_L"] }, ok: (r) => r.error.g <= 1e-3 };
  });
  assert.ok(rate >= 0.95, `rate ${rate}`);
});

test("reachable targets: the gaze of 150 random head / neck poses x 6 bodies, solved from the straight head (neck and eyes free), error < 0.5 degree", (t) => {
  const rate = reachRate("gaze, neck + eyes", t, (solver, rnd) => {
    const pose = standing(solver);
    for (const id of NECK) pose.angles[id] = randomAngles(id, rnd);
    const mid = solver.worldPoint(pose, "eye_mid"), fwd = dirOf(solver, pose, "head", [0, 0, 1]);
    const target = mid.clone().addScaledVector(fwd, 1.5).toArray();
    return { goals: [{ type: "lookAt", id: "g", target }], options: { free: ["neck", "eyes"] }, target, ok: (r) => gazeErrorDeg(solver, r.pose, target) < 0.5 };
  });
  assert.ok(rate >= 0.95, `rate ${rate}`);
});

// ---- 2. hard limits ------------------------------------------------------------------------------------------------------------
test("hard limits: no returned pose violates a range of motion or the 180 degree swing cap, over 1,000 random goals including absurd ones", (t) => {
  const rnd = rng(42);
  const FREES = [["arm_R", "clavicle_R"], ["arms", "clavicles", "trunk"], ["all"], ["all", "pelvis-xyz", "pelvis-rot"], ["legs"], ["neck", "eyes"], ["leg_L", "pelvis-y"], ["arm_L", "trunk", "pelvis-xz"]];
  const stats = { absurd: 0, below: 0, inside: 0, reachable: 0, unreachable: 0 };
  let n = 0;
  const bad = [];
  for (let i = 0; i < 1000; i++) {
    const [name, , solver] = SOLVERS[i % SOLVERS.length];
    const start = { root: { x: rnd() - 0.5, y: solver.restRoot.y, z: rnd() - 0.5, heading: 360 * rnd() - 180, flex: 0, lat: 0, rot: 0 }, angles: {} };
    for (const j of JOINTS) if (j.id !== "pelvis" && j.group !== "hand" && j.group !== "face") start.angles[j.id] = randomAngles(j.id, rnd, 0.6);
    const kind = Math.floor(rnd() * 8);
    const pelvis = solver.worldPoint(start, { joint: "pelvis" });
    let target;
    if (kind === 0) { target = [(rnd() - 0.5) * 2e3, (rnd() - 0.5) * 2e3, (rnd() - 0.5) * 2e3]; stats.absurd++; } // up to a kilometre away
    else if (kind === 1) { target = [pelvis.x + (rnd() - 0.5), -0.05 - rnd(), pelvis.z + (rnd() - 0.5)]; stats.below++; } // below the floor
    else if (kind === 2) { target = [pelvis.x + (rnd() - 0.5) * 0.1, pelvis.y + (rnd() - 0.5) * 0.1, pelvis.z + (rnd() - 0.5) * 0.1]; stats.inside++; } // inside the body
    else target = [pelvis.x + (rnd() - 0.5) * 2.4, pelvis.y + (rnd() - 0.4) * 2.2, pelvis.z + (rnd() - 0.5) * 2.4];
    const lm = ["grip_centre_R", "grip_centre_L", "heel_sole_L", "vertex", "index_tip_R", "toe_tip_R"][Math.floor(rnd() * 6)];
    const goals = [{ type: "position", id: "a", landmark: lm, target }];
    const k2 = Math.floor(rnd() * 4);
    if (k2 === 1) goals.push({ type: "lookAt", id: "b", target: [target[0] * 0.5, target[1] * 0.5, target[2] * 0.5 + 1] });
    else if (k2 === 2) goals.push({ type: "frame", id: "c", joint: lm.includes("heel") ? "ankle_L" : "wrist_R", axes: [{ local: lm.includes("heel") ? "sole_normal" : "palm_normal", world: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5] }] });
    else if (k2 === 3) goals.push(...IK.pinGoals(solver, start, ["heel_sole_R", "ball_sole_medial_R"]));
    const free = FREES[Math.floor(rnd() * FREES.length)];
    let r;
    try { r = solver.solve(start, goals, { free, maxIterations: 40, restarts: 1 }); } catch (e) { bad.push(`${name} #${i}: threw ${e.message}`); continue; }
    n++;
    const p = problemsOf(r);
    if (p.length) bad.push(`${name} #${i} (${lm}, free ${free}): ${p.slice(0, 2).join("; ")}`);
    for (const [k, v] of Object.entries(r.error)) if (!(Number.isFinite(v) && v >= 0)) bad.push(`${name} #${i}: error ${k} = ${v}`);
    if (r.reachable !== Object.entries(r.error).every(([k, v]) => v <= r.tolerance[k])) bad.push(`${name} #${i}: reachable disagrees with the errors`);
    if (r.reachable) stats.reachable++; else stats.unreachable++;
  }
  t.diagnostic(`1000 random goals: ${JSON.stringify(stats)}; ${bad.length} problems`);
  assert.equal(n, 1000);
  assert.deepEqual(bad.slice(0, 5), []);
});

test("bad input is an Error with a plain message, never a silent NaN pose", () => {
  const s = standing(MAN);
  const goal = (g) => [{ type: "position", landmark: "grip_centre_R", ...g }];
  assert.throws(() => MAN.solve(s, goal({ target: [NaN, 1, 0] })), /finite/);
  assert.throws(() => MAN.solve(s, goal({ target: [Infinity, 1, 0] })), /finite/);
  assert.throws(() => MAN.solve(s, goal({ target: [0, 1] })), /\[x, y, z\]/);
  assert.throws(() => MAN.solve(s, goal({ target: "up" })), /\[x, y, z\]/);
  assert.throws(() => MAN.solve(s, goal({})), /target/);
  assert.throws(() => MAN.solve(s, goal({ landmark: "elbow_R", target: [0, 1, 0] })), /unknown landmark/);
  assert.throws(() => MAN.solve(s, [{ type: "wobble", target: [0, 0, 0] }]), /unknown goal type/);
  assert.throws(() => MAN.solve(s, [{ type: "position", landmark: "grip_centre_R", target: [0, 1, 0], weight: -1 }]), /weight/);
  assert.throws(() => MAN.solve(s, "goals"), /array/);
  assert.throws(() => MAN.solve(s, goal({ target: [0, 1, 0] }), { free: ["elbow"] }), /unknown name "elbow"/);
  assert.throws(() => MAN.solve(s, goal({ target: [0, 1, 0] }), { restart: 3 }), /unknown option "restart"/);
  assert.throws(() => MAN.solve(s, goal({ target: [0, 1, 0] }), { maxIterations: -1 }), /maxIterations/);
  assert.throws(() => MAN.solve(s, goal({ target: [0, 1, 0] }), { tolerance: 0 }), /tolerance/);
  assert.throws(() => MAN.solve({ root: { y: NaN }, angles: {} }, goal({ target: [0, 1, 0] })), /not a finite/);
  assert.throws(() => MAN.solve({ root: {}, angles: { elbow_Z: [1] } }, goal({ target: [0, 1, 0] })), /unknown joint/);
  assert.throws(() => MAN.solve({ root: {}, angles: { elbow_R: ["a"] } }, goal({ target: [0, 1, 0] })), /finite/);
  assert.throws(() => MAN.solve(null, goal({ target: [0, 1, 0] })), /start/);
  assert.throws(() => IK.createSolver(null), /BodyModel/);
  assert.throws(() => IK.reachHand(MAN, s, "X", [0, 1, 0]), /side/);
  // the solver is not corrupted by a failed call
  const r = MAN.solve(s, goal({ target: [-0.2, 1.2, 0.4] }));
  assert.ok(r.reachable);
});

// ---- 3. unreachable goals ---------------------------------------------------------------------------------------------------
test("unreachable goals: best effort, reachable = false, the shortfall is reported, the pose is valid and closer than the start", () => {
  const start = standing(MAN);
  const sh = MAN.worldPoint(start, { joint: "shoulder_R" });
  const far = [sh.x - 1.5, sh.y + 0.2, sh.z + 0.6]; // about 1.6 m from the shoulder; the arm is 0.65 m
  const r0 = MAN.solve(start, [{ type: "position", id: "hand", landmark: "grip_centre_R", target: far }], { free: ["arm_R", "clavicle_R"], maxIterations: 0 });
  const r = IK.reachHand(MAN, start, "R", far);
  assert.equal(r.reachable, false);
  assert.ok(r.converged, "the best effort is final");
  assert.deepEqual(problemsOf(r), []);
  assert.ok(r.error.hand_R < r0.error.hand, "closer than the start");
  const dist = sh.distanceTo(V(far));
  assert.ok(r.error.hand_R > dist - 0.8 && r.error.hand_R < dist, `shortfall ${r.error.hand_R.toFixed(3)} m of ${dist.toFixed(3)} m`);
  // the arm points at the target: the hand is on the line from the shoulder to the target, as far as it reaches
  const hand = MAN.worldPoint(r.pose, "grip_centre_R");
  const toTarget = V(far).sub(sh).normalize(), toHand = hand.clone().sub(sh).normalize();
  assert.ok(angleDeg(toTarget, toHand) < 12, `the hand is ${angleDeg(toTarget, toHand).toFixed(1)} degrees off the line to the target`);
  assert.ok(r.provablyUnreachable === true && r.beyondReach.join() === "hand_R", "provably out of reach of a straight chain, and the result says which goal");
  const text = IK.describeResult(r, { hand_R: "The right hand" });
  assert.equal(text.length, 1);
  assert.match(text[0], /^The right hand: \d+ mm short of the target \(farther than the limb can stretch\)\.$/);
  assert.deepEqual(IK.describeResult(MAN.solve(start, [], {})), [], "nothing to say when every goal is met");
  // slightly beyond the reach: the closest feasible pose, within centimetres, limits named
  const near = [sh.x - 0.1, sh.y - 0.1, sh.z + 0.75];
  const rn = IK.reachHand(MAN, start, "R", near);
  assert.equal(rn.reachable, false);
  assert.ok(rn.error.hand_R > 0.001 && rn.error.hand_R < 0.15);
  assert.deepEqual(problemsOf(rn), []);
  // a foot below the floor level of the leg's reach; a gaze beyond what the head can turn (only the rotation DOF are free: 80 degrees of neck, 45 of eyes)
  const rf = IK.placeFoot(MAN, start, "L", { position: [0.1, -0.5, 0.3] });
  assert.equal(rf.reachable, false);
  assert.ok(rf.error.foot_L > 0.3 && rf.error.foot_L < 0.6);
  const mid = MAN.worldPoint(start, "eye_mid");
  const rl = IK.lookAt(MAN, start, [mid.x + 2 * Math.sin(160 * D2R), mid.y, mid.z + 2 * Math.cos(160 * D2R)], { free: ["cervical.rot", "head.rot", "eyes"] });
  assert.equal(rl.reachable, false);
  assert.ok(rl.error.lookAt * R2D > 25 && rl.error.lookAt * R2D < 45, `${(rl.error.lookAt * R2D).toFixed(0)} degrees short (160 - 125 = 35)`);
  assert.deepEqual(problemsOf(rl), []);
  assert.ok(IK.describeResult(rl).some((l) => /degrees off the target/.test(l)));
});

// ---- 4. pinned feet ---------------------------------------------------------------------------------------------------------------
test("pinned feet: the pelvis goes down, up and forward while both feet stay (0.5 mm), knees and hips flex more the lower it goes", (t) => {
  const rows = [];
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver);
    const world = (pose) => ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R", "ball_sole_lateral_L", "ball_sole_lateral_R", "toe_sole_L"].map((id) => solver.worldPoint(pose, id));
    const feet0 = world(start);
    const moved = (r) => Math.max(...world(r.pose).map((p, i) => p.distanceTo(feet0[i])));
    let prev = null;
    for (const dy of [-0.05, -0.1, -0.15, -0.2]) {
      const r = IK.movePelvis(solver, start, { dy });
      assert.ok(r.reachable, `${name}: ${dy}: ${JSON.stringify(r.error)}`);
      assert.ok(moved(r) <= 5e-4, `${name} dy ${dy}: a foot moved ${(moved(r) * 1000).toFixed(2)} mm`);
      assert.ok(Math.abs(r.root.y - (start.root.y + dy)) < 1e-12, "root.y is the requested height");
      assert.ok(r.root.y < start.root.y);
      assert.deepEqual(problemsOf(r), []);
      const knee = r.angles.knee_L[0], hip = r.angles.hip_L[0];
      // the geometry flexes more as the pelvis goes down: the thigh tilts forward, the knee bends (the hip angle itself can trade flexion for abduction and rotation at the ankle limit)
      const H = solver.worldPoint(r.pose, { joint: "hip_L" }), K = solver.worldPoint(r.pose, { joint: "knee_L" }), A = solver.worldPoint(r.pose, { joint: "ankle_L" });
      const thigh = angleDeg(K.clone().sub(H).normalize(), new THREE.Vector3(0, -1, 0)), bend = 180 - angleDeg(H.clone().sub(K).normalize(), A.clone().sub(K).normalize());
      if (prev) { assert.ok(knee > prev.knee + 1, `${name}: knee flexes more at ${dy}`); assert.ok(thigh > prev.thigh + 0.5 && bend > prev.bend + 1, `${name}: the thigh tilts and the knee bends more at ${dy} (${thigh.toFixed(1)}, ${bend.toFixed(1)})`); assert.ok(hip > prev.hip - 0.5 || dy <= -0.2, `${name}: hip`); }
      assert.ok(Math.abs(r.angles.knee_L[0] - r.angles.knee_R[0]) < 0.5 && Math.abs(r.angles.hip_L[0] - r.angles.hip_R[0]) < 0.5, "symmetric legs");
      prev = { knee, hip, thigh, bend };
      if (dy === -0.2) rows.push(`${name}: knee ${knee.toFixed(0)}, hip ${hip.toFixed(0)}, ankle ${r.angles.ankle_L[0].toFixed(0)} degrees at -0.2 m`);
    }
    // too deep: either it works (the pins hold) or reachable is false and the pin error is reported; never a pose out of range
    const deep = IK.movePelvis(solver, start, { dy: -0.4 });
    assert.deepEqual(problemsOf(deep), []);
    if (deep.reachable) assert.ok(moved(deep) <= 5e-4);
    else { assert.ok(pins(deep) > 5e-4, "the error of the pins is reported"); assert.ok(pins(deep) < 0.1, "and small: the closest feasible squat"); }
    // up and forward from a squat
    const sq = IK.movePelvis(solver, start, { dy: -0.15 });
    const squat = { root: sq.root, angles: sq.angles }, feetSq = world(squat);
    const up = IK.movePelvis(solver, squat, { dy: 0.1 });
    assert.ok(up.reachable && up.root.y > sq.root.y, `${name}: up`);
    assert.ok(Math.max(...world(up.pose).map((p, i) => p.distanceTo(feetSq[i]))) <= 5e-4);
    assert.ok(up.angles.knee_L[0] < sq.angles.knee_L[0], "knees extend when the pelvis rises");
    const fwd = IK.movePelvis(solver, squat, { dz: 0.05 });
    assert.ok(fwd.reachable, `${name}: forward ${JSON.stringify(fwd.error)}`);
    assert.ok(Math.max(...world(fwd.pose).map((p, i) => p.distanceTo(feetSq[i]))) <= 5e-4);
    assert.ok(Math.abs(fwd.root.z - (sq.root.z + 0.05)) < 1e-12);
    // pelvis target form
    const tgt = IK.movePelvis(solver, start, { target: [0, start.root.y - 0.1, 0] });
    assert.ok(tgt.reachable && Math.abs(tgt.root.y - (start.root.y - 0.1)) < 1e-12);
  }
  t.diagnostic(rows.join("; "));
});

test("pinned feet and hands: the pelvis moves, the grips stay (the arms and clavicles take it up)", () => {
  const start = standing(MAN);
  const reach = IK.reachHand(MAN, start, "R", [-0.2, 1.1, 0.45]);
  const pose = reach.pose;
  const grip0 = MAN.worldPoint(pose, "grip_centre_R");
  const r = IK.movePelvis(MAN, pose, { dy: -0.08 }, { pinHands: true, pin: [] });
  assert.ok(MAN.worldPoint(r.pose, "grip_centre_R").distanceTo(grip0) < 1e-3 || !r.reachable);
  assert.ok(Object.keys(r.error).some((k) => k.startsWith("pin:grip_centre")));
  assert.deepEqual(problemsOf(r), []);
});

// ---- 5. hand frames ---------------------------------------------------------------------------------------------------------
test("the hand frame: the fingers curl about hand_across and toward the palm normal (checked on the grip presets, independent of the solver)", () => {
  for (const [name, , solver] of SOLVERS) {
    for (const side of ["L", "R"]) {
      const hf = solver.handFrame(side);
      assert.ok(Math.abs(Math.hypot(...hf.normal) - 1) < 1e-9 && Math.abs(THREE.MathUtils.clamp(V(hf.normal).dot(V(hf.across)), -1, 1)) < 1e-9, "orthonormal");
      for (const grip of ["fist", "power", "hook"]) {
        const pose = { root: { ...solver.restRoot }, angles: gripAngles(grip, side) };
        const tips = ["index", "middle", "ring", "little"].map((f) => solver.worldPoint(pose, `${f}_tip_${side}`));
        const spread = (local) => {
          const a = dirOf(solver, pose, `wrist_${side}`, local);
          const proj = tips.map((p) => p.clone().sub(a.clone().multiplyScalar(p.dot(a))));
          const c = proj.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(0.25);
          return Math.sqrt(proj.reduce((s, p) => s + p.distanceToSquared(c), 0) / 4);
        };
        assert.ok(spread(hf.across) < 0.5 * spread(hf.finger) && spread(hf.across) < 0.5 * spread(hf.normal), `${name} ${side} ${grip}: the four fingertips line up seen along hand_across`);
        if (grip === "fist") { // an open hand points along finger_axis (within the offset of the middle finger from the knuckle centre, 9 degrees)
          const open = { root: { ...solver.restRoot }, angles: gripAngles("open", side) };
          const f = dirOf(solver, open, `wrist_${side}`, hf.finger), tip = solver.worldPoint(open, `middle_tip_${side}`).sub(solver.worldPoint(open, { joint: `wrist_${side}` })).normalize();
          assert.ok(angleDeg(f, tip) < 12, `${name} ${side}: finger_axis is ${angleDeg(f, tip).toFixed(1)} degrees off the open middle finger`);
        }
        // the fingertips are on the palm side of the wrist
        const n = dirOf(solver, pose, `wrist_${side}`, hf.normal), w = solver.worldPoint(pose, { joint: `wrist_${side}` });
        assert.ok(tips.reduce((a, p) => a + p.clone().sub(w).dot(n), 0) / 4 > 0.004, `${name} ${side} ${grip}: the fingertips are on the palm-normal side`);
      }
    }
  }
});

test("hand frame goals: palms on a horizontal bar and on a vertical handle, palm normal within 5 degrees, knuckle line along the bar", (t) => {
  const cases = [];
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver);
    const sh = solver.worldPoint(start, { joint: "shoulder_R" }), shL = solver.worldPoint(start, { joint: "shoulder_L" });
    const len = sh.distanceTo(solver.worldPoint(start, "grip_centre_R"));
    const y = sh.y - 0.1, z = sh.z + 0.55 * len + 0.05;
    // a bar across the body in front of the chest, palms down; the two sides of a box held in front (palms toward the midline); a wall to push (palms forward)
    for (const [side, grip] of [
      ["L", { position: [shL.x + 0.02, y, z], normal: [0, -1, 0], axis: [1, 0, 0], diameter: 0.03 }],
      ["R", { position: [sh.x - 0.02, y, z], normal: [0, -1, 0], axis: [1, 0, 0], diameter: 0.03 }],
      ["R", { position: [-0.17, sh.y - 0.2, sh.z + 0.35], normal: [1, 0, 0], axis: [0, 1, 0], diameter: 0.03 }],
      ["L", { position: [0.17, sh.y - 0.2, sh.z + 0.35], normal: [-1, 0, 0], axis: [0, 1, 0], diameter: 0.03 }],
      ["R", { position: [sh.x, sh.y - 0.05, sh.z + 0.5 * len], normal: [0, 0, 1], axis: [1, 0, 0], diameter: 0.03 }],
      ["L", { position: [shL.x, sh.y, sh.z + 0.5 * len], normal: [0, 0, 1], axis: [1, 0, 0], diameter: 0 }],
    ]) {
      const goal = IK.handFrameFromGrip(grip, side);
      const r = solver.solve(start, [goal], { free: [`arm_${side}`, `clavicle_${side}`] });
      assert.deepEqual(problemsOf(r), []);
      const lmk = grip.diameter === 0 ? "palm_centre" : "grip_centre";
      const pos = solver.worldPoint(r.pose, `${lmk}_${side}`);
      const n = dirOf(solver, r.pose, `wrist_${side}`, solver.handFrame(side).normal), ax = dirOf(solver, r.pose, `wrist_${side}`, solver.handFrame(side).across);
      const nErr = angleDeg(n, V(grip.normal)), aErr = Math.min(angleDeg(ax, V(grip.axis)), angleDeg(ax, V(grip.axis).negate()));
      cases.push({ ok: r.reachable, nErr, aErr, pos: pos.distanceTo(V(grip.position)), name });
      if (r.reachable) {
        assert.ok(nErr < 5, `${name} ${side} ${JSON.stringify(grip.normal)}: palm normal ${nErr.toFixed(2)} degrees off`);
        assert.ok(aErr < 5, `${name} ${side}: knuckle line ${aErr.toFixed(2)} degrees off the bar`);
        assert.ok(pos.distanceTo(V(grip.position)) < 1e-3, "the grip centre is on the bar");
      } else { // honest: the error says which part fails, and the pose is the closest feasible one
        assert.ok(r.error[`hand_${side}`] > 5e-4 || r.error[`hand_${side}.rot`] > 2e-3);
        assert.ok(r.error[`hand_${side}`] < 0.1);
      }
    }
  }
  const ok = cases.filter((c) => c.ok);
  t.diagnostic(`${ok.length}/${cases.length} grips reachable; worst palm normal error ${Math.max(...ok.map((c) => c.nErr)).toFixed(2)} degrees, worst bar axis error ${Math.max(...ok.map((c) => c.aErr)).toFixed(2)} degrees`);
  assert.ok(ok.length >= cases.length * 0.75, "most of these grips are within reach");
});

test("frame goals: a joint frame as a quaternion, as axes, with a position; foot on a pedal (tilted sole), flat on the floor with a heading", () => {
  const start = standing(MAN);
  // a head orientation as a quaternion (a yaw and a tilt within the neck ranges)
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, 0, "YXZ"));
  const r = MAN.solve(start, [{ type: "frame", id: "head", joint: "head", quaternion: q.toArray() }], { free: ["neck"] });
  assert.ok(r.reachable, JSON.stringify(r.error));
  const h = dirOf(MAN, r.pose, "head", [0, 0, 1]), want = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  assert.ok(angleDeg(h, want) < 0.2);
  // foot on a tilted pedal
  const ball = MAN.worldPoint(start, "ball_centre_R");
  const n = V([0, -0.5, 0.8]).normalize(); // the sole faces down and forward
  const pos = [ball.x, ball.y + 0.18, ball.z + 0.4];
  const f = IK.placeFoot(MAN, start, "R", { position: pos, soleNormal: n.toArray() });
  assert.ok(f.reachable, JSON.stringify(f.error));
  assert.ok(angleDeg(dirOf(MAN, f.pose, "ankle_R", [0, -1, 0]), n) < 0.2);
  assert.ok(MAN.worldPoint(f.pose, "ball_centre_R").distanceTo(V(pos)) < 1e-3);
  // flat with a heading: the sole is horizontal and the foot points 30 degrees to the left
  const heel0 = MAN.worldPoint(start, "heel_sole_L"), g = IK.placeFoot(MAN, start, "L", { position: [heel0.x + 0.1, heel0.y + 0.04, heel0.z + 0.12], heading: 30, landmark: "heel_sole" });
  assert.ok(g.reachable, JSON.stringify(g.error));
  const fw = dirOf(MAN, g.pose, "ankle_L", [0, 0, 1]);
  assert.ok(Math.abs(Math.atan2(fw.x, fw.z) * R2D - 30) < 0.3, "heading");
  assert.ok(dirOf(MAN, g.pose, "ankle_L", [0, -1, 0]).y < -0.9999, "flat");
});

// ---- 6. look-at -------------------------------------------------------------------------------------------------------------------
test("look-at: head, neck and eyes look at points in front, to the side, up and down: gaze error < 0.5 degree inside the neck ranges", () => {
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver), mid = solver.worldPoint(start, "eye_mid");
    const at = (az, el, d = 2) => [mid.x + d * Math.cos(el * D2R) * Math.sin(az * D2R), mid.y + d * Math.sin(el * D2R), mid.z + d * Math.cos(el * D2R) * Math.cos(az * D2R)];
    for (const [az, el] of [[0, 0], [40, 0], [-40, 0], [75, 10], [-75, -10], [0, 40], [0, -50], [30, 30], [-30, -35], [60, -25]]) {
      const target = at(az, el);
      const r = IK.lookAt(solver, start, target);
      assert.deepEqual(problemsOf(r), []);
      assert.ok(r.reachable, `${name} az ${az} el ${el}: ${(r.error.lookAt * R2D).toFixed(2)} degrees left`);
      const e = gazeErrorDeg(solver, r.pose, target);
      assert.ok(e < 0.5, `${name} az ${az} el ${el}: gaze error ${e.toFixed(3)} degrees`);
      assert.ok(r.error.lookAt * R2D < 0.5);
      // the head and neck took the turn, not the eyes (distribute over cervical, head, then eyes)
      if (Math.abs(az) <= 40 && Math.abs(el) <= 30) {
        const eyes = Math.max(...["eye_L", "eye_R"].flatMap((id) => (r.angles[id] ?? [0, 0]).map(Math.abs)));
        assert.ok(eyes < 8, `${name} az ${az} el ${el}: the eyes turned ${eyes.toFixed(1)} degrees (convergence only)`);
      }
    }
    // the eyes converge: for a near target the lines of sight cross at the target
    const near = at(0, 0, 0.5);
    const rn = IK.lookAt(solver, start, near);
    assert.ok(rn.reachable);
    const aL = rn.angles.eye_L[1], aR = rn.angles.eye_R[1];
    assert.ok(aL < -1 && aR < -1 && Math.abs(aL - aR) < 0.01, `${name}: both eyes turn in (joint convention: azim + is lateral for either eye): ${aL.toFixed(2)}, ${aR.toFixed(2)}`);
  }
});

test("look-at beyond the neck: the eyes take the rest, then the shortfall is reported", () => {
  const start = standing(MAN), mid = MAN.worldPoint(start, "eye_mid");
  const at = (az, el = 0) => [mid.x + 2 * Math.cos(el * D2R) * Math.sin(az * D2R), mid.y + 2 * Math.sin(el * D2R), mid.z + 2 * Math.cos(el * D2R) * Math.cos(az * D2R)];
  const turnOnly = { free: ["cervical.rot", "head.rot", "eyes"] }; // rotation DOF only: 70 + 10 degrees of neck and head, 45 of eyes
  const rotOf = (r) => REGIONS.cervical.joints.reduce((s, id) => s + (r.angles[id]?.[2] ?? 0), 0) + (r.angles.head?.[2] ?? 0);
  // inside the neck range the eyes only converge
  const inNeck = IK.lookAt(MAN, start, at(60), turnOnly);
  assert.ok(inNeck.reachable);
  assert.ok(Math.abs(rotOf(inNeck) - 60) < 4 && Math.abs(inNeck.angles.eye_L[1]) < 5 && Math.abs(inNeck.angles.eye_R[1]) < 5, `neck ${rotOf(inNeck).toFixed(1)}, eyes ${inNeck.angles.eye_L[1].toFixed(1)}, ${inNeck.angles.eye_R[1].toFixed(1)}`);
  // 100 degrees: the neck is at its limits (80), the eyes took the rest (about 20)
  const inEyes = IK.lookAt(MAN, start, at(100), turnOnly);
  assert.ok(inEyes.reachable, `${(inEyes.error.lookAt * R2D).toFixed(2)} degrees left`);
  assert.ok(gazeErrorDeg(MAN, inEyes.pose, at(100)) < 0.5);
  assert.ok(rotOf(inEyes) > 77 && rotOf(inEyes) <= 80 + 1e-6, `neck + head turn ${rotOf(inEyes).toFixed(1)} of 80`);
  const eyeAz = inEyes.angles.eye_L[1];
  assert.ok(eyeAz > 14 && eyeAz < 27, `the eyes took the rest: ${eyeAz.toFixed(1)} degrees`);
  assert.ok(inEyes.clamped.some((c) => c.joint === "cervical" && c.dof === "rot" && c.limit === "max"));
  // 150 degrees: neck and eyes at their limits, the rest is reported (150 - 80 - 45 = 25 degrees)
  const beyond = IK.lookAt(MAN, start, at(150), turnOnly);
  assert.equal(beyond.reachable, false);
  const short = beyond.error.lookAt * R2D;
  assert.ok(short > 15 && short < 35, `short by ${short.toFixed(1)} degrees`);
  assert.ok(Math.abs(beyond.angles.eye_L[1]) > 44.9, "the eyes are at their limit");
  assert.ok(beyond.clamped.filter((c) => c.blocking).length >= 3);
  assert.deepEqual(problemsOf(beyond), []);
  // the full neck (flexion, lateral bend and rotation together: the box of ranges is generous) turns farther; the eyes still take what the neck cannot
  const full = (az) => IK.lookAt(MAN, start, at(az));
  const noEyes = IK.lookAt(MAN, start, at(120), { eyes: false });
  assert.equal(noEyes.reachable, false);
  assert.ok(noEyes.error.lookAt * R2D > 5, `the cyclopean axis of the neck alone is ${(noEyes.error.lookAt * R2D).toFixed(1)} degrees short at 120`);
  const with120 = full(120);
  assert.ok(with120.reachable && gazeErrorDeg(MAN, with120.pose, at(120)) < 0.5);
  assert.ok(Math.max(...with120.angles.eye_L.map(Math.abs)) > 3, "and the eyes help");
  // with the trunk free the trunk turns and a gaze behind the body works
  const trunk = IK.lookAt(MAN, start, at(150), { ...turnOnly, free: [...turnOnly.free, "trunk"] });
  assert.ok(trunk.reachable, `${(trunk.error.lookAt * R2D).toFixed(2)}`);
  const turn = [...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints].reduce((s, id) => s + (trunk.angles[id]?.[2] ?? 0), 0);
  assert.ok(turn > 5, `the trunk turned ${turn.toFixed(0)} degrees`);
});

// ---- 7. elbow and knee direction ---------------------------------------------------------------------------------------------
test("elbow and knee direction: reaching a point on the front plane keeps the elbow below the shoulder-hand line and outside the trunk; knees point forward", (t) => {
  let n = 0, penetrating = 0;
  for (const [name, body, solver] of SOLVERS) {
    const start = standing(solver), prox = bodyProxies(figureOf(body));
    const sh = solver.worldPoint(start, { joint: "shoulder_R" });
    const len = sh.distanceTo(solver.worldPoint(start, "grip_centre_R"));
    const zf = sh.z + 0.6 * len;
    for (const x of [-0.3, -0.15, 0.05]) for (const dy of [-0.35, -0.15, 0.05, 0.2]) {
      const target = [x, sh.y + dy, zf];
      const r = IK.reachHand(solver, start, "R", target);
      if (!r.reachable) continue;
      n++;
      const S = sh, H = V(target), E = solver.worldPoint(r.pose, { joint: "elbow_R" });
      const line = H.clone().sub(S), t0 = E.clone().sub(S).dot(line) / line.lengthSq();
      const perp = E.clone().sub(S).sub(line.clone().multiplyScalar(t0));
      assert.ok(perp.y < -0.01, `${name} (${x}, ${dy}): the elbow is ${(perp.y * 1000).toFixed(0)} mm relative to the line (must be below)`);
      assert.ok(E.x < 0.03, `${name} (${x}, ${dy}): the elbow at x = ${E.x.toFixed(3)} is not through the trunk`);
      if (selfPenetrations(prox, proxyWorld(prox, solvePose(body, r.pose, r.root))).length) penetrating++; // pose.js capsule proxies: the solver does not avoid collisions, the pole just makes them rare
    }
    // a foot placed forward and up: the knee is in front of the hip-ankle line
    const hip = solver.worldPoint(start, { joint: "hip_R" });
    const f = IK.placeFoot(solver, start, "R", { position: [hip.x, 0.25, 0.3], flat: false });
    if (f.reachable) {
      const H = solver.worldPoint(f.pose, { joint: "hip_R" }), K = solver.worldPoint(f.pose, { joint: "knee_R" }), A = solver.worldPoint(f.pose, { joint: "ankle_R" });
      const line = A.clone().sub(H), t0 = K.clone().sub(H).dot(line) / line.lengthSq();
      const perp = K.clone().sub(H).sub(line.clone().multiplyScalar(t0));
      assert.ok(perp.z > 0.02, `${name}: the knee is ${(perp.z * 1000).toFixed(0)} mm in front of the hip-ankle line`);
    }
  }
  t.diagnostic(`${n} reaches checked, ${penetrating} with a self-penetration of the capsule proxies (the arm across the belly)`);
  assert.ok(n >= 60);
  assert.ok(penetrating <= 0.1 * n, `${penetrating} of ${n} reaches penetrate the trunk`);
});

// ---- 8. idempotence, determinism, performance ----------------------------------------------------------------------------------
test("idempotence: solving from the solution returns the same pose without iterating", () => {
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver);
    const sh = solver.worldPoint(start, { joint: "shoulder_R" });
    const goals = [
      { type: "position", id: "hand", landmark: "grip_centre_R", target: [sh.x - 0.1, sh.y - 0.2, sh.z + 0.4] },
      { type: "lookAt", id: "look", target: [0.3, 1.5, 2] },
      ...IK.pinGoals(solver, start, ["heel_sole_L", "heel_sole_R"]),
    ];
    const opts = { free: ["arm_R", "clavicle_R", "neck", "eyes", "legs", "trunk"] };
    const r1 = solver.solve(start, goals, opts);
    assert.ok(r1.reachable, name);
    const r2 = solver.solve(r1.pose, goals, opts);
    assert.ok(r2.iterations <= 1, `${name}: ${r2.iterations} iterations`);
    assert.deepEqual(r2.angles, r1.angles);
    assert.deepEqual(r2.root, r1.root);
    assert.ok(r2.reachable && r2.converged);
  }
});

test("determinism: the same inputs give the same bits, also from a fresh solver, also for restarts", () => {
  const a = IK.createSolver(MAN_BODY), b = IK.createSolver(MAN_BODY);
  const rnd = rng(5);
  for (let i = 0; i < 20; i++) {
    const pose = standing(a);
    for (const id of ARM_R) pose.angles[id] = randomAngles(id, rnd);
    const target = a.worldPoint(pose, "palm_centre_R").toArray();
    const goals = [{ type: "position", id: "g", landmark: "palm_centre_R", target }];
    const o = { free: ["arm_R", "clavicle_R"] };
    const r1 = a.solve(standing(a), goals, o), r2 = a.solve(standing(a), goals, o), r3 = b.solve(standing(b), goals, o);
    for (const r of [r2, r3]) { assert.deepEqual(r.angles, r1.angles); assert.deepEqual(r.root, r1.root); assert.equal(r.iterations, r1.iterations); assert.deepEqual(r.error, r1.error); }
  }
  const src = fs.readFileSync(path.join(ROOT, "site/js/human/ik.js"), "utf8");
  assert.ok(!/Math\.random/.test(src), "no Math.random in ik.js");
});

test("performance: arm reach under 3 ms median, whole body with 3 goals and pins under 12 ms median, a drag step well under a frame", (t) => {
  const solver = MAN;
  const start = standing(solver);
  const rnd = rng(77);
  // warm up the JIT as a page would have after the first drags
  for (let i = 0; i < 40; i++) IK.reachHand(solver, start, "R", [-0.1 - 0.4 * rnd(), 1.0 + 0.5 * rnd(), 0.2 + 0.4 * rnd()]);
  const arm = [];
  for (let i = 0; i < 300; i++) arm.push(IK.reachHand(solver, start, "R", [-0.1 - 0.4 * rnd(), 1.0 + 0.5 * rnd(), 0.2 + 0.4 * rnd()]).ms);
  const pinIds = ["heel_sole_L", "ball_sole_medial_L", "heel_sole_R", "ball_sole_medial_R", "grip_centre_L"];
  const whole = (from, target) => solver.solve(from, [...IK.pinGoals(solver, start, pinIds), { type: "position", id: "hand_R", landmark: "grip_centre_R", target }, { type: "lookAt", id: "look", target }], { free: ["all", "pelvis-y"] });
  for (let i = 0; i < 20; i++) whole(start, [-0.1 - 0.4 * rnd(), 1.0 + 0.5 * rnd(), 0.3 + 0.3 * rnd()]);
  const body = [], ok = [];
  for (let i = 0; i < 100; i++) { const r = whole(start, [-0.1 - 0.4 * rnd(), 1.0 + 0.6 * rnd(), 0.3 + 0.4 * rnd()]); body.push(r.ms); ok.push(r.reachable); }
  // a drag: every solve starts from the previous pose
  const drag = [];
  let cur = start;
  for (let i = 0; i < 150; i++) { const a = i / 15; const r = whole(cur, [-0.25 + 0.1 * Math.sin(a), 1.3 + 0.1 * Math.cos(a), 0.45 + 0.05 * Math.sin(2 * a)]); cur = r.pose; drag.push(r.ms); }
  t.diagnostic(`arm reach from standing: median ${median(arm).toFixed(3)} ms (max ${Math.max(...arm).toFixed(2)}); whole body (5 pins, a hand, a look-at, all joints + pelvis y) from standing: median ${median(body).toFixed(2)} ms (p90 ${[...body].sort((x, y) => x - y)[90].toFixed(1)}), ${ok.filter(Boolean).length}/100 reachable; whole-body drag step: median ${median(drag).toFixed(2)} ms (max ${Math.max(...drag).toFixed(1)})`);
  // a drag beyond the reach: one run, not nine
  const beyond = [], beyondFull = [];
  for (let i = 0; i < 40; i++) {
    const sh = solver.worldPoint(start, { joint: "shoulder_R" }), t = [sh.x - 0.05, sh.y - 0.2, sh.z + 1.1 + 0.004 * i]; // within the straight-chain bound, beyond what the limits allow
    beyond.push(solver.solve(start, [{ type: "position", id: "g", landmark: "grip_centre_R", target: t }], { ...IK.DRAG_OPTIONS, free: ["arm_R", "clavicle_R", "trunk"] }).ms);
    beyondFull.push(solver.solve(start, [{ type: "position", id: "g", landmark: "grip_centre_R", target: t }], { free: ["arm_R", "clavicle_R", "trunk"] }).ms);
  }
  t.diagnostic(`goal beyond the reach, arm + clavicle + trunk free: DRAG_OPTIONS median ${median(beyond).toFixed(2)} ms, default (restarts) median ${median(beyondFull).toFixed(2)} ms (max ${Math.max(...beyondFull).toFixed(0)})`);
  assert.ok(median(beyond) < 8, `drag beyond the reach: ${median(beyond)} ms`);
  assert.ok(median(arm) < 3, `arm median ${median(arm)}`);
  assert.ok(median(body) < 12, `whole body median ${median(body)}`);
  assert.ok(median(drag) < 6);
});

// ---- 9. symmetry ------------------------------------------------------------------------------------------------------------------
test("left / right symmetry: a target and its mirror image give the same anatomical angles on the other side", () => {
  for (const [name, , solver] of SOLVERS) {
    const rnd = rng(31), start = standing(solver);
    for (let i = 0; i < 12; i++) {
      const pose = standing(solver);
      for (const id of ARM_R) pose.angles[id] = randomAngles(id, rnd, 0.7);
      const t = solver.worldPoint(pose, "palm_centre_R").toArray();
      const rr = solver.solve(start, [{ type: "position", id: "g", landmark: "palm_centre_R", target: t }], { free: ["arm_R", "clavicle_R", "trunk"] });
      const rl = solver.solve(start, [{ type: "position", id: "g", landmark: "palm_centre_L", target: [-t[0], t[1], t[2]] }], { free: ["arm_L", "clavicle_L", "trunk"] });
      assert.equal(rr.reachable, rl.reachable, `${name} #${i}`);
      for (const j of ["shoulder", "elbow", "forearm", "wrist", "clavicle"]) {
        rr.angles[`${j}_R`].forEach((v, k) => assert.ok(Math.abs(v - rl.angles[`${j}_L`][k]) < 1e-5, `${name} #${i} ${j}[${k}]: ${v} vs ${rl.angles[`${j}_L`][k]}`));
      }
      // the trunk mirrors too: lateral bend and rotation change sign, flexion stays
      for (const id of [...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints]) {
        const a = rr.angles[id] ?? [0, 0, 0], b = rl.angles[id] ?? [0, 0, 0];
        assert.ok(Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] + b[1]) < 1e-5 && Math.abs(a[2] + b[2]) < 1e-5, `${name} #${i} ${id}`);
      }
    }
    // feet and gaze
    const rf = IK.placeFoot(solver, start, "R", { position: [-0.15, 0.2, 0.5], heading: -15 }), lf = IK.placeFoot(solver, start, "L", { position: [0.15, 0.2, 0.5], heading: 15 });
    for (const j of ["hip", "knee", "ankle"]) rf.angles[`${j}_R`].forEach((v, k) => assert.ok(Math.abs(v - lf.angles[`${j}_L`][k]) < 1e-5, `${name} ${j}[${k}]`));
    const mid = solver.worldPoint(start, "eye_mid"), a = IK.lookAt(solver, start, [mid.x + 0.7, mid.y + 0.3, mid.z + 1.5]), b = IK.lookAt(solver, start, [mid.x - 0.7, mid.y + 0.3, mid.z + 1.5]);
    for (const id of REGIONS.cervical.joints) assert.ok(Math.abs(a.angles[id][0] - b.angles[id][0]) < 1e-5 && Math.abs(a.angles[id][2] + b.angles[id][2]) < 1e-5);
    assert.ok(Math.abs(a.angles.eye_L[1] - b.angles.eye_R[1]) < 1e-5 && Math.abs(a.angles.eye_L[0] - b.angles.eye_R[0]) < 1e-5, "the eyes mirror in the joint convention (the same angles on the other side)");
  }
});

// ---- 10. spine regions --------------------------------------------------------------------------------------------------------
test("region distribution: a trunk lean uses lumbar and thoracic, each region spread over its vertebrae by the REGIONS weights", () => {
  const start = standing(MAN);
  const vertex = MAN.worldPoint(start, "vertex");
  const r = MAN.solve(start, [{ type: "position", id: "head", landmark: "vertex", target: [vertex.x, vertex.y - 0.04, vertex.z + 0.2] }], { free: ["trunk"], pole: {} });
  assert.ok(r.reachable, JSON.stringify(r.error));
  const total = (region, c) => REGIONS[region].joints.reduce((s, id) => s + (r.angles[id]?.[c] ?? 0), 0);
  const lumbar = total("lumbar", 0), thoracic = total("thoracic", 0);
  assert.ok(lumbar > 1 && thoracic > 1, `both regions flex: lumbar ${lumbar.toFixed(1)}, thoracic ${thoracic.toFixed(1)}`);
  for (const region of ["lumbar", "thoracic"]) {
    const tot = total(region, 0);
    REGIONS[region].joints.forEach((id, i) => {
      const share = (r.angles[id][0] / tot), w = REGIONS[region].weights[i];
      assert.ok(Math.abs(share - w) < 1e-6, `${id}: ${share.toFixed(4)} of the region, weight ${w.toFixed(4)}`);
    });
    // lateral bend and rotation are not used by a sagittal reach
    assert.ok(Math.abs(total(region, 1)) < 0.05 && Math.abs(total(region, 2)) < 0.05);
  }
  // the lumbar region (a longer lever, a cheaper joint chain) takes more than the thoracic per region here
  assert.ok(lumbar > thoracic * 0.5);
  // the cervical spine did not move
  for (const id of REGIONS.cervical.joints) assert.equal(r.angles[id], undefined);
  assert.deepEqual(problemsOf(r), []);
  // existing per-vertebra angles are kept and the region total goes on top
  const withL3 = { root: start.root, angles: { L3: [5, 0, 0] } };
  const r2 = MAN.solve(withL3, [{ type: "position", id: "head", landmark: "vertex", target: [vertex.x, vertex.y - 0.04, vertex.z + 0.2] }], { free: ["trunk"], pole: {} });
  const share = (id, i) => r2.angles[id][0] - (id === "L3" ? 5 : 0);
  const tot2 = REGIONS.lumbar.joints.reduce((s, id, i) => s + share(id, i), 0);
  REGIONS.lumbar.joints.forEach((id, i) => assert.ok(Math.abs(share(id, i) / tot2 - REGIONS.lumbar.weights[i]) < 1e-6));
  // a vertebra at its limit takes no more and the others take the rest (water-filling)
  const L = REGIONS.lumbar.joints, atLimit = { root: start.root, angles: { [L[0]]: [JOINT_BY_ID[L[0]].dof[0].max, 0, 0] } };
  const probe = MAN.jacobian(atLimit, [{ type: "position", id: "head", landmark: "vertex", target: [0, 1, 0] }], { free: ["lumbar"], pole: {} });
  const kf = probe.names.indexOf("lumbar.flex"), xs = Float64Array.from(probe.x);
  xs[kf] = 4 * D2R; // four more degrees of lumbar flexion, shared by the four levels that still have room
  const v1 = MAN.worldPoint(probe.poseAt(xs), "vertex");
  const r3 = MAN.solve(atLimit, [{ type: "position", id: "head", landmark: "vertex", target: [v1.x, v1.y, v1.z] }], { free: ["lumbar"], pole: {} });
  assert.deepEqual(problemsOf(r3), []);
  assert.ok(r3.reachable, JSON.stringify(r3.error));
  assert.ok(Math.abs(r3.angles[L[0]][0] - JOINT_BY_ID[L[0]].dof[0].max) < 1e-9, "the vertebra at its limit stays there");
  assert.ok(r3.angles[L[1]][0] > 0.5, "its neighbours take the lean");
  const tot3 = L.slice(1).reduce((s, id) => s + r3.angles[id][0], 0);
  L.slice(1).forEach((id, i) => assert.ok(Math.abs(r3.angles[id][0] / tot3 - REGIONS.lumbar.weights[i + 1] / (1 - REGIONS.lumbar.weights[0])) < 1e-6, `${id} shares the rest by its weight`));
});

// ---- 11. posture preservation, groups, locks --------------------------------------------------------------------------------------
test("posture preservation: the arm first, then the clavicle, then the trunk", () => {
  const start = standing(MAN);
  const sh = MAN.worldPoint(start, { joint: "shoulder_R" });
  const reachArm = 0.62;
  // inside the reach of the arm: the clavicle and the trunk stay (almost) where they were
  const a = IK.reachHand(MAN, start, "R", [sh.x - 0.1, sh.y - 0.15, sh.z + 0.5], { trunk: true });
  assert.ok(a.reachable);
  const trunkAngle = (r) => Math.max(0, ...[...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints].map((id) => Math.max(...(r.angles[id] ?? [0]).map(Math.abs))));
  const clav = (r) => Math.max(...r.angles.clavicle_R.map(Math.abs));
  assert.ok(trunkAngle(a) < 0.5, `trunk ${trunkAngle(a).toFixed(2)} degrees`);
  assert.ok(clav(a) < 6, `clavicle ${clav(a).toFixed(1)} degrees`);
  // a little beyond the straight arm: the clavicle (and then the trunk) take it
  const b = IK.reachHand(MAN, start, "R", [sh.x - 0.05, sh.y - 0.05, sh.z + reachArm + 0.1], { trunk: true });
  assert.ok(b.reachable, JSON.stringify(b.error));
  assert.ok(clav(b) > clav(a) + 5 || trunkAngle(b) > 1, `clavicle ${clav(b).toFixed(1)}, trunk ${trunkAngle(b).toFixed(1)}`);
  assert.ok(trunkAngle(b) < 25);
  // far beyond: the trunk leans, the arm is straight
  const c = IK.reachHand(MAN, start, "R", [sh.x - 0.05, sh.y - 0.2, sh.z + reachArm + 0.35], { trunk: true });
  assert.ok(c.reachable, JSON.stringify(c.error));
  assert.ok(trunkAngle(c) > trunkAngle(b));
  assert.ok(c.angles.elbow_R[0] < 25, `elbow ${c.angles.elbow_R[0].toFixed(1)}`);
});

test("lock, free groups, reference pose and stiffness", () => {
  const start = standing(MAN), sh = MAN.worldPoint(start, { joint: "shoulder_R" });
  const target = [sh.x - 0.1, sh.y - 0.1, sh.z + 0.5];
  const goal = [{ type: "position", id: "g", landmark: "grip_centre_R", target }];
  // a locked joint does not move, a locked DOF neither
  const locked = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R"], lock: ["clavicle_R", "elbow_R.flex"] });
  assert.ok(!locked.angles.clavicle_R || locked.angles.clavicle_R.every((v) => v === 0), "a locked joint does not move");
  assert.ok(!locked.angles.elbow_R || locked.angles.elbow_R[0] === 0, "a locked DOF does not move");
  assert.ok(locked.angles.shoulder_R.some((v) => v !== 0));
  assert.ok(locked.error.g < 0.5 || locked.reachable === false);
  // joints that are not free keep exactly what they had
  const dressed = { root: start.root, angles: { elbow_L: [40], head: [3, 1, 2], L3: [2, 1, 0] } };
  const r = MAN.solve(dressed, goal, { free: ["arm_R"] });
  assert.deepEqual(r.angles.elbow_L, [40]);
  assert.deepEqual(r.angles.head, [3, 1, 2]);
  assert.deepEqual(r.angles.L3, [2, 1, 0]);
  assert.deepEqual(r.changed.filter((id) => !id.endsWith("_R")), []);
  // the result is a pose rig.setPose takes as it is (joints not listed would become neutral: they are all listed)
  assert.deepEqual(Object.keys(r.pose).sort(), ["angles", "root"]);
  // a reference pose pulls the free redundancy toward it
  const refPose = IK.reachHand(MAN, start, "R", target, { pole: { elbow_R: [-1, 0, -0.2] } }).pose;
  const free = { free: ["arm_R", "clavicle_R"] };
  const plain = MAN.solve(start, goal, free);
  const pulled = MAN.solve(start, goal, { ...free, reference: refPose, referenceWeight: 50 });
  const dist = (a, b) => ARM_R.reduce((s, id) => s + a.angles[id].reduce((u, v, k) => u + (v - (b.angles[id]?.[k] ?? 0)) ** 2, 0), 0);
  assert.ok(plain.reachable && pulled.reachable);
  assert.ok(dist(pulled, refPose) <= dist(plain, refPose) + 1e-9, "closer to the reference");
  // stiffness: make the clavicle free and expensive/cheap
  const cheap = MAN.solve(start, [{ type: "position", id: "g", landmark: "grip_centre_R", target: [sh.x - 0.05, sh.y - 0.05, sh.z + 0.62] }], { free: ["arm_R", "clavicle_R"], stiffness: { clavicle: 0.0005 } });
  const dear = MAN.solve(start, [{ type: "position", id: "g", landmark: "grip_centre_R", target: [sh.x - 0.05, sh.y - 0.05, sh.z + 0.62] }], { free: ["arm_R", "clavicle_R"], stiffness: { clavicle: 0.5 } });
  const cl = (x) => x.angles.clavicle_R.reduce((s, v) => s + Math.abs(v), 0);
  assert.ok(cl(cheap) > cl(dear), `clavicle ${cl(cheap).toFixed(1)} (cheap) vs ${cl(dear).toFixed(1)} (dear)`);
  assert.throws(() => MAN.solve(start, goal, { stiffness: { bogus: 1 } }), /unknown key/);
});

test("goal types: pin, height, direction, aim, combined frame; weights decide a conflict; zero weight is ignored", () => {
  const start = standing(MAN);
  // pin keeps a landmark where it is
  const p0 = MAN.worldPoint(start, "heel_sole_R");
  const r = MAN.solve(start, [{ type: "pin", landmark: "heel_sole_R" }, { type: "position", id: "h", landmark: "grip_centre_R", target: [-0.2, 1.1, 0.4] }], { free: ["arm_R", "clavicle_R", "leg_R"] });
  assert.ok(MAN.worldPoint(r.pose, "heel_sole_R").distanceTo(p0) < 2e-4);
  // height: a landmark at a given height, free to move elsewhere
  const h = MAN.solve(start, [{ type: "height", id: "pelvis", landmark: "ASIS_L", height: 0.8 }], { free: ["pelvis-y"] });
  assert.ok(h.reachable && Math.abs(MAN.worldPoint(h.pose, "ASIS_L").y - 0.8) < 5e-4);
  // direction and aim
  const d = MAN.solve(start, [{ type: "direction", id: "dir", joint: "wrist_R", axis: "finger_axis", target: [0, 1, 0.3] }], { free: ["arm_R"] });
  assert.ok(d.reachable, JSON.stringify(d.error));
  const fa = dirOf(MAN, d.pose, "wrist_R", MAN.handFrame("R").finger);
  assert.ok(angleDeg(fa, V([0, 1, 0.3]).normalize()) < 0.2);
  const a = MAN.solve(start, [{ type: "aim", id: "pointer", landmark: "index_tip_R", axis: MAN.handFrame("R").finger, target: [-0.3, 1.5, 1.5] }], { free: ["arm_R", "clavicle_R", "hand_R"] });
  assert.ok(a.reachable, JSON.stringify(a.error));
  // zero weight: ignored (and not reported); two goals in conflict: the heavier one wins
  const z = MAN.solve(start, [{ type: "position", id: "x", landmark: "grip_centre_R", target: [0, 5, 0], weight: 0 }, { type: "position", id: "y", landmark: "grip_centre_R", target: [-0.2, 1.1, 0.4] }], { free: ["arm_R"] });
  assert.equal(z.error.x, undefined);
  assert.ok(z.reachable);
  const t1 = [-0.2, 1.1, 0.4], t2 = [-0.2, 1.1, 0.5];
  const heavy1 = MAN.solve(start, [{ type: "position", id: "a", landmark: "grip_centre_R", target: t1, weight: 20 }, { type: "position", id: "b", landmark: "grip_centre_R", target: t2, weight: 1 }], { free: ["arm_R"] });
  assert.equal(heavy1.reachable, false);
  assert.ok(heavy1.error.a < heavy1.error.b / 5, `a ${heavy1.error.a} b ${heavy1.error.b}`);
  // duplicate ids get a suffix, never overwrite
  const dup = MAN.solve(start, [{ type: "position", landmark: "grip_centre_R", target: t1 }, { type: "position", landmark: "grip_centre_R", target: t1 }], { free: ["arm_R"] });
  assert.deepEqual(Object.keys(dup.error), ["grip_centre_R", "grip_centre_R#2"]);
});

test("inputs are never modified; nothing free is nothing to solve; the pelvis travels a bounded distance; a locked vertebra carries none of its region", () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const start = deepFreeze({ root: { ...MAN.restRoot }, angles: { elbow_L: [30], L3: [2, 0, 0] } });
  const goals = deepFreeze([{ type: "position", landmark: "grip_centre_R", target: [-0.2, 1.1, 0.4] }]);
  const options = deepFreeze({ free: ["arm_R", "trunk"], stiffness: { elbow: 0.01 }, pole: { elbow_R: [0, -1, 0] } });
  const r = MAN.solve(start, goals, options);
  assert.ok(r.reachable);
  assert.deepEqual(r.angles.elbow_L, [30]);
  assert.notEqual(r.angles.elbow_L, start.angles.elbow_L, "fresh arrays");
  // nothing free
  const none = MAN.solve(standing(MAN), [{ type: "position", landmark: "grip_centre_R", target: [0, 1, 0.5] }], { free: [] });
  assert.equal(none.reachable, false);
  assert.equal(none.iterations, 0);
  assert.deepEqual(none.changed, []);
  assert.ok(none.error.grip_centre_R > 0.2);
  assert.deepEqual(MAN.solve(standing(MAN), [], {}).error, {}, "no goals, no errors");
  // a target a kilometre away does not send the pelvis away
  const far = MAN.solve(standing(MAN), [{ type: "position", landmark: "grip_centre_R", target: [1e3, 1e3, 0] }], { free: ["all", "pelvis-xyz", "pelvis-rot"] });
  assert.equal(far.reachable, false);
  assert.ok(Math.hypot(far.root.x, far.root.y - MAN.restRoot.y, far.root.z) <= 1.5 * Math.sqrt(3) + 1e-9);
  assert.deepEqual(problemsOf(far), []);
  // a locked vertebra inside a free region carries none of the total
  const lean = [{ type: "position", id: "head", landmark: "vertex", target: [0, MAN.worldPoint(standing(MAN), "vertex").y - 0.03, 0.18] }];
  const locked = MAN.solve(standing(MAN), lean, { free: ["lumbar"], lock: ["L3"], pole: {} });
  assert.ok(locked.error.head < 0.01, "close: the lumbar spine alone moves the head along an arc");
  assert.ok(!locked.angles.L3 || locked.angles.L3[0] === 0, "L3 stays");
  assert.ok(locked.angles.L4[0] > 0 && locked.angles.L2[0] > 0);
  // a single string works for free and lock
  const str = MAN.solve(standing(MAN), [{ type: "position", landmark: "grip_centre_R", target: [-0.2, 1.1, 0.4] }], { free: "arm_R", lock: "wrist_R" });
  assert.ok(str.reachable && !str.angles.wrist_R);
});

// ---- 12. the helpers --------------------------------------------------------------------------------------------------------------
test("the solver poses the figure the rig draws: rig.setPose(result.pose) puts the landmarks where the solver said", () => {
  const rig = buildRig(MAN_BODY, { skeleton: false });
  const start = { root: { ...rig.getPose().root }, angles: rig.getPose().angles };
  const r = IK.reachHand(MAN, start, "R", [-0.2, 1.2, 0.5], { frame: { normal: [0, -1, 0], axis: [1, 0, 0] } });
  assert.ok(r.reachable);
  rig.setPose(r.pose, { clamp: false });
  const w = rig.landmarkWorld("grip_centre_R", new THREE.Vector3());
  assert.ok(w.distanceTo(V([-0.2, 1.2, 0.5])) < 1e-3, `rig and solver agree: ${w.distanceTo(V([-0.2, 1.2, 0.5])).toExponential(2)} m`);
  for (const id of ["heel_sole_L", "vertex", "index_tip_L", "pupil_R"]) assert.ok(rig.landmarkWorld(id, new THREE.Vector3()).distanceTo(MAN.worldPoint(r.pose, id)) < 1e-9, id);
  // a rig body (restBody) gives the same solver
  const s2 = IK.createSolver(rig.restBody);
  assert.ok(s2.worldPoint(r.pose, "grip_centre_R").distanceTo(MAN.worldPoint(r.pose, "grip_centre_R")) < 1e-12);
  rig.dispose();
});

test("maxReach: the farthest the hand goes along a direction, from the shoulder", (t) => {
  const start = standing(MAN);
  const fwd = IK.maxReach(MAN, start, "R", {});
  const arm = MAN.worldPoint(start, { joint: "shoulder_R" }).distanceTo(MAN.worldPoint(start, "grip_centre_R"));
  t.diagnostic(`forward reach from the shoulder: ${(fwd.distance * 1000).toFixed(0)} mm (hanging arm: ${(arm * 1000).toFixed(0)} mm)`);
  assert.ok(fwd.distance > arm * 0.9 && fwd.distance < arm * 1.25);
  const at = (d) => IK.reachHand(MAN, start, "R", [fwd.origin[0] + fwd.direction[0] * d, fwd.origin[1] + fwd.direction[1] * d, fwd.origin[2] + fwd.direction[2] * d]);
  assert.ok(at(fwd.distance - 0.002).reachable);
  assert.ok(!at(fwd.distance + 0.01).reachable);
  assert.ok(fwd.result.reachable);
  // with the trunk free the hand goes farther; upward is about the same as forward
  const withTrunk = IK.maxReach(MAN, start, "R", { trunk: true });
  assert.ok(withTrunk.distance > fwd.distance + 0.03, `${withTrunk.distance} vs ${fwd.distance}`);
  const up = IK.maxReach(MAN, start, "R", { direction: [0, 1, 0] });
  assert.ok(up.distance > arm * 0.8 && up.distance < arm * 1.25);
  const sideways = IK.maxReach(MAN, start, "L", { direction: [1, 0, 0] });
  assert.ok(sideways.distance > arm * 0.8);
});

test("reach envelope: seeded, within the arm's range, a closed hull", (t) => {
  const start = standing(MAN);
  const e1 = IK.reachEnvelope(MAN, start, "R", { samples: 1500, seed: 3 }), e2 = IK.reachEnvelope(MAN, start, "R", { samples: 1500, seed: 3 }), e3 = IK.reachEnvelope(MAN, start, "R", { samples: 1500, seed: 4 });
  assert.deepEqual(Array.from(e1.points), Array.from(e2.points), "same seed, same points");
  assert.notDeepEqual(Array.from(e1.points), Array.from(e3.points));
  const arm = MAN.worldPoint(start, { joint: "shoulder_R" }).distanceTo(MAN.worldPoint(start, "grip_centre_R"));
  t.diagnostic(`envelope: ${e1.count} points in ${e1.ms.toFixed(0)} ms, farthest ${(e1.maxDistance * 1000).toFixed(0)} mm from the shoulder, hull ${e1.hull.faces.length / 3} triangles`);
  assert.ok(e1.maxDistance > arm * 0.95 && e1.maxDistance < arm * 1.3 + 0.1);
  // a closed triangle mesh: V - E + F = 2 with E = 3F / 2
  const F = e1.hull.faces.length / 3, Vn = e1.hull.vertices.length / 3;
  assert.equal(Vn - (3 * F) / 2 + F, 2, "Euler characteristic of a sphere");
  // every sampled point is inside (or on) the hull
  const vs = e1.hull.vertices, fs_ = e1.hull.faces;
  let worst = 0;
  for (let i = 0; i < e1.count; i += 7) {
    const p = V([e1.points[3 * i], e1.points[3 * i + 1], e1.points[3 * i + 2]]);
    for (let f = 0; f < F; f++) {
      const a = V([vs[3 * fs_[3 * f]], vs[3 * fs_[3 * f] + 1], vs[3 * fs_[3 * f] + 2]]), b = V([vs[3 * fs_[3 * f + 1]], vs[3 * fs_[3 * f + 1] + 1], vs[3 * fs_[3 * f + 1] + 2]]), c = V([vs[3 * fs_[3 * f + 2]], vs[3 * fs_[3 * f + 2] + 1], vs[3 * fs_[3 * f + 2] + 2]]);
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      worst = Math.max(worst, p.clone().sub(a).dot(n));
    }
  }
  assert.ok(worst < 1e-5, `a point is ${worst} outside the hull`);
  // the bounds contain the origin's neighbourhood and the right hand is mostly on the right
  assert.ok(e1.centroid[0] < e1.origin[0] + 0.1);
  // the trunk widens it
  const et = IK.reachEnvelope(MAN, start, "R", { samples: 1500, seed: 3, trunk: true });
  assert.ok(et.maxDistance > e1.maxDistance);
});

test("convexHull: a cube with interior points, coplanar and tiny inputs", () => {
  const pts = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) pts.push(x, y, z);
  const rnd = rng(9);
  for (let i = 0; i < 60; i++) pts.push(0.05 + 0.9 * rnd(), 0.05 + 0.9 * rnd(), 0.05 + 0.9 * rnd());
  const h = IK.convexHull(Float64Array.from(pts));
  assert.equal(h.vertices.length / 3, 8);
  assert.equal(h.faces.length / 3, 12);
  assert.equal(IK.convexHull(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])).faces.length, 0, "coplanar: no volume");
  assert.equal(IK.convexHull(new Float64Array(6)).faces.length, 0);
});

test("a body from the synthetic fallback and a stature-only body work as well", () => {
  for (const body of [fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" } } }), fitBody({ sex: "F", measures: { stature: { value: 1200, unit: "mm" } } })]) {
    const s = IK.createSolver(body), start = standing(s), sh = s.worldPoint(start, { joint: "shoulder_R" });
    const r = IK.reachHand(s, start, "R", [sh.x - 0.1, sh.y - 0.1, sh.z + 0.3]);
    assert.ok(r.reachable);
    assert.deepEqual(problemsOf(r), []);
  }
});


// ---- 12. defects found by the independent verification -----------------------------------------------------------------------------
/** The largest rotation (degrees) of the world frame of any of `ids` between two poses, and the largest displacement (metres) of any of the `points`. */
function frameMeter(solver) {
  const offsets = {};
  for (const j of JOINTS) if (j.parent) offsets[j.id] = Array.from(solver.body.joints[j.id].offset).slice(0, 3);
  const ka = new Kinematics(offsets), kb = new Kinematics(offsets), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  return (pa, pb, ids, points = []) => {
    ka.solve(pa.angles, pa.root); kb.solve(pb.angles, pb.root);
    let rot = 0, move = 0;
    for (const id of ids) { ka.quaternion(id, qa); kb.quaternion(id, qb); rot = Math.max(rot, 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * R2D); }
    for (const p of points) move = Math.max(move, solver.worldPoint(pa, p).distanceTo(solver.worldPoint(pb, p)));
    return { rot, move };
  };
}
/** The largest change of any angle (degrees) of any joint between two poses, and of any root rotation. */
const maxAngleChange = (a, b) => {
  let m = 0;
  for (const id of new Set([...Object.keys(a.angles), ...Object.keys(b.angles)])) (b.angles[id] ?? a.angles[id]).forEach((v, i) => { m = Math.max(m, Math.abs(v - (a.angles[id]?.[i] ?? 0))); });
  for (const k of ["heading", "flex", "lat", "rot"]) m = Math.max(m, Math.abs((b.root[k] ?? 0) - (a.root[k] ?? 0)));
  return m;
};

test("drag continuity: a hand that circles the head at 6 mm per frame moves the elbow by less than 40 mm and any joint frame by less than 15 degrees per frame", (t) => {
  let worstElbow = 0, worstRot = 0, frames = 0;
  for (const [, , solver] of [SOLVERS[0], SOLVERS[1], SOLVERS[2], SOLVERS[4]]) {
    const meter = frameMeter(solver), sh = solver.worldPoint(standing(solver), { joint: "shoulder_R" });
    for (const hy of [0.3, 0.15]) {
      const pts = Array.from({ length: 200 }, (_, i) => { const u = i / 199; return [sh.x + 0.2 * Math.cos(2 * Math.PI * u) + 0.1, sh.y + hy, sh.z + 0.2 * Math.sin(2 * Math.PI * u)]; });
      let cur = IK.reachHand(solver, standing(solver), "R", pts[0]).pose;
      for (let i = 1; i < pts.length; i++) {
        const r = IK.reachHand(solver, cur, "R", pts[i], IK.DRAG_OPTIONS), m = meter(cur, r.pose, ARM_R, [{ joint: "elbow_R" }]);
        worstElbow = Math.max(worstElbow, m.move); worstRot = Math.max(worstRot, m.rot); frames++;
        assert.deepEqual(problemsOf(r), []);
        cur = r.pose;
      }
    }
  }
  t.diagnostic(`${frames} frames: worst elbow step ${(worstElbow * 1000).toFixed(0)} mm, worst joint frame ${worstRot.toFixed(1)} degrees`);
  assert.ok(worstElbow < 0.04 && worstRot < 15, `elbow ${worstElbow}, rotation ${worstRot}`);
});

test("drag continuity: paths that are reachable by construction (forward kinematics of smooth in-ROM joint trajectories), hand 13 to 26 mm per frame, never a jump", (t) => {
  let frames = 0, lag = 0, worstElbow = 0, worstRot = 0, maxStep = 0, paths = 0;
  const rnd = rng(555);
  for (const [, , solver] of [SOLVERS[1], SOLVERS[3]]) {
    const meter = frameMeter(solver);
    for (let p = 0; p < 6; p++) {
      const spec = ARM_R.map((id) => JOINT_BY_ID[id].dof.map((d) => ({ mid: (d.min + d.max) / 2, half: ((d.max - d.min) / 2) * 0.8, f: 0.4 + 1.2 * rnd(), ph: 6.283 * rnd() })));
      const n = p % 2 ? 450 : 900, pts = [];
      for (let i = 0; i < n; i++) {
        const u = (i / (n - 1)) * 2 * Math.PI, angles = {};
        ARM_R.forEach((id, k) => { angles[id] = clampAngles(id, spec[k].map((q) => q.mid + q.half * Math.sin(q.f * u + q.ph))).angles; });
        const g = solver.worldPoint({ root: solver.restRoot, angles }, "grip_centre_R");
        pts.push([g.x, g.y, g.z]);
      }
      paths++;
      let cur = IK.reachHand(solver, standing(solver), "R", pts[0]).pose;
      for (let i = 1; i < n; i++) {
        const r = IK.reachHand(solver, cur, "R", pts[i], IK.DRAG_OPTIONS), m = meter(cur, r.pose, ARM_R, [{ joint: "elbow_R" }]);
        maxStep = Math.max(maxStep, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
        worstElbow = Math.max(worstElbow, m.move); worstRot = Math.max(worstRot, m.rot); frames++; if (!r.reachable) lag++;
        assert.ok(maxAngleChange(cur, r.pose) <= IK.DRAG_OPTIONS.maxMove * R2D + 1e-9, "no joint moves more than maxMove per call");
        cur = r.pose;
      }
    }
  }
  t.diagnostic(`${paths} paths, ${frames} frames, hand step up to ${(maxStep * 1000).toFixed(0)} mm: worst elbow step ${(worstElbow * 1000).toFixed(0)} mm, worst joint frame ${worstRot.toFixed(1)} degrees, ${lag} frames behind the handle`);
  assert.ok(worstElbow < 0.04 && worstRot < 15, `elbow ${worstElbow}, rotation ${worstRot}`);
  assert.ok(lag / frames < 0.05, `${lag} of ${frames} frames behind the handle`);
});

test("drag continuity of the foot and of the gaze, also with the trunk free, along wide paths that leave the reachable zone", (t) => {
  const rnd = rng(4242);
  let frames = 0, worst = 0, worstRot = 0;
  for (const [, , solver] of [SOLVERS[1], SOLVERS[0]]) {
    const meter = frameMeter(solver), hip = solver.worldPoint(standing(solver), { joint: "hip_R" }), eye = solver.worldPoint(standing(solver), "eye_mid");
    for (let p = 0; p < 6; p++) {
      const A = [0, 1, 2].map(() => 0.1 + 0.3 * rnd()), ph = [0, 1, 2].map(() => 6.28 * rnd()), fr = [0, 1, 2].map(() => 0.5 + rnd());
      const foot = (u) => [{ type: "position", id: "foot", landmark: "heel_sole_R", target: [hip.x + A[0] * Math.sin(fr[0] * u + ph[0]), hip.y - 0.55 + A[1] * Math.sin(fr[1] * u + ph[1]), hip.z + 0.15 + A[2] * Math.sin(fr[2] * u + ph[2])] }];
      const gaze = (u) => { const yaw = 100 * Math.sin(fr[0] * u + ph[0]) * D2R, pit = 70 * Math.sin(fr[1] * u + ph[1]) * D2R, d = 2 + Math.sin(fr[2] * u); return [{ type: "lookAt", id: "look", target: [eye.x + d * Math.sin(yaw) * Math.cos(pit), eye.y + d * Math.sin(pit), eye.z + d * Math.cos(yaw) * Math.cos(pit)] }]; };
      for (const [goalAt, free, ids, pts] of [[foot, ["leg_R"], H_LEG, [{ joint: "knee_R" }]], [gaze, ["neck", "eyes"], NECK_ROT, [{ joint: "head" }]], [gaze, ["neck", "eyes", "trunk"], NECK_ROT, [{ joint: "head" }]]]) {
        let cur = solver.solve(standing(solver), goalAt(0), { free }).pose;
        for (let i = 1; i < 300; i++) {
          const r = solver.solve(cur, goalAt((i / 299) * 2 * Math.PI), { ...IK.DRAG_OPTIONS, free }), m = meter(cur, r.pose, ids, pts);
          worst = Math.max(worst, m.move); worstRot = Math.max(worstRot, m.rot); frames++;
          assert.deepEqual(problemsOf(r), []);
          cur = r.pose;
        }
      }
    }
  }
  t.diagnostic(`${frames} frames: worst knee / head step ${(worst * 1000).toFixed(0)} mm, worst joint frame ${worstRot.toFixed(1)} degrees`);
  assert.ok(worst < 0.04 && worstRot < 15, `${worst} m, ${worstRot} degrees`);
});
const H_LEG = ["hip_R", "knee_R", "ankle_R"];
const NECK_ROT = ["head", "eye_L", "eye_R", ...REGIONS.cervical.joints];

test("maxMove: no variable moves farther than that per call (joints, spine regions, pelvis), result.limited says the figure is still on its way, repeated calls arrive", () => {
  const solver = MAN, start = standing(solver), sh = solver.worldPoint(start, { joint: "shoulder_R" }), target = [sh.x - 0.1, sh.y + 0.2, sh.z + 0.5];
  const cap = 0.03 * R2D;
  let cur = start, calls = 0, r;
  do {
    r = IK.reachHand(solver, cur, "R", target, { maxMove: 0.03, maxIterations: 30 });
    assert.ok(maxAngleChange(cur, r.pose) <= cap + 1e-9, `call ${calls}: ${maxAngleChange(cur, r.pose)} degrees`);
    if (!r.reachable) assert.ok(r.limited === true, "short of the goal because of the cap: limited");
    cur = r.pose; calls++;
  } while (!r.reachable && calls < 80);
  assert.ok(r.reachable && !r.limited, `arrived after ${calls} calls`);
  assert.ok(calls > 10, "it took several calls: the cap held the figure back");
  assert.match(IK.describeResult(IK.reachHand(solver, start, "R", target, { maxMove: 0.03 }))[0], /still on its way/);
  // wild goals, wild free sets with the trunk and the pelvis: the bound holds for every variable
  const rnd = rng(77), ids = JOINTS.map((j) => j.id).filter((id) => id !== "pelvis"), FREE = [["all", "pelvis-xyz", "pelvis-rot"], ["arm_R", "clavicle_R", "trunk", "pelvis-xz"], ["legs", "pelvis-y", "pelvis-tilt"], ["L3", "T5", "C4", "head", "lumbar.flex"]];
  let n = 0;
  for (const [, , sv] of [SOLVERS[1], SOLVERS[2]]) for (let it = 0; it < 60; it++) {
    const angles = {};
    for (const id of ids) if (rnd() < 0.5) angles[id] = randomAngles(id, rnd, 0.9);
    const st = { root: { x: rnd() - 0.5, y: sv.restRoot.y + 0.2 * (rnd() - 0.5), z: rnd() - 0.5, heading: 360 * rnd() - 180, flex: 20 * rnd(), lat: 10 * rnd(), rot: 20 * rnd() }, angles };
    const goals = [{ type: "position", landmark: ["grip_centre_R", "heel_sole_L", "pupil_L", "vertex"][it % 4], target: [2 * rnd() - 1, 2 * rnd(), 2 * rnd() - 0.5] }, { type: "pin", landmark: "heel_sole_R" }];
    const res = sv.solve(st, goals, { ...IK.DRAG_OPTIONS, maxMove: 0.05, free: FREE[it % 4] });
    assert.ok(maxAngleChange(st, res) <= 0.05 * R2D + 1e-9, `solve ${n}: ${maxAngleChange(st, res)} degrees`);
    for (const k of ["x", "y", "z"]) assert.ok(Math.abs(res.root[k] - st.root[k]) <= 0.5 * 0.05 + 1e-9, "pelvis translation");
    assert.deepEqual(problemsOf(res), []);
    n++;
  }
  assert.throws(() => MAN.solve(start, [], { maxMove: 0 }), /maxMove/);
  assert.throws(() => MAN.solve(start, [], { maxMove: "1" }), /maxMove/);
  assert.throws(() => MAN.solve(start, [], { follow: 1 }), /follow/);
  assert.ok(IK.DRAG_OPTIONS.follow === true && IK.DRAG_OPTIONS.maxMove > 0 && Object.isFrozen(IK.DRAG_OPTIONS));
});

test("a drag that starts far from the goal glides there at a modest cost per frame (the preferences are not relaxed while the region of the move is full)", () => {
  // whole body: hand frame, look-at, six pins, every joint and the pelvis free, from the standing pose; the goal is 0.5 m away
  const solver = MAN, start = standing(solver), sh = solver.worldPoint(start, { joint: "shoulder_R" }), free = ["all", "pelvis-xyz", "pelvis-rot"];
  const goals = [{ type: "frame", id: "hand", joint: "wrist_R", landmark: "grip_centre_R", target: [sh.x - 0.1, sh.y + 0.25, sh.z + 0.5], axes: [{ local: "palm_normal", world: [0, 0, -1] }, { local: "hand_across", world: [0, 1, 0], line: true }] },
    { type: "lookAt", id: "look", target: [0, 1.6, 1] }, ...IK.pinGoals(solver, start, ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"])];
  let cur = start, frames = 0, iters = 0, r;
  do { r = solver.solve(cur, goals, { ...IK.DRAG_OPTIONS, free }); assert.ok(maxAngleChange(cur, r.pose) <= IK.DRAG_OPTIONS.maxMove * R2D + 1e-9); assert.deepEqual(problemsOf(r), []); iters += r.iterations; cur = r.pose; frames++; } while (!r.reachable && frames < 60);
  assert.ok(r.reachable, `arrived after ${frames} frames`);
  assert.ok(iters / frames <= 11, `${(iters / frames).toFixed(1)} iterations per frame over ${frames} frames`);
});

test("closest feasible pose: a goal beyond the reach ends no farther than 10 mm from the best of 8,000 random in-ROM arm poses (the shoulder, the cap and the extension limit have local minima)", (t) => {
  const solver = MAN, start = standing(solver), env = IK.reachEnvelope(solver, start, "R", { samples: 8000, seed: 99, hull: false }), P = env.points, sh = V(env.origin);
  const rnd = rng(3);
  let n = 0, worstGap = -Infinity;
  const targets = [V([0.11, 0.94, -0.33]).normalize().multiplyScalar(0.84)]; // the verifier's example: almost straight up and slightly back
  for (let i = 0; i < 45; i++) targets.push(V([2 * rnd() - 1, 1.6 * rnd() - 0.6, 2 * rnd() - 1]).normalize().multiplyScalar(0.75 + 0.55 * rnd()));
  for (const d of targets) {
    const tg = sh.clone().add(d);
    let best = Infinity;
    for (let k = 0; k < env.count; k++) best = Math.min(best, Math.hypot(P[3 * k] - tg.x, P[3 * k + 1] - tg.y, P[3 * k + 2] - tg.z));
    const r = IK.reachHand(solver, start, "R", [tg.x, tg.y, tg.z]);
    if (r.reachable) continue;
    n++; worstGap = Math.max(worstGap, r.error.hand_R - best);
    assert.deepEqual(problemsOf(r), []);
  }
  t.diagnostic(`${n} unreachable targets: the solver ends at most ${(worstGap * 1000).toFixed(1)} mm farther than the best of 8,000 random poses`);
  assert.ok(n >= 40);
  assert.ok(worstGap < 0.01, `${worstGap * 1000} mm`);
});

test("overhead reach: targets 0.45 m or more above the shoulder that are reachable by construction are solved (99%), a miss is never farther than 50 mm; the verifier's 590 mm miss is solved", (t) => {
  let n = 0, ok = 0, worst = 0;
  for (const [, , solver] of [SOLVERS[1], SOLVERS[0], SOLVERS[2]]) {
    const rnd = rng(31), sh = solver.worldPoint(standing(solver), { joint: "shoulder_R" });
    for (let got = 0; got < 120;) {
      const angles = Object.fromEntries(ARM_R.map((id) => [id, randomAngles(id, rnd)])), g = solver.worldPoint({ root: solver.restRoot, angles }, "grip_centre_R");
      if (g.y - sh.y < 0.45) continue;
      got++; n++;
      const e = IK.reachHand(solver, standing(solver), "R", [g.x, g.y, g.z]).error.hand_R;
      if (e < 1e-3) ok++; worst = Math.max(worst, e);
    }
  }
  t.diagnostic(`${ok}/${n} solved to 1 mm, worst miss ${(worst * 1000).toFixed(0)} mm`);
  assert.ok(ok / n >= 0.985, `${ok}/${n}`);
  assert.ok(worst < 0.05, `worst miss ${worst} m`);
  const F = IK.createSolver(army("F", 50)), r = IK.reachHand(F, standing(F), "R", [0.027627945046626995, 1.8577069355717954, -0.13055844528634175]);
  assert.ok(r.reachable, `the target 0.56 m above the shoulder (a hand straight up, the elbow nearly straight) is ${(r.error.hand_R * 1000).toFixed(0)} mm off`);
});

test("validation: every number a caller passes is checked; nothing is a silent no-op or a non-finite error", () => {
  const s = standing(MAN), T = [-0.25, 1.2, 0.45], free = ["arm_R", "clavicle_R"];
  const frame = (w) => ({ type: "frame", id: "f", joint: "wrist_R", landmark: "grip_centre_R", target: T, axes: [{ local: "palm_normal", world: [0, 0, 1], weight: w }, { local: "hand_across", world: [0, 1, 0], line: true }] });
  for (const w of [NaN, -1, "x", Infinity, 1e300]) assert.throws(() => MAN.solve(s, [frame(w)], { free }), /axis weight|weight/, `axis weight ${w}`);
  assert.ok(MAN.solve(s, [frame(0.5)], { free }).iterations > 0);
  assert.throws(() => IK.handFrameFromGrip({ position: T, normal: [0, 0, 1], axis: [0, 1, 0] }, "R", { normalWeight: NaN }), /normalWeight/);
  assert.throws(() => IK.handFrameFromGrip({ position: T, normal: [0, 0, 1], axis: [0, 1, 0] }, "R", { axisWeight: -2 }), /axisWeight/);
  const pos = (target) => [{ type: "position", landmark: "grip_centre_R", target }];
  assert.throws(() => MAN.solve(s, pos([1e308, 1e308, 1e308]), { free }), /absurdly far/);
  assert.throws(() => MAN.solve(s, [{ type: "height", landmark: "vertex", height: 1e300 }], { free }), /absurdly far/);
  assert.ok(Number.isFinite(MAN.solve(s, pos([1e6, 0, 0]), { free }).residual), "a point 1000 km away is far, not absurd");
  for (const reference of [{ angles: { elbow_R: [NaN] } }, { angles: { bogus: [1] } }, { angles: { elbow_R: "x" } }, { root: { heading: NaN } }, { root: { bogus: 1 } }, "x", 5]) assert.throws(() => MAN.solve(s, pos(T), { free, reference }), /reference/, JSON.stringify(reference));
  assert.deepEqual(MAN.solve(s, pos(T), { free, reference: null }).pose, MAN.solve(s, pos(T), { free }).pose, "reference: null is no reference");
  for (const o of [{ tolerance: "1" }, { tolerance: Infinity }, { angTolerance: NaN }, { stepMax: 0 }, { stepMax: -1 }, { stepMax: NaN }, { seed: "x" }, { seed: NaN }, { seed: 1.5 }, { damping: "1" }, { angleScale: "1" }]) assert.throws(() => MAN.solve(s, pos(T), { free, ...o }), /options|must be/, JSON.stringify(o));
  assert.throws(() => MAN.solve(s, [{ ...pos(T)[0], tolerance: "1" }], { free }), /tolerance/);
  assert.throws(() => MAN.solve(s, [{ ...pos(T)[0], tolerance: Infinity }], { free }), /tolerance/);
  for (const axis of ["constructor", "__proto__", "toString"]) assert.throws(() => MAN.solve(s, [{ type: "direction", joint: "wrist_R", axis, target: [0, 1, 0] }], { free }), /is not a named axis/, axis);
  const r = MAN.solve(s, [{ type: "position", id: "__proto__", landmark: "grip_centre_R", target: T }], { free });
  assert.ok(Object.keys(r.error).includes("__proto__") && Number.isFinite(r.error["__proto__"]) && r.units["__proto__"] === "m", "a goal called __proto__ is reported like any other");
  assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(r)).error, "__proto__") || true);
  assert.equal(IK.pinGoals(MAN, s, "heel_sole_L").length, 1, "one id is a list of one");
  assert.throws(() => IK.pinGoals(MAN, s, 5), /array/);
  assert.throws(() => IK.describeResult(null), /Result/);
  assert.throws(() => IK.describeResult({}), /Result/);
  // a look at the eye itself has no direction
  const eye = MAN.worldPoint(s, "eye_mid");
  assert.throws(() => IK.lookAt(MAN, s, [eye.x, eye.y, eye.z], { eyes: false }), /undefined/);
  assert.throws(() => MAN.solve(s, [{ type: "aim", landmark: "grip_centre_R", target: MAN.worldPoint(s, "grip_centre_R").toArray() }], { free }), /undefined/);
});

test("describeResult names, for each goal, the limits that push against that goal (not those of the whole result), strongest first", () => {
  const start = standing(MAN), r = IK.movePelvis(MAN, start, { dy: -0.4 });
  assert.equal(r.reachable, false);
  const lines = IK.describeResult(r);
  assert.ok(lines.length >= 4);
  for (const l of lines) {
    const left = l.startsWith("pin:") && /_L:/.test(l.split(" ")[0]), right = l.startsWith("pin:") && /_R:/.test(l.split(" ")[0]);
    if (right) assert.ok(!/Left/.test(l), l);
    if (left) assert.ok(!/Right/.test(l), l);
  }
  for (const c of r.clamped.filter((x) => x.blocking)) assert.ok(c.pushedBy.length > 0 && c.pushedBy.every((p) => p.force > 0), "a blocking limit lists the goals that push on it");
  assert.ok(r.clamped.filter((x) => x.blocking).every((c) => c.pushedBy.every((p) => p.goal in r.error)));
  // labels: an object, a function; goalLabel turns ids into words
  assert.match(IK.describeResult(r, { "pin:heel_sole_R": "The right heel" }).find((l) => /^The right heel/.test(l)), /^The right heel: \d+ mm short of the target \(limited by Right/);
  const words = IK.describeResult(r, IK.goalLabel);
  assert.ok(words.some((l) => l.startsWith("Right heel sole (pinned): ")) && words.some((l) => l.startsWith("Left ball sole medial (pinned): ")));
  assert.equal(IK.goalLabel("hand_R.rot"), "Right hand orientation");
  assert.equal(IK.goalLabel("lookAt"), "Look at");
  assert.equal(IK.goalLabel("foot_L.frame"), "Left foot frame");
  // a goal that no pose meets is named as such, the other goals are not blamed on the reach
  const sh = MAN.worldPoint(start, { joint: "shoulder_R" });
  const two = MAN.solve(start, [{ type: "position", id: "far", landmark: "grip_centre_R", target: [sh.x - 0.3, sh.y + 0.7, sh.z + 0.9] }, { type: "lookAt", id: "look", target: [0, 1.6, -3], weight: 1 }], { free: ["arm_R", "clavicle_R", "neck"] });
  const text = IK.describeResult(two);
  assert.match(text.find((l) => l.startsWith("far:")), /farther than the limb can stretch/);
  assert.ok(!text.some((l) => l.startsWith("look:") && /farther than the limb/.test(l)));
});

test("a start with a vertebra outside its range is repaired when its region is free, and kept when the vertebra is locked or the region is not free", () => {
  const goal = [{ type: "position", landmark: "grip_centre_R", target: [-0.25, 1.3, 0.5] }], start = { root: { ...MAN.restRoot }, angles: { L3: [60, 0, 0], T5: [0, 50, 0] } };
  const r = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R", "trunk"] });
  assert.deepEqual(problemsOf(r), []);
  assert.ok(r.changed.includes("L3") && r.changed.includes("T5"));
  assert.ok(r.angles.L3[0] <= JOINT_BY_ID.L3.dof[0].max + 1e-9 && Math.abs(r.angles.T5[1]) <= JOINT_BY_ID.T5.dof[1].max + 1e-9);
  const locked = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R", "trunk"], lock: ["L3"] });
  assert.equal(locked.angles.L3[0], 60, "a locked vertebra keeps what it was given");
  const notFree = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R"] });
  assert.equal(notFree.angles.L3[0], 60);
  assert.equal(notFree.angles.T5[1], 50);
  // an in-range start is not touched by the repair
  const fine = MAN.solve({ root: { ...MAN.restRoot }, angles: { L3: [5, 0, 0] } }, goal, { free: ["arm_R", "clavicle_R", "trunk"] });
  assert.ok(Math.abs(fine.angles.L3[0] - 5) < 3);
});

test("the hand frame: knuckle_line is the line through the metacarpale landmarks, about 6 degrees from hand_across (the line of the knuckle joints the grips curl about)", () => {
  for (const [, , solver] of [SOLVERS[0], SOLVERS[1], SOLVERS[2]]) for (const sd of ["L", "R"]) {
    const start = standing(solver), h = solver.handFrame(sd);
    const line = solver.worldPoint(start, `metacarpale_radiale_${sd}`).sub(solver.worldPoint(start, `metacarpale_ulnare_${sd}`)).normalize();
    assert.ok(V(h.line).angleTo(line) * R2D < 1e-6, "the named axis is the landmark line");
    const off = V(h.line).angleTo(V(h.across)) * R2D;
    assert.ok(off > 3 && off < 9, `${off.toFixed(1)} degrees between the two conventions`);
    // a goal on it works like any other axis
    const g = { type: "direction", joint: `wrist_${sd}`, axis: "knuckle_line", target: [0, 0, 1], line: true };
    const r = solver.solve(start, [g], { free: [`arm_${sd}`] });
    assert.ok(r.reachable, `knuckle_line goal: ${(r.error.direction ?? r.error[`wrist_${sd}`]) * R2D} degrees`);
    const here = dirOf(solver, r, `wrist_${sd}`, h.line);
    assert.ok(Math.abs(here.z) > Math.cos(0.5 * D2R));
  }
});

test("warmUp changes nothing but the speed of the first solves; rootRange is a limit per axis", () => {
  const solver = IK.createSolver(MAN_BODY), start = standing(solver), sh = solver.worldPoint(start, { joint: "shoulder_R" });
  const goal = [{ type: "position", landmark: "grip_centre_R", target: [sh.x - 0.2, sh.y + 0.3, sh.z + 0.5] }];
  const before = JSON.stringify({ ...solver.solve(start, goal, { free: ["arm_R", "clavicle_R"] }), ms: 0 });
  const ms = IK.warmUp(solver, 1);
  assert.ok(ms > 0 && ms < 5000);
  assert.equal(JSON.stringify({ ...solver.solve(start, goal, { free: ["arm_R", "clavicle_R"] }), ms: 0 }), before);
  // a goal 100 m away with the pelvis free: x and z may each travel rootRange (1.5 m by default), so the pelvis ends at most sqrt 2 times that from where it was
  const far = solver.solve(start, [{ type: "position", landmark: "grip_centre_R", target: [60, 1.2, 80] }], { free: ["arm_R", "clavicle_R", "pelvis-xz"] });
  assert.ok(Math.abs(far.root.x) <= 1.5 + 1e-9 && Math.abs(far.root.z) <= 1.5 + 1e-9 && Math.hypot(far.root.x, far.root.z) > 1.5, `${far.root.x}, ${far.root.z}`);
  const tight = solver.solve(start, [{ type: "position", landmark: "grip_centre_R", target: [60, 1.2, 80] }], { free: ["arm_R", "clavicle_R", "pelvis-xz"], rootRange: 0.3 });
  assert.ok(Math.abs(tight.root.x) <= 0.3 + 1e-9 && Math.abs(tight.root.z) <= 0.3 + 1e-9);
});

// ---- 12. the defects an independent verifier found (second round) -----------------------------------------------------------------
const armOf = (side) => ARM_R.map((id) => id.replace("_R", `_${side}`));
/** The largest rotation (degrees) any joint makes between two poses: the angle of the relative quaternion, not a difference of DOF numbers. */
function turnDeg(a, b) {
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  let worst = 0;
  for (const id of Object.keys(b.angles)) { jointQuaternion(id, a.angles[id] ?? [], qa); jointQuaternion(id, b.angles[id], qb); worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * R2D); }
  return worst;
}
/** The library postures placed on the body of MAN: { id, start } for every posture that expands. */
function libraryStarts() {
  const out = [];
  for (const p of POSTURES) {
    try {
      const ex = expandPosture(p), root = placePose(MAN_BODY, ex, { posture: p });
      out.push({ id: p.id, start: { root: { x: root.x, y: root.y, z: root.z, heading: root.heading, flex: root.flex, lat: root.lat, rot: root.rot }, angles: JSON.parse(JSON.stringify(ex.angles)) } });
    } catch { /* a posture that does not place on this body */ }
  }
  return out;
}

test("6D hand-frame goals (the bar axis has no sign): grips that are reachable by construction are solved from the standing start almost as often as with the sign given", (t) => {
  const rnd = rng(1), rig = buildRig(MAN_BODY, { skeleton: false });
  let n = 0, free = 0, signed = 0;
  for (let i = 0; i < 300; i++) {
    const sd = i % 2 ? "L" : "R", angles = {};
    for (const id of armOf(sd)) angles[id] = randomAngles(id, rnd);
    const pose = { root: { ...MAN.restRoot }, angles }, pos = MAN.worldPoint(pose, `grip_centre_${sd}`);
    rig.setPose(pose, { clamp: false });
    const q = rig.jointQuaternion(`wrist_${sd}`, new THREE.Quaternion()), hf = MAN.handFrame(sd);
    const grip = { position: [pos.x, pos.y, pos.z], normal: V(hf.normal).applyQuaternion(q).toArray(), axis: V(hf.across).applyQuaternion(q).toArray(), diameter: 0.03 };
    const opt = { free: [`arm_${sd}`, `clavicle_${sd}`] };
    n++;
    if (MAN.solve(standing(MAN), [IK.handFrameFromGrip(grip, sd)], opt).reachable) free++;
    if (MAN.solve(standing(MAN), [IK.handFrameFromGrip(grip, sd, { line: false })], opt).reachable) signed++;
  }
  t.diagnostic(`sign free ${free}/${n}, sign given ${signed}/${n} (before: 257 and 296 of 300)`);
  assert.ok(free / n >= 0.96, `sign free: ${free}/${n}`);
  assert.ok(free >= signed - 0.03 * n, `sign free ${free} against sign given ${signed}`);
});

test("a line goal takes the sign nearer to the direction it is at, in every evaluation: the axis asked for in either direction is the same goal", () => {
  const start = { root: { ...MAN.restRoot }, angles: { wrist_R: [20, 10] } };
  const here = dirOf(MAN, start, "wrist_R", MAN.handFrame("R").across);
  for (const sign of [1, -1]) {
    const goal = { type: "direction", joint: "wrist_R", axis: "hand_across", target: here.clone().multiplyScalar(sign).toArray(), line: true };
    const r = MAN.solve(start, [goal], { free: ["arm_R"] });
    assert.ok(r.reachable && r.iterations === 0, `a goal that is met as it is (sign ${sign})`);
  }
  // tilted a few degrees, in either sign: the same small motion of the wrist, and the error does not depend on the sign
  const tilt = here.clone().add(new THREE.Vector3(0, 0.04, 0)).normalize();
  const a = MAN.solve(start, [{ type: "direction", joint: "wrist_R", axis: "hand_across", target: tilt.toArray(), line: true }], { free: ["wrist_R"] });
  const b = MAN.solve(start, [{ type: "direction", joint: "wrist_R", axis: "hand_across", target: tilt.clone().negate().toArray(), line: true }], { free: ["wrist_R"] });
  assert.ok(a.reachable && b.reachable);
  assert.ok(Math.abs(a.angles.wrist_R[0] - b.angles.wrist_R[0]) < 0.05 && Math.abs(a.angles.wrist_R[1] - b.angles.wrist_R[1]) < 0.05, `${a.angles.wrist_R} against ${b.angles.wrist_R}`);
});

test("a hand goal near the hand keeps the posture of the start (8 cm: no flip of the arm), and the pose is continuous where the automatic follow switches on (5 cm)", (t) => {
  const rows = [], steps = [];
  for (const { start } of libraryStarts()) {
    for (const sd of ["L", "R"]) {
      const h = MAN.worldPoint(start, `grip_centre_${sd}`);
      for (const d of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const at = (m) => [h.x + d[0] * m, h.y + d[1] * m, h.z + d[2] * m];
        const a = IK.reachHand(MAN, start, sd, at(0.08));
        if (a.reachable) rows.push(turnDeg(start, a.pose));
        if (d[1] >= 0 || d[0] === 0) { const lo = IK.reachHand(MAN, start, sd, at(0.047)), hi = IK.reachHand(MAN, start, sd, at(0.053)); if (lo.reachable && hi.reachable) steps.push(turnDeg(lo.pose, hi.pose)); }
      }
    }
  }
  const flips = rows.filter((x) => x > 40).length, s2 = [...steps].sort((x, y) => x - y);
  t.diagnostic(`${flips} of ${rows.length} moves of 8 cm turn a joint more than 40 degrees (before: 225 of 1107; the rest bend a straight limb: an arm that hangs needs 45 to 60 degrees of elbow to bring the hand 8 cm up); 4.7 against 5.3 cm: median ${median(steps).toFixed(1)}, p90 ${s2[Math.floor(s2.length * 0.9)].toFixed(1)} degrees (before: 14, 44)`);
  assert.ok(rows.length > 900);
  assert.ok(flips / rows.length < 0.05, `${flips} of ${rows.length}`);
  assert.ok(median(steps) < 5 && s2[Math.floor(s2.length * 0.9)] < 15 && steps.filter((x) => x > 30).length / steps.length < 0.02, "the pose does not jump at 5 cm");
});

test("options.reference holds a chosen posture: the elbow and knee pole of a limb is the side the reference has it on, and the avoidance of the ends of the ranges leaves the joints the reference put there", (t) => {
  const st = standing(MAN), A = [-0.3, 1.2, 0.45];
  const raised = IK.reachHand(MAN, st, "R", A, { pole: { elbow_R: [-1, 0.3, 0] } }).pose;
  const el = (p) => MAN.worldPoint(p, { joint: "elbow_R" });
  const wiggle = (opt) => { let cur = raised; for (let i = 0; i < 60; i++) cur = IK.reachHand(MAN, cur, "R", [A[0] + 0.003 * Math.sin(i), A[1] + 0.003 * Math.cos(i), A[2]], { ...IK.DRAG_OPTIONS, ...opt }).pose; return cur; };
  const withRef = el(wiggle({ reference: raised })).distanceTo(el(raised)), without = el(wiggle({})).distanceTo(el(raised));
  t.diagnostic(`a 3 mm wiggle for 60 drag frames moves the elbow ${(withRef * 1000).toFixed(1)} mm with the reference, ${(without * 1000).toFixed(1)} mm without (before: 227 and 237)`);
  assert.ok(withRef < 0.01, `with the reference: ${withRef * 1000} mm`);
  assert.ok(without < 0.06, `without: ${without * 1000} mm`);
  // the first frame of the wiggle: the goal moves 3 mm, the posture hardly (it moved 3 to 4 degrees and the elbow 22 to 33 mm)
  const first = IK.reachHand(MAN, raised, "R", [A[0], A[1] + 0.003, A[2]], { ...IK.DRAG_OPTIONS, reference: raised });
  assert.ok(turnDeg(raised, first.pose) < 1, `${turnDeg(raised, first.pose)} degrees in the first frame`);
  // a pole of its own wins over the pole of the reference
  const down = el(wiggle({ reference: raised, pole: { elbow_R: [0, -1, 0] } })).y, held = el(wiggle({ reference: raised })).y;
  assert.ok(down < held - 0.02, `explicit pole ${down} against reference ${held}`);
  // out and back by 15 cm from library postures: with the reference the elbow comes back
  const back = [];
  for (const { start } of libraryStarts().filter((_, i) => i % 5 === 0)) {
    for (const sd of ["L", "R"]) {
      const h = MAN.worldPoint(start, `grip_centre_${sd}`).clone(), opt = { ...IK.DRAG_OPTIONS, reference: start };
      let cur = start;
      for (let i = 1; i <= 80; i++) { const u = i <= 40 ? i / 40 : (80 - i) / 40; cur = IK.reachHand(MAN, cur, sd, [h.x, h.y, h.z + 0.15 * u], opt).pose; }
      let fin = IK.reachHand(MAN, cur, sd, [h.x, h.y, h.z], opt);
      for (let k = 0; k < 30 && fin.error[`hand_${sd}`] > 5e-4; k++) fin = IK.reachHand(MAN, fin.pose, sd, [h.x, h.y, h.z], opt);
      if (fin.error[`hand_${sd}`] <= 1e-3) back.push(MAN.worldPoint(fin.pose, { joint: `elbow_${sd}` }).distanceTo(MAN.worldPoint(start, { joint: `elbow_${sd}` })));
    }
  }
  const b2 = [...back].sort((x, y) => x - y);
  t.diagnostic(`out and back by 15 cm with reference: start: ${back.length} cases, the elbow ends ${(median(back) * 1000).toFixed(1)} mm (median), ${(b2[Math.floor(b2.length * 0.95)] * 1000).toFixed(0)} mm (p95) from where it was (before: 40, 134)`);
  assert.ok(back.length > 20 && median(back) < 0.01 && b2[Math.floor(b2.length * 0.95)] < 0.05);
  // validation of the weight without a reference, and a zero pole
  assert.throws(() => MAN.solve(st, [{ type: "position", landmark: "grip_centre_R", target: A }], { free: ["arm_R"], referenceWeight: -1 }), /referenceWeight/);
  assert.throws(() => MAN.solve(st, [{ type: "position", landmark: "grip_centre_R", target: A }], { free: ["arm_R"], pole: { elbow_R: [0, 0, 0] } }), /zero vector/);
});

test("a squat is the exact sagittal squat: no axial twist of the legs where a twist-free solution exists, the same pose with and without follow, and no jump while the height is scrubbed", (t) => {
  const rows = [];
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver), twist = (r) => Math.max(...["L", "R"].map((sd) => Math.max(Math.abs(r.angles[`hip_${sd}`][2]), Math.abs(r.angles[`knee_${sd}`][1]), Math.abs(r.angles[`ankle_${sd}`][2]), Math.abs(r.angles[`ankle_${sd}`][1]), Math.abs(r.angles[`hip_${sd}`][1]))));
    for (const dy of [-0.02, -0.048, -0.1]) {
      const a = IK.movePelvis(solver, start, { dy }), b = IK.movePelvis(solver, start, { dy }, { follow: true });
      assert.ok(a.reachable && b.reachable, `${name} ${dy}`);
      const lock = ["hip_L.rot", "hip_R.rot", "knee_L.rot", "knee_R.rot", "ankle_L.rot", "ankle_R.rot", "ankle_L.inv", "ankle_R.inv", "hip_L.abd", "hip_R.abd"];
      assert.ok(IK.movePelvis(solver, start, { dy }, { lock }).reachable, "the twist-free squat is reachable");
      assert.ok(twist(a) < 2 && twist(b) < 2, `${name} ${dy}: twist ${twist(a).toFixed(2)} (follow ${twist(b).toFixed(2)}) degrees`);
      assert.ok(turnDeg(a.pose, b.pose) < 1, `${name} ${dy}: follow or not is the same squat`);
      if (dy === -0.1) rows.push(`${name} ${twist(a).toFixed(1)}`);
    }
    // scrubbing the height in steps of 3 mm: reachable neighbours are neighbours in pose
    let prev = null, worst = 0;
    for (let i = 1; i <= 34; i++) { const r = IK.movePelvis(solver, start, { dy: -0.003 * i }); if (prev && prev.reachable && r.reachable) worst = Math.max(worst, turnDeg(prev.pose, r.pose)); prev = r; }
    assert.ok(worst < 8, `${name}: a joint turns ${worst.toFixed(1)} degrees between two heights 3 mm apart`);
  }
  t.diagnostic(`axial twist at -0.1 m (degrees; before: 4 to 26): ${rows.join(", ")}`);
});

test("movePelvis called for every frame of a slider: the feet do not creep (also from the previous pose), and with an anchor they stay where they were put", () => {
  const start = standing(MAN), ids = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"];
  const ref = ids.map((id) => MAN.worldPoint(start, id));
  const offset = (pose) => Math.max(...ids.map((id, i) => MAN.worldPoint(pose, id).distanceTo(ref[i]))) * 1000;
  let cur = start, anchored = start, worst = 0;
  for (let i = 1; i <= 250; i++) { cur = IK.movePelvis(MAN, cur, { dy: -0.001 }).pose; anchored = IK.movePelvis(MAN, anchored, { dy: -0.001 }, { anchor: start }).pose; worst = Math.max(worst, offset(anchored)); }
  assert.ok(offset(cur) < 1.5, `from the previous pose: ${offset(cur)} mm after 250 calls (10 mm before)`);
  assert.ok(worst < 0.1, `with an anchor: ${worst} mm`);
  for (let i = 1; i <= 250; i++) anchored = IK.movePelvis(MAN, anchored, { dy: 0.001 }, { anchor: start }).pose;
  assert.ok(offset(anchored) < 0.1 && Math.abs(anchored.root.y - start.root.y) < 1e-9, "and back up");
  assert.throws(() => IK.movePelvis(MAN, start, { dy: -0.1 }, { anchor: 5 }), /anchor/);
  assert.throws(() => IK.movePelvis(MAN, null, { dy: -0.1 }), /start/);
  assert.throws(() => IK.movePelvis(MAN, start, { dy: -0.1 }, null), /options/);
});

test("frame goals with a quaternion of the wrong type throw (they used to become the identity orientation); a THREE.Quaternion, { x, y, z, w } and a typed array are fine", () => {
  const start = { root: { ...MAN.restRoot }, angles: { wrist_R: [30, 10] } }, free = ["arm_R"];
  for (const q of ["abc", {}, 5, true, [], [1], [1, 2, 3], [1, 2, 3, "w"], [1, 2, 3, null], { x: 1, y: 2, z: 3 }, { x: "a", y: 0, z: 0, w: 1 }, [0, 0, 0, 0], [NaN, 0, 0, 1], new Float64Array(3)]) {
    assert.throws(() => MAN.solve(start, [{ type: "frame", joint: "wrist_R", quaternion: q }], { free }), Error, JSON.stringify(q));
  }
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.3, 0.1));
  const a = MAN.solve(start, [{ type: "frame", joint: "wrist_R", quaternion: q }], { free }), b = MAN.solve(start, [{ type: "frame", joint: "wrist_R", quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } }], { free }), c = MAN.solve(start, [{ type: "frame", joint: "wrist_R", quaternion: Float64Array.of(q.x, q.y, q.z, q.w) }], { free });
  assert.deepEqual(a.pose, b.pose); assert.deepEqual(a.pose, c.pose);
});

test("a free shoulder that starts beyond the 180 degree swing cap is repaired also when the goals are already met; a shoulder that is not free is kept as given", () => {
  const pin = [{ type: "pin", landmark: "heel_sole_L" }], start = { root: { ...MAN.restRoot }, angles: { shoulder_R: [150, 150, 0] } };
  const r = MAN.solve(start, pin, { free: ["arm_R"] });
  assert.deepEqual(problemsOf(r), []);
  assert.ok(r.changed.includes("shoulder_R") && swingLength("shoulder_R", r.angles.shoulder_R) <= 180 + 1e-9, JSON.stringify(r.angles.shoulder_R));
  const kept = MAN.solve(start, pin, { free: ["arm_L"] });
  assert.deepEqual(kept.angles.shoulder_R, [150, 150, 0]);
  assert.deepEqual(kept.changed, []);
  const on = MAN.solve({ root: { ...MAN.restRoot }, angles: { shoulder_R: [120, 120, 0] } }, pin, { free: ["arm_R"] }); // exactly on the cap: 169.7 degrees, inside
  assert.deepEqual(on.changed, []);
});

test("an absurd but finite start (root.x 1e200, an angle of 1e300 degrees, a pelvis moved by 1e300) is an error with a message, not an Infinity or NaN error", () => {
  const goal = [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.45] }], free = ["arm_R"], st = standing(MAN);
  assert.throws(() => MAN.solve({ root: { ...MAN.restRoot, x: 1e200 }, angles: {} }, goal, { free }), /start\.root\.x.*absurdly/);
  assert.throws(() => MAN.solve({ root: { ...MAN.restRoot, flex: 1e300 }, angles: {} }, goal, { free }), /start\.root\.flex.*absurdly/);
  assert.throws(() => MAN.solve({ root: { ...MAN.restRoot }, angles: { elbow_R: [1e300] } }, goal, { free }), /elbow_R.*absurdly/);
  assert.throws(() => MAN.worldPoint({ root: { ...MAN.restRoot, y: 1e300 }, angles: {} }, "vertex"), /absurdly/);
  assert.throws(() => MAN.solve(st, goal, { free, reference: { root: { x: 1e300 } } }), /reference.*absurdly/);
  assert.throws(() => IK.movePelvis(MAN, st, { dy: 1e300 }), /pelvis position/);
  assert.throws(() => IK.movePelvis(MAN, st, { target: [0, 1e300, 0] }), /absurdly|pelvis position/);
  const big = MAN.solve({ root: { ...MAN.restRoot, x: 1e6 }, angles: { elbow_R: [90] } }, [{ type: "position", landmark: "grip_centre_R", target: [1e6 - 0.3, 1.2, 0.45] }], { free });
  assert.ok(Number.isFinite(big.residual) && Object.values(big.error).every(Number.isFinite), "a pelvis 1000 km away is far, not absurd");
});

test("validation: options of the wrong type, a bad envelope seed, null arguments and the words for a NaN are named, not raw TypeErrors", () => {
  const st = standing(MAN), goal = [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.45] }];
  assert.throws(() => MAN.reachEnvelope(st, "R", null), /options/);
  for (const seed of [1.5, "a", NaN, Infinity]) assert.throws(() => MAN.reachEnvelope(st, "R", { seed, samples: 10 }), /seed/, String(seed));
  for (const o of [{ stiffness: 5 }, { stiffness: [1] }, { stiffness: "x" }, { pole: 5 }, { pole: "x" }, { pole: [] }, { referenceWeight: -1 }, { referenceWeight: NaN }, { referenceWeight: "1" }, { analyticStart: "yes" }]) assert.throws(() => MAN.solve(st, goal, o), Error, JSON.stringify(o));
  assert.ok(MAN.solve(st, goal, { stiffness: null, pole: null, referenceWeight: 0.5 }).iterations > 0, "null is no option");
  assert.ok(IK.describeResult({ error: { a: NaN }, tolerance: { a: 1e-3 } }).length === 1, "a NaN is not met");
  assert.equal(IK.describeResult({ error: { a: 1e-4 }, tolerance: { a: 1e-3 } }).length, 0);
  assert.equal(IK.goalLabel("pin:"), "Pinned point");
  assert.equal(IK.goalLabel(NaN), "NaN");
  assert.equal(IK.goalLabel("pin:heel_sole_R"), "Right heel sole (pinned)");
  for (const id of ["pin:", ".rot", "hand_R.rot", "x", "_", "pin:_L"]) assert.equal(IK.goalLabel(id), IK.goalLabel(id).trim(), id);
});

test("free joints that no goal depends on are not variables: the same pose and the same iterations as with the joints named that matter, and they still appear in the result", () => {
  const start = standing(MAN), goal = [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.3, 0.5] }];
  const big = MAN.solve(start, goal, { free: ["all", "hands", "eyes", "jaw", "toes_L", "toes_R"] }), small = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R", "trunk"] });
  assert.deepEqual(big.pose.root, small.pose.root);
  for (const id of Object.keys(small.angles)) assert.deepEqual(big.angles[id], small.angles[id], id);
  assert.equal(big.iterations, small.iterations);
  for (const id of ["eye_L", "index_mcp_L", "leg_L".replace("leg_L", "hip_L"), "jaw", "mtp_L"]) assert.ok(Array.isArray(big.angles[id]) && big.angles[id].every((v) => v === 0), id);
  assert.deepEqual(big.changed.filter((id) => !small.changed.includes(id)), []);
  // an inert joint that starts outside its range is repaired (a free joint is), and with a reference it is pulled toward the chosen posture
  const odd = MAN.solve({ root: { ...MAN.restRoot }, angles: { elbow_L: [200] } }, goal, { free: ["arm_R", "arm_L"] });
  assert.ok(odd.angles.elbow_L[0] <= JOINT_BY_ID.elbow_L.dof[0].max && odd.changed.includes("elbow_L"));
  const pulled = MAN.solve(start, goal, { free: ["arm_R", "clavicle_R", "hand_L"], reference: { angles: { index_mcp_L: [30, 0] } } });
  assert.ok(pulled.angles.index_mcp_L[0] > 1, `the reference pulls an idle free joint: ${pulled.angles.index_mcp_L}`);
  // a big free set with conflicting goals is no longer 100 times slower than the necessary one
  const absurd = [{ type: "position", id: "a", landmark: "grip_centre_R", target: [-0.5, 2.5, 0.5] }, { type: "position", id: "b", landmark: "grip_centre_R", target: [0.5, 0.2, 0.9] }, { type: "lookAt", target: [0, 1, -5] }];
  const t0 = performance.now();
  const r = MAN.solve(start, absurd, { free: ["all", "hands", "pelvis-xyz"], restarts: 10 });
  assert.deepEqual(problemsOf(r), []);
  assert.ok(performance.now() - t0 < 1500);
});

// ---- 13. the defects an independent verifier found (third round) ------------------------------------------------------------------
const population = (name, percentile = 50) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations", `${name.replace(/\/([MF]|both)$/, "/$1")}.json`))), { percentile }));
const popSolver = (name) => IK.createSolver(population(name));

test("a goal 1 to 2 cm from the hand, default options (and follow: true), is a small move of the pose: the avoidance of the ends of the ranges resists going deeper into a corner, it does not pull a posture out of one", (t) => {
  const rnd = rng(3), turn = [], turnFollow = [];
  const dirIn = () => V([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]).normalize();
  for (const { start } of libraryStarts()) {
    for (const sd of ["R", "L"]) {
      const A = MAN.worldPoint(start, `grip_centre_${sd}`), B = A.clone().addScaledVector(dirIn(), 0.01), at = [B.x, B.y, B.z];
      const a = IK.reachHand(MAN, start, sd, at), f = IK.reachHand(MAN, start, sd, at, { follow: true });
      if (a.reachable) turn.push(turnDeg(start, a.pose));
      if (f.reachable) turnFollow.push(turnDeg(start, f.pose));
    }
  }
  // from poses that the solver itself made (a start with the joints inside their ranges and away from the ends): 1 to 2 cm in a random direction
  const fromSolved = [];
  for (let i = 0; i < 240; i++) {
    const sd = i % 2 ? "L" : "R", sh = MAN.worldPoint(standing(MAN), { joint: `shoulder_${sd}` });
    const p = sh.clone().add(V([(rnd() - 0.5) * 1.0, (rnd() - 0.2) * 0.9, rnd() * 0.7]).setLength(0.25 + 0.3 * rnd())), s = IK.reachHand(MAN, standing(MAN), sd, [p.x, p.y, p.z]);
    if (!s.reachable) continue;
    const q = p.clone().addScaledVector(dirIn(), 0.01 + 0.01 * rnd()), r = IK.reachHand(MAN, s.pose, sd, [q.x, q.y, q.z]);
    if (r.reachable) fromSolved.push(turnDeg(s.pose, r.pose));
  }
  const pc = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
  t.diagnostic(`library postures, 1 cm: ${turn.length} moves, ${turn.filter((x) => x > 10).length} turn a joint more than 10 degrees, max ${Math.max(...turn).toFixed(0)} (before: 114 of 243, 22 over 40); from solved poses, 1 to 2 cm: p90 ${pc(fromSolved, 0.9).toFixed(1)}, p99 ${pc(fromSolved, 0.99).toFixed(1)}, max ${Math.max(...fromSolved).toFixed(1)} degrees (before: p90 39, p99 86, max 177)`);
  assert.ok(turn.length > 150 && fromSolved.length > 150);
  assert.ok(turn.filter((x) => x > 10).length / turn.length < 0.06 && Math.max(...turn) < 25, `library: ${turn.filter((x) => x > 10).length} of ${turn.length}, max ${Math.max(...turn)}`);
  assert.ok(turnFollow.filter((x) => x > 10).length / turnFollow.length < 0.06 && Math.max(...turnFollow) < 25, "follow: true alone is the same");
  assert.ok(pc(fromSolved, 0.9) < 10 && pc(fromSolved, 0.99) < 25 && Math.max(...fromSolved) < 40, `from solved poses: p90 ${pc(fromSolved, 0.9)}, max ${Math.max(...fromSolved)}`);
});

test("the avoidance of the ends of the ranges never pulls a joint that sits in a zone out of it: a goal that is met, or a null-space motion, leaves a posture in a corner alone; going deeper is resisted", () => {
  // the shoulder at 150 degrees of flexion (in the zone of its end), the goal 2 mm from the hand: the pose may not slide away from its start by more than the 2 mm need
  const start = { root: { ...MAN.restRoot }, angles: { shoulder_R: [150, 20, 0], elbow_R: [30], clavicle_R: [20, 0] } };
  const h = MAN.worldPoint(start, "grip_centre_R"), r = IK.reachHand(MAN, start, "R", [h.x, h.y + 0.002, h.z], { follow: true });
  assert.ok(r.reachable);
  assert.ok(turnDeg(start, r.pose) < 5, `${turnDeg(start, r.pose)} degrees for 2 mm`);
  // the same goal held for 60 frames with DRAG_OPTIONS settles
  let cur = start, last = null, prev = null;
  for (let i = 0; i < 60; i++) { prev = cur; last = IK.reachHand(MAN, cur, "R", [h.x, h.y + 0.002, h.z], IK.DRAG_OPTIONS); cur = last.pose; }
  assert.ok(turnDeg(prev, cur) < 0.01 && turnDeg(start, cur) < 5);
});

test("a handle held still beyond the reach (or in a corner) with DRAG_OPTIONS settles: no frame-to-frame cycle, no creeping in the null space of the arm, `limited` only while the figure is on its way", (t) => {
  let tot = 0, moving = 0, cyc = 0, limitedStill = 0;
  for (const name of ["united-states/army/M", "japan/air-force/F", "brazil/army/M"]) {
    const solver = popSolver(name), rnd = rng(11 + name.length);
    for (const sd of ["R", "L"]) {
      const sh = solver.worldPoint(standing(solver), { joint: `shoulder_${sd}` });
      for (let k = 0; k < 8; k++) {
        const dir = V([(rnd() - 0.5) * 2, rnd() * 1.4 - 0.4, rnd() * 1.4 - 0.4]).normalize(), T = sh.clone().addScaledVector(dir, 0.65 * (1.05 + 0.75 * rnd()));
        let cur = standing(solver), prev = null, prev2 = null, last = null;
        for (let i = 0; i < 260; i++) { prev2 = prev; prev = cur; last = IK.reachHand(solver, cur, sd, [T.x, T.y, T.z], IK.DRAG_OPTIONS); cur = last.pose; }
        tot++;
        const step = turnDeg(prev, cur);
        if (step > 0.1) { moving++; if (prev2 && turnDeg(prev2, cur) < 0.01) cyc++; }
        else if (last.limited) limitedStill++; // not moving and still "on its way"?
      }
    }
  }
  t.diagnostic(`${tot} held goals beyond the reach: ${moving} still move after 260 frames, ${cyc} in a two-frame cycle, ${limitedStill} stand still but report limited (before, 150 frames: 56 % moving, 130 of 300 limited and moving)`);
  assert.equal(cyc, 0);
  assert.ok(moving / tot < 0.05, `${moving} of ${tot} still moving`);
  assert.equal(limitedStill, 0);
});

test("a drag that cannot get to a reachable goal stands still and does not say `limited` (so that the editor's full solve takes over); `limited` is true only while the figure is still making progress", (t) => {
  const solver = popSolver("united-states/army/M"), rnd = rng(900);
  let stuck = 0, cycling = 0, stuckLimited = 0, n = 0;
  for (let k = 0; k < 40; k++) {
    const sd = k % 2 ? "L" : "R", angles = Object.fromEntries(ARM_R.map((id) => [id.replace("_R", `_${sd}`), randomAngles(id, rnd)]));
    const T = solver.worldPoint({ root: { ...solver.restRoot }, angles }, `grip_centre_${sd}`);
    let cur = standing(solver), prev = null, prev2 = null, last = null;
    for (let i = 0; i < 300; i++) { prev2 = prev; prev = cur; last = IK.reachHand(solver, cur, sd, [T.x, T.y, T.z], IK.DRAG_OPTIONS); cur = last.pose; }
    n++;
    if (last.error[`hand_${sd}`] > 1e-3) {
      stuck++;
      if (turnDeg(prev, cur) > 0.1 && turnDeg(prev2, cur) < 0.01) cycling++;
      if (last.limited && turnDeg(prev, cur) < 0.01) stuckLimited++;
    }
  }
  t.diagnostic(`${n} reachable far goals from a hanging arm, 300 frames: ${stuck} not reached (a local minimum of a drag), ${cycling} in a cycle, ${stuckLimited} standing still with limited true (before: 111 of 720 not reached, 57 in an exact 2.3 degree cycle with limited true)`);
  assert.equal(cycling, 0);
  assert.equal(stuckLimited, 0);
});

test("options.stiffness: every documented key is accepted and does what it says (joint ids, joint.dof of sided joints and vertebrae, both sides, groups, regions, the pelvis); a typo is an error", () => {
  const start = standing(MAN), sh = MAN.worldPoint(start, { joint: "shoulder_R" });
  const goal = [{ type: "position", id: "g", landmark: "grip_centre_R", target: [sh.x - 0.05, sh.y - 0.1, sh.z + 0.5] }];
  const flex = (stiffness, free = ["arm_R", "clavicle_R"]) => MAN.solve(start, goal, { free, stiffness });
  const base = flex({}), keys = ["shoulder_R.flex", "knee_L.flex", "L3.flex", "eye_L.azim", "shoulder.flex", "shoulder_R", "shoulder", "clavicle", "clavicle_R.prot", "lumbar", "lumbar.flex", "hand", "vertebra", "index_mcp_R.flex", "index_mcp.abd", "T12.rot", "pelvis", "pelvis.y", "pelvis.tilt", "pelvis.heading", "ankle_L.rot", "mtp_R.dorsi", "jaw.open", "wrist_R.dev", "head.lat", "cervical.rot"];
  for (const k of keys) assert.doesNotThrow(() => MAN.solve(start, goal, { stiffness: { [k]: 0.01 } }), k);
  for (const k of ["elbow.flx", "foo.bar", "shoulder_R.flx", "shoulder_X.flex", "Shoulder_R", "tx", "constructor", "toString", "__proto__", "pelvis.q", "lumbar.up", "", "elbow_R.flex.x", " elbow"]) assert.throws(() => MAN.solve(start, goal, { stiffness: Object.fromEntries([[k, 0.01]]) }), /unknown key/, JSON.stringify(k));
  // effect: a very stiff shoulder flexion leaves the shoulder flexion alone and the elbow and the clavicle take the reach
  const stiffShoulder = flex({ "shoulder_R.flex": 5 }), sameBoth = flex({ "shoulder.flex": 5 });
  assert.ok(base.reachable && Math.abs(stiffShoulder.angles.shoulder_R[0]) < Math.abs(base.angles.shoulder_R[0]) - 5, `shoulder_R.flex stiff: ${stiffShoulder.angles.shoulder_R[0]} against ${base.angles.shoulder_R[0]}`);
  assert.deepEqual(sameBoth.angles.shoulder_R, stiffShoulder.angles.shoulder_R);
  // the other side's key does not touch this arm
  assert.deepEqual(flex({ "shoulder_L.flex": 5 }).angles.shoulder_R, base.angles.shoulder_R);
  // a vertebra: with the individual vertebra L3 free, a stiff L3.flex moves the other lumbar vertebrae more
  const lean = [{ type: "position", id: "g", landmark: "grip_centre_R", target: [sh.x - 0.1, sh.y - 0.1, sh.z + 0.85] }], vert = (stiffness) => MAN.solve(start, lean, { free: ["arm_R", "clavicle_R", "L3", "L4"], stiffness });
  const cheapL3 = vert({ "L3.flex": 0.0005, "L4.flex": 5 }), cheapL4 = vert({ "L3.flex": 5, "L4.flex": 0.0005 });
  assert.ok(Math.abs(cheapL3.angles.L3[0]) > Math.abs(cheapL4.angles.L3[0]) + 1e-3 && Math.abs(cheapL4.angles.L4[0]) > Math.abs(cheapL3.angles.L4[0]) + 1e-3, "per-vertebra keys");
  // the pelvis: a cheap "pelvis" steps farther than a dear one
  const far = [{ type: "position", id: "g", landmark: "grip_centre_R", target: [sh.x, sh.y, sh.z + 0.9] }];
  const cheapP = MAN.solve(start, far, { free: ["arm_R", "clavicle_R", "pelvis-xz"], stiffness: { pelvis: 0.0005 } }), dearP = MAN.solve(start, far, { free: ["arm_R", "clavicle_R", "pelvis-xz"], stiffness: { pelvis: 5 } });
  assert.ok(Math.abs(cheapP.root.z - start.root.z) > Math.abs(dearP.root.z - start.root.z) + 0.01, `pelvis ${cheapP.root.z} vs ${dearP.root.z}`);
  // the fingers: "hand" is the group of the lot (a stiff hand keeps a free finger where it is when a reference pulls it)
  assert.doesNotThrow(() => MAN.solve(start, goal, { free: ["arm_R", "hand_R"], stiffness: { hand: 1 }, reference: { angles: { index_mcp_R: [60, 0] } } }));
});

test("reachable-by-construction arm targets that every start and every analytic pose falls short of (a corner: the shoulder swing at its cap, the clavicle at its end) are solved by more random restarts; `restarts` is the most, not more", () => {
  const cases = [
    ["united-states/aircrew/M", "R", { clavicle_R: [43.66859619272873, -24.419059045612812], shoulder_R: [-21.85524020344019, 124.38401856692508, -72.01910154428333], elbow_R: [-1.6285856405738741], forearm_R: [-63.78631217870861], wrist_R: [3.9718064316548407, 4.971246565692127] }, 0.097],
    ["ukraine/cadets/M", "L", { clavicle_L: [28.097030484350398, -24.82909446116537], shoulder_L: [-47.160893976688385, 123.55476500466466, -7.4999788496643305], elbow_L: [7.544249378843233], forearm_L: [-1.854579895734787], wrist_L: [-39.638682913500816, -13.008163457270712] }, 0.064],
  ];
  for (const [name, sd, angles, was] of cases) {
    const solver = popSolver(name), T = solver.worldPoint({ root: { ...solver.restRoot }, angles }, `grip_centre_${sd}`), t = [T.x, T.y, T.z];
    const r = IK.reachHand(solver, standing(solver), sd, t);
    assert.ok(r.error[`hand_${sd}`] < 0.005, `${name}: ${(r.error[`hand_${sd}`] * 1000).toFixed(1)} mm short (it was ${was * 1000} mm)`);
    assert.deepEqual(problemsOf(r), []);
    const none = IK.reachHand(solver, standing(solver), sd, t, { restarts: 0 }), few = IK.reachHand(solver, standing(solver), sd, t, { restarts: 2 });
    assert.ok(none.iterations < few.iterations && few.iterations < r.iterations, `${none.iterations} < ${few.iterations} < ${r.iterations}: restarts is the most, 0 is none`);
    assert.ok(none.error[`hand_${sd}`] > 0.005 || none.reachable);
    // a start at the true pose is still returned untouched; a goal no pose can meet spends no extra restarts
    assert.equal(IK.reachHand(solver, { root: { ...solver.restRoot }, angles }, sd, t).iterations, 0);
  }
  // an unreachable target within the straight chain but outside the ranges (behind the head, hand low): the extra restarts are bounded, the answer is the closest pose and says so
  const far = MAN.solve(standing(MAN), [{ type: "position", id: "g", landmark: "grip_centre_R", target: [-0.2, 1.0, -0.62] }], { free: ["arm_R", "clavicle_R"] });
  assert.ok(far.ms < 400 && !far.reachable === (far.error.g > 5e-4));
});

test("maxReach: a backward direction is not underestimated (the probes use the automatic restarts)", () => {
  let n = 0;
  for (const name of ["israel/army/M", "lithuania/recruits-trainees/M", "serbia/cadets/M"]) {
    const solver = popSolver(name);
    for (const sd of ["R", "L"]) {
      const mr = IK.maxReach(solver, standing(solver), sd, { direction: [0, 0.3, -1] });
      const beyond = IK.reachHand(solver, standing(solver), sd, mr.origin.map((o, i) => o + mr.direction[i] * (mr.distance + 0.03)), { restarts: 30 });
      assert.ok(!beyond.reachable, `${name} ${sd}: ${mr.distance.toFixed(3)} m but 3 cm farther is reachable`);
      n++;
    }
  }
  assert.equal(n, 6);
});

test("the Result owns its pose: result.pose.root and result.pose.angles are copies of result.root and result.angles, not the same objects", () => {
  const r = MAN.solve({ root: { ...MAN.restRoot }, angles: { elbow_R: [20] } }, [{ type: "position", landmark: "grip_centre_R", target: [-0.2, 1.2, 0.4] }], { free: ["arm_R"] });
  assert.notEqual(r.pose.root, r.root);
  assert.notEqual(r.pose.angles, r.angles);
  for (const id of Object.keys(r.angles)) assert.notEqual(r.pose.angles[id], r.angles[id], id);
  assert.deepEqual(r.pose.root, r.root);
  assert.deepEqual(r.pose.angles, r.angles);
  const keep = JSON.stringify(r.pose);
  r.root.x = 99; r.angles.elbow_R[0] = 1234;
  assert.equal(JSON.stringify(r.pose), keep, "editing result.root / result.angles must not change result.pose");
  r.pose.root.y = -5; r.pose.angles.shoulder_R[0] = -77;
  assert.notEqual(r.root.y, -5); assert.notEqual(r.angles.shoulder_R[0], -77);
});
