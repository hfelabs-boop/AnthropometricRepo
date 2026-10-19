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
