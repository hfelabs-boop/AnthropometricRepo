// Second-round adversarial verification of site/js/human/ik.js (independent of ik.test.mjs and of the first round ik.adversarial.test.mjs:
// own sampler, own FK through the rig scene graph, own limit checker, own geometry).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.adversarial.r2.test.mjs"
// Tests named DEFECT are marked `todo`: they run and print what they measured but do not fail the suite (remove the todo once fixed).
import test from "node:test";
import assert from "node:assert/strict";
import { THREE, IK, H, JOINTS, JOINT_BY_ID, REGIONS, ctx, standing, randPosture, poseWithRoot, rigPoint, poseStep, rng, deepFreeze, clone, pct, R2D, D2R } from "./ik.adversarial.r2.lib.mjs";
import { POSTURES } from "../../site/js/human/postures.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";

const POPS = H.popBodies();
const PEOPLE = await H.realPeople(8);
const ALL = [...POPS, ...PEOPLE];
const named = (n) => POPS.find((p) => p.name === n);
const MAN = named("united-states/army/M"), WOMAN = named("united-states/army/F");
const V = (a) => new THREE.Vector3(...a);
const ang = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.clone().normalize().dot(b.clone().normalize()))));
const FEET = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"];
const info = (t, m) => t.diagnostic(m);

test("hard limits: 3000 solves with absurd goals, random free sets and options never leave a range of motion, the 180 degree cap or a finite number", (t) => {
  const GROUPS = ["arm_L", "arm_R", "arms", "clavicles", "hands", "legs", "toes_L", "trunk", "lumbar", "thoracic", "cervical", "spine", "neck", "head", "eyes", "jaw", "pelvis-y", "pelvis-xz", "pelvis-xyz", "pelvis-heading", "pelvis-tilt", "pelvis-rot", "all", "auto", "L3", "T7", "C4", "lumbar.flex", "thoracic.rot", "cervical.lat", "shoulder_R.rot", "hip_L.abd"];
  const LMS = ["grip_centre_R", "grip_centre_L", "index_tip_R", "heel_sole_L", "ball_centre_L", "toe_tip_R", "vertex", "pupil_L", "eye_mid", "ASIS_L", "olecranon_R", "patella_R", "suprasternale"];
  const TYPES = ["position", "position", "position", "pin", "height", "direction", "aim", "lookAt", "frame"];
  const r = rng(4242), pick = (a) => a[Math.floor(r() * a.length)];
  const vec = (k) => [(r() - 0.5) * k, (r() - 0.5) * k + 1, (r() - 0.5) * k];
  let n = 0, caps = 0, bad = [];
  const bodies = [MAN, WOMAN, POPS[40], POPS[100], ...PEOPLE.slice(0, 3)];
  for (let it = 0; it < 3000; it++) {
    const b = bodies[it % bodies.length], s = ctx(b).solver;
    const start = poseWithRoot(s, randPosture(r, { arms: true, legs: true, neck: true, spine: 1, root: true }));
    const goals = [];
    for (let g = 0, ng = 1 + Math.floor(r() * 4); g < ng; g++) {
      const type = pick(TYPES), k = pick([0.5, 2, 10, 1000, 1e5]), lm = pick(LMS), base = { id: "g" + g, weight: pick([1, 1, 0.01, 100, 1e6]) };
      if (type === "position") goals.push({ ...base, type, landmark: lm, target: vec(k) });
      else if (type === "pin") goals.push({ ...base, type, landmark: lm });
      else if (type === "height") goals.push({ ...base, type, landmark: lm, height: (r() - 0.3) * 3 });
      else if (type === "direction") goals.push({ ...base, type, joint: pick(["wrist_R", "head", "ankle_L", "shoulder_R", "T4", "L1"]), axis: pick([[0, 0, 1], [0.3, 0.4, 0.5]]), target: vec(2), line: r() < 0.3 });
      else if (type === "aim") goals.push({ ...base, type, landmark: pick(["pupil_L", "index_tip_R", "toe_tip_L"]), axis: [0, 0, 1], target: vec(k) });
      else if (type === "lookAt") goals.push({ ...base, type, target: vec(k), eyes: r() < 0.5 });
      else goals.push({ ...base, type, joint: pick(["wrist_R", "head", "ankle_R"]), axes: [{ local: [1, 0, 0], world: vec(2) }, { local: [0, 1, 0], world: vec(2), line: r() < 0.5 }] });
    }
    const opts = { free: Array.from({ length: Math.floor(r() * 6) }, () => pick(GROUPS)) };
    if (!opts.free.length) delete opts.free;
    if (r() < 0.2) opts.maxMove = pick([0.04, 0.2, 1]);
    if (r() < 0.2) opts.follow = r() < 0.5;
    if (r() < 0.2) opts.restarts = Math.floor(r() * 10);
    if (r() < 0.1) opts.rootRange = pick([0, 0.1, 5]);
    if (r() < 0.1) opts.maxIterations = pick([0, 1, 5, 200]);
    let res;
    try { res = s.solve(start, goals, opts); } catch (e) { bad.push("threw on valid input: " + e.message); continue; }
    n++;
    const probs = H.limitProblems(res, 1e-9);
    for (const [k2, v] of Object.entries(res.error)) if (!Number.isFinite(v)) probs.push("error " + k2);
    if (!Number.isFinite(res.residual)) probs.push("residual");
    if (res.clamped.some((c) => c.dof === "swing")) caps++;
    if (probs.length) bad.push(b.name + " " + probs.slice(0, 2).join("; ") + " " + JSON.stringify(opts).slice(0, 120));
  }
  info(t, `${n} solves, ${caps} with the shoulder cap active`);
  assert.deepEqual(bad.slice(0, 5), []);
});

test("the solver mutates nothing it was given, accepts frozen inputs, is deterministic and independent of earlier calls and of other solvers", () => {
  const s = ctx(MAN).solver, r = rng(5);
  const same = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  for (let i = 0; i < 25; i++) {
    const p = randPosture(r, { arms: true, legs: true, neck: true, spine: 0.5, root: true });
    const start = poseWithRoot(s, p);
    const tgt = s.worldPoint(poseWithRoot(s, randPosture(r, { arms: true })), "grip_centre_R");
    const goals = [
      { type: "position", id: "h", landmark: "grip_centre_R", target: [tgt.x, tgt.y, tgt.z] }, { type: "lookAt", target: [0.3, 1.6, 2] },
      { type: "frame", joint: "wrist_L", axes: [{ local: "palm_normal", world: [1, 0, 0] }, { local: "hand_across", world: [0, 0, 1], line: true }] },
      { type: "pin", landmark: "heel_sole_L" }, { type: "height", landmark: "ASIS_L", height: 0.9 },
    ];
    const opt = { free: ["arms", "clavicles", "neck", "eyes", "trunk", "legs", "pelvis-xyz", "pelvis-rot"], reference: clone(start), stiffness: { elbow: 0.01 }, pole: { elbow_R: [0, -1, 0] }, lock: ["L3"] };
    const A = clone(start), G = clone(goals), O = clone(opt);
    const frozen = s.solve(deepFreeze(clone(start)), deepFreeze(clone(goals)), deepFreeze(clone(opt)));
    const live = s.solve(clone(start), clone(goals), clone(opt));
    same(frozen.pose, live.pose);
    const st2 = clone(start), g2 = clone(goals), o2 = clone(opt);
    s.solve(st2, g2, o2); same(st2, A); same(g2, G); same(o2, O);
    // aliasing: start used as its own reference, one target array shared by two goals; mutating a result must not reach the next solve
    const sh = [tgt.x, tgt.y, tgt.z], st3 = clone(start);
    const goals3 = [{ type: "position", landmark: "grip_centre_R", target: sh }, { type: "position", landmark: "grip_centre_L", target: sh }];
    const ra = s.solve(st3, goals3, { reference: st3, free: ["arms", "clavicles"] });
    same(sh, [tgt.x, tgt.y, tgt.z]); same(st3, A);
    for (const id of Object.keys(st3.angles)) assert.notEqual(ra.angles[id], st3.angles[id], id + " aliases the start");
    ra.pose.angles.elbow_R[0] = 12345; ra.pose.root.x = 99;
    const rb = s.solve(st3, goals3, { reference: st3, free: ["arms", "clavicles"] });
    assert.notEqual(rb.pose.angles.elbow_R[0], 12345); assert.notEqual(rb.pose.root.x, 99);
    // deterministic, and identical on a fresh solver (no hidden state)
    assert.deepStrictEqual(s.solve(clone(start), clone(goals), clone(opt)).pose, live.pose);
    assert.deepStrictEqual(IK.createSolver(MAN.body).solve(clone(start), clone(goals), clone(opt)).pose, live.pose);
  }
});

test("rig agreement: the errors the solver claims for every goal type equal independent errors measured on the rig scene graph; rig.setPose clamps nothing", (t) => {
  const bodies = [MAN, WOMAN, POPS[33], ...PEOPLE.slice(0, 2)];
  let n = 0, worst = 0, worstLm = 0;
  for (const b of bodies) {
    const c = ctx(b), s = c.solver, rig = c.rig, r = rng(808);
    for (let it = 0; it < 120; it++) {
      const start = poseWithRoot(s, randPosture(r, { arms: true, legs: true, neck: true, spine: 1, root: true }));
      const sdh = r() < 0.5 ? "R" : "L", hp = s.worldPoint(start, `grip_centre_${sdh}`), rr = (a) => a + (r() - 0.5) * 0.8;
      const goals = [
        { type: "position", id: "pos", landmark: `grip_centre_${sdh}`, target: [rr(hp.x), rr(hp.y), rr(hp.z)] },
        { type: "height", id: "ht", landmark: "ASIS_L", height: 0.7 + r() * 0.4 },
        { type: "direction", id: "dir", joint: "head", axis: [0, 0, 1], target: [r() - 0.5, r() - 0.5, 1] },
        { type: "aim", id: "aim", landmark: "index_tip_L", axis: [0, -1, 0], target: [r() - 0.5, 1 + r() * 0.5, 0.5 + r()] },
        { type: "lookAt", id: "look", target: [r() - 0.5, 1.4 + r() * 0.4, 1 + r() * 2] },
        { type: "frame", id: "fr", joint: "ankle_R", axes: [{ local: [0, 0, 1], world: [0.2, 0.1, 1] }, { local: [0, 1, 0], world: [0, 1, 0.1], line: true }] },
        { type: "pin", id: "pin", landmark: "heel_sole_L" },
      ];
      const res = s.solve(start, goals, { free: ["arms", "clavicles", "neck", "eyes", "legs", "trunk", "pelvis-xyz", "pelvis-tilt"] });
      n++;
      assert.equal(rig.setPose(res.pose).clamped.length, 0, "rig.setPose clamped something of the result");
      const gp = rig.getPose();
      for (const id of Object.keys(res.angles)) res.angles[id].forEach((v, k) => assert.ok(Math.abs(gp.angles[id][k] - v) < 1e-9, id));
      for (const id of s.landmarkIds) { if (id.startsWith("ball_centre")) continue; worstLm = Math.max(worstLm, rig.landmarkWorld(id, new THREE.Vector3()).distanceTo(s.worldPoint(res.pose, id))); }
      const lm = (id) => rig.landmarkWorld(id, new THREE.Vector3()), jq = (id) => rig.jointQuaternion(id, new THREE.Quaternion());
      const E = {};
      E.pos = lm(`grip_centre_${sdh}`).distanceTo(V(goals[0].target));
      E.ht = Math.abs(lm("ASIS_L").y - goals[1].height);
      E.dir = ang(V([0, 0, 1]).applyQuaternion(jq("head")), V(goals[2].target));
      E.aim = ang(V([0, -1, 0]).applyQuaternion(jq(s.body.landmarks.index_tip_L.joint)), V(goals[3].target).sub(lm("index_tip_L")));
      E.look = Math.max(...["L", "R"].map((sd) => ang(V([0, 0, 1]).applyQuaternion(jq(`eye_${sd}`)), V(goals[4].target).sub(lm(`pupil_${sd}`)))));
      { const q = jq("ankle_R"), v = V([0, 1, 0]).applyQuaternion(q), tt = V([0, 1, 0.1]); E.fr = Math.max(ang(V([0, 0, 1]).applyQuaternion(q), V([0.2, 0.1, 1])), Math.min(ang(v, tt), ang(v.clone().negate(), tt))); }
      E.pin = lm("heel_sole_L").distanceTo(s.worldPoint(start, "heel_sole_L"));
      for (const k of Object.keys(E)) { worst = Math.max(worst, Math.abs(E[k] - res.error[k])); assert.ok(Math.abs(E[k] - res.error[k]) < 1e-6, `${b.name} ${k}: independent ${E[k]} claimed ${res.error[k]}`); }
    }
  }
  info(t, `${n} solves, worst claimed-vs-independent error difference ${worst.toExponential(1)}, worst landmark difference ${worstLm.toExponential(1)}`);
  assert.ok(worstLm < 1e-8);
});

test("convergence of reachable-by-construction targets over 176 population medians and 12 real people (random start posture, random root and spine): arm position 99%+, leg 99.9%+, gaze 100%", (t) => {
  const st = { arm: [0, 0], leg: [0, 0], gaze: [0, 0] }, misses = [];
  let bi = 0;
  for (const b of ALL) {
    const c = ctx(b), s = c.solver, r = rng(777 + bi++);
    for (const sd of ["L", "R"]) for (let i = 0; i < 10; i++) {
      const gp = randPosture(r, { arms: true, spine: 0.4, root: i % 2 === 0 }), gpose = poseWithRoot(s, gp), tgt = s.worldPoint(gpose, `grip_centre_${sd}`);
      const start = { root: { ...gpose.root }, angles: i % 3 === 0 ? randPosture(r, { arms: true }).angles : {} };
      for (const k of Object.keys(gp.angles)) if (!k.endsWith(`_${sd}`)) start.angles[k] = gp.angles[k];
      const res = IK.reachHand(s, start, sd, [tgt.x, tgt.y, tgt.z]);
      assert.deepEqual(H.limitProblems(res, 1e-9), []);
      const e = rigPoint(c.rig, res.pose, `grip_centre_${sd}`).distanceTo(V([tgt.x, tgt.y, tgt.z]));
      assert.ok(Math.abs(e - res.error[`hand_${sd}`]) < 1e-8, "claimed error differs from the rig");
      st.arm[1]++; if (e <= 1e-3) st.arm[0]++; else misses.push({ b: b.name, e: +(e * 1000).toFixed(1), reachable: res.reachable });
      const la = H.randPose(H.LEG(sd), r, 0.9), lt = s.worldPoint({ root: s.restRoot, angles: la }, `ball_centre_${sd}`);
      const lr = IK.placeFoot(s, { root: { ...s.restRoot }, angles: i % 2 ? H.randPose(H.LEG(sd), r, 0.9) : {} }, sd, { position: [lt.x, lt.y, lt.z], flat: false });
      st.leg[1]++; if (lr.error[`foot_${sd}`] < 1e-3) st.leg[0]++;
      if (sd === "R") { const lk = IK.lookAt(s, { root: { ...s.restRoot }, angles: H.randPose(H.NECK, r, 0.3) }, [(r() - 0.5) * 3, 1 + r(), 0.3 + r() * 2]); st.gaze[1]++; if (lk.error.lookAt < 0.5 * D2R) st.gaze[0]++; }
    }
  }
  const rate = (a) => a[0] / a[1];
  info(t, `arm ${(100 * rate(st.arm)).toFixed(2)}% of ${st.arm[1]}, leg ${(100 * rate(st.leg)).toFixed(2)}% of ${st.leg[1]}, gaze ${(100 * rate(st.gaze)).toFixed(2)}% of ${st.gaze[1]}; worst arm misses ${JSON.stringify(misses.sort((a, b) => b.e - a.e).slice(0, 3))}`);
  assert.ok(rate(st.arm) >= 0.99); assert.ok(rate(st.leg) >= 0.999); assert.equal(rate(st.gaze), 1);
  assert.ok(misses.every((m) => !m.reachable || m.e < 2), "a miss was reported as reachable");
});

test("DEFECT 6D hand-frame goals (handFrameFromGrip, bar axis sign free) reachable by construction are missed 12 % of the time from standing; known sign: 1 %", { todo: "the sign of a line goal is chosen once from the start pose; random restarts reuse it" }, (t) => {
  const c = ctx(MAN), s = c.solver, rig = c.rig, r = rng(1);
  const cnt = { n: 0, line: 0, signed: 0 };
  for (let i = 0; i < 300; i++) {
    const sd = i % 2 ? "L" : "R", aa = H.randPose(H.ARM(sd), r), gp = { root: { ...s.restRoot }, angles: aa };
    const pos = s.worldPoint(gp, `grip_centre_${sd}`);
    rig.setPose(gp, { clamp: false });
    const qw = rig.jointQuaternion(`wrist_${sd}`, new THREE.Quaternion()), hf = s.handFrame(sd);
    const nrm = V(hf.normal).applyQuaternion(qw), ac = V(hf.across).applyQuaternion(qw);
    const mk = (line) => IK.handFrameFromGrip({ position: [pos.x, pos.y, pos.z], normal: nrm.toArray(), axis: ac.toArray(), diameter: 0.03 }, sd, { line });
    const free = [`arm_${sd}`, `clavicle_${sd}`];
    cnt.n++;
    if (s.solve(standing(s), [mk(true)], { free }).reachable) cnt.line++;
    if (s.solve(standing(s), [mk(false)], { free }).reachable) cnt.signed++;
  }
  info(t, `sign free ${cnt.line}/${cnt.n}, sign known ${cnt.signed}/${cnt.n}`);
  assert.ok(cnt.line / cnt.n >= 0.97);
});

test("the hand frame agrees with an independent palm normal built from the landmarks (knuckles and middle fingertip); the claimed orientation error is the worst axis error", () => {
  const bodies = [MAN, WOMAN, POPS[60], ...PEOPLE.slice(0, 3)];
  const lmNormal = (rig, pose, sd, sign) => {
    const g = (id) => rigPoint(rig, pose, `${id}_${sd}`).clone();
    const across = g("metacarpale_radiale").sub(g("metacarpale_ulnare")), mid = g("metacarpale_radiale").add(g("metacarpale_ulnare")).multiplyScalar(0.5);
    return across.cross(g("middle_tip").sub(mid)).normalize().multiplyScalar(sign);
  };
  for (const b of bodies) {
    const c = ctx(b), s = c.solver, rig = c.rig, r = rng(5);
    for (const sd of ["L", "R"]) {
      const hf = s.handFrame(sd), n0 = lmNormal(rig, standing(s), sd, 1), sign = n0.dot(V(hf.normal)) >= 0 ? 1 : -1;
      assert.ok(ang(n0.multiplyScalar(sign), V(hf.normal)) < 0.5 * D2R, "neutral palm normal differs from the landmarks");
      const sh = s.worldPoint(standing(s), { joint: `shoulder_${sd}` });
      for (let i = 0; i < 40; i++) {
        const tgt = [sh.x + (r() - 0.5) * 0.6, sh.y + (r() - 0.5) * 0.6, sh.z + 0.15 + r() * 0.4];
        const nrm = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), ax = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).cross(nrm).normalize();
        const res = s.solve(standing(s), [IK.handFrameFromGrip({ position: tgt, normal: nrm.toArray(), axis: ax.toArray(), diameter: 0.03 }, sd)], { free: [`arm_${sd}`, `clavicle_${sd}`, "trunk"] });
        const nl = lmNormal(rig, res.pose, sd, sign), q = rig.jointQuaternion(`wrist_${sd}`, new THREE.Quaternion());
        const acr = V(hf.across).applyQuaternion(q), nDev = ang(V(hf.normal).applyQuaternion(q), nrm), aDev = Math.min(ang(acr, ax), ang(acr.clone().negate(), ax));
        assert.ok(Math.abs(Math.max(nDev, aDev) - res.error[`hand_${sd}.rot`]) < 0.05, "claimed orientation error differs from the independent axis error");
        if (res.reachable) assert.ok(ang(nl, nrm) < 0.5 * D2R, `landmark palm normal ${ang(nl, nrm) * R2D} deg off a goal reported as met`);
      }
    }
  }
});

test("look-at against an independent gaze computation (eye axis through each pupil; head axis from eye_mid): claimed error equals the measured one, 70 x 40 degrees in front always met", () => {
  const bodies = [...POPS.filter((_, i) => i % 6 === 0), ...PEOPLE.slice(0, 4)];
  let n = 0, metFront = 0, front = 0;
  for (const b of bodies) {
    const c = ctx(b), s = c.solver, rig = c.rig, r = rng(21);
    for (let i = 0; i < 25; i++) {
      const start = poseWithRoot(s, randPosture(r, { arms: false, neck: true, spine: 0.3, root: true, frac: 0.5 }));
      const em = rigPoint(rig, start, "eye_mid").clone(), az = (r() * 2 - 1) * Math.PI, el = (r() - 0.5) * 2.4, dd = 0.3 + r() * 4;
      const tgt = em.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dd));
      for (const eyes of [true, false]) {
        const res = IK.lookAt(s, start, tgt.toArray(), { eyes });
        assert.deepEqual(H.limitProblems(res, 1e-9), []);
        rig.setPose(res.pose, { clamp: false });
        let worst;
        if (eyes) worst = Math.max(...["L", "R"].map((sd) => ang(V([0, 0, 1]).applyQuaternion(rig.jointQuaternion(`eye_${sd}`, new THREE.Quaternion())), tgt.clone().sub(rig.landmarkWorld(`pupil_${sd}`, new THREE.Vector3())))));
        else worst = ang(V([0, 0, 1]).applyQuaternion(rig.jointQuaternion("head", new THREE.Quaternion())), tgt.clone().sub(rig.landmarkWorld("eye_mid", new THREE.Vector3())));
        assert.ok(Math.abs(worst - res.error.lookAt) < 0.02 * D2R, `claimed ${res.error.lookAt * R2D} measured ${worst * R2D}`);
        n++;
        if (Math.abs(az) < 70 * D2R && Math.abs(el) < 40 * D2R) { front++; if (res.reachable) metFront++; }
      }
    }
  }
  assert.equal(metFront, front);
});

test("poles: a reaching elbow never rides above shoulder and hand, never crosses the torso for a target on its own side, a knee never bends more backward than its range", () => {
  const bodies = [MAN, WOMAN, POPS[50], ...PEOPLE.slice(0, 3)];
  let n = 0, high = 0, inside = 0;
  for (const b of bodies) {
    const s = ctx(b).solver, r = rng(3), st = standing(s);
    const P = (id) => s.worldPoint(st, s.landmarkIds.includes(id) ? id : { joint: id }).clone();
    const aL = P("acromion_L"), aR = P("acromion_R"), cf = P("chest_front"), cb = P("chest_back");
    const a = Math.abs(aL.x - aR.x) / 2 * 0.85, bz = Math.abs(cf.z - cb.z) / 2 * 0.9, cz = (cf.z + cb.z) / 2, yLo = P("omphalion").y - 0.05, yHi = P("suprasternale").y;
    const inTorso = (p, k = 1) => p.y > yLo && p.y < yHi && (p.x / (a * k)) ** 2 + ((p.z - cz) / (bz * k)) ** 2 < 1;
    for (const sd of ["L", "R"]) {
      const sgn = sd === "L" ? 1 : -1, sh = P(`shoulder_${sd}`);
      for (let i = 0; i < 100; i++) {
        const t = [sh.x + (r() - 0.5) * 0.4, sh.y - 0.45 + r() * 0.4, sh.z + 0.15 + r() * 0.4];
        const res = IK.reachHand(s, st, sd, t);
        if (!res.reachable) continue;
        n++;
        const el = s.worldPoint(res.pose, { joint: `elbow_${sd}` });
        if (el.y > Math.max(sh.y - 0.02, t[1]) + 0.02) high++;
      }
      for (let i = 0; i < 100; i++) {
        const t = new THREE.Vector3(sh.x + (r() - 0.5) * 1.1, sh.y + (r() - 0.7), sh.z + (r() - 0.35) * 1.1);
        if (inTorso(t, 1.25) || t.y < 0.3 || t.z < 0.05 || t.x * sgn < -0.1) continue;
        const res = IK.reachHand(s, st, sd, t.toArray());
        if (res.reachable && inTorso(s.worldPoint(res.pose, { joint: `elbow_${sd}` }), 0.8)) inside++;
      }
      for (let i = 0; i < 60; i++) {
        const hip = P(`hip_${sd}`), res = IK.placeFoot(s, st, sd, { position: [hip.x + (r() - 0.5) * 0.5, r() * 0.5, hip.z + (r() - 0.3) * 0.7], flat: false });
        assert.ok(res.angles[`knee_${sd}`][0] >= JOINT_BY_ID[`knee_${sd}`].dof[0].min - 1e-9);
      }
    }
  }
  assert.equal(high, 0, "elbow above shoulder and hand");
  assert.ok(inside <= 10, `${inside} elbows inside the torso (borderline targets across the chest only)`);
});

test("L/R symmetry: mirrored goals give identical joint angles (arm reach, gaze) on 2 x 60 bodies", () => {
  const bodies = [...POPS.filter((_, i) => i % 4 === 0), ...PEOPLE.slice(0, 4)];
  let n = 0;
  for (const b of bodies) {
    const s = ctx(b).solver, r = rng(2);
    for (let i = 0; i < 12; i++) {
      const g = s.worldPoint({ root: s.restRoot, angles: H.randPose(H.ARM("R"), r) }, "grip_centre_R");
      const rR = IK.reachHand(s, standing(s), "R", [g.x, g.y, g.z]), rL = IK.reachHand(s, standing(s), "L", [-g.x, g.y, g.z]);
      assert.equal(rR.reachable, rL.reachable);
      for (const j of ["clavicle", "shoulder", "elbow", "forearm", "wrist"]) rR.angles[`${j}_R`].forEach((v, k) => assert.ok(Math.abs(v - rL.angles[`${j}_L`][k]) < 1e-6, `${b.name} ${j}`));
      const tt = [(r() - 0.5) * 3, 1 + r(), 0.5 + r() * 3], a = IK.lookAt(s, standing(s), tt), c = IK.lookAt(s, standing(s), [-tt[0], tt[1], tt[2]]);
      assert.equal(a.reachable, c.reachable);
      assert.ok(Math.abs(a.angles.head[0] - c.angles.head[0]) < 1e-6 && Math.abs(a.angles.head[1] + c.angles.head[1]) < 1e-6 && Math.abs(a.angles.head[2] + c.angles.head[2]) < 1e-6);
      n++;
    }
  }
  assert.ok(n > 100);
});

test("drag continuity (DRAG_OPTIONS): 6 path families x 2 hands x 4 bodies, plus gaze, foot and whole-body drags: no joint turns more than 6 degrees in a frame, limits hold", (t) => {
  const bodies = [MAN, WOMAN, ...PEOPLE.slice(0, 2)];
  let worst = 0, where = "";
  const note = (d, w) => { if (d > worst) { worst = d; where = w; } };
  for (const b of bodies) {
    const s = ctx(b).solver, st = standing(s), em = s.worldPoint(st, "eye_mid").clone();
    for (const sd of ["R", "L"]) {
      const sh = s.worldPoint(st, { joint: `shoulder_${sd}` }), sgn = sd === "L" ? 1 : -1;
      const paths = {
        lissajous: (r) => { const R = 0.15 + r() * 0.5, ph = [r() * 6.28, r() * 6.28, r() * 6.28], fr = [1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3)], cen = [sh.x + (r() - 0.5) * 0.4, sh.y + (r() - 0.5) * 0.4, sh.z + 0.1 + r() * 0.3]; return (u) => [0, 1, 2].map((k) => cen[k] + R * 0.6 * Math.sin(fr[k] * u + ph[k])); },
        torso: (r) => { const y = sh.y - 0.3 + r() * 0.5, z = sh.z + (r() - 0.3) * 0.3; return (u) => [sh.x + sgn * (0.55 - 1.1 * u / 6.283), y, z]; },
        radial: (r) => { const d = [(r() - 0.5) * 2, (r() - 0.5) * 2, 0.3 + r()], l = Math.hypot(...d); return (u) => { const k = Math.sin(u / 2) * 0.85 + 0.15; return [sh.x + d[0] / l * k, sh.y + d[1] / l * k, sh.z + d[2] / l * k]; }; },
        overhead: () => (u) => [sh.x + sgn * 0.3 * Math.cos(u), sh.y + 0.4 + 0.2 * Math.sin(2 * u), sh.z + 0.25 * Math.sin(u) - 0.1],
        behind: () => (u) => [sh.x + sgn * 0.1 * Math.sin(u), sh.y - 0.2 - 0.5 * u / 6.283, sh.z - 0.15 - 0.2 * Math.sin(u / 2)],
        head: (r) => { const v = s.worldPoint(st, "vertex"), R = 0.12 + r() * 0.1; return (u) => [v.x + R * Math.cos(u), v.y - 0.1 + 0.6 * R * Math.sin(u), v.z + R * Math.sin(u)]; },
      };
      for (const [nm, mk] of Object.entries(paths)) for (let k = 0; k < 3; k++) {
        const f = mk(rng(100 * k + 7 + sd.charCodeAt(0)));
        let cur = IK.reachHand(s, st, sd, f(0)).pose;
        for (let i = 1; i < 200; i++) {
          const res = IK.reachHand(s, cur, sd, f((i / 199) * 6.283), IK.DRAG_OPTIONS);
          assert.deepEqual(H.limitProblems(res, 1e-9), []);
          note(poseStep(cur, res.pose).deg, `${b.name} ${nm} ${sd}`); cur = res.pose;
        }
      }
    }
    const gaze = { horizontal: (u) => [em.x + 1.5 * Math.sin(u), em.y, em.z + 1.5 * Math.cos(u)], sagittal: (u) => [em.x, em.y + 1.5 * Math.sin(u), em.z + 1.5 * Math.cos(u)], near: (u) => [em.x + (0.4 + 0.05 * u) * Math.sin(2 * u), em.y + 0.2 * Math.sin(u), em.z + 0.3 + (0.4 + 0.05 * u) * Math.cos(2 * u)] };
    for (const [nm, f] of Object.entries(gaze)) for (const trunk of [false, true]) {
      let cur = IK.lookAt(s, st, f(0), { trunk }).pose;
      for (let i = 1; i <= 240; i++) { const res = IK.lookAt(s, cur, f((i / 240) * 6.283), { trunk, ...IK.DRAG_OPTIONS }); note(poseStep(cur, res.pose).deg, `${b.name} gaze ${nm}`); cur = res.pose; }
    }
    for (const sd of ["L", "R"]) {
      const bc = s.worldPoint(st, `ball_centre_${sd}`).clone();
      const feet = { floor: (u) => ({ position: [bc.x + 0.15 * Math.sin(u), 0, bc.z + 0.15 * (1 - Math.cos(u))], heading: 20 * Math.sin(u) }), kick: (u) => ({ position: [bc.x, 0.7 * (1 - Math.cos(u)) / 2, bc.z + 0.5 * (1 - Math.cos(u)) / 2], flat: false }) };
      for (const [nm, f] of Object.entries(feet)) {
        let cur = IK.placeFoot(s, st, sd, f(0)).pose;
        for (let i = 1; i <= 160; i++) { const res = IK.placeFoot(s, cur, sd, f((i / 160) * 6.283), IK.DRAG_OPTIONS); note(poseStep(cur, res.pose).deg, `${b.name} foot ${nm}`); cur = res.pose; }
      }
    }
    // whole body: right hand + left hand + look-at + six pinned foot points, everything and the pelvis free
    let cur = st; const pins = IK.pinGoals(s, cur, FEET), h0 = s.worldPoint(cur, "grip_centre_R"), r = rng(9);
    for (let i = 0; i < 200; i++) {
      const u = (i / 199) * 6.283, goals = [{ type: "position", id: "h", landmark: "grip_centre_R", target: [h0.x - 0.1 + 0.2 * Math.sin(u), h0.y + 0.3 + 0.15 * Math.sin(2 * u), h0.z + 0.35 + 0.1 * Math.sin(u)] }, { type: "lookAt", id: "look", target: [0.3 * Math.sin(u), 1.6, 2] }, { type: "position", id: "hl", landmark: "grip_centre_L", target: [0.25, 1.0 + 0.1 * Math.sin(u), 0.35] }, ...pins];
      const res = s.solve(cur, goals, { ...IK.DRAG_OPTIONS, free: ["all", "pelvis-xyz", "pelvis-tilt"] });
      assert.deepEqual(H.limitProblems(res, 1e-9), []);
      if (i > 20) note(poseStep(cur, res.pose).deg, `${b.name} whole body`);
      cur = res.pose;
    }
  }
  info(t, `worst step ${worst.toFixed(2)} deg (${where})`);
  assert.ok(worst < 6, `${worst} deg at ${where}`);
});

test("performance and allocation: whole-body drag frame median < 4 ms and p99 < 20 ms after warm-up (noisy machine); no memory retained over 20000 solves", (t) => {
  const s = IK.createSolver(MAN.body);
  IK.warmUp(s);
  let cur = standing(s); const pins = IK.pinGoals(s, cur, FEET), h0 = s.worldPoint(cur, "grip_centre_R").clone(), ts = [];
  for (let i = 0; i < 600; i++) {
    const u = i / 60, res = s.solve(cur, [{ type: "position", landmark: "grip_centre_R", target: [h0.x - 0.1 + 0.2 * Math.sin(u), h0.y + 0.3 + 0.15 * Math.sin(1.7 * u), h0.z + 0.35 + 0.1 * Math.sin(0.9 * u)] }, { type: "lookAt", target: [0.5 * Math.sin(u), 1.6, 2] }, ...pins], { ...IK.DRAG_OPTIONS, free: ["all", "pelvis-xyz", "pelvis-tilt"] });
    ts.push(res.ms); cur = res.pose;
  }
  info(t, `whole-body drag p50 ${pct(ts, 0.5).toFixed(2)} p95 ${pct(ts, 0.95).toFixed(2)} p99 ${pct(ts, 0.99).toFixed(2)} max ${Math.max(...ts).toFixed(1)} ms, ${ts.filter((x) => x > 12).length} frames over 12 ms`);
  assert.ok(pct(ts, 0.5) < 4); assert.ok(pct(ts, 0.99) < 20);
  if (global.gc) { // node --expose-gc
    const mem = () => { global.gc(); const m = process.memoryUsage(); return (m.heapUsed + m.arrayBuffers) / 1024; };
    const r = rng(1); const m0 = mem();
    for (let i = 0; i < 20000; i++) { const u = r() * 6; cur = s.solve(i % 50 ? cur : standing(s), [{ type: "position", id: "g" + (i % 7), landmark: "grip_centre_R", target: [h0.x - 0.1 + 0.2 * Math.sin(u), h0.y + 0.3 * Math.sin(2 * u), h0.z + 0.35] }], { ...IK.DRAG_OPTIONS, free: ["arm_R", "neck"] }).pose; }
    const grown = mem() - m0;
    info(t, `retained after 20000 solves: ${grown.toFixed(0)} KB`);
    assert.ok(grown < 20000);
  }
});

test("reachEnvelope: deterministic bytes for a seed (two solvers, after other work), seeds differ, L is the mirror of R, the hull is a closed outward manifold containing every point, every sampled point is solvable", () => {
  const s = ctx(MAN).solver, s2 = IK.createSolver(MAN.body), st = standing(s);
  const same = (a, b) => Buffer.compare(Buffer.from(a.points.buffer), Buffer.from(b.points.buffer)) === 0;
  const e1 = s.reachEnvelope(st, "R", { samples: 1500, seed: 1 });
  assert.ok(same(e1, s2.reachEnvelope(st, "R", { samples: 1500, seed: 1 })));
  IK.reachHand(s, st, "L", [0.3, 1.2, 0.5], { trunk: true });
  assert.ok(same(e1, s.reachEnvelope(st, "R", { samples: 1500, seed: 1 })));
  assert.ok(same(e1, s.reachEnvelope(st, "R", { samples: 1500 })), "default seed is 1");
  assert.ok(!same(e1, s.reachEnvelope(st, "R", { samples: 1500, seed: 2 })));
  const eL = s.reachEnvelope(st, "L", { samples: 1500, seed: 1 });
  for (let i = 0; i < 1500; i++) assert.ok(Math.abs(eL.points[3 * i] + e1.points[3 * i]) < 1e-6 && Math.abs(eL.points[3 * i + 1] - e1.points[3 * i + 1]) < 1e-6);
  for (const trunk of [false, true]) {
    const e = s.reachEnvelope(st, "R", { samples: 1500, seed: 3, trunk }), V3 = e.hull.vertices, F = e.hull.faces, edges = new Map();
    for (let f = 0; f < F.length; f += 3) for (let k = 0; k < 3; k++) edges.set(F[f + k] + "," + F[f + (k + 1) % 3], 1);
    for (const key of edges.keys()) { const [a, c] = key.split(",").map(Number); assert.ok(edges.has(c + "," + a), "open edge"); }
    let vol = 0;
    for (let f = 0; f < F.length; f += 3) {
      const A = [0, 1, 2].map((k) => V3[3 * F[f] + k]), B = [0, 1, 2].map((k) => V3[3 * F[f + 1] + k]), C = [0, 1, 2].map((k) => V3[3 * F[f + 2] + k]);
      const n = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
      vol += (A[0] * n[0] + A[1] * n[1] + A[2] * n[2]) / 6;
      const l = Math.hypot(...n);
      for (let i = 0; i < e.count; i += 11) assert.ok((n[0] * (e.points[3 * i] - A[0]) + n[1] * (e.points[3 * i + 1] - A[1]) + n[2] * (e.points[3 * i + 2] - A[2])) / l < 1e-5, "point outside the hull");
    }
    assert.ok(vol > 0.5, "hull volume " + vol);
    const e5 = s.reachEnvelope(st, "R", { samples: 300, seed: 9, trunk, rangeFraction: 0.9 });
    for (let i = 0; i < 300; i += 10) assert.ok(IK.reachHand(s, st, "R", [e5.points[3 * i], e5.points[3 * i + 1], e5.points[3 * i + 2]], { trunk }).error.hand_R < 1e-3);
  }
});

test("movePelvis: root.y is exactly the request, claimed pin errors equal independent rig measurements, on 7 bodies x 10 depths x standing / posed starts", () => {
  const bodies = [MAN, WOMAN, POPS[77], ...PEOPLE.slice(0, 4)], r = rng(31);
  for (const b of bodies) {
    const c = ctx(b), s = c.solver;
    for (const dy of [0, -0.02, -0.1, -0.2, -0.3, -0.5, -0.9, 0.05, 0.3, 2]) for (const mode of ["stand", "posed"]) {
      const start = mode === "stand" ? standing(s) : poseWithRoot(s, randPosture(r, { arms: true, legs: true, spine: 0.3, root: true, frac: 0.4 }));
      for (const opt of [{ free: ["legs", "pelvis-tilt"] }, {}]) {
        const res = IK.movePelvis(s, start, { dy }, opt);
        assert.deepEqual(H.limitProblems(res, 1e-9), []);
        assert.equal(res.root.y, start.root.y + dy);
        let worst = 0;
        for (const f of FEET) worst = Math.max(worst, rigPoint(c.rig, start, f).clone().distanceTo(rigPoint(c.rig, res.pose, f)));
        assert.ok(Math.abs(worst - Math.max(...FEET.map((f) => res.error["pin:" + f]))) < 1e-8, "claimed pin error differs from the rig");
      }
    }
  }
});

test("DEFECT a pure vertical squat twists the legs about their axes: hip / knee / ankle axial rotation of 3.6 to 5 degrees at 2 to 5 cm (15 to 22 degrees at 10 to 20 cm with follow:true) where a twist-free exact solution exists; scrubbing dy in 3 mm steps jumps the hip 15 to 80 degrees", { todo: "LM returns at the first iterate within tolerance (ik.js lm(): `if (P.ok) return`), the soft preference toward the start never settles; locked axial DOF reach the same pins" }, (t) => {
  const out = [];
  for (const b of [MAN, WOMAN, named("japan/air-force/both")]) {
    const s = ctx(b).solver, st = standing(s);
    for (const dy of [-0.02, -0.048]) {
      const a = IK.movePelvis(s, st, { dy });
      const lk = IK.movePelvis(s, st, { dy }, { lock: ["hip_L.rot", "hip_R.rot", "knee_L.rot", "knee_R.rot", "ankle_L.rot", "ankle_R.rot", "ankle_L.inv", "ankle_R.inv", "hip_L.abd", "hip_R.abd"] });
      out.push({ b: b.name, dy, twist: Math.max(Math.abs(a.angles.hip_L[2]), Math.abs(a.angles.knee_L[1]), Math.abs(a.angles.ankle_L[2])), lockedReachable: lk.reachable });
    }
  }
  info(t, JSON.stringify(out.map((o) => ({ ...o, twist: +o.twist.toFixed(1) }))));
  assert.ok(out.every((o) => o.lockedReachable), "the twist-free squat is reachable");
  assert.ok(out.every((o) => o.twist < 3), "axial twist of the squatting legs above 3 degrees");
});

test("DEFECT movePelvis called per frame from the previous pose lets the pinned feet creep: 1 mm/frame for 250 frames moves them 10 mm (18 mm after the return); DRAG_OPTIONS lag 250 mm at 10 mm/frame", { todo: "every call re-pins the feet where the previous result left them, and stops up to a pin tolerance (0.1 mm) short in the same direction" }, (t) => {
  const c = ctx(MAN), s = c.solver, rig = c.rig, st = standing(s), ref = Object.fromEntries(FEET.map((f) => [f, s.worldPoint(st, f).clone()]));
  const drift = (pose) => { rig.setPose(pose, { clamp: false }); return Math.max(...FEET.map((f) => rig.landmarkWorld(f, new THREE.Vector3()).distanceTo(ref[f]))) * 1000; };
  let cur = st;
  for (let i = 1; i <= 250; i++) cur = IK.movePelvis(s, cur, { dy: -0.001 }).pose;
  info(t, `foot drift after a 250 mm squat in 250 calls: ${drift(cur).toFixed(1)} mm`);
  assert.ok(drift(cur) < 2);
});

test("DEFECT with the default options a hand goal 8 cm from the hand of a library posture flips the arm: 20 % of 1107 cases turn a joint more than 40 degrees (1 % with follow: true); ref-overhead-reach turns the shoulder 133 degrees for 8 cm", { todo: "outside FOLLOW_BELOW = 5 cm the start is replaced by the analytic two-bone pose (ik.js optimise(): `first = warm`), the posture is not preserved" }, (t) => {
  const s = ctx(MAN).solver, rows = [];
  for (const p of POSTURES) {
    let ex, root;
    try { ex = expandPosture(p); root = placePose(MAN.body, ex, { posture: p }); } catch { continue; }
    const start = { root: { x: root.x, y: root.y, z: root.z, heading: root.heading, flex: root.flex, lat: root.lat, rot: root.rot }, angles: clone(ex.angles) };
    for (const sd of ["L", "R"]) {
      const h = s.worldPoint(start, `grip_centre_${sd}`);
      for (const d of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const a = IK.reachHand(s, start, sd, [h.x + d[0] * 0.08, h.y + d[1] * 0.08, h.z + d[2] * 0.08]);
        if (a.reachable) rows.push({ id: p.id, sd, step: poseStep(start, a.pose).deg });
      }
    }
  }
  const flips = rows.filter((x) => x.step > 40);
  rows.sort((a, b) => b.step - a.step);
  info(t, `${flips.length} of ${rows.length} moves of 8 cm turn a joint > 40 degrees; worst ${JSON.stringify(rows.slice(0, 3))}`);
  assert.ok(flips.length / rows.length < 0.02);
});

test("DEFECT options.reference does not hold a chosen posture against the default elbow pole: after 60 drag frames the elbow is as far from the reference as without it (227 vs 237 mm after 60 frames of a 3 mm wiggle, started from the chosen posture itself)", { todo: "poleWeight 0.003 outweighs referenceWeight 0.25 x stiffness (~2e-6) by 30x; a 3 mm hand wiggle pulls the elbow toward the default pole" }, (t) => {
  const s = ctx(MAN).solver, st = standing(s), A = [-0.3, 1.2, 0.45];
  const natural = IK.reachHand(s, st, "R", A, { pole: { elbow_R: [0, -1, 0] } }).pose, raised = IK.reachHand(s, st, "R", A, { pole: { elbow_R: [-1, 0.3, 0] } }).pose;
  const el = (p) => s.worldPoint(p, { joint: "elbow_R" }).clone();
  const run = (opt, from, ref) => { let cur = from; for (let i = 0; i < 60; i++) cur = IK.reachHand(s, cur, "R", [A[0] + 0.003 * Math.sin(i), A[1] + 0.003 * Math.cos(i), A[2]], { ...IK.DRAG_OPTIONS, ...opt }).pose; return el(cur).distanceTo(el(ref)) * 1000; };
  const withRef = run({ reference: raised }, raised, raised), without = run({}, raised, raised);
  info(t, `elbow ends ${withRef.toFixed(0)} mm from the chosen posture with reference, ${without.toFixed(0)} mm without`);
  assert.ok(withRef < 0.5 * without, "the reference barely changes the drift");
  void natural;
});

test("validation: invalid inputs throw Errors with a message, none returns a silent no-op (known silent cases are listed as DEFECT below)", () => {
  const s = ctx(MAN).solver, st = standing(s), goalOK = [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.45] }];
  const bad = [NaN, Infinity, "1", null, undefined, {}, [], [1, 2], [NaN, 0, 0], ["1", 2, 3], [1e308, 0, 0], true, [1, 2, 3, 4], 5n, () => 1];
  for (const v of bad) {
    assert.throws(() => IK.reachHand(s, st, "R", v), Error, String(v));
    assert.throws(() => s.solve(st, [{ type: "position", landmark: "grip_centre_R", target: v }], { free: ["arm_R"] }), Error);
  }
  for (const g of [null, [null], [1], ["x"], [{ type: "position" }], [{ type: "position", landmark: "nope", target: [0, 1, 0] }], [{ type: "bogus", landmark: "vertex", target: [0, 1, 0] }], [{ type: "height", landmark: "vertex" }],
    [{ type: "direction", joint: "wrist_R", axis: "finger_axis", target: [0, 0, 0] }], [{ type: "direction", joint: "wrist_R", axis: "nope", target: [0, 1, 0] }], [{ type: "lookAt" }], [{ type: "frame", joint: "wrist_R" }], [{ type: "frame", joint: "wrist_R", quaternion: [0, 0, 0, 0] }],
    [{ type: "position", landmark: "grip_centre_R", target: [0, 1, 0], weight: -1 }], [{ type: "position", landmark: "grip_centre_R", target: [0, 1, 0], weight: "2" }], [{ type: "position", landmark: "grip_centre_R", target: [0, 1, 0], tolerance: 0 }], [{ type: "position", id: 5, landmark: "grip_centre_R", target: [0, 1, 0] }]]) {
    assert.throws(() => s.solve(st, g, { free: ["arm_R"] }), Error, JSON.stringify(g));
  }
  for (const o of [null, 5, { free: 5 }, { free: ["nope"] }, { free: ["pelvis"] }, { lock: 5 }, { maxIterations: -1 }, { maxIterations: 1.5 }, { tolerance: 0 }, { tolerance: Infinity }, { damping: 0 }, { stepMax: 0 }, { angleScale: 0 }, { restarts: -1 }, { seed: 1.5 }, { follow: "yes" }, { maxMove: 0 }, { maxMove: NaN }, { limitStiffness: -1 },
    { stiffness: { nope: 1 } }, { stiffness: { elbow: -1 } }, { reference: 5 }, { reference: { angles: { nope: [1] } } }, { reference: { angles: { elbow_R: [NaN] } } }, { reference: { root: { x: NaN } } }, { pole: { nope: [1, 0, 0] } }, { pole: { elbow_R: [NaN, 0, 0] } }, { poleWeight: -1 }, { rootRange: -1 }, { unknownOption: 1 }]) {
    assert.throws(() => s.solve(st, goalOK, o), Error, JSON.stringify(o));
  }
  for (const p of [null, 5, "a", { root: 5 }, { root: { x: NaN } }, { root: { q: 1 } }, { angles: 5 }, { angles: { nope: [1] } }, { angles: { elbow_R: 5 } }, { angles: { elbow_R: [NaN] } }, { angles: { elbow_R: [1, 2] } }, { angles: { elbow_R: "9" } }, { angles: { toString: [1] } }]) {
    assert.throws(() => s.solve(p, goalOK, { free: ["arm_R"] }), Error, JSON.stringify(p));
  }
  for (const b of [null, undefined, {}, { joints: {} }, 5, "x", []]) assert.throws(() => IK.createSolver(b), Error);
  assert.throws(() => IK.describeResult(null), TypeError);
  assert.throws(() => s.reachEnvelope(st, "X", {}), Error);
});

test("DEFECT a frame goal with a wrong-typed quaternion is accepted as the identity orientation (string, {}, 5, true, []) or as a partial rotation ([1])", { todo: "ik.js frameAxes(): non-array quaternions go through new THREE.Quaternion(q.x, q.y, q.z, q.w), whose defaults hide undefined" }, () => {
  const s = ctx(MAN).solver, st = { root: { ...s.restRoot }, angles: { wrist_R: [30, 10] } };
  for (const q of ["abc", {}, 5, true, [], [1]]) assert.throws(() => s.solve(st, [{ type: "frame", joint: "wrist_R", quaternion: q }], { free: ["arm_R"] }), Error, JSON.stringify(q));
});

test("DEFECT a free shoulder whose start sits beyond the 180 degree swing cap (the corner of its box, 150 + 150 = 212 degrees) is returned as given when the goals are already met, though the doc says free joints are repaired", { todo: "ik.js optimise(): `if (P.ok) return` before the cap projection; loadStart/applyVars only clamp per DOF" }, () => {
  const s = ctx(MAN).solver, st = { root: { ...s.restRoot }, angles: { shoulder_R: [150, 150, 0] } };
  const r = s.solve(st, [{ type: "pin", landmark: "heel_sole_L" }], { free: ["arm_R"] });
  assert.deepEqual(H.limitProblems(r, 1e-9), []);
});

test("DEFECT a finite but absurd start root (x >= 1e200, or movePelvis dy 1e300) gives non-finite errors and residual without throwing", { todo: "only goal targets are range checked (FAR = 1e7); the start root is not" }, () => {
  const s = ctx(MAN).solver;
  const r = s.solve({ root: { ...s.restRoot, x: 1e200 }, angles: {} }, [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.45] }], { free: ["arm_R"] });
  assert.ok(Number.isFinite(r.residual) && Object.values(r.error).every(Number.isFinite));
  const m = IK.movePelvis(s, standing(s), { dy: 1e300 });
  assert.ok(Number.isFinite(m.residual) && Object.values(m.error).every(Number.isFinite));
});

test("DEFECT misleading raw TypeErrors / unchecked options: reachEnvelope(options null), movePelvis(start null), envelope seed, options.stiffness / pole of the wrong type, referenceWeight without a reference, describeResult with a NaN error", { todo: "low: polish of the validation" }, () => {
  const s = ctx(MAN).solver, st = standing(s), goalOK = [{ type: "position", landmark: "grip_centre_R", target: [-0.3, 1.2, 0.45] }];
  const msg = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  assert.match(msg(() => s.reachEnvelope(st, "R", null)) ?? "", /options/, "reachEnvelope(null) should name the argument");
  assert.match(msg(() => IK.movePelvis(s, null, { dy: -0.1 })) ?? "", /start/, "movePelvis(null) should name the argument");
  assert.throws(() => s.reachEnvelope(st, "R", { seed: 1.5 }), Error);
  assert.throws(() => s.solve(st, goalOK, { stiffness: 5 }), Error);
  assert.throws(() => s.solve(st, goalOK, { pole: 5 }), Error);
  assert.throws(() => s.solve(st, goalOK, { referenceWeight: -1 }), Error);
  assert.ok(IK.describeResult({ error: { a: NaN }, tolerance: { a: 1e-3 } }).length > 0, "a NaN error is reported as met");
});
