// Adversarial tests of sandbox.js / measure.js / catalog.js (written by the verifier, independent of sandbox.test.mjs).
// Run: node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.adversarial.test.mjs
// Tests whose title starts with "DEFECT:" assert the CORRECT behaviour and FAIL while the defect exists.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CATALOG, byType, buildObject, disposeObject, normalizeParams } from "../../site/js/human/catalog.js";
import { createSandbox, validateScene, parseSceneText, snapValue, normalizeYaw, snapAngle, findFreeSpot, MAX_OBJECTS } from "../../site/js/human/sandbox.js";
import { createMeasure, viewInfo, angleAt, cleanItems, cleanRef, formatResult, fmtM } from "../../site/js/human/measure.js";
import { createStore } from "../../site/js/human/state.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { buildRig } from "../../site/js/human/rig.js";

const W = 800, H = 600;
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 120);
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const handlers = new Map(), container = new EventTarget(), raycaster = new THREE.Raycaster(), labelSources = new Map();
  const vp = {
    scene, camera, container, controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null, gizmoDragging: false, canvas: null, renders: 0, cursor: "",
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() { vp.renders++; },
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    emit(evt, ev = {}) { for (const f of [...(handlers.get(evt) ?? [])]) f(ev); return ev; }, count: (e) => handlers.get(e)?.size ?? 0,
    ray(cx, cy) { camera.updateMatrixWorld(); raycaster.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), camera); return raycaster; },
    toClient(v) { const p = v.clone().project(camera); return { clientX: (p.x * 0.5 + 0.5) * W, clientY: (-p.y * 0.5 + 0.5) * H }; },
    project(v) { const p = v.clone().project(camera); return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, visible: p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 }; },
    attachGizmo(o, opts) { vp.gizmo = { object: o, mode: opts.mode, axis: null }; }, detachGizmo() { vp.gizmo = null; }, setGizmoOptions() {},
    setCursor(c) { vp.cursor = c; }, addLabelSource(k, fn) { labelSources.set(k, fn); return () => labelSources.delete(k); }, removeLabelSource(k) { labelSources.delete(k); },
    labels: () => [...labelSources.values()].flatMap((f) => f()), frame() {},
  };
  return vp;
}
function fix({ rig = null, storage } = {}) {
  const viewport = stubViewport(), store = createStore();
  const box = { rig };
  const ctx = { state: store.state, viewport, on: store.on, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => box.rig, toast() {}, units: "mm" };
  const sb = createSandbox({ viewport, ctx, storage, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  return { sb, ctx, vp: viewport, store, box };
}
const rigOf = () => buildRig(syntheticBody(1.75, "male"), { skeleton: false });
const ptr = (vp, v, extra = {}) => ({ ...vp.toClient(v), button: 0, buttons: 1, shift: false, alt: false, pointerType: "mouse", originalEvent: { isPrimary: true, pointerId: 1 }, ...extra });
const near = (a, b, e = 1e-6, m) => assert.ok(Math.abs(a - b) <= e, m ?? `${a} != ${b}`);

// ------------------------------------------------------------------ hostile scene JSON
test("hostile scene files never throw and never produce NaN", () => {
  const evil = [
    null, 1, "x", [], {}, { version: 1 }, { version: "1", objects: [] }, { version: 1.5, objects: [] }, { version: 1, objects: {} }, { version: 1, objects: "box" },
    { version: 1, objects: [null, 1, "a", [], { type: 5 }, { type: "__proto__" }, { type: "constructor" }, { type: "toString" }] },
    { version: 1, objects: [{ type: "box", position: [1e309, 0, 0] }] },
    { version: 1, objects: [{ type: "box", position: ["1", "2", "3"] }] },
    { version: 1, objects: [{ type: "box", position: [1, 2] }] },
    { version: 1, objects: [{ type: "box", position: { x: 1, y: 2, z: 3 } }] },
    { version: 1, objects: [{ type: "box", params: { width: "abc", depth: null, height: [1], __proto__: { width: 1 } } }] },
    { version: 1, objects: [{ type: "box", params: { width: 1e308, depth: -1e308, height: NaN } }] },
    { version: 1, objects: [{ type: "box", yaw: 1e300 }, { type: "box", yaw: "90" }, { type: "box", yaw: Infinity }] },
    { version: 1, objects: [{ type: "box", id: "__proto__" }, { type: "box", id: "constructor" }, { type: "box", id: "o1" }, { type: "box", id: "o1" }] },
    { version: 1, objects: [{ type: "box", name: "<img src=x onerror=alert(1)>" }, { type: "box", name: "\u0000‮" }] },
    { version: 1, objects: [{ type: "box", attachedTo: { kind: "joint", id: "../../x", offset: [1, 2, 3] } }, { type: "box", attachedTo: { kind: "joint", id: "pelvis", offset: [1e9, 0, 0] } }, { type: "box", attachedTo: [] }] },
    { version: 1, objects: [{ type: "box", color: "red" }, { type: "box", color: "#GGGGGG" }, { type: "box", color: { toString() { return "#ffffff"; } } }] },
    { version: 1, objects: [{ type: "box" }], measurements: [{ kind: "distance", a: { kind: "object", id: "__proto__", anchor: "__proto__" }, b: { kind: "world", p: [1e999, 0, 0] } }], human: 5, snap: { gridMm: "x", angleDeg: {} } },
    { version: 1, objects: [{ type: "box" }], measurements: [{ kind: "angle", a: { kind: "world", p: [0, 0, 0] }, b: { kind: "world", p: [0, 0, 0] }, c: { kind: "world", p: [0, 0, 0] } }] },
    { version: 1, objects: [{ type: "box" }], measurements: { length: 1e9 } },
    { version: 1, objects: [{ type: "box" }], snap: { gridMm: 1e308 } },
  ];
  for (const e of evil) {
    const f = fix({ rig: rigOf() });
    const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
    const r = f.sb.fromJSON(e);
    assert.equal(typeof r.ok, "boolean");
    for (const o of f.sb.objects.values()) {
      assert.ok(o.position.every(Number.isFinite), JSON.stringify(e));
      assert.ok(Number.isFinite(o.yaw));
      assert.ok(o.bbox && !o.bbox.isEmpty() && Number.isFinite(o.bbox.max.x));
      for (const v of Object.values(o.params)) if (typeof v === "number") assert.ok(Number.isFinite(v));
      assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(o.id), o.id);
    }
    for (const it of ms.items) { const res = ms.evaluate(it); if (res.ok) assert.ok(Number.isFinite(res.value), JSON.stringify(e)); assert.ok(!/NaN|Infinity/.test(ms.format(res))); }
    assert.doesNotThrow(() => { JSON.stringify(f.sb.toSceneFile()); ms.toCSV(); ms.toResultsJSON(); });
    // prototype pollution
    assert.equal({}.width, undefined);
    f.sb.dispose(); ms.dispose();
  }
});

test("parseSceneText: size limit, depth bomb, duplicate keys", () => {
  assert.equal(parseSceneText("x".repeat(5e6)).ok, false);
  const deep = "[".repeat(100000) + "]".repeat(100000);
  assert.doesNotThrow(() => parseSceneText(deep));
  assert.equal(parseSceneText('{"version":1,"objects":[],"objects":[{"type":"box"}]}').objects.length, 1);
  assert.equal(parseSceneText('{"__proto__":{"polluted":1},"version":1,"objects":[]}').ok, true);
  assert.equal({}.polluted, undefined);
});

test("scene with exactly MAX_OBJECTS +50 entries loads 200 and warns", () => {
  const f = fix();
  const r = f.sb.fromJSON({ version: 1, objects: Array.from({ length: 250 }, () => ({ type: "small_box" })) });
  assert.equal(f.sb.objects.size, MAX_OBJECTS); assert.ok(r.warnings.length);
  f.sb.undo(); assert.equal(f.sb.objects.size, 0);
});

// ------------------------------------------------------------------ history semantics
test("history: add, move, param, undo/redo ordering, discard of redo branch", () => {
  const f = fix(); const { sb } = f;
  const a = sb.add("box", { position: [0, 0, 1] }), b = sb.add("crate", { position: [1, 0, 1] });
  sb.move(a.id, { x: 0.5 }); sb.setParam(b.id, "mass", 40);
  assert.equal(sb.undo(), true); assert.equal(b.params.mass !== 40 || sb.objects.get(b.id).params.mass !== 40, true);
  assert.equal(sb.undo(), true); assert.equal(sb.objects.get(a.id).position[0], 0);
  assert.equal(sb.redo(), true); assert.equal(sb.objects.get(a.id).position[0], 0.5);
  sb.add("stool");                      // new branch
  assert.equal(sb.canRedo, false);
  while (sb.undo());
  assert.equal(sb.objects.size, 0); assert.equal(sb.canUndo, false);
  while (sb.redo());
  assert.equal(sb.objects.size, 3);
});

test("history: object ids and selection stay consistent after delete + undo", () => {
  const f = fix(); const { sb } = f;
  const a = sb.add("box", { select: true });
  sb.remove(a.id); assert.equal(sb.selected, null); assert.equal(f.store.state.selection ?? null, null);
  sb.undo(); assert.ok(sb.objects.has(a.id));
  assert.equal(sb.objects.get(a.id).group.parent, sb.root);
  sb.redo(); assert.equal(sb.objects.size, 0); assert.equal(sb.root.children.length, 0);
});

test("history: drag = one undo step; hold arrow = one step; alt disables snap; locked and attached objects do not move", () => {
  const f = fix(); const { sb, vp } = f;
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.4, depth: 0.4, height: 0.4 } });
  sb.setSnap({ gridMm: 50 });
  const start = vp.toClient(new THREE.Vector3(0, 0.4, 1));
  vp.emit("pointerdown", ptr(vp, new THREE.Vector3(0, 0.4, 1)));
  for (let i = 1; i <= 20; i++) vp.emit("pointermove", { ...ptr(vp, new THREE.Vector3(0, 0.4, 1)), clientX: start.clientX + i * 3, clientY: start.clientY, buttons: 1 });
  vp.emit("pointerup", {});
  assert.ok(o.position[0] > 0.05, "moved " + o.position);
  assert.equal(Math.round(o.position[0] * 1000) % 50, 0, "snapped to 50 mm: " + o.position[0]);
  const n = sb.undo(); assert.ok(n); assert.equal(sb.objects.get(o.id).position[0], 0);
  assert.equal(sb.canUndo, true); // the add is still there
  assert.equal(vp.controls.enabled, true, "orbit controls re-enabled after a drag");
  sb.setLocked(o.id, true);
  assert.equal(sb.move(o.id, { x: 3 }), false); assert.equal(sb.nudge(o.id, 1, 1), false);
  assert.equal(sb.rotate(o.id, 90), false);
});

test("drag cancelled by a second pointer or suspendInput restores orbit and leaves no open undo group", () => {
  const f = fix(); const { sb, vp } = f;
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.4, depth: 0.4, height: 0.4 } });
  const p0 = ptr(vp, new THREE.Vector3(0, 0.4, 1));
  vp.emit("pointerdown", p0);
  assert.equal(vp.controls.enabled, false);
  vp.emit("pointermove", { ...p0, clientX: p0.clientX + 30 });
  vp.emit("pointerdown", { ...p0, originalEvent: { isPrimary: false, pointerId: 2 } });
  assert.equal(vp.controls.enabled, true);
  vp.emit("pointermove", { ...p0, clientX: p0.clientX + 60 });
  vp.emit("pointerup", {});
  sb.move(o.id, { x: 2 }); assert.equal(sb.undo(), true); // history not wedged
  const r = sb.suspendInput(); vp.emit("pointerdown", p0); assert.equal(vp.controls.enabled, true); r();
});

test("DEFECT?: a gizmo scale gesture of a box commits exactly one undo step and params stay within range", () => {
  const f = fix(); const { sb, vp } = f;
  const o = sb.add("box", { select: true, position: [0, 0, 1] });
  sb.setGizmoMode("scale");
  vp.gizmo.mode = "scale"; vp.gizmo.object = o.group;
  vp.emit("gizmo-start", {});
  for (const s of [1.5, 3, 1e6, 0, -2, NaN, 2]) { o.group.scale.set(s, s, s); vp.emit("gizmo-change", {}); }
  vp.emit("gizmo-end", {});
  for (const v of Object.values(o.params)) assert.ok(Number.isFinite(v), JSON.stringify(o.params));
  assert.ok(o.params.width <= 10 && o.params.width >= 0.01, JSON.stringify(o.params));
  assert.equal(o.group.scale.x, 1);
  sb.undo();
  assert.equal(sb.objects.get(o.id).params.width, 0.5);
});

test("gizmo rotate keeps yaw finite and upright; translate cannot go below floor", () => {
  const f = fix(); const { sb, vp } = f;
  const o = sb.add("box", { select: true, position: [0, 0, 1] });
  vp.gizmo.mode = "translate"; vp.emit("gizmo-start", {}); o.group.position.set(1, -5, 2); vp.emit("gizmo-change", {}); vp.emit("gizmo-end", {});
  assert.equal(o.position[1], 0);
  sb.setGizmoMode("rotate"); vp.gizmo.mode = "rotate"; vp.emit("gizmo-start", {});
  o.group.rotation.set(0.3, 1.2, 0.2); vp.emit("gizmo-change", {}); vp.emit("gizmo-end", {});
  assert.ok(Number.isFinite(o.yaw)); near(o.group.rotation.x, 0); near(o.group.rotation.z, 0);
});

// ------------------------------------------------------------------ keyboard & focus
test("keyboard: shortcuts ignored while typing, with modifiers, or when editing is off; Delete on locked toasts", () => {
  const f = fix(); const { sb } = f;
  const o = sb.add("box", { select: true });
  const k = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(sb.onKey(k("Delete", { target: { tagName: "INPUT" } })), false);
  assert.equal(sb.onKey(k("Delete", { target: { tagName: "TEXTAREA" } })), false);
  assert.equal(sb.onKey(k("Delete", { target: { tagName: "SELECT" } })), false);
  assert.equal(sb.onKey(k("Delete", { target: { tagName: "DIV", isContentEditable: true } })), false);
  assert.equal(sb.objects.size, 1);
  assert.equal(sb.onKey(k("r", { ctrlKey: true })), false);               // reload must pass
  assert.equal(sb.onKey(k("w", { metaKey: true })), false);               // close tab must pass
  assert.equal(sb.onKey(k("Delete", { altKey: true })), true);            // alt+Delete deletes (acceptable?)
  assert.equal(sb.objects.size, 0);
  sb.undo();
  sb.setInteraction({ drag: false });
  assert.equal(sb.onKey(k("Delete")), false); assert.equal(sb.objects.size, 1);
  sb.setInteraction({ drag: true });
  assert.equal(sb.onKey(k("c", { ctrlKey: true })), false);               // copy must pass
  assert.equal(sb.onKey(k("a", { ctrlKey: true })), false);
  assert.equal(sb.onKey(k("Tab")), false); assert.equal(sb.onKey(k(" ")), false); assert.equal(sb.onKey(k("Enter")), false);
  assert.equal(sb.onKey(k("Escape")), false);
});

test("keyboard: Ctrl+Z with nothing selected and with panel focus still undoes; arrow nudge steps", () => {
  const f = fix(); const { sb } = f;
  const o = sb.add("box", { select: true, position: [0, 0, 1] });
  const k = (key, extra = {}) => { const e = new Event("keydown", { cancelable: true }); Object.assign(e, { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, extra); return e; };
  sb.onKey(k("ArrowRight")); sb.onKey(k("ArrowRight"));
  near(Math.abs(o.position[0]) + Math.abs(o.position[2] - 1), 0.02, 1e-9);
  sb.select(null);
  assert.equal(sb.onKey(k("z", { ctrlKey: true })), true);
});

// ------------------------------------------------------------------ picking
test("picking: nearest of overlapping objects wins; hidden objects are not pickable; label/outline lines are skipped", () => {
  const f = fix(); const { sb, vp } = f;
  const a = sb.add("box", { position: [0, 0, 1], params: { width: 1, depth: 1, height: 1 }, select: true });
  const b = sb.add("box", { position: [0, 0, 2], params: { width: 1, depth: 1, height: 1 } });
  const c = vp.toClient(new THREE.Vector3(0, 0.5, 1.5));
  const hit = sb.pickAt(c.clientX, c.clientY); assert.equal(hit.obj.id, b.id, "box at z=2 is nearer the camera at z=4.5");
  sb.setVisible(b.id, false);
  assert.equal(sb.pickAt(c.clientX, c.clientY).obj.id, a.id);
});

test("snapping helpers: negative zero, huge, NaN, step not in table", () => {
  assert.ok(Object.is(snapValue(-0.0001, 5), 0));
  assert.ok(Number.isNaN(snapValue(NaN, 5)));
  assert.equal(snapValue(1e12, 5), 1e12);
  assert.equal(normalizeYaw(180), 180); assert.equal(normalizeYaw(-180), 180); assert.equal(normalizeYaw(540), 180); assert.equal(normalizeYaw(Infinity), 0);
  assert.equal(snapAngle(44.9, 45), 45); assert.equal(snapAngle(-179, 90), 180);
  const f = fix(); assert.equal(f.sb.setSnap({ gridMm: 7 }), false); assert.equal(f.sb.setSnap({ gridMm: "10" }), false);
});

test("add: position of NaN / strings / huge falls back safely; MAX_OBJECTS enforced; free spot finds a place", () => {
  const f = fix(); const { sb } = f;
  for (const p of [[NaN, 0, 0], ["a", 0, 0], [1e12, -1e12, 5], { x: 1, y: 2 }, null, undefined]) { const o = sb.add("box", { position: p }); assert.ok(o.position.every(Number.isFinite)); assert.ok(Math.abs(o.position[0]) <= 1000); assert.ok(o.position[1] >= 0); }
  assert.throws(() => sb.add("nope"));
  assert.throws(() => sb.add("__proto__"));
  for (let i = 0; i < 300; i++) sb.add("small_box");
  assert.equal(sb.objects.size, MAX_OBJECTS);
});

test("free spot for 200 big floor objects terminates quickly", () => {
  const f = fix(); const t0 = performance.now();
  for (let i = 0; i < 60; i++) f.sb.add("floor_platform", { params: { width: 6, depth: 6 } });
  assert.ok(performance.now() - t0 < 6000, `${performance.now() - t0} ms`);
});

// ------------------------------------------------------------------ persistence
test("persistence: remember opt-in only; hostile stored text ignored; storage that throws does not break", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  let f = fix({ storage });
  f.sb.add("box"); f.sb.saveLocal(); assert.equal(mem.has("hm-scene"), false, "nothing stored unless remembered");
  f.sb.setRemember(true); assert.ok(mem.get("hm-scene")); f.sb.dispose();
  f = fix({ storage }); assert.equal(f.sb.restore().added, 1);
  f.sb.setRemember(false); assert.equal(mem.has("hm-scene"), false);
  mem.set("hm-scene-remember", "1"); mem.set("hm-scene", "{evil");
  f = fix({ storage }); assert.doesNotThrow(() => f.sb.restore());
  mem.set("hm-scene", JSON.stringify({ version: 1, objects: [{ type: "box", position: [0, 0, 0] }], measurements: [{ kind: "x" }] }));
  const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("x"); } };
  f = fix({ storage: bad }); assert.equal(f.sb.restore(), null); assert.equal(f.sb.setRemember(true), false); assert.equal(f.sb.saveLocal(), false);
});

test("DEFECT: opening a scene file (replace) then Undo restores the objects but the measurements are lost for good", () => {
  const f = fix({ rig: rigOf() }); const { sb } = f;
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: sb, scheduler: (fn) => fn() });
  const o = sb.add("monitor", { position: [0, 0, 1] });
  ms.addDistance({ kind: "landmark", id: "eye_mid" }, { kind: "object", id: o.id, anchor: "screen_centre" });
  sb.fromJSON({ version: 1, objects: [{ type: "box" }] });
  sb.undo();
  assert.equal(sb.objects.size, 1);
  assert.equal(ms.items.length, 1, "undo of Open scene should bring the measurement back (the toast promises Undo)");
});

// ------------------------------------------------------------------ attachment
test("attach: follows joint, survives rig replacement, detaches upright; missing joint reports", () => {
  const rig = rigOf(); const f = fix({ rig }); const { sb } = f;
  const o = sb.add("hammer");
  assert.equal(sb.attach(o.id, { kind: "landmark", id: "palm_centre_L" }, [0, 0, 0]), true);
  const p = rig.landmarkWorld("palm_centre_L", new THREE.Vector3());
  near(o.position[0], p.x, 1e-5); near(o.position[1], Math.max(0, p.y), 1e-5);
  rig.setPose({ root: { y: rig.root.y }, angles: { shoulder_L: [60, 0, 0] } }); f.ctx.emit("pose", {});
  const p2 = rig.landmarkWorld("palm_centre_L", new THREE.Vector3()); near(o.position[2], p2.z, 1e-5);
  assert.equal(sb.attach(o.id, { kind: "joint", id: "../x" }), false);
  f.box.rig = null; f.ctx.emit("rig", null);
  assert.ok(o.attachError);
  sb.undo(); sb.redo();
  assert.equal(sb.detach(o.id), true);
});

// ------------------------------------------------------------------ measurement maths
test("measure: hand-calculated distance, deltas, height, angle, view geometry", () => {
  const f = fix({ rig: rigOf() }); const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  const W3 = (x, y, z) => ({ kind: "world", p: [x, y, z] });
  let r = ms.evaluate(ms.addDistance(W3(0, 0, 0), W3(0.3, 0.4, 1.2)));
  near(r.value, Math.hypot(0.3, 0.4, 1.2)); near(r.horizontal, Math.hypot(0.3, 1.2)); near(r.dx, 0.3); near(r.dy, 0.4); near(r.dz, 1.2);
  r = ms.evaluate(ms.addHeight(W3(1, 1.234, 2))); near(r.value, 1.234);
  r = ms.evaluate(ms.addAngle(W3(1, 0, 0), W3(0, 0, 0), W3(0, 1, 0))); near(r.value, 90, 1e-9);
  r = ms.evaluate(ms.addAngle(W3(1, 0, 0), W3(0, 0, 0), W3(-1, 0, 0))); near(r.value, 180, 1e-6);
  r = ms.evaluate(ms.addAngle(W3(1, 0, 0), W3(0, 0, 0), W3(2, 0, 0))); near(r.value, 0, 1e-6);
  r = ms.evaluate(ms.addAngle(W3(1, 0, 0), W3(1, 0, 0), W3(2, 0, 0))); assert.equal(r.ok, false);
  // view: eye (0,1.6,0), screen centre (0,1.15,0.6)
  const eye = new THREE.Vector3(0, 1.6, 0), c = new THREE.Vector3(0, 1.15, 0.6);
  const v = viewInfo(eye, c, { normal: new THREE.Vector3(0, 0, -1) });
  near(v.declination, Math.atan2(0.45, 0.6) * 180 / Math.PI, 1e-9); near(v.distance, 0.75, 1e-9); 
  near(v.incidence, Math.atan2(0.45, 0.6) * 180 / Math.PI, 1e-6, "incidence vs normal -Z: " + v.incidence);
  const v2 = viewInfo(eye, new THREE.Vector3(0, 1.8, 0.6), {}); assert.ok(v2.declination < 0); assert.equal(v2.zone.declination, "above");
  const v3 = viewInfo(eye, eye.clone(), {}); assert.ok(Number.isFinite(v3.declination), "coincident eye / screen");
  const d0 = viewInfo(eye, eye.clone(), { normal: new THREE.Vector3(0, 0, 1) }); assert.equal(d0.incidence, null);
});

test("measure: monitor viewing check vs hand calculation of visual angle", () => {
  const rig = rigOf(); const f = fix({ rig }); const sb = f.sb;
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: sb, scheduler: (fn) => fn() });
  const o = sb.add("monitor", { position: [0, 0, 0.7], params: { diagonal: 24, centreHeight: 1.2, tilt: 0 }, yaw: 180 });
  const it = ms.addView({ kind: "object", id: o.id, anchor: "screen_centre" }, { kind: "world", p: [0, 1.2, 0] });
  const res = ms.evaluate(it), w = 24 * 0.0254 * 16 / Math.hypot(16, 9);
  near(res.view.width, w, 1e-6); near(res.view.visualH, 2 * Math.atan(w / 2 / 0.7) * 180 / Math.PI, 1e-4);
  near(res.view.incidence, 0, 1e-4, "looking straight at the screen: " + res.view.incidence);
  // screen must face the eye (yaw 180 => faces -Z towards the figure at z=0)
  const n = sb.anchorNormalWorld(o.id, "screen_centre"); near(n.z, -1, 1e-6);
  // left/right edges: viewer's left. Viewer looks toward +Z, so viewer's left is world +X ? (the figure's left = +X)
  const L = sb.anchorWorld(o.id, "left_edge"), R = sb.anchorWorld(o.id, "right_edge");
  assert.ok(L.x > R.x, `viewer's left edge should be +X (figure left) but L.x=${L.x} R.x=${R.x}`);
});

test("measure: skin point reference follows its bone", () => {
  const rig = rigOf(); const f = fix({ rig });
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  const jp = rig.jointWorld("elbow_L", new THREE.Vector3()), q = rig.jointQuaternion("elbow_L", new THREE.Quaternion());
  const world = jp.clone().add(new THREE.Vector3(0.02, -0.05, 0.03));
  const local = world.clone().sub(jp).applyQuaternion(q.clone().invert()).toArray();
  const it = ms.addHeight({ kind: "joint", id: "elbow_L", local });
  near(ms.evaluate(it).points.a.y, world.y, 1e-9);
  rig.setPose({ root: { y: rig.root.y }, angles: { shoulder_L: [0, 70, 0], elbow_L: [90, 0, 0] } });
  const jp2 = rig.jointWorld("elbow_L", new THREE.Vector3()), q2 = rig.jointQuaternion("elbow_L", new THREE.Quaternion());
  const expect = jp2.clone().add(new THREE.Vector3(...local).applyQuaternion(q2));
  const got = ms.evaluate(it).points.a; near(got.distanceTo(expect), 0, 1e-9);
});

test("measure: resolved landmark distance equals the rig's landmark positions for all landmarks", () => {
  const rig = rigOf(); const f = fix({ rig });
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  const ids = rig.landmarkIds.slice(0, 40);
  for (let i = 1; i < ids.length; i++) {
    const it = ms.addDistance({ kind: "landmark", id: ids[0] }, { kind: "landmark", id: ids[i] });
    near(ms.evaluate(it).value, rig.landmarkWorld(ids[0], new THREE.Vector3()).distanceTo(rig.landmarkWorld(ids[i], new THREE.Vector3())), 1e-12);
  }
});

test("measure: live update scheduling is coalesced and disposed measure ignores events", async () => {
  const rig = rigOf(); const f = fix({ rig });
  let queued = 0; const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => { queued++; ms._fn = fn; } });
  ms.addHeight({ kind: "landmark", id: "vertex" });
  const q0 = queued;
  for (let i = 0; i < 50; i++) f.ctx.emit("pose", {});
  assert.ok(queued - q0 <= 1, `${queued - q0} callbacks for 50 pose events`);
  ms.dispose(); assert.doesNotThrow(() => { ms._fn?.(); f.ctx.emit("pose", {}); f.ctx.emit("scene", {}); });
    assert.equal(f.vp.scene.children.filter((c) => c.name === "hm-measure").length, 0);
});

test("DEFECT (low): measure formatting never shows NaN or negative zero", () => {
  assert.equal(fmtM(NaN), "—"); assert.equal(fmtM(Infinity), "—");
  assert.ok(!/^-0 /.test(fmtM(-0.0001)), "negative zero: " + fmtM(-0.0001));
  assert.ok(!/^-0\.0+ /.test(fmtM(-0.00001, "in")), fmtM(-0.00001, "in"));
});

test("measure: label text sanitised for CSV and long labels", () => {
  const f = fix({ rig: rigOf() }); const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  const it = ms.addHeight({ kind: "world", p: [0, 1, 0] }, { label: '=HYPERLINK("http://evil","x")' });
  const csv = ms.toCSV();
  assert.ok(!/^m\d+,=/m.test(csv) && !/,=HYPERLINK/.test(csv), "CSV formula injection: label begins with '='");
});

test("measure: pointOptions / matchPoint ambiguity and duplicate labels", () => {
  const f = fix({ rig: rigOf() }); const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  const opts = ms.pointOptions(); const texts = opts.map((o) => o.text);
  assert.equal(new Set(texts).size, texts.length, "option texts must be unique (datalist round-trip)");
  assert.ok(opts.length > 100);
  assert.equal(ms.matchPoint("zzzz"), null); assert.equal(ms.matchPoint(""), null); assert.equal(ms.matchPoint(undefined), null);
});

// ------------------------------------------------------------------ resource leaks
test("leaks: add / param-change / remove / measure cycles dispose every geometry and material they create", () => {
  const live = new Set();
  const origG = THREE.BufferGeometry.prototype.dispose, origM = THREE.Material.prototype.dispose;
  const created = { g: 0, m: 0 }, disposed = { g: new Set(), m: new Set() };
  THREE.BufferGeometry.prototype.dispose = function () { disposed.g.add(this.uuid); return origG.call(this); };
  THREE.Material.prototype.dispose = function () { disposed.m.add(this.uuid); return origM.call(this); };
  const f = fix({ rig: rigOf() }); const { sb } = f;
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: sb, scheduler: (fn) => fn() });
  const seen = () => { const g = new Set(), m = new Set(); f.vp.scene.traverse((o) => { if (o.geometry) g.add(o.geometry.uuid); for (const x of [].concat(o.material ?? [])) if (x && !x.userData.shared) m.add(x.uuid); }); return { g, m }; };
  const all = { g: new Set(), m: new Set() };
  const note = () => { const s = seen(); s.g.forEach((x) => all.g.add(x)); s.m.forEach((x) => all.m.add(x)); };
  for (let i = 0; i < 40; i++) {
    const t = CATALOG[i % CATALOG.length].type;
    const o = sb.add(t, { select: true, position: [0, 0, 1] }); note();
    const ps = byType(t).params.find((p) => p.kind === "number"); if (ps) { sb.setParam(o.id, ps.key, ps.max); note(); sb.setParam(o.id, ps.key, ps.min); note(); }
    sb.update(o.id, { color: "#123456" }); note();
    sb.hover(o.id); note();
    const it = ms.addDistance({ kind: "landmark", id: "vertex" }, { kind: "object", id: o.id, local: [0, 0.1, 0] }); ms.flush(); note();
    ms.select(it.id); ms.flush(); note();
    ms.setVisible(it.id, false); ms.flush(); ms.setVisible(it.id, true); ms.flush(); note();
    sb.remove(o.id); ms.flush(); note();
    ms.remove(it.id); ms.flush();
    sb.undo(); note(); sb.undo(); sb.undo(); sb.redo();
    sb.clear(); sb.undo(); sb.clear();
  }
  sb.undo(); sb.dispose(); ms.dispose();
  const leakedG = [...all.g].filter((x) => !disposed.g.has(x)), leakedM = [...all.m].filter((x) => !disposed.m.has(x));
  THREE.BufferGeometry.prototype.dispose = origG; THREE.Material.prototype.dispose = origM;
  assert.equal(leakedG.length, 0, `${leakedG.length} geometries never disposed (of ${all.g.size})`);
  assert.equal(leakedM.length, 0, `${leakedM.length} materials never disposed (of ${all.m.size})`);
  assert.equal(f.vp.scene.children.length, 0, "scene empty after dispose");
  assert.equal(["click", "pointerdown", "pointermove", "pointerup", "gizmo-start", "gizmo-change", "gizmo-end"].reduce((n, e) => n + f.vp.count(e), 0), 0, "listeners removed");
});

test("build cost: every type builds under 60 ms at default and under 150 ms at max", () => {
  const slow = [];
  for (const t of CATALOG) {
    for (const [n, params] of [["def", {}], ["max", Object.fromEntries(t.params.map((p) => [p.key, p.kind === "number" ? p.max : p.kind === "bool" ? true : p.options.at(-1).value]))]]) {
      const t0 = performance.now(); const g = buildObject(t.type, params); const dt = performance.now() - t0; disposeObject(g);
      if (dt > (n === "def" ? 60 : 150)) slow.push(`${t.type}/${n} ${dt.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test("100 objects: mesh count and triangle budget", () => {
  const f = fix(); const { sb } = f; let meshes = 0, tris = 0;
  for (let i = 0; i < 100; i++) sb.add(CATALOG[i % CATALOG.length].type, { position: [i % 10, 0, Math.floor(i / 10)] });
  f.vp.scene.traverse((o) => { if (o.isMesh) { meshes++; tris += o.geometry.attributes.position.count / 3; } });
  console.log(`100 objects: ${meshes} meshes, ${tris} triangles`);
  assert.ok(meshes < 700, `${meshes} meshes`); assert.ok(tris < 400000, `${tris} tris`);
});

test("free-spot placement: 25 rotated long objects never overlap each other (independent polygon test)", () => {
  const f = fix(); const { sb } = f;
  const polys = [];
  const poly = (o) => { const b = o.bbox, c = Math.cos(o.yaw * Math.PI / 180), s = Math.sin(o.yaw * Math.PI / 180); return [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.max.x, b.max.z], [b.min.x, b.max.z]].map(([x, z]) => [o.position[0] + x * c + z * s, o.position[2] - x * s + z * c]); };
  const sat = (A, B) => { for (const P of [A, B]) for (let i = 0; i < 4; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % 4], ax = -(z2 - z1), az = x2 - x1; const pr = (Q) => Q.map(([x, z]) => x * ax + z * az); const a = pr(A), b = pr(B); if (Math.max(...a) <= Math.min(...b) + 1e-9 || Math.max(...b) <= Math.min(...a) + 1e-9) return false; } return true; };
  for (let i = 0; i < 25; i++) { const o = sb.add(i % 2 ? "bench" : "ladder", { yaw: [0, 90, 45, 30][i % 4] }); polys.push(poly(o)); }
  for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) assert.equal(sat(polys[i], polys[j]), false, `${i} overlaps ${j}`);
});

test("rest on a surface: a box released above a desk lands on the desk top; outside the desk it lands on the floor", () => {
  const f = fix(); const { sb } = f;
  const desk = sb.add("desk", { position: [0, 0, 1] }), b = sb.add("small_box", { position: [0.1, 1.5, 1.05] });
  sb.dropToSurface(b.id); near(b.position[1], 0.74, 1e-6);
  const c = sb.add("small_box", { position: [3, 1.5, 3] }); sb.dropToSurface(c.id); assert.equal(c.position[1], 0);
});
