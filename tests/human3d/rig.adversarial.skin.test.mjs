// A SkinnedMesh built by a skinBuilder on rig.bones must follow Kinematics: vertex bound 100% to joint J at neutral offset d from J
// ends at kin.toWorld(J, d) in any pose, including extreme roots. Also: rig.skin visibility / dispose through the builder handle.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";

test("skinned vertices follow the kinematics (all joints, extreme root, unclamped)", () => {
  let handle;
  // the realistic form: do not touch the hierarchy
  const realistic = (body, bones) => {
    const list = [...bones.values()];
    const sk = new THREE.Skeleton(list);
    const geo = new THREE.BufferGeometry();
    const pos = [], si = [], sw = [];
    const probe = new THREE.Vector3(0.011, 0.007, 0.03);
    list.forEach((b, i) => { const p = b.getWorldPosition(new THREE.Vector3()).add(probe); pos.push(p.x, p.y, p.z); si.push(i, 0, 0, 0); sw.push(1, 0, 0, 0); });
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    mesh.bind(sk);
    handle = { mesh, dispose() { geo.dispose(); mesh.material.dispose(); handle.disposed = true; } };
    return handle;
  };
  const rig = buildRig(syntheticBody(1.75, "male"), { skinBuilder: realistic });
  assert.ok(rig.skin);
  const probe = new THREE.Vector3(0.011, 0.007, 0.03);
  const rnd = (() => { let a = 5; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  let worst = 0;
  for (let k = 0; k < 20; k++) {
    const angles = {};
    for (const j of JOINTS) angles[j.id] = j.dof.map((d) => d.min + (d.max - d.min) * rnd());
    rig.setPose({ root: { x: rnd(), y: 1 + rnd(), z: rnd(), heading: rnd() * 720 - 360, flex: rnd() * 360 - 180, lat: rnd() * 180 - 90, rot: rnd() * 180 - 90 }, angles });
    rig.group.updateMatrixWorld(true);
    rig.skin.skeleton.update();
    const v = new THREE.Vector3();
    JOINTS.forEach((j, i) => {
      rig.skin.getVertexPosition(i, v);
      v.applyMatrix4(rig.skin.matrixWorld);
      // expected: joint world frame * probe
      const q = rig.jointQuaternion(j.id), p = rig.jointWorld(j.id);
      const e = probe.clone().applyQuaternion(q).add(p);
      worst = Math.max(worst, v.distanceTo(e));
    });
  }
  console.log("skinned vertex vs kinematics worst (m):", worst);
  assert.ok(worst < 1e-4, `worst ${worst}`);
  rig.dispose();
  assert.ok(handle.disposed);
});
