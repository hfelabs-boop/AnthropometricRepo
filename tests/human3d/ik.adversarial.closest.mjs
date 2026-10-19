// "closest feasible pose": for unreachable hand targets the solver's residual must not be worse than the best of many random in-ROM arm poses (forward kinematics only).
import * as H from "./ik.adversarial.helpers.mjs";
const { IK, THREE } = H;
export function closestStats(solver, nTargets = 60, samples = 20000, seed = 3) {
  const env = IK.reachEnvelope(solver, { root: { ...solver.restRoot }, angles: {} }, "R", { samples, seed: 99, hull: false });
  const P = env.points;
  const r = H.rng(seed);
  const sh = new THREE.Vector3(...env.origin);
  const rows = [];
  for (let i = 0; i < nTargets; i++) {
    const d = new THREE.Vector3(H.uni(r, -1, 1), H.uni(r, -0.6, 1), H.uni(r, -1, 1)).normalize().multiplyScalar(H.uni(r, 0.75, 1.3));
    const t = sh.clone().add(d);
    let best = Infinity;
    for (let k = 0; k < env.count; k++) best = Math.min(best, Math.hypot(P[3 * k] - t.x, P[3 * k + 1] - t.y, P[3 * k + 2] - t.z));
    const res = IK.reachHand(solver, { root: { ...solver.restRoot }, angles: {} }, "R", [t.x, t.y, t.z]);
    rows.push({ sampleBest: best, solver: res.error.hand_R, reachable: res.reachable, prov: !!res.provablyUnreachable, lim: H.limitProblems(res).length });
  }
  return rows;
}
