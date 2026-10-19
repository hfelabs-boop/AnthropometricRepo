// Semantic tests of the two posture groups "Kneeling & squatting" (site/js/human/postures/kneeling.js, ids kneel-*) and "Locomotion" (locomotion.js, ids loco-*): what each
// posture MEANS, measured with metrics.js (docs/human3d/METRICS.md) and the landmarks of the fitted body on three bodies (5th-percentile woman, median man, 95th-percentile man
// of the US Army populations), on top of the structure rules and the validator, which is run here too (no errors and no warnings on the three bodies; postures.test.mjs runs the
// whole library on six).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-kneeling-locomotion.test.mjs"
// A tolerance has a reason: a literature value where there is one (the Perry and Winter joint angles of the gait phases, the squat depth definitions, the stair geometry of
// MIL-STD-1472, the ISO 11226 trunk bands) or else the name and the description of the posture. Values were measured first and the bounds set around them; a failing line names
// the quantity and the body. Heights are metres above the floor of the posture (the lowest supporting point), landmarks are those of fit.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { validatePosture, expandPosture, placePose, landmarkPosition, mirrorPose, poseEquals, CATEGORIES } from "../../site/js/human/pose.js";
import { postureMetrics } from "../../site/js/human/metrics.js";
import { byType, normalizeParams } from "../../site/js/human/catalog.js";
import { GRIPS } from "../../site/js/human/postures/grips.js";
import kneeling from "../../site/js/human/postures/kneeling.js";
import locomotion from "../../site/js/human/postures/locomotion.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = { "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95) };
const MAN = BODIES["P50 man"];
const ALL = [...kneeling, ...locomotion];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));
const get = (id) => { const p = BY_ID.get(id); assert.ok(p, `no posture ${id}`); return p; };

// ---- measuring ---------------------------------------------------------------------------------------------------------------------------------------
function measure(body, p) {
  const e = expandPosture(p), pose = { root: e.root, angles: e.angles }, root = placePose(body, pose, { posture: p });
  const lm = (id) => landmarkPosition(body, pose, root, id);
  return { m: postureMetrics(body, pose, root), pose, root, lm, e, body };
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
const kneeFlex = (m) => 180 - (m.kneeAngle_L + m.kneeAngle_R) / 2;
const kneeFlexSide = (m, s) => 180 - m[`kneeAngle_${s}`];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const mm = (v) => v * 1000;
/** lowest point of the sole of one foot (heel, balls, toe), metres */
const footLowest = (r, s) => Math.min(...["heel_sole", "ball_sole_medial", "ball_sole_lateral", "toe_sole", "toe_tip"].map((id) => r.lm(`${id}_${s}`).y));
const FLAT = (r, s, tol = 0.02) => { const h = r.lm(`heel_sole_${s}`).y, b = r.lm(`ball_sole_medial_${s}`).y; return Math.max(Math.abs(h - footLowest(r, s)), Math.abs(b - footLowest(r, s))) <= tol; };
const fwd = (r, id) => r.lm(id).z; // the figure faces +Z in every posture of these groups (heading 0)

// ---- structure -------------------------------------------------------------------------------------------------------------------------------------
test("the two groups hold at least 36 postures between them, with the kneel- and loco- prefixes, unique ids and the right category", () => {
  assert.ok(ALL.length >= 36, `${ALL.length} postures`);
  assert.ok(kneeling.length >= 15 && locomotion.length >= 20, `${kneeling.length} kneeling, ${locomotion.length} locomotion`);
  const ids = ALL.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  for (const p of kneeling) { assert.match(p.id, /^kneel-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Kneeling & squatting", p.id); }
  for (const p of locomotion) { assert.match(p.id, /^loco-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Locomotion", p.id); }
  assert.ok(CATEGORIES.some((c) => c.name === "Kneeling & squatting") && CATEGORIES.some((c) => c.name === "Locomotion"));
});

test("the plan of POSTURES.md exists: squats from quarter to deep, the half-kneeling lunge and the side lunge, two knees, hands and knees, bear crawl, plank and push-up; the eight phases of walking, running, step up and down, stairs, ladder, jump, march, side-step, crouch walking", () => {
  const need = [
    "kneel-squat-quarter", "kneel-squat-half", "kneel-squat-deep", "kneel-squat-wide", "kneel-squat-heels-up", "kneel-squat-elbows-on-knees", "kneel-squat-plumber", "kneel-half-lunge", "kneel-lunge-side", "kneel-upright-toes", "kneel-upright-instep", "kneel-quadruped", "kneel-bear-crawl", "kneel-plank", "kneel-pushup-down",
    "loco-walk-initial-contact", "loco-walk-loading-response", "loco-walk-mid-stance", "loco-walk-terminal-stance", "loco-walk-pre-swing", "loco-walk-initial-swing", "loco-walk-mid-swing", "loco-walk-terminal-swing",
    "loco-run-contact", "loco-run-midstance", "loco-run-pushoff", "loco-run-flight", "loco-march-high-step", "loco-step-up-place", "loco-step-up-push", "loco-step-up-top", "loco-step-down-reach", "loco-step-down-land",
    "loco-stairs-up", "loco-stairs-down", "loco-ladder-climb-foot-up", "loco-ladder-climb-foot-lift", "loco-jump-prepare", "loco-jump-takeoff", "loco-jump-land", "loco-sidestep", "loco-crouch-walk",
  ];
  for (const id of need) assert.ok(BY_ID.has(id), `${id} is missing`);
});

test("every posture has a plain name, a description of what it is and what it is for, a source, lower-case tags, a hand grip for each hand, and says whether it is symmetric", () => {
  for (const p of ALL) {
    assert.ok(p.name.length >= 8 && p.name.length <= 70, `${p.id}: name length ${p.name.length}`);
    assert.ok(p.description.length >= 100 && p.description.length <= 620, `${p.id}: description length ${p.description.length}`);
    assert.ok(/[.]$/.test(p.description), `${p.id}: the description ends with a full stop`);
    assert.ok(p.source.length >= 10, `${p.id}: source`);
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 4 && p.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), `${p.id}: tags ${JSON.stringify(p.tags)}`);
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: duplicate tags`);
    assert.ok(p.grips?.L in GRIPS && p.grips?.R in GRIPS, `${p.id}: grips`);
    assert.ok(p.tags.includes("symmetric") !== p.tags.includes("asymmetric"), `${p.id}: tagged symmetric or asymmetric, one of the two`);
  }
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

test("no posture uses hints.contactTolerance (the floor contacts are within the 15 mm of the validator or the posture says what else carries the weight), and every posture that is not balanced by its own feet says why", () => {
  for (const p of ALL) {
    assert.equal(p.hints?.contactTolerance, undefined, `${p.id}: contactTolerance`);
    if (p.hints?.externalSupport) assert.ok(typeof p.hints.externalSupport === "string" && p.hints.externalSupport.length > 5, `${p.id}: externalSupport names what carries the weight`);
    if (["hands-knees", "hands-feet", "elbows-knees", "knees+feet"].includes(p.support)) assert.ok(p.hints?.externalSupport, `${p.id}: a posture with two closed chains to the floor says what carries the second one`);
  }
});

test("an object a posture names (hints.prop) exists in the catalog with its params in range and its grip ids on the right hand", () => {
  const ROLES = new Set(["held", "support", "target"]);
  let withProp = 0;
  for (const p of ALL) {
    const o = p.hints?.prop;
    if (!o) continue;
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
  }
  assert.ok(withProp >= 12, `${withProp} postures name an object`);
  for (const id of ["loco-step-up-place", "loco-step-up-push", "loco-step-down-reach", "loco-step-down-land", "loco-stairs-up", "loco-stairs-down", "loco-ladder-climb-foot-up", "loco-ladder-climb-foot-lift"]) assert.ok(get(id).hints.prop, `${id}: names its step, stairs or ladder`);
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
    if (asym) assert.ok(worst > 4, `${p.id}: tagged asymmetric, the sides differ by only ${worst.toFixed(1)}`);
  }
});

test("mirroring a pose is an involution for every posture, and the mirror image of an asymmetric posture has its sides exchanged and the same clearance from the floor", () => {
  for (const p of ALL) {
    const e = expandPosture(p), pose = { root: e.root, angles: e.angles };
    assert.ok(poseEquals(mirrorPose(mirrorPose(pose)), pose, 1e-9), `${p.id}: mirrorPose twice is the identity`);
  }
  for (const p of ALL.filter((q) => q.tags.includes("asymmetric"))) {
    const a = measure(MAN, p), mir = mirrorPose({ root: a.e.root, angles: a.e.angles });
    const root = placePose(MAN, mir, { posture: p }), b = postureMetrics(MAN, mir, root);
    for (const k of ["kneeAngle", "hipAngle", "elbowAngle", "shoulderElevation", "ankleAngle"]) {
      near(b[`${k}_L`], a.m[`${k}_R`], 1.0, `${p.id} mirrored ${k}_L`);
      near(b[`${k}_R`], a.m[`${k}_L`], 1.0, `${p.id} mirrored ${k}_R`);
    }
    near(b.trunkInclination, a.m.trunkInclination, 0.5, `${p.id} mirrored forward lean`);
    near(b.pelvisHeight, a.m.pelvisHeight, 0.002, `${p.id} mirrored pelvis height (the placement does not depend on the side)`);
  }
});

// ---- kneeling and squatting: the squat family -------------------------------------------------------------------------------------------------------------------
const SQUATS = ["kneel-squat-quarter", "kneel-squat-half", "kneel-squat-deep"];

test("squat depth family: quarter, half and deep squat have knee flexion of about 45, 110 and 145 degrees (monotonic), the pelvis gets lower and the thighs go from 50 degrees below the horizontal to above it, the heels stay down", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const ph = SQUATS.map((id) => measure(body, get(id)));
    const [q, h, d] = ph.map((r) => r.m);
    within(kneeFlex(q), 38, 58, `${label}: quarter squat knee flexion (Schoenfeld 2010: a quarter squat is about 40 to 50 degrees)`);
    within(kneeFlex(h), 95, 125, `${label}: half squat knee flexion`);
    above(kneeFlex(d), 135, `${label}: deep squat knee flexion (Hemmerich 2006: 140 to 155 degrees)`);
    assert.ok(kneeFlex(q) + 25 < kneeFlex(h) && kneeFlex(h) + 15 < kneeFlex(d), `${label}: knee flexion rises with depth (${f1(kneeFlex(q))}, ${f1(kneeFlex(h))}, ${f1(kneeFlex(d))})`);
    assert.ok(q.pelvisHeight > h.pelvisHeight + 0.15 && h.pelvisHeight > d.pelvisHeight + 0.1, `${label}: the pelvis gets lower with depth (${f1(q.pelvisHeight)}, ${f1(h.pelvisHeight)}, ${f1(d.pelvisHeight)})`);
    near(h.thighInclination_L, 0, 12, `${label}: half squat: the thighs are horizontal ('parallel')`);
    below(q.thighInclination_L, -35, `${label}: quarter squat: the thighs are well below the horizontal`);
    above(d.thighInclination_L, 12, `${label}: deep squat: the hips are below the knees`);
    below(d.pelvisHeight, 0.4, `${label}: deep squat: the pelvis is low`);
    for (const r of ph) for (const s of ["L", "R"]) { below(mm(r.lm(`heel_sole_${s}`).y), 15, `${label}: heels down`); below(mm(r.lm(`ball_sole_medial_${s}`).y), 15, `${label}: balls of the feet down`); }
    within(h.trunkInclination, 25, 50, `${label}: half squat trunk inclination (the hip-to-C7 chord)`);
    within(q.trunkInclination, 15, 40, `${label}: quarter squat trunk inclination`);
    within(d.trunkInclination, 15, 40, `${label}: deep squat trunk inclination`);
    below(ph[2].e.angles.ankle_L[0], 35.01, `${label}: deep squat: ankle dorsiflexion within its range (35 degrees)`);
    above(ph[2].e.angles.ankle_L[0], 12, `${label}: and deep (the shank leans well forward)`);
    above(d.comOverBase, 0.0, `${label}: the deep squat is balanced over the feet (arms forward)`);
    for (const id of SQUATS) above(validatePosture(body, get(id), { library: ALL }).metrics.balanceMargin, 0.0, `${label} ${id}: balance margin`);
  }
});

test("squat variants: wide squat (feet and knees well apart, hips abducted), heels-up squat (balls of the feet, heels at least 10 cm up, knees deep), forearms on the thighs (elbows on the thighs), plumber's squat (trunk far forward, one hand low in front)", () => {
  each("kneel-squat-wide", (m, r, w) => {
    above(kneeFlex(m), 135, `${w}: deep knee flexion`);
    const deep = measure(r.body, get("kneel-squat-deep"));
    above(dist(r.lm("knee_top_L"), r.lm("knee_top_R")), dist(deep.lm("knee_top_L"), deep.lm("knee_top_R")) + 0.04, `${w}: the knees are further apart than in the plain deep squat`);
    above(r.e.angles.hip_L[1], 8, `${w}: hip abduction`);
    below(r.e.angles.hip_L[2], -8, `${w}: the thighs are externally rotated (toes out)`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.17, `${w}: the hands are together in front of the chest`);
    below(m.trunkInclination, 25, `${w}: the trunk stays upright between the thighs`);
  });
  each("kneel-squat-heels-up", (m, r, w) => {
    above(mm(r.lm("heel_sole_L").y), 80, `${w}: the heels are up (the ball of the foot is the support)`);
    below(mm(r.lm("ball_sole_medial_L").y), 15, `${w}: the balls of the feet are on the floor`);
    above(kneeFlex(m), 120, `${w}: deep knee flexion`);
    below(Math.abs(m.thighInclination_L), 30, `${w}: the thighs near horizontal`);
    const el = r.lm("olecranon_L"), kn = r.lm("knee_top_L");
    below(dist(el, kn), 0.26, `${w}: the elbows are near the knees (forearms rest on the thighs)`);
  });
  each("kneel-squat-elbows-on-knees", (m, r, w) => {
    above(kneeFlex(m), 100, `${w}: a low squat`);
    for (const s of ["L", "R"]) {
      const o = r.lm(`olecranon_${s}`), h = r.lm(`trochanterion_${s}`), k = r.lm(`knee_top_${s}`);
      below(dist(o, { x: (h.x + k.x) / 2, y: (h.y + k.y) / 2, z: (h.z + k.z) / 2 }), 0.12, `${w}: the ${s} elbow rests on the middle of the thigh`);
      below(dist(r.lm(`palm_centre_${s}`), k), 0.2, `${w}: the ${s} hand is by the knee`);
    }
    within(m.trunkInclination, 20, 55, `${w}: the trunk leans forward over the thighs`);
  });
  each("kneel-squat-plumber", (m, r, w) => {
    within(m.trunkInclination, 40, 65, `${w}: the trunk is bent far forward (ISO 11226 'not recommended' beyond 60 degrees)`);
    below(r.lm("palm_centre_R").y, 0.36, `${w}: the right hand works at floor level`);
    above(r.lm("palm_centre_R").z - r.lm("ball_sole_medial_R").z, 0.1, `${w}: and in front of the feet`);
    below(dist(r.lm("palm_centre_L"), r.lm("knee_top_L")), 0.27, `${w}: the left hand is braced on or by the knee`);
    above(kneeFlex(m), 105, `${w}: a deep squat`);
    below(m.eyeHeight, 0.9, `${w}: the head is low`);
  });
});

// ---- lunges and half-kneeling ---------------------------------------------------------------------------------------------------------------------------
test("half-kneeling lunge: a stride of 0.55 to 1.25 m, the right foot flat in front with the thigh about horizontal, the left knee close to the floor with its thigh near vertical, the trunk upright; side lunge: a wide base (0.5 m or more), the left knee bent, the right leg straight, trunk leaned forward", () => {
  each("kneel-half-lunge", (m, r, w) => {
    within(-m.footSeparationAnteroposterior, 0.55, 1.25, `${w}: stride length`);
    assert.ok(FLAT(r, "R", 0.015), `${w}: the front foot is flat`);
    within(kneeFlexSide(m, "R"), 70, 125, `${w}: the front knee`);
    within(m.thighInclination_R, -35, 25, `${w}: the front thigh is about horizontal`);
    below(mm(r.lm("knee_front_L").y), 125, `${w}: the rear knee is off the floor by at most 0.12 m`);
    above(mm(r.lm("knee_front_L").y), -8, `${w}: and not in it`);
    within(m.thighInclination_L, -100, -45, `${w}: the rear thigh leans back from the vertical by at most 45 degrees`);
    below(mm(footLowest(r, "L")), 75, `${w}: the rear foot is near the floor`);
    below(Math.abs(m.trunkInclination), 12, `${w}: the trunk is upright`);
    assert.ok(get("kneel-half-lunge").hints.dynamic, `${w}: a moment of a stepping movement`);
  });
  each("kneel-lunge-side", (m, r, w) => {
    above(m.stanceWidth, 0.5, `${w}: a wide base`);
    within(kneeFlexSide(m, "L"), 45, 110, `${w}: the left (bent) knee`);
    below(kneeFlexSide(m, "R"), 15, `${w}: the right leg is straight`);
    within(m.trunkInclination, 12, 45, `${w}: trunk lean`);
    assert.ok(FLAT(r, "L", 0.02) && FLAT(r, "R", 0.02), `${w}: both feet are flat`);
    above(r.e.angles.hip_R[1], 20, `${w}: the straight leg is abducted`);
  });
});

test("kneeling on both knees: toes tucked (heels up, thighs vertical, trunk upright, hands on the thighs) and insteps down (thighs near vertical, the shins on the floor, the hands working at waist height)", () => {
  each("kneel-upright-toes", (m, r, w) => {
    below(mm(r.lm("knee_front_L").y), 15, `${w}: the knees are on the floor`);
    above(mm(r.lm("heel_sole_L").y), 80, `${w}: the heels are up`);
    below(mm(r.lm("toe_tip_L").y), 30, `${w}: the toes are tucked under`);
    below(Math.abs(m.trunkInclination), 8, `${w}: upright`);
    below(Math.abs(m.thighInclination_L + 90), 18, `${w}: the thighs are near vertical`);
    for (const s of ["L", "R"]) { const h = r.lm(`trochanterion_${s}`), k = r.lm(`knee_top_${s}`); below(dist(r.lm(`palm_centre_${s}`), { x: (h.x + k.x) / 2, y: (h.y + k.y) / 2, z: (h.z + k.z) / 2 + 0.08 }), 0.18, `${w}: the ${s} hand rests at the side of the thigh`); }
  });
  each("kneel-upright-instep", (m, r, w) => {
    below(mm(r.lm("knee_front_L").y), 15, `${w}: the knees are on the floor`);
    above(mm(r.lm("heel_sole_L").y), 100, `${w}: the feet are behind the shins, heels up`);
    for (const s of ["L", "R"]) above(mm(footLowest(r, s)), -5, `${w}: and the toes do not go into the floor`);
    below(Math.abs(m.trunkInclination), 8, `${w}: upright`);
    below(Math.abs(m.thighInclination_L + 90), 18, `${w}: the thighs are near vertical`);
    within(m.handHeightAboveFloor_L, 0.6, 1.2, `${w}: the hands work at waist height`);
  });
});

// ---- on all fours -----------------------------------------------------------------------------------------------------------------------------------------
test("hands and knees: the back horizontal (trunk 70 to 100 degrees), arms nearly straight, hands near the floor, knees on it, the thighs vertical; the low postures of the family (plank, push-up down, bear crawl) are on hands and toes with the body straight and the hands near the floor", () => {
  each("kneel-quadruped", (m, r, w) => {
    within(m.trunkInclination, 70, 100, `${w}: the back is horizontal`);
    above(m.elbowAngle_L, 160, `${w}: the arms are almost straight`);
    below(mm(r.lm("knee_front_L").y), 15, `${w}: the knees are on the floor`);
    below(mm(Math.min(r.lm("palm_centre_L").y, r.lm("palm_centre_R").y)), 80, `${w}: the hands are near the floor`);
    within(m.thighInclination_L, -95, -65, `${w}: the thighs are vertical`);
    within(m.hipAngle_L, 75, 105, `${w}: the hips are bent about 90 degrees`);
    within(m.shoulderHeight_L, 0.35, 0.65, `${w}: the shoulders are about 0.45 m above the floor`);
    assert.ok(get("kneel-quadruped").hints.externalSupport, `${w}: says what carries the hands`);
  });
  each("kneel-plank", (m, r, w) => {
    within(m.trunkInclination, 65, 88, `${w}: the body slopes from the toes to the shoulders`);
    above(m.kneeAngle_L, 168, `${w}: the knees are straight`);
    above(m.hipAngle_L, 165, `${w}: the hips are straight`);
    above(m.elbowAngle_L, 170, `${w}: the arms are straight`);
    below(mm(Math.min(r.lm("palm_centre_L").y, r.lm("palm_centre_R").y)), 80, `${w}: the hands are near the floor`);
    below(mm(r.lm("toe_sole_L").y), 15, `${w}: on the toes`);
    above(mm(r.lm("heel_sole_L").y), 100, `${w}: heels up`);
    within(m.shoulderHeight_L, 0.25, 0.65, `${w}: the shoulders are 0.3 to 0.5 m above the floor`);
  });
  for (const [label, body] of Object.entries(BODIES)) {
    const up = measure(body, get("kneel-plank")), down = measure(body, get("kneel-pushup-down"));
    assert.ok(down.m.shoulderHeight_L < up.m.shoulderHeight_L - 0.1, `${label}: the shoulders are lower at the bottom of the push-up (${f1(down.m.shoulderHeight_L)} against ${f1(up.m.shoulderHeight_L)})`);
    within(180 - down.m.elbowAngle_L, 70, 125, `${label}: push-up down: elbow flexion about 90 degrees`);
    above(down.m.hipAngle_L, 165, `${label}: push-up down: the body stays straight`);
    above(down.m.kneeAngle_L, 168, `${label}: push-up down: knees straight`);
    below(mm(Math.min(down.lm("palm_centre_L").y, down.lm("palm_centre_R").y)), 110, `${label}: push-up down: the hands are near the floor`);
    const bear = measure(body, get("kneel-bear-crawl"));
    within(mm(bear.lm("knee_front_L").y), 40, 260, `${label}: bear crawl: the knees are a hand's breadth off the floor`);
    within(kneeFlex(bear.m), 90, 135, `${label}: bear crawl: knees bent`);
    above(bear.m.hipAngle_L, 60, `${label}: bear crawl: the hips are flexed`);
    below(mm(Math.min(bear.lm("palm_centre_L").y, bear.lm("palm_centre_R").y)), 110, `${label}: bear crawl: the hands are near the floor`);
    below(mm(bear.lm("toe_sole_L").y), 15, `${label}: bear crawl: on the toes`);
    below(Math.abs(bear.m.hipHeight - bear.m.shoulderHeight_L), 0.1, `${label}: bear crawl: the hips are about level with the shoulders`);
  }
});

// ---- locomotion: the eight phases of walking --------------------------------------------------------------------------------------------------------
// Perry (1992) / Winter (2009) joint angles at the instant of each phase (hip flexion, knee flexion, ankle dorsiflexion, degrees) of the right leg, % of the gait cycle; the left leg is 50 percent later.
const GAIT = [[0, 25, 4, 0], [5, 24, 10, -3], [12, 22, 16, -6], [20, 12, 12, -1], [31, 2, 8, 6], [40, -6, 6, 6], [45, -12, 8, 3], [50, -12, 12, -2], [57, -8, 30, -10], [62, -2, 40, -15], [67, 10, 55, -8], [73, 20, 60, -4], [80, 26, 28, 0], [87, 28, 12, 0], [93, 26, 6, 0], [100, 25, 4, 0]];
function gaitAt(t) {
  t = ((t % 100) + 100) % 100;
  for (let i = 0; i < GAIT.length - 1; i++) { const a = GAIT[i], b = GAIT[i + 1]; if (t >= a[0] && t <= b[0]) { const f = (t - a[0]) / (b[0] - a[0]); return [1, 2, 3].map((k) => a[k] + f * (b[k] - a[k])); } }
}
const PHASES = [["loco-walk-initial-contact", 0], ["loco-walk-loading-response", 12], ["loco-walk-mid-stance", 31], ["loco-walk-terminal-stance", 45], ["loco-walk-pre-swing", 57], ["loco-walk-initial-swing", 67], ["loco-walk-mid-swing", 80], ["loco-walk-terminal-swing", 93]];

test("walking: the joint angles of both legs follow the Perry / Winter curves at the instant of each phase (hip and knee within 12 degrees, ankle within 12)", () => {
  for (const [id, t] of PHASES) {
    const a = expandPosture(get(id)).angles;
    for (const [side, tt] of [["R", t], ["L", t + 50]]) {
      const [h, k, an] = gaitAt(tt);
      near(a[`hip_${side}`][0], h, 12, `${id}: hip_${side} at ${tt % 100} percent of the cycle`);
      near(a[`knee_${side}`][0], k, 12, `${id}: knee_${side} at ${tt % 100} percent`);
      near(a[`ankle_${side}`]?.[0] ?? 0, an, 12, `${id}: ankle_${side} at ${tt % 100} percent`);
    }
  }
});

test("walking: initial contact is on the right heel with the forefoot up and the leg reaching ahead, the left heel rising behind; the step is longest here and shorter at loading response", () => {
  const steps = [];
  each("loco-walk-initial-contact", (m, r, w) => {
    below(mm(r.lm("heel_sole_R").y), 15, `${w}: the right heel is on the floor`);
    above(r.lm("toe_sole_R").y - r.lm("heel_sole_R").y, 0.03, `${w}: the toes of the right foot are up`);
    above(mm(r.lm("heel_sole_L").y), 60, `${w}: the left heel is raised`);
    below(kneeFlexSide(m, "R"), 15, `${w}: the leading knee is almost straight`);
    below(m.footSeparationAnteroposterior, -0.4, `${w}: the right foot is well ahead of the left (step length)`);
    above(m.footSeparationAnteroposterior, -0.8, `${w}: and not further than a long step`);
    within(m.trunkInclination, 1, 9, `${w}: the trunk leans forward a few degrees`);
    steps.push(m.footSeparationAnteroposterior);
  });
  each("loco-walk-loading-response", (m, r, w) => {
    assert.ok(FLAT(r, "R", 0.015), `${w}: the right foot is flat`);
    within(kneeFlexSide(m, "R"), 15, 30, `${w}: the right knee flexes to take the weight`);
    above(mm(r.lm("heel_sole_L").y), 100, `${w}: the left heel is high`);
    below(mm(r.lm("toe_sole_L").y), 45, `${w}: with the left toes about to leave the floor`);
    above(m.footSeparationAnteroposterior, -0.6, `${w}: step length`);
  });
  for (const [label, body] of Object.entries(BODIES)) {
    const a = measure(body, get("loco-walk-initial-contact")).m.footSeparationAnteroposterior, b = measure(body, get("loco-walk-loading-response")).m.footSeparationAnteroposterior;
    above(Math.abs(a), Math.abs(b) + 0.05, `${label}: the stride is longest at initial contact, shorter at loading response`);
  }
});

test("walking: single support in mid-stance (right foot flat under the body, hip near neutral, left foot clear, centre of mass over the supporting foot) and terminal stance (heel raised, hip extended, left leg reaching)", () => {
  each("loco-walk-mid-stance", (m, r, w) => {
    assert.ok(FLAT(r, "R", 0.015), `${w}: the right foot is flat`);
    above(mm(footLowest(r, "L")), 35, `${w}: the swinging left foot clears the floor`);
    above(m.hipAngle_R, 170, `${w}: the hip of the stance leg is near neutral (thigh in line with the trunk)`);
    within(m.trunkInclination, -3, 4, `${w}: the trunk is upright`);
    above(m.comOverBase, -0.012, `${w}: the centre of mass is over the supporting foot`);
    below(kneeFlexSide(m, "L"), 40, `${w}: the swing knee`);
    above(kneeFlexSide(m, "L"), 20, `${w}: is flexed`);
  });
  each("loco-walk-terminal-stance", (m, r, w) => {
    above(mm(r.lm("heel_sole_R").y), 30, `${w}: the right heel is raised`);
    below(mm(r.lm("ball_sole_medial_R").y), 15, `${w}: the ball of the right foot is on the floor`);
    above(m.footSeparationAnteroposterior, 0.4, `${w}: the left foot is far ahead of the right`);
    above(mm(footLowest(r, "L")), 5, `${w}: the left foot is off the floor`);
    below(mm(r.lm("heel_sole_L").y), 110, `${w}: but only just`);
    above(m.hipAngle_R, 160, `${w}: the stance hip is extended, the thigh behind the vertical of the trunk`);
  });
});

test("walking: pre-swing (right knee bent about 35, heel high, toes on the floor, the left heel landed) and the three swing phases (knee flexion peaks in initial swing, falls to mid-swing and terminal swing)", () => {
  each("loco-walk-pre-swing", (m, r, w) => {
    within(kneeFlexSide(m, "R"), 28, 48, `${w}: the right knee flexes in pre-swing`);
    above(mm(r.lm("heel_sole_R").y), 100, `${w}: the right heel is high`);
    below(mm(r.lm("toe_sole_R").y), 45, `${w}: the toes are still on the floor`);
    below(mm(r.lm("heel_sole_L").y), 15, `${w}: the left heel has landed`);
    above(m.footSeparationAnteroposterior, 0.35, `${w}: the left foot is ahead`);
  });
  const knee = [];
  for (const [label, body] of Object.entries(BODIES)) {
    const ph = ["loco-walk-initial-swing", "loco-walk-mid-swing", "loco-walk-terminal-swing"].map((id) => measure(body, get(id)));
    const k = ph.map((r) => kneeFlexSide(r.m, "R"));
    within(k[0], 52, 72, `${label}: initial swing knee flexion (Perry: about 60 degrees)`);
    within(k[1], 25, 45, `${label}: mid-swing knee flexion`);
    below(k[2], 15, `${label}: terminal swing: the knee is almost straight`);
    assert.ok(k[0] > k[1] + 10 && k[1] > k[2] + 10, `${label}: the swing knee flexion falls from initial swing to terminal swing (${k.map(f1).join(", ")})`);
    for (const r of ph) assert.ok(FLAT(r, "L", 0.02) || r.lm("ball_sole_medial_L").y < 0.025, `${label}: the left (stance) foot is on the floor in the swing phases`);
    above(mm(footLowest(ph[0], "R")), 55, `${label}: initial swing: the right foot has left the floor (toe clearance)`);
    above(mm(footLowest(ph[1], "R")), 35, `${label}: mid-swing: the foot clears the floor`);
    below(mm(r2(ph[2]).heel), 90, `${label}: terminal swing: the foot is a hand's breadth above the floor`);
    below(ph[2].m.footSeparationAnteroposterior, -0.4, `${label}: terminal swing: the right foot reaches ahead`);
    const hip = ph.map((r) => 180 - r.m.hipAngle_R);
    above(hip[1], 18, `${label}: mid-swing: the thigh is forward`);
    knee.push(k);
  }
});
const r2 = (r) => ({ heel: r.lm("heel_sole_R").y });

test("walking: the arms swing against the legs and the pelvis turns with the leading leg, in every phase with a clear leading leg (right foot ahead: left arm forward, right arm back)", () => {
  for (const [id, t] of PHASES) {
    const a = expandPosture(get(id)).angles;
    const lead = gaitAt(t)[0] - gaitAt(t + 50)[0]; // right hip flexion minus left hip flexion
    if (Math.abs(lead) < 12) continue;
    const armDiff = a.shoulder_L[0] - a.shoulder_R[0];
    assert.ok(Math.sign(armDiff) === Math.sign(lead) && Math.abs(armDiff) >= 6, `${id}: the arm opposite the leading leg swings forward (arm difference ${armDiff.toFixed(0)} against leg difference ${lead.toFixed(0)})`);
  }
});

// ---- locomotion: running -------------------------------------------------------------------------------------------------------------------------------
test("running: foot strike (heel first, ahead of the body, knee bent, the other knee bent past a right angle, hands swinging), mid-stance (foot flat, knee loaded), push-off (toes only, leg behind, the other thigh driven forward), flight (both legs bent, one forward one back)", () => {
  each("loco-run-contact", (m, r, w) => {
    below(mm(r.lm("heel_sole_R").y), 15, `${w}: the right heel is on the floor`);
    within(kneeFlexSide(m, "R"), 15, 40, `${w}: the leading knee is bent`);
    above(kneeFlexSide(m, "L"), 70, `${w}: the trailing knee is bent past a right angle`);
    above(mm(footLowest(r, "L")), 150, `${w}: the trailing foot is well off the floor`);
    below(m.footSeparationAnteroposterior, -0.45, `${w}: the stride`);
    within(m.trunkInclination, 4, 14, `${w}: the trunk leans forward (running lean)`);
    within(elbowFlex(m, "L"), 80, 110, `${w}: the elbows are bent about 90 degrees`);
  });
  each("loco-run-midstance", (m, r, w) => {
    assert.ok(FLAT(r, "R", 0.015), `${w}: the right foot is flat`);
    within(kneeFlexSide(m, "R"), 30, 50, `${w}: the stance knee is loaded`);
    above(kneeFlexSide(m, "L"), 80, `${w}: the swing knee is flexed`);
    above(mm(footLowest(r, "L")), 200, `${w}: the swing foot is high`);
    above(m.comOverBase, -0.012, `${w}: the centre of mass is over the foot`);
    within(m.trunkInclination, 4, 14, `${w}: running lean`);
  });
  each("loco-run-pushoff", (m, r, w) => {
    above(mm(r.lm("heel_sole_R").y), 80, `${w}: the heel is off the floor`);
    below(mm(r.lm("toe_sole_R").y), 15, `${w}: the toes are on it`);
    below(r.e.angles.ankle_R[0], -20, `${w}: the ankle is plantar-flexed`);
    below(kneeFlexSide(m, "R"), 15, `${w}: the push-off knee is almost straight`);
    above(r.lm("trochanterion_R").z - r.lm("ball_sole_medial_R").z, 0.15, `${w}: the stance foot is behind the hip`);
    above(kneeFlexSide(m, "L"), 70, `${w}: the other knee is flexed`);
    above(m.thighInclination_L, -40, `${w}: and its thigh is driven forward and up`);
  });
  each("loco-run-flight", (m, r, w) => {
    above(kneeFlexSide(m, "R"), 55, `${w}: the trailing knee is bent`);
    above(kneeFlexSide(m, "L"), 55, `${w}: the leading knee is bent`);
    above(m.thighInclination_L - m.thighInclination_R, 10, `${w}: the left thigh is further forward than the right`);
    above(mm(r.lm("heel_sole_R").y), 300, `${w}: the trailing foot is high behind`);
  });
  assert.ok(/airborne/.test(get("loco-run-flight").hints.externalSupport) && get("loco-run-flight").hints.dynamic === true, "flight declares that it has no support");
});
const elbowFlex = (m, s) => 180 - m[`elbowAngle_${s}`];

// ---- locomotion: march, steps, stairs, ladder -----------------------------------------------------------------------------------------------------------
test("high-step march: the stance leg straight under an upright trunk, the other thigh horizontal with the shank vertical, opposite arm swing", () => {
  each("loco-march-high-step", (m, r, w) => {
    below(kneeFlexSide(m, "R"), 12, `${w}: the stance knee`);
    near(m.thighInclination_L, 0, 12, `${w}: the raised thigh is horizontal (ISO 7250-1 sitting thigh)`);
    within(kneeFlexSide(m, "L"), 80, 105, `${w}: the raised knee is bent about 90 degrees`);
    above(mm(r.lm("heel_sole_L").y), 250, `${w}: the raised foot is a step high`);
    within(m.trunkInclination, -4, 5, `${w}: upright`);
    above(m.comOverBase, -0.012, `${w}: the weight is over the stance foot`);
    assert.ok(measure(MAN, get("loco-march-high-step")).e.angles.shoulder_R[0] * measure(MAN, get("loco-march-high-step")).e.angles.shoulder_L[0] < 0, `${w}: the arms swing in opposite directions`);
  });
});

test("steps: the raised foot is 0.20 m (0.13 to 0.28 m for every body) above the floor foot in place, push and reach; the stair postures hold the rail at 0.8 to 1.2 m; steps up lean forward, steps down stay upright", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    for (const id of ["loco-step-up-place", "loco-step-up-push", "loco-step-down-reach", "loco-step-down-land"]) {
      const r = measure(body, get(id)), other = id.includes("land") ? "R" : "R";
      within(mm(footLowest(r, other)), 130, 280, `${label} ${id}: the foot on the step is about 0.2 m above the floor`);
      assert.ok(FLAT(r, "R", 0.02) || id.includes("land"), `${label} ${id}: the foot on the step is flat`);
    }
    near(footLowest(measure(body, get("loco-stairs-up")), "R"), 0.18, 0.06, `${label}: stairs up: the right foot is one riser (0.18 m) above the left`);
    near(footLowest(measure(body, get("loco-stairs-down")), "L"), 0.18, 0.06, `${label}: stairs down: the left foot is one riser above the right`);
    within(measure(body, get("loco-stairs-up")).lm("palm_centre_R").y, 0.85, 1.25, `${label}: stairs up: the right hand is at rail height`);
    within(measure(body, get("loco-stairs-down")).lm("palm_centre_R").y, 0.7, 1.05, `${label}: stairs down: the right hand is at rail height`);
    above(measure(body, get("loco-stairs-up")).m.trunkInclination, 5, `${label}: stairs up: leaning forward`);
    above(measure(body, get("loco-step-up-push")).m.trunkInclination, 14, `${label}: push-up: leaning over the knee`);
    below(Math.abs(measure(body, get("loco-step-down-reach")).m.trunkInclination), 6, `${label}: step down: upright`);
  }
  each("loco-step-up-place", (m, r, w) => { within(kneeFlexSide(m, "R"), 60, 100, `${w}: the leading knee flexion`); assert.ok(FLAT(r, "L", 0.02), `${w}: the left foot is flat on the floor`); });
  each("loco-step-up-push", (m, r, w) => { within(kneeFlexSide(m, "R"), 75, 100, `${w}: the stepping knee flexion`); above(mm(r.lm("heel_sole_L").y), 60, `${w}: the trailing heel is raised`); below(mm(r.lm("ball_sole_medial_L").y), 15, `${w}: the trailing toes are on the floor`); });
  each("loco-step-up-top", (m, r, w) => {
    assert.ok(FLAT(r, "R", 0.015), `${w}: the right foot is flat`);
    above(mm(footLowest(r, "L")), 150, `${w}: the left foot is lifted`);
    within(kneeFlexSide(m, "L"), 65, 120, `${w}: the lifted knee is bent`);
    above(m.comOverBase, -0.012, `${w}: over the stance foot`);
  });
  each("loco-step-down-reach", (m, r, w) => {
    below(mm(r.lm("toe_sole_L").y), 15, `${w}: the left toes reach the floor`);
    above(mm(r.lm("heel_sole_L").y), 50, `${w}: with the heel up`);
    within(kneeFlexSide(m, "R"), 30, 70, `${w}: the supporting knee bends to lower the body`);
  });
  each("loco-step-down-land", (m, r, w) => {
    assert.ok(FLAT(r, "L", 0.015), `${w}: the landing foot is flat`);
    above(mm(r.lm("heel_sole_R").y), 300, `${w}: the rear heel is raised on the step`);
    above(m.footSeparationAnteroposterior, 0.5, `${w}: the left foot is ahead of the right`);
  });
});

test("ladder: the raised foot is one rung (0.30 m along a 75 degree ladder, 0.29 m high) above the floor foot in the first phase and about halfway in the second; the hands are above the shoulders' height; the trunk is near upright", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const a = measure(body, get("loco-ladder-climb-foot-up")), b = measure(body, get("loco-ladder-climb-foot-lift"));
    near(footLowest(a, "R"), 0.29, 0.06, `${label}: raised foot one rung above (0.30 m rung spacing x sin 75)`);
    within(footLowest(b, "R"), 0.12, 0.25, `${label}: raised foot about halfway to the next rung`);
    above(footLowest(a, "R"), footLowest(b, "R") + 0.05, `${label}: higher in the first phase than in the second`);
    for (const r of [a, b]) {
      within(r.m.trunkInclination, -12, 12, `${label}: the body is close to vertical on a 75 degree ladder`);
      for (const s of ["L", "R"]) above(r.m[`handHeightAboveFloor_${s}`], 0.9, `${label}: the ${s} hand is on a rung at chest height`);
      below(Math.abs(r.m.handToShoulderLateral_L + r.m.handToShoulderLateral_R), 0.1, `${label}: hands symmetric about the midline`);
    }
    above(a.m.handHeightAboveFloor_L, a.m.handHeightAboveFloor_R + 0.15, `${label}: three-point climbing: the left hand is a rung above the right`);
    near(b.m.handHeightAboveFloor_L, b.m.handHeightAboveFloor_R, 0.02, `${label}: both hands on the same rung in the second phase`);
    within(kneeFlexSide(a.m, "R"), 80, 105, `${label}: the raised knee is bent about 90 degrees`);
    assert.ok(a.e.angles.knee_L[0] < 5, `${label}: the stance knee is straight`);
  }
});

// ---- locomotion: jump, side-step, crouch walking -----------------------------------------------------------------------------------------------------------
test("jump: the crouch (knees about 100 flexion, trunk leaning, arms back), the take-off (legs straight, heels up, hands above the head) and the landing (knees about 85, trunk leaning, arms forward, feet flat); the hips are lowest in the crouch, highest at take-off", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const c = measure(body, get("loco-jump-prepare")), t = measure(body, get("loco-jump-takeoff")), l = measure(body, get("loco-jump-land"));
    within(kneeFlex(c.m), 82, 112, `${label}: crouch knee flexion`);
    within(c.m.trunkInclination, 22, 48, `${label}: crouch trunk lean`);
    assert.ok(c.e.angles.shoulder_L[0] < -20, `${label}: the arms are swung back`);
    for (const s of ["L", "R"]) { below(mm(c.lm(`heel_sole_${s}`).y), 15, `${label}: crouch heels down`); }
    below(kneeFlex(t.m), 20, `${label}: take-off knees straight`);
    above(mm(t.lm("heel_sole_L").y), 80, `${label}: take-off heels up`);
    above(t.m.handAboveHeadBy_L, 0.1, `${label}: the hands are above the head at take-off`);
    within(kneeFlex(l.m), 65, 105, `${label}: landing knee flexion`);
    above(l.m.trunkInclination, 18, `${label}: landing trunk lean`);
    assert.ok(l.e.angles.shoulder_L[0] > 30, `${label}: the arms are forward on landing`);
    for (const s of ["L", "R"]) below(mm(l.lm(`heel_sole_${s}`).y), 15, `${label}: landing heels down`);
    assert.ok(c.m.pelvisHeight < l.m.pelvisHeight + 0.05 && l.m.pelvisHeight < t.m.pelvisHeight - 0.15, `${label}: pelvis height rises from the crouch (${f1(c.m.pelvisHeight)}) through the landing (${f1(l.m.pelvisHeight)}) to the take-off (${f1(t.m.pelvisHeight)})`);
    assert.equal(measure(body, get("loco-jump-takeoff")).e.angles.mtp_L[0] > 30, true, `${label}: toes dorsiflexed at take-off`);
  }
});

test("side-step: a wide base (feet at least 0.45 m apart outer edge to outer edge) with the left foot out, the left knee bent more than the right, the trunk upright; crouch walking: knees bent, trunk leaning 20 to 45 degrees, eyes low, the left heel raised behind", () => {
  each("loco-sidestep", (m, r, w) => {
    above(m.stanceWidth, 0.4, `${w}: stance width`);
    above(m.footSeparationMediolateral, 0.25, `${w}: the left ankle is well to the left of the right ankle`);
    above(kneeFlexSide(m, "L"), kneeFlexSide(m, "R") + 5, `${w}: the leading knee is bent more`);
    below(Math.abs(m.trunkInclination), 6, `${w}: upright`);
    below(mm(r.lm("heel_sole_L").y), 15, `${w}: the left foot has landed`);
    above(mm(footLowest(r, "R")), 2, `${w}: the right foot is just off the floor`);
  });
  each("loco-crouch-walk", (m, r, w) => {
    within(kneeFlexSide(m, "R"), 55, 100, `${w}: the front knee`);
    within(m.trunkInclination, 18, 45, `${w}: trunk lean`);
    above(mm(r.lm("heel_sole_L").y), 100, `${w}: the trailing heel is raised`);
    below(m.footSeparationAnteroposterior, -0.4, `${w}: the stride`);
    assert.ok(FLAT(r, "R", 0.015), `${w}: the front foot is flat`);
  });
  for (const [label, body] of Object.entries(BODIES)) {
    above(measure(body, get("loco-walk-mid-stance")).m.eyeHeight, measure(body, get("loco-crouch-walk")).m.eyeHeight + 0.3, `${label}: normal walking carries the head 0.3 m higher than crouch walking`);
  }
});

test("single-support postures with the free foot well off the floor keep the centre of mass over the supporting foot (a margin better than -12 mm) on the three bodies", () => {
  // (the swing foot is more than 20 mm off the floor in these, so the base of support of metrics.js is the stance foot alone)
  for (const id of ["loco-walk-mid-stance", "loco-walk-initial-swing", "loco-walk-mid-swing", "loco-run-midstance", "loco-march-high-step", "loco-step-up-top"]) {
    each(id, (m, r, w) => above(m.comOverBase, -0.012, `${w}: centre of mass over the base`));
  }
});
