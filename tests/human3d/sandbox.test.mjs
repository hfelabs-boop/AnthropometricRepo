// The sandbox of the Digital human tab without WebGL: the object catalogue (catalog.js) and the scene manager (sandbox.js) against a stub viewport
// and the real state store of the shell. The browser side (drag with a real mouse, the gizmo, labels, panels) is tests/human3d/test_sandbox.py.
// Run: node --import ./tests/human3d/register.mjs --test tests/human3d/sandbox.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CATALOG, CATEGORIES, byType, buildObject, disposeObject, defaultParams, normalizeParams, clampParams, SWATCHES, isHexColor } from "../../site/js/human/catalog.js";
import {
  createSandbox, sandboxFor, peekSandbox, acquireSandbox, releaseSandbox, snapValue, snapAngle, normalizeYaw, arrowToWorld, rectsOverlap, pointInPolygon, findFreeSpot,
  validateScene, parseSceneText, cleanAttachment, TEMPLATES, TEMPLATE_GROUPS, MAX_OBJECTS, MAX_HISTORY, MAX_TEXT, SCENE_VERSION, GRID_STEPS_MM, ANGLE_STEPS, yawOfQuaternion,
} from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";
import { createMeasure } from "../../site/js/human/measure.js";
import { Worker } from "node:worker_threads";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b} (eps ${eps})`);
const vnear = (v, [x, y, z], eps = 1e-6) => { near(v.x, x, eps, `x ${v.x} != ${x}`); near(v.y, y, eps, `y ${v.y} != ${y}`); near(v.z, z, eps, `z ${v.z} != ${z}`); };

// ------------------------------------------------------------------------------------------------------------------------------------ stubs
const W = 800, H = 600;
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 120);
  camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 0.6, 0.8); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const handlers = new Map(), container = new EventTarget(), raycaster = new THREE.Raycaster(), labelSources = new Map();
  const vp = {
    scene, camera, container, controls: { enabled: true }, active: true, theme: { accent: new THREE.Color(0x2a78d6) }, gizmo: null, gizmoDragging: false, canvas: null,
    renders: 0, cursor: "", frames: [],
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() { vp.renders++; },
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    emit(evt, ev = {}) { for (const f of [...(handlers.get(evt) ?? [])]) f(ev); return ev; },
    listenerCount: (evt) => handlers.get(evt)?.size ?? 0,
    ray(cx, cy) { camera.updateMatrixWorld(); raycaster.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), camera); return raycaster; },
    toClient(v) { const p = v.clone().project(camera); return { clientX: (p.x * 0.5 + 0.5) * W, clientY: (-p.y * 0.5 + 0.5) * H }; },
    attachGizmo(o, opts) { vp.gizmo = { object: o, mode: opts.mode, axis: null, showX: true, showY: true, showZ: true, snap: opts.snap }; },
    detachGizmo() { vp.gizmo = null; }, setGizmoOptions(o) { if (vp.gizmo && o.snap !== undefined) vp.gizmo.snap = o.snap; },
    setCursor(c) { vp.cursor = c; }, addLabelSource(k, fn) { labelSources.set(k, fn); return () => labelSources.delete(k); }, removeLabelSource(k) { labelSources.delete(k); },
    labels: () => [...labelSources.values()].flatMap((f) => f()), frame(b) { vp.frames.push(b); },
  };
  return vp;
}
function stubCtx({ rig = null, viewport = stubViewport() } = {}) {
  const store = createStore(), toasts = [], events = [];
  store.on("selection", () => {});
  const ctx = { state: store.state, viewport, on: store.on, emit: (e, d) => { events.push([e, d]); store.emit(e, d); }, select: (s) => store.select(s), getRig: () => rig, toast: (m) => toasts.push(m), units: "mm" };
  return { ctx, store, toasts, events, setRig(r) { rig = r; } };
}
function fixture(opts = {}) {
  const { ctx, store, toasts, events, setRig } = stubCtx(opts);
  const sb = createSandbox({ viewport: ctx.viewport, ctx, storage: opts.storage, scheduler: opts.scheduler ?? ((fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); }) });
  return { sb, ctx, vp: ctx.viewport, store, toasts, events, setRig };
}
const key = (k, { target, defaultPrevented, ...extra } = {}) => {
  const e = new Event("keydown", { cancelable: true });
  Object.assign(e, { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, extra);
  if (target) Object.defineProperty(e, "target", { value: target }); // Event.target is a getter: a stub element stands in for the focused control
  if (defaultPrevented) e.preventDefault();
  return e;
};
const ptr = (vp, v, extra = {}) => ({ ...vp.toClient(v), button: 0, buttons: 1, shift: false, alt: false, pointerType: "mouse", originalEvent: { isPrimary: true, pointerId: 1 }, ...extra });
const ids = (sb) => [...sb.objects.keys()];

// ============================================================================================================================ catalogue
test("catalogue: at least 45 types, unique ids, every category filled, required types present", () => {
  assert.ok(CATALOG.length >= 45, `${CATALOG.length} types`);
  assert.equal(new Set(CATALOG.map((t) => t.type)).size, CATALOG.length);
  assert.deepEqual(CATEGORIES.map((c) => c.name), ["Seating", "Displays", "Boxes and loads", "Structures", "Tools and controls", "Reference", "Imported"]);
  for (const c of CATEGORIES) assert.ok(c.types.length >= (c.name === "Imported" ? 1 : 5), `${c.name} has ${c.types.length}`);
  assert.equal(CATEGORIES.reduce((n, c) => n + c.types.length, 0), CATALOG.length, "every type is in exactly one category");
  const need = ["cabin_seat", "office_chair", "stool", "bar_stool", "bench", "jump_seat", "monitor", "triple_monitor", "hud_panel", "tablet", "laptop", "wall_display", "instrument_panel",
    "crate", "small_box", "pallet", "ammo_can", "toolbox", "rucksack", "drum", "sandbag", "jerrycan", "floor_platform", "step", "stairs", "ladder", "desk", "workbench", "shelving", "wall", "doorway", "hatch",
    "partition", "handrail", "console", "steering_wheel", "joystick", "throttle", "pedals", "hammer", "wrench", "screwdriver", "drill", "rifle", "pistol", "binoculars", "radio_handset", "shovel",
    "grab_handle", "horizontal_bar", "lever", "keyboard_mouse", "flashlight", "cube_1m", "measuring_pole", "point_marker", "box", "cylinder", "floor_tile",
    "equipment_rack", "cabin_shell", "side_console", "cad_model"];
  for (const t of need) assert.ok(byType(t), `type ${t} is missing`);
  assert.equal(byType("nope"), null);
  assert.equal(byType("__proto__"), null);
  assert.equal(byType(undefined), null);
});

function variants(t) {
  const lo = {}, hi = {}, mid = {};
  for (const p of t.params) {
    if (p.kind === "number") { lo[p.key] = p.min; hi[p.key] = p.max; mid[p.key] = p.default; } else if (p.kind === "bool") { lo[p.key] = false; hi[p.key] = true; mid[p.key] = p.default; } else if (p.kind === "text") { lo[p.key] = hi[p.key] = mid[p.key] = p.default; } else { lo[p.key] = p.options[0].value; hi[p.key] = p.options.at(-1).value; mid[p.key] = p.default; }
  }
  const flip = {};
  for (const p of t.params) flip[p.key] = p.kind === "bool" ? !p.default : mid[p.key];
  return { default: {}, min: lo, max: hi, flipped: flip };
}

test("catalogue: parameter specs are well formed", () => {
  for (const t of CATALOG) {
    assert.ok(t.name && t.description && t.category, t.type);
    assert.match(t.defaultColor, /^#[0-9a-f]{6}$/i, `${t.type} colour`);
    assert.ok(Array.isArray(t.params) && t.params.length >= 1, `${t.type} has parameters`);
    const keys = new Set();
    for (const p of t.params) {
      assert.ok(p.key && p.label && !keys.has(p.key), `${t.type}.${p.key}`);
      keys.add(p.key);
      assert.ok(["number", "bool", "choice", "text"].includes(p.kind));
      assert.equal(typeof p.unit, "string");
      if (p.kind === "number") {
        assert.ok(p.min < p.max && p.step > 0 && p.default >= p.min && p.default <= p.max, `${t.type}.${p.key} range`);
      } else if (p.kind === "choice") assert.ok(p.options.length >= 2 && p.options.some((o) => o.value === p.default), `${t.type}.${p.key} options`);
      else if (p.kind === "text") assert.ok(p.pattern instanceof RegExp && p.maxLength > 0 && p.hidden === true && typeof p.default === "string", `${t.type}.${p.key} text`);
      else assert.equal(typeof p.default, "boolean");
    }
    if (t.scaleMap) for (const v of Object.values(t.scaleMap)) assert.ok(keys.has(v), `${t.type} scaleMap ${v}`);
  }
});

test("catalogue: every type builds at default, minimum, maximum and flipped parameters into a sane, bounded object that stays above the floor", () => {
  for (const t of CATALOG) {
    for (const [vn, params] of Object.entries(variants(t))) {
      const g = t.build(params), tag = `${t.type}/${vn}`;
      assert.ok(g instanceof THREE.Group, tag);
      const b = g.userData.bbox, s = b.getSize(new THREE.Vector3());
      assert.ok([b.min, b.max].every((v) => Number.isFinite(v.x + v.y + v.z)), `${tag} bbox finite`);
      assert.ok(Math.min(s.x, s.y, s.z) > 1e-3, `${tag} non-degenerate ${s.toArray()}`);
      assert.ok(b.min.y > -1e-3, `${tag} below the floor by ${b.min.y}`);
      assert.ok(Math.max(s.x, s.y, s.z) < 20, `${tag} absurd size`);
      let meshes = 0, tris = 0;
      g.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        const pos = o.geometry.attributes.position;
        tris += pos.count / 3;
        for (const v of pos.array) if (!Number.isFinite(v)) assert.fail(`${tag}: NaN in a position`);
        assert.equal(o.receiveShadow, true, `${tag} receives shadows`);
        assert.equal(o.castShadow, !o.material.transparent, `${tag} casts shadows unless translucent`);
      });
      assert.ok(meshes >= 1 && meshes < 40, `${tag}: ${meshes} draw calls`);
      assert.ok(tris < 60000, `${tag}: ${tris} triangles`);
      disposeObject(g);
    }
  }
});

test("catalogue: anchors, grips and supports are finite and lie on or inside the object", () => {
  for (const t of CATALOG) {
    for (const [vn, params] of Object.entries(variants(t))) {
      const tag = `${t.type}/${vn}`, g = t.build(params), box = g.userData.bbox.clone().expandByScalar(0.02);
      const anchors = t.anchors(params);
      assert.ok(Object.keys(anchors).length >= 1, `${tag} has anchors`);
      for (const [id, a] of Object.entries(anchors)) {
        assert.ok(a.label && a.position.length === 3 && a.position.every(Number.isFinite), `${tag}.${id}`);
        assert.ok(box.containsPoint(new THREE.Vector3(...a.position)), `${tag}: anchor ${id} ${a.position} is outside ${g.userData.bbox.min.toArray()} .. ${g.userData.bbox.max.toArray()}`);
        if (a.normal) near(Math.hypot(...a.normal), 1, 1e-5, `${tag}.${id} normal`);
      }
      for (const gr of t.grips(params)) {
        assert.ok(["L", "R", "both"].includes(gr.hand) && gr.id && gr.label, `${tag} grip ${gr.id}`);
        for (const v of [...gr.position, ...gr.normal, ...gr.axis, gr.diameter]) assert.ok(Number.isFinite(v), `${tag} grip ${gr.id} finite`);
        near(Math.hypot(...gr.normal), 1, 1e-5); near(Math.hypot(...gr.axis), 1, 1e-5);
        assert.ok(gr.diameter >= 0 && gr.diameter < 0.2);
        assert.ok(box.containsPoint(new THREE.Vector3(...gr.position)), `${tag}: grip ${gr.id} ${gr.position} is outside`);
      }
      const bb = g.userData.bbox;
      for (const s of t.supports(params)) {
        assert.ok(s.id && s.label && s.size[0] > 0 && s.size[1] > 0 && [s.y, ...s.size, ...s.center].every(Number.isFinite), `${tag} support ${s.id}`);
        assert.ok(s.y >= bb.min.y - 0.02 && s.y <= bb.max.y + 0.02, `${tag}: support ${s.id} y=${s.y}`);
        assert.ok(s.center[0] - s.size[0] / 2 >= bb.min.x - 0.02 && s.center[0] + s.size[0] / 2 <= bb.max.x + 0.02 && s.center[1] - s.size[1] / 2 >= bb.min.z - 0.02 && s.center[1] + s.size[1] / 2 <= bb.max.z + 0.02, `${tag}: support ${s.id} footprint sticks out`);
      }
      disposeObject(g);
    }
  }
});

test("catalogue: the types the spec names have the anchors, grips and supports it asks for", () => {
  const A = (t, p = {}) => Object.keys(byType(t).anchors(p)), G = (t, p = {}) => byType(t).grips(p), S = (t, p = {}) => byType(t).supports(p);
  for (const id of ["srp", "h_point", "back_top", "headrest_centre", "cushion_front_edge"]) assert.ok(A("cabin_seat").includes(id), `cabin seat anchor ${id}`);
  assert.equal(S("cabin_seat").length, 1);
  for (const id of ["screen_centre", "top_edge", "bottom_edge", "left_edge", "right_edge"]) assert.ok(A("monitor").includes(id), `monitor anchor ${id}`);
  assert.ok(byType("monitor").anchors({}).screen_centre.normal, "the monitor's viewing normal");
  assert.ok(A("monitor").includes("viewing_normal"));
  assert.ok(A("triple_monitor").includes("left_screen") && A("triple_monitor").includes("right_screen"));
  assert.deepEqual(G("steering_wheel").map((g) => g.hand).sort(), ["L", "R"]);
  const rifle = G("rifle"); assert.deepEqual(rifle.map((g) => `${g.id}:${g.hand}`).sort(), ["handguard:L", "pistol_grip:R"]);
  assert.ok(S("stairs", { steps: 7 }).length === 7 && S("shelving", { shelves: 5 }).length === 5);
  for (const t of ["office_chair", "stool", "bar_stool", "bench", "jump_seat", "step", "floor_platform", "desk", "workbench", "pallet", "crate", "box"]) assert.ok(S(t).length >= 1, `${t} has a support`);
  for (const t of ["crate", "small_box", "pallet", "ammo_can", "toolbox", "rucksack", "drum", "sandbag", "jerrycan"]) assert.ok(byType(t).params.some((p) => p.key === "mass") === true, `${t} has a mass`);
  assert.deepEqual(byType("monitor").params.find((p) => p.key === "aspect").options.map((o) => o.value), ["16:9", "16:10", "21:9"]);
  const d = byType("monitor").params.find((p) => p.key === "diagonal"); assert.ok(d.min === 15 && d.max === 49);
  const seat = (k) => byType("cabin_seat").params.find((p) => p.key === k);
  assert.deepEqual([seat("seatHeight").min, seat("seatHeight").max], [0.25, 0.60]); assert.deepEqual([seat("panDepth").min, seat("panDepth").max], [0.35, 0.55]);
  assert.deepEqual([seat("panAngle").min, seat("panAngle").max], [-5, 15]); assert.deepEqual([seat("recline").min, seat("recline").max], [90, 140]);
  const wheel = byType("steering_wheel").params.find((p) => p.key === "diameter"); assert.deepEqual([wheel.min, wheel.max], [0.30, 0.45]);
  assert.equal(byType("rifle").params.find((p) => p.key === "length").default, 0.84);
});

test("catalogue: cabin seat geometry follows its parameters (SRP, pan direction, back angle)", () => {
  const p = { seatHeight: 0.42, panDepth: 0.5, panAngle: 8, recline: 110, backHeight: 0.6 }, a = byType("cabin_seat").anchors(p), v = (id) => new THREE.Vector3(...a[id].position);
  vnear(v("srp"), [0, 0.42, 0]); vnear(v("h_point"), [0, 0.42, 0]);
  const u = new THREE.Vector3(0, Math.sin(8 * Math.PI / 180), Math.cos(8 * Math.PI / 180));
  vnear(v("cushion_front_edge").clone().sub(v("srp")), u.clone().multiplyScalar(0.5).toArray(), 1e-5);
  const back = v("back_top").clone().sub(v("srp"));
  near(back.length(), 0.6, 1e-5);
  near(back.angleTo(u) * 180 / Math.PI, 110, 1e-4, "angle between the pan and the back is the back angle parameter");
  assert.ok(back.z < 0 && back.y > 0, "the back leans away from the sitter");
  const s = byType("cabin_seat").supports(p)[0];
  assert.equal(s.pitch, 8); assert.ok(s.y > 0.42, "the pan rises towards the front");
});

test("catalogue: monitor dimensions from the diagonal and aspect ratio (24 inch 16:9)", () => {
  const t = byType("monitor"), a = t.anchors({ diagonal: 24, aspect: "16:9", tilt: 0, centreHeight: 1.2 }), d = (x, y) => new THREE.Vector3(...a[x].position).distanceTo(new THREE.Vector3(...a[y].position));
  const w = 0.6096 * 16 / Math.hypot(16, 9), h = 0.6096 * 9 / Math.hypot(16, 9);
  near(d("left_edge", "right_edge"), w, 1e-5); near(d("top_edge", "bottom_edge"), h, 1e-5);
  vnear(new THREE.Vector3(...a.screen_centre.position), [0, 1.2, 0]);
  assert.deepEqual(a.screen_centre.normal, [0, 0, 1], "faces +Z when not tilted");
  const tilted = t.anchors({ diagonal: 24, aspect: "16:9", tilt: 10, centreHeight: 1.2 });
  near(tilted.screen_centre.normal[1], Math.sin(10 * Math.PI / 180), 1e-5, "tilting back turns the normal upwards");
  const wide = t.anchors({ diagonal: 34, aspect: "21:9", tilt: 0, centreHeight: 1.2 });
  near(new THREE.Vector3(...wide.left_edge.position).distanceTo(new THREE.Vector3(...wide.right_edge.position)) / new THREE.Vector3(...wide.top_edge.position).distanceTo(new THREE.Vector3(...wide.bottom_edge.position)), 21 / 9, 1e-5);
});

test("catalogue: steering wheel grips sit at 9 and 3 o'clock and pedals are measured from the heel point", () => {
  const p = { diameter: 0.4, tilt: 30, centreHeight: 0.8, spokes: 3 }, g = byType("steering_wheel").grips(p), L = g.find((x) => x.hand === "L"), R = g.find((x) => x.hand === "R");
  near(L.position[0], -0.2, 1e-6); near(R.position[0], 0.2, 1e-6); near(L.position[1], 0.8, 1e-6);
  assert.equal(L.normal[0], 1); assert.equal(R.normal[0], -1);
  near(Math.hypot(...L.position.map((c, i) => c - R.position[i])), 0.4, 1e-6, "the grips are a diameter apart");
  const a = byType("pedals").anchors({});
  assert.deepEqual(a.heel_point.position, [0, 0.01, 0]);
  assert.ok(a.accel_pad && a.brake_pad && a.clutch_pad);
  assert.ok(!byType("pedals").anchors({ clutch: false }).clutch_pad, "no clutch pad without a clutch");
});

test("catalogue: parameters are clamped, completed and cleaned", () => {
  const t = byType("monitor");
  const p = normalizeParams("monitor", { diagonal: 1000, aspect: "4:3", tilt: -99, centreHeight: "1.3", extra: 5, __proto__: { x: 1 } });
  assert.deepEqual(Object.keys(p).sort(), ["aspect", "centreHeight", "diagonal", "tilt"]);
  assert.equal(p.diagonal, 49); assert.equal(p.aspect, "16:9"); assert.equal(p.tilt, -5); assert.equal(p.centreHeight, 1.3);
  assert.equal(normalizeParams("monitor", { diagonal: NaN }).diagonal, 24);
  assert.equal(normalizeParams("monitor", { diagonal: Infinity }).diagonal, 24, "a non-finite number falls back to the default");
  assert.equal(normalizeParams("monitor", { diagonal: 1e308 }).diagonal, 49, "a huge finite number is clamped");
  assert.equal(normalizeParams("monitor", { diagonal: "abc" }).diagonal, 24);
  assert.equal(normalizeParams("monitor", { diagonal: null }).diagonal, 24);
  assert.equal(normalizeParams("stairs", { steps: 5.6 }).steps, 6, "counts are integers");
  assert.equal(normalizeParams("cabin_seat", { armrests: "true" }).armrests, true);
  assert.equal(normalizeParams("cabin_seat", { armrests: "yes" }).armrests, false);
  assert.deepEqual(normalizeParams("monitor", null), defaultParams("monitor"));
  assert.deepEqual(normalizeParams("monitor", [1, 2]), defaultParams("monitor"));
  assert.throws(() => normalizeParams("nope", {}), /unknown object type/);
  assert.equal(({}).x, undefined, "Object.prototype is untouched");
  assert.ok(Object.isFrozen(t.params));
  assert.equal(clampParams(t, { tilt: 7.5 }).tilt, 7.5);
});

test("catalogue: dispose frees geometries and owned materials, never the shared palette", () => {
  const g = buildObject("crate", {}), geos = [], mats = [];
  g.traverse((o) => { if (o.isMesh) { geos.push(o.geometry); mats.push(o.material); } });
  const disposed = new Set();
  for (const x of [...geos, ...mats]) x.addEventListener("dispose", () => disposed.add(x));
  disposeObject(g);
  for (const x of geos) assert.ok(disposed.has(x), "geometry disposed");
  assert.ok(mats.some((m) => disposed.has(m)), "the object's own material is disposed");
  assert.ok(mats.some((m) => m.userData.shared && !disposed.has(m)), "shared palette materials survive");
  assert.doesNotThrow(() => disposeObject(null));
  // two objects share the palette but not the main material, so a colour override does not leak
  const a = buildObject("box", {}, { color: "#ff0000" }), b = buildObject("box", {});
  assert.notEqual(a.children[0].material.color.getHex(), b.children[0].material.color.getHex());
  assert.ok(isHexColor(SWATCHES[0].hex) && SWATCHES.length >= 8);
  assert.ok(!isHexColor("red") && !isHexColor("#12345") && !isHexColor(null));
});

// ============================================================================================================================ pure maths
test("snapping: grid steps, angle steps, wrap-around, never -0", () => {
  assert.deepEqual(GRID_STEPS_MM, [0, 5, 10, 25, 50, 100]); assert.deepEqual(ANGLE_STEPS, [0, 5, 15, 45, 90]);
  near(snapValue(0.1234, 0), 0.1234);
  near(snapValue(0.1234, 5), 0.125); near(snapValue(0.1234, 10), 0.12); near(snapValue(0.1234, 25), 0.125); near(snapValue(0.1234, 50), 0.1); near(snapValue(0.1234, 100), 0.1);
  near(snapValue(-0.1234, 25), -0.125); near(snapValue(1.2, 100), 1.2);
  assert.ok(Object.is(snapValue(-0.0004, 10), 0), "no negative zero");
  assert.ok(Number.isNaN(snapValue(NaN, 10)));
  assert.equal(snapAngle(52, 15), 45); assert.equal(snapAngle(53, 15), 60); assert.equal(snapAngle(100, 90), 90); assert.equal(snapAngle(-100, 90), -90); assert.equal(snapAngle(44, 0), 44); assert.equal(snapAngle(182, 5), 180); assert.equal(snapAngle(183, 5), -175);
  assert.equal(normalizeYaw(190), -170); assert.equal(normalizeYaw(-190), 170); assert.equal(normalizeYaw(180), 180); assert.equal(normalizeYaw(-180), 180); assert.equal(normalizeYaw(720), 0); assert.equal(normalizeYaw(NaN), 0); assert.ok(Object.is(normalizeYaw(-0), 0));
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.5); near(yawOfQuaternion(q), 2.5 * 180 / Math.PI, 1e-9);
});

test("arrow keys map to world axes through the camera direction", () => {
  assert.deepEqual(arrowToWorld("ArrowUp", 0, -1), [0, -1], "looking along -Z, Up moves away from the camera");
  assert.deepEqual(arrowToWorld("ArrowDown", 0, -1), [0, 1]);
  assert.deepEqual(arrowToWorld("ArrowRight", 0, -1), [1, 0], "the viewer's right is +X when looking along -Z");
  assert.deepEqual(arrowToWorld("ArrowLeft", 0, -1), [-1, 0]);
  assert.deepEqual(arrowToWorld("ArrowRight", 1, 0), [0, 1], "looking along +X the right hand is +Z");
  assert.deepEqual(arrowToWorld("ArrowUp", 0.3, -0.9), [0, -1], "snapped to the nearest axis");
  assert.deepEqual(arrowToWorld("ArrowUp", 0, 0), [0, -1], "straight down falls back to -Z");
  assert.equal(arrowToWorld("a", 0, 1), null);
});

test("rectangle overlap, point in polygon and the free-spot search", () => {
  const r = (cx, cz, hx, hz, yaw = 0) => ({ cx, cz, hx, hz, yaw });
  assert.equal(rectsOverlap(r(0, 0, 1, 1), r(1.5, 0, 1, 1)), true);
  assert.equal(rectsOverlap(r(0, 0, 1, 1), r(2.5, 0, 1, 1)), false);
  assert.equal(rectsOverlap(r(0, 0, 1, 1), r(2, 0, 1, 1)), false, "touching is not overlapping");
  assert.equal(rectsOverlap(r(0, 0, 1, 1), r(1.5, 1.5, 1, 1, 45)), true, "rotated");
  assert.equal(rectsOverlap(r(0, 0, 1, 0.1), r(0.5, 0.9, 0.1, 1, 0)), true);
  assert.equal(rectsOverlap(r(0, 0, 1, 0.1), r(0, 0.5, 1, 0.1, 90)), true, "a plank rotated by 90 degrees crosses it");
  assert.equal(rectsOverlap(r(0, 0, 1, 0.1, 90), r(0.5, 0, 0.1, 0.1, 0)), false, "a rotated plank no longer reaches x = 0.5");
  const sq = [[0, 0], [2, 0], [2, 2], [0, 2]];
  assert.equal(pointInPolygon(1, 1, sq), true); assert.equal(pointInPolygon(3, 1, sq), false); assert.equal(pointInPolygon(1, 1, [...sq].reverse()), true);
  const others = [r(0, 0.9, 0.3, 0.3)], spot = findFreeSpot({ hx: 0.3, hz: 0.3 }, others, r(0, 0, 0.32, 0.25));
  assert.ok(!rectsOverlap(r(spot[0], spot[1], 0.34, 0.34), others[0]) && !rectsOverlap(r(spot[0], spot[1], 0.34, 0.34), r(0, 0, 0.32, 0.25)));
  assert.ok(spot[1] > 0.3, "in front of the figure");
});

// ============================================================================================================================ add / remove / history
test("add: default spot is in front of the figure, objects never overlap, names are unique, events are emitted", () => {
  const { sb, events } = fixture();
  const types = ["cabin_seat", "monitor", "crate", "desk", "pallet", "office_chair", "ladder", "rifle", "drum", "shelving", "wall", "stool", "monitor", "monitor"];
  const objs = types.map((t) => sb.add(t));
  assert.equal(sb.objects.size, types.length);
  for (const o of objs) { assert.ok(o.position[2] > 0 || Math.abs(o.position[0]) > 0.4, `${o.name} is in front of / beside the figure`); assert.equal(o.position[1], 0); }
  const rects = objs.map((o) => { const b = o.bbox, c = Math.cos(o.yaw * Math.PI / 180), s = Math.sin(o.yaw * Math.PI / 180), cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2; return { cx: o.position[0] + cx * c + cz * s, cz: o.position[2] - cx * s + cz * c, hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2, yaw: o.yaw }; });
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!rectsOverlap(rects[i], rects[j]), `${objs[i].name} overlaps ${objs[j].name}`);
  assert.equal(new Set(objs.map((o) => o.name)).size, objs.length, "unique names");
  assert.deepEqual(objs.filter((o) => o.type === "monitor").map((o) => o.name), ["Monitor", "Monitor 2", "Monitor 3"]);
  assert.equal(objs[1].yaw, 180, "a display faces the user by default");
  assert.equal(objs[0].yaw, 0);
  assert.equal(events.filter(([e, d]) => e === "scene" && d.op === "add").length, types.length);
  assert.throws(() => sb.add("nope"), /Unknown object type/);
  assert.deepEqual(sb.add("box", { position: [NaN, 0, 0] }).position.every(Number.isFinite), true, "a bad position is replaced, never NaN");
});

test("add with explicit position, yaw, params, colour and name; coordinates and heights are limited", () => {
  const { sb } = fixture();
  const o = sb.add("crate", { position: [1, 2, 3], yaw: 190, params: { width: 99, mass: 40 }, color: "#ff8800", name: "  Ammo  " });
  assert.deepEqual(o.position, [1, 2, 3]); assert.equal(o.yaw, -170); assert.equal(o.params.width, 1.5); assert.equal(o.params.mass, 40); assert.equal(o.color, "#ff8800"); assert.equal(o.name, "Ammo");
  assert.equal(sb.add("box", { position: [0, -5, 0] }).position[1], 0, "no object below the floor");
  assert.equal(sb.add("box", { position: [1e9, 0, -1e9] }).position[0], 1000, "coordinates are limited");
  assert.equal(sb.add("box", { name: "x".repeat(200) }).name.length, 60);
  assert.equal(sb.add("box", { color: "javascript:alert(1)" }).color, null);
});

test("remove, duplicate, update, rename, lock and hide", () => {
  const { sb, events } = fixture();
  const a = sb.add("crate", { position: [0, 0, 1], color: "#123456", params: { mass: 33 } });
  const b = sb.duplicate(a.id, { select: true });
  assert.notEqual(b.id, a.id); assert.equal(b.type, "crate"); assert.equal(b.params.mass, 33); assert.equal(b.color, "#123456"); assert.equal(b.name, "Crate 2");
  assert.notDeepEqual(b.position, a.position); assert.equal(sb.selected, b.id, "the copy is selected");
  b.params.mass = 1; assert.equal(a.params.mass, 33, "params are copied, not shared");
  assert.equal(sb.rename(a.id, "  Load A  "), true); assert.equal(a.name, "Load A"); assert.equal(sb.rename(a.id, "   "), false);
  assert.equal(sb.setLocked(a.id, true), true); assert.equal(a.locked, true);
  assert.equal(sb.setVisible(a.id, false), true); assert.equal(a.group.visible, false);
  assert.equal(sb.update(a.id, { name: "Z", color: "#ffffff", nonsense: 1 }), true); assert.equal(a.color, "#ffffff");
  assert.equal(sb.update(a.id, { color: "bad" }), false);
  assert.equal(sb.update("nope", { name: "x" }), false);
  assert.equal(sb.remove(b.id), true); assert.equal(sb.objects.has(b.id), false); assert.equal(sb.selected, null, "removing the selection clears it");
  assert.equal(sb.remove(b.id), false); assert.equal(sb.duplicate("nope"), null);
  assert.ok(events.some(([e, d]) => e === "scene" && d.op === "remove" && d.id === b.id));
  assert.equal(sb.root.children.length, 1, "the removed group left the scene graph");
});

test("setParam rebuilds the geometry, keeps the transform, clamps, and rejects unknown keys", () => {
  const { sb } = fixture();
  const o = sb.add("desk", { position: [1, 0, 2], yaw: 45 }), before = o.model;
  assert.equal(sb.setParam(o.id, "height", 1.0), true);
  assert.notEqual(o.model, before, "rebuilt"); assert.equal(o.params.height, 1.0); assert.deepEqual(o.position, [1, 0, 2]); assert.equal(o.yaw, 45);
  near(o.bbox.max.y, 1.0, 1e-6);
  assert.equal(sb.setParam(o.id, "height", 99), true); assert.equal(o.params.height, 1.3);
  assert.equal(sb.setParam(o.id, "height", 99), false, "no change, no rebuild");
  assert.equal(sb.setParam(o.id, "nope", 1), false); assert.equal(sb.setParam(o.id, "__proto__", 1), false); assert.equal(sb.setParam("zzz", "height", 1), false);
  assert.equal(sb.setParam(o.id, "drawers", true), true); assert.equal(o.params.drawers, true);
  assert.equal(sb.setParams(o.id, { width: 2, depth: 0.9 }), true); assert.equal(o.params.width, 2);
  assert.ok(!o.group.children.includes(before), "the old model left the group");
  let freed = 0; const m2 = o.model; m2.traverse((x) => x.geometry?.addEventListener("dispose", () => freed++));
  sb.setParam(o.id, "height", 0.8); assert.ok(freed > 0, "the replaced model's geometry is disposed");
});

test("floor constraint: nothing sinks below the floor unless a pit is allowed explicitly", () => {
  const { sb } = fixture();
  const o = sb.add("box", { position: [0, 1, 1] });
  sb.move(o.id, { y: -3 }); assert.equal(o.position[1], 0);
  sb.nudge(o.id, 0, 0, -1); assert.equal(o.position[1], 0);
  sb.update(o.id, { position: [0, -2, 1] }); assert.equal(o.position[1], 0);
  sb.setFloorLimit(-0.5); sb.move(o.id, { y: -3 }); assert.equal(o.position[1], -0.5, "an explicit pit is allowed, but limited");
  sb.setFloorLimit(5); assert.equal(sb.floorLimit, 0, "a positive limit is ignored");
  sb.setFloorLimit(-99); assert.equal(sb.floorLimit, -5);
  sb.setFloorLimit(0); sb.move(o.id, { y: 2 }); assert.equal(sb.dropToFloor(o.id), true); assert.equal(o.position[1], 0); assert.equal(sb.dropToFloor(o.id), false, "already there");
});

test("move, rotate and nudge: grid and angle snapping, arrays and partial objects, invalid input", () => {
  const { sb } = fixture();
  const o = sb.add("box", { position: [0, 0, 1] });
  sb.setSnap({ gridMm: 50 }); sb.move(o.id, [0.123, 0.0, 1.337]); assert.deepEqual(o.position, [0.1, 0, 1.35]);
  sb.move(o.id, { x: 0.126 }); assert.equal(o.position[0], 0.15); assert.equal(o.position[2], 1.35, "other components are kept");
  sb.move(o.id, { x: 0.126 }, { snap: false }); assert.equal(o.position[0], 0.126);
  assert.equal(sb.move(o.id, { x: NaN }), false); assert.equal(sb.move(o.id, { x: Infinity }), false); assert.equal(sb.move("nope", { x: 1 }), false);
  assert.equal(sb.setSnap({ gridMm: 7 }), false, "only the offered steps"); assert.equal(sb.setSnap({ angleDeg: 7 }), false); assert.equal(sb.snap.gridMm, 50);
  sb.setSnap({ angleDeg: 15 }); sb.rotate(o.id, 52); assert.equal(o.yaw, 45); sb.rotate(o.id, 53); assert.equal(o.yaw, 60); sb.rotate(o.id, 53, { snap: false }); assert.equal(o.yaw, 53);
  assert.equal(sb.rotate(o.id, NaN), false); sb.rotate(o.id, 400, { snap: false }); assert.equal(o.yaw, 40);
  sb.setSnap({ gridMm: 0, angleDeg: 0 }); sb.move(o.id, [0, 0, 1]); sb.nudge(o.id, 0.01, -0.02, 0.5); assert.deepEqual(o.position.map((v) => Math.round(v * 1e6) / 1e6), [0.01, 0.5, 0.98]);
  near(o.group.position.x, 0.01); near(o.group.rotation.y, 40 * Math.PI / 180);
  assert.equal(sb.snapValue(0.123), 0.123); sb.setSnap({ gridMm: 25 }); assert.equal(sb.snapValue(0.123), 0.125);
});

test("locked objects do not move, rotate, nudge, drop or respond to the arrow keys", () => {
  const { sb, toasts } = fixture();
  const o = sb.add("box", { position: [0, 1, 1] });
  sb.setLocked(o.id, true);
  const p = [...o.position];
  assert.equal(sb.move(o.id, { x: 5 }), false); assert.equal(sb.rotate(o.id, 30), false); assert.equal(sb.nudge(o.id, 1, 1, 1), false); assert.equal(sb.dropToFloor(o.id), false); assert.equal(sb.dropToSurface(o.id), false);
  assert.equal(sb.update(o.id, { position: [3, 3, 3], yaw: 90 }), false);
  assert.deepEqual(o.position, p); assert.equal(o.yaw, 0);
  assert.equal(sb.move(o.id, { x: 5 }, { force: true }), true, "force moves it");
  sb.select(o.id); assert.equal(sb.onKey(key("ArrowLeft")), true); assert.ok(toasts.some((t) => /locked/.test(t)));
  assert.equal(sb.onKey(key("Delete")), true); assert.equal(sb.objects.has(o.id), true, "Delete keeps a locked object");
  assert.equal(sb.setParam(o.id, "width", 1), true, "parameters stay editable");
});

test("undo and redo: add, move, parameter, remove; new work clears redo; labels; coalescing", () => {
  const { sb, events } = fixture();
  assert.equal(sb.canUndo, false); assert.equal(sb.undo(), false); assert.equal(sb.redo(), false);
  const a = sb.add("box", { position: [0, 0, 1] });
  sb.move(a.id, { x: 1 }); sb.move(a.id, { x: 2 }); sb.move(a.id, { x: 3 }); // one coalesced step
  sb.setParam(a.id, "width", 1); sb.setParam(a.id, "width", 1.2); sb.setParam(a.id, "width", 1.4);
  const b = sb.add("crate", { position: [3, 0, 3] });
  sb.remove(a.id);
  assert.equal(sb.objects.size, 1); assert.equal(sb.canUndo, true);
  assert.equal(sb.undoLabel, "Delete Box");
  sb.undo(); assert.equal(sb.objects.size, 2); const a2 = sb.objects.get(a.id); assert.ok(a2, "same id comes back"); assert.equal(a2.params.width, 1.4); assert.equal(a2.position[0], 3);
  sb.undo(); assert.equal(sb.objects.size, 1); assert.equal(sb.objects.has(b.id), false);
  sb.undo(); assert.equal(sb.objects.get(a.id).params.width, 0.5, "the three width edits were one step");
  sb.undo(); assert.equal(sb.objects.get(a.id).position[0], 0, "the three moves were one step");
  sb.undo(); assert.equal(sb.objects.size, 0);
  assert.equal(sb.canUndo, false); assert.equal(sb.canRedo, true);
  sb.redo(); sb.redo(); sb.redo(); sb.redo(); sb.redo();
  assert.equal(sb.objects.size, 1); assert.equal(sb.objects.get(a.id), undefined); assert.ok(sb.objects.get(b.id));
  assert.equal(sb.canRedo, false);
  sb.undo(); assert.equal(sb.canRedo, true);
  sb.add("cylinder"); assert.equal(sb.canRedo, false, "a new edit clears the redo stack");
  assert.ok(events.some(([e, d]) => e === "scene" && d.op === "restore"));
  assert.equal(sb.objects.size, 3);
});

test("undo restores colour, lock, visibility, names and attachments, and rebuilds only what changed", () => {
  const { sb } = fixture();
  const o = sb.add("crate", { position: [0, 0, 1] });
  sb.update(o.id, { color: "#00ff00", name: "Green", locked: true, visible: false });
  assert.equal(o.color, "#00ff00");
  sb.undo(); const o2 = sb.objects.get(o.id);
  assert.equal(o2.color, null); assert.equal(o2.name, "Crate"); assert.equal(o2.locked, false); assert.equal(o2.visible, true); assert.equal(o2.group.visible, true);
  sb.redo(); assert.equal(sb.objects.get(o.id).color, "#00ff00"); assert.equal(sb.objects.get(o.id).locked, true);
  sb.undo();
  const m = sb.objects.get(o.id).model; sb.move(o.id, { x: 2 }); sb.undo(); assert.equal(sb.objects.get(o.id).model, m, "a move does not rebuild the geometry");
});

test("groups: a whole drag is one undo step, nested groups close at the outermost end, undo inside a group closes it", () => {
  const { sb } = fixture();
  const a = sb.add("box", { position: [0, 0, 1] });
  sb.beginGroup("Drag"); for (let i = 1; i <= 10; i++) sb.move(a.id, { x: i * 0.1 }); sb.beginGroup("inner"); sb.move(a.id, { z: 2 }); sb.endGroup(); assert.equal(sb.canUndo, true);
  const depth = sb.endGroup(); assert.equal(depth, true, "committed at the outermost end");
  assert.equal(sb.undoLabel, "Drag");
  sb.undo(); assert.deepEqual(sb.objects.get(a.id).position, [0, 0, 1]);
  assert.equal(sb.endGroup(), false, "closing a group that is not open is harmless");
  sb.beginGroup("empty"); assert.equal(sb.endGroup(), false, "an empty group records nothing");
  sb.beginGroup("x"); sb.move(a.id, { x: 5 }); sb.undo(); assert.equal(sb.objects.get(a.id).position[0], 5 - 5 + 0, "undo closes the open group, then steps back");
});

test("history is bounded", () => {
  const { sb } = fixture();
  const a = sb.add("box", { position: [0, 0, 1] });
  for (let i = 0; i < MAX_HISTORY + 50; i++) sb.rename(a.id, `n${i}`);
  let steps = 0; while (sb.undo()) steps++;
  assert.ok(steps <= MAX_HISTORY, `${steps} steps`); assert.ok(steps >= MAX_HISTORY - 2);
});

// ============================================================================================================================ selection, picking, drag, keyboard, gizmo
test("selection goes through ctx.select and comes back from the shell's selection event", () => {
  const { sb, store } = fixture();
  const a = sb.add("box", { position: [0, 0, 1] }), b = sb.add("box", { position: [1, 0, 1] });
  sb.select(a.id); assert.deepEqual(store.state.selection, { kind: "object", id: a.id }); assert.equal(sb.selected, a.id);
  assert.ok(a.group.children.some((c) => c.name === "selection"), "outline shown");
  assert.equal(sb.select("nope"), false); assert.equal(sb.selected, a.id);
  store.select({ kind: "object", id: b.id }); assert.equal(sb.selected, b.id, "follows a selection made elsewhere");
  assert.ok(!a.group.children.some((c) => c.name === "selection") && b.group.children.some((c) => c.name === "selection"));
  store.select({ kind: "joint", id: "elbow_L" }); assert.equal(sb.selected, null, "another kind of selection clears it");
  assert.ok(!b.group.children.some((c) => c.name === "selection"));
  store.select({ kind: "object", id: "ghost" }); assert.equal(sb.selected, null, "an unknown id selects nothing");
  sb.select(a.id); sb.select(null); assert.equal(store.state.selection, null); sb.remove(a.id);
  sb.select(b.id); sb.remove(b.id); assert.equal(store.state.selection, null);
});

test("picking: a click selects the nearest visible object, hidden and missing ones are ignored, joints win", () => {
  const { sb, vp, store } = fixture();
  const near1 = sb.add("box", { position: [0, 0, 1.5], params: { width: 0.6, depth: 0.6, height: 1 } });
  const far = sb.add("box", { position: [0, 0, 0.5], params: { width: 0.6, depth: 0.6, height: 1 } });
  const target = new THREE.Vector3(0, 0.5, 1.5);
  const ev = () => ({ ...vp.toClient(target), handled: false });
  const click = vp.emit("click", ev()); assert.equal(sb.selected, near1.id, "the nearer of two objects on the ray"); assert.equal(click.handled, true);
  sb.setVisible(near1.id, false); sb.select(null); vp.emit("click", ev()); assert.equal(sb.selected, far.id, "a hidden object is not pickable: the one behind it is");
  sb.setVisible(far.id, false); sb.select(null); const c2 = vp.emit("click", ev()); assert.equal(sb.selected, null); assert.equal(c2.handled, false, "nothing hit: the click is left to the shell");
  sb.setVisible(near1.id, true); const c3 = vp.emit("click", { ...ev(), handled: true }); assert.equal(sb.selected, null, "a click the shell already used (a joint marker) is not ours");
  sb.setInteraction({ pick: false }); vp.emit("click", ev()); assert.equal(sb.selected, null, "picking can be switched off");
  sb.setInteraction({ pick: true }); const resume = sb.suspendInput(); vp.emit("click", ev()); assert.equal(sb.selected, null, "suspended by a measuring tool"); resume();
  vp.emit("click", ev()); assert.equal(sb.selected, near1.id);
  assert.equal(store.state.selection.id, near1.id);
  assert.equal(sb.pickAt(5, 5), null);
});

test("dragging on the floor: orbit is suspended, the object follows the pointer, grid snapping applies, one undo step, locked objects are left to the camera", () => {
  const { sb, vp } = fixture();
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.5, depth: 0.5, height: 0.5 } });
  const grab = new THREE.Vector3(0.1, 0.25, 1.1);
  vp.emit("pointerdown", ptr(vp, grab));
  assert.equal(vp.controls.enabled, false, "the orbit controls are off while the object is held");
  const to = new THREE.Vector3(0.6, 0.0, 1.9);
  vp.emit("pointermove", ptr(vp, new THREE.Vector3(0.11, 0.25, 1.1)));
  assert.deepEqual(o.position, [0, 0, 1], "below the 4 px threshold nothing moves");
  sb.setSnap({ gridMm: 100 });
  vp.emit("pointermove", ptr(vp, to));
  assert.ok(sb.dragging); assert.ok(o.position[0] > 0.3 && o.position[2] > 1.5, `moved to ${o.position}`);
  for (const c of [o.position[0], o.position[2]]) near(Math.round(c * 10) / 10, c, 1e-9, "snapped to 100 mm");
  assert.equal(o.position[1], 0, "stays on the floor");
  assert.equal(sb.selected, o.id, "dragging selects");
  vp.emit("pointermove", ptr(vp, new THREE.Vector3(1.0, 0, 1.9), { alt: true })); const x = o.position[0]; assert.ok(x > 0.5);
  vp.emit("pointerup", ptr(vp, to)); assert.equal(vp.controls.enabled, true); assert.equal(sb.dragging, false);
  sb.undo(); assert.deepEqual(o.position, [0, 0, 1], "the whole drag is one undo step");
  sb.setSnap({ gridMm: 0 }); sb.setLocked(o.id, true);
  vp.emit("pointerdown", ptr(vp, grab)); assert.equal(vp.controls.enabled, true, "a locked object does not capture the press");
  vp.emit("pointermove", ptr(vp, to)); vp.emit("pointerup", ptr(vp, to)); assert.deepEqual(o.position, [0, 0, 1]);
  sb.setLocked(o.id, false);
  vp.emit("pointerdown", ptr(vp, new THREE.Vector3(3, 0, 5))); assert.equal(vp.controls.enabled, true, "an empty spot orbits the camera");
  vp.emit("pointerdown", ptr(vp, grab, { originalEvent: { isPrimary: false } })); assert.equal(vp.controls.enabled, true, "a second finger is a pinch, not a drag");
  vp.emit("pointerdown", ptr(vp, grab, { button: 2 })); assert.equal(vp.controls.enabled, true, "only the primary button drags");
  sb.setInteraction({ drag: false }); vp.emit("pointerdown", ptr(vp, grab)); assert.equal(vp.controls.enabled, true, "dragging can be switched off");
});

test("dragging with Shift moves vertically and a press on a gizmo handle is left to the gizmo", () => {
  const { sb, vp } = fixture();
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.5, depth: 0.5, height: 0.5 } });
  const grab = new THREE.Vector3(0, 0.25, 1.25);
  vp.emit("pointerdown", ptr(vp, grab, { shift: true }));
  vp.emit("pointermove", ptr(vp, grab.clone().add(new THREE.Vector3(0, 0.5, 0)), { shift: true }));
  assert.ok(o.position[1] > 0.3, `lifted to ${o.position[1]}`); near(o.position[0], 0, 1e-6); near(o.position[2], 1, 1e-6);
  vp.emit("pointermove", ptr(vp, grab.clone().add(new THREE.Vector3(0, -2, 0)), { shift: true })); assert.equal(o.position[1], 0, "not below the floor");
  vp.emit("pointerup", ptr(vp, grab));
  vp.emit("pointerdown", ptr(vp, grab)); vp.emit("pointermove", ptr(vp, grab.clone().add(new THREE.Vector3(0.3, 0, 0)), { shift: false }));
  vp.emit("pointermove", ptr(vp, grab.clone().add(new THREE.Vector3(0.3, 0.4, 0)), { shift: true }));
  assert.ok(Math.abs(o.position[0] - 0.3) < 0.15, "switching to vertical mid-drag does not make the object jump sideways");
  vp.emit("pointerup", ptr(vp, grab));
  sb.select(o.id); vp.gizmo.axis = "X"; const before = [...o.position]; vp.emit("pointerdown", ptr(vp, grab)); assert.equal(vp.controls.enabled, true); vp.emit("pointermove", ptr(vp, grab.clone().add(new THREE.Vector3(1, 0, 0)))); assert.deepEqual(o.position, before);
});

test("keyboard: arrows nudge through the camera, Shift x10, Alt x0.1, Delete, Ctrl+D, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, W E R, brackets; typing and unselected states are ignored", () => {
  const { sb, vp } = fixture();
  const o = sb.add("box", { position: [0, 0, 1] });
  assert.equal(sb.onKey(key("ArrowUp")), false, "nothing selected: the camera keeps the arrow keys");
  sb.select(o.id);
  const p = () => o.position.map((v) => Math.round(v * 1e4) / 1e4);
  assert.equal(sb.onKey(key("ArrowUp")), true); assert.deepEqual(p(), [0, 0, 0.99], "Up moves away from the camera (-Z), 10 mm");
  sb.onKey(key("ArrowRight")); assert.deepEqual(p(), [0.01, 0, 0.99]);
  sb.onKey(key("ArrowDown", { shiftKey: true })); assert.deepEqual(p(), [0.01, 0, 1.09], "Shift = 100 mm");
  sb.onKey(key("ArrowLeft", { altKey: true })); assert.deepEqual(p(), [0.009, 0, 1.09], "Alt = 1 mm");
  sb.setSnap({ gridMm: 50 }); sb.onKey(key("ArrowRight")); near(o.position[0], 0.059, 1e-9, "the grid step is the arrow step when snapping is on"); sb.setSnap({ gridMm: 0 });
  assert.equal(sb.onKey(key("x")), false); assert.equal(sb.onKey(key("ArrowUp", { ctrlKey: true })), false);
  assert.equal(sb.onKey(key("ArrowUp", { target: { tagName: "INPUT" } })), false, "typing in a field");
  assert.equal(sb.onKey(key("ArrowUp", { defaultPrevented: true })), false);
  sb.onKey(key("]")); assert.equal(o.yaw, 5); sb.onKey(key("[", { shiftKey: true })); assert.equal(o.yaw, -10);
  assert.equal(sb.gizmoMode, "translate"); sb.onKey(key("e")); assert.equal(sb.gizmoMode, "rotate"); assert.equal(vp.gizmo.mode, "rotate"); assert.equal(vp.gizmo.showX, false); sb.onKey(key("r")); assert.equal(sb.gizmoMode, "scale"); sb.onKey(key("W")); assert.equal(sb.gizmoMode, "translate"); assert.equal(vp.gizmo.showX, true);
  const n = sb.objects.size; assert.equal(sb.onKey(key("d", { ctrlKey: true })), true); assert.equal(sb.objects.size, n + 1); assert.notEqual(sb.selected, o.id, "the copy is selected");
  sb.onKey(key("z", { ctrlKey: true })); assert.equal(sb.objects.size, n); sb.onKey(key("Z", { metaKey: true, shiftKey: true })); assert.equal(sb.objects.size, n + 1); sb.onKey(key("z", { ctrlKey: true })); sb.onKey(key("y", { ctrlKey: true })); assert.equal(sb.objects.size, n + 1);
  sb.select(o.id); sb.onKey(key("Delete")); assert.equal(sb.objects.has(o.id), false); sb.select(sb.objects.keys().next().value); sb.onKey(key("Backspace")); assert.equal(sb.objects.size, 0);
  sb.onKey(key("z", { ctrlKey: true }));  assert.equal(sb.objects.size, 1, "undo works without a selection");
  const e = key("ArrowUp"); sb.select([...sb.objects.keys()][0]);
  vp.container.dispatchEvent(e); assert.equal(e.defaultPrevented, true, "the container's capture listener consumes the arrow key (OrbitControls would pan otherwise)");
  const e2 = key("q"); vp.container.dispatchEvent(e2); assert.equal(e2.defaultPrevented, false);
  sb.setInteraction({ pick: true }); const resume = sb.suspendInput(); assert.equal(sb.onKey(key("ArrowUp")), false); resume();
  sb.setInteraction({ drag: false }); assert.equal(sb.onKey(key("ArrowUp")), false, "outside the Scene panel the keys are not ours"); assert.equal(sb.onKey(key("Delete")), false); assert.equal(sb.onKey(key("z", { ctrlKey: true })), false);
  const e3 = key("ArrowUp"); vp.container.dispatchEvent(e3); assert.equal(e3.defaultPrevented, false, "and the camera keeps its arrow keys");
  sb.setInteraction({ drag: true }); assert.equal(sb.onKey(key("ArrowUp")), true);
});

test("gizmo: attached to the selected object in the current mode, snaps follow the settings, a drag is one undo step, floor and scale handling", () => {
  const { sb, vp } = fixture();
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.5, depth: 0.4, height: 0.3 } }), crate = sb.add("crate", { position: [2, 0, 2] });
  assert.equal(vp.gizmo, null, "nothing selected, no gizmo");
  sb.select(o.id); assert.equal(vp.gizmo.object, o.group); assert.equal(vp.gizmo.mode, "translate");
  sb.setSnap({ gridMm: 25, angleDeg: 15 }); assert.deepEqual(vp.gizmo.snap, { translate: 0.025, rotate: 15, scale: null });
  sb.setSnap({ gridMm: 0, angleDeg: 0 }); assert.deepEqual(vp.gizmo.snap, { translate: null, rotate: null, scale: null });
  vp.gizmo.mode = "translate"; vp.emit("gizmo-start", {}); o.group.position.set(1, -1, 3); vp.emit("gizmo-change", {});
  assert.deepEqual(o.position, [1, 0, 3], "the gizmo cannot sink it below the floor"); near(o.group.position.y, 0);
  o.group.position.set(1.5, 0.2, 3.5); vp.emit("gizmo-change", {}); vp.emit("gizmo-end", {});
  assert.deepEqual(o.position, [1.5, 0.2, 3.5]);
  sb.undo(); assert.deepEqual(o.position, [0, 0, 1], "one step for the whole gizmo drag");
  sb.redo(); sb.setGizmoMode("rotate"); vp.gizmo.mode = "rotate";
  vp.emit("gizmo-start", {}); o.group.rotation.set(0, 2.2, 0); vp.emit("gizmo-change", {}); vp.emit("gizmo-end", {}); near(o.yaw, 2.2 * 180 / Math.PI, 1e-6);
  o.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -2.9); vp.emit("gizmo-start", {}); vp.emit("gizmo-change", {}); vp.emit("gizmo-end", {}); near(o.yaw, -2.9 * 180 / Math.PI, 1e-6, "no flip at +-90 degrees");
  sb.setGizmoMode("scale"); vp.gizmo.mode = "scale"; assert.equal(vp.gizmo.mode, "scale");
  vp.emit("gizmo-start", {}); o.group.scale.set(2, 1.5, 0.5); vp.emit("gizmo-change", {});
  near(o.params.width, 1.0); near(o.params.height, 0.45); near(o.params.depth, 0.2); near(o.group.scale.x, 1, 1e-12, "the scale is folded into the parameters");
  o.group.scale.set(40, 1, 1); vp.emit("gizmo-change", {}); assert.equal(o.params.width, 10, "clamped to the parameter range"); vp.emit("gizmo-end", {});
  sb.select(crate.id); assert.equal(vp.gizmo.mode, "scale"); // crate has a scaleMap too
  const desk = sb.add("desk", { position: [0, 0, 4] }); sb.select(desk.id); assert.equal(vp.gizmo.mode, "translate", "types without resizable size fall back to translate");
  sb.setGizmoMode("none"); assert.equal(vp.gizmo, null); assert.equal(sb.setGizmoMode("bogus"), false); sb.setGizmoMode("translate"); assert.ok(vp.gizmo);
  sb.setLocked(desk.id, true); assert.equal(vp.gizmo, null, "no gizmo on a locked object"); sb.setLocked(desk.id, false); assert.ok(vp.gizmo);
  sb.select(null); assert.equal(vp.gizmo, null);
  const cyl = sb.add("cylinder", { params: { diameter: 0.4, height: 0.6 } }); sb.select(cyl.id); sb.setGizmoMode("scale"); vp.gizmo.mode = "scale";
  vp.emit("gizmo-start", {}); cyl.group.scale.set(1.5, 1, 1.2); vp.emit("gizmo-change", {}); near(cyl.params.diameter, 0.6, 1e-9, "a diameter takes the larger change of x and z"); vp.emit("gizmo-end", {});
});

// ============================================================================================================================ serialisation
const sample = (sb) => {
  sb.add("cabin_seat", { position: [0.3, 0, 0.6], yaw: 20, params: { recline: 112, armrests: true }, color: "#336699", name: "Pilot seat" });
  sb.add("monitor", { position: [0, 0.74, 1.8], yaw: 180, params: { diagonal: 27, aspect: "21:9" } });
  const k = sb.add("crate", { position: [-1, 0, 2], params: { mass: 12.5 } }); sb.setLocked(k.id, true);
  const h = sb.add("box", { position: [1, 0, 2] }); sb.setVisible(h.id, false);
};

test("scene JSON: round trip keeps every field, ids, names, locks and visibility; the file is plain data with a version", () => {
  const a = fixture(); sample(a.sb);
  const j = a.sb.toJSON();
  assert.equal(j.app, "digital-human-scene"); assert.equal(j.version, SCENE_VERSION); assert.equal(j.objects.length, 4);
  const text = JSON.stringify(j); assert.ok(text.length < 5000);
  const b = fixture(); const r = b.sb.fromJSON(text);
  assert.equal(r.ok, true); assert.equal(r.added, 4); assert.deepEqual(r.warnings, []);
  assert.deepEqual(b.sb.toJSON(), j, "identical after a round trip");
  assert.deepEqual(ids(b.sb), ids(a.sb));
  const seat = [...b.sb.objects.values()][0]; assert.equal(seat.name, "Pilot seat"); assert.equal(seat.params.recline, 112); assert.equal(seat.color, "#336699"); assert.equal(seat.yaw, 20);
  assert.equal([...b.sb.objects.values()][2].locked, true); assert.equal([...b.sb.objects.values()][3].visible, false); assert.equal([...b.sb.objects.values()][3].group.visible, false);
  const n = b.sb.add("box"); assert.ok(!ids(a.sb).includes(n.id), "new ids never collide with loaded ones");
  assert.equal(b.sb.undo(), true); assert.equal(b.sb.objects.size, 4); b.sb.undo(); assert.equal(b.sb.objects.size, 0, "loading is one undo step");
});

test("scene JSON: merge keeps the current objects, replaces ids that collide, and respects the limit", () => {
  const a = fixture(); sample(a.sb);
  const j = a.sb.toJSON(), b = fixture(); b.sb.fromJSON(j);
  const r = b.sb.fromJSON(j, { merge: true }); assert.equal(r.ok, true); assert.equal(b.sb.objects.size, 8); assert.equal(new Set(ids(b.sb)).size, 8, "colliding ids were renamed");
  const full = fixture(); for (let i = 0; i < MAX_OBJECTS - 2; i++) full.sb.add("box", { position: [i * 0.1, 0, 5] });
  const r2 = full.sb.fromJSON(j, { merge: true }); assert.equal(full.sb.objects.size, MAX_OBJECTS); assert.ok(r2.warnings.some((w) => /limited to 200/.test(w)));
});

test("scene JSON: hostile input is rejected or cleaned and never pollutes prototypes", () => {
  const f = fixture(); f.sb.add("box");
  const bad = (x) => { const r = f.sb.fromJSON(x); assert.equal(r.ok, false, JSON.stringify(x)?.slice(0, 80)); assert.ok(r.errors.length >= 1); assert.equal(f.sb.objects.size, 1, "a rejected file changes nothing"); return r; };
  bad(null); bad(5); bad("nope"); bad("[]"); bad([]); bad({}); bad({ version: 1 }); bad({ version: 1, objects: {} }); bad({ version: 1, objects: "x" });
  assert.match(bad({ version: 2, objects: [] }).errors[0], /newer/); assert.match(bad({ version: 99, objects: [] }).errors[0], /newer/);
  bad({ version: 0, objects: [] }); bad({ version: -1, objects: [] }); bad({ version: "1", objects: [] }); bad({ version: 1.5, objects: [] }); bad({ version: NaN, objects: [] }); bad({ version: null, objects: [] });
  bad('{"version": 1, "objects": [}'); bad("x".repeat(MAX_TEXT + 1));
  // pollution attempts
  const evil = '{"version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"objects":[{"type":"box","__proto__":{"polluted3":true},"params":{"__proto__":{"polluted4":true},"constructor":"x","width":0.7,"prototype":1},"position":[0,0,1]}]}';
  const r = f.sb.fromJSON(evil); assert.equal(r.ok, true); assert.equal(({}).polluted, undefined); assert.equal(({}).polluted2, undefined); assert.equal(({}).polluted3, undefined); assert.equal(({}).polluted4, undefined);
  const added = [...f.sb.objects.values()].at(-1); assert.deepEqual(Object.keys(added.params).sort(), ["depth", "height", "width"]); assert.equal(added.params.width, 0.7);
  assert.equal(Object.getPrototypeOf(added.params), Object.prototype);
  // types that are not catalogue entries
  const r2 = f.sb.fromJSON({ version: 1, objects: [{ type: "__proto__" }, { type: "constructor" }, { type: "toString" }, { type: 5 }, { type: null }, {}, null, 7, "x", [], { type: "BOX" }, { type: "box" }] });
  assert.equal(r2.ok, true); assert.equal(r2.added, 1); assert.equal(r2.warnings.filter((w) => /skipped/.test(w)).length, 11); assert.equal(r2.skipped, 11);
  assert.ok(r2.warnings.every((w) => !/\n/.test(w)) && r2.warnings.some((w) => /unknown type "__proto__"/.test(w)));
  const r3 = f.sb.fromJSON({ version: 1, objects: [{ type: `bad\u0007‮type${"y".repeat(300)}` }] }); assert.ok(r3.warnings[0].length < 120 && !/[\u0007‮]/.test(r3.warnings[0]), "unknown type names are shown safely");
  // huge arrays
  const many = { version: 1, objects: Array.from({ length: 5000 }, (_, i) => ({ type: "box", position: [i * 0.01, 0, 1] })) };
  const r4 = f.sb.fromJSON(many); assert.equal(r4.added, MAX_OBJECTS); assert.ok(r4.warnings.some((w) => /only the first 200/.test(w))); assert.equal(f.sb.objects.size, MAX_OBJECTS);
  // numbers
  const r5 = f.sb.fromJSON({ version: 1, objects: [{ type: "monitor", params: { diagonal: 1e308, tilt: -1e308, centreHeight: "NaN", aspect: { x: 1 } }, position: [1e300, -1e300, 5], yaw: 1e30, id: "o9;drop", name: "\u0000\n<b>x</b>", color: "#12" },
    { type: "box", position: [NaN, 0, 0] }, { type: "box", position: [0, 0] }, { type: "box", position: "1,2,3" }, { type: "box", yaw: Infinity, locked: "yes", visible: 0 }] });
  assert.equal(r5.ok, true); const [m, b1, b2, b3, b4] = [...f.sb.objects.values()];
  assert.equal(m.params.diagonal, 49); assert.equal(m.params.tilt, -5); assert.equal(m.params.centreHeight, 1.15); assert.equal(m.params.aspect, "16:9");
  assert.deepEqual(m.position, [1000, 0, 5]); assert.ok(Number.isFinite(m.yaw)); assert.notEqual(m.id, "o9;drop"); assert.ok(!/[\u0000\n]/.test(m.name)); assert.equal(m.color, null);
  for (const o of [b1, b2, b3]) assert.deepEqual(o.position, [0, 0, 0]); assert.equal(b4.yaw, 0); assert.equal(b4.locked, false); assert.equal(b4.visible, true);
  assert.ok(r5.warnings.some((w) => /no valid position/.test(w)) && r5.warnings.some((w) => /out of range/.test(w)));
  for (const o of f.sb.objects.values()) assert.ok([...o.position, o.yaw].every(Number.isFinite));
  // attachments
  assert.deepEqual(cleanAttachment({ kind: "landmark", id: "palm_centre_L", offset: [0.1, 0, 99] }).value, { kind: "landmark", id: "palm_centre_L", offset: [0.1, 0, 5], local: false, orient: false });
  for (const a of [{ kind: "x", id: "a" }, { kind: "joint" }, { kind: "joint", id: "../../etc" }, { kind: "joint", id: {} }, "str", [], 5]) assert.equal(cleanAttachment(a).value, null);
  assert.equal(cleanAttachment(null).value, null); assert.equal(cleanAttachment(undefined).warning, undefined);
  assert.deepEqual(cleanAttachment({ kind: "joint", id: "wrist_R", offset: "bad" }).value.offset, [0, 0, 0]);
  // duplicate and invalid ids
  const r6 = f.sb.fromJSON({ version: 1, objects: [{ type: "box", id: "a1" }, { type: "box", id: "a1" }, { type: "box", id: "" }, { type: "box", id: 5 }, { type: "box", id: "x".repeat(100) }] });
  assert.equal(new Set(ids(f.sb)).size, 5); assert.equal(r6.ok, true);
});

test("parseSceneText and validateScene never throw", () => {
  for (const x of [undefined, null, 5, {}, [], "", "{", "null", "[1,2]", '{"version":1,"objects":[{"type":"box","params":null,"position":null,"attachedTo":5}]}']) {
    assert.doesNotThrow(() => parseSceneText(x)); assert.doesNotThrow(() => validateScene(x));
  }
  const ok = parseSceneText('{"version":1,"objects":[{"type":"box","params":null,"position":null,"attachedTo":5}]}'); assert.equal(ok.ok, true); assert.equal(ok.objects.length, 1); assert.ok(ok.warnings.length >= 1);
  const v = validateScene({ version: 1, objects: [], measurements: [1], human: { x: 1 }, snap: { gridMm: 5 }, other: 1 }); assert.deepEqual(Object.keys(v.extras).sort(), ["human", "measurements", "snap"]);
});

test("scene file sections of other modules are saved and restored through registerSerializer", () => {
  const f = fixture(); sample(f.sb);
  let saved = null; const off = f.sb.registerSerializer("measurements", { toJSON: () => [{ id: "m1" }], fromJSON: (v, o) => { saved = { v, o }; } });
  f.sb.registerSerializer("human", { toJSON: () => undefined, fromJSON() { throw new Error("boom"); } });
  const file = f.sb.toSceneFile(); assert.deepEqual(file.measurements, [{ id: "m1" }]); assert.ok(!("human" in file), "a section that returns undefined is left out");
  assert.throws(() => f.sb.registerSerializer("objects", {}), /unknown section/);
  const r = f.sb.fromJSON({ ...file, human: { x: 1 } }); assert.equal(r.ok, true); assert.deepEqual(saved, { v: [{ id: "m1" }], o: { merge: false } }); assert.ok(r.warnings.some((w) => /"human" section/.test(w)), "a section that cannot be read is reported, the rest loads");
  off(); saved = null; f.sb.fromJSON(file); assert.equal(saved, null);
});

// ============================================================================================================================ templates
test("templates: every template builds valid objects above the floor, in front of the figure, as one undo step", () => {
  assert.deepEqual(TEMPLATES.map((t) => t.name), ["Empty", "Office workstation", "UAV ground control station", "Operations room watch station", "Ship bridge console (standing)", "Vehicle cab", "Cockpit, fast jet",
    "Helicopter cockpit", "Equipment rack, standing", "Floor-level unit, kneeling", "Deck enclosure, gull-wing doors", "Junction box, lid lifted", "Lifting task", "Rifle range bench", "Stairs and ladder"]);
  for (const t of TEMPLATES) assert.ok(TEMPLATE_GROUPS.includes(t.group), `${t.id} group`);
  const f = fixture(); f.sb.add("box");
  for (const t of TEMPLATES) {
    assert.equal(f.sb.applyTemplate(t.id), true, t.id);
    assert.equal(f.sb.objects.size, t.objects.length, t.id);
    for (const o of f.sb.objects.values()) {
      assert.ok(byType(o.type), `${t.id}: ${o.type}`); assert.ok(o.position[1] >= 0 && o.position.every(Number.isFinite), `${t.id}: ${o.name} ${o.position}`);
      if (!["floor_tile", "wrench", "screwdriver", "toolbox"].includes(o.type)) assert.ok(o.position[2] > 0.3, `${t.id}: ${o.name} is in front of the figure`); // a mat or tools at the maintainer's feet
      const b = o.bbox; assert.ok(Number.isFinite(b.min.x + b.max.z));
    }
  }
  assert.equal(f.sb.applyTemplate("nope"), false);
  f.sb.applyTemplate("office"); const types = [...f.sb.objects.values()].map((o) => o.type).sort(); assert.deepEqual(types, ["desk", "keyboard_mouse", "monitor", "office_chair"]);
  f.sb.applyTemplate("cab"); assert.deepEqual([...f.sb.objects.values()].map((o) => o.type).sort(), ["cabin_seat", "instrument_panel", "pedals", "steering_wheel"]);
  f.sb.applyTemplate("cockpit"); assert.equal(f.sb.objects.size, 8); assert.ok([...f.sb.objects.values()].some((o) => o.type === "cabin_shell")); assert.ok([...f.sb.objects.values()].some((o) => o.type === "hud_panel") && [...f.sb.objects.values()].some((o) => o.type === "triple_monitor"));
  f.sb.applyTemplate("lifting"); assert.deepEqual([...f.sb.objects.values()].map((o) => o.type).sort(), ["crate", "pallet", "shelving"]);
  f.sb.applyTemplate("stairs"); f.sb.undo(); assert.deepEqual([...f.sb.objects.values()].map((o) => o.type).sort(), ["crate", "pallet", "shelving"], "one step back from a template is the scene before it");
  f.sb.applyTemplate("empty"); assert.equal(f.sb.objects.size, 0);
  f.sb.applyTemplate("office", { merge: true }); f.sb.applyTemplate("lifting", { merge: true }); assert.equal(f.sb.objects.size, 7);
  // the templates sit on their furniture: the monitor and keyboard rest on the desk top, the crate on the pallet
  f.sb.applyTemplate("office"); const desk = [...f.sb.objects.values()].find((o) => o.type === "desk"); for (const o of f.sb.objects.values()) if (o.type === "monitor" || o.type === "keyboard_mouse") near(o.position[1], desk.params.height, 1e-9);
  f.sb.applyTemplate("lifting"); near([...f.sb.objects.values()].find((o) => o.type === "crate").position[1], 0.144);
});

// ============================================================================================================================ world hooks
test("anchorWorld / anchorNormalWorld / supportsWorld / gripsWorld follow position and rotation", () => {
  const f = fixture(), { sb } = f;
  const seat = sb.add("cabin_seat", { position: [1, 0, 2], yaw: 90, params: { seatHeight: 0.4, panDepth: 0.45, panAngle: 0 } });
  const srp = sb.anchorWorld(seat.id, "srp"); vnear(srp, [1, 0.4, 2]);
  const front = sb.anchorWorld(seat.id, "cushion_front_edge"); vnear(front, [1 + 0.45, 0.4, 2], 1e-5); // yaw 90: the seat's +Z (forward) points along world +X
  const out = new THREE.Vector3(); assert.equal(sb.anchorWorld(seat.id, "srp", out), out, "fills `out`");
  assert.equal(sb.anchorWorld(seat.id, "nope"), null); assert.equal(sb.anchorWorld("ghost", "srp"), null); assert.equal(sb.anchorWorld(seat.id, "__proto__"), null); assert.equal(sb.anchorWorld(seat.id, "constructor"), null);
  const mon = sb.add("monitor", { position: [0, 0, 3], yaw: 180, params: { tilt: 0, centreHeight: 1.2 } });
  vnear(sb.anchorWorld(mon.id, "screen_centre"), [0, 1.2, 3]); vnear(sb.anchorNormalWorld(mon.id, "screen_centre"), [0, 0, -1], 1e-9);
  assert.equal(sb.anchorNormalWorld(mon.id, "base_centre"), null, "an anchor without a normal"); assert.equal(sb.anchorNormalWorld("ghost", "x"), null);
  const left = sb.anchorWorld(mon.id, "left_edge"), right = sb.anchorWorld(mon.id, "right_edge"); assert.ok(left.x > right.x, "rotated by 180 degrees the viewer's left edge is on +X in the world: the figure's left");
  const all = sb.anchorsWorld(mon.id); assert.ok(all.screen_centre.position instanceof THREE.Vector3 && all.screen_centre.normal && all.screen_centre.label); assert.deepEqual(sb.anchorsWorld("ghost"), {});
  vnear(sb.localToWorld(seat.id, [0, 0.4, 0.45]), [1.45, 0.4, 2], 1e-5); vnear(sb.worldToLocal(seat.id, new THREE.Vector3(1.45, 0.4, 2)), [0, 0.4, 0.45], 1e-5); assert.equal(sb.localToWorld("ghost", [0, 0, 0]), null);
  // supports
  const sup = sb.supportsWorld(), pan = sup.find((s) => s.objectId === seat.id);
  near(pan.y, 0.4); assert.equal(pan.polygon.length, 4); assert.match(pan.name, /Cabin seat: Seat pan/);
  const xs = pan.polygon.map((p) => p[0]), zs = pan.polygon.map((p) => p[1]);
  near(Math.max(...xs) - Math.min(...xs), 0.51, 1e-5, "yaw 90 swaps the width and the depth of the footprint (depth 0.45 + 0.06)"); near(Math.max(...zs) - Math.min(...zs), 0.5, 1e-5);
  assert.ok(pointInPolygon(1.2, 2, pan.polygon) && !pointInPolygon(1.0, 2.5, pan.polygon));
  sb.setVisible(seat.id, false); assert.ok(!sb.supportsWorld().some((s) => s.objectId === seat.id), "hidden objects offer no support");
  // grips under rotation
  const wheel = sb.add("steering_wheel", { position: [0, 0, 5], yaw: 180, params: { diameter: 0.4, tilt: 0, centreHeight: 0.8 } });
  const grips = sb.gripsWorld(wheel.id), gl = grips.find((g) => g.hand === "L"), gr = grips.find((g) => g.hand === "R");
  vnear(gl.position, [0.2, 0.8, 5], 1e-6); vnear(gr.position, [-0.2, 0.8, 5], 1e-6); assert.ok(gl.position.x > gr.position.x, "the driver's left hand is on +X, the figure's left, once the wheel is turned to face the driver");
  vnear(gl.normal, [-1, 0, 0], 1e-9); near(gl.diameter, 0.034);
  for (const g of grips) { near(g.axis.length(), 1); const m = g.matrix.elements; assert.ok(m.every(Number.isFinite)); near(new THREE.Vector3(m[0], m[1], m[2]).dot(new THREE.Vector3(m[4], m[5], m[6])), 0, 1e-9, "orthogonal frame"); vnear(new THREE.Vector3().setFromMatrixPosition(g.matrix), g.position.toArray()); }
  assert.deepEqual(sb.gripsWorld("ghost"), []);
  // a rotated desk's supports and bounds
  const desk = sb.add("desk", { position: [4, 0, 4], yaw: 30 }), dp = sb.supportsWorld().find((s) => s.objectId === desk.id);
  near(dp.y, 0.74); const area = Math.abs(dp.polygon.reduce((a, p, i) => { const q = dp.polygon[(i + 1) % 4]; return a + (p[0] * q[1] - q[0] * p[1]); }, 0)) / 2; near(area, 1.4 * 0.7, 1e-5, "rotation keeps the area");
  const b = sb.bounds(); assert.ok(!b.isEmpty() && b.max.x > 4 && b.min.x < 1.0); assert.ok(sb.bounds(new THREE.Box3()).equals(b));
  assert.equal(sb.frameObjects(desk.id), true); assert.equal(f.vp.frames.length, 1); assert.equal(sb.frameObjects("ghost"), false);
});

test("dropToSurface rests an object on the highest support below it, otherwise on the floor", () => {
  const { sb } = fixture();
  const desk = sb.add("desk", { position: [0, 0, 2], yaw: 180 }), laptop = sb.add("laptop", { position: [0.2, 1.5, 2.1] }), lone = sb.add("laptop", { position: [3, 1.5, 6] });
  assert.equal(sb.dropToSurface(laptop.id), true); near(laptop.position[1], 0.74); assert.equal(sb.dropToSurface(lone.id), true); assert.equal(lone.position[1], 0);
  const below = sb.add("box", { position: [0, 0, 2.2] }); assert.equal(sb.dropToSurface(below.id), false, "already on the floor and the desk top is above it");
  sb.remove(below.id); sb.setVisible(desk.id, false); sb.move(laptop.id, { y: 1 }); sb.dropToSurface(laptop.id); assert.equal(laptop.position[1], 0, "a hidden desk is not a surface");
});

// ============================================================================================================================ attachments
function fakeRig() {
  const pts = { palm: new THREE.Vector3(0.3, 1.0, 0.5), wrist: new THREE.Vector3(0.35, 0.95, 0.4) };
  const quat = new THREE.Quaternion();
  const rig = {
    pts, quat, root: { x: 0, y: 0.9, z: 0 }, body: { landmarks: { palm_centre_L: { joint: "wrist_L" } } },
    landmarkWorld(id, out) { if (id !== "palm_centre_L") throw new Error(`unknown landmark id "${id}"`); return out.copy(pts.palm); },
    jointWorld(id, out) { if (id !== "wrist_L") throw new Error(`unknown joint "${id}"`); return out.copy(pts.wrist); },
    jointQuaternion(id, out) { return out.copy(quat); },
  };
  return rig;
}
test("attach and detach: an object follows a landmark or joint on pose and rig events; offsets, orientation, errors", () => {
  const rig = fakeRig(), f = fixture({ rig }), { sb, ctx } = f;
  const tool = sb.add("hammer", { position: [3, 0, 3] });
  assert.equal(sb.attach(tool.id, { kind: "landmark", id: "palm_centre_L" }, [0, 0.05, 0]), true);
  vnear(new THREE.Vector3(...tool.position), [0.3, 1.05, 0.5]); vnear(tool.group.position, [0.3, 1.05, 0.5]);
  rig.pts.palm.set(0.5, 1.4, 0.8); ctx.emit("pose", { rig });
  vnear(new THREE.Vector3(...tool.position), [0.5, 1.45, 0.8], 1e-9); assert.ok(tool.attachedTo && tool.attachError === null);
  assert.equal(sb.move(tool.id, { x: 0.7, y: 1.45, z: 0.8 }), true, "moving an attached object changes its offset");
  assert.deepEqual(tool.attachedTo.offset, [0.2, 0.05, 0]); rig.pts.palm.set(0, 1, 0); ctx.emit("pose", { rig }); near(tool.position[0], 0.2, 1e-9);
  // not draggable, no gizmo, arrow keys explain
  sb.select(tool.id); assert.equal(f.vp.gizmo, null, "no gizmo on an attached object");
  vnear(new THREE.Vector3(...tool.position), [0.2, 1.05, 0]);
  sb.detach(tool.id); assert.equal(tool.attachedTo, null); vnear(new THREE.Vector3(...tool.position), [0.2, 1.05, 0]); rig.pts.palm.set(5, 5, 5); ctx.emit("pose", { rig }); near(tool.position[0], 0.2, 1e-9, "no longer follows");
  assert.equal(sb.detach(tool.id), false); assert.equal(sb.attach("ghost", { kind: "joint", id: "wrist_L" }), false); assert.equal(sb.attach(tool.id, { kind: "bone", id: "x" }), false); assert.equal(sb.attach(tool.id, { kind: "joint", id: "../x" }), false);
  // a joint, in the joint's own frame, with orientation
  sb.attach(tool.id, { kind: "joint", id: "wrist_L" }, [0, 0, 0.1], { local: true, orient: true });
  rig.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); ctx.emit("pose", { rig });
  vnear(new THREE.Vector3(...tool.position), [0.35 + 0.1, 0.95, 0.4], 1e-9); // local +Z turned by 90 degrees about Y is world +X
  vnear(new THREE.Vector3(0, 0, 1).applyQuaternion(tool.group.quaternion), [1, 0, 0], 1e-9);
  sb.detach(tool.id); near(tool.yaw, 90, 1e-6, "the heading is kept, pitch and roll are dropped"); near(tool.group.rotation.y, Math.PI / 2, 1e-9);
  // landmark of a rig that does not have it, and no rig at all
  const bad = sb.add("hammer", { position: [1, 0, 1] }); sb.attach(bad.id, { kind: "landmark", id: "nope" }); assert.match(bad.attachError, /no landmark "nope"/); assert.deepEqual(bad.position, [1, 0, 1], "stays put");
  f.setRig(null); sb.updateAttached(); assert.match(bad.attachError, /no figure/);
  // saved and restored with the scene
  f.setRig(rig); sb.attach(tool.id, { kind: "landmark", id: "palm_centre_L" }, [0, 0.1, 0]); const json = JSON.stringify(sb.toJSON()), g = fixture({ rig }); g.sb.fromJSON(json);
  assert.deepEqual([...g.sb.objects.values()].find((o) => o.id === tool.id).attachedTo, { kind: "landmark", id: "palm_centre_L", offset: [0, 0.1, 0], local: false, orient: false });
  // undo brings the attachment back
  sb.detach(tool.id); sb.undo(); assert.ok(sb.objects.get(tool.id).attachedTo);
  const real = fixture(); real.sb.add("box", { position: [0, 0, 1] }); assert.doesNotThrow(() => real.ctx.emit("pose", {}));
});

test("attached to the real rig: an object follows a hand when the pose changes", async () => {
  const { syntheticBody } = await import("../../site/js/human/synthetic.js"), { buildRig } = await import("../../site/js/human/rig.js");
  const rig = buildRig(syntheticBody(1.75, "male"), { skeleton: false }), f = fixture({ rig });
  const o = f.sb.add("flashlight", { position: [2, 0, 2] }); f.sb.attach(o.id, { kind: "landmark", id: "grip_centre_R" });
  const p0 = rig.landmarkWorld("grip_centre_R"); vnear(new THREE.Vector3(...o.position), p0.toArray(), 1e-5);
  rig.setPose({ root: { y: rig.root.y }, angles: { shoulder_R: [90, 0, 0], elbow_R: [20] } }); f.ctx.emit("pose", { rig });
  const p1 = rig.landmarkWorld("grip_centre_R"); assert.ok(p1.distanceTo(p0) > 0.2, "the hand moved"); vnear(new THREE.Vector3(...o.position), p1.toArray(), 1e-5);
  const hand = f.sb.anchorWorld(o.id, "grip_centre"); assert.ok(hand.distanceTo(p1) < 0.1, "the object's grip is at the hand");
  f.sb.dispose(); rig.dispose();
});

// ============================================================================================================================ persistence
function fakeStorage(fail = false) {
  const m = new Map();
  return { m, getItem: (k) => { if (fail) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { if (fail) throw new Error("quota"); m.set(k, String(v)); }, removeItem: (k) => { if (fail) throw new Error("blocked"); m.delete(k); } };
}
function manualScheduler() { const q = []; const fn = (f) => { q.push(f); return () => { const i = q.indexOf(f); if (i >= 0) q.splice(i, 1); }; }; fn.run = () => { const l = q.splice(0); l.forEach((f) => f()); return l.length; }; fn.pending = () => q.length; return fn; }

test("persistence is opt-in, debounced, guarded and restorable", () => {
  const st = fakeStorage(), sch = manualScheduler(), f = fixture({ storage: st, scheduler: sch });
  f.sb.add("box"); sch.run(); assert.equal(st.m.size, 0, "nothing is stored without opt-in");
  assert.equal(f.sb.remember, false);
  assert.equal(f.sb.setRemember(true), true); assert.equal(st.m.get("hm-scene-remember"), "1"); assert.ok(st.m.get("hm-scene"), "stored at once when switched on");
  f.sb.add("crate"); f.sb.add("monitor"); assert.equal(sch.pending(), 1, "changes are debounced into one save"); sch.run();
  assert.equal(JSON.parse(st.m.get("hm-scene")).objects.length, 3);
  // a new session
  const g = fixture({ storage: st, scheduler: manualScheduler() }); const r = g.sb.restore(); assert.equal(r.ok, true); assert.equal(g.sb.objects.size, 3); assert.equal(g.sb.remember, true); assert.equal(g.sb.canUndo, false, "the restored scene is the start of the history");
  g.sb.setRemember(false); assert.equal(st.m.has("hm-scene"), false); assert.equal(st.m.has("hm-scene-remember"), false);
  const h = fixture({ storage: st }); assert.equal(h.sb.restore(), null); assert.equal(h.sb.objects.size, 0);
  // blocked storage never throws
  const bad = fixture({ storage: fakeStorage(true), scheduler: manualScheduler() });
  assert.equal(bad.sb.setRemember(true), false); assert.equal(bad.sb.saveLocal(), false); assert.equal(bad.sb.restore(), null); bad.sb.add("box");
  // corrupt or hostile stored text is ignored
  const st2 = fakeStorage(); st2.m.set("hm-scene-remember", "1"); st2.m.set("hm-scene", "{not json"); const c = fixture({ storage: st2 }); assert.equal(c.sb.restore().ok, false); assert.equal(c.sb.objects.size, 0);
  st2.m.set("hm-scene", JSON.stringify({ version: 1, objects: [{ type: "box" }, { type: "bogus" }] })); const d = fixture({ storage: st2 }); assert.equal(d.sb.restore().added, 1);
  const none = fixture({ storage: null }); none.sb.add("box");
  assert.doesNotThrow(() => none.sb.setRemember(true));
});

test("sections of other modules survive the remembered scene", () => {
  const st = fakeStorage(), sch = manualScheduler(), f = fixture({ storage: st, scheduler: sch });
  f.sb.registerSerializer("measurements", { toJSON: () => [{ id: "m1", kind: "distance" }], fromJSON() {} }); f.sb.setRemember(true);
  assert.deepEqual(JSON.parse(st.m.get("hm-scene")).measurements, [{ id: "m1", kind: "distance" }]);
});

// ============================================================================================================================ limits, labels, lifecycle
test("the scene is limited to 200 objects", () => {
  const { sb, toasts } = fixture();
  for (let i = 0; i < MAX_OBJECTS; i++) assert.ok(sb.add("point_marker", { position: [i * 0.05, 0, 3] }));
  assert.equal(sb.add("box"), null); assert.ok(toasts.some((t) => /200 objects/.test(t))); assert.equal(sb.objects.size, MAX_OBJECTS);
  assert.equal(sb.duplicate([...sb.objects.keys()][0]), null);
  sb.remove([...sb.objects.keys()][0]); assert.ok(sb.add("box"));
});

test("labels in the 3D view: the mass of loads, the name of the selection, optional names for all", () => {
  const { sb, vp } = fixture();
  const crate = sb.add("crate", { position: [0, 0, 1], params: { mass: 12.5 }, name: "Crate A" }), desk = sb.add("desk", { position: [2, 0, 1], name: "Desk A" }), empty = sb.add("pallet", { position: [-2, 0, 1] });
  let l = vp.labels(); assert.deepEqual(l.map((x) => x.text), ["12.5 kg"], "only loads with a mass are labelled; an empty pallet has no mass");
  sb.select(desk.id); l = vp.labels(); assert.deepEqual(l.map((x) => x.text).sort(), ["12.5 kg", "Desk A"]);
  sb.select(crate.id); assert.ok(vp.labels().some((x) => x.text === "Crate A · 12.5 kg" && x.priority >= 100));
  sb.setShowNames(true); assert.equal(vp.labels().length, 3); assert.ok(vp.labels().every((x) => x.position instanceof THREE.Vector3 && Number.isFinite(x.position.y)));
  const top = vp.labels().find((x) => x.id === desk.id).position; near(top.y, 0.79, 1e-6, "above the top of the desk");
  sb.setVisible(desk.id, false); assert.equal(vp.labels().length, 2);
  sb.setParam(empty.id, "mass", 800); assert.ok(vp.labels().some((x) => x.text === "800 kg" || x.text.includes("800 kg")));
});

test("dispose frees every geometry, removes the scene graph and listeners, and is idempotent", () => {
  const f = fixture(); sample(f.sb);
  f.sb.select(f.sb.objects.keys().next().value);
  const geos = []; f.sb.root.traverse((o) => { if (o.geometry) { geos.push(o.geometry); } });
  let freed = 0; for (const g of geos) g.addEventListener("dispose", () => freed++);
  const clicks = f.vp.listenerCount("click"), keys = (() => { let n = 0; return n; })();
  assert.ok(clicks >= 1);
  f.sb.dispose(); f.sb.dispose();
  assert.equal(freed, new Set(geos).size, "every geometry (selection outline included) was disposed once");
  assert.equal(f.vp.scene.children.includes(f.sb.root), false); assert.equal(f.vp.listenerCount("click"), 0); assert.equal(f.vp.listenerCount("gizmo-change"), 0); assert.equal(f.vp.gizmo, null); assert.equal(f.vp.labels().length, 0);
  f.ctx.emit("selection", { kind: "object", id: "o1" }); f.ctx.emit("pose", {}); // no longer handled, no throw
  const e = key("ArrowUp"); f.vp.container.dispatchEvent(e); assert.equal(e.defaultPrevented, false, "the key listener is gone");
  assert.equal(f.sb.disposed, true); void keys;
});

test("twenty add/remove cycles leave no geometry behind", () => {
  const f = fixture(); let live = 0;
  const geoCount = () => { let n = 0; f.sb.root.traverse((o) => { if (o.geometry) n++; }); return n; };
  const base = geoCount();
  for (let i = 0; i < 20; i++) {
    const o = f.sb.add(CATALOG[i % CATALOG.length].type); f.sb.select(o.id); f.sb.setParam(o.id, byType(o.type).params[0].key, byType(o.type).params[0].max); f.sb.remove(o.id); live = geoCount();
  }
  assert.equal(live, base); assert.equal(f.sb.root.children.length, 0);
});

test("one sandbox per viewport: sandboxFor, peekSandbox, acquire / release, and the ctx hooks", () => {
  const { ctx, store } = stubCtx(); assert.equal(peekSandbox(ctx), null);
  const a = sandboxFor(ctx), b = sandboxFor(ctx); assert.equal(a, b); assert.equal(ctx.sandbox, a); assert.equal(ctx.state.sandbox, a); assert.ok(!Object.keys(ctx.state).includes("sandbox"), "not enumerable: the shell's prefs code is unaffected");
  const other = { ...ctx, state: store.state }; assert.equal(sandboxFor(other), a, "another panel's ctx (same viewport) reaches the same sandbox"); assert.equal(peekSandbox(ctx.viewport), a);
  assert.throws(() => sandboxFor({}), /no viewport/);
  acquireSandbox(ctx); acquireSandbox(ctx); releaseSandbox(ctx); assert.equal(a.disposed, false); releaseSandbox(ctx); assert.equal(a.disposed, true); assert.equal(peekSandbox(ctx), null);
  const c = sandboxFor(ctx); assert.notEqual(c, a, "a new one after disposal"); c.dispose();
  assert.doesNotThrow(() => releaseSandbox({ viewport: stubViewport() }));
});

test("the place-the-human container exists before any panel does", () => {
  const f = fixture(); assert.equal(f.sb.placeContainer, null, "no DOM in Node: null, never a throw");
  globalThis.document = { createElement: () => ({ id: "", className: "" }) };
  try { const a = f.sb.placeContainer; assert.equal(a.id, "hm-place-human"); assert.equal(f.sb.placeContainer, a, "one element, created once"); } finally { delete globalThis.document; }
});

test("hover outlines follow the pointer and are cleaned up", () => {
  const sch = manualScheduler(), f = fixture({ scheduler: sch }), { sb, vp } = f;
  const o = sb.add("box", { position: [0, 0, 1.5], params: { width: 0.6, depth: 0.6, height: 1 } });
  vp.emit("pointermove", { ...vp.toClient(new THREE.Vector3(0, 0.5, 1.5)), buttons: 0, pointerType: "mouse" }); sch.run();
  assert.equal(sb.hovered, o.id); assert.ok(o.group.children.some((c) => c.name === "hover")); assert.equal(vp.cursor, "move");
  vp.emit("pointermove", { ...vp.toClient(new THREE.Vector3(3, 0, 6)), buttons: 0, pointerType: "mouse" }); sch.run();
  assert.equal(sb.hovered, null); assert.ok(!o.group.children.some((c) => c.name === "hover")); assert.equal(vp.cursor, "grab");
  vp.emit("pointermove", { ...vp.toClient(new THREE.Vector3(0, 0.5, 1.5)), buttons: 1, pointerType: "mouse" }); assert.equal(sch.pending(), 0, "no hover work while a button is down (an orbit drag)");
  sb.hover(o.id); sb.select(o.id); sb.hover(o.id); assert.equal(sb.hovered, null, "the selected object is not also hovered");
  sb.hover("ghost"); assert.equal(sb.hovered, null);
});

// ============================================================================================================================ regressions of the verifier's defects
// A stand-in for the figure's skin: a solid slab where the body is. The sandbox only needs `rig.skin` (a raycastable object) and `rig.display`.
function figureSkin({ xray = false } = {}) {
  const skin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.7, 0.3), new THREE.MeshBasicMaterial());
  skin.position.set(0, 0.85, 0); skin.updateMatrixWorld(true);
  return { skin, display: { skin: true, xray }, root: { x: 0, z: 0 } };
}
const chest = new THREE.Vector3(0, 1.3, 0.15); // on the front of the slab, as seen from the default camera

test("picking: an object behind the figure is not under the pointer; beside it, in front of it, through an x-ray or a hidden skin it is", () => {
  const rig = figureSkin(), f = fixture({ rig }), { sb, vp } = f;
  const wall = sb.add("box", { position: [0, 0, -0.6], params: { width: 2, depth: 0.3, height: 2 } });
  assert.equal(sb.pickAt(...Object.values(vp.toClient(chest))), null, "the press on the chest belongs to the figure");
  vp.emit("pointerdown", ptr(vp, chest)); assert.equal(vp.controls.enabled, true, "no drag started: the orbit controls keep the press");
  vp.emit("pointermove", ptr(vp, chest.clone().add(new THREE.Vector3(0.3, 0, 0)))); assert.equal(sb.dragging, false); assert.deepEqual(wall.position, [0, 0, -0.6]);
  vp.emit("pointerup", ptr(vp, chest));
  const click = vp.toClient(chest); const ev = { ...click, handled: false }; vp.emit("click", ev); assert.equal(ev.handled, false, "the click is left to the figure");
  assert.equal(sb.selected, null);
  const beside = new THREE.Vector3(0.8, 1.0, -0.45); // wall surface seen next to the figure
  assert.equal(sb.pickAt(...Object.values(vp.toClient(beside)))?.obj.id, wall.id, "next to the figure the wall is pickable");
  assert.equal(sb.pickAt(...Object.values(vp.toClient(chest)), { ignoreFigure: true })?.obj.id, wall.id, "a caller that compares with the skin itself can ask for the object");
  rig.display.xray = true; assert.equal(sb.pickAt(...Object.values(vp.toClient(chest)))?.obj.id, wall.id, "x-ray: the figure is see-through");
  rig.display.xray = false; rig.skin.visible = false; assert.equal(sb.pickAt(...Object.values(vp.toClient(chest)))?.obj.id, wall.id, "a hidden skin hides nothing");
  rig.skin.visible = true;
  const holder = new THREE.Object3D(); holder.add(rig.skin); holder.visible = false;
  assert.equal(sb.pickAt(...Object.values(vp.toClient(chest)))?.obj.id, wall.id, "a hidden parent hides the skin too");
  holder.visible = true;
  const front = sb.add("box", { position: [0, 0, 0.9], params: { width: 0.5, depth: 0.2, height: 1.4 } });
  assert.equal(sb.pickAt(...Object.values(vp.toClient(new THREE.Vector3(0, 1.0, 1.0))))?.obj.id, front.id, "an object in front of the figure is picked");
});

test("picking: the skin is only tested when an object is hit (a skinned ray test is slow, hover runs often)", () => {
  const rig = figureSkin(), f = fixture({ rig }), { sb, vp } = f;
  let rays = 0; const raycast = rig.skin.raycast.bind(rig.skin); rig.skin.raycast = (...a) => { rays++; return raycast(...a); };
  sb.add("box", { position: [3, 0, 1], params: { width: 0.4, depth: 0.4, height: 0.4 } });
  sb.pickAt(...Object.values(vp.toClient(new THREE.Vector3(-3, 0, 2)))); assert.equal(rays, 0, "nothing hit: no skin test");
  sb.pickAt(...Object.values(vp.toClient(new THREE.Vector3(3, 0.2, 1)))); assert.equal(rays, 1);
});

test("pointercancel (a touch the browser took over) ends the drag: orbit back on, undo group closed, from the viewport event and from the DOM event", () => {
  for (const via of ["dom", "viewport"]) {
    const f = fixture(), { sb, vp } = f;
    const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.6, depth: 0.6, height: 0.6 } });
    const at = new THREE.Vector3(0, 0.3, 1);
    vp.emit("pointerdown", ptr(vp, at)); vp.emit("pointermove", ptr(vp, new THREE.Vector3(0.4, 0.3, 1.2)));
    assert.equal(sb.dragging, true, via); assert.equal(vp.controls.enabled, false);
    if (via === "dom") vp.container.dispatchEvent(new Event("pointercancel")); else vp.emit("pointercancel", {});
    assert.equal(sb.dragging, false, via); assert.equal(vp.controls.enabled, true, "orbit is back");
    sb.add("small_box"); // would be swallowed into a still-open group
    assert.equal(sb.undoLabel.startsWith("Add"), true, `${via}: the drag was committed as its own step, then the add`);
    assert.equal(sb.undo(), true); assert.ok(sb.objects.has(o.id)); assert.equal(sb.undoLabel, `Move ${o.name}`);
  }
});

test("touch: a finger on an object leaves the camera its pinch, the drag takes over only after the threshold", () => {
  const f = fixture(), { sb, vp } = f;
  vp.controls = { enabled: true, touches: { ONE: 0, TWO: 2 } };
  const o = sb.add("box", { position: [0, 0, 1], params: { width: 0.6, depth: 0.6, height: 0.6 } });
  const at = new THREE.Vector3(0, 0.3, 1), t = (extra = {}) => ptr(vp, at, { pointerType: "touch", ...extra });
  // finger 1 down, finger 2 down: the controls were never switched off, so they see both fingers and pinch
  vp.emit("pointerdown", t()); assert.equal(vp.controls.enabled, true, "the controls still get the press"); assert.equal(vp.controls.touches.ONE, -1, "but the one-finger orbit is parked: the object is being held");
  vp.emit("pointerdown", t({ originalEvent: { isPrimary: false, pointerId: 2 } }));
  assert.equal(vp.controls.touches.ONE, 0, "the second finger gives the one-finger action back"); assert.equal(vp.controls.enabled, true); assert.equal(sb.dragging, false);
  vp.emit("pointerup", t()); assert.deepEqual(o.position, [0, 0, 1]);
  // a one-finger drag: below the threshold nothing moves, beyond it the controls are off, at the end everything is restored
  vp.emit("pointerdown", t()); vp.emit("pointermove", { ...t(), clientX: t().clientX + 2 }); assert.equal(vp.controls.enabled, true); assert.equal(sb.dragging, false);
  vp.emit("pointermove", ptr(vp, new THREE.Vector3(0.4, 0.3, 1), { pointerType: "touch" })); assert.equal(sb.dragging, true); assert.equal(vp.controls.enabled, false);
  vp.emit("pointerup", t()); assert.equal(vp.controls.enabled, true); assert.equal(vp.controls.touches.ONE, 0); assert.ok(o.position[0] > 0.1);
  // a tap: restored too
  vp.emit("pointerdown", t()); vp.emit("pointerup", t()); assert.equal(vp.controls.touches.ONE, 0); assert.equal(vp.controls.enabled, true);
  // a mouse press still switches the controls off at once (there is no pinch to keep)
  vp.emit("pointerdown", ptr(vp, new THREE.Vector3(o.position[0], 0.3, 1))); assert.equal(vp.controls.enabled, false); vp.emit("pointerup", ptr(vp, at)); assert.equal(vp.controls.enabled, true);
});

test("dragging on the floor with the camera near it does not throw the object away (a few pixels move it a little, the view along the floor is damped)", () => {
  const f = fixture(), { sb, vp } = f;
  vp.camera.position.set(0.5, 0.35, 4.5); vp.camera.lookAt(0, 0.3, 1.2); vp.camera.updateMatrixWorld(); vp.camera.updateProjectionMatrix();
  const o = sb.add("box", { position: [0, 0, 1.2], params: { width: 0.4, depth: 0.4, height: 0.4 } });
  const p0 = vp.toClient(new THREE.Vector3(0, 0.2, 1.2));
  vp.emit("pointerdown", { ...p0, button: 0, buttons: 1, shift: false, alt: false, pointerType: "mouse", originalEvent: { isPrimary: true, pointerId: 1 } });
  let last = 1.2, at36 = null;
  for (const dy of [-4, -8, -12, -20, -36, -80, -200, -600]) {
    vp.emit("pointermove", { ...p0, clientY: p0.clientY + dy, buttons: 1, shift: false, alt: false, pointerType: "mouse", originalEvent: { isPrimary: true, pointerId: 1 } });
    const z = o.position[2];
    assert.ok(Math.abs(z - 1.2) < 12, `${dy} px moved it to z=${z}`);
    assert.ok(z <= last + 1e-9, `moving the pointer further up never brings it back (${dy}: ${z} after ${last})`); last = z;
    if (dy === -36) at36 = z;
  }
  assert.ok(Math.abs(at36 - 1.2) < 1.5, `36 px of motion on a grazing view stay below 1.5 m: ${at36} (it was 838 m)`);
  vp.emit("pointerup", p0);
  // a normal view is not damped: the object follows the pointer's point on the floor plane exactly (the cap is 6 times the distance the pointer covers)
  const g = fixture(); const q = g.sb.add("box", { position: [0, 0, 1], params: { width: 0.6, depth: 0.6, height: 0.6 } });
  const floorAt = (c) => g.vp.ray(c.clientX, c.clientY).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  const a = ptr(g.vp, new THREE.Vector3(0, 0.3, 1)), to = g.vp.toClient(new THREE.Vector3(0.5, 0, 1.5)), want = floorAt(a);
  const w2 = floorAt(to); g.vp.emit("pointerdown", a); g.vp.emit("pointermove", { ...a, ...to });
  near(q.position[0], w2.x - want.x, 1e-6, `x ${q.position}`); near(q.position[2], 1 + w2.z - want.z, 1e-6, `z ${q.position}`);
});

test("keyboard: with objectKeys off only undo / redo / duplicate work; the 3D view's keys come from the canvas only", () => {
  const f = fixture(), { sb, vp } = f;
  const o = sb.add("box", { position: [0, 0, 1] }); sb.select(o.id);
  for (const k of ["Delete", "Backspace", "w", "e", "r", "[", "]", "ArrowUp"]) assert.equal(sb.onKey(key(k), { objectKeys: false }), false, k);
  assert.ok(sb.objects.has(o.id)); assert.equal(sb.gizmoMode, "translate"); assert.equal(o.yaw, 0);
  assert.equal(sb.onKey(key("d", { ctrlKey: true }), { objectKeys: false }), true); assert.equal(sb.objects.size, 2);
  assert.equal(sb.onKey(key("z", { ctrlKey: true }), { objectKeys: false }), true); assert.equal(sb.objects.size, 1);
  const button = { tagName: "BUTTON" }, canvas = new EventTarget(); vp.canvas = canvas;
  sb.select(o.id);
  vp.container.dispatchEvent(key("Delete", { target: button })); assert.ok(sb.objects.has(o.id), "a button inside the view container does not delete");
  vp.container.dispatchEvent(key("Delete", { target: canvas })); assert.equal(sb.objects.has(o.id), false, "the canvas does");
  sb.undo(); sb.select(o.id); vp.container.dispatchEvent(key("Delete", { target: vp.container })); assert.equal(sb.objects.has(o.id), false, "so does the container itself");
});

test("Open scene: Undo brings the old measurements back with the old objects, Redo the new ones; Add scene leaves them alone", () => {
  const f = fixture(), { sb } = f;
  let items = [{ id: "m1", kind: "height", a: { kind: "world", p: [0, 1, 0] } }];
  const ser = { toJSON: () => items.map((i) => ({ ...i })), fromJSON: (v) => { items = Array.isArray(v) ? v.map((i) => ({ ...i })) : []; } };
  sb.registerSerializer("measurements", ser);
  sb.add("box", { position: [0, 0, 1] });
  assert.equal(sb.fromJSON({ version: 1, objects: [{ type: "crate" }, { type: "crate" }] }).ok, true);
  assert.equal(items.length, 0, "a file without measurements replaces them");
  sb.undo(); assert.equal(sb.objects.size, 1); assert.deepEqual(items.map((i) => i.id), ["m1"], "undo restores the measurements too");
  sb.redo(); assert.equal(sb.objects.size, 2); assert.equal(items.length, 0, "redo opens the file again, measurements included");
  sb.undo();
  const n = sb.objects.size; sb.fromJSON({ version: 1, objects: [{ type: "crate" }] }, { merge: true });
  assert.equal(items.length, 1, "Add scene (merge) keeps them"); sb.undo(); assert.equal(sb.objects.size, n); assert.equal(items.length, 1, "undoing an Add scene changes nothing about measurements");
  // a file that changes nothing about the sections still is an undo step (an empty scene opened over an empty scene)
  const g = fixture(); items = []; g.sb.registerSerializer("measurements", ser); g.sb.fromJSON({ version: 1, objects: [] }); assert.equal(g.sb.canUndo, false, "nothing changed: no step");
});

test("catalogue: grip normals are perpendicular to their axes; seat supports are at the seat top; nothing dips below the floor", () => {
  for (const t of CATALOG) for (const [vn, params] of Object.entries(variants(t))) {
    const tag = `${t.type}/${vn}`;
    for (const gr of t.grips(params)) {
      const n = new THREE.Vector3(...gr.normal), ax = new THREE.Vector3(...gr.axis);
      near(n.length(), 1, 1e-5, `${tag} ${gr.id} normal length`); near(ax.length(), 1, 1e-5, `${tag} ${gr.id} axis length`); near(n.dot(ax), 0, 1e-5, `${tag} grip ${gr.id}: normal.axis = ${n.dot(ax)}`);
    }
    assert.ok(t.build(params).userData.bbox.min.y > -1e-6, `${tag} dips below the floor by ${t.build(params).userData.bbox.min.y}`);
  }
  for (const height of [0.6, 0.75, 0.8]) {
    const g = buildObject("bar_stool", { height }), top = new THREE.Raycaster(new THREE.Vector3(0.05, height + 1, 0.05), new THREE.Vector3(0, -1, 0)).intersectObject(g, true)[0];
    near(top.point.y, height, 1e-6, "the seat top is where the seat support and the seat anchor say");
    near(byType("bar_stool").supports({ height })[0].y, height, 1e-9); assert.ok(g.userData.bbox.max.y >= height - 1e-9);
  }
  // the grip of a tilted lever keeps the intended side: the palm still faces the user (-Z) after the projection
  const tilted = byType("lever").grips({ angle: 40 })[0]; assert.ok(tilted.normal[2] < -0.3 || Math.abs(tilted.normal[1]) > 0.3, `lever grip normal ${tilted.normal}`);
});

test("catalogue: the defaults lie within the ranges their source text quotes, and the text says where the sliders go further", () => {
  const st = byType("stairs"), lad = byType("ladder"), step = byType("step");
  const def = (t, k) => t.params.find((p) => p.key === k).default;
  assert.ok(def(st, "rise") >= 0.12 && def(st, "rise") <= 0.20 && def(st, "tread") >= 0.24, "stairs defaults");
  assert.ok(def(lad, "width") >= 0.4 && def(lad, "spacing") >= 0.25 && def(lad, "spacing") <= 0.35, "ladder defaults");
  assert.ok(def(step, "rise") >= 0.12 && def(step, "rise") <= 0.25 && def(step, "depth") >= 0.2, "step defaults");
  assert.match(st.source, /sliders go further/); assert.match(lad.source, /width slider starts at 0\.35/); assert.match(step.source, /Rise slider goes from 0\.05 to 0\.45/);
  assert.equal(st.params.find((p) => p.key === "rise").max, 0.25); assert.equal(lad.params.find((p) => p.key === "width").min, 0.35); assert.equal(step.params.find((p) => p.key === "rise").max, 0.45);
});

// ============================================================================================================================ regressions of the verifier's round-2 defects
// Run a module snippet in a worker thread, so that a regression back to an endless loop fails this test (after `ms`) instead of hanging the whole file.
async function inWorker(code, ms = 5000) {
  const w = new Worker(code, { eval: true, execArgv: ["--import", new URL("./register.mjs", import.meta.url).href] });
  const res = await Promise.race([new Promise((r) => { w.once("message", r); w.once("error", (e) => r({ error: String(e) })); }), new Promise((r) => setTimeout(() => r({ hang: true }), ms))]);
  await w.terminate();
  return res;
}
const href = (rel) => new URL(rel, import.meta.url).href;
const HEAD = `import * as THREE from "three"; import { parentPort } from "node:worker_threads";
const vp = { scene: new THREE.Scene(), add() {}, remove() {}, requestRender() {}, on() { return () => {}; }, container: null };
const ctx = { state: {}, on: () => () => {}, emit() {}, select() {}, getRig: () => null, toast() {}, units: "mm" };`;

test("an id like o99999999999999999999 in a scene file cannot freeze id allocation (sandbox and measurements)", async () => {
  const r1 = await inWorker(`${HEAD} import { createSandbox } from "${href("../../site/js/human/sandbox.js")}";
    const sb = createSandbox({ viewport: vp, ctx, scheduler: () => () => {} });
    const r = sb.fromJSON({ version: 1, objects: [{ type: "box", id: "o99999999999999999999" }, { type: "box" }, { type: "box" }] });
    sb.add("box"); parentPort.postMessage({ ok: r.ok, ids: [...sb.objects.keys()] });`);
  assert.ok(!r1.hang, "loading the scene never finished (newId spun)");
  assert.equal(r1.ok, true); assert.equal(new Set(r1.ids).size, 4, `ids ${r1.ids}`);
  const r2 = await inWorker(`${HEAD} import { createMeasure } from "${href("../../site/js/human/measure.js")}";
    const ms = createMeasure({ viewport: vp, ctx, scheduler: () => {} }), w = (x) => ({ kind: "world", p: [x, 0, 0] });
    const r = ms.fromJSON([{ kind: "distance", id: "m99999999999999999999", a: w(0), b: w(1) }, { kind: "distance", a: w(0), b: w(2) }, { kind: "distance", a: w(0), b: w(3) }, { kind: "height", id: "m1".padEnd(40, "9"), a: w(1) }, { kind: "height", a: w(4) }]);
    parentPort.postMessage({ ok: r.ok, ids: ms.items.map((i) => i.id) });`);
  assert.ok(!r2.hang, "loading the measurements never finished (nextId spun)");
  assert.equal(r2.ok, true); assert.equal(new Set(r2.ids).size, 5, `ids ${r2.ids}`);
  // numbers up to 9 digits still advance the counter, so a new object never takes an id of the file
  const f = fixture(); f.sb.fromJSON({ version: 1, objects: [{ type: "box", id: "o999999999" }] });
  assert.equal(f.sb.add("box").id, "o1000000000");
});

test("'Remember this scene' brings back the measurements, even though their module registers after the restore, and never overwrites them", () => {
  const scene = { app: "digital-human-scene", version: 1, objects: [{ id: "o1", type: "monitor", position: [0, 0, 1.5] }],
    measurements: [{ id: "m1", kind: "height", a: { kind: "world", p: [0, 1.5, 0] }, label: "Remembered" }], snap: { gridMm: 0, angleDeg: 0 } };
  const st = fakeStorage(); st.m.set("hm-scene-remember", "1"); st.m.set("hm-scene", JSON.stringify(scene));
  const sch = manualScheduler(), f = fixture({ storage: st, scheduler: sch });
  const stored = () => JSON.parse(st.m.get("hm-scene"));
  assert.equal(f.sb.restore().ok, true);
  sch.run(); // the autosave that follows the restore, while nobody owns the measurements yet
  assert.equal(stored().measurements.length, 1, "the section is written back, not dropped, while its module is missing");
  const ms = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() });
  assert.deepEqual(ms.items.map((i) => i.label), ["Remembered"], "the module is handed its section when it registers");
  f.sb.add("box"); sch.run();
  assert.equal(stored().objects.length, 2); assert.equal(stored().measurements.length, 1); assert.equal(f.sb.canUndo, true);
  f.sb.undo(); assert.equal(ms.items.length, 1, "undoing an object does not touch the measurements");
  // the module goes away (its panel is closed), the scene stays: the next save keeps its section, and a new module gets it back
  ms.dispose(); f.sb.add("box"); sch.run(); assert.equal(stored().measurements.length, 1);
  const ms2 = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() }); assert.equal(ms2.items.length, 1);
  // opening a scene file without measurements replaces them also when nobody owns them
  ms2.dispose(); f.sb.fromJSON({ version: 1, objects: [] }); sch.run(); assert.equal(stored().measurements, undefined);
  // a merge adds to the waiting section
  f.sb.fromJSON({ version: 1, objects: [], measurements: [{ kind: "height", a: { kind: "world", p: [0, 1, 0] } }] });
  f.sb.fromJSON({ version: 1, objects: [], measurements: [{ kind: "height", a: { kind: "world", p: [0, 2, 0] } }] }, { merge: true });
  const ms3 = createMeasure({ viewport: f.vp, ctx: f.ctx, sandbox: f.sb, scheduler: (fn) => fn() }); assert.equal(ms3.items.length, 2);
});

test("an edit younger than the autosave delay is written when the sandbox is disposed or flushSave() is called", () => {
  const st = fakeStorage(), sch = manualScheduler(), f = fixture({ storage: st, scheduler: sch }), x = () => JSON.parse(st.m.get("hm-scene")).objects[0].position[0];
  f.sb.setRemember(true);
  const o = f.sb.add("box", { position: [0, 0, 2] }); sch.run();
  f.sb.move(o.id, { x: 1 }); assert.equal(sch.pending(), 1); assert.equal(x(), 0, "not stored yet");
  assert.equal(f.sb.flushSave(), true); assert.equal(x(), 1); assert.equal(sch.pending(), 0); assert.equal(f.sb.flushSave(), false, "nothing waiting");
  f.sb.move(o.id, { x: 2 }); f.sb.dispose(); assert.equal(x(), 2, "dispose flushes the waiting save");
  const off = fixture({ storage: fakeStorage(), scheduler: manualScheduler() }); off.sb.add("box"); assert.equal(off.sb.flushSave(), false, "without the opt-in nothing is written");
});

test("hover picking is throttled: at most one pick per 30 ms", () => {
  const q = [], f = fixture({ scheduler: (fn, ms) => { q.push([fn, ms]); return () => {}; } }), { sb, vp } = f;
  sb.add("box", { position: [0, 0, 1.5], params: { width: 0.6, depth: 0.6, height: 1 } });
  const move = () => vp.emit("pointermove", { ...vp.toClient(new THREE.Vector3(0, 0.5, 1.5)), buttons: 0, pointerType: "mouse" });
  q.length = 0; move(); assert.equal(q.length, 1); assert.equal(q[0][1], 0, "the first pick is not delayed"); q.shift()[0]();
  move(); move(); assert.equal(q.length, 1, "moves between two picks are coalesced");
  const delay = q[0][1]; assert.ok(delay > 0 && delay <= 30, `the next pick waits for the rest of the 30 ms (${delay})`);
});

test("triple monitor: the side screens wrap towards the user, left and right are the viewer's, and every screen has its edges", () => {
  const T = byType("triple_monitor"), A = (p) => T.anchors(normalizeParams("triple_monitor", p)), P = (a) => new THREE.Vector3(...a.position), N = (a) => new THREE.Vector3(...a.normal);
  const eye = new THREE.Vector3(0, 1.15, 0.7), incidence = (a) => N(a).angleTo(eye.clone().sub(P(a))) * 180 / Math.PI;
  for (const curved of [false, true]) {
    const flat = A({ panelAngle: 180, curved }), wrap = A({ panelAngle: 140, curved });
    assert.ok(wrap.left_screen.position[0] < 0 && wrap.right_screen.position[0] > 0, "the viewer's left screen is on -X (the user is at +Z looking along -Z)");
    assert.match(wrap.left_screen.label, /viewer's left/); assert.match(wrap.right_screen.label, /viewer's right/);
    for (const side of ["left", "right"]) {
      assert.ok(wrap[`${side}_outer_edge`].position[2] > wrap[`${side}_screen`].position[2] + 0.05, `${side}: the outer edge comes towards the user (curved ${curved})`);
      assert.ok(incidence(wrap[`${side}_screen`]) < incidence(flat[`${side}_screen`]) - 5, `${side}: a smaller angle between the panels turns the side screens towards the eye (curved ${curved})`);
    }
    assert.ok(wrap.left_screen.normal[0] > 0.3 && wrap.right_screen.normal[0] < -0.3, "the side normals point inwards");
    // every screen reports its four edges (the viewing check takes the width and the visual angle from them), the viewer's right edge being on the right
    for (const id of ["", "left_screen_", "right_screen_"]) {
      const l = wrap[`${id}left_edge`], r = wrap[`${id}right_edge`], t = wrap[`${id}top_edge`], b = wrap[`${id}bottom_edge`];
      assert.ok(l && r && t && b, `edges of "${id || "centre screen"}"`);
      near(P(l).distanceTo(P(r)), 0.5313, 2e-3, `${id} width`); assert.ok(t.position[1] > b.position[1]);
    }
    const lc = wrap.left_screen_right_edge, cc = wrap.left_edge; // the joint: the left screen's inner edge meets the middle screen's left edge
    assert.ok(P(lc).distanceTo(P(cc)) < 0.06 && Math.abs(lc.position[2] - cc.position[2]) < 0.03, `the panels meet at the joint (curved ${curved})`);
  }
  // in line (180, flat): the side screens lie in the plane of the middle one; the angle between neighbours' normals is 180 - the angle between panels
  const line = A({ panelAngle: 180, curved: false, tilt: 0 }), a140 = A({ panelAngle: 140, curved: false, tilt: 0 });
  near(line.left_screen.position[2], line.screen_centre.position[2], 1e-9); near(N(line.left_screen).angleTo(N(line.screen_centre)), 0, 1e-9);
  near(N(a140.left_screen).angleTo(N(a140.screen_centre)) * 180 / Math.PI, 40, 1e-3);
  // curved and 180: the three arcs form one smooth arc of the 1.8 m radius
  const c180 = A({ panelAngle: 180, curved: true });
  for (const id of ["left_screen", "right_screen"]) { const x = Math.abs(c180[id].position[0]), z = 1.8 - Math.sqrt(1.8 * 1.8 - x * x); near(c180[id].position[2], z, 0.003, `${id} lies on the circle of the curved array`); }
});

test("anchors name the side they are on: 'viewer's' for what a user at +Z faces, 'object's' for the rest, 'sitter's' for seats, and the label agrees with the position", () => {
  const want = { "viewer's left": (x) => x < 0, "viewer's right": (x) => x > 0, "object's left": (x) => x > 0, "object's right": (x) => x < 0, "sitter's left": (x) => x > 0, "sitter's right": (x) => x < 0 };
  let n = 0;
  for (const t of CATALOG) for (const [id, an] of Object.entries(byType(t.type).anchors(defaultParams(t.type)))) {
    const m = /(viewer's|object's|sitter's) (left|right)/.exec(an.label);
    if (m) { n++; assert.ok(want[m[0]](an.position[0]), `${t.type}.${id} "${an.label}" is at x = ${an.position[0]}`); }
    assert.ok(!/\b(left|right)\b[^(]*\(\s*[+-]X\s*\)/.test(an.label) || /'s (left|right)/.test(an.label), `${t.type}.${id} "${an.label}" does not say whose left it is`);
  }
  assert.ok(n >= 40, `${n} labels checked`);
  const desk = byType("desk").anchors({}), box = byType("box").anchors({});
  assert.ok(desk.corner_fl.position[0] < 0 && /viewer's left/.test(desk.corner_fl.label), "a desk's front left corner is the one on the left of the person at +Z");
  assert.ok(box.corner_fl.position[0] > 0 && /object's left/.test(box.corner_fl.label), "a plain box has no user: its left is its own");
});
