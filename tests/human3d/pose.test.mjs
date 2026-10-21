// pose.js (expand, clamp, mirror, blend, place, contacts, centre of mass, balance, validate), proxies.js and the grips of postures/grips.js.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.test.mjs"
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody, referencePose, CONSTANTS } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, jointQuaternion } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import * as P from "../../site/js/human/pose.js";
import * as PX from "../../site/js/human/proxies.js";
import { bodyProxies, proxyWorld, lowestPoint, lowestSkinPoint, capsuleOverlap, selfPenetrations } from "../../site/js/human/proxies.js";
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
  assert.equal(t.angles.shoulder_L[1], 84); assert.equal(t.angles.shoulder_R[1], 84);
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
      const prox = bodyProxies(body), w = proxyWorld(prox, kin);
      assert.ok(lowestSkinPoint(prox, kin, w).y >= -1e-12, "no skin section below the floor"); // not the capsules: the end spheres of the toes and fingers stick out beyond the skin
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
  // The margin of quiet standing is the distance from the centre of mass to the heel edge of the support: with the centre of mass 37.5 % of the foot length from the heel (fit.js leanLegs,
  // MODEL.md 7.1) it is 60 to 80 mm over the bodies of the sweep (was 23 to 31 mm while the centre of mass stood 2 mm in front of the ankle and 21 % of the foot from the heel: the old band
  // 10 to 60 mm).
  assert.equal(b.inside, true); assert.ok(b.margin > 0.05 && b.margin < 0.09, `margin ${b.margin}`);
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
  // Leaning back with the arms stretched forward: the held weight at the hands is the counterweight. The posture is a family, not one tuned input: the body leaned back about the ankles by
  // `back` degrees (root flex -back; ankles -back keep the soles flat) on top of the extended spine and hips; the centre of mass of quiet standing (MODEL.md 7.1) is 60 to 80 mm from the heel
  // edge and each degree of lean moves it by about 16 mm, so at 5 degrees back this posture is 40 mm or more outside without the load (it needs it) and the load brings it back inside.
  // For every lean of the family, whatever the margin without the load, 25 kg held at the grip centres move the centre of mass forward and raise the margin by 40 to 120 mm.
  const lean = (back) => ({ root: { flex: -back }, joints: { shoulder_LR: [90, 0, 0], hip_LR: [-10, 0, 0], ankle_LR: [-back] }, spine: { lumbar: [-35, 0, 0], thoracic: [-20, 0, 0] } });
  for (const back of [2, 3, 4, 5, 6]) {
    const without = P.validatePosture(MAN, base(lean(back))), withLoad = P.validatePosture(MAN, base({ ...lean(back), hints: { load: { mass: 25 } } }));
    const gain = withLoad.metrics.balanceMargin - without.metrics.balanceMargin;
    assert.ok(gain > 0.04 && gain < 0.12 && withLoad.metrics.com[2] > without.metrics.com[2], `back ${back}: the 25 kg held change the margin by ${gain}`);
    if (back === 5) { // the case the rule is about: falls without the weight, stands with it
      assert.ok(without.errors.some((e) => /centre of mass/.test(e)) && without.metrics.balanceMargin < -0.04, `without the load: ${without.metrics.balanceMargin}`);
      assert.equal(withLoad.ok, true, withLoad.errors.join("; "));
      assert.ok(withLoad.metrics.balanceMargin > -0.04, `with the load: ${withLoad.metrics.balanceMargin}`);
    }
  }
  const heavier = (m) => P.validatePosture(MAN, base({ ...lean(5), hints: { load: { mass: m } } })).metrics.balanceMargin;
  assert.ok(heavier(10) < heavier(25) && heavier(25) < heavier(40), "a heavier load pulls the centre of mass further forward, monotonically");
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
  // tapered: the maximum over the axis of r(s) + r2 - distance, not the radius at the closest point. Sphere-cone against a sphere beside its small end: with e = 1 - s
  // the derivative of 0.1 - 0.08 s + 0.03 - sqrt(0.2^2 + e^2) vanishes at e = 0.08 * 0.2 / sqrt(1 - 0.08^2), a gain of 0.64 mm over the closest point's -0.15
  const e = (0.08 * 0.2) / Math.sqrt(1 - 0.08 ** 2);
  near(capsuleOverlap({ a: [0, 0, 0], b: [0, 1, 0], ra: 0.1, rb: 0.02 }, { a: [0.2, 1, 0], b: [0.2, 1, 0], r: 0.03 }), 0.1 - 0.08 * (1 - e) + 0.03 - Math.hypot(0.2, e), 1e-12);
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
test("pose.js on rig.restBody agrees with rig.kin (forearm rebasing included); a plain body gives the same figure, an independent FK of body.joints does not", async (t) => {
  let buildRig;
  try { ({ buildRig } = await import("../../site/js/human/rig.js")); } catch (e) { t.skip(`rig.js not importable: ${e.message}`); return; }
  const rig = buildRig(MAN, { skeleton: false });
  const pose = randomPose(rng(77), 0.8);
  pose.angles.forearm_L = [70]; pose.angles.forearm_R = [-60]; // pronation is where the rebased rig differs from the raw body
  const place = P.placePose(rig.restBody, pose);
  near(place.y, P.placePose(MAN, pose).y, 1e-12, "the same placement from the plain body");
  rig.setPose({ root: place, angles: pose.angles });
  let worst = 0, worstPlain = 0, rawWorst = 0;
  const raw = kinOf(MAN); // what a Kinematics built from body.joints (the elbow-centred twist axis) says
  raw.solve(pose.angles, place);
  for (const id of Object.keys(MAN.landmarks)) {
    worst = Math.max(worst, rig.landmarkWorld(id).distanceTo(P.landmarkPosition(rig.restBody, pose, place, id)));
    worstPlain = Math.max(worstPlain, rig.landmarkWorld(id).distanceTo(P.landmarkPosition(MAN, pose, place, id)));
    rawWorst = Math.max(rawWorst, rig.landmarkWorld(id).distanceTo(lmWorld(MAN, raw, id)));
  }
  assert.ok(worst < 1e-9, `rig.restBody: ${worst}`);
  assert.ok(worstPlain < 1e-9, `plain body: ${worstPlain}`);
  assert.ok(rawWorst > 0.005, `the raw offsets differ from the rig by up to ${(rawWorst * 1000).toFixed(1)} mm where the forearm is pronated`);
  assert.ok(rig.centerOfMass().point.distanceTo(P.centerOfMass(rig.restBody, pose, place).point) < 1e-9, "centre of mass");
  assert.ok(rig.centerOfMass().point.distanceTo(P.centerOfMass(MAN, pose, place).point) < 1e-9, "centre of mass, plain body");
  const lows = P.contactClearances(rig.restBody, pose, place, { floor: 0 }, { feet: "floor" });
  assert.ok(Math.abs(Math.min(...lows.map((r) => r.clearance)) - Math.min(...rig.contactPoints("feet").map((p) => p.y))) < 1e-9, "feet contacts");
  rig.dispose();
});

// ---- regression tests of the verifier's defects (round 2) ------------------------------------------------------------------------
const popFile = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations", rel)));
const popBody = (rel, percentile = 50) => fitBody(percentileProfile(popFile(rel), { percentile, meanStature: true }));
const lazy = async (t, file) => { try { return await import(file); } catch (e) { t.skip(`${file} not importable: ${e.message}`); return null; } };

test("defect: an explicit vertebra angle beyond that vertebra's own range is kept as written and rejected, never spread over its neighbours (rule 2)", () => {
  const cases = [[{ L3: [40, 0, 0] }, "L3", 0, 40, /L3 flex = 40° is outside the range of motion/], [{ T7: [-80] }, "T7", 0, -80, /T7 flex = -80° is outside/], [{ C1: [0, 0, 200] }, "C1", 2, 200, /C1 rot = 200° is outside/]];
  for (const [joints, id, c, value, re] of cases) {
    const e = P.expandPosture({ id: "v", joints });
    near(e.angles[id][c], value, 1e-12, `${id} keeps the requested value`);
    for (const other of Object.values(REGIONS).find((r) => r.joints.includes(id)).joints) if (other !== id) assert.ok(!e.angles[other] || e.angles[other][c] === 0, `${other} must not take the surplus of ${id}`);
    assert.deepEqual(e.shortfall, [], "no region shortfall is invented for it");
    for (const body of [MAN, WOMAN5]) {
      const r = P.validatePosture(body, base({ joints }));
      assert.equal(r.ok, false, `${id}: ${r.errors}`);
      assert.equal(r.errors.length, 1, r.errors.join("\n"));
      assert.match(r.errors[0], re);
    }
  }
  // inside its range an addition still goes on top of the region total
  const ok = P.expandPosture({ id: "w", spine: { lumbar: [20, 0, 0] }, joints: { L3: [5, 0, 0] } });
  near(REGIONS.lumbar.joints.reduce((s, id) => s + ok.angles[id][0], 0), 25, 1e-9);
  assert.equal(P.validatePosture(MAN, base({ spine: { lumbar: [20, 0, 0] }, joints: { L3: [5, 0, 0] } })).ok, true);
});

test("defect: a region total that the vertebrae can take is never reported as a shortfall, whatever per-vertebra additions are written", () => {
  // the case of the verifier: additions of both signs, three of them (T9, T4, T1) beyond their own vertebra's range. The old expandRegions pinned those levels, moved the
  // surplus onto the others and reported "requested 40.79, the vertebrae can take 39.19". Now the out-of-range ones are range-of-motion errors that name the vertebra and
  // no shortfall is invented; with in-range additions the old algorithm never dropped anything (0 of 40,000 random cases), the loop below keeps it that way.
  const joints = { T10: [-1.78, 0, 0], T9: [3.87, 0, 0], T8: [0.83, 0, 0], T4: [4.41, 0, 0], T3: [-0.75, 0, 0], T1: [-4.6, 0, 0] };
  const e = P.expandPosture({ id: "a", spine: { thoracic: [40.79, 0, 0] }, joints });
  assert.deepEqual(e.shortfall, []);
  const r = P.validatePosture(MAN, base({ spine: { thoracic: [40.79, 0, 0] }, joints }));
  assert.deepEqual(r.errors.map((m) => /^(T\d+) flex = /.exec(m)?.[1]), ["T9", "T4", "T1"], r.errors.join("\n"));
  assert.equal(r.metrics.regionShortfalls, 0);
  for (const id of ["T9", "T4", "T1"]) near(e.angles[id][0], joints[id][0], 1e-12, `${id} keeps its written value`);
  // random cases against an independent bisection on the water level
  const rand = rng(31);
  const channels = [["flex", "weights"], ["lat", "weightsLat"], ["rot", "weightsRot"]];
  let n = 0;
  for (let it = 0; it < 1500; it++) {
    const [name, rg] = Object.entries(REGIONS)[Math.floor(rand() * 3)], c = Math.floor(rand() * 3), w = rg[channels[c][1]], ids = rg.joints;
    const lo = ids.map((id) => JOINT_BY_ID[id].dof[c].min), hi = ids.map((id) => JOINT_BY_ID[id].dof[c].max);
    const add = ids.map((_, i) => (rand() < 0.5 ? 0 : lo[i] + rand() * (hi[i] - lo[i])));
    const A = lo.map((l, i) => Math.min(0, l - add[i])), B = hi.map((h, i) => Math.max(0, h - add[i]));
    const sa = A.reduce((s, v) => s + v, 0), sb = B.reduce((s, v) => s + v, 0), total = sa + rand() * (sb - sa);
    let l0 = -1e4, l1 = 1e4;
    for (let k = 0; k < 200; k++) { const m = (l0 + l1) / 2, s = w.reduce((t, wi, i) => t + Math.min(B[i], Math.max(A[i], m * wi)), 0); if (s < total) l0 = m; else l1 = m; }
    const ref = w.map((wi, i) => Math.min(B[i], Math.max(A[i], l1 * wi)));
    const vals = [0, 0, 0];
    const joints = Object.fromEntries(ids.map((id, i) => [id, vals.map((_, q) => (q === c ? add[i] : 0))]).filter(([id], i) => add[i] !== 0));
    const r = P.expandPosture({ id: "r", spine: { [name]: vals.map((_, q) => (q === c ? total : 0)) }, joints });
    assert.deepEqual(r.shortfall, [], `${name} ${channels[c][0]} total ${total} is feasible`);
    ids.forEach((id, i) => { const got = r.angles[id]?.[c] ?? 0; near(got, add[i] + ref[i], 1e-6, `${id}`); });
    n++;
  }
  assert.equal(n, 1500);
});

test("defect: blendPoses stays inside the range of motion (corners and random poses of every joint with 2 or more DOF), t from 0.1 to 0.9", () => {
  const rand = rng(12);
  const corners = (j) => { const out = []; const rec = (i, a) => { if (i === j.dof.length) { out.push(clampAngles(j.id, a).angles); return; } for (const v of [j.dof[i].min, j.dof[i].max, 0]) rec(i + 1, [...a, v]); }; rec(0, []); return out; };
  let n = 0;
  for (const j of JOINTS.filter((x) => x.parent && x.dof.length >= 2)) {
    const pool = [...corners(j), ...Array.from({ length: 12 }, () => clampAngles(j.id, j.dof.map((d) => d.min + rand() * (d.max - d.min))).angles)];
    for (let i = 0; i < pool.length; i++) for (let k = 0; k < pool.length; k += 2) for (const t of [0.1, 0.5, 0.9]) {
      const r = P.blendPoses({ angles: { [j.id]: pool[i] } }, { angles: { [j.id]: pool[k] } }, t).angles[j.id], c = clampAngles(j.id, r).angles;
      r.forEach((x, q) => assert.ok(Math.abs(x - c[q]) < 1e-7, `${j.id} ${JSON.stringify(pool[i])} -> ${JSON.stringify(pool[k])} at ${t}: ${JSON.stringify(r)} leaves the range`));
      n++;
    }
  }
  assert.ok(n > 20000, `${n} blends`);
  // the example of the verifier: shoulder flexion 170 -> extension 60 must not pass flexion -157
  for (const t of [0.25, 0.5, 0.75]) {
    const m = P.blendPoses({ angles: { shoulder_L: [170, 0, 0] } }, { angles: { shoulder_L: [-60, 0, 0] } }, t).angles.shoulder_L;
    assert.ok(m[0] >= -60 && m[0] <= 180, `flexion ${m[0]} at ${t}`);
  }
  // whole random poses, as an animation between two library postures would blend them
  for (let it = 0; it < 300; it++) assert.equal(P.clampPose(P.blendPoses(randomPose(rand, 1, false), randomPose(rand, 1, false), 0.5)).clamped.length, 0);
});

test("defect: blendPoses does not make the hand flick when a shoulder or hip swing is near 180 degrees", () => {
  const kin = kinOf(MAN), rand = rng(5);
  for (const [jid, tip] of [["shoulder_L", "wrist_L"], ["hip_L", "ankle_L"]]) {
    const j = JOINT_BY_ID[jid];
    let worstRatio = 0, worstStep = 0;
    for (let it = 0; it < 250; it++) {
      const mk = () => { for (;;) { const a = j.dof.map((d) => d.min + rand() * (d.max - d.min)); if (Math.hypot(a[0], a[1]) <= 178) return a; } };
      const a = { angles: { [jid]: mk() } }, b = { angles: { [jid]: mk() } };
      let prev = null;
      const steps = [];
      for (let k = 0; k <= 200; k++) { kin.solve(P.blendPoses(a, b, k / 200).angles, { y: 1 }); const cur = kin.position(tip).clone(); if (prev) steps.push(cur.distanceTo(prev)); prev = cur; }
      const mean = steps.reduce((s, v) => s + v, 0) / steps.length, mx = Math.max(...steps);
      worstStep = Math.max(worstStep, mx);
      if (mean > 1e-3) worstRatio = Math.max(worstRatio, mx / mean);
    }
    assert.ok(worstRatio < 3.5, `${jid}: the largest step is ${worstRatio.toFixed(1)} times the mean step`);
    assert.ok(worstStep < 0.02, `${jid}: ${(worstStep * 1000).toFixed(0)} mm in 1/200 of t`);
  }
});

test("defect: pose.js poses the figure the rig draws, from a plain BodyModel as from rig.restBody (forearm pronation, sternum)", async (t) => {
  const R = await lazy(t, "../../site/js/human/rig.js");
  if (!R) return;
  for (const body of [MAN, WOMAN5]) {
    const rig = R.buildRig(body, { skeleton: false }), rand = rng(3);
    assert.equal(P.figureOf(rig.restBody), rig.restBody, "a rig.restBody passes through unchanged");
    assert.equal(P.figureOf(body), P.figureOf(body), "stable per body");
    let worst = 0;
    for (let it = 0; it < 40; it++) {
      const pose = randomPose(rand, 0.9), root = { x: 0.2, y: 1, z: 0.1, ...pose.root };
      rig.setPose({ root, angles: pose.angles }, { clamp: false });
      for (const id of Object.keys(body.landmarks)) worst = Math.max(worst, rig.landmarkWorld(id).distanceTo(P.landmarkPosition(body, pose, root, id)), rig.landmarkWorld(id).distanceTo(P.landmarkPosition(rig.restBody, pose, root, id)));
      assert.ok(rig.centerOfMass().point.distanceTo(P.centerOfMass(body, pose, root).point) < 1e-9, "centre of mass");
    }
    assert.ok(worst < 1e-9, `${worst}`);
    // the case of the verifier: a forearm on a desk, pronation 80, elbow 80: the palm is where the rig draws it
    const pose = { root: {}, angles: { shoulder_L: [50, 5, 0], elbow_L: [80], forearm_L: [80], wrist_L: [-20, 0] } }, root = { y: 1 };
    rig.setPose({ root, angles: pose.angles }, { clamp: false });
    for (const id of ["palm_centre_L", "grip_centre_L", "middle_tip_L", "stylion_L", "thumb_tip_L"]) assert.ok(rig.landmarkWorld(id).distanceTo(P.landmarkPosition(body, pose, root, id)) < 1e-9, id);
    // placement and clearances follow: the palm carrier of a quadruped sits where the rig draws the palms
    const quad = { root: { flex: 90 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0], shoulder_L: [90, 0, 0], shoulder_R: [90, 0, 0], forearm_L: [60], forearm_R: [60] } };
    const placed = P.placePose(body, quad, { support: "hands-knees" });
    rig.setPose({ root: placed, angles: quad.angles }, { clamp: false });
    near(Math.min(...rig.contactPoints("knees").map((p) => p.y)), 0, 1e-9, "the knees touch the floor");
    near(Math.min(rig.landmarkWorld("palm_centre_L").y, rig.landmarkWorld("palm_centre_R").y), Math.min(...P.contactClearances(body, quad, placed, { floor: 0 }, { palms: "floor" }).map((r) => r.clearance)), 1e-9, "the palm clearances are the rig's");
    rig.dispose();
  }
});

test("defect: the lowest point of a lying body is the lowest point of its skin (within 5 mm), lowestSkinPoint is exact for the sections", async (t) => {
  const R = await lazy(t, "../../site/js/human/rig.js"), S = await lazy(t, "../../site/js/human/body.js");
  if (!R || !S) return;
  const poses = {
    supine: ["body", { root: { flex: -90 }, angles: { ankle_L: [-15, 0, 0], ankle_R: [-15, 0, 0] } }],
    prone: ["body", { root: { flex: 90 }, angles: { ankle_L: [-45, 0, 0], ankle_R: [-45, 0, 0] } }],
    side: ["body", { root: { lat: 90 }, angles: {} }],
    supine_flat_feet: ["body", { root: { flex: -90 }, angles: {} }],
  };
  const bodies = [MAN, WOMAN5, army("M", 95), army("F", 50), popBody("germany/army/both.json"), popBody("canada/tri-service/M.json"), popBody("czech-republic/tri-service/F.json", 25)];
  let worstSink = 0, worstFloat = 0;
  for (const body of bodies) {
    const rig = R.buildRig(body, { skinBuilder: (b, bones, o) => S.buildSkin(b, bones, { ...o, }), skeleton: false });
    for (const [name, [support, pose]] of Object.entries(poses)) {
      const placed = P.placePose(body, pose, { support });
      rig.setPose({ root: placed, angles: pose.angles }, { clamp: false });
      const y = rig.lowestY({ skin: true });
      worstSink = Math.max(worstSink, -y); worstFloat = Math.max(worstFloat, y);
      assert.ok(Math.abs(y) < 0.005, `${name}: the skin is ${(y * 1000).toFixed(1)} mm from the floor`);
    }
    rig.dispose();
  }
  assert.ok(worstSink < 0.005 && worstFloat < 0.005);
  // lowestSkinPoint against a brute-force sampling of the superellipse sections (margin of the skin between the sections: 3 mm)
  const px = bodyProxies(P.figureOf(MAN)), rand = rng(21), kin = kinOf(P.figureOf(MAN));
  for (let it = 0; it < 15; it++) {
    const pose = randomPose(rand, 0.9), root = { x: 0, y: 1, z: 0, ...pose.root };
    kin.solve(pose.angles, root);
    const got = lowestSkinPoint(px, kin, { n: 0 });
    let best = Infinity;
    for (const r of px.rings) {
      const n = r.q / (r.q - 1);
      for (let k = 0; k < 1440; k++) {
        const th = (k / 1440) * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
        const x = Math.sign(c) * r.rx * Math.abs(c) ** (2 / n), z = Math.sign(s) * r.rz * Math.abs(s) ** (2 / n);
        const p = kin.toWorld(r.joint, [r.off[0] + x * r.ex[0] + z * r.ez[0], r.off[1] + x * r.ex[1] + z * r.ez[1], r.off[2] + x * r.ex[2] + z * r.ez[2]]);
        best = Math.min(best, p.y);
      }
    }
    near(got.y, best - 0.003, 5e-5, "lowest skin point of the sections");
  }
});

test("defect: the buttocks of a reclined seated posture do not sink into the seat plane (rule 3)", () => {
  for (const body of [MAN, army("F", 50)]) {
    const r = P.validatePosture(body, base({ support: "seat+feet", root: { flex: -45 }, joints: { hip_LR: [45, 0, 0], knee_LR: [90] } }));
    assert.ok(r.errors.some((e) => /sinks? into the seat: .*buttock_extremity by \d+ mm/.test(e)), r.errors.join("\n"));
    // a posture that only leans back 10 degrees sits as usual
    const ok = P.validatePosture(body, base({ support: "seat+feet", root: { flex: -10 }, joints: { hip_LR: [100, 0, 0], knee_LR: [90] } }));
    assert.ok(!ok.errors.some((e) => /sink/.test(e)), ok.errors.join("\n"));
  }
});

test("defect: names that are inherited object properties are errors for supports and surfaces, not a NaN root", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.throws(() => P.placePose(MAN, P.neutralPose(), { carriers: { feet: name } }), /surface/, `surface ${name}`);
    assert.throws(() => P.placePose(MAN, P.neutralPose(), { support: name }), /unknown support/, `support ${name}`);
    assert.throws(() => P.contactClearances(MAN, P.neutralPose(), { y: 1 }, { floor: 0 }, { feet: name }), /surface/, `clearances ${name}`);
    assert.equal(P.validatePosture(MAN, base({ support: name })).ok, false);
  }
  assert.equal(Number.isFinite(P.placePose(MAN, P.neutralPose(), { carriers: { feet: "floor" } }).y), true);
});

test("defect: the reference postures are accepted for the P5 and P95 bodies of the populations whose thighs overlap in the neutral pose", () => {
  const files = ["australia/army/both.json", "india/army/M.json", "united-states/officers/M.json"];
  for (const rel of files) for (const pct of [5, 95]) {
    const body = popBody(rel, pct);
    for (const p of REFERENCE) {
      const r = P.validatePosture(body, p);
      assert.equal(r.ok, true, `${rel} P${pct} ${p.id}: ${r.errors.join("; ")}`);
    }
  }
  // the tolerance was raised for the pair that overlaps in the reference postures, and only for it
  const body = popBody("australia/army/both.json", 5), px = bodyProxies(body), plain = bodyProxies(MAN);
  const pair = (x, a, b) => { const i = x.byId.get(a), j = x.byId.get(b); for (let k = 0; k < x.tol.length; k++) if (x.pairs[2 * k] === Math.min(i, j) && x.pairs[2 * k + 1] === Math.max(i, j)) return x.tol[k]; return null; };
  assert.ok(pair(px, "thigh_L", "thigh_R") > 0.055 * px.softness + 0.005, "thigh-thigh tolerance follows the body's own neutral overlap");
  near(pair(plain, "thigh_L", "thigh_R"), 0.055 * plain.softness, 1e-9, "unchanged for a body that does not need it");
  // crossing the legs deeply is still rejected, and the message says what to look at
  const crossed = P.validatePosture(MAN, base({ joints: { hip_LR: [0, -20, 0] } }));
  assert.equal(crossed.ok, false);
  assert.ok(crossed.errors.some((e) => /thigh.* and thigh.* overlap.*the thighs press into each other/.test(e)), crossed.errors.join("\n"));
});

test("defect: the limb capsules follow the rings of their tube, the thigh in two pieces (no ring end is further than 30 mm outside)", () => {
  for (const body of [army("F", 50), MAN, WOMAN5, army("M", 95)]) {
    const px = bodyProxies(body), kin = kinOf(body);
    kin.solve({}, { y: body.joints.pelvis.offset[1] });
    const W = proxyWorld(px, kin);
    const outside = (p) => { let best = Infinity; for (let k = 0; k < W.n; k++) { const ax = W.ax[k], ay = W.ay[k], az = W.az[k], bx = W.bx[k] - ax, by = W.by[k] - ay, bz = W.bz[k] - az, L = bx * bx + by * by + bz * bz, tt = L > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * bx + (p[1] - ay) * by + (p[2] - az) * bz) / L)) : 0; best = Math.min(best, Math.hypot(p[0] - ax - bx * tt, p[1] - ay - by * tt, p[2] - az - bz * tt) - (W.ra[k] + tt * (W.rb[k] - W.ra[k]))); } return best; };
    for (const tube of ["thigh_L", "upper_arm_L", "forearm_L", "shank_L"]) {
      for (const r of body.shape.tubes[tube].rings) {
        if (r.id === "sh_malleolus") continue; // belongs to the foot capsule
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const o = outside([r.c[0] + dx * r.rx, r.c[1], r.c[2] + dz * r.rz]);
          assert.ok(o < 0.03, `${tube} ring ${r.id} (${dx},${dz}) is ${(o * 1000).toFixed(0)} mm outside every capsule`);
        }
      }
    }
  }
  assert.ok(bodyProxies(MAN).n <= 40 && bodyProxies(MAN).byId.has("thigh_lo_L"));
});

test("defect: thumb, index, ring and little finger have capsules; a thumb pushed into the head is detected", () => {
  const px = bodyProxies(MAN);
  for (const s of ["L", "R"]) for (const f of ["fingers", "index", "ring", "little", "thumb"]) assert.ok(px.byId.has(`${f}_${s}`), `${f}_${s}`);
  const rb = P.figureOf(MAN), root = { y: rb.joints.pelvis.offset[1] };
  const vx = P.landmarkPosition(rb, P.neutralPose(), root, "vertex"), me = P.landmarkPosition(rb, P.neutralPose(), root, "menton");
  const c = new THREE.Vector3(0, (vx.y + me.y) / 2 + 0.01, 0.028), rand = rng(5);
  let inside = 0, accepted = 0;
  for (let it = 0; it < 20000; it++) {
    const a = P.clampPose({ angles: { shoulder_L: [-30 + rand() * 210, -20 + rand() * 110, -60 + rand() * 120], elbow_L: [rand() * 150], forearm_L: [-60 + rand() * 120], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] } }).pose.angles;
    const tip = P.landmarkPosition(rb, { angles: a }, root, "thumb_tip_L");
    if ((((tip.x - c.x) / 0.0766 / 0.6) ** 2 + ((tip.y - c.y) / 0.1175 / 0.6) ** 2 + ((tip.z - c.z) / 0.0985 / 0.6) ** 2) >= 1) continue;
    inside++;
    // the hand of the probe is the neutral one, so the posture has no grip either
    if (P.validatePosture(rb, { ...base({ joints: a }), grips: {} }).ok) accepted++;
  }
  assert.ok(inside > 5, `${inside} probes with the thumb tip 40 mm or more inside the head`);
  assert.equal(accepted, 0, `${accepted} of ${inside} accepted`);
});

test("defect: capsuleOverlap is exact for tapered capsules (strong taper, thigh against thigh), and never below the closest-point value", () => {
  const rand = rng(40), V = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
  const brute = (c1, c2) => { // fine grid, then pattern refinement
    const f = (s, t) => { const p = c1.a.clone().lerp(c1.b, s), q = c2.a.clone().lerp(c2.b, t); return c1.ra + (c1.rb - c1.ra) * s + c2.ra + (c2.rb - c2.ra) * t - p.distanceTo(q); };
    let bs = 0, bt = 0, bv = -Infinity;
    for (let i = 0; i <= 80; i++) for (let j = 0; j <= 80; j++) { const v = f(i / 80, j / 80); if (v > bv) { bv = v; bs = i / 80; bt = j / 80; } }
    for (let w = 1 / 80; w > 1e-9; w *= 0.7) for (const ds of [-w, 0, w]) for (const dt of [-w, 0, w]) { const s = Math.min(1, Math.max(0, bs + ds)), t = Math.min(1, Math.max(0, bt + dt)), v = f(s, t); if (v > bv) { bv = v; bs = s; bt = t; } }
    return bv;
  };
  let worst = 0;
  for (let it = 0; it < 250; it++) {
    const mk = () => { const a = V(), b = it % 9 === 0 ? a.clone() : a.clone().add(V().multiplyScalar(0.6)), ra = 0.02 + rand() * 0.08; return { a, b, ra, rb: ra * (0.3 + 0.7 * rand()) }; };
    const c1 = mk(), c2 = mk();
    worst = Math.max(worst, Math.abs(capsuleOverlap(c1, c2) - brute(c1, c2)));
  }
  assert.ok(worst < 2e-6, `worst difference ${worst}`);
  // two thighs of a woman side by side: the old formula said "apart by 33 mm" for capsules whose spheres are 2 mm apart
  const th = (x) => ({ a: new THREE.Vector3(x, 0.82, -0.05), b: new THREE.Vector3(x, 0.47, -0.13), ra: 0.09, rb: 0.058 });
  near(capsuleOverlap(th(0.086), th(-0.086)), brute(th(0.086), th(-0.086)), 1e-6);
});

test("defect: expandPosture names a sided joint written with _LR correctly", () => {
  assert.throws(() => P.expandPosture({ id: "m", joints: { hip_L_LR: [1] } }), (e) => /joints\.hip_L_LR: "hip_L" already names one side: write "hip_L" for that side or "hip_LR" for both/.test(e.message) && !/not a paired joint/.test(e.message));
  assert.throws(() => P.expandPosture({ id: "m", joints: { head_LR: [1] } }), /"head" is not a paired joint/);
});

// ---- regressions of the second verification round -----------------------------------------------------------------------------
test("defect: the verdict of the validator does not depend on the heading of the posture (seat sink footprint in the body's own frame)", () => {
  const iso = REFERENCE.find((q) => q.id === "iso-7250-sitting");
  const recl = (h, rot = 0) => base({ support: "seat+feet", root: { heading: h, flex: -45, rot }, joints: { hip_LR: [90], knee_LR: [90] }, hints: { dynamic: true } });
  let sinking = 0;
  for (const body of [MAN, army("F", 50), WOMAN5, army("M", 95)]) {
    for (const h of [0, 30, 45, 90, 135, 180, -90, -135]) {
      const r = P.validatePosture(body, { ...structuredClone(iso), root: { heading: h } });
      assert.ok(r.ok, `ISO sitting at heading ${h}: ${r.errors.join("; ")}`);
    }
    // the buttocks of a reclined seated posture sink into the seat at every heading, by the same depth
    const msgs = [0, 30, 90, 180, -90].map((h) => P.validatePosture(body, recl(h)).errors.find((e) => /sink into the seat/.test(e)));
    assert.ok(msgs.every((m) => m === msgs[0]), msgs.join(" | "));
    sinking += msgs[0] ? 1 : 0;
  }
  assert.ok(sinking >= 3, `${sinking} of 4 bodies sink into the seat when reclined by 45 degrees`);
  // a twist of the pelvis about the vertical (root.rot with the pelvis upright) is the same turn
  for (const body of [MAN, army("F", 50)]) {
    const a = P.validatePosture(body, base({ support: "seat+feet", root: { heading: 135 }, joints: { hip_LR: [90], knee_LR: [90] } })), b = P.validatePosture(body, base({ support: "seat+feet", root: { rot: 135 }, joints: { hip_LR: [90], knee_LR: [90] } }));
    assert.deepEqual(b.errors, a.errors);
  }
  // 1200 random seated and standing postures: every error list is the same at five headings
  const rand = rng(77), bodies = [MAN, army("F", 50), WOMAN5, army("M", 95)];
  for (let it = 0; it < 1200; it++) {
    const pose = randomPose(rand, 0.4, false), sup = ["seat+feet", "seat", "feet", "knees"][it % 4], body = bodies[it % 4];
    if (sup.startsWith("seat")) { pose.angles.hip_L = pose.angles.hip_R = [60 + rand() * 50, 0, 0]; pose.angles.knee_L = pose.angles.knee_R = [60 + rand() * 40, 0]; }
    const flex = (rand() - 0.5) * 100, at = (heading) => P.validatePosture(body, { ...base({ support: sup, joints: pose.angles, hints: { dynamic: true } }), root: { flex, heading } });
    const r0 = at(0);
    for (const h of [37, 90, 135, 180, -100]) assert.deepEqual(at(h).errors, r0.errors, `random posture ${it} at heading ${h}`);
  }
});

test("defect: upright kneeling (support knees, thighs vertical, shanks on the floor) is stable, kneeling too far forward or back is still not", () => {
  const kneel = (hip, knee, ankle = -60) => base({ id: "kneel-upright", name: "Kneeling", category: "Kneeling & squatting", tags: ["kneeling"], support: "knees", joints: { hip_LR: [hip], knee_LR: [knee], ankle_LR: [ankle] } });
  for (const body of [MAN, army("F", 50), WOMAN5, army("M", 95), TALL]) {
    const up = P.validatePosture(body, kneel(0, 90));
    assert.ok(up.ok, up.errors.join(" | "));
    assert.ok(up.metrics.balanceMargin > 0.03, `margin ${up.metrics.balanceMargin}`);
    // the verdict does not hang on a lean of 10 degrees (it did: 0 failed, 10 passed)
    assert.ok(P.validatePosture(body, kneel(10, 100)).errors.every((e) => !/centre of mass/.test(e)));
    // leaning 40 degrees forward on straight thighs puts the centre of mass over the knees' front, 110 to 140 mm ahead of the shanks: falls
    assert.ok(P.validatePosture(body, kneel(40, 90)).errors.some((e) => /centre of mass is \d+ mm outside the support polygon/.test(e)));
    // sitting back on the heels needs something else to carry the weight (hints.externalSupport), as POSE.md says
    const heels = P.validatePosture(body, kneel(100, 150, -50));
    assert.ok(heels.errors.some((e) => /centre of mass is \d+ mm outside/.test(e)), heels.errors.join(" | "));
  }
  // the shin counts as touching up to 30 mm only for the "knees" support: the other kneeling supports have their own carriers
  const rows = P.contactClearances(MAN, P.expandPosture(kneel(0, 90)), P.placePose(MAN, P.expandPosture(kneel(0, 90)), { support: "knees" }), { floor: 0 }, { knees: "floor" });
  const shin = rows.find((q) => q.point === "shin_L").clearance;
  assert.ok(shin > 0.015 && shin < 0.03, `the shin landmark is ${shin} m above the floor with the knee front on it`);
});

test("defect: the hint of an overlap with a thumb, index, ring or little finger blames the hand, not the neck, head or shoulders", () => {
  const cases = [
    [{ shoulder_L: [100.33, 65.84, 3.9], elbow_L: [116.98], forearm_L: [-9.9], wrist_L: [-29.73, 1.22] }, "point", /^head and thumb_L overlap by \d+ mm \(more than \d+ mm\): a hand is inside the body/],
    [{ shoulder_L: [131.52, 68.79, 14.78], elbow_L: [148.61], forearm_L: [28.6], wrist_L: [22.42, 9.49] }, "point", /^neck and thumb_L overlap by \d+ mm \(more than \d+ mm\): a hand is inside the body/],
    [{ shoulder_L: [114.16, 67.69, 9.46], elbow_L: [113.04], forearm_L: [-14.96], wrist_L: [1.56, 9.22] }, "flat", /^head and index_L overlap by \d+ mm \(more than \d+ mm\): a hand is inside the body/],
    [{ shoulder_L: [4.14, -11.23, -27.65], elbow_L: [3.59], forearm_L: [10.12], wrist_L: [7.98, -3.73] }, "point", /^(little|ring)_L and thigh_L overlap by \d+ mm \(more than \d+ mm\): a hand is inside the body/],
  ];
  for (const [joints, grip, re] of cases) {
    const r = P.validatePosture(MAN, base({ joints, grips: { L: grip, R: "relaxed" } }));
    assert.ok(r.errors.some((e) => re.test(e)), `${re}\n${r.errors.join("\n")}`);
    assert.ok(!r.errors.some((e) => /^(thumb|index|ring|little)_[LR] and \w+ overlap.*(head is in the shoulders|check the joint angles of the two segments)/.test(e) || /^head and (thumb|index|ring|little)_[LR].*head is in the shoulders/.test(e)), r.errors.join("\n"));
  }
  // two hands, or two fingers of one hand, say so
  const clasp = P.validatePosture(MAN, base({ joints: { shoulder_LR: [60, 0, 0], elbow_LR: [90], forearm_LR: [60] }, grips: { L: "fist", R: "fist" } }));
  assert.ok(clasp.errors.every((e) => !/head is in the shoulders/.test(e)), clasp.errors.join("\n"));
});

test("defect: lying prone with the toes pointing at the floor, and rolled half way, rests within 5 mm of the floor on the rig's skin", async (t) => {
  const R = await lazy(t, "../../site/js/human/rig.js"), S = await lazy(t, "../../site/js/human/body.js");
  if (!R || !S) return;
  const lying = (rig, body, root, angles) => { const placed = P.placePose(body, { root, angles }, { support: "body" }); rig.setPose({ root: placed, angles }, { clamp: false }); return rig.lowestY({ skin: true }); };
  const rand = rng(31);
  for (const body of [MAN, army("F", 50), WOMAN5, army("M", 95)]) {
    const rig = R.buildRig(body, { skinBuilder: (b, bones, o) => S.buildSkin(b, bones, o), skeleton: false });
    for (const ank of [0, -10, -20, -30, -45, 15]) for (const flex of [90, 80]) {
      const y = lying(rig, body, { flex }, { ankle_L: [ank, 0, 0], ankle_R: [ank, 0, 0] });
      assert.ok(Math.abs(y) < 0.005, `prone, ankle ${ank}, flex ${flex}: the skin is ${(y * 1000).toFixed(1)} mm from the floor`);
    }
    for (let i = 0; i < 12; i++) { // random ankles, the fingers pointing at the floor as well (arms overhead, hands open)
      const ank = -50 + rand() * 70, y = lying(rig, body, { flex: 60 + rand() * 30 }, { ankle_L: [ank, 0, 0], ankle_R: [ank, 0, 0], shoulder_L: [170, 0, 0], shoulder_R: [170, 0, 0], ...gripAngles("open", "L"), ...gripAngles("open", "R") });
      assert.ok(Math.abs(y) < 0.006, `prone, ankle ${ank.toFixed(0)}: the skin is ${(y * 1000).toFixed(1)} mm from the floor`);
    }
    for (const flex of [-90, 90]) for (const lat of [20, 45, 70]) {
      const y = lying(rig, body, { flex, lat }, flex > 0 ? { ankle_L: [-45, 0, 0], ankle_R: [-45, 0, 0] } : {});
      assert.ok(y > -0.005 && y < 0.0065, `${flex} / roll ${lat}: the skin is ${(y * 1000).toFixed(1)} mm from the floor`);
    }
    rig.dispose();
  }
});

test("defect: a body without segment masses is an error for the balance rule, never a centre of mass at the origin", () => {
  const noMass = { ...MAN, masses: undefined };
  const stand = base({ id: "stand" });
  const r = P.validatePosture(noMass, stand);
  assert.equal(r.metrics.balanceMargin, null); assert.equal(r.metrics.com, null);
  assert.ok(r.errors.some((e) => /no segment masses/.test(e)), r.errors.join("\n"));
  // where the balance is not checked nothing is said about the masses
  assert.ok(P.validatePosture(noMass, { ...stand, hints: { dynamic: true } }).ok);
  assert.ok(P.validatePosture(noMass, { ...stand, hints: { externalSupport: true } }).ok);
  assert.throws(() => P.balance(noMass, P.neutralPose(), { y: 1 }, ["heel_sole_L"]), /no segment masses/);
  assert.throws(() => P.centerOfMass(noMass, P.neutralPose(), { y: 1 }), /no segment masses/);
});

test("defect: proxyWorld does not hand out the radii and ids of another body when given its result as `out`", () => {
  const A = MAN, B = army("F", 5), pa = bodyProxies(A), pb = bodyProxies(B);
  assert.equal(pa.n, pb.n);
  const ka = P.solvePose(A, P.neutralPose(), { y: 1 }), wa = proxyWorld(pa, ka);
  const kb = P.solvePose(B, P.neutralPose(), { y: 1 }), wb = proxyWorld(pb, kb, wa);
  assert.notEqual(wb, wa, "another body's result is not reused");
  assert.deepEqual(Array.from(wb.ra), pb.list.map((c) => c.ra)); assert.deepEqual(Array.from(wb.rb), pb.list.map((c) => c.rb));
  assert.notDeepEqual(Array.from(wb.ra), Array.from(wa.ra));
  // the same body's result is reused (no allocation) and stays right
  const again = proxyWorld(pa, P.solvePose(A, P.neutralPose(), { y: 1.1 }), wa);
  assert.equal(again, wa); near(again.ay[0], wa.ay[0], 0);
});

test("defect: messages. One value, rounded vertebra ranges, a gap that is 15.1 mm is not '15 mm above ... within 15 mm', the right eye in the convention that was written", () => {
  assert.throws(() => P.expandPosture({ id: "x", joints: { elbow_LR: [] } }), /expected 1 value \(flex\), got 0/);
  assert.throws(() => P.expandPosture({ id: "x", joints: { elbow_LR: [1, 2] } }), /expected 1 value \(flex\), got 2/);
  assert.throws(() => P.expandPosture({ id: "x", joints: { hip_LR: [] } }), /expected 1 to 3 values \(flex, abd, rot\), got 0/);
  const v = P.validatePosture(MAN, base({ joints: { L3: [40], eye_LR: [0, 60] } }));
  assert.ok(v.errors.includes("L3 flex = 40\u00b0 is outside the range of motion [-6.7, 11.5] (clamps to 11.5\u00b0)"), v.errors.join("\n"));
  assert.ok(v.errors.includes("eye_R azim = 60\u00b0 is outside the range of motion [-45, 45] (clamps to 45\u00b0)"), v.errors.join("\n")); // not -60
  assert.ok(v.errors.includes("eye_L azim = 60\u00b0 is outside the range of motion [-45, 45] (clamps to 45\u00b0)"));
  const r = P.validatePosture(MAN, base({ joints: { eye_LR: [0, -60], shoulder_R: [200, 0, 0] } }));
  assert.ok(r.errors.some((e) => /^eye_R azim = -60\u00b0 is outside/.test(e)) && r.errors.some((e) => /^shoulder_R flex = 200\u00b0 is outside the range of motion \[-60, 180\]/.test(e)));
  const sh = P.seatHeightFor(MAN), iso = (d) => P.validatePosture(MAN, base({ support: "seat+feet", joints: { hip_LR: [90], knee_LR: [90] }, hints: { seat: { height: sh + d } } }));
  const e = iso(0.0151).errors[0];
  assert.match(e, /^contact set "feet": its lowest point is 15\.1 mm above the floor .*within 15 mm\)$/);
  assert.match(iso(0.054).errors[0], /its lowest point is 54 mm above the floor/);
});

test("defect: the reference postures are accepted for bodies far beyond the data (BMI above 100): the T-pose is a reference posture of the tolerances", () => {
  for (const [sex, st, ms] of [["F", 1310, 180], ["F", 1450, 250], ["M", 1310, 300], ["M", 1750, 300]]) {
    const body = fitBody({ sex, measures: { stature: { value: st, unit: "mm" }, mass: { value: ms, unit: "kg" } } });
    for (const posture of REFERENCE) { const r = P.validatePosture(body, posture); assert.ok(r.ok, `${sex} ${st} mm ${ms} kg, ${posture.id}: ${r.errors.join("; ")}`); }
  }
});

test("defect: every posture of the Reference group is accepted for the 99th-percentile New Zealand navy woman and the 1.31 m, 300 kg man (the tolerances learn from the whole group, not from three postures)", () => {
  // The Vitruvian figure (arms 108 degrees out) put the neck 54 mm into her upper arms against a tolerance of 51 mm while only ISO standing, ISO sitting and the T-pose taught the tolerances
  // (pose.adversarial2: 6,336 validations); the arms forward put the forearms 92 mm into the chest of the heavy man against 90.
  const nz = JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/new-zealand/navy/F.json")));
  const bodies = [["NZ navy F p99", fitBody(percentileProfile(nz, { percentile: 99 }))], ["NZ navy F p99, mean stature", fitBody(percentileProfile(nz, { percentile: 99, meanStature: true }))],
    ["M 1310 mm 300 kg", fitBody({ sex: "M", measures: { stature: { value: 1310, unit: "mm" }, mass: { value: 300, unit: "kg" } } })]];
  assert.ok(REFERENCE.length >= 10 && REFERENCE.some((p) => p.id === "ref-vitruvian") && REFERENCE.some((p) => p.id === "ref-forward-reach"), "the group the test is about");
  for (const [name, body] of bodies) for (const posture of REFERENCE) { const r = P.validatePosture(body, posture, { library: REFERENCE }); assert.ok(r.ok, `${name}, ${posture.id}: ${r.errors.join("; ")}`); }
});

test("standing centre of mass lies in front of the ankle (20 to 50 mm; quiet standing has 40 to 58 mm) and 34 to 40 % of the foot length from the heel (quiet standing: 40 %)", () => {
  // Was an open todo (fit.js had the centre of mass 2 mm in front of the ankle, 11 to 21 % of the foot from the heel); fixed by the lean of the shank in fit.js leanLegs (MODEL.md 4.1, 7.1).
  // Hellebrandt (1940) 40 to 50 mm, Di Giulio and Baltzopoulos (2019) 47 to 58 mm in front of the ankle joint centre, Kawai et al. (1997) 39.6 % of the base of support from its rear edge;
  // the model has 26 to 46 mm (median 35) and 36 to 40 %: with its vertical thigh the 40 % would need a shank leaning 5.9 degrees, twice the 3 to 4 measured, so the lean stops at 4.9 (K.leanMaxDeg).
  for (const body of [MAN, army("F", 50), WOMAN5, army("M", 95), TALL]) {
    const root = { y: body.joints.pelvis.offset[1] }, com = P.centerOfMass(body, P.neutralPose(), root).point, kin = P.solvePose(body, P.neutralPose(), root), ankle = kin.position("ankle_L");
    assert.ok(com.z - ankle.z > 0.025 && com.z - ankle.z < 0.05, `COM is ${((com.z - ankle.z) * 1000).toFixed(1)} mm in front of the ankle`);
    const heel = lmWorld(body, kin, "heel_L"), toe = lmWorld(body, kin, "toe_tip_L"), f = (com.z - heel.z) / (toe.z - heel.z);
    assert.ok(f > 0.33 && f < CONSTANTS.comFromHeel + 1e-3, `COM is ${(f * 100).toFixed(1)} % of the foot (heel to toe tip) from the heel`);
    assert.ok(body.stance.shankLeanDeg > 3.5 && body.stance.shankLeanDeg <= CONSTANTS.leanMaxDeg + 1e-3, `the shank leans ${body.stance.shankLeanDeg} degrees`);
  }
});

test("balance rule with the centre of mass of quiet standing: tiptoe is balanced, the edge of the support is about 4.5 degrees back and 8.5 forward, the 40 mm tolerance is 3 degrees more", () => {
  // The rule (POSTURES.md 6, pose.js validatePosture): the centre of mass is within 40 mm of the hull of the soles. With the centre of mass 37.5 % of the foot from the heel (MODEL.md 7.1) the
  // margin of the neutral pose is 62 to 79 mm (it was 23 to 31 mm) and each degree of lean about the ankles moves it by about 16 mm (0.97 m x pi / 180) toward the heel or the toes. Margins in mm
  // of the four bodies below, for the whole body tilted about the ankles with the soles flat (root flex tilts it about the pelvis, the ankles take the tilt back):
  //   back 3: 20..28, back 5: -9..-6, back 8: -57..-49, back 15: -174..-145 | forward 5: 46..69, 8: 4..18, 10: -23..-15, 15: -97..-86
  // (the old geometry: back 3: -21..-18, back 5: -54..-45; forward 10: 15..33)
  // so the rule (limit -40 mm) accepts about 7.5 degrees back and 11.5 forward. The edge of the support (4.6 back, 8.6 forward) is where the limits of stability of a healthy adult are: 8 degrees
  // forward and 4.5 backward (12.5 degrees of anteroposterior sway in all), Tsang and Hui-Chan 2003, 2004, as quoted by the Interacoustics overview of the limits-of-stability test (found by a
  // web search; the papers themselves not opened, and a model with another assumption gives 6.25 and 4.45). The 40 mm are the uncertainty of the model's centre of mass (it is 5 to 15 mm nearer the
  // heel than the measured 40 % of the foot, de Leva's centres are good to 10 to 20 mm) and the sway of a person (10 to 20 mm).
  const tilt = (deg) => base({ root: { flex: deg }, joints: { ankle_LR: [deg] } });
  const comError = (r) => r.errors.some((e) => /centre of mass is \d+ mm outside the support polygon/.test(e));
  for (const body of [MAN, army("F", 50), WOMAN5, army("M", 95)]) {
    const v = (p) => P.validatePosture(body, p), m = (p) => v(p).metrics.balanceMargin;
    const quiet = m(base({}));
    assert.ok(quiet > 0.05 && quiet < 0.09, `quiet standing ${quiet}`);
    // lean back: 3 degrees is inside (nearer the heel), 5 degrees is just outside the heel edge but inside the tolerance, 8 and more fall
    assert.ok(m(tilt(-3)) > 0.01 && m(tilt(-3)) < quiet - 0.03, `3 degrees back ${m(tilt(-3))}`);
    assert.ok(m(tilt(-5)) < 0 && m(tilt(-5)) > -0.02, `5 degrees back ${m(tilt(-5))}`);
    assert.ok(!comError(v(tilt(-5))) && comError(v(tilt(-8))) && comError(v(tilt(-15))), "back: 5 degrees stands, 8 and 15 degrees fall");
    assert.ok(m(tilt(-15)) < -0.1, `15 degrees back ${m(tilt(-15))}`);
    // lean forward: the centre of mass moves toward the middle of the foot (the margin grows) and then toward the toes: 5 degrees inside, 8 inside, 10 just outside but inside the tolerance, 15 falls
    assert.ok(m(tilt(5)) > 0.03 && m(tilt(5)) > m(tilt(8)) + 0.03, `5 degrees forward ${m(tilt(5))}`);
    assert.ok(m(tilt(8)) > 0 && m(tilt(8)) < 0.03, `8 degrees forward ${m(tilt(8))}`);
    assert.ok(m(tilt(10)) < 0 && m(tilt(10)) > -0.03 && !comError(v(tilt(10))) && comError(v(tilt(15))), "forward: 10 degrees is on the edge, inside the tolerance, 15 falls");
    // tiptoe (ankles 45 plantar-flexed, toes 45 dorsiflexed: the support is the ball and the toes): the upright model, with the centre of mass over the ankle, was 31 to 49 mm behind the
    // ball line and fell backward; now it is up to 7 mm behind it, or 5 mm in front (a person on tiptoe moves the body forward over the ball, the rigid model does not), inside the tolerance
    const tiptoe = v(base({ joints: { ankle_LR: [-45], mtp_LR: [45] } }));
    assert.ok(tiptoe.metrics.balanceMargin > -0.015 && !comError(tiptoe), `tiptoe ${tiptoe.metrics.balanceMargin}`);
    // a flat-footed deep squat with an upright trunk and the arms down is outside the support (a real squat reaches forward or leans the trunk), by 28 to 60 mm
    const squat = m(base({ joints: { hip_LR: [120], knee_LR: [145], ankle_LR: [30] } }));
    assert.ok(squat < -0.02 && squat > -0.08, `deep squat ${squat}`);
    // a forward bend of the trunk of 45 degrees at the hips (legs vertical, arms forward) is inside the tolerance, and falls with 10 kg in the hands: the load is why a lifter puts the hips back
    const bend = { root: { flex: 45 }, joints: { hip_LR: [45], shoulder_LR: [60] } };
    assert.ok(!comError(v(base(bend))) && comError(v(base({ ...bend, hints: { load: { mass: 10 } } }))), "bend 45 without and with 10 kg");
    assert.ok(m(base({ ...bend, hints: { load: { mass: 10 } } })) < m(base(bend)) - 0.03, "the load moves the centre of mass forward");
  }
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
  // 31 mm since the stance change (was 54): the shank of the neutral pose leans forward by 4.9 degrees and a knee at 60 instead of 90 swings the foot about it (MODEL.md 4.1)
  assert.match(floats.errors[0], /^contact set "feet": its lowest point is 31 mm above the floor \(the posture is placed by its seat on a seat plane of 428 mm; support "seat\+feet" needs the feet to touch within 15 mm\)$/);
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
  for (const f of Object.keys(PX)) assert.ok(text.includes(f), `export ${f} of proxies.js is not in POSE.md`);
});

// ---- documentation ------------------------------------------------------------------------------------------------------------
test("docs/human3d/POSE.md contains the current DOF table generated from skeleton.js", () => {
  const text = fs.readFileSync(path.join(ROOT, "docs/human3d/POSE.md"), "utf8");
  const a = text.indexOf("<!-- dof-table:begin -->"), b = text.indexOf("<!-- dof-table:end -->");
  assert.ok(a >= 0 && b > a, "markers missing");
  assert.equal(text.slice(a + "<!-- dof-table:begin -->".length, b).trim(), dofTable().trim(), "regenerate with: node scripts/human_dof_table.mjs --update-docs");
});


// ---- defects of the third verification round ------------------------------------------------------------------------------------
// The skin sections of the head (the oracle of these tests is not proxies.js): depth in mm, positive = inside, of a world point, by linear interpolation between the rings
function headDepth(body, p) {
  const rs = body.shape.head.rings.slice().sort((a, b) => a.c[1] - b.c[1]);
  if (p.y < rs[0].c[1] || p.y > rs[rs.length - 1].c[1]) return -1;
  let i = 0;
  while (i < rs.length - 2 && rs[i + 1].c[1] < p.y) i++;
  const a = rs[i], b = rs[i + 1], t = Math.min(1, Math.max(0, (p.y - a.c[1]) / (b.c[1] - a.c[1]))), L = (u, v) => u + (v - u) * t;
  const rx = L(a.rx, b.rx), rz = L(a.rz, b.rz), n = L(a.n ?? 2, b.n ?? 2);
  return (1 - (Math.abs((p.x - L(a.c[0], b.c[0])) / rx) ** n + Math.abs((p.z - L(a.c[2], b.c[2])) / rz) ** n) ** (1 / n)) * Math.min(rx, rz);
}
const popBody95 = (rel) => popBody(rel, 95);
const W50 = army("F", 50), M95 = army("M", 95);

test("defect: the upper arm swung through the thorax is rejected on the skin sections (it was never tested: the shoulder joint is inside the chest capsule)", () => {
  for (const [name, body] of Object.entries({ "median man": MAN, "median woman": W50, "5th-percentile woman": WOMAN5, "95th-percentile man": M95 })) {
    for (const joints of [{ shoulder_L: [-60, -50, 60], elbow_L: [10] }, { shoulder_L: [-30, -45, 0], elbow_L: [0] }]) {
      const r = P.validatePosture(body, base({ joints }));
      assert.equal(r.ok, false, `${name} ${JSON.stringify(joints)}`);
      assert.match(r.errors[0], /^upper_arm_L and trunk overlap by \d+ mm \(more than \d+ mm\): the upper arm passes through the trunk/, `${name}: ${r.errors[0]}`);
      const pen = r.metrics.penetrations.find((q) => q.b === "trunk");
      assert.equal(pen.a, "upper_arm_L"); assert.ok(pen.depth > pen.tolerance + 0.01 && pen.depth > 0.06, `${name}: depth ${pen.depth} tolerance ${pen.tolerance}`);
      // the same on the right: the right arm is the mirror image
      const mirrored = { shoulder_R: joints.shoulder_L, elbow_R: joints.elbow_L };
      assert.match(P.validatePosture(body, base({ joints: mirrored })).errors[0], /^upper_arm_R and trunk overlap/, name);
    }
  }
});

test("upper arm against the trunk: the arm at rest, a T-pose, hands on the hips, a hand on the opposite shoulder, reaching forward and overhead are not rejected (4 bodies)", () => {
  const ok = [
    {}, { shoulder_LR: [0, 84, 0] }, { shoulder_LR: [-10, 30, 0], elbow_LR: [100], wrist_LR: [0, -10] }, { shoulder_L: [60, -30, 40], elbow_L: [135], forearm_L: [50] },
    { shoulder_LR: [90, 0, 0], elbow_LR: [10] }, { shoulder_LR: [170, 10, 0], elbow_LR: [5] }, { shoulder_LR: [-45, 5, 0] }, { shoulder_L: [35, -5, 0], elbow_L: [120], forearm_L: [40] },
  ];
  for (const [name, body] of Object.entries({ MAN, W50, WOMAN5, M95 })) {
    for (const joints of ok) {
      const r = P.validatePosture(body, base({ joints }));
      assert.ok(!r.errors.some((e) => /trunk/.test(e)), `${name} ${JSON.stringify(joints)}: ${r.errors.join("; ")}`);
    }
    const px = bodyProxies(P.figureOf(body)), kin = P.solvePose(body, { angles: {} }, { y: body.joints.pelvis.offset[1] });
    const d = PX.armTorsoDepth(px, kin);
    assert.ok(d.L <= px.arm.tol.L && d.R <= px.arm.tol.R, `${name}: the neutral arm is ${d.L} / ${d.R} inside the trunk, allowed ${px.arm.tol.L}`);
    near(d.L, d.R, 0.002, `${name}: left and right arm of the neutral pose`);
  }
});

test("skinPenetrations: the entries have the form of selfPenetrations, deepest excess first, `all` lists every positive depth, slack is added to the tolerance", () => {
  const ex = P.expandPosture({ id: "a", joints: { shoulder_L: [-60, -50, 60], elbow_L: [10], shoulder_R: [100, 65, 0], elbow_R: [120], forearm_R: [-10], wrist_R: [-30, 1] }, grips: { L: "relaxed", R: "point" } });
  const kin = P.solvePose(MAN, ex, P.placePose(MAN, ex, {})), px = bodyProxies(P.figureOf(MAN)), W = proxyWorld(px, kin, null);
  const pens = PX.skinPenetrations(px, kin, W);
  assert.ok(pens.length >= 2, JSON.stringify(pens));
  for (const q of pens) { assert.deepEqual(Object.keys(q).sort(), ["a", "b", "depth", "excess", "tolerance"]); near(q.excess, q.depth - q.tolerance, 1e-12); assert.ok(q.excess > 0); }
  assert.deepEqual(pens.map((q) => q.excess), pens.map((q) => q.excess).sort((x, y) => y - x));
  assert.ok(pens.some((q) => q.a === "upper_arm_L" && q.b === "trunk") && pens.some((q) => q.a === "head" && /_R$/.test(q.b)), JSON.stringify(pens.map((q) => [q.a, q.b])));
  assert.ok(PX.skinPenetrations(px, kin, W, { all: true }).length >= pens.length);
  assert.ok(PX.skinPenetrations(px, kin, W, { slack: 0.2 }).length === 0, "a slack of 200 mm excuses everything");
  const rest = P.solvePose(MAN, { angles: {} }, { y: MAN.joints.pelvis.offset[1] });
  assert.deepEqual(PX.skinPenetrations(px, rest, proxyWorld(px, rest, null)), [], "nothing in the neutral pose");
  assert.deepEqual(PX.handHeadDepth(px, rest, proxyWorld(px, rest, null)), [], "hands at the sides are nowhere near the head");
});

test("defect: a palm laid against the side of the head is not 'a hand inside the body' (the head capsule is 10 mm too wide at the temples), a hand 25 to 70 mm inside it still is", () => {
  const HAND = ["grip_centre_L", "metacarpale_radiale_L", "metacarpale_ulnare_L", "middle_tip_L", "index_tip_L", "ring_tip_L", "little_tip_L", "thumb_tip_L", "stylion_L"];
  const wi = JOINTS.findIndex((j) => j.id === "wrist_L"), q = new THREE.Quaternion();
  const sample = (body, want, seed, accept) => { // poses whose palm centre has the skin depth (mm) given by `want`, and the rest of the hand outside the head when accept says so
    const rand = rng(seed), root = { y: body.joints.pelvis.offset[1] }, out = [], mid = body.shape.head.rings[Math.floor(body.shape.head.rings.length / 2)];
    for (let it = 0; it < 400000 && out.length < 40; it++) {
      const sh = clampAngles("shoulder_L", [-30 + rand() * 210, -30 + rand() * 170, -80 + rand() * 160]).angles;
      const joints = { shoulder_L: sh, elbow_L: [40 + rand() * 110], forearm_L: [-90 + rand() * 180], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] };
      const ex = P.expandPosture({ id: "a", joints, grips: { L: "flat", R: "relaxed" } }), kin = P.solvePose(body, ex, root);
      const pc = P.landmarkPosition(body, ex, root, "palm_centre_L"), d0 = headDepth(body, pc);
      if (d0 < want[0] || d0 > want[1]) continue;
      if (accept === "touching") {
        if (Math.max(...HAND.map((id) => headDepth(body, P.landmarkPosition(body, ex, root, id)))) > 0.001) continue;
        q.set(kin.quaternions[4 * wi], kin.quaternions[4 * wi + 1], kin.quaternions[4 * wi + 2], kin.quaternions[4 * wi + 3]);
        if (new THREE.Vector3(-1, 0, 0).applyQuaternion(q).dot(new THREE.Vector3(0, pc.y, mid.c[2]).sub(pc).normalize()) < 0.8) continue; // the palm faces the head
      }
      const r = P.validatePosture(body, base({ joints, grips: { L: "flat", R: "relaxed" } }));
      if (r.errors.some((e) => /range|requested|swing/.test(e))) continue;
      out.push(r.errors.some((e) => /^head and (palm|thumb|index|fingers|ring|little)_L/.test(e)));
    }
    return out;
  };
  let n = 0, rej = 0, nd = 0, rejd = 0;
  for (const [i, body] of [MAN, W50, WOMAN5, M95].entries()) {
    const a = sample(body, [-0.006, 0.001], 92 + i, "touching"), b = sample(body, [0.025, 0.07], 7 + i, "any");
    n += a.length; rej += a.filter(Boolean).length; nd += b.length; rejd += b.filter(Boolean).length;
  }
  assert.ok(n >= 100, `${n} touching poses sampled`);
  assert.ok(rej / n < 0.1, `${rej} of ${n} palm-on-head poses rejected (it was 40 to 65 %)`);
  assert.ok(nd >= 100 && rejd / nd > 0.9, `${rejd} of ${nd} poses with the palm 25 to 70 mm inside the head rejected`);
});

test("hand against the head: a fingertip in front of the face is judged on the face (the capsule was 11 mm short there), a hand beside the head on the temple (10 mm too wide)", () => {
  // the head table of the proxies is the loft of the skin sections: its depth at the brow ring's front, back and side is the ring's own
  const px = bodyProxies(P.figureOf(MAN)), H = px.head, brow = MAN.shape.head.rings.find((r) => r.id === "brow"), kin = P.solvePose(MAN, { angles: {} }, { y: MAN.joints.pelvis.offset[1] });
  const j = kin.position("head"), W = proxyWorld(px, kin, null);
  assert.ok(H.y.length > 20 && H.y.every((y, i) => i === 0 || y >= H.y[i - 1]), "the sections are sorted from the chin up");
  assert.ok(H.top > H.y[H.y.length - 1] && H.top < 0.2, "the dome above the top section ends at the vertex");
  // put a finger tip sphere at known places by moving the left index finger capsule of a copy of the world result
  const ci = px.byId.get("index_L"), pi = px.byId.get("palm_L"), at = (x, y, z) => { // the index finger collapsed to a sphere of 10 mm there; the palm capsule moved along so that the hand counts as near the head
    const w = { ...W, ax: W.ax.slice(), ay: W.ay.slice(), az: W.az.slice(), bx: W.bx.slice(), by: W.by.slice(), bz: W.bz.slice(), ra: Float64Array.from(W.ra), rb: Float64Array.from(W.rb) };
    for (const i of [ci, pi]) for (const k of ["a", "b"]) { w[k + "x"][i] = x; w[k + "y"][i] = y; w[k + "z"][i] = z; }
    w.ra[ci] = w.rb[ci] = 0.01; w.ra[pi] = w.rb[pi] = 0.001;
    return w;
  };
  const depthOf = (w) => PX.handHeadDepth(px, kin, w).find((h) => h.part === "index_L")?.depth;
  const cz = brow.c[2], by = brow.c[1];
  near(depthOf(at(0, by, cz)), brow.rx < brow.rz ? brow.rx + 0.01 : brow.rz + 0.01, 0.002, "a sphere of 10 mm at the middle of the brow section: the half-width plus the radius");
  near(depthOf(at(brow.rx - 0.02, by, cz)), 0.02 + 0.01, 0.003, "20 mm inside the temple");
  near(depthOf(at(0, by, cz + brow.rz - 0.02)), 0.02 * Math.min(brow.rx, brow.rz) / brow.rz + 0.01, 0.002, "20 mm inside the face (depth is measured in units of the shorter half axis)");
  near(depthOf(at(brow.rx + 0.01, by, cz)), 0.01 - 0.01, 0.003, "touching the temple from outside");
  assert.ok(depthOf(at(0, by, cz + brow.rz + 0.05)) < -0.02, "in front of the face, away from it");
});

test("defect: a body lying on its side rests on the floor within 6 mm: the upper arm of the support sections is narrowed to the measured bideltoid breadth like the skin (it floated 11 to 16 mm)", async () => {
  const { buildRig } = await import("../../site/js/human/rig.js");
  const { buildSkin } = await import("../../site/js/human/body.js");
  for (const rel of ["multiple-latin-america-18-countries/tri-service/both.json", "germany/aircrew/both.json", "france/pilots/both.json"]) {
    const body = popBody95(rel), rig = buildRig(body, { skinBuilder: (b, bo, o) => buildSkin(b, bo, o), skeleton: false });
    for (const lat of [90, -90]) {
      const ex = P.expandPosture({ id: "l", root: { lat } }), r = P.placePose(body, ex, { support: "body" });
      rig.setPose({ root: r, angles: ex.angles }, { clamp: false });
      const y = rig.lowestY({ skin: true });
      assert.ok(y > -0.006 && y < 0.006, `${rel} lat ${lat}: the skin is ${(y * 1000).toFixed(1)} mm from the floor`);
    }
    rig.dispose();
  }
});

test("upper arm support sections: no section of the upper arm reaches beyond half the bideltoid breadth by more than the 12 mm of body.js (narrow shoulders)", () => {
  for (const rel of ["multiple-latin-america-18-countries/tri-service/both.json", "germany/aircrew/both.json", "france/pilots/both.json"]) {
    const body = popBody95(rel), px = bodyProxies(P.figureOf(body)), kin = P.solvePose(body, { angles: {} }, { y: body.joints.pelvis.offset[1] });
    const half = body.report.find((r) => r.id === "bideltoid_breadth" && r.kind === "measure")?.input / 2000;
    assert.ok(half > 0.1, `${rel}: bideltoid breadth measured`);
    const elbowY = kin.position("elbow_L").y, sx = kin.position("shoulder_L");
    let widest = 0;
    for (const r of px.rings) if (r.tube === "upper_arm_L" && sx.y + r.off[1] >= elbowY) widest = Math.max(widest, sx.x + r.off[0] + r.rx);
    assert.ok(widest <= half + 0.0005 + 0.012 + 0.0015, `${rel}: the outer edge of the upper arm is ${(widest * 1000).toFixed(1)} mm, half the bideltoid breadth ${(half * 1000).toFixed(1)} mm`);
  }
});

test("defect: sitting with the thighs rotated outward does not sink the trochanter into the seat (a bony point on the side of the hip, not a seat contact)", () => {
  const files = ["united-states/army/M.json", "united-states/army/F.json", "germany/aircrew/both.json", "france/pilots/both.json", "multiple-latin-america-18-countries/tri-service/both.json"];
  for (const rel of files) for (const pc of [5, 50, 95]) {
    const body = fitBody(percentileProfile(popFile(rel), { percentile: pc, meanStature: true }));
    for (const [abd, rot] of [[15, -45], [0, -45], [0, -60], [30, -60]]) {
      const r = P.validatePosture(body, base({ support: "seat", joints: { hip_LR: [90, abd, rot], knee_LR: [90] }, hints: { seat: { height: 0.45 } } }));
      assert.ok(!r.errors.some((e) => /sink into the seat/.test(e)), `${rel} P${pc} abd ${abd} rot ${rot}: ${r.errors.join("; ")}`);
    }
  }
  // the buttocks of a reclined posture still sink into the seat and are caught: "defect: the buttocks of a reclined seated posture do not sink into the seat plane" above
});

test("defect: the grips 'spherical' and 'cup' open to their descriptions (a 60 mm ball: the thumb tip is 40 to 55 mm from the index and middle fingertips; a cup of 70 mm: more)", () => {
  for (const [name, body] of Object.entries({ MAN, W50, WOMAN5, M95 })) {
    const root = { y: body.joints.pelvis.offset[1] }, scale = body.stature / MAN.stature;
    const d = (g) => { const ex = P.expandPosture({ id: "g", grips: { L: g, R: g } }), tip = (id) => P.landmarkPosition(body, ex, root, id).clone(); return { ti: tip("thumb_tip_L").distanceTo(tip("index_tip_L")), tm: tip("thumb_tip_L").distanceTo(tip("middle_tip_L")), im: tip("index_tip_L").distanceTo(tip("middle_tip_L")) }; };
    const sph = d("spherical"), cup = d("cup"), power = d("power");
    for (const k of ["ti", "tm"]) assert.ok(sph[k] > 0.037 * scale && sph[k] < 0.06 * scale, `${name} spherical ${k} ${sph[k]}`);
    assert.ok(cup.ti > 0.042 * scale && cup.ti < 0.07 * scale && cup.tm > sph.tm, `${name} cup ${JSON.stringify(cup)}`);
    assert.ok(sph.ti > 2 * power.ti, `${name}: the ball grip is wider than the 35 mm power grip`);
    assert.ok(sph.im > 0.02 * scale, `${name}: the fingertips do not pile up (index to middle ${sph.im})`);
  }
  for (const g of ["spherical", "cup"]) { // inside the ranges of motion, no finger clamped
    const { pose, clamped } = P.clampPose({ root: {}, angles: P.expandPosture({ id: "g", grips: { L: g, R: g } }).angles });
    assert.deepEqual(clamped, [], g); assert.ok(pose);
  }
});

test("defect: options.contactTolerance and options.seatHeight are validated like their hints, and the messages never echo 'undefined'", () => {
  const floating = base({ support: "seat+feet", joints: { hip_LR: [90], knee_LR: [60] } });
  assert.match(P.validatePosture(MAN, floating).errors[0], /^contact set "feet": its lowest point is 31 mm above the floor/); // was 54 mm before the stance change (MODEL.md 4.1)
  for (const bad of [NaN, Infinity, -Infinity, "5", "0.01", 5, -0.001, 0.2, {}, [], true]) {
    const r = P.validatePosture(MAN, floating, { contactTolerance: bad });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /^options\.contactTolerance must be a number of metres between 0 and 0\.1, got /, String(bad));
    assert.ok(r.errors.some((e) => /^contact set "feet"/.test(e)), "the contact is then checked against the default 15 mm, not against the bad value");
  }
  for (const bad of [NaN, Infinity, -Infinity, "5", "high", 1.6, -0.001, {}, [], true]) {
    const s = P.validatePosture(MAN, floating, { seatHeight: bad });
    assert.match(s.errors[0], /^options\.seatHeight must be "popliteal" or a height in metres \(0 to 1\.5\), got /, String(bad));
    assert.equal(s.errors.filter((e) => /seat ?height/i.test(e)).length, 1, "reported once");
  }
  for (const good of [0, 0.01, 0.055, 0.1]) assert.ok(!P.validatePosture(MAN, floating, { contactTolerance: good }).errors.some((e) => /options\./.test(e)), String(good));
  const loose = P.validatePosture(MAN, floating, { contactTolerance: 0.055 });
  assert.equal(loose.ok, true); assert.ok(loose.warnings.some((w) => /options\.contactTolerance is 55 mm/.test(w)));
  assert.equal(P.validatePosture(MAN, floating, { seatHeight: 0.43 }).metrics.seatHeight, 0.43);
  assert.equal(P.validatePosture(MAN, floating, { seatHeight: "popliteal", contactTolerance: null }).metrics.seatHeight, P.seatHeightFor(MAN));
  // the same value in a hint: one error, and the rest of the posture is still checked with the default
  for (const hints of [{ seat: { height: -1 } }, { seat: { height: "high" } }]) {
    const r = P.validatePosture(MAN, { ...floating, hints });
    assert.equal(r.errors.filter((e) => /seat/i.test(e) && !/contact set/.test(e)).length, 1, r.errors.join("\n"));
    assert.ok(!r.errors.some((e) => /cannot place the posture/.test(e)), r.errors.join("\n"));
    assert.ok(r.errors.some((e) => /^contact set "feet"/.test(e)), r.errors.join("\n"));
  }
  const r2 = P.validatePosture(MAN, { ...floating, hints: { contactTolerance: 5 } });
  assert.deepEqual(r2.errors.map((e) => e.slice(0, 22)), ["hints.contactTolerance", "contact set \"feet\": it"]);
  // missing fields are named as missing
  for (const [key, re] of [["support", /^support is missing: it must be one of: feet, seat/], ["category", /^category is missing: it must be one of: Standing/], ["id", /^id is missing: it must be kebab-case/]]) {
    const p = { ...floating }; delete p[key];
    const r = P.validatePosture(MAN, p);
    assert.match(r.errors[0], re); assert.ok(!r.errors.some((e) => /undefined/.test(e)), r.errors.join("\n"));
  }
  assert.match(P.validatePosture(MAN, { ...floating, support: "hovering" }).errors[0], /^support "hovering" must be one of/);
});
