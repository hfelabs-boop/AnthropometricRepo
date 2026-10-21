// RULA / REBA segment strain (site/js/human/strain.js): scores, colour levels and the bone colouring of the skeleton view.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/strain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { postureMetrics } from "../../site/js/human/metrics.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";
import { byId } from "../../site/js/human/postures.js";
import { BONES } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { segmentStrain, segmentOfBone, boneLevels, STRAIN_COLORS, STRAIN_LEVELS } from "../../site/js/human/strain.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const body = fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army/M.json"))), { percentile: 50 }));
const SEGMENTS = ["trunk", "neck", "upperArm_L", "upperArm_R", "lowerArm_L", "lowerArm_R", "wrist_L", "wrist_R", "legs_L", "legs_R"];

function strainOf(id) {
  const p = byId(id), e = expandPosture(p);
  const pl = placePose(body, { root: e.root, angles: e.angles }, { support: p.support });
  const root = { ...e.root, ...pl };
  return segmentStrain(postureMetrics(body, { root, angles: e.angles }, root, {}), { seated: p.support === "seat" || p.support === "seat+feet" });
}
const neutral = () => { const root = { x: 0, y: body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }; return segmentStrain(postureMetrics(body, { root, angles: {} }, root, {})); };

test("every segment is scored and coloured, within its range", () => {
  for (const s of [neutral(), strainOf("lift-stoop-start"), strainOf("sit-upright-90")]) {
    assert.deepEqual(Object.keys(s).sort(), [...SEGMENTS].sort());
    for (const [k, v] of Object.entries(s)) {
      assert.ok(Number.isInteger(v.score) && v.score >= 1 && v.score <= v.max, `${k}: ${v.score} of ${v.max}`);
      assert.ok(STRAIN_LEVELS.includes(v.level), `${k}: ${v.level}`);
      assert.equal(typeof v.why, "string");
    }
  }
});

test("the neutral standing figure is green everywhere", () => {
  for (const [k, v] of Object.entries(neutral())) assert.equal(v.level, "low", `${k}: ${v.why}`);
});

test("a stooped lift turns the trunk red, an overhead reach the raised arm, a deep squat the legs", () => {
  assert.equal(strainOf("lift-stoop-start").trunk.level, "high");
  const reach = strainOf("reach-overhead-one-hand");
  assert.ok(["upperArm_L", "upperArm_R"].some((k) => reach[k].level === "high"), JSON.stringify([reach.upperArm_L, reach.upperArm_R]));
  const squat = strainOf("kneel-squat-deep");
  assert.equal(squat.legs_L.level, "high");
  assert.equal(squat.legs_R.level, "high");
});

test("sitting does not score the knees", () => {
  const s = strainOf("sit-upright-90");
  assert.equal(s.legs_L.level, "low");
  assert.equal(s.legs_R.level, "low");
});

test("every bone belongs to a segment, and bones take the colour of their segment", () => {
  for (const b of BONES) assert.ok(SEGMENTS.includes(segmentOfBone(b)), `${b.id} -> ${segmentOfBone(b)}`);
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "femur_L")), "legs_L");
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "humerus_R")), "upperArm_R");
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "radius_L")), "lowerArm_L");
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "phalanx_index_2_L")), "wrist_L");
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "skull")), "neck");
  assert.equal(segmentOfBone(BONES.find((b) => b.id === "rib_5_L")), "trunk");
  const s = strainOf("lift-stoop-start"), lv = boneLevels(s, BONES);
  assert.equal(Object.keys(lv).length, BONES.length);
  assert.equal(lv.vert_L3, s.trunk.level);
  assert.equal(lv.tibia_R, s.legs_R.level);
});

test("the rig colours its bone meshes and restores their own material", () => {
  const rig = buildRig(body);
  const meshes = rig.view.boneMeshes, own = meshes[0].material;
  const tint = Object.fromEntries(BONES.map((b) => [b.id, STRAIN_COLORS.high]));
  tint.femur_L = STRAIN_COLORS.low;
  rig.setBoneTint(tint);
  const femur = meshes.find((m) => m.userData.boneId === "femur_L"), skull = meshes.find((m) => m.userData.boneId === "skull");
  assert.equal(femur.material.color.getHex(), STRAIN_COLORS.low);
  assert.equal(skull.material.color.getHex(), STRAIN_COLORS.high);
  assert.notEqual(skull.material, own);
  rig.setBoneTint(null);
  for (const m of meshes) assert.equal(m.material, own);
  assert.throws(() => rig.setBoneTint("red"), TypeError);
  rig.dispose();
});
