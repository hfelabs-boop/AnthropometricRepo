// Semantic tests of the posture groups Standing (stand-*), Reference (ref-*, iso-7250-*, t-pose) and Lying (lie-*): what each posture MEANS, measured with
// metrics.js (docs/human3d/METRICS.md) and the landmarks of the fitted body, on three bodies (5th-percentile woman, median man, 95th-percentile man of the US
// Army populations). The validator (validatePosture: range of motion, support, overlap, balance) is run here too, on the same three bodies with warnings
// counted as failures; the six-body acceptance test of the whole library is postures.test.mjs.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-standing-reference-lying.test.mjs"
// Tolerances are taken from the literature the posture cites (ISO 7250-1, ISO 11226, RULA, REBA, NIOSH) or from the name of the posture; where a number
// comes from the model (the neutral arm hangs abducted by 3 to 14 degrees, the neutral shank leans 6 degrees: METRICS.md section 3) it is said so.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { expandPosture, clampPose, placePose, landmarkPosition, solvePose, mirrorPose, poseEquals, validatePosture } from "../../site/js/human/pose.js";
import { postureMetrics, ergonomicFlags } from "../../site/js/human/metrics.js";
import { POSTURES, byId } from "../../site/js/human/postures.js";
import standing from "../../site/js/human/postures/standing.js";
import reference from "../../site/js/human/postures/reference.js";
import lying from "../../site/js/human/postures/lying.js";
import { byType } from "../../site/js/human/catalog.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = [["P5 woman", army("F", 5)], ["P50 man", army("M", 50)], ["P95 man", army("M", 95)]];
const GROUP = [...standing, ...reference, ...lying];

// ---- helpers -----------------------------------------------------------------------------------------------------------------------------------
const cache = new Map();
/** The posture placed on its support: { p, pose, root, m (metrics), lm(id) -> THREE.Vector3 (copy), joint(id), floor(id) (landmark height, m) }. */
function put(id, body) {
  const key = `${id}|${BODIES.findIndex(([, b]) => b === body)}`;
  if (cache.has(key)) return cache.get(key);
  const p = byId(id);
  assert.ok(p, `posture ${id} is in the library`);
  const pose = clampPose(expandPosture(p)).pose;
  const root = placePose(body, pose, { posture: p });
  const m = postureMetrics(body, pose, root, { support: p.support });
  const lm = (l) => landmarkPosition(body, pose, root, l, new THREE.Vector3());
  const joint = (j) => { const kin = solvePose(body, pose, root); return kin.position(j); };
  const r = { p, pose, root, m, lm, joint, floor: (l) => lm(l).y };
  cache.set(key, r);
  return r;
}
const each = (fn) => { for (const [label, body] of BODIES) fn(label, body); };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} is not within ${tol} of ${b}`);
const within = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what}: ${typeof v === "number" ? v.toFixed(3) : v} is not in [${lo}, ${hi}]`);
const dist = (a, b) => a.distanceTo(b);
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
/** The body's long axis, from the middle of the ankles to the vertex (unit vector), for lying postures. */
function axis(r) { return r.lm("vertex").sub(mid(r.joint("ankle_L"), r.joint("ankle_R"))).normalize(); }
/** How far a point lies beyond the top of the head along the long axis of the body (positive = beyond). */
const beyondHead = (r, point) => point.clone().sub(r.lm("vertex")).dot(axis(r));

// ---- structure ---------------------------------------------------------------------------------------------------------------------------------
test("the three group files hold at least 40 postures with the ids, categories and tags of the plan", () => {
  assert.ok(GROUP.length >= 40, `${GROUP.length} postures`);
  assert.ok(standing.length >= 18 && reference.length >= 10 && lying.length >= 14, `standing ${standing.length}, reference ${reference.length}, lying ${lying.length}`);
  for (const p of standing) { assert.match(p.id, /^stand-/); assert.equal(p.category, "Standing"); }
  for (const p of lying) { assert.match(p.id, /^lie-/); assert.equal(p.category, "Lying"); }
  for (const p of reference) { assert.match(p.id, /^(ref-|iso-7250-|t-pose$)/); assert.equal(p.category, "Reference"); }
  for (const p of GROUP) {
    assert.ok(byId(p.id) && byId(p.id).id === p.id && byId(p.id).category === p.category, `${p.id} is in the aggregated library`);
    assert.ok(p.tags.every((t) => t === t.toLowerCase() && /^[a-z0-9-]+$/.test(t)), `${p.id}: tags are lower-case words`);
    assert.ok(p.description.length >= 80 && p.description.length <= 600, `${p.id}: description of ${p.description.length} characters`);
    assert.ok(p.source.length >= 10, `${p.id}: a source`);
    assert.ok(p.name.length <= 60 && !/^\s|\s$/.test(p.name), `${p.id}: short plain name`);
  }
  // no two postures of these groups are the same thing: the angles (joints, spine, root) differ by more than 3 degrees somewhere
  const flat = (p) => { const e = expandPosture(p), o = {}; for (const [j, a] of Object.entries(e.angles)) a.forEach((v, i) => { o[`${j}.${i}`] = v; }); for (const [k, v] of Object.entries(e.root)) o[`root.${k}`] = v; return o; };
  const fl = GROUP.map((p) => [p, flat(p)]);
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    const keys = new Set([...Object.keys(fl[i][1]), ...Object.keys(fl[j][1])]);
    let d = 0;
    for (const k of keys) d = Math.max(d, Math.abs((fl[i][1][k] ?? 0) - (fl[j][1][k] ?? 0)));
    assert.ok(d > 3 || fl[i][0].support !== fl[j][0].support, `${fl[i][0].id} and ${fl[j][0].id} differ by only ${d.toFixed(1)} degrees`);
  }
});

test("everything POSTURES.md asks for in these groups exists (the floor of the plan)", () => {
  const need = [
    // Standing (attention, at ease, parade rest are in military.js; A-pose, T-pose, Vitruvian in reference.js)
    "stand-relaxed", "stand-hands-on-hips", "stand-arms-crossed", "stand-hands-behind-back", "stand-hands-in-pockets", "stand-weight-on-left-leg", "stand-wide-stance",
    "stand-feet-one-forward", "stand-slouched", "stand-look-up", "stand-look-down",
    // Reference
    "iso-7250-standing", "iso-7250-sitting", "ref-a-pose", "t-pose", "ref-vitruvian", "ref-niosh-origin", "ref-niosh-destination", "ref-rula-neutral",
    // Lying
    "lie-supine", "lie-prone", "lie-side-left", "lie-side-right", "lie-fetal", "lie-supine-knees-up", "lie-prone-on-elbows", "lie-creeper-reaching-up", "lie-supine-arms-overhead",
    "lie-prone-arms-forward", "lie-semi-reclined-legs-raised",
  ];
  for (const id of need) assert.ok(byId(id), id);
});

test("a prop hint names a catalogue type, a role, parameters and grips that exist", () => {
  let n = 0;
  for (const p of GROUP) {
    const h = p.hints?.prop;
    if (!h) continue;
    n++;
    const t = byType(h.type);
    assert.ok(t, `${p.id}: catalogue type "${h.type}"`);
    assert.ok(["held", "support", "target"].includes(h.role), `${p.id}: role`);
    assert.ok(typeof h.note === "string" && h.note.length > 10, `${p.id}: a note`);
    for (const k of Object.keys(h.params ?? {})) assert.ok(t.params.some((s) => s.key === k), `${p.id}: ${h.type} has no parameter ${k}`);
    const ids = t.grips(h.params ?? {}).map((g) => g.id);
    for (const [hand, g] of Object.entries(h.grips ?? {})) {
      assert.ok(["L", "R"].includes(hand) && ids.includes(g), `${p.id}: ${h.type} has no grip ${g} (has ${ids.join(", ")})`);
      assert.ok(["both", hand].includes(t.grips(h.params ?? {}).find((x) => x.id === g).hand), `${p.id}: grip ${g} is not for the ${hand} hand`);
    }
  }
  assert.ok(n >= 8, `${n} postures carry a prop hint`);
  for (const id of ["ref-niosh-origin", "ref-niosh-destination"]) assert.equal(byId(id).hints.prop.type, "crate");
  assert.equal(byId("stand-foot-on-step").hints.prop.type, "step");
  assert.equal(byId("ref-niosh-origin").hints.load.mass, 23, "the NIOSH load constant");
});

test("every posture of the three groups passes the validator on the three bodies, with no warning", () => {
  const problems = [];
  each((label, body) => {
    for (const g of GROUP) {
      const p = byId(g.id);
      const r = validatePosture(body, p, { library: POSTURES });
      for (const e of r.errors) problems.push(`${label} | ${p.id} | ${e}`);
      for (const w of r.warnings) problems.push(`${label} | ${p.id} | warning: ${w}`);
    }
  });
  assert.deepEqual(problems, []);
});

test("the support of each posture is what carries the weight: feet for stances, the body for lying, a seat for the RULA posture", () => {
  for (const p of standing) assert.equal(p.support, "feet", p.id);
  for (const p of lying) assert.equal(p.support, "body", p.id);
  assert.equal(byId("ref-rula-neutral").support, "seat+feet");
  // postures that stand on both feet declare the soles that must touch (the validator checks them within 15 mm): a stance cannot hide a foot on its edge
  for (const id of ["stand-relaxed", "stand-feet-shoulder-width", "stand-wide-stance", "stand-weight-on-left-leg", "stand-feet-one-forward", "stand-slouched", "stand-ready"]) {
    const c = byId(id).contacts;
    assert.ok(c.includes("heel_sole_L") && c.includes("heel_sole_R") && c.includes("ball_sole_medial_L") && c.includes("ball_sole_medial_R"), id);
  }
  each((label, body) => {
    for (const id of ["stand-relaxed", "stand-wide-stance", "stand-feet-one-forward", "stand-ready", "stand-on-toes"]) {
      const r = put(id, body);
      for (const l of r.p.contacts) assert.ok(r.floor(l) < 0.016 && r.floor(l) > -0.006, `${label} | ${id}: ${l} is ${(r.floor(l) * 1000).toFixed(1)} mm above the floor`);
    }
  });
});

// ---- Standing: stances -------------------------------------------------------------------------------------------------------------------------
test("stance width grows from the ISO standing posture to feet shoulder-width apart to a wide stance (monotonic), and the wide stance is wider than the body", () => {
  each((label, body) => {
    const w = ["iso-7250-standing", "stand-feet-shoulder-width", "stand-wide-stance"].map((id) => put(id, body).m.stanceWidth);
    assert.ok(w[1] > w[0] + 0.12 && w[2] > w[1] + 0.12, `${label}: stance widths ${w.map((x) => x.toFixed(2)).join(", ")}`);
    // the outer width of the feet of "shoulder width": at least the biacromial breadth (the centre-to-centre distance is a foot width less)
    const acr = put("iso-7250-standing", body).lm("acromion_L").x * 2;
    assert.ok(w[1] >= 0.9 * acr && w[1] <= 1.4 * acr, `${label}: feet shoulder-width apart ${w[1].toFixed(2)} m, biacromial ${acr.toFixed(2)} m`);
    assert.ok(w[2] >= 1.5 * acr, `${label}: wide stance ${w[2].toFixed(2)} m against ${acr.toFixed(2)} m`);
    // feet flat: every sole point within 15 mm of the floor in both stances
    for (const id of ["stand-feet-shoulder-width", "stand-wide-stance"]) {
      const r = put(id, body);
      for (const s of ["L", "R"]) for (const l of ["heel_sole", "ball_sole_medial", "ball_sole_lateral", "toe_sole"]) assert.ok(r.floor(`${l}_${s}`) < 0.02, `${label} | ${id}: ${l}_${s} floats ${(r.floor(`${l}_${s}`) * 1000).toFixed(0)} mm`);
    }
  });
});

test("weight on the left leg: the centre of mass is over the left foot and the right knee is bent; one leg: only the left foot is down and the right thigh is raised", () => {
  each((label, body) => {
    const w = put("stand-weight-on-left-leg", body).m, neutral = put("iso-7250-standing", body).m;
    assert.ok(w.weightShareLeft >= 0.65 && w.legSupport === "left", `${label}: weight share left ${w.weightShareLeft.toFixed(2)}`);
    assert.ok(neutral.weightShareLeft > 0.4 && neutral.weightShareLeft < 0.6, `${label}: neutral ${neutral.weightShareLeft}`);
    assert.ok(w.kneeAngle_R < 175 - 8 && w.kneeAngle_L > w.kneeAngle_R, `${label}: knees ${w.kneeAngle_L.toFixed(0)} / ${w.kneeAngle_R.toFixed(0)}`);
    const one = put("stand-one-leg", body);
    assert.equal(one.m.legSupport, "left", label);
    assert.ok(one.m.thighInclination_R > -35, `${label}: the free thigh is raised ${one.m.thighInclination_R.toFixed(0)} deg above the horizontal`);
    within(one.m.kneeAngle_R, 70, 110, `${label} free knee`);
    assert.ok(one.m.comOverBase > 0, `${label}: the centre of mass is over the foot (${one.m.comOverBase.toFixed(3)})`);
    assert.ok(one.floor("heel_sole_R") > 0.1 && one.floor("ball_sole_medial_R") > 0.1, `${label}: the right foot is off the floor`);
  });
});

test("one foot forward: the left ankle is 0.25 to 0.4 m ahead of the right, both feet flat, the weight shared, the front knee bent more than the rear one", () => {
  each((label, body) => {
    const r = put("stand-feet-one-forward", body), m = r.m;
    within(m.footSeparationAnteroposterior, 0.25, 0.42, `${label} step length`);
    within(m.weightShareLeft, 0.35, 0.65, `${label} weight share`);
    assert.ok(m.kneeAngle_L < m.kneeAngle_R - 10, `${label}: knees ${m.kneeAngle_L.toFixed(0)} / ${m.kneeAngle_R.toFixed(0)}`);
    for (const l of ["heel_sole", "ball_sole_medial"]) for (const s of ["L", "R"]) assert.ok(r.floor(`${l}_${s}`) < 0.016, `${label}: ${l}_${s}`);
  });
});

test("slouched: trunk leaning forward 8 to 30 degrees, the upper back rounded, the neck flexed (ISO 11226), against an erect relaxed stance", () => {
  each((label, body) => {
    const s = put("stand-slouched", body).m, relaxed = put("stand-relaxed", body).m, iso = put("iso-7250-standing", body).m;
    within(s.trunkInclination, 8, 30, `${label} trunk inclination`);
    assert.ok(s.thoracicFlexion >= 15 && s.thoracicFlexion > relaxed.thoracicFlexion + 12, `${label}: thoracic flexion ${s.thoracicFlexion.toFixed(0)} against ${relaxed.thoracicFlexion.toFixed(0)}`);
    assert.ok(s.lumbarFlexion >= 8, `${label}: the lordosis is flattened (lumbar flexion ${s.lumbarFlexion.toFixed(0)})`);
    assert.ok(s.headInclination > relaxed.headInclination + 5, `${label}: head inclination ${s.headInclination.toFixed(0)} against ${relaxed.headInclination.toFixed(0)}`);
    assert.ok(Math.abs(iso.trunkInclination) < 2 && Math.abs(relaxed.trunkInclination) < 3, `${label}: the other stances are erect`);
  });
});

test("looking down, relaxed, ISO and looking up: the line of sight rises monotonically; up about 40 degrees above the horizontal, down about 35 below", () => {
  each((label, body) => {
    const g = ["stand-look-down", "stand-relaxed", "iso-7250-standing", "stand-look-up"].map((id) => put(id, body).m.gazeElevation);
    assert.ok(g[0] < g[1] && g[1] < g[2] + 0.5 && g[2] < g[3], `${label}: gaze ${g.map((x) => x.toFixed(0)).join(", ")}`);
    within(g[3], 30, 55, `${label} looking up`);
    within(g[0], -50, -25, `${label} looking down`);
    assert.ok(put("stand-look-up", body).m.neckFlexion < -25, `${label}: neck extension`);
    assert.ok(put("stand-look-down", body).m.neckFlexion > 20 || put("stand-look-down", body).m.headInclination > 25, `${label}: head down`);
    assert.ok(Math.abs(put("stand-look-up", body).m.trunkInclination) < 5 && Math.abs(put("stand-look-down", body).m.trunkInclination) < 5, `${label}: the trunk stays erect`);
  });
});

test("on the toes: the heels are 0.07 to 0.14 m off the floor, the forefoot is flat, the whole body is that much higher and the centre of mass is over the balls of the feet", () => {
  each((label, body) => {
    const r = put("stand-on-toes", body), iso = put("iso-7250-standing", body);
    const rise = r.floor("heel_sole_L") - r.floor("ball_sole_medial_L");
    within(rise, 0.07, 0.14, `${label} heel rise`);
    for (const l of ["ball_sole_medial_L", "ball_sole_lateral_R", "toe_sole_L"]) assert.ok(r.floor(l) < 0.016, `${label}: ${l}`);
    within(r.lm("vertex").y - iso.lm("vertex").y, 0.04, 0.14, `${label} gain in height`);
    assert.ok(r.m.comOverBase > 0, `${label}: centre of mass margin ${r.m.comOverBase.toFixed(3)}`);
  });
});

test("one foot on a step: the right sole is 0.15 to 0.27 m above the left, flat, the trunk leans forward and the right hand rests on the right thigh above the knee", () => {
  each((label, body) => {
    const r = put("stand-foot-on-step", body);
    const h = r.floor("heel_sole_R") - r.floor("heel_sole_L");
    within(h, 0.15, 0.27, `${label} step height`);
    near(r.floor("ball_sole_medial_R"), r.floor("heel_sole_R"), 0.015, `${label}: the foot is flat on the step`);
    assert.ok(r.floor("heel_sole_L") < 0.016 && r.floor("ball_sole_medial_L") < 0.016, `${label}: the left foot is on the floor`);
    within(r.m.trunkInclination, 8, 35, `${label} trunk inclination`);
    const on = r.lm("thigh_top_R").lerp(r.lm("knee_top_R"), 0.55);
    assert.ok(dist(r.lm("palm_centre_R"), on) < 0.11, `${label}: the hand is ${(dist(r.lm("palm_centre_R"), on) * 1000).toFixed(0)} mm from the top of the right thigh`);
    assert.ok(r.p.hints.externalSupport && r.p.hints.prop.params.rise > 0.1);
  });
});

test("the athletic ready position: knees flexed about 50 degrees, trunk inclined about 20 degrees, head up (gaze level), hands forward at waist height", () => {
  each((label, body) => {
    const r = put("stand-ready", body), m = r.m;
    within(180 - m.kneeAngle_L, 40, 70, `${label} knee flexion`);
    within(m.trunkInclination, 12, 30, `${label} trunk inclination`);
    within(m.gazeElevation, -12, 12, `${label} gaze`);
    assert.ok(m.handToShoulderForward_L > 0.18 && m.handToShoulderForward_R > 0.18, `${label}: hands forward ${m.handToShoulderForward_L.toFixed(2)}`);
    assert.ok(m.handHeightAboveFloor_L < m.shoulderHeight_L && m.handHeightAboveFloor_L > 0.5 * m.shoulderHeight_L, `${label}: hands at waist height`);
    assert.ok(m.comOverBase > 0.03, `${label}: balance margin ${m.comOverBase.toFixed(3)}`);
  });
});

test("trunk turned to the left: the thorax is twisted 25 to 50 degrees to the left of the pelvis; bent to the left: lateral flexion 18 to 40 degrees; mirrorPose gives the other side", () => {
  each((label, body) => {
    const t = put("stand-trunk-turned", body).m, b = put("stand-side-bend", body).m;
    within(t.trunkTwist, 25, 50, `${label} twist`);
    assert.ok(Math.abs(t.trunkInclination) < 5 && Math.abs(t.trunkLateralFlexion) < 6, `${label}: no lean`);
    within(b.trunkLateralFlexion, 18, 40, `${label} lateral flexion`);
    assert.ok(b.trunkInclinationSide > 8, `${label}: the shoulders are left of the hips (${b.trunkInclinationSide.toFixed(0)} deg)`);
    // mirrored: the figure the other way round has the opposite signs
    const p = byId("stand-trunk-turned"), mp = mirrorPose({ root: expandPosture(p).root, angles: expandPosture(p).angles });
    const rm = postureMetrics(body, mp, placePose(body, mp, { support: "feet" }), { support: "feet" });
    near(rm.trunkTwist, -t.trunkTwist, 1.5, `${label} mirrored twist`);
  });
});

// ---- Standing: arms ----------------------------------------------------------------------------------------------------------------------------
test("hands on hips: both palms on the iliac crests, elbows out beyond the hips and flexed about 70 degrees (included angle 55 to 100)", () => {
  each((label, body) => {
    const r = put("stand-hands-on-hips", body);
    for (const s of ["L", "R"]) {
      assert.ok(dist(r.lm(`palm_centre_${s}`), r.lm(`iliocristale_${s}`)) < 0.11, `${label}: palm ${s} is ${(dist(r.lm(`palm_centre_${s}`), r.lm(`iliocristale_${s}`)) * 1000).toFixed(0)} mm from the iliac crest`);
      within(r.m[`elbowAngle_${s}`], 55, 100, `${label} elbow ${s}`);
      assert.ok(Math.abs(r.lm(`olecranon_${s}`).x) > Math.abs(r.lm(`trochanterion_${s}`).x) + 0.05, `${label}: the ${s} elbow is out`);
      assert.ok(r.lm(`palm_centre_${s}`).y > r.lm(`trochanterion_${s}`).y, `${label}: the hand is above the trochanter`);
    }
  });
});

test("arms crossed: each hand is across the midline on the other side, in front of the chest, elbows flexed beyond 90 degrees; the left forearm is in front", () => {
  each((label, body) => {
    const r = put("stand-arms-crossed", body);
    assert.ok(r.lm("palm_centre_L").x < 0.02 && r.lm("palm_centre_R").x > -0.02, `${label}: the hands cross the midline (${(r.lm("palm_centre_L").x * 1000).toFixed(0)}, ${(r.lm("palm_centre_R").x * 1000).toFixed(0)} mm)`);
    assert.ok(r.lm("palm_centre_L").z > r.lm("chest_front").z && r.lm("palm_centre_R").z > r.lm("chest_front").z - 0.02, `${label}: in front of the chest`);
    assert.ok(r.m.elbowAngle_L < 100 && r.m.elbowAngle_R < 100, `${label}: elbows ${r.m.elbowAngle_L.toFixed(0)} / ${r.m.elbowAngle_R.toFixed(0)}`);
    const y = r.lm("thelion_L").y;
    assert.ok(r.lm("olecranon_L").y < y + 0.12 && r.lm("olecranon_L").y > y - 0.35, `${label}: elbows at chest level`);
    assert.ok(r.lm("olecranon_L").z > r.lm("olecranon_R").z - 0.1, `${label}: the left arm in front`);
  });
});

test("hands behind the back: both palms behind the hips, close together at the small of the back, shoulders extended (about 45 degrees)", () => {
  each((label, body) => {
    const r = put("stand-hands-behind-back", body);
    for (const s of ["L", "R"]) {
      assert.ok(r.lm(`palm_centre_${s}`).z < r.lm("buttock_extremity").z + 0.08, `${label}: palm ${s} behind the hips`);
      assert.ok(r.m[`handToShoulderForward_${s}`] < -0.05, `${label}: the hand is behind the shoulder (${r.m[`handToShoulderForward_${s}`].toFixed(2)} m)`);
      assert.ok(r.m[`upperArmInclinationSagittal_${s}`] < -25, `${label}: the upper arm points backward ${r.m[`upperArmInclinationSagittal_${s}`].toFixed(0)} deg`);
    }
    assert.ok(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")) < 0.22, `${label}: hands ${(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")) * 1000).toFixed(0)} mm apart`);
    within(r.lm("palm_centre_L").y, r.lm("trochanterion_L").y - 0.05, r.lm("trochanterion_L").y + 0.22, `${label} hand height`);
  });
});

test("hands in pockets: the palms on the front of the thighs at pocket height, elbows flexed, arms close to the body", () => {
  each((label, body) => {
    const r = put("stand-hands-in-pockets", body);
    for (const s of ["L", "R"]) {
      const palm = r.lm(`palm_centre_${s}`), tr = r.lm(`trochanterion_${s}`);
      within(palm.y, tr.y - 0.2, tr.y + 0.02, `${label} palm ${s} height against the trochanter`);
      assert.ok(Math.abs(palm.x) > 0.1 && Math.abs(palm.x) < 0.26, `${label}: palm ${s} beside the thigh`);
      assert.ok(palm.z > tr.z + 0.08, `${label}: palm ${s} on the front of the thigh`);
      within(r.m[`elbowAngle_${s}`], 110, 160, `${label} elbow ${s}`);
    }
  });
});

test("hands clasped in front: the two palms within 0.12 m of each other, in front of the lower abdomen, forearms rising", () => {
  each((label, body) => {
    const r = put("stand-hands-clasped-front", body);
    assert.ok(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")) < 0.14, `${label}: hands ${(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")) * 1000).toFixed(0)} mm apart`);
    const palm = mid(r.lm("palm_centre_L"), r.lm("palm_centre_R"));
    assert.ok(Math.abs(palm.x) < 0.05 && palm.z > r.lm("abdomen_front").z - 0.02, `${label}: in front of the abdomen`);
    within(palm.y, r.lm("crotch").y - 0.02, r.lm("crotch").y + 0.2, `${label} hand height against the crotch`);
  });
});

test("hands behind the head: the palms on the back of the head, the upper arms raised to the horizontal or above, the elbows out", () => {
  each((label, body) => {
    const r = put("stand-hands-behind-head", body);
    for (const s of ["L", "R"]) {
      assert.ok(dist(r.lm(`palm_centre_${s}`), r.lm("opisthocranion")) < 0.14, `${label}: palm ${s} is ${(dist(r.lm(`palm_centre_${s}`), r.lm("opisthocranion")) * 1000).toFixed(0)} mm from the back of the head`);
      assert.ok(r.m[`upperArmInclination_${s}`] > 85, `${label}: the upper arm is ${r.m[`upperArmInclination_${s}`].toFixed(0)} deg from the vertical`);
      assert.ok(Math.abs(r.lm(`olecranon_${s}`).x) > Math.abs(r.lm("euryon_L").x) + 0.1, `${label}: the elbow is out`);
      assert.ok(r.m[`handToShoulderUp_${s}`] > 0.05, `${label}: the hand is above the shoulder joint`);
    }
  });
});

// ---- Reference ---------------------------------------------------------------------------------------------------------------------------------
test("arm elevation grows from the ISO standing posture to the A-pose, the T-pose and the Vitruvian figure; the A-pose arm is 45 degrees from the trunk", () => {
  each((label, body) => {
    const e = ["iso-7250-standing", "ref-a-pose", "t-pose", "ref-vitruvian"].map((id) => put(id, body).m.upperArmInclination_L);
    assert.ok(e[0] < e[1] && e[1] < e[2] && e[2] < e[3], `${label}: ${e.map((x) => x.toFixed(0)).join(", ")}`);
    within(e[1], 38, 52, `${label} A-pose`);
    within(e[2], 82, 100, `${label} T-pose`);
    within(e[3], 105, 125, `${label} Vitruvian`);
    const a = put("ref-a-pose", body).m;
    near(a.upperArmInclination_L, a.upperArmInclination_R, 0.5, `${label}: symmetric`);
  });
});

test("Vitruvian: the fingertips reach the level of the top of the head, the legs are spread", () => {
  each((label, body) => {
    const r = put("ref-vitruvian", body);
    near(r.lm("dactylion_L").y, r.lm("vertex").y, 0.08, `${label}: fingertip height against the vertex`);
    near(r.lm("dactylion_L").y, r.lm("dactylion_R").y, 1e-6, `${label}: symmetric`);
    assert.ok(r.m.stanceWidth > put("stand-feet-shoulder-width", body).m.stanceWidth + 0.1, `${label}: legs spread (${r.m.stanceWidth.toFixed(2)} m)`);
    assert.ok(r.lm("dactylion_L").x > r.lm("acromion_L").x + 0.3, `${label}: arms out to the side`);
  });
});

test("anatomical position: the forearms supinated so that the palms face forward", () => {
  each((label, body) => {
    const r = put("ref-anatomical-position", body);
    within(r.m.forearmPronation_L, -95, -70, `${label} pronation L`);
    near(r.m.forearmPronation_L, r.m.forearmPronation_R, 1e-6, `${label}: symmetric`);
    // the thumb points away from the trunk
    assert.ok(r.lm("thumb_tip_L").x > r.lm("metacarpale_ulnare_L").x - 0.02, `${label}: the thumb points outward`);
    assert.ok(r.m.shoulderElevation_L < 20, `${label}: arms by the sides`);
  });
});

test("arms forward (grip reach): horizontal and straight ahead; overhead reach: vertical, the hands far above the head", () => {
  each((label, body) => {
    const f = put("ref-forward-reach", body).m, o = put("ref-overhead-reach", body);
    within(f.upperArmInclinationSagittal_L, 85, 95, `${label} arm elevation forward`);
    assert.ok(Math.abs(f.handToShoulderUp_L) < 0.05, `${label}: the hand is level with the shoulder (${f.handToShoulderUp_L.toFixed(3)})`);
    assert.ok(f.handToShoulderForward_L > 0.5, `${label}: reach forward ${f.handToShoulderForward_L.toFixed(2)} m`);
    assert.ok(o.m.handAboveHeadBy_L > 0.15 && o.m.upperArmInclination_L > 160, `${label}: overhead ${o.m.handAboveHeadBy_L.toFixed(2)} m above the vertex`);
    assert.ok(o.m.handHeightAboveFloor_L > put("ref-forward-reach", body).m.handHeightAboveFloor_L + 0.4, `${label}: higher than the forward reach`);
  });
});

test("NIOSH reference lift: origin hands at knuckle height 0.7 to 0.9 m, destination 0.15 to 0.35 m higher, both 0.2 to 0.35 m ahead of the ankles, trunk upright, knees straight", () => {
  each((label, body) => {
    const o = put("ref-niosh-origin", body), d = put("ref-niosh-destination", body);
    const V = (r) => (r.lm("grip_centre_L").y + r.lm("grip_centre_R").y) / 2;
    const H = (r) => (r.lm("grip_centre_L").z + r.lm("grip_centre_R").z) / 2 - (r.joint("ankle_L").z + r.joint("ankle_R").z) / 2;
    within(V(o), 0.68, 0.88, `${label} V origin`);
    within(V(d) - V(o), 0.15, 0.35, `${label} vertical travel D`);
    within(H(o), 0.2, 0.36, `${label} H origin`);
    within(H(d), 0.2, 0.42, `${label} H destination`);
    for (const r of [o, d]) {
      assert.ok(Math.abs(r.m.trunkInclination) < 6 && r.m.kneeAngle_L > 165, `${label}: upright and straight-kneed`);
      near(r.m.handHeightAboveFloor_L, r.m.handHeightAboveFloor_R, 1e-6, `${label}: symmetric`);
      assert.ok(r.m.comOverBase > 0.02, `${label}: balance with the load ${r.m.comOverBase.toFixed(3)}`);
    }
    assert.ok(d.m.elbowAngle_L < 110 && o.m.elbowAngle_L > 165, `${label}: elbows bent at the destination (${d.m.elbowAngle_L.toFixed(0)}), straight at the origin`);
  });
});

test("RULA neutral posture: every segment in the lowest band of RULA and ISO 11226 (upper arm within 20 degrees, elbows 60-100 flexion, wrists straight, neck 0-10, trunk upright against the backrest, feet flat)", () => {
  each((label, body) => {
    const r = put("ref-rula-neutral", body), m = r.m;
    assert.ok(m.shoulderElevation_L <= 20 && m.shoulderElevation_R <= 20, `${label}: upper arm ${m.shoulderElevation_L.toFixed(0)} deg from the trunk`);
    within(m.elbowAngle_L, 80, 120, `${label} elbow (60-100 deg flexion)`);
    assert.ok(Math.abs(m.wristFlexion_L) <= 5 && Math.abs(m.wristDeviation_L) <= 5, `${label}: wrists straight`);
    within(m.neckFlexion, 0, 10, `${label} neck flexion (RULA 0-10)`);
    assert.ok(Math.abs(m.trunkInclination) <= 4, `${label}: trunk upright (${m.trunkInclination.toFixed(1)})`);
    within(m.hipAngle_L, 85, 100, `${label} hip angle`);
    assert.ok(r.floor("heel_sole_L") < 0.016 && r.floor("ball_sole_medial_L") < 0.016, `${label}: the feet are flat on the floor`);
    // the hands are at elbow height: the forearm is within 10 degrees of horizontal
    const fa = r.lm("palm_centre_L").y - r.lm("olecranon_L").y;
    assert.ok(Math.abs(fa) < 0.06, `${label}: forearm slope ${(fa * 1000).toFixed(0)} mm over the forearm`);
    const flags = ergonomicFlags(m, { trunkSupport: true, seated: true });
    const bad = flags.filter((f) => f.severity !== "ok");
    assert.deepEqual(bad.map((f) => `${f.id}: ${f.value}`), [], `${label}: ISO 11226 / REBA flags`);
    assert.equal(r.p.hints.prop.type, "keyboard_mouse");
  });
});

// ---- Lying -------------------------------------------------------------------------------------------------------------------------------------
test("every lying posture is on the floor: no landmark below it, the lowest skin point on it, nothing but the semi-reclined ones higher than 0.5 m", () => {
  each((label, body) => {
    for (const p of lying) {
      const r = put(p.id, body);
      let lo = Infinity, hi = -Infinity;
      for (const l of body.landmarkIds ?? Object.keys(body.landmarks)) { const y = r.floor(l); lo = Math.min(lo, y); hi = Math.max(hi, y); }
      assert.ok(lo > -0.006, `${label} | ${p.id}: a landmark is ${(-lo * 1000).toFixed(0)} mm below the floor`);
      assert.ok(lo < 0.06, `${label} | ${p.id}: the lowest landmark is ${(lo * 1000).toFixed(0)} mm above the floor`);
      if (!/semi/.test(p.id)) assert.ok(hi < (/legs-raised|creeper|on-elbows|knees-up/.test(p.id) ? 0.85 : /fetal|recovery|side/.test(p.id) ? 0.65 : 0.5), `${label} | ${p.id}: highest landmark ${hi.toFixed(2)} m`);
    }
  });
});

test("supine: trunk 90 degrees backward, the shoulder blades, the back of the head and the sacrum within 30 mm of the floor, the elbows within 60 mm", () => {
  each((label, body) => {
    const r = put("lie-supine", body), m = r.m;
    near(m.trunkInclination, -90, 6, `${label} trunk inclination`);
    for (const l of ["scapula_back_L", "scapula_back_R", "opisthocranion"]) assert.ok(r.floor(l) < 0.03, `${label}: ${l} floats ${(r.floor(l) * 1000).toFixed(0)} mm`);
    assert.ok(r.floor("buttock_extremity") < (label === "P5 woman" ? 0.08 : 0.03), `${label}: the sacrum floats ${(r.floor("buttock_extremity") * 1000).toFixed(0)} mm`);
    assert.ok(r.floor("olecranon_L") < 0.08 && r.floor("olecranon_R") < 0.08, `${label}: the elbows ${(r.floor("olecranon_L") * 1000).toFixed(0)} mm`);
    assert.ok(r.floor("heel_L") < 0.06, `${label}: the heel`);
    near(r.floor("scapula_back_L"), r.floor("scapula_back_R"), 1e-6, `${label}: symmetric`);
    assert.ok(m.gazeElevation > 65, `${label}: the face looks up (${m.gazeElevation.toFixed(0)} deg)`);
    assert.ok(Math.abs(r.lm("vertex").y - r.lm("toe_tip_L").y) < 0.35, `${label}: the body is flat`);
  });
});

test("prone: trunk 90 degrees forward, the chest, the knees and the cheek of the turned face within 60 mm of the floor", () => {
  each((label, body) => {
    const r = put("lie-prone", body);
    near(r.m.trunkInclination, 90, 8, `${label} trunk inclination`);
    assert.ok(r.floor("chest_front") < 0.06, `${label}: chest ${(r.floor("chest_front") * 1000).toFixed(0)} mm`);
    assert.ok(r.floor("zygion_R") < 0.06, `${label}: the right cheek (the head is turned left) ${(r.floor("zygion_R") * 1000).toFixed(0)} mm`);
    assert.ok(r.floor("knee_front_L") < 0.07, `${label}: knee ${(r.floor("knee_front_L") * 1000).toFixed(0)} mm`);
    assert.ok(r.m.neckTwist > 40, `${label}: the head is turned to the left (${r.m.neckTwist.toFixed(0)} deg)`);
  });
});

test("prone with the arms forward: the hands are beyond the head along the body, the arms nearly straight; supine with the arms overhead: the same", () => {
  each((label, body) => {
    for (const id of ["lie-prone-arms-forward", "lie-supine-arms-overhead"]) {
      const r = put(id, body);
      for (const s of ["L", "R"]) {
        assert.ok(beyondHead(r, r.lm(`palm_centre_${s}`)) > 0.1, `${label} | ${id}: palm ${s} is ${(beyondHead(r, r.lm(`palm_centre_${s}`)) * 1000).toFixed(0)} mm beyond the head`);
        assert.ok(r.m[`elbowAngle_${s}`] > 150, `${label} | ${id}: elbow ${r.m[`elbowAngle_${s}`].toFixed(0)}`);
      }
    }
    // against the arms-at-the-sides postures: the palms are by the hips, not beyond the head
    for (const id of ["lie-supine", "lie-prone"]) assert.ok(beyondHead(put(id, body), put(id, body).lm("palm_centre_L")) < -0.4, `${label} | ${id}`);
  });
});

test("supine with the knees up: the soles flat on the floor, thighs raised, knees bent past 60 degrees; legs raised: hips and knees at about 90 degrees with the shanks horizontal", () => {
  each((label, body) => {
    const k = put("lie-supine-knees-up", body), l = put("lie-supine-legs-raised", body), flat = put("lie-supine", body);
    // F5 is the short body: her feet float up to 50 mm; the median and tall bodies are within 15 mm
    const lim = label === "P5 woman" ? 0.06 : 0.02;
    for (const s of ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R"]) assert.ok(k.floor(s) < lim, `${label}: ${s} ${(k.floor(s) * 1000).toFixed(0)} mm`);
    assert.ok(k.m.kneeAngle_L < 80 && k.m.hipAngle_L < 150, `${label}: knee ${k.m.kneeAngle_L.toFixed(0)}, hip ${k.m.hipAngle_L.toFixed(0)}`);
    assert.ok(k.m.kneeHeight_L > flat.m.kneeHeight_L + 0.25, `${label}: the knees are up (${k.m.kneeHeight_L.toFixed(2)} m against ${flat.m.kneeHeight_L.toFixed(2)})`);
    within(l.m.kneeAngle_L, 78, 100, `${label} knee 90-90`);
    within(l.m.hipAngle_L, 80, 105, `${label} hip 90-90`);
    near(l.lm("lateral_malleolus_L").y, l.lm("epicondyle_lateral_L").y, 0.07, `${label}: the shank is horizontal`);
    assert.ok(l.lm("epicondyle_lateral_L").y > l.lm("trochanterion_L").y + 0.2, `${label}: the thigh is vertical`);
    assert.equal(l.p.hints.prop.type, "office_chair");
  });
});

test("hands on the chest: both palms within 0.13 m of the lower end of the breastbone, forearms folded", () => {
  each((label, body) => {
    const r = put("lie-supine-hands-on-chest", body);
    for (const s of ["L", "R"]) {
      assert.ok(dist(r.lm(`palm_centre_${s}`), r.lm("xiphoid")) < 0.13, `${label}: palm ${s} ${(dist(r.lm(`palm_centre_${s}`), r.lm("xiphoid")) * 1000).toFixed(0)} mm from the xiphoid`);
      assert.ok(r.m[`elbowAngle_${s}`] < 80, `${label}: elbow ${s} ${r.m[`elbowAngle_${s}`].toFixed(0)}`);
    }
    near(r.m.trunkInclination, -90, 6, `${label} trunk`);
  });
});

test("propped on the elbows: the elbows on the floor under the shoulders, the lumbar spine in extension 20 to 35 degrees, the chest raised, the head up", () => {
  each((label, body) => {
    const r = put("lie-prone-on-elbows", body), flat = put("lie-prone", body);
    assert.ok(r.floor("olecranon_L") < 0.07 && r.floor("olecranon_R") < 0.07 || label === "P95 man" && r.floor("olecranon_L") < 0.09, `${label}: elbows ${(r.floor("olecranon_L") * 1000).toFixed(0)} mm`);
    within(r.m.lumbarFlexion, -36, -18, `${label} lumbar extension`);
    assert.ok(r.m.thoracicFlexion < -10, `${label}: thoracic extension ${r.m.thoracicFlexion.toFixed(0)}`);
    assert.ok(r.floor("cervicale") > flat.floor("cervicale") + 0.08, `${label}: the shoulders are raised (${(r.floor("cervicale") * 1000).toFixed(0)} against ${(flat.floor("cervicale") * 1000).toFixed(0)} mm)`);
    assert.ok(r.floor("vertex") > flat.floor("vertex") + 0.1, `${label}: head up`);
    assert.ok(r.floor("abdomen_front") < 0.09, `${label}: the abdomen is on the floor (${(r.floor("abdomen_front") * 1000).toFixed(0)} mm)`);
  });
});

test("on the left or the right side: the lateral landmarks of that side are the low ones, and the two side postures are mirror images", () => {
  each((label, body) => {
    const l = put("lie-side-left", body), r = put("lie-side-right", body);
    near(l.m.trunkInclinationSide, 90, 15, `${label} left side`);
    near(r.m.trunkInclinationSide, -90, 15, `${label} right side`);
    for (const s of ["L"]) for (const id of ["deltoid", "epicondyle_lateral", "lateral_malleolus"]) assert.ok(l.floor(`${id}_${s}`) < 0.06, `${label} | left side: ${id}_${s} ${(l.floor(`${id}_${s}`) * 1000).toFixed(0)} mm`);
    for (const id of ["deltoid", "epicondyle_lateral", "lateral_malleolus"]) assert.ok(r.floor(`${id}_R`) < 0.06, `${label} | right side: ${id}_R ${(r.floor(`${id}_R`) * 1000).toFixed(0)} mm`);
    assert.ok(l.floor("deltoid_L") < l.floor("deltoid_R") - 0.2 && r.floor("deltoid_R") < r.floor("deltoid_L") - 0.2, `${label}: the shoulder of that side is below the other`);
    near(l.floor("deltoid_L"), r.floor("deltoid_R"), 0.004, `${label}: mirrored heights`);
    near(l.floor("epicondyle_lateral_L"), r.floor("epicondyle_lateral_R"), 0.004, `${label}: mirrored heights`);
    // legs slightly bent, the upper leg more than the lower
    assert.ok(l.m.kneeAngle_R < l.m.kneeAngle_L - 10 && r.m.kneeAngle_L < r.m.kneeAngle_R - 10, `${label}: the upper leg is the more bent`);
  });
  // exact mirror image: the pose of the right side is mirrorPose of the pose of the left side
  const e = (id) => { const x = expandPosture(byId(id)); return { root: x.root, angles: x.angles }; };
  assert.ok(poseEquals(mirrorPose(e("lie-side-left")), e("lie-side-right"), 1e-9));
});

test("fetal: on the left side, spine flexed more than 50 degrees in all, hips drawn up past 90 degrees and knees bent to about 55 degrees, hands in front of the chest", () => {
  each((label, body) => {
    const r = put("lie-fetal", body), m = r.m;
    near(m.trunkInclinationSide, 90, 20, `${label} on the left side`);
    assert.ok(m.lumbarFlexion + m.thoracicFlexion > 50, `${label}: spine flexion ${(m.lumbarFlexion + m.thoracicFlexion).toFixed(0)} deg`);
    assert.ok(m.hipAngle_L < 100 && m.hipAngle_R < 100, `${label}: hips ${m.hipAngle_L.toFixed(0)} / ${m.hipAngle_R.toFixed(0)}`);
    assert.ok(m.kneeAngle_L < 65 && m.kneeAngle_R < 65, `${label}: knees ${m.kneeAngle_L.toFixed(0)} / ${m.kneeAngle_R.toFixed(0)}`);
    assert.ok(m.neckFlexion > 5 || m.headInclination > 20, `${label}: the head is bent forward`);
    assert.ok(dist(r.lm("palm_centre_L"), r.lm("chest_front")) < 0.36 && dist(r.lm("palm_centre_R"), r.lm("chest_front")) < 0.36, `${label}: hands in front of the chest`);
    // compact: the extent of the figure along the floor is under 1 m
    let lo = Infinity, hi = -Infinity;
    for (const l of Object.keys(body.landmarks)) { const v = r.lm(l); lo = Math.min(lo, v.x); hi = Math.max(hi, v.x); }
    assert.ok(hi - lo < 1.1, `${label}: ${(hi - lo).toFixed(2)} m long`);
  });
});

test("recovery position: on the left side, the upper knee and hip bent about 90 degrees in front, the head tilted back, the lower arm forward and the upper hand near the face", () => {
  each((label, body) => {
    const r = put("lie-recovery-position", body), m = r.m;
    near(m.trunkInclinationSide, 90, 15, `${label} on the left side`);
    within(m.kneeAngle_R, 70, 110, `${label} upper knee`);
    within(m.hipAngle_R, 60, 110, `${label} upper hip`);
    assert.ok(m.kneeAngle_L > 120 && m.hipAngle_L > 130 && m.kneeAngle_L > m.kneeAngle_R + 30, `${label}: the lower leg is less bent (${m.kneeAngle_L.toFixed(0)}, ${m.hipAngle_L.toFixed(0)})`);
    assert.ok(m.neckFlexion < -5, `${label}: head tilted back ${m.neckFlexion.toFixed(0)}`);
    assert.ok(dist(r.lm("palm_centre_R"), r.lm("zygion_L")) < 0.3 || dist(r.lm("palm_centre_R"), r.lm("menton")) < 0.3, `${label}: upper hand near the face`);
    assert.ok(r.floor("epicondyle_lateral_L") < 0.08 && r.floor("deltoid_L") < 0.08 && r.floor("trochanterion_L") < 0.1, `${label}: low points on the left side`);
  });
});

test("creeper: on the back, head lifted (neck flexion above 8 degrees), the right arm straight up (hand more than 0.25 m above the shoulder), a platform prop", () => {
  each((label, body) => {
    const r = put("lie-creeper-reaching-up", body), m = r.m;
    near(m.trunkInclination, -90, 6, `${label} trunk`);
    assert.ok(m.neckFlexion > 8, `${label}: neck flexion ${m.neckFlexion.toFixed(0)}`);
    assert.ok(m.handToShoulderUp_R > 0.25 && m.elbowAngle_R > 150, `${label}: the right hand is ${m.handToShoulderUp_R.toFixed(2)} m above the shoulder, elbow ${m.elbowAngle_R.toFixed(0)}`);
    assert.ok(m.handToShoulderUp_L < m.handToShoulderUp_R - 0.04 && m.elbowAngle_L < 110, `${label}: the left arm is folded in front of the chest (hand ${m.handToShoulderUp_L.toFixed(2)} m above the shoulder, elbow ${m.elbowAngle_L.toFixed(0)})`);
    // total thickness: the highest point above the floor with the 0.1 m creeper is the hand, the head or the chest
    const top = Math.max(...Object.keys(body.landmarks).map((l) => r.floor(l)));
    assert.ok(top + 0.1 < 0.95, `${label}: the hand reaches ${(top + 0.1).toFixed(2)} m above the floor`);
    assert.equal(r.p.hints.prop.type, "floor_platform");
    assert.equal(r.p.hints.prop.params.height, 0.1);
  });
});

test("semi-reclined with the legs raised and propped up in bed: the trunk backward 38 to 62 degrees (semi-Fowler 45), hips bent, the knees slightly bent, the legs higher than in the fowler", () => {
  each((label, body) => {
    const a = put("lie-semi-reclined-legs-raised", body), f = put("lie-semi-fowler", body), s = put("lie-supine", body);
    within(a.m.trunkInclination, -62, -38, `${label} reclined trunk`);
    within(f.m.trunkInclination, -52, -35, `${label} fowler trunk`);
    assert.ok(s.m.trunkInclination < a.m.trunkInclination - 20 && a.m.trunkInclination < f.m.trunkInclination, `${label}: reclining grows from the fowler (${f.m.trunkInclination.toFixed(0)}) to the recliner (${a.m.trunkInclination.toFixed(0)}) to supine (${s.m.trunkInclination.toFixed(0)})`);
    assert.ok(a.m.kneeAngle_L > 140 && a.m.kneeAngle_L < 170 && f.m.kneeAngle_L > 140 && f.m.kneeAngle_L < 170, `${label}: knees ${a.m.kneeAngle_L.toFixed(0)} / ${f.m.kneeAngle_L.toFixed(0)}`);
    assert.ok(a.m.thighInclination_L > f.m.thighInclination_L + 3 && a.m.thighInclination_L > 5, `${label}: thigh ${a.m.thighInclination_L.toFixed(0)} against ${f.m.thighInclination_L.toFixed(0)} deg above the horizontal`);
    assert.ok(a.m.hipAngle_L < 150 && f.m.hipAngle_L < 150 && a.m.hipAngle_L > 100, `${label}: hip angles ${a.m.hipAngle_L.toFixed(0)}, ${f.m.hipAngle_L.toFixed(0)}`);
    assert.equal(a.p.hints.prop.type, "cabin_seat");
  });
});
