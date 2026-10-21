// Mutation fuzz of scene files: take a valid scene (objects, attachments, measurements, snap), mutate random nodes into hostile values, load it, then exercise everything
// that reads the loaded data (evaluate, format, exports, labels, redraw, save, undo). Nothing may throw, hang (each load is timed) or leak NaN.
// node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.fuzz4.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createMeasure } from "../../site/js/human/measure.js";
import { createStore } from "../../site/js/human/state.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { buildRig } from "../../site/js/human/rig.js";

function stub() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 120);
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld();
  const labels = new Map();
  return { scene, camera, container: new EventTarget(), controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null,
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {}, on() { return () => {}; }, ray() { return new THREE.Raycaster(); }, attachGizmo(o) { this.gizmo = { object: o }; }, detachGizmo() { this.gizmo = null; },
    setGizmoOptions() {}, setCursor() {}, addLabelSource(k, f) { labels.set(k, f); return () => labels.delete(k); }, removeLabelSource(k) { labels.delete(k); }, frame() {}, project(v) { return { x: 100, y: 100, visible: true }; }, labelFns: labels };
}
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const HOSTILE = [null, undefined, NaN, Infinity, -Infinity, 1e308, -1e308, 1e-320, -0, 0, 1, -1, 3.5, 2 ** 53, 2 ** 31, "", " ", "abc", "1", "NaN", "1e999", "__proto__", "constructor", "toString", "o1", "m1", "<script>", "\u0000", "‮x", [], [1], [1, 2, 3], [NaN, 1, 2], ["a", "b", "c"], {}, { x: 1 }, { __proto__: { polluted: 1 } }, true, false, "#ff00ff", "#GG0000", "x".repeat(5000), [[[]]], { kind: "joint", id: "pelvis" }, { kind: "world", p: [0, 0, 0] }];
function mutate(node, R, depth = 0) {
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  for (const k of keys) {
    const x = R();
    if (x < 0.12) node[k] = HOSTILE[Math.floor(R() * HOSTILE.length)];
    else if (x < 0.15) { if (Array.isArray(node)) node[k] = null; else delete node[k]; }
    else if (typeof node[k] === "object" && depth < 6) mutate(node[k], R, depth + 1);
    else if (typeof node[k] === "number" && x < 0.25) node[k] = node[k] * (R() < 0.5 ? 1e6 : -1);
  }
  if (!Array.isArray(node) && R() < 0.05) node[["__proto__", "constructor", "hasOwnProperty", "x"][Math.floor(R() * 4)]] = HOSTILE[Math.floor(R() * HOSTILE.length)];
  return node;
}
const base = () => ({
  app: "digital-human-scene", version: 1, snap: { gridMm: 10, angleDeg: 5 },
  objects: [
    { id: "o1", type: "cabin_seat", name: "Seat", params: { seatHeight: 0.4, recline: 110 }, color: "#3a74b8", position: [0, 0, 0.6], yaw: 0, locked: false, visible: true },
    { id: "o2", type: "triple_monitor", name: "Screens", params: { diagonal: 27 }, position: [0, 0, 1.6], yaw: 180 },
    { id: "o3", type: "crate", params: { mass: 20 }, position: [0.8, 0, 0.5], yaw: 30, attachedTo: { kind: "joint", id: "wrist_L", offset: [0.1, 0, 0], local: true, orient: true } },
    { id: "o4", type: "box", position: [-1, 0, 1], yaw: -90 },
  ],
  measurements: [
    { id: "m1", kind: "distance", a: { kind: "landmark", id: "eye_mid" }, b: { kind: "object", id: "o2", anchor: "screen_centre" }, label: "Eye to screen", color: "accent", visible: true },
    { id: "m2", kind: "height", a: { kind: "joint", id: "T9", local: [0.01, 0, 0.1] } },
    { id: "m3", kind: "angle", a: { kind: "joint", id: "shoulder_L" }, b: { kind: "joint", id: "elbow_L" }, c: { kind: "joint", id: "wrist_L" } },
    { id: "m4", kind: "view", a: { kind: "landmark", id: "eye_mid" }, b: { kind: "object", id: "o2", anchor: "screen_centre" } },
    { id: "m5", kind: "distance", a: { kind: "object", id: "o1", local: [0, 0.2, 0] }, b: { kind: "world", p: [1, 1, 1] } },
  ],
});

test("mutated scene files: no throw, no hang, no NaN, exports and labels stay valid", () => {
  const rig = buildRig(syntheticBody(1.75, "male"), { skeleton: false });
  let slowest = 0, loaded = 0, rejected = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const R = rng(seed), vp = stub(), store = createStore();
    const ctx = { state: store.state, viewport: vp, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => rig, toast() {}, units: ["mm", "cm", "in"][seed % 3] };
    const sb = createSandbox({ viewport: vp, ctx, scheduler: () => () => {} });
    const ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (f) => f() });
    const doc = mutate(base(), R);
    const t0 = performance.now();
    let r;
    try { r = sb.fromJSON(R() < 0.5 ? JSON.stringify(doc) : doc); } catch (e) { assert.fail(`seed ${seed}: fromJSON threw ${e.stack}\n${JSON.stringify(doc).slice(0, 600)}`); }
    slowest = Math.max(slowest, performance.now() - t0);
    if (!r.ok) { rejected++; sb.dispose(); ms.dispose(); continue; }
    loaded++;
    try {
      for (const o of sb.objects.values()) {
        assert.ok(o.position.every(Number.isFinite) && Number.isFinite(o.yaw), `seed ${seed}: NaN position ${o.id} ${o.type} ${o.position} yaw ${o.yaw} att ${JSON.stringify(o.attachedTo)}`);
        assert.ok(Number.isFinite(o.bbox.max.x) && !o.bbox.isEmpty(), `seed ${seed}: bad bbox`);
        assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(o.id), `seed ${seed}: odd id ${o.id}`);
        assert.ok(typeof o.name === "string" && o.name.length <= 60, `seed ${seed}: name`);
      }
      ms.flush();
      for (const it of ms.items) {
        const res = ms.evaluate(it);
        if (res.ok) assert.ok(Number.isFinite(res.value), `seed ${seed}: non-finite value`);
        const text = ms.format(res) + ms.formatDeltas(res);
        assert.ok(!/NaN|Infinity|undefined|null/.test(text), `seed ${seed}: bad text ${text}`);
      }
      const csv = ms.toCSV(), json = ms.toResultsJSON();
      const walk = (v) => { if (typeof v === "number") assert.ok(Number.isFinite(v), `seed ${seed}: non-finite number in the results JSON`); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
      walk(JSON.parse(json)); assert.ok(typeof csv === "string");
      for (const f of vp.labelFns.values()) for (const l of f()) assert.ok(l.position.toArray().every(Number.isFinite) && typeof l.text === "string" && !/NaN|undefined/.test(l.text), `seed ${seed}: label ${JSON.stringify(l.text)}`);
      sb.updateAttached(); sb.supportsWorld(); sb.bounds(); for (const o of sb.objects.values()) { sb.gripsWorld(o.id); sb.anchorsWorld(o.id); }
      const file = sb.toSceneFile(); const again = sb.fromJSON(JSON.stringify(file)); assert.ok(again.ok, `seed ${seed}: own file not accepted: ${JSON.stringify(again.errors)}`);
      sb.undo(); sb.redo();
    } catch (e) { e.message = `seed ${seed}: ${e.message}\n${JSON.stringify(doc).slice(0, 800)}`; throw e; }
    sb.dispose(); ms.dispose();
  }
  console.log(`loaded ${loaded}, rejected ${rejected}, slowest load ${slowest.toFixed(1)} ms`);
  assert.ok(loaded > 100);
});
