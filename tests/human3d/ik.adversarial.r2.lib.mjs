// Second-round adversarial verification of site/js/human/ik.js: shared helpers (own sampler, own FK through the rig, own limit checker).
import * as THREE from "three";
import { buildRig } from "../../site/js/human/rig.js";
import { JOINTS, JOINT_BY_ID, REGIONS } from "../../site/js/human/skeleton.js";
import * as IK from "../../site/js/human/ik.js";
import * as H from "./ik.adversarial.helpers.mjs";

export { THREE, JOINTS, JOINT_BY_ID, REGIONS, IK, H, buildRig };
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const rng = H.rng;

const cache = new Map();
/** { solver, rig } for a body entry of H.popBodies() / H.realPeople(); rig only on demand (skin-less). */
export function ctx(b) {
  let c = cache.get(b);
  if (!c) { c = { b, solver: IK.createSolver(b.body), _rig: null, get rig() { return this._rig ??= buildRig(b.body, { skeleton: false }); } }; cache.set(b, c); }
  return c;
}
export const standing = (s) => ({ root: { ...s.restRoot }, angles: {} });

/** A fully random in-ROM posture of the listed joints (uniform in the box, radial cap at 180), optional random spine region totals and root. */
export function randPosture(r, { arms = true, legs = false, neck = false, spine = 0, root = false, frac = 1 } = {}) {
  const ids = [];
  if (arms) for (const s of ["L", "R"]) ids.push(...H.ARM(s));
  if (legs) for (const s of ["L", "R"]) ids.push(...H.LEG(s));
  const angles = H.randPose(ids, r, frac);
  if (neck) { angles.head = H.randAngles("head", r, 0.7); for (const id of REGIONS.cervical.joints) angles[id] = H.randAngles(id, r, 0.3); }
  if (spine) for (const reg of ["lumbar", "thoracic"]) for (const id of REGIONS[reg].joints) angles[id] = H.randAngles(id, r, spine);
  const rt = { x: 0, y: 0, z: 0, heading: 0, flex: 0, lat: 0, rot: 0 };
  return { angles, rootSpec: root ? { dx: (r() - 0.5) * 0.6, dz: (r() - 0.5) * 0.6, heading: (r() - 0.5) * 120, flex: (r() - 0.5) * 20, lat: (r() - 0.5) * 20, rot: (r() - 0.5) * 30 } : null, rt };
}
export function poseWithRoot(s, p) {
  const root = { ...s.restRoot };
  if (p.rootSpec) { root.x += p.rootSpec.dx; root.z += p.rootSpec.dz; root.heading = p.rootSpec.heading; root.flex = p.rootSpec.flex; root.lat = p.rootSpec.lat; root.rot = p.rootSpec.rot; }
  return { root, angles: p.angles };
}

/** independent landmark position through the rig (scene graph), not through the solver's Kinematics */
export function rigPoint(rig, pose, id) {
  rig.setPose(pose, { clamp: false });
  return rig.landmarkWorld(id, new THREE.Vector3());
}
export const dist = (a, b) => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
export const deepFreeze = H.deepFreeze;
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const pct = H.pct;

/** Largest rotation (degrees) of any joint between two poses: relative quaternion angle from jointQuaternion (not a difference of DOF numbers). */
import { jointQuaternion } from "../../site/js/human/skeleton.js";
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
export function poseStep(a, b, only = null) {
  let worst = 0, wj = null;
  for (const id of Object.keys(b.angles)) {
    if (only && !only.includes(id)) continue;
    const j = JOINT_BY_ID[id];
    if (!j) continue;
    jointQuaternion(id, a.angles[id] ?? j.dof.map(() => 0), qa); jointQuaternion(id, b.angles[id], qb);
    const d = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * R2D;
    if (d > worst) { worst = d; wj = id; }
  }
  return { deg: worst, joint: wj };
}
