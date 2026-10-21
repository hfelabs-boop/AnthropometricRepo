// Realistic skin (site/js/human/realskin.js and the assets of scripts/human_skin): decoding, fitting to bodies, binding to the rig.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/realskin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { buildRig } from "../../site/js/human/rig.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { decodeAsset, fitVertices, meshJoints, regionMaps, buildRealSkin, skinSexOf, REGIONS, CHAINS } from "../../site/js/human/realskin.js";
import { byId } from "../../site/js/human/postures.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const asset = (sex) => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, `site/assets/human/skin-${sex}.json`)));
  const bin = fs.readFileSync(path.join(ROOT, `site/assets/human/skin-${sex}.bin`));
  return decodeAsset(man, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
};
const A = { M: asset("M"), F: asset("F") };
const pop = (sex) => JSON.parse(fs.readFileSync(path.join(ROOT, `public/api/v1/populations/united-states/army/${sex}.json`)));
const POP = { M: pop("M"), F: pop("F") };
const body = (sex, p) => fitBody(percentileProfile(POP[sex], { percentile: p }));
const minMaxY = (P) => { let lo = Infinity, hi = -Infinity; for (let i = 1; i < P.length; i += 3) { if (P[i] < lo) lo = P[i]; if (P[i] > hi) hi = P[i]; } return [lo, hi]; };

test("the assets decode: counts, joints, four weights summing to 255, valid regions and triangle indices", () => {
  for (const a of Object.values(A)) {
    const n = a.manifest.vertices;
    assert.equal(a.position.length, n * 3);
    assert.equal(a.index.length, a.manifest.triangles * 3);
    for (let i = 0; i < a.index.length; i++) assert.ok(a.index[i] < n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) { s += a.skinWeight[4 * i + k]; assert.ok(a.skinIndex[4 * i + k] < JOINTS.length); }
      assert.equal(s, 255, `vertex ${i}`);
      assert.ok(a.region[2 * i] < REGIONS.length && a.region[2 * i + 1] < REGIONS.length);
    }
    for (const j of JOINTS) assert.equal(a.manifest.joints[j.id].length, 3, j.id);
    assert.equal(a.eyes.length, 2);
  }
});

test("a body wears the mesh of its form: female for a woman, male otherwise", () => {
  assert.equal(skinSexOf(body("F", 50)), "F");
  assert.equal(skinSexOf(body("M", 50)), "M");
  assert.equal(skinSexOf(syntheticBody(1.6, "female")), "F");
  assert.equal(skinSexOf(syntheticBody(1.75, "neutral")), "M");
});

test("the fitted skin has the body's stature and stands on the floor, from P5 to P95, men and women", () => {
  for (const sex of ["M", "F"]) for (const p of [5, 50, 95]) {
    const b = body(sex, p), [lo, hi] = minMaxY(fitVertices(A[sex], b));
    assert.ok(Math.abs(hi - b.stature) < 0.006, `${sex} P${p}: top ${hi.toFixed(4)} vs stature ${b.stature.toFixed(4)}`);
    assert.ok(lo > -0.01 && lo < 0.01, `${sex} P${p}: soles at ${lo.toFixed(4)}`);
  }
});

test("the limb joints of the mesh land on the body's joints, the others within a few centimetres", () => {
  for (const sex of ["M", "F"]) for (const p of [5, 95]) {
    const b = body(sex, p), Q = meshJoints(A[sex], b);
    for (const [tube, ids] of Object.entries(CHAINS)) if (tube !== "torso") for (const id of ids) {
      const d = Math.hypot(...b.positions[id].map((x, k) => x - Q[id][k]));
      assert.ok(d < 1e-6, `${sex} P${p} ${id}: ${(d * 1000).toFixed(2)} mm`);
    }
    for (const j of JOINTS) {
      if (j.id.startsWith("eye") || j.id === "jaw") continue; // carry no skin
      const d = Math.hypot(...b.positions[j.id].map((x, k) => x - Q[j.id][k]));
      assert.ok(d < 0.06, `${sex} P${p} ${j.id}: ${(d * 1000).toFixed(0)} mm`);
    }
  }
});

test("a bigger body gets a bigger skin: the P95 man's trunk and thighs are wider and deeper than the P5 man's", () => {
  const ext = (P, y0, y1, ax, xmin = -1, xmax = 1) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < P.length; i += 3) if (P[i + 1] > y0 && P[i + 1] < y1 && P[i] > xmin && P[i] < xmax) { lo = Math.min(lo, P[i + ax]); hi = Math.max(hi, P[i + ax]); } return hi - lo; };
  const s = body("M", 5), l = body("M", 95);
  const ps = fitVertices(A.M, s), pl = fitVertices(A.M, l);
  const waist = (b) => b.positions.L3[1];
  assert.ok(ext(pl, waist(l) - 0.01, waist(l) + 0.01, 2, -0.12, 0.12) > ext(ps, waist(s) - 0.01, waist(s) + 0.01, 2, -0.12, 0.12) + 0.02, "waist depth");
  const th = (b) => (b.positions.hip_L[1] + b.positions.knee_L[1]) / 2;
  assert.ok(ext(pl, th(l) - 0.01, th(l) + 0.01, 0, 0.02, 0.3) > ext(ps, th(s) - 0.01, th(s) + 0.01, 0, 0.02, 0.3) + 0.01, "thigh breadth");
});

test("fitting is quick and deterministic, and leaves the asset alone", () => {
  const b = body("F", 50), before = A.F.position.slice(0, 300);
  const t0 = performance.now(), a = fitVertices(A.F, b), ms = performance.now() - t0;
  assert.deepEqual(fitVertices(A.F, b), a);
  assert.deepEqual(A.F.position.slice(0, 300), before);
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  for (const v of a) assert.ok(Number.isFinite(v));
  assert.equal(regionMaps(A.F, b).length, REGIONS.length);
});

test("the rig takes it as its skin builder: one skinned mesh with eyes, on the floor in the neutral pose and in a squat, and disposable", () => {
  for (const [sex, b] of [["M", body("M", 50)], ["F", body("F", 5)], ["F", syntheticBody(1.62, "female")]]) {
    const rig = buildRig(b, { skinBuilder: (bb, bones, o) => buildRealSkin(A[sex], bb, bones, o) });
    assert.equal(rig.skinError, null);
    assert.ok(rig.skin.isSkinnedMesh);
    assert.equal(rig.skin.userData.style, "realistic");
    assert.ok(rig.skin.children.some((c) => c.name === "eyes"));
    assert.ok(Math.abs(rig.lowestY({ skin: true })) < 0.012, `neutral ${rig.lowestY({ skin: true })}`);
    const p = byId("kneel-squat-deep"), e = expandPosture(p);
    rig.setPose({ root: { ...e.root, ...placePose(rig.restBody, { root: e.root, angles: e.angles }, { support: p.support }) }, angles: e.angles });
    const low = rig.lowestY({ skin: true });
    assert.ok(low > -0.03 && low < 0.02, `squat ${low}`);
    const box = new THREE.Box3().setFromObject(rig.skin);
    assert.ok(box.max.y - box.min.y < b.stature * 0.8, "the squat is lower than standing");
    rig.dispose();
  }
});

test("a body without the measures the fitting reads makes the builder throw, so that the shell can fall back to the mannequin", () => {
  const b = body("M", 50);
  const bad = { ...b, landmarks: { ...b.landmarks } };
  delete bad.landmarks.euryon_L;
  const bones = new Map(JOINTS.map((j) => [j.id, new THREE.Bone()]));
  assert.throws(() => buildRealSkin(A.M, bad, bones), /euryon_L/);
});
