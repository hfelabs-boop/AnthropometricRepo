// Independent (adversarial) verification of skeleton.js + fk.js. Nothing here reads the author's probe / moves data: the
// expected anatomical direction of every DOF is written out below from first principles (right-hand rule, +Y up, +Z anterior,
// +X the figure's left). Tests named "DEFECT:" assert behaviour that the verifier believes is required but is not met.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import v8 from "node:v8";
import {
  JOINTS, JOINT_BY_ID, REGIONS, jointQuaternion, anglesFromQuaternion, expandRegions, expandSides, clampAngles, rootQuaternion,
  mirrorId, writeJointQuaternion, swingLength,
} from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";

const D2R = Math.PI / 180;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = [0, 1, 0], DOWN = [0, -1, 0], FWD = [0, 0, 1], BACK = [0, 0, -1];

// ---------------------------------------------------------------------------------------------------------------------
// 1. Sign / axis of every DOF against anatomy. s = +1 for the left side (lateral = +X), -1 for the right side.
// row: [joint stem, dof index, probe(s), expected direction of motion for a POSITIVE angle(s)]
const LAT = (s) => [s, 0, 0], MED = (s) => [-s, 0, 0];
const SPINE_ROWS = (id) => [
  [id, 0, () => UP, () => FWD, "forward bend"],
  [id, 1, () => UP, () => [1, 0, 0], "lean to the figure's left"],
  [id, 2, () => FWD, () => [1, 0, 0], "turn to the figure's left"],
];
const ROWS = [
  ...["pelvis", ...REGIONS.lumbar.joints, ...REGIONS.thoracic.joints, ...REGIONS.cervical.joints, "head"].flatMap(SPINE_ROWS),
  ["jaw", 0, () => [0, -0.6, 0.8], () => [0, -0.8, -0.6], "chin down and back"],
];
const PAIRED = [
  // stem, dof, probe, direction, text
  ["eye", 0, () => FWD, () => UP, "looks up"],
  ["clavicle", 0, (s) => LAT(s), () => UP, "lateral end up"],
  ["clavicle", 1, (s) => LAT(s), () => FWD, "lateral end forward"],
  ["shoulder", 0, () => DOWN, () => FWD, "arm forward"],
  ["shoulder", 1, () => DOWN, (s) => LAT(s), "arm out"],
  ["shoulder", 2, () => FWD, (s) => MED(s), "internal rotation: front of arm turns medially"],
  ["elbow", 0, () => DOWN, () => FWD, "forearm forward"],
  ["forearm", 0, () => FWD, (s) => MED(s), "pronation: thumb turns medially (mid-position, arm hanging)"],
  ["wrist", 0, () => DOWN, (s) => MED(s), "palmar flexion: hand toward the palm side (palm faces medially)"],
  ["wrist", 1, () => DOWN, () => FWD, "radial deviation: toward the thumb side (thumb forward)"],
  ["thumb_cmc", 0, () => DOWN, () => BACK, "flexion across the palm toward the ulnar side"],
  ["thumb_mcp", 0, () => DOWN, () => BACK, "thumb MCP flexion"],
  ["thumb_ip", 0, () => DOWN, () => BACK, "thumb IP flexion"],
  ...["index", "middle", "ring", "little"].flatMap((f) => [
    [`${f}_mcp`, 0, () => DOWN, (s) => MED(s), "finger curls toward the palm"],
    [`${f}_mcp`, 1, () => DOWN, () => (f === "index" || f === "middle" ? FWD : BACK), "spread away from the middle finger"],
    [`${f}_pip`, 0, () => DOWN, (s) => MED(s), "PIP flexion"],
    [`${f}_dip`, 0, () => DOWN, (s) => MED(s), "DIP flexion"],
  ]),
  ["hip", 0, () => DOWN, () => FWD, "thigh forward"],
  ["hip", 1, () => DOWN, (s) => LAT(s), "thigh out"],
  ["hip", 2, () => FWD, (s) => MED(s), "internal rotation"],
  ["knee", 0, () => DOWN, () => BACK, "heel toward the buttock"],
  ["knee", 1, () => FWD, (s) => MED(s), "internal rotation"],
  ["ankle", 0, () => FWD, () => UP, "dorsiflexion: toes up"],
  ["ankle", 1, () => DOWN, (s) => MED(s), "inversion: sole turns medially"],
  ["ankle", 2, () => FWD, (s) => MED(s), "toe-in"],
  ["mtp", 0, () => FWD, () => UP, "toes bend up"],
];
// thumb palmar abduction is tested separately (it is the contested one)
const sides = [["_L", 1], ["_R", -1]];
for (const [stem, di, probe, dir, text] of PAIRED) {
  for (const [suf, s] of sides) ROWS.push([stem + suf, di, () => probe(s), () => dir(s), text]);
}

test("every DOF: a positive angle moves the probe in the anatomically expected direction (independent table)", () => {
  assert.ok(ROWS.length > 150);
  for (const [id, di, probe, dir, text] of ROWS) {
    const j = JOINT_BY_ID[id];
    assert.ok(j, id);
    const p = V(...probe()), want = V(...dir()).normalize();
    for (const sg of [1, -1]) {
      const a = [0, 0, 0];
      a[di] = sg * 1;
      const q = jointQuaternion(id, a);
      const d = p.clone().applyQuaternion(q).sub(p);
      assert.ok(d.length() > 1e-4, `${id}[${di}] probe does not move`);
      const dot = d.normalize().dot(want) * sg;
      assert.ok(dot > 0.99, `${id}.${j.dof[di].key} ${sg > 0 ? "+" : "-"}: ${text}; direction cosine ${dot.toFixed(3)} (moved ${d.toArray().map((x) => x.toFixed(2))})`);
    }
  }
});

test("FIXED: thumb CMC palmar abduction moves the thumb toward the palm side (same side the fingers curl to), not the back of the hand", () => {
  for (const [suf, s] of sides) {
    const id = `thumb_cmc${suf}`;
    const d = V(...DOWN).applyQuaternion(jointQuaternion(id, [0, 20, 0])).sub(V(...DOWN));
    const finger = V(...DOWN).applyQuaternion(jointQuaternion(`index_mcp${suf}`, [20, 0])).sub(V(...DOWN));
    assert.ok(Math.sign(d.x) === Math.sign(finger.x), `${id}: palmar abduction dx=${d.x.toFixed(3)} but finger flexion dx=${finger.x.toFixed(3)} (palm faces ${s > 0 ? "-X" : "+X"})`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Mirroring
const reflectQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const sameRot = (a, b, eps = 1e-12) => 1 - Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) < eps;
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rndAngles = (j, f = 1) => j.dof.map((d) => (d.min + rnd() * (d.max - d.min)) * f);

test("right joint rotation is exactly the reflection (x -> -x) of the left one for the same angles; ranges equal", () => {
  for (const j of JOINTS) {
    if (j.side !== "L") continue;
    const r = JOINT_BY_ID[mirrorId(j.id)];
    assert.ok(r, j.id);
    assert.deepEqual(r.dof.map((d) => [d.key, d.role, d.min, d.max]), j.dof.map((d) => [d.key, d.role, d.min, d.max]));
    for (let n = 0; n < 20; n++) {
      const a = rndAngles(j);
      assert.ok(sameRot(jointQuaternion(r.id, a), reflectQ(jointQuaternion(j.id, a))), `${j.id} ${a}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Exp-map composition and swing/twist order, independently via three's axis-angle
function refQuat(id, a) {
  const j = JOINT_BY_ID[id];
  const sw = new THREE.Vector3(), tw = new THREE.Quaternion();
  j.dof.forEach((d, i) => {
    const ang = (a[i] ?? 0) * D2R;
    if (d.role === "twist") tw.setFromAxisAngle(V(...d.axis), ang);
    else sw.addScaledVector(V(...d.axis), ang);
  });
  const qs = sw.length() > 0 ? new THREE.Quaternion().setFromAxisAngle(sw.clone().normalize(), sw.length()) : new THREE.Quaternion();
  return qs.multiply(tw);
}
test("jointQuaternion == setFromAxisAngle(exp swing) * twist for random in-range angles, every joint", () => {
  for (const j of JOINTS) for (let n = 0; n < 25; n++) {
    const a = rndAngles(j);
    assert.ok(sameRot(jointQuaternion(j.id, a), refQuat(j.id, a), 1e-13), `${j.id} ${a}`);
  }
});
test("swing axes are perpendicular and perpendicular to the twist axis of the same joint", () => {
  for (const j of JOINTS) {
    for (let a = 0; a < j.dof.length; a++) for (let b = a + 1; b < j.dof.length; b++) {
      const dot = j.dof[a].axis.reduce((s, v, i) => s + v * j.dof[b].axis[i], 0);
      assert.equal(Math.abs(dot), 0, `${j.id}: ${a},${b}`);
    }
    const roles = j.dof.map((d) => d.role);
    assert.ok(roles.filter((r) => r === "twist").length <= 1, j.id);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. anglesFromQuaternion
test("inverse: random in-range angles with swing < 170 deg round-trip to the angles (and in rotation), every joint", () => {
  let checked = 0;
  for (const j of JOINTS) for (let n = 0; n < 200; n++) {
    const a = rndAngles(j);
    if (swingLength(j.id, a) > 170) continue;
    const back = anglesFromQuaternion(j.id, jointQuaternion(j.id, a));
    a.forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-7, `${j.id}[${i}] ${v} -> ${back[i]} (angles ${a})`));
    checked++;
  }
  assert.ok(checked > 5000);
});
test("inverse near the 180 deg swing singularity: the rotation always round-trips, angles when twist is zero", () => {
  const j = JOINT_BY_ID.shoulder_L;
  for (const sw of [170, 178, 179.9, 179.999, 180]) for (const tw of [-80, -10, 0, 10, 80]) {
    const a = [sw, 0, tw], q = jointQuaternion(j.id, a);
    const back = anglesFromQuaternion(j.id, q);
    assert.ok(back.every(Number.isFinite), `${sw},${tw}`);
    assert.ok(sameRot(jointQuaternion(j.id, back), q, 1e-9), `rotation ${sw},${tw} -> ${back}`);
    if (sw <= 179.999) assert.ok(Math.abs(back[2] - tw) < 1e-4 || tw === 0, `twist ${sw},${tw} -> ${back}`);
  }
});
test("inverse: degenerate inputs (zero quaternion, unnormalised, -q) do not leak NaN", () => {
  const z = anglesFromQuaternion("hip_L", new THREE.Quaternion(0, 0, 0, 0));
  assert.deepEqual(z, [0, 0, 0]);
  const q = jointQuaternion("hip_L", [30, 20, 10]);
  const a = anglesFromQuaternion("hip_L", q), b = anglesFromQuaternion("hip_L", new THREE.Quaternion(-q.x * 3, -q.y * 3, -q.z * 3, -q.w * 3));
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9));
});
test("inverse: dofs beyond +-180 twist alias but stay finite; ankle (twist axis -Z) round-trips", () => {
  const a = [20, 30, -10];
  const back = anglesFromQuaternion("ankle_R", jointQuaternion("ankle_R", a));
  a.forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-9));
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Kinematics against an independent scene graph
const IDS = JOINTS.map((j) => j.id);
function sampleOffsets() {
  const o = {};
  for (const j of JOINTS) {
    if (j.id === "pelvis") continue;
    if (j.side === "R") continue;
    const xs = j.side === "L" ? 0.02 + 0.05 * rnd() : 0;
    o[j.id] = [xs, 0.2 * (rnd() - 0.5), 0.1 * (rnd() - 0.5)];
    if (j.side === "L") o[mirrorId(j.id)] = [-o[j.id][0], o[j.id][1], o[j.id][2]];
  }
  return o;
}
function sceneFk(offsets, angles, root) {
  const obj = {};
  for (const j of JOINTS) {
    const o = new THREE.Object3D();
    if (j.id !== "pelvis") o.position.set(...offsets[j.id]);
    o.quaternion.copy(refQuat(j.id, angles[j.id] ?? []));
    obj[j.id] = o;
    if (j.parent) obj[j.parent].add(o);
  }
  const p = obj.pelvis;
  const qr = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), (root.heading ?? 0) * D2R).multiply(refQuat("pelvis", [root.flex ?? 0, root.lat ?? 0, root.rot ?? 0]));
  p.quaternion.copy(qr);
  p.position.set(root.x ?? 0, root.y ?? 0, root.z ?? 0);
  p.updateMatrixWorld(true);
  return obj;
}
test("Kinematics agrees with a three.js scene graph for random poses and roots", () => {
  for (let n = 0; n < 15; n++) {
    const off = sampleOffsets(), k = new Kinematics(off);
    const ang = {};
    for (const j of JOINTS) if (j.id !== "pelvis") ang[j.id] = rndAngles(j);
    const root = { x: rnd(), y: rnd(), z: rnd(), heading: 360 * rnd() - 180, flex: 90 * rnd(), lat: 60 * rnd() - 30, rot: 60 * rnd() };
    k.solve(ang, root);
    const sg = sceneFk(off, ang, root);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
    for (const id of IDS) {
      sg[id].getWorldPosition(wp);
      sg[id].getWorldQuaternion(wq);
      assert.ok(k.position(id).distanceTo(wp) < 1e-12, `${id} position`);
      assert.ok(sameRot(k.quaternion(id), wq, 1e-13), `${id} orientation`);
    }
    // toWorld agrees with matrixWorld
    const lp = V(0.03, -0.07, 0.11);
    assert.ok(k.toWorld("wrist_L", lp).distanceTo(lp.clone().applyMatrix4(sg.wrist_L.matrixWorld)) < 1e-12);
  }
});
test("Kinematics: a symmetric pose gives mirror-image joint centres; ISO sitting chain (hip+knee 90) folds the right way", () => {
  const off = sampleOffsets(), k = new Kinematics(off);
  const ang = {};
  for (const j of JOINTS) if (j.side === "L") { const a = rndAngles(j); ang[j.id] = a; ang[mirrorId(j.id)] = a; }
  k.solve(ang, { y: 1 });
  for (const j of JOINTS) if (j.side === "L") {
    const l = k.position(j.id), r = k.position(mirrorId(j.id));
    assert.ok(Math.hypot(l.x + r.x, l.y - r.y, l.z - r.z) < 1e-12, j.id);
  }
  // thigh pointing down, knee at (0,-.4,0), ankle (0,-.4,0) below the knee; hip 90 then knee 90: shank points down again
  const o = {};
  for (const j of JOINTS) o[j.id] = [0, 0, 0];
  o.knee_L = [0, -0.4, 0]; o.ankle_L = [0, -0.4, 0]; o.knee_R = [0, -0.4, 0]; o.ankle_R = [0, -0.4, 0];
  const k2 = new Kinematics(o).solve({ hip_L: [90, 0, 0], knee_L: [90, 0, 0] }, {});
  const knee = k2.position("knee_L"), ankle = k2.position("ankle_L");
  assert.ok(knee.distanceTo(V(0, 0, 0.4)) < 1e-12, "knee forward of the hip");
  assert.ok(ankle.distanceTo(V(0, -0.4, 0.4)) < 1e-12, "ankle straight below the knee");
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Validation, NaN, mutation
test("Kinematics validation: unknown ids, bad offsets, bad angle containers", () => {
  const off = sampleOffsets();
  assert.throws(() => new Kinematics({ ...off, nonsense: [0, 0, 0] }));
  const bad = { ...off }; delete bad.knee_L;
  assert.throws(() => new Kinematics(bad));
  assert.throws(() => new Kinematics({ ...off, knee_L: [0, NaN, 0] }));
  const k = new Kinematics(off);
  assert.throws(() => k.solve({ foo: [1] }, {}));
  assert.throws(() => k.solve({ hip_L: [1, 2, 3, 4] }, {}));
  assert.throws(() => k.solve({ hip_L: 5 }, {}));
  assert.throws(() => k.position("nope"));
});
test("Kinematics.solve does not mutate its inputs or leak NaN for finite input", () => {
  const off = sampleOffsets(), k = new Kinematics(off);
  const ang = { hip_L: [30, 10, 5], head: [10, 5, 3] }, root = { y: 1, heading: 30 };
  const snap = JSON.stringify([ang, root, off]);
  k.solve(ang, root);
  assert.equal(JSON.stringify([ang, root, off]), snap);
  assert.ok(k.positions.every(Number.isFinite) && k.quaternions.every(Number.isFinite));
});
test("Kinematics: NaN angles are rejected or at least detectable (NaN must not silently poison the rig)", () => {
  const k = new Kinematics(sampleOffsets());
  let threw = false;
  try { k.solve({ hip_L: [NaN, 0, 0] }, {}); } catch { threw = true; }
  assert.ok(threw || k.positions.every(Number.isFinite), "NaN angle silently produced NaN joint centres");
});
test("two Kinematics instances share no mutable state", () => {
  const a = new Kinematics(sampleOffsets()), b = new Kinematics(sampleOffsets());
  a.solve({ hip_L: [90, 0, 0] }, { y: 1 });
  const before = Array.from(b.positions);
  a.solve({ hip_L: [10, 0, 0] }, { y: 3 });
  assert.deepEqual(Array.from(b.positions), before);
  assert.notEqual(a.ids, b.ids);
});

test("expandRegions: non-finite or non-numeric region totals must not leak NaN into the vertebrae", () => {
  let out, threw = false;
  try { out = expandRegions({ lumbar: [NaN, 0, 0] }); } catch { threw = true; }
  assert.ok(threw || Object.values(out).every((r) => r.every(Number.isFinite)), "NaN region total leaks into all lumbar levels");
});
test("expandRegions: totals beyond the region range are clamped, never beyond any vertebra's range", () => {
  const out = expandRegions({ lumbar: [500, 500, 500], thoracic: [-500, 500, -500], cervical: [500, -500, 500] });
  for (const [id, v] of Object.entries(out)) v.forEach((x, i) => {
    const d = JOINT_BY_ID[id].dof[i];
    assert.ok(x >= d.min - 1e-9 && x <= d.max + 1e-9, `${id}[${i}] = ${x}`);
  });
});
test("expandRegions: output rows are fresh arrays and the input is untouched", () => {
  const sp = { lumbar: [10, 5, 2] }, pv = { L3: [1, 1, 1] };
  const s = JSON.stringify([sp, pv]);
  const a = expandRegions(sp, pv), b = expandRegions(sp, pv);
  assert.equal(JSON.stringify([sp, pv]), s);
  a.L3[0] = 99;
  assert.notEqual(b.L3[0], 99);
});
test("expandRegions: distribution preserves the total below the limits (flex, lat, rot) for mixed signs", () => {
  for (let n = 0; n < 50; n++) {
    const sp = {};
    for (const [name, rg] of Object.entries(REGIONS)) sp[name] = [rg.range.flex[0] + rnd() * (rg.range.flex[1] - rg.range.flex[0]), (rnd() * 2 - 1) * rg.range.lat[1], (rnd() * 2 - 1) * rg.range.rot[1]];
    const out = expandRegions(sp);
    for (const [name, rg] of Object.entries(REGIONS)) for (let c = 0; c < 3; c++) {
      const sum = rg.joints.reduce((s, id) => s + out[id][c], 0);
      assert.ok(Math.abs(sum - sp[name][c]) < 1e-9, `${name}[${c}] ${sum} vs ${sp[name][c]}`);
    }
  }
});
test("clampAngles does not mutate and reports clamping", () => {
  const a = [999, -999, NaN];
  const r = clampAngles("hip_L", a);
  assert.deepEqual(a.slice(0, 2), [999, -999]);
  assert.deepEqual(r.angles, [135, -30, 0]);
  assert.deepEqual(r.clamped, [true, true, true]);
});
test("expandSides: explicit side overrides _LR regardless of key order, returns fresh arrays", () => {
  const e = expandSides({ hip_L: [5], hip_LR: [10, 1] });
  assert.deepEqual(e.hip_L, [5, 0, 0]);
  assert.deepEqual(e.hip_R, [10, 1, 0]);
  const src = [1, 2, 3];
  const f = expandSides({ hip_LR: src });
  f.hip_L[0] = 99;
  assert.equal(f.hip_R[0], 1);
  assert.equal(src[0], 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Root orientation
test("rootQuaternion: heading is a world yaw applied after the pelvis swing-twist (Ry * swing * twist)", () => {
  const r = { heading: 70, flex: 30, lat: 20, rot: 15 };
  const want = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 70 * D2R).multiply(refQuat("pelvis", [30, 20, 15]));
  assert.ok(sameRot(rootQuaternion(r), want, 1e-13));
  // + heading turns the face (+Z) toward +X (the figure's left)
  const f = V(0, 0, 1).applyQuaternion(rootQuaternion({ heading: 10 }));
  assert.ok(f.x > 0);
  // flex 90 = lying prone: the face (+Z) points down, the head (+Y) points forward
  const q = rootQuaternion({ flex: 90 });
  assert.ok(V(0, 1, 0).applyQuaternion(q).distanceTo(V(0, 0, 1)) < 1e-12);
  assert.ok(V(0, 0, 1).applyQuaternion(q).distanceTo(V(0, -1, 0)) < 1e-12);
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. Performance and allocation
test("FIXED: Kinematics.solve with strict=false does not allocate for a full pose with fractional angles", () => {
  // fk.js documents solve() as allocation free; `a[0] ?? 0` in writeJointQuaternion boxes every double read from an angles array.
  // (the author's own test only has 4 non-empty joints, which hides it.)
  const k = new Kinematics(sampleOffsets());
  k.strict = false;
  const ang = {};
  for (const j of JOINTS) ang[j.id] = j.dof.map((_, i) => 10.37 + 0.41 * i);
  const root = { x: 0, y: 1, z: 0, heading: 20.5, flex: 5.5, lat: 3.1, rot: 2.2 };
  for (let i = 0; i < 30000; i++) k.solve(ang, root);
  const used = () => v8.getHeapStatistics().used_heap_size;
  let worst = 0, prev = used();
  for (let r = 0; r < 6; r++) {
    for (let i = 0; i < 1000; i++) k.solve(ang, root);
    const u = used(); worst = Math.max(worst, u - prev); prev = u;
  }
  assert.ok(worst < 128 * 1024, `heap grew by up to ${(worst / 1024).toFixed(0)} KB per 1000 solves (about ${(worst / 1000).toFixed(0)} bytes per solve)`);
});
test("Kinematics.solve is fast (strict=false)", () => {
  const k = new Kinematics(sampleOffsets());
  k.strict = false;
  const ang = {};
  for (const j of JOINTS) ang[j.id] = j.dof.map(() => 10);
  for (let i = 0; i < 20000; i++) k.solve(ang, { y: 1 });
  const N = 50000, t0 = performance.now();
  for (let i = 0; i < N; i++) k.solve(ang, { y: 1 });
  const dt = performance.now() - t0;
  assert.ok(dt / N < 0.05, `${(dt / N * 1000).toFixed(1)} us per solve`);
});
test("eyes: posture azim + looks toward the figure's left for both eyes (expandSides converts); joint-level azim is lateral-positive", () => {
  const e = expandSides({ eye_LR: [0, 10] });
  for (const id of ["eye_L", "eye_R"]) {
    const g = V(0, 0, 1).applyQuaternion(jointQuaternion(id, e[id]));
    assert.ok(g.x > 0.1, `${id} posture azim +10 looks toward x=${g.x.toFixed(3)}`);
  }
  assert.ok(V(0, 0, 1).applyQuaternion(jointQuaternion("eye_R", [0, 10])).x < 0, "joint-level eye_R azim + is lateral (to the right)");
});
test("Kinematics.solve default (strict) mode: per-call time stays small even with a dictionary-mode angles object", () => {
  const k = new Kinematics(sampleOffsets());
  const ang = {};
  for (const j of JOINTS) ang[j.id] = j.dof.map(() => 10);
  const N = 20000, t0 = performance.now();
  for (let i = 0; i < N; i++) k.solve(ang, { y: 1 });
  const dt = performance.now() - t0;
  assert.ok(dt / N < 0.2, `${(dt / N * 1000).toFixed(1)} us per strict solve`);
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. Literature spot checks (healthy active ROM; wide tolerance, only clearly wrong values fail)
test("ranges of motion are within the plausible literature envelope", () => {
  const rom = (id, key) => { const j = JOINT_BY_ID[id], d = j.dof.find((x) => x.key === key); return [d.min, d.max]; };
  const within = (id, key, lo, hi) => {
    const [mn, mx] = rom(id, key);
    assert.ok(mx >= lo[1] && mx <= hi[1] && -mn >= lo[0] && -mn <= hi[0], `${id}.${key} [${mn}, ${mx}] outside plausible [-${hi[0]}..-${lo[0]}, ${lo[1]}..${hi[1]}]`);
  };
  // [min |neg| , min pos], [max |neg|, max pos]
  within("elbow_L", "flex", [0, 140], [10, 160]);
  within("knee_L", "flex", [0, 130], [10, 165]);
  within("hip_L", "flex", [15, 115], [35, 140]);
  within("ankle_L", "dorsi", [40, 18], [65, 40]);
  within("wrist_L", "flex", [60, 70], [90, 95]);
  within("shoulder_L", "flex", [40, 160], [70, 190]);
  within("forearm_L", "pron", [70, 70], [95, 95]);
  within("mtp_L", "dorsi", [30, 60], [60, 95]);
  within("jaw", "open", [0, 25], [10, 45]);
  within("index_mcp_L", "flex", [0, 80], [45, 100]);
  within("index_pip_L", "flex", [0, 100], [5, 120]);
  within("index_dip_L", "flex", [0, 70], [20, 95]);
  const tot = (r, c, i) => REGIONS[r].range[c][i];
  assert.ok(tot("lumbar", "flex", 1) >= 40 && tot("lumbar", "flex", 1) <= 70);
  assert.ok(-tot("cervical", "flex", 0) + -JOINT_BY_ID.head.dof[0].min >= 55 && -tot("cervical", "flex", 0) - JOINT_BY_ID.head.dof[0].min <= 100, "neck extension");
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. Second pass
test("the author's probe / moves data is itself right: moves equals the independently derived direction table", () => {
  for (const [id, di, probe, dir] of ROWS) {
    const d = JOINT_BY_ID[id].dof[di];
    if (id.startsWith("thumb_cmc") && di === 1) continue; // covered by the palmar abduction test
    const want = V(...dir()).normalize(), got = V(...d.moves).normalize();
    assert.ok(want.dot(got) > 0.99, `${id}.${d.key}: moves ${d.moves} vs ${want.toArray()}`);
    assert.ok(V(...probe()).normalize().dot(V(...d.probe).normalize()) > 0.99, `${id}.${d.key}: probe ${d.probe}`);
  }
});
test("inverse of uniformly random rotations reproduces the rotation for every 3-DOF joint", () => {
  const randQ = () => {
    const u1 = rnd(), u2 = rnd(), u3 = rnd();
    return new THREE.Quaternion(Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3));
  };
  for (const j of JOINTS) if (j.dof.length === 3) for (let n = 0; n < 300; n++) {
    const q = randQ(), back = anglesFromQuaternion(j.id, q);
    assert.ok(back.every(Number.isFinite));
    assert.ok(sameRot(jointQuaternion(j.id, back), q, 1e-12), j.id);
  }
});
test("inverse within 0.5 deg of the 180 deg swing singularity: finite and the rotation round-trips, for random twist", () => {
  for (const id of ["shoulder_L", "hip_R", "L3", "pelvis", "ankle_L"]) {
    const j = JOINT_BY_ID[id];
    for (let n = 0; n < 500; n++) {
      const th = rnd() * 2 * Math.PI, mag = 179.5 + rnd() * 0.5;
      let c = 0;
      const a = j.dof.map((d) => (d.role === "twist" ? (rnd() * 2 - 1) * 170 : mag * (c++ === 0 ? Math.cos(th) : Math.sin(th))));
      const q = jointQuaternion(id, a), back = anglesFromQuaternion(id, q);
      assert.ok(back.every(Number.isFinite) && sameRot(jointQuaternion(id, back), q, 1e-12), `${id} ${a}`);
    }
  }
});
test("combined positive swings keep both anatomical components (hip / shoulder, both sides)", () => {
  for (const [id, s] of [["shoulder_L", 1], ["shoulder_R", -1], ["hip_L", 1], ["hip_R", -1]]) {
    const p = V(0, -1, 0).applyQuaternion(jointQuaternion(id, [60, 60, 0]));
    assert.ok(p.z > 0.3 && p.x * s > 0.3, `${id} flex 60 + abd 60 -> ${p.toArray()}`);
  }
});
test("FIXED: rootQuaternion validates like Kinematics.solve (NaN root must not return a NaN quaternion)", () => {
  let threw = false, q;
  try { q = rootQuaternion({ flex: NaN }); } catch { threw = true; }
  assert.ok(threw || [q.x, q.y, q.z, q.w].every(Number.isFinite));
});
test("FIXED: Kinematics.solve treats an undefined entry as 0 like jointQuaternion / expandSides do", () => {
  const o = {};
  for (const j of JOINTS) o[j.id] = [0, 0.1, 0];
  const k = new Kinematics(o);
  jointQuaternion("hip_L", [undefined, 5]);
  k.solve({ hip_L: [undefined, 5] }, {});
});
test("FIXED: a failed Kinematics.setOffsets leaves the previous offsets intact", () => {
  const o = {}, o2 = {};
  for (const j of JOINTS) { o[j.id] = [0, 0.1, 0]; o2[j.id] = [1, 1, 1]; }
  const k = new Kinematics(o), before = Array.from(k.offsets);
  delete o2.mtp_R;
  assert.throws(() => k.setOffsets(o2));
  assert.deepEqual(Array.from(k.offsets), before);
});
test("FIXED: expandRegions rejects inherited Object.prototype names as region keys", () => {
  assert.throws(() => expandRegions({ constructor: [1] }));
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. Third pass (open findings: marked todo until the author fixes them)
test("DEFECT: an in-range shoulder angle pair (flex 150, abd 150) must not produce an arm pointing backward-medially, nor pass clampAngles unchanged", { todo: "ROM box allows swing vector length 212 > 180; exp map wraps" }, () => {
  const r = clampAngles("shoulder_L", [150, 150, 0]);
  const unchanged = r.angles[0] === 150 && r.angles[1] === 150;
  const arm = V(0, -1, 0).applyQuaternion(jointQuaternion("shoulder_L", r.angles));
  // both positive swings are forward and lateral components of the same raised arm: z and x must not both be negative
  assert.ok(!(unchanged && arm.z < 0 && arm.x < 0), `shoulder [150,150] -> arm ${arm.toArray().map((v) => v.toFixed(2))}`);
  assert.ok(swingLength("shoulder_L", r.angles) <= 180 + 1e-9, `clamped swing length ${swingLength("shoulder_L", r.angles).toFixed(0)}`);
});
test("DEFECT: expandSides treats undefined entries as 0, as skeleton.js checkedAngles' comment claims", { todo: "expandSides throws 'value 0 is not a finite number'" }, () => {
  assert.deepEqual(expandSides({ hip_L: [undefined, 5] }).hip_L, [0, 5, 0]);
});
test("DEFECT: a throwing Kinematics.solve leaves positions / quaternions untouched (atomic)", { todo: "solve writes root and early joints before validating the later ones" }, () => {
  const o = {};
  for (const j of JOINTS) o[j.id] = [0, 0.1, 0];
  const k = new Kinematics(o);
  k.solve({ hip_L: [30, 0, 0] }, { y: 1 });
  const P = Array.from(k.positions), Q = Array.from(k.quaternions);
  assert.throws(() => k.solve({ hip_L: [10, 0, 0], mtp_R: [NaN] }, { y: 2 }));
  assert.deepEqual(Array.from(k.positions), P);
  assert.deepEqual(Array.from(k.quaternions), Q);
});
