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
// * the first run starts from the pose as given (the analytic two-bone pose instead from 20 cm of error, or with options.analyticStart: a straight limb that has to
//   bend is a singular point). A run that fails (a local minimum at the joint limits, an arm that has to go over the head) is retried: the analytic two-bone solution
//   (shoulder-elbow-wrist, hip-knee-ankle, elbow / knee toward a pole direction, swivel sampled inside the range of motion), the other sign of the line goals, then
//   random poses ranked by cost, deterministically (seeded); a goal that is still 5 mm off after all of them gets more random poses (EXTRA_RESTARTS), since runs
//   that agree only prove that they fell into the same corner. The runs from the start and from the analytic poses can all fall into the same corner of the ranges, so
//   the search stops early only when random poses have agreed too. A reach bound (a straight chain of the free joints) tells goals that no pose can reach: for those
//   the closest pose is searched for (the distance has local minima as well), unless the first run is already as close as the straight chain allows;
// * the winner is SETTLED (settle()): the first iterate within tolerance is on the way to the goals, not where the soft preferences put the redundancy, so the
//   iteration goes on, almost undamped, on the penalised problem, as long as every goal stays within a quarter of its tolerance (or where it was);
// * free DOF that no goal depends on (the fingers, the other leg, ... of a big free set) are not variables: they keep their value (idle, see compile());
// * FOLLOWING a pose (the start is near the goals, or options.follow: a drag): the pose is the previous frame, so the variables stay in a trust region around it
//   (0.03 rad + 4 rad per metre of starting error, widened x4 at a time when relaxing the soft preferences has not brought the goals nearer although the goals push a variable against the border, or when
//   the preferences are out of the way and a variable sits on it; the preferences then start over at full strength), and options.maxMove bounds the move of every variable per call (DRAG_OPTIONS: 0.04 rad). The soft preferences that are absolute
//   (the pole of the elbow, the avoidance of the ends of the ranges) would otherwise carry the pose to wherever they are minimal in one call, and a minimum
//   that appears or disappears with the goal makes the pose jump: the pole is the side the limb is on in the start (or in options.reference) for a near
//   goal and the default one for a far goal, and the avoidance (which keeps a tracked hand out of the corners of the ranges where the figure would stop
//   following) fades out between 2 and 5 cm of error, so the pose is a continuous function of the goal where the automatic follow switches on. The avoidance is
//   relative to the start (it resists going deeper into a zone, it never pulls a joint out of one): an absolute pull toward the edge of the zone moved a posture
//   that sat in a zone 40 degrees in one call and kept a held goal beyond the reach sliding in the null space of the arm for hundreds of frames.
//   A call that is bound by maxMove, whose region is full and whose goals are still 100 tolerances off ends there (the figure is on its way) instead of relaxing
//   the preferences, which cannot help while the region is the limit.
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
 * Options for a live drag: no restarts (the previous pose is the right basin, so a goal beyond the reach costs one run, not nine), a short iteration budget,
 * `follow` (the start is the previous frame: it is never replaced by an analytic or random pose) and `maxMove` 0.04 (no variable changes by more than 2.3 degrees
 * per call: a pose that is stuck, or a handle that jumps, makes the figure glide toward the goal over a few frames instead of snapping; `result.limited` says so).
 * solver.solve(pose, goals, { ...DRAG_OPTIONS, free }) ; call again without them when the drag ends if the result must be as good as the solver can make it.
 */
export const DRAG_OPTIONS = Object.freeze({ restarts: 0, maxIterations: 24, follow: true, maxMove: 0.04 });

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
// Soft avoidance of the ends of the ranges of motion (cost length in metres per radian, and the width of the zone before each end as a part of the half range):
// a tracked hand that wanders into a corner of the ranges (a joint at its limit, the clavicle at both of its limits, the shoulder at the 180 degree cap) has no
// way out and the figure stops following the handle; this resists the redundant joints going deeper into the zone of an end than they were at the start of the call
// (zoneExcess), so the joints that have room take the motion. It is scaled by mu like the other soft preferences, so a goal that needs the end of a range gets it. Only while following a pose (a drag): for a reach from far away the order of
// the stiffness decides which joint takes the motion, and a clavicle at its limit is better than an elbow that is never straight.
const LIMIT_COST = 0.05, LIMIT_ZONE = 0.5;
// The trust region of a solve that follows a previous pose: the variables stay within TRUST_MIN + TRUST_GAIN * (worst starting goal error in metres) radians of
// their start (a translation counts TRANS_PER_RAD metres per radian), widened by TRUST_GROW when the soft preferences are exhausted and a variable sits on the border of the region.
const TRUST_MIN = 0.03, TRUST_GAIN = 4, TRUST_GROW = 4, TRUST_OPEN = 6, FOLLOW_BELOW = 0.05, LIMIT_FULL = 0.02, POLE_START_NEAR = 0.05, POLE_START_FAR = 0.2, STRAIGHT_BELOW = 10; // STRAIGHT_BELOW: degrees of elbow or knee flexion below which a limb has no side
const EXTRA_RESTARTS = 8, EXTRA_BELOW = 0.005, POOL = 40; // more random restarts for a goal that is still 5 mm off or more when the first ones agree; random poses sampled per solve
const CLOSEST_RESTARTS = 10; // restarts for a goal beyond the reach: the closest pose is searched for, not a pose that meets it
const TRANS_PER_RAD = 0.5; // metres of pelvis translation that count as one radian in the trust region
const DOF_FACTOR = { "shoulder.rot": 1.5, "hip.rot": 4, "knee.rot": 5, "ankle.inv": 3, "ankle.rot": 5, "wrist.dev": 1.2, "hip.abd": 2 };
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
const FAR = 1e7; // metres: a point beyond ten thousand kilometres is a mistake, and its square would not leave room for the sums of the solver
function vec3(v, what, far = FAR) {
  const a = Array.isArray(v) || ArrayBuffer.isView(v) ? v : v !== null && typeof v === "object" ? [v.x, v.y, v.z] : null;
  if (!a || a.length !== 3) throw new TypeError(`${what} must be [x, y, z] (metres)`);
  if (!isNum(a[0]) || !isNum(a[1]) || !isNum(a[2])) throw new RangeError(`${what} must be three finite numbers, got ${JSON.stringify([a[0], a[1], a[2]])}`);
  if (Math.abs(a[0]) > far || Math.abs(a[1]) > far || Math.abs(a[2]) > far) throw new RangeError(`${what} is absurdly far away (more than ${far} m from the origin): ${JSON.stringify([a[0], a[1], a[2]])}`);
  return [a[0], a[1], a[2]];
}
function unit3(v, what) { // a direction: any length is fine, only its direction counts
  const a = vec3(v, what, Infinity), m = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
  if (!(m > 1e-12)) throw new RangeError(`${what} must not be the zero vector`);
  const b = [a[0] / m, a[1] / m, a[2] / m], l = Math.hypot(b[0], b[1], b[2]); // scaled first: the length of [1e200, 1e200, 0] does not overflow
  return [b[0] / l, b[1] / l, b[2] / l];
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
  const S = { kin, lm, restRootY, offsets, ang: {}, angArr: [], root: { x: 0, y: 0, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }, kinRef: null, angRef: {} };
  for (let i = 0; i < N; i++) { S.angArr.push(new Float64Array(NDOF[i])); S.ang[IDS[i]] = S.angArr[i]; S.angRef[IDS[i]] = new Float64Array(NDOF[i]); } // typed: V8 never boxes a read of them in Kinematics.solve

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
    // the line through the landmarks of the heads of the metacarpals (what a measurement along the knuckles sees): about 6 degrees from the line of the knuckle
    // joints in the neutral pose, which is the hand_across the grips use (the fingers curl about the joints). Same sign as hand_across.
    let line = null;
    const mr = lm.get(`metacarpale_radiale_${s}`), mu = lm.get(`metacarpale_ulnare_${s}`);
    if (mr && mu) {
      const at = (e) => [0, 1, 2].map((k) => P0[3 * e.ji + k] + e.off[k]); // every joint frame is the world frame in the neutral pose
      line = norm3(sub3(at(mr), at(mu)));
      if (dot3(line, across) < 0) line = line.map((v) => -v);
    }
    S.hand[s] = { finger: f, across, normal: n, line };
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
    if (id.startsWith("wrist_")) ax = { palm_normal: S.hand[s].normal, finger_axis: S.hand[s].finger, hand_across: S.hand[s].across, ...(S.hand[s].line ? { knuckle_line: S.hand[s].line } : {}) };
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
    /** Named hand axes of the neutral pose, in the wrist frame: { finger, across, normal, line } per side (unit vectors; line: through the metacarpale landmarks, about 6 degrees from across). */
    handFrame: (side) => { const h = S.hand[sideOf(side)]; return { finger: [...h.finger], across: [...h.across], normal: [...h.normal], ...(h.line ? { line: [...h.line] } : {}) }; },
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
const ROOT_FIELDS = ["x", "y", "z", "heading", "flex", "lat", "rot"];
/** A finite number can still be absurd: its square, or the sine of an angle that large, would leave no meaning in the sums of the solver. */
function checkMagnitude(obj, keys, what) {
  for (const k of keys) { const v = obj[k]; if (v !== undefined && Math.abs(v) > FAR) throw new RangeError(`${what}${k} is absurdly large (more than ${FAR} ${["x", "y", "z"].includes(k) ? "m" : "degrees"}): ${v}`); }
}
function loadStart(S, start) {
  if (start === null || typeof start !== "object") throw new TypeError("start must be a pose { root, angles } (what rig.getPose() returns)");
  const root = S.root;
  const r = start.root ?? null;
  if (r === null) { Object.assign(root, { x: 0, y: S.restRootY, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }); } else {
    if (typeof r !== "object") throw new TypeError("start.root must be an object { x, y, z, heading, flex, lat, rot }");
    for (const k of Object.keys(r)) if (!ROOT_FIELDS.includes(k)) throw new Error(`start.root: unknown field "${k}"`);
    checkRoot(r);
    checkMagnitude(r, ROOT_FIELDS, "start.root.");
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
    for (let k = 0; k < NDOF[i] && k < c.length; k++) if (Math.abs(c[k]) > FAR) throw new RangeError(`start.angles.${id}: angle ${k} is absurdly large (more than ${FAR} degrees): ${c[k]}`);
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
    const table = S.axes.get(ji), a = Object.hasOwn(table, spec) ? table[spec] : null;
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
  if (!(isNum(posTol) && posTol > 0) || !(isNum(angTol) && angTol > 0)) throw new RangeError("options.tolerance (metres) and options.angTolerance (radians) must be finite numbers > 0");
  const uniq = (base) => { let id = base, k = 2; while (ids.has(id)) id = `${base}#${k++}`; ids.add(id); return id; };
  const slot = (id, unit, tol) => { slots.push({ id, unit, tol, err: 0 }); return slots.length - 1; };
  const needStartFK = goals.some((g) => g && ((g.type === "pin" && g.target == null) || g.type === "aim" || g.type === "lookAt"));
  if (needStartFK) S.kin.solve(S.ang, S.root);
  goals.forEach((g, gi) => {
    if (g === null || typeof g !== "object") throw new TypeError(`goal ${gi} must be an object`);
    const type = g.type ?? "position";
    const idBase = g.id ?? g.landmark ?? g.joint ?? type;
    if (typeof idBase !== "string" || idBase === "") throw new TypeError(`goal ${gi}: id must be a non-empty string`);
    const id = uniq(String(idBase));
    const what = `goal "${id}"`;
    const weight = g.weight ?? (type === "pin" ? 100 : 1);
    if (!isNum(weight) || weight < 0 || weight > 1e12) throw new RangeError(`${what}: weight must be a finite number from 0 to 1e12`);
    if (weight === 0) return;
    // `tolerance` is in the unit of the goal's error: metres for a point, radians for a direction, an aim, a look-at, a frame without a position;
    // `angTolerance` is the radians of the orientation of a frame that also has a position. A pin is meant to stay put: five times tighter.
    const angular = type === "direction" || type === "aim" || type === "lookAt" || (type === "frame" && g.target == null);
    const tol = angular ? posTol : g.tolerance ?? (type === "pin" ? 0.2 * posTol : posTol);
    const atol = g.angTolerance ?? (angular ? g.tolerance : undefined) ?? angTol;
    if (!(isNum(tol) && tol > 0) || !(isNum(atol) && atol > 0)) throw new RangeError(`${what}: tolerance and angTolerance must be finite numbers > 0`);
    const add = (t) => terms.push({ w: weight, ...t });
    const aimTerm = (pt, dirSpec, target, sl) => {
      // the direction from the point to the target is undefined when they coincide (the gaze at the eye itself)
      const here = toWorld(S.kin, pt.ji, pt.off, new THREE.Vector3());
      if (Math.hypot(here.x - target[0], here.y - target[1], here.z - target[2]) < 1e-6) throw new RangeError(`${what}: the target is at the point that aims (${here.x.toFixed(3)}, ${here.y.toFixed(3)}, ${here.z.toFixed(3)}): the direction is undefined`);
      add({ kind: T_AIM, ji: pt.ji, off: pt.off, dir: localDir(S, pt.ji, dirSpec, `${what}.axis`), tgt: target, slot: sl });
    };
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
        if (Math.abs(g.height) > FAR) throw new RangeError(`${what}: height ${g.height} is absurdly far away`);
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
          for (const a of axes) {
            const aw = a.weight ?? 1;
            if (!isNum(aw) || aw < 0 || !(weight * aw <= 1e12)) throw new RangeError(`${what}.axes: an axis weight must be a finite number from 0 to 1e12 (times the goal weight), got ${JSON.stringify(a.weight)}`);
            add({ kind: T_DIR, ji, dir: localDir(S, ji, a.local, `${what}.axes.local`), tgt: unit3(a.world, `${what}.axes.world`), line: !!a.line, w: weight * aw, slot: sl });
          }
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
    // [x, y, z, w] or { x, y, z, w } (a THREE.Quaternion): every part must be there as a number (the THREE constructor would turn a missing one into 0 or 1)
    const a = Array.isArray(q) || ArrayBuffer.isView(q) ? (q.length === 4 ? [q[0], q[1], q[2], q[3]] : null) : typeof q === "object" ? [q.x, q.y, q.z, q.w] : null;
    if (!a) throw new TypeError(`${what}.quaternion must be [x, y, z, w] or { x, y, z, w }`);
    if (!a.every(isNum)) throw new RangeError(`${what}.quaternion must be four finite numbers, got ${JSON.stringify(a)}`);
    const Q = new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    if (Q.lengthSq() < 1e-12) throw new RangeError(`${what}.quaternion must not be all zero`);
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
/** options.reference is a pose like start: unknown joints, non-finite angles and root fields are errors (a silent NaN would stop the solve before it began). */
function checkReference(ref) {
  const root = ref.root ?? null, angles = ref.angles ?? null;
  if (root !== null) {
    if (typeof root !== "object") throw new TypeError("options.reference.root must be an object { x, y, z, heading, flex, lat, rot }");
    for (const k of Object.keys(root)) if (!ROOT_FIELDS.includes(k)) throw new Error(`options.reference.root: unknown field "${k}"`);
    try { checkRoot(root); checkMagnitude(root, ROOT_FIELDS, "root."); } catch (e) { e.message = `options.reference: ${e.message}`; throw e; }
  }
  if (angles !== null) {
    if (typeof angles !== "object") throw new TypeError("options.reference.angles must be an object { jointId: [degrees] }");
    const scratch = new Float64Array(3);
    for (const id of Object.keys(angles)) {
      const i = INDEX.get(id);
      if (i === undefined) throw new Error(`options.reference.angles: unknown joint id "${id}"`);
      const v = angles[id];
      if (v === null || typeof v !== "object" || typeof v.length !== "number") throw new TypeError(`options.reference.angles.${id} must be an array in DOF order (${JOINTS[i].dof.map((d) => d.key).join(", ")})`);
      try { checkedAngles(JOINTS[i], v, scratch); } catch (e) { e.message = `options.reference: ${e.message}`; throw e; }
    }
  }
}
/**
 * A chosen posture (options.reference) also says where the elbows and the knees are: the default pole (elbows down and out, knees forward) would pull them away from it
 * 30 times harder than the reference pull on the angles holds them. So the pole of a limb without a pole of its own is the direction from the upper joint to the middle
 * joint in the reference pose: the joints the reference does not name, and the root fields it leaves out, are those of the start. A limb that is straight there
 * has no swivel to keep: it keeps the default.
 */
function referencePoles(P, ref) {
  const S = P.S;
  S.kinRef ??= Object.assign(new Kinematics(S.offsets), { strict: false });
  for (let i = 0; i < N; i++) {
    const a = ref.angles?.[IDS[i]];
    for (let d = 0; d < NDOF[i]; d++) S.angRef[IDS[i]][d] = a ? a[d] ?? 0 : P.angArr[i][d];
  }
  const rr = ref.root ?? {}, r0 = P.root0;
  S.kinRef.solve(S.angRef, { x: rr.x ?? r0.x, y: rr.y ?? r0.y, z: rr.z ?? r0.z, heading: rr.heading ?? r0.heading, flex: rr.flex ?? r0.flex, lat: rr.lat ?? r0.lat, rot: rr.rot ?? r0.rot });
  const Pk = S.kinRef.positions;
  for (const pe of P.poles) {
    if (pe.user) continue;
    const u = 3 * pe.ju, m = 3 * pe.jm, e = 3 * pe.je;
    const vx = Pk[m] - Pk[u], vy = Pk[m + 1] - Pk[u + 1], vz = Pk[m + 2] - Pk[u + 2], v = Math.hypot(vx, vy, vz);
    if (!(v > 1e-6) || Math.abs(S.angRef[IDS[pe.jm]][0]) < STRAIGHT_BELOW) continue; // a (nearly) straight limb has no side to keep
    pe.ref = [vx / v, vy / v, vz / v];
  }
}
// The keys of options.stiffness: the groups of COST, every joint id and group of sided joints ("shoulder"), each with its DOF ("shoulder_R.flex", "shoulder.flex", "L3.flex"),
// the spine regions with their channels ("lumbar.flex") and the pelvis ("pelvis", "pelvis.y", "pelvis.tilt"). A key that is not in this set is a typo and an error.
const ROOT_NAMES = ["x", "y", "z", "heading", "flex", "lat", "rot"];
const STIFFNESS_KEYS = new Set([...Object.keys(COST).filter((name) => !/^(t[xyz]|heading|tilt)$/.test(name)), "pelvis", "pelvis.tilt", ...ROOT_NAMES.map((n) => `pelvis.${n}`)]);
for (const r of REGION_IDS) for (const c of CHAN) STIFFNESS_KEYS.add(`${r}.${c}`);
for (let i = 1; i < N; i++) for (const id of [IDS[i], baseName(IDS[i])]) { STIFFNESS_KEYS.add(id); for (const d of JOINTS[i].dof) STIFFNESS_KEYS.add(`${id}.${d.key}`); }
const OPTION_KEYS = ["free", "lock", "maxIterations", "tolerance", "angTolerance", "damping", "stiffness", "reference", "referenceWeight", "pole", "poleWeight", "angleScale", "stepMax", "rootRange", "restarts", "seed", "warmStart", "analyticStart", "follow", "maxMove", "limitStiffness"];
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
  // A free DOF that no goal depends on (a finger, an eye, the other leg, while the goals are on one hand) cannot help any goal and costs time (the normal matrix grows with the
  // square of the variables, the Cholesky factor with the cube): it keeps the value it has. Not with a reference (that pulls every free variable toward the chosen posture),
  // and not when the start is outside the ranges (a free joint is repaired). The joint still appears in the result, as before.
  P.idle = new Set();
  if (options.reference == null) {
    const dep = new Uint8Array(N); // joints that a goal point or direction hangs on, and their ancestors
    for (const t of terms) for (let a = t.ji; a >= 0; a = PARENT[a]) dep[a] = 1;
    const inRange = (i, d) => S.angArr[i][d] >= JOINTS[i].dof[d].min && S.angArr[i][d] <= JOINTS[i].dof[d].max;
    const swingOk = (i) => !CAP_JOINTS.includes(i) || Math.hypot(...JOINTS[i].dof.map((dd, d) => (dd.role === "twist" ? 0 : S.angArr[i][d] * D2R))) <= PI;
    for (let i = 1; i < N; i++) {
      if (dep[i] || !swingOk(i)) continue;
      for (let d = 0; d < NDOF[i]; d++) if (flags.dof[i * 3 + d] && inRange(i, d)) { flags.dof[i * 3 + d] = 0; P.idle.add(i); }
    }
    for (let r = 0; r < 3; r++) {
      if (REGION[r].ji.some((j) => dep[j])) continue;
      for (let c = 0; c < 3; c++) if (flags.reg[r * 3 + c] && REGION[r].ji.every((j) => inRange(j, c))) { flags.reg[r * 3 + c] = 0; for (const j of REGION[r].ji) P.idle.add(j); }
    }
  }
  // a vertebra named in `free` while its region is free is part of the region
  const vk = [], vj = [], vd = [], lo = [], hi = [], x0 = [], x0deg = [], cost = [], names = [], rbase = [], rA = [], rB = [];
  const stiff = options.stiffness ?? {};
  if (typeof stiff !== "object" || Array.isArray(stiff)) throw new TypeError("options.stiffness must be an object { key: cost length in metres per radian }");
  const costFor = (key, dflt) => { const v = Object.hasOwn(stiff, key) ? stiff[key] : undefined; if (v === undefined) return dflt; if (!(isNum(v) && v >= 0)) throw new RangeError(`options.stiffness.${key} must be a cost length >= 0 (metres per radian)`); return v; };
  for (const k of Object.keys(stiff)) if (!STIFFNESS_KEYS.has(k)) throw new Error(`options.stiffness: unknown key "${k}" (a group such as "clavicle", "lumbar", "hand" or "vertebra", a joint id such as "shoulder_R", "joint.dof" such as "shoulder_R.flex" or "shoulder.flex" (both sides), "region.channel" such as "lumbar.flex", "pelvis" or "pelvis.y")`);
  for (let r = 0; r < 3; r++) {
    const R = REGION[r];
    for (let c = 0; c < 3; c++) {
      if (!flags.reg[r * 3 + c]) continue;
      let sumA = 0, sumB = 0;
      const A = new Float64Array(R.n), B = new Float64Array(R.n), base = new Float64Array(R.n);
      for (let v = 0; v < R.n; v++) {
        const locked = flags.locked[R.ji[v] * 3 + c], dd = JOINTS[R.ji[v]].dof[c];
        // a vertebra outside its range is repaired like any free joint (a locked one keeps what it was given); the region total is on top of that
        base[v] = locked ? S.angArr[R.ji[v]][c] : Math.min(dd.max, Math.max(dd.min, S.angArr[R.ji[v]][c]));
        const cur = base[v] * D2R;
        A[v] = Math.min(0, R.lo[c][v] - cur); B[v] = Math.max(0, R.hi[c][v] - cur);
        if (locked) A[v] = B[v] = 0; // a locked vertebra of a free region carries none of the total
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
      const group = isFinger(JOINTS[i]) ? "hand" : REGION_OF[i] >= 0 ? "vertebra" : null; // the fingers and the vertebrae have names of their own, "hand" and "vertebra", for the lot
      cost.push(costFor(`${IDS[i]}.${dd.key}`, costFor(`${b}.${dd.key}`, costFor(IDS[i], costFor(b, group ? costFor(group, costOf(JOINTS[i], d)) : costOf(JOINTS[i], d))))));
      names.push(`${IDS[i]}.${dd.key}`); rbase.push(null); rA.push(null); rB.push(null);
    }
  }
  const R = S.root, rootVals = [R.x, R.y, R.z, R.heading * D2R, R.flex * D2R, R.lat * D2R, R.rot * D2R];
  const rootRange = options.rootRange ?? 1.5; // how far the pelvis may travel from where it is (metres), so that a goal a kilometre away does not launch the figure
  if (!(isNum(rootRange) && rootRange >= 0)) throw new RangeError("options.rootRange must be a distance in metres >= 0");
  const rootNames = ROOT_NAMES, rootCost = [COST.tx, COST.ty, COST.tz, COST.heading, COST.tilt, COST.tilt, COST.tilt];
  for (let k = 0; k < 7; k++) {
    if (!flags.root[k]) continue;
    vk.push(k < 3 ? 2 : 3); vj.push(k < 3 ? k : k - 3); vd.push(0);
    const half = k === 3 ? PI : PI / 2;
    lo.push(k < 3 ? rootVals[k] - rootRange : rootVals[k] - half); hi.push(k < 3 ? rootVals[k] + rootRange : rootVals[k] + half); x0.push(rootVals[k]); x0deg.push([R.x, R.y, R.z, R.heading, R.flex, R.lat, R.rot][k]);
    cost.push(costFor(`pelvis.${rootNames[k]}`, costFor("pelvis", k >= 4 ? costFor("pelvis.tilt", rootCost[k]) : rootCost[k]))); // "pelvis.tilt": flex, lat and rot of the root
    names.push(`pelvis.${rootNames[k]}`); rbase.push(null); rA.push(null); rB.push(null);
  }
  const n = vk.length;
  const limitCost = options.limitStiffness ?? LIMIT_COST; // only while following a pose unless asked for, see optimise()
  if (!(isNum(limitCost) && limitCost >= 0)) throw new RangeError("options.limitStiffness must be a cost length >= 0 (metres per radian)");
  Object.assign(P, {
    n, nt, vk: Uint8Array.from(vk), vj: Int16Array.from(vj), vd: Int8Array.from(vd), lo: Float64Array.from(lo), hi: Float64Array.from(hi), x0: Float64Array.from(x0), x0deg: Float64Array.from(x0deg),
    s: Float64Array.from(cost, (c) => c * c), names, rbase, rA, rB, flags,
    tlo: Float64Array.from(lo), thi: Float64Array.from(hi), B: Infinity, // the trust region (see setBox); lo / hi are the ranges of motion
    // the avoidance of the ends of the ranges: weight, and the borders of the zones (-Infinity / Infinity: none). A limit at 0 (the elbow and the knee straight)
    // is the rest posture, not a corner: it has no zone
    lb: Float64Array.from(vk, (v) => (v === 0 ? limitCost * limitCost : 0)),
    zl: Float64Array.from(vk, (v, k) => (v === 0 && lo[k] < -1e-9 ? lo[k] + LIMIT_ZONE * 0.5 * (hi[k] - lo[k]) : -Infinity)),
    zh: Float64Array.from(vk, (v, k) => (v === 0 && hi[k] > 1e-9 ? hi[k] - LIMIT_ZONE * 0.5 * (hi[k] - lo[k]) : Infinity)),
    d0: new Float64Array(n), // how deep each variable is in the zone of an end at the start (see zoneExcess)
    x: Float64Array.from(x0), xt: new Float64Array(n), xr: Float64Array.from(x0),
    rdelta: new Float64Array(n * MAXV), rdw: new Float64Array(n * MAXV), // region shares and their derivatives per variable
  });
  for (let k = 0; k < n; k++) P.d0[k] = x0[k] < P.zl[k] ? P.zl[k] - x0[k] : x0[k] > P.zh[k] ? x0[k] - P.zh[k] : 0;
  // ---- the swing cap
  P.caps = []; // the cap of the combined swing (180 degrees) as a constraint on the free swing variables of a joint
  for (const ji of CAP_JOINTS) {
    const ks = [];
    for (let k = 0; k < n; k++) if (vk[k] === 0 && vj[k] === ji && JOINTS[ji].dof[vd[k]].role !== "twist") ks.push(k);
    if (ks.length) P.caps.push({ ji, ks, u: new Float64Array(ks.length), on: false });
  }
  // the projection onto the cap (the nearest point of a disk) moves the swing by no more than the step it corrects: a box of B / sqrt 2 keeps the move of each
  // component within B (a box corner is sqrt 2 B away)
  P.boxScale = new Float64Array(n).fill(1);
  for (const c of P.caps) if (c.ks.length > 1) for (const k of c.ks) P.boxScale[k] = Math.SQRT1_2;
  // ---- reference pose (null-space pull)
  P.refW = 0;
  if (options.referenceWeight !== undefined && !(isNum(options.referenceWeight) && options.referenceWeight >= 0)) throw new RangeError("options.referenceWeight must be a number >= 0");
  if (options.reference != null) {
    const ref = options.reference;
    if (ref === null || typeof ref !== "object") throw new TypeError("options.reference must be a pose { root, angles }");
    checkReference(ref);
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
      // the avoidance of the ends of the ranges does not apply where the chosen posture itself sits in the zone of an end: the user put the joint there
      if (P.xr[k] < P.zl[k] || P.xr[k] > P.zh[k]) P.lb[k] = 0;
    }
  }
  // ---- term arrays
  const wsc = options.angleScale ?? 0.3;
  if (!(isNum(wsc) && wsc > 0)) throw new RangeError("options.angleScale must be a finite number > 0 (metres of residual per radian)");
  P.angleScale = wsc;
  P.tk = new Uint8Array(nt); P.tj = new Int16Array(nt); P.toff = new Float64Array(3 * nt); P.tdir = new Float64Array(3 * nt); P.ttgt = new Float64Array(3 * nt);
  P.tsw = new Float64Array(nt); P.tbase = new Float64Array(nt); P.tsign = new Float64Array(nt).fill(1); P.tfix = new Int8Array(nt); P.tline = new Uint8Array(nt); P.tslot = new Int16Array(nt);
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
  const mGoals = m; // rows of the goal terms; the pole terms come after them
  // ---- poles (elbow / knee swivel): soft terms that put the middle joint in the half-plane of the pole direction, see evalTerms
  P.poles = [];
  const poleOpt = options.pole ?? {};
  if (typeof poleOpt !== "object" || Array.isArray(poleOpt)) throw new TypeError("options.pole must be an object { elbow_R: [x, y, z] | false, ... }");
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
      P.poles.push({ limb: li, ju: L.u, jm: L.m, je: L.e, L1: L.L1, L2: L.L2, user: poleOpt[L.name] != null ? unit3(poleOpt[L.name], `options.pole.${L.name}`) : null, ref: null, t: -1 });
    });
    if (options.reference != null && P.poles.some((pe) => !pe.user)) referencePoles(P, options.reference);
    const np = P.poles.length, grow = (arr, k) => { const b = new arr.constructor(arr.length + k); b.set(arr); return b; };
    for (const key of ["tk", "tj", "tsw", "tbase", "tsign", "tfix", "tline", "tslot", "trow", "tdyn", "tD", "te"]) P[key] = grow(P[key], np);
    for (const key of ["toff", "tdir", "ttgt", "tp", "td", "tu"]) P[key] = grow(P[key], 3 * np);
    P.poles.forEach((pe, q) => {
      const i = nt + q;
      P.tk[i] = T_POLE; P.tj[i] = pe.je; P.tsign[i] = 1; P.tslot[i] = -1; P.trow[i] = m; m += 3; P.tdyn[i] = q; P.tbase[i] = Math.sqrt(poleW); P.tsw[i] = P.tbase[i];
      pe.t = i;
    });
  }
  P.m = m; P.mg = mGoals; P.ngoal = nt; P.nt = nt + P.poles.length; // terms [0, ngoal) are goals, [ngoal, nt) are pole terms
  P.sbound = new Float64Array(P.slots.length);
  P.r = new Float64Array(m); P.J = new Float64Array(m * n); P.g = new Float64Array(n); P.gg = new Float64Array(n); // g: gradient of F, gg: of the goal terms alone
  P.om = new Float64Array(N * 9); P.omStamp = new Int32Array(N); P.stamp = 0;
  P.mu = 1; P.rho = P.refW;
  // scratch for the step
  P.H0 = new Float64Array(n * n); P.Hs = new Float64Array(n * n); P.b = new Float64Array(n); P.dl = new Float64Array(n); P.act = new Int16Array(n); P.posn = new Int16Array(n); P.fx = new Uint8Array(n);
  P.sol = new Float64Array(n); P.idx = new Int16Array(n); P.fpos = new Int16Array(n); P.tvars = new Int16Array(n);
  P.lambda0 = options.damping ?? 1e-3;
  P.stepMax = options.stepMax ?? 0.4;
  if (!(isNum(P.lambda0) && P.lambda0 > 0)) throw new RangeError("options.damping must be a finite number > 0");
  if (!(typeof P.stepMax === "number" && P.stepMax > 0)) throw new RangeError("options.stepMax must be a number > 0 (the largest change of one variable per iteration, radians or metres)");
  P.maxIter = options.maxIterations ?? 60;
  if (!(Number.isInteger(P.maxIter) && P.maxIter >= 0)) throw new RangeError("options.maxIterations must be an integer >= 0");
  if (options.restarts !== undefined && !(Number.isInteger(options.restarts) && options.restarts >= 0)) throw new RangeError("options.restarts must be an integer >= 0");
  P.restarts = options.restarts ?? -1; // -1: automatic, see optimise()
  if (options.follow !== undefined && typeof options.follow !== "boolean") throw new TypeError("options.follow must be true, false or undefined (automatic)");
  P.followOpt = options.follow ?? null;
  P.restartsAuto = options.restarts === undefined;
  P.limitOpt = options.limitStiffness;
  P.maxMove = options.maxMove ?? Infinity;
  if (!(typeof P.maxMove === "number" && P.maxMove > 0)) throw new RangeError("options.maxMove must be a number > 0 (radians per variable per call; Infinity: unlimited)");
  P.seed = options.seed ?? 20240607;
  if (!Number.isInteger(P.seed)) throw new RangeError("options.seed must be an integer");
  P.useWarm = options.warmStart !== false;
  if (options.analyticStart !== undefined && typeof options.analyticStart !== "boolean") throw new TypeError("options.analyticStart must be true or false");
  P.analyticStart = options.analyticStart === true;
  P.startPole = 0;
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
      const dx = P.td[t3], dy = P.td[t3 + 1], dz = P.td[t3 + 2];
      // a line goal (a bar axis has no sign) takes the sign that is nearer to the current direction, unless a restart forces the other one (tfix)
      const s = P.tfix[t] !== 0 ? P.tfix[t] : P.tline[t] && dx * tgx + dy * tgy + dz * tgz < 0 ? -1 : 1;
      P.tsign[t] = s;
      const bx = s * tgx, by = s * tgy, bz = s * tgz;
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

/**
 * How much deeper than at the start variable k is in the zone of an end of its range (radians; 0 outside the zone or when it is no deeper than it was). The avoidance
 * of the ends of the ranges penalises only this: it resists a goal that would drive a joint deeper into a corner, so that the joints that have room take the motion,
 * but it never pulls a joint that is in a zone out of it. (An absolute pull toward the edge of the zone carried a posture that sits in a zone 40 degrees away in one
 * call, and kept a held goal beyond the reach sliding in the null space of the arm for hundreds of frames, one frame step after the other.)
 */
function zoneExcess(P, k, xk) {
  const d = xk < P.zl[k] ? P.zl[k] - xk : xk > P.zh[k] ? xk - P.zh[k] : 0;
  return d > P.d0[k] ? d - P.d0[k] : 0;
}

function regCost(P, x) {
  let c = 0;
  const { n, s, x0, xr, lb, zl, zh } = P;
  for (let k = 0; k < n; k++) {
    const d = x[k] - x0[k];
    c += s[k] * d * d;
    if (lb[k] > 0) { const e = zoneExcess(P, k, x[k]); c += lb[k] * e * e; }
  }
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
    else if (pe.ref) v = pe.ref;
    else {
      const b = POLE_BODY[L.kind](L.side);
      v = [b[0] * c + b[2] * sn, b[1], -b[0] * sn + b[2] * c]; // rotation about +Y by the heading
      // near the goal the side the limb is on in the start is the one to keep: the default is mixed in as the goal gets farther (see optimise)
      if (pe.start && P.startPole > 0) { const w = P.startPole, l0 = Math.hypot(v[0], v[1], v[2]) || 1; v = [0, 1, 2].map((k) => (1 - w) * v[k] / l0 + w * pe.start[k]); }
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
  const { n, m, J, r, s, x0, xr, g, act, posn, lb, zl, zh } = P, lo = P.tlo, hi = P.thi;
  const eps = 1e-10;
  for (let k = 0; k < n; k++) {
    let a = 0;
    const o = k * m;
    for (let i = 0; i < P.mg; i++) a += J[o + i] * r[i];
    P.gg[k] = a;
    for (let i = P.mg; i < m; i++) a += J[o + i] * r[i];
    a += P.mu * s[k] * (x[k] - x0[k]);
    if (lb[k] > 0) { const e = zoneExcess(P, k, x[k]); if (e > 0) a += (x[k] < zl[k] ? -1 : 1) * P.mu * lb[k] * e; }
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
  for (let a = 0; a < na; a++) {
    const k = act[a];
    H[a * na + a] += P.mu * s[k] * (1 + P.rho);
    if (lb[k] > 0 && zoneExcess(P, k, x[k]) > 0) H[a * na + a] += P.mu * lb[k];
  }
}

/** One solve of the damped, box-constrained step into P.dl; `mask` bit c = the cap c is held (its radial step is forced to zero by a stiff penalty). */
function solveStep(P, x, lam, mask) {
  const { na, act, posn, g, H0, Hs, b, dl, fx, sol, idx, fpos } = P, lo = P.tlo, hi = P.thi;
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
const SETTLE_LAMBDA = 1e-8, SETTLE_ITER = 12, SETTLE_STEP = 1e-4, SETTLE_GAIN = 1e-2; // settle(): initial damping, most iterations, the step (rad) and the relative gain of F (one step is enough) below which the pose has settled

/**
 * The trust region of a solve that follows a previous pose: no variable leaves [x0 - B, x0 + B] (radians; a translation counts TRANS_PER_RAD metres per radian) nor its range of
 * motion. The soft preferences that are absolute rather than relative to the start (the pole of the elbow, the avoidance of the ends of the ranges) would
 * otherwise carry the pose to wherever they are minimal in one call, and a minimum that appears or disappears with the goal makes the pose jump.
 */
function setBox(P, B) {
  P.B = B;
  for (let k = 0; k < P.n; k++) {
    const b = (P.vk[k] === 2 ? TRANS_PER_RAD * B : B) * P.boxScale[k];
    P.tlo[k] = Math.max(P.lo[k], P.x0[k] - b); P.thi[k] = Math.min(P.hi[k], P.x0[k] + b);
  }
}
/** Does a variable sit on the border of the trust region (not on a range of motion)? */
function atTrustBound(P) {
  for (let k = 0; k < P.n; k++) if ((P.thi[k] < P.hi[k] && P.x[k] >= P.thi[k] - 1e-9) || (P.tlo[k] > P.lo[k] && P.x[k] <= P.tlo[k] + 1e-9)) return true;
  return false;
}
/** Does a variable sit on the border of the trust region with the goals alone pushing outward? Then the region, not a preference, is what keeps a goal from being met. */
function goalsPushOutOfTrust(P) {
  for (let k = 0; k < P.n; k++) {
    if (P.thi[k] < P.hi[k] && P.x[k] >= P.thi[k] - 1e-9 && P.gg[k] < -1e-7) return true;
    if (P.tlo[k] > P.lo[k] && P.x[k] <= P.tlo[k] + 1e-9 && P.gg[k] > 1e-7) return true;
  }
  return false;
}
const FAR_OFF = 100; // a goal this many tolerances off (5 cm, 11 degrees) is "on its way", not "almost there"
function worstRatio(P) {
  let w = 0;
  for (let t = 0; t < P.ngoal; t++) { const q = P.te[t] / P.slots[P.tslot[t]].tol; if (q > w) w = q; }
  return w;
}
/**
 * Iterate from the current x. Returns { iters, status } with status "ok" (every goal within tolerance), "stalled" (stationary), "maxiter". The soft
 * preferences are relaxed (mu / 10) at a stationary point only while the worst goal error is below `polishBelow` (the first run always does).
 * x is updated in place; on return the FK / term state corresponds to x.
 */
function lm(P, maxIter, polishBelow = Infinity, settle = false) {
  const { x, xt, n } = P;
  if (!settle) setMu(P, 1);
  let F = evaluate(P, x), lam = settle ? SETTLE_LAMBDA : P.lambda0, nu = 2, iters = 0, mulevel = 0, small = 0, slow = 0, prevW = Infinity, wRelax = Infinity;
  if (!(F < Infinity)) return { iters, status: "stalled" };
  while (true) {
    if (P.ok && !settle) return { iters, status: "ok" };
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
      for (let k = 0; k < n; k++) { xt[k] = Math.min(P.thi[k], Math.max(P.tlo[k], x[k] + sc * P.dl[k])); const a = Math.abs(xt[k] - x[k]); if (a > mx) mx = a; }
      if (mx < (settle ? SETTLE_STEP : 1e-11)) { tiny = true; break; }
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
      if (Fn < F && rho > 1e-4 && (!settle || settleOk(P))) { // a settling step may not make a goal worse than it is, or than a quarter of its tolerance
        const gain = F - Fn;
        x.set(xt);
        lam = Math.max(lam * Math.max(1 / 3, 1 - (2 * rho - 1) ** 3), 1e-9); nu = 2; // Nielsen's rule
        small = gain < (settle ? SETTLE_GAIN : 1e-12) * (F + 1e-12) ? small + 1 : 0;
        let w = 0; // the worst goal error: when it stops improving the penalised problem is solved and the soft preferences must give way
        for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w) w = P.te[t];
        slow = prevW - w < Math.max(1e-3 * prevW, 1e-9) ? slow + 1 : 0; prevW = w;
        F = Fn; accepted = true;
        break;
      }
      lam = Math.min(lam * nu, 1e9); nu *= 2;
    }
    if (!accepted) evaluate(P, x); // the FK state must match x again
    if (accepted && !tiny && small < (settle ? 1 : 2) && (settle || slow < 2)) continue;
    // stationary: tighten the soft preferences and go on, or give up
    if (P.ok) return { iters, status: "ok" };
    let w1 = 0;
    for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w1) w1 = P.te[t];
    // bound to a small move per call and a variable sits on the border of its box: the figure is on its way, the next call goes on (relaxing the preferences
    // would only spend iterations on a region that is already full)
    if (P.B >= P.maxMove && P.B < Infinity && atTrustBound(P) && worstRatio(P) > FAR_OFF) return { iters, status: "stalled" };
    // The goals themselves may push a variable against the border of the region (a squat from straight legs: the knee has to bend farther than a few centimetres of error
    // suggest, since a straight leg shortens only with the square of the bend). Relaxing the preferences cannot help then, the region has to grow. But the region grows x4 at a
    // time, and a goal 1 cm away is mostly met inside it once the preferences give way (the cheap joints of the lever take less, the others more); a pose in a wider region
    // with the preferences at full strength is another pose (26 % of such moves turned a joint more than 10 degrees, p99 86). So the preferences are relaxed first, and the
    // region grows only when relaxing has not brought the worst goal error down by a tenth since the last time: then it is the region that holds the goal back, and the
    // preferences start over at full strength in the wider region (a relaxed twist-free squat is not twist-free).
    const futile = P.B < Infinity && P.B < P.maxMove && mulevel > 0 && w1 > 0.9 * wRelax && goalsPushOutOfTrust(P);
    const relax = !futile && mulevel + 1 < MU_STEPS && w1 < polishBelow;
    if (!relax && P.B < Infinity && P.B < P.maxMove && atTrustBound(P)) { // the preferences are out of the way and the region is what stops the goal: widen it (up to maxMove)
      const wide = P.B * TRUST_GROW;
      setBox(P, wide > P.maxMove ? P.maxMove : wide > TRUST_OPEN ? Infinity : wide);
      small = 0; slow = 0; prevW = Infinity; lam = P.lambda0; nu = 2;
      mulevel = 0; wRelax = Infinity; setMu(P, 1);
      F = evaluate(P, x);
      continue;
    }
    if (relax) {
      mulevel++; wRelax = w1; setMu(P, Math.pow(0.1, mulevel)); lam = P.lambda0; nu = 2; small = 0; slow = 0; prevW = Infinity;
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
function snapshot(P) { return { x: Float64Array.from(P.x), fix: Int8Array.from(P.tfix), mu: P.mu, B: P.B }; }
function restore(P, s) { P.x.set(s.x); P.tfix.set(s.fix); }

const SETTLE_KEEP = 0.25; // a settling step may take a goal up to this part of its tolerance (or keep the error it has, if that is more)
function settleOk(P) {
  if (!P.ok) return false;
  for (let t = 0; t < P.ngoal; t++) if (P.te[t] > P.sbound[P.tslot[t]]) return false;
  return true;
}
/**
 * A run stops at the first iterate within tolerance. That iterate is on the way to the goals, not at the pose the soft preferences ask for: the redundancy
 * (axial twist of a squatting leg, the swivel of an elbow) keeps whatever the first large steps left in it, which depends on the path of the iteration, so
 * 2 mm apart two goals could end in two different poses, and the next call from the result started from a pose that sat up to the tolerance off the goals.
 * So the winner is settled: the iteration goes on, with an almost undamped Gauss-Newton step, on the penalised problem (the preferences as strong as in the run that met the goals) in the trust region of the run, and a step is taken only if it lowers F and keeps every goal within its tolerance. It ends in the pose the preferences
 * select among those that meet the goals, the same one for every path to it, and the goals end much closer than the tolerance.
 */
function settle(P, snap, maxIter) {
  restore(P, snap);
  setBox(P, snap.B);
  evaluate(P, P.x);
  P.sbound.fill(0);
  for (let t = 0; t < P.ngoal; t++) { const sl = P.tslot[t]; P.sbound[sl] = Math.max(P.sbound[sl], P.te[t], SETTLE_KEEP * P.slots[sl].tol); }
  setMu(P, snap.mu); // not stronger than the run needed to meet the goals: a stronger preference would settle the pose where a goal is off by its tolerance
  return lm(P, maxIter, Infinity, true).iters;
}

/**
 * Is any goal beyond what a straight chain of its free joints could reach? Then no pose meets it. P.gcLower receives the least goal cost any pose can have
 * (the sum, over the position goals that are beyond, of the cost of the distance by which they are): a run that ends there has found the closest pose.
 */
function provablyOutOfReach(P) {
  evaluate(P, P.x0);
  const Pk = P.kin.positions;
  let out = false;
  P.gcLower = 0;
  P.beyond = [];
  for (let t = 0; t < P.ngoal; t++) {
    const b = reachBound(P, t);
    if (!b) continue;
    const t3 = 3 * t, d = Math.hypot(P.ttgt[t3] - Pk[3 * b.top], P.ttgt[t3 + 1] - Pk[3 * b.top + 1], P.ttgt[t3 + 2] - Pk[3 * b.top + 2]);
    if (d > b.len + P.slots[P.tslot[t]].tol) { out = true; if (!P.beyond.includes(P.slots[P.tslot[t]].id)) P.beyond.push(P.slots[P.tslot[t]].id); }
    if (d > b.len) P.gcLower += 0.5 * P.tbase[t] * P.tbase[t] * (d - b.len) ** 2;
  }
  return out;
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
  let F0 = evaluate(P, P.x);
  if (capSwing(P, P.x)) F0 = evaluate(P, P.x); // a free shoulder that starts beyond the 180 degree cap is repaired, also when the goals are met
  if (P.ok) return { iters: 0, status: "ok" }; // already there: the pose is returned untouched
  if (P.n === 0) return { iters: 0, status: "stalled" }; // nothing is free: there is nothing to solve
  // restarts: by default 8, but only 1 when the start is already close to the goals (a drag follows a path: the previous pose is the right basin)
  let w0 = 0, e0 = 0; // worst start error (metres or radians) and in metres (an angle counts angleScale metres per radian)
  for (let t = 0; t < P.ngoal; t++) { const e = P.te[t], m = P.tk[t] === T_DIR || P.tk[t] === T_AIM ? e * P.angleScale : e; if (e > w0) w0 = e; if (m > e0) e0 = m; }
  P.follow = P.followOpt ?? w0 < FOLLOW_BELOW;
  // The default side of an elbow or a knee (down and out, forward) would carry the limb of a posture somebody set toward it, the more completely the longer the iteration runs.
  // Near the goal the limb keeps the side it is on (the pole of the start); the default takes over between POLE_START_NEAR and POLE_START_FAR of error, so that the pose
  // does not jump where the limb stops being "near". follow: true keeps the side of the start, follow: false takes the default.
  if (P.poles.length) {
    const Pk = P.kin.positions;
    for (const pe of P.poles) {
      pe.start = null;
      const u = 3 * pe.ju, m = 3 * pe.jm, e = 3 * pe.je;
      const vx = Pk[m] - Pk[u], vy = Pk[m + 1] - Pk[u + 1], vz = Pk[m + 2] - Pk[u + 2], D = Math.hypot(Pk[e] - Pk[u], Pk[e + 1] - Pk[u + 1], Pk[e + 2] - Pk[u + 2]), v = Math.hypot(vx, vy, vz);
      if (!(D > 1e-6 && v > 1e-6)) continue;
      if (Math.abs(P.angArr[pe.jm][0]) < STRAIGHT_BELOW) continue; // (nearly) straight: no side to keep
      pe.start = [vx / v, vy / v, vz / v];
    }
    P.startPole = P.followOpt === true ? 1 : P.followOpt === false ? 0 : Math.min(1, Math.max(0, (POLE_START_FAR - w0) / (POLE_START_FAR - POLE_START_NEAR)));
    setPoleDirs(P, P.S);
    F0 = evaluate(P, P.x);
  }
  // The avoidance of the ends of the ranges is for a pose that is followed (a drag): it moves joints out of the zones of their ends, which is not what a reach from a posture
  // somebody set should do. Given follow: true it is on; automatically it fades out between LIMIT_FULL and FOLLOW_BELOW of error, so that the pose is a continuous
  // function of the goal where follow switches on by itself (4.9 cm and 5.1 cm gave postures 14 degrees apart, the median joint, when it was all or nothing).
  if (P.limitOpt === undefined && P.followOpt !== true) {
    const fade = P.followOpt === false ? 0 : Math.min(1, Math.max(0, (FOLLOW_BELOW - w0) / (FOLLOW_BELOW - LIMIT_FULL)));
    for (let k = 0; k < P.n; k++) P.lb[k] *= fade * fade;
    F0 = evaluate(P, P.x);
  } // the order of the stiffness (the arm first, then the clavicle, then the trunk) decides a reach
  if (P.restarts < 0) P.restarts = P.follow ? 1 : 8;
  if (P.maxMove < Infinity) { P.restarts = 0; setBox(P, Math.min(P.maxMove, TRUST_MIN + TRUST_GAIN * e0)); } // a restart starts anywhere: it cannot keep the move small
  else setBox(P, TRUST_MIN + TRUST_GAIN * e0); // the first run stays near the pose it was given, as far as the goals allow: continuous in the distance
  const plain = Float64Array.from(P.x), signs0 = Float64Array.from(P.tsign); // the signs of the line goals at the start pose
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
  // The pose as given first when the goals are not far from it: a start that solves keeps its posture (the analytic pose, taken from 8 cm away, turned the shoulder of a
  // raised arm by 133 degrees). From POLE_START_FAR of error there is no posture to keep and the analytic pose is the better start (elbows on the pole side, and a run of
  // 4 iterations where the hanging arm needs 12); it is also taken when asked (analyticStart): a straight limb that has to bend (a squat) is a singular point, the first
  // steps from it leave the plane of the limb and the run ends in a pose with twisted legs. Not while the move per call is bounded (a drag): its own basin.
  const first = warm && (P.analyticStart || (P.followOpt !== true && w0 >= POLE_START_FAR)) && P.maxMove === Infinity && evaluate(P, warm) < F0 ? warm : plain;
  if (first === warm) setBox(P, Infinity); // the analytic pose is far from the pose as given, and so may be outside its trust region
  P.x.set(first);
  evaluate(P, P.x);
  let totalIters = 0;
  const res = lm(P, P.maxIter);
  totalIters += res.iters;
  let best = { snap: snapshot(P), ok: P.ok, gc: P.gc, status: res.status }; // with the trust region of this run: settle() stays inside it
  if (P.maxMove === Infinity) setBox(P, Infinity); // the restarts start anywhere
  // when to stop restarting: three restarts ended where the best run ended, two of them from random poses (that is the closest the pose gets: the runs from the
  // start and from the analytic poses can all fall into the same corner of the ranges), or the best is already within 3 cm and three restarts in a row did not
  // improve on it (a goal just beyond what the limits allow)
  let still = 0, agree = 0;
  const worst = () => { let w = 0; for (let t = 0; t < P.ngoal; t++) if (P.te[t] > w) w = P.te[t]; return w; };
  best.err = worst();
  const consider = (r2) => {
    totalIters += r2.iters;
    const err = worst();
    if (!P.ok && Math.abs(P.gc - best.gc) <= 1e-3 * best.gc + 1e-12) agree++;
    if ((P.ok && !best.ok) || (!best.ok && P.gc < best.gc * (1 - 1e-3))) { best = { snap: snapshot(P), ok: P.ok, gc: P.gc, status: r2.status, err }; still = 0; } else still++;
  };
  if (!best.ok) P.provablyUnreachable = provablyOutOfReach(P); // beyond a straight chain of the free joints: no pose can meet the goal
  // ... but the closest pose is still to be found: the distance to the goal has local minima (the extension limit of the shoulder, the 180 degree cap), a single
  // run from the start sits in the nearest one. Three runs that agree do not prove much there, so the automatic budget is spent in full.
  const asClose = P.provablyUnreachable && best.gc <= P.gcLower * 1.02 + 1e-12; // a run that is as close as the straight chain allows has found the closest pose
  const closest = P.provablyUnreachable && P.restartsAuto && !P.follow;
  if (!best.ok && !asClose && P.maxIter > 0 && P.restarts > 0) {
    {
      const half = Math.max(10, P.maxIter >> 1), rng = mulberry32(P.seed);
      const run = (xs, flip) => {
        P.x.set(xs);
        for (let t = 0; t < P.ngoal; t++) P.tfix[t] = flip && P.tline[t] ? -signs0[t] : 0;
        evaluate(P, P.x);
        consider(lm(P, half, 0.03)); // a restart is polished only when it comes close
      };
      let sampleRuns = 0;
      const queue = [];
      // random poses of the free joints (40 samples cost about the same as one LM iteration each): the best few by cost are refined
      let pool = null;
      const sampled = (i) => {
        if (!pool) {
          pool = [];
          for (let q = 0; q < POOL; q++) {
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
      const sampleRun = (i) => () => { const x = sampled(i); if (x) { sampleRuns++; run(x, false); } };
      // a bar axis has no sign: a run takes the sign that is nearer to the direction it is at, so a wrong first choice is mostly repaired on the way, but a run that
      // ends in a corner of the wrist's ranges because it started on the wrong side may need the other sign from the start: that restart follows the analytic one, before
      // the early stop can apply (it needs two runs from random poses)
      const lines = P.tline.some((v, t) => v && t < P.ngoal);
      if (closest) queue.push(sampleRun(0), sampleRun(1)); // the random poses are the most productive restarts for a goal beyond the reach
      if (warm) queue.push(() => run(first === warm ? plain : warm, false));
      if (lines) queue.push(() => run(plain, true));
      if (P.poles.length) queue.push(analyticRun(1), analyticRun(2));
      if (!closest) queue.push(sampleRun(0), sampleRun(1));
      if (P.poles.length) queue.push(analyticRun(3));
      for (let i = 2; i < 12; i++) queue.push(sampleRun(i));
      const most = closest ? Math.max(P.restarts, CLOSEST_RESTARTS) : P.restarts;
      let ran = 0;
      for (let q = 0; q < queue.length && q < most && !best.ok && (closest || (!(agree >= 3 && sampleRuns >= 2) && !(best.err < 0.03 && still >= 3))); q++) { queue[q](); ran++; }
      // Runs that agree do not prove that no pose meets the goals: a corner of the ranges (the swing of the shoulder at its 180 degree cap, the clavicle at the end of its range)
      // can attract the start, the analytic poses and the best random poses alike, while a pose that is nowhere near them meets a goal that is reachable by construction (a
      // miss of 64 and of 97 mm in 7,440 targets, and 40 restarts did not help: the list ended). A goal that is still 5 mm off or more therefore gets more random poses, from
      // the rest of the pool: EXTRA_RESTARTS when the number of restarts is automatic, what is left of `restarts` when it was given. Not for a goal that no pose can meet, and not for
      // a squat (analyticStart: pins that cannot all be kept are over-constrained, not in a corner, and a slider calls it for every frame).
      if (!best.ok && !closest && !P.provablyUnreachable && !P.analyticStart && best.err >= EXTRA_BELOW) {
        const extra = P.restartsAuto ? (P.follow ? 0 : EXTRA_RESTARTS) : Math.max(0, P.restarts - ran);
        for (let i = 12, e = 0; i < POOL && e < extra && !best.ok; i++, e++) { const x = sampled(i); if (x) run(x, false); }
      }
    }
  }
  if (best.ok) totalIters += settle(P, best.snap, Math.min(SETTLE_ITER, P.maxIter));
  else restore(P, best.snap);
  setMu(P, Math.pow(0.1, MU_STEPS - 1)); // the soft preferences hardly count in the gradient that finish() reads to tell which limits push against the goals
  evaluate(P, P.x);
  return { iters: totalIters, status: best.status };
}

function solveImpl(S, start, goals, options = {}) {
  const t0 = now();
  const P = compile(S, start, goals, options);
  const out = optimise(P);
  return finish(P, out, start, t0);
}

/** obj[key] = value as an own property also for key "__proto__" (a goal id is a user string). */
function setOwn(obj, key, value) { Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true }); }

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
  for (const sl of P.slots) { setOwn(error, sl.id, sl.err); setOwn(tolerances, sl.id, sl.tol); setOwn(units, sl.id, sl.unit); if (sl.err > sl.tol) reachable = false; }
  // pose out
  const angles = {};
  const src = start.angles ?? {};
  for (const id of Object.keys(src)) { const i = INDEX.get(id); angles[id] = Array.from({ length: NDOF[i] }, (_, d) => S.angArr[i][d]); }
  const touched = new Set(P.idle);
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
  // the force each goal puts on a variable: the part of the gradient that comes from its rows (a limit is "blocking" for the goals that push against it)
  const force = (k, slot) => {
    let a = 0;
    for (let t = 0; t < P.ngoal; t++) if (P.tslot[t] === slot) for (let q = 0; q < TERM_ROWS[P.tk[t]]; q++) a += P.J[k * P.m + P.trow[t] + q] * P.r[P.trow[t] + q];
    return a;
  };
  const pushedBy = (k, sign) => {
    const list = [];
    P.slots.forEach((sl, i) => { const f = sign * force(k, i); if (f > 1e-9) list.push({ goal: sl.id, force: f }); });
    return list.sort((a, b) => b.force - a.force);
  };
  for (const k of limits) {
    const atLo = P.x[k] <= P.lo[k] + 1e-9;
    const by = blocking && blocking.has(k) ? pushedBy(k, atLo ? 1 : -1) : [];
    if (P.vk[k] === 0) {
      const jd = JOINTS[P.vj[k]], d = jd.dof[P.vd[k]];
      clamped.push({ joint: jd.id, dof: d.key, value: atLo ? d.min : d.max, limit: atLo ? "min" : "max", bound: atLo ? d.min : d.max, blocking: blocking ? blocking.has(k) : false, pushedBy: by });
    } else {
      const c = P.vd[k];
      clamped.push({ joint: REGION_IDS[P.vj[k]], dof: CHAN[c], value: R2D * (P.x[k] + P.rbase[k].reduce((a, v) => a + v * D2R, 0)), limit: atLo ? "min" : "max", bound: null, region: true, blocking: blocking ? blocking.has(k) : false, pushedBy: by });
    }
  }
  for (const c of P.caps) { // the 180 degree cap of the combined swing, as a limit of its own
    let s2 = 0;
    for (let d = 0; d < NDOF[c.ji]; d++) if (JOINTS[c.ji].dof[d].role !== "twist") s2 += (S.angArr[c.ji][d] * D2R) ** 2;
    if (Math.sqrt(s2) < PI - 1e-6) continue;
    let push = 0;
    const by = [];
    if (blocking) {
      for (let q = 0; q < c.ks.length; q++) push -= (S.angArr[c.ji][P.vd[c.ks[q]]] * D2R / Math.sqrt(s2)) * P.g[c.ks[q]];
      if (push > 1e-9) {
        P.slots.forEach((sl, i) => { let f = 0; for (let q = 0; q < c.ks.length; q++) f -= (S.angArr[c.ji][P.vd[c.ks[q]]] * D2R / Math.sqrt(s2)) * force(c.ks[q], i); if (f > 1e-9) by.push({ goal: sl.id, force: f }); });
        by.sort((a, b) => b.force - a.force);
      }
    }
    clamped.push({ joint: IDS[c.ji], dof: "swing", value: 180, limit: "max", bound: 180, cap: true, blocking: blocking ? push > 1e-9 : false, pushedBy: by });
  }
  const changed = [];
  for (const id of IDS) {
    const i = INDEX.get(id), a0 = src[id];
    for (let d = 0; d < NDOF[i]; d++) if (Math.abs(S.angArr[i][d] - (a0?.[d] ?? 0)) > 1e-9) { changed.push(id); break; }
  }
  const rootChanged = ["x", "y", "z", "heading", "flex", "lat", "rot"].some((k) => Math.abs(root[k] - P.root0[k]) > 1e-12);
  const res = {
    root, angles, pose: { root: { ...root }, angles: Object.fromEntries(Object.entries(angles).map(([id, a]) => [id, a.slice()])) }, converged: out.status !== "maxiter", iterations: out.iters, error, units, tolerance: tolerances, residual: Math.sqrt(cost), clamped, changed,
    reachable, ms: now() - t0, rootChanged,
  };
  if (P.provablyUnreachable) { res.provablyUnreachable = true; res.beyondReach = P.beyond; } // beyondReach: the ids of the goals that no pose can meet
  if (P.maxMove < Infinity && !reachable && P.B >= P.maxMove - 1e-12 && atTrustBound(P)) res.limited = true; // still on its way: maxMove stopped the figure short
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnostics: the Jacobian
function jacobianImpl(S, start, goals, options = {}) {
  const P = compile(S, start, goals, options);
  setPoleDirs(P, S);
  setMu(P, 1);
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
  if (options === null || typeof options !== "object") throw new TypeError("reachEnvelope: options must be an object { samples, seed, trunk, clavicle, rangeFraction, landmark }");
  const t0 = now();
  const sd = sideOf(side);
  const { samples = 2000, seed = 1, trunk = false, clavicle = true, rangeFraction = 1, hull = true } = options;
  const landmark = options.landmark ?? "grip_centre";
  if (!(Number.isInteger(samples) && samples >= 1 && samples <= 200000)) throw new RangeError("samples must be an integer from 1 to 200000");
  if (!Number.isInteger(seed)) throw new RangeError("seed must be an integer");
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
  for (const k of ["normalWeight", "axisWeight", "weight"]) if (options[k] != null && !(isNum(options[k]) && options[k] >= 0)) throw new RangeError(`handFrameFromGrip: options.${k} must be a finite number >= 0, got ${JSON.stringify(options[k])}`);
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
  if (typeof ids === "string") ids = [ids];
  if (!Array.isArray(ids)) throw new TypeError("pinGoals: ids must be an array of landmark ids (or one id)");
  return ids.map((id) => {
    const p = solver.worldPoint(start, id);
    return { type: "pin", id: `pin:${id}`, landmark: id, target: [p.x, p.y, p.z], weight: options.weight ?? 100, ...(options.tolerance != null ? { tolerance: options.tolerance } : {}) };
  });
}
const FOOT_PINS = (s) => [`heel_sole_${s}`, `ball_sole_medial_${s}`, `ball_sole_lateral_${s}`];

/**
 * Move the pelvis and keep the rest where it is. move: { dy } or { dx, dy, dz } (metres) or { target: [x, y, z] } (the new pelvis position). options:
 * pinFeet (default true: the heel and the two balls of each foot stay), pinHands (false), pin (more landmark ids), anchor (a pose: the pinned points stay where
 * THAT pose has them, by default `start`), free (default both legs, plus the arms and clavicles when the hands are pinned), and every option of solve(). The root is
 * moved first and the legs re-solved, so it is the squat / stand-up solver: root.y decreases, hips and knees flex, the feet stay.
 * A slider that calls this with every new height should pass the pose it started from as `anchor` (and the pose of the previous call as `start`): each call then
 * pins the feet where they were put in the first place, so the few micrometres a call is short of the pins cannot add up to a creep of the feet.
 */
export function movePelvis(solver, start, move, options = {}) {
  if (start === null || typeof start !== "object") throw new TypeError("movePelvis: start must be a pose { root, angles } (what rig.getPose() returns)");
  if (move === null || typeof move !== "object") throw new TypeError("move must be { dy } | { dx, dy, dz } | { target: [x, y, z] }");
  if (options === null || typeof options !== "object") throw new TypeError("movePelvis: options must be an object");
  const { pinFeet = true, pinHands = false, pin = [], anchor = start, ...rest } = options;
  if (anchor === null || typeof anchor !== "object") throw new TypeError("movePelvis: options.anchor must be a pose { root, angles }");
  const r0 = start.root ?? solver.restRoot;
  const to = move.target != null ? asPoint(move.target, "move.target") : [(r0.x ?? 0) + (move.dx ?? 0), (r0.y ?? 0) + (move.dy ?? 0), (r0.z ?? 0) + (move.dz ?? 0)];
  for (const v of to) if (!isNum(v) || Math.abs(v) > FAR) throw new RangeError(`the new pelvis position must be finite and within ${FAR} m of the origin, got ${JSON.stringify(to)}`);
  const ids = [...(pinFeet ? SIDES.flatMap(FOOT_PINS) : []), ...(pinHands ? SIDES.map((s) => `grip_centre_${s}`) : []), ...pin];
  const goals = pinGoals(solver, anchor, ids, { weight: rest.pinWeight }); // where the pinned points are: in `anchor`, by default in `start`
  delete rest.pinWeight;
  const moved = { root: { ...r0, x: to[0], y: to[1], z: to[2] }, angles: start.angles ?? {} };
  const free = rest.free ?? [...(pinFeet ? ["legs"] : []), ...(pinHands ? ["arms", "clavicles"] : [])];
  delete rest.free;
  // no avoidance of the ends of the ranges (a drag's feature): a squat comes near the ankle's dorsiflexion limit by design, and the avoidance would buy the ankle some
  // room with axial twist of the whole leg
  return solver.solve(moved, goals, { free, limitStiffness: 0, analyticStart: true, ...rest });
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
  const tryD = (d) => reachHand(solver, start, sd, at(d), rest);
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

/**
 * Runs the hot paths of the solver a few dozen times on throw-away poses so that the JIT has compiled them (the first ~100 solves of a page take up to 25 to 40 ms
 * each, later ones about 1 ms): call it once after createSolver, when the page is idle (it takes 130 ms on a quiet machine, 330 to 570 ms on a loaded one; rounds = 1 is half of that and warms less). Nothing of the solver's state changes; returns the
 * milliseconds it took.
 */
export function warmUp(solver, rounds = 2) {
  const t0 = now(), start = { root: { ...solver.restRoot }, angles: {} };
  for (let r = 0; r < rounds; r++) {
    for (const side of SIDES) {
      const o = solver.worldPoint(start, `grip_centre_${side}`);
      let cur = start;
      for (let i = 0; i < 24; i++) { // a small circle in front of the hand, as a drag
        const a = (i / 24) * 2 * PI, q = reachHand(solver, cur, side, [o.x + 0.1 * Math.sin(a), o.y + 0.25 + 0.1 * Math.cos(a), o.z + 0.3], i === 0 ? {} : DRAG_OPTIONS);
        cur = q.pose;
      }
      reachHand(solver, start, side, [o.x, o.y + 0.9, o.z + 0.2], { trunk: true }); // an unreachable one: restarts, the closest pose
      placeFoot(solver, start, side, { position: [o.x, 0.1, o.z + 0.2], heading: 5 });
    }
    lookAt(solver, start, [0.5, 1.5, 2], { eyes: true });
    movePelvis(solver, start, { dy: -0.15 });
  }
  return now() - t0;
}

/** Reach envelope of a hand: random in-ROM poses of the arm (and the trunk), see solver.reachEnvelope. */
export function reachEnvelope(solver, start, side, options) {
  return solver.reachEnvelope(start, side, options);
}

/**
 * A goal id as words: "pin:heel_sole_R" -> "Right heel sole (pinned)", "hand_R.rot" -> "Right hand orientation", "lookAt" -> "Look at".
 * describeResult(result, goalLabel) uses it for every goal that has no label of its own.
 */
export function goalLabel(id) {
  if (typeof id !== "string") return String(id); // a number or NaN is not a name to take apart
  let s = id, tail = "", pinned = false;
  if (s.startsWith("pin:")) { pinned = true; s = s.slice(4); }
  if (s.endsWith(".rot")) { s = s.slice(0, -4); tail = " orientation"; } else if (s.endsWith(".frame")) { s = s.slice(0, -6); tail = " frame"; }
  const parts = s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split("_").filter(Boolean), last = parts[parts.length - 1];
  const side = parts.length > 1 && (last === "l" || last === "r") ? (parts.pop(), last === "l" ? "left" : "right") : "";
  const name = `${side} ${parts.join(" ")}`.trim();
  const out = (name || !pinned ? name + tail + (pinned ? " (pinned)" : "") : "pinned point").trim();
  return out ? out[0].toUpperCase() + out.slice(1) : String(id);
}

/**
 * Plain-English lines for a Result: [] when every goal is met, otherwise one sentence per goal that is not ("Right hand: 120 mm short of the target"), naming
 * the joints that sit at a limit and push against THAT goal (Result.clamped[].pushedBy), strongest first. `labels` maps goal ids to words ({ hand_R: "The right hand" });
 * without one the id itself is shown; a function (id) -> words, such as goalLabel, labels every goal.
 */
export function describeResult(result, labels = {}) {
  if (result === null || typeof result !== "object" || result.error === null || typeof result.error !== "object") throw new TypeError("describeResult: needs the Result of solve()");
  const lines = [];
  const blocking = (result.clamped ?? []).filter((c) => c.blocking);
  for (const [id, err] of Object.entries(result.error ?? {})) {
    const tol = result.tolerance?.[id] ?? DEFAULT_TOL;
    if (!(err > tol) && !Number.isNaN(err)) continue; // NaN is not "met": it is a result that cannot be shown as a number
    // the limits that push against THIS goal, the strongest first (a Result of an older version has no pushedBy: all of them)
    const limits = blocking.filter((c) => !c.pushedBy || c.pushedBy.some((p) => p.goal === id))
      .sort((a, b) => (b.pushedBy?.find((p) => p.goal === id)?.force ?? 0) - (a.pushedBy?.find((p) => p.goal === id)?.force ?? 0));
    const angle = result.units?.[id] === "rad";
    const what = typeof labels === "function" ? labels(id) : labels !== null && typeof labels === "object" && Object.hasOwn(labels, id) ? labels[id] : id;
    if (!Number.isFinite(err)) { lines.push(`${what}: the error could not be computed (${err}); the pose is not usable.`); continue; }
    const deg = err * R2D, mm = err * 1000;
    const amount = angle ? `${deg.toFixed(deg < 10 ? 1 : 0)} degrees off` : `${mm.toFixed(mm < 10 ? 1 : 0)} mm short of`;
    let why = "";
    if (result.beyondReach ? result.beyondReach.includes(id) : result.provablyUnreachable) why = " (farther than the limb can stretch)";
    else if (result.limited && !limits.length) why = " (still on its way: one drag step moves a joint a few degrees at most)";
    else if (limits.length) why = ` (limited by ${limits.slice(0, 4).map((c) => `${JOINT_BY_ID[c.joint]?.label ?? c.joint} ${c.dof} at its ${c.limit === "max" ? "maximum" : "minimum"}`).join(", ")})`;
    lines.push(`${what}: ${amount} the target${why}.`);
  }
  return lines;
}
