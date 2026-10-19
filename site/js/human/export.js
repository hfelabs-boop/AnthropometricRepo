// Export formats of the Digital human tab: GLB, OBJ, STL, BVH, tables (CSV / JSON), the "human-exchange" JSON, posture files and a plain-text summary.
// Pure: imports three, skeleton.js and util.js (toCSV) and, lazily, the GLTF / OBJ / STL exporters of three.js, pose.js, postures.js and metrics.js; it never
// touches document or window, so everything here runs in Node (tests/human3d/export.test.mjs). The panel (panels/export.js) adds downloads, options and the PNG images.
// Manual: docs/human3d/EXPORT.md (formats, units, axes, how to import them, what could not be tested).
//
// Conventions: the model is in metres, +Y up, +Z in front of the figure, +X the figure's LEFT, floor at y = 0 (DESIGN.md). glTF uses the same axes and metres.
// OBJ / STL offer millimetres (default) or metres and three axis systems; tables and the exchange JSON are in millimetres and degrees; BVH offers cm / mm / m.
// Every function takes `input = { rig, profile?, posture?, sandbox?, measurements? }`: the Rig of rig.js, the Profile of anthro.js, `posture` = { id, name } of the
// shell (state.posture), the Sandbox of sandbox.js (peekSandbox(ctx)) and the rows of measure.exportRows(). Nothing is read from anywhere else, nothing is sent anywhere.
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, CHILDREN, GROUPS, ROOT_DOF, BONES } from "./skeleton.js";
import { toCSV } from "../util.js";

export const EXPORT_VERSION = 1;
export const GENERATOR = `Digital human export ${EXPORT_VERSION} (Military Anthropometry site; three.js r${THREE.REVISION})`;
export const AXES_NOTE = "right-handed; +Y up, the figure faces +Z, +X is the figure's left, floor at y = 0";
export const MODEL_NOTE = "Simplified kinematic and anthropometric visualisation: rigid links, approximate joint centres and ranges of motion, no soft-tissue model.";
export const EXCHANGE_FORMAT = "human-exchange";
export const POSTURE_APP = "digital-human-posture";
export const MAX_POSTURE_TEXT = 2_000_000; // characters accepted from a posture file

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const nz = (x) => (x === 0 ? 0 : x);
/** Round to `d` decimals; never returns -0. */
export const rnd = (v, d = 3) => { const k = 10 ** d; return nz(Math.round(v * k) / k); };
const mm3 = (m) => rnd(m * 1000, 3);
const vmm = (v) => [mm3(v.x), mm3(v.y), mm3(v.z)];
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));
/** ASCII-only single line, for file headers and comments (OBJ, BVH, STL): accents are dropped, anything else outside ASCII becomes "-". */
export const ascii = (s, max = 200) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "-").trim().slice(0, max);
/** A name safe for a node / object name: no control characters, at most 60 characters. */
const cleanName = (s, fallback = "object") => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;

// ---------------------------------------------------------------------------------------------------------------------
// names of files
/** Lower-case a-z0-9 words joined by "-": "United States · Army · men · P50" -> "united-states-army-men-p50". "" when nothing is left (Chinese, emoji, ...). */
export function slug(text, max = 40) {
  let s = String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/-+$/, "");
  return s;
}
/** The posture part of a file name: the library id, else the slug of its name, else "pose". */
export const postureSlug = (posture) => slug(posture?.id, 40) || slug(posture?.name, 40) || "pose";
/**
 * "<profile-slug>_<posture-id>_<what>.<ext>", e.g. united-states-army-men-p50_stand-relaxed_figure.glb. The pieces are slugs, so the name is safe on
 * every file system (no spaces, slashes or dots except the extension); an empty profile becomes "figure"; the whole name stays under 125 characters.
 */
export function exportFileName({ profile, posture, what = "", ext, suffix = "" } = {}) {
  const parts = [slug(profile?.label, 44) || slug(profile?.id, 44) || "figure", postureSlug(posture)];
  const w = slug(what, 20), s = slug(suffix, 8);
  if (w) parts.push(w);
  if (s) parts.push(s);
  return `${parts.join("_")}.${String(ext).replace(/[^a-z0-9]/gi, "").toLowerCase() || "dat"}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// axes and units of the mesh formats
/** Length units of OBJ / STL / BVH: factor from metres. */
export const UNIT_SCALE = Object.freeze({ m: 1, cm: 100, mm: 1000 });
export const UNIT_NAME = Object.freeze({ m: "metres", cm: "centimetres", mm: "millimetres" });
/**
 * Axis systems for OBJ and STL. `m` maps the model's (x left, y up, z front) to the file's (x, y, z): row-major 3 x 3, always a proper rotation (the
 * winding of the triangles is kept). "y-up" is the model itself (as in glTF; Blender's OBJ importer takes it upright with its defaults); "z-up" is Blender's own and the CAD usual
 * (up = +Z, the figure looks along -Y, its left is +X); "x-front" is the vehicle / SAE J670 system (X forward, Y left, Z up).
 */
export const AXES = Object.freeze({
  "y-up": { label: "Y up, front +Z (app, glTF)", up: "+Y", front: "+Z", left: "+X", m: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  "z-up": { label: "Z up, front -Y (Blender, CAD)", up: "+Z", front: "-Y", left: "+X", m: [1, 0, 0, 0, 0, -1, 0, 1, 0] },
  "x-front": { label: "X front, Y left, Z up (SAE)", up: "+Z", front: "+X", left: "+Y", m: [0, 0, 1, 1, 0, 0, 0, 1, 0] },
});
/** Matrix4 that turns model coordinates (metres) into file coordinates: axis system `axes`, then `scale`. */
export function axesMatrix(axes = "y-up", scale = 1) {
  const a = Object.hasOwn(AXES, axes) ? AXES[axes] : null;
  if (!a) throw new RangeError(`Unknown axis system "${axes}" (use ${Object.keys(AXES).join(", ")}).`);
  const m = a.m.map((v) => v * scale);
  return new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
}
function unitOf(unit, allowed) {
  if (!Object.hasOwn(UNIT_SCALE, unit) || !allowed.includes(unit)) throw new RangeError(`Unknown unit "${unit}" (use ${allowed.join(", ")}).`);
  return UNIT_SCALE[unit];
}

// ---------------------------------------------------------------------------------------------------------------------
// the figure and what describes it
function need(input) {
  const rig = input?.rig;
  if (!rig || typeof rig.getPose !== "function" || !rig.bones) throw new Error("There is no figure to export yet. Wait for the model to finish building.");
  return { rig, body: rig.body, profile: input.profile ?? null, posture: input.posture ?? null, sandbox: input.sandbox ?? null, measurements: Array.isArray(input.measurements) ? input.measurements : null };
}
const tickOf = (o) => (typeof o?.tick === "function" ? o.tick : async () => {});
/** Who made the file, for what: the part every export states about itself. */
function provenance({ profile, posture }, created) {
  return {
    format_version: EXPORT_VERSION, generator: GENERATOR, ...(created ? { created: String(created) } : {}),
    profile: { id: profile?.id ?? null, label: profile?.label ?? null, sex: profile?.sex ?? null },
    posture: { id: posture?.id ?? null, name: posture?.name ?? null },
    note: MODEL_NOTE,
  };
}
const profileLine = (p) => p?.label || "unknown profile";
const postureLine = (q) => (q?.name || q?.id ? `${q.name ?? q.id}${q.id && q.name && q.id !== q.name ? ` [${q.id}]` : ""}` : "custom posture");

// ---------------------------------------------------------------------------------------------------------------------
// skin: the SkinnedMeshes of the rig, posed on the CPU
/** The skinned meshes of the rig's skin (the skin itself and the eyes), in scene order. */
export function skinnedMeshes(rig) {
  const out = [];
  rig.skin?.traverse?.((o) => { if (o.isSkinnedMesh && o.geometry?.getAttribute?.("position") && o.skeleton) out.push(o); });
  return out;
}
const dense = (attr, n) => { // plain typed array of an attribute (also interleaved ones) with itemSize components per vertex
  if (!attr) return null;
  const k = attr.itemSize, out = new Float64Array(attr.count * k);
  for (let i = 0; i < attr.count; i++) { out[i * k] = attr.getX(i); if (k > 1) out[i * k + 1] = attr.getY(i); if (k > 2) out[i * k + 2] = attr.getZ(i); if (k > 3) out[i * k + 3] = attr.getW(i); }
  return n && k !== n ? null : out;
};
/** Skinning matrices of a mesh in the CURRENT pose of its bones, column-major, one 4 x 4 per bone: world = matrixWorld * bindInverse * (bone.matrixWorld * boneInverse) * bind. */
function skinTable(mesh) {
  const sk = mesh.skeleton, n = sk.bones.length, out = new Float64Array(16 * n), M = new THREE.Matrix4(), T = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    T.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]);
    M.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(T).multiply(mesh.bindMatrix);
    M.toArray(out, 16 * i);
  }
  return out;
}
/**
 * Pose a skinned mesh: world positions and normals of every vertex for the bones as they are now (what the GPU draws; the test compares it with
 * three.js's own applyBoneTransform). Returns { position: Float32Array, normal: Float32Array | null }. `S` = a skinTable.
 */
function poseVertices(mesh, S) {
  const g = mesh.geometry, P = dense(g.getAttribute("position"), 3), N = dense(g.getAttribute("normal"), 3), SI = dense(g.getAttribute("skinIndex"), 4), SW = dense(g.getAttribute("skinWeight"), 4);
  if (!P || !SI || !SW) throw new Error("The skin has no bone weights, so it cannot be posed.");
  const n = P.length / 3, pos = new Float32Array(3 * n), nor = N ? new Float32Array(3 * n) : null;
  for (let v = 0; v < n; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    const nx = N ? N[3 * v] : 0, ny = N ? N[3 * v + 1] : 0, nzz = N ? N[3 * v + 2] : 0;
    for (let k = 0; k < 4; k++) {
      const w = SW[4 * v + k];
      if (w === 0) continue;
      const m = 16 * SI[4 * v + k];
      ax += w * (S[m] * x + S[m + 4] * y + S[m + 8] * z + S[m + 12]);
      ay += w * (S[m + 1] * x + S[m + 5] * y + S[m + 9] * z + S[m + 13]);
      az += w * (S[m + 2] * x + S[m + 6] * y + S[m + 10] * z + S[m + 14]);
      if (N) { bx += w * (S[m] * nx + S[m + 4] * ny + S[m + 8] * nzz); by += w * (S[m + 1] * nx + S[m + 5] * ny + S[m + 9] * nzz); bz += w * (S[m + 2] * nx + S[m + 6] * ny + S[m + 10] * nzz); }
    }
    pos[3 * v] = ax; pos[3 * v + 1] = ay; pos[3 * v + 2] = az;
    if (nor) { const l = Math.hypot(bx, by, bz) || 1; nor[3 * v] = bx / l; nor[3 * v + 1] = by / l; nor[3 * v + 2] = bz / l; }
  }
  return { position: pos, normal: nor };
}
function indexOf(g, n) {
  const ix = g.getIndex();
  if (!ix) return null;
  return (n > 65535 ? Uint32Array : Uint16Array).from(ix.array);
}
/**
 * The skin in the pose the rig is in now, as static meshes in WORLD space: [{ name, geometry (position, normal, colour, index; no bones), material }].
 * `skin` of rig.js is untouched. This is the geometry of OBJ, STL and "pose baked in" GLB.
 */
export function bakeSkin(rig) {
  rig.group.updateMatrixWorld(true);
  return skinnedMeshes(rig).map((mesh) => {
    const { position, normal } = poseVertices(mesh, skinTable(mesh));
    const g = new THREE.BufferGeometry(), n = position.length / 3;
    g.setAttribute("position", new THREE.BufferAttribute(position, 3));
    if (normal) g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    const col = mesh.geometry.getAttribute("color");
    if (col) g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(dense(col, 3) ?? []), 3));
    const ix = indexOf(mesh.geometry, n);
    if (ix) g.setIndex(new THREE.BufferAttribute(ix, 1));
    return { name: cleanName(mesh.name, "skin"), geometry: g, material: mesh.material, vertices: n, triangles: ix ? ix.length / 3 : n / 3 };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// the sandbox objects as plain data and as meshes
/** Objects of the sandbox that are visible: [{ id, type, name, params, color, locked, visible, position (m), yaw, attachedTo, group, model }]. */
export function visibleObjects(sandbox) {
  const out = [];
  if (!sandbox?.objects || typeof sandbox.objects.values !== "function") return out;
  for (const o of sandbox.objects.values()) if (o && o.visible !== false && o.group && o.model) out.push(o);
  return out;
}
/** The scene as data for the exchange JSON: positions in millimetres. */
export function sceneInfo(sandbox) {
  const objects = [...(sandbox?.objects?.values?.() ?? [])].map((o) => ({
    id: String(o.id), type: o.type, name: cleanName(o.name), params: JSON.parse(JSON.stringify(o.params ?? {})), color: o.color ?? null, locked: !!o.locked, visible: o.visible !== false,
    position_mm: (o.position ?? [0, 0, 0]).map(mm3), yaw_deg: rnd(o.yaw ?? 0, 3), attachedTo: o.attachedTo ? JSON.parse(JSON.stringify(o.attachedTo)) : null,
  }));
  return { count: objects.length, objects };
}
/**
 * Clones of the visible objects as one Group per object (node name = object name, made unique and never a joint id; `userData.digitalHuman` = type,
 * parameters, id ...), with the object's current world transform. Geometry and materials are shared with the sandbox (nothing is copied or disposed).
 */
function objectNodes(sandbox, taken) {
  const root = new THREE.Group();
  root.name = "scene";
  const used = new Set(taken);
  let skipped = 0;
  for (const o of visibleObjects(sandbox)) {
    o.group.updateWorldMatrix(true, true);
    if (!o.group.matrixWorld.elements.every(Number.isFinite)) { skipped++; continue; }
    let name = cleanName(o.name, o.type), base = name, n = 2;
    while (used.has(name) || JOINT_BY_ID[name]) name = `${base} ${n++}`;
    used.add(name);
    const node = new THREE.Group();
    node.name = name;
    o.group.matrixWorld.decompose(node.position, node.quaternion, node.scale);
    node.userData = { digitalHuman: { id: String(o.id), type: o.type, name: cleanName(o.name), params: JSON.parse(JSON.stringify(o.params ?? {})), color: o.color ?? null, locked: !!o.locked, units: "m" } };
    const model = o.model.clone(true); // shares geometry and materials; userData of the clone holds Box3s and materials: scrubbed
    model.traverse((c) => {
      c.userData = {};
      // the catalogue meshes carry texture coordinates that no material uses: leave them out (a quarter of the file) by sharing the other attributes
      if (c.isMesh && c.geometry.getAttribute("uv") && ![].concat(c.material).some((m) => m?.map || m?.normalMap || m?.emissiveMap || m?.roughnessMap || m?.aoMap)) {
        const g = new THREE.BufferGeometry(), src = c.geometry;
        for (const [k, a] of Object.entries(src.attributes)) if (k !== "uv") g.setAttribute(k, a);
        g.setIndex(src.index);
        for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
        c.geometry = g;
      }
    });
    let k = 0;
    model.traverse((c) => { if (c.isMesh) c.name = `${name} (mesh${++k > 1 ? ` ${k}` : ""})`; });
    model.name = "";
    node.add(...model.children.length && model.matrix.equals(new THREE.Matrix4()) ? model.children.slice() : [model]);
    root.add(node);
  }
  return { root, skipped, count: root.children.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// GLB
const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
/** Split a GLB (ArrayBuffer or typed array) into { json, bin: Uint8Array | null }. Throws an Error with a plain message for a malformed file. */
export function parseGLB(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (buf.byteLength < 20) throw new Error("This is not a GLB file: it is too short.");
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("This is not a GLB file: the glTF header is missing.");
  if (dv.getUint32(4, true) !== 2) throw new Error(`Only glTF 2.0 is supported (this file is version ${dv.getUint32(4, true)}).`);
  const total = dv.getUint32(8, true);
  if (total !== buf.byteLength) throw new Error("The GLB file is truncated or has extra bytes.");
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    off += 8;
    if (off + len > total) throw new Error("A chunk of the GLB file runs past its end.");
    if (type === CHUNK_JSON && json === null) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, len)));
    else if (type === CHUNK_BIN && bin === null) bin = new Uint8Array(buf, off, len);
    off += len;
  }
  if (json === null) throw new Error("The GLB file has no JSON chunk.");
  return { json, bin };
}
/** Assemble a GLB from a glTF JSON object and its binary chunk (both chunks padded to 4 bytes). */
export function packGLB(json, bin) {
  const jb = new TextEncoder().encode(JSON.stringify(json)), jl = (jb.length + 3) & ~3, bl = bin ? (bin.length + 3) & ~3 : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0), out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jl); out.set(jb, 20);
  if (bin) { const o = 20 + jl; dv.setUint32(o, bl, true); dv.setUint32(o + 4, CHUNK_BIN, true); out.set(bin, o + 8); }
  return out.buffer;
}
// GLTFExporter finishes through FileReader; browsers have it, Node does not. This stand-in lets buildGLB run headless (tests, scripts) and is only
// installed when there is no FileReader.
function ensureFileReader() {
  if (typeof globalThis.FileReader !== "undefined") return;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }, (e) => { this.error = e; this.onerror?.(e); }); }
    readAsDataURL() { throw new Error("FileReader.readAsDataURL is not available here."); }
  };
}
const SKIN_COLOR = 0xd9b99b;
const RESERVED_NODE_NAMES = ["digital-human", "figure", "scene", "skin", "eyes", "skeleton-sticks"]; // names of the nodes this file makes itself: an object never takes one
/** GLTFExporter writes one skin per skinned mesh; the figure has one skeleton, so the skin and the eyes share a single glTF skin (dropUnused then removes the second copy of the matrices). */
function shareSkins(json) {
  if (!json.skins || json.skins.length < 2) return;
  const seen = new Map(), out = [], remap = json.skins.map((sk, i) => {
    const key = `${sk.skeleton}|${sk.joints.join(",")}`;
    if (!seen.has(key)) { seen.set(key, out.length); out.push(sk); }
    return seen.get(key);
  });
  for (const n of json.nodes) if (n.skin !== undefined) n.skin = remap[n.skin];
  json.skins = out;
}
/**
 * Drop the accessors that nothing refers to any more (the copy of the inverse bind matrices that shareSkins left behind) together with their buffer views,
 * and close the gaps in the binary chunk. Returns the new binary chunk. Every index that points at an accessor is renumbered.
 */
function dropUnused(json, bin) {
  if (!json.accessors || !bin) return bin;
  const used = new Set(), mark = (i) => { if (Number.isInteger(i)) used.add(i); };
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) { mark(p.indices); for (const a of Object.values(p.attributes ?? {})) mark(a); for (const t of p.targets ?? []) for (const a of Object.values(t)) mark(a); }
  for (const sk of json.skins ?? []) mark(sk.inverseBindMatrices);
  for (const an of json.animations ?? []) for (const sm of an.samplers ?? []) { mark(sm.input); mark(sm.output); }
  if (used.size === json.accessors.length) return bin;
  const remap = new Map(), accessors = [];
  json.accessors.forEach((a, i) => { if (used.has(i)) { remap.set(i, accessors.length); accessors.push(a); } });
  const fix = (i) => (Number.isInteger(i) ? remap.get(i) : i);
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) { p.indices = fix(p.indices); for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = fix(p.attributes[k]); for (const t of p.targets ?? []) for (const k of Object.keys(t)) t[k] = fix(t[k]); if (p.indices === undefined) delete p.indices; }
  for (const sk of json.skins ?? []) sk.inverseBindMatrices = fix(sk.inverseBindMatrices);
  for (const an of json.animations ?? []) for (const sm of an.samplers ?? []) { sm.input = fix(sm.input); sm.output = fix(sm.output); }
  const imageViews = (json.images ?? []).map((im) => im.bufferView).filter(Number.isInteger); // embedded textures keep their buffer views
  const viewUsed = [...new Set([...accessors.map((a) => a.bufferView).filter(Number.isInteger), ...imageViews])].sort((a, b) => a - b), vmap = new Map(), views = [], chunks = [];
  let offset = 0;
  for (const vi of viewUsed) {
    const v = json.bufferViews[vi], start = v.byteOffset ?? 0, bytes = bin.subarray(start, start + v.byteLength);
    vmap.set(vi, views.length);
    views.push({ ...v, byteOffset: offset });
    chunks.push(bytes);
    offset += (bytes.length + 3) & ~3;
    if (bytes.length & 3) chunks.push(new Uint8Array(4 - (bytes.length & 3)));
  }
  for (const a of accessors) if (Number.isInteger(a.bufferView)) a.bufferView = vmap.get(a.bufferView);
  for (const im of json.images ?? []) if (Number.isInteger(im.bufferView)) im.bufferView = vmap.get(im.bufferView);
  json.accessors = accessors; json.bufferViews = views;
  json.buffers[0].byteLength = offset;
  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
const GLB_FIGURE = ["skin", "skeleton", "none"], GLB_POSE = ["baked", "clip"];

/**
 * Thin octahedral sticks, one per bone of the skeleton (joint to child joint), skinned 100 % to the parent joint: a visible skeleton in any viewer and an
 * armature for Blender. `at(id)` gives the world position of a joint in the bind pose that the file will have (neutral, or the current pose when baked).
 */
function stickGeometry(at, boneIndex) {
  const pos = [], nor = [], si = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), w = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const j of JOINTS) {
    if (!j.parent) continue;
    a.copy(at(j.parent)); b.copy(at(j.id));
    const len = a.distanceTo(b);
    if (len < 1e-3) continue; // the forearm joint sits on the elbow: no bone to draw
    u.subVectors(b, a).divideScalar(len);
    v.crossVectors(u, Math.abs(u.y) < 0.9 ? e1.set(0, 1, 0) : e1.set(1, 0, 0)).normalize();
    w.crossVectors(u, v);
    const r = Math.min(0.012, Math.max(0.003, 0.1 * len)), mid = a.clone().addScaledVector(u, 0.15 * len);
    const ring = [0, 1, 2, 3].map((k) => { const t = (k * Math.PI) / 2; return mid.clone().addScaledVector(v, r * Math.cos(t)).addScaledVector(w, r * Math.sin(t)); });
    const tris = [[a, ring[0], ring[1]], [a, ring[1], ring[2]], [a, ring[2], ring[3]], [a, ring[3], ring[0]], [b, ring[1], ring[0]], [b, ring[2], ring[1]], [b, ring[3], ring[2]], [b, ring[0], ring[3]]];
    for (const [p, q, s] of tris) {
      n.crossVectors(e1.subVectors(q, p), e2.subVectors(s, p)).normalize();
      for (const x of [p, q, s]) { pos.push(x.x, x.y, x.z); nor.push(n.x, n.y, n.z); si.push(boneIndex.get(j.parent), 0, 0, 0); }
    }
  }
  const g = new THREE.BufferGeometry(), count = pos.length / 3, sw = new Float32Array(4 * count);
  for (let i = 0; i < count; i++) sw[4 * i] = 1;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(si), 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  return g;
}

/**
 * Binary glTF 2.0 of the figure. options:
 *   figure       "skin" (skinned mesh + eyes + the 77-joint skeleton, default) | "skeleton" (the skeleton and thin bone sticks) | "none" (scene objects only)
 *   pose         "baked" (default): skeleton and skin in the current pose, which is also the bind pose; | "clip": neutral bind pose, the current pose as a one-frame animation clip
 *   scene        include the visible sandbox objects (named nodes, catalogue type and parameters in `extras`)
 *   measurements include `input.measurements` (rows of measure.exportRows()) in the scene `extras`
 *   created      an ISO date string written into the metadata (omitted by default: the output is then byte-for-byte reproducible)
 *   tick(text)   awaited between the steps; the panel uses it to let the page breathe
 * Node names of the skeleton are the joint ids of skeleton.js, in that order (parents first); the pelvis is the root joint. Units metres, +Y up, the figure faces +Z.
 * Returns { data: ArrayBuffer, bytes, stats: { vertices, triangles, joints, nodes, meshes, objects, skippedObjects }, json }.
 */
export async function buildGLB(input, options = {}) {
  const { rig, profile, posture, sandbox, measurements } = need(input);
  const o = { figure: "skin", pose: "baked", scene: false, measurements: false, created: null, ...options };
  if (!GLB_FIGURE.includes(o.figure)) throw new RangeError(`Unknown GLB content "${o.figure}" (use ${GLB_FIGURE.join(", ")}).`);
  if (!GLB_POSE.includes(o.pose)) throw new RangeError(`Unknown GLB pose mode "${o.pose}" (use ${GLB_POSE.join(", ")}).`);
  const tick = tickOf(o);
  await tick("Collecting the figure");
  const scene = new THREE.Scene();
  scene.name = "digital-human";
  const stats = { vertices: 0, triangles: 0, joints: 0, nodes: 0, meshes: 0, objects: 0, skippedObjects: 0 };
  const clips = [];
  rig.group.updateMatrixWorld(true);

  if (o.figure !== "none") {
    const figure = new THREE.Group();
    figure.name = "figure";
    const bones = new Map(), list = [];
    const rest = rig.restOffsets, baked = o.pose === "baked";
    for (const j of JOINTS) {
      const b = new THREE.Bone(), src = rig.bones.get(j.id);
      b.name = j.id;
      if (baked) { b.position.copy(src.position); b.quaternion.copy(src.quaternion); } else if (j.parent) b.position.fromArray(rest[j.id]); else b.position.set(0, rig.restRootY, 0);
      if (j.parent) bones.get(j.parent).add(b); else figure.add(b);
      bones.set(j.id, b);
      list.push(b);
    }
    figure.updateMatrixWorld(true);
    const boneIndex = new Map(JOINTS.map((j, i) => [j.id, i]));
    const meshes = o.figure === "skin" ? skinnedMeshes(rig) : [];
    if (o.figure === "skin" && !meshes.length) throw new Error("The figure has no skin to export. Choose 'Skeleton only', or wait until the skin has been built.");
    // the inverse bind matrices: in the pose that is baked in, those of the pose; else the ones the rig's skin was bound with (by bone name)
    const orig = new Map();
    if (meshes[0]) meshes[0].skeleton.bones.forEach((b, i) => orig.set(b.name, meshes[0].skeleton.boneInverses[i]));
    const inverses = list.map((b) => (baked ? null : orig.get(b.name))?.clone() ?? b.matrixWorld.clone().invert());
    const skeleton = new THREE.Skeleton(list, inverses);
    await tick("Posing the skin");
    const add = (name, geometry, material) => {
      const m = new THREE.SkinnedMesh(geometry, material);
      m.name = name;
      scene.add(m); // a skinned mesh sits at the root of the scene: the transform of its parents would not move it (glTF validators warn otherwise)
      m.bind(skeleton, new THREE.Matrix4());
      stats.vertices += geometry.getAttribute("position").count;
      stats.triangles += geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
      stats.meshes++;
    };
    for (const m of meshes) {
      const src = m.geometry, g = new THREE.BufferGeometry(), n = src.getAttribute("position").count;
      let position = dense(src.getAttribute("position"), 3), normal = dense(src.getAttribute("normal"), 3);
      if (baked) ({ position, normal } = poseVertices(m, skinTable(m)));
      const remap = m.skeleton.bones.map((b) => boneIndex.get(b.name)); // the skin's bone indices -> positions in the joint list of the file
      if (remap.some((i) => i === undefined)) throw new Error("The skin is bound to a bone that is not one of the 77 joints.");
      g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(position), 3));
      if (normal) g.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(normal), 3));
      const col = src.getAttribute("color");
      if (col) g.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(dense(col, 3)), 3));
      g.setAttribute("skinIndex", new THREE.BufferAttribute(Uint16Array.from(dense(src.getAttribute("skinIndex"), 4), (i) => remap[i]), 4));
      g.setAttribute("skinWeight", new THREE.BufferAttribute(Float32Array.from(dense(src.getAttribute("skinWeight"), 4)), 4));
      const ix = indexOf(src, n);
      if (ix) g.setIndex(new THREE.BufferAttribute(ix, 1));
      const mat = new THREE.MeshStandardMaterial({ name: col ? "eyes" : "skin", color: col ? 0xffffff : (m.material?.color ?? new THREE.Color(SKIN_COLOR)), roughness: m.material?.roughness ?? 0.6, metalness: 0, vertexColors: !!col });
      add(cleanName(m.name, col ? "eyes" : "skin"), g, mat);
    }
    if (o.figure === "skeleton") {
      const at = (id) => new THREE.Vector3().setFromMatrixPosition(bones.get(id).matrixWorld); // the bind pose of the file: the current pose when baked, neutral otherwise
      add("skeleton-sticks", stickGeometry(at, boneIndex), new THREE.MeshStandardMaterial({ name: "skeleton", color: 0xd8d4c8, roughness: 0.6, metalness: 0 }));
    }
    figure.userData = { digitalHuman: { kind: "figure", units: "m", nodeNames: "node names are the joint ids of the rig (pelvis is the root joint)", bind: baked ? "the current pose is the bind pose" : "neutral standing bind pose; the animation clip holds the current pose", jointCount: JOINTS.length } };
    scene.add(figure);
    stats.joints = JOINTS.length;
    if (!baked) {
      const tracks = JOINTS.map((j) => new THREE.QuaternionKeyframeTrack(`${j.id}.quaternion`, [0], rig.bones.get(j.id).quaternion.toArray()));
      tracks.push(new THREE.VectorKeyframeTrack("pelvis.position", [0], rig.bones.get("pelvis").position.toArray()));
      clips.push(new THREE.AnimationClip(`pose-${postureSlug(posture)}`, 0, tracks));
    }
  }

  if (o.scene && sandbox) {
    await tick("Adding the scene objects");
    const nodes = objectNodes(sandbox, new Set([...JOINTS.map((j) => j.id), ...RESERVED_NODE_NAMES]));
    stats.objects = nodes.count; stats.skippedObjects = nodes.skipped;
    if (nodes.count) {
      scene.add(nodes.root);
      nodes.root.traverse((c) => { if (c.isMesh) { stats.meshes++; stats.vertices += c.geometry.getAttribute("position")?.count ?? 0; stats.triangles += c.geometry.index ? c.geometry.index.count / 3 : (c.geometry.getAttribute("position")?.count ?? 0) / 3; } });
    }
  }
  if (o.measurements && measurements?.length) scene.userData = { digitalHuman: { measurements: JSON.parse(JSON.stringify(measurements)), units: { length: "mm", angle: "deg" } } };

  if (!scene.children.length) throw new Error("There is nothing to export: choose the figure, or include scene objects that are visible.");
  await tick("Writing the GLB");
  ensureFileReader();
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const raw = await new GLTFExporter().parseAsync(scene, { binary: true, trs: true, onlyVisible: true, animations: clips });
  const { json, bin: rawBin } = parseGLB(raw);
  shareSkins(json);
  const bin = dropUnused(json, rawBin);
  const prov = provenance({ profile, posture }, o.created);
  json.asset = { ...json.asset, generator: GENERATOR, extras: { ...prov, units: "m", axes: { up: "+Y", front: "+Z", left: "+X", handedness: "right", note: AXES_NOTE }, pose: o.pose === "baked" ? "baked: skeleton and skin are in the current pose" : "clip: neutral bind pose + a one-frame animation clip with the current pose", figure: o.figure } };
  const data = packGLB(json, bin);
  stats.nodes = json.nodes?.length ?? 0;
  return { data, bytes: data.byteLength, stats, json };
}

// ---------------------------------------------------------------------------------------------------------------------
// OBJ and STL: static posed meshes
/** The group both mesh exporters read: posed skin (+ visible scene objects), transformed to the file's axes and unit. */
function staticScene(input, o) {
  const { rig, sandbox } = need(input);
  const root = new THREE.Group();
  root.name = "digital-human";
  const stats = { vertices: 0, triangles: 0, objects: 0 };
  if (o.skin !== false) {
    for (const s of bakeSkin(rig)) {
      const mesh = new THREE.Mesh(s.geometry, new THREE.MeshBasicMaterial({ name: s.name }));
      mesh.name = s.name;
      root.add(mesh);
      stats.vertices += s.vertices; stats.triangles += s.triangles;
    }
  }
  if (o.scene && sandbox) {
    const nodes = objectNodes(sandbox, new Set(RESERVED_NODE_NAMES));
    nodes.root.name = "scene";
    if (nodes.count) {
      root.add(nodes.root);
      nodes.root.traverse((c) => { if (c.isMesh) { stats.vertices += c.geometry.getAttribute("position")?.count ?? 0; stats.triangles += c.geometry.index ? c.geometry.index.count / 3 : (c.geometry.getAttribute("position")?.count ?? 0) / 3; } });
    }
    stats.objects = nodes.count;
  }
  root.matrixAutoUpdate = false;
  root.matrix.copy(axesMatrix(o.axes, unitOf(o.unit, ["m", "mm"])));
  root.updateMatrixWorld(true);
  return { root, stats };
}
const staticOptions = (options) => ({ unit: "mm", axes: "y-up", skin: true, scene: false, created: null, ...options });
const unitHeader = (u) => `${UNIT_NAME[u]} (1 unit = 1 ${u})`;

/** Wavefront OBJ of the posed skin (+ scene objects). options: { unit: "mm" | "m", axes: "y-up" | "z-up" | "x-front", skin, scene, created }. Returns { text, bytes, stats }. */
export async function buildOBJ(input, options = {}) {
  const o = staticOptions(options), n = need(input);
  const { root, stats } = staticScene(input, o);
  if (!root.children.length) throw new Error("There is nothing to export: turn on the skin or include the scene objects.");
  await tickOf(o)("Writing the OBJ");
  const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js");
  const ax = AXES[o.axes];
  const header = [
    "# Digital human OBJ export", `# Generated by: ${ascii(GENERATOR)}`, `# Profile: ${ascii(profileLine(n.profile))}`, `# Posture: ${ascii(postureLine(n.posture))}`,
    `# Units: ${unitHeader(o.unit)}`, `# Axes: right-handed; up = ${ax.up}, the figure faces ${ax.front}, the figure's left = ${ax.left}; floor at height 0`,
    `# Contents: ${[o.skin !== false ? "skin (posed)" : null, stats.objects ? `${stats.objects} scene object${stats.objects === 1 ? "" : "s"}` : null].filter(Boolean).join(", ")}`,
    ...(o.created ? [`# Created: ${ascii(o.created)}`] : []), `# ${ascii(MODEL_NOTE)}`, "",
  ].join("\n");
  const text = header + new OBJExporter().parse(root);
  return { text, bytes: new TextEncoder().encode(text).length, stats };
}

/** Binary STL (triangles only; the 80-byte header holds a short text, never starting with "solid"). Same options as buildOBJ. Returns { data: ArrayBuffer, bytes, triangles, stats }. */
export async function buildSTL(input, options = {}) {
  const o = staticOptions(options), n = need(input);
  const { root, stats } = staticScene(input, o);
  if (!root.children.length) throw new Error("There is nothing to export: turn on the skin or include the scene objects.");
  await tickOf(o)("Writing the STL");
  const { STLExporter } = await import("three/addons/exporters/STLExporter.js");
  const dv = new STLExporter().parse(root, { binary: true });
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const ax = AXES[o.axes];
  const head = ascii(`Digital human STL | units ${o.unit} | up ${ax.up} front ${ax.front} | ${n.posture?.id ?? n.posture?.name ?? "pose"} | ${n.profile?.label ?? "figure"}`, 79);
  bytes.fill(0x20, 0, 80);
  bytes.set(new TextEncoder().encode(head.startsWith("solid") ? `_${head}`.slice(0, 79) : head), 0);
  const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return { data: bytes.slice().buffer, bytes: bytes.length, triangles, stats };
}

// ---------------------------------------------------------------------------------------------------------------------
// BVH
/** Where a leaf joint ends (End Site offset, metres, neutral pose): the landmark its bone ends at (fingertip, toe tip, chin, pupil), else 1 cm along +Y. */
function endSite(rig, id) {
  const rb = rig.restBody, pos = rb.positions ?? {};
  const bone = BONES.find((b) => b.joint === id && b.from === id && typeof b.to === "string" && b.to.startsWith("lm:"));
  const lm = bone ? rb.landmarks?.[bone.to.slice(3)] : null;
  if (!lm || !pos[lm.joint] || !pos[id]) return [0, 0.01, 0];
  return [0, 1, 2].map((k) => pos[lm.joint][k] + lm.offset[k] - pos[id][k]);
}
/**
 * Biovision BVH of the 77-joint skeleton. options:
 *   unit          "cm" (default) | "mm" | "m": OFFSET and the root position
 *   neutralFrame  add a second frame with the neutral standing pose (frame 1 is the current pose)
 *   header        write "#" comment lines (profile, posture, units, axes) before HIERARCHY; off by default because several readers (Blender among them)
 *                 insist that the first word of the file is HIERARCHY
 *   created       ISO date for the header
 * ROOT is the pelvis with channels Xposition Yposition Zposition Zrotation Xrotation Yrotation; every other joint has Zrotation Xrotation Yrotation, degrees,
 * the rotation being R = Rz * Rx * Ry of its LOCAL rotation relative to its parent (the local frames are world-aligned at rest, so the conversion is exact
 * and OFFSET is simply the rest offset). Axes: Y up, +Z in front of the figure, +X the figure's left, right-handed. Frame time 1/30 s. Leaf joints get an
 * End Site at their landmark (fingertip, toe tip, chin, pupil). Returns { text, bytes, frames, joints, unit }.
 */
export function buildBVH(input, options = {}) {
  const { rig, profile, posture } = need(input);
  const o = { unit: "cm", neutralFrame: false, header: false, created: null, ...options };
  const k = unitOf(o.unit, ["m", "cm", "mm"]), dec = { m: 6, cm: 5, mm: 4 }[o.unit];
  const num = (v) => String(rnd(v, dec)), ang = (v) => String(rnd(v, 5));
  const rest = rig.restOffsets, lines = [], order = [];
  if (o.header) {
    lines.push(
      "# Digital human BVH export", `# Generated by: ${ascii(GENERATOR)}`, `# Profile: ${ascii(profileLine(profile))}`, `# Posture: ${ascii(postureLine(posture))}`,
      `# Units of OFFSET and position: ${UNIT_NAME[o.unit]}; rotations in degrees, order Z X Y (R = Rz * Rx * Ry)`, `# Axes: ${AXES_NOTE}`,
      `# Frame 1: the posture${o.neutralFrame ? "; frame 2: the neutral standing pose" : ""}`, ...(o.created ? [`# Created: ${ascii(o.created)}`] : []), `# ${ascii(MODEL_NOTE)}`);
  }
  lines.push("HIERARCHY");
  const emit = (id, depth) => {
    const pad = "\t".repeat(depth), j = JOINT_BY_ID[id], off = j.parent ? rest[id] : [0, 0, 0], kids = CHILDREN[id];
    order.push(id);
    lines.push(`${pad}${depth === 0 ? "ROOT" : "JOINT"} ${id}`, `${pad}{`, `${pad}\tOFFSET ${off.map((v) => num(v * k)).join(" ")}`,
      `${pad}\tCHANNELS ${depth === 0 ? "6 Xposition Yposition Zposition Zrotation Xrotation Yrotation" : "3 Zrotation Xrotation Yrotation"}`);
    if (!kids.length) lines.push(`${pad}\tEnd Site`, `${pad}\t{`, `${pad}\t\tOFFSET ${endSite(rig, id).map((v) => num(v * k)).join(" ")}`, `${pad}\t}`);
    for (const c of kids) emit(c, depth + 1);
    lines.push(`${pad}}`);
  };
  emit("pelvis", 0);
  const e = new THREE.Euler(), id4 = new THREE.Quaternion();
  const frame = (posOf, quatOf) => {
    const vals = posOf().map((v) => num(v * k));
    for (const id of order) { e.setFromQuaternion(quatOf(id), "ZXY"); vals.push(ang(e.z * (180 / Math.PI)), ang(e.x * (180 / Math.PI)), ang(e.y * (180 / Math.PI))); }
    return vals.join(" ");
  };
  const frames = [frame(() => rig.bones.get("pelvis").position.toArray(), (id) => rig.bones.get(id).quaternion)];
  if (o.neutralFrame) frames.push(frame(() => [0, rig.restRootY, 0], () => id4));
  lines.push("MOTION", `Frames: ${frames.length}`, "Frame Time: 0.0333333", ...frames, "");
  const text = lines.join("\n");
  return { text, bytes: new TextEncoder().encode(text).length, frames: frames.length, joints: order.length, unit: o.unit };
}

// ---------------------------------------------------------------------------------------------------------------------
// tables
const csv = (cols, rows) => toCSV(cols, rows);
const csvCell = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v); // a spreadsheet would run a cell that starts with = + - @ as a formula
/** Lines "# ..." for the top of a CSV (profile, posture, units, axes). Optional: spreadsheets show them as rows. */
export function csvHeader(input, what, units) {
  const { profile, posture } = need(input);
  return [`# ${what} - ${ascii(GENERATOR)}`, `# Profile: ${ascii(profileLine(profile))}`, `# Posture: ${ascii(postureLine(posture))}`, `# Units: ${units}`, `# Axes: ${AXES_NOTE}`, ""].join("\n");
}
export const POINT_COLUMNS = Object.freeze(["type", "id", "label", "group", "kind", "attached_to", "x_mm", "y_mm", "z_mm"]);
const mm1 = (m) => { const v = Math.round(m * 10000) / 10; return Object.is(v, -0) ? 0 : v; };
/**
 * Every joint centre and landmark in world millimetres (one decimal), +X the figure's left, +Y up, +Z in front, floor at y = 0, in the pose the figure is in.
 * The same columns and numbers as pointsCSV() of panels/skeleton.js ("Points for CAD"), which the panel uses when it is there; this one is the fallback and the reference of the test.
 */
export function pointsCSV(input, { header = false } = {}) {
  const { rig } = need(input), rows = [];
  for (const j of JOINTS) { const p = rig.jointWorld(j.id); rows.push(["joint", j.id, j.label, GROUP_LABEL[j.group] ?? j.group, "centre", j.parent ?? "", mm1(p.x), mm1(p.y), mm1(p.z)]); }
  for (const [id, l] of Object.entries(rig.body.landmarks)) { const p = rig.landmarkWorld(id); rows.push(["landmark", id, l.label ?? id, l.group ?? "", l.kind ?? "", l.joint, mm1(p.x), mm1(p.y), mm1(p.z)]); }
  return (header ? csvHeader(input, "Joint centres and landmarks", "millimetres") : "") + csv(POINT_COLUMNS, rows);
}
export const ANGLE_COLUMNS = Object.freeze(["joint_id", "joint_label", "group", "side", "dof_key", "dof_label", "role", "value_deg", "min_deg", "max_deg", "at_limit", "axis_x", "axis_y", "axis_z", "positive_means"]);
/**
 * One row per degree of freedom in the current pose: the root orientation (joint_id "root": heading, flex, lat, rot, not limited), then the 77 joints in
 * skeleton order (the pelvis only when its own angles are not 0). `at_limit` is "min" or "max" within 0.01 degree of the range of motion, else "".
 */
export function anglesRows(input) {
  const { rig } = need(input), pose = rig.getPose(), rows = [];
  for (const d of ROOT_DOF) rows.push({ joint_id: "root", joint_label: "Root (orientation of the pelvis in the world)", group: "Root", side: "", dof_key: d.key, dof_label: d.label, role: d.role, value_deg: rnd(pose.root[d.key] ?? 0, 4), min_deg: d.min, max_deg: d.max, at_limit: "", axis: d.axis, positive_means: d.pos });
  for (const j of JOINTS) {
    const a = pose.angles[j.id] ?? [];
    if (j.id === "pelvis" && a.every((v) => !v)) continue;
    j.dof.forEach((d, i) => {
      const v = a[i] ?? 0;
      rows.push({ joint_id: j.id, joint_label: j.label, group: GROUP_LABEL[j.group] ?? j.group, side: j.side ?? "", dof_key: d.key, dof_label: d.label, role: d.role, value_deg: rnd(v, 4), min_deg: rnd(d.min, 3), max_deg: rnd(d.max, 3),
        at_limit: Math.abs(v - d.min) < 0.01 ? "min" : Math.abs(v - d.max) < 0.01 ? "max" : "", axis: d.axis, positive_means: d.pos });
    });
  }
  return rows;
}
export function anglesCSV(input, { header = false } = {}) {
  const rows = anglesRows(input);
  return (header ? csvHeader(input, "Joint angles", "degrees") : "") + csv(ANGLE_COLUMNS, rows.map((r) => [r.joint_id, r.joint_label, r.group, r.side, r.dof_key, r.dof_label, r.role, r.value_deg, r.min_deg, r.max_deg, r.at_limit, ...r.axis, r.positive_means]));
}
export function anglesJSON(input, { created = null } = {}) {
  const { profile, posture } = need(input);
  return JSON.stringify({ format: "human-joint-angles", ...provenance({ profile, posture }, created), units: { angle: "deg" }, axes: AXES_NOTE,
    rows: anglesRows(input).map(({ axis, ...r }) => ({ ...r, axis })) }, null, 2) + "\n";
}

export const DIM_COLUMNS = Object.freeze(["id", "label", "value", "unit", "status", "measure_keys", "formula"]);
/** The mapping table (body.dims) in millimetres: lengths in m become mm, masses stay kg, ratios stay unitless. */
export function dimsRows(input) {
  const { body } = need(input);
  return (body.dims ?? []).map((d) => ({ id: d.id, label: d.label, value: d.unit === "m" ? mm3(d.value) : rnd(d.value, 4), unit: d.unit === "m" ? "mm" : d.unit === "ratio" ? "" : d.unit, status: d.status, measure_keys: (d.via ?? []).join(" "), formula: d.formula ?? d.note ?? "" }));
}
export const dimsCSV = (input, { header = false } = {}) => (header ? csvHeader(input, "Dimensions (mapping table)", "millimetres, kilograms") : "") + csv(DIM_COLUMNS, dimsRows(input).map((r) => [r.id, r.label, r.value, r.unit, r.status, r.measure_keys, csvCell(r.formula)]));

export const REPORT_COLUMNS = Object.freeze(["id", "label", "kind", "posture", "unit", "input", "model", "delta", "tolerance", "status", "note"]);
/** The fit report (body.report): the profile value, the value measured on the built model, their difference and a status, millimetres (kilograms for the mass). */
export function reportRows(input) {
  const { body } = need(input);
  return (body.report ?? []).map((r) => ({ id: r.id, label: r.label, kind: r.kind, posture: r.posture ?? "", unit: r.unit ?? "mm", input: r.input == null ? "" : rnd(r.input, 3), model: r.model == null ? "" : rnd(r.model, 3), delta: r.delta == null ? "" : rnd(r.delta, 3), tolerance: r.tolerance == null ? "" : rnd(r.tolerance, 3), status: r.status ?? "", note: r.note ?? "" }));
}
export const reportCSV = (input, { header = false } = {}) => (header ? csvHeader(input, "Fit report", "millimetres, kilograms") : "") + csv(REPORT_COLUMNS, reportRows(input).map((r) => [r.id, r.label, r.kind, r.posture, r.unit, r.input, r.model, r.delta, r.tolerance, r.status, csvCell(r.note)]));

export const METRIC_COLUMNS = Object.freeze(["group", "key", "label", "unit", "value"]);
/** Posture metrics of metrics.js (trunk, neck, arm and leg angles, heights, reach, balance) in the current pose, or null when metrics.js is not there. Lengths in mm. */
export async function metricRows(input) {
  const { rig, body } = need(input);
  const m = await import("./metrics.js").catch(() => null);
  if (!m || typeof m.postureMetrics !== "function" || !Array.isArray(m.METRIC_DEFS)) return null;
  const pose = rig.getPose(), values = m.postureMetrics(body, { root: pose.root, angles: pose.angles }, { ...pose.root });
  const rows = [];
  for (const d of m.METRIC_DEFS) {
    for (const key of d.sided ? [`${d.key}_L`, `${d.key}_R`] : [d.key]) {
      const v = values[key], side = d.sided ? (key.endsWith("_L") ? " (left)" : " (right)") : "";
      rows.push({ group: d.group, key, label: `${d.label}${side}`, unit: d.type === "deg" ? "deg" : d.type === "m" ? "mm" : "", value: v == null ? "" : d.type === "m" ? mm3(v) : typeof v === "number" ? rnd(v, 3) : String(v) });
    }
  }
  return rows;
}
export async function metricsCSV(input, { header = false } = {}) {
  const rows = await metricRows(input);
  if (!rows) return null;
  return (header ? csvHeader(input, "Posture metrics", "degrees, millimetres") : "") + csv(METRIC_COLUMNS, rows.map((r) => [r.group, r.key, r.label, r.unit, r.value]));
}

// ---------------------------------------------------------------------------------------------------------------------
// the exchange JSON
const qxyzw = (q) => { const s = q.w < 0 ? -1 : 1; return [rnd(s * q.x, 7), rnd(s * q.y, 7), rnd(s * q.z, 7), rnd(s * q.w, 7)]; };
const jsonCopy = (v) => JSON.parse(JSON.stringify(v));
/** The pose as { jointId: { dofKey: degrees } } for the joints that are not at 0 (the full list with ranges is in body.joints). */
function namedAngles(pose) {
  const out = {};
  for (const j of JOINTS) {
    const a = pose.angles[j.id] ?? [];
    if (a.some((v) => v)) out[j.id] = Object.fromEntries(j.dof.map((d, i) => [d.key, rnd(a[i] ?? 0, 4)]));
  }
  return out;
}
/**
 * The "human-exchange" document (version 1): one self-describing JSON for other programs. Lengths in millimetres, masses in kilograms, angles in degrees;
 * axes +Y up, +Z front, +X the figure's left, right-handed, floor at y = 0. Sections: format / version / generator / units / axes, profile (the survey
 * measures with units and status), body (stature, mass, the dimension table, the 77 joints with parent, rest offset, rest and posed world position, world
 * orientation and every degree of freedom with its range, the landmarks, the segment masses), posture (root and joint angles, library id), placement (root
 * position), scene (the sandbox objects) and measurements. validateExchange() checks it. Same options as the other builders (created).
 */
export function buildExchange(input, options = {}) {
  const { rig, body, profile, posture, sandbox, measurements } = need(input);
  rig.group.updateMatrixWorld(true);
  const pose = rig.getPose(), root = rig.root, restPos = rig.restBody.positions ?? {}, rest = rig.restOffsets;
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  const joints = JOINTS.map((j) => {
    const a = pose.angles[j.id] ?? [], p = rig.jointWorld(j.id, v), rp = restPos[j.id];
    const dof = j.dof.map((d, i) => {
      const val = a[i] ?? 0;
      return { key: d.key, label: d.label, role: d.role, axis: [...d.axis], value_deg: rnd(val, 4), min_deg: rnd(d.min, 3), max_deg: rnd(d.max, 3), at_limit: Math.abs(val - d.min) < 0.01 ? "min" : Math.abs(val - d.max) < 0.01 ? "max" : null, positive_means: d.pos };
    });
    return {
      id: j.id, label: j.label, group: j.group, side: j.side ?? null, parent: j.parent ?? null,
      rest_offset_mm: j.parent ? rest[j.id].map(mm3) : [0, mm3(rig.restRootY), 0],
      rest_position_mm: rp ? rp.map(mm3) : null, position_mm: vmm(p), orientation_xyzw: qxyzw(rig.jointQuaternion(j.id, q)), dof,
    };
  });
  const landmarks = Object.entries(rig.restBody.landmarks ?? {}).map(([id, l]) => ({ id, label: l.label ?? id, group: l.group ?? null, kind: l.kind ?? null, joint: l.joint, offset_mm: l.offset.map(mm3), position_mm: vmm(rig.landmarkWorld(id, v)) }));
  const segs = rig.comSegments;
  const segments = segs.map((s) => { const m = body.masses?.[s.id] ?? {}; return { id: s.id, label: s.label, joint: m.com?.joint ?? null, mass_kg: rnd(s.mass, 4), com_offset_mm: m.com?.offset ? m.com.offset.map(mm3) : null, com_position_mm: vmm(s.point) }; });
  let com = null;
  if (segs.length) { const c = rig.centerOfMass(new THREE.Vector3()); com = { position_mm: vmm(c.point), mass_kg: rnd(c.mass, 3) }; }
  const dims = dimsRows(input).map((d) => ({ id: d.id, label: d.label, value: d.value, unit: d.unit, status: d.status, measure_keys: body.dims.find((x) => x.id === d.id)?.via ?? [] }));
  const measures = {};
  for (const [key, m] of Object.entries(profile?.measures ?? {})) if (m && fin(m.value)) measures[key] = jsonCopy(m);
  const scene = sceneInfo(sandbox);
  return {
    format: EXCHANGE_FORMAT, version: 1, generator: GENERATOR, ...(options.created ? { created: String(options.created) } : {}),
    units: "mm", units_detail: { length: "mm", mass: "kg", angle: "deg" },
    axes: { up: "+Y", front: "+Z", left: "+X", handedness: "right", origin: "floor (y = 0)", note: AXES_NOTE },
    note: MODEL_NOTE,
    profile: { id: profile?.id ?? body.profileId ?? null, label: profile?.label ?? body.label ?? "Figure", sex: profile?.sex ?? body.sex ?? "both", source: profile?.source ? jsonCopy(profile.source) : null, notes: Array.isArray(profile?.notes) ? profile.notes.map(String) : [], measures },
    body: { form: body.form ?? null, stature_mm: mm3(body.stature ?? 0), mass_kg: rnd(body.mass ?? 0, 3), dims, joints, landmarks, segments, centre_of_mass: com },
    posture: { id: posture?.id ?? null, name: posture?.name ?? null, library: !!posture?.id, root: { heading_deg: rnd(root.heading, 4), flex_deg: rnd(root.flex, 4), lat_deg: rnd(root.lat, 4), rot_deg: rnd(root.rot, 4) }, angles: namedAngles(pose) },
    placement: { root: { x_mm: mm3(root.x), y_mm: mm3(root.y), z_mm: mm3(root.z), note: "world position of the pelvis joint centre" } },
    scene: { version: 1, objects: scene.objects },
    measurements: measurements ? jsonCopy(measurements) : [],
  };
}
export const exchangeText = (input, options) => JSON.stringify(buildExchange(input, options), null, 2) + "\n";

const AXES_FIXED = { up: "+Y", front: "+Z", left: "+X", handedness: "right" };
/**
 * Check a human-exchange document (an object or its JSON text). Returns { ok, errors: [string], warnings: [string] }; never throws. Checks: format and version,
 * units, axes, the profile and its measures, the 77 joints in skeleton order with finite positions, unit quaternions and consistent degrees of freedom, rigid
 * bone lengths (distance to the parent = rest offset, within 0.05 mm), landmarks that name a joint, a plausible stature, masses that add up, scene objects.
 */
export function validateExchange(doc) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  try {
    if (typeof doc === "string") { try { doc = JSON.parse(doc); } catch (e) { return { ok: false, errors: [`The text is not valid JSON (${String(e.message).slice(0, 100)}).`], warnings }; } }
    if (!isObj(doc)) return { ok: false, errors: ["The document must be a JSON object."], warnings };
    if (doc.format !== EXCHANGE_FORMAT) err(`format must be "${EXCHANGE_FORMAT}" (found ${JSON.stringify(doc.format)}).`);
    if (!Number.isInteger(doc.version) || doc.version < 1) err("version must be a whole number from 1.");
    else if (doc.version > 1) err(`version ${doc.version} is newer than this validator understands (1).`);
    if (typeof doc.generator !== "string" || !doc.generator) err("generator must be a text.");
    if (doc.units !== "mm") err('units must be "mm" (lengths in millimetres; masses in kg, angles in degrees are fixed).');
    if (!isObj(doc.axes) || Object.entries(AXES_FIXED).some(([k, v]) => doc.axes[k] !== v)) err(`axes must declare up "+Y", front "+Z", left "+X", handedness "right".`);
    const p = doc.profile;
    if (!isObj(p)) err("profile is missing.");
    else {
      if (typeof p.label !== "string" || !p.label) err("profile.label must be a non-empty text.");
      if (!isObj(p.measures)) err("profile.measures must be an object.");
      else for (const [k, m] of Object.entries(p.measures)) if (!isObj(m) || !fin(m.value) || typeof m.unit !== "string") err(`profile.measures.${k} needs a finite value and a unit.`);
    }
    const b = doc.body;
    if (!isObj(b)) { err("body is missing."); return finish(); }
    if (!fin(b.stature_mm) || b.stature_mm < 500 || b.stature_mm > 3000) err(`body.stature_mm must be a number between 500 and 3000 (found ${b.stature_mm}).`);
    else if (b.stature_mm < 1300 || b.stature_mm > 2500) warn(`body.stature_mm = ${b.stature_mm} is outside the 1300 to 2500 mm range of adults.`);
    if (!fin(b.mass_kg) || b.mass_kg <= 0) err("body.mass_kg must be a positive number.");
    if (!Array.isArray(b.joints) || b.joints.length !== JOINTS.length) err(`body.joints must list the ${JOINTS.length} joints of the rig (found ${Array.isArray(b.joints) ? b.joints.length : "none"}).`);
    else {
      const idx = new Map();
      b.joints.forEach((j, i) => {
        const exp = JOINTS[i], where = `body.joints[${i}]`;
        if (!isObj(j)) return err(`${where} must be an object.`);
        if (j.id !== exp.id) return err(`${where}.id is ${JSON.stringify(j.id)} but joint ${i} of the skeleton is "${exp.id}": the joints must be in skeleton order (parents first).`);
        idx.set(j.id, j);
        if ((j.parent ?? null) !== (exp.parent ?? null)) err(`${where} (${j.id}): parent must be ${JSON.stringify(exp.parent ?? null)}.`);
        for (const key of ["rest_offset_mm", "position_mm"]) if (!Array.isArray(j[key]) || j[key].length !== 3 || !j[key].every((c) => fin(c) && Math.abs(c) < 1e5)) err(`${where} (${j.id}): ${key} must be three finite numbers in millimetres.`);
        const q = j.orientation_xyzw;
        if (!Array.isArray(q) || q.length !== 4 || !q.every(fin) || Math.abs(Math.hypot(...q) - 1) > 1e-5) err(`${where} (${j.id}): orientation_xyzw must be a unit quaternion.`);
        if (!Array.isArray(j.dof) || j.dof.length !== exp.dof.length || j.dof.some((d, k) => d?.key !== exp.dof[k].key)) err(`${where} (${j.id}): dof must list ${exp.dof.map((d) => d.key).join(", ")}.`);
        else for (const d of j.dof) {
          if (!fin(d.value_deg) || !fin(d.min_deg) || !fin(d.max_deg) || d.min_deg > d.max_deg) err(`${where} (${j.id}).${d.key}: value_deg, min_deg and max_deg must be finite with min <= max.`);
          else if (j.id !== "pelvis" && (d.value_deg < d.min_deg - 1e-3 || d.value_deg > d.max_deg + 1e-3)) warn(`${j.id}.${d.key} = ${d.value_deg} is outside its range ${d.min_deg} to ${d.max_deg}.`);
        }
      });
      for (const j of idx.values()) { // rigid links: the distance to the parent never changes
        if (!j.parent || !idx.has(j.parent)) continue;
        const pp = idx.get(j.parent).position_mm, d = Math.hypot(j.position_mm[0] - pp[0], j.position_mm[1] - pp[1], j.position_mm[2] - pp[2]), r = Math.hypot(...j.rest_offset_mm);
        if (Number.isFinite(d) && Number.isFinite(r) && Math.abs(d - r) > 0.05) err(`${j.id}: the distance to ${j.parent} is ${rnd(d, 3)} mm but its rest offset is ${rnd(r, 3)} mm (the links are rigid).`);
      }
    }
    if (!Array.isArray(b.landmarks)) err("body.landmarks must be a list.");
    else {
      const ids = new Set();
      for (const l of b.landmarks) {
        if (!isObj(l) || typeof l.id !== "string") { err("A landmark has no id."); continue; }
        if (ids.has(l.id)) err(`Landmark "${l.id}" is listed twice.`);
        ids.add(l.id);
        if (!JOINT_BY_ID[l.joint]) err(`Landmark "${l.id}" names the unknown joint ${JSON.stringify(l.joint)}.`);
        if (!Array.isArray(l.position_mm) || l.position_mm.length !== 3 || !l.position_mm.every(fin)) err(`Landmark "${l.id}": position_mm must be three finite numbers.`);
      }
    }
    if (!Array.isArray(b.segments)) err("body.segments must be a list.");
    else if (b.segments.length) {
      const sum = b.segments.reduce((s, x) => s + (fin(x?.mass_kg) ? x.mass_kg : NaN), 0);
      if (!Number.isFinite(sum)) err("Every segment needs a finite mass_kg.");
      else if (fin(b.mass_kg) && Math.abs(sum - b.mass_kg) > 0.05 * b.mass_kg) warn(`The segment masses add up to ${rnd(sum, 2)} kg, not ${b.mass_kg} kg.`);
    }
    if (!Array.isArray(b.dims)) err("body.dims must be a list.");
    const ps = doc.posture;
    if (!isObj(ps) || !isObj(ps.root) || !isObj(ps.angles)) err("posture needs root and angles.");
    else {
      for (const [id, a] of Object.entries(ps.angles)) { const j = JOINT_BY_ID[id]; if (!j) err(`posture.angles names the unknown joint "${id}".`); else if (!isObj(a) || Object.entries(a).some(([k, v]) => !j.dof.some((d) => d.key === k) || !fin(v))) err(`posture.angles.${id} must give numbers for ${j.dof.map((d) => d.key).join(", ")}.`); }
    }
    const pr = doc.placement?.root;
    if (!isObj(pr) || !["x_mm", "y_mm", "z_mm"].every((k) => fin(pr[k]))) err("placement.root needs x_mm, y_mm and z_mm.");
    if (!isObj(doc.scene) || !Array.isArray(doc.scene.objects)) err("scene.objects must be a list.");
    else doc.scene.objects.forEach((o, i) => { if (!isObj(o) || typeof o.type !== "string" || !Array.isArray(o.position_mm) || !o.position_mm.every(fin)) err(`scene.objects[${i}] needs a type and position_mm.`); });
    if (!Array.isArray(doc.measurements)) err("measurements must be a list.");
  } catch (e) { err(`The document could not be checked (${String(e?.message ?? e).slice(0, 100)}).`); }
  return finish();
  function finish() { return { ok: errors.length === 0, errors, warnings }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// posture files
const ROOT_KEYS = ["heading", "flex", "lat", "rot"];
const wrapOf = (a) => nz(Math.abs(a) <= 180 ? a : ((((a + 180) % 360) + 360) % 360) - 180);
/**
 * A Posture object (DESIGN.md 2.4) for the pose the figure is in. A library posture whose pose is exactly the figure's pose is returned as it is (a copy);
 * anything else becomes a custom posture that lists every non-zero joint by its own id (so it reproduces the pose exactly; the eyes are written in the
 * posture convention). Returns { posture, library: boolean }.
 */
export async function posturePostureOf(input) {
  const { rig, posture } = need(input);
  const pose = rig.getPose();
  if (posture?.id) {
    try {
      const { byId } = await import("./postures.js");
      const { expandPosture, clampPose, poseEquals } = await import("./pose.js");
      const lib = byId(posture.id);
      if (lib) {
        const x = expandPosture(lib), cur = { root: Object.fromEntries(ROOT_KEYS.map((k) => [k, pose.root[k]])), angles: pose.angles };
        if (poseEquals(clampPose({ root: x.root, angles: x.angles }).pose, cur, 1e-6)) return { posture: jsonCopy(lib), library: true };
      }
    } catch { /* no library: a custom posture below */ }
  }
  const joints = {};
  for (const [id, a] of Object.entries(pose.angles)) {
    if (id === "pelvis" || !a.some((v) => v)) continue;
    const v = [...a];
    if (id === "eye_R") v[1] = nz(-(v[1] ?? 0)); // posture convention: azim + looks to the figure's left for both eyes
    while (v.length > 1 && v[v.length - 1] === 0) v.pop();
    joints[id] = v.map((x) => rnd(x, 6));
  }
  const root = Object.fromEntries(ROOT_KEYS.map((k) => [k, rnd(pose.root[k] ?? 0, 6)]));
  const flat = Math.abs(root.flex) > 45 || Math.abs(root.lat) > 45;
  const name = cleanName(posture?.name, "Custom posture");
  return { library: false, posture: { id: `custom-${slug(posture?.id || posture?.name || "posture", 40) || "posture"}`, name, category: "Reference", tags: ["custom", "exported"], description: "Joint angles of the figure when it was exported from the Export tab.", source: "custom (exported)", root, spine: {}, joints, support: flat ? "body" : "feet" } };
}
/** The posture file: { app, version, posture, pose (root orientation + every non-zero joint, degrees, DOF order), placement, profile }. */
export async function buildPostureFile(input, { created = null } = {}) {
  const { rig, profile, posture: shellPosture } = need(input);
  const { posture, library } = await posturePostureOf(input);
  const pose = rig.getPose();
  const angles = {};
  for (const [id, a] of Object.entries(pose.angles)) if (a.some((v) => v)) angles[id] = a.map((x) => rnd(x, 6));
  return {
    app: POSTURE_APP, version: 1, generator: GENERATOR, ...(created ? { created: String(created) } : {}),
    units: { angle: "deg", length: "mm" }, axes: AXES_NOTE,
    posture, library_posture: library, shell: { id: shellPosture?.id ?? null, name: shellPosture?.name ?? null },
    pose: { root: Object.fromEntries(ROOT_KEYS.map((k) => [k, rnd(pose.root[k] ?? 0, 6)])), angles },
    placement: { root_mm: [mm3(rig.root.x), mm3(rig.root.y), mm3(rig.root.z)], note: "where the pelvis was; informational, a posture has no position" },
    profile: { id: profile?.id ?? null, label: profile?.label ?? null },
    note: MODEL_NOTE,
  };
}
/**
 * Read a posture file (text or object): the wrapper of buildPostureFile, a bare Posture object, or a bare pose { root, angles }. Never throws.
 * Returns { ok, errors, warnings, pose?: { root, angles } (clamped to the ranges of motion), posture?: object | null, support?: string, seatHeight?: number | null, name?, id?, clamped: [...] }.
 */
export async function parsePostureFile(input) {
  const errors = [], warnings = [], fail = () => ({ ok: false, errors, warnings, clamped: [] });
  try {
    let data = input;
    if (typeof input === "string") {
      if (input.length > MAX_POSTURE_TEXT) { errors.push(`The posture file is too large (more than ${Math.round(MAX_POSTURE_TEXT / 1e6)} MB).`); return fail(); }
      try { data = JSON.parse(input); } catch (e) { errors.push(`The file is not valid JSON (${String(e.message).slice(0, 100)}).`); return fail(); }
    }
    if (!isObj(data)) { errors.push("A posture file must be a JSON object."); return fail(); }
    let posture = null, pose = null;
    if (Object.hasOwn(data, "app")) {
      if (data.app !== POSTURE_APP) { errors.push(`This file is not a posture file (app is ${JSON.stringify(String(data.app).slice(0, 40))}). A scene file can be opened with "Load scene".`); return fail(); }
      if (!Number.isInteger(data.version) || data.version < 1) { errors.push("The posture file has no valid version number."); return fail(); }
      if (data.version > 1) { errors.push(`This posture was saved by a newer version of the tool (format ${data.version}); this one reads format 1.`); return fail(); }
      if (isObj(data.pose)) pose = data.pose;
      if (isObj(data.posture)) posture = data.posture;
    } else if (isObj(data.angles) || (isObj(data.root) && !Object.hasOwn(data, "joints") && !Object.hasOwn(data, "id"))) pose = data;
    else if (isObj(data.joints) || isObj(data.spine) || typeof data.id === "string") posture = data;
    else { errors.push("This file is neither a posture file, a posture (id, joints, spine ...) nor a pose (root, angles)."); return fail(); }
    const poseMod = await import("./pose.js");
    if (!pose && posture) {
      try { const x = poseMod.expandPosture(posture); pose = { root: x.root, angles: x.angles }; } catch (e) { errors.push(String(e.message).slice(0, 240)); return fail(); }
    }
    if (!pose) { errors.push("The file holds neither a pose nor a posture."); return fail(); }
    const root = {};
    if (pose.root != null) {
      if (!isObj(pose.root)) { errors.push("pose.root must be an object { heading, flex, lat, rot } in degrees."); return fail(); }
      for (const [k, v] of Object.entries(pose.root)) {
        if (k === "x" || k === "y" || k === "z") { warnings.push(`pose.root.${k} was ignored: a posture has no position, the figure is placed on its support.`); continue; }
        if (!ROOT_KEYS.includes(k)) { errors.push(`pose.root.${k} is not a root field (use ${ROOT_KEYS.join(", ")}).`); continue; }
        if (!fin(v) || Math.abs(v) > 3600) errors.push(`pose.root.${k} must be a number of degrees (found ${JSON.stringify(v)}).`); else root[k] = k === "heading" ? wrapOf(v) : v;
      }
    }
    const angles = {};
    if (pose.angles != null) {
      if (!isObj(pose.angles)) { errors.push("pose.angles must be an object { jointId: [degrees in DOF order] }."); return fail(); }
      for (const [id, a] of Object.entries(pose.angles)) {
        const j = Object.hasOwn(JOINT_BY_ID, id) ? JOINT_BY_ID[id] : null;
        if (!j) { errors.push(`pose.angles names the unknown joint "${String(id).slice(0, 40)}".`); continue; }
        if (!Array.isArray(a) || a.length > j.dof.length || !a.every(fin) || a.some((x) => Math.abs(x) > 3600)) { errors.push(`pose.angles.${id} must be ${j.dof.length === 1 ? "one number" : `up to ${j.dof.length} numbers`} in degrees (${j.dof.map((d) => d.key).join(", ")}).`); continue; }
        angles[id] = j.dof.map((_, i) => nz(a[i] ?? 0));
      }
    }
    if (errors.length) return fail();
    const full = { root: { heading: 0, flex: 0, lat: 0, rot: 0, ...root }, angles };
    const { pose: clampedPose, clamped } = poseMod.clampPose(full);
    for (const c of clamped.slice(0, 8)) warnings.push(`${c.joint} ${c.dof} = ${rnd(c.requested, 1)} degrees is outside its range and was limited to ${rnd(c.applied, 1)}.`);
    if (clamped.length > 8) warnings.push(`... and ${clamped.length - 8} more angles were limited to their ranges of motion.`);
    const support = typeof posture?.support === "string" && Object.hasOwn(poseMod.SUPPORT_CARRIERS, posture.support) ? posture.support : (Math.abs(full.root.flex) > 45 || Math.abs(full.root.lat) > 45 ? "body" : "feet");
    const seat = posture?.hints?.seat?.height, seatHeight = typeof seat === "number" && seat >= 0 && seat <= 1.5 ? seat : null;
    return { ok: true, errors, warnings, pose: clampedPose, posture: posture && typeof posture.id === "string" ? posture : null, support, seatHeight, id: typeof posture?.id === "string" ? posture.id : null, name: cleanName(posture?.name ?? data.shell?.name, "Imported posture"), clamped };
  } catch (e) {
    errors.push(`The posture could not be read (${String(e?.message ?? e).slice(0, 160)}).`);
    return fail();
  }
}

/**
 * Put a pose read by parsePostureFile on the figure: the figure is placed on the support of the posture (the floor for standing, the posture's own seat
 * height for seated postures, the body for lying ones; placePose of pose.js) and the angles are set, clamped to the ranges of motion. Returns what
 * rig.setPose returns ({ clamped }). `place: false` keeps the figure where it is and only changes the angles and the orientation.
 */
export async function applyPostureFile(rig, parsed, { place = true } = {}) {
  if (!parsed?.ok || !parsed.pose) throw new Error("There is no valid posture to apply.");
  const { placePose } = await import("./pose.js");
  const where = { support: parsed.support, ...(parsed.seatHeight != null ? { seatHeight: parsed.seatHeight } : {}) }; // the checked values, not the raw fields of the file
  const root = place ? placePose(rig.restBody, parsed.pose, where) : { ...parsed.pose.root, x: rig.root.x, y: rig.root.y, z: rig.root.z };
  return rig.setPose({ root: { ...root }, angles: parsed.pose.angles }, { clamp: true });
}
/** The scene file as text (Scene JSON of sandbox.js: objects, measurements, snapping), two-space indented. */
export function sceneFileText(sandbox) {
  if (!sandbox || typeof sandbox.toSceneFile !== "function") throw new Error("There is no scene yet. Open the Scene tab once, or load a scene file.");
  return JSON.stringify(sandbox.toSceneFile(), null, 2) + "\n";
}

// ---------------------------------------------------------------------------------------------------------------------
// summary text
const SUMMARY_DIMS = ["stature", "mass", "sitting_height", "eye_height_sitting", "acromion_height", "bideltoid_breadth", "buttock_knee_length", "hand_length", "foot_length", "span"];
const SUMMARY_METRICS = ["trunkInclination", "neckFlexion", "shoulderElevation_L", "shoulderElevation_R", "elbowAngle_L", "elbowAngle_R", "hipAngle_L", "hipAngle_R", "kneeAngle_L", "kneeAngle_R", "eyeHeight", "comOverBase"];
/**
 * A short plain-text summary for a report: profile, key dimensions, posture, the largest joint angles, placement, scene objects and measurements.
 * `metrics` = the rows of metricRows() (optional).
 */
export function summaryText(input, metrics = null) {
  const { rig, body, profile, posture, sandbox, measurements } = need(input);
  const pose = rig.getPose(), L = [];
  const f = (v, d = 0) => (v == null || !Number.isFinite(v) ? "-" : nz(rnd(v, d)).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  L.push("DIGITAL HUMAN SUMMARY", "", `Profile: ${profileLine(profile)}`);
  L.push(`Source: ${profile?.source?.kind ?? "unknown"}; body form: ${body.form ?? "unknown"}`);
  const rows = (body.report ?? []).filter((r) => r.kind === "measure"), byId = new Map(rows.map((r) => [r.id, r]));
  const dims = SUMMARY_DIMS.filter((id) => byId.has(id)).map((id) => { const r = byId.get(id), v = r.input ?? r.model; return `${r.label} ${f(v, r.unit === "kg" ? 1 : 0)} ${r.unit === "kg" ? "kg" : "mm"}${r.input == null ? " (model)" : ""}`; });
  if (dims.length) L.push("Key dimensions: " + dims.join("; "));
  else L.push(`Stature ${f((body.stature ?? 0) * 1000)} mm; mass ${f(body.mass, 1)} kg`);
  L.push("", `Posture: ${postureLine(posture)}`);
  const r = pose.root;
  L.push(`Root: heading ${f(r.heading, 1)}, tilt forward ${f(r.flex, 1)}, tilt sideways ${f(r.lat, 1)}, twist ${f(r.rot, 1)} degrees; pelvis at x ${f(rig.root.x * 1000)}, y ${f(rig.root.y * 1000)}, z ${f(rig.root.z * 1000)} mm`);
  const big = [];
  for (const j of JOINTS) (pose.angles[j.id] ?? []).forEach((v, i) => { if (Math.abs(v) >= 1 && !/^(thumb|index|middle|ring|little)_/.test(j.id)) big.push([Math.abs(v), `${j.label} ${j.dof[i].key} ${f(v, 0)}`]); });
  big.sort((a, b) => b[0] - a[0]);
  if (big.length) L.push(`Largest joint angles (degrees): ${big.slice(0, 8).map((x) => x[1]).join("; ")}${big.length > 8 ? `; ${big.length - 8} more` : ""}`);
  else L.push("All joint angles are 0 (neutral standing).");
  if (metrics?.length) {
    const by = new Map(metrics.map((m) => [m.key, m])), shown = SUMMARY_METRICS.map((k) => by.get(k)).filter((m) => m && m.value !== "").map((m) => `${m.label} ${f(Number(m.value), 0)}${m.unit ? ` ${m.unit}` : ""}`);
    if (shown.length) L.push("Posture metrics: " + shown.join("; "));
  }
  const objs = visibleObjects(sandbox);
  if (objs.length) L.push("", `Scene (${objs.length} object${objs.length === 1 ? "" : "s"}): ${objs.slice(0, 10).map((o) => cleanName(o.name)).join(", ")}${objs.length > 10 ? `, and ${objs.length - 10} more` : ""}`);
  if (measurements?.length) {
    L.push("", "Measurements:");
    for (const m of measurements.slice(0, 12)) L.push(`  ${cleanName(m.label, m.kind)}: ${m.value == null ? (m.status && m.status !== "ok" ? m.status : "-") : `${f(m.value, m.unit === "deg" ? 1 : 0)} ${m.unit}`}`);
    if (measurements.length > 12) L.push(`  ... ${measurements.length - 12} more`);
  }
  L.push("", "Units: millimetres, kilograms, degrees. Axes: +Y up, +Z in front of the figure, +X the figure's left; floor at y = 0.", MODEL_NOTE, `Made with ${GENERATOR}.`);
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------------
// images: the pure part (the capture itself is in panels/export.js)
/**
 * Recover colour and transparency from two renders of the same view over a black and over a white background (RGBA, 0 to 255, as read from a canvas).
 * Over background B a pixel is  C = a F + (1 - a) B,  so  a = 1 - (C_white - C_black)  and  F = C_black / a. Exact for anti-aliased edges, soft shadows and
 * see-through materials, because the framebuffer blends linearly. Returns un-premultiplied RGBA (Uint8ClampedArray).
 */
export function matteFromPair(black, white) {
  if (!black || !white || black.length !== white.length || black.length % 4) throw new RangeError("The two renders must have the same size.");
  const out = new Uint8ClampedArray(black.length);
  for (let i = 0; i < black.length; i += 4) {
    const a = 1 - ((white[i] - black[i]) + (white[i + 1] - black[i + 1]) + (white[i + 2] - black[i + 2])) / (3 * 255), al = a < 0 ? 0 : a > 1 ? 1 : a;
    if (al < 1 / 512) continue; // fully transparent: leave 0,0,0,0
    out[i] = black[i] / al; out[i + 1] = black[i + 1] / al; out[i + 2] = black[i + 2] / al; out[i + 3] = Math.round(al * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// size estimates for the panel (bytes; calibrated against real output in the tests)
const attrBytes = (g) => { let n = 0; for (const [k, a] of Object.entries(g.attributes ?? {})) if (k !== "uv") n += a.array?.byteLength ?? 0; return n + (g.index?.array?.byteLength ?? 0); }; // no uv: objectNodes leaves them out
function sceneMeshStats(sandbox) {
  let verts = 0, tris = 0, bytes = 0, meshes = 0;
  for (const o of visibleObjects(sandbox)) o.model.traverse((c) => { if (c.isMesh && c.geometry) { const p = c.geometry.getAttribute("position"); if (!p) return; meshes++; verts += p.count; tris += c.geometry.index ? c.geometry.index.count / 3 : p.count / 3; bytes += attrBytes(c.geometry); } });
  return { verts, tris, bytes, meshes };
}
/** Rough sizes in bytes of the files the panel offers: { glbSkin, glbSkeleton, glbScene, obj, objScene, stl, stlScene, bvh, json }. Within about +-25 % of the real files. */
export function estimateSizes(input) {
  const { rig, sandbox } = need(input);
  let v = 0, t = 0;
  for (const m of skinnedMeshes(rig)) { v += m.geometry.getAttribute("position").count; t += m.geometry.index ? m.geometry.index.count / 3 : 0; }
  const sc = sceneMeshStats(sandbox), ib = v > 65535 ? 4 : 2;
  return {
    glbSkin: Math.round(v * 48 + t * 3 * ib + 52000), glbSkeleton: 90000, glbScene: Math.round(sc.bytes + sc.meshes * 700 + visibleObjects(sandbox).length * 500),
    obj: Math.round(v * 125 + t * 30), objScene: Math.round(sc.verts * 125 + sc.tris * 30), stl: 84 + 50 * t, stlScene: 50 * Math.round(sc.tris),
    bvh: 14000, json: 260000, objects: visibleObjects(sandbox).length,
  };
}
export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
