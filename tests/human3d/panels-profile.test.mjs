// The pure parts of the Profile and Skeleton panels (site/js/human/panels/profile.js and skeleton.js): dimension rows, grouping, filtering, editing and
// reverting dimensions, profile ids, the fit report, paging, import messages, manual entry, the joint -> dimension mapping (checked against fit.js: moving a
// dimension must only move joints that list it), the joint tree, ranges of motion and the CSV of all points. No DOM, no WebGL.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/panels-profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import profilePanel from "../../site/js/human/panels/profile.js";
import skeletonPanel from "../../site/js/human/panels/skeleton.js";
import { fitBody, DIM_DEFS, evaluateMeasures } from "../../site/js/human/fit.js";
import * as anthro from "../../site/js/human/anthro.js";
import { JOINTS, JOINT_BY_ID, BONES } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { fmtLength } from "../../site/js/human/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(ROOT, "public/api/v1");
const haveData = fs.existsSync(path.join(DATA, "index.json"));
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8"));
const popFile = (country, role, sex) => readJSON(`populations/${country}/${role}/${sex}.json`);
const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);

const profiles = {};
if (haveData) {
  profiles.armyM = anthro.percentileProfile(popFile("united-states", "army", "M"), { percentile: 50 });
  profiles.armyF = anthro.percentileProfile(popFile("united-states", "army", "F"), { percentile: 30 });
}
profiles.manual = anthro.manualProfile({ sex: "M", stature: 1755, mass: 80 });
profiles.manualF = anthro.manualProfile({ sex: "F", stature: 1650, mass: 62 });
const bodies = Object.fromEntries(Object.entries(profiles).map(([k, p]) => [k, fitBody(p, {})]));

// ------------------------------------------------------------------------------------------------------------------ modules
test("both panels are modules the shell can load: default { id, label, order, mount }", () => {
  assert.deepEqual([profilePanel.id, profilePanel.label, profilePanel.order, typeof profilePanel.mount], ["profile", "Profile", 1, "function"]);
  assert.deepEqual([skeletonPanel.id, skeletonPanel.label, skeletonPanel.order, typeof skeletonPanel.mount], ["skeleton", "Skeleton", 5, "function"]);
});

// ------------------------------------------------------------------------------------------------------------------ numbers
test("parseNumber reads what people type", () => {
  assert.equal(P.parseNumber("1755"), 1755);
  assert.equal(P.parseNumber(" 80 "), 80);
  assert.equal(P.parseNumber("175,5"), 175.5);
  assert.equal(P.parseNumber("1,755"), 1755);
  assert.equal(P.parseNumber("1,755.5"), 1755.5);
  assert.equal(P.parseNumber("-3.5"), -3.5);
  assert.equal(P.parseNumber(".5"), 0.5);
  assert.equal(P.parseNumber(12), 12);
  for (const bad of ["", "  ", "abc", "12 mm", "1.2.3", "Infinity", NaN, Infinity, null, undefined, "0x10", "1e", "--1"]) assert.ok(Number.isNaN(P.parseNumber(bad)), String(bad));
});

test("units and number formatting", () => {
  assert.equal(P.toMm(175, "cm"), 1750);
  assert.equal(P.toMm(2, "m"), 2000);
  near(P.toMm(69, "in"), 1752.6, 1e-9);
  assert.ok(Number.isNaN(P.toMm(1, "ft")));
  assert.equal(P.fmtSigned(1.234), "+1.2");
  assert.equal(P.fmtSigned(-0.04), "0.0");
  assert.equal(P.fmtSigned(-3.2), "−3.2");
  assert.equal(P.fmtSigned(0, 2), "0.00");
  assert.equal(P.fmtSigned(null), "—");
  assert.deepEqual(["mm", "cm", "in"].map(P.deltaDigits), [1, 2, 3]);
  assert.equal(P.fmtKg(76.34), "76.3 kg");
  assert.equal(P.fmtKg(NaN), "—");
  assert.equal(P.fmtQuantity(1749.3, "mm", "mm"), "1,749 mm");
  assert.equal(P.fmtQuantity(1749.3, "mm", "cm"), "174.9 cm");
  assert.equal(P.fmtQuantity(76.34, "kg"), "76.3 kg");
  assert.equal(P.fmtQuantity(0.9876, "ratio"), "0.988");
  assert.equal(P.fmtQuantity(undefined, "mm"), "—");
});

// ------------------------------------------------------------------------------------------------------------------ populations
test("populationOptions: only combinations that exist, selections are corrected", { skip: !haveData }, async () => {
  const index = await anthro.loadIndex("api/v1", async (u) => readJSON(u.replace(/^api\/v1\//, "")));
  const o = P.populationOptions(index, { country: "united-states", role: "army", sex: "F" });
  assert.deepEqual(o.sel, { country: "united-states", role: "army", sex: "F" });
  assert.equal(o.entry.country_id, "united-states");
  assert.ok(o.countries.length > 30 && o.roles.length >= 10 && o.sexes.length >= 2);
  assert.deepEqual(o.sexes.map((x) => x.id), ["M", "F"].filter((x) => o.sexes.some((y) => y.id === x)));
  assert.match(o.sexes.find((x) => x.id === "M").label, /^Men · \d+ measures$/, "the number of published measures is in the label");
  assert.equal(o.sexes.find((x) => x.id === "M").measures, index.populations.find((p) => p.country_id === "united-states" && p.role_id === "army" && p.sex === "M").measures);
  // every (country, role, sex) the lists offer is a real population
  for (const c of index.countries.slice(0, 40)) {
    const oc = P.populationOptions(index, { country: c.id });
    for (const r of oc.roles) {
      const or = P.populationOptions(index, { country: c.id, role: r.id });
      for (const s of or.sexes) assert.ok(P.populationOptions(index, { country: c.id, role: r.id, sex: s.id }).entry, `${c.id}/${r.id}/${s.id}`);
    }
  }
  // unknown country -> the first; role the country lacks -> its first; sex the role lacks -> men if possible, else the first
  const bad = P.populationOptions(index, { country: "atlantis", role: "wizard", sex: "F" });
  assert.equal(bad.sel.country, index.countries[0].id);
  const noRole = P.populationOptions(index, { country: "united-states", role: "no-such-role", sex: "M" });
  assert.equal(noRole.sel.role, index.countries.find((c) => c.id === "united-states").roles[0].id);
  const nl = P.populationOptions(index, { country: "netherlands", role: "army", sex: "F" });
  assert.equal(nl.sel.sex, "M", "the Dutch army has men only: F becomes M");
  assert.deepEqual(nl.sexes.map((x) => x.label), ["Men · 1 measure"], "singular for one");
  assert.deepEqual(P.populationOptions(null, {}).countries, []);
  // few measures
  const hint = P.populationHint(nl.entry);
  assert.equal(hint.measures, 1);
  assert.ok(hint.few && /Only 1 measure is published/.test(hint.text), hint.text);
  const us = P.populationHint(o.entry);
  assert.ok(!us.few && /203|measures are published/.test(us.text), us.text);
  assert.equal(P.populationHint(null).few, true);
});

test("selectionOfProfile puts the controls back; readLast / writeLast keep only three select values and survive blocked storage", () => {
  const prof = anthro.percentileProfile({ population: { country: "Canada", role: "Army", country_id: "canada", role_id: "army", sex: "F" }, measures: [{ key: "stature", reliability: "high", unit: "mm", percentiles: { p5: 1500, p50: 1630, p95: 1760 } }] }, { percentile: 80, scaling: "proportional", minReliability: "high" });
  assert.deepEqual(P.selectionOfProfile(prof), { country: "canada", role: "army", sex: "F", percentile: 80, scaling: "proportional", reliability: "high", survey: "combined" });
  assert.equal(P.selectionOfProfile(profiles.manual), null);
  assert.equal(P.selectionOfProfile(null), null);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(P.readLast(storage), null);
  assert.equal(P.writeLast({ country: "canada", role: "army", sex: "F", percentile: 99, secret: "x" }, storage), true);
  assert.deepEqual(JSON.parse(store.get("hm-profile-last")), { country: "canada", role: "army", sex: "F" });
  assert.deepEqual(P.readLast(storage), { country: "canada", role: "army", sex: "F" });
  store.set("hm-profile-last", JSON.stringify({ country: "../etc", role: "army", sex: "F" }));
  assert.equal(P.readLast(storage), null, "a corrupt or hostile value is ignored");
  store.set("hm-profile-last", "{not json");
  assert.equal(P.readLast(storage), null);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(P.readLast(blocked), null);
  assert.equal(P.writeLast({ country: "a", role: "b", sex: "M" }, blocked), false);
});

// ------------------------------------------------------------------------------------------------------------------ dimension rows
test("every dimension of every kind of body has a region, a 3D target that exists, and an edit rule", () => {
  for (const [name, body] of Object.entries(bodies)) {
    const rows = P.dimensionRows(body, profiles[name]);
    assert.equal(rows.length, body.dims.length, name);
    for (const r of rows) {
      assert.notEqual(r.group, "other", `${name}: ${r.id} has no region`);
      assert.ok(P.DIM_GROUPS.some((g) => g.id === r.group));
      assert.ok(r.target, `${name}: ${r.id} has no target`);
      if (r.target.joint) assert.ok(JOINT_BY_ID[r.target.joint], `${r.id} -> joint ${r.target.joint}`);
      if (r.target.landmark) assert.ok(body.landmarks[r.target.landmark], `${r.id} -> landmark ${r.target.landmark}`);
      assert.ok(["measure", "override", "derived", "none"].includes(r.editability.kind), r.id);
      assert.ok(["measured", "derived", "estimated"].includes(r.status), `${r.id}: ${r.status}`);
      assert.equal(typeof r.label, "string");
    }
    // groups partition the rows, in the order of DIM_GROUPS, and nothing is lost
    const groups = P.groupRows(rows);
    assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
    assert.deepEqual(groups.map((g) => g.group), P.DIM_GROUPS.map((g) => g.id).filter((id) => rows.some((r) => r.group === id)));
  }
  // the tables name only dimensions that exist in fit.js
  const known = new Set(DIM_DEFS.map((d) => d.id));
  for (const id of [...Object.keys(P.DIM_GROUP), ...Object.keys(P.DIM_TARGET), ...Object.keys(P.DIRECT_MEASURE), ...Object.keys(P.PURE_DERIVED), ...Object.keys(P.ALIASED_OVERRIDES)]) assert.ok(known.has(id), `${id} is not a dimension of fit.js`);
  for (const id of known) assert.ok(P.DIM_TARGET[id], `${id} has no DIM_TARGET`);
});

test("the dimension list: counts, filters, search, source text", () => {
  const body = bodies.manual, rows = P.dimensionRows(body, profiles.manual);
  const c = P.statusCounts(rows);
  assert.equal(c.all, rows.length);
  assert.equal(c.measured + c.derived + c.estimated, c.all);
  assert.ok(c.estimated > c.all * 0.8, "a stature and a mass: most of the body is estimated");
  assert.equal(c.edited, 0);
  assert.equal(P.filterRows(rows, { status: "estimated" }).length, c.estimated);
  assert.equal(P.filterRows(rows, { status: "measured" }).length, c.measured);
  assert.equal(P.filterRows(rows, { status: "all" }).length, rows.length);
  assert.equal(P.filterRows(rows, { status: "edited" }).length, 0);
  assert.deepEqual(P.filterRows(rows, { query: "thigh" }).map((r) => r.id).sort(), rows.filter((r) => /thigh/i.test(`${r.label} ${r.id} ${r.note}`)).map((r) => r.id).sort());
  assert.ok(P.filterRows(rows, { query: "femur_length" }).some((r) => r.id === "femur_length"), "search matches ids");
  assert.equal(P.filterRows(rows, { query: "thigh zzzz" }).length, 0, "every word must match");
  assert.equal(P.filterRows(rows, { query: "  " }).length, rows.length);
  const stature = rows.find((r) => r.id === "stature");
  assert.equal(P.sourceText(stature), "from Stature");
  assert.equal(P.sourceText(rows.find((r) => r.status === "estimated")), "estimated from stature, mass and sex");
  const pop = P.dimensionRows(bodies.armyM, profiles.armyM);
  assert.match(P.sourceText(pop.find((r) => r.id === "neck_length")), /^from .+ and \d+ more$|^from .+, .+$/);
  assert.equal(P.niceLabel("tragion_top_of_head"), "Tragion top of head");
  assert.equal(P.niceLabel("stature"), "Stature");
  assert.equal(P.groupOfDim("ring_waist"), "girths");
  assert.equal(P.groupOfDim("something_new"), "other");
});

// ------------------------------------------------------------------------------------------------------------------ editing
test("editability rules match fit.js: pure derivations are refused, aliases and girths can be edited", () => {
  const rows = Object.fromEntries(P.dimensionRows(bodies.armyM, profiles.armyM).map((r) => [r.id, r]));
  for (const id of Object.keys(P.PURE_DERIVED)) {
    assert.equal(rows[id].editability.kind, "derived", id);
    for (const dep of rows[id].editability.from) assert.ok(rows[dep], `${id} -> ${dep}`);
  }
  // a pure derivation of fit.js is exactly a dimension with no measure, no estimate, and no override rule of its own
  const pureInFit = DIM_DEFS.filter((d) => d.fallback.startsWith("derived from other dimensions") && !d.id.startsWith("ring_") && d.requires.length === 0).map((d) => d.id).sort();
  assert.deepEqual(pureInFit, [...Object.keys(P.PURE_DERIVED), ...Object.keys(P.ALIASED_OVERRIDES)].sort());
  assert.equal(rows.stature.editability.kind, "measure");
  assert.equal(rows.mass.editability.kind, "measure");
  assert.equal(rows.mass.editability.unit, "kg");
  assert.equal(rows.hand_length.editability.kind, "measure");
  assert.equal(rows.hand_length.editability.key, "hand_length");
  assert.equal(rows.ankle_height.editability.key, "other:lateral_malleolus_height");
  assert.equal(rows.femur_length.editability.kind, "override");
  assert.equal(rows.shank_length.editability.kind, "override");
  assert.equal(rows.ring_waist.editability.kind, "override");
  assert.equal(rows.ring_head.editability.kind, "none");
  assert.equal(rows.adiposity.editability.kind, "none");
  // the measure keys of DIRECT_MEASURE are what fit.js reads for that dimension
  for (const [id, keys] of Object.entries(P.DIRECT_MEASURE)) {
    const def = DIM_DEFS.find((d) => d.id === id);
    for (const k of keys) assert.ok(def.requires.includes(k), `${id}: ${k}`);
  }
});

test("editing a measured dimension edits the profile's measure (and reverts exactly)", () => {
  const prof = profiles.armyM, rows = Object.fromEntries(P.dimensionRows(bodies.armyM, prof).map((r) => [r.id, r]));
  const p2 = P.editDimension(prof, rows.hand_length, 210);
  assert.equal(p2.measures.hand_length.value, 210);
  assert.equal(p2.measures.hand_length.status, "edited");
  assert.equal(prof.measures.hand_length.status !== "edited", true, "the profile passed in is not changed");
  assert.match(p2.label, /\(edited\)$/);
  assert.notEqual(p2.id, prof.id);
  const b2 = fitBody(p2, {});
  near(b2.d.hand_length, 0.21, 1e-9);
  const r2 = P.dimensionRows(b2, p2).find((r) => r.id === "hand_length");
  assert.ok(r2.edited);
  assert.equal(P.statusCounts(P.dimensionRows(b2, p2)).edited, 1);
  assert.equal(P.filterRows(P.dimensionRows(b2, p2), { status: "edited" }).length, 1);
  // the fit report shows the edit: input 210
  const rep = b2.report.find((r) => r.id === "hand_length");
  near(rep.input, 210, 1e-6);
  // units: cm and inches
  near(P.editDimension(prof, rows.hand_length, 21, "cm").measures.hand_length.value, 210, 1e-9);
  near(P.editDimension(prof, rows.hand_length, 8, "in").measures.hand_length.value, 203.2, 1e-9);
  // the mass takes kg
  assert.equal(P.editDimension(prof, rows.mass, 90).measures.mass.value, 90);
  assert.equal(P.editDimension(prof, rows.mass, 200, "lb").measures.mass.unit, "kg");
  // reverting restores value, id and label
  const back = P.revertDimension(p2, r2);
  assert.equal(back.measures.hand_length.value, prof.measures.hand_length.value);
  assert.equal(back.id, prof.id);
  assert.equal(back.label, prof.label);
  assert.deepEqual(back.notes, prof.notes);
  // an estimated dimension with a direct measure gets that measure added
  const m = profiles.manual, mrows = Object.fromEntries(P.dimensionRows(bodies.manual, m).map((r) => [r.id, r]));
  assert.equal(mrows.hand_length.status, "estimated");
  const m2 = P.editDimension(m, mrows.hand_length, 200);
  assert.equal(m2.measures.hand_length.value, 200);
  near(fitBody(m2, {}).d.hand_length, 0.2, 1e-9);
  // nonsense is refused with a message that says what to fix
  assert.throws(() => P.editDimension(prof, rows.stature, 100), /outside|Give the unit/);
  assert.throws(() => P.editDimension(prof, rows.hand_length, 5), /outside the 120 to 260 mm/);
  assert.throws(() => P.editDimension(prof, rows.hand_length, 2000), /outside the 120 to 260 mm/, "the model would refuse it and fall back to another route");
  assert.throws(() => P.editDimension(prof, rows.hand_length, -5), /Hand length must be more than zero\./, "no raw measure key in the message");
  assert.throws(() => P.editDimension(prof, rows.hand_length, NaN), /Enter the value as a number/);
});

test("editing a derived or estimated dimension sets a fit override, which fitBody applies; ids and labels follow", () => {
  const prof = profiles.armyM, rows = Object.fromEntries(P.dimensionRows(bodies.armyM, prof).map((r) => [r.id, r]));
  const p2 = P.editDimension(prof, rows.femur_length, 430);
  assert.deepEqual(p2.overrides, { femur_length: 0.43 });
  assert.deepEqual(p2.measures, prof.measures, "the measures stay as they were");
  assert.match(p2.id, /~ov$/);
  assert.match(p2.label, /\(edited\)$/);
  assert.ok(p2.notes.some((n) => /set by hand/.test(n)));
  assert.equal(prof.overrides, undefined);
  const b2 = fitBody(p2, { overrides: p2.overrides });
  near(b2.d.femur_length, 0.43, 1e-9);
  const row2 = P.dimensionRows(b2, p2).find((r) => r.id === "femur_length");
  assert.equal(row2.status, "measured");
  assert.ok(row2.edited, "marked edited");
  assert.match(row2.note, /overridden by the user/);
  assert.deepEqual(P.verifyExtras(p2, b2), []);
  assert.deepEqual(P.verifyExtras(p2, bodies.armyM), ["the dimension edits"], "a shell that drops the overrides is noticed");
  // the report changes: the thigh length moved the hip, so a measure that depends on the legs changes
  const changed = b2.report.filter((r) => { const o = bodies.armyM.report.find((x) => x.id === r.id); return !o || Math.abs(o.model - r.model) > 0.05; });
  assert.ok(changed.length >= 3, `the report changes: ${changed.map((r) => r.id).join(", ")}`);
  // an alias (shank length) is an edit of the knee height and is recognised as edited
  const p3 = P.editDimension(prof, rows.shank_length, 400);
  const b3 = fitBody(p3, { overrides: p3.overrides });
  near(b3.d.shank_length, 0.4, 1e-9);
  assert.deepEqual(P.verifyExtras(p3, b3), []);
  // a girth
  const p4 = P.editDimension(prof, rows.ring_waist, 900);
  const b4 = fitBody(p4, { overrides: p4.overrides });
  assert.deepEqual(P.verifyExtras(p4, b4), []);
  assert.ok(P.dimensionRows(b4, p4).find((r) => r.id === "ring_waist").edited);
  // two edits, then one reverted, then all
  const p5 = P.editDimension(p2, P.dimensionRows(b2, p2).find((r) => r.id === "hand_length"), 200);
  assert.equal(p5.overrides.femur_length, 0.43);
  assert.equal(p5.measures.hand_length.status, "edited");
  const p6 = P.revertDimension(p5, P.dimensionRows(fitBody(p5, { overrides: p5.overrides }), p5).find((r) => r.id === "femur_length"));
  assert.equal(p6.overrides, undefined);
  assert.equal(p6.measures.hand_length.value, 200);
  assert.match(p6.id, /~edited:[0-9a-f]+$/, "ids do not pile up suffixes");
  const p7 = P.revertAll(p5);
  assert.equal(p7.id, prof.id);
  assert.equal(p7.label, prof.label);
  assert.equal(p7.overrides, undefined);
  assert.deepEqual(p7.notes, prof.notes);
  // refused: a pure derivation, nonsense numbers
  assert.throws(() => P.editDimension(prof, rows.trunk_length, 450), /other dimensions/);
  assert.throws(() => P.editDimension(prof, rows.adiposity, 1), /volume/);
  assert.throws(() => P.editDimension(prof, rows.femur_length, -5), /must be more than zero/);
  assert.throws(() => P.editDimension(prof, rows.femur_length, 9000), /between 0 and 5 metres/);
  assert.throws(() => P.editDimension(prof, rows.femur_length, "abc"), /number/);
});

test("every overridable dimension: a small override is applied by fitBody and verifyExtras agrees; without it the loss is noticed", () => {
  const prof = profiles.manualF, body = bodies.manualF, rows = P.dimensionRows(body, prof);
  let tested = 0;
  for (const r of rows) {
    if (r.editability.kind !== "override") continue;
    const mm = r.mm + (r.id.startsWith("ring_") ? 80 : 8); // a girth is only held to 1.5 %, so a dropped edit shows for a bigger one
    const p = P.editDimension(prof, r, mm);
    const b = fitBody(p, { overrides: p.overrides });
    assert.deepEqual(P.verifyExtras(p, b), [], `${r.id} not applied`);
    assert.deepEqual(P.verifyExtras(p, body), ["the dimension edits"], `${r.id} not noticed when dropped`);
    tested++;
  }
  assert.ok(tested >= 25, `${tested} dimensions tested`);
});

test("profile form: finalizeProfile, defaultForm, sameProfile, verifyExtras", () => {
  const prof = profiles.armyM;
  assert.equal(P.defaultForm(prof), "male");
  assert.equal(P.defaultForm(profiles.armyF), "female");
  assert.equal(P.defaultForm(anthro.manualProfile({ stature: 1700 })), "neutral");
  const f = P.finalizeProfile(prof, { form: "female" });
  assert.equal(f.form, "female");
  assert.match(f.id, /~form:female$/);
  assert.match(f.label, / · female form$/);
  assert.ok(f.notes.some((n) => /^Body form: female/.test(n)));
  assert.equal(prof.form, undefined);
  // asking for the form the profile has already is no choice; null clears
  const same = P.finalizeProfile(prof, { form: "male" });
  assert.equal(same.form, undefined);
  assert.equal(same.id, prof.id);
  assert.equal(P.finalizeProfile(f, { form: null }).id, prof.id);
  assert.equal(P.finalizeProfile(f, { form: "bogus" }).form, undefined);
  // idempotent: finalizing again changes nothing (no growing ids, labels or notes)
  const again = P.finalizeProfile(P.finalizeProfile(f));
  assert.equal(again.id, f.id);
  assert.equal(again.label, f.label);
  assert.deepEqual(again.notes, f.notes);
  assert.ok(P.sameProfile(f, again));
  assert.ok(!P.sameProfile(f, prof));
  assert.ok(!P.sameProfile(prof, P.finalizeProfile(prof, { overrides: { femur_length: 0.4 } })));
  assert.ok(P.sameProfile(null, null) === false);
  // the fitter really changes with the form, and verifyExtras sees whether the body has it
  const bf = fitBody(f, { form: f.form });
  assert.equal(bf.form, "female");
  assert.deepEqual(P.verifyExtras(f, bf), []);
  assert.deepEqual(P.verifyExtras(f, bodies.armyM), ["the body form"]);
  assert.deepEqual(P.verifyExtras(prof, bodies.armyM), []);
  assert.deepEqual(P.verifyExtras(null, null), []);
  // form and an edit together keep one id each
  const fe = P.editDimension(f, P.dimensionRows(bf, f).find((r) => r.id === "hand_length"), 200);
  assert.equal(fe.form, "female");
  assert.match(fe.id, /~edited:[0-9a-f]+~form:female$/);
  assert.match(fe.label, / · female form \(edited\)$/);
});

// ------------------------------------------------------------------------------------------------------------------ fit report
test("fit report: sorted by status, split into measures and checks, summary counts", () => {
  for (const [name, body] of Object.entries(bodies)) {
    const sorted = P.sortReport(body.report), rank = { off: 0, warn: 1, ok: 2, "n/a": 3 };
    assert.equal(sorted.length, body.report.length);
    for (let i = 1; i < sorted.length; i++) assert.ok(rank[sorted[i - 1].status] <= rank[sorted[i].status], `${name}: ${i}`);
    const { measures, checks } = P.splitReport(body.report);
    assert.equal(measures.length + checks.length, body.report.length);
    assert.ok(measures.every((r) => r.kind === "measure") && checks.every((r) => r.kind === "check"));
    const s = P.reportSummary(body.report);
    assert.equal(s.ok + s.warn + s.off + s.na, body.report.length);
    assert.equal(s.evaluated, s.ok + s.warn + s.off);
    assert.equal(s.text, `${s.ok} of ${s.evaluated} checks within tolerance`);
    // consistent with the fitter's own summary of the measure rows
    const m = P.reportSummary(measures);
    assert.deepEqual([m.ok, m.warn, m.off, m.na], [body.reportSummary.ok, body.reportSummary.warn, body.reportSummary.off, body.reportSummary.na], name);
  }
  // stable inside a status
  const rows = [{ id: "a", status: "ok" }, { id: "b", status: "off" }, { id: "c", status: "ok" }, { id: "d", status: "n/a" }, { id: "e", status: "warn" }];
  assert.deepEqual(P.sortReport(rows).map((r) => r.id), ["b", "e", "a", "c", "d"]);
  assert.deepEqual(P.reportSummary([]), { evaluated: 0, ok: 0, warn: 0, off: 0, na: 0, text: "Nothing to check: the profile has none of the measures the report compares", detail: "" });
  assert.equal(P.reportSummary(rows).detail, "1 close (warn), 1 off, 1 without an input value");
});

test("evaluating the report in a pose gives the same rows the panel shows in its second column", () => {
  const body = bodies.armyM, rig = buildRig(body, { skeleton: false });
  const rows = evaluateMeasures(body, rig.getPose());
  assert.ok(rows.length > 40);
  const stature = rows.find((r) => r.id === "stature");
  near(stature.model, body.report.find((r) => r.id === "stature").model, 1e-3);
  rig.dispose();
});

// ------------------------------------------------------------------------------------------------------------------ database pickers
test("pageInfo: paging maths", () => {
  assert.deepEqual(P.pageInfo(0, 0), { page: 0, pages: 1, size: 20, offset: 0, from: 0, to: 0, total: 0, hasPrev: false, hasNext: false });
  const a = P.pageInfo(1774, 0);
  assert.deepEqual([a.pages, a.offset, a.from, a.to, a.hasPrev, a.hasNext], [89, 0, 1, 20, false, true]);
  const b = P.pageInfo(1774, 88);
  assert.deepEqual([b.page, b.offset, b.from, b.to, b.hasPrev, b.hasNext], [88, 1760, 1761, 1774, true, false]);
  assert.equal(P.pageInfo(1774, 500).page, 88, "held inside the list");
  assert.equal(P.pageInfo(1774, -3).page, 0);
  assert.equal(P.pageInfo(40, 1).to, 40);
  assert.equal(P.pageInfo(41, 2).from, 41);
  assert.equal(P.pageInfo(41, 2).to, 41);
  assert.equal(P.pageInfo(10, 0, 3).pages, 4);
  assert.equal(P.pageInfo(NaN, NaN).pages, 1);
  assert.equal(P.pageInfo(10, 0, 0).size, 20);
  assert.equal(P.pageInfo(-5, 0).total, 0);
});

test("subjectOptions: datasets, sexes and branches that exist; selection corrected; people counts", () => {
  const filters = [
    { dataset: "ansur_ii_2012", sex: "F", branch: "Army", n: 1986 }, { dataset: "ansur_ii_2012", sex: "M", branch: "Army", n: 4082 },
    { dataset: "asran_2015", sex: "M", branch: "Navy", n: 800 }, { dataset: "asran_2015", sex: "M", branch: "Army", n: 290 }, { dataset: "asran_2015", sex: "F", branch: "Navy", n: 232 },
    { dataset: "usaf_1967", sex: "M", branch: null, n: 2420 }, { dataset: "ansur_1988", sex: "M", branch: null, n: 1774 }, { dataset: "ansur_1988", sex: "F", branch: null, n: 2208 },
  ];
  const o = P.subjectOptions(filters, {});
  assert.deepEqual(o.datasets.map((d) => d.id), ["ansur_1988", "ansur_ii_2012", "asran_2015", "usaf_1967"], "in the order of anthro.SUBJECT_DATASETS");
  assert.equal(o.datasets[0].name, "ANSUR 1988 (US Army)");
  assert.equal(o.sel.dataset, "ansur_1988");
  assert.equal(o.sel.sex, "M");
  assert.equal(o.n, 1774);
  assert.deepEqual(o.branches, []);
  const asran = P.subjectOptions(filters, { dataset: "asran_2015", sex: "F", branch: "Navy" });
  assert.deepEqual(asran.sel, { dataset: "asran_2015", sex: "F", branch: "Navy" });
  assert.deepEqual(asran.branches, [{ id: "Navy", n: 232 }]);
  assert.equal(asran.n, 232);
  const m = P.subjectOptions(filters, { dataset: "asran_2015", sex: "M", branch: "Army" });
  assert.equal(m.n, 290);
  assert.deepEqual(m.branches.map((b) => b.id), ["Army", "Navy"]);
  // a branch the sex lacks is dropped; a sex the survey lacks becomes men
  assert.equal(P.subjectOptions(filters, { dataset: "asran_2015", sex: "F", branch: "Army" }).sel.branch, null);
  assert.equal(P.subjectOptions(filters, { dataset: "usaf_1967", sex: "F" }).sel.sex, "M");
  assert.equal(P.subjectOptions(filters, { dataset: "nope" }).sel.dataset, "ansur_1988");
  assert.deepEqual(P.subjectOptions(null, {}).datasets, []);
  assert.equal(P.subjectOptions([], {}).sel.dataset, null);
});

test("subjectLabel keeps people anonymous: the survey's own number, stature and mass", () => {
  assert.equal(P.subjectLabel({ subject_key: 3045, stature: 1762, mass: 78.2 }), "#3045 · 1,762 mm · 78.2 kg");
  assert.equal(P.subjectLabel({ subject_key: 7, stature: 1762, mass: 78.2 }, "cm"), "#7 · 176.2 cm · 78.2 kg");
  assert.equal(P.subjectLabel({ subject_key: 7, stature: 1762, mass: null }), "#7 · 1,762 mm · mass not measured");
  assert.equal(fmtLength(1762, "mm"), "1,762 mm");
  // the profile of a person carries nothing that could identify them but the number
  const prof = anthro.subjectProfile({ subject_key: 12, dataset: "ansur_1988", sex: "M", branch: null, stature: 1750, mass: 75 });
  assert.deepEqual(Object.keys(prof.source).sort(), ["branch", "dataset", "kind", "sex", "subject_key"]);
});

// ------------------------------------------------------------------------------------------------------------------ import
test("checkImportFile: type, emptiness, size", () => {
  assert.equal(P.checkImportFile({ name: "me.csv", size: 120 }), null);
  assert.equal(P.checkImportFile({ name: "me.JSON", size: 120 }), null);
  assert.equal(P.checkImportFile({ name: "notes.txt", size: 120 }), null);
  assert.equal(P.checkImportFile({ name: "noextension", size: 120 }), null);
  assert.match(P.checkImportFile({ name: "me.xlsx", size: 120 }), /xlsx file\. Only JSON and CSV/);
  assert.match(P.checkImportFile({ name: "photo.png", size: 120 }), /png/);
  assert.match(P.checkImportFile({ name: "me.csv", size: 0 }), /is empty/);
  assert.match(P.checkImportFile({ name: "big.json", size: 5_000_000 }), /5\.0 MB; the limit is 3 MB/);
  assert.match(P.checkImportFile(null), /No file/);
  assert.ok(P.checkImportFile({ name: "x".repeat(500) + ".exe", size: 1 }).length < 200, "a long name is cut");
});

test("explainImportError: real errors of parseImport come with what to do", () => {
  const err = (text, name = "") => { try { anthro.parseImport(text, name); } catch (e) { return P.explainImportError(e); } throw new Error("expected an error"); };
  assert.match(err('{"mass": 80}').hint, /stature/);
  assert.match(err("{not json}", "a.json").hint, /comma|quote/);
  assert.match(err("   ").message, /empty/);
  assert.match(err("key,value\nstature,abc").message, /not a number/);
  assert.match(err("key,value\nstature,abc").hint, /unit/);
  assert.match(err("key,value\nstature,17,furlong").hint, /unit/);
  assert.match(err("<html><body>no</body></html>").hint, /JSON or CSV/);
  assert.match(err("hello world").hint, /key,value,unit/);
  assert.match(err("key,value\nstature,10 m").message, /outside/);
  assert.deepEqual(P.explainImportError(new Error("something odd")), { message: "something odd", hint: "" });
  assert.equal(P.explainImportError(undefined).message, "The file could not be read.");
  assert.equal(P.explainImportError(new Error("two\n  lines")).message, "two lines");
});

test("the example files import cleanly and say what they are", () => {
  const csv = anthro.parseImport(P.EXAMPLE_CSV, "digital-human-example.csv"), json = anthro.parseImport(P.EXAMPLE_JSON, "digital-human-example.json");
  for (const p of [csv, json]) {
    assert.equal(p.measures.stature.value, 1755);
    assert.equal(p.measures.mass.value, 80);
    assert.equal(p.measures.hand_length.value, 190);
    assert.equal(p.source.kind, "import");
    assert.ok(Object.keys(p.measures).length >= 6);
  }
  assert.equal(json.sex, "M");
  assert.equal(json.label, "Example person");
  // and they fit
  assert.equal(fitBody(csv, {}).warnings.filter((w) => /not used by the model/.test(w)).length, 0);
});

test("a profile exported by the panel's buttons imports again (json and csv)", () => {
  const p = P.editDimension(profiles.armyM, P.dimensionRows(bodies.armyM, profiles.armyM).find((r) => r.id === "hand_length"), 205);
  for (const text of [anthro.profileToJSON(p), anthro.profileToCSV(p)]) {
    const back = anthro.parseImport(text, "x");
    assert.equal(back.measures.hand_length.value, 205);
    assert.equal(back.sex, "M");
  }
});

if (haveData) {
  test("the API's own files import: a populations file, a mannequin file, a populations CSV", () => {
    const pj = anthro.parseImport(fs.readFileSync(path.join(DATA, "populations/united-states/army/M.json"), "utf8"), "M.json");
    assert.ok(pj.measures.stature.value > 1700 && pj.measures.stature.value < 1800);
    assert.ok(Object.keys(pj.measures).length > 100);
    const pc = anthro.parseImport(fs.readFileSync(path.join(DATA, "populations/united-states/army/M.csv"), "utf8"), "M.csv");
    assert.ok(pc.measures.stature);
    const mannequin = fs.readdirSync(path.join(DATA, "mannequin")).length;
    assert.ok(mannequin > 0);
  });
}

// ------------------------------------------------------------------------------------------------------------------ manual
test("manualFromForm: units, limits and messages", () => {
  const p = P.manualFromForm({ sex: "M", stature: "2000", statureUnit: "mm", mass: "95", massUnit: "kg" });
  assert.equal(p.measures.stature.value, 2000);
  assert.equal(p.measures.mass.value, 95);
  assert.equal(p.sex, "M");
  assert.equal(fitBody(p, {}).stature, 2);
  near(P.manualFromForm({ sex: "F", stature: "175,5", statureUnit: "cm", mass: "165", massUnit: "lb" }).measures.stature.value, 1755, 1e-9);
  near(P.manualFromForm({ sex: "F", stature: "175.5", statureUnit: "cm", mass: "165", massUnit: "lb" }).measures.mass.value, 74.843, 1e-3);
  near(P.manualFromForm({ sex: "both", stature: "69", statureUnit: "in" }).measures.stature.value, 1752.6, 1e-9);
  assert.equal(P.manualFromForm({ sex: "both", stature: "1.8", statureUnit: "m" }).measures.stature.value, 1800);
  assert.equal(P.manualFromForm({ stature: "1700", mass: "" }).measures.mass, undefined, "mass is optional");
  assert.equal(P.manualFromForm({ stature: "1700" }).sex, "both");
  assert.throws(() => P.manualFromForm({ stature: "" }), /Enter the stature as a number/);
  assert.throws(() => P.manualFromForm({ stature: "tall" }), /Enter the stature as a number/);
  assert.throws(() => P.manualFromForm({ stature: "175" }), /outside the 1,300 to 2,500 mm.*unit/, "175 in mm is a typo for cm");
  assert.throws(() => P.manualFromForm({ stature: "2600" }), /outside/);
  assert.throws(() => P.manualFromForm({ stature: "1700", mass: "heavy" }), /body mass as a number/);
  assert.throws(() => P.manualFromForm({ stature: "1700", mass: "5" }), /Body mass .* outside|outside/);
  assert.throws(() => P.manualFromForm({ stature: "1700", statureUnit: "ft" }), /Unknown stature unit/);
  assert.throws(() => P.manualFromForm({ stature: "1700", mass: "70", massUnit: "st" }), /Unknown mass unit/);
});

// ------------------------------------------------------------------------------------------------------------------ skeleton panel: mapping
test("JOINT_DIMS covers all 77 joints; every dimension it names exists in fit.js", () => {
  assert.equal(JOINTS.length, 77);
  assert.deepEqual(Object.keys(S.JOINT_DIMS).sort(), JOINTS.map((j) => j.id).sort());
  const known = new Set(DIM_DEFS.map((d) => d.id));
  for (const [id, e] of Object.entries(S.JOINT_DIMS)) {
    assert.ok(Array.isArray(e.dims) && Array.isArray(e.also), id);
    for (const d of [...e.dims, ...e.also]) assert.ok(known.has(d), `${id}: ${d}`);
    if (!e.dims.length) assert.ok(e.note.length > 10, `${id} is fixed and says why`);
  }
  assert.deepEqual(JOINTS.filter((j) => !S.JOINT_DIMS[j.id].dims.length).map((j) => j.id).sort(), ["forearm_L", "forearm_R", "jaw"]);
  for (const [d, parts] of Object.entries(S.DERIVED_FROM)) { assert.ok(known.has(d)); for (const p of parts) assert.ok(known.has(p), `${d}: ${p}`); }
  // right and left have the same entries
  for (const j of JOINTS) if (j.side === "L") assert.deepEqual(S.JOINT_DIMS[j.id], S.JOINT_DIMS[j.id.replace(/_L$/, "_R")], j.id);
  // expansion
  assert.deepEqual([...S.expandDims(["trunk_length"])].sort(), ["c7_height", "femur_length", "hip_height", "knee_height", "l5_above_hip", "trunk_length"]);
  assert.ok(S.expandDims(["neck_length"]).has("tragion_below_eye"));
  assert.ok(S.expandDims(["shank_length"]).has("ankle_height"));
  assert.ok(S.jointInfluences("ankle_L").has("knee_height"));
  // (the shoulder too: a profile with an arm span or a thumbtip reach makes the model solve the shoulder, and the hand sets the span)
  assert.deepEqual(S.dimensionJoints("hand_breadth").filter((j) => j.endsWith("_L")).sort(), ["index_mcp_L", "little_mcp_L", "middle_mcp_L", "ring_mcp_L", "shoulder_L", "thumb_cmc_L"]);
  // an edit of a derived dimension is an edit of the one it stands for
  assert.ok(S.dimensionJoints("hip_height").includes("knee_L") && S.dimensionJoints("shank_length").includes("knee_L") && S.dimensionJoints("gh_halfwidth").includes("index_mcp_L"));
  assert.deepEqual(S.dimensionJoints("hip_halfwidth").sort(), ["hip_L", "hip_R"]);
});

test("the joint -> dimension table agrees with fit.js: moving a dimension only moves joints that list it", () => {
  // Each overridable dimension is moved by 6 mm; every joint whose rest offset to its parent changes by more than 1.2 mm (the 17 vertebrae share a
  // trunk change in small parts, so they are checked by the sums below) must list that dimension, directly or through a derived one.
  // Aliases (shank_length, hip_height, gh_halfwidth) are edits of other dimensions and are covered by those.
  const sample = [profiles.manual, profiles.manualF, anthro.manualProfile({ sex: "M", stature: 1900, mass: 95 })];
  if (haveData) { const p = { ...profiles.armyF, measures: { ...profiles.armyF.measures } }; delete p.measures.span; delete p.measures.thumbtip_reach; sample.push(p); }
  // the profiles with a span and a thumbtip reach: the model solves the shoulder for them, which moves joints the other profiles do not move
  if (haveData) sample.push(profiles.armyM, profiles.armyF);
  let pairs = 0;
  for (const prof of sample) {
    const b0 = fitBody(prof, {});
    for (const d of b0.dims) {
      if (d.unit !== "m" || d.id.startsWith("ring_") || d.id === "stature" || P.ALIASED_OVERRIDES[d.id] || P.PURE_DERIVED[d.id]) continue;
      const b1 = fitBody(prof, { overrides: { [d.id]: d.value + 0.006 } });
      for (const j of JOINTS) {
        const o0 = b0.joints[j.id].offset, o1 = b1.joints[j.id].offset, moved = Math.hypot(o0[0] - o1[0], o0[1] - o1[1], o0[2] - o1[2]);
        if (moved > 0.0012) { assert.ok(S.jointInfluences(j.id).has(d.id), `${prof.id}: ${d.id} moves ${j.id} by ${(moved * 1000).toFixed(1)} mm but the table does not say so`); pairs++; }
      }
    }
  }
  assert.ok(pairs > 150, `${pairs} (dimension, joint) pairs checked`);
});

test("the trunk and neck rows describe what the spine really is: the 17 + 7 intervals add up to trunk_length and neck_length", () => {
  for (const [name, body] of Object.entries(bodies)) {
    const trunk = ["L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7"].reduce((s, id) => s + body.joints[id].offset[1], body.joints.L5.offset[1]);
    // L5 -> C7 vertical = trunk_length; the pelvis -> L5 offset is l5_above_hip
    near(trunk - body.d.l5_above_hip, body.d.trunk_length, 1e-5, `${name} trunk`);
    const neck = ["C6", "C5", "C4", "C3", "C2", "C1", "head"].reduce((s, id) => s + body.joints[id].offset[1], 0);
    near(neck, body.d.neck_length, 1e-5, `${name} neck`);
    for (const id of ["L4", "T12", "T1", "C7"]) assert.equal(S.JOINT_DIMS[id].dims[0], "trunk_length");
    for (const id of ["C6", "C1", "head"]) assert.equal(S.JOINT_DIMS[id].dims[0], "neck_length");
  }
});

test("jointBoneStatus: measured / derived / estimated / fixed, and restSegmentMm", () => {
  const man = bodies.manual, pop = bodies.armyM;
  assert.equal(S.jointBoneStatus("knee_L", man).status, "estimated", "a stature and mass only: estimated");
  assert.equal(S.jointBoneStatus("jaw", man).status, "fixed");
  assert.equal(S.jointBoneStatus("forearm_L", pop).status, "fixed");
  assert.equal(S.jointBoneStatus("hip_L", pop).status, "derived");
  assert.equal(S.jointBoneStatus("nonsense", pop).status, "unknown");
  assert.equal(S.jointBoneStatus("knee_L", null).status, "unknown");
  const st = S.jointBoneStatus("shoulder_L", pop);
  assert.deepEqual(st.dims.map((d) => d.id), ["shoulder_height", "gh_halfwidth", "shoulder_protraction"]);
  assert.ok(["measured", "derived", "estimated"].includes(st.status));
  // an edit makes a dimension measured
  const p2 = P.editDimension(profiles.manual, P.dimensionRows(man, profiles.manual).find((r) => r.id === "hand_length"), 200);
  assert.equal(S.jointBoneStatus("index_mcp_L", man).status, "estimated");
  const b2 = fitBody(p2, {});
  assert.equal(S.jointBoneStatus("index_pip_L", b2).status, "measured");
  assert.equal(S.jointBoneStatus("index_mcp_L", b2).status, "derived", "hand length measured, hand breadth estimated: a mix");
  // segment lengths
  near(S.restSegmentMm("knee_L", pop), Math.hypot(...pop.joints.knee_L.offset) * 1000, 1e-9);
  near(S.restSegmentMm("pelvis", pop), pop.joints.pelvis.offset[1] * 1000, 1e-9);
  assert.equal(S.restSegmentMm("forearm_L", pop), 0);
  assert.equal(S.restSegmentMm("knee_L", null), null);
  for (const j of JOINTS) assert.ok(Number.isFinite(S.restSegmentMm(j.id, pop)), j.id);
});

// ------------------------------------------------------------------------------------------------------------------ skeleton panel: tree, search, angles
test("the joint tree holds every joint exactly once, grouped as the task says", () => {
  const tree = S.buildJointTree();
  const ids = S.treeJoints(tree);
  assert.equal(ids.length, 77);
  assert.deepEqual([...ids].sort(), JOINTS.map((j) => j.id).sort());
  assert.deepEqual(tree.map((n) => n.label), ["Pelvis and spine", "Head and face", "Left arm", "Right arm", "Left leg", "Right leg"]);
  const spine = tree[0].children;
  assert.deepEqual(spine.map((n) => n.label), ["Pelvis (root)", "Lumbar spine", "Thoracic spine", "Cervical spine"]);
  assert.deepEqual(S.treeJoints(spine[1].children), ["L5", "L4", "L3", "L2", "L1"]);
  assert.equal(S.treeJoints(spine[2].children).length, 12);
  assert.equal(S.treeJoints(spine[3].children).length, 7);
  const hand = tree[2].children.find((n) => n.id === "g:hand_L");
  assert.deepEqual(hand.children.map((n) => n.label), ["Thumb", "Index finger", "Middle finger", "Ring finger", "Little finger"]);
  assert.deepEqual(S.treeJoints(hand.children[0].children), ["thumb_cmc_L", "thumb_mcp_L", "thumb_ip_L"]);
  assert.deepEqual(S.treeJoints(hand.children[4].children), ["little_mcp_L", "little_pip_L", "little_dip_L"]);
  assert.equal(S.treeJoints(tree[2].children).length, 20);
  assert.deepEqual(S.treeJoints(tree[4].children), ["hip_L", "knee_L", "ankle_L", "mtp_L"]);
  const seen = new Set();
  (function walk(ns) { for (const n of ns) { assert.ok(!seen.has(n.id), `duplicate node ${n.id}`); seen.add(n.id); if (n.children) walk(n.children); } })(tree);
  assert.deepEqual(S.ancestorsOf(tree, "index_dip_R"), ["g:arm_R", "g:hand_R", "g:index_R"]);
  assert.deepEqual(S.ancestorsOf(tree, "pelvis"), ["g:spine"]);
  assert.equal(S.ancestorsOf(tree, "nonsense"), null);
});

test("short labels, joint search, summary line", () => {
  assert.equal(S.shortJointLabel("L5"), "L5/S1");
  assert.equal(S.shortJointLabel("shoulder_L"), "Shoulder (glenohumeral)");
  assert.equal(S.shortJointLabel("index_mcp_R"), "MCP");
  assert.equal(S.shortJointLabel("thumb_cmc_L"), "CMC");
  assert.equal(S.shortJointLabel("pelvis"), "Pelvis (root)");
  for (const j of JOINTS) assert.ok(S.shortJointLabel(j.id).length > 1);
  const all = JOINTS.map((j) => j.id);
  assert.equal(S.matchJoints("").length, 77);
  assert.deepEqual(S.matchJoints("shoulder").sort(), ["clavicle_L", "clavicle_R", "shoulder_L", "shoulder_R"], "the shoulder girdle group matches too");
  assert.deepEqual(S.matchJoints("glenohumeral").sort(), ["shoulder_L", "shoulder_R"]);
  assert.equal(S.matchJoints("index").length, 6);
  assert.equal(S.matchJoints("left index").length, 3);
  assert.deepEqual(S.matchJoints("KNEE flex").sort(), ["knee_L", "knee_R"], "words may match the joint or its degrees of freedom");
  assert.equal(S.matchJoints("zzzz").length, 0);
  assert.deepEqual(S.matchJoints("hip", ["hip_L", "knee_L"]), ["hip_L"]);
  assert.ok(S.matchJoints("lumbar").length >= 5 && S.matchJoints("lumbar").every((id) => all.includes(id)));
  assert.deepEqual(S.skeletonCounts(), { joints: 77, dof: 159, bones: BONES.length });
  assert.equal(S.summaryText(120), `77 joints, 159 degrees of freedom, ${BONES.length} bones, 120 landmarks`);
  assert.equal(S.summaryText(), `77 joints, 159 degrees of freedom, ${BONES.length} bones, 0 landmarks`);
  assert.ok(BONES.length > 100);
});

test("angles and ranges of motion", () => {
  assert.equal(S.fmtDeg(12), "12°");
  assert.equal(S.fmtDeg(-5.56), "−5.6°");
  assert.equal(S.fmtDeg(-0.04), "0°");
  assert.equal(S.fmtDeg(12.34, 0), "12°");
  assert.equal(S.fmtDeg(NaN), "—");
  assert.equal(S.angleSummary("knee_L", [0, 0]), "neutral");
  assert.equal(S.angleSummary("knee_L", undefined), "neutral");
  assert.equal(S.angleSummary("knee_L", [90, 0]), "flex 90°");
  assert.equal(S.angleSummary("shoulder_L", [12.5, -30, 0.02]), "flex 12.5°, abd −30°");
  assert.equal(S.angleSummary("hip_R", [1, 2, 3]), "flex 1°, abd 2°, rot 3°");
  assert.deepEqual(S.romFractions(-60, 180, 0), { zero: 0.25, pos: 0.25 });
  assert.deepEqual(S.romFractions(0, 110, 55), { zero: 0, pos: 0.5 });
  assert.deepEqual(S.romFractions(-10, 10, 99), { zero: 0.5, pos: 1 });
  assert.deepEqual(S.romFractions(-10, 10, -99), { zero: 0.5, pos: 0 });
  assert.deepEqual(S.romFractions(5, 5, 5), { zero: 0, pos: 0 });
  assert.equal(S.romText(JOINT_BY_ID.knee_L.dof[0]), "−5° to 160°");
  // every joint's DOF can be drawn: finite ranges, a source string and the two directions
  for (const j of JOINTS) for (const d of j.dof) {
    assert.ok(Number.isFinite(d.min) && Number.isFinite(d.max) && d.min < d.max, `${j.id}.${d.key}`);
    assert.ok(typeof d.src === "string" && d.src.length > 3 && d.pos && d.neg, `${j.id}.${d.key}`);
    const f = S.romFractions(d.min, d.max, 0);
    assert.ok(f.zero >= 0 && f.zero <= 1);
  }
});

// ------------------------------------------------------------------------------------------------------------------ skeleton panel: points for CAD
test("collectPoints / pointsCSV: every joint centre and landmark in world mm in the DESIGN.md axes", () => {
  const body = bodies.armyM, rig = buildRig(body, { skeleton: false });
  rig.setPose({ root: { y: rig.restRootY, heading: 30 }, angles: { elbow_L: [90], hip_L: [90, 0, 0], knee_L: [90, 0] } });
  const pts = S.collectPoints(rig);
  assert.equal(pts.length, 77 + Object.keys(body.landmarks).length);
  assert.equal(pts.filter((p) => p.type === "joint").length, 77);
  const csv = S.pointsCSV(pts), lines = csv.trim().split("\n");
  assert.equal(lines[0], "type,id,label,group,kind,attached_to,x_mm,y_mm,z_mm");
  assert.equal(lines.length, 1 + pts.length);
  assert.ok(csv.endsWith("\n"));
  // parse back (labels may be quoted because they contain commas)
  const rows = lines.slice(1).map((l) => { const cells = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; } cells.push(cur); return cells; });
  for (const c of rows) assert.equal(c.length, 9, c.join("|"));
  const byId = Object.fromEntries(rows.map((c) => [`${c[0]}:${c[1]}`, c]));
  const pel = byId["joint:pelvis"], p = rig.jointWorld("pelvis");
  near(Number(pel[6]), p.x * 1000, 0.06); near(Number(pel[7]), p.y * 1000, 0.06); near(Number(pel[8]), p.z * 1000, 0.06);
  const el = byId["joint:elbow_L"], e = rig.jointWorld("elbow_L");
  near(Number(el[7]), e.y * 1000, 0.06);
  const vx = byId["landmark:vertex"], v = rig.landmarkWorld("vertex");
  near(Number(vx[7]), v.y * 1000, 0.06);
  near(Number(vx[7]), body.stature * 1000, 0.06, "the vertex of the neutral standing figure is at the stature");
  assert.equal(byId["landmark:vertex"][5], "head");
  assert.equal(byId["joint:knee_L"][5], "hip_L");
  assert.equal(byId["joint:pelvis"][5], "");
  // axes: the left shoulder is on +X, the figure faces +Z (the toes are ahead of the heel)
  rig.resetPose();
  assert.ok(rig.jointWorld("shoulder_L").x > 0.1 && rig.jointWorld("shoulder_R").x < -0.1);
  assert.ok(rig.landmarkWorld("toe_tip_L").z > rig.landmarkWorld("heel_L").z);
  // no "-0" in the text, one decimal at most
  for (const c of rows) for (const n of c.slice(6)) { assert.ok(/^-?\d+(\.\d)?$/.test(n), n); assert.notEqual(n, "-0"); assert.notEqual(n, "-0.0"); }
  rig.dispose();
  assert.match(S.pointsCSV([{ type: "landmark", id: "x", label: "Top, back \"edge\"", group: "g", kind: "k", attached: "j", p: [0, 0, 0] }]), /"Top, back ""edge"""/, "labels with commas and quotes are quoted");
});

test("landmark search and coordinate text", () => {
  const lms = bodies.armyM.landmarks;
  assert.equal(S.matchLandmarks(lms, "").length, Object.keys(lms).length);
  assert.ok(S.matchLandmarks(lms, "acromion").includes("acromion_L"));
  assert.ok(S.matchLandmarks(lms, "ACROMION left").length >= 1, "case does not matter; words match label, id, group, kind and joint");
  assert.deepEqual(S.matchLandmarks(lms, "vertex"), ["vertex"]);
  assert.ok(S.matchLandmarks(lms, "hand").every((id) => /hand|palm|grip|tip|metacarpale|dactylion|thumb/i.test(`${id} ${lms[id].label} ${lms[id].group}`)));
  assert.equal(S.matchLandmarks(lms, "zzzz").length, 0);
  assert.equal(S.matchLandmarks(null, "x").length, 0);
  assert.equal(S.fmtPointMm([-0.0852, 1.4029, 0.0153]), "−85.2   1,402.9   15.3");
  assert.equal(S.fmtPointMm([0, 0, 0]), "0.0   0.0   0.0");
});

// ------------------------------------------------------------------------------------------------------------------ regressions of the verifier's defects
const fitWith = (p) => fitBody(p, { form: p.form ?? P.defaultForm(p), overrides: p.overrides }); // what a shell that passes the extras on does
const rowOf = (body, prof, id) => P.dimensionRows(body, prof).find((r) => r.id === id);

test("a population id that the profile cut at 100 characters is completed from the index (the controls must not jump to the first country)", async () => {
  const long = `multiple-${"bolivia-brazil-colombia-chile-".repeat(5)}venezuela`;
  assert.ok(long.length > P.SOURCE_ID_MAX + 20);
  const index = { countries: [{ id: "angola", roles: [{ id: "cadets", sexes: ["M"] }] }, { id: long, roles: [{ id: "recruits", sexes: ["M", "F"] }] }], populations: [] };
  const cut = { source: { kind: "population", country_id: long.slice(0, P.SOURCE_ID_MAX), role_id: "recruits", sex: "F", percentile: 95 } };
  assert.equal(P.resolveSourceId(index.countries, cut.source.country_id).id, long);
  assert.deepEqual(P.selectionOfProfile(cut, index), { country: long, role: "recruits", sex: "F", percentile: 95, scaling: "percentile", reliability: "medium", survey: "combined" });
  assert.equal(P.selectionOfProfile(cut).country, long.slice(0, P.SOURCE_ID_MAX), "without an index the id is as the profile has it");
  // ambiguous or short ids are not guessed
  const two = [{ id: `${long}-a` }, { id: `${long}-b` }];
  assert.equal(P.resolveSourceId(two, long.slice(0, P.SOURCE_ID_MAX)), null);
  assert.equal(P.resolveSourceId([{ id: "united-states" }, { id: "united-states-navy" }], "united"), null, "a short id must match exactly");
  assert.equal(P.resolveSourceId([{ id: "united-states" }], "united-states").id, "united-states");
  // and the real pooled populations of the index come back whole
  if (haveData) {
    const idx = await anthro.loadIndex("api/v1", async (url) => readJSON(url.replace(/^api\/v1\//, "")));
    for (const c of idx.countries.filter((x) => x.id.length > P.SOURCE_ID_MAX)) assert.equal(P.resolveSourceId(idx.countries, c.id.slice(0, P.SOURCE_ID_MAX)).id, c.id);
  }
});

test("editing the shoulder half-width works for a profile with an arm span (it is stored as the acromion offset the solver leaves alone)", { skip: !haveData }, () => {
  const prof = P.finalizeProfile(profiles.armyM, {});
  assert.ok(prof.measures.span, "this profile has an arm span: the model solves the shoulder for it");
  const b0 = fitWith(prof), row = rowOf(b0, prof, "gh_halfwidth");
  const target = row.mm + 7;
  const p1 = P.editDimension(prof, row, target);
  assert.deepEqual(Object.keys(p1.overrides), ["acromion_to_gh"], "stored as the offset it comes from");
  const b1 = fitWith(p1);
  near(b1.dims.find((d) => d.id === "gh_halfwidth").value * 1000, target, 0.01, "applied");
  assert.deepEqual(P.verifyExtras(p1, b1), []);
  const r1 = rowOf(b1, p1, "gh_halfwidth");
  assert.ok(r1.edited, "the row is marked edited");
  assert.equal(P.explainEdit(r1, target, b1), null, "nothing to explain: the value is what was typed");
  // the other route (an override of the derived row itself) is what the solver used to undo
  const bOld = fitWith({ ...prof, overrides: { gh_halfwidth: target / 1000 } });
  assert.ok(Math.abs(bOld.dims.find((d) => d.id === "gh_halfwidth").value * 1000 - target) > 3, "documented: fit.js does not honour it with a span in the profile");
  // revert removes the offset (and an old override of the derived row)
  const back = P.revertDimension(p1, r1);
  assert.equal(back.overrides, undefined);
  assert.equal(back.id, prof.id);
  assert.equal(P.revertDimension({ ...p1, overrides: { gh_halfwidth: 0.15, acromion_to_gh: 0.04 } }, r1).overrides, undefined);
  // wider than the acromion: the offset would be negative; the model holds it at its lower limit and says so
  const p2 = P.editDimension(prof, row, row.mm + 400);
  assert.ok(p2.overrides.acromion_to_gh > 0);
  const b2 = fitWith(p2);
  const ex = P.explainEdit(rowOf(b2, p2, "gh_halfwidth"), row.mm + 400, b2);
  assert.match(ex.text, /was held to .* outside the range the model accepts/);
  assert.deepEqual(P.verifyExtras(p2, b2), []);
});

test("an extreme girth is applied (held in its range): no 'ignored the edits' notice, and the status says it was held", () => {
  const prof = profiles.manual, b0 = fitWith(prof), row = rowOf(b0, prof, "ring_waist");
  for (const mm of [50, 4000]) {
    const p1 = P.editDimension(prof, row, mm), b1 = fitWith(p1);
    const held = b1.dims.find((d) => d.id === "ring_waist").value * 1000;
    assert.ok(held !== mm && held > 100, `held to ${held}`);
    assert.ok(b1.warnings.some((w) => w.startsWith("The edited waist girth (")), "fit.js says so only in the warnings");
    assert.deepEqual(P.unappliedOverrides(p1, b1), []);
    assert.deepEqual(P.verifyExtras(p1, b1), []);
    assert.equal(P.extrasNotice(p1, b1), null);
    assert.match(P.explainEdit(rowOf(b1, p1, "ring_waist"), mm, b1).text, /^Waist section.* was held to .*: .* is outside the range the model accepts/);
  }
  // an edit the model really dropped is still noticed
  const p1 = P.editDimension(prof, row, row.mm * 1.3);
  assert.deepEqual(P.unappliedOverrides(p1, b0), ["ring_waist"]);
  assert.match(P.extrasNotice(p1, b0), /ignored the dimension edits: this build/);
  // a girth the section holds to within 1.5 % is explained as such, not as a limit of the model
  if (haveData) {
    const prof2 = P.finalizeProfile(profiles.armyM, {}), r2 = rowOf(fitWith(prof2), prof2, "ring_chest");
    const p2 = P.editDimension(prof2, r2, r2.mm * 1.08), b2 = fitWith(p2);
    const ex = P.explainEdit(rowOf(b2, p2, "ring_chest"), r2.mm * 1.08, b2);
    assert.equal(ex.level, "info");
    assert.match(ex.text, /^Chest .* was fitted as .*: the body section cannot hold .* exactly \(it holds a girth within 1\.5 %\)/);
  }
});

test("a signed offset (the shoulder protraction) takes zero and negative values; the others say what is wrong", () => {
  const prof = profiles.manual, body = fitWith(prof), row = rowOf(body, prof, "shoulder_protraction");
  assert.ok(row.band[0] < 0, "its plausible band is signed");
  for (const mm of [-20, 0, -80, 20]) assert.deepEqual(P.editDimension(prof, row, mm).overrides, { shoulder_protraction: mm / 1000 });
  assert.throws(() => P.editDimension(prof, row, 6000), /between 0 and 5 metres/);
  const femur = rowOf(body, prof, "femur_length");
  for (const bad of [0, -3]) assert.throws(() => P.editDimension(prof, femur, bad), /must be more than zero/);
  assert.throws(() => P.editDimension(prof, rowOf(body, prof, "mass"), 0), /Body mass must be more than zero/);
  // a fitter that ignores a value of zero or less is reported as that, not as a shell that drops everything
  const p1 = P.editDimension(prof, row, -20), b1 = fitWith(p1);
  assert.deepEqual(P.unappliedOverrides(p1, b1), ["shoulder_protraction"]);
  const text = P.extrasNotice(p1, b1);
  assert.match(text, /does not take a value of zero or less for “Glenohumeral centre ahead of its standard place”/);
  assert.doesNotMatch(text, /this build of the Digital human view/);
});

test("explainEdit: held at an edge, not applied, or built another way; null when the value is what was typed", () => {
  const prof = profiles.manual, b0 = fitWith(prof);
  const row = rowOf(b0, prof, "upper_arm_length");
  // not applied (a shell that drops the overrides)
  const p1 = P.editDimension(prof, row, row.mm + 15);
  assert.match(P.explainEdit(row, row.mm + 15, b0).text, /^The model did not apply this edit: Upper arm is /);
  // applied
  const b1 = fitWith(p1);
  assert.equal(P.explainEdit(rowOf(b1, p1, "upper_arm_length"), row.mm + 15, b1), null);
  // held at the edge of the plausible band
  const p2 = P.editDimension(prof, row, 600), b2 = fitWith(p2);
  assert.match(P.explainEdit(rowOf(b2, p2, "upper_arm_length"), 600, b2).text, /^Upper arm was held to .*: .* is outside the range the model accepts for this dimension\.$/);
  // units: the text follows the display unit
  assert.match(P.explainEdit(rowOf(b2, p2, "upper_arm_length"), 600, b2, "in").text, /in\b/);
  // the mass
  assert.equal(P.explainEdit(rowOf(b0, prof, "mass"), 80, b0), null);
  assert.equal(P.explainEdit(row, NaN, b0), null);
  assert.equal(P.explainEdit({ id: "nonsense", kind: "mm" }, 5, b0), null);
});

test("a measure outside the plausible band is refused with the range, not stored for the model to drop (a hand length of 2 m)", () => {
  const prof = profiles.manual, b0 = fitWith(prof), row = rowOf(b0, prof, "hand_length");
  assert.throws(() => P.editDimension(prof, row, 2000), /Hand length of 2,000 mm is outside the 120 to 260 mm that the model accepts for this dimension\./);
  assert.throws(() => P.editDimension(prof, row, 11, "cm"), /outside the 120 to 260 mm/);
  assert.equal(P.bandText(0.12, 0.26), "120 to 260 mm");
  assert.equal(P.bandText(0.02, null), "at least 20 mm");
  assert.equal(P.bandText(null, 0.09), "at most 90 mm");
  assert.equal(P.editDimension(prof, row, 21, "cm").measures.hand_length.value, 210);
});

test("reverting a row that is marked edited because of the dimension it comes from removes that edit (shank length, hip height)", () => {
  const prof = profiles.manual, b0 = fitWith(prof);
  const kh = rowOf(b0, prof, "knee_height");
  const p1 = P.editDimension(prof, kh, kh.mm + 20), b1 = fitWith(p1);
  const shank = rowOf(b1, p1, "shank_length");
  assert.ok(shank.edited, "marked edited through the knee height");
  const back = P.revertDimension(p1, shank);
  assert.ok(!back.overrides && !Object.values(back.measures).some((m) => m.status === "edited"));
  assert.equal(back.id, prof.id);
});

test("small helpers: countEdits, capFirst, the report with nothing to compare", () => {
  assert.equal(P.countEdits(null), 0);
  assert.equal(P.countEdits(profiles.manual), 0);
  const e = P.editDimension(P.editDimension(profiles.manual, rowOf(bodies.manual, profiles.manual, "hand_length"), 200), rowOf(bodies.manual, profiles.manual, "femur_length"), 430);
  assert.equal(P.countEdits(e), 2);
  assert.equal(P.capFirst("the model's arm hangs"), "The model's arm hangs");
  assert.equal(P.capFirst(""), "");
  assert.match(P.reportSummary([]).text, /^Nothing to check/);
  assert.doesNotMatch(P.reportSummary([]).text, /0 of 0/);
});

test("dimensionJoints follows an edit of a derived dimension to the one it is applied to", () => {
  assert.deepEqual(S.EDIT_AS, { shank_length: "knee_height", hip_height: "femur_length", gh_halfwidth: "acromion_to_gh" });
  assert.ok(S.dimensionJoints("gh_halfwidth").includes("thumb_cmc_L"), "an arm that tilts differently carries the hand");
  assert.ok(S.dimensionJoints("femur_length").includes("C3") && S.dimensionJoints("hip_height").includes("head"), "a longer thigh leaves less stature for the neck");
  assert.ok(S.dimensionJoints("l5_above_hip").includes("clavicle_L"));
});
