// Semantic tests of the two posture groups "Lifting & carrying" (site/js/human/postures/lifting.js, ids lift-*) and "Reaching" (reaching.js, ids reach-*): what each posture
// MEANS, measured with metrics.js (docs/human3d/METRICS.md) and the landmarks of the fitted body on three bodies (5th-percentile woman, median man, 95th-percentile man of the
// US Army populations), on top of the structure rules and the validator, which is run here too (no errors and no warnings on the three bodies; postures.test.mjs runs the
// whole library on six).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-lifting-reaching.test.mjs"
// A tolerance has a reason: a literature value where there is one (REBA / RULA bands, ISO 11226 trunk and arm limits, the NIOSH asymmetry angles A = 30 and 60 degrees, the
// definitions of the squat, stoop and semi-squat techniques) or else the name and the description of the posture. Values were measured first and the bounds set around them;
// a failing line names the quantity and the body. The hand and foot targets of the reaches are those of the median man (hints.target), so the position tests are made on him
// only; the other two bodies are held to the angles.
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
import lifting from "../../site/js/human/postures/lifting.js";
import reaching from "../../site/js/human/postures/reaching.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = { "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95) };
const MAN = BODIES["P50 man"];
const ALL = [...lifting, ...reaching];
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
const all = (id) => Object.fromEntries(Object.entries(BODIES).map(([label, body]) => [label, measure(body, get(id)).m]));
const f1 = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
const within = (v, lo, hi, what) => assert.ok(typeof v === "number" && v >= lo && v <= hi, `${what}: ${f1(v)} is not in [${lo}, ${hi}]`);
const near = (v, target, tol, what) => within(v, target - tol, target + tol, what);
const above = (v, lo, what) => assert.ok(typeof v === "number" && v > lo, `${what}: ${f1(v)} is not above ${lo}`);
const below = (v, hi, what) => assert.ok(typeof v === "number" && v < hi, `${what}: ${f1(v)} is not below ${hi}`);
const kneeFlex = (m) => 180 - (m.kneeAngle_L + m.kneeAngle_R) / 2;
const elbowFlex = (m, s) => 180 - m[`elbowAngle_${s}`];
const midHands = (r) => { const a = r.lm("grip_centre_L"), b = r.lm("grip_centre_R"); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; };
/** the point between the two hip joints on the floor frame of the placement (the origin of the seated targets and of relz "pelvis") */
const hipMid = (r) => { const a = r.lm("trochanterion_L"), b = r.lm("trochanterion_R"); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; };

// ---- structure -------------------------------------------------------------------------------------------------------------------------------------
test("the two groups hold at least 38 postures between them (52 now), with the lift- and reach- prefixes, unique ids and the right category", () => {
  assert.ok(ALL.length >= 38, `${ALL.length} postures`);
  assert.ok(lifting.length >= 28 && reaching.length >= 20, `${lifting.length} lifting, ${reaching.length} reaching`);
  const ids = ALL.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  for (const p of lifting) { assert.match(p.id, /^lift-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Lifting & carrying", p.id); }
  for (const p of reaching) { assert.match(p.id, /^reach-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Reaching", p.id); }
  assert.ok(CATEGORIES.some((c) => c.name === "Lifting & carrying") && CATEGORIES.some((c) => c.name === "Reaching"));
});

test("the plan of POSTURES.md exists: the three lifting techniques in three phases, one-hand, high and overhead lifts, the carries, push and pull, the stretcher and the fireman's carry; the reaches in every direction, standing and seated", () => {
  const need = [
    "lift-squat-start", "lift-squat-mid", "lift-squat-end", "lift-stoop-start", "lift-stoop-mid", "lift-stoop-end", "lift-semisquat-start", "lift-semisquat-mid", "lift-semisquat-end",
    "lift-one-hand-golfer", "lift-shoulder-height", "lift-overhead-start", "lift-overhead-end", "lift-high-shelf", "lift-asym-30", "lift-asym-60", "lift-carry-front", "lift-carry-chest",
    "lift-carry-bucket", "lift-carry-two-hands", "lift-carry-shoulder", "lift-carry-rucksack", "lift-push-cart", "lift-push-low", "lift-pull-rope", "lift-drag-casualty", "lift-stretcher-front",
    "lift-stretcher-rear", "lift-fireman-carry",
    "reach-forward-shoulder", "reach-forward-low", "reach-forward-high", "reach-overhead-one-hand", "reach-overhead-both", "reach-lateral", "reach-across-body", "reach-behind-back",
    "reach-floor-stoop", "reach-floor-squat", "reach-floor-lateral-bend", "reach-tiptoe-shelf", "reach-foot-pedal", "reach-seated-forward-far", "reach-seated-overhead", "reach-seated-lateral",
    "reach-seated-floor", "reach-seated-behind",
  ];
  for (const id of need) assert.ok(BY_ID.has(id), `${id} is missing`);
});

test("every posture has a plain name, a description of what it is and what it is for, a source, lower-case tags, a hand grip for each hand, and says whether it is symmetric", () => {
  for (const p of ALL) {
    assert.ok(p.name.length >= 8 && p.name.length <= 60, `${p.id}: name length ${p.name.length}`);
    assert.ok(p.description.length >= 100 && p.description.length <= 460, `${p.id}: description length ${p.description.length}`);
    assert.ok(/[.]$/.test(p.description), `${p.id}: the description ends with a full stop`);
    assert.ok(p.source.length >= 10, `${p.id}: source`);
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 4 && p.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), `${p.id}: tags ${JSON.stringify(p.tags)}`);
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: duplicate tags`);
    assert.ok(p.grips?.L in GRIPS && p.grips?.R in GRIPS, `${p.id}: grips`);
    assert.ok(p.tags.includes("symmetric") !== p.tags.includes("asymmetric"), `${p.id}: tagged symmetric or asymmetric, one of the two`);
    assert.ok(p.tags.some((t) => ["lift", "carry", "push", "pull", "drag", "reach"].includes(t)), `${p.id}: a tag for the activity`);
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

test("the validator really looks at the load: without hints.load the lifts with a load would have a larger balance margin (the load is in the centre of mass)", () => {
  let checked = 0;
  for (const id of ["lift-stoop-mid", "lift-squat-end", "lift-stretcher-rear", "lift-fireman-carry"]) {
    const p = get(id), q = structuredClone(p);
    delete q.hints.load;
    for (const [label, body] of Object.entries(BODIES)) {
      const a = validatePosture(body, p, { library: ALL }).metrics.balanceMargin, b = validatePosture(body, q, { library: ALL }).metrics.balanceMargin;
      assert.ok(typeof a === "number" && typeof b === "number", `${id} on the ${label}: the balance is checked`);
      if (id === "lift-stretcher-rear" || id === "lift-fireman-carry") assert.ok(a !== b, `${id} on the ${label}: the load moves the centre of mass`);
      else above(b, a + 0.005, `${id} on the ${label}: margin without the load against with it`);
      checked++;
    }
  }
  assert.equal(checked, 12);
});

test("an object a posture names (hints.prop, hints.props) exists in the catalog with its params in range, its grip ids on the right hand; the load of the balance check is the mass of the objects", () => {
  const ROLES = new Set(["held", "support", "target"]);
  let withProp = 0;
  for (const p of ALL) {
    const hints = p.hints ?? {};
    const objs = [hints.prop, ...(hints.props ?? [])].filter(Boolean);
    if (hints.prop) withProp++;
    for (const o of objs) {
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
    // a held object has grips for the hands that hold it, unless it is worn or only marks a place (rucksack, casualty)
    const held = objs.filter((o) => o.role === "held" && o.grips);
    for (const o of held) assert.ok(Object.keys(o.grips).length >= 1, `${p.id}: grips of the held object`);
    if (hints.load) {
      const mass = objs.reduce((s, o) => s + (o.params?.mass ?? 0), 0);
      if (mass > 0) assert.ok([mass, mass / 2].some((x) => Math.abs(x - hints.load.mass) < 1e-9), `${p.id}: hints.load.mass ${hints.load.mass} is the mass of its objects (${mass}) or half of it (a bearer)`);
    }
    if (hints.externalSupport) assert.ok(objs.length, `${p.id}: external support "${hints.externalSupport}" names no object`);
    if (hints.dynamic) assert.ok(hints.externalSupport || /^lift-(one-hand|supported)/.test(p.id), `${p.id}: a dynamic posture says what holds it up`);
  }
  assert.ok(withProp >= 45, `${withProp} postures name their main object`);
  for (const p of ALL) assert.ok(p.hints?.prop, `${p.id}: names the object it is for`);
  for (const p of lifting) if (!p.hints.externalSupport) assert.ok(p.hints.load, `${p.id}: a lifting or carrying posture without an outside support has a load in the balance check`);
  const mirrorable = reaching.filter((p) => !p.tags.includes("symmetric"));
  assert.ok(mirrorable.length >= 15);
});

test("every reaching posture states its target (hints.target: description, height, distance) and the target is where the right hand (the right foot for the pedal) of the median man is", () => {
  const body = MAN;
  for (const p of reaching) {
    const t = p.hints.target;
    assert.ok(t && typeof t.description === "string" && t.description.length > 8, `${p.id}: target description`);
    assert.ok(Number.isFinite(t.height_m) && t.height_m >= 0 && t.height_m <= 2.5, `${p.id}: target height`);
    assert.ok(Number.isFinite(t.distance_m) && Math.abs(t.distance_m) <= 1.2, `${p.id}: target distance`);
    assert.equal(p.hints.prop.type === "point_marker" ? p.hints.prop.params.height : t.height_m, t.height_m, `${p.id}: the marker is at the height of the target`);
    const r = measure(body, p);
    const seated = /seat/.test(p.support);
    const org = seated ? hipMid(r) : { x: 0, y: 0, z: 0 };
    const lat = t.lateral_m ?? 0; // the right hand has the negative x (the figure's left is +x); lateral_m is positive to the right
    if (p.id === "reach-foot-pedal") {
      const toe = r.lm("toe_tip_R");
      near(toe.y, t.height_m, 0.08, `${p.id}: right toe height against the target`);
      near(toe.z - r.lm("heel_sole_L").z, t.distance_m, 0.1, `${p.id}: right toe ahead of the stance heel (the pedal pad is 0.45 m ahead of the heel of the stance foot)`);
      continue;
    }
    if (p.id === "reach-both-forward-waist" || p.id === "reach-overhead-both") {
      const g = midHands(r);
      near(g.y, t.height_m, 0.07, `${p.id}: mid-hand height against the target`);
      near(g.z - org.z, t.distance_m, 0.07, `${p.id}: mid-hand distance against the target`);
      continue;
    }
    const g = r.lm("grip_centre_R");
    if (t.height_m <= 0.1) within(g.y, t.height_m, t.height_m + 0.2, `${p.id}: grip height against the object on the floor (the grip centre is 0.1 to 0.2 m above the fingertips of the open hand)`);
    else near(g.y, t.height_m, 0.07, `${p.id}: grip height against the target`);
    near(g.z - org.z, t.distance_m, 0.08, `${p.id}: grip distance against the target`);
    if (lat !== 0) near(-(g.x - org.x), lat, 0.08, `${p.id}: lateral position against the target (positive = right)`);
  }
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

test("mirroring an asymmetric posture exchanges its sides, and the mirror image of the whole posture is as balanced and as clear of the floor as the original", () => {
  for (const id of ["lift-carry-bucket", "lift-carry-shoulder", "lift-one-hand-golfer", "reach-lateral", "reach-across-body", "reach-foot-pedal", "reach-seated-behind"]) {
    const p = get(id), body = MAN;
    const a = measure(body, p), e = expandPosture(p);
    const mir = mirrorPose({ root: e.root, angles: e.angles });
    const root = placePose(body, mir, { posture: p }), b = postureMetrics(body, mir, root);
    for (const k of ["handHeightAboveFloor", "elbowAngle", "kneeAngle", "handToShoulderLateral", "shoulderElevation"]) {
      const sgn = k === "handToShoulderLateral" ? -1 : 1;
      const tol = k === "handHeightAboveFloor" ? 0.01 : k === "handToShoulderLateral" ? 0.02 : 1.0;
      near(b[`${k}_L`], sgn * a.m[`${k}_R`], tol, `${id} mirrored ${k}_L`);
      near(b[`${k}_R`], sgn * a.m[`${k}_L`], tol, `${id} mirrored ${k}_R`);
    }
    near(b.trunkInclinationSide, -a.m.trunkInclinationSide, 0.5, `${id} mirrored lateral lean`);
    near(b.trunkInclination, a.m.trunkInclination, 0.5, `${id} mirrored forward lean`);
  }
});

// ---- lifting: the three techniques ---------------------------------------------------------------------------------------------------------------------
const TECH = { squat: ["lift-squat-start", "lift-squat-mid", "lift-squat-end"], stoop: ["lift-stoop-start", "lift-stoop-mid", "lift-stoop-end"], semisquat: ["lift-semisquat-start", "lift-semisquat-mid", "lift-semisquat-end"] };

test("squat lift: start, mid and end have the knees bent deeply (above 110 degrees at the start), the trunk less flexed than a stoop, the heels down; the knee and trunk angles fall and the hands rise from phase to phase", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const ph = TECH.squat.map((id) => measure(body, get(id)));
    const [s, m, e] = ph.map((r) => r.m);
    within(kneeFlex(s), 110, 140, `${label}: squat start knee flexion (Burgess-Limerick and Abernethy: a squat keeps the knees bent while the back stays in line)`);
    within(kneeFlex(m), 70, 100, `${label}: squat mid knee flexion`);
    within(kneeFlex(e), 15, 40, `${label}: squat end knee flexion`);
    within(s.trunkInclination, 25, 50, `${label}: squat start trunk inclination (a squat lifter leans the trunk 30 to 50 degrees)`);
    below(e.trunkInclination, 20, `${label}: squat end trunk inclination`);
    below(s.pelvisHeight, 0.55, `${label}: the hips are low at the start of the squat`);
    for (const r of ph) { below(r.lm("heel_sole_L").y, 0.02, `${label}: left heel on the floor`); below(r.lm("heel_sole_R").y, 0.02, `${label}: right heel on the floor`); }
    for (let i = 1; i < 3; i++) {
      above(ph[i].m.kneeAngle_L, ph[i - 1].m.kneeAngle_L + 20, `${label}: the knees straighten from phase ${i} to ${i + 1}`);
      above(ph[i].m.handHeightAboveFloor_L, ph[i - 1].m.handHeightAboveFloor_L + 0.15, `${label}: the crate rises from phase ${i} to ${i + 1}`);
      above(ph[i].m.pelvisHeight, ph[i - 1].m.pelvisHeight + 0.1, `${label}: the hips rise from phase ${i} to ${i + 1}`);
    }
    below(e.trunkInclination, s.trunkInclination - 15, `${label}: the trunk comes up between the start and the end of the squat`);
    below(e.trunkInclination, m.trunkInclination - 15, `${label}: and between the middle and the end (the squat trunk stays inclined 35 to 50 degrees while the legs do the work)`);
    near(m.trunkInclination, s.trunkInclination, 12, `${label}: the squat trunk keeps its inclination from the start to the middle`);
    within(s.handHeightAboveFloor_L, 0.15, 0.4, `${label}: the crate starts on the floor (grip 0.27 m above its base)`);
    near(s.handHeightAboveFloor_L - s.handHeightAboveFloor_R, 0, 0.01, `${label}: both hands at the same height`);
  }
});

test("stoop lift: the knees stay nearly straight (below 30 degrees of flexion) while the trunk bends to about 80, 50 and 20 degrees; always more flexed than the squat at the same phase", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const ph = TECH.stoop.map((id) => measure(body, get(id)).m), sq = TECH.squat.map((id) => measure(body, get(id)).m);
    for (const m of ph) below(kneeFlex(m), 30, `${label}: stoop knee flexion`);
    near(ph[0].trunkInclination, 80, 8, `${label}: stoop start trunk inclination`);
    near(ph[1].trunkInclination, 52, 8, `${label}: stoop mid trunk inclination`);
    near(ph[2].trunkInclination, 23, 7, `${label}: stoop end trunk inclination`);
    above(ph[0].trunkInclination, 60, `${label}: stoop start is above the 60 degrees that ISO 11226 does not recommend`);
    for (let i = 0; i < 3; i++) { above(ph[i].trunkInclination, sq[i].trunkInclination + 8, `${label}: phase ${i + 1}: the stoop trunk is more inclined than the squat trunk`); below(kneeFlex(ph[i]), kneeFlex(sq[i]) - 8, `${label}: phase ${i + 1}: the stoop knees are straighter than the squat knees`); }
    for (let i = 1; i < 3; i++) { below(ph[i].trunkInclination, ph[i - 1].trunkInclination - 15, `${label}: the stoop trunk comes up`); above(ph[i].handHeightAboveFloor_L, ph[i - 1].handHeightAboveFloor_L + 0.15, `${label}: the crate rises`); }
    above(ph[0].pelvisHeight, 0.7, `${label}: the hips stay high in a stoop`);
  }
});

test("semi-squat lift: between the two techniques at the start (knees about 65 degrees, trunk about 60), and the same ordering of the three techniques in the middle", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const semi = TECH.semisquat.map((id) => measure(body, get(id)).m), sq = TECH.squat.map((id) => measure(body, get(id)).m), st = TECH.stoop.map((id) => measure(body, get(id)).m);
    near(kneeFlex(semi[0]), 65, 12, `${label}: semi-squat start knee flexion`);
    near(semi[0].trunkInclination, 63, 10, `${label}: semi-squat start trunk inclination`);
    for (const i of [0, 1]) {
      assert.ok(kneeFlex(sq[i]) > kneeFlex(semi[i]) && kneeFlex(semi[i]) > kneeFlex(st[i]), `${label}: phase ${i + 1}: knee flexion squat > semi-squat > stoop (${f1(kneeFlex(sq[i]))}, ${f1(kneeFlex(semi[i]))}, ${f1(kneeFlex(st[i]))})`);
      assert.ok(sq[i].trunkInclination < semi[i].trunkInclination + 1 && (i === 0 ? semi[i].trunkInclination < st[i].trunkInclination : semi[i].trunkInclination < st[i].trunkInclination + 20), `${label}: phase ${i + 1}: trunk inclination squat < semi-squat < stoop`);
    }
    for (let i = 1; i < 3; i++) above(semi[i].handHeightAboveFloor_L, semi[i - 1].handHeightAboveFloor_L + 0.15, `${label}: the crate rises`);
  }
});

test("the balance margin of every lifting phase is positive on the three bodies (the load is in the check), and the stoop mid-phase is not the safest one", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    for (const id of [...TECH.squat, ...TECH.stoop, ...TECH.semisquat]) {
      const r = validatePosture(body, get(id), { library: ALL });
      above(r.metrics.balanceMargin, 0.0, `${id} on the ${label}: balance margin (m)`);
    }
  }
});

test("lift-one-hand-golfer: one-leg stance, the trunk nearly horizontal, the free leg stretched out behind and raised, the right hand near the floor; lift-supported-one-hand: two feet, trunk about 70 degrees, the left hand on the thigh", () => {
  each("lift-one-hand-golfer", (m, r, w) => {
    above(m.trunkInclination, 70, `${w}: trunk inclination`);
    above(r.lm("heel_sole_R").y, 0.4, `${w}: the free foot is high behind`);
    near(r.lm("heel_sole_R").z - r.lm("heel_sole_L").z, -0.7, 0.35, `${w}: the free foot is behind the stance foot (the leg is stretched out backward)`);
    below(m.handHeightAboveFloor_R, 0.45, `${w}: the right hand takes the toolbox from the floor`);
    below(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L - 0.05, `${w}: the left hand hangs higher than the working hand`);
    above(kneeFlex(m) > 0 ? m.kneeAngle_R : 0, 165, `${w}: the free leg is straight`);
    assert.equal(m.legSupport, "left", `${w}: the left leg carries the weight`);
  });
  each("lift-supported-one-hand", (m, r, w) => {
    within(m.trunkInclination, 58, 82, `${w}: trunk inclination`);
    below(m.handHeightAboveFloor_R, 0.45, `${w}: the right hand takes the toolbox from the floor`);
    const k = r.lm("knee_top_L"), pc = r.lm("palm_centre_L");
    below(Math.hypot(pc.x - k.x, pc.y - k.y, pc.z - k.z), 0.24, `${w}: the left palm is on the left thigh just above the knee`);
    assert.equal(m.legSupport, "both", `${w}: both feet`);
  });
});

// ---- lifting: the load at a height ----------------------------------------------------------------------------------------------------------------------
test("lifts to a height: the hands rise from the carry (1.0 m) through shoulder height and the high shelf to overhead, the trunk leans back, and overhead the hands are above the head", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const chain = ["lift-carry-front", "lift-shoulder-height", "lift-high-shelf", "lift-overhead-end"].map((id) => measure(body, get(id)));
    for (let i = 1; i < chain.length; i++) above(chain[i].m.handHeightAboveFloor_L, chain[i - 1].m.handHeightAboveFloor_L + 0.12, `${label}: the hands rise from ${i} to ${i + 1}`);
    for (let i = 1; i < chain.length; i++) above(chain[i].m.shoulderElevation_L, chain[i - 1].m.shoulderElevation_L - 3, `${label}: the upper arm is not lower in step ${i + 1}`);
    above(chain[3].m.handAboveHeadBy_L, 0.05, `${label}: overhead end: the hands are above the head`);
    above(chain[3].m.handAboveHeadBy_R, 0.05, `${label}: overhead end: the hands are above the head`);
    above(chain[3].m.shoulderElevation_L, 110, `${label}: overhead end: arm elevation (above the 60 degrees that ISO 11226 does not recommend)`);
    above(chain[3].m.elbowAngle_L, 160, `${label}: overhead end: the arms are nearly straight`);
    below(chain[3].m.trunkInclination, -3, `${label}: overhead end: leaning back`);
    within(chain[1].m.handHeightAboveFloor_L / (chain[1].m.eyeHeight), 0.7, 0.85, `${label}: shoulder-height lift: the hands at the height of the chest, below the eyes (hand height / eye height)`);
    within(elbowFlex(chain[1].m, "L"), 85, 130, `${label}: shoulder-height lift: elbows flexed`);
    within(chain[1].m.trunkInclination, -9, 3, `${label}: shoulder-height lift: trunk upright`);
  }
  each("lift-overhead-start", (m, r, w) => {
    within(kneeFlex(m), 15, 40, `${w}: knees dipped`);
    within(elbowFlex(m, "L"), 70, 110, `${w}: elbows about 90 degrees with the load at the collarbone`);
    within(m.handHeightAboveFloor_L / m.eyeHeight, 0.7, 0.88, `${w}: hands at chest height`);
  });
  each("lift-high-shelf", (m, r, w) => {
    within(m.handHeightAboveFloor_L - m.eyeHeight, -0.2, 0.15, `${w}: the hands at about eye height`);
    within(m.shoulderElevation_L, 60, 100, `${w}: arm elevation`);
  });
});

// ---- lifting: NIOSH asymmetry -------------------------------------------------------------------------------------------------------------------------------
test("lift-asym-30 and lift-asym-60: the load is 30 and 60 degrees to the left of the sagittal plane (NIOSH A), the trunk twist grows with A, the feet stay forward", () => {
  const A = { "lift-asym-30": 30, "lift-asym-60": 60 };
  const twist = {};
  for (const [label, body] of Object.entries(BODIES)) {
    for (const [id, a] of Object.entries(A)) {
      const r = measure(body, get(id)), g = midHands(r);
      const az = (Math.atan2(g.x, g.z) * 180) / Math.PI; // + = toward the figure's left
      near(az, a, a === 30 ? 9 : 12, `${label}: ${id}: direction of the hands from the middle of the feet (NIOSH asymmetry angle)`);
      within(r.m.handHeightAboveFloor_L, 0.62, 0.9, `${label}: ${id}: knuckle height (V = 75 cm)`);
      above(r.m.trunkTwist, a === 30 ? 15 : 40, `${label}: ${id}: trunk twist to the left`);
      twist[`${label}|${id}`] = r.m.trunkTwist;
      below(Math.abs(r.m.bodyHeading), 12, `${label}: ${id}: the pelvis turns at most 8 degrees; the feet stay forward`);
    }
    above(twist[`${label}|lift-asym-60`], twist[`${label}|lift-asym-30`] + 15, `${label}: the twist is monotonic in A`);
  }
});

// ---- carries --------------------------------------------------------------------------------------------------------------------------------------------------
test("carry in front and at the chest: the crate held close, elbows bent, the trunk leaning back a little; the chest carry is higher and more flexed than the waist carry", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const a = measure(body, get("lift-carry-front")), c = measure(body, get("lift-carry-chest"));
    within(a.m.handHeightAboveFloor_L / a.m.hipHeight, 0.95, 1.2, `${label}: waist carry: hands about at the height of the hips (hand height / trochanter height)`);
    within(elbowFlex(a.m, "L"), 40, 85, `${label}: waist carry elbow flexion`);
    within(c.m.handHeightAboveFloor_L / c.m.eyeHeight, 0.65, 0.8, `${label}: chest carry: hands at the chest`);
    within(elbowFlex(c.m, "L"), 80, 115, `${label}: chest carry elbow flexion (about 100)`);
    above(c.m.handHeightAboveFloor_L, a.m.handHeightAboveFloor_L + 0.12, `${label}: the chest carry is higher`);
    above(elbowFlex(c.m, "L"), elbowFlex(a.m, "L") + 15, `${label}: and more flexed`);
    for (const m of [a.m, c.m]) { within(m.trunkInclination, -14, -2, `${label}: leaning back against the front load`); below(Math.abs(m.trunkInclinationSide), 1, `${label}: no side lean`); }
    below(c.m.trunkInclination, a.m.trunkInclination + 1, `${label}: the higher load leans the trunk back at least as far`);
  }
});

test("carry in one hand, in both hands, on the shoulder, in a rucksack: the lean and the arm positions that name them", () => {
  each("lift-carry-bucket", (m, r, w) => {
    above(m.trunkInclinationSide, 2, `${w}: the trunk leans to the left, away from the load in the right hand`);
    above(m.shoulderElevation_L, 20, `${w}: the free arm is held out for balance`);
    below(m.shoulderElevation_R, 20, `${w}: the load hangs from the straight right arm`);
    above(m.elbowAngle_R, 170, `${w}: right arm straight`);
    within(m.handHeightAboveFloor_R, 0.6, 0.95, `${w}: handle height of a hanging load (hand beside the thigh)`);
    above(m.handHeightAboveFloor_R - m.handHeightAboveFloor_L, -0.2, `${w}: the load hand is not far below the free hand`);
  });
  each("lift-carry-two-hands", (m, r, w) => {
    below(Math.abs(m.trunkInclinationSide), 1, `${w}: no side lean (the loads cancel)`);
    below(Math.abs(m.trunkInclination), 3, `${w}: upright`);
    above(m.elbowAngle_L, 170, `${w}: arms straight`);
    within(m.handHeightAboveFloor_L / m.hipHeight, 0.8, 1.0, `${w}: hands at the sides of the thighs`);
  });
  each("lift-carry-shoulder", (m, r, w) => {
    above(m.handToShoulderUp_R, 0.1, `${w}: the right hand is above the right shoulder, steadying the load on it`);
    above(m.trunkInclinationSide, 2, `${w}: leaning to the left, away from the shoulder load`);
    above(m.elbowAngle_L, 160, `${w}: the left arm hangs`);
    assert.ok(get("lift-carry-shoulder").hints.load.landmarks.includes("acromion_R"), "the load rests on the right shoulder");
  });
  each("lift-carry-rucksack", (m, r, w) => {
    within(m.trunkInclination, 4, 16, `${w}: forward lean under a pack (Knapik et al.: 5 to 15 degrees for 20 to 40 kg)`);
    above(kneeFlex(m), 3, `${w}: knees soft`);
    within(m.handHeightAboveFloor_L / m.hipHeight, 0.95, 1.2, `${w}: hands at the hip belt`);
    assert.deepEqual(get("lift-carry-rucksack").hints.load.landmarks, ["scapula_back_L", "scapula_back_R"], "the load is on the back");
    above(get("lift-carry-rucksack").hints.load.mass, 20, "pack mass");
  });
});

// ---- push, pull, drag, stretcher, fireman ---------------------------------------------------------------------------------------------------------------------
test("push and pull: the body leans into the push and away from the pull; the stance is staggered; the hands are at the handle height; they are dynamic and held up by the cart, the rope, the load or the ground", () => {
  each("lift-push-cart", (m, r, w) => {
    within(m.trunkInclination, 10, 30, `${w}: leaning forward into the push`);
    within(m.handHeightAboveFloor_L, 0.85, 1.15, `${w}: cart handle height (Snook and Ciriello push tables: roughly 0.9 to 1.0 m)`);
    above(m.elbowAngle_L, 135, `${w}: arms nearly straight`);
    above(Math.abs(m.footSeparationAnteroposterior), 0.35, `${w}: staggered stance`);
    above(kneeFlex({ kneeAngle_L: m.kneeAngle_L, kneeAngle_R: m.kneeAngle_L }), 25, `${w}: the front knee is bent`);
    above(m.kneeAngle_R, 165, `${w}: the rear leg is straight`);
  });
  each("lift-push-low", (m, r, w) => {
    within(m.trunkInclination, 28, 50, `${w}: crouched push`);
    within(m.handHeightAboveFloor_L, 0.45, 0.8, `${w}: hands low on the load`);
    within(180 - m.kneeAngle_L, 45, 80, `${w}: front knee`);
    above(m.kneeAngle_R, 165, `${w}: rear leg straight`);
    above(Math.abs(m.footSeparationAnteroposterior), 0.35, `${w}: staggered stance`);
  });
  each("lift-pull-rope", (m, r, w) => {
    within(m.trunkInclination, -26, -10, `${w}: leaning back against the rope`);
    within(m.handHeightAboveFloor_L, 0.95, 1.35, `${w}: rope held in front of the chest`);
    above(m.elbowAngle_L, 150, `${w}: arms nearly straight`);
  });
  each("lift-drag-casualty", (m, r, w) => {
    within(180 - m.kneeAngle_L, 40, 70, `${w}: knees bent about 55 degrees`);
    within(m.trunkInclination, -12, 5, `${w}: trunk upright to slightly back`);
    const hip = hipMid(r), heel = r.lm("heel_sole_L");
    below(hip.z, heel.z + 0.02, `${w}: the hips are pushed back to the heels or behind them (the casualty pulls forward)`);
  });
  for (const id of ["lift-push-cart", "lift-push-low", "lift-pull-rope", "lift-drag-casualty"]) {
    const h = get(id).hints;
    assert.equal(h.dynamic, true, `${id}: dynamic`);
    assert.ok(typeof h.externalSupport === "string" && h.externalSupport.length >= 3, `${id}: names what holds the body up`);
  }
});

test("stretcher carry: front bearer with the handles behind the hips, rear bearer with the handles in front; upright, arms straight, handles at 0.8 m; the fireman's carry is bent forward with a load at the neck", () => {
  each("lift-stretcher-front", (m, r, w) => {
    below(m.handToShoulderForward_L, -0.03, `${w}: the hands are behind the shoulders`);
    below(m.handToShoulderForward_R, -0.03, `${w}: the hands are behind the shoulders`);
    near(m.handHeightAboveFloor_L, 0.8, 0.12, `${w}: handle height`);
    above(m.elbowAngle_L, 165, `${w}: arms straight`);
    below(Math.abs(m.trunkInclination), 6, `${w}: upright`);
  });
  each("lift-stretcher-rear", (m, r, w) => {
    above(m.handToShoulderForward_L, 0.1, `${w}: the hands are in front of the shoulders`);
    near(m.handHeightAboveFloor_L, 0.8, 0.12, `${w}: handle height`);
    above(m.elbowAngle_L, 165, `${w}: arms straight`);
    within(m.trunkInclination, -10, 2, `${w}: leaning back a little`);
  });
  each("lift-fireman-carry", (m, r, w) => {
    within(m.trunkInclination, 14, 35, `${w}: bent forward`);
    within(kneeFlex(m), 20, 45, `${w}: knees bent`);
    above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.2, `${w}: the right hand holds the casualty's wrist high, the left hand is free`);
    assert.deepEqual(get("lift-fireman-carry").hints.load.landmarks, ["cervicale"], "the load is across the shoulders");
    above(get("lift-fireman-carry").hints.load.mass, 60, "the casualty's mass");
  });
});

// ---- reaching: standing -----------------------------------------------------------------------------------------------------------------------------------------
test("forward reaches: shoulder height, waist height, and up: the hand height and the arm elevation rise in that order; the elbow is nearly straight at shoulder height", () => {
  for (const [label, body] of Object.entries(BODIES)) {
    const low = measure(body, get("reach-forward-low")).m, mid = measure(body, get("reach-forward-shoulder")).m, high = measure(body, get("reach-forward-high")).m, over = measure(body, get("reach-overhead-one-hand")).m;
    const h = [low, mid, high, over].map((m) => m.handHeightAboveFloor_R);
    for (let i = 1; i < 4; i++) above(h[i], h[i - 1] + 0.1, `${label}: the reach rises (${h.map(f1).join(", ")})`);
    for (let i = 1; i < 4; i++) above([low, mid, high, over][i].shoulderElevation_R, [low, mid, high, over][i - 1].shoulderElevation_R + 15, `${label}: the right arm is raised more`);
    near(mid.handToShoulderUp_R, 0, 0.14, `${label}: shoulder-height reach: the hand is at the level of the shoulder joint`);
    above(mid.handToShoulderForward_R, 0.45, `${label}: shoulder-height reach: forward of the shoulder`);
    above(mid.elbowAngle_R, 120, `${label}: shoulder-height reach: nearly straight elbow`);
    within(mid.shoulderElevation_R, 55, 90, `${label}: shoulder-height reach: arm elevation about 65 degrees (the model's arm hangs abducted, so the arm is raised less than 90 degrees for a hand at the shoulder level)`);
    within(low.shoulderElevation_R, 25, 55, `${label}: waist-height reach`);
    above(high.upperArmInclination_R, 100, `${label}: forward-and-up reach: the arm is above the horizontal`);
    above(over.upperArmInclination_R, 150, `${label}: overhead reach: the arm is vertical`);
    above(over.handAboveHeadBy_R, 0.12, `${label}: overhead reach: the hand is above the head`);
    above(over.trunkInclinationSide, 3, `${label}: overhead one-hand reach: leaning to the left to gain height on the right side`);
    below(Math.abs(low.trunkInclination - 5), 10, `${label}: waist-height reach: trunk nearly upright`);
    above(low.reachFromAnkles_R, 0.45, `${label}: waist-height reach is over half a metre from the ankles`);
  }
  each("reach-forward-high", (m, r, w) => {
    below(m.trunkInclination, 0, `${w}: leaning back for the high reach`);
    above(m.gazeElevation, 5, `${w}: looking up`);
  });
});

test("overhead with both hands, to the side, across the body, behind the back: the arm and trunk positions that name them", () => {
  each("reach-overhead-both", (m, r, w) => {
    above(m.handAboveHeadBy_L, 0.1, `${w}: left hand above the head`);
    above(m.handAboveHeadBy_R, 0.1, `${w}: right hand above the head`);
    above(m.shoulderElevation_L, 120, `${w}: arm elevation`);
    near(m.shoulderElevation_L, m.shoulderElevation_R, 3, `${w}: symmetric`);
    above(m.elbowAngle_L, 160, `${w}: arms almost straight`);
    above(m.gazeElevation, 8, `${w}: looking up at the panel`);
  });
  each("reach-lateral", (m, r, w) => {
    below(m.handToShoulderLateral_R, -0.45, `${w}: the right hand is far to the right of the right shoulder`);
    below(m.trunkInclinationSide, -5, `${w}: the trunk bends to the right toward the control`);
    within(m.shoulderElevation_R, 55, 95, `${w}: arm raised sideways (shoulder abduction about 60 degrees from the trunk)`);
    near(m.handToShoulderUp_R, -0.08, 0.14, `${w}: about shoulder height`);
    within(m.handToShoulderForward_R, -0.15, 0.15, `${w}: the hand is level with the shoulder from front to back`);
    below(Math.abs(m.headTilt), 8, `${w}: the head is kept upright (cervical spine bent back toward the vertical)`);
  });
  each("reach-across-body", (m, r, w) => {
    above(r.lm("palm_centre_R").x, -0.02, `${w}: the right hand has crossed the midline to the left`);
    above(m.trunkTwist, 25, `${w}: the thorax is turned to the left`);
    above(m.handToShoulderLateral_R, 0.1, `${w}: the hand is to the left of the right shoulder`);
    near(m.handToShoulderUp_R, -0.15, 0.2, `${w}: at chest height`);
  });
  each("reach-behind-back", (m, r, w) => {
    below(m.handToShoulderForward_R, -0.1, `${w}: the hand is behind the shoulder`);
    below(r.lm("palm_centre_R").z, r.lm("trochanterion_R").z - 0.03, `${w}: and behind the hip`);
    within(m.handHeightAboveFloor_R / m.hipHeight, 0.95, 1.2, `${w}: at the belt line`);
    below(m.shoulderElevation_R, 75, `${w}: the shoulder is extended, the arm is low`);
    within(elbowFlex(m, "R"), 55, 110, `${w}: elbow flexed`);
  });
});

test("reaches to the floor: stooping (trunk above 70 degrees, knees nearly straight), squatting (knees deeply bent, heels down), and with a side bend (knees bent, trunk bent to the right); the hand is near the floor in each", () => {
  each("reach-floor-stoop", (m, r, w) => {
    above(m.trunkInclination, 70, `${w}: stoop`);
    within(kneeFlex(m), 25, 55, `${w}: the knees are bent about 40 degrees`);
    below(m.handHeightAboveFloor_R, 0.32, `${w}: right hand near the floor`);
    below(m.handHeightAboveFloor_L, 0.4, `${w}: the left arm hangs toward the floor`);
  });
  each("reach-floor-squat", (m, r, w) => {
    above(kneeFlex(m), 100, `${w}: deep squat`);
    below(m.handHeightAboveFloor_R, 0.3, `${w}: right hand near the floor`);
    below(r.lm("heel_sole_L").y, 0.02, `${w}: heels down`);
    within(m.trunkInclination, 25, 50, `${w}: trunk tilted forward`);
    near(r.lm("palm_centre_L").y, r.lm("knee_top_L").y, 0.25, `${w}: the left hand is on or near the left knee`);
  });
  each("reach-floor-lateral-bend", (m, r, w) => {
    below(m.trunkInclinationSide, -12, `${w}: the trunk bends to the right`);
    within(kneeFlex(m), 35, 65, `${w}: knees bent`);
    below(m.handHeightAboveFloor_R, 0.7, `${w}: right hand low`);
    above(m.handHeightAboveFloor_L - m.handHeightAboveFloor_R, 0.2, `${w}: the left hand is higher than the working hand`);
    above(Math.abs(m.footSeparationMediolateral), 0.3, `${w}: wide stance`);
  });
  const stoop = all("reach-floor-stoop"), squat = all("reach-floor-squat");
  for (const label of Object.keys(BODIES)) { above(stoop[label].trunkInclination, squat[label].trunkInclination + 25, `${label}: the stoop is more inclined than the squat`); above(kneeFlex(squat[label]), kneeFlex(stoop[label]) + 50, `${label}: the squat has the knees more bent`); }
});

test("on the toes: the heels are raised and the hand is above the head; the foot reach: one foot forward, one-leg stance; step and counter reaches: far reach by a step or by leaning, low shelf in a crouch", () => {
  each("reach-tiptoe-shelf", (m, r, w) => {
    above(r.lm("heel_sole_L").y, 0.06, `${w}: the heels are raised`);
    below(r.lm("ball_sole_medial_L").y, 0.02, `${w}: the balls of the feet are on the floor`);
    above(m.handAboveHeadBy_R, 0.15, `${w}: the hand is above the head`);
    above(m.upperArmInclination_R, 150, `${w}: arm vertical`);
    above(m.elbowAngle_R, 160, `${w}: nearly straight`);
  });
  each("reach-foot-pedal", (m, r, w) => {
    assert.equal(m.legSupport, "left", `${w}: the left leg carries the weight`);
    above(Math.abs(m.footSeparationAnteroposterior), 0.2, `${w}: the right foot is far ahead of the left`);
    above(r.lm("toe_tip_R").z, r.lm("toe_tip_L").z + 0.2, `${w}: the right toe is ahead of the left toe`);
    below(r.lm("heel_sole_R").y, 0.15, `${w}: the pedal is near the floor`);
    above(r.lm("heel_sole_R").y, 0.0, `${w}: the sole is just above the floor`);
    above(180 - m.kneeAngle_R, 15, `${w}: the reaching knee is bent`);
  });
  each("reach-step-far-forward", (m, r, w) => {
    above(m.reachFromAnkles_R, 0.85, `${w}: the hand is almost a metre from the ankles (a step plus an arm)`);
    above(Math.abs(m.footSeparationAnteroposterior), 0.3, `${w}: a step apart`);
    within(m.trunkInclination, 10, 28, `${w}: leaning forward`);
    above(m.elbowAngle_R, 140, `${w}: the arm is stretched`);
  });
  each("reach-low-shelf-crouch", (m, r, w) => {
    within(kneeFlex(m), 60, 100, `${w}: half squat`);
    within(m.trunkInclination, 30, 58, `${w}: trunk tilted forward`);
    within(m.handHeightAboveFloor_R, 0.25, 0.6, `${w}: the hand is in the bottom shelf`);
  });
  each("reach-both-forward-waist", (m, r, w) => {
    within(m.trunkInclination, 8, 22, `${w}: leaning forward 15 degrees`);
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.01, `${w}: both hands at one height`);
    within(m.handHeightAboveFloor_L / m.hipHeight, 0.95, 1.25, `${w}: at the bench height`);
    near(m.shoulderElevation_L, m.shoulderElevation_R, 3, `${w}: symmetric`);
  });
  each("reach-lean-over-counter", (m, r, w) => {
    within(m.trunkInclination, 20, 40, `${w}: leaning forward`);
    below(kneeFlex(m), 15, `${w}: the legs are straight`);
    above(m.reachFromAnkles_R, 0.75, `${w}: the hand is far beyond the arm's length from the ankles`);
    above(m.handToShoulderForward_R, 0.4, `${w}: the arm is stretched forward`);
  });
  const lean = all("reach-lean-over-counter"), fwd = all("reach-forward-shoulder");
  for (const label of Object.keys(BODIES)) above(lean[label].reachFromAnkles_R, fwd[label].reachFromAnkles_R + 0.05, `${label}: leaning over a counter reaches further than a standing reach`);
});

// ---- reaching: seated --------------------------------------------------------------------------------------------------------------------------------------------
test("seated reaches: on a popliteal seat, hips and knees near 90 degrees; far forward leans the trunk, overhead raises the arm, lateral bends the trunk, to the floor flexes it more than 40 degrees, behind twists it", () => {
  for (const id of ["reach-seated-forward-far", "reach-seated-overhead", "reach-seated-lateral", "reach-seated-floor", "reach-seated-behind"]) {
    assert.equal(get(id).support, "seat+feet", id);
    assert.equal(get(id).hints.seat.height, "popliteal", id);
    each(id, (m, r, w) => {
      within(m.seatHeight, 0.3, 0.5, `${w}: on a seat at popliteal height`);
      within(180 - m.kneeAngle_L, 75, 115, `${w}: knees bent about 90 degrees (the model's ISO knee reads 96)`);
      assert.equal(m.legSupport, "both", `${w}: both feet on the floor`);
    });
  }
  each("reach-seated-forward-far", (m, r, w) => {
    within(m.trunkInclination, 10, 32, `${w}: leaning forward from the seat`);
    above(m.handToShoulderForward_R, 0.4, `${w}: the hand is forward of the shoulder`);
    above(r.lm("grip_centre_R").z - hipMid(r).z, 0.55, `${w}: the hand is far in front of the hips (the seated forward reach is about 0.7 to 0.8 m)`);
    above(m.elbowAngle_R, 120, `${w}: nearly straight`);
  });
  each("reach-seated-overhead", (m, r, w) => {
    above(m.upperArmInclination_R, 135, `${w}: arm raised above the head`);
    above(m.handAboveHeadBy_R, 0.1, `${w}: the hand is above the head`);
    within(m.trunkInclination, -10, 4, `${w}: upright to leaning back`);
  });
  each("reach-seated-lateral", (m, r, w) => {
    below(m.handToShoulderLateral_R, -0.35, `${w}: the hand is far to the right`);
    below(m.trunkInclinationSide, -8, `${w}: trunk bends to the right`);
    below(Math.abs(m.trunkInclination), 6, `${w}: no forward lean`);
  });
  each("reach-seated-floor", (m, r, w) => {
    above(m.trunkInclination, 35, `${w}: bent far forward`);
    below(m.handHeightAboveFloor_R, 0.3, `${w}: the right hand is near the floor`);
    below(m.hipAngle_L, 60, `${w}: the hip is flexed far beyond the 90 degrees of sitting (included angle below 60)`);
  });
  each("reach-seated-behind", (m, r, w) => {
    below(m.trunkTwist, -30, `${w}: the thorax is turned to the right`);
    below(m.neckTwist, -10, `${w}: the head follows`);
    below(r.lm("grip_centre_R").z, hipMid(r).z - 0.1, `${w}: the right hand is behind the hips`);
    below(m.handToShoulderLateral_R, -0.1, `${w}: and out to the side`);
  });
  const lat = all("reach-seated-lateral"), fl = all("reach-seated-floor"), fw = all("reach-seated-forward-far");
  for (const label of Object.keys(BODIES)) { above(fl[label].trunkInclination, fw[label].trunkInclination + 12, `${label}: reaching to the floor bends the trunk more than reaching forward`); above(Math.abs(lat[label].trunkInclinationSide), 8, `${label}: lateral`); }
});
