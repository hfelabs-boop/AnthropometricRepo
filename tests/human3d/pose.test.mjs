// pose.js (expand, clamp, mirror, blend, place, contacts, centre of mass, balance, validate), proxies.js and the grips of postures/grips.js.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.test.mjs"
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody, referencePose } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, jointQuaternion } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import * as P from "../../site/js/human/pose.js";
import { bodyProxies, proxyWorld, lowestPoint, capsuleOverlap, selfPenetrations } from "../../site/js/human/proxies.js";
import { GRIPS, GRIP_NAMES, HAND_JOINTS, gripAngles } from "../../site/js/human/postures/grips.js";
import REFERENCE from "../../site/js/human/postures/reference.js";
import { dofTable } from "../../scripts/human_dof_table.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);

// ---- bodies -------------------------------------------------------------------------------------------------------------------
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const MAN = army("M", 50), WOMAN5 = army("F", 5), TALL = fitBody({ sex: "M", measures: { stature: { value: 2000, unit: "mm" } } });
const BODIES = { "median man": MAN, "5th-percentile woman": WOMAN5, "2.0 m man": TALL };

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random pose inside the ranges of motion; `scale` shrinks every range toward 0 (1 = the whole range). */
function randomPose(rand, scale = 1, withRoot = true) {
  const angles = {};
  for (const j of JOINTS) {
    if (j.id === "pelvis") continue;
    const a = j.dof.map((d) => (d.min + rand() * (d.max - d.min)) * scale);
    angles[j.id] = clampAngles(j.id, a).angles;
  }
  const root = withRoot ? { heading: (rand() - 0.5) * 300, flex: (rand() - 0.5) * 120, lat: (rand() - 0.5) * 100, rot: (rand() - 0.5) * 100 } : { heading: 0, flex: 0, lat: 0, rot: 0 };
  return { root, angles };
}
const base = (over) => ({ id: "test-posture", name: "Test posture", category: "Reference", tags: ["test"], description: "A posture written for the tests of the validator.", source: "illustrative", support: "feet", grips: { L: "relaxed", R: "relaxed" }, ...over });
const kinOf = (body) => { const o = {}; for (const j of JOINTS) if (j.parent) o[j.id] = body.joints[j.id].offset; return new Kinematics(o); };
const lmWorld = (body, kin, id) => kin.toWorld(body.landmarks[id].joint, body.landmarks[id].offset);

// ---- expansion ----------------------------------------------------------------------------------------------------------------
test("expandPosture: an empty posture is the neutral pose", () => {
  const e = P.expandPosture({ id: "empty" });
  assert.deepEqual(e.root, { heading: 0, flex: 0, lat: 0, rot: 0 });
  assert.deepEqual(e.angles, {});
  assert.deepEqual(e.grips, { L: null, R: null });
});

test("expandPosture: spine regions are distributed over the vertebrae with the region weights, per-vertebra values go on top", () => {
  const e = P.expandPosture({ id: "s", spine: { lumbar: [30, 10, 6], thoracic: [-10, 0, 20] }, joints: { L3: [4, 0, 0] } });
  const sum = (ids, c) => ids.reduce((s, id) => s + e.angles[id][c], 0);
  near(sum(REGIONS.lumbar.joints, 0), 30 + 4, 1e-9, "lumbar flex total incl. the L3 addition");
  near(sum(REGIONS.lumbar.joints, 1), 10, 1e-9); near(sum(REGIONS.lumbar.joints, 2), 6, 1e-9);
  near(sum(REGIONS.thoracic.joints, 0), -10, 1e-9); near(sum(REGIONS.thoracic.joints, 2), 20, 1e-9);
  // shares follow the weights: L5 takes 20/78 of the flexion, L1 12/78 (L3 has 4 more)
  near(e.angles.L5[0], 30 * (20 / 78), 1e-9); near(e.angles.L1[0], 30 * (12 / 78), 1e-9);
  near(e.angles.L3[0], 30 * (15 / 78) + 4, 1e-9);
  assert.equal(e.angles.C3, undefined, "an untouched region is not listed");
  assert.ok(e.angles.L5.length === 3);
});

test("expandPosture: _LR, _L and _R keys; an explicit side overrides _LR; the posture is not modified", () => {
  const posture = { id: "sides", joints: { hip_LR: [90, 0, 0], hip_R: [45], knee_L: [80, 5], head: [10, -4, 2] } };
  const copy = JSON.parse(JSON.stringify(posture));
  const e = P.expandPosture(posture);
  assert.deepEqual(e.angles.hip_L, [90, 0, 0]);
  assert.deepEqual(e.angles.hip_R, [45, 0, 0]);
  assert.deepEqual(e.angles.knee_L, [80, 5]);
  assert.equal(e.angles.knee_R, undefined);
  assert.deepEqual(e.angles.head, [10, -4, 2]);
  assert.deepEqual(posture, copy, "input untouched");
  // the eyes use the posture convention: azim + looks toward the figure's left for BOTH eyes (expandSides negates the right eye)
  const eyes = P.expandPosture({ id: "eyes", joints: { eye_LR: [5, 12] } });
  assert.deepEqual(eyes.angles.eye_L, [5, 12]);
  assert.deepEqual(eyes.angles.eye_R, [5, -12]);
});

test("expandPosture: grips become finger joints, explicit joints override them, _LR overrides too", () => {
  const e = P.expandPosture({ id: "g", grips: { L: "fist", R: "open" }, joints: { index_mcp_L: [10, 2], middle_pip_LR: [5] } });
  assert.deepEqual(e.grips, { L: "fist", R: "open" });
  assert.equal(HAND_JOINTS.filter((h) => e.angles[`${h}_L`] && e.angles[`${h}_R`]).length, 15, "all 15 finger joints of both hands");
  assert.deepEqual(e.angles.index_mcp_L, [10, 2], "explicit joint overrides the grip");
  assert.deepEqual(e.angles.index_pip_L, GRIPS.fist.joints.index_pip, "the rest of the grip stays");
  assert.deepEqual(e.angles.middle_pip_L, [5]); assert.deepEqual(e.angles.middle_pip_R, [5]);
  assert.deepEqual(e.angles.index_mcp_R, GRIPS.open.joints.index_mcp, "the right hand uses the same numbers");
  assert.notEqual(e.angles.index_pip_L, GRIPS.fist.joints.index_pip, "fresh arrays: GRIPS is not shared");
});

test("expandPosture: errors name the posture id and the offending key", () => {
  const bad = (posture, ...needles) => {
    assert.throws(() => P.expandPosture({ id: "bad-one", ...posture }), (e) => {
      for (const n of ["bad-one", ...needles]) assert.ok(e.message.includes(n), `"${n}" missing in: ${e.message}`);
      return e instanceof Error;
    });
  };
  bad({ joints: { bogus_LR: [1] } }, "joints.bogus_LR");
  bad({ joints: { hip: [1] } }, "joints.hip", "hip_LR");
  bad({ joints: { head_LR: [1] } }, "joints.head_LR", "not a paired joint");
  bad({ joints: { pelvis: [1] } }, "joints.pelvis", "root");
  bad({ joints: { knee_L: [1, 2, 3] } }, "joints.knee_L", "1 to 2");
  bad({ joints: { knee_L: [] } }, "joints.knee_L");
  bad({ joints: { knee_L: [NaN] } }, "joints.knee_L", "not a finite number");
  bad({ joints: { knee_L: ["90"] } }, "joints.knee_L", "not a finite number");
  bad({ joints: { knee_L: 90 } }, "joints.knee_L", "array");
  bad({ spine: { sacral: [1] } }, "spine.sacral", "unknown region");
  bad({ spine: { lumbar: [1, 2, 3, 4] } }, "spine.lumbar");
  bad({ grips: { L: "claw" } }, "grips.L", "claw", "fist");
  bad({ grips: { X: "fist" } }, "grips.X");
  bad({ root: { x: 1 } }, "root.x", "no position");
  bad({ root: { flex: Infinity } }, "root.flex");
  bad({ root: { yaw: 1 } }, "root.yaw");
  assert.throws(() => P.expandPosture(null), /expected an object/);
});

test("expandPosture: a region total that the vertebrae cannot take is reported in `shortfall`", () => {
  const e = P.expandPosture({ id: "s", spine: { lumbar: [200, 0, 0] } });
  assert.equal(e.shortfall.length, 1);
  assert.equal(e.shortfall[0].region, "lumbar"); assert.equal(e.shortfall[0].dof, "flex");
  near(e.shortfall[0].applied, REGIONS.lumbar.range.flex[1], 1e-6);
  assert.deepEqual(P.expandPosture({ id: "fine", spine: { lumbar: [20, 0, 0] } }).shortfall, []);
});

test("expandPosture: the three reference postures expand to the textbook angles", () => {
  const sit = P.expandPosture(REFERENCE.find((p) => p.id === "iso-7250-sitting"));
  assert.deepEqual(sit.angles.hip_L, [90, 0, 0]); assert.deepEqual(sit.angles.knee_R, [90, 0]);
  const t = P.expandPosture(REFERENCE.find((p) => p.id === "t-pose"));
  assert.equal(t.angles.shoulder_L[1], 82); assert.equal(t.angles.shoulder_R[1], 82);
});

// ---- clamp --------------------------------------------------------------------------------------------------------------------
test("clampPose: clamps to the ROM, reports joint/dof/requested/applied, never mutates", () => {
  const pose = { root: { heading: 10 }, angles: { knee_L: [200, 50], elbow_R: [90], shoulder_L: [150, 150, 10] } };
  const copy = JSON.parse(JSON.stringify(pose));
  const { pose: out, clamped } = P.clampPose(pose);
  assert.deepEqual(pose, copy);
  assert.deepEqual(out.angles.knee_L, [160, 30]);
  assert.deepEqual(out.angles.elbow_R, [90]);
  assert.deepEqual(clamped.filter((c) => c.joint === "knee_L"), [{ joint: "knee_L", dof: "flex", requested: 200, applied: 160 }, { joint: "knee_L", dof: "rot", requested: 50, applied: 30 }]);
  const sh = clamped.filter((c) => c.joint === "shoulder_L");
  assert.ok(sh.length === 2 && sh.every((c) => c.applied < c.requested), "the 180-degree swing cap is reported");
  assert.equal(out.root.heading, 10);
  assert.throws(() => P.clampPose({ angles: { nope: [1] } }), /unknown joint/);
  assert.throws(() => P.clampPose({ angles: { knee_L: [NaN] } }), /finite/);
  assert.deepEqual(P.clampPose({ angles: {} }).clamped, []);
});

// ---- mirror -------------------------------------------------------------------------------------------------------------------
test("mirrorPose: involution, known asymmetric posture, and the geometry is the mirror image", () => {
  const rand = rng(11);
  for (let n = 0; n < 40; n++) {
    const p = randomPose(rand);
    const m = P.mirrorPose(p);
    assert.ok(P.poseEquals(P.mirrorPose(m), p, 1e-12), "mirror(mirror(p)) == p");
    assert.ok(!Object.is(m.root.heading, -0));
  }
  const m = P.mirrorPose({ root: { heading: 30, flex: 5, lat: 7, rot: -3, x: 0.5 }, angles: { elbow_R: [90], hip_L: [20, 10, 5], head: [4, 6, -8], L2: [3, 2, 1], jaw: [10], eye_L: [3, 9] } });
  assert.deepEqual(m.root, { heading: -30, flex: 5, lat: -7, rot: 3, x: -0.5 });
  assert.deepEqual(m.angles.elbow_L, [90]); assert.equal(m.angles.elbow_R, undefined);
  assert.deepEqual(m.angles.hip_R, [20, 10, 5]);
  assert.deepEqual(m.angles.head, [4, -6, 8], "head: flexion unchanged, lateral bend and turn negated");
  assert.deepEqual(m.angles.L2, [3, -2, -1]);
  assert.deepEqual(m.angles.jaw, [10], "the jaw opens the same");
  assert.deepEqual(m.angles.eye_R, [3, 9], "eye joint angles are lateral-positive on both sides: a swap");
  // geometry: every landmark of the mirrored pose is the mirror image (x -> -x) of the same landmark of the original, with left and right exchanged
  const kin = kinOf(MAN), kin2 = kinOf(MAN);
  const ids = Object.keys(MAN.landmarks);
  for (const seed of [3, 4, 5]) {
    const p = randomPose(rng(seed));
    p.root.x = 0.3; p.root.y = 1; p.root.z = -0.2;
    kin.solve(p.angles, p.root);
    kin2.solve(P.mirrorPose(p).angles, P.mirrorPose(p).root);
    for (const id of ids) {
      const other = id.endsWith("_L") ? id.slice(0, -2) + "_R" : id.endsWith("_R") ? id.slice(0, -2) + "_L" : id;
      const a = lmWorld(MAN, kin, other), b = lmWorld(MAN, kin2, id);
      assert.ok(Math.abs(a.x + b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9, `${id}: ${b.toArray()} vs mirror of ${other} ${a.toArray()}`);
    }
  }
  // the eye convention on the posture level: mirroring a gaze to the left gives a gaze to the right (posture azim -12 for both eyes)
  const e = P.expandPosture({ id: "eyes", joints: { eye_LR: [0, 12] } });
  const me = P.mirrorPose({ root: {}, angles: e.angles });
  assert.deepEqual(me.angles.eye_L, [0, -12]); assert.deepEqual(me.angles.eye_R, [0, 12]);
});

test("copySide: the editor's mirror left to right / right to left", () => {
  const pose = { root: { heading: 20 }, angles: { shoulder_L: [30, 40, 5], shoulder_R: [1, 2, 3], elbow_R: [90], head: [4, 5, 6], eye_L: [2, 5], thumb_cmc_L: [10, 20] } };
  const copy = JSON.parse(JSON.stringify(pose));
  const l = P.copySide(pose, "L");
  assert.deepEqual(pose, copy, "input untouched");
  assert.deepEqual(l.angles.shoulder_R, [30, 40, 5]); assert.deepEqual(l.angles.shoulder_L, [30, 40, 5]);
  assert.deepEqual(l.angles.elbow_R, [0], "L has no elbow: R becomes 0"); assert.equal(l.angles.elbow_L, undefined);
  assert.deepEqual(l.angles.head, [4, 5, 6]); assert.equal(l.root.heading, 20);
  assert.deepEqual(l.angles.eye_R, [2, -5], "both eyes keep looking the same way (posture convention)");
  assert.deepEqual(l.angles.thumb_cmc_R, [10, 20]);
  const r = P.copySide(pose, "R");
  assert.deepEqual(r.angles.shoulder_L, [1, 2, 3]); assert.deepEqual(r.angles.elbow_L, [90]); assert.deepEqual(r.angles.eye_L, [0, 0], "R has no gaze: L becomes neutral");
  assert.throws(() => P.copySide(pose, "X"), /"L" or "R"/);
  // geometry: with only paired joints the result is mirror symmetric (eyes excluded: a conjugate gaze to the side is not)
  const sym = P.copySide({ root: {}, angles: { shoulder_L: [30, 40, 5], hip_R: [20, 5, 3], knee_L: [10, 4], ankle_R: [5, 6, 7] } }, "R");
  assert.ok(P.poseEquals(P.mirrorPose(sym), sym, 1e-12));
});

// ---- blend --------------------------------------------------------------------------------------------------------------------
test("blendPoses: t = 0 and t = 1 are exact, the union of joints is kept, t is clamped", () => {
  const rand = rng(5);
  const a = randomPose(rand), b = randomPose(rand);
  delete b.angles.knee_L; // a joint only in one pose is 0 in the other
  const b0 = P.blendPoses(a, b, 0), b1 = P.blendPoses(a, b, 1);
  assert.ok(P.poseEquals(b0, a, 0), "t = 0");
  assert.ok(P.poseEquals(b1, b, 0), "t = 1");
  assert.deepEqual(b0.angles.knee_L, a.angles.knee_L); assert.deepEqual(b1.angles.knee_L, [0, 0]);
  assert.equal(b0.root.heading, a.root.heading); assert.equal(b1.root.heading, b.root.heading);
  assert.ok(P.poseEquals(P.blendPoses(a, b, -3), a, 0)); assert.ok(P.poseEquals(P.blendPoses(a, b, 7), b, 0));
  assert.throws(() => P.blendPoses(a, b, NaN), /finite/);
  const m = P.blendPoses({ root: {}, angles: { elbow_L: [0] } }, { root: {}, angles: { elbow_L: [100] } }, 0.25);
  near(m.angles.elbow_L[0], 25, 1e-12, "a hinge is linear in its angle");
});

test("blendPoses: the heading takes the short way round", () => {
  const h = (a, b, t) => P.blendPoses({ root: { heading: a } }, { root: { heading: b } }, t).root.heading;
  near(Math.abs(h(170, -170, 0.5)), 180, 1e-9);
  near(h(-170, 170, 0.25), -175, 1e-9);
  near(h(10, 50, 0.5), 30, 1e-9);
  near(h(350 - 360, 20, 0.5), 5, 1e-9);
  assert.equal(h(170, -170, 1), -170);
  assert.equal(h(170, -170, 0), 170);
});

test("blendPoses: continuity and monotonic progress along the path", () => {
  const rand = rng(21);
  const rest = {}; // rest direction of the bone of a joint with two swing DOF: its twist axis, else the third axis
  for (const j of JOINTS) {
    const sw = j.dof.filter((d) => d.role !== "twist");
    if (sw.length !== 2) continue;
    const tw = j.dof.find((d) => d.role === "twist");
    rest[j.id] = new THREE.Vector3(...(tw ? tw.axis : new THREE.Vector3(...sw[0].axis).cross(new THREE.Vector3(...sw[1].axis)).toArray())).normalize();
  }
  const dir = (id, ang) => rest[id].clone().applyQuaternion(jointQuaternion(id, ang));
  let balls = 0;
  for (let n = 0; n < 12; n++) {
    const a = randomPose(rand, 0.6), b = randomPose(rand, 0.6);
    const N = 100, samples = [];
    for (let k = 0; k <= N; k++) samples.push(P.blendPoses(a, b, k / N));
    for (const j of JOINTS) {
      if (j.id === "pelvis") continue;
      const A = a.angles[j.id], B = b.angles[j.id];
      let prev = 0;
      const total = rest[j.id] ? Math.acos(Math.min(1, dir(j.id, A).dot(dir(j.id, B)))) : 0;
      if (rest[j.id]) balls++;
      for (let k = 0; k <= N; k++) {
        const ang = samples[k].angles[j.id];
        if (k > 0) { // continuity: no jump larger than a few times the average step
          const before = samples[k - 1].angles[j.id];
          const step = Math.max(...ang.map((v, i) => Math.abs(v - before[i])));
          const bound = rest[j.id] ? 5 : Math.max(...A.map((v, i) => Math.abs(B[i] - v))) / N + 1e-9;
          assert.ok(step <= bound + 1e-9, `${j.id} step ${step} > ${bound} at ${k}`);
        }
        if (rest[j.id]) { // the bone direction moves along the great circle: its distance from a never decreases and ends at the distance a-b
          const d = Math.acos(Math.min(1, dir(j.id, A).dot(dir(j.id, ang))));
          assert.ok(d >= prev - 1e-7 && d <= total + 1e-7, `${j.id} bone direction not monotonic at ${k}: ${d} after ${prev} (total ${total})`);
          prev = d;
          const tw = j.dof.findIndex((x) => x.role === "twist");
          if (tw >= 0) assert.ok(ang[tw] >= Math.min(A[tw], B[tw]) - 1e-9 && ang[tw] <= Math.max(A[tw], B[tw]) + 1e-9, `${j.id} twist monotonic`);
        } else { // hinge or twist: every angle moves monotonically from a to b
          ang.forEach((v, i) => {
            const lo = Math.min(A[i], B[i]) - 1e-9, hi = Math.max(A[i], B[i]) + 1e-9;
            assert.ok(v >= lo && v <= hi, `${j.id}[${i}] outside [${lo}, ${hi}]`);
          });
        }
      }
    }
  }
  assert.ok(balls > 200, "the swing joints were exercised");
});

test("blendPoses: the bone direction follows the great circle (constant angular speed) and the root blends like a ball joint", () => {
  const a = { root: { flex: 0 }, angles: { shoulder_L: [90, 0, 0] } }, b = { root: { flex: 0 }, angles: { shoulder_L: [0, 90, 0] } };
  const dir = (p) => new THREE.Vector3(0, -1, 0).applyQuaternion(jointQuaternion("shoulder_L", p.angles.shoulder_L)); // where the joint axis points (the neutral arm is tilted a few degrees from it)
  const d0 = dir(a), d1 = dir(b), total = Math.acos(d0.dot(d1));
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) near(Math.acos(d0.dot(dir(P.blendPoses(a, b, t)))), t * total, 1e-9, `constant speed at ${t}`);
  // supine to prone passes through the upright body (the two up-vectors are opposite: the swing moves along the line)
  const mid = P.blendPoses({ root: { flex: -90 } }, { root: { flex: 90 } }, 0.5).root;
  near(mid.flex, 0, 1e-9);
  near(P.blendPoses({ root: { flex: -90 } }, { root: { flex: -30 } }, 0.5).root.flex, -60, 1e-9);
  // hinges are linear
  near(P.blendPoses({ angles: { knee_L: [0, 0] } }, { angles: { knee_L: [90, 10] } }, 0.5).angles.knee_L[1], 5, 1e-12);
});

test("blendPoses: a raised arm swings on its arc, it does not sag like a linear blend of the angles", () => {
  const kin = kinOf(MAN);
  const fwd = { root: {}, angles: { shoulder_L: [90, 0, 0] } }, side = { root: {}, angles: { shoulder_L: [0, 90, 0] } };
  const rise = (pose) => { kin.solve(pose.angles, { y: 1 }); return kin.position("wrist_L").y - kin.position("shoulder_L").y; };
  const mid = P.blendPoses(fwd, side, 0.5);
  const lerp = { root: {}, angles: { shoulder_L: [45, 45, 0] } };
  assert.ok(Math.abs(rise(mid) - rise(fwd)) < 0.06, `slerp: arm stays near horizontal (${rise(mid)} vs ${rise(fwd)})`);
  assert.ok(rise(fwd) - rise(lerp) > 0.12, `a linear blend of the angles sags by ${rise(fwd) - rise(lerp)}`);
});

test("poseEquals: missing joints and trailing values are 0, the heading compares modulo 360", () => {
  assert.ok(P.poseEquals({ angles: { knee_L: [0, 0] } }, { root: {} }));
  assert.ok(P.poseEquals({ root: { heading: 180 } }, { root: { heading: -180 } }));
  assert.ok(!P.poseEquals({ angles: { knee_L: [1] } }, { angles: {} }));
  assert.ok(P.poseEquals({ angles: { knee_L: [1] } }, { angles: { knee_L: [1.0000001] } }, 1e-3));
  assert.ok(!P.poseEquals({ root: { flex: 1 } }, { root: {} }));
});

// ---- placement ----------------------------------------------------------------------------------------------------------------
const centroidXZ = (body, pose, root, set) => {
  const rows = P.contactClearances(body, pose, root, { floor: 0 }, { [set]: "floor" });
  let x = 0, z = 0;
  for (const r of rows) { const v = P.landmarkPosition(body, pose, root, r.point); x += v.x; z += v.z; }
  return [x / rows.length, z / rows.length];
};

for (const [name, body] of Object.entries(BODIES)) {
  test(`placePose: neutral standing on the floor, feet centroid at the anchor (${name})`, () => {
    const pose = { root: {}, angles: {} };
    const root = P.placePose(body, pose);
    const rows = P.contactClearances(body, pose, root);
    near(Math.min(...rows.map((r) => r.clearance)), 0, 1e-12, "lowest foot point on the floor");
    assert.ok(rows.every((r) => r.clearance >= -1e-12), "no point below the floor");
    near(root.y, body.joints.pelvis.offset[1], 1e-6, "the neutral pose stands where fitBody put the pelvis");
    const [cx, cz] = centroidXZ(body, pose, root, "feet");
    near(cx, 0, 1e-12); near(cz, 0, 1e-12);
    const r2 = P.placePose(body, pose, { anchor: { x: 1.5, z: -2 } });
    const [x2, z2] = centroidXZ(body, pose, r2, "feet");
    near(x2, 1.5, 1e-12); near(z2, -2, 1e-12);
    assert.deepEqual(Object.keys(root), ["x", "y", "z", "heading", "flex", "lat", "rot"]);
    assert.equal(root.report.primary, "feet"); assert.equal(root.report.gaps.feet, 0);
    assert.ok(!Object.keys(root).includes("report"), "the report is not enumerable");
  });

  test(`placePose: heading turns the body about the vertical through the anchor (${name})`, () => {
    const pose = { root: { heading: 30 }, angles: { hip_L: [20, 0, 0], knee_L: [40, 0] } };
    const anchor = { x: 0.7, z: 0.4 };
    const r0 = P.placePose(body, pose, { anchor });
    const r1 = P.placePose(body, pose, { anchor, heading: 60 });
    near(r1.heading, 90, 1e-12);
    for (const r of [r0, r1]) { const [cx, cz] = centroidXZ(body, pose, r, "feet"); near(cx, anchor.x, 1e-12); near(cz, anchor.z, 1e-12); }
    near(r0.y, r1.y, 1e-12, "the height does not depend on the heading");
    const k0 = kinOf(body), k1 = kinOf(body);
    k0.solve(pose.angles, r0); k1.solve(pose.angles, r1);
    // the body turned by 60 degrees about the anchor: every landmark's offset from the anchor is rotated
    const c = Math.cos(Math.PI / 3), s = Math.sin(Math.PI / 3);
    for (const id of ["vertex", "toe_tip_L", "palm_centre_R", "heel_L"]) {
      const a = lmWorld(body, k0, id), b = lmWorld(body, k1, id);
      const dx = a.x - anchor.x, dz = a.z - anchor.z;
      // heading + turns the figure to its left, i.e. +Z toward +X: x' = x cos + z sin, z' = -x sin + z cos
      near(b.x - anchor.x, dx * c + dz * s, 1e-9, id); near(b.z - anchor.z, -dx * s + dz * c, 1e-9, id); near(b.y, a.y, 1e-12);
    }
    assert.equal(P.placePose(body, { root: { heading: 170 } }, { heading: 30 }).heading, -160, "the heading is kept in (-180, 180]");
  });

  test(`placePose: the ISO seated reference posture on a seat plane (${name})`, () => {
    const ref = referencePose(body, "seat");
    const pose = { root: {}, angles: ref.angles };
    // explicit seat plane at 0.45 m: the lowest seat contact point is exactly on it, the feet are reported
    const d = P.placePoseDetailed(body, pose, { support: "seat+feet", surfaces: { floor: 0, seat: 0.45 } });
    const rows = P.contactClearances(body, pose, d.root, { floor: 0, seat: 0.45 }, { seat: "seat", feet: "floor" });
    near(Math.min(...rows.filter((r) => r.set === "seat").map((r) => r.clearance)), 0, 1e-12, "lowest seat point on the seat");
    for (const id of ["ischial_L", "ischial_R"]) near(rows.find((r) => r.point === id).clearance, 0, 1e-9, id);
    const pop = P.seatHeightFor(body, "popliteal");
    near(d.gaps.seat, 0, 1e-12); near(d.gaps.feet, 0.45 - pop, 1e-9, "the feet float by the difference of the seat heights");
    // on the popliteal seat the soles are on the floor, and the root is where fit.js puts it (knee height)
    const dp = P.placePoseDetailed(body, pose, { support: "seat+feet" });
    near(dp.gaps.feet, 0, 1e-9, "popliteal seat: soles on the floor");
    near(dp.surfaces.seat, pop, 0, "seat plane = seatHeightFor");
    near(dp.root.y, ref.root.y, 1e-6, "root height = fit.js referencePose");
    // a seat that is too low pushes the feet through the floor: reported as a negative gap, not forced
    assert.ok(P.placePoseDetailed(body, pose, { support: "seat+feet", surfaces: { floor: 0, seat: pop - 0.05 } }).gaps.feet < -0.049);
    assert.equal(P.seatHeightFor(body, 0.5), 0.5);
    assert.throws(() => P.seatHeightFor(body, -1), /seat height/);
    assert.throws(() => P.seatHeightFor(body, "low"), /popliteal/);
    // floor sitting: seat plane 0
    const fl = P.placePoseDetailed(body, { root: {}, angles: ref.angles }, { support: "seat", surfaces: { floor: 0, seat: 0 } });
    near(Math.min(...P.contactClearances(body, pose, fl.root, { floor: 0, seat: 0 }, { seat: "seat" }).map((r) => r.clearance)), 0, 1e-12);
  });

  test(`placePose: supine and prone bodies rest on their lowest points (${name})`, () => {
    for (const flex of [-90, 90]) {
      const pose = { root: { flex }, angles: { shoulder_L: [0, 20, 0], knee_L: [30, 0] } };
      const anchor = { x: -1, z: 2 };
      const root = P.placePose(body, pose, { support: "body", anchor });
      const rows = P.contactClearances(body, pose, root, { floor: 0 }, { body: "floor" });
      near(Math.min(...rows.map((r) => r.clearance)), 0, 1e-12, `lowest point of the body on the floor (flex ${flex})`);
      assert.ok(rows.every((r) => r.clearance >= -1e-12));
      const kin = P.solvePose(body, pose, root);
      const w = proxyWorld(bodyProxies(body), kin);
      assert.ok(lowestPoint(w).y >= -1e-12, "no proxy below the floor");
      let lm = Infinity;
      for (const id of Object.keys(body.landmarks)) lm = Math.min(lm, lmWorld(body, kin, id).y);
      assert.ok(lm >= -1e-12);
      const com = P.centerOfMass(body, pose, root).point;
      near(com.x, anchor.x, 1e-9); near(com.z, anchor.z, 1e-9);
      assert.ok(com.y > 0.05 && com.y < 0.4, `COM of a lying body is low: ${com.y}`);
      // supine lies on the back: the back landmarks are the lowest; prone on the front
      const y = (id) => lmWorld(body, kin, id).y;
      if (flex < 0) assert.ok(y("buttock_extremity") < y("abdomen_front") && y("opisthocranion") < y("pronasale"), "supine");
      else assert.ok(y("abdomen_front") < y("buttock_extremity") && y("chest_front") < y("chest_back"), "prone");
    }
  });
}

test("placePose: carriers, surfaces and errors", () => {
  const pose = { root: {}, angles: {} };
  // heels only on a 0.2 m step
  const r = P.placePose(MAN, pose, { carriers: { feet: "step" }, surfaces: { floor: 0, step: 0.2 } });
  near(r.y, MAN.joints.pelvis.offset[1] + 0.2, 1e-6);
  const toes = P.placePose(MAN, pose, { carriers: { toes: "floor" } });
  near(Math.min(...P.contactClearances(MAN, pose, toes, { floor: 0 }, { toes: "floor" }).map((x) => x.clearance)), 0, 1e-12);
  assert.throws(() => P.placePose(MAN, pose, { support: "levitating" }), /unknown support/);
  assert.throws(() => P.placePose(MAN, pose, { carriers: { feet: "roof" } }), /roof/);
  assert.throws(() => P.placePose(MAN, pose, { carriers: { wings: "floor" } }), /unknown contact set/);
  assert.throws(() => P.placePose(MAN, pose, { surfaces: { floor: "0" } }), /height/);
  assert.throws(() => P.placePose(MAN, { angles: { nope: [1] } }), /unknown joint/);
  assert.throws(() => P.placePose(MAN, pose, { heading: NaN }), /heading/);
  assert.throws(() => P.placePose({}, pose), /BodyModel/);
  for (const [support, c] of Object.entries(P.SUPPORT_CARRIERS)) {
    assert.ok(P.SUPPORT_INFO[support], `${support} is documented`);
    for (const set of Object.keys(c)) assert.ok(set === "body" || MAN.contacts[set] || ["toes", "heels", "palms", "shins", "kneecaps"].includes(set), `${support}: contact set ${set}`);
    P.placePose(MAN, pose, { support }); // every support places without error
  }
  assert.deepEqual(Object.keys(P.SUPPORT_INFO).sort(), Object.keys(P.SUPPORT_CARRIERS).sort());
  assert.deepEqual(Object.keys(P.SUPPORT_CARRIERS.feet), ["feet"]);
  assert.deepEqual(Object.keys(P.SUPPORT_CARRIERS["seat+feet"]), ["seat", "feet"], "the primary carrier comes first");
});

test("contactClearances: positive above the surface, one row per point", () => {
  const pose = { root: {}, angles: {} };
  const root = P.placePose(MAN, pose);
  const up = { ...root, y: root.y + 0.1 };
  const rows = P.contactClearances(MAN, pose, up);
  assert.equal(rows.length, MAN.contacts.feet.length);
  assert.deepEqual(rows.map((r) => r.point), MAN.contacts.feet);
  assert.ok(rows.every((r) => r.set === "feet" && Math.abs(r.clearance - 0.1) < 1e-12));
  const sunk = P.contactClearances(MAN, pose, { ...root, y: root.y - 0.02 });
  assert.ok(sunk.every((r) => r.clearance < 0));
  const body = P.contactClearances(MAN, { root: { flex: -90 }, angles: {} }, { y: 0.3 }, { floor: 0 }, { body: "floor" });
  assert.equal(body.length, 2); assert.ok(body[1].point.startsWith("proxy:"));
});

test("placePose / validatePosture on random poses: finite, the primary carrier touches, nothing throws", () => {
  const rand = rng(99);
  const supports = Object.keys(P.SUPPORT_CARRIERS);
  for (let n = 0; n < 150; n++) {
    const body = Object.values(BODIES)[n % 3], support = supports[n % supports.length];
    const pose = randomPose(rand, 0.7);
    const d = P.placePoseDetailed(body, pose, { support, anchor: { x: rand() - 0.5, z: rand() - 0.5 }, heading: rand() * 360 - 180 });
    assert.ok(Object.values(d.root).every(Number.isFinite), JSON.stringify(d.root));
    assert.equal(d.gaps[d.primary], 0);
    const rows = P.contactClearances(body, pose, d.root, d.surfaces, d.carriers).filter((r) => r.set === d.primary);
    near(Math.min(...rows.map((r) => r.clearance)), 0, 1e-9, `${support}: the lowest point of the primary carrier is on its surface`);
    const v = P.validatePosture(body, base({ support, root: pose.root, joints: Object.fromEntries(Object.entries(pose.angles).filter(([id]) => !REGIONS.lumbar.joints.concat(REGIONS.thoracic.joints, REGIONS.cervical.joints).includes(id))) }));
    assert.equal(typeof v.ok, "boolean");
    assert.ok(Object.values(v.metrics.gaps).every(Number.isFinite) && (v.metrics.balanceMargin === null || Number.isFinite(v.metrics.balanceMargin) || v.metrics.balanceMargin === -Infinity));
  }
});

// ---- centre of mass and balance -----------------------------------------------------------------------------------------------
for (const [name, body] of Object.entries(BODIES)) {
  test(`centerOfMass: neutral standing (${name})`, () => {
    const pose = { root: {}, angles: {} };
    const root = P.placePose(body, pose);
    const { point, mass } = P.centerOfMass(body, pose, root);
    const stature = body.stature;
    assert.ok(point.y / stature > 0.52 && point.y / stature < 0.6, `COM height ${(point.y / stature).toFixed(3)} of stature`);
    const kin = P.solvePose(body, pose, root);
    const ax = 0.5 * (kin.position("ankle_L").x + kin.position("ankle_R").x), az = 0.5 * (kin.position("ankle_L").z + kin.position("ankle_R").z);
    assert.ok(Math.abs(point.x - ax) < 0.06 && Math.abs(point.z - az) < 0.06, `COM over the ankles: dx ${point.x - ax}, dz ${point.z - az}`);
    near(mass, Object.values(body.masses).reduce((s, m) => s + m.mass, 0), 1e-9);
    near(mass, body.mass, 0.02 * body.mass, "segment masses add up to the body mass");
    // fit.js's whole-body COM of the neutral pose (massInfo.com, world frame with the soles on the floor)
    const ref = body.massInfo.com; // world frame of the fit: pelvis at x = z = 0
    const rc = Array.isArray(ref) ? ref : [ref.x, ref.y, ref.z];
    near(point.x - root.x, rc[0], 1e-4); near(point.y, rc[1], 1e-4); near(point.z - root.z, rc[2], 1e-4);
    const out = new THREE.Vector3();
    assert.equal(P.centerOfMass(body, pose, root, out).point, out);
  });
}

test("centerOfMass: bending forward moves the COM forward, raising an arm raises it", () => {
  const a = P.centerOfMass(MAN, { root: {}, angles: {} }, { y: 1 }).point;
  const bent = P.centerOfMass(MAN, P.expandPosture({ id: "b", spine: { lumbar: [50, 0, 0], thoracic: [30, 0, 0] } }), { y: 1 }).point;
  assert.ok(bent.z - a.z > 0.05 && bent.y < a.y);
  const arm = P.centerOfMass(MAN, { root: {}, angles: { shoulder_L: [0, 150, 0] } }, { y: 1 }).point;
  assert.ok(arm.y > a.y && arm.x > a.x);
});

test("balance: inside and outside against a hand-computed polygon", () => {
  const pose = { root: {}, angles: {} };
  const com0 = P.centerOfMass(MAN, pose, { y: 1 }).point;
  // rectangle x in [0, 0.2], z in [0, 0.1] (metres), as world points on the floor
  const rect = [[0, 0, 0], [0.2, 0, 0], [0.2, 0, 0.1], [0, 0, 0.1], [0.1, 0, 0.05]]; // the last point is inside the hull
  const at = (x, z) => ({ y: 1, x: x - com0.x, z: z - com0.z });
  let b = P.balance(MAN, pose, at(0.1, 0.05), rect);
  assert.equal(b.inside, true); near(b.margin, 0.05, 1e-9, "centre: nearest edge is 50 mm away (z)");
  assert.equal(b.hull.length, 4);
  near(b.com.x, 0.1, 1e-9); near(b.com.z, 0.05, 1e-9);
  b = P.balance(MAN, pose, at(0.04, 0.05), rect);
  assert.equal(b.inside, true); near(b.margin, 0.04, 1e-9, "40 mm from the x = 0 edge");
  b = P.balance(MAN, pose, at(0.3, 0.05), rect);
  assert.equal(b.inside, false); near(b.margin, -0.1, 1e-9, "100 mm outside the x = 0.2 edge");
  b = P.balance(MAN, pose, at(0.3, 0.2), rect);
  near(b.margin, -Math.hypot(0.1, 0.1), 1e-9, "outside a corner: distance to the corner");
  b = P.balance(MAN, pose, at(0.1, 0.1), rect);
  assert.equal(b.inside, true); near(b.margin, 0, 1e-9, "on the edge");
  // a triangle: (0,0), (0.3,0), (0,0.3); the centre (0.1, 0.1) is 0.1 from the legs and 0.1/sqrt2... the hypotenuse x + z = 0.3 is 0.1/sqrt(2) away
  b = P.balance(MAN, pose, at(0.1, 0.1), [[0, 0, 0], [0.3, 0, 0], [0, 0, 0.3]]);
  assert.equal(b.inside, true); near(b.margin, 0.1 / Math.SQRT2, 1e-9);
  // degenerate supports: a segment, a point, nothing
  b = P.balance(MAN, pose, at(0.1, 0.05), [[0, 0, 0], [0.2, 0, 0]]);
  assert.equal(b.inside, false); near(b.margin, -0.05, 1e-9);
  b = P.balance(MAN, pose, at(0.03, 0.04), [[0, 0, 0]]);
  near(b.margin, -0.05, 1e-9);
  assert.equal(P.balance(MAN, pose, at(0, 0), []).inside, false);
  // landmark ids: a person standing is balanced over the soles
  const root = P.placePose(MAN, pose);
  b = P.balance(MAN, pose, root, MAN.contacts.feet);
  assert.equal(b.inside, true); assert.ok(b.margin > 0.01 && b.margin < 0.06, `margin ${b.margin}`);
  assert.throws(() => P.balance(MAN, pose, root, ["no_such_landmark"]), /unknown landmark/);
  // {x, y, z} points work too
  assert.equal(P.balance(MAN, pose, root, MAN.contacts.feet.map((id) => P.landmarkPosition(MAN, pose, root, id))).inside, true);
});

// ---- validatePosture ----------------------------------------------------------------------------------------------------------
test("validatePosture: accepts the three reference postures on several bodies", () => {
  for (const [name, body] of Object.entries(BODIES)) {
    for (const p of REFERENCE) {
      const r = P.validatePosture(body, p, { library: REFERENCE });
      assert.equal(r.ok, true, `${p.id} on ${name}: ${r.errors.join("; ")}`);
      assert.deepEqual(r.warnings, [], `${p.id} on ${name}: ${r.warnings.join("; ")}`);
      assert.equal(r.metrics.romViolations, 0);
      assert.ok(r.metrics.gaps.feet !== undefined || r.metrics.gaps.seat !== undefined);
    }
  }
  const sit = P.validatePosture(MAN, REFERENCE[1]);
  near(sit.metrics.gaps.feet, 0, 1e-9); assert.ok(sit.metrics.seatHeight > 0.35 && sit.metrics.seatHeight < 0.55);
  assert.ok(sit.metrics.balanceMargin > 0.03);
});

test("validatePosture and expandPosture do not modify a frozen posture", () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  for (const p of REFERENCE) {
    const copy = JSON.parse(JSON.stringify(p));
    const f = deepFreeze(JSON.parse(JSON.stringify(p)));
    assert.equal(P.validatePosture(MAN, f).ok, true);
    P.expandPosture(f);
    assert.deepEqual(f, copy);
  }
  assert.ok(Object.isFrozen(P.CATEGORIES) && Object.isFrozen(P.CATEGORIES[0]) && Object.isFrozen(P.SUPPORT_CARRIERS.feet));
});

test("validatePosture: schema problems", () => {
  const v = (over, opts) => P.validatePosture(MAN, base(over), opts);
  const has = (r, re) => assert.ok(r.errors.some((e) => re.test(e)), `no error ${re} in ${JSON.stringify(r.errors)}`);
  assert.equal(v({}).ok, true);
  has(v({ id: "Not Kebab" }), /kebab-case/);
  has(v({ id: "ok-id", category: "Dancing" }), /category/);
  has(v({ name: "" }), /name is missing/);
  has(v({ description: undefined }), /description is missing/);
  has(v({ description: "  " }), /description is missing/);
  has(v({ source: undefined }), /source is missing/);
  has(v({ tags: ["Upper"] }), /tag "Upper"/);
  has(v({ tags: "seat" }), /tags must be an array/);
  has(v({ support: "floating" }), /support "floating"/);
  has(v({ support: undefined }), /support/);
  has(v({ contacts: ["heel_sole_X"] }), /unknown landmark/);
  has(v({ hints: { seat: { height: "high" } } }), /hints.seat.height/);
  has(v({ hints: { contactTolerance: 0.5 } }), /contactTolerance/);
  has(v({ hints: { dynamic: "yes" } }), /dynamic/);
  assert.ok(v({ colour: "red" }).warnings.some((w) => /unknown field "colour"/.test(w)));
  assert.deepEqual(v({}).warnings, []);
  assert.ok(v({ grips: undefined }).warnings.some((w) => /no grip for the left hand/.test(w)) && v({ grips: undefined }).warnings.some((w) => /right hand/.test(w)));
  assert.deepEqual(v({ grips: { L: "fist" } }).warnings.length, 1, "one hand without a grip");
  assert.deepEqual(v({ grips: undefined, joints: Object.fromEntries(["thumb_cmc", "index_mcp"].map((j) => [`${j}_LR`, [5]])) }).warnings, [], "explicit finger joints count as a choice");
  // duplicate ids need the library
  const a = base({ id: "dup" }), b = base({ id: "dup", name: "Other" });
  has(P.validatePosture(MAN, a, { library: [a, b] }), /duplicate id "dup"/);
  assert.equal(P.validatePosture(MAN, a, { library: [a] }).ok, true);
});

test("validatePosture: unknown joints, grips and bad numbers are reported, not thrown", () => {
  const v = (over) => P.validatePosture(MAN, base(over));
  let r = v({ joints: { bogus_LR: [1] } });
  assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes("test-posture") && e.includes("bogus_LR")));
  r = v({ grips: { L: "claw" } }); assert.ok(r.errors.some((e) => e.includes("claw")));
  r = v({ joints: { knee_L: [NaN] } }); assert.equal(r.ok, false);
  r = v({ root: { x: 3 } }); assert.ok(r.errors.some((e) => /no position/.test(e)));
});

test("validatePosture: range of motion violations name the joint and the DOF", () => {
  const r = P.validatePosture(MAN, base({ joints: { knee_L: [170, 0], head: [5, 30, 0], elbow_R: [90] } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /knee_L flex = 170.* \[-5, 160\]/.test(e)), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /head lat = 30.* \[-10, 10\]/.test(e)));
  assert.ok(!r.errors.some((e) => e.includes("elbow_R")));
  assert.equal(r.metrics.romViolations, 2);
  // swing cap
  assert.ok(P.validatePosture(MAN, base({ joints: { shoulder_L: [150, 150, 0] } })).errors.some((e) => /shoulder_L.*180/.test(e)));
  // a region total the vertebrae cannot take
  assert.ok(P.validatePosture(MAN, base({ spine: { lumbar: [90, 0, 0] } })).errors.some((e) => /spine lumbar flex: requested 90.*can take 60/.test(e)));
});

test("validatePosture: floating feet, floating declared contacts, sinking into the floor", () => {
  // seated with the knees nearly straight: the feet are held up in front of the chair
  let r = P.validatePosture(MAN, base({ support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [30, 0] } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /contact set "feet": its lowest point is \d+ mm above the floor/.test(e)), r.errors.join("\n"));
  assert.ok(r.metrics.gaps.feet > 0.15);
  // standing on one leg while both heels are declared as contacts
  r = P.validatePosture(MAN, base({ joints: { hip_R: [60, 0, 0] }, contacts: ["heel_sole_L", "heel_sole_R"] }));
  assert.ok(r.errors.some((e) => /contact heel_sole_R is \d+ mm above the floor/.test(e)), r.errors.join("\n"));
  assert.ok(!r.errors.some((e) => e.includes("heel_sole_L")));
  // externalSupport waives the secondary carrier and the balance rule, not the declared contacts
  r = P.validatePosture(MAN, base({ support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [30, 0] }, hints: { externalSupport: "footrest" } }));
  assert.ok(!r.errors.some((e) => /contact set "feet"/.test(e)));
  // support "feet" with the heels at the buttocks: the knees would be the lowest points, below the floor
  r = P.validatePosture(MAN, base({ joints: { knee_LR: [150, 0] } })); // heels at the buttocks, "feet" support: the knees sink
  assert.equal(r.ok, false); assert.ok(r.errors.some((e) => /below the floor/.test(e)), r.errors.join("\n"));
});

test("validatePosture: a hand through the torso is a gross self-intersection", () => {
  const r = P.validatePosture(MAN, base({ joints: { shoulder_L: [-19, -37, -34], elbow_L: [50] } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /(palm|fingers)_L/.test(e) && /(abdomen|chest|pelvis|buttock)_[LR]/.test(e) && /hand is inside the body/.test(e)), r.errors.join("\n"));
  assert.ok(r.metrics.penetrations.length > 0 && r.metrics.worstPenetration > 0.03);
  // resting a hand on the thigh while sitting is allowed
  const ok = P.validatePosture(MAN, base({ support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0], shoulder_L: [30, 0, 0], elbow_L: [40] } }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
  // legs through each other
  assert.ok(P.validatePosture(MAN, base({ joints: { hip_L: [0, -30, 0], hip_R: [0, -30, 0] } })).errors.some((e) => /thigh_L and thigh_R overlap/.test(e)));
  // the proxy-level check of the head into the chest (outside the ROM, so run on the kinematics directly)
  const prox = bodyProxies(MAN), kin = kinOf(MAN);
  kin.solve({ C7: [60, 0, 0], C4: [60, 0, 0], head: [60, 0, 0] }, { y: 1 });
  const pens = selfPenetrations(prox, proxyWorld(prox, kin));
  assert.ok(pens.some((p) => /head|neck/.test(p.a + p.b)), JSON.stringify(pens.slice(0, 3)));
});

test("validatePosture: balance (rule 6), hints.dynamic and hints.externalSupport", () => {
  // one leg lifted to the side with nothing under the centre of mass
  const lean = base({ joints: { hip_L: [0, 40, 0] } });
  let r = P.validatePosture(MAN, lean);
  assert.ok(r.errors.some((e) => /centre of mass is \d+ mm outside the support polygon/.test(e)), r.errors.join("\n"));
  assert.ok(r.metrics.balanceMargin < -0.04);
  r = P.validatePosture(MAN, { ...lean, hints: { dynamic: true } });
  assert.ok(!r.errors.some((e) => /centre of mass/.test(e)));
  r = P.validatePosture(MAN, { ...lean, hints: { externalSupport: "wall" } });
  assert.ok(!r.errors.some((e) => /centre of mass/.test(e)));
  // standing is inside, with a margin
  r = P.validatePosture(MAN, base({}));
  assert.ok(r.metrics.balanceMargin > 0.02);
  // lying has no balance rule
  r = P.validatePosture(MAN, base({ support: "body", root: { flex: -90 } }));
  assert.equal(r.ok, true, r.errors.join("; ")); assert.equal(r.metrics.balanceMargin, null);
});

test("validatePosture: hints.load adds a held weight to the balance check", () => {
  const lean = { joints: { shoulder_LR: [90, 0, 0], hip_LR: [-10, 0, 0] }, spine: { lumbar: [-35, 0, 0], thoracic: [-20, 0, 0] } };
  const without = P.validatePosture(MAN, base(lean));
  assert.ok(without.errors.some((e) => /centre of mass/.test(e)) && without.metrics.balanceMargin < -0.04, `without the load: ${without.metrics.balanceMargin}`);
  const withLoad = P.validatePosture(MAN, base({ ...lean, hints: { load: { mass: 20 } } }));
  assert.equal(withLoad.ok, true, withLoad.errors.join("; "));
  assert.ok(withLoad.metrics.balanceMargin > 0 && withLoad.metrics.com[2] > without.metrics.com[2]);
  assert.ok(P.validatePosture(MAN, base({ hints: { load: { mass: -1 } } })).errors.some((e) => /hints.load/.test(e)));
  assert.ok(P.validatePosture(MAN, base({ hints: { load: { mass: 5, landmarks: ["nowhere"] } } })).errors.some((e) => /hints.load.landmarks/.test(e)));
  // centerOfMass: the weighted mean of the body and the load at the mean of the grip centres
  const pose = { root: {}, angles: { shoulder_L: [90, 0, 0], shoulder_R: [90, 0, 0] } }, root = { y: 1 };
  const body = P.centerOfMass(MAN, pose, root), both = P.centerOfMass(MAN, pose, root, new THREE.Vector3(), { mass: 20 });
  const g = ["grip_centre_L", "grip_centre_R"].map((id) => P.landmarkPosition(MAN, pose, root, id));
  const expect = body.point.clone().multiplyScalar(body.mass).addScaledVector(g[0].clone().add(g[1]).multiplyScalar(0.5), 20).multiplyScalar(1 / (body.mass + 20));
  assert.ok(both.point.distanceTo(expect) < 1e-12 && Math.abs(both.mass - body.mass - 20) < 1e-12);
  assert.ok(P.balance(MAN, pose, root, [[0, 0, 0]], { load: { mass: 20 } }).com.distanceTo(expect) < 1e-12);
});

test("validatePosture: symmetry warnings", () => {
  const w = (over) => P.validatePosture(MAN, base(over)).warnings;
  assert.ok(w({ tags: ["symmetric"], joints: { elbow_L: [30], elbow_R: [40] } }).some((x) => /tagged symmetric/.test(x)));
  assert.ok(w({ joints: { elbow_L: [30], elbow_R: [30] } }).some((x) => /elbow_LR/.test(x)));
  assert.ok(w({ joints: { elbow_L: [30], elbow_R: [31] } }).some((x) => /differ by only/.test(x)));
  assert.deepEqual(w({ joints: { elbow_L: [30], elbow_R: [60] } }), [], "a clearly asymmetric posture is fine");
  assert.deepEqual(w({ tags: ["symmetric"], joints: { eye_LR: [3, 10], elbow_LR: [20] } }), [], "equal gaze of both eyes is symmetric in the posture convention");
});

test("validatePosture: never throws", () => {
  const junk = [null, undefined, 5, "x", [], {}, { id: 5 }, { id: "a-b", joints: null, spine: 7, grips: [], hints: 3, contacts: "x", tags: null }, { id: "a-b", joints: { head: [Infinity] } }, base({ support: "seat+feet", hints: { seat: { height: NaN } } })];
  for (const j of junk) {
    const r = P.validatePosture(MAN, j);
    assert.equal(typeof r.ok, "boolean"); assert.ok(Array.isArray(r.errors) && Array.isArray(r.warnings) && r.metrics);
    if (j == null || typeof j !== "object" || !j.name) assert.equal(r.ok, false);
  }
  const r = P.validatePosture({}, base({}));
  assert.equal(r.ok, false); assert.ok(r.errors.some((e) => /cannot place/.test(e)));
  assert.equal(P.validatePosture(MAN, base({}), null).ok, true, "options may be null");
  const hostile = base({}); Object.defineProperty(hostile, "tags", { get() { throw new Error("boom"); }, enumerable: true });
  const h = P.validatePosture(MAN, hostile);
  assert.equal(h.ok, false); assert.ok(h.errors.length > 0 && Array.isArray(h.warnings) && h.metrics);
  assert.ok(P.placePose(MAN, { root: {}, angles: {} }, null).y > 0.5);
  assert.equal(P.validatePosture(null, base({})).ok, false);
});

test("validatePosture: a seat height hint moves the seat; floor sitting uses height 0", () => {
  const sit = base({ support: "seat", joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0] }, hints: { seat: { height: 0.6 } } });
  const r = P.validatePosture(MAN, sit);
  assert.equal(r.ok, true, r.errors.join("; ")); assert.equal(r.metrics.seatHeight, 0.6);
  const floor = P.validatePosture(MAN, base({ support: "seat", joints: { hip_LR: [60, 30, 30], knee_LR: [120, 0], ankle_LR: [0, 0, 0] }, hints: { seat: { height: 0 } } }));
  assert.equal(floor.metrics.seatHeight, 0);
});

// ---- proxies ------------------------------------------------------------------------------------------------------------------
for (const [name, body] of Object.entries(BODIES)) {
  test(`bodyProxies: structure and standing sole (${name})`, () => {
    const prox = bodyProxies(body);
    assert.ok(prox.n >= 25 && prox.n <= 40, `${prox.n} capsules`);
    assert.equal(bodyProxies(body), prox, "cached per body");
    const ids = new Set(prox.list.map((c) => c.id));
    assert.equal(ids.size, prox.n, "unique ids");
    for (const c of prox.list) {
      assert.ok(c.ra > 0.005 && c.rb > 0.005 && c.ra < 0.2 && c.rb < 0.2, `${c.id} radii ${c.ra} ${c.rb}`);
      assert.ok(c.a.off.every(Number.isFinite) && c.b.off.every(Number.isFinite));
      assert.ok(JOINTS.some((j) => j.id === c.a.joint) && JOINTS.some((j) => j.id === c.b.joint));
    }
    for (const id of ["head", "neck", "thigh_L", "thigh_R", "shank_L", "foot_L", "toes_R", "palm_L", "fingers_R", "upper_arm_L", "forearm_R", "kneecap_L", "buttock_R", "pelvis_L", "abdomen_R", "chest_L", "shoulders"]) assert.ok(ids.has(id), id);
    const kin = kinOf(body);
    kin.solve({}, { x: 0, y: body.joints.pelvis.offset[1], z: 0 });
    const w = proxyWorld(prox, kin);
    const lp = lowestPoint(w);
    near(lp.y, 0, 1e-9, "the lowest point of a standing body is the sole");
    assert.ok(/foot|toes/.test(lp.proxy), lp.proxy);
    assert.equal(selfPenetrations(prox, w).length, 0, "no gross overlap in the neutral pose: " + JSON.stringify(selfPenetrations(prox, w).slice(0, 2)));
    // the head capsule contains the vertex and the proxies roughly cover the skin landmarks of the legs and trunk
    const head = prox.byId.get("head");
    assert.ok(Math.abs(w.by[head] + w.rb[head] - body.stature) < 0.01 || Math.abs(w.ay[head] - w.ra[head]) < body.stature, "head top near the stature");
    near(w.by[head] + w.rb[head], body.stature, 0.005, "the top of the head capsule is the vertex");
  });
}

test("bodyProxies: cost per evaluation is far below 0.3 ms", () => {
  const prox = bodyProxies(MAN), kin = kinOf(MAN);
  const pose = randomPose(rng(2), 0.7, false);
  let w = null;
  const run = (n) => { for (let i = 0; i < n; i++) { kin.solve(pose.angles, { y: 1 }); w = proxyWorld(prox, kin, w); lowestPoint(w); } };
  run(300); // warm up
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) { w = proxyWorld(prox, kin, w); lowestPoint(w); }
  const perCall = (performance.now() - t0) / 2000;
  assert.ok(perCall < 0.3, `${(perCall * 1000).toFixed(1)} us per proxyWorld + lowestPoint`);
  const t1 = performance.now();
  for (let i = 0; i < 2000; i++) selfPenetrations(prox, w);
  const pairs = (performance.now() - t1) / 2000;
  assert.ok(pairs < 0.3, `${(pairs * 1000).toFixed(1)} us per selfPenetrations over ${prox.tol.length} pairs`);
});

test("capsuleOverlap: spheres, parallel and crossing capsules, tapered capsules", () => {
  const sph = (x, r) => ({ a: [x, 0, 0], b: [x, 0, 0], r });
  near(capsuleOverlap(sph(0, 0.1), sph(0.15, 0.1)), 0.05, 1e-12);
  near(capsuleOverlap(sph(0, 0.1), sph(0.3, 0.1)), -0.1, 1e-12);
  // two parallel segments 0.1 apart, radii 0.06 each
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 1, 0], r: 0.06 }, { a: [0.1, 0.2, 0], b: [0.1, 0.9, 0], r: 0.06 }), 0.02, 1e-12);
  // crossing segments (skew, 0.05 apart): perpendicular axes
  near(capsuleOverlap({ a: [-1, 0, 0], b: [1, 0, 0], r: 0.04 }, { a: [0, 0.05, -1], b: [0, 0.05, 1], r: 0.04 }), 0.03, 1e-12);
  // end to end
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 1, 0], r: 0.05 }, { a: [0, 1.08, 0], b: [0, 2, 0], r: 0.05 }), 0.02, 1e-12);
  // tapered: radius interpolated at the closest points (sphere-cone against a sphere)
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 1, 0], ra: 0.1, rb: 0.02 }, { a: [0.2, 1, 0], b: [0.2, 1, 0], r: 0.03 }), 0.02 + 0.03 - 0.2, 1e-12);
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 1, 0], ra: 0.1, rb: 0.02 }, { a: [0.15, 0, 0], b: [0.15, 0, 0], r: 0.1 }), 0.05, 1e-12);
  // Vector3 and {x,y,z} inputs
  near(capsuleOverlap({ a: new THREE.Vector3(0, 0, 0), b: { x: 0, y: 1, z: 0 }, r: 0.1 }, sph(0.15, 0.1)), 0.05, 1e-12);
  // degenerate (zero-length) capsules
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 0, 0], r: 0.1 }, { a: [0, 0, 0.1], b: [0, 0, 0.1], r: 0.1 }), 0.1, 1e-12);
});

test("selfPenetrations: tolerances, slack and the `all` option", () => {
  const prox = bodyProxies(MAN), kin = kinOf(MAN);
  kin.solve({ shoulder_L: [-19, -37, -34], elbow_L: [50] }, { y: 1 });
  const w = proxyWorld(prox, kin);
  const pens = selfPenetrations(prox, w);
  assert.ok(pens.length > 0 && pens.every((p) => p.excess > 0 && p.depth > p.tolerance));
  assert.ok(pens.every((p, i) => i === 0 || pens[i - 1].excess >= p.excess), "deepest first");
  assert.equal(selfPenetrations(prox, w, { slack: 1 }).length, 0);
  assert.ok(selfPenetrations(prox, w, { all: true }).length > pens.length);
});

// ---- grips --------------------------------------------------------------------------------------------------------------------
test("grips: structure, ROM for both hands, sources", () => {
  assert.ok(GRIP_NAMES.length >= 14);
  for (const n of ["relaxed", "open", "flat", "fist", "power", "precision", "hook", "trigger", "point", "wheel", "pinch", "cup", "thumbsup", "spread"]) assert.ok(GRIPS[n], n);
  assert.ok(Object.isFrozen(GRIPS) && Object.isFrozen(GRIPS.fist.joints.index_mcp));
  for (const [name, g] of Object.entries(GRIPS)) {
    assert.ok(g.label && g.description.length > 30 && g.source, name);
    assert.deepEqual(Object.keys(g.joints), HAND_JOINTS, `${name}: the 15 finger joints in table order`);
    for (const side of ["L", "R"]) {
      const a = gripAngles(name, side);
      assert.equal(Object.keys(a).length, 15);
      for (const [id, v] of Object.entries(a)) {
        assert.equal(v.length, JOINT_BY_ID[id].dof.length, `${name} ${id}: DOF count`);
        const c = clampAngles(id, v);
        assert.ok(!c.clamped.some(Boolean), `${name} ${id} ${v} is outside the ROM`);
        assert.deepEqual(v, GRIPS[name].joints[id.slice(0, -2)], "the right hand uses the same values");
      }
    }
  }
  assert.throws(() => gripAngles("claw", "L"), /unknown grip "claw"/);
  assert.throws(() => gripAngles("fist", "X"), /side/);
  assert.throws(() => gripAngles("__proto__", "L"), /unknown grip/);
});

for (const side of ["L", "R"]) {
  test(`grips: geometry on a real body, ${side} hand`, () => {
    const body = MAN, kin = kinOf(body);
    const S = side === "L" ? 1 : -1;
    const root = { y: body.joints.pelvis.offset[1] };
    const pos = (id) => lmWorld(body, kin, id);
    const tips = ["index", "middle", "ring", "little"].map((f) => `${f}_tip_${side}`);
    const palmN = new THREE.Vector3(-S, 0, 0); // the neutral palm faces the thigh: medially
    const solve = (grip) => kin.solve(gripAngles(grip, side), root);

    solve("open");
    const open = tips.map(pos);
    // fingers straight: each finger's joints are collinear (the finger length equals the straight distance mcp -> tip)
    for (const f of ["index", "middle", "ring", "little"]) {
      const j = (s) => kin.position(`${f}_${s}_${side}`), tip = pos(`${f}_tip_${side}`);
      const along = j("mcp").distanceTo(j("pip")) + j("pip").distanceTo(j("dip")) + j("dip").distanceTo(tip);
      assert.ok(j("mcp").distanceTo(tip) / along > 0.999, `${f} straight in 'open'`);
    }
    // spread: the span from the index to the little fingertip is wider than with the fingers together ('flat')
    const span = (pts) => pts[0].distanceTo(pts[3]);
    solve("flat");
    assert.ok(span(open) > span(tips.map(pos)) + 0.015, "open spreads the fingers");
    solve("spread");
    assert.ok(span(tips.map(pos)) > span(open) + 0.005, "spread is wider than open");

    // fist: every fingertip lands in front of the palm, on the palm side of the knuckles, within a thumb's width of the palm centre
    solve("fist");
    const palm = pos(`palm_centre_${side}`);
    for (const f of ["index", "middle", "ring", "little"]) {
      const tip = pos(`${f}_tip_${side}`), mcp = kin.position(`${f}_mcp_${side}`);
      assert.ok(tip.clone().sub(mcp).dot(palmN) > 0.01, `${f} fingertip is on the palm side of its knuckle`);
      assert.ok(tip.distanceTo(palm) < 0.045, `${f} fingertip ${(tip.distanceTo(palm) * 1000).toFixed(0)} mm from the palm centre`);
      assert.ok(tip.clone().sub(palm).dot(palmN) > -0.012, `${f} fingertip does not pass behind the palm plane`);
    }
    const thumb = pos(`thumb_tip_${side}`);
    assert.ok(thumb.clone().sub(palm).dot(palmN) > 0.03, "the thumb lies across the fingers, in front of the palm");
    // closed hand versus open hand: fingertips come closer to the wrist
    const wrist = kin.position(`wrist_${side}`);
    assert.ok(pos(`middle_tip_${side}`).distanceTo(wrist) < 0.09);
    solve("open");
    assert.ok(pos(`middle_tip_${side}`).distanceTo(wrist) > 0.17);

    // pinch and tripod bring the thumb tip to the fingertips
    solve("pinch");
    assert.ok(pos(`thumb_tip_${side}`).distanceTo(pos(`index_tip_${side}`)) < 0.025, "pinch: thumb meets the index fingertip");
    solve("tripod");
    const mid = pos(`index_tip_${side}`).add(pos(`middle_tip_${side}`)).multiplyScalar(0.5);
    assert.ok(pos(`thumb_tip_${side}`).distanceTo(mid) < 0.025, "tripod: thumb meets the index and middle fingertips");
    // point: the index stays straight, the others curl
    solve("point");
    const idx = kin.position(`index_mcp_${side}`).distanceTo(pos(`index_tip_${side}`)), mdl = kin.position(`middle_mcp_${side}`).distanceTo(pos(`middle_tip_${side}`));
    assert.ok(idx > 0.09 && mdl < 0.06, `point: index ${idx}, middle ${mdl}`);
    // thumbs up: thumb tip far from the fist
    solve("thumbsup");
    assert.ok(pos(`thumb_tip_${side}`).distanceTo(palm) > 0.08);
    // the grips differ from one another
    const sig = (g) => JSON.stringify(gripAngles(g, side));
    assert.equal(new Set(GRIP_NAMES.map(sig)).size, GRIP_NAMES.length);
  });
}

// ---- agreement with the rig ----------------------------------------------------------------------------------------------------
test("pose.js on rig.restBody agrees with rig.kin (forearm rebasing included)", async (t) => {
  let buildRig;
  try { ({ buildRig } = await import("../../site/js/human/rig.js")); } catch (e) { t.skip(`rig.js not importable: ${e.message}`); return; }
  const rig = buildRig(MAN, { skeleton: false });
  const pose = randomPose(rng(77), 0.8);
  pose.angles.forearm_L = [70]; pose.angles.forearm_R = [-60]; // pronation is where the rebased rig differs from the raw body
  const place = P.placePose(rig.restBody, pose);
  rig.setPose({ root: place, angles: pose.angles });
  let worst = 0, rawWorst = 0;
  const raw = P.solvePose(MAN, pose, place);
  const rawPos = Object.fromEntries(Object.keys(MAN.landmarks).map((id) => [id, lmWorld(MAN, raw, id)]));
  for (const id of Object.keys(MAN.landmarks)) {
    worst = Math.max(worst, rig.landmarkWorld(id).distanceTo(P.landmarkPosition(rig.restBody, pose, place, id)));
    rawWorst = Math.max(rawWorst, rig.landmarkWorld(id).distanceTo(rawPos[id]));
  }
  assert.ok(worst < 1e-9, `rig.restBody: ${worst}`);
  assert.ok(rawWorst > 0.005, `the raw body differs from the rig by up to ${(rawWorst * 1000).toFixed(1)} mm where the forearm is pronated`);
  assert.ok(rig.centerOfMass().point.distanceTo(P.centerOfMass(rig.restBody, pose, place).point) < 1e-9, "centre of mass");
  const lows = P.contactClearances(rig.restBody, pose, place, { floor: 0 }, { feet: "floor" });
  assert.ok(Math.abs(Math.min(...lows.map((r) => r.clearance)) - Math.min(...rig.contactPoints("feet").map((p) => p.y))) < 1e-9, "feet contacts");
  rig.dispose();
});

test("the worked example of POSE.md (section 6) is valid on six bodies; its two broken variants give the quoted messages", () => {
  const ex = {
    id: "sit-reach-forward-panel", name: "Seated, reaching forward to a panel", category: "Sitting", tags: ["seat", "reach", "one-hand", "forward"],
    description: "Seated upright on a seat at popliteal height, the right arm reaching forward and slightly up to press a control; the left hand rests in the lap.",
    source: "illustrative", support: "seat+feet", spine: { lumbar: [8, 0, 0], thoracic: [8, 0, 0] },
    joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0], shoulder_R: [75, 0, 0], elbow_R: [15], shoulder_L: [15, 0, 0], elbow_L: [60], head: [-5, 0, 0] },
    grips: { L: "relaxed", R: "point" },
  };
  for (const [sex, pct] of [["M", 5], ["M", 50], ["M", 95], ["F", 5], ["F", 50], ["F", 95]]) {
    const r = P.validatePosture(army(sex, pct), ex);
    assert.equal(r.ok, true, `${sex}${pct}: ${r.errors.join("; ")}`);
    assert.deepEqual(r.warnings, []);
    near(r.metrics.gaps.feet, 0, 0.015); assert.ok(r.metrics.balanceMargin > 0.07 && r.metrics.balanceMargin < 0.1, `balance margin ${r.metrics.balanceMargin}`);
  }
  const floats = P.validatePosture(MAN, { ...ex, joints: { ...ex.joints, knee_LR: [60, 0] } });
  assert.match(floats.errors[0], /^contact set "feet": its lowest point is 54 mm above the floor \(the posture is placed by its seat on a seat plane of 428 mm; support "seat\+feet" needs the feet to touch within 15 mm\)$/);
  assert.deepEqual(P.validatePosture(MAN, { ...ex, joints: { ...ex.joints, shoulder_R: [200, 0, 0] } }).errors, ["shoulder_R flex = 200\u00b0 is outside the range of motion [-60, 180] (clamps to 180\u00b0)"]);
});

test("POSE.md documents every support, grip, category and hint of the code", () => {
  const text = fs.readFileSync(path.join(ROOT, "docs/human3d/POSE.md"), "utf8");
  for (const s of Object.keys(P.SUPPORT_CARRIERS)) assert.ok(text.includes(`\`${s}\``), `support ${s}`);
  for (const g of GRIP_NAMES) assert.ok(text.includes(g), `grip ${g}`);
  for (const c of P.CATEGORIES) assert.ok(text.includes(c.name) && text.includes(c.id), `category ${c.name}`);
  for (const h of ["seat: { height }", "dynamic", "externalSupport", "contactTolerance", "load: { mass"]) assert.ok(text.includes(h), `hint ${h}`);
  for (const f of ["expandPosture", "clampPose", "mirrorPose", "blendPoses", "poseEquals", "placePose", "placePoseDetailed", "contactClearances", "centerOfMass", "balance", "validatePosture", "bodyProxies", "proxyWorld", "lowestPoint", "capsuleOverlap", "seatHeightFor"]) assert.ok(text.includes(f), `function ${f}`);
  for (const f of Object.keys(P)) assert.ok(text.includes(f), `export ${f} of pose.js is not in POSE.md`);
});

// ---- documentation ------------------------------------------------------------------------------------------------------------
test("docs/human3d/POSE.md contains the current DOF table generated from skeleton.js", () => {
  const text = fs.readFileSync(path.join(ROOT, "docs/human3d/POSE.md"), "utf8");
  const a = text.indexOf("<!-- dof-table:begin -->"), b = text.indexOf("<!-- dof-table:end -->");
  assert.ok(a >= 0 && b > a, "markers missing");
  assert.equal(text.slice(a + "<!-- dof-table:begin -->".length, b).trim(), dofTable().trim(), "regenerate with: node scripts/human_dof_table.mjs --update-docs");
});
