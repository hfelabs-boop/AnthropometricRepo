// Semantic tests of the two posture groups "Leaning" (site/js/human/postures/leaning.js) and "Holding" (holding.js): what each posture MEANS, measured with
// metrics.js on three bodies (5th-percentile woman, median man, 95th-percentile man of the US Army populations), on top of the structure rules and the validator
// (which postures.test.mjs also runs for the whole library on six bodies, the heavy man included).
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/postures-leaning-holding.test.mjs"
// A tolerance has a reason: a literature range where there is one (ISO 11226 trunk classes: below 20 degrees acceptable, 20 to 60 only with support, above 60 not
// recommended; REBA / RULA bands for elbows and wrists), else the posture's own name (a 45 degree bench lean leans 45 degrees, a hand "at the ear" is within 0.14 m of the tragion).
// The values were measured on the postures first and the bounds set around them with a margin; a failing line says which quantity and which body.
// What these tests cannot check: where the prop is (the library holds no positions, only hints.prop with a note), that the hand closes on the real grip (the sandbox does that
// with ik.js), and that the contact planes of the leaning postures coincide on all bodies: they are checked per body, on the landmarks that touch the wall.
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
import leaning from "../../site/js/human/postures/leaning.js";
import holding from "../../site/js/human/postures/holding.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = { "P5 woman": army("F", 5), "P50 man": army("M", 50), "P95 man": army("M", 95) };
const ALL = [...leaning, ...holding];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));
const get = (id) => { const p = BY_ID.get(id); assert.ok(p, `no posture ${id}`); return p; };

// ---- measuring ---------------------------------------------------------------------------------------------------------------------------------------------
function measure(body, p) {
  const e = expandPosture(p), pose = { root: e.root, angles: e.angles }, root = placePose(body, pose, { posture: p });
  const lm = (id) => landmarkPosition(body, pose, root, id).clone();
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
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** horizontal position of a landmark in the figure's own frame (the pelvis heading frame of metrics.js): forward and left, from the middle of the two heel points */
function frame(r, id, m) {
  const h = (m.bodyHeading * Math.PI) / 180, f = { x: Math.sin(h), z: Math.cos(h) }, l = { x: Math.cos(h), z: -Math.sin(h) };
  const a = r.lm("heel_sole_L"), b = r.lm("heel_sole_R"), q = r.lm(id), mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  return { fwd: (q.x - mx) * f.x + (q.z - mz) * f.z, left: (q.x - mx) * l.x + (q.z - mz) * l.z, up: q.y };
}

// ---- structure -----------------------------------------------------------------------------------------------------------------------------------------------
test("the two groups hold at least 44 postures between them (46 now), with the lean- and hold- prefixes, unique ids and the right category", () => {
  assert.ok(ALL.length >= 44, `${ALL.length} postures`);
  assert.ok(leaning.length >= 14 && holding.length >= 28, `${leaning.length} leaning, ${holding.length} holding`);
  const ids = ALL.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate ids: " + ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
  for (const p of leaning) { assert.match(p.id, /^lean-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Leaning", p.id); }
  for (const p of holding) { assert.match(p.id, /^hold-[a-z0-9]+(-[a-z0-9]+)*$/, p.id); assert.equal(p.category, "Holding", p.id); }
  assert.ok(CATEGORIES.some((c) => c.name === "Leaning") && CATEGORIES.some((c) => c.name === "Holding"));
});

test("every posture has a plain name, a description of what it is and what it is for, a source, lower-case tags and a hand grip for each hand", () => {
  for (const p of ALL) {
    assert.ok(p.name.length >= 8 && p.name.length <= 60, `${p.id}: name length ${p.name.length}`);
    assert.ok(p.description.length >= 100 && p.description.length <= 560, `${p.id}: description length ${p.description.length}`);
    assert.ok(/[.]$/.test(p.description), `${p.id}: the description ends with a full stop`);
    assert.ok(p.source.length >= 10, `${p.id}: source`);
    assert.ok(Array.isArray(p.tags) && p.tags.length >= 3 && p.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), `${p.id}: tags ${JSON.stringify(p.tags)}`);
    assert.equal(new Set(p.tags).size, p.tags.length, `${p.id}: duplicate tags`);
    assert.ok(p.grips?.L in GRIPS && p.grips?.R in GRIPS, `${p.id}: grips`);
    assert.equal(p.support, "feet", `${p.id}: standing on the feet; the other support is outside the model`);
    assert.ok(p.tags.includes(p.category === "Leaning" ? "lean" : "hold"), `${p.id}: tagged with its group`);
  }
  for (const p of holding) assert.ok(p.hints?.prop, `${p.id}: a holding posture names the object it holds`);
});

// History: the heavy man of postures.test.mjs (134.6 kg) needs the arms of every posture of these groups out of the trunk by more than the neutral arm is, which is why the arms of
// pistol, drill, shovel, rifle and shield postures are solved with an elbow clearance (see the header of holding.js); the test below has no allowance for any of that on three bodies.
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
test("every posture passes validatePosture on the three bodies, without errors and without warnings", () => {
  const found = problemsOnThreeBodies();
  assert.equal(found.length, 0, found.slice(0, 40).join("\n  "));
});

test("an object a posture names (hints.prop, hints.props) exists in the catalog with its params in range and its grip ids on the right hand", () => {
  const ROLES = new Set(["held", "support", "target"]);
  for (const p of ALL) {
    const hints = p.hints ?? {};
    const objs = [hints.prop, ...(hints.props ?? [])].filter(Boolean);
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
        const params = normalizeParams(o.type, o.params ?? {});
        const grips = t.grips(params, t.dims ? t.dims(params) : undefined);
        for (const [hand, id] of Object.entries(o.grips)) {
          const g = grips.find((x) => x.id === id);
          assert.ok(g, `${p.id}: ${o.type} has no grip ${id} (has ${grips.map((x) => x.id).join(", ")})`);
          assert.ok(g.hand === hand || g.hand === "both", `${p.id}: grip ${id} is for the ${g.hand} hand, listed for ${hand}`);
        }
      }
    }
  }
  for (const p of ALL) if (p.hints?.externalSupport) assert.ok(p.hints.prop || p.hints.props || p.id === "lean-stoop-hands-knees", `${p.id}: external support "${p.hints.externalSupport}" names no object`);
  // a held object with a catalog grip lists it for the hand that holds it
  for (const p of holding) {
    const o = p.hints.prop;
    if (o.role !== "held") continue;
    const params = normalizeParams(o.type, o.params ?? {});
    const t = byType(o.type), grips = t.grips(params, t.dims ? t.dims(params) : undefined);
    if (grips.length) assert.ok(o.grips && Object.keys(o.grips).length, `${p.id}: ${o.type} has grips, the posture says which hand takes which`);
  }
  // the leaning postures name what they lean on and say where it is for the median man (distance, height)
  for (const p of leaning.filter((x) => x.hints?.prop)) assert.match(p.hints.prop.note, /\d[.,]?\d* ?m/, `${p.id}: the note of the support says where it is, in metres`);
});

test("a held mass is declared as a load that matches the mass of the object (crate, toolbox, rifle, drill ...), and the balance rule is not waived for it", () => {
  const checks = { "hold-box-chest": 10, "hold-box-waist": 10, "hold-box-overhead": 5, "hold-bag-side": 8 };
  for (const [id, kg] of Object.entries(checks)) {
    const p = get(id);
    assert.equal(p.hints.load?.mass, kg, `${id}: hints.load.mass`);
    assert.equal(p.hints.prop.params.mass, kg, `${id}: the prop's mass is the load`);
    assert.ok(!p.hints.dynamic && !p.hints.externalSupport, `${id}: a carried load is balanced by the body, nothing outside carries it`);
  }
  for (const id of ["hold-pistol-isosceles", "hold-pistol-weaver", "hold-rifle-shouldered-aim", "hold-rifle-low-ready", "hold-rifle-high-ready"]) assert.ok(get(id).hints.load?.mass >= 1, `${id}: the weight of the weapon is in the balance`);
  // the load is in the centre of mass: with it the margin differs from the one without (10 kg held 0.3 m in front of the heels moves the point by 3 cm)
  const body = BODIES["P50 man"], p = get("hold-box-chest"), noLoad = { ...p, hints: { ...p.hints, load: undefined } };
  const a = validatePosture(body, p, {}).metrics.balanceMargin, b = validatePosture(body, noLoad, {}).metrics.balanceMargin;
  above(Math.abs(a - b), 0.015, "the 10 kg box at the chest changes the balance margin by more than 15 mm");
});

test("symmetric postures are symmetric, asymmetric ones are not (the tags tell the truth)", () => {
  const pairs = ["elbowAngle", "shoulderElevation", "kneeAngle", "hipAngle", "handHeightAboveFloor", "thighInclination", "wristFlexion", "ankleAngle"];
  for (const p of ALL) {
    const sym = p.tags.includes("symmetric"), asym = p.tags.includes("asymmetric");
    assert.ok(!(sym && asym), `${p.id} is tagged both symmetric and asymmetric`);
    const m = measure(BODIES["P50 man"], p).m;
    let worst = 0;
    for (const k of pairs) { const a = m[`${k}_L`], b = m[`${k}_R`]; if (typeof a === "number" && typeof b === "number") worst = Math.max(worst, k === "handHeightAboveFloor" ? Math.abs(a - b) * 100 : Math.abs(a - b)); }
    worst = Math.max(worst, Math.abs(m.trunkInclinationSide ?? 0), Math.abs(m.trunkTwist ?? 0), Math.abs(m.headTilt ?? 0));
    if (sym) assert.ok(worst < 3, `${p.id}: tagged symmetric, the sides differ by ${worst.toFixed(1)} (degrees, or cm for the hands)`);
    if (asym) assert.ok(worst > 4, `${p.id}: tagged asymmetric, the sides differ by only ${worst.toFixed(1)}`);
  }
});

test("mirroring an asymmetric posture exchanges its sides (the left-handed version exists for free)", () => {
  for (const id of ["lean-shoulder-wall-left", "lean-door-frame", "hold-bag-side", "hold-handset-ear", "hold-pistol-one-hand"]) {
    const p = get(id), body = BODIES["P50 man"];
    const a = measure(body, p), e = expandPosture(p);
    const mir = mirrorPose({ root: e.root, angles: e.angles });
    const root = placePose(body, mir, { posture: p }), b = postureMetrics(body, mir, root);
    for (const k of ["handHeightAboveFloor", "elbowAngle", "shoulderElevation"]) {
      near(b[`${k}_L`], a.m[`${k}_R`], k.startsWith("hand") ? 0.01 : 1.0, `${id} mirrored ${k}_L`);
      near(b[`${k}_R`], a.m[`${k}_L`], k.startsWith("hand") ? 0.01 : 1.0, `${id} mirrored ${k}_R`);
    }
    near(b.trunkLateralFlexion, -a.m.trunkLateralFlexion, 0.5, `${id} mirrored lateral flexion`);
  }
});

// ---- leaning: the support is where the contact landmarks are ------------------------------------------------------------------------------------------------
const LATERAL_ANKLE = ["lateral_malleolus_L", "trochanterion_L", "epicondyle_lateral_L", "euryon_L", "tragion_L", "acromion_L"];

test("lean-back-wall: the shoulder blades and the buttocks touch one vertical plane behind the figure, the feet a foot or more in front of it, the trunk upright", () => {
  each("lean-back-wall", (m, r, w) => {
    const sb = frame(r, "scapula_back_L", m).fwd, bt = frame(r, "buttock_extremity", m).fwd, head = frame(r, "opisthocranion", m).fwd;
    near(sb, bt, 0.08, `${w}: shoulder blade and buttock in one plane (${f1(sb)} and ${f1(bt)} m in front of the heels; a woman's buttocks protrude 4 to 7 cm further than the model's median man's, so her wall touches them first)`);
    within(-(sb + bt) / 2, 0.25, 0.45, `${w}: the wall is 0.25 to 0.45 m behind the heels`);
    within(head - (sb + bt) / 2, 0.0, 0.12, `${w}: the back of the head is within 12 cm of the wall plane (the cervical lordosis keeps it off the wall)`);
    within(m.trunkInclination, -8, 5, `${w}: trunk upright (ISO 11226: below 20 degrees)`);
    above(frame(r, "heel_sole_L", m).fwd - sb, 0.25, `${w}: the heels are well ahead of the shoulder blades`);
    above(m.hipAngle_L, 145, `${w}: legs only slightly flexed at the hip`);
    below(m.comOverBase, -0.05, `${w}: the centre of mass is behind the feet, the wall carries the difference`);
  });
});

test("lean-hip-desk: the buttocks on the edge of a high desk, legs forward, arms folded", () => {
  each("lean-hip-desk", (m, r, w) => {
    const bt = frame(r, "buttock_extremity", m);
    within(-bt.fwd, 0.22, 0.45, `${w}: the desk edge is behind the heels`);
    within(bt.up, 0.7, 0.95, `${w}: the buttocks rest on a desk or counter of 0.75 to 0.9 m`);
    within(m.elbowAngle_L, 50, 90, `${w}: the forearms are folded across the chest`);
    within(m.elbowAngle_R, 50, 90, `${w}: the forearms are folded across the chest`);
    below(dist(r.lm("palm_centre_L"), r.lm("olecranon_R")), 0.2, `${w}: the left hand is on the right arm`);
    below(m.comOverBase, -0.05, `${w}: the desk carries part of the weight`);
  });
});

test("lean-forearm-counter, lean-forearms-rail, lean-workbench-forearms-45: the forearms lie on a surface (elbow and hand at one height), the trunk inclined as named", () => {
  each("lean-forearm-counter", (m, r, w) => {
    within(m.trunkInclination, 8, 20, `${w}: about 15 degrees (ISO 11226: below 20 degrees)`);
    near(r.lm("olecranon_L").y, r.lm("palm_centre_L").y, 0.04, `${w}: the left forearm is horizontal`);
    within(r.lm("olecranon_L").y, m.hipHeight + 0.1, m.eyeHeight - 0.35, `${w}: the counter is at elbow height`);
    below(dist(r.lm("palm_centre_R"), r.lm("iliocristale_R")), 0.12, `${w}: the right hand is on the hip`);
    above(m.elbowAngle_R, 0, `${w}: right arm`);
  });
  each("lean-forearms-rail", (m, r, w) => {
    within(m.trunkInclination, 15, 30, `${w}: about 22 degrees (ISO 11226: 20 to 60 only with the trunk supported through the arms)`);
    near(r.lm("olecranon_L").y, r.lm("olecranon_R").y, 0.025, `${w}: both elbows on the same rail`);
    near(r.lm("olecranon_L").y, r.lm("palm_centre_L").y, 0.04, `${w}: forearms horizontal`);
    within(m.elbowAngle_L, 85, 135, `${w}: elbow`);
    above(m.handToShoulderForward_L, 0.3, `${w}: the hands are well ahead of the shoulders`);
  });
  each("lean-workbench-forearms-45", (m, r, w) => {
    near(m.trunkInclination, 45, 5, `${w}: the 45 degrees of the name`);
    near(r.lm("olecranon_L").y, r.lm("palm_centre_L").y, 0.04, `${w}: forearms horizontal on the bench`);
    above(m.kneeAngle_L, 165, `${w}: knees straight`);
    above(m.hipAngle_L, 125, `${w}: hips`);
    below(m.hipAngle_L, 150, `${w}: bent at the hips`);
    below(m.comOverBase, -0.01, `${w}: the bench carries part of the weight`);
  });
  const a = all("lean-forearm-counter"), b = all("lean-forearms-rail"), c = all("lean-workbench-forearms-45");
  for (const label of Object.keys(BODIES)) { below(a[label].trunkInclination, b[label].trunkInclination - 3, `${label}: counter lean < rail lean`); below(b[label].trunkInclination, c[label].trunkInclination - 10, `${label}: rail lean < bench lean`); }
});

test("lean-stoop-hands-knees: knees bent, trunk about 50 degrees forward, both hands on the knees", () => {
  each("lean-stoop-hands-knees", (m, r, w) => {
    within(m.trunkInclination, 38, 58, `${w}: trunk (ISO 11226: above 60 is not recommended)`);
    within(180 - m.kneeAngle_L, 35, 70, `${w}: knee flexion`);
    for (const s of ["L", "R"]) below(dist(r.lm(`palm_centre_${s}`), r.lm(`knee_top_${s}`)), 0.22, `${w}: the ${s} hand is on its knee`);
    within(m.elbowAngle_L, 100, 150, `${w}: arms only slightly bent`);
    above(m.comOverBase, -0.02, `${w}: the body stands on its feet, the arms only prop it`);
  });
});

test("lean-side-hand-wall-left, lean-shoulder-wall-left, lean-door-frame: sideways lean toward the wall or the jamb, the touching landmark is the outermost", () => {
  each("lean-side-hand-wall-left", (m, r, w) => {
    within(m.trunkLateralFlexion, 12, 28, `${w}: lateral flexion to the left (ISO 11226 asks for none when held: this is a lean)`);
    const palm = r.lm("palm_centre_L"), eye = m.eyeHeight;
    within(palm.y, eye - 0.25, eye + 0.1, `${w}: the hand on the wall is at head height`);
    within(m.shoulderElevation_L, 65, 100, `${w}: the arm is out to the side`);
    below(dist(r.lm("palm_centre_R"), r.lm("iliocristale_R")), 0.12, `${w}: the right hand on the hip`);
    const palmLeft = frame(r, "palm_centre_L", m).left;
    above(palmLeft, Math.max(...LATERAL_ANKLE.map((l) => frame(r, l, m).left)) + 0.1, `${w}: the palm is farther to the left than every other landmark: it touches the wall`);
  });
  each("lean-shoulder-wall-left", (m, r, w) => {
    within(m.trunkLateralFlexion, 10, 22, `${w}: bent to the left`);
    const d = frame(r, "deltoid_L", m).left;
    for (const l of LATERAL_ANKLE.filter((x) => x !== "acromion_L")) above(d, frame(r, l, m).left - 0.01, `${w}: the left deltoid is the outermost left landmark (${l})`);
    below(m.shoulderElevation_L, 40, `${w}: the arm is not out: it is held against the side or forward`);
    below(dist(r.lm("palm_centre_R"), r.lm("trochanterion_R")), 0.25, `${w}: the right hand is in a pocket (near the right thigh)`);
  });
  each("lean-door-frame", (m, r, w) => {
    within(m.trunkLateralFlexion, -22, -10, `${w}: bent to the right, toward the jamb`);
    const d = frame(r, "deltoid_R", m).left;
    for (const l of ["trochanterion_R", "epicondyle_lateral_R", "euryon_R", "tragion_R"]) below(d, frame(r, l, m).left + 0.01, `${w}: the right deltoid is the outermost right landmark (${l})`);
    within(m.elbowAngle_L, 50, 90, `${w}: arms folded`);
    above(frame(r, "heel_sole_L", m).fwd - frame(r, "heel_sole_R", m).fwd, 0.04, `${w}: the left foot is crossed in front of the right`);
    below(Math.abs(frame(r, "heel_sole_R", m).left - frame(r, "heel_sole_L", m).left), 0.3, `${w}: the feet are close together (the stance is narrow)`);
  });
  // mirrorPose gives the other side
  const body = BODIES["P50 man"], p = get("lean-shoulder-wall-left"), e = expandPosture(p), mir = mirrorPose({ root: e.root, angles: e.angles });
  const root = placePose(body, mir, { posture: p });
  near(postureMetrics(body, mir, root).trunkLateralFlexion, -16, 3, "mirrored: bent to the right");
});

test("lean-forward-hands-table, lean-push-wall, lean-one-hand-wall, lean-one-arm-high-wall, lean-chair-back-hands: the hands are on the support, at the height and distance the name says", () => {
  each("lean-forward-hands-table", (m, r, w) => {
    within(m.trunkInclination, 33, 48, `${w}: about 40 degrees (ISO 11226: 20 to 60 only with the trunk supported through the arms)`);
    near(r.lm("palm_centre_L").y, r.lm("palm_centre_R").y, 0.02, `${w}: both hands on the table`);
    within(r.lm("palm_centre_L").y, 0.6, 0.85, `${w}: a table of 0.6 to 0.85 m`);
    above(m.elbowAngle_L, 140, `${w}: arms nearly straight`);
    above(m.handToShoulderForward_L, 0.25, `${w}: hands ahead of the shoulders`);
    above(m.neckFlexion, 10, `${w}: the head forward to look at the table`);
  });
  each("lean-push-wall", (m, r, w) => {
    within(m.trunkInclination, 15, 30, `${w}: about 22 degrees`);
    near(frame(r, "palm_centre_L", m).fwd, frame(r, "palm_centre_R", m).fwd, 0.03, `${w}: both palms in one plane: the wall`);
    within(frame(r, "palm_centre_L", m).fwd, 0.7, 1.25, `${w}: the wall is 0.7 to 1.25 m ahead of the heels`);
    within(r.lm("palm_centre_L").y, m.eyeHeight - 0.5, m.eyeHeight - 0.15, `${w}: hands at about shoulder height`);
    within(m.kneeAngle_L, 110, 150, `${w}: the front (left) knee is bent`);
    above(m.kneeAngle_R, 168, `${w}: the rear leg is straight`);
    above(frame(r, "heel_sole_L", m).fwd, frame(r, "heel_sole_R", m).fwd + 0.08, `${w}: left foot forward`);
    below(m.comOverBase, -0.03, `${w}: without the wall the figure would fall forward`);
  });
  each("lean-one-hand-wall", (m, r, w) => {
    within(m.trunkInclination, 5, 16, `${w}: about 10 degrees`);
    const palm = r.lm("palm_centre_R");
    within(palm.y - (m.eyeHeight - 0.15), 0.0, 0.3, `${w}: the right hand is a little above shoulder height`);
    below(m.shoulderElevation_L, 30, `${w}: the left arm hangs`);
    above(m.handToShoulderForward_R, 0.3, `${w}: the hand is ahead of the shoulder`);
  });
  each("lean-one-arm-high-wall", (m, r, w) => {
    within(m.trunkInclination, 8, 20, `${w}: about 15 degrees`);
    above(r.lm("palm_centre_L").y, m.eyeHeight - 0.1, `${w}: the hand is at head height or above`);
    above(m.shoulderElevation_L, 85, `${w}: the arm is raised to or above the horizontal`);
    below(dist(r.lm("palm_centre_R"), r.lm("iliocristale_R")), 0.12, `${w}: the right hand is on the hip`);
  });
  each("lean-chair-back-hands", (m, r, w) => {
    within(m.trunkInclination, 15, 30, `${w}: about 22 degrees`);
    near(r.lm("palm_centre_L").y, r.lm("palm_centre_R").y, 0.02, `${w}: both hands on the top of the back rest`);
    within(r.lm("palm_centre_L").y, 0.8, 1.05, `${w}: a back rest top of 0.8 to 1.05 m`);
    above(m.handToShoulderForward_L, 0.25, `${w}: hands ahead of the shoulders`);
  });
  // the push is the larger and the lower of the lean angles: parameterless, but ordered
  const a = all("lean-one-hand-wall"), b = all("lean-push-wall");
  for (const label of Object.keys(BODIES)) above(b[label].trunkInclination, a[label].trunkInclination + 6, `${label}: pushing with both hands leans more than a hand on the wall`);
});

test("lean-arched-back: the spine in extension, the head tipped back, the hands on the hips, standing on its own feet", () => {
  each("lean-arched-back", (m, r, w) => {
    below(m.trunkInclination, -12, `${w}: trunk leaning back`);
    below(m.lumbarFlexion, -15, `${w}: lumbar extension`);
    below(m.thoracicFlexion, -8, `${w}: thoracic extension`);
    above(m.gazeElevation, 20, `${w}: the face turned up`);
    below(dist(r.lm("palm_centre_L"), r.lm("iliocristale_L")), 0.12, `${w}: the left hand on the hip`);
    above(m.comOverBase, 0.02, `${w}: no support from outside: the centre of mass is over the feet`);
  });
  assert.ok(!get("lean-arched-back").hints?.externalSupport, "nothing outside carries the arched back");
});

// ---- holding: the hands are where the object is ------------------------------------------------------------------------------------------------------------
test("hold-box-chest, hold-box-waist, hold-box-overhead: a family ordered by hand height, the box held with both hands, the load in the balance", () => {
  const chest = all("hold-box-chest"), waist = all("hold-box-waist"), over = all("hold-box-overhead");
  for (const [label, body] of Object.entries(BODIES)) {
    below(waist[label].handHeightAboveFloor_L, chest[label].handHeightAboveFloor_L - 0.12, `${label}: waist below chest`);
    above(over[label].handHeightAboveFloor_L, chest[label].handHeightAboveFloor_L + 0.4, `${label}: overhead above chest`);
    near(chest[label].handHeightAboveFloor_L, chest[label].handHeightAboveFloor_R, 0.02, `${label}: both hands carry the box level`);
    within(chest[label].eyeHeight - chest[label].handHeightAboveFloor_L, 0.3, 0.55, `${label}: the hands are 0.3 to 0.55 m below the eyes at the chest`);
    within(waist[label].handHeightAboveFloor_L / waist[label].hipHeight, 0.9, 1.25, `${label}: the waist-height box is carried at hip level`);
    assert.ok(over[label].handAboveHead_L && over[label].handAboveHead_R, `${label}: overhead means above the head`);
    above(over[label].shoulderElevation_L, 100, `${label}: arms raised (ISO 11226: above 60 is not recommended for long)`);
    above(chest[label].comOverBase, 0.04, `${label}: chest box, the load in the hands, the body stays balanced`);
  }
  each("hold-box-chest", (m, r, w) => {
    within(m.elbowAngle_L, 45, 85, `${w}: elbows flexed about 120 degrees`);
    near(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.34, 0.1, `${w}: the palms are on the sides of a 0.34 m box`);
    within(frame(r, "palm_centre_L", m).fwd - frame(r, "chest_front", m).fwd, 0.1, 0.35, `${w}: the box is in front of the chest`);
  });
  each("hold-box-waist", (m, r, w) => {
    near(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.4, 0.1, `${w}: the palms are on the sides of a 0.4 m box`);
    within(m.elbowAngle_L, 90, 140, `${w}: forearms about horizontal, elbows flexed 40 to 90 degrees`);
  });
});

test("hold-bag-side: one hand carries a toolbox beside the leg, the trunk leans away from it, the other arm counterbalances", () => {
  each("hold-bag-side", (m, r, w) => {
    below(m.handHeightAboveFloor_R, m.hipHeight + 0.08, `${w}: the carrying hand is at the level of the hip or below (the handle is 0.8 m high for the median man, 0.73 m for the small woman, whose hip is at 0.71 m)`);
    above(m.elbowAngle_R, 160, `${w}: the carrying arm is straight`);
    within(m.trunkLateralFlexion, 2, 8, `${w}: leaning to the left, away from the load in the right hand`);
    above(m.shoulderElevation_L, 8, `${w}: the left arm is out a little`);
    below(frame(r, "palm_centre_R", m).left, -0.12, `${w}: the hand is to the right of the mid-line`);
  });
});

test("hold-hammer-ready, hold-drill-forward, hold-screwdriver-forward, hold-flashlight-forward, hold-cup, hold-joystick, hold-lever-pull: the right hand in front of the body, the left free", () => {
  const spec = {
    "hold-hammer-ready": { up: [-0.5, -0.1], fwd: [0.1, 0.5], elbow: [55, 85] },
    "hold-drill-forward": { up: [-0.35, 0.1], fwd: [0.25, 0.65], elbow: [60, 110] },
    "hold-screwdriver-forward": { up: [-0.35, 0.05], fwd: [0.2, 0.55], elbow: [60, 100] },
    "hold-flashlight-forward": { up: [-0.35, 0.05], fwd: [0.15, 0.5], elbow: [45, 90] },
    "hold-cup": { up: [-0.55, -0.1], fwd: [0.15, 0.55], elbow: [65, 100] },
    "hold-joystick": { up: [-0.55, -0.1], fwd: [0.2, 0.6], elbow: [90, 130] },
    "hold-lever-pull": { up: [-0.6, -0.1], fwd: [0.2, 0.65], elbow: [70, 110] },
  };
  for (const [id, s] of Object.entries(spec)) {
    each(id, (m, r, w) => {
      within(m.handToShoulderUp_R, s.up[0], s.up[1], `${w}: right hand height relative to the shoulder joint`);
      within(m.handToShoulderForward_R, s.fwd[0], s.fwd[1], `${w}: right hand ahead of the shoulder joint`);
      within(m.elbowAngle_R, s.elbow[0], s.elbow[1], `${w}: right elbow`);
      above(m.elbowAngle_L, 145, `${w}: left arm hangs`);
      below(m.shoulderElevation_L, 30, `${w}: left arm hangs`);
    });
  }
  each("hold-lever-pull", (m, r, w) => below(m.trunkInclination, -1.5, `${w}: tilted back against the pull`));
});

test("hold-shovel-waist, hold-wheel-standing, hold-tray, hold-shield-forward: two hands in front of the body at the height the object is", () => {
  each("hold-shovel-waist", (m, r, w) => {
    above(m.handToShoulderForward_R, 0.15, `${w}: the right hand is in front of the shoulder`);
    below(m.handToShoulderUp_R, -0.3, `${w}: at the waist, well below the shoulder`);
    below(m.handToShoulderUp_L, -0.3, `${w}: the left hand too`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.7, `${w}: the hands are on one tool`);
  });
  each("hold-wheel-standing", (m, r, w) => {
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.02, `${w}: hands at nine and three are at one height`);
    within(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.3, 0.55, `${w}: the hands are on a rim of 0.45 m`);
    within(m.handToShoulderUp_L, -0.3, 0.0, `${w}: the wheel centre is at chest height`);
    within(m.elbowAngle_L, 80, 120, `${w}: elbows`);
  });
  each("hold-tray", (m, r, w) => {
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.02, `${w}: the tray is level`);
    within(m.handHeightAboveFloor_L / m.hipHeight, 0.9, 1.3, `${w}: a tray at about waist height`);
    within(m.elbowAngle_L, 100, 140, `${w}: elbows (REBA lower arm: 60 to 100 degrees of flexion is the good band, 40 to 80 here)`);
    within(m.wristFlexion_L, -15, 45, `${w}: wrists`);
  });
  each("hold-shield-forward", (m, r, w) => {
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.02, `${w}: handles at one height`);
    within(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.15, 0.4, `${w}: the handles are about 0.26 m apart`);
    within(m.elbowAngle_L, 70, 110, `${w}: elbows at a right angle`);
  });
});

test("hold-grab-handle, hold-bar-overhead, hold-handrail-side: the hands on a fixed support, placed where the support is", () => {
  each("hold-grab-handle", (m, r, w) => {
    above(m.handToShoulderForward_R, 0.4, `${w}: the handle is an arm's length ahead of the shoulder`);
    within(m.handToShoulderUp_R, -0.25, 0.0, `${w}: at chest height, a little below the shoulder joint`);
    below(m.trunkInclination, -2, `${w}: leaning back against the pull`);
    within(m.elbowAngle_R, 115, 160, `${w}: the arm is bent about 50 degrees`);
    assert.ok(get("hold-grab-handle").hints.externalSupport, "the handle carries weight");
  });
  each("hold-bar-overhead", (m, r, w) => {
    assert.ok(m.handAboveHead_L && m.handAboveHead_R, `${w}: both hands above the head`);
    above(m.shoulderElevation_L, 130, `${w}: arms raised`);
    above(m.elbowAngle_L, 135, `${w}: arms nearly straight`);
    within(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.3, 0.65, `${w}: hands 0.3 to 0.65 m apart on the bar`);
    near(m.handHeightAboveFloor_L, m.handHeightAboveFloor_R, 0.03, `${w}: one bar`);
  });
  each("hold-handrail-side", (m, r, w) => {
    within(m.handHeightAboveFloor_R / m.hipHeight, 0.8, 1.1, `${w}: the rail is at hip height`);
    below(frame(r, "palm_centre_R", m).left, -0.15, `${w}: the rail is out to the right`);
    below(m.shoulderElevation_L, 30, `${w}: the left arm hangs`);
  });
});

test("hold-handset-ear, hold-handset-mouth, hold-binoculars, hold-tablet, hold-clipboard: the object is at the head (distances measured from the landmarks)", () => {
  each("hold-handset-ear", (m, r, w) => {
    below(dist(r.lm("palm_centre_R"), r.lm("tragion_R")), 0.16, `${w}: the right hand is at the right ear`);
    below(m.elbowAngle_R, 60, `${w}: the elbow is bent about 140 degrees`);
    above(m.handHeightAboveFloor_R, m.eyeHeight - 0.15, `${w}: hand at ear height`);
  });
  each("hold-handset-mouth", (m, r, w) => {
    below(dist(r.lm("palm_centre_R"), r.lm("stomion")), 0.2, `${w}: the right hand is at the mouth`);
    below(m.elbowAngle_R, 70, `${w}: forearm raised`);
  });
  each("hold-binoculars", (m, r, w) => {
    for (const s of ["L", "R"]) below(dist(r.lm(`palm_centre_${s}`), r.lm("eye_mid")), 0.22, `${w}: the ${s} hand is at the eyes`);
    within(m.elbowAngle_L, 50, 85, `${w}: elbows bent`);
    near(m.gazeElevation, 0, 8, `${w}: looking straight ahead`);
  });
  each("hold-tablet", (m, r, w) => {
    within(m.neckFlexion, 8, 24, `${w}: the neck flexed to look down (ISO 11226: 20 degrees or more is a load on the neck)`);
    below(m.gazeElevation, -25, `${w}: the line of sight goes down to the screen`);
    within(m.eyeHeight - m.handHeightAboveFloor_L, 0.25, 0.55, `${w}: the tablet is 0.25 to 0.55 m below the eyes`);
    near(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.28, 0.1, `${w}: the hands are on the two edges of a 12.9 inch tablet`);
  });
  each("hold-clipboard", (m, r, w) => {
    within(m.neckFlexion, 5, 25, `${w}: looking down at the board`);
    below(m.gazeElevation, -25, `${w}: the line of sight goes down to the board`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.32, `${w}: the writing hand is on the board held by the other`);
    within(m.handHeightAboveFloor_L / m.eyeHeight, 0.55, 0.85, `${w}: the board is at chest height`);
  });
});

test("hold-pistol-isosceles, hold-pistol-weaver, hold-pistol-one-hand, hold-pistol-low-ready: the pistol at eye level or at the chest", () => {
  each("hold-pistol-isosceles", (m, r, w) => {
    for (const s of ["L", "R"]) {
      near(m.handHeightAboveFloor_R, m.eyeHeight - 0.1, 0.12, `${w}: hands at eye level (the slide top just below the eye)`);
      above(m.handToShoulderForward_R, 0.38, `${w}: arms extended in front`);
      above(m[`elbowAngle_${s}`], 120, `${w}: nearly straight arms`);
    }
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.12, `${w}: the left hand wraps the right`);
    below(m.kneeAngle_L, 172, `${w}: knees slightly bent`);
    above(frame(r, "heel_sole_L", m).left - frame(r, "heel_sole_R", m).left, 0.2, `${w}: feet apart`);
    near(frame(r, "heel_sole_L", m).fwd, frame(r, "heel_sole_R", m).fwd, 0.04, `${w}: feet square to the target`);
  });
  each("hold-pistol-weaver", (m, r, w) => {
    near(Math.abs(r.root.heading), 30, 3, `${w}: the body is turned 30 degrees from the line of fire`);
    near(m.handHeightAboveFloor_R, m.eyeHeight - 0.1, 0.12, `${w}: hands at eye level`);
    above(frame(r, "heel_sole_L", m).fwd - frame(r, "heel_sole_R", m).fwd, 0.15, `${w}: the left foot is forward of the right`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.12, `${w}: the left hand wraps the right`);
  });
  each("hold-pistol-one-hand", (m, r, w) => {
    near(m.handHeightAboveFloor_R, m.eyeHeight - 0.1, 0.12, `${w}: right hand at eye level`);
    above(m.elbowAngle_R, 140, `${w}: arm nearly straight`);
    above(m.elbowAngle_L, 150, `${w}: the left arm hangs`);
    below(m.shoulderElevation_L, 30, `${w}: the left arm hangs`);
  });
  each("hold-pistol-low-ready", (m, r, w) => {
    within(m.handHeightAboveFloor_R / m.eyeHeight, 0.58, 0.8, `${w}: hands at the chest, not at eye level`);
    below(dist(r.lm("palm_centre_L"), r.lm("palm_centre_R")), 0.17, `${w}: both hands on the pistol`);
    within(m.elbowAngle_R, 60, 115, `${w}: elbows bent and held in`);
  });
  const iso = all("hold-pistol-isosceles"), low = all("hold-pistol-low-ready");
  for (const label of Object.keys(BODIES)) above(iso[label].handHeightAboveFloor_R, low[label].handHeightAboveFloor_R + 0.25, `${label}: the pistol is raised from the low ready to eye level`);
});

test("hold-rifle-shouldered-aim, hold-rifle-low-ready, hold-rifle-high-ready, hold-rifle-sling-carry: right-handed rifle postures ordered by how high the weapon is", () => {
  each("hold-rifle-shouldered-aim", (m, r, w) => {
    within(m.trunkInclination, 8, 25, `${w}: the trunk inclined forward over the rifle (ISO 11226: above 20 needs support, the rifle stock is it)`);
    near(Math.abs(r.root.heading), 45, 3, `${w}: the body turned 45 degrees to the line of fire`);
    above(m.handHeightAboveFloor_R, m.eyeHeight - 0.35, `${w}: the right hand on the grip is at about shoulder height or higher`);
    above(m.handToShoulderForward_L - m.handToShoulderForward_R, 0.1, `${w}: the left hand is ahead of the right (handguard against grip)`);
    above(m.handHeightAboveFloor_L, m.eyeHeight - 0.4, `${w}: the left hand holds the handguard up at the level of the sights`);
    above(frame(r, "heel_sole_L", m).fwd - frame(r, "heel_sole_R", m).fwd, 0.1, `${w}: the left foot is forward`);
    within(m.gazeElevation, -12, 15, `${w}: the sights are looked through, so the line of sight is about level`);
  });
  const aim = all("hold-rifle-shouldered-aim"), low = all("hold-rifle-low-ready"), high = all("hold-rifle-high-ready"), sling = all("hold-rifle-sling-carry");
  for (const label of Object.keys(BODIES)) {
    above(high[label].handHeightAboveFloor_L, low[label].handHeightAboveFloor_L + 0.15, `${label}: the left hand is higher at the high ready than at the low ready`);
    above(aim[label].handHeightAboveFloor_L, high[label].handHeightAboveFloor_L - 0.1, `${label}: the sights are higher than the ready positions`);
    below(sling[label].shoulderElevation_L, 30, `${label}: on the sling the left arm is free`);
    within(sling[label].handHeightAboveFloor_R / sling[label].hipHeight, 0.8, 1.2, `${label}: on the sling the right hand rests on the grip at hip level`);
    above(low[label].elbowAngle_R, 40, `${label}: low ready, right elbow`);
  }
  for (const id of ["hold-rifle-low-ready", "hold-rifle-high-ready"]) each(id, (m, r, w) => {
    above(m.handToShoulderForward_L, 0.2, `${w}: the left hand reaches forward to the handguard`);
    below(Math.abs(m.trunkInclination), 6, `${w}: trunk upright`);
  });
});

test("every posture of these groups stands on the floor: both soles within the validator's tolerance, and a leaning posture would not stand without its support while a holding one does", () => {
  for (const p of ALL) {
    for (const [label, body] of Object.entries(BODIES)) {
      const r = validatePosture(body, p, { library: ALL });
      assert.ok(Math.abs(r.metrics.gaps.feet ?? 0) < 1e-9, `${label}: ${p.id}: the primary carrier touches`);
      if (!p.hints?.externalSupport && !p.hints?.dynamic) assert.ok(r.metrics.balanceMargin > -0.04, `${label}: ${p.id}: balanced without outside help (${f1(r.metrics.balanceMargin)} m)`);
    }
  }
  // the leaning postures that rest on a wall or a table lean so far that the feet alone would not hold them
  let falls = 0;
  for (const id of ["lean-back-wall", "lean-push-wall", "lean-hip-desk", "lean-forward-hands-table"]) {
    const p = get(id), body = BODIES["P50 man"], r = validatePosture(body, { ...p, hints: { ...p.hints, externalSupport: undefined } }, { library: ALL });
    if (r.metrics.balanceMargin < -0.04) falls++;
  }
  assert.ok(falls >= 3, `at least 3 of the 4 wall and table postures need the support (${falls})`);
});
