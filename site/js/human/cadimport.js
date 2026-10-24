// Import of CAD and 3D files into the Scene: the asset registry behind the catalogue type "cad_model" (catalog.js).
//
//   importCadFile(file | { name, buffer }, { units, up }) -> { id, asset, units, up, warnings }   read, convert, register, keep in this browser
//   ensureAsset(id) -> asset | null          the asset of an id: from memory, else from this browser's storage (IndexedDB), else null
//   getAsset(id), assetBytes(id), embedAssets(ids) / restoreAssets(section)   for scene files that carry their models
//   parseCad(buffer, name) -> { object, format, warnings }                   the raw model (source units and axes), no registry
//
// Formats. glTF / GLB, OBJ, STL, PLY, FBX, 3MF and COLLADA (DAE) are read with the three.js loaders (vendor/three/addons/loaders, loaded on demand).
// STEP, IGES and BREP are converted with OpenCascade (occt-import-js 0.0.23, LGPL-2.1, vendor/occt, 7.6 MB of WebAssembly loaded on the first such
// file) in a Web Worker (cadworker.js), triangulated in metres. A .gltf must be self-contained (embedded buffers); OBJ materials (.mtl) and FBX / glTF
// textures in separate files are not read: such parts come in grey.
//
// Units and axes. glTF, COLLADA and the OpenCascade output are in metres; glTF and COLLADA are Y-up (the loaders turn COLLADA files that say Z-up).
// STL, OBJ, PLY and 3MF carry no units: the size decides (more than 100 across: millimetres; more than 10: centimetres; else metres); FBX is
// centimetres unless it is smaller than 5 units. CAD formats (STEP, IGES, STL, 3MF) are taken as Z-up, mesh formats as Y-up. Both are only guesses:
// the object's settings change them, and the import report says what was assumed and why.
//
// Layers. The parts a user may want to hide (a canopy, a door, a console): the children of the model's root, or of the first node that has more than
// one child when the root is a chain of single-child groups (glTF scenes, STEP assemblies). Each layer is addressed by its path of child indices.
//
// Storage. A file is identified by its SHA-256. Its bytes are kept in this browser's IndexedDB ("hm-cad", store "files") so that a remembered scene
// opens with its models next time; a scene file saved from the Scene panel embeds them (base64), so it can be opened elsewhere. Nothing is uploaded.
import * as THREE from "three";
import { setAssetSource, notifyAssetReady, UNIT_FACTORS } from "./catalog.js";

export const MAX_FILE_BYTES = 250e6;
export const MAX_LAYERS = 400;
export const CAD_FORMATS = Object.freeze([
  { id: "gltf", ext: ["glb", "gltf"], label: "glTF / GLB", units: "m", up: "y" },
  { id: "step", ext: ["step", "stp"], label: "STEP", units: "m", up: "z", occt: true },
  { id: "iges", ext: ["iges", "igs"], label: "IGES", units: "m", up: "z", occt: true },
  { id: "brep", ext: ["brep", "brp"], label: "OpenCascade BREP", units: "auto", up: "z", occt: true },
  { id: "stl", ext: ["stl"], label: "STL", units: "auto", up: "z" },
  { id: "obj", ext: ["obj"], label: "Wavefront OBJ", units: "auto", up: "y" },
  { id: "ply", ext: ["ply"], label: "PLY", units: "auto", up: "y" },
  { id: "fbx", ext: ["fbx"], label: "FBX", units: "fbx", up: "y" },
  { id: "3mf", ext: ["3mf"], label: "3MF", units: "auto", up: "z" },
  { id: "dae", ext: ["dae"], label: "COLLADA", units: "m", up: "y" },
]);
/** The `accept` list of a file input. */
export const CAD_ACCEPT = CAD_FORMATS.flatMap((f) => f.ext.map((e) => `.${e}`)).join(",");
/** The format of a file name (by extension), or null. */
export function formatOf(name) {
  const ext = String(name ?? "").toLowerCase().split(".").pop();
  return CAD_FORMATS.find((f) => f.ext.includes(ext)) ?? null;
}

/** Units to assume for a format and the largest extent of the model in file units: [unit, reason]. */
export function guessUnits(format, extent) {
  const f = typeof format === "string" ? CAD_FORMATS.find((x) => x.id === format) : format;
  if (f?.occt) return ["m", `OpenCascade converts ${f.label} from the units the file declares to metres`];
  if (f && f.units !== "auto" && f.units !== "fbx") return [f.units, `${f.label} files are in metres`];
  const e = Number.isFinite(extent) ? extent : 0, size = `${Math.round(e * 100) / 100} units across`;
  if (f?.units === "fbx") return e < 5 ? ["m", `the model is ${size}: too small for centimetres`] : ["cm", "FBX files are usually in centimetres"];
  if (e > 100) return ["mm", `the model is ${size}`];
  if (e > 10) return ["cm", `the model is ${size}`];
  return ["m", `the model is ${size}`];
}
const sizeOf = (obj) => { obj.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(obj); return b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3()); };

// ---- parsing -------------------------------------------------------------------------------------------------------------------------------------
const GREY = () => new THREE.MeshStandardMaterial({ color: 0xa7adb4, roughness: 0.6, metalness: 0.1 });
const loaders = {};
const loader = async (name, file) => (loaders[name] ??= import(`three/addons/loaders/${file}`).then((m) => m[name]));
const text = (buf) => new TextDecoder().decode(buf);

/** A model from the JSON of occt-import-js: { root: { name, meshes, children }, meshes: [{ name, color, attributes, index, brep_faces }] } -> THREE.Group. */
export function occtToThree(result) {
  const meshes = (result.meshes ?? []).map((m, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(m.attributes.position.array), 3));
    if (m.attributes.normal?.array?.length) g.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(m.attributes.normal.array), 3));
    const idx = m.index?.array ?? [];
    const n = g.attributes.position.count;
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), 1));
    if (!g.attributes.normal) g.computeVertexNormals();
    const faces = m.brep_faces ?? [];
    let material;
    if (faces.some((f) => f.color)) { // per-face colours of the b-rep: one group per face
      const mats = [], key = new Map();
      for (const f of faces) {
        const c = f.color ?? m.color ?? null, k = c ? c.join(",") : "none";
        if (!key.has(k)) { key.set(k, mats.length); mats.push(c ? new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.55, metalness: 0.1 }) : GREY()); }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, key.get(k));
      }
      material = mats;
    } else material = m.color ? new THREE.MeshStandardMaterial({ color: new THREE.Color(m.color[0], m.color[1], m.color[2]), roughness: 0.55, metalness: 0.1 }) : GREY();
    const mesh = new THREE.Mesh(g, material);
    mesh.name = m.name || `Part ${i + 1}`;
    return mesh;
  });
  const used = new Set();
  const node = (n) => {
    const grp = new THREE.Group();
    grp.name = n?.name || "";
    for (const k of n?.meshes ?? []) if (meshes[k] && !used.has(k)) { grp.add(meshes[k]); used.add(k); }
    for (const c of n?.children ?? []) grp.add(node(c));
    return grp;
  };
  const root = node(result.root);
  meshes.forEach((m, k) => { if (!used.has(k)) root.add(m); });
  return root;
}

let worker = null, workerSeq = 0;
const pending = new Map();
/** Convert a STEP / IGES / BREP file with OpenCascade in a worker. Resolves the occt-import-js result. */
function occtConvert(format, buffer) {
  if (typeof Worker === "undefined") return Promise.reject(new Error("STEP, IGES and BREP files need a browser (Web Workers)"));
  if (!worker) {
    worker = new Worker(new URL("./cadworker.js", import.meta.url));
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (!p) return; pending.delete(ev.data.id); if (ev.data.ok) p.resolve(ev.data.result); else p.reject(new Error(ev.data.error || "the file could not be converted")); };
    worker.onerror = (ev) => { const err = new Error(`the converter failed to load (${ev.message || "network or memory"})`); for (const p of pending.values()) p.reject(err); pending.clear(); worker?.terminate(); worker = null; };
  }
  const id = ++workerSeq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, format, buffer }, []); });
}

/**
 * Read a file into a THREE.Object3D, in its own units and axes. buffer: ArrayBuffer. Returns { object, format, warnings }. Throws an Error that says
 * what is wrong (unknown format, a file the loader rejects, an empty model).
 */
export async function parseCad(buffer, name, { onProgress } = {}) {
  const fmt = formatOf(name);
  if (!fmt) throw new Error(`"${name}" is not a format this tool reads (${CAD_FORMATS.map((f) => f.label).join(", ")})`);
  const warnings = [];
  let object;
  const say = (t) => { try { onProgress?.(t); } catch { /* the UI is gone */ } };
  if (fmt.id === "gltf") {
    const GLTFLoader = await loader("GLTFLoader", "GLTFLoader.js");
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, "", res, (e) => rej(new Error(e?.message ?? String(e)))));
    object = gltf.scene ?? gltf.scenes?.[0];
    if (gltf.animations?.length) warnings.push("The file's animations are not played; the model is shown in its rest pose.");
  } else if (fmt.id === "stl") {
    const STLLoader = await loader("STLLoader", "STLLoader.js");
    const g = new STLLoader().parse(buffer);
    if (!g.attributes.normal) g.computeVertexNormals();
    const colors = !!g.attributes.color;
    object = new THREE.Group();
    object.add(new THREE.Mesh(g, colors ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }) : GREY()));
    object.children[0].name = name.replace(/\.[^.]+$/, "");
  } else if (fmt.id === "obj") {
    const OBJLoader = await loader("OBJLoader", "OBJLoader.js");
    object = new OBJLoader().parse(text(buffer));
    if (/^\s*mtllib\s/m.test(text(buffer.slice(0, Math.min(buffer.byteLength, 65536))))) warnings.push("The OBJ names a material library (.mtl); it is not read, so the model is grey (choose a colour in its settings).");
    object.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(() => GREY()) : GREY(); });
  } else if (fmt.id === "ply") {
    const PLYLoader = await loader("PLYLoader", "PLYLoader.js");
    const g = new PLYLoader().parse(buffer);
    if (!g.attributes.normal && g.index) g.computeVertexNormals();
    if (!g.index) warnings.push("The PLY file has no faces (a point cloud): it is shown as points.");
    object = new THREE.Group();
    object.add(g.index ? new THREE.Mesh(g, g.attributes.color ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }) : GREY()) : new THREE.Points(g, new THREE.PointsMaterial({ size: 0.01, vertexColors: !!g.attributes.color })));
  } else if (fmt.id === "fbx") {
    const FBXLoader = await loader("FBXLoader", "FBXLoader.js");
    object = new FBXLoader().parse(buffer, "");
    if (object.animations?.length) warnings.push("The file's animations are not played; the model is shown in its rest pose.");
  } else if (fmt.id === "3mf") {
    const ThreeMFLoader = await loader("ThreeMFLoader", "3MFLoader.js");
    object = new ThreeMFLoader().parse(buffer);
  } else if (fmt.id === "dae") {
    const ColladaLoader = await loader("ColladaLoader", "ColladaLoader.js");
    const r = new ColladaLoader().parse(text(buffer), "");
    object = r?.scene;
    if (object) { object.rotation.set(0, 0, 0); object.updateMatrix(); } // the loader turns a Z-up file itself through this rotation; the model's `up` setting does it instead
    if (r?.scene && /<up_axis>\s*Z_UP/i.test(text(buffer.slice(0, Math.min(buffer.byteLength, 65536))))) warnings.push("The COLLADA file says Z is up.");
  } else if (fmt.occt) {
    say(`Converting the ${fmt.label} file with OpenCascade (the converter, 7.6 MB, is downloaded the first time)…`);
    const res = await occtConvert(fmt.id, buffer);
    if (!res?.success) throw new Error(`OpenCascade could not read this ${fmt.label} file`);
    object = occtToThree(res);
  }
  if (!object) throw new Error("the file holds no model");
  let tris = 0, meshes = 0;
  object.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) { meshes++; tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3; }
    if ((o.isMesh || o.isPoints) && o.geometry) o.geometry.userData.shared = true; // owned by the asset, never disposed by a copy (catalog.js disposeObject)
    if (o.isSkinnedMesh) o.bind?.(o.skeleton, o.bindMatrix);
  });
  if (!meshes && !object.getObjectByProperty("isPoints", true)) throw new Error("the file holds no surfaces (only empty nodes, curves or lights)");
  if (tris > 3e6) warnings.push(`The model has ${Math.round(tris / 1e5) / 10} million triangles: the view may be slow. A simplified export (fewer triangles) works better.`);
  return { object, format: fmt, warnings, triangles: Math.round(tris), meshes };
}

/** The layers of a model: [{ name, path: [child indices from the root], triangles }]. */
export function collectLayers(object) {
  let base = object, path = [];
  while (base.children.length === 1 && base.children[0].children.length > 0 && !base.children[0].isMesh) { base = base.children[0]; path = [...path, 0]; }
  const tri = (o) => { let n = 0; o.traverse((x) => { const g = x.geometry; if (x.isMesh && g?.attributes?.position) n += g.index ? g.index.count / 3 : g.attributes.position.count / 3; }); return Math.round(n); };
  const kids = base.children.length ? base.children : [base];
  const out = kids.slice(0, MAX_LAYERS).map((c, i) => ({ name: (c.name || "").trim().slice(0, 80) || `Part ${i + 1}`, path: base === object && !base.children.length ? [] : [...path, i], triangles: tri(c) }));
  // duplicate names get a number, so that the list can be read
  const seen = new Map();
  for (const l of out) { const n = (seen.get(l.name) ?? 0) + 1; seen.set(l.name, n); if (n > 1) l.name = `${l.name} (${n})`; }
  return out;
}

// ---- registry and storage ---------------------------------------------------------------------------------------------------------------------
const ASSETS = new Map(); // id -> { id, name, format, object, layers, triangles, extent (file units), bytes (ArrayBuffer), warnings }
const LOADING = new Map();
export const getAsset = (id) => ASSETS.get(id) ?? null;
export const assetBytes = (id) => ASSETS.get(id)?.bytes ?? null;
setAssetSource({ get: getAsset, request: (id) => ensureAsset(id) });

/** SHA-256 of a buffer, lower-case hex. */
export async function hashBuffer(buffer) {
  const d = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DB = "hm-cad", STORE = "files";
function db() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = globalThis.indexedDB?.open(DB, 1); } catch (e) { reject(e); return; }
    if (!req) { reject(new Error("no IndexedDB")); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode), st = tx.objectStore(STORE), r = fn(st);
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { d.close(); }
}
/** Keep a file's bytes in this browser. Never throws: returns false when storage is not available or full. */
export async function storeFile(id, { name, format, bytes }) {
  try { await idb("readwrite", (st) => st.put({ name, format, bytes, saved: Date.now() }, id)); return true; } catch { return false; }
}
/** A stored file { name, format, bytes } or null. */
export async function loadFile(id) {
  try { return (await idb("readonly", (st) => st.get(id))) ?? null; } catch { return null; }
}
/** Forget a stored file. */
export async function deleteFile(id) { try { await idb("readwrite", (st) => st.delete(id)); return true; } catch { return false; } }

async function register(id, name, buffer, parsed) {
  const asset = { id, name, format: parsed.format.id, formatLabel: parsed.format.label, object: parsed.object, layers: collectLayers(parsed.object), triangles: parsed.triangles, bytes: buffer, warnings: parsed.warnings };
  const s = sizeOf(parsed.object);
  asset.extent = Math.max(s.x, s.y, s.z);
  ASSETS.set(id, asset);
  notifyAssetReady(id);
  return asset;
}

/**
 * Import a file: { name, buffer } or a File. opts: { units: "auto" | unit, up: "auto" | "y" | "z", onProgress(text) }. Returns { id, asset, units, up, unitsWhy,
 * warnings, stored }: the settings to give the cad_model object. Throws with a message for the user.
 */
export async function importCadFile(file, { units = "auto", up = "auto", onProgress } = {}) {
  const name = String(file?.name ?? "model").slice(0, 160);
  const fmt = formatOf(name);
  if (!fmt) throw new Error(`"${name}" is not a format this tool reads. Use ${CAD_FORMATS.map((f) => f.label).join(", ")}.`);
  const size = file?.size ?? file?.buffer?.byteLength ?? 0;
  if (size > MAX_FILE_BYTES) throw new Error(`The file is ${Math.round(size / 1e6)} MB; the limit is ${MAX_FILE_BYTES / 1e6} MB. Export a simplified model.`);
  onProgress?.(`Reading ${name}…`);
  const buffer = file.buffer ?? (await file.arrayBuffer());
  const id = await hashBuffer(buffer);
  let asset = getAsset(id);
  const fresh = !asset;
  if (!asset) {
    const parsed = await parseCad(buffer, name, { onProgress });
    asset = await register(id, name, buffer, parsed);
  }
  const [gu, why] = guessUnits(fmt, asset.extent);
  const u = units !== "auto" && Object.hasOwn(UNIT_FACTORS, units) ? units : gu;
  const ax = up === "y" || up === "z" ? up : fmt.up;
  onProgress?.("Keeping a copy in this browser…");
  const stored = await storeFile(id, { name, format: fmt.id, bytes: buffer });
  return { id, asset, fresh, units: u, up: ax, unitsWhy: units === "auto" ? why : "chosen", warnings: asset.warnings, stored };
}

/** The asset of an id, loading it from this browser's storage when needed. Resolves null when it is not stored here. */
export function ensureAsset(id) {
  if (ASSETS.has(id)) return Promise.resolve(ASSETS.get(id));
  if (LOADING.has(id)) return LOADING.get(id);
  const p = (async () => {
    const f = await loadFile(id);
    if (!f?.bytes) return null;
    try { return await register(id, f.name, f.bytes, await parseCad(f.bytes, f.name)); } catch (e) { console.warn(`cadimport: the stored model ${f.name} could not be read:`, e); return null; }
  })().finally(() => LOADING.delete(id));
  LOADING.set(id, p);
  return p;
}

const toB64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (t) => { const s = atob(t), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; };
/** The "assets" section of a scene file for these asset ids: { id: { name, format, data (base64) } }, and the ids that are missing or too large. */
export function embedAssets(ids, { maxBytes = 150e6 } = {}) {
  const out = {}, missing = [], skipped = [];
  let total = 0;
  for (const id of new Set(ids)) {
    const a = getAsset(id);
    if (!a?.bytes) { missing.push(id); continue; }
    if (total + a.bytes.byteLength > maxBytes) { skipped.push(a.name); continue; }
    total += a.bytes.byteLength;
    out[id] = { name: a.name, format: a.format, data: toB64(a.bytes) };
  }
  return { assets: out, missing, skipped, bytes: total };
}
/** Read the "assets" section of a scene file: every model whose bytes hash to its id is registered and kept in this browser. Returns { loaded, failed }. */
export async function restoreAssets(section, { onProgress } = {}) {
  const loaded = [], failed = [];
  if (!section || typeof section !== "object") return { loaded, failed };
  for (const [id, e] of Object.entries(section)) {
    try {
      if (!/^[0-9a-f]{64}$/.test(id) || typeof e?.data !== "string" || typeof e?.name !== "string") throw new Error("malformed entry");
      if (ASSETS.has(id)) { loaded.push(e.name); continue; }
      onProgress?.(`Reading ${e.name}…`);
      const buffer = fromB64(e.data);
      if ((await hashBuffer(buffer)) !== id) throw new Error("its content does not match its id");
      await register(id, e.name, buffer, await parseCad(buffer, e.name, { onProgress }));
      await storeFile(id, { name: e.name, format: e.format, bytes: buffer });
      loaded.push(e.name);
    } catch (err) { failed.push(`${e?.name ?? id.slice(0, 8)}: ${err.message}`); }
  }
  return { loaded, failed };
}
