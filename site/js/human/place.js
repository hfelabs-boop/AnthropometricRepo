// "Place the human" of the Digital human tab: put the figure on a floor spot, on a seat of the sandbox, on the grips of a control or tool, check what it can
// reach and where it looks. Manual: docs/human3d/PLACE_ANALYSIS.md. Tests: tests/human3d/place.test.mjs (Node, real rig / sandbox / editor / ik) and test_place_analysis.py.
//
// Two layers.
//   createPlacer({ ctx, sandbox, editor, ik, metrics }) -> Placer     the engine: no DOM. Every change of the pose goes through the posture editor (editor.js, ctx.posture)
//                                                                     so that it is one undo step of the Posture tab's history; every change of an object goes through the
//                                                                     sandbox (its own history). The shared one of a ctx: placeFor(ctx).
//   mountPlace(container, ctx) -> { ready, dispose, placer }          the section's controls, drawn into sandbox.placeContainer (id hm-place-human, the Scene panel's
//                                                                     "Place the human" section). The Scene panel calls it (see docs/human3d/PLACE_ANALYSIS.md).
// The top of the file is pure maths and wording (tested without a figure).
//
// Conventions as everywhere (DESIGN.md 0): metres in the API (millimetres on screen), degrees, +Y up, +Z in front of the figure, +X its left; heading is the world yaw,
// + = turn left (a heading h faces (sin h, cos h)). An object's yaw is the same.
import * as THREE from "three";
import { h } from "../util.js";
import { byType, normalizeParams, disposeObject } from "./catalog.js";
import { normalizeYaw, pointInPolygon, sandboxFor, acquireSandbox, releaseSandbox } from "./sandbox.js";
import { contactClearances, placePoseDetailed, seatHeightFor } from "./pose.js";
import { viewInfo, peekMeasure, measureFor } from "./measure.js";
import { chipButton, segmented, nextId, notice, fromUnit, UNIT_LABEL, fmtLength } from "./ui.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const mm = (m) => m * 1000;
const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: v % 1 ? 1 : 0 });
const f0 = (v) => Math.round(v).toLocaleString("en-US");
/** "12 mm", "0.4 mm": millimetres with one decimal below 10. */
export const fmtMm = (m) => { const v = Math.abs(mm(m)); return `${v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : f0(v)} mm`; };

export const DEFAULT_SEATED = "sit-upright-90";
/** Gaps (metres) within this are reported as touching. */
export const TOUCH_MM = 5;
const BACK_ALIGN = 0;     // the buttock extremity goes to the back-rest plane of a seat that has a seat reference point
const IDLE_MS = 280;      // the reach envelope is recomputed this long after the last pose change
const ENVELOPE_SAMPLES = 1200;
const SEAT_PARAMS = ["seatHeight", "height"];
const SIDES = ["L", "R"];
const SIDE_WORD = { L: "left", R: "right" };

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers
/** Heading (degrees, 0 = +Z, + = left) that faces from (x, z) to (tx, tz); null when they coincide. */
export function headingToward(x, z, tx, tz) {
  const dx = tx - x, dz = tz - z;
  if (Math.hypot(dx, dz) < 1e-6) return null;
  return normalizeYaw(Math.atan2(dx, dz) * R2D);
}
/** The forward unit vector [x, z] of a yaw in degrees. */
export const forwardOf = (yaw) => [Math.sin(yaw * D2R), Math.cos(yaw * D2R)];
/** Height of a seat surface at a world point: the support's height at its centre plus the pan angle along the seat's forward axis (front up is positive). */
export function planeHeightAt(support, yawDeg, x, z) {
  const c = support.polygon.reduce((a, p) => [a[0] + p[0] / support.polygon.length, a[1] + p[1] / support.polygon.length], [0, 0]);
  const [fx, fz] = forwardOf(yawDeg);
  return support.y + Math.tan((support.pitch ?? 0) * D2R) * ((x - c[0]) * fx + (z - c[1]) * fz);
}
/** Centre of a support's polygon [x, z]. */
export const polygonCentre = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];

/**
 * Which grip goes to which hand. grips: gripsWorld() entries ({ id, label, hand: "L" | "R" | "both" }); hand: "L" | "R" | "both"; gripId: a grip chosen by name (or null: automatic).
 * Returns { assignments: [{ side, grip }], skipped: [{ side, why }] }. Automatic: each side takes the first free grip made for its hand (then one that either hand can take).
 * A named grip goes to the chosen hand (to its own hand when both are asked for); a grip made for the other hand is still used, the caller says so.
 */
export function assignGrips(grips, hand, gripId = null) {
  const sides = hand === "both" ? SIDES : [hand === "L" ? "L" : "R"], used = new Set(), assignments = [], skipped = [];
  const by = (id) => grips.find((g) => g.id === id) ?? null;
  const named = gripId ? by(gripId) : null;
  if (gripId && !named) return { assignments, skipped: sides.map((side) => ({ side, why: `The object has no grip "${gripId}".` })) };
  if (named) {
    const side = hand === "both" ? (named.hand === "L" || named.hand === "R" ? named.hand : "R") : sides[0];
    assignments.push({ side, grip: named });
    used.add(named.id);
  }
  for (const side of sides) {
    if (assignments.some((a) => a.side === side)) continue;
    const g = grips.find((x) => !used.has(x.id) && x.hand === side) ?? grips.find((x) => !used.has(x.id) && x.hand === "both");
    if (g) { assignments.push({ side, grip: g }); used.add(g.id); } else skipped.push({ side, why: `There is no free grip for the ${SIDE_WORD[side]} hand.` });
  }
  assignments.sort((a, b) => (a.side < b.side ? -1 : 1));
  return { assignments, skipped };
}
/** The hand preset (postures/grips.js) that closes best on a grip: "flat" for a flat contact, "wheel" on a steering wheel, "trigger" on a pistol grip, else "power". */
export function gripPreset(grip, objectType = "") {
  if (grip.diameter === 0) return "flat";
  if (objectType === "steering_wheel") return "wheel";
  if (/pistol|trigger/.test(grip.id)) return "trigger";
  return "power";
}
/** The `frame` goal grip of ik.js for a gripsWorld() entry. */
export const ikGrip = (g) => ({ position: g.position.toArray(), normal: g.normal.toArray(), axis: g.axis.toArray(), diameter: g.diameter });

/** Best yaw (degrees) and translation [x, y, z] that put local points `locals` (x, y, z in the object's frame) on world points `targets` (least squares; Ry(yaw) then a translation). */
export function fitYaw(locals, targets) {
  const n = locals.length;
  if (!n) return { yaw: 0, t: [0, 0, 0], cost: 0 };
  const cost = (yaw) => {
    const c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R), w = locals.map((p) => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]);
    const t = [0, 1, 2].map((k) => w.reduce((a, p, i) => a + targets[i][k] - p[k], 0) / n);
    return { t, c: w.reduce((a, p, i) => a + (targets[i][0] - p[0] - t[0]) ** 2 + (targets[i][1] - p[1] - t[1]) ** 2 + (targets[i][2] - p[2] - t[2]) ** 2, 0) };
  };
  let best = { yaw: 0, ...cost(0) };
  for (let y = 5; y < 360; y += 5) { const r = cost(y); if (r.c < best.c - 1e-12) best = { yaw: y, ...r }; }
  for (let step = 2.5; step >= 0.05; step /= 2) for (const y of [best.yaw - step, best.yaw + step]) { const r = cost(y); if (r.c < best.c - 1e-12) best = { yaw: y, ...r }; }
  return { yaw: normalizeYaw(best.yaw), t: best.t, cost: best.c };
}

/** The prop of a posture's hints, checked against the catalogue: { type, params, role, grips, note } or null. */
export function propOf(posture) {
  const p = posture?.hints?.prop;
  if (!p || typeof p !== "object" || typeof p.type !== "string" || !byType(p.type)) return null;
  const spec = byType(p.type), grips = {};
  const have = new Set(spec.grips(normalizeParams(p.type, p.params)).map((g) => g.id));
  if (p.grips && typeof p.grips === "object") for (const s of SIDES) if (typeof p.grips[s] === "string" && have.has(p.grips[s])) grips[s] = p.grips[s];
  return { type: p.type, params: p.params && typeof p.params === "object" ? { ...p.params } : {}, role: p.role === "support" ? "support" : "held", grips, note: typeof p.note === "string" ? p.note : "", name: spec.name };
}
/**
 * Where a prop without grips goes, from the words of its note: { direction: "front" | "behind" | "left" | "right", distance (m or null) }. "0.37 m behind the heels", "on the figure's left",
 * "in front of the figure". The distance is the first "N m" before one of the direction words.
 */
export function parsePropNote(note) {
  const t = String(note ?? "").toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*m\s+(behind|in front of|to the left|to the right|on the left|on the right)/.exec(t);
  const dirOf = (w) => (/behind/.test(w) ? "behind" : /left/.test(w) ? "left" : /right/.test(w) ? "right" : "front");
  if (m) return { direction: dirOf(m[2]), distance: Number(m[1]) };
  const w = /(behind the figure|on the figure's left|on the figure's right|in front of the figure)/.exec(t);
  return { direction: w ? dirOf(w[1]) : "front", distance: null };
}

/** Sentences about the gap of the feet to the floor (metres, + = above the floor). */
export function feetSentence(gap) {
  if (!fin(gap)) return "";
  if (Math.abs(mm(gap)) <= TOUCH_MM) return "The feet rest on the floor.";
  return gap > 0 ? `The feet are ${fmtMm(gap)} above the floor: the seat is too high for this body and posture.` : `The feet would be ${fmtMm(gap)} below the floor: the seat is too low for this body and posture.`;
}
/** Sentence about the sit bones and the seat surface (metres, + = above the surface). */
export function seatSentence(gap) {
  if (!fin(gap)) return "";
  if (Math.abs(mm(gap)) <= TOUCH_MM) return "The sit bones rest on the seat.";
  return gap > 0 ? `The sit bones are ${fmtMm(gap)} above the seat surface (the pan is tilted, the figure is not).` : `The sit bones are ${fmtMm(gap)} inside the seat surface (the pan is tilted, the figure is not).`;
}

const EDGE_BASE = Object.freeze({ screen_centre: "", glass_centre: "", panel_centre: "", left_screen_centre: "left_screen_", right_screen_centre: "right_screen_" });
const DISPLAY_ANCHORS = Object.freeze(["screen_centre", "glass_centre", "panel_centre"]);

// ---------------------------------------------------------------------------------------------------------------------
// the engine
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

/**
 * createPlacer({ ctx, sandbox, editor, ik, metrics, scheduler? }) -> Placer. `ctx` is a panel ctx of the shell (getRig, getBody, on, emit, select, state, viewport, toast, units),
 * `sandbox` the Sandbox of sandbox.js, `editor` the posture editor of editor.js (the only thing that changes the pose), `ik` the module ik.js, `metrics` the module metrics.js
 * (optional). `scheduler.later(fn, ms) -> cancel` replaces setTimeout (tests). Methods return plain results ({ ok, message, ... }) and never throw for a user error.
 */
export function createPlacer({ ctx, sandbox, editor, ik, metrics = null, scheduler, onDispose } = {}) {
  if (!ctx || !sandbox || !editor || !ik) throw new TypeError("createPlacer: ctx, sandbox, editor and ik are required");
  const later = scheduler?.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const viewport = ctx.viewport;
  const listeners = new Set(), offs = [];
  let disposed = false;
  const S = { last: null, solver: null, solverRig: null, floorDrag: null, floorDragOn: false, env: { on: false, groups: [], rig: null, cancel: null, origin: {} } };

  const say = (t) => { try { ctx.toast?.(t); } catch { /* no toast */ } };
  const emit = (what = "change") => { for (const f of [...listeners]) { try { f(what); } catch (e) { console.error("placer: listener failed:", e); } } };
  const rig = () => { const r = ctx.getRig(); if (!r) throw new Error("The figure is not ready yet."); return r; };
  const bodyOf = (r) => r.restBody ?? r.body;
  const solver = () => { const r = rig(); if (S.solverRig !== r) { S.solver = ik.createSolver(bodyOf(r)); S.solverRig = r; } return S.solver; };
  const objectOf = (id) => sandbox.objects.get(id) ?? null;
  const nameOf = (id) => objectOf(id)?.name ?? "the object";
  const fail = (message, extra = {}) => ({ ok: false, message, ...extra });

  // ---- selection -----------------------------------------------------------------------------------------------------
  /** The object selected in the Scene tab (a SceneObject) or null. */
  function selectedObject() {
    const sel = ctx.state?.selection, id = sel?.kind === "object" ? sel.id : sandbox.selected;
    return id ? objectOf(id) : null;
  }
  /** Seats of the scene (editor.seatSurfaces: a seat, bench, stool or box lid 0.15 to 0.9 m high), chairs first. */
  function seats() {
    const rank = (s) => (/seat|chair|stool|bench/.test(`${objectOf(s.objectId)?.type} ${s.id}`) ? 0 : 1);
    return editor.seatSurfaces().map((s) => ({ ...s, type: objectOf(s.objectId)?.type ?? "", objectName: objectOf(s.objectId)?.name ?? s.name })).sort((a, b) => rank(a) - rank(b) || a.objectName.localeCompare(b.objectName));
  }
  /** Objects that have grips: [{ id, name, type, grips: [{ id, label, hand }] }]. */
  function gripObjects() {
    const out = [];
    for (const o of sandbox.objects.values()) {
      if (!o.visible) continue;
      const g = sandbox.gripsWorld(o.id);
      if (g.length) out.push({ id: o.id, name: o.name, type: o.type, grips: g.map((x) => ({ id: x.id, label: x.label, hand: x.hand })) });
    }
    return out;
  }
  /** Displays of the scene: objects with a screen-centre style anchor. */
  function displays() {
    const out = [];
    for (const o of sandbox.objects.values()) {
      if (!o.visible) continue;
      const anchor = DISPLAY_ANCHORS.find((a) => Object.hasOwn(o._anchors ?? {}, a));
      if (anchor) out.push({ id: o.id, name: o.name, anchor });
    }
    return out;
  }

  // ---- stand at --------------------------------------------------------------------------------------------------------
  /** Where the figure is: the centroid of the points that carry it (mid-feet standing, the seat contact when sitting) and its heading. */
  function spot() {
    const pl = editor.place;
    return { x: pl.anchor.x, z: pl.anchor.z, heading: rig().root.heading, mode: pl.mode, support: pl.support, floor: pl.mode === "floor" };
  }
  /**
   * Move the figure to a floor spot: the middle of its feet (the centroid of the carrier points) at (x, z) metres, turned to `heading` degrees. A figure that sits or floats stands
   * up first (neutral standing). One undo step. Omitted fields keep their value.
   */
  function standAt({ x, z, heading } = {}, { label = "Stand at a spot", stand = true } = {}) {
    if (![x, z, heading].some((v) => v !== undefined)) return fail("Give a spot or a heading.");
    for (const [k, v] of Object.entries({ x, z, heading })) if (v !== undefined && !fin(v)) return fail(`The ${k} must be a number.`);
    const g = editor.beginGesture(label);
    try {
      let stood = false;
      const pl = editor.place;
      if (stand && (pl.mode !== "floor" || Object.values(pl.carriers).includes("seat"))) { editor.neutral({ animate: false, label }); stood = true; }
      const cur = editor.place.anchor;
      if (x !== undefined || z !== undefined) editor.setAnchor({ x: x ?? cur.x, z: z ?? cur.z });
      if (heading !== undefined) editor.setHeading(heading);
    } finally { g.end(); }
    emit();
    const s = spot();
    return { ok: true, ...s, message: `The figure stands at x ${f0(mm(s.x))} mm, z ${f0(mm(s.z))} mm, facing ${f0(s.heading)} degrees.` };
  }
  /** Turn the figure to face the centre of an object (or a world point [x, y, z]). */
  function faceObject(target) {
    let p = null, name = "the object";
    if (Array.isArray(target)) { p = new THREE.Vector3(...target); name = "that point"; } else {
      const o = objectOf(target ?? selectedObject()?.id);
      if (!o) return fail("Select an object in the scene first.");
      name = o.name;
      const c = o.bbox.getCenter(new THREE.Vector3());
      p = sandbox.localToWorld(o.id, c.toArray()) ?? null;
    }
    if (!p) return fail("That object has no position.");
    const a = editor.place.anchor, hd = headingToward(a.x, a.z, p.x, p.z);
    if (hd === null) return fail(`The figure is already at the middle of ${name}.`);
    const g = editor.beginGesture(`Face ${name}`);
    try { editor.setHeading(hd); } finally { g.end(); }
    emit();
    return { ok: true, heading: hd, message: `The figure now faces ${name}.` };
  }

  // ---- drag the figure on the floor --------------------------------------------------------------------------------------
  const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundPoint(ev, out = new THREE.Vector3()) { const ray = viewport.ray?.(ev.clientX, ev.clientY); return ray?.ray.intersectPlane(GROUND, out) ? out : null; }
  function figureUnder(ev) {
    const r = ctx.getRig();
    if (!r) return false;
    const ray = viewport.ray?.(ev.clientX, ev.clientY);
    if (!ray) return false;
    const near = sandbox.pickAt?.(ev.clientX, ev.clientY);
    let hit = Infinity;
    if (r.skin && r.display?.skin !== false) { try { hit = ray.intersectObject(r.skin, true)[0]?.distance ?? Infinity; } catch { hit = Infinity; } }
    if (near && near.distance < hit) return false; // an object in front of the figure: the sandbox drags that
    if (hit < Infinity) return true;
    const p = groundPoint(ev), a = editor.place.anchor; // no skin (skeleton only): the floor under the figure
    return !!p && Math.hypot(p.x - a.x, p.z - a.z) < 0.4;
  }
  let dragRaf = null;
  const applyDrag = () => {
    dragRaf = null;
    const d = S.floorDrag;
    if (!d || !d.pending) return;
    const p = d.pending;
    d.pending = null;
    d.moved = true;
    try { editor.setAnchor({ x: d.a0.x + p.x - d.grab.x, z: d.a0.z + p.z - d.grab.z }, { record: false }); } catch (e) { console.warn("placer: drag failed:", e); }
    emit("drag");
  };
  function releaseOrbit() { const c = viewport.controls; if (c) c.enabled = (viewport.active === undefined ? true : !!viewport.active) && !viewport.gizmoDragging; }
  function endFloorDrag(commit) {
    const d = S.floorDrag;
    if (!d) return;
    S.floorDrag = null;
    if (dragRaf) { (scheduler?.cancelFrame ?? globalThis.cancelAnimationFrame)?.(dragRaf); dragRaf = null; }
    if (commit && d.pending) { d.moved = true; try { editor.setAnchor({ x: d.a0.x + d.pending.x - d.grab.x, z: d.a0.z + d.pending.z - d.grab.z }, { record: false }); } catch { /* gone */ } }
    if (!commit) { try { editor.setAnchor({ x: d.a0.x, z: d.a0.z }, { record: false }); } catch { /* gone */ } }
    if (d.moved) editor.commit("Move the figure", "floor-drag"); // setAnchor without record leaves the gesture clean: this is the one step
    d.gesture.end();
    releaseOrbit();
    viewport.setCursor?.("grab");
    emit();
  }
  const onDown = (ev) => {
    if (!S.floorDragOn || S.floorDrag || ev.button !== 0 || ev.originalEvent?.isPrimary === false || editor.dragging || editor.place.mode !== "floor") return;
    if (!figureUnder(ev)) return;
    const grab = groundPoint(ev);
    if (!grab) return;
    S.floorDrag = { grab, a0: { ...editor.place.anchor }, pending: null, gesture: editor.beginGesture("Move the figure", "floor-drag") };
    if (viewport.controls) viewport.controls.enabled = false;
    viewport.setCursor?.("grabbing");
    ev.handled = true;
  };
  const onMove = (ev) => {
    const d = S.floorDrag;
    if (!d) return;
    if (!ev.buttons && ev.pointerType !== "touch" && ev.buttons !== undefined) { endFloorDrag(true); return; } // the release never arrived
    const p = groundPoint(ev);
    if (!p) return;
    d.pending = p.clone();
    const raf = scheduler?.frame ?? globalThis.requestAnimationFrame;
    if (!raf) applyDrag(); else if (!dragRaf) dragRaf = raf(applyDrag);
  };
  const onUp = () => endFloorDrag(true);
  /** Switch dragging the figure over the floor on or off (a press on the figure, not on an object; only while the figure stands on the floor). */
  function setFloorDrag(on) {
    on = !!on;
    if (on === S.floorDragOn) return on;
    S.floorDragOn = on;
    if (on) {
      for (const [e, f] of [["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onUp]]) { const off = viewport.on?.(e, f); if (typeof off === "function") S.floorDragOffs = [...(S.floorDragOffs ?? []), off]; }
    } else { endFloorDrag(true); for (const f of S.floorDragOffs ?? []) f(); S.floorDragOffs = []; }
    emit();
    return on;
  }

  // ---- sit on a seat ------------------------------------------------------------------------------------------------------------
  function supportOf(objectId, supportId) {
    const list = sandbox.supportsWorld().filter((s) => s.objectId === objectId && (!supportId || s.id === supportId));
    return list.find((s) => /seat|bench|stool|lid|top|platform|deck|pad/i.test(`${s.id} ${s.name}`) && !/foot|mat|shelf/i.test(s.id)) ?? null;
  }
  const seatParamKey = (obj) => (obj ? SEAT_PARAMS.find((k) => byType(obj.type).params.some((p) => p.key === k)) ?? null : null);
  /**
   * What the figure sits on and how it rests: { sitting, objectId, objectName, supportId, seatHeight (surface at its centre), seatGap (m: the lowest seat contact above (+) or inside (-) the seat surface),
   * feetGap (m: the lowest foot point above (+) or below (-) the floor), gaps (the editor's carrier gaps), onSeat (sit bones inside the surface), messages, param: { key, value, min, max } }.
   */
  function seatReport() {
    const r = rig(), pl = editor.place, sitting = pl.mode === "seat" && Object.values(pl.carriers).includes("seat");
    const out = { sitting, objectId: null, objectName: null, supportId: null, seatHeight: null, seatGap: null, feetGap: null, gaps: {}, onSeat: null, messages: [], param: null };
    try { out.gaps = editor.info().gaps; } catch { /* no info */ }
    try { const f = r.contactPoints("feet"); if (f.length) out.feetGap = Math.min(...f.map((p) => p.y)); } catch { /* a body without a feet set */ }
    if (!sitting) { out.messages.push("The figure is not sitting."); return out; }
    const seat = pl.seat;
    if (seat.kind === "object") {
      const obj = objectOf(seat.objectId), sup = supportOf(seat.objectId, seat.supportId);
      if (obj && sup) {
        Object.assign(out, { objectId: obj.id, objectName: obj.name, supportId: sup.id, seatHeight: sup.y });
        const pts = r.contactPoints("seat");
        out.seatGap = Math.min(...pts.map((p) => p.y - planeHeightAt(sup, obj.yaw, p.x, p.z)));
        const ischial = ["ischial_L", "ischial_R"].map((id) => r.landmarkWorld(id));
        out.onSeat = ischial.every((p) => pointInPolygon(p.x, p.z, sup.polygon));
        const key = seatParamKey(obj);
        if (key) { const ps = byType(obj.type).params.find((p) => p.key === key); out.param = { key, label: ps.label, value: obj.params[key], min: ps.min, max: ps.max }; }
        out.messages.push(seatSentence(out.seatGap));
        if (!out.onSeat) out.messages.push("The sit bones are not over the seat surface.");
      }
    } else out.seatHeight = editor.seatHeight();
    out.messages.push(feetSentence(out.feetGap));
    out.messages = out.messages.filter(Boolean);
    return out;
  }
  /** Shift the figure along the seat's forward axis so that its buttock extremity touches the back-rest plane (seats with a seat reference point). */
  function alignToBack(objectId) {
    const obj = objectOf(objectId), srp = sandbox.anchorWorld(objectId, "srp", new THREE.Vector3());
    if (!obj || !srp) return false;
    const r = rig(), b = r.landmarkWorld("buttock_extremity"), [fx, fz] = forwardOf(obj.yaw);
    const s = (srp.x * fx + srp.z * fz + BACK_ALIGN) - (b.x * fx + b.z * fz);
    if (Math.abs(s) < 5e-4) return false;
    const a = editor.place.anchor;
    editor.setAnchor({ x: a.x + fx * s, z: a.z + fz * s });
    return true;
  }
  /**
   * Sit on a seat of the scene: the figure takes `posture` (a library id; default: the posture it has when that sits, else sit-upright-90), turns to the seat's yaw, and sits with the sit
   * bones on the seat surface and the buttocks at the back-rest plane (a seat with a reference point) or the seat contacts at the middle of the surface. The seat height is NOT changed:
   * the report says how far the feet are from the floor. One undo step. The editor then keeps the figure on the seat when the seat is moved, turned or adjusted.
   */
  function sitOn(objectId, { supportId = null, posture = null, face = true } = {}) {
    const obj = objectOf(objectId);
    if (!obj) return fail("Select a seat in the scene first.");
    const sup = supportOf(objectId, supportId);
    const surf = editor.seatSurfaces().find((s) => s.objectId === objectId && (!supportId || s.id === supportId));
    if (!sup || !surf) return fail(`${obj.name} has no surface to sit on.`);
    const g = editor.beginGesture(`Sit on ${obj.name}`);
    let res;
    try {
      const seated = Object.values(editor.place.carriers).includes("seat") && editor.place.mode !== "floor";
      const id = posture && posture !== "current" ? posture : seated ? null : DEFAULT_SEATED;
      if (id) editor.apply(id, { animate: false });
      editor.sitOn(objectId, surf.id, { face });
      alignToBack(objectId);
      res = seatReport();
    } catch (e) { g.end(); return fail(`Could not sit on ${obj.name}: ${e.message}`); } finally { g.end(); }
    emit();
    return { ok: true, report: res, headline: `Sitting on ${obj.name}.`, message: `Sitting on ${obj.name}. ${res.messages.join(" ")}`.trim() };
  }
  /** The seat height (surface at its centre) that puts the lowest seat contact of the CURRENT pose at `level` metres. */
  function setSeatSurface(objectId, level, what) {
    const obj = objectOf(objectId);
    if (!obj) return fail("Select a seat in the scene first.");
    const key = seatParamKey(obj), sup = supportOf(objectId);
    if (!key || !sup) return fail(`The height of ${obj.name} cannot be adjusted.`);
    const ps = byType(obj.type).params.find((p) => p.key === key), want = obj.params[key] + (level - sup.y);
    const next = normalizeParams(obj.type, { ...obj.params, [key]: want })[key];
    const clamped = Math.abs(next - want) > 1e-6;
    if (Math.abs(next - obj.params[key]) > 1e-9) {
      sandbox.setParam(objectId, key, next);
      editor.commit("Adjust the seat height"); // the figure followed the seat (editor.syncChair); this keeps the editor's history in step with it
    }
    const report = seatReport();
    const pname = ps.label.split(" (")[0].toLowerCase();
    const msg = clamped ? `The ${pname} of ${obj.name} can only go ${next < want ? "up" : "down"} to ${fmtMm(next)}, ${fmtMm(Math.abs(want - next))} short of what ${what} needs.` : `The ${pname} of ${obj.name} is now ${fmtMm(next)}.`;
    emit();
    return { ok: true, clamped, param: key, from: obj.params[key], to: next, wanted: want, report, headline: msg, message: `${msg} ${report.messages.join(" ")}`.trim() };
  }
  /** Set the seat height so that this body's popliteal rule holds (pose.js seatHeightFor: the ISO 7250-1 posture rests its soles on the floor). */
  function adjustSeatToBody(objectId = editor.place.seat.objectId) {
    const r = rig();
    return setSeatSurface(objectId, seatHeightFor(bodyOf(r), "popliteal"), "this body");
  }
  /** Set the seat height so that the feet of the CURRENT posture touch the floor. */
  function adjustSeatToFeet(objectId = editor.place.seat.objectId) {
    const r = rig(), pose = r.getPose(), body = bodyOf(r);
    const d = placePoseDetailed(body, pose, { carriers: { feet: "floor" } });
    const rows = contactClearances(body, pose, { ...pose.root, y: d.root.y }, { floor: 0, seat: 0 }, { seat: "seat" });
    return setSeatSurface(objectId, Math.min(...rows.map((x) => x.clearance)), "these feet");
  }

  // ---- grab with IK ------------------------------------------------------------------------------------------------------------------
  const FOOT_PINS = (s) => [`heel_sole_${s}`, `ball_sole_medial_${s}`, `ball_sole_lateral_${s}`];
  /**
   * Close the hands on grips of an object. opts: { hand: "L" | "R" | "both", gripId, assignments: [{ side, gripId }] (explicit), freeTrunk, freePelvis, preset (close the fingers: default true), label }.
   * The feet stay where they are. Free: the arm and clavicle of each hand used; the trunk with freeTrunk; the pelvis and legs with freePelvis (standing only). The pose is applied even
   * when a grip cannot be reached (the closest pose), with the shortfall in the result. One undo step. Returns { ok, reachable, hands: [{ side, gripId, label, errorMm, rotDeg, reachable,
   * target }], worstMm, messages, canFreeTrunk, canMove, ... }.
   */
  function grab({ objectId = selectedObject()?.id, hand = "both", gripId = null, assignments = null, freeTrunk = false, freePelvis = false, preset = true, label } = {}) {
    const obj = objectOf(objectId);
    if (!obj) return fail("Select an object with grips (a steering wheel, a rifle, a handle) first.");
    const grips = sandbox.gripsWorld(objectId);
    if (!grips.length) return fail(`${obj.name} has no grips to hold.`);
    let plan;
    if (assignments) {
      plan = { assignments: [], skipped: [] };
      for (const a of assignments) { const g = grips.find((x) => x.id === a.gripId); if (g) plan.assignments.push({ side: a.side, grip: g }); else plan.skipped.push({ side: a.side, why: `The object has no grip "${a.gripId}".` }); }
    } else plan = assignGrips(grips, hand, gripId);
    if (!plan.assignments.length) return fail(plan.skipped[0]?.why ?? "There is no grip to hold.");
    const r = rig(), sv = solver(), start = r.getPose(), notes = plan.skipped.map((s) => s.why);
    for (const a of plan.assignments) if ((a.grip.hand === "L" || a.grip.hand === "R") && a.grip.hand !== a.side) notes.push(`${a.grip.label} is made for the ${SIDE_WORD[a.grip.hand]} hand; the ${SIDE_WORD[a.side]} hand takes it here.`);
    const goals = plan.assignments.map(({ side, grip }) => ik.handFrameFromGrip(ikGrip(grip), side));
    const standing = editor.place.mode === "floor";
    const pins = ik.pinGoals(sv, start, [...FOOT_PINS("L"), ...FOOT_PINS("R")]);
    const free = [];
    for (const { side } of plan.assignments) free.push(`arm_${side}`, `clavicle_${side}`);
    if (freeTrunk) free.push("trunk");
    const pelvisFree = freePelvis && standing;
    if (freePelvis && !standing) notes.push("The pelvis stays where the seat or the support holds it.");
    if (pelvisFree) free.push("legs", "pelvis-xyz", "pelvis-tilt");
    const res = sv.solve(start, [...goals, ...pins], { free, reference: start });
    const g = editor.beginGesture(label ?? `Hold ${obj.name}`);
    try {
      editor.setPose({ root: res.pose.root, angles: res.pose.angles }, { clamp: true, label: label ?? `Hold ${obj.name}` });
      if (preset) for (const { side, grip } of plan.assignments) { try { editor.setGrip(side, gripPreset(grip, obj.type)); } catch { /* an unknown preset */ } }
    } finally { g.end(); }
    // what the figure shows now, not what the solver thought
    const hands = plan.assignments.map(({ side, grip }) => {
      const p = r.landmarkWorld(`grip_centre_${side}`, new THREE.Vector3()), err = p.distanceTo(grip.position);
      const rot = (res.error[`hand_${side}.rot`] ?? 0) * R2D;
      return { side, gripId: grip.id, label: grip.label, errorMm: mm(err), rotDeg: rot, reachable: err <= 0.001 && rot <= 2, target: grip.position.toArray(), reached: p.toArray() };
    });
    const worstMm = Math.max(...hands.map((x) => x.errorMm));
    const reachable = hands.every((x) => x.reachable);
    const lines = reachable ? [] : ik.describeResult(res, (id) => (id.startsWith("hand_") ? `The ${SIDE_WORD[id[5]]} hand${id.endsWith(".rot") ? " (orientation)" : ""}` : ik.goalLabel(id)));
    const messages = [...notes, ...(reachable ? [] : lines.length ? lines : hands.filter((x) => !x.reachable).map((x) => `The ${SIDE_WORD[x.side]} hand is ${fmtMm(x.errorMm / 1000)} from ${x.label}.`))];
    S.last = { objectId, hand, gripId, assignments, freeTrunk, freePelvis, preset, sides: plan.assignments.map((a) => a.side) };
    emit();
    const who = hands.length === 2 ? "Both hands hold" : `The ${SIDE_WORD[hands[0].side]} hand holds`;
    const text = reachable ? `${obj.name}: ${who} ${hands.map((x) => `"${x.label}"`).join(" and ")} (within ${fmtMm(worstMm / 1000)}).` : `${obj.name} is out of reach: ${fmtMm(worstMm / 1000)} short.`;
    return { ok: true, reachable, hands, worstMm, messages, message: [text, ...messages].join(" "), canFreeTrunk: !reachable && !freeTrunk, canMove: !reachable && !obj.locked && !obj.attachedTo, freeTrunk, ms: res.ms };
  }
  /** Grab again with the trunk free (the button of an unreachable grab). */
  function grabFreeTrunk() { return S.last ? grab({ ...S.last, freeTrunk: true }) : fail("Grab something first."); }
  /**
   * Move the grabbed object to where the hands can reach it: the object moves by the shortfall of the hands (the closest pose they found) and the grab is repeated, up to 4 times.
   * The object moves through the sandbox (its own undo step). Returns the last grab with `moved: [dx, dy, dz]` (metres).
   */
  function moveWithinReach() {
    const last = S.last, obj = objectOf(last?.objectId);
    if (!last || !obj) return fail("Grab something first.");
    if (obj.locked) return fail(`${obj.name} is locked. Unlock it to move it.`);
    if (obj.attachedTo) return fail(`${obj.name} is attached to the hand. Detach it to move it.`);
    const total = [0, 0, 0];
    let res = null;
    const g = editor.beginGesture(`Move ${obj.name} within reach`);
    try {
      sandbox.grouped(`Move ${obj.name} within reach`, () => {
        for (let i = 0; i < 4; i++) {
          res = grab({ ...last, label: `Hold ${obj.name}` });
          if (!res.ok || res.reachable) break;
          const bad = res.hands.filter((x) => !x.reachable);
          const d = [0, 1, 2].map((k) => bad.reduce((a, x) => a + (x.reached[k] - x.target[k]), 0) / bad.length);
          if (Math.hypot(...d) < 2e-4) break;
          const o = objectOf(obj.id);
          if (!sandbox.move(obj.id, { x: o.position[0] + d[0], y: o.position[1] + d[1], z: o.position[2] + d[2] }, { snap: false, label: `Move ${obj.name} within reach` })) break;
          for (let k = 0; k < 3; k++) total[k] += d[k];
        }
        if (res?.ok && !res.reachable) res = grab({ ...last });
      });
    } finally { g.end(); }
    if (!res) return fail("Nothing was moved.");
    const d = Math.hypot(...total);
    return { ...res, moved: total, message: `${obj.name} moved ${fmtMm(d)} toward the figure. ${res.message}` };
  }
  /** Attach the object to a hand (it follows the hand; sandbox.attach) or detach it. `side` defaults to the hand of the last grab. */
  function toggleAttach(objectId = selectedObject()?.id, side = null) {
    const o = objectOf(objectId);
    if (!o) return fail("Select an object first.");
    if (o.attachedTo) { sandbox.detach(objectId); emit(); return { ok: true, attached: false, message: `${o.name} is no longer attached.` }; }
    side ??= S.last?.objectId === objectId ? S.last.sides?.[0] : null;
    side ??= "R";
    const lm = `grip_centre_${side}`, p = rig().landmarkWorld(lm, new THREE.Vector3());
    const ok = sandbox.attach(objectId, { kind: "landmark", id: lm }, [o.position[0] - p.x, o.position[1] - p.y, o.position[2] - p.z]);
    emit();
    return ok ? { ok: true, attached: true, side, message: `${o.name} now follows the ${SIDE_WORD[side]} hand.` } : fail(`${o.name} could not be attached.`);
  }

  // ---- the prop of a posture ------------------------------------------------------------------------------------------------------------
  /** The prop of the posture on the figure: { posture: { id, name }, prop } or null. */
  function postureProp() {
    const base = editor.base;
    if (!base.id) return null;
    const p = editor.getPosture(base.id), prop = propOf(p);
    return prop ? { posture: { id: base.id, name: base.name }, prop } : null;
  }
  function propPlacement(prop, r) {
    const spec = byType(prop.type), params = normalizeParams(prop.type, prop.params), locals = spec.grips(params);
    const named = SIDES.filter((s) => prop.grips[s]);
    if (named.length) {
      const L = named.map((s) => locals.find((g) => g.id === prop.grips[s]).position), T = named.map((s) => r.landmarkWorld(`grip_centre_${s}`).toArray());
      const fit = fitYaw(L, T);
      const y = fit.t[1] < 0.06 ? 0 : fit.t[1]; // a prop whose height is a parameter has its origin on the floor; a hand tool is lifted to the hand
      return { position: [fit.t[0], y, fit.t[2]], yaw: fit.yaw, how: "its grips on the hands of the posture" };
    }
    const root = r.root, hd = root.heading, [fx, fz] = forwardOf(hd), [lx, lz] = [fz, -fx];
    const foot = ["L", "R"].map((s) => r.landmarkWorld(`ball_sole_medial_${s}`)), mid = foot[0].clone().add(foot[1]).multiplyScalar(0.5);
    const box = new THREE.Box3().makeEmpty();
    for (const id of ["heel_sole_L", "heel_sole_R", "toe_sole_L", "toe_sole_R"]) box.expandByPoint(r.landmarkWorld(id));
    const model = spec.build(params), bb = model.userData.bbox.clone(), bc = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    disposeObject(model);
    if (prop.role === "held") {
      const hands = SIDES.filter((s) => { const g = editor.gripOf(s); return g !== "relaxed" && g !== "open" && g !== null; });
      const use = hands.length ? hands : SIDES, pts = use.map((s) => r.landmarkWorld(`palm_centre_${s}`)), c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      const cy = Math.cos(hd * D2R), sy = Math.sin(hd * D2R), off = [bc.x * cy + bc.z * sy, bc.y, -bc.x * sy + bc.z * cy];
      return { position: [c.x - off[0], Math.max(0, c.y - off[1]), c.z - off[2]], yaw: hd, how: "between the hands" };
    }
    const info = parsePropNote(prop.note), dir = info.direction;
    const depth = (dir === "left" || dir === "right" ? size.x : size.z) / 2;
    const gap = info.distance ?? 0.3;
    // direction in the world: front = figure's forward, behind = -forward, left = +left, right = -left
    const d = dir === "front" ? [fx, fz] : dir === "behind" ? [-fx, -fz] : dir === "left" ? [lx, lz] : [-lx, -lz];
    const reach = Math.max(...[box.min, box.max].flatMap((p) => [Math.abs((p.x - mid.x) * d[0] + (p.z - mid.z) * d[1])]));
    const centre = [mid.x + d[0] * (reach + gap + depth), mid.z + d[1] * (reach + gap + depth)];
    const yaw = normalizeYaw(Math.atan2(-d[0], -d[1]) * R2D); // the object's front (+Z) faces the figure
    const cy = Math.cos(yaw * D2R), sy = Math.sin(yaw * D2R);
    return { position: [centre[0] - (bc.x * cy + bc.z * sy), 0, centre[1] - (-bc.x * sy + bc.z * cy)], yaw, how: `${dir === "front" ? "in front of" : dir === "behind" ? "behind" : `on the figure's ${dir} of`} the figure` };
  }
  /**
   * Create the object the current library posture uses (hints.prop) where the posture needs it: the grips on the hands (held props and supports with grips), between the hands (held,
   * no grips), or beside the figure as the note says (supports). Then close the hands on the named grips. The object is one undo step of the sandbox; the hands one of the editor's.
   */
  function addPostureProp() {
    const pp = postureProp();
    if (!pp) return fail("The posture on the figure does not use an object.");
    const r = rig(), { prop } = pp;
    let placement;
    try { placement = propPlacement(prop, r); } catch (e) { return fail(`Could not place ${prop.name}: ${e.message}`); }
    let obj = null;
    sandbox.grouped(`Add ${prop.name} for ${pp.posture.name}`, () => {
      obj = sandbox.add(prop.type, { params: prop.params, position: placement.position, yaw: placement.yaw, name: prop.name, select: true });
    });
    if (!obj) return fail("The scene is full.");
    let grabbed = null;
    const sides = SIDES.filter((s) => prop.grips[s]);
    if (sides.length) {
      const assignments = sides.map((s) => ({ side: s, gripId: prop.grips[s] }));
      grabbed = grab({ objectId: obj.id, assignments, label: `Hold ${prop.name}` });
      if (grabbed.ok && !grabbed.reachable) grabbed = grab({ objectId: obj.id, assignments, freeTrunk: true, label: `Hold ${prop.name}` });
    }
    emit();
    const tail = grabbed ? (grabbed.reachable ? ` The hands hold it (within ${fmtMm(grabbed.worstMm / 1000)}).` : ` ${grabbed.message}`) : "";
    return { ok: true, object: obj, role: prop.role, placed: placement.how, grab: grabbed, message: `Added ${prop.name} (${prop.role === "held" ? "held" : "support"}) ${placement.how}.${tail}` };
  }

  // ---- reach ---------------------------------------------------------------------------------------------------------------------------------
  /** Straight-arm length of a side (shoulder to elbow to wrist to grip centre), metres. */
  function armLength(side) {
    const r = rig(), p = (id) => r.jointWorld(id, new THREE.Vector3());
    return p(`shoulder_${side}`).distanceTo(p(`elbow_${side}`)) + p(`elbow_${side}`).distanceTo(p(`wrist_${side}`)) + p(`wrist_${side}`).distanceTo(r.landmarkWorld(`grip_centre_${side}`));
  }
  /** Points the reach check can aim at: [{ key, label, points: { L: [x, y, z], R: [x, y, z] } }] for the selected object (its grips, else its middle) and the selected measurement. */
  function reachTargets() {
    const out = [], o = selectedObject();
    if (o) {
      const grips = sandbox.gripsWorld(o.id), centre = sandbox.localToWorld(o.id, o.bbox.getCenter(new THREE.Vector3()).toArray());
      const near = (side) => {
        const own = grips.filter((g) => g.hand === side || g.hand === "both");
        if (!own.length) return centre?.toArray() ?? null;
        const c = rig().landmarkWorld(`grip_centre_${side}`);
        return own.reduce((a, g) => (g.position.distanceTo(c) < a.position.distanceTo(c) ? g : a)).position.toArray();
      };
      out.push({ key: `object:${o.id}`, label: `${o.name}${grips.length ? " (its grips)" : " (its middle)"}`, points: { L: near("L"), R: near("R") } });
    }
    const m = peekMeasure(ctx);
    if (m?.items?.length) {
      const item = m.items.find((i) => i.id === m.selected) ?? m.items[m.items.length - 1];
      for (const k of ["a", "b", "c"]) {
        const ref = item[k];
        if (!ref || ref.kind === "joint" || ref.kind === "landmark") continue;
        const res = m.resolve(ref);
        if (res?.ok) { out.push({ key: `measure:${item.id}`, label: `Measurement point: ${item.label}`, points: { L: res.p.toArray(), R: res.p.toArray() } }); break; }
      }
    }
    return out;
  }
  /**
   * Can each hand reach a point from where the figure stands? For each side: the arm and clavicle only, then (if that fails) with the trunk leaning. Returns
   * { L: { reachable, withTrunk, shortMm, shortTrunkMm, distance, armLength, fraction, message }, R: ... }. `points` is { L: [x, y, z], R: [x, y, z] } or one [x, y, z].
   */
  function reachCheck(points, { sides = SIDES } = {}) {
    const r = rig(), sv = solver(), start = r.getPose(), out = {};
    for (const s of sides) {
      const t = Array.isArray(points) ? points : points?.[s];
      if (!Array.isArray(t) || t.length !== 3 || !t.every(fin)) { out[s] = { reachable: false, message: `The ${SIDE_WORD[s]} hand has no point to reach.` }; continue; }
      const sh = r.jointWorld(`shoulder_${s}`, new THREE.Vector3()), dist = sh.distanceTo(_w.set(t[0], t[1], t[2])), len = armLength(s);
      const a = ik.reachHand(sv, start, s, t);
      const row = { reachable: a.reachable, withTrunk: a.reachable, shortMm: a.reachable ? 0 : mm(a.error[`hand_${s}`] ?? 0), shortTrunkMm: 0, distance: dist, armLength: len, fraction: dist / len, target: t };
      if (!a.reachable) {
        const b = ik.reachHand(sv, start, s, t, { trunk: true });
        row.withTrunk = b.reachable;
        row.shortTrunkMm = b.reachable ? 0 : mm(b.error[`hand_${s}`] ?? 0);
      }
      const w = SIDE_WORD[s][0].toUpperCase() + SIDE_WORD[s].slice(1), pc = f0(row.fraction * 100);
      row.message = row.reachable ? `${w} hand: reaches it with the arm (${f0(mm(dist))} mm from the shoulder, ${pc} % of the straight arm).`
        : row.withTrunk ? `${w} hand: only with the trunk leaning (the arm alone is ${fmtMm(row.shortMm / 1000)} short; ${pc} % of the straight arm).`
          : `${w} hand: cannot reach it, ${fmtMm(row.shortTrunkMm / 1000)} short even with the trunk leaning (${pc} % of the straight arm).`;
      out[s] = row;
    }
    return out;
  }

  // ---- the reach envelope in the 3D view ----------------------------------------------------------------------------------------------
  const themeColor = (side) => (side === "L" ? viewport.theme?.accent : viewport.theme?.good) ?? new THREE.Color(side === "L" ? 0x2a78d6 : 0x0f7a2e);
  function disposeGroup(grp) {
    grp.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    grp.parent?.remove(grp);
  }
  function clearEnvelope() {
    S.env.cancel?.(); S.env.cancel = null;
    for (const g of S.env.groups) disposeGroup(g);
    S.env.groups = []; S.env.origin = {};
    viewport.requestRender?.();
  }
  /** The reach envelope of a side: random in-range poses of the arm and clavicle (forward kinematics, no IK): { points: Float32Array, bounds, maxDistance, hull, origin }. */
  function envelope(side, samples = ENVELOPE_SAMPLES) {
    return ik.reachEnvelope(solver(), rig().getPose(), side, { samples, seed: 1, hull: true });
  }
  function buildEnvelope() {
    S.env.cancel = null;
    if (disposed || !S.env.on) return;
    const r = ctx.getRig();
    if (!r) return;
    clearEnvelope();
    S.env.rig = r;
    for (const s of SIDES) {
      let env;
      try { env = envelope(s); } catch (e) { console.warn("placer: reach envelope failed:", e); continue; }
      const grp = new THREE.Group();
      grp.name = `hm-reach-envelope-${s}`;
      grp.userData.noPick = true;
      const col = themeColor(s);
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(env.points), 3));
      const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color: col, size: 0.014, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false }));
      pts.raycast = () => {}; pts.renderOrder = 8; pts.name = "points";
      grp.add(pts);
      if (env.hull?.faces?.length) {
        const hg = new THREE.BufferGeometry();
        hg.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(env.hull.vertices), 3));
        hg.setIndex(new THREE.BufferAttribute(Uint32Array.from(env.hull.faces), 1));
        const mesh = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
        mesh.raycast = () => {}; mesh.renderOrder = 7; mesh.name = "shell";
        grp.add(mesh);
      }
      grp.userData.side = s;
      grp.userData.count = env.count;
      grp.userData.maxDistance = env.maxDistance;
      S.env.origin[s] = r.jointWorld(`shoulder_${s}`, new THREE.Vector3());
      viewport.add?.(grp);
      S.env.groups.push(grp);
    }
    viewport.requestRender?.();
    emit("envelope");
  }
  /** Show or hide the reach envelope: a translucent point cloud and shell around each shoulder (1,200 random poses of the arm and clavicle, from where the trunk is now). */
  function showEnvelope(on) {
    on = !!on;
    S.env.on = on;
    if (!on) { clearEnvelope(); emit(); return false; }
    buildEnvelope();
    emit();
    return true;
  }
  // The cloud follows the shoulder at once when the figure moves and is recomputed when it has been still for a moment.
  function onPose() {
    if (!S.env.on || disposed) return;
    const r = ctx.getRig();
    if (r && S.env.groups.length && S.env.rig === r) for (const g of S.env.groups) { const o = S.env.origin[g.userData.side]; if (o) g.position.copy(r.jointWorld(`shoulder_${g.userData.side}`, _v)).sub(o); }
    viewport.requestRender?.();
    S.env.cancel?.();
    S.env.cancel = later(buildEnvelope, IDLE_MS);
  }

  // ---- line of sight ------------------------------------------------------------------------------------------------------------------------
  function displayTarget(objectId) {
    const o = objectOf(objectId);
    if (!o) return null;
    const anchor = DISPLAY_ANCHORS.find((a) => Object.hasOwn(o._anchors ?? {}, a));
    if (anchor) return { id: o.id, anchor, point: sandbox.anchorWorld(o.id, anchor, new THREE.Vector3()), name: o.name };
    const c = sandbox.localToWorld(o.id, o.bbox.getCenter(new THREE.Vector3()).toArray());
    return c ? { id: o.id, anchor: null, point: c, name: o.name } : null;
  }
  /** Viewing numbers from the eye point to a display: { distance, declination, visualH, visualV, incidence, zone } (measure.js viewInfo), or null. */
  function viewOf(objectId) {
    const t = displayTarget(objectId);
    if (!t) return null;
    const eye = rig().landmarkWorld("eye_mid", new THREE.Vector3()), base = t.anchor !== null && Object.hasOwn(EDGE_BASE, t.anchor) ? EDGE_BASE[t.anchor] : undefined, edges = {};
    if (base !== undefined) for (const k of ["left", "right", "top", "bottom"]) { const p = sandbox.anchorWorld(t.id, `${base}${k}_edge`, new THREE.Vector3()); if (p) edges[k] = p; }
    const normal = t.anchor ? sandbox.anchorNormalWorld(t.id, t.anchor, new THREE.Vector3()) : null;
    return { target: t, ...viewInfo(eye, t.point, { ...edges, normal }) };
  }
  /** Turn the head, neck and eyes to the middle of a display (ik.js lookAt through the editor: one undo step), then read the viewing numbers. */
  function lookAtObject(objectId = selectedObject()?.id) {
    const t = displayTarget(objectId);
    if (!t) return fail("Select a display (or any object) in the scene first.");
    const st = editor.lookAtPoint(t.point.toArray(), { record: true });
    if (!st) return fail("The gaze solver is not ready yet.");
    const view = viewOf(objectId);
    emit();
    const gaze = st.reachable ? "The eyes are on it." : `The eyes stop ${st.short || "short"} of it.`;
    return { ok: true, reachable: st.reachable, status: st, view, message: `Looking at ${t.name}. ${gaze}` };
  }
  /** Add a viewing check (measure.js "view": eye point to the display centre, with the visual angle) to the Measure tab's list. Returns the item or null. */
  function addViewMeasurement(objectId = selectedObject()?.id) {
    const t = displayTarget(objectId);
    if (!t?.anchor) return null;
    const m = measureFor(ctx);
    const have = m.items.find((i) => i.kind === "view" && i.b.kind === "object" && i.b.id === t.id && i.b.anchor === t.anchor && i.a.kind === "landmark" && i.a.id === "eye_mid");
    return have ?? m.addView({ kind: "object", id: t.id, anchor: t.anchor }, { kind: "landmark", id: "eye_mid" }, { label: `View of ${t.name}` });
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------------
  const wire = (evt, fn) => { const off = ctx.on?.(evt, fn); if (typeof off === "function") offs.push(off); };
  wire("pose", onPose);
  wire("rig", () => { S.solver = null; S.solverRig = null; if (S.env.on) { S.env.cancel?.(); S.env.cancel = later(buildEnvelope, 0); } emit("rig"); });
  wire("selection", () => emit("selection"));
  wire("scene", () => emit("scene"));
  wire("measure", () => emit("measure"));
  wire("theme", () => { for (const g of S.env.groups) { const c = themeColor(g.userData.side); g.traverse((o) => o.material?.color?.copy(c)); } viewport.requestRender?.(); });
  const offEditor = editor.on?.("change", () => emit("editor"));
  if (typeof offEditor === "function") offs.push(offEditor);

  function dispose() {
    if (disposed) return;
    disposed = true;
    setFloorDrag(false);
    S.env.on = false;
    clearEnvelope();
    for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
    listeners.clear();
    try { onDispose?.(); } catch { /* gone */ }
  }

  return {
    get disposed() { return disposed; },
    get last() { return S.last; },
    get floorDrag() { return S.floorDragOn; },
    get envelopeOn() { return S.env.on; },
    get envelopeGroups() { return S.env.groups; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    selectedObject, seats, gripObjects, displays, spot,
    standAt, faceObject, setFloorDrag,
    sitOn, seatReport, adjustSeatToBody, adjustSeatToFeet,
    grab, grabFreeTrunk, moveWithinReach, toggleAttach,
    postureProp, addPostureProp,
    armLength, reachTargets, reachCheck, envelope, showEnvelope,
    displayTarget, viewOf, lookAtObject, addViewMeasurement,
    dispose,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// one placer per viewport, like the sandbox and the editor
const registry = new WeakMap();
/** The placer of a ctx's viewport (created with the editor, the sandbox and the modules it needs; async because ik.js and the editor are loaded on demand). Pair with releasePlace(). */
export async function placeFor(ctx) {
  const vp = ctx.viewport;
  let p = registry.get(vp);
  if (p && !p.disposed) return p;
  const [ed, ik, metrics] = await Promise.all([import("./editor.js"), import("./ik.js"), import("./metrics.js").catch(() => null)]);
  p = registry.get(vp);
  if (p && !p.disposed) return p;
  const editor = ed.editorFor(ctx), sandbox = sandboxFor(ctx);
  await editor.ready;
  p = createPlacer({ ctx, sandbox, editor, ik, metrics, onDispose: () => { if (registry.get(vp) === p) registry.delete(vp); } });
  registry.set(vp, p);
  return p;
}
export const peekPlace = (vpOrCtx) => registry.get(vpOrCtx?.viewport ?? vpOrCtx) ?? null;
/** Count a user of the shared placer (acquirePlace is placeFor plus a count); the last releasePlace disposes it. */
export async function acquirePlace(ctx) { const p = await placeFor(ctx); p.refs = (p.refs ?? 0) + 1; return p; }
export function releasePlace(ctx) { const p = peekPlace(ctx); if (p && (p.refs = (p.refs ?? 1) - 1) <= 0) p.dispose(); }

// ---------------------------------------------------------------------------------------------------------------------
// the controls (DOM). Styles: site/human-analysis.css (prefix hm-pl-).
const CSS_URL = new URL("../../human-analysis.css", import.meta.url).href;
/** Inject site/human-analysis.css once and wait (briefly) for it; resolves whether or not it loaded (the controls still work, only plainer). Shared with panels/analysis.js. */
export function ensureAnalysisStyles() {
  let link = document.querySelector("link[data-hm-analysis-css]");
  if (link?.dataset.hmFailed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-analysis-css": "" });
    link.onerror = () => { link.dataset.hmFailed = "1"; };
    document.head.append(link);
  }
  return new Promise((resolve) => {
    if (link.sheet || link.dataset.hmFailed) return resolve();
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  });
}

const sideLabel = { L: "Left", R: "Right", both: "Both" };

/**
 * Draw the "Place the human" controls into `container` (sandbox.placeContainer: the Scene panel's section). Returns { ready (a promise: the engine is loaded), dispose(), get placer }.
 * The controls work on the figure and the sandbox of ctx's viewport; dispose() removes every listener, the reach envelope and the drag mode.
 */
export function mountPlace(container, ctx) {
  if (!container) throw new TypeError("mountPlace: a container element is required");
  const offs = [];
  let placer = null, disposed = false, frame = 0;
  const sb = acquireSandbox(ctx);
  const id = { x: nextId("hm-pl-x"), z: nextId("hm-pl-z"), hd: nextId("hm-pl-hd"), seat: nextId("hm-pl-seat"), posture: nextId("hm-pl-posture"), obj: nextId("hm-pl-obj"), grip: nextId("hm-pl-grip"), target: nextId("hm-pl-target"), disp: nextId("hm-pl-disp") };
  ensureAnalysisStyles();

  const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  const say = (t) => { live.textContent = ""; setTimeout(() => { if (!disposed) live.textContent = t; }, 30); };
  const unit = () => ctx.units ?? "mm";
  const num = (m) => fmtLength(mm(m), unit(), { suffix: false });
  const lenIn = (v) => fromUnit(v, unit()) / 1000;

  const btn = (label, onClick, { title, primary = false, small = true } = {}) => h("button", { type: "button", class: `btn${small ? " small" : ""}${primary ? " primary" : ""}`, title, onclick: onClick }, label);
  const field = (label, control, forId) => h("div", { class: "hm-pl-f" }, h("label", { for: forId }, label), control);
  const chosen = { seat: false, obj: false, disp: false }; // a list the user changed keeps its value until the selection in the scene changes
  const numberInput = (idv, onCommit, { step = 1, min, max } = {}) => {
    const el = h("input", { type: "number", class: "input hm-num", id: idv, step, min, max, inputmode: "decimal" });
    el.addEventListener("change", () => { const v = Number(el.value); if (el.value === "" || !Number.isFinite(v)) { refresh(); return; } onCommit(v); });
    return el;
  };
  const sec = (title, body, open = false) => h("details", { class: "hm-pl-sec", open: open ? true : null }, h("summary", {}, title), h("div", { class: "hm-pl-body" }, body));
  const out = () => h("div", { class: "hm-pl-out" });
  const showResult = (box, res, extra = []) => {
    box.replaceChildren();
    if (!res) return;
    const level = !res.ok ? "warn" : res.reachable === false ? "warn" : "info";
    box.append(notice(res.headline ?? res.message, { level }), ...extra);
    say(res.message);
  };
  const needs = (fn) => (...a) => { if (!placer) { say("The controls are still loading."); return; } try { return fn(...a); } catch (e) { console.error("place:", e); const m = `That did not work: ${String(e?.message ?? e).slice(0, 160)}`; say(m); ctx.toast?.(m); } };

  // ---- stand at ------------------------------------------------------------------------------------------------------------------------------
  const xIn = numberInput(id.x, needs((v) => apply({ x: lenIn(v) })), { step: unit() === "in" ? 0.5 : 10 });
  const zIn = numberInput(id.z, needs((v) => apply({ z: lenIn(v) })), { step: unit() === "in" ? 0.5 : 10 });
  const hdIn = numberInput(id.hd, needs((v) => apply({ heading: v })), { step: 5, min: -180, max: 180 });
  const standOut = out(), xLab = h("span", {}, "Across (x)"), zLab = h("span", {}, "Along (z)");
  function apply(p) { const r = placer.standAt(p); showResult(standOut, r); }
  const dragChip = chipButton({ label: "Drag the figure on the floor", toggle: true, title: "Press on the figure in the 3D view and drag it over the floor (objects in front of it are dragged first)", onClick: needs(() => { const on = placer.setFloorDrag(!placer.floorDrag); dragChip.setPressed(on); say(on ? "Drag the figure over the floor in the 3D view." : "Dragging the figure is off."); }) });
  const standSec = sec("Stand at a spot", [
    h("p", { class: "small muted" }, "Where the middle of the feet is on the floor, and which way the figure faces. A seated figure stands up first."),
    h("div", { class: "hm-pl-3" }, field(xLab, xIn, id.x), field(zLab, zIn, id.z), field("Heading (°)", hdIn, id.hd)),
    h("div", { class: "hm-pl-row" }, btn("Face the selected object", needs(() => showResult(standOut, placer.faceObject())), { title: "Turn the figure toward the object selected in the list above" }), dragChip),
    standOut,
  ], true);

  // ---- sit ----------------------------------------------------------------------------------------------------------------------------------------
  const seatSel = h("select", { class: "input", id: id.seat }), postureSel = h("select", { class: "input", id: id.posture });
  const sitOut = out(), sitFacts = h("ul", { class: "hm-pl-facts small" });
  const seatKey = () => seatSel.value.split("|");
  const sitBtn = btn("Sit on it", needs(() => { const [o, s] = seatKey(); showResult(sitOut, placer.sitOn(o, { supportId: s, posture: postureSel.value })); }), { primary: true, title: "Sit on the chosen seat, turned the way the seat faces, with the sit bones on its surface" });
  const bodyBtn = btn("Adjust seat height to this body", needs(() => { const [o] = seatKey(); showResult(sitOut, placer.adjustSeatToBody(o)); }), { title: "Set the seat height by the popliteal rule: the ISO 7250-1 posture (hips 90, knees 90) puts the soles on the floor" });
  const feetBtn = btn("Adjust seat to the feet", needs(() => { const [o] = seatKey(); showResult(sitOut, placer.adjustSeatToFeet(o)); }), { title: "Set the seat height so that the feet of the present posture touch the floor" });
  const sitSec = sec("Sit on the selected seat", [
    h("p", { class: "small muted" }, "Choose a chair, stool, bench or seat of the scene and a seated posture. The seat height is yours to set; the readout says how far the feet are from the floor."),
    field("Seat", seatSel, id.seat), field("Posture", postureSel, id.posture),
    h("div", { class: "hm-pl-row" }, sitBtn), h("div", { class: "hm-pl-row" }, bodyBtn, feetBtn),
    sitFacts, sitOut,
  ], true);

  // ---- grab ----------------------------------------------------------------------------------------------------------------------------------------------
  const objSel = h("select", { class: "input", id: id.obj }), gripSel = h("select", { class: "input", id: id.grip });
  const handSeg = segmented({ label: "Which hand", value: "both", options: [{ value: "L", label: "Left" }, { value: "R", label: "Right" }, { value: "both", label: "Both" }] });
  const trunkBox = h("input", { type: "checkbox", id: nextId("hm-pl-trunk") }), pelvisBox = h("input", { type: "checkbox", id: nextId("hm-pl-pelvis") });
  const grabOut = out();
  const attachChip = chipButton({ label: "Attach to hand", toggle: true, title: "The object follows the hand (the Scene tab's attach)", onClick: needs(() => { const r = placer.toggleAttach(objSel.value || undefined); attachChip.setPressed(!!r.attached); say(r.message); refresh(); }) });
  function grabNow(extra = {}) {
    const r = placer.grab({ objectId: objSel.value, hand: handSeg.get(), gripId: gripSel.value || null, freeTrunk: trunkBox.checked, freePelvis: pelvisBox.checked, ...extra });
    const more = [];
    if (r.ok && !r.reachable) {
      const row = h("div", { class: "hm-pl-row" });
      if (r.canMove) row.append(btn("Move the object within reach", needs(() => showResult(grabOut, placer.moveWithinReach(), [])), { title: "Move the object toward the figure by the shortfall and hold it again (undo in the Scene tab)" }));
      if (r.canFreeTrunk) row.append(btn("Free the trunk and try again", needs(() => { trunkBox.checked = true; grabNow({ freeTrunk: true }); }), { title: "Let the spine lean and turn to reach it" }));
      more.push(row);
    }
    showResult(grabOut, r, more);
    return r;
  }
  const grabBtn = btn("Grab with IK", needs(() => grabNow()), { primary: true, title: "Close the hand (or both hands) on the grip: the arm and shoulder are solved by inverse kinematics, the feet stay" });
  const grabSec = sec("Grab with the hands (IK)", [
    h("p", { class: "small muted" }, "The hands close on the grips of a control or tool; the feet stay where they are. If a grip is out of reach the closest pose is shown with the shortfall."),
    field("Object", objSel, id.obj), h("div", { class: "hm-pl-f" }, h("span", { class: "hm-pl-lab", id: nextId("hm-pl-hand") }, "Hand"), handSeg.el), field("Grip", gripSel, id.grip),
    h("label", { class: "hm-pl-check" }, trunkBox, " Free the trunk (it may lean and turn)"),
    h("label", { class: "hm-pl-check" }, pelvisBox, " Free the pelvis (standing; the feet stay)"),
    h("div", { class: "hm-pl-row" }, grabBtn, attachChip), grabOut,
  ]);

  // ---- the posture's prop ---------------------------------------------------------------------------------------------------------------------------------
  const propText = h("p", { class: "small" }), propOut = out();
  const propBtn = btn("Add the object this posture uses", needs(() => showResult(propOut, placer.addPostureProp())), { primary: true, title: "Create the object the posture of the figure was written for and place it at the hands" });
  const propSec = sec("Object of the posture", [propText, h("div", { class: "hm-pl-row" }, propBtn), propOut]);

  // ---- reach ------------------------------------------------------------------------------------------------------------------------------------------------
  const targetSel = h("select", { class: "input", id: id.target }), reachOut = h("ul", { class: "hm-pl-facts small" });
  const envChip = chipButton({ label: "Show the reach envelope", toggle: true, title: "A translucent cloud around each shoulder: where the hand can go with the arm alone (1,200 random poses within the ranges of motion)", onClick: needs(() => { const on = placer.showEnvelope(!placer.envelopeOn); envChip.setPressed(on); say(on ? "Reach envelopes shown." : "Reach envelopes hidden."); }) });
  const reachBtn = btn("Check reach", needs(() => {
    const t = placer.reachTargets().find((x) => x.key === targetSel.value);
    reachOut.replaceChildren();
    if (!t) { reachOut.append(h("li", {}, "Select an object, or a measurement with a point in space, to check.")); return; }
    const r = placer.reachCheck(t.points);
    for (const s of SIDES) reachOut.append(h("li", { "data-ok": r[s].reachable ? "1" : r[s].withTrunk ? "trunk" : "0" }, r[s].message));
    say(SIDES.map((s) => r[s].message).join(" "));
  }), { primary: true, title: "Can each hand reach the point from where the figure stands?" });
  const reachSec = sec("Reach check", [
    field("Target", targetSel, id.target), h("div", { class: "hm-pl-row" }, reachBtn, envChip), reachOut,
    h("p", { class: "small muted" }, "From the present stance, arm and shoulder only; if that fails, with the trunk leaning. A kinematic check on a simplified model: no strength, no comfort."),
  ]);

  // ---- line of sight ------------------------------------------------------------------------------------------------------------------------------------
  const dispSel = h("select", { class: "input", id: id.disp }), sightFacts = h("ul", { class: "hm-pl-facts small" }), sightOut = out();
  const lookBtn = btn("Look at the selected display", needs(() => { const r = placer.lookAtObject(dispSel.value || undefined); showResult(sightOut, r); refresh(); }), { primary: true, title: "Turn the head, neck and eyes to the middle of the display" });
  const viewBtn = btn("Add a viewing measurement", needs(() => {
    const it = placer.addViewMeasurement(dispSel.value || undefined);
    showResult(sightOut, it ? { ok: true, message: `"${it.label}" is in the Measure tab: eye to display, with the visual angle.` } : { ok: false, message: "Choose a display with a screen centre." });
  }), { title: "Add the viewing check (distance, angle below the horizontal, visual angle) to the Measure tab" });
  const sightSec = sec("Line of sight", [
    field("Display", dispSel, id.disp), h("div", { class: "hm-pl-row" }, lookBtn, viewBtn), sightFacts, sightOut,
    h("p", { class: "small muted" }, "Numbers are information: commonly cited guidance is a view distance of about 0.5 to 0.75 m with the screen centre 0 to 30 degrees below the horizontal."),
  ]);

  const root = h("div", { class: "hm-pl" }, standSec, sitSec, grabSec, propSec, reachSec, sightSec, live);
  container.append(root);

  // ---- keeping the controls in step with the figure and the scene -------------------------------------------------------------------------------------
  const sig = new Map();
  /** Replace the options of a select only when the list changed (the user's open list and focus stay). */
  function fillSelect(sel, items, keep = true) {
    const s = JSON.stringify(items.map((i) => [i.value, i.label, i.group ?? null]));
    if (sig.get(sel) === s) return false;
    sig.set(sel, s);
    const cur = sel.value;
    sel.replaceChildren();
    const groups = new Map();
    for (const it of items) {
      const o = h("option", { value: it.value }, it.label);
      if (it.group) { if (!groups.has(it.group)) { const g = h("optgroup", { label: it.group }); groups.set(it.group, g); sel.append(g); } groups.get(it.group).append(o); } else sel.append(o);
    }
    if (keep && items.some((i) => i.value === cur)) sel.value = cur;
    return true;
  }
  let seatedPostures = null;
  function postureItems() {
    const keep = { value: "current", label: "Keep the current posture" };
    return seatedPostures ? [keep, ...seatedPostures] : [keep];
  }
  function refresh() {
    frame = 0;
    if (disposed || !placer) return;
    try {
      const sel = placer.selectedObject();
      const spot = placer.spot();
      for (const [el, v] of [[xIn, num(spot.x)], [zIn, num(spot.z)], [hdIn, String(Math.round(spot.heading * 10) / 10)]]) if (document.activeElement !== el && el.value !== v) el.value = v;
      xLab.textContent = `Across x (${UNIT_LABEL[unit()]})`; zLab.textContent = `Along z (${UNIT_LABEL[unit()]})`;
      xIn.step = zIn.step = unit() === "in" ? "0.5" : unit() === "cm" ? "1" : "10";
      dragChip.setPressed(placer.floorDrag);
      // seats
      const seats = placer.seats();
      fillSelect(seatSel, seats.length ? seats.map((s) => ({ value: `${s.objectId}|${s.id}`, label: `${s.objectName}${s.id !== "seat" && s.id !== "seat_pan" ? `: ${s.name.split(": ").pop()}` : ""} (${Math.round(mm(s.y))} mm high)` })) : [{ value: "", label: "No seat in the scene: add a chair, stool or bench" }]);
      if (sel && !chosen.seat && seats.some((s) => s.objectId === sel.id)) { const want = seats.find((s) => s.objectId === sel.id); seatSel.value = `${want.objectId}|${want.id}`; }
      fillSelect(postureSel, postureItems());
      const haveSeat = seats.length > 0;
      for (const b of [sitBtn, bodyBtn, feetBtn]) b.disabled = !haveSeat;
      const rep = placer.seatReport();
      const facts = [];
      if (rep.sitting) {
        if (rep.objectName) facts.push(`Sitting on ${rep.objectName}${rep.seatHeight != null ? `, seat ${fmtLength(mm(rep.seatHeight), unit())} high` : ""}.`);
        facts.push(...rep.messages);
      } else facts.push("The figure is not on a seat.");
      const fs = JSON.stringify(facts);
      if (sitFacts.dataset.s !== fs) { sitFacts.dataset.s = fs; sitFacts.replaceChildren(...facts.map((t) => h("li", {}, t))); }
      // grips
      const objs = placer.gripObjects();
      fillSelect(objSel, objs.length ? objs.map((o) => ({ value: o.id, label: o.name })) : [{ value: "", label: "No object with grips: add a steering wheel, rifle or handle" }]);
      if (sel && !chosen.obj && objs.some((o) => o.id === sel.id)) objSel.value = sel.id;
      const cur = objs.find((o) => o.id === objSel.value);
      fillSelect(gripSel, [{ value: "", label: "Automatic" }, ...(cur?.grips ?? []).map((g) => ({ value: g.id, label: `${g.label}` }))]);
      grabBtn.disabled = !cur;
      const o = cur ? sb.objects.get(cur.id) : null;
      attachChip.disabled = !cur;
      attachChip.setPressed(!!o?.attachedTo);
      pelvisBox.disabled = placer.spot().mode !== "floor";
      // posture prop
      const pp = placer.postureProp();
      const note = pp?.prop.note.trim().replace(/\.+$/, "");
      propText.textContent = pp ? `${pp.posture.name} uses ${pp.prop.name.toLowerCase()} (${pp.prop.role === "held" ? "held in the hands" : "something to sit on, lean on or hold"}).${note ? ` ${note.charAt(0).toUpperCase()}${note.slice(1)}.` : ""}` : "The posture on the figure does not use an object. Choose a posture such as Holding a crate in the Posture tab.";
      propBtn.disabled = !pp;
      // reach
      const targets = placer.reachTargets();
      fillSelect(targetSel, targets.length ? targets.map((t) => ({ value: t.key, label: t.label })) : [{ value: "", label: "Select an object or a measurement" }]);
      reachBtn.disabled = !targets.length;
      envChip.setPressed(placer.envelopeOn);
      // sight
      const ds = placer.displays(), pick = sel && !ds.some((d) => d.id === sel.id) ? [{ id: sel.id, name: `${sel.name} (selected)` }] : [], all = [...ds, ...pick];
      fillSelect(dispSel, all.length ? all.map((d) => ({ value: d.id, label: d.name })) : [{ value: "", label: "No display in the scene" }]);
      if (!chosen.disp && all.length) dispSel.value = (sel && ds.some((d) => d.id === sel.id) ? sel.id : ds[0]?.id) ?? sel?.id ?? all[0].id;
      lookBtn.disabled = viewBtn.disabled = !dispSel.value;
      const v = dispSel.value ? placer.viewOf(dispSel.value) : null;
      const sf = v ? [`Distance eye to display: ${fmtLength(mm(v.distance), unit())}; centre ${f1(Math.abs(v.declination))}° ${v.declination >= 0 ? "below" : "above"} the horizontal.`, ...(v.visualH != null ? [`It fills ${f1(v.visualH)}° across${v.visualV != null ? ` and ${f1(v.visualV)}° high` : ""}.`] : []), ...(v.incidence != null ? [`The line of sight is ${f1(v.incidence)}° off the screen normal.`] : [])] : ["Choose a display to see the distance and visual angle."];
      const ss = JSON.stringify(sf);
      if (sightFacts.dataset.s !== ss) { sightFacts.dataset.s = ss; sightFacts.replaceChildren(...sf.map((t) => h("li", {}, t))); }
    } catch (e) {
      if (!/not ready/.test(String(e?.message))) console.warn("place: refresh failed:", e);
    }
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(refresh); };
  for (const [k, sel] of [["seat", seatSel], ["obj", objSel], ["disp", dispSel]]) sel.addEventListener("change", () => { chosen[k] = true; sig.delete(gripSel); schedule(); });

  const ready = (async () => {
    placer = await acquirePlace(ctx);
    if (disposed) { releasePlace(ctx); placer = null; return; }
    const ed = peekEditorRef();
    if (ed) ed.refs = (ed.refs ?? 0) + 1;
    offs.push(placer.onChange(() => schedule()));
    offs.push(ctx.on("selection", () => { chosen.seat = chosen.obj = chosen.disp = false; schedule(); }));
    for (const evt of ["units", "scene", "pose", "rig", "measure"]) offs.push(ctx.on(evt, schedule));
    import("./postures.js").then((m) => {
      if (disposed) return;
      const seated = m.POSTURES.filter((p) => /^seat/.test(p.support) && p.hints?.seat?.height !== 0).map((p) => ({ value: p.id, label: p.name, group: p.category }));
      seatedPostures = seated;
      sig.delete(postureSel);
      schedule();
    }).catch(() => {});
    refresh();
  })().catch((e) => { console.error("place: could not start:", e); root.prepend(notice(`The placing tools could not start (${String(e?.message ?? e).slice(0, 120)}).`, { level: "error" })); });
  const peekEditorRef = () => ctx.state?.postureEditor ?? ctx.posture ?? null;

  return {
    ready, get placer() { return placer; }, refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
      const had = placer;
      if (had) { try { had.setFloorDrag(false); had.showEnvelope(false); } catch { /* gone */ } }
      const ed = peekEditorRef();
      if (had) releasePlace(ctx);
      if (ed && had && (ed.refs = (ed.refs ?? 1) - 1) <= 0) { try { ed.dispose(); } catch { /* gone */ } }
      root.remove();
      releaseSandbox(ctx);
    },
  };
}
