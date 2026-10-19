// posture preservation: a 2 mm change of the goal must not change the pose by much (the solution map is continuous), from the same start.
import * as H from "./ik.adversarial.helpers.mjs";
import { makeRotMeter } from "./ik.adversarial.drag.mjs";
const { IK, THREE } = H;
export function lipschitz(solver, n, opts, seed = 8, delta = 0.002, startMaker = () => ({ root: { ...solver.restRoot }, angles: {} })) {
  const r = H.rng(seed), meter = makeRotMeter(solver);
  const ARMJ = ["clavicle_R", "shoulder_R", "elbow_R", "forearm_R", "wrist_R"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = H.randPose(H.ARM("R"), r, 0.9);
    const g = solver.worldPoint({ root: solver.restRoot, angles: a }, "grip_centre_R");
    const d = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(delta);
    const st = startMaker(r);
    const A = IK.reachHand(solver, st, "R", [g.x, g.y, g.z], opts), B = IK.reachHand(solver, st, "R", [g.x + d.x, g.y + d.y, g.z + d.z], opts);
    if (!A.reachable || !B.reachable) continue;
    const m = meter(A.pose, B.pose, ARMJ);
    const e = solver.worldPoint(A.pose, { joint: "elbow_R" }).distanceTo(solver.worldPoint(B.pose, { joint: "elbow_R" }));
    out.push({ rot: m.m, who: m.who, elbow: e, i });
  }
  return out;
}
