// Whole-body inverse kinematics on the 77-joint rig: reach a point with a hand, put a foot on a pedal, look at a display, move the pelvis
// while the feet stay. Pure (three, skeleton.js, fk.js, pose.js figureOf); it works on the numerical truth (Kinematics), never on the scene graph.
// Manual: docs/human3d/IK.md. Tests: tests/human3d/ik.test.mjs.
//
// Method. Damped least squares (Levenberg-Marquardt with Nielsen's gain-ratio rule, Wampler / Nakamura) on the degrees of freedom of the FREE joints:
//   F(x) = 1/2 |r(x)|^2 + mu/2 sum_k s_k (x_k - x0_k)^2 [+ reference pull] [+ elbow / knee pole]     r = weighted goal residuals (metres; angles
//   scaled by `angleScale` metres per radian)
// * s_k = (cost length c_k)^2: the "stiffness" of a variable, c_k in metres of goal error per radian of motion, small for distal joints
//   (wrist, elbow, shoulder), larger for the clavicle and the spine regions, so a reaching hand uses the arm first, then the clavicle, then the trunk;
// * hard joint limits by an active set (a variable at a limit whose gradient pushes outward is frozen for the step; variables that would cross a limit
//   are clipped and frozen and the step is re-solved); the 180 degree cap of the combined swing of the shoulder is a constraint of the step as well
//   (a stiff penalty on its radial direction while it is active), then a projection;
// * spine REGIONS are variables (lumbar / thoracic / cervical totals per channel) spread over the vertebrae with the REGIONS weights and exact
//   water-filling at the per-vertebra limits, on top of whatever the vertebrae already have;
// * the Jacobian is geometric (a deviation from "forward differences on Kinematics.solve", for speed): one Kinematics.solve per iteration plus the
//   closed-form angular velocity of every free DOF (the derivative of q = exp(swing) * twist is the left Jacobian of SO(3) applied to the DOF axis), so a
//   column costs a few dozen flops instead of a forward pass (forward differences need 50 passes, about 0.9 ms at 17 microseconds each, per
//   iteration of a whole-body problem; a whole-body solve from standing takes 4 ms in all). tests/human3d/ik.test.mjs checks every kind of column
//   against finite differences of the forward kinematics (agreement 1e-9);
// * the soft preferences (stiffness, reference pull, pole) are scaled by mu. When the penalised problem is stationary and a goal is still out of
//   tolerance, mu is divided by 10 (up to three times) and the iteration goes on: the posture stays as close to the start as the goals allow, and the
//   goals are met to the tolerance when they can be met at all;
// * a start that fails (a local minimum at the joint limits, an arm that has to go over the head) is retried: the analytic two-bone solution
//   (shoulder-elbow-wrist, hip-knee-ankle, elbow / knee toward a pole direction, swivel sampled inside the range of motion), then random poses ranked by
//   cost, deterministically (seeded). A reach bound (a straight chain of the free joints) tells goals that no pose can reach: no restarts for those.
// Everything in solve() is deterministic. The iteration loop works on preallocated typed arrays (under 0.3 KB of garbage per iteration, measured); the
// set-up of a solve and its Result allocate some 100 KB.
//
// Conventions: world metres, +Y up, +Z anterior, +X the figure's left (DESIGN.md 0); angles in degrees at the API, radians inside; a pose is
// { root: { x, y, z, heading, flex, lat, rot }, angles: { [jointId]: number[] } } exactly as rig.getPose() returns it.
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, REGIONS, clampAngles, anglesFromQuaternion, checkedAngles, checkRoot } from "./skeleton.js";
import { Kinematics } from "./fk.js";
import { figureOf } from "./pose.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI, PI = Math.PI;
const N = JOINTS.length;
const IDS = JOINTS.map((j) => j.id);
const INDEX = new Map(IDS.map((id, i) => [id, i]));
const PARENT = Int16Array.from(JOINTS.map((j) => (j.parent == null ? -1 : INDEX.get(j.parent))));
const NDOF = Int8Array.from(JOINTS.map((j) => j.dof.length));
const ANC = new Uint8Array(N * N); // ANC[a * N + b] = 1 when joint a is b or an ancestor of b
for (let b = 0; b < N; b++) for (let a = b; a >= 0; a = PARENT[a]) ANC[a * N + b] = 1;
const now = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const nz = (x) => (x === 0 ? 0 : x);

// ---------------------------------------------------------------------------------------------------------------------
// Tables: spine regions, free-joint groups, stiffness
const REGION_IDS = ["lumbar", "thoracic", "cervical"];
const REGION = REGION_IDS.map((name) => {
  const rg = REGIONS[name], ji = rg.joints.map((id) => INDEX.get(id));
  return {
    name, ji, n: ji.length,
    w: [rg.weights, rg.weightsLat, rg.weightsRot].map((a) => Float64Array.from(a)),
    lo: [0, 1, 2].map((c) => Float64Array.from(ji.map((j) => JOINTS[j].dof[c].min * D2R))),
    hi: [0, 1, 2].map((c) => Float64Array.from(ji.map((j) => JOINTS[j].dof[c].max * D2R))),
  };
});
const REGION_OF = new Int8Array(N).fill(-1);
REGION.forEach((r, k) => r.ji.forEach((j) => { REGION_OF[j] = k; }));
const CHAN = ["flex", "lat", "rot"];
const MAXV = 12; // most vertebrae in a region

// Joints whose box of swing DOF reaches beyond the 180 degree cap of clampAngles (only the shoulders do)
const CAP_JOINTS = JOINTS.map((j, i) => [j, i]).filter(([j]) => Math.hypot(...j.dof.filter((d) => d.role !== 'twist').map((d) => Math.max(Math.abs(d.min), Math.abs(d.max)))) > 180).map(([, i]) => i);
const SIDES = ["L", "R"];
const baseName = (id) => (id.endsWith("_L") || id.endsWith("_R") ? id.slice(0, -2) : id);
const isFinger = (j) => j.group === "hand";
const GROUP = {};
for (const s of SIDES) {
  GROUP[`arm_${s}`] = [`shoulder_${s}`, `elbow_${s}`, `forearm_${s}`, `wrist_${s}`];
  GROUP[`clavicle_${s}`] = [`clavicle_${s}`];
  GROUP[`hand_${s}`] = JOINTS.filter((j) => isFinger(j) && j.side === s).map((j) => j.id);
  GROUP[`leg_${s}`] = [`hip_${s}`, `knee_${s}`, `ankle_${s}`];
  GROUP[`toes_${s}`] = [`mtp_${s}`];
  GROUP[`eye_${s}`] = [`eye_${s}`];
}
GROUP.arms = [...GROUP.arm_L, ...GROUP.arm_R];
GROUP.clavicles = ["clavicle_L", "clavicle_R"];
GROUP.legs = [...GROUP.leg_L, ...GROUP.leg_R];
GROUP.hands = [...GROUP.hand_L, ...GROUP.hand_R];
GROUP.head = ["head"];
GROUP.eyes = ["eye_L", "eye_R"];
GROUP.jaw = ["jaw"];
// region groups (the names of REGION_IDS are groups too) and root groups
const REGION_GROUP = { lumbar: [0], thoracic: [1], cervical: [2], trunk: [0, 1], spine: [0, 1, 2] };
const ROOT_GROUP = {
  "pelvis-y": [1], "pelvis-xz": [0, 2], "pelvis-xyz": [0, 1, 2], "pelvis-heading": [3], "pelvis-tilt": [4, 5, 6], "pelvis-rot": [3, 4, 5, 6],
}; // indices into the root fields x y z heading flex lat rot
const ALL_GROUPS = ["arms", "clavicles", "legs", "neck", "eyes", "trunk"]; // 'all'

/**
 * Options for a live drag: no restarts (the previous pose is the right basin, so a goal beyond the reach costs one run, not nine) and a short iteration budget.
 * solver.solve(pose, goals, { ...DRAG_OPTIONS, free }) ; call again without them when the drag ends if the result must be as good as the solver can make it.
 */
export const DRAG_OPTIONS = Object.freeze({ restarts: 0, maxIterations: 24 });

/** Names accepted by options.free / options.lock besides joint ids ("elbow_R") and joint.dof ("shoulder_R.rot"). */
export const FREE_GROUPS = Object.freeze([
  "auto", "all", "arm_L", "arm_R", "arms", "clavicle_L", "clavicle_R", "clavicles", "hand_L", "hand_R", "hands", "leg_L", "leg_R", "legs", "toes_L", "toes_R",
  "trunk", "lumbar", "thoracic", "cervical", "spine", "neck", "head", "eye_L", "eye_R", "eyes", "jaw", "pelvis-y", "pelvis-xz", "pelvis-xyz", "pelvis-heading", "pelvis-tilt", "pelvis-rot",
]);

// Cost length c (metres of goal error per radian of motion; the stiffness is c^2). Distal joints are cheap, proximal ones and the spine dear.
const COST = {
  shoulder: 0.004, elbow: 0.004, forearm: 0.006, wrist: 0.005, hand: 0.004, clavicle: 0.012,
  hip: 0.006, knee: 0.005, ankle: 0.006, mtp: 0.01, head: 0.008, eye: 0.06, jaw: 0.01,
  vertebra: 0.04, lumbar: 0.03, thoracic: 0.03, cervical: 0.012,
  tx: 0.15, ty: 0.05, tz: 0.15, heading: 0.03, tilt: 0.03, // pelvis: metres per metre (a step is the last resort, a squat is cheaper), radians
};
const DOF_FACTOR = { "shoulder.rot": 1.5, "hip.rot": 1.5, "knee.rot": 2, "ankle.inv": 2, "ankle.rot": 2, "wrist.dev": 1.2, "hip.abd": 1.2 };
function costOf(jd, d) {
  const b = baseName(jd.id);
  const base = isFinger(jd) ? COST.hand : REGION_OF[INDEX.get(jd.id)] >= 0 ? COST.vertebra : COST[b] ?? 0.02;
  return base * (DOF_FACTOR[`${b}.${jd.dof[d].key}`] ?? 1);
}

// Default pole directions (body frame, +x = the figure's left; rotated by the heading of the pelvis at solve time): elbows down, out and a little back,
// knees forward and a little outward (the line of the toes).
const POLE_BODY = {
  elbow: (s) => [0.4 * (s === "L" ? 1 : -1), -1, -0.5],
  knee: (s) => [0.15 * (s === "L" ? 1 : -1), 0, 1],
};
const LIMBS = [];
for (const s of SIDES) {
  LIMBS.push({ name: `elbow_${s}`, kind: "elbow", side: s, u: INDEX.get(`shoulder_${s}`), m: INDEX.get(`elbow_${s}`), e: INDEX.get(`wrist_${s}`) });
  LIMBS.push({ name: `knee_${s}`, kind: "knee", side: s, u: INDEX.get(`hip_${s}`), m: INDEX.get(`knee_${s}`), e: INDEX.get(`ankle_${s}`) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
function vec3(v, what) {
  const a = Array.isArray(v) || ArrayBuffer.isView(v) ? v : v !== null && typeof v === "object" ? [v.x, v.y, v.z] : null;
  if (!a || a.length !== 3) throw new TypeError(`${what} must be [x, y, z] (metres)`);
  if (!isNum(a[0]) || !isNum(a[1]) || !isNum(a[2])) throw new RangeError(`${what} must be three finite numbers, got ${JSON.stringify([a[0], a[1], a[2]])}`);
  return [a[0], a[1], a[2]];
}
function unit3(v, what) {
  const a = vec3(v, what), l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 1e-12)) throw new RangeError(`${what} must not be the zero vector`);
  return [a[0] / l, a[1] / l, a[2] / l];
}
function mulberry32(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function angleBetween(ax, ay, az, bx, by, bz) {
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
}

// ---------------------------------------------------------------------------------------------------------------------
// Water-filling of a region total over the vertebrae of one channel. delta_i = share of T (radians), within [A_i, B_i] (A_i <= 0 <= B_i: the
// room each vertebra has below / above its start value); shares follow the weights, a vertebra at its limit takes no more and the rest goes to the
// others. For a total of one sign only one side of the boxes can bind, so pinning level after level is exact. `dw` receives d delta_i / dT.
function fillRegion(T, w, A, B, n, out, dw, o = 0) {
  const pos = T >= 0;
  let rest = T;
  for (let i = 0; i < n; i++) { out[o + i] = 0; dw[o + i] = 1; }
  for (let pass = 0; pass <= n; pass++) {
    let ws = 0;
    for (let i = 0; i < n; i++) if (dw[o + i] === 1) ws += w[i];
    if (!(ws > 1e-15)) { for (let i = 0; i < n; i++) if (dw[o + i] === 1) dw[o + i] = 0; break; }
    let pinned = false, used = 0;
    for (let i = 0; i < n; i++) {
      if (dw[o + i] !== 1) continue;
      const share = (rest * w[i]) / ws, cap = pos ? B[i] : A[i];
      if (pos ? share > cap + 1e-15 : share < cap - 1e-15) { out[o + i] = cap; dw[o + i] = 2; used += cap; pinned = true; }
    }
    if (!pinned) {
      for (let i = 0; i < n; i++) if (dw[o + i] === 1) { out[o + i] = (rest * w[i]) / ws; dw[o + i] = w[i] / ws; }
      break;
    }
    rest -= used;
    for (let i = 0; i < n; i++) if (dw[o + i] === 2) dw[o + i] = 3; // pinned for good
  }
  for (let i = 0; i < n; i++) if (dw[o + i] === 2 || dw[o + i] === 3) dw[o + i] = 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// createSolver
/**
 * A solver for one body (fit.js BodyModel, or rig.restBody). Caches the kinematics and the landmark table, so make one per body and keep it.
 * solver.solve(start, goals, options) -> Result; see docs/human3d/IK.md for the goal types, the options and the Result.
 */
export function createSolver(body) {
  if (body === null || typeof body !== "object" || body.joints == null || body.landmarks == null) throw new TypeError("createSolver: body must be a BodyModel (fit.js fitBody) or rig.restBody");
  const fig = figureOf(body); // the figure the rig draws (forearm twist axis at the wrist, sternum on T4): the same numbers as rig.kin
  const offsets = {};
  for (const j of JOINTS) if (j.parent) offsets[j.id] = Array.from(fig.joints[j.id].offset).slice(0, 3);
  const kin = new Kinematics(offsets);
  kin.strict = false;
  const lm = new Map();
  for (const [id, l] of Object.entries(fig.landmarks)) {
    const ji = INDEX.get(l.joint);
    if (ji !== undefined) lm.set(id, { ji, off: Float64Array.from(Array.from(l.offset).slice(0, 3)) });
  }
  for (const s of SIDES) { // virtual points: the centre of the ball of the foot
    const a = lm.get(`ball_sole_medial_${s}`), b = lm.get(`ball_sole_lateral_${s}`);
    if (a && b && a.ji === b.ji) lm.set(`ball_centre_${s}`, { ji: a.ji, off: Float64Array.from([0, 1, 2].map((k) => 0.5 * (a.off[k] + b.off[k]))) });
  }
  const restRootY = fig.joints.pelvis.offset[1];
  const S = { kin, lm, restRootY, ang: {}, angArr: [], root: { x: 0, y: 0, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 } };
  for (let i = 0; i < N; i++) { S.angArr.push(new Float64Array(NDOF[i])); S.ang[IDS[i]] = S.angArr[i]; } // typed: V8 never boxes a read of them in Kinematics.solve

  // neutral geometry: hand frames (wrist-local = neutral world), limb lengths and rest bends
  const A0 = {};
  for (const j of JOINTS) A0[j.id] = j.dof.map(() => 0);
  kin.solve(A0, { x: 0, y: restRootY, z: 0 });
  const P0 = Float64Array.from(kin.positions);
  const pos0 = (id) => { const i = 3 * INDEX.get(id); return [P0[i], P0[i + 1], P0[i + 2]]; };
  S.hand = {};
  for (const s of SIDES) {
    const w = pos0(`wrist_${s}`), idx = pos0(`index_mcp_${s}`), lit = pos0(`little_mcp_${s}`), mid = pos0(`middle_mcp_${s}`), rin = pos0(`ring_mcp_${s}`);
    const across = norm3(sub3(idx, lit));
    const mean = [0, 1, 2].map((k) => (idx[k] + lit[k] + mid[k] + rin[k]) / 4);
    let f = sub3(mean, w);
    const d = dot3(f, across);
    f = norm3([f[0] - d * across[0], f[1] - d * across[1], f[2] - d * across[2]]);
    let n = norm3(cross3(f, across));
    if (n[0] * w[0] > 0) n = [-n[0], -n[1], -n[2]]; // the palm faces the midline in the neutral pose
    S.hand[s] = { finger: f, across, normal: n };
  }
  S.limbs = LIMBS.map((L) => {
    const U = pos0(IDS[L.u]), M = pos0(IDS[L.m]), E = pos0(IDS[L.e]);
    const a = sub3(M, U), b = sub3(E, M);
    return { ...L, L1: Math.hypot(...a), L2: Math.hypot(...b), beta0: angleBetween(...a, ...b) * R2D };
  });
  S.axes = new Map(); // named local axes per joint index
  for (let i = 0; i < N; i++) {
    const id = IDS[i], s = JOINTS[i].side;
    let ax = { forward: [0, 0, 1], up: [0, 1, 0], left: [1, 0, 0] };
    if (id.startsWith("wrist_")) ax = { palm_normal: S.hand[s].normal, finger_axis: S.hand[s].finger, hand_across: S.hand[s].across };
    else if (id.startsWith("ankle_") || id.startsWith("mtp_")) ax = { foot_forward: [0, 0, 1], foot_up: [0, 1, 0], sole_normal: [0, -1, 0] };
    else if (id === "head" || id.startsWith("eye_")) ax = { gaze: [0, 0, 1], head_up: [0, 1, 0] };
    S.axes.set(i, ax);
  }

  const solver = {
    /** The figure (same object for a given body) and the rest root of a standing body. */
    body: fig,
    restRoot: Object.freeze({ x: 0, y: restRootY, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }),
    /** Landmark ids and virtual points (`ball_centre_L/R`) a goal may name. */
    landmarkIds: Object.freeze([...lm.keys()]),
    solve: (start, goals, options) => solveImpl(S, start, goals, options),
    /** World position of a landmark id, or of { joint, local } in a pose (strict: validates the pose). */
    worldPoint: (pose, point, out = new THREE.Vector3()) => worldPointImpl(S, pose, point, out),
    /** Named hand axes of the neutral pose, in the wrist frame: { finger, across, normal } per side (unit vectors). */
    handFrame: (side) => { const h = S.hand[sideOf(side)]; return { finger: [...h.finger], across: [...h.across], normal: [...h.normal] }; },
    /** Diagnostics: the Jacobian the solver uses, { names, rows, J (row-major m x n), r, x, poseAt(x) }. Used by the tests. */
    jacobian: (start, goals, options) => jacobianImpl(S, start, goals, options),
    /** Random in-ROM poses of an arm (and the trunk): end points, bounds and convex hull of the reachable region. See reachEnvelope(). */
    reachEnvelope: (start, side, options) => envelopeImpl(S, start, side, options),
  };
  return Object.freeze(solver);
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function sideOf(side) {
  if (side === "L" || side === "R") return side;
  if (typeof side === "string" && (side.toLowerCase() === "left" || side.toLowerCase() === "right")) return side[0].toUpperCase();
  throw new Error(`side must be "L" or "R", got ${JSON.stringify(side)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Pose input
function loadStart(S, start) {
  if (start === null || typeof start !== "object") throw new TypeError("start must be a pose { root, angles } (what rig.getPose() returns)");
  const root = S.root;
  const r = start.root ?? null;
  if (r === null) { Object.assign(root, { x: 0, y: S.restRootY, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }); } else {
    if (typeof r !== "object") throw new TypeError("start.root must be an object { x, y, z, heading, flex, lat, rot }");
    for (const k of Object.keys(r)) if (!["x", "y", "z", "heading", "flex", "lat", "rot"].includes(k)) throw new Error(`start.root: unknown field "${k}"`);
    checkRoot(r);
    root.x = r.x ?? 0; root.y = r.y ?? 0; root.z = r.z ?? 0; root.heading = r.heading ?? 0; root.flex = r.flex ?? 0; root.lat = r.lat ?? 0; root.rot = r.rot ?? 0;
  }
  for (let i = 0; i < N; i++) S.angArr[i].fill(0);
  const a = start.angles ?? {};
  if (typeof a !== "object") throw new TypeError("start.angles must be an object { jointId: [degrees] }");
  const scratch = new Float64Array(3);
  for (const id of Object.keys(a)) {
    const i = INDEX.get(id);
    if (i === undefined) throw new Error(`start.angles: unknown joint id "${id}"`);
    const v = a[id];
    if (v === null || typeof v !== "object" || typeof v.length !== "number") throw new TypeError(`start.angles.${id} must be an array in DOF order (${JOINTS[i].dof.map((d) => d.key).join(", ")})`);
    const c = checkedAngles(JOINTS[i], v, scratch);
    for (let k = 0; k < NDOF[i]; k++) S.angArr[i][k] = k < c.length ? c[k] : 0;
  }
}

function worldPointImpl(S, pose, point, out) {
  loadStart(S, pose);
  S.kin.solve(S.ang, S.root);
  const p = pointOf(S, typeof point === "string" ? { landmark: point } : point, "worldPoint");
  return toWorld(S.kin, p.ji, p.off, out);
}
function toWorld(kin, ji, off, out) {
  const P = kin.positions, Q = kin.quaternions, i3 = 3 * ji, i4 = 4 * ji, vx = off[0], vy = off[1], vz = off[2];
  const x = Q[i4], y = Q[i4 + 1], z = Q[i4 + 2], w = Q[i4 + 3];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return out.set(P[i3] + vx + w * tx + (y * tz - z * ty), P[i3 + 1] + vy + w * ty + (z * tx - x * tz), P[i3 + 2] + vz + w * tz + (x * ty - y * tx));
}
function pointOf(S, g, what) {
  if (g.landmark != null) {
    const e = S.lm.get(g.landmark);
    if (!e) throw new Error(`${what}: unknown landmark "${g.landmark}"`);
    return { ji: e.ji, off: e.off, name: g.landmark };
  }
  if (g.joint != null) {
    const ji = INDEX.get(g.joint);
    if (ji === undefined) throw new Error(`${what}: unknown joint "${g.joint}"`);
    return { ji, off: g.local != null ? Float64Array.from(vec3(g.local, `${what}.local`)) : new Float64Array(3), name: g.joint };
  }
  throw new Error(`${what}: needs a landmark id or a joint (with an optional local offset)`);
}
function localDir(S, ji, spec, what) {
  if (typeof spec === "string") {
    const a = S.axes.get(ji)[spec];
    if (!a) throw new Error(`${what}: "${spec}" is not a named axis of ${IDS[ji]} (known: ${Object.keys(S.axes.get(ji)).join(", ")})`);
    return a.slice();
  }
  return unit3(spec, what);
}

// ---------------------------------------------------------------------------------------------------------------------
// Goals
const DEFAULT_TOL = 5e-4, DEFAULT_ANG_TOL = 2e-3;
const T_POS = 0, T_HEIGHT = 1, T_DIR = 2, T_AIM = 3, T_POLE = 4;
const TERM_ROWS = [3, 1, 3, 3, 3];

/**
 * Turn the user's goals into terms. A term is one residual block: position (3 rows), height along a direction (1), direction (3), aim (3).
 * Every term belongs to a reported slot (an entry of Result.error). Pins take their target from the start pose.
 */
function compileGoals(P, goals, options) {
  const S = P.S, terms = [], slots = [], ids = new Set();
  if (!Array.isArray(goals)) throw new TypeError("goals must be an array");
  const angTol = options.angTolerance ?? DEFAULT_ANG_TOL, posTol = options.tolerance ?? DEFAULT_TOL;
  if (!(posTol > 0) || !(angTol > 0)) throw new RangeError("tolerance and angTolerance must be positive");
  const uniq = (base) => { let id = base, k = 2; while (ids.has(id)) id = `${base}#${k++}`; ids.add(id); return id; };
  const slot = (id, unit, tol) => { slots.push({ id, unit, tol, err: 0 }); return slots.length - 1; };
  const needStartFK = goals.some((g) => g && g.type === "pin" && g.target == null);
  if (needStartFK) S.kin.solve(S.ang, S.root);
  goals.forEach((g, gi) => {
    if (g === null || typeof g !== "object") throw new TypeError(`goal ${gi} must be an object`);
    const type = g.type ?? "position";
    const idBase = g.id ?? g.landmark ?? g.joint ?? type;
    if (typeof idBase !== "string" || idBase === "") throw new TypeError(`goal ${gi}: id must be a non-empty string`);
    const id = uniq(String(idBase));
    const what = `goal "${id}"`;
    const weight = g.weight ?? (type === "pin" ? 100 : 1);
    if (!isNum(weight) || weight < 0) throw new RangeError(`${what}: weight must be a number >= 0`);
    if (weight === 0) return;
    // `tolerance` is in the unit of the goal's error: metres for a point, radians for a direction, an aim, a look-at, a frame without a position;
    // `angTolerance` is the radians of the orientation of a frame that also has a position. A pin is meant to stay put: five times tighter.
    const angular = type === "direction" || type === "aim" || type === "lookAt" || (type === "frame" && g.target == null);
    const tol = angular ? posTol : g.tolerance ?? (type === "pin" ? 0.2 * posTol : posTol);
    const atol = g.angTolerance ?? (angular ? g.tolerance : undefined) ?? angTol;
    if (!(tol > 0) || !(atol > 0)) throw new RangeError(`${what}: tolerance must be positive`);
    const add = (t) => terms.push({ w: weight, ...t });
    const aimTerm = (pt, dirSpec, target, sl) => add({ kind: T_AIM, ji: pt.ji, off: pt.off, dir: localDir(S, pt.ji, dirSpec, `${what}.axis`), tgt: target, slot: sl });
    switch (type) {
      case "position": case "pin": {
        const pt = pointOf(S, g, what);
        let target;
        if (g.target != null) target = vec3(g.target, `${what}.target`);
        else if (type === "pin") { const v = toWorld(S.kin, pt.ji, pt.off, new THREE.Vector3()); target = [v.x, v.y, v.z]; } else throw new Error(`${what}: a position goal needs a target [x, y, z]`);
        add({ kind: T_POS, ji: pt.ji, off: pt.off, tgt: target, slot: slot(id, "m", tol) });
        break;
      }
      case "height": {
        const pt = pointOf(S, g, what);
        if (!isNum(g.height)) throw new TypeError(`${what}: a height goal needs height (metres along the direction, default up)`);
        const n = g.direction != null ? unit3(g.direction, `${what}.direction`) : [0, 1, 0];
        add({ kind: T_HEIGHT, ji: pt.ji, off: pt.off, dir: n, tgt: [n[0] * g.height, n[1] * g.height, n[2] * g.height], slot: slot(id, "m", tol) });
        break;
      }
      case "direction": {
        const ji = g.joint != null ? INDEX.get(g.joint) : g.landmark != null ? S.lm.get(g.landmark)?.ji : undefined;
        if (ji === undefined) throw new Error(`${what}: a direction goal needs a joint`);
        add({ kind: T_DIR, ji, dir: localDir(S, ji, g.axis ?? g.local, `${what}.axis`), tgt: unit3(g.target, `${what}.target`), line: !!g.line, slot: slot(id, "rad", atol) });
        break;
      }
      case "aim": {
        const pt = pointOf(S, g, what);
        aimTerm(pt, g.axis ?? [0, 0, 1], vec3(g.target, `${what}.target`), slot(id, "rad", atol));
        break;
      }
      case "lookAt": {
        const target = vec3(g.target, `${what}.target`), sl = slot(id, "rad", atol);
        if (g.eyes === false) {
          const p = S.lm.get("eye_mid");
          if (!p) throw new Error(`${what}: the body has no eye_mid landmark`);
          aimTerm({ ji: p.ji, off: p.off }, "gaze", target, sl);
        } else {
          for (const s of SIDES) {
            const p = S.lm.get(`pupil_${s}`);
            if (!p) throw new Error(`${what}: the body has no pupil_${s} landmark`);
            aimTerm({ ji: p.ji, off: p.off }, "gaze", target, sl);
          }
        }
        break;
      }
      case "frame": {
        const hasPoint = g.target != null;
        const ji = g.joint != null ? INDEX.get(g.joint) : g.landmark != null ? S.lm.get(g.landmark)?.ji : undefined;
        if (ji === undefined) throw new Error(`${what}: a frame goal needs a joint (the frame it orients) or a landmark`);
        if (hasPoint) {
          const pt = pointOf(S, g.landmark != null || g.local != null ? g : { joint: IDS[ji] }, what);
          add({ kind: T_POS, ji: pt.ji, off: pt.off, tgt: vec3(g.target, `${what}.target`), slot: slot(id, "m", tol) });
        }
        const axes = frameAxes(g, what);
        if (!axes.length && !hasPoint) throw new Error(`${what}: a frame goal needs axes, a quaternion or a frame { x, y, z }, or a target`);
        if (axes.length) {
          const sl = slot(hasPoint ? `${id}.rot` : id, "rad", atol);
          for (const a of axes) add({ kind: T_DIR, ji, dir: localDir(S, ji, a.local, `${what}.axes.local`), tgt: unit3(a.world, `${what}.axes.world`), line: !!a.line, w: weight * (a.weight ?? 1), slot: sl });
        }
        break;
      }
      default:
        throw new Error(`${what}: unknown goal type "${type}" (position, pin, height, direction, aim, lookAt, frame)`);
    }
  });
  P.terms = terms;
  P.slots = slots;
}

function frameAxes(g, what) {
  if (Array.isArray(g.axes)) return g.axes.map((a, i) => { if (a == null || typeof a !== "object") throw new TypeError(`${what}.axes[${i}] must be { local, world }`); return a; });
  const q = g.quaternion;
  if (q != null) {
    const Q = Array.isArray(q) || ArrayBuffer.isView(q) ? new THREE.Quaternion(q[0], q[1], q[2], q[3]) : new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (![Q.x, Q.y, Q.z, Q.w].every(isNum) || Q.lengthSq() < 1e-12) throw new RangeError(`${what}.quaternion must be four finite numbers, not all zero`);
    Q.normalize();
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((l) => ({ local: l, world: new THREE.Vector3(...l).applyQuaternion(Q).toArray() }));
  }
  if (g.frame != null) return ["x", "y", "z"].filter((k) => g.frame[k] != null).map((k) => ({ local: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[k], world: g.frame[k] }));
  return [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables: which DOF move
function parseName(name, what) {
  if (typeof name !== "string") throw new TypeError(`${what} entries must be strings (group names or joint ids)`);
  return name;
}
function applyNames(S, flags, names, value, what, goalJoints) {
  // flags: { dof: Uint8Array(N*3), reg: Uint8Array(9), root: Uint8Array(7) }
  const setJoint = (id, dofKey) => {
    const i = INDEX.get(id);
    if (i === undefined) return false;
    for (let d = 0; d < NDOF[i]; d++) if (dofKey == null || JOINTS[i].dof[d].key === dofKey) { flags.dof[i * 3 + d] = value; if (!value) flags.locked[i * 3 + d] = 1; }
    return true;
  };
  const setRegion = (r, chan) => { for (const c of chan == null ? [0, 1, 2] : [chan]) flags.reg[r * 3 + c] = value; };
  for (const raw of names) {
    const name = parseName(raw, what);
    if (name === "auto") { // joints on the chains to the goal points (the pelvis excluded)
      for (let i = 1; i < N; i++) {
        if (!goalJoints.some((g) => ANC[i * N + g])) continue;
        if (REGION_OF[i] >= 0) setRegion(REGION_OF[i]); else setJoint(IDS[i]);
      }
      continue;
    }
    if (name === "all") { applyNames(S, flags, ALL_GROUPS, value, what, goalJoints); continue; }
    if (name === "neck") { setRegion(2); setJoint("head"); continue; }
    if (Object.hasOwn(REGION_GROUP, name)) { for (const r of REGION_GROUP[name]) setRegion(r); continue; }
    if (Object.hasOwn(ROOT_GROUP, name)) { for (const k of ROOT_GROUP[name]) flags.root[k] = value; continue; }
    if (Object.hasOwn(GROUP, name)) { for (const id of GROUP[name]) setJoint(id); continue; }
    const dot = name.indexOf(".");
    const id = dot > 0 ? name.slice(0, dot) : name, key = dot > 0 ? name.slice(dot + 1) : null;
    if (Object.hasOwn(REGION_GROUP, id) && REGION_GROUP[id].length === 1 && key != null) {
      if (!CHAN.includes(key)) throw new Error(`${what}: "${name}": a spine region has the channels ${CHAN.join(", ")}`);
      setRegion(REGION_GROUP[id][0], CHAN.indexOf(key));
      continue;
    }
    const ji = INDEX.get(id);
    if (ji !== undefined && (key == null || JOINTS[ji].dof.some((d) => d.key === key)) && id !== "pelvis") { setJoint(id, key); continue; }
    throw new Error(`${what}: unknown name "${name}" (groups: ${FREE_GROUPS.join(", ")}; or a joint id such as "elbow_R", or "joint.dof" such as "shoulder_R.rot")`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The problem
const OPTION_KEYS = ["free", "lock", "maxIterations", "tolerance", "angTolerance", "damping", "stiffness", "reference", "referenceWeight", "pole", "poleWeight", "angleScale", "stepMax", "rootRange", "restarts", "seed", "warmStart"];
function compile(S, start, goals, options) {
  if (options === null || typeof options !== "object") throw new TypeError("options must be an object");
  for (const k of Object.keys(options)) if (!OPTION_KEYS.includes(k)) throw new Error(`unknown option "${k}" (known: ${OPTION_KEYS.join(", ")})`);
  loadStart(S, start);
  const P = { S, kin: S.kin, root: S.root, ang: S.ang, angArr: S.angArr, root0: { ...S.root } };
  compileGoals(P, goals, options);
  const terms = P.terms, nt = terms.length;
  // ---- free set
  const flags = { dof: new Uint8Array(N * 3), reg: new Uint8Array(9), root: new Uint8Array(7), locked: new Uint8Array(N * 3) };
  const goalJoints = terms.map((t) => t.ji);
  const free = typeof options.free === "string" ? [options.free] : options.free ?? ["auto"];
  if (!Array.isArray(free)) throw new TypeError("options.free must be an array of group names / joint ids");
  applyNames(S, flags, free, 1, "options.free", goalJoints);
  if (options.lock != null) {
    const lock = typeof options.lock === "string" ? [options.lock] : options.lock;
    if (!Array.isArray(lock)) throw new TypeError("options.lock must be an array of joint ids");
    applyNames(S, flags, lock, 0, "options.lock", goalJoints);
  }
  // a vertebra named in `free` while its region is free is part of the region
  const vk = [], vj = [], vd = [], lo = [], hi = [], x0 = [], x0deg = [], cost = [], names = [], rbase = [], rA = [], rB = [];
  const stiff = options.stiffness ?? {};
  const costFor = (key, dflt) => { const v = stiff[key]; if (v === undefined) return dflt; if (!(isNum(v) && v >= 0)) throw new RangeError(`options.stiffness.${key} must be a cost length >= 0 (metres per radian)`); return v; };
  for (const k of Object.keys(stiff)) if (!(Object.hasOwn(COST, k) || INDEX.has(k) || REGION_IDS.includes(k) || /^[a-z_]+\.[a-z0-9_]+$/.test(k))) throw new Error(`options.stiffness: unknown key "${k}"`);
  for (let r = 0; r < 3; r++) {
    const R = REGION[r];
    for (let c = 0; c < 3; c++) {
      if (!flags.reg[r * 3 + c]) continue;
      let sumA = 0, sumB = 0;
      const A = new Float64Array(R.n), B = new Float64Array(R.n), base = new Float64Array(R.n);
      for (let v = 0; v < R.n; v++) {
        const cur = S.angArr[R.ji[v]][c] * D2R;
        base[v] = S.angArr[R.ji[v]][c];
        A[v] = Math.min(0, R.lo[c][v] - cur); B[v] = Math.max(0, R.hi[c][v] - cur);
        if (flags.locked[R.ji[v] * 3 + c]) A[v] = B[v] = 0; // a locked vertebra of a free region carries none of the total
        sumA += A[v]; sumB += B[v];
        flags.dof[R.ji[v] * 3 + c] = 0; // the region carries it
      }
      vk.push(1); vj.push(r); vd.push(c); lo.push(sumA); hi.push(sumB); x0.push(0); x0deg.push(0);
      cost.push(costFor(`${REGION_IDS[r]}.${CHAN[c]}`, costFor(REGION_IDS[r], COST[REGION_IDS[r]])));
      names.push(`${REGION_IDS[r]}.${CHAN[c]}`); rbase.push(base); rA.push(A); rB.push(B);
    }
  }
  for (let i = 1; i < N; i++) {
    for (let d = 0; d < NDOF[i]; d++) {
      if (!flags.dof[i * 3 + d]) continue;
      const dd = JOINTS[i].dof[d];
      const cur = S.angArr[i][d] * D2R;
      vk.push(0); vj.push(i); vd.push(d);
      lo.push(dd.min * D2R); hi.push(dd.max * D2R); x0.push(Math.min(hi[hi.length - 1], Math.max(lo[lo.length - 1], cur)));
      x0deg.push(S.angArr[i][d] >= dd.min && S.angArr[i][d] <= dd.max ? S.angArr[i][d] : Math.min(dd.max, Math.max(dd.min, S.angArr[i][d])));
      const b = baseName(IDS[i]);
      cost.push(costFor(`${IDS[i]}.${dd.key}`, costFor(`${b}.${dd.key}`, costFor(IDS[i], costFor(b, costOf(JOINTS[i], d))))));
      names.push(`${IDS[i]}.${dd.key}`); rbase.push(null); rA.push(null); rB.push(null);
    }
  }
  const R = S.root, rootVals = [R.x, R.y, R.z, R.heading * D2R, R.flex * D2R, R.lat * D2R, R.rot * D2R];
  const rootRange = options.rootRange ?? 1.5; // how far the pelvis may travel from where it is (metres), so that a goal a kilometre away does not launch the figure
  if (!(isNum(rootRange) && rootRange >= 0)) throw new RangeError("options.rootRange must be a distance in metres >= 0");
  const rootNames = ["x", "y", "z", "heading", "flex", "lat", "rot"], rootCost = [COST.tx, COST.ty, COST.tz, COST.heading, COST.tilt, COST.tilt, COST.tilt];
  for (let k = 0; k < 7; k++) {
    if (!flags.root[k]) continue;
    vk.push(k < 3 ? 2 : 3); vj.push(k < 3 ? k : k - 3); vd.push(0);
    const half = k === 3 ? PI : PI / 2;
    lo.push(k < 3 ? rootVals[k] - rootRange : rootVals[k] - half); hi.push(k < 3 ? rootVals[k] + rootRange : rootVals[k] + half); x0.push(rootVals[k]); x0deg.push([R.x, R.y, R.z, R.heading, R.flex, R.lat, R.rot][k]);
    cost.push(costFor(`pelvis.${rootNames[k]}`, rootCost[k]));
    names.push(`pelvis.${rootNames[k]}`); rbase.push(null); rA.push(null); rB.push(null);
  }
  const n = vk.length;
  Object.assign(P, {
    n, nt, vk: Uint8Array.from(vk), vj: Int16Array.from(vj), vd: Int8Array.from(vd), lo: Float64Array.from(lo), hi: Float64Array.from(hi), x0: Float64Array.from(x0), x0deg: Float64Array.from(x0deg),
    s: Float64Array.from(cost, (c) => c * c), names, rbase, rA, rB, flags,
    x: Float64Array.from(x0), xt: new Float64Array(n), xr: Float64Array.from(x0),
    rdelta: new Float64Array(n * MAXV), rdw: new Float64Array(n * MAXV), // region shares and their derivatives per variable
  });
  // ---- the swing cap
  P.caps = []; // the cap of the combined swing (180 degrees) as a constraint on the free swing variables of a joint
  for (const ji of CAP_JOINTS) {
    const ks = [];
    for (let k = 0; k < n; k++) if (vk[k] === 0 && vj[k] === ji && JOINTS[ji].dof[vd[k]].role !== "twist") ks.push(k);
    if (ks.length) P.caps.push({ ji, ks, u: new Float64Array(ks.length), on: false });
  }
  // ---- reference pose (null-space pull)
  P.refW = 0;
  if (options.reference != null) {
    const ref = options.reference;
    if (typeof ref !== "object") throw new TypeError("options.reference must be a pose { root, angles }");
    P.refW = options.referenceWeight ?? 0.25;
    if (!(isNum(P.refW) && P.refW >= 0)) throw new RangeError("options.referenceWeight must be a number >= 0");
    for (let k = 0; k < n; k++) {
      if (vk[k] === 0) { const a = ref.angles?.[IDS[vj[k]]]; P.xr[k] = Math.min(P.hi[k], Math.max(P.lo[k], (a?.[vd[k]] ?? 0) * D2R)); }
      else if (vk[k] === 1) { // reference total of the region minus the start total
        const Rg = REGION[vj[k]];
        let t = 0;
        for (let v = 0; v < Rg.n; v++) t += (ref.angles?.[IDS[Rg.ji[v]]]?.[vd[k]] ?? 0) - rbase[k][v];
        P.xr[k] = Math.min(P.hi[k], Math.max(P.lo[k], t * D2R));
      } else if (vk[k] === 3) { const f = ["heading", "flex", "lat", "rot"][vj[k]]; P.xr[k] = Math.min(P.hi[k], Math.max(P.lo[k], (ref.root?.[f] ?? rootVals[3 + vj[k]] * R2D) * D2R)); }
      else P.xr[k] = x0[k];
    }
  }
  // ---- term arrays
  const wsc = options.angleScale ?? 0.3;
  if (!(wsc > 0)) throw new RangeError("options.angleScale must be > 0 (metres of residual per radian)");
  P.angleScale = wsc;
  P.tk = new Uint8Array(nt); P.tj = new Int16Array(nt); P.toff = new Float64Array(3 * nt); P.tdir = new Float64Array(3 * nt); P.ttgt = new Float64Array(3 * nt);
  P.tsw = new Float64Array(nt); P.tbase = new Float64Array(nt); P.tsign = new Float64Array(nt).fill(1); P.tline = new Uint8Array(nt); P.tslot = new Int16Array(nt);
  P.trow = new Int32Array(nt); P.tdyn = new Int16Array(nt).fill(-1);
  P.tp = new Float64Array(3 * nt); P.td = new Float64Array(3 * nt); P.tu = new Float64Array(3 * nt); P.tD = new Float64Array(nt); P.te = new Float64Array(nt);
  let m = 0;
  terms.forEach((t, i) => {
    P.tk[i] = t.kind; P.tj[i] = t.ji; P.tslot[i] = t.slot; P.trow[i] = m; m += TERM_ROWS[t.kind];
    if (t.off) P.toff.set(t.off, 3 * i);
    if (t.dir) P.tdir.set(t.dir, 3 * i);
    P.ttgt.set(t.tgt, 3 * i);
    P.tbase[i] = Math.sqrt(t.w) * (t.kind === T_DIR || t.kind === T_AIM ? wsc : 1);
    P.tsw[i] = P.tbase[i];
    P.tline[i] = t.line ? 1 : 0;
  });
  // ---- poles (elbow / knee swivel): soft terms that put the middle joint in the half-plane of the pole direction, see evalTerms
  P.poles = [];
  const poleOpt = options.pole ?? {};
  const poleW = options.poleWeight ?? 0.003;
  if (!(isNum(poleW) && poleW >= 0)) throw new RangeError("options.poleWeight must be a number >= 0");
  for (const k of Object.keys(poleOpt)) if (!S.limbs.some((L) => L.name === k)) throw new Error(`options.pole: unknown key "${k}" (known: ${S.limbs.map((L) => L.name).join(", ")})`);
  if (poleW > 0) {
    S.limbs.forEach((L, li) => {
      if (poleOpt[L.name] === false || poleOpt[L.name] === null) return;
      // the limb takes part when a position goal sits on the chain of its end joint, and its upper joint and hinge move
      if (!terms.some((t) => t.kind === T_POS && ANC[L.e * N + t.ji])) return;
      const freeU = [0, 1, 2].slice(0, NDOF[L.u]).every((d) => flags.dof[L.u * 3 + d]);
      if (!freeU || !flags.dof[L.m * 3]) return;
      P.poles.push({ limb: li, ju: L.u, jm: L.m, je: L.e, L1: L.L1, L2: L.L2, user: poleOpt[L.name] != null ? vec3(poleOpt[L.name], `options.pole.${L.name}`) : null, t: -1 });
    });
    const np = P.poles.length, grow = (arr, k) => { const b = new arr.constructor(arr.length + k); b.set(arr); return b; };
    for (const key of ["tk", "tj", "tsw", "tbase", "tsign", "tline", "tslot", "trow", "tdyn", "tD", "te"]) P[key] = grow(P[key], np);
    for (const key of ["toff", "tdir", "ttgt", "tp", "td", "tu"]) P[key] = grow(P[key], 3 * np);
    P.poles.forEach((pe, q) => {
      const i = nt + q;
      P.tk[i] = T_POLE; P.tj[i] = pe.je; P.tsign[i] = 1; P.tslot[i] = -1; P.trow[i] = m; m += 3; P.tdyn[i] = q; P.tbase[i] = Math.sqrt(poleW); P.tsw[i] = P.tbase[i];
      pe.t = i;
    });
  }
  P.m = m; P.ngoal = nt; P.nt = nt + P.poles.length; // terms [0, ngoal) are goals, [ngoal, nt) are pole terms
  P.r = new Float64Array(m); P.J = new Float64Array(m * n); P.g = new Float64Array(n);
  P.om = new Float64Array(N * 9); P.omStamp = new Int32Array(N); P.stamp = 0;
  P.mu = 1; P.rho = P.refW;
  // scratch for the step
  P.H0 = new Float64Array(n * n); P.Hs = new Float64Array(n * n); P.b = new Float64Array(n); P.dl = new Float64Array(n); P.act = new Int16Array(n); P.posn = new Int16Array(n); P.fx = new Uint8Array(n);
  P.sol = new Float64Array(n); P.idx = new Int16Array(n); P.fpos = new Int16Array(n); P.tvars = new Int16Array(n);
  P.lambda0 = options.damping ?? 1e-3;
  P.stepMax = options.stepMax ?? 0.4;
  if (!(P.lambda0 > 0)) throw new RangeError("options.damping must be > 0");
  P.maxIter = options.maxIterations ?? 60;
  if (!(Number.isInteger(P.maxIter) && P.maxIter >= 0)) throw new RangeError("options.maxIterations must be an integer >= 0");
  if (options.restarts !== undefined && !(Number.isInteger(options.restarts) && options.restarts >= 0)) throw new RangeError("options.restarts must be an integer >= 0");
  P.restarts = options.restarts ?? -1; // -1: automatic, see optimise()
  P.seed = options.seed ?? 20240607;
  P.useWarm = options.warmStart !== false;
  P.poleDir = new Float64Array(3 * P.poles.length); P.pf = new Float64Array(11 * P.poles.length);
  return P;
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables -> pose
function applyVars(P, x) {
  const n = P.n, { vk, vj, vd, angArr, root } = P;
  for (let k = 0; k < n; k++) {
    switch (vk[k]) {
      case 0: angArr[vj[k]][vd[k]] = x[k] === P.x0[k] ? P.x0deg[k] : x[k] * R2D; break; // a variable that did not move keeps its exact start value
      case 1: {
        const R = REGION[vj[k]], c = vd[k], base = P.rbase[k], o = k * MAXV;
        fillRegion(x[k], R.w[c], P.rA[k], P.rB[k], R.n, P.rdelta, P.rdw, o);
        for (let v = 0; v < R.n; v++) angArr[R.ji[v]][c] = base[v] + P.rdelta[o + v] * R2D;
        break;
      }
      case 2: if (vj[k] === 0) root.x = x[k]; else if (vj[k] === 1) root.y = x[k]; else root.z = x[k]; break;
      default: { const f = vj[k], v = x[k] === P.x0[k] ? P.x0deg[k] : x[k] * R2D; if (f === 0) root.heading = v; else if (f === 1) root.flex = v; else if (f === 2) root.lat = v; else root.rot = v; }
    }
  }
}

/**
 * Enforce the 180 degree cap on the combined swing (clampAngles) on a candidate x: the free swing DOF of a joint whose swing vector is longer than
 * 180 are scaled radially onto the cap (the Euclidean projection onto the disk); swing DOF that are not variables keep their value.
 * Returns true when x changed.
 */
function capSwing(P, x) {
  let changed = false;
  const { n, vk, vj, vd } = P;
  for (let k = 0; k < n; k++) {
    if (vk[k] !== 0) continue;
    const ji = vj[k];
    if (k > 0 && vk[k - 1] === 0 && vj[k - 1] === ji) continue; // each joint once, at its first variable
    const jd = JOINTS[ji];
    if (NDOF[ji] < 2) continue;
    let kk = k, free2 = 0, fixed2 = 0, freeMask = 0;
    for (; kk < n && vk[kk] === 0 && vj[kk] === ji; kk++) if (jd.dof[vd[kk]].role !== "twist") { free2 += x[kk] * x[kk]; freeMask |= 1 << vd[kk]; }
    for (let d = 0; d < NDOF[ji]; d++) if (jd.dof[d].role !== "twist" && !(freeMask & (1 << d))) fixed2 += (P.angArr[ji][d] * D2R) ** 2;
    if (free2 + fixed2 <= PI * PI) continue;
    if (!(free2 > 0)) continue;
    const f = Math.sqrt(Math.max(0, PI * PI - fixed2) / free2) * (1 - 1e-12);
    for (let q = k; q < kk; q++) if (jd.dof[vd[q]].role !== "twist") x[q] *= f;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Residuals
/**
 * The swivel of a two-bone limb. With the pole direction p, the unit chord a = (W - S) / D (S upper joint, W end joint) and the bone lengths L1, L2, the
 * middle joint of the straight-bone triangle sits at S + a d1 + n h, n the unit component of p perpendicular to a. Writes into out (11 numbers):
 * d1, h n (3), n (3), h, dh/dD, |p perpendicular|, p . a; the chord length D goes to POLE_D[0].
 */
function poleFrame(P, qi, out) {
  const pe = P.poles[qi], Pk = P.kin.positions, u = 3 * pe.ju, mi = 3 * pe.jm, e = 3 * pe.je;
  let ax = Pk[e] - Pk[u], ay = Pk[e + 1] - Pk[u + 1], az = Pk[e + 2] - Pk[u + 2];
  const D = Math.sqrt(ax * ax + ay * ay + az * az), { L1, L2 } = pe;
  POLE_D[0] = D;
  out.fill(0);
  out[0] = 0.5 * L1;
  if (D < 1e-9) return;
  ax /= D; ay /= D; az /= D;
  const lo = Math.abs(L1 - L2) + 1e-6, hi = L1 + L2 - 1e-6, Dc = Math.min(hi, Math.max(lo, D));
  const d1 = (L1 * L1 - L2 * L2 + Dc * Dc) / (2 * Dc), h = Math.sqrt(Math.max(0, L1 * L1 - d1 * d1));
  const o = 3 * qi;
  let px = P.poleDir[o], py = P.poleDir[o + 1], pz = P.poleDir[o + 2];
  const pa = px * ax + py * ay + pz * az;
  px -= pa * ax; py -= pa * ay; pz -= pa * az;
  let pl = Math.sqrt(px * px + py * py + pz * pz), regular = true;
  if (pl < 1e-6) { // the pole is along the limb: keep the current bend side
    regular = false;
    px = Pk[mi] - Pk[u]; py = Pk[mi + 1] - Pk[u + 1]; pz = Pk[mi + 2] - Pk[u + 2];
    const dd = px * ax + py * ay + pz * az;
    px -= dd * ax; py -= dd * ay; pz -= dd * az; pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
  }
  const nx = px / pl, ny = py / pl, nz = pz / pl;
  out[0] = d1; out[1] = nx * h; out[2] = ny * h; out[3] = nz * h; out[4] = nx; out[5] = ny; out[6] = nz; out[7] = h;
  out[8] = D > lo && D < hi && h > 1e-9 ? (-d1 * (0.5 - (L1 * L1 - L2 * L2) / (2 * Dc * Dc))) / h : 0;
  out[9] = regular ? pl : Infinity; out[10] = pa;
}
const POLE_TMP = new Float64Array(11), POLE_D = new Float64Array(1); // POLE_D: the chord length, kept out of the return value so no double is boxed

/** Evaluate the terms in the current FK state: residual rows, errors, ok flag, goal cost. */
function evalTerms(P) {
  const { kin, nt, tk, tj, toff, tdir, ttgt, tsw, trow, r } = P;
  const Pk = kin.positions, Q = kin.quaternions;
  let ok = true, gc = 0, c2 = 0;
  for (let t = 0; t < nt; t++) {
    const ji = tj[t], i3 = 3 * ji, i4 = 4 * ji, t3 = 3 * t, row = trow[t], sw = tsw[t], kind = tk[t];
    let err;
    if (kind === T_POLE) { // v = chord-perpendicular part of (middle - upper); target h n
      const pe = P.poles[P.tdyn[t]], u = 3 * pe.ju, mi = 3 * pe.jm;
      poleFrame(P, P.tdyn[t], POLE_TMP);
      const D = POLE_D[0];
      P.pf.set(POLE_TMP, 11 * P.tdyn[t]);
      let vx = Pk[mi] - Pk[u], vy = Pk[mi + 1] - Pk[u + 1], vz = Pk[mi + 2] - Pk[u + 2];
      let ax = Pk[i3] - Pk[u], ay = Pk[i3 + 1] - Pk[u + 1], az = Pk[i3 + 2] - Pk[u + 2];
      if (D > 1e-9) { ax /= D; ay /= D; az /= D; } else { ax = 0; ay = 1; az = 0; }
      P.tp[t3] = vx; P.tp[t3 + 1] = vy; P.tp[t3 + 2] = vz; P.tu[t3] = ax; P.tu[t3 + 1] = ay; P.tu[t3 + 2] = az; P.tD[t] = Math.max(D, 1e-9);
      const va = vx * ax + vy * ay + vz * az;
      vx -= va * ax; vy -= va * ay; vz -= va * az;
      const ex = vx - POLE_TMP[1], ey = vy - POLE_TMP[2], ez = vz - POLE_TMP[3];
      r[row] = sw * ex; r[row + 1] = sw * ey; r[row + 2] = sw * ez;
      err = Math.sqrt(ex * ex + ey * ey + ez * ez);
      P.te[t] = err;
      c2 += r[row] * r[row] + r[row + 1] * r[row + 1] + r[row + 2] * r[row + 2];
      continue;
    }
    const qx = Q[i4], qy = Q[i4 + 1], qz = Q[i4 + 2], qw = Q[i4 + 3];
    if (kind === T_DIR || kind === T_AIM) { // d = Q * dir
      const vx = tdir[t3], vy = tdir[t3 + 1], vz = tdir[t3 + 2];
      const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
      P.td[t3] = vx + qw * tx + (qy * tz - qz * ty); P.td[t3 + 1] = vy + qw * ty + (qz * tx - qx * tz); P.td[t3 + 2] = vz + qw * tz + (qx * ty - qy * tx);
    }
    if (kind !== T_DIR) { // p = P_j + Q * off
      const vx = toff[t3], vy = toff[t3 + 1], vz = toff[t3 + 2];
      const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
      P.tp[t3] = Pk[i3] + vx + qw * tx + (qy * tz - qz * ty); P.tp[t3 + 1] = Pk[i3 + 1] + vy + qw * ty + (qz * tx - qx * tz); P.tp[t3 + 2] = Pk[i3 + 2] + vz + qw * tz + (qx * ty - qy * tx);
    }
    const tgx = ttgt[t3], tgy = ttgt[t3 + 1], tgz = ttgt[t3 + 2];
    if (kind === T_POS) {
      const ex = P.tp[t3] - tgx, ey = P.tp[t3 + 1] - tgy, ez = P.tp[t3 + 2] - tgz;
      r[row] = sw * ex; r[row + 1] = sw * ey; r[row + 2] = sw * ez;
      err = Math.sqrt(ex * ex + ey * ey + ez * ez);
    } else if (kind === T_HEIGHT) {
      const nx = tdir[t3], ny = tdir[t3 + 1], nz = tdir[t3 + 2];
      const ex = nx * P.tp[t3] + ny * P.tp[t3 + 1] + nz * P.tp[t3 + 2] - (nx * tgx + ny * tgy + nz * tgz);
      r[row] = sw * ex; err = Math.abs(ex);
    } else if (kind === T_DIR) {
      const s = P.tsign[t], bx = s * tgx, by = s * tgy, bz = s * tgz;
      const dx = P.td[t3], dy = P.td[t3 + 1], dz = P.td[t3 + 2];
      r[row] = sw * (dx - bx); r[row + 1] = sw * (dy - by); r[row + 2] = sw * (dz - bz);
      err = angleBetween(dx, dy, dz, bx, by, bz);
      if (P.tline[t]) err = Math.min(err, PI - err);
    } else { // aim
      let ux = tgx - P.tp[t3], uy = tgy - P.tp[t3 + 1], uz = tgz - P.tp[t3 + 2];
      let D = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (D < 1e-9) { D = 1e-9; ux = P.td[t3]; uy = P.td[t3 + 1]; uz = P.td[t3 + 2]; } else { ux /= D; uy /= D; uz /= D; }
      P.tu[t3] = ux; P.tu[t3 + 1] = uy; P.tu[t3 + 2] = uz; P.tD[t] = D;
      const dx = P.td[t3], dy = P.td[t3 + 1], dz = P.td[t3 + 2];
      r[row] = sw * (dx - ux); r[row + 1] = sw * (dy - uy); r[row + 2] = sw * (dz - uz);
      err = angleBetween(dx, dy, dz, ux, uy, uz);
    }
    P.te[t] = err;
    const rows = TERM_ROWS[kind];
    let q = 0;
    for (let a = 0; a < rows; a++) q += r[row + a] * r[row + a];
    gc += q;
    if (err > P.slots[P.tslot[t]].tol) ok = false;
  }
  P.ok = ok; P.gc = 0.5 * gc;
  return 0.5 * (gc + c2);
}

function regCost(P, x) {
  let c = 0;
  const { n, s, x0, xr } = P;
  for (let k = 0; k < n; k++) { const d = x[k] - x0[k]; c += s[k] * d * d; }
  c *= P.mu;
  if (P.rho > 0) { let c2 = 0; for (let k = 0; k < n; k++) { const d = x[k] - P.xr[k]; c2 += s[k] * d * d; } c += P.mu * P.rho * c2; }
  return 0.5 * c;
}

/** x -> pose -> FK -> residuals -> F. Non-finite results (a bad step) give Infinity. */
function evaluate(P, x) {
  applyVars(P, x);
  try { P.kin.solve(P.ang, P.root); } catch { P.ok = false; return Infinity; }
  const f = evalTerms(P);
  return f + regCost(P, x);
}

function setMu(P, mu) {
  P.mu = mu;
  const sm = Math.sqrt(mu);
  for (let t = P.ngoal; t < P.nt; t++) P.tsw[t] = P.tbase[t] * sm;
}

function setPoleDirs(P, S) {
  // default poles: body frame rotated by the heading of the pelvis (up to date at solve start); a user pole is a world direction
  const h = P.root.heading * D2R, c = Math.cos(h), sn = Math.sin(h);
  P.poles.forEach((pe, i) => {
    const L = S.limbs[pe.limb];
    let v;
    if (pe.user) v = pe.user;
    else {
      const b = POLE_BODY[L.kind](L.side);
      v = [b[0] * c + b[2] * sn, b[1], -b[0] * sn + b[2] * c]; // rotation about +Y by the heading
    }
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    P.poleDir[3 * i] = v[0] / l; P.poleDir[3 * i + 1] = v[1] / l; P.poleDir[3 * i + 2] = v[2] / l;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Jacobian (geometric)
/** Angular velocity in the world frame of every DOF of joint ji at the current angles (rad / rad), into P.om[ji * 9 + 3 * d]. */
function fillOmega(P, ji) {
  const jd = JOINTS[ji], k = jd.kernel, a = P.angArr[ji], nd = NDOF[ji], om = P.om, o = ji * 9;
  const d0 = a[0], d1 = nd > 1 ? a[1] : 0, d2 = nd > 2 ? a[2] : 0;
  const sx = (d0 * k.sx[0] + d1 * k.sx[1] + d2 * k.sx[2]) * D2R, sy = (d0 * k.sy[0] + d1 * k.sy[1] + d2 * k.sy[2]) * D2R, sz = (d0 * k.sz[0] + d1 * k.sz[1] + d2 * k.sz[2]) * D2R;
  const phi = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let A, B, cp = 1, sp = 0;
  if (phi < 1e-4) { const p2 = phi * phi; A = 0.5 - p2 / 24; B = 1 / 6 - p2 / 120; } else { cp = Math.cos(phi); sp = Math.sin(phi); A = (1 - cp) / (phi * phi); B = (phi - sp) / (phi * phi * phi); }
  const Q = P.kin.quaternions, p4 = 4 * PARENT[ji];
  const qx = Q[p4], qy = Q[p4 + 1], qz = Q[p4 + 2], qw = Q[p4 + 3];
  for (let i = 0; i < nd; i++) {
    let wx, wy, wz;
    if (k.tw[i]) { // twist about its axis, carried by exp(swing)
      const tx = k.tx, ty = k.ty, tz = k.tz;
      if (phi < 1e-9) { wx = tx; wy = ty; wz = tz; } else {
        const ux = sx / phi, uy = sy / phi, uz = sz / phi, dd = ux * tx + uy * ty + uz * tz;
        wx = tx * cp + (uy * tz - uz * ty) * sp + ux * dd * (1 - cp); wy = ty * cp + (uz * tx - ux * tz) * sp + uy * dd * (1 - cp); wz = tz * cp + (ux * ty - uy * tx) * sp + uz * dd * (1 - cp);
      }
    } else { // swing: left Jacobian of SO(3) applied to the DOF axis
      const vx = k.sx[i], vy = k.sy[i], vz = k.sz[i];
      const c1x = sy * vz - sz * vy, c1y = sz * vx - sx * vz, c1z = sx * vy - sy * vx;
      const c2x = sy * c1z - sz * c1y, c2y = sz * c1x - sx * c1z, c2z = sx * c1y - sy * c1x;
      wx = vx + A * c1x + B * c2x; wy = vy + A * c1y + B * c2y; wz = vz + A * c1z + B * c2z;
    }
    // into the world frame: rotate by the parent's orientation
    const tx2 = 2 * (qy * wz - qz * wy), ty2 = 2 * (qz * wx - qx * wz), tz2 = 2 * (qx * wy - qy * wx);
    om[o + 3 * i] = wx + qw * tx2 + (qy * tz2 - qz * ty2); om[o + 3 * i + 1] = wy + qw * ty2 + (qz * tx2 - qx * tz2); om[o + 3 * i + 2] = wz + qw * tz2 + (qx * ty2 - qy * tx2);
  }
  P.omStamp[ji] = P.stamp;
}

// Scratch for the column assembly. Doubles are never passed as arguments in this hot path (V8 boxes a double argument of a call it does not inline: about
// 30 KB of garbage per iteration before this was done): vectors travel in these arrays.
const EV = new Float64Array(6); // emit(): velocity of the term's point (0..2) and of its direction (3..5)
const OMV = new Float64Array(4); // emitRotation(): angular velocity (0..2) and the factor (3)
const POLEV = new Float64Array(9); // emitPole(): velocities of the upper, middle and end joint centres

/** Add the velocity of the point (EV[0..2]) and of the direction (EV[3..5]) of term t to column `col` of the Jacobian. */
function emit(P, col, t) {
  const kind = P.tk[t], row = P.trow[t], sw = P.tsw[t], J = P.J, t3 = 3 * t;
  const vx = EV[0], vy = EV[1], vz = EV[2], wx = EV[3], wy = EV[4], wz = EV[5];
  if (kind === T_POS) { J[col + row] += sw * vx; J[col + row + 1] += sw * vy; J[col + row + 2] += sw * vz; }
  else if (kind === T_HEIGHT) J[col + row] += sw * (P.tdir[t3] * vx + P.tdir[t3 + 1] * vy + P.tdir[t3 + 2] * vz);
  else if (kind === T_DIR) { J[col + row] += sw * wx; J[col + row + 1] += sw * wy; J[col + row + 2] += sw * wz; }
  else { // aim: d(d - u) = dd + (dp - (u . dp) u) / D
    const ux = P.tu[t3], uy = P.tu[t3 + 1], uz = P.tu[t3 + 2], uv = ux * vx + uy * vy + uz * vz, iD = 1 / P.tD[t];
    J[col + row] += sw * (wx + (vx - uv * ux) * iD); J[col + row + 1] += sw * (wy + (vy - uv * uy) * iD); J[col + row + 2] += sw * (wz + (vz - uv * uz) * iD);
  }
}

/**
 * The pole term r = P(v) - h n with v = M - S, a = (W - S) / D, P the projection perpendicular to a, n the unit perpendicular part of the pole direction p
 * and h(D) the height of the triangle. With the velocities of S, M, W (POLEV): da = P(dW - dS) / D, dD = a . (dW - dS),
 * d P(v) = P(dv) - (v . da) a - (v . a) da,  dn = P_n(-(p . da) a - (p . a) da) / |p_perp|,  d(h n) = h' dD n + h dn.
 */
function emitPole(P, col, t) {
  const t3 = 3 * t, row = P.trow[t], sw = P.tsw[t], J = P.J, pf = P.pf, f = 11 * P.tdyn[t], qi3 = 3 * P.tdyn[t];
  const sx = POLEV[0], sy = POLEV[1], sz = POLEV[2], mx = POLEV[3], my = POLEV[4], mz = POLEV[5], ex = POLEV[6], ey = POLEV[7], ez = POLEV[8];
  const ax = P.tu[t3], ay = P.tu[t3 + 1], az = P.tu[t3 + 2], vx = P.tp[t3], vy = P.tp[t3 + 1], vz = P.tp[t3 + 2], iD = 1 / P.tD[t];
  const dvx = mx - sx, dvy = my - sy, dvz = mz - sz;
  let wx = ex - sx, wy = ey - sy, wz = ez - sz;
  const wa = wx * ax + wy * ay + wz * az; // dD
  wx = (wx - wa * ax) * iD; wy = (wy - wa * ay) * iD; wz = (wz - wa * az) * iD; // da
  const dva = dvx * ax + dvy * ay + dvz * az, vda = vx * wx + vy * wy + vz * wz, va = vx * ax + vy * ay + vz * az;
  const rx = dvx - dva * ax - vda * ax - va * wx, ry = dvy - dva * ay - vda * ay - va * wy, rz = dvz - dva * az - vda * az - va * wz;
  // d(h n)
  const nx = pf[f + 4], ny = pf[f + 5], nz = pf[f + 6], h = pf[f + 7], dh = pf[f + 8], pl = pf[f + 9], pa = pf[f + 10];
  let cx = dh * wa * nx, cy = dh * wa * ny, cz = dh * wa * nz;
  if (pl !== Infinity) {
    const px = P.poleDir[qi3], py = P.poleDir[qi3 + 1], pz = P.poleDir[qi3 + 2], pw = px * wx + py * wy + pz * wz;
    let qx = -pw * ax - pa * wx, qy = -pw * ay - pa * wy, qz = -pw * az - pa * wz; // d p_perp
    const qn = qx * nx + qy * ny + qz * nz;
    qx = (qx - qn * nx) / pl; qy = (qy - qn * ny) / pl; qz = (qz - qn * nz) / pl; // dn
    cx += h * qx; cy += h * qy; cz += h * qz;
  }
  J[col + row] += sw * (rx - cx); J[col + row + 1] += sw * (ry - cy); J[col + row + 2] += sw * (rz - cz);
}

/** One rotation of joint ji (angular velocity OMV[0..2] at its centre, times OMV[3]) for every term of a joint that is ji or below it. */
function emitRotation(P, col, ji) {
  const Pk = P.kin.positions, px = Pk[3 * ji], py = Pk[3 * ji + 1], pz = Pk[3 * ji + 2];
  const ox = OMV[0], oy = OMV[1], oz = OMV[2], coef = OMV[3];
  for (let t = 0; t < P.nt; t++) {
    if (!ANC[ji * N + P.tj[t]]) continue;
    const t3 = 3 * t, kind = P.tk[t];
    if (kind === T_POLE) {
      const pe = P.poles[P.tdyn[t]];
      POLEV.fill(0);
      // velocity of a joint centre: omega x (P - pivot) when the pivot joint is above it
      for (let q = 0; q < 3; q++) {
        const jx = q === 0 ? pe.ju : q === 1 ? pe.jm : pe.je;
        if (!ANC[ji * N + jx]) continue;
        const o3 = 3 * jx, rx = Pk[o3] - px, ry = Pk[o3 + 1] - py, rz = Pk[o3 + 2] - pz;
        POLEV[3 * q] = coef * (oy * rz - oz * ry); POLEV[3 * q + 1] = coef * (oz * rx - ox * rz); POLEV[3 * q + 2] = coef * (ox * ry - oy * rx);
      }
      emitPole(P, col, t);
      continue;
    }
    EV.fill(0);
    if (kind !== T_DIR) { const rx = P.tp[t3] - px, ry = P.tp[t3 + 1] - py, rz = P.tp[t3 + 2] - pz; EV[0] = coef * (oy * rz - oz * ry); EV[1] = coef * (oz * rx - ox * rz); EV[2] = coef * (ox * ry - oy * rx); }
    if (kind === T_DIR || kind === T_AIM) { const dx = P.td[t3], dy = P.td[t3 + 1], dz = P.td[t3 + 2]; EV[3] = coef * (oy * dz - oz * dy); EV[4] = coef * (oz * dx - ox * dz); EV[5] = coef * (ox * dy - oy * dx); }
    emit(P, col, t);
  }
}

/** Angular velocity (world frame, rad / rad) of the root orientation parameter f (0 heading, 1 flex, 2 lat, 3 rot). */
function rootOmega(P, f, out) {
  if (f === 0) { out[0] = 0; out[1] = 1; out[2] = 0; return; }
  const kn = JOINTS[0].kernel, R = P.root, i = f - 1;
  const d0 = R.flex, d1 = R.lat, d2 = R.rot;
  const sx = (d0 * kn.sx[0] + d1 * kn.sx[1] + d2 * kn.sx[2]) * D2R, sy = (d0 * kn.sy[0] + d1 * kn.sy[1] + d2 * kn.sy[2]) * D2R, sz = (d0 * kn.sz[0] + d1 * kn.sz[1] + d2 * kn.sz[2]) * D2R;
  const phi = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let A, B, cp = 1, sp = 0;
  if (phi < 1e-4) { const p2 = phi * phi; A = 0.5 - p2 / 24; B = 1 / 6 - p2 / 120; } else { cp = Math.cos(phi); sp = Math.sin(phi); A = (1 - cp) / (phi * phi); B = (phi - sp) / (phi * phi * phi); }
  let wx, wy, wz;
  if (kn.tw[i]) {
    const tx = kn.tx, ty = kn.ty, tz = kn.tz;
    if (phi < 1e-9) { wx = tx; wy = ty; wz = tz; } else {
      const ux = sx / phi, uy = sy / phi, uz = sz / phi, dd = ux * tx + uy * ty + uz * tz;
      wx = tx * cp + (uy * tz - uz * ty) * sp + ux * dd * (1 - cp); wy = ty * cp + (uz * tx - ux * tz) * sp + uy * dd * (1 - cp); wz = tz * cp + (ux * ty - uy * tx) * sp + uz * dd * (1 - cp);
    }
  } else {
    const vx = kn.sx[i], vy = kn.sy[i], vz = kn.sz[i];
    const c1x = sy * vz - sz * vy, c1y = sz * vx - sx * vz, c1z = sx * vy - sy * vx;
    const c2x = sy * c1z - sz * c1y, c2y = sz * c1x - sx * c1z, c2z = sx * c1y - sy * c1x;
    wx = vx + A * c1x + B * c2x; wy = vy + A * c1y + B * c2y; wz = vz + A * c1z + B * c2z;
  }
  const h = R.heading * D2R, ch = Math.cos(h), sh = Math.sin(h); // Ry(heading)
  out[0] = ch * wx + sh * wz; out[1] = wy; out[2] = -sh * wx + ch * wz;
}

function buildJac(P) {
  const { n, m, vk, vj, vd } = P;
  P.J.fill(0);
  P.stamp++;
  for (let k = 0; k < n; k++) {
    const col = k * m;
    if (vk[k] === 0) {
      const ji = vj[k];
      if (P.omStamp[ji] !== P.stamp) fillOmega(P, ji);
      const o = ji * 9 + 3 * vd[k];
      OMV[0] = P.om[o]; OMV[1] = P.om[o + 1]; OMV[2] = P.om[o + 2]; OMV[3] = 1;
      emitRotation(P, col, ji);
    } else if (vk[k] === 1) {
      const R = REGION[vj[k]], c = vd[k], o = k * MAXV;
      for (let v = 0; v < R.n; v++) {
        const coef = P.rdw[o + v];
        if (coef === 0) continue;
        const ji = R.ji[v];
        if (P.omStamp[ji] !== P.stamp) fillOmega(P, ji);
        const q = ji * 9 + 3 * c;
        OMV[0] = P.om[q]; OMV[1] = P.om[q + 1]; OMV[2] = P.om[q + 2]; OMV[3] = coef;
        emitRotation(P, col, ji);
      }
    } else if (vk[k] === 2) { // translation: the pole terms do not feel it
      const ax = vj[k];
      for (let t = 0; t < P.nt; t++) {
        if (P.tk[t] === T_DIR || P.tk[t] === T_POLE) continue;
        EV.fill(0); EV[ax] = 1;
        emit(P, col, t);
      }
    } else { // root rotation: about the pelvis centre
      rootOmega(P, vj[k], OMV);
      OMV[3] = 1;
      emitRotation(P, col, 0);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Levenberg-Marquardt with an active set
/** Cholesky solve of the nf x nf system in Hs (row-major, lower triangle used and overwritten) with right-hand side b; result in out. false: not positive definite. */
function cholSolve(H, nf, b, out) {
  for (let i = 0; i < nf; i++) {
    const ri = i * nf;
    for (let j = 0; j <= i; j++) {
      const rj = j * nf;
      let s = H[ri + j];
      for (let k = 0; k < j; k++) s -= H[ri + k] * H[rj + k];
      if (i === j) { if (!(s > 1e-300)) return false; H[ri + i] = Math.sqrt(s); } else H[ri + j] = s / H[rj + j];
    }
  }
  for (let i = 0; i < nf; i++) { let s = b[i]; const ri = i * nf; for (let k = 0; k < i; k++) s -= H[ri + k] * out[k]; out[i] = s / H[ri + i]; }
  for (let i = nf - 1; i >= 0; i--) { let s = out[i]; for (let k = i + 1; k < nf; k++) s -= H[k * nf + i] * out[k]; out[i] = s / H[i * nf + i]; }
  return true;
}

/** Gradient g, the active set (variables not blocked at a limit) and the normal matrix of the active variables, at the current state. */
function prepareStep(P, x) {
  const { n, m, J, r, s, x0, xr, lo, hi, g, act, posn } = P;
  const eps = 1e-10;
  for (let k = 0; k < n; k++) {
    let a = 0;
    const o = k * m;
    for (let i = 0; i < m; i++) a += J[o + i] * r[i];
    a += P.mu * s[k] * (x[k] - x0[k]);
    if (P.rho > 0) a += P.mu * P.rho * s[k] * (x[k] - xr[k]);
    g[k] = a;
  }
  let na = 0;
  for (let k = 0; k < n; k++) {
    const blocked = (x[k] <= lo[k] + eps && g[k] > 0) || (x[k] >= hi[k] - eps && g[k] < 0);
    if (blocked) posn[k] = -1; else { act[na] = k; posn[k] = na++; }
  }
  P.na = na;
  for (const c of P.caps) { // joints at the 180 degree cap of the combined swing: the step must not push outward
    let s2 = 0;
    const jd = JOINTS[c.ji];
    for (let d = 0; d < NDOF[c.ji]; d++) if (jd.dof[d].role !== "twist") s2 += (P.angArr[c.ji][d] * D2R) ** 2;
    const rho = Math.sqrt(s2);
    c.on = rho >= PI - 1e-7;
    if (c.on) for (let q = 0; q < c.ks.length; q++) c.u[q] = (P.angArr[c.ji][P.vd[c.ks[q]]] * D2R) / rho;
  }
  // normal matrix, term by term: only the variables that move a term (a nonzero block) meet in its rows
  const H = P.H0, L = P.tvars;
  H.fill(0, 0, na * na);
  for (let t = 0; t < P.nt; t++) {
    const row = P.trow[t], rows = TERM_ROWS[P.tk[t]];
    let nl = 0;
    for (let a = 0; a < na; a++) {
      const o = act[a] * m + row;
      let nzero = false;
      for (let q = 0; q < rows; q++) if (J[o + q] !== 0) { nzero = true; break; }
      if (nzero) L[nl++] = a;
    }
    for (let i = 0; i < nl; i++) {
      const a = L[i], oa = act[a] * m + row;
      for (let j = 0; j <= i; j++) {
        const b = L[j], ob = act[b] * m + row;
        let q = 0;
        for (let r2 = 0; r2 < rows; r2++) q += J[oa + r2] * J[ob + r2];
        H[a * na + b] += q;
        if (a !== b) H[b * na + a] += q;
      }
    }
  }
  for (let a = 0; a < na; a++) H[a * na + a] += P.mu * s[act[a]] * (1 + P.rho);
}

/** One solve of the damped, box-constrained step into P.dl; `mask` bit c = the cap c is held (its radial step is forced to zero by a stiff penalty). */
function solveStep(P, x, lam, mask) {
  const { na, act, posn, lo, hi, g, H0, Hs, b, dl, fx, sol, idx, fpos } = P;
  dl.fill(0);
  fx.fill(0);
  let nf = na;
  for (let pass = 0; pass < 5; pass++) {
    nf = 0;
    for (let a = 0; a < na; a++) if (!fx[act[a]]) { fpos[act[a]] = nf; idx[nf++] = act[a]; }
    if (nf === 0) break;
    for (let i = 0; i < nf; i++) {
      const pa = posn[idx[i]];
      let rhs = -g[idx[i]];
      for (let a = 0; a < na; a++) { const kf = act[a]; if (fx[kf]) rhs -= H0[pa * na + a] * dl[kf]; }
      b[i] = rhs;
      for (let j = 0; j < nf; j++) Hs[i * nf + j] = H0[pa * na + posn[idx[j]]];
      Hs[i * nf + i] += lam;
    }
    for (let c = 0; c < P.caps.length; c++) {
      if (!(mask & (1 << c))) continue;
      const cap = P.caps[c];
      for (let q = 0; q < cap.ks.length; q++) {
        if (posn[cap.ks[q]] < 0 || fx[cap.ks[q]]) continue;
        for (let r2 = 0; r2 < cap.ks.length; r2++) if (posn[cap.ks[r2]] >= 0 && !fx[cap.ks[r2]]) Hs[fpos[cap.ks[q]] * nf + fpos[cap.ks[r2]]] += CAP_STIFF * cap.u[q] * cap.u[r2];
      }
    }
    if (!cholSolve(Hs, nf, b, sol)) return false;
    let clipped = false;
    for (let i = 0; i < nf; i++) {
      const k = idx[i], v = x[k] + sol[i];
      if (v < lo[k] - 1e-12) { fx[k] = 1; dl[k] = lo[k] - x[k]; clipped = true; } else if (v > hi[k] + 1e-12) { fx[k] = 1; dl[k] = hi[k] - x[k]; clipped = true; } else dl[k] = sol[i];
    }
    if (!clipped) break;
  }
  return true;
}
const CAP_STIFF = 1e7;

/** The damped step into P.dl (zero for blocked variables, clipped at the limits for the others, tangent to the swing cap where it is active). false: singular. */
function computeStep(P, x, lam) {
  if (!solveStep(P, x, lam, 0)) return false;
  let mask = 0;
  for (let c = 0; c < P.caps.length; c++) {
    const cap = P.caps[c];
    if (!cap.on) continue;
    let d = 0;
    for (let q = 0; q < cap.ks.length; q++) d += cap.u[q] * P.dl[cap.ks[q]];
    if (d > 1e-10) mask |= 1 << c;
  }
  return mask === 0 ? true : solveStep(P, x, lam, mask);
}

const MU_STEPS = 4; // mu = 1, 0.1, 0.01, 0.001
/**
 * Iterate from the current x. Returns { iters, status } with status "ok" (every goal within tolerance), "stalled" (stationary), "maxiter". The soft
 * preferences are relaxed (mu / 10) at a stationary point only while the worst goal error is below `polishBelow` (the first run always does).
 * x is updated in place; on return the FK / term state corresponds to x.
 */
function lm(P, maxIter, polishBelow = Infinity) {
  const { x, xt, n } = P;
  setMu(P, 1);
  let F = evaluate(P, x), lam = P.lambda0, nu = 2, iters = 0, mulevel = 0, small = 0, slow = 0, prevW = Infinity;
  if (!(F < Infinity)) return { iters, status: "stalled" };
  while (true) {
    if (P.ok) return { iters, status: "ok" };
    if (iters >= maxIter) return { iters, status: "maxiter" };
    iters++;
    buildJac(P);
    prepareStep(P, x);
    let accepted = false, tiny = false;
    for (let tries = 0; tries < 12; tries++) {
      if (!computeStep(P, x, lam)) { lam = Math.min(lam * 10, 1e9); continue; }
      let mx = 0, big = 0;
      for (let k = 0; k < n; k++) { const a = Math.abs(P.dl[k]); if (a > big) big = a; }
      const sc = big > P.stepMax ? P.stepMax / big : 1; // a trust region: no variable moves more than stepMax per iteration
      for (let k = 0; k < n; k++) { xt[k] = Math.min(P.hi[k], Math.max(P.lo[k], x[k] + sc * P.dl[k])); const a = Math.abs(xt[k] - x[k]); if (a > mx) mx = a; }
      if (mx < 1e-11) { tiny = true; break; }
      // reduction the quadratic model predicts for this step (before the cap projection)
      const { na, act, g, H0 } = P;
      let gd = 0, dHd = 0;
      for (let a = 0; a < na; a++) {
        const ka = act[a], da = xt[ka] - x[ka];
        if (da === 0) continue;
        let hd = 0;
        for (let b = 0; b < na; b++) hd += H0[a * na + b] * (xt[act[b]] - x[act[b]]);
        gd += g[ka] * da; dHd += da * hd;
      }
      const pred = -(gd + 0.5 * dHd);
      capSwing(P, xt);
      const Fn = evaluate(P, xt);
      const rho = pred > 0 ? (F - Fn) / pred : F - Fn > 0 ? 1 : -1;
      if (Fn < F && rho > 1e-4) {
        const gain = F - Fn;
        x.set(xt);
        lam = Math.max(lam * Math.max(1 / 3, 1 - (2 * rho - 1) ** 3), 1e-9); nu = 2; // Nielsen's rule
        small = gain < 1e-12 * (F + 1e-12) ? small + 1 : 0;
        let w = 0; // the worst goal error: when it stops improving the penalised problem is solved and the soft preferences must give way
        for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w) w = P.te[t];
        slow = prevW - w < Math.max(1e-3 * prevW, 1e-9) ? slow + 1 : 0; prevW = w;
        F = Fn; accepted = true;
        break;
      }
      lam = Math.min(lam * nu, 1e9); nu *= 2;
    }
    if (!accepted) evaluate(P, x); // the FK state must match x again
    if (accepted && !tiny && small < 2 && slow < 2) continue;
    // stationary: tighten the soft preferences and go on, or give up
    if (P.ok) return { iters, status: "ok" };
    let w1 = 0;
    for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w1) w1 = P.te[t];
    if (mulevel + 1 < MU_STEPS && w1 < polishBelow) {
      mulevel++; setMu(P, Math.pow(0.1, mulevel)); lam = P.lambda0; nu = 2; small = 0; slow = 0; prevW = Infinity;
      F = evaluate(P, x);
      continue;
    }
    return { iters, status: "stalled" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Warm start: the analytic two-bone solution
const W = {
  U: new THREE.Vector3(), M: new THREE.Vector3(), E: new THREE.Vector3(), T: new THREE.Vector3(), h: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), wt: new THREE.Vector3(),
  q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), q4: new THREE.Quaternion(), qp: new THREE.Quaternion(), ql: new THREE.Quaternion(),
};

function syncVars(P) {
  for (let k = 0; k < P.n; k++) if (P.vk[k] === 0) P.x[k] = Math.min(P.hi[k], Math.max(P.lo[k], P.angArr[P.vj[k]][P.vd[k]] * D2R));
}

const PSI = [0, 25, -25, 50, -50, 80, -80, 110, -110, 150, -150, 180].map((d) => d * D2R); // swivel samples about the chord (radians)
const SECTOR = (psi) => { const a = Math.abs(psi) * R2D; return a <= 40 ? 0 : a > 140 ? 3 : psi > 0 ? 1 : 2; }; // 0 pole side, 1 and 2 swivelled sideways, 3 opposite

/** How far (degrees, summed over the DOF, including the 180 degree swing cap) angles are outside the range of motion of a joint. */
function romExcess(jd, ang) {
  let e = 0, sw = 0;
  for (let d = 0; d < ang.length; d++) {
    const dd = jd.dof[d];
    e += Math.max(0, dd.min - ang[d], ang[d] - dd.max);
    if (dd.role !== "twist") sw += ang[d] * ang[d];
  }
  return e + Math.max(0, Math.sqrt(sw) - 180);
}

/**
 * The analytic two-bone solution of the limb of pole entry `qi` with its end joint at W.wt (a world position): the middle joint on the pole side
 * (poleFrame), the upper joint turned the shortest way onto the new upper bone, the hinge from the law of cosines, a swivel about the upper bone that
 * brings the end joint onto the target. Every swivel angle about the chord from the shoulder to the target gives another solution; they are ranked by how far
 * the upper joint is outside its range of motion (then by the distance from the pole side), and the best one of the requested sector is written into the
 * angle arrays (clamped, so the pose is always inside the ranges; what the clamp spoils the iteration repairs). Returns false when no solution exists.
 */
function warmLimb(P, qi, sector) {
  const pe = P.poles[qi], kin = P.kin, Pk = kin.positions, Qk = kin.quaternions;
  const { ju, jm, je } = pe, wt = W.wt, jd = JOINTS[ju];
  W.U.set(Pk[3 * ju], Pk[3 * ju + 1], Pk[3 * ju + 2]); W.M.set(Pk[3 * jm], Pk[3 * jm + 1], Pk[3 * jm + 2]);
  const e3 = 3 * je, keep0 = Pk[e3], keep1 = Pk[e3 + 1], keep2 = Pk[e3 + 2];
  const v2 = new THREE.Vector3(keep0 - W.M.x, keep1 - W.M.y, keep2 - W.M.z).normalize(); // lower bone now
  const hand = W.h.clone(); // end joint -> goal point, rotates with the lower bone
  let estar = null, a = null, D = 0;
  for (let pass = 0; pass < 3; pass++) { // the end joint target: goal target minus the hand offset as it will stand once the limb has moved
    wt.copy(W.T).sub(hand);
    Pk[e3] = wt.x; Pk[e3 + 1] = wt.y; Pk[e3 + 2] = wt.z; // the pole frame for the end joint at wt
    poleFrame(P, qi, POLE_TMP);
    Pk[e3] = keep0; Pk[e3 + 1] = keep1; Pk[e3 + 2] = keep2;
    a = W.a.copy(wt).sub(W.U); D = a.length();
    if (D < 1e-9) return false;
    a.multiplyScalar(1 / D);
    estar = W.b.copy(W.U).addScaledVector(a, POLE_TMP[0]).add(W.c.set(POLE_TMP[1], POLE_TMP[2], POLE_TMP[3])).clone();
    const v2n = new THREE.Vector3().copy(wt).sub(estar).normalize();
    hand.copy(W.h).applyQuaternion(W.q4.setFromUnitVectors(v2, v2n));
  }
  const u1 = W.c.copy(W.M).sub(W.U).normalize(), u1p = W.d.copy(estar).sub(W.U).normalize();
  W.q1.setFromUnitVectors(u1, u1p);
  W.q2.set(Qk[4 * ju], Qk[4 * ju + 1], Qk[4 * ju + 2], Qk[4 * ju + 3]);
  const p4 = 4 * PARENT[ju];
  W.qp.set(Qk[p4], Qk[p4 + 1], Qk[p4 + 2], Qk[p4 + 3]).invert(); // parent orientation, inverted
  W.q3.copy(W.q1).multiply(W.q2); // upper joint after the shortest turn onto E*
  const axis = u1p.clone(), lower = new THREE.Vector3().copy(wt).sub(estar).normalize();
  const beta = Math.acos(Math.min(1, Math.max(-1, axis.dot(lower)))) * R2D;
  const mj = JOINTS[jm].dof[0], flex = Math.min(mj.max, Math.max(mj.min, beta - P.S.limbs[pe.limb].beta0));
  // exact stage-1 pose (no clamping) to measure where the end joint lands, then the swivel that fixes it
  W.ql.copy(W.qp).multiply(W.q3);
  const raw = anglesFromQuaternion(IDS[ju], W.ql);
  for (let d = 0; d < NDOF[ju]; d++) P.angArr[ju][d] = raw[d];
  P.angArr[jm][0] = beta - P.S.limbs[pe.limb].beta0;
  kin.solve(P.ang, P.root);
  const Ux = Pk[3 * ju], Uy = Pk[3 * ju + 1], Uz = Pk[3 * ju + 2];
  const ca = new THREE.Vector3(Pk[3 * je] - Ux, Pk[3 * je + 1] - Uy, Pk[3 * je + 2] - Uz), cb = new THREE.Vector3(wt.x - Ux, wt.y - Uy, wt.z - Uz);
  ca.addScaledVector(axis, -ca.dot(axis)); cb.addScaledVector(axis, -cb.dot(axis));
  let psi0 = 0;
  if (ca.lengthSq() > 1e-12 && cb.lengthSq() > 1e-12) psi0 = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(ca, cb)), ca.dot(cb));
  // the chord from the upper joint to the target is the axis of the swivel family (the middle joint goes round it)
  const chord = a.clone();
  const q0 = new THREE.Quaternion().setFromAxisAngle(axis, psi0).multiply(W.q3); // the solution for the pole side
  let best = null;
  for (const psi of PSI) {
    const qi2 = new THREE.Quaternion().setFromAxisAngle(chord, psi).multiply(q0);
    const sec = SECTOR(psi);
    if (sector !== undefined && sec !== sector) continue;
    const ang = anglesFromQuaternion(IDS[ju], W.ql.copy(W.qp).multiply(qi2));
    const score = romExcess(jd, ang) * 100 + Math.abs(psi) * R2D * 0.01;
    if (!best || score < best.score) best = { score, ang };
  }
  if (!best) return false;
  const c = clampAngles(IDS[ju], best.ang).angles;
  for (let d = 0; d < NDOF[ju]; d++) P.angArr[ju][d] = c[d];
  P.angArr[jm][0] = flex;
  syncVars(P);
  return true;
}

/** The analytic warm start for every limb that has a position goal on its end chain. `sector` selects the swivel family (see SECTOR). Returns true when a limb was set. */
function warmStart(P, sector) {
  if (!P.poles.length) return false;
  let any = false;
  P.poles.forEach((pe, qi) => {
    let best = -1; // the heaviest position term on the chain of the end joint
    for (let t = 0; t < P.ngoal; t++) if (P.tk[t] === T_POS && ANC[pe.je * N + P.tj[t]] && (best < 0 || P.tbase[t] > P.tbase[best])) best = t;
    if (best < 0) return;
    P.kin.solve(P.ang, P.root);
    evalTerms(P); // the goal point's world position at the current angles
    const e3 = 3 * pe.je, t3 = 3 * best, Pk = P.kin.positions;
    W.T.set(P.ttgt[t3], P.ttgt[t3 + 1], P.ttgt[t3 + 2]);
    W.h.set(P.tp[t3] - Pk[e3], P.tp[t3 + 1] - Pk[e3 + 1], P.tp[t3 + 2] - Pk[e3 + 2]); // end joint -> goal point
    if (!(Math.abs(W.T.x) + Math.abs(W.T.y) + Math.abs(W.T.z) < 1e6)) return;
    if (warmLimb(P, qi, sector)) any = true;
  });
  return any;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reach bound: the farthest a goal point can be from the centre of the topmost free joint of its chain, assuming straight bones
function reachBound(P, t) {
  if (P.tk[t] !== T_POS) return null;
  for (let k = 0; k < P.n; k++) if (P.vk[k] >= 2) return null; // the root moves
  const freeJoint = P.freeJoint;
  let top = -1;
  for (let a = P.tj[t]; a > 0; a = PARENT[a]) if (freeJoint[a]) top = a; // the topmost free ancestor
  if (top < 0) return null; // nothing moves
  let len = Math.hypot(P.toff[3 * t], P.toff[3 * t + 1], P.toff[3 * t + 2]);
  const off = P.S.kin.offsets;
  for (let a = P.tj[t]; a !== top; a = PARENT[a]) len += Math.hypot(off[3 * a], off[3 * a + 1], off[3 * a + 2]);
  return { top, len };
}

// ---------------------------------------------------------------------------------------------------------------------
// The solve
function snapshot(P) { return { x: Float64Array.from(P.x), sign: Float64Array.from(P.tsign) }; }
function restore(P, s) { P.x.set(s.x); P.tsign.set(s.sign); }

function chooseSigns(P) {
  for (let t = 0; t < P.ngoal; t++) {
    if (!P.tline[t]) continue;
    const t3 = 3 * t, d = P.td[t3] * P.ttgt[t3] + P.td[t3 + 1] * P.ttgt[t3 + 1] + P.td[t3 + 2] * P.ttgt[t3 + 2];
    P.tsign[t] = d >= 0 ? 1 : -1;
  }
}

/** Is any goal beyond what a straight chain of its free joints could reach? Then no restart can succeed. */
function provablyOutOfReach(P) {
  evaluate(P, P.x0);
  const Pk = P.kin.positions;
  for (let t = 0; t < P.ngoal; t++) {
    const b = reachBound(P, t);
    if (!b) continue;
    const t3 = 3 * t, d = Math.hypot(P.ttgt[t3] - Pk[3 * b.top], P.ttgt[t3 + 1] - Pk[3 * b.top + 1], P.ttgt[t3 + 2] - Pk[3 * b.top + 2]);
    if (d > b.len + P.slots[P.tslot[t]].tol) return true;
  }
  return false;
}

function optimise(P) {
  const S = P.S;
  setPoleDirs(P, S);
  setMu(P, 1);
  P.freeJoint = new Uint8Array(N); // free joints (for the reach bound)
  for (let k = 0; k < P.n; k++) {
    if (P.vk[k] === 0) P.freeJoint[P.vj[k]] = 1;
    else if (P.vk[k] === 1) for (const j of REGION[P.vj[k]].ji) P.freeJoint[j] = 1;
  }
  const F0 = evaluate(P, P.x);
  if (P.ok) return { iters: 0, status: "ok" }; // already there: the pose is returned untouched
  if (P.n === 0) { chooseSigns(P); return { iters: 0, status: "stalled" }; } // nothing is free: there is nothing to solve
  // restarts: by default 8, but only 1 when the start is already close to the goals (a drag follows a path: the previous pose is the right basin)
  if (P.restarts < 0) { let w0 = 0; for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w0) w0 = P.te[t]; P.restarts = w0 < 0.05 ? 1 : 8; }
  chooseSigns(P);
  const plain = Float64Array.from(P.x), signs0 = Float64Array.from(P.tsign);
  // the analytic two-bone solution for a swivel sector, from the pose as given
  const analytic = (sector) => {
    const keep = P.angArr.map((a) => a.slice());
    P.x.set(plain); applyVars(P, P.x);
    const got = warmStart(P, sector);
    const x = got ? Float64Array.from(P.x) : null;
    for (let i = 0; i < N; i++) for (let d = 0; d < NDOF[i]; d++) P.angArr[i][d] = keep[i][d];
    return x;
  };
  const warm = P.useWarm && P.poles.length ? analytic(undefined) : null;
  let first = plain;
  if (warm && evaluate(P, warm) < F0) first = warm;
  P.x.set(first);
  evaluate(P, P.x); chooseSigns(P);
  let totalIters = 0;
  const res = lm(P, P.maxIter);
  totalIters += res.iters;
  let best = { snap: snapshot(P), ok: P.ok, gc: P.gc, status: res.status };
  // when to stop restarting: three restarts ended where the best run ended (that is the closest the pose gets), or the best is already within 3 cm and three
  // restarts in a row did not improve on it (a goal just beyond what the limits allow)
  let still = 0, agree = 0;
  const worst = () => { let w = 0; for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w) w = P.te[t]; return w; };
  best.err = worst();
  const consider = (r2) => {
    totalIters += r2.iters;
    const err = worst();
    if (!P.ok && Math.abs(P.gc - best.gc) <= 1e-3 * best.gc + 1e-12) agree++;
    if ((P.ok && !best.ok) || (!best.ok && P.gc < best.gc * (1 - 1e-3))) { best = { snap: snapshot(P), ok: P.ok, gc: P.gc, status: r2.status, err }; still = 0; } else still++;
  };
  if (!best.ok) P.provablyUnreachable = provablyOutOfReach(P); // beyond a straight chain of the free joints: no pose and no restart can help
  if (!best.ok && P.maxIter > 0 && P.restarts > 0) {
    if (!P.provablyUnreachable) {
      const half = Math.max(10, P.maxIter >> 1), rng = mulberry32(P.seed);
      const run = (xs, flip) => {
        P.x.set(xs); evaluate(P, P.x);
        if (flip) { for (let t = 0; t < P.ngoal; t++) if (P.tline[t]) P.tsign[t] = -signs0[t]; } else P.tsign.set(signs0);
        consider(lm(P, half, 0.03)); // a restart is polished only when it comes close
      };
      const queue = [];
      // random poses of the free joints (40 samples cost about the same as one LM iteration each): the best few by cost are refined
      let pool = null;
      const sampled = (i) => {
        if (!pool) {
          pool = [];
          for (let q = 0; q < 40; q++) {
            const cand = Float64Array.from(plain);
            for (let k = 0; k < P.n; k++) { if (P.vk[k] > 1) continue; cand[k] = P.lo[k] + rng() * (P.hi[k] - P.lo[k]); }
            capSwing(P, cand);
            pool.push({ x: cand, f: evaluate(P, cand) });
          }
          pool.sort((u, v) => u.f - v.f);
        }
        return pool[i]?.x;
      };
      const analyticRun = (sec) => () => { const x = analytic(sec); if (x) run(x, false); };
      const sampleRun = (i) => () => { const x = sampled(i); if (x) run(x, false); };
      if (warm) queue.push(() => run(first === warm ? plain : warm, false));
      if (P.poles.length) queue.push(analyticRun(1), analyticRun(2));
      queue.push(sampleRun(0), sampleRun(1));
      if (P.poles.length) queue.push(analyticRun(3));
      if (P.tline.some((v, t) => v && t < P.ngoal)) queue.push(() => run(first, true));
      for (let i = 2; i < 12; i++) queue.push(sampleRun(i));
      for (let q = 0; q < queue.length && q < P.restarts && !best.ok && agree < 3 && !(best.err < 0.03 && still >= 3); q++) queue[q]();
    }
  }
  restore(P, best.snap);
  evaluate(P, P.x);
  return { iters: totalIters, status: best.status };
}

function solveImpl(S, start, goals, options = {}) {
  const t0 = now();
  const P = compile(S, start, goals, options);
  const out = optimise(P);
  return finish(P, out, start, t0);
}

function finish(P, out, start, t0) {
  const S = P.S;
  // slot errors from the final state (a line goal takes the nearer sign)
  for (const sl of P.slots) sl.err = 0;
  let cost = 0;
  for (let t = 0; t < P.ngoal; t++) {
    const sl = P.slots[P.tslot[t]];
    sl.err = Math.max(sl.err, P.te[t]);
    const rows = TERM_ROWS[P.tk[t]], row = P.trow[t];
    for (let a = 0; a < rows; a++) cost += P.r[row + a] ** 2;
  }
  const error = {}, tolerances = {}, units = {};
  let reachable = true;
  for (const sl of P.slots) { error[sl.id] = sl.err; tolerances[sl.id] = sl.tol; units[sl.id] = sl.unit; if (sl.err > sl.tol) reachable = false; }
  // pose out
  const angles = {};
  const src = start.angles ?? {};
  for (const id of Object.keys(src)) { const i = INDEX.get(id); angles[id] = Array.from({ length: NDOF[i] }, (_, d) => S.angArr[i][d]); }
  const touched = new Set();
  for (let k = 0; k < P.n; k++) {
    if (P.vk[k] === 0) touched.add(P.vj[k]);
    else if (P.vk[k] === 1) for (const j of REGION[P.vj[k]].ji) touched.add(j);
  }
  for (const i of touched) angles[IDS[i]] = Array.from({ length: NDOF[i] }, (_, d) => nz(S.angArr[i][d]));
  const R = P.root;
  const root = { x: R.x, y: R.y, z: R.z, heading: R.heading, flex: R.flex, lat: R.lat, rot: R.rot };
  // joints at a limit
  const clamped = [];
  let blocking = null;
  const limits = [];
  for (let k = 0; k < P.n; k++) {
    if (P.vk[k] > 1) continue;
    const atLo = P.x[k] <= P.lo[k] + 1e-9, atHi = P.x[k] >= P.hi[k] - 1e-9;
    if (atLo || atHi) limits.push(k);
  }
  if ((limits.length || P.caps.length) && !reachable) { // which of them push against the goals?
    buildJac(P); prepareStep(P, P.x);
    blocking = new Set();
    for (const k of limits) if ((P.x[k] <= P.lo[k] + 1e-9 && P.g[k] > 1e-9) || (P.x[k] >= P.hi[k] - 1e-9 && P.g[k] < -1e-9)) blocking.add(k);
  }
  for (const k of limits) {
    const atLo = P.x[k] <= P.lo[k] + 1e-9;
    if (P.vk[k] === 0) {
      const jd = JOINTS[P.vj[k]], d = jd.dof[P.vd[k]];
      clamped.push({ joint: jd.id, dof: d.key, value: atLo ? d.min : d.max, limit: atLo ? "min" : "max", bound: atLo ? d.min : d.max, blocking: blocking ? blocking.has(k) : false });
    } else {
      const c = P.vd[k];
      clamped.push({ joint: REGION_IDS[P.vj[k]], dof: CHAN[c], value: R2D * (P.x[k] + P.rbase[k].reduce((a, v) => a + v * D2R, 0)), limit: atLo ? "min" : "max", bound: null, region: true, blocking: blocking ? blocking.has(k) : false });
    }
  }
  for (const c of P.caps) { // the 180 degree cap of the combined swing, as a limit of its own
    let s2 = 0;
    for (let d = 0; d < NDOF[c.ji]; d++) if (JOINTS[c.ji].dof[d].role !== "twist") s2 += (S.angArr[c.ji][d] * D2R) ** 2;
    if (Math.sqrt(s2) < PI - 1e-6) continue;
    let push = 0;
    if (blocking) for (let q = 0; q < c.ks.length; q++) push -= (S.angArr[c.ji][P.vd[c.ks[q]]] * D2R / Math.sqrt(s2)) * P.g[c.ks[q]];
    clamped.push({ joint: IDS[c.ji], dof: "swing", value: 180, limit: "max", bound: 180, cap: true, blocking: blocking ? push > 1e-9 : false });
  }
  const changed = [];
  for (const id of IDS) {
    const i = INDEX.get(id), a0 = src[id];
    for (let d = 0; d < NDOF[i]; d++) if (Math.abs(S.angArr[i][d] - (a0?.[d] ?? 0)) > 1e-9) { changed.push(id); break; }
  }
  const rootChanged = ["x", "y", "z", "heading", "flex", "lat", "rot"].some((k) => Math.abs(root[k] - P.root0[k]) > 1e-12);
  const res = {
    root, angles, pose: { root, angles }, converged: out.status !== "maxiter", iterations: out.iters, error, units, tolerance: tolerances, residual: Math.sqrt(cost), clamped, changed,
    reachable, ms: now() - t0, rootChanged,
  };
  if (P.provablyUnreachable) res.provablyUnreachable = true;
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnostics: the Jacobian
function jacobianImpl(S, start, goals, options = {}) {
  const P = compile(S, start, goals, options);
  setPoleDirs(P, S);
  setMu(P, 1);
  evaluate(P, P.x);
  chooseSigns(P);
  evaluate(P, P.x);
  buildJac(P);
  const rows = [];
  for (let t = 0; t < P.nt; t++) for (let a = 0; a < TERM_ROWS[P.tk[t]]; a++) rows.push(`${t < P.ngoal ? P.slots[P.tslot[t]].id : "pole"}:${t}.${a}`);
  const J = new Float64Array(P.m * P.n);
  for (let k = 0; k < P.n; k++) for (let i = 0; i < P.m; i++) J[i * P.n + k] = P.J[k * P.m + i];
  const poseAt = (xv) => {
    applyVars(P, xv);
    const angles = {};
    for (let i = 0; i < N; i++) angles[IDS[i]] = Array.from(P.angArr[i]);
    return { root: { ...P.root }, angles };
  };
  return { names: P.names.slice(), rows, J, r: Float64Array.from(P.r), x: Float64Array.from(P.x), n: P.n, m: P.m, poseAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reach envelope: random in-ROM poses of an arm (and the trunk), their end points and the convex hull
/**
 * Three-dimensional convex hull of a point cloud (incremental, O(n f)). Returns { vertices: Float64Array (3 per vertex), faces: Uint32Array (3 per
 * triangle, counter-clockwise seen from outside) }; empty when the points do not span a volume.
 */
export function convexHull(points) {
  const n = Math.floor(points.length / 3);
  const P = (i) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
  if (n < 4) return { vertices: new Float64Array(0), faces: new Uint32Array(0) };
  let i0 = 0, i1 = 0;
  for (let i = 1; i < n; i++) { if (points[3 * i] < points[3 * i0]) i0 = i; if (points[3 * i] > points[3 * i1]) i1 = i; }
  if (i0 === i1) { i1 = 1; }
  const a = P(i0), b = P(i1), ab = sub3(b, a);
  let i2 = -1, best = 1e-12;
  for (let i = 0; i < n; i++) { const c = cross3(ab, sub3(P(i), a)); const l = dot3(c, c); if (l > best) { best = l; i2 = i; } }
  if (i2 < 0) return { vertices: new Float64Array(0), faces: new Uint32Array(0) };
  const nrm = norm3(cross3(ab, sub3(P(i2), a)));
  let i3 = -1; best = 1e-9;
  for (let i = 0; i < n; i++) { const d = Math.abs(dot3(nrm, sub3(P(i), a))); if (d > best) { best = d; i3 = i; } }
  if (i3 < 0) return { vertices: new Float64Array(0), faces: new Uint32Array(0) };
  const faces = [];
  const mk = (p, q, r) => {
    const A = P(p), n3 = cross3(sub3(P(q), A), sub3(P(r), A)), l = Math.hypot(...n3);
    if (l < 1e-18) return null;
    const nn = [n3[0] / l, n3[1] / l, n3[2] / l];
    return { p, q, r, n: nn, d: dot3(nn, A), live: true };
  };
  const base = [i0, i1, i2, i3], cen = [0, 1, 2].map((k) => (P(i0)[k] + P(i1)[k] + P(i2)[k] + P(i3)[k]) / 4);
  for (const [p, q, r] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
    let f = mk(base[p], base[q], base[r]);
    if (dot3(f.n, cen) - f.d > 0) f = mk(base[p], base[r], base[q]); // the centroid must be behind every face
    faces.push(f);
  }
  const used = new Set(base);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const p = P(i), vis = [];
    for (const f of faces) if (f.live && dot3(f.n, p) - f.d > 1e-9) vis.push(f);
    if (!vis.length) continue;
    const edges = new Map();
    for (const f of vis) for (const [u, v] of [[f.p, f.q], [f.q, f.r], [f.r, f.p]]) edges.set(`${u},${v}`, [u, v]);
    for (const f of vis) f.live = false;
    for (const [key, [u, v]] of edges) { // horizon: edges whose twin is not also removed
      if (edges.has(`${v},${u}`)) continue;
      const f = mk(u, v, i);
      if (f) { if (dot3(f.n, cen) - f.d > 0) { const g = mk(v, u, i); faces.push(g); } else faces.push(f); }
    }
    used.add(i);
    if (faces.length > 8 * n) break;
  }
  const live = faces.filter((f) => f.live), map = new Map(), verts = [];
  const id = (v) => { if (!map.has(v)) { map.set(v, verts.length / 3); verts.push(points[3 * v], points[3 * v + 1], points[3 * v + 2]); } return map.get(v); };
  const tri = [];
  for (const f of live) tri.push(id(f.p), id(f.q), id(f.r));
  return { vertices: Float64Array.from(verts), faces: Uint32Array.from(tri) };
}

function envelopeImpl(S, start, side, options = {}) {
  const t0 = now();
  const sd = sideOf(side);
  const { samples = 2000, seed = 1, trunk = false, clavicle = true, rangeFraction = 1, hull = true } = options;
  const landmark = options.landmark ?? "grip_centre";
  if (!(Number.isInteger(samples) && samples >= 1 && samples <= 200000)) throw new RangeError("samples must be an integer from 1 to 200000");
  if (!(isNum(rangeFraction) && rangeFraction > 0 && rangeFraction <= 1)) throw new RangeError("rangeFraction must be a number in (0, 1]");
  const e = S.lm.get(`${landmark}_${sd}`) ?? S.lm.get(landmark);
  if (!e) throw new Error(`unknown landmark "${landmark}"`);
  loadStart(S, start);
  const kin = S.kin, rng = mulberry32(seed);
  kin.solve(S.ang, S.root);
  const sh = INDEX.get(`shoulder_${sd}`), origin = [kin.positions[3 * sh], kin.positions[3 * sh + 1], kin.positions[3 * sh + 2]];
  const ids = [...GROUP[`arm_${sd}`], ...(clavicle ? [`clavicle_${sd}`] : [])].map((id) => INDEX.get(id));
  const regions = trunk ? [0, 1] : [];
  const pts = new Float32Array(3 * samples), out = new THREE.Vector3();
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity], cen = [0, 0, 0];
  let maxD = 0, far = [0, 0, 0];
  const dl = new Float64Array(MAXV), dw = new Float64Array(MAXV);
  for (let i = 0; i < samples; i++) {
    for (const ji of ids) {
      const jd = JOINTS[ji], a = jd.dof.map((d) => { const mid = (d.min + d.max) / 2, half = ((d.max - d.min) / 2) * rangeFraction; return mid + (rng() * 2 - 1) * half; });
      const c = clampAngles(jd.id, a).angles;
      for (let d = 0; d < NDOF[ji]; d++) S.angArr[ji][d] = c[d];
    }
    for (const r of regions) {
      const R = REGION[r];
      for (let c = 0; c < 3; c++) {
        const A = new Float64Array(R.n), B = new Float64Array(R.n);
        let sa = 0, sb = 0;
        for (let v = 0; v < R.n; v++) { A[v] = R.lo[c][v]; B[v] = R.hi[c][v]; sa += A[v]; sb += B[v]; }
        const mid = (sa + sb) / 2, half = ((sb - sa) / 2) * rangeFraction, T = mid + (rng() * 2 - 1) * half;
        fillRegion(T, R.w[c], A, B, R.n, dl, dw, 0);
        for (let v = 0; v < R.n; v++) S.angArr[R.ji[v]][c] = dl[v] * R2D;
      }
    }
    kin.solve(S.ang, S.root);
    toWorld(kin, e.ji, e.off, out);
    pts[3 * i] = out.x; pts[3 * i + 1] = out.y; pts[3 * i + 2] = out.z;
    for (let k = 0; k < 3; k++) { const v = pts[3 * i + k]; if (v < bmin[k]) bmin[k] = v; if (v > bmax[k]) bmax[k] = v; cen[k] += v / samples; }
    const d = Math.hypot(out.x - origin[0], out.y - origin[1], out.z - origin[2]);
    if (d > maxD) { maxD = d; far = [out.x, out.y, out.z]; }
  }
  const h = hull ? convexHull(pts) : null;
  return { points: pts, count: samples, bounds: { min: bmin, max: bmax }, centroid: cen, origin, maxDistance: maxD, farthest: far, hull: h, side: sd, landmark: `${landmark}_${sd}`, ms: now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers for the editor and the sandbox
const asPoint = (v, what) => vec3(v, what);

/**
 * Reach a point with a hand. `target` is [x, y, z] in metres. options: landmark ("grip_centre", the default: the axis of a handle held in the fist; or
 * "palm_centre", "index_tip", "middle_tip", ... without the side), frame { normal, axis, line } for the palm normal and the bar axis (see handFrameFromGrip),
 * trunk (true: the lumbar and thoracic spine may lean and turn), pelvis (a free-name or array, for example "pelvis-xz"), and every option of solve().
 * Free by default: the arm and the clavicle of that side.
 */
export function reachHand(solver, start, side, target, options = {}) {
  const sd = sideOf(side), { landmark = "grip_centre", frame = null, trunk = false, pelvis = null, weight, ...rest } = options;
  const lm = solver.landmarkIds.includes(landmark) ? landmark : `${landmark}_${sd}`;
  const id = rest.id ?? `hand_${sd}`;
  delete rest.id;
  const goal = frame
    ? { ...handFrameFromGrip({ position: target, normal: frame.normal, axis: frame.axis, diameter: landmark === "palm_centre" ? 0 : 1 }, sd, { landmark: lm, line: frame.line !== false }), id }
    : { type: "position", id, landmark: lm, target: asPoint(target, "target") };
  if (weight != null) goal.weight = weight;
  const free = rest.free ?? [`arm_${sd}`, `clavicle_${sd}`, ...(trunk ? ["trunk"] : []), ...(pelvis ? [].concat(pelvis) : [])];
  delete rest.free;
  return solver.solve(start, [goal], { free, ...rest });
}

/**
 * The frame goal that puts a hand on a grip of the catalogue: { position, normal, axis, diameter } -> a goal for solve(). `normal` is the direction the
 * palm faces (from the hand toward the object), `axis` the direction of the bar the fingers wrap around (its sign is free: the hand may take it either way).
 * The hand frame (documented in IK.md): palm normal = the direction the open palm faces, "hand_across" = the line of the knuckles from the little finger to the index
 * finger (the axis the fingers curl about, so the axis of a gripped bar), "finger_axis" = from the wrist to the middle knuckle. The point that goes to `position` is
 * grip_centre (the axis of a handle held in the fist), or palm_centre for a flat contact (diameter 0).
 */
export function handFrameFromGrip(grip, side, options = {}) {
  const sd = sideOf(side);
  if (grip === null || typeof grip !== "object") throw new TypeError("grip must be { position, normal, axis }");
  const flat = grip.diameter === 0;
  const landmark = options.landmark ?? (flat ? `palm_centre_${sd}` : `grip_centre_${sd}`);
  return {
    type: "frame", id: options.id ?? `hand_${sd}`, joint: `wrist_${sd}`, landmark, target: asPoint(grip.position, "grip.position"),
    axes: [
      { local: "palm_normal", world: unit3(grip.normal, "grip.normal"), weight: options.normalWeight ?? 1 },
      { local: "hand_across", world: unit3(grip.axis, "grip.axis"), line: options.line !== false, weight: options.axisWeight ?? 1 },
    ],
    ...(options.weight != null ? { weight: options.weight } : {}),
  };
}

/**
 * Put a foot somewhere. spec: { position: [x, y, z], landmark ("ball_centre", the default; "heel_sole", "toe_sole", "ball_sole_medial", ...; without the side
 * unless it is a virtual point), heading (degrees, the world yaw of the foot axis; omitted: not constrained), flat (true by default: the sole is horizontal),
 * soleNormal ([x, y, z], the direction the sole faces, for a tilted pedal; replaces flat) }. Free by default: the leg of that side.
 */
export function placeFoot(solver, start, side, spec, options = {}) {
  const sd = sideOf(side), { landmark = "ball_centre", position, heading, flat = true, soleNormal } = spec ?? {};
  const lm = solver.landmarkIds.includes(`${landmark}_${sd}`) ? `${landmark}_${sd}` : landmark;
  const goals = [{ type: "position", id: `foot_${sd}`, landmark: lm, target: asPoint(position, "spec.position"), ...(options.weight != null ? { weight: options.weight } : {}) }];
  const axes = [];
  if (soleNormal != null) axes.push({ local: "sole_normal", world: unit3(soleNormal, "spec.soleNormal") });
  else if (flat) axes.push({ local: "sole_normal", world: [0, -1, 0] });
  if (heading != null) {
    if (!isNum(heading)) throw new RangeError("spec.heading must be a number of degrees");
    const h = heading * D2R;
    axes.push({ local: "foot_forward", world: [Math.sin(h), 0, Math.cos(h)] });
  }
  if (axes.length) goals.push({ type: "frame", id: `foot_${sd}.frame`, joint: `ankle_${sd}`, axes });
  const { weight, ...rest } = options;
  return solver.solve(start, goals, { free: [`leg_${sd}`], ...rest });
}

/**
 * Look at a world point. The eyes converge on it (options.eyes false: the cyclopean axis of the head points at it). Free by default: the neck (cervical
 * spine and the head joint) and the eyes; add `trunk: true` to let the trunk turn when the neck runs out of range. The error is the angle (radians) between
 * the line of sight and the line to the target (the larger of the two eyes).
 */
export function lookAt(solver, start, target, options = {}) {
  const { eyes = true, trunk = false, weight, ...rest } = options;
  const goal = { type: "lookAt", id: rest.id ?? "lookAt", target: asPoint(target, "target"), eyes, ...(weight != null ? { weight } : {}) };
  delete rest.id;
  const free = rest.free ?? ["neck", ...(eyes ? ["eyes"] : []), ...(trunk ? ["trunk"] : [])];
  delete rest.free;
  return solver.solve(start, [goal], { free, ...rest });
}

/**
 * Pin goals: keep landmarks where they are in pose `start` (a `pin` goal each: weight 100, tolerance a fifth of the default, so almost hard). `ids` are landmark ids.
 */
export function pinGoals(solver, start, ids, options = {}) {
  return ids.map((id) => {
    const p = solver.worldPoint(start, id);
    return { type: "pin", id: `pin:${id}`, landmark: id, target: [p.x, p.y, p.z], weight: options.weight ?? 100, ...(options.tolerance != null ? { tolerance: options.tolerance } : {}) };
  });
}
const FOOT_PINS = (s) => [`heel_sole_${s}`, `ball_sole_medial_${s}`, `ball_sole_lateral_${s}`];

/**
 * Move the pelvis and keep the rest where it is. move: { dy } or { dx, dy, dz } (metres) or { target: [x, y, z] } (the new pelvis position). options:
 * pinFeet (default true: the heel and the two balls of each foot stay), pinHands (false), pin (more landmark ids), free (default both legs, plus the arms
 * and clavicles when the hands are pinned), and every option of solve(). The root is moved first and the legs re-solved, so it is the squat / stand-up solver:
 * root.y decreases, hips and knees flex, the feet stay.
 */
export function movePelvis(solver, start, move, options = {}) {
  if (move === null || typeof move !== "object") throw new TypeError("move must be { dy } | { dx, dy, dz } | { target: [x, y, z] }");
  const { pinFeet = true, pinHands = false, pin = [], ...rest } = options;
  const r0 = start.root ?? solver.restRoot;
  const to = move.target != null ? asPoint(move.target, "move.target") : [(r0.x ?? 0) + (move.dx ?? 0), (r0.y ?? 0) + (move.dy ?? 0), (r0.z ?? 0) + (move.dz ?? 0)];
  for (const v of to) if (!isNum(v)) throw new RangeError("the new pelvis position must be finite");
  const ids = [...(pinFeet ? SIDES.flatMap(FOOT_PINS) : []), ...(pinHands ? SIDES.map((s) => `grip_centre_${s}`) : []), ...pin];
  const goals = pinGoals(solver, start, ids, { weight: rest.pinWeight });
  delete rest.pinWeight;
  const moved = { root: { ...r0, x: to[0], y: to[1], z: to[2] }, angles: start.angles ?? {} };
  const free = rest.free ?? [...(pinFeet ? ["legs"] : []), ...(pinHands ? ["arms", "clavicles"] : [])];
  delete rest.free;
  return solver.solve(moved, goals, { free, ...rest });
}

/**
 * The farthest the hand can reach from its shoulder along a direction (default: straight ahead of the pelvis): scans from the straight-chain bound inward, then
 * bisects. options: direction ([x, y, z] in the world, default the heading of the pelvis), from ("shoulder", the default, or [x, y, z]), landmark, trunk, and the
 * options of reachHand. Returns { distance, point, origin, direction, result } (distance from the origin to the farthest reachable point found on the ray).
 */
export function maxReach(solver, start, side, options = {}) {
  const sd = sideOf(side), { direction, from = "shoulder", scan = 24, bisect = 14, ...rest } = options;
  const h = (start.root?.heading ?? 0) * D2R;
  const dir = unit3(direction ?? [Math.sin(h), 0, Math.cos(h)], "direction");
  const o = from === "shoulder" ? solver.worldPoint(start, { joint: `shoulder_${sd}` }) : new THREE.Vector3(...asPoint(from, "from"));
  const origin = [o.x, o.y, o.z];
  const at = (d) => [origin[0] + dir[0] * d, origin[1] + dir[1] * d, origin[2] + dir[2] * d];
  const tryD = (d) => reachHand(solver, start, sd, at(d), { restarts: 3, ...rest });
  // upper bound: the arm straight plus the hand (and the trunk when it may lean)
  const w = solver.worldPoint(start, { joint: `wrist_${sd}` }), g = solver.worldPoint(start, `grip_centre_${sd}`);
  const e = solver.worldPoint(start, { joint: `elbow_${sd}` });
  let hi = o.distanceTo(e) + e.distanceTo(w) + w.distanceTo(g) + (rest.trunk ? 0.9 : 0.15);
  let best = null, lo = 0, hiBad = hi;
  for (let i = 0; i <= scan; i++) {
    const d = hi * (1 - i / scan), r = tryD(d);
    if (r.reachable) { best = { d, r }; lo = d; break; }
    hiBad = d;
  }
  if (!best) return { distance: 0, point: origin, origin, direction: dir, result: null };
  for (let i = 0; i < bisect && hiBad - lo > 1e-4; i++) {
    const m = 0.5 * (lo + hiBad), r = tryD(m);
    if (r.reachable) { best = { d: m, r }; lo = m; } else hiBad = m;
  }
  return { distance: best.d, point: at(best.d), origin, direction: dir, result: best.r };
}

/** Reach envelope of a hand: random in-ROM poses of the arm (and the trunk), see solver.reachEnvelope. */
export function reachEnvelope(solver, start, side, options) {
  return solver.reachEnvelope(start, side, options);
}

/**
 * Plain-English lines for a Result: [] when every goal is met, otherwise one sentence per goal that is not ("hand_R: 120 mm short of the target"), naming
 * the joints that sit at a limit and push against it. `labels` maps goal ids to words ({ hand_R: "The right hand" }).
 */
export function describeResult(result, labels = {}) {
  const lines = [];
  const limits = (result.clamped ?? []).filter((c) => c.blocking);
  for (const [id, err] of Object.entries(result.error ?? {})) {
    const tol = result.tolerance?.[id] ?? DEFAULT_TOL;
    if (!(err > tol)) continue;
    const angle = result.units?.[id] === "rad", what = labels[id] ?? id;
    const deg = err * R2D, mm = err * 1000;
    const amount = angle ? `${deg.toFixed(deg < 10 ? 1 : 0)} degrees off` : `${mm.toFixed(mm < 10 ? 1 : 0)} mm short of`;
    let why = "";
    if (result.provablyUnreachable) why = " (farther than the limb can stretch)";
    else if (limits.length) why = ` (limited by ${limits.slice(0, 4).map((c) => `${JOINT_BY_ID[c.joint]?.label ?? c.joint} ${c.dof} at its ${c.limit === "max" ? "maximum" : "minimum"}`).join(", ")})`;
    lines.push(`${what}: ${amount} the target${why}.`);
  }
  return lines;
}
