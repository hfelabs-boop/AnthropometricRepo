// "Place the human" (site/js/human/place.js) and the Analysis data (site/js/human/panels/analysis.js computeAnalysis) without a browser: the REAL rig, sandbox, posture editor,
// ik.js and metrics.js on three bodies, a stub viewport and the real state store. The browser side is tests/human3d/test_place_analysis.py. Manual: docs/human3d/PLACE_ANALYSIS.md.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/place.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { buildRig } from "../../site/js/human/rig.js";
import * as IK from "../../site/js/human/ik.js";
import * as METRICS from "../../site/js/human/metrics.js";
import { POSTURES, byId } from "../../site/js/human/postures.js";
import { contactClearances, poseEquals } from "../../site/js/human/pose.js";
import { createEditor } from "../../site/js/human/editor.js";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";
import { byType } from "../../site/js/human/catalog.js";
import {
  createPlacer, headingToward, forwardOf, planeHeightAt, assignGrips, gripPreset, fitYaw, propOf, parsePropNote, feetSentence, seatSentence, fmtMm, DEFAULT_SEATED,
} from "../../site/js/human/place.js";
import { computeAnalysis, ANGLE_ROWS, MODEL_NOTES, displayOf } from "../../site/js/human/panels/analysis.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = [["woman P5", army("F", 5)], ["man P50", army("M", 50)], ["man P95", army("M", 95)]];
const MAN = BODIES[1][1];
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------------------------------- harness
const W = 800, H = 600;
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 120);
  camera.position.set(0, 6, 0.01); camera.lookAt(0, 0, 0.6); camera.updateMatrixWorld(); camera.updateProjectionMatrix(); // from above: a floor drag is easy to aim
  const handlers = new Map(), container = new EventTarget(), raycaster = new THREE.Raycaster();
  const vp = {
    scene, camera, container, controls: { enabled: true }, active: true, gizmo: null, gizmoDragging: false, canvas: null, cursor: "",
    theme: { accent: new THREE.Color(0x2a78d6), good: new THREE.Color(0x0f7a2e) },
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {},
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    emit(evt, ev = {}) { for (const f of [...(handlers.get(evt) ?? [])]) f(ev); return ev; },
    listenerCount: () => [...handlers.values()].reduce((a, s) => a + s.size, 0),
    ray(cx, cy) { camera.updateMatrixWorld(); raycaster.setFromCamera(new THREE.Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), camera); return raycaster; },
    toClient(v) { const p = v.clone().project(camera); return { clientX: (p.x * 0.5 + 0.5) * W, clientY: (-p.y * 0.5 + 0.5) * H }; },
    attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor(c) { vp.cursor = c; }, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {},
  };
  return vp;
}
/** A real rig, sandbox, editor and placer wired like the shell wires them (rig.onChange -> "pose"; the editor and the sandbox listen on the ctx). */
function world(body = MAN, { later } = {}) {
  let rig = buildRig(body, {});
  const store = createStore(), toasts = [], viewport = stubViewport();
  let handlers = 0, offRig = null;
  const ctx = {
    state: store.state, viewport, on: (e, f) => { handlers++; const off = store.on(e, f); return () => { handlers--; off(); }; }, emit: (e, d) => store.emit(e, d), select: (s) => store.select(s),
    getRig: () => rig, getBody: () => rig.body, toast: (m) => toasts.push(m), units: "mm", setPosture() {},
  };
  const wire = () => { offRig?.(); offRig = rig.onChange(() => ctx.emit("pose", { rig })); };
  wire();
  const sb = createSandbox({ viewport, ctx, storage: null, scheduler: () => () => {} });
  ctx.sandbox = sb;
  const ed = createEditor({ getRig: () => rig, getBody: () => rig.body, ik: IK, metrics: METRICS, ctx, storage: null, scheduler: { raf: null, caf: null, now: () => 0 }, coalesceMs: 0 });
  const pending = [];
  const scheduler = { later: later ?? ((fn) => { const t = { fn, live: true }; pending.push(t); return () => { t.live = false; }; }), frame: null };
  const placer = createPlacer({ ctx, sandbox: sb, editor: ed, ik: IK, metrics: METRICS, scheduler });
  return {
    get rig() { return rig; }, ctx, sb, ed, placer, viewport, toasts, store, get handlers() { return handlers; },
    /** Run the callbacks the placer deferred (the idle recompute of the reach envelope). */
    flush() { for (const t of pending.splice(0)) if (t.live) t.fn(); },
    /** A new profile: the shell builds another rig, swaps it in and emits "rig". */
    swapRig(newBody) { const old = rig; rig = buildRig(newBody, {}); wire(); ctx.emit("rig", rig); old.dispose?.(); return rig; },
  };
}
const feet = (rig) => Math.min(...rig.contactPoints("feet").map((p) => p.y));
const pointOf = (rig, id) => rig.landmarkWorld(id).clone();
const seatObj = (w, type, opts = {}) => w.sb.add(type, { position: [0.4, 0, -0.3], yaw: 35, ...opts });
const planeAt = (w, o, p) => { const sup = w.sb.supportsWorld().find((s) => s.objectId === o.id && /seat|bench|stool/i.test(`${s.id}`)); return planeHeightAt(sup, o.yaw, p.x, p.z); };
const gaze = (rig) => { const q = new THREE.Quaternion(), d = new THREE.Vector3(); for (const id of ["eye_L", "eye_R"]) d.add(new THREE.Vector3(0, 0, 1).applyQuaternion(rig.jointQuaternion(id, q))); return d.normalize(); };

// ======================================================================================================================================== pure helpers
test("pure helpers: headings, the seat plane, grip assignment, presets, the yaw fit, props and sentences", () => {
  near(headingToward(0, 0, 0, 1), 0, 1e-9); near(headingToward(0, 0, 1, 0), 90, 1e-9); near(headingToward(0, 0, -1, 0), -90, 1e-9); near(Math.abs(headingToward(0, 0, 0, -1)), 180, 1e-9);
  assert.equal(headingToward(1, 1, 1, 1), null);
  const [fx, fz] = forwardOf(90); near(fx, 1, 1e-12); near(fz, 0, 1e-12);
  // a pan tilted front up by 5 degrees: 0.1 m in front of the centre is 8.7 mm higher, behind it lower; yaw 90 turns the forward axis to +X
  const sup = { y: 0.4, pitch: 5, polygon: [[-0.25, 0.5], [0.25, 0.5], [0.25, 1], [-0.25, 1]] };
  near(planeHeightAt(sup, 0, 0, 0.85), 0.4 + Math.tan(5 * D2R) * 0.1, 1e-9); near(planeHeightAt(sup, 0, 0, 0.65), 0.4 - Math.tan(5 * D2R) * 0.1, 1e-9);
  near(planeHeightAt({ ...sup, polygon: [[0.5, -0.25], [1, -0.25], [1, 0.25], [0.5, 0.25]] }, 90, 0.85, 0), 0.4 + Math.tan(5 * D2R) * 0.1, 1e-9);
  near(planeHeightAt({ ...sup, pitch: 0 }, 0, 0.1, 0.1), 0.4, 1e-12);
  const grips = [{ id: "a", hand: "L", label: "A" }, { id: "b", hand: "R", label: "B" }, { id: "c", hand: "both", label: "C" }];
  assert.deepEqual(assignGrips(grips, "both").assignments.map((x) => [x.side, x.grip.id]), [["L", "a"], ["R", "b"]]);
  assert.deepEqual(assignGrips(grips, "R").assignments.map((x) => [x.side, x.grip.id]), [["R", "b"]]);
  assert.deepEqual(assignGrips([{ id: "k", hand: "both", label: "K" }], "both").assignments.map((x) => [x.side, x.grip.id]), [["L", "k"]], "one shared grip: the first hand takes it, the other is skipped");
  assert.equal(assignGrips([{ id: "k", hand: "both", label: "K" }], "both").skipped.length, 1);
  assert.deepEqual(assignGrips(grips, "L", "b").assignments.map((x) => [x.side, x.grip.id]), [["L", "b"]], "a named grip goes to the chosen hand");
  assert.equal(assignGrips(grips, "L", "zzz").assignments.length, 0);
  assert.equal(gripPreset({ id: "x", diameter: 0 }), "flat"); assert.equal(gripPreset({ id: "rim_9", diameter: 0.03 }, "steering_wheel"), "wheel");
  assert.equal(gripPreset({ id: "pistol_grip", diameter: 0.03 }, "rifle"), "trigger"); assert.equal(gripPreset({ id: "handle", diameter: 0.03 }, "hammer"), "power");
  // the fit recovers a yaw and a translation exactly
  const locals = [[0.2, 0.1, 0.0], [-0.2, 0.1, 0.0], [0, 0.3, 0.4]], yaw = 137.5, t = [0.3, 0.05, -1.2];
  const targets = locals.map((p) => { const c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R); return [p[0] * c + p[2] * s + t[0], p[1] + t[1], -p[0] * s + p[2] * c + t[2]]; });
  const fit = fitYaw(locals, targets);
  near(fit.yaw, yaw, 0.1, "yaw"); fit.t.forEach((v, i) => near(v, t[i], 2e-3, `t${i}`)); assert.ok(fit.cost < 1e-5);
  assert.equal(propOf({}), null); assert.equal(propOf({ hints: { prop: { type: "no_such_thing" } } }), null);
  const p = propOf({ hints: { prop: { type: "crate", params: { mass: 10 }, role: "held", grips: { L: "side_left", R: "nope" }, note: "n" } } });
  assert.deepEqual(p.grips, { L: "side_left" }, "a grip the object does not have is dropped"); assert.equal(p.role, "held");
  assert.deepEqual(parsePropNote("wall behind the figure: 0.37 m behind the heels"), { direction: "behind", distance: 0.37 });
  assert.deepEqual(parsePropNote("wall on the figure's left, plane at the left palm"), { direction: "left", distance: null });
  assert.deepEqual(parsePropNote("desk edge"), { direction: "front", distance: null });
  assert.match(feetSentence(0.012), /12 mm above the floor/); assert.match(feetSentence(-0.0123), /12 mm below the floor/); assert.match(feetSentence(0.002), /rest on the floor/);
  assert.match(seatSentence(-0.0073), /7\.3 mm inside/); assert.equal(fmtMm(0.0004), "0.4 mm"); assert.equal(fmtMm(0.1234), "123 mm");
  assert.equal(DEFAULT_SEATED, "sit-upright-90");
  assert.ok(byId(DEFAULT_SEATED), "the default seated posture exists in the library");
});

// ======================================================================================================================================== sitting
const SEAT_TYPES = ["cabin_seat", "office_chair", "stool", "bar_stool", "bench", "jump_seat"];
test("sit on every seat type of the catalogue, three bodies: the sit bones on the seat plane, the heading of the seat, the feet gap reported as measured", () => {
  const rows = [];
  for (const [bname, body] of BODIES) {
    for (const type of SEAT_TYPES) {
      const w = world(body), o = seatObj(w, type);
      const res = w.placer.sitOn(o.id);
      const tag = `${bname} / ${type}`;
      assert.equal(res.ok, true, `${tag}: ${res.message}`);
      const rig = w.rig, pl = w.ed.place, rep = res.report;
      assert.equal(pl.mode, "seat", tag); assert.equal(pl.seat.objectId, o.id, tag);
      near(rig.root.heading, 35, 1e-6, `${tag} heading = the seat's yaw`);
      // independent seat contact: every seat-set point against the (tilted) plane of the surface
      const sup = w.sb.supportsWorld().find((s) => s.objectId === o.id), pts = rig.contactPoints("seat");
      const gaps = pts.map((p) => p.y - planeHeightAt(sup, o.yaw, p.x, p.z)), lowest = Math.min(...gaps);
      near(rep.seatGap, lowest, 1e-9, `${tag} reported seat gap`);
      const tol = sup.pitch ? 0.012 : 0.001;
      assert.ok(Math.abs(lowest) <= tol, `${tag}: the seat contacts are ${(lowest * 1000).toFixed(2)} mm from the surface (limit ${tol * 1000} mm, pitch ${sup.pitch})`);
      const isch = ["ischial_L", "ischial_R"].map((id) => pointOf(rig, id));
      assert.ok(isch.every((p) => planeAt(w, o, p) - p.y < 0.02 && p.y - planeAt(w, o, p) < 0.02), `${tag}: the ischial points are within 2 cm of the seat surface`);
      assert.equal(rep.onSeat, true, `${tag}: the sit bones are over the seat`);
      // the feet gap: measured from the figure, not from the editor
      const fg = feet(rig);
      near(rep.feetGap, fg, 1e-9, `${tag} feet gap`);
      near(w.ed.info().gaps.feet, fg, 1e-6, `${tag} the editor agrees`);
      const mmFeet = Math.abs(fg * 1000);
      if (mmFeet > 5) assert.ok(rep.messages.join(" ").includes(`${mmFeet < 10 ? mmFeet.toFixed(1) : Math.round(mmFeet)} mm`), `${tag}: the message names the gap: ${rep.messages.join(" ")}`);
      else assert.match(rep.messages.join(" "), /feet rest on the floor/, tag);
      // the buttocks touch the back-rest plane of a seat with a reference point
      const srp = w.sb.anchorWorld(o.id, "srp");
      if (srp) { const [fx, fz] = forwardOf(o.yaw), b = pointOf(rig, "buttock_extremity"); near(b.x * fx + b.z * fz, srp.x * fx + srp.z * fz, 1e-6, `${tag} buttock at the back-rest plane`); }
      // adjust to this body: the popliteal rule puts the feet on the floor unless the seat cannot go there
      const adj = w.placer.adjustSeatToBody(o.id);
      assert.equal(adj.ok, true, tag);
      const ps = byType(type).params.find((p) => p.key === adj.param), now = w.sb.objects.get(o.id).params[adj.param];
      assert.ok(now >= ps.min - 1e-9 && now <= ps.max + 1e-9, `${tag}: the parameter stays in range`);
      const g2 = feet(rig);
      if (!adj.clamped) assert.ok(Math.abs(g2) <= (sup.pitch ? 0.012 : 0.0015), `${tag}: after the adjustment the feet are ${(g2 * 1000).toFixed(2)} mm from the floor`);
      else { assert.ok(Math.abs(adj.to - adj.wanted) > 1e-6, tag); assert.ok(Math.sign(g2) === Math.sign(adj.to - adj.wanted) || Math.abs(g2) < 0.012, `${tag}: a clamped seat leaves the feet ${(g2 * 1000).toFixed(1)} mm off, on the side of the shortfall`); assert.match(adj.message, /can only go/, tag); }
      assert.ok(Math.abs(w.placer.seatReport().feetGap - g2) < 1e-9, tag);
      // the figure still sits on the seat after the seat moved (the editor follows)
      const sup2 = w.sb.supportsWorld().find((s) => s.objectId === o.id);
      assert.ok(Math.abs(Math.min(...rig.contactPoints("seat").map((p) => p.y - planeHeightAt(sup2, o.yaw, p.x, p.z)))) <= tol, `${tag}: the figure followed the adjusted seat`);
      // adjust to the feet of another posture
      w.ed.apply("sit-relaxed-office", { animate: false, keepPlacement: true });
      const f2 = w.placer.adjustSeatToFeet(o.id);
      assert.equal(f2.ok, true, tag);
      const g3 = feet(rig);
      if (!f2.clamped) assert.ok(Math.abs(g3) <= (sup.pitch ? 0.012 : 0.0015), `${tag}: the feet of another posture touch the floor: ${(g3 * 1000).toFixed(2)} mm`);
      rows.push([bname, type, (fg * 1000).toFixed(1), adj.clamped ? "clamped" : (g2 * 1000).toFixed(1)]);
    }
  }
  assert.equal(rows.length, 18);
  console.log("sit: feet gap before / after the popliteal adjustment (mm)\n" + rows.map((r) => `  ${r.join(" | ")}`).join("\n"));
});

test("sitting: the current seated posture is kept, a standing figure gets sit-upright-90, a chosen posture is used, and one undo goes back", () => {
  const w = world(), o = seatObj(w, "office_chair");
  w.ed.apply("iso-7250-standing", { animate: false });
  const before = w.rig.getPose();
  const r1 = w.placer.sitOn(o.id);
  assert.equal(r1.ok, true); assert.equal(w.ed.base.id, DEFAULT_SEATED);
  assert.equal(w.ed.history.undoLabel, "Sit on Office chair", "one history step");
  w.ed.undo();
  assert.ok(poseEquals(w.rig.getPose(), before, 1e-9) || Math.abs(w.rig.root.x - before.root.x) < 1e-9, "undo restores the standing pose");
  assert.equal(w.ed.place.mode, "floor"); assert.equal(w.ed.base.id, "iso-7250-standing");
  w.ed.redo();
  assert.equal(w.ed.place.mode, "seat");
  // a chosen posture
  const r2 = w.placer.sitOn(o.id, { posture: "sit-lean-forward-desk" });
  assert.equal(r2.ok, true); assert.equal(w.ed.base.id, "sit-lean-forward-desk");
  // "current" keeps a seated posture
  w.ed.apply("sit-recline-115", { animate: false });
  w.placer.sitOn(o.id, { posture: "current" });
  assert.equal(w.ed.base.id, "sit-recline-115");
  // no seat: a clear sentence, nothing changes
  const box = w.sb.add("floor_tile", { position: [3, 0, 3] });
  const r3 = w.placer.sitOn(box.id);
  assert.equal(r3.ok, false); assert.match(r3.message, /no surface to sit on/);
  assert.equal(w.placer.sitOn("nope").ok, false);
  assert.equal(w.placer.seats().length, 1); assert.equal(w.placer.seats()[0].objectId, o.id);
});

test("the figure follows the seat that was sat on: moved, turned and raised, the sit bones stay on its surface and the heading follows", () => {
  const w = world(), o = seatObj(w, "stool");
  w.placer.sitOn(o.id);
  const a = w.rig.root.heading;
  w.sb.move(o.id, { x: 1.2, z: 0.5 }, { snap: false });
  w.sb.rotate(o.id, 80, { snap: false });
  w.sb.setParam(o.id, "height", 0.55);
  const sup = w.sb.supportsWorld().find((s) => s.objectId === o.id);
  near(Math.min(...w.rig.contactPoints("seat").map((p) => p.y - sup.y)), 0, 1e-6, "on the raised stool");
  near(w.rig.root.heading, 80, 1e-6); assert.notEqual(a, w.rig.root.heading);
  const c = sup.polygon.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
  assert.ok(Math.hypot(w.placer.spot().x - c[0], w.placer.spot().z - c[1]) < 1e-6, "the contact centroid is at the middle of the stool");
});

// ======================================================================================================================================== standing
test("stand at: the middle of the feet at a spot, the heading, standing up from a seat, face an object, one undo step each", () => {
  const w = world(), o = seatObj(w, "bench");
  w.placer.sitOn(o.id);
  const r = w.placer.standAt({ x: 0.5, z: -0.7, heading: 120 });
  assert.equal(r.ok, true, r.message);
  assert.equal(w.ed.place.mode, "floor"); assert.equal(w.ed.place.seat.objectId, null, "the chair is let go");
  near(w.rig.root.heading, 120, 1e-9);
  const f = w.rig.contactPoints("feet"), cx = f.reduce((a, p) => a + p.x, 0) / f.length, cz = f.reduce((a, p) => a + p.z, 0) / f.length;
  near(cx, 0.5, 1e-6); near(cz, -0.7, 1e-6); near(Math.min(...f.map((p) => p.y)), 0, 1e-9, "the soles are on the floor");
  assert.match(r.message, /x 500 mm, z -700 mm|x 500 mm, z −700 mm/);
  assert.equal(w.ed.history.undoLabel, "Stand at a spot");
  w.ed.undo();
  assert.equal(w.ed.place.mode, "seat", "undo sits the figure down again");
  w.ed.redo();
  // moving while standing keeps the posture and only the omitted field stays
  w.ed.apply("stand-head-turned", { animate: false });
  const pose = w.rig.getPose().angles;
  const r2 = w.placer.standAt({ x: -1 });
  assert.equal(r2.ok, true); near(w.placer.spot().z, -0.7, 1e-9); near(w.placer.spot().x, -1, 1e-9);
  assert.ok(poseEquals({ root: {}, angles: w.rig.angles }, { root: {}, angles: pose }, 1e-9), "the posture is kept");
  assert.equal(w.placer.standAt({}).ok, false); assert.equal(w.placer.standAt({ x: NaN }).ok, false); assert.equal(w.placer.standAt({ heading: "a" }).ok, false);
  // face
  const m = w.sb.add("monitor", { position: [2, 0.7, 1] });
  const fr = w.placer.faceObject(m.id);
  assert.equal(fr.ok, true);
  const a = w.ed.place.anchor, c = w.sb.localToWorld(m.id, m.bbox.getCenter(new THREE.Vector3()).toArray());
  near(fr.heading, Math.atan2(c.x - a.x, c.z - a.z) / D2R, 1e-6); near(w.rig.root.heading, fr.heading, 1e-6);
  assert.equal(w.placer.faceObject("nope").ok, false);
  w.ctx.select({ kind: "object", id: m.id });
  assert.equal(w.placer.faceObject().ok, true, "defaults to the selected object");
  assert.equal(w.placer.faceObject([a.x, 1, a.z]).ok, false, "a point on the figure has no direction");
});

test("drag the figure on the floor: a press on the figure moves it, one history step, Escape-like cancel via pointercancel keeps it, a press elsewhere does nothing, listeners are removed", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  w.placer.standAt({ x: 0.3, z: 0.2, heading: 0 });
  const base = w.viewport.listenerCount();
  assert.equal(w.placer.setFloorDrag(true), true);
  assert.equal(w.viewport.listenerCount(), base + 4);
  const at = (x, z) => w.viewport.toClient(new THREE.Vector3(x, 0, z));
  const ev = (p, extra = {}) => ({ ...p, button: 0, buttons: 1, pointerType: "mouse", originalEvent: { isPrimary: true }, ...extra });
  const hist = w.ed.history.steps;
  w.viewport.emit("pointerdown", ev(at(2, 2))); // far from the figure
  assert.equal(w.viewport.controls.enabled, true, "nothing was grabbed");
  const down = w.viewport.emit("pointerdown", ev(at(0.3, 0.2)));
  assert.equal(down.handled, true); assert.equal(w.viewport.controls.enabled, false, "the orbit controls are held");
  for (let i = 1; i <= 5; i++) w.viewport.emit("pointermove", ev(at(0.3 + 0.2 * i, 0.2 - 0.1 * i)));
  w.viewport.emit("pointerup", {});
  assert.equal(w.viewport.controls.enabled, true);
  const s = w.placer.spot();
  near(s.x, 1.3, 2e-3); near(s.z, -0.3, 2e-3);
  assert.equal(w.ed.history.steps, hist + 1, "one history step");
  assert.equal(w.ed.history.undoLabel, "Move the figure");
  w.ed.undo();
  near(w.placer.spot().x, 0.3, 1e-6);
  // cancel keeps the last place; a release that never arrives ends the drag on the next move without buttons
  w.viewport.emit("pointerdown", ev(at(0.3, 0.2)));
  w.viewport.emit("pointermove", ev(at(0.8, 0.2)));
  w.viewport.emit("pointermove", ev(at(0.9, 0.2), { buttons: 0 }));
  assert.equal(w.viewport.controls.enabled, true);
  // a seated figure is not dragged over the floor
  const o = seatObj(w, "stool");
  w.placer.sitOn(o.id);
  const sp = w.placer.spot();
  const sitDown = w.viewport.emit("pointerdown", ev(at(sp.x, sp.z)));
  assert.notEqual(sitDown.handled, true, "sitting: the figure is not dragged over the floor (the press goes to the stool under it)");
  w.viewport.emit("pointerup", {});
  assert.equal(w.placer.setFloorDrag(false), false);
  assert.equal(w.viewport.listenerCount(), base);
});

// ======================================================================================================================================== grab with IK
/** The cab of the cab template: seat, wheel. The figure sits and the seat is set to this body. */
function cab(body = MAN) {
  const w = world(body);
  const seat = w.sb.add("cabin_seat", { position: [0, 0, 0.6], yaw: 0 });
  const wheel = w.sb.add("steering_wheel", { position: [0, 0, 1.2], yaw: 180, params: { centreHeight: 0.72, tilt: 25 } });
  w.placer.sitOn(seat.id);
  w.placer.adjustSeatToBody(seat.id);
  return { w, seat, wheel };
}
test("grab: both hands on a steering wheel from the seat, P50 man within 1 mm (checked on the figure), fingers closed, feet and pelvis unmoved, one undo step", () => {
  const { w, wheel } = cab();
  const feetBefore = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_R"].map((id) => pointOf(w.rig, id)), pelvis = w.rig.jointWorld("pelvis").clone(), before = w.rig.getPose(), grip0 = w.ed.gripOf("L");
  const r = w.placer.grab({ objectId: wheel.id, hand: "both" });
  assert.equal(r.ok, true, r.message); assert.equal(r.reachable, true, r.message);
  assert.deepEqual(r.hands.map((x) => [x.side, x.gripId]), [["L", "rim_9"], ["R", "rim_3"]]);
  const grips = w.sb.gripsWorld(wheel.id);
  for (const g of grips) { const side = g.hand; assert.ok(pointOf(w.rig, `grip_centre_${side}`).distanceTo(g.position) < 0.001, `${side} hand on ${g.id}`); }
  assert.ok(r.worstMm < 1, `worst ${r.worstMm} mm`);
  ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_lateral_R"].forEach((id, i) => assert.ok(pointOf(w.rig, id).distanceTo(feetBefore[i]) < 1e-4, `${id} did not move`));
  assert.ok(w.rig.jointWorld("pelvis").distanceTo(pelvis) < 1e-6, "the pelvis did not move");
  assert.equal(w.ed.gripOf("L"), "wheel"); assert.equal(w.ed.gripOf("R"), "wheel");
  assert.equal(w.ed.history.undoLabel, "Hold Steering wheel");
  w.ed.undo();
  assert.ok(poseEquals(w.rig.getPose(), before, 1e-9), "undo gives the arms back");
  assert.equal(w.ed.gripOf("L"), grip0);
  // each hand alone, either way round
  const L = w.placer.grab({ objectId: wheel.id, hand: "L" }), R = w.placer.grab({ objectId: wheel.id, hand: "R", gripId: "rim_9" });
  assert.equal(L.hands[0].gripId, "rim_9"); assert.equal(R.hands[0].gripId, "rim_9");
  assert.match(R.messages.join(" "), /made for the left hand/, "a grip made for the other hand is said so");
  assert.equal(L.reachable, true);
});

test("grab: the posture is not thrown away (a drag of the shoulders only), other joints stay, and three bodies reach the wheel or report the shortfall", () => {
  for (const [name, body] of BODIES) {
    const { w, wheel } = cab(body);
    const legs = JSON.stringify(w.rig.angles.hip_L) + JSON.stringify(w.rig.angles.knee_R), spine = JSON.stringify(w.rig.angles.L3);
    const r = w.placer.grab({ objectId: wheel.id, hand: "both" });
    assert.equal(r.ok, true, name);
    if (r.reachable) for (const g of w.sb.gripsWorld(wheel.id)) assert.ok(pointOf(w.rig, `grip_centre_${g.hand}`).distanceTo(g.position) < 0.001, `${name} ${g.id} within 1 mm`);
    else { assert.ok(r.worstMm > 1, name); assert.match(r.message, /\d+(\.\d)? mm/, name); }
    assert.equal(JSON.stringify(w.rig.angles.hip_L) + JSON.stringify(w.rig.angles.knee_R), legs, `${name}: the legs are the posture's`);
    assert.equal(JSON.stringify(w.rig.angles.L3), spine, `${name}: the trunk is the posture's`);
  }
});

test("grab: a rifle held standing: the right hand on the pistol grip within 1 mm; both hands either within 1 mm or the shortfall is named in mm", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const rifle = w.sb.add("rifle", { position: [-0.2, 1.25, 0.35], yaw: 0 });
  const R = w.placer.grab({ objectId: rifle.id, hand: "R", gripId: "pistol_grip" });
  assert.equal(R.ok, true, R.message); assert.equal(R.reachable, true, R.message);
  const grip = w.sb.gripsWorld(rifle.id).find((g) => g.id === "pistol_grip");
  assert.ok(pointOf(w.rig, "grip_centre_R").distanceTo(grip.position) < 0.001);
  assert.equal(w.ed.gripOf("R"), "trigger");
  // both hands: a placement the left arm reaches across the body
  let best = null;
  for (const x of [-0.05, -0.1, -0.15]) for (const z of [0.25, 0.3, 0.35]) {
    w.sb.move(rifle.id, { x, y: 1.25, z }, { snap: false });
    w.ed.apply("iso-7250-standing", { animate: false });
    const b = w.placer.grab({ objectId: rifle.id, hand: "both" });
    assert.equal(b.ok, true);
    if (b.reachable) for (const g of w.sb.gripsWorld(rifle.id)) assert.ok(pointOf(w.rig, `grip_centre_${g.hand}`).distanceTo(g.position) < 0.001, `rifle ${g.id} within 1 mm at ${x}, ${z}`);
    else assert.ok(b.worstMm > 1 && /\d+(\.\d)? mm/.test(b.message), "the shortfall is named in mm");
    if (!best || b.worstMm < best.worstMm) best = b;
  }
  console.log(`rifle, both hands, best of 9 placements: ${best.reachable ? "reachable" : `${best.worstMm.toFixed(1)} mm short`} (${best.hands.map((h) => `${h.side} ${h.errorMm.toFixed(2)} mm, ${h.rotDeg.toFixed(1)} deg`).join("; ")})`);
});

test("grab: unreachable cases are reported in mm, 'free the trunk' helps where the arm alone fails, 'move the object within reach' brings it, and both are undoable", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const far = w.sb.add("steering_wheel", { position: [0, 0, 2.5], yaw: 180, params: { centreHeight: 1.0 } });
  const start = w.sb.objects.get(far.id).position.slice();
  const r = w.placer.grab({ objectId: far.id, hand: "both" });
  assert.equal(r.ok, true); assert.equal(r.reachable, false);
  assert.ok(r.worstMm > 1500, `short ${r.worstMm}`); assert.match(r.message, /out of reach: 1,8\d\d mm short|out of reach: 1,9\d\d mm short|out of reach: 1,7\d\d mm short/);
  assert.equal(r.canMove, true); assert.equal(r.canFreeTrunk, true);
  assert.ok(w.ed.gripOf("L") === "wheel", "the closest pose is shown");
  const m = w.placer.moveWithinReach();
  assert.equal(m.ok, true, m.message); assert.equal(m.reachable, true, m.message);
  const now = w.sb.objects.get(far.id).position;
  assert.ok(Math.hypot(now[0] - start[0], now[1] - start[1], now[2] - start[2]) > 1.5, "the object moved toward the figure");
  assert.ok(m.hands.every((h) => h.errorMm < 1), "and the hands hold it");
  assert.equal(w.sb.undoLabel, "Move Steering wheel within reach", "one sandbox step");
  assert.ok(w.sb.undo()); assert.deepEqual(w.sb.objects.get(far.id).position, start, "the sandbox undo puts the object back");
  // a locked or attached object is not moved
  w.sb.setLocked(far.id, true);
  const bad = w.placer.grab({ objectId: far.id, hand: "R" });
  assert.equal(bad.canMove, false); assert.equal(w.placer.moveWithinReach().ok, false); assert.match(w.placer.moveWithinReach().message, /locked/);
  w.sb.setLocked(far.id, false);
  // the trunk: a joystick at shoulder height; find a distance where the arm alone is short and the trunk makes it
  const j = w.sb.add("joystick", { position: [0, 0, 0.8], yaw: 180, params: { height: 1.2 } });
  let band = null;
  for (let z = 0.6; z <= 1.0 + 1e-9; z += 0.05) {
    w.sb.move(j.id, { x: 0, y: 0, z }, { snap: false });
    w.ed.apply("iso-7250-standing", { animate: false });
    const a = w.placer.grab({ objectId: j.id, hand: "R" });
    if (a.reachable) continue;
    const spine = JSON.stringify(w.rig.angles.L3);
    const b = w.placer.grabFreeTrunk();
    assert.notEqual(JSON.stringify(w.rig.angles.L3), spine, "the trunk moved");
    if (b.reachable) { band = { z, shortMm: a.worstMm }; assert.ok(b.hands[0].errorMm < 1); break; }
  }
  assert.ok(band, "there is a distance where the arm alone is short and the trunk reaches");
  // nothing to grab
  assert.equal(w.placer.grab({ objectId: w.sb.add("floor_tile", { position: [1, 0, 1] }).id }).ok, false);
  assert.equal(w.placer.grab({ objectId: "nope" }).ok, false);
  assert.equal(w.placer.grabFreeTrunk().ok, true, "repeats the last grab");
});

test("grab: the pelvis can be freed while standing (the feet stay), and is ignored while sitting with a note", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const j = w.sb.add("joystick", { position: [0, 0, 1.0], yaw: 180, params: { height: 1.1 } });
  const heels = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R"].map((id) => pointOf(w.rig, id));
  const r = w.placer.grab({ objectId: j.id, hand: "R", freePelvis: true, freeTrunk: true });
  assert.equal(r.ok, true);
  ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R"].forEach((id, i) => assert.ok(pointOf(w.rig, id).distanceTo(heels[i]) < 2e-3, `${id} stays (${(pointOf(w.rig, id).distanceTo(heels[i]) * 1000).toFixed(2)} mm)`));
  const { w: w2, wheel } = cab();
  const r2 = w2.placer.grab({ objectId: wheel.id, hand: "both", freePelvis: true });
  assert.match(r2.messages.join(" "), /pelvis stays/);
});

test("attach to hand: the object follows the hand on every pose change, detach leaves it where it is, undo in the sandbox", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const h = w.sb.add("hammer", { position: [-0.2, 1.1, 0.4] });
  const g = w.placer.grab({ objectId: h.id, hand: "R" });
  assert.equal(g.ok, true);
  const a = w.placer.toggleAttach(h.id);
  assert.equal(a.attached, true); assert.equal(a.side, "R"); assert.ok(w.sb.objects.get(h.id).attachedTo);
  const p0 = w.sb.objects.get(h.id).position.slice(), hand0 = pointOf(w.rig, "grip_centre_R");
  w.ed.setJoint("shoulder_R", "flex", 60, { clamp: true });
  const hand = pointOf(w.rig, "grip_centre_R"), p1 = w.sb.objects.get(h.id).position;
  assert.ok(hand.distanceTo(hand0) > 0.1, "the hand moved");
  assert.ok(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) > 0.1, "the hammer moved with the hand");
  [0, 1, 2].forEach((k) => near(p1[k] - [hand.x, hand.y, hand.z][k], p0[k] - [hand0.x, hand0.y, hand0.z][k], 1e-5, "the offset from the hand stays"));
  const d = w.placer.toggleAttach(h.id);
  assert.equal(d.attached, false); assert.equal(w.sb.objects.get(h.id).attachedTo, null);
  assert.equal(w.placer.toggleAttach("nope").ok, false);
  assert.equal(w.placer.toggleAttach(h.id, "L").side, "L", "the hand can be chosen");
});

// ======================================================================================================================================== the object of a posture
test("the object a posture uses: created for every library posture with hints.prop, grips on the hands (within 1 mm or the shortfall named), role and type right, undo removes it", () => {
  const w = world();
  const withProp = POSTURES.filter((p) => p.hints?.prop && propOf(p));
  assert.ok(withProp.length >= 60, `${withProp.length} postures with a prop`);
  let held = 0, closed = 0, short = [], noGrip = 0;
  for (const p of withProp) {
    w.ed.apply(p.id, { animate: false });
    assert.equal(w.placer.postureProp().posture.id, p.id);
    const n = w.sb.objects.size;
    const r = w.placer.addPostureProp();
    assert.equal(r.ok, true, `${p.id}: ${r.message}`);
    assert.equal(r.object.type, p.hints.prop.type, p.id); assert.equal(r.role, p.hints.prop.role === "support" ? "support" : "held");
    assert.equal(w.sb.objects.size, n + 1, p.id);
    for (const [k, v] of Object.entries(p.hints.prop.params ?? {})) { const spec = byType(r.object.type).params.find((q) => q.key === k); if (spec && typeof v === "number") assert.ok(Math.abs(r.object.params[k] - Math.min(spec.max, Math.max(spec.min, v))) < 1e-9, `${p.id}: parameter ${k}`); }
    if (r.grab) {
      held++;
      for (const h of r.grab.hands) {
        const g = w.sb.gripsWorld(r.object.id).find((x) => x.id === h.gripId), d = pointOf(w.rig, `grip_centre_${h.side}`).distanceTo(g.position);
        near(d * 1000, h.errorMm, 1e-6, `${p.id}: the reported error is the measured one`);
      }
      if (r.grab.reachable) closed++; else { short.push(`${p.id} ${r.grab.worstMm.toFixed(1)} mm`); assert.match(r.grab.message, /\d+(\.\d)? mm/, p.id); }
    } else noGrip++;
    assert.ok(w.sb.undo(), `${p.id}: sandbox undo`);
    assert.equal(w.sb.objects.size, n, `${p.id}: undo removed the object`);
    // the object count stays n, but the scene history also recorded the grab moves; clear them to keep the stack short
  }
  assert.ok(held >= 40, `${held} props with named grips`);
  assert.ok(closed / held >= 0.8, `${closed} of ${held} grips closed within 1 mm; short: ${short.join(", ")}`);
  console.log(`posture props: ${withProp.length} postures, ${held} with grips (${closed} closed within 1 mm; short: ${short.join(", ") || "none"}), ${noGrip} placed by note or between the hands`);
  // no prop: a clear sentence
  const plain = POSTURES.find((p) => !propOf(p));
  if (plain) {
    w.ed.apply(plain.id, { animate: false });
    assert.equal(w.placer.postureProp(), null, plain.id);
    assert.equal(w.placer.addPostureProp().ok, false);
  }
  w.ed.neutral({ animate: false });
  assert.equal(w.placer.postureProp(), null, "the neutral pose has no posture, so no prop");
});

// ======================================================================================================================================== reach and the envelope
test("reach check: a point in front of the shoulder, one with the trunk, one out of reach; the straight arm length and fractions", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const sh = w.rig.jointWorld("shoulder_R").clone(), len = w.placer.armLength("R");
  assert.ok(len > 0.55 && len < 0.85, `arm length ${len}`);
  const near1 = w.placer.reachCheck([sh.x, sh.y - 0.1, sh.z + 0.35], { sides: ["R"] }).R;
  assert.equal(near1.reachable, true); near(near1.distance, Math.hypot(0.1, 0.35), 1e-6); near(near1.fraction, near1.distance / len, 1e-9); assert.match(near1.message, /reaches it with the arm/);
  const far = w.placer.reachCheck([sh.x, sh.y, sh.z + len + 0.5], { sides: ["R"] }).R;
  assert.equal(far.reachable, false); assert.equal(far.withTrunk, false);
  assert.ok(far.shortTrunkMm > 100 && far.shortMm >= far.shortTrunkMm - 1, `short ${far.shortMm} / ${far.shortTrunkMm}`); assert.match(far.message, /cannot reach it/);
  // a distance the arm alone misses and the trunk reaches
  let found = null;
  for (let d = len; d < len + 0.6 && !found; d += 0.02) { const c = w.placer.reachCheck([sh.x, sh.y - 0.2, sh.z + d], { sides: ["R"] }).R; if (!c.reachable && c.withTrunk) found = c; }
  assert.ok(found, "a point only the leaning trunk reaches"); assert.match(found.message, /only with the trunk leaning/);
  const both = w.placer.reachCheck({ L: [0.3, 1.2, 0.3], R: [-0.3, 1.2, 0.3] });
  assert.ok(both.L.message.startsWith("Left hand") && both.R.message.startsWith("Right hand"));
  assert.equal(w.placer.reachCheck([NaN, 1, 1], { sides: ["R"] }).R.reachable, false);
  // targets: the selected object and the selected measurement
  assert.equal(w.placer.reachTargets().length, 0);
  const box = w.sb.add("floor_tile", { position: [-0.1, 1.0, 0.3] });
  w.ctx.select({ kind: "object", id: box.id });
  const t = w.placer.reachTargets();
  assert.equal(t.length, 1); assert.match(t[0].label, /its middle/);
  assert.equal(w.placer.reachCheck(t[0].points).R.reachable, true);
  const wheel = w.sb.add("steering_wheel", { position: [0, 0, 0.9], yaw: 180, params: { centreHeight: 1.0 } });
  w.ctx.select({ kind: "object", id: wheel.id });
  const tg = w.placer.reachTargets()[0];
  assert.match(tg.label, /its grips/);
  const grips = w.sb.gripsWorld(wheel.id);
  assert.deepEqual(tg.points.L, grips.find((g) => g.hand === "L").position.toArray(), "each hand aims at its own grip");
});

test("reach envelope: random in-range poses of the arm around each shoulder, within the straight arm, drawn as a translucent cloud that follows the shoulder, rebuilt when still, freed when off", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  for (const side of ["L", "R"]) {
    const env = w.placer.envelope(side, 600), sh = w.rig.jointWorld(`shoulder_${side}`), len = w.placer.armLength(side);
    assert.equal(env.count, 600); assert.equal(env.points.length, 1800);
    let max = 0;
    for (let i = 0; i < env.count; i++) max = Math.max(max, Math.hypot(env.points[3 * i] - sh.x, env.points[3 * i + 1] - sh.y, env.points[3 * i + 2] - sh.z));
    assert.ok(max <= len + 0.12, `${side}: the farthest sample ${max} is within the straight arm ${len} plus the travel of the clavicle`);
    const noClav = IK.reachEnvelope(IK.createSolver(w.rig.restBody), w.rig.getPose(), side, { samples: 300, clavicle: false, hull: false });
    assert.ok(noClav.maxDistance <= len + 1e-6, `${side}: with the clavicle fixed no sample is beyond the straight arm`);
    assert.ok(max > 0.8 * len, `${side}: and reaches most of it`);
    near(env.maxDistance, max, 1e-4);
    assert.ok(env.hull.faces.length >= 12, "a hull");
  }
  const kids = w.viewport.scene.children.length;
  assert.equal(w.placer.showEnvelope(true), true);
  const groups = w.placer.envelopeGroups;
  assert.equal(groups.length, 2); assert.equal(w.viewport.scene.children.length, kids + 2);
  for (const g of groups) { const pts = g.getObjectByName("points"), shell = g.getObjectByName("shell"); assert.equal(pts.geometry.attributes.position.count, 1200); assert.ok(shell.material.transparent && shell.material.opacity < 0.2, "translucent"); assert.ok(pts.material.transparent); assert.equal(pts.raycast(), undefined, "never picked"); }
  // the figure moves: the cloud follows the shoulder at once; after a still moment it is rebuilt
  const shBefore = w.rig.jointWorld("shoulder_R").clone();
  w.placer.standAt({ x: 0.5, z: 0.5 });
  const moved = w.rig.jointWorld("shoulder_R").clone().sub(shBefore);
  const gR = w.placer.envelopeGroups.find((g) => g.userData.side === "R");
  near(gR.position.x, moved.x, 1e-9); near(gR.position.z, moved.z, 1e-9);
  w.flush();
  const rebuilt = w.placer.envelopeGroups;
  assert.equal(rebuilt.length, 2); assert.equal(rebuilt.find((g) => g.userData.side === "R").position.length(), 0, "rebuilt around the new shoulder");
  assert.equal(w.viewport.scene.children.length, kids + 2, "the old groups are gone");
  assert.equal(w.placer.showEnvelope(false), false);
  assert.equal(w.viewport.scene.children.length, kids); assert.equal(w.placer.envelopeGroups.length, 0);
  // the geometries are disposed when the cloud goes
  w.placer.showEnvelope(true);
  const mine = w.placer.envelopeGroups.map((g) => g.getObjectByName("points").geometry);
  const dis = mine.map((g) => { let d = false; g.addEventListener("dispose", () => { d = true; }); return () => d; });
  w.placer.showEnvelope(false);
  assert.ok(dis.every((f) => f()), "geometries are disposed when the envelope is switched off");
});

// ======================================================================================================================================== line of sight
test("look at a display: the gaze goes to its centre (one undo step) and the viewing numbers are those of measure.js; a viewing measurement is added once", () => {
  const w = world();
  w.ed.apply("sit-upright-90", { animate: false });
  const seat = w.sb.add("office_chair", { position: [0, 0, 0.2], yaw: 0 });
  w.placer.sitOn(seat.id); w.placer.adjustSeatToBody(seat.id);
  const mon = w.sb.add("monitor", { position: [0, 0.74, 0.9], yaw: 180, params: { diagonal: 24, centreHeight: 0.3, tilt: 5 } });
  w.ctx.select({ kind: "object", id: mon.id });
  assert.equal(w.placer.displays().length, 1);
  const r = w.placer.lookAtObject();
  assert.equal(r.ok, true, r.message); assert.equal(r.reachable, true);
  const t = w.sb.anchorWorld(mon.id, "screen_centre"), eye = pointOf(w.rig, "eye_mid"), dir = t.clone().sub(eye).normalize();
  assert.ok(gaze(w.rig).angleTo(dir) * 180 / Math.PI < 1, `the gaze is ${(gaze(w.rig).angleTo(dir) * 180 / Math.PI).toFixed(2)} degrees off the screen centre`);
  near(r.view.distance, eye.distanceTo(t), 1e-6);
  assert.ok(r.view.visualH > 5 && r.view.visualH < 60, `visual width ${r.view.visualH}`); assert.ok(r.view.visualV > 3);
  assert.equal(w.ed.history.undoLabel, "Look at a point");
  w.ed.undo();
  assert.ok(gaze(w.rig).angleTo(dir) * 180 / Math.PI > 1.5, "undo looks away again");
  const a = w.placer.addViewMeasurement(), b = w.placer.addViewMeasurement();
  assert.ok(a && a === b, "added once"); assert.equal(a.kind, "view");
  assert.equal(w.placer.lookAtObject("nope").ok, false);
  assert.equal(w.placer.viewOf("nope"), null);
  // an object without a screen: the middle of the object
  const box = w.sb.add("small_box", { position: [0, 1, 1.5] });
  assert.equal(w.placer.lookAtObject(box.id).ok, true);
});

// ======================================================================================================================================== the Analysis data
test("analysis data: angles with ISO 11226 flags, REBA bands, balance hull and margin, gaps, range violations, reach, verdict; it changes with the posture", () => {
  const w = world();
  w.ed.apply("iso-7250-standing", { animate: false });
  const a = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.equal(a.ready, true);
  assert.equal(a.rows.length, ANGLE_ROWS.length);
  const by = (d, id) => d.rows.find((r) => r.id === id);
  near(by(a, "trunk").single.value, -0.5, 1, "neutral trunk"); assert.equal(by(a, "trunk").single.severity, "ok");
  near(by(a, "knee").L.value, 4.9, 1.5, "the model's neutral knee"); assert.ok(by(a, "hip").L.value > 170);
  assert.equal(a.balance.applies, true); assert.ok(a.balance.inside && a.balance.margin > 0.04, `margin ${a.balance.margin}`); assert.ok(a.balance.hull.length >= 4);
  near(a.balance.margin, w.ed.info().balance.margin, 1e-9, "the same margin as the editor's");
  assert.deepEqual(a.rom, []); assert.match(a.verdict, /inside the support/); assert.match(a.verdict, /all joints inside their ranges/);
  assert.ok(a.gaps.some((g) => g.set === "feet" && g.state === "touch"));
  assert.equal(a.reach.L.above, false);
  // a bent trunk with raised arms: the flags change, the verdict changes
  w.ed.apply("reach-overhead-both", { animate: false });
  const b = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.ok(b.reach.R.aboveShoulder > 0.1 && b.reach.R.above, "hands above the head");
  assert.ok(b.notes.some((n) => /upper-arm/.test(n.id)), "an upper arm note");
  assert.notEqual(b.verdict, a.verdict);
  w.ed.apply("sit-slumped", { animate: false });
  const c = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.notEqual(by(c, "trunk").single.value, by(a, "trunk").single.value); assert.notEqual(by(c, "hip").L.value, by(a, "hip").L.value);
  // flags reflect a seat with a back-rest: backward lean is acceptable there
  const seat = w.sb.add("cabin_seat", { position: [0, 0, 0.6] });
  w.ed.apply("sit-recline-125", { animate: false });
  const noSeat = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  w.placer.sitOn(seat.id, { posture: "current" });
  const onSeat = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.equal(onSeat.flagOptions.trunkSupport, true); assert.equal(noSeat.flagOptions.trunkSupport, undefined);
  assert.equal(onSeat.flags.find((f) => f.id === "trunk-inclination").severity, "ok", "reclined against a back-rest: acceptable");
  assert.ok(onSeat.gaps.find((g) => g.set === "seat").text.includes("Cabin seat"));
  // range violations: a joint outside its range when the range is not enforced
  w.ed.setOption("enforceRom", false);
  w.ed.setJoint("elbow_R", "flex", 170, { clamp: false });
  const d = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.equal(d.rom.length, 1); assert.equal(d.rom[0].joint, "elbow_R"); assert.match(d.verdict, /1 joint angle outside the range of motion/);
  // the display the view numbers refer to
  assert.equal(c.reach.view, null);
  const mon = w.sb.add("monitor", { position: [0, 0.74, 1.2], yaw: 180 });
  assert.equal(displayOf(w.sb, null).id, mon.id, "the only display");
  const e = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb, selection: { kind: "object", id: mon.id } });
  assert.ok(e.reach.view && e.reach.view.distance > 0.4 && e.reach.view.name === "Monitor");
  assert.ok(MODEL_NOTES.length >= 4 && MODEL_NOTES.every((t) => t.length > 40));
  assert.equal(computeAnalysis({ rig: null, editor: w.ed }).ready, false);
});

test("analysis data: lying has no balance rule, a free figure has no gaps, the verdict names the reason", () => {
  const w = world();
  w.ed.apply("lie-supine", { animate: false });
  const a = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.equal(a.balance.applies, false); assert.match(a.verdict, /lying|carries itself/i);
  w.ed.setMode("free");
  const b = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
  assert.deepEqual(b.gaps, []); assert.deepEqual(b.balance.points, []);
});

test("analysis data: cost is small (a refresh is a few milliseconds) and never throws on every posture of the library", () => {
  const w = world();
  let worst = 0, n = 0;
  for (const p of POSTURES) {
    w.ed.apply(p.id, { animate: false });
    const t0 = performance.now(), d = computeAnalysis({ rig: w.rig, editor: w.ed, sandbox: w.sb });
    worst = Math.max(worst, performance.now() - t0); n++;
    assert.equal(d.ready, true, p.id); assert.ok(d.verdict.length > 20, p.id);
    assert.ok(d.rows.every((r) => [r.single, r.L, r.R].filter(Boolean).every((c) => c.value === null || Number.isFinite(c.value))), `${p.id}: finite numbers`);
    assert.ok(d.balance.com === null || d.balance.com.every(Number.isFinite), p.id);
  }
  console.log(`analysis: ${n} postures, slowest refresh ${worst.toFixed(1)} ms`);
  assert.ok(worst < 120, `slowest ${worst} ms`);
});

// ======================================================================================================================================== lifecycle
test("a new profile (the rig is replaced): the placer rebuilds its solver, sits, grabs and shows the envelope on the new figure; the old cloud is freed", () => {
  const w = world(BODIES[0][1]);
  const seat = w.sb.add("cabin_seat", { position: [0, 0, 0.6] }), wheel = w.sb.add("steering_wheel", { position: [0, 0, 1.2], yaw: 180, params: { centreHeight: 0.72, tilt: 25 } });
  w.placer.sitOn(seat.id); w.placer.adjustSeatToBody(seat.id);
  w.placer.showEnvelope(true);
  const oldGroups = w.placer.envelopeGroups.slice(), oldRig = w.rig;
  const rig2 = w.swapRig(BODIES[2][1]);
  assert.notEqual(rig2, oldRig);
  w.flush();
  assert.equal(w.placer.envelopeGroups.length, 2); assert.ok(w.placer.envelopeGroups.every((g) => !oldGroups.includes(g)), "the envelope was rebuilt");
  assert.ok(oldGroups.every((g) => g.parent === null), "the old cloud was removed from the scene");
  const sh = rig2.jointWorld("shoulder_L");
  assert.ok(w.placer.envelope("L", 200).origin.every((v, i) => Math.abs(v - [sh.x, sh.y, sh.z][i]) < 1e-9), "around the new shoulder");
  // the editor re-grounds the new figure on the seat; sit again to be sure and grab
  assert.equal(w.placer.sitOn(seat.id).ok, true);
  w.placer.adjustSeatToBody(seat.id);
  const r = w.placer.grab({ objectId: wheel.id, hand: "both" });
  assert.equal(r.ok, true, r.message);
  if (r.reachable) assert.ok(pointOf(rig2, "grip_centre_L").distanceTo(w.sb.gripsWorld(wheel.id).find((g) => g.hand === "L").position) < 0.001);
  assert.equal(w.placer.reachCheck([0, 1, 3]).L.reachable, false);
  const a = computeAnalysis({ rig: rig2, editor: w.ed, sandbox: w.sb });
  assert.equal(a.ready, true); assert.ok(a.reach.L.armLength > 0.55);
});

test("dispose: every listener of the placer is removed, the drag mode and the envelope are off, nothing is left in the scene, and a second dispose is harmless", () => {
  const w = world();
  const handlers0 = w.handlers, vp0 = w.viewport.listenerCount(), kids0 = w.viewport.scene.children.length;
  // a fresh placer on the same world, used and disposed 20 times
  for (let i = 0; i < 20; i++) {
    const p = createPlacer({ ctx: w.ctx, sandbox: w.sb, editor: w.ed, ik: IK, metrics: METRICS, scheduler: { later: () => () => {} } });
    p.setFloorDrag(true); p.showEnvelope(true);
    p.onChange(() => {});
    p.dispose();
    p.dispose();
    assert.equal(p.disposed, true);
  }
  assert.equal(w.handlers, handlers0, "no ctx listeners left");
  assert.equal(w.viewport.listenerCount(), vp0, "no viewport listeners left");
  assert.equal(w.viewport.scene.children.length, kids0, "no envelope groups left");
  // a disposed placer does not react to the figure
  const p = createPlacer({ ctx: w.ctx, sandbox: w.sb, editor: w.ed, ik: IK, metrics: METRICS, scheduler: { later: () => () => {} } });
  p.showEnvelope(true); p.dispose();
  w.ed.apply("iso-7250-standing", { animate: false });
  assert.equal(w.viewport.scene.children.length, kids0);
});

test("createPlacer needs its parts, and never throws for a user error", () => {
  assert.throws(() => createPlacer({}), /required/);
  const w = world();
  assert.equal(w.placer.sitOn(undefined).ok, false);
  assert.equal(w.placer.grab({}).ok, false);
  assert.equal(w.placer.addPostureProp().ok, false);
  assert.equal(w.placer.moveWithinReach().ok, false);
  assert.equal(w.placer.lookAtObject().ok, false);
  assert.equal(w.placer.adjustSeatToBody("nope").ok, false);
  assert.equal(w.placer.adjustSeatToFeet("nope").ok, false);
  const r = w.placer.seatReport();
  assert.equal(r.sitting, false); assert.match(r.messages[0], /not sitting/);
});
