// The figure changes while a GLB is being built (the page "breathes" between steps: tick() awaits an animation frame, during which the 3D view stays interactive).
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
const { THREE, JOINTS } = H;
const GLTFLoader = await H.loadGLTFLoader();
const profile = H.army("M", 50);

test("GLB: the pose changes during a tick -> skeleton nodes and mesh must still describe ONE pose", { skip: !GLTFLoader }, async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.neutral);
  const ticks = [];
  const out = await X.buildGLB({ rig, profile, posture: { id: "t", name: "t" } }, { pose: "baked", tick: async (t) => { ticks.push(t); if (t === "Posing the skin") H.putPose(rig, H.POSTURES.squat); } });
  console.log("ticks:", ticks.join(" | "));
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(out.data.slice(0), "", res, rej));
  gltf.scene.updateMatrixWorld(true);
  let skin; gltf.scene.traverse((o) => { if (o.isSkinnedMesh && o.name === "skin") skin = o; });
  const bone = (n) => new THREE.Vector3().setFromMatrixPosition(skin.skeleton.bones.find((b) => b.name === n).matrixWorld);
  // file's mesh (rest of the skeleton at bind = identity skinning): bounding box of the vertices
  skin.geometry.computeBoundingBox();
  const truth = X.bakeSkin(rig)[0].geometry; truth.computeBoundingBox();
  const meshTop = skin.geometry.boundingBox.max.y, truthTop = truth.boundingBox.max.y;
  const kneeFile = bone("knee_L"), kneeLive = rig.jointWorld("knee_L");
  console.log(`mesh top ${meshTop.toFixed(3)} (live ${truthTop.toFixed(3)}); knee_L node ${kneeFile.toArray().map((v) => v.toFixed(3))} live ${kneeLive.toArray().map((v) => v.toFixed(3))}`);
  const dMesh = Math.abs(meshTop - truthTop), dJoint = kneeFile.distanceTo(kneeLive);
  assert.ok(dMesh < 1e-4 || dJoint < 1e-4, `mesh and skeleton disagree: mesh follows ${dMesh < 1e-4 ? "the later" : "the earlier"} pose, knee_L node is ${(dJoint * 1000).toFixed(0)} mm from the pose the mesh has`);
  assert.ok(dJoint < 1e-3 && dMesh < 1e-3, `file mixes two poses: mesh top differs ${(dMesh * 1000).toFixed(0)} mm from the final pose (joint ${(dJoint * 1000).toFixed(0)} mm)`);
});
