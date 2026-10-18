// Pose data and what is done with it: expand a posture of the library into joint angles, clamp, mirror, blend, place the posed
// body on its supporting surface(s), centre of mass and balance, and the validator that every posture of the library must pass.
// Contract: docs/human3d/DESIGN.md 2.4, rules: docs/human3d/POSTURES.md, author guide: docs/human3d/POSE.md.
// Pure: three, skeleton.js, fk.js, proxies.js and postures/grips.js only; no DOM.
//
// A POSE is { root: { heading, flex, lat, rot }, angles: { [jointId]: number[] } } (degrees, concrete joint ids, DOF order of skeleton.js):
// what rig.setPose consumes, minus the root position. Joints that are not listed are 0. A POSTURE (the library entry, see the typedef)
// is the author's shorthand for a pose (regions, "_LR" keys, grip presets) plus what carries the weight.
//
// Placement needs a body (fit.js BodyModel, or rig.restBody, which agrees with rig.kin when forearms are pronated). A body is treated as
// immutable: per-body tables (kinematics, landmark index, proxies) are cached on the object and rebuilt when its joints, landmarks,
// contacts or masses object is replaced.
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, expandRegions, expandSides, mirrorId, sideOf } from "./skeleton.js";
import { Kinematics } from "./fk.js";
import { GRIPS, GRIP_NAMES, HAND_JOINTS, gripAngles } from "./postures/grips.js";
import { bodyProxies, proxyWorld, lowestPoint, selfPenetrations } from "./proxies.js";

const nz = (x) => (x === 0 ? 0 : x); // -0 -> 0
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const wrap180 = (d) => { const w = ((((d + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w; }; // (-180, 180]
const mm = (m) => `${(m * 1000).toFixed(m !== 0 && Math.abs(m * 1000) < 10 ? 1 : 0)} mm`;

/**
 * @typedef {object} Posture
 * @property {string} id            kebab-case, unique in the library ("sit-upright-90")
 * @property {string} name          short, plain ("Seated upright (90-90-90)")
 * @property {string} category      the `name` of an entry of CATEGORIES
 * @property {string[]} tags        lower-case words ("seat", "iso-7250", "rifle", ...)
 * @property {string} description   one or two sentences: what it is and what it is for
 * @property {string} source        where the angles come from ("ISO 7250-1 ...") or "illustrative"
 * @property {{heading?: number, flex?: number, lat?: number, rot?: number}} [root]  pelvis orientation, degrees (default 0); never a position
 * @property {{lumbar?: number[], thoracic?: number[], cervical?: number[]}} [spine]  region totals [flex, lat, rot], degrees, relative to the natural standing curvature
 * @property {Object<string, number[]>} [joints]  joint id, or id with the side replaced by "_LR" (both sides, same anatomical values), "_L" or "_R"
 *   (an explicit side overrides "_LR"); values in the joint's DOF order, trailing zeros may be omitted; vertebra ids add on top of the region totals
 * @property {{L?: string, R?: string}} [grips]  hand preset per hand (a key of GRIPS); explicit finger joints in `joints` override it
 * @property {string} support       what carries the weight: a key of SUPPORT_CARRIERS ("feet", "seat", "seat+feet", "knees", "hands-knees", "body", ...)
 * @property {string[]} [contacts]  landmark ids that must touch the support (within 15 mm); the surface is derived from the support
 * @property {{seat?: {height?: number|"popliteal"}, dynamic?: boolean, externalSupport?: boolean|string, contactTolerance?: number, load?: {mass: number, landmarks?: string[]}}} [hints]
 *   seat.height: seat plane in metres (0 = sitting on the floor) or "popliteal" (default: the seat height at which the ISO 7250 posture has the
 *   feet on the floor); dynamic: balance is not checked; externalSupport: something else carries part of the weight (wall, table, rail),
 *   balance and the secondary contacts are not checked; contactTolerance: allowed gap in metres for the secondary contacts (default 0.015, at most 0.04);
 *   load: a held weight in kg (a box, a tool, a rifle) that the balance check adds at the mean position of `landmarks` (default both grip centres)
 */

// ---------------------------------------------------------------------------------------------------------------------
// Library structure
/** The 13 groups of the library in display order. `name` is what `Posture.category` holds. */
export const CATEGORIES = Object.freeze([
  { id: "standing", name: "Standing", blurb: "Upright on both feet or one: neutral, relaxed, at attention, at ease, arms crossed, hands on hips, leaning on one leg, wide stance." },
  { id: "sitting", name: "Sitting", blurb: "On a chair, stool, bench or the floor: upright, reclined, slumped, forward to a desk, cross-legged, kneeling on the heels, driving, typing." },
  { id: "leaning", name: "Leaning", blurb: "Standing with part of the weight on something else: a table, a wall, a rail, a door frame, a workbench." },
  { id: "holding", name: "Holding", blurb: "Hands on an object: a box at chest or waist height, a tool, a tray, a phone, binoculars, a pistol or a rifle in the ready positions." },
  { id: "lifting", name: "Lifting & carrying", blurb: "Squat, stoop and semi-squat lifts (start, middle, end), overhead lifts, carrying in front, at the side and on the shoulder, pushing and pulling." },
  { id: "reaching", name: "Reaching", blurb: "Forward, high, low, lateral, across the body and behind the back, standing and seated, on tiptoe, to the floor." },
  { id: "kneeling", name: "Kneeling & squatting", blurb: "Squats of every depth, half and full kneeling, hands and knees, crawls, lunges, push-up." },
  { id: "lying", name: "Lying", blurb: "Supine, prone, on the side, fetal, with the knees up, on a creeper, with the arms overhead or forward." },
  { id: "locomotion", name: "Locomotion", blurb: "The phases of walking and running, steps and stairs, ladder climbing, jumping and landing, marching." },
  { id: "work", name: "Work", blurb: "Workstation and tool postures, including the RULA and REBA reference postures: overhead work, floor-level work, bent over a bench, welding, crawling." },
  { id: "military", name: "Military", blurb: "Attention, parade rest, salute, firing positions (standing, kneeling, prone, supported), low and high ready, crawls, sprint start, hatch stand." },
  { id: "vehicle", name: "Vehicle & cockpit", blurb: "Driver, passenger and crew postures: hands on the wheel, pedals, seat-belt and mirror reach, entry and exit, stick and throttle." },
  { id: "reference", name: "Reference", blurb: "Measurement and calibration postures: ISO 7250-1 standing and sitting, A-pose, T-pose, Vitruvian, NIOSH lift origin and destination, RULA neutral." },
].map((c) => Object.freeze(c)));

/**
 * Which contact sets carry the weight and on which surface, by `Posture.support`. The FIRST entry is the primary carrier: placement puts
 * its lowest point exactly on its surface. The other entries are checked by the validator (the lowest point of the set within 15 mm above its surface)
 * unless hints.externalSupport. A set is a key of body.contacts (feet, seat, knees, hands, elbows, back, front, side_L, side_R, head) or one of
 * the derived sets toes, heels, palms, shins, kneecaps, or "body" (the lowest points of the body proxies and the landmarks). A surface is a key of the
 * `surfaces` heights ("floor" = 0, "seat" = the seat plane).
 */
export const SUPPORT_CARRIERS = Object.freeze({
  feet: Object.freeze({ feet: "floor" }),
  seat: Object.freeze({ seat: "seat" }),
  "seat+feet": Object.freeze({ seat: "seat", feet: "floor" }),
  knees: Object.freeze({ knees: "floor" }),
  "knees+toes": Object.freeze({ knees: "floor", toes: "floor" }),
  "knees+feet": Object.freeze({ knees: "floor", feet: "floor" }),
  "hands-knees": Object.freeze({ knees: "floor", palms: "floor" }),
  "hands-feet": Object.freeze({ feet: "floor", palms: "floor" }),
  "elbows-knees": Object.freeze({ knees: "floor", elbows: "floor" }),
  body: Object.freeze({ body: "floor" }),
});
/** One line per support value, for the docs and the editor. */
export const SUPPORT_INFO = Object.freeze({
  feet: "standing, walking, crouching with the feet flat (one foot or both; the lowest sole point touches)",
  seat: "sitting on a seat plane (hints.seat.height), feet free; height 0 = sitting on the floor",
  "seat+feet": "sitting with the feet on the floor as well",
  knees: "kneeling on one or both knees / shins, the feet free (kneeling on the heels, side kneeling)",
  "knees+toes": "kneeling upright with the toes on the floor",
  "knees+feet": "half kneeling: one knee down, the other foot flat",
  "hands-knees": "quadruped: palms and knees (crawling, hands-and-knees reach)",
  "hands-feet": "palms and feet: push-up, bear crawl, plank",
  "elbows-knees": "forearms and knees: low crawl, kneeling on the elbows",
  body: "lying: the lowest points of the body rest on the floor (supine, prone, on the side, creeper)",
});

// Derived contact sets (landmark ids of fit.js) besides body.contacts.
const EXTRA_SETS = Object.freeze({
  toes: ["toe_tip_L", "toe_tip_R"],
  heels: ["heel_sole_L", "heel_sole_R"],
  palms: ["palm_centre_L", "palm_centre_R"],
  shins: ["shin_L", "shin_R"],
  kneecaps: ["knee_front_L", "knee_front_R"],
});
// The surface a landmark of a body contact set is assumed to rest on when a posture lists it in `contacts` and the support does not say.
const SET_SURFACE = Object.freeze({ feet: "floor", seat: "seat", knees: "floor", hands: "floor", elbows: "floor", back: "floor", front: "floor", side_L: "floor", side_R: "floor", head: "floor" });

// ---------------------------------------------------------------------------------------------------------------------
// Expansion
const ROOT_FIELDS = ["heading", "flex", "lat", "rot"];
const PAIRED = [...new Set(JOINTS.filter((j) => j.side === "L").map((j) => j.id.slice(0, -2)))]; // base names of the paired joints: hip, knee, eye, thumb_cmc, ...
const VERTEBRAE = new Set(Object.values(REGIONS).flatMap((r) => r.joints));

/**
 * Expand a Posture of the library into a pose: { root: { heading, flex, lat, rot }, angles: { [jointId]: number[] }, grips: { L, R } }.
 * - root fields default to 0; a posture has no position (x, y, z are an error);
 * - spine region totals are distributed over the vertebrae (skeleton.js expandRegions); vertebra ids in `joints` are added on top;
 * - `joints` keys with "_LR" / "_L" / "_R" are expanded (expandSides, which also handles the eye azimuth convention);
 * - `grips` presets become finger joint angles; explicit joints in `joints` override them;
 * - `pelvis` is not a valid joint key (the root drives it).
 * `angles` holds only the joints that the posture specifies or that come out non-zero (every other joint is 0; the rig treats missing as 0),
 * each padded to the joint's DOF count. `grips` echoes the preset names ({ L: "fist", R: null }). The result carries a non-enumerable `shortfall`:
 * region totals the vertebrae could not take, [{ region, dof, requested, applied }] (the validator reports them).
 * Throws an Error naming the posture id and the offending key for unknown ids, unknown grip names, wrong array lengths and non-finite numbers.
 */
export function expandPosture(posture) {
  if (!isObj(posture)) throw new Error("posture: expected an object");
  const id = typeof posture.id === "string" ? posture.id : "(no id)";
  const bad = (where, msg) => { throw new Error(`posture "${id}": ${where}: ${msg}`); };

  const root = { heading: 0, flex: 0, lat: 0, rot: 0 };
  if (posture.root != null) {
    if (!isObj(posture.root)) bad("root", "must be an object { heading, flex, lat, rot }");
    for (const [k, v] of Object.entries(posture.root)) {
      if (!ROOT_FIELDS.includes(k)) bad(`root.${k}`, ["x", "y", "z"].includes(k) ? "a posture has no position: placement computes it (placePose)" : `unknown root field (expected ${ROOT_FIELDS.join(", ")})`);
      if (!isNum(v)) bad(`root.${k}`, "is not a finite number");
      root[k] = v;
    }
  }

  const checkArray = (where, v, ndof, names) => {
    if (!Array.isArray(v)) bad(where, `angles must be an array in DOF order (${names})`);
    if (v.length === 0 || v.length > ndof) bad(where, `expected 1 to ${ndof} values (${names}), got ${v.length}`);
    for (let i = 0; i < v.length; i++) if (!isNum(v[i])) bad(where, `value ${i} is not a finite number`);
  };

  // joints: split the vertebra ids (they go through expandRegions) from the rest (expandSides)
  const joints = posture.joints ?? {};
  if (!isObj(joints)) bad("joints", "must be an object { jointId: [angles] }");
  const perVertebra = {}, rest = {};
  for (const [key, v] of Object.entries(joints)) {
    const base = key.endsWith("_LR") ? key.slice(0, -3) : null;
    const ids = base !== null ? [`${base}_L`, `${base}_R`] : [key];
    for (const jid of ids) {
      if (JOINT_BY_ID[jid]) continue;
      if (base !== null && JOINT_BY_ID[base]) bad(`joints.${key}`, `"${base}" is not a paired joint: write "${base}" without _LR`);
      if (JOINT_BY_ID[`${key}_L`]) bad(`joints.${key}`, `unknown joint id: "${key}" needs a side, write ${key}_LR (both), ${key}_L or ${key}_R`);
      bad(`joints.${key}`, `unknown joint id (see skeleton.js JOINTS${base !== null ? "; _LR needs a paired joint" : ""})`);
    }
    if (key === "pelvis") bad("joints.pelvis", "the pelvis is driven by `root` (heading, flex, lat, rot)");
    const j = JOINT_BY_ID[ids[0]];
    checkArray(`joints.${key}`, v, j.dof.length, j.dof.map((d) => d.key).join(", "));
    if (VERTEBRAE.has(key)) perVertebra[key] = v; else rest[key] = v;
  }
  const spine = posture.spine ?? {};
  if (!isObj(spine)) bad("spine", "must be an object { lumbar, thoracic, cervical }");
  for (const [r, v] of Object.entries(spine)) {
    if (!Object.hasOwn(REGIONS, r)) bad(`spine.${r}`, `unknown region (expected ${Object.keys(REGIONS).join(", ")})`);
    checkArray(`spine.${r}`, v, 3, "flex, lat, rot");
  }

  const grips = { L: null, R: null };
  if (posture.grips != null) {
    if (!isObj(posture.grips)) bad("grips", "must be an object { L, R }");
    for (const [side, name] of Object.entries(posture.grips)) {
      if (side !== "L" && side !== "R") bad(`grips.${side}`, 'unknown hand (expected "L" or "R")');
      if (name == null) continue;
      if (typeof name !== "string" || !Object.hasOwn(GRIPS, name)) bad(`grips.${side}`, `unknown grip ${JSON.stringify(name)} (known: ${GRIP_NAMES.join(", ")})`);
      grips[side] = name;
    }
  }

  const angles = {};
  for (const side of ["L", "R"]) if (grips[side]) Object.assign(angles, gripAngles(grips[side], side));
  let regions;
  try { regions = expandRegions(spine, perVertebra); } catch (e) { bad("spine", e.message); }
  for (const [vid, a] of Object.entries(regions)) {
    if (a.some((x) => x !== 0) || vid in perVertebra) angles[vid] = a.map(nz);
  }
  let sides;
  try { sides = expandSides(rest); } catch (e) { bad("joints", e.message); }
  for (const [jid, a] of Object.entries(sides)) angles[jid] = a.map(nz);

  // region totals the vertebrae could not take (the rig reports the same as a clamp)
  const shortfall = [];
  for (const [r, v] of Object.entries(spine)) {
    ["flex", "lat", "rot"].forEach((dof, c) => {
      const applied = REGIONS[r].joints.reduce((s, jid) => s + (regions[jid][c] - (perVertebra[jid]?.[c] ?? 0)), 0);
      const requested = v[c] ?? 0;
      if (Math.abs(applied - requested) > 1e-6) shortfall.push({ region: r, dof, requested, applied: nz(Math.round(applied * 1e9) / 1e9) });
    });
  }
  const out = { root, angles, grips };
  Object.defineProperty(out, "shortfall", { value: shortfall, enumerable: false });
  return out;
}

/** An all-neutral pose: every joint 0, root orientation 0. */
export function neutralPose() {
  return { root: { heading: 0, flex: 0, lat: 0, rot: 0 }, angles: {} };
}

function checkPose(pose, where = "pose") {
  if (!isObj(pose)) throw new TypeError(`${where}: expected { root, angles }`);
  if (pose.root != null && !isObj(pose.root)) throw new TypeError(`${where}.root: expected an object`);
  if (pose.angles != null && !isObj(pose.angles)) throw new TypeError(`${where}.angles: expected an object { jointId: [degrees] }`);
  for (const [k, v] of Object.entries(pose.root ?? {})) if (v !== undefined && !isNum(v)) throw new RangeError(`${where}.root.${k} is not a finite number`);
  for (const [jid, a] of Object.entries(pose.angles ?? {})) {
    const j = JOINT_BY_ID[jid];
    if (!j) throw new Error(`${where}: unknown joint id "${jid}"`);
    if (!Array.isArray(a) && !ArrayBuffer.isView(a)) throw new TypeError(`${where}.angles.${jid}: expected an array in DOF order (${j.dof.map((d) => d.key).join(", ")})`);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === undefined) continue; // a hole is 0, as everywhere
      if (!isNum(a[i])) throw new RangeError(`${where}.angles.${jid}[${i}] is not a finite number`);
      if (i >= j.dof.length && a[i] !== 0) throw new RangeError(`${where}.angles.${jid}: ${j.id} has ${j.dof.length} DOF (${j.dof.map((d) => d.key).join(", ")}), got ${a.length} values`);
    }
  }
}
const padded = (id, a) => JOINT_BY_ID[id].dof.map((_, i) => (isNum(a?.[i]) ? a[i] : 0));
const rootOf = (pose) => ({ heading: pose.root?.heading ?? 0, flex: pose.root?.flex ?? 0, lat: pose.root?.lat ?? 0, rot: pose.root?.rot ?? 0 });

// ---------------------------------------------------------------------------------------------------------------------
// Clamp, mirror, blend, compare
/**
 * Clamp every joint of a pose to its range of motion (skeleton.js clampAngles, including the 180-degree swing cap). Never mutates the input.
 * Returns { pose, clamped: [{ joint, dof, requested, applied }] } (the root orientation is not limited). Throws for unknown joints and
 * non-finite values.
 */
export function clampPose(pose) {
  checkPose(pose);
  const out = { root: { ...(pose.root ?? {}) }, angles: {} };
  const clamped = [];
  for (const [jid, a] of Object.entries(pose.angles ?? {})) {
    const j = JOINT_BY_ID[jid], req = padded(jid, a), c = clampAngles(jid, req);
    out.angles[jid] = c.angles.map(nz);
    c.angles.forEach((ap, i) => {
      if (c.clamped[i] && !(Math.abs(req[i] - ap) < 1e-9)) clamped.push({ joint: jid, dof: j.dof[i].key, requested: req[i], applied: ap });
    });
  }
  return { pose: out, clamped };
}

/**
 * The mirror image of a pose (left and right exchanged). Paired joints swap their arrays unchanged: the same anatomical angles on the other side
 * (this holds for the eyes too: their joint `azim` is lateral-positive on both sides, DESIGN.md 1.4). Unpaired joints (spine, head, jaw, pelvis
 * `angles`) keep flexion (and jaw opening) and negate lateral bend and axial rotation. Root: heading, lat and rot negated, flex unchanged;
 * a root x is negated. mirrorPose(mirrorPose(p)) equals p. The input is not modified.
 */
export function mirrorPose(pose) {
  checkPose(pose);
  const r = pose.root ?? {}, root = {};
  for (const [k, v] of Object.entries(r)) root[k] = nz(k === "heading" || k === "lat" || k === "rot" || k === "x" ? -v : v);
  const angles = {};
  for (const [jid, a] of Object.entries(pose.angles ?? {})) {
    const j = JOINT_BY_ID[jid];
    const arr = padded(jid, a);
    if (sideOf(jid)) angles[mirrorId(jid)] = arr.map(nz);
    else angles[jid] = arr.map((v, i) => nz(j.dof[i].key === "lat" || j.dof[i].key === "rot" ? -v : v));
  }
  return { root, angles };
}

/**
 * The editor's "mirror left to right" / "right to left": the paired joints of the other side get the anatomical angles of side `from` ("L" or "R"; the joints
 * that `from` does not list become 0 on the other side), unpaired joints and the root are untouched. The eyes follow the POSTURE convention of DESIGN.md 1.4:
 * both eyes keep looking the same way (the copy of eye_L has its azimuth negated), which is why this is not mirrorPose + merge. The input is not modified.
 */
export function copySide(pose, from = "L") {
  checkPose(pose);
  if (from !== "L" && from !== "R") throw new Error(`copySide: from must be "L" or "R", got ${JSON.stringify(from)}`);
  const out = { root: { ...(pose.root ?? {}) }, angles: {} };
  for (const [jid, a] of Object.entries(pose.angles ?? {})) out.angles[jid] = padded(jid, a);
  for (const base of PAIRED) {
    const src = `${base}_${from}`, dst = mirrorId(src);
    if (!(src in out.angles) && !(dst in out.angles)) continue;
    const a = padded(src, out.angles[src]);
    if (base === "eye") a[1] = a[1] === 0 ? 0 : -a[1]; // the same conjugate gaze: azimuth is lateral-positive in the joint convention
    out.angles[dst] = a;
  }
  return out;
}

/** Do two poses describe the same posture within eps degrees (missing joints and trailing values are 0, heading compares modulo 360, root positions in metres)? */
export function poseEquals(a, b, eps = 1e-9) {
  checkPose(a, "a"); checkPose(b, "b");
  const ra = a.root ?? {}, rb = b.root ?? {};
  if (Math.abs(wrap180((ra.heading ?? 0) - (rb.heading ?? 0))) > eps) return false;
  for (const k of ["flex", "lat", "rot", "x", "y", "z"]) if (Math.abs((ra[k] ?? 0) - (rb[k] ?? 0)) > eps) return false;
  for (const jid of new Set([...Object.keys(a.angles ?? {}), ...Object.keys(b.angles ?? {})])) {
    const x = padded(jid, a.angles?.[jid]), y = padded(jid, b.angles?.[jid]);
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > eps) return false;
  }
  return true;
}

// Joints with two swing DOF (shoulder, hip, ankle, vertebrae, head, pelvis, but also clavicle, wrist, fingers, eyes): the swing is a point on a
// sphere (where the bone points), the twist an angle about the bone. The bone direction is interpolated on the great circle between the two
// directions (spherical interpolation) and the twist linearly; a plain interpolation of the two swing angles would cut across the sphere.
const BASES = new Map();
function swingBasis(j) {
  if (BASES.has(j.id)) return BASES.get(j.id);
  const sw = j.dof.map((d, i) => [d, i]).filter(([d]) => d.role !== "twist");
  let b = null;
  if (sw.length === 2) {
    const tw = j.dof.findIndex((d) => d.role === "twist");
    const a1 = new THREE.Vector3(...sw[0][0].axis), a2 = new THREE.Vector3(...sw[1][0].axis);
    b = { a1, a2, i1: sw[0][1], i2: sw[1][1], tw, t: tw >= 0 ? new THREE.Vector3(...j.dof[tw].axis) : a1.clone().cross(a2).normalize() }; // t = the rest direction of the bone
  }
  BASES.set(j.id, b);
  return b;
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _d = new THREE.Vector3(), _w = new THREE.Vector3();
// where the bone points after a swing vector v (radians, perpendicular to t): t turned by |v| about v
function swingDirection(t, v, out) {
  const ang = v.length();
  if (ang < 1e-15) return out.copy(t);
  const n = _w.copy(v).multiplyScalar(1 / ang);
  return out.copy(t).multiplyScalar(Math.cos(ang)).addScaledVector(n.cross(t), Math.sin(ang)); // n . t = 0
}
function blendJoint(j, a, b, u) {
  if (u === 0) return a.slice();
  if (u === 1) return b.slice();
  const B = swingBasis(j);
  if (!B) return a.map((v, i) => v + (b[i] - v) * u); // a hinge or a twist: a circle, linear in the angle is exact
  const sv = (arr, out) => out.set(0, 0, 0).addScaledVector(B.a1, arr[B.i1] * Math.PI / 180).addScaledVector(B.a2, arr[B.i2] * Math.PI / 180);
  const v1 = sv(a, _v1), v2 = sv(b, _v2), d1 = swingDirection(B.t, v1, _d1), d2 = swingDirection(B.t, v2, _d2);
  const om = Math.acos(Math.max(-1, Math.min(1, d1.dot(d2))));
  let v = null;
  if (Math.PI - om > 1e-4) { // otherwise the two directions are opposite: no unique great circle, move along the line in the swing vector (below)
    const so = Math.sin(om), d = om < 1e-9 ? _d.copy(d1) : _d.copy(d1).multiplyScalar(Math.sin((1 - u) * om) / so).addScaledVector(d2, Math.sin(u * om) / so);
    const phi = Math.acos(Math.max(-1, Math.min(1, B.t.dot(d)))), axis = _w.copy(B.t).cross(d), len = axis.length();
    if (len > 1e-12) v = axis.multiplyScalar(phi / len);
    else if (phi < 1e-9) v = axis.set(0, 0, 0);
  }
  if (v === null) v = _w.copy(v1).lerp(v2, u);
  const out = a.map((x, i) => x + (b[i] - x) * u); // the twist (and, for a joint without one, nothing else) is linear
  out[B.i1] = v.dot(B.a1) * 180 / Math.PI;
  out[B.i2] = v.dot(B.a2) * 180 / Math.PI;
  return out.map(nz);
}

/**
 * Interpolate between two poses, t in [0, 1] (clamped). Joints with two swing DOF (shoulder, hip, ankle, every vertebra, head, the root orientation,
 * but also clavicle, wrist, finger and eye joints) are interpolated as swing-twist rotations: the direction the bone points moves along the great circle
 * between the two directions at constant angular speed (spherical interpolation, so a raised arm swings on its arc instead of sagging as a linear blend
 * of the two swing angles would) and the twist angle moves linearly. This is not the quaternion slerp of the two rotations, whose geodesic dips
 * (flexion 90 to abduction 90 would pass 20 degrees below the horizontal); when the two bone directions are opposite the swing moves along the line
 * of the exp-map swing vector. Hinges and twists (elbow, knee, forearm, jaw, ...) are interpolated linearly in their angle, which is exact for a circle.
 * t = 0 returns the angles of `a` and t = 1 those of `b` exactly. The heading takes the short way round (170 to -170 passes 180).
 * The result holds every joint of either pose (a joint missing from one pose is 0 there). Root positions x, y, z, when present, are interpolated linearly.
 */
export function blendPoses(a, b, t) {
  checkPose(a, "a"); checkPose(b, "b");
  if (!isNum(t)) throw new RangeError("blendPoses: t must be a finite number");
  const u = Math.min(1, Math.max(0, t));
  const ra = rootOf(a), rb = rootOf(b);
  let heading;
  if (u === 0) heading = ra.heading; else if (u === 1) heading = rb.heading;
  else heading = wrap180(ra.heading + u * wrap180(rb.heading - ra.heading));
  const rotA = [ra.flex, ra.lat, ra.rot], rotB = [rb.flex, rb.lat, rb.rot];
  const [flex, lat, rot] = blendJoint(JOINTS[0], rotA, rotB, u);
  const root = { heading: nz(heading), flex: nz(flex), lat: nz(lat), rot: nz(rot) };
  for (const k of ["x", "y", "z"]) {
    const va = a.root?.[k], vb = b.root?.[k];
    if (va !== undefined && vb !== undefined) root[k] = u === 0 ? va : u === 1 ? vb : va + (vb - va) * u;
    else if (va !== undefined || vb !== undefined) root[k] = va ?? vb;
  }
  const angles = {};
  for (const jid of new Set([...Object.keys(a.angles ?? {}), ...Object.keys(b.angles ?? {})])) {
    angles[jid] = blendJoint(JOINT_BY_ID[jid], padded(jid, a.angles?.[jid]), padded(jid, b.angles?.[jid]), u);
  }
  return { root, angles };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-body context: kinematics, landmark and contact tables
const CTX = new WeakMap();
function ctxOf(body) {
  if (!isObj(body) || !isObj(body.joints) || !isObj(body.landmarks)) throw new TypeError("expected a BodyModel (fit.js) with joints and landmarks");
  let c = CTX.get(body);
  if (c && c.joints === body.joints && c.landmarks === body.landmarks && c.contacts === body.contacts && c.masses === body.masses) return c;
  const offsets = {};
  for (const j of JOINTS) if (j.parent) offsets[j.id] = body.joints[j.id].offset;
  const kin = new Kinematics(offsets);
  const lm = new Map();
  for (const [id, l] of Object.entries(body.landmarks)) lm.set(id, { id, ji: kin.index(l.joint), off: Array.from(l.offset) });
  const point = (e, label) => {
    if (typeof e === "string") return lm.get(e) ?? null;
    return { id: label, ji: kin.index(e.joint), off: Array.from(e.offset) };
  };
  const sets = new Map();
  for (const [name, set] of Object.entries(body.contacts ?? {})) sets.set(name, set.map((e, i) => point(e, `${name}[${i}]`)).filter(Boolean));
  for (const [name, ids] of Object.entries(EXTRA_SETS)) if (!sets.has(name) && ids.every((id) => lm.has(id))) sets.set(name, ids.map((id) => lm.get(id)));
  const masses = Object.values(body.masses ?? {}).map((m) => ({ mass: m.mass, ji: kin.index(m.com.joint), off: Array.from(m.com.offset) }));
  c = { joints: body.joints, landmarks: body.landmarks, contacts: body.contacts, masses: body.masses, body, kin, lm, sets, massSegs: masses, seatRef: null, tmp: new THREE.Vector3(), W: null };
  CTX.set(body, c);
  return c;
}

function fullRoot(r) {
  return { x: r?.x ?? 0, y: r?.y ?? 0, z: r?.z ?? 0, heading: r?.heading ?? 0, flex: r?.flex ?? 0, lat: r?.lat ?? 0, rot: r?.rot ?? 0 };
}
/**
 * Solve the kinematics of `body` in a pose and root (root x, y, z, heading, flex, lat, rot); returns the body's cached Kinematics, which stays valid
 * until the next call of any function of this module for the same body. Throws RangeError for non-finite values and Error for unknown joints.
 */
export function solvePose(body, pose, root) {
  const c = ctxOf(body);
  checkPose(pose);
  const r = fullRoot(root ?? pose.root);
  c.kin.solve(pose.angles ?? {}, r);
  return c.kin;
}

// world position of a table entry after c.kin.solve
function worldOf(c, e, out) {
  const P = c.kin.positions, Q = c.kin.quaternions, j3 = 3 * e.ji, j4 = 4 * e.ji;
  const vx = e.off[0], vy = e.off[1], vz = e.off[2], x = Q[j4], y = Q[j4 + 1], z = Q[j4 + 2], w = Q[j4 + 3];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return out.set(P[j3] + vx + w * tx + (y * tz - z * ty), P[j3 + 1] + vy + w * ty + (z * tx - x * tz), P[j3 + 2] + vz + w * tz + (x * ty - y * tx));
}

/** World position of a landmark of the body in a pose (m). */
export function landmarkPosition(body, pose, root, id, out = new THREE.Vector3()) {
  const c = ctxOf(body);
  const e = c.lm.get(id);
  if (!e) throw new Error(`unknown landmark id "${id}"`);
  solvePose(body, pose, root);
  return worldOf(c, e, out);
}

function setEntries(c, name) {
  const s = c.sets.get(name);
  if (!s) throw new Error(`unknown contact set "${name}" (available: ${[...c.sets.keys(), "body"].join(", ")})`);
  return s;
}

// Points of a carrier after c.kin.solve: [{ id, x, y, z }]. "body" = every landmark plus the lowest point of the proxies.
function carrierPoints(c, name) {
  const v = c.tmp, pts = [];
  if (name === "body") {
    for (const e of c.lm.values()) { worldOf(c, e, v); pts.push({ id: e.id, x: v.x, y: v.y, z: v.z }); }
    const prox = bodyProxies(c.body);
    c.W = proxyWorld(prox, c.kin, c.W);
    const lp = lowestPoint(c.W);
    pts.push({ id: `proxy:${lp.proxy}`, x: lp.point.x, y: lp.y, z: lp.point.z });
    return pts;
  }
  for (const e of setEntries(c, name)) { worldOf(c, e, v); pts.push({ id: e.id, x: v.x, y: v.y, z: v.z }); }
  return pts;
}

// load: { mass (kg), landmarks?: ids } a held weight, added at the mean position of the landmarks (default both grip centres)
function comInto(c, out, load) {
  const v = c.tmp;
  let M = 0;
  out.set(0, 0, 0);
  for (const s of c.massSegs) { worldOf(c, s, v); out.addScaledVector(v, s.mass); M += s.mass; }
  if (load && load.mass > 0) {
    const ids = load.landmarks ?? DEFAULT_LOAD, p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const id of ids) {
      const e = c.lm.get(id);
      if (!e) throw new Error(`load: unknown landmark id "${id}"`);
      p.add(worldOf(c, e, q));
    }
    out.addScaledVector(p.multiplyScalar(1 / ids.length), load.mass);
    M += load.mass;
  }
  if (M > 0) out.multiplyScalar(1 / M);
  return M;
}
const DEFAULT_LOAD = ["grip_centre_L", "grip_centre_R"];

// ---------------------------------------------------------------------------------------------------------------------
// Seat height and placement
const ISO_SEAT = { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] };

/**
 * Height (m) of a seat plane. A number (>= 0) is returned as it is. "popliteal" (the default of hints.seat.height) is the seat height at which
 * the ISO 7250-1 seated posture (hips 90, knees 90, ankles 0, trunk upright) has the soles on the floor: the lowest point of the `seat`
 * contact set when that posture is placed on the floor. This is the model's own popliteal height (the seat plane of the body, as fit.js builds
 * it from the sitting measures), not the popliteal LANDMARK: for population boundary-case bodies the two differ by -30 to +40 mm because the
 * percentiles of popliteal height and thigh thickness are independent.
 */
export function seatHeightFor(body, hint = "popliteal") {
  if (typeof hint === "number") {
    if (!(hint >= 0 && Number.isFinite(hint))) throw new RangeError(`seat height must be a number >= 0 (metres), got ${hint}`);
    return hint;
  }
  if (hint !== "popliteal") throw new Error(`seat height must be a number of metres or "popliteal", got ${JSON.stringify(hint)}`);
  const c = ctxOf(body);
  if (c.seatRef === null) {
    const d = placePoseDetailed(body, { root: {}, angles: ISO_SEAT }, { carriers: { feet: "floor" } });
    solvePose(body, { root: {}, angles: ISO_SEAT }, d.root);
    c.seatRef = Math.min(...carrierPoints(c, "seat").map((p) => p.y));
  }
  return c.seatRef;
}

function resolveCarriers(options) {
  if (options.carriers) {
    if (!isObj(options.carriers) || !Object.keys(options.carriers).length) throw new Error("options.carriers must be an object { contactSet: surfaceName } with at least one entry");
    return options.carriers;
  }
  const support = options.support ?? options.posture?.support ?? "feet";
  const c = SUPPORT_CARRIERS[support];
  if (!c) throw new Error(`unknown support ${JSON.stringify(support)} (known: ${Object.keys(SUPPORT_CARRIERS).join(", ")})`);
  return c;
}

function resolveSurfaces(body, options, carriers) {
  const surfaces = { floor: 0, ...(options.surfaces ?? {}) };
  for (const [k, v] of Object.entries(surfaces)) if (!isNum(v)) throw new RangeError(`surface "${k}" must be a height in metres, got ${v}`);
  if (Object.values(carriers).includes("seat") && !("seat" in (options.surfaces ?? {}))) {
    surfaces.seat = seatHeightFor(body, options.posture?.hints?.seat?.height ?? options.seatHeight ?? "popliteal");
  }
  for (const [set, surf] of Object.entries(carriers)) if (!(surf in surfaces)) throw new Error(`carrier "${set}" rests on the surface "${surf}", which options.surfaces does not define (defined: ${Object.keys(surfaces).join(", ")})`);
  return surfaces;
}

/**
 * Put a posed body on its support. `pose` gives the angles and the root ORIENTATION (position fields are ignored). options:
 *  - support: a key of SUPPORT_CARRIERS (or posture: a Posture, whose `support` and `hints.seat.height` are used); default "feet";
 *  - carriers: { contactSet: surfaceName } instead of the support's table; the first entry is the primary carrier;
 *  - surfaces: { name: height in metres } of horizontal planes (default { floor: 0 }; "seat" defaults to the posture's seat height / "popliteal");
 *  - anchor: { x, z } where the horizontal centroid of ALL points of the primary carrier goes (default 0, 0); for the "body" carrier the centroid is
 *    the horizontal position of the centre of mass;
 *  - heading: degrees added to pose.root.heading; the whole body turns about the vertical through the anchor.
 * The root height is chosen so that the lowest point of the primary carrier touches its surface exactly. Returns the root
 * { x, y, z, heading, flex, lat, rot } with a non-enumerable `report` ({ gaps, primary, carriers, surfaces }; see placePoseDetailed).
 */
export function placePose(body, pose, options) {
  const d = placePoseDetailed(body, pose, options);
  Object.defineProperty(d.root, "report", { value: { gaps: d.gaps, primary: d.primary, carriers: d.carriers, surfaces: d.surfaces }, enumerable: false });
  return d.root;
}

/** placePose with its report in the open: { root, gaps: { [contactSet]: metres }, primary, carriers, surfaces }. gaps = height of the lowest point of each carrier above its surface (0 for the primary; > 0 floats, < 0 sinks). */
export function placePoseDetailed(body, pose, options) {
  options ??= {};
  const c = ctxOf(body);
  checkPose(pose);
  const carriers = resolveCarriers(options);
  const surfaces = resolveSurfaces(body, options, carriers);
  if (!isNum(options.heading ?? 0)) throw new RangeError("options.heading must be a number of degrees");
  const r0 = rootOf(pose);
  const root = { x: 0, y: 0, z: 0, heading: wrap180(r0.heading + (options.heading ?? 0)), flex: r0.flex, lat: r0.lat, rot: r0.rot };
  const anchor = { x: options.anchor?.x ?? 0, z: options.anchor?.z ?? 0 };
  if (!isNum(anchor.x) || !isNum(anchor.z)) throw new RangeError("options.anchor must be { x, z } in metres");
  c.kin.solve(pose.angles ?? {}, root);
  const names = Object.keys(carriers), primary = names[0];
  const pp = carrierPoints(c, primary);
  let minY = Infinity, cx = 0, cz = 0;
  for (const p of pp) { if (p.y < minY) minY = p.y; cx += p.x; cz += p.z; }
  cx /= pp.length; cz /= pp.length;
  if (primary === "body" && c.massSegs.length) { const com = new THREE.Vector3(); comInto(c, com); cx = com.x; cz = com.z; } // no masses: the centroid of the landmarks
  root.x = anchor.x - cx;
  root.y = surfaces[carriers[primary]] - minY;
  root.z = anchor.z - cz;
  const gaps = {};
  for (const name of names) {
    const pts = name === primary ? pp : carrierPoints(c, name);
    gaps[name] = Math.min(...pts.map((p) => p.y)) + root.y - surfaces[carriers[name]];
  }
  gaps[primary] = 0;
  return { root, gaps, primary, carriers: { ...carriers }, surfaces };
}

/**
 * Height of every contact point above its surface in a placed pose: [{ set, point (landmark id; "proxy:<id>" for the lowest body proxy), clearance }],
 * clearance in metres, positive = above the surface. `root` is the full root (x, y, z and orientation, e.g. from placePose); `carriers` as in placePose
 * (default the "feet" support); `surfaces` default { floor: 0 }.
 */
export function contactClearances(body, pose, root, surfaces = { floor: 0 }, carriers = SUPPORT_CARRIERS.feet) {
  const c = ctxOf(body);
  solvePose(body, pose, root);
  const rows = [];
  for (const [set, surf] of Object.entries(carriers)) {
    if (!(surf in surfaces)) throw new Error(`carrier "${set}" rests on the surface "${surf}", which is not in surfaces`);
    const pts = carrierPoints(c, set);
    if (set === "body") { // the lowest landmark and the lowest proxy, not 120 rows
      const proxy = pts[pts.length - 1], lm = pts.slice(0, -1).reduce((a, b) => (b.y < a.y ? b : a));
      for (const p of [lm, proxy]) rows.push({ set, point: p.id, clearance: p.y - surfaces[surf] });
    } else for (const p of pts) rows.push({ set, point: p.id, clearance: p.y - surfaces[surf] });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Centre of mass and balance
/**
 * Whole-body centre of mass of a pose from body.masses (segment masses at their centres, de Leva 1996): { point: Vector3 (out), mass }. `root` is the
 * full root. `load` ({ mass kg, landmarks? }, default both grip centres) adds a held weight; the returned mass then includes it.
 */
export function centerOfMass(body, pose, root, out = new THREE.Vector3(), load = null) {
  const c = ctxOf(body);
  if (!c.massSegs.length) throw new Error("this body has no segment masses (body.masses)");
  solvePose(body, pose, root);
  return { point: out, mass: comInto(c, out, load) };
}

function hull2(points) { // Andrew's monotone chain on [x, z]; counter-clockwise (x right, z up), collinear points dropped
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function distSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}

/**
 * Static balance: is the centre of mass, projected on the floor plane, inside the convex hull of the support points? `supportPoints`: landmark ids
 * (strings) and/or world points (Vector3, [x, y, z] or {x, y, z}); `root` is the full root; `options.load` ({ mass, landmarks? }) adds a held weight
 * to the centre of mass (see centerOfMass). Returns { inside, margin, com: Vector3, hull: [[x, z], ...] }:
 * margin in metres, positive = the distance from the centre of mass to the nearest edge of the hull (inside), negative = the distance to the hull (outside).
 * A hull with fewer than three non-collinear corners has no inside: margin = -distance to the point or segment, inside = false.
 */
export function balance(body, pose, root, supportPoints, options = {}) {
  const c = ctxOf(body);
  solvePose(body, pose, root);
  const com = new THREE.Vector3();
  comInto(c, com, options.load);
  const pts = [];
  for (const sp of supportPoints ?? []) {
    if (typeof sp === "string") {
      const e = c.lm.get(sp);
      if (!e) throw new Error(`balance: unknown landmark id "${sp}"`);
      const v = worldOf(c, e, new THREE.Vector3());
      pts.push([v.x, v.z]);
    } else if (Array.isArray(sp)) pts.push([sp[0], sp[2]]);
    else pts.push([sp.x, sp.z]);
  }
  const hull = hull2(pts);
  let margin, inside = false;
  const cross = (a, b) => (b[0] - a[0]) * (com.z - a[1]) - (b[1] - a[1]) * (com.x - a[0]);
  if (hull.length >= 3) {
    let min = Infinity;
    hull.forEach((a, i) => { const b = hull[(i + 1) % hull.length]; min = Math.min(min, cross(a, b) / Math.hypot(b[0] - a[0], b[1] - a[1])); });
    if (min >= 0) { inside = true; margin = min; }
    else margin = -Math.min(...hull.map((a, i) => distSeg(com.x, com.z, a, hull[(i + 1) % hull.length])));
  } else if (hull.length === 2) margin = -distSeg(com.x, com.z, hull[0], hull[1]);
  else if (hull.length === 1) margin = -Math.hypot(com.x - hull[0][0], com.z - hull[0][1]);
  else margin = -Infinity;
  return { inside, margin, com, hull };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (POSTURES.md rules)
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG_RE = /^[a-z0-9][a-z0-9+._-]*$/;
const KNOWN_FIELDS = new Set(["id", "name", "category", "tags", "description", "source", "root", "spine", "joints", "grips", "support", "contacts", "hints"]);
const SITS = new Set(["pelvis", "hip_L", "hip_R", "L5", "L4", "L3", "L2", "L1"]); // joints whose landmarks can sink into a seat
const TOUCH = 0.015; // a contact counts as touching up to this far above its surface (rule 3)
const SINK = 0.005; // and a landmark may be this far below it (rule 3)

/**
 * Check a posture against the rules of POSTURES.md on a body. Never throws for a bad posture: the problems come back as strings.
 * options: { library: Posture[] (for the duplicate-id check), seatHeight (override), contactTolerance (override, m) }.
 * Returns { ok, errors, warnings, metrics: { romViolations, regionShortfalls, gaps, clearances, penetrations, worstPenetration, balanceMargin, seatHeight, root, com } }:
 *  1. schema: kebab-case unique id, category in CATEGORIES, name, description, source, tags (lower-case), a known support, known landmarks in contacts, hints;
 *  2. every joint angle inside its range of motion (a clamped value is an error naming the joint and the DOF), spine region totals that the vertebrae can take;
 *  3. support: the posture is placed on the floor (and on a seat of hints.seat.height for supports with a seat): the primary carrier touches by construction,
 *     every other carrier of the support and every landmark in `contacts` is at most 15 mm (hints.contactTolerance) above its surface, no landmark is more
 *     than 5 mm below the floor (or below the seat plane under the buttocks and thighs), the lowest body proxy is not more than 20 mm below the floor;
 *  4. gross self-intersection: proxies.js capsules, with the tolerances of pairTolerance (hands may rest on the body, not be inside it);
 *  5. balance: for supports on the feet, knees or hands the centre of mass is within 40 mm of the support polygon (the hull of the carrier points that touch)
 *     unless hints.dynamic or hints.externalSupport;
 *  6. warnings: a hand without a grip preset; "symmetric" postures with unequal sides, explicit _L and _R entries that are equal (write _LR), sides that differ by less than 2 degrees.
 */
export function validatePosture(body, posture, options) {
  try {
    return validate(body, posture, options ?? {});
  } catch (e) { // a bug or a hostile object (a getter that throws): report, never throw
    return { ok: false, errors: [`internal error while validating: ${e?.message ?? e}`], warnings: [], metrics: { romViolations: 0, regionShortfalls: 0, gaps: {}, clearances: {}, penetrations: [], worstPenetration: 0, balanceMargin: null, seatHeight: null, root: null, com: null } };
  }
}

function validate(body, posture, options) {
  const errors = [], warnings = [];
  const metrics = { romViolations: 0, regionShortfalls: 0, gaps: {}, clearances: {}, penetrations: [], worstPenetration: 0, balanceMargin: null, seatHeight: null, root: null, com: null };
  const out = () => ({ ok: errors.length === 0, errors, warnings, metrics });
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  if (!isObj(posture)) { err("the posture is not an object"); return out(); }

  // ---- 1. schema -------------------------------------------------------------------------------------------------------------
  try {
    if (typeof posture.id !== "string" || !ID_RE.test(posture.id)) err(`id ${JSON.stringify(posture.id)} must be kebab-case (lower-case letters, digits, hyphens)`);
    if (options.library && typeof posture.id === "string" && options.library.some((p) => p !== posture && p?.id === posture.id)) err(`duplicate id "${posture.id}" in the library`);
    if (typeof posture.name !== "string" || !posture.name.trim()) err("name is missing"); else if (posture.name.length > 60) warn(`name is ${posture.name.length} characters: keep it short and plain`);
    if (!CATEGORIES.some((c) => c.name === posture.category)) err(`category ${JSON.stringify(posture.category)} is not one of: ${CATEGORIES.map((c) => c.name).join(", ")}`);
    if (typeof posture.description !== "string" || !posture.description.trim()) err("description is missing (one or two sentences: what it is and what it is for)");
    else if (posture.description.trim().length < 20) warn("description is very short: say what the posture is and what it is for");
    if (typeof posture.source !== "string" || !posture.source.trim()) err('source is missing (the reference of the angles, or "illustrative")');
    if (!Array.isArray(posture.tags)) err("tags must be an array of lower-case words");
    else {
      if (!posture.tags.length) warn("no tags");
      for (const t of posture.tags) if (typeof t !== "string" || !TAG_RE.test(t)) err(`tag ${JSON.stringify(t)} must be a lower-case word`);
    }
    if (!Object.hasOwn(SUPPORT_CARRIERS, posture.support)) err(`support ${JSON.stringify(posture.support)} must be one of: ${Object.keys(SUPPORT_CARRIERS).join(", ")}`);
    for (const k of Object.keys(posture)) if (!KNOWN_FIELDS.has(k)) warn(`unknown field "${k}"`);
    if (posture.contacts != null) {
      if (!Array.isArray(posture.contacts)) err("contacts must be an array of landmark ids");
      else for (const l of posture.contacts) if (typeof l !== "string" || !Object.hasOwn(body.landmarks ?? {}, l)) err(`contacts: unknown landmark ${JSON.stringify(l)}`);
    }
    const h = posture.hints;
    if (h != null) {
      if (!isObj(h)) err("hints must be an object");
      else {
        const sh = h.seat?.height;
        if (h.seat != null && !isObj(h.seat)) err("hints.seat must be an object { height }");
        else if (sh !== undefined && sh !== "popliteal" && !(isNum(sh) && sh >= 0 && sh <= 1.5)) err(`hints.seat.height must be "popliteal" or a height in metres (0 to 1.5), got ${JSON.stringify(sh)}`);
        if (h.contactTolerance !== undefined && !(isNum(h.contactTolerance) && h.contactTolerance >= 0 && h.contactTolerance <= 0.04)) err("hints.contactTolerance must be a number of metres between 0 and 0.04");
        else if (h.contactTolerance !== undefined && h.contactTolerance > TOUCH) warn(`hints.contactTolerance is ${mm(h.contactTolerance)}: the secondary contacts are checked against that, not 15 mm`);
        for (const k of ["dynamic"]) if (h[k] !== undefined && typeof h[k] !== "boolean") err(`hints.${k} must be true or false`);
        if (h.externalSupport !== undefined && typeof h.externalSupport !== "boolean" && typeof h.externalSupport !== "string") err("hints.externalSupport must be true or the name of what carries the weight");
        if (h.load !== undefined) {
          if (!isObj(h.load) || !(isNum(h.load.mass) && h.load.mass >= 0 && h.load.mass <= 200)) err("hints.load must be { mass } in kg (0 to 200), optionally with `landmarks`");
          else if (h.load.landmarks !== undefined && (!Array.isArray(h.load.landmarks) || !h.load.landmarks.length || h.load.landmarks.some((l) => !Object.hasOwn(body.landmarks ?? {}, l)))) err("hints.load.landmarks must be a list of landmark ids");
        }
      }
    }
  } catch (e) { err(`schema check failed: ${e.message}`); }

  // ---- expansion -------------------------------------------------------------------------------------------------------------
  let ex;
  try { ex = expandPosture(posture); } catch (e) { err(e.message); return out(); }
  const requested = { root: ex.root, angles: ex.angles };

  // ---- 2. range of motion ----------------------------------------------------------------------------------------------------
  const { pose, clamped } = clampPose(requested);
  for (const k of clamped) {
    const d = JOINT_BY_ID[k.joint].dof.find((x) => x.key === k.dof);
    const outside = k.requested < d.min || k.requested > d.max;
    err(outside ? `${k.joint} ${k.dof} = ${k.requested}° is outside the range of motion [${d.min}, ${d.max}] (clamps to ${+k.applied.toFixed(2)}°)`
      : `${k.joint} ${k.dof}: the swing of the joint is limited to 180° in total (${k.requested}° would become ${+k.applied.toFixed(2)}°)`);
  }
  metrics.romViolations = clamped.length;
  for (const s of ex.shortfall) err(`spine ${s.region} ${s.dof}: requested ${s.requested}°, the vertebrae of the region can take ${s.applied}°`);
  metrics.regionShortfalls = ex.shortfall.length;

  // ---- hands and symmetry (warnings) -----------------------------------------------------------------------------------------
  for (const side of ["L", "R"]) {
    if (!ex.grips[side] && !HAND_JOINTS.some((h) => `${h}_${side}` in ex.angles)) warn(`no grip for the ${side === "L" ? "left" : "right"} hand (rule 4: choose a preset of GRIPS, e.g. grips: { ${side}: "relaxed" })`);
  }
  try { symmetryWarnings(posture, ex, warn); } catch (e) { warn(`symmetry check skipped: ${e.message}`); }

  // ---- 3. support, penetration, balance --------------------------------------------------------------------------------------
  if (!Object.hasOwn(SUPPORT_CARRIERS, posture.support)) return out();
  let c;
  try { c = ctxOf(body); } catch (e) { err(`cannot place the posture: ${e.message}`); return out(); }
  try {
    const hints = posture.hints ?? {};
    const carriers = SUPPORT_CARRIERS[posture.support];
    const hasSeat = Object.values(carriers).includes("seat");
    const seat = hasSeat ? seatHeightFor(body, options.seatHeight ?? hints.seat?.height ?? "popliteal") : null;
    const surfaces = hasSeat ? { floor: 0, seat } : { floor: 0 };
    metrics.seatHeight = seat;
    const placed = placePoseDetailed(body, pose, { carriers, surfaces });
    const root = placed.root;
    metrics.root = root;
    metrics.gaps = placed.gaps;
    const tol = options.contactTolerance ?? hints.contactTolerance ?? TOUCH;
    const external = !!hints.externalSupport;
    c.kin.solve(pose.angles, root);
    const w = new THREE.Vector3();

    // primary carrier: exact by construction (a failure here is a bug in the placement)
    const names = Object.keys(carriers), primary = names[0];
    const prim = carrierPoints(c, primary).map((p) => p.y - surfaces[carriers[primary]]);
    if (Math.abs(Math.min(...prim)) > 0.002) err(`internal: the primary carrier "${primary}" is ${mm(Math.min(...prim))} from its surface after placement`);

    // other carriers of the support: the lowest point of the set must touch
    if (!external) {
      for (const name of names.slice(1)) {
        const gap = placed.gaps[name];
        const surf = carriers[name] === "floor" ? "the floor" : `the ${carriers[name]}`;
        const how = `the posture is placed by its ${primary}${primary === "seat" ? ` on a seat plane of ${mm(seat)}` : ""}; support "${posture.support}" needs the ${name} to touch within ${mm(tol)}`;
        if (gap > tol) err(`contact set "${name}": its lowest point is ${mm(gap)} above ${surf} (${how})`);
        else if (gap < -SINK) err(`contact set "${name}": its lowest point is ${mm(-gap)} below ${surf}`);
      }
    }
    // explicit contacts
    const clearances = {};
    for (const lmid of posture.contacts ?? []) {
      const e = c.lm.get(lmid);
      if (!e) continue;
      worldOf(c, e, w);
      const surfName = surfaceOfLandmark(c, lmid, carriers, surfaces);
      const cl = w.y - surfaces[surfName];
      clearances[lmid] = cl;
      if (cl > tol) err(`contact ${lmid} is ${mm(cl)} above the ${surfName === "floor" ? "floor" : "seat"} (it must be within ${mm(tol)})`);
      else if (cl < -SINK) err(`contact ${lmid} is ${mm(-cl)} below the ${surfName === "floor" ? "floor" : "seat"}`);
    }
    metrics.clearances = clearances;
    // landmarks below the floor, or below the seat plane under the buttocks and thighs
    const below = [];
    for (const e of c.lm.values()) { worldOf(c, e, w); if (w.y < -SINK) below.push([e.id, -w.y]); }
    below.sort((a, b) => b[1] - a[1]);
    if (below.length) err(`${below.length} landmark${below.length > 1 ? "s are" : " is"} below the floor: ${below.slice(0, 3).map(([l, d]) => `${l} by ${mm(d)}`).join(", ")}${below.length > 3 ? ", ..." : ""}`);
    if (hasSeat && seat > 0) {
      const sp = carrierPoints(c, "seat"), xs = sp.map((p) => p.x), zs = sp.map((p) => p.z), m = 0.06;
      const bounds = [Math.min(...xs) - m, Math.max(...xs) + m, Math.min(...zs) - m, Math.max(...zs) + m];
      const sunk = [];
      for (const e of c.lm.values()) {
        // what sits on a seat: the pelvis, the lower trunk and the thighs (the hands hang beside it, the shanks and feet are below it)
        if (!SITS.has(c.body.landmarks[e.id].joint)) continue;
        if (e.id === "crotch") continue; // a soft-tissue point between the thighs, set by the standing crotch height: it can lie below the ischial plane in the model
        worldOf(c, e, w);
        if (w.x >= bounds[0] && w.x <= bounds[1] && w.z >= bounds[2] && w.z <= bounds[3] && w.y < seat - SINK && w.y > seat - 0.12) sunk.push([e.id, seat - w.y]);
      }
      sunk.sort((a, b) => b[1] - a[1]);
      if (sunk.length) err(`${sunk.length} landmark${sunk.length > 1 ? "s sink" : " sinks"} into the seat: ${sunk.slice(0, 3).map(([l, d]) => `${l} by ${mm(d)}`).join(", ")}`);
    }

    // ---- self-intersection (the proxies) -------------------------------------------------------------------------------------
    const prox = bodyProxies(body);
    c.W = proxyWorld(prox, c.kin, c.W);
    const lp = lowestPoint(c.W);
    if (lp.y < -0.02 && !below.length) err(`the body proxy "${lp.proxy}" sinks ${mm(-lp.y)} below the floor`);
    const pens = selfPenetrations(prox, c.W);
    metrics.penetrations = pens;
    metrics.worstPenetration = pens.length ? pens[0].depth : 0;
    for (const p of pens.slice(0, 4)) err(`${p.a} and ${p.b} overlap by ${mm(p.depth)} (more than ${mm(p.tolerance)}): ${selfHint(p.a, p.b)}`);
    if (pens.length > 4) err(`... and ${pens.length - 4} more overlapping pairs`);

    // ---- balance --------------------------------------------------------------------------------------------------------------
    const needsBalance = !hints.dynamic && !external && posture.support !== "body" && posture.support !== "seat";
    const com = new THREE.Vector3();
    comInto(c, com, hints.load);
    metrics.com = [com.x, com.y, com.z];
    if (needsBalance) {
      const pts = [];
      for (const [name, surf] of Object.entries(carriers)) {
        for (const p of carrierPoints(c, name)) if (p.y - surfaces[surf] <= TOUCH) pts.push([p.x, p.y, p.z]);
      }
      const b = balance(body, pose, root, pts, { load: hints.load });
      metrics.balanceMargin = b.margin;
      if (b.margin < -0.04) err(`the centre of mass is ${mm(-b.margin)} outside the support polygon (limit 40 mm; the posture would fall: ${posture.support === "feet" ? "move the weight over the feet, or declare hints.dynamic / hints.externalSupport" : "check which contacts carry the weight"})`);
    }
  } catch (e) { err(`cannot place the posture: ${e.message}`); }
  return out();
}

// The surface a declared contact rests on: that of the carrier set it belongs to, else the usual one for its body set, else the floor.
function surfaceOfLandmark(c, id, carriers, surfaces) {
  let surf = null;
  for (const [set, sf] of Object.entries(carriers)) if (set !== "body" && c.sets.get(set)?.some((p) => p.id === id)) { surf = sf; break; }
  if (surf === null) for (const [name, entries] of c.sets) if (SET_SURFACE[name] && entries.some((p) => p.id === id)) { surf = SET_SURFACE[name]; break; }
  return surf !== null && surf in surfaces ? surf : "floor";
}

function selfHint(a, b) {
  const g = (n) => n.replace(/_[LR]$/, "");
  const hands = ["palm", "fingers"];
  if (hands.includes(g(a)) || hands.includes(g(b))) return "a hand is inside the body: check the shoulder, elbow and wrist angles";
  if (["shank", "foot", "toes"].includes(g(a)) && ["shank", "foot", "toes", "thigh"].includes(g(b))) return "one leg passes through the other: check hip abduction and rotation";
  if (g(a) === "head" || g(b) === "head") return "the head is in the shoulders or chest: check the neck and head angles";
  return "check the joint angles of the two segments";
}

function symmetryWarnings(posture, ex, warn) {
  const tags = posture.tags ?? [];
  const declaredSymmetric = tags.includes("symmetric") || tags.includes("symmetrical");
  const explicit = new Set(Object.keys(posture.joints ?? {}));
  const pairs = [];
  for (const base of PAIRED) {
    const l = ex.angles[`${base}_L`], r = ex.angles[`${base}_R`];
    if (!l && !r) continue;
    const a = padded(`${base}_L`, l), b = padded(`${base}_R`, r);
    if (base === "eye") b[1] = -b[1]; // expandSides stores the right eye's azimuth in joint convention (lateral +): back to the posture convention
    const diff = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    pairs.push({ base, diff, explicitBoth: explicit.has(`${base}_L`) && explicit.has(`${base}_R`) });
  }
  for (const p of pairs) {
    if (declaredSymmetric && p.diff > 1e-6) warn(`tagged symmetric, but ${p.base}_L and ${p.base}_R differ by up to ${+p.diff.toFixed(1)}°`);
    else if (p.explicitBoth && p.diff <= 1e-6) warn(`${p.base}_L and ${p.base}_R are written separately with equal values: use ${p.base}_LR`);
    else if (!declaredSymmetric && p.diff > 1e-6 && p.diff < 2) warn(`${p.base}_L and ${p.base}_R differ by only ${+p.diff.toFixed(2)}°: a typo, or use ${p.base}_LR`);
  }
}
