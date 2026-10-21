// Independent check of the reconciliation after the shank-lean / centre-of-mass change of fit.js (MODEL.md 4.1, 7.1; POSE.md "Balance and the stance").
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/reconcile.adversarial.test.mjs"
// Written by the checker, not by the author of the reconciliation. Nothing here reads the expectations of the reconciled tests: every number is recomputed from the model.
//  1. neutral standing geometry of the 528 population bodies (176 populations x P5/P50/P95) and 600 real people (every 23rd subject of the four surveys);
//  2. seated closure of real people, independently of the fit report;
//  3. the balance rule on six bodies x eleven postures x with and without 15 kg in the hands;
//  4. the guards that the reconciliation touched (the validator still rejects the gross errors it rejected before).
// (It had a node:test `todo` test "DEFECT ..." for the shank lean of 1 to 5 degrees; the lean was capped at 4.9 and the test is a real test now. MODEL.md 7.1.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fitBody, referencePose } from "../../site/js/human/fit.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { subjectProfile, SUBJECT_MEASURES, percentileProfile } from "../../site/js/human/anthro.js";
import * as P from "../../site/js/human/pose.js";
import REFERENCE from "../../site/js/human/postures/reference.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POP_DIR = path.join(ROOT, "public/api/v1/populations"), DB_PATH = path.join(ROOT, "database/anthro.sqlite");
const HAVE = fs.existsSync(POP_DIR) && fs.existsSync(DB_PATH);
const opt = HAVE ? {} : { skip: "data not present" };
const mm = (x) => x * 1000;
const offsetsOf = (b) => Object.fromEntries(JOINTS.filter((j) => j.parent).map((j) => [j.id, b.joints[j.id].offset]));
function world(b, name = "stand") {
  const kin = new Kinematics(offsetsOf(b)), ref = referencePose(b, name);
  kin.solve(ref.angles, ref.root);
  return { kin, w: (id) => kin.toWorld(b.landmarks[id].joint, b.landmarks[id].offset), j: (id) => kin.toWorld(id, [0, 0, 0]) };
}

// ---------------------------------------------------------------------------------------------------------------- bodies
let _pops, _people;
function populationBodies() { // 528 = 176 populations x P5 / P50 / P95
  if (_pops) return _pops;
  _pops = [];
  for (const c of fs.readdirSync(POP_DIR)) for (const role of fs.readdirSync(path.join(POP_DIR, c))) for (const f of fs.readdirSync(path.join(POP_DIR, c, role))) {
    if (!/^(M|F|both)\.json$/.test(f)) continue;
    const pop = JSON.parse(fs.readFileSync(path.join(POP_DIR, c, role, f), "utf8"));
    for (const pct of [5, 50, 95]) { let prof; try { prof = percentileProfile(pop, { percentile: pct }); } catch { continue; } _pops.push({ tag: `${c}/${role}/${f} P${pct}`, b: fitBody(prof) }); }
  }
  return _pops;
}
function people() { // 600 real people, deterministic
  if (_people) return _people;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const cols = ["subject_key", "dataset", "sex", "branch", ...SUBJECT_MEASURES].map((c) => `"${c}"`).join(", ");
  const rows = db.prepare(`SELECT ${cols} FROM subjects ORDER BY subject_key`).all();
  _people = [];
  for (let i = 0; i < rows.length && _people.length < 600; i += 23) { const prof = subjectProfile(rows[i]); _people.push({ tag: `person ${rows[i].subject_key}`, row: rows[i], prof, b: fitBody(prof) }); }
  return _people;
}
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(POP_DIR, "united-states/army", `${sex}.json`))), { percentile }));
let _six;
function six() { // P5 woman, P50 man, P95 man, 2.0 m man, 1.5 m woman from her stature alone, a heavy real person (the heaviest subject of the four surveys)
  if (_six) return _six;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const cols = ["subject_key", "dataset", "sex", "branch", ...SUBJECT_MEASURES].map((c) => `"${c}"`).join(", ");
  const heavy = db.prepare(`SELECT ${cols} FROM subjects WHERE mass IS NOT NULL AND stature IS NOT NULL ORDER BY mass DESC LIMIT 1`).get();
  return (_six = {
    "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95),
    "2.0 m man": fitBody({ sex: "M", measures: { stature: { value: 2000, unit: "mm" } } }),
    "1.5 m woman (stature only)": fitBody({ sex: "F", measures: { stature: { value: 1500, unit: "mm" } } }),
    "heavy real person": fitBody(subjectProfile(heavy)),
  });
}

// ================================================================================================================ 1. neutral standing geometry
function stance(b) {
  const { w, j } = world(b);
  const k = j("knee_L"), a = j("ankle_L"), h = j("hip_L"), com = b.massInfo.com, heel = w("heel_L"), toe = w("toe_tip_L");
  let lowest = Infinity, feetOff = 0;
  for (const id of Object.keys(b.landmarks)) lowest = Math.min(lowest, w(id).y);
  for (const id of b.contacts.feet) feetOff = Math.max(feetOff, Math.abs(w(id).y));
  return { lean: Math.atan2(k.z - a.z, k.y - a.y) * 180 / Math.PI, kneeAhead: mm(k.z - a.z), hipOverKnee: Math.hypot(h.x - k.x, h.z - k.z), comAhead: mm(com[2] - a.z), comFromHeel: (com[2] - heel.z) / (toe.z - heel.z), lowest, feetOff, heelY: Math.abs(w("heel_sole_L").y), toeY: Math.abs(w("toe_sole_L").y), kneeAnkleY: k.y - a.y, shank: b.d.shank_length, bodyLean: b.stance.shankLeanDeg };
}

test("neutral standing of 528 population bodies and 600 real people: soles on the floor, nothing below it, thigh vertical, centre of mass 20-50 mm in front of the ankle and 33-40 % of the foot from the heel", opt, () => {
  const all = [...populationBodies(), ...people()];
  assert.equal(populationBodies().length, 528);
  assert.equal(people().length, 600);
  for (const { tag, b } of all) {
    const s = stance(b);
    assert.ok(s.lowest > -3e-6, `${tag}: a landmark ${mm(s.lowest)} mm below the floor`);
    assert.ok(s.feetOff < 3e-6, `${tag}: a sole contact ${mm(s.feetOff)} mm off the floor`);
    assert.ok(s.heelY < 3e-6 && s.toeY < 3e-6, `${tag}: heel ${mm(s.heelY)} / toe ${mm(s.toeY)} mm above the floor`);
    assert.ok(s.hipOverKnee < 1e-9, `${tag}: thigh not vertical`);
    assert.ok(s.comAhead > 20 && s.comAhead < 50, `${tag}: COM ${s.comAhead.toFixed(1)} mm in front of the ankle`);
    // 40 % is the target of leanLegs; the cap on the shank lean (4.9 degrees, K.leanMaxDeg) stops short of it for 97 % of the bodies: 34 to 40 %, median 37.5 (MODEL.md 7.1)
    assert.ok(s.comFromHeel > 0.33 && s.comFromHeel < 0.4 + 0.005, `${tag}: COM ${(100 * s.comFromHeel).toFixed(1)} % of the foot from the heel`);
    assert.ok(Math.abs(s.lean - s.bodyLean) < 0.05, `${tag}: body.stance.shankLeanDeg ${s.bodyLean} is not the geometry ${s.lean}`);
    assert.ok(Math.abs(s.kneeAnkleY - (b.d.knee_height - b.d.ankle_height)) < 2.5e-3, `${tag}: knee is not knee_height - ankle_height above the ankle`);
    assert.ok(Math.abs(s.kneeAnkleY - (b.d.shank_length)) < 5e-3, `${tag}: shank length ${s.shank} vs ${s.kneeAnkleY}`);
  }
});

test("both feet are mirror images: left and right sole contacts and ankles at the same height, same lean", opt, () => {
  for (const { tag, b } of [...populationBodies().filter((_, i) => i % 7 === 0), ...people().filter((_, i) => i % 9 === 0)]) {
    const { w, j } = world(b);
    for (const id of b.contacts.feet.filter((x) => /_L$/.test(x))) {
      const r = id.replace(/_L$/, "_R");
      assert.ok(Math.abs(w(id).y - w(r).y) < 1e-9 && Math.abs(w(id).z - w(r).z) < 1e-9 && Math.abs(w(id).x + w(r).x) < 1e-9, `${tag}: ${id} / ${r} not mirrored`);
    }
    assert.ok(Math.abs(j("ankle_L").z - j("ankle_R").z) < 1e-9 && Math.abs(j("ankle_L").y - j("ankle_R").y) < 1e-9);
  }
});

// The brief asks for a shank lean of 1 to 5 degrees. The first reconciliation had 4.5 to 7.3 (5.9 for the median man; the 40 % of the foot needs it with a vertical thigh), twice the 3 degrees of
// the literature the model quotes (Di Giulio and Baltzopoulos 2019: the knee 21-26 mm in front of the ankle, 3 degrees of a 0.45 m shank). Fixed by capping the lean (K.leanMaxDeg = 4.9; MODEL.md 4.1, 7.1).
test("the shank of the neutral pose leans 1 to 5 degrees (Di Giulio and Baltzopoulos 2019: 3 to 4 degrees for the leg; the model keeps the thigh vertical and caps the shank at 4.9)", opt, () => {
  const bad = [];
  for (const { tag, b } of [...populationBodies(), ...people()]) { const s = stance(b); if (s.lean < 1 || s.lean > 5) bad.push(`${tag}: ${s.lean.toFixed(2)} deg`); }
  assert.equal(bad.length, 0, `${bad.length} of 1128 outside 1-5 degrees, e.g. ${bad.slice(0, 3).join("; ")}`);
});

test("the lean is not a free parameter of the closure: sitting height of real people, computed independently of the fit report, is exact in the ISO 7250 seated posture", opt, () => {
  let n = 0;
  for (const { tag, prof, b } of people()) {
    const sh = prof.measures.sitting_height;
    if (!sh || !(b.d.hip_to_seat > 0.0101 && b.d.hip_to_seat < 0.1799)) continue;
    const { w, j } = world(b, "seat");
    const seat = Math.min(...b.contacts.seat.map((id) => w(id).y));
    const err = mm(w("vertex").y - seat) - sh.value;
    assert.ok(Math.abs(err) < 0.5, `${tag}: seated height differs by ${err.toFixed(2)} mm from the measured sitting height`);
    // feet flat, thighs horizontal, the seated shank is the neutral shank
    for (const id of b.contacts.feet) assert.ok(Math.abs(w(id).y) < 3e-6, `${tag}: seated ${id} y ${w(id).y}`);
    for (const s of ["L", "R"]) {
      assert.ok(Math.abs(j(`hip_${s}`).y - j(`knee_${s}`).y) < 1e-9, `${tag}: thigh ${s} not horizontal`);
      assert.ok(Math.abs((j(`knee_${s}`).z - j(`ankle_${s}`).z) - b.stance.ankleBehindKneeM) < 1e-6, `${tag}: seated shank is not the neutral shank`);
    }
    n++;
  }
  assert.ok(n > 100, `only ${n} people had a sitting height`);
});

// ================================================================================================================ 2. balance rule
const base = (over) => ({ id: "test-posture", name: "Test posture", category: "Reference", tags: ["test"], description: "A posture written for the checks.", source: "illustrative", support: "feet", grips: { L: "relaxed", R: "relaxed" }, ...over });
const tilt = (deg) => ({ root: { flex: deg }, joints: { ankle_LR: [deg] } }); // whole body tilted about the ankles, soles flat
const POSTURES = {
  neutral: {},
  tiptoe: { joints: { ankle_LR: [-45], mtp_LR: [45] } },
  back5: tilt(-5), back8: tilt(-8), back15: tilt(-15),
  fwd5: tilt(5), fwd10: tilt(10), fwd15: tilt(15), fwd40: tilt(40),
  squatArmsFwd: { joints: { hip_LR: [120], knee_LR: [145], ankle_LR: [30], shoulder_LR: [90] } },
  stoop45: { root: { flex: 45 }, joints: { hip_LR: [45], shoulder_LR: [60] } },
  stoopRound: { joints: { hip_LR: [30] }, spine: { lumbar: [30], thoracic: [20] } },
};
function verdict(b, name, load) {
  const p = base({ ...POSTURES[name], ...(load ? { hints: { load: { mass: load } } } : {}) });
  const r = P.validatePosture(b, p);
  return { fall: r.errors.some((e) => /centre of mass is \d+ mm outside the support polygon/.test(e)), margin: r.metrics.balanceMargin, errors: r.errors };
}

test("balance rule, six bodies x posture x 0 / 15 kg: neutral stands comfortably, tiptoe stands, 40 degrees forward falls, deep squat with the arms forward stands, loaded stoop falls", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    for (const load of [0, 15]) {
      const v = (p) => verdict(b, p, load);
      const n = v("neutral");
      assert.ok(!n.fall && n.margin > 0.05, `${name} ${load} kg: neutral margin ${mm(n.margin)} mm`);
      assert.ok(!v("tiptoe").fall && v("tiptoe").margin > -0.03, `${name} ${load} kg: tiptoe ${mm(v("tiptoe").margin)}`);
      assert.ok(v("fwd40").fall && v("fwd40").margin < -0.3, `${name} ${load} kg: 40 degrees forward at the ankles ${mm(v("fwd40").margin)} mm`);
      assert.ok(v("fwd15").fall, `${name} ${load} kg: 15 degrees forward must fall (${mm(v("fwd15").margin)})`);
      assert.ok(!v("fwd5").fall && v("fwd5").margin > 0.03, `${name} ${load} kg: 5 degrees forward ${mm(v("fwd5").margin)}`);
      assert.ok(!v("back5").fall, `${name} ${load} kg: 5 degrees back ${mm(v("back5").margin)}`);
      assert.ok(v("back15").fall, `${name} ${load} kg: 15 degrees back must fall`);
      assert.ok(!v("squatArmsFwd").fall, `${name} ${load} kg: deep squat, arms forward ${mm(v("squatArmsFwd").margin)} mm`);
      assert.ok(v("stoopRound").fall, `${name} ${load} kg: stoop with the legs straight and the spine rounded 50 degrees falls (${mm(v("stoopRound").margin)})`);
    }
    // a 15 kg weight held in front of the body moves the stoop outward, never inward
    assert.ok(verdict(b, "stoop45", 15).margin < verdict(b, "stoop45", 0).margin - 0.03, `${name}: 15 kg does not hurt the stoop`);
    assert.ok(verdict(b, "stoop45", 15).fall, `${name}: stoop 45 with 15 kg held`);
  }
});

test("balance: the margin is unimodal in the tilt about the ankles: it rises a little from the neutral pose as the centre of mass leaves the heel edge, then falls monotonically forward to 40 degrees; backward it falls monotonically to 20 degrees", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const m = (d) => P.validatePosture(b, base(tilt(d))).metrics.balanceMargin;
    let prev = m(0), peaked = false;
    for (let d = 2.5; d <= 40; d += 2.5) {
      const v = m(d);
      if (v < prev - 1e-9) peaked = true; else assert.ok(!peaked, `${name}: margin rises again at ${d} degrees forward (${mm(prev)} -> ${mm(v)})`);
      prev = v;
    }
    assert.ok(peaked && m(40) < -0.3);
    prev = m(0);
    for (let d = -2.5; d >= -20; d -= 2.5) { const v = m(d); assert.ok(v < prev, `${name}: margin does not fall at ${d} degrees back (${mm(prev)} -> ${mm(v)})`); prev = v; }
  }
});

test("balance: the neutral margin and the edges are the same for every one of the 528 population bodies (neutral stands with 50 mm or more; 8 degrees back and 15 forward fall; 3 back and 5 forward stand)", opt, () => {
  const bad = [];
  for (const { tag, b } of populationBodies()) {
    const m = (p) => P.validatePosture(b, base(p));
    const n = m({}), fall = (r) => r.errors.some((e) => /centre of mass is \d+ mm outside/.test(e));
    if (fall(n) || n.metrics.balanceMargin < 0.05) bad.push(`${tag}: neutral ${mm(n.metrics.balanceMargin).toFixed(0)}`);
    if (fall(m(tilt(8)))) bad.push(`${tag}: 8 forward falls`); // 8 forward stands (limit 11.5)
    if (!fall(m(tilt(-9)))) bad.push(`${tag}: 9 back stands`);
    if (!fall(m(tilt(16)))) bad.push(`${tag}: 16 forward stands`);
    if (fall(m(tilt(-3))) || fall(m(tilt(5)))) bad.push(`${tag}: 3 back / 5 forward falls`);
  }
  assert.equal(bad.length, 0, `${bad.length} bodies: ${bad.slice(0, 6).join(" | ")}`);
});

// ================================================================================================================ 3. guards the reconciliation touched
test("the validator still rejects gross errors after the proxies learned from the whole Reference group (arm through the trunk, leg through leg, floating feet, sunk feet, 40 degrees forward)", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const bad = (p, re) => { const r = P.validatePosture(b, base(p)); assert.ok(r.errors.some((e) => re.test(e)), `${name}: ${JSON.stringify(p)} -> ${r.errors.join(" | ")}`); };
    bad({ joints: { shoulder_R: [0, -50, 0] } }, /upper_arm_R and trunk overlap/);
    bad({ joints: { hip_LR: [20, -30, 0] } }, /overlap/);
    bad({ support: "seat+feet", joints: { hip_LR: [90], knee_LR: [60] } }, /contact set "feet": its lowest point is \d+ mm above the floor/);
    bad({ support: "seat+feet", joints: { hip_LR: [90], knee_LR: [100] } }, /contact set "feet": its lowest point is \d+ mm below the floor/);
    bad(tilt(40), /centre of mass is \d+ mm outside/);
  }
});

test("every posture of the Reference group is valid on the six bodies and on every 4th population body (the group the proxies learn from)", opt, () => {
  const bodies = [...Object.entries(six()), ...populationBodies().filter((_, i) => i % 4 === 0).map(({ tag, b }) => [tag, b])];
  const bad = [];
  for (const [name, b] of bodies) for (const p of REFERENCE) { const r = P.validatePosture(b, p, { library: REFERENCE }); if (!r.ok) bad.push(`${name} | ${p.id}: ${r.errors[0]}`); }
  assert.equal(bad.length, 0, `${bad.length} failures, e.g. ${bad.slice(0, 4).join(" || ")}`);
});

// ================================================================================================================ 4. second independent pass (round 2 of the check)
// Nothing below reads the numbers of the reconciled tests either. What is new here: random profiles (not the surveys), the lean read from the rig and the skin instead of from fit.js,
// the tilt posture checked against a rigid rotation about the ankle, the skin of the ankle and the foot checked for holes, the loads.
import * as THREE from "three";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";

function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const manual = (sex, stature, mass, extra = {}) => ({ id: "r", label: "r", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: stature, unit: "mm" }, mass: { value: mass, unit: "kg" }, ...extra } });

test("random profiles (400: stature 1.30-2.20 m, BMI 15-55, both sexes, with and without a foot length / a sitting height): the neutral stance is quiet standing, the soles are level on the floor", () => {
  const rnd = lcg(20261019), U = (a, c) => a + (c - a) * rnd(), bad = [];
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const sex = rnd() < 0.5 ? "M" : "F", st = U(1300, 2200), mass = U(15, 55) * (st / 1000) ** 2, extra = {};
    if (rnd() < 0.5) extra.foot_length = { value: st * U(0.125, 0.18), unit: "mm" };
    if (rnd() < 0.3) extra.sitting_height = { value: st * U(0.5, 0.55), unit: "mm" };
    const b = fitBody(manual(sex, st, mass, extra)), s = stance(b), tag = `${sex} ${st.toFixed(0)} mm ${mass.toFixed(0)} kg ${JSON.stringify(Object.keys(extra))}`;
    n++;
    if (s.lean < 1 || s.lean > 5) bad.push(`${tag}: lean ${s.lean.toFixed(2)}`);
    if (s.comAhead < 20 || s.comAhead > 50) bad.push(`${tag}: COM ${s.comAhead.toFixed(1)} mm in front of the ankle`);
    if (s.comFromHeel < 0.33 || s.comFromHeel > 0.405) bad.push(`${tag}: COM ${(100 * s.comFromHeel).toFixed(1)} % of the foot`);
    if (s.lowest < -3e-6 || s.feetOff > 3e-6 || s.heelY > 3e-6 || s.toeY > 3e-6) bad.push(`${tag}: floor ${mm(s.lowest)} / ${mm(s.feetOff)}`);
    if (s.hipOverKnee > 1e-9) bad.push(`${tag}: thigh not vertical`);
    const v = verdict(b, "neutral", 0);
    if (v.fall || v.margin < 0.045) bad.push(`${tag}: neutral margin ${mm(v.margin).toFixed(0)} mm`);
    if (!verdict(b, "fwd40", 0).fall) bad.push(`${tag}: 40 degrees forward stands`);
  }
  assert.equal(n, 400);
  assert.equal(bad.length, 0, `${bad.length} of 400: ${bad.slice(0, 5).join(" | ")}`);
});

test("the stance of the rig is the stance of the fit: rig.centerOfMass() is the mass-weighted centre of fit.js and of pose.js, the ankle of the rig is behind the knee by body.stance, the soles of the rig are on the floor", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const rig = buildRig(b, { skeleton: false, quality: "low" });
    const com = rig.centerOfMass().point, kin = P.solvePose(b, P.neutralPose(), { y: b.joints.pelvis.offset[1] }), pc = P.centerOfMass(b, P.neutralPose(), { y: b.joints.pelvis.offset[1] }).point;
    assert.ok(Math.hypot(com.x - pc.x, com.y - pc.y, com.z - pc.z) < 1e-9, `${name}: rig COM ${com.toArray()} vs pose COM ${pc.toArray()}`);
    assert.ok(Math.abs(com.z - b.massInfo.com[2]) < 1e-5 && Math.abs(com.y - b.massInfo.com[1]) < 1e-5, `${name}: rig COM ${com.toArray()} vs fit ${b.massInfo.com}`);
    const k = rig.jointWorld("knee_L"), a = rig.jointWorld("ankle_L");
    assert.ok(Math.abs((k.z - a.z) - b.stance.ankleBehindKneeM) < 1e-6, `${name}: rig lean`);
    assert.ok(Math.abs(kin.position("ankle_L").z - a.z) < 1e-9);
    const soles = rig.contactPoints("feet").map((p) => p.y);
    assert.ok(Math.max(...soles) < 3e-6 && Math.min(...soles) > -3e-6, `${name}: soles ${Math.min(...soles)}..${Math.max(...soles)}`);
    assert.ok(Math.abs(rig.lowestY()) < 3e-6, `${name}: lowestY ${rig.lowestY()}`);
    // the balance margin, recomputed here: distance from the COM to the nearest edge of the convex hull of the sole contacts (a rectangle-ish polygon: heel, ball, toe of both feet)
    const pts = rig.contactPoints("feet").map((p) => [p.x, p.z]);
    const hull = hullOf(pts); let min = Infinity;
    for (let i = 0; i < hull.length; i++) { const A = hull[i], B = hull[(i + 1) % hull.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]); min = Math.min(min, ((B[0] - A[0]) * (com.z - A[1]) - (B[1] - A[1]) * (com.x - A[0])) / L); }
    const r = P.validatePosture(b, base({}));
    assert.ok(Math.abs(min - r.metrics.balanceMargin) < 1e-9, `${name}: margin ${min} here vs ${r.metrics.balanceMargin} in pose.js`);
    rig.dispose();
  }
});
function hullOf(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

test("the tilt posture used for the balance verdicts is a rigid rotation of the body about the ankle axis: the centre of mass moves by R(angle) about the ankle, whatever the body", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const at = (d) => {
      const pose = P.expandPosture(base(tilt(d))), root = P.placePose(b, { root: pose.root, angles: pose.angles }, { support: "feet" });
      const kin = P.solvePose(b, { root: pose.root, angles: pose.angles }, root), com = P.centerOfMass(b, { root: pose.root, angles: pose.angles }, root).point, an = kin.position("ankle_L");
      return { dz: com.z - an.z, dy: com.y - an.y, sole: Math.min(...b.contacts.feet.map((id) => P.landmarkPosition(b, { root: pose.root, angles: pose.angles }, root, id).y)) };
    };
    const n = at(0);
    for (const d of [-10, -5, 5, 10, 20, 40]) {
      const t = d * Math.PI / 180, o = at(d);
      const ez = n.dz * Math.cos(t) + n.dy * Math.sin(t), ey = -n.dz * Math.sin(t) + n.dy * Math.cos(t); // + tilt = forward = toward +z
      assert.ok(Math.abs(o.dz - ez) < 2e-3 && Math.abs(o.dy - ey) < 2e-3, `${name} ${d} deg: COM relative to the ankle (${mm(o.dz).toFixed(1)}, ${mm(o.dy).toFixed(1)}) mm vs a rotation about the ankle (${mm(ez).toFixed(1)}, ${mm(ey).toFixed(1)}) mm`);
      assert.ok(Math.abs(o.sole) < 5e-3, `${name} ${d} deg: lowest sole ${mm(o.sole)} mm`);
    }
  }
});

test("loads: a weight held in front never helps a forward stoop, and helps a body leaning back with the arms forward; the margin is monotone in the mass; 15 kg held at the sides change standing by less than 15 mm", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const m = (pn, kg) => verdict(b, pn, kg).margin;
    let prev = Infinity;
    for (const kg of [0, 5, 10, 15, 25, 40]) { const v = m("stoop45", kg); assert.ok(v < prev + 1e-12, `${name}: stoop 45 margin rises with the load at ${kg} kg`); prev = v; }
    prev = -Infinity;
    const backArms = (kg) => P.validatePosture(b, base({ ...tilt(-8), joints: { ...tilt(-8).joints, shoulder_LR: [90] }, ...(kg ? { hints: { load: { mass: kg } } } : {}) })).metrics;
    for (const kg of [0, 5, 10, 15, 25]) { const v = backArms(kg).com[2]; assert.ok(v > prev - 1e-12, `${name}: 8 back, arms forward, the centre of mass moves back with the load at ${kg} kg`); prev = v; } // (the margin itself is the distance to the nearest edge: it peaks in the middle of the foot)
    assert.ok(backArms(15).balanceMargin > backArms(0).balanceMargin, `${name}: 15 kg in the outstretched hands of a body leaning back 8 degrees`);
    assert.ok(Math.abs(m("neutral", 15) - m("neutral", 0)) < 0.015, `${name}: 15 kg at the sides move standing by ${mm(m("neutral", 15) - m("neutral", 0))} mm`);
    // arms forward in a deep squat: the held weight is a counterweight, the squat stands better with it
    assert.ok(m("squatArmsFwd", 15) > m("squatArmsFwd", 0), `${name}: 15 kg in the outstretched hands of a deep squat`);
    assert.ok(!verdict(b, "squatArmsFwd", 15).fall && m("squatArmsFwd", 15) > 0.03, `${name}: loaded squat margin ${mm(m("squatArmsFwd", 15))}`);
  }
});

test("hands-free deep squat: arms forward is better than arms down (more stable: the arms are a counterweight), and the verdicts do not depend on which hand grip is used", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const down = P.validatePosture(b, base({ joints: { hip_LR: [120], knee_LR: [145], ankle_LR: [30] } })).metrics.balanceMargin;
    const fwd = P.validatePosture(b, base(POSTURES.squatArmsFwd)).metrics.balanceMargin;
    assert.ok(fwd > down + 0.015, `${name}: arms forward ${mm(fwd)} vs arms down ${mm(down)} mm`);
    for (const grip of ["fist", "open", "relaxed"]) {
      const g = P.validatePosture(b, { ...base(POSTURES.squatArmsFwd), grips: { L: grip, R: grip } });
      assert.ok(Math.abs(g.metrics.balanceMargin - fwd) < 0.006, `${name}: grip ${grip} moves the margin by ${mm(g.metrics.balanceMargin - fwd)} mm`);
    }
  }
});

// the skin around the ankle. The shank and the foot are two closed parts that overlap; the lean must not open a hole between them. Rays are shot through the ankle axis from the side, the front and the
// back, every 4 mm of height from 16 mm above the floor (the sole is rounded below that) to 12 cm above the ankle: each ray must meet the skin of the leg (a hole in the union of the two parts would let it through), and meet it an even number of
// times (parity: an odd count means an open surface).
function skinTriangles(body) {
  const bones = new Map(); // rest bones as rig.js builds them
  for (const j of JOINTS) { const o = new THREE.Bone(); o.name = j.id; const p = body.positions[j.id]; if (j.parent) { const q = body.positions[j.parent]; o.position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]); bones.get(j.parent).add(o); } else o.position.set(...p); bones.set(j.id, o); }
  bones.get("pelvis").updateMatrixWorld(true);
  const skin = buildSkin(body, bones, { eyes: false, quality: "high" }), g = skin.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array;
  return { pos, idx, skin };
}
function hitsAlong(pos, idx, o, d, box) { // all intersections of the ray o + t d (t > 0) with triangles whose bounding box meets `box`
  const hits = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ya = pos[a + 1], yb = pos[b + 1], yc = pos[c + 1];
    if (Math.max(ya, yb, yc) < box.y0 || Math.min(ya, yb, yc) > box.y1) continue;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-14) continue;
    const s = [o[0] - pos[a], o[1] - pos[a + 1], o[2] - pos[a + 2]], u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (tt > 0) hits.push(tt);
  }
  return hits;
}
test("skin at the ankle and the foot: no hole between the shank and the foot, every ray through the ankle region crosses the surface an even number of times", opt, () => {
  for (const [name, b] of Object.entries(six())) {
    const { pos, idx, skin } = skinTriangles(b), an = b.positions.ankle_L;
    const holes = [];
    for (let y = 0.016; y < an[1] + 0.12; y += 0.004) {
      for (const [label, o, d] of [["lateral", [1.5, y, an[2]], [-1, 0, 0]], ["front", [an[0], y, 1.5], [0, 0, -1]], ["back", [an[0], y, -1.5], [0, 0, 1]], ["front-lateral", [an[0] + 1, y, an[2] + 1], [-Math.SQRT1_2, 0, -Math.SQRT1_2]]]) {
        // the leg is the first thing met along x or z; count the hits in a window of 25 cm around the ankle axis (the other leg is 20 cm or more away on the other side)
        const hs = hitsAlong(pos, idx, o, d, { y0: y - 1e-4, y1: y + 1e-4 });
        const near = hs.filter((t) => { const px = o[0] + d[0] * t, pz = o[2] + d[2] * t; return Math.abs(px - an[0]) < 0.12 && Math.abs(pz - an[2]) < 0.4 && (label !== "lateral" || px > 0); });
        if (near.length === 0) holes.push(`${label} y ${mm(y).toFixed(0)} mm: no skin`);
        else if (near.length % 2 !== 0 && label !== "front-lateral") holes.push(`${label} y ${mm(y).toFixed(0)} mm: ${near.length} crossings (open surface)`);
      }
    }
    skin.dispose();
    assert.equal(holes.length, 0, `${name}: ${holes.length} problems, e.g. ${holes.slice(0, 4).join("; ")}`);
  }
});

// ================================================================================================================ 5. open defect found by the check
// postures.test.mjs ("every posture of the library passes validatePosture on 6 bodies"), postures-sitting-vehicle.test.mjs ("every posture passes validatePosture on the three bodies") and the last loop
// of pose.adversarial2.test.mjs ("library: frozen all the way down ...", val(MAN, p) for every posture) are RED at HEAD since the shank lean was capped at 4.9 degrees: sit-seiza (toes 7.1 / 7.7 mm
// below the floor on the P50 / P95 man, limit 5 mm), sit-legs-extended and veh-pedal-brake* / veh-pedal-clutch / veh-gear-shift (heels 15.4 to 21 mm above the floor, limit 15 mm) on the P50 woman.
// The reconciliation turned the same loop of pose.adversarial.test.mjs into a todo but left these three red. Todo here until the posture authors retune the angles (or declare hints.contactTolerance).
test("OPEN (posture authors): every posture of the library validates on the six bodies", { todo: "sit-seiza, sit-legs-extended, veh-pedal-*, veh-gear-shift miss their floor contacts by 1 to 8 mm since the lean cap of 4.9 degrees (POSE.md 'Balance and the stance')", ...opt }, () => {
  const bad = [];
  for (const [name, b] of Object.entries(six())) for (const p of POSTURES_ALL) { const r = P.validatePosture(b, p, { library: POSTURES_ALL }); if (!r.ok) bad.push(`${name} | ${p.id}: ${r.errors[0]}`); }
  assert.equal(bad.length, 0, `${bad.length} failures, e.g. ${bad.slice(0, 4).join(" || ")}`);
});
import { POSTURES as POSTURES_ALL } from "../../site/js/human/postures.js";
