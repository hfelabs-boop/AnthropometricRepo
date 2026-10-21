// Semantic tests of the two posture groups "Work" (site/js/human/postures/work.js, ids work-*) and "Military" (military.js, ids mil-*): what each posture MEANS, measured with
// metrics.js (docs/human3d/METRICS.md) and the landmarks of the fitted body on three bodies (5th-percentile woman, median man, 95th-percentile man of the US Army populations),
// on top of the structure rules and the validator, which is run here too (no errors and no warnings on the three bodies; postures.test.mjs runs the whole library on six).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-work-military.test.mjs"
// A tolerance has a reason: a literature value where there is one (the RULA / REBA bands of the reference postures, the ISO 11226 limits, the 45 degree toe-out of attention
// in TC 3-21.5) or else the name and the description of the posture. Values were measured first and the bounds set around them; a failing line names the quantity and the body.
// The positions of the props (hints.prop notes) are those of the median man, so the position tests are made on him only; the other two bodies are held to the angles.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { validatePosture, expandPosture, placePose, landmarkPosition, mirrorPose, CATEGORIES } from "../../site/js/human/pose.js";
import { postureMetrics } from "../../site/js/human/metrics.js";
import { byType, normalizeParams } from "../../site/js/human/catalog.js";
import { GRIPS } from "../../site/js/human/postures/grips.js";
import work from "../../site/js/human/postures/work.js";
import military from "../../site/js/human/postures/military.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = { "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95) };
const MAN = BODIES["P50 man"];
const ALL = [...work, ...military];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));
const get = (id) => { const p = BY_ID.get(id); assert.ok(p, `no posture ${id}`); return p; };

// ---- measuring -------------------------------------------------------------------------------------------------------------------------------------
function measure(body, p) {
  const e = expandPosture(p), pose = { root: e.root, angles: e.angles }, root = placePose(body, pose, { posture: p });
  const lm = (id) => landmarkPosition(body, pose, root, id);
  return { m: postureMetrics(body, pose, root), pose, root, lm, body };
}
/** run fn(metrics, measurement, label) for the posture on every body */
function each(id, fn) {
  const p = get(id);
  for (const [label, body] of Object.entries(BODIES)) { const r = measure(body, p); fn(r.m, r, `${id} on the ${label}`); }
}
const f1 = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
const within = (v, lo, hi, what) => assert.ok(typeof v === "number" && v >= lo && v <= hi, `${what}: ${f1(v)} is not in [${lo}, ${hi}]`);
const near = (v, target, tol, what) => within(v, target - tol, target + tol, what);
const above = (v, lo, what) => assert.ok(typeof v === "number" && v > lo, `${what}: ${f1(v)} is not above ${lo}`);
const below = (v, hi, what) => assert.ok(typeof v === "number" && v < hi, `${what}: ${f1(v)} is not below ${hi}`);
const kneeFlex = (m, s) => 180 - m[`kneeAngle_${s}`];
const elbowFlex = (m, s) => 180 - m[`elbowAngle_${s}`];

// ---- structure -------------------------------------------------------------------------------------------------------------------------------------
test("the two groups hold at least 44 postures between them (54 now), with the work- and mil- prefixes, unique ids and the right category", () => {
  assert.ok(ALL.length >= 44, `${ALL.length} postures`);
  assert.ok(work.length >= 25 && military.length >= 20, `${work.length} work, ${military.length} military`);
  const ids = ALL.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  for (const p of work) { assert.match(p.id, /^work-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Work", p.id); }
  for (const p of military) { assert.match(p.id, /^mil-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Military", p.id); }
  assert.ok(CATEGORIES.some((c) => c.name === "Work") && CATEGORIES.some((c) => c.name === "Military"));
});

test("the plan of POSTURES.md exists: the occupational postures, the RULA / REBA bands (trunk, upper arm, neck, wrist), the drill positions, the rifle positions, the movement techniques", () => {
  const need = [
    "work-overhead-drilling", "work-overhead-painting", "work-kneel-floor-level", "work-crouch-under-beam", "work-bench-bent-over", "work-bench-standing", "work-seated-precision", "work-microscope",
    "work-welding-crouch", "work-under-vehicle-wrench", "work-wrench-pull", "work-hammering", "work-sawing", "work-shovel-dig", "work-ladder-work", "work-hatch-push-up", "work-hatch-wheel",
    "work-reba-trunk-10", "work-reba-trunk-40", "work-reba-trunk-75", "work-reba-arm-20", "work-reba-arm-45", "work-reba-arm-90", "work-reba-arm-120", "work-reba-neck-10", "work-reba-neck-20", "work-reba-neck-40",
    "work-reba-wrist-neutral", "work-reba-wrist-flexed-30", "work-reba-wrist-extended-30",
    "mil-attention", "mil-parade-rest", "mil-at-ease", "mil-salute", "mil-fire-standing", "mil-fire-kneeling", "mil-fire-prone", "mil-fire-seated-supported", "mil-low-ready", "mil-high-ready",
    "mil-crouch-tactical", "mil-crawl-high", "mil-crawl-low", "mil-sprint-start", "mil-drop-to-prone", "mil-grenade-throw-cocked", "mil-bayonet-stance", "mil-ruck-march", "mil-sentry-order-arms",
    "mil-vehicle-climb", "mil-hatch-stand", "mil-plf-landing",
  ];
  for (const id of need) assert.ok(BY_ID.has(id), `${id} is missing`);
});

test("every posture has a plain name, a description of what it is and what it is for, a source, lower-case tags, a hand grip for each hand, and says whether it is symmetric", () => {
  for (const p of ALL) {
    assert.ok(p.name.length >= 8 && p.name.length <= 70, `${p.id}: name length ${p.name.length}`);
    assert.ok(p.description.length >= 100 && p.description.length <= 520, `${p.id}: description length ${p.description.length}`);
    assert.ok(/[.]$/.test(p.description), `${p.id}: the description ends with a full stop`);
    assert.ok(p.source.length >= 10, `${p.id}: source`);
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 4 && p.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), `${p.id}: tags ${JSON.stringify(p.tags)}`);
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: duplicate tags`);
    assert.ok(p.grips?.L in GRIPS && p.grips?.R in GRIPS, `${p.id}: grips`);
    assert.ok(p.tags.includes("symmetric") !== p.tags.includes("asymmetric"), `${p.id}: tagged symmetric or asymmetric, one of the two`);
  }
  // the sources of the military postures say what they rest on, and where the author could not open the manual
  for (const p of military) assert.ok(/TC 3-|FM 3-|illustrative|Knapik|Bezodis/.test(p.source), `${p.id}: source names the manual or says illustrative`);
  for (const p of work) assert.ok(/illustrative|RULA|REBA|ISO|Pheasant|Waters|NIOSH|OSHA|Hignett/.test(p.source), `${p.id}: source`);
});

// ---- the validator -----------------------------------------------------------------------------------------------------------------------------------
test("every posture passes validatePosture on the three bodies, without errors and without warnings", () => {
  const out = [];
  for (const [label, body] of Object.entries(BODIES)) {
    for (const p of ALL) {
      const r = validatePosture(body, p, { library: ALL });
      for (const e of r.errors) out.push(`${label} | ${p.id} | ${e}`);
      for (const w of r.warnings) out.push(`${label} | ${p.id} | warning: ${w}`);
    }
  }
  assert.equal(out.length, 0, out.slice(0, 30).join("\n  "));
});

test("an object a posture names (hints.prop) exists in the catalog with its params in range and its grip ids on the right hand; the rifle postures carry the rifle in the balance check", () => {
  const ROLES = new Set(["held", "support", "target"]);
  const noProp = new Set(["mil-attention", "mil-parade-rest", "mil-at-ease", "mil-salute", "mil-sprint-start", "mil-drop-to-prone", "mil-grenade-throw-cocked", "mil-grenade-throw-release", "mil-plf-landing"]);
  let withProp = 0;
  for (const p of ALL) {
    const hints = p.hints ?? {};
    const o = hints.prop;
    if (/^work-reba-/.test(p.id) || noProp.has(p.id)) { assert.ok(!o, `${p.id}: has no object`); continue; }
    assert.ok(o, `${p.id}: names the object it is for`);
    withProp++;
    const t = byType(o.type);
    assert.ok(t, `${p.id}: catalog has no type ${o.type}`);
    assert.ok(ROLES.has(o.role), `${p.id}: ${o.type} role ${o.role}`);
    assert.ok(typeof o.note === "string" && o.note.length > 25, `${p.id}: ${o.type} note`);
    if (o.params) {
      const keys = new Set(t.params.map((q) => q.key));
      const clamped = normalizeParams(o.type, o.params);
      for (const [k, v] of Object.entries(o.params)) { assert.ok(keys.has(k), `${p.id}: ${o.type} has no param ${k}`); assert.equal(clamped[k], v, `${p.id}: ${o.type}.${k} = ${v} is outside the range of the catalog (${clamped[k]})`); }
    }
    if (o.grips) {
      const grips = t.grips(o.params ?? {});
      for (const [hand, id] of Object.entries(o.grips)) {
        const g = grips.find((x) => x.id === id);
        assert.ok(g, `${p.id}: ${o.type} has no grip ${id} (has ${grips.map((x) => x.id).join(", ")})`);
        assert.ok(g.hand === hand || g.hand === "both", `${p.id}: grip ${id} is for the ${g.hand} hand, listed for ${hand}`);
      }
    }
    if (o.type === "rifle") assert.ok(hints.load && hints.load.mass >= 3, `${p.id}: a rifle is a load of the balance check`);
    if (hints.externalSupport) assert.ok(typeof hints.externalSupport === "string" || hints.externalSupport === true, `${p.id}: external support`);
  }
  assert.ok(withProp >= 28, `${withProp} postures name their object`);
  for (const p of military.filter((q) => q.hints?.prop?.type === "rifle" && q.hints.prop.grips)) assert.deepEqual(p.hints.prop.grips, { R: "pistol_grip", L: "handguard" }, `${p.id}: the right-handed rifle grips`);
});

// ---- symmetry and the mirrored posture ---------------------------------------------------------------------------------------------------------------
test("symmetric postures are symmetric, asymmetric ones are not (the tags tell the truth)", () => {
  const pairs = ["elbowAngle", "shoulderElevation", "kneeAngle", "hipAngle", "handHeightAboveFloor", "thighInclination", "wristFlexion", "ankleAngle"];
  for (const p of ALL) {
    const sym = p.tags.includes("symmetric"), asym = p.tags.includes("asymmetric");
    const m = measure(MAN, p).m;
    let worst = 0;
    for (const k of pairs) { const a = m[`${k}_L`], b = m[`${k}_R`]; if (typeof a === "number" && typeof b === "number") worst = Math.max(worst, k === "handHeightAboveFloor" ? Math.abs(a - b) * 100 : Math.abs(a - b)); }
    worst = Math.max(worst, Math.abs(m.trunkInclinationSide ?? 0), Math.abs(m.trunkTwist ?? 0), Math.abs(m.trunkLateralFlexion ?? 0), Math.abs(m.neckTwist ?? 0), Math.abs(m.headTilt ?? 0));
    if (sym) assert.ok(worst < 3, `${p.id}: tagged symmetric, the sides differ by ${worst.toFixed(1)} (degrees, or cm for the hands)`);
    if (asym) assert.ok(worst > 2, `${p.id}: tagged asymmetric, the sides differ by only ${worst.toFixed(1)}`);
  }
});

test("mirroring an asymmetric posture exchanges its sides (the left-handed variant of the right-handed rifle postures)", () => {
  for (const id of ["mil-fire-standing", "mil-fire-kneeling", "mil-grenade-throw-cocked", "mil-salute", "work-hammering", "work-sawing"]) {
    const p = get(id), body = MAN;
    const a = measure(body, p), e = expandPosture(p);
    const mir = mirrorPose({ root: e.root, angles: e.angles });
    const root = placePose(body, mir, { posture: p }), b = postureMetrics(body, mir, root);
    for (const k of ["handHeightAboveFloor", "elbowAngle", "kneeAngle", "shoulderElevation"]) {
      const tol = k === "handHeightAboveFloor" ? 0.01 : 1.0;
      near(b[`${k}_L`], a.m[`${k}_R`], tol, `${id} mirrored ${k}_L`);
      near(b[`${k}_R`], a.m[`${k}_L`], tol, `${id} mirrored ${k}_R`);
    }
    near(b.trunkInclination, a.m.trunkInclination, 0.5, `${id} mirrored forward lean`);
  }
});

// ---- RULA / REBA reference postures: one band, one quantity -----------------------------------------------------------------------------------------------
test("REBA trunk family: the trunk is inclined 10, 40 and 75 degrees (bands 0-20, 20-60, over 60), monotonic, with the other segments neutral", () => {
  const ids = ["work-reba-trunk-10", "work-reba-trunk-40", "work-reba-trunk-75"], want = [10, 40, 75];
  for (const [label, body] of Object.entries(BODIES)) {
    const vals = ids.map((id) => measure(body, get(id)).m.trunkInclination);
    ids.forEach((id, i) => near(vals[i], want[i], 4, `${id} on the ${label}: trunk inclination`));
    assert.ok(vals[0] < vals[1] && vals[1] < vals[2], `${label}: monotonic ${vals.map(f1)}`);
    within(vals[0], 0, 20, `${label}: band 0-20`); within(vals[1], 20, 60, `${label}: band 20-60`); above(vals[2], 60, `${label}: band over 60`);
  }
  for (const id of ids) each(id, (m, r, what) => { below(Math.abs(m.trunkInclinationSide), 2, `${what}: no side lean`); below(Math.abs(m.upperArmInclinationSagittal_L), 25, `${what}: the arms hang (about vertical in the world)`); above(r.m.comOverBase, 0, `${what}: balanced`); });
});

test("REBA upper-arm family: the upper arm is raised 20, 45, 90 and 120 degrees from the trunk, both sides alike, monotonic, trunk upright", () => {
  const ids = ["work-reba-arm-20", "work-reba-arm-45", "work-reba-arm-90", "work-reba-arm-120"], want = [20, 45, 90, 120];
  for (const [label, body] of Object.entries(BODIES)) {
    const vals = ids.map((id) => measure(body, get(id)).m);
    ids.forEach((id, i) => { near(vals[i].shoulderElevation_L, want[i], 3, `${id} on the ${label}: left upper arm`); near(vals[i].shoulderElevation_R, want[i], 3, `${id} on the ${label}: right upper arm`); below(Math.abs(vals[i].trunkInclination), 3, `${id} on the ${label}: trunk upright`); });
    for (let i = 1; i < 4; i++) assert.ok(vals[i].shoulderElevation_L > vals[i - 1].shoulderElevation_L, `${label}: monotonic`);
  }
  each("work-reba-arm-20", (m, r, what) => within(elbowFlex(m, "L"), 60, 100, `${what}: lower arm band 60-100 degrees of flexion`));
  each("work-reba-arm-120", (m, r, what) => assert.ok(m.handAboveHead_L && m.handAboveHead_R, `${what}: the hands are above the head`));
});

test("REBA neck family: the head is flexed 10, 20 and 40 degrees against the trunk (bands 0-20 and over 20), monotonic, the trunk and arms unchanged", () => {
  const ids = ["work-reba-neck-10", "work-reba-neck-20", "work-reba-neck-40"], want = [10, 20, 40];
  for (const [label, body] of Object.entries(BODIES)) {
    const vals = ids.map((id) => measure(body, get(id)).m);
    ids.forEach((id, i) => { near(vals[i].neckFlexion, want[i], 2, `${id} on the ${label}: neck flexion`); below(Math.abs(vals[i].trunkInclination), 2, `${id} on the ${label}: trunk upright`); });
    assert.ok(vals[0].neckFlexion < vals[1].neckFlexion && vals[1].neckFlexion < vals[2].neckFlexion, `${label}: monotonic`);
    near(vals[0].shoulderElevation_L, vals[2].shoulderElevation_L, 0.01, `${label}: the arms are the same in all three`);
  }
});

test("REBA wrist family: the wrist is neutral, flexed 30 and extended 30 degrees with the same arms (elbows near 90, forearms horizontal)", () => {
  each("work-reba-wrist-neutral", (m, r, what) => { near(m.wristFlexion_L, 0, 0.01, `${what}: left wrist`); near(m.wristFlexion_R, 0, 0.01, `${what}: right wrist`); near(m.elbowAngle_L, 90, 5, `${what}: elbow`); });
  each("work-reba-wrist-flexed-30", (m, r, what) => { near(m.wristFlexion_L, 30, 0.01, `${what}: left wrist`); near(m.wristFlexion_R, 30, 0.01, `${what}: right wrist`); });
  each("work-reba-wrist-extended-30", (m, r, what) => { near(m.wristFlexion_L, -30, 0.01, `${what}: left wrist`); near(m.wristFlexion_R, -30, 0.01, `${what}: right wrist`); });
  each("work-reba-wrist-neutral", (m, r, what) => near(m.shoulderElevation_L, 17, 8, `${what}: the upper arm stays in the first band of the upper-arm score (about 20)`));
});

// ---- occupational postures -----------------------------------------------------------------------------------------------------------------------------
test("standing at a bench: upright trunk, elbows near a right angle, hands on the bench top 0.1 m below the elbow; bent over a bench: the trunk is bent 30 degrees, the arms straight", () => {
  each("work-bench-standing", (m, r, what) => { below(Math.abs(m.trunkInclination), 3, `${what}: upright`); within(m.elbowAngle_L, 85, 115, `${what}: elbows`); within(m.neckFlexion, 8, 25, `${what}: head bent to the work (ISO 11226 25 degrees)`); });
  const r = measure(MAN, get("work-bench-standing"));
  near(r.lm("palm_centre_L").y, 1.05, 0.03, "work-bench-standing: palms on the bench top (1.05 m)");
  near(r.m.handHeightAboveFloor_L, r.lm("olecranon_L").y - 0.06, 0.04, "work-bench-standing: hands 0.06 m below the elbows (light manual work, 50 to 100 mm)");
  each("work-bench-bent-over", (m, r2, what) => { within(m.trunkInclination, 25, 40, `${what}: trunk bent over`); above(m.elbowAngle_L, 170, `${what}: arms straight`); });
  const b = measure(MAN, get("work-bench-bent-over"));
  near(b.lm("palm_centre_L").y, 0.8, 0.04, "work-bench-bent-over: palms on the bench top (0.78 m)");
});

test("overhead work: both hands above the shoulders (the drill hand above the head), arms raised over 120 degrees for drilling, the hatch pushed with straight arms", () => {
  each("work-overhead-drilling", (m, r, what) => { assert.ok(m.handAboveHead_L && m.handAboveHead_R, `${what}: hands above the head`); above(m.shoulderElevation_R, 120, `${what}: right arm over the REBA 90 degree band`); above(m.shoulderElevation_L, 120, `${what}: left arm`); below(Math.abs(m.trunkInclination), 5, `${what}: upright`); });
  near(measure(MAN, get("work-overhead-drilling")).lm("grip_centre_R").y, 1.9, 0.08, "work-overhead-drilling: the pistol grip is 0.2 m below the ceiling bit (bit tip 2.1 m)");
  each("work-overhead-painting", (m, r, what) => { assert.ok(m.handAboveShoulder_L && m.handAboveShoulder_R, `${what}: hands above the shoulder joints`); above(m.shoulderElevation_R, 120, `${what}: upper hand arm`); below(m.neckFlexion, -12, `${what}: head tipped back to see the ceiling`); });
  each("work-hatch-push-up", (m, r, what) => { assert.ok(m.handAboveHead_L && m.handAboveHead_R, `${what}: palms above the head`); above(m.shoulderElevation_L, 150, `${what}: arms raised`); above(m.elbowAngle_L, 135, `${what}: nearly straight`); });
  near(measure(MAN, get("work-hatch-push-up")).m.handHeightAboveFloor_L, 1.955, 0.05, "work-hatch-push-up: palms on the hatch cover (1.955 m)");
  each("work-ladder-work", (m, r, what) => { assert.ok(m.handAboveHead_R, `${what}: the working hand is above the head`); assert.ok(!m.handAboveHead_L, `${what}: the holding hand is on a rung at chest height`); within(m.handHeightAboveFloor_L, 1.0, 1.4, `${what}: left hand on the rung (above the feet)`); });
});

test("crouching postures: deep flexion of the knees, the trunk bent forward, the centre of mass over the feet, the head below the obstacle", () => {
  each("work-welding-crouch", (m, r, what) => { above(kneeFlex(m, "L"), 95, `${what}: deep knee flexion`); within(m.trunkInclination, 40, 50, `${what}: trunk`); within(m.neckFlexion, 15, 35, `${what}: head down to the weld`); above(m.comOverBase, 0, `${what}: balanced`); below(m.hipHeight, 0.65, `${what}: hips low`); });
  each("work-crouch-under-beam", (m, r, what) => { within(kneeFlex(m, "L"), 80, 100, `${what}: knees (a crouch under a 1.25 m beam)`); within(m.trunkInclination, 35, 45, `${what}: trunk`); below(r.lm("vertex").y, 1.15, `${what}: the head is under the beam (1.25 m)`); });
  const c = measure(MAN, get("work-crouch-under-beam"));
  below(c.lm("vertex").y, 1.25, "work-crouch-under-beam: vertex under the beam of the median man");
  near(c.m.handHeightAboveFloor_L, 1.235, 0.05, "work-crouch-under-beam: the left palm touches the beam underside");
  each("work-kneel-floor-level", (m, r, what) => { above(m.trunkInclination, 60, `${what}: trunk bent over 60 degrees (REBA top band)`); within(m.kneeHeight_L, 0.0, 0.2, `${what}: knees low`); below(m.handHeightAboveFloor_L, 0.3, `${what}: the left hand is near the floor`); });
});

test("tool postures: hammering with the head over the work and one hand raised; pulling a wrench with a stride; sawing and shovelling with the trunk bent 15 to 25 degrees", () => {
  each("work-hammering", (m, r, what) => { within(m.trunkInclination, 5, 15, `${what}: trunk`); within(m.footSeparationAnteroposterior, 0.1, 0.5, `${what}: left foot forward`); above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.05, `${what}: the hammer hand is above the holding hand`); });
  each("work-sawing", (m, r, what) => { within(m.trunkInclination, 10, 20, `${what}: trunk`); above(m.footSeparationAnteroposterior, 0.1, `${what}: left foot forward`); above(elbowFlex(m, "R"), 30, `${what}: the sawing elbow is bent`); });
  each("work-wrench-pull", (m, r, what) => { within(m.footSeparationAnteroposterior, 0.1, 0.6, `${what}: stride`); above(m.stanceWidth, 0.2, `${what}: base`); within(m.handHeightAboveFloor_R, 0.85, 1.1, `${what}: hand at the height of the hip`); });
  each("work-shovel-dig", (m, r, what) => { within(m.trunkInclination, 15, 28, `${what}: trunk`); above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.2, `${what}: the D handle hand is above the shaft hand`); });
});

test("seated work: sat at popliteal height with the trunk leaning forward 10 to 20 degrees and the head bent over the work; the microscope bends the neck more; the hands on the desk (0.74 m)", () => {
  each("work-seated-precision", (m, r, what) => { within(m.seatHeight, 0.33, 0.52, `${what}: seat height`); within(m.trunkInclination, 10, 18, `${what}: trunk`); within(m.neckFlexion, 25, 36, `${what}: neck (ISO 11226: 25 degrees is the limit for a limited time)`); near(m.kneeAngle_L, 85, 6, `${what}: knee`); });
  each("work-microscope", (m, r, what) => { within(m.trunkInclination, 14, 24, `${what}: trunk`); above(m.neckFlexion, 28, `${what}: head bent to the eyepieces`); within(m.handHeightAboveFloor_L, 0.55, 0.86, `${what}: hands on the desk (0.74 m; the 5th-percentile woman sits lower, the desk is fixed)`); });
  assert.ok(measure(MAN, get("work-microscope")).m.neckFlexion > measure(MAN, get("work-seated-precision")).m.neckFlexion, "the microscope bends the neck more than precision work on the desk");
  const e = measure(MAN, get("work-seated-precision"));
  near(e.lm("palm_centre_L").y, 0.76, 0.03, "work-seated-precision: left palm on the desk");
});

test("under a vehicle: lying on the back (trunk inclination -90), the head lifted, both arms raised above the chest holding the wrench 0.5 m above the floor", () => {
  each("work-under-vehicle-wrench", (m, r, what) => { near(m.trunkInclination, -93, 4, `${what}: supine`); within(m.neckFlexion, 8, 25, `${what}: head lifted`); below(m.eyeHeight, 0.4, `${what}: on the floor`); above(m.handHeightAboveFloor_R, 0.35, `${what}: the hands are well above the chest`); below(m.handHeightAboveFloor_R, 0.65, `${what}: under the vehicle (0.56 m)`); });
  const r = measure(MAN, get("work-under-vehicle-wrench"));
  near(r.lm("grip_centre_R").y, 0.52, 0.1, "work-under-vehicle-wrench: the grip is at the wrench (0.52 m)");
});

// ---- military: drill and ceremony ------------------------------------------------------------------------------------------------------------------------
test("attention: erect, arms along the seams, heels together with the toes out at 45 degrees; parade rest: feet apart, hands behind the back; at ease: weight on the left leg; salute: right hand at the eyebrow", () => {
  each("mil-attention", (m, r, what) => {
    below(Math.abs(m.trunkInclination), 3, `${what}: erect`); below(m.upperArmInclination_L, 15, `${what}: arms hang`); below(m.stanceWidth, 0.3, `${what}: narrow base`);
    above(m.kneeAngle_L, 170, `${what}: knees straight`);
    const h = r.lm("heel_sole_L"), hr = r.lm("heel_sole_R"), tl = r.lm("toe_sole_L"), tr = r.lm("toe_sole_R");
    below(Math.hypot(h.x - hr.x, h.z - hr.z), 0.1, `${what}: heels together (centres of the soles less than 0.1 m apart)`);
    const ang = (a, b) => (Math.atan2(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) * 180) / Math.PI;
    within(ang(tl, h) + ang(tr, hr), 25, 55, `${what}: the feet form an angle of about 45 degrees (TC 3-21.5; 25 to 55 on the model: the toe-out is 22 degrees of hip rotation per leg)`);
  });
  each("mil-parade-rest", (m, r, what) => {
    within(m.stanceWidth, 0.3, 0.55, `${what}: feet apart`); below(Math.abs(m.trunkInclination), 3, `${what}: erect`);
    below(m.handToShoulderForward_L, -0.05, `${what}: left hand behind the shoulder`); below(m.handToShoulderForward_R, -0.05, `${what}: right hand behind the shoulder`);
    below(m.handHeightAboveFloor_L, 1.1 * m.hipHeight + 0.15, `${what}: hands at the belt line`);
    assert.ok(m.shoulderFlexion_L < -30 && m.shoulderFlexion_R < -30, `${what}: shoulders extended`);
  });
  each("mil-at-ease", (m, r, what) => { assert.equal(m.legSupport, "left", `${what}: weight on the left leg`); above(m.kneeAngle_L, 170, `${what}: supporting knee`); below(m.kneeAngle_R, 170, `${what}: resting knee bent`); below(m.handToShoulderForward_L, -0.03, `${what}: hands behind`); });
  each("mil-salute", (m, r, what) => {
    within(m.upperArmInclination_R, 80, 110, `${what}: upper arm about horizontal`); within(m.elbowAngle_R, 55, 85, `${what}: elbow`); below(m.upperArmInclination_L, 15, `${what}: left arm at the side`);
    const tip = r.lm("index_tip_R"), eye = r.lm("eye_R");
    below(Math.hypot(tip.x - eye.x, tip.y - eye.y, tip.z - eye.z), 0.1, `${what}: forefinger tip at the right eyebrow`);
    assert.ok(tip.y > eye.y + 0.01, `${what}: above the eye`);
  });
  each("mil-sentry-order-arms", (m, r, what) => { below(Math.abs(m.trunkInclination), 3, `${what}: erect`); below(m.upperArmInclination_L, 15, `${what}: left arm at the side`); within(m.handHeightAboveFloor_R, 0.55, 0.95, `${what}: right hand on the rifle at hip height`); });
});

// ---- military: rifle positions ------------------------------------------------------------------------------------------------------------------------
test("rifle postures put the right eye behind the sight, both hands forward on the rifle, the right elbow bent, with the position's own legs: standing, supported, kneeling, seated, prone", () => {
  for (const id of ["mil-fire-standing", "mil-fire-standing-supported", "mil-fire-kneeling", "mil-fire-seated-supported", "mil-fire-prone", "mil-low-ready", "mil-high-ready", "mil-crouch-tactical"]) {
    each(id, (m, r, what) => {
      above(m.handReach_L, 0.28, `${what}: the left (support) hand is forward of the shoulder`);
      above(elbowFlex(m, "R"), 55, `${what}: the right elbow is bent`);
      assert.ok(m.shoulderFlexion_L > 40 && m.shoulderFlexion_R > 20, `${what}: both arms are raised forward`);
    });
  }
  for (const id of ["mil-fire-standing", "mil-fire-standing-supported", "mil-fire-kneeling", "mil-fire-seated-supported", "mil-fire-prone"]) {
    each(id, (m, r, what) => {
      const eye = r.lm("eye_R"), hand = r.lm("grip_centre_L");
      const d = Math.hypot(hand.x - eye.x, hand.y - eye.y, hand.z - eye.z);
      within(d, 0.25, 0.75, `${what}: the support hand is 0.25 to 0.75 m from the aiming eye (the rifle is about 0.8 m long)`);
      assert.ok(Math.abs(hand.y - eye.y) < 0.2, `${what}: the support hand is about at the eye line (the rifle is nearly level)`);
    });
  }
  each("mil-fire-standing", (m, r, what) => { above(m.kneeAngle_L, 160, `${what}: knees nearly straight`); within(m.trunkInclination, 3, 15, `${what}: weight forward`); above(m.comOverBase, 0.04, `${what}: balanced`); assert.equal(m.legSupport, "both", `${what}: both feet`); within(Math.abs(m.bodyHeading), 40, 65, `${what}: the body is turned 55 degrees to the line of fire`); });
  each("mil-fire-standing-supported", (m, r, what) => { within(m.trunkInclination, 8, 20, `${what}: leaning into the support`); });
  assert.ok(measure(MAN, get("mil-fire-standing-supported")).m.trunkInclination > measure(MAN, get("mil-fire-standing")).m.trunkInclination, "the supported position leans further forward");
  each("mil-fire-kneeling", (m, r, what) => {
    below(m.kneeHeight_R, 0.15, `${what}: the right knee is on the floor`); within(kneeFlex(m, "R"), 100, 150, `${what}: right knee deeply bent (buttocks toward the heel)`);
    within(m.thighInclination_L, -10, 35, `${what}: left thigh about horizontal`); within(kneeFlex(m, "L"), 60, 100, `${what}: left knee`); below(m.hipHeight, 0.6, `${what}: low position`);
  });
  each("mil-fire-seated-supported", (m, r, what) => { within(m.kneeAngle_L, 80, 90, `${what}: knees at about 90`); within(m.seatHeight, 0.33, 0.52, `${what}: seat at popliteal height`); within(m.trunkInclination, 3, 14, `${what}: trunk`); });
  each("mil-fire-prone", (m, r, what) => {
    if (what.includes("P50")) { below(r.lm("olecranon_L").y, 0.14, `${what}: left elbow on the ground`); below(r.lm("olecranon_R").y, 0.14, `${what}: right elbow on the ground`); }
    above(m.trunkInclination, 70, `${what}: on the front`); below(m.hipHeight, 0.4, `${what}: on the ground`); within(m.eyeHeight, 0.33, 0.55, `${what}: head raised, eye above the rifle sight line (the eye is 0.33 to 0.55 m high)`);
    within(elbowFlex(m, "L"), 45, 130, `${what}: support elbow bent`); above(m.neckFlexion, -75, `${what}: head extension within range`); below(m.neckFlexion, -40, `${what}: head raised against the trunk`);
    below(r.lm("olecranon_L").y, 0.22, `${what}: left elbow near the ground (the arms were solved for the median man: a small body is 0.15 m short)`); below(r.lm("olecranon_R").y, 0.22, `${what}: right elbow near the ground`);
  });
});

test("low ready: the hands are low and forward (below the high ready); high ready: the support hand is above the shoulder; both with the right hand near the shoulder pocket", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const lo = measure(body, get("mil-low-ready")), hi = measure(body, get("mil-high-ready"));
    assert.ok(hi.m.handHeightAboveFloor_L > lo.m.handHeightAboveFloor_L + 0.25, `${label}: the support hand is higher at the high ready`);
    assert.ok(hi.m.handAboveShoulder_L && !lo.m.handAboveShoulder_L, `${label}: the left hand is above the shoulder only at the high ready`);
    above(hi.m.shoulderElevation_L, 110, `${label}: raised support arm at the high ready`); below(lo.m.shoulderElevation_L, 100, `${label}: low support arm`);
    const a = lo.lm("grip_centre_R"), s = lo.lm("acromion_R");
    below(Math.hypot(a.x - s.x, a.y - s.y, a.z - s.z), 0.4, `${label}: the right hand is near the right shoulder`);
  }
  each("mil-low-ready", (m, r, what) => { below(m.handHeightAboveFloor_L, 1.35 * m.hipHeight + 0.2, `${what}: hands below the eyes`); below(m.handHeightAboveFloor_L, r.lm("eye_mid").y - 0.1, `${what}: the muzzle hand is below the eyes`); });
});

test("tactical crouch: knees bent 45 to 60 degrees, hips lowered 0.1 m or more, the rifle shouldered, balanced; bayonet stance: stride and knee flexion 30 to 40 degrees", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const c = measure(body, get("mil-crouch-tactical")), s = measure(body, get("mil-fire-standing"));
    within(kneeFlex(c.m, "L"), 40, 70, `${label}: knee flexion in the crouch`); assert.ok(c.m.hipHeight < s.m.hipHeight - 0.08, `${label}: the crouch is lower than standing fire`);
    above(c.m.comOverBase, -0.04, `${label}: balanced`);
  }
  each("mil-bayonet-stance", (m, r, what) => { within(kneeFlex(m, "L"), 25, 45, `${what}: front knee`); above(m.footSeparationAnteroposterior, 0.15, `${what}: left foot forward`); above(m.stanceWidth, 0.25, `${what}: base`); above(m.handReach_L, 0.25, `${what}: left hand extended on the handguard`); });
});

// ---- military: movement -----------------------------------------------------------------------------------------------------------------------------------
test("crawls: the high crawl is on forearms and knees with the trunk near horizontal about 0.3 m up; the low crawl is flat with the head below 0.3 m and one knee drawn up", () => {
  each("mil-crawl-high", (m, r, what) => { above(m.trunkInclination, 70, `${what}: trunk near horizontal`); within(m.hipHeight, 0.2, 0.45, `${what}: hips 0.2 to 0.45 m up`); within(m.eyeHeight, 0.25, 0.5, `${what}: head up`); within(r.lm("olecranon_L").y, -0.01, 0.1, `${what}: the elbows are on the ground`); above(180 - m.elbowAngle_L, 60, `${what}: elbows bent`); });
  each("mil-crawl-low", (m, r, what) => { above(m.trunkInclination, 80, `${what}: flat on the front`); below(m.eyeHeight, 0.3, `${what}: head down`); below(m.hipHeight, 0.4, `${what}: on the ground`); above(Math.abs(m.kneeAngle_L - m.kneeAngle_R), 40, `${what}: one leg drawn up`); });
  for (const [label, body] of Object.entries(BODIES)) assert.ok(measure(body, get("mil-crawl-low")).m.eyeHeight < measure(body, get("mil-crawl-high")).m.eyeHeight, `${label}: the low crawl is lower`);
});

test("rush and drop: the crouched start has the left foot forward with the knees bent 20 to 60 degrees and the trunk 25 to 40 degrees; the drop has both knees down and the hands forward", () => {
  each("mil-sprint-start", (m, r, what) => { within(m.trunkInclination, 25, 40, `${what}: trunk`); above(m.footSeparationAnteroposterior, 0.3, `${what}: stride`); within(kneeFlex(m, "L"), 45, 70, `${what}: front knee`); below(kneeFlex(m, "R"), 30, `${what}: rear knee`); within(elbowFlex(m, "L"), 70, 110, `${what}: running arm`); above(Math.abs(m.shoulderFlexion_L - m.shoulderFlexion_R), 60, `${what}: arms in opposition`); });
  each("mil-drop-to-prone", (m, r, what) => { within(m.trunkInclination, 35, 45, `${what}: trunk bent forward`); below(m.kneeHeight_L, 0.1, `${what}: knees down`); below(m.kneeHeight_R, 0.1, `${what}: knees down`); below(m.handHeightAboveFloor_L, 0.3, `${what}: hands near the ground`); });
});

test("grenade throw: cocked, the throwing arm is abducted to shoulder height with the elbow at 90 and the trunk is twisted away; at the release the arm is extended up and the weight is forward", () => {
  each("mil-grenade-throw-cocked", (m, r, what) => {
    within(m.shoulderElevation_R, 80, 100, `${what}: right arm at shoulder height`); within(m.elbowAngle_R, 80, 100, `${what}: elbow at 90`); assert.ok(m.handAboveShoulder_R, `${what}: the grenade hand is above the shoulder joint`);
    below(m.trunkTwist, -10, `${what}: thorax turned away from the pelvis`); within(Math.abs(m.bodyHeading), 40, 70, `${what}: the pelvis faces 60 degrees away from the target`);
    above(m.handToShoulderLateral_L, 0.35, `${what}: the left arm points out to the left of the pelvis, toward the target (the body is turned 60 degrees away from it)`);
  });
  each("mil-grenade-throw-release", (m, r, what) => { above(m.shoulderElevation_R, 110, `${what}: the throwing arm is up`); above(m.elbowAngle_R, 150, `${what}: nearly straight`); above(m.handToShoulderUp_R, 0.2, `${what}: the hand is well above the shoulder joint`); within(m.trunkInclination, 8, 20, `${what}: trunk forward`); above(m.footSeparationAnteroposterior, 0.2, `${what}: left foot forward`); });
});

test("ruck march: the trunk leans 8 to 16 degrees forward with the load on the back and the centre of mass over the feet; vehicle climb: one foot on a step 0.45 m up, hands on the rail; hatch stand: elbows on the rim; landing attitude: chin down, knees slightly bent", () => {
  each("mil-ruck-march", (m, r, what) => { within(m.trunkInclination, 8, 16, `${what}: forward lean`); above(m.comOverBase, 0.02, `${what}: balanced with the load`); assert.equal(m.legSupport, "both", `${what}: both feet`); above(elbowFlex(m, "L"), 100, `${what}: elbows strongly bent (thumbs in the straps)`); });
  assert.equal(get("mil-ruck-march").hints.load.mass, 25);
  const bare = structuredClone(get("mil-ruck-march")); delete bare.hints.load;
  for (const [label, body] of Object.entries(BODIES)) {
    const a = validatePosture(body, get("mil-ruck-march"), { library: ALL }).metrics.balanceMargin, b = validatePosture(body, bare, { library: ALL }).metrics.balanceMargin;
    assert.ok(typeof a === "number" && typeof b === "number" && Math.abs(a - b) > 0.01, `${label}: the load on the back is in the centre of mass (margin ${f1(a)} with, ${f1(b)} without)`);
  }
  const v = measure(MAN, get("mil-vehicle-climb"));
  near(v.lm("heel_sole_L").y, 0.45, 0.06, "mil-vehicle-climb: the left heel is on the step (0.45 m)"); assert.ok(v.lm("heel_sole_R").y < 0.03, "mil-vehicle-climb: the right foot is on the floor");
  each("mil-vehicle-climb", (m, r, what) => { above(m.hipAngle_L, 60, `${what}: hip`); below(m.kneeAngle_L, 70, `${what}: the raised knee is bent`); within(m.handHeightAboveFloor_L, 1.2, 1.9, `${what}: hands on the rail`); above(m.footSeparationAnteroposterior, 0.1, `${what}: the left foot is ahead`); });
  each("mil-hatch-stand", (m, r, what) => { below(Math.abs(m.trunkInclination), 3, `${what}: upright`); within(r.lm("olecranon_L").y, 1.1, 1.5, `${what}: elbows on the rim`); const e = r.lm("eye_mid"), h = r.lm("palm_centre_L"); below(Math.hypot(h.x - e.x, h.y - e.y, h.z - e.z), 0.25, `${what}: the hands are at the eyes`); });
  each("mil-plf-landing", (m, r, what) => { within(kneeFlex(m, "L"), 8, 30, `${what}: knees slightly bent`); above(m.neckFlexion, 25, `${what}: chin on the chest`); below(m.stanceWidth, 0.3, `${what}: feet together`); within(m.trunkInclination, -3, 10, `${what}: upright`); });
});
