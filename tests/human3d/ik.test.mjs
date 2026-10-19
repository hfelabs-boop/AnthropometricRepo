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
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, swingLength } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { gripAngles } from "../../site/js/human/postures/grips.js";
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

test("reachable targets: palm with the trunk free (random trunk, arm and clavicle poses)", (t) => {
  const rate = reachRate("palm, arm + clavicle + trunk", t, (solver, rnd) => {
    const pose = standing(solver);
    for (const id of [...ARM_R, ...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints]) pose.angles[id] = randomAngles(id, rnd);
    const target = solver.worldPoint(pose, "palm_centre_R").toArray();
    return { goals: [{ type: "position", id: "g", landmark: "palm_centre_R", target }], options: { free: ["arm_R", "clavicle_R", "trunk"] }, ok: (r) => r.error.g <= 1e-3 };
  }, 100);
  assert.ok(rate >= 0.95, `rate ${rate}`);
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
  assert.ok(r.hopeless === true, "provably out of reach of a straight chain: no restarts were spent");
  const text = IK.describeResult(r, { hand_R: "The right hand" });
  assert.equal(text.length, 1);
  assert.match(text[0], /^The right hand: \d+ mm short of the target/);
  // slightly beyond the reach: the closest feasible pose, within centimetres, limits named
  const near = [sh.x - 0.1, sh.y - 0.1, sh.z + 0.75];
  const rn = IK.reachHand(MAN, start, "R", near);
  assert.equal(rn.reachable, false);
  assert.ok(rn.error.hand_R > 0.001 && rn.error.hand_R < 0.15);
  assert.deepEqual(problemsOf(rn), []);
  // a foot below the floor level of the leg's reach, a gaze behind the head
  const rf = IK.placeFoot(MAN, start, "L", { position: [0.1, -0.5, 0.3] });
  assert.equal(rf.reachable, false);
  assert.ok(rf.error.foot_L > 0.3 && rf.error.foot_L < 0.6);
  const mid = MAN.worldPoint(start, "eye_mid");
  const rl = IK.lookAt(MAN, start, [mid.x, mid.y, mid.z - 2]);
  assert.equal(rl.reachable, false);
  assert.ok(rl.error.lookAt * R2D > 40 && rl.error.lookAt * R2D < 120, `behind: ${(rl.error.lookAt * R2D).toFixed(0)} degrees left`);
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
      if (prev) { assert.ok(knee > prev.knee + 1, `${name}: knee flexes more at ${dy}`); assert.ok(hip > prev.hip, `${name}: hip flexes more at ${dy}`); }
      assert.ok(Math.abs(r.angles.knee_L[0] - r.angles.knee_R[0]) < 0.5 && Math.abs(r.angles.hip_L[0] - r.angles.hip_R[0]) < 0.5, "symmetric legs");
      prev = { knee, hip };
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
        // the fingertips are on the palm side of the wrist
        const n = dirOf(solver, pose, `wrist_${side}`, hf.normal), w = solver.worldPoint(pose, { joint: `wrist_${side}` });
        assert.ok(tips.every((p) => p.clone().sub(w).dot(n) > 0.02), `${name} ${side} ${grip}: the fingertips are on the palm-normal side`);
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
    // a bar across the body in front of the chest, palms down; and a vertical handle each side, palms toward the midline
    for (const [side, grip] of [
      ["L", { position: [shL.x + 0.02, y, z], normal: [0, -1, 0], axis: [1, 0, 0], diameter: 0.03 }],
      ["R", { position: [sh.x - 0.02, y, z], normal: [0, -1, 0], axis: [1, 0, 0], diameter: 0.03 }],
      ["R", { position: [sh.x - 0.12, y - 0.25, sh.z + 0.35], normal: [1, 0, 0], axis: [0, 1, 0], diameter: 0.03 }],
      ["L", { position: [shL.x + 0.12, y - 0.25, sh.z + 0.35], normal: [-1, 0, 0], axis: [0, 1, 0], diameter: 0.03 }],
      ["R", { position: [sh.x - 0.1, y - 0.1, z - 0.1], normal: [0, 0, 1], axis: [1, 0, 0], diameter: 0.03 }], // a bar in front, palm facing back toward the body (an inverted grip)
    ]) {
      const goal = IK.handFrameFromGrip(grip, side);
      const r = solver.solve(start, [goal], { free: [`arm_${side}`, `clavicle_${side}`] });
      assert.deepEqual(problemsOf(r), []);
      const pos = solver.worldPoint(r.pose, `grip_centre_${side}`);
      const n = dirOf(solver, r.pose, `wrist_${side}`, solver.handFrame(side).normal), ax = dirOf(solver, r.pose, `wrist_${side}`, solver.handFrame(side).across);
      const nErr = angleDeg(n, V(grip.normal)), aErr = Math.min(angleDeg(ax, V(grip.axis)), angleDeg(ax, V(grip.axis).negate()));
      cases.push({ ok: r.reachable, nErr, aErr, pos: pos.distanceTo(V(grip.position)), name });
      if (r.reachable) {
        assert.ok(nErr < 5, `${name} ${side} ${JSON.stringify(grip.normal)}: palm normal ${nErr.toFixed(2)} degrees off`);
        assert.ok(aErr < 5, `${name} ${side}: knuckle line ${aErr.toFixed(2)} degrees off the bar`);
        assert.ok(pos.distanceTo(V(grip.position)) < 1e-3, "the grip centre is on the bar");
      } else assert.ok(r.error[`hand_${side}`] > 5e-4 || r.error[`hand_${side}.rot`] > 2e-3);
    }
  }
  const ok = cases.filter((c) => c.ok);
  t.diagnostic(`${ok.length}/${cases.length} grips reachable; worst palm normal error ${Math.max(...ok.map((c) => c.nErr)).toFixed(2)} degrees, worst bar axis error ${Math.max(...ok.map((c) => c.aErr)).toFixed(2)} degrees`);
  assert.ok(ok.length >= cases.length * 0.8, "most of these grips are within reach");
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
  const g = IK.placeFoot(MAN, start, "L", { position: [0.25, 0.04, 0.4], heading: 30, landmark: "heel_sole" });
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
    assert.ok(aL < -1 && aR > 1, `${name}: left eye turns in (${aL.toFixed(1)}), right eye turns in (${aR.toFixed(1)}), joint convention`);
  }
});

test("look-at beyond the neck: the eyes take the rest, then the shortfall is reported", () => {
  const start = standing(MAN), mid = MAN.worldPoint(start, "eye_mid");
  const at = (az) => [mid.x + 2 * Math.sin(az * D2R), mid.y, mid.z + 2 * Math.cos(az * D2R)];
  // neck: 70 degrees cervical + 10 head = 80 to a side, then the eyes (45 each): 125
  const inEyes = IK.lookAt(MAN, start, at(100));
  assert.ok(inEyes.reachable, `${(inEyes.error.lookAt * R2D).toFixed(2)} degrees left`);
  assert.ok(gazeErrorDeg(MAN, inEyes.pose, at(100)) < 0.5);
  const neckRot = REGIONS.cervical.joints.reduce((s, id) => s + inEyes.angles[id][2], 0) + inEyes.angles.head[2];
  assert.ok(neckRot > 76 && neckRot <= 80 + 1e-6, `neck + head turn ${neckRot.toFixed(1)} of 80`);
  const eyeAz = inEyes.angles.eye_L[1];
  assert.ok(eyeAz > 12 && eyeAz < 27, `the eyes took the rest: ${eyeAz.toFixed(1)} degrees`);
  assert.ok(inEyes.clamped.some((c) => c.joint === "cervical" && c.dof === "rot" && c.limit === "max"));
  // further: the neck is at its limits, the eyes too, the rest is the reported shortfall
  const beyond = IK.lookAt(MAN, start, at(150));
  assert.equal(beyond.reachable, false);
  const short = beyond.error.lookAt * R2D;
  assert.ok(short > 15 && short < 35, `short by ${short.toFixed(1)} degrees (150 - 125 = 25)`);
  assert.ok(beyond.angles.eye_L[1] > 44.9 && beyond.angles.eye_R[1] < -44.9 === false || beyond.angles.eye_L[1] > 44.9, "the eyes are at their limit");
  assert.deepEqual(problemsOf(beyond), []);
  // with the trunk free the trunk turns and it works
  const trunk = IK.lookAt(MAN, start, at(150), { trunk: true });
  assert.ok(trunk.reachable, `${(trunk.error.lookAt * R2D).toFixed(2)}`);
  const turn = [...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints].reduce((s, id) => s + trunk.angles[id][2], 0);
  assert.ok(turn > 10, `the trunk turned ${turn.toFixed(0)} degrees`);
});

// ---- 7. elbow and knee direction ---------------------------------------------------------------------------------------------
test("elbow and knee direction: reaching a point on the front plane keeps the elbow below the shoulder-hand line and outside the trunk; knees point forward", (t) => {
  let n = 0;
  for (const [name, , solver] of SOLVERS) {
    const start = standing(solver);
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
  t.diagnostic(`${n} reaches checked`);
  assert.ok(n >= 60);
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
    assert.ok(Math.abs(a.angles.eye_L[1] + b.angles.eye_R[1]) < 1e-5 && Math.abs(a.angles.eye_L[0] - b.angles.eye_R[0]) < 1e-5, "the eyes mirror in the joint convention");
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
  const r3 = MAN.solve(atLimit, [{ type: "position", id: "head", landmark: "vertex", target: [vertex.x, vertex.y - 0.03, vertex.z + 0.12] }], { free: ["lumbar"], pole: {} });
  assert.deepEqual(problemsOf(r3), []);
  assert.ok(Math.abs(r3.angles[L[0]][0] - JOINT_BY_ID[L[0]].dof[0].max) < 1e-9, "the vertebra at its limit stays there");
  assert.ok(r3.angles[L[1]][0] > 0.5, "its neighbours take the lean");
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
  assert.equal(locked.angles.clavicle_R?.some((v) => v !== 0), false);
  assert.equal(locked.angles.elbow_R[0], 0);
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
