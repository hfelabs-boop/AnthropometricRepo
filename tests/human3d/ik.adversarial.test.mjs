// Adversarial verification of site/js/human/ik.js (independent of ik.test.mjs: own sampler, own limit checker, own geometry).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.adversarial.test.mjs"
// Tests marked `todo` report DEFECTS that were found (they run and print, but do not fail the suite; remove the todo once fixed).
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./ik.adversarial.helpers.mjs";
import { buildRig } from "../../site/js/human/rig.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { makeRotMeter } from "./ik.adversarial.drag.mjs";
import { randomPath, dragStats } from "./ik.adversarial.drag.run.mjs";
import { SCENARIOS, runScenario } from "./ik.adversarial.perf.mjs";
import { closestStats } from "./ik.adversarial.closest.mjs";
const { IK, THREE, JOINTS } = H;

const POPS = H.popBodies();
const PEOPLE = await H.realPeople(8);
const ALL = [...POPS, ...PEOPLE];
const SOLVERS = new Map();
const solverOf = (b) => { if (!SOLVERS.has(b)) SOLVERS.set(b, IK.createSolver(b.body)); return SOLVERS.get(b); };
const named = (n) => POPS.find((b) => b.name === n);
const MAN = named("united-states/army/M"), WOMAN = named("united-states/army/F"), JAPAN = named("japan/air-force/both");
const standing = (s) => ({ root: { ...s.restRoot }, angles: {} });
const info = (t, m) => t.diagnostic(m);

test("all 176 population medians and 8 real people build a solver (1 to 5 ms)", (t) => {
  assert.equal(POPS.length, 176);
  assert.equal(POPS.filter((p) => p.error).length, 0);
  const ts = ALL.map((b) => { const t0 = performance.now(); IK.createSolver(b.body); return performance.now() - t0; });
  info(t, `createSolver median ${H.pct(ts, 0.5).toFixed(2)} ms, max ${Math.max(...ts).toFixed(1)} ms`);
  assert.ok(H.pct(ts, 0.5) < 5);
});

test("convergence on reachable targets: arm 99%+, leg 100%, gaze 100% over 184 bodies; every pose inside every range", (t) => {
  const st = { arm: [0, 0], leg: [0, 0], gaze: [0, 0], armRand: [0, 0] };
  let limits = 0, bi = 0;
  for (const b of ALL) {
    const s = solverOf(b), r = H.rng(1000 + bi++);
    for (const sd of ["L", "R"]) for (let i = 0; i < 12; i++) {
      const a = H.randPose(H.ARM(sd), r), g = s.worldPoint({ root: s.restRoot, angles: a }, `grip_centre_${sd}`);
      const res = IK.reachHand(s, standing(s), sd, [g.x, g.y, g.z]);
      st.arm[1]++; if (res.error[`hand_${sd}`] < 1e-3) st.arm[0]++; limits += H.limitProblems(res).length;
      const res2 = IK.reachHand(s, { root: { ...s.restRoot }, angles: H.randPose(H.ARM(sd), r, 0.8) }, sd, [g.x, g.y, g.z]);
      st.armRand[1]++; if (res2.error[`hand_${sd}`] < 1e-3) st.armRand[0]++; limits += H.limitProblems(res2).length;
      const l = H.randPose(H.LEG(sd), r), p = s.worldPoint({ root: s.restRoot, angles: l }, `heel_sole_${sd}`);
      const res3 = s.solve(standing(s), [{ type: "position", id: "heel", landmark: `heel_sole_${sd}`, target: [p.x, p.y, p.z] }], { free: [`leg_${sd}`] });
      st.leg[1]++; if (res3.error.heel < 1e-3) st.leg[0]++; limits += H.limitProblems(res3).length;
    }
    for (let i = 0; i < 12; i++) {
      const e = s.worldPoint({ root: s.restRoot, angles: H.randPose(H.NECK, r, 0.9) }, "eye_mid");
      const ph = H.uni(r, -80, 80) * H.D2R, th = H.uni(r, -40, 50) * H.D2R;
      const res = IK.lookAt(s, standing(s), [e.x + 2 * Math.sin(ph) * Math.cos(th), e.y + 2 * Math.sin(th), e.z + 2 * Math.cos(ph) * Math.cos(th)]);
      st.gaze[1]++; if (res.error.lookAt < 0.5 * H.D2R) st.gaze[0]++; limits += H.limitProblems(res).length;
    }
  }
  info(t, JSON.stringify(st) + ` limit problems ${limits}`);
  assert.equal(limits, 0);
  assert.ok(st.arm[0] / st.arm[1] > 0.985, `arm ${st.arm}`);
  assert.ok(st.armRand[0] / st.armRand[1] > 0.985, `arm from random start ${st.armRand}`);
  assert.equal(st.leg[0], st.leg[1]);
  assert.equal(st.gaze[0], st.gaze[1]);
});

test("hard limits: 1500 wild solves (every goal type, every free group, wild starts, far/below-floor/inside-body targets, DRAG and default)", (t) => {
  const FREE = [["auto"], ["all"], ["arms", "clavicles", "trunk", "neck"], ["arm_R", "clavicle_R", "trunk", "pelvis-xz"], ["legs", "pelvis-y", "pelvis-tilt"], ["all", "pelvis-rot"], ["lumbar.flex", "thoracic.rot", "cervical.lat", "shoulder_R.rot"], ["L3", "T5", "C4", "head"], ["hands", "jaw", "toes_L"], ["arm_L", "pelvis-heading"], ["leg_R", "trunk", "pelvis-xyz", "pelvis-rot"]];
  const LMS = ["grip_centre_R", "grip_centre_L", "heel_sole_L", "heel_sole_R", "ball_centre_L", "pupil_L", "vertex", "acromion_R", "ASIS_L", "index_tip_R", "toe_tip_L", "olecranon_L", "patella_R"];
  const ids = JOINTS.map((j) => j.id).filter((i) => i !== "pelvis");
  let count = 0, bad = [];
  for (const b of [MAN, WOMAN, JAPAN, named("india/army/M"), ...PEOPLE.slice(0, 2)]) {
    const s = solverOf(b), r = H.rng(2024);
    for (let it = 0; it < 250; it++) {
      const angles = {};
      for (const id of ids) if (r() < 0.5) angles[id] = H.randAngles(id, r, 0.9);
      const start = { root: { x: H.uni(r, -1, 1), y: s.restRoot.y + H.uni(r, -0.3, 0.3), z: H.uni(r, -1, 1), heading: H.uni(r, -180, 180), flex: H.uni(r, -30, 30), lat: H.uni(r, -20, 20), rot: H.uni(r, -30, 30) }, angles };
      const goals = [];
      for (let g = 0, ng = 1 + Math.floor(r() * 4); g < ng; g++) {
        const k = r(), lm = LMS[Math.floor(r() * LMS.length)], far = r();
        const target = far < 0.1 ? [H.uni(r, -1000, 1000), H.uni(r, -1000, 1000), H.uni(r, -1000, 1000)] : far < 0.25 ? [H.uni(r, -1, 1), H.uni(r, -1, 0), H.uni(r, -1, 1)] : far < 0.4 ? [H.uni(r, -0.1, 0.1), H.uni(r, 0.9, 1.5), H.uni(r, -0.1, 0.1)] : [H.uni(r, -1.2, 1.2), H.uni(r, 0, 2.2), H.uni(r, -1, 1.5)];
        const v3 = () => [r() - 0.5, r() - 0.5, r() - 0.5];
        if (k < 0.45) goals.push({ type: "position", landmark: lm, target });
        else if (k < 0.55) goals.push({ type: "pin", landmark: lm });
        else if (k < 0.65) goals.push({ type: "height", landmark: lm, height: H.uni(r, -0.5, 2.5) });
        else if (k < 0.75) goals.push({ type: "lookAt", target, eyes: r() < 0.5 });
        else if (k < 0.85) goals.push({ type: "direction", joint: ["wrist_R", "ankle_L", "head", "shoulder_L", "elbow_R"][Math.floor(r() * 5)], axis: v3(), target: v3(), line: r() < 0.3 });
        else if (k < 0.92) goals.push({ type: "frame", joint: r() < 0.5 ? "wrist_L" : "wrist_R", target: r() < 0.5 ? target : undefined, axes: [{ local: "palm_normal", world: v3() }, { local: "hand_across", world: v3(), line: true }] });
        else goals.push({ type: "aim", landmark: lm, axis: v3(), target });
      }
      const opts = { free: FREE[Math.floor(r() * FREE.length)], ...(r() < 0.3 ? IK.DRAG_OPTIONS : {}) };
      const before = JSON.stringify(start);
      let res;
      try { res = s.solve(start, goals, opts); } catch (e) { bad.push(`throw ${e.message}`); continue; }
      count++;
      if (JSON.stringify(start) !== before) bad.push("start mutated");
      const lp = H.limitProblems(res); if (lp.length) bad.push(`${b.name}#${it}: ${lp[0]}`);
      for (const [k, v] of Object.entries(res.error)) if (!Number.isFinite(v)) bad.push(`non-finite error ${k}`);
      if (!Number.isFinite(res.residual)) bad.push("non-finite residual");
      const changed = new Set(res.changed);
      for (const id of Object.keys(start.angles)) if (!changed.has(id)) { const a = res.angles[id]; if (!a || a.some((v, i) => Math.abs(v - start.angles[id][i]) > 1e-9)) bad.push(`unchanged joint ${id} differs`); }
    }
  }
  info(t, `${count} solves, ${bad.length} problems ${JSON.stringify(bad.slice(0, 3))}`);
  assert.deepEqual(bad, []);
});

test("inputs are never mutated; frozen inputs work; results are fresh objects; same input, same bits", () => {
  const s = solverOf(MAN);
  const start = H.deepFreeze({ root: { ...s.restRoot }, angles: { shoulder_R: [20, 10, 5], elbow_R: [30], clavicle_R: [0, 0] } });
  const goals = H.deepFreeze([{ type: "position", landmark: "grip_centre_R", target: [-0.25, 1.35, 0.5] }]);
  const opts = H.deepFreeze({ free: ["arm_R", "clavicle_R"], pole: { elbow_R: [0, -1, 0] }, stiffness: { shoulder: 0.01 }, reference: { root: {}, angles: { elbow_R: [10] } } });
  const a = s.solve(start, goals, opts), b = s.solve(start, goals, opts);
  const strip = (r) => JSON.stringify({ ...r, ms: 0 });
  assert.equal(strip(a), strip(b));
  a.angles.elbow_R[0] = 999; a.root.x = 5;
  assert.notEqual(s.solve(start, goals, opts).angles.elbow_R[0], 999);
  // interleaved solves of other problems and a second solver of the same body do not change the answer
  const other = IK.createSolver(MAN.body);
  s.solve({ root: { ...s.restRoot }, angles: {} }, [{ type: "position", landmark: "grip_centre_L", target: [1, 1, 1] }], { free: ["all", "pelvis-xyz"] });
  assert.equal(strip(other.solve(start, goals, opts)), strip(a.root.x === 5 ? b : a));
});

test("rig.js and ik.js agree: rig.setPose(result.pose) reproduces the claimed landmarks, errors and angles (1e-9); solver built from the body or rig.restBody is identical", () => {
  let worst = 0, solves = 0;
  for (const b of [MAN, WOMAN, JAPAN, ...PEOPLE.slice(0, 3)]) {
    const rig = buildRig(b.body), sA = IK.createSolver(b.body), sB = IK.createSolver(rig.restBody), r = H.rng(321);
    for (let i = 0; i < 20; i++) {
      const sd = i % 2 ? "L" : "R", start = rig.getPose();
      const g = sA.worldPoint({ root: sA.restRoot, angles: H.randPose(H.ARM(sd), r, 0.9) }, `grip_centre_${sd}`);
      const look = [H.uni(r, -1, 1), H.uni(r, 1, 2), H.uni(r, 0.5, 2)];
      const goals = [{ type: "position", id: "hand", landmark: `grip_centre_${sd}`, target: [g.x, g.y, g.z] }, { type: "lookAt", id: "look", target: look }, ...IK.pinGoals(sA, start, ["heel_sole_L", "heel_sole_R"])];
      const opts = { free: [`arm_${sd}`, `clavicle_${sd}`, "neck", "eyes", "trunk"] };
      const res = sA.solve(start, goals, opts), resB = sB.solve(start, goals, opts);
      assert.equal(JSON.stringify({ ...res, ms: 0 }), JSON.stringify({ ...resB, ms: 0 }));
      assert.equal(rig.setPose(res.pose).clamped.length, 0);
      solves++;
      for (const lm of ["grip_centre_R", "grip_centre_L", "heel_sole_L", "pupil_L", "pupil_R", "eye_mid"]) worst = Math.max(worst, rig.landmarkWorld(lm).distanceTo(sA.worldPoint(res.pose, lm)));
      worst = Math.max(worst, Math.abs(rig.landmarkWorld(`grip_centre_${sd}`).distanceTo(new THREE.Vector3(g.x, g.y, g.z)) - res.error.hand));
      let gz = 0;
      for (const e of ["L", "R"]) gz = Math.max(gz, new THREE.Vector3(0, 0, 1).applyQuaternion(rig.jointQuaternion(`eye_${e}`)).angleTo(new THREE.Vector3(...look).sub(rig.landmarkWorld(`pupil_${e}`)).normalize()));
      worst = Math.max(worst, Math.abs(gz - res.error.look));
    }
    rig.dispose();
  }
  assert.ok(worst < 1e-9, `worst ${worst} over ${solves}`);
});

test("hand-frame goal vs an independent palm normal built from the landmarks (0.2 degree: the default angular tolerance is 0.11); claimed error equals the independent error", () => {
  const indep = (s, pose, sd) => {
    const w = (l) => s.worldPoint(pose, l);
    const rad = w(`metacarpale_radiale_${sd}`), uln = w(`metacarpale_ulnare_${sd}`), dact = w(`dactylion_${sd}`), pc = w(`palm_centre_${sd}`);
    const across = rad.clone().sub(uln).normalize(), kn = rad.clone().add(uln).multiplyScalar(0.5);
    const finger = dact.clone().sub(kn); finger.addScaledVector(across, -finger.dot(across)); finger.normalize();
    const normal = new THREE.Vector3().crossVectors(finger, across).normalize();
    if (normal.dot(pc.clone().sub(kn)) < 0) normal.negate();
    return { across, normal };
  };
  let n = 0, ok = 0, worst = 0, claimDiff = 0;
  for (const b of [MAN, WOMAN, JAPAN, named("india/army/M")]) {
    const s = solverOf(b), r = H.rng(9);
    for (const sd of ["L", "R"]) for (let i = 0; i < 40; i++) {
      const pose = { root: s.restRoot, angles: H.randPose(H.ARM(sd), r, 0.8) }, g = s.worldPoint(pose, `grip_centre_${sd}`), fr = indep(s, pose, sd);
      // the palm normal alone (the knuckle-line convention differs by 6 degrees between joints and landmarks: reported separately)
      const goal = { type: "frame", id: "h", joint: `wrist_${sd}`, landmark: `grip_centre_${sd}`, target: [g.x, g.y, g.z], axes: [{ local: "palm_normal", world: fr.normal.toArray() }] };
      const res = s.solve(standing(s), [goal], { free: [`arm_${sd}`, `clavicle_${sd}`] });
      const ind = indep(s, { root: res.root, angles: res.angles }, sd).normal.angleTo(fr.normal);
      n++;
      if (res.reachable) { ok++; worst = Math.max(worst, ind); }
      claimDiff = Math.max(claimDiff, Math.abs(res.error["h.rot"] - ind));
    }
  }
  assert.ok(ok / n > 0.9, `${ok}/${n}`);
  assert.ok(worst < 0.2 * H.D2R, `worst ${worst * H.R2D} deg`);
  assert.ok(claimDiff < 0.2 * H.D2R, `claim vs independent ${claimDiff * H.R2D} deg`);
});

test("look-at vs an independent gaze (eye joint +Z through each pupil, from raw Kinematics): same error, 900 directions all reached", () => {
  let bad = 0, n = 0, unreached = 0;
  for (const b of [MAN, WOMAN, JAPAN]) {
    const s = solverOf(b), fig = s.body, offs = {};
    for (const j of JOINTS) if (j.parent) offs[j.id] = Array.from(fig.joints[j.id].offset).slice(0, 3);
    const kin = new Kinematics(offs), r = H.rng(3);
    for (let i = 0; i < 300; i++) {
      const d = new THREE.Vector3(H.uni(r, -1, 1), H.uni(r, -0.8, 0.8), H.uni(r, -0.3, 1)).normalize().multiplyScalar(H.uni(r, 0.3, 5)), m = s.worldPoint({ root: s.restRoot, angles: {} }, "eye_mid");
      const t = [m.x + d.x, m.y + d.y, m.z + d.z], res = IK.lookAt(s, standing(s), t);
      kin.solve(res.angles, res.root);
      let e = 0;
      for (const sd of ["L", "R"]) e = Math.max(e, new THREE.Vector3(0, 0, 1).applyQuaternion(kin.quaternion(`eye_${sd}`)).angleTo(new THREE.Vector3(...t).sub(s.worldPoint({ root: res.root, angles: res.angles }, `pupil_${sd}`)).normalize()));
      n++; if (Math.abs(e - res.error.lookAt) > 1e-6) bad++; if (!res.reachable) unreached++;
    }
  }
  assert.equal(bad, 0); assert.equal(unreached, 0, `${unreached}/${n}`);
});

test("pinned feet: movePelvis dy -0.05..-0.2 keeps six foot points within 1 mm on every body; root.y exact; claimed pin error equals the measured one", () => {
  const PINS = ["heel_sole_L", "ball_sole_medial_L", "ball_sole_lateral_L", "heel_sole_R", "ball_sole_medial_R", "ball_sole_lateral_R"];
  for (const dy of [-0.05, -0.1, -0.2]) for (const b of ALL) {
    const s = solverOf(b), st = standing(s), res = IK.movePelvis(s, st, { dy });
    assert.ok(res.reachable, `${b.name} dy ${dy}`);
    assert.equal(res.root.y, s.restRoot.y + dy);
    let worst = 0; for (const p of PINS) worst = Math.max(worst, s.worldPoint(st, p).distanceTo(s.worldPoint(res, p)));
    assert.ok(worst < 1e-3, `${b.name} dy ${dy}: ${worst}`);
    assert.equal(H.limitProblems(res).length, 0);
  }
});

test("foot placement vs an independent sole plane and heading from landmarks", () => {
  let n = 0, ok = 0, bad = 0;
  for (const b of [MAN, WOMAN, JAPAN]) {
    const s = solverOf(b), r = H.rng(12);
    for (const sd of ["L", "R"]) for (let i = 0; i < 60; i++) {
      const base = s.worldPoint({ root: s.restRoot, angles: {} }, `ball_centre_${sd}`), pos = [base.x + H.uni(r, -0.2, 0.2), H.uni(r, 0, 0.25), base.z + H.uni(r, -0.3, 0.35)], heading = H.uni(r, -40, 40);
      const res = IK.placeFoot(s, standing(s), sd, { position: pos, heading, flat: true });
      n++; if (!res.reachable) continue; ok++;
      const w = (l) => s.worldPoint(res, l), heel = w(`heel_sole_${sd}`), med = w(`ball_sole_medial_${sd}`), lat = w(`ball_sole_lateral_${sd}`);
      const nrm = new THREE.Vector3().crossVectors(med.clone().sub(heel), lat.clone().sub(heel)).normalize(); if (nrm.y > 0) nrm.negate();
      const fwd = med.clone().add(lat).multiplyScalar(0.5).sub(heel); fwd.y = 0;
      let dh = Math.abs(Math.atan2(fwd.x, fwd.z) * H.R2D - heading); dh = Math.min(dh, 360 - dh);
      if (nrm.angleTo(new THREE.Vector3(0, -1, 0)) > 0.5 * H.D2R || dh > 0.5 || w(`ball_centre_${sd}`).distanceTo(new THREE.Vector3(...pos)) > 1e-3) bad++;
    }
  }
  assert.ok(ok > 250, `${ok}`); assert.equal(bad, 0);
});

test("reach envelope: deterministic for a seed, closed hull containing every point; maxReach is the end of the reachable ray", () => {
  const s = solverOf(MAN), start = H.deepFreeze({ root: { ...s.restRoot }, angles: { elbow_R: [20] } });
  const a = IK.reachEnvelope(s, start, "R", { samples: 800, seed: 7 }), b = IK.reachEnvelope(s, start, "R", { samples: 800, seed: 7 }), c = IK.reachEnvelope(s, start, "R", { samples: 800, seed: 8 });
  assert.ok(Buffer.from(a.points.buffer).equals(Buffer.from(b.points.buffer)));
  assert.ok(!Buffer.from(a.points.buffer).equals(Buffer.from(c.points.buffer)));
  const { vertices: V, faces: F } = a.hull, edges = new Set();
  for (let f = 0; f < F.length; f += 3) for (let k = 0; k < 3; k++) edges.add(`${F[f + k]},${F[f + (k + 1) % 3]}`);
  for (const e of edges) { const [u, v] = e.split(","); assert.ok(edges.has(`${v},${u}`), "open hull edge"); }
  for (let i = 0; i < a.count; i++) for (let f = 0; f < F.length; f += 3) {
    const P = [0, 1, 2].map((k) => new THREE.Vector3(V[3 * F[f + k]], V[3 * F[f + k] + 1], V[3 * F[f + k] + 2]));
    const n = new THREE.Vector3().crossVectors(P[1].clone().sub(P[0]), P[2].clone().sub(P[0])).normalize();
    assert.ok(n.dot(new THREE.Vector3(a.points[3 * i], a.points[3 * i + 1], a.points[3 * i + 2]).sub(P[0])) < 1e-5, "point outside the hull");
  }
  for (const d of [[0, 0, 1], [0, 1, 0], [-1, 0, 0], [0, 0.7, 0.7]]) {
    const m = IK.maxReach(s, standing(s), "R", { direction: d }), dir = new THREE.Vector3(...d).normalize();
    assert.ok(m.result.reachable);
    assert.equal(IK.reachHand(s, standing(s), "R", m.origin.map((o, k) => o + dir.getComponent(k) * (m.distance + 0.03)), { restarts: 8 }).reachable, false);
  }
});

test("performance: DRAG_OPTIONS whole-body drag p95 < 12 ms after warm-up", (t) => {
  for (const b of [MAN, WOMAN]) {
    const s = solverOf(b);
    for (const [n, fn] of Object.entries(SCENARIOS)) if (fn) runScenario(s, n, fn, 2, 150); // warm up (the first ~100 solves are JIT-cold: up to 25 ms)
    for (const [n, fn] of Object.entries(SCENARIOS)) {
      if (!fn) continue;
      const ts = runScenario(s, n, fn, 4, 100);
      info(t, `${b.name} ${n}: p50 ${H.pct(ts, 0.5).toFixed(2)} p99 ${H.pct(ts, 0.99).toFixed(2)} max ${Math.max(...ts).toFixed(2)} ms`);
      assert.ok(H.pct(ts, 0.95) < 12, `${n}: p95 ${H.pct(ts, 0.95)}`);
    }
  }
});

test("mirror symmetry: the same target mirrored x -> -x gives mirrored elbows (< 1 mm) for 99% of reachable targets", () => {
  let n = 0, bad = 0;
  for (const b of [MAN, WOMAN, JAPAN]) {
    const s = solverOf(b), r = H.rng(5);
    for (let i = 0; i < 150; i++) {
      const g = s.worldPoint({ root: s.restRoot, angles: H.randPose(H.ARM("R"), r, 0.9) }, "grip_centre_R");
      const R = IK.reachHand(s, standing(s), "R", [g.x, g.y, g.z]), L = IK.reachHand(s, standing(s), "L", [-g.x, g.y, g.z]);
      if (!(R.reachable && L.reachable)) continue;
      n++;
      const eR = s.worldPoint(R, { joint: "elbow_R" }), eL = s.worldPoint(L, { joint: "elbow_L" });
      if (Math.hypot(eR.x + eL.x, eR.y - eL.y, eR.z - eL.z) > 1e-3) bad++;
    }
  }
  assert.ok(bad / n < 0.01, `${bad}/${n}`);
});

// ------------------------------------------------------------------------------------------------------------------------------------
// DEFECTS (todo: they run and print, but do not fail the suite)

test("DEFECT drag continuity: hand circling the head, DRAG_OPTIONS, hand moves 6 mm per frame; the elbow must not jump more than 40 mm per frame", { todo: "elbow jumps 50 to 170 mm in one frame" }, (t) => {
  const worst = [];
  for (const b of [MAN, WOMAN, JAPAN]) {
    const s = solverOf(b), sh = s.worldPoint({ root: s.restRoot, angles: {} }, { joint: "shoulder_R" });
    for (const hy of [0.3, 0.15]) {
      const pts = Array.from({ length: 200 }, (_, i) => { const u = i / 199; return [sh.x + 0.2 * Math.cos(2 * Math.PI * u) + 0.1, sh.y + hy, sh.z + 0.2 * Math.sin(2 * Math.PI * u)]; });
      let cur = IK.reachHand(s, standing(s), "R", pts[0]).pose, w = 0;
      for (let i = 1; i < pts.length; i++) { const q = IK.reachHand(s, cur, "R", pts[i], IK.DRAG_OPTIONS); w = Math.max(w, s.worldPoint(cur, { joint: "elbow_R" }).distanceTo(s.worldPoint(q.pose, { joint: "elbow_R" }))); cur = q.pose; }
      worst.push(w);
    }
  }
  info(t, `worst elbow step per frame (mm): ${worst.map((w) => (w * 1000).toFixed(0)).join(" ")}`);
  assert.ok(Math.max(...worst) < 0.04);
});

test("DEFECT drag continuity over random smooth paths (200 points, 3 bodies x 40 paths): at most 1% of paths contain a >40 mm elbow / >15 degree jump", { todo: "45% of paths jump" }, (t) => {
  let paths = 0, bad = 0;
  for (const b of [MAN, WOMAN, JAPAN]) {
    const s = solverOf(b), sh = s.worldPoint({ root: s.restRoot, angles: {} }, { joint: "shoulder_R" }), r = H.rng(77);
    for (let p = 0; p < 40; p++) { paths++; if (dragStats(s, "R", randomPath([sh.x, sh.y, sh.z], r), IK.DRAG_OPTIONS).jumps) bad++; }
  }
  info(t, `${bad}/${paths} paths with a jump`);
  assert.ok(bad / paths <= 0.01);
});

test("DEFECT closest feasible pose: for unreachable hand targets the solver must not be worse than the best of 20000 random in-ROM poses by more than 10 mm", { todo: "about 10% of unreachable targets end 2 to 7 times farther away" }, (t) => {
  let n = 0, worse = 0, worstRatio = 0;
  for (const b of [MAN, WOMAN, JAPAN]) for (const row of closestStats(solverOf(b), 80)) {
    if (row.reachable) continue;
    n++; if (row.solver > row.sampleBest + 0.01) { worse++; worstRatio = Math.max(worstRatio, row.solver / row.sampleBest); }
  }
  info(t, `${worse}/${n} worse, worst ratio ${worstRatio.toFixed(1)}`);
  assert.equal(worse, 0);
});

test("DEFECT overhead reach: hand >= 0.45 m above the shoulder, reachable by construction: solved >= 99%, and a miss is never more than 50 mm", { todo: "98.4% solved, misses of 0.4 to 0.57 m; restarts and seeds do not help" }, (t) => {
  let n = 0, ok = 0, big = 0;
  for (const b of [MAN, WOMAN, JAPAN, named("chile/army/M"), named("india/army/M"), named("russia/recruits-trainees/F")]) {
    const s = solverOf(b), r = H.rng(31), sh = s.worldPoint({ root: s.restRoot, angles: {} }, { joint: "shoulder_R" });
    for (let got = 0; got < 150;) {
      const g = s.worldPoint({ root: s.restRoot, angles: H.randPose(H.ARM("R"), r) }, "grip_centre_R");
      if (g.y - sh.y < 0.45) continue;
      got++; n++;
      const e = IK.reachHand(s, standing(s), "R", [g.x, g.y, g.z]).error.hand_R;
      if (e < 1e-3) ok++; else if (e > 0.05) big++;
    }
  }
  info(t, `${ok}/${n} solved, ${big} misses > 50 mm`);
  assert.ok(ok / n >= 0.99 && big === 0);
});

test("DEFECT validation holes: a NaN / negative / string axis weight, a NaN reference angle and a 1e308 target must throw (or give finite numbers), never a silent no-op", { todo: "silent no-op / non-finite error" }, () => {
  const s = solverOf(MAN), st = standing(s), T = [-0.25, 1.2, 0.45], holes = [];
  const frame = (w) => ({ type: "frame", id: "f", joint: "wrist_R", landmark: "grip_centre_R", target: T, axes: [{ local: "palm_normal", world: [0, 0, 1], weight: w }, { local: "hand_across", world: [0, 1, 0], line: true }] });
  for (const w of [NaN, -1, "x", Infinity]) { try { const r = s.solve(st, [frame(w)], { free: ["arm_R", "clavicle_R"] }); if (!(r.iterations > 0) || !Number.isFinite(r.residual)) holes.push(`axis weight ${w}: iterations ${r.iterations}, residual ${r.residual}`); } catch { /* fine */ } }
  try { const r = s.solve(st, [{ type: "position", landmark: "grip_centre_R", target: T }], { free: ["arm_R"], reference: { angles: { elbow_R: [NaN] } } }); if (r.iterations === 0 && !r.reachable) holes.push(`reference NaN: 0 iterations, silent failure (error ${r.error.grip_centre_R})`); } catch { /* fine */ }
  try { const r = s.solve(st, [{ type: "position", landmark: "grip_centre_R", target: [1e308, 1e308, 1e308] }], { free: ["arm_R"] }); if (!Number.isFinite(r.error.grip_centre_R) || !Number.isFinite(r.residual)) holes.push(`1e308 target: error ${r.error.grip_centre_R}`); } catch { /* fine */ }
  assert.deepEqual(holes, []);
});

test("DEFECT out-of-range start: a vertebra outside its range under a FREE region is repaired like any free joint (IK.md section 2, Limits)", { todo: "kept as given" }, () => {
  const s = solverOf(MAN), res = s.solve({ root: { ...s.restRoot }, angles: { L3: [60, 0, 0], T5: [0, 50, 0] } }, [{ type: "position", landmark: "grip_centre_R", target: [-0.25, 1.3, 0.5] }], { free: ["arm_R", "clavicle_R", "trunk"] });
  assert.deepEqual(H.limitProblems(res), []);
});

test("DEFECT describeResult names the limits of the first four blocking joints of the whole result for every failed goal (right-foot pins blame the left knee)", { todo: "misleading text" }, () => {
  const s = solverOf(MAN), lines = IK.describeResult(IK.movePelvis(s, standing(s), { dy: -0.4 }));
  const right = lines.filter((l) => l.startsWith("pin:heel_sole_R") || l.startsWith("pin:ball_sole_medial_R"));
  assert.ok(right.length > 0);
  for (const l of right) assert.ok(!/Left/.test(l), l);
});
