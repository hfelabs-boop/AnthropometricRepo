// random smooth drag paths through the reach zone of a hand; counts frames where the pose jumps although the target moved a few millimetres
import * as H from "./ik.adversarial.helpers.mjs";
import { makeRotMeter } from "./ik.adversarial.drag.mjs";
const { IK } = H;
const ARMJ = ["clavicle_R", "shoulder_R", "elbow_R", "forearm_R", "wrist_R"];
export function randomPath(S, r, n = 200, reach = 0.6) {
  // Lissajous in a box in front of / around the shoulder, smooth, bounded step
  const c = [S[0] + H.uni(r, -0.25, 0.1), S[1] + H.uni(r, -0.35, 0.3), S[2] + H.uni(r, 0.0, 0.35)];
  const A = [H.uni(r, 0.05, 0.3), H.uni(r, 0.05, 0.3), H.uni(r, 0.05, 0.3)], ph = [r() * 6.28, r() * 6.28, r() * 6.28], fr = [H.uni(r, 0.5, 1.5), H.uni(r, 0.5, 1.5), H.uni(r, 0.5, 1.5)];
  const pts = Array.from({ length: n }, (_, i) => { const t = i / (n - 1) * 2 * Math.PI; return [0, 1, 2].map((k) => c[k] + A[k] * Math.sin(fr[k] * t + ph[k])); });
  return pts;
}
export function dragStats(solver, side, pts, opts) {
  const meter = makeRotMeter(solver);
  let cur = IK.reachHand(solver, { root: { ...solver.restRoot }, angles: {} }, side, pts[0]).pose;
  let maxElbow = 0, maxRot = 0, jumps = 0, frames = 0, unreach = 0, maxMs = 0, maxPt = 0;
  for (let i = 1; i < pts.length; i++) {
    const r = IK.reachHand(solver, cur, side, pts[i], opts);
    const e0 = solver.worldPoint(cur, { joint: `elbow_${side}` }), e1 = solver.worldPoint(r.pose, { joint: `elbow_${side}` });
    const dE = e0.distanceTo(e1), m = meter(cur, r.pose, ARMJ.map((j) => j.replace("_R", `_${side}`)));
    const dp = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    maxPt = Math.max(maxPt, dp);
    maxElbow = Math.max(maxElbow, dE); maxRot = Math.max(maxRot, m.m);
    if (dE > 0.04 || m.m > 15) jumps++;
    frames++; if (!r.reachable) unreach++; maxMs = Math.max(maxMs, r.ms);
    cur = r.pose;
  }
  return { maxElbow, maxRot, jumps, frames, unreach, maxMs, maxPt };
}
