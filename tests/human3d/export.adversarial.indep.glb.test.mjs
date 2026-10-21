// Independent adversarial verification of the GLB export: parsed by a reader written here, loaded with the npm GLTFLoader, and driven through glTF node transforms.
//   GLTF_LOADER=<three>/examples/jsm/loaders/GLTFLoader.js node --import ./tests/human3d/register.mjs --test tests/human3d/export.adversarial.indep.glb.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { THREE, JOINTS, army, haveData, makeRig, putPose, POSTURES, loadGLTFLoader, sceneFixture } from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";

const GLTFLoader = await loadGLTFLoader();
const profile = haveData ? army("M", 50) : null;
const opt = { skip: !haveData || !GLTFLoader };

function readGLB(ab) { // own reader
  const dv = new DataView(ab); assert.equal(dv.getUint32(0, true), 0x46546c67); assert.equal(dv.getUint32(4, true), 2); assert.equal(dv.getUint32(8, true), ab.byteLength);
  const jl = dv.getUint32(12, true); assert.equal(dv.getUint32(16, true), 0x4e4f534a);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jl)));
  const o = 20 + jl; const bl = dv.getUint32(o, true); assert.equal(dv.getUint32(o + 4, true), 0x004e4942);
  assert.equal(jl % 4, 0); assert.equal(bl % 4, 0);
  return { json, bin: new Uint8Array(ab, o + 8, bl) };
}
const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView], [T, sz] = COMP[a.componentType], n = NC[a.type];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = bv.byteStride ?? sz * n;
  assert.ok(off + stride * (a.count - 1) + sz * n <= g.bin.byteLength, "accessor in bounds");
  const out = new Float64Array(a.count * n), dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
  const get = { 5126: "getFloat32", 5125: "getUint32", 5123: "getUint16", 5121: "getUint8" }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](off + k * stride + c * sz, true);
  return { data: out, n, count: a.count, a };
}
const load = (ab) => new Promise((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
const rigSkin = (rig) => X.skinnedMeshes(rig).find((m) => m.name === "skin") ?? X.skinnedMeshes(rig)[0];
const posed = (m) => { m.skeleton.update(); const v = new THREE.Vector3(), n = m.geometry.getAttribute("position").count, out = new Float32Array(3 * n); for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z; } return out; };
const maxDiff = (a, b) => { let d = 0; assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };

for (const mode of ["baked", "clip"]) for (const key of ["neutral", "squat", "supine", "prone", "side"]) {
  test(`GLB ${mode} / ${key}: GLTFLoader pose == live rig, own reader agrees`, opt, async () => {
    const rig = makeRig(profile); putPose(rig, POSTURES[key]);
    const out = await X.buildGLB({ rig, profile, posture: { id: POSTURES[key].id, name: POSTURES[key].name } }, { pose: mode });
    const g = readGLB(out.data);
    // skin structure
    assert.equal(g.json.skins.length, 1, "one skin");
    const sk = g.json.skins[0]; assert.equal(sk.joints.length, 77);
    const names = sk.joints.map((j) => g.json.nodes[j].name); assert.deepEqual(names, JOINTS.map((j) => j.id));
    const ibm = acc(g, sk.inverseBindMatrices); assert.equal(ibm.count, 77);
    // node worlds from json
    const nodes = g.json.nodes, parent = new Map(); nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
    const local = (n) => new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = (i) => { const m = local(nodes[i]); return parent.has(i) ? world(parent.get(i)).multiply(m) : m; };
    sk.joints.forEach((ji, k) => { const inv = new THREE.Matrix4().fromArray(Array.from(ibm.data.subarray(16 * k, 16 * k + 16))); const prod = inv.multiply(world(ji)); const id = new THREE.Matrix4(); for (let e = 0; e < 16; e++) assert.ok(Math.abs(prod.elements[e] - id.elements[e]) < 1e-5, `ibm*world != I at ${names[k]} e${e}: ${prod.elements[e]}`); });
    // weights
    for (const mesh of g.json.meshes) for (const p of mesh.primitives) {
      const w = acc(g, p.attributes.WEIGHTS_0), j = acc(g, p.attributes.JOINTS_0);
      for (let v = 0; v < w.count; v++) { let s = 0; for (let k = 0; k < 4; k++) { const ww = w.data[4 * v + k]; assert.ok(ww >= 0); s += ww; if (ww > 0) assert.ok(j.data[4 * v + k] < 77); } assert.ok(Math.abs(s - 1) < 1e-4, `weight sum ${s}`); }
    }
    // GLTFLoader, drive via its own scene (+ animation for clip)
    const gl = await load(out.data); gl.scene.updateMatrixWorld(true);
    if (mode === "clip") { assert.equal(gl.animations.length, 1); const mx = new THREE.AnimationMixer(gl.scene); mx.clipAction(gl.animations[0]).play(); mx.update(0); }
    gl.scene.updateMatrixWorld(true);
    const sm = []; gl.scene.traverse((o) => { if (o.isSkinnedMesh) sm.push(o); });
    assert.equal(sm.length, 2);
    const live = rig.skin ? X.skinnedMeshes(rig) : [];
    for (const m of sm) {
      const ref = live.find((l) => l.name === m.name); assert.ok(ref, "mesh " + m.name);
      rig.group.updateMatrixWorld(true);
      const a = posed(m), b = posed(ref);
      assert.ok(maxDiff(a, b) < 2e-5, `${m.name}: ${maxDiff(a, b)}`);
    }
    // joints' world positions vs rig
    const byName = new Map(); gl.scene.traverse((o) => { if (o.isBone) byName.set(o.name, o); });
    for (const j of JOINTS) { const p = new THREE.Vector3().setFromMatrixPosition(byName.get(j.id).matrixWorld), q = rig.jointWorld(j.id); assert.ok(p.distanceTo(q) < 2e-5, `${j.id} ${p.distanceTo(q)}`); }
  });
}

test("GLB baked: perturb one elbow in the file's nodes vs the same perturbation in the rig (LBS around a baked bind)", opt, async () => {
  const rig = makeRig(profile); putPose(rig, POSTURES.neutral);
  const out = await X.buildGLB({ rig, profile, posture: { id: "t", name: "Neutral standing" } }, { pose: "baked" });
  const gl = await load(out.data); gl.scene.updateMatrixWorld(true);
  const bone = (n) => { let b; gl.scene.traverse((o) => { if (o.name === n && o.isBone) b = o; }); return b; };
  const e = bone("elbow_L"); const d = 30; e.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0)); // identity: keep
  // rig: flex elbow 30 degrees
  const before = rig.getPose(); const idx = JOINTS.find((j) => j.id === "elbow_L").dof.findIndex((x) => /flex/i.test(x.key));
  const pose = JSON.parse(JSON.stringify(before)); pose.angles.elbow_L[idx] = d; rig.setPose(pose, { clamp: true }); rig.group.updateMatrixWorld(true);
  // file: the rig's new local quaternion of the joint
  e.quaternion.copy(rig.bones.get("elbow_L").quaternion); gl.scene.updateMatrixWorld(true);
  const sm = []; gl.scene.traverse((o) => { if (o.isSkinnedMesh && o.name === "skin") sm.push(o); });
  const diff = maxDiff(posed(sm[0]), posed(rigSkin(rig)));
  console.log("elbow 30 deg around baked neutral: max diff m", diff);
  assert.ok(diff < 1e-4, `file-with-node-edit vs viewer: ${diff}`);
});

test("exchange JSON joint positions / orientations equal the GLB node world transforms (two formats, one pose)", opt, async () => {
  for (const key of ["squat", "supine", "prone", "side"]) {
    const rig = makeRig(profile); putPose(rig, POSTURES[key]);
    const inp = { rig, profile, posture: { id: POSTURES[key].id, name: POSTURES[key].name } };
    const doc = JSON.parse(X.exchangeText(inp, {}));
    const v = X.validateExchange(doc); assert.ok(v.ok, v.errors.join("; "));
    const gl = await load((await X.buildGLB(inp, {})).data); gl.scene.updateMatrixWorld(true);
    const bones = new Map(); gl.scene.traverse((o) => { if (o.isBone) bones.set(o.name, o); });
    for (const j of doc.body.joints) {
      const b = bones.get(j.id), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); b.matrixWorld.decompose(p, q, s);
      const d = Math.hypot(p.x * 1000 - j.position_mm[0], p.y * 1000 - j.position_mm[1], p.z * 1000 - j.position_mm[2]);
      assert.ok(d < 0.01, `${key} ${j.id} position ${d} mm`);
      const dot = Math.abs(q.x * j.orientation_xyzw[0] + q.y * j.orientation_xyzw[1] + q.z * j.orientation_xyzw[2] + q.w * j.orientation_xyzw[3]);
      assert.ok(1 - dot < 1e-6, `${key} ${j.id} orientation ${dot}`);
      assert.ok(j.orientation_xyzw[3] >= 0);
    }
  }
});
