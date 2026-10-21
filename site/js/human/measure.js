// Measurements of the Digital human tab: distances, heights above the floor, angles and display viewing checks between points of the figure
// (landmarks, joint centres, points on its skin) and of the sandbox objects (anchors, corners, any surface point). Contract: DESIGN.md 3.5.
//
// A measurement is a list of POINT REFERENCES that are resolved LIVE every time the scene or the pose changes, so a measurement follows whatever
// moves. A reference is { kind: "world", p } | { kind: "object", id, anchor?, local? } | { kind: "joint", id, local? } | { kind: "landmark", id }
// (`local` = a point in the frame of the object, or of the joint, so it keeps its place on the thing it was picked on). When an object or a
// joint disappears the item turns grey and says why. Lengths are stored in METRES and angles in degrees; the display unit comes from ctx.units;
// exports are always millimetres and degrees in the axes of DESIGN.md (+Y up, +Z in front of the figure, +X the figure's left).
//
// The top of the file is PURE maths (distance / angle / viewing geometry, reference cleaning, formatting): tests/human3d/measure.test.mjs.
// createMeasure() adds the state, the live update, the 3D overlay (dashed lines, markers, labels through the viewport's label layer) and the
// two-click picking tool with snapping. It never touches `document` / `window`: the panel (panels/measure.js) draws the controls.
import * as THREE from "three";
import { JOINT_BY_ID, JOINTS } from "./skeleton.js";
import { toUnit, unitDigits, UNIT_LABEL } from "./ui.js";
import { toCSV } from "../util.js";
import { sandboxFor } from "./sandbox.js";

const R2D = 180 / Math.PI;
export const MEASURE_VERSION = 1;
export const MAX_ITEMS = 200;
export const KINDS = Object.freeze(["distance", "height", "angle", "view"]);
export const COLOR_TOKENS = Object.freeze(["accent", "bad", "good", "text"]);
export const SNAP_PX = 12;
/** Information shown with a viewing check. It is a note, not a verdict: nothing here is checked against a standard automatically. */
export const VIEW_NOTE = "Commonly cited guidance (ISO 9241-5, ANSI/HFES 100): view distance about 0.5 to 0.75 m, screen centre 0 to 30 degrees below the horizontal. This is information, not a verdict.";
export const VIEW_ZONE = Object.freeze({ distance: [0.5, 0.75], declination: [0, 30] });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d) => { const k = 10 ** d; const r = Math.round(v * k) / k; return r === 0 ? 0 : r; };
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
const num3 = (v, lim) => (Array.isArray(v) && v.length === 3 && v.every(fin) ? v.map((c) => Math.min(lim, Math.max(-lim, c))) : null);

// ---------------------------------------------------------------------------------------------------------------------
// pure maths
/** Distance info between two points (a -> b): { dist, dx, dy, dz, horizontal } in the units of the inputs. */
export function distanceInfo(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return { dist: Math.hypot(dx, dy, dz), dx, dy, dz, horizontal: Math.hypot(dx, dz) };
}
/** The angle at `vertex` between the directions to `a` and `c`, in degrees (0 to 180), or null when a leg has no length. */
export function angleAt(a, vertex, c) {
  const u = new THREE.Vector3().subVectors(a, vertex), v = new THREE.Vector3().subVectors(c, vertex), lu = u.length(), lv = v.length();
  if (lu < 1e-9 || lv < 1e-9) return null;
  return Math.acos(Math.min(1, Math.max(-1, u.dot(v) / (lu * lv)))) * R2D;
}
/**
 * Viewing geometry from an eye point to the centre of a display. `edges` (optional Vector3s) = { left, right, top, bottom } edge centres and
 * `normal` the display's viewing normal. Returns { distance, horizontal, declination (degrees BELOW the horizontal at the eye, negative when
 * the centre is above it), visualH / visualV (the angles the screen's width and height subtend at the eye, degrees), width, height (metres),
 * incidence (angle between the line of sight and the screen normal, 0 = looking straight at it), zone: { distance, declination } as
 * "within" | "closer" | "farther" / "within" | "above" | "below" } with the ISO 9241-5 / ANSI-HFES note ranges (VIEW_ZONE).
 */
export function viewInfo(eye, centre, { normal = null, left = null, right = null, top = null, bottom = null } = {}) {
  const d = distanceInfo(eye, centre);
  const declination = Math.atan2(eye.y - centre.y, d.horizontal) * R2D;
  const visualH = left && right ? angleAt(left, eye, right) : null, visualV = top && bottom ? angleAt(top, eye, bottom) : null;
  const incidence = normal && d.dist > 1e-9 ? angleAt(new THREE.Vector3().copy(eye), centre, new THREE.Vector3().copy(centre).add(normal)) : null;
  const [d0, d1] = VIEW_ZONE.distance, [a0, a1] = VIEW_ZONE.declination;
  return {
    distance: d.dist, horizontal: d.horizontal, declination, visualH, visualV,
    width: left && right ? left.distanceTo(right) : null, height: top && bottom ? top.distanceTo(bottom) : null, incidence,
    zone: { distance: d.dist < d0 ? "closer" : d.dist > d1 ? "farther" : "within", declination: declination < a0 ? "above" : declination > a1 ? "below" : "within" },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// formatting (never NaN: unresolved values show an em dash)
export const DASH = "—";
// number.toLocaleString(locale, options) builds a formatter on every call (about 20 microseconds); a list of 200 measurements formats 1000 numbers per update
const formatters = new Map();
const numberFormat = (min, max) => { const k = `${min}.${max}`; let f = formatters.get(k); if (!f) { f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }); formatters.set(k, f); } return f; };
const fmtDeg = (v) => (fin(v) ? `${numberFormat(0, 1).format((Math.round(v * 10) / 10) || 0)}°` : DASH);
/** A length in metres in the display unit ("1,153 mm", "115.3 cm", "45.39 in"). Negative values use the real minus sign; a value that rounds to zero has no sign. */
export const fmtM = (m, unit = "mm") => {
  if (!fin(m)) return DASH;
  const d = unitDigits(unit), t = numberFormat(d, d).format(toUnit(m * 1000, unit)); // toUnit throws on an unknown unit, like ui.js fmtLength
  return `${t[0] !== "-" ? t : /[1-9]/.test(t) ? `−${t.slice(1)}` : t.slice(1)} ${UNIT_LABEL[unit]}`;
};
/** The headline value of an evaluated item: "612 mm", "1,153 mm" (a height: the label says what it is), "87.3°", "612 mm, 12.3° below level". */
export function formatResult(res, unit = "mm") {
  if (!res?.ok) return DASH;
  if (res.kind === "angle") return fmtDeg(res.value);
  if (res.kind === "view") return `${fmtM(res.view.distance, unit)}, ${fmtDeg(Math.abs(res.view.declination))} ${res.view.declination >= 0 ? "below" : "above"} level`;
  return fmtM(res.value, unit);
}
/** The Δ components of a distance result as text: "Δx 120 mm, Δy −45 mm, Δz 300 mm, horizontal 323 mm". */
export function formatDeltas(res, unit = "mm") {
  if (!res?.ok || res.dx == null) return "";
  return `Δx ${fmtM(res.dx, unit)}, Δy ${fmtM(res.dy, unit)}, Δz ${fmtM(res.dz, unit)}, horizontal ${fmtM(res.horizontal, unit)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// references
/** Validate and clean a point reference (hostile input is normal for a scene file). Returns the clean reference or null. */
export function cleanRef(r) {
  if (!isObj(r)) return null;
  const kind = own(r, "kind");
  if (kind === "world") { const p = num3(own(r, "p"), 1000); return p ? { kind, p: p.map((v) => round(v, 6)) } : null; }
  const id = own(r, "id");
  if (kind === "landmark") return typeof id === "string" && ID_RE.test(id) ? { kind, id } : null;
  const local = own(r, "local") === undefined ? undefined : num3(own(r, "local"), 1000);
  if (own(r, "local") !== undefined && !local) return null;
  if (kind === "joint") return typeof id === "string" && ID_RE.test(id) ? { kind, id, ...(local ? { local: local.map((v) => round(v, 6)) } : {}) } : null;
  if (kind === "object") {
    const anchor = own(r, "anchor");
    if (typeof id !== "string" || !ID_RE.test(id) || (anchor !== undefined && (typeof anchor !== "string" || !ID_RE.test(anchor))) || (anchor === undefined && !local)) return null;
    return { kind, id, ...(anchor !== undefined ? { anchor } : {}), ...(local ? { local: local.map((v) => round(v, 6)) } : {}) };
  }
  return null;
}
/** The display points a viewing check can take the screen size from -> the prefix of their edge anchors (catalog.js). */
const EDGE_BASE = Object.freeze({ screen_centre: "", glass_centre: "", panel_centre: "", left_screen: "left_screen_", right_screen: "right_screen_" });
const KIND_POINTS = { distance: ["a", "b"], height: ["a"], angle: ["a", "b", "c"], view: ["a", "b"] };
const THEME_FALLBACK = { accent: 0x2a78d6, bad: 0xb3261e, good: 0x0f7a2e, text: 0x888888, text3: 0x888888 };

/** Validate and clean a list of items from a scene file. Never throws. Returns { items, warnings }. */
export function cleanItems(list, { max = MAX_ITEMS } = {}) {
  const warnings = [], items = [];
  if (!Array.isArray(list)) return { items, warnings: list === undefined ? [] : ["The measurements section is not a list and was ignored."] };
  let arr = list;
  if (arr.length > max) { warnings.push(`The file holds ${arr.length} measurements; only the first ${max} were read.`); arr = arr.slice(0, max); }
  arr.forEach((raw, i) => {
    if (!isObj(raw)) { warnings.push(`Measurement ${i + 1} was skipped: it is not an object.`); return; }
    const kind = own(raw, "kind");
    if (!KINDS.includes(kind)) { warnings.push(`Measurement ${i + 1} was skipped: unknown kind.`); return; }
    const item = { id: typeof own(raw, "id") === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : null, kind };
    for (const k of KIND_POINTS[kind]) {
      const ref = cleanRef(own(raw, k));
      if (!ref) { warnings.push(`Measurement ${i + 1} was skipped: point ${k.toUpperCase()} is not a valid reference.`); return; }
      item[k] = ref;
    }
    item.label = typeof own(raw, "label") === "string" ? raw.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
    item.color = COLOR_TOKENS.includes(own(raw, "color")) ? raw.color : null;
    item.visible = own(raw, "visible") !== false;
    items.push(item);
  });
  return { items, warnings };
}

// ---------------------------------------------------------------------------------------------------------------------
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * createMeasure({ viewport, ctx, sandbox, scheduler? }) -> Measure. `sandbox` is the Sandbox of sandbox.js (anchors, objects), `ctx` the panel ctx.
 * `scheduler(fn)` replaces requestAnimationFrame for the coalesced live update (tests); measure.flush() always updates at once.
 */
export function createMeasure({ viewport, ctx, sandbox, scheduler } = {}) {
  if (!viewport) throw new TypeError("createMeasure: a viewport is required");
  const emitCtx = (evt, data) => { try { ctx?.emit?.(evt, data); } catch (e) { console.error(`measure: "${evt}" listener failed:`, e); } };
  const later = scheduler ?? ((fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 0)));
  const unit = () => ctx?.units ?? "mm";
  const root = new THREE.Group();
  root.name = "hm-measure";
  viewport.add?.(root);

  const items = [];
  const listeners = new Set();
  const unsubs = [];
  const lastNames = new Map(); // `${itemId}:${point}` -> what the reference last resolved to, for "the object X was removed"
  const drawn = new Map(); // item id -> { sig, group }
  let seq = 0, selectedId = null, disposed = false, queued = false, tool = "off", pending = [], hoverState = null, resumeInput = null, previewGroup = null;
  let colorIdx = 0;
  // Results of the update in progress (flush) are shared by the overlay and by every listener, so an item is evaluated once per frame, not once per
  // consumer; `lastFrame` also serves the labels until the next event says that something may have changed.
  let frame = null, lastFrame = null;

  // ---- references -------------------------------------------------------------------------------------------------
  const theme = () => viewport.theme ?? {};
  const rigOf = () => ctx?.getRig?.() ?? null;
  const objectOf = (id) => sandbox?.objects?.get(id) ?? null;
  const landmarkLabel = (rig, id) => rig?.body?.landmarks?.[id]?.label ?? id;

  /** Resolve a reference: { ok: true, p: Vector3, label } or { ok: false, why }. */
  function resolve(ref, out = new THREE.Vector3()) {
    if (!isObj(ref)) return { ok: false, why: "This point is not set." };
    switch (ref.kind) {
      case "world": return fin(ref.p?.[0] + ref.p?.[1] + ref.p?.[2]) ? { ok: true, p: out.set(ref.p[0], ref.p[1], ref.p[2]), label: "Point in space" } : { ok: false, why: "This point has no valid position." };
      case "object": {
        const o = objectOf(ref.id);
        if (!o) return { ok: false, why: "The object this point was on has been removed." };
        if (ref.anchor !== undefined) {
          const p = sandbox.anchorWorld(ref.id, ref.anchor, out);
          if (p) return { ok: true, p, label: `${o.name}: ${o._anchors[ref.anchor].label}` };
          if (!ref.local) return { ok: false, why: `"${o.name}" no longer has the point "${ref.anchor}".`, name: o.name };
        }
        if (ref.local) { const p = sandbox.localToWorld(ref.id, ref.local, out); if (p) return { ok: true, p, label: `${o.name} (point)` }; }
        return { ok: false, why: "This point has no valid position." };
      }
      case "joint": {
        const rig = rigOf();
        if (!rig) return { ok: false, why: "There is no figure yet." };
        try {
          rig.jointWorld(ref.id, out);
          if (ref.local) { rig.jointQuaternion(ref.id, _q); out.add(_v.set(ref.local[0], ref.local[1], ref.local[2]).applyQuaternion(_q)); }
          if (!fin(out.x + out.y + out.z)) throw new Error("not finite");
          return { ok: true, p: out, label: (JOINT_BY_ID[ref.id]?.label ?? ref.id) + (ref.local ? " (skin point)" : " joint") };
        } catch { return { ok: false, why: `The figure has no joint "${ref.id}".` }; }
      }
      case "landmark": {
        const rig = rigOf();
        if (!rig) return { ok: false, why: "There is no figure yet." };
        try { rig.landmarkWorld(ref.id, out); if (!fin(out.x + out.y + out.z)) throw new Error("not finite"); return { ok: true, p: out, label: landmarkLabel(rig, ref.id) }; } catch { return { ok: false, why: `The figure has no landmark "${ref.id}".` }; }
      }
      default: return { ok: false, why: "This point is not set." };
    }
  }
  /** A name for a reference ("Monitor: Screen centre", "Cyclopean eye point"), also for one that no longer resolves. */
  function refLabel(ref, memo) {
    const r = resolve(ref, new THREE.Vector3());
    if (r.ok) { if (memo) lastNames.set(memo, r.label); return r.label; }
    return (memo && lastNames.get(memo)) || (ref?.kind === "landmark" ? ref.id : ref?.kind === "joint" ? JOINT_BY_ID[ref.id]?.label ?? ref.id : "a point");
  }

  // ---- evaluation ---------------------------------------------------------------------------------------------------
  /** Evaluate an item (or an id) now: { ok, why?, kind, points, value, unit, dx, dy, dz, horizontal, view? }. value: metres, or degrees for an angle. */
  function evaluate(itemOrId) {
    const item = typeof itemOrId === "string" ? items.find((i) => i.id === itemOrId) : itemOrId;
    if (!item) return { ok: false, why: "There is no such measurement.", kind: null, points: {} };
    const hit = frame?.get(item);
    if (hit) return hit;
    const res = evaluateNow(item);
    frame?.set(item, res);
    return res;
  }
  function evaluateNow(item) {
    const pts = {}, whys = [];
    for (const k of KIND_POINTS[item.kind]) {
      const r = resolve(item[k], new THREE.Vector3());
      if (r.ok) { pts[k] = r.p; lastNames.set(`${item.id}:${k}`, r.label); continue; }
      if (item[k]?.kind === "object" && !objectOf(item[k].id)) { // say WHICH object, from what the point last resolved to ("Monitor: Screen centre")
        const was = lastNames.get(`${item.id}:${k}`);
        whys.push(was ? `The object "${String(was).split(":")[0].replace(/ \(point\)$/, "")}" was removed.` : "The object this point was on was removed.");
      } else whys.push(r.why);
    }
    if (whys.length) return { ok: false, why: whys[0], kind: item.kind, points: pts };
    const base = { ok: true, kind: item.kind, points: pts };
    switch (item.kind) {
      case "distance": { const d = distanceInfo(pts.a, pts.b); return { ...base, value: d.dist, unit: "m", ...d }; }
      case "height": return { ...base, value: pts.a.y, unit: "m", dx: null, dy: null, dz: null, horizontal: null };
      case "angle": {
        const ang = angleAt(pts.a, pts.b, pts.c);
        return ang == null ? { ok: false, why: "Two of the three points coincide, so there is no angle.", kind: "angle", points: pts } : { ...base, value: ang, unit: "deg", dx: null, dy: null, dz: null, horizontal: null };
      }
      case "view": {
        const edges = {}, ref = item.b;
        let normal = null;
        if (ref.kind === "object" && sandbox) {
          // the edge anchors of a display point: "top_edge" for the centre of a screen, "left_screen_top_edge" for the left side screen of a triple monitor
          const edgeBase = Object.hasOwn(EDGE_BASE, ref.anchor ?? "") ? EDGE_BASE[ref.anchor] : undefined;
          if (edgeBase !== undefined) {
            for (const k of ["left", "right", "top", "bottom"]) { const p = sandbox.anchorWorld(ref.id, `${edgeBase}${k}_edge`, new THREE.Vector3()); if (p) edges[k] = p; }
          }
          if (ref.anchor !== undefined) normal = sandbox.anchorNormalWorld(ref.id, ref.anchor, new THREE.Vector3());
        }
        const view = viewInfo(pts.a, pts.b, { ...edges, normal });
        const d = distanceInfo(pts.a, pts.b);
        return { ...base, value: view.distance, unit: "m", dx: d.dx, dy: d.dy, dz: d.dz, horizontal: d.horizontal, view };
      }
      default: return { ok: false, why: "Unknown kind.", kind: item.kind, points: pts };
    }
  }
  const results = () => new Map(items.map((i) => [i.id, evaluate(i)]));

  // ---- items ------------------------------------------------------------------------------------------------------------
  const defaultName = (kind) => {
    const base = { distance: "Distance", height: "Height", angle: "Angle", view: "View" }[kind];
    let n = items.filter((i) => i.kind === kind).length + 1;
    while (items.some((i) => i.label === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  };
  // `seq` follows the numbers in ids that came from a file, but only up to 9 digits: above 2^53 `++seq` would no longer change it and the loop below would never end
  const noteId = (id) => { const m = /^m(\d{1,9})$/.exec(id); if (m) seq = Math.max(seq, Number(m[1])); };
  const nextId = () => { let id; do { id = `m${++seq}`; } while (items.some((i) => i.id === id)); return id; };
  /** Add { kind, a, b?, c?, label?, color? }. Returns the item, or null (invalid points, or MAX_ITEMS reached). */
  function add(spec, { silent = false } = {}) {
    if (!isObj(spec) || !KINDS.includes(spec.kind) || items.length >= MAX_ITEMS) return null;
    const item = { id: spec.id && !items.some((i) => i.id === spec.id) ? spec.id : nextId(), kind: spec.kind };
    for (const k of KIND_POINTS[spec.kind]) { const r = cleanRef(spec[k]); if (!r) return null; item[k] = r; }
    noteId(item.id);
    item.label = typeof spec.label === "string" && spec.label.trim() ? spec.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : defaultName(spec.kind);
    item.color = COLOR_TOKENS.includes(spec.color) ? spec.color : COLOR_TOKENS[colorIdx++ % COLOR_TOKENS.length];
    item.visible = spec.visible !== false;
    items.push(item);
    evaluate(item); // remembers the names of the points
    if (!silent) changed("add", item.id);
    return item;
  }
  const addDistance = (a, b, o = {}) => add({ ...o, kind: "distance", a, b });
  const addHeight = (a, o = {}) => add({ ...o, kind: "height", a });
  const addAngle = (a, b, c, o = {}) => add({ ...o, kind: "angle", a, b, c });
  /** A viewing check from an eye point (default: the cyclopean eye landmark) to a display point (an object anchor such as "screen_centre"). */
  const addView = (display, eye = { kind: "landmark", id: "eye_mid" }, o = {}) => add({ ...o, kind: "view", a: eye, b: display });

  function remove(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    for (const k of [...lastNames.keys()]) if (k.startsWith(`${id}:`)) lastNames.delete(k);
    if (selectedId === id) selectedId = null;
    changed("remove", id);
    return true;
  }
  function clear() { if (!items.length) return false; items.length = 0; lastNames.clear(); selectedId = null; changed("clear"); return true; }
  function rename(id, label) {
    const it = items.find((x) => x.id === id);
    if (!it || typeof label !== "string" || !label.trim()) return false;
    it.label = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
    changed("update", id);
    return true;
  }
  function setVisible(id, v) { const it = items.find((x) => x.id === id); if (!it) return false; it.visible = !!v; changed("update", id); return true; }
  function setColor(id, token) { const it = items.find((x) => x.id === id); if (!it || !COLOR_TOKENS.includes(token)) return false; it.color = token; changed("update", id); return true; }
  function select(id) {
    if (id != null && !items.some((x) => x.id === id)) return false; // an unknown id changes nothing
    const v = id ?? null;
    if (v === selectedId) return false;
    selectedId = v;
    changed("select", v);
    return true;
  }
  function changed(op, id) {
    if (disposed) return;
    invalidate();
    for (const f of [...listeners]) { try { f({ op, id }); } catch (e) { console.error("measure: listener failed:", e); } }
    emitCtx("measure", { op, id });
  }
  /** Listen for changes of the list or of the values: fn({ op, id }); op is add | remove | clear | update | select | values | load. Returns the unsubscribe function. */
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ---- live update and overlay --------------------------------------------------------------------------------------
  function invalidate() {
    lastFrame = null;
    if (queued || disposed) return;
    queued = true;
    later(() => { queued = false; if (!disposed) flush(); });
  }
  /** Re-evaluate everything and redraw the overlay now. */
  function flush() {
    if (disposed) return;
    queued = false;
    frame = new Map();
    try {
      redraw();
      for (const f of [...listeners]) { try { f({ op: "values" }); } catch (e) { console.error("measure: listener failed:", e); } }
      lastFrame = frame;
    } finally { frame = null; }
    viewport.requestRender?.();
  }

  const colorOf = (item, ok) => {
    if (!ok) return theme().text3 ?? new THREE.Color(THEME_FALLBACK.text3);
    return theme()[item.color ?? "accent"] ?? new THREE.Color(THEME_FALLBACK[item.color ?? "accent"]);
  };
  const cssColorOf = (item, ok) => (ok ? `var(--${item.color ?? "accent"})` : "var(--text-3)");

  function markerMesh(color, k = 0.0055) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true }));
    m.renderOrder = 31; m.raycast = () => {}; m.userData.noPick = true; m.userData.k = k;
    m.onBeforeRender = (renderer, scene, camera) => { // constant size on screen, whatever the zoom
      const s = camera.position.distanceTo(_w.setFromMatrixPosition(m.matrixWorld)) * (m.userData.k ?? k);
      m.scale.setScalar(s);
      m.matrixWorld.compose(_w, _q.identity(), _v.setScalar(s));
    };
    return m;
  }
  function dashedLines(points, color, { dash } = {}) {
    // two passes: crisp where the line is in front, dim where a surface hides it
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const g = new THREE.Group();
    const len = points.reduce((s, p, i) => (i ? s + p.distanceTo(points[i - 1]) : 0), 0), d = dash ?? Math.min(0.05, Math.max(0.008, len / 36));
    const mk = (front) => {
      const mat = new THREE.LineDashedMaterial({ color, dashSize: d, gapSize: d * 0.6, depthTest: front, depthWrite: false, transparent: true, opacity: front ? 1 : 0.32 });
      const l = new THREE.Line(geo, mat);
      l.computeLineDistances();
      l.renderOrder = front ? 29 : 28; l.raycast = () => {}; l.userData.noPick = true;
      return l;
    };
    g.add(mk(false), mk(true));
    g.userData.geo = geo;
    return g;
  }
  function disposeGroup(g) { g.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); g.parent?.remove(g); }
  const key = (v) => `${round(v.x, 5)},${round(v.y, 5)},${round(v.z, 5)}`;

  function buildItemGroup(item, res, selected) {
    const g = new THREE.Group(), color = colorOf(item, res.ok), P = res.points;
    const pts = [];
    const line = (arr) => g.add(dashedLines(arr, selected ? color.clone().lerp(new THREE.Color(1, 1, 1), 0.25) : color));
    const dot = (p) => { const m = markerMesh(color, selected ? 0.0075 : 0.0055); m.position.copy(p); g.add(m); };
    if (item.kind === "distance") { line([P.a, P.b]); dot(P.a); dot(P.b); pts.push(P.a, P.b); }
    else if (item.kind === "height") {
      const foot = new THREE.Vector3(P.a.x, 0, P.a.z);
      line([foot, P.a]); dot(P.a); dot(foot);
      line([foot.clone().add(new THREE.Vector3(-0.05, 0, 0)), foot.clone().add(new THREE.Vector3(0.05, 0, 0))]);
    } else if (item.kind === "angle") {
      line([P.a, P.b, P.c]); dot(P.a); dot(P.b); dot(P.c);
      const u = P.a.clone().sub(P.b), v = P.c.clone().sub(P.b), r = Math.min(u.length(), v.length()) * 0.35, arc = [];
      if (r > 1e-4) { const an = u.angleTo(v), ax = new THREE.Vector3().crossVectors(u, v); if (ax.lengthSq() > 1e-12) { ax.normalize(); for (let i = 0; i <= 16; i++) arc.push(u.clone().normalize().applyAxisAngle(ax, (an * i) / 16).multiplyScalar(r).add(P.b)); line(arc); } }
    } else if (item.kind === "view") {
      line([P.a, P.b]); dot(P.a); dot(P.b);
      // the right triangle that shows the angle below the horizontal: level line from the eye, then straight down / up to the display centre
      const corner = new THREE.Vector3(P.b.x, P.a.y, P.b.z);
      if (corner.distanceTo(P.a) > 1e-3 && Math.abs(P.a.y - P.b.y) > 1e-3) line([P.a, corner, P.b]);
    }
    g.userData.pts = pts;
    return g;
  }

  function redraw() {
    const seen = new Set();
    for (const item of items) {
      const res = evaluate(item);
      seen.add(item.id);
      const selected = item.id === selectedId, show = item.visible && res.ok;
      const sig = show ? `${item.kind}|${item.color}|${selected}|${Object.values(res.points).map(key).join("|")}` : "";
      const old = drawn.get(item.id);
      if (old && old.sig === sig) continue;
      if (old) { disposeGroup(old.group); drawn.delete(item.id); }
      if (!show) continue;
      const group = buildItemGroup(item, res, selected);
      root.add(group);
      drawn.set(item.id, { sig, group });
    }
    for (const [id, d] of [...drawn]) if (!seen.has(id)) { disposeGroup(d.group); drawn.delete(id); }
    drawPreview();
  }

  // 3D labels through the viewport's label layer: they do not overlap (placeLabels), the selected one is pinned
  function labelItems() {
    const out = [], u = unit();
    for (const item of items) {
      if (!item.visible) continue;
      const res = lastFrame?.get(item) ?? evaluate(item);
      if (!res.ok) continue;
      const P = res.points, pos = item.kind === "angle" ? P.b.clone() : item.kind === "height" ? P.a.clone().setY(P.a.y / 2) : P.a.clone().lerp(P.b, 0.5);
      const sel = item.id === selectedId, text = `${item.label}: ${formatResult(res, u)}`;
      out.push({ id: item.id, text: text.length > 60 ? `${text.slice(0, 57)}…` : text, position: pos, color: cssColorOf(item, true), priority: sel ? 101 : 60, cls: `hm-label-measure${sel ? " hm-label-sel" : ""}` });
    }
    if (hoverState?.snap) out.push({ id: "snap", text: hoverState.snap.text, position: hoverState.snap.p.clone(), color: "var(--accent)", priority: 120, cls: "hm-label-snap" });
    return out;
  }
  const offLabels = viewport.addLabelSource?.("measure", labelItems);
  if (typeof offLabels === "function") unsubs.push(offLabels);

  // ---- the picking tool -----------------------------------------------------------------------------------------------------
  const NEEDS = { distance: 2, height: 1, angle: 3 };
  function setTool(next) {
    if (!["off", "distance", "height", "angle"].includes(next) || next === tool) return false;
    tool = next;
    pending = [];
    hoverState = null;
    if (tool === "off") { resumeInput?.(); resumeInput = null; viewport.setCursor?.("grab"); }
    else { if (!resumeInput && sandbox?.suspendInput) resumeInput = sandbox.suspendInput(); viewport.setCursor?.("crosshair"); }
    changed("tool");
    return true;
  }
  /** Abandon the points picked so far; a second call ends the tool. */
  function cancel() { if (pending.length) { pending = []; hoverState = null; changed("tool"); return true; } if (tool !== "off") return setTool("off"); return false; }

  function* snapCandidates() {
    const rig = rigOf();
    if (rig) {
      try { for (const id of rig.bones?.keys?.() ?? JOINTS.map((j) => j.id)) yield { p: rig.jointWorld(id, new THREE.Vector3()), ref: { kind: "joint", id }, text: `Joint: ${JOINT_BY_ID[id]?.label ?? id}`, pr: 0 }; } catch { /* no joint */ }
      if (ctx?.state?.display?.landmarks) for (const id of rig.landmarkIds ?? []) { try { yield { p: rig.landmarkWorld(id, new THREE.Vector3()), ref: { kind: "landmark", id }, text: `Landmark: ${landmarkLabel(rig, id)}`, pr: 1 }; } catch { /* skip */ } }
    }
    if (sandbox) {
      for (const o of sandbox.objects.values()) {
        if (!o.visible) continue;
        for (const [id, a] of Object.entries(o._anchors)) yield { p: sandbox.anchorWorld(o.id, id, new THREE.Vector3()), ref: { kind: "object", id: o.id, anchor: id }, text: `${o.name}: ${a.label}`, pr: 2 };
        const b = o.bbox, xs = [b.min.x, (b.min.x + b.max.x) / 2, b.max.x], ys = [b.min.y, (b.min.y + b.max.y) / 2, b.max.y], zs = [b.min.z, (b.min.z + b.max.z) / 2, b.max.z];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
          const nMid = (i === 1) + (j === 1) + (k === 1);
          if (nMid === 3) continue; // the centre of the box is inside it
          const local = [xs[i], ys[j], zs[k]];
          yield { p: sandbox.localToWorld(o.id, local, new THREE.Vector3()), ref: { kind: "object", id: o.id, local: local.map((v) => round(v, 6)) }, text: `${o.name}: ${nMid === 0 ? "corner" : nMid === 1 ? "edge middle" : "face centre"}`, pr: 3 };
        }
      }
    }
  }
  /** The snap target within `px` screen pixels of (x, y) (canvas coordinates): { ref, p, text, px } or null. Joints beat landmarks beat anchors beat box points when close. */
  function snapAt(x, y, px = SNAP_PX) {
    let best = null;
    for (const c of snapCandidates()) {
      const s = viewport.project?.(c.p);
      if (!s || !s.visible) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > px) continue;
      const score = d + c.pr * 3;
      if (!best || score < best.score) best = { ...c, px: d, score };
    }
    return best && { ref: best.ref, p: best.p, text: best.text, px: best.px };
  }
  /** What a click at this client position would pick: a snap target, else a point on an object, on the figure's skin or on the floor. */
  function pickPoint(clientX, clientY, x, y) {
    const snap = snapAt(x, y);
    if (snap) return { ...snap, snapped: true };
    const ray = viewport.ray?.(clientX, clientY);
    if (!ray) return null;
    let best = null;
    const objHit = sandbox?.pickAt?.(clientX, clientY, { ignoreFigure: true }); // the skin is compared below
    if (objHit) best = { dist: objHit.distance, p: objHit.point, ref: { kind: "object", id: objHit.obj.id, local: sandbox.worldToLocal(objHit.obj.id, objHit.point).toArray().map((v) => round(v, 6)) }, text: `${objHit.obj.name} (surface)` };
    const rig = rigOf();
    if (rig?.skin) {
      let hit = null;
      try { hit = ray.intersectObject(rig.skin, false)[0] ?? null; } catch { hit = null; }
      if (hit && (!best || hit.distance < best.dist)) {
        const jid = skinJoint(rig, hit);
        if (jid) {
          const jp = rig.jointWorld(jid, new THREE.Vector3()), q = rig.jointQuaternion(jid, new THREE.Quaternion()), local = hit.point.clone().sub(jp).applyQuaternion(q.invert());
          best = { dist: hit.distance, p: hit.point.clone(), ref: { kind: "joint", id: jid, local: local.toArray().map((v) => round(v, 6)) }, text: "Skin" };
        }
      }
    }
    const g = ray.ray.intersectPlane(GROUND, new THREE.Vector3());
    if (g && ray.ray.direction.y < 0) { const d = g.distanceTo(ray.ray.origin); if (d < 60 && (!best || d < best.dist)) best = { dist: d, p: g, ref: { kind: "world", p: g.toArray().map((v) => round(v, 6)) }, text: "Floor" }; }
    return best && { ref: best.ref, p: best.p, text: best.text, snapped: false };
  }
  /** The joint that moves a skin triangle: the bone with the largest skin weight over its three vertices. */
  function skinJoint(rig, hit) {
    const geo = rig.skin?.geometry, idx = geo?.attributes?.skinIndex, wt = geo?.attributes?.skinWeight, face = hit.face;
    const bones = rig.skin?.skeleton?.bones;
    if (!idx || !wt || !face || !bones) return null;
    const sum = new Map();
    for (const vi of [face.a, face.b, face.c]) for (let k = 0; k < 4; k++) { const b = idx.getComponent(vi, k), w = wt.getComponent(vi, k); sum.set(b, (sum.get(b) ?? 0) + w); }
    let bi = -1, bw = -1;
    for (const [b, w] of sum) if (w > bw) { bw = w; bi = b; }
    const name = bones[bi]?.name;
    return typeof name === "string" && JOINT_BY_ID[name] ? name : null;
  }

  function drawPreview() {
    if (previewGroup) { disposeGroup(previewGroup); previewGroup = null; }
    if (tool === "off" || !pending.length) return;
    const pts = [];
    for (const r of pending) { const v = resolve(r, new THREE.Vector3()); if (v.ok) pts.push(v.p); }
    if (hoverState?.p) pts.push(hoverState.p.clone());
    if (pts.length < 1) return;
    const g = new THREE.Group(), col = theme().accent ?? new THREE.Color(THEME_FALLBACK.accent);
    if (pts.length >= 2) g.add(dashedLines(pts, col));
    for (const p of pts) { const m = markerMesh(col, 0.0065); m.position.copy(p); g.add(m); }
    root.add(g);
    previewGroup = g;
  }

  // Hover is coalesced to one pick per frame: a ray through the skinned body costs about 10 ms, and a mouse reports far more often than the screen refreshes.
  let moveEv = null, moveQueued = false;
  function onPointerMove(ev) {
    if (tool === "off" || ev.buttons || ev.pointerType === "touch") return;
    moveEv = ev;
    if (moveQueued) return;
    moveQueued = true;
    later(() => {
      moveQueued = false;
      const e = moveEv;
      moveEv = null;
      if (disposed || tool === "off" || !e) return;
      const hit = pickPoint(e.clientX, e.clientY, e.x, e.y);
      hoverState = hit ? { p: hit.p, ref: hit.ref, text: hit.text, snap: hit.snapped ? hit : null } : null;
      drawPreview();
      viewport.requestRender?.();
    });
  }
  function onClick(ev) {
    if (tool === "off") return;
    ev.handled = true;
    const hit = pickPoint(ev.clientX, ev.clientY, ev.x, ev.y);
    if (!hit) return;
    pending.push(hit.ref);
    hoverState = null;
    if (pending.length >= NEEDS[tool]) {
      const [a, b, c] = pending;
      pending = [];
      const item = tool === "distance" ? addDistance(a, b) : tool === "height" ? addHeight(a) : addAngle(a, b, c);
      if (item) select(item.id);
    } else changed("tool");
    drawPreview();
    viewport.requestRender?.();
  }
  const offs = [viewport.on?.("pointermove", onPointerMove), viewport.on?.("click", onClick)];
  for (const f of offs) if (typeof f === "function") unsubs.push(f);
  const onKeyDown = (e) => { if (tool !== "off" && e.key === "Escape") { cancel(); e.preventDefault(); e.stopPropagation(); } };
  viewport.container?.addEventListener?.("keydown", onKeyDown, true);
  unsubs.push(() => viewport.container?.removeEventListener?.("keydown", onKeyDown, true));

  // ---- lists to choose points from (the "between" tool) -----------------------------------------------------------------------
  /** Every point one can choose by name: [{ key, group, label, text, ref }]. `text` ("Landmark · Cyclopean eye point") is what a search box shows. */
  function pointOptions() {
    const out = [], rig = rigOf();
    if (rig) {
      for (const id of rig.landmarkIds ?? []) { const label = landmarkLabel(rig, id); out.push({ key: `landmark:${id}`, group: "Landmark", label, text: `Landmark · ${label}`, ref: { kind: "landmark", id } }); }
      for (const j of JOINTS) if (!rig.bones || rig.bones.has(j.id)) out.push({ key: `joint:${j.id}`, group: "Joint", label: j.label, text: `Joint · ${j.label}`, ref: { kind: "joint", id: j.id } });
    }
    if (sandbox) for (const o of sandbox.objects.values()) for (const [id, a] of Object.entries(o._anchors)) out.push({ key: `object:${o.id}:${id}`, group: "Object", label: `${o.name}: ${a.label}`, text: `Object · ${o.name}: ${a.label}`, ref: { kind: "object", id: o.id, anchor: id } });
    // aliases of one landmark share a label: name them by id so that a typed text means one point
    const seen = new Map();
    for (const o of out) seen.set(o.text, (seen.get(o.text) ?? 0) + 1);
    for (const o of out) if (seen.get(o.text) > 1) { const id = o.ref.id; o.label = `${o.label} [${id}]`; o.text = `${o.text} [${id}]`; }
    return out;
  }
  /** Display points (an object's screen / glass / panel centre) for a viewing check: [{ key, label, ref }]. */
  function displayOptions() {
    const out = [];
    if (!sandbox) return out;
    for (const o of sandbox.objects.values()) for (const [id, a] of Object.entries(o._anchors)) if (Object.hasOwn(EDGE_BASE, id)) out.push({ key: `object:${o.id}:${id}`, label: `${o.name}: ${a.label}`, ref: { kind: "object", id: o.id, anchor: id } });
    return out.sort((x, y) => (x.key.endsWith(":screen_centre") ? 0 : 1) - (y.key.endsWith(":screen_centre") ? 0 : 1));
  }
  /** Find an option from text typed in a search box: exact text, else exact label, else the one option whose text contains it (case-insensitive). */
  function matchPoint(text, options = pointOptions()) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return null;
    const exact = options.find((o) => o.text.toLowerCase() === t) ?? options.find((o) => o.label.toLowerCase() === t);
    if (exact) return exact;
    const part = options.filter((o) => o.text.toLowerCase().includes(t));
    return part.length === 1 ? part[0] : null;
  }

  // ---- scene file and exports -------------------------------------------------------------------------------------------------
  const toJSON = () => items.map((i) => ({ id: i.id, kind: i.kind, ...Object.fromEntries(KIND_POINTS[i.kind].map((k) => [k, i[k]])), label: i.label, color: i.color, visible: i.visible }));
  /** Replace (or with { merge: true } extend) the items from a scene file section. Returns { ok, added, warnings }; never throws. */
  function fromJSON(list, { merge = false } = {}) {
    const { items: clean, warnings } = cleanItems(list);
    if (!merge) { items.length = 0; lastNames.clear(); selectedId = null; }
    let added = 0;
    for (const c of clean) if (add(c, { silent: true })) added++;
    changed("load");
    return { ok: true, added, warnings };
  }
  const mm = (v) => round(v * 1000, 1);
  const pt = (p) => (p ? [mm(p.x), mm(p.y), mm(p.z)] : null);
  /** The rows of an export: one per item, everything in millimetres and degrees. */
  function exportRows() {
    return items.map((it) => {
      const r = evaluate(it), P = r.ok ? r.points : {}, deg = r.unit === "deg";
      return {
        id: it.id, label: it.label, kind: it.kind, ok: r.ok, status: r.ok ? "ok" : r.why,
        value: r.ok ? (deg ? round(r.value, 2) : mm(r.value)) : null, unit: r.ok ? (deg ? "deg" : "mm") : "",
        dx: r.ok && r.dx != null ? mm(r.dx) : null, dy: r.ok && r.dy != null ? mm(r.dy) : null, dz: r.ok && r.dz != null ? mm(r.dz) : null, horizontal: r.ok && r.horizontal != null ? mm(r.horizontal) : null,
        a: pt(P.a), b: pt(P.b), c: pt(P.c), refs: Object.fromEntries(KIND_POINTS[it.kind].map((k) => [k, it[k]])),
        notes: r.ok && it.kind === "view" ? `declination ${round(r.view.declination, 1)} deg below horizontal; screen ${r.view.visualH == null ? "size unknown" : `${round(r.view.visualH, 1)} x ${round(r.view.visualV, 1)} deg`}; incidence ${r.view.incidence == null ? "unknown" : `${round(r.view.incidence, 1)} deg`}` : "",
        view: r.ok && it.kind === "view" ? { declination_deg: round(r.view.declination, 2), visual_h_deg: r.view.visualH == null ? null : round(r.view.visualH, 2), visual_v_deg: r.view.visualV == null ? null : round(r.view.visualV, 2), incidence_deg: r.view.incidence == null ? null : round(r.view.incidence, 2), width_mm: r.view.width == null ? null : mm(r.view.width), height_mm: r.view.height == null ? null : mm(r.view.height) } : undefined,
      };
    });
  }
  const triple = (v) => (v ? v.join(" ") : "");
  // a spreadsheet runs a cell that starts with = + - @ (or a tab / return) as a formula: names come from the user or from a file, so they get a quote in front
  const csvText = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  /** CSV text: id, label, kind, value, unit, dx, dy, dz, a, b, c (x y z in mm), horizontal, status, notes. Millimetres and degrees, DESIGN.md axes. */
  function toCSVText() {
    return toCSV(["id", "label", "kind", "value", "unit", "dx", "dy", "dz", "a", "b", "c", "horizontal", "status", "notes"],
      exportRows().map((r) => [csvText(r.id), csvText(r.label), r.kind, r.value, r.unit, r.dx, r.dy, r.dz, triple(r.a), triple(r.b), triple(r.c), r.horizontal, csvText(r.status), csvText(r.notes)]));
  }
  /** JSON text of the results (and the references they were made from), for other tools. */
  function toResultsJSON() {
    return JSON.stringify({ app: "digital-human-measurements", version: MEASURE_VERSION, units: { length: "mm", angle: "deg" }, axes: "x: figure's left, y: up, z: in front of the figure; origin on the floor", items: exportRows().map(({ ok, ...r }) => ({ ...r, resolved: ok })) }, null, 2);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    resumeInput?.(); resumeInput = null;
    for (const f of unsubs.splice(0)) { try { f(); } catch { /* gone */ } }
    for (const d of drawn.values()) disposeGroup(d.group);
    drawn.clear();
    if (previewGroup) disposeGroup(previewGroup);
    viewport.remove?.(root);
    viewport.removeLabelSource?.("measure");
    listeners.clear();
    registry.delete(viewport);
  }

  // follow the world: objects, the figure's pose, a new figure, units, theme
  if (ctx?.on) {
    for (const evt of ["scene", "pose", "rig", "units", "theme"]) unsubs.push(ctx.on(evt, () => invalidate()));
  }

  const measure = {
    items, root, viewport, ctx, sandbox,
    get selected() { return selectedId; },
    get tool() { return tool; },
    get pending() { return pending.slice(); },
    get hover() { return hoverState; },
    get disposed() { return disposed; },
    add, addDistance, addHeight, addAngle, addView, remove, clear, rename, setVisible, setColor, select, onChange, flush, invalidate,
    resolve, refLabel, evaluate, results, setTool, cancel, snapAt, pickPoint, pointOptions, displayOptions, matchPoint,
    format: (res) => formatResult(res, unit()), formatDeltas: (res) => formatDeltas(res, unit()),
    toJSON, fromJSON, exportRows, toCSV: toCSVText, toResultsJSON, dispose,
    refs: 0,
  };
  // the scene file carries the items
  if (sandbox?.registerSerializer) unsubs.push(sandbox.registerSerializer("measurements", { toJSON, fromJSON: (v, o) => fromJSON(v, o) }));
  registry.set(viewport, measure);
  return measure;
}

const registry = new WeakMap();
/** The measure of a ctx's viewport, created on first use (with the sandbox of that viewport). Also set as ctx.measure and ctx.state.measure (non-enumerable). */
export function measureFor(ctx) {
  const vp = ctx?.viewport;
  if (!vp) throw new TypeError("measureFor: the ctx has no viewport");
  let m = registry.get(vp);
  if (!m || m.disposed) m = createMeasure({ viewport: vp, ctx, sandbox: sandboxFor(ctx) });
  try { ctx.measure = m; } catch { /* frozen */ }
  try { if (ctx.state && ctx.state.measure !== m) Object.defineProperty(ctx.state, "measure", { value: m, configurable: true, writable: true, enumerable: false }); } catch { /* not extensible */ }
  return m;
}
/** The measure of a viewport or ctx if it exists. */
export const peekMeasure = (vpOrCtx) => registry.get(vpOrCtx?.viewport ?? vpOrCtx) ?? null;
/** Count a user of the shared measure; the last release disposes it. */
export function acquireMeasure(ctx) { const m = measureFor(ctx); m.refs++; return m; }
export function releaseMeasure(ctx) { const m = peekMeasure(ctx); if (!m) return; if (--m.refs <= 0) m.dispose(); }
