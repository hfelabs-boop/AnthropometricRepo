// Adversarial checks of site/js/human/body.js, independent of body.test.mjs. The structural checks always run (a sample of the 176 populations at
// P5/P50/P95); the shape checks that document known defects only assert when ADVERSARIAL_STRICT=1 (see the verifier's report).
// The full sweeps are scripts: body.adversarial.sweep.mjs (+ summary.mjs), body.adversarial.limits.mjs, body.adversarial.poses.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { fitBody } from "../../site/js/human/fit.js";
import { buildSkin } from "../../site/js/human/body.js";
import { allPopulations, popProfile, makeBones, manifold, volume, rangeBox, sliceY } from "./body.adversarial.helpers.mjs";

const STRICT = process.env.ADVERSARIAL_STRICT === "1";
const pops = allPopulations().filter((_, i) => i % 6 === 0);

test("sample of populations: closed outward manifolds, finite, weights sum to one, exact stature and sole", () => {
  for (const [c, r, s] of pops) for (const pct of [5, 50, 95]) {
    const b = fitBody(popProfile(c, r, s, pct)), sk = buildSkin(b, makeBones(b)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array;
    const lab = `${c}/${r}/${s} P${pct}`;
    assert.ok(pos.every(Number.isFinite) && g.attributes.normal.array.every(Number.isFinite), `${lab}: finite`);
    for (const [name, p] of Object.entries(sk.mesh.userData.parts)) {
      assert.equal(manifold(idx, p.triStart, p.triEnd), 0, `${lab}: ${name} is a closed 2-manifold`);
      assert.ok(volume(pos, idx, p.triStart, p.triEnd) > 0, `${lab}: ${name} is wound outward`);
    }
    const sw = g.attributes.skinWeight.array;
    for (let v = 0; v < sw.length / 4; v++) assert.equal(sw[v * 4] + sw[v * 4 + 1] + sw[v * 4 + 2] + sw[v * 4 + 3], 1, `${lab}: weights of vertex ${v}`);
    const bb = rangeBox(pos, 0, pos.length / 3);
    assert.ok(Math.abs(bb.hi[1] - b.stature) < 1e-4 && Math.abs(bb.lo[1]) < 1e-4, `${lab}: stature and sole`);
    sk.dispose();
  }
});

test("low quality stays within 20,000 triangles and keeps the parts", () => {
  for (const [c, r, s] of pops.slice(0, 10)) {
    const b = fitBody(popProfile(c, r, s, 50)), hi = buildSkin(b, makeBones(b)), lo = buildSkin(b, makeBones(b), { quality: "low" });
    assert.ok(lo.stats.triangles < 20000 && lo.stats.triangles < hi.stats.triangles / 2);
    assert.deepEqual(Object.keys(lo.mesh.userData.parts), Object.keys(hi.mesh.userData.parts));
    hi.dispose(); lo.dispose();
  }
});

test("KNOWN DEFECT (strict): the thigh does not stand out in front of the torso at the hip (US Army women P50: 43 mm)", { skip: !STRICT }, () => {
  const b = fitBody(popProfile("united-states", "army", "F", 50)), sk = buildSkin(b, makeBones(b)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, P = sk.mesh.userData.parts;
  const y = b.positions.hip_L[1], t = sliceY(pos, idx, P.torso.triStart, P.torso.triEnd, y), l = sliceY(pos, idx, P.leg_L.triStart, P.leg_L.triEnd, y);
  assert.ok((l.z[1] - t.z[1]) * 1000 < 20, `thigh front is ${((l.z[1] - t.z[1]) * 1000).toFixed(0)} mm in front of the torso front`);
});

test("KNOWN DEFECT (strict): the mesh bideltoid breadth is within 10 mm of the measured one (median +16 mm, up to +68 mm)", { skip: !STRICT }, () => {
  const b = fitBody(popProfile("united-states", "officers", "M", 5)), sk = buildSkin(b, makeBones(b)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, P = sk.mesh.userData.parts;
  const ring = b.shape.tubes.upper_arm_L.rings.find((r) => r.id === "ua_deltoid");
  let best = 0;
  for (let dy = -0.04; dy <= 0.06; dy += 0.01) { const a = sliceY(pos, idx, P.arm_L.triStart, P.arm_L.triEnd, ring.c[1] + dy); if (a.n) best = Math.max(best, a.x[1]); }
  assert.ok(Math.abs(2 * best - b.inputs.bideltoid_breadth) * 1000 < 10);
});
