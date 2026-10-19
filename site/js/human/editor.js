// Posture editor engine of the Digital human tab: the state and the operations behind the Posture panel (panels/posture.js), without a DOM.
// Manual: docs/human3d/EDITOR.md. Tests: tests/human3d/editor.test.mjs (Node, with a real rig and a fake viewport / scheduler).
//
//   const editor = createEditor({ getRig, getBody, ik: await import("./ik.js"), viewport, ctx, storage });   // published as ctx.posture by the panel
//   editor.apply("sit-upright-90-90-90")            library posture -> expandPosture -> clampPose -> placePose on its support, animated (350 ms)
//   editor.setJoint("shoulder_R", "flex", 90)       one degree of freedom (the symmetric option mirrors it, eyes in the posture convention)
//   const drag = editor.createDrag("palm_R"); drag.begin(point); drag.move(point2); drag.end()      IK handles (ik.js), one history step per drag
//   editor.undo(); editor.saveCustom("My reach")    history of 200 steps (placement included), custom postures in localStorage
//
// What the editor keeps, apart from the rig (which holds the pose):
//   * the BASE: the posture the pose started from (library, custom, imported or neutral) and its clamped pose, so "modified" is a comparison, not a flag;
//   * the PLACEMENT: what carries the weight (a key of SUPPORT_CARRIERS), the mode (floor, seat, free), the seat (the posture's own height, a number of metres
//     or a surface of a sandbox object, which the figure then follows), the horizontal ANCHOR where the carrier centroid is, the heading and "stay on the support";
//   * the history (snapshots of pose + placement + base), the look-at target and the options.
// After every edit the figure is re-grounded with placePose (pose.js) on that placement, so bending the trunk never lifts the figure off its seat or sinks it into
// the floor; the anchor is what keeps the support in place while the pelvis moves, and it is re-read from the figure after a foot or pelvis drag.
//
// Conventions as everywhere (DESIGN.md): metres in the API, degrees for angles, +Y up, +Z in front of the figure, +X its left. The eyes' `azim` of a raw joint is lateral-positive
// on both sides; "symmetric" edits keep the two eyes looking the same way (the posture convention of DESIGN.md 1.4).
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, mirrorId, sideOf, swingLength } from "./skeleton.js";
import { CATEGORIES, SUPPORT_CARRIERS, SUPPORT_INFO, expandPosture, expandSpine, clampPose, mirrorPose, copySide, blendPoses, poseEquals, placePoseDetailed, seatHeightFor, contactClearances, balance } from "./pose.js";
import { POSTURES, GRIPS } from "./postures.js";
import { GRIP_NAMES, HAND_JOINTS, gripAngles } from "./postures/grips.js";

export { SUPPORT_CARRIERS, SUPPORT_INFO, CATEGORIES, GRIPS, GRIP_NAMES };

export const STORAGE_KEY = "hm-custom-postures-v1";
export const MAX_CUSTOM = 100;
export const MAX_CUSTOM_BYTES = 200_000;
export const MAX_HISTORY = 200;
export const ANIMATION_MS = 350;
export const COALESCE_MS = 600;
export const NUDGE_M = 0.01;
const TOUCH = 0.015, SHIN_TOUCH = 0.03, BALANCE_LIMIT = 0.04; // pose.js: a contact touches within 15 mm, the balance rule allows 40 mm
const MAX_ANGLE = 3600;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const nz = (x) => (x === 0 ? 0 : x);
const wrap180 = (d) => { const w = ((((d + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w; };
const ORIENT = ["heading", "flex", "lat", "rot"];
const ROOT_KEYS = ["x", "y", "z", "heading", "flex", "lat", "rot"];
const r6 = (v) => nz(Math.round(v * 1e6) / 1e6);

/** A deep copy of a pose { root, angles } (arrays copied, so a frozen rig state can be edited). */
export function copyPose(p) {
  const angles = {};
  for (const [k, a] of Object.entries(p.angles ?? {})) angles[k] = Array.from(a);
  return { root: { ...(p.root ?? {}) }, angles };
}
const orientOf = (root) => ({ heading: root?.heading ?? 0, flex: root?.flex ?? 0, lat: root?.lat ?? 0, rot: root?.rot ?? 0 });

// ---------------------------------------------------------------------------------------------------------------------
// Names for people
const SUPPORT_LABEL = Object.freeze({
  feet: "Stands on the feet", seat: "Sits on a seat", "seat+feet": "Sits, feet on the floor", knees: "Kneels", "knees+toes": "Kneels on knees and toes",
  "knees+feet": "Half kneeling", "hands-knees": "Hands and knees", "hands-feet": "Hands and feet", "elbows-knees": "Elbows and knees", body: "Lies on the floor",
});
const SUPPORT_SHORT = Object.freeze({ feet: "stands", seat: "sits", "seat+feet": "sits", knees: "kneels", "knees+toes": "kneels", "knees+feet": "kneels", "hands-knees": "all fours", "hands-feet": "plank", "elbows-knees": "crawls", body: "lies" });
/** "Stands on the feet" for a support key of SUPPORT_CARRIERS. */
export const supportLabel = (s) => (Object.hasOwn(SUPPORT_LABEL, s) ? SUPPORT_LABEL[s] : String(s));
/** One word for a badge: stands, sits, kneels, lies ... */
export const supportShort = (s) => (Object.hasOwn(SUPPORT_SHORT, s) ? SUPPORT_SHORT[s] : String(s));

/** The label of a degree of freedom for people: "Left shoulder: Flexion / extension". */
export function dofTitle(jointId, dofIndex) {
  const j = JOINT_BY_ID[jointId];
  return j ? `${j.label}: ${j.dof[dofIndex]?.label ?? dofIndex}` : String(jointId);
}

// ---------------------------------------------------------------------------------------------------------------------
// The editing tabs (what the panel shows) and the slider bounds
const sided = (base, s) => `${base}_${s}`;
const ARM = (s) => ["clavicle", "shoulder", "elbow", "forearm", "wrist"].map((b) => sided(b, s));
const LEG = (s) => ["hip", "knee", "ankle", "mtp"].map((b) => sided(b, s));
/** The eight body-region tabs: { id, label, side, joints (joint ids with their own sliders), regions (spine regions), root (pelvis tilt), grips (hand tab) }. */
export const EDIT_TABS = Object.freeze([
  { id: "spine", label: "Spine & pelvis", short: "Spine", side: null, regions: ["lumbar", "thoracic", "cervical"], root: true, joints: [] },
  { id: "head", label: "Head & eyes", short: "Head", side: null, regions: ["cervical"], joints: ["head", "eye_L", "eye_R", "jaw"] },
  { id: "arm_L", label: "Left arm", short: "L arm", side: "L", joints: ARM("L") },
  { id: "arm_R", label: "Right arm", short: "R arm", side: "R", joints: ARM("R") },
  { id: "hand_L", label: "Left hand", short: "L hand", side: "L", grips: true, joints: [] },
  { id: "hand_R", label: "Right hand", short: "R hand", side: "R", grips: true, joints: [] },
  { id: "leg_L", label: "Left leg", short: "L leg", side: "L", joints: LEG("L") },
  { id: "leg_R", label: "Right leg", short: "R leg", side: "R", joints: LEG("R") },
].map((t) => Object.freeze(t)));
/** The tab that edits a joint (for "select a joint, show its tab"), or null for joints without a slider tab (vertebrae are reached through the spine tab). */
export function tabOfJoint(jointId) {
  const j = JOINT_BY_ID[jointId];
  if (!j) return null;
  if (j.group === "hand") return j.side === "L" ? "hand_L" : "hand_R";
  for (const t of EDIT_TABS) if (t.joints.includes(jointId)) return t.id;
  if (j.region) return j.region === "cervical" ? "head" : "spine";
  return jointId === "pelvis" ? "spine" : null;
}
/** Does a joint have a twin on the other side (so that a "symmetric" edit mirrors it)? */
export const hasTwin = (jointId) => !!sideOf(jointId) && !!JOINT_BY_ID[mirrorId(jointId)];

/**
 * Bounds of a slider for a degree of freedom { min, max }: the range of motion when it is enforced, otherwise a margin on either side (half the span, at least 20 degrees,
 * at most 360 degrees in all) so that the user can see how far a joint would go.
 */
export function sliderBounds(d, enforce = true) {
  if (enforce) return { min: d.min, max: d.max, lo: d.min, hi: d.max };
  const m = Math.max(20, 0.5 * (d.max - d.min));
  return { min: Math.max(-360, d.min - m), max: Math.min(360, d.max + m), lo: d.min, hi: d.max };
}

/** Per-channel totals of the angles of a spine region: [flex, lat, rot]. */
export function regionTotals(angles, region) {
  const out = [0, 0, 0];
  for (const id of REGIONS[region].joints) { const a = angles?.[id]; if (a) for (let c = 0; c < 3; c++) out[c] += a[c] ?? 0; }
  return out.map((v) => r6(v));
}
/** Range of a region total per channel: [[min, max], ...] */
export const regionRange = (region) => [REGIONS[region].range.flex, REGIONS[region].range.lat, REGIONS[region].range.rot];

// ---------------------------------------------------------------------------------------------------------------------
// Custom postures: validation (pure; used on load and on import)
const TAG_RE = /^[a-z0-9][a-z0-9+._-]*$/;
const CUSTOM_ID_RE = /^custom-[a-z0-9]+(-[a-z0-9]+)*$/;
const cleanText = (s, max, fallback = "") => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || fallback;
};
const slugOf = (text, max = 40) => {
  let s = String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/-+$/, "");
  return s;
};
const angleArray = (where, v, max = 3) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw new Error(`${where}: expected 1 to ${max} numbers`);
  return v.map((x) => { if (!isNum(x) || Math.abs(x) > MAX_ANGLE) throw new Error(`${where}: not a number of degrees`); return nz(x); });
};
const allowedJointKey = (key) => {
  if (typeof key !== "string" || key.length > 40) return false;
  if (Object.hasOwn(JOINT_BY_ID, key)) return key !== "pelvis";
  return key.endsWith("_LR") && Object.hasOwn(JOINT_BY_ID, `${key.slice(0, -3)}_L`);
};

/**
 * A stored or imported posture -> a clean copy that holds only known fields (no prototype pollution: no key of the input is ever assigned except joint ids that are
 * looked up as own properties of the joint table), or an Error that says what is wrong. `custom: true` demands a "custom-" id; otherwise the id may be anything kebab-case.
 */
export function sanitizePosture(raw, { custom = true } = {}) {
  if (!isObj(raw)) throw new Error("not an object");
  const out = {};
  if (typeof raw.id !== "string" || !(custom ? CUSTOM_ID_RE : /^[a-z0-9]+(-[a-z0-9]+)*$/).test(raw.id) || raw.id.length > 60) throw new Error("bad id");
  out.id = raw.id;
  out.name = cleanText(raw.name, 60);
  if (!out.name) throw new Error("no name");
  out.category = CATEGORIES.some((c) => c.name === raw.category) ? raw.category : "Reference";
  out.tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((t) => typeof t === "string" && t.length <= 24 && TAG_RE.test(t)))].slice(0, 12) : [];
  out.description = cleanText(raw.description, 400);
  out.source = cleanText(raw.source, 160, "custom");
  if (!Object.hasOwn(SUPPORT_CARRIERS, raw.support)) throw new Error("bad support");
  out.support = raw.support;
  out.root = {};
  if (raw.root != null) {
    if (!isObj(raw.root)) throw new Error("root: not an object");
    for (const k of ORIENT) if (raw.root[k] !== undefined) { if (!isNum(raw.root[k]) || Math.abs(raw.root[k]) > MAX_ANGLE) throw new Error(`root.${k}: not a number of degrees`); out.root[k] = nz(raw.root[k]); }
  }
  out.spine = {};
  if (raw.spine != null) {
    if (!isObj(raw.spine)) throw new Error("spine: not an object");
    for (const r of Object.keys(REGIONS)) if (Object.hasOwn(raw.spine, r)) out.spine[r] = angleArray(`spine.${r}`, raw.spine[r]);
  }
  out.joints = {};
  if (raw.joints != null) {
    if (!isObj(raw.joints)) throw new Error("joints: not an object");
    const keys = Object.keys(raw.joints);
    if (keys.length > 200) throw new Error("joints: too many");
    for (const k of keys) {
      if (!allowedJointKey(k)) throw new Error(`joints: unknown joint "${k.slice(0, 20)}"`);
      const j = JOINT_BY_ID[k.endsWith("_LR") ? `${k.slice(0, -3)}_L` : k];
      out.joints[k] = angleArray(`joints.${k}`, raw.joints[k], j.dof.length);
    }
  }
  out.grips = {};
  if (raw.grips != null) {
    if (!isObj(raw.grips)) throw new Error("grips: not an object");
    for (const s of ["L", "R"]) if (raw.grips[s] != null) { if (typeof raw.grips[s] !== "string" || !Object.hasOwn(GRIPS, raw.grips[s])) throw new Error("grips: unknown grip"); out.grips[s] = raw.grips[s]; }
  }
  if (raw.contacts != null) {
    if (!Array.isArray(raw.contacts)) throw new Error("contacts: not a list");
    out.contacts = raw.contacts.filter((c) => typeof c === "string" && /^[a-z0-9_]{1,40}$/.test(c)).slice(0, 12);
  }
  const hints = {};
  if (raw.hints != null) {
    if (!isObj(raw.hints)) throw new Error("hints: not an object");
    const h = raw.hints, sh = h.seat?.height;
    if (sh === "popliteal" || (isNum(sh) && sh >= 0 && sh <= 1.5)) hints.seat = { height: sh };
    if (typeof h.dynamic === "boolean") hints.dynamic = h.dynamic;
    if (typeof h.externalSupport === "boolean") hints.externalSupport = h.externalSupport;
    else if (typeof h.externalSupport === "string") hints.externalSupport = cleanText(h.externalSupport, 40, "true");
    if (isNum(h.contactTolerance) && h.contactTolerance >= 0 && h.contactTolerance <= 0.04) hints.contactTolerance = h.contactTolerance;
    if (isObj(h.load) && isNum(h.load.mass) && h.load.mass >= 0 && h.load.mass <= 200) {
      hints.load = { mass: h.load.mass };
      if (Array.isArray(h.load.landmarks)) hints.load.landmarks = h.load.landmarks.filter((l) => typeof l === "string" && /^[a-z0-9_]{1,40}$/.test(l)).slice(0, 8);
    }
  }
  if (Object.keys(hints).length) out.hints = hints;
  expandPosture(out); // the last word: unknown joints, wrong array lengths, grips (throws with the posture id)
  return out;
}

/**
 * The text of the custom store -> { postures: Posture[], problems: string[] }. Never throws: corrupt JSON, the wrong shape, hostile entries, too many entries and
 * too much text give an empty or shorter list and a line in `problems`.
 */
export function parseCustomStore(text) {
  const problems = [], postures = [];
  if (text == null || text === "") return { postures, problems };
  if (typeof text !== "string") return { postures, problems: ["the stored postures are not text"] };
  if (text.length > MAX_CUSTOM_BYTES * 1.5) return { postures, problems: ["the stored postures are too large and were ignored"] };
  let data;
  try { data = JSON.parse(text); } catch { return { postures, problems: ["the stored postures are not valid JSON and were ignored"] }; }
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.postures) ? data.postures : null;
  if (!list) return { postures, problems: ["the stored postures have the wrong shape and were ignored"] };
  const seen = new Set();
  for (const raw of list.slice(0, MAX_CUSTOM * 2)) {
    if (postures.length >= MAX_CUSTOM) { problems.push(`only the first ${MAX_CUSTOM} custom postures are kept`); break; }
    try {
      const p = sanitizePosture(raw);
      if (seen.has(p.id)) { problems.push(`a second posture with the id ${p.id} was dropped`); continue; }
      seen.add(p.id);
      postures.push(p);
    } catch (e) { problems.push(`a stored posture was dropped (${String(e.message).slice(0, 80)})`); }
  }
  return { postures, problems };
}
/** The custom store as text. */
export const serializeCustomStore = (postures) => JSON.stringify({ version: 1, postures });
/** A custom id for a name that is not in `taken`: "custom-my-reach", then "custom-my-reach-2", ... */
export function customIdFor(name, taken = new Set(), reserved = new Set()) {
  const base = `custom-${slugOf(name) || "posture"}`.replace(/^(custom-)+/, "custom-");
  let id = base, n = 1;
  while (taken.has(id) || reserved.has(id)) id = `${base}-${++n}`;
  return id.slice(0, 60);
}

// ---------------------------------------------------------------------------------------------------------------------
// Handles
const FOOT_PINS = (s) => [`heel_sole_${s}`, `ball_sole_medial_${s}`, `ball_sole_lateral_${s}`];
// A drag that is stuck in a corner of the ranges looks for a pose that reaches the point and glides to it (see createDrag).
// The pelvis has no "follow" mode: its root is the pointer, so the legs must meet their pins at once on every event (a follow step of 2 degrees cannot, the pinned feet slide and sink).
const PELVIS_SOLVE = Object.freeze({ follow: false, maxMove: Infinity, maxIterations: 40 });
const RESCUE_MS = 120, RESCUE_MOVE = 0.03, RESCUE_RESTARTS = 6, GLIDE_DEG = 8;
// A drag follows the previous frame, so the redundant joints (the twist of the forearm against the shoulder, the rotation of the knee) keep whatever the path left in them: a hand
// taken out and back ends with the arm twisted 50 degrees. The pose a solve from the drag-start pose gives for the same point is the relaxed one; it is taken when it is
// nearer the start pose by RELAX_GAIN (square degrees summed over the joints), in the drag when the pointer rests and always at the end.
const RELAX_GAIN = 40, RELAX_IDLE = 240;
/** Sum over all joints of the squared difference of the angles of two poses (degrees squared): how far the redundant joints have wandered. */
function poseSpread(a, b) {
  let t = 0;
  for (const id of new Set([...Object.keys(a.angles), ...Object.keys(b.angles)])) {
    const x = a.angles[id] ?? [], y = b.angles[id] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const e = (x[i] ?? 0) - (y[i] ?? 0); t += e * e; }
  }
  return t;
}
/** The largest change of any angle (degrees; a root translation counts 1 degree per centimetre) between two poses. */
function poseGap(a, b) {
  let m = 0;
  for (const id of new Set([...Object.keys(a.angles), ...Object.keys(b.angles)])) {
    const x = a.angles[id] ?? [], y = b.angles[id] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) m = Math.max(m, Math.abs((x[i] ?? 0) - (y[i] ?? 0)));
  }
  for (const k of ["flex", "lat", "rot"]) m = Math.max(m, Math.abs((a.root[k] ?? 0) - (b.root[k] ?? 0)));
  m = Math.max(m, Math.abs(wrap180((a.root.heading ?? 0) - (b.root.heading ?? 0))));
  for (const k of ["x", "y", "z"]) m = Math.max(m, Math.abs((a.root[k] ?? 0) - (b.root[k] ?? 0)) * 100);
  return m;
}
/** One step from pose a toward pose b that changes no angle by more than `deg`: { pose, done }. */
function stepToward(a, b, deg) {
  const gap = poseGap(a, b);
  if (gap <= deg) return { pose: copyPose(b), done: true };
  return { pose: blendPoses(a, b, deg / gap), done: false };
}
/** The IK handles: id, words for people, kind (what the drag does) and group. `pole` handles swivel the elbow or knee, `target` is a point in space. */
export const HANDLES = Object.freeze([
  { id: "palm_L", label: "Left hand", short: "L hand", kind: "reach", side: "L", shape: "sphere", color: "hand" },
  { id: "palm_R", label: "Right hand", short: "R hand", kind: "reach", side: "R", shape: "sphere", color: "hand" },
  { id: "foot_L", label: "Left foot", short: "L foot", kind: "foot", side: "L", shape: "sphere", color: "foot" },
  { id: "foot_R", label: "Right foot", short: "R foot", kind: "foot", side: "R", shape: "sphere", color: "foot" },
  { id: "pelvis", label: "Pelvis", short: "Pelvis", kind: "pelvis", side: null, shape: "ring", color: "pelvis" },
  { id: "chest", label: "Chest (trunk lean)", short: "Chest", kind: "chest", side: null, shape: "sphere", color: "trunk" },
  { id: "gaze", label: "Look-at target", short: "Look at", kind: "gaze", side: null, shape: "cross", color: "gaze" },
  { id: "elbow_L", label: "Left elbow", short: "L elbow", kind: "pole", side: "L", shape: "diamond", color: "pole" },
  { id: "elbow_R", label: "Right elbow", short: "R elbow", kind: "pole", side: "R", shape: "diamond", color: "pole" },
  { id: "knee_L", label: "Left knee", short: "L knee", kind: "pole", side: "L", shape: "diamond", color: "pole" },
  { id: "knee_R", label: "Right knee", short: "R knee", kind: "pole", side: "R", shape: "diamond", color: "pole" },
].map((h) => Object.freeze(h)));
const HANDLE_BY_ID = Object.freeze(Object.fromEntries(HANDLES.map((h) => [h.id, h])));
const HANDLE_ALIAS = Object.freeze({ head: "gaze", look: "gaze", hand_L: "palm_L", hand_R: "palm_R" });
const GOAL_LABELS = Object.freeze({
  hand_L: "The left hand", hand_R: "The right hand", foot_L: "The left foot", foot_R: "The right foot", chest: "The chest", lookAt: "The gaze",
  elbow_L: "The left elbow", elbow_R: "The right elbow", knee_L: "The left knee", knee_R: "The right knee",
});
const HANDLE_GOAL = Object.freeze({ palm_L: "hand_L", palm_R: "hand_R", foot_L: "foot_L", foot_R: "foot_R", chest: "chest", gaze: "lookAt", elbow_L: "elbow_L", elbow_R: "elbow_R", knee_L: "knee_L", knee_R: "knee_R" });

/** Seat-like surfaces of a sandbox: [{ objectId, id, name, y, polygon, centre: [x, z] }] (a seat, a bench, a stool, a box lid: 0.15 to 0.9 m high). */
export function seatSurfaces(sandbox) {
  let list = [];
  try { list = sandbox?.supportsWorld?.() ?? []; } catch { return []; }
  const out = [];
  for (const s of list) {
    if (!isNum(s.y) || s.y < 0.15 || s.y > 0.9 || !Array.isArray(s.polygon) || s.polygon.length < 3) continue;
    if (!/seat|bench|stool|lid|top|platform|deck|pad/i.test(`${s.id} ${s.name}`) || /foot|mat|shelf/i.test(s.id)) continue;
    const cx = s.polygon.reduce((t, p) => t + p[0], 0) / s.polygon.length, cz = s.polygon.reduce((t, p) => t + p[1], 0) / s.polygon.length;
    out.push({ objectId: s.objectId, id: s.id, name: String(s.name), y: s.y, polygon: s.polygon, centre: [cx, cz], size: s.size ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The editor
const NEUTRAL_POSTURE = Object.freeze({ id: null, name: "Neutral standing", category: "Reference", tags: [], description: "Every joint angle 0: relaxed standing, arms at the sides.", source: "DESIGN.md 1.1", root: {}, spine: {}, joints: {}, grips: {}, support: "feet" });
const EXTRA_SETS = Object.freeze({ toes: ["toe_tip_L", "toe_tip_R"], heels: ["heel_sole_L", "heel_sole_R"], palms: ["palm_centre_L", "palm_centre_R"], shins: ["shin_L", "shin_R"], kneecaps: ["knee_front_L", "knee_front_R"] });
const FINGERS = Object.freeze({ thumb: ["thumb_cmc", "thumb_mcp", "thumb_ip"], index: ["index_mcp", "index_pip", "index_dip"], middle: ["middle_mcp", "middle_pip", "middle_dip"], ring: ["ring_mcp", "ring_pip", "ring_dip"], little: ["little_mcp", "little_pip", "little_dip"] });
export const FINGER_NAMES = Object.freeze(Object.keys(FINGERS));
const KEY_ANGLES = Object.freeze([
  ["trunkInclination", "Trunk inclination", "deg"], ["neckFlexion", "Neck flexion", "deg"], ["hipAngle_L", "Left hip angle", "deg"], ["hipAngle_R", "Right hip angle", "deg"],
  ["kneeAngle_L", "Left knee angle", "deg"], ["kneeAngle_R", "Right knee angle", "deg"], ["elbowAngle_L", "Left elbow angle", "deg"], ["elbowAngle_R", "Right elbow angle", "deg"],
  ["upperArmInclination_L", "Left upper arm elevation", "deg"], ["upperArmInclination_R", "Right upper arm elevation", "deg"], ["eyeHeight", "Eye height", "m"], ["seatHeight", "Sit-bone height", "m"],
]);
const defaultPlace = () => ({
  support: "feet", mode: "floor", anchor: { x: 0, z: 0 }, heading: 0, stick: true,
  seat: { kind: "auto", hint: "popliteal", height: null, objectId: null, supportId: null, name: null, centre: null, yaw: 0 },
});
const clonePlace = (p) => ({ ...p, anchor: { ...p.anchor }, seat: { ...p.seat, centre: p.seat.centre ? [...p.seat.centre] : null } });
const dofIndexOf = (j, dof) => {
  const i = typeof dof === "number" ? dof : j.dof.findIndex((d) => d.key === dof);
  if (!Number.isInteger(i) || i < 0 || i >= j.dof.length) throw new RangeError(`${j.id} has no degree of freedom ${JSON.stringify(dof)} (${j.dof.map((d) => d.key).join(", ")})`);
  return i;
};
const OPTION_KEYS = Object.freeze(["enforceRom", "animate", "symmetric", "pelvisMode", "trunkAssist", "handFrame", "footPoint"]);

/**
 * createEditor({ getRig, getBody?, ik?, metrics?, viewport?, ctx?, storage?, scheduler?, reducedMotion?, library?, coalesceMs? }) -> Editor.
 * `getRig()` returns the current Rig (rig.js), `ik` the module ik.js (loaded on demand when omitted), `ctx` the panel ctx of the shell (events rig and scene, setPosture, toast),
 * `storage` something with getItem / setItem (default localStorage, every access guarded), `scheduler` { raf, caf, now } for the animation and the throttled drag.
 */
export function createEditor(options = {}) {
  const { getRig, getBody = null, viewport = null, ctx = null, library = POSTURES } = options;
  if (typeof getRig !== "function") throw new TypeError("createEditor: getRig is required");
  const sched = {
    raf: typeof requestAnimationFrame === "function" ? (f) => requestAnimationFrame(f) : null,
    caf: typeof cancelAnimationFrame === "function" ? (id) => cancelAnimationFrame(id) : null,
    now: () => (globalThis.performance?.now ? performance.now() : Date.now()),
    ...options.scheduler,
  };
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const reducedMotion = options.reducedMotion ?? (() => { try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } });
  let disposed = false;

  // ---- events ---------------------------------------------------------------------------------------------------
  const handlers = new Map();
  function on(evt, fn) {
    if (typeof fn !== "function") throw new TypeError("on(event, fn): fn must be a function");
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt)?.delete(fn);
  }
  function emit(evt, data = {}) {
    for (const fn of [...(handlers.get(evt) ?? [])]) { try { fn(data); } catch (e) { console.error(`posture editor: "${evt}" listener failed:`, e); } }
  }
  const say = (text) => { try { ctx?.toast?.(text); } catch { /* no toast */ } };

  // ---- optional modules ------------------------------------------------------------------------------------------
  let IK = options.ik ?? null, METRICS = options.metrics ?? null;
  const loadIk = () => (IK ? Promise.resolve(IK) : import("./ik.js").then((m) => (IK = m), () => null));
  const loadMetrics = () => (METRICS ? Promise.resolve(METRICS) : import("./metrics.js").then((m) => (METRICS = m), () => null));
  const ready = Promise.all([options.ik === null ? null : loadIk(), options.metrics === null ? null : loadMetrics()]).then(() => editor);

  // ---- the rig -------------------------------------------------------------------------------------------------------
  let rigRef = null, offRig = null, solverRef = null, busy = 0;
  const bodyIds = new WeakMap();
  let bodySeq = 0;
  function rig() {
    if (disposed) throw new Error("The posture editor was disposed.");
    const r = getRig();
    if (!r) throw new Error("The figure is not ready yet.");
    if (r !== rigRef) attach(r);
    return r;
  }
  const bodyOf = (r) => r.restBody ?? r.body ?? getBody?.();
  const bodyId = (r) => { const b = r.body ?? r; let id = bodyIds.get(b); if (!id) bodyIds.set(b, (id = ++bodySeq)); return id; };
  function attach(r) {
    const first = rigRef === null;
    try { offRig?.(); } catch { /* the old rig is gone */ }
    rigRef = r;
    solverRef = null;
    offRig = r.onChange?.(() => { if (!busy) emit("external"); }) ?? null;
    if (!first) rigReplaced();
  }
  function solver() {
    const r = rig();
    if (!IK) return null;
    if (solverRef?.rig !== r) solverRef = { rig: r, solver: IK.createSolver(bodyOf(r)) };
    return solverRef.solver;
  }
  const writePose = (pose, clamp = false) => {
    const r = rig();
    busy++;
    try { return r.setPose({ root: { ...r.root, ...pose.root }, angles: pose.angles ?? r.getPose().angles }, { clamp }); } finally { busy--; }
  };

  // ---- state ---------------------------------------------------------------------------------------------------------
  const S = {
    base: { id: null, name: "Neutral standing", kind: "neutral", posture: null, pose: { root: { heading: 0, flex: 0, lat: 0, rot: 0 }, angles: {} } },
    place: defaultPlace(),
    look: null,
    opts: { enforceRom: true, animate: true, symmetric: false, pelvisMode: "bend", trunkAssist: false, handFrame: false, footPoint: "ball" },
    pins: { feet: true, hands: false },
    clamps: [],
    drag: null,
  };
  let lastPosture = "";

  // ---- library and custom postures -------------------------------------------------------------------------------------
  const libById = new Map();
  for (const p of library) if (p && typeof p.id === "string" && !libById.has(p.id)) libById.set(p.id, p);
  let memoryText = null, customCache = { raw: undefined, list: [], problems: [] };
  const store = () => { try { return options.storage !== undefined ? options.storage : globalThis.localStorage ?? null; } catch { return null; } };
  function loadCustom() {
    let raw = memoryText;
    if (raw === null) { try { raw = store()?.getItem(STORAGE_KEY) ?? null; } catch { raw = null; } }
    if (customCache.raw === raw) return customCache;
    customCache = { raw, ...parseCustomStoreList(raw) };
    return customCache;
  }
  function parseCustomStoreList(raw) { const { postures, problems } = parseCustomStore(raw); return { list: postures, problems }; }
  function writeCustom(list) {
    const text = serializeCustomStore(list);
    if (text.length > MAX_CUSTOM_BYTES) return { ok: false, error: `The saved postures would take ${Math.round(text.length / 1000)} kB; at most ${Math.round(MAX_CUSTOM_BYTES / 1000)} kB are kept. Delete some first.` };
    const st = store();
    if (st) {
      try { st.setItem(STORAGE_KEY, text); memoryText = null; } catch (e) {
        memoryText = text; // quota or blocked storage: the session still has them
        customCache = { raw: text, list, problems: [] };
        emit("custom");
        return { ok: true, persistent: false, warning: `This browser would not store them (${String(e?.name ?? e).slice(0, 40)}); they last until the page is closed.` };
      }
    } else memoryText = text;
    customCache = { raw: text, list, problems: [] };
    emit("custom");
    return { ok: true, persistent: !!st };
  }
  const copyPosture = (p) => JSON.parse(JSON.stringify(p));
  function findPosture(id) {
    const c = loadCustom().list.find((p) => p.id === id);
    if (c) return { posture: c, kind: "custom" };
    const l = libById.get(id);
    return l ? { posture: l, kind: "library" } : null;
  }

  // ---- placement ---------------------------------------------------------------------------------------------------------
  const sandbox = () => ctx?.state?.sandbox ?? ctx?.sandbox ?? options.sandbox ?? null;
  function carriersOf(place = S.place) {
    const base = SUPPORT_CARRIERS[place.support] ?? SUPPORT_CARRIERS.feet, out = {};
    for (const [set, surf] of Object.entries(base)) out[set] = place.mode === "floor" && surf === "seat" ? "floor" : surf;
    return out;
  }
  const chairSurface = (seat = S.place.seat) => (seat.kind === "object" ? seatSurfaces(sandbox()).find((s) => s.objectId === seat.objectId && s.id === seat.supportId) ?? null : null);
  function seatHeightOf(place, r) {
    const st = place.seat;
    if (st.kind === "object") { const c = chairSurface(st); return c ? c.y : st.height ?? seatHeightFor(bodyOf(r), "popliteal"); }
    if (st.kind === "height") return st.height;
    return seatHeightFor(bodyOf(r), st.hint ?? "popliteal");
  }
  function surfacesOf(place, r) {
    const s = { floor: 0 };
    if (Object.values(carriersOf(place)).includes("seat")) s.seat = seatHeightOf(place, r);
    return s;
  }
  function planPlacement(pose, r = rig(), place = S.place) {
    return placePoseDetailed(bodyOf(r), pose, { carriers: carriersOf(place), surfaces: surfacesOf(place, r), anchor: place.anchor });
  }
  /** Put the figure on its support again (placePose) unless the mode is free or "stay on the support" is off. `vertical`: only the height. Returns true when it moved. */
  function ground({ vertical = false, force = false } = {}) {
    if (S.place.mode === "free" || (!S.place.stick && !force)) return false;
    const r = rig(), cur = r.getPose(), d = planPlacement(cur, r);
    const next = vertical ? { y: d.root.y } : { x: d.root.x, y: d.root.y, z: d.root.z };
    if (!Object.entries(next).some(([k, v]) => Math.abs(v - cur.root[k]) > 1e-9)) return false;
    busy++;
    try { r.setRoot(next); } finally { busy--; }
    return true;
  }
  /** Read the anchor off the figure: where the centroid of its carrier points is now (after a foot or pelvis drag). */
  function captureAnchor() {
    const r = rig(), cur = r.getPose();
    const d = placePoseDetailed(bodyOf(r), cur, { carriers: carriersOf(), surfaces: surfacesOf(S.place, r), anchor: { x: 0, z: 0 } });
    S.place.anchor = { x: r6(cur.root.x - d.root.x), z: r6(cur.root.z - d.root.z) };
  }
  /** The sandbox changed: a chair the figure sits on may have moved, turned or been adjusted, or removed. The figure goes with it. */
  function syncChair() {
    const st = S.place.seat;
    if (st.kind !== "object" || disposed) return false;
    const c = chairSurface(st);
    if (!c) {
      st.kind = "height";
      emit("place");
      say("The seat the figure was sitting on was removed. It stays at the same height.");
      return true;
    }
    const obj = sandbox()?.objects?.get?.(st.objectId), yaw = obj?.yaw ?? st.yaw, dyaw = yaw - st.yaw;
    const old = st.centre ?? c.centre, moved = Math.hypot(c.centre[0] - old[0], c.centre[1] - old[1]) > 1e-7, turned = Math.abs(dyaw) > 1e-7, higher = Math.abs(c.y - (st.height ?? c.y)) > 1e-7;
    if (!moved && !turned && !higher) return false;
    if (turned) {
      const a = dyaw * Math.PI / 180, ox = S.place.anchor.x - old[0], oz = S.place.anchor.z - old[1];
      S.place.anchor = { x: c.centre[0] + ox * Math.cos(a) + oz * Math.sin(a), z: c.centre[1] - ox * Math.sin(a) + oz * Math.cos(a) };
      S.place.heading = wrap180(S.place.heading + dyaw);
      busy++;
      try { const r = rig(); r.setRoot({ heading: wrap180(r.root.heading + dyaw) }); } finally { busy--; }
    } else S.place.anchor = { x: S.place.anchor.x + c.centre[0] - old[0], z: S.place.anchor.z + c.centre[1] - old[1] };
    st.centre = [...c.centre]; st.yaw = yaw; st.height = c.y;
    ground({ force: true });
    emit("change", { reason: "chair" });
    return true;
  }

  // ---- history ---------------------------------------------------------------------------------------------------------------
  const hist = { stack: [], i: -1 };
  let gesture = null;
  function snap(label, key, pose) {
    const r = rig();
    return { label, key, t: sched.now(), pose: copyPose(pose ?? r.getPose()), place: clonePlace(S.place), base: S.base, look: S.look ? [...S.look] : null, bodyId: bodyId(r) };
  }
  function ensureStart() { if (!hist.stack.length) { hist.stack.push(snap("Start")); hist.i = 0; } }
  function pushHistory(label, key = null, pose = null) {
    ensureStart();
    if (gesture) { gesture.dirty = true; gesture.label ||= label; gesture.key ||= key; return false; }
    const s = snap(label, key, pose), top = hist.stack[hist.i];
    if (key && coalesceMs > 0 && top && hist.i > 0 && hist.i === hist.stack.length - 1 && top.key === key && s.t - top.t <= coalesceMs) {
      hist.stack[hist.i] = { ...s, label: top.label };
    } else {
      hist.stack.length = hist.i + 1;
      hist.stack.push(s);
      if (hist.stack.length > MAX_HISTORY + 1) hist.stack.shift();
      hist.i = hist.stack.length - 1;
    }
    emit("history", historyState());
    return true;
  }
  const historyState = () => ({ canUndo: hist.i > 0, canRedo: hist.i < hist.stack.length - 1, undoLabel: hist.i > 0 ? hist.stack[hist.i].label : "", redoLabel: hist.i < hist.stack.length - 1 ? hist.stack[hist.i + 1].label : "", steps: Math.max(0, hist.stack.length - 1), index: Math.max(0, hist.i) });
  function restore(s) {
    const r = rig();
    S.place = clonePlace(s.place);
    S.base = s.base;
    S.look = s.look ? [...s.look] : null;
    writePose(s.pose, false);
    if (s.bodyId !== bodyId(r)) ground();
    syncPosture();
    emit("change", { reason: "history" });
  }
  /** Begin a gesture: everything recorded until end() (a slider drag, a handle drag, a run of keystrokes) is ONE history step. */
  function beginGesture(label = "Edit", key = null) {
    endGesture();
    begin();
    const g = { label, key, dirty: false };
    gesture = g;
    return { end: () => { if (gesture === g) endGesture(); } };
  }
  function endGesture() {
    const g = gesture;
    if (!g) return false;
    gesture = null;
    if (g.dirty) pushHistory(g.label, g.key);
    return g.dirty;
  }
  function begin() { cancelAnimation(); if (!hist.stack.length) ensureStart(); }
  function undo() {
    endGesture(); cancelAnimation(); cancelDrag();
    ensureStart();
    if (hist.i <= 0) return false;
    restore(hist.stack[--hist.i]);
    emit("history", historyState());
    return true;
  }
  function redo() {
    endGesture(); cancelAnimation(); cancelDrag();
    if (hist.i >= hist.stack.length - 1) return false;
    restore(hist.stack[++hist.i]);
    emit("history", historyState());
    return true;
  }

  // ---- animation ---------------------------------------------------------------------------------------------------------------
  let anim = null;
  function startAnimation(from, to) {
    return new Promise((resolve) => {
      const a = { from, to, t0: sched.now(), id: 0, resolve };
      anim = a;
      const step = () => {
        if (anim !== a || disposed) return;
        const t = Math.min(1, (sched.now() - a.t0) / ANIMATION_MS);
        if (t >= 1) { finishAnimation(a, "done"); return; }
        const u = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const p = blendPoses(a.from, a.to, u), r = rig();
        writePose(p, false);
        if (S.place.mode !== "free") { const low = r.lowestY(); if (low < -1e-4) { busy++; try { r.setRoot({ y: r.root.y - low }); } finally { busy--; } } } // a body lying down never dips through the floor on its way
        a.id = sched.raf(step);
      };
      a.id = sched.raf(step);
      emit("animation", { state: "start" });
    });
  }
  function finishAnimation(a, state) {
    if (anim !== a) return;
    anim = null;
    if (a.id && sched.caf) sched.caf(a.id);
    if (state === "done") writePose(a.to, false);
    syncPosture(); // the shell was told "edited" or nothing at all while the figure was still moving
    a.resolve(state);
    emit("animation", { state });
    emit("change", { reason: "animation" });
  }
  /** Stop a running animation. By default the figure jumps to the end pose (so the state matches the history); `finish: false` leaves it where it is. */
  function cancelAnimation({ finish = true } = {}) {
    const a = anim;
    if (!a) return false;
    finishAnimation(a, finish ? "done" : "cancelled");
    return true;
  }

  // ---- naming the posture in the shell ---------------------------------------------------------------------------------------------
  function isModified() {
    const r = tryRig();
    if (!r || anim) return false; // while a posture is on its way it already is the base
    const cur = r.getPose();
    const rel = { root: { heading: wrap180(cur.root.heading - S.place.heading), flex: cur.root.flex, lat: cur.root.lat, rot: cur.root.rot }, angles: cur.angles };
    try { return !poseEquals(rel, S.base.pose, 1e-6); } catch { return true; }
  }
  const tryRig = () => { try { return rig(); } catch { return null; } };
  function syncPosture() {
    const modified = isModified();
    const id = modified ? null : S.base.id, name = modified ? `${S.base.name} (edited)` : S.base.name, key = `${id}|${name}`;
    if (key === lastPosture) return;
    lastPosture = key;
    try { ctx?.setPosture?.({ id, name }); } catch { /* the shell is gone */ }
  }

  // ---- presenting a posture ---------------------------------------------------------------------------------------------------------
  /** Show a clamped pose with the placement of `info` (the shared tail of apply, import, neutral and reset). */
  function present(pose, info, { animate, keepPlacement = false, record = true, label } = {}) {
    begin();
    cancelDrag();
    const r = rig(), P = S.place;
    P.support = Object.hasOwn(SUPPORT_CARRIERS, info.support) ? info.support : "feet";
    const hint = info.seatHint ?? "popliteal";
    if (P.seat.kind === "auto") P.seat.hint = hint;
    if (!keepPlacement) {
      const hasSeat = Object.values(SUPPORT_CARRIERS[P.support]).includes("seat");
      P.mode = hasSeat && !(P.seat.kind === "auto" && hint === 0) ? "seat" : "floor";
    }
    const cur = r.getPose();
    const target = { root: { x: cur.root.x, y: cur.root.y, z: cur.root.z, heading: wrap180(P.heading + (pose.root?.heading ?? 0)), flex: pose.root?.flex ?? 0, lat: pose.root?.lat ?? 0, rot: pose.root?.rot ?? 0 }, angles: copyPose(pose).angles };
    if (P.mode !== "free") { const d = planPlacement(target, r); Object.assign(target.root, { x: d.root.x, y: d.root.y, z: d.root.z }); }
    S.base = { id: info.id, name: info.name, kind: info.kind, posture: info.posture ?? null, pose: { root: orientOf(pose.root), angles: copyPose(pose).angles } };
    const go = (animate ?? S.opts.animate) && sched.raf && !reducedMotion() && !poseEquals(cur, target, 1e-9);
    let done;
    if (go) done = startAnimation(cur, target);
    else { writePose(target, false); done = Promise.resolve("done"); }
    if (record) pushHistory(label ?? `Posture: ${info.name}`, null, target);
    syncPosture();
    emit("place");
    emit("change", { reason: "apply" });
    return { ok: true, id: info.id, name: info.name, kind: info.kind, done };
  }

  /**
   * Show a posture: a library or custom id, or a Posture object. expandPosture -> clampPose -> placePose on its support, animated over 350 ms (skipped under reduced motion, with
   * `animate: false`, or when the animate option is off). `keepPlacement: true` keeps the mode, seat and anchor (the posture's own support still decides what carries the weight).
   * Returns { ok, id, name, kind, clamped, done } (`done` settles when the animation has ended). Throws for an unknown id or a posture that cannot be expanded.
   */
  function apply(idOrPosture, o = {}) {
    let found = null;
    if (typeof idOrPosture === "string") found = findPosture(idOrPosture);
    else if (isObj(idOrPosture)) found = { posture: idOrPosture, kind: typeof idOrPosture.id === "string" && libById.get(idOrPosture.id) === idOrPosture ? "library" : "object" };
    if (!found) throw new RangeError(`unknown posture ${typeof idOrPosture === "string" ? JSON.stringify(idOrPosture.slice(0, 60)) : "(not an id or a Posture object)"}`);
    const p = found.posture, ex = expandPosture(p);
    const { pose, clamped } = clampPose({ root: ex.root, angles: ex.angles });
    const res = present(pose, { id: typeof p.id === "string" ? p.id : null, name: cleanText(p.name, 60, "Posture"), kind: found.kind === "object" ? "imported" : found.kind, posture: p, support: p.support, seatHint: p.hints?.seat?.height }, o);
    return { ...res, clamped };
  }
  const neutral = (o = {}) => present(copyPose({ root: { heading: 0, flex: 0, lat: 0, rot: 0 }, angles: {} }), { id: null, name: NEUTRAL_POSTURE.name, kind: "neutral", posture: null, support: "feet" }, { label: "Neutral", ...o });
  /** Back to the posture the pose started from (library, custom or imported), keeping the placement. */
  function resetToLibrary(o = {}) {
    const b = S.base;
    if (b.kind === "neutral" || !b.posture) return neutral({ keepPlacement: true, label: "Reset", ...o });
    return present(copyPose(b.pose), { id: b.id, name: b.name, kind: b.kind, posture: b.posture, support: b.posture.support, seatHint: b.posture.hints?.seat?.height }, { keepPlacement: true, label: "Reset", ...o });
  }

  // ---- editing --------------------------------------------------------------------------------------------------------------------
  function setClamps(list) {
    const same = list.length === S.clamps.length && list.every((c, i) => c.joint === S.clamps[i].joint && c.dof === S.clamps[i].dof && c.applied === S.clamps[i].applied);
    S.clamps = list;
    if (!same || list.length) emit("clamp", { clamped: list });
  }
  function afterEdit(label, key, { record = true, report = null, groundIt = true } = {}) {
    if (groundIt) ground();
    if (report) setClamps(report);
    if (record) pushHistory(label, key);
    syncPosture();
    emit("change", { reason: "edit", label });
  }
  function applyAngles(partial, clamp) {
    const r = rig();
    busy++;
    try { return r.setAngles(partial, { clamp }); } finally { busy--; }
  }

  /**
   * Set one degree of freedom (dof: its index or key). Options: symmetric (also set the twin on the other side in posture convention: the eyes keep looking the same way),
   * clamp (default: the enforce-ROM option; false lets the value go beyond the range), record (default true; false while a slider is being dragged, then commit()).
   * Returns { applied, clamped: [{ joint, dof, requested, applied }] }.
   */
  function setJoint(jointId, dof, value, o = {}) {
    const j = Object.hasOwn(JOINT_BY_ID, jointId) ? JOINT_BY_ID[jointId] : null;
    if (!j) throw new Error(`unknown joint id ${JSON.stringify(String(jointId).slice(0, 40))}`);
    const di = dofIndexOf(j, dof);
    if (!isNum(value) || Math.abs(value) > MAX_ANGLE) throw new RangeError("the angle must be a finite number of degrees");
    const { symmetric = S.opts.symmetric, clamp = S.opts.enforceRom, record = true } = o;
    begin();
    const r = rig(), partial = {};
    const put = (id, i, v) => { const a = Array.from(partial[id] ?? r.angles[id]); a[i] = v; partial[id] = a; };
    put(jointId, di, value);
    if (symmetric && hasTwin(jointId)) put(mirrorId(jointId), di, j.id.startsWith("eye_") && j.dof[di].key === "azim" ? nz(-value) : value);
    const rep = applyAngles(partial, clamp);
    afterEdit(`Edit ${dofTitle(jointId, di)}`, `joint:${jointId}:${di}`, { record, report: rep.clamped });
    return { applied: r.angles[jointId][di], clamped: rep.clamped };
  }
  /** Set every degree of freedom of a joint to 0 (symmetric: and its twin). */
  function resetJoint(jointId, o = {}) {
    const j = Object.hasOwn(JOINT_BY_ID, jointId) ? JOINT_BY_ID[jointId] : null;
    if (!j) throw new Error(`unknown joint id ${JSON.stringify(String(jointId).slice(0, 40))}`);
    const { symmetric = S.opts.symmetric, record = true } = o;
    begin();
    const partial = { [jointId]: j.dof.map(() => 0) };
    if (symmetric && hasTwin(jointId)) partial[mirrorId(jointId)] = j.dof.map(() => 0);
    const rep = applyAngles(partial, false);
    afterEdit(`Reset ${j.label}`, null, { record, report: rep.clamped });
    return { clamped: rep.clamped };
  }
  /**
   * Set the total of a spine region: values = [flex, lat, rot] (a channel given as null / undefined is left alone). The total is shared by the vertebrae with the weights of
   * skeleton.js (expandSpine: a vertebra at its own limit takes no more and the rest goes to the others). With the ROM not enforced the shares are not limited.
   * Returns { applied: [flex, lat, rot], clamped } (clamped: { joint: <region>, dof, requested, applied } for a total the vertebrae cannot take).
   */
  function setRegion(region, values, o = {}) {
    if (!Object.hasOwn(REGIONS, region)) throw new Error(`unknown spine region ${JSON.stringify(String(region).slice(0, 40))} (lumbar, thoracic, cervical)`);
    if (!Array.isArray(values)) throw new TypeError("setRegion(region, [flex, lat, rot])");
    const chans = [0, 1, 2].filter((c) => values[c] != null);
    for (const c of chans) if (!isNum(values[c]) || Math.abs(values[c]) > MAX_ANGLE) throw new RangeError("the totals must be finite numbers of degrees");
    const { clamp = S.opts.enforceRom, record = true } = o;
    begin();
    const r = rig(), rg = REGIONS[region], t = [0, 1, 2].map((c) => values[c] ?? 0), partial = {}, report = [];
    if (clamp) {
      const { angles, shortfall } = expandSpine({ [region]: t });
      for (const id of rg.joints) { const a = Array.from(r.angles[id]); for (const c of chans) a[c] = angles[id][c]; partial[id] = a; }
      for (const s of shortfall) { const c = ["flex", "lat", "rot"].indexOf(s.dof); if (chans.includes(c)) report.push({ joint: region, dof: s.dof, requested: s.requested, applied: s.applied }); }
    } else {
      const w = [rg.weights, rg.weightsLat, rg.weightsRot];
      rg.joints.forEach((id, i) => { const a = Array.from(r.angles[id]); for (const c of chans) a[c] = t[c] * w[c][i]; partial[id] = a; });
    }
    const rep = applyAngles(partial, false);
    afterEdit(`Edit ${rg.label.toLowerCase()} spine`, `region:${region}:${chans.join("")}`, { record, report: [...rep.clamped, ...report] });
    return { applied: regionTotals(r.angles, region), clamped: report };
  }
  /** Pelvis orientation and heading (and, only when the placement is free, the position). Heading changes turn the figure about its support (the anchor). */
  function setRoot(partial, o = {}) {
    if (!isObj(partial)) throw new TypeError("setRoot({ heading?, flex?, lat?, rot?, x?, y?, z? })");
    for (const [k, v] of Object.entries(partial)) {
      if (!ROOT_KEYS.includes(k)) throw new Error(`unknown root field ${JSON.stringify(k.slice(0, 20))}`);
      if (v !== undefined && !isNum(v)) throw new RangeError(`root.${k} must be a finite number`);
    }
    const { record = true } = o;
    begin();
    const r = rig(), cur = r.root, next = {};
    for (const k of ORIENT) if (partial[k] !== undefined) next[k] = k === "heading" ? wrap180(partial[k]) : partial[k];
    if (next.heading !== undefined) S.place.heading = wrap180(S.place.heading + (next.heading - cur.heading));
    if (S.place.mode === "free") { for (const k of ["x", "y", "z"]) if (partial[k] !== undefined) next[k] = partial[k]; }
    else if (partial.x !== undefined || partial.z !== undefined) S.place.anchor = { x: S.place.anchor.x + (partial.x ?? cur.x) - cur.x, z: S.place.anchor.z + (partial.z ?? cur.z) - cur.z };
    if (Object.keys(next).length) { busy++; try { r.setRoot(next); } finally { busy--; } }
    afterEdit("Edit pelvis orientation", `root:${Object.keys(partial).join("")}`, { record });
    return { root: r.getPose().root };
  }
  /** Turn the figure about its support to face `degrees` (the heading slider). */
  function setHeading(degrees, o = {}) {
    if (!isNum(degrees)) throw new RangeError("the heading must be a number of degrees");
    const r = rig();
    return setRoot({ heading: r.root.heading + wrap180(degrees - S.place.heading) }, o);
  }
  /** Move the figure so that its support is at (x, z) metres. */
  function setAnchor({ x, z }, o = {}) {
    if (!isNum(x) || !isNum(z)) throw new RangeError("the anchor must be { x, z } in metres");
    begin();
    const r = rig();
    if (S.place.mode === "free") { const dx = x - S.place.anchor.x, dz = z - S.place.anchor.z; busy++; try { r.setRoot({ x: r.root.x + dx, z: r.root.z + dz }); } finally { busy--; } }
    S.place.anchor = { x, z };
    afterEdit("Move the figure", "anchor", { record: o.record ?? true });
  }
  /**
   * Replace the pose: { root?, angles? } with the semantics of rig.setPose (angles: the joints not listed become neutral; root: the orientation fields, a position only when the
   * placement is free). clamp defaults to the enforce-ROM option. Returns { clamped }.
   */
  function setPose(pose, o = {}) {
    if (!isObj(pose)) throw new TypeError("setPose({ root?, angles? })");
    const { clamp = S.opts.enforceRom, record = true, label = "Set the pose" } = o;
    begin();
    const r = rig(), cur = r.getPose(), next = { ...cur.root };
    for (const [k, v] of Object.entries(pose.root ?? {})) {
      if (!ROOT_KEYS.includes(k)) throw new Error(`unknown root field ${JSON.stringify(k.slice(0, 20))}`);
      if (!isNum(v)) throw new RangeError(`root.${k} must be a finite number`);
      if ((k === "x" || k === "y" || k === "z") && S.place.mode !== "free") continue;
      next[k] = v;
    }
    busy++;
    let rep;
    try { rep = r.setPose({ root: next, ...(pose.angles ? { angles: pose.angles } : {}) }, { clamp }); } finally { busy--; }
    afterEdit(label, null, { record, report: rep.clamped });
    return { clamped: rep.clamped };
  }
  /** The hand preset for one hand ("relaxed", "fist", ... see GRIPS). */
  function setGrip(side, name, o = {}) {
    if (side !== "L" && side !== "R") throw new Error('side must be "L" or "R"');
    const angles = gripAngles(name, side); // throws for an unknown name
    begin();
    const rep = applyAngles(angles, true);
    afterEdit(`${side === "L" ? "Left" : "Right"} hand: ${GRIPS[name].label}`, `grip:${side}`, { record: o.record ?? true, report: rep.clamped, groundIt: false });
    return { clamped: rep.clamped };
  }
  /** The preset the hand is in now (within half a degree), or null. */
  function gripOf(side) {
    const A = rig().angles;
    for (const name of GRIP_NAMES) {
      let ok = true;
      for (const [id, vals] of Object.entries(GRIPS[name].joints)) { const cur = A[`${id}_${side}`]; if (vals.some((v, i) => Math.abs((cur?.[i] ?? 0) - v) > 0.51)) { ok = false; break; } }
      if (ok) return name;
    }
    return null;
  }
  /** One degree of freedom of a finger joint: jointBase is "index_mcp", "thumb_cmc", ... */
  function setFingerAngle(side, jointBase, dof, value, o = {}) {
    if (side !== "L" && side !== "R") throw new Error('side must be "L" or "R"');
    if (!HAND_JOINTS.includes(jointBase)) throw new Error(`unknown finger joint ${JSON.stringify(String(jointBase).slice(0, 30))} (${HAND_JOINTS.join(", ")})`);
    return setJoint(`${jointBase}_${side}`, dof, value, { symmetric: false, ...o });
  }
  /** Close a finger between the open hand (0) and the fist (1): the joints of the finger interpolate the two presets. */
  function setFingerCurl(side, finger, t, o = {}) {
    if (side !== "L" && side !== "R") throw new Error('side must be "L" or "R"');
    if (!Object.hasOwn(FINGERS, finger)) throw new Error(`unknown finger ${JSON.stringify(String(finger).slice(0, 20))} (${FINGER_NAMES.join(", ")})`);
    if (!isNum(t)) throw new RangeError("the curl must be a number from 0 to 1");
    const u = Math.min(1, Math.max(0, t)), open = GRIPS.open.joints, fist = GRIPS.fist.joints, partial = {};
    begin();
    for (const jb of FINGERS[finger]) partial[`${jb}_${side}`] = open[jb].map((v, i) => v + u * (fist[jb][i] - v));
    const rep = applyAngles(partial, true);
    afterEdit(`${side === "L" ? "Left" : "Right"} ${finger} finger`, `curl:${side}:${finger}`, { record: o.record ?? true, report: rep.clamped, groundIt: false });
    return { curl: fingerCurl(side, finger), clamped: rep.clamped };
  }
  /** Where a finger is between the open hand (0) and the fist (1): the projection of its joint angles on that line. */
  function fingerCurl(side, finger) {
    if (!Object.hasOwn(FINGERS, finger)) return 0;
    const A = rig().angles, open = GRIPS.open.joints, fist = GRIPS.fist.joints;
    let num = 0, den = 0;
    for (const jb of FINGERS[finger]) open[jb].forEach((v, i) => { const d = fist[jb][i] - v; num += ((A[`${jb}_${side}`]?.[i] ?? 0) - v) * d; den += d * d; });
    return den > 0 ? Math.min(1.5, Math.max(-0.5, num / den)) : 0;
  }

  function transform(fn, label, key) {
    begin();
    const r = rig(), cur = r.getPose();
    const rel = { root: { ...cur.root, heading: wrap180(cur.root.heading - S.place.heading) }, angles: cur.angles };
    const out = fn(rel);
    const root = { ...cur.root, heading: wrap180(S.place.heading + (out.root?.heading ?? rel.root.heading)), flex: out.root?.flex ?? cur.root.flex, lat: out.root?.lat ?? cur.root.lat, rot: out.root?.rot ?? cur.root.rot };
    busy++;
    let rep;
    try { rep = r.setPose({ root, angles: out.angles }, { clamp: S.opts.enforceRom }); } finally { busy--; }
    afterEdit(label, key, { report: rep.clamped });
    return { clamped: rep.clamped };
  }
  /** The mirror image of the pose (left and right exchanged, the figure keeps its place and heading). */
  const mirror = () => transform((p) => mirrorPose(p), "Mirror left and right", null);
  /** Copy the anatomical angles of one side to the other ("L": left to right). The eyes keep looking the same way. */
  function copySideTo(from) {
    if (from !== "L" && from !== "R") throw new Error('copySide("L" | "R")');
    return transform((p) => copySide(p, from), from === "L" ? "Copy left to right" : "Copy right to left", null);
  }

  // ---- placement setters ---------------------------------------------------------------------------------------------------------------
  function placeEdit(label, mutate, o = {}) {
    begin();
    mutate(S.place);
    ground();
    if (o.record ?? true) pushHistory(label, o.key ?? null);
    syncPosture();
    emit("place");
    emit("change", { reason: "place" });
  }
  function setMode(mode, o) {
    if (!["floor", "seat", "free"].includes(mode)) throw new RangeError('mode is "floor", "seat" or "free"');
    placeEdit(`Support: ${mode}`, (P) => { P.mode = mode; }, o);
  }
  function setSeatHeight(metres, o) {
    if (!isNum(metres) || metres < 0 || metres > 1.5) throw new RangeError("the seat height is a number of metres from 0 to 1.5");
    placeEdit("Seat height", (P) => { P.seat = { ...P.seat, kind: "height", height: metres, objectId: null, supportId: null, centre: null, name: null }; P.mode = "seat"; }, { key: "seat-height", ...o });
  }
  /** Back to the seat height of the posture itself ("popliteal" or what its hints say). */
  function useSeatOfPosture(o) {
    placeEdit("Seat of the posture", (P) => { P.seat = { ...P.seat, kind: "auto", hint: S.base.posture?.hints?.seat?.height ?? "popliteal", height: null, objectId: null, supportId: null, centre: null, name: null }; }, o);
  }
  /**
   * Sit on a surface of the sandbox (seatSurfaces(): a seat, a bench, a stool, a box lid). The figure moves to the middle of the surface, faces the way the object faces
   * (`face: false` keeps the heading) and follows it from then on when the object is moved, turned or adjusted. Returns false when there is no such surface.
   */
  function sitOn(objectId, supportId, { face = true, ...o } = {}) {
    const c = seatSurfaces(sandbox()).find((s) => s.objectId === objectId && (supportId == null || s.id === supportId));
    if (!c) return false;
    const yaw = sandbox()?.objects?.get?.(objectId)?.yaw ?? 0;
    begin();
    const r = rig();
    placeEdit(`Sit on ${c.name}`, (P) => {
      P.seat = { ...P.seat, kind: "object", objectId, supportId: c.id, name: c.name, height: c.y, centre: [...c.centre], yaw };
      P.mode = "seat";
      P.anchor = { x: c.centre[0], z: c.centre[1] };
      if (face) { const d = wrap180(yaw - P.heading); P.heading = wrap180(yaw); busy++; try { r.setRoot({ heading: wrap180(r.root.heading + d) }); } finally { busy--; } }
    }, o);
    return true;
  }
  function setSupport(name, o) {
    if (!Object.hasOwn(SUPPORT_CARRIERS, name)) throw new RangeError(`unknown support ${JSON.stringify(String(name).slice(0, 30))} (${Object.keys(SUPPORT_CARRIERS).join(", ")})`);
    placeEdit(`Carried by: ${supportLabel(name)}`, (P) => { P.support = name; }, o);
  }
  function setStick(on_, o) { placeEdit(on_ ? "Stay on the support" : "Free the support", (P) => { P.stick = !!on_; }, o); }

  function setOption(name, value) {
    if (name === "stick") return setStick(!!value);
    if (name === "pinFeet" || name === "pinHands") { S.pins[name === "pinFeet" ? "feet" : "hands"] = !!value; emit("options", { name, value: !!value }); return; }
    if (!OPTION_KEYS.includes(name)) throw new Error(`unknown option ${JSON.stringify(String(name).slice(0, 30))} (${[...OPTION_KEYS, "stick", "pinFeet", "pinHands"].join(", ")})`);
    if (name === "pelvisMode" && !["bend", "move"].includes(value)) throw new RangeError('pelvisMode is "bend" or "move"');
    if (name === "footPoint" && !["ball", "heel"].includes(value)) throw new RangeError('footPoint is "ball" or "heel"');
    S.opts[name] = typeof S.opts[name] === "boolean" ? !!value : value;
    emit("options", { name, value: S.opts[name] });
  }
  const getOptions = () => ({ ...S.opts, stick: S.place.stick, pinFeet: S.pins.feet, pinHands: S.pins.hands });

  // ---- custom postures, import and export ---------------------------------------------------------------------------------------------------
  const listCustom = () => loadCustom().list.map(copyPosture);
  const customProblems = () => loadCustom().problems.slice();
  /**
   * Save the current pose as a custom posture ("custom-<slug of the name>", unique): every non-zero joint by its own id (the eyes in the posture convention: export.js
   * posturePostureOf), the support and the seat height of the placement, the hints of the posture it started from. Stored in localStorage (key hm-custom-postures-v1, at most
   * 100 postures and 200 kB; without storage they last for the session). Returns { ok, id, posture, persistent, warning?, error? }; never throws for storage problems.
   */
  async function saveCustom(name, { category, description, overwrite = null } = {}) {
    const nm = cleanText(name, 60);
    if (!nm) return { ok: false, error: "Give the posture a name." };
    const r = rig(), cur = r.getPose();
    let list = loadCustom().list.map(copyPosture);
    const existing = overwrite ? list.findIndex((p) => p.id === overwrite) : -1;
    if (existing < 0 && list.length >= MAX_CUSTOM) return { ok: false, error: `At most ${MAX_CUSTOM} custom postures can be kept. Delete one first.` };
    const { posturePostureOf } = await import("./export.js");
    const { posture: x } = await posturePostureOf({ rig: r, posture: null });
    const P = S.place, carriers = SUPPORT_CARRIERS[P.support] ?? SUPPORT_CARRIERS.feet, hasSeat = Object.values(carriers).includes("seat");
    const hints = { ...(S.base.posture?.hints ?? {}) };
    delete hints.seat;
    if (hasSeat) hints.seat = { height: P.mode === "floor" ? 0 : P.seat.kind === "auto" ? (P.seat.hint ?? "popliteal") : r6(seatHeightOf(P, r)) };
    const id = existing >= 0 ? overwrite : customIdFor(nm, new Set(list.map((p) => p.id)), new Set(libById.keys()));
    const tags = ["custom", ...(S.base.posture?.tags ?? []).filter((t) => t !== "custom")].slice(0, 8);
    const raw = {
      id, name: nm, category: CATEGORIES.some((c) => c.name === category) ? category : S.base.posture?.category ?? "Reference", tags,
      description: cleanText(description, 400, S.base.kind === "neutral" ? "Edited in the Posture tab." : `Edited from "${S.base.name}" in the Posture tab.`),
      source: "custom (edited in the Posture tab)", root: { ...x.root, heading: r6(wrap180(cur.root.heading - P.heading)) }, spine: {}, joints: x.joints, grips: {}, support: P.support, ...(Object.keys(hints).length ? { hints } : {}),
    };
    let clean;
    try { clean = sanitizePosture(raw); } catch (e) { return { ok: false, error: `This pose cannot be saved (${String(e.message).slice(0, 100)}).` }; }
    if (existing >= 0) list[existing] = clean; else list.push(clean);
    const w = writeCustom(list);
    if (!w.ok) return w;
    begin();
    S.base = { id: clean.id, name: clean.name, kind: "custom", posture: clean, pose: { root: { ...orientOf(cur.root), heading: wrap180(cur.root.heading - P.heading) }, angles: copyPose(cur).angles } };
    pushHistory(`Save "${clean.name}"`, null);
    syncPosture();
    emit("change", { reason: "save" });
    return { ok: true, id: clean.id, posture: copyPosture(clean), persistent: w.persistent, ...(w.warning ? { warning: w.warning } : {}) };
  }
  /** Delete a custom posture. Returns false when there is none with this id. */
  function deleteCustom(id) {
    const list = loadCustom().list.map(copyPosture), i = list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    const w = writeCustom(list);
    if (!w.ok) return false;
    emit("change", { reason: "custom" });
    return true;
  }
  /**
   * Read a posture file (text, a File / Blob, or an object: export.js parsePostureFile reads the wrapper, a bare Posture or a bare pose) and show it. `save: true` also keeps it as
   * a custom posture. Returns { ok, name, warnings, errors, clamped }. Never throws for a bad file.
   */
  async function importPosture(file, { save = false, animate, keepPlacement = false } = {}) {
    let data = file;
    try { if (file && typeof file === "object" && typeof file.text === "function") data = await file.text(); } catch { return { ok: false, errors: ["The file could not be read."], warnings: [] }; }
    const { parsePostureFile } = await import("./export.js");
    const parsed = await parsePostureFile(data);
    if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
    present({ root: orientOf(parsed.pose.root), angles: parsed.pose.angles }, { id: parsed.id ?? null, name: parsed.name, kind: "imported", posture: parsed.posture ?? null, support: parsed.support, seatHint: parsed.seatHeight ?? undefined }, { animate, keepPlacement, label: `Import "${parsed.name}"` });
    let saved = null;
    if (save) saved = await saveCustom(parsed.name);
    return { ok: true, name: parsed.name, warnings: parsed.warnings, errors: [], clamped: parsed.clamped, ...(saved ? { saved } : {}) };
  }
  /** The posture file of the current pose (export.js buildPostureFile): an object, the same JSON as the Export tab writes. */
  async function exportPosture() {
    const { buildPostureFile } = await import("./export.js");
    const r = rig(), file = await buildPostureFile({ rig: r, profile: ctx?.getProfile?.() ?? null, posture: ctx?.state?.posture ?? { id: S.base.id, name: S.base.name } });
    // export.js cannot know what carries the weight of a posture it writes from the angles alone (it guesses the floor or the body): the placement does
    if (file.posture && !file.library_posture) {
      file.posture.support = S.place.support;
      const hasSeat = Object.values(SUPPORT_CARRIERS[S.place.support] ?? {}).includes("seat");
      if (hasSeat) file.posture.hints = { ...(file.posture.hints ?? {}), seat: { height: S.place.mode === "floor" ? 0 : r6(seatHeightOf(S.place, r)) } };
    }
    return file;
  }
  const exportPostureText = async () => `${JSON.stringify(await exportPosture(), null, 2)}\n`;

  // ---- live readouts -----------------------------------------------------------------------------------------------------------------------------
  function romViolations(angles) {
    const out = [];
    for (const j of JOINTS) {
      if (j.id === "pelvis") continue;
      const a = angles[j.id];
      j.dof.forEach((d, i) => {
        const v = a?.[i] ?? 0;
        if (v < d.min - 1e-6 || v > d.max + 1e-6) out.push({ joint: j.id, dof: d.key, index: i, value: v, min: d.min, max: d.max, label: `${j.label}: ${d.label}` });
      });
      if (j.dof.length > 1 && swingLength(j.id, a ?? []) > 180 + 1e-6) out.push({ joint: j.id, dof: "swing", index: -1, value: swingLength(j.id, a), min: 0, max: 180, label: `${j.label}: combined swing` });
    }
    return out;
  }
  function contactEntries(r, set) {
    if (set === "body") return [];
    const ids = EXTRA_SETS[set];
    if (ids) return ids.map((id) => { const v = r.landmarkWorld(id); return { id, x: v.x, y: v.y, z: v.z }; });
    const entries = r.restBody?.contacts?.[set] ?? r.body?.contacts?.[set];
    return r.contactPoints(set).map((v, i) => ({ id: typeof entries?.[i] === "string" ? entries[i] : `${set}[${i}]`, x: v.x, y: v.y, z: v.z }));
  }
  /**
   * Live readouts of the figure: { base, modified, place, history, romViolations, clamps, balance, gaps, metrics, angles, flags, grips }.
   * balance: { applies, margin (m, positive = inside the support polygon), inside, status: "ok" | "edge" | "falls", limit } or { applies: false, reason };
   * gaps: metres of the lowest point of each carrier above its surface (negative = sunk); angles: [{ key, label, value, unit }] from metrics.js when it is there.
   */
  function info() {
    const r = rig(), pose = r.getPose(), P = S.place, body = bodyOf(r), hints = S.base.posture?.hints ?? {};
    const out = {
      base: { id: S.base.id, name: S.base.name, kind: S.base.kind }, modified: isModified(), place: placeView(), history: historyState(), romViolations: romViolations(r.angles), clamps: S.clamps.slice(),
      balance: { applies: false, reason: "" }, gaps: {}, metrics: null, angles: [], flags: [], grips: { L: gripOf("L"), R: gripOf("R") },
    };
    const carriers = carriersOf(P);
    let surfaces = null;
    try { surfaces = surfacesOf(P, r); } catch { /* an unknown support */ }
    if (surfaces && P.mode !== "free") {
      try {
        const rows = contactClearances(body, pose, pose.root, surfaces, carriers);
        for (const row of rows) out.gaps[row.set] = Math.min(out.gaps[row.set] ?? Infinity, row.clearance);
      } catch { /* a body without the contact sets */ }
    }
    const needs = P.mode !== "free" && P.support !== "body" && P.support !== "seat" && !hints.dynamic && !hints.externalSupport;
    if (!needs) out.balance.reason = P.mode === "free" ? "The figure is not on a support." : hints.dynamic ? "A moment of a movement: the balance rule is not applied." : hints.externalSupport ? "Something else carries part of the weight." : P.support === "seat" ? "A seat carries the weight." : "Lying: the body carries itself.";
    else if (surfaces) {
      try {
        const pts = [];
        for (const [set, surf] of Object.entries(carriers)) for (const e of contactEntries(r, set)) if (e.y - surfaces[surf] <= (P.support === "knees" && /^shin_[LR]$/.test(e.id) ? SHIN_TOUCH : TOUCH)) pts.push([e.x, e.y, e.z]);
        const b = balance(body, pose, pose.root, pts, { load: hints.load });
        out.balance = { applies: true, margin: b.margin, inside: b.inside, limit: BALANCE_LIMIT, status: b.margin >= 0 ? "ok" : b.margin >= -BALANCE_LIMIT ? "edge" : "falls", com: [b.com.x, b.com.y, b.com.z] };
      } catch (e) { out.balance = { applies: false, reason: String(e.message).slice(0, 100) }; }
    }
    if (METRICS) {
      try {
        const m = METRICS.postureMetrics(body, { root: orientOf(pose.root), angles: pose.angles }, pose.root, {});
        out.metrics = m;
        out.angles = KEY_ANGLES.filter(([k]) => isNum(m[k])).map(([key, label, unit]) => ({ key, label, value: m[key], unit }));
        out.flags = METRICS.ergonomicFlags(m, { seated: Object.values(carriers).includes("seat") });
      } catch { /* the metrics are an extra */ }
    }
    return out;
  }
  const placeView = () => {
    const P = S.place;
    return { support: P.support, mode: P.mode, stick: P.stick, heading: P.heading, anchor: { ...P.anchor }, seat: { kind: P.seat.kind, hint: P.seat.hint, height: P.seat.height, objectId: P.seat.objectId, supportId: P.seat.supportId, name: P.seat.name }, carriers: carriersOf(P) };
  };
  /** The seat height now in metres (null when the carriers have no seat). */
  function currentSeatHeight() {
    const r = rig();
    return Object.values(carriersOf()).includes("seat") ? seatHeightOf(S.place, r) : null;
  }

  // ---- IK handles ----------------------------------------------------------------------------------------------------------------------------------------
  const vec = (p) => (p?.isVector3 ? p.clone() : new THREE.Vector3(p?.x ?? p?.[0] ?? 0, p?.y ?? p?.[1] ?? 0, p?.z ?? p?.[2] ?? 0));
  const handleOf = (id) => HANDLE_BY_ID[HANDLE_ALIAS[id] ?? id] ?? null;
  const lookActive = () => S.look !== null;
  function defaultLookTarget() {
    const r = rig(), q = new THREE.Quaternion(), d = new THREE.Vector3(), e = new THREE.Vector3(), a = r.landmarkWorld("eye_mid");
    for (const id of ["eye_L", "eye_R"]) d.add(e.set(0, 0, 1).applyQuaternion(r.jointQuaternion(id, q)));
    if (d.lengthSq() < 1e-9) d.set(0, 0, 1);
    return a.addScaledVector(d.normalize(), 1).toArray();
  }
  /** World position of a handle (a new Vector3). Throws for an unknown handle. */
  function handlePoint(id, out = new THREE.Vector3()) {
    const h = handleOf(id), r = rig();
    if (!h) throw new RangeError(`unknown handle ${JSON.stringify(String(id).slice(0, 30))} (${HANDLES.map((x) => x.id).join(", ")})`);
    switch (h.kind) {
      case "reach": return r.landmarkWorld(`palm_centre_${h.side}`, out);
      case "foot": {
        if (S.opts.footPoint === "heel") return r.landmarkWorld(`heel_sole_${h.side}`, out);
        return out.copy(r.landmarkWorld(`ball_sole_medial_${h.side}`)).add(r.landmarkWorld(`ball_sole_lateral_${h.side}`)).multiplyScalar(0.5);
      }
      case "pelvis": return r.jointWorld("pelvis", out);
      case "chest": return r.landmarkWorld("chest_front", out);
      case "gaze": return out.fromArray(S.look ?? defaultLookTarget());
      default: return r.jointWorld(h.id, out); // elbow_L, knee_R ...
    }
  }
  /** Is the handle usable now: the gaze target only while look-at is on; every handle needs the IK module. */
  const handleAvailable = (id) => { const h = handleOf(id); return !!h && !!IK && (h.kind !== "gaze" || lookActive()); };
  const handles = () => HANDLES.map((h) => ({ ...h, available: handleAvailable(h.id), active: S.drag?.handle?.id === h.id }));
  function setLookTarget(p, { announce = true } = {}) {
    S.look = p == null ? null : vec(p).toArray();
    if (announce) emit("look", { target: S.look });
    return S.look ? [...S.look] : null;
  }
  const lookTarget = () => (S.look ? [...S.look] : null);
  /** Turn the look-at target on (a point 1 m in front of the eyes) or off. */
  function toggleLook(on_ = !lookActive()) {
    if (on_ && !lookActive()) setLookTarget(defaultLookTarget());
    else if (!on_) setLookTarget(null);
    return lookActive();
  }

  const R2D = 180 / Math.PI, KNEE_SEED = 8;
  function statusOf(res, h, extra = {}) {
    const IKm = IK, gid = HANDLE_GOAL[h.id];
    const errors = {};
    for (const [id, e] of Object.entries(res.error ?? {})) errors[id] = res.units?.[id] === "rad" ? e * R2D : e * 1000;
    let amount = null, unit = null;
    if (h.kind === "pelvis") { const pins = Object.entries(res.error ?? {}).filter(([id]) => id.startsWith("pin:")); if (pins.length) { amount = Math.max(...pins.map(([, e]) => e)) * 1000; unit = "mm"; } }
    else if (gid && res.error?.[gid] !== undefined) { const rad = res.units?.[gid] === "rad"; amount = res.error[gid] * (rad ? R2D : 1000); unit = rad ? "deg" : "mm"; }
    const tol = (gid && res.tolerance?.[gid]) ?? 0.0005;
    const reachable = !!res.reachable;
    // "still on its way": one drag step moves a joint a few degrees at most, so a far handle is approached over some frames; that is not a failure
    const moving = !reachable && !!res.limited && !res.provablyUnreachable && !(res.clamped ?? []).some((c) => c.blocking);
    const state = reachable ? "ok" : moving ? "moving" : "short";
    let message = "";
    if (state === "short") {
      try { message = IKm.describeResult(res, (id) => GOAL_LABELS[id] ?? IKm.goalLabel(id))[0] ?? ""; } catch { /* the sentence is an extra */ }
      if (h.kind === "pelvis" && amount !== null) message = `The feet cannot stay where they are: ${amount.toFixed(amount < 10 ? 1 : 0)} mm off. The legs have reached a limit of motion.`;
    }
    const short = state === "short" && amount !== null ? (unit === "mm" ? `${amount.toFixed(amount < 10 ? 1 : 0)} mm ${h.kind === "pelvis" ? "off" : "short"}` : `${amount.toFixed(amount < 10 ? 1 : 0)}° short`) : "";
    return { handle: h.id, label: h.label, reachable, state, limited: !!res.limited, amount, unit, short, message, errors, tolerance: tol, ms: res.ms, ...extra };
  }

  /** Prepare a drag: returns plan(target: Vector3, cur) -> { start?, goals, free, options? } or { direct } for the handles that do not need the solver. */
  function prepare(h, d) {
    const sv = d.sv, start = d.start, IKm = IK, side = h.side, other = side === "L" ? "R" : "L";
    const pinFeet = (s) => (S.pins.feet ? IKm.pinGoals(sv, start, FOOT_PINS(s)) : []);
    const pinHand = (s) => IKm.pinGoals(sv, start, [`grip_centre_${s}`]);
    const wristQ = (s) => { const q = d.r.jointQuaternion(`wrist_${s}`); return [q.x, q.y, q.z, q.w]; };
    switch (h.kind) {
      case "reach": {
        const q = S.opts.handFrame ? wristQ(side) : null;
        const assist = S.opts.trunkAssist, keepOther = assist && S.pins.hands ? pinHand(other) : [];
        return (t) => ({
          goals: [{ type: "position", id: `hand_${side}`, landmark: `palm_centre_${side}`, target: t.toArray() }, ...(q ? [{ type: "frame", id: `hand_${side}.frame`, joint: `wrist_${side}`, quaternion: q, weight: 0.5 }] : []), ...keepOther],
          free: [`arm_${side}`, `clavicle_${side}`, ...(assist ? ["trunk"] : []), ...(keepOther.length ? [`arm_${other}`, `clavicle_${other}`] : [])],
        });
      }
      case "foot": {
        const lm = S.opts.footPoint === "heel" ? `heel_sole_${side}` : `ball_centre_${side}`;
        return (t) => {
          const y = Math.max(t.y, 0), flat = y < 0.03;
          return { goals: [{ type: "position", id: `foot_${side}`, landmark: lm, target: [t.x, y, t.z] }, ...(flat ? [{ type: "frame", id: `foot_${side}.frame`, joint: `ankle_${side}`, axes: [{ local: "sole_normal", world: [0, -1, 0] }] }] : [])], free: [`leg_${side}`] };
        };
      }
      case "pelvis": {
        if (S.opts.pelvisMode === "move") return (t) => ({ direct: { dx: t.x - d.P0.x, dy: t.y - d.P0.y, dz: t.z - d.P0.z } });
        const pins = [...pinFeet("L"), ...pinFeet("R"), ...(S.pins.hands ? [...pinHand("L"), ...pinHand("R")] : [])];
        // A straight leg is a singularity: lowering the hip a little shortens the leg only to second order in the knee angle, so the solver may as well choose to push the knee
        // back (into its stop) as to bend it, and a pelvis dragged down and a little sideways ended with straight legs and the feet 28 cm off. Seed a small bend of the knee
        // that the target needs (law of cosines on the hip-to-pinned-ankle distance) so that the solver starts on the right side of it.
        const legs = S.pins.feet ? ["L", "R"].map((sd) => {
          const hip = d.r.jointWorld(`hip_${sd}`), knee = d.r.jointWorld(`knee_${sd}`), ankle = d.r.jointWorld(`ankle_${sd}`);
          return { id: `knee_${sd}`, hip, ankle, L1: hip.distanceTo(knee), L2: knee.distanceTo(ankle) };
        }) : [];
        return (t, cur) => {
          let angles = cur.angles;
          const shift = t.clone().sub(d.P0);
          for (const lg of legs) {
            const k = cur.angles[lg.id];
            if (!k || k[0] >= KNEE_SEED) continue;
            const dist = lg.hip.clone().add(shift).distanceTo(lg.ankle), c = (dist * dist - lg.L1 * lg.L1 - lg.L2 * lg.L2) / (2 * lg.L1 * lg.L2);
            const need = Math.acos(Math.min(1, Math.max(-1, c))) * R2D;
            if (need > k[0] + 0.25) { if (angles === cur.angles) angles = { ...angles }; angles[lg.id] = [Math.min(need, KNEE_SEED), ...k.slice(1)]; }
          }
          return { start: { root: { ...cur.root, x: t.x, y: t.y, z: t.z }, angles }, goals: pins, free: ["legs", ...(S.pins.hands ? ["arms", "clavicles"] : [])], options: PELVIS_SOLVE };
        };
      }
      case "chest": {
        const pins = S.pins.hands ? [...pinHand("L"), ...pinHand("R")] : [];
        return (t) => ({ goals: [{ type: "position", id: "chest", landmark: "chest_front", target: t.toArray() }, ...pins], free: ["trunk", ...(pins.length ? ["arms", "clavicles"] : [])] });
      }
      case "gaze": {
        return (t) => ({ goals: [{ type: "lookAt", id: "lookAt", target: t.toArray(), eyes: true }], free: ["neck", "eyes", ...(S.opts.trunkAssist ? ["trunk"] : [])] });
      }
      case "pole": {
        const knee = h.id.startsWith("knee"), up = d.r.jointWorld(knee ? `hip_${side}` : `shoulder_${side}`), mid = d.r.jointWorld(h.id), end = d.r.jointWorld(knee ? `ankle_${side}` : `wrist_${side}`);
        const L1 = mid.distanceTo(up), L2 = end.distanceTo(mid), D = end.distanceTo(up), a = end.clone().sub(up).normalize();
        const x = (L1 * L1 - L2 * L2 + D * D) / (2 * D), hgt = Math.sqrt(Math.max(0, L1 * L1 - x * x));
        const pins = knee ? [...pinFeet(side), ...IKm.pinGoals(sv, start, [`toe_tip_${side}`])] : IKm.pinGoals(sv, start, [`palm_centre_${side}`]);
        const q = knee ? null : wristQ(side);
        return (t) => {
          const v = t.clone().sub(up);
          v.addScaledVector(a, -v.dot(a));
          if (v.length() < 1e-4) return { goals: [], free: [] };
          const target = up.clone().addScaledVector(a, x).addScaledVector(v.normalize(), hgt);
          return { goals: [{ type: "position", id: h.id, joint: h.id, local: [0, 0, 0], target: target.toArray() }, ...pins, ...(q ? [{ type: "frame", id: `wrist_${side}.frame`, joint: `wrist_${side}`, quaternion: q, weight: 0.3 }] : [])], free: [knee ? `leg_${side}` : `arm_${side}`] };
        };
      }
      default: throw new Error(`no drag for handle ${h.id}`);
    }
  }

  function cancelDrag() { const d = S.drag; if (d) d.cancel(); return !!d; }

  /**
   * The drag controller of one IK handle (HANDLES): begin(worldPoint) when the pointer goes down on it, move(worldPoint) for every pointer position (throttled to one solve per
   * animation frame), end() on release (one history step), cancel() to put everything back. The figure follows the point with ik.js DRAG_OPTIONS (no jumps: a far point is approached
   * over a few frames); `status` says whether the goal was reached and how far short it fell. Options: immediate (solve inside move(), for tests and the keyboard).
   */
  function createDrag(handleId, { immediate = !sched.raf } = {}) {
    const h = handleOf(handleId);
    if (!h) throw new RangeError(`unknown handle ${JSON.stringify(String(handleId).slice(0, 30))} (${HANDLES.map((x) => x.id).join(", ")})`);
    let st = null, last = null;
    const api = {
      handle: h,
      get active() { return !!st; },
      get status() { return st?.status ?? last; },
      begin(point) {
        endGesture();
        cancelAnimation();
        if (S.drag && S.drag !== api) S.drag.cancel();
        if (!IK) return false;
        const sv = solver();
        if (!sv) return false;
        const r = rig();
        ensureStart();
        if (h.kind === "gaze" && !lookActive()) setLookTarget(defaultLookTarget());
        const start = r.getPose(), P0 = handlePoint(h.id), grab = point ? vec(point) : P0.clone();
        st = { r, sv, start, cur: start, place0: clonePlace(S.place), P0, off: P0.clone().sub(grab), target: P0.clone(), pending: false, raf: 0, status: null, moved: false, res: null };
        try { st.plan = prepare(h, st); } catch (e) { st = null; throw e; }
        S.drag = api;
        emit("drag", { phase: "begin", handle: h.id });
        return true;
      },
      move(point) {
        if (!st) return;
        st.target = vec(point).add(st.off);
        st.idle = 0;
        if (h.kind === "gaze") { S.look = st.target.toArray(); emit("look", { target: S.look }); }
        if (immediate) solveNow(); else if (!st.pending) { st.pending = true; st.raf = sched.raf(solveNow); }
      },
      end(o = {}) {
        if (!st) return last;
        const d = st;
        if (d.pending && d.raf && sched.caf) sched.caf(d.raf);
        d.pending = false;
        if (d.moved || d.target.distanceToSquared(d.P0) > 1e-12) {
          solveNow();
          for (let i = 0; i < 80 && (d.glide || (d.res?.limited && d.res.changed?.length !== 0)); i++) solveNow(); // the figure is still on its way: let it arrive
          polish(d);
          relax(d);
        }
        st = null;
        S.drag = null;
        last = d.status;
        finishDrag(h, d, o);
        return last;
      },
      cancel() {
        if (!st) return;
        const d = st;
        if (d.pending && d.raf && sched.caf) sched.caf(d.raf);
        st = null;
        S.drag = null;
        S.place = d.place0;
        writePose(d.start, false);
        last = null;
        emit("drag", { phase: "cancel", handle: h.id });
        emit("change", { reason: "drag-cancel" });
      },
    };
    /** The drag solver steps a few degrees a frame and stops a millimetre or two short; once the pointer is up, one ordinary local solve from where it stopped closes that. */
    function polish(d) {
      if (!d.res || d.res.provablyUnreachable || h.kind === "gaze" || h.kind === "pelvis") return;
      const plan = d.plan(d.target, d.cur);
      if (plan.direct) return;
      const res = d.sv.solve(plan.start ?? d.cur, plan.goals, { free: plan.free, reference: d.start, restarts: 0, maxIterations: 120, ...(plan.options ?? {}) });
      const before = statusOf(d.res, h), after = statusOf(res, h);
      if (d.res.reachable ? res.reachable : res.reachable || (after.amount ?? Infinity) < (before.amount ?? Infinity)) {
        d.res = res;
        d.cur = res.pose;
        writePose(d.cur, false);
        d.status = { ...after, target: d.target.toArray() };
      }
    }
    /** The solve for the same point from the drag-start pose (the figure relaxed as the posture has it): { res, plan }. The pelvis asks for where its root really is. */
    function fromStart(d, extra) {
      const q = h.kind === "pelvis" && d.ok ? d.ok.t : d.target, plan = d.plan(q, d.start);
      return { plan, res: plan.direct ? null : d.sv.solve(plan.start ?? d.start, plan.goals, { free: plan.free, reference: d.start, ...extra, ...(plan.options ?? {}) }) };
    }
    /** The relaxed pose (see RELAX_GAIN), or null when the figure is as near the start pose as that, or the start pose cannot reach the point. */
    function relaxedPose(d, extra) {
      if (!d.res || d.res.provablyUnreachable || (!d.res.reachable && h.kind !== "pelvis") || (h.kind === "pelvis" && !d.ok)) return null;
      const { res } = fromStart(d, extra);
      return res?.reachable && poseSpread(res.pose, d.start) + RELAX_GAIN < poseSpread(d.cur, d.start) ? res : null;
    }
    function relax(d) {
      const res = relaxedPose(d, { restarts: 0, maxIterations: 120 });
      if (!res) return;
      d.glide = null;
      d.res = res;
      d.cur = res.pose;
      writePose(d.cur, false);
      d.status = { ...statusOf(res, h), target: d.target.toArray() };
    }
    /**
     * The pelvis is the pointer: the root goes where the pointer is and the legs must meet their pins at once on every event (a follow step of a few degrees cannot: the pinned
     * feet would slide and sink until the release). Where the legs cannot (the ankles or knees at a stop), the root stays at the last place they could, found by bisection
     * between it and the pointer, the feet stay where they are and the handle says how far short of the pointer the pelvis is.
     */
    function solvePelvis(d, plan) {
      const at = (q, p = d.plan(q, d.cur)) => { const res = d.sv.solve(p.start, p.goals, { free: p.free, reference: d.start, ...p.options }); return { res, t: q.clone() }; };
      d.ok ??= { t: d.P0.clone(), res: null, pose: d.start };
      let hit = at(d.target, plan), ok = hit.res.reachable;
      if (ok) d.ok = { t: hit.t, res: hit.res, pose: hit.res.pose };
      else {
        const from = d.ok.t.clone();
        let lo = 0, hi = 1;
        for (let i = 0; i < 4; i++) {
          const m = (lo + hi) / 2, mid = at(from.clone().lerp(d.target, m));
          if (mid.res.reachable) { lo = m; d.ok = { t: mid.t, res: mid.res, pose: mid.res.pose }; } else hi = m;
        }
        hit = d.ok.res ? { res: d.ok.res, t: d.ok.t } : hit;
      }
      d.res = hit.res;
      d.cur = ok ? hit.res.pose : d.ok.pose;
      writePose(d.cur, false);
      if (ok) { d.status = statusOf(hit.res, h); return; }
      const mm = d.ok.t.distanceTo(d.target) * 1000;
      d.status = { ...statusOf(hit.res, h), reachable: false, state: "short", limited: false, amount: mm, unit: "mm", short: `${mm.toFixed(mm < 10 ? 1 : 0)} mm short`, message: "The pelvis cannot go further with the feet where they are: the legs have reached a limit of motion. Switch off \"Keep the feet in place\" to go on." };
    }
    function solveNow() {
      const d = st;
      if (!d) return;
      d.pending = false;
      d.raf = 0;
      const plan = d.plan(d.target, d.cur);
      if (plan.direct) { // the whole figure slides: no solver
        const { dx, dy, dz } = plan.direct, free = S.place.mode === "free";
        S.place.anchor = { x: d.place0.anchor.x + dx, z: d.place0.anchor.z + dz };
        d.cur = { root: { ...d.start.root, x: d.start.root.x + dx, z: d.start.root.z + dz, ...(free ? { y: d.start.root.y + dy } : {}) }, angles: d.start.angles };
        writePose(d.cur, false);
        if (!free) ground({ vertical: true });
        d.status = { handle: h.id, label: h.label, reachable: true, state: "ok", limited: false, amount: 0, unit: null, short: "", message: "", errors: {} };
      } else if (h.kind === "pelvis") {
        solvePelvis(d, plan);
      } else {
        const run = (from, extra) => d.sv.solve(from, plan.goals, { free: plan.free, reference: d.start, ...extra });
        const follow = (from) => run(from, { ...IK.DRAG_OPTIONS, ...(plan.options ?? {}) });
        const gliding = !!d.glide && d.target.distanceTo(d.glide.target) < RESCUE_MOVE;
        if (!gliding) d.glide = null;
        let res = null;
        if (gliding) {
          // on its way to a pose that reaches the target (below): a few degrees a frame, then the drag solver takes over again
          const step = stepToward(d.cur, d.glide.pose, GLIDE_DEG);
          d.cur = step.pose;
          if (step.done) { d.glide = null; res = follow(d.cur); d.cur = res.pose; }
          else res = { ...d.res, pose: d.cur, reachable: false, limited: true, clamped: [], provablyUnreachable: false };
        } else {
          res = follow(plan.start ?? d.cur);
          d.cur = res.pose;
          // A drag follows the previous frame, so it can end in a corner of the ranges (a straight arm dragged toward the shoulder: the elbow would have to bend first)
          // although the goal is within reach. When it is stuck there, look for a pose that does reach (a full solve with restarts, at most every 120 ms and
          // every 3 cm of the point) and glide to it instead of staying stuck.
          const stuck = !res.reachable && !res.provablyUnreachable && !res.limited;
          const now_ = sched.now();
          if (stuck && (!d.rescue || (now_ - d.rescue.t >= RESCUE_MS && d.target.distanceTo(d.rescue.at) >= RESCUE_MOVE))) {
            d.rescue = { t: now_, at: d.target.clone() };
            // from the pose the drag began with (the figure relaxed as the posture has it), not from the corner it is stuck in: the result is the more natural of the two
            const alt = run(plan.start ? { root: plan.start.root, angles: d.start.angles } : d.start, { restarts: RESCUE_RESTARTS, ...(plan.options ?? {}) });
            if (alt.reachable) {
              d.glide = { pose: alt.pose, target: d.target.clone() };
              const step = stepToward(d.cur, alt.pose, GLIDE_DEG);
              d.cur = step.pose;
              res = { ...res, pose: d.cur, limited: true, clamped: [], reachable: false };
              if (step.done) { d.glide = null; res = follow(d.cur); d.cur = res.pose; }
            }
          }
        }
        d.res = res;
        writePose(d.cur, false);
        d.status = statusOf(res, h);
      }
      d.status.target = d.target.toArray();
      d.moved = true;
      emit("drag", { phase: "move", handle: h.id, status: d.status });
    }
    return api;
  }
  /** After a drag: the support bookkeeping, one history step, the message. */
  function finishDrag(h, d, o) {
    const P = S.place;
    let note = "";
    if (d.moved) {
      if (P.mode !== "free") {
        if (h.kind === "foot" || (h.kind === "pelvis" && S.opts.pelvisMode === "bend")) {
          const primary = Object.keys(carriersOf())[0];
          if (h.kind === "pelvis" && primary !== "feet") { P.stick = false; note = "The pelvis was moved off its support, so Stay on the support was turned off."; } else captureAnchor();
        }
        if (P.stick) ground();
      }
      pushHistory(`Move ${h.label.toLowerCase()}`, o.key ?? null);
    }
    if (note && d.status) d.status = { ...d.status, note };
    syncPosture();
    emit("drag", { phase: "end", handle: h.id, status: d.status });
    emit("change", { reason: "drag", label: h.label });
    if (note) emit("place");
  }
  /** Nudge a handle by a vector in metres (the keyboard way to drag): one drag step, merged with the previous nudge of the same handle within 600 ms. */
  function nudgeHandle(id, delta) {
    const h = handleOf(id);
    if (!h) throw new RangeError(`unknown handle ${JSON.stringify(String(id).slice(0, 30))}`);
    const d = createDrag(h.id, { immediate: true }), p = handlePoint(h.id).clone();
    if (!d.begin(p)) return null;
    d.move(p.clone().add(vec(delta)));
    return d.end({ key: `nudge:${h.id}` });
  }
  /** Look at a world point now (head, neck and eyes by ik.js lookAt, the target stays as the look-at handle). Returns the drag status shape. */
  function lookAtPoint(point, { record = true } = {}) {
    if (!IK) return null;
    const sv = solver();
    if (!sv) return null;
    begin();
    const r = rig(), start = r.getPose(), t = vec(point);
    setLookTarget(t);
    const res = IK.lookAt(sv, start, t.toArray(), { trunk: S.opts.trunkAssist, reference: start });
    writePose(res.pose, false);
    const st = statusOf(res, HANDLE_BY_ID.gaze);
    afterEdit("Look at a point", null, { record, groundIt: false });
    return st;
  }
  /** Run the hot paths of the solver once so that the first drag is not janky (100 to 250 ms): call it when the page is idle. */
  function warmUp() { const sv = solver(); return sv && IK.warmUp ? IK.warmUp(sv, 1) : 0; }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------------------------------------------------
  function rigReplaced() {
    cancelDrag();
    cancelAnimation({ finish: false });
    gesture = null;
    solverRef = null;
    try { syncChair(); ground(); } catch (e) { console.warn("posture editor: the posture does not fit the new figure:", e); }
    syncPosture();
    emit("rig", {});
    emit("change", { reason: "rig" });
  }
  const offs = [];
  if (ctx?.on) {
    offs.push(ctx.on("rig", () => { try { rig(); } catch { /* no figure yet */ } }));
    offs.push(ctx.on("scene", () => { try { syncChair(); } catch { /* no figure */ } }));
  }
  function dispose() {
    if (disposed) return;
    cancelDrag();
    cancelAnimation({ finish: false });
    disposed = true;
    for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
    try { offRig?.(); } catch { /* gone */ }
    handlers.clear();
    options.onDispose?.();
  }

  const editor = {
    ready,
    get disposed() { return disposed; },
    on,
    // posture
    apply, neutral, resetToLibrary, mirror, copySide: copySideTo,
    getPosture: (id) => { const f = findPosture(id); return f ? copyPosture(f.posture) : null; },
    get base() { return { id: S.base.id, name: S.base.name, kind: S.base.kind }; },
    get modified() { return isModified(); },
    // editing
    setJoint, resetJoint, setRegion, setRoot, setHeading, setAnchor, setPose, setGrip, gripOf, setFingerAngle, setFingerCurl, fingerCurl,
    regionTotals: (region) => regionTotals(rig().angles, region),
    // placement
    setMode, setSeatHeight, useSeatOfPosture, sitOn, setSupport, setStick, setOption, get options() { return getOptions(); },
    get place() { return placeView(); },
    seatSurfaces: () => seatSurfaces(sandbox()),
    seatHeight: currentSeatHeight,
    ground: (o) => ground({ force: true, ...o }),
    // history
    undo, redo, get canUndo() { return hist.i > 0; }, get canRedo() { return hist.i < hist.stack.length - 1; }, get history() { return historyState(); },
    beginGesture, endGesture, commit: (label = "Edit", key = null) => pushHistory(label, key),
    cancelAnimation, get animating() { return !!anim; },
    // custom postures and files
    saveCustom, listCustom, deleteCustom, customProblems, importPosture, exportPosture, exportPostureText,
    get customPersistent() { return memoryText === null; },
    // readouts
    info, get clamps() { return S.clamps.slice(); },
    // IK
    handles, handlePoint, handleAvailable, createDrag, cancelDrag, nudgeHandle, lookAtPoint, setLookTarget, lookTarget, toggleLook, get lookActive() { return lookActive(); }, defaultLookTarget,
    get dragging() { return !!S.drag; }, get ikReady() { return !!IK; }, loadIk, warmUp,
    rigPoint: (id, out) => rig().landmarkWorld(id, out), sandbox,
    dispose,
  };
  return editor;
}

// ---------------------------------------------------------------------------------------------------------------------
// The handles in the 3D view: small shapes of constant screen size that follow the figure, picked in screen space (so a finger can hit them), dragged on a plane through the
// handle that faces the camera. The orbit controls are held while a handle is dragged; a press that is not on a handle is left to the viewport.
const DEFAULT_COLORS = Object.freeze({ hand: "#2a78d6", foot: "#1baf7a", pelvis: "#eda100", trunk: "#7c5cd6", gaze: "#e87ba4", pole: "#8a8983", bad: "#d6342a", outline: "#ffffff", select: "#1c5cab" });
const PRIORITY = Object.freeze({ reach: 0, foot: 0, gaze: 0, chest: 1, pelvis: 1, pole: 2 });
const PIXELS = Object.freeze({ sphere: 7, diamond: 6.5, cross: 9, ring: 0 }); // radius in pixels (0: a world size)
const RING_RADIUS = 0.12;

class ScreenSized extends THREE.Group {
  constructor(layer, px) { super(); this.layer = layer; this.px = px; this.boost = 1; }
  updateMatrixWorld(force) {
    const L = this.layer, cam = L.camera;
    if (this.px > 0 && cam) {
      const d = Math.max(0.05, cam.position.distanceTo(this.position)), perPx = (2 * Math.tan((cam.fov * Math.PI) / 360) * d) / Math.max(L.height(), 100);
      this.scale.setScalar(this.px * perPx * this.boost);
    } else this.scale.setScalar(RING_RADIUS * this.boost);
    super.updateMatrixWorld(force);
  }
}

/**
 * The layer of IK handles for a viewport and an editor: { group, update(), setEnabled(bool), setPoles(bool), setSelected(id), pick(clientX, clientY), setColors({ hand, foot, ... }), dispose() }.
 * `onSelect(id)` is called after a click or a drag on a handle (not after a keyboard nudge). Pointer events: viewport.on("pointerdown" / "pointermove" / "pointerup").
 */
export function createHandleLayer({ viewport, editor, colors = {}, onSelect = null, scheduler = {} }) {
  const raf = scheduler.raf ?? (typeof requestAnimationFrame === "function" ? (f) => requestAnimationFrame(f) : null);
  const caf = scheduler.caf ?? (typeof cancelAnimationFrame === "function" ? (i) => cancelAnimationFrame(i) : null);
  let palette = { ...DEFAULT_COLORS, ...colors };
  const group = new THREE.Group();
  group.name = "hm-posture-handles";
  group.renderOrder = 999;
  const layer = { camera: viewport.camera, height: () => viewport.canvas?.clientHeight || viewport.container?.clientHeight || 600 };
  const geo = {
    sphere: new THREE.SphereGeometry(1, 20, 14), diamond: new THREE.OctahedronGeometry(1.25),
    ring: new THREE.TorusGeometry(1, 0.07, 8, 48).rotateX(Math.PI / 2), bar: new THREE.BoxGeometry(2.6, 0.3, 0.3),
  };
  const items = new Map();
  let enabled = false, poles = true, selected = null, hover = null, bad = new Map(), dragging = null, pending = 0, disposed = false;
  const mats = [];
  const mat = (color, back = false) => { const m = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: back ? 0.92 : 0.97, side: back ? THREE.BackSide : THREE.FrontSide }); mats.push(m); return m; };
  function shapeMeshes(shape, material, outlineMaterial) {
    const make = (g, rot) => {
      const m = new THREE.Mesh(g, material), o = new THREE.Mesh(g, outlineMaterial);
      for (const x of [m, o]) { x.renderOrder = 1000; x.raycast = () => {}; x.frustumCulled = false; if (rot) x.rotation.set(...rot); }
      o.scale.setScalar(1.32);
      o.renderOrder = 999;
      return [o, m];
    };
    if (shape === "cross") return [...make(geo.bar), ...make(geo.bar, [0, 0, Math.PI / 2]), ...make(geo.bar, [0, Math.PI / 2, 0])];
    return make(geo[shape]);
  }
  for (const h of HANDLES) {
    const holder = new ScreenSized(layer, PIXELS[h.shape]), material = mat(palette[h.color]), outline = mat(palette.outline, true);
    holder.add(...shapeMeshes(h.shape, material, outline));
    holder.visible = false;
    holder.name = `handle-${h.id}`;
    group.add(holder);
    items.set(h.id, { h, holder, material, outline });
  }
  const gazeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]), new THREE.LineBasicMaterial({ color: palette.gaze, depthTest: false, transparent: true, opacity: 0.7 }));
  gazeLine.renderOrder = 998; gazeLine.frustumCulled = false; gazeLine.visible = false; gazeLine.raycast = () => {};
  group.add(gazeLine);
  viewport.add(group);

  const visible = (h) => enabled && editor.ikReady && (h.kind === "gaze" ? editor.lookActive : h.kind === "pole" ? poles : true);
  function paint(it) {
    const on = it.h.id;
    const state = dragging?.id === on ? "drag" : selected === on ? "select" : hover === on ? "hover" : "idle";
    it.holder.boost = state === "drag" ? 1.45 : state === "select" ? 1.35 : state === "hover" ? 1.2 : 1;
    it.material.color.set(bad.has(on) ? palette.bad : palette[it.h.color]);
    it.outline.color.set(state === "select" || state === "drag" ? palette.select : palette.outline);
  }
  const v1 = new THREE.Vector3();
  function update() {
    pending = 0;
    if (disposed) return;
    group.visible = enabled && editor.ikReady;
    if (!group.visible) { viewport.requestRender?.(); return; }
    try {
      for (const it of items.values()) {
        const vis = visible(it.h);
        it.holder.visible = vis;
        if (vis) editor.handlePoint(it.h.id, it.holder.position);
        paint(it);
      }
      const g = items.get("gaze").holder;
      gazeLine.visible = g.visible;
      if (g.visible) {
        const a = gazeLine.geometry.attributes.position;
        editor.rigPoint?.("eye_mid", v1);
        a.setXYZ(0, v1.x, v1.y, v1.z); a.setXYZ(1, g.position.x, g.position.y, g.position.z); a.needsUpdate = true;
        gazeLine.material.color.set(palette.gaze);
      }
    } catch { for (const it of items.values()) it.holder.visible = false; gazeLine.visible = false; } // no figure yet
    viewport.requestRender?.();
  }
  const schedule = () => { if (!pending && !disposed) { if (raf) pending = raf(update); else update(); } };

  /** The handle under a client position (CSS pixels), or null: the nearest within `radius` of its centre on the screen, the hands and feet before the poles. */
  function pick(clientX, clientY, radius = 14) {
    const cv = viewport.canvas;
    if (!cv || !enabled) return null;
    const rc = cv.getBoundingClientRect(), x = clientX - rc.left, y = clientY - rc.top, out = {};
    let best = null, score = Infinity;
    for (const it of items.values()) {
      if (!it.holder.visible) continue;
      const p = viewport.project(it.holder.position, out);
      if (!p.visible) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > (it.h.kind === "pole" ? radius * 0.85 : radius)) continue;
      const s = d + 5 * PRIORITY[it.h.kind];
      if (s < score) { score = s; best = it.h.id; }
    }
    return best;
  }

  // ---- pointer ----------------------------------------------------------------------------------------------------
  const plane = new THREE.Plane(), hit = new THREE.Vector3(), tmp = new THREE.Vector3(), cdir = new THREE.Vector3();
  function planeFor(h, p0) {
    if (h.kind === "pelvis" && editor.options.pelvisMode === "move" && editor.place.mode !== "free") return plane.setFromNormalAndCoplanarPoint(tmp.set(0, 1, 0), p0);
    return plane.setFromNormalAndCoplanarPoint(viewport.camera.getWorldDirection(cdir), p0);
  }
  const rayHit = (ev) => { const ray = viewport.ray(ev.clientX, ev.clientY).ray; return ray.intersectPlane(plane, hit) ? hit : null; };
  function holdOrbit() { if (viewport.controls) viewport.controls.enabled = false; }
  function releaseOrbit() { if (viewport.controls) viewport.controls.enabled = (viewport.active === undefined ? true : !!viewport.active) && !viewport.gizmoDragging; }
  function stopDrag(commit) {
    const d = dragging;
    if (!d) return;
    dragging = null;
    d.resume?.();
    try { viewport.canvas?.releasePointerCapture?.(d.pointerId); } catch { /* not captured */ }
    docEvents(false);
    releaseOrbit();
    viewport.setCursor?.(hover ? "pointer" : "grab");
    let status = null;
    if (commit) status = d.api.end(); else d.api.cancel();
    if (commit && onSelect) onSelect(d.id);
    schedule();
    return status;
  }
  const docEvents = (add) => { if (typeof document !== "undefined") document[add ? "addEventListener" : "removeEventListener"]("keydown", onKey, true); };
  function onKey(e) { if (e.key === "Escape" && dragging) { e.preventDefault(); e.stopPropagation(); stopDrag(false); } }
  function onDown(ev) {
    if (!enabled || !editor.ikReady || ev.button !== 0 || ev.originalEvent?.isPrimary === false) { stopDrag(false); return; }
    stopDrag(false);
    if (viewport.gizmoDragging) return;
    const id = pick(ev.clientX, ev.clientY, ev.pointerType === "touch" ? 26 : 14);
    if (!id) return;
    let api;
    try { api = editor.createDrag(id); const p0 = editor.handlePoint(id); planeFor(HANDLE_BY_ID[id], p0); const g = rayHit(ev) ?? p0; if (!api.begin(g.clone())) return; } catch (e) { console.warn("posture handles:", e); return; }
    holdOrbit();
    const sb = (typeof editor.sandbox === "function" ? editor.sandbox() : null);
    const resume = sb?.suspendInput?.() ?? null;
    try { if (ev.originalEvent?.pointerId != null) viewport.canvas?.setPointerCapture?.(ev.originalEvent.pointerId); } catch { /* not capturable */ }
    dragging = { id, api, x0: ev.clientX, y0: ev.clientY, moved: false, pointerId: ev.originalEvent?.pointerId, resume };
    docEvents(true);
    viewport.setCursor?.("grabbing");
    schedule();
  }
  function onMove(ev) {
    if (dragging) {
      if (!dragging.moved && Math.hypot(ev.clientX - dragging.x0, ev.clientY - dragging.y0) < 3) return;
      dragging.moved = true;
      const p = rayHit(ev);
      if (p) dragging.api.move(p);
      return;
    }
    if (ev.buttons || !enabled) return;
    const id = pick(ev.clientX, ev.clientY, ev.pointerType === "touch" ? 0 : 14);
    if (id !== hover) { hover = id; viewport.setCursor?.(id ? "pointer" : "grab"); schedule(); }
  }
  const onUp = () => { if (dragging) stopDrag(true); };
  const onCancel = () => { if (dragging) stopDrag(false); };
  const offs = [viewport.on("pointerdown", onDown), viewport.on("pointermove", onMove), viewport.on("pointerup", onUp), viewport.on("pointerleave", () => { if (hover) { hover = null; schedule(); } })];
  viewport.canvas?.addEventListener?.("pointercancel", onCancel, true);
  const offEd = [
    editor.on("change", (e) => { if (e?.reason !== "drag" && e?.reason !== "animation") bad.clear(); schedule(); }),
    editor.on("external", schedule), editor.on("look", schedule), editor.on("rig", schedule), editor.on("options", schedule),
    editor.on("drag", (e) => {
      if (e.phase === "cancel") bad.delete(e.handle);
      else if (e.status?.state === "short") bad.set(e.handle, e.status.short || "cannot reach"); else bad.delete(e.handle);
      schedule();
    }),
  ];
  viewport.addLabelSource?.("posture-handles", () => {
    if (!enabled) return [];
    const out = [];
    for (const id of new Set([hover, selected, dragging?.id])) {
      const it = id && items.get(id);
      if (!it || !it.holder.visible) continue;
      out.push({ id, text: bad.has(id) ? `${it.h.label}: ${bad.get(id)}` : it.h.label, position: it.holder.position.clone(), priority: 120, cls: "hm-label-handle", color: palette[it.h.color] });
    }
    return out;
  });

  const api = {
    group, items, update, pick,
    get enabled() { return enabled; },
    get dragging() { return !!dragging; },
    setEnabled(on_) { enabled = !!on_; if (!enabled) { stopDrag(false); hover = null; viewport.setCursor?.("grab"); } update(); },
    setPoles(on_) { poles = !!on_; update(); },
    setSelected(id) { selected = id && items.has(id) ? id : null; schedule(); },
    setColors(c) { palette = { ...palette, ...c }; update(); },
    /** Cancel a handle drag in progress (Esc, the tab was left). */
    cancel() { stopDrag(false); },
    dispose() {
      if (disposed) return;
      stopDrag(false);
      disposed = true;
      if (pending && caf) caf(pending);
      for (const f of [...offs, ...offEd]) { try { f(); } catch { /* gone */ } }
      viewport.canvas?.removeEventListener?.("pointercancel", onCancel, true);
      viewport.removeLabelSource?.("posture-handles");
      viewport.remove?.(group);
      for (const g of Object.values(geo)) g.dispose();
      for (const m of mats) m.dispose();
      gazeLine.geometry.dispose(); gazeLine.material.dispose();
      docEvents(false);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------------
// One editor per viewport, reachable from any panel (each panel has a ctx of its own, so ctx.posture cannot be shared by assignment)
const registry = new WeakMap();
/**
 * The posture editor of a ctx's viewport, created on first use. Also set as ctx.posture and (non-enumerable) ctx.state.postureEditor, so that the Scene, Analysis and
 * Export panels can reach it: `import { editorFor } from "../editor.js"; editorFor(ctx).apply("sit-upright-90")`.
 */
export function editorFor(ctx, options = {}) {
  const key = ctx?.viewport ?? ctx;
  if (!key || typeof ctx?.getRig !== "function") throw new TypeError("editorFor: expected the panel ctx of the shell");
  let ed = registry.get(key);
  if (!ed || ed.disposed) {
    ed = createEditor({ getRig: () => ctx.getRig(), getBody: () => ctx.getBody(), viewport: ctx.viewport, ctx, ...options, onDispose: () => { if (registry.get(key) === ed) registry.delete(key); options.onDispose?.(); } });
    registry.set(key, ed);
  }
  try { ctx.posture = ed; } catch { /* a frozen ctx */ }
  try { if (ctx.state && ctx.state.postureEditor !== ed) Object.defineProperty(ctx.state, "postureEditor", { value: ed, configurable: true, writable: true, enumerable: false }); } catch { /* state is not extensible */ }
  return ed;
}
/** The posture editor of a viewport or ctx if it exists (never creates one). */
export const peekEditor = (vpOrCtx) => registry.get(vpOrCtx?.viewport ?? vpOrCtx) ?? null;
