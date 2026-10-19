// Third-round ADVERSARIAL verification of site/js/human/ik.js (independent of ik.test.mjs and of the earlier ik.adversarial.* files).
// Own PRNG and sampler (ik.adversarial.r3.lib.mjs), the oracle for "inside every range" is skeleton.js clampAngles (boxes + the 180 degree
// swing cap), forward kinematics for the independent checks come from the rig scene graph (rig.js), never from the solver.
// Run: node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.adversarial.r3.test.mjs"
// Tests named DEFECT carry `todo`: they assert the documented behaviour, currently fail, and say why in the todo text.
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "./ik.adversarial.r3.lib.mjs";
import { mirrorPose, clampPose } from "../../site/js/human/pose.js";
import { POSTURES } from "../../site/js/human/postures.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";

const { IK, JOINTS, JOINT_BY_ID, REGIONS, THREE, ARM, LEG, rng, uni, pct, standing, limitProblems, poseStep, spline, ctx } = L;
const pops = L.popBodies().filter((b) => b.body);
const people = await L.realPeople(10);
const ALL = [...pops, ...people];
const pickFrom = (r, a) => a[Math.floor(r() * a.length)];
const PINS = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"];

test("all 176 population medians and 10 real people build a solver; every one of them solves", () => {
  assert.equal(pops.length, 176);
  assert.ok(people.length >= 8);
  for (const b of ALL) assert.ok(ctx(b).solver.landmarkIds.length > 100, b.name);
});

test("convergence: reachable-by-construction arm targets (random in-ROM arm + clavicle), standing start, 186 bodies x 40 targets: >= 99.2 %, every pose inside every range, claimed error = independent error, never 'provably unreachable'", (t) => {
  let n = 0, miss = 0, worst = 0, falsePU = 0, probs = 0, claim = 0;
  for (const [bi, b] of ALL.entries()) {
    const { solver, rig } = ctx(b), r = rng(777 + bi * 31);
    for (let k = 0; k < 40; k++) {
      const side = k % 2 ? "L" : "R";
      const tgt = solver.worldPoint({ root: { ...solver.restRoot }, angles: L.randPose(ARM(side), r) }, `grip_centre_${side}`);
      const res = IK.reachHand(solver, standing(solver), side, [tgt.x, tgt.y, tgt.z]);
      n++;
      if (limitProblems(res).length) probs++;
      if (res.provablyUnreachable) falsePU++;
      const e = res.error[`hand_${side}`];
      if (Math.abs(L.rigPoint(rig, res.pose, `grip_centre_${side}`).distanceTo(tgt) - e) > 1e-8) claim++;
      if (e > 1e-3) miss++;
      worst = Math.max(worst, e);
      assert.equal(res.reachable, e <= 5e-4, "reachable flag must equal error <= tolerance");
    }
  }
  t.diagnostic(`n ${n}, misses over 1 mm ${miss} (${(100 * (1 - miss / n)).toFixed(2)} % solved), worst ${(worst * 1000).toFixed(1)} mm`);
  assert.equal(probs, 0);
  assert.equal(falsePU, 0, "a target that is reachable by construction must never be reported as provably unreachable");
  assert.equal(claim, 0);
  assert.ok(1 - miss / n >= 0.992, `solved ${(100 * (1 - miss / n)).toFixed(2)} %`);
  assert.ok(worst < 0.15, `worst miss ${worst}`);
});

test("DEFECT (low): IK.md says no reachable-by-construction arm target is missed by more than 30 mm; 64 and 97 mm misses exist (swing near the cap, 40 restarts do not help, a start from the true pose solves it)", { todo: "documented bound of 30 mm is exceeded (2 of 7,440)" }, () => {
  const b = pops.find((p) => p.name === "united-states/aircrew/M"), { solver } = ctx(b);
  const angles = { clavicle_R: [43.66859619272873, -24.419059045612812], shoulder_R: [-21.85524020344019, 124.38401856692508, -72.01910154428333], elbow_R: [-1.6285856405738741], forearm_R: [-63.78631217870861], wrist_R: [3.9718064316548407, 4.971246565692127] };
  const tgt = solver.worldPoint({ root: { ...solver.restRoot }, angles }, "grip_centre_R");
  const fromTruth = IK.reachHand(solver, { root: { ...solver.restRoot }, angles }, "R", tgt.toArray());
  assert.ok(fromTruth.error.hand_R < 1e-3, "a start at the truth must solve");
  const res = IK.reachHand(solver, standing(solver), "R", tgt.toArray(), { restarts: 40 });
  assert.ok(res.error.hand_R < 0.03, `${(res.error.hand_R * 1000).toFixed(0)} mm short from standing with 40 restarts`);
});

test("hard limits: 2,500 solves with every goal type, random free sets/options, wild starts, absurd targets: no exception, ranges + 180 degree cap (clampAngles oracle), no NaN, inputs unmutated", (t) => {
  const r = rng(424242), pick = (a) => pickFrom(r, a);
  const bodies = ALL.filter((b, i) => i % 9 === 0);
  const GR = ["arm_L", "arm_R", "arms", "clavicle_L", "clavicle_R", "clavicles", "hand_L", "hand_R", "hands", "leg_L", "leg_R", "legs", "toes_L", "toes_R", "trunk", "lumbar", "thoracic", "cervical", "spine", "neck", "head", "eye_L", "eye_R", "eyes", "jaw", "pelvis-y", "pelvis-xz", "pelvis-xyz", "pelvis-heading", "pelvis-tilt", "pelvis-rot", "all", "auto", "L3", "T7", "C4", "shoulder_R.rot", "lumbar.flex", "elbow_L", "knee_R.flex"];
  const target = (solver) => {
    const k = r();
    if (k < 0.3) return [uni(r, -1.2, 1.2), uni(r, -0.2, 2.4), uni(r, -1.2, 1.2)];
    if (k < 0.45) return [uni(r, -1e4, 1e4), uni(r, -1e4, 1e4), uni(r, -1e4, 1e4)];
    if (k < 0.6) return [0, 1.4, 0];
    if (k < 0.75) return [0.2, 1.4, 0.0001];
    if (k < 0.85) return [1e7, -1e7, 1e7];
    const p = solver.worldPoint(standing(solver), pick(solver.landmarkIds));
    return [p.x + uni(r, -1e-4, 1e-4), p.y + uni(r, -1e-4, 1e-4), p.z + uni(r, -1e-4, 1e-4)];
  };
  const goal = (solver) => {
    const type = pick(["position", "position", "pin", "height", "direction", "aim", "lookAt", "frame", "frame"]), lm = pick(solver.landmarkIds), g = { type };
    if (r() < 0.2) g.weight = pick([0, 1e-9, 1, 100, 1e12]);
    if (r() < 0.1) g.tolerance = pick([1e-9, 1e-3, 0.1, 1]);
    if (r() < 0.1) g.angTolerance = pick([1e-9, 1e-3, 0.1, 1]);
    const dir = () => [uni(r, -1, 1) || 1, uni(r, -1, 1), uni(r, -1, 1)];
    switch (type) {
      case "position": g.landmark = lm; g.target = target(solver); break;
      case "pin": g.landmark = lm; if (r() < 0.5) g.target = target(solver); break;
      case "height": g.landmark = lm; g.height = uni(r, -1, 3); if (r() < 0.5) g.direction = dir(); break;
      case "direction": g.joint = pick(JOINTS).id; g.axis = pick([[0, 0, 1], [1, 0, 0], dir()]); g.target = pick([[0, 1, 0], dir(), [0, 0, 1e-3]]); g.line = r() < 0.4; break;
      case "aim": g.landmark = lm; g.target = target(solver); g.axis = pick([[0, 0, 1], [0, 1, 0], [1, 1, 1]]); break;
      case "lookAt": g.target = target(solver); g.eyes = r() < 0.5; break;
      case "frame":
        g.joint = pick(["wrist_L", "wrist_R", "head", "ankle_L", "pelvis", "T4", "L3", "shoulder_R", "mtp_L"]);
        if (r() < 0.5) g.axes = [{ local: dir(), world: dir(), line: r() < 0.3 }, { local: [0, 1, 0], world: [0, 1, 0] }]; else g.quaternion = [uni(r, -1, 1), uni(r, -1, 1), uni(r, -1, 1), uni(r, -1, 1)];
        if (r() < 0.4) { g.landmark = lm; g.target = target(solver); }
    }
    return g;
  };
  let solved = 0, unreachable = 0;
  for (let i = 0; i < 2500; i++) {
    const solver = ctx(pick(bodies)).solver, angles = {};
    if (r() > 0.3) for (const j of JOINTS) if (j.parent && r() < 0.3) angles[j.id] = L.randAngles(j.id, r, pick([0.2, 1]));
    const root = { ...solver.restRoot };
    if (r() < 0.4) Object.assign(root, { x: uni(r, -2, 2), z: uni(r, -2, 2), heading: uni(r, -180, 180), flex: uni(r, -90, 90), lat: uni(r, -60, 60), rot: uni(r, -60, 60) });
    const start = { root, angles }, goals = Array.from({ length: 1 + Math.floor(r() * 4) }, () => goal(solver)), o = {};
    if (r() < 0.8) o.free = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(GR));
    if (r() < 0.15) o.lock = [pick(GR)];
    if (r() < 0.2) o.maxIterations = pick([0, 1, 5, 60, 200]);
    if (r() < 0.1) o.tolerance = pick([1e-9, 1e-7, 1e-3, 1, 1e6]);
    if (r() < 0.1) o.damping = pick([1e-12, 1e-6, 1, 1e9]);
    if (r() < 0.1) o.stepMax = pick([1e-9, 1e-3, 10, 1e9]);
    if (r() < 0.1) o.angleScale = pick([1e-9, 1e-3, 10, 1e9]);
    if (r() < 0.1) o.rootRange = pick([0, 1e-9, 100, 1e300]);
    if (r() < 0.25) o.restarts = pick([0, 1, 3, 10]);
    if (r() < 0.2) o.seed = pick([0, -5, 2 ** 31, 2 ** 40, 1e15]);
    if (r() < 0.2) o.follow = r() < 0.5;
    if (r() < 0.15) o.maxMove = pick([1e-300, 1e-9, 0.04, 1, 1e300, Infinity]);
    if (r() < 0.1) o.analyticStart = r() < 0.5;
    if (r() < 0.1) o.limitStiffness = pick([0, 1e-3, 1, 1e6]);
    if (r() < 0.1) o.poleWeight = pick([0, 1e-6, 1, 1e6]);
    if (r() < 0.1) o.pole = { elbow_R: pick([[1, 0, 0], [0, 0, 0.0001], [0, -1, 0], false]) };
    if (r() < 0.1) o.stiffness = { pelvis: 0, elbow_R: 1e-12, clavicle: 1e6 };
    if (r() < 0.1) o.reference = { root: {}, angles: { elbow_R: [90], head: [10, 10, 10] } };
    if (r() < 0.1) o.referenceWeight = pick([0, 4, 1e6]);
    const before = JSON.stringify([start, goals, o]);
    let res;
    try { res = solver.solve(start, goals, o); } catch (e) { assert.fail(`threw on valid input ${before.slice(0, 700)}: ${e.message}`); }
    assert.equal(JSON.stringify([start, goals, o]), before, "inputs were mutated");
    const p = limitProblems(res);
    assert.deepEqual(p, [], `solve #${i}: ${before.slice(0, 500)}`);
    if (res.reachable) solved++; else unreachable++;
  }
  t.diagnostic(`${solved} reachable, ${unreachable} not (reported as such)`);
});

test("frozen/shared inputs: deeply frozen start, goals and options (DRAG_OPTIONS too) work; results are fresh objects; same input gives the same bits regardless of earlier calls, other solvers and warmUp", () => {
  const b1 = pops.find((p) => p.name === "united-states/army/M"), b2 = pops.find((p) => p.name === "japan/air-force/F");
  const s1 = ctx(b1).solver, s2 = ctx(b2).solver;
  const sh = [-0.3, 1.35, 0.5], mk = () => ({ start: { root: { ...s1.restRoot }, angles: { elbow_R: [30], shoulder_R: [10, 20, 5], L3: [3, 0, 0] } }, goals: [{ type: "position", id: "hand", landmark: "grip_centre_R", target: sh }, { type: "lookAt", target: [0, 1.6, 2] }], opt: { free: ["arm_R", "clavicle_R", "neck", "eyes", "trunk"], reference: { angles: { elbow_R: [40] } } } });
  const a = mk(), strip = (r) => JSON.stringify({ ...r, ms: 0 });
  const ref = strip(s1.solve(a.start, a.goals, a.opt));
  // interleave other work
  s2.solve({ root: { ...s2.restRoot }, angles: {} }, [{ type: "position", landmark: "grip_centre_L", target: [0.3, 1.2, 0.4] }]);
  IK.warmUp(s2); IK.warmUp(s1, 1);
  s1.reachEnvelope(standing(s1), "L", { samples: 50 });
  const f = mk(); L.deepFreeze(f); L.deepFreeze(IK.DRAG_OPTIONS);
  const res = s1.solve(f.start, f.goals, f.opt);
  assert.equal(strip(res), ref, "same input, different bits");
  const res2 = s1.solve(f.start, f.goals, { ...IK.DRAG_OPTIONS, ...f.opt });
  assert.ok(Array.isArray(res2.angles.elbow_R));
  // fresh objects
  assert.notEqual(res.angles.elbow_R, f.start.angles.elbow_R);
  res.angles.elbow_R[0] = 1234; res.root.x = 99; res.error.hand = 99;
  const again = s1.solve(f.start, f.goals, f.opt);
  assert.equal(strip(again), ref, "mutating a result changed later solves");
  assert.equal(JSON.stringify(f), JSON.stringify(mk()), "frozen input differs");
});

test("rig and solver agree: rig.setPose(result.pose) clamps nothing, landmark positions equal the solver's to 1e-9, the claimed errors equal the rig's (400 solves: tilted roots, posed starts, 5 goal types)", () => {
  const r = rng(4711), pick = (a) => pickFrom(r, a);
  let clamped = 0, worstPos = 0, worstErr = 0;
  for (let it = 0; it < 400; it++) {
    const b = pick(ALL), { solver, rig } = ctx(b), angles = {};
    for (const j of JOINTS) if (j.parent && r() < 0.2 && !/^(index|middle|ring|little|thumb)/.test(j.id)) angles[j.id] = L.randAngles(j.id, r, 0.6);
    const root = { ...solver.restRoot, x: uni(r, -1, 1), z: uni(r, -1, 1), heading: uni(r, -180, 180), flex: uni(r, -40, 40), lat: uni(r, -30, 30), rot: uni(r, -30, 30) };
    const T = [uni(r, -1, 1), uni(r, 0.2, 2.2), uni(r, -0.6, 1)], type = pick(["position", "height", "lookAt", "direction"]), lm = pick(solver.landmarkIds.filter((id) => !/^ball_centre/.test(id)));
    const g = type === "position" ? { type, id: "g", landmark: lm, target: T } : type === "height" ? { type, id: "g", landmark: lm, height: uni(r, 0.2, 2) } : type === "lookAt" ? { type, id: "g", target: T } : { type, id: "g", joint: "wrist_R", axis: "finger_axis", target: [uni(r, -1, 1), uni(r, -1, 1), uni(r, -1, 1)] };
    const free = pick([["arms", "clavicles", "trunk", "neck", "eyes"], ["all", "pelvis-xyz"], ["auto"], ["legs", "pelvis-y"], ["all", "pelvis-rot"]]);
    const res = solver.solve({ root, angles }, [g], { free, restarts: 2 });
    if (rig.setPose(res.pose).clamped.length || clampPose(res.pose).clamped.length) clamped++;
    const P = (id) => rig.landmarkWorld(id, new THREE.Vector3());
    let err;
    if (type === "position") err = P(lm).distanceTo(new THREE.Vector3(...T));
    else if (type === "height") err = Math.abs(P(lm).y - g.height);
    else if (type === "lookAt") { err = 0; for (const s of ["L", "R"]) err = Math.max(err, new THREE.Vector3(0, 0, 1).applyQuaternion(rig.bones.get(`eye_${s}`).getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(...T).sub(P(`pupil_${s}`)))); }
    else err = new THREE.Vector3(...solver.handFrame("R").finger).applyQuaternion(rig.bones.get("wrist_R").getWorldQuaternion(new THREE.Quaternion())).angleTo(new THREE.Vector3(...g.target));
    worstErr = Math.max(worstErr, Math.abs(err - res.error.g));
    for (const id of ["grip_centre_R", "heel_sole_L", "eye_mid", "ASIS_L", "cervicale"]) worstPos = Math.max(worstPos, solver.worldPoint(res.pose, id).distanceTo(P(id)));
  }
  assert.equal(clamped, 0);
  assert.ok(worstPos < 1e-9, `landmark disagreement ${worstPos}`);
  assert.ok(worstErr < 1e-7, `claimed error disagreement ${worstErr}`);
});

test("hand-frame goals against an independent palm normal / knuckle line built from joint centres of the rig: claimed error = independent error, >= 97 % of reachable-by-construction grips solved", () => {
  const axes = (rig, pose, side) => {
    rig.setPose(pose, { clamp: false });
    const p = (id) => rig.jointWorld(id, new THREE.Vector3());
    const w = p(`wrist_${side}`), i = p(`index_mcp_${side}`), l = p(`little_mcp_${side}`), m = p(`middle_mcp_${side}`);
    const across = i.clone().sub(l).normalize();
    return { across, n: new THREE.Vector3().crossVectors(m.clone().sub(w), across).normalize() };
  };
  let tot = 0, miss = 0, claimBad = 0;
  for (let bi = 0; bi < ALL.length; bi += 4) {
    const b = ALL[bi], { solver, rig } = ctx(b), r = rng(4242 + bi);
    for (let k = 0; k < 20; k++) {
      const side = k % 2 ? "L" : "R", tpose = { root: { ...solver.restRoot }, angles: L.randPose(ARM(side), r, 0.85) };
      const ax = axes(rig, tpose, side), sgn = Math.sign(axes(rig, standing(solver), side).n.dot(new THREE.Vector3(...solver.handFrame(side).normal))) || 1;
      const grip = { position: solver.worldPoint(tpose, `grip_centre_${side}`).toArray(), normal: ax.n.clone().multiplyScalar(sgn).toArray(), axis: (r() < 0.5 ? ax.across.clone() : ax.across.clone().negate()).toArray(), diameter: 0.03 };
      const res = solver.solve(standing(solver), [IK.handFrameFromGrip(grip, side)], { free: [`arm_${side}`, `clavicle_${side}`] });
      tot++;
      const got = axes(rig, res.pose, side);
      const nErr = got.n.clone().multiplyScalar(sgn).angleTo(new THREE.Vector3(...grip.normal)), aErr = Math.acos(Math.min(1, Math.abs(got.across.dot(new THREE.Vector3(...grip.axis)))));
      if (Math.abs(Math.max(nErr, aErr) - res.error[`hand_${side}.rot`]) > 3e-4 + 1e-3 * nErr) claimBad++;
      if (Math.abs(L.rigPoint(rig, res.pose, `grip_centre_${side}`).distanceTo(new THREE.Vector3(...grip.position)) - res.error[`hand_${side}`]) > 1e-7) claimBad++;
      if (!res.reachable) miss++;
    }
  }
  assert.equal(claimBad, 0);
  assert.ok(1 - miss / tot >= 0.97, `solved ${(100 * (1 - miss / tot)).toFixed(1)} % of ${tot}`);
});

test("look-at against an independent gaze (rig eye bones through the pupils / head axis from eye_mid): 186 bodies x 24 directions up to 85 degrees off axis, both modes: error < 0.5 degree, claimed = measured", () => {
  let n = 0, miss = 0, worstClaim = 0;
  for (const [bi, b] of ALL.entries()) {
    const { solver, rig } = ctx(b), r = rng(606 + bi), eye = solver.worldPoint(standing(solver), "eye_mid");
    for (let k = 0; k < 24; k++) {
      const a = uni(r, 0, 85) * Math.PI / 180, az = uni(r, 0, 2 * Math.PI), d = Math.exp(uni(r, Math.log(0.4), Math.log(20)));
      const T = [eye.x + d * Math.sin(a) * Math.cos(az), eye.y + d * Math.sin(a) * Math.sin(az), eye.z + d * Math.cos(a)];
      for (const eyes of [true, false]) {
        const res = IK.lookAt(solver, standing(solver), T, { eyes });
        rig.setPose(res.pose, { clamp: false });
        const q = (id) => rig.bones.get(id).getWorldQuaternion(new THREE.Quaternion()), fwd = new THREE.Vector3(0, 0, 1);
        let e = 0;
        if (eyes) for (const s of ["L", "R"]) e = Math.max(e, fwd.clone().applyQuaternion(q(`eye_${s}`)).angleTo(new THREE.Vector3(...T).sub(rig.landmarkWorld(`pupil_${s}`, new THREE.Vector3()))));
        else e = fwd.clone().applyQuaternion(q("head")).angleTo(new THREE.Vector3(...T).sub(rig.landmarkWorld("eye_mid", new THREE.Vector3())));
        worstClaim = Math.max(worstClaim, Math.abs(e - res.error.lookAt));
        n++;
        if (res.error.lookAt > 0.5 * Math.PI / 180) miss++;
      }
    }
  }
  assert.equal(miss, 0, `${miss} of ${n} gaze goals missed`);
  assert.ok(worstClaim < 1e-7, `claimed vs independent ${worstClaim}`);
});

test("mirror symmetry and rotation equivariance: mirrored goals + mirrored start give the mirrored pose (drag, foot, gaze exactly; hand >= 99 %); a pose turned by any heading about the pelvis is the same pose", () => {
  const stat = { hand: [0, 0], drag: [0, 0], foot: [0, 0], look: [0, 0], turn: [0, 0] };
  for (let bi = 0; bi < ALL.length; bi += 3) {
    const b = ALL[bi], { solver } = ctx(b), r = rng(31337 + bi);
    for (let k = 0; k < 12; k++) {
      const angles = {};
      for (const j of JOINTS) if (j.parent && r() < 0.25 && !/^(index|middle|ring|little|thumb)/.test(j.id)) angles[j.id] = L.randAngles(j.id, r, 0.4);
      const root = { ...solver.restRoot, x: uni(r, -.5, .5), z: uni(r, -.5, .5), heading: uni(r, -60, 60), lat: uni(r, -10, 10), rot: uni(r, -10, 10), flex: uni(r, -10, 10) };
      const start = { root, angles }, ms = mirrorPose(start);
      ms.root.y = root.y; ms.root.z = root.z;
      const T = solver.worldPoint({ root: { ...solver.restRoot }, angles: L.randPose(ARM("R"), r, 0.8) }, "grip_centre_R").toArray(), mT = [-T[0], T[1], T[2]];
      for (const [name, run] of [
        ["hand", (s, side, t) => IK.reachHand(solver, s, side, t)], ["drag", (s, side, t) => IK.reachHand(solver, s, side, t, IK.DRAG_OPTIONS)],
        ["foot", (s, side, t) => IK.placeFoot(solver, s, side, { position: [t[0], Math.max(0, t[1] - 1), t[2] * 0.5], flat: false })], ["look", (s, side, t) => IK.lookAt(solver, s, [t[0], t[1] + 0.2, t[2] + 0.5], { trunk: true })],
      ]) {
        const a = run(start, "R", T), m = run(ms, "L", mT), mr = mirrorPose(a.pose);
        const rootDiff = Math.max(...["x", "y", "z", "heading", "flex", "lat", "rot"].map((q) => Math.abs((mr.root[q] ?? 0) - m.root[q])));
        stat[name][0]++;
        if (poseStep(mr, m.pose).deg > 1 || Math.abs(Object.values(a.error)[0] - Object.values(m.error)[0]) > 1e-6 || rootDiff > 1e-6) stat[name][1]++;
      }
      const side = k % 2 ? "L" : "R", h = uni(r, -180, 180), c = Math.cos(h * Math.PI / 180), s = Math.sin(h * Math.PI / 180);
      const A = solver.worldPoint({ root: { ...solver.restRoot }, angles: L.randPose(ARM(side), r, 0.9) }, `grip_centre_${side}`);
      const pa = { root: { ...solver.restRoot }, angles: L.randPose(ARM(side), r, 0.4) };
      const x1 = IK.reachHand(solver, pa, side, A.toArray(), { trunk: true }), x2 = IK.reachHand(solver, { root: { ...solver.restRoot, heading: h }, angles: pa.angles }, side, [A.x * c + A.z * s, A.y, -A.x * s + A.z * c], { trunk: true });
      stat.turn[0]++;
      if (poseStep(x1.pose, x2.pose).deg > 1 || Math.abs(x1.error[`hand_${side}`] - x2.error[`hand_${side}`]) > 1e-6) stat.turn[1]++;
    }
  }
  assert.equal(stat.drag[1], 0, JSON.stringify(stat));
  assert.equal(stat.foot[1], 0, JSON.stringify(stat));
  assert.equal(stat.look[1], 0, JSON.stringify(stat));
  assert.equal(stat.turn[1], 0, JSON.stringify(stat));
  assert.ok(stat.hand[1] / stat.hand[0] < 0.01, JSON.stringify(stat));
});

test("poles: an elbow never ends inside the trunk capsule for a hand target outside it, never on the far side of the midline of a same-side target; a knee bends forward (placeFoot to 2,400 random foot targets)", () => {
  let n = 0, inTorso = 0, crossed = 0, nk = 0, kneeBack = 0;
  const segDist = (p, a, b) => { const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())); return p.distanceTo(a.clone().addScaledVector(ab, t)); };
  for (let bi = 0; bi < ALL.length; bi += 2) {
    const b = ALL[bi], { solver } = ctx(b), r = rng(66 + bi), base = standing(solver);
    for (let k = 0; k < 30; k++) {
      const side = k % 2 ? "L" : "R", sx = side === "L" ? 1 : -1;
      const res = IK.reachHand(solver, base, side, [sx * uni(r, 0, 0.7), uni(r, 0.7, 1.9), uni(r, 0, 0.8)]);
      if (!res.reachable) continue;
      n++;
      const W = (j) => solver.worldPoint(res.pose, { joint: j }), el = W(`elbow_${side}`), hd = solver.worldPoint(res.pose, `grip_centre_${side}`);
      const hip = W("hip_L").add(W("hip_R")).multiplyScalar(0.5), c7 = W("C7");
      if (segDist(el, hip, c7) < 0.08 && segDist(hd, hip, c7) > 0.3) inTorso++;
      if (Math.sign(el.x - hip.x) !== sx && Math.abs(el.x - hip.x) > 0.05 && Math.sign(hd.x - hip.x) === sx) crossed++;
    }
    for (let k = 0; k < 30; k++) {
      const side = k % 2 ? "L" : "R", b0 = solver.worldPoint(base, `ball_centre_${side}`);
      const res = IK.placeFoot(solver, base, side, { position: [b0.x + uni(r, -0.3, 0.3), uni(r, 0, 0.6), b0.z + uni(r, -0.5, 0.7)], flat: false });
      if (!res.reachable) continue;
      nk++;
      const W = (j) => solver.worldPoint(res.pose, { joint: j }), hip = W(`hip_${side}`), kn = W(`knee_${side}`), chord = W(`ankle_${side}`).sub(hip), tt = kn.clone().sub(hip).dot(chord) / chord.lengthSq();
      const perp = kn.clone().sub(hip).addScaledVector(chord, -tt);
      if (perp.length() > 0.01 && perp.z < -0.005) kneeBack++;
    }
  }
  assert.equal(inTorso, 0); assert.equal(crossed, 0); assert.equal(kneeBack, 0);
  assert.ok(n > 1000 && nk > 1500);
});

test("options are honoured exactly: maxMove bounds every DOF / region total / root variable per call, rootRange bounds the pelvis, lock keeps a DOF bit-for-bit, a root that is not free does not move, a joint that is not free does not move, `changed` is exact (600 solves)", () => {
  const r = rng(99), pick = (a) => pickFrom(r, a), bodies = ALL.filter((b, i) => i % 6 === 0);
  const bad = [];
  for (let it = 0; it < 600; it++) {
    const b = pick(bodies), { solver } = ctx(b), root = { ...solver.restRoot, heading: uni(r, -180, 180), x: uni(r, -1, 1), z: uni(r, -1, 1) }, angles = {};
    for (const j of JOINTS) if (j.parent && r() < 0.2) angles[j.id] = L.randAngles(j.id, r, 0.5);
    const start = { root, angles }, side = pick(["L", "R"]);
    const goals = [{ type: "position", id: "h", landmark: `grip_centre_${side}`, target: [uni(r, -1, 1), uni(r, 0.3, 2.2), uni(r, -0.8, 1.2)] }];
    if (r() < 0.4) goals.push({ type: "lookAt", id: "look", target: [uni(r, -2, 2), uni(r, 0, 2.5), uni(r, -1, 3)] });
    if (r() < 0.3) goals.push(...IK.pinGoals(solver, start, ["heel_sole_L", "heel_sole_R"]));
    const free = [`arm_${side}`, `clavicle_${side}`, ...(r() < 0.6 ? ["trunk"] : []), ...(r() < 0.4 ? ["neck", "eyes"] : []), ...(r() < 0.4 ? [pick(["pelvis-xz", "pelvis-xyz", "pelvis-tilt", "pelvis-rot", "pelvis-y"])] : []), ...(r() < 0.3 ? ["legs"] : [])];
    const lock = r() < 0.4 ? [pick([`wrist_${side}.dev`, `elbow_${side}`, "lumbar.rot", "thoracic.flex", "L3", "T5.rot", `clavicle_${side}.prot`, `shoulder_${side}.rot`])] : undefined, o = { free, ...(lock ? { lock } : {}) };
    if (r() < 0.5) o.maxMove = pick([0.01, 0.04, 0.2]);
    if (r() < 0.3) o.rootRange = pick([0, 0.05, 0.3]);
    if (r() < 0.3) o.follow = true;
    const res = solver.solve(start, goals, o), mm = o.maxMove ?? Infinity, sums = {};
    for (const [id, a] of Object.entries(res.angles)) {
      const a0 = start.angles[id] ?? a.map(() => 0), reg = Object.keys(REGIONS).find((g) => REGIONS[g].joints.includes(id));
      a.forEach((v, k) => {
        const d = (v - (a0[k] ?? 0)) * Math.PI / 180;
        if (reg) sums[reg + k] = (sums[reg + k] ?? 0) + d; else if (Math.abs(d) > mm + 1e-6) bad.push(["maxMove", id, k, d]);
      });
    }
    for (const [k, v] of Object.entries(sums)) if (Math.abs(v) > mm + 1e-6) bad.push(["maxMove region", k, v]);
    if (mm < Infinity) {
      for (const k of ["x", "y", "z"]) if (Math.abs(res.root[k] - root[k]) > mm * 0.5 + 1e-9) bad.push(["maxMove root", k]);
      for (const k of ["heading", "flex", "lat", "rot"]) if (Math.abs(res.root[k] - root[k]) * Math.PI / 180 > mm + 1e-6) bad.push(["maxMove root rot", k]);
    }
    for (const k of ["x", "y", "z"]) if (Math.abs(res.root[k] - root[k]) > (o.rootRange ?? 1.5) + 1e-9) bad.push(["rootRange", k]);
    if (!free.some((nm) => nm.startsWith("pelvis"))) for (const k of Object.keys(root)) if (res.root[k] !== root[k]) bad.push(["root moved", k]);
    for (const nm of lock ?? []) {
      const [id, dof] = nm.split("."), ids = REGIONS[id]?.joints ?? [id];
      for (const jid of ids) JOINT_BY_ID[jid]?.dof.forEach((d, k) => { if (dof && d.key !== dof) return; if ((start.angles[jid]?.[k] ?? 0) !== (res.angles[jid]?.[k] ?? 0)) bad.push(["lock", nm, jid, d.key]); });
    }
    const other = side === "L" ? "R" : "L";
    for (const jid of Object.keys(res.angles)) {
      if (!(jid.endsWith(`_${other}`) || jid === "head" || jid === "jaw")) continue;
      if ((jid === "head" && free.includes("neck")) || (jid.startsWith("eye_") && free.includes("eyes")) || (/^(hip|knee|ankle)_/.test(jid) && free.includes("legs"))) continue;
      JOINT_BY_ID[jid].dof.forEach((d, k) => { if ((start.angles[jid]?.[k] ?? 0) !== res.angles[jid][k]) bad.push(["not free but moved", jid, d.key]); });
    }
    const changed = new Set();
    for (const [id, a] of Object.entries(res.angles)) { const a0 = start.angles[id] ?? a.map(() => 0); if (a.some((v, k) => Math.abs(v - (a0[k] ?? 0)) > 1e-9)) changed.add(id); }
    if (changed.size !== res.changed.length || res.changed.some((id) => !changed.has(id))) bad.push(["changed", [...changed].join(), res.changed.join()]);
    for (const c of res.clamped) if (!c.region && !c.cap) { const v = res.angles[c.joint][JOINT_BY_ID[c.joint].dof.findIndex((d) => d.key === c.dof)]; if (Math.abs(v - c.bound) > 1e-6) bad.push(["clamped lies", c.joint, c.dof]); }
    assert.deepEqual(limitProblems(res), []);
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("drag with DRAG_OPTIONS: 200-point smooth paths (random splines, through the shoulder, the zenith, the body, around the head, out of reach and back): no joint turns more than 6 degrees and no elbow moves more than 70 mm between frames; hand, foot and gaze drags too; limits hold", () => {
  const bodies = pops.filter((b) => /united-states\/army\/M|japan\/air-force\/F|germany\/recruits-trainees\/M|france\/navy\/both|brazil\/army\/F|brazil\/air-force\/M/.test(b.name));
  let paths = 0, maxJoint = 0, maxElbow = 0, maxFoot = 0, maxGaze = 0;
  for (const [bi, b] of bodies.entries()) {
    const { solver } = ctx(b), r = rng(5000 + bi);
    IK.warmUp(solver);
    for (const side of ["R", "L"]) {
      const sx = side === "R" ? -1 : 1, sh = solver.worldPoint(standing(solver), { joint: `shoulder_${side}` });
      const families = [
        ...Array.from({ length: 8 }, () => Array.from({ length: 3 + Math.floor(r() * 4) }, () => [sx * uni(r, -0.4, 0.8), uni(r, 0.35, 2.05), uni(r, -0.25, 0.85)])),
        [[sh.x + sx * 0.3, sh.y + 0.55, sh.z], [sh.x, sh.y + 0.55, sh.z], [sh.x - sx * 0.3, sh.y + 0.55, sh.z]], [[sh.x + sx * 0.4, sh.y, sh.z + 0.2], [sh.x, sh.y, sh.z], [sh.x - sx * 0.4, sh.y, sh.z - 0.2]],
        [[sh.x + sx * 0.3, sh.y - 0.2, sh.z + 0.3], [0, sh.y - 0.2, 0.1], [-sx * 0.3, sh.y - 0.2, 0.3]], [[sh.x + sx * 0.3, sh.y, sh.z + 0.3], [sh.x + sx * 0.5, sh.y + 0.2, sh.z + 1.3], [sh.x + sx * 0.3, sh.y, sh.z + 0.3]],
      ];
      for (const ctrl of families) {
        const { pts } = spline(ctrl, 200);
        let cur = IK.reachHand(solver, standing(solver), side, pts[0]).pose, prev = cur, prevEl = solver.worldPoint(cur, { joint: `elbow_${side}` }).clone();
        for (let i = 1; i < pts.length; i++) {
          const rr = IK.reachHand(solver, cur, side, pts[i], IK.DRAG_OPTIONS);
          assert.deepEqual(limitProblems(rr), []);
          maxJoint = Math.max(maxJoint, poseStep(prev, rr.pose).deg);
          const el = solver.worldPoint(rr.pose, { joint: `elbow_${side}` }); maxElbow = Math.max(maxElbow, el.distanceTo(prevEl)); prevEl = el.clone();
          prev = cur = rr.pose;
        }
        paths++;
      }
      const eye = solver.worldPoint(standing(solver), "eye_mid"), b0 = solver.worldPoint(standing(solver), `ball_centre_${side}`);
      for (let p = 0; p < 4; p++) {
        const gz = spline(Array.from({ length: 4 }, () => { const d = r() < 0.3 ? uni(r, 0.02, 0.3) : uni(r, 0.5, 4), a = uni(r, 0, 2 * Math.PI), e = uni(r, -1, 1), q = Math.sqrt(1 - e * e); return [eye.x + d * Math.cos(a) * q, eye.y + d * e, eye.z + d * Math.sin(a) * q]; }), 200).pts;
        const ft = spline(Array.from({ length: 4 }, () => [b0.x + uni(r, -0.5, 0.5), uni(r, 0, 0.7), b0.z + uni(r, -0.5, 0.8)]), 200).pts;
        let cg = standing(solver), cf = standing(solver);
        for (let i = 0; i < 200; i++) {
          const g = IK.lookAt(solver, cg, gz[i], { ...IK.DRAG_OPTIONS, trunk: p % 2 === 1 }), f = IK.placeFoot(solver, cf, side, { position: ft[i], flat: p % 2 === 0 }, { ...IK.DRAG_OPTIONS, ...(p === 3 ? { free: [`leg_${side}`, "pelvis-xyz", "pelvis-tilt"] } : {}) });
          assert.deepEqual(limitProblems(g), []); assert.deepEqual(limitProblems(f), []);
          if (i) { maxGaze = Math.max(maxGaze, poseStep(cg, g.pose).deg); maxFoot = Math.max(maxFoot, poseStep(cf, f.pose).deg); }
          cg = g.pose; cf = f.pose;
        }
      }
    }
  }
  assert.ok(paths >= 100);
  assert.ok(maxJoint < 6, `hand drag: joint turned ${maxJoint.toFixed(1)} degrees in a frame`);
  assert.ok(maxElbow < 0.07, `elbow moved ${(maxElbow * 1000).toFixed(0)} mm in a frame`);
  assert.ok(maxGaze < 6 && maxFoot < 6, `gaze ${maxGaze.toFixed(1)}, foot ${maxFoot.toFixed(1)} degrees`);
});

test("DEFECT (medium): a small goal move with the DEFAULT options (also `follow: true` without maxMove) jumps the pose: 1 cm hand moves from library postures turn a joint more than 10 degrees in 45 % of cases (more than 40 degrees in 9 %), from a solved pose 26 %; IK.md section 2 promises a continuous follow within 5 cm", { todo: "ik.js lm(): `regionBinds` widens the trust region x4 (to infinity) before relaxing mu; relaxing first keeps every jump below 16 degrees" }, () => {
  const b = pops.find((p) => p.name === "united-states/army/M"), { solver } = ctx(b), r = rng(3);
  let n = 0, over10 = 0, over40 = 0;
  for (const p of POSTURES) {
    let ex; try { ex = expandPosture(p); } catch { continue; }
    let root; try { root = placePose(b.body, ex, { posture: p }); } catch { root = { x: 0, y: solver.restRoot.y, z: 0, ...ex.root }; }
    const start = { root: { x: root.x, y: root.y, z: root.z, heading: root.heading, flex: root.flex, lat: root.lat, rot: root.rot }, angles: JSON.parse(JSON.stringify(ex.angles)) };
    for (const side of ["R", "L"]) {
      const A = solver.worldPoint(start, `grip_centre_${side}`), B = A.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(0.01));
      const res = IK.reachHand(solver, start, side, B.toArray());
      if (!res.reachable) continue;
      const st = poseStep(start, res.pose).deg;
      n++; if (st > 10) over10++; if (st > 40) over40++;
    }
  }
  assert.ok(over10 / n < 0.05 && over40 === 0, `${n} one-centimetre moves, ${over10} turn a joint > 10 degrees, ${over40} > 40`);
});

test("DEFECT (medium): holding the handle still on a goal beyond the reach (or in a corner) with DRAG_OPTIONS never settles: the pose keeps changing 2.3 degrees a frame, often in an exact two-frame cycle, and `limited: true` is reported in the cycle (the editor's rescue only fires when `limited` is false)", { todo: "56 % of 900 beyond-reach goals still move > 0.1 degree per frame at frame 150 (50 % at frame 500, 15 % of them in an exact 2-cycle); with limitStiffness: 0 it is 1.3 %: the limit-avoidance term of follow mode is the cause; 8 % of reachable far goals are never reached in 300 frames and half of those report limited" }, () => {
  const bodies = pops.filter((b, i) => i % 6 === 0);
  let tot = 0, moving = 0, limitedStuck = 0;
  for (const [bi, b] of bodies.entries()) {
    const { solver } = ctx(b), r = rng(2024 + bi * 6);
    for (let k = 0; k < 10; k++) {
      const side = k % 2 ? "L" : "R", dir = new THREE.Vector3(uni(r, -1, 1), uni(r, -0.6, 1), uni(r, -0.5, 1)).normalize();
      const T = solver.worldPoint(standing(solver), { joint: `shoulder_${side}` }).addScaledVector(dir, 0.65 * uni(r, 1.05, 1.8));
      let cur = standing(solver), last, prev;
      for (let i = 0; i < 150; i++) { prev = cur; last = IK.reachHand(solver, cur, side, T.toArray(), IK.DRAG_OPTIONS); cur = last.pose; }
      tot++;
      if (poseStep(prev, cur).deg > 0.1) { moving++; if (last.limited) limitedStuck++; }
    }
  }
  assert.ok(moving / tot < 0.05, `${moving} of ${tot} still moving after 150 frames on a fixed goal (${limitedStuck} of them report limited)`);
});

test("DEFECT (medium): options.stiffness rejects the documented \"joint.dof\" keys of a sided joint or a vertebra (\"shoulder_R.flex\", \"knee_L.flex\", \"L3.flex\") as unknown", { todo: "ik.js compile(): key check regex /^[a-z_]+\\.[a-z0-9_]+$/ has no upper case, while costFor() looks `${IDS[i]}.${dof}` up" }, () => {
  const { solver } = ctx(pops.find((p) => p.name === "united-states/army/M"));
  for (const key of ["shoulder_R.flex", "knee_L.flex", "L3.flex", "eye_L.azim"]) {
    assert.doesNotThrow(() => solver.solve(standing(solver), [{ type: "position", landmark: "grip_centre_R", target: [-0.2, 1.3, 0.4] }], { stiffness: { [key]: 0.001 } }), key);
  }
});

test("validation: 80+ kinds of invalid input throw an Error with a message (never a silent NaN pose, never an uncaught non-Error); edge values that are valid (1e7 m, -0, empty goals) are accepted", () => {
  const { solver } = ctx(pops.find((p) => p.name === "united-states/army/M")), st = () => standing(solver);
  const g = () => ({ type: "position", landmark: "grip_centre_R", target: [-0.25, 1.3, 0.5] });
  const bad = [
    () => solver.solve(undefined, [g()]), () => solver.solve(() => 1, [g()]), () => solver.solve(st(), g()), () => solver.solve(st(), [null]), () => solver.solve(st(), [{ type: "foo" }]),
    () => solver.solve({ root: { x: NaN }, angles: {} }, [g()]), () => solver.solve({ root: "x" }, [g()]), () => solver.solve({ root: {}, angles: { elbow_R: ["10"] } }, [g()]), () => solver.solve({ root: {}, angles: { elbow_R: [10, 5] } }, [g()]),
    () => solver.solve({ root: {}, angles: { nope: [1] } }, [g()]), () => solver.solve(st(), [{ ...g(), target: "1,2,3" }]), () => solver.solve(st(), [{ ...g(), target: [1, 2, 3, 4] }]), () => solver.solve(st(), [{ ...g(), target: [NaN, 0, 0] }]),
    () => solver.solve(st(), [{ ...g(), target: [Infinity, 0, 0] }]), () => solver.solve(st(), [{ ...g(), target: [1.0000001e7, 0, 0] }]), () => solver.solve(st(), [{ ...g(), landmark: "__proto__" }]), () => solver.solve(st(), [{ ...g(), landmark: "constructor" }]),
    () => solver.solve(st(), [{ ...g(), id: "" }]), () => solver.solve(st(), [{ ...g(), id: 5 }]), () => solver.solve(st(), [{ ...g(), weight: "2" }]), () => solver.solve(st(), [{ ...g(), weight: -1 }]), () => solver.solve(st(), [{ ...g(), weight: 1e13 }]),
    () => solver.solve(st(), [{ ...g(), tolerance: 0 }]), () => solver.solve(st(), [g()], { tolerance: "0.001" }), () => solver.solve(st(), [g()], { foo: 1 }), () => solver.solve(st(), [g()], null), () => solver.solve(st(), [g()], "x"),
    () => solver.solve(st(), [g()], { free: ["arm_X"] }), () => solver.solve(st(), [g()], { free: [5] }), () => solver.solve(st(), [g()], { free: ["pelvis"] }), () => solver.solve(st(), [g()], { free: ["__proto__"] }), () => solver.solve(st(), [g()], { lock: 5 }),
    () => solver.solve(st(), [g()], { maxIterations: 1.5 }), () => solver.solve(st(), [g()], { maxIterations: Infinity }), () => solver.solve(st(), [g()], { restarts: -1 }), () => solver.solve(st(), [g()], { seed: 1.5 }),
    () => solver.solve(st(), [g()], { maxMove: 0 }), () => solver.solve(st(), [g()], { maxMove: NaN }), () => solver.solve(st(), [g()], { damping: 0 }), () => solver.solve(st(), [g()], { stepMax: -1 }), () => solver.solve(st(), [g()], { angleScale: 0 }),
    () => solver.solve(st(), [g()], { reference: { angles: { foo: [1] } } }), () => solver.solve(st(), [g()], { reference: { angles: { elbow_R: [NaN] } } }), () => solver.solve(st(), [g()], { reference: 5 }), () => solver.solve(st(), [g()], { referenceWeight: -1 }),
    () => solver.solve(st(), [g()], { pole: { elbow_R: [0, 0, 0] } }), () => solver.solve(st(), [g()], { pole: { elbow_X: [1, 0, 0] } }), () => solver.solve(st(), [g()], { pole: "x" }), () => solver.solve(st(), [g()], { stiffness: { elbow: -1 } }),
    () => solver.solve(st(), [g()], { rootRange: -1 }), () => solver.solve(st(), [{ type: "direction", joint: "wrist_R", axis: [0, 0, 0], target: [0, 1, 0] }]), () => solver.solve(st(), [{ type: "direction", joint: "wrist_R", axis: "finger_axis", target: [0, 0, 0] }]),
    () => solver.solve(st(), [{ type: "direction", joint: "elbow_R", axis: "palm_normal", target: [0, 1, 0] }]), () => solver.solve(st(), [{ type: "direction", joint: "wrist_R", axis: "__proto__", target: [0, 1, 0] }]),
    () => { const p = solver.worldPoint(st(), "pupil_L"); solver.solve(st(), [{ type: "aim", landmark: "pupil_L", target: [p.x, p.y, p.z] }]); },
    () => { const p = solver.worldPoint(st(), "eye_mid"); solver.solve(st(), [{ type: "lookAt", eyes: false, target: [p.x, p.y, p.z] }]); },
    () => solver.solve(st(), [{ type: "frame", joint: "head", quaternion: [0, 0, 0, 0] }]), () => solver.solve(st(), [{ type: "frame", joint: "head", quaternion: "x" }]), () => solver.solve(st(), [{ type: "frame", joint: "head" }]),
    () => solver.solve(st(), [{ type: "height", landmark: "ASIS_L" }]), () => solver.solve(st(), [{ type: "height", landmark: "ASIS_L", height: 1, direction: [0, 0, 0] }]),
    () => solver.worldPoint(st(), "nope"), () => solver.handFrame("X"), () => IK.reachHand(solver, st(), "Q", [0, 1, 0]), () => IK.reachHand(solver, st(), "R"), () => IK.placeFoot(solver, st(), "R"), () => IK.placeFoot(solver, st(), "R", { position: [0, 0, 0.2], heading: "5" }),
    () => IK.lookAt(solver, st()), () => IK.movePelvis(solver, st()), () => IK.movePelvis(solver, st(), { dy: NaN }), () => IK.movePelvis(solver, st(), { dy: "-0.1" }), () => IK.movePelvis(solver, st(), { dy: 1e300 }), () => IK.maxReach(solver, st(), "R", { direction: [0, 0, 0] }),
    () => IK.pinGoals(solver, st(), ["nope"]), () => IK.pinGoals(solver, st(), 5), () => IK.createSolver(null), () => IK.createSolver({}), () => IK.describeResult(null), () => solver.reachEnvelope(st(), "X"), () => solver.reachEnvelope(st(), "R", { samples: 0 }),
    () => solver.reachEnvelope(st(), "R", { samples: 1.5 }), () => solver.reachEnvelope(st(), "R", { seed: 1.5 }), () => solver.reachEnvelope(st(), "R", { rangeFraction: 0 }), () => solver.reachEnvelope(st(), "R", { landmark: "nope" }),
    () => solver.solve({ root: { x: 1e200 }, angles: {} }, [g()]), () => solver.solve({ root: {}, angles: { elbow_R: [1e300] } }, [g()]),
  ];
  let n = 0;
  for (const f of bad) {
    n++;
    try { f(); assert.fail(`#${n} did not throw: ${f}`); } catch (e) {
      assert.ok(e instanceof Error && !(e instanceof assert.AssertionError) && typeof e.message === "string" && e.message.length > 8, `#${n}: ${e?.constructor?.name}: ${e?.message}`);
      assert.ok(!/Cannot read prop|is not a function|is not iterable|of undefined/.test(e.message), `#${n} raw TypeError: ${e.message}`);
    }
  }
  assert.equal(solver.solve(st(), [g()], {}).converged, true);
  assert.equal(solver.solve({ root: { ...solver.restRoot, x: -0 }, angles: {} }, [g()]).reachable, true);
  const empty = solver.solve(st(), []);
  assert.deepEqual([empty.reachable, empty.iterations, empty.changed.length], [true, 0, 0]);
  assert.doesNotThrow(() => solver.solve(st(), [{ ...g(), target: [1e7, 0, 0] }]));
  assert.doesNotThrow(() => solver.solve(st(), [{ ...g(), id: "__proto__" }]));
  const ids = Object.keys(solver.solve(st(), [g(), g(), g()]).error);
  assert.equal(new Set(ids).size, 3);
  assert.ok(n >= 80, `only ${n} invalid inputs tried`);
});

test("reachEnvelope: deterministic bytes for a seed (two solvers, after other work), different seeds differ, the hull is a closed outward manifold (Euler 2) holding every point; convexHull of 400 random/flat/spherical/lattice clouds is valid", () => {
  const b = pops.find((p) => p.name === "united-states/army/M"), s1 = ctx(b).solver, s2 = IK.createSolver(b.body);
  const e1 = s1.reachEnvelope(standing(s1), "R", { samples: 1500, seed: 7 });
  s1.solve(standing(s1), [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.5] }]);
  const e2 = s2.reachEnvelope(standing(s2), "R", { samples: 1500, seed: 7 }), e3 = s2.reachEnvelope(standing(s2), "R", { samples: 1500, seed: 8 });
  assert.deepEqual(Buffer.from(e1.points.buffer), Buffer.from(e2.points.buffer));
  assert.notDeepEqual(Buffer.from(e1.points.buffer), Buffer.from(e3.points.buffer));
  const check = (pts) => {
    const h = IK.convexHull(pts), V = h.vertices.length / 3, F = h.faces.length / 3;
    if (F === 0) return null;
    const edges = new Set();
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) edges.add(`${h.faces[3 * f + k]},${h.faces[3 * f + (k + 1) % 3]}`);
    assert.equal(edges.size, 3 * F, "duplicate directed edge");
    for (const key of edges) { const [u, v] = key.split(",").map(Number); assert.ok(edges.has(`${v},${u}`), "open edge"); }
    assert.equal(V - edges.size / 2 + F, 2, "Euler characteristic");
    const Pn = (i) => [h.vertices[3 * i], h.vertices[3 * i + 1], h.vertices[3 * i + 2]];
    let vol = 0;
    for (let f = 0; f < F; f++) {
      const a = Pn(h.faces[3 * f]), bb = Pn(h.faces[3 * f + 1]), c = Pn(h.faces[3 * f + 2]), u = bb.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n);
      assert.ok(l > 1e-18, "degenerate face");
      vol += (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) / 6;
      for (let i = 0; i < pts.length / 3; i++) assert.ok(((pts[3 * i] - a[0]) * n[0] + (pts[3 * i + 1] - a[1]) * n[1] + (pts[3 * i + 2] - a[2]) * n[2]) / l < 1e-7, "point outside the hull");
    }
    assert.ok(vol > 0, "inward orientation");
    return V;
  };
  assert.ok(check(e1.points) > 20);
  const r = rng(5);
  for (let t = 0; t < 400; t++) {
    const n = 4 + Math.floor(r() * 40), kind = t % 4, pts = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) { const p = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; if (kind === 1) p[2] *= 1e-3; if (kind === 2) { const s = Math.hypot(...p); p[0] /= s; p[1] /= s; p[2] /= s; } if (kind === 3) for (let k = 0; k < 3; k++) p[k] = Math.round(p[k] * 3) / 3; pts.set(p, 3 * i); }
    check(pts);
  }
  assert.equal(IK.convexHull(new Float64Array(0)).faces.length, 0);
});

test("movePelvis: root.y is exactly the request, the pinned heel and balls (and grips with pinHands) stay within the tolerance on every reachable squat and the claimed pin error equals the rig's, over 704 squats of posed / rotated starts", () => {
  let n = 0, unreach = 0;
  for (let bi = 0; bi < ALL.length; bi += 4) {
    const b = ALL[bi], { solver, rig } = ctx(b), r = rng(808 + bi);
    for (let k = 0; k < 16; k++) {
      const root = { ...solver.restRoot, x: uni(r, -1, 1), z: uni(r, -1, 1), heading: uni(r, -180, 180) }, angles = {};
      for (const s of ["L", "R"]) for (const id of [`shoulder_${s}`, `elbow_${s}`]) angles[id] = L.randAngles(id, r, 0.4);
      if (k % 2) for (const s of ["L", "R"]) { angles[`hip_${s}`] = [uni(r, 0, 20), uni(r, -3, 5), 0]; angles[`knee_${s}`] = [uni(r, 0, 25), 0]; angles[`ankle_${s}`] = [uni(r, -5, 5), 0, 0]; }
      const start = { root, angles }, dy = -uni(r, 0.02, 0.25), pinHands = k % 4 === 0, res = IK.movePelvis(solver, start, { dy }, { pinHands });
      n++;
      assert.deepEqual(limitProblems(res), []);
      assert.ok(Math.abs(res.root.y - (root.y + dy)) < 1e-12 && res.root.x === root.x && res.root.z === root.z);
      let maxd = 0;
      for (const id of [...PINS, ...(pinHands ? ["grip_centre_L", "grip_centre_R"] : [])]) maxd = Math.max(maxd, L.rigPoint(rig, start, id).clone().distanceTo(L.rigPoint(rig, res.pose, id)));
      assert.ok(Math.abs(Math.max(...Object.entries(res.error).filter(([q]) => q.startsWith("pin:")).map(([, v]) => v)) - maxd) < 1e-7, "claimed pin error differs from the rig");
      if (res.reachable) assert.ok(maxd <= 5e-4 + 1e-9, `pins moved ${maxd}`); else { unreach++; assert.ok(dy < -0.1, `shallow squat ${dy} unreachable`); }
    }
  }
  assert.ok(unreach < n * 0.05);
});

test("weighted conflicts are resolved by the exact least-squares ratio; closest pose of unreachable targets is no worse than the best of 30,000 random in-ROM poses by more than 3 mm (99 %)", () => {
  let n = 0, ratioBad = 0, worse = 0, m = 0;
  for (let bi = 0; bi < ALL.length; bi += 8) {
    const b = ALL[bi], { solver } = ctx(b), r = rng(5 + bi);
    for (let k = 0; k < 10; k++) {
      const A = [-uni(r, 0.2, 0.4), uni(r, 1.1, 1.5), uni(r, 0.3, 0.5)], B = [A[0] - 0.1, A[1] + 0.1, A[2] + 0.05], w = [100, 10, 3][k % 3], d = Math.hypot(0.1, 0.1, 0.05);
      const res = solver.solve(standing(solver), [{ type: "position", id: "a", landmark: "grip_centre_R", target: A, weight: w }, { type: "position", id: "b", landmark: "grip_centre_R", target: B }], { free: ["arm_R", "clavicle_R"] });
      n++;
      if (!(res.error.a < res.error.b) || Math.abs(res.error.a - d / (1 + w)) > 0.05 * d || res.reachable) ratioBad++;
    }
  }
  assert.equal(ratioBad, 0);
  for (let bi = 0; bi < ALL.length; bi += 14) {
    const b = ALL[bi], { solver } = ctx(b), r = rng(31 + bi), P = solver.reachEnvelope(standing(solver), "R", { samples: 30000, seed: 9, hull: false }).points;
    const sh = solver.worldPoint(standing(solver), { joint: "shoulder_R" });
    for (let k = 0; k < 14; k++) {
      const T = sh.clone().addScaledVector(new THREE.Vector3(uni(r, -1, 1), uni(r, -0.7, 1), uni(r, -0.8, 1)).normalize(), uni(r, 0.7, 1.3));
      let best = Infinity;
      for (let i = 0; i < P.length; i += 3) best = Math.min(best, Math.hypot(P[i] - T.x, P[i + 1] - T.y, P[i + 2] - T.z));
      if (best < 0.02) continue;
      m++;
      if (IK.reachHand(solver, standing(solver), "R", T.toArray()).error.hand_R > best + 0.003) worse++;
    }
  }
  assert.ok(worse / m < 0.01, `${worse} of ${m} unreachable targets ended farther than the best sampled pose`);
});

test("DEFECT (low): maxReach underestimates backward reaches (3 cm beyond the returned distance a fresh solve with restarts still reaches)", { todo: "maxReach probes with restarts: 3; direction [0, 0.3, -1] returns 0.254 m where 0.284 m is reachable (8 of 180 cases)" }, () => {
  let bad = 0, n = 0;
  for (const name of ["israel/army/M", "lithuania/recruits-trainees/M", "serbia/cadets/M"]) {
    const { solver } = ctx(pops.find((p) => p.name === name));
    for (const side of ["R", "L"]) {
      const dir = [side === "L" ? -0 : 0, 0.3, -1], mr = IK.maxReach(solver, standing(solver), side, { direction: dir });
      n++;
      const beyond = IK.reachHand(solver, standing(solver), side, mr.origin.map((o, i) => o + mr.direction[i] * (mr.distance + 0.03)), { restarts: 30 });
      if (beyond.reachable) bad++;
    }
  }
  assert.equal(bad, 0, `${bad} of ${n}`);
});

test("performance (CPU time, noisy machine allowed): createSolver < 15 ms, arm drag frame p50 < 3 ms, whole-body drag frame (6 pins + hand + look-at, 'all' + pelvis free) p50 < 8 ms and p95 < 16 ms after warmUp (p99 and max are printed only: GC and scheduler noise on a loaded machine); no memory retained over 3,000 solves", (t) => {
  const b = pops[40];
  const cs = []; for (let i = 0; i < 20; i++) { const t0 = L.cpuMs(); IK.createSolver(pops[i].body); cs.push(L.cpuMs() - t0); }
  assert.ok(pct(cs, 0.5) < 15, `createSolver p50 ${pct(cs, 0.5)}`);
  const solver = IK.createSolver(b.body), r = rng(1);
  const cold = [];
  for (let i = 0; i < 100; i++) { const t0 = L.cpuMs(); IK.reachHand(solver, standing(solver), "R", [uni(r, -0.6, 0.1), uni(r, 0.9, 1.7), uni(r, 0.1, 0.6)]); cold.push(L.cpuMs() - t0); }
  t.diagnostic(`cold: first solve ${cold[0].toFixed(1)} ms, worst of the first 100 ${Math.max(...cold).toFixed(1)} ms (warmUp ${IK.warmUp(solver).toFixed(0)} ms)`);
  const frames = (mk, N = 400) => {
    const ts = [], pins = IK.pinGoals(solver, standing(solver), PINS), hand = spline(Array.from({ length: 6 }, () => [uni(r, -0.7, 0.3), uni(r, 0.6, 1.9), uni(r, 0, 0.8)]), N).pts, gz = spline(Array.from({ length: 5 }, () => [uni(r, -1, 1), uni(r, 1, 2), uni(r, 1, 3)]), N).pts;
    let cur = standing(solver);
    for (let i = 0; i < N; i++) { const q = mk(pins, hand[i], gz[i]), t0 = L.cpuMs(); cur = solver.solve(cur, q.goals, { ...IK.DRAG_OPTIONS, ...q.opt }).pose; ts.push(L.cpuMs() - t0); }
    return ts;
  };
  const arm = frames((p, h) => ({ goals: [{ type: "position", id: "h", landmark: "grip_centre_R", target: h }], opt: { free: ["arm_R", "clavicle_R"] } }));
  const whole = frames((p, h, g) => ({ goals: [...p, { type: "position", id: "h", landmark: "grip_centre_R", target: h }, { type: "lookAt", id: "look", target: g }], opt: { free: ["all", "pelvis-xyz"] } }));
  t.diagnostic(`arm drag p50/p95/p99 ${pct(arm, 0.5).toFixed(2)}/${pct(arm, 0.95).toFixed(2)}/${pct(arm, 0.99).toFixed(2)} ms; whole body ${pct(whole, 0.5).toFixed(2)}/${pct(whole, 0.95).toFixed(2)}/${pct(whole, 0.99).toFixed(2)} ms (max ${Math.max(...whole).toFixed(1)})`);
  assert.ok(pct(arm, 0.5) < 3);
  assert.ok(pct(whole, 0.5) < 8 && pct(whole, 0.95) < 16);
  if (global.gc) {
    global.gc(); const h0 = process.memoryUsage().heapUsed; let cur = standing(solver);
    for (let i = 0; i < 3000; i++) cur = IK.reachHand(solver, cur, "R", [-0.3 + 0.1 * Math.sin(i / 20), 1.3 + 0.1 * Math.cos(i / 20), 0.5], IK.DRAG_OPTIONS).pose;
    global.gc(); assert.ok(process.memoryUsage().heapUsed - h0 < 3e6, "memory retained");
  }
});
