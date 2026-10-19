// Third adversarial verification round of pose.js / proxies.js / postures.js / postures/grips.js (independent of the author's tests and of
// pose.adversarial.test.mjs / pose.adversarial2.test.mjs, whose defects are all fixed now and whose todo flags were removed).
// The oracle is the skin itself, not the capsules: the superellipse sections of body.shape (rings of the tubes), posed with the same kinematics,
// sampled on their boundary and tested against the sections of the torso / head. A capsule check is "right" when it agrees with that.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.adversarial.round3.test.mjs"
// Tests marked `todo` document CONFIRMED DEFECTS: they assert the correct behaviour and currently fail (node reports them as todo, not as
// failures, so the suite stays green; remove the todo flag when the defect is fixed).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, clampAngles } from "../../site/js/human/skeleton.js";
import * as P from "../../site/js/human/pose.js";
import { bodyProxies } from "../../site/js/human/proxies.js";
import { GRIP_NAMES } from "../../site/js/human/postures/grips.js";
import { fitBody } from "../../site/js/human/fit.js";
import * as H from "./pose.adversarial.helpers.mjs";

const MAN = H.army("M"), WOMAN = H.army("F"), WOMAN5 = H.army("F", 5), MAN95 = H.army("M", 95);
const FOUR = { MAN, WOMAN, WOMAN5, MAN95 };
const posture = H.posture;
const rootOf = (b) => ({ y: b.joints.pelvis.offset[1] });

// depth (m, positive = inside the skin) of a world point in the loft of a stack of rings (static, neutral torso / head); -1 outside the stack
function depthIn(rings, p) {
  const rs = rings.slice().sort((a, b) => a.c[1] - b.c[1]);
  if (p.y < rs[0].c[1] || p.y > rs[rs.length - 1].c[1]) return -1;
  let i = 0; while (i < rs.length - 2 && rs[i + 1].c[1] < p.y) i++;
  const a = rs[i], b = rs[i + 1], t = Math.min(1, Math.max(0, (p.y - a.c[1]) / (b.c[1] - a.c[1]))), L = (u, v) => u + (v - u) * t;
  const rx = L(a.rx, b.rx), rz = L(a.rz, b.rz), n = L(a.n ?? 2, b.n ?? 2);
  return (1 - (Math.abs((p.x - L(a.c[0], b.c[0])) / rx) ** n + Math.abs((p.z - L(a.c[2], b.c[2])) / rz) ** n) ** (1 / n)) * Math.min(rx, rz);
}
const torsoRings = (b) => b.shape.tubes.torso.rings.filter((r) => r.id !== "crotch");

// =====================================================================================================================================
// 1. an upper arm through the thorax (the pair upper_arm / chest and upper_arm / shoulders is never tested: proxies.js pairTolerance returns null)
// =====================================================================================================================================
// NB: solvePose returns the body's ONE shared Kinematics (valid until the next pose.js call for that body): take the neutral joint position first, solve the pose last
function upperArmSkinDepth(body, joints, rings, tube = "upper_arm_L", joint = "shoulder_L", skip = 1) {
  const q0 = P.solvePose(body, { angles: {} }, rootOf(body)).position(joint).clone(); // neutral joint position (the tube rings are in the neutral world)
  const kin = P.solvePose(body, P.expandPosture({ id: "a", joints }), rootOf(body));
  let worst = -1;
  for (const r of body.shape.tubes[tube].rings.slice(skip)) for (let a = 0; a < 12; a++) {
    const th = (a * Math.PI) / 6, loc = new THREE.Vector3(r.c[0] - q0.x + r.rx * Math.cos(th), r.c[1] - q0.y, r.c[2] - q0.z + r.rz * Math.sin(th));
    worst = Math.max(worst, depthIn(rings, kin.toWorld(joint, loc)));
  }
  return worst;
}
test("validator: the upper arm swung through the thorax (shoulder extension + adduction) is rejected", { todo: "DEFECT (high) proxies.js:337 pairTolerance returns null for upper_arm vs chest and upper_arm vs shoulders (the shoulder joint is inside the chest outline in the neutral pose), so no part of the upper arm is ever tested against the chest, however deep: shoulder_L [-60, -50, 60] + elbow_L [10] puts the left elbow 36 mm to the RIGHT of the midline and 18 cm BEHIND the body, the upper arm crosses the whole thorax, and the validator says ok with no warning (shoulder_LR is only rejected because the two upper arms overlap each other). 80 to 135 mm of upper-arm skin inside the torso skin are accepted" }, () => {
  for (const [n, b] of Object.entries(FOUR)) {
    for (const joints of [{ shoulder_L: [-60, -50, 60], elbow_L: [10] }, { shoulder_L: [-30, -45, 0], elbow_L: [0] }]) {
      const v = P.validatePosture(b, posture({ id: "arm-through-chest", joints }));
      const d = upperArmSkinDepth(b, joints, torsoRings(b));
      assert.ok(!v.ok || d < 0.05, `${n} ${JSON.stringify(joints)}: accepted with ${(d * 1000).toFixed(0)} mm of upper-arm skin inside the torso skin`);
    }
  }
});
test("validator: no accepted shoulder pose (elbow 10 / 90, rotation -60/0/60) has more than 60 mm of upper-arm skin inside the torso skin (4 bodies)", { todo: "DEFECT (high), same cause as above: 1400 accepted poses per body, 99th percentile of the depth 84 to 99 mm, maximum 102 (man) to 135 mm (95th percentile man); the rejected ones go to 117 to 143 mm" }, () => {
  for (const [n, body] of Object.entries(FOUR)) {
    const T = torsoRings(body); let worst = 0, at = null;
    for (let flex = -60; flex <= 150; flex += 15) for (let abd = -50; abd <= 60; abd += 10) for (const rot of [-60, 0, 60]) for (const el of [10, 90]) {
      const sh = clampAngles("shoulder_L", [flex, abd, rot]); if (sh.clamped.some(Boolean)) continue;
      const joints = { shoulder_L: sh.angles, elbow_L: [el] };
      const v = P.validatePosture(body, posture({ id: "a", joints }));
      if (!v.ok) continue;
      const d = upperArmSkinDepth(body, joints, T);
      if (d > worst) { worst = d; at = joints; }
    }
    assert.ok(worst < 0.06, `${n}: accepted pose with ${(worst * 1000).toFixed(0)} mm of upper-arm skin inside the torso: ${JSON.stringify(at)}`);
  }
});

// =====================================================================================================================================
// 2. a hand resting on the head (the head capsule is a circle of radius mean(rx, rz), 10 to 16 mm wider than the head is at the temples)
// =====================================================================================================================================
test("validator: a palm resting against the side of the head (palm facing the head, touching the skin, nothing of the hand inside it) is not rejected as 'a hand is inside the body'", { todo: "MEDIUM proxies.js:165 the head capsule has radius (rx + rz) / 2 = 87 mm (man) while the head is 77 mm wide: a palm laid on the temple or the ear (phone to ear, hand to the head, a hand supporting the head) overlaps the capsule by 21 to 41 mm against a tolerance of 20 to 25 mm. 40 to 65 % of such poses are rejected (man 43/64, woman 41/90, 95th-percentile man 19/37)" }, () => {
  const HAND = ["grip_centre_L", "metacarpale_radiale_L", "metacarpale_ulnare_L", "middle_tip_L", "index_tip_L", "ring_tip_L", "little_tip_L", "thumb_tip_L", "stylion_L"];
  const wi = JOINTS.findIndex((j) => j.id === "wrist_L");
  let n = 0, rej = 0;
  for (const [bn, body] of Object.entries(FOUR)) {
    const rand = H.rng(92), root = rootOf(body), head = body.shape.head.rings;
    let m = 0;
    for (let it = 0; it < 300000 && m < 60; it++) {
      const sh = clampAngles("shoulder_L", [-30 + rand() * 210, -30 + rand() * 170, -80 + rand() * 160]);
      const joints = { shoulder_L: sh.angles, elbow_L: [40 + rand() * 110], forearm_L: [-90 + rand() * 180], wrist_L: [-40 + rand() * 80, -10 + rand() * 20] };
      const ex = P.expandPosture({ id: "a", joints, grips: { L: "flat", R: "relaxed" } }), kin = P.solvePose(body, ex, root);
      const pc = P.landmarkPosition(body, ex, root, "palm_centre_L"), d0 = depthIn(head, pc);
      if (d0 > 0.001 || d0 < -0.006) continue;
      if (Math.max(...HAND.map((id) => depthIn(head, P.landmarkPosition(body, ex, root, id)))) > 0.001) continue;
      const q = new THREE.Quaternion(kin.quaternions[4 * wi], kin.quaternions[4 * wi + 1], kin.quaternions[4 * wi + 2], kin.quaternions[4 * wi + 3]);
      const nrm = new THREE.Vector3(-1, 0, 0).applyQuaternion(q), mid = head[Math.floor(head.length / 2)];
      if (nrm.dot(new THREE.Vector3(0, pc.y, mid.c[2]).sub(pc).normalize()) < 0.8) continue; // the palm faces the head
      const v = P.validatePosture(body, posture({ id: "a", joints, grips: { L: "flat", R: "relaxed" } }));
      if (v.errors.some((e) => /range|requested|swing/.test(e))) continue;
      m++; n++;
      if (v.errors.some((e) => /head and (palm|thumb|index|fingers|ring|little)/.test(e))) rej++;
    }
  }
  assert.ok(n >= 100, `only ${n} touching poses sampled`);
  assert.ok(rej / n < 0.1, `${rej} of ${n} palm-on-head poses rejected`);
});

// =====================================================================================================================================
// 3. seated with the hips externally rotated: the greater trochanter (a bony landmark on the side of the hip) 'sinks into the seat'
// =====================================================================================================================================
test("validator: sitting with the thighs rotated outward by 45 degrees is not rejected for the trochanter 'sinking into the seat' (a soft seat gives 20 mm)", { todo: "LOW pose.js:1014 SINK = 5 mm applies to trochanterion_L/R, which rides on the hip joint: external hip rotation 45 deg with abduction 0..15 swings it up to 35 mm below the plane of the ischial tuberosities (9 of 176 population medians rejected at abduction 15, 11 at abduction 0, 'trochanterion_R by 35 mm'), 30 deg: 1 to 3 of 176. The ischial and thigh-under contacts are the support, the trochanter is not a contact" }, () => {
  const bodies = H.populationFiles().map((f) => H.popBody(f));
  let sink = 0;
  for (const b of bodies) {
    const v = P.validatePosture(b, posture({ id: "s", support: "seat", joints: { hip_LR: [90, 15, -45], knee_LR: [90] }, hints: { seat: { height: 0.45 } } }));
    if (v.errors.some((e) => /sink into the seat/.test(e))) sink++;
  }
  assert.equal(sink, 0, `${sink} of ${bodies.length} medians rejected for a sink into the seat`);
});

// =====================================================================================================================================
// 4. guards: things that were tried and are fine (they must stay fine)
// =====================================================================================================================================
test("guard: validatePosture never throws and always returns {ok, errors:string[], warnings, metrics} for 30000 random garbage postures", () => {
  const rand = H.rng(123), pick = (a) => a[Math.floor(rand() * a.length)];
  const vals = [0, 1, -1, 90, 1e9, -1e9, NaN, Infinity, "10", null, undefined, true, {}, [], [1], [1, 2], [1, 2, 3, 4, 5], ["a"], [NaN], [0, 0, 0], "popliteal", -0, 0.5, 1e-300];
  const val = () => (rand() < 0.5 ? pick(vals) : [pick(vals), pick(vals), pick(vals)].slice(0, 1 + Math.floor(rand() * 3)));
  const jids = JOINTS.map((j) => j.id), bases = [...new Set(jids.map((i) => i.replace(/_[LR]$/, "")))];
  const keys = () => (rand() < 0.3 ? pick(bases) + "_LR" : rand() < 0.5 ? pick(jids) : pick(["pelvis", "hip", "__proto__", "constructor", "toString", "x", "L3_LR", "hip_L_LR", ""]));
  const supports = [...Object.keys(P.SUPPORT_CARRIERS), "bogus", undefined, null, 5, "__proto__"];
  for (let it = 0; it < 30000; it++) {
    const p = { id: "f-" + it, name: "n", category: "Reference", tags: ["a"], description: "a posture in the fuzz test", source: "illustrative", support: pick(supports) };
    if (rand() < 0.8) { p.joints = {}; for (let k = 0; k < 1 + Math.floor(rand() * 5); k++) p.joints[keys()] = val(); }
    if (rand() < 0.4) p.spine = { [pick(["lumbar", "thoracic", "cervical", "neck"])]: val() };
    if (rand() < 0.3) p.root = { [pick(["heading", "flex", "lat", "rot", "x", "y", "z", "bogus"])]: pick(vals) };
    if (rand() < 0.3) p.grips = { [pick(["L", "R", "M"])]: pick(["fist", "open", "nope", null, 5, "__proto__"]) };
    if (rand() < 0.3) p.hints = { seat: pick([{ height: pick(vals) }, null, 5]), dynamic: pick(vals), externalSupport: pick(vals), contactTolerance: pick(vals), load: pick([{ mass: pick(vals) }, { mass: 5, landmarks: pick([["nope"], [], ["grip_centre_L"], "x"]) }, null, 3]) };
    if (rand() < 0.2) p.contacts = pick([["heel_sole_L"], ["nope"], "heel", [5], []]);
    const r = P.validatePosture(MAN, p, rand() < 0.2 ? { seatHeight: pick(vals), contactTolerance: pick(vals) } : undefined);
    assert.ok(r && typeof r.ok === "boolean" && Array.isArray(r.errors) && r.errors.every((e) => typeof e === "string") && Array.isArray(r.warnings) && r.metrics, JSON.stringify(p).slice(0, 200));
    assert.equal(r.ok, r.errors.length === 0);
    assert.ok(!r.errors.some((e) => /internal error|\[object/.test(e)), `${r.errors.find((e) => /internal error|\[object/.test(e))} for ${JSON.stringify(p).slice(0, 200)}`);
  }
});

test("guard: the blend of two valid poses (every DOF at min / max / random, root any orientation) stays inside the range of motion, 30000 blends, never NaN", () => {
  const rand = H.rng(77);
  const extremePose = () => {
    const angles = {};
    for (const j of JOINTS) { if (j.id === "pelvis") continue; angles[j.id] = clampAngles(j.id, j.dof.map((d) => { const r = rand(); return r < 0.35 ? d.min : r < 0.7 ? d.max : d.min + rand() * (d.max - d.min); })).angles; }
    return { root: { heading: (rand() - 0.5) * 360, flex: (rand() - 0.5) * 360, lat: (rand() - 0.5) * 360, rot: (rand() - 0.5) * 360 }, angles };
  };
  for (let it = 0; it < 6000; it++) {
    const a = extremePose(), b = extremePose();
    for (const t of [0.07, 0.3, 0.5, 0.77, 0.93]) {
      const m = P.blendPoses(a, b, t);
      assert.equal(P.clampPose(m).clamped.length, 0, `blend leaves the ROM at t=${t}`);
      for (const arr of Object.values(m.angles)) assert.ok(arr.every(Number.isFinite));
    }
  }
});

test("guard: a leg through the other leg is never accepted (independent chain of ring spheres, 3 bodies x 5000 random leg poses)", () => {
  for (const [bn, body] of Object.entries({ MAN, WOMAN, WOMAN5 })) {
    const rand = H.rng(21), kin0 = P.solvePose(body, { angles: {} }, rootOf(body));
    const mk = (tube, joint) => body.shape.tubes[tube].rings.map((r) => { const q = kin0.position(joint); return { joint, off: new THREE.Vector3(r.c[0] - q.x, r.c[1] - q.y, r.c[2] - q.z), r: 0.5 * (r.rx + r.rz) }; });
    const legs = { L: [...mk("thigh_L", "hip_L"), ...mk("shank_L", "knee_L")], R: [...mk("thigh_R", "hip_R"), ...mk("shank_R", "knee_R")] };
    let accepted = 0;
    for (let it = 0; it < 5000; it++) {
      const joints = { hip_L: [-20 + rand() * 155, -30 + rand() * 90, -60 + rand() * 110], hip_R: [-20 + rand() * 155, -30 + rand() * 90, -60 + rand() * 110], knee_L: [rand() * 150], knee_R: [rand() * 150], ankle_LR: [-30 + rand() * 50] };
      const p = posture({ id: "l", joints, hints: { dynamic: true, externalSupport: true } });
      if (!P.validatePosture(body, p).ok) continue;
      accepted++;
      const ex = P.expandPosture(p), kin = P.solvePose(body, ex, P.placePose(body, ex, {}));
      const PL = legs.L.map((x) => kin.toWorld(x.joint, x.off.clone())), PR = legs.R.map((x) => kin.toWorld(x.joint, x.off.clone()));
      let m = -9;
      for (let a = 0; a < PL.length; a++) for (let b = 0; b < PR.length; b++) m = Math.max(m, legs.L[a].r + legs.R[b].r - PL[a].distanceTo(PR[b]));
      assert.ok(m < 0.07, `${bn}: accepted with leg spheres overlapping by ${(m * 1000).toFixed(0)} mm: ${JSON.stringify(joints)}`);
    }
    assert.ok(accepted > 500, `${bn}: only ${accepted} accepted`);
  }
});

test("guard: legs and shanks do not sink into the torso skin by more than 60 mm in accepted squat / stoop poses (hip 60..135, knee 40..155, lumbar and thoracic flexion)", () => {
  const SPINE = new Set(JOINTS.filter((j) => j.region).map((j) => j.id)); SPINE.add("pelvis");
  const qv = new THREE.Quaternion(), v = new THREE.Vector3();
  const heavy = fitBody({ sex: "M", measures: { stature: { value: 1800, unit: "mm" }, mass: { value: 130, unit: "kg" } } });
  for (const [bn, body] of Object.entries({ MAN, WOMAN, heavy })) {
    const px = bodyProxies(P.figureOf(body)), TR = px.rings.filter((r) => SPINE.has(r.joint));
    const kin0 = P.solvePose(body, { angles: {} }, rootOf(body));
    const mkpts = (rings, joint) => { const q = kin0.position(joint), out = []; for (const r of rings) for (let a = 0; a < 8; a++) { const th = (a * Math.PI) / 4; out.push([joint, new THREE.Vector3(r.c[0] - q.x + r.rx * Math.cos(th), r.c[1] - q.y, r.c[2] - q.z + r.rz * Math.sin(th))]); } return out; };
    const thigh = body.shape.tubes.thigh_L.rings, pts = [...mkpts(thigh.slice(Math.ceil(thigh.length * 0.5)), "hip_L"), ...mkpts(body.shape.tubes.shank_L.rings, "knee_L")];
    const rand = H.rng(33); let worst = -1;
    for (let it = 0; it < 1500; it++) {
      const p = posture({ id: "t", joints: { hip_LR: [60 + rand() * 75, -10 + rand() * 30, 0], knee_LR: [40 + rand() * 115], ankle_LR: [rand() * 30 - 10] }, spine: { lumbar: [rand() * 60 - 10, 0, 0], thoracic: [rand() * 45 - 5, 0, 0] }, hints: { dynamic: true, externalSupport: true } });
      if (!P.validatePosture(body, p).ok) continue;
      const ex = P.expandPosture(p), kin = P.solvePose(body, ex, P.placePose(body, ex, {}));
      const R = TR.map((r) => { const j = r.ji; qv.set(kin.quaternions[4 * j], kin.quaternions[4 * j + 1], kin.quaternions[4 * j + 2], kin.quaternions[4 * j + 3]); const ex_ = new THREE.Vector3(...r.ex).applyQuaternion(qv), ez = new THREE.Vector3(...r.ez).applyQuaternion(qv); return { c: new THREE.Vector3(...r.off).applyQuaternion(qv).add(new THREE.Vector3(kin.positions[3 * j], kin.positions[3 * j + 1], kin.positions[3 * j + 2])), ex: ex_, ez, n: ex_.clone().cross(ez).normalize(), rx: r.rx, rz: r.rz, nn: r.q / (r.q - 1) }; });
      for (const [jn, loc] of pts) {
        const w = kin.toWorld(jn, loc.clone());
        for (const r of R) { v.copy(w).sub(r.c); if (Math.abs(v.dot(r.n)) > 0.025) continue; const f = (Math.abs(v.dot(r.ex) / r.rx) ** r.nn + Math.abs(v.dot(r.ez) / r.rz) ** r.nn) ** (1 / r.nn); worst = Math.max(worst, (1 - f) * Math.min(r.rx, r.rz)); }
      }
    }
    assert.ok(worst < 0.06, `${bn}: ${(worst * 1000).toFixed(0)} mm of leg skin inside the torso skin in an accepted pose`);
  }
});

test("guard: stature-only and stature+mass bodies from 1.0 m to 2.4 m, 25 to 250 kg: reference, lying and squat postures validate without internal errors or NaN", () => {
  const defs = [
    ["neutral", { support: "feet" }],
    ["iso-sit", { support: "seat+feet", joints: { hip_LR: [90], knee_LR: [90] } }],
    ["t-pose", { support: "feet", joints: { shoulder_LR: [0, 84, 0] }, grips: { L: "open", R: "open" } }],
    ["supine", { support: "body", root: { flex: -90 } }],
    ["prone", { support: "body", root: { flex: 90 }, joints: { ankle_LR: [-40] } }],
    ["side", { support: "body", root: { lat: 90 } }],
  ];
  for (const sex of ["M", "F"]) for (const st of [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400]) for (const mass of [null, 25, 60, 120, 250]) {
    const meas = { stature: { value: st, unit: "mm" } }; if (mass) meas.body_mass = { value: mass, unit: "kg" };
    const body = fitBody({ sex, measures: meas });
    for (const [name, def] of defs) {
      const v = P.validatePosture(body, posture({ id: "r-" + name, ...def }));
      assert.ok(v.ok, `${sex} ${st} mm ${mass} kg ${name}: ${v.errors.join("; ")}`);
      assert.ok(v.metrics.root && Object.values(v.metrics.root).every(Number.isFinite), `${sex} ${st} ${mass} ${name}: root`);
    }
  }
});

test("guard: lying supine / prone with the arms / legs articulated rests on the floor within 10 mm on the rig skin (arms overhead, knees up, head up, hands behind the head)", async () => {
  const { buildRig } = await import("../../site/js/human/rig.js");
  const { buildSkin } = await import("../../site/js/human/body.js");
  const poses = {
    "supine arms overhead": { root: { flex: -90 }, joints: { shoulder_LR: [170, 0, 0] } },
    "supine knees up": { root: { flex: -90 }, joints: { hip_LR: [60, 0, 0], knee_LR: [100] } },
    "prone arms forward": { root: { flex: 90 }, joints: { shoulder_LR: [170, 0, 0], ankle_LR: [-40] } },
    "prone head up": { root: { flex: 90 }, spine: { cervical: [-40, 0, 0], thoracic: [-20, 0, 0], lumbar: [-30, 0, 0] }, joints: { ankle_LR: [-40] } },
    "hands behind head": { root: { flex: -90 }, joints: { shoulder_LR: [150, 60, 40], elbow_LR: [140] } },
  };
  const files = H.populationFiles();
  for (let i = 0; i < files.length; i += 17) for (const pc of [5, 95]) {
    const body = H.popBody(files[i], pc), rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o), skeleton: false });
    for (const [name, def] of Object.entries(poses)) {
      const ex = P.expandPosture({ id: "l", ...def }), r = P.placePose(body, ex, { support: "body" });
      rig.setPose({ root: r, angles: ex.angles }, { clamp: false });
      const y = rig.lowestY({ skin: true });
      assert.ok(Math.abs(y) < 0.01, `${name} pc${pc} #${i}: skin ${(y * 1000).toFixed(1)} mm from the floor`);
    }
  }
});
test("lying on a side: the skin of the 95th-percentile body of every third population rests within 8 mm of the floor", { todo: "MEDIUM proxies.js lowestSkinPoint (the 'body' carrier, lat = +-90): the shoulder / deltoid section of the upper-arm tube reaches 8 to 16 mm lower than the skin of body.js, so the body floats: 12 of 118 side-lying P95 bodies float more than 5 mm (multiple-latin-america-18-countries/tri-service/both 16.0 mm, germany/aircrew/both 14.1, france/pilots/both 11.3), against the documented 'within 5 mm in 98 % of 792, worst 7 mm' (POSE.md section 4)" }, async () => {
  const { buildRig } = await import("../../site/js/human/rig.js");
  const { buildSkin } = await import("../../site/js/human/body.js");
  const files = H.populationFiles(); let worst = 0, at = "";
  for (let i = 0; i < files.length; i += 3) {
    const body = H.popBody(files[i], 95), rig = buildRig(body, { skinBuilder: (b, bones, o) => buildSkin(b, bones, o), skeleton: false });
    const ex = P.expandPosture({ id: "l", root: { lat: 90 } }), r = P.placePose(body, ex, { support: "body" });
    rig.setPose({ root: r, angles: ex.angles }, { clamp: false });
    const y = rig.lowestY({ skin: true });
    if (Math.abs(y) > worst) { worst = Math.abs(y); at = files[i]; }
  }
  assert.ok(worst < 0.008, `worst ${(worst * 1000).toFixed(1)} mm (${at})`);
});

test("guard: a deep-frozen body, a JSON round-tripped body and a shared body give the same verdict and metrics; interleaving bodies changes nothing", () => {
  const deep = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Reflect.ownKeys(o)) deep(o[k]); } return o; };
  const p = posture({ id: "x", support: "seat+feet", joints: { hip_LR: [90], knee_LR: [90] } });
  const ref = P.validatePosture(MAN, p);
  for (const b of [JSON.parse(JSON.stringify(MAN)), deep(structuredClone(MAN))]) {
    const v = P.validatePosture(b, p);
    assert.deepEqual(v.errors, ref.errors); assert.deepEqual(v.metrics.gaps, ref.metrics.gaps); assert.equal(v.metrics.seatHeight, ref.metrics.seatHeight);
  }
  const a1 = P.validatePosture(MAN, posture({ id: "y", joints: { hip_LR: [20] } }));
  P.validatePosture(WOMAN, p);
  assert.deepEqual(P.validatePosture(MAN, posture({ id: "y", joints: { hip_LR: [20] } })), a1);
});

test("guard: the verdict of a seated / standing / kneeling posture does not depend on a twist of the pelvis about the vertical (root.rot 30, 90, -90, 180)", () => {
  for (const b of [MAN, WOMAN, WOMAN5, MAN95]) for (const base of [
    { support: "seat+feet", joints: { hip_LR: [90], knee_LR: [90] } },
    { support: "feet", joints: { shoulder_LR: [30, 20, 0] }, spine: { lumbar: [20, 0, 0] } },
    { support: "knees", joints: { hip_LR: [5], knee_LR: [100], ankle_LR: [-50] }, hints: { externalSupport: true } },
  ]) {
    const ref = P.validatePosture(b, posture({ id: "r", ...base }));
    for (const rot of [30, 90, -90, 180]) {
      const v = P.validatePosture(b, posture({ id: "r", ...base, root: { rot } }));
      assert.equal(v.ok, ref.ok); assert.equal(v.errors.length, ref.errors.length);
      assert.ok(Math.abs((v.metrics.balanceMargin ?? 0) - (ref.metrics.balanceMargin ?? 0)) < 1e-6 && Math.abs(v.metrics.worstPenetration - ref.metrics.worstPenetration) < 1e-6);
    }
  }
});

test("guard: validatePosture speed. cold first call on a new body under 40 ms, warm calls under 1.5 ms for every support, 200 postures x 6 bodies under 2 s", () => {
  const bodies = H.populationFiles().slice(0, 30).map((f) => H.popBody(f));
  let t = performance.now();
  for (const b of bodies) P.validatePosture(b, posture({ id: "x", support: "seat+feet", joints: { hip_LR: [90], knee_LR: [90] } }));
  assert.ok((performance.now() - t) / bodies.length < 40, `cold ${(performance.now() - t) / bodies.length} ms per body`);
  for (const s of Object.keys(P.SUPPORT_CARRIERS)) {
    const p = posture({ id: "z", support: s, joints: { hip_LR: [90], knee_LR: [90] }, hints: { dynamic: true, externalSupport: true } });
    P.validatePosture(bodies[0], p); t = performance.now();
    for (let i = 0; i < 200; i++) P.validatePosture(bodies[0], p);
    assert.ok((performance.now() - t) / 200 < 1.5, `${s}: ${((performance.now() - t) / 200).toFixed(2)} ms`);
  }
  const lib = Array.from({ length: 200 }, (_, i) => posture({ id: "p" + i, joints: { hip_LR: [i % 100], knee_LR: [i % 120] } }));
  t = performance.now();
  for (const b of bodies.slice(0, 6)) for (const p of lib) P.validatePosture(b, p, { library: lib });
  assert.ok(performance.now() - t < 2000, `${performance.now() - t} ms`);
});

test("grips: every preset keeps its description's geometry: thumb-tip to fingertip distances of the pinch / tripod / precision / power / wheel presets", () => {
  const body = MAN, root = rootOf(body), d = {};
  for (const g of GRIP_NAMES) {
    const ex = P.expandPosture({ id: "g", grips: { L: g, R: g } }), tip = (id) => P.landmarkPosition(body, ex, root, id);
    d[g] = { ti: tip("thumb_tip_L").distanceTo(tip("index_tip_L")), tm: tip("thumb_tip_L").distanceTo(tip("middle_tip_L")) };
  }
  assert.ok(d.pinch.ti < 0.02, "pinch: thumb pad to index pad"); assert.ok(d.tripod.tm < 0.02, "tripod: thumb to middle"); assert.ok(d.wheel.ti < 0.02, "wheel: thumb over the index finger");
  assert.ok(d.power.ti < 0.03 && d.fist.ti > 0.05 && d.point.ti > 0.1, "power wraps, a fist keeps the thumb away from the index tip, a pointing hand has it far");
});

test("grips: 'spherical' (a ball of about 60 mm) opens the thumb at least 30 mm from the index and middle fingertips", { todo: "LOW grips.js spherical: thumb tip to index tip 15 mm, to middle tip 17 mm, (palm centre to fingertips 66 to 86 mm): the five digits close on something of about 20 to 30 mm, not on a 60 mm ball; cup (23 mm thumb to index tip) is just as tight for a cup or a ball of 70 mm. The sources say 'approx.', but the description is the contract" }, () => {
  const body = MAN, root = rootOf(body), ex = P.expandPosture({ id: "g", grips: { L: "spherical", R: "spherical" } }), tip = (id) => P.landmarkPosition(body, ex, root, id);
  assert.ok(tip("thumb_tip_L").distanceTo(tip("index_tip_L")) >= 0.03, "thumb to index tip");
  assert.ok(tip("thumb_tip_L").distanceTo(tip("middle_tip_L")) >= 0.03, "thumb to middle tip");
});
