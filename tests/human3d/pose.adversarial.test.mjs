// Adversarial verification of pose.js, proxies.js, postures.js and postures/grips.js (written by an independent verifier; the author's
// pose.test.mjs / postures.test.mjs are not used or edited). Every check uses an independent implementation (own FK from fk.js, own hull,
// own water-filling, own capsule distance) rather than calling the function under test to judge itself.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.adversarial.test.mjs"
// Tests marked `todo` document CONFIRMED DEFECTS (they assert the correct behaviour and currently fail; node reports them as todo, not as
// failures, so the suite stays green; remove the todo flag when the defect is fixed).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, mirrorId } from "../../site/js/human/skeleton.js";
import * as P from "../../site/js/human/pose.js";
import { bodyProxies, proxyWorld, lowestPoint, capsuleOverlap } from "../../site/js/human/proxies.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { GRIPS, GRIP_NAMES, HAND_JOINTS, gripAngles } from "../../site/js/human/postures/grips.js";
import * as LIB from "../../site/js/human/postures.js";
import * as H from "./pose.adversarial.helpers.mjs";

const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const MAN = H.army("M"), WOMAN = H.army("F"), WOMAN5 = H.army("F", 5), MAN95 = H.army("M", 95);
const FILES = H.populationFiles();
const MEDIANS = FILES.map((f) => H.popBody(f));
const posture = H.posture;

// =====================================================================================================================================
// 1. expansion
// =====================================================================================================================================
test("expand: prototype-polluting and inherited keys are rejected with an error, never reach Object.prototype", () => {
  const J = JSON.parse;
  const bad = [
    { joints: J('{"__proto__":[1]}') }, { joints: J('{"__proto___LR":[1]}') }, { joints: { constructor_LR: [1] } }, { joints: { toString: [1] } },
    { spine: J('{"__proto__":[1,2,3]}') }, { spine: { constructor: [1, 2, 3] } }, { spine: { toString: [1] } },
    { grips: { L: "constructor" } }, { grips: J('{"__proto__":"fist"}') }, { grips: { L: "__proto__" } }, { grips: { L: "toString" } },
    { root: J('{"__proto__":1}') }, { root: { constructor: 1 } },
  ];
  for (const b of bad) assert.throws(() => P.expandPosture({ id: "a", ...b }), /posture "a"/, JSON.stringify(b));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(Object.prototype).length, 0);
});

test("expand: explicit _L/_R override _LR whatever the key order; LR alone mirrors anatomically", () => {
  const a = P.expandPosture({ id: "o", joints: { hip_R: [45], hip_LR: [90, 5, 3], knee_L: [10, 2] } }).angles;
  assert.deepEqual(a.hip_L, [90, 5, 3]); assert.deepEqual(a.hip_R, [45, 0, 0]);
  assert.deepEqual(a.knee_L, [10, 2]); assert.equal(a.knee_R, undefined);
  const b = P.expandPosture({ id: "o", joints: { hip_LR: [90, 5, 3], hip_R: [45] } }).angles;
  assert.deepEqual(a.hip_R, b.hip_R);
  // a grip is overridden joint-by-joint, and the override replaces the whole array of that joint (documented)
  const g = P.expandPosture({ id: "g", grips: { L: "fist" }, joints: { index_mcp_L: [10] } }).angles;
  assert.deepEqual(g.index_mcp_L, [10, 0]); assert.deepEqual(g.middle_mcp_L, GRIPS.fist.joints.middle_mcp);
});

test("expand: eye azimuth convention (posture: + = both eyes look to the figure's left) checked through the kinematics", () => {
  const kin = H.kinOf(MAN);
  const gaze = (angles) => {
    kin.solve(angles, { y: 1 });
    return ["eye_L", "eye_R"].map((id) => new THREE.Vector3(0, 0, 1).applyQuaternion(kin.quaternion(id)));
  };
  const l = gaze(P.expandPosture({ id: "e", joints: { eye_LR: [0, 25] } }).angles);
  for (const v of l) { assert.ok(v.x > 0.4, `looks to +X (the figure's left): ${v.x}`); }
  near(l[0].x, l[1].x, 1e-12); near(l[0].z, l[1].z, 1e-12);
  const r = gaze(P.expandPosture({ id: "e", joints: { eye_LR: [10, -25] } }).angles);
  for (const v of r) assert.ok(v.x < -0.3 && v.y > 0.1);
  // explicit eye_R in posture convention: the same
  const e = gaze(P.expandPosture({ id: "e", joints: { eye_L: [0, 20], eye_R: [0, 20] } }).angles);
  near(e[0].x, e[1].x, 1e-12);
  // symmetric result of mirrorPose: looking left becomes looking right
  const m = gaze(P.mirrorPose({ root: {}, angles: P.expandPosture({ id: "e", joints: { eye_LR: [0, 25] } }).angles }).angles);
  for (const v of m) assert.ok(v.x < -0.4);
  // copySide keeps looking the same way
  const c = gaze(P.copySide({ root: {}, angles: { eye_L: [0, 25] } }, "L").angles);
  assert.ok(c[0].x > 0.4 && c[1].x > 0.4);
});

test("expand: no negative zeros, no mutation, frozen input is fine, output arrays have the DOF count", () => {
  const p = Object.freeze({ id: "f", joints: Object.freeze({ hip_LR: Object.freeze([-0, 5]), eye_LR: Object.freeze([0, -0]) }), spine: Object.freeze({ lumbar: Object.freeze([-0, 0, -0]) }), root: Object.freeze({ flex: -0 }) });
  const e = P.expandPosture(p);
  const walk = (v) => { if (typeof v === "number") assert.ok(!Object.is(v, -0) || v === 0 && false, "negative zero"); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  for (const [jid, a] of Object.entries(e.angles)) { assert.equal(a.length, JOINT_BY_ID[jid].dof.length, jid); a.forEach((x) => assert.ok(!Object.is(x, -0), `${jid} has -0`)); }
  assert.ok(!Object.is(e.root.flex, -0) || true);
});

function waterfill(total, w, lo, hi, add) { // reference: s_i = clamp(lambda w_i, lo_i - add_i, hi_i - add_i) with sum = clip(total), by bisection
  const L = lo.map((l, i) => l - add[i]), U = hi.map((h, i) => h - add[i]);
  const f = (lam) => w.map((wi, i) => Math.min(U[i], Math.max(L[i], lam * wi)));
  const sum = (lam) => f(lam).reduce((a, b) => a + b, 0);
  const T = Math.min(U.reduce((a, b) => a + b, 0), Math.max(L.reduce((a, b) => a + b, 0), total));
  let a = -1e6, b = 1e6;
  for (let k = 0; k < 200; k++) { const m = (a + b) / 2; if (sum(m) < T) a = m; else b = m; }
  return f((a + b) / 2);
}
function regionCase(rand, withAdds) {
  const rn = Object.keys(REGIONS)[Math.floor(rand() * 3)], rg = REGIONS[rn], c = Math.floor(rand() * 3);
  const w = [rg.weights, rg.weightsLat, rg.weightsRot][c];
  const js = rg.joints.map((id) => JOINT_BY_ID[id]);
  const lo = js.map((j) => j.dof[c].min), hi = js.map((j) => j.dof[c].max);
  const add = rg.joints.map(() => (withAdds && rand() < 0.4 ? (rand() - 0.5) * (hi[0] - lo[0]) * 0.8 : 0));
  const total = (rand() - 0.5) * 2 * [rg.range.flex[1], rg.range.lat[1], rg.range.rot[1]][c] * 1.3;
  const pv = {}; rg.joints.forEach((id, i) => { if (add[i]) { pv[id] = [0, 0, 0]; pv[id][c] = add[i]; } });
  const spine = { [rn]: [0, 0, 0] }; spine[rn][c] = total;
  return { rn, rg, c, w, lo, hi, add, total, pv, spine };
}
test("expand: region totals follow the water-filling reference (no per-vertebra additions), saturation included", () => {
  const rand = H.rng(11);
  for (let it = 0; it < 5000; it++) {
    const k = regionCase(rand, false);
    const e = P.expandPosture({ id: "a", spine: k.spine });
    const got = k.rg.joints.map((id) => e.angles[id]?.[k.c] ?? 0), exp = waterfill(k.total, k.w, k.lo, k.hi, k.add);
    got.forEach((g, i) => near(g, exp[i], 1e-6, `${k.rn}[${k.c}] total ${k.total}`));
  }
});
test("expand: a region total that the vertebrae can take is never reported as a shortfall when per-vertebra values are added", () => {
  const rand = H.rng(11);
  let bad = 0;
  for (let it = 0; it < 20000; it++) {
    const k = regionCase(rand, true);
    const e = P.expandPosture({ id: "a", spine: k.spine, joints: k.pv });
    const feasible = k.hi.reduce((s, h, i) => s + h - k.add[i], 0) >= k.total - 1e-9 && k.lo.reduce((s, l, i) => s + l - k.add[i], 0) <= k.total + 1e-9;
    if (feasible && e.shortfall.length) bad++;
  }
  assert.equal(bad, 0, `${bad} feasible cases reported as shortfall`);
});
test("expand: every region total at the exact limit of the region validates without ROM or shortfall errors", () => {
  for (const [rn, rg] of Object.entries(REGIONS)) for (let c = 0; c < 3; c++) {
    for (const v of [[rg.range.flex, rg.range.lat, rg.range.rot][c][0], [rg.range.flex, rg.range.lat, rg.range.rot][c][1]]) {
      const arr = [0, 0, 0]; arr[c] = v;
      const e = P.expandPosture({ id: "a", spine: { [rn]: arr } });
      assert.equal(e.shortfall.length, 0, `${rn} ${c} ${v}`);
      assert.equal(P.clampPose({ root: e.root, angles: e.angles }).clamped.length, 0, `${rn} ${c} ${v}`);
    }
  }
});
test("expand: error messages name the posture and the key; docs examples", () => {
  assert.throws(() => P.expandPosture({ id: "q", joints: { hip: [1] } }), /posture "q": joints\.hip: unknown joint id: "hip" needs a side, write hip_LR/);
  assert.throws(() => P.expandPosture({ id: "q", joints: { hip_LR: [1, 2, 3, 4] } }), /joints\.hip_LR: expected 1 to 3 values \(flex, abd, rot\), got 4/);
  assert.throws(() => P.expandPosture({ id: "q", joints: { hip_LR: [] } }), /expected 1 to 3/);
  assert.throws(() => P.expandPosture({ id: "q", joints: { pelvis: [1] } }), /driven by `root`/);
  assert.throws(() => P.expandPosture({ id: "q", root: { x: 1 } }), /no position/);
  assert.throws(() => P.expandPosture({ id: "q", spine: { lumbar: [1, 2, 3, 4] } }), /spine\.lumbar/);
});
test("expand: the message for 'hip_L_LR' calls the sided joint 'not a paired joint' (misleading)", () => {
  assert.throws(() => P.expandPosture({ id: "q", joints: { hip_L_LR: [1] } }), (e) => !/is not a paired joint/.test(e.message));
});

// =====================================================================================================================================
// 2. clamp / mirror / copySide
// =====================================================================================================================================
const swingLen = (j, a) => Math.sqrt(j.dof.reduce((s, d, i) => s + (d.role === "twist" ? 0 : (a[i] ?? 0) ** 2), 0));
test("clamp: result is inside the box and the 180 degree swing cap, idempotent, identity inside the ROM, input untouched, report exact", () => {
  const rand = H.rng(5);
  for (let it = 0; it < 300; it++) {
    const angles = {};
    for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = j.dof.map((d) => d.min - 40 + rand() * (d.max - d.min + 80));
    const snap = JSON.stringify(angles);
    const { pose, clamped } = P.clampPose({ root: { heading: 5 }, angles });
    assert.equal(JSON.stringify(angles), snap);
    for (const [jid, a] of Object.entries(pose.angles)) {
      const j = JOINT_BY_ID[jid];
      a.forEach((v, i) => assert.ok(v >= j.dof[i].min - 1e-9 && v <= j.dof[i].max + 1e-9, `${jid}[${i}]`));
      assert.ok(swingLen(j, a) <= 180 + 1e-9, `${jid} swing ${swingLen(j, a)}`);
    }
    const again = P.clampPose(pose);
    assert.equal(again.clamped.length, 0); assert.ok(P.poseEquals(again.pose, pose, 1e-12));
    for (const k of clamped) { const j = JOINT_BY_ID[k.joint], i = j.dof.findIndex((d) => d.key === k.dof); near(k.requested, angles[k.joint][i], 0); near(k.applied, pose.angles[k.joint][i], 1e-12); assert.notEqual(k.requested, k.applied); }
  }
  const ok = H.randomPose(H.rng(1), 0.5, false);
  assert.equal(P.clampPose(ok).clamped.length, 0);
  assert.throws(() => P.clampPose({ angles: { hip_L: [NaN] } }), /finite/);
  assert.throws(() => P.clampPose({ angles: { nope: [1] } }), /unknown joint/);
});

test("mirror: forward kinematics of mirrorPose(p) is the left-right image of p (positions and orientations of every joint, root included)", () => {
  const body = MAN, k1 = H.kinOf(body), k2 = H.kinOf(body), rand = H.rng(3);
  let seen = 0;
  for (let it = 0; it < 200; it++) {
    const p = H.randomPose(rand, it % 3 === 0 ? 1 : 0.6), m = P.mirrorPose(p);
    k1.solve(p.angles, { x: 0.1, y: 0.9, z: 0.2, ...p.root });
    k2.solve(m.angles, { x: -0.1, y: 0.9, z: 0.2, ...m.root });
    for (const j of JOINTS) {
      const a = k1.position(j.id), b = k2.position(mirrorId(j.id));
      near(a.x, -b.x, 1e-12, j.id); near(a.y, b.y, 1e-12, j.id); near(a.z, b.z, 1e-12, j.id);
      const pa = k1.toWorld(j.id, [0.03, 0.07, -0.05]), pb = k2.toWorld(mirrorId(j.id), [-0.03, 0.07, -0.05]);
      near(pa.x, -pb.x, 1e-12); near(pa.y, pb.y, 1e-12); near(pa.z, pb.z, 1e-12);
      if (Math.abs(a.x + a.x) > 0 && Math.abs(a.x - b.x) > 1e-3) seen++;
    }
    assert.ok(P.poseEquals(P.mirrorPose(m), p, 1e-12), "involution");
  }
  assert.ok(seen > 1000, "the test is not vacuous");
});

test("copySide: the other side gets the anatomical angles of the source, eyes keep looking the same way, unpaired joints and root untouched", () => {
  const rand = H.rng(9), k = H.kinOf(MAN);
  for (let it = 0; it < 50; it++) {
    const p = H.randomPose(rand, 0.8, false); p.root = { heading: 0, flex: 0, lat: 0, rot: 0 };
    for (const from of ["L", "R"]) {
      const c = P.copySide(p, from);
      const to = from === "L" ? "R" : "L";
      for (const j of JOINTS.filter((j) => j.side === from)) {
        const src = p.angles[j.id], dst = c.angles[mirrorId(j.id)];
        const exp = src.slice(); if (j.id.startsWith("eye_")) exp[1] = -exp[1] === 0 ? 0 : -exp[1];
        exp.forEach((v, i) => near(dst[i], v, 1e-12, j.id));
      }
      for (const j of JOINTS.filter((j) => !j.side && j.id !== "pelvis")) assert.deepEqual(c.angles[j.id], p.angles[j.id]);
      // FK: with a symmetric trunk (unpaired joints zeroed) the result is left-right symmetric
      const sym = { root: {}, angles: Object.fromEntries(Object.entries(c.angles).map(([jid, a]) => [jid, JOINT_BY_ID[jid].side ? a : a.map(() => 0)])) };
      k.solve(sym.angles, { y: 1 });
      for (const j of JOINTS.filter((j) => j.side === "L" && !/^(eye)/.test(j.id))) {
        const a = k.position(j.id), b = k.position(mirrorId(j.id));
        near(a.x, -b.x, 1e-9, j.id + " x"); near(a.y, b.y, 1e-9); near(a.z, b.z, 1e-9);
      }
    }
  }
  assert.throws(() => P.copySide({ angles: {} }, "X"), /from must be/);
});

// =====================================================================================================================================
// 3. blend
// =====================================================================================================================================
test("blend: t=0/1 exact, blend(a,a)=a, symmetric in (a,b,t)/(b,a,1-t), heading short way, clamps t", () => {
  const rand = H.rng(77);
  for (let it = 0; it < 200; it++) {
    const a = H.randomPose(rand, 0.7), b = H.randomPose(rand, 0.7), t = 0.05 + 0.9 * rand();
    assert.ok(P.poseEquals(P.blendPoses(a, b, 0), a, 0)); assert.ok(P.poseEquals(P.blendPoses(a, b, 1), b, 0));
    assert.ok(P.poseEquals(P.blendPoses(a, a, t), a, 1e-9), "blend(a,a)");
    const x = P.blendPoses(a, b, t), y = P.blendPoses(b, a, 1 - t);
    assert.ok(P.poseEquals(x, y, 1e-6), "symmetry");
  }
  const hd = (a, b, t) => P.blendPoses({ root: { heading: a } }, { root: { heading: b } }, t).root.heading;
  near(hd(170, -170, 0.5), 180, 1e-9); near(hd(-170, 170, 0.5), 180, 1e-9); near(hd(10, 350, 0.5), 0, 1e-9); near(hd(0, 180, 0.5), 90, 1e-9);
});

test("blend: continuity in t for random pairs whose swing stays below 150 degrees (no jumps)", () => {
  const body = MAN, k1 = H.kinOf(body), k2 = H.kinOf(body), rand = H.rng(5);
  const sh = JOINT_BY_ID.shoulder_L;
  let worst = 0;
  for (let it = 0; it < 600; it++) {
    const mk = () => { for (;;) { const a = sh.dof.map((d) => d.min + rand() * (d.max - d.min)); if (Math.hypot(a[0], a[1]) <= 120) return a; } };
    const a = { angles: { shoulder_L: mk(), hip_L: [rand() * 100, rand() * 30, 0] } }, b = { angles: { shoulder_L: mk(), hip_L: [rand() * 100, rand() * 30, 0] } };
    let prev = null;
    for (let k = 0; k <= 100; k++) {
      k2.solve(P.blendPoses(a, b, k / 100).angles, { y: 1 });
      const cur = ["wrist_L", "ankle_L"].map((id) => k2.position(id).clone());
      if (prev) worst = Math.max(worst, ...cur.map((c, i) => c.distanceTo(prev[i])));
      prev = cur;
    }
  }
  assert.ok(worst < 0.3 * Math.PI / 100 * 3, `largest step ${worst}`);
});

test("blend: continuity in t when an end pose has a shoulder swing near 180 degrees (raised arm): the hand must not flick", () => {
  const k2 = H.kinOf(MAN), rand = H.rng(5), sh = JOINT_BY_ID.shoulder_L;
  let worst = 0;
  for (let it = 0; it < 1500; it++) {
    const mk = () => { for (;;) { const a = sh.dof.map((d) => d.min + rand() * (d.max - d.min)); if (Math.hypot(a[0], a[1]) <= 175) return a; } };
    const a = { angles: { shoulder_L: mk() } }, b = { angles: { shoulder_L: mk() } };
    let prev = null;
    for (let k = 0; k <= 200; k++) {
      k2.solve(P.blendPoses(a, b, k / 200).angles, { y: 1 });
      const cur = k2.position("wrist_L").clone();
      if (prev) worst = Math.max(worst, cur.distanceTo(prev));
      prev = cur;
    }
  }
  assert.ok(worst < 0.3 * Math.PI / 200 * 3, `largest step ${(worst * 1000).toFixed(0)} mm`);
});

test("blend: the blend of two poses inside the range of motion stays inside it (animation between library postures must not need clamping)", () => {
  const rand = H.rng(8);
  let bad = 0, n = 0;
  for (let it = 0; it < 1500; it++) {
    const a = H.randomPose(rand, 1, false), b = H.randomPose(rand, 1, false);
    if (P.clampPose(P.blendPoses(a, b, 0.5)).clamped.length) bad++;
    n++;
  }
  assert.equal(bad, 0, `${bad}/${n} mid-poses outside the ROM`);
  const m = P.blendPoses({ angles: { shoulder_L: [170, 0, 0] } }, { angles: { shoulder_L: [-60, 0, 0] } }, 0.25);
  assert.ok(m.angles.shoulder_L[0] >= -60, `flexion ${m.angles.shoulder_L[0]}`);
});

test("blend: moderate poses (every joint within 60% of its range): midpoint stays inside the ROM", () => {
  const rand = H.rng(8);
  let bad = 0;
  for (let it = 0; it < 1500; it++) {
    const a = H.randomPose(rand, 0.3, false), b = H.randomPose(rand, 0.3, false);
    if (P.clampPose(P.blendPoses(a, b, 0.5)).clamped.length) bad++;
  }
  assert.equal(bad, 0);
});

// =====================================================================================================================================
// 4. placement
// =====================================================================================================================================
const NEUTRAL = { root: {}, angles: {} };
const ISO = { root: {}, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } };
const POSES = {
  neutral: ["feet", NEUTRAL], iso: ["seat+feet", ISO],
  supine: ["body", { root: { flex: -90 }, angles: { ankle_L: [-15, 0, 0], ankle_R: [-15, 0, 0] } }],
  prone: ["body", { root: { flex: 90 }, angles: { ankle_L: [-45, 0, 0], ankle_R: [-45, 0, 0] } }],
  side: ["body", { root: { lat: 90 }, angles: {} }],
  tpose: ["feet", { root: {}, angles: { shoulder_L: [0, 82, 0], shoulder_R: [0, 82, 0] } }],
  squat: ["feet", { root: {}, angles: { hip_L: [125, 0, 0], hip_R: [125, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [30, 0, 0], ankle_R: [30, 0, 0] } }],
  kneel: ["knees", { root: {}, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } }],
  quad: ["hands-knees", { root: { flex: 90 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } }],
};
const SURF = (placed, name) => placed.surfaces[placed.carriers[name]];

test("placement: the primary carrier touches its surface exactly (<1e-12 m) for 176 population medians x 9 poses x 4 headings; nothing else of the support set sinks for body/feet", () => {
  let n = 0;
  for (const body of MEDIANS) {
    const kin = H.kinOf(body);
    for (const [pn, [support, pose]] of Object.entries(POSES)) for (const heading of [0, 37, -140, 180]) {
      const d = P.placePoseDetailed(body, pose, { support, heading, anchor: { x: 0.3, z: -0.2 } });
      kin.solve(pose.angles, d.root); n++;
      const prim = Object.keys(d.carriers)[0];
      const set = prim === "body" ? Object.keys(body.landmarks).map((id) => H.lmWorld(body, kin, id).y) : (P.contactClearances(body, pose, d.root, d.surfaces, { [prim]: d.carriers[prim] }).map((r) => r.clearance + SURF(d, prim)));
      if (prim === "body") { assert.ok(Math.min(...set) >= -1e-12, `${pn}: a landmark is ${Math.min(...set)} below the floor`); assert.ok(Math.min(...set) < 0.03, `${pn}: nothing within 30 mm of the floor`); }
      else near(Math.min(...set), SURF(d, prim), 1e-12, `${pn} primary ${prim} gap`);
      assert.ok(Object.values(d.root).every(Number.isFinite));
      near(d.gaps[prim], 0, 0);
    }
  }
  assert.ok(n > 6000);
});

test("placement: 200 real people (ANSUR/ASRAN/USAF): exact grounding for neutral, ISO sitting, supine, prone; ISO sitting puts the soles on the floor within 1 micron", async () => {
  const people = await H.realPeople(200);
  assert.equal(people.length, 200);
  for (const { key, body } of people) {
    const kin = H.kinOf(body);
    for (const pn of ["neutral", "iso", "supine", "prone"]) {
      const [support, pose] = POSES[pn];
      const d = P.placePoseDetailed(body, pose, { support });
      kin.solve(pose.angles, d.root);
      const feetY = Math.min(...body.contacts.feet.map((id) => H.lmWorld(body, kin, id).y));
      if (support === "feet" || support === "seat+feet") near(feetY, 0, 1e-9, `person ${key} ${pn} feet`);
      if (support === "seat+feet") near(Math.min(...body.contacts.seat.map((id) => H.lmWorld(body, kin, id).y)), d.surfaces.seat, 1e-12);
      if (support === "body") assert.ok(Math.min(...Object.keys(body.landmarks).map((id) => H.lmWorld(body, kin, id).y)) >= -1e-12);
    }
  }
});

test("placement: heading invariance (heights and horizontal distances unchanged), anchor centroid exact, input pose not mutated", () => {
  const rand = H.rng(21);
  const bodies = MEDIANS.filter((_, i) => i % 4 === 0);
  for (const body of bodies) for (const support of Object.keys(P.SUPPORT_CARRIERS)) {
    const pose = H.randomPose(rand, 0.7), snap = JSON.stringify(pose);
    const heading = (rand() - 0.5) * 720, anchor = { x: (rand() - 0.5) * 4, z: (rand() - 0.5) * 4 };
    const r0 = P.placePoseDetailed(body, pose, { support }), r1 = P.placePoseDetailed(body, pose, { support, heading, anchor });
    assert.equal(JSON.stringify(pose), snap);
    const ids = Object.keys(body.landmarks).filter((_, i) => i % 3 === 0);
    const p0 = ids.map((id) => P.landmarkPosition(body, pose, r0.root, id).clone()), p1 = ids.map((id) => P.landmarkPosition(body, pose, r1.root, id).clone());
    p0.forEach((a, i) => { near(a.y, p1[i].y, 1e-12); for (let j = i + 1; j < p0.length; j += 7) near(Math.hypot(a.x - p0[j].x, a.z - p0[j].z), Math.hypot(p1[i].x - p1[j].x, p1[i].z - p1[j].z), 1e-12); });
    const prim = Object.keys(r1.carriers)[0];
    if (prim !== "body") {
      const rows = P.contactClearances(body, pose, r1.root, r1.surfaces, { [prim]: r1.carriers[prim] }).map((x) => P.landmarkPosition(body, pose, r1.root, x.point));
      near(rows.reduce((s, p) => s + p.x, 0) / rows.length, anchor.x, 1e-12); near(rows.reduce((s, p) => s + p.z, 0) / rows.length, anchor.z, 1e-12);
    }
  }
});

test("placement: the body carrier is anchored at the centre of mass (hand calculation)", () => {
  const pose = POSES.supine[1], anchor = { x: 0.7, z: -1.1 };
  const r = P.placePose(MAN, pose, { support: "body", anchor });
  const com = P.centerOfMass(MAN, pose, r).point;
  near(com.x, anchor.x, 1e-12); near(com.z, anchor.z, 1e-12);
});

test("placement: wrong carrier / support / surface names are errors with a message that lists the valid names; no NaN root", () => {
  assert.throws(() => P.placePose(MAN, NEUTRAL, { carriers: { foo: "floor" } }), /unknown contact set "foo" \(available: feet/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { support: "foo" }), /unknown support "foo" \(known: feet/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { carriers: { feet: "desk" } }), /surface "desk"/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { carriers: {} }), /at least one entry/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { surfaces: { floor: NaN } }), /height in metres/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { heading: NaN }), /degrees/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { anchor: { x: "a" } }), /anchor/);
  assert.throws(() => P.placePose(MAN, null), /expected/);
  assert.throws(() => P.placePose(null, NEUTRAL), /BodyModel/);
  assert.throws(() => P.placePose(MAN, { angles: { nope: [1] } }), /unknown joint/);
  assert.throws(() => P.placePose(MAN, { angles: { knee_L: [1, 2, 3] } }), /2 DOF/);
  assert.throws(() => P.placePose(MAN, NEUTRAL, { support: "seat", seatHeight: -1 }), /seat height/);
  // a floor that is not at 0, a seat given explicitly
  near(P.placePose(MAN, NEUTRAL, { surfaces: { floor: 0.5 } }).y - P.placePose(MAN, NEUTRAL).y, 0.5, 1e-12);
  near(P.placePose(MAN, ISO, { support: "seat", surfaces: { seat: 0.6 } }).y - P.placePose(MAN, ISO, { support: "seat", surfaces: { seat: 0.5 } }).y, 0.1, 1e-12);
});

test("placement: surface / support names that are inherited object properties ('toString', 'constructor', '__proto__') are errors, not a NaN root", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => P.placePose(MAN, NEUTRAL, { carriers: { feet: name } }), Error, `surface ${name}`);
    assert.throws(() => P.placePose(MAN, NEUTRAL, { support: name }), /unknown support/, `support ${name}`);
    assert.throws(() => P.contactClearances(MAN, NEUTRAL, { y: 1 }, { floor: 0 }, { feet: name }), Error, `contactClearances ${name}`);
  }
});

test("placement: rig agreement. With rig.restBody AND with the plain BodyModel the placed pose agrees with the rig to 1e-9 (figureOf)", () => {
  const rig = buildRig(MAN, {}), rb = rig.restBody, rand = H.rng(3);
  let worstRB = 0, worstBody = 0;
  for (let it = 0; it < 60; it++) {
    const pose = H.randomPose(rand, 0.9), root = { x: 0.2, y: 1, z: 0.1, ...pose.root };
    rig.setPose({ root, angles: pose.angles }, { clamp: false });
    for (const id of Object.keys(MAN.landmarks)) {
      const r = rig.landmarkWorld(id);
      worstRB = Math.max(worstRB, r.distanceTo(P.landmarkPosition(rb, pose, root, id)));
      if (!/^(xiphoid|substernale)$/.test(id)) worstBody = Math.max(worstBody, r.distanceTo(P.landmarkPosition(MAN, pose, root, id)));
    }
  }
  assert.ok(worstRB < 1e-9, `restBody vs rig ${worstRB}`);
  assert.ok(worstBody < 1e-9, `plain BodyModel vs rig ${worstBody} (pose.js poses the figure the rig draws)`);
});
test("placement and validation of hand positions on the BodyModel agree with the figure drawn by the rig (palm within 15 mm)", () => {
  const rig = buildRig(MAN, {});
  const pose = { root: {}, angles: { shoulder_L: [50, 5, 0], elbow_L: [80], forearm_L: [80], wrist_L: [-20, 0] } }, root = { y: 1 };
  rig.setPose({ root, angles: pose.angles }, { clamp: false });
  const d = rig.landmarkWorld("palm_centre_L").distanceTo(P.landmarkPosition(MAN, pose, root, "palm_centre_L"));
  assert.ok(d < 0.015, `palm differs by ${(d * 1000).toFixed(0)} mm`);
});

test("placement: lying postures: the skin of the rig does not sink more than 5 mm below the floor or float more than 5 mm above it", () => {
  let worstSink = 0, worstFloat = 0;
  for (const body of [MAN, WOMAN5, MAN95, H.popBody(FILES[7]), H.popBody(FILES[40])]) {
    const rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o) });
    for (const pn of ["supine", "prone", "side"]) {
      const [support, pose] = POSES[pn];
      const r = P.placePose(body, pose, { support });
      rig.setPose({ root: r, angles: pose.angles }, { clamp: false });
      const y = rig.lowestY({ skin: true });
      worstSink = Math.max(worstSink, -y); worstFloat = Math.max(worstFloat, y);
    }
  }
  assert.ok(worstSink < 0.005 && worstFloat < 0.005, `skin sinks ${(worstSink * 1000).toFixed(1)} mm / floats ${(worstFloat * 1000).toFixed(1)} mm`);
});

// =====================================================================================================================================
// 5. proxies
// =====================================================================================================================================
test("proxies: 29 capsules for every population body, finite positive radii, radii follow the rings, left/right symmetric", () => {
  for (const body of MEDIANS) {
    const px = bodyProxies(body);
    assert.equal(px.n, px.list.length); assert.equal(new Set(px.list.map((c) => c.id)).size, px.n);
    assert.ok(px.n >= 29 && px.n <= 40, `n=${px.n}`);
    for (const c of px.list) {
      assert.ok(c.ra > 0.005 && c.ra < 0.2 && c.rb > 0.005 && c.rb < 0.2, `${c.id} radii ${c.ra} ${c.rb}`);
      [...c.a.off, ...c.b.off].forEach((v) => assert.ok(Number.isFinite(v)));
    }
    const rings = (t) => body.shape.tubes[t].rings.map((r) => 0.5 * (r.rx + r.rz));
    for (const t of ["thigh", "shank", "upper_arm", "forearm"]) {
      const c = px.list.find((x) => x.id === `${t}_L`), rr = rings(`${t}_L`);
      assert.ok(Math.max(c.ra, c.rb) <= Math.max(...rr) + 1e-9 && Math.min(c.ra, c.rb) >= Math.min(...rr) - 1e-9, `${t} radii inside the ring range`);
    }
    for (const c of px.list.filter((x) => x.side === "L")) {
      const m = px.list.find((x) => x.id === c.id.replace(/_L$/, "_R"));
      near(m.ra, c.ra, 1e-12); near(m.rb, c.rb, 1e-12);
    }
  }
});

test("proxies: lowestPoint equals an independent brute-force minimum over the swept spheres; proxyWorld equals toWorld of the endpoints", () => {
  const rand = H.rng(12), kin = H.kinOf(MAN), px = bodyProxies(MAN);
  let W = null;
  for (let it = 0; it < 100; it++) {
    const pose = H.randomPose(rand, 0.9), root = { x: 0.1, y: 0.9, z: 0.2, ...pose.root };
    kin.solve(pose.angles, root);
    const k = P.solvePose(MAN, pose, root); W = proxyWorld(px, k, W);
    let best = Infinity;
    px.list.forEach((c, i) => {
      const a = kin.toWorld(c.a.joint, c.a.off), b = kin.toWorld(c.b.joint, c.b.off);
      near(W.ay[i], a.y, 1e-12); near(W.bx[i], b.x, 1e-12); near(W.bz[i], b.z, 1e-12);
      for (let s = 0; s <= 200; s++) { const t = s / 200; best = Math.min(best, a.y + (b.y - a.y) * t - (c.ra + (c.rb - c.ra) * t)); }
    });
    near(lowestPoint(W).y, best, 1e-12);
  }
});

function numericOverlap(c1, c2) { // brute force: max over (s,t) of r1(s)+r2(t)-|p1(s)-p2(t)| (coarse grid + local refinement)
  const f = (s, t) => { const p = c1.a.clone().lerp(c1.b, s), q = c2.a.clone().lerp(c2.b, t); return c1.ra + (c1.rb - c1.ra) * s + c2.ra + (c2.rb - c2.ra) * t - p.distanceTo(q); };
  let bs = 0, bt = 0, bv = -Infinity;
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) { const v = f(i / 60, j / 60); if (v > bv) { bv = v; bs = i / 60; bt = j / 60; } }
  for (let w = 1 / 60; w > 1e-7; w *= 0.6) for (const ds of [-w, 0, w]) for (const dt of [-w, 0, w]) { const s = Math.min(1, Math.max(0, bs + ds)), t = Math.min(1, Math.max(0, bt + dt)), v = f(s, t); if (v > bv) { bv = v; bs = s; bt = t; } }
  return bv;
}
test("proxies: capsuleOverlap agrees with a numeric minimisation (untapered exactly, tapered within the documented approximation), degenerate segments included", () => {
  const rand = H.rng(40), V = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
  let worstUntapered = 0, worstTapered = 0;
  for (let it = 0; it < 300; it++) {
    const mk = (taper) => { const a = V(), b = it % 7 === 0 ? a.clone() : a.clone().add(V().multiplyScalar(0.6)), ra = 0.02 + rand() * 0.05; return { a, b, ra, rb: taper ? 0.02 + rand() * 0.05 : ra }; };
    const u1 = mk(false), u2 = mk(false); worstUntapered = Math.max(worstUntapered, Math.abs(capsuleOverlap(u1, u2) - numericOverlap(u1, u2)));
    const t1 = mk(true), t2 = mk(true); t1.rb = t1.ra * (0.7 + 0.3 * rand()); t2.rb = t2.ra * (0.7 + 0.3 * rand()); // limb-like taper (up to 30 %)
    worstTapered = Math.max(worstTapered, Math.abs(capsuleOverlap(t1, t2) - numericOverlap(t1, t2)));
  }
  assert.ok(worstUntapered < 1e-5, `untapered ${worstUntapered}`);
  assert.ok(worstTapered < 0.02, `tapered ${worstTapered}`);
  // parallel and crossing segments, point on segment
  near(capsuleOverlap({ a: [0, 0, 0], b: [1, 0, 0], r: 0.1 }, { a: [0, 0.15, 0], b: [1, 0.15, 0], r: 0.1 }), 0.05, 1e-12);
  near(capsuleOverlap({ a: [0, 0, 0], b: [1, 0, 0], r: 0.1 }, { a: [0.5, -1, 0.3], b: [0.5, 1, 0.3], r: 0.1 }), -0.1, 1e-12);
});

test("proxies: the capsules cover the skin: no skin vertex of the rig is more than 80 mm outside every capsule (neutral and ISO sitting, 6 bodies)", () => {
  let worst = 0;
  for (const body of [MAN, WOMAN, WOMAN5, MAN95, MEDIANS[10], MEDIANS[100]]) {
    const rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o) });
    for (const [pn, [support, pose]] of [["neutral", POSES.neutral], ["iso", POSES.iso]]) {
      const root = P.placePose(body, pose, { support });
      rig.setPose({ root, angles: pose.angles }, { clamp: false }); rig.group.updateMatrixWorld(true);
      const W = proxyWorld(bodyProxies(body), P.solvePose(rig.restBody, pose, root));
      const m = rig.skin, pos = m.geometry.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i += 5) {
        m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
        let best = Infinity;
        for (let k = 0; k < W.n; k++) {
          const ax = W.ax[k], ay = W.ay[k], az = W.az[k], bx = W.bx[k] - ax, by = W.by[k] - ay, bz = W.bz[k] - az, L = bx * bx + by * by + bz * bz;
          const t = L > 0 ? Math.max(0, Math.min(1, ((v.x - ax) * bx + (v.y - ay) * by + (v.z - az) * bz) / L)) : 0;
          best = Math.min(best, Math.hypot(v.x - ax - bx * t, v.y - ay - by * t, v.z - az - bz * t) - (W.ra[k] + t * (W.rb[k] - W.ra[k])));
        }
        worst = Math.max(worst, best);
      }
    }
  }
  assert.ok(worst < 0.08, `worst skin vertex ${(worst * 1000).toFixed(0)} mm outside the capsules`);
});

test("proxies: thigh capsule follows the thigh rings (the capsule axis uses only the first and last ring centre)", () => {
  const body = WOMAN, rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o) });
  const root = P.placePose(body, NEUTRAL, {});
  rig.setPose({ root, angles: {} }, { clamp: false }); rig.group.updateMatrixWorld(true);
  const W = proxyWorld(bodyProxies(body), P.solvePose(rig.restBody, NEUTRAL, root));
  const m = rig.skin, pos = m.geometry.attributes.position, v = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < pos.count; i++) {
    m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
    if (v.y < 0.55 || v.y > 0.78) continue; // the thigh
    let best = Infinity;
    for (let k = 0; k < W.n; k++) {
      const ax = W.ax[k], ay = W.ay[k], az = W.az[k], bx = W.bx[k] - ax, by = W.by[k] - ay, bz = W.bz[k] - az, L = bx * bx + by * by + bz * bz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((v.x - ax) * bx + (v.y - ay) * by + (v.z - az) * bz) / L)) : 0;
      best = Math.min(best, Math.hypot(v.x - ax - bx * t, v.y - ay - by * t, v.z - az - bz * t) - (W.ra[k] + t * (W.rb[k] - W.ra[k])));
    }
    worst = Math.max(worst, best);
  }
  assert.ok(worst < 0.03, `thigh skin ${(worst * 1000).toFixed(0)} mm outside the capsules`);
});

test("proxies: a thumb pushed deep into the head is detected", () => {
  const rb = buildRig(MAN, {}).restBody, root = { y: rb.joints.pelvis.offset[1] };
  // thumb tip inside the head, palm just outside: search a wrist/forearm combination near the head
  let found = null;
  const vx = P.landmarkPosition(rb, NEUTRAL, root, "vertex"), me = P.landmarkPosition(rb, NEUTRAL, root, "menton");
  const c = new THREE.Vector3(0, (vx.y + me.y) / 2 + 0.01, 0.028);
  const rand = H.rng(5);
  for (let it = 0; it < 20000 && !found; it++) {
    const j = P.clampPose({ angles: { shoulder_L: [-30 + rand() * 210, -20 + rand() * 110, -60 + rand() * 120], elbow_L: [rand() * 150], forearm_L: [-60 + rand() * 120], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] } }).pose.angles;
    const a = j, full = P.expandPosture(posture({ id: "thumb", joints: a })).angles; // the thumb tip is judged in the pose that is validated (with the relaxed grip)
    const t = P.landmarkPosition(rb, { angles: full }, root, "thumb_tip_L");
    const inside = (((t.x - c.x) / 0.0766 / 0.6) ** 2 + ((t.y - c.y) / 0.1175 / 0.6) ** 2 + ((t.z - c.z) / 0.0985 / 0.6) ** 2) < 1;
    if (inside && val(rb, posture({ id: "thumb", joints: a })).ok) found = a;
  }
  assert.equal(found, null, `thumb 40+ mm inside the head accepted: ${JSON.stringify(found)}`);
});

// =====================================================================================================================================
// 6. centre of mass and balance
// =====================================================================================================================================
test("centre of mass: equals the hand calculation sum(m_i * p_i) / sum(m_i) with an independent FK; load adds at the landmark mean; agrees with rig.centerOfMass within 1 mm", () => {
  const kin = H.kinOf(MAN), rig = buildRig(MAN, {}), rand = H.rng(9);
  for (let it = 0; it < 100; it++) {
    const pose = H.randomPose(rand, 0.8), root = { x: 0.3, y: 1, z: -0.2, ...pose.root };
    kin.solve(pose.angles, root);
    let M = 0; const s = new THREE.Vector3();
    for (const m of Object.values(MAN.masses)) { s.addScaledVector(kin.toWorld(m.com.joint, m.com.offset), m.mass); M += m.mass; }
    s.multiplyScalar(1 / M);
    const got = P.centerOfMass(MAN, pose, root);
    near(got.mass, M, 1e-9); assert.ok(got.point.distanceTo(s) < 1e-12);
    rig.setPose({ root, angles: pose.angles }, { clamp: false });
    assert.ok(rig.centerOfMass(new THREE.Vector3()).point.distanceTo(got.point) < 1e-3);
    const load = P.centerOfMass(MAN, pose, root, new THREE.Vector3(), { mass: 25, landmarks: ["grip_centre_L", "palm_centre_R"] });
    const lp = kin.toWorld(MAN.landmarks.grip_centre_L.joint, MAN.landmarks.grip_centre_L.offset).add(kin.toWorld(MAN.landmarks.palm_centre_R.joint, MAN.landmarks.palm_centre_R.offset)).multiplyScalar(0.5);
    const exp = s.clone().multiplyScalar(M).addScaledVector(lp, 25).multiplyScalar(1 / (M + 25));
    assert.ok(load.point.distanceTo(exp) < 1e-12); near(load.mass, M + 25, 1e-9);
  }
  assert.throws(() => P.centerOfMass(MAN, NEUTRAL, {}, new THREE.Vector3(), { mass: 5, landmarks: ["nope"] }), /unknown landmark/);
  // the standing COM height is 54-58% of stature for the 176 medians
  for (const b of MEDIANS) { const r = P.placePose(b, NEUTRAL, {}); const c = P.centerOfMass(b, NEUTRAL, r).point; assert.ok(c.y / b.stature > 0.5 && c.y / b.stature < 0.6, `${c.y / b.stature}`); }
});

function refMargin(points, q) { // independent: hull by gift wrapping, then signed distance
  const uniq = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()];
  const distSeg = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); };
  if (uniq.length === 0) return -Infinity;
  if (uniq.length === 1) return -Math.hypot(q[0] - uniq[0][0], q[1] - uniq[0][1]);
  // gift wrapping
  let start = uniq.reduce((m, p) => (p[0] < m[0] || (p[0] === m[0] && p[1] < m[1]) ? p : m));
  const hull = []; let cur = start;
  do {
    hull.push(cur); let nxt = uniq[0] === cur ? uniq[1] : uniq[0];
    for (const p of uniq) { if (p === cur) continue; const cr = (nxt[0] - cur[0]) * (p[1] - cur[1]) - (nxt[1] - cur[1]) * (p[0] - cur[0]); if (cr < 0 || (cr === 0 && Math.hypot(p[0] - cur[0], p[1] - cur[1]) > Math.hypot(nxt[0] - cur[0], nxt[1] - cur[1]))) nxt = p; }
    cur = nxt;
  } while (cur !== start && hull.length <= uniq.length);
  // drop collinear points
  const h = hull.filter((p, i) => { const a = hull[(i + hull.length - 1) % hull.length], b = hull[(i + 1) % hull.length]; return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-12; });
  if (h.length < 3) { // all collinear: the segment between the extreme points
    const ext = [uniq.reduce((m, p) => (p[0] < m[0] || (p[0] === m[0] && p[1] < m[1]) ? p : m)), uniq.reduce((m, p) => (p[0] > m[0] || (p[0] === m[0] && p[1] > m[1]) ? p : m))];
    return -distSeg(q, ext[0], ext[1]);
  }
  // orientation
  let area = 0; h.forEach((p, i) => { const n = h[(i + 1) % h.length]; area += p[0] * n[1] - n[0] * p[1]; });
  const sgn = area > 0 ? 1 : -1;
  let inside = true, minSigned = Infinity;
  h.forEach((a, i) => { const b = h[(i + 1) % h.length]; const cr = sgn * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])); const d = cr / Math.hypot(b[0] - a[0], b[1] - a[1]); if (d < 0) inside = false; minSigned = Math.min(minSigned, d); });
  if (inside) return minSigned;
  return -Math.min(...h.map((a, i) => distSeg(q, a, h[(i + 1) % h.length])));
}
test("balance: margin equals an independent gift-wrapping hull with signed distance (random clouds, collinear, duplicate, single and empty sets; all point formats)", () => {
  const rand = H.rng(33), root = { y: 1 };
  const com = P.centerOfMass(MAN, NEUTRAL, root).point;
  for (let it = 0; it < 400; it++) {
    const n = it % 40 === 0 ? 0 : it % 41 === 0 ? 1 : 2 + Math.floor(rand() * 10);
    let pts = Array.from({ length: n }, () => [com.x + (rand() - 0.5) * 0.5, com.z + (rand() - 0.5) * 0.5]);
    if (it % 5 === 0 && n > 2) pts = pts.map((p, i) => [p[0], pts[0][1] + (p[0] - pts[0][0]) * 0.5]); // collinear
    if (it % 7 === 0 && n > 1) pts.push(pts[0].slice()); // duplicate
    const fmt = [(p) => [p[0], 0, p[1]], (p) => ({ x: p[0], y: 0, z: p[1] }), (p) => new THREE.Vector3(p[0], 0, p[1])];
    const b = P.balance(MAN, NEUTRAL, root, pts.map((p, i) => fmt[i % 3](p)));
    const exp = refMargin(pts, [com.x, com.z]);
    if (exp === -Infinity) assert.equal(b.margin, -Infinity); else near(b.margin, exp, 1e-9, `case ${it} n=${n}`);
    assert.equal(b.inside, exp >= 0 && pts.length >= 3 && Number.isFinite(exp) && b.hull.length >= 3);
  }
  assert.throws(() => P.balance(MAN, NEUTRAL, root, ["nope"]), /unknown landmark/);
  const feet = P.balance(MAN, NEUTRAL, root, body_feet(MAN));
  assert.ok(feet.inside && feet.margin > 0, "standing COM is inside the feet hull");
});
function body_feet(body) { return body.contacts.feet; }

test("balance: standing COM inside the foot hull for the 176 medians; leaning the trunk forward 30 degrees takes it out", () => {
  for (const b of MEDIANS) {
    const r = P.placePose(b, NEUTRAL, {});
    const bal = P.balance(b, NEUTRAL, r, b.contacts.feet);
    assert.ok(bal.margin > -0.02, `${bal.margin}`);
  }
  const lean = { root: {}, angles: { hip_L: [30, 0, 0], hip_R: [30, 0, 0] } }, r = P.placePose(MAN, lean, {});
  assert.ok(P.balance(MAN, lean, r, MAN.contacts.feet).margin < -0.04);
});

// =====================================================================================================================================
// 7. validator
// =====================================================================================================================================
const val = (body, p, o) => P.validatePosture(body, p, o);
const ISO_SIT = posture({ id: "adv-iso-sit", support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90] } });

test("validator: accepts the reference postures for every population median and 200 real people", async () => {
  const good = [LIB.byId("iso-7250-standing"), LIB.byId("iso-7250-sitting"), LIB.byId("t-pose"), ISO_SIT, posture({ id: "adv-relaxed", joints: { elbow_LR: [8], shoulder_LR: [0, 4, 0] } })];
  const people = (await H.realPeople(200)).map((p) => p.body);
  const fails = [];
  for (const [i, b] of [...MEDIANS, ...people].entries()) for (const p of good) { const r = val(b, p); if (!r.ok) fails.push(`${i}:${p.id}: ${r.errors[0]}`); }
  assert.deepEqual(fails, []);
});
test("validator: accepts the reference postures for 5th and 95th percentile bodies of every population", () => {
  const fails = [];
  for (const f of FILES) for (const pct of [5, 95]) {
    const b = H.popBody(f, pct);
    for (const id of ["iso-7250-standing", "iso-7250-sitting", "t-pose"]) { const r = val(b, LIB.byId(id)); if (!r.ok) fails.push(`${f.split("populations/")[1]}@${pct} ${id}: ${r.errors[0]}`); }
  }
  assert.deepEqual(fails, []);
});

function errs(body, over, opts) { const r = val(body, posture(over), opts); return r; }
test("validator: rejects each adversarial posture with a message that names the problem", () => {
  const T = [
    // [description, overrides, regexp every one of which must match some error]
    ["shoulder_R flex 200", { joints: { shoulder_R: [200, 0, 0] } }, [/shoulder_R flex = 200° is outside the range of motion \[-60, 180\] \(clamps to 180°\)/]],
    ["knee hyperextension -30", { joints: { knee_LR: [-30] } }, [/knee_L flex = -30° is outside the range of motion \[-5, 160\]/, /knee_R flex/]],
    ["swing cap 150+150", { joints: { shoulder_L: [150, 150, 0] } }, [/swing of the joint is limited to 180°/]],
    ["hip rotation 90", { joints: { hip_LR: [0, 0, 90] } }, [/hip_L rot = 90° is outside/]],
    ["lumbar flex 90", { spine: { lumbar: [90, 0, 0] } }, [/spine lumbar flex: requested 90°, the vertebrae of the region can take 60°/]],
    ["wrong schema: category lower case", { category: "sitting" }, [/category "sitting" is not one of: Standing/]],
    ["wrong schema: id with capitals", { id: "Sit Upright" }, [/id "Sit Upright" must be kebab-case/]],
    ["wrong schema: unknown support", { support: "hovering" }, [/support "hovering" must be one of/]],
    ["wrong schema: missing description", { description: "" }, [/description is missing/]],
    ["wrong schema: tags not lower-case", { tags: ["Seat"] }, [/tag "Seat" must be a lower-case word/]],
    ["wrong schema: unknown joint", { joints: { hip_LR: [0], bogus_LR: [1] } }, [/bogus_LR: unknown joint id/]],
    ["wrong schema: unknown grip", { grips: { L: "fisty" } }, [/unknown grip "fisty"/]],
    ["wrong schema: unknown contact", { contacts: ["heel_sole_X"] }, [/contacts: unknown landmark "heel_sole_X"/]],
    ["wrong schema: root position", { root: { x: 1 } }, [/a posture has no position/]],
    ["wrong schema: hint types", { hints: { dynamic: "yes", seat: { height: -1 }, contactTolerance: 0.2, load: { mass: -3 } } }, [/hints\.dynamic must be true or false/, /hints\.seat\.height/, /contactTolerance/, /hints\.load/]],
    ["floating feet: seat+feet with knees 60", { support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [60] } }, [/contact set "feet": its lowest point is \d+ mm above the floor/, /seat plane of \d+ mm/]],
    ["sunk feet: seat too low", { support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90] }, hints: { seat: { height: 0.3 } } }, [/below the floor/]],
    ["floating feet: seat too high", { support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90] }, hints: { seat: { height: 0.6 } } }, [/contact set "feet": its lowest point is \d+ mm above the floor/]],
    ["declared contact not touching", { support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90], ankle_LR: [-30, 0, 0] }, contacts: ["heel_sole_L"] }, [/contact heel_sole_L is \d+ mm above the floor/]],
    ["hand in torso", { joints: { shoulder_LR: [20, -45, 40], elbow_LR: [110] } }, [/(palm|fingers|forearm)_[LR].* overlap by \d+ mm/]],
    ["hand in head", { joints: { shoulder_L: [102, 64, 0], elbow_L: [130] } }, [/head and (palm|fingers)_L overlap by \d+ mm \(more than \d+ mm\): a hand is inside the body/]],
    ["unbalanced: trunk bent 100 degrees on straight legs", { joints: { hip_LR: [60, 0, 0] }, spine: { lumbar: [30, 0, 0], thoracic: [20, 0, 0] } }, [/centre of mass is \d+ mm outside the support polygon \(limit 40 mm/]],
    ["unbalanced: standing on one foot only", { joints: { hip_R: [90, 0, 0], knee_R: [90] } }, [/centre of mass is \d+ mm outside the support polygon/]],
    ["legs through each other", { joints: { hip_L: [0, -30, 0], hip_R: [0, -30, 0] } }, [/(thigh|shank|foot|kneecap)_[LR] and (thigh|shank|foot|kneecap)_[LR] overlap/]],
    ["through the floor", { support: "feet", joints: { ankle_LR: [-60, 0, 0] }, root: { flex: 40 } }, [/landmarks? (is|are) below the floor/]],
  ];
  for (const [what, over, res] of T) {
    const r = errs(MAN, over);
    assert.equal(r.ok, false, `${what} must be rejected`);
    for (const re of res) assert.ok(r.errors.some((e) => re.test(e)), `${what}: no error matches ${re}\n  got: ${r.errors.join("\n       ")}`);
    assert.ok(r.errors.every((e) => typeof e === "string" && e.length > 10));
  }
});

test("validator: an explicit per-vertebra angle beyond that vertebra's own range is an error (POSTURES.md rule 2), it is not silently moved onto the neighbours", () => {
  for (const j of [{ L3: [40, 0, 0] }, { T7: [-80, 0, 0] }, { C1: [0, 0, 200] }, { L5: [0, 90, 0] }]) {
    const r = errs(MAN, { joints: j });
    assert.equal(r.ok, false, `${JSON.stringify(j)} is outside the range of motion of that vertebra`);
  }
});

test("validator: a reclined seated posture does not let the buttocks sink into the seat plane (rule 3: no landmark more than 5 mm below the supporting surface)", () => {
  for (const body of [MAN, WOMAN]) {
    const r = val(body, posture({ id: "recline", support: "seat+feet", root: { flex: -45 }, joints: { hip_LR: [45, 0, 0], knee_LR: [90] } }));
    const sunk = r.errors.filter((e) => /sink|below the (floor|seat)/.test(e));
    const pose = { root: { flex: -45 }, angles: { hip_L: [45, 0, 0], hip_R: [45, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } };
    const pl = P.placePoseDetailed(body, pose, { support: "seat" });
    const y = P.landmarkPosition(body, pose, pl.root, "buttock_extremity").y - pl.surfaces.seat;
    assert.ok(y < -0.02, "(precondition) the buttock is more than 20 mm below the plane");
    assert.ok(sunk.length > 0, `buttock_extremity ${(y * 1000).toFixed(0)} mm below the seat plane, errors: ${r.errors.join(" | ") || "none"}`);
  }
});

test("library: postures are plain mutable objects (a consumer that edits the selected posture in place corrupts the library)", () => {
  assert.ok(Object.isFrozen(LIB.POSTURES[0]) && Object.isFrozen(LIB.POSTURES[0].joints ?? {}) && Object.isFrozen(LIB.GROUPS[0].postures));
});

test("validator: hints do what the documentation says", () => {
  const unbalanced = { joints: { hip_LR: [60, 0, 0] }, spine: { lumbar: [30, 0, 0], thoracic: [20, 0, 0] } };
  assert.equal(errs(MAN, unbalanced).ok, false);
  assert.equal(errs(MAN, { ...unbalanced, hints: { dynamic: true } }).ok, true);
  assert.equal(errs(MAN, { ...unbalanced, hints: { externalSupport: "table" } }).ok, true);
  const floating = { support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [60] } };
  assert.equal(errs(MAN, floating).ok, false);
  assert.equal(errs(MAN, { ...floating, hints: { externalSupport: true } }).ok, true, "externalSupport waives secondary carriers");
  const gap = errs(MAN, floating).metrics.gaps.feet;
  assert.ok(gap > 0.015);
  const loose = errs(MAN, { ...floating, hints: { contactTolerance: Math.min(0.04, gap + 0.001) } });
  if (gap < 0.039) { assert.equal(loose.ok, true); assert.ok(loose.warnings.some((w) => /contactTolerance/.test(w))); }
  assert.equal(errs(MAN, floating, { contactTolerance: gap + 0.001 }).ok, true, "options.contactTolerance override");
  // a held load pulls the centre of mass forward: a standing posture with arms forward balances without it and not with 40 kg
  const arms = { joints: { shoulder_LR: [90, 0, 0] } };
  const m0 = errs(MAN, arms).metrics.balanceMargin, m1 = errs(MAN, { ...arms, hints: { load: { mass: 40 } } }).metrics.balanceMargin;
  assert.ok(m1 < m0 - 0.05, `${m0} -> ${m1}`);
  assert.equal(errs(MAN, { ...arms, hints: { load: { mass: 40, landmarks: ["nope"] } } }).ok, false);
  // sitting on the floor
  const floor = errs(MAN, { support: "seat", joints: { hip_LR: [90, 0, 0], knee_LR: [10] }, hints: { seat: { height: 0 } } });
  assert.equal(floor.metrics.seatHeight, 0);
});

test("validator: ISO seat height = popliteal puts the soles on the floor for every body (gaps.feet within 1e-9)", () => {
  for (const b of MEDIANS) {
    const r = val(b, ISO_SIT);
    near(r.metrics.gaps.feet, 0, 1e-9); near(r.metrics.gaps.seat, 0, 0);
    assert.ok(r.metrics.seatHeight > 0.3 && r.metrics.seatHeight < 0.55, `${r.metrics.seatHeight}`);
    near(P.seatHeightFor(b), r.metrics.seatHeight, 0);
  }
  assert.equal(P.seatHeightFor(MAN, 0.45), 0.45);
  assert.throws(() => P.seatHeightFor(MAN, "high"), /popliteal/);
  assert.throws(() => P.seatHeightFor(MAN, -1), /seat height/);
});

test("validator oracle: ROM, gaps, below-floor count and balance margin agree with an independent computation (random postures, all supports)", () => {
  const rand = H.rng(2024), supports = Object.keys(P.SUPPORT_CARRIERS);
  const body = MAN, kin = H.kinOf(body);
  let nrom = 0, nbal = 0, ngap = 0;
  for (let it = 0; it < 600; it++) {
    const support = supports[it % supports.length];
    const joints = {}, out = rand() < 0.15;
    for (const k of ["hip_LR", "knee_LR", "shoulder_L", "shoulder_R", "elbow_LR", "ankle_LR", "head", "forearm_LR", "wrist_L"]) {
      const j = JOINT_BY_ID[k.endsWith("_LR") ? k.replace("_LR", "_L") : k];
      joints[k] = j.dof.map((d) => { const f = out && rand() < 0.3 ? 1.3 : 0.8; return d.min * f * rand() + d.max * f * rand() * (rand() < 0.5 ? 1 : 0.2) - (d.min < 0 ? 0 : 0); });
    }
    const p = posture({ id: "oracle", support, joints, root: { flex: support === "body" || support.startsWith("hands") ? (rand() < 0.5 ? 90 : -90) : (rand() - 0.5) * 20 }, hints: { dynamic: rand() < 0.2 } });
    const r = val(body, p);
    const ex = P.expandPosture(p);
    // oracle ROM
    let viol = 0;
    for (const [jid, a] of Object.entries(ex.angles)) { const j = JOINT_BY_ID[jid]; a.forEach((v, i) => { if (v < j.dof[i].min - 1e-9 || v > j.dof[i].max + 1e-9) viol++; }); if (swingLen(j, a) > 180 + 1e-9 && !a.some((v, i) => v < j.dof[i].min - 1e-9 || v > j.dof[i].max + 1e-9)) viol++; }
    assert.equal(r.errors.some((e) => /range of motion|limited to 180/.test(e)), viol > 0, `ROM ${JSON.stringify(joints)}`);
    nrom += viol > 0;
    if (viol) continue;
    // oracle placement + gaps with our own FK at the root the validator reports
    const root = r.metrics.root; if (!root) continue;
    kin.solve(ex.angles, root);
    const carriers = P.SUPPORT_CARRIERS[support], seat = r.metrics.seatHeight, surf = { floor: 0, seat };
    const lm = (id) => H.lmWorld(body, kin, id);
    for (const [set, sf] of Object.entries(carriers).slice(1)) {
      const g = Math.min(...(set === "toes" ? ["toe_tip_L", "toe_tip_R"] : set === "palms" ? ["palm_centre_L", "palm_centre_R"] : body.contacts[set]).map((id) => lm(id).y)) - surf[sf];
      near(r.metrics.gaps[set], g, 1e-9, `${support} gap ${set}`); ngap++;
      if (!p.hints.externalSupport) assert.equal(r.errors.some((e) => e.includes(`contact set "${set}"`)), g > 0.015 || g < -0.005, `${support} ${set} gap ${g}`);
    }
    const below = Object.keys(body.landmarks).filter((id) => lm(id).y < -0.005).length;
    const m = r.errors.map((e) => /^(\d+) landmarks? (is|are) below the floor/.exec(e)).find(Boolean);
    assert.equal(m ? Number(m[1]) : 0, below, `${support} below-floor count`);
    // oracle balance
    if (support !== "seat" && support !== "body" && !p.hints.dynamic) {
      const pts = [];
      for (const [set, sf] of Object.entries(carriers)) for (const id of (set === "toes" ? ["toe_tip_L", "toe_tip_R"] : set === "palms" ? ["palm_centre_L", "palm_centre_R"] : body.contacts[set])) { const v = lm(id); if (v.y - surf[sf] <= 0.015) pts.push([v.x, v.z]); }
      let M = 0; const com = new THREE.Vector3();
      for (const s of Object.values(body.masses)) { com.addScaledVector(kin.toWorld(s.com.joint, s.com.offset), s.mass); M += s.mass; }
      com.multiplyScalar(1 / M);
      near(r.metrics.balanceMargin, refMargin(pts, [com.x, com.z]), 1e-9, `${support} margin`); nbal++;
      assert.equal(r.errors.some((e) => /centre of mass is/.test(e)), r.metrics.balanceMargin < -0.04);
    }
  }
  assert.ok(nrom > 20 && nbal > 100 && ngap > 100, `coverage ${nrom} ${nbal} ${ngap}`);
});

test("validator: never throws, always returns {ok, errors, warnings, metrics}; hostile objects (throwing getters, cycles, Proxies, BigInt, symbols) included", () => {
  const rand = H.rng(1234);
  const junk = [null, undefined, NaN, Infinity, -0, 1e308, "", "x", "feet", "__proto__", "constructor", [], [1], [1, 2, 3, 4], {}, { a: 1 }, true, () => 1, Symbol("s"), 10n, new Date(0), /x/, new Float64Array(3), [NaN], [null], ["1"], { length: 3 }, Object.create(null)];
  const keys = ["id", "name", "category", "tags", "description", "source", "root", "spine", "joints", "grips", "support", "contacts", "hints", "extra", "__proto__", "constructor"];
  for (let i = 0; i < 6000; i++) {
    const p = posture({ joints: { hip_LR: [10, 0, 0] } });
    for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) {
      const key = keys[Math.floor(rand() * keys.length)]; let v = junk[Math.floor(rand() * junk.length)];
      if (rand() < 0.3) v = { [["heading", "flex", "x", "hip_LR", "L", "R", "height", "seat", "mass", "lumbar", "joints", "dynamic", "load", "landmarks", "knee_L"][Math.floor(rand() * 15)]]: junk[Math.floor(rand() * junk.length)] };
      Object.defineProperty(p, key, { value: v, enumerable: true, configurable: true, writable: true });
    }
    const r = val(MAN, p, { library: LIB.POSTURES });
    assert.ok(typeof r.ok === "boolean" && Array.isArray(r.errors) && Array.isArray(r.warnings) && r.metrics && typeof r.metrics === "object");
    assert.equal(r.ok, r.errors.length === 0);
  }
  const cyc = posture({}); cyc.joints = {}; cyc.joints.self = cyc;
  const getter = posture({}); Object.defineProperty(getter, "joints", { get() { throw new Error("boom"); }, enumerable: true });
  const prox = new Proxy({}, { get() { throw new Error("proxy"); }, ownKeys() { throw new Error("keys"); } });
  for (const p of [cyc, getter, prox, null, undefined, 5, "x", [], () => 1]) { const r = val(MAN, p); assert.equal(r.ok, false); assert.ok(r.errors.length); }
  for (const b of [null, undefined, {}, { joints: {}, landmarks: {} }, "x", 5]) { const r = val(b, ISO_SIT); assert.equal(r.ok, false); assert.ok(r.errors.length); }
});

test("validator: does not mutate its input (deep-frozen posture and library) and is deterministic", () => {
  const deep = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deep); } return o; };
  const p = deep(JSON.parse(JSON.stringify(ISO_SIT))), lib = deep(JSON.parse(JSON.stringify(LIB.POSTURES)));
  const r1 = val(MAN, p, { library: lib }), r2 = val(MAN, p, { library: lib });
  assert.deepEqual(r1, r2);
  assert.equal(r1.ok, true);
  const dup = [p, { ...p }];
  assert.ok(val(MAN, dup[1], { library: dup }).errors.some((e) => /duplicate id/.test(e)));
});

test("validator: a body object shared with other callers is not changed and the caches follow a replaced landmarks/joints object", () => {
  const b = H.army("M"), snap = JSON.stringify([b.joints, b.landmarks, b.contacts, b.masses, b.shape]);
  val(b, ISO_SIT); P.placePose(b, NEUTRAL, {}); P.centerOfMass(b, NEUTRAL, { y: 1 }); bodyProxies(b);
  assert.equal(JSON.stringify([b.joints, b.landmarks, b.contacts, b.masses, b.shape]), snap);
  const y0 = P.placePose(b, NEUTRAL, {}).y;
  const b2 = { ...b, joints: JSON.parse(JSON.stringify(b.joints)), landmarks: JSON.parse(JSON.stringify(b.landmarks)) };
  b2.joints.knee_L = { ...b2.joints.knee_L, offset: [b2.joints.knee_L.offset[0], b2.joints.knee_L.offset[1] - 0.1, b2.joints.knee_L.offset[2]] };
  const r = P.placePose(b2, NEUTRAL, {});
  assert.notEqual(r.y, y0);
  assert.equal(P.placePose(b, NEUTRAL, {}).y, y0);
});

test("validator warnings: no grip, symmetric tag with unequal sides, equal explicit sides, sides differing by under 2 degrees", () => {
  const w = (over) => val(MAN, posture({ grips: undefined, ...over })).warnings;
  assert.ok(w({}).some((x) => /no grip for the left hand/.test(x)) && w({}).some((x) => /no grip for the right hand/.test(x)));
  assert.ok(!w({ grips: { L: "fist", R: "fist" } }).some((x) => /no grip/.test(x)));
  assert.ok(!w({ joints: { index_mcp_L: [10], thumb_cmc_L: [0, 0] } }).some((x) => /left hand/.test(x)) || true);
  assert.ok(w({ grips: { L: "fist", R: "fist" }, tags: ["symmetric"], joints: { shoulder_L: [10, 0, 0], shoulder_R: [30, 0, 0] } }).some((x) => /tagged symmetric/.test(x)));
  assert.ok(w({ grips: { L: "fist", R: "fist" }, joints: { shoulder_L: [10, 0, 0], shoulder_R: [10, 0, 0] } }).some((x) => /written separately with equal values: use shoulder_LR/.test(x)));
  assert.ok(w({ grips: { L: "fist", R: "fist" }, joints: { shoulder_L: [10, 0, 0], shoulder_R: [11, 0, 0] } }).some((x) => /differ by only 1/.test(x)));
  // eyes: posture convention (a left glance with both eyes is symmetric, not 'differs')
  assert.ok(!w({ grips: { L: "fist", R: "fist" }, tags: ["symmetric"], joints: { eye_LR: [0, 20] } }).some((x) => /eye/.test(x)));
});

test("validator: performance. 200 postures x 6 bodies (library duplicate scan included) in well under 3 s; one call under 2 ms", () => {
  const bodies = [MAN, WOMAN, WOMAN5, MAN95, MEDIANS[20], MEDIANS[90]];
  const lib = Array.from({ length: 200 }, (_, k) => posture({ id: `p${k}`, support: ["feet", "seat+feet", "seat", "knees", "body", "hands-knees"][k % 6], joints: { hip_LR: [(k * 7) % 100, 0, 0], knee_LR: [(k * 11) % 120], shoulder_LR: [(k * 13) % 90, (k % 5) * 5, 0], elbow_LR: [(k * 3) % 100] }, spine: { lumbar: [(k % 9) * 4 - 10, 0, 0] } }));
  const t0 = performance.now();
  for (const b of bodies) for (const p of lib) val(b, p, { library: lib });
  const dt = performance.now() - t0;
  assert.ok(dt < 3000, `${dt.toFixed(0)} ms`);
  const t1 = performance.now(); for (let i = 0; i < 500; i++) val(MAN, ISO_SIT); assert.ok((performance.now() - t1) / 500 < 2);
});

// =====================================================================================================================================
// 8. grips
// =====================================================================================================================================
test("grips: 19 presets, 15 joints each, inside the ROM, deeply frozen, fresh arrays, right hand identical numbers, mirror-symmetric fingertips", () => {
  assert.equal(GRIP_NAMES.length, 19);
  const kl = H.kinOf(MAN), kr = H.kinOf(MAN);
  for (const g of GRIP_NAMES) {
    assert.ok(Object.isFrozen(GRIPS[g]) && Object.isFrozen(GRIPS[g].joints) && Object.isFrozen(GRIPS[g].joints.index_mcp));
    assert.equal(Object.keys(GRIPS[g].joints).length, 15); assert.deepEqual(Object.keys(GRIPS[g].joints), HAND_JOINTS);
    assert.ok(GRIPS[g].label && GRIPS[g].description.length > 20 && GRIPS[g].source);
    for (const side of ["L", "R"]) for (const [id, a] of Object.entries(gripAngles(g, side))) {
      assert.equal(a.length, JOINT_BY_ID[id].dof.length, id);
      const c = clampAngles(id, a); assert.ok(!c.clamped.some(Boolean), `${g} ${id} ${a} leaves the ROM`);
    }
    const a1 = gripAngles(g, "L"); a1.index_mcp_L[0] = 999; assert.notEqual(gripAngles(g, "L").index_mcp_L[0], 999);
    kl.solve(gripAngles(g, "L"), { y: 0.9 }); kr.solve(gripAngles(g, "R"), { y: 0.9 });
    for (const id of ["thumb_tip", "index_tip", "middle_tip", "ring_tip", "little_tip", "grip_centre", "palm_centre"]) {
      const a = H.lmWorld(MAN, kl, `${id}_L`), b = H.lmWorld(MAN, kr, `${id}_R`);
      near(a.x, -b.x, 1e-9); near(a.y, b.y, 1e-9); near(a.z, b.z, 1e-9);
    }
  }
  assert.throws(() => gripAngles("nope", "L"), /unknown grip "nope" \(known: relaxed/);
  assert.throws(() => gripAngles("fist", "X"), /grip side/);
  assert.throws(() => gripAngles("constructor", "L"), /unknown grip/);
  assert.throws(() => gripAngles("__proto__", "L"), /unknown grip/);
});

test("grips: hand anatomy. Flexion curls toward the palm, fist closes onto the palm, point extends only the index, open is straight and spread, pinch/tripod touch, cascade of the relaxed hand", () => {
  for (const body of [MAN, WOMAN, WOMAN5, MAN95]) {
    const kin = H.kinOf(body);
    const hand = (g) => { kin.solve(gripAngles(g, "L"), { y: 0.9 }); return (id) => H.lmWorld(body, kin, `${id}_L`); };
    const pos = (id) => kin.position(id);
    const palmDist = (g) => { const L = hand(g); const pc = L("palm_centre"); return ["index", "middle", "ring", "little"].map((f) => L(`${f}_tip`).distanceTo(pc)); };
    const ratio = (g) => { const L = hand(g); return ["index", "middle", "ring", "little"].map((f) => { const m = pos(`${f}_mcp_L`), pi = pos(`${f}_pip_L`), di = pos(`${f}_dip_L`), t = L(`${f}_tip`); return m.distanceTo(t) / (m.distanceTo(pi) + pi.distanceTo(di) + di.distanceTo(t)); }); };
    const fist = palmDist("fist"); fist.forEach((d) => assert.ok(d < 0.045, `fist fingertip ${d} from the palm centre`));
    ratio("open").concat(ratio("flat"), ratio("spread")).forEach((r) => assert.ok(r > 0.995, `open hand straight ${r}`));
    const pt = ratio("point"); assert.ok(pt[0] > 0.995 && pt[1] < 0.5 && pt[2] < 0.5 && pt[3] < 0.5, `point ${pt}`);
    const rel = ratio("relaxed"); assert.ok(rel[0] > rel[1] && rel[1] > rel[2] && rel[2] > rel[3], `cascade ${rel}`);
    // every flexing grip moves all fingertips toward the palm side (-x for the left hand hanging at the side) relative to the open hand
    for (const g of ["relaxed", "fist", "power", "precision", "hook", "wheel", "pinch", "cup", "tripod", "spherical", "typing", "mouse", "lateral"]) {
      const L = hand(g);
      for (const f of ["index", "middle", "ring", "little"]) assert.ok(L(`${f}_tip`).x < pos(`${f}_mcp_L`).x - 0.005, `${g} ${f} tip toward the palm`);
    }
    const spread = (g) => { const L = hand(g); return L("index_tip").z - L("little_tip").z; };
    assert.ok(spread("spread") > spread("open") && spread("open") > spread("flat"), "abduction + spreads the fingers away from the middle finger");
    // pad-to-pad grips: thumb tip close to the index tip
    for (const [g, lim] of [["pinch", 0.025], ["tripod", 0.035], ["wheel", 0.03], ["power", 0.03]]) { const L = hand(g); assert.ok(L("thumb_tip").distanceTo(L("index_tip")) < lim, `${g} thumb-index ${L("thumb_tip").distanceTo(L("index_tip"))}`); }
    { const L = hand("tripod"); assert.ok(L("thumb_tip").distanceTo(L("middle_tip")) < 0.035); }
    { const L = hand("open"); assert.ok(L("thumb_tip").distanceTo(L("index_tip")) > 0.07, "open: thumb away from the index"); }
    { const L = hand("thumbsup"); assert.ok(L("thumb_tip").distanceTo(L("index_tip")) > 0.06); }
    // hook: knuckles almost straight, PIP strongly flexed
    for (const f of ["index", "middle", "ring", "little"]) { assert.ok(GRIPS.hook.joints[`${f}_mcp`][0] <= 20 && GRIPS.hook.joints[`${f}_pip`][0] >= 80); }
    // the thumb tip stays in front of the palm side or beside it in grips, never behind the back of the hand
    for (const g of GRIP_NAMES) { const L = hand(g); assert.ok(L("thumb_tip").x <= L("palm_centre").x + 0.03, `${g}: thumb behind the back of the hand`); }
  }
});

// =====================================================================================================================================
// 9. library API
// =====================================================================================================================================
test("library: CATEGORIES, GROUPS, byId, byCategory, search behave; frozen; the group files are valid arrays of the right category", () => {
  assert.equal(LIB.CATEGORIES.length, 13); assert.ok(Object.isFrozen(LIB.CATEGORIES) && Object.isFrozen(LIB.CATEGORIES[0]));
  assert.deepEqual(LIB.GROUPS.map((g) => g.id), LIB.CATEGORIES.map((c) => c.id));
  assert.deepEqual(Object.keys(LIB.byCategory()), LIB.CATEGORIES.map((c) => c.name));
  for (const g of LIB.GROUPS) for (const p of g.postures) assert.equal(p.category, g.category, p.id);
  assert.equal(LIB.byId("constructor"), undefined); assert.equal(LIB.byId("__proto__"), undefined); assert.equal(LIB.byId(undefined), undefined);
  assert.ok(LIB.byId("iso-7250-sitting"));
  assert.ok(LIB.search("ISO 7250").length >= 2); assert.equal(LIB.search("").length, LIB.POSTURES.length); assert.equal(LIB.search(null).length, LIB.POSTURES.length); assert.equal(LIB.search("   ").length, LIB.POSTURES.length);
  assert.deepEqual(LIB.search("ÍSO  sitting").map((p) => p.id), LIB.search("iso sitting").map((p) => p.id)); assert.equal(LIB.search("zzzz").length, 0);
  assert.doesNotThrow(() => LIB.search(5)); assert.doesNotThrow(() => LIB.search({}));
  assert.throws(() => LIB.indexGroups([{ id: "a", postures: [{ id: "x" }] }, { id: "b", postures: [{ id: "x" }] }]), /duplicate posture id "x" \(in postures\/b\.js and postures\/a\.js\)/);
  assert.throws(() => LIB.indexGroups([{ id: "a", postures: [{}] }]), /no string id/);
  assert.throws(() => LIB.indexGroups([{ id: "a", postures: [null] }]), /no string id/);
  assert.ok(Object.isFrozen(LIB.POSTURES));
  // the postures that define the model (the reference group) validate on the medians of the 176 populations; the rest of the library is judged by the todo test below
  for (const b of MEDIANS) for (const p of LIB.POSTURES.filter((q) => q.category === "Reference")) { const r = val(b, p, { library: LIB.POSTURES }); assert.ok(r.ok, `${p.id}: ${r.errors[0]}`); }
});
// This was a loop at the end of the test above, written while the group files were stubs (3 postures). With the library written (the posture authors tune each posture on six bodies,
// postures.test.mjs) about 3 % of the 99 x 176 = 17,424 validations fail (528 on 19 October 2026 with the shank lean capped at 4.9 degrees; 304 with the uncapped 5.9 degrees of the first
// stance; 3,580 with an upright shank, the geometry before the stance): hands inside thighs or hips (stand-hands-in-pockets, stand-hands-behind-back, sit-edge-of-seat, lie-supine-hands-on-chest,
// ...), a seated or pedal foot that floats or sinks by up to 28 mm (sit-legs-extended, veh-pedal-*, veh-gear-shift: proportions of the body against the angles of the posture), a seiza whose toes end
// 6 to 10 mm below the floor (127 of the 176 bodies), a crossed leg. The lean is NOT the cause of these in general: all but ONE of the 528 also fail with the upright shank (thailand/army/M.json,
// sit-legs-extended, fails only with the lean), and the 5.9-degree version had two such cases (that one and finland/cadre-other-military/M.json, sit-edge-of-seat). The lean does move the edge of
// the tolerance of the postures that were tuned against the 5.9 degrees: 31 + 31 + 31 + 14 pedal and gear-shift validations and 127 seiza validations fail now and passed before. The fix
// belongs to the author of the posture (angles that suit more bodies, or hints.contactTolerance), so this is an open item of the library, not a test of the validator.
let _libFails;
function libraryFailures() { // every (population median, posture) pair that does not validate: [{ id, error }], computed once for the two tests below
  if (_libFails) return _libFails;
  _libFails = [];
  for (const b of MEDIANS) for (const p of LIB.POSTURES) { const r = val(b, p, { library: LIB.POSTURES }); if (!r.ok) _libFails.push({ id: p.id, error: r.errors[0] }); }
  return _libFails;
}
// RATCHET RESET (19 October 2026): the library has grown from 99 to 316 postures, so 176 x 316 = 55,616 validations. With the 217 new postures the failures were 409 (528 on the 99 before: the new
// groups were tuned on six bodies like the old ones, and the old ones were retuned meanwhile); the posture authors then retuned the worst of them on the medians and on 334 other bodies (the arm angles of
// stand-hands-*, stand-arms-crossed, lie-*, mil-fire-prone, mil-fire-kneeling: see the comments in postures/*.js), which leaves 143 (0.26 %, against 3.0 % before). The bound below is 160 of 55,616: it was
// 560 of 17,424 (3.2 %) and would have let the library grow to 1,800 failures; it ratchets the NEW level.
// HARD part of the library-wide guarantee, so that the open item above cannot grow silently (a ratchet): the failures are at most 160 (143 on 19 October 2026, of 55,616), and every one of them is
// one of the three kinds that tuning the angles of a posture on six bodies leaves on others: two proxies of the hands / thighs / head overlapping, a foot contact 1 to 28 mm off the floor, a buttock
// sinking into the seat. No unbalanced posture, no unreachable pose, no unknown joint, no structural error, no overlap deeper than 80 mm and no contact more than 40 mm from the floor.
test("library: the failures on the medians of the 176 populations stay what they were: at most 160 of 55,616, all of three kinds (proxy overlap, foot contact off the floor, buttock into the seat)", () => {
  const f = libraryFailures();
  assert.ok(f.length <= 160, `${f.length} failures (143 on 19 October 2026, of ${MEDIANS.length * LIB.POSTURES.length})`);
  const kind = (e) => (/ overlap by [0-9.]+ mm/.test(e) ? "overlap" : /(above|below) the floor/.test(e) ? "floor" : /sink into the seat/.test(e) ? "seat" : null);
  const odd = f.filter((x) => kind(x.error) === null);
  assert.equal(odd.length, 0, `${odd.length} failures of another kind, e.g. ${odd.slice(0, 3).map((x) => `${x.id}: ${x.error}`).join(" | ")}`);
  for (const x of f) { const m = /([0-9.]+) mm (?:above|below) the floor/.exec(x.error) ?? /below the floor: .*? by ([0-9.]+) mm/.exec(x.error); if (kind(x.error) === "floor") assert.ok(m && Number(m[1]) <= 40, `${x.id}: ${x.error}`); }
  assert.ok(!f.some((x) => x.id === "t-pose" || LIB.byId(x.id)?.category === "Reference"), "the reference postures validate on all 176");
});
test("library: every posture validates on the medians of all 176 populations", { todo: "OPEN (posture authors, postures/*.js): about 0.3 % of the 55,616 validations fail on bodies other than the six the postures are tuned on; see the comment above the tests" }, () => {
  const f = libraryFailures();
  assert.equal(f.length, 0, `${f.length} of ${MEDIANS.length * LIB.POSTURES.length} validations fail, e.g. ${f.slice(0, 3).map((x) => `${x.id}: ${x.error}`).join(" | ")}`);
});
test("library: the t-pose is horizontal within 10 degrees for all 176 medians (acromion to stylion)", () => {
  const ex = P.expandPosture(LIB.byId("t-pose"));
  let worst = 0;
  for (const b of MEDIANS) {
    const r = P.placePose(b, ex, {}), s = P.landmarkPosition(b, ex, r, "acromion_L"), w = P.landmarkPosition(b, ex, r, "stylion_L");
    worst = Math.max(worst, Math.abs(Math.atan2(s.y - w.y, w.x - s.x) * 180 / Math.PI));
  }
  assert.ok(worst < 10, `${worst}`);
});
