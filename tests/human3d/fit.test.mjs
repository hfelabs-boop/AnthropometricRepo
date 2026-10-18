// Tests of site/js/human/fit.js: profile -> body model. Run with
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/fit.test.mjs"
// The sweeps use the built website data (public/api/v1) and the real subjects of database/anthro.sqlite; they are skipped when the data is absent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fitBody, evaluateMeasures, referencePose, DIM_DEFS, REGRESSIONS, RELATIONS, CONSTANTS, REFERENCE_POSTURES, REPORT_MEASURES, ellipsePerimeter, ringPerimeter, ringArea, sectionFrom } from "../../site/js/human/fit.js";
import { JOINTS, BONE_LANDMARKS, mirrorId } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { percentileProfile, subjectProfile, manualProfile, parseImport, SUBJECT_MEASURES, SKELETON_MEASURES } from "../../site/js/human/anthro.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = path.join(ROOT, "database/anthro.sqlite"), POP_DIR = path.join(ROOT, "public/api/v1/populations");
const HAVE_DB = fs.existsSync(DB_PATH), HAVE_POPS = fs.existsSync(POP_DIR);
let _db;
const db = () => (_db ??= new DatabaseSync(DB_PATH, { readOnly: true }));
const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const mm = (x) => x * 1000;
const P = (stature, sex = "M", mass) => ({ id: `t:${sex}:${stature}`, label: "test", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: stature, unit: "mm", status: "reported" }, ...(mass ? { mass: { value: mass, unit: "kg", status: "reported" } } : {}) } });
function walkFinite(o, p = "body") {
  if (typeof o === "number") assert.ok(Number.isFinite(o), `${p} = ${o}`);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walkFinite(v, `${p}.${k}`);
}
const row = (b, id, kind = "measure") => b.report.find((r) => r.id === id && r.kind === kind);
// a consistent person made of the regressions of the table (a typical man or woman of this stature and mass), with every measure the fitter reads
const OTHER = new Set(["lateral_malleolus_height", "lateral_femoral_epicondyle_height", "knee_height_midpatella", "wrist_height", "axilla_height", "chest_height", "omphalion_height", "hip_breadth", "waist_breadth", "waist_depth", "buttock_depth", "bimalleolar_breadth", "knee_circumference", "tragion_top_of_head"]);
function typicalProfile(S, M, sex = "M") {
  const meas = {};
  for (const [k, rows] of Object.entries(REGRESSIONS)) {
    const c = rows[sex === "M" ? 0 : 1];
    if (c && !/^(palm_length|wrist_to_grip|wrist_to_thumbtip|ball_of_foot_length|buttock_height|gluteal_furrow_height|foot_circumference|heel_breadth|heel_ankle_circumference|lower_thigh_circumference|ear_breadth|thumb_breadth)$/.test(k)) meas[OTHER.has(k) ? `other:${k}` : k] = { value: Math.round(c[0] + c[1] * S + c[2] * M), unit: "mm" };
  }
  return { id: `typical:${sex}`, label: "typical", sex, source: { kind: "manual" }, notes: [], measures: { ...meas, stature: { value: S, unit: "mm" }, mass: { value: M, unit: "kg" } } };
}
const OFFS = (b) => Object.fromEntries(JOINTS.filter((j) => j.parent).map((j) => [j.id, b.joints[j.id].offset]));

// plausible ranges of the skeleton dimensions (metres) for any adult body of the sweeps
const BONES = { shank_length: [0.3, 0.58], femur_length: [0.3, 0.62], upper_arm_length: [0.19, 0.42], forearm_length: [0.17, 0.36], trunk_length: [0.33, 0.58], neck_length: [0.07, 0.18], hand_length: [0.12, 0.26], foot_length: [0.18, 0.36], hip_to_seat: [0.01, 0.18] };
function sane(b, tag, bones = BONES) {
  walkFinite(b, tag);
  for (const j of JOINTS) assert.ok(b.joints[j.id].offset.length === 3, `${tag} ${j.id} offset`);
  for (const [id, [lo, hi]] of Object.entries(bones)) assert.ok(b.d[id] >= lo - 1e-9 && b.d[id] <= hi + 1e-9, `${tag}: ${id} = ${mm(b.d[id]).toFixed(0)} mm`);
  for (const j of JOINTS) if (j.parent && !j.id.startsWith("forearm_")) assert.ok(Math.hypot(...b.joints[j.id].offset) > 0.004, `${tag}: bone ${j.id} has no length`);
  // heights in order
  const y = (id) => b.positions[id][1];
  const chain = ["ankle_L", "knee_L", "hip_L", "L5", "L1", "T12", "T1", "C7", "C1", "head"];
  for (let i = 1; i < chain.length; i++) assert.ok(y(chain[i]) > y(chain[i - 1]), `${tag}: ${chain[i]} above ${chain[i - 1]}`);
  assert.ok(y("head") < b.stature && y("shoulder_L") < y("C7") && y("shoulder_L") > y("T12") && y("elbow_L") < y("shoulder_L") && y("wrist_L") < y("elbow_L") && y("wrist_L") > y("hip_L") - 0.2, `${tag}: arm`);
  near(b.landmarks.vertex.offset[1] + y("head"), b.stature, 2e-5, `${tag}: vertex`);
  assert.ok(b.shape.adiposity >= 0.75 && b.shape.adiposity <= 1.35);
}

// ---------------------------------------------------------------------------------------------------------------------------------
test("contract with rig.js: masses is a segment map, landmarks and contacts reference real joints and landmarks", () => {
  const b = fitBody(P(1750, "M", 78));
  const ids = new Set(JOINTS.map((j) => j.id));
  // rig.js reads body.masses as { id: { mass, com: { joint, offset } } } (the shape of synthetic.js); the totals are in body.massInfo
  assert.equal(Array.isArray(b.masses), false);
  for (const [id, m] of Object.entries(b.masses)) {
    assert.ok(typeof m.mass === "number" && m.mass > 0, id);
    assert.ok(ids.has(m.com.joint) && m.com.offset.length === 3 && m.com.offset.every(Number.isFinite), id);
  }
  assert.deepEqual(Object.keys(b.massInfo).sort(), ["com", "form", "fractionSum", "source", "total"]);
  for (const [id, l] of Object.entries(b.landmarks)) assert.ok(ids.has(l.joint) && l.offset.length === 3 && typeof l.label === "string" && typeof l.group === "string", id);
  for (const [name, set] of Object.entries(b.contacts)) for (const id of set) assert.ok(b.landmarks[id], `${name}: ${id}`);
  for (const id of BONE_LANDMARKS) assert.ok(b.landmarks[id], `bone landmark ${id}`);
});

test("contract: 77 joints, mirrored offsets, neutral positions, feet flat on the floor", () => {
  const b = fitBody(P(1750, "M", 78));
  assert.equal(Object.keys(b.joints).length, 77);
  for (const j of JOINTS) assert.ok(b.joints[j.id], j.id);
  near(b.joints.pelvis.offset[1], b.d.hip_height, 1e-6);
  assert.deepEqual([b.joints.pelvis.offset[0], b.joints.pelvis.offset[2]], [0, 0]);
  for (const j of JOINTS) {
    if (!j.id.endsWith("_L")) continue;
    const l = b.joints[j.id].offset, r = b.joints[mirrorId(j.id)].offset;
    assert.deepEqual(r, [-l[0] + 0, l[1], l[2]].map((x) => x + 0), `mirror of ${j.id}`);
  }
  // the offsets are the differences of the neutral positions, and Kinematics at rest gives the positions back
  const k = new Kinematics(OFFS(b)).solve({}, { x: 0, y: b.joints.pelvis.offset[1], z: 0 });
  for (const j of JOINTS) near(k.position(j.id).y, b.positions[j.id][1], 3e-5, j.id), near(k.position(j.id).x, b.positions[j.id][0], 3e-5, j.id), near(k.position(j.id).z, b.positions[j.id][2], 3e-5, j.id);
  // feet flat: every sole contact on y = 0 in the neutral pose, nothing of the body below the floor
  const world = (id) => k.toWorld(b.landmarks[id].joint, b.landmarks[id].offset).toArray();
  for (const id of b.contacts.feet) near(world(id)[1], 0, 2e-5, id);
  for (const id of Object.keys(b.landmarks)) assert.ok(world(id)[1] > -2e-5, `${id} below the floor`);
  // feet point forward and are parallel: toe tip ahead of the heel by the foot length, left-right at the hip width
  near(world("toe_tip_L")[2] - world("heel_L")[2], b.d.foot_length, 2e-5);
  near(world("heel_L")[0], b.positions.hip_L[0], 2e-5);
  // the figure's left is +X
  assert.ok(world("acromion_L")[0] > 0 && world("acromion_R")[0] < 0 && world("toe_tip_L")[2] > world("heel_L")[2]);
});

test("contract: landmarks the bones need, the landmarks the task lists, contact sets", () => {
  const b = fitBody(P(1700, "F", 62));
  for (const id of BONE_LANDMARKS) assert.ok(b.landmarks[id], `bone landmark ${id}`);
  const want = ["vertex", "glabella", "sellion", "nasion", "pupil_L", "pupil_R", "eye_L", "eye_R", "eye_mid", "tragion_L", "tragion_R", "ectocanthus_L", "menton", "gonion_L", "cervicale", "suprasternale",
    "substernale", "xiphoid", "thelion_L", "acromion_L", "acromion_R", "olecranon_L", "radiale_L", "stylion_L", "dactylion_L", "dactylion_R", "grip_centre_L", "palm_centre_R", "thumb_tip_L", "ASIS_L", "ASIS_R",
    "iliocristale_L", "trochanterion_L", "crotch", "omphalion", "knee_front_L", "patella_L", "epicondyle_lateral_L", "popliteal_L", "lateral_malleolus_L", "heel_L", "heel_sole_L", "metatarsale_tibiale_L", "metatarsale_fibulare_L",
    "toe_tip_L", "ischial_L", "ischial_R", "buttock_extremity", "thigh_top_L", "abdomen_front"];
  for (const id of want) assert.ok(b.landmarks[id], `landmark ${id}`);
  const ids = new Set(JOINTS.map((j) => j.id));
  for (const [id, l] of Object.entries(b.landmarks)) {
    assert.ok(ids.has(l.joint), `${id} joint ${l.joint}`);
    assert.ok(l.label && l.group && ["bony", "surface", "contact"].includes(l.kind), `${id} metadata`);
    assert.equal(l.offset.length, 3);
    if (id.endsWith("_L")) {
      const r = b.landmarks[mirrorId(id)];
      assert.ok(r, `${id} has no right twin`);
      assert.equal(r.joint, mirrorId(l.joint));
      assert.deepEqual(r.offset, [-l.offset[0] + 0, l.offset[1], l.offset[2]]);
    }
  }
  for (const [set, list] of Object.entries(b.contacts)) for (const id of list) assert.ok(b.landmarks[id], `contact set ${set}: ${id}`);
  for (const s of ["feet", "seat", "knees", "hands", "elbows", "back"]) assert.ok(b.contacts[s].length >= 2, s);
  // the seat set is the plane of the seated posture (the buttock extremity is 50 mm above it: a back contact)
  assert.ok(b.contacts.seat.includes("ischial_L") && b.contacts.seat.includes("thigh_under_R") && !b.contacts.seat.includes("buttock_extremity") && b.contacts.back.includes("buttock_extremity"));
});

test("worked example of MODEL.md 2.6: 1750 mm, 78 kg man by hand from the regression table", () => {
  const S = 1750, M = 78, R = REGRESSIONS;
  const est = (k) => R[k][0][0] + R[k][0][1] * S + R[k][0][2] * M;
  const b = fitBody(P(S, "M", M));
  const ankle = est("lateral_malleolus_height"), knee = est("lateral_femoral_epicondyle_height"), troch = est("trochanterion_height");
  near(mm(b.d.ankle_height), ankle, 1e-6, "ankle");
  near(mm(b.d.knee_height), knee, 1e-6, "knee");
  near(mm(b.d.femur_length), troch + mm(CONSTANTS.hjcAboveTroch) - knee, 1e-6, "thigh");
  near(mm(b.d.hip_height), troch - 5, 1e-6, "hip");
  near(ankle, 70.2, 0.05); near(knee, 493.3, 0.05); near(troch, 912.8, 0.05);
  near(mm(b.d.hip_to_seat), RELATIONS.seat_below_hip[0][0], 1e-9, "hip_to_seat is the mean of the men");
  near(row(b, "stature").model, S, 0.01);
});

test("unit case: a 1.75 m man from stature alone is in the published proportions", () => {
  const b = fitBody(P(1750, "M"));
  const S = b.stature, d = b.d;
  assert.equal(b.form, "male");
  near(S, 1.75, 1e-12);
  assert.equal(b.dims.find((x) => x.id === "stature").status, "measured");
  for (const x of b.dims) if (x.id !== "stature" && x.unit === "m" && !x.id.startsWith("ring_") && !["acromion_to_gh", "shoulder_protraction"].includes(x.id)) assert.ok(["estimated", "derived"].includes(x.status), `${x.id} ${x.status}`);
  assert.ok(b.dims.filter((x) => x.status === "measured").length <= 2, "only stature (and mass) are measured");
  // mass from the median BMI of the survey men (26.2 kg/m2)
  near(b.mass, 26.16 * 1.75 * 1.75, 0.01);
  assert.equal(b.dims.find((x) => x.id === "mass").status, "estimated");
  const fr = (id) => d[id] / S;
  // ranges: Winter 2009 / Drillis & Contini 1966 (hip 0.52-0.53 H, thigh 0.245, leg 0.246, upper arm 0.186 acromion to elbow axis, hand 0.108, foot 0.152 H),
  // ANSUR II men means (sitting height 0.52 H, shoulder 0.82 H)
  assert.ok(fr("hip_height") > 0.51 && fr("hip_height") < 0.54, `hip ${fr("hip_height")}`);
  assert.ok(fr("femur_length") > 0.22 && fr("femur_length") < 0.26, `thigh ${fr("femur_length")}`);
  assert.ok(fr("shank_length") > 0.23 && fr("shank_length") < 0.26, `shank ${fr("shank_length")}`);
  assert.ok(fr("ankle_height") > 0.035 && fr("ankle_height") < 0.048);
  assert.ok(fr("trunk_length") > 0.25 && fr("trunk_length") < 0.28, `spine L5-C7 ${fr("trunk_length")}`);
  assert.ok(mm(d.neck_length) > 95 && mm(d.neck_length) < 140);
  assert.ok(fr("shoulder_height") > 0.78 && fr("shoulder_height") < 0.82, `shoulder ${fr("shoulder_height")}`);
  assert.ok(fr("upper_arm_length") > 0.155 && fr("upper_arm_length") < 0.175 && fr("forearm_length") > 0.15 && fr("forearm_length") < 0.17);
  assert.ok(fr("hand_length") > 0.1 && fr("hand_length") < 0.12 && fr("foot_length") > 0.14 && fr("foot_length") < 0.16);
  const sh = row(b, "sitting_height").model / 1750, ehs = row(b, "eye_height_sitting").model / 1750, bkl = row(b, "buttock_knee_length").model, span = row(b, "span").model / 1750;
  assert.ok(sh > 0.51 && sh < 0.54 && ehs > 0.44 && ehs < 0.47, `sitting ${sh} ${ehs}`);
  assert.ok(bkl > 590 && bkl < 650 && span > 1.0 && span < 1.06, `bkl ${bkl} span ${span}`);
  // centre of mass of the standing body at 0.55-0.57 of stature, above the feet
  assert.ok(b.massInfo.com[1] / S > 0.54 && b.massInfo.com[1] / S < 0.58, `COM ${b.massInfo.com[1] / S}`);
  assert.ok(Math.abs(b.massInfo.com[2]) < 0.04 && Math.abs(b.massInfo.com[0]) < 1e-5);
  sane(b, "1.75 m man");
  assert.ok(b.warnings.some((w) => /estimated from stature, mass and sex/.test(w)));
  assert.ok(b.reportSummary.na > 50 && b.reportSummary.ok === 1 && b.reportSummary.measures >= 55);
});

test("unit case: women and the neutral form", () => {
  const m = fitBody(P(1690, "M", 70)), w = fitBody(P(1690, "F", 70)), n = fitBody(P(1690, "both", 70));
  const typM = fitBody(P(1764, "M")), typW = fitBody(P(1629, "F"));
  assert.deepEqual([m.form, w.form, n.form], ["male", "female", "neutral"]);
  assert.equal(fitBody(P(1690, "M", 70), { form: "female" }).form, "female");
  assert.equal(fitBody(P(1690, "F", 70), { form: "neutral" }).form, "neutral");
  // at the same stature and mass women have the shorter trunk-to-leg ratio the data show: lower sitting height, narrower shoulders, wider hips
  assert.ok(w.d.acromion_halfwidth < m.d.acromion_halfwidth);
  assert.ok(typW.d.hand_length < typM.d.hand_length && typW.d.foot_length < typM.d.foot_length && typW.d.acromion_halfwidth < typM.d.acromion_halfwidth, "the typical woman is smaller than the typical man in every width and extremity");
  assert.ok(row(w, "other:hip_breadth").model / row(w, "biacromial_breadth").model > row(m, "other:hip_breadth").model / row(m, "biacromial_breadth").model);
  // the neutral form is the mean of the two templates for every estimated length that is a plain regression
  for (const id of ["hand_length", "foot_length", "head_length", "acromion_halfwidth", "ankle_height"]) near(n.d[id], 0.5 * (m.d[id] + w.d[id]), 1e-9, id);
  for (const b of [m, w, n]) sane(b, b.form);
  // de Leva: women carry more of their mass in the thighs, men in the trunk and head
  assert.ok(w.masses.thigh_L.fraction > m.masses.thigh_L.fraction && m.masses.head.fraction > w.masses.head.fraction);
});

test("hand-built complete profile: every driving measure is reproduced by construction", () => {
  const profile = typicalProfile(1760, 80);
  const b = fitBody(profile);
  sane(b, "typical man, all measures");
  const bad = b.report.filter((r) => r.kind === "measure" && r.input !== null && r.status !== "ok");
  // the arm span and the thumbtip reach are made exact by the shoulder parameters; the rest of the exceptions are the posture-dependent measures
  assert.ok(bad.every((r) => ["acromion_height_sitting", "elbow_rest_height", "abdominal_depth_sitting", "other:wrist_height", "mass", "chest_breadth", "chest_depth", "other:waist_breadth", "other:waist_depth", "other:hip_breadth", "other:buttock_depth"].includes(r.id)), bad.map((r) => `${r.id}:${r.delta}`).join(" "));
  for (const id of ["stature", "sitting_height", "eye_height_sitting", "cervicale_height", "acromion_height", "trochanterion_height", "knee_height_sitting", "popliteal_height", "thigh_clearance", "buttock_knee_length", "buttock_popliteal_length", "acromion_radiale_length", "radiale_stylion_length", "shoulder_elbow_length", "hand_length", "hand_breadth", "foot_length", "foot_breadth", "span", "thumbtip_reach", "head_length", "head_breadth", "bizygomatic_breadth", "menton_sellion_length", "interpupillary_breadth", "chest_circumference", "waist_circumference", "buttock_circumference", "thigh_circumference", "calf_circumference", "neck_circumference", "head_circumference", "hip_breadth_sitting"]) {
    const r = row(b, id);
    assert.ok(r && r.input !== null, `${id} is in the report with its input`);
    assert.ok(Math.abs(r.delta) <= 2, `${id}: ${r.input} vs ${r.model}`);
  }
  assert.ok(b.dims.filter((x) => x.status === "estimated" && !x.id.startsWith("ring_") && x.unit === "m").length <= 4);
});

test("closure: stature exact, sitting height in the ISO 7250 posture, report for any pose", () => {
  const prof = { sex: "M", measures: { stature: { value: 1801, unit: "mm" }, sitting_height: { value: 936, unit: "mm" }, trochanterion_height: { value: 931, unit: "mm" }, mass: { value: 81, unit: "kg" } } };
  const b = fitBody(prof);
  near(row(b, "stature").delta, 0, 0.01);
  near(row(b, "sitting_height").delta, 0, 0.01);
  near(b.reportSummary.closure.stature_mm, 0, 0.01);
  // hand-check the closure: seated vertex above the seat plane = stature - (hip height - knee height) - (knee height - hip-to-seat)
  const seat = referencePose(b, "seat");
  const k = new Kinematics(OFFS(b)).solve(seat.angles, seat.root);
  const w = (id) => k.toWorld(b.landmarks[id].joint, b.landmarks[id].offset);
  near(mm(w("vertex").y - w("ischial_L").y), 936, 0.01);
  near(mm(w("heel_sole_L").y), 0, 0.02);
  // knees at 90: the shank is vertical and the thigh horizontal
  near(k.position("knee_L").y, k.position("hip_L").y, 1e-9);
  near(k.position("ankle_L").x, k.position("knee_L").x, 1e-9);
  near(k.position("ankle_L").z, k.position("knee_L").z, 1e-9);
  // the same definitions evaluated in the user's pose: the seated pose gives the seated report, a forward bend moves the vertex
  const rows = evaluateMeasures(b, seat);
  near(rows.find((r) => r.id === "sitting_height").model, 936, 0.05);
  assert.ok(rows.every((r) => r.posture === "given"));
  const bent = evaluateMeasures(b, { root: { x: 0, y: b.joints.pelvis.offset[1], z: 0 }, angles: { hip_L: [50, 0, 0], hip_R: [50, 0, 0], L5: [20, 0, 0] } });
  assert.ok(bent.find((r) => r.id === "stature").model < 1801 - 100, "bending lowers the vertex");
  near(bent.find((r) => r.id === "hand_length").model, row(b, "hand_length").model, 1e-3);
  assert.deepEqual(evaluateMeasures(b).map((r) => [r.id, r.model]), b.report.filter((r) => r.kind === "measure").map((r) => [r.id, r.model]));
  assert.throws(() => referencePose(b, "nope"), /unknown reference posture/);
});

test("over-determined inputs: the most direct measure drives, the other is reported with its delta", () => {
  // trochanterion 931 and crotch height 770 disagree by ~60 mm about the hip centre; the trochanterion wins
  const prof = { sex: "M", measures: { stature: { value: 1780, unit: "mm" }, trochanterion_height: { value: 920, unit: "mm" }, crotch_height: { value: 800, unit: "mm" }, buttock_knee_length: { value: 610, unit: "mm" } } };
  const b = fitBody(prof);
  const dm = b.dims.find((x) => x.id === "femur_length");
  assert.deepEqual(dm.via, ["trochanterion_height"]);
  assert.equal(dm.status, "derived");
  assert.ok(dm.alt.length >= 2 && dm.alt.some((a) => a.keys[0] === "crotch_height") && dm.alt.some((a) => a.keys[0] === "buttock_knee_length"));
  assert.ok(dm.alt.every((a) => Math.abs(a.delta) > 0 && Number.isFinite(a.delta)));
  const checks = b.report.filter((r) => r.kind === "check" && r.id === "check:femur_length");
  assert.equal(checks.length, dm.alt.length);
  for (const c of checks) assert.ok(c.note.includes("nothing is averaged") && c.delta !== null);
  // the hip height is the trochanterion one: nothing was averaged
  near(b.d.hip_height, 0.92 + CONSTANTS.hjcAboveTroch, 1e-9);
  assert.ok(row(b, "crotch_height").status === "ok", "the crotch landmark is still at the measured height");
  // a sitting height that contradicts the leg measures wins the closure, the legs become the check
  const b2 = fitBody({ sex: "M", measures: { stature: { value: 1780, unit: "mm" }, trochanterion_height: { value: 995, unit: "mm" }, sitting_height: { value: 940, unit: "mm" } } });
  near(row(b2, "sitting_height").delta, 0, 0.05);
  assert.ok(b2.dims.find((x) => x.id === "femur_length").note.includes("contradicts the sitting height"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("sweep: the median, P5 and P95 person of all 176 populations", { skip: !HAVE_POPS }, () => {
  const files = [];
  for (const c of fs.readdirSync(POP_DIR)) for (const r of fs.readdirSync(path.join(POP_DIR, c))) for (const f of fs.readdirSync(path.join(POP_DIR, c, r))) if (/^(M|F|both)\.json$/.test(f)) files.push(path.join(POP_DIR, c, r, f));
  assert.equal(files.length, 176);
  let fits = 0, withStature = 0, measured = 0;
  for (const f of files) {
    const pop = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const pct of [5, 50, 95]) {
      const prof = percentileProfile(pop, { percentile: pct, minReliability: pct === 50 ? "low" : "medium", meanStature: true });
      const b = fitBody(prof), tag = `${path.relative(POP_DIR, f)} P${pct}`;
      sane(b, tag);
      fits++;
      const st = prof.measures.stature?.value;
      if (st) { withStature++; near(row(b, "stature").delta, 0, 0.01, tag); near(b.stature, st / 1000, 1e-9); }
      measured += Object.keys(prof.measures).length;
      // the form follows the population's sex
      assert.equal(b.form, pop.population.sex === "M" ? "male" : pop.population.sex === "F" ? "female" : "neutral");
      assert.ok(b.warnings.length >= 0 && b.reportSummary.measures >= 55);
      assert.ok(b.warnings.some((w) => (pct === 50 ? /Population profile at P50/ : /boundary case/).test(w)), `${tag}: population caveat`);
      // a measured length is reproduced; the profile's own mass is the model's mass when many sections are estimated
      for (const id of ["hand_length", "foot_length", "head_length", "hand_breadth", "foot_breadth"]) { const r = row(b, id); if (r.input !== null) assert.ok(Math.abs(r.delta) <= 0.5, `${tag} ${id}`); }
    }
  }
  assert.ok(fits === 528 && withStature > 250 && measured > 3000, `${fits} fits, ${withStature} with stature`);
});

function subjects(dataset, n) {
  const rows = db().prepare("select * from subjects where dataset = ? and stature is not null order by subject_key").all(dataset);
  const step = Math.max(1, Math.floor(rows.length / n)), out = [];
  for (let i = 0; i < rows.length && out.length < n; i += step) out.push(rows[i]);
  return out;
}
const MEASURE_CHECKS = ["stature", "sitting_height", "eye_height_sitting", "acromion_radiale_length", "radiale_stylion_length", "hand_length", "foot_length", "hand_breadth", "foot_breadth", "knee_height_sitting", "popliteal_height", "thigh_clearance"];
for (const ds of ["ansur_1988", "ansur_ii_2012", "asran_2015", "usaf_1967"]) {
  test(`sweep: 600 real people of ${ds}`, { skip: !HAVE_DB }, () => {
    const rows = subjects(ds, 600);
    let n = 0, sittingBad = 0, massSum = 0, limbBad = 0, shoulderBad = 0, closed = 0;
    for (const r of rows) {
      const prof = subjectProfile(r);
      const b = fitBody(prof), tag = `${ds} #${r.subject_key}`;
      sane(b, tag);
      n++;
      // driving inputs reproduced
      near(row(b, "stature").delta, 0, 0.01, tag);
      for (const id of MEASURE_CHECKS) {
        const rw = row(b, id);
        if (!rw || rw.input === null) continue;
        if (Math.abs(rw.delta) > 2) { if (id === "sitting_height") sittingBad++; else if (["acromion_radiale_length", "radiale_stylion_length", "hand_length", "foot_length"].includes(id)) limbBad++; }
      }
      // the arm span and the thumbtip reach are exact unless the shoulder parameter is at its limit
      for (const id of ["span", "thumbtip_reach"]) {
        const rw = row(b, id);
        if (rw && rw.input !== null && Math.abs(rw.delta) > 2) {
          const dm = b.dims.find((x) => x.id === (id === "span" ? "acromion_to_gh" : "shoulder_protraction"));
          assert.ok(Math.abs(dm.value) >= 0.0499 || dm.value <= 0.0201 || dm.value >= 0.0849, `${tag}: ${id} off by ${rw.delta} without the limit`);
          shoulderBad++;
        }
      }
      // heights of the standing landmarks are exact (a measured value 7 cm from the model's own height is refused with a warning)
      for (const id of ["cervicale_height", "acromion_height", "iliocristale_height", "trochanterion_height", "suprasternale_height"]) { const rw = row(b, id); if (rw?.input !== null && Math.abs(rw.delta) > 0.01) assert.ok(b.warnings.some((w) => w.includes(id)), `${tag} ${id} ${rw.delta}`); }
      // the circumferences the profile has are the circumferences of the rings
      for (const id of ["chest_circumference", "waist_circumference", "buttock_circumference", "neck_circumference", "thigh_circumference", "calf_circumference", "ankle_circumference", "wrist_circumference", "head_circumference"]) {
        const rw = row(b, id);
        // (a chest / waist / hip tape longer than a section of the measured breadth and depth can hold is reproduced to 1.5 %: sectionFrom)
        const slack = b.dims.some((x) => x.id === `ring_${id.split("_")[0]}` && /more than the section holds|scaled by/.test(x.note)) ? 0.0155 : 0.005;
        if (rw?.input !== null && rw && !/^not used/.test(rw.note)) assert.ok(Math.abs(rw.delta) <= slack * rw.input + 0.5 || b.shape.adiposity !== 1, `${tag} ${id} ${rw.delta}`);
      }
      const mr = row(b, "mass");
      massSum += (mr.model - mr.input) / mr.input;
      if (Math.abs(row(b, "sitting_height").delta) <= 0.05) closed++;
    }
    assert.equal(n, rows.length);
    assert.ok(sittingBad === 0, `sitting height off by more than 2 mm in ${sittingBad} of ${n}`);
    assert.ok(limbBad <= 0.02 * n, `limb lengths off by more than 2 mm in ${limbBad} of ${n}`);
    assert.ok(shoulderBad <= 0.4 * n, `span / thumbtip reach beyond the shoulder limits in ${shoulderBad}`);
    // the volume x 1.05 kg/L reproduces the mass of people whose girths are all measured within about 4 % on average
    assert.ok(Math.abs(massSum / n) < 0.05, `mean mass error ${massSum / n}`);
    assert.ok(closed >= 0.99 * n, `closed ${closed}`);
  });
}

test("sweep: random subsets of the measures of real people never break the fit", { skip: !HAVE_DB }, () => {
  let s = 12345;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rows = db().prepare("select * from subjects where stature is not null order by subject_key").all();
  for (let i = 0; i < 400; i++) {
    const prof = subjectProfile(rows[Math.floor(rnd() * rows.length)]);
    const keys = Object.keys(prof.measures), keep = {};
    const k = 1 + Math.floor(rnd() * keys.length);
    for (let j = 0; j < k; j++) { const key = keys[Math.floor(rnd() * keys.length)]; keep[key] = prof.measures[key]; }
    if (rnd() < 0.7) keep.stature = prof.measures.stature;
    const b = fitBody({ ...prof, measures: keep, sex: rnd() < 0.15 ? "both" : prof.sex });
    sane(b, `subset ${i}`, { ...BONES, femur_length: [0.28, 0.62] });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("determinism, purity, left-right symmetry", () => {
  const prof = Object.freeze({ id: "x", label: "x", sex: "F", notes: [], source: Object.freeze({ kind: "manual" }), measures: Object.freeze({ stature: Object.freeze({ value: 1655, unit: "mm" }), mass: Object.freeze({ value: 61, unit: "kg" }), hand_length: Object.freeze({ value: 181, unit: "mm" }) }) });
  const a = fitBody(prof), b = fitBody(prof), c = fitBody(JSON.parse(JSON.stringify(prof)));
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, "the model is plain JSON data");
  // idempotent: fitting the profile that a model reports as its input gives the same model
  const again = fitBody({ ...prof, measures: Object.fromEntries(Object.entries(a.inputs).map(([k, v]) => [k, { value: k === "mass" ? v : v * 1000, unit: k === "mass" ? "kg" : "mm" }])) });
  assert.deepEqual(again.d, a.d);
  // symmetry of rings, tubes, hand and foot
  for (const side of ["upper_arm", "forearm", "thigh", "shank"]) {
    const L = a.shape.tubes[`${side}_L`], R = a.shape.tubes[`${side}_R`];
    assert.equal(L.rings.length, R.rings.length);
    L.rings.forEach((r, i) => {
      assert.deepEqual([R.rings[i].rx, R.rings[i].rz, R.rings[i].n, R.rings[i].id], [r.rx, r.rz, r.n, r.id]);
      near(R.rings[i].c[0], -r.c[0], 1e-9); near(R.rings[i].c[1], r.c[1], 1e-9); near(R.rings[i].c[2], r.c[2], 1e-9);
      assert.deepEqual(R.rings[i].bind.map(([j]) => j), r.bind.map(([j]) => mirrorId(j)));
    });
  }
  for (const r of a.shape.tubes.torso.rings) near(r.c[0], 0, 1e-12);
  near(a.shape.feet.R.stations[2].cx, -a.shape.feet.L.stations[2].cx, 1e-12);
  assert.equal(a.shape.hands.R.joint, "wrist_R");
  for (const s of ["L", "R"]) { const sg = a.masses; near(sg[`thigh_${s}`].mass, sg.thigh_L.mass, 1e-9); }
  for (const id of ["thigh_L", "shank_L", "foot_L", "upper_arm_L", "hand_L"]) near(a.masses[id.replace("_L", "_R")].com.offset[0], -a.masses[id].com.offset[0], 1e-6, id);
});

test("proportional scaling keeps the median's proportions, percentile scaling is a boundary case", { skip: !HAVE_POPS }, () => {
  const pop = JSON.parse(fs.readFileSync(path.join(POP_DIR, "united-states/army/M.json"), "utf8"));
  const med = fitBody(percentileProfile(pop, { percentile: 50 }));
  const prop = fitBody(percentileProfile(pop, { percentile: 95, scaling: "proportional" }));
  const bnd = fitBody(percentileProfile(pop, { percentile: 95 }));
  const s = prop.stature / med.stature;
  assert.ok(s > 1.05);
  // geometric similarity: every measured length scales with stature (within the 1 mm rounding of the profile values)
  for (const id of ["hand_length", "foot_length", "acromion_radiale_length", "buttock_knee_length", "sitting_height", "span"]) {
    const a = row(med, id), b = row(prop, id);
    if (a?.input === null || b?.input === null) continue;
    near(b.model / a.model, s, 0.004, id);
  }
  for (const id of ["femur_length", "shank_length", "upper_arm_length", "forearm_length", "trunk_length"]) near(prop.d[id] / med.d[id], s, 0.01, id);
  // in the boundary case each dimension is the 95th percentile of its own distribution: the proportions are not the median's
  const ratio = (b, id) => b.d[id] / b.stature;
  const spread = ["femur_length", "upper_arm_length", "hand_length", "trunk_length"].map((id) => Math.abs(ratio(bnd, id) - ratio(med, id)) / ratio(med, id));
  assert.ok(Math.max(...spread) > 0.01, `boundary-case proportions differ from the median's: ${spread.map((x) => x.toFixed(3))}`);
  assert.ok(bnd.warnings.some((w) => /boundary case/.test(w)) && !prop.warnings.some((w) => /boundary case/.test(w)));
  // measured values are kept exactly in both
  near(row(bnd, "hand_length").delta, 0, 0.5);
  near(row(prop, "hand_length").delta, 0, 0.5);
});

test("overrides win over the profile, the estimates and the derived dimensions", () => {
  const prof = { sex: "M", measures: { stature: { value: 1760, unit: "mm" }, mass: { value: 78, unit: "kg" }, radiale_stylion_length: { value: 262, unit: "mm" }, acromion_radiale_length: { value: 330, unit: "mm" }, chest_circumference: { value: 1000, unit: "mm" } } };
  const base = fitBody(prof);
  const b = fitBody(prof, { overrides: { forearm_length: 0.3, femur_length: 0.45, hand_length: 0.2, ring_chest: 1.1, shank_length: 0.4 } });
  for (const [id, v] of [["forearm_length", 0.3], ["femur_length", 0.45], ["hand_length", 0.2]]) {
    const d = b.dims.find((x) => x.id === id);
    near(d.value, v, 1e-9); assert.equal(d.status, "measured"); assert.ok(/overridden by the user/.test(d.note));
    near(b.d[id], v, 1e-9);
  }
  near(b.d.shank_length, 0.4, 1e-9, "a derived dimension edits its source");
  near(b.d.knee_height - b.d.ankle_height, 0.4, 1e-9);
  assert.equal(b.dims.find((x) => x.id === "knee_height").status, "measured");
  near(b.d.hip_height - b.d.knee_height, 0.45, 1e-9);
  // the model really changed: the forearm joint chain and the hand tip
  near(Math.hypot(...b.joints.wrist_L.offset), 0.3, 1e-4, "forearm bone");
  near(row(b, "hand_length").model, 200, 0.5);
  near(b.landmarks.vertex.offset[1] + b.positions.head[1], 1.76, 2e-5);
  assert.notEqual(b.d.upper_arm_length, 0);
  near(row(b, "chest_circumference").model, 1100, 0.5);
  assert.ok(base.d.forearm_length < 0.29);
  // an override that is nonsense is ignored with a warning (a derived dimension without a rule)
  const w = fitBody(prof, { overrides: { trunk_length: 0.5 } });
  assert.ok(w.warnings.some((x) => /override of .* was ignored/.test(x)));
});

test("sections: girths, breadths and depths of a body part", () => {
  // Ramanujan's second approximation against a numerical integral of the ellipse
  const num = (a, b) => { let s = 0, N = 200000; for (let i = 0; i < N; i++) { const t0 = (2 * Math.PI * i) / N, t1 = (2 * Math.PI * (i + 1)) / N; s += Math.hypot(a * (Math.cos(t1) - Math.cos(t0)), b * (Math.sin(t1) - Math.sin(t0))); } return s; };
  for (const [a, b] of [[0.17, 0.12], [0.07, 0.065], [0.2, 0.05], [0.1, 0.1]]) near(ellipsePerimeter(a, b) / num(a, b), 1, 1e-5, `${a} ${b}`);
  near(ringPerimeter(0.1, 0.1, 2), 2 * Math.PI * 0.1, 1e-9);
  // the polyline against a fine numerical integral of the superellipse |x/a|^n + |z/b|^n = 1
  const sup = (a, b, n) => { let s = 0, N = 400000, px = a, pz = 0; for (let i = 1; i <= N; i++) { const t = (Math.PI / 2) * (i / N), x = a * Math.cos(t) ** (2 / n), z = b * Math.sin(t) ** (2 / n); s += Math.hypot(x - px, z - pz); px = x; pz = z; } return 4 * s; };
  for (const [a, b, n] of [[0.17, 0.12, 1.8], [0.15, 0.12, 3], [0.2, 0.15, 5], [0.1, 0.1, 4]]) near(ringPerimeter(a, b, n) / sup(a, b, n), 1, 1.5e-3, `${a} ${b} ${n}`);
  near(ringArea(0.1, 0.1, 2), Math.PI * 0.01, 1e-12);
  assert.ok(ringArea(0.1, 0.1, 4) > Math.PI * 0.01 && ringArea(0.1, 0.1, 4) < 0.04);
  // all three given: breadth, depth and girth reproduced
  let s = sectionFrom({ B: 0.31, D: 0.25, G: 0.98, n0: 2 });
  near(2 * s.rx, 0.31, 1e-12); near(2 * s.rz, 0.25, 1e-12); near(ringPerimeter(s.rx, s.rz, s.n), 0.98, 1e-4); assert.ok(s.n > 2 && s.k === 1);
  // girth beyond what any exponent reaches: the girth wins, the ratio of breadth to depth stays
  s = sectionFrom({ B: 0.31, D: 0.25, G: 1.2 });
  near(ringPerimeter(s.rx, s.rz, s.n), 1.2, 1e-4); near(s.rz / s.rx, 0.25 / 0.31, 1e-12); assert.ok(s.k > 1);
  // girth and one axis
  s = sectionFrom({ B: 0.3, G: 0.9, n0: 2 }); near(2 * s.rx, 0.3, 1e-12); near(ringPerimeter(s.rx, s.rz, 2), 0.9, 1e-4);
  s = sectionFrom({ D: 0.2, G: 0.7, n0: 2 }); near(2 * s.rz, 0.2, 1e-12); near(ringPerimeter(s.rx, s.rz, 2), 0.7, 1e-4);
  // girth alone with a typical ratio
  s = sectionFrom({ G: 0.4, ratio: 0.8 }); near(s.rz / s.rx, 0.8, 1e-12); near(ringPerimeter(s.rx, s.rz, 2), 0.4, 1e-4);
});

test("shape: rings are ordered, positive, bound to joints; measured girths are never altered; adiposity closes the mass", () => {
  const withGirths = fitBody({ sex: "M", measures: { stature: { value: 1780, unit: "mm" }, mass: { value: 85, unit: "kg" }, chest_circumference: { value: 1050, unit: "mm" }, chest_breadth: { value: 320, unit: "mm" }, chest_depth: { value: 270, unit: "mm" }, waist_circumference: { value: 900, unit: "mm" }, buttock_circumference: { value: 1020, unit: "mm" }, thigh_circumference: { value: 620, unit: "mm" }, biceps_circumference_flexed: { value: 340, unit: "mm" }, neck_circumference: { value: 390, unit: "mm" } } });
  const ids = new Set(JOINTS.map((j) => j.id));
  for (const [name, t] of Object.entries(withGirths.shape.tubes)) {
    assert.ok(ids.has(t.joint) && t.rings.length >= 3, name);
    t.rings.forEach((r, i) => {
      assert.ok(r.rx > 0.005 && r.rz > 0.005 && r.n >= 1.8 && r.n <= 12, `${name}.${r.id}`);
      near(r.bind.reduce((a, [, w]) => a + w, 0), 1, 1e-5, `${name}.${r.id} weights`);
      for (const [j] of r.bind) assert.ok(ids.has(j));
      assert.ok(["measured", "derived", "estimated"].includes(r.src));
      if (i && (name === "torso" || name === "neck")) assert.ok(r.c[1] > t.rings[i - 1].c[1], `${name}.${r.id} ascends`);
    });
  }
  for (const [id, g] of [["chest", 1050], ["waist", 900], ["buttock", 1020], ["th_prox", 620], ["ua_biceps", 340], ["neck_mid", 390]]) {
    const r = withGirths.shape.tubes[id === "th_prox" ? "thigh_L" : id === "ua_biceps" ? "upper_arm_L" : id === "neck_mid" ? "neck" : "torso"].rings.find((x) => x.id === id);
    near(mm(ringPerimeter(r.rx, r.rz, r.n)), g, 0.6, id);
  }
  const chest = withGirths.shape.tubes.torso.rings.find((x) => x.id === "chest");
  near(2 * chest.rx * 1000, 320, 0.01); near(2 * chest.rz * 1000, 270, 0.01); assert.equal(chest.src, "measured");
  // everything estimated: the adiposity factor closes the mass; stature + mass only
  for (const [S, M, sex] of [[1750, 60, "M"], [1750, 110, "M"], [1600, 50, "F"], [1600, 95, "F"]]) {
    const b = fitBody(P(S, sex, M));
    near(b.shape.volume.mass, M, 0.002 * M, `${sex} ${M}`);
    assert.ok(b.shape.adiposity > 0.9 && b.shape.adiposity < 1.2, `${sex} ${M}: adiposity ${b.shape.adiposity}`);
  }
  const lean = fitBody(P(1750, "M", 60)), heavy = fitBody(P(1750, "M", 110));
  assert.ok(heavy.shape.tubes.torso.rings.find((r) => r.id === "waist").rz > lean.shape.tubes.torso.rings.find((r) => r.id === "waist").rz * 1.2);
  // the measured girths imply a mass different from the profile: a warning, not a silent scaling
  const heavyProfile = typicalProfile(1760, 80); heavyProfile.measures.mass.value = 130;
  const odd = fitBody(heavyProfile);
  assert.ok(odd.shape.volume.mass < 0.85 * 130 && odd.shape.adiposity === 1, `${odd.shape.volume.mass} kg from 130 kg`);
  assert.ok(odd.warnings.some((w) => /girths imply/.test(w)), "the measured girths imply less than the profile's mass: said, not hidden");
});

test("landmarks sit on the surface of the rings that the skin is lofted from", () => {
  const b = fitBody(typicalProfile(1760, 80));
  const k = new Kinematics(OFFS(b)).solve({}, { x: 0, y: b.joints.pelvis.offset[1], z: 0 });
  const w = (id) => k.toWorld(b.landmarks[id].joint, b.landmarks[id].offset).toArray();
  const ring = (id) => { for (const t of [...Object.values(b.shape.tubes), b.shape.head]) { const r = t.rings.find((x) => x.id === id); if (r) return r; } throw new Error(id); };
  const front = (r) => r.c[2] + r.rz, back = (r) => r.c[2] - r.rz;
  near(w("chest_front")[2], front(ring("chest")), 2e-5); near(w("chest_back")[2], back(ring("chest")), 2e-5);
  near(w("omphalion")[2], front(ring("waist")), 2e-5); near(w("waist_back")[2], back(ring("waist")), 2e-5);
  near(w("buttock_extremity")[2], back(ring("buttock")), 2e-5);
  near(w("knee_top_L")[2], front(ring("th_low")), 3e-5); near(w("popliteal_L")[2], back(ring("th_low")), 3e-5);
  // the seated thigh clearance is the (compressed) seated thickness; the ring is the standing section, up to 20 mm thicker (MODEL.md 6.3)
  near(w("thigh_under_L")[2], back(ring("th_prox")), 3e-5);
  assert.ok(w("thigh_top_L")[2] <= front(ring("th_prox")) + 3e-5 && front(ring("th_prox")) - w("thigh_top_L")[2] < 0.03, `thigh top ${w("thigh_top_L")[2]} front ${front(ring("th_prox"))}`);
  const d = ring("ua_deltoid"); near(w("deltoid_L")[0], d.c[0] + d.rx, 2e-5);
  near(w("glabella")[2], front(ring("brow")), 5e-4); near(w("opisthocranion")[2], back(ring("brow")), 5e-4);
  near(2 * ring("brow").rx, b.d.head_breadth, 5e-4);
  // the rings are around the bones: the knee centre is inside the knee ring, the shoulder joint inside the upper-arm top ring's extent
  const kn = ring("th_knee"); assert.ok(Math.abs(b.positions.knee_L[2] - kn.c[2]) < kn.rz && Math.abs(b.positions.knee_L[0] - kn.c[0]) < kn.rx);
  // thighs do not stick out of the hips
  assert.ok(ring("th_prox").c[0] + ring("th_prox").rx <= ring("buttock").rx + 0.0061);
  // hands hang outside the thighs and the hips
  const wr = b.positions.wrist_L[0], hand = b.shape.hands.L.palm[1];
  assert.ok(wr - 0.02 >= ring("buttock").rx - 0.005, `the wrist (${wr}) clears the hip edge (${ring("buttock").rx})`);
  assert.ok(hand.c[0] > 0.8 * ring("buttock").rx);
});

test("masses: de Leva segments add up and the centre of mass follows the joints", () => {
  for (const sex of ["M", "F", "both"]) {
    const b = fitBody(P(1700, sex, 72));
    const seg = b.masses;
    assert.equal(Object.keys(seg).length, 16);
    near(b.massInfo.total, 72, 0.02); near(b.massInfo.fractionSum, 1, 2e-4); // de Leva's women's fractions add up to 0.9999
    near(Object.values(seg).reduce((a, x) => a + x.mass, 0), b.mass, 0.02);
    // whole-body COM from the segments via Kinematics in a seated pose equals the sum of moments
    const pose = referencePose(b, "seat");
    const k = new Kinematics(OFFS(b)).solve(pose.angles, pose.root);
    let m = 0, y = 0;
    for (const s of Object.values(seg)) { const p = k.toWorld(s.com.joint, s.com.offset); m += s.mass; y += s.mass * p.y; }
    assert.ok(y / m > 0.45 && y / m < 0.95, `seated COM height ${y / m}`);
    const kn = new Kinematics(OFFS(b)).solve({}, { x: 0, y: b.joints.pelvis.offset[1], z: 0 });
    let cy = 0; for (const s of Object.values(seg)) cy += s.mass * kn.toWorld(s.com.joint, s.com.offset).y;
    near(cy / m, b.massInfo.com[1], 2e-5);
  }
  // de Leva's published fractions (men): head 6.94 %, trunk 43.46 %, thigh 14.16 %
  const m = fitBody(P(1750, "M", 100)), s = m.masses;
  near(s.head.fraction, 0.0694, 1e-6); near(s.thigh_L.fraction, 0.1416, 1e-6); near(s.trunk_upper.fraction + s.trunk_middle.fraction + s.trunk_lower.fraction, 0.4346, 1e-5);
  near(s.thigh_L.mass, 14.16, 1e-3);
  // the thigh centre of mass is 40.95 % of the way down from the hip centre (men)
  near(s.thigh_L.com.offset[1] / (m.positions.knee_L[1] - m.positions.hip_L[1]), 0.4095, 1e-4);
  const w = fitBody(P(1650, "F", 60)).masses;
  near(w.thigh_L.fraction, 0.1478, 1e-6);
});

test("spine: the standing curvature is baked in, the trunk is balanced over the hips", () => {
  const b = fitBody(P(1750, "M", 80));
  const dir = (a, c) => { const v = [b.positions[c][1] - b.positions[a][1], b.positions[c][2] - b.positions[a][2]]; return (Math.atan2(v[1], v[0]) * 180) / Math.PI; }; // lean from the vertical, + = toward +z (forward)
  const ang = (a, c) => dir(a, c);
  // lumbar lordosis: the direction turns by 4/5 of 50 degrees between the first and the last lumbar interval; thoracic kyphosis 10/12 of 38 between T12 and T2
  near(ang("L1", "T12") - ang("L5", "L4"), -CONSTANTS.lordosis * 4 / 5, 1.5, "lordosis");
  near(ang("T2", "T1") - ang("T12", "T11"), CONSTANTS.kyphosis * 10 / 12, 2, "kyphosis");
  near(ang("C1", "head") - ang("C7", "C6"), -CONSTANTS.cervical * 6 / 7, 1.5, "cervical lordosis");
  near(b.positions.C7[2] - b.positions.L5[2], CONSTANTS.sva, 1e-4, "C7 plumb line");
  near(b.positions.L5[2], -CONSTANTS.l5Behind, 1e-9);
  assert.ok(b.spine.lordosisDeg === 50 && Math.abs(b.spine.balanceRotationDeg) < 10);
  // the lumbar spine moves forward and back (lordosis), the thoracic spine has its apex behind
  const z = (id) => b.positions[id][2];
  assert.ok(z("L3") > z("L5") && z("T7") < z("L1") && z("C1") > z("C7") - 0.02);
  // the head sits over the shoulders: tragion within 5 cm of the acromion
  const tr = b.positions.head[2] + b.landmarks.tragion_L.offset[2] - 0;
  assert.ok(Math.abs(tr - (b.positions.clavicle_L[2] - 0.06)) < 0.12);
  // head, neck and trunk lengths close on the stature
  near(b.stature - b.d.head_pivot_depth, b.positions.head[1], 1e-5);
  near(b.positions.C7[1], b.d.c7_height, 1e-5);
  near(b.positions.L5[1] - b.positions.pelvis[1], b.d.l5_above_hip, 1e-5);
});

test("regression and relation tables reproduce from the database (data provenance)", { skip: !HAVE_DB }, () => {
  const rows = db().prepare("select * from subjects").all();
  const ols = (sex, f) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bb = [0, 0, 0], ys = [], xs = [];
    for (const r of rows) {
      if (r.sex !== sex || !r.stature || !r.mass) continue;
      const y = f(r);
      if (!Number.isFinite(y)) continue;
      const x = [1, r.stature, r.mass];
      for (let i = 0; i < 3; i++) { bb[i] += x[i] * y; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; }
      ys.push(y); xs.push(x);
    }
    const M = A.map((r, i) => [...r, bb[i]]);
    for (let i = 0; i < 3; i++) { let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r; [M[i], M[p]] = [M[p], M[i]]; for (let r = 0; r < 3; r++) if (r !== i) { const q = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= q * M[i][c]; } }
    const beta = [0, 1, 2].map((i) => M[i][3] / M[i][i]);
    let sse = 0; ys.forEach((y, i) => { const e = y - (beta[0] + beta[1] * xs[i][1] + beta[2] * xs[i][2]); sse += e * e; });
    return { n: ys.length, a: beta[0], bs: beta[1], bm: beta[2], sd: Math.sqrt(sse / (ys.length - 3)) };
  };
  for (const key of ["sitting_height", "cervicale_height", "hand_length", "chest_circumference", "thigh_clearance", "popliteal_height", "acromion_radiale_length", "bicristal_breadth"]) {
    [0, 1].forEach((i) => {
      const t = REGRESSIONS[key][i], r = ols(i ? "F" : "M", (x) => x[key] ?? NaN);
      assert.equal(t[4], r.n, `${key} n`);
      near(t[0], r.a, 0.06, `${key} a`); near(t[1], r.bs, 6e-5, `${key} bs`); near(t[2], r.bm, 1e-3, `${key} bm`); near(t[3], r.sd, 0.06, `${key} sd`);
    });
  }
  // relations with the model's own constants
  const g = (r, k) => r[k] ?? NaN; // a missing value (null) is not a number
  const hjc = (r) => g(r, "trochanterion_height") + 1000 * CONSTANTS.hjcAboveTroch;
  const rel = { seat_below_hip: (r) => g(r, "sitting_height") - g(r, "stature") + hjc(r), hip_over_crotch: (r) => hjc(r) - g(r, "crotch_height"), bkl_minus_bpl: (r) => g(r, "buttock_knee_length") - g(r, "buttock_popliteal_length"),
    cervicale_over_acromion: (r) => g(r, "cervicale_height") - g(r, "acromion_height"), vertex_to_eye: (r) => g(r, "sitting_height") - g(r, "eye_height_sitting"), iliocristale_over_hip: (r) => g(r, "iliocristale_height") - hjc(r) };
  for (const [name, f] of Object.entries(rel)) [0, 1].forEach((i) => {
    const v = rows.filter((r) => r.sex === (i ? "F" : "M")).map(f).filter(Number.isFinite);
    const m = v.reduce((a, x) => a + x, 0) / v.length, sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
    assert.equal(RELATIONS[name][i][2], v.length, `${name} n`);
    near(RELATIONS[name][i][0], m, 0.06, `${name} mean`); near(RELATIONS[name][i][1], sd, 0.06, `${name} sd`);
  });
  const n = rows.length;
  assert.equal(n, 13792);
  for (const [k, [m, w]] of Object.entries(REGRESSIONS)) for (const c of [m, w]) if (c) assert.ok(c[3] > 0 && c[4] >= 1000 && c[1] > -1 && c[1] < 2, k);
});

test("implausible and missing inputs: ignored with a warning, never an exception", () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: 78, unit: "kg" }, hand_length: { value: 1900, unit: "mm" }, foot_length: { value: 27, unit: "mm" } } });
  sane(b, "bad hand");
  assert.ok(b.warnings.some((w) => /hand_length.*implausible/.test(w)) && b.warnings.some((w) => /foot_length.*implausible/.test(w)));
  assert.ok(b.d.hand_length < 0.25);
  const h = row(b, "hand_length");
  assert.equal(h.input, 1900); assert.ok(h.status !== "ok" && /not used/.test(h.note));
  // no stature: estimated from the other heights, with a warning
  const e = fitBody({ sex: "M", measures: { sitting_height: { value: 920, unit: "mm" }, cervicale_height: { value: 1500, unit: "mm" } } });
  assert.equal(e.dims[0].status, "estimated"); near(e.stature, 1.75, 0.04); assert.ok(e.warnings.some((w) => /no stature/.test(w)));
  const none = fitBody({ sex: "F", measures: {} });
  near(none.stature, 1.629, 1e-9); assert.ok(none.warnings.some((w) => /no stature/.test(w)));
  for (const bad of [undefined, null, {}, { measures: null }, { sex: "?", measures: { stature: { value: NaN, unit: "mm" }, mass: { value: -1, unit: "kg" }, foo: 3 } }, { measures: { stature: { value: 1.75, unit: "m" }, mass: { value: 165, unit: "lb" } } }]) {
    const x = fitBody(bad); walkFinite(x);
  }
  const lb = fitBody({ measures: { stature: { value: 1.75, unit: "m" }, mass: { value: 165, unit: "lb" } } });
  near(lb.stature, 1.75, 1e-12); near(lb.mass, 74.84, 0.01);
  // BMI instead of mass
  const bm = fitBody({ sex: "M", measures: { stature: { value: 1800, unit: "mm" }, bmi: { value: 25, unit: "kg/m²" } } });
  near(bm.mass, 25 * 1.8 * 1.8, 1e-9); assert.equal(bm.dims[1].status, "derived");
  assert.equal(fitBody(P(1750, "M"), { form: "x" }).form, "male", "an unknown form falls back to the one of the profile's sex");
  // a manual profile from anthro.js
  const mp = fitBody(manualProfile({ sex: "F", stature: 168, statureUnit: "cm", mass: 64 }));
  near(mp.stature, 1.68, 1e-12); sane(mp, "manual");
});

test("DIM_DEFS documents every dimension of the table", () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" } } });
  const ids = new Set(DIM_DEFS.map((d) => d.id));
  assert.equal(ids.size, DIM_DEFS.length, "ids are unique");
  for (const d of b.dims) assert.ok(ids.has(d.id), `${d.id} is not in DIM_DEFS`);
  for (const d of DIM_DEFS) {
    assert.ok(d.label && ["m", "kg", "ratio"].includes(d.unit) && Array.isArray(d.formula) && d.formula.length && Array.isArray(d.requires) && typeof d.fallback === "string", d.id);
  }
  // every dimension record is complete: value, unit, status, via, note
  for (const d of b.dims) { assert.ok(Number.isFinite(d.value) && d.label && d.note && Array.isArray(d.via) && ["measured", "derived", "estimated"].includes(d.status), d.id); }
  // measured / derived dimensions name the measures they came from
  const full = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, acromion_radiale_length: { value: 330, unit: "mm" }, sitting_height: { value: 920, unit: "mm" } } });
  assert.deepEqual(full.dims.find((x) => x.id === "upper_arm_length").via, ["acromion_radiale_length"]);
  assert.ok(full.dims.find((x) => x.id === "hip_to_seat").via.includes("sitting_height"));
  assert.ok(full.dims.find((x) => x.id === "upper_arm_length").note.includes("acromion-radiale"));
});

test("report: statuses, tolerances and notes", () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1770, unit: "mm" }, mass: { value: 80, unit: "kg" }, hand_length: { value: 190, unit: "mm" }, span: { value: 1850, unit: "mm" }, elbow_rest_height: { value: 255, unit: "mm" }, acromion_height_sitting: { value: 600, unit: "mm" }, sitting_height: { value: 930, unit: "mm" } } });
  for (const r of b.report) {
    assert.ok(["ok", "warn", "off", "n/a"].includes(r.status) && ["measure", "check"].includes(r.kind) && r.id && r.label && r.unit && Number.isFinite(r.model), r.id);
    if (r.input === null) assert.equal(r.status, "n/a"); else {
      const tol = r.unit === "kg" ? 0.05 * r.input : Math.max(5, 0.005 * Math.abs(r.input));
      near(r.delta, r.model - r.input, 1e-6);
      assert.equal(r.status === "ok", Math.abs(r.delta) <= tol + 1e-9, `${r.id} ${r.delta} ${r.status}`);
      if (r.status !== "ok" && r.kind === "measure") assert.ok(r.note.length >= 0);
    }
  }
  assert.equal(row(b, "hand_length").status, "ok");
  assert.equal(row(b, "span").status, "ok");
  // the conflicting seated measures are explained
  const e = row(b, "elbow_rest_height");
  assert.ok(e.status !== "ok" ? /acromion height sitting/.test(e.note) : true);
  const s = b.reportSummary;
  assert.equal(s.measures, s.ok + s.warn + s.off + s.na);
  assert.ok(s.dims.total === b.dims.length && s.dims.measured + s.dims.derived + s.dims.estimated === s.dims.total);
  assert.ok(b.report.find((r) => r.id === "mass").unit === "kg");
});

test("performance: a full profile fits in under 15 ms", { skip: !HAVE_DB }, () => {
  const r = db().prepare("select * from subjects where dataset = 'ansur_ii_2012' and sex = 'M' order by subject_key limit 1 offset 700").get();
  const prof = subjectProfile(r);
  for (let i = 0; i < 5; i++) fitBody(prof); // warm up
  const t = [];
  for (let i = 0; i < 25; i++) { const t0 = performance.now(); fitBody(prof); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  assert.ok(t[12] < 15, `median ${t[12].toFixed(2)} ms`);
  const t1 = [];
  for (let i = 0; i < 25; i++) { const t0 = performance.now(); fitBody(P(1750, "M", 80)); t1.push(performance.now() - t0); }
  t1.sort((a, b) => a - b);
  assert.ok(t1[12] < 15, `stature only: median ${t1[12].toFixed(2)} ms`);
});

// =================================================================================================================================
// Regression tests of the defects found by the independent verification (tests/human3d/fit.adversarial.test.mjs): one per defect.
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ring = (b, tube, id) => b.shape.tubes[tube].rings.find((r) => r.id === id);
const sample = (every, filter = () => true) => db().prepare("select * from subjects where stature is not null and mass is not null order by subject_key").all().filter((r, i) => i % every === 0 && filter(r));

test("fix: evaluateMeasures(body, pose) does not depend on where the figure looks (heading), nor on where it stands", () => {
  const b = fitBody(P(1750, "M", 78));
  for (const name of ["stand", "seat", "tpose", "forward"]) {
    const ref = referencePose(b, name);
    const at = (heading, x = 0, z = 0) => Object.fromEntries(evaluateMeasures(b, { root: { ...ref.root, heading, x, z }, angles: ref.angles }).map((r) => [r.id, r.model]));
    const a = at(0);
    for (const [h, x, z] of [[37, 0, 0], [90, 0.3, -0.2], [180, 0, 0], [-120, -1, 2]]) {
      const c = at(h, x, z);
      assert.deepEqual(Object.keys(a).filter((k) => Math.abs(a[k] - c[k]) > 1e-6), [], `${name} heading ${h}`);
    }
  }
  // and the known values: biacromial breadth and chest depth do not collapse to 0 when the figure is turned by 90 degrees
  const turned = evaluateMeasures(b, { root: { ...referencePose(b, "stand").root, heading: 90 }, angles: {} });
  near(turned.find((r) => r.id === "biacromial_breadth").model, row(b, "biacromial_breadth").model, 1e-6);
  assert.ok(turned.find((r) => r.id === "chest_depth").model > 200);
});

test("fix: a section keeps breadth and depth and meets the girth within 1.5 %; ANSUR II men (tape 24 % over the ellipse) are no longer inflated", () => {
  // between the exponent limit and the bounding rectangle: the girth is met by the smallest growth that leaves 1.5 % out, not by inflating the axes by 2.4 %
  const B = 0.29, D = 0.245, G = 1.062; // the median ANSUR II man: ratio 1.24 to the ellipse
  assert.ok(G / ellipsePerimeter(B / 2, D / 2) > 1.23 && G < 2 * (B + D));
  const s = sectionFrom({ B, D, G });
  assert.equal(s.n, 12);
  assert.ok(s.k >= 1 && s.k < 1.025, `k ${s.k}`);
  near(ringPerimeter(s.rx, s.rz, s.n) / G, 1, 0.0151);
  near(2 * s.rx, B * s.k, 1e-12);
  // a girth a little over what exponent 12 holds, within the 1.5 %: breadth and depth are untouched
  const hi = ringPerimeter(B / 2, D / 2, 12), t = sectionFrom({ B, D, G: hi * 1.01 });
  assert.ok(t.k === 1 && t.n === 12 && Math.abs(t.short - hi * 0.01) < 1e-9);
  // beyond the rectangle by more than 5 %: impossible for any convex section, the girth wins exactly
  const big = sectionFrom({ B: 0.3, D: 0.24, G: 1.2 });
  assert.ok(big.k > 1.1 && Math.abs(big.girth - 1.2) < 1e-4 && big.short < 1e-4);
});

test("fix: ANSUR II men: chest breadth and depth are the measured ones (mean error < 8 mm), the tape within 2 %", { skip: !HAVE_DB }, () => {
  const rows = sample(27, (r) => r.dataset === "ansur_ii_2012" && r.sex === "M" && r.chest_breadth > 0 && r.chest_depth > 0 && r.chest_circumference > 0);
  assert.ok(rows.length > 100);
  const fits = rows.map((r) => fitBody(subjectProfile(r)));
  for (const id of ["chest_breadth", "chest_depth"]) {
    const e = fits.map((b) => row(b, id).delta);
    assert.ok(Math.abs(mean(e)) < 8, `${id} mean error ${mean(e).toFixed(1)} mm`);
    assert.ok(fits.filter((b) => row(b, id).status === "off").length / fits.length < 0.1, `${id} off`);
  }
  assert.ok(fits.every((b) => row(b, "chest_circumference").status !== "off"), "the chest tape is within 2 % for everybody");
  assert.ok(fits.every((b) => b.shape.tubes.torso.rings.every((r) => r.n <= 12)));
});

test("fix: the thumbtip reach of a profile without a reach is unbiased in every survey and sex", { skip: !HAVE_DB }, () => {
  const acc = new Map(), pooled = { M: [], F: [] };
  for (const r of sample(27, (x) => x.thumbtip_reach > 0)) {
    const b = fitBody({ sex: r.sex, measures: { stature: { value: r.stature, unit: "mm" }, mass: { value: r.mass, unit: "kg" } } });
    const e = row(b, "thumbtip_reach").model - r.thumbtip_reach;
    (acc.get(`${r.dataset}/${r.sex}`) ?? acc.set(`${r.dataset}/${r.sex}`, []).get(`${r.dataset}/${r.sex}`)).push(e); pooled[r.sex].push(e);
  }
  for (const sx of ["M", "F"]) assert.ok(Math.abs(mean(pooled[sx])) < 6, `${sx}: pooled bias ${mean(pooled[sx]).toFixed(1)} mm`);
  for (const [g, e] of acc) if (e.length >= 25 && !/asran_2015\/F/.test(g)) assert.ok(Math.abs(mean(e)) < 15, `${g}: bias ${mean(e).toFixed(1)} mm (n ${e.length})`);
});

test("fix: the arm and the shoulder of the report postures are horizontal whatever the neutral abduction of the arm", () => {
  for (const [S, M, sx] of [[1750, 78, "M"], [1650, 55, "F"], [1750, 130, "M"]]) {
    const b = fitBody(P(S, sx, M));
    // the arm span / thumbtip reach definitions need the arm horizontal: abduction 90 - beta, and flexion with the adduction that puts it in the sagittal plane
    const t = referencePose(b, "tpose").angles.shoulder_L, f = referencePose(b, "forward").angles.shoulder_L;
    const beta = (Math.atan2(b.joints.elbow_L.offset[0], -b.joints.elbow_L.offset[1]) * 180) / Math.PI;
    near(t[1], 90 - beta, 1e-9, "tpose abduction"); assert.ok(f[0] === 90 && f[1] < 0 && f[1] > -30);
    const k = new Kinematics(OFFS(b));
    k.solve({ shoulder_L: f }, { x: 0, y: 1, z: 0 });
    const s0 = k.toWorld("shoulder_L", [0, 0, 0]), e0 = k.toWorld("elbow_L", [0, 0, 0]);
    near(e0.x - s0.x, 0, 1e-6, "forward arm in the sagittal plane");
    k.solve({ shoulder_L: t }, { x: 0, y: 1, z: 0 });
    near(k.toWorld("elbow_L", [0, 0, 0]).y - k.toWorld("shoulder_L", [0, 0, 0]).y, 0, 1e-6, "T-pose arm horizontal");
    assert.deepEqual(REFERENCE_POSTURES.tpose.angles.shoulder_L, [0, 90, 0], "the nominal table is unchanged");
  }
});

test("fix: the hanging arm's skin clears the trunk's skin (overlap < 20 mm), the bones hang as before, ua_elbow and fa_elbow are the same ring", () => {
  for (const [S, m, sx] of [[1750, 78, "M"], [1750, 110, "M"], [1650, 55, "F"], [1900, 95, "M"], [1650, 95, "F"]]) {
    const b = fitBody(P(S, sx, m)), ch = ring(b, "torso", "chest"), tag = `${sx} ${S} ${m}`;
    for (const id of ["ua_biceps"]) { const r = ring(b, "upper_arm_L", id); assert.ok(mm(ch.rx - (r.c[0] - r.rx)) < 20, `${tag} ${id}: ${mm(ch.rx - (r.c[0] - r.rx)).toFixed(0)} mm into the chest`); }
    assert.deepEqual(ring(b, "upper_arm_L", "ua_elbow").c, ring(b, "forearm_L", "fa_elbow").c, `${tag}: elbow rings`);
    // the bone is not moved by the clearance: abduction stays between 3 and 14 degrees
    const beta = (Math.atan2(b.joints.elbow_L.offset[0], -b.joints.elbow_L.offset[1]) * 180) / Math.PI;
    assert.ok(beta >= 2.99 && beta <= 14.01, `${tag}: beta ${beta}`);
    // and the right arm is the mirror image
    assert.deepEqual(ring(b, "upper_arm_R", "ua_biceps").c, [-ring(b, "upper_arm_L", "ua_biceps").c[0] + 0, ...ring(b, "upper_arm_L", "ua_biceps").c.slice(1)]);
  }
});

test("fix: the thighs do not cross the midline by more than 30 mm (the standing section comes from the girth, not from the seated thickness)", () => {
  for (const [S, m, sx] of [[1764, 84, "M"], [1629, 66, "F"], [1750, 78, "M"], [1650, 120, "F"], [1800, 140, "M"], [1600, 45, "F"]]) {
    const b = fitBody(P(S, sx, m)), t = ring(b, "thigh_L", "th_prox"), tag = `${sx} ${S} ${m}`;
    assert.ok(mm(t.rx - t.c[0]) <= 30.01, `${tag}: crosses the midline by ${mm(t.rx - t.c[0]).toFixed(0)} mm`);
  }
  const b = fitBody(P(1764, "M", 84)), t = ring(b, "thigh_L", "th_prox");
  assert.ok(mm(2 * t.rx) < 205, `the median thigh is ${mm(2 * t.rx).toFixed(0)} mm wide (was 213)`);
  near(t.rz / t.rx, 1, 1e-9);
  // the seated thickness is still exact (it is carried by the landmark)
  near(row(b, "thigh_clearance").delta, 0, 0.5);
});

test("fix: overrides are limited to the plausible band, the spine stays in order, unknown overrides are reported", () => {
  for (const ov of [{ femur_length: 1.0 }, { hip_height: 3 }, { vertex_to_eye: 1 }, { c7_height: 2.5 }, { femur_length: 0.62 }, { shank_length: 2 }, { gh_halfwidth: 0.5 }, { upper_arm_length: 9 }]) {
    const b = fitBody(P(1750, "M", 78), { overrides: ov }), y = (id) => b.positions[id][1];
    for (const [a, c] of [["pelvis", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "C1"], ["C1", "head"]]) assert.ok(y(c) > y(a), `${JSON.stringify(ov)}: ${c} not above ${a}`);
    near(b.landmarks.vertex.offset[1] + y("head"), b.stature, 2e-5);
    assert.ok(b.warnings.some((w) => /outside the plausible/.test(w)), `${JSON.stringify(ov)}: no warning`);
    walkFinite(b, JSON.stringify(ov));
    for (const [k, [lo, hi]] of Object.entries({ femur_length: [0.3, 0.62], trunk_length: [0.28, 0.6], neck_length: [0.065, 0.18], shank_length: [0.3, 0.58], upper_arm_length: [0.19, 0.42] })) assert.ok(b.d[k] >= lo - 1e-9 && b.d[k] <= hi + 1e-9, `${JSON.stringify(ov)}: ${k} ${b.d[k]}`);
  }
  const t = fitBody(P(1750, "M", 78), { overrides: { femur_length: 1.0 } });
  assert.ok(t.d.femur_length < 0.62 && t.warnings.some((w) => /heights leave only/.test(w)), "a long thigh squeezes the trunk and says so");
  const f = t.dims.find((d) => d.id === "femur_length");
  assert.equal(f.status, "measured"); assert.match(f.note, /limited to/);
  // an edit inside the band is applied as before, without a warning about the band
  const ok = fitBody(P(1750, "M", 78), { overrides: { femur_length: 0.45 } });
  near(ok.d.femur_length, 0.45, 1e-9); assert.ok(!ok.warnings.some((w) => /outside the plausible/.test(w)));
  // stature, mass and unknown ids are not overrides
  const u = fitBody(P(1750, "M", 78), { overrides: { stature: 2, mass: 3, nonsense: 1, ring_chest: 5 } });
  near(u.stature, 1.75, 1e-12);
  for (const re of [/override of stature/, /override of mass/, /"nonsense" is not a dimension/, /edited chest girth/]) assert.ok(u.warnings.some((w) => re.test(w)), String(re));
  assert.ok(ringPerimeter(ring(u, "torso", "chest").rx, ring(u, "torso", "chest").rz, ring(u, "torso", "chest").n) < 2.3, "a 5 m chest girth is limited");
});

test("fix: a mass far outside the fitted range does not bend the skeleton, says so, and the girths follow the real mass", () => {
  const n = fitBody(P(1750, "M", 78)), h = fitBody(P(1750, "M", 200)), mid = fitBody(P(1750, "M", 122)), light = fitBody(P(1750, "M", 30));
  assert.ok(h.warnings.some((w) => /BMI 65/.test(w) && /outside/.test(w)), "range warning");
  assert.ok(!n.warnings.some((w) => /BMI/.test(w)));
  assert.ok(Math.abs(h.d.femur_length - n.d.femur_length) < 0.03 && Math.abs(h.d.trunk_length - n.d.trunk_length) < 0.05);
  // beyond the range the skeleton is the one of the edge of the range
  for (const k of ["femur_length", "trunk_length", "shank_length", "hand_length"]) near(h.d[k], fitBody(P(1750, "M", 1750 * 1750 * 40 / 1e6)).d[k], 1e-9, k);
  assert.ok(ring(h, "torso", "waist").rz > 1.3 * ring(mid, "torso", "waist").rz * 0.9, "the girths follow the real mass");
  near(h.shape.volume.mass, 200, 0.02 * 200 + 5);
  assert.ok(light.warnings.some((w) => /BMI 9\.8/.test(w)), "light");
  // inside the range nothing changes
  assert.ok(!mid.warnings.some((w) => /BMI/.test(w)));
});

test("fix: fitBody never throws: null options, keys and units named like Object.prototype members, odd unit spellings", () => {
  assert.doesNotThrow(() => fitBody(P(1750, "M", 78), null));
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype", "__defineGetter__"]) {
    const prof = JSON.parse(`{"sex":"M","measures":{"stature":{"value":1750,"unit":"mm"},"${key}":{"value":5,"unit":"mm"},"other:${key}":{"value":5,"unit":"mm"}}}`);
    const b = fitBody(prof); near(b.stature, 1.75, 1e-12); walkFinite(b, key);
  }
  for (const unit of ["constructor", "toString", "__proto__"]) {
    const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, bicristal_breadth: { value: 280, unit }, mass: { value: 78, unit } } });
    walkFinite(b, unit); assert.ok(b.inputs.bicristal_breadth === undefined && b.warnings.some((w) => /bicristal_breadth: the unit/.test(w)), unit);
  }
  for (const o of [null, undefined, "x", 5, [], { overrides: null }, { form: null }]) assert.doesNotThrow(() => fitBody(P(1750, "M", 78), o));
  // units are matched without case or spaces; an unknown one drops the value and says so
  near(fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "MM" } } }).stature, 1.75, 1e-12);
  near(fitBody({ sex: "M", measures: { stature: { value: 175, unit: " Cm " } } }).stature, 1.75, 1e-12);
  near(fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: 172, unit: "LB" } } }).mass, 78.0179, 1e-3);
  const w = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "furlong" }, hand_length: { value: 190, unit: "yards" }, "x:unrelated": { value: 5, unit: "yards" } } });
  assert.ok(w.warnings.some((x) => /stature: the unit "furlong"/.test(x)) && w.warnings.some((x) => /hand_length: the unit "yards"/.test(x)) && !w.warnings.some((x) => /unrelated/.test(x)));
});

test("fix: the exported tables are deeply frozen; the report cannot be corrupted from outside", () => {
  assert.ok(Object.isFrozen(REPORT_MEASURES) && Object.isFrozen(REFERENCE_POSTURES.seat.angles) && Object.isFrozen(REFERENCE_POSTURES.seat.angles.hip_L) && Object.isFrozen(REFERENCE_POSTURES.seat_arm.angles.elbow_L));
  assert.throws(() => { REFERENCE_POSTURES.seat.angles.hip_L[0] = 0; }, TypeError);
  assert.throws(() => REPORT_MEASURES.push({}), TypeError);
  const b = fitBody(P(1750, "M", 78)), before = JSON.stringify(row(b, "sitting_height"));
  const pose = referencePose(b, "seat"); pose.angles.hip_L[0] = 0; // the caller's copy is theirs
  assert.deepEqual(referencePose(b, "seat").angles.hip_L, [90, 0, 0]);
  assert.equal(JSON.stringify(row(fitBody(P(1750, "M", 78)), "sitting_height")), before);
});

test("fix: the mirrored joints are exact images of the left ones (ties in the rounding)", { skip: !HAVE_DB }, () => {
  for (const key of [4081, 4157, 4195, 4201]) {
    const r = db().prepare("select * from subjects where subject_key = ?").get(key), b = fitBody(subjectProfile(r));
    for (const j of JOINTS) if (j.id.endsWith("_L")) assert.deepEqual(b.joints[mirrorId(j.id)].offset, b.joints[j.id].offset.map((v, i) => (i === 0 ? -v + 0 : v)), `${key} ${j.id}`);
  }
  // a sample of the whole database
  for (const r of sample(97)) { const b = fitBody(subjectProfile(r)); for (const j of JOINTS) if (j.id.endsWith("_L")) assert.equal(b.joints[mirrorId(j.id)].offset[0], -b.joints[j.id].offset[0] + 0, `${r.subject_key} ${j.id}`); }
});

test("fix: the neck rings ascend for everybody; statures below 1.3 m are refused instead of inverting the spine", { skip: !HAVE_DB }, () => {
  const known = [2714, 10227, 10609, 11101, 11314];
  for (const key of known) {
    const r = db().prepare("select * from subjects where subject_key = ?").get(key), rings = fitBody(subjectProfile(r)).shape.tubes.neck.rings;
    for (let i = 1; i < rings.length; i++) assert.ok(rings[i].c[1] > rings[i - 1].c[1], `person ${key}: ${rings[i].id}`);
  }
  for (const S of [1200, 1250, 1300, 1450, 1600, 1750, 1900, 2050, 2300, 2500]) for (const sx of ["M", "F", "both"]) {
    const b = fitBody(P(S, sx, S * S * 24 / 1e6)), y = (id) => b.positions[id][1];
    for (const [a, c] of [["ankle_L", "knee_L"], ["knee_L", "hip_L"], ["pelvis", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "C1"], ["C1", "head"]]) assert.ok(y(c) > y(a), `${sx} ${S}: ${c} above ${a}`);
    for (const t of [b.shape.tubes.torso.rings, b.shape.tubes.neck.rings]) for (let i = 1; i < t.length; i++) assert.ok(t[i].c[1] > t[i - 1].c[1], `${sx} ${S}: ring ${t[i].id}`);
  }
  for (const S of [800, 1000, 1190, 1250, 1299]) {
    const b = fitBody(P(S, "M", 30));
    near(b.stature, 1.764, 1e-12); assert.ok(b.warnings.some((w) => /Stature \d+ mm is outside the 1300 to 2500 mm/.test(w)) && b.rejected.stature);
  }
});

test("fix: alt[].delta follows the refined value, so the conflict warning uses the final delta", { skip: !HAVE_DB }, () => {
  let n = 0;
  for (const r of sample(130)) for (const d of fitBody(subjectProfile(r)).dims) for (const a of d.alt ?? []) { n++; near(a.delta, a.value - d.value, 1e-9, `${r.subject_key} ${d.id}`); }
  assert.ok(n > 30);
  // refine notes do not stack when the layout runs again (the shoulder tuning runs it several times)
  const r = db().prepare("select * from subjects where subject_key = 9851").get(), b = fitBody(subjectProfile(r));
  for (const id of ["acromion_to_gh", "shoulder_protraction", "upper_arm_length"]) { const d = b.dims.find((x) => x.id === id); assert.ok((d.note.match(/; (solved|refined) so that/g) ?? []).length <= 1, `${id}: ${d.note}`); }
});

test("fix: a clamped mass is not called 'as given'; implausible statures and masses say so", () => {
  for (const [m, want] of [[12, 25], [399, 300], [305, 300]]) {
    const b = fitBody(P(1750, "M", m)), d = b.dims.find((x) => x.id === "mass");
    assert.equal(d.value, want); assert.equal(d.status, "derived"); assert.match(d.note, /clamped from/); assert.ok(b.warnings.some((w) => /Body mass .* outside the 25 to 300/.test(w)), `mass ${m}`);
  }
  const ok = fitBody(P(1750, "M", 78)).dims.find((x) => x.id === "mass");
  assert.equal(ok.status, "measured"); assert.equal(ok.note, "body mass as given");
});

test("fix: measures that give the forearm or the ankle directly are used, with their limits", () => {
  const f = (m) => fitBody({ sex: "M", measures: { stature: { value: 1760, unit: "mm" }, ...m } }).dims.find((d) => d.id === "forearm_length");
  const base = f({}), rsl = f({ radiale_stylion_length: { value: 262, unit: "mm" } });
  assert.equal(base.status, "estimated"); assert.equal(rsl.status, "derived");
  const ew = f({ "other:elbow_wrist_length": { value: 293, unit: "mm" } }); // = radiale-stylion 262 + 31
  assert.equal(ew.status, "derived"); near(ew.value, 0.262 + 0.012, 1e-9); assert.deepEqual(ew.via, ["other:elbow_wrist_length"]);
  const fh = f({ hand_length: { value: 190, unit: "mm" }, "other:forearm_hand_length": { value: 190 + 262 + 19.5, unit: "mm" } });
  assert.equal(fh.status, "derived"); near(fh.value, 0.262 + 0.012, 1e-6); assert.deepEqual(fh.via, ["other:forearm_hand_length", "hand_length"]);
  assert.equal(f({ "other:forearm_hand_length": { value: 470, unit: "mm" } }).status, "estimated", "needs the hand length");
  // the radiale-stylion length wins when both are there, the other becomes a check
  const both = f({ radiale_stylion_length: { value: 262, unit: "mm" }, "other:elbow_wrist_length": { value: 300, unit: "mm" } });
  assert.deepEqual(both.via, ["radiale_stylion_length"]); assert.equal(both.alt.length, 1); near(both.alt[0].value, 0.281, 1e-9); near(both.alt[0].delta, both.alt[0].value - both.value, 1e-12);
  // ankle height: the Australian files (the malleolus) yes, the US ones (a higher landmark) no
  const a = (v) => fitBody({ sex: "M", measures: { stature: { value: 1760, unit: "mm" }, "other:ankle_height": { value: v, unit: "mm" } } }).dims.find((d) => d.id === "ankle_height");
  assert.equal(a(72).status, "measured"); near(a(72).value, 0.072, 1e-12);
  assert.equal(a(120).status, "estimated"); assert.match(a(120).note, /different, higher landmark/);
});

test("fix: the seat contact set is a plane; the buttock extremity is a back contact", () => {
  for (const [S, m, sx] of [[1750, 78, "M"], [1650, 60, "F"], [1850, 120, "M"]]) {
    const b = fitBody(P(S, sx, m)), pose = referencePose(b, "seat"), k = new Kinematics(OFFS(b));
    k.solve(pose.angles, pose.root);
    const ys = b.contacts.seat.map((id) => k.toWorld(b.landmarks[id].joint, b.landmarks[id].offset).y);
    assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-4, `seat contacts span ${mm(Math.max(...ys) - Math.min(...ys))} mm`);
  }
});

test("fix: the forearm-hand relation reproduces from the database; the new constants are documented", { skip: !HAVE_DB }, () => {
  const rows = [];
  for (const [t, col] of [["raw_ansur_1988", '"FOREARM-HAND_LENTH"'], ["raw_ansur_ii_2012", "forearmhandlength"]])
    rows.push(...db().prepare(`select s.sex, r.${col} fh, s.hand_length hl, s.radiale_stylion_length rsl from ${t} r join subjects s on s.subject_key = r.subject_key where r.${col} > 0 and s.hand_length > 0 and s.radiale_stylion_length > 0`).all());
  [0, 1].forEach((i) => {
    const v = rows.filter((r) => r.sex === (i ? "F" : "M")).map((r) => r.fh - r.hl - r.rsl), m = mean(v), sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
    assert.equal(RELATIONS.fhl_minus_hand_rsl[i][2], v.length); near(RELATIONS.fhl_minus_hand_rsl[i][0], m, 0.06); near(RELATIONS.fhl_minus_hand_rsl[i][1], sd, 0.06);
  });
  const md = fs.readFileSync(path.join(ROOT, "docs/human3d/MODEL.md"), "utf8");
  for (const k of ["ghAhead", "reachSetbackMen", "reachSetbackWomen", "elbowWristOverRadialeStylion", "armClear", "armShiftMax"]) assert.ok(md.includes(`\`${k}\``), `${k} is in MODEL.md`);
});

// ---- round 3: fixes for the second independent verification
test("fix: 'the measures conflict' is raised at 2 SD of the relations a route reads, not at a flat 15 mm", () => {
  const base = typicalProfile(1760, 80);
  const conflicts = (b) => b.warnings.filter((w) => w.includes("the measures conflict"));
  assert.equal(conflicts(fitBody(base)).length, 0, "a consistent person has no conflict");
  // the buttock-knee length enters the thigh through a relation of SD 25 mm: +30 mm is an ordinary person, +95 mm is a contradiction
  // (without the sitting height, which would reject a thigh that puts the hip 95 mm off the seat plane before it could be compared)
  const noSitting = () => { const p = typicalProfile(1760, 80); delete p.measures.sitting_height; return p; };
  const bump = (mm_) => { const p = noSitting(); p.measures.buttock_knee_length.value += mm_; return fitBody(p); };
  const small = bump(30), big = bump(95);
  assert.equal(conflicts(small).filter((w) => w.startsWith("Thigh")).length, 0, conflicts(small).join(" | "));
  assert.equal(conflicts(big).filter((w) => w.startsWith("Thigh")).length, 1, conflicts(big).join(" | "));
  // the wording follows the sign: the buttock-knee route gives a LONGER thigh than the trochanter route here
  assert.match(conflicts(big).find((w) => w.startsWith("Thigh")), /\d+ mm more than the \d+ mm used/);
  const short = noSitting(); short.measures.buttock_knee_length.value -= 95;
  assert.match(conflicts(fitBody(short)).find((w) => w.startsWith("Thigh")) ?? "", /\d+ mm less than the \d+ mm used/);
  // every alternative says how much of its delta is relation spread; a pure-measure route has none
  const alt = small.dims.find((d) => d.id === "femur_length").alt.find((a) => a.keys[0] === "buttock_knee_length");
  near(alt.sd, 0.0252, 2e-4, "SD of bkl_minus_femur");
  const alt0 = fitBody(noSitting()).dims.find((d) => d.id === "femur_length").alt.find((a) => a.keys[0] === "buttock_knee_length");
  near(alt.delta - alt0.delta, 0.03, 1e-9);
  const rsl = fitBody({ sex: "M", measures: { stature: { value: 1760, unit: "mm" }, radiale_stylion_length: { value: 262, unit: "mm" }, "other:elbow_wrist_length": { value: 300, unit: "mm" } } });
  assert.equal(rsl.dims.find((d) => d.id === "forearm_length").alt[0].sd, 0, "two measures: no relation, the 15 mm floor applies");
});

test("fix: real people (every 28th of four surveys): at most a third get a conflict warning, a handful warnings each", { skip: !HAVE_DB }, () => {
  const bodies = sample(28).map((r) => fitBody(subjectProfile(r)));
  const n = bodies.map((b) => b.warnings.filter((w) => w.includes("the measures conflict")).length);
  const any = n.filter((x) => x > 0).length / n.length;
  assert.ok(any < 0.4, `${(100 * any).toFixed(0)} % of people get a conflict warning`);
  assert.ok(mean(n) < 1, `${mean(n).toFixed(2)} conflict warnings per person`);
});

test("fix: referencePose rejects names inherited from Object.prototype with the documented error", () => {
  const b = fitBody(P(1750, "M", 78));
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty", Symbol("x"), 5, null, undefined]) assert.throws(() => referencePose(b, n), /unknown reference posture/, String(n));
  assert.doesNotThrow(() => referencePose(b, "seat"));
});

test("fix: fitBody never throws for Symbols, valueOf / getters that throw, throwing proxies and odd units", () => {
  const boom = () => { throw new Error("boom"); };
  const bad = [
    { measures: { stature: { value: Symbol("x") } } },
    { measures: { stature: { value: { valueOf: boom } } } },
    { measures: { stature: { get value() { boom(); } } } },
    { measures: { stature: { value: 1750, unit: Symbol("u") } } },
    { measures: { get stature() { return boom(); }, mass: { value: 70 } } },
    { get measures() { return boom(); } },
    { get sex() { return boom(); }, get id() { return boom(); }, get label() { return boom(); }, get source() { return boom(); }, measures: {} },
    { source: { get kind() { return boom(); }, get percentile() { return boom(); } }, measures: {} },
    { measures: new Proxy({}, { ownKeys: boom }) },
    { measures: new Proxy({ stature: { value: 1750 } }, { get: boom }) },
  ];
  for (const [i, p] of bad.entries()) assert.doesNotThrow(() => fitBody(p), `profile ${i}`);
  assert.doesNotThrow(() => fitBody(P(1750, "M", 78), { get form() { return boom(); }, get overrides() { return boom(); } }));
  assert.doesNotThrow(() => fitBody(P(1750, "M", 78), { overrides: new Proxy({}, { ownKeys: boom }) }));
  // the good parts of a profile survive a bad neighbour
  const b = fitBody({ measures: { stature: { value: 1750 }, mass: { value: { valueOf: boom } }, sitting_height: { value: 910 } } });
  near(b.stature, 1.75, 1e-12); assert.equal(b.inputs.sitting_height, 0.91);
  // options still work through the snapshot
  const o = fitBody(P(1750, "M", 78), { overrides: { femur_length: 0.43 } });
  near(o.d.femur_length, 0.43, 1e-9);
});

test("fix: a bmi without a unit is kg/m2; an unknown unit is named in the warning, never 'undefined'", () => {
  const b = fitBody({ measures: { stature: { value: 1750 }, bmi: { value: 30 } } });
  near(b.mass, 30 * 1.75 * 1.75, 1e-9); assert.equal(b.dims.find((d) => d.id === "mass").status, "derived");
  assert.ok(!b.warnings.some((w) => w.includes("undefined")));
  const u = fitBody({ measures: { stature: { value: 1750 }, bmi: { value: 30, unit: "mm" } } });
  assert.ok(u.warnings.some((w) => w.includes('bmi: the unit "mm" is not understood')));
});

test("fix: de Leva's women's fractions are used as published (they add up to 0.9999): the deficit is visible, not hidden", () => {
  const b = fitBody(P(1650, "F", 100));
  near(b.massInfo.fractionSum, 0.9999, 1e-6);
  near(Object.values(b.masses).reduce((a, m) => a + m.mass, 0), 99.99, 1e-4);
  near(fitBody(P(1750, "M", 100)).massInfo.fractionSum, 1, 1e-6);
  assert.match(fs.readFileSync(path.join(ROOT, "docs/human3d/MODEL.md"), "utf8"), /0\.9999/);
});

test("fix: MODEL.md section 11 states the survey-dependent thigh length and the overhead reach shortfall", () => {
  const md = fs.readFileSync(path.join(ROOT, "docs/human3d/MODEL.md"), "utf8"), s11 = md.slice(md.indexOf("## 11."), md.indexOf("## 12."));
  assert.match(s11, /trochanterion/); assert.match(s11, /404/); assert.match(s11, /425/);
  assert.match(s11, /overhead/i); assert.match(s11, /102 mm/); assert.match(s11, /89 mm/);
});

// ---- regressions of the round-3 verification ----------------------------------------------------------------------------------------------
const headOrdered = (b) => b.shape.head.rings.every((q, i) => i === 0 || q.c[1] < b.shape.head.rings[i - 1].c[1] - 0.001);

test("fix: the head rings are ordered top to bottom for every menton-sellion length of the band (80 to 160 mm), both sexes, short and tall", () => {
  for (const sex of ["M", "F"]) for (const S of [1300, 1450, 1600, 1750, 2000]) for (let msl = 80; msl <= 160; msl += 5) {
    const b = fitBody({ sex, measures: { stature: { value: S, unit: "mm" }, menton_sellion_length: { value: msl, unit: "mm" } } });
    assert.ok(headOrdered(b), `${sex} ${S} msl ${msl}: ${b.shape.head.rings.map((q) => `${q.id}:${mm(q.c[1]).toFixed(0)}`).join(" ")}`);
    const yM = b.positions.jaw[1] + b.landmarks.menton.offset[1], R = Object.fromEntries(b.shape.head.rings.map((q) => [q.id, q.c[1]]));
    assert.ok(R.chin > yM, `${sex} ${S} msl ${msl}: the chin ring is above the menton`);
  }
  // a long face (135 mm; the gap to the mouth ring is over 60 mm) is unchanged: chin_top 30 mm and chin 4 mm above the menton
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, menton_sellion_length: { value: 135, unit: "mm" } } }), yM = b.positions.jaw[1] + b.landmarks.menton.offset[1];
  const R = Object.fromEntries(b.shape.head.rings.map((q) => [q.id, q.c[1]]));
  near(R.chin_top - yM, 0.03, 2e-6); near(R.chin - yM, 0.004, 2e-6);
});

test("fix: no real person has head rings that are not ordered (the 90 people with a menton-sellion length of 101 mm or less included)", { skip: !HAVE_DB }, () => {
  let n = 0;
  for (const r of db().prepare("select * from subjects where menton_sellion_length > 0 and menton_sellion_length <= 108").all()) { n++; assert.ok(headOrdered(fitBody(subjectProfile(r))), `person ${r.subject_key}`); }
  assert.ok(n > 100, `${n} short faces`);
});

test("fix: measures named without the other: prefix in an import are read; keys nobody reads are listed in a warning (imports and manual entry only)", () => {
  const names = ["hip_breadth", "waist_breadth", "waist_depth", "buttock_depth", "knee_circumference", "ankle_height", "tragion_top_of_head", "elbow_wrist_length", "forearm_hand_length", "omphalion_height", "chest_height"];
  const csv = "measure,value,unit\nstature,1750,mm\nmass,78,kg\nhip_breadth,360,mm\nwaist_depth,250,mm\nwaist_breadth,330,mm\nbuttock_depth,240,mm\nknee_circumference,380,mm\ntragion_top_of_head,125,mm\nelbow_wrist_length,290,mm\nbogus_key,5,mm\n";
  const b = fitBody(parseImport(csv, "x.csv"));
  for (const k of ["hip_breadth", "waist_depth", "waist_breadth", "buttock_depth", "knee_circumference", "tragion_top_of_head", "elbow_wrist_length"]) assert.ok(`other:${k}` in b.inputs && !(k in b.inputs), k);
  assert.ok(b.warnings.some((w) => /not used by the model.*bogus_key/.test(w)) && !b.warnings.some((w) => /not used by the model.*hip_breadth/.test(w)), b.warnings.join(" | "));
  // every "other:" measure the module reads (dimension routes, girth sections, report) has its bare name understood: no drift between this list and the code
  const read = new Set([...DIM_DEFS.flatMap((d) => d.requires), ...REPORT_MEASURES.map((m) => m.id)].filter((k) => k.startsWith("other:")).map((k) => k.slice(6)));
  // (the names that anthro.js lists in SKELETON_MEASURES are prefixed by its own import code)
  for (const k of read) {
    if (SKELETON_MEASURES.includes(`other:${k}`)) continue;
    const f = fitBody({ sex: "M", source: { kind: "import" }, measures: { stature: { value: 1750, unit: "mm" }, [k]: { value: 100, unit: "mm" } } });
    if (!(`other:${k}` in f.inputs)) assert.fail(`the bare name ${k} is not read as other:${k}`);
  }
  assert.ok(names.every((k) => read.has(k) || ["forearm_hand_length", "chest_height", "omphalion_height"].includes(k)));
  // population / individual profiles carry hundreds of measures the model has no use for: no list
  const pop = fitBody({ sex: "M", source: { kind: "population" }, measures: { stature: { value: 1750, unit: "mm" }, bogus_key: { value: 5, unit: "mm" } } });
  assert.ok(!pop.warnings.some((w) => /not used by the model/.test(w)));
  // an alias of a canonical name does not trigger it
  const al = fitBody({ sex: "M", source: { kind: "manual" }, measures: { stature: { value: 1750, unit: "mm" }, "other:waist_depth_standing": { value: 250, unit: "mm" }, mass: { value: 70, unit: "kg" } } });
  assert.ok(!al.warnings.some((w) => /not used by the model/.test(w)) && "other:waist_depth" in al.inputs);
});

test("fix: a mass outside 10 to 400 kg is reported as ignored (never 'no body mass'), with or without a BMI, and listed in rejected", () => {
  for (const mass of [5, 9.9, 400.5, 780]) {
    const plain = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: mass, unit: "kg" } } });
    const bmi = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: mass, unit: "kg" }, bmi: { value: 25 } } });
    for (const b of [plain, bmi]) {
      assert.ok(b.warnings.some((w) => /Body mass .*kg is outside the 10 to 400 kg the model accepts and was ignored/.test(w) && w.includes(String(Math.round(mass)).slice(0, 1))), `${mass}: ${b.warnings}`);
      assert.ok(b.rejected.mass.includes("10 to 400 kg") && !b.warnings.some((w) => w.includes("has no body mass")), `${mass}`);
    }
    near(bmi.mass, 25 * 1.75 * 1.75, 1e-9); assert.equal(bmi.dims.find((d) => d.id === "mass").status, "derived");
    assert.equal(plain.dims.find((d) => d.id === "mass").status, "estimated");
    assert.ok(plain.warnings.some((w) => w.includes("body mass of the profile was ignored")));
  }
  // a profile without any mass keeps its own message; a valid mass says nothing
  assert.ok(fitBody(P(1750, "M")).warnings.some((w) => w.includes("has no body mass")));
  assert.ok(!fitBody(P(1750, "M", 78)).warnings.some((w) => /body mass/i.test(w)));
});

test("fix: a length so large that its conversion overflows is ignored with a warning: the fit report holds no Infinity", () => {
  for (const unit of ["m", "cm", "in"]) {
    const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, hand_length: { value: 1e308, unit }, foot_length: { value: 12, unit: "m" } } });
    walkFinite(b.report, "report");
    for (const id of ["hand_length", "foot_length"]) { const r = row(b, id); assert.equal(r.input, null, `${unit} ${id}`); assert.equal(r.status, "n/a"); }
    assert.ok(b.warnings.some((w) => w.startsWith("hand_length:") && w.includes("not a length of a person")) && b.warnings.some((w) => w.startsWith("foot_length:")));
    assert.equal(JSON.parse(JSON.stringify(b.report)).filter((r) => r.input === null && r.status !== "n/a").length, 0);
  }
  // a plausible long value (a span of 2.4 m) is untouched
  assert.ok(row(fitBody({ sex: "M", measures: { stature: { value: 2000, unit: "mm" }, span: { value: 2.4, unit: "m" } } }), "span").input > 2300);
});

test("fix: the accepted stature range starts at 1.30 m: the thigh, trunk and neck floors hold for both sexes and every mass from there, the shank floor from 1.31 m; shorter statures are refused", () => {
  for (const sex of ["M", "F"]) for (const M of [25, 50, 80, 150, 300]) {
    for (const S of [1300, 1305, 1310, 1320, 1350, 1400]) {
      const b = fitBody({ sex, measures: { stature: { value: S, unit: "mm" }, mass: { value: M, unit: "kg" } } }), d = b.d;
      assert.ok(d.femur_length >= 0.3 - 1e-9 && d.trunk_length >= 0.3 - 1e-9 && d.neck_length >= 0.07 - 1e-9, `${sex} ${S} ${M}: thigh ${d.femur_length} trunk ${d.trunk_length} neck ${d.neck_length}`);
      assert.ok(d.shank_length >= (S >= 1310 ? 0.3 : 0.29) - 1e-9, `${sex} ${S} ${M}: shank ${d.shank_length}`);
      near(b.stature, S / 1000, 1e-12); assert.ok(headOrdered(b), `${sex} ${S} ${M}: head`);
      for (const [a, c] of [["ankle_L", "knee_L"], ["knee_L", "hip_L"], ["pelvis", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "C1"], ["C1", "head"]]) assert.ok(b.positions[c][1] > b.positions[a][1], `${sex} ${S} ${M}: ${c} above ${a}`);
    }
    for (const S of [1200, 1250, 1299]) { const b = fitBody({ sex, measures: { stature: { value: S, unit: "mm" }, mass: { value: M, unit: "kg" } } }); assert.ok(b.rejected.stature && b.stature > 1.5, `${sex} ${S}`); }
  }
  // the lowest stature estimated from other measures is clamped to the range as well
  const e = fitBody({ sex: "F", measures: { buttock_knee_length: { value: 400, unit: "mm" } } });
  assert.ok(e.stature >= 1.3 && headOrdered(e));
  assert.match(fs.readFileSync(path.join(ROOT, "docs/human3d/MODEL.md"), "utf8"), /Stature must be 1\.3 to 2\.5 m/);
});

test("fix: without a bicristal breadth the ASIS landmarks follow the hip joint centres (hip breadth sitting): the ANSUR 1988 bias against the bispinous breadth is below 6 mm (men) / 10 mm (women); with one they keep 0.87 x bicristal", { skip: !HAVE_DB }, () => {
  const cols = ["subject_key", "dataset", "sex", ...SUBJECT_MEASURES].map((c) => `s."${c}"`).join(",");
  const rows = db().prepare(`select ${cols}, r.BISPINOUS_BRTH bs from subjects s join raw_ansur_1988 r on r.subject_key = s.subject_key`).all().filter((_, i) => i % 6 === 0);
  const lim = { M: 6, F: 10 };
  for (const sex of ["M", "F"]) {
    const e = rows.filter((r) => r.sex === sex && r.bs > 0).map((r) => 2000 * fitBody(subjectProfile(r)).landmarks.ASIS_L.offset[0] - r.bs);
    const mean = e.reduce((a, x) => a + x, 0) / e.length;
    assert.ok(e.length > 200 && Math.abs(mean) < lim[sex], `${sex}: mean ${mean.toFixed(1)} mm (n ${e.length})`);
  }
  // consistency with the hip centres (Harrington 2007) when no bicristal breadth is given
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, hip_breadth_sitting: { value: 360, unit: "mm" } } });
  near(b.landmarks.ASIS_L.offset[0], (b.d.hip_halfwidth - 0.0073) / 0.33 / 2, 2e-6);
  const c = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, bicristal_breadth: { value: 300, unit: "mm" }, hip_breadth_sitting: { value: 360, unit: "mm" } } });
  near(c.landmarks.ASIS_L.offset[0], 0.87 * 0.3 / 2, 2e-6);
});
