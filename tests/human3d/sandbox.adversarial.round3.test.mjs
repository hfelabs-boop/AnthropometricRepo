// Round 3 adversarial tests (verifier). node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.round3.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createMeasure } from "../../site/js/human/measure.js";
import { createStore } from "../../site/js/human/state.js";

function stub() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 120);
  return { scene, camera, container: new EventTarget(), controls: { enabled: true }, active: true, theme: {}, add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {}, on() { return () => {}; },
    attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {} };
}
const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const mk = (storage) => {
  const vp = stub(), store = createStore(), timers = [];
  const ctx = { state: store.state, viewport: vp, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => null, toast() {}, units: "mm" };
  const sb = createSandbox({ viewport: vp, ctx, storage, scheduler: (fn) => { timers.push(fn); return () => {}; } });
  return { vp, ctx, sb, timers };
};

test("measure module disposed (tab torn down) keeps its measurements in the scene file; flushSave on dispose writes them", () => {
  const storage = memStore({ "hm-scene-remember": "1" });
  const { vp, ctx, sb, timers } = mk(storage);
  sb.setRemember(true);
  sb.add("box", { position: [0, 0, 1] });
  const ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (f) => f() });
  ms.addHeight({ kind: "world", p: [0, 1, 0] });
  assert.equal(ms.items.length, 1);
  ms.dispose();
  const f = sb.toSceneFile();
  assert.equal(f.measurements?.length, 1, "measurements survive the disposal of the measure module");
  sb.add("box", { position: [1, 0, 1] }); // an edit after the measure module went away
  sb.dispose();
  const saved = JSON.parse(storage.getItem("hm-scene"));
  assert.equal(saved.objects.length, 2, "dispose flushes the pending autosave");
  assert.equal(saved.measurements?.length, 1, "and keeps the measurements");
  void timers;
});

test("a scene file whose measurements section is hostile (not an array / huge / nested) is neither echoed unbounded nor breaks a later measure module", () => {
  const { vp, ctx, sb } = mk(undefined);
  const hostile = { app: "digital-human-scene", version: 1, objects: [], measurements: { __proto__: { x: 1 }, a: "x".repeat(10) } };
  const r = sb.fromJSON(JSON.stringify(hostile));
  assert.ok(r.ok);
  const ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (f) => f() });
  assert.equal(ms.items.length, 0);
  const f = JSON.parse(JSON.stringify(sb.toSceneFile()));
  assert.ok(Array.isArray(f.measurements) || f.measurements === undefined, `measurements section written back is ${JSON.stringify(f.measurements)}`);
});

test("DEFECT (low, API only: the panel always registers measure first): pending measurements of a scene opened before the measure module existed: Open scene (replace) then Undo brings them back", () => {
  const { vp, ctx, sb } = mk(undefined);
  const withM = { app: "digital-human-scene", version: 1, objects: [{ id: "o1", type: "box" }], measurements: [{ id: "m1", kind: "height", a: { kind: "world", p: [0, 1, 0] } }] };
  sb.fromJSON(withM);
  sb.fromJSON({ app: "digital-human-scene", version: 1, objects: [{ id: "o2", type: "crate" }] });
  sb.undo();
  const ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (f) => f() });
  assert.equal([...sb.objects.keys()].join(), "o1");
  assert.equal(ms.items.length, 1, "the measurement of the restored scene is back with its objects");
});
