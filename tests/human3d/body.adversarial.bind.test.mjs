// The skin follows the bones through three.js's own skinning (SkinnedMesh.getVertexPosition) even when the rig's group is moved, rotated and scaled
// by the host, and when the pose is far from neutral: a vertex weighted 100 % to one bone lands at boneWorld * (v - restPosition).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { popProfile } from "./body.adversarial.helpers.mjs";

test("rigid vertices follow their bone under a transformed group and a strong pose; eyes follow their joints", () => {
  const body = fitBody(popProfile("united-states", "army", "M", 50)), h = {};
  const rig = buildRig(body, { skeleton: false, skinBuilder: (b, bones, o) => (h.skin = buildSkin(b, bones, o)) });
  const { mesh, eyes } = h.skin;
  rig.group.position.set(0.7, 0.2, -1.1); rig.group.rotation.set(0.3, 1.2, -0.2); rig.group.scale.setScalar(1);
  rig.setPose({ root: { x: 0.1, y: 0.9, z: 0.2, heading: 30, flex: 20, lat: 5, rot: 10 }, angles: { hip_L: [80, 10, 5], knee_L: [100, 0], shoulder_R: [120, 30, 20], elbow_R: [90], head: [15, 5, 20], eye_L: [10, 10] } });
  rig.group.updateMatrixWorld(true);
  const rest = rig.restBody.positions, ids = JOINTS.map((j) => j.id);
  const geo = mesh.geometry, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, pos = geo.attributes.position.array;
  const t = new THREE.Vector3(), e = new THREE.Vector3();
  let checked = 0, worst = 0;
  for (let v = 0; v < pos.length / 3; v += 3) {
    if (sw[v * 4] !== 1) continue;
    const id = ids[si[v * 4]], bone = rig.bones.get(id);
    mesh.getVertexPosition(v, t); t.applyMatrix4(mesh.matrixWorld);
    e.set(pos[v * 3] - rest[id][0], pos[v * 3 + 1] - rest[id][1], pos[v * 3 + 2] - rest[id][2]).applyMatrix4(bone.matrixWorld);
    worst = Math.max(worst, t.distanceTo(e)); checked++;
  }
  assert.ok(checked > 1000, `${checked} rigid vertices checked`);
  assert.ok(worst < 1e-4, `worst error ${worst}`);
  const eg = eyes.geometry, ep = eg.attributes.position.array, esi = eg.attributes.skinIndex.array;
  for (let v = 0; v < ep.length / 3; v += 7) {
    const id = ids[esi[v * 4]]; assert.match(id, /^eye_[LR]$/);
    eyes.getVertexPosition(v, t); t.applyMatrix4(eyes.matrixWorld);
    e.set(ep[v * 3] - rest[id][0], ep[v * 3 + 1] - rest[id][1], ep[v * 3 + 2] - rest[id][2]).applyMatrix4(rig.bones.get(id).matrixWorld);
    assert.ok(t.distanceTo(e) < 1e-4, `eye vertex ${v}`);
  }
  rig.dispose();
});

test("the skin bound in a rig whose body needed rebasing (restBody differs from the body) is still the identity at rest", () => {
  for (const [c, r, s, p] of [["united-states", "army", "F", 5], ["united-states", "army", "M", 95]]) {
    const body = fitBody(popProfile(c, r, s, p)), h = {};
    const rig = buildRig(body, { skeleton: false, skinBuilder: (b, bones, o) => (h.skin = buildSkin(b, bones, o)) });
    rig.group.updateMatrixWorld(true);
    const pos = h.skin.mesh.geometry.attributes.position.array, t = new THREE.Vector3();
    let worst = 0;
    for (let v = 0; v < pos.length / 3; v += 5) { h.skin.mesh.getVertexPosition(v, t); worst = Math.max(worst, Math.hypot(t.x - pos[v * 3], t.y - pos[v * 3 + 1], t.z - pos[v * 3 + 2])); }
    assert.ok(worst < 1e-5, `rest skinning error ${worst}`);
    rig.dispose();
  }
});
