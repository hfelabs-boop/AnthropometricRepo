// Shared helpers of the adversarial checks of the export module: rigs, a stub viewport for the sandbox, and readers written here (not taken from export.js or export.test.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { JOINTS, JOINT_BY_ID } from "../../site/js/human/skeleton.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";

export { THREE, JOINTS, JOINT_BY_ID, fitBody, buildRig, buildSkin, syntheticBody, createSandbox, createStore };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POP = (sex) => path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`);
export const haveData = fs.existsSync(POP("M")) && fs.existsSync(POP("F"));
export const army = (sex, percentile) => percentileProfile(JSON.parse(fs.readFileSync(POP(sex), "utf8")), { percentile });
export const D2R = Math.PI / 180;
export const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** A GLTFLoader from the npm package (r180), or null: GLTF_LOADER=<three>/examples/jsm/loaders/GLTFLoader.js (default: the scratch copy of this session). */
export async function loadGLTFLoader() {
  const cand = [process.env.GLTF_LOADER, "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/npm3/package/examples/jsm/loaders/GLTFLoader.js"].filter(Boolean);
  for (const c of cand) if (fs.existsSync(c)) return (await import(pathToFileURL(c).href)).GLTFLoader;
  return null;
}

export function makeRig(profile, { skin = true, quality = "high", body = null } = {}) {
  return buildRig(body ?? fitBody(profile, {}), { skinBuilder: skin ? buildSkin : null, quality });
}
const base = { category: "Reference", tags: [], description: "t", source: "illustrative" };
export function putPose(rig, def) {
  const x = expandPosture({ ...base, ...def });
  const root = placePose(rig.restBody, { root: x.root, angles: x.angles }, { support: def.support });
  return rig.setPose({ root: { ...root }, angles: x.angles }, { clamp: true });
}
export const POSTURES = {
  neutral: { id: "t-neutral", name: "Neutral standing", support: "feet" },
  squat: { id: "t-squat", name: "Deep squat", support: "feet", spine: { lumbar: [20, 0, 0] }, joints: { hip_LR: [125, 10, 0], knee_LR: [150, 0], ankle_LR: [30, 0, 0] } },
  supine: { id: "t-supine", name: "Lying on the back", support: "body", root: { flex: -90 }, joints: { knee_LR: [10, 0], shoulder_R: [20, 20, 10] } },
  prone: { id: "t-prone", name: "Prone", support: "body", root: { flex: 90, heading: 200 }, joints: { shoulder_LR: [160, 0, 0] } },
  side: { id: "t-side", name: "Side", support: "body", root: { lat: 90, rot: 30 }, joints: { hip_L: [100, 0, 0] } },
};

export function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 800 / 600, 0.05, 120), handlers = new Map(), container = new EventTarget();
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld();
  return {
    scene, camera, container, controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null, gizmoDragging: false, canvas: null,
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {},
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    ray() { return new THREE.Raycaster(); }, attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {},
  };
}
export function sceneFixture(rig) {
  const store = createStore(), viewport = stubViewport();
  const ctx = { state: store.state, viewport, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => rig, toast() {}, units: "mm" };
  const sandbox = createSandbox({ viewport, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  return { sandbox, ctx, viewport, store };
}

// ------------------------------------------------------------------------------------------------ readers
export function parseOBJ(text) {
  const v = [], vn = [], objects = [], comments = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) { comments.push(line); continue; }
    const t = line.trim().split(/\s+/);
    if (t[0] === "o") { cur = { name: line.slice(2), faces: [] }; objects.push(cur); }
    else if (t[0] === "v") v.push(t.slice(1, 4).map(Number));
    else if (t[0] === "vn") vn.push(t.slice(1, 4).map(Number));
    else if (t[0] === "f") { if (!cur) { cur = { name: "(none)", faces: [] }; objects.push(cur); } cur.faces.push(t.slice(1).map((s) => s.split("/").map((x) => (x === "" ? null : Number(x) - 1)))); }
  }
  return { v, vn, objects, comments };
}
export function parseSTL(ab) {
  const buf = Buffer.from(ab), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), n = dv.getUint32(80, true);
  if (buf.length !== 84 + 50 * n) throw new Error(`STL size ${buf.length} != ${84 + 50 * n}`);
  const tris = [];
  for (let i = 0; i < n; i++) { const o = 84 + 50 * i, f = (k) => dv.getFloat32(o + 4 * k, true); tris.push({ n: [f(0), f(1), f(2)], v: [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]] }); }
  return { header: buf.subarray(0, 80).toString("latin1"), tris };
}
export function signedVolume(tris) { let s = 0; for (const [a, b, c] of tris) s += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; return s; }

/** BVH: parse the text with a tokenizer written here; returns { joints:[{name,parent,offset,channels,end}], frames:[number[]], frameTime }. */
export function parseBVH(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("#")) i++;
  if (lines[i].trim() !== "HIERARCHY") throw new Error(`first word is ${lines[i]}`);
  i++;
  const joints = [], stack = [];
  let pending = null;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === "MOTION") break;
    if (t[0] === "ROOT" || t[0] === "JOINT") { pending = { name: t[1], parent: stack.length ? stack[stack.length - 1] : null, offset: null, channels: [], end: null }; joints.push(pending); }
    else if (t[0] === "End") pending = { endOf: stack[stack.length - 1] };
    else if (t[0] === "{") stack.push(pending.endOf ? pending : pending);
    else if (t[0] === "}") { const top = stack.pop(); }
    else if (t[0] === "OFFSET") { const o = t.slice(1).map(Number); if (pending.endOf) pending.endOf.end = o; else pending.offset = o; }
    else if (t[0] === "CHANNELS") pending.channels = t.slice(2);
    else if (t[0] === "") continue;
    else throw new Error(`unexpected line ${lines[i]}`);
  }
  // stack above holds objects; fix parents to names
  const byName = new Map(joints.map((j) => [j.name, j]));
  for (const j of joints) j.parent = j.parent && j.parent.name ? j.parent.name : null;
  if (lines[i].trim() !== "MOTION") throw new Error("no MOTION");
  const nf = Number(lines[i + 1].split(":")[1]), ft = Number(lines[i + 2].split(":")[1]);
  const frames = [];
  for (let k = 0; k < nf; k++) frames.push(lines[i + 3 + k].trim().split(/\s+/).map(Number));
  return { joints, byName, frames, frameTime: ft, nf, tail: lines.slice(i + 3 + nf) };
}
const E = (a, ax) => { const c = Math.cos(a), s = Math.sin(a); return ax === "X" ? new THREE.Matrix4().set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1) : ax === "Y" ? new THREE.Matrix4().set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1) : new THREE.Matrix4().set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); };
/** World matrices of every joint of a BVH frame by the standard BVH rule: channels are applied in the order listed (M = T * R_c1 * R_c2 * R_c3 ...), parent first. */
export function bvhWorld(b, frame, scale) {
  const f = b.frames[frame], world = new Map();
  let k = 0;
  for (const j of b.joints) {
    let m = new THREE.Matrix4().makeTranslation(...j.offset.map((v) => v * scale));
    for (const ch of j.channels) {
      const v = f[k++];
      if (ch.endsWith("position")) m = m.multiply(new THREE.Matrix4().makeTranslation(...(ch[0] === "X" ? [v * scale, 0, 0] : ch[0] === "Y" ? [0, v * scale, 0] : [0, 0, v * scale])));
      else m = m.multiply(E(v * D2R, ch[0]));
    }
    if (k > f.length) throw new Error("frame too short");
    world.set(j.name, j.parent ? world.get(j.parent).clone().multiply(m) : m);
  }
  if (k !== f.length) throw new Error(`frame has ${f.length} numbers, channels ${k}`);
  return world;
}
