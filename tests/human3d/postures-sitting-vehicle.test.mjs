// Semantic tests of the two posture groups "Sitting" (site/js/human/postures/sitting.js) and "Vehicle & cockpit" (vehicle.js): what each posture MEANS,
// measured with metrics.js on three bodies (5th-percentile woman, median man, 95th-percentile man of the US Army populations), on top of the structure
// rules and the validator (which postures.test.mjs also runs for the whole library on six bodies).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-sitting-vehicle.test.mjs"
// A tolerance has a reason: a literature range where there is one (ISO 7250-1 seated posture, ISO 11226, REBA / RULA bands, Porter and Gyi / Reed driver
// ranges (the knee and elbow ranges are approx., from memory of the papers, see vehicle.js), ISO 9241-5 elbow and wrist), else the posture's own name (a 115 degree seat leans the upper trunk back about 22 degrees, a high stool is 0.65 m
// high). Values were measured on the postures first and the bounds set around them with a margin; a failing line says which quantity and which body.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { validatePosture, expandPosture, placePose, landmarkPosition, seatHeightFor, mirrorPose, CATEGORIES } from "../../site/js/human/pose.js";
import { postureMetrics } from "../../site/js/human/metrics.js";
import { byType, normalizeParams } from "../../site/js/human/catalog.js";
import { GRIPS } from "../../site/js/human/postures/grips.js";
import sitting from "../../site/js/human/postures/sitting.js";
import vehicle from "../../site/js/human/postures/vehicle.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = { "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95) };
const ALL = [...sitting, ...vehicle];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));
const get = (id) => { const p = BY_ID.get(id); assert.ok(p, `no posture ${id}`); return p; };

// ---- measuring ---------------------------------------------------------------------------------------------------------------------------------------------
function measure(body, p, options) {
  const e = expandPosture(p), pose = { root: e.root, angles: e.angles }, root = placePose(body, pose, { posture: p });
  return { m: postureMetrics(body, pose, root, options), pose, root, lm: (id) => landmarkPosition(body, pose, root, id), body };
}
/** run fn(metrics, measurement, label) for the posture on every body */
function each(id, fn) {
  const p = get(id);
  for (const [label, body] of Object.entries(BODIES)) {
    const r = measure(body, p);
    fn(r.m, r, `${id} on the ${label}`);
  }
}
const f1 = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
const within = (v, lo, hi, what) => assert.ok(typeof v === "number" && v >= lo && v <= hi, `${what}: ${f1(v)} is not in [${lo}, ${hi}]`);
const near = (v, target, tol, what) => within(v, target - tol, target + tol, what);
const above = (v, lo, what) => assert.ok(typeof v === "number" && v > lo, `${what}: ${f1(v)} is not above ${lo}`);
const below = (v, hi, what) => assert.ok(typeof v === "number" && v < hi, `${what}: ${f1(v)} is not below ${hi}`);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** metrics of a posture on every body: { label: metrics } */
const all = (id) => Object.fromEntries(Object.entries(BODIES).map(([label, body]) => [label, measure(body, get(id)).m]));

// ---- structure -----------------------------------------------------------------------------------------------------------------------------------------------
test("the two groups hold at least 44 postures between them (68 now), with the sit- and veh- prefixes, unique ids and the right category", () => {
  assert.ok(ALL.length >= 44, `${ALL.length} postures`);
  assert.ok(sitting.length >= 34 && vehicle.length >= 34, `${sitting.length} sitting, ${vehicle.length} vehicle`);
  const ids = ALL.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  for (const p of sitting) { assert.match(p.id, /^sit-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Sitting", p.id); }
  for (const p of vehicle) { assert.match(p.id, /^veh-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Vehicle & cockpit", p.id); }
  assert.ok(CATEGORIES.some((c) => c.name === "Sitting") && CATEGORIES.some((c) => c.name === "Vehicle & cockpit"));
});

test("every posture has a plain name, a description of what it is and what it is for, a source, lower-case tags and a hand grip for each hand", () => {
  for (const p of ALL) {
    assert.ok(p.name.length >= 8 && p.name.length <= 60, `${p.id}: name length ${p.name.length}`);
    assert.ok(p.description.length >= 100 && p.description.length <= 420, `${p.id}: description length ${p.description.length}`);
    assert.ok(/[.]$/.test(p.description), `${p.id}: the description ends with a full stop`);
    assert.ok(p.source.length >= 10, `${p.id}: source`);
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 3 && p.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), `${p.id}: tags ${JSON.stringify(p.tags)}`);
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: duplicate tags`);
    assert.ok(p.grips?.L in GRIPS && p.grips?.R in GRIPS, `${p.id}: grips`);
    assert.ok(p.tags.includes("symmetric") !== p.tags.includes("asymmetric"), `${p.id}: tagged symmetric or asymmetric, one of the two`);
  }
  // the vehicle postures are findable by their words
  for (const p of vehicle) assert.ok(p.tags.includes("vehicle"), `${p.id}: tag "vehicle"`);
});

// History: after the shank lean of the neutral stance was capped at 4.9 degrees (fit.js leanMax, MODEL.md 7.1) six postures missed a floor contact by 1 to 8 mm on some of the six
// test bodies (sit-seiza, sit-legs-extended, veh-pedal-brake, veh-pedal-brake-hard, veh-pedal-clutch, veh-gear-shift). They were retuned (hip 50 for the seiza, knee 40 and hip 70 for
// the extended legs; the working foot of the pedal postures is no longer a floor contact, the resting heel is, and the extended leg takes its hip angle from the other one), and this
// test has no allowance for them any more: nothing is tolerated, no error and no warning, on three bodies (the six of postures.test.mjs are run by that file).
function problemsOnThreeBodies() {
  const out = [];
  for (const [label, body] of Object.entries(BODIES)) {
    for (const p of ALL) {
      const r = validatePosture(body, p, { library: ALL });
      for (const e of r.errors) out.push(`${label} | ${p.id} | ${e}`);
      for (const w of r.warnings) out.push(`${label} | ${p.id} | warning: ${w}`);
    }
  }
  return out;
}
test("every posture passes validatePosture on the three bodies, without errors and without warnings (no allowance for floor contacts)", () => {
  const all = problemsOnThreeBodies();
  assert.equal(all.length, 0, all.slice(0, 40).join("\n  "));
});

test("an object a posture names (hints.prop, hints.props) exists in the catalog with its params in range, its grip ids on the right hand and its foot anchors", () => {
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
      assert.ok(typeof o.note === "string" && o.note.length > 15, `${p.id}: ${o.type} note`);
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
      if (o.anchors) for (const id of Object.values(o.anchors)) assert.ok(Object.hasOwn(t.anchors(o.params ?? {}), id), `${p.id}: ${o.type} has no anchor ${id}`);
    }
  }
  assert.ok(withProp >= 60, `${withProp} postures name their main object`);
  for (const p of vehicle) assert.ok(p.hints?.prop, `${p.id}: a vehicle posture names the object it is for`);
  for (const p of ALL) if (p.hints?.externalSupport) assert.ok(p.hints.prop || p.hints.props, `${p.id}: external support "${p.hints.externalSupport}" names no object`);
  for (const p of ALL) if (/seat/.test(p.support)) assert.ok(p.hints?.prop, `${p.id}: a seated posture names the seat or the object it is for`);
});

test("the seat height is a number for stools and mats, otherwise the body's popliteal height, and the hints the validator reads are consistent with the support", () => {
  for (const p of ALL) {
    const h = p.hints?.seat?.height;
    if (/seat/.test(p.support)) assert.ok(h === "popliteal" || (typeof h === "number" && h >= 0.05), `${p.id}: seat height ${h}`);
    if (p.support === "seat+feet" && h === "popliteal") assert.ok((p.contacts ?? []).length || !p.hints?.externalSupport, `${p.id}: with external support the feet are declared as contacts`);
  }
  assert.equal(get("sit-high-stool").hints.seat.height, 0.65);
  assert.equal(get("veh-motorcycle-rider").hints.seat.height, 0.8);
});

test("symmetric postures are symmetric, asymmetric ones are not (the tags tell the truth)", () => {
  const pairs = ["elbowAngle", "shoulderElevation", "kneeAngle", "hipAngle", "handHeightAboveFloor", "thighInclination", "wristFlexion", "ankleAngle"];
  for (const p of ALL) {
    const sym = p.tags.includes("symmetric"), asym = p.tags.includes("asymmetric");
    assert.ok(!(sym && asym), `${p.id} is tagged both symmetric and asymmetric`);
    const m = measure(BODIES["P50 man"], p).m;
    let worst = 0;
    for (const k of pairs) { const a = m[`${k}_L`], b = m[`${k}_R`]; if (typeof a === "number" && typeof b === "number") worst = Math.max(worst, k === "handHeightAboveFloor" ? Math.abs(a - b) * 100 : Math.abs(a - b)); }
    worst = Math.max(worst, Math.abs(m.trunkInclinationSide ?? 0), Math.abs(m.trunkTwist ?? 0), Math.abs(m.trunkLateralFlexion ?? 0), Math.abs(m.neckTwist ?? 0), Math.abs(m.headTilt ?? 0));
    if (sym) assert.ok(worst < 3, `${p.id}: tagged symmetric, the sides differ by ${worst.toFixed(1)} (degrees, or cm for the hands)`);
    if (asym) assert.ok(worst > 4, `${p.id}: tagged asymmetric, the sides differ by only ${worst.toFixed(1)}`);
  }
});

test("mirroring an asymmetric posture exchanges its sides (the left-handed version exists for free)", () => {
  for (const id of ["veh-seatbelt-reach", "veh-mirror-adjust", "sit-mouse", "veh-gear-shift"]) {
    const p = get(id), body = BODIES["P50 man"];
    const a = measure(body, p), e = expandPosture(p);
    const mir = mirrorPose({ root: e.root, angles: e.angles });
    const root = placePose(body, mir, { posture: p }), b = postureMetrics(body, mir, root);
    for (const k of ["handHeightAboveFloor", "elbowAngle", "kneeAngle", "handToShoulderLateral"]) {
      const sgn = k === "handToShoulderLateral" ? -1 : 1;
      near(b[`${k}_L`], sgn * a.m[`${k}_R`], k.startsWith("hand") && k !== "handToShoulderLateral" ? 0.01 : k === "handToShoulderLateral" ? 0.02 : 1.0, `${id} mirrored ${k}_L`);
      near(b[`${k}_R`], sgn * a.m[`${k}_L`], k.startsWith("hand") && k !== "handToShoulderLateral" ? 0.01 : k === "handToShoulderLateral" ? 0.02 : 1.0, `${id} mirrored ${k}_R`);
    }
  }
});

// ---- sitting: the back rest family -------------------------------------------------------------------------------------------------------------------
test("sit-recline-105 / 115 / 125 / 135: the upper trunk follows the back rest (angle - 93 degrees back), everything is monotonic in the angle", () => {
  const angles = [105, 115, 125, 135];
  const res = angles.map((a) => all(`sit-recline-${a}`));
  for (const label of Object.keys(BODIES)) {
    const col = res.map((r) => r[label]);
    angles.forEach((a, i) => {
      near(col[i].thoraxInclination, -(a - 93), 4, `${label}: upper trunk (T1 up axis) of the ${a} degree seat back, the lean is ${a - 90} with 3 degrees of offset`);
      near(col[i].seatHeight, seatHeightFor(BODIES[label]), 0.02, `${label}: the sit bones are on the popliteal seat plane`);
      near(col[i].thighInclination_L, 0, 3, `${label}: thighs level`);
      near(col[i].headInclination, 0, 10, `${label}: the head stays near level (the eyes on the horizon)`);
      above(col[i].hipAngle_L, 94, `${label}: hip angle ${a}`);
    });
    for (let i = 1; i < col.length; i++) {
      below(col[i].trunkInclination, col[i - 1].trunkInclination - 2, `${label}: hip to C7 line leans back more at ${angles[i]} than at ${angles[i - 1]}`);
      below(col[i].thoraxInclination, col[i - 1].thoraxInclination - 8, `${label}: thorax leans back more at ${angles[i]}`);
      above(col[i].hipAngle_L, col[i - 1].hipAngle_L + 3, `${label}: hip angle opens with the recline at ${angles[i]}`);
      above(col[i].neckFlexion, col[i - 1].neckFlexion + 1, `${label}: the neck flexes more to keep the gaze level at ${angles[i]}`);
    }
    // SAE J826: a driver's seat back of 115 degrees leans the torso 20 to 25 degrees (the chord hip to C7 is 5 to 10 degrees less because the pelvis is capped, see sitting.js)
    within(col[1].thoraxInclination, -28, -16, `${label}: 115 degree seat, upper trunk`);
    within(col[1].trunkInclination, -22, -10, `${label}: 115 degree seat, hip to C7 chord`);
    within(col[0].trunkInclination, -14, -4, `${label}: 105 degree seat, hip to C7 chord`);
  }
  for (const a of angles) { const p = get(`sit-recline-${a}`); assert.equal(p.hints.prop.type, "cabin_seat"); assert.equal(p.hints.prop.params.recline, a); }
});

test("sit-upright-90: the ISO 7250-1 seated posture with the hands on the thighs", () => {
  each("sit-upright-90", (m, r, w) => {
    near(m.trunkInclination, 0, 2, `${w}: trunk`);
    near(m.hipAngle_L, 90.5, 4, `${w}: hip (ISO 90)`);
    near(m.kneeAngle_L, 84, 4, `${w}: knee (the model's ISO 90 reads 84, MODEL.md 4.1)`);
    near(m.thighInclination_L, 0, 3, `${w}: thighs horizontal`);
    near(m.headInclination, 0, 2, `${w}: head in the Frankfurt plane`);
    near(m.seatHeight, seatHeightFor(r.body), 0.01, `${w}: popliteal seat`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.08, 0.30, `${w}: the hands are at thigh level`);
    near(m.weightShareLeft, 0.5, 0.15, `${w}: feet share the load`);
  });
});

test("sit-relaxed-office and sit-lumbar-supported-100: leaning on a 100 degree back rest, the lumbar curve kept with the support and rounded without", () => {
  each("sit-relaxed-office", (m, r, w) => {
    within(m.trunkInclination, -10, 2, `${w}: trunk`);
    within(m.neckFlexion, 5, 25, `${w}: the head forward of the trunk (ISO 11226 neck flexion band 0 to 25)`);
    above(m.lumbarFlexion, 0, `${w}: the lower back is rounded, not arched`);
    within(m.elbowAngle_L, 80, 120, `${w}: forearms on the arm rests (REBA lower arm 60 to 100 degrees of flexion)`);
  });
  each("sit-lumbar-supported-100", (m, r, w) => {
    within(m.trunkInclination, -16, -6, `${w}: a 100 degree back rest leans the trunk about 10 degrees`);
    below(m.lumbarFlexion, -3, `${w}: the lumbar lordosis is kept (extension) by the support`);
    near(m.headInclination, 0, 5, `${w}: head level`);
    above(m.hipAngle_L, 96, `${w}: hip angle`);
  });
  const rel = all("sit-relaxed-office"), sup = all("sit-lumbar-supported-100");
  for (const label of Object.keys(BODIES)) above(rel[label].lumbarFlexion, sup[label].lumbarFlexion + 8, `${label}: relaxed sitting has a rounder lower back than the lumbar-supported posture`);
});

test("sit-slumped: rounded lumbar and thoracic spine, the pelvis rolled back, the head poked forward, arms hanging", () => {
  each("sit-slumped", (m, r, w) => {
    above(m.lumbarFlexion, 15, `${w}: lumbar flexion`);
    above(m.thoracicFlexion, 15, `${w}: thoracic flexion (kyphosis)`);
    above(m.thoraxInclination, 30, `${w}: the upper trunk is rounded forward`);
    below(m.pelvisTilt, 14, `${w}: the pelvis is tilted back relative to standing (${f1(m.pelvisTilt)} against the 17 degrees of the neutral pose)`);
    above(m.elbowAngle_L, 150, `${w}: arms hang`);
    below(m.handHeightAboveFloor_L, m.seatHeight, `${w}: the hands hang below the seat plane level of the thighs`);
  });
});

test("sit-lean-forward-desk: trunk about 20 degrees forward (the top of the ISO 11226 band that needs no support), forearms on a desk at the sitter's elbow height", () => {
  each("sit-lean-forward-desk", (m, r, w) => {
    near(m.trunkInclination, 20, 6, `${w}: trunk inclination`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.22, 0.40, `${w}: the hands lie on a desk about 0.3 m above the seat plane`);
    above(m.handToShoulderForward_L, 0.25, `${w}: the hands are well ahead of the shoulders`);
    within(m.headInclination, 25, 55, `${w}: the head is tilted down to the work`);
    near(r.lm("palm_centre_L").y - r.lm("palm_centre_R").y, 0, 0.02, `${w}: both hands on the same desk`);
  });
});

test("sit-edge-of-seat, sit-high-stool, sit-legs-extended, sit-feet-up: the leg angles that give each its name", () => {
  each("sit-edge-of-seat", (m, r, w) => {
    below(m.kneeAngle_L, 80, `${w}: feet drawn back, knee flexed beyond the ISO 90 (included angle below 80 degrees in the model)`);
    within(m.trunkInclination, 0, 15, `${w}: trunk upright to slightly forward, free of the back rest`);
    near(m.legSupport === "both" ? 1 : 0, 1, 0, `${w}: both feet carry weight`);
  });
  each("sit-high-stool", (m, r, w) => {
    near(m.seatHeight, 0.65, 0.04, `${w}: stool height (the sit bones are 0.65 m above the floor plus the 20 mm of thigh slope)`);
    within(m.thighInclination_L, -25, -3, `${w}: thighs slope down from the high seat`);
    within(m.kneeAngle_L, 90, 115, `${w}: knees at about 100 deg, the shanks vertical, the feet on the foot ring under the knees`);
    within(m.shankInclination_L, -12, 12, `${w}: the shanks are vertical`);
    assert.equal(m.legSupport, "none", `${w}: the feet are on the ring, not the floor`);
  });
  each("sit-legs-extended", (m, r, w) => {
    above(m.kneeAngle_L, 135, `${w}: legs only slightly bent`);
    within(m.thighInclination_L, -35, -8, `${w}: thighs slope down so that the heels reach the floor`);
    below(m.trunkInclination, -6, `${w}: leaning back`);
    near(r.lm("heel_sole_L").y, 0, 0.02, `${w}: heels on the floor`);
  });
  each("sit-feet-up", (m, r, w) => {
    above(m.kneeAngle_L, 140, `${w}: legs almost straight`);
    above(r.lm("heel_sole_L").y, 0.15, `${w}: the heels are raised on a footrest, well above the floor`);
    assert.equal(m.legSupport, "none", `${w}: no foot on the floor`);
    below(m.trunkInclination, -8, `${w}: reclined`);
  });
});

test("sit-legs-crossed-knee and sit-legs-crossed-ankle: one leg over the other, one foot on the floor", () => {
  each("sit-legs-crossed-knee", (m, r, w) => {
    assert.equal(m.legSupport, "left", `${w}: only the left foot is on the floor`);
    above(m.kneeHeight_R - m.kneeHeight_L, 0.08, `${w}: the right knee is raised over the left thigh`);
    const kneeR = r.lm("knee_top_R"), kneeL = r.lm("knee_top_L"), hipR = r.lm("trochanterion_R");
    above(kneeR.x - hipR.x, 0.02, `${w}: the right knee has crossed toward the midline and beyond (lateral position relative to its own hip, +x is the left)`);
    below(Math.abs(kneeR.x - kneeL.x), 0.20, `${w}: the knees are over each other`);
  });
  each("sit-legs-crossed-ankle", (m, r, w) => {
    assert.equal(m.legSupport, "left", `${w}: the right foot rests on the left`);
    const aR = r.lm("lateral_malleolus_R"), aL = r.lm("lateral_malleolus_L");
    above(aR.y - aL.y, 0.04, `${w}: the right ankle lies above the left`);
    below(Math.abs(aR.x - aL.x), 0.10, `${w}: the ankles are over each other`);
    above(m.kneeAngle_L, 105, `${w}: legs forward`);
  });
});

test("sit-bench-arms-along-back, sit-elbows-on-knees, sit-armrest-lean, sit-hands-behind-head", () => {
  each("sit-bench-arms-along-back", (m, r, w) => {
    above(m.upperArmInclination_L, 60, `${w}: the arms are raised to about the horizontal`);
    below(m.upperArmInclinationSagittal_L, -5, `${w}: and a little behind the trunk, along the back rest`);
    above(m.shoulderAbduction_L, 55, `${w}: spread to the side`);
    below(m.trunkInclination, -2, `${w}: leaning back on the rail`);
  });
  each("sit-elbows-on-knees", (m, r, w) => {
    above(m.trunkInclination, 25, `${w}: leaning far forward (ISO 11226: 20 to 60 degrees only with support, here the arms on the knees)`);
    below(dist(r.lm("olecranon_L"), r.lm("knee_top_L")), 0.22, `${w}: the left elbow rests on the knee`);
    below(dist(r.lm("olecranon_R"), r.lm("knee_top_R")), 0.22, `${w}: the right elbow rests on the knee`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.20, `${w}: hands together in front of the knees`);
  });
  each("sit-armrest-lean", (m, r, w) => {
    within(m.trunkLateralFlexion, 8, 25, `${w}: leaning to the left (ISO 11226: lateral flexion is not recommended when held)`);
    above(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R + 0.04, `${w}: the left forearm is on the armrest, higher than the right hand in the lap`);
    below(m.headTilt, 10, `${w}: the head compensates toward the vertical`);
  });
  each("sit-hands-behind-head", (m, r, w) => {
    above(m.handToShoulderUp_L, 0.05, `${w}: the hands are above the shoulder joints`);
    below(m.handToShoulderForward_L, -0.05, `${w}: and behind them`);
    above(m.shoulderAbduction_L, 40, `${w}: the elbows are out`);
    below(m.trunkInclination, -8, `${w}: leaning back`);
    below(dist(r.lm("palm_centre_L"), r.lm("opisthocranion")), 0.16, `${w}: the hands are at the back of the head`);
  });
});

test("sit-typing, sit-mouse, sit-writing, sit-eating, sit-tablet: the workstation postures (ISO 9241-5 elbow and wrist, ISO 11226 head)", () => {
  each("sit-typing", (m, r, w) => {
    within(m.elbowAngle_L, 85, 125, `${w}: elbows (REBA lower arm 60 to 100 degrees of flexion, 80 to 120 included)`);
    within(m.wristFlexion_L, -15, 15, `${w}: wrists straight (REBA 15 degrees)`);
    within(m.trunkInclination, -6, 8, `${w}: upright`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.15, 0.40, `${w}: the keyboard is at desk height above the seat plane`);
    within(m.neckFlexion, 5, 25, `${w}: looking at a screen`);
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.02, `${w}: both hands on the keyboard`);
  });
  each("sit-mouse", (m, r, w) => {
    const pR = r.lm("palm_centre_R"), pL = r.lm("palm_centre_L");
    above(Math.abs(pR.x) - Math.abs(pL.x), 0.0, `${w}: the mouse hand is farther from the midline than the keyboard hand`);
    below(pR.x, -0.07, `${w}: the right hand is to the sitter's right of the midline`);
    within(m.wristFlexion_R, -15, 15, `${w}: mouse wrist straight`);
    within(m.elbowAngle_R, 85, 125, `${w}: elbow`);
  });
  each("sit-writing", (m, r, w) => {
    within(m.trunkInclination, 5, 25, `${w}: leaning forward`);
    within(m.headInclination, 30, 55, `${w}: head down over the page`);
    within(m.handHeightAboveFloor_R - m.seatHeight, 0.22, 0.42, `${w}: the right hand on a desk`);
    above(Math.abs(m.headTilt), 3, `${w}: the head is tilted sideways over the page`);
  });
  each("sit-eating", (m, r, w) => {
    below(dist(r.lm("palm_centre_R"), r.lm("stomion")), 0.18, `${w}: the right hand is at the mouth`);
    above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.15, `${w}: the cutlery hand is raised above the resting hand`);
    within(m.trunkInclination, 0, 15, `${w}: leaning slightly toward the table`);
  });
  each("sit-tablet", (m, r, w) => {
    within(m.neckFlexion, 20, 40, `${w}: neck flexion of tablet reading (ISO 11226 band 25 to 40 is conditional)`);
    within(m.headInclination, 20, 45, `${w}: head inclination`);
    above(m.handToShoulderForward_L, 0.2, `${w}: the tablet is held in front of the chest`);
    near(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.24, 0.12, `${w}: hands at the two edges of a 10 inch tablet`);
    below(r.lm("palm_centre_L").y, r.lm("eye_mid").y - 0.2, `${w}: the tablet is below the eyes`);
  });
});

test("sit-reach-panel and sit-twist-reach-side: the reach is made by the arm, or by turning the trunk", () => {
  each("sit-reach-panel", (m, r, w) => {
    above(m.handToShoulderForward_R, 0.45, `${w}: the right hand is far ahead of the shoulder`);
    above(m.elbowAngle_R, 140, `${w}: the arm is almost straight`);
    above(m.handReach_R, m.handReach_L + 0.2, `${w}: the other hand rests in the lap`);
    within(m.trunkInclination, 5, 22, `${w}: leaning toward the panel`);
    within(m.handToShoulderUp_R, -0.1, 0.12, `${w}: at shoulder height`);
  });
  each("sit-twist-reach-side", (m, r, w) => {
    above(m.trunkTwist, 15, `${w}: the thorax is turned to the left against the pelvis (ISO 11226: an asymmetric posture)`);
    above(m.handToShoulderLateral_L, 0.2, `${w}: the left arm reaches out to the side`);
    below(Math.abs(m.handToShoulderLateral_R), 0.15, `${w}: the right hand stays at the keyboard`);
  });
});

test("sit-floor-long and sit-seiza: floor postures", () => {
  each("sit-floor-long", (m, r, w) => {
    near(m.seatHeight, 0.07, 0.04, `${w}: the sit bones are on a 0.07 m mat`);
    above(m.kneeAngle_L, 155, `${w}: legs straight`);
    near(m.thighInclination_L, 0, 12, `${w}: legs along the floor`);
    below(m.pelvisHeight, 0.2, `${w}: the pelvis is low`);
    above(m.stanceWidth, 0.2, `${w}: feet a little apart`);
  });
  each("sit-seiza", (m, r, w) => {
    below(m.kneeAngle_L, 50, `${w}: deep knee flexion`);
    below(m.kneeHeight_L, 0.2, `${w}: the knees are on the floor`);
    below(m.pelvisHeight, 0.4, `${w}: seated on the heels`);
    below(m.hipHeight, 0.35, `${w}: hips low`);
    below(m.shankInclination_L, -75, `${w}: the shanks lie flat behind the knees`);
    below(m.comOverBase, 0, `${w}: the centre of mass is behind the knees, over the heels (hints.externalSupport)`);
  });
});

// ---- vehicle: the driver family -----------------------------------------------------------------------------------------------------------------------
test("veh-driver-9-and-3 and 10-and-2: the car driver posture (torso about 23 degrees from vertical, hip 95 to 115, knee 110 to 135, elbow 100 to 135)", () => {
  const nine = all("veh-driver-9-and-3"), ten = all("veh-driver-10-and-2");
  for (const [label, body] of Object.entries(BODIES)) {
    for (const [name, m] of [["9 and 3", nine[label]], ["10 and 2", ten[label]]]) {
      near(m.thoraxInclination, -22, 5, `${label} ${name}: torso angle (SAE 20 to 25 degrees from vertical)`);
      within(m.hipAngle_L, 95, 115, `${label} ${name}: hip angle (Porter and Gyi 90 to 115)`);
      within(m.kneeAngle_L, 110, 135, `${label} ${name}: knee angle (driver comfort range 110 to 135, approx.)`);
      within(m.kneeAngle_R, 110, 135, `${label} ${name}: knee angle right`);
      within(m.elbowAngle_L, 100, 135, `${label} ${name}: elbow angle (driver range 110 to 130, approx., with 10 degrees of margin)`);
      near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.01, `${label} ${name}: the two hands at the same height`);
      near(m.seatHeight, seatHeightFor(body), 0.03, `${label} ${name}: seat`);
      within(m.wristFlexion_L, -20, 20, `${label} ${name}: wrists`);
      assert.equal(m.legSupport, "both", `${label} ${name}: both feet on the floor mat`);
      near(m.headInclination, 0, 6, `${label} ${name}: the head is level for the road`);
    }
    above(ten[label].handHeightAboveFloor_L, nine[label].handHeightAboveFloor_L + 0.08, `${label}: hands at 10 and 2 are higher than at 9 and 3`);
    below(ten[label].elbowAngle_L, nine[label].elbowAngle_L - 10, `${label}: and the elbows are more bent`);
  }
  // the hands are on a 0.38 m wheel: their grip centres are one rim diameter apart at 9 and 3, 0.33 m at 10 and 2
  const body = BODIES["P50 man"];
  near(dist(measure(body, get("veh-driver-9-and-3")).lm("grip_centre_L"), measure(body, get("veh-driver-9-and-3")).lm("grip_centre_R")), 0.38, 0.05, "9 and 3: hand spacing");
  near(dist(measure(body, get("veh-driver-10-and-2")).lm("grip_centre_L"), measure(body, get("veh-driver-10-and-2")).lm("grip_centre_R")), 0.33, 0.05, "10 and 2: hand spacing");
  const p = get("veh-driver-9-and-3");
  assert.equal(p.hints.prop.type, "steering_wheel"); assert.deepEqual(p.hints.prop.grips, { L: "rim_9", R: "rim_3" });
  assert.ok(p.hints.props.some((o) => o.type === "pedals" && o.anchors?.R === "accel_pad"), "the pedals are named with the foot anchor");
});

test("veh-pedal-brake, brake-hard, clutch, gear-shift: the feet differ from the accelerator posture in the way their names say", () => {
  const base = all("veh-driver-9-and-3"), brake = all("veh-pedal-brake"), hard = all("veh-pedal-brake-hard"), clutch = all("veh-pedal-clutch"), gear = all("veh-gear-shift");
  for (const label of Object.keys(BODIES)) {
    below(brake[label].footSeparationMediolateral, base[label].footSeparationMediolateral - 0.08, `${label}: the right foot has swung toward the left foot (the brake is 0.13 m to the left of the accelerator)`);
    near(brake[label].kneeAngle_R, base[label].kneeAngle_R, 3, `${label}: the knee does not change much between the accelerator and the brake (the pedals are about the same distance away)`);
    above(brake[label].ankleAngle_R, base[label].ankleAngle_R + 4, `${label}: the foot presses the pad, the ankle is a little more plantar-flexed than at rest`);
    assert.notEqual(brake[label].legSupport, "none", `${label}: the heels are on the floor mat`);
    above(hard[label].kneeAngle_R, 128, `${label}: emergency braking pushes the right leg almost straight`);
    above(hard[label].kneeAngle_R, brake[label].kneeAngle_R + 8, `${label}: and straighter than on the ordinary brake`);
    above(hard[label].ankleAngle_R, base[label].ankleAngle_R + 8, `${label}: ankle plantar-flexed on the pedal`);
    above(hard[label].elbowAngle_L, 120, `${label}: arms braced on the wheel`);
    above(clutch[label].kneeAngle_L, clutch[label].kneeAngle_R + 8, `${label}: the left leg pushes the clutch, more extended than the right`);
    above(clutch[label].ankleAngle_L, base[label].ankleAngle_L + 8, `${label}: left ankle plantar-flexed`);
    above(gear[label].kneeAngle_L, gear[label].kneeAngle_R + 8, `${label}: gear change with the clutch down`);
    above(gear[label].handHeightAboveFloor_L, gear[label].handHeightAboveFloor_R + 0.1, `${label}: the right hand is down at the gear lever, the left on the wheel`);
    // the resting foot is on the mat, the working foot may be off it (the floor contact is declared for the resting heel only)
    assert.equal(hard[label].legSupport, "left", `${label}: emergency braking: the left foot on the mat, the working right foot on the pedal`);
    assert.equal(clutch[label].legSupport, "right", `${label}: clutch: the right foot on the mat`);
  }
  const heels = (id) => get(id).contacts;
  assert.deepEqual(heels("veh-pedal-brake-hard"), ["heel_sole_L"]); assert.deepEqual(heels("veh-pedal-clutch"), ["heel_sole_R"]); assert.deepEqual(heels("veh-gear-shift"), ["heel_sole_R"]);
  assert.equal(get("veh-gear-shift").hints.prop.type, "lever");
});

test("veh-driver-relaxed, veh-console-reach, veh-mirror-adjust, veh-seatbelt-reach, veh-door-reach, veh-reverse-look: one arm leaves the wheel", () => {
  const base = all("veh-driver-9-and-3");
  each("veh-driver-relaxed", (m, r, w) => {
    above(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R + 0.15, `${w}: the left hand is at the top of the wheel, the right on the thigh`);
    below(m.thoraxInclination, -24, `${w}: more reclined than the 9 and 3 driver (-22)`);
  });
  each("veh-console-reach", (m, r, w) => {
    above(m.handToShoulderForward_R, 0.42, `${w}: the right arm reaches out to the centre stack`);
    below(Math.abs(r.lm("index_tip_R").x), 0.2, `${w}: across toward the midline (the index finger is within 0.2 m of the centre line, the wheel hand is at 0.19 m)`);
    near(m.handHeightAboveFloor_L, base[w.split(" on the ")[1]].handHeightAboveFloor_L, 0.02, `${w}: the left hand stays on the wheel`);
  });
  each("veh-mirror-adjust", (m, r, w) => {
    above(m.handToShoulderUp_R, 0.1, `${w}: the right hand is above the shoulder joint, at the interior mirror`);
    above(m.upperArmInclination_R, 80, `${w}: the arm is raised to or above the horizontal`);
    above(m.handToShoulderForward_R, 0.3, `${w}: and forward`);
    assert.ok(m.handAboveShoulder_R, `${w}: handAboveShoulder_R`);
    assert.ok(!m.handAboveShoulder_L, `${w}: the left hand stays on the wheel`);
  });
  each("veh-seatbelt-reach", (m, r, w) => {
    above(m.trunkTwist, 20, `${w}: the trunk is turned to the left`);
    above(m.handToShoulderUp_L, 0.05, `${w}: the left hand reaches up to the belt guide`);
    below(m.handToShoulderForward_L, -0.03, `${w}: and behind the shoulder`);
    within(m.neckTwist, 10, 35, `${w}: the head turns with it`);
  });
  each("veh-door-reach", (m, r, w) => {
    above(m.handToShoulderLateral_L, 0.2, `${w}: the left hand is out to the side at the door handle`);
    within(m.trunkTwist, 8, 30, `${w}: slightly turned`);
    below(m.handToShoulderUp_L, 0, `${w}: below the shoulder joint, at hip level of the door`);
  });
  each("veh-reverse-look", (m, r, w) => {
    below(m.trunkTwist, -20, `${w}: the trunk is turned to the right`);
    below(m.trunkTwist + m.neckTwist, -60, `${w}: trunk and head together look back (more than 60 degrees)`);
    above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L - 0.2, `${w}: the right arm is raised over the passenger seat back`);
  });
});

test("veh-cockpit-stick-throttle, veh-helicopter-pilot, veh-tank-driver-reclined, veh-operator-joysticks, veh-truck-driver: seat back angle and hand positions of each station", () => {
  const car = all("veh-driver-9-and-3");
  for (const label of Object.keys(BODIES)) {
    const jet = all("veh-cockpit-stick-throttle")[label], heli = all("veh-helicopter-pilot")[label], tank = all("veh-tank-driver-reclined")[label], op = all("veh-operator-joysticks")[label], truck = all("veh-truck-driver")[label];
    within(jet.thoraxInclination, -36, -20, `${label}: a fighter seat back of 120 degrees (13 to 30 degrees from vertical)`);
    below(tank.thoraxInclination, car[label].thoraxInclination - 12, `${label}: the armoured vehicle driver is far more reclined than the car driver`);
    above(heli.thoraxInclination, -14, `${label}: the helicopter seat is almost upright`);
    above(truck.thoraxInclination, car[label].thoraxInclination + 8, `${label}: the truck driver sits more upright than the car driver (SAE class B)`);
    above(truck.elbowAngle_L, 100, `${label}: truck driver's arms on a large wheel`);
    within(op.elbowAngle_L, 80, 110, `${label}: operator elbows on the armrests`);
    near(op.handHeightAboveFloor_L, op.handHeightAboveFloor_R, 0.01, `${label}: operator hands at the same height`);
    above(op.handToShoulderLateral_L, 0.05, `${label}: joysticks beside the thighs`);
    // right hand on the centre stick between the knees, left hand out to the left on the throttle
    above(jet.handToShoulderLateral_L, 0.1, `${label}: throttle hand to the left`);
    below(Math.abs(jet.handToShoulderLateral_R), 0.1, `${label}: stick hand on the centre line`);
    above(heli.handToShoulderLateral_L, 0.1, `${label}: collective hand to the left`);
    below(Math.abs(heli.handToShoulderLateral_R), 0.15, `${label}: cyclic hand on the centre line`);
    assert.equal(jet.legSupport, "both"); assert.equal(heli.legSupport, "both");
  }
  assert.equal(get("veh-cockpit-stick-throttle").hints.prop.type, "joystick");
  assert.equal(get("veh-cockpit-stick-throttle").hints.props.find((o) => o.type === "throttle").grips.L, "knob");
  assert.equal(get("veh-truck-driver").hints.prop.params.diameter, 0.45, "the largest wheel of the catalog");
});

test("veh-entry-leg-in, veh-exit-step-out, veh-cab-step-up: one foot off the ground, hands on the frame or handle, the trunk bent", () => {
  each("veh-entry-leg-in", (m, r, w) => {
    assert.equal(m.legSupport, "left", `${w}: the left foot carries the weight`);
    above(r.lm("heel_sole_R").y, 0.15, `${w}: the right foot is lifted into the car`);
    above(m.trunkInclination, 12, `${w}: bent to get under the roof`);
    above(m.neckFlexion, 15, `${w}: head ducked`);
    above(m.handToShoulderUp_L, 0.08, `${w}: the left hand on the roof edge above the shoulder`);
  });
  each("veh-exit-step-out", (m, r, w) => {
    assert.equal(m.legSupport, "left", `${w}: the left foot is already on the ground`);
    above(r.lm("heel_sole_R").y, 0.1, `${w}: the right foot is still in the footwell above the ground`);
    within(m.trunkInclination, 4, 22, `${w}: coming up out of the seat`);
    above(m.handToShoulderUp_L, 0.05, `${w}: the left hand on the roof`);
  });
  each("veh-cab-step-up", (m, r, w) => {
    assert.equal(m.legSupport, "right", `${w}: the right foot pushes from the ground`);
    within(r.lm("heel_sole_L").y, 0.38, 0.58, `${w}: the left foot is on a 0.45 m step (the fixed angles put it 0.4 to 0.55 m up on the three bodies)`);
    above(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R + 0.2, `${w}: left hand high on the grab handle, right hand low`);
    above(m.handHeightAboveFloor_R, 0.9, `${w}: both hands above the waist (three-point contact)`);
    within(m.trunkInclination, 5, 30, `${w}: leaning into the climb`);
    above(m.handToShoulderForward_L, 0.25, `${w}: the handle is ahead`);
  });
});

test("veh-turret-gunner-standing, veh-standing-passenger-grab, veh-rear-bench-passenger, veh-jump-seat-crew, veh-motorcycle-rider", () => {
  each("veh-turret-gunner-standing", (m, r, w) => {
    above(m.kneeAngle_L, 155, `${w}: standing, knees a little bent`);
    above(m.stanceWidth, 0.3, `${w}: feet apart on the platform`);
    within(m.shoulderHeight_L - m.handHeightAboveFloor_L, 0.08, 0.30, `${w}: hands on the grips at chest height`);
    above(m.handToShoulderForward_L, 0.25, `${w}: the grips are ahead of the chest`);
    within(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.12, 0.40, `${w}: the two grips of the mount are about 0.3 m apart`);
    assert.equal(m.legSupport, "both");
  });
  each("veh-standing-passenger-grab", (m, r, w) => {
    above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.5, `${w}: the right hand is up on the handle, the left hangs`);
    above(m.stanceWidth, 0.3, `${w}: a wide stance for balance`);
    within(m.kneeAngle_L, 150, 175, `${w}: knees slightly bent`);
    assert.equal(m.legSupport, "both", `${w}: both feet on the floor`);
    assert.ok(get("veh-standing-passenger-grab").hints.dynamic, `${w}: a moment in a moving vehicle`);
  });
  each("veh-rear-bench-passenger", (m, r, w) => {
    within(m.thoraxInclination, -24, -10, `${w}: the rear seat back is about 20 degrees (SAE J1100)`);
    below(m.neckTwist, -4, `${w}: the head is turned to the right, toward the window`);
    below(m.handHeightAboveFloor_L - m.seatHeight, 0.3, `${w}: the hands rest in the lap`);
  });
  each("veh-jump-seat-crew", (m, r, w) => {
    above(m.stanceWidth, 0.4, `${w}: knees and feet apart`);
    above(m.handToShoulderUp_R, 0.05, `${w}: the right hand holds a handle above the shoulder`);
    above(m.handHeightAboveFloor_R, m.handHeightAboveFloor_L + 0.4, `${w}: the left hand rests on the thigh`);
    within(m.trunkInclination, -10, 4, `${w}: upright against the seat back`);
  });
  each("veh-motorcycle-rider", (m, r, w) => {
    within(m.trunkInclination, 12, 30, `${w}: leaning forward over the tank`);
    near(m.seatHeight, 0.8, 0.04, `${w}: seat height of the motorcycle`);
    above(m.stanceWidth, 0.45, `${w}: knees apart astride the tank`);
    above(m.handToShoulderForward_L, 0.2, `${w}: hands forward on the handlebar`);
    assert.equal(m.legSupport, "none", `${w}: the feet are on the pegs, not the floor`);
    below(m.neckFlexion, 0, `${w}: the neck is extended so that the rider looks ahead`);
  });
});

// ---- sitting: the added postures ----------------------------------------------------------------------------------------------------------------------
test("sit-high-stool-bench-work: on a 0.68 m stool, thighs sloping down, trunk about 15 degrees forward, hands flat on a bench at about elbow height, feet off the floor on a ring", () => {
  each("sit-high-stool-bench-work", (m, r, w) => {
    within(m.seatHeight, 0.69, 0.76, `${w}: the sit bones are 0.02 to 0.06 m above the 0.68 m seat plane (soft tissue under the sit bones and the tilted pelvis)`);
    within(m.trunkInclination, 8, 22, `${w}: trunk about 15 deg forward (ISO 11226: 0 to 20 deg needs no support)`);
    within(m.thighInclination_L, -25, -8, `${w}: the thighs slope down from the high seat`);
    within(m.kneeAngle_L, 85, 110, `${w}: knees`);
    assert.equal(m.legSupport, "none", `${w}: the feet are on the ring, not on the floor`);
    within(m.elbowAngle_L, 70, 105, `${w}: elbows (the hands were placed on the bench by IK)`);
    within(m.wristFlexion_L, -12, 15, `${w}: wrists nearly straight`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.2, 0.32, `${w}: the bench top is about 0.26 m above the sit bones`);
    above(m.handToShoulderForward_L, 0.25, `${w}: the hands are well ahead of the shoulders`);
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.01, `${w}: both hands on the same bench`);
  });
  assert.equal(get("sit-high-stool-bench-work").hints.seat.height, 0.68);
  assert.equal(get("sit-high-stool-bench-work").hints.props[0].type, "workbench");
});

test("sit-rise-seat-off: a moment of standing up: thighs level, trunk bent about 40 degrees, feet under the knees, arms swung forward, the sit bones just above the seat plane", () => {
  each("sit-rise-seat-off", (m, r, w) => {
    within(m.trunkInclination, 28, 48, `${w}: trunk flexion of the seat-off phase (about 40 to 50 deg, Schenkman et al., approx.)`);
    within(m.thighInclination_L, -9, 4, `${w}: thighs nearly level (they slope down 6 deg here)`);
    within(m.shankInclination_L, -14, 6, `${w}: the shanks are about vertical or leaning back: the feet are under or behind the knees`);
    assert.equal(m.legSupport, "both", `${w}: both feet carry the weight`);
    above(m.elbowAngle_L, 150, `${w}: arms nearly straight`);
    above(m.shoulderElevation_L, 85, `${w}: and swung forward to about the horizontal`);
    above(m.handToShoulderForward_L, 0.4, `${w}: the hands are far ahead of the shoulders`);
    within(m.seatHeight - seatHeightFor(r.body), 0.02, 0.12, `${w}: the sit bones are 20 to 120 mm above the popliteal seat plane: the buttocks have just left it`);
    below(m.neckFlexion, 0, `${w}: the neck is extended to keep the eyes ahead while the trunk is bent`);
  });
  const p = get("sit-rise-seat-off");
  assert.equal(p.support, "feet"); assert.equal(p.hints.dynamic, true, "a moment of a movement: the balance rule is waived");
});

test("sit-smartphone: about 55 degrees of neck flexion, the phone held low in front of the chest, elbows well bent (ISO 11226 neck band exceeded)", () => {
  each("sit-smartphone", (m, r, w) => {
    within(m.neckFlexion, 48, 62, `${w}: neck flexion of handheld phone use (Hansraj: 45 to 60 deg)`);
    within(m.headInclination, 50, 66, `${w}: head inclination`);
    within(m.elbowAngle_L, 60, 90, `${w}: elbows bent to about 75 deg, the phone is held close to the chest`);
    within(m.eyeHeight - m.handHeightAboveFloor_L, 0.18, 0.35, `${w}: the hands are 0.2 to 0.3 m below the eyes`);
    within(m.handToShoulderForward_L, 0.2, 0.45, `${w}: the phone is in front of the chest`);
    within(m.gazeElevation, -70, -45, `${w}: the eyes look down at the phone, about 55 deg below the horizontal`);
    within(Math.hypot(r.lm("eye_mid").y - r.lm("palm_centre_L").y, r.lm("eye_mid").z - r.lm("palm_centre_L").z), 0.25, 0.42, `${w}: the phone is about 0.3 m from the eyes`);
    near(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.11, 0.08, `${w}: the hands are together, thumbs on the same screen`);
    below(r.lm("palm_centre_L").y, r.lm("eye_mid").y - 0.18, `${w}: the screen is below the eye level`);
    within(m.trunkInclination, -3, 10, `${w}: trunk upright to slightly forward`);
  });
});

test("sit-laptop-on-lap: keyboard on the thighs, hands low, neck about 40 degrees flexed, wrists nearly straight, trunk against the back rest", () => {
  each("sit-laptop-on-lap", (m, r, w) => {
    within(m.neckFlexion, 32, 48, `${w}: neck flexion of a screen on the lap (ISO 11226: 25 deg accepted)`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.15, 0.30, `${w}: the keys are about 0.2 m above the sit bones, on the thighs`);
    below(m.handHeightAboveFloor_L - m.seatHeight, 0.30, `${w}: and lower than the desk keyboard of sit-typing (0.3 m and more)`);
    within(m.wristFlexion_L, -12, 12, `${w}: wrists nearly straight`);
    within(m.elbowAngle_L, 70, 105, `${w}: elbows`);
    within(m.trunkInclination, -10, 4, `${w}: trunk at or behind the vertical`);
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.01, `${w}: both hands on the keyboard`);
    assert.equal(m.legSupport, "both");
  });
  const keys = all("sit-typing"), lap = all("sit-laptop-on-lap");
  for (const label of Object.keys(BODIES)) {
    below(lap[label].handHeightAboveFloor_L, keys[label].handHeightAboveFloor_L - 0.05, `${label}: lower hands than at the desk`);
    above(lap[label].neckFlexion, keys[label].neckFlexion + 10, `${label}: and a more bent neck than at a desk`);
  }
});

test("sit-floor-lean-back: on the floor, legs forward, trunk leaning back on the arms, palms flat on the floor behind the hips", () => {
  each("sit-floor-lean-back", (m, r, w) => {
    near(m.seatHeight, 0.07, 0.04, `${w}: the sit bones are on a 0.07 m mat`);
    within(m.trunkInclination, -30, -12, `${w}: trunk leaning back (the upper trunk more: ${f1(m.thoraxInclination)})`);
    below(m.thoraxInclination, -25, `${w}: upper trunk well behind the vertical`);
    above(m.kneeAngle_L, 160, `${w}: legs straight`);
    below(m.handHeightAboveFloor_L, 0.12, `${w}: the palms are on the floor (mat top at 0.07 m)`);
    below(m.wristFlexion_L, -55, `${w}: wrists extended to carry the weight (palm down)`);
    above(m.elbowAngle_L, 110, `${w}: arms nearly straight`);
    const pL = r.lm("palm_centre_L"), ischial = r.lm("ischial_L");
    below(pL.z, ischial.z + 0.05, `${w}: the hands are at or behind the sit bones`);
    above(pL.x, 0.15, `${w}: and to the side of the hips`);
    below(m.pelvisTilt, 14, `${w}: the pelvis is tilted back relative to standing`);
  });
});

test("sit-arms-crossed: forearms folded across the chest, the left in front of the right, each hand on the opposite arm", () => {
  each("sit-arms-crossed", (m, r, w) => {
    const pL = r.lm("palm_centre_L"), pR = r.lm("palm_centre_R");
    below(pL.x, 0.12, `${w}: the left hand has crossed toward the midline or beyond`);
    above(pR.x, -0.12, `${w}: and the right hand as well`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.3, 0.7, `${w}: the hands are at chest height`);
    above(m.handToShoulderForward_L, 0.1, `${w}: in front of the chest`);
    above(m.shoulderElevation_L, 55, `${w}: the upper arms are raised to hold the forearms across the chest`);
    within(m.elbowAngle_L, 50, 95, `${w}: elbows folded`);
    above(r.lm("olecranon_L").z - r.lm("acromion_L").z, 0.1, `${w}: the elbows project forward of the shoulders`);
  });
  const p = get("sit-arms-crossed");
  const a = measure(BODIES["P50 man"], p), e = expandPosture(p), mir = mirrorPose({ root: e.root, angles: e.angles });
  const root = placePose(BODIES["P50 man"], mir, { posture: p }), b = postureMetrics(BODIES["P50 man"], mir, root);
  near(b.handHeightAboveFloor_R, a.m.handHeightAboveFloor_L, 0.01, "mirrored: the right hand is where the left was");
});

// ---- vehicle: the added postures --------------------------------------------------------------------------------------------------------------------------
test("veh-driver-head-check: the head turned about 70 degrees to the left from the pelvis, both hands still on the wheel, torso as in the driving posture", () => {
  const base = all("veh-driver-9-and-3");
  each("veh-driver-head-check", (m, r, w) => {
    const label = w.split(" on the ")[1];
    above(m.trunkTwist + m.neckTwist, 60, `${w}: trunk and neck together turn the head more than 60 deg to the left`);
    above(m.neckTwist, 45, `${w}: most of it by the neck`);
    within(m.trunkTwist, 3, 20, `${w}: the trunk turns a little`);
    near(m.thoraxInclination, base[label].thoraxInclination, 2, `${w}: the torso angle does not change (Reed et al.)`);
    near(m.handHeightAboveFloor_L, base[label].handHeightAboveFloor_L, 0.04, `${w}: the left hand stays on the wheel at 9 o'clock`);
    near(m.handHeightAboveFloor_R, base[label].handHeightAboveFloor_R, 0.04, `${w}: and the right hand at 3`);
    assert.equal(m.legSupport, "both", `${w}: both feet on the mat`);
  });
  const body = BODIES["P50 man"], c = measure(body, get("veh-driver-head-check"));
  near(dist(c.lm("grip_centre_L"), c.lm("grip_centre_R")), 0.38, 0.06, "hand spacing on a 0.38 m wheel");
  assert.equal(get("veh-driver-head-check").hints.prop.type, "steering_wheel");
  // the neck rotation range: cervical + head joint rotation stays inside the range of motion (the validator checks) and below the 70 deg of the cervical spine
  below(Math.abs(expandPosture(get("veh-driver-head-check")).angles.head[2]), 10.1, "the head joint turns at most 10 deg, the rest is the cervical spine");
});

test("veh-driver-glovebox-reach and veh-driver-seat-adjust-reach: one hand leaves the wheel for a place on the passenger side and below the seat", () => {
  const base = all("veh-driver-9-and-3");
  each("veh-driver-glovebox-reach", (m, r, w) => {
    const label = w.split(" on the ")[1];
    below(m.trunkLateralFlexion, -10, `${w}: the trunk bends to the right (negative)`);
    above(m.elbowAngle_R, 165, `${w}: the right arm is stretched out`);
    above(m.handToShoulderForward_R, 0.3, `${w}: far ahead of the shoulder`);
    const pR = r.lm("palm_centre_R"), ischial = r.lm("ischial_R");
    below(pR.x - ischial.x, -0.1, `${w}: the hand is out to the right of the right hip`);
    below(m.handHeightAboveFloor_R, m.seatHeight + 0.15, `${w}: at about seat level, the glovebox`);
    near(m.handHeightAboveFloor_L, base[label].handHeightAboveFloor_L, 0.04, `${w}: the left hand stays on the wheel`);
    below(m.headTilt, -8, `${w}: the head tilts with the trunk`);
  });
  each("veh-driver-seat-adjust-reach", (m, r, w) => {
    const label = w.split(" on the ")[1];
    above(m.thoraxInclination, 15, `${w}: the upper trunk is bent forward past the vertical (it is 22 deg back in the driving posture)`);
    above(m.thoraxInclination, base[label].thoraxInclination + 35, `${w}: by more than 35 deg`);
    above(m.trunkLateralFlexion, 6, `${w}: and to the left`);
    below(m.handHeightAboveFloor_L, m.seatHeight + 0.05, `${w}: the left hand is down at the seat cushion, level with the sit bones or lower`);
    above(m.handToShoulderLateral_L, 0.04, `${w}: out to the left`);
    within(m.handHeightAboveFloor_R - m.seatHeight, 0.05, 0.35, `${w}: the right hand rests on the thigh`);
    above(m.neckFlexion, 20, `${w}: the head is turned down to look`);
  });
  for (const id of ["veh-driver-glovebox-reach", "veh-driver-seat-adjust-reach"]) assert.ok(get(id).hints.prop, id);
});

test("veh-flight-deck-sidestick and veh-flight-deck-overhead-reach: the upright pilot seat, the stick on the left console and the levers on the pedestal, an arm raised to the overhead panel", () => {
  const heli = all("veh-helicopter-pilot"), car = all("veh-driver-9-and-3");
  for (const label of Object.keys(BODIES)) {
    const side = all("veh-flight-deck-sidestick")[label];
    above(side.thoraxInclination, car[label].thoraxInclination + 6, `${label}: more upright than the car driver`);
    above(side.handToShoulderLateral_L, 0.12, `${label}: the stick hand is out to the left`);
    below(side.handToShoulderLateral_R, -0.1, `${label}: the lever hand is out to the right`);
    above(side.handToShoulderForward_R, 0.3, `${label}: the levers are ahead`);
    within(side.elbowAngle_L, 75, 110, `${label}: stick elbow (the forearm is along the arm rest)`);
    assert.equal(side.legSupport, "both", `${label}: feet on the pedals`);
    near(side.kneeAngle_L, heli[label].kneeAngle_L, 1, `${label}: the legs of the helicopter pilot (upright aircrew seat)`);
  }
  each("veh-flight-deck-overhead-reach", (m, r, w) => {
    above(m.handToShoulderUp_R, 0.2, `${w}: the right hand is well above the shoulder`);
    assert.ok(m.handAboveShoulder_R && !m.handAboveShoulder_L, `${w}: one hand above the shoulder`);
    above(m.shoulderElevation_R, 80, `${w}: the upper arm is raised to the horizontal or more`);
    above(r.lm("index_tip_R").y, r.lm("eye_mid").y + 0.1, `${w}: the fingertip is above the eye level (the panel is overhead)`);
    below(m.neckFlexion, -10, `${w}: the neck is extended, the head tilted back`);
    above(m.gazeElevation, 30, `${w}: the eyes look up at the panel`);
    below(m.handHeightAboveFloor_L - m.seatHeight, 0.3, `${w}: the left hand rests low`);
  });
  const p = get("veh-flight-deck-sidestick");
  assert.equal(p.hints.prop.type, "joystick"); assert.equal(p.hints.props.find((o) => o.type === "throttle").grips.R, "knob");
  assert.equal(get("veh-flight-deck-overhead-reach").hints.prop.type, "instrument_panel");
});

test("veh-gunner-seated: upright seat, both hands on the controller in front of the chest at the same height, head forward at the sight", () => {
  each("veh-gunner-seated", (m, r, w) => {
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.01, `${w}: hands at the same height`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.25, 0.42, `${w}: grips about 0.3 m above the sit bones`);
    within(dist(r.lm("grip_centre_L"), r.lm("grip_centre_R")), 0.2, 0.45, `${w}: grips about 0.32 m apart`);
    above(m.handToShoulderForward_L, 0.2, `${w}: ahead of the chest`);
    within(m.headInclination, 5, 20, `${w}: the head is inclined toward the sight`);
    above(m.thoraxInclination, -14, `${w}: upright seat`);
    assert.equal(m.legSupport, "both");
  });
  assert.equal(get("veh-gunner-seated").hints.prop.type, "joystick");
});

test("veh-airliner-passenger and veh-passenger-sleeping: the economy seat at 105 degrees with forearms on the arm rests, and the 125 degree seat with the head resting on its side", () => {
  each("veh-airliner-passenger", (m, r, w) => {
    within(m.thoraxInclination, -20, -8, `${w}: upper trunk about 12 deg back on a 105 deg seat`);
    within(m.kneeAngle_L, 85, 100, `${w}: knees at about 90 deg`);
    within(m.handHeightAboveFloor_L - m.seatHeight, 0.1, 0.28, `${w}: forearms on the arm rests, 0.2 m above the sit bones`);
    above(Math.abs(r.lm("palm_centre_L").x), 0.18, `${w}: the hands are beside the hips`);
    within(m.neckFlexion, 0, 15, `${w}: the head rests on the head rest`);
    assert.equal(m.legSupport, "both");
  });
  const r125 = all("sit-recline-125");
  each("veh-passenger-sleeping", (m, r, w) => {
    const label = w.split(" on the ")[1];
    below(m.headTilt, -12, `${w}: the head leans to the right, toward the window`);
    below(m.neckSideBend, -12, `${w}: by lateral flexion of the neck`);
    within(m.thoraxInclination, -40, -28, `${w}: reclined 125 deg`);
    near(m.thoraxInclination, r125[label].thoraxInclination, 4, `${w}: the same seat back as sit-recline-125`);
    above(Math.abs(m.neckTwist), 5, `${w}: and turned a little`);
    below(m.handHeightAboveFloor_L - m.seatHeight, 0.45, `${w}: the hands are in the lap`);
  });
  assert.equal(get("veh-passenger-sleeping").hints.prop.params.recline, 125);
});

test("veh-brace-position: bent forward over the thighs about 65 degrees, head down, arms down by the lower legs, feet flat (the FAA research position)", () => {
  each("veh-brace-position", (m, r, w) => {
    above(m.thoraxInclination, 55, `${w}: the upper trunk is bent far forward`);
    above(m.trunkInclination, 35, `${w}: and so is the hip to C7 chord`);
    above(m.neckFlexion, 45, `${w}: the chin is down`);
    below(m.handHeightAboveFloor_L, m.kneeHeight_L, `${w}: the hands are lower than the knees: at the lower legs`);
    below(dist(r.lm("palm_centre_L"), r.lm("shin_L")), 0.25, `${w}: the left hand is on the shin`);
    assert.equal(m.legSupport, "both", `${w}: feet flat on the floor`);
    within(m.thighInclination_L, -9, 5, `${w}: the thighs are about level`);
  });
  const p = get("veh-brace-position");
  assert.match(p.source, /FAA/); assert.equal(p.hints.props[0].role, "target", "the seat in front is named");
});

test("the added postures flag what they claim (metrics.js ergonomicFlags): neck flexion of the phone and the lap, the arm above the head, the brace", async () => {
  const { ergonomicFlags } = await import("../../site/js/human/metrics.js");
  const flag = (id, label, support, key) => ergonomicFlags(measure(BODIES[label], get(id)).m, support).find((f) => f.id === key);
  for (const label of Object.keys(BODIES)) {
    assert.equal(flag("sit-smartphone", label, { trunkSupport: true }, "neck-flexion").severity, "high", `${label}: phone: neck flexion 55 deg is beyond the conditional band`);
    assert.notEqual(flag("sit-laptop-on-lap", label, { trunkSupport: true }, "neck-flexion").severity, "ok", `${label}: laptop on the lap`);
    assert.equal(flag("veh-flight-deck-overhead-reach", label, {}, "upper-arm-elevation-R").severity, "high", `${label}: the raised arm is in the top band`);
    assert.equal(flag("veh-brace-position", label, {}, "neck-flexion").severity, "high", `${label}: brace`);
  }
  assert.equal(flag("sit-high-stool-bench-work", "P50 man", { trunkSupport: true }, "trunk-inclination").severity, "ok", "bench work: 15 deg is inside the 0 to 20 band");
});

test("the ergonomic flags agree with what the postures claim (metrics.js ergonomicFlags / ISO 11226 trunk, neck, arm bands)", async () => {
  const { ergonomicFlags } = await import("../../site/js/human/metrics.js");
  const flag = (id, label, support, key) => ergonomicFlags(measure(BODIES[label], get(id)).m, support).find((f) => f.id === key);
  assert.equal(flag("sit-upright-90", "P50 man", { trunkSupport: false }, "trunk-inclination").severity, "ok");
  assert.equal(flag("sit-recline-115", "P50 man", { trunkSupport: true }, "trunk-inclination").severity, "ok");
  assert.notEqual(flag("sit-recline-115", "P50 man", { trunkSupport: false }, "trunk-inclination").severity, "ok", "leaning back without support is not recommended");
  assert.notEqual(flag("sit-lean-forward-desk", "P50 man", { trunkSupport: false }, "trunk-inclination").severity, "ok", "20 degrees forward is the upper edge, 20.x goes to step 2");
  assert.equal(flag("sit-lean-forward-desk", "P50 man", { trunkSupport: true }, "trunk-inclination").severity, "ok", "with the forearms on the desk (full trunk support) it is acceptable");
  assert.equal(flag("sit-typing", "P50 man", {}, "wrist-flexion-L").severity, "ok");
  assert.equal(flag("sit-tablet", "P50 man", { trunkSupport: true }, "neck-flexion").severity, "caution", "tablet reading: neck flexion 30 degrees is in the conditional band 25 to 40");
  assert.equal(flag("sit-typing", "P50 man", { trunkSupport: false }, "neck-flexion").severity, "ok", "screen work: neck flexion 16 degrees is in the 0 to 25 band");
});
