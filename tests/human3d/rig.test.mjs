// rig.js + skeletonview.js + synthetic.js against the synthetic body (no WebGL needed: logic, geometry and raycasting only).
//   node --import ./tests/human3d/register.mjs --test tests/human3d/rig.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, BONES, BONE_BY_ID, BONE_LANDMARKS, REGIONS, clampAngles, expandRegions, jointQuaternion } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { buildRig, Rig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { fitBody } from "../../site/js/human/fit.js";
import { COLORS } from "../../site/js/human/skeletonview.js";

const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
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
const body = syntheticBody(1.75, "male");
const fresh = (o) => buildRig(body, o);
const lmWorldNeutral = (b, id) => { const l = b.landmarks[id]; return b.positions[l.joint].map((x, i) => x + l.offset[i]); };

// ---- synthetic body ----------------------------------------------------------------------------------------------------------------------
test("synthetic body has every field rig.js and the skeleton need", () => {
  assert.equal(Object.keys(body.joints).length, 77);
  for (const j of JOINTS) {
    assert.equal(body.joints[j.id].offset.length, 3, j.id);
    assert.ok(body.positions[j.id].every(Number.isFinite), j.id);
  }
  near(body.joints.pelvis.offset[0], 0); near(body.joints.pelvis.offset[2], 0);
  for (const id of BONE_LANDMARKS) assert.ok(body.landmarks[id], `landmark ${id}`);
  for (const id of ["vertex", "eye_L", "eye_R", "eye_mid", "acromion_L", "acromion_R", "trochanterion_L", "ischial_L", "ischial_R", "palm_centre_L", "patella_L", "heel_L", "heel_sole_L", "ball_sole_medial_L", "toe_tip_L"]) assert.ok(body.landmarks[id], `landmark ${id}`);
  for (const [id, l] of Object.entries(body.landmarks)) {
    assert.ok(JOINT_BY_ID[l.joint], `${id}: joint`);
    assert.ok(typeof l.label === "string" && l.label && l.group && l.kind, `${id}: label/group/kind`);
  }
  for (const [name, set] of Object.entries(body.contacts)) for (const id of set) assert.ok(body.landmarks[id], `contact ${name}: ${id}`);
  for (const k of ["feet", "seat", "knees", "hands", "elbows"]) assert.ok(body.contacts[k]?.length, k);
  assert.equal(Object.keys(body.masses).length, 16);
  near(Object.values(body.masses).reduce((s, m) => s + m.mass, 0), 75, 1e-3);
  assert.ok(body.dims.length > 20 && body.shape.tubes && body.report.length > 5 && body.warnings.some((w) => /generic body/.test(w)), "a complete fit.js BodyModel");
  assert.equal(body.synthetic, true);
  assert.equal(body.stature, 1.75);
  assert.equal(body.form, "male");
});

test("synthetic body is left-right symmetric, scales with stature, and positions are the cumulative offsets", () => {
  for (const j of JOINTS) {
    if (!j.id.endsWith("_L")) continue;
    const l = body.joints[j.id].offset, r = body.joints[j.id.replace(/_L$/, "_R")].offset;
    near(l[0], -r[0], 1e-9, j.id); near(l[1], r[1], 1e-9, j.id); near(l[2], r[2], 1e-9, j.id);
  }
  for (const [id, l] of Object.entries(body.landmarks)) {
    if (!id.endsWith("_L")) continue;
    const a = lmWorldNeutral(body, id), b = lmWorldNeutral(body, id.replace(/_L$/, "_R"));
    near(a[0], -b[0], 1e-5, id); near(a[1], b[1], 1e-5, id); near(a[2], b[2], 1e-5, id);
  }
  for (const H of [1.5, 2.0]) {
    const b = syntheticBody(H, "female");
    near(lmWorldNeutral(b, "vertex")[1], H, 1e-4, `vertex ${H}`);
    near(Math.min(...Object.keys(b.landmarks).map((id) => lmWorldNeutral(b, id)[1])), 0, 1e-4, `lowest ${H}`);
    const t = syntheticBody(H, "neutral");
    assert.ok(t.mass > 0 && t.mass < 120);
  }
  assert.throws(() => syntheticBody(0.2), RangeError);
  assert.throws(() => syntheticBody(1.75, "robot"), RangeError);
});

// ---- hierarchy and neutral pose ---------------------------------------------------------------------------------------------------------
test("77 bones with the right parents, names, rest offsets", () => {
  const rig = fresh();
  assert.equal(rig.bones.size, 77);
  assert.deepEqual([...rig.bones.keys()], JOINTS.map((j) => j.id), "JOINTS order (parents first)");
  for (const j of JOINTS) {
    const b = rig.bones.get(j.id);
    assert.ok(b.isBone && b.name === j.id);
    if (j.parent) {
      assert.equal(b.parent, rig.bones.get(j.parent), `${j.id} parent`);
      for (let i = 0; i < 3; i++) near(b.position.getComponent(i), rig.restBody.joints[j.id].offset[i], 1e-12, `${j.id} offset`);
      near(b.quaternion.w, 1, 1e-12);
    } else assert.equal(b.parent, rig.group);
  }
  assert.equal(rig.group.name, "rig");
});

test("neutral standing: feet on the floor, head vertex at the stature, positions equal the body's", () => {
  const rig = fresh();
  near(rig.lowestY(), 0, 1e-3);
  near(rig.landmarkWorld("vertex").y, 1.75, 1e-4);
  for (const j of JOINTS) {
    const w = rig.jointWorld(j.id);
    for (let i = 0; i < 3; i++) near(w.getComponent(i), rig.restBody.positions[j.id][i], 1e-5, j.id);
    // the rebasing of rig.js moves the forearm joint sideways onto the vertical through the wrist and nothing else
    if (!j.id.startsWith("forearm_")) for (let i = 0; i < 3; i++) near(w.getComponent(i), body.positions[j.id][i], 1e-5, `${j.id} as in the body`);
    const b = new THREE.Vector3().setFromMatrixPosition(rig.bones.get(j.id).matrixWorld);
    near(b.distanceTo(w), 0, 1e-9, `bone ${j.id}`);
  }
  assert.deepEqual(rig.getPose().root, { x: 0, y: body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
  for (const id of Object.keys(rig.angles)) assert.ok(rig.angles[id].every((v) => v === 0), id);
});

// ---- bones vs kinematics ----------------------------------------------------------------------------------------------------------------
test("bones agree with Kinematics to 1e-9 over 300 random poses and roots", () => {
  const rig = fresh(), rand = rng(7);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), kp = new THREE.Vector3(), kq = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1), km = new THREE.Matrix4();
  let worstP = 0, worstQ = 0, worstM = 0, clampedSome = 0;
  for (let n = 0; n < 300; n++) {
    const angles = {};
    for (const j of JOINTS) if (rand() < 0.8) angles[j.id] = j.dof.map((d) => d.min + (d.max - d.min) * rand() * (rand() < 0.1 ? 1.2 : 1)); // a few are out of range on purpose
    if (n % 3 === 0) angles.pelvis = [rand() * 20 - 10, rand() * 20 - 10, rand() * 20 - 10];
    const root = { x: rand() * 4 - 2, y: rand() * 2, z: rand() * 4 - 2, heading: rand() * 360 - 180, flex: rand() * 180 - 90, lat: rand() * 180 - 90, rot: rand() * 360 - 180 };
    const rep = rig.setPose({ root, angles });
    clampedSome += rep.clamped.length > 0;
    for (const j of JOINTS) {
      rig.bones.get(j.id).matrixWorld.decompose(p, q, s);
      rig.kin.position(j.id, kp);
      rig.kin.quaternion(j.id, kq);
      worstP = Math.max(worstP, p.distanceTo(kp));
      worstQ = Math.max(worstQ, 1 - Math.abs(q.dot(kq)));
      // the full 4x4 world matrix (rotation elements are cosines: no acos precision loss) against the Kinematics pose
      km.compose(kp, kq, unit);
      const e = rig.bones.get(j.id).matrixWorld.elements;
      for (let i = 0; i < 16; i++) worstM = Math.max(worstM, Math.abs(e[i] - km.elements[i]));
      near(s.x, 1, 1e-12); near(s.y, 1, 1e-12); near(s.z, 1, 1e-12);
      // public API goes through kin
      assert.ok(rig.jointWorld(j.id).distanceTo(kp) === 0);
    }
  }
  assert.ok(worstP < 1e-9, `position ${worstP}`);
  assert.ok(worstQ < 1e-12, `orientation ${worstQ}`); // 1 - |dot| ~ angle^2 / 8
  assert.ok(worstM < 1e-9, `world matrix ${worstM}`);
  assert.ok(clampedSome > 100, "the out-of-range samples were clamped");
});

test("landmarkWorld is exactly Kinematics.toWorld, and agrees with the bone matrices", () => {
  const rig = fresh();
  rig.setPose({ root: { x: 0.3, y: 0.9, z: -0.2, heading: 40, flex: -30, lat: 10 }, angles: { hip_L: [60, 10, 20], knee_L: [90, 5], shoulder_R: [120, 30, 40], head: [10, 5, 5], L3: [10, 4, 2] } });
  const k = new Kinematics(Object.fromEntries(JOINTS.filter((j) => j.parent).map((j) => [j.id, rig.restBody.joints[j.id].offset])));
  k.solve(rig.angles, rig.root);
  const v = new THREE.Vector3();
  for (const id of rig.landmarkIds) {
    const l = rig.restBody.landmarks[id];
    assert.ok(rig.landmarkWorld(id).distanceTo(k.toWorld(l.joint, l.offset, v)) < 1e-12, id);
    const viaBone = new THREE.Vector3(...l.offset).applyMatrix4(rig.bones.get(l.joint).matrixWorld);
    assert.ok(viaBone.distanceTo(rig.landmarkWorld(id)) < 1e-9, `${id} via bone`);
  }
  assert.throws(() => rig.landmarkWorld("nope"), /unknown landmark/);
  const out = new THREE.Vector3();
  assert.equal(rig.landmarkWorld("vertex", out), out);
  assert.equal(rig.landmarkIds.length, Object.keys(body.landmarks).length);
});

test("boneSegment, contactPoints, lowestY", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.7, heading: 25, flex: 15 }, angles: { knee_L: [80, 0], hip_L: [70, 0, 0] } });
  const seg = rig.boneSegment("femur_L");
  near(seg.a.distanceTo(rig.jointWorld("hip_L")), 0); near(seg.b.distanceTo(rig.jointWorld("knee_L")), 0);
  const st = rig.boneSegment("sternum");
  near(st.a.distanceTo(rig.landmarkWorld("suprasternale")), 0); near(st.b.distanceTo(rig.landmarkWorld("xiphoid")), 0);
  const rib = rig.boneSegment("rib_3_R");
  near(rib.a.distanceTo(rig.jointWorld("T3")), 0); near(rib.b.distanceTo(rib.a), 0, 0, "rib has no second end");
  for (const b of BONES) { const sgm = rig.boneSegment(b.id); assert.ok(Number.isFinite(sgm.a.x + sgm.b.y)); }
  assert.throws(() => rig.boneSegment("femur"), /unknown bone/);
  const feet = rig.contactPoints("feet");
  assert.equal(feet.length, body.contacts.feet.length);
  assert.ok(feet.every((p, i) => p.distanceTo(rig.landmarkWorld(body.contacts.feet[i])) === 0));
  assert.throws(() => rig.contactPoints("lap"), /available: .*feet/);
  const brute = Math.min(...rig.landmarkIds.map((id) => rig.landmarkWorld(id).y));
  near(rig.lowestY(), brute, 1e-12);
  // contact entries may be { joint, offset } too
  const b2 = { ...body, contacts: { ...body.contacts, probe: [{ joint: "T1", offset: [0, -5, 0] }] } };
  const r2 = buildRig(b2);
  near(r2.lowestY(), r2.contactPoints("probe")[0].y, 1e-12);
  r2.dispose();
});

// ---- setPose semantics -------------------------------------------------------------------------------------------------------------------------
const snapshot = (rig) => JSON.stringify([rig.getPose(), [...rig.bones.values()].map((b) => b.matrixWorld.elements)]);

test("setPose is atomic: any invalid input throws and changes nothing (no listener call either)", () => {
  const rig = fresh();
  rig.setPose({ root: { x: 0.1, y: 1, heading: 20 }, angles: { elbow_L: [40], head: [5, 0, 0] } });
  const before = snapshot(rig);
  let calls = 0;
  rig.onChange(() => calls++);
  const bad = [
    { angles: { knee_L: [30, 0], elbow_R: [NaN] } }, // valid joint first: it must not leak through
    { angles: { knee_L: [30, 0], notAJoint: [1] } },
    { angles: { knee_L: [30, 0], elbow_R: [10, 5] } }, // too many values
    { angles: { knee_L: [30, "5"] } },
    { angles: { knee_L: 30 } },
    { angles: { knee_L: [Infinity, 0] } },
    { angles: { knee_L: [null] } },
    { angles: { hip_LR: [10, 0, 0] } }, // posture-level keys belong to pose.js
    { root: { x: NaN } },
    { root: { x: 1, bogus: 2 } },
    { root: { y: "1" } },
    { root: [1, 2, 3] },
    { angle: {} },
    { root: { y: 1 }, angles: { head: [1, 2, 3], C1: [1, 2, 3, 4] } },
    null, "x", 5, [],
  ];
  for (const pose of bad) {
    assert.throws(() => rig.setPose(pose), undefined, JSON.stringify(pose));
    assert.equal(snapshot(rig), before, `state changed after ${JSON.stringify(pose)}`);
  }
  assert.equal(calls, 0);
  assert.throws(() => rig.setAngles({ knee_L: [NaN, 0] }));
  assert.throws(() => rig.setRoot({ heading: NaN }));
  assert.throws(() => rig.setSpine({ lumbar: [NaN, 0, 0] }));
  assert.equal(snapshot(rig), before);
});

test("clamping: report { joint, dof, requested, applied }; clamp: false passes the value through", () => {
  const rig = fresh();
  let r = rig.setPose({ angles: { knee_L: [200, 0] } });
  assert.deepEqual(r.clamped, [{ joint: "knee_L", dof: "flex", requested: 200, applied: JOINT_BY_ID.knee_L.dof[0].max }]);
  assert.equal(rig.angles.knee_L[0], 160);
  r = rig.setPose({ angles: { knee_L: [-20, 100], elbow_R: [100] } });
  assert.deepEqual(r.clamped.map((c) => [c.joint, c.dof, c.requested, c.applied]), [["knee_L", "flex", -20, -5], ["knee_L", "rot", 100, 30]]);
  assert.deepEqual(rig.setPose({ angles: { knee_L: [90, 0] } }).clamped, []);
  // the swing-length cap of clampAngles is reported too (shoulder flex 150 + abd 150 is 212 degrees)
  r = rig.setPose({ angles: { shoulder_L: [150, 150, 0] } });
  assert.ok(r.clamped.length >= 1 && r.clamped.every((c) => c.joint === "shoulder_L"));
  const ref = clampAngles("shoulder_L", [150, 150, 0]).angles;
  rig.angles.shoulder_L.forEach((v, i) => near(v, ref[i], 1e-12));
  // clamp: false keeps it (and the bones follow it)
  r = rig.setPose({ angles: { knee_L: [200, 0] } }, { clamp: false });
  assert.deepEqual(r.clamped, []);
  assert.equal(rig.angles.knee_L[0], 200);
  near(Math.abs(rig.bones.get("knee_L").quaternion.dot(jointQuaternion("knee_L", [200, 0]))), 1, 1e-12, "the bone follows the unclamped angle");
  // holes and missing values are zero
  rig.setPose({ angles: { shoulder_R: [, 30] } });
  assert.deepEqual([...rig.angles.shoulder_R], [0, 30, 0]);
});

test("setPose replaces what it is given, setAngles / setRoot merge, resetPose is neutral standing", () => {
  const rig = fresh();
  rig.setPose({ root: { x: 0.5, y: 0.9, z: 0.2, heading: 30 }, angles: { elbow_L: [90], head: [10, 0, 0] } });
  rig.setPose({ angles: { knee_R: [40, 0] } }); // replaces ALL angles, leaves the root alone
  assert.equal(rig.angles.elbow_L[0], 0); assert.equal(rig.angles.head[0], 0); assert.equal(rig.angles.knee_R[0], 40);
  assert.equal(rig.root.heading, 30); assert.equal(rig.root.x, 0.5);
  rig.setPose({ root: { y: 1.0 } }); // replaces the root: the other fields are 0, the angles stay
  assert.deepEqual({ ...rig.root }, { x: 0, y: 1, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
  assert.equal(rig.angles.knee_R[0], 40);
  rig.setAngles({ elbow_L: [30] });
  assert.equal(rig.angles.elbow_L[0], 30); assert.equal(rig.angles.knee_R[0], 40);
  rig.setRoot({ heading: 15 });
  assert.equal(rig.root.heading, 15); assert.equal(rig.root.y, 1);
  const noop = rig.setPose({});
  assert.deepEqual(noop, { clamped: [] });
  rig.resetPose();
  assert.deepEqual(rig.getPose().root, { x: 0, y: body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
  near(rig.lowestY(), 0, 1e-3);
  assert.ok(Object.values(rig.angles).every((a) => a.every((v) => v === 0)));
  // getPose is a deep copy that setPose accepts back
  rig.setPose({ root: { x: 0.2, y: 0.95, heading: 10 }, angles: { hip_L: [30, 5, 0] } });
  const g = rig.getPose();
  g.angles.hip_L[0] = 99; g.root.x = 99;
  assert.equal(rig.angles.hip_L[0], 30); assert.equal(rig.root.x, 0.2);
  const keep = rig.getPose();
  rig.resetPose();
  rig.setPose(keep);
  assert.deepEqual(rig.getPose(), keep);
  // the exposed state is frozen: nothing can corrupt it by accident
  assert.throws(() => { rig.angles.hip_L[0] = 1; }, TypeError);
  assert.throws(() => { rig.root.x = 1; }, TypeError);
});

test("setSpine distributes region totals over the vertebrae (skeleton.js expandRegions)", () => {
  const rig = fresh();
  rig.setSpine({ lumbar: [40, 10, 6], thoracic: [20, 0, 20], cervical: [-30, 0, 0] });
  const ref = expandRegions({ lumbar: [40, 10, 6], thoracic: [20, 0, 20], cervical: [-30, 0, 0] });
  for (const id of Object.keys(ref)) ref[id].forEach((v, i) => near(rig.angles[id][i], v, 1e-12, id));
  near(REGIONS.lumbar.joints.reduce((s, id) => s + rig.angles[id][0], 0), 40, 1e-9);
  rig.setAngles({ knee_L: [10, 0] }); // merges: the spine stays
  near(REGIONS.lumbar.joints.reduce((s, id) => s + rig.angles[id][0], 0), 40, 1e-9);
  assert.throws(() => rig.setSpine({ sacral: [1, 0, 0] }), /unknown spine region/);
});

test("onChange fires after every committed setPose, with the rig; unsubscribe works; a throwing listener does not break the others", () => {
  const rig = fresh();
  const seen = [];
  const off = rig.onChange((r) => seen.push(r.root.heading));
  rig.onChange(() => { throw new Error("boom"); });
  const log = console.error; console.error = () => {};
  try {
    rig.setRoot({ heading: 10 }); rig.setAngles({ head: [1, 0, 0] }); rig.resetPose();
  } finally { console.error = log; }
  assert.deepEqual(seen, [10, 10, 0]);
  off();
  rig.setRoot({ heading: 5 });
  assert.equal(seen.length, 3);
  assert.throws(() => rig.onChange(5), TypeError);
});

// ---- centre of mass ----------------------------------------------------------------------------------------------------------------------------
test("centre of mass of the neutral standing body: 0.52-0.58 of stature, between the feet", () => {
  const rig = fresh();
  const { point, mass } = rig.centerOfMass();
  near(mass, 75, 1e-3);
  const f = point.y / 1.75;
  assert.ok(f > 0.52 && f < 0.58, `COM at ${f} of stature`);
  near(point.x, 0, 2e-3);
  const heel = rig.landmarkWorld("heel_L").z, toe = rig.landmarkWorld("toe_tip_L").z;
  assert.ok(point.z > heel && point.z < toe, `z ${point.z} not in [${heel}, ${toe}]`);
  const segs = rig.comSegments;
  assert.equal(segs.length, Object.keys(body.masses).length);
  near(segs.reduce((s, x) => s + x.mass, 0), mass, 1e-9);
  const sum = segs.reduce((a, x) => a.addScaledVector(x.point, x.mass), new THREE.Vector3()).multiplyScalar(1 / mass);
  near(sum.distanceTo(point), 0, 1e-12);
  // raising both arms moves the COM up and keeps it centred; flexing the trunk moves it forward
  const h0 = point.y;
  rig.setAngles({ shoulder_L: [170, 0, 0], shoulder_R: [170, 0, 0] });
  const up = rig.centerOfMass().point;
  assert.ok(up.y > h0 + 0.005 && Math.abs(up.x) < 2e-3);
  rig.resetPose();
  rig.setSpine({ lumbar: [50, 0, 0], thoracic: [30, 0, 0] });
  assert.ok(rig.centerOfMass().point.z > point.z + 0.03);
  const out = new THREE.Vector3();
  assert.equal(rig.centerOfMass(out).point, out);
  // a body without masses: the call fails clearly, the rest of the rig works
  const nm = buildRig({ ...body, masses: undefined });
  assert.throws(() => nm.centerOfMass(), /no segment masses/);
  nm.dispose();
  // flat { mass, joint, offset } entries are accepted too
  const flat = buildRig({ ...body, masses: Object.fromEntries(Object.entries(body.masses).map(([k, m]) => [k, { mass: m.mass, ...m.com }])) });
  near(flat.centerOfMass().point.distanceTo(point), 0, 1e-9, "flat masses") ;
  assert.throws(() => buildRig({ ...body, masses: { x: { mass: 1, com: { joint: "nope", offset: [0, 0, 0] } } } }), /body.masses/);
  flat.dispose();
});

// ---- body validation ---------------------------------------------------------------------------------------------------------------------------
test("buildRig names what is wrong with a body", () => {
  assert.throws(() => buildRig(null), TypeError);
  assert.throws(() => buildRig({ ...body, joints: { ...body.joints, knee_L: { offset: [0, NaN, 0] } } }), /knee_L/);
  const { elbow_R, ...rest } = body.joints;
  assert.throws(() => buildRig({ ...body, joints: rest }), /elbow_R/);
  const extra = buildRig({ ...body, joints: { ...body.joints, tail: { offset: [0, 0, 0] } }, whatever: 1 }); // extra keys are ignored
  assert.equal(extra.bones.size, 77);
  extra.dispose();
  const lm = { ...body.landmarks }; delete lm.xiphoid;
  assert.throws(() => buildRig({ ...body, landmarks: lm }), /xiphoid/);
  const r = buildRig({ ...body, landmarks: lm }, { skeleton: false }); // no skeleton visuals: the bone landmarks are not needed
  assert.equal(r.view, null);
  assert.deepEqual({ ...r.display }, { skin: false, skeleton: false, joints: false, labels: false, axes: true, landmarks: false, wireframe: false, xray: false, com: false });
  assert.equal(r.setDisplay({ skeleton: true, joints: true }).skeleton, false);
  assert.equal(r.pickJoint(new THREE.Raycaster()), null);
  assert.deepEqual(r.labelAnchors(), []);
  r.select("knee_L"); r.highlight("knee_L"); // harmless
  r.dispose();
  assert.throws(() => buildRig({ ...body, landmarks: { ...body.landmarks, x: { joint: "nope", offset: [0, 0, 0] } } }), /landmark "x"/);
});

// ---- the skeleton meshes -----------------------------------------------------------------------------------------------------------------------
function meshes(rig) { const a = []; rig.group.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isLineSegments) a.push(o); }); return a; }

test("one mesh per BONES entry, parented to the right bone, valid geometry (finite, unit normals, outward faces)", () => {
  const rig = fresh();
  const bm = rig.view.boneMeshes;
  assert.equal(bm.length, BONES.length);
  assert.deepEqual(bm.map((m) => m.userData.boneId).sort(), BONES.map((b) => b.id).sort());
  for (const m of bm) {
    const def = BONE_BY_ID[m.userData.boneId];
    const skinned = (def.kind === "rib" && def.level <= 10) || def.id.startsWith("radius_"); // ribs 1-10: vertebra T_n at the back, the sternum's bone (T4) at the front; radius: elbow / forearm joint
    if (m.isSkinnedMesh) {
      assert.ok(skinned, `${def.id} is skinned`);
      assert.equal(m.parent, rig.bones.get(def.joint), `${def.id} parent`);
      const bi = m.geometry.attributes.skinIndex.array, bw = m.geometry.attributes.skinWeight.array, names = m.skeleton.bones.map((b) => b.name);
      for (let i = 0; i < bi.length; i += 4) {
        assert.ok(bw[i] + bw[i + 1] > 0.999 && bw[i + 2] === 0 && bw[i + 3] === 0);
        assert.ok(def.kind === "rib" ? names[bi[i]] === `T${def.level}` && names[bi[i + 1]] === "T4" : names[bi[i]] === `elbow_${def.side}` && names[bi[i + 1]] === `forearm_${def.side}`, def.id);
      }
    } else {
      assert.ok(!skinned, `${def.id} must be skinned`);
      assert.equal(m.parent, rig.bones.get(def.joint), `${def.id} parent`);
    }
    const g = m.geometry, P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color.array, I = g.index.array;
    assert.ok(P.length > 0 && I.length > 0 && I.length % 3 === 0, def.id);
    for (let i = 0; i < P.length; i++) assert.ok(Number.isFinite(P[i]) && Number.isFinite(N[i]) && Number.isFinite(C[i]), `${def.id} finite`);
    for (let i = 0; i < N.length; i += 3) near(Math.hypot(N[i], N[i + 1], N[i + 2]), 1, 1e-3, `${def.id} normal`);
    let vol = 0;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
      assert.ok(I[i] < P.length / 3 && I[i + 1] < P.length / 3 && I[i + 2] < P.length / 3, `${def.id} index range`);
    }
    assert.ok(vol > 0, `${def.id}: signed volume ${vol} (faces point inward?)`);
    assert.ok(g.boundingSphere.radius > 0.003 && g.boundingSphere.radius < 0.6, `${def.id} size ${g.boundingSphere.radius}`);
    assert.equal(m.material, rig.view.boneMat);
  }
});

/** World bounding box of a bone mesh in the neutral pose. */
function bboxOf(rig, mesh) {
  rig.group.updateMatrixWorld(true);
  const bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  return bb;
}

test("every bone sits where its definition says: the end points lie inside (or within 2 cm of) its mesh, left and right mirror each other", () => {
  for (const [H, form] of [[1.75, "male"], [1.52, "female"], [1.95, "male"]]) {
    const b = syntheticBody(H, form), rig = buildRig(b);
    for (const m of rig.view.boneMeshes) {
      // the metacarpals 2-5 start behind the carpal bones (which are drawn with the middle one), 30 % of the way to the knuckle
      const def = BONE_BY_ID[m.userData.boneId], bb = bboxOf(rig, m).expandByScalar((def.id.startsWith("metacarpal") ? 0.04 : 0.02) * (H / 1.75));
      const seg = rig.boneSegment(def.id);
      assert.ok(bb.containsPoint(seg.a), `${H} ${def.id}: start ${seg.a.toArray().map((x) => x.toFixed(3))} outside ${bb.min.toArray().map((x) => x.toFixed(3))} .. ${bb.max.toArray().map((x) => x.toFixed(3))}`);
      if (def.to) assert.ok(bb.containsPoint(seg.b), `${H} ${def.id}: end ${seg.b.toArray().map((x) => x.toFixed(3))} outside bbox`);
    }
    for (const def of BONES) {
      if (def.side !== "L") continue;
      const l = bboxOf(rig, rig.view.boneMeshes.find((m) => m.userData.boneId === def.id)), r = bboxOf(rig, rig.view.boneMeshes.find((m) => m.userData.boneId === def.id.replace(/_L$/, "_R")));
      near(l.min.x, -r.max.x, 2e-4, `${def.id} x`); near(l.max.x, -r.min.x, 2e-4, `${def.id} x`);
      near(l.min.y, r.min.y, 2e-4, `${def.id} y`); near(l.max.y, r.max.y, 2e-4, `${def.id} y`);
      near(l.min.z, r.min.z, 2e-4, `${def.id} z`); near(l.max.z, r.max.z, 2e-4, `${def.id} z`);
    }
    rig.dispose();
  }
});

test("robustness: a body with every joint and landmark perturbed (up to 12 % / 15 mm) still builds, with finite outward-facing geometry", () => {
  const rand = rng(11);
  for (let n = 0; n < 4; n++) {
    const joints = {}, landmarks = {};
    for (const [id, j] of Object.entries(body.joints)) joints[id] = { offset: j.offset.map((v) => v * (1 + (rand() - 0.5) * 0.24) + (id === "pelvis" ? 0 : (rand() - 0.5) * 0.004)) };
    joints.pelvis.offset = [0, body.joints.pelvis.offset[1], 0];
    for (const [id, l] of Object.entries(body.landmarks)) landmarks[id] = { ...l, offset: l.offset.map((v) => v + (rand() - 0.5) * 0.03) };
    const rig = buildRig({ ...body, joints, landmarks });
    for (const m of rig.view.boneMeshes) {
      const P = m.geometry.attributes.position.array;
      assert.ok(P.every(Number.isFinite), `${m.userData.boneId} finite`);
      assert.ok(m.geometry.boundingSphere.radius < 0.7, `${m.userData.boneId} size`);
    }
    rig.setPose({ angles: { knee_L: [90, 0], shoulder_R: [90, 30, 0] } });
    rig.dispose();
  }
});

test("the skeleton stays inside the body envelope: nothing sticks out of a 0.5 m radius around its own joints; the whole thing is about stature tall", () => {
  const rig = fresh();
  const all = new THREE.Box3();
  for (const m of rig.view.boneMeshes) all.union(bboxOf(rig, m));
  assert.ok(all.max.y > 1.70 && all.max.y < 1.78, `top ${all.max.y}`);
  assert.ok(all.min.y > -0.01 && all.min.y < 0.03, `bottom ${all.min.y}`);
  assert.ok(all.min.x > -0.55 && all.max.x < 0.55, `width ${all.min.x}..${all.max.x}`); // arms hang up to 30 degrees away from the body (fit.js)
  assert.ok(all.min.z > -0.2 && all.max.z < 0.35, `depth ${all.min.z}..${all.max.z}`);
});

test("bone meshes move with the pose (no per-frame work): a raised arm carries the humerus mesh", () => {
  const rig = fresh();
  const hum = rig.view.boneMeshes.find((m) => m.userData.boneId === "humerus_L");
  const c0 = bboxOf(rig, hum).getCenter(new THREE.Vector3());
  rig.setAngles({ shoulder_L: [90, 0, 0] });
  const c1 = bboxOf(rig, hum).getCenter(new THREE.Vector3());
  assert.ok(c1.z > c0.z + 0.1 && c1.y > c0.y + 0.1, `${c0.toArray()} -> ${c1.toArray()}`);
  // and the centre of the humerus mesh stays on the segment shoulder-elbow
  const seg = rig.boneSegment("humerus_L"), mid = seg.a.clone().lerp(seg.b, 0.5);
  assert.ok(c1.distanceTo(mid) < 0.05);
});

test("draw-call budget: at most 450 objects (skeleton + markers + overlays), everything switched on", () => {
  const rig = fresh();
  rig.setDisplay({ skeleton: true, joints: true, landmarks: true, com: true, labels: true, axes: true, xray: true });
  rig.select("shoulder_L");
  const n = meshes(rig).filter((o) => o.visible).length;
  assert.ok(n <= 450, `${n} drawable objects`);
  assert.ok(n >= 118 + 77, `${n}`);
  // triangles: a few hundred thousand at most
  let tris = 0;
  for (const m of rig.view.boneMeshes) tris += m.geometry.index.count / 3;
  assert.ok(tris < 400000, `${tris} triangles`);
  const low = buildRig(body, { quality: "low" });
  let lowTris = 0;
  for (const m of low.view.boneMeshes) lowTris += m.geometry.index.count / 3;
  assert.ok(lowTris < tris * 0.8, `low ${lowTris} vs ${tris}`);
  low.dispose();
  rig.dispose();
});

// ---- display, markers, picking, selection ---------------------------------------------------------------------------------------------------------
test("setDisplay: validates, freezes, applies visibility; flags that cannot apply stay false", () => {
  const rig = fresh();
  assert.deepEqual({ ...rig.display }, { skin: false, skeleton: true, joints: true, labels: false, axes: true, landmarks: false, wireframe: false, xray: false, com: false });
  assert.throws(() => rig.setDisplay({ bones: true }), /unknown flag/);
  assert.throws(() => rig.setDisplay(null), TypeError);
  assert.throws(() => { rig.display.joints = false; }, TypeError);
  rig.setDisplay({ skeleton: false });
  assert.ok(rig.view.boneMeshes.every((m) => !m.visible) && rig.view.markers.every((m) => m.visible));
  rig.setDisplay({ skeleton: true, joints: false, landmarks: true, com: true });
  assert.ok(rig.view.boneMeshes.every((m) => m.visible) && rig.view.markers.every((m) => !m.visible));
  assert.ok(rig.view.lmPoints.visible && rig.view.comPoint.visible && rig.view.comLine.visible);
  assert.equal(rig.setDisplay({ skin: true, wireframe: true }).skin, false, "no skin: stays false");
  assert.equal(rig.display.wireframe, false);
});

test("joint markers: colour by DOF count, finger markers tiny, hips large, x-ray puts them on top", () => {
  const rig = fresh(), mk = (id) => rig.view.markers.find((m) => m.userData.jointId === id);
  assert.equal(rig.view.markers.length, 77);
  const col = (id) => mk(id).material.color.getHex();
  assert.equal(col("pelvis"), 0xe5484d);
  assert.equal(col("elbow_L"), 0x3b82f6); // 1 DOF
  assert.equal(col("jaw"), 0x3b82f6);
  assert.equal(col("wrist_L"), 0x22b573); // 2 DOF
  assert.equal(col("clavicle_R"), 0x22b573);
  assert.equal(col("hip_L"), 0xf59e0b); // 3 DOF
  assert.equal(col("L3"), 0xf59e0b);
  const r = (id) => mk(id).scale.x;
  assert.ok(r("hip_L") > r("wrist_L") && r("wrist_L") > r("index_mcp_L") && r("index_mcp_L") > r("index_dip_L") * 0.99);
  assert.ok(r("index_dip_L") < 0.005 && r("hip_L") > 0.015);
  // no skin: nothing hides the markers, they are drawn over the bones (otherwise hip, knee and shoulder markers would sit inside the epiphyses)
  assert.ok(rig.view.markers.every((m) => !m.material.depthTest && m.material.transparent && m.renderOrder > 0));
  const withSkin = buildRig(body, { skinBuilder: fakeSkinBuilder({ calls: 0, disposed: 0 }) });
  withSkin.setDisplay({ joints: true });
  assert.ok(withSkin.view.markers.every((m) => m.material.depthTest && !m.material.transparent && m.renderOrder === 0), "skin on: markers are depth-tested");
  withSkin.setDisplay({ xray: true });
  assert.ok(withSkin.view.markers.every((m) => !m.material.depthTest && m.material.transparent && m.renderOrder > 0), "x-ray: markers on top");
  withSkin.setDisplay({ xray: false, skin: false });
  assert.ok(withSkin.view.markers.every((m) => !m.material.depthTest), "skin hidden: on top again");
  withSkin.dispose();
  // the marker sits at the joint centre; the forearm joint is on the vertical through the wrist, a quarter of the forearm above it (rig.js rebase), clear of the elbow and wrist markers
  const w = new THREE.Vector3().setFromMatrixPosition(mk("knee_R").matrixWorld);
  near(w.distanceTo(rig.jointWorld("knee_R")), 0, 1e-9);
  const fw = new THREE.Vector3().setFromMatrixPosition(mk("forearm_L").matrixWorld);
  near(fw.distanceTo(rig.jointWorld("forearm_L")), 0, 1e-9);
  assert.ok(fw.distanceTo(rig.jointWorld("elbow_L")) > 0.05 && fw.distanceTo(rig.jointWorld("wrist_L")) > 0.03);

});

function rayAt(from, to) { const d = to.clone().sub(from).normalize(); return new THREE.Raycaster(from, d); }

test("pickJoint / pickBone with a raycaster; hidden things are not picked", () => {
  const rig = fresh();
  for (const id of ["hip_L", "knee_R", "wrist_L", "head", "L3", "shoulder_R"]) {
    const w = rig.jointWorld(id);
    const hit = rig.pickJoint(rayAt(w.clone().add(new THREE.Vector3(0, 0, 1.5)), w));
    assert.ok(hit, id);
    assert.equal(hit.id, id);
    assert.ok(hit.distance > 1.4 && hit.distance < 1.5, `${id} d=${hit.distance}`);
    assert.ok(hit.point.distanceTo(w) < 0.03);
  }
  // a ray that misses everything
  assert.equal(rig.pickJoint(rayAt(new THREE.Vector3(2, 1, 2), new THREE.Vector3(2, 1, 0))), null);
  // joints hidden -> nothing; shown again -> found
  rig.setDisplay({ joints: false });
  assert.equal(rig.pickJoint(rayAt(new THREE.Vector3(0.087, 0.927, 2), rig.jointWorld("hip_L"))), null);
  rig.setDisplay({ joints: true });
  assert.equal(rig.pickJoint(rayAt(new THREE.Vector3(0.087, 0.927, 2), rig.jointWorld("hip_L"))).id, "hip_L");
  // bones: aim at the middle of the femur shaft from the front (from the side the hanging hand is in the way)
  const seg = rig.boneSegment("femur_L"), mid = seg.a.clone().lerp(seg.b, 0.5);
  const shaft = mid.clone().add(new THREE.Vector3(0.028, 0, 0)), ahead = () => rayAt(shaft.clone().add(new THREE.Vector3(0, 0, 2)), shaft); // the shaft runs lateral of the hip-knee line
  const side = rig.pickBone(ahead());
  assert.equal(side.id, "femur_L");
  const sk = rig.boneSegment("sternum"), sm = sk.a.clone().lerp(sk.b, 0.4);
  assert.equal(rig.pickBone(rayAt(sm.clone().add(new THREE.Vector3(0, 0.05, 2)), sm)).id, "sternum");
  rig.setDisplay({ skeleton: false });
  assert.equal(rig.pickBone(ahead()), null);
  // follows the pose
  rig.setDisplay({ skeleton: true });
  rig.setAngles({ hip_L: [80, 0, 0] });
  const seg2 = rig.boneSegment("femur_L"), mid2 = seg2.a.clone().lerp(seg2.b, 0.5);
  assert.equal(rig.pickBone(rayAt(mid2.clone().add(new THREE.Vector3(2, 0, 0)), mid2)).id, "femur_L");
  // raycaster near / far are respected
  const rc = rayAt(rig.jointWorld("hip_L").clone().add(new THREE.Vector3(0, 0, 1.5)), rig.jointWorld("hip_L"));
  rc.far = 1.0;
  assert.equal(rig.pickJoint(rc), null);
});

test("with an opaque skin in front, hidden bones and markers are not picked; x-ray or hiding the skin exposes them", () => {
  const rig = buildRig(body, { skinBuilder: fakeSkinBuilder({ calls: 0, disposed: 0 }) });
  rig.setDisplay({ skeleton: true, joints: true });
  const w = rig.jointWorld("hip_L"), ray = () => rayAt(w.clone().add(new THREE.Vector3(0, 0, 1.5)), w);
  assert.equal(rig.pickJoint(ray()), null);
  assert.equal(rig.pickBone(ray()), null);
  rig.setDisplay({ xray: true });
  assert.equal(rig.pickJoint(ray()).id, "hip_L");
  assert.ok(rig.pickBone(ray()));
  rig.setDisplay({ xray: false, skin: false });
  assert.equal(rig.pickJoint(ray()).id, "hip_L");
  rig.dispose();
});

test("framing the rig (Box3.setFromObject) ignores the dynamic overlays: moving the body away from the origin moves the box with it", () => {
  const rig = fresh();
  rig.setDisplay({ landmarks: true, com: true });
  rig.setPose({ root: { x: 6, y: body.joints.pelvis.offset[1], z: -4 } });
  rig.group.updateWorldMatrix(true, true);
  const b = new THREE.Box3().setFromObject(rig.group);
  assert.ok(b.min.x > 5.5 && b.max.x < 6.5 && b.min.z > -4.3 && b.max.z < -3.5, `${b.min.toArray()} .. ${b.max.toArray()}`);
  assert.ok(b.min.y > -0.05 && b.max.y < 1.8);
  rig.dispose();
});

test("highlight swaps the marker material and size; select adds the ring and a triad with one arrow per DOF; labels", () => {
  const rig = fresh();
  const mk = (id) => rig.view.markers.find((m) => m.userData.jointId === id);
  const r0 = mk("elbow_L").scale.x, mat0 = mk("elbow_L").material;
  rig.highlight("elbow_L");
  assert.ok(mk("elbow_L").scale.x > r0 && mk("elbow_L").material !== mat0);
  rig.highlight("knee_L");
  assert.equal(mk("elbow_L").scale.x, r0); assert.equal(mk("elbow_L").material, mat0);
  rig.highlight(null);
  assert.throws(() => rig.highlight("elbow"), /unknown joint/);
  assert.throws(() => rig.select("nope"), /unknown joint/);
  assert.equal(meshes(rig).filter((o) => o.name === "joint-triad" || o.parent?.name === "joint-triad").length, 0);

  for (const id of ["knee_L", "hip_R", "pelvis", "ankle_L", "jaw", "shoulder_L", "forearm_L", "eye_R"]) {
    rig.select(id);
    const tri = rig.view.triad;
    assert.ok(tri, id);
    const arrows = tri.group.children.filter((o) => o.name.startsWith("dof:"));
    assert.equal(arrows.length, JOINT_BY_ID[id].dof.length, `${id} arrows`);
    assert.deepEqual(arrows.map((a) => a.name.slice(4)), JOINT_BY_ID[id].dof.map((d) => d.key));
    assert.equal(new Set(arrows.map((a) => a.material)).size, arrows.length);
    assert.ok(tri.group.children.some((o) => o.name === "axes"));
    const anchors = rig.labelAnchors().filter((a) => a.kind === "dof");
    assert.deepEqual(anchors.map((a) => a.text), JOINT_BY_ID[id].dof.map((d) => d.key));
    for (const a of anchors) assert.ok(a.position instanceof THREE.Vector3 && Number.isFinite(a.position.x) && a.id.startsWith(`dof:${id}:`));
  }
  // the arrow of a DOF points the way the positive angle moves the probe point (skeleton.js probe / moves)
  rig.select("knee_L");
  const dofs = rig.view.triad.dofs;
  assert.equal(dofs[0].key, "flex");
  rig.select(null);
  assert.equal(rig.view.triad, null);
  assert.equal(rig.labelAnchors().length, 0);
  // the triad follows the pose without per-frame work (child of the parent bone)
  rig.select("knee_L");
  assert.equal(rig.view.triad.group.parent, rig.bones.get("hip_L"));
  rig.setAngles({ hip_L: [90, 0, 0] });
  const tipWorld = rig.view.triad.group.localToWorld(rig.view.triad.dofs[0].tip.clone());
  const expect = rig.kin.toWorld("hip_L", rig.view.triad.dofs[0].tip.clone().add(rig.view.triad.local), new THREE.Vector3());
  near(tipWorld.distanceTo(expect), 0, 1e-9, "the arrow follows the pose with the bone");
  // the names of the arrows are fanned out around the joint (not on the arrow tips: those are 10-15 px apart at the default framing)
  const dofA = rig.labelAnchors().filter((x) => x.kind === "dof"), J = rig.jointWorld("knee_L"), s = 1;
  assert.equal(dofA.length, JOINT_BY_ID.knee_L.dof.length);
  for (const x of dofA) { const d = x.position.distanceTo(J); assert.ok(d > 0.09 * s && d < 0.3 * s, `${x.text} ${d}`); }
  for (let i = 0; i < dofA.length; i++) for (let k = i + 1; k < dofA.length; k++) assert.ok(dofA[i].position.distanceTo(dofA[k].position) > 0.09 * s, "labels apart");
  rig.setDisplay({ axes: false });
  assert.equal(rig.labelAnchors().filter((x) => x.kind === "dof").length, 0);
  assert.equal(rig.view.triad.group.visible, false);
  assert.ok(rig.view.ring.visible, "ring stays");
});

test("every DOF arrow points the way a positive angle really moves the probe point (through the rig, all 77 joints)", () => {
  const rig = fresh();
  for (const j of JOINTS) {
    rig.select(j.id);
    const dofs = rig.view.triad.dofs;
    assert.equal(dofs.length, j.dof.length, j.id);
    j.dof.forEach((d, i) => {
      rig.resetPose();
      const probe = new THREE.Vector3(...d.probe).normalize().multiplyScalar(0.05);
      const rest = rig.kin.toWorld(j.id, probe, new THREE.Vector3());
      const a = j.dof.map(() => 0); a[i] = 3;
      rig.setAngles({ [j.id]: a });
      const moved = rig.kin.toWorld(j.id, probe, new THREE.Vector3());
      const disp = moved.clone().sub(rest).normalize();
      // the arrow: tail at probe * 0.05 * s in the parent frame (neutral = world axes), direction = d.moves
      const arrow = new THREE.Vector3(...d.moves).normalize();
      assert.ok(disp.dot(arrow) > 0.97, `${j.id} ${d.key}: moves ${disp.toArray().map((x) => x.toFixed(2))} vs arrow ${arrow.toArray()}`);
    });
  }
});

test("labelAnchors: joint names (+ landmark names with the landmark flag), at the world positions", () => {
  const rig = fresh();
  assert.equal(rig.labelAnchors().length, 0);
  rig.setDisplay({ labels: true });
  let L = rig.labelAnchors();
  assert.equal(L.length, 77);
  assert.ok(L.every((a) => a.kind === "joint" && a.text && a.position instanceof THREE.Vector3));
  assert.equal(L.find((a) => a.id === "knee_L").text, JOINT_BY_ID.knee_L.label);
  rig.setPose({ root: { x: 1, y: 1, z: 1, heading: 90 }, angles: { knee_L: [60, 0] } });
  L = rig.labelAnchors();
  assert.ok(L.every((a) => a.position.distanceTo(rig.jointWorld(a.id)) < 1e-12));
  rig.setDisplay({ landmarks: true });
  L = rig.labelAnchors();
  assert.equal(L.length, 77 + rig.landmarkIds.length);
  const v = L.find((a) => a.id === "lm:vertex");
  assert.equal(v.kind, "landmark"); assert.equal(v.text, body.landmarks.vertex.label);
  near(v.position.distanceTo(rig.landmarkWorld("vertex")), 0, 1e-12);
});

test("landmark dots and the centre-of-mass marker follow the pose (world frame overlays)", () => {
  const rig = fresh();
  rig.setDisplay({ landmarks: true, com: true });
  rig.setPose({ root: { x: 0.4, y: 0.8, z: -0.3, heading: 60, flex: 20 }, angles: { elbow_R: [70], hip_L: [50, 0, 0] } });
  const P = rig.view.lmPoints.geometry.attributes.position;
  rig.view.lmIds.forEach((id, i) => {
    const w = rig.landmarkWorld(id);
    near(P.getX(i), w.x, 1e-6, id); near(P.getY(i), w.y, 1e-6, id); near(P.getZ(i), w.z, 1e-6, id);
  });
  const c = rig.centerOfMass().point, cp = rig.view.comPoint.geometry.attributes.position;
  near(cp.getX(0), c.x, 1e-6); near(cp.getY(0), c.y, 1e-6); near(cp.getZ(0), c.z, 1e-6);
  const line = rig.view.comLine.geometry.attributes.position;
  near(line.getX(1), c.x, 1e-6); near(line.getZ(1), c.z, 1e-6); assert.ok(line.getY(1) < 0.01, "line ends on the floor");
  // a body without masses: no crash while the COM flag is on
  const nm = buildRig({ ...body, masses: undefined });
  nm.setDisplay({ com: true });
  nm.setRoot({ heading: 20 });
  nm.dispose();
});

// ---- skin hook -----------------------------------------------------------------------------------------------------------------------------------
function fakeSkinBuilder(log) {
  return (b, bones, opts) => {
    log.calls++;
    log.args = { body: b, bones, opts };
    log.pelvisAtBind = new THREE.Vector3().setFromMatrixPosition(bones.get("pelvis").matrixWorld).toArray();
    log.kneeAtBind = new THREE.Vector3().setFromMatrixPosition(bones.get("knee_L").matrixWorld).toArray();
    const mat = new THREE.MeshStandardMaterial({ color: 0xcc9988 });
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(0.4, 1.7, 0.2), mat);
    mesh.bind(new THREE.Skeleton([...bones.values()]));
    return { mesh, dispose() { log.disposed++; mesh.geometry.dispose(); mat.dispose(); } };
  };
}

test("skinBuilder: called with (body, bones) in the neutral standing pose; skin toggles, x-ray and wireframe are applied and undone", () => {
  const log = { calls: 0, disposed: 0 };
  const rig = buildRig(body, { skinBuilder: fakeSkinBuilder(log), quality: "low" });
  assert.equal(log.calls, 1);
  assert.equal(log.args.body, rig.restBody);
  assert.equal(log.args.bones, rig.bones);
  assert.equal(log.args.opts.quality, "low");
  near(log.pelvisAtBind[1], body.joints.pelvis.offset[1], 1e-9, "bones are at the neutral standing pose with fresh matrices when the skin is built");
  near(log.kneeAtBind[1], body.positions.knee_L[1], 1e-6);
  assert.ok(rig.skin?.isSkinnedMesh && rig.group.children.includes(rig.skin));
  assert.deepEqual({ ...rig.display }, { skin: true, skeleton: false, joints: false, labels: false, axes: true, landmarks: false, wireframe: false, xray: false, com: false });
  assert.equal(rig.skin.visible, true);
  assert.ok(rig.view.boneMeshes.every((m) => !m.visible));
  const mat = rig.skin.material;
  rig.setDisplay({ xray: true, wireframe: true });
  assert.ok(mat.transparent && mat.opacity < 0.5 && !mat.depthWrite && mat.wireframe);
  rig.setDisplay({ xray: false, wireframe: false });
  assert.ok(!mat.transparent && mat.opacity === 1 && mat.depthWrite && !mat.wireframe);
  rig.setDisplay({ skin: false, skeleton: true });
  assert.equal(rig.skin.visible, false);
  rig.dispose();
  assert.equal(log.disposed, 1);
  // a builder that returns null (fitting failed): the rig works without a skin
  const r2 = buildRig(body, { skinBuilder: () => null });
  assert.equal(r2.skin, null);
  assert.equal(r2.display.skeleton, true);
  r2.dispose();
});

// ---- dispose ----------------------------------------------------------------------------------------------------------------------------------------
test("dispose frees every geometry, material and texture the rig created, removes the group, and is idempotent", () => {
  const geos = new Set(), mats = new Set(), texs = new Set();
  const pg = THREE.BufferGeometry.prototype.dispose, pm = THREE.Material.prototype.dispose, pt = THREE.Texture.prototype.dispose;
  THREE.BufferGeometry.prototype.dispose = function () { geos.add(this); return pg.call(this); };
  THREE.Material.prototype.dispose = function () { mats.add(this); return pm.call(this); };
  THREE.Texture.prototype.dispose = function () { texs.add(this); return pt.call(this); };
  try {
    const scene = new THREE.Scene();
    const rig = buildRig(body);
    scene.add(rig.group);
    rig.setDisplay({ landmarks: true, com: true, labels: true });
    rig.select("shoulder_L");
    rig.select("knee_R"); // the first triad is replaced (and freed) here
    rig.select("hip_L");
    const usedG = new Set(), usedM = new Set(), usedT = new Set();
    rig.group.traverse((o) => {
      if (o.geometry) usedG.add(o.geometry);
      for (const m of [].concat(o.material ?? [])) { usedM.add(m); if (m.map) usedT.add(m.map); }
    });
    // the first two triads were disposed when replaced; the live set must be disposed by dispose()
    geos.clear(); mats.clear(); texs.clear();
    assert.ok(usedG.size > 100 && usedM.size >= 8 && usedT.size >= 3, `${usedG.size} geometries, ${usedM.size} materials, ${usedT.size} textures`);
    rig.dispose();
    for (const g of usedG) assert.ok(geos.has(g), "geometry not disposed");
    for (const m of usedM) assert.ok(mats.has(m), "material not disposed");
    for (const t of usedT) assert.ok(texs.has(t), "texture not disposed");
    assert.equal(scene.children.length, 0, "group removed from the scene");
    assert.equal(rig.group.children.length, 0);
    const n = geos.size;
    rig.dispose();
    assert.equal(geos.size, n, "second dispose is a no-op");
    assert.throws(() => rig.setPose({}), /disposed/);
    assert.throws(() => rig.jointWorld("head"), /disposed/);
    // a replaced triad was freed when it was replaced
    const rig2 = buildRig(body);
    rig2.select("shoulder_L");
    const first = rig2.view.triad.group.children.map((o) => o.geometry);
    geos.clear();
    rig2.select("knee_L");
    for (const g of first) assert.ok(geos.has(g), "replaced triad geometry freed");
    rig2.dispose();
  } finally {
    THREE.BufferGeometry.prototype.dispose = pg; THREE.Material.prototype.dispose = pm; THREE.Texture.prototype.dispose = pt;
  }
});

test("a lot of poses and rebuilds do not leak objects: the scene graph size is constant", () => {
  const rig = fresh();
  const count = () => { let n = 0; rig.group.traverse(() => n++); return n; };
  const n0 = count();
  const rand = rng(3);
  for (let i = 0; i < 50; i++) { rig.setPose({ root: { y: rand() }, angles: { knee_L: [rand() * 100, 0] } }); rig.select(JOINTS[i % 77].id); }
  rig.select(null);
  assert.equal(count(), n0);
  rig.dispose();
});

test("Rig is a class; buildRig and new Rig agree", () => {
  const a = buildRig(body), b = new Rig(body);
  assert.ok(a instanceof Rig);
  near(a.jointWorld("head").distanceTo(b.jointWorld("head")), 0);
  a.dispose(); b.dispose();
});

// ---- verifier round: regression tests ------------------------------------------------------------------------------------------------------
const profile = (H, sex = "M", mass = 78) => ({ id: `t:${H}`, label: "t", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: H, unit: "mm", status: "reported" }, mass: { value: mass, unit: "kg", status: "reported" } } });
const worldBox = (rig, id) => { rig.group.updateMatrixWorld(true); return new THREE.Box3().setFromObject(rig.view.boneMeshes.find((m) => m.userData.boneId === id)); };

test("sacrum and coccyx stay 0.075-0.085 of the stature long and above the ischial tuberosities on fitted bodies (they were 2.3 times too long)", () => {
  for (const [H, sex, mass] of [[1750, "M", 78], [1500, "F", 45], [1950, "M", 120], [1400, "both", 40], [2050, "M", 70]]) {
    const rig = buildRig(fitBody(profile(H, sex, mass)));
    const b = worldBox(rig, "sacrum"), isch = rig.landmarkWorld("ischial_L").y, stat = H / 1000;
    const len = b.max.y - b.min.y;
    assert.ok(len < 0.085 * stat && len > 0.06 * stat, `${H}: sacrum + coccyx ${len} m`);
    assert.ok(b.min.y > isch + 0.02 * stat, `${H}: lowest point ${b.min.y} vs ischial ${isch}`);
    assert.ok(b.max.y < rig.jointWorld("L5").y + 0.02 * stat, `${H}: top ${b.max.y} vs L5 ${rig.jointWorld("L5").y}`);
    // the iliac wings reach the sacrum (they floated 3-4 cm behind it when the pelvis was the template's)
    const sv = rig.view.boneMeshes.find((m) => m.userData.boneId === "sacrum"), iv = rig.view.boneMeshes.find((m) => m.userData.boneId === "innominate_L");
    const pts = (m) => { const a = m.geometry.attributes.position, out = []; for (let i = 0; i < a.count; i += 3) out.push(new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld)); return out; };
    const A = pts(sv), B = pts(iv);
    let dmin = Infinity;
    for (const p of A) for (const q of B) dmin = Math.min(dmin, p.distanceTo(q));
    assert.ok(dmin < 0.012 * stat / 1.75, `${H}: ilium to sacrum ${dmin} m`);
    rig.dispose();
  }
});

test("the fallback body has exactly the landmark ids, contact sets and joints of fit.js (a panel keyed on fit ids must not throw on it)", () => {
  for (const [H, form, sex] of [[1.75, "male", "M"], [1.5, "female", "F"], [1.9, "neutral", "both"]]) {
    const syn = syntheticBody(H, form), fit = fitBody(profile(H * 1000, sex, syn.mass));
    for (const id of Object.keys(fit.landmarks)) assert.ok(syn.landmarks[id], `synthetic lacks landmark ${id}`);
    assert.deepEqual(Object.keys(syn.contacts), Object.keys(fit.contacts));
    for (const k of Object.keys(fit.contacts)) assert.deepEqual(syn.contacts[k], fit.contacts[k], `contact set ${k}`);
    assert.deepEqual(Object.keys(syn.masses), Object.keys(fit.masses));
    for (const j of JOINTS) for (let i = 0; i < 3; i++) near(syn.joints[j.id].offset[i], fit.joints[j.id].offset[i], 1e-9, `${j.id} offset`);
    const rig = buildRig(syn);
    for (const id of Object.keys(fit.landmarks)) assert.ok(rig.landmarkWorld(id).toArray().every(Number.isFinite), id);
    for (const k of Object.keys(fit.contacts)) assert.ok(rig.contactPoints(k).length > 0, k);
    near(rig.landmarkWorld("heel_sole_L").y, 0, 1e-4, "same foot-sole geometry as fit.js");
    assert.equal(syn.synthetic, true);
    rig.dispose();
  }
});

test("setAngles / setSpine merge without touching the other joints: no collateral clamping, no collateral report", () => {
  const rig = fresh();
  rig.setPose({ angles: { knee_L: [200, 0] } }, { clamp: false });
  assert.equal(rig.angles.knee_L[0], 200);
  const rep = rig.setAngles({ elbow_L: [10] });
  assert.deepEqual(rep.clamped, []);
  assert.equal(rig.angles.knee_L[0], 200, "an unrelated joint outside its range is left alone");
  assert.equal(rig.angles.elbow_L[0], 10);
  const rep2 = rig.setSpine({ lumbar: [10, 0, 0] });
  assert.deepEqual(rep2.clamped, []);
  assert.equal(rig.angles.knee_L[0], 200);
  // what IS given is still clamped and reported, and a bad value changes nothing
  assert.deepEqual(rig.setAngles({ knee_R: [300, 0] }).clamped.map((c) => c.joint), ["knee_R"]);
  const before = JSON.stringify(rig.getPose());
  assert.throws(() => rig.setAngles({ elbow_R: [NaN] }));
  assert.equal(JSON.stringify(rig.getPose()), before);
  // setPose({ root }) with a partial root replaces the whole root (documented): a pose is a whole state
  rig.setPose({ root: { heading: 90 } });
  assert.equal(rig.root.y, 0);
});

test("a skin builder that throws, or returns junk, leaves a working skeleton-only rig (warns, keeps the error, frees what it can)", () => {
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a);
  try {
    let disposed = 0, mesh = null;
    const rig = fresh({ skinBuilder: () => { throw new Error("skin boom"); } });
    assert.equal(rig.skin, null);
    assert.match(rig.skinError.message, /skin boom/);
    assert.equal(warned.length, 1);
    assert.equal(rig.display.skeleton, true, "the skeleton is shown instead");
    rig.setAngles({ elbow_L: [40] });
    assert.equal(rig.view.boneMeshes.length, BONES.length);
    rig.dispose();
    // a builder that fails after creating its mesh: the half-built skin is detached and disposed
    const r2 = fresh({ skinBuilder: () => { mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); const h = { mesh, dispose() { disposed++; } }; Object.defineProperty(h, "mesh", { get() { throw new Error("late"); } }); return h; } });
    assert.equal(r2.skin, null);
    assert.equal(disposed, 1);
    r2.dispose();
    // junk
    const r3 = fresh({ skinBuilder: () => ({ mesh: { material: undefined } }) });
    assert.equal(r3.skin, null); assert.ok(r3.skinError);
    r3.dispose();
    const r4 = fresh({ skinBuilder: () => null });
    assert.equal(r4.skinError, null);
    r4.dispose();
  } finally { console.warn = warn; }
});

test("pickJoint / pickBone ignore a hidden rig or a hidden ancestor", () => {
  const rig = fresh();
  const w = rig.jointWorld("hip_L"), ray = () => rayAt(w.clone().add(new THREE.Vector3(0, 0, 1.5)), w);
  assert.equal(rig.pickJoint(ray()).id, "hip_L");
  assert.ok(rig.pickBone(ray()));
  const parent = new THREE.Group(); parent.add(rig.group);
  parent.visible = false;
  assert.equal(rig.pickJoint(ray()), null, "hidden ancestor");
  assert.equal(rig.pickBone(ray()), null);
  parent.visible = true; rig.group.visible = false;
  assert.equal(rig.pickJoint(ray()), null, "hidden rig");
  assert.equal(rig.pickBone(ray()), null);
  rig.group.visible = true;
  assert.equal(rig.pickJoint(ray()).id, "hip_L");
  rig.bones.get("hip_L").visible = false; // a hidden bone hides its markers and meshes
  assert.equal(rig.pickJoint(ray()), null);
});

test("pickJoint has a screen-space tolerance: the small spine and finger markers can be hit with a mouse", () => {
  const rig = fresh();
  const cam = new THREE.PerspectiveCamera(35, 1, 0.05, 50); cam.position.set(0, 1.1, 4.2); cam.lookAt(0, 0.9, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const H = 800; // pixels
  const ndcOf = (p) => { const v = p.clone().project(cam); return v; };
  const rayAtPx = (p, dxPx, dyPx) => { const v = ndcOf(p); const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(v.x + (dxPx / H) * 2, v.y + (dyPx / H) * 2), cam); return rc; };
  for (const id of ["L3", "T8", "index_dip_L", "middle_pip_R", "thumb_ip_L"]) {
    const p = rig.jointWorld(id);
    assert.equal(rig.pickJoint(rayAtPx(p, 0, 0)).id, id, `${id} centre`);
    const hit = rig.pickJoint(rayAtPx(p, 6, -4));
    assert.ok(hit && JOINTS.some((j) => j.id === hit.id), `${id} 7 px off`); // the nearest marker to the ray: maybe a neighbour, never null
    assert.equal(rig.pickJoint(rayAtPx(p, 6, -4), { tolerance: 0 })?.id === id, false, `${id} exact only: a miss`);
  }
  // far from every marker (beyond 40 px of the figure): nothing
  assert.equal(rig.pickJoint(rayAtPx(new THREE.Vector3(1.2, 0.9, 0), 0, 0)), null);
  // the closest marker wins among tolerance hits; an exact hit on a marker always wins over a near one
  const p = rig.jointWorld("L3"), q = rig.jointWorld("L2");
  const px = ndcOf(q).sub(ndcOf(p)).multiplyScalar(H / 2); // pixel offset between L2 and L3
  assert.ok(Math.hypot(px.x, px.y) < 40);
  assert.equal(rig.pickJoint(rayAtPx(p, px.x * 0.3, px.y * 0.3)).id, "L3");
  assert.equal(rig.pickJoint(rayAtPx(p, px.x * 0.7, px.y * 0.7)).id, "L2");
  // near / far and an orthographic camera
  const rc = rayAtPx(p, 3, 0); rc.far = 1;
  assert.equal(rig.pickJoint(rc), null);
  const oc = new THREE.OrthographicCamera(-1, 1, 1.4, -0.6, 0.05, 50); oc.position.set(0, 1, 4); oc.lookAt(0, 1, 0); oc.updateMatrixWorld(); oc.updateProjectionMatrix();
  const orc = new THREE.Raycaster(); const v = p.clone().project(oc);
  orc.setFromCamera(new THREE.Vector2(v.x + (5 / 800) * 2, v.y), oc);
  assert.ok(rig.pickJoint(orc), "orthographic");
  // a hand-made ray (no camera) hits exactly
  assert.equal(rig.pickJoint(new THREE.Raycaster(p.clone().add(new THREE.Vector3(0.02, 0, 2)), new THREE.Vector3(0, 0, -1))), null);
});

test("the DOF names of every joint are fanned around it: apart from each other in every axis view", () => {
  const rig = fresh();
  for (const id of ["pelvis", "hip_L", "shoulder_R", "L3", "T5", "C4", "head", "wrist_L", "index_mcp_L", "elbow_L", "mtp_L"]) {
    rig.select(id);
    const A = rig.labelAnchors().filter((a) => a.kind === "dof"), J = rig.jointWorld(id);
    assert.equal(A.length, JOINT_BY_ID[id].dof.length, id);
    for (const a of A) { const d = a.position.distanceTo(J); assert.ok(d > 0.09 && d < 0.3, `${id} ${a.text} ${d}`); }
    // each pair is separated by >= 9 cm in the front view (x, y), the side view (z, y) or the top view (x, z) - and vertically by >= 10 cm in the first two
    for (let i = 0; i < A.length; i++) for (let k = i + 1; k < A.length; k++) {
      const d = A[i].position.clone().sub(A[k].position);
      assert.ok(Math.abs(d.y) >= 0.099 || Math.hypot(d.x, d.z) >= 0.09, `${id}: ${A[i].text}/${A[k].text} ${d.toArray()}`);
      assert.ok(Math.hypot(d.x, d.y) >= 0.09 && Math.hypot(d.z, d.y) >= 0.09 && Math.hypot(d.x, d.z) >= 0.09 - 1e-9 || A.length === 1, `${id}: ${A[i].text}/${A[k].text} overlap in some view`);
    }
  }
});

test("the bone material is a mid tone with a silhouette darkening, so bones read against the light AND the dark background", () => {
  const rel = (hex) => { const c = new THREE.Color(hex); const f = (v) => v; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }; // linear relative luminance
  const L = rel(COLORS.bone);
  assert.ok(L < 0.45, `bone luminance ${L}`); // 0xe8dcc3 was 0.72: lit faces 1.03:1 against the light theme background
  const rig = fresh();
  const shader = { fragmentShader: "void main(){\n#include <normal_fragment_maps>\n}" };
  rig.view.boneMat.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb \*= mix\(0\.38/);
  assert.ok(rig.view.boneMat.customProgramCacheKey().includes("rim"));
  rig.dispose();
});

test("lazy bones: behind a skin the 118 bone meshes are not generated until the skeleton is shown (or asked for)", () => {
  const rig = buildRig(body, { skinBuilder: fakeSkinBuilder({ calls: 0, disposed: 0 }) });
  const boneMeshes = () => { const a = []; rig.group.traverse((o) => { if (o.name.startsWith("bone:")) a.push(o); }); return a; };
  assert.equal(boneMeshes().length, 0);
  assert.equal(rig.pickBone(rayAt(new THREE.Vector3(0, 1, 2), new THREE.Vector3(0, 1, 0))), null, "hidden skeleton: nothing, and nothing built");
  assert.equal(boneMeshes().length, 0);
  rig.setDisplay({ skin: false, skeleton: true });
  assert.equal(boneMeshes().length, BONES.length);
  assert.ok(boneMeshes().every((m) => m.visible));
  const w = rig.jointWorld("hip_L");
  assert.ok(rig.pickBone(rayAt(w.clone().add(new THREE.Vector3(0, 0, 1.5)), w)), "meshes built late are pickable at once (world matrices are fresh)");
  rig.setDisplay({ skin: true, skeleton: false });
  assert.ok(boneMeshes().every((m) => !m.visible));
  rig.dispose();
  // asking for the meshes of a rig that never showed them builds them, hidden
  const r2 = buildRig(body, { skinBuilder: fakeSkinBuilder({ calls: 0, disposed: 0 }) });
  assert.equal(r2.view.boneMeshes.length, BONES.length);
  assert.ok(r2.view.boneMeshes.every((m) => !m.visible));
  r2.dispose();
  assert.doesNotThrow(() => r2.view.dispose());
});

test("the selected joint's local axes are solid rods (a LineSegments is 1 px wide in WebGL)", () => {
  const rig = fresh();
  rig.select("shoulder_L");
  const ax = rig.view.triad.group.getObjectByName("axes");
  assert.ok(ax.isMesh && !ax.isLineSegments);
  ax.geometry.computeBoundingBox();
  const bb = ax.geometry.boundingBox;
  near(bb.max.x, 0.06 + 0.0034, 1e-3); near(bb.max.y, 0.06 + 0.0034, 1e-3); near(bb.max.z, 0.06 + 0.0034, 1e-3);
  assert.ok(ax.geometry.attributes.position.count > 100);
  rig.dispose();
});

test("grounding by lowestY keeps every bone vertex within 5 mm of the floor or above it, in lying, kneeling and crawling postures (fitted bodies)", () => {
  const POSES = {
    supine: { root: { flex: -90 } }, prone: { root: { flex: 90 }, angles: { shoulder_L: [170, 0, 0], shoulder_R: [170, 0, 0] } }, sideLeft: { root: { lat: 90 } },
    kneel: { angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [-40, 0, 0], ankle_R: [-40, 0, 0] } },
    allFours: { root: { flex: 90 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [140, 0], knee_R: [140, 0], shoulder_L: [90, 0, 0], shoulder_R: [90, 0, 0], wrist_L: [-70, 0], wrist_R: [-70, 0] } },
    headstand: { root: { flex: 180 } },
  };
  for (const [name, bodyOf] of [["synthetic", syntheticBody(1.75)], ["fit", fitBody(profile(1750))]]) {
    const rig = buildRig(bodyOf), v = new THREE.Vector3();
    for (const [pn, p] of Object.entries(POSES)) {
      rig.resetPose();
      rig.setPose({ root: { y: 0, ...(p.root || {}) }, angles: p.angles || {} });
      rig.setRoot({ y: -rig.lowestY() });
      rig.group.updateMatrixWorld(true);
      let miny = Infinity;
      for (const m of rig.view.boneMeshes) {
        const P = m.geometry.attributes.position.array;
        for (let i = 0; i < P.length; i += 3) miny = Math.min(miny, (m.isSkinnedMesh ? m.getVertexPosition(i / 3, v) : v.set(P[i], P[i + 1], P[i + 2])).applyMatrix4(m.matrixWorld).y);
      }
      assert.ok(miny > -0.005, `${name} ${pn}: lowest bone vertex ${(miny * 1000).toFixed(1)} mm`);
    }
    rig.dispose();
  }
});

// ---- review round 2: attachments, region limits, input handling ----------------------------------------------------------------------------
const T4_NAME = BONE_BY_ID.sternum.joint;

test("forearm pronation turns the hand about its own centre: wrist and ulna stay together, the radial head turns in place, both bodies and sides", () => {
  for (const b of [body, syntheticBody(1.55, "female")]) {
    const rig = buildRig(b);
    for (const sd of ["L", "R"]) {
      rig.setPose({ root: { y: rig.restRootY, heading: 25 }, angles: { shoulder_L: [30, 20, 10], shoulder_R: [30, 20, 10], [`elbow_${sd}`]: [50] } });
      const wrist = rig.jointWorld(`wrist_${sd}`).clone(), elbow = rig.jointWorld(`elbow_${sd}`).clone(), fa = rig.jointWorld(`forearm_${sd}`).clone();
      // the forearm joint is on the vertical (in the elbow's frame) through the wrist, a quarter of the forearm above it: that is the twist axis
      const eq = rig.jointQuaternion(`elbow_${sd}`).invert();
      const wl = wrist.clone().sub(fa).applyQuaternion(eq);
      near(wl.x, 0, 1e-9, "wrist on the axis"); near(wl.z, 0, 1e-9, "wrist on the axis");
      near(fa.distanceTo(wrist), 0.25 * Math.abs(b.joints[`wrist_${sd}`].offset[1]), 2e-3, "a quarter of the forearm above the wrist");
      const sty = rig.landmarkWorld(`stylion_${sd}`);
      const radius = (p) => { const q = p.clone().sub(fa).applyQuaternion(eq); return Math.hypot(q.x, q.z); };
      const r0 = radius(sty);
      for (const pron of [-80, -45, 45, 80]) {
        rig.setAngles({ [`forearm_${sd}`]: [pron] });
        assert.ok(rig.jointWorld(`wrist_${sd}`).distanceTo(wrist) < 1e-9, `${sd} wrist moved with pronation ${pron}`);
        assert.ok(rig.jointWorld(`elbow_${sd}`).distanceTo(elbow) < 1e-9);
        for (const id of [`palm_centre_${sd}`, `grip_centre_${sd}`, `middle_dip_${sd}`]) { // the hand turns about the vertical through the wrist: its distance to it is constant
          const p = id.startsWith("middle") ? rig.jointWorld(id) : rig.landmarkWorld(id);
          rig.setAngles({ [`forearm_${sd}`]: [0] });
          const p0 = id.startsWith("middle") ? rig.jointWorld(id).clone() : rig.landmarkWorld(id).clone();
          rig.setAngles({ [`forearm_${sd}`]: [pron] });
          near(radius(p), radius(p0), 1e-9, `${id} distance to the pronation axis`);
        }
        near(radius(rig.landmarkWorld(`stylion_${sd}`)), r0, 1e-9, "radial styloid circles the axis");
      }
      // the radius is skinned between the elbow (its head stays on the humerus) and the forearm joint (its distal end turns with the hand)
      const mesh = rig.view.boneMeshes.find((m) => m.userData.boneId === `radius_${sd}`);
      assert.ok(mesh.isSkinnedMesh);
      assert.equal(mesh.parent, rig.bones.get(`forearm_${sd}`));
      const wts = mesh.geometry.attributes.skinWeight.array, ebone = rig.bones.get(`elbow_${sd}`), fbone = rig.bones.get(`forearm_${sd}`);
      const headV = [], distV = [];
      for (let i = 0; i < wts.length / 4; i++) { if (wts[4 * i + 1] === 0) headV.push(i); else if (wts[4 * i + 1] === 1) distV.push(i); }
      assert.ok(headV.length >= 30 && distV.length >= 100 && headV.length + distV.length < wts.length / 4, "head, distal end and a blended shaft between");
      const inFrame = (i, bone) => bone.worldToLocal(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
      rig.setAngles({ [`forearm_${sd}`]: [0] });
      const h0 = headV.map((i) => inFrame(i, ebone)), d0 = distV.map((i) => inFrame(i, fbone));
      for (const pron of [-80, 80]) {
        rig.setAngles({ [`forearm_${sd}`]: [pron] });
        headV.forEach((i, k) => assert.ok(inFrame(i, ebone).distanceTo(h0[k]) < 1e-6, "radial head stays on the elbow"));
        distV.forEach((i, k) => assert.ok(inFrame(i, fbone).distanceTo(d0[k]) < 1e-6, "distal radius turns with the forearm joint"));
      }
      rig.setAngles({ [`forearm_${sd}`]: [0] });
      const ulna = rig.boneSegment(`ulna_${sd}`), at = rig.view.boneMeshes.find((m) => m.userData.boneId === `ulna_${sd}`);
      assert.equal(at.parent, rig.bones.get(`elbow_${sd}`));
      assert.ok(ulna.b.distanceTo(rig.jointWorld(`wrist_${sd}`)) < 1e-12);
    }
    rig.dispose();
  }
  // data that already has this form is not touched again, and the rest pose of every joint but the forearm is the body's
  const r1 = buildRig(body), r2 = buildRig(r1.restBody);
  assert.equal(r2.restBody, r1.restBody);
  near(r1.restBody.joints.forearm_L.offset[0], body.joints.wrist_L.offset[0], 1e-12); near(r1.restBody.joints.wrist_L.offset[0], 0, 1e-12);
  near(r1.restBody.joints.forearm_R.offset[0], body.joints.wrist_R.offset[0], 1e-12);
  assert.equal(r1.restBody.joints.knee_L.offset, r1.restBody.joints.knee_L.offset);
  r1.dispose(); r2.dispose();
});

test("rebasing keeps every landmark, contact and mass at its neutral world position (the sternum landmarks ride on the sternum bone)", () => {
  const rig = fresh();
  rig.resetPose();
  for (const id of rig.landmarkIds) {
    const l = body.landmarks[id], w = rig.landmarkWorld(id), n = lmWorldNeutral(body, id);
    for (let i = 0; i < 3; i++) near(w.getComponent(i), n[i], 1e-5, `${id} at rest`); // body.positions is rounded to 1 um
  }
  for (const id of ["xiphoid", "substernale", "suprasternale"]) assert.equal(rig.restBody.landmarks[id].joint, T4_NAME, id);
  assert.equal(rig.restBody.landmarks.chest_front.joint, body.landmarks.chest_front.joint, "skin landmarks stay where fit.js put them");
  assert.equal(rig.restBody.landmarks.stylion_L.joint, "forearm_L");
  // contact sets and the centre of mass at rest are those of the body
  const flat = (b) => Object.fromEntries(Object.entries(b.contacts).map(([k, set]) => [k, set.map((c) => (typeof c === "string" ? lmWorldNeutral(b, c) : null))]));
  for (const [k, set] of Object.entries(flat(body))) rig.contactPoints(k).forEach((p, i) => { if (set[i]) for (let c = 0; c < 3; c++) near(p.getComponent(c), set[i][c], 1e-5, `${k}[${i}]`); });
  const com = rig.centerOfMass().point, ref = new THREE.Vector3(), M = Object.values(body.masses).reduce((s, m) => s + m.mass, 0);
  for (const m of Object.values(body.masses)) ref.addScaledVector(new THREE.Vector3(...body.positions[m.com.joint]).add(new THREE.Vector3(...m.com.offset)), m.mass / M);
  assert.ok(com.distanceTo(ref) < 1e-5, `centre of mass ${com.distanceTo(ref)}`);
  // and a { joint, offset } contact on the forearm joint (which moved) keeps its place
  const b2 = { ...body, contacts: { probe: [{ joint: "forearm_L", offset: [0.01, -0.05, 0.02] }] } };
  const r2 = buildRig(b2);
  const want = new THREE.Vector3(...body.positions.forearm_L).add(new THREE.Vector3(0.01, -0.05, 0.02));
  assert.ok(r2.contactPoints("probe")[0].distanceTo(want) < 1e-5);
  r2.dispose(); rig.dispose();
});

test("bones and landmarks move with what they are drawn on: bone ends rigid with their joint (all but the nominal radius end), sternum landmarks, ribs and cartilage on the sternum", () => {
  const rnd = rng(5);
  for (const [stature, form] of [[1.75, "male"], [1.55, "female"]]) {
    const rig = buildRig(syntheticBody(stature, form));
    rig.resetPose();
    rig.group.position.set(0.3, 0.1, -0.2); rig.group.rotation.y = 0.4; rig.group.updateMatrixWorld(true); // a host that moves the rig group: the skinned ribs must follow
    const N = {};
    for (const j of JOINTS) N[j.id] = rig.jointWorld(j.id).clone();
    const wp = (e) => (e.startsWith("lm:") ? rig.landmarkWorld(e.slice(3)) : rig.jointWorld(e)).clone();
    for (const d of BONES) for (const e of [d.from, d.to]) if (e) N[e] ??= wp(e);
    const T4 = rig.bones.get(T4_NAME), sk = rig.view.boneMeshes.filter((m) => m.isSkinnedMesh && BONE_BY_ID[m.userData.boneId].kind === "rib");
    assert.equal(sk.length, 20, "ribs 1-10, both sides");
    const rest = new Map(); // neutral position of the cartilage / back vertices of each rib in the frame of the bone that carries them
    const local = (m, i, bone, v) => bone.worldToLocal(m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld));
    const cart = (m) => { const c = m.geometry.attributes.color.array, out = []; for (let i = 0; i < c.length / 3; i++) if (m.geometry.attributes.skinWeight.array[4 * i + 1] >= 1) out.push(i); return out; };
    const back = (m) => { const w = m.geometry.attributes.skinWeight.array, out = []; for (let i = 0; i < w.length / 4; i++) if (w[4 * i + 1] === 0) out.push(i); return out; };
    const split = sk.filter((m) => BONE_BY_ID[m.userData.boneId].level !== 4); // rib 4 sits on the sternum bone itself: rigid on T4 throughout
    for (const m of split) {
      const own = rig.bones.get(`T${BONE_BY_ID[m.userData.boneId].level}`);
      assert.ok(cart(m).length > 20 && back(m).length > 20, `${m.name} has a back and a front`);
      rest.set(m, { cart: cart(m).map((i) => local(m, i, T4, new THREE.Vector3())), back: back(m).map((i) => local(m, i, own, new THREE.Vector3())) });
    }
    let worst = 0, worstRib = 0;
    for (let k = 0; k < 30; k++) {
      const angles = {};
      for (const j of JOINTS) angles[j.id] = j.dof.map((dd) => dd.min + (dd.max - dd.min) * (0.5 + 0.5 * (rnd() * 2 - 1) * (k % 2 ? 1 : 0.3)));
      rig.setPose({ root: { x: rnd(), y: 1 + rnd(), z: rnd(), heading: rnd() * 360, flex: (rnd() - 0.5) * 180, lat: (rnd() - 0.5) * 90, rot: (rnd() - 0.5) * 90 }, angles });
      rig.setSpine({ thoracic: [-20 + 65 * rnd(), (rnd() - 0.5) * 30, (rnd() - 0.5) * 60] });
      for (const d of BONES) {
        const seg = rig.boneSegment(d.id), jb = rig.bones.get(d.joint);
        for (const [e, real] of [[d.from, seg.a], [d.to, seg.b]]) {
          if (!e || (d.id.startsWith("radius_") && e === d.from)) continue; // the radius starts at the radial head, which is on the forearm joint, not at the elbow centre BONES names
          worst = Math.max(worst, jb.localToWorld(N[e].clone().sub(N[d.joint])).distanceTo(real.clone().applyMatrix4(rig.group.matrixWorld)));
        }
      }
      for (const m of split) {
        const own = rig.bones.get(`T${BONE_BY_ID[m.userData.boneId].level}`), r = rest.get(m), v = new THREE.Vector3();
        cart(m).forEach((vi, i) => { worstRib = Math.max(worstRib, local(m, vi, T4, v).distanceTo(r.cart[i])); });
        back(m).forEach((vi, i) => { worstRib = Math.max(worstRib, local(m, vi, own, v).distanceTo(r.back[i])); });
      }
    }
    assert.ok(worst < 1e-9, `${form}: a bone end moved ${worst} m away from its joint's frame`);
    assert.ok(worstRib < 1e-5, `${form}: a rib's back or cartilage left its bone by ${worstRib} m`);
    rig.dispose();
  }
});

test("a rib is rigid on its vertebra at the back and on the sternum at the front: thoracic flexion no longer pulls the cartilage off the sternum", () => {
  const rig = fresh();
  rig.resetPose();
  const pick = new Map(); // the cartilage vertex nearest to the midline at rest (the same vertex afterwards)
  const cartilageEnd = (id) => {
    const m = rig.view.boneMeshes.find((x) => x.userData.boneId === id), w = m.geometry.attributes.skinWeight.array, v = new THREE.Vector3();
    if (!pick.has(id)) {
      let best = -1, bx = Infinity;
      for (let i = 0; i < w.length / 4; i++) if (w[4 * i + 1] >= 1) { m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); if (Math.abs(v.x) < bx) { bx = Math.abs(v.x); best = i; } }
      pick.set(id, best);
    }
    return m.getVertexPosition(pick.get(id), v).applyMatrix4(m.matrixWorld);
  };
  const sternum = () => rig.landmarkWorld("xiphoid").clone();
  const rel = (p) => p.clone().sub(sternum()).length();
  const before = ["rib_7_L", "rib_10_R", "rib_5_L"].map((id) => rel(cartilageEnd(id)));
  rig.setSpine({ thoracic: [45, 0, 0] });
  const after = ["rib_7_L", "rib_10_R", "rib_5_L"].map((id) => rel(cartilageEnd(id)));
  after.forEach((d, i) => near(d, before[i], 1e-6, "cartilage end to the xiphoid"));
  rig.setSpine({ thoracic: [0, 0, 40] });
  ["rib_7_L", "rib_10_R", "rib_5_L"].forEach((id, i) => near(rel(cartilageEnd(id)), before[i], 1e-6));
  // ribs 11 and 12 are free: plain rigid meshes on their vertebra
  for (const id of ["rib_11_L", "rib_12_R"]) assert.ok(!rig.view.boneMeshes.find((m) => m.userData.boneId === id).isSkinnedMesh);
  // picking a skinned rib in a bent, moved rig finds it where it is (the bounds of a skinned mesh do not follow the pose by themselves)
  rig.setPose({ root: { x: 0.6, y: 1.1, z: -0.4, heading: 70, flex: 30 }, angles: {} });
  rig.setSpine({ thoracic: [40, 10, 20] });
  const m = rig.view.boneMeshes.find((x) => x.userData.boneId === "rib_6_L"), mid = new THREE.Vector3(), target = new THREE.Vector3();
  const w = m.geometry.attributes.skinWeight.array;
  let c = 0;
  for (let i = 0; i < w.length / 4; i++) if (w[4 * i + 1] > 0.5 && w[4 * i + 1] < 0.9) { target.add(m.getVertexPosition(i, mid).applyMatrix4(m.matrixWorld)); c++; }
  target.multiplyScalar(1 / c);
  const from = target.clone().add(new THREE.Vector3(0.5, 0.2, 1.5).normalize().multiplyScalar(1.5)); // a ray from outside the chest towards the middle of the rib
  const hit = rig.pickBone(rayAt(from, target));
  assert.ok(hit, "a ray at the middle of a rib hits some bone");
  rig.dispose();
});

test("setSpine merges by region and reports what a region could not take (the vertebrae's own limits), like a clamp", () => {
  const rig = fresh();
  const lum = (c) => REGIONS.lumbar.joints.reduce((s, id) => s + rig.angles[id][c], 0), tho = (c) => REGIONS.thoracic.joints.reduce((s, id) => s + rig.angles[id][c], 0);
  rig.setSpine({ lumbar: [20, 0, 0], thoracic: [30, 0, 0] });
  const rep = rig.setSpine({ lumbar: [200, 0, 0] }); // more than the lumbar spine can bend: 60
  near(lum(0), 60, 1e-9);
  assert.deepEqual(rep.clamped, [{ joint: "lumbar", dof: "flex", requested: 200, applied: 60 }]);
  near(tho(0), 30, 1e-9, "a region that is not mentioned stays");
  assert.deepEqual(rig.setSpine({ lumbar: [200, 0, 0] }, undefined, { clamp: false }).clamped.map((c) => c.dof), ["flex"], "reported whatever clamp says: the vertebrae's limit is not a clamp");
  assert.deepEqual(rig.setSpine({ lumbar: [-100, 40, -30], cervical: [10, 0, 0] }).clamped, [
    { joint: "lumbar", dof: "flex", requested: -100, applied: -35 }, { joint: "lumbar", dof: "lat", requested: 40, applied: 25 }, { joint: "lumbar", dof: "rot", requested: -30, applied: -12 }]);
  assert.deepEqual(rig.setSpine({ thoracic: [45, 20, -40], cervical: [-60, 35, 70] }).clamped, [], "exactly the limits are not saturation");
  // per-vertebra additions: only their regions are touched, and a region total is reported without them
  const lumBefore = lum(0);
  const rep2 = rig.setSpine({}, { T6: [3, 0, 0] });
  assert.deepEqual(rep2.clamped, []);
  near(lum(0), lumBefore, 1e-12, "lumbar not mentioned");
  near(rig.angles.T6[0], 3, 1e-12, "thoracic region total 0 + the addition");
  near(tho(0) - 3, 0, 1e-9);
  assert.throws(() => rig.setSpine({ lumbar: [NaN, 0, 0] }));
  assert.throws(() => rig.setSpine({}, { X9: [1] }), /unknown vertebra/);
});

test("setPose keepPosition: a posture's root (orientation only) is applied without dropping the pelvis to the origin; null options mean the defaults", () => {
  const rig = fresh();
  rig.setPose({ root: { x: 0.4, y: 0.95, z: -0.2, heading: 10, flex: 5 }, angles: {} });
  rig.setPose({ root: { heading: 90, lat: 3 } }, { keepPosition: true });
  assert.deepEqual({ ...rig.root }, { x: 0.4, y: 0.95, z: -0.2, heading: 90, flex: 0, lat: 3, rot: 0 }, "x, y, z kept, the orientation fields not given are 0");
  rig.setPose({ root: { heading: 90 } });
  assert.equal(rig.root.y, 0, "without the option a root replaces the whole root (documented)");
  rig.setPose({ root: { y: 1, x: undefined }, angles: { knee_L: [10, 0] } }, { keepPosition: true });
  assert.equal(rig.root.x, 0);
  assert.deepEqual(rig.setPose({}, null), { clamped: [] });
  assert.deepEqual(rig.setAngles({ elbow_L: [200] }, null).clamped.map((c) => c.joint), ["elbow_L"]);
  rig.setRoot({ x: 2 }, null); assert.equal(rig.root.x, 2);
  rig.setRoot({ heading: undefined, y: 1.2 }); assert.equal(rig.root.heading, 0); assert.equal(rig.root.y, 1.2);
  assert.throws(() => rig.setPose({}, "clamp"), /options/);
  rig.dispose();
});

test("pickJoint / pickBone without a raycaster find nothing; body contacts are validated when the rig is built", () => {
  const rig = fresh();
  assert.equal(rig.pickJoint(null), null); assert.equal(rig.pickBone(undefined), null);
  rig.dispose();
  assert.throws(() => buildRig({ ...body, contacts: { feet: ["heel_sole_L", "no_such_landmark"] } }), /contacts\.feet\[1\].*no_such_landmark/);
  assert.throws(() => buildRig({ ...body, contacts: { feet: [{ joint: "nope", offset: [0, 0, 0] }] } }), /contacts\.feet\[0\]/);
  assert.throws(() => buildRig({ ...body, contacts: { feet: [{ joint: "T1", offset: [0, NaN, 0] }] } }), /contacts\.feet\[0\]/);
  assert.throws(() => buildRig({ ...body, contacts: { feet: "heel_sole_L" } }), /contacts\.feet must be an array/);
  assert.throws(() => buildRig({ ...body, contacts: 5 }), /body\.contacts/);
  assert.doesNotThrow(() => buildRig({ ...body, contacts: undefined }).dispose());
  assert.doesNotThrow(() => buildRig({ ...body, contacts: null }).dispose());
});

test("lowestY({ skin: true }) includes the skin (default: landmarks and contacts only, which is cheap enough for IK loops)", () => {
  const skin = (b, bones) => {
    const geo = new THREE.BoxGeometry(0.4, 1.7, 0.2), n = geo.attributes.position.count;
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(4 * n), 4)); // every vertex on the pelvis bone
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(Float32Array.from({ length: 4 * n }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const mat = new THREE.MeshStandardMaterial();
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.bind(new THREE.Skeleton([...bones.values()]));
    return { mesh, dispose() { geo.dispose(); mat.dispose(); } };
  };
  const rig = buildRig(body, { skinBuilder: skin });
  rig.resetPose();
  const y0 = rig.lowestY();
  near(y0, 0, 1e-3);
  near(rig.lowestY({ skin: true }), -0.85, 1e-6, "the box (bound to the pelvis in the neutral pose) reaches 0.85 m below the floor");
  rig.setRoot({ y: rig.restRootY + 2 });
  near(rig.lowestY({ skin: true }), 2 - 0.85, 1e-6, "follows the pose of the bones it is skinned to");
  near(rig.lowestY(), y0 + 2, 1e-6);
  assert.equal(rig.lowestY(), rig.lowestY({ skin: false }));
  const bare = fresh();
  assert.equal(bare.lowestY({ skin: true }), bare.lowestY(), "no skin: nothing to add");
  rig.dispose(); bare.dispose();
});

test("selection ring and axes triad of the forearm are centred on the joint (and so are the other joints'); the hover colour is not white", () => {
  const rig = fresh();
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const id of ["forearm_L", "forearm_R", "elbow_L", "knee_R", "T7"]) {
    rig.setPose({ root: { y: 1, heading: 30 }, angles: { elbow_L: [60], elbow_R: [20] } });
    rig.select(id);
    rig.group.updateMatrixWorld(true);
    rig.view.ring.getWorldPosition(p); rig.view.triad.group.getWorldPosition(q);
    assert.ok(p.distanceTo(rig.jointWorld(id)) < 1e-9, `${id} ring`);
    assert.ok(q.distanceTo(rig.jointWorld(id)) < 1e-9, `${id} triad`);
  }
  assert.notEqual(rig.view.hiMat.color.getHex(), 0xffffff);
  rig.dispose();
});

// ---- verifier round 4: skin culling / picking, skeleton disposal, rebased offsets, setSpine input ---------------------------------------------------
// a skin whose every vertex is on the pelvis bone: the box moves with the root only
function pelvisBoxSkin(b, bones) {
  const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  geo.translate(0, b.joints.pelvis.offset[1], 0);
  const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(4 * n), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(Float32Array.from({ length: 4 * n }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton([...bones.values()]));
  return { mesh, dispose() { geo.dispose(); mesh.material.dispose(); } };
}

test("a builder's skin is never frustum culled and is picked wherever the root goes (its cached bounds follow the pose)", () => {
  const rig = buildRig(body, { skinBuilder: pelvisBoxSkin });
  const y = rig.restRootY;
  const hits = (x, z = 0) => new THREE.Raycaster(new THREE.Vector3(x, y, z + 5), new THREE.Vector3(0, 0, -1)).intersectObject(rig.skin, false).length;
  assert.equal(rig.skin.frustumCulled, false);
  assert.ok(hits(0) > 0);
  assert.equal(hits(3), 0, "nothing is at x = 3 yet");
  for (const x of [3, -8, 20]) {
    rig.setRoot({ x });
    assert.equal(rig.skin.frustumCulled, false);
    assert.ok(hits(x) > 0, `picked at x = ${x}`);
    assert.equal(hits(0), 0, `and no longer at the origin when the body is at x = ${x}`);
  }
  // a camera that follows the body sees the skin: the frustum test of three itself
  rig.setRoot({ x: 3 });
  rig.group.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  cam.position.set(3, y, 4); cam.lookAt(3, y, 0); cam.updateMatrixWorld(true);
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  assert.ok(fr.intersectsBox(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(3, y, 0), new THREE.Vector3(0.4, 0.4, 0.4))));
  rig.dispose();
});

test("a skin with several skinned parts: all are un-culled and re-bounded (the builder's mesh may be a group)", () => {
  const build = (b, bones) => {
    const a = pelvisBoxSkin(b, bones), c = pelvisBoxSkin(b, bones);
    const root = new THREE.Group();
    root.add(a.mesh, c.mesh);
    return { mesh: root, dispose() { a.dispose(); c.dispose(); } };
  };
  const rig = buildRig(body, { skinBuilder: build });
  rig.setRoot({ x: 5 });
  rig.skin.traverse((o) => assert.equal(o.frustumCulled, false));
  const parts = rig.skin.children.filter((o) => o.isSkinnedMesh);
  assert.equal(parts.length, 2);
  const ray = new THREE.Raycaster(new THREE.Vector3(5, rig.restRootY, 5), new THREE.Vector3(0, 0, -1));
  for (const p of parts) assert.ok(ray.intersectObject(p, false).length > 0);
  rig.dispose();
});

test("dispose frees the skin's Skeleton (bone texture), whether the builder has a dispose() that forgets it, one that frees it too, or none", () => {
  const counted = (build) => (b, bones) => {
    const r = build(b, bones);
    const sk = r.mesh.skeleton, orig = sk.dispose.bind(sk);
    sk.disposals = 0;
    sk.dispose = () => { sk.disposals++; orig(); };
    return r;
  };
  for (const [name, build] of [
    ["dispose() forgets the skeleton", pelvisBoxSkin],
    ["no dispose() at all", (b, bones) => ({ mesh: pelvisBoxSkin(b, bones).mesh })],
    ["dispose() frees it too", (b, bones) => { const r = pelvisBoxSkin(b, bones); return { mesh: r.mesh, dispose() { r.dispose(); r.mesh.skeleton.dispose(); } }; }],
  ]) {
    const rig = buildRig(body, { skinBuilder: counted(build) });
    const sk = rig.skin.skeleton;
    rig.dispose();
    assert.ok(sk.disposals >= 1, name);
    rig.dispose(); // idempotent
  }
});

test("rig.restOffsets: a Kinematics built from them is the rig's kin in a bent, pronated arm; one built from body.joints is not (the forearm joint is rebased)", () => {
  const rig = fresh();
  const offs = rig.restOffsets, mine = new Kinematics(offs);
  assert.equal(Object.keys(offs).length, 76, "every joint but the pelvis");
  const theirs = {};
  for (const j of JOINTS) if (j.parent) theirs[j.id] = body.joints[j.id].offset;
  const other = new Kinematics(theirs);
  const angles = {};
  for (const j of JOINTS) angles[j.id] = j.dof.map(() => 0);
  Object.assign(angles, { elbow_L: [90], forearm_L: [80] });
  const root = { x: 0, y: body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 };
  rig.setPose({ root, angles });
  mine.solve(angles, root); other.solve(angles, root);
  const v = new THREE.Vector3();
  let worstMine = 0, worstTheirs = 0;
  for (const j of JOINTS) {
    worstMine = Math.max(worstMine, rig.jointWorld(j.id).distanceTo(mine.position(j.id, v)));
    worstTheirs = Math.max(worstTheirs, rig.jointWorld(j.id).distanceTo(other.position(j.id, v)));
  }
  assert.ok(worstMine < 1e-9, `restOffsets agree with kin: ${worstMine}`);
  assert.ok(worstTheirs > 0.01, "the documented deviation: body offsets put the hand elsewhere in pronated postures");
  // restOffsets are a copy: editing them cannot move the rig
  offs.wrist_L[1] = 99;
  assert.notEqual(rig.restOffsets.wrist_L[1], 99);
  // and at neutral everything but the forearm joint itself is where the body has it (body.positions are rounded to the micrometre)
  rig.resetPose();
  const off = JOINTS.filter((j) => rig.jointWorld(j.id).distanceTo(new THREE.Vector3(...body.positions[j.id])) > 2e-5).map((j) => j.id);
  assert.deepEqual(off, ["forearm_L", "forearm_R"]);
  rig.dispose();
});

test("setSpine says what is wrong with its input and changes nothing", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 1 }, angles: { head: [10, 5, 3] } });
  const before = snapshot(rig);
  for (const [args, re] of [
    [[{ lumbar: null }], /"lumbar" needs \[flex, lat, rot\]/],
    [[{}, { L3: null }], /"L3" needs \[flex, lat, rot\]/],
    [["x"], /regions must be an object/],
    [[[]], /regions must be an object/],
    [[5], /regions must be an object/],
    [[{}, "L3"], /perVertebra must be an object/],
    [[{ lumbar: [NaN] }], /not a finite number/],
    [[{ foo: [1] }], /unknown spine region/],
  ]) {
    assert.throws(() => rig.setSpine(...args), re, JSON.stringify(args));
    assert.equal(snapshot(rig), before, JSON.stringify(args));
  }
  assert.deepEqual(rig.setSpine(null).clamped, []);
  assert.deepEqual(rig.setSpine(undefined, undefined).clamped, []);
  rig.dispose();
});
