import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, jointQuaternion, neutralAngles } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";

const D2R = Math.PI / 180;
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const vnear = (a, b, eps = 1e-9, msg = "") => b.forEach((x, i) => near(a[i], x, eps, `${msg} [${i}]`));
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

// ---- a synthetic 1.75 m standing person (neutral world positions in metres, invented but plausible) ----------------------
const W = { pelvis: [0, 0.995, 0] };
const mir = (v) => [-v[0], v[1], v[2]];
{
  let y = W.pelvis[1];
  const stack = (ids, first, step, z) => ids.forEach((id, i) => { W[id] = [0, (y = y + (i === 0 ? first : step)), z]; });
  stack(["L5", "L4", "L3", "L2", "L1"], 0.045, 0.037, -0.01);
  stack(["T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1"], 0.0225, 0.0225, -0.025);
  stack(["C7", "C6", "C5", "C4", "C3", "C2", "C1"], 0.02, 0.018, -0.02);
  W.head = [0, y + 0.02, -0.005]; // occiput-C1
  W.jaw = [0, W.head[1] - 0.03, 0.03];
  W.eye_L = [0.032, W.head[1] + 0.08, 0.09];
  W.eye_R = mir(W.eye_L);
  const arm = {
    clavicle_L: [W.T4[0] + 0.02, W.T4[1] + 0.04, 0.05], shoulder_L: [0.19, 1.42, -0.01], elbow_L: [0.19, 1.13, -0.01],
    forearm_L: [0.19, 1.13, -0.01], wrist_L: [0.19, 0.87, -0.01],
    thumb_cmc_L: [0.195, 0.84, 0.01], thumb_mcp_L: [0.195, 0.80, 0.025], thumb_ip_L: [0.195, 0.765, 0.035],
    index_mcp_L: [0.19, 0.78, 0.02], index_pip_L: [0.19, 0.735, 0.02], index_dip_L: [0.19, 0.71, 0.02],
    middle_mcp_L: [0.19, 0.775, 0.0], middle_pip_L: [0.19, 0.725, 0.0], middle_dip_L: [0.19, 0.695, 0.0],
    ring_mcp_L: [0.19, 0.78, -0.02], ring_pip_L: [0.19, 0.735, -0.02], ring_dip_L: [0.19, 0.708, -0.02],
    little_mcp_L: [0.19, 0.79, -0.04], little_pip_L: [0.19, 0.76, -0.04], little_dip_L: [0.19, 0.74, -0.04],
  };
  const leg = { hip_L: [0.09, 0.935, -0.005], knee_L: [0.09, 0.505, -0.005], ankle_L: [0.09, 0.085, -0.005], mtp_L: [0.09, 0.02, 0.15] };
  for (const [id, v] of [...Object.entries(arm), ...Object.entries(leg)]) { W[id] = v; W[id.replace(/_L$/, "_R")] = mir(v); }
}
const OFFSETS = {};
for (const j of JOINTS) if (j.parent) OFFSETS[j.id] = W[j.id].map((x, k) => x - W[j.parent][k]);
const len3 = (a) => Math.hypot(...a);
const thigh = len3(OFFSETS.knee_L), shank = len3(OFFSETS.ankle_L), upperArm = len3(OFFSETS.elbow_L), forearm = len3(OFFSETS.wrist_L);
const ROOT0 = { x: 0, y: W.pelvis[1], z: 0 };

const fresh = () => new Kinematics(OFFSETS);
const pos = (k, id) => k.position(id).toArray();

test("the synthetic person is a plausible 1.75 m", () => {
  assert.equal(Object.keys(OFFSETS).length, 76);
  assert.ok(Math.abs(W.head[1] + 0.15 - 1.75) < 0.03, `top of head ${W.head[1] + 0.15}`);
  near(thigh, 0.43, 0.001);
});

test("neutral pose reproduces the neutral world positions", () => {
  const k = fresh().solve({}, ROOT0);
  for (const j of JOINTS) vnear(pos(k, j.id), W[j.id], 1e-12, j.id);
  for (const j of JOINTS) vnear(k.quaternion(j.id).toArray(), [0, 0, 0, 1], 1e-15, j.id);
  assert.equal(k.ids.length, 77);
  assert.deepEqual(k.ids, JOINTS.map((j) => j.id));
  // the root position moves everything rigidly
  k.solve({}, { x: 1, y: 0, z: -2 });
  vnear(pos(k, "head"), [W.head[0] + 1, W.head[1] - W.pelvis[1], W.head[2] - 2], 1e-12);
  // omitted arguments mean "neutral, root at the origin"
  k.solve();
  vnear(pos(k, "pelvis"), [0, 0, 0], 0);
  k.solve(neutralAngles(), ROOT0); // explicit zero arrays (including the pelvis) are fine
  vnear(pos(k, "knee_R"), W.knee_R, 1e-12);
});

test("hip flexion 90 puts the knee in front of the hip at the same height", () => {
  const k = fresh().solve({ hip_L: [90, 0, 0] }, ROOT0);
  const hip = pos(k, "hip_L"), knee = pos(k, "knee_L"), ankle = pos(k, "ankle_L");
  vnear(knee, [hip[0], hip[1], hip[2] + thigh], 1e-12, "knee");
  vnear(ankle, [hip[0], hip[1], hip[2] + thigh + shank], 1e-12, "straight leg forward");
  vnear(pos(k, "knee_R"), W.knee_R, 1e-12, "the other leg is untouched");
  // right side, same angles = same anatomical movement
  const r = fresh().solve({ hip_R: [90, 0, 0] }, ROOT0);
  vnear(pos(r, "knee_R"), [W.hip_R[0], W.hip_R[1], W.hip_R[2] + thigh], 1e-12);
});

test("hip 90 + knee 90 (sitting): ankle directly below the knee", () => {
  for (const s of ["L", "R"]) {
    const k = fresh().solve({ [`hip_${s}`]: [90, 0, 0], [`knee_${s}`]: [90, 0] }, ROOT0);
    const hip = pos(k, `hip_${s}`), knee = pos(k, `knee_${s}`), ankle = pos(k, `ankle_${s}`);
    vnear(knee, [hip[0], hip[1], hip[2] + thigh], 1e-12, "knee");
    vnear(ankle, [knee[0], knee[1] - shank, knee[2]], 1e-12, "ankle below the knee");
    // the foot still points forward: the toes are in front of the ankle
    const mtp = pos(k, `mtp_${s}`);
    assert.ok(mtp[2] > ankle[2] + 0.1);
  }
  // knee flexion alone swings the shank backward
  const k = fresh().solve({ knee_L: [90, 0] }, ROOT0);
  vnear(pos(k, "ankle_L"), [W.knee_L[0], W.knee_L[1], W.knee_L[2] - shank], 1e-12);
});

test("elbow flexion 90 brings the wrist forward of the elbow at elbow height", () => {
  for (const s of ["L", "R"]) {
    const k = fresh().solve({ [`elbow_${s}`]: [90] }, ROOT0);
    const el = pos(k, `elbow_${s}`), wr = pos(k, `wrist_${s}`);
    vnear(el, W[`elbow_${s}`], 1e-12);
    vnear(wr, [el[0], el[1], el[2] + forearm], 1e-12);
  }
});

test("shoulder abduction 90 puts the elbow out to the side (+X left, -X right)", () => {
  let k = fresh().solve({ shoulder_L: [0, 90, 0] }, ROOT0);
  let sh = pos(k, "shoulder_L");
  vnear(pos(k, "elbow_L"), [sh[0] + upperArm, sh[1], sh[2]], 1e-12);
  vnear(pos(k, "wrist_L"), [sh[0] + upperArm + forearm, sh[1], sh[2]], 1e-12);
  k = fresh().solve({ shoulder_R: [0, 90, 0] }, ROOT0);
  sh = pos(k, "shoulder_R");
  vnear(pos(k, "elbow_R"), [sh[0] - upperArm, sh[1], sh[2]], 1e-12);
  // shoulder flexion 90 -> forward; 180 -> overhead
  k = fresh().solve({ shoulder_L: [90, 0, 0] }, ROOT0);
  sh = pos(k, "shoulder_L");
  vnear(pos(k, "elbow_L"), [sh[0], sh[1], sh[2] + upperArm], 1e-12);
  k = fresh().solve({ shoulder_L: [180, 0, 0] }, ROOT0);
  vnear(pos(k, "elbow_L"), [sh[0], sh[1] + upperArm, sh[2]], 1e-12);
});

test("root heading turns the whole figure about the vertical through the pelvis", () => {
  const k0 = fresh().solve({ hip_L: [30, 10, 0], knee_L: [50, 0], elbow_R: [70] }, ROOT0);
  const p0 = JOINTS.map((j) => pos(k0, j.id));
  const k = fresh().solve({ hip_L: [30, 10, 0], knee_L: [50, 0], elbow_R: [70] }, { ...ROOT0, heading: 90 });
  JOINTS.forEach((j, i) => {
    const d = [p0[i][0] - ROOT0.x, p0[i][1] - ROOT0.y, p0[i][2] - ROOT0.z];
    vnear(pos(k, j.id), [ROOT0.x + d[2], ROOT0.y + d[1], ROOT0.z - d[0]], 1e-12, j.id); // Ry(90): (x,y,z) -> (z,y,-x)
  });
  // the figure now faces +X, its left hip is at -Z
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(k.quaternion("head"));
  vnear(fwd.toArray(), [1, 0, 0], 1e-12);
  assert.ok(pos(k, "hip_L")[2] < ROOT0.z);
  // -90 turns right; 360 is a full turn
  vnear(pos(fresh().solve({}, { ...ROOT0, heading: 360 }), "head"), W.head, 1e-12);
  assert.ok(pos(fresh().solve({}, { ...ROOT0, heading: -90 }), "hip_L")[2] > 0);
});

test("root flex -90 lays the figure supine; +90 prone; lat tilts sideways", () => {
  const k = fresh().solve({}, { x: 0, y: 0.2, z: 0.5, flex: -90 });
  const head = pos(k, "head"), ankle = pos(k, "ankle_L");
  const up = W.head[1] - W.pelvis[1], down = W.pelvis[1] - W.ankle_L[1];
  vnear(head, [W.head[0], 0.2 + (W.head[2] - 0), 0.5 - up], 1e-12, "head toward -Z");
  vnear(ankle, [W.ankle_L[0], 0.2 + W.ankle_L[2], 0.5 + down], 1e-12, "feet toward +Z");
  vnear(new THREE.Vector3(0, 0, 1).applyQuaternion(k.quaternion("head")).toArray(), [0, 1, 0], 1e-12, "face up");
  vnear(new THREE.Vector3(0, 1, 0).applyQuaternion(k.quaternion("head")).toArray(), [0, 0, -1], 1e-12, "head axis");
  const p = fresh().solve({}, { ...ROOT0, flex: 90 });
  assert.ok(pos(p, "head")[2] > 0.5, "prone: head toward +Z");
  vnear(new THREE.Vector3(0, 0, 1).applyQuaternion(p.quaternion("head")).toArray(), [0, -1, 0], 1e-12, "face down");
  const l = fresh().solve({}, { ...ROOT0, lat: 90 });
  assert.ok(pos(l, "head")[0] > 0.5, "lat +90 tilts the head toward +X (the figure's left)");
  // rot twists about the pelvis's own vertical
  const r = fresh().solve({}, { ...ROOT0, rot: 90 });
  vnear(new THREE.Vector3(0, 0, 1).applyQuaternion(r.quaternion("head")).toArray(), [1, 0, 0], 1e-12);
});

test("pronation turns the hand about the forearm axis and keeps the wrist where it is", () => {
  const k0 = fresh().solve({}, ROOT0), k = fresh().solve({ forearm_L: [90] }, ROOT0);
  vnear(pos(k, "wrist_L"), pos(k0, "wrist_L"), 1e-12, "wrist stays");
  vnear(pos(k, "elbow_L"), pos(k0, "elbow_L"), 1e-12, "elbow stays");
  // the thumb base was 0.02 m in front of the wrist; after 90 degrees of pronation it is on the medial side (-X for the left)
  const w = pos(k0, "wrist_L"), t0 = pos(k0, "thumb_cmc_L"), t1 = pos(k, "thumb_cmc_L");
  const d = [t0[0] - w[0], t0[1] - w[1], t0[2] - w[2]];
  vnear(t1, [w[0] - d[2], w[1] + d[1], w[2] + d[0]], 1e-12, "Ry(-90) about the forearm axis");
  assert.ok(t1[0] < w[0], "thumb moved medially");
  near(Math.hypot(t1[0] - w[0], t1[2] - w[2]), Math.hypot(d[0], d[2]), 1e-12, "distance to the axis is preserved");
  // all fingertips follow
  const dip = pos(k, "index_dip_L");
  near(Math.hypot(dip[0] - w[0], dip[2] - w[2]), Math.hypot(W.index_dip_L[0] - w[0], W.index_dip_L[2] - w[2]), 1e-12);
});

test("toWorld maps a neutral-frame offset through the joint frame (landmarks)", () => {
  const k = fresh().solve({}, ROOT0);
  const out = new THREE.Vector3();
  vnear(k.toWorld("knee_L", [0, 0, 0.05], out).toArray(), [W.knee_L[0], W.knee_L[1], W.knee_L[2] + 0.05], 1e-12);
  vnear(k.toWorld("knee_L", { x: 0.01, y: 0.02, z: 0.03 }).toArray(), [W.knee_L[0] + 0.01, W.knee_L[1] + 0.02, W.knee_L[2] + 0.03], 1e-12);
  assert.equal(k.toWorld("knee_L", [0, 0, 0], out), out, "writes into `out`");
  // with the hip flexed 90 the patella (in front of the knee) is on top of it
  k.solve({ hip_L: [90, 0, 0] }, ROOT0);
  const knee = pos(k, "knee_L");
  vnear(k.toWorld("knee_L", [0, 0, 0.05]).toArray(), [knee[0], knee[1] + 0.05, knee[2]], 1e-12);
  // a landmark at the joint centre is the joint centre; with the whole figure turned the offset turns too
  vnear(k.toWorld("hip_R", [0, 0, 0]).toArray(), pos(k, "hip_R"), 1e-15);
  k.solve({}, { ...ROOT0, heading: 90 });
  vnear(k.toWorld("pelvis", [0, 0, 0.1]).toArray(), [ROOT0.x + 0.1, ROOT0.y, ROOT0.z], 1e-12);
  assert.throws(() => k.toWorld("nope", [0, 0, 0]), /nope/);
  assert.throws(() => k.position("nope"), /nope/);
  assert.throws(() => k.quaternion("nope"), /nope/);
});

// ---- agreement with an Object3D hierarchy ----------------------------------------------------------------------------------
test("200 random in-range poses agree with a recursive THREE.Object3D hierarchy", () => {
  const r = rng(2024);
  const objs = {};
  const scene = new THREE.Object3D();
  for (const j of JOINTS) {
    const o = new THREE.Object3D();
    o.position.fromArray(j.parent ? OFFSETS[j.id] : [0, 0, 0]);
    (j.parent ? objs[j.parent] : scene).add(o);
    objs[j.id] = o;
  }
  const k = fresh();
  const Ry = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  let worst = 0;
  for (let n = 0; n < 200; n++) {
    const angles = {};
    for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = j.dof.map((d) => d.min + (d.max - d.min) * r());
    const root = { x: r() * 4 - 2, y: r(), z: r() * 4 - 2, heading: (r() - 0.5) * 360, flex: (r() - 0.5) * 180, lat: (r() - 0.5) * 180, rot: (r() - 0.5) * 180 };
    k.solve(angles, root);
    for (const j of JOINTS) {
      if (j.id !== "pelvis") objs[j.id].quaternion.copy(jointQuaternion(j.id, angles[j.id]));
    }
    Ry.setFromAxisAngle(new THREE.Vector3(0, 1, 0), root.heading * D2R);
    objs.pelvis.quaternion.copy(Ry).multiply(jointQuaternion("pelvis", [root.flex, root.lat, root.rot]));
    objs.pelvis.position.set(root.x, root.y, root.z);
    scene.updateMatrixWorld(true);
    for (const j of JOINTS) {
      const e = objs[j.id].matrixWorld.elements;
      const p = pos(k, j.id);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(p[c] - e[12 + c]));
      objs[j.id].getWorldQuaternion(qa);
      k.quaternion(j.id, qb);
      const s = Math.sign(qa.dot(qb)) || 1;
      worst = Math.max(worst, Math.abs(qa.x - s * qb.x), Math.abs(qa.y - s * qb.y), Math.abs(qa.z - s * qb.z), Math.abs(qa.w - s * qb.w));
    }
  }
  assert.ok(worst < 1e-9, `worst deviation ${worst}`);
});

test("the optional pelvis entry composes after the root orientation", () => {
  const k = fresh().solve({ pelvis: [20, 0, 0] }, { ...ROOT0, heading: 30 });
  const ref = fresh().solve({}, { ...ROOT0, heading: 30, flex: 20 });
  for (const id of ["head", "knee_L", "wrist_R"]) vnear(pos(k, id), pos(ref, id), 1e-12, id);
});

test("input checking", () => {
  assert.throws(() => fresh().solve({ hand_L: [1] }, ROOT0), /hand_L/);
  assert.throws(() => fresh().solve({ hip_LR: [1] }, ROOT0), /hip_LR/, "_LR keys must be expanded first");
  assert.throws(() => fresh().solve({ elbow_L: 90 }, ROOT0), /elbow_L/);
  assert.throws(() => fresh().solve({ elbow_L: [90, 5] }, ROOT0), /elbow_L.*1 DOF/);
  assert.doesNotThrow(() => fresh().solve({ elbow_L: [90, 0, 0] }, ROOT0), "trailing zeros are tolerated");
  assert.doesNotThrow(() => fresh().solve({ elbow_L: new Float64Array([90]) }, ROOT0), "typed arrays work");
  const k = fresh();
  k.strict = false;
  assert.doesNotThrow(() => k.solve({ whatever: [1] }, ROOT0), "strict = false skips the id check");
  // constructor
  const bad = { ...OFFSETS };
  delete bad.knee_L;
  assert.throws(() => new Kinematics(bad), /knee_L/);
  assert.throws(() => new Kinematics({ ...OFFSETS, foo: [0, 0, 0] }), /foo/);
  assert.throws(() => new Kinematics({ ...OFFSETS, knee_L: [0, NaN, 0] }), /knee_L/);
  assert.throws(() => new Kinematics(), /offsets/);
  // the pelvis offset is ignored; {x,y,z} offsets are accepted
  const k2 = new Kinematics({ ...OFFSETS, pelvis: [9, 9, 9], knee_L: { x: OFFSETS.knee_L[0], y: OFFSETS.knee_L[1], z: OFFSETS.knee_L[2] } });
  k2.solve({}, ROOT0);
  vnear(pos(k2, "pelvis"), [ROOT0.x, ROOT0.y, ROOT0.z], 0);
  vnear(pos(k2, "knee_L"), W.knee_L, 1e-12);
  // setOffsets changes the figure
  const taller = { ...OFFSETS, knee_L: OFFSETS.knee_L.map((x, i) => (i === 1 ? x * 1.1 : x)) };
  k2.setOffsets(taller).solve({}, ROOT0);
  near(pos(k2, "knee_L")[1], W.hip_L[1] + OFFSETS.knee_L[1] * 1.1, 1e-12);
  assert.equal(k2.index("pelvis"), 0);
  assert.equal(k2.solve({}, ROOT0), k2, "solve returns this (chaining)");
});

test("solve is stateless: the result depends only on its arguments", () => {
  const k = fresh(), a = { hip_L: [100, 20, -10], knee_L: [120, 5], shoulder_R: [60, 80, -40] }, root = { x: 0.3, y: 0.9, z: -0.2, heading: 40, flex: 15 };
  const first = Array.from(k.solve(a, root).positions);
  k.solve({ hip_L: [0, 0, 0], elbow_L: [150] }, { x: 5 });
  assert.deepEqual(Array.from(k.solve(a, root).positions), first);
  assert.deepEqual(Array.from(fresh().solve(a, root).positions), first);
});

test("performance: 10,000 solves in well under 2 s", () => {
  const k = fresh(), r = rng(5);
  const poses = Array.from({ length: 50 }, () => {
    const a = {};
    for (const j of JOINTS) if (j.id !== "pelvis") a[j.id] = j.dof.map((d) => d.min + (d.max - d.min) * r());
    return a;
  });
  const root = { x: 0, y: 1, z: 0, heading: 20, flex: 5, lat: -3, rot: 8 };
  for (let i = 0; i < 500; i++) k.solve(poses[i % 50], root); // warm up
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) k.solve(poses[i % 50], root);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `10,000 solves took ${ms.toFixed(0)} ms`);
});

test("solve() does not allocate: no heap growth over 20,000 solves with strict = false", () => {
  // strict = true enumerates the keys of `angles` (for-in), which V8 allocates for large dictionary-mode objects such as
  // neutralAngles() (about 1.3 MB per 1000 solves here): hot loops set strict = false once their angle object is vetted.
  const k = fresh();
  k.strict = false;
  const a = neutralAngles();
  a.hip_L = [80, 10, 5]; a.knee_L = [90, 3]; a.shoulder_R = [100, 60, -20]; a.elbow_R = [120];
  const root = { x: 0, y: 1, z: 0, heading: 20, flex: 5, lat: -3, rot: 8 };
  for (let i = 0; i < 5000; i++) k.solve(a, root); // let the JIT settle
  const used = () => v8.getHeapStatistics().used_heap_size;
  let worst = 0, prev = used();
  for (let i = 0; i < 20000; i++) {
    a.hip_L[0] = 40 + (i % 90);
    k.solve(a, root);
    if (i % 1000 === 999) { const u = used(); worst = Math.max(worst, u - prev); prev = u; }
  }
  // measured: about 60 KB of noise per 1000 solves (allocation-buffer granularity) against more than 1 MB if solve() allocated
  assert.ok(worst < 256 * 1024, `heap grew by up to ${(worst / 1024).toFixed(0)} KB per 1000 solves`);
});

// ---- regressions for the verifier's defects ----------------------------------------------------------------------------
test("solve() does not allocate for a FULL pose of fractional angles (boxed doubles in the angle reads)", () => {
  const k = fresh();
  k.strict = false;
  const a = {};
  for (const j of JOINTS) a[j.id] = j.dof.map((_, i) => 10.37 + 0.41 * i);
  const root = { x: 0, y: 1, z: 0, heading: 20.5, flex: 5.5, lat: 3.1, rot: 2.2 };
  for (let i = 0; i < 30000; i++) k.solve(a, root);
  const used = () => v8.getHeapStatistics().used_heap_size;
  let worst = 0, prev = used();
  for (let r = 0; r < 6; r++) {
    for (let i = 0; i < 1000; i++) k.solve(a, root);
    const u = used(); worst = Math.max(worst, u - prev); prev = u;
  }
  assert.ok(worst < 128 * 1024, `heap grew by up to ${(worst / 1024).toFixed(0)} KB per 1000 solves`);
});

test("solve() rejects non-finite angles and root values, and null entries, with a useful message", () => {
  assert.throws(() => fresh().solve({ hip_L: [NaN, 0, 0] }, ROOT0), /hip_L/);
  assert.throws(() => fresh().solve({ knee_R: [Infinity] }, ROOT0), /knee_R/);
  assert.throws(() => fresh().solve({}, { ...ROOT0, heading: NaN }), /root/);
  assert.throws(() => fresh().solve({}, { ...ROOT0, y: NaN }), /root/);
  assert.throws(() => fresh().solve({ pelvis: [NaN] }, ROOT0), /pelvis/);
  assert.throws(() => fresh().solve({ hip_L: null }, ROOT0), /hip_L.*array/);
  assert.throws(() => fresh().solve({ pelvis: null }, ROOT0), /pelvis.*array/);
  const k = fresh();
  assert.doesNotThrow(() => k.solve({ hip_L: [30, 0, 0] }, ROOT0), "still usable after a refusal");
  assert.ok(k.positions.every(Number.isFinite));
});

test("jointQuaternion and solve agree on extra entries (both throw for a non-zero extra)", () => {
  assert.throws(() => jointQuaternion("knee_L", [10, 5, 99]), RangeError);
  assert.throws(() => fresh().solve({ knee_L: [10, 5, 99] }, ROOT0), RangeError);
});

// ---- review round: regression tests ---------------------------------------------------------------------------------------
test("solve: an undefined entry is 0 (as in jointQuaternion); strings, booleans and null entries are refused; sparse arrays work", () => {
  const a = fresh().solve({ hip_L: [undefined, 5] }, ROOT0), b = fresh().solve({ hip_L: [0, 5] }, ROOT0);
  vnear(Array.from(a.positions), Array.from(b.positions), 0);
  const c = fresh().solve({ hip_L: [, 5] }, ROOT0); // eslint-disable-line no-sparse-arrays
  vnear(Array.from(c.positions), Array.from(b.positions), 0);
  for (const bad of ["30", true, null, NaN, Infinity]) {
    assert.throws(() => fresh().solve({ hip_L: [bad] }, ROOT0), RangeError, String(bad));
    assert.throws(() => fresh().solve({ pelvis: [bad] }, ROOT0), RangeError, `pelvis ${String(bad)}`);
  }
  assert.throws(() => fresh().solve({ knee_L: [10, 5, NaN] }, ROOT0), RangeError, "a NaN beyond the DOF count is refused too");
  vnear(Array.from(fresh().solve({ pelvis: [undefined, 10] }, ROOT0).positions), Array.from(fresh().solve({ pelvis: [0, 10] }, ROOT0).positions), 0);
  // identical verdict for the same input in jointQuaternion
  assert.doesNotThrow(() => jointQuaternion("hip_L", [undefined, 5]));
  assert.throws(() => jointQuaternion("hip_L", ["30"]), RangeError);
});

test("solve: root values are validated (strings, booleans, null, NaN), undefined means 0", () => {
  for (const bad of ["30", true, null, NaN, Infinity]) {
    for (const key of ["x", "y", "z", "heading", "flex", "lat", "rot"]) assert.throws(() => fresh().solve({}, { ...ROOT0, [key]: bad }), /root/, `${key}=${String(bad)}`);
  }
  assert.doesNotThrow(() => fresh().solve({}, { ...ROOT0, flex: undefined }));
});

test("strict = false is the unchecked IK path: still allocation-free and still refuses a non-finite result", () => {
  const k = fresh();
  k.strict = false;
  assert.throws(() => k.solve({ hip_L: [NaN] }, ROOT0), /hip_L/);
  assert.throws(() => k.solve({ knee_L: [10, 5, 99] }, ROOT0), RangeError);
  assert.doesNotThrow(() => k.solve({ hip_L: [30, 5, 0] }, ROOT0));
});

test("a failed setOffsets leaves the previous offsets untouched (all or nothing)", () => {
  const k = fresh(), before = Array.from(k.offsets);
  const o2 = {};
  for (const j of JOINTS) o2[j.id] = [1, 1, 1];
  delete o2.mtp_R;
  assert.throws(() => k.setOffsets(o2), /mtp_R/);
  assert.deepEqual(Array.from(k.offsets), before);
  o2.mtp_R = [1, 1, NaN];
  assert.throws(() => k.setOffsets(o2), /mtp_R/);
  assert.deepEqual(Array.from(k.offsets), before);
  assert.throws(() => k.setOffsets({ ...OFFSETS, nope: [0, 0, 0] }), /nope/);
  assert.deepEqual(Array.from(k.offsets), before);
  k.setOffsets({ ...OFFSETS, knee_L: [0, -0.5, 0] });
  near(k.offsets[3 * k.index("knee_L") + 1], -0.5);
});

test("offsets may be typed arrays, plain arrays, {x,y,z} or Vector3; short or string offsets are refused", () => {
  const typed = {};
  for (const [id, v] of Object.entries(OFFSETS)) typed[id] = new Float32Array(v);
  typed.L5 = new Float64Array(OFFSETS.L5);
  typed.head = new THREE.Vector3(...OFFSETS.head);
  const k = new Kinematics(typed);
  assert.equal(k.offsets[3 * k.index("L5") + 1], OFFSETS.L5[1]);
  near(k.offsets[3 * k.index("head") + 1], OFFSETS.head[1], 0);
  near(k.offsets[3 * k.index("knee_L") + 1], OFFSETS.knee_L[1], 1e-6);
  assert.throws(() => new Kinematics({ ...OFFSETS, L5: [0, 0.1] }), /L5/);
  assert.throws(() => new Kinematics({ ...OFFSETS, L5: ["0", "0.1", "0"] }), /L5/);
});

test("parentIndex is a per-instance copy: writing to it cannot corrupt other instances or solve()", () => {
  const a = fresh(), b = fresh();
  assert.notEqual(a.parentIndex, b.parentIndex);
  a.parentIndex.fill(0);
  assert.equal(b.parentIndex[5], 4);
  vnear(pos(a.solve({}, ROOT0), "head"), W.head, 1e-12);
});

// ---- verifier round: regression tests ---------------------------------------------------------------------------------------
test("solve is atomic: a throw (late bad angle, bad root, bad key) leaves positions and quaternions of the previous pose", () => {
  for (const strict of [true, false]) {
    const k = fresh();
    k.strict = strict;
    k.solve({ hip_L: [30, 0, 0], L3: [5, 2, 1] }, { ...ROOT0, y: 1 });
    const P = Array.from(k.positions), Q = Array.from(k.quaternions);
    assert.throws(() => k.solve({ hip_L: [10, 0, 0], mtp_R: [NaN] }, { ...ROOT0, y: 2 }), RangeError, `late bad angle strict=${strict}`);
    assert.deepEqual(Array.from(k.positions), P);
    assert.deepEqual(Array.from(k.quaternions), Q);
    assert.throws(() => k.solve({ hip_L: [10, 0, 0] }, { ...ROOT0, y: Infinity }), RangeError, `bad root strict=${strict}`);
    assert.deepEqual(Array.from(k.positions), P);
    if (strict) {
      assert.throws(() => k.solve({ nope: [1] }, { ...ROOT0, y: 3 }), /nope/);
      assert.deepEqual(Array.from(k.positions), P);
    }
    // and the next valid solve is not contaminated by the failed one
    const fresh2 = fresh();
    fresh2.strict = strict;
    vnear(Array.from(k.solve({ hip_L: [10, 0, 0] }, { ...ROOT0, y: 2 }).positions), Array.from(fresh2.solve({ hip_L: [10, 0, 0] }, { ...ROOT0, y: 2 }).positions), 0);
  }
});
