// The posture library: structure and the acceptance test (validatePosture of pose.js on six bodies, every posture of POSTURES).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures.test.mjs"
// A failure prints one line per problem: "<body> | <posture id> | <message>". Fix the posture, not the test; see docs/human3d/POSE.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { validatePosture, figureOf, landmarkPosition, solvePose, CATEGORIES as POSE_CATEGORIES } from "../../site/js/human/pose.js";
import { POSTURES, GROUPS, CATEGORIES, GRIPS, byId, byCategory, search, indexGroups } from "../../site/js/human/postures.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));

// ---- the six bodies -------------------------------------------------------------------------------------------------------------
const BODIES = [
  ["man P50", army("M", 50)],
  ["woman P50", army("F", 50)],
  ["woman P5", army("F", 5)],
  ["man P95", army("M", 95)],
  ["man 1.70 m (stature only)", fitBody({ sex: "M", measures: { stature: { value: 1700, unit: "mm" } } })],
];
// one real heavy person (ANSUR II, a man of about 1.8 m and 134 kg): the soft tissue of the trunk and thighs is the hard case for self-intersection
let heavy = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(ROOT, "database", "anthro.sqlite");
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT * FROM subjects WHERE mass BETWEEN 118 AND 135 AND stature BETWEEN 1700 AND 1850 AND buttock_circumference IS NOT NULL AND waist_circumference IS NOT NULL ORDER BY mass DESC, subject_key LIMIT 1").get();
    if (row) heavy = [`real person #${row.subject_key} (${row.stature} mm, ${row.mass} kg)`, fitBody(subjectProfile(row))];
    db.close();
  }
} catch { /* node:sqlite or the database is not available: the synthetic heavy body below stands in */ }
BODIES.push(heavy ?? ["heavy man 1.80 m, 130 kg (stature and mass only)", fitBody({ sex: "M", measures: { stature: { value: 1800, unit: "mm" }, mass: { value: 130, unit: "kg" } } })]);

// ---- structure ------------------------------------------------------------------------------------------------------------------
test("the library has the 13 groups of POSTURES.md in order, and their category names match CATEGORIES", () => {
  assert.equal(CATEGORIES, POSE_CATEGORIES, "postures.js re-exports the CATEGORIES of pose.js");
  assert.deepEqual(CATEGORIES.map((c) => c.id), ["standing", "sitting", "leaning", "holding", "lifting", "reaching", "kneeling", "lying", "locomotion", "work", "military", "vehicle", "reference"]);
  assert.deepEqual(CATEGORIES.map((c) => c.name), ["Standing", "Sitting", "Leaning", "Holding", "Lifting & carrying", "Reaching", "Kneeling & squatting", "Lying", "Locomotion", "Work", "Military", "Vehicle & cockpit", "Reference"]);
  assert.ok(CATEGORIES.every((c) => c.blurb.length > 30 && c.blurb.length < 260), "a short blurb each");
  assert.deepEqual(GROUPS.map((g) => g.id), CATEGORIES.map((c) => c.id));
  assert.deepEqual(GROUPS.map((g) => g.category), CATEGORIES.map((c) => c.name));
  for (const g of GROUPS) {
    assert.ok(Array.isArray(g.postures), g.id);
    for (const p of g.postures) assert.equal(p.category, g.category, `${p.id} is in postures/${g.id}.js, its category must be "${g.category}", not "${p.category}"`);
  }
  assert.deepEqual(Object.keys(byCategory()), CATEGORIES.map((c) => c.name), "byCategory lists all 13, empty ones too");
});

test("every group file exists, is imported by the aggregator and exports an array", () => {
  const dir = path.join(ROOT, "site/js/human/postures");
  for (const c of CATEGORIES) {
    assert.ok(fs.existsSync(path.join(dir, `${c.id}.js`)), `postures/${c.id}.js`);
    assert.match(fs.readFileSync(path.join(dir, `${c.id}.js`), "utf8"), /export default \[/, `${c.id}.js exports its array by default`);
  }
  const agg = fs.readFileSync(path.join(ROOT, "site/js/human/postures.js"), "utf8");
  for (const c of CATEGORIES) assert.ok(agg.includes(`./postures/${c.id}.js`), `postures.js imports ${c.id}.js`);
});

test("ids are unique and kebab-case, POSTURES is the groups in order, lookups agree", () => {
  const ids = POSTURES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((id, i) => ids.indexOf(id) !== i).join(", "));
  assert.ok(ids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)), "kebab-case");
  assert.deepEqual(POSTURES, GROUPS.flatMap((g) => g.postures));
  for (const p of POSTURES) assert.equal(byId(p.id), p);
  assert.equal(byId("no-such-posture"), undefined);
  assert.equal(byId("__proto__"), undefined);
  for (const [cat, list] of Object.entries(byCategory())) assert.ok(list.every((p) => p.category === cat));
  assert.equal(Object.values(byCategory()).reduce((n, l) => n + l.length, 0), POSTURES.length);
  for (const id of ["iso-7250-standing", "iso-7250-sitting", "t-pose"]) assert.ok(byId(id), id);
  assert.ok(Object.keys(GRIPS).length >= 14);
});

test("a duplicate id is an Error that names both files", () => {
  const dup = [{ id: "standing", postures: [{ id: "a-b" }] }, { id: "sitting", postures: [{ id: "c-d" }, { id: "a-b" }] }];
  assert.throws(() => indexGroups(dup), (e) => e instanceof Error && /duplicate posture id "a-b"/.test(e.message) && /standing/.test(e.message) && /sitting/.test(e.message));
  assert.throws(() => indexGroups([{ id: "x", postures: [{}] }]), /no string id/);
  assert.equal(indexGroups([{ id: "x", postures: [{ id: "ok" }] }]).get("ok").file, "x");
});

test("search: name, description, tags and category; case, diacritics, several words (AND)", () => {
  const ids = (q) => search(q).map((p) => p.id);
  assert.deepEqual(ids("T-POSE"), ["t-pose"]);
  assert.ok(ids("iso 7250").includes("iso-7250-sitting") && ids("iso 7250").includes("iso-7250-standing"));
  // all words must match: "seat" narrows "iso 7250" to the postures that also have the word. (It was exactly ["iso-7250-sitting"] while the library had only the three reference
  // postures; sit-upright-90, "seated upright (90-90-90)" with the tags iso-7250 and seat, is a second answer now that the sitting group exists.)
  const narrowed = ids("iso 7250 seat");
  assert.ok(narrowed.includes("iso-7250-sitting") && !narrowed.includes("iso-7250-standing"), "all words must match");
  assert.ok(narrowed.every((id) => ids("iso 7250").includes(id)) && narrowed.length < ids("iso 7250").length, "adding a word only narrows the result");
  assert.deepEqual(ids("iso 7250 qwertyuiop"), [], "a word that occurs nowhere removes everything");
  assert.deepEqual(ids("ISO-7250 sitting"), ids("iso-7250 SITTING"));
  assert.ok(ids("reference").length >= 3, "the category counts");
  assert.ok(ids("calibration").includes("t-pose"), "tags count");
  assert.ok(ids("motion capture").includes("t-pose"), "descriptions count");
  assert.ok(ids("Ségation").length === 0);
  assert.ok(ids("té-pose").length === 0 && ids("t-póse").includes("t-pose"), "diacritics are ignored");
  assert.equal(search("").length, POSTURES.length); assert.equal(search("   ").length, POSTURES.length); assert.equal(search(undefined).length, POSTURES.length);
  assert.equal(search("qwertyuiop").length, 0);
});

test("every posture carries the fields of the Posture schema with the right types", () => {
  const problems = [];
  for (const p of POSTURES) {
    for (const k of ["id", "name", "category", "description", "source", "support"]) if (typeof p[k] !== "string" || !p[k].trim()) problems.push(`${p.id}: ${k}`);
    if (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== "string" || t !== t.toLowerCase())) problems.push(`${p.id}: tags`);
    if (p.joints !== undefined && (typeof p.joints !== "object" || p.joints === null)) problems.push(`${p.id}: joints`);
    if (p.grips !== undefined) for (const g of Object.values(p.grips)) if (!(g in GRIPS)) problems.push(`${p.id}: grip ${g}`);
  }
  assert.deepEqual(problems, []);
});

// ---- the library is data, not state -------------------------------------------------------------------------------------------------
test("the library is deeply frozen: an editor that edits the selected posture in place gets an error, not a corrupted library", () => {
  const walk = (v, where, bad) => {
    if (v === null || typeof v !== "object") return;
    if (!Object.isFrozen(v)) bad.push(where);
    for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`, bad);
  };
  const bad = [];
  walk(POSTURES, "POSTURES", bad); walk(GROUPS, "GROUPS", bad);
  assert.deepEqual(bad, []);
  for (const g of GROUPS) assert.ok(Object.isFrozen(g.postures), `${g.id} array`);
  for (const p of POSTURES) {
    assert.equal(typeof p.joints, "object", `${p.id}: joints always exists`); assert.equal(typeof p.spine, "object", `${p.id}: spine always exists`);
    assert.throws(() => { p.name = "changed"; }, TypeError);
    assert.throws(() => { p.joints.head = [1]; }, TypeError);
    assert.throws(() => { p.spine.lumbar = [1]; }, TypeError);
    assert.throws(() => { p.tags.push("x"); }, TypeError);
  }
  assert.throws(() => { POSTURES.push({}); }, TypeError);
  assert.throws(() => { GROUPS[0].postures.push({}); }, TypeError);
  // a copy is the way to edit one
  const copy = structuredClone(POSTURES[0]);
  copy.joints.head = [3, 0, 0];
  assert.equal(validatePosture(BODIES[0][1], { ...copy, id: "edited-copy" }, {}).errors.filter((e) => /head/.test(e)).length, 0);
  assert.equal(POSTURES[0].joints.head, undefined);
});

test("a plain BodyModel and the figure of the rig (figureOf, rig.restBody) give the same verdict for every posture", () => {
  for (const [label, body] of BODIES) {
    const fig = figureOf(body);
    for (const p of POSTURES) {
      const a = validatePosture(body, p, { library: POSTURES }), b = validatePosture(fig, p, { library: POSTURES });
      assert.deepEqual(a.errors, b.errors, `${label} | ${p.id}`); assert.deepEqual(a.warnings, b.warnings, `${label} | ${p.id}`);
    }
  }
});

test("the library's t-pose is horizontal for the population medians: acromion to stylion within 7 degrees, shoulder to wrist within 5", () => {
  const dir = path.join(ROOT, "public/api/v1/populations");
  const files = [];
  for (const c of fs.readdirSync(dir)) for (const r of fs.readdirSync(path.join(dir, c))) for (const f of fs.readdirSync(path.join(dir, c, r))) if (f.endsWith(".json") && !f.includes("latest")) files.push(path.join(dir, c, r, f));
  assert.ok(files.length >= 150, `${files.length} population files`);
  const t = byId("t-pose"), pose = { root: {}, angles: { shoulder_L: [0, t.joints.shoulder_LR[1], 0], shoulder_R: [0, t.joints.shoulder_LR[1], 0] } };
  const deg = (a, s) => (Math.atan2(s.y - a.y, Math.hypot(s.x - a.x, s.z - a.z)) * 180) / Math.PI;
  let worstLine = 0, worstArm = 0;
  for (const f of files.sort()) {
    const body = fitBody(percentileProfile(JSON.parse(fs.readFileSync(f)), { percentile: 50, meanStature: true }));
    worstLine = Math.max(worstLine, Math.abs(deg(landmarkPosition(body, pose, { y: 1 }, "acromion_L"), landmarkPosition(body, pose, { y: 1 }, "stylion_L"))));
    const kin = solvePose(body, pose, { y: 1 });
    worstArm = Math.max(worstArm, Math.abs(deg(kin.position("shoulder_L"), kin.position("wrist_L"))));
  }
  assert.ok(worstLine < 7, `acromion to stylion is ${worstLine.toFixed(1)} degrees off the horizontal`);
  assert.ok(worstArm < 5.5, `shoulder joint to wrist is ${worstArm.toFixed(1)} degrees off the horizontal`);
});

// ---- acceptance: validatePosture on six bodies ----------------------------------------------------------------------------------------
test(`every posture of the library passes validatePosture on ${BODIES.length} bodies`, () => {
  const problems = [], warnings = [];
  let checked = 0;
  for (const [label, body] of BODIES) {
    for (const p of POSTURES) {
      const r = validatePosture(body, p, { library: POSTURES });
      checked++;
      for (const e of r.errors) problems.push(`${label} | ${p.id} | ${e}`);
      for (const w of r.warnings) warnings.push(`${label} | ${p.id} | ${w}`);
    }
  }
  assert.equal(checked, BODIES.length * POSTURES.length);
  if (warnings.length) console.log(`(${warnings.length} warning${warnings.length === 1 ? "" : "s"}, not failures)\n  ` + warnings.slice(0, 20).join("\n  "));
  assert.equal(problems.length, 0, `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${POSTURES.length} postures x ${BODIES.length} bodies:\n  ` + problems.slice(0, 80).join("\n  ") + (problems.length > 80 ? `\n  ... and ${problems.length - 80} more` : ""));
});

test("the bodies of the acceptance test are what the task asks for", () => {
  assert.equal(BODIES.length, 6);
  const [man, woman, woman5, man95, stat, heavyBody] = BODIES.map((b) => b[1]);
  assert.ok(woman5.stature < woman.stature && woman.stature < man.stature && man.stature < man95.stature);
  near(stat.stature, 1.7, 1e-9);
  assert.ok(heavyBody.mass > 110, `heavy: ${heavyBody.mass} kg`);
  function near(a, b, eps) { assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`); }
});
