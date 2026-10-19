// The exporters of the Digital human tab (site/js/human/export.js) without a browser: GLB, OBJ, STL, BVH, tables, the human-exchange JSON, posture files,
// the transparency maths of the PNG export and the file names. Every output is read back by a parser written in this file (not by the exporter's code):
// the GLB is skinned again from its own nodes and accessors and compared with the vertices the live rig draws, the BVH is walked with its own forward
// kinematics and compared with Kinematics (fk.js) within 0.05 mm, OBJ and STL are parsed and measured.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/export.test.mjs
// Optional: GLTF_LOADER=/path/to/three/examples/jsm/loaders/GLTFLoader.js (and its ../utils/BufferGeometryUtils.js) also loads the GLB with three.js's own loader;
// GLTF_VALIDATOR=/path/to/node_modules/gltf-validator (npm i gltf-validator) runs the Khronos glTF validator on the files: no errors, no warnings expected.
// The browser side (the panel, the downloads, the PNG files) is tests/human3d/test_export.py.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { JOINTS, JOINT_BY_ID, CHILDREN } from "../../site/js/human/skeleton.js";
import { expandPosture, placePose, poseEquals } from "../../site/js/human/pose.js";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createMeasure } from "../../site/js/human/measure.js";
import { createStore } from "../../site/js/human/state.js";
import * as X from "../../site/js/human/export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POP = (sex) => path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`);
const haveData = fs.existsSync(POP("M")) && fs.existsSync(POP("F"));
const near = (a, b, eps, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const army = (sex, percentile) => percentileProfile(JSON.parse(fs.readFileSync(POP(sex), "utf8")), { percentile });

// ---------------------------------------------------------------------------------------------------------------------------- bodies and postures
const PROFILES = haveData
  ? [["P5 woman", army("F", 5)], ["P50 man", army("M", 50)], ["P95 man", army("M", 95)]]
  : [];
PROFILES.push(["stature only", { id: "manual:1700", label: "Man, 1700 mm (stature only)", sex: "M", source: { kind: "manual" }, measures: { stature: { value: 1700, unit: "mm", status: "edited" } }, notes: [] }]);
const RIGS = PROFILES.map(([name, profile]) => ({ name, profile, rig: buildRig(fitBody(profile, {}), { skinBuilder: buildSkin }) }));

const POSTURE_DEFS = [
  { id: "t-neutral", name: "Neutral standing", support: "feet" },
  { id: "t-sitting", name: "Seated 90-90-90", support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0] } },
  { id: "t-squat", name: "Deep squat", support: "feet", spine: { lumbar: [20, 0, 0] }, joints: { hip_LR: [125, 10, 0], knee_LR: [150, 0], ankle_LR: [30, 0, 0] } },
  { id: "t-arms-up", name: "Arms raised", support: "feet", joints: { shoulder_LR: [170, 0, 0], elbow_LR: [5], wrist_L: [10, 5], head: [-10, 3, 2] } },
  { id: "t-supine", name: "Lying on the back", support: "body", root: { flex: -90 }, joints: { knee_LR: [10, 0], shoulder_R: [20, 20, 10] } },
];
const base = { category: "Reference", tags: [], description: "test", source: "illustrative" };
/** Put the figure of `r` in the posture; returns the exporters' input. */
function setup(r, def, extra = {}) {
  const x = expandPosture({ ...base, ...def });
  const root = placePose(r.rig.restBody, { root: x.root, angles: x.angles }, { support: def.support });
  r.rig.setPose({ root: { ...root }, angles: x.angles }, { clamp: true });
  return { rig: r.rig, profile: r.profile, posture: { id: def.id, name: def.name }, ...extra };
}
const CASES = RIGS.flatMap((r) => POSTURE_DEFS.map((def) => ({ label: `${r.name} / ${def.name}`, r, def })));

// ---------------------------------------------------------------------------------------------------------------------------- stubs for the sandbox
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 800 / 600, 0.05, 120), handlers = new Map(), container = new EventTarget();
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld();
  return {
    scene, camera, container, controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null, gizmoDragging: false, canvas: null,
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {},
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    ray() { return new THREE.Raycaster(); }, attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {},
  };
}
function sceneFixture(rig, specs = []) {
  const store = createStore(), viewport = stubViewport();
  const ctx = { state: store.state, viewport, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => rig, toast() {}, units: "mm" };
  const sandbox = createSandbox({ viewport, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  for (const [type, opts] of specs) sandbox.add(type, opts);
  return { sandbox, ctx, viewport };
}

// ---------------------------------------------------------------------------------------------------------------------------- independent readers
const CT = { 5120: [1, "getInt8"], 5121: [1, "getUint8"], 5122: [2, "getInt16"], 5123: [2, "getUint16"], 5125: [4, "getUint32"], 5126: [4, "getFloat32"] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/** GLB -> { json, bin, dv } with every structural rule checked on the way. */
function readGLB(ab) {
  const buf = Buffer.from(ab), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, "magic glTF");
  assert.equal(dv.getUint32(4, true), 2, "version 2");
  assert.equal(dv.getUint32(8, true), buf.length, "total length");
  assert.equal(buf.length % 4, 0, "4-byte aligned");
  const jl = dv.getUint32(12, true);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a, "first chunk is JSON");
  assert.equal(jl % 4, 0);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString("utf8"));
  let bin = new Uint8Array(0);
  if (20 + jl < buf.length) {
    const o = 20 + jl, bl = dv.getUint32(o, true);
    assert.equal(dv.getUint32(o + 4, true), 0x004e4942, "second chunk is BIN");
    assert.equal(o + 8 + bl, buf.length, "BIN chunk ends the file");
    bin = buf.subarray(o + 8, o + 8 + bl);
    assert.ok(!json.buffers || json.buffers[0].byteLength <= bl && bl - json.buffers[0].byteLength < 4, "buffer length matches the BIN chunk");
  }
  return { json, bin, dv: new DataView(bin.buffer, bin.byteOffset, bin.byteLength) };
}
function readAccessor(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView], [size, getter] = CT[a.componentType], n = NC[a.type];
  assert.ok(size && n, `accessor ${i}: type`);
  const stride = bv.byteStride ?? size * n, start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  assert.ok((bv.byteOffset ?? 0) + bv.byteLength <= g.bin.length, `bufferView ${a.bufferView} lies inside the buffer`);
  assert.ok((a.byteOffset ?? 0) + stride * (a.count - 1) + size * n <= bv.byteLength, `accessor ${i} lies inside its bufferView`);
  const out = new Float64Array(a.count * n);
  for (let e = 0; e < a.count; e++) for (let c = 0; c < n; c++) out[e * n + c] = g.dv[getter](start + e * stride + c * size, true);
  return { a, n, data: out };
}
const nodeMatrix = (nd) => (nd.matrix ? new THREE.Matrix4().fromArray(nd.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(nd.translation ?? [0, 0, 0])), new THREE.Quaternion(...(nd.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(nd.scale ?? [1, 1, 1]))));
function worldMatrices(json, override = new Map()) {
  const world = new Map(), sc = json.scenes[json.scene ?? 0];
  const walk = (i, parent) => {
    const nd = json.nodes[i], ov = override.get(i);
    const m = ov ? new THREE.Matrix4().compose(ov.t ?? new THREE.Vector3(...(nd.translation ?? [0, 0, 0])), ov.r ?? new THREE.Quaternion(...(nd.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(nd.scale ?? [1, 1, 1]))) : nodeMatrix(nd);
    const w = parent ? parent.clone().multiply(m) : m;
    world.set(i, w);
    for (const c of nd.children ?? []) walk(c, w);
  };
  for (const r of sc.nodes) walk(r, null);
  return world;
}
/** Skin the primitive of `meshNode` from the glTF alone (the node transform of a skinned mesh is ignored, as the specification says). */
function skinFromGLB(g, meshNode, override) {
  const json = g.json, nd = json.nodes[meshNode], skin = json.skins[nd.skin], prim = json.meshes[nd.mesh].primitives[0], world = worldMatrices(json, override);
  const P = readAccessor(g, prim.attributes.POSITION).data, J = readAccessor(g, prim.attributes.JOINTS_0).data, W = readAccessor(g, prim.attributes.WEIGHTS_0).data, IBM = readAccessor(g, skin.inverseBindMatrices).data;
  const M = skin.joints.map((j, k) => world.get(j).clone().multiply(new THREE.Matrix4().fromArray(IBM, 16 * k)).elements);
  const out = new Float64Array(P.length);
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    for (let k = 0; k < 4; k++) {
      const w = W[4 * v + k];
      if (!w) continue;
      const m = M[J[4 * v + k]];
      out[3 * v] += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      out[3 * v + 1] += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      out[3 * v + 2] += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
  }
  return out;
}
/** The vertices the live rig draws, from three.js's own skinning (not from export.js). */
function rigVertices(rig, mesh) {
  rig.group.updateMatrixWorld(true);
  mesh.skeleton.update();
  const out = new Float64Array(mesh.geometry.attributes.position.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < out.length / 3; i++) { v.fromBufferAttribute(mesh.geometry.attributes.position, i); mesh.applyBoneTransform(i, v); v.applyMatrix4(mesh.matrixWorld); out.set([v.x, v.y, v.z], 3 * i); }
  return out;
}
const maxDiff = (a, b) => { let m = 0; assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const range = (a, axis) => { let lo = Infinity, hi = -Infinity; for (let i = axis; i < a.length; i += 3) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return [lo, hi]; };

function glbChecks(g, input, label) {
  const { json } = g, names = (json.nodes ?? []).map((n) => n.name);
  assert.equal(json.asset.version, "2.0", label);
  assert.match(json.asset.generator, /Digital human export/, label);
  const ex = json.asset.extras;
  assert.equal(ex.units, "m"); assert.equal(ex.axes.up, "+Y"); assert.equal(ex.axes.front, "+Z"); assert.equal(ex.profile.label, input.profile.label); assert.equal(ex.posture.id, input.posture.id);
  for (let i = 0; i < json.accessors.length; i++) {
    const { a, data } = readAccessor(g, i);
    if (a.componentType === 5126) assert.ok(data.every(Number.isFinite), `${label}: accessor ${i} has NaN`);
    if (a.min && a.max) for (let c = 0; c < a.min.length; c++) { let lo = Infinity, hi = -Infinity; for (let e = 0; e < a.count; e++) { const v = data[e * a.min.length + c]; if (v < lo) lo = v; if (v > hi) hi = v; } near(lo, a.min[c], 1e-6, "accessor min"); near(hi, a.max[c], 1e-6, "accessor max"); }
  }
  // the 77 joints: names = ids, hierarchy = skeleton.js
  const idx = new Map(JOINTS.map((j) => [j.id, names.indexOf(j.id)]));
  for (const [id, i] of idx) assert.ok(i >= 0, `${label}: node ${id}`);
  assert.equal(new Set(names.filter(Boolean)).size, names.filter(Boolean).length, `${label}: node names are unique`);
  for (const j of JOINTS) { const kids = json.nodes[idx.get(j.id)].children ?? []; assert.deepEqual(kids.map((k) => names[k]).sort(), [...CHILDREN[j.id]].sort(), `${label}: children of ${j.id}`); }
  return idx;
}

// ============================================================================================================================ file names
test("slug and file names: safe, lower case, bounded, never empty", () => {
  assert.equal(X.slug("United States · Army · men · P50"), "united-states-army-men-p50");
  assert.equal(X.slug("Ünïcödé Café — 日本語 & emoji 😀 / ../../etc/passwd"), "unicode-cafe-emoji-etc-passwd");
  assert.equal(X.slug("日本語"), "");
  assert.equal(X.slug(null), "");
  assert.equal(X.slug("a".repeat(500)).length, 40);
  assert.equal(X.slug("x-".repeat(100), 10), "x-x-x-x-x");
  assert.equal(X.exportFileName({ profile: { label: "United States · Army · men · P50" }, posture: { id: "sit-upright-90", name: "Seated" }, what: "figure", ext: "glb" }), "united-states-army-men-p50_sit-upright-90_figure.glb");
  assert.equal(X.exportFileName({ profile: null, posture: null, ext: "csv" }), "figure_pose.csv");
  assert.equal(X.exportFileName({ profile: { label: "日本語" }, posture: { name: "Neutral standing" }, what: "joints", ext: "CSV" }), "figure_neutral-standing_joints.csv");
  // the suffix the panel makes for unit + axes ("mm-x-front") is kept whole, not cut to "mm-x-fro"
  for (const suffix of ["mm", "m-z-up", "mm-z-up", "mm-x-front", "m-x-front"]) assert.equal(X.exportFileName({ profile: { label: "P" }, posture: { id: "q" }, what: "mesh", ext: "obj", suffix }), `p_q_mesh_${suffix}.obj`);
  for (const evil of ["../../x", "a/b\\c", "con", "nul.txt", "x\u0000y", "  ", "CON:", "a".repeat(400), "<script>"]) {
    const f = X.exportFileName({ profile: { label: evil }, posture: { id: evil }, what: evil, ext: "json", suffix: evil });
    assert.match(f, /^[a-z0-9_-]+\.json$/, f);
    assert.ok(f.length < 125, `${f.length} characters`);
  }
});

test("ASCII helper for headers", () => {
  assert.equal(X.ascii("United States · Army · café\nnew line"), "United States - Army - cafe new line");
  assert.equal(X.ascii(null), "");
  assert.ok(X.ascii("x".repeat(500), 50).length === 50);
});

// ============================================================================================================================ GLB
test("GLB: structure, skeleton, skin and pose of every body in every posture, baked and as a clip", { timeout: 300000 }, async () => {
  for (const { label, r, def } of CASES) {
    const input = setup(r, def);
    const pose = r.rig.getPose();
    const truth = new Map(X.skinnedMeshes(r.rig).map((m) => [m.name, rigVertices(r.rig, m)]));
    for (const mode of ["baked", "clip"]) {
      const out = await X.buildGLB(input, { pose: mode });
      assert.ok(out.bytes < 12e6, `${label}: ${out.bytes} bytes`);
      assert.equal(out.data.byteLength, out.bytes);
      const g = readGLB(out.data), idx = glbChecks(g, input, `${label} ${mode}`);
      assert.equal(g.json.skins.length, 1, "one skin shared by skin and eyes");
      const skin = g.json.skins[0];
      assert.deepEqual(skin.joints, JOINTS.map((j) => idx.get(j.id)), "skin.joints in skeleton order");
      assert.equal(skin.skeleton, idx.get("pelvis"));
      assert.equal(readAccessor(g, skin.inverseBindMatrices).a.count, 77);
      const meshNodes = g.json.nodes.map((n, i) => (n.mesh !== undefined ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(meshNodes.map((i) => g.json.nodes[i].name), ["skin", "eyes"]);
      for (const mi of meshNodes) {
        const nd = g.json.nodes[mi], prim = g.json.meshes[nd.mesh].primitives[0];
        assert.equal(nd.skin, 0);
        const P = readAccessor(g, prim.attributes.POSITION), J = readAccessor(g, prim.attributes.JOINTS_0).data, W = readAccessor(g, prim.attributes.WEIGHTS_0).data, IX = readAccessor(g, prim.indices).data;
        assert.ok(prim.attributes.NORMAL !== undefined);
        for (let v = 0; v < P.a.count; v++) {
          near(W[4 * v] + W[4 * v + 1] + W[4 * v + 2] + W[4 * v + 3], 1, 1e-5, `${label}: weights of vertex ${v}`);
          for (let k = 0; k < 4; k++) { assert.ok(J[4 * v + k] >= 0 && J[4 * v + k] < 77); assert.ok(W[4 * v + k] >= 0); }
        }
        assert.ok(IX.every((i) => i >= 0 && i < P.a.count) && IX.length % 3 === 0 && IX.length > 0);
        // the vertices skinned from the file alone against the vertices the live rig draws
        let override = new Map();
        if (mode === "clip") {
          const anim = g.json.animations[0];
          assert.equal(g.json.animations.length, 1);
          assert.equal(anim.channels.length, 78, "77 rotations + the pelvis position");
          for (const ch of anim.channels) {
            const smp = anim.samplers[ch.sampler], t = readAccessor(g, smp.input).data, v = readAccessor(g, smp.output).data;
            assert.deepEqual([...t], [0], "one frame at t = 0");
            const o = override.get(ch.target.node) ?? {};
            if (ch.target.path === "rotation") o.r = new THREE.Quaternion(...v); else if (ch.target.path === "translation") o.t = new THREE.Vector3(...v); else assert.fail(`path ${ch.target.path}`);
            override.set(ch.target.node, o);
          }
          // the bind pose of the file is the neutral standing pose: no rotation on any joint node
          for (const j of JOINTS) assert.equal(g.json.nodes[idx.get(j.id)].rotation, undefined, `${j.id} rests at identity`);
          near(g.json.nodes[idx.get("pelvis")].translation[1], r.rig.restRootY, 1e-6);
        } else assert.equal(g.json.animations, undefined);
        const skinned = skinFromGLB(g, mi, override);
        const live = truth.get(nd.name);
        assert.ok(maxDiff(skinned, live) < 2e-6, `${label} ${mode} ${nd.name}: ${maxDiff(skinned, live)} m`);
      }
      // the joint nodes carry the pose of the rig in baked mode, and the skinning matrices are the identity then
      if (mode === "baked") {
        const w = worldMatrices(g.json);
        for (const j of JOINTS) { const p = new THREE.Vector3().setFromMatrixPosition(w.get(idx.get(j.id))), q = r.rig.jointWorld(j.id); assert.ok(p.distanceTo(q) < 1e-6, `${label}: joint ${j.id}`); }
        const ibm = readAccessor(g, skin.inverseBindMatrices).data;
        for (let k = 0; k < 77; k++) { const m = w.get(skin.joints[k]).clone().multiply(new THREE.Matrix4().fromArray(ibm, 16 * k)).elements; for (let c = 0; c < 16; c++) near(m[c], c % 5 === 0 ? 1 : 0, 1e-5, "baked bind pose"); }
      }
      if (mode === "baked" && def.id === "t-neutral") { // standing on the floor: the skin spans stature
        const P = readAccessor(g, g.json.meshes[g.json.nodes[g.json.nodes.findIndex((n) => n.name === "skin")].mesh].primitives[0].attributes.POSITION).data, [lo, hi] = range(P, 1);
        near(lo, 0, 0.012, `${label}: soles on the floor`);
        near(hi - lo, r.rig.body.stature, 0.02, `${label}: height of the skin`);
      }
    }
    assert.ok(poseEquals(r.rig.getPose(), pose), "the export did not change the pose");
  }
});

test("GLB: skeleton only, no figure, hostile options, the export is read-only", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]);
  const before = JSON.stringify(r.rig.getPose());
  for (const mode of ["baked", "clip"]) {
    const out = await X.buildGLB(input, { figure: "skeleton", pose: mode });
    const g = readGLB(out.data), idx = glbChecks(g, input, `skeleton ${mode}`);
    assert.deepEqual(g.json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name), ["skeleton-sticks"]);
    assert.ok(out.bytes < 400000, `${out.bytes}`);
    const mi = g.json.nodes.findIndex((n) => n.name === "skeleton-sticks"), P = readAccessor(g, g.json.meshes[g.json.nodes[mi].mesh].primitives[0].attributes.POSITION).data;
    assert.equal(P.length / 3, out.stats.vertices);
    let override = new Map();
    if (mode === "clip") for (const ch of g.json.animations[0].channels) { const v = readAccessor(g, g.json.animations[0].samplers[ch.sampler].output).data, o = override.get(ch.target.node) ?? {}; if (ch.target.path === "rotation") o.r = new THREE.Quaternion(...v); else o.t = new THREE.Vector3(...v); override.set(ch.target.node, o); }
    const posed = skinFromGLB(g, mi, override), [lo, hi] = range(posed, 1);
    assert.ok(lo > -0.05 && hi < 2.4, `sticks inside the figure's box: ${lo}..${hi}`);
    assert.ok(idx.size === 77);
  }
  await assert.rejects(() => X.buildGLB(input, { figure: "none" }), /nothing to export/i);
  await assert.rejects(() => X.buildGLB(input, { figure: "bones" }), /Unknown GLB content/);
  await assert.rejects(() => X.buildGLB(input, { pose: "t" }), /Unknown GLB pose/);
  await assert.rejects(() => X.buildGLB({ rig: null }), /no figure to export/i);
  await assert.rejects(() => X.buildGLB({}), /no figure to export/i);
  assert.equal(JSON.stringify(r.rig.getPose()), before);
});

test("GLB: scene objects as named nodes with type and parameters, measurements as extras, hidden and broken objects", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]);
  const { sandbox, ctx, viewport } = sceneFixture(r.rig, [
    ["cabin_seat", { position: [0, 0, 0.5], params: { seatHeight: 0.42 }, name: "Pilot seat" }], ["monitor", { position: [0, 0.74, 1.2], yaw: 180, name: "pelvis" }],
    ["crate", { position: [1, 0, 0], params: { mass: 12.5 }, name: "Crate\nwith newline and a very long name ".repeat(4) }], ["crate", { position: [-1, 0, 0], name: "Hidden crate", visible: false }],
    ["crate", { position: [2, 0, 0], name: "Crate" }], ["crate", { position: [3, 0, 0], name: "Crate" }], ["crate", { position: [4, 0, 0], name: "scene" }], ["crate", { position: [5, 0, 0], name: "skin" }],
  ]);
  const measure = createMeasure({ viewport, ctx, sandbox });
  measure.addDistance({ kind: "landmark", id: "eye_mid" }, { kind: "object", id: [...sandbox.objects.keys()][1], anchor: "screen_centre" }, { label: "Eye to screen" });
  const rows = measure.exportRows();
  assert.equal(rows.length, 1);
  const out = await X.buildGLB({ ...input, sandbox, measurements: rows }, { scene: true, measurements: true });
  const g = readGLB(out.data), idx = glbChecks(g, input, "scene");
  assert.equal(out.stats.objects, 7, "the hidden crate is left out");
  const nodes = g.json.nodes, sceneNode = nodes.find((n) => n.name === "scene");
  assert.ok(sceneNode, "a group for the scene objects");
  const objs = sceneNode.children.map((i) => nodes[i]);
  assert.equal(objs.length, 7);
  const names = objs.map((n) => n.name);
  assert.equal(new Set(names).size, 7, "unique names");
  assert.equal(nodes.filter((n) => n.name === "scene").length, 1, "an object named like the scene group got another name");
  assert.equal(nodes.filter((n) => n.name === "skin").length, 1);
  assert.ok(names.every((n) => !JOINT_BY_ID[n] && n.length <= 60 && !/[\n\r]/.test(n)), names.join("|"));
  const seat = objs[0], crate = objs[2];
  assert.equal(seat.extras.digitalHuman.type, "cabin_seat");
  assert.equal(seat.extras.digitalHuman.params.seatHeight, 0.42);
  assert.equal(crate.extras.digitalHuman.type, "crate");
  assert.equal(crate.extras.digitalHuman.params.mass, 12.5);
  assert.deepEqual(seat.translation?.map((v) => Math.round(v * 1000) / 1000), [0, 0, 0.5]);
  assert.ok(g.json.meshes.length >= 2 + 7, "meshes for the figure and every object");
  const meas = g.json.scenes[0].extras?.digitalHuman?.measurements ?? [];
  assert.equal(meas.length, 1);
  assert.equal(meas[0].label, "Eye to screen");
  assert.equal(g.json.scenes[0].name, "digital-human");
  // without the options the extras are not there
  const plain = readGLB((await X.buildGLB({ ...input, sandbox, measurements: rows }, {})).data);
  assert.ok(!plain.json.nodes.some((n) => n.name === "scene") && !plain.json.scenes[0].extras);
  // an object with a broken transform is skipped, not exported as NaN
  const first = [...sandbox.objects.values()][0];
  first.group.position.x = NaN; first.group.updateMatrixWorld(true);
  const bad = await X.buildGLB({ ...input, sandbox }, { scene: true });
  assert.equal(bad.stats.skippedObjects, 1);
  assert.equal(bad.stats.objects, 6);
  assert.ok(readGLB(bad.data).json.accessors.length > 0);
  // empty scene
  const empty = sceneFixture(r.rig, []);
  const e = await X.buildGLB({ ...input, sandbox: empty.sandbox }, { scene: true });
  assert.equal(e.stats.objects, 0);
  await assert.rejects(() => X.buildGLB({ ...input, sandbox: empty.sandbox }, { scene: true, figure: "none" }), /nothing to export/i);
  sandbox.dispose(); empty.sandbox.dispose(); measure.dispose();
});

test("GLB: a scene of 200 objects stays small and fast, odd names are made safe", { timeout: 120000 }, async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]);
  const types = ["crate", "monitor", "stool", "pallet", "ladder", "rifle", "desk", "steering_wheel"];
  const specs = Array.from({ length: 200 }, (_, i) => [types[i % types.length], { position: [(i % 20) * 1.5 - 15, 0, Math.floor(i / 20) * 1.5 + 2], name: ["", "😀", "x".repeat(200), "same", "same", "pelvis", "head", "a\u0000b"][i % 8] || undefined }]);
  const { sandbox } = sceneFixture(r.rig, specs);
  assert.equal(sandbox.objects.size, 200);
  const t0 = performance.now();
  const out = await X.buildGLB({ ...input, sandbox }, { scene: true });
  const ms = performance.now() - t0;
  const g = readGLB(out.data);
  assert.equal(out.stats.objects, 200);
  assert.ok(out.bytes < 16e6 && out.bytes / 200 < 90000, `${out.bytes} bytes`);
  assert.ok(ms < 30000, `${ms} ms`);
  const names = g.json.nodes.map((n) => n.name).filter(Boolean);
  assert.equal(new Set(names).size, names.length, "all node names are unique");
  const sceneNode = g.json.nodes.find((n) => n.name === "scene");
  assert.equal(sceneNode.children.length, 200);
  for (const c of sceneNode.children) { const n = g.json.nodes[c]; assert.ok(n.name.length <= 70 && !JOINT_BY_ID[n.name] && !/[\u0000-\u001f]/.test(n.name)); }
  for (const f of [() => X.buildOBJ({ ...input, sandbox }, { scene: true }), () => X.buildSTL({ ...input, sandbox }, { scene: true })]) { const o = await f(); assert.ok(o.bytes > 0 && o.stats.objects === 200); }
  sandbox.dispose();
});

test("GLB: loads again with three.js's GLTFLoader when it is available (GLTF_LOADER)", { skip: !process.env.GLTF_LOADER }, async () => {
  const { GLTFLoader } = await import(pathToFileURL(process.env.GLTF_LOADER).href);
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[3]);
  const truth = rigVertices(r.rig, r.rig.skin), v = new THREE.Vector3();
  for (const mode of ["baked", "clip"]) {
    const out = await X.buildGLB(input, { pose: mode });
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(out.data, "", res, rej));
    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && o.name === "skin") skin = o; });
    assert.ok(skin && skin.skeleton.bones.length === 77);
    assert.deepEqual(skin.skeleton.bones.map((b) => b.name), JOINTS.map((j) => j.id));
    if (mode === "clip") { assert.equal(gltf.animations.length, 1); const mx = new THREE.AnimationMixer(gltf.scene); mx.clipAction(gltf.animations[0]).play(); mx.update(0); }
    gltf.scene.updateMatrixWorld(true); skin.skeleton.update();
    let worst = 0;
    for (let i = 0; i < skin.geometry.attributes.position.count; i += 3) { v.fromBufferAttribute(skin.geometry.attributes.position, i); skin.applyBoneTransform(i, v); v.applyMatrix4(skin.matrixWorld); worst = Math.max(worst, Math.hypot(v.x - truth[3 * i], v.y - truth[3 * i + 1], v.z - truth[3 * i + 2])); }
    assert.ok(worst < 1e-6, `${mode}: ${worst}`);
  }
});

test("GLB: the Khronos glTF validator finds no error and no warning (GLTF_VALIDATOR)", { skip: !process.env.GLTF_VALIDATOR }, async () => {
  const { createRequire } = await import("node:module");
  const validator = createRequire(path.join(process.env.GLTF_VALIDATOR, "index.js"))(process.env.GLTF_VALIDATOR);
  const r = RIGS[0], input = setup(r, POSTURE_DEFS[1]), { sandbox } = sceneFixture(r.rig, [["cabin_seat", {}], ["monitor", { position: [0, 0.7, 1.4] }], ["crate", { position: [1, 0, 0] }]]);
  for (const [name, opts] of [["baked", { pose: "baked", scene: true }], ["clip", { pose: "clip", scene: true }], ["skeleton", { figure: "skeleton" }], ["scene only", { figure: "none", scene: true }]]) {
    const g = await X.buildGLB({ ...input, sandbox }, opts), rep = await validator.validateBytes(new Uint8Array(g.data), { maxIssues: 50 });
    assert.equal(rep.issues.numErrors + rep.issues.numWarnings, 0, `${name}: ${JSON.stringify(rep.issues.messages.slice(0, 3))}`);
  }
  sandbox.dispose();
});

test("GLB helpers: parseGLB and packGLB round trip, and refuse damaged files", () => {
  const json = { asset: { version: "2.0" }, scenes: [{}], extras: { text: "café" } }, bin = new Uint8Array([1, 2, 3, 4, 5]);
  const ab = X.packGLB(json, bin), back = X.parseGLB(ab);
  assert.deepEqual(back.json, json);
  assert.deepEqual([...back.bin.slice(0, 5)], [1, 2, 3, 4, 5]);
  assert.equal(ab.byteLength % 4, 0);
  assert.equal(X.parseGLB(X.packGLB(json, null)).bin, null);
  assert.throws(() => X.parseGLB(new ArrayBuffer(8)), /too short/);
  assert.throws(() => X.parseGLB(new Uint8Array(40).buffer), /header is missing/);
  const trunc = ab.slice(0, ab.byteLength - 4);
  assert.throws(() => X.parseGLB(trunc), /truncated/);
  const v1 = new Uint8Array(ab.slice(0)); v1[4] = 1;
  assert.throws(() => X.parseGLB(v1.buffer), /version/);
});

// ============================================================================================================================ OBJ and STL
function readOBJ(text) {
  const v = [], vn = [], faces = [], objects = [], comments = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) comments.push(line);
    else if (line.startsWith("v ")) v.push(line.slice(2).split(" ").map(Number));
    else if (line.startsWith("vn ")) vn.push(line.slice(3).split(" ").map(Number));
    else if (line.startsWith("f ")) faces.push(line.slice(2).split(" ").map((t) => t.split("/").map((x) => (x === "" ? null : Number(x)))));
    else if (line.startsWith("o ")) objects.push(line.slice(2));
  }
  return { v, vn, faces, objects, comments };
}
const rangeOf = (pts, k) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p[k] < lo) lo = p[k]; if (p[k] > hi) hi = p[k]; } return [lo, hi]; };
function readSTL(ab) {
  const dv = new DataView(ab), n = dv.getUint32(80, true);
  assert.equal(ab.byteLength, 84 + 50 * n, "binary STL size");
  const tris = [];
  for (let i = 0; i < n; i++) { const o = 84 + 50 * i, f = (k) => dv.getFloat32(o + 4 * k, true); tris.push({ n: [f(0), f(1), f(2)], v: [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]] }); assert.equal(dv.getUint16(o + 48, true), 0); }
  return { n, tris, header: new TextDecoder().decode(new Uint8Array(ab, 0, 80)) };
}

test("OBJ: counts, bounds in the chosen unit, header, axis systems, no NaN", { timeout: 120000 }, async () => {
  for (const { label, r, def } of CASES.filter((c, i) => i % 3 === 0 || c.def.id === "t-supine")) {
    const input = setup(r, def), out = await X.buildOBJ(input);
    const o = readOBJ(out.text);
    assert.equal(o.v.length, out.stats.vertices, label);
    assert.equal(o.vn.length, o.v.length);
    assert.equal(o.faces.length, out.stats.triangles);
    assert.ok(o.faces.every((f) => f.length === 3 && f.every(([a, , c]) => a >= 1 && a <= o.v.length && c >= 1 && c <= o.vn.length)), "face indices");
    assert.ok(o.v.every((p) => p.length === 3 && p.every(Number.isFinite)) && o.vn.every((p) => p.every(Number.isFinite)));
    assert.deepEqual(o.objects, ["skin", "eyes"]);
    const head = o.comments.join("\n");
    assert.match(head, /Units: millimetres \(1 unit = 1 mm\)/); assert.match(head, /up = \+Y, the figure faces \+Z, the figure's left = \+X/); assert.ok(head.includes(X.ascii(r.profile.label)) && head.includes(def.id), "profile and posture named");
    assert.ok(!/[^\x00-\x7f]/.test(head), "the header is ASCII");
    if (def.id === "t-neutral") { const [lo, hi] = rangeOf(o.v, 1); near(lo, 0, 12, `${label}: floor, mm`); near(hi - lo, r.rig.body.stature * 1000, 20, `${label}: stature in mm`); }
  }
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[3]);
  const mm = readOBJ((await X.buildOBJ(input)).text), m = readOBJ((await X.buildOBJ(input, { unit: "m" })).text);
  assert.ok(maxDiff(mm.v.flat().map((x) => x / 1000), m.v.flat()) < 2e-6, "metres are millimetres / 1000");
  assert.match((await X.buildOBJ(input, { unit: "m" })).text, /Units: metres \(1 unit = 1 m\)/);
  const z = readOBJ((await X.buildOBJ(input, { axes: "z-up" })).text), xf = readOBJ((await X.buildOBJ(input, { axes: "x-front" })).text);
  for (let i = 0; i < mm.v.length; i += 97) {
    const [x, y, zz] = mm.v[i];
    assert.ok(maxDiff([z.v[i][0], z.v[i][1], z.v[i][2]], [x, -zz, y]) < 1e-3, "z-up = (x, -z, y)");
    assert.ok(maxDiff(xf.v[i], [zz, x, y]) < 1e-3, "x-front = (z, x, y)");
  }
  assert.match((await X.buildOBJ(input, { axes: "z-up" })).text, /up = \+Z, the figure faces -Y/);
  // the winding survives the axes (a proper rotation): the first triangle has the same orientation relative to its normal
  const orient = (obj, k) => { const f = obj.faces[k], [a, b, c] = f.map(([i]) => obj.v[i - 1]), n = obj.vn[f[0][2] - 1], u = b.map((q, j) => q - a[j]), w = c.map((q, j) => q - a[j]); return Math.sign(n[0] * (u[1] * w[2] - u[2] * w[1]) + n[1] * (u[2] * w[0] - u[0] * w[2]) + n[2] * (u[0] * w[1] - u[1] * w[0])); };
  for (const k of [0, 5000, 20000]) { assert.equal(orient(z, k), orient(mm, k)); assert.equal(orient(xf, k), orient(mm, k)); }
  await assert.rejects(() => X.buildOBJ(input, { unit: "cm" }), /Unknown unit/);
  await assert.rejects(() => X.buildOBJ(input, { axes: "up" }), /Unknown axis/);
  await assert.rejects(() => X.buildOBJ(input, { skin: false }), /nothing to export/i);
});

test("STL: binary size and triangle count, normals, bounds in mm, header, units and axes", { timeout: 120000 }, async () => {
  for (const { label, r, def } of CASES.filter((c, i) => i % 4 === 1)) {
    const input = setup(r, def), out = await X.buildSTL(input), s = readSTL(out.data);
    assert.equal(s.n, out.triangles); assert.equal(s.n, out.stats.triangles); assert.equal(out.bytes, 84 + 50 * s.n);
    assert.ok(!s.header.startsWith("solid"), "a binary header must not start with 'solid'");
    assert.match(s.header, /units mm/); assert.ok(s.header.includes(def.id) || s.header.includes(def.name));
    let bad = 0;
    for (const t of s.tris) {
      const [a, b, c] = t.v, u = b.map((q, j) => q - a[j]), w = c.map((q, j) => q - a[j]), n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n);
      assert.ok(t.n.every(Number.isFinite) && t.v.flat().every(Number.isFinite));
      if (l > 1e-6) { const dot = (n[0] * t.n[0] + n[1] * t.n[1] + n[2] * t.n[2]) / l; if (dot < 0.999) bad++; }
    }
    assert.ok(bad < s.n * 0.001, `${label}: ${bad} facets whose normal is not their winding`);
    if (def.id === "t-neutral") { const pts = s.tris.flatMap((t) => t.v), [lo, hi] = rangeOf(pts, 1); near(lo, 0, 12, `${label}: floor`); near(hi - lo, r.rig.body.stature * 1000, 20, `${label}: stature in mm`); }
  }
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]);
  const m = readSTL((await X.buildSTL(input, { unit: "m" })).data), z = readSTL((await X.buildSTL(input, { axes: "z-up" })).data);
  const [lo, hi] = rangeOf(m.tris.flatMap((t) => t.v), 1); near(hi - lo, r.rig.body.stature, 0.02, "metres");
  const [zlo, zhi] = rangeOf(z.tris.flatMap((t) => t.v), 2); near(zhi - zlo, r.rig.body.stature * 1000, 20, "z-up: the height is along Z");
  assert.match(readSTL((await X.buildSTL(input, { axes: "z-up" })).data).header, /up \+Z front -Y/);
});

// ============================================================================================================================ BVH
function readBVH(text) {
  const clean = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"), tok = clean.split(/\s+/).filter(Boolean);
  let i = 0;
  const eat = (s) => { assert.equal(tok[i], s, `expected ${s} at token ${i}`); i++; };
  const num3 = () => [Number(tok[i++]), Number(tok[i++]), Number(tok[i++])];
  const joints = [], ends = [];
  function node(parent) {
    const kind = tok[i++];
    assert.ok(kind === "ROOT" || kind === "JOINT", `JOINT at ${i}: ${kind}`);
    const j = { name: tok[i++], parent, kids: [] };
    eat("{"); eat("OFFSET"); j.offset = num3(); eat("CHANNELS");
    const nch = Number(tok[i++]); j.channels = tok.slice(i, i + nch); i += nch; assert.equal(j.channels.length, nch);
    joints.push(j);
    for (;;) {
      if (tok[i] === "JOINT") j.kids.push(node(j));
      else if (tok[i] === "End") { i++; eat("Site"); eat("{"); eat("OFFSET"); const o = num3(); eat("}"); j.end = o; ends.push(j); }
      else { eat("}"); break; }
    }
    return j;
  }
  eat("HIERARCHY");
  const root = node(null);
  eat("MOTION"); eat("Frames:"); const nf = Number(tok[i++]); eat("Frame"); eat("Time:"); const dt = Number(tok[i++]);
  const per = joints.reduce((s, j) => s + j.channels.length, 0), frames = [];
  for (let f = 0; f < nf; f++) { frames.push(tok.slice(i, i + per).map(Number)); i += per; }
  assert.equal(i, tok.length, "nothing after the last frame");
  assert.ok(frames.every((fr) => fr.length === per && fr.every(Number.isFinite)));
  return { root, joints, ends, frames, dt, per };
}
const RX = (a) => new THREE.Matrix4().makeRotationX(a), RY = (a) => new THREE.Matrix4().makeRotationY(a), RZ = (a) => new THREE.Matrix4().makeRotationZ(a);
/** Forward kinematics of one BVH frame: world matrices by joint name (lengths in the file's unit). */
function bvhFK(bvh, frame) {
  let c = 0;
  const world = new Map(), ends = new Map();
  (function walk(j, parentW) {
    const vals = frame.slice(c, c + j.channels.length); c += j.channels.length;
    let T = new THREE.Matrix4().makeTranslation(...j.offset), R = new THREE.Matrix4();
    j.channels.forEach((ch, k) => {
      const v = vals[k];
      if (ch === "Xposition") T.elements[12] += v; else if (ch === "Yposition") T.elements[13] += v; else if (ch === "Zposition") T.elements[14] += v;
      else R = R.multiply({ Xrotation: RX, Yrotation: RY, Zrotation: RZ }[ch](v * Math.PI / 180)); // channels in the order listed: R = R1 * R2 * R3
    });
    const W = (parentW ? parentW.clone() : new THREE.Matrix4()).multiply(T).multiply(R);
    world.set(j.name, W);
    if (j.end) ends.set(j.name, new THREE.Vector3(...j.end).applyMatrix4(W));
    for (const k of j.kids) walk(k, W);
  })(bvh.root, null);
  return { world, ends };
}

test("BVH: hierarchy of 77 joints, channels, frames; forward kinematics of the file equals Kinematics within 0.05 mm", () => {
  const SCALE = { cm: 100, mm: 1000, m: 1 };
  for (const { label, r, def } of CASES) {
    const input = setup(r, def), kin = new Kinematics(r.rig.restOffsets);
    for (const unit of ["cm", "mm", "m"]) {
      if (unit !== "cm" && def.id !== "t-sitting" && def.id !== "t-supine") continue;
      const out = X.buildBVH(input, { unit, neutralFrame: true }), b = readBVH(out.text);
      assert.equal(b.joints.length, 77); assert.deepEqual(b.joints.map((j) => j.name), (function dfs(id) { return [id, ...CHILDREN[id].flatMap(dfs)]; })("pelvis"));
      assert.equal(b.root.name, "pelvis"); assert.deepEqual(b.root.channels, ["Xposition", "Yposition", "Zposition", "Zrotation", "Xrotation", "Yrotation"]);
      assert.ok(b.joints.slice(1).every((j) => j.channels.join() === "Zrotation,Xrotation,Yrotation"));
      assert.equal(b.ends.length, JOINTS.filter((j) => !CHILDREN[j.id].length).length, "an End Site for every leaf");
      assert.equal(b.frames.length, 2); near(b.dt, 1 / 30, 1e-6); assert.equal(b.per, 6 + 3 * 76);
      assert.equal(out.joints, 77); assert.equal(out.frames, 2);
      const k = SCALE[unit], eps = 5e-5; // 0.05 mm
      // frame 1: the current pose
      kin.solve(r.rig.angles, r.rig.root);
      const f1 = bvhFK(b, b.frames[0]), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
      let worst = 0, worstR = 0;
      for (const j of JOINTS) {
        const p = new THREE.Vector3().setFromMatrixPosition(f1.world.get(j.id)).divideScalar(k), t = kin.position(j.id);
        worst = Math.max(worst, p.distanceTo(t));
        q.setFromRotationMatrix(f1.world.get(j.id)); kin.quaternion(j.id, q2);
        worstR = Math.max(worstR, q.angleTo(q2));
      }
      assert.ok(worst < eps, `${label} ${unit}: joint positions differ by ${(worst * 1000).toFixed(4)} mm`);
      assert.ok(worstR < 1e-5, `${label} ${unit}: joint orientations differ by ${worstR} rad`);
      // the End Sites are the landmarks their bones end at: that checks the rotation of every leaf joint
      for (const [name, p] of f1.ends) {
        const j = JOINT_BY_ID[name], lmId = Object.entries(r.rig.restBody.landmarks).find(([id, l]) => l.joint === name && /tip|pupil|gnathion/.test(id))?.[0];
        if (lmId) assert.ok(p.divideScalar(k).distanceTo(r.rig.landmarkWorld(lmId)) < eps, `${label}: End Site of ${j.id} is ${lmId}`);
      }
      // frame 2: neutral standing at the rest height
      const neutral = new Kinematics(r.rig.restOffsets).solve({}, { x: 0, y: r.rig.restRootY, z: 0 }), f2 = bvhFK(b, b.frames[1]);
      for (const j of JOINTS) assert.ok(new THREE.Vector3().setFromMatrixPosition(f2.world.get(j.id)).divideScalar(k).distanceTo(neutral.position(j.id)) < eps, `${label}: neutral frame, ${j.id}`);
      // OFFSETs are the rest offsets in the unit of the file
      for (const j of b.joints.slice(1)) near(Math.hypot(...j.offset) / k, Math.hypot(...r.rig.restOffsets[j.name]), 2e-6, `${label}: offset of ${j.name}`);
    }
  }
});

test("BVH: gimbal poses, the optional header, options, hostile input", () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]);
  // hips at 90 degrees put the local Euler angle X at exactly +-90: the conversion must stay exact there
  const plain = X.buildBVH(input).text;
  assert.ok(plain.startsWith("HIERARCHY\n"), "the first word is HIERARCHY (Blender insists)");
  const withHeader = X.buildBVH(input, { header: true, neutralFrame: true, created: "2026-01-02T03:04:05Z" }).text;
  assert.ok(withHeader.startsWith("# Digital human BVH export\n"));
  assert.match(withHeader, /# Units of OFFSET and position: centimetres; rotations in degrees, order Z X Y/); assert.match(withHeader, /# Axes: right-handed; \+Y up/); assert.match(withHeader, /# Posture: Seated 90-90-90 \[t-sitting\]/); assert.match(withHeader, /# Created: 2026-01-02T03:04:05Z/);
  assert.equal(readBVH(withHeader).frames.length, 2);
  assert.equal(readBVH(plain).frames.length, 1);
  assert.throws(() => X.buildBVH(input, { unit: "in" }), /Unknown unit/);
  assert.throws(() => X.buildBVH({ rig: undefined }), /no figure/);
  // an angle on every joint at the same time, including the limits
  const angles = {};
  for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = j.dof.map((d, i) => (i % 2 ? d.max : d.min));
  r.rig.setPose({ root: { y: 1, heading: 135, flex: 200, lat: -70, rot: 33 }, angles }, { clamp: true });
  const out = X.buildBVH({ ...input }, { unit: "mm" }), b = readBVH(out.text), kin = new Kinematics(r.rig.restOffsets).solve(r.rig.angles, r.rig.root), f = bvhFK(b, b.frames[0]);
  for (const j of JOINTS) assert.ok(new THREE.Vector3().setFromMatrixPosition(f.world.get(j.id)).divideScalar(1000).distanceTo(kin.position(j.id)) < 5e-5, j.id);
  // all-zero rotation channels in the neutral frame
  const n = readBVH(X.buildBVH(input, { neutralFrame: true }).text).frames[1];
  assert.ok(n.slice(3).every((v) => v === 0), "neutral rotations are exactly 0");
});

// ============================================================================================================================ tables
function readCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test("tables: joint angles (CSV and JSON), dimensions, fit report, posture metrics", async () => {
  const r = RIGS[1] ?? RIGS[0];
  setup(r, POSTURE_DEFS[3]);
  r.rig.setAngles({ elbow_L: [150], knee_R: [-5, 0], shoulder_L: [170, 0, 0] }); // limits: elbow flex max, knee flex min
  const input = { rig: r.rig, profile: r.profile, posture: { id: "t-arms-up", name: "Arms raised" } }, pose = r.rig.getPose();
  const rows = readCSV(X.anglesCSV(input)), head = rows[0];
  assert.deepEqual(head, [...X.ANGLE_COLUMNS]);
  const nDof = JOINTS.filter((j) => j.id !== "pelvis").reduce((s, j) => s + j.dof.length, 0);
  assert.equal(rows.length - 1, 4 + nDof, "4 root rows + every degree of freedom (the pelvis only when it has its own angles)");
  const col = (name) => head.indexOf(name), get = (id, dof) => rows.find((x) => x[0] === id && x[col("dof_key")] === dof);
  assert.equal(get("root", "heading")[col("value_deg")], String(pose.root.heading));
  const elbow = get("elbow_L", "flex"); assert.equal(elbow[col("value_deg")], "150"); assert.equal(elbow[col("at_limit")], "max"); assert.equal(elbow[col("max_deg")], "150");
  const knee = get("knee_R", "flex"); assert.equal(knee[col("at_limit")], "min");
  assert.equal(get("hip_L", "flex")[col("at_limit")], "");
  for (const j of JOINTS) j.dof.forEach((d, i) => { if (j.id === "pelvis") return; const row = get(j.id, d.key); near(Number(row[col("value_deg")]), pose.angles[j.id][i], 5e-5, `${j.id} ${d.key}`); near(Number(row[col("min_deg")]), d.min, 1e-3); assert.equal(row[col("side")], j.side ?? ""); assert.equal(row[col("axis_x")], String(d.axis[0])); });
  assert.ok(rows.every((x) => x.length === head.length), "every row has every column");
  const json = JSON.parse(X.anglesJSON(input));
  assert.equal(json.format, "human-joint-angles"); assert.equal(json.units.angle, "deg"); assert.equal(json.rows.length, rows.length - 1); assert.equal(json.profile.label, r.profile.label); assert.equal(json.posture.id, "t-arms-up");
  assert.match(X.anglesCSV(input, { header: true }), /^# Joint angles - Digital human export 1[^\n]*\n# Profile: [^\n]*\n# Posture: Arms raised \[t-arms-up\]\n# Units: degrees\n# Axes: right-handed/);
  // dimensions
  const dims = readCSV(X.dimsCSV(input)), body = r.rig.body;
  assert.deepEqual(dims[0], [...X.DIM_COLUMNS]); assert.equal(dims.length - 1, body.dims.length);
  const stat = dims.find((x) => x[0] === "stature"); near(Number(stat[2]), body.stature * 1000, 5e-4); assert.equal(stat[3], "mm"); assert.equal(dims.find((x) => x[0] === "mass")[3], "kg"); assert.equal(dims.find((x) => x[0] === "adiposity")?.[3] ?? "", "");
  // fit report
  const rep = readCSV(X.reportCSV(input));
  assert.deepEqual(rep[0], [...X.REPORT_COLUMNS]); assert.equal(rep.length - 1, body.report.length);
  const rs = rep.find((x) => x[0] === "stature"); near(Number(rs[5]), body.report.find((x) => x.id === "stature").input, 5e-4); assert.equal(rs[9], "ok");
  assert.ok(rep.every((x) => x.length === X.REPORT_COLUMNS.length));
  // metrics
  const met = await X.metricsCSV(input);
  if (met) {
    const m = readCSV(met);
    assert.deepEqual(m[0], [...X.METRIC_COLUMNS]);
    const eye = m.find((x) => x[1] === "eyeHeight"); assert.equal(eye[3], "mm"); assert.ok(Number(eye[4]) > 800 && Number(eye[4]) < 2000);
    assert.ok(m.find((x) => x[1] === "shoulderElevation_L")[4] !== "" && m.find((x) => x[1] === "shoulderElevation_L")[2].endsWith("(left)"));
    assert.ok(m.every((x) => x.length === 5));
  }
  // spreadsheets run a formula that starts with = + - @
  const fake = Object.create(r.rig); // a rig whose body has one hostile dimension row
  Object.defineProperty(fake, "body", { value: { ...body, dims: [{ id: "x", label: "=HYPERLINK(1)", unit: "m", value: 1, status: "measured", via: [], formula: "=SUM(A1)" }] } });
  const evil = { ...input, rig: fake };
  assert.ok(readCSV(X.dimsCSV(evil))[1][6].startsWith("'="));
});

test("points CSV: the fallback of export.js is the file of the Skeleton tab (same columns, same numbers), and says what it holds", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[3]), mine = X.pointsCSV(input);
  const rows = readCSV(mine);
  assert.deepEqual(rows[0], [...X.POINT_COLUMNS]);
  assert.equal(rows.length - 1, 77 + Object.keys(r.rig.body.landmarks).length);
  assert.ok(rows.every((x) => x.length === 9));
  const S = await import("../../site/js/human/panels/skeleton.js").catch(() => null);
  if (S && typeof S.collectPoints === "function" && typeof S.pointsCSV === "function") assert.equal(mine, S.pointsCSV(S.collectPoints(r.rig)), "the two CSV writers must agree: change both or neither");
  assert.match(X.pointsCSV(input, { header: true }), /^# Joint centres and landmarks - Digital human export 1[^\n]*\n# Profile: [^\n]*\n# Posture: Arms raised \[t-arms-up\]\n# Units: millimetres\n/);
  const vertex = rows.find((x) => x[1] === "vertex"), w = r.rig.landmarkWorld("vertex");
  near(Number(vertex[7]), w.y * 1000, 0.06, "vertex height in mm");
});

// ============================================================================================================================ exchange JSON
test("exchange JSON: valid for every body and posture, coordinates agree with Kinematics, joint order and stature", () => {
  for (const { label, r, def } of CASES) {
    const input = setup(r, def), doc = X.buildExchange(input), res = X.validateExchange(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(res.errors, [], label); assert.equal(res.ok, true);
    assert.equal(doc.format, "human-exchange"); assert.equal(doc.version, 1); assert.equal(doc.units, "mm"); assert.deepEqual([doc.axes.up, doc.axes.front, doc.axes.left, doc.axes.handedness], ["+Y", "+Z", "+X", "right"]);
    assert.deepEqual(doc.body.joints.map((j) => j.id), JOINTS.map((j) => j.id));
    near(doc.body.stature_mm, r.rig.body.stature * 1000, 1e-3); near(doc.body.mass_kg, r.rig.body.mass, 1e-3);
    const kin = new Kinematics(r.rig.restOffsets).solve(r.rig.angles, r.rig.root), q = new THREE.Quaternion();
    for (const j of doc.body.joints) {
      const p = kin.position(j.id); near(j.position_mm[0], p.x * 1000, 1.1e-3, j.id); near(j.position_mm[1], p.y * 1000, 1.1e-3, j.id); near(j.position_mm[2], p.z * 1000, 1.1e-3, j.id);
      kin.quaternion(j.id, q); const s = q.w < 0 ? -1 : 1; assert.ok(new THREE.Quaternion(...j.orientation_xyzw).normalize().angleTo(new THREE.Quaternion(s * q.x, s * q.y, s * q.z, s * q.w)) < 1e-5, `${label}: orientation of ${j.id}`);
      assert.deepEqual(j.parent, JOINT_BY_ID[j.id].parent ?? null);
    }
    const lm = Object.fromEntries(doc.body.landmarks.map((l) => [l.id, l]));
    assert.equal(doc.body.landmarks.length, Object.keys(r.rig.body.landmarks).length);
    for (const id of ["vertex", "heel_sole_L", "pupil_R"]) { const w = r.rig.landmarkWorld(id); near(lm[id].position_mm[1], w.y * 1000, 1.1e-3, id); near(lm[id].position_mm[0], w.x * 1000, 1.1e-3, id); }
    if (def.id === "t-neutral") near(lm.vertex.position_mm[1], doc.body.stature_mm, 0.6, `${label}: the vertex is at stature standing on the floor`);
    assert.equal(doc.posture.id, def.id); near(doc.placement.root.y_mm, r.rig.root.y * 1000, 1e-3);
    assert.ok(Object.keys(doc.posture.angles).length > 0 || def.id === "t-neutral");
    assert.ok(Math.abs(doc.body.segments.reduce((s, x) => s + x.mass_kg, 0) - doc.body.mass_kg) < 0.05 * doc.body.mass_kg);
    assert.equal(doc.body.centre_of_mass.mass_kg > 10, true);
    if (r.name === "P50 man") assert.equal(doc.profile.measures.stature.unit, "mm");
  }
});

test("exchange JSON: the validator names what is wrong", () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]), good = X.buildExchange(input);
  const bad = (mut, re) => { const d = JSON.parse(JSON.stringify(good)); mut(d); const v = X.validateExchange(d); assert.equal(v.ok, false, String(re)); assert.ok(v.errors.some((e) => re.test(e)), `${re}: ${v.errors.join(" | ")}`); };
  assert.equal(X.validateExchange(JSON.stringify(good)).ok, true, "text is accepted");
  bad((d) => { d.format = "x"; }, /format must be/);
  bad((d) => { d.version = 2; }, /newer/);
  bad((d) => { d.version = "1"; }, /version must be/);
  bad((d) => { d.units = "m"; }, /units must be "mm"/);
  bad((d) => { d.axes.up = "+Z"; }, /axes must declare/);
  bad((d) => { delete d.axes; }, /axes must declare/);
  bad((d) => { d.profile.label = ""; }, /profile.label/);
  bad((d) => { d.profile.measures.stature.value = "tall"; }, /profile.measures.stature/);
  bad((d) => { d.body.stature_mm = 17; }, /stature_mm/);
  bad((d) => { [d.body.joints[3], d.body.joints[4]] = [d.body.joints[4], d.body.joints[3]]; }, /skeleton order/);
  bad((d) => { d.body.joints.pop(); }, /77 joints/);
  bad((d) => { d.body.joints[10].position_mm[1] = null; }, /position_mm/);
  bad((d) => { d.body.joints[10].position_mm[1] += 5; }, /rigid/);
  bad((d) => { d.body.joints[10].orientation_xyzw = [0, 0, 0, 2]; }, /unit quaternion/);
  bad((d) => { d.body.joints[20].dof.pop(); d.body.joints[20].dof.pop(); }, /dof must list/);
  bad((d) => { d.body.joints[20].dof[0].min_deg = 99999; }, /min <= max/);
  bad((d) => { d.body.landmarks[0].joint = "nope"; }, /unknown joint/);
  bad((d) => { d.body.landmarks.push(d.body.landmarks[0]); }, /twice/);
  bad((d) => { d.posture.angles.hip_L = { flex: "x" }; }, /posture.angles.hip_L/);
  bad((d) => { d.posture.angles.nope = { a: 1 }; }, /unknown joint "nope"/);
  bad((d) => { delete d.placement; }, /placement.root/);
  bad((d) => { d.scene.objects = [{ type: 1 }]; }, /scene.objects\[0\]/);
  bad((d) => { delete d.measurements; }, /measurements/);
  for (const nonsense of [null, 5, "{", [], "null", undefined]) { const v = X.validateExchange(nonsense); assert.equal(v.ok, false); assert.ok(v.errors.length > 0); }
  const w = JSON.parse(JSON.stringify(good)); w.body.stature_mm = 1100; assert.ok(X.validateExchange(w).warnings.some((m) => /outside the 1300 to 2500/.test(m)));
});

// ============================================================================================================================ posture files
test("posture file: round trip, library detection, custom postures, apply", async () => {
  const r = RIGS[1] ?? RIGS[0];
  for (const def of POSTURE_DEFS) {
    const input = setup(r, def), file = await X.buildPostureFile(input), parsed = await X.parsePostureFile(JSON.stringify(file));
    assert.equal(file.app, "digital-human-posture"); assert.equal(file.version, 1); assert.equal(file.posture.category, "Reference");
    assert.equal(parsed.ok, true, parsed.errors.join("; "));
    const now = r.rig.getPose();
    assert.ok(poseEquals(parsed.pose, { root: { heading: now.root.heading, flex: now.root.flex, lat: now.root.lat, rot: now.root.rot }, angles: now.angles }, 1e-4), `${def.id}: the file reproduces the pose`);
    // the custom Posture object alone (without the pose) expands to the same pose
    const alone = await X.parsePostureFile(JSON.stringify(file.posture));
    assert.equal(alone.ok, true, alone.errors.join("; "));
    assert.ok(poseEquals(alone.pose, parsed.pose, 1e-4), `${def.id}: the Posture object reproduces the pose too`);
    // apply it to a different pose and compare
    r.rig.resetPose();
    await X.applyPostureFile(r.rig, parsed);
    const after = r.rig.getPose();
    for (const [id, a] of Object.entries(parsed.pose.angles)) a.forEach((v, i) => near(after.angles[id][i], v, 1e-6, `${def.id} ${id}`));
    near(after.root.flex, parsed.pose.root.flex, 1e-9);
    assert.ok(after.root.y > 0.05, "placed above the floor");
  }
  // a library posture is recognised and written as it is
  const lib = await import("../../site/js/human/postures.js");
  const id = lib.POSTURES.find((p) => p.id === "iso-7250-sitting")?.id ?? lib.POSTURES[0].id, posture = lib.byId(id), x = expandPosture(posture);
  r.rig.setPose({ root: { ...placePose(r.rig.restBody, { root: x.root, angles: x.angles }, { posture }) }, angles: x.angles }, { clamp: true });
  const f = await X.buildPostureFile({ rig: r.rig, profile: r.profile, posture: { id, name: posture.name } });
  assert.equal(f.library_posture, true); assert.equal(f.posture.id, id); assert.deepEqual(f.posture.joints, JSON.parse(JSON.stringify(posture.joints)));
  r.rig.setAngles({ elbow_L: [30] });
  assert.equal((await X.buildPostureFile({ rig: r.rig, profile: r.profile, posture: { id, name: posture.name } })).library_posture, false, "edited since: written as a custom posture");
});

test("posture file: hostile and damaged input gives plain messages and never throws", async () => {
  const good = { app: "digital-human-posture", version: 1, pose: { root: { heading: 10 }, angles: { elbow_L: [90], knee_R: [30, 5] } } };
  const ok = await X.parsePostureFile(good); assert.equal(ok.ok, true); assert.deepEqual(ok.pose.angles.elbow_L, [90]); assert.equal(ok.pose.root.heading, 10);
  const cases = [
    [null, /JSON object/], [[], /JSON object/], [5, /JSON object/], ["", /not valid JSON/], ["{", /not valid JSON/], ["x".repeat(2_100_000), /too large/], [{}, /neither a posture file/],
    [{ app: "digital-human-scene", version: 1, objects: [] }, /not a posture file/], [{ app: "digital-human-posture" }, /version/], [{ ...good, version: 99 }, /newer version/], [{ ...good, version: 0 }, /version/],
    [{ ...good, pose: { angles: { nope: [1] } } }, /unknown joint "nope"/], [{ ...good, pose: { angles: { elbow_L: [NaN] } } }, /elbow_L must be one number/], [{ ...good, pose: { angles: { elbow_L: [1, 2] } } }, /elbow_L/],
    [{ ...good, pose: { angles: { elbow_L: "90" } } }, /elbow_L/], [{ ...good, pose: { angles: { elbow_L: [1e9] } } }, /elbow_L/], [{ ...good, pose: { root: { spin: 1 } } }, /not a root field/], [{ ...good, pose: { root: { heading: "x" } } }, /pose.root.heading/],
    [{ ...good, pose: { root: 5 } }, /pose.root must be an object/], [{ ...good, pose: { angles: [] } }, /pose.angles must be an object/], [JSON.parse('{"app":"digital-human-posture","version":1,"pose":{"angles":{"__proto__":[1]}}}'), /unknown joint "__proto__"/],
    [{ id: "x", name: "x", joints: { hip: [1] } }, /needs a side/], [{ id: "x", joints: { hip_LR: [1, 2, 3, 4] } }, /hip_LR/], [{ id: "x", joints: {}, root: { x: 1 } }, /no position/],
  ];
  for (const [input, re] of cases) { const p = await X.parsePostureFile(input); assert.equal(p.ok, false, String(re)); assert.ok(p.errors.some((e) => re.test(e)), `${re}: ${p.errors.join(" | ")}`); assert.ok(!p.pose); }
  // warnings, not errors
  const w = await X.parsePostureFile({ ...good, pose: { root: { x: 5, heading: 400 }, angles: { elbow_L: [999 - 800], shoulder_L: [500, 0, 0] } } });
  assert.equal(w.ok, true); assert.ok(w.warnings.some((m) => /root.x was ignored/.test(m)) && w.warnings.some((m) => /shoulder_L flex = 500/.test(m)), w.warnings.join(" | ")); assert.equal(w.pose.angles.shoulder_L[0], 180); assert.equal(w.pose.root.heading, 40);
  const lying = await X.parsePostureFile({ root: { flex: -90 }, angles: {} }); assert.equal(lying.ok, true); assert.equal(lying.support, "body");
  assert.equal((await X.parsePostureFile({ id: "x", name: "N", joints: { hip_LR: [90] }, support: "seat+feet" })).support, "seat+feet");
  assert.equal((await X.parsePostureFile({ id: "x", name: "N", joints: {}, support: "toString" })).support, "feet");
  await assert.rejects(() => X.applyPostureFile(RIGS[0].rig, { ok: false }), /no valid posture/);
  // what the file says about its support is checked once, at reading: a nonsense value never reaches the placement
  const odd = await X.parsePostureFile({ id: "x", name: "N", joints: { hip_LR: [90] }, support: "toString", hints: { seat: { height: -5 } } });
  assert.equal(odd.ok, true); assert.equal(odd.support, "feet"); assert.equal(odd.seatHeight, null);
  await X.applyPostureFile(RIGS[0].rig, odd);
  const seated = await X.parsePostureFile({ id: "x", name: "N", support: "seat+feet", joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0] }, hints: { seat: { height: 0.5 } } });
  assert.equal(seated.seatHeight, 0.5);
  await X.applyPostureFile(RIGS[0].rig, seated);
  near(Math.min(...RIGS[0].rig.contactPoints("seat").map((v) => v.y)), 0.5, 1e-6, "the seat height of the file is the plane the figure sits on");
});

// ============================================================================================================================ scene file, summary, images, estimates
test("scene file text and summary text", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]);
  const { sandbox, ctx, viewport } = sceneFixture(r.rig, [["monitor", { position: [0, 0.74, 1.2], yaw: 180, name: "Main display" }], ["crate", { position: [1, 0, 0] }]]);
  const text = X.sceneFileText(sandbox), data = JSON.parse(text);
  assert.equal(data.app, "digital-human-scene"); assert.equal(data.objects.length, 2);
  const again = sandbox.fromJSON(text); assert.equal(again.ok, true); assert.equal(sandbox.objects.size, 2);
  assert.throws(() => X.sceneFileText(null), /no scene yet/);
  const measure = createMeasure({ viewport, ctx, sandbox });
  measure.addHeight({ kind: "landmark", id: "vertex" }, { label: "Head height" });
  const s = X.summaryText({ ...input, sandbox, measurements: measure.exportRows() }, await X.metricRows(input));
  for (const re of [/DIGITAL HUMAN SUMMARY/, new RegExp(r.profile.label.replace(/[()]/g, "\\$&")), /Posture: Seated 90-90-90 \[t-sitting\]/, /Stature [\d,]+ mm/, /Scene \(2 objects\): Main display, /, /Head height: [\d,]+ mm/, /Units: millimetres, kilograms, degrees\. Axes: \+Y up/, /Largest joint angles/, /Hip included angle/]) assert.match(s, re);
  assert.ok(s.split("\n").length < 40, "short");
  assert.ok(!/NaN|undefined|null|-0 /.test(s), s);
  const neutral = setup(r, POSTURE_DEFS[0]); assert.match(X.summaryText(neutral), /All joint angles are 0/);
  sandbox.dispose(); measure.dispose();
});

test("matteFromPair recovers colour and alpha from a render over black and over white", () => {
  const px = [[200, 100, 50, 255], [200, 100, 50, 128], [10, 240, 90, 64], [0, 0, 0, 0], [255, 255, 255, 255], [30, 30, 30, 200]];
  const black = [], white = [];
  for (const [r, g, b, a] of px) { for (const bg of [0, 255]) { const t = a / 255; (bg ? white : black).push(...[r, g, b].map((c) => Math.round(c * t + bg * (1 - t))), 255); } }
  const out = X.matteFromPair(Uint8ClampedArray.from(black), Uint8ClampedArray.from(white));
  px.forEach(([r, g, b, a], i) => { near(out[4 * i + 3], a, 2, `alpha ${i}`); if (a > 40) for (const [k, v] of [r, g, b].entries()) near(out[4 * i + k], v, 10, `colour ${i}.${k}`); });
  assert.deepEqual([...out.slice(12, 16)], [0, 0, 0, 0], "a fully transparent pixel stays 0,0,0,0");
  assert.throws(() => X.matteFromPair(new Uint8ClampedArray(8), new Uint8ClampedArray(4)), /same size/);
});

test("size estimates are within 30 % of the real files", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]), est = X.estimateSizes(input);
  const real = { glbSkin: (await X.buildGLB(input)).bytes, glbSkeleton: (await X.buildGLB(input, { figure: "skeleton" })).bytes, obj: (await X.buildOBJ(input)).bytes, stl: (await X.buildSTL(input)).bytes, bvh: X.buildBVH(input, { neutralFrame: true }).bytes, json: X.exchangeText(input).length };
  for (const [k, v] of Object.entries(real)) assert.ok(Math.abs(est[k] - v) / v < 0.3, `${k}: estimated ${est[k]}, real ${v}`);
  assert.equal(X.formatBytes(512), "512 B"); assert.equal(X.formatBytes(2048), "2.0 kB"); assert.equal(X.formatBytes(1.5 * 1048576), "1.5 MB");
});

// ============================================================================================================================ determinism and safety
test("the same figure gives the same bytes every time, and nothing is sent anywhere", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[2]);
  const hash = (b) => Buffer.from(b).toString("base64");
  assert.equal(hash((await X.buildGLB(input)).data), hash((await X.buildGLB(input)).data));
  assert.equal(hash((await X.buildGLB(input, { pose: "clip" })).data), hash((await X.buildGLB(input, { pose: "clip" })).data));
  assert.equal((await X.buildOBJ(input)).text, (await X.buildOBJ(input)).text);
  assert.equal(hash((await X.buildSTL(input)).data), hash((await X.buildSTL(input)).data));
  assert.equal(X.buildBVH(input, { neutralFrame: true }).text, X.buildBVH(input, { neutralFrame: true }).text);
  assert.equal(X.exchangeText(input), X.exchangeText(input));
  assert.equal(X.anglesCSV(input), X.anglesCSV(input));
  assert.equal(JSON.stringify(await X.buildPostureFile(input)), JSON.stringify(await X.buildPostureFile(input)));
  assert.notEqual(X.exchangeText(input, { created: "2026-01-01" }), X.exchangeText(input), "a date is only written when asked for");
  const src = fs.readFileSync(path.join(ROOT, "site/js/human/export.js"), "utf8");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|document\.|window\./.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "export.js neither touches the DOM nor the network");
});

test("the tick callback is awaited between the steps of a GLB", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]), steps = [];
  await X.buildGLB(input, { tick: async (t) => { steps.push(t); await new Promise((res) => setTimeout(res, 1)); } });
  assert.ok(steps.length >= 3 && steps.every((s) => typeof s === "string" && s.length > 3), steps.join(", "));
});

// ============================================================================================================================ regressions of the verifier
test("GLB: the pose changes while the page breathes (every tick): the file still holds ONE pose, baked and as a clip", { timeout: 120000 }, async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]), defs = [POSTURE_DEFS[2], POSTURE_DEFS[3], POSTURE_DEFS[4], POSTURE_DEFS[1]];
  for (const mode of ["baked", "clip"]) {
    setup(r, POSTURE_DEFS[0]);
    let n = 0, atWrite = null;
    const out = await X.buildGLB(input, { pose: mode, tick: async (t) => {
      if (t === "Writing the GLB") atWrite = new Map(X.skinnedMeshes(r.rig).map((m) => [m.name, rigVertices(r.rig, m)])); // what the live rig draws when the last tick starts
      await Promise.resolve();
      setup(r, defs[n++ % defs.length]); // a drag in the 3D view: the pose differs after every tick
    } });
    assert.ok(n >= 3, `${n} ticks`);
    const g = readGLB(out.data), idx = glbChecks(g, input, mode), override = new Map();
    if (mode === "clip") {
      const anim = g.json.animations[0];
      for (const ch of anim.channels) {
        const v = readAccessor(g, anim.samplers[ch.sampler].output).data, o = override.get(ch.target.node) ?? {};
        if (ch.target.path === "rotation") o.r = new THREE.Quaternion(...v); else o.t = new THREE.Vector3(...v);
        override.set(ch.target.node, o);
      }
    }
    for (const mi of g.json.nodes.map((nd, i) => (nd.mesh !== undefined ? i : -1)).filter((i) => i >= 0)) {
      const name = g.json.nodes[mi].name, d = maxDiff(skinFromGLB(g, mi, override), atWrite.get(name));
      assert.ok(d < 2e-6, `${mode} ${name}: the mesh and the pose of the nodes disagree by ${d} m`);
    }
    if (mode === "baked") { // skeleton nodes = the pose the mesh has, and the inverse bind matrices fit them
      const w = worldMatrices(g.json);
      const sk = g.json.skins[0], ibm = readAccessor(g, sk.inverseBindMatrices).data;
      for (let k = 0; k < 77; k++) { const m = w.get(sk.joints[k]).clone().multiply(new THREE.Matrix4().fromArray(ibm, 16 * k)).elements; for (let c = 0; c < 16; c++) near(m[c], c % 5 === 0 ? 1 : 0, 1e-5, "baked bind pose"); }
    }
  }
});

test("GLB: scene objects that move while the page breathes are written where they are after the last tick", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]), { sandbox } = sceneFixture(r.rig, [["crate", { position: [0, 0, 1] }]]);
  const obj = [...sandbox.objects.values()][0];
  const out = await X.buildGLB({ ...input, sandbox }, { scene: true, tick: async (t) => { await Promise.resolve(); if (t === "Adding the scene objects") { obj.group.position.set(1, 0, 2); obj.group.updateMatrixWorld(true); } } });
  const g = readGLB(out.data), node = g.json.nodes.find((nd) => nd.extras?.digitalHuman?.type === "crate");
  assert.deepEqual(node.translation.map((v) => Math.round(v * 1e4) / 1e4), [1, 0, 2]);
  sandbox.dispose();
});

test("OBJ: written in pieces (the page breathes between them) it is byte for byte what one OBJExporter call writes", { timeout: 120000 }, async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[1]);
  const types = ["crate", "monitor", "stool", "pallet", "ladder", "rifle", "desk", "steering_wheel"];
  const { sandbox } = sceneFixture(r.rig, Array.from({ length: 60 }, (_, i) => [types[i % types.length], { position: [(i % 10) * 1.5 - 7, 0, Math.floor(i / 10) * 1.5 + 2] }]));
  const root = new THREE.Group(), scene = new THREE.Group();
  scene.name = "scene";
  for (const s of X.bakeSkin(r.rig)) { const m = new THREE.Mesh(s.geometry, new THREE.MeshBasicMaterial({ name: s.name })); m.name = s.name; root.add(m); }
  for (const o of X.visibleObjects(sandbox)) { const node = new THREE.Group(); node.name = o.name; o.group.updateWorldMatrix(true, true); o.group.matrixWorld.decompose(node.position, node.quaternion, node.scale); const c = o.model.clone(true); c.traverse((x) => { if (x.isMesh) x.name = `${o.name} (mesh)`; }); node.add(c); scene.add(node); }
  // a line object and an object with texture coordinates exercise the l lines and the vt indices
  const withUv = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()); withUv.name = "plane";
  const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial()); line.name = "segs";
  const g2 = new THREE.Group(); g2.add(withUv, line); scene.add(g2);
  root.add(scene);
  root.updateMatrixWorld(true);
  const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js"), whole = new OBJExporter().parse(root);
  let breaths = 0;
  const pieces = await X.objChunks(root, async () => { breaths++; await new Promise((res) => setTimeout(res, 0)); }, -1);
  assert.ok(breaths >= 60, `${breaths} breaths`); // one after every piece but the last
  assert.equal(pieces.parts.join(""), whole);
  assert.equal(pieces.bytes, new TextEncoder().encode(whole).length);
  assert.ok(whole.length > 2e6, "a real scene");
  // the same through buildOBJ with a tick: it breathes more than once for a big scene, and its faces are valid for the file's own vertex and normal counts
  const ticks = [], out = await X.buildOBJ({ ...input, sandbox }, { scene: true, tick: async (t) => { ticks.push(t); } }), o = readOBJ(out.text);
  assert.ok(ticks.length >= 1 && ticks[0] === "Writing the OBJ", ticks.join(" | "));
  assert.equal(o.v.length, out.stats.vertices);
  assert.ok(o.faces.every((f) => f.every(([a, , c]) => a >= 1 && a <= o.v.length && c >= 1 && c <= o.vn.length)));
  assert.equal(out.bytes, new TextEncoder().encode(out.text).length);
  sandbox.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------------- labels must describe the content (round 6)
test("posture label: a figure that has left the posture the shell names is called a custom pose, in every file", async () => {
  const r = RIGS[1] ?? RIGS[0];
  const neutral = { id: null, name: "Neutral standing" };
  r.rig.resetPose();
  // still neutral: the shell's name is kept (and a turned figure is still standing neutrally)
  assert.deepEqual(X.effectivePosture(neutral, r.rig), neutral);
  r.rig.setPose({ root: { x: 0, y: r.rig.root.y, z: 0, heading: 40, flex: 0, lat: 0, rot: 0 }, angles: {} }, { clamp: true });
  assert.equal(X.effectivePosture(neutral, r.rig).edited, undefined, "heading is not part of a posture name");
  r.rig.resetPose();
  // seated pose, shell never told
  const seated = setup(r, POSTURE_DEFS[1], { posture: neutral });
  const eff = X.effectivePosture(seated.posture, r.rig);
  assert.deepEqual(eff, { id: null, name: "Custom pose", edited: true, basedOn: { id: null, name: "Neutral standing" } });
  assert.equal(X.exportFileName({ profile: r.profile, posture: eff, what: "figure", ext: "glb" }).includes("neutral"), false);
  assert.match(X.exportFileName({ profile: r.profile, posture: eff, what: "figure", ext: "glb" }), /_custom-pose_figure\.glb$/);
  const sum = X.summaryText(seated);
  assert.match(sum, /Posture: Custom pose \(edited from Neutral standing\)/); assert.doesNotMatch(sum, /Posture: Neutral standing/);
  const ex = X.buildExchange(seated);
  assert.equal(ex.posture.name, "Custom pose"); assert.equal(ex.posture.library, false); assert.deepEqual(ex.posture.edited_from, { id: null, name: "Neutral standing" });
  assert.equal(X.validateExchange(ex).ok, true);
  assert.match((await X.buildOBJ(seated)).text, /# Posture: Custom pose \(edited from Neutral standing\)/);
  const stl = new TextDecoder().decode(new Uint8Array((await X.buildSTL(seated)).data, 0, 80)); assert.match(stl, /Custom pose/); assert.doesNotMatch(stl, /Neutral/);
  assert.match(X.buildBVH(seated, { header: true }).text, /# Posture: Custom pose \(edited from Neutral standing\)/);
  assert.match(X.anglesCSV(seated, { header: true }), /# Posture: Custom pose/);
  const glb = await X.buildGLB(seated), extras = readGLB(glb.data).json.asset.extras;
  assert.equal(extras.posture.name, "Custom pose"); assert.deepEqual(extras.posture.edited_from, { id: null, name: "Neutral standing" }); assert.equal(glb.posture.name, "Custom pose");
  const pf = await X.buildPostureFile(seated);
  assert.equal(pf.library_posture, false); assert.equal(pf.posture.id, "custom-pose"); assert.deepEqual(pf.shell.edited_from, { id: null, name: "Neutral standing" });
  // a library posture the figure is still in keeps its name; one edited since does not; an unknown id (cannot be checked) is trusted
  const lib = await import("../../site/js/human/postures.js"), posture = lib.byId("iso-7250-sitting") ?? lib.POSTURES[0], x = expandPosture(posture);
  r.rig.setPose({ root: { ...placePose(r.rig.restBody, { root: x.root, angles: x.angles }, { posture }) }, angles: x.angles }, { clamp: true });
  const named = { id: posture.id, name: posture.name };
  assert.deepEqual(X.effectivePosture(named, r.rig), named);
  assert.equal((await X.buildExchange({ rig: r.rig, profile: r.profile, posture: named })).posture.library, true);
  r.rig.setAngles({ elbow_L: [30] });
  assert.equal(X.effectivePosture(named, r.rig).edited, true);
  assert.deepEqual(X.effectivePosture({ id: "t-whatever", name: "Whatever" }, r.rig), { id: "t-whatever", name: "Whatever" });
  // posture.pose: the pose the name was given to
  const was = JSON.parse(JSON.stringify(r.rig.getPose()));
  assert.equal(X.effectivePosture({ id: "custom-x", name: "X", pose: was }, r.rig).edited, undefined);
  r.rig.setAngles({ elbow_R: [20] });
  assert.equal(X.effectivePosture({ id: "custom-x", name: "X", pose: was }, r.rig).edited, true);
  r.rig.resetPose();
});

test("exchange posture.library is true only for ids of the library; a custom posture keeps its id when saved again", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[0]);
  assert.equal(X.buildExchange({ ...input, posture: { id: "custom-foo", name: "Foo" } }).posture.library, false);
  assert.equal(X.buildExchange({ ...input, posture: { id: "nonsense", name: "?" } }).posture.library, false);
  let posture = { id: "custom-foo", name: "Foo" };
  for (let i = 0; i < 3; i++) { // save, load, save ...
    const file = await X.buildPostureFile({ ...input, posture }), parsed = await X.parsePostureFile(JSON.stringify(file));
    assert.equal(file.posture.id, "custom-foo", `cycle ${i}`); assert.equal(parsed.ok, true);
    posture = { id: parsed.id, name: parsed.name };
  }
  assert.equal((await X.buildPostureFile({ ...input, posture: { id: null, name: "Reach to the left" } })).posture.id, "custom-reach-to-the-left");
  assert.equal((await X.buildPostureFile({ ...input, posture: { id: "custom", name: "x" } })).posture.id, "custom");
});

test("the profile of a file is the one the rig was built from, not the one the shell holds now", () => {
  const r = RIGS[1] ?? RIGS[0], other = { ...RIGS[0].profile, id: "other:1", label: "Somebody else" }, id = r.rig.body.profileId;
  assert.equal(id, r.profile.id);
  assert.equal(X.profileOf(r.rig, [other, r.profile]), r.profile, "found by id among the candidates");
  assert.equal(X.profileOf(r.rig, [r.profile, other]), r.profile);
  const d = X.profileOf(r.rig, [other]);
  assert.equal(d.id, id); assert.equal(d.label, r.rig.body.label); assert.deepEqual(d.measures, {}); assert.equal(d.source, null);
  assert.equal(X.profileOf(r.rig).label, r.rig.body.label);
  const gen = { ...r.rig, body: { ...r.rig.body, synthetic: true, profileId: "generic:male:1750", label: "Generic male body, 1750 mm" } };
  assert.equal(X.profileOf(gen, [{ id: "generic:male:1750", label: "x" }]).label, "Generic male body, 1750 mm", "a generic body is described by itself");
  // the exchange file of a rig with the wrong profile object next to it says what the rig is
  const doc = X.buildExchange({ rig: r.rig, profile: X.profileOf(r.rig, [other]), posture: { id: null, name: "Neutral standing" } });
  assert.equal(doc.profile.label, r.rig.body.label); assert.equal(doc.profile.id, id); assert.equal(X.validateExchange(doc).ok, true);
});

test("GLB: a figure replaced while the page breathed gives a message that says so (OBJ and STL read the rig before their first breath)", async () => {
  const r = RIGS[0], fresh = () => { const rig = buildRig(fitBody(r.profile, {}), { skinBuilder: buildSkin }); return { rig, input: { rig, profile: r.profile, posture: { id: null, name: "Neutral standing" } } }; };
  const g = fresh();
  await assert.rejects(() => X.buildGLB(g.input, { tick: async () => { g.rig.dispose(); } }), (e) => /replaced while the file was being made/.test(e.message) && !/no skin/.test(e.message));
  const o = fresh(), obj = await X.buildOBJ(o.input, { tick: async () => { o.rig.dispose(); } });
  const s = fresh(), stl = await X.buildSTL(s.input, { tick: async () => { s.rig.dispose(); } });
  assert.ok(obj.stats.vertices > 5000 && stl.triangles > 5000, "the pose was read before the rig was gone: one consistent file");
});

test("exchange scene objects carry their world orientation (an attached object with orient follows pitch and roll of its joint)", async () => {
  const r = RIGS[1] ?? RIGS[0], input = setup(r, POSTURE_DEFS[3]), { sandbox, ctx } = sceneFixture(r.rig);
  const a = sandbox.add("box", { position: [0.5, 1, 0.5], yaw: 30 }), b = sandbox.add("crate", { position: [0, 0.5, 1], yaw: 10 });
  sandbox.attach(a.id, { kind: "joint", id: "wrist_R" }, [0, 0, 0.05], { local: true, orient: true });
  ctx.emit("pose", { rig: r.rig });
  await new Promise((res) => setTimeout(res, 30));
  const doc = X.buildExchange({ ...input, sandbox }), qOf = (o) => { const q = new THREE.Quaternion(); o.group.updateWorldMatrix(true, false); o.group.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; };
  for (const o of sandbox.objects.values()) {
    const d = doc.scene.objects.find((x) => x.id === String(o.id)), q = qOf(o), e = new THREE.Quaternion(...d.orientation_xyzw);
    assert.ok(Math.abs(q.dot(e)) > 1 - 1e-6, `${o.type}: orientation_xyzw is the world rotation`);
    assert.ok(d.orientation_xyzw[3] >= 0 && Math.abs(Math.hypot(...d.orientation_xyzw) - 1) < 1e-6);
  }
  const att = doc.scene.objects.find((x) => x.id === String(a.id)), plain = doc.scene.objects.find((x) => x.id === String(b.id));
  const flat = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...att.orientation_xyzw), "YXZ");
  assert.ok(Math.abs(flat.x) > 0.05 || Math.abs(flat.z) > 0.05, "pitch or roll survives; yaw_deg alone could not say it");
  assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...plain.orientation_xyzw), "YXZ").y * 180 / Math.PI - plain.yaw_deg) < 0.01, "an unattached object: the quaternion is its yaw");
  assert.equal(X.validateExchange(doc).ok, true);
  const bad = JSON.parse(JSON.stringify(doc)); bad.scene.objects[0].orientation_xyzw = [0, 0, 0, 2];
  assert.match(X.validateExchange(bad).errors.join(" "), /orientation_xyzw/);
  sandbox.dispose();
});

test("posture file: an angle beyond 3600 degrees is named as such, not as a wrong count", async () => {
  const p = await X.parsePostureFile({ app: "digital-human-posture", version: 1, pose: { angles: { knee_L: [9999] } } });
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /knee_L.*more than 3600 degrees.*9999/); assert.doesNotMatch(p.errors[0], /up to 2 numbers/);
  const q = await X.parsePostureFile({ app: "digital-human-posture", version: 1, pose: { angles: { knee_L: [10, 20, 30] } } });
  assert.match(q.errors[0], /one number|up to/);
});
