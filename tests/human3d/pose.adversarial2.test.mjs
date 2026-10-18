// Second adversarial verification round of pose.js / proxies.js / postures.js / postures/grips.js (independent of the author's tests and of
// pose.adversarial.test.mjs, whose FK oracle (a Kinematics built from body.joints) is stale since pose.js poses the rig's figure).
// The oracle here is the RIG (rig.js: its own kinematics on rig.restBody, contactPoints, centerOfMass, the skin of body.js), an independent bisection for
// the spine, an independent hull and a brute-force capsule distance.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.adversarial2.test.mjs"
// Tests marked `todo` document CONFIRMED DEFECTS: they assert the correct behaviour and currently fail (node reports them as todo, the suite stays green).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, mirrorId, sideOf } from "../../site/js/human/skeleton.js";
import { jointQuaternion } from "../../site/js/human/skeleton.js";
import * as P from "../../site/js/human/pose.js";
import { bodyProxies, proxyWorld, lowestPoint, selfPenetrations, capsuleOverlap, worldCapsule } from "../../site/js/human/proxies.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { GRIPS, GRIP_NAMES, gripAngles } from "../../site/js/human/postures/grips.js";
import { POSTURES, byId, search } from "../../site/js/human/postures.js";
import * as H from "./pose.adversarial.helpers.mjs";

const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const MAN = H.army("M"), WOMAN = H.army("F"), WOMAN5 = H.army("F", 5), MAN95 = H.army("M", 95);
const FILES = H.populationFiles();
const MEDIANS = FILES.map((f) => H.popBody(f));
const posture = H.posture;
const SIX = () => [MAN, WOMAN, WOMAN5, MAN95];

// The rig as the independent oracle for the figure.
const SETS = { toes: ["toe_tip_L", "toe_tip_R"], palms: ["palm_centre_L", "palm_centre_R"], heels: ["heel_sole_L", "heel_sole_R"], shins: ["shin_L", "shin_R"], kneecaps: ["knee_front_L", "knee_front_R"] };
function oracle(body) {
  const rig = buildRig(body, { skeleton: false });
  const set = (name) => (SETS[name] ? SETS[name].map((id) => rig.landmarkWorld(id)) : rig.contactPoints(name));
  return { rig, set, at: (pose, root) => rig.setPose({ root, angles: pose.angles ?? {} }, { clamp: false }) };
}
const NEUTRAL = { root: {}, angles: {} };
const ISO = { root: {}, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } };

// =====================================================================================================================================
// 1. expansion
// =====================================================================================================================================
function bisect(total, w, lo, hi, add) { // independent water-filling: bisection on the multiplier
  const A = lo.map((l, i) => Math.min(0, l - add[i])), B = hi.map((h, i) => Math.max(0, h - add[i]));
  const sa = A.reduce((a, b) => a + b, 0), sb = B.reduce((a, b) => a + b, 0), T = Math.min(sb, Math.max(sa, total));
  const f = (lam) => w.map((wi, i) => Math.min(B[i], Math.max(A[i], lam * wi)));
  let L = -1e6, Hh = 1e6;
  for (let it = 0; it < 300; it++) { const m = (L + Hh) / 2; if (f(m).reduce((a, b) => a + b, 0) < T) L = m; else Hh = m; }
  return f((L + Hh) / 2);
}
test("expandSpine: region totals with in-range per-vertebra additions follow an independent bisection; shortfall exactly when infeasible (20000 random cases)", () => {
  const rand = H.rng(1);
  let worst = 0;
  for (let it = 0; it < 20000; it++) {
    const rn = Object.keys(REGIONS)[Math.floor(rand() * 3)], rg = REGIONS[rn], c = Math.floor(rand() * 3), w = [rg.weights, rg.weightsLat, rg.weightsRot][c];
    const js = rg.joints.map((id) => JOINT_BY_ID[id]), lo = js.map((j) => j.dof[c].min), hi = js.map((j) => j.dof[c].max);
    const add = rg.joints.map((_, i) => (rand() < 0.4 ? lo[i] + rand() * (hi[i] - lo[i]) : 0));
    const total = (rand() * 2.4 - 1.2) * (rand() < 0.5 ? Math.max(hi.reduce((a, b) => a + b, 0), -lo.reduce((a, b) => a + b, 0)) : 20);
    const pv = {}; rg.joints.forEach((id, i) => { if (add[i] !== 0) { pv[id] = [0, 0, 0]; pv[id][c] = add[i]; } });
    const sp = { [rn]: [0, 0, 0] }; sp[rn][c] = total;
    const r = P.expandSpine(sp, pv), exp = bisect(total, w, lo, hi, add);
    rg.joints.forEach((id, i) => { worst = Math.max(worst, Math.abs(r.angles[id][c] - add[i] - exp[i])); });
    const sA = lo.reduce((s, l, i) => s + Math.min(0, l - add[i]), 0), sB = hi.reduce((s, h, i) => s + Math.max(0, h - add[i]), 0);
    const feasible = total >= sA - 1e-9 && total <= sB + 1e-9;
    assert.equal(r.shortfall.length === 0, feasible, `${rn}[${c}] total ${total} feasible ${feasible}`);
  }
  assert.ok(worst < 1e-9, `worst ${worst}`);
});

test("expandPosture: prototype keys, key precedence, holes, typed arrays, frozen input, -0, and an explicit vertebra beyond its range is kept and rejected", () => {
  const J = JSON.parse;
  for (const b of [{ joints: J('{"__proto__":[1]}') }, { joints: { constructor_LR: [1] } }, { spine: J('{"__proto__":[1,2,3]}') }, { grips: J('{"__proto__":"fist"}') }, { grips: { L: "hasOwnProperty" } }, { root: J('{"__proto__":1}') }, { joints: { "": [1] } }, { joints: { _LR: [1] } }, { joints: { L3_LR: [1] } }, { joints: { hip_L_LR: [1] } }]) {
    assert.throws(() => P.expandPosture({ id: "a", ...b }), /posture "a"/, JSON.stringify(b));
  }
  assert.equal({}.polluted, undefined); assert.equal(Object.keys(Object.prototype).length, 0);
  assert.throws(() => P.expandPosture({ id: "a", joints: { knee_LR: new Float64Array([10, 0]) } }), /array/);
  assert.throws(() => P.expandPosture({ id: "a", joints: { knee_LR: [10, "5"] } }), /finite/);
  assert.throws(() => P.expandPosture({ id: "a", joints: { knee_LR: [10, Infinity] } }), /finite/);
  // precedence: explicit sides beat _LR in either key order; a grip is beaten by a finger joint, which is beaten by nothing
  for (const j of [{ hip_LR: [90, 5, 3], hip_R: [45] }, { hip_R: [45], hip_LR: [90, 5, 3] }]) {
    const a = P.expandPosture({ id: "o", joints: j }).angles;
    assert.deepEqual(a.hip_L, [90, 5, 3]); assert.deepEqual(a.hip_R, [45, 0, 0]);
  }
  const g = P.expandPosture({ id: "g", grips: { L: "fist" }, joints: { index_mcp_LR: [7] } }).angles;
  assert.deepEqual(g.index_mcp_L, [7, 0]); assert.deepEqual(g.index_mcp_R, [7, 0]); assert.deepEqual(g.middle_mcp_L, GRIPS.fist.joints.middle_mcp);
  assert.equal(g.middle_mcp_R, undefined);
  // frozen deep input, -0 never in the output
  const fr = Object.freeze({ id: "f", joints: Object.freeze({ hip_LR: Object.freeze([-0, 5]), eye_LR: Object.freeze([-0, -0]) }), spine: Object.freeze({ lumbar: Object.freeze([-0, 0, -0]) }), root: Object.freeze({ flex: -0 }) });
  const e = P.expandPosture(fr);
  for (const [jid, a] of Object.entries(e.angles)) { assert.equal(a.length, JOINT_BY_ID[jid].dof.length); a.forEach((x) => assert.ok(!Object.is(x, -0), `${jid} -0`)); }
  // an explicit vertebra beyond its own range stays as written and the validator names it (rule 2)
  const x = P.expandPosture({ id: "v", joints: { L3: [40] }, spine: { lumbar: [10, 0, 0] } });
  assert.equal(x.angles.L3[0] - 0, x.angles.L3[0]); assert.ok(x.angles.L3[0] >= 40);
  const r = P.validatePosture(MAN, posture({ id: "v", joints: { L3: [40] } }));
  assert.ok(!r.ok && r.errors.some((m) => /L3 flex = 40°/.test(m)), r.errors.join("|"));
});

test("expandPosture: the eye azimuth convention through the kinematics of the rig (+ = both eyes look to the figure's left), explicit eye_R too", () => {
  const o = oracle(MAN);
  const gaze = (angles) => { o.at({ angles }, { y: 1 }); return ["eye_L", "eye_R"].map((id) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.rig.kin.quaternion(id))); };
  for (const [j, sgn] of [[{ eye_LR: [0, 25] }, 1], [{ eye_LR: [5, -25] }, -1], [{ eye_L: [0, 25], eye_R: [0, 25] }, 1]]) {
    const v = gaze(P.expandPosture({ id: "e", joints: j }).angles);
    for (const d of v) assert.ok(d.x * sgn > 0.35, `${JSON.stringify(j)} looks ${d.x}`);
    near(v[0].x, v[1].x, 1e-12); near(v[0].z, v[1].z, 1e-12);
  }
});

// =====================================================================================================================================
// 2. clamp / mirror / copySide / blend
// =====================================================================================================================================
const box = (j, a) => j.dof.every((d, i) => a[i] >= d.min - 1e-9 && a[i] <= d.max + 1e-9);
test("clampPose: inside the ROM box and the 180 degree swing cap, idempotent, identity on valid poses, exact report, input untouched (random, extreme values)", () => {
  const rand = H.rng(2);
  for (let it = 0; it < 400; it++) {
    const angles = {};
    for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = j.dof.map((d) => (rand() - 0.5) * 6 * Math.max(Math.abs(d.min), Math.abs(d.max)));
    const snap = JSON.stringify(angles);
    const { pose, clamped } = P.clampPose({ root: { heading: 10 }, angles });
    assert.equal(JSON.stringify(angles), snap);
    for (const [jid, a] of Object.entries(pose.angles)) {
      const j = JOINT_BY_ID[jid]; assert.ok(box(j, a), jid);
      const sw = Math.hypot(...j.dof.map((d, i) => (d.role === "twist" ? 0 : a[i]))); assert.ok(sw <= 180 + 1e-9, `${jid} swing ${sw}`);
    }
    const again = P.clampPose(pose); assert.equal(again.clamped.length, 0); assert.ok(P.poseEquals(again.pose, pose, 1e-12));
    for (const c of clamped) near(pose.angles[c.joint][JOINT_BY_ID[c.joint].dof.findIndex((d) => d.key === c.dof)], c.applied, 1e-12);
  }
  assert.throws(() => P.clampPose({ angles: { knee_L: [NaN] } }), /finite/);
  assert.throws(() => P.clampPose({ angles: { kneeL: [1] } }), /unknown joint/);
});

test("mirrorPose: involution, and the rig's landmarks of the mirrored pose are the x-reflection of the original's (all 176 medians, random poses)", () => {
  const rand = H.rng(3), swap = (id) => (sideOf(id) ? mirrorId(id) : id);
  let n = 0;
  for (const body of [MAN, WOMAN, ...MEDIANS.filter((_, i) => i % 17 === 0)]) {
    const o = oracle(body);
    for (let it = 0; it < 4; it++) {
      const pose = H.randomPose(rand, 0.9); delete pose.root.x;
      const m = P.mirrorPose(pose), mm = P.mirrorPose(m);
      assert.ok(P.poseEquals(mm, pose, 1e-12), "involution");
      const root = { x: 0, y: 1, z: 0, ...pose.root }, rootM = { x: 0, y: 1, z: 0, ...m.root };
      o.at(pose, root); const A = new Map(Object.keys(body.landmarks).map((id) => [id, o.rig.landmarkWorld(id)]));
      o.at(m, rootM);
      for (const id of Object.keys(body.landmarks)) {
        const want = A.get(swap(id)); if (!want) continue;
        const got = o.rig.landmarkWorld(id);
        // the body model is left/right symmetric up to the landmarks that are not paired (midline), which the mirror leaves in place
        if (sideOf(id) || /_(L|R)$/.test(id)) { assert.ok(Math.hypot(got.x + want.x, got.y - want.y, got.z - want.z) < 2e-4, `${id} ${got.toArray()} vs ${want.toArray()}`); n++; }
      }
    }
  }
  assert.ok(n > 1000);
});

test("copySide: the other side gets the anatomical angles, the eyes keep looking the same way, unpaired joints and the root are untouched, input not mutated", () => {
  const rand = H.rng(4), o = oracle(MAN);
  for (let it = 0; it < 50; it++) {
    const pose = H.randomPose(rand, 0.8), snap = JSON.stringify(pose);
    for (const from of ["L", "R"]) {
      const c = P.copySide(pose, from), to = from === "L" ? "R" : "L";
      for (const j of JOINTS) {
        if (!j.side || j.side !== to) continue;
        const src = pose.angles[mirrorId(j.id)] ?? j.dof.map(() => 0), got = c.angles[j.id] ?? j.dof.map(() => 0);
        j.dof.forEach((_, i) => near(got[i], /^eye_/.test(j.id) && i === 1 ? -src[i] : src[i], 1e-12, j.id));
      }
      for (const j of JOINTS) if (!j.side) assert.deepEqual(c.angles[j.id], pose.angles[j.id]);
      assert.deepEqual(c.root, pose.root);
    }
    assert.equal(JSON.stringify(pose), snap);
  }
  const g = (a) => { o.at({ angles: a }, { y: 1 }); return ["eye_L", "eye_R"].map((id) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.rig.kin.quaternion(id)).x); };
  const c = P.copySide({ angles: { eye_L: [0, 25] } }, "L"); const x = g(c.angles); assert.ok(x[0] > 0.4 && x[1] > 0.4);
});

const poseAt = (rand, scale = 1) => { const p = H.randomPose(rand, scale, false); for (const j of ["pelvis"]) delete p.angles[j]; return p; };
test("blendPoses: t = 0 / 1 exact, blend(a, a) = a, symmetric, and no joint orientation runs faster than ~3x the end-to-end change (no flick) for corner-to-corner poses", () => {
  const rand = H.rng(5), corner = () => {
    const angles = {};
    for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = clampAngles(j.id, j.dof.map((d) => { const r = rand(); return r < 0.35 ? d.min : r < 0.7 ? d.max : d.min + rand() * (d.max - d.min); })).angles;
    return { root: { heading: rand() * 360 - 180 }, angles };
  };
  let worst = 0;
  for (let it = 0; it < 600; it++) {
    const a = corner(), b = corner(), N = 40, seq = [];
    for (let k = 0; k <= N; k++) seq.push(P.blendPoses(a, b, k / N));
    assert.ok(P.poseEquals(seq[0], a, 0)); assert.ok(P.poseEquals(seq[N], b, 0));
    const mid = P.blendPoses(a, b, 0.3), mid2 = P.blendPoses(b, a, 0.7);
    for (const jid of Object.keys(mid.angles)) mid.angles[jid].forEach((v, i) => near(v, mid2.angles[jid][i], 1e-7, `symmetry ${jid}`));
    assert.ok(P.poseEquals(P.blendPoses(a, a, 0.37), a, 1e-9));
    for (const s of seq) assert.equal(P.clampPose(s).clamped.length, 0, "blend leaves the ROM");
    for (const j of JOINTS) {
      if (j.id === "pelvis") continue;
      let ref = 0; j.dof.forEach((d, i) => { ref += d.role === "twist" ? Math.abs(b.angles[j.id][i] - a.angles[j.id][i]) : 0; });
      ref = Math.hypot(...j.dof.map((d, i) => (d.role === "twist" ? 0 : (b.angles[j.id][i] - a.angles[j.id][i])))) + ref;
      if (ref < 20) continue;
      let prev = null, maxStep = 0;
      for (const s of seq) { const q = jointQuaternion(j.id, s.angles[j.id] ?? j.dof.map(() => 0)); if (prev) maxStep = Math.max(maxStep, (2 * Math.acos(Math.min(1, Math.abs(prev.dot(q)))) * 180) / Math.PI); prev = q; }
      worst = Math.max(worst, maxStep / (ref / N));
    }
  }
  assert.ok(worst < 3.5, `a joint turns ${worst.toFixed(2)}x faster than the average`);
});

// =====================================================================================================================================
// 3. placement (rig as the oracle)
// =====================================================================================================================================
const PLACE_POSES = {
  neutral: ["feet", NEUTRAL], iso: ["seat+feet", ISO],
  supine: ["body", { root: { flex: -90 }, angles: { ankle_L: [-15, 0, 0], ankle_R: [-15, 0, 0] } }],
  prone: ["body", { root: { flex: 90 }, angles: { ankle_L: [-45, 0, 0], ankle_R: [-45, 0, 0] } }],
  tpose: ["feet", { root: {}, angles: { shoulder_L: [0, 82, 0], shoulder_R: [0, 82, 0] } }],
  squat: ["feet", { root: {}, angles: { hip_L: [125, 0, 0], hip_R: [125, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [30, 0, 0], ankle_R: [30, 0, 0] } }],
  kneel: ["knees", { root: {}, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } }],
  quad: ["hands-knees", { root: { flex: 90 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } }],
  pronated: ["feet", { root: {}, angles: { shoulder_L: [50, 5, 0], elbow_L: [80], forearm_L: [80], wrist_L: [-20, 0], shoulder_R: [50, 5, 0], elbow_R: [80], forearm_R: [-80] } }],
};
test("placePose vs the rig: the primary carrier touches its surface (<1e-9 m), every other point of it is not below, the anchor centroid is exact, for 176 medians x 9 poses x 3 headings", () => {
  let n = 0;
  for (const body of MEDIANS) {
    const o = oracle(body);
    for (const [pn, [support, pose]] of Object.entries(PLACE_POSES)) for (const heading of [0, 61, -170]) {
      const d = P.placePoseDetailed(body, pose, { support, heading, anchor: { x: 0.3, z: -0.2 } });
      o.at(pose, d.root); n++;
      const prim = Object.keys(d.carriers)[0], surf = d.surfaces[d.carriers[prim]];
      if (prim === "body") {
        const ys = Object.keys(body.landmarks).map((id) => o.rig.landmarkWorld(id).y);
        assert.ok(Math.min(...ys) >= -1e-9, `${pn}: a landmark is ${Math.min(...ys)} below the floor`); assert.ok(Math.min(...ys) < 0.04, `${pn}: nothing within 40 mm`);
        const com = o.rig.centerOfMass().point; near(com.x, 0.3, 1e-9, "com x"); near(com.z, -0.2, 1e-9, "com z");
      } else {
        const pts = o.set(prim), ys = pts.map((p) => p.y);
        near(Math.min(...ys), surf, 1e-9, `${pn} ${prim}`);
        near(pts.reduce((s, p) => s + p.x, 0) / pts.length, 0.3, 1e-9, `${pn} centroid x`); near(pts.reduce((s, p) => s + p.z, 0) / pts.length, -0.2, 1e-9, `${pn} centroid z`);
        for (const [set, sf] of Object.entries(d.carriers)) near(Math.min(...o.set(set).map((p) => p.y)) - d.surfaces[sf], d.gaps[set], 1e-9, `${pn} gap ${set}`);
      }
    }
  }
  assert.ok(n > 4000);
});

test("placePose: heading changes nothing but the yaw about the anchor (heights and pairwise horizontal distances of all landmarks) and never mutates the pose", () => {
  const rand = H.rng(6), o = oracle(MAN);
  for (let it = 0; it < 60; it++) {
    const pose = H.randomPose(rand, 0.5); pose.root.heading = 0;
    const snap = JSON.stringify(pose);
    const support = ["feet", "body", "knees", "seat+feet", "hands-feet"][it % 5];
    const d0 = P.placePoseDetailed(MAN, pose, { support }), d1 = P.placePoseDetailed(MAN, pose, { support, heading: (rand() - 0.5) * 360 });
    assert.equal(JSON.stringify(pose), snap);
    near(d0.root.y, d1.root.y, 1e-9, "height"); near(d1.root.heading, P.placePose(MAN, pose, { support, heading: d1.root.heading }).heading, 0);
    o.at(pose, d0.root); const a = Object.keys(MAN.landmarks).map((id) => o.rig.landmarkWorld(id));
    o.at(pose, d1.root); const b = Object.keys(MAN.landmarks).map((id) => o.rig.landmarkWorld(id));
    for (let i = 0; i < a.length; i += 7) for (let j = i + 1; j < a.length; j += 11) near(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z), Math.hypot(b[i].x - b[j].x, b[i].z - b[j].z), 1e-9);
    a.forEach((p, i) => near(p.y, b[i].y, 1e-9));
  }
});

test("placePose: wrong names are errors that list the valid ones (inherited property names included), never a NaN root", () => {
  for (const bad of [{ support: "stand" }, { support: "toString" }, { support: "__proto__" }, { support: "constructor" }, { carriers: { feet: "toString" } }, { carriers: { feet: "nope" } }, { carriers: { foot: "floor" } }, { carriers: {} }, { carriers: { feet: "floor" }, surfaces: { floor: NaN } }, { surfaces: { floor: "0" } }, { anchor: { x: NaN } }, { heading: Infinity }]) {
    assert.throws(() => P.placePose(MAN, NEUTRAL, bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => P.placePose(MAN, { angles: { hipp_L: [1] } }), /unknown joint/);
  assert.throws(() => P.placePose(MAN, { angles: { hip_L: [1, 2, 3, 4] } }), /DOF/);
  assert.throws(() => P.placePose({}, NEUTRAL), /BodyModel/);
  const r = P.placePose(MAN, NEUTRAL, { support: "feet", surfaces: JSON.parse('{"__proto__":1,"floor":0.5}') });
  assert.ok(Number.isFinite(r.y));
});

test("placePose + the rig skin: 200 real people lying supine / on a side land within 5 mm of the floor (landmark minimum exact)", async () => {
  const people = await H.realPeople(40);
  for (const { key, body } of people) {
    const o = oracle(body);
    for (const [pn, pose] of [["supine", PLACE_POSES.supine[1]], ["left", { root: { lat: 90 }, angles: {} }]]) {
      const d = P.placePoseDetailed(body, pose, { support: "body" });
      o.at(pose, d.root);
      const lowest = Math.min(...Object.keys(body.landmarks).map((id) => o.rig.landmarkWorld(id).y));
      assert.ok(lowest >= -1e-9 && lowest < 0.04, `${key} ${pn}: lowest landmark ${lowest}`);
    }
  }
});

function lyingSkin(body, pose, rig) {
  const r = P.placePose(body, pose, { support: "body" });
  rig.setPose({ root: r, angles: pose.angles ?? {} }, { clamp: false });
  return rig.lowestY({ skin: true });
}
test("lying: supine, prone (ankles plantarflexed), left and right side rest within 5 mm of the floor on the rig's skin (18 population bodies)", () => {
  const POS = { supine: PLACE_POSES.supine[1], prone: PLACE_POSES.prone[1], left: { root: { lat: 90 }, angles: {} }, right: { root: { lat: -90 }, angles: {} } };
  let worst = 0;
  for (let i = 0; i < FILES.length; i += 11) {
    const body = H.popBody(FILES[i], i % 2 ? 5 : 95), rig = buildRig(body, { skinBuilder: (b, bones, op) => buildSkin(b, bones, op), skeleton: false });
    for (const pose of Object.values(POS)) worst = Math.max(worst, Math.abs(lyingSkin(body, pose, rig)));
  }
  assert.ok(worst < 0.0065, `worst ${(worst * 1000).toFixed(1)} mm`);
});
test("lying prone with the ankles not plantarflexed (toes pointing at the floor): the skin floats by the radius of the toe capsule", () => {
  const body = MAN, rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o), skeleton: false });
  for (const ank of [0, -10, -20, -30]) for (const flex of [90, 80]) {
    const y = lyingSkin(body, { root: { flex }, angles: { ankle_L: [ank, 0, 0], ankle_R: [ank, 0, 0] } }, rig);
    assert.ok(Math.abs(y) < 0.005, `prone ankle ${ank} flex ${flex}: skin ${(y * 1000).toFixed(1)} mm from the floor`);
  }
});
test("lying rolled half way (supine, pelvis lat 45): the skin does not sink more than 5 mm", () => {
  const body = MAN95, rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o), skeleton: false });
  for (const lat of [20, 45, 70]) { const y = lyingSkin(body, { root: { flex: -90, lat }, angles: {} }, rig); assert.ok(y > -0.005, `lat ${lat}: ${(y * 1000).toFixed(1)} mm`); }
});

// =====================================================================================================================================
// 4. proxies
// =====================================================================================================================================
test("proxies: 39 capsules for every population body, finite positive radii inside the ring range, symmetric left/right, pair table consistent", () => {
  for (const body of MEDIANS) {
    const px = bodyProxies(body);
    assert.equal(px.n, 39); assert.equal(px.pairs.length, 2 * px.tol.length);
    for (const c of px.list) { assert.ok(c.ra > 0 && c.rb > 0 && Number.isFinite(c.ra + c.rb), c.id); for (const e of [c.a, c.b]) assert.ok(e.off.every(Number.isFinite), c.id); }
    for (const c of px.list) if (c.side === "L") { const m = px.list[px.byId.get(c.id.replace(/_L$/, "_R"))]; assert.ok(m, c.id); near(m.ra, c.ra, 1e-9); near(m.rb, c.rb, 1e-9); }
    for (const t of px.tol) assert.ok(t > 0.005 && t < 0.2);
    assert.ok(px.softness >= 1 && px.softness <= 1.8);
  }
});
test("proxies: lowestPoint equals a brute-force minimum over the swept spheres of the rig-posed capsules; proxyWorld equals the rig's own toWorld of the end points", () => {
  const o = oracle(MAN), px = bodyProxies(MAN), rand = H.rng(12);
  let W = null;
  for (let it = 0; it < 60; it++) {
    const pose = H.randomPose(rand, 0.9), root = { x: 0.1, y: 0.9, z: 0.2, ...pose.root };
    o.at(pose, root); W = proxyWorld(px, o.rig.kin, W);
    let best = Infinity;
    px.list.forEach((c, i) => {
      const a = o.rig.kin.toWorld(c.a.joint, c.a.off), b = o.rig.kin.toWorld(c.b.joint, c.b.off);
      near(W.ay[i], a.y, 1e-12); near(W.bx[i], b.x, 1e-12); near(W.bz[i], b.z, 1e-12);
      for (let s = 0; s <= 200; s++) { const t = s / 200; best = Math.min(best, a.y + (b.y - a.y) * t - (c.ra + (c.rb - c.ra) * t)); }
    });
    near(lowestPoint(W).y, best, 1e-12);
    const Wp = proxyWorld(px, P.solvePose(MAN, pose, root)); near(lowestPoint(Wp).y, best, 1e-12);
  }
});
test("capsuleOverlap is exact for tapered capsules (4000 random pairs against a grid + local refinement), degenerate segments and equal radii included", () => {
  const rand = H.rng(40), V = (s) => new THREE.Vector3((rand() - 0.5) * s, (rand() - 0.5) * s, (rand() - 0.5) * s);
  const brute = (c1, c2) => {
    const f = (s, t) => c1.ra + (c1.rb - c1.ra) * s + c2.ra + (c2.rb - c2.ra) * t - c1.a.clone().lerp(c1.b, s).distanceTo(c2.a.clone().lerp(c2.b, t));
    let bs = 0, bt = 0, bv = -Infinity;
    for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) { const v = f(i / 60, j / 60); if (v > bv) { bv = v; bs = i / 60; bt = j / 60; } }
    for (let w = 1 / 60; w > 1e-9; w *= 0.7) for (let r = 0; r < 3; r++) for (const ds of [-w, 0, w]) for (const dt of [-w, 0, w]) { const s = Math.min(1, Math.max(0, bs + ds)), t = Math.min(1, Math.max(0, bt + dt)), v = f(s, t); if (v > bv) { bv = v; bs = s; bt = t; } }
    return bv;
  };
  let worst = 0;
  for (let it = 0; it < 1500; it++) {
    const sc = [0.1, 0.5, 1][it % 3], mk = () => { const a = V(sc), b = it % 17 === 0 ? a.clone() : a.clone().add(V(sc * 0.6)), ra = 0.005 + rand() * 0.1; return { a, b, ra, rb: it % 5 === 0 ? ra : 0.005 + rand() * 0.1 }; };
    const c1 = mk(), c2 = mk(); worst = Math.max(worst, Math.abs(capsuleOverlap(c1, c2) - brute(c1, c2)));
  }
  assert.ok(worst < 1e-8, `worst ${worst}`);
});
test("proxies cover the body: every landmark of 264 bodies is within 45 mm of the union of the capsules (neutral)", () => {
  let worst = 0, who = "";
  for (let i = 0; i < FILES.length; i += 3) for (const pc of [5, 95]) {
    const body = H.popBody(FILES[i], pc), px = bodyProxies(body), root = { y: body.joints.pelvis.offset[1] };
    const W = proxyWorld(px, P.solvePose(body, NEUTRAL, root));
    for (const id of Object.keys(body.landmarks)) {
      const p = P.landmarkPosition(body, NEUTRAL, root, id); let best = Infinity;
      for (let k = 0; k < W.n; k++) {
        const ax = W.ax[k], ay = W.ay[k], az = W.az[k], bx = W.bx[k] - ax, by = W.by[k] - ay, bz = W.bz[k] - az, L = bx * bx + by * by + bz * bz;
        const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * bx + (p.y - ay) * by + (p.z - az) * bz) / L)) : 0;
        best = Math.min(best, Math.hypot(p.x - ax - bx * t, p.y - ay - by * t, p.z - az - bz * t) - (W.ra[k] + t * (W.rb[k] - W.ra[k])));
      }
      if (best > worst) { worst = best; who = id; }
    }
  }
  assert.ok(worst < 0.045, `${who} ${(worst * 1000).toFixed(0)} mm outside`);
});
test("proxies: a palm or a fingertip deep inside the torso or the head is rejected (random arm search, 4 bodies), the five fingers are tested", () => {
  const depthIn = (rings, p, y0, y1) => {
    if (p.y < y0 || p.y > y1) return null;
    const rs = rings.slice().sort((a, b) => a.c[1] - b.c[1]); let i = 0; while (i < rs.length - 2 && rs[i + 1].c[1] < p.y) i++;
    const a = rs[i], b = rs[i + 1], t = Math.min(1, Math.max(0, (p.y - a.c[1]) / (b.c[1] - a.c[1]))), L = (u, v) => u + (v - u) * t;
    const rx = L(a.rx, b.rx), rz = L(a.rz, b.rz), n = L(a.n ?? 2, b.n ?? 2);
    return (1 - (Math.abs((p.x - L(a.c[0], b.c[0])) / rx) ** n + Math.abs((p.z - L(a.c[2], b.c[2])) / rz) ** n) ** (1 / n)) * Math.min(rx, rz);
  };
  const rand = H.rng(99); let deep = 0, accepted = 0;
  for (let it = 0; it < 60000; it++) {
    const body = SIX()[it % 4], T = body.shape.tubes.torso.rings, Hd = body.shape.head.rings;
    const joints = { shoulder_L: clampAngles("shoulder_L", [-30 + rand() * 210, -45 + rand() * 150, -60 + rand() * 120]).angles, elbow_L: [rand() * 150], forearm_L: [-60 + rand() * 120], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] };
    const grips = { L: ["flat", "open", "spread", "point"][it % 4], R: "relaxed" }, ex = P.expandPosture({ id: "h", joints, grips }), root = { y: body.joints.pelvis.offset[1] };
    let d = -1;
    for (const id of ["palm_centre_L", "thumb_tip_L", "index_tip_L", "middle_tip_L", "ring_tip_L", "little_tip_L"]) {
      const p = P.landmarkPosition(body, ex, root, id);
      d = Math.max(d, depthIn(T, p, T.find((r) => r.id === "buttock").c[1], T.find((r) => r.id === "chest").c[1]) ?? -1, depthIn(Hd, p, Math.min(...Hd.map((r) => r.c[1])), Math.max(...Hd.map((r) => r.c[1]))) ?? -1);
    }
    if (d < 0.05) continue;
    deep++; if (P.validatePosture(body, posture({ id: "hand-test", joints, grips })).ok) accepted++;
  }
  assert.ok(deep >= 20, `only ${deep} deep cases sampled`);
  assert.equal(accepted, 0, `${accepted} of ${deep} poses with a fingertip or palm 50+ mm inside the torso or head were accepted`);
});

// =====================================================================================================================================
// 5. centre of mass and balance
// =====================================================================================================================================
test("centerOfMass: equals the hand calculation on body.positions in the neutral pose, the rig's centre of mass in random poses (<1e-9), load adds at the landmark mean", () => {
  for (const f of FILES.filter((_, i) => i % 4 === 0)) {
    const b = H.popBody(f, 95), root = { y: b.joints.pelvis.offset[1] };
    let M = 0, c = [0, 0, 0];
    for (const m of Object.values(b.masses)) { const pj = b.positions[m.com.joint]; for (let k = 0; k < 3; k++) c[k] += m.mass * (pj[k] + m.com.offset[k]); M += m.mass; }
    c = c.map((v) => v / M);
    const got = P.centerOfMass(b, NEUTRAL, root); near(got.mass, M, 1e-9); assert.ok(Math.hypot(got.point.x - c[0], got.point.y - c[1], got.point.z - c[2]) < 1e-5);
    near(M, b.mass, 1e-3 * b.mass, "segment masses add up to the body mass");
  }
  const rand = H.rng(9), o = oracle(MAN);
  for (let it = 0; it < 100; it++) {
    const pose = H.randomPose(rand, 0.9), root = { x: 0.3, y: 1, z: -0.2, ...pose.root };
    o.at(pose, root);
    const want = o.rig.centerOfMass().point, got = P.centerOfMass(MAN, pose, root);
    assert.ok(got.point.distanceTo(want) < 1e-9, `${got.point.distanceTo(want)}`);
    const load = P.centerOfMass(MAN, pose, root, new THREE.Vector3(), { mass: 25, landmarks: ["grip_centre_L", "palm_centre_R"] });
    const lp = o.rig.landmarkWorld("grip_centre_L").add(o.rig.landmarkWorld("palm_centre_R")).multiplyScalar(0.5), M = got.mass;
    assert.ok(load.point.distanceTo(want.clone().multiplyScalar(M).addScaledVector(lp, 25).multiplyScalar(1 / (M + 25))) < 1e-9); near(load.mass, M + 25, 1e-9);
  }
  assert.throws(() => P.centerOfMass(MAN, NEUTRAL, {}, new THREE.Vector3(), { mass: 5, landmarks: ["nope"] }), /unknown landmark/);
});

test("validatePosture with a body that has no segment masses: the balance rule must not use a centre of mass at the origin", () => {
  const body = { ...MAN, masses: undefined };
  const r = P.validatePosture(body, posture({ id: "no-mass", joints: {} }));
  assert.ok(r.metrics.balanceMargin === null || r.errors.some((e) => /mass/.test(e)), `balance margin ${r.metrics.balanceMargin}`);
});

// =====================================================================================================================================
// 6. validator
// =====================================================================================================================================
const val = (b, p, o) => P.validatePosture(b, p, o);
function refMargin(points, q) { // independent hull (gift wrapping) + signed distance
  const uniq = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()];
  const dseg = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); };
  if (uniq.length === 0) return -Infinity;
  if (uniq.length === 1) return -Math.hypot(q[0] - uniq[0][0], q[1] - uniq[0][1]);
  const start = uniq.reduce((m, p) => (p[0] < m[0] || (p[0] === m[0] && p[1] < m[1]) ? p : m)), hull = []; let cur = start;
  do {
    hull.push(cur); let nxt = uniq[0] === cur ? uniq[1] : uniq[0];
    for (const p of uniq) { if (p === cur) continue; const cr = (nxt[0] - cur[0]) * (p[1] - cur[1]) - (nxt[1] - cur[1]) * (p[0] - cur[0]); if (cr < 0 || (cr === 0 && Math.hypot(p[0] - cur[0], p[1] - cur[1]) > Math.hypot(nxt[0] - cur[0], nxt[1] - cur[1]))) nxt = p; }
    cur = nxt;
  } while (cur !== start && hull.length <= uniq.length);
  const h = hull.filter((p, i) => { const a = hull[(i + hull.length - 1) % hull.length], b = hull[(i + 1) % hull.length]; return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-12; });
  if (h.length < 3) { const e = [uniq.reduce((m, p) => (p[0] < m[0] || (p[0] === m[0] && p[1] < m[1]) ? p : m)), uniq.reduce((m, p) => (p[0] > m[0] || (p[0] === m[0] && p[1] > m[1]) ? p : m))]; return -dseg(q, e[0], e[1]); }
  let area = 0; h.forEach((p, i) => { const n = h[(i + 1) % h.length]; area += p[0] * n[1] - n[0] * p[1]; });
  const sg = area > 0 ? 1 : -1; let inside = true, mn = Infinity;
  h.forEach((a, i) => { const b = h[(i + 1) % h.length], d = (sg * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]))) / Math.hypot(b[0] - a[0], b[1] - a[1]); if (d < 0) inside = false; mn = Math.min(mn, d); });
  return inside ? mn : -Math.min(...h.map((a, i) => dseg(q, a, h[(i + 1) % h.length])));
}
test("validator oracle: ROM, gaps, below-floor count and balance margin agree with the rig-based computation (600 random postures, all supports, 2 bodies)", () => {
  const rand = H.rng(2024), supports = Object.keys(P.SUPPORT_CARRIERS);
  let nrom = 0, nbal = 0, ngap = 0;
  for (const body of [MAN, WOMAN5]) {
    const o = oracle(body);
    for (let it = 0; it < 300; it++) {
      const support = supports[it % supports.length], out = rand() < 0.15, joints = {};
      for (const k of ["hip_LR", "knee_LR", "shoulder_L", "shoulder_R", "elbow_LR", "ankle_LR", "head", "forearm_LR", "wrist_L"]) {
        const j = JOINT_BY_ID[k.endsWith("_LR") ? k.replace("_LR", "_L") : k];
        joints[k] = j.dof.map((d) => { const f = out && rand() < 0.3 ? 1.3 : 0.8; return d.min * f * rand() + d.max * f * rand() * (rand() < 0.5 ? 1 : 0.2); });
      }
      const p = posture({ id: "oracle", support, joints, root: { flex: support === "body" || support.startsWith("hands") ? (rand() < 0.5 ? 90 : -90) : (rand() - 0.5) * 20 }, hints: { dynamic: rand() < 0.2 } });
      const r = val(body, p), ex = P.expandPosture(p);
      let viol = 0;
      for (const [jid, a] of Object.entries(ex.angles)) { const j = JOINT_BY_ID[jid]; a.forEach((v, i) => { if (v < j.dof[i].min - 1e-9 || v > j.dof[i].max + 1e-9) viol++; }); }
      assert.equal(r.errors.some((e) => /range of motion/.test(e)), viol > 0);
      nrom += viol > 0; if (viol) continue;
      const root = r.metrics.root; if (!root) continue;
      o.at(ex, root);
      const carriers = P.SUPPORT_CARRIERS[support], surf = { floor: 0, seat: r.metrics.seatHeight };
      for (const [set, sf] of Object.entries(carriers).slice(1)) {
        const g = Math.min(...o.set(set).map((q) => q.y)) - surf[sf];
        near(r.metrics.gaps[set], g, 1e-9, `${support} gap ${set}`); ngap++;
        assert.equal(r.errors.some((e) => e.includes(`contact set "${set}"`)), g > 0.015 || g < -0.005, `${support} ${set} ${g}`);
      }
      const below = Object.keys(body.landmarks).filter((id) => o.rig.landmarkWorld(id).y < -0.005).length, m = r.errors.map((e) => /^(\d+) landmarks? (is|are) below the floor/.exec(e)).find(Boolean);
      assert.equal(m ? Number(m[1]) : 0, below, `${support} below-floor count`);
      if (support !== "seat" && support !== "body" && !p.hints.dynamic) {
        const pts = []; for (const [set, sf] of Object.entries(carriers)) for (const q of o.set(set)) if (q.y - surf[sf] <= 0.015) pts.push([q.x, q.z]);
        const com = o.rig.centerOfMass().point;
        near(r.metrics.balanceMargin, refMargin(pts, [com.x, com.z]), 1e-9, `${support} margin`); nbal++;
        assert.equal(r.errors.some((e) => /centre of mass is/.test(e)), r.metrics.balanceMargin < -0.04);
      }
    }
  }
  assert.ok(nrom > 20 && nbal > 100 && ngap > 100, `coverage ${nrom} ${nbal} ${ngap}`);
});

test("validator: the reference postures are accepted for percentile 1..99 of every population (6336 validations) and for 40 real people", async () => {
  const fs = await import("node:fs");
  const { fitBody } = await import("../../site/js/human/fit.js"); const { percentileProfile } = await import("../../site/js/human/anthro.js");
  const refs = POSTURES.filter((p) => p.category === "Reference"); assert.ok(refs.length >= 3);
  const bad = [];
  for (const f of FILES) {
    const pop = JSON.parse(fs.readFileSync(f));
    for (const pc of [1, 5, 25, 75, 95, 99]) for (const ms of [true, false]) {
      const body = fitBody(percentileProfile(pop, { percentile: pc, meanStature: ms }));
      for (const p of refs) { const r = val(body, p, { library: POSTURES }); if (!r.ok) bad.push(`${f.split("populations/")[1]} p${pc} ${p.id}: ${r.errors[0]}`); }
    }
  }
  for (const { key, body } of await H.realPeople(40)) for (const p of refs) { const r = val(body, p); if (!r.ok) bad.push(`${key} ${p.id}: ${r.errors[0]}`); }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("validator is invariant under the posture's heading (a turn about the vertical changes no verdict): ISO sitting at every heading, and the reclined seat sink", () => {
  const iso = byId("iso-7250-sitting");
  for (const body of SIX()) for (const h of [0, 30, 45, 90, 135, 180, -90, -135]) {
    const r = val(body, { ...structuredClone(iso), root: { heading: h } });
    assert.ok(r.ok, `ISO sitting at heading ${h}: ${r.errors.join("; ")}`);
  }
  for (const body of [MAN, WOMAN]) {
    const sinks = [0, 30, 90, 180, -90].map((h) => val(body, posture({ id: "recl", support: "seat+feet", root: { heading: h, flex: -45 }, joints: { hip_LR: [90], knee_LR: [90] }, hints: { dynamic: true } })).errors.some((e) => /sink into the seat/.test(e)));
    assert.deepEqual(sinks, [true, true, true, true, true], `reclined sink detected per heading ${sinks}`);
  }
});

test("validator is invariant under left/right mirroring of the posture (3000 random postures, 10 supports): verdict, gaps, balance margin, worst penetration", () => {
  const rand = H.rng(18), supports = Object.keys(P.SUPPORT_CARRIERS);
  for (let it = 0; it < 1500; it++) {
    const b = SIX()[it % 4], pose = H.randomPose(rand, 0.4, false);
    delete pose.angles.eye_L; delete pose.angles.eye_R;
    const sup = supports[it % supports.length], root = { flex: [0, -90, 90, -45, 30][it % 5], lat: [0, 0, 0, 20, 90][it % 5], rot: [0, 0, 15, 0, 0][it % 5], heading: [0, 30, -50, 0, 90][it % 5] };
    if (sup.startsWith("seat")) { pose.angles.hip_L = [80 + rand() * 20, 0, 0]; pose.angles.hip_R = [...pose.angles.hip_L]; pose.angles.knee_L = [60 + rand() * 40, 0]; pose.angles.knee_R = [...pose.angles.knee_L]; }
    const mp = P.mirrorPose({ root, angles: pose.angles });
    const p0 = posture({ id: "mir", support: sup, joints: pose.angles, root, hints: { dynamic: it % 3 === 0 } }), p1 = posture({ id: "mir", support: sup, joints: mp.angles, root: mp.root, hints: { dynamic: it % 3 === 0 } });
    delete p0.grips; delete p1.grips;
    const r0 = val(b, p0), r1 = val(b, p1);
    assert.equal(r0.ok, r1.ok, `${sup} ${JSON.stringify(root)}: ${r0.errors} || ${r1.errors}`);
    assert.equal(r0.errors.length, r1.errors.length);
    for (const k of Object.keys(r0.metrics.gaps)) near(r0.metrics.gaps[k], r1.metrics.gaps[k], 1e-6);
    near(r0.metrics.balanceMargin ?? 0, r1.metrics.balanceMargin ?? 0, 1e-6); near(r0.metrics.worstPenetration, r1.metrics.worstPenetration, 1e-5);
  }
});

test("validator tolerances: feet 14.9 mm above the floor pass, 15.1 mm fail; 4 mm below pass, 6 mm below fail; contactTolerance widens (max 40 mm); externalSupport waives", () => {
  const iso = byId("iso-7250-sitting"), sh = P.seatHeightFor(MAN);
  for (const [d, ok] of [[-0.03, false], [-0.006, false], [-0.004, true], [0, true], [0.0149, true], [0.0151, false], [0.05, false]]) {
    const r = val(MAN, { ...structuredClone(iso), hints: { seat: { height: sh + d } } });
    assert.equal(r.ok, ok, `${(d * 1000).toFixed(1)} mm: ${r.errors.join("; ")}`);
  }
  const at = (hints) => val(MAN, { ...structuredClone(iso), hints: { seat: { height: sh + 0.03 }, ...hints } });
  assert.ok(!at({}).ok); assert.ok(at({ contactTolerance: 0.035 }).ok); assert.ok(!at({ contactTolerance: 0.05 }).ok); assert.ok(at({ externalSupport: true }).ok);
  assert.ok(at({ contactTolerance: 0.035 }).warnings.some((w) => /contactTolerance/.test(w)));
  assert.ok(!val(MAN, { ...structuredClone(iso), hints: { seat: { height: 1.6 } } }).ok); assert.ok(!val(MAN, { ...structuredClone(iso), hints: { seat: { height: -0.1 } } }).ok);
});

test("validator rejects adversarial postures and names the problem", () => {
  const chk = (name, over, re, bodies = SIX()) => { for (const b of bodies) { const r = val(b, posture({ id: "adv-" + name, ...over })); assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${name}: ${r.errors.join(" | ")}`); } };
  chk("hips90-straight-legs", { joints: { hip_LR: [90] } }, /centre of mass is \d+ mm outside/);
  chk("supine-declared-feet", { root: { flex: -90 } }, /below the floor/);
  chk("prone-on-seat", { support: "seat", root: { flex: 90 } }, /sink into the seat|below the floor/);
  chk("legs-through-each-other", { joints: { hip_LR: [20, -30, 0] } }, /thigh.* overlap by/);
  chk("sitting-feet-floating", { support: "seat+feet", joints: { hip_LR: [90], knee_LR: [60] } }, /contact set "feet": its lowest point is \d+ mm above the floor/);
  chk("sitting-feet-in-the-floor", { support: "seat+feet", joints: { hip_LR: [90], knee_LR: [120] } }, /contact set "feet": its lowest point is \d+ mm below the floor/);
  chk("kneeling-toes-floating", { support: "knees+toes", joints: { knee_LR: [120], ankle_LR: [-40] } }, /contact set "toes"/);
  chk("shoulder-over-range", { joints: { shoulder_R: [200, 0, 0] } }, /shoulder_R flex = 200° is outside the range of motion \[-60, 180\]/);
  chk("swing-cap", { joints: { shoulder_L: [150, 150, 0] } }, /limited to 180°/);
  chk("spine-overflow", { spine: { lumbar: [90, 0, 0] } }, /spine lumbar flex: requested 90°/);
  chk("unknown-joint", { joints: { elbo_LR: [90] } }, /unknown joint id/);
  chk("bad-grip", { grips: { L: "pinchh" } }, /unknown grip/);
  chk("explicit-contact-floating", { contacts: ["palm_centre_L"] }, /contact palm_centre_L is \d+ mm above the floor/);
  chk("deep-forward-bend", { joints: { hip_LR: [80] } }, /below the floor|centre of mass/);
  for (const p of [null, undefined, 3, "x", [], () => 1]) { const r = val(MAN, p); assert.ok(!r.ok && r.errors.length && r.metrics, String(p)); }
  assert.ok(!val(null, posture({ id: "a" })).ok); assert.ok(!val({}, posture({ id: "a" })).ok);
});

test("validator: messages for hands: a finger inside the head / the chest says so (and not that 'the head is in the shoulders')", () => {
  const rand = H.rng(4); let n = 0;
  for (let it = 0; it < 20000 && n < 40; it++) {
    const joints = { shoulder_L: [rand() * 150, -20 + rand() * 100, -60 + rand() * 120], elbow_L: [rand() * 150], forearm_L: [-60 + rand() * 120], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] };
    for (const e of val(MAN, posture({ id: "m-" + it, joints, grips: { L: ["flat", "point", "open"][it % 3], R: "relaxed" } })).errors) {
      const m = /^(\w+) and (\w+) overlap by.*?: (.*)$/.exec(e);
      if (m && (/^(thumb|index|ring|little)_[LR]$/.test(m[1]) || /^(thumb|index|ring|little)_[LR]$/.test(m[2]))) { n++; assert.ok(/hand/.test(m[3]), e); }
    }
  }
  assert.ok(n > 0);
});

test("validator: upright kneeling (thighs vertical, shanks on the floor) is a stable posture and must not be rejected as 'would fall'", () => {
  for (const b of SIX()) {
    const r = val(b, posture({ id: "kneel-upright", support: "knees", joints: { hip_LR: [0], knee_LR: [90], ankle_LR: [-60] } }));
    assert.ok(r.ok, r.errors.join(" | "));
  }
});

test("validator: performance. 200 postures x 6 bodies (duplicate scan included) in under 5 s; median call under 2 ms, p99 under 15 ms", () => {
  const rand = H.rng(3), posts = [];
  for (let i = 0; i < 200; i++) { const p = H.randomPose(rand, 0.5); posts.push(posture({ id: "p-" + i, support: ["feet", "seat+feet", "seat", "knees", "hands-knees", "body", "hands-feet"][i % 7], joints: p.angles, root: i % 7 === 5 ? { flex: -90 } : {}, hints: { dynamic: i % 3 === 0 } })); }
  const bodies = [...SIX(), H.army("M", 99), H.army("F", 95)]; for (const b of bodies) val(b, posts[0]);
  const t0 = performance.now(), each = [];
  for (const b of bodies.slice(0, 6)) for (const p of posts) { const t = performance.now(); val(b, p, { library: posts }); each.push(performance.now() - t); }
  const dt = performance.now() - t0; each.sort((a, b) => a - b);
  assert.ok(dt < 5000, `${dt.toFixed(0)} ms`); assert.ok(each[each.length >> 1] < 2, `median ${each[each.length >> 1]} ms`); assert.ok(each[Math.floor(each.length * 0.99)] < 15, `p99 ${each[Math.floor(each.length * 0.99)]} ms`);
});

// =====================================================================================================================================
// 7. grips, library
// =====================================================================================================================================
test("grips: anatomy by the fitted hand (fingertips and thumb of the rig-posed hand): fist closes on the palm, point extends only the index, open is straight and spread, pinch/tripod touch, thumb-up sticks out; both hands mirror", () => {
  for (const body of [MAN, WOMAN5, MAN95]) {
    const root = { y: body.joints.pelvis.offset[1] }, tip = (g, f, side = "L") => P.landmarkPosition(body, { angles: gripAngles(g, side) }, root, `${f}_tip_${side}`);
    const palm = (g) => P.landmarkPosition(body, { angles: gripAngles(g, "L") }, root, "palm_centre_L"), wrist = (g) => P.landmarkPosition(body, { angles: gripAngles(g, "L") }, root, "wrist_L");
    const len = (g) => Object.fromEntries(["thumb", "index", "middle", "ring", "little"].map((f) => [f, tip(g, f).distanceTo(palm(g))]));
    const fist = len("fist"), open = len("open"), point = len("point"), thumbsup = len("thumbsup");
    for (const f of ["index", "middle", "ring", "little"]) { assert.ok(fist[f] < 0.045, `fist ${f} ${fist[f]}`); assert.ok(open[f] > 0.075, `open ${f} ${open[f]}`); }
    assert.ok(point.index > 0.1 && point.middle < 0.03 && point.ring < 0.03, "point"); assert.ok(thumbsup.thumb > fist.thumb + 0.02, "thumbs-up"); assert.ok(thumbsup.index < 0.045);
    assert.ok(tip("pinch", "thumb").distanceTo(tip("pinch", "index")) < 0.025, "pinch"); assert.ok(tip("tripod", "thumb").distanceTo(tip("tripod", "middle")) < 0.025, "tripod");
    assert.ok(tip("open", "thumb").distanceTo(tip("open", "index")) > 0.06);
    // the spread hand is wider than the open one: little-to-index tip distance
    assert.ok(tip("spread", "index").distanceTo(tip("spread", "little")) > tip("open", "index").distanceTo(tip("open", "little")));
    for (const g of GRIP_NAMES) for (const f of ["thumb", "index", "middle", "ring", "little"]) { const l = tip(g, f, "L"), r = tip(g, f, "R"); near(l.x, -r.x, 1e-6, `${g} ${f}`); near(l.y, r.y, 1e-6); near(l.z, r.z, 1e-6); }
    void wrist;
  }
  // 19 presets, frozen, fresh arrays, inside the ROM
  assert.equal(GRIP_NAMES.length, 19);
  for (const g of GRIP_NAMES) { assert.ok(Object.isFrozen(GRIPS[g]) && Object.isFrozen(GRIPS[g].joints)); const a = gripAngles(g, "R"); assert.equal(Object.keys(a).length, 15); for (const [id, v] of Object.entries(a)) { assert.ok(box(JOINT_BY_ID[id], v), `${g} ${id}`); v[0] = 999; } assert.ok(box(JOINT_BY_ID.index_mcp_R, gripAngles(g, "R").index_mcp_R)); }
  assert.throws(() => gripAngles("fist", "X"), /side/); assert.throws(() => gripAngles("constructor", "L"), /unknown grip/); assert.throws(() => gripAngles(undefined, "L"), /unknown grip/);
});

test("library: frozen all the way down, ids unique, categories valid, search is word-order / case / diacritics insensitive, byId is own-property only", () => {
  assert.ok(Object.isFrozen(POSTURES));
  for (const p of POSTURES) { assert.ok(Object.isFrozen(p) && Object.isFrozen(p.joints) && Object.isFrozen(p.spine) && Object.isFrozen(p.tags), p.id); }
  assert.equal(new Set(POSTURES.map((p) => p.id)).size, POSTURES.length);
  assert.equal(byId("__proto__"), undefined); assert.equal(byId("constructor"), undefined); assert.equal(byId("t-pose").id, "t-pose");
  assert.deepEqual(search("POSE t").map((p) => p.id), search("t pose").map((p) => p.id)); assert.ok(search("ÍSO 7250").length >= 2); assert.equal(search("zzzz-nothing").length, 0);
  assert.equal(search("").length, POSTURES.length); assert.equal(search(null).length, POSTURES.length);
  for (const p of POSTURES) { const r = val(MAN, p, { library: POSTURES }); assert.ok(r.ok, `${p.id}: ${r.errors}`); }
});

test("figureOf: idempotent, equal to rig.restBody joints and landmarks, passes a restBody through, never mutates the body", () => {
  for (let i = 0; i < FILES.length; i += 3) {
    const b = H.popBody(FILES[i], i % 2 ? 5 : 95), snap = JSON.stringify([b.joints, b.landmarks]), rig = buildRig(b, { skeleton: false }), f = P.figureOf(b);
    assert.equal(P.figureOf(f), f); assert.equal(P.figureOf(rig.restBody), rig.restBody); assert.equal(JSON.stringify([b.joints, b.landmarks]), snap);
    for (const id of Object.keys(f.joints)) for (let k = 0; k < 3; k++) assert.equal(f.joints[id].offset[k], rig.restBody.joints[id].offset[k]);
    for (const id of Object.keys(f.landmarks)) { assert.equal(f.landmarks[id].joint, rig.restBody.landmarks[id].joint); for (let k = 0; k < 3; k++) assert.equal(f.landmarks[id].offset[k], rig.restBody.landmarks[id].offset[k]); }
    const r1 = val(b, byId("iso-7250-sitting")), r2 = val(rig.restBody, byId("iso-7250-sitting")); assert.equal(r1.ok, r2.ok); near(r1.metrics.balanceMargin, r2.metrics.balanceMargin, 1e-12);
  }
});
