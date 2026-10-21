// Whole-body drag timing: DRAG_OPTIONS solves along random paths with many goals and many free variables; prints percentiles per scenario.
import * as H from "./ik.adversarial.helpers.mjs";
const { IK } = H;
export const SCENARIOS = {
  "hand only (arm+clavicle)": (solver, start, t) => ({ goals: [{ type: "position", id: "hand", landmark: "grip_centre_R", target: t }], opts: { free: ["arm_R", "clavicle_R"] } }),
  "hand, trunk free": (solver, start, t) => ({ goals: [{ type: "position", id: "hand", landmark: "grip_centre_R", target: t }], opts: { free: ["arm_R", "clavicle_R", "trunk"] } }),
  "whole body: hand frame + look + 5 pins, all + pelvis free": (solver, start, t) => ({
    goals: [{ type: "frame", id: "hand", joint: "wrist_R", landmark: "grip_centre_R", target: t, axes: [{ local: "palm_normal", world: [0, 0, -1] }, { local: "hand_across", world: [0, 1, 0], line: true }] },
      { type: "lookAt", id: "look", target: [t[0], t[1] + 0.1, t[2] + 0.4] }, ...IK.pinGoals(solver, start, ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"])],
    opts: { free: ["all", "pelvis-xyz", "pelvis-rot"] } }),
  "two hands + look + 6 pins, all+pelvis, reach beyond": (solver, start, t) => ({
    goals: [{ type: "position", id: "handR", landmark: "grip_centre_R", target: t }, { type: "position", id: "handL", landmark: "grip_centre_L", target: [-t[0], t[1], t[2]] },
      { type: "lookAt", id: "look", target: [0, t[1], t[2] + 0.5] }, ...IK.pinGoals(solver, start, ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_L", "ball_sole_medial_R", "ball_sole_lateral_R"])],
    opts: { free: ["all", "pelvis-xyz", "pelvis-rot"] } }),
  "unreachable hand (1.5 m away), trunk+pelvis free": (solver, start, t) => ({ goals: [{ type: "position", id: "hand", landmark: "grip_centre_R", target: [t[0] - 1.2, t[1], t[2] + 0.6] }], opts: { free: ["arm_R", "clavicle_R", "trunk", "pelvis-xz"] } }),
  "squat movePelvis": null,
};
export function runScenario(solver, name, fn, nPaths = 5, steps = 120) {
  const times = [];
  const S = solver.worldPoint({ root: solver.restRoot, angles: {} }, { joint: "shoulder_R" });
  const r = H.rng(99);
  for (let p = 0; p < nPaths; p++) {
    let cur = { root: { ...solver.restRoot }, angles: {} };
    const c = [S.x + H.uni(r, -0.3, 0.0), S.y + H.uni(r, -0.2, 0.2), S.z + H.uni(r, 0.3, 0.45)];
    const A = [0.1, 0.12, 0.08];
    for (let i = 0; i < steps; i++) {
      const th = i / steps * 2 * Math.PI;
      const t = [c[0] + A[0] * Math.sin(th), c[1] + A[1] * Math.sin(2 * th), c[2] + A[2] * Math.cos(th)];
      const { goals, opts } = fn(solver, cur, t);
      const res = solver.solve(cur, goals, { ...IK.DRAG_OPTIONS, ...opts });
      times.push(res.ms);
      cur = res.pose;
    }
  }
  return times;
}
