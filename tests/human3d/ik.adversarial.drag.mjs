// Drag continuity: successive DRAG_OPTIONS solves along a smooth path. Measures the world displacement of marker points (elbow, wrist, ...) and the
// rotation of each joint frame between frames (quaternion angle), the quantities a person sees, not the raw DOF.
import * as H from "./ik.adversarial.helpers.mjs";
import { Kinematics } from "../../site/js/human/fk.js";
const { IK, THREE, JOINTS } = H;

export function frameMetrics(solver, pa, pb, joints, markers) {
  let maxPt = 0, whoPt = "", maxRot = 0, whoRot = "";
  for (const m of markers) {
    const a = solver.worldPoint(pa, m), b = solver.worldPoint(pb, m);
    const d = a.distanceTo(b);
    if (d > maxPt) { maxPt = d; whoPt = JSON.stringify(m); }
  }
  return { maxPt, whoPt };
}
/** joint frame rotation angle between two poses (degrees), using the Kinematics of the solver body */
export function makeRotMeter(solver) {
  const offs = {};
  const fig = solver.body;
  for (const j of JOINTS) if (j.parent) offs[j.id] = Array.from(fig.joints[j.id].offset).slice(0, 3);
  const ka = new Kinematics(offs), kb = new Kinematics(offs);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  return (pa, pb, ids) => {
    ka.solve(pa.angles, pa.root); kb.solve(pb.angles, pb.root);
    let m = 0, who = "";
    for (const id of ids) {
      ka.quaternion(id, qa); kb.quaternion(id, qb);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb)))) * H.R2D;
      if (ang > m) { m = ang; who = id; }
    }
    return { m, who };
  };
}
