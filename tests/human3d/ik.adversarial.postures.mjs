// Reach and look-at from every posture of the library (sitting, lying, kneeling, leaning ...): the start is a realistic pose, not just standing.
import * as H from "./ik.adversarial.helpers.mjs";
import { POSTURES } from "../../site/js/human/postures.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";
const { IK } = H;
export function runPostureReach(bodies, perPosture = 6, seed = 17) {
  const rows = [];
  const bad = [];
  for (const { name: bn, body } of bodies) {
    const solver = IK.createSolver(body);
    const r = H.rng(seed);
    for (const p of POSTURES) {
      let ex;
      try { ex = expandPosture(p); } catch { continue; }
      let root;
      try { root = placePose(body, ex, { posture: p }); } catch { root = { x: 0, y: solver.restRoot.y, z: 0, ...ex.root }; }
      const start = { root: { x: root.x, y: root.y, z: root.z, heading: root.heading, flex: root.flex, lat: root.lat, rot: root.rot }, angles: JSON.parse(JSON.stringify(ex.angles)) };
      for (let i = 0; i < perPosture; i++) {
        const s = i % 2 ? "L" : "R";
        const mod = { ...start.angles };
        for (const j of H.ARM(s)) mod[j] = H.randAngles(j, r, 0.8);
        const tgt = solver.worldPoint({ root: start.root, angles: mod }, `grip_centre_${s}`);
        const res = IK.reachHand(solver, start, s, [tgt.x, tgt.y, tgt.z]);
        const lp = H.limitProblems(res);
        const fingerChanged = res.changed.filter((c) => /mcp|pip|dip|thumb|index|middle|ring|little/.test(c));
        rows.push({ bn, id: p.id, s, ok: res.error[`hand_${s}`] < 1e-3, err: res.error[`hand_${s}`], lp, fingerChanged });
      }
    }
  }
  return rows;
}
