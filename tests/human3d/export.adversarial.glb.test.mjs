// Adversarial checks of the GLB export with three.js's own GLTFLoader (npm three@0.180.0), not with parsers of export.js / export.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
const { THREE, JOINTS } = H;
const GLTFLoader = await H.loadGLTFLoader();

const load = (data) => new Promise((res, rej) => new GLTFLoader().parse(data.slice(0), "", res, rej));
const rig = H.makeRig(H.haveData ? H.army("M", 50) : null);
const profile = H.army("M", 50);

function worldVerts(mesh) { mesh.updateWorldMatrix(true, true); mesh.skeleton.update(); const p = mesh.geometry.attributes.position, out = new Float64Array(p.count * 3), v = new THREE.Vector3(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); mesh.applyBoneTransform(i, v); v.applyMatrix4(mesh.matrixWorld); out.set([v.x, v.y, v.z], 3 * i); } return out; }
const maxd = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

test("GLTFLoader: skins, joints, weights, inverse bind matrices; clip mode re-posed through the node transforms equals the viewer", { skip: !GLTFLoader }, async () => {
  for (const [pname, def] of Object.entries(H.POSTURES)) {
    H.putPose(rig, def);
    const truthMesh = X.skinnedMeshes(rig)[0];
    rig.group.updateMatrixWorld(true);
    const truth = worldVerts(truthMesh);
    for (const mode of ["baked", "clip"]) {
      const out = await X.buildGLB({ rig, profile, posture: { id: def.id, name: def.name } }, { pose: mode });
      const gltf = await load(out.data);
      const skins = []; gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
      assert.deepEqual(skins.map((s) => s.name).sort(), ["eyes", "skin"]);
      const skin = skins.find((s) => s.name === "skin");
      assert.equal(skin.skeleton.bones.length, 77);
      assert.deepEqual(skin.skeleton.bones.map((b) => b.name), JOINTS.map((j) => j.id));
      // hierarchy
      for (const j of JOINTS) { const b = skin.skeleton.bones[JOINTS.indexOf(j)]; assert.equal(b.parent?.isBone ? b.parent.name : null, j.parent ?? null); }
      // weights
      const w = skin.geometry.attributes.skinWeight, si = skin.geometry.attributes.skinIndex;
      for (let v = 0; v < w.count; v++) { const s = w.getX(v) + w.getY(v) + w.getZ(v) + w.getW(v); assert.ok(Math.abs(s - 1) < 1e-5); for (const c of [si.getX(v), si.getY(v), si.getZ(v), si.getW(v)]) assert.ok(c >= 0 && c < 77); }
      let after = null;
      if (mode === "clip") {
        const mixer = new THREE.AnimationMixer(gltf.scene);
        assert.equal(gltf.animations.length, 1);
        mixer.clipAction(gltf.animations[0]).play(); mixer.update(0);
        gltf.scene.updateMatrixWorld(true);
        after = worldVerts(skin);
        // bind pose must be neutral: IBM x bone world at bind = identity BEFORE the clip. recompute from a fresh load
        const g2 = await load(out.data), s2 = []; g2.scene.traverse((o) => { if (o.isSkinnedMesh && o.name === "skin") s2.push(o); });
        g2.scene.updateMatrixWorld(true);
        const neutral = H.makeRig(profile); neutral.group.updateMatrixWorld(true);
        const nm = X.skinnedMeshes(neutral)[0], nv = worldVerts(nm);
        assert.ok(maxd(worldVerts(s2[0]), nv) < 5e-6, `${pname}: bind pose of the clip file is not the neutral shape of the viewer`);
      } else { gltf.scene.updateMatrixWorld(true); after = worldVerts(skin); }
      const d = maxd(after, truth);
      assert.ok(d < 3e-6, `${pname} ${mode}: skeleton drives the mesh ${d} m away from the viewer`);
    }
  }
});

test("baked GLB: how far is the mesh from the viewer when a user re-poses the nodes to the NEUTRAL pose (what 're-posing starts from it' means)", { skip: !GLTFLoader }, async () => {
  const report = [];
  for (const [pname, def] of Object.entries(H.POSTURES)) {
    if (pname === "neutral") continue;
    H.putPose(rig, def);
    const out = await X.buildGLB({ rig, profile, posture: { id: def.id, name: def.name } }, { pose: "baked" });
    const gltf = await load(out.data), skin = []; gltf.scene.traverse((o) => { if (o.isSkinnedMesh && o.name === "skin") skin.push(o); });
    const nr = H.makeRig(profile); nr.group.updateMatrixWorld(true);
    const truth = worldVerts(X.skinnedMeshes(nr)[0]);
    // set every node to the neutral pose
    for (const b of skin[0].skeleton.bones) { const nb = nr.bones.get(b.name); b.position.copy(nb.position); b.quaternion.copy(nb.quaternion); }
    gltf.scene.updateMatrixWorld(true);
    // pelvis: neutral root at rest height; the baked file's pelvis is where the figure stood
    const after = worldVerts(skin[0]);
    report.push(`${pname}: max ${(maxd(after, truth) * 1000).toFixed(1)} mm`);
  }
  console.log("baked -> neutral re-pose error:\n  " + report.join("\n  "));
});
