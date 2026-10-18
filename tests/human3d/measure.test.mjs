// Measurements of the Digital human tab without WebGL: the maths (distance, angle, viewing geometry), references resolved live against the sandbox and a
// real rig, exports, scene-file sections, hostile input, the overlay bookkeeping and the picking tool with snapping against a stub viewport.
// Run: node --import ./tests/human3d/register.mjs --test tests/human3d/measure.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createMeasure, measureFor, peekMeasure, acquireMeasure, releaseMeasure, distanceInfo, angleAt, viewInfo, cleanRef, cleanItems, formatResult, formatDeltas, fmtM, DASH, VIEW_NOTE, VIEW_ZONE,
  KINDS, COLOR_TOKENS, MAX_ITEMS, SNAP_PX,
} from "../../site/js/human/measure.js";
import { createSandbox, sandboxFor } from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { buildRig } from "../../site/js/human/rig.js";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b} (eps ${eps})`);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------------------------------------------------ stubs
const W = 800, H = 600;
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 120);
  camera.position.set(0, 1.5, 4.5); camera.lookAt(0, 0.9, 0); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const handlers = new Map(), container = new EventTarget(), raycaster = new THREE.Raycaster(), labelSources = new Map();
  const vp = {
    scene, camera, container, controls: { enabled: true }, active: true, canvas: null, gizmo: null, gizmoDragging: false,
    theme: { accent: new THREE.Color(0x2a78d6), bad: new THREE.Color(0xb3261e), good: new THREE.Color(0x0f7a2e), text: new THREE.Color(0x111111), text3: new THREE.Color(0x888888) },
    renders: 0, cursor: "",
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() { vp.renders++; },
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    emit(evt, ev = {}) { for (const f of [...(handlers.get(evt) ?? [])]) f(ev); return ev; },
    listenerCount: (e) => handlers.get(e)?.size ?? 0,
    ray(cx, cy) { camera.updateMatrixWorld(); raycaster.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), camera); return raycaster; },
    project(v) { const p = v.clone().project(camera); return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 }; },
    ev(v, extra = {}) { const s = vp.project(v); return { x: s.x, y: s.y, clientX: s.x, clientY: s.y, button: 0, buttons: 0, pointerType: "mouse", handled: false, ...extra }; },
    attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor(c) { vp.cursor = c; }, addLabelSource(k, fn) { labelSources.set(k, fn); return () => labelSources.delete(k); }, removeLabelSource(k) { labelSources.delete(k); },
    labels: (k) => (k ? labelSources.get(k)() : [...labelSources.values()].flatMap((f) => f())), frame() {},
  };
  return vp;
}
function rigFixture(stature = 1.75) { return buildRig(syntheticBody(stature, "male"), { skeleton: false }); }
function fixture({ rig = null, units = "mm" } = {}) {
  const viewport = stubViewport(), store = createStore(), box = { rig, units }, queue = [];
  const ctx = { state: store.state, viewport, on: store.on, emit: store.emit, select: (s) => store.select(s), getRig: () => box.rig, toast() {}, get units() { return box.units; } };
  const sb = createSandbox({ viewport, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  const ms = createMeasure({ viewport, ctx, sandbox: sb, scheduler: (fn) => queue.push(fn) });
  return { ctx, sb, ms, vp: viewport, store, box, queue, run: () => queue.splice(0).forEach((f) => f()) };
}
const objRef = (id, anchor) => ({ kind: "object", id, anchor });
const lm = (id) => ({ kind: "landmark", id });
const jn = (id) => ({ kind: "joint", id });

// ============================================================================================================================ maths
test("distance: components, horizontal distance and 3D length", () => {
  const d = distanceInfo(V(1, 2, 3), V(4, 6, 15));
  assert.deepEqual([d.dx, d.dy, d.dz], [3, 4, 12]); near(d.dist, Math.hypot(3, 4, 12)); near(d.dist, 13); near(d.horizontal, Math.hypot(3, 12));
  const z = distanceInfo(V(1, 1, 1), V(1, 1, 1)); assert.equal(z.dist, 0); assert.equal(z.horizontal, 0);
});

test("angle at a vertex: right angle, equilateral, straight, reflex input and degenerate legs", () => {
  near(angleAt(V(1, 0, 0), V(0, 0, 0), V(0, 1, 0)), 90, 1e-9);
  near(angleAt(V(1, 0, 0), V(0, 0, 0), V(0.5, Math.sqrt(3) / 2, 0)), 60, 1e-9);
  near(angleAt(V(-1, 0, 0), V(0, 0, 0), V(1, 0, 0)), 180, 1e-9);
  near(angleAt(V(1, 0, 0), V(0, 0, 0), V(2, 0, 0)), 0, 1e-6);
  near(angleAt(V(0, 1, 0), V(0, 0, 0), V(0, 0, 3)), 90, 1e-9, "3D");
  near(angleAt(V(1, 1, 0), V(0, 0, 0), V(1, 0, 0)), 45, 1e-9);
  assert.equal(angleAt(V(1, 1, 1), V(1, 1, 1), V(2, 2, 2)), null); assert.equal(angleAt(V(2, 2, 2), V(1, 1, 1), V(1, 1, 1)), null);
  near(angleAt(V(1, 0, 0), V(0, 0, 0), V(1, 1e-9, 0)), 0, 1e-6, "acos of a value just above 1 does not give NaN");
});

test("viewing geometry from hand calculations: a 24 inch monitor 0.6 m away at eye height", () => {
  const w = 0.6096 * 16 / Math.hypot(16, 9), h = 0.6096 * 9 / Math.hypot(16, 9);
  const eye = V(0, 1.15, 0.6), c = V(0, 1.15, 0), v = viewInfo(eye, c, { left: V(-w / 2, 1.15, 0), right: V(w / 2, 1.15, 0), top: V(0, 1.15 + h / 2, 0), bottom: V(0, 1.15 - h / 2, 0), normal: V(0, 0, 1) });
  near(v.distance, 0.6); near(v.horizontal, 0.6); near(v.declination, 0, 1e-9);
  near(v.visualH, 2 * Math.atan(w / 2 / 0.6) * 180 / Math.PI, 1e-9); near(v.visualH, 47.76, 0.01, "531 mm wide at 600 mm: 47.76 degrees");
  near(v.visualV, 2 * Math.atan(h / 2 / 0.6) * 180 / Math.PI, 1e-9); near(v.visualV, 27.97, 0.01, "299 mm high at 600 mm: 27.97 degrees");
  near(v.width, w, 1e-9); near(v.height, h, 1e-9); near(v.incidence, 0, 1e-6);
  assert.deepEqual(v.zone, { distance: "within", declination: "within" });
  // eye 0.3 m above the screen centre: 26.565 degrees below the horizontal, distance sqrt(0.6^2 + 0.3^2)
  const hi = viewInfo(V(0, 1.45, 0.6), c, { normal: V(0, 0, 1) });
  near(hi.declination, Math.atan(0.5) * 180 / Math.PI, 1e-9); near(hi.distance, Math.hypot(0.6, 0.3)); near(hi.horizontal, 0.6);
  near(hi.incidence, hi.declination, 1e-9, "the normal is horizontal, so the angle between it and the line of sight is the declination");
  assert.equal(hi.visualH, null); assert.equal(hi.width, null);
  // eye below the screen centre: negative declination = the screen is above the horizontal
  const lo = viewInfo(V(0, 0.9, 0.6), c, {}); near(lo.declination, -Math.atan(0.25 / 0.6) * 180 / Math.PI, 1e-9); assert.equal(lo.zone.declination, "above");
  assert.equal(viewInfo(V(0, 1.15, 0.4), c).zone.distance, "closer"); assert.equal(viewInfo(V(0, 1.15, 1.2), c).zone.distance, "farther");
  assert.equal(viewInfo(V(0, 2.5, 0.6), c).zone.declination, "below"); assert.equal(viewInfo(V(0, 1.15, 0.6), c, { normal: V(1, 0, 0) }).incidence, 90);
  assert.deepEqual(VIEW_ZONE, { distance: [0.5, 0.75], declination: [0, 30] }); assert.match(VIEW_NOTE, /not a verdict/); assert.match(VIEW_NOTE, /ISO 9241-5/);
  const same = viewInfo(c, c, { normal: V(0, 0, 1) }); assert.equal(same.incidence, null); assert.ok(Number.isFinite(same.declination), "an eye at the display centre does not give NaN");
});

test("formatting: units, em dash for anything unresolved, signed deltas", () => {
  assert.equal(fmtM(1.1534, "mm"), "1,153 mm"); assert.equal(fmtM(1.1534, "cm"), "115.3 cm"); assert.equal(fmtM(1.1534, "in"), "45.41 in"); assert.equal(fmtM(0.0254, "in"), "1.00 in");
  assert.equal(fmtM(NaN), DASH); assert.equal(fmtM(undefined), DASH); assert.equal(fmtM(Infinity), DASH); assert.equal(fmtM(null), DASH);
  const dist = { ok: true, kind: "distance", value: 0.5, dx: 0.12, dy: -0.045, dz: 0.3, horizontal: 0.3232 };
  assert.equal(formatResult(dist, "mm"), "500 mm"); assert.equal(formatResult({ ok: true, kind: "angle", value: 87.34 }), "87.3°"); assert.equal(formatResult({ ok: true, kind: "angle", value: 90 }), "90°");
  assert.equal(formatResult({ ok: true, kind: "height", value: 1.153 }, "cm"), "115.3 cm");
  assert.equal(formatResult({ ok: true, kind: "view", view: { distance: 0.612, declination: 12.34 } }, "mm"), "612 mm, 12.3° below level"); assert.equal(formatResult({ ok: true, kind: "view", view: { distance: 0.6, declination: -5 } }), "600 mm, 5° above level");
  assert.equal(formatResult({ ok: false }), DASH); assert.equal(formatResult(null), DASH); assert.equal(formatResult(undefined), DASH);
  assert.equal(formatDeltas(dist, "mm"), "Δx 120 mm, Δy −45 mm, Δz 300 mm, horizontal 323 mm"); assert.equal(formatDeltas({ ok: true, dx: null }), ""); assert.equal(formatDeltas({ ok: false }), "");
  assert.equal(formatDeltas(dist, "in"), "Δx 4.72 in, Δy −1.77 in, Δz 11.81 in, horizontal 12.72 in");
});

test("cleanRef accepts the four kinds and rejects everything hostile", () => {
  assert.deepEqual(cleanRef({ kind: "world", p: [1, 2, 3] }), { kind: "world", p: [1, 2, 3] });
  assert.deepEqual(cleanRef({ kind: "object", id: "o1", anchor: "srp" }), { kind: "object", id: "o1", anchor: "srp" });
  assert.deepEqual(cleanRef({ kind: "object", id: "o1", local: [0.1, 0.2, 0.3] }), { kind: "object", id: "o1", local: [0.1, 0.2, 0.3] });
  assert.deepEqual(cleanRef({ kind: "joint", id: "elbow_L" }), { kind: "joint", id: "elbow_L" }); assert.deepEqual(cleanRef({ kind: "joint", id: "elbow_L", local: [0, 0.1, 0] }), { kind: "joint", id: "elbow_L", local: [0, 0.1, 0] });
  assert.deepEqual(cleanRef({ kind: "landmark", id: "eye_mid", junk: 1 }), { kind: "landmark", id: "eye_mid" });
  assert.deepEqual(cleanRef({ kind: "world", p: [1e9, -1e9, 0] }).p, [1000, -1000, 0]);
  for (const bad of [null, undefined, 5, "x", [], {}, { kind: "world" }, { kind: "world", p: [1, 2] }, { kind: "world", p: [NaN, 0, 0] }, { kind: "world", p: "1,2,3" }, { kind: "object", id: "o1" }, { kind: "object", anchor: "a" },
    { kind: "object", id: "../x", anchor: "a" }, { kind: "object", id: "o1", anchor: 5 }, { kind: "object", id: "o1", local: [1, 2] }, { kind: "object", id: "o1", anchor: "a", local: "bad" }, { kind: "joint" }, { kind: "joint", id: "a b" },
    { kind: "landmark", id: "" }, { kind: "landmark", id: "x".repeat(65) }, { kind: "bone", id: "x" }, { kind: "__proto__", id: "x" }, JSON.parse('{"kind":"landmark","__proto__":{"id":"eye_mid"}}')]) assert.equal(cleanRef(bad), null, JSON.stringify(bad));
  assert.equal(({}).id, undefined);
});

// ============================================================================================================================ references
test("resolve: world, object anchor, object local point, joint, joint skin point, landmark; and why a reference fails", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb } = f;
  const mon = sb.add("monitor", { position: [0.5, 0, 2], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } });
  let r = ms.resolve({ kind: "world", p: [1, 2, 3] }); assert.ok(r.ok); assert.deepEqual(r.p.toArray(), [1, 2, 3]);
  r = ms.resolve(objRef(mon.id, "screen_centre")); assert.ok(r.ok); near(r.p.x, 0.5); near(r.p.y, 1.2); near(r.p.z, 2); assert.equal(r.label, "Monitor: Screen centre");
  r = ms.resolve({ kind: "object", id: mon.id, local: [0, 0.5, 0.1] }); assert.ok(r.ok); near(r.p.x, 0.5); near(r.p.y, 0.5); near(r.p.z, 1.9, 1e-9, "yaw 180 turns the object's +Z towards -Z"); assert.equal(r.label, "Monitor (point)");
  r = ms.resolve(lm("eye_mid")); assert.ok(r.ok); near(r.p.y, 1.6286, 1e-3); assert.match(r.label, /eye/i);
  r = ms.resolve(jn("elbow_L")); assert.ok(r.ok); assert.ok(r.p.x > 0.15, "the figure's left elbow is on +X"); assert.match(r.label, /elbow/i);
  const e = rig.jointWorld("elbow_L"), q = rig.jointQuaternion("elbow_L");
  r = ms.resolve({ kind: "joint", id: "elbow_L", local: [0.02, -0.03, 0.01] }); assert.ok(r.ok);
  assert.ok(r.p.distanceTo(e.clone().add(V(0.02, -0.03, 0.01).applyQuaternion(q))) < 1e-9); assert.match(r.label, /skin point/);
  // failures
  r = ms.resolve(objRef("ghost", "srp")); assert.equal(r.ok, false); assert.match(r.why, /removed/);
  r = ms.resolve(objRef(mon.id, "nope")); assert.equal(r.ok, false); assert.match(r.why, /no longer has the point "nope"/);
  r = ms.resolve({ kind: "object", id: mon.id, anchor: "nope", local: [0, 0.5, 0] }); assert.ok(r.ok, "a missing anchor falls back to the local point");
  r = ms.resolve(lm("nope")); assert.match(r.why, /no landmark "nope"/); r = ms.resolve(jn("nope")); assert.match(r.why, /no joint "nope"/);
  for (const bad of [null, undefined, {}, { kind: "world" }, { kind: "world", p: [NaN, 0, 0] }, { kind: "object", id: mon.id }, { kind: "zzz" }]) { const x = ms.resolve(bad); assert.equal(x.ok, false); assert.ok(x.why); }
  f.box.rig = null; assert.match(ms.resolve(lm("eye_mid")).why, /no figure/); assert.match(ms.resolve(jn("elbow_L")).why, /no figure/);
  assert.ok(ms.resolve(objRef(mon.id, "top_edge")).ok, "object points do not need the figure");
});

test("items: add, defaults, names, colours, validation, selection, rename, remove, limits", () => {
  const f = fixture({ rig: rigFixture() }), { ms } = f;
  const a = ms.addDistance(lm("eye_mid"), lm("vertex")), b = ms.addDistance(lm("eye_mid"), lm("menton")), h = ms.addHeight(lm("vertex")), g = ms.addAngle(jn("shoulder_L"), jn("elbow_L"), jn("wrist_L"));
  assert.deepEqual(ms.items.map((i) => i.label), ["Distance 1", "Distance 2", "Height 1", "Angle 1"]); assert.deepEqual(ms.items.map((i) => i.kind), ["distance", "distance", "height", "angle"]);
  assert.deepEqual(ms.items.map((i) => i.color), COLOR_TOKENS.slice(0, 4)); assert.ok(ms.items.every((i) => i.visible === true));
  assert.equal(new Set(ms.items.map((i) => i.id)).size, 4);
  assert.equal(ms.add({ kind: "distance", a: lm("eye_mid") }), null, "a distance needs two points"); assert.equal(ms.add({ kind: "angle", a: lm("a"), b: lm("b") }), null); assert.equal(ms.add({ kind: "nope", a: lm("x") }), null); assert.equal(ms.add(null), null); assert.equal(ms.add({ kind: "height", a: { kind: "bad" } }), null);
  assert.equal(ms.items.length, 4);
  assert.equal(ms.rename(a.id, "  Eye to crown  "), true); assert.equal(a.label, "Eye to crown"); assert.equal(ms.rename(a.id, "   "), false); assert.equal(ms.rename("zz", "x"), false); ms.rename(a.id, "x".repeat(300)); assert.equal(a.label.length, 80); ms.rename(a.id, "a\u0000b\nc"); assert.equal(a.label, "a b c");
  assert.equal(ms.setVisible(b.id, false), true); assert.equal(b.visible, false); assert.equal(ms.setColor(b.id, "good"), true); assert.equal(b.color, "good"); assert.equal(ms.setColor(b.id, "pink"), false); assert.equal(ms.setColor("zz", "good"), false);
  assert.equal(ms.select(a.id), true); assert.equal(ms.selected, a.id); assert.equal(ms.select(a.id), false); assert.equal(ms.select("ghost"), false); assert.equal(ms.selected, a.id); assert.equal(ms.select(null), true);
  ms.select(g.id); ms.remove(g.id); assert.equal(ms.selected, null); assert.equal(ms.remove(g.id), false); assert.equal(ms.items.length, 3);
  const d2 = ms.addDistance(lm("eye_mid"), lm("nasion")); assert.equal(d2.label, "Distance 3", "names never repeat");
  const named = ms.add({ kind: "height", a: lm("vertex"), label: "Stature", color: "bad", id: a.id }); assert.notEqual(named.id, a.id, "an id already in use is replaced"); assert.equal(named.label, "Stature");
  ms.clear(); assert.equal(ms.items.length, 0); assert.equal(ms.clear(), false);
  for (let i = 0; i < MAX_ITEMS; i++) assert.ok(ms.addHeight({ kind: "world", p: [0, i * 0.001, 0] })); assert.equal(ms.addHeight({ kind: "world", p: [0, 0, 0] }), null);
  assert.deepEqual(KINDS, ["distance", "height", "angle", "view"]);
});

test("values are live: moving an object, posing the figure, a new figure and the units all change what is shown", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb, ctx } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1.0], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } });
  const it = ms.addDistance(lm("eye_mid"), objRef(mon.id, "screen_centre")), eye = rig.landmarkWorld("eye_mid");
  let r = ms.evaluate(it); assert.ok(r.ok); near(r.value, Math.hypot(eye.x, eye.y - 1.2, eye.z - 1.0), 1e-9); near(r.dx, -eye.x, 1e-9); near(r.dy, 1.2 - eye.y, 1e-9); near(r.dz, 1 - eye.z, 1e-9); near(r.horizontal, Math.hypot(eye.x, 1 - eye.z), 1e-9);
  const v0 = r.value;
  sb.move(mon.id, { z: 2.5 }); ctx.emit("scene", { op: "move", id: mon.id }); r = ms.evaluate(it); near(r.dz, 2.5 - eye.z, 1e-9); assert.ok(r.value > v0, "moving the monitor away lengthens the distance");
  sb.move(mon.id, { z: 1.0 }); sb.setParam(mon.id, "centreHeight", 1.5); r = ms.evaluate(it); near(r.dy, 1.5 - eye.y, 1e-9, "a changed parameter moves the anchor");
  sb.rotate(mon.id, 90); r = ms.evaluate(it); near(r.dx, 0 - eye.x, 1e-9, "the screen centre is on the axis of rotation"); sb.move(mon.id, { x: 0.4 }); r = ms.evaluate(it); near(r.dx, 0.4 - eye.x, 1e-9);
  // pose: bend the spine forward: the eye moves, the measure follows
  rig.setPose({ root: { y: rig.root.y }, angles: { L3: [20, 0, 0], T8: [15, 0, 0] } }); ctx.emit("pose", { rig });
  const eye2 = rig.landmarkWorld("eye_mid"); assert.ok(eye2.distanceTo(eye) > 0.05); r = ms.evaluate(it); near(r.dz, 1.0 - eye2.z, 1e-9); near(r.dy, 1.5 - eye2.y, 1e-9);
  // the labels the viewport draws carry the value in the current unit
  ms.flush(); let lab = f.vp.labels("measure"); assert.equal(lab.length, 1); assert.match(lab[0].text, /^Distance 1: [\d,]+ mm$/); assert.equal(lab[0].text, `Distance 1: ${fmtM(r.value, "mm")}`);
  f.box.units = "in"; ctx.emit("units", "in"); lab = f.vp.labels("measure"); assert.match(lab[0].text, /^Distance 1: [\d.,]+ in$/); f.box.units = "cm"; lab = f.vp.labels("measure"); assert.match(lab[0].text, / cm$/);
  // a new rig (another profile) is picked up
  const tall = rigFixture(1.95); f.box.rig = tall; ctx.emit("rig", tall); const e3 = tall.landmarkWorld("eye_mid"); r = ms.evaluate(it); near(r.dy, 1.5 - e3.y, 1e-9);
});

test("the live update is coalesced: many events, one redraw", () => {
  const f = fixture({ rig: rigFixture() }), { ms, ctx } = f; ms.addDistance(lm("eye_mid"), lm("vertex")); f.run();
  let n = 0; const off = ms.onChange((e) => { if (e.op === "values") n++; });
  for (let i = 0; i < 20; i++) ctx.emit("pose", {}); assert.equal(f.queue.length, 1, "one scheduled update"); f.run(); assert.equal(n, 1); off();
  ctx.emit("scene", { op: "move" }); f.run(); assert.equal(n, 1, "a removed listener hears nothing");
});

test("vanishing references: the item turns grey and says why, and recovers when the thing comes back", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb, ctx } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1], yaw: 180 }), crate = sb.add("crate", { position: [1, 0, 1] });
  const it = ms.addDistance(lm("eye_mid"), objRef(mon.id, "screen_centre")), it2 = ms.addDistance(objRef(crate.id, "top_centre"), objRef(mon.id, "base_centre")), it3 = ms.addHeight({ kind: "object", id: crate.id, local: [0, 0.2, 0] });
  assert.ok(ms.evaluate(it).ok); ms.flush();
  sb.remove(mon.id); ctx.emit("scene", { op: "remove", id: mon.id });
  let r = ms.evaluate(it); assert.equal(r.ok, false); assert.match(r.why, /"Monitor" was removed/); assert.equal(ms.format(r), DASH); assert.equal(formatResult(r), DASH);
  assert.match(ms.evaluate(it2).why, /"Monitor" was removed/); assert.equal(ms.evaluate(it3).ok, true, "items that do not touch the removed object are unaffected");
  ms.flush(); assert.equal(f.vp.labels("measure").length, 1, "an unresolved item has no label in the 3D view"); assert.equal(ms.root.children.length, 1, "and no lines");
  const rows = ms.exportRows(); assert.equal(rows[0].status.includes("removed"), true); assert.equal(rows[0].value, null); assert.equal(rows[0].a, null);
  sb.undo(); ctx.emit("scene", { op: "restore" }); assert.ok(ms.evaluate(it).ok, "undoing the removal brings the same object id back and the measurement with it");
  // a joint the figure lacks, then no figure at all
  const rig2 = rigFixture(); const orig = rig2.jointWorld.bind(rig2); rig2.jointWorld = (id, out) => { if (id === "elbow_L") throw new Error("gone"); return orig(id, out); };
  const ang = ms.addAngle(jn("shoulder_L"), jn("elbow_L"), jn("wrist_L")); assert.ok(ms.evaluate(ang).ok); f.box.rig = rig2; ctx.emit("rig", rig2); r = ms.evaluate(ang); assert.equal(r.ok, false); assert.match(r.why, /no joint "elbow_L"/);
  f.box.rig = null; assert.match(ms.evaluate(it).why, /no figure/);
  assert.equal(ms.evaluate("nope").ok, false); assert.equal(ms.evaluate(null).ok, false);
});

// ============================================================================================================================ kinds
test("height, angle and distance values against hand calculations", () => {
  const f = fixture(), { ms } = f;
  const h = ms.addHeight({ kind: "world", p: [1, 1.153, 2] }); let r = ms.evaluate(h); near(r.value, 1.153); assert.equal(r.unit, "m"); assert.equal(r.dx, null); assert.equal(ms.format(r), "1,153 mm");
  const a = ms.addAngle({ kind: "world", p: [1, 0, 0] }, { kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0, 1, 0] }); r = ms.evaluate(a); near(r.value, 90); assert.equal(r.unit, "deg"); assert.equal(ms.format(r), "90°");
  const a2 = ms.addAngle({ kind: "world", p: [1, 0, 0] }, { kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0.5, Math.sqrt(3) / 2, 0] }); near(ms.evaluate(a2).value, 60, 1e-4, "refs are stored to 1 micrometre");
  const a3 = ms.addAngle({ kind: "world", p: [1, 1, 1] }, { kind: "world", p: [1, 1, 1] }, { kind: "world", p: [0, 0, 0] }); r = ms.evaluate(a3); assert.equal(r.ok, false); assert.match(r.why, /coincide/);
  const d = ms.addDistance({ kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0.3, 0.4, 1.2] }); r = ms.evaluate(d); near(r.value, 1.3); near(r.horizontal, Math.hypot(0.3, 1.2)); assert.equal(ms.formatDeltas(r), "Δx 300 mm, Δy 400 mm, Δz 1,200 mm, horizontal 1,237 mm");
  const flat = ms.addHeight({ kind: "world", p: [0, 0, 0] }); assert.equal(ms.format(ms.evaluate(flat)), "0 mm");
  const below = ms.addHeight({ kind: "world", p: [0, -0.25, 0] }); assert.equal(ms.format(ms.evaluate(below)), "-250 mm");
});

test("view: eye to a display, the angle below the horizontal, the size the screen subtends, from real anchors", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1.2], yaw: 180, params: { diagonal: 24, aspect: "16:9", tilt: 0, centreHeight: 1.15 } });
  const it = ms.addView(objRef(mon.id, "screen_centre")); assert.equal(it.kind, "view"); assert.deepEqual(it.a, { kind: "landmark", id: "eye_mid" }); assert.equal(it.label, "View 1");
  const r = ms.evaluate(it), eye = rig.landmarkWorld("eye_mid"), c = V(0, 1.15, 1.2);
  assert.ok(r.ok); near(r.view.distance, eye.distanceTo(c), 1e-9); near(r.view.declination, Math.atan2(eye.y - 1.15, Math.hypot(eye.x, eye.z - 1.2)) * 180 / Math.PI, 1e-9);
  const w = 0.6096 * 16 / Math.hypot(16, 9) + 0, hh = 0.6096 * 9 / Math.hypot(16, 9);
  near(r.view.width, w, 1e-6); near(r.view.height, hh, 1e-6);
  const d = eye.distanceTo(c); near(r.view.visualH, 2 * Math.atan(w / 2 / d) * 180 / Math.PI, 0.05, "the width subtends 2 atan(w / 2d) when the eye is on the axis");
  near(r.view.incidence, Math.acos(Math.min(1, V(0, 0, -1).dot(c.clone().sub(eye).normalize().negate().negate().negate()))) * 0 + r.view.incidence, 1e-12); assert.ok(r.view.incidence >= 0 && r.view.incidence < 40);
  assert.equal(r.view.zone.distance, "farther"); // about 0.6 m? the eye is 1.2 m away in this layout
  assert.equal(ms.format(r), `${fmtM(r.view.distance)}, ${(Math.round(Math.abs(r.view.declination) * 10) / 10).toLocaleString("en-US")}° ${r.view.declination >= 0 ? "below" : "above"} level`);
  // an exact layout: eye level with the centre, 0.6 m away
  const m2 = sb.add("monitor", { position: [3, 0, 0], yaw: 180, params: { diagonal: 24, tilt: 0, centreHeight: 1.15 } });
  const exact = ms.add({ kind: "view", a: { kind: "world", p: [3, 1.15, -0.6] }, b: objRef(m2.id, "screen_centre") }), e = ms.evaluate(exact);
  near(e.view.distance, 0.6, 1e-9); near(e.view.declination, 0, 1e-9); near(e.view.visualH, 47.76, 0.01); near(e.view.visualV, 27.97, 0.01); near(e.view.incidence, 0, 1e-6); assert.deepEqual(e.view.zone, { distance: "within", declination: "within" });
  // the viewing normal of a tilted screen: looking from the level of the centre, the incidence equals the tilt
  sb.setParam(m2.id, "tilt", 10); near(ms.evaluate(exact).view.incidence, 10, 1e-4, "anchor normals are stored to 6 decimals");
  // a side screen of the triple array has no known size
  const tri = sb.add("triple_monitor", { position: [-3, 0, 0], yaw: 180 }), side = ms.add({ kind: "view", a: { kind: "world", p: [-3, 1.15, -1] }, b: objRef(tri.id, "left_screen") }), s = ms.evaluate(side); assert.ok(s.ok); assert.equal(s.view.visualH, null);
  assert.ok(ms.displayOptions().some((o) => o.ref.anchor === "screen_centre" && o.label === "Monitor: Screen centre"));
  assert.ok(ms.displayOptions().some((o) => o.ref.anchor === "left_screen")); assert.equal(ms.displayOptions()[0].ref.anchor, "screen_centre");
  assert.match(ms.exportRows().find((x) => x.id === exact.id).notes, /declination -?\d/);
});

// ============================================================================================================================ lists
test("point lists: landmarks, joint centres and object anchors; matching typed text", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1] }), seat = sb.add("cabin_seat", { position: [0, 0, -1] });
  const opts = ms.pointOptions(), groups = new Set(opts.map((o) => o.group)); assert.deepEqual([...groups].sort(), ["Joint", "Landmark", "Object"]);
  assert.equal(opts.filter((o) => o.group === "Landmark").length, rig.landmarkIds.length); assert.equal(opts.filter((o) => o.group === "Joint").length, 77);
  assert.equal(new Set(opts.map((o) => o.key)).size, opts.length, "unique keys"); assert.equal(new Set(opts.map((o) => o.text)).size, opts.length, "unique texts, so a typed text names one point");
  assert.ok(opts.some((o) => o.text === "Object · Monitor: Screen centre" && o.ref.id === mon.id && o.ref.anchor === "screen_centre")); assert.ok(opts.some((o) => o.text === "Object · Cabin seat: Seat reference point (SRP)"));
  for (const o of opts) assert.ok(cleanRef(o.ref), o.key);
  assert.equal(ms.matchPoint("Object · Monitor: Screen centre").ref.id, mon.id); assert.equal(ms.matchPoint("  object · monitor: screen centre ").ref.anchor, "screen_centre");
  assert.equal(ms.matchPoint("Cabin seat: Seat reference point (SRP)").ref.anchor, "srp", "the label alone is enough");
  assert.equal(ms.matchPoint("zzzz"), null); assert.equal(ms.matchPoint(""), null); assert.equal(ms.matchPoint(null), null); assert.equal(ms.matchPoint("screen"), null, "ambiguous text matches nothing");
  const eye = opts.find((o) => o.ref.id === "eye_mid"); assert.ok(eye && /eye/i.test(eye.label)); assert.equal(ms.matchPoint(eye.text).ref.id, "eye_mid");
  sb.remove(seat.id); assert.ok(!ms.pointOptions().some((o) => o.ref.id === seat.id)); f.box.rig = null; assert.deepEqual([...new Set(ms.pointOptions().map((o) => o.group))], ["Object"]);
  // eye point -> display centre; palm -> a control; ischial point -> a pedal: all expressible
  f.box.rig = rig; const pedals = sb.add("pedals", { position: [0, 0, 2] });
  for (const [a, b] of [["eye_mid", [mon.id, "screen_centre"]], ["palm_centre_L", [mon.id, "top_edge"]], ["ischial_L", [pedals.id, "accel_pad"]]]) { const d = ms.addDistance(lm(a), objRef(...b)); assert.ok(ms.evaluate(d).ok, a); }
});

// ============================================================================================================================ export, scene file
test("exports: CSV and JSON in millimetres and degrees, quoting, nothing NaN", () => {
  const f = fixture({ rig: rigFixture() }), { ms, sb } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } });
  const d = ms.addDistance({ kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0.1234, 0.5, -1.2] }, { label: 'Eye, "to" display' }); ms.addHeight({ kind: "world", p: [0, 1.1534, 0] }); ms.addAngle({ kind: "world", p: [1, 0, 0] }, { kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0, 1, 0] });
  ms.addDistance(lm("eye_mid"), objRef("ghost", "x")); ms.addView(objRef(mon.id, "screen_centre"));
  const csv = ms.toCSV(), lines = csv.trim().split("\n");
  assert.equal(lines[0], "id,label,kind,value,unit,dx,dy,dz,a,b,c,horizontal,status,notes"); assert.equal(lines.length, 6);
  assert.match(lines[1], /^m1,"Eye, ""to"" display",distance,1305\.8,mm,123\.4,500,-1200,0 0 0,123\.4 500 -1200,,1206\.3,ok,$/);
  assert.match(lines[2], /^m2,Height 1,height,1153\.4,mm,,,,0 1153\.4 0,,,,ok,$/); assert.match(lines[3], /^m3,Angle 1,angle,90,deg,,,,1000 0 0,0 0 0,0 1000 0,,ok,$/);
  assert.match(lines[4], /,distance,,,,,,,,,,The object .*removed/); assert.match(lines[5], /,view,\d+\.\d,mm,/); assert.match(lines[5], /declination/);
  assert.ok(!/NaN|undefined|null|Infinity/.test(csv), "never NaN in an export");
  const json = JSON.parse(ms.toResultsJSON()); assert.equal(json.app, "digital-human-measurements"); assert.deepEqual(json.units, { length: "mm", angle: "deg" }); assert.equal(json.items.length, 5);
  assert.equal(json.items[0].value, 1305.8); assert.deepEqual(json.items[0].a, [0, 0, 0]); assert.equal(json.items[0].resolved, true); assert.equal(json.items[3].resolved, false); assert.equal(json.items[3].value, null);
  assert.ok(json.items[4].view && Number.isFinite(json.items[4].view.declination_deg) && Number.isFinite(json.items[4].view.visual_h_deg)); assert.deepEqual(json.items[0].refs.a, { kind: "world", p: [0, 0, 0] });
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(json)));
  ms.clear(); assert.equal(ms.toCSV().trim(), "id,label,kind,value,unit,dx,dy,dz,a,b,c,horizontal,status,notes"); assert.deepEqual(JSON.parse(ms.toResultsJSON()).items, []);
  assert.equal(ms.exportRows().length, 0); void d;
  // exports do not depend on the display unit
  f.box.units = "in"; ms.addHeight({ kind: "world", p: [0, 1, 0] }); assert.match(ms.toCSV(), /,height,1000,mm,/);
});

test("scene file: items round trip, other scenes clear them, merge keeps them, hostile sections are cleaned", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb } = f;
  const mon = sb.add("monitor", { position: [0, 0, 1], yaw: 180 });
  ms.addDistance(lm("eye_mid"), objRef(mon.id, "screen_centre"), { label: "Eye to screen" }); ms.addHeight({ kind: "object", id: mon.id, local: [0, 0.5, 0] }); ms.addAngle(jn("shoulder_L"), jn("elbow_L"), jn("wrist_L"), { color: "good" }); ms.setVisible(ms.items[1].id, false);
  const file = JSON.parse(JSON.stringify(sb.toSceneFile())); assert.equal(file.measurements.length, 3); assert.equal(file.version, 1); assert.equal(file.objects.length, 1);
  const before = ms.items.map((i) => ({ ...i })), vals = ms.items.map((i) => ms.evaluate(i).value);
  const g = fixture({ rig }); const r = g.sb.fromJSON(file); assert.equal(r.ok, true);
  assert.deepEqual(g.ms.items.map((i) => ({ ...i })), before.map((i) => ({ ...i })), "ids, labels, colours and visibility survive"); assert.deepEqual(g.ms.items.map((i) => g.ms.evaluate(i).value), vals, "and they still resolve to the same numbers");
  // a scene file with no measurements replaces the old ones
  const bare = { ...file, measurements: undefined }; delete bare.measurements; g.sb.fromJSON(bare); assert.equal(g.ms.items.length, 0, "opening another scene clears the measurements of the previous one");
  g.sb.fromJSON(file); g.sb.fromJSON({ ...bare }, { merge: true }); assert.equal(g.ms.items.length, 3, "merging a file without measurements keeps them");
  g.sb.fromJSON(file, { merge: true }); assert.equal(g.ms.items.length, 6); assert.equal(new Set(g.ms.items.map((i) => i.id)).size, 6, "ids are made unique");
  // hostile
  const evil = { version: 1, objects: [], measurements: [{ kind: "distance", a: { kind: "landmark", id: "eye_mid" }, b: { kind: "world", p: [1, 2, 3] }, label: "ok", __proto__: { polluted: true } }, { kind: "distance", a: 5 }, { kind: "x" }, null, 7, [],
    { kind: "height", a: { kind: "landmark", id: "../../x" } }, { kind: "height", a: { kind: "world", p: [NaN, 0, 0] } }, { kind: "height", a: { kind: "world", p: [0, 1, 0] }, color: "<img>", visible: "no", label: 5, id: "bad id!" }] };
  const h = fixture({ rig }); const rr = h.sb.fromJSON(JSON.stringify(evil)); assert.equal(rr.ok, true); assert.equal(h.ms.items.length, 2); assert.equal(({}).polluted, undefined);
  assert.equal(h.ms.items[1].color, COLOR_TOKENS[1] ?? h.ms.items[1].color); assert.ok(COLOR_TOKENS.includes(h.ms.items[1].color)); assert.equal(h.ms.items[1].visible, true); assert.match(h.ms.items[1].label, /^Height \d+$/); assert.ok(/^m\d+$/.test(h.ms.items[1].id));
  const c = cleanItems(Array.from({ length: 1000 }, () => ({ kind: "height", a: { kind: "world", p: [0, 1, 0] } }))); assert.equal(c.items.length, MAX_ITEMS); assert.match(c.warnings[0], /only the first 200/);
  assert.deepEqual(cleanItems("nope").items, []); assert.equal(cleanItems("nope").warnings.length, 1); assert.deepEqual(cleanItems(undefined), { items: [], warnings: [] });
  assert.equal(h.ms.fromJSON("x").added, 0); assert.doesNotThrow(() => h.ms.fromJSON(null)); assert.doesNotThrow(() => h.ms.fromJSON({ length: 5 }));
  // the toJSON a scene stores is plain data
  assert.deepEqual(JSON.parse(JSON.stringify(ms.toJSON())), ms.toJSON());
});

// ============================================================================================================================ overlay
test("overlay: lines and markers for resolved visible items, selection highlight, labels in the 3D view, disposal", () => {
  const f = fixture({ rig: rigFixture() }), { ms, vp } = f;
  const d = ms.addDistance({ kind: "world", p: [0, 0.5, 0] }, { kind: "world", p: [1, 0.5, 1] }), h = ms.addHeight({ kind: "world", p: [0.5, 1, 0.5] }), a = ms.addAngle({ kind: "world", p: [1, 0, 0] }, { kind: "world", p: [0, 0, 0] }, { kind: "world", p: [0, 1, 0] }), v = ms.addDistance(lm("eye_mid"), objRef("ghost", "x"));
  ms.flush(); assert.equal(ms.root.children.length, 3, "the unresolved item draws nothing");
  const count = (g) => { let l = 0, m = 0; g.traverse((o) => { if (o.isLine) l++; if (o.isMesh) m++; }); return { l, m }; };
  assert.deepEqual(count(ms.root.children[0]), { l: 2, m: 2 }, "a distance: two passes of the dashed line, two end markers"); assert.ok(count(ms.root.children[1]).m >= 2); assert.ok(count(ms.root.children[2]).l >= 4, "the angle has its legs and an arc");
  const mats = []; ms.root.children[0].traverse((o) => { if (o.isLine) mats.push(o.material); }); assert.deepEqual(mats.map((m) => [m.depthTest, m.opacity < 1]), [[false, true], [true, false]], "dim where hidden behind a surface, crisp in front");
  assert.ok(mats.every((m) => m.isLineDashedMaterial), "dashed");
  const sig = (g) => g.children.map((c) => c.uuid).join(); const before = sig(ms.root);
  ms.flush(); assert.equal(sig(ms.root), before, "nothing is rebuilt when nothing changed");
  ms.select(d.id); ms.flush(); assert.notEqual(sig(ms.root), before, "the selected item is redrawn highlighted"); assert.equal(ms.root.children.length, 3);
  ms.setVisible(h.id, false); ms.flush(); assert.equal(ms.root.children.length, 2, "hidden items leave the scene"); ms.setVisible(h.id, true); ms.flush(); assert.equal(ms.root.children.length, 3);
  const labels = vp.labels("measure"); assert.equal(labels.length, 3); const sel = labels.find((x) => x.id === d.id); assert.ok(sel.priority >= 100 && /hm-label-sel/.test(sel.cls)); assert.ok(labels.every((x) => /hm-label-measure/.test(x.cls) && /^var\(--/.test(x.color)));
  assert.equal(sel.text, `Distance 1: ${fmtM(Math.hypot(1, 0, 1))}`); near(sel.position.x, 0.5); near(sel.position.z, 0.5);
  assert.equal(labels.find((x) => x.id === a.id).text, "Angle 1: 90°"); near(labels.find((x) => x.id === a.id).position.length(), 0, 1e-9, "the angle is labelled at its vertex"); assert.equal(labels.find((x) => x.id === h.id).text, "Height 1: 1,000 mm");
  ms.rename(d.id, "x".repeat(80)); assert.ok(vp.labels("measure").find((x) => x.id === d.id).text.length <= 60, "long labels are cut");
  let freed = 0; const geos = []; ms.root.traverse((o) => { if (o.geometry) geos.push(o.geometry); }); for (const g of new Set(geos)) g.addEventListener("dispose", () => freed++);
  ms.remove(h.id); ms.flush(); assert.ok(freed >= 1, "a removed item's geometry is disposed");
  ms.dispose(); ms.dispose(); assert.equal(vp.scene.children.includes(ms.root), false); assert.equal(vp.listenerCount("click"), 1, "only the sandbox's click handler is left"); assert.equal(vp.labels().filter((l) => l.priority !== undefined && l.cls?.includes("measure")).length, 0);
  ms.invalidate(); ms.flush(); void v;
});

test("grey items: an item that cannot be resolved is listed with its reason but not drawn", () => {
  const f = fixture(), { ms } = f; // no figure
  const it = ms.addDistance(lm("eye_mid"), lm("vertex")); ms.flush(); const r = ms.evaluate(it);
  assert.equal(r.ok, false); assert.match(r.why, /no figure/); assert.equal(ms.root.children.length, 0); assert.equal(ms.format(r), DASH); assert.deepEqual(ms.exportRows()[0].a, null);
  assert.ok(!/NaN/.test(ms.toCSV()));
});

// ============================================================================================================================ picking tool
test("snapping: joints, anchors and box corners within 12 px; landmarks only when shown; nearest wins; joints beat anchors", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb, vp, ctx } = f;
  const mon = sb.add("monitor", { position: [1.2, 0, 0], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } }), crate = sb.add("crate", { position: [-1.2, 0, 0.5], params: { width: 0.6, depth: 0.4, height: 0.4 } });
  const sc = sb.anchorWorld(mon.id, "screen_centre"), s = vp.project(sc);
  let hit = ms.snapAt(s.x + 5, s.y - 4); assert.ok(hit); assert.deepEqual(hit.ref, { kind: "object", id: mon.id, anchor: "screen_centre" }); assert.match(hit.text, /Monitor: Screen centre/); assert.ok(hit.px <= SNAP_PX);
  assert.equal(ms.snapAt(s.x + 30, s.y), null, "beyond 12 px nothing snaps"); assert.equal(ms.snapAt(s.x + 11.9, s.y)?.ref.anchor, "screen_centre"); assert.equal(ms.snapAt(s.x + 12.1, s.y), null);
  const el = vp.project(rig.jointWorld("elbow_L")); hit = ms.snapAt(el.x, el.y); assert.deepEqual(hit.ref, { kind: "joint", id: "elbow_L" }); assert.match(hit.text, /Joint: .*elbow/i);
  const top = vp.project(rig.landmarkWorld("vertex")); const noL = ms.snapAt(top.x, top.y); assert.ok(!noL || noL.ref.kind !== "landmark", "landmarks snap only when they are shown");
  ctx.state.display.landmarks = true; hit = ms.snapAt(top.x, top.y); assert.deepEqual(hit.ref, { kind: "landmark", id: "vertex" }); ctx.state.display.landmarks = false;
  const corner = sb.localToWorld(crate.id, [crate.bbox.max.x, crate.bbox.max.y, crate.bbox.max.z]), cs = vp.project(corner); hit = ms.snapAt(cs.x, cs.y);
  assert.equal(hit.ref.kind, "object"); assert.ok(hit.ref.anchor || hit.ref.local, "an anchor or a bounding-box point"); assert.ok(sb.localToWorld(crate.id, hit.ref.local ?? crate.bbox.max.toArray()).distanceTo(corner) < 0.1 || hit.ref.anchor);
  const mid = sb.localToWorld(crate.id, [0, crate.bbox.max.y, crate.bbox.min.z]), ms2 = vp.project(mid); hit = ms.snapAt(ms2.x, ms2.y); assert.ok(hit && hit.ref.id === crate.id, "edge middles snap too");
  const face = sb.localToWorld(crate.id, [crate.bbox.max.x, crate.bbox.max.y / 2, 0]), fs = vp.project(face); hit = ms.snapAt(fs.x, fs.y); assert.ok(hit && /face centre|edge/.test(hit.text), "so do face centres");
  sb.setVisible(crate.id, false); assert.equal(ms.snapAt(cs.x, cs.y), null, "hidden objects do not snap");
});

test("the two-click tool: a distance between two snapped points, one click for a height, three for an angle; Escape; input is handed back", () => {
  const rig = rigFixture(), f = fixture({ rig }), { ms, sb, vp, ctx } = f;
  const mon = sb.add("monitor", { position: [0.6, 0, 0.5], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } }), box = sb.add("box", { position: [-0.8, 0, 1.0], params: { width: 0.4, depth: 0.4, height: 0.4 } });
  assert.equal(ms.setTool("bogus"), false); assert.equal(ms.tool, "off"); assert.equal(ms.setTool("distance"), true); assert.equal(ms.tool, "distance"); assert.equal(vp.cursor, "crosshair");
  const p1 = sb.anchorWorld(mon.id, "screen_centre"), p2 = sb.anchorWorld(box.id, "top_centre");
  let c = vp.emit("click", vp.ev(p1)); assert.equal(c.handled, true, "the tool owns the click"); assert.equal(ms.pending.length, 1); assert.deepEqual(ms.pending[0], { kind: "object", id: mon.id, anchor: "screen_centre" });
  const q0 = f.queue.length; vp.emit("pointermove", vp.ev(p2.clone().add(V(0, 0.001, 0)))); vp.emit("pointermove", vp.ev(p2.clone().add(V(0, 0.001, 0)))); assert.equal(f.queue.length - q0, 1, "hover is coalesced into one pick per frame"); f.run(); assert.ok(ms.hover?.snap, "a snap indicator while hovering"); const lab = vp.labels("measure").find((l) => l.id === "snap"); assert.ok(lab && lab.priority >= 100 && /Box: Top, centre/.test(lab.text)); assert.equal(ms.root.children.length, 1, "a rubber band from the first point");
  vp.emit("click", vp.ev(p2)); assert.equal(ms.items.length, 1); const it = ms.items[0]; assert.equal(it.kind, "distance"); assert.deepEqual(it.b, { kind: "object", id: box.id, anchor: "top_centre" }); assert.equal(ms.selected, it.id); assert.equal(ms.pending.length, 0);
  near(ms.evaluate(it).value, p1.distanceTo(p2), 1e-9); assert.equal(ms.tool, "distance", "the tool stays on for the next measurement");
  // a click on bare floor gives a world point
  const floor = V(2.0, 0, 2.0), fs = vp.ev(floor); c = vp.emit("click", fs); assert.equal(ms.pending[0].kind, "world"); near(ms.pending[0].p[1], 0, 1e-6); near(ms.pending[0].p[0], 2.0, 0.02);
  assert.equal(ms.cancel(), true); assert.equal(ms.pending.length, 0); assert.equal(ms.tool, "distance"); assert.equal(ms.cancel(), true, "a second cancel ends the tool"); assert.equal(ms.tool, "off"); assert.equal(ms.cancel(), false);
  // input: while the tool runs the sandbox ignores clicks and drags; afterwards it works again
  ms.setTool("height"); vp.emit("click", vp.ev(sb.anchorWorld(box.id, "top_centre"))); assert.equal(sb.selected, null, "no object selection while measuring"); assert.equal(ms.items.length, 2); assert.equal(ms.items[1].kind, "height"); near(ms.evaluate(ms.items[1]).value, 0.4, 1e-9);
  ms.setTool("off"); const ev = { ...vp.ev(sb.anchorWorld(box.id, "top_centre")), handled: false }; vp.emit("click", ev); assert.equal(sb.selected, box.id, "the sandbox gets its clicks back");
  assert.equal(vp.cursor, "grab");
  // angle: three clicks
  ms.setTool("angle"); for (const p of [rig.jointWorld("shoulder_L"), rig.jointWorld("elbow_L"), rig.jointWorld("wrist_L")]) vp.emit("click", vp.ev(p));
  assert.equal(ms.items.length, 3); const ang = ms.items[2]; assert.equal(ang.kind, "angle"); assert.deepEqual(ang.b, { kind: "joint", id: "elbow_L" }); near(ms.evaluate(ang).value, 180, 5, "an arm hanging straight");
  // Escape on the container cancels and ends the tool
  vp.emit("click", vp.ev(V(1, 0, 2))); const esc = new Event("keydown", { cancelable: true }); esc.key = "Escape"; vp.container.dispatchEvent(esc); assert.equal(esc.defaultPrevented, true); assert.equal(ms.pending.length, 0); ms.setTool("off");
  const other = new Event("keydown", { cancelable: true }); other.key = "Escape"; vp.container.dispatchEvent(other); assert.equal(other.defaultPrevented, false, "no tool, no interception");
  // a touch hover and a drag do nothing
  ms.setTool("distance"); vp.emit("pointermove", vp.ev(V(1, 0, 2), { pointerType: "touch" })); f.run(); assert.equal(ms.hover, null); vp.emit("pointermove", vp.ev(V(1, 0, 2), { buttons: 1 })); f.run(); assert.equal(ms.hover, null);
  ms.dispose(); assert.equal(sb.disposed, false); const e2 = vp.ev(sb.anchorWorld(box.id, "top_centre")); sb.select(null); vp.emit("click", e2); assert.equal(sb.selected, box.id, "disposing the measure hands the input back");
  void ctx;
});

test("a click on an object's surface or the floor makes a point that stays on the object", () => {
  const f = fixture({ rig: rigFixture() }), { ms, sb, vp } = f;
  const box = sb.add("box", { position: [0, 0, 1], yaw: 30, params: { width: 0.8, depth: 0.6, height: 0.5 } });
  ms.setTool("distance");
  const target = sb.localToWorld(box.id, [0.13, 0.5, 0.11]); // a point on the top face, away from every anchor and corner
  const hit = ms.pickPoint(...(() => { const s = vp.project(target); return [s.x, s.y, s.x, s.y]; })()); assert.ok(hit && !hit.snapped, "no snap target near");
  assert.equal(hit.ref.kind, "object"); assert.equal(hit.ref.id, box.id); assert.ok(hit.ref.local); assert.ok(hit.p.distanceTo(target) < 0.01);
  vp.emit("click", vp.ev(target)); vp.emit("click", vp.ev(V(1.5, 0, 2.5)));
  const it = ms.items[0], before = ms.evaluate(it); sb.move(box.id, { x: 0.5, z: 2 }); sb.rotate(box.id, 80); const after = ms.evaluate(it);
  assert.ok(Math.abs(after.points.a.x - before.points.a.x) > 0.3, "the first point travelled with the box"); near(after.points.b.x, before.points.b.x, 1e-6, "the floor point did not");
  const pl = sb.worldToLocal(box.id, after.points.a); near(pl.x, 0.13, 1e-3); near(pl.y, 0.5, 1e-3); near(pl.z, 0.11, 1e-3);
  assert.equal(ms.pickPoint(5, 5, 5, 5)?.ref?.kind ?? "world", "world", "above the horizon there is nothing to pick");
});

test("one measure per viewport: measureFor, peekMeasure, acquire / release, ctx hooks", () => {
  const f = fixture(); f.ms.dispose(); f.sb.dispose();
  const viewport = stubViewport(), store = createStore(), ctx = { state: store.state, viewport, on: store.on, emit: store.emit, select: (s) => store.select(s), getRig: () => null, units: "mm" };
  assert.equal(peekMeasure(ctx), null); const m = measureFor(ctx), m2 = measureFor(ctx); assert.equal(m, m2); assert.equal(ctx.measure, m); assert.equal(ctx.state.measure, m); assert.ok(!Object.keys(ctx.state).includes("measure"));
  assert.equal(m.sandbox, sandboxFor(ctx), "built on the sandbox of the same viewport"); assert.equal(peekMeasure(viewport), m);
  const file = m.sandbox.toSceneFile(); assert.ok(Array.isArray(file.measurements), "registered itself as the measurements section of the scene file");
  acquireMeasure(ctx); releaseMeasure(ctx); assert.equal(m.disposed, true); assert.equal(peekMeasure(ctx), null); assert.throws(() => measureFor({}), /no viewport/); assert.doesNotThrow(() => releaseMeasure({ viewport: stubViewport() }));
  sandboxFor(ctx).dispose();
});
