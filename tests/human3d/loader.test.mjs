import test from "node:test";
import assert from "node:assert/strict";

test("the vendored three.js resolves like the browser's import map", async () => {
  const THREE = await import("three");
  assert.equal(THREE.REVISION, "180");
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const v = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  assert.ok(Math.abs(v.z - 1) < 1e-12, "rotation about +X by +90 deg turns +Y toward +Z");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  assert.equal(typeof OrbitControls, "function");
});
