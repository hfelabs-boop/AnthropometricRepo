import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import * as S from "../../site/js/human/skeleton.js";

const { JOINTS, JOINT_BY_ID, REGIONS, BONES } = S;
const D2R = Math.PI / 180;

// ---- helpers ---------------------------------------------------------------------------------------------------------
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const vnear = (a, b, eps = 1e-9, msg = "") => a.forEach((x, i) => near(x, b[i], eps, `${msg} [${i}]`));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(...a);
const unit = (a) => a.map((x) => x / len(a));
/** Rotate vector v by joint `id` at `angles` (degrees, DOF order). */
const rot = (id, angles, v) => new THREE.Vector3(...v).applyQuaternion(S.jointQuaternion(id, angles)).toArray();
/** Independent reference: Rodrigues rotation of v about unit axis k by deg degrees. */
function rodrigues(v, k, deg) {
  const t = deg * D2R, c = Math.cos(t), s = Math.sin(t), kv = cross(k, v), kd = dot(k, v);
  return v.map((x, i) => x * c + kv[i] * s + k[i] * kd * (1 - c));
}
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
const FINGERS = ["index", "middle", "ring", "little"];
const side = (s) => [
  `clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `forearm_${s}`, `wrist_${s}`,
  `thumb_cmc_${s}`, `thumb_mcp_${s}`, `thumb_ip_${s}`,
  ...FINGERS.flatMap((f) => [`${f}_mcp_${s}`, `${f}_pip_${s}`, `${f}_dip_${s}`]),
];

// ---- the table -------------------------------------------------------------------------------------------------------
const EXPECTED_IDS = [
  "pelvis",
  "L5", "L4", "L3", "L2", "L1",
  "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1",
  "C7", "C6", "C5", "C4", "C3", "C2", "C1",
  "head", "jaw", "eye_L", "eye_R",
  "clavicle_L", "shoulder_L", "elbow_L", "forearm_L", "wrist_L",
  "thumb_cmc_L", "thumb_mcp_L", "thumb_ip_L",
  "index_mcp_L", "index_pip_L", "index_dip_L", "middle_mcp_L", "middle_pip_L", "middle_dip_L",
  "ring_mcp_L", "ring_pip_L", "ring_dip_L", "little_mcp_L", "little_pip_L", "little_dip_L",
  "clavicle_R", "shoulder_R", "elbow_R", "forearm_R", "wrist_R",
  "thumb_cmc_R", "thumb_mcp_R", "thumb_ip_R",
  "index_mcp_R", "index_pip_R", "index_dip_R", "middle_mcp_R", "middle_pip_R", "middle_dip_R",
  "ring_mcp_R", "ring_pip_R", "ring_dip_R", "little_mcp_R", "little_pip_R", "little_dip_R",
  "hip_L", "knee_L", "ankle_L", "mtp_L",
  "hip_R", "knee_R", "ankle_R", "mtp_R",
];

test("77 joints, exactly the DESIGN.md table, parents before children", () => {
  assert.equal(JOINTS.length, 77);
  assert.deepEqual(JOINTS.map((j) => j.id), EXPECTED_IDS);
  assert.equal(new Set(EXPECTED_IDS).size, 77);
  assert.equal(S.ROOT, "pelvis");
  assert.equal(JOINTS[0].id, "pelvis");
  assert.equal(JOINTS[0].parent, null);
  const seen = new Set();
  for (const j of JOINTS) {
    if (j.id !== "pelvis") assert.ok(seen.has(j.parent), `${j.id}: parent ${j.parent} must come first`);
    seen.add(j.id);
    assert.equal(JOINT_BY_ID[j.id], j);
  }
  assert.equal(JOINTS.filter((j) => j.parent === null).length, 1);
  assert.equal(Object.keys(JOINT_BY_ID).length, 77);
});

test("parents follow DESIGN.md 1.4", () => {
  const P = (id) => JOINT_BY_ID[id].parent;
  assert.equal(P("L5"), "pelvis");
  assert.equal(P("L4"), "L5");
  assert.equal(P("T12"), "L1");
  assert.equal(P("T11"), "T12");
  assert.equal(P("C7"), "T1");
  assert.equal(P("C1"), "C2");
  assert.equal(P("head"), "C1");
  for (const id of ["jaw", "eye_L", "eye_R"]) assert.equal(P(id), "head");
  for (const s of ["L", "R"]) {
    assert.equal(P(`clavicle_${s}`), "T4");
    assert.equal(P(`shoulder_${s}`), `clavicle_${s}`);
    assert.equal(P(`elbow_${s}`), `shoulder_${s}`);
    assert.equal(P(`forearm_${s}`), `elbow_${s}`);
    assert.equal(P(`wrist_${s}`), `forearm_${s}`);
    assert.equal(P(`thumb_cmc_${s}`), `wrist_${s}`);
    assert.equal(P(`thumb_mcp_${s}`), `thumb_cmc_${s}`);
    assert.equal(P(`thumb_ip_${s}`), `thumb_mcp_${s}`);
    for (const f of FINGERS) {
      assert.equal(P(`${f}_mcp_${s}`), `wrist_${s}`);
      assert.equal(P(`${f}_pip_${s}`), `${f}_mcp_${s}`);
      assert.equal(P(`${f}_dip_${s}`), `${f}_pip_${s}`);
    }
    assert.equal(P(`hip_${s}`), "pelvis");
    assert.equal(P(`knee_${s}`), `hip_${s}`);
    assert.equal(P(`ankle_${s}`), `knee_${s}`);
    assert.equal(P(`mtp_${s}`), `ankle_${s}`);
  }
  assert.deepEqual([...S.CHILDREN.T4].sort(), ["T3", "clavicle_L", "clavicle_R"].sort());
});

test("DOF keys per joint class", () => {
  const keys = (id) => S.dofKeys(id);
  assert.deepEqual(keys("pelvis"), ["flex", "lat", "rot"]);
  for (const id of ["L5", "L1", "T12", "T1", "C7", "C1", "head"]) assert.deepEqual(keys(id), ["flex", "lat", "rot"], id);
  assert.deepEqual(keys("jaw"), ["open"]);
  for (const s of ["L", "R"]) {
    assert.deepEqual(keys(`eye_${s}`), ["elev", "azim"]);
    assert.deepEqual(keys(`clavicle_${s}`), ["elev", "prot"]);
    assert.deepEqual(keys(`shoulder_${s}`), ["flex", "abd", "rot"]);
    assert.deepEqual(keys(`elbow_${s}`), ["flex"]);
    assert.deepEqual(keys(`forearm_${s}`), ["pron"]);
    assert.deepEqual(keys(`wrist_${s}`), ["flex", "dev"]);
    assert.deepEqual(keys(`thumb_cmc_${s}`), ["flex", "abd"]);
    assert.deepEqual(keys(`thumb_mcp_${s}`), ["flex"]);
    assert.deepEqual(keys(`thumb_ip_${s}`), ["flex"]);
    for (const f of FINGERS) {
      assert.deepEqual(keys(`${f}_mcp_${s}`), ["flex", "abd"]);
      assert.deepEqual(keys(`${f}_pip_${s}`), ["flex"]);
      assert.deepEqual(keys(`${f}_dip_${s}`), ["flex"]);
    }
    assert.deepEqual(keys(`hip_${s}`), ["flex", "abd", "rot"]);
    assert.deepEqual(keys(`knee_${s}`), ["flex", "rot"]);
    assert.deepEqual(keys(`ankle_${s}`), ["dorsi", "inv", "rot"]);
    assert.deepEqual(keys(`mtp_${s}`), ["dorsi"]);
  }
  assert.equal(JOINTS.reduce((n, j) => n + j.dof.length, 0), 159);
  assert.throws(() => S.dofKeys("nope"), /nope/);
});

test("groups, sides and labels are filled in", () => {
  const groups = new Set(S.GROUPS.map((g) => g.id));
  for (const j of JOINTS) {
    assert.ok(groups.has(j.group), `${j.id}: group ${j.group}`);
    assert.ok(j.label && !j.label.includes("undefined"), j.id);
    assert.equal(j.side, S.sideOf(j.id), j.id);
    assert.equal(j.probe.length, 3);
    near(len(j.probe), 1, 1e-12, `${j.id} probe`);
    for (const d of j.dof) {
      assert.ok(d.label && d.pos && d.neg && d.src, `${j.id}.${d.key} has label / pos / neg / src`);
      assert.ok(["swing1", "swing2", "twist"].includes(d.role));
    }
  }
  assert.deepEqual([...groups].sort(), [...new Set(JOINTS.map((j) => j.group))].sort());
});

// ---- mirror ---------------------------------------------------------------------------------------------------------
test("mirrorId / sideOf", () => {
  assert.equal(S.mirrorId("hip_L"), "hip_R");
  assert.equal(S.mirrorId("hip_R"), "hip_L");
  assert.equal(S.mirrorId("thumb_cmc_L"), "thumb_cmc_R");
  for (const id of ["pelvis", "L5", "T12", "C1", "head", "jaw", "hip_LR"]) assert.equal(S.mirrorId(id), id);
  assert.equal(S.sideOf("knee_L"), "L");
  assert.equal(S.sideOf("knee_R"), "R");
  for (const id of ["pelvis", "head", "L5", "hip_LR"]) assert.equal(S.sideOf(id), null);
  for (const j of JOINTS) assert.equal(S.mirrorId(S.mirrorId(j.id)), j.id);
});

test("every left joint has a right twin with reflected axes and identical ranges", () => {
  const lefts = JOINTS.filter((j) => j.side === "L");
  assert.equal(lefts.length, 1 /* eye */ + 20 + 4);
  assert.equal(JOINTS.filter((j) => j.side === "R").length, lefts.length);
  for (const L of lefts) {
    const R = JOINT_BY_ID[S.mirrorId(L.id)];
    assert.ok(R, L.id);
    assert.equal(R.mirrorOf, L.id);
    assert.equal(L.mirrorOf, undefined);
    assert.equal(R.side, "R");
    assert.equal(R.parent, S.mirrorId(L.parent));
    assert.equal(R.group, L.group);
    assert.equal(R.label, L.label.replace(/^Left/, "Right"));
    vnear(R.probe, [-L.probe[0], L.probe[1], L.probe[2]], 0, `${R.id} probe`);
    assert.equal(R.dof.length, L.dof.length);
    L.dof.forEach((d, i) => {
      const e = R.dof[i];
      assert.equal(e.key, d.key);
      assert.equal(e.role, d.role);
      assert.equal(e.min, d.min);
      assert.equal(e.max, d.max);
      vnear(e.axis, [d.axis[0], -d.axis[1], -d.axis[2]], 0, `${R.id}.${d.key} axis (pseudovector)`);
      vnear(e.probe, [-d.probe[0], d.probe[1], d.probe[2]], 0, `${R.id}.${d.key} probe`);
      vnear(e.moves, [-d.moves[0], d.moves[1], d.moves[2]], 0, `${R.id}.${d.key} moves`);
    });
  }
});

test("mirrored joints are mirror images: reflecting x maps a left pose onto the right one", () => {
  // The same angles on _L and _R must give mirror-image rotations: R_right = M R_left M with M = diag(-1,1,1).
  const r = rng(7);
  const M = (v) => [-v[0], v[1], v[2]];
  for (const L of JOINTS.filter((j) => j.side === "L")) {
    const ang = L.dof.map((d) => d.min + (d.max - d.min) * r());
    const R = S.mirrorId(L.id);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.5, 0.8]]) {
      vnear(rot(R, ang, v), M(rot(L.id, ang, M(v))), 1e-12, `${L.id} mirror`);
    }
  }
});

// ---- axes ------------------------------------------------------------------------------------------------------------
test("axes are unit, mutually perpendicular within a joint, roles are consistent", () => {
  for (const j of JOINTS) {
    j.dof.forEach((d, i) => {
      near(len(d.axis), 1, 1e-12, `${j.id}.${d.key}`);
      j.dof.slice(i + 1).forEach((e) => near(dot(d.axis, e.axis), 0, 1e-12, `${j.id}: ${d.key} . ${e.key}`));
    });
    const roles = j.dof.map((d) => d.role);
    assert.ok(roles.filter((r) => r === "twist").length <= 1, `${j.id}: at most one twist`);
    assert.ok(roles.filter((r) => r === "swing1").length <= 1 && roles.filter((r) => r === "swing2").length <= 1, j.id);
    if (roles.includes("swing2")) assert.ok(roles.includes("swing1"), `${j.id}: swing2 needs swing1`);
  }
});

// ---- probe / moves: the sign of every DOF -----------------------------------------------------------------------------
test("every DOF: a small positive angle moves its probe in the stated direction", () => {
  for (const j of JOINTS) {
    j.dof.forEach((d, i) => {
      const tag = `${j.id}.${d.key}`;
      near(len(d.probe), 1, 1e-12, `${tag} probe`);
      near(len(d.moves), 1, 1e-12, `${tag} moves`);
      near(dot(d.probe, d.axis), 0, 1e-12, `${tag}: probe is perpendicular to its axis`);
      const t = unit(cross(d.axis, d.probe)); // tangent of a positive rotation about the axis
      vnear(d.moves, t, 1e-9, `${tag}: moves is the tangent axis x probe`);
      if (d.role === "twist") near(dot(d.probe, j.probe), 0, 1e-12, `${tag}: twist probe is off the bone axis`);
      else vnear(d.probe, j.probe, 1e-12, `${tag}: swing probe is the bone direction`);
      for (const sign of [1, -1]) {
        const a = j.dof.map(() => 0);
        a[i] = 5 * sign;
        const p = rot(j.id, a, d.probe);
        const v = p.map((x, k) => x - d.probe[k]);
        assert.ok(sign * dot(v, d.moves) > 0, `${tag} (${sign * 5} deg) moves along ${sign > 0 ? "" : "-"}moves`);
        assert.ok(sign * dot(unit(v), d.moves) > 0.99, `${tag}: dominant direction`);
      }
    });
  }
});

// ---- hand-computed reference rotations ---------------------------------------------------------------------------------
test("jointQuaternion against hand-computed vectors", () => {
  const down = [0, -1, 0];
  const s30 = Math.sin(30 * D2R), c30 = Math.cos(30 * D2R), s20 = Math.sin(20 * D2R), c20 = Math.cos(20 * D2R);
  const s10 = Math.sin(10 * D2R), c10 = Math.cos(10 * D2R);
  for (const s of ["L", "R"]) {
    vnear(rot(`shoulder_${s}`, [90, 0, 0], down), [0, 0, 1], 1e-12, "shoulder flex 90 -> arm forward");
    vnear(rot(`shoulder_${s}`, [-45, 0, 0], down), [0, -Math.SQRT1_2, -Math.SQRT1_2], 1e-12, "shoulder extension");
    vnear(rot(`knee_${s}`, [90, 0], down), [0, 0, -1], 1e-12, "knee flex 90 -> shank points back");
    vnear(rot(`elbow_${s}`, [90], down), [0, 0, 1], 1e-12, "elbow flex 90 -> forearm forward");
    vnear(rot(`hip_${s}`, [90, 0, 0], down), [0, 0, 1], 1e-12, "hip flex 90 -> thigh forward");
    vnear(rot(`ankle_${s}`, [20, 0, 0], [0, 0, 1]), [0, s20, c20], 1e-12, "dorsiflexion lifts the toes");
    vnear(rot(`mtp_${s}`, [-30], [0, 0, 1]), [0, -0.5, Math.cos(30 * D2R)], 1e-12, "toe curl goes down");
    vnear(rot(`wrist_${s}`, [0, 20], down), [0, -c20, s20], 1e-12, "radial deviation swings the hand forward");
  }
  // abduction: away from the midline
  vnear(rot("hip_L", [0, 30, 0], down), [s30, -c30, 0], 1e-12, "left hip abd 30 -> +X");
  vnear(rot("hip_R", [0, 30, 0], down), [-s30, -c30, 0], 1e-12, "right hip abd 30 -> -X");
  vnear(rot("shoulder_L", [0, 90, 0], down), [1, 0, 0], 1e-12, "left arm abducted -> +X");
  vnear(rot("shoulder_R", [0, 90, 0], down), [-1, 0, 0], 1e-12, "right arm abducted -> -X");
  // internal rotation turns the front of the limb toward the midline
  vnear(rot("hip_L", [0, 0, 30], [0, 0, 1]), [-s30, 0, c30], 1e-12, "left hip internal rotation");
  vnear(rot("hip_R", [0, 0, 30], [0, 0, 1]), [s30, 0, c30], 1e-12, "right hip internal rotation");
  vnear(rot("forearm_L", [90], [0, 0, 1]), [-1, 0, 0], 1e-12, "pronation turns the thumb medially (left)");
  vnear(rot("forearm_R", [90], [0, 0, 1]), [1, 0, 0], 1e-12, "pronation turns the thumb medially (right)");
  // wrist: palmar flexion moves the hand toward the palm = medially
  vnear(rot("wrist_L", [90, 0], down), [-1, 0, 0], 1e-12, "left palmar flexion");
  vnear(rot("wrist_R", [90, 0], down), [1, 0, 0], 1e-12, "right palmar flexion");
  // ankle
  vnear(rot("ankle_L", [0, 0, 20], [0, 0, 1]), [-s20, 0, c20], 1e-12, "left toe-in");
  vnear(rot("ankle_R", [0, 0, 20], [0, 0, 1]), [s20, 0, c20], 1e-12, "right toe-in");
  vnear(rot("ankle_L", [0, 20, 0], down), [-s20, -c20, 0], 1e-12, "left inversion: sole turns medially");
  vnear(rot("ankle_R", [0, 20, 0], down), [s20, -c20, 0], 1e-12, "right inversion");
  // spine and head (+ = forward / figure's left)
  for (const id of ["L5", "T7", "C4", "head"]) {
    vnear(rot(id, [10, 0, 0], [0, 1, 0]), [0, c10, s10], 1e-12, `${id} flexion`);
    vnear(rot(id, [0, 10, 0], [0, 1, 0]), [s10, c10, 0], 1e-12, `${id} lateral bend to the left`);
    vnear(rot(id, [0, 0, 20], [0, 0, 1]), [s20, 0, c20], 1e-12, `${id} rotation to the left`);
  }
  // clavicle, jaw, eyes
  vnear(rot("clavicle_L", [20, 0], [1, 0, 0]), [c20, s20, 0], 1e-12, "left clavicle elevation");
  vnear(rot("clavicle_R", [20, 0], [-1, 0, 0]), [-c20, s20, 0], 1e-12, "right clavicle elevation");
  vnear(rot("clavicle_L", [0, 20], [1, 0, 0]), [c20, 0, s20], 1e-12, "left clavicle protraction");
  vnear(rot("clavicle_R", [0, 20], [-1, 0, 0]), [-c20, 0, s20], 1e-12, "right clavicle protraction");
  vnear(rot("jaw", [20], [0, -0.6, 0.8]), [0, -0.6 * c20 - 0.8 * s20, -0.6 * s20 + 0.8 * c20], 1e-12, "jaw opens: chin down and back");
  vnear(rot("eye_L", [20, 0], [0, 0, 1]), [0, s20, c20], 1e-12, "gaze up");
  vnear(rot("eye_L", [0, 20], [0, 0, 1]), [s20, 0, c20], 1e-12, "left eye lateral = toward the figure's left");
  vnear(rot("eye_R", [0, 20], [0, 0, 1]), [-s20, 0, c20], 1e-12, "right eye lateral = toward the figure's right");
  // fingers and thumb (left): palm faces -X, thumb forward (+Z)
  vnear(rot("index_pip_L", [90], down), [-1, 0, 0], 1e-12, "finger flexion toward the palm (-X)");
  vnear(rot("index_pip_R", [90], down), [1, 0, 0], 1e-12, "finger flexion toward the palm (+X on the right)");
  vnear(rot("index_mcp_L", [0, 20], down), [0, -c20, s20], 1e-12, "index abduction: toward the thumb side (+Z)");
  vnear(rot("little_mcp_L", [0, 20], down), [0, -c20, -s20], 1e-12, "little finger abduction: ulnar (-Z)");
  vnear(rot("thumb_cmc_L", [0, 40], down), [-Math.sin(40 * D2R), -Math.cos(40 * D2R), 0], 1e-12, "palmar abduction toward the side the palm faces (-X left), like finger flexion");
  vnear(rot("thumb_cmc_R", [0, 40], down), [Math.sin(40 * D2R), -Math.cos(40 * D2R), 0], 1e-12, "palmar abduction (right)");
  vnear(rot("thumb_ip_L", [30], down), [0, -Math.cos(30 * D2R), -0.5], 1e-12, "thumb flexion folds across the palm (-Z)");
});

test("hanging limbs fold the right way: knee 90 + hip 90 and shoulder 90 + elbow 90", () => {
  // chain rotation hip*knee on a vector along the shank
  const q = S.jointQuaternion("hip_L", [90, 0, 0]).multiply(S.jointQuaternion("knee_L", [90, 0]));
  vnear(new THREE.Vector3(0, -1, 0).applyQuaternion(q).toArray(), [0, -1, 0], 1e-12, "shank hangs down when the thigh is horizontal");
  const q2 = S.jointQuaternion("shoulder_L", [90, 0, 0]).multiply(S.jointQuaternion("elbow_L", [90]));
  vnear(new THREE.Vector3(0, -1, 0).applyQuaternion(q2).toArray(), [0, 1, 0], 1e-12, "forearm points up when the arm is forward and the elbow bent");
});

test("exponential-map swing: combined flexion + abduction rotates about the summed axis", () => {
  // shoulder_L: s = 90*(-X) + 90*(+Z); rotation about (-1,0,1)/sqrt2 by |s| = 127.279 degrees (computed with Rodrigues' formula)
  const k = unit([-1, 0, 1]), ang = Math.hypot(90, 90);
  const ref = rodrigues([0, -1, 0], k, ang);
  vnear(rot("shoulder_L", [90, 90, 0], [0, -1, 0]), ref, 1e-12, "swing vector");
  // a 3-DOF check with a non-trivial (non-axis-aligned) vector
  const v = [0.2, -0.9, 0.4];
  vnear(rot("shoulder_L", [40, -25, 0], v), rodrigues(v, unit([-40, 0, -25]), Math.hypot(40, 25)), 1e-12, "mixed signs");
  vnear(rot("hip_R", [40, 25, 0], v), rodrigues(v, unit([-40, 0, -25]), Math.hypot(40, 25)), 1e-12, "mirrored axis [0,0,-1] for abduction");
});

test("twist is applied first (innermost): q = exp(swing) * twist", () => {
  // front vector of the arm: twist (internal rotation 90 -> front goes medial) THEN swing (flex 90 leaves a vector along X unchanged)
  vnear(rot("shoulder_L", [90, 0, 90], [0, 0, 1]), [-1, 0, 0], 1e-12, "twist first");
  // the other order would give +Y
  const swingFirst = rodrigues(rodrigues([0, 0, 1], [-1, 0, 0], 90), [0, -1, 0], 90);
  vnear(swingFirst, [0, 1, 0], 1e-12, "reference for the wrong order");
  // quaternion identity
  const qs = S.jointQuaternion("shoulder_L", [70, 20, 0]), qt = S.jointQuaternion("shoulder_L", [0, 0, 55]);
  const q = S.jointQuaternion("shoulder_L", [70, 20, 55]);
  const prod = qs.clone().multiply(qt);
  assert.ok(Math.abs(Math.abs(q.dot(prod)) - 1) < 1e-12);
});

test("the twist never changes where the bone axis points", () => {
  const r = rng(11);
  for (const id of ["pelvis", "L3", "T5", "C4", "head", "shoulder_L", "shoulder_R", "hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R", "forearm_L"]) {
    const j = JOINT_BY_ID[id];
    const ti = j.dof.findIndex((d) => d.role === "twist");
    assert.ok(ti >= 0, id);
    const axis = j.dof[ti].axis;
    for (let n = 0; n < 20; n++) {
      const a = j.dof.map((d) => (d.role === "twist" ? 0 : (d.min + (d.max - d.min) * r()) * 0.5));
      const b = a.slice();
      b[ti] = (r() - 0.5) * 160;
      vnear(rot(id, a, axis), rot(id, b, axis), 1e-12, `${id} twist axis`);
      const q0 = S.jointQuaternion(id, a), qt = S.jointQuaternion(id, j.dof.map((d, i) => (i === ti ? b[ti] : 0)));
      assert.ok(Math.abs(Math.abs(S.jointQuaternion(id, b).dot(q0.clone().multiply(qt))) - 1) < 1e-12, `${id} = swing * twist`);
    }
  }
});

test("writeJointQuaternion agrees with jointQuaternion and is unit length", () => {
  const r = rng(3), out = new Float64Array(8);
  for (const j of JOINTS) {
    for (let n = 0; n < 5; n++) {
      const a = [0, 0, 0].map((_, i) => (j.dof[i] ? j.dof[i].min + (j.dof[i].max - j.dof[i].min) * r() : 0));
      S.writeJointQuaternion(j, a, out, 4);
      const q = S.jointQuaternion(j.id, a);
      vnear([q.x, q.y, q.z, q.w], [out[4], out[5], out[6], out[7]], 1e-15, j.id);
      near(Math.hypot(out[4], out[5], out[6], out[7]), 1, 1e-12, `${j.id} unit`);
    }
  }
  // missing angles are 0, extra entries are ignored by joints with fewer DOF
  assert.deepEqual(S.jointQuaternion("elbow_L", []).toArray(), [0, 0, 0, 1]);
  assert.deepEqual(S.jointQuaternion("elbow_L").toArray(), [0, 0, 0, 1]);
  vnear(S.jointQuaternion("elbow_L", [30, 0, 0]).toArray(), S.jointQuaternion("elbow_L", [30]).toArray(), 1e-15);
  // regression (verifier): extras and non-finite values are rejected exactly as Kinematics.solve does, not silently ignored
  assert.throws(() => S.jointQuaternion("elbow_L", [30, 99, 99]), RangeError);
  assert.throws(() => S.jointQuaternion("knee_L", [10, NaN]), RangeError);
  assert.throws(() => S.jointQuaternion("knee_L", [Infinity]), RangeError);
  assert.throws(() => S.jointQuaternion("knee_L", 5), TypeError);
  vnear(S.jointQuaternion("knee_L", [undefined, 20]).toArray(), S.jointQuaternion("knee_L", [0, 20]).toArray(), 1e-15, "holes are 0");
  assert.throws(() => S.jointQuaternion("nope", [1]), /nope/);
});

// ---- inverse ---------------------------------------------------------------------------------------------------------
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

test("anglesFromQuaternion round-trips a dense grid of in-range angles", () => {
  let n = 0;
  for (const j of JOINTS) {
    const grid = j.dof.map((d) => [d.min, 0.5 * d.min, 0.2 * d.min, 0, 0.2 * d.max, 0.5 * d.max, d.max]);
    const idx = grid.map(() => 0);
    for (;;) {
      const a = idx.map((k, i) => grid[i][k]);
      // skip combinations at the documented 180-degree singularity (swing vector) and the +-180 twist wrap
      const sing = S.swingLength(j.id, a) >= 179.5 || j.dof.some((d, i) => d.role === "twist" && Math.abs(a[i]) >= 179.5);
      if (!sing) {
        const q = S.jointQuaternion(j.id, a);
        const b = S.anglesFromQuaternion(j.id, q);
        assert.equal(b.length, j.dof.length);
        a.forEach((x, i) => assert.ok(Math.abs(wrap(x - b[i])) < 1e-6, `${j.id}.${j.dof[i].key}: ${x} -> ${b[i]} (grid ${a})`));
        n++;
      }
      let i = idx.length - 1;
      while (i >= 0 && ++idx[i] === grid[i].length) idx[i--] = 0;
      if (i < 0) break;
    }
  }
  assert.ok(n > 5000, `grid size ${n}`);
});

test("anglesFromQuaternion: every rotation of a full 3-DOF joint comes back (random quaternions)", () => {
  const r = rng(99), q = new THREE.Quaternion();
  for (const id of ["pelvis", "L4", "head", "shoulder_L", "shoulder_R", "hip_L", "hip_R", "ankle_L", "ankle_R"]) {
    for (let n = 0; n < 200; n++) {
      q.set(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const a = S.anglesFromQuaternion(id, q);
      const back = S.jointQuaternion(id, a);
      assert.ok(Math.abs(Math.abs(back.dot(q)) - 1) < 1e-12, `${id} quaternion round trip`);
      assert.ok(S.swingLength(id, a) <= 180 + 1e-9, `${id} principal solution has swing <= 180`);
    }
  }
  // accepts a plain {x,y,z,w} and un-normalised input, writes into `out`
  const out = [];
  const res = S.anglesFromQuaternion("elbow_L", { x: -0.5, y: 0, z: 0, w: 0.5 * Math.sqrt(3) * 2 }, out);
  assert.equal(res, out);
});

test("anglesFromQuaternion near and at the 180-degree swing limit", () => {
  // just below the limit the twist is still recovered
  let a = [179, 0, 30];
  let b = S.anglesFromQuaternion("shoulder_L", S.jointQuaternion("shoulder_L", a));
  a.forEach((x, i) => near(x, b[i], 1e-5, `179 deg: ${i}`));
  // exactly at the limit with no twist: exact
  a = [180, 0, 0];
  b = S.anglesFromQuaternion("shoulder_L", S.jointQuaternion("shoulder_L", a));
  a.forEach((x, i) => near(x, b[i], 1e-6, `180 deg, no twist: ${i}`));
  // exactly at the limit with a twist: the angles are not unique (documented), but the rotation is preserved
  const q = S.jointQuaternion("shoulder_L", [180, 0, 30]);
  b = S.anglesFromQuaternion("shoulder_L", q);
  assert.ok(Math.abs(Math.abs(S.jointQuaternion("shoulder_L", b).dot(q)) - 1) < 1e-9, "same rotation");
  near(b[2], 0, 1e-9, "twist is folded into the swing direction");
  // a swing vector longer than 180 wraps to the equivalent shorter one
  b = S.anglesFromQuaternion("shoulder_L", S.jointQuaternion("shoulder_L", [170, 60, 0]));
  assert.ok(S.swingLength("shoulder_L", [170, 60, 0]) > 180);
  assert.ok(S.swingLength("shoulder_L", b) < 180);
  assert.ok(Math.abs(Math.abs(S.jointQuaternion("shoulder_L", b).dot(S.jointQuaternion("shoulder_L", [170, 60, 0]))) - 1) < 1e-12);
  // identity, sign of q does not matter
  const id = S.anglesFromQuaternion("hip_R", new THREE.Quaternion(0, 0, 0, -1));
  assert.deepEqual(id, [0, 0, 0]);
  assert.ok(id.every((x) => !Object.is(x, -0)));
  near(S.swingLength("hip_L", [30, 40, 99]), 50, 1e-12);
});

test("hinge joints keep only the motion they can represent", () => {
  // a rotation about the elbow axis plus junk about another axis: only the elbow component is returned
  const q = S.jointQuaternion("elbow_L", [60]);
  near(S.anglesFromQuaternion("elbow_L", q)[0], 60, 1e-9);
  const withTwist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3).multiply(q);
  const b = S.anglesFromQuaternion("elbow_L", withTwist);
  assert.equal(b.length, 1);
  // forearm is a pure twist: pronation -80 comes back
  near(S.anglesFromQuaternion("forearm_R", S.jointQuaternion("forearm_R", [-80]))[0], -80, 1e-9);
  near(S.anglesFromQuaternion("jaw", S.jointQuaternion("jaw", [-3]))[0], -3, 1e-9);
});

// ---- clamp ----------------------------------------------------------------------------------------------------------
test("clampAngles", () => {
  const e = JOINT_BY_ID.elbow_L.dof[0];
  let r = S.clampAngles("elbow_L", [999]);
  assert.deepEqual(r, { angles: [e.max], clamped: [true] });
  r = S.clampAngles("elbow_L", [-999]);
  assert.deepEqual(r, { angles: [e.min], clamped: [true] });
  r = S.clampAngles("elbow_L", [45]);
  assert.deepEqual(r, { angles: [45], clamped: [false] });
  r = S.clampAngles("hip_L", [200, 0]);
  assert.equal(r.angles.length, 3);
  assert.deepEqual(r.clamped, [true, false, false]);
  assert.equal(r.angles[0], JOINT_BY_ID.hip_L.dof[0].max);
  assert.deepEqual(S.clampAngles("knee_R", undefined), { angles: [0, 0], clamped: [false, false] });
  assert.deepEqual(S.clampAngles("elbow_L", [NaN]).angles, [0]);
  assert.deepEqual(S.clampAngles("elbow_L", [Infinity]), { angles: [0], clamped: [true] });
  assert.deepEqual(S.clampAngles("elbow_L", [20, 500, 500]), { angles: [20], clamped: [false] });
  assert.throws(() => S.clampAngles("nope", []), /nope/);
});

test("neutralAngles has one zero per DOF for all 77 joints", () => {
  const n = S.neutralAngles();
  assert.equal(Object.keys(n).length, 77);
  for (const j of JOINTS) assert.deepEqual(n[j.id], j.dof.map(() => 0));
  n.hip_L[0] = 5;
  assert.deepEqual(S.neutralAngles().hip_L, [0, 0, 0], "fresh object every call");
});

// ---- ranges ---------------------------------------------------------------------------------------------------------
test("ranges are sane: min <= 0 <= max for every DOF", () => {
  for (const j of JOINTS) for (const d of j.dof) {
    assert.ok(Number.isFinite(d.min) && Number.isFinite(d.max), `${j.id}.${d.key}`);
    assert.ok(d.min <= 0 && 0 <= d.max, `${j.id}.${d.key} [${d.min}, ${d.max}] must contain the neutral pose`);
    assert.ok(d.max - d.min > 0.5, `${j.id}.${d.key} has a non-trivial range`);
    assert.ok(d.min >= -180 && d.max <= 180, `${j.id}.${d.key} within +-180`);
  }
});

test("ranges are wide enough for the posture library", () => {
  const r = (id, key) => JOINT_BY_ID[id].dof.find((d) => d.key === key);
  for (const s of ["L", "R"]) {
    assert.ok(r(`hip_${s}`, "flex").max >= 130, "deep squat hip flexion 125-135");
    assert.ok(r(`knee_${s}`, "flex").max >= 155, "deep squat 140-155, kneeling on the heels 150-160");
    assert.ok(r(`ankle_${s}`, "dorsi").max >= 30, "flat-foot squat dorsiflexion 30-35");
    assert.ok(r(`ankle_${s}`, "dorsi").min <= -50, "sitting on the heels plantarflexion 50-60");
    assert.ok(r(`hip_${s}`, "abd").max >= 45 && r(`hip_${s}`, "rot").min <= -45, "cross-legged: abduction 45, external rotation 45");
    assert.ok(r(`hip_${s}`, "flex").max >= 110, "cross-legged flexion 110");
    assert.ok(r(`shoulder_${s}`, "flex").max >= 170 && r(`shoulder_${s}`, "abd").max >= 170, "arm overhead");
    assert.ok(r(`shoulder_${s}`, "rot").max >= 90, "hand behind the back: internal rotation 90");
    assert.ok(r(`shoulder_${s}`, "flex").min <= -45, "extension for hand behind the back");
    assert.ok(r(`elbow_${s}`, "flex").max >= 145);
    assert.ok(r(`forearm_${s}`, "pron").max >= 80 && r(`forearm_${s}`, "pron").min <= -80);
    assert.ok(r(`wrist_${s}`, "flex").max >= 75 && r(`wrist_${s}`, "flex").min <= -65);
    assert.ok(r(`mtp_${s}`, "dorsi").max >= 70, "kneeling on the toes / heel raise");
    assert.ok(r(`index_pip_${s}`, "flex").max >= 100 && r(`index_mcp_${s}`, "flex").max >= 90, "fist");
  }
  const total = (key) => (REGIONS.lumbar.range.flex[1] + REGIONS.thoracic.range.flex[1]) * (key === "flex" ? 1 : 0);
  assert.ok(total("flex") >= 100, "full forward bend: thoracic + lumbar flexion about 100");
  assert.ok(REGIONS.lumbar.range.flex[0] + REGIONS.thoracic.range.flex[0] <= -50, "trunk extension");
  const neckFlex = REGIONS.cervical.range.flex[1] + r("head", "flex").max;
  const neckExt = -(REGIONS.cervical.range.flex[0] + r("head", "flex").min);
  assert.ok(neckFlex >= 60 && neckExt >= 70, "neck flexion / extension");
  assert.ok(REGIONS.cervical.range.rot[1] + r("head", "rot").max >= 75, "looking over the shoulder");
  assert.ok(REGIONS.lumbar.range.rot[1] + REGIONS.thoracic.range.rot[1] >= 45, "trunk rotation");
  assert.ok(REGIONS.lumbar.range.lat[1] + REGIONS.thoracic.range.lat[1] >= 40, "trunk side bend");
  // root: lying down
  for (const k of ["flex", "lat", "rot"]) assert.ok(r("pelvis", k).min <= -90 && r("pelvis", k).max >= 90);
});

// ---- regions --------------------------------------------------------------------------------------------------------
test("regions: weights sum to 1 and per-level ranges add up to the region range", () => {
  assert.deepEqual(Object.keys(REGIONS), ["lumbar", "thoracic", "cervical"]);
  assert.deepEqual(REGIONS.lumbar.joints, ["L5", "L4", "L3", "L2", "L1"]);
  assert.deepEqual(REGIONS.thoracic.joints, ["T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1"]);
  assert.deepEqual(REGIONS.cervical.joints, ["C7", "C6", "C5", "C4", "C3", "C2", "C1"]);
  for (const [name, rg] of Object.entries(REGIONS)) {
    for (const w of [rg.weights, rg.weightsLat, rg.weightsRot]) {
      assert.equal(w.length, rg.joints.length);
      near(w.reduce((a, b) => a + b, 0), 1, 1e-12, `${name} weights`);
      assert.ok(w.every((x) => x > 0));
    }
    rg.joints.forEach((id, i) => {
      const j = JOINT_BY_ID[id];
      assert.equal(j.region, name);
      assert.equal(j.weight, rg.weights[i]);
      assert.equal(S.regionOf(id), name);
    });
    ["flex", "lat", "rot"].forEach((key, c) => {
      const lo = rg.joints.reduce((a, id) => a + JOINT_BY_ID[id].dof[c].min, 0);
      const hi = rg.joints.reduce((a, id) => a + JOINT_BY_ID[id].dof[c].max, 0);
      near(lo, rg.range[key][0], 1e-9, `${name}.${key} min`);
      near(hi, rg.range[key][1], 1e-9, `${name}.${key} max`);
    });
  }
  // literature shape: the low lumbar levels move more in flexion than L1/L2, the C1/C2 level carries about half the neck rotation
  assert.ok(REGIONS.lumbar.weights[1] > REGIONS.lumbar.weights[4]);
  assert.ok(REGIONS.cervical.weightsRot[6] > 0.5);
  assert.ok(REGIONS.thoracic.weightsRot[11] > REGIONS.thoracic.weightsRot[0]);
  assert.equal(S.regionOf("head"), null);
  assert.equal(S.regionOf("hip_L"), null);
  assert.equal(JOINT_BY_ID.head.region, undefined);
});

test("expandRegions: no saturation -> the vertebrae add up to the region total", () => {
  const sp = { lumbar: [40, -12, 8], thoracic: [-20, 15, -30], cervical: [35, 20, -60] };
  const out = S.expandRegions(sp);
  assert.equal(Object.keys(out).length, 24);
  for (const [name, rg] of Object.entries(REGIONS)) {
    for (let c = 0; c < 3; c++) {
      const sum = rg.joints.reduce((a, id) => a + out[id][c], 0);
      near(sum, sp[name][c], 1e-9, `${name}[${c}]`);
    }
    rg.joints.forEach((id, i) => { // proportional to the weights and inside the vertebra's own range
      near(out[id][0], sp[name][0] * rg.weights[i], 1e-9);
      near(out[id][1], sp[name][1] * rg.weightsLat[i], 1e-9);
      near(out[id][2], sp[name][2] * rg.weightsRot[i], 1e-9);
      out[id].forEach((v, c) => assert.ok(v >= JOINT_BY_ID[id].dof[c].min - 1e-9 && v <= JOINT_BY_ID[id].dof[c].max + 1e-9));
    });
  }
  // the whole-region range itself is reachable without saturating any level
  for (const [name, rg] of Object.entries(REGIONS)) {
    for (const [c, key] of ["flex", "lat", "rot"].entries()) {
      for (const end of rg.range[key]) {
        const v = [0, 0, 0];
        v[c] = end;
        const o = S.expandRegions({ [name]: v });
        near(rg.joints.reduce((a, id) => a + o[id][c], 0), end, 1e-9, `${name}.${key} at ${end}`);
      }
    }
  }
  // empty input -> all zeros; missing regions are 0; the input is not modified
  const z = S.expandRegions();
  assert.equal(Object.keys(z).length, 24);
  assert.ok(Object.values(z).every((v) => v.length === 3 && v.every((x) => x === 0)));
  const frozen = Object.freeze({ lumbar: Object.freeze([10, 0, 0]) });
  near(S.expandRegions(frozen).L5[0], 10 * REGIONS.lumbar.weights[0], 1e-12);
  assert.deepEqual(S.expandRegions({ lumbar: [10] }).L5.slice(1), [0, 0], "short arrays are padded with 0");
});

test("expandRegions: a vertebra at its limit is pinned and the rest re-normalised", () => {
  const rg = REGIONS.lumbar;
  const hiL3 = JOINT_BY_ID.L3.dof[0].max;
  // 30 degrees shared by weights; L3 additionally gets +10, which would push it beyond its range
  const out = S.expandRegions({ lumbar: [30, 0, 0] }, { L3: [10, 0, 0] });
  near(out.L3[0], hiL3, 1e-9, "L3 is pinned at its maximum");
  const others = rg.joints.filter((id) => id !== "L3");
  const sumOthers = others.reduce((a, id) => a + out[id][0], 0);
  near(sumOthers + out.L3[0], 30 + 10, 1e-9, "total is conserved: region total + addition");
  near(sumOthers, 30 - (hiL3 - 10), 1e-9, "the pinned level's share is handed on");
  // the others stay proportional to each other
  const wsum = others.reduce((a, id) => a + rg.weights[rg.joints.indexOf(id)], 0);
  others.forEach((id) => near(out[id][0], (sumOthers * rg.weights[rg.joints.indexOf(id)]) / wsum, 1e-9, id));
  // without the addition nothing is pinned
  const plain = S.expandRegions({ lumbar: [30, 0, 0] });
  assert.ok(plain.L3[0] < hiL3);
  // additions alone (zero region total) just add up; negative additions are bounded below
  const add = S.expandRegions({}, { T5: [1, -1, 2] });
  assert.deepEqual(add.T5, [1, -1, 2]);
  assert.deepEqual(S.expandRegions({}, { T5: [3, -2, 1] }).T5.map((x) => +x.toFixed(6)), [2.465753, -1.578947, 1], "additions are limited to the vertebra's own range");
  assert.deepEqual(add.T6, [0, 0, 0]);
  const low = S.expandRegions({}, { L2: [-500, 0, 0] });
  near(low.L2[0], JOINT_BY_ID.L2.dof[0].min, 1e-9, "never beyond the vertebra's own range");
  // asking for more than the region can give: every level ends at its limit, the excess is dropped (not an error)
  const over = S.expandRegions({ lumbar: [500, 0, 0] });
  rg.joints.forEach((id) => near(over[id][0], JOINT_BY_ID[id].dof[0].max, 1e-9));
  near(rg.joints.reduce((a, id) => a + over[id][0], 0), rg.range.flex[1], 1e-9);
  // several pinned levels in one pass; the remainder is shared by the others by weight
  const two = S.expandRegions({ thoracic: [10, 0, 0] }, { T12: [10, 0, 0], T11: [10, 0, 0] });
  const t12 = JOINT_BY_ID.T12.dof[0].max, t11 = JOINT_BY_ID.T11.dof[0].max;
  near(two.T12[0], t12, 1e-9);
  near(two.T11[0], t11, 1e-9);
  const tr = REGIONS.thoracic, restIds = tr.joints.slice(2);
  const rest = restIds.reduce((a, id) => a + two[id][0], 0);
  near(rest, 10 - (t12 - 10) - (t11 - 10), 1e-9, "remainder handed on");
  const wRest = restIds.reduce((a, id) => a + tr.weights[tr.joints.indexOf(id)], 0);
  restIds.forEach((id) => near(two[id][0], (rest * tr.weights[tr.joints.indexOf(id)]) / wRest, 1e-9, id));
  // a cascade: the hand-over pushes further levels to their limits, the excess beyond the region capacity is dropped
  const casc = S.expandRegions({ thoracic: [10, 0, 0] }, { T12: [20, 0, 0], T11: [20, 0, 0] });
  tr.joints.forEach((id) => near(casc[id][0], JOINT_BY_ID[id].dof[0].max, 1e-9, `${id} at its limit`));
  // unknown names throw
  assert.throws(() => S.expandRegions({ sacral: [1, 0, 0] }), /sacral/);
  assert.throws(() => S.expandRegions({}, { head: [1, 0, 0] }), /head/);
  assert.throws(() => S.expandRegions({}, { L9: [1, 0, 0] }), /L9/);
});

// ---- sides ----------------------------------------------------------------------------------------------------------
test("expandSides rules", () => {
  const out = S.expandSides({ hip_LR: [90, 5, -10], knee_L: [100], head: [10, 0, 0], elbow_LR: [90] });
  assert.deepEqual(out.hip_L, [90, 5, -10]);
  assert.deepEqual(out.hip_R, [90, 5, -10]);
  assert.deepEqual(out.knee_L, [100, 0], "padded with zeros to the DOF count");
  assert.equal(out.knee_R, undefined, "unspecified joints are not invented");
  assert.deepEqual(out.head, [10, 0, 0]);
  assert.deepEqual(Object.keys(out).sort(), ["elbow_L", "elbow_R", "head", "hip_L", "hip_R", "knee_L"]);
  // explicit side overrides _LR regardless of key order
  let o = S.expandSides({ hip_R: [10, 0, 0], hip_LR: [90, 0, 0] });
  assert.deepEqual(o.hip_R, [10, 0, 0]);
  assert.deepEqual(o.hip_L, [90, 0, 0]);
  o = S.expandSides({ hip_L: [1, 2, 3], hip_LR: [90, 0, 0], hip_R: [4, 5, 6] });
  assert.deepEqual([o.hip_L, o.hip_R], [[1, 2, 3], [4, 5, 6]]);
  // copies, not aliases
  const input = { hip_LR: [1, 2, 3] };
  o = S.expandSides(input);
  o.hip_L[0] = 99;
  assert.deepEqual(input.hip_LR, [1, 2, 3]);
  assert.notEqual(o.hip_L, o.hip_R);
  assert.deepEqual(S.expandSides({}), {});
  assert.deepEqual(S.expandSides(undefined), {});
  // trailing zeros beyond the DOF count are tolerated, non-zero ones are an error
  assert.deepEqual(S.expandSides({ elbow_LR: [90, 0, 0] }).elbow_L, [90]);
  assert.throws(() => S.expandSides({ elbow_L: [90, 5] }), /elbow_L.*1 DOF/);
  // errors name the id
  assert.throws(() => S.expandSides({ hand_LR: [0] }), /hand_LR/);
  assert.throws(() => S.expandSides({ foo: [0] }), /"foo"/);
  assert.throws(() => S.expandSides({ head_LR: [0] }), /head_LR/, "_LR on an unpaired joint");
  assert.throws(() => S.expandSides({ hip_LR: 90 }), /hip_LR/);
  assert.throws(() => S.expandSides({ hip_LR: [90, "x"] }), /hip_LR/);
  assert.throws(() => S.expandSides({ hip_LR: [NaN] }), /hip_LR/);
  // the expanded values drive the same anatomical movement on both sides
  const sym = S.expandSides({ shoulder_LR: [90, 0, 0] });
  vnear(rot("shoulder_L", sym.shoulder_L, [0, -1, 0]), rot("shoulder_R", sym.shoulder_R, [0, -1, 0]), 1e-12);
});

// ---- root -----------------------------------------------------------------------------------------------------------
test("ROOT_DOF and rootQuaternion", () => {
  assert.deepEqual(S.ROOT_DOF.map((d) => d.key), ["heading", "flex", "lat", "rot"]);
  assert.deepEqual(JOINTS[0].dof.map((d) => d.key), ["flex", "lat", "rot"]);
  for (const d of S.ROOT_DOF) assert.ok(d.min <= -90 && d.max >= 90, d.key);
  S.ROOT_DOF.slice(1).forEach((d, i) => assert.deepEqual(d.axis, JOINTS[0].dof[i].axis));
  const v = (q, p) => p.applyQuaternion(q).toArray();
  // heading + = turn left: facing +Z turns toward +X
  vnear(v(S.rootQuaternion({ heading: 90 }), new THREE.Vector3(0, 0, 1)), [1, 0, 0], 1e-12);
  vnear(v(S.rootQuaternion({ heading: 90 }), new THREE.Vector3(1, 0, 0)), [0, 0, -1], 1e-12);
  // flex -90: lies supine, head toward -Z, face up
  vnear(v(S.rootQuaternion({ flex: -90 }), new THREE.Vector3(0, 1, 0)), [0, 0, -1], 1e-12);
  vnear(v(S.rootQuaternion({ flex: -90 }), new THREE.Vector3(0, 0, 1)), [0, 1, 0], 1e-12);
  // flex +90: prone, face down
  vnear(v(S.rootQuaternion({ flex: 90 }), new THREE.Vector3(0, 0, 1)), [0, -1, 0], 1e-12);
  // lat +90: tilts to the figure's left (head toward +X)
  vnear(v(S.rootQuaternion({ lat: 90 }), new THREE.Vector3(0, 1, 0)), [1, 0, 0], 1e-12);
  // composition: Ry(heading) * swing-twist
  const r = { heading: 33, flex: -20, lat: 10, rot: 25 };
  const ref = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 33 * D2R).multiply(S.jointQuaternion("pelvis", [-20, 10, 25]));
  assert.ok(Math.abs(Math.abs(S.rootQuaternion(r).dot(ref)) - 1) < 1e-14);
  assert.deepEqual(S.rootQuaternion().toArray(), [0, 0, 0, 1]);
});

// ---- bones ----------------------------------------------------------------------------------------------------------
test("bones: valid references, every joint moves a bone, the fixed bones listed in DESIGN.md are present", () => {
  const ids = new Set(BONES.map((b) => b.id));
  assert.equal(ids.size, BONES.length, "unique bone ids");
  const landmarks = new Set(S.BONE_LANDMARKS);
  const moved = new Set();
  for (const b of BONES) {
    assert.ok(JOINT_BY_ID[b.joint], `${b.id}: joint ${b.joint}`);
    moved.add(b.joint);
    assert.ok(b.label && b.kind, b.id);
    for (const end of [b.from, b.to]) {
      if (end == null) continue;
      if (end.startsWith("lm:")) assert.ok(landmarks.has(end.slice(3)), `${b.id}: ${end}`);
      else assert.ok(JOINT_BY_ID[end], `${b.id}: end ${end}`);
    }
    assert.notEqual(b.from, null, b.id);
    assert.ok([null, "L", "R"].includes(b.side), b.id);
    if (S.sideOf(b.joint)) assert.equal(b.side, S.sideOf(b.joint), `${b.id}: a bone on a sided joint has that side`);
    // the bone's own ends move with it: they are its joint or descendants of it (the radius starts at the elbow, its parent)
    for (const end of [b.from, b.to]) if (end && !end.startsWith("lm:")) assert.ok(isAncestorOrSelf(b.joint, end) || b.id.startsWith("radius"), `${b.id} -> ${end}`);
  }
  for (const j of JOINTS) assert.ok(moved.has(j.id), `joint ${j.id} moves at least one bone`);
  const kinds = (k) => BONES.filter((b) => b.kind === k);
  assert.equal(kinds("vertebra").length, 24);
  assert.equal(kinds("rib").length, 24);
  assert.equal(BONES.filter((b) => b.id.startsWith("metacarpal")).length, 10);
  assert.equal(BONES.filter((b) => b.id.startsWith("patella")).length, 2);
  assert.equal(BONES.filter((b) => b.id.startsWith("scapula")).length, 2);
  for (const id of ["sacrum", "sternum", "skull", "mandible", "humerus_L", "ulna_R", "radius_L", "femur_R", "tibia_L", "fibula_R", "calcaneus_L", "metatarsus_R", "clavicle_bone_L", "toes_R"]) assert.ok(ids.has(id), id);
  // ribs hang on T1..T12 (rib n on joint T_n), the scapulae ride on the clavicle joint, the sternum on T4
  for (let n = 1; n <= 12; n++) for (const s of ["L", "R"]) assert.equal(S.BONE_BY_ID[`rib_${n}_${s}`].joint, `T${n}`);
  assert.equal(S.BONE_BY_ID.scapula_L.joint, "clavicle_L");
  assert.equal(S.BONE_BY_ID.sternum.joint, "T4");
  assert.equal(S.BONE_BY_ID.skull.to, "lm:vertex");
  // vertebra bones form a chain from the sacrum to the skull
  assert.equal(S.BONE_BY_ID.vert_L5.from, "L5");
  assert.equal(S.BONE_BY_ID.vert_L5.to, "L4");
  assert.equal(S.BONE_BY_ID.vert_L1.to, "T12");
  assert.equal(S.BONE_BY_ID.vert_T1.to, "C7");
  assert.equal(S.BONE_BY_ID.vert_C1.to, "head");
  assert.equal(S.BONE_BY_ID.sacrum.to, "L5");
  assert.ok(S.BONE_LANDMARKS.includes("vertex") && S.BONE_LANDMARKS.every((l) => !l.startsWith("lm:")));
});

function isAncestorOrSelf(anc, id) {
  for (let j = JOINT_BY_ID[id]; j; j = JOINT_BY_ID[j.parent]) if (j.id === anc) return true;
  return false;
}

// ---- regressions for the verifier's defects ----------------------------------------------------------------------------
test("thumb CMC palmar abduction moves the thumb to the same side as finger MCP flexion (the side the palm faces)", () => {
  for (const suf of ["_L", "_R"]) {
    const d = rot(`thumb_cmc${suf}`, [0, 20], [0, -1, 0]), f = rot(`index_mcp${suf}`, [20, 0], [0, -1, 0]);
    assert.equal(Math.sign(d[0]), Math.sign(f[0]), `${suf}: abduction dx ${d[0]} vs finger flexion dx ${f[0]}`);
    near(d[0], f[0], 1e-12, "same sweep for the same angle");
  }
});

test("eyes: azim + is LATERAL for both eyes (DESIGN.md 1.3 mirror rule); a conjugate gaze needs opposite signs", () => {
  const gaze = (id, a) => rot(id, [0, a], [0, 0, 1]);
  assert.ok(gaze("eye_L", 10)[0] > 0 && gaze("eye_R", 10)[0] < 0, "same angles diverge");
  // looking to the figure's left with both eyes: eye_L azim +a, eye_R azim -a
  near(gaze("eye_L", 10)[0], gaze("eye_R", -10)[0], 1e-12, "conjugate gaze left");
  assert.ok(gaze("eye_R", -10)[0] > 0);
});

test("lumbar flexion-extension shares are White & Panjabi 1990 (L5/S1 20, L4/5 17, L3/4 15, L2/3 14, L1/2 12)", () => {
  const w = S.REGIONS.lumbar.weights, tot = 20 + 17 + 15 + 14 + 12;
  [20, 17, 15, 14, 12].forEach((v, i) => near(w[i], v / tot, 1e-12, `level ${i}`));
});

test("expandRegions rejects non-finite or malformed totals (NaN would otherwise spread over a whole region)", () => {
  assert.throws(() => S.expandRegions({ lumbar: [NaN, 0, 0] }), /lumbar.*finite/);
  assert.throws(() => S.expandRegions({ cervical: [0, Infinity, 0] }), RangeError);
  assert.throws(() => S.expandRegions({ thoracic: ["10", 0, 0] }), RangeError);
  assert.throws(() => S.expandRegions({ thoracic: 10 }), TypeError);
  assert.throws(() => S.expandRegions({ lumbar: [1, 2, 3, 4] }), RangeError);
  assert.throws(() => S.expandRegions({}, { L3: [NaN, 0, 0] }), /L3/);
  const ok = S.expandRegions({ lumbar: [10], thoracic: null }, { L3: [1, undefined, 0] });
  assert.ok(Object.values(ok).every((r) => r.every(Number.isFinite)));
});

test("shoulder swing vectors longer than 180 degrees: the inverse is the wrapped equivalent, swingLength() flags it", () => {
  const a = [150, 150, 0], q = S.jointQuaternion("shoulder_L", a);
  assert.ok(S.swingLength("shoulder_L", a) > 180);
  const back = S.anglesFromQuaternion("shoulder_L", q);
  assert.ok(back.some((v, i) => Math.abs(v - a[i]) > 1), "different (wrapped) angles ...");
  assert.ok(1 - Math.abs(S.jointQuaternion("shoulder_L", back).dot(q)) < 1e-12, "... for the same rotation");
  assert.ok(S.swingLength("shoulder_L", [100, 100, 0]) < 180 && S.swingLength("shoulder_L", [180, 0, 0]) <= 180);
});

// ---- review round: regression tests ---------------------------------------------------------------------------------------
test("eyes in a posture: azim + looks toward the figure's left for BOTH eyes (DESIGN.md 1.4); the joint DOF stays mirror-symmetric", () => {
  const gazeX = (posture) => {
    const ex = S.expandSides(posture);
    return ["eye_L", "eye_R"].map((id) => rot(id, ex[id], [0, 0, 1])[0]);
  };
  for (const posture of [{ eye_LR: [0, 10] }, { eye_L: [0, 10], eye_R: [0, 10] }]) {
    const [l, r] = gazeX(posture);
    assert.ok(l > 0 && r > 0, `conjugate gaze to the left: ${l}, ${r}`);
    near(l, r, 1e-12);
  }
  assert.deepEqual(S.expandSides({ eye_LR: [5, 10] }).eye_R, [5, -10], "only the right eye's azim flips; elev does not");
  assert.deepEqual(S.expandSides({ eye_LR: [5, 10] }).eye_L, [5, 10]);
  assert.deepEqual(S.expandSides({ eye_LR: [5, 0] }).eye_R, [5, 0], "no -0");
  assert.ok(Object.is(S.expandSides({ eye_LR: [5] }).eye_R[1], 0));
  assert.ok(rot("eye_R", [0, 10], [0, 0, 1])[0] < 0, "raw joint convention: lateral +");
});

test("rootQuaternion and checkRoot refuse NaN, Infinity, strings, booleans and null", () => {
  for (const bad of [NaN, Infinity, -Infinity, "30", true, null, {}]) {
    for (const k of ["flex", "lat", "rot", "heading", "x", "y", "z"]) assert.throws(() => S.rootQuaternion({ [k]: bad }), RangeError, `${k}=${String(bad)}`);
  }
  assert.doesNotThrow(() => S.rootQuaternion({}));
  assert.doesNotThrow(() => S.rootQuaternion(undefined));
  assert.doesNotThrow(() => S.rootQuaternion({ flex: 10, lat: undefined, heading: -30 }));
  const q = S.rootQuaternion({ flex: 30, heading: 20 });
  assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite));
});

test("jointQuaternion: holes are 0, strings / booleans / null / NaN are refused, a missing array is neutral", () => {
  vnear(S.jointQuaternion("hip_L", [undefined, 5]).toArray(), S.jointQuaternion("hip_L", [0, 5]).toArray(), 0);
  vnear(S.jointQuaternion("hip_L", [, 5]).toArray(), S.jointQuaternion("hip_L", [0, 5]).toArray(), 0); // eslint-disable-line no-sparse-arrays
  for (const bad of ["30", true, null, NaN, Infinity]) assert.throws(() => S.jointQuaternion("hip_L", [bad]), RangeError, String(bad));
  assert.deepEqual(S.jointQuaternion("hip_L").toArray(), [0, 0, 0, 1]);
  assert.deepEqual(S.jointQuaternion("hip_L", null).toArray(), [0, 0, 0, 1]);
  assert.throws(() => S.jointQuaternion("hip_L", 30), TypeError);
});

test("expandRegions rejects names inherited from Object.prototype (and __proto__) as regions or vertebrae", () => {
  for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.throws(() => S.expandRegions({ [k]: [1] }), /unknown spine region/, k);
    assert.throws(() => S.expandRegions({}, { [k]: [1] }), /unknown vertebra/, k);
  }
  assert.throws(() => S.expandRegions(JSON.parse('{"__proto__": [1]}')), /unknown spine region/);
  assert.doesNotThrow(() => S.expandRegions({ lumbar: [10, 0, 0] }));
});

test("the exported tables are frozen and no DOF record shares an array with another", () => {
  for (const t of [JOINTS, S.JOINT_BY_ID, S.CHILDREN, S.GROUPS, REGIONS, S.ROOT_DOF, BONES, S.BONE_BY_ID, S.BONE_LANDMARKS]) assert.ok(Object.isFrozen(t));
  for (const j of JOINTS) {
    assert.ok(Object.isFrozen(j) && Object.isFrozen(j.dof) && Object.isFrozen(j.probe), j.id);
    for (const d of j.dof) assert.ok(Object.isFrozen(d) && Object.isFrozen(d.axis) && Object.isFrozen(d.probe) && Object.isFrozen(d.moves), `${j.id}.${d.key}`);
  }
  for (const r of Object.values(REGIONS)) assert.ok(Object.isFrozen(r) && Object.isFrozen(r.weights) && Object.isFrozen(r.range.flex) && Object.isFrozen(r.joints));
  assert.throws(() => { JOINT_BY_ID.elbow_L.dof[0].axis[0] = 9; }, TypeError);
  assert.throws(() => { REGIONS.lumbar.weights[0] = 1; }, TypeError);
  assert.throws(() => JOINTS.push({}), TypeError);
  const seen = new Set();
  for (const j of JOINTS) for (const d of j.dof) for (const a of [d.axis, d.probe, d.moves]) {
    assert.ok(!seen.has(a), `${j.id}.${d.key}: shared array`);
    seen.add(a);
  }
  assert.notEqual(JOINT_BY_ID.elbow_L.dof[0].axis, JOINT_BY_ID.hip_L.dof[0].axis);
  // the compiled kernel still works frozen
  assert.ok(Object.isFrozen(JOINT_BY_ID.hip_L.kernel));
  vnear(rot("hip_L", [90, 0, 0], [0, -1, 0]), [0, 0, 1], 1e-12);
});

test("anglesFromQuaternion refuses NaN, missing and non-numeric components; swingLength validates like jointQuaternion", () => {
  for (const q of [{ x: NaN, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, { x: "0", y: 0, z: 0, w: 1 }, { x: 0, y: Infinity, z: 0, w: 1 }, {}]) {
    assert.throws(() => S.anglesFromQuaternion("hip_L", q), RangeError, JSON.stringify(q));
  }
  assert.deepEqual(S.anglesFromQuaternion("hip_L", { x: 0, y: 0, z: 0, w: 1 }), [0, 0, 0]);
  assert.equal(S.swingLength("hip_L"), 0);
  assert.equal(S.swingLength("hip_L", null), 0);
  near(S.swingLength("hip_L", [undefined, 30, 40]), 30, 1e-12);
  assert.throws(() => S.swingLength("hip_L", [NaN]), RangeError);
  assert.throws(() => S.swingLength("hip_L", ["3"]), RangeError);
});

// ---- verifier round: regression tests ---------------------------------------------------------------------------------------
test("clampAngles caps the swing vector at 180 degrees (shoulder flex 150 + abd 150 is 212 and would wrap)", () => {
  const r = S.clampAngles("shoulder_L", [150, 150, 20]);
  near(S.swingLength("shoulder_L", r.angles), 180, 1e-9);
  assert.deepEqual(r.clamped, [true, true, false], "the scaled swing DOFs are reported, the twist is untouched");
  near(r.angles[0], r.angles[1], 1e-12, "scaled by one common factor: same direction");
  assert.equal(r.angles[2], 20);
  // the arm now points up, forward and lateral (the raised arm), not backward-medially
  const arm = rot("shoulder_L", r.angles, [0, -1, 0]);
  assert.ok(arm[2] > 0 && arm[0] > 0, `arm ${arm.map((v) => v.toFixed(2))}`);
  // inside the cap nothing changes
  assert.deepEqual(S.clampAngles("shoulder_L", [100, 100, 0]), { angles: [100, 100, 0], clamped: [false, false, false] });
  assert.deepEqual(S.clampAngles("shoulder_L", [180, 0, 0]).clamped, [false, false, false]);
  // pelvis root box is +-180 per DOF: the cap applies there too
  near(S.swingLength("pelvis", S.clampAngles("pelvis", [180, -180, 0]).angles), 180, 1e-9);
});

test("clampAngles output always round-trips through jointQuaternion / anglesFromQuaternion (every joint, corners of the box included)", () => {
  const r = rng(7);
  for (const j of JOINTS) {
    const trials = [j.dof.map((d) => d.max), j.dof.map((d) => d.min), j.dof.map((d, i) => (i % 2 ? d.min : d.max))];
    for (let n = 0; n < 60; n++) trials.push(j.dof.map((d) => d.min + (d.max - d.min) * r()));
    for (const a of trials) {
      const c = S.clampAngles(j.id, a).angles;
      assert.ok(S.swingLength(j.id, c) <= 180 + 1e-9, `${j.id} ${a}`);
      if (S.swingLength(j.id, c) > 179.5 || j.dof.some((d, i) => d.role === "twist" && Math.abs(c[i]) > 179.5)) continue; // documented singularities
      const back = S.anglesFromQuaternion(j.id, S.jointQuaternion(j.id, c));
      c.forEach((v, i) => near(back[i], v, 1e-6, `${j.id}[${i}] ${a}`));
    }
  }
});

test("expandSides: undefined entries are 0 (as in jointQuaternion and Kinematics.solve), other junk still throws", () => {
  assert.deepEqual(S.expandSides({ hip_L: [undefined, 5] }).hip_L, [0, 5, 0]);
  assert.deepEqual(S.expandSides({ hip_LR: [, 5] }).hip_R, [0, 5, 0]); // eslint-disable-line no-sparse-arrays
  assert.deepEqual(S.expandSides({ knee_L: [10, 5, undefined] }).knee_L, [10, 5]);
  for (const bad of [null, "3", true, NaN, Infinity]) assert.throws(() => S.expandSides({ hip_L: [0, bad] }), /not a finite number/, String(bad));
  assert.throws(() => S.expandSides({ knee_L: [10, 5, 1] }), /DOF/);
});

test("jointQuaternion: an undefined entry beyond the DOF count is a hole (no message about finiteness); a non-zero one is a length error", () => {
  const a = [1, 2, 3];
  a[5] = undefined;
  assert.doesNotThrow(() => S.jointQuaternion("hip_L", a));
  vnear(S.jointQuaternion("hip_L", a).toArray(), S.jointQuaternion("hip_L", [1, 2, 3]).toArray(), 0);
  const b = [1, 2, 3];
  b[5] = 4;
  assert.throws(() => S.jointQuaternion("hip_L", b), /3 DOF/);
});

test("anglesFromQuaternion: finite but huge or tiny components are normalised without overflow; non-finite ones still throw", () => {
  const h = Math.SQRT1_2;
  const ref = S.anglesFromQuaternion("hip_L", { x: h, y: 0, z: 0, w: h });
  for (const s of [1e308, 1e-300]) {
    const got = S.anglesFromQuaternion("hip_L", { x: h * s, y: 0, z: 0, w: h * s });
    vnear(got, ref, 1e-9, `scale ${s}`);
  }
  vnear(S.anglesFromQuaternion("hip_L", { x: 1e308, y: 1e308, z: 0, w: 0 }), S.anglesFromQuaternion("hip_L", { x: 1, y: 1, z: 0, w: 0 }), 1e-9);
  assert.throws(() => S.anglesFromQuaternion("hip_L", { x: 1e308, y: Infinity, z: 0, w: 0 }), RangeError);
});
