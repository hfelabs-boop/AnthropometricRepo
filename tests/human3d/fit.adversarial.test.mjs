// Adversarial verification of site/js/human/fit.js (written by an independent verifier, not by the author of fit.js / fit.test.mjs).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/fit.adversarial.test.mjs"
// Principle: nothing here trusts fit.test.mjs. Real people come from database/anthro.sqlite (13,792 subjects, four surveys, both sexes) and the
// raw_* survey tables (columns that fit.js never reads, as independent evidence); populations come from public/api/v1/populations.
// Tests named "KNOWN DEFECT ..." / "OPEN LIMITATION ..." are node:test `todo` tests: they assert the CORRECT behaviour, currently fail, and do not fail the run;
// when the defect is fixed they start to pass (and should be turned into ordinary tests). Tests named "fixed (...)" are defects of earlier rounds that now pass.
// Everything else must pass. Round 3 is at the end of the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  fitBody, evaluateMeasures, referencePose, REFERENCE_POSTURES, REPORT_MEASURES, REGRESSIONS, RELATIONS, CONSTANTS, DIM_DEFS,
  ellipsePerimeter, ringPerimeter, ringArea, sectionFrom,
} from "../../site/js/human/fit.js";
import { JOINTS, BONE_LANDMARKS, mirrorId } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { subjectProfile, SUBJECT_MEASURES, percentileProfile, parseImport } from "../../site/js/human/anthro.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = path.join(ROOT, "database/anthro.sqlite"), POP_DIR = path.join(ROOT, "public/api/v1/populations");
const MODEL_MD = path.join(ROOT, "docs/human3d/MODEL.md");
const HAVE_DB = fs.existsSync(DB_PATH), HAVE_POPS = fs.existsSync(POP_DIR);
const opt = (have) => (have ? {} : { skip: "data not present" });
const mm = (x) => x * 1000;

// ---------------------------------------------------------------------------------------------------------------- helpers
const P = (stature, sex = "M", mass) => ({ id: `adv:${sex}:${stature}:${mass}`, label: "adv", sex, source: { kind: "manual" }, notes: [],
  measures: { ...(stature != null ? { stature: { value: stature, unit: "mm" } } : {}), ...(mass != null ? { mass: { value: mass, unit: "kg" } } : {}) } });
function nonFinite(o, p = "body", out = []) {
  if (typeof o === "number") { if (!Number.isFinite(o)) out.push(`${p}=${o}`); }
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) nonFinite(v, `${p}.${k}`, out);
  return out;
}
const offsetsOf = (b) => Object.fromEntries(JOINTS.filter((j) => j.parent).map((j) => [j.id, b.joints[j.id].offset]));
function world(b, pose = { angles: {} }, root) {
  const kin = new Kinematics(offsetsOf(b));
  kin.solve(pose.angles ?? {}, root ?? pose.root ?? referencePose(b, "stand").root);
  return { kin, w: (id) => kin.toWorld(b.landmarks[id].joint, b.landmarks[id].offset), j: (id) => kin.toWorld(id, [0, 0, 0]) };
}
let _db, _rows;
const db = () => (_db ??= new DatabaseSync(DB_PATH, { readOnly: true }));
function subjects() {
  if (!_rows) {
    const cols = ["subject_key", "dataset", "sex", "branch", ...SUBJECT_MEASURES].map((c) => `"${c}"`).join(", ");
    _rows = db().prepare(`SELECT ${cols} FROM subjects ORDER BY subject_key`).all();
  }
  return _rows;
}
const GROUP = (r) => `${r.dataset}/${r.sex}`;
// every STRIDE-th person: ~800 people, all four surveys and both sexes, deterministic
const STRIDE = 27;
let _full, _min;
// the same people fitted from stature and mass alone (shared by the held-out tests)
function minimalBodies() {
  return (_min ??= sampleBodies().filter(({ r }) => r.stature != null && r.mass != null).map(({ r, prof }) => ({ r, b: fitBody({ ...prof, measures: { stature: prof.measures.stature, mass: prof.measures.mass } }) })));
}
function sampleBodies() {
  if (!_full) _full = subjects().filter((_, i) => i % STRIDE === 0).map((r) => ({ r, prof: subjectProfile(r), b: fitBody(subjectProfile(r)) }));
  return _full;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const rms = (a) => Math.sqrt(mean(a.map((x) => x * x)));
const row = (b, id) => b.report.find((r) => r.id === id && r.kind === "measure");
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ================================================================================================================ 1. API contract
test("API: fitBody returns every field DESIGN 2.2 / MODEL.md section 1 promise, with the documented shapes", () => {
  const b = fitBody(P(1750, "M", 78));
  for (const k of ["version", "profileId", "label", "sex", "form", "formFactor", "stature", "mass", "dims", "d", "joints", "positions", "landmarks", "contacts", "shape", "masses", "massInfo",
    "inputs", "rejected", "warnings", "report", "reportSummary", "spine"]) assert.ok(k in b, `missing ${k}`);
  assert.equal(b.version, 1);
  assert.deepEqual(Object.keys(b.joints).sort(), JOINTS.map((j) => j.id).sort(), "exactly the 77 joints of skeleton.js");
  assert.equal(JOINTS.length, 77);
  assert.deepEqual(Object.keys(b.positions).sort(), JOINTS.map((j) => j.id).sort());
  for (const j of JOINTS) {
    const o = b.joints[j.id].offset;
    assert.ok(Array.isArray(o) && o.length === 3 && o.every(Number.isFinite), j.id);
    // positions are the cumulative sum of the offsets
    const pp = j.parent ? b.positions[j.parent] : [0, 0, 0];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(b.positions[j.id][i] - (pp[i] + o[i])) < 3e-6, `${j.id} position != parent + offset`);
  }
  assert.deepEqual(b.joints.pelvis.offset, b.positions.pelvis, "the pelvis offset is its world position");
  // landmarks: shape, joint exists, group is one of the documented ones, every bone end of skeleton.js present
  const ids = new Set(JOINTS.map((j) => j.id));
  assert.equal(Object.keys(b.landmarks).length, 120, "MODEL.md says 120 landmarks");
  for (const [id, l] of Object.entries(b.landmarks)) {
    assert.ok(ids.has(l.joint), `${id}: unknown joint ${l.joint}`);
    assert.ok(l.offset.length === 3 && l.offset.every(Number.isFinite), id);
    assert.ok(typeof l.label === "string" && l.label.length > 2, id);
    assert.ok(["head", "trunk", "pelvis", "leg", "foot", "arm", "hand"].includes(l.group), `${id}: group ${l.group}`);
    assert.ok(["bony", "surface", "contact"].includes(l.kind), `${id}: kind ${l.kind}`);
  }
  for (const id of BONE_LANDMARKS) assert.ok(b.landmarks[id], `bone landmark ${id} missing`);
  // contacts reference landmarks
  for (const [set, list] of Object.entries(b.contacts)) for (const id of list) assert.ok(b.landmarks[id], `contacts.${set}: ${id}`);
  // dims: the mapping table
  assert.ok(b.dims.length > 40);
  for (const d of b.dims) {
    assert.ok(typeof d.id === "string" && typeof d.label === "string" && typeof d.note === "string", JSON.stringify(d));
    assert.ok(Number.isFinite(d.value) && (d.value > 0 || d.id === "shoulder_protraction"), `${d.id} = ${d.value}`);
    assert.ok(["measured", "derived", "estimated"].includes(d.status), `${d.id}: ${d.status}`);
    assert.ok(Array.isArray(d.via), d.id);
    assert.ok(["m", "kg", "ratio"].includes(d.unit), d.id);
    if (d.status === "estimated") assert.deepEqual(d.via, [], `${d.id}: estimated dimension names measure keys`);
  }
  for (const d of b.dims) if (b.d[d.id] !== undefined) assert.ok(Math.abs(b.d[d.id] - d.value) < 1e-12, `d.${d.id} differs from the dims record`);
  // masses
  assert.equal(Object.keys(b.masses).length, 16);
  for (const [id, m] of Object.entries(b.masses)) assert.ok(m.mass > 0 && ids.has(m.com.joint) && m.com.offset.length === 3, id);
  assert.ok(Math.abs(Object.values(b.masses).reduce((a, m) => a + m.mass, 0) - b.mass) < 1e-3);
  // report
  assert.ok(b.report.length >= 55);
  for (const r of b.report) {
    assert.ok(["measure", "check"].includes(r.kind) && ["ok", "warn", "off", "n/a"].includes(r.status), JSON.stringify(r));
    for (const k of ["id", "label", "unit", "posture", "input", "model", "delta", "tolerance", "note"]) assert.ok(k in r, `${r.id}: ${k}`);
  }
  assert.equal(typeof referencePose, "function");
  assert.ok(Object.isFrozen(REGRESSIONS) && Object.isFrozen(RELATIONS) && Object.isFrozen(CONSTANTS) && Object.isFrozen(DIM_DEFS));
  assert.ok(REPORT_MEASURES.length >= 55);
});

test("API: pure and deterministic: input never mutated, two fits identical, mutating a result cannot change the next fit", () => {
  const prof = JSON.parse(JSON.stringify(sampleProfile()));
  const frozen = JSON.stringify(prof);
  const deepFreeze = (o) => { if (o && typeof o === "object") { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  deepFreeze(prof);
  const a = fitBody(prof), a2 = fitBody(prof);
  assert.equal(JSON.stringify(prof), frozen);
  assert.deepEqual(a, a2);
  const snapshot = JSON.stringify(a);
  // vandalise the first result as hard as possible
  const vandal = (o) => { if (Array.isArray(o)) { o.fill(0); o.push("x"); o.forEach(vandal); } else if (o && typeof o === "object") for (const k of Object.keys(o)) { if (typeof o[k] === "number") o[k] = -9999; else vandal(o[k]); } };
  vandal(a);
  assert.equal(JSON.stringify(fitBody(prof)), snapshot);
  // same numbers in a different key order give the same body
  const rev = { ...prof, measures: Object.fromEntries(Object.entries(prof.measures).reverse()) };
  const sorted = (b) => JSON.stringify({ ...b, inputs: Object.fromEntries(Object.entries(b.inputs).sort()) });
  assert.equal(sorted(fitBody(rev)), sorted(fitBody(prof)));
});
function sampleProfile() {
  return { id: "x", label: "x", sex: "M", source: { kind: "manual" }, notes: [], measures: Object.fromEntries(Object.entries({ stature: 1763, mass: 81.5, sitting_height: 921, hand_length: 191, foot_length: 271, acromion_height: 1452, radiale_stylion_length: 271, buttock_knee_length: 612 }).map(([k, v]) => [k, { value: v, unit: k === "mass" ? "kg" : "mm" }])) };
}

// ================================================================================================================ 2. neutral posture
test("neutral posture: feet flat on the floor, nothing below it, thigh vertical and shank leaning forward by the stance, symmetric, arms hanging, curved spine (real people of all four surveys)", () => {
  const sample = HAVE_DB ? sampleBodies().filter((_, i) => i % 6 === 0) : [{ b: fitBody(P(1750, "M", 78)), r: { subject_key: 0 } }, { b: fitBody(P(1620, "F", 60)), r: { subject_key: 1 } }];
  assert.ok(sample.length >= 2);
  for (const { b, r } of sample) {
    const tag = `person ${r.subject_key}`;
    const { kin, w, j } = world(b);
    // floor: every contact of the feet set at y = 0, no landmark below the floor
    for (const id of b.contacts.feet) assert.ok(Math.abs(w(id).y) < 3e-6, `${tag}: ${id} y = ${w(id).y}`);
    for (const id of Object.keys(b.landmarks)) assert.ok(w(id).y > -3e-6, `${tag}: ${id} below the floor (${w(id).y})`);
    // thigh vertical (hip over knee: every posture is written against it), shank leaning forward about the ankle by the quiet-standing lean (MODEL.md 4.1, 7.1),
    // feet parallel and pointing +Z. STALE since the stance change: the whole leg used to be vertical (ankle under the knee); the ankle now sits behind the knee by
    // stance.ankleBehindKneeM, 3.5 to 4.9 degrees (Di Giulio and Baltzopoulos 2019: knee 21-26 mm in front of the ankle, 3-4 degrees for the whole leg; the model keeps the thigh vertical and
    // caps the shank at 4.9 degrees, K.leanMaxDeg; the sweep of 1,128 bodies has 4.5 to 4.9, MODEL.md 7.1)
    for (const s of ["L", "R"]) {
      const h = j(`hip_${s}`), k = j(`knee_${s}`), a = j(`ankle_${s}`);
      assert.ok(Math.abs(h.x - k.x) < 1e-9 && Math.abs(h.x - a.x) < 1e-9 && Math.abs(h.z - k.z) < 1e-9, `${tag}: thigh ${s} not vertical / shank ${s} not in the sagittal plane of the knee`);
      const lean = Math.atan2(k.z - a.z, k.y - a.y) * 180 / Math.PI; // + = the knee is ahead of the ankle
      assert.ok(k.z - a.z > 0.025 && k.z - a.z < 0.045 && lean > 3.5 && lean <= 4.9 + 1e-3, `${tag}: shank ${s} leans ${lean.toFixed(2)} deg, ankle ${mm(k.z - a.z).toFixed(1)} mm behind the knee`);
      assert.ok(Math.abs(mm(k.z - a.z) - mm(b.stance.ankleBehindKneeM)) < 0.01 && Math.abs(lean - b.stance.shankLeanDeg) < 0.05, `${tag}: body.stance does not describe the geometry`);
      assert.ok(w(`toe_tip_${s}`).z > w(`heel_${s}`).z + 0.15, `${tag}: foot ${s} does not point +Z`);
      assert.ok(Math.abs(w(`toe_tip_${s}`).x - w(`heel_${s}`).x) < 0.03, `${tag}: foot ${s} not parallel to Z`);
    }
    assert.ok(j("hip_L").x > 0 && j("hip_R").x < 0, `${tag}: left is +X`);
    // symmetry: x -> -x for every joint offset and every landmark
    for (const jt of JOINTS) {
      const m = mirrorId(jt.id);
      if (m === jt.id) { assert.equal(b.joints[jt.id].offset[0], 0, `${tag}: midline joint ${jt.id} off the midline`); continue; }
      if (!jt.id.endsWith("_L")) continue;
      const [x, y, z] = b.joints[jt.id].offset, [mx, my, mz] = b.joints[m].offset;
      assert.ok(Math.abs(x + mx) <= 1.5e-6 && y === my && z === mz, `${tag}: ${jt.id} not mirrored`); // exactness: see the KNOWN DEFECT on r6 ties
    }
    for (const [id, l] of Object.entries(b.landmarks)) {
      if (!id.endsWith("_L")) continue;
      const rr = b.landmarks[id.replace(/_L$/, "_R")];
      assert.ok(rr && rr.joint === mirrorId(l.joint) && rr.offset[0] === -l.offset[0] && rr.offset[1] === l.offset[1] && rr.offset[2] === l.offset[2], `${tag}: ${id} twin`);
      assert.ok(w(id).x > 0, `${tag}: ${id} (left) is not at +X (${w(id).x})`);
    }
    // arms hang: shoulder > elbow > wrist, within 25 degrees of vertical, hands near the hip (below pelvis + 12 cm) and above the knees
    for (const s of ["L", "R"]) {
      const sh = j(`shoulder_${s}`), el = j(`elbow_${s}`), wr = j(`wrist_${s}`);
      assert.ok(sh.y > el.y && el.y > wr.y, `${tag}: arm ${s} not hanging`);
      const dir = [wr.x - sh.x, wr.y - sh.y, wr.z - sh.z], len = Math.hypot(...dir);
      assert.ok(Math.acos(-dir[1] / len) < (25 * Math.PI) / 180, `${tag}: arm ${s} tilted ${(Math.acos(-dir[1] / len) * 180 / Math.PI).toFixed(1)} deg`);
      assert.ok(wr.y < j("pelvis").y + 0.12 && wr.y > j(`knee_${s}`).y, `${tag}: wrist ${s} at ${wr.y}`);
    }
    // curved spine: lumbar lordosis (convex forward), thoracic kyphosis (convex backward), cervical lordosis
    const z = (id) => j(id).z, y = (id) => j(id).y;
    const offLine = (a, m, c) => z(m) - (z(a) + ((z(c) - z(a)) * (y(m) - y(a))) / (y(c) - y(a)));
    assert.ok(offLine("L5", "L3", "T12") > 0.004, `${tag}: no lumbar lordosis (${offLine("L5", "L3", "T12")})`);
    assert.ok(offLine("T12", "T6", "T1") < -0.004, `${tag}: no thoracic kyphosis (${offLine("T12", "T6", "T1")})`);
    assert.ok(offLine("C7", "C4", "C1") > 0.0005, `${tag}: no cervical lordosis`);
    assert.ok(Math.abs(z("C7") - z("L5") - CONSTANTS.sva) < 2e-4, `${tag}: trunk not balanced`);
    for (const [a, c] of [["pelvis", "L5"], ["L5", "L1"], ["L1", "T12"], ["T12", "T1"], ["T1", "C7"], ["C7", "C1"], ["C1", "head"]]) assert.ok(y(c) > y(a), `${tag}: ${c} not above ${a}`);
    // the vertex is the highest landmark, the head landmarks are ordered as in ISO 7250 / ANSUR
    const vy = w("vertex").y;
    for (const id of Object.keys(b.landmarks)) assert.ok(w(id).y <= vy + 1e-9, `${tag}: ${id} above the vertex`);
    assert.ok(w("ectocanthus_L").y > w("tragion_L").y && w("tragion_L").y > w("menton").y && w("sellion").y > w("pronasale").y && w("pronasale").y > w("stomion").y, `${tag}: face landmark order`);
    assert.ok(w("glabella").z > w("tragion_L").z && w("opisthocranion").z < w("tragion_L").z, `${tag}: head front/back`);
    assert.ok(w("chest_front").z > w("chest_back").z && w("suprasternale").z > w("cervicale").z && w("omphalion").z > w("waist_back").z && w("patella_L").z > j("knee_L").z, `${tag}: front/back`);
    assert.ok(w("acromion_L").y > w("radiale_L").y && w("radiale_L").y > w("stylion_L").y && w("stylion_L").y > w("dactylion_L").y, `${tag}: arm landmark order`);
    assert.ok(w("iliocristale_L").y > w("trochanterion_L").y && w("trochanterion_L").y > w("crotch").y && w("crotch").y > w("patella_L").y, `${tag}: pelvis/leg landmark order`);
    assert.ok(Math.abs(w("lateral_malleolus_L").y - b.d.ankle_height) < 1e-6 && Math.abs(w("epicondyle_lateral_L").y - b.d.knee_height) < 1e-6, `${tag}: malleolus / epicondyle heights`);
    // whole-body centre of mass: 53 to 59 % of stature, inside the base of support
    const com = b.massInfo.com;
    assert.ok(com[1] / b.stature > 0.53 && com[1] / b.stature < 0.59, `${tag}: COM at ${com[1] / b.stature} of stature`);
    assert.ok(Math.abs(com[0]) < 1e-4 && com[2] > w("heel_L").z && com[2] < w("toe_tip_L").z, `${tag}: COM outside the feet`);
    // quiet standing (Di Giulio and Baltzopoulos 2019: 47-58 mm; Hellebrandt 1940: 40-50 mm; Kawai et al. 1997: 39.6 % of the base of support from the rear edge): the centre
    // of mass is 20 to 50 mm in front of the ankle joint centre and 34 to 40 % of the foot length from the heel: K.comFromHeel (40 %) is the target, the cap on the shank lean (K.leanMaxDeg,
    // 4.9 degrees: the measured lean of the leg is 3 to 4 and the thigh is vertical, so the hip is as far forward as the knee) stops short of it for 98 % of the bodies (MODEL.md 7.1).
    // (Was: 2 mm in front of the ankle, 21 % from the heel.)
    const ahead = mm(com[2] - j("ankle_L").z), fromHeel = (com[2] - w("heel_L").z) / (w("toe_tip_L").z - w("heel_L").z);
    assert.ok(ahead > 20 && ahead < 51, `${tag}: the COM is ${ahead.toFixed(1)} mm in front of the ankle`);
    assert.ok(fromHeel > 0.33 && fromHeel < CONSTANTS.comFromHeel + 1e-3, `${tag}: the COM is ${(fromHeel * 100).toFixed(1)} % of the foot (heel to toe tip) from the heel`);
    // the hand clears the thigh: the lateral palm surface is outside the thigh edge
    const hand = b.shape.hands.L.palm[1], th = b.shape.tubes.thigh_L.rings;
    for (let i = 1; i < th.length; i++) if (hand.c[1] <= th[i - 1].c[1] && hand.c[1] >= th[i].c[1]) {
      const t = (th[i - 1].c[1] - hand.c[1]) / (th[i - 1].c[1] - th[i].c[1]);
      const edge = th[i - 1].c[0] + (th[i].c[0] - th[i - 1].c[0]) * t + th[i - 1].rx + (th[i].rx - th[i - 1].rx) * t;
      assert.ok(hand.c[0] - hand.rx > edge, `${tag}: the hand is inside the thigh by ${mm(edge - hand.c[0] + hand.rx).toFixed(0)} mm`);
    }
  }
});

test("ISO 7250 seated posture closes: feet flat, thighs horizontal, shanks vertical to within the stance lean, seat plane under the ischial tuberosities, sitting height exact", () => {
  const sample = HAVE_DB ? sampleBodies().filter((_, i) => i % 5 === 0) : [{ b: fitBody({ ...P(1750, "M", 78), measures: { ...P(1750, "M", 78).measures, sitting_height: { value: 920, unit: "mm" } } }), r: { subject_key: 0 }, prof: null }];
  for (const { b, r } of sample) {
    const tag = `person ${r.subject_key}`, ref = referencePose(b, "seat");
    const { w, j } = world(b, ref);
    for (const id of b.contacts.feet) assert.ok(Math.abs(w(id).y) < 3e-6, `${tag}: seated ${id} y = ${w(id).y}`);
    for (const s of ["L", "R"]) {
      assert.ok(Math.abs(j(`hip_${s}`).y - j(`knee_${s}`).y) < 1e-9, `${tag}: thigh ${s} not horizontal`);
      // STALE since the stance change (MODEL.md 8.1): hip 90 and knee 90 turn the shank frame by 90 degrees and back, so the seated shank is the shank of the neutral pose:
      // vertical to within the stance lean (the heel a few cm toward the seat), in the sagittal plane, with the knee exactly shank_length above the ankle. Heights are unchanged.
      const kn = j(`knee_${s}`), an = j(`ankle_${s}`);
      assert.ok(Math.abs(kn.x - an.x) < 1e-9, `${tag}: shank ${s} not in the sagittal plane`);
      assert.ok(Math.abs(kn.y - an.y - b.d.shank_length) < 1e-6, `${tag}: shank ${s} not shank_length high`);
      assert.ok(Math.abs(an.z - (kn.z - b.stance.ankleBehindKneeM)) < 1e-6 && Math.atan2(kn.z - an.z, kn.y - an.y) * 180 / Math.PI <= 4.9 + 1e-3, `${tag}: shank ${s} leans back by more than the stance lean (4.9 degrees)`);
      assert.ok(j(`knee_${s}`).z > j(`hip_${s}`).z + 0.3, `${tag}: knee behind hip`);
    }
    const seat = b.d.knee_height - b.d.hip_to_seat;
    for (const id of ["ischial_L", "ischial_R", "thigh_under_L", "thigh_under_R"]) assert.ok(Math.abs(w(id).y - seat) < 3e-6, `${tag}: ${id} not on the seat plane`);
    assert.ok(w("buttock_extremity").y >= seat - 3e-6, `${tag}: buttock below the seat plane`);
    // the vertex is exactly sitting_height above the seat when the profile has one
    const sh = row(b, "sitting_height");
    assert.ok(Math.abs(w("vertex").y - seat - sh.model / 1000) < 3e-6);
    if (sh.input !== null) assert.ok(Math.abs(sh.delta) < 0.01, `${tag}: sitting height delta ${sh.delta} mm`);
    // popliteal and knee heights are above the floor but below the hip
    assert.ok(w("popliteal_L").y < j("knee_L").y && w("knee_top_L").y > j("knee_L").y && w("popliteal_L").y > b.d.ankle_height, tag);
    // the buttock-knee length is in front of the buttock
    assert.ok(w("knee_front_L").z - w("buttock_extremity").z > 0.45, `${tag}: BKL ${w("knee_front_L").z - w("buttock_extremity").z}`);
  }
});

// ================================================================================================================ 3. real people
test("real people (every STRIDE-th of the 13,792, all surveys, both sexes): no exception, no NaN, stature and sitting height exact, measured lengths reproduced", opt(HAVE_DB), () => {
  const S = sampleBodies();
  assert.ok(S.length > 450);
  // MODEL.md 8.2: these are exact by construction for the person who has them
  const EXACT = ["stature", "cervicale_height", "suprasternale_height", "acromion_height", "biacromial_breadth", "chest_circumference", "waist_circumference", "thigh_circumference",
    "calf_circumference", "ankle_circumference", "biceps_circumference_flexed", "forearm_circumference_flexed", "neck_circumference_base", "head_circumference", "radiale_stylion_length",
    "hand_length", "hand_breadth", "foot_length", "foot_breadth", "head_length", "head_breadth", "bizygomatic_breadth", "menton_sellion_length", "interpupillary_breadth", "sitting_height",
    "knee_height_sitting", "bicristal_breadth", "neck_circumference", "buttock_circumference", "thigh_clearance", "acromion_radiale_length", "shoulder_elbow_length", "popliteal_height", "wrist_circumference"];
  const stats = new Map();
  for (const { r, b } of S) {
    const bad = nonFinite(b); assert.deepEqual(bad, [], `person ${r.subject_key}`);
    assert.ok(Math.abs(row(b, "stature").delta) < 0.01, `stature ${r.subject_key}`);
    if (r.sitting_height) assert.ok(Math.abs(row(b, "sitting_height").delta) < 0.01, `sitting height ${r.subject_key}: ${row(b, "sitting_height").delta}`);
    for (const id of EXACT) {
      const x = row(b, id); if (!x || x.status === "n/a") continue;
      const g = stats.get(`${GROUP(r)}|${id}`) ?? { n: 0, bad: 0, ex: null }; g.n++;
      if (x.status === "off") { g.bad++; g.ex ??= `${r.subject_key}: ${x.delta} mm`; } stats.set(`${GROUP(r)}|${id}`, g);
    }
  }
  for (const [k, g] of stats) if (g.n >= 25) assert.ok(g.bad / g.n <= 0.03, `${k}: ${g.bad}/${g.n} off (first ${g.ex})`);
});

test("real people: the fit reproduces what was measured. bones from measured heights equal the measured distances to 2 mm; hip-to-seat plausible", opt(HAVE_DB), () => {
  const bad = [];
  for (const { r, b } of sampleBodies()) {
    const d = b.d;
    // the knee height is the measured epicondyle height only if the person has it: otherwise (subjects table) estimated; trochanterion-based thigh agrees with the measure
    if (r.trochanterion_height && b.dims.find((x) => x.id === "femur_length").formula.startsWith("trochanterion")) {
      const hjc = d.hip_height * 1000 + 5;
      if (Math.abs(hjc - r.trochanterion_height) > 0.5) bad.push(`troch ${r.subject_key}`);
    }
    assert.ok(d.hip_to_seat >= 0.01 && d.hip_to_seat <= 0.18, `hip_to_seat ${d.hip_to_seat}`);
    // upper arm + forearm + hand length versus the survey's acromion-radiale / radiale-stylion / hand length (landmark distances)
    if (r.acromion_radiale_length) assert.ok(Math.abs(row(b, "acromion_radiale_length").delta) < 2, `${r.subject_key} ARL`);
    if (r.radiale_stylion_length) assert.ok(Math.abs(row(b, "radiale_stylion_length").delta) < 2, `${r.subject_key} RSL`);
    // legs: shank + ankle height + thigh = hip height, knee between hip and ankle, thigh and shank within 0.3..0.62 m
    assert.ok(Math.abs(d.hip_height - (d.knee_height + d.femur_length)) < 1e-9 && Math.abs(d.shank_length - (d.knee_height - d.ankle_height)) < 1e-9);
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("INDEPENDENT evidence: ANSUR II forearm-hand length (olecranon to fingertip, elbow at 90 degrees) is not read by fit.js; the model's arm reproduces it", opt(HAVE_DB), () => {
  const raw = new Map(db().prepare("SELECT subject_key, forearmhandlength fh FROM raw_ansur_ii_2012").all().map((x) => [x.subject_key, x.fh]));
  const err = { M: [], F: [] };
  for (const { r, b } of sampleBodies()) {
    const fh = raw.get(r.subject_key); if (!(fh > 0)) continue;
    const { w } = world(b, referencePose(b, "arm90"));
    const o = w("olecranon_L"), d = w("dactylion_L");
    err[r.sex].push(mm(Math.hypot(d.x - o.x, d.y - o.y, d.z - o.z)) - fh);
  }
  for (const sex of ["M", "F"]) {
    assert.ok(err[sex].length > 60, `${sex}: ${err[sex].length} people`);
    assert.ok(Math.abs(mean(err[sex])) < 5 && sd(err[sex]) < 10, `${sex}: bias ${mean(err[sex]).toFixed(1)} sd ${sd(err[sex]).toFixed(1)} mm`);
  }
});

test("held-out: a profile with only stature and mass predicts the person's other measures without group bias above 20 mm (lengths) per survey and sex", opt(HAVE_DB), () => {
  const IDS = ["knee_height_sitting", "popliteal_height", "acromion_height", "cervicale_height", "radiale_stylion_length", "hand_length", "foot_length", "sitting_height"];
  const acc = new Map();
  for (const { r, b: small } of minimalBodies()) {
    for (const id of IDS) { const x = row(small, id); if (r[id] > 0 && x) (acc.get(`${GROUP(r)}|${id}`) ?? acc.set(`${GROUP(r)}|${id}`, []).get(`${GROUP(r)}|${id}`)).push(x.model - r[id]); }
  }
  for (const [k, e] of acc) if (e.length >= 25) assert.ok(Math.abs(mean(e)) <= 20 && rms(e) <= 35, `${k}: bias ${mean(e).toFixed(1)} rms ${rms(e).toFixed(1)} mm (n ${e.length})`);
});

test("held-out: model segment lengths of a 1741 mm / 73 kg man are within 5 % of de Leva (1996) (thigh 422.2, shank 434.0, hand 86.2 mm; upper arm 281.7, forearm 268.9: recalled from Table 4)", () => {
  const b = fitBody(P(1741, "M", 73));
  const near = (got, want, what) => assert.ok(Math.abs(got / want - 1) < 0.05, `${what}: ${mm(got).toFixed(0)} mm vs ${mm(want)} mm`);
  near(b.d.femur_length, 0.4222, "thigh"); near(b.d.shank_length, 0.434, "shank"); near(b.d.upper_arm_length, 0.2817, "upper arm"); near(b.d.forearm_length, 0.2689, "forearm");
  const w = b.positions;
  near(Math.hypot(...w.middle_mcp_L.map((v, i) => v - w.wrist_L[i])), 0.0862, "hand (wrist to 3rd MCP)");
});

// ================================================================================================================ 4. populations
test("every populations file at P5 and P95 (per-measure percentiles) and the P50 scaled median: no exception, no NaN, stature exact, bones in range, adiposity in range, hip-to-seat in range", opt(HAVE_POPS), () => {
  const BONES = { shank_length: [0.3, 0.58], femur_length: [0.3, 0.62], upper_arm_length: [0.19, 0.42], forearm_length: [0.17, 0.36], trunk_length: [0.33, 0.58], neck_length: [0.07, 0.18], hip_to_seat: [0.01, 0.18] };
  let fits = 0;
  for (const c of fs.readdirSync(POP_DIR)) for (const role of fs.readdirSync(path.join(POP_DIR, c))) for (const f of fs.readdirSync(path.join(POP_DIR, c, role))) {
    if (!/^(M|F|both)\.json$/.test(f)) continue;
    const pop = JSON.parse(fs.readFileSync(path.join(POP_DIR, c, role, f), "utf8"));
    for (const [pct, scaling] of [[5, "percentile"], [95, "percentile"], [50, "proportional"]]) {
      let prof; try { prof = percentileProfile(pop, { percentile: pct, scaling, minReliability: "all", meanStature: true }); } catch { continue; }
      const tag = `${c}/${role}/${f} P${pct} ${scaling}`;
      const b = fitBody(prof); fits++;
      assert.deepEqual(nonFinite(b), [], tag);
      const S = prof.measures.stature;
      if (S) assert.ok(Math.abs(b.stature * 1000 - S.value) < 0.01, `${tag}: stature`);
      for (const [k, [lo, hi]] of Object.entries(BONES)) assert.ok(b.d[k] >= lo - 1e-9 && b.d[k] <= hi + 1e-9, `${tag}: ${k} ${b.d[k]}`);
      assert.ok(b.shape.adiposity >= 0.75 - 1e-6 && b.shape.adiposity <= 1.35 + 1e-6, `${tag}: adiposity`);
      const sh = prof.measures.sitting_height;
      if (sh && b.d.hip_to_seat > 0.0101 && b.d.hip_to_seat < 0.1799) assert.ok(Math.abs(row(b, "sitting_height").delta) < 0.01, `${tag}: sitting height closure`);
      // the figure must be a body: chain heights ascend
      const y = (id) => b.positions[id][1];
      for (const [a, z] of [["ankle_L", "knee_L"], ["knee_L", "hip_L"], ["hip_L", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "head"], ["elbow_L", "shoulder_L"], ["wrist_L", "elbow_L"]]) assert.ok(y(z) > y(a), `${tag}: ${z} not above ${a}`);
    }
  }
  assert.ok(fits > 450, `${fits} fits`);
});

// ================================================================================================================ 5. inputs: partial, contradictory, garbage
test("partial inputs: nothing, only stature, stature + mass, only mass, only a hand length, only sitting height: plausible adult, honest status", () => {
  const none = fitBody({ sex: "M", measures: {} });
  assert.ok(Math.abs(none.stature - 1.764) < 1e-9 && none.dims.find((d) => d.id === "stature").status === "estimated" && none.warnings.length > 0);
  const f = fitBody({ sex: "F", measures: {} });
  assert.ok(Math.abs(f.stature - 1.629) < 1e-9);
  const n = fitBody({ sex: "both", measures: {} });
  assert.ok(Math.abs(n.stature - 1.6965) < 1e-4);
  const only = fitBody(P(1700, "M"));
  assert.equal(only.dims.find((d) => d.id === "stature").status, "measured");
  assert.equal(only.dims.find((d) => d.id === "mass").status, "estimated");
  assert.ok(only.warnings.some((w) => /mass/i.test(w)));
  const sm = fitBody(P(1700, "M", 90));
  assert.equal(sm.dims.find((d) => d.id === "mass").status, "measured");
  assert.ok(sm.mass === 90);
  const sit = fitBody({ sex: "M", measures: { sitting_height: { value: 920, unit: "mm" } } });
  assert.equal(sit.dims.find((d) => d.id === "stature").status, "estimated");
  assert.ok(sit.stature > 1.65 && sit.stature < 1.85, `stature from sitting height ${sit.stature}`);
  const hand = fitBody({ sex: "M", measures: { hand_length: { value: 190, unit: "mm" } } });
  assert.ok(Math.abs(row(hand, "hand_length").delta) < 0.01 && Math.abs(hand.stature - 1.764) < 1e-9);
  // a typical person is the median of that sex: a 5 mm change of stature moves the skeleton by about that much, never by a jump
  const a = fitBody(P(1700, "M", 75)), c = fitBody(P(1705, "M", 75));
  for (const k of ["femur_length", "shank_length", "upper_arm_length", "forearm_length", "trunk_length", "hip_halfwidth", "hand_length"]) assert.ok(Math.abs(c.d[k] - a.d[k]) < 0.004, `${k} jumps by ${mm(c.d[k] - a.d[k])} mm for 5 mm of stature`);
  // stature: the vertex is exactly at the stature, mass is exactly the mass
  for (const S of [1300, 1450, 1600, 1750, 1900, 2050, 2300]) for (const sx of ["M", "F", "both"]) {
    const b = fitBody(P(S, sx, S * 0.04)); assert.ok(Math.abs(row(b, "stature").delta) < 0.01);
  }
});

test("units: m, cm, in, lb are converted once; unknown units and non-positive values are ignored with the fallback, never half-applied", () => {
  const s = (v, unit) => fitBody({ sex: "M", measures: { stature: { value: v, unit } } }).stature;
  assert.ok(Math.abs(s(1.75, "m") - 1.75) < 1e-12 && Math.abs(s(175, "cm") - 1.75) < 1e-12 && Math.abs(s(1750, "mm") - 1.75) < 1e-12 && Math.abs(s(68.9, "in") - 1.75006) < 1e-9);
  assert.equal(s(1750, "furlong"), 1.764);
  assert.equal(s(-1750, "mm"), 1.764); assert.equal(s(0, "mm"), 1.764); assert.equal(s(NaN, "mm"), 1.764); assert.equal(s(Infinity, "mm"), 1.764);
  assert.equal(s(790, "mm"), 1.764, "below 0.8 m is ignored"); assert.equal(s(2600, "mm"), 1.764, "above 2.5 m is ignored");
  const m = (v, unit) => fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: v, unit } } }).mass;
  assert.ok(Math.abs(m(172, "lb") - 78.0179) < 1e-3 && m(78, "kg") === 78);
  assert.ok(Math.abs(m(78000, "g") - 80.115) < 0.01, "an unknown mass unit is ignored (median BMI)");
  // a string number and a missing unit
  assert.equal(fitBody({ sex: "M", measures: { stature: { value: "1750", unit: "mm" } } }).stature, 1.75);
  assert.equal(fitBody({ sex: "M", measures: { stature: { value: 1750 } } }).stature, 1.75);
});

test("contradictory inputs: impossible values are rejected with a reason and a warning, the model still closes on stature", () => {
  const cases = [
    ["sitting height above stature", { stature: 1500, sitting_height: 1600 }, "sitting_height"],
    ["sitting height 60 % of stature", { stature: 1750, sitting_height: 1050 }, "sitting_height"],
    ["crotch height 1100 for 1500 mm", { stature: 1500, crotch_height: 1100 }, "crotch_height"],
    ["trochanterion 1200 for 1500 mm", { stature: 1500, trochanterion_height: 1200 }, "trochanterion_height"],
    ["popliteal height 700", { stature: 1700, popliteal_height: 700 }, "popliteal_height"],
    ["knee height sitting 900", { stature: 1700, knee_height_sitting: 900 }, "knee_height_sitting"],
    ["hand length 19 mm (cm slip)", { stature: 1750, hand_length: 19 }, "hand_length"],
  ];
  for (const [name, meas, key] of cases) {
    const b = fitBody({ sex: "M", measures: Object.fromEntries(Object.entries(meas).map(([k, v]) => [k, { value: v, unit: "mm" }])) });
    assert.ok(Math.abs(row(b, "stature").delta) < 0.01, name);
    assert.deepEqual(nonFinite(b), [], name);
    assert.ok(b.rejected[key] || b.dims.some((d) => d.note.includes("outside the plausible")), `${name}: neither rejected nor flagged`);
    assert.ok(b.warnings.length > 0, name);
  }
  // not contradictory enough to reject: a high but possible sitting height gives a warning and the closure still holds
  const hi = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, trochanterion_height: { value: 913, unit: "mm" }, sitting_height: { value: 972, unit: "mm" } } });
  assert.ok(Math.abs(row(hi, "sitting_height").delta) < 0.01 && hi.d.hip_to_seat > 0.125 && hi.warnings.some((w) => /Sitting height and the standing leg heights disagree/.test(w)));
  // two different measures of the same leg that disagree: nothing is averaged, the conflict is reported
  const conf = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, trochanterion_height: { value: 930, unit: "mm" }, crotch_height: { value: 760, unit: "mm" } } });
  assert.ok(conf.dims.find((d) => d.id === "femur_length").alt?.length === 1);
  assert.ok(conf.warnings.some((w) => /the measures conflict/.test(w)));
  assert.ok(conf.report.some((r) => r.kind === "check" && r.status !== "ok"));
});

test("fuzz: 300 real people with random subsets, garbage values, slipped units, odd sexes and options never throw and never leak NaN / Infinity", opt(HAVE_DB), () => {
  const GARB = [NaN, -1, 0, Infinity, -Infinity, 1e12, 1e-12, "abc", "", null, undefined, [], {}, "1750", true, 5, 100000, -5000];
  const rows = subjects(), R = rng(20260101);
  for (let it = 0; it < 300; it++) {
    const p = subjectProfile(rows[Math.floor(R() * rows.length)]);
    const keep = R();
    for (const k of Object.keys(p.measures)) if (R() > keep) delete p.measures[k];
    const ks = Object.keys(p.measures);
    for (let j = 0, n = Math.floor(R() * 5); j < n && ks.length; j++) {
      const k = ks[Math.floor(R() * ks.length)];
      p.measures[k] = R() < 0.8 ? { ...p.measures[k], value: GARB[Math.floor(R() * GARB.length)] } : { ...p.measures[k], unit: ["m", "cm", "in", "lb", "kg", "", "x", null, "MM"][Math.floor(R() * 9)] };
    }
    if (R() < 0.15) { const f = [0.1, 10, 0.0254, 25.4, 2][Math.floor(R() * 5)]; for (const k of Object.keys(p.measures)) if (R() < 0.5 && typeof p.measures[k].value === "number") p.measures[k] = { ...p.measures[k], value: p.measures[k].value * f }; }
    if (R() < 0.1) p.sex = [undefined, null, "x", 5, "Male", "FEMALE", " f "][Math.floor(R() * 7)];
    const o = R() < 0.25 ? { form: ["male", "female", "neutral", "x", undefined][Math.floor(R() * 5)], overrides: R() < 0.5 ? { femur_length: 0.3 + R() * 0.3, hip_halfwidth: R() * 0.2, gh_halfwidth: NaN, upper_arm_length: "x", ring_chest: 0.5 + R() } : undefined } : undefined;
    const b = fitBody(p, o);
    assert.deepEqual(nonFinite(b), [], `iteration ${it}`);
    assert.ok(b.stature > 0 && b.mass > 0 && b.report.length > 40);
  }
});

test("odd profile shapes: undefined, null, strings, arrays, measures of the wrong type, frozen profiles do not throw", () => {
  for (const prof of [undefined, null, "abc", 5, [], {}, { measures: null }, { measures: [{ value: 1750 }] }, { measures: "stature" }, { sex: {}, measures: { stature: null, mass: 5, sitting_height: [] } },
    Object.freeze({ sex: "M", measures: Object.freeze({ stature: Object.freeze({ value: 1750, unit: "mm" }) }) }), { measures: { stature: { value: 1750n, unit: "mm" } } }]) {
    const b = fitBody(prof);
    assert.deepEqual(nonFinite(b), [], JSON.stringify(prof, (k, v) => (typeof v === "bigint" ? String(v) : v)));
    assert.ok(b.warnings.length >= 0 && b.joints.pelvis);
  }
  for (const opts of [undefined, {}, "male", 5, { overrides: [1, 2] }, { overrides: "x" }, { form: 5 }]) assert.ok(fitBody(P(1750, "M", 80), opts).stature === 1.75);
});

// ================================================================================================================ 6. overrides
test("overrides: a user edit inside the plausible band is applied, marked measured, and keeps the stature closure; derived dimensions redirect", () => {
  const base = fitBody(P(1750, "M", 78));
  const b = fitBody(P(1750, "M", 78), { overrides: { shank_length: 0.45, upper_arm_length: 0.3, hand_length: 0.2 } });
  const ua = b.dims.find((d) => d.id === "upper_arm_length");
  assert.ok(ua.status === "measured" && ua.value === 0.3 && ua.via.length === 0 && /overridden/.test(ua.note));
  assert.ok(Math.abs(b.d.shank_length - 0.45) < 1e-9, "shank override edits the knee height");
  assert.ok(Math.abs(b.d.knee_height - (base.d.ankle_height + 0.45)) < 1e-9);
  assert.ok(Math.abs(row(b, "stature").delta) < 0.01);
  assert.ok(Math.abs(b.positions.elbow_L[1] - b.positions.shoulder_L[1] + 0.3 * Math.cos(Math.asin(Math.hypot(b.positions.elbow_L[0] - b.positions.shoulder_L[0], 0) / 0.3))) < 1e-3);
  // pure derivations cannot be edited: ignored with a warning that names what to edit
  const t = fitBody(P(1750, "M", 78), { overrides: { trunk_length: 0.5 } });
  assert.ok(Math.abs(t.d.trunk_length - base.d.trunk_length) < 1e-9 && t.warnings.some((w) => /trunk/i.test(w)));
  // girth overrides
  const g = fitBody(P(1750, "M", 78), { overrides: { ring_chest: 1.2 } });
  assert.ok(Math.abs(ringPerimeter(g.shape.tubes.torso.rings.find((r) => r.id === "chest").rx, g.shape.tubes.torso.rings.find((r) => r.id === "chest").rz, g.shape.tubes.torso.rings.find((r) => r.id === "chest").n) - 1.2) < 2e-3);
});

// ================================================================================================================ 7. literature
test("literature: de Leva (1996) mass fractions and centre-of-mass fractions as published (men and women); Harrington (2007) hip centre", () => {
  const DL = { // [mass fraction, COM fraction from the proximal end] men | women (Visual3D / paper Table 4; shank COM 43.95 as corrected against the paper)
    head: [[0.0694, 0.5002], [0.0668, 0.4841]], upper_arm: [[0.0271, 0.5772], [0.0255, 0.5754]], forearm: [[0.0162, 0.4574], [0.0138, 0.4559]], hand: [[0.0061, 0.79], [0.0056, 0.7474]],
    thigh: [[0.1416, 0.4095], [0.1478, 0.3612]], shank: [[0.0433, 0.4395], [0.0481, 0.4352]], foot: [[0.0137, 0.4415], [0.0129, 0.4014]] };
  for (const [i, sex] of [[0, "M"], [1, "F"]]) {
    const b = fitBody(P(sex === "M" ? 1760 : 1640, sex, 100));
    for (const [seg, v] of Object.entries(DL)) {
      const id = seg === "head" ? "head" : `${seg}_L`, s = b.masses[id];
      assert.ok(Math.abs(s.fraction - v[i][0]) < 1e-6 && Math.abs(s.mass - 100 * v[i][0]) < 1e-5, `${sex} ${seg}: mass ${s.fraction}`);
      assert.ok(Math.abs(s.comFraction - v[i][1]) < 1e-6, `${sex} ${seg}: COM ${s.comFraction}`);
    }
    const trunk = ["trunk_upper", "trunk_middle", "trunk_lower"].reduce((a, k) => a + b.masses[k].fraction, 0);
    assert.ok(Math.abs(trunk - (i === 0 ? 0.4346 : 0.4257)) < 2e-6, `${sex} trunk ${trunk}`);
    assert.ok(Math.abs(b.massInfo.fractionSum - 1) < 2e-4, `fraction sum ${b.massInfo.fractionSum} (de Leva's women's table sums to 0.9999)`);
  }
  // neutral = the mean of the two forms
  const n = fitBody(P(1700, "both", 80)), m = fitBody(P(1700, "M", 80)), w = fitBody(P(1700, "F", 80));
  assert.ok(Math.abs(n.masses.thigh_L.fraction - 0.5 * (m.masses.thigh_L.fraction + w.masses.thigh_L.fraction)) < 1e-6);
  // Harrington et al. 2007 (J Biomech 40:595): hip centre 0.33 PW + 7.3 mm from the midline, ASIS 0.30 PW + 10.9 mm above and 0.24 PD + 9.9 mm in front of it (PD taken as 0.4 PW)
  const h = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, bicristal_breadth: { value: 300, unit: "mm" } } });
  const PW = 0.87 * 0.3;
  assert.ok(Math.abs(h.d.hip_halfwidth - (0.33 * PW + 0.0073)) < 1e-9);
  const asis = h.landmarks.ASIS_L.offset;
  assert.ok(Math.abs(asis[0] - PW / 2) < 2e-6 && Math.abs(asis[1] - (0.3 * PW + 0.0109)) < 2e-6 && Math.abs(asis[2] - (0.24 * 0.4 * PW + 0.0099)) < 2e-6, `ASIS ${asis}`);
  assert.ok(Math.abs(h.landmarks.iliocristale_L.offset[0] - 0.15) < 1e-6, "bicristal breadth is the iliocristale distance");
});

test("literature: a population-typical man has the proportions of Winter 2009 / Drillis-Contini within 8 % (hip, knee, ankle, shoulder heights as fractions of stature)", () => {
  // Winter (2009), Fig 4.1: hip 0.530 H, knee 0.285 H, ankle 0.039 H, shoulder 0.818 H, elbow 0.630 H, wrist 0.485 H (recalled; used with a wide 8 % band)
  const b = fitBody(P(1764, "M", 84)), H = b.stature, y = (id) => b.positions[id][1] / H;
  for (const [id, want] of [["hip_L", 0.53], ["knee_L", 0.285], ["ankle_L", 0.039], ["shoulder_L", 0.818], ["elbow_L", 0.63], ["wrist_L", 0.485]]) assert.ok(Math.abs(y(id) / want - 1) < 0.08, `${id}: ${y(id).toFixed(3)} H vs ${want} H`);
  // women have proportionally shorter trunk-to-leg: both forms have an adult hand length / stature of 0.10 +- 0.01
  for (const sx of ["M", "F"]) { const f = fitBody(P(sx === "M" ? 1764 : 1629, sx, 70)); assert.ok(Math.abs(f.d.hand_length / f.stature - 0.108) < 0.012, `${sx} hand/stature ${f.d.hand_length / f.stature}`); }
});

// ================================================================================================================ 8. documentation versus code
test("MODEL.md versus code: the regression table, the relation table, the constants, the dimension list and the reference postures say what the code does", () => {
  const md = fs.readFileSync(MODEL_MD, "utf8");
  // 9.2 regressions
  const reg = md.split("### 9.2 Regressions")[1].split("### 9.3")[0];
  const cell = (c) => { const m = /^(-?[\d.e-]+) ([+-]) ([\d.e-]+) S ([+-]) ([\d.e-]+) M, SD ([\d.]+), n (\d+)$/.exec(c.trim()); assert.ok(m, `cell "${c}"`); return [Number(m[1]), (m[2] === "-" ? -1 : 1) * Number(m[3]), (m[4] === "-" ? -1 : 1) * Number(m[5]), Number(m[6]), Number(m[7])]; };
  let n = 0;
  for (const m of reg.matchAll(/^\| `(\w+)` \| (.+?) \| (.+?) \|$/gm)) {
    n++; const code = REGRESSIONS[m[1]]; assert.ok(code, `MODEL.md lists ${m[1]}, fit.js does not`);
    assert.deepEqual(cell(m[2]), code[0], `${m[1]} men`); assert.deepEqual(cell(m[3]), code[1], `${m[1]} women`);
  }
  assert.equal(n, Object.keys(REGRESSIONS).length, "every regression of the code is in MODEL.md");
  // 9.3 relations
  const rel = md.split("### 9.3 Relations")[1].split("## 10.")[0];
  let nr = 0;
  for (const m of rel.matchAll(/^\| `(\w+)` \| .+? \| ([\d.-]+), ([\d.]+), (\d+) \| ([\d.-]+), ([\d.]+), (\d+) \|$/gm)) {
    nr++; assert.deepEqual([[+m[2], +m[3], +m[4]], [+m[5], +m[6], +m[7]]], RELATIONS[m[1]], m[1]);
  }
  assert.equal(nr, Object.keys(RELATIONS).length);
  // section 3 constants
  const consts = md.split("## 3. Constants")[1].split("## 4.")[0];
  let nc = 0;
  for (const m of consts.matchAll(/^\| `(\w+)` \| (-?[\d.]+)(?: (?:m|degrees|kg\/m3))? \|/gm)) if (typeof CONSTANTS[m[1]] === "number") { nc++; assert.ok(Math.abs(CONSTANTS[m[1]] - Number(m[2])) < 1e-12, `${m[1]}: code ${CONSTANTS[m[1]]} doc ${m[2]}`); }
  assert.ok(nc >= 12, `${nc} constants compared`);
  // 2.4 dimension ids
  const t24 = md.split("### 2.4 The dimensions")[1].split("### 2.5")[0];
  const docIds = [...t24.matchAll(/^\| `(\w+)` \|/gm)].map((x) => x[1]).sort();
  const codeIds = DIM_DEFS.map((d) => d.id).filter((i) => !/^ring_|^stature$|^mass$|^adiposity$/.test(i)).sort();
  assert.deepEqual(docIds, codeIds);
  // 8.1 reference postures
  const t81 = md.split("### 8.1 Reference postures")[1].split("In the seated postures")[0];
  for (const m of t81.matchAll(/^\| `(\w+)` \| .+? \| (.+) \|$/gm)) {
    if (!REFERENCE_POSTURES[m[1]]) continue;
    const angles = {}; for (const a of m[2].matchAll(/(\w+_[LR]) \[([^\]]*)\]/g)) angles[a[1]] = a[2].split(",").map(Number);
    assert.deepEqual(angles, REFERENCE_POSTURES[m[1]].angles, m[1]);
  }
  // 4.7 / 2.3 thresholds quoted in prose
  assert.match(md, /less than 20 mm or more than 140 mm above the seat plane/);
  const mk = (sh) => fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, trochanterion_height: { value: 913, unit: "mm" }, sitting_height: { value: sh, unit: "mm" } } });
  assert.ok(mk(972).warnings.some((w) => /Sitting height and the standing leg heights/.test(w)) && mk(972).d.hip_to_seat > 0.125, "above 125 mm warns");
  assert.ok(mk(866).warnings.some((w) => /Sitting height and the standing leg heights/.test(w)) && mk(866).d.hip_to_seat < 0.035, "below 35 mm warns");
  assert.ok(!mk(917).warnings.some((w) => /Sitting height and the standing leg heights/.test(w)), "a typical 74 mm does not warn");
  // beyond 140 mm / below 20 mm the sitting height wins over the trochanterion height (legs yield)
  assert.ok(mk(1000).dims.find((d) => d.id === "femur_length").formula.startsWith("stature - sitting height"), "sitting height closure route");
  // the worked example of 2.6 and the claims of section 7 / 4.3
  const w = fitBody(P(1750, "M", 78));
  assert.ok(Math.abs(w.d.ankle_height - 0.07025) < 1e-4 && Math.abs(w.d.knee_height - 0.49328) < 1e-4 && Math.abs(w.d.femur_length - 0.41448) < 1e-4 && Math.abs(w.d.hip_height - 0.90776) < 1e-4);
  // MODEL.md 7: "0.975 m (0.557 of stature), 0.3 mm behind the hip midpoint and 36.0 mm in front of the ankle joint centre, 37.4 % of the foot length from the heel". STALE since the stance
  // change: the old text said 2.4 mm ahead of the hip midpoint and of the ankle (world z 0.002, because the ankle stood under the hip). Height unchanged; the ankles went back instead.
  const comAhead = w.massInfo.com[2] - w.positions.ankle_L[2], comFromHeel = (w.massInfo.com[2] - (w.positions.ankle_L[2] + w.landmarks.heel_L.offset[2])) / w.d.foot_length;
  assert.ok(Math.abs(w.massInfo.com[1] - 0.975) < 0.002 && Math.abs(w.massInfo.com[1] / w.stature - 0.557) < 0.001 && Math.abs(w.massInfo.com[2] + 0.00025) < 0.001, "COM height / behind the hip midpoint");
  assert.ok(Math.abs(mm(comAhead) - 36.0) < 0.5 && Math.abs(comFromHeel - 0.3743) < 0.001, `COM in front of the ankle ${mm(comAhead)} mm, ${comFromHeel} of the foot from the heel`);
  assert.ok(Math.abs(w.stance.shankLeanDeg - 4.9) < 1e-5, "shank lean of the worked example: at the cap of 4.9 degrees (the 40 % of the foot would need 5.9)");
  // quiet standing literature: Hellebrandt 40-50 mm, Di Giulio 47-58 mm in front of the ankle; the model is a little BELOW them on purpose (MODEL.md 7.1: a vertical thigh and a 5.9 degree shank otherwise)
  assert.ok(comAhead > 0.020 && comAhead < 0.050, "20 to 50 mm");
  assert.ok(Math.abs(w.spine.balanceRotationDeg + 4) < 0.2 && Math.abs(w.spine.t1SlopeDeg - 20) < 0.2);
});

test("fixed (docs): MODEL.md section 5 names a fixed carrying joint for the trunk landmarks (T10 / T9 / L4 / T8), fit.js picks it per body", () => {
  const md = fs.readFileSync(MODEL_MD, "utf8");
  const b = fitBody(P(1750, "M", 78));
  const sect = md.split("## 5. Landmarks")[1].split("### Contact sets")[0];
  const wrong = [];
  for (const m of sect.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (\w+) \|/gm)) {
    const ids = m[1].includes("{L,R}") ? [m[1].replace("{L,R}", "L"), m[1].replace("{L,R}", "R")] : [m[1]];
    for (const id of ids) { const j = m[2].includes("{L,R}") ? m[2].replace("{L,R}", id.endsWith("_R") ? "R" : "L") : m[2]; if (b.landmarks[id].joint !== j) wrong.push(`${id}: code ${b.landmarks[id].joint}, doc ${j}`); }
  }
  assert.deepEqual(wrong, []);
});

// ================================================================================================================ 9. section maths
test("section maths: perimeters and areas match independent numerical integration; sectionFrom reproduces breadth, depth and girth when it can", () => {
  const numPer = (a, b, n) => { let s = 0, px = a, pz = 0; const N = 20000; for (let i = 1; i <= N; i++) { const t = (2 * Math.PI * i) / N, c = Math.cos(t), sn = Math.sin(t); const x = a * Math.sign(c) * Math.abs(c) ** (2 / n), z = b * Math.sign(sn) * Math.abs(sn) ** (2 / n); s += Math.hypot(x - px, z - pz); px = x; pz = z; } return s; };
  const numArea = (a, b, n) => { let s = 0, px = a, pz = 0; const N = 20000; for (let i = 1; i <= N; i++) { const t = (2 * Math.PI * i) / N, c = Math.cos(t), sn = Math.sin(t); const x = a * Math.sign(c) * Math.abs(c) ** (2 / n), z = b * Math.sign(sn) * Math.abs(sn) ** (2 / n); s += px * z - x * pz; px = x; pz = z; } return Math.abs(s) / 2; };
  for (const [a, b] of [[0.15, 0.1], [0.1, 0.1], [0.2, 0.05], [0.05, 0.2]]) for (const n of [2, 2.5, 3.3, 5]) {
    assert.ok(Math.abs(ringPerimeter(a, b, n) / numPer(a, b, n) - 1) < 2e-3, `perimeter ${a} ${b} ${n}`);
    assert.ok(Math.abs(ringArea(a, b, n) / numArea(a, b, n) - 1) < 2e-3, `area ${a} ${b} ${n}`);
  }
  assert.ok(Math.abs(ellipsePerimeter(1, 1) - 2 * Math.PI) < 1e-12 && Math.abs(ellipsePerimeter(2, 1) - 9.688448) < 1e-5);
  const s = sectionFrom({ B: 0.34, D: 0.24, G: 0.95 });
  assert.ok(Math.abs(2 * s.rx - 0.34) < 1e-9 && Math.abs(2 * s.rz - 0.24) < 1e-9 && Math.abs(ringPerimeter(s.rx, s.rz, s.n) - 0.95) < 1e-4, "all three reproduced");
  const big = sectionFrom({ B: 0.30, D: 0.24, G: 1.2 }); // more girth than n = 5 holds: the girth wins and the axes grow
  assert.ok(big.k > 1 && Math.abs(big.girth - 1.2) < 1e-4);
  for (const bad of [{}, { B: NaN }]) assert.doesNotThrow(() => sectionFrom(bad));
});

// ================================================================================================================ 10. performance
test("performance: 200 consecutive fits of real people take under 8 ms each on average; a pathological profile (everything 0.5x or 2x) is not slower than 40 ms", opt(HAVE_DB), () => {
  const rows = subjects().filter((_, i) => i % 69 === 0).slice(0, 200).map((r) => subjectProfile(r));
  const t0 = performance.now(); for (const p of rows) fitBody(p); const per = (performance.now() - t0) / rows.length;
  assert.ok(per < 8, `${per.toFixed(2)} ms per fit`);
  for (const f of [0.5, 2]) {
    const p = rows[10]; const q = { ...p, measures: Object.fromEntries(Object.entries(p.measures).map(([k, v]) => [k, { ...v, value: k === "stature" ? v.value : v.value * f }])) };
    const t = performance.now(); const b = fitBody(q); assert.ok(performance.now() - t < 40); assert.deepEqual(nonFinite(b), []);
  }
});

// ================================================================================================================ KNOWN DEFECTS (todo: assert the correct behaviour)
test("fixed (high): evaluateMeasures(body, pose) is not invariant to the figure's heading: breadths read world X, depths read world Z", () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: 78, unit: "kg" } } });
  const stand = referencePose(b, "stand");
  const at = (heading) => Object.fromEntries(evaluateMeasures(b, { root: { ...stand.root, heading }, angles: {} }).map((r) => [r.id, r.model]));
  const a = at(0), c = at(90);
  const moved = Object.keys(a).filter((k) => Math.abs(a[k] - c[k]) > 1);
  assert.deepEqual(moved, [], "a turned figure has the same biacromial breadth (405 mm becomes 0), chest depth, foot length, interpupillary breadth, ...");
});

test("fixed (medium): ANSUR II men: the chest section is 24 mm too wide and 21 mm too deep (girth wins over breadth and depth), 87 % of them 'off'", opt(HAVE_DB), () => {
  const men = sampleBodies().filter(({ r }) => r.dataset === "ansur_ii_2012" && r.sex === "M");
  assert.ok(men.length > 60);
  const e = men.map(({ b }) => row(b, "chest_breadth").delta);
  assert.ok(Math.abs(mean(e)) < 8, `mean chest breadth error ${mean(e).toFixed(1)} mm`);
  assert.ok(men.filter(({ b }) => row(b, "chest_breadth").status === "off").length / men.length < 0.1);
});

test("fixed (medium): the thumbtip reach of a profile without reach is biased long in every survey and sex (+14 to +52 mm, 0.5 to 1.5 residual SD)", opt(HAVE_DB), () => {
  const acc = new Map();
  for (const { r, b: small } of minimalBodies()) {
    if (!(r.thumbtip_reach > 0)) continue;
    (acc.get(GROUP(r)) ?? acc.set(GROUP(r), []).get(GROUP(r))).push(row(small, "thumbtip_reach").model - r.thumbtip_reach);
  }
  for (const [g, e] of acc) if (e.length >= 25) assert.ok(Math.abs(mean(e)) <= 12, `${g}: thumbtip reach bias ${mean(e).toFixed(1)} mm (n ${e.length})`);
});

test("fixed (medium): in the neutral pose the hanging upper arm sinks into the chest (median 43 mm, up to 66 mm at BMI 46) instead of hanging beside it", () => {
  for (const [S, m, sx] of [[1750, 78, "M"], [1750, 110, "M"], [1650, 55, "F"], [1900, 95, "M"]]) {
    const b = fitBody(P(S, sx, m)), ua = b.shape.tubes.upper_arm_L.rings.find((r) => r.id === "ua_biceps"), ch = b.shape.tubes.torso.rings.find((r) => r.id === "chest");
    const overlap = mm(ch.rx - (ua.c[0] - ua.rx));
    assert.ok(overlap < 20, `${sx} ${S} ${m}: biceps ring overlaps the chest ring by ${overlap.toFixed(0)} mm`);
  }
});

test("fixed (medium): the thigh sections are wider than half the hip breadth (213 mm each, 80 mm more than the hip ring for the pair); MODEL.md says the overlap is 'up to 30 mm'", () => {
  for (const sx of ["M", "F"]) {
    const b = fitBody(P(sx === "M" ? 1764 : 1629, sx, sx === "M" ? 84 : 66)), t = b.shape.tubes.thigh_L.rings.find((r) => r.id === "th_prox");
    const cross = mm(t.rx - t.c[0]);
    assert.ok(cross <= 30, `${sx}: the left thigh crosses the midline by ${cross.toFixed(0)} mm`);
  }
});

test("fixed (medium): overrides are not validated: a 1.0 m thigh or a 1.0 m vertex-to-eye distance inverts the skeleton (L5 above C7, head below the hip) while the vertex stays at the stature", () => {
  for (const ov of [{ femur_length: 1.0 }, { hip_height: 3 }, { vertex_to_eye: 1 }, { c7_height: 2.5 }]) {
    const b = fitBody(P(1750, "M", 78), { overrides: ov }), y = (id) => b.positions[id][1];
    for (const [a, c] of [["pelvis", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "C1"], ["C1", "head"]]) assert.ok(y(c) > y(a), `${JSON.stringify(ov)}: ${c} not above ${a}`);
    assert.ok(Math.abs(y("head") + b.landmarks.vertex.offset[1] - b.stature) < 1e-4);
  }
});

test("fixed (medium): a mass far outside the fitted range (BMI above ~45) silently bends the skeleton (thigh -55 mm, trunk +100 mm at 200 kg / 1750 mm) with no warning about the extrapolation", () => {
  const normal = fitBody(P(1750, "M", 78)), heavy = fitBody(P(1750, "M", 200));
  assert.ok(heavy.warnings.some((w) => /mass|BMI|weight/i.test(w) && /outside|extrapolat|range/i.test(w)), "no BMI / mass range warning");
  assert.ok(Math.abs(heavy.d.femur_length - normal.d.femur_length) < 0.03 && Math.abs(heavy.d.trunk_length - normal.d.trunk_length) < 0.05, "the skeleton changed with fat mass");
});

test("fixed (low): fitBody(profile, null) throws; keys / units named like Object.prototype members crash or poison the inputs, against the claim 'never throws for any profile'", () => {
  assert.doesNotThrow(() => fitBody(P(1750, "M", 78), null));
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const prof = JSON.parse(`{"sex":"M","measures":{"stature":{"value":1750,"unit":"mm"},"${key}":{"value":5,"unit":"mm"}}}`);
    assert.doesNotThrow(() => fitBody(prof), key);
  }
  for (const unit of ["constructor", "toString"]) assert.doesNotThrow(() => fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, bicristal_breadth: { value: 280, unit } } }), unit);
});

test("fixed (low): REFERENCE_POSTURES is only shallow-frozen: its angle arrays are the module's own state, so one assignment corrupts every later report", () => {
  assert.ok(Object.isFrozen(REFERENCE_POSTURES.seat.angles) && Object.isFrozen(REFERENCE_POSTURES.seat.angles.hip_L), "reference posture angles must be frozen");
  assert.ok(Object.isFrozen(REPORT_MEASURES));
});

test("fixed (low): the dimension record keeps the pre-refinement delta in alt[].delta (7 % of alternatives, up to 8 mm), and the 'measures conflict' warning uses it", opt(HAVE_DB), () => {
  for (const { b, r } of sampleBodies().slice(0, 300)) for (const d of b.dims) for (const a of d.alt ?? []) assert.ok(Math.abs(a.delta - (a.value - d.value)) < 1e-6, `person ${r.subject_key} ${d.id}: stale delta ${mm(a.delta - (a.value - d.value)).toFixed(1)} mm`);
});

test("fixed (low): neck rings are not strictly ascending for 5 of 13,792 real people (and for every stature below ~1.05 m): the loft folds", opt(HAVE_DB), () => {
  const known = [2714, 10227, 10609, 11101, 11314];
  const rows = subjects().filter((r) => known.includes(r.subject_key));
  assert.equal(rows.length, 5);
  for (const r of rows) {
    const rings = fitBody(subjectProfile(r)).shape.tubes.neck.rings;
    for (let i = 1; i < rings.length; i++) assert.ok(rings[i].c[1] > rings[i - 1].c[1], `person ${r.subject_key}: ${rings[i].id} (${rings[i].c[1]}) not above ${rings[i - 1].id} (${rings[i - 1].c[1]})`);
  }
});

test("fixed (low): the 'seat' contact set contains a point 52 mm above the seat plane (buttock_extremity), so it is not 'the plane through these points'", () => {
  const b = fitBody(P(1750, "M", 78)), ys = b.contacts.seat.map((id) => world(b, referencePose(b, "seat")).w(id).y), lo = Math.min(...ys);
  assert.ok(Math.max(...ys) - lo < 0.01, `seat contacts span ${mm(Math.max(...ys) - lo).toFixed(0)} mm`);
});

test("fixed (low): a mass outside 10..25 / 300..400 kg is clamped but still labelled 'measured, body mass as given'", () => {
  for (const m of [12, 399]) {
    const b = fitBody(P(1750, "M", m)), d = b.dims.find((x) => x.id === "mass");
    assert.ok(d.value === m || /clamp|limit|capped/i.test(d.note), `mass ${m} -> ${d.value} kg, note "${d.note}"`);
  }
});

test("fixed (low): measures that give a forearm, ankle or hand-to-elbow length directly are ignored (other:elbow_wrist_length in 16 population files, other:ankle_height in 18, other:forearm_hand_length in 29)", () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1760, unit: "mm" }, "other:elbow_wrist_length": { value: 300, unit: "mm" } } });
  assert.notEqual(b.dims.find((d) => d.id === "forearm_length").status, "estimated");
});

test("fixed (low): the mirrored joint offsets are not exact mirror images for 342 of 13,792 people (hip_L 0.080511 vs hip_R -0.08051): r6 rounds ties with Math.round, which is asymmetric", opt(HAVE_DB), () => {
  for (const key of [4081, 4157, 4195, 4201]) {
    const r = subjects().find((x) => x.subject_key === key), b = fitBody(subjectProfile(r));
    for (const j of JOINTS) if (j.id.endsWith("_L")) assert.deepEqual(b.joints[mirrorId(j.id)].offset, b.joints[j.id].offset.map((v, i) => (i === 0 ? -v + 0 : v)), `person ${key} ${j.id}`);
  }
});

// ================================================================================================================ ROUND 2 (second verification pass)
test("round 2: every previously known defect now passes (no todo marker needed)", () => {
  // the 16 earlier KNOWN DEFECT tests pass when their todo flag is removed (checked by hand in round 2); this test only pins the cheap ones
  const b = fitBody(P(1750, "M", 78));
  assert.throws(() => Object.assign(REFERENCE_POSTURES.seat.angles.hip_L, [0]), TypeError);
  assert.doesNotThrow(() => fitBody(P(1750, "M", 78), null));
  assert.equal(b.massInfo.com.length, 3);
});

test("round 2: evaluateMeasures tolerates partial / absent poses and a JSON round trip of the body", () => {
  const b = fitBody(P(1750, "M", 78));
  const n = evaluateMeasures(b).length;
  for (const pose of [undefined, null, {}, { angles: {} }, { root: { heading: 20 }, angles: {} }, { root: { y: 1 } }]) assert.equal(evaluateMeasures(b, pose).length, n);
  assert.equal(evaluateMeasures(JSON.parse(JSON.stringify(b))).length, n);
});

test("round 2: independent evidence, USAF 1967 standing dactylion height is reproduced within 15 mm on average (SD about 14 mm)", opt(HAVE_DB), () => {
  const cols = ["subject_key", "dataset", "sex", ...SUBJECT_MEASURES].map((c) => `s."${c}"`).join(",");
  const rows = db().prepare(`select ${cols}, r."V19_DACTYLION HT" dact from subjects s join raw_usaf_1967 r on r.subject_key = s.subject_key`).all().filter((_, i) => i % 9 === 0);
  const d = [];
  for (const r of rows) {
    if (!(r.dact > 0)) continue;
    const b = fitBody(subjectProfile(r)), { w } = world(b, referencePose(b, "stand"));
    d.push(mm(w("dactylion_L").y) - r.dact);
  }
  assert.ok(d.length > 200);
  assert.ok(Math.abs(mean(d)) < 15 && sd(d) < 25, `mean ${mean(d)} sd ${sd(d)}`);
});

// ---- KNOWN DEFECTS found in round 2 (todo: they assert the correct behaviour)
test("fixed (medium): 'the measures conflict' warnings fire for about 95 % of real people (88 % for the thigh alone), because the 15 mm threshold is below the SD of the relations (25 mm)", opt(HAVE_DB), () => {
  const S = sampleBodies();
  const conflict = S.filter(({ b }) => b.warnings.some((w) => w.includes("the measures conflict"))).length;
  assert.ok(conflict / S.length < 0.4, `${conflict} of ${S.length} real people get a conflict warning`);
});

test("fixed (low): referencePose(body, name) with a name that is an Object.prototype member throws SyntaxError instead of the documented 'unknown reference posture' error", () => {
  const b = fitBody(P(1750, "M", 78));
  for (const n of ["constructor", "__proto__", "toString"]) assert.throws(() => referencePose(b, n), /unknown reference posture/);
});

test("fixed (low): fitBody throws for values / getters that throw (Symbol value, valueOf that throws), against 'never throws for any profile'", () => {
  assert.doesNotThrow(() => fitBody({ measures: { stature: { value: Symbol("x") } } }));
  assert.doesNotThrow(() => fitBody({ measures: { stature: { value: { valueOf() { throw new Error("boom"); } } } } }));
});

test("OPEN LIMITATION (low): the segment masses of a woman add up to 99.99 % of her body mass (de Leva women's fractions sum to 0.9999), while the code comment says 1.0000", { todo: "normalise the fractions or document the 0.01 % deficit" }, () => {
  const b = fitBody(P(1650, "F", 100));
  assert.ok(Math.abs(Object.values(b.masses).reduce((a, m) => a + m.mass, 0) - b.mass) < 1e-3);
});

test("fixed (low): a bmi measure without a unit is dropped with a warning that prints the unit as \"undefined\"", () => {
  const b = fitBody({ measures: { stature: { value: 1750 }, bmi: { value: 30 } } });
  assert.ok(!b.warnings.some((w) => w.includes("undefined")));
});

test("OPEN LIMITATION (low): the thigh length depends on the survey's trochanterion definition: ANSUR II men (404 mm) vs ANSUR 1988 men (425 mm) of identical mean stature; the other routes (sitting height 417-419, buttock-knee 408-411) agree with neither", { todo: "route 1 (trochanterion) wins in every survey; nothing is averaged", skip: HAVE_DB ? false : "no db" }, () => {
  const m = (ds) => { const x = sampleBodies().filter(({ r }) => r.dataset === ds && r.sex === "M").map(({ b }) => b.d.femur_length); return mean(x) * 1000; };
  assert.ok(Math.abs(m("ansur_ii_2012") - m("ansur_1988")) < 12, `${m("ansur_ii_2012")} vs ${m("ansur_1988")}`);
});

test("OPEN LIMITATION (low): overhead fingertip reach sitting (ANSUR II) is 100 mm (men) / 87 mm (women) short in the model with the arm at 180 degrees flexion, SD 41 mm: the shoulder girdle does not rise", { todo: "clavicle elevation / scapulohumeral rhythm is not applied by the reference posture; MODEL.md 11 does not state the size of the effect", skip: HAVE_DB ? false : "no db" }, () => {
  const cols = ["subject_key", "dataset", "sex", ...SUBJECT_MEASURES].map((c) => `s."${c}"`).join(",");
  const rows = db().prepare(`select ${cols}, r.overheadfingertipreachsitting oh from subjects s join raw_ansur_ii_2012 r on r.subject_key = s.subject_key`).all().filter((_, i) => i % 12 === 0 && true);
  const d = rows.filter((r) => r.oh > 0 && r.sex === "M").map((r) => {
    const b = fitBody(subjectProfile(r)), ref = referencePose(b, "seat");
    const { w } = world(b, { root: ref.root, angles: { ...ref.angles, shoulder_L: [180, 0, 0], shoulder_R: [180, 0, 0] } });
    return mm(w("dactylion_L").y - w("ischial_L").y) - r.oh;
  });
  assert.ok(Math.abs(mean(d)) < 40, `mean model - measured = ${mean(d)} mm`);
});


// ================================================================================================================ ROUND 3 (third verification pass)
// ---- things that were attacked and held (pinned as ordinary tests)
test("round 3: structure of the whole skin description for real people: tubes ordered, mirrored, weights sum to 1, seams close, feet and fingers well formed", opt(HAVE_DB), () => {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const { r, b } of sampleBodies()) {
    const t = b.shape.tubes, tag = `${r.subject_key}`;
    for (const tn of ["torso", "neck"]) for (let q = 1; q < t[tn].rings.length; q++) assert.ok(t[tn].rings[q].c[1] > t[tn].rings[q - 1].c[1], `${tag}: ${tn} ring ${q}`);
    for (const tn of ["upper_arm_L", "forearm_L", "thigh_L", "shank_L"]) for (let q = 1; q < t[tn].rings.length; q++) assert.ok(dist(t[tn].rings[q].c, t[tn].rings[q - 1].c) >= 0.012, `${tag}: ${tn} ring gap ${q}`);
    for (const [l, rr] of [["thigh_L", "thigh_R"], ["shank_L", "shank_R"], ["upper_arm_L", "upper_arm_R"], ["forearm_L", "forearm_R"]]) t[l].rings.forEach((q, i) => {
      const p = t[rr].rings[i];
      assert.ok(Math.abs(q.c[0] + p.c[0]) < 1e-9 && q.c[1] === p.c[1] && q.c[2] === p.c[2] && q.rx === p.rx && q.rz === p.rz, `${tag}: ${l} ring ${i} not mirrored`);
    });
    for (const tn of Object.keys(t)) for (const q of t[tn].rings) {
      assert.ok(Math.abs(q.bind.reduce((a, x) => a + x[1], 0) - 1) < 1e-5, `${tag}: ${q.id} weights`);
      assert.ok(q.rx > 0.004 && q.rz > 0.004 && q.rx < 0.4 && q.rz < 0.4 && q.n >= 1.79 && q.n <= 12.01, `${tag}: ${q.id} size`);
      for (const [j] of q.bind) assert.ok(b.joints[j], `${tag}: bind joint ${j}`);
    }
    assert.ok(dist(t.torso.rings.at(-1).c, t.neck.rings[0].c) < 1e-9, `${tag}: neck seam`);
    for (const sd of ["L", "R"]) { const st = b.shape.feet[sd].stations; for (let i = 1; i < st.length; i++) assert.ok(st[i].z > st[i - 1].z, `${tag}: foot stations`); for (const s of st) assert.ok(s.rx > 0 && s.top > s.lift, `${tag}: foot station size`); }
    for (const [n, f] of Object.entries(b.shape.hands.L.fingers)) { const pts = [...f.points, f.tip]; for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i], pts[i - 1]) > 0.004, `${tag}: ${n} segment`); }
  }
});

test("round 3: the hands of the neutral pose clear the thighs and hips (palm, knuckles, fingertips, thumb) for real people of all surveys", opt(HAVE_DB), () => {
  for (const { r, b } of sampleBodies()) {
    const W = (id) => { const l = b.landmarks[id], p = b.positions[l.joint]; return [p[0] + l.offset[0], p[1] + l.offset[1], p[2] + l.offset[2]]; };
    const tor = b.shape.tubes.torso.rings, th = [...b.shape.tubes.thigh_L.rings].sort((a, c) => a.c[1] - c.c[1]);
    const at = (rings, y, f) => { if (y <= rings[0].c[1]) return f(rings[0]); for (let i = 1; i < rings.length; i++) if (y <= rings[i].c[1]) { const t = (y - rings[i - 1].c[1]) / (rings[i].c[1] - rings[i - 1].c[1]); return f(rings[i - 1]) * (1 - t) + f(rings[i]) * t; } return f(rings.at(-1)); };
    for (const id of ["palm_centre_L", "dactylion_L", "metacarpale_ulnare_L", "index_tip_L", "little_tip_L", "thumb_tip_L"]) {
      const p = W(id), edge = at(th, p[1], (q) => q.c[0] + q.rx);
      assert.ok(p[0] > edge - 0.002, `${r.subject_key}: ${id} is ${((edge - p[0]) * 1000).toFixed(1)} mm inside the thigh`);
    }
  }
});

test("round 3: population profiles at P1 / P50 / P99, every reliability filter, both scalings, with and without the mean stature: no exception, no NaN, stature exact, bones in range, chain ascending", opt(HAVE_POPS), () => {
  const BONES = { shank_length: [0.3, 0.58], femur_length: [0.3, 0.62], upper_arm_length: [0.19, 0.42], forearm_length: [0.17, 0.36], trunk_length: [0.28, 0.6], neck_length: [0.06, 0.2], hip_to_seat: [0.01, 0.18] };
  let fits = 0, k = 0;
  for (const c of fs.readdirSync(POP_DIR)) for (const role of fs.readdirSync(path.join(POP_DIR, c))) for (const f of fs.readdirSync(path.join(POP_DIR, c, role))) {
    if (!/^(M|F|both)\.json$/.test(f) || k++ % 6) continue; // every sixth file keeps the test fast; the full sweep (5,109 fits) was run by hand
    const pop = JSON.parse(fs.readFileSync(path.join(POP_DIR, c, role, f), "utf8"));
    for (const rel of ["all", "medium", "high"]) for (const pct of [1, 50, 99]) for (const scaling of ["percentile", "proportional"]) for (const meanStature of [false, true]) {
      let prof; try { prof = percentileProfile(pop, { percentile: pct, scaling, minReliability: rel, meanStature }); } catch { continue; }
      const tag = `${c}/${role}/${f} P${pct} ${scaling} ${rel} ${meanStature}`, b = fitBody(prof); fits++;
      assert.deepEqual(nonFinite(b), [], tag);
      const S = prof.measures.stature;
      if (S && S.value >= 1200 && S.value <= 2500) assert.ok(Math.abs(b.stature * 1000 - S.value) < 0.01, `${tag}: stature`);
      for (const [key, [lo, hi]] of Object.entries(BONES)) assert.ok(b.d[key] >= lo - 1e-9 && b.d[key] <= hi + 1e-9, `${tag}: ${key} ${b.d[key]}`);
      const y = (id) => b.positions[id][1];
      for (const [a, z] of [["ankle_L", "knee_L"], ["knee_L", "hip_L"], ["hip_L", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "head"], ["elbow_L", "shoulder_L"], ["wrist_L", "elbow_L"]]) assert.ok(y(z) > y(a), `${tag}: ${z} not above ${a}`);
    }
  }
  assert.ok(fits > 400, `${fits} fits`);
});

test("round 3: one measure at a time (every regression key, +-3 SD, with / without stature and mass): no exception, bones in range, chain ascending, the measure itself reproduced unless it is a posture measure", () => {
  const BONES = { shank_length: [0.3, 0.58], femur_length: [0.3, 0.62], upper_arm_length: [0.19, 0.42], forearm_length: [0.17, 0.36], trunk_length: [0.28, 0.6], neck_length: [0.06, 0.2], hip_to_seat: [0.01, 0.18] };
  const POSTURE = new Set(["abdominal_depth_sitting", "acromion_height_sitting", "elbow_rest_height", "eye_height_sitting", "buttock_popliteal_length", "buttock_knee_length", "thumbtip_reach", "other:wrist_height", "span", "mass"]);
  for (const [key, [m, w]] of Object.entries(REGRESSIONS)) for (const sx of ["M", "F"]) {
    const reg = sx === "M" ? m : w; if (!reg) continue;
    for (const z of [-3, 3]) for (const withS of [false, true]) for (const withM of [z > 0]) for (const k of [key, "other:" + key]) {
      const S = sx === "M" ? 1764 : 1629, M = sx === "M" ? 82 : 62, val = reg[0] + reg[1] * S + reg[2] * M + z * reg[3];
      const meas = { [k]: { value: val, unit: "mm" } }; if (withS) meas.stature = { value: S + z * 30, unit: "mm" }; if (withM) meas.mass = { value: M, unit: "kg" };
      const tag = `${sx} ${k}=${val.toFixed(0)} z${z} S${withS} M${withM}`, b = fitBody({ sex: sx, measures: meas });
      assert.deepEqual(nonFinite(b), [], tag);
      assert.ok(b.stature >= 1.2 && b.stature <= 2.5, tag);
      for (const [bk, [lo, hi]] of Object.entries(BONES)) assert.ok(b.d[bk] >= lo - 1e-9 && b.d[bk] <= hi + 1e-9, `${tag}: ${bk} ${b.d[bk]}`);
      const y = (id) => b.positions[id][1];
      for (const [a, c] of [["ankle_L", "knee_L"], ["knee_L", "hip_L"], ["hip_L", "L5"], ["L5", "T12"], ["T12", "C7"], ["C7", "head"]]) assert.ok(y(c) > y(a), `${tag}: ${c} not above ${a}`);
      const r = row(b, k);
      if (r && !b.rejected[k] && !POSTURE.has(k) && !POSTURE.has(bare(k))) assert.notEqual(r.status, "off", `${tag}: ${k} not reproduced (${r.delta} mm)`);
    }
  }
});
const bare = (k) => k.replace(/^other:/, "");

test("round 3: the body does not depend on the order of the keys of the profile (everything but the order of warnings / inputs)", opt(HAVE_DB), () => {
  const R = rng(5), norm = (x) => JSON.stringify({ ...x, inputs: null, rejected: null, warnings: [...x.warnings].sort() });
  for (const { r, prof } of sampleBodies().filter((_, i) => i % 4 === 0)) {
    const keys = Object.keys(prof.measures).sort(() => R() - 0.5);
    const shuffled = { ...prof, measures: Object.fromEntries(keys.map((k) => [k, prof.measures[k]])) };
    assert.equal(norm(fitBody(shuffled)), norm(fitBody(prof)), `${r.subject_key}`);
  }
});

test("round 3: 1,000 garbage profiles (odd values, units, sexes, options) never throw, never leak NaN, and the report stays evaluable", () => {
  const R = rng(99), pick = (a) => a[Math.floor(R() * a.length)];
  const keys = [...Object.keys(REGRESSIONS), "stature", "mass", "bmi", "sitting_height", "other:ankle_height", "other:elbow_wrist_length", "other:weight_as_reported", "span", "constructor", "__proto__", "toString"];
  const vals = () => pick([0, -0, -5, NaN, Infinity, -Infinity, 1e-300, 1e9, 0.001, 1, 5, 50, 500, 1750, 175, "1750", "abc", "", null, undefined, true, [1750], {}, { valueOf() { return 1700; } }, () => 1, Symbol("x"), 10n, 2 ** 53, -1750]);
  const units = () => pick(["mm", "cm", "m", "in", "MM", " mm ", "kg", "lb", "kg/m2", "N", "", undefined, null, 5, {}, "__proto__", "constructor"]);
  for (let i = 0; i < 1000; i++) {
    const m = {};
    for (let j = 0, n = Math.floor(R() * 12); j < n; j++) m[pick(keys)] = R() < 0.1 ? pick([5, "x", null, [], undefined]) : { value: vals(), unit: units() };
    if (R() < 0.6) m.stature = { value: pick([1500, 1650, 1750, 1900, 2100]), unit: "mm" };
    const opts = R() < 0.3 ? { form: pick(["male", "female", "neutral", "x", null, 5]), overrides: R() < 0.5 ? { [pick(["femur_length", "hip_height", "ring_waist", "stature", "bogus", "__proto__", "upper_arm_length"])]: pick([0.3, -1, NaN, "x", 1e9, 0.5, null, Infinity]) } : undefined } : undefined;
    const b = fitBody({ id: pick(["x", 5, null]), label: pick(["a", 5, null]), sex: pick(["M", "F", "both", "male", undefined, null, 5, {}]), measures: m }, opts);
    // the report may hold an Infinity only for the ABSURD input KNOWN DEFECT below; everything else must be finite
    const bad = nonFinite({ ...b, report: undefined });
    assert.deepEqual(bad, [], `profile ${i}`);
    assert.ok(b.stature >= 1.2 && b.stature <= 2.5);
    assert.doesNotThrow(() => evaluateMeasures(b));
  }
});

// ---- defects of round 3 (todo: they assert the correct behaviour)
test("KNOWN DEFECT (medium): head rings are not ordered top to bottom for a menton-sellion length of 101 mm or less (90 real people, 0.65 %): chin_top lies at or above the mouth ring", { todo: "chin_top = menton + 30 mm and mouth = sellion - 70 mm are both fixed offsets; they cross when menton-sellion < 100 mm; the band of the dimension is 80 to 160 mm" }, () => {
  for (const msl of [80, 90, 100, 101]) {
    const b = fitBody({ sex: "F", measures: { stature: { value: 1600, unit: "mm" }, menton_sellion_length: { value: msl, unit: "mm" } } }), R = b.shape.head.rings;
    assert.ok(R.every((q, i) => i === 0 || q.c[1] < R[i - 1].c[1] - 0.001), `menton-sellion ${msl} mm: ${R.map((q) => `${q.id}:${(q.c[1] * 1000).toFixed(0)}`).join(" ")}`);
  }
});
test("KNOWN DEFECT (medium, real people): 90 of 13,792 people have head rings that are not ordered top to bottom", { todo: "same cause", skip: HAVE_DB ? false : "no db" }, () => {
  let bad = 0;
  for (const r of subjects().filter((x) => x.menton_sellion_length > 0 && x.menton_sellion_length <= 103)) { const R = fitBody(subjectProfile(r)).shape.head.rings; if (!R.every((q, i) => i === 0 || q.c[1] < R[i - 1].c[1] - 0.001)) bad++; }
  assert.equal(bad, 0, `${bad} people`);
});

test("KNOWN DEFECT (medium): the measures fit.js reads under an other: key are not in anthro.js SKELETON_MEASURES, so an imported file that names them without the prefix is silently ignored (no warning, 34 of 38 dimensions estimated)", { todo: "anthro.js BARE_TO_OTHER is built from SKELETON_MEASURES, which lacks other:hip_breadth, waist_breadth, waist_depth, buttock_depth, knee_circumference, ankle_height, tragion_top_of_head, elbow_wrist_length, forearm_hand_length (fit.js reads them; its ALIAS map does not add the bare names either)" }, () => {
  const csv = "measure,value,unit\nstature,1750,mm\nmass,78,kg\nhip_breadth,360,mm\nwaist_depth,250,mm\nwaist_breadth,330,mm\nbuttock_depth,240,mm\nknee_circumference,380,mm\ntragion_top_of_head,125,mm\nelbow_wrist_length,290,mm\n";
  const prof = parseImport(csv, "x.csv"), b = fitBody(prof);
  const used = ["other:hip_breadth", "other:waist_depth", "other:waist_breadth", "other:buttock_depth", "other:knee_circumference", "other:tragion_top_of_head", "other:elbow_wrist_length"].filter((k) => k in b.inputs);
  assert.equal(used.length, 7, `fit.js received ${Object.keys(b.inputs)} and used only ${used}`);
});

test("KNOWN DEFECT (low): a value so large that its conversion to millimetres overflows (1e308 m) puts Infinity into the fit report and calls the row 'warn'", { todo: "evaluateMeasures multiplies the input by 1000 after the 6 SD screen has already rejected it; readInputs has no upper bound" }, () => {
  const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, hand_length: { value: 1e308, unit: "m" } } });
  assert.deepEqual(nonFinite(b), []);
});

test("KNOWN DEFECT (low): a mass of 5 kg (or 780 kg) is dropped and the warning says 'The profile has no body mass'; with a BMI present nothing is said at all", { todo: "massDim ignores a mass outside 10..400 kg silently; only the 'no mass' branch warns" }, () => {
  for (const mass of [5, 780]) {
    const b = fitBody({ sex: "M", measures: { stature: { value: 1750, unit: "mm" }, mass: { value: mass, unit: "kg" }, bmi: { value: 25 } } });
    assert.ok(b.warnings.some((w) => w.includes(String(mass))), `mass ${mass} kg: ${b.warnings}`);
  }
});

test("KNOWN DEFECT (low): the accepted stature range starts at 1.2 m but the documented floors of the skeleton (thigh 0.30, trunk 0.30, neck 0.07 m) break below 1.30 m (men) / 1.27 m (women), and the head rings of women below 1.22 m are not ordered", { todo: "MODEL.md 2.1 says a stature below 1.2 m cannot honour the floors; they are already broken up to 1.30 m (the 'squeezed' warning does fire)" }, () => {
  for (const sex of ["M", "F"]) for (let S = 1200; S <= 1300; S += 10) {
    const b = fitBody({ sex, measures: { stature: { value: S, unit: "mm" } } });
    assert.ok(b.d.femur_length >= 0.3 - 1e-9 && b.d.trunk_length >= 0.3 - 1e-9 && b.d.neck_length >= 0.07 - 1e-9, `${sex} ${S}: thigh ${b.d.femur_length} trunk ${b.d.trunk_length} neck ${b.d.neck_length}`);
  }
});

test("KNOWN DEFECT (low): the ASIS landmarks are 9 to 11 mm wider than the bispinous breadth measured on 996 ANSUR 1988 people (SD 17 to 19 mm): K.asis = 0.87 overshoots", { todo: "K.asis is marked approx.; the raw ANSUR 1988 table has BISPINOUS_BRTH, which would calibrate it (men 231 mm, women 220 mm on average)", skip: HAVE_DB ? false : "no db" }, () => {
  const cols = ["subject_key", "dataset", "sex", ...SUBJECT_MEASURES].map((c) => `s."${c}"`).join(",");
  const rows = db().prepare(`select ${cols}, r.BISPINOUS_BRTH bs from subjects s join raw_ansur_1988 r on r.subject_key = s.subject_key`).all().filter((_, i) => i % 4 === 0);
  for (const sex of ["M", "F"]) {
    const e = rows.filter((r) => r.sex === sex && r.bs > 0).map((r) => 2000 * fitBody(subjectProfile(r)).landmarks.ASIS_L.offset[0] - r.bs);
    assert.ok(Math.abs(mean(e)) < 5, `${sex}: model ASIS-ASIS minus bispinous = ${mean(e).toFixed(1)} mm`);
  }
});
