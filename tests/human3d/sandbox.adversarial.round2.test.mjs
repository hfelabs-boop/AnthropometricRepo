// Round 2 adversarial tests (verifier). Titles that start with "DEFECT" assert the CORRECT behaviour and FAIL while the defect exists.
// node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.round2.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { byType } from "../../site/js/human/catalog.js";
import { angleAt } from "../../site/js/human/measure.js";

const V = (a) => new THREE.Vector3(...a);

test("DEFECT: triple monitor side panels wrap TOWARDS the user (a smaller angle between panels turns the sides inwards)", () => {
  // the user sits at +Z of the array looking at -Z (objects face +Z). The eye is 0.7 m in front of the centre screen.
  const eye = new THREE.Vector3(0, 1.15, 0.7);
  const incidence = (params) => { const a = byType("triple_monitor").anchors(params), s = a.left_screen; return angleAt(eye, V(s.position), V(s.position).add(V(s.normal))); };
  const flat = incidence({ panelAngle: 180 }), wrapped = incidence({ panelAngle: 140 });
  assert.ok(wrapped < flat - 5, `turning the side panels in should bring the line of sight closer to their normal: flat ${flat.toFixed(1)} deg, 140 deg array ${wrapped.toFixed(1)} deg`);
  // and the outer edge of a side panel must come closer to the user than its inner edge, not move away
  const a = byType("triple_monitor").anchors({ panelAngle: 140 });
  assert.ok(a.left_outer_edge.position[2] > a.left_screen.position[2], `outer edge z ${a.left_outer_edge.position[2]} should be in front of the panel centre z ${a.left_screen.position[2]}`);
});

test("DEFECT: triple monitor 'left' / 'right' side screens are named from the user's side like the single monitor's left_edge (viewer's left)", () => {
  const mono = byType("monitor").anchors({}), tri = byType("triple_monitor").anchors({});
  assert.ok(mono.left_edge.label.includes("viewer's left") && mono.left_edge.position[0] < 0, "monitor: the viewer's left is -X in the object frame");
  assert.ok(tri.left_screen.position[0] < 0, `Side screen "left" is at x = ${tri.left_screen.position[0]} (the viewer's RIGHT); its label says "${tri.left_screen.label}"`);
});

// ---------------------------------------------------------------------------------------------------------------------
import { createSandbox, sandboxFor } from "../../site/js/human/sandbox.js";
import { measureFor, createMeasure } from "../../site/js/human/measure.js";
import { createStore } from "../../site/js/human/state.js";

function stub() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 120);
  return { scene, camera, container: new EventTarget(), controls: { enabled: true }, active: true, theme: {}, add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {}, on() { return () => {}; },
    attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {} };
}
const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test("DEFECT: 'Remember this scene' restores the measurements too (the Scene panel restores the sandbox before the measure module has registered its section) and does not overwrite them", () => {
  const scene = { app: "digital-human-scene", version: 1, objects: [{ id: "o1", type: "monitor", position: [0, 0, 1.5] }],
    measurements: [{ id: "m1", kind: "height", a: { kind: "world", p: [0, 1.5, 0] }, label: "Remembered" }], snap: { gridMm: 0, angleDeg: 0 } };
  const storage = memStore({ "hm-scene-remember": "1", "hm-scene": JSON.stringify(scene) });
  const timers = [];
  const vp = stub(), store = createStore();
  const ctx = { state: store.state, viewport: vp, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => null, toast() {}, units: "mm" };
  // the order in which panels/scene.js mount() does it: acquireSandbox(ctx) (which restores), then acquireMeasure(ctx)
  const sb = createSandbox({ viewport: vp, ctx, storage, scheduler: (fn) => { timers.push(fn); return () => {}; } });
  sb.restore();
  const ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (f) => f() });
  assert.equal(sb.objects.size, 1, "the object came back");
  for (const t of timers.splice(0)) t(); // the autosave that follows the restore
  const saved = JSON.parse(storage.getItem("hm-scene"));
  assert.equal(ms.items.length, 1, "the remembered measurement is back");
  assert.equal(saved.measurements.length, 1, "and the stored scene still holds it (it was overwritten with an empty list)");
});

test("DEFECT: the viewing check of every display type can report the visual angle of the screen width (left and right edge anchors exist)", () => {
  const f = (() => { const vp = stub(), store = createStore(); const ctx = { state: store.state, viewport: vp, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => null, toast() {}, units: "mm" };
    const sb = createSandbox({ viewport: vp, ctx, scheduler: () => () => {} }), ms = createMeasure({ viewport: vp, ctx, sandbox: sb, scheduler: (fn) => fn() }); return { sb, ms }; })();
  const missing = [];
  for (const type of ["monitor", "triple_monitor", "hud_panel", "tablet", "laptop", "wall_display", "instrument_panel"]) {
    const o = f.sb.add(type, { position: [0, 0, 1.6], yaw: 180 });
    const anchors = f.sb.anchorsWorld(o.id), centre = ["screen_centre", "glass_centre", "panel_centre"].find((k) => anchors[k]);
    const m = f.ms.add({ kind: "view", a: { kind: "world", p: [0, 1.2, 0.9] }, b: { kind: "object", id: o.id, anchor: centre } });
    const r = f.ms.evaluate(m);
    if (!r.ok || r.view.visualH == null || r.view.visualV == null) missing.push(`${type}/${centre}: visualH ${r.view?.visualH}, visualV ${r.view?.visualV}`);
  }
  assert.deepEqual(missing, [], "no screen width / height for: " + missing.join("; "));
});
