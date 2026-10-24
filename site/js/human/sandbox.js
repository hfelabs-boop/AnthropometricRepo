// The sandbox of the Digital human tab: the scene manager that holds the objects the figure is placed among (chairs, displays, boxes, tools),
// moves them (drag on the floor, gizmo, numeric fields, arrow keys), keeps their history, saves and loads scenes, and offers the hooks that
// later modules use to place the figure: anchors, supports and grips in WORLD coordinates, and "attach this object to a body point".
// Contract: docs/human3d/DESIGN.md 2.5, 3.4. Objects come from catalog.js. This file imports only three.js and catalog.js and never touches
// `document` / `window`: the DOM it needs comes through the viewport (events, container) and localStorage is optional and injected.
//
// World axes as everywhere: +Y up, +Z in front of the figure, +X the figure's left, metres; yaw is degrees about +Y (0 = the object's +Z along
// the world +Z). Events go out through ctx.emit("scene", { op, id, ... }) with op = add | remove | update | move | attach | load | restore |
// history, so measurements recompute; selection goes through ctx.select({ kind: "object", id }) and comes back as the shell's "selection" event.
//
// The top of the file is PURE (no three objects needed): snapping, yaw handling, scene validation, the free-spot search. They are unit-tested in
// Node without WebGL (tests/human3d/sandbox.test.mjs), and so is the whole Sandbox, against a stub viewport.
import * as THREE from "three";
import { byType, buildObject, disposeObject, normalizeParams, isHexColor, onAssetReady } from "./catalog.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const SCENE_APP = "digital-human-scene";
export const SCENE_VERSION = 1;
export const MAX_OBJECTS = 200;
export const MAX_TEXT = 4_000_000; // bytes of scene text accepted from a file or from localStorage
export const MAX_HISTORY = 100;
export const MAX_COORD = 1000; // metres: no object is placed further out than this (it would never be seen again)
export const GRID_STEPS_MM = Object.freeze([0, 5, 10, 25, 50, 100]);
export const ANGLE_STEPS = Object.freeze([0, 5, 15, 45, 90]);
const STORE_KEY = "hm-scene", REMEMBER_KEY = "hm-scene-remember";
const SECTIONS = Object.freeze(["measurements", "human"]); // the sections of a scene file that other modules own

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers
/** Round a length in metres to the nearest multiple of `stepMm` millimetres (0 = no snapping). Never returns -0. */
export function snapValue(v, stepMm) {
  if (!fin(v)) return v;
  if (!(stepMm > 0)) return v;
  const r = (Math.round((v * 1000) / stepMm) * stepMm) / 1000;
  return r === 0 ? 0 : r;
}
/** Wrap degrees into (-180, 180]. */
export function normalizeYaw(deg) {
  if (!fin(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360; else if (d <= -180) d += 360;
  return d === 0 ? 0 : d;
}
/** Round degrees to the nearest multiple of `step` (0 = no snapping) and wrap them. */
export function snapAngle(deg, step) { return normalizeYaw(step > 0 ? Math.round(deg / step) * step : deg); }
/** Yaw (degrees) of a quaternion that is a rotation about +Y (possibly composed with others: the heading of its +Z axis). */
export function yawOfQuaternion(q) {
  const x = 2 * (q.x * q.z + q.w * q.y), z = 1 - 2 * (q.x * q.x + q.y * q.y);
  return Math.atan2(x, z) * R2D;
}
/**
 * Which world axis an arrow key moves along, for a camera looking along (fx, fz) on the ground: Up = away from the camera, Right = to the
 * viewer's right, both snapped to the nearest world axis so a nudge is always axis-aligned. Returns [dx, dz] (unit axis vector) or null.
 */
export function arrowToWorld(key, fx, fz) {
  let ax = fx, az = fz;
  if (Math.hypot(ax, az) < 1e-6) { ax = 0; az = -1; }
  if (Math.abs(ax) > Math.abs(az)) { az = 0; ax = Math.sign(ax); } else { ax = 0; az = Math.sign(az); }
  const f = [ax, az], r = [-az, ax]; // right = forward x up
  const pick = { ArrowUp: f, ArrowDown: [-f[0], -f[1]], ArrowRight: r, ArrowLeft: [-r[0], -r[1]] }[key];
  return pick ? [pick[0] || 0, pick[1] || 0] : null;
}

/** Oriented rectangle { cx, cz, hx, hz, yaw (degrees) }: do two overlap (separating axis test, touching does not count)? */
export function rectsOverlap(a, b) {
  const axes = [];
  for (const r of [a, b]) { const c = Math.cos(r.yaw * D2R), s = Math.sin(r.yaw * D2R); axes.push([c, -s], [s, c]); }
  const proj = (r, ax) => {
    const c = Math.cos(r.yaw * D2R), s = Math.sin(r.yaw * D2R);
    const ux = [c, -s], uz = [s, c]; // the rectangle's local x and z axes in the ground plane (Ry(yaw): x -> (cos, -sin), z -> (sin, cos))
    const centre = r.cx * ax[0] + r.cz * ax[1];
    const ext = r.hx * Math.abs(ux[0] * ax[0] + ux[1] * ax[1]) + r.hz * Math.abs(uz[0] * ax[0] + uz[1] * ax[1]);
    return [centre - ext, centre + ext];
  };
  for (const ax of axes) {
    const pa = proj(a, ax), pb = proj(b, ax);
    if (pa[1] <= pb[0] + 1e-9 || pb[1] <= pa[0] + 1e-9) return false;
  }
  return true;
}
/** Is the point (x, z) inside the convex polygon [[x, z], ...] (either winding)? */
export function pointInPolygon(x, z, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    const cr = (x2 - x1) * (z - z1) - (z2 - z1) * (x - x1);
    if (Math.abs(cr) < 1e-12) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// Candidate offsets (metres) for the free-spot search, 0.1 m grid, 8 m by 8 m
const SPOTS = (() => {
  const out = [];
  for (let ix = -40; ix <= 40; ix++) for (let iz = -40; iz <= 40; iz++) out.push([ix / 10, iz / 10]);
  return out;
})();
/**
 * A spot where a footprint (half sizes hx, hz around its centre, offset (ox, oz) from the object's origin, yaw in degrees) overlaps none of
 * `others` (oriented rectangles { cx, cz, hx, hz, yaw }) nor the figure (`avoid`, a rectangle). Searches outwards from the place in front of the
 * figure (or from `near` = [x, z]) and prefers positions in front (z >= 0.6, clear of the figure). Returns [x, z] of the object's ORIGIN.
 */
export function findFreeSpot({ hx, hz, ox = 0, oz = 0, yaw = 0 }, others, avoid, near = null) {
  const c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R);
  const cx = ox * c + oz * s, cz = -ox * s + oz * c; // the footprint centre relative to the origin, in the world frame (Ry(yaw) applied to (ox, oz))
  const pref = near ?? [0, Math.max(0.8, hz + 0.6)];
  const order = SPOTS.map(([dx, dz]) => {
    const x = pref[0] + dx, z = pref[1] + dz;
    return [x, z, Math.hypot(dx, dz) + 0.001 * Math.abs(dx) + (dx < 0 ? 0.0005 : 0) + (z < 0.6 ? 1.2 * (0.6 - z) : 0) + (z < 0 ? 1.5 : 0)]; // keep clear of the figure: z < 0.6 costs extra, behind it more
  }).sort((p, q) => p[2] - q[2]);
  for (const [x, z] of order) {
    const r = { cx: x + cx, cz: z + cz, hx: hx + 0.04, hz: hz + 0.04, yaw };
    if (avoid && rectsOverlap(r, avoid)) continue;
    if (others.some((o) => rectsOverlap(r, o))) continue;
    return [round6(x), round6(z)];
  }
  return [round6(pref[0]), round6(pref[1] + 8)];
}

// ---------------------------------------------------------------------------------------------------------------------
// scene validation (hostile input is the normal case for a file the user opened)
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_REF = /^[A-Za-z0-9_:.-]{1,64}$/;
const printable = (s, n = 40) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);
const num3 = (v, lim) => Array.isArray(v) && v.length === 3 && v.every(fin) ? v.map((c) => clamp(c, -lim, lim)) : null;

/** Validate and clean an attachment record; returns { value, warning } (value null when it cannot be used). */
export function cleanAttachment(a) {
  if (a == null) return { value: null };
  if (!isObj(a)) return { value: null, warning: "an attachment was not an object and was ignored" };
  const kind = Object.hasOwn(a, "kind") ? a.kind : null, id = Object.hasOwn(a, "id") ? a.id : null;
  if ((kind !== "landmark" && kind !== "joint") || typeof id !== "string" || !SAFE_REF.test(id)) return { value: null, warning: "an attachment named no valid joint or landmark and was ignored" };
  const off = Object.hasOwn(a, "offset") ? num3(a.offset, 5) : null;
  return { value: { kind, id, offset: (off ?? [0, 0, 0]).map(round6), local: Object.hasOwn(a, "local") && a.local === true, orient: Object.hasOwn(a, "orient") && a.orient === true } };
}

/**
 * Validate a parsed scene file. Never throws. Returns { ok, objects, warnings, errors, extras } where `objects` are clean
 * { id|null, type, name, params, color, position, yaw, locked, visible, attachedTo } (unknown types skipped with a warning, numbers clamped to
 * the parameter ranges, only declared parameter keys copied, at most `maxObjects`), and `extras` the other top-level sections
 * ({ measurements, human, snap }) as they came (their owners validate them).
 */
export function validateScene(data, { maxObjects = MAX_OBJECTS } = {}) {
  const warnings = [], errors = [], objects = [], extras = {};
  let skipped = 0;
  const fail = (m) => ({ ok: false, objects: [], warnings, errors: [...errors, m], extras, skipped: 0 });
  if (!isObj(data)) return fail("This is not a scene file: it should be a JSON object.");
  const ver = Object.hasOwn(data, "version") ? data.version : undefined;
  if (!Number.isInteger(ver)) return fail("This file has no version number, so it is not a scene saved by this tool.");
  if (ver > SCENE_VERSION) return fail(`This scene was saved by a newer version of the tool (scene format ${ver}); this one reads format ${SCENE_VERSION}. Update the tool to open it.`);
  if (ver < 1) return fail(`Scene format ${ver} is not supported.`);
  if (!Object.hasOwn(data, "objects") || !Array.isArray(data.objects)) return fail("The scene file has no list of objects.");
  let list = data.objects;
  if (list.length > maxObjects) { warnings.push(`The file holds ${list.length} objects; only the first ${maxObjects} were read.`); list = list.slice(0, maxObjects); }
  const adjusted = [];
  list.forEach((raw, i) => {
    const n = i + 1;
    if (!isObj(raw)) { skipped++; warnings.push(`Object ${n} was skipped: it is not an object.`); return; }
    const type = Object.hasOwn(raw, "type") ? raw.type : undefined, spec = typeof type === "string" ? byType(type) : null;
    if (!spec) { skipped++; warnings.push(`Object ${n} was skipped: unknown type "${printable(type ?? "(none)")}".`); return; }
    const given = Object.hasOwn(raw, "params") && isObj(raw.params) ? raw.params : {};
    const params = normalizeParams(type, given);
    for (const ps of spec.params) {
      if (ps.kind !== "number" || !Object.hasOwn(given, ps.key)) continue;
      const g = given[ps.key];
      if (typeof g === "number" && Number.isFinite(g) && Math.abs(g - params[ps.key]) < 1e-9) continue;
      if (typeof g === "string" && g.trim() !== "" && Number(g) === params[ps.key]) continue;
      adjusted.push(`${spec.name}: "${ps.label}" was out of range and is now ${round6(params[ps.key])}`);
    }
    let position = Object.hasOwn(raw, "position") ? num3(raw.position, MAX_COORD) : null;
    if (!position) { if (Object.hasOwn(raw, "position")) warnings.push(`Object ${n} (${spec.name}) had no valid position and was put at the origin.`); position = [0, 0, 0]; }
    if (position[1] < 0) position[1] = 0;
    const att = cleanAttachment(Object.hasOwn(raw, "attachedTo") ? raw.attachedTo : null);
    if (att.warning) warnings.push(`Object ${n} (${spec.name}): ${att.warning}.`);
    const name = Object.hasOwn(raw, "name") && typeof raw.name === "string" && raw.name.trim() ? raw.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) : spec.name;
    objects.push({
      id: Object.hasOwn(raw, "id") && typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null,
      type, name, params, color: Object.hasOwn(raw, "color") && isHexColor(raw.color) ? raw.color.toLowerCase() : null,
      position: position.map(round6), yaw: round6(Object.hasOwn(raw, "yaw") && fin(raw.yaw) ? normalizeYaw(raw.yaw) : 0),
      locked: Object.hasOwn(raw, "locked") && raw.locked === true, visible: !(Object.hasOwn(raw, "visible") && raw.visible === false), attachedTo: att.value,
    });
  });
  if (adjusted.length) warnings.push(...adjusted.slice(0, 12), ...(adjusted.length > 12 ? [`... and ${adjusted.length - 12} more values were adjusted to their allowed range.`] : []));
  for (const k of ["measurements", "human", "snap"]) if (Object.hasOwn(data, k)) extras[k] = data[k];
  return { ok: true, objects, warnings, errors, extras, skipped };
}

/** Parse scene text (a file or a stored string): size-limited JSON.parse, then validateScene. Never throws. */
export function parseSceneText(text, opts) {
  if (typeof text !== "string") return { ok: false, objects: [], warnings: [], errors: ["The scene text is missing."], extras: {} };
  if (text.length > MAX_TEXT) return { ok: false, objects: [], warnings: [], errors: [`The scene file is too large (more than ${Math.round(MAX_TEXT / 1e6)} MB).`], extras: {} };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, objects: [], warnings: [], errors: [`The file is not valid JSON (${String(e.message).slice(0, 120)}).`], extras: {} }; }
  return validateScene(data, opts);
}

// ---------------------------------------------------------------------------------------------------------------------
// templates (environment presets): layouts around a figure standing at the origin facing +Z. Seat reference points sit about 0.55 m in front of the figure,
// so the figure stands behind the seat; displays and controls face the user (yaw 180). `group` sorts them in the Scene panel. `figure` (optional) says
// where the Scene panel puts the figure after loading: { sitOn: index of the seat in `objects`, posture } or { stand: [x, z], heading, posture } (a posture
// id of the library). Maintenance presets follow common shipboard / shop situations: a rack bay at chest height, a floor-level unit, a deck enclosure
// with gull-wing doors, a junction box with a lift-up lid.
export const TEMPLATE_GROUPS = Object.freeze(["Workstations", "Cockpits and cabins", "Maintenance", "Tasks", "Other"]);
const UAV_POSITION = (x, pilot) => [
  { type: "desk", position: [x, 0, 1.25], yaw: 180, params: { height: 0.74, width: 0.9, depth: 0.7 } },
  { type: "monitor", position: [x, 0.74, 1.45], yaw: 180, params: { diagonal: 24, centreHeight: 0.3, tilt: 0 } },
  { type: "monitor", position: [x, 0.74, 1.5], yaw: 180, params: { diagonal: 24, centreHeight: 0.66, tilt: 12 } },
  { type: "keyboard_mouse", position: [x, 0.74, 1.08], yaw: 180 },
  { type: "office_chair", position: [x, 0, 0.55], yaw: 0 },
  ...(pilot ? [{ type: "joystick", position: [x - 0.3, 0, 0.85], yaw: 180, params: { height: 0.68 } }, { type: "throttle", position: [x + 0.3, 0, 0.85], yaw: 180, params: { height: 0.68 } }] : []),
];
export const TEMPLATES = Object.freeze([
  { id: "empty", group: "Other", name: "Empty", description: "Clear the scene.", objects: [] },
  {
    id: "office", group: "Workstations", name: "Office workstation", description: "Desk, office chair, monitor and keyboard.",
    figure: { sitOn: 1, posture: "sit-typing" },
    objects: [
      { type: "desk", position: [0, 0, 1.25], yaw: 180 },
      { type: "office_chair", position: [0, 0, 0.55], yaw: 0 },
      { type: "monitor", position: [0, 0.74, 1.45], yaw: 180, params: { diagonal: 24, centreHeight: 0.3, tilt: 5 } },
      { type: "keyboard_mouse", position: [0, 0.74, 1.12], yaw: 180 },
    ],
  },
  {
    id: "uav_gcs", group: "Workstations", name: "UAV ground control station", description: "Two operator positions side by side, pilot (stick and throttle) and sensor operator, each with two stacked displays, a keyboard and a chair, and a shared wall display.",
    figure: { sitOn: 4, posture: "veh-operator-joysticks" },
    objects: [...UAV_POSITION(0, true), ...UAV_POSITION(-1.0, false), { type: "wall_display", position: [-0.5, 0, 2.6], yaw: 180, params: { diagonal: 65, centreHeight: 1.55 } }, { type: "wall", position: [-0.5, 0, 2.75], yaw: 180, params: { width: 3.2, height: 2.6 } }],
  },
  {
    id: "ops_room", group: "Workstations", name: "Operations room watch station", description: "A long desk with a 3 by 2 wall of monitors, keyboard and chair: surveillance and command-and-control consoles.",
    figure: { sitOn: 1, posture: "sit-typing" },
    objects: [
      { type: "desk", position: [0, 0, 1.25], yaw: 180, params: { height: 0.74, width: 1.8, depth: 0.8 } },
      { type: "office_chair", position: [0, 0, 0.55], yaw: 0 },
      ...[-0.47, 0, 0.47].flatMap((x) => [
        { type: "monitor", position: [x, 0.74, 1.5], yaw: 180, params: { diagonal: 21, centreHeight: 0.3, tilt: 0 } },
        { type: "monitor", position: [x, 0.74, 1.55], yaw: 180, params: { diagonal: 21, centreHeight: 0.62, tilt: 8 } },
      ]),
      { type: "keyboard_mouse", position: [0, 0.74, 1.05], yaw: 180 },
    ],
  },
  {
    id: "bridge_console", group: "Workstations", name: "Ship bridge console (standing)", description: "A standing-height console with a sloped control panel and a display above it, as on a ship's bridge.",
    figure: { stand: [0, 0], heading: 0, posture: "work-bench-standing" },
    objects: [
      { type: "console", position: [0, 0, 0.72], yaw: 180, params: { width: 1.4, depth: 0.7, height: 0.95, panelHeight: 0.25, panelAngle: 30 } },
      { type: "monitor", position: [0, 0.95, 0.98], yaw: 180, params: { diagonal: 27, centreHeight: 0.45, tilt: 15 } },
    ],
  },
  {
    id: "cab", group: "Cockpits and cabins", name: "Vehicle cab", description: "Cabin seat, steering wheel, pedals and a dashboard panel.",
    figure: { sitOn: 0, posture: "veh-driver-9-and-3" },
    objects: [
      { type: "cabin_seat", position: [0, 0, 0.6], yaw: 0, params: { seatHeight: 0.4, recline: 105 } },
      { type: "steering_wheel", position: [0, 0, 1.2], yaw: 180, params: { centreHeight: 0.72, tilt: 25 } },
      { type: "pedals", position: [-0.05, 0, 1.4], yaw: 180 },
      { type: "instrument_panel", position: [0, 0, 1.6], yaw: 180, params: { centreHeight: 0.95, tilt: 15, width: 0.9 } },
    ],
  },
  {
    id: "cockpit", group: "Cockpits and cabins", name: "Cockpit, fast jet", description: "A see-through canopy cockpit: reclined seat, centre stick, throttle on the left, side consoles, three displays and a HUD.",
    figure: { sitOn: 0, posture: "veh-cockpit-stick-throttle" },
    objects: [
      { type: "cabin_seat", position: [0, 0, 0.6], yaw: 0, params: { seatHeight: 0.35, recline: 100, panAngle: 8 } },
      { type: "joystick", position: [0, 0, 1.05], yaw: 180, params: { height: 0.62 } },
      { type: "throttle", position: [0.42, 0, 0.95], yaw: 180, params: { height: 0.62 } },
      { type: "triple_monitor", position: [0, 0, 1.6], yaw: 180, params: { centreHeight: 0.95, tilt: 10 } },
      { type: "hud_panel", position: [0, 0, 1.25], yaw: 180, params: { centreHeight: 1.12, tilt: 20 } },
      { type: "side_console", position: [0.5, 0, 0.45], yaw: 0, params: { length: 0.7, width: 0.2, height: 0.55 } },
      { type: "side_console", position: [-0.5, 0, 0.55], yaw: 0, params: { length: 0.9, width: 0.2, height: 0.55 } },
      { type: "cabin_shell", position: [0, 0, 0.75], yaw: 0, params: { width: 1.2, length: 2.6, height: 1.45, roof: "canopy", windscreen: 60 } },
    ],
  },
  {
    id: "helicopter", group: "Cockpits and cabins", name: "Helicopter cockpit", description: "Two-seat rotorcraft cockpit with a flat roof: pilot seat with cyclic between the knees, collective on the left, pedals, a wide instrument panel and the co-pilot seat.",
    figure: { sitOn: 0, posture: "veh-helicopter-pilot" },
    objects: [
      { type: "cabin_seat", position: [0, 0, 0.6], yaw: 0, params: { seatHeight: 0.4, recline: 102 } },
      { type: "joystick", position: [0, 0, 1.0], yaw: 180, params: { height: 0.6 } },
      { type: "lever", position: [0.28, 0, 0.75], yaw: 90, params: { length: 0.45, angle: 30, height: 0.3 } },
      { type: "pedals", position: [0, 0, 1.38], yaw: 180 },
      { type: "instrument_panel", position: [0.4, 0, 1.68], yaw: 180, params: { centreHeight: 0.92, tilt: 12, width: 1.5 } },
      { type: "cabin_seat", position: [0.85, 0, 0.6], yaw: 0, params: { seatHeight: 0.4, recline: 102 } },
      { type: "cabin_shell", position: [0.42, 0, 0.8], yaw: 0, params: { width: 1.9, length: 2.6, height: 1.6, roof: "flat", windscreen: 45 } },
    ],
  },
  {
    id: "rack_standing", group: "Maintenance", name: "Equipment rack, standing", description: "A 2 m electronics rack with its door open and the service bay at chest to eye height, and a toolbox at the maintainer's feet.",
    figure: { stand: [0, 0], heading: 0, posture: "reach-forward-shoulder" },
    objects: [
      { type: "equipment_rack", position: [0, 0, 0.78], yaw: 180, params: { width: 0.6, depth: 0.8, height: 2.0, bayBottom: 1.0, bayTop: 1.6, door: "side" } },
      { type: "equipment_rack", position: [0.65, 0, 0.78], yaw: 180, params: { width: 0.6, depth: 0.8, height: 2.0, bayBottom: 0.2, bayTop: 0.4, door: "none" } },
      { type: "toolbox", position: [-0.55, 0, 0.35], yaw: 0 },
    ],
  },
  {
    id: "floor_unit", group: "Maintenance", name: "Floor-level unit, kneeling", description: "A low equipment unit with its service bay near the floor, worked on kneeling on a mat, a multimeter-sized toolbox beside it.",
    figure: { stand: [0, 0], heading: 0, posture: "work-kneel-floor-level" },
    objects: [
      { type: "equipment_rack", position: [0, 0, 0.95], yaw: 180, params: { width: 0.7, depth: 0.6, height: 1.0, bayBottom: 0.12, bayTop: 0.7, door: "none", plinth: 0.1 } },
      { type: "floor_tile", position: [0, 0, 0.3], yaw: 0, params: { size: 0.8, thickness: 0.01 } },
      { type: "toolbox", position: [0.6, 0, 0.55], yaw: 0 },
    ],
  },
  {
    id: "deck_enclosure", group: "Maintenance", name: "Deck enclosure, gull-wing doors", description: "A deck-mounted equipment enclosure with two leaves swung up, the bay from knee to chest height, worked on kneeling on a cardboard mat with tools laid out.",
    figure: { stand: [0, 0], heading: 0, posture: "kneel-upright-toes" },
    objects: [
      { type: "equipment_rack", position: [0, 0, 0.85], yaw: 180, params: { width: 1.0, depth: 0.9, height: 1.6, bayBottom: 0.4, bayTop: 1.3, door: "gullwing", doorAngle: 125, plinth: 0.12 } },
      { type: "floor_tile", position: [0, 0, 0.15], yaw: 0, params: { size: 1.0, thickness: 0.006 }, color: "#c89f6e" },
      { type: "wrench", position: [0.45, 0, 0.1], yaw: 30 },
      { type: "screwdriver", position: [0.55, 0, -0.05], yaw: 80 },
    ],
  },
  {
    id: "junction_box", group: "Maintenance", name: "Junction box, lid lifted", description: "A wall- or mast-mounted junction box with its lid lifted, the cable terminations at chest height, worked on standing.",
    figure: { stand: [0, 0], heading: 0, posture: "reach-forward-shoulder" },
    objects: [
      { type: "equipment_rack", position: [0, 0, 0.62], yaw: 180, params: { width: 0.8, depth: 0.45, height: 1.45, bayBottom: 1.0, bayTop: 1.4, door: "lift", doorAngle: 115, plinth: 0.9 } },
    ],
  },
  {
    id: "lifting", group: "Tasks", name: "Lifting task", description: "A crate on a pallet and a shelving unit to lift it onto.",
    objects: [
      { type: "pallet", position: [0, 0, 1.0], yaw: 0 },
      { type: "crate", position: [0, 0.144, 1.0], yaw: 0, params: { width: 0.5, depth: 0.35, height: 0.3, mass: 15 } },
      { type: "shelving", position: [0, 0, 2.3], yaw: 180 },
    ],
  },
  {
    id: "range", group: "Tasks", name: "Rifle range bench", description: "Shooting bench with a rifle, a sandbag rest, an ammunition can and a seat.",
    objects: [
      { type: "bench", position: [0, 0, 0.55], yaw: 0, params: { length: 1.0 } },
      { type: "workbench", position: [0, 0, 1.15], yaw: 180, params: { height: 0.85, width: 1.5, depth: 0.6 } },
      { type: "rifle", position: [0, 0.85, 1.05], yaw: 0 },
      { type: "sandbag", position: [0, 0.85, 1.32], yaw: 0 },
      { type: "ammo_can", position: [0.5, 0.85, 1.1], yaw: 0 },
    ],
  },
  {
    id: "stairs", group: "Tasks", name: "Stairs and ladder", description: "A flight of stairs with handrails and a ladder leaning on a wall.",
    objects: [
      { type: "stairs", position: [-0.9, 0, 0.8], yaw: 0, params: { steps: 5, handrails: true } },
      { type: "ladder", position: [0.9, 0, 0.88], yaw: 0, params: { length: 2.4, angle: 75 } },
      { type: "wall", position: [0, 0, 1.62], yaw: 180, params: { width: 4.5, height: 3 } },
    ],
  },
]);

// ---------------------------------------------------------------------------------------------------------------------
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _box = new THREE.Box3(), _pl = new THREE.Plane();
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const DRAG_GAIN_MAX = 6; // a drag moves an object at most this many times the distance the pointer covers on the object's own depth (a view along the floor would give 10 to 100)

function edgesOf(box, pad = 0.004) {
  const a = box.min, b = box.max, x0 = a.x - pad, y0 = a.y - pad, z0 = a.z - pad, x1 = b.x + pad, y1 = b.y + pad, z1 = b.z + pad;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7], pos = [];
  for (const i of e) pos.push(...c[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * createSandbox({ viewport, ctx, storage?, scheduler? }) -> Sandbox. `viewport` is the Viewport of viewport.js (a stub in tests), `ctx` the panel ctx
 * of the shell (on, emit, select, getRig, units, toast). `storage` replaces localStorage; `scheduler(fn, ms)` replaces setTimeout (it returns a
 * cancel function) so tests need no timers.
 */
export function createSandbox({ viewport, ctx, storage, scheduler } = {}) {
  if (!viewport) throw new TypeError("createSandbox: a viewport is required");
  const emitCtx = (evt, data) => { try { ctx?.emit?.(evt, data); } catch (e) { console.error(`sandbox: "${evt}" listener failed:`, e); } };
  const later = scheduler ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const store = () => { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } };

  const root = new THREE.Group();
  root.name = "hm-sandbox";
  viewport.add?.(root);
  const objects = new Map();
  const unsubs = [];
  let seq = 0, selectedId = null, hoverId = null, disposed = false, gizmoMode = "translate", showNames = false, remember = false, floorLimit = 0;
  const snap = { gridMm: 0, angleDeg: 0 };
  const serializers = new Map();
  // Sections of a loaded scene whose module has not registered its serializer yet (the sandbox is created, and the remembered scene restored, before the
  // measure module exists): kept until it registers, and written back with the scene meanwhile, so a restore never loses or overwrites them.
  const pendingSections = new Map();

  const render = () => viewport.requestRender?.();
  const emitScene = (op, extra = {}) => emitCtx("scene", { op, ...extra });

  // ---- objects ----------------------------------------------------------------------------------------------------
  const newId = () => { let id; do { id = `o${++seq}`; } while (objects.has(id)); return id; };
  // `seq` follows the numbers in ids that came from a file, but only up to 9 digits: ID_RE lets "o" + 39 digits through, and above 2^53 `++seq` no longer
  // changes the number, so newId() would repeat one id for ever (a scene file, or the remembered scene, would freeze the page)
  const noteId = (id) => { const m = /^o(\d{1,9})$/.exec(id); if (m) seq = Math.max(seq, Number(m[1])); };
  const uniqueName = (spec) => {
    const used = new Set([...objects.values()].map((o) => o.name));
    if (!used.has(spec.name)) return spec.name;
    for (let n = 2; ; n++) if (!used.has(`${spec.name} ${n}`)) return `${spec.name} ${n}`;
  };

  function buildModel(obj) {
    if (obj.model) { obj.group.remove(obj.model); disposeObject(obj.model); }
    obj.model = buildObject(obj.type, obj.params, { color: obj.color });
    obj.model.traverse((o) => { o.userData.sandboxId = obj.id; });
    obj.group.add(obj.model);
    obj.bbox = obj.model.userData.bbox.clone();
    obj._anchors = byType(obj.type).anchors(obj.params);
    obj.group.updateMatrixWorld(true);
    if (selectedId === obj.id) refreshOutline(obj);
    if (hoverId === obj.id) refreshHover(obj);
  }

  function applyTransform(obj) {
    obj.group.position.set(obj.position[0], obj.position[1], obj.position[2]);
    obj.group.rotation.set(0, obj.yaw * D2R, 0);
    obj.group.visible = obj.visible;
    obj.group.updateMatrixWorld(true);
  }

  function makeObject(data) {
    const spec = byType(data.type);
    const id = data.id && !objects.has(data.id) ? data.id : newId();
    noteId(id);
    const obj = {
      id, type: data.type, name: data.name || uniqueName(spec), params: normalizeParams(data.type, data.params), color: isHexColor(data.color) ? data.color.toLowerCase() : null,
      position: [...data.position], yaw: normalizeYaw(data.yaw), locked: !!data.locked, visible: data.visible !== false, group: new THREE.Group(), model: null,
      attachedTo: data.attachedTo ? { ...data.attachedTo, offset: [...data.attachedTo.offset] } : null, attachError: null,
    };
    obj.group.name = id;
    obj.group.userData.sandboxId = id;
    objects.set(id, obj);
    root.add(obj.group);
    buildModel(obj);
    applyTransform(obj);
    return obj;
  }

  function destroyObject(obj) {
    if (selectedId === obj.id) clearSelectionState();
    // the shell's one selection must not keep pointing at an object that is gone
    if (ctx?.state?.selection?.kind === "object" && ctx.state.selection.id === obj.id) ctx.select?.(null);
    if (hoverId === obj.id) { hoverId = null; }
    disposeOutlines(obj);
    root.remove(obj.group);
    disposeObject(obj.model);
    objects.delete(obj.id);
  }

  // ---- history ----------------------------------------------------------------------------------------------------
  const serializeObject = (o) => ({
    id: o.id, type: o.type, name: o.name, params: { ...o.params }, color: o.color, position: o.position.map(round6), yaw: round6(o.yaw), locked: o.locked, visible: o.visible,
    ...(o.attachedTo ? { attachedTo: { ...o.attachedTo, offset: [...o.attachedTo.offset] } } : {}),
  });
  const serializeAll = () => [...objects.values()].map(serializeObject);
  const states = [];
  let hIdx = -1, hKey = null, hTime = 0, groupDepth = 0, groupDirty = false, groupLabel = "", groupExt = null, muted = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  // `ext` = { before, after } snapshots of the sections other modules keep in the scene file (the measurements), for a step that replaces them
  // (Open scene): the objects are in every state, the measurements are not (they have a life of their own), so only such a step carries them
  function commit(label, key, ext = null) {
    if (muted) return false;
    const json = JSON.stringify(serializeAll());
    if (!ext && hIdx >= 0 && states[hIdx].json === json) return false;
    const t = now();
    if (!ext && key && hKey === key && t - hTime < 1000 && hIdx === states.length - 1 && hIdx > 0) states[hIdx] = { json, label };
    else {
      states.length = hIdx + 1;
      states.push({ json, label, ext });
      if (states.length > MAX_HISTORY) states.shift();
      hIdx = states.length - 1;
    }
    hKey = key ?? null; hTime = t;
    emitScene("history", { label });
    scheduleSave();
    return true;
  }
  /** Record an undoable step now, or at the end of the open group. */
  function record(label, key) {
    if (muted) return;
    if (groupDepth) { groupDirty = true; groupLabel ||= label; return; }
    commit(label, key);
  }
  function beginGroup(label = "Edit") { if (groupDepth++ === 0) { groupDirty = false; groupLabel = label; } }
  function endGroup() {
    if (groupDepth === 0) return false;
    if (--groupDepth > 0) return false;
    const was = groupDirty, ext = groupExt;
    groupDirty = false; groupExt = null;
    hKey = null;
    return was ? commit(groupLabel, undefined, ext) : false;
  }
  /** Run fn as one undo step. */
  function grouped(label, fn) { beginGroup(label); try { return fn(); } finally { endGroup(); } }

  function applyState(json) {
    const list = JSON.parse(json), want = new Map(list.map((d) => [d.id, d]));
    muted++;
    try {
      for (const o of [...objects.values()]) if (!want.has(o.id)) destroyObject(o);
      for (const d of list) {
        const o = objects.get(d.id);
        if (!o) { makeObject(d); continue; }
        const rebuild = o.type !== d.type || o.color !== d.color || JSON.stringify(o.params) !== JSON.stringify(normalizeParams(d.type, d.params));
        o.type = d.type; o.params = normalizeParams(d.type, d.params); o.color = d.color;
        o.name = d.name; o.locked = d.locked; o.visible = d.visible; o.position = [...d.position]; o.yaw = d.yaw;
        o.attachedTo = d.attachedTo ? { ...d.attachedTo, offset: [...d.attachedTo.offset] } : null;
        if (rebuild) buildModel(o);
        applyTransform(o);
      }
      updateAttached();
    } finally { muted--; }
    if (selectedId && !objects.has(selectedId)) select(null);
    syncGizmo();
    render();
    emitScene("restore");
  }
  function undo() {
    if (groupDepth) endGroup();
    if (hIdx <= 0) return false;
    const ext = states[hIdx].ext;
    hIdx--; hKey = null;
    applyState(states[hIdx].json);
    if (ext) applySections(ext.before);
    emitScene("history"); scheduleSave();
    return true;
  }
  function redo() {
    if (hIdx >= states.length - 1) return false;
    hIdx++; hKey = null;
    applyState(states[hIdx].json);
    if (states[hIdx].ext) applySections(states[hIdx].ext.after);
    emitScene("history"); scheduleSave();
    return true;
  }

  // ---- placement --------------------------------------------------------------------------------------------------
  function footprintOf(obj, pos = obj.position, yaw = obj.yaw) {
    const b = obj.bbox, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R);
    return { cx: pos[0] + cx * c + cz * s, cz: pos[2] - cx * s + cz * c, hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2, yaw };
  }
  function figureRect() {
    const rig = ctx?.getRig?.(), r = rig?.root;
    return { cx: fin(r?.x) ? r.x : 0, cz: fin(r?.z) ? r.z : 0, hx: 0.32, hz: 0.25, yaw: 0 };
  }
  function freeSpotFor(type, params, yaw, near = null) {
    const m = buildObject(type, params);
    const b = m.userData.bbox.clone();
    disposeObject(m);
    const others = [...objects.values()].filter((o) => o.visible).map((o) => footprintOf(o));
    return findFreeSpot({ hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2, ox: (b.min.x + b.max.x) / 2, oz: (b.min.z + b.max.z) / 2, yaw }, others, figureRect(), near);
  }

  /**
   * Add an object of `type`. opts: { params, position [x, y, z] (default: a free spot in front of the figure), yaw, name, color, locked, visible, select, id, silent }.
   * Returns the SceneObject, or null when the scene already holds MAX_OBJECTS.
   */
  function add(type, opts = {}) {
    const spec = byType(type);
    if (!spec) throw new Error(`Unknown object type "${type}".`);
    if (objects.size >= MAX_OBJECTS) { ctx?.toast?.(`The scene is limited to ${MAX_OBJECTS} objects.`); return null; }
    const params = normalizeParams(type, opts.params);
    const yaw = normalizeYaw(opts.yaw ?? spec.defaultYaw);
    let position = opts.position;
    if (position && !(Array.isArray(position) ? position : [position.x, position.y, position.z]).every(fin)) position = null;
    if (position && !Array.isArray(position)) position = [position.x, position.y, position.z];
    if (!position) { const [x, z] = freeSpotFor(type, params, yaw, opts.near ?? null); position = [x, fin(opts.y) ? opts.y : 0, z]; }
    position = position.map((c) => clamp(c, -MAX_COORD, MAX_COORD));
    position[1] = Math.max(floorLimit, position[1]);
    const obj = makeObject({ id: opts.id, type, name: typeof opts.name === "string" && opts.name.trim() ? opts.name.trim().slice(0, 60) : null, params, color: opts.color, position, yaw, locked: opts.locked, visible: opts.visible });
    if (!opts.silent) { emitScene("add", { id: obj.id }); record(`Add ${obj.name}`); }
    render();
    if (opts.select) select(obj.id);
    return obj;
  }

  function remove(id) {
    const obj = objects.get(id);
    if (!obj) return false;
    destroyObject(obj);
    emitScene("remove", { id });
    record(`Delete ${obj.name}`);
    render();
    return true;
  }

  function duplicate(id, opts = {}) {
    const o = objects.get(id);
    if (!o) return null;
    return add(o.type, { params: { ...o.params }, color: o.color, yaw: o.yaw, name: null, near: [o.position[0] + 0.3, o.position[2] + 0.3], y: o.position[1], position: opts.position, select: opts.select });
  }

  function dropToFloor(id, opts = {}) { return move(id, { y: 0 }, { snap: false, ...opts, label: "Drop to the floor" }); }

  /** Put an object on the highest support surface under its centre that is not above it (the floor when there is none). */
  function dropToSurface(id, opts = {}) {
    const o = objects.get(id);
    if (!o || o.locked && !opts.force) return false;
    let best = 0;
    for (const s of supportsWorld()) {
      if (s.objectId === id || s.y > o.position[1] + 0.02) continue;
      if (pointInPolygon(o.position[0], o.position[2], s.polygon)) best = Math.max(best, s.y);
    }
    return move(id, { y: best }, { snap: false, ...opts, label: "Rest on a surface" });
  }

  const asXYZ = (p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p ?? {});
  /**
   * Move an object to { x, y, z } (any component may be left out; an array [x, y, z] works too). opts: { snap = true: grid, floor = true, force: also a
   * locked object, silent, label }. Locked objects do not move. An attached object changes its offset from the body point instead.
   */
  function move(id, pos, opts = {}) {
    const o = objects.get(id);
    if (!o || (o.locked && !opts.force)) return false;
    const p = asXYZ(pos), np = [...o.position];
    for (const [i, k] of ["x", "y", "z"].entries()) if (p[k] !== undefined) { if (!fin(p[k])) return false; np[i] = p[k]; }
    if (opts.snap !== false && snap.gridMm > 0) for (const [i, k] of ["x", "y", "z"].entries()) if (p[k] !== undefined) np[i] = snapValue(np[i], snap.gridMm);
    for (let i = 0; i < 3; i++) np[i] = clamp(np[i], -MAX_COORD, MAX_COORD);
    if (opts.floor !== false) np[1] = Math.max(floorLimit, np[1]);
    if (np.every((v, i) => v === o.position[i])) return false;
    if (o.attachedTo) {
      const t = attachmentTarget(o.attachedTo);
      if (!t) return false;
      const off = [np[0] - t.pos.x, np[1] - t.pos.y, np[2] - t.pos.z];
      o.attachedTo.offset = (o.attachedTo.local ? new THREE.Vector3(...off).applyQuaternion(t.quat.clone().invert()).toArray() : off).map((c) => round6(clamp(c, -5, 5)));
      updateAttached();
    } else { o.position = np; applyTransform(o); }
    if (!opts.silent) { emitScene("move", { id }); record(opts.label ?? `Move ${o.name}`, opts.key ?? `move:${id}`); }
    render();
    return true;
  }

  /** Set the yaw (degrees about +Y). opts as move(); snap uses the angle step. */
  function rotate(id, yaw, opts = {}) {
    const o = objects.get(id);
    if (!o || (o.locked && !opts.force) || !fin(yaw)) return false;
    let y = normalizeYaw(yaw);
    if (opts.snap !== false && snap.angleDeg > 0) y = snapAngle(y, snap.angleDeg);
    if (y === o.yaw) return false;
    o.yaw = y;
    if (o.attachedTo) updateAttached(); else applyTransform(o);
    if (!opts.silent) { emitScene("move", { id }); record(opts.label ?? `Rotate ${o.name}`, opts.key ?? `rot:${id}`); }
    render();
    return true;
  }

  /** Move by (dx, dz, dy) metres. */
  function nudge(id, dx = 0, dz = 0, dy = 0, opts = {}) {
    const o = objects.get(id);
    if (!o) return false;
    return move(id, { x: o.position[0] + dx, y: o.position[1] + dy, z: o.position[2] + dz }, { snap: false, key: `nudge:${id}`, ...opts, label: `Move ${o.name}` });
  }

  const PATCH_KEYS = ["name", "color", "locked", "visible", "position", "yaw", "params"];
  /** Change several things at once: patch = { name, color, locked, visible, position, yaw, params }. One undo step. */
  function update(id, patch, opts = {}) {
    const o = objects.get(id);
    if (!o || !isObj(patch)) return false;
    let changed = false;
    grouped(opts.label ?? `Edit ${o.name}`, () => {
      for (const k of Object.keys(patch)) {
        if (!PATCH_KEYS.includes(k)) continue;
        const v = patch[k];
        if (k === "name" && typeof v === "string" && v.trim() && v.trim().slice(0, 60) !== o.name) { o.name = v.trim().slice(0, 60); changed = true; }
        else if (k === "color" && (v === null || isHexColor(v)) && (v?.toLowerCase() ?? null) !== o.color) { o.color = v ? v.toLowerCase() : null; buildModel(o); changed = true; }
        else if (k === "locked" && typeof v === "boolean" && v !== o.locked) { o.locked = v; changed = true; syncGizmo(); }
        else if (k === "visible" && typeof v === "boolean" && v !== o.visible) { o.visible = v; applyTransform(o); changed = true; if (!v && selectedId === id) select(null); }
        else if (k === "position") changed = move(id, v, { ...opts, silent: true }) || changed;
        else if (k === "yaw") changed = rotate(id, v, { ...opts, silent: true }) || changed;
        else if (k === "params" && isObj(v)) { for (const [pk, pv] of Object.entries(v)) changed = setParam(id, pk, pv, { silent: true }) || changed; }
      }
      if (changed) { emitScene("update", { id }); record(opts.label ?? `Edit ${o.name}`); }
    });
    if (changed) render();
    return changed;
  }

  /** Set one parameter (clamped to its range), rebuild the geometry, keep the transform. */
  function setParam(id, key, value, opts = {}) {
    const o = objects.get(id), spec = o && byType(o.type);
    if (!o || typeof key !== "string" || !spec.params.some((p) => p.key === key)) return false;
    const next = normalizeParams(o.type, { ...o.params, [key]: value });
    if (next[key] === o.params[key]) return false;
    o.params = next;
    buildModel(o);
    if (!opts.silent) { emitScene("update", { id, key }); record(`Change ${spec.params.find((p) => p.key === key).label.toLowerCase()}`, `param:${id}:${key}`); }
    render();
    return true;
  }
  function setParams(id, patch, opts = {}) { return update(id, { params: patch }, opts); }

  function rename(id, name) { return update(id, { name }, { label: "Rename" }); }
  function setLocked(id, v) { return update(id, { locked: !!v }, { label: v ? "Lock" : "Unlock" }); }
  function setVisible(id, v) { return update(id, { visible: !!v }, { label: v ? "Show" : "Hide" }); }
  function clear(opts = {}) {
    if (!objects.size) return false;
    grouped("Clear the scene", () => { for (const o of [...objects.values()]) destroyObject(o); emitScene("clear"); record("Clear the scene"); });
    render();
    return !opts.silent;
  }

  // ---- selection, hover, outlines -----------------------------------------------------------------------------------
  const accent = () => viewport.theme?.accent ?? new THREE.Color(0x2a78d6);
  function lineFor(obj, opacity, key) {
    const mat = new THREE.LineBasicMaterial({ color: accent(), depthTest: false, transparent: true, opacity });
    const l = new THREE.LineSegments(edgesOf(obj.bbox), mat);
    l.name = key; l.renderOrder = 20; l.raycast = () => {};
    l.userData.noPick = true;
    obj.group.add(l);
    return l;
  }
  function disposeLine(l) { if (!l) return; l.parent?.remove(l); l.geometry.dispose(); l.material.dispose(); }
  function disposeOutlines(obj) { disposeLine(obj._outline); disposeLine(obj._hover); obj._outline = obj._hover = null; }
  function refreshOutline(obj) { disposeLine(obj._outline); obj._outline = lineFor(obj, 0.95, "selection"); render(); }
  function refreshHover(obj) { disposeLine(obj._hover); obj._hover = lineFor(obj, 0.5, "hover"); render(); }

  function clearSelectionState() {
    const o = objects.get(selectedId);
    if (o) { disposeLine(o._outline); o._outline = null; }
    selectedId = null;
    viewport.detachGizmo?.();
    render();
  }
  function syncSelection(sel) {
    const id = sel && sel.kind === "object" && objects.has(sel.id) ? sel.id : null;
    if (id === selectedId) return;
    if (selectedId) clearSelectionState();
    selectedId = id;
    if (id) { refreshOutline(objects.get(id)); syncGizmo(); }
    render();
  }
  /** Select an object (or nothing). Goes through ctx.select so the shell's single selection stays in step. */
  function select(id) {
    if (id != null && !objects.has(id)) return false;
    if (ctx?.select) ctx.select(id == null ? null : { kind: "object", id });
    else syncSelection(id == null ? null : { kind: "object", id });
    // a ctx that did not route the change back (it does in the shell) is brought in step here
    if ((id ?? null) !== selectedId) syncSelection(id == null ? null : { kind: "object", id });
    return true;
  }
  function hover(id) {
    id = id != null && objects.has(id) && id !== selectedId ? id : null;
    if (id === hoverId) return;
    const prev = objects.get(hoverId);
    if (prev) { disposeLine(prev._hover); prev._hover = null; }
    hoverId = id;
    if (id) refreshHover(objects.get(id));
    render();
  }

  // ---- gizmo ----------------------------------------------------------------------------------------------------------
  const gizmoState = { active: false, start: null };
  function effectiveMode(o) { return gizmoMode === "scale" && !byType(o.type).scaleMap ? "translate" : gizmoMode; }
  function syncGizmo() {
    const o = objects.get(selectedId);
    if (!o || !gizmoEnabled || gizmoMode === "none" || o.locked || o.attachedTo || !o.visible) { viewport.detachGizmo?.(); return; }
    const mode = effectiveMode(o);
    viewport.attachGizmo?.(o.group, { mode, space: "world", snap: gizmoSnap() });
    const g = viewport.gizmo;
    if (g) { g.showX = mode !== "rotate"; g.showZ = mode !== "rotate"; g.showY = true; }
    render();
  }
  const gizmoSnap = () => ({ translate: snap.gridMm > 0 ? snap.gridMm / 1000 : null, rotate: snap.angleDeg > 0 ? snap.angleDeg : null, scale: null });
  function setGizmoMode(mode) {
    if (!["translate", "rotate", "scale", "none"].includes(mode) || mode === gizmoMode) return false;
    gizmoMode = mode;
    syncGizmo();
    emitScene("update", { op2: "gizmo" });
    return true;
  }
  function setSnap(patch = {}) {
    if (patch.gridMm !== undefined) { if (!GRID_STEPS_MM.includes(patch.gridMm)) return false; snap.gridMm = patch.gridMm; }
    if (patch.angleDeg !== undefined) { if (!ANGLE_STEPS.includes(patch.angleDeg)) return false; snap.angleDeg = patch.angleDeg; }
    viewport.setGizmoOptions?.({ snap: gizmoSnap() });
    return true;
  }

  const gizmoObject = () => { const g = viewport.gizmo?.object; return g ? objects.get(g.userData.sandboxId) : null; };
  function onGizmoStart() { const o = gizmoObject(); if (!o) return; gizmoState.active = true; gizmoState.start = { params: { ...o.params }, mode: viewport.gizmo?.mode }; beginGroup(`Move ${o.name}`); cancelDrag(); }
  function onGizmoChange() {
    const o = gizmoObject();
    if (!o || o.locked) return;
    const g = o.group, mode = viewport.gizmo?.mode ?? gizmoMode;
    if (mode === "translate") {
      const y = Math.max(floorLimit, g.position.y);
      o.position = [clamp(g.position.x, -MAX_COORD, MAX_COORD), y, clamp(g.position.z, -MAX_COORD, MAX_COORD)];
      g.position.set(o.position[0], o.position[1], o.position[2]);
    } else if (mode === "rotate") {
      g.updateMatrixWorld(true);
      o.yaw = normalizeYaw(yawOfQuaternion(g.quaternion));
      g.rotation.set(0, o.yaw * D2R, 0);
    } else if (mode === "scale" && gizmoState.start) {
      const map = byType(o.type).scaleMap, sc = g.scale, start = gizmoState.start.params, factor = {};
      if (map) {
        // a parameter driven by several axes (a cylinder's diameter) takes the factor that moved furthest from 1
        for (const [axis, key] of Object.entries(map)) { const f = sc[axis], cur = factor[key]; if (cur === undefined || Math.abs(f - 1) > Math.abs(cur - 1)) factor[key] = f; }
        const next = {};
        for (const [key, f] of Object.entries(factor)) next[key] = start[key] * f;
        o.params = normalizeParams(o.type, { ...o.params, ...next });
        buildModel(o);
      }
      g.scale.set(1, 1, 1);
    }
    o.group.updateMatrixWorld(true);
    emitScene("move", { id: o.id, live: true });
    render();
  }
  function onGizmoEnd() {
    const o = gizmoObject();
    gizmoState.active = false; gizmoState.start = null;
    if (o) { emitScene("move", { id: o.id }); record(`Move ${o.name}`); }
    endGroup();
  }

  // ---- picking and dragging -----------------------------------------------------------------------------------------------
  const suspended = new Set();
  let inputEnabled = true, pickEnabled = true, dragEnabled = true, gizmoEnabled = true;
  const inputOn = () => inputEnabled && suspended.size === 0 && !disposed;

  function pickTargets() { const t = []; for (const o of objects.values()) if (o.visible && o.model) t.push(o.model); return t; }
  /** Distance along the ray to the figure's skin when it is shown and solid (it hides what is behind it), else Infinity. A skinned ray test is slow, so it runs only once an object is hit. */
  function skinDistance(ray) {
    const rig = ctx?.getRig?.(), skin = rig?.skin;
    if (!skin || rig.display?.xray) return Infinity; // x-ray: the figure is see-through, what is behind it can be picked
    for (let n = skin; n; n = n.parent) if (n.visible === false) return Infinity;
    try { return ray.intersectObject(skin, true)[0]?.distance ?? Infinity; } catch { return Infinity; }
  }
  /**
   * The nearest visible object under a client position: { obj, point: Vector3, distance } or null. An object behind the figure is not under the
   * pointer (the press belongs to the figure); `ignoreFigure` skips that test for a caller that compares with the skin itself (the measuring tool).
   */
  function pickAt(clientX, clientY, { ignoreFigure = false } = {}) {
    const targets = pickTargets();
    if (!targets.length || !viewport.ray) return null;
    const ray = viewport.ray(clientX, clientY);
    const hits = ray.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.object.userData.noPick) continue;
      let n = h.object;
      while (n && !n.userData?.sandboxId) n = n.parent;
      const obj = n && objects.get(n.userData.sandboxId);
      if (!obj) continue;
      if (!ignoreFigure && skinDistance(ray) < h.distance) return null;
      return { obj, point: h.point.clone(), distance: h.distance };
    }
    return null;
  }

  let drag = null, cursorOwned = false; // cursorOwned: this module set the "move" / "grabbing" cursor (and must restore it; the shell sets its own over joints)
  let heldTouch = null; // the orbit controls' one-finger action while a finger is down on an object (see holdOrbit)
  /**
   * The press belongs to the object, not to the orbit controls. A mouse press just switches the controls off. A finger must not: controls that
   * never saw the first finger cannot make a pinch of it when the second one lands, so the one-finger action is parked instead and the controls
   * switch off only once the drag really starts (dragStarted).
   */
  function holdOrbit(touch) {
    const c = viewport.controls;
    if (!c) return;
    if (touch && c.touches) { heldTouch = { one: c.touches.ONE }; c.touches.ONE = -1; } else c.enabled = false;
  }
  function releaseOrbit() {
    const c = viewport.controls;
    if (!c) return;
    if (heldTouch) { if (c.touches) c.touches.ONE = heldTouch.one; heldTouch = null; }
    c.enabled = (viewport.active === undefined ? true : !!viewport.active) && !viewport.gizmoDragging;
  }
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) endGroup();
    releaseOrbit();
    if (cursorOwned) { cursorOwned = false; viewport.setCursor?.("grab"); }
  }
  function planeHit(ev, plane, out) { const ray = viewport.ray(ev.clientX, ev.clientY); return ray.ray.intersectPlane(plane, out) ? out : null; }
  function setupDragPlane(ev) {
    const d = drag, o = objects.get(d.id);
    d.vertical = !!ev.shift;
    if (d.vertical) {
      const cam = viewport.camera, f = _v.set(0, 0, 0);
      cam.getWorldDirection(f);
      f.y = 0;
      if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
      f.normalize();
      _pl.setFromNormalAndCoplanarPoint(f, _v2.set(o.position[0], o.position[1], o.position[2]));
    } else _pl.set(new THREE.Vector3(0, 1, 0), -o.position[1]);
    d.plane = _pl.clone();
    d.grab = planeHit(ev, d.plane, new THREE.Vector3());
    d.start = [...o.position];
    d.ax = ev.clientX; d.ay = ev.clientY;
    // metres per pixel at the depth of the object under the pointer (not of the plane point behind it, which is far away on a grazing view); see DRAG_GAIN_MAX
    const a = viewport.ray(ev.clientX, ev.clientY).ray, d0 = a.direction.clone(), d1 = viewport.ray(ev.clientX + 1, ev.clientY).ray.direction;
    d.pxScale = d0.angleTo(d1) * d.dist;
  }
  function onPointerDown(ev) {
    // a second pointer (a pinch), another button, or input switched off: whatever was being dragged stops, and the camera gets the gesture
    if (!inputOn() || !dragEnabled || ev.button !== 0 || ev.originalEvent?.isPrimary === false) { cancelDrag(); return; }
    cancelDrag(); // a stale drag (a pointerup that never came)
    if (viewport.gizmo?.axis) return; // the pointer is on a gizmo handle: the gizmo owns this press
    const hit = pickAt(ev.clientX, ev.clientY);
    if (!hit || hit.obj.locked || hit.obj.attachedTo) return;
    drag = { id: hit.obj.id, dist: hit.distance, x0: ev.clientX, y0: ev.clientY, moved: false, pointerId: ev.originalEvent?.pointerId };
    setupDragPlane(ev);
    if (!drag.grab) { drag = null; return; }
    holdOrbit(ev.pointerType === "touch");
    try { if (drag.pointerId != null) viewport.canvas?.setPointerCapture?.(drag.pointerId); } catch { /* not capturable */ }
  }
  function onPointerMove(ev) {
    if (drag) {
      if (viewport.gizmoDragging) { cancelDrag(); return; }
      if (!drag.moved) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
        drag.moved = true;
        if (viewport.controls) viewport.controls.enabled = false;
        beginGroup(`Move ${objects.get(drag.id)?.name ?? "object"}`);
        select(drag.id);
        cursorOwned = true;
        viewport.setCursor?.("grabbing");
      }
      const o = objects.get(drag.id);
      if (!o) { cancelDrag(); return; }
      if (!!ev.shift !== drag.vertical) setupDragPlane(ev); // Shift pressed or released mid-drag: re-anchor so the object does not jump
      const p = planeHit(ev, drag.plane, new THREE.Vector3());
      if (!p) return;
      let dx = p.x - drag.grab.x, dy = p.y - drag.grab.y, dz = p.z - drag.grab.z;
      const len = Math.hypot(dx, dy, dz), cap = DRAG_GAIN_MAX * (drag.pxScale || 0) * Math.hypot(ev.clientX - drag.ax, ev.clientY - drag.ay);
      if (drag.pxScale && len > cap) { const k = cap / len; dx *= k; dy *= k; dz *= k; }
      const target = drag.vertical ? { y: drag.start[1] + dy } : { x: drag.start[0] + dx, z: drag.start[2] + dz };
      move(drag.id, target, { snap: !ev.alt, label: `Move ${o.name}` });
      return;
    }
    scheduleHover(ev);
  }
  function onPointerUp() { if (drag) cancelDrag(); }
  // a cancelled pointer (the browser took the touch over for scrolling, a call came in) sends no pointerup: end the drag here, so that the orbit controls and the undo group are not left stuck
  const onPointerCancel = () => cancelDrag();
  // The hover pick runs at most every HOVER_GAP ms, and never takes more than a quarter of the time: with the figure's skin in the way one pick costs about 10 ms
  // (a skinned ray test of ~19k triangles) and a mouse reports far more often than that, so the gap grows to 4 times what the last pick cost.
  const HOVER_GAP = 30;
  let hoverEv = null, hoverQueued = false, hoverLast = -Infinity, hoverCost = 0;
  function scheduleHover(ev) {
    if (!inputOn() || !pickEnabled || ev.buttons || ev.pointerType === "touch") return;
    hoverEv = ev;
    if (hoverQueued) return;
    hoverQueued = true;
    later(() => {
      hoverQueued = false;
      hoverLast = now();
      if (disposed || !hoverEv || drag) return;
      const h = pickAt(hoverEv.clientX, hoverEv.clientY);
      hoverCost = now() - hoverLast;
      hover(h?.obj.id ?? null);
      const want = !!h && !h.obj.locked && !h.obj.attachedTo;
      if (want !== cursorOwned) { cursorOwned = want; viewport.setCursor?.(want ? "move" : "grab"); }
    }, Math.max(0, Math.max(HOVER_GAP, 4 * hoverCost) - (now() - hoverLast)));
  }
  function onClick(ev) {
    if (ev.handled || !inputOn() || !pickEnabled) return;
    const h = pickAt(ev.clientX, ev.clientY);
    if (h) { ev.handled = true; select(h.obj.id); }
  }

  // ---- keyboard --------------------------------------------------------------------------------------------------------------
  const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ""));
  /**
   * Handle a keydown from the 3D view or the Scene panel. Returns true when it was used (the caller then stops the event). `objectKeys: false` (the
   * Scene panel: focus is on a button, a card, a swatch) leaves only Ctrl+Z / Y / D: Delete, W, E, R, [ ] and the arrows then belong to the control.
   */
  function onKey(e, { arrows = true, objectKeys = true } = {}) {
    // keys edit the scene, so they work only while editing is on (the Scene panel is shown): in the Measure or Posture tab Delete and the arrow keys are not ours
    if (!inputOn() || !dragEnabled || e.defaultPrevented || typing(e.target)) return false;
    const mod = e.ctrlKey || e.metaKey, k = e.key, id = selectedId, o = id && objects.get(id);
    if (mod && !e.altKey) {
      if (k === "z" || k === "Z") { e.shiftKey ? redo() : undo(); return true; }
      if (k === "y" || k === "Y") { redo(); return true; }
      if ((k === "d" || k === "D") && o) { duplicate(id, { select: true }); return true; }
      return false;
    }
    if (mod || !objectKeys) return false;
    if (!o) return false;
    if (k === "Delete" || k === "Backspace") { if (o.locked) { ctx?.toast?.(`"${o.name}" is locked. Unlock it to delete it.`); return true; } remove(id); return true; }
    if (k === "w" || k === "W") return setGizmoMode("translate") || true;
    if (k === "e" || k === "E") return setGizmoMode("rotate") || true;
    if (k === "r" || k === "R") return setGizmoMode("scale") || true;
    if (k === "[" || k === "]") { if (!o.locked) rotate(id, o.yaw + (k === "]" ? 1 : -1) * (snap.angleDeg || 5) * (e.shiftKey ? 3 : 1), { snap: true }); return true; }
    if (arrows && k.startsWith("Arrow")) {
      if (o.locked || o.attachedTo) { ctx?.toast?.(o.attachedTo ? "Detach the object before moving it." : `"${o.name}" is locked.`); return true; }
      const f = viewport.camera ? viewport.camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(0, 0, -1);
      const dir = arrowToWorld(k, f.x, f.z);
      if (!dir) return false;
      const step = ((snap.gridMm > 0 ? snap.gridMm : 10) * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1)) / 1000;
      nudge(id, dir[0] * step, dir[1] * step, 0, { snap: false, key: `nudge:${id}:${k}` }); // holding one arrow key is one undo step; another direction is another
      return true;
    }
    return false;
  }
  // capture phase on the viewport container: runs before OrbitControls' own arrow-key panning on the canvas, and survives a rebuilt canvas
  // only keys pressed on the 3D view itself: a button inside the container (or any other control) has its own meaning for Delete and the letters
  const onContainerKey = (e) => { if (e.target !== viewport.canvas && e.target !== viewport.container) return; if (onKey(e)) { e.preventDefault(); e.stopPropagation(); } };
  viewport.container?.addEventListener?.("keydown", onContainerKey, true);
  viewport.container?.addEventListener?.("pointercancel", onPointerCancel, true);

  // ---- attachments (an object follows a joint or landmark of the figure) ----------------------------------------------------------
  function attachmentTarget(att) {
    const rig = ctx?.getRig?.();
    if (!rig) return null;
    try {
      const pos = att.kind === "joint" ? rig.jointWorld(att.id, new THREE.Vector3()) : rig.landmarkWorld(att.id, new THREE.Vector3());
      const jid = att.kind === "joint" ? att.id : rig.body?.landmarks?.[att.id]?.joint;
      let quat = new THREE.Quaternion();
      if (jid) { try { rig.jointQuaternion(jid, quat); } catch { quat = new THREE.Quaternion(); } }
      return { pos, quat };
    } catch { return null; }
  }
  function updateAttached() {
    let any = false;
    for (const o of objects.values()) {
      if (!o.attachedTo) continue;
      const t = attachmentTarget(o.attachedTo);
      if (!t) { o.attachError = ctx?.getRig?.() ? `The figure has no ${o.attachedTo.kind} "${o.attachedTo.id}".` : "There is no figure to attach to yet."; continue; }
      o.attachError = null;
      const off = new THREE.Vector3(...o.attachedTo.offset);
      if (o.attachedTo.local) off.applyQuaternion(t.quat);
      o.position = [t.pos.x + off.x, Math.max(floorLimit, t.pos.y + off.y), t.pos.z + off.z].map(round6);
      o.group.position.set(...o.position);
      if (o.attachedTo.orient) o.group.quaternion.copy(t.quat).multiply(_q.setFromAxisAngle(_v.set(0, 1, 0), o.yaw * D2R));
      else o.group.rotation.set(0, o.yaw * D2R, 0);
      o.group.updateMatrixWorld(true);
      any = true;
    }
    if (any) { emitScene("move", { attached: true }); render(); }
  }
  /**
   * Make an object follow a joint or landmark of the figure: target = { kind: "landmark" | "joint", id }; offset [x, y, z] metres in world axes
   * (or in the joint's own frame with opts.local); opts.orient also follows the orientation of the joint. The object is updated on every "pose"
   * and "rig" event. Returns false when the object is unknown.
   */
  function attach(id, target, offset = [0, 0, 0], opts = {}) {
    const o = objects.get(id);
    const att = cleanAttachment({ kind: target?.kind, id: target?.id, offset, local: !!opts.local, orient: !!opts.orient });
    if (!o || !att.value) return false;
    o.attachedTo = att.value;
    syncGizmo();
    updateAttached();
    emitScene("attach", { id });
    record(`Attach ${o.name}`);
    return true;
  }
  /** Stop following. The object stays where it is, upright (only its yaw is kept). */
  function detach(id) {
    const o = objects.get(id);
    if (!o || !o.attachedTo) return false;
    if (o.attachedTo.orient) o.yaw = normalizeYaw(yawOfQuaternion(o.group.quaternion)); // keep the heading, drop pitch and roll
    o.attachedTo = null; o.attachError = null;
    applyTransform(o);
    syncGizmo();
    emitScene("attach", { id });
    record(`Detach ${o.name}`);
    render();
    return true;
  }

  // ---- world queries (hooks for the placement and measurement modules) --------------------------------------------------------------
  const ready = (o) => { o.group.updateMatrixWorld(true); return o.group.matrixWorld; };
  /** World position of an anchor of an object (into `out`); null when the object or the anchor does not exist. */
  function anchorWorld(objectId, anchorId, out = new THREE.Vector3()) {
    const o = objects.get(objectId), a = o?._anchors && Object.hasOwn(o._anchors, anchorId) ? o._anchors[anchorId] : null;
    if (!a) return null;
    return out.set(a.position[0], a.position[1], a.position[2]).applyMatrix4(ready(o));
  }
  /** World direction of an anchor's normal (viewing direction of a screen), or null. */
  function anchorNormalWorld(objectId, anchorId, out = new THREE.Vector3()) {
    const o = objects.get(objectId), a = o?._anchors && Object.hasOwn(o._anchors, anchorId) ? o._anchors[anchorId] : null;
    if (!a?.normal) return null;
    return out.set(a.normal[0], a.normal[1], a.normal[2]).transformDirection(ready(o));
  }
  /** All anchors of an object: { id: { label, position: Vector3, normal: Vector3 | null } } in world coordinates ({} for an unknown object). */
  function anchorsWorld(objectId) {
    const o = objects.get(objectId), out = {};
    if (!o) return out;
    for (const [id, a] of Object.entries(o._anchors)) out[id] = { label: a.label, position: anchorWorld(objectId, id), normal: anchorNormalWorld(objectId, id) };
    return out;
  }
  /** World position of a point given in an object's local frame. */
  function localToWorld(objectId, local, out = new THREE.Vector3()) { const o = objects.get(objectId); return o ? out.set(local[0], local[1], local[2]).applyMatrix4(ready(o)) : null; }
  /** Inverse: a world point into an object's local frame. */
  function worldToLocal(objectId, p, out = new THREE.Vector3()) { const o = objects.get(objectId); return o ? out.copy(p).applyMatrix4(_m.copy(ready(o)).invert()) : null; }

  /** Horizontal surfaces a body can rest on: [{ objectId, id, name, y (world), polygon [[x, z] x4 world], size, pitch }]. */
  function supportsWorld() {
    const out = [];
    for (const o of objects.values()) {
      if (!o.visible) continue;
      const m = ready(o);
      for (const s of byType(o.type).supports(o.params)) {
        const [cx, cz] = s.center, hw = s.size[0] / 2, hd = s.size[1] / 2;
        const polygon = [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]].map(([x, z]) => { _v.set(x, s.y, z).applyMatrix4(m); return [round6(_v.x), round6(_v.z)]; });
        _v.set(cx, s.y, cz).applyMatrix4(m);
        out.push({ objectId: o.id, id: s.id, name: `${o.name}: ${s.label}`, y: round6(_v.y), polygon, size: [...s.size], pitch: s.pitch ?? 0 });
      }
    }
    return out;
  }
  /** Grip frames of an object in world coordinates: { id, label, hand, objectId, position, normal, axis (Vector3), quaternion, matrix, diameter }. */
  function gripsWorld(objectId) {
    const o = objects.get(objectId);
    if (!o) return [];
    const m = ready(o);
    return byType(o.type).grips(o.params).map((g) => {
      const position = new THREE.Vector3(...g.position).applyMatrix4(m), normal = new THREE.Vector3(...g.normal).transformDirection(m), axis = new THREE.Vector3(...g.axis).transformDirection(m);
      const x = axis.clone(), y = normal.clone(), z = new THREE.Vector3().crossVectors(x, y);
      if (z.lengthSq() < 1e-8) { z.set(0, 0, 1); if (Math.abs(x.z) > 0.9) z.set(1, 0, 0); }
      z.normalize();
      y.crossVectors(z, x).normalize();
      const matrix = new THREE.Matrix4().makeBasis(x, y, z).setPosition(position);
      return { id: g.id, label: g.label, hand: g.hand, objectId, position, normal, axis, diameter: g.diameter, matrix, quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix) };
    });
  }
  /** World bounding box of all visible objects (empty box when there are none). */
  function bounds(out = new THREE.Box3()) {
    out.makeEmpty();
    for (const o of objects.values()) if (o.visible) { ready(o); out.union(_box.copy(o.bbox).applyMatrix4(o.group.matrixWorld)); }
    return out;
  }
  /** Fit an object (or every object) in the 3D view. */
  /** Fit one object (or every object, id null) in the view; opts.view: a camera preset to look from (viewport.js VIEW_PRESETS). */
  function frameObjects(id, opts = {}) {
    const b = new THREE.Box3();
    if (id) { const o = objects.get(id); if (!o) return false; ready(o); b.copy(o.bbox).applyMatrix4(o.group.matrixWorld); } else bounds(b);
    if (b.isEmpty()) return false;
    b.expandByScalar(0.25);
    viewport.frame?.(b, { animate: true, margin: 1.4, ...(opts.view ? { view: opts.view } : {}) });
    return true;
  }

  // ---- labels in the 3D view ----------------------------------------------------------------------------------------------------------
  const massText = (m) => `${Number(m.toFixed(1))} kg`;
  function labelItems() {
    const out = [];
    for (const o of objects.values()) {
      if (!o.visible) continue;
      const sel = o.id === selectedId, mass = byType(o.type).hasMass && o.params.mass > 0 ? massText(o.params.mass) : null;
      if (!sel && !showNames && !mass) continue;
      const text = sel || showNames ? (mass ? `${o.name} · ${mass}` : o.name) : mass;
      const m = ready(o), c = _v.set((o.bbox.min.x + o.bbox.max.x) / 2, o.bbox.max.y, (o.bbox.min.z + o.bbox.max.z) / 2).applyMatrix4(m);
      out.push({ id: o.id, text, position: new THREE.Vector3(c.x, c.y + 0.05, c.z), priority: sel ? 100 : showNames ? 12 : 8, cls: "hm-label-object" });
    }
    return out;
  }
  const offLabels = viewport.addLabelSource?.("sandbox", labelItems);
  if (typeof offLabels === "function") unsubs.push(offLabels);
  function setShowNames(v) { showNames = !!v; render(); }

  // ---- scene files and persistence --------------------------------------------------------------------------------------------------
  function toJSON() { return { app: SCENE_APP, version: SCENE_VERSION, objects: serializeAll(), snap: { ...snap } }; }
  /** Register another module's section of the scene file: toJSON() -> value, fromJSON(value, { merge }). Returns an unregister function. */
  function registerSerializer(key, ser) {
    if (!SECTIONS.includes(key)) throw new RangeError(`registerSerializer: unknown section "${key}" (measurements, human)`);
    serializers.set(key, ser);
    if (pendingSections.has(key)) { // the scene was loaded before this module existed: hand it its section now
      const v = pendingSections.get(key);
      pendingSections.delete(key);
      try { ser.fromJSON(v, { merge: false }); } catch (e) { console.error(`sandbox: restoring "${key}" failed:`, e); }
    }
    return () => {
      if (serializers.get(key) !== ser) return;
      // the module goes away (its panel closed) but the scene stays: keep its section so that the next save does not drop it
      try { const v = ser.toJSON(); if (v !== undefined) pendingSections.set(key, JSON.parse(JSON.stringify(v))); } catch { /* nothing to keep */ }
      serializers.delete(key);
    };
  }
  /** The whole scene file: objects plus the sections other modules registered (measurements, human). */
  function toSceneFile() {
    const f = toJSON();
    for (const [k, s] of serializers) { try { const v = s.toJSON(); if (v !== undefined) f[k] = v; } catch (e) { console.error(`sandbox: saving "${k}" failed:`, e); } }
    for (const [k, v] of pendingSections) if (!serializers.has(k)) f[k] = v;
    return f;
  }
  // The sections of other modules as plain data (a deep copy) and back: what Undo / Redo of "Open scene" hands back
  function sectionsSnapshot() {
    const out = {};
    for (const [k, s] of serializers) { try { const v = s.toJSON(); if (v !== undefined) out[k] = JSON.parse(JSON.stringify(v)); } catch { /* a section that cannot be saved cannot be restored */ } }
    return out;
  }
  function applySections(snap) {
    for (const [k, s] of serializers) { try { s.fromJSON(Object.hasOwn(snap, k) ? snap[k] : undefined, { merge: false }); } catch (e) { console.error(`sandbox: restoring "${k}" failed:`, e); } }
  }
  /**
   * Replace (or, with { merge: true }, extend) the scene from a scene file (an object or JSON text). One undo step. Returns
   * { ok, added, skipped, warnings, errors }: nothing is changed when `ok` is false.
   */
  function fromJSON(input, { merge = false } = {}) {
    const v = typeof input === "string" ? parseSceneText(input) : validateScene(input);
    if (!v.ok) return { ok: false, added: 0, warnings: v.warnings, errors: v.errors };
    const room = merge ? MAX_OBJECTS - objects.size : MAX_OBJECTS, list = v.objects.slice(0, Math.max(room, 0)), warnings = [...v.warnings];
    if (list.length < v.objects.length) warnings.push(`Only ${list.length} of ${v.objects.length} objects fit: a scene is limited to ${MAX_OBJECTS} objects.`);
    let added = 0;
    const before = merge ? null : sectionsSnapshot();
    grouped(merge ? "Add scene" : "Open scene", () => {
      if (!merge) for (const o of [...objects.values()]) destroyObject(o);
      const ids = new Set(); // file ids that were used: an attachment never refers to ids, so only uniqueness matters
      for (const d of list) { const o = makeObject({ ...d, id: d.id && !ids.has(d.id) ? d.id : null }); ids.add(o.id); added++; }
      if (v.extras.snap && isObj(v.extras.snap)) { const g = GRID_STEPS_MM.includes(v.extras.snap.gridMm) ? v.extras.snap.gridMm : snap.gridMm, a = ANGLE_STEPS.includes(v.extras.snap.angleDeg) ? v.extras.snap.angleDeg : snap.angleDeg; setSnap({ gridMm: g, angleDeg: a }); }
      updateAttached();
      // a section the file does not have is passed as `undefined` when the scene is replaced, so that e.g. the measurements of the old scene go too
      for (const [k, s] of serializers) {
        const has = Object.hasOwn(v.extras, k);
        if (!has && merge) continue;
        try { s.fromJSON(has ? v.extras[k] : undefined, { merge }); } catch (e) { warnings.push(`The "${k}" section of the file could not be read (${String(e?.message ?? e).slice(0, 100)}).`); }
      }
      for (const k of SECTIONS) { // the sections whose module is not there yet wait for it (see pendingSections)
        if (serializers.has(k)) continue;
        const has = Object.hasOwn(v.extras, k), old = pendingSections.get(k);
        if (!has) { if (!merge) pendingSections.delete(k); }
        else if (merge && Array.isArray(old) && Array.isArray(v.extras[k])) pendingSections.set(k, [...old, ...v.extras[k]]);
        else if (!merge || old === undefined) pendingSections.set(k, v.extras[k]);
      }
      emitScene("load", { added });
      if (before) { const after = sectionsSnapshot(); if (JSON.stringify(before) !== JSON.stringify(after)) groupExt = { before, after }; } // Undo brings the old measurements back with the old objects
      record(merge ? "Add scene" : "Open scene");
    });
    if (selectedId && !objects.has(selectedId)) select(null);
    syncGizmo();
    render();
    return { ok: true, added, skipped: v.skipped, warnings, errors: [] };
  }
  /** Load (or with merge: add) a template. opts.created: an array that receives the SceneObjects made, in the template's order (null for one that was not added). */
  function applyTemplate(id, { merge = false, created = null } = {}) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return false;
    grouped(`Template: ${t.name}`, () => {
      if (!merge) for (const o of [...objects.values()]) destroyObject(o);
      for (const d of t.objects) { const o = add(d.type, { params: d.params, position: d.position, yaw: d.yaw, color: d.color, silent: true }); created?.push(o ?? null); }
      emitScene("load", { template: id });
      record(`Template: ${t.name}`);
    });
    if (selectedId && !objects.has(selectedId)) select(null);
    syncGizmo();
    render();
    return true;
  }

  let cancelSave = null;
  function scheduleSave() {
    if (!remember || disposed) return;
    cancelSave?.();
    cancelSave = later(() => { cancelSave = null; saveLocal(); }, 600);
  }
  /** Write the scene to localStorage now (only when "Remember this scene" is on). Returns true when it was stored. */
  function saveLocal() {
    const st = store();
    if (!st || !remember) return false;
    try { const text = JSON.stringify(toSceneFile()); if (text.length > MAX_TEXT) return false; st.setItem(STORE_KEY, text); return true; } catch { return false; }
  }
  /** Write the autosave that is still waiting for its 600 ms now (the page is being hidden, the tab is left). Returns true when something was written. */
  function flushSave() {
    if (!cancelSave) return false;
    cancelSave(); cancelSave = null;
    return saveLocal();
  }
  /** Load the remembered scene when the opt-in flag is set. Returns { ok, added } or null. */
  function restore() {
    const st = store();
    if (!st) return null;
    try {
      remember = st.getItem(REMEMBER_KEY) === "1";
      if (!remember) return null;
      const text = st.getItem(STORE_KEY);
      if (!text) return null;
      const r = fromJSON(text, { merge: false });
      states.length = 0; hIdx = -1; // the restored scene is the start of the history, not an undoable step
      commit("Restore");
      return r;
    } catch { return null; }
  }
  function setRemember(v) {
    const st = store();
    remember = !!v;
    try {
      if (!st) return false;
      if (remember) { st.setItem(REMEMBER_KEY, "1"); saveLocal(); } else { st.removeItem(REMEMBER_KEY); st.removeItem(STORE_KEY); }
    } catch { return false; }
    emitScene("update", { op2: "remember" });
    return true;
  }

  // ---- wiring -----------------------------------------------------------------------------------------------------------------------
  if (ctx?.on) {
    unsubs.push(ctx.on("selection", (sel) => syncSelection(sel)));
    unsubs.push(ctx.on("pose", () => updateAttached()));
    unsubs.push(ctx.on("rig", () => updateAttached()));
    unsubs.push(ctx.on("theme", () => { for (const o of objects.values()) for (const l of [o._outline, o._hover]) if (l) l.material.color.copy(accent()); render(); }));
  }
  // an imported model whose file was still loading is drawn as a placeholder: rebuild it when its asset arrives (catalog.js onAssetReady)
  unsubs.push(onAssetReady((assetId) => {
    let n = 0;
    for (const o of objects.values()) if (o.type === "cad_model" && o.params.asset === assetId) { buildModel(o); applyTransform(o); n++; }
    if (n) { updateAttached(); render(); emitScene("restore", { asset: assetId }); }
  }));
  for (const [evt, fn] of [["click", onClick], ["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerUp], ["pointercancel", onPointerCancel], ["gizmo-start", onGizmoStart], ["gizmo-change", onGizmoChange], ["gizmo-end", onGizmoEnd]]) {
    const off = viewport.on?.(evt, fn);
    if (typeof off === "function") unsubs.push(off);
  }
  unsubs.push(() => viewport.container?.removeEventListener?.("keydown", onContainerKey, true));
  unsubs.push(() => viewport.container?.removeEventListener?.("pointercancel", onPointerCancel, true));
  commit("Start"); // the empty scene is the first state of the history
  states[0].label = "Start";

  function dispose() {
    if (disposed) return;
    cancelDrag();
    flushSave(); // an edit less than 600 ms old is not lost when the tab is left
    disposed = true;
    for (const f of unsubs.splice(0)) { try { f(); } catch { /* already gone */ } }
    viewport.detachGizmo?.();
    for (const o of [...objects.values()]) destroyObject(o);
    viewport.remove?.(root);
    viewport.removeLabelSource?.("sandbox");
    registry.delete(viewport);
    serializers.clear();
    pendingSections.clear();
  }

  const sandbox = {
    objects, root, viewport, ctx,
    get selected() { return selectedId; },
    get hovered() { return hoverId; },
    get snap() { return { ...snap }; },
    get gizmoMode() { return gizmoMode; },
    get showNames() { return showNames; },
    get remember() { return remember; },
    get floorLimit() { return floorLimit; },
    get canUndo() { return hIdx > 0; },
    get canRedo() { return hIdx < states.length - 1; },
    get undoLabel() { return hIdx > 0 ? states[hIdx].label : ""; },
    get redoLabel() { return hIdx < states.length - 1 ? states[hIdx + 1].label : ""; },
    get disposed() { return disposed; },
    get dragging() { return !!drag?.moved; },
    get placeContainer() { return placeEl(); },
    refs: 0,
    add, remove, duplicate, update, setParam, setParams, rename, setLocked, setVisible, clear,
    move, rotate, nudge, dropToFloor, dropToSurface,
    select, hover, setGizmoMode, setSnap, setShowNames,
    undo, redo, beginGroup, endGroup, grouped,
    toJSON, toSceneFile, fromJSON, applyTemplate, registerSerializer, saveLocal, flushSave, restore, setRemember,
    attach, detach, updateAttached,
    anchorWorld, anchorNormalWorld, anchorsWorld, localToWorld, worldToLocal, supportsWorld, gripsWorld, bounds, frameObjects, pickAt,
    onKey, snapValue: (v) => snapValue(v, snap.gridMm),
    /** Pause object picking and dragging (a measuring tool owns the pointer). Returns a function that resumes it. */
    suspendInput() { const t = Symbol("suspend"); suspended.add(t); cancelDrag(); return () => suspended.delete(t); },
    /** Turn picking, dragging and the gizmo on or off (the Scene panel is shown / hidden; the Measure panel only picks). */
    setInteraction({ pick, drag: dr, gizmo } = {}) {
      if (pick !== undefined) pickEnabled = !!pick;
      if (dr !== undefined) { dragEnabled = !!dr; if (!dragEnabled) cancelDrag(); }
      if (gizmo !== undefined && !!gizmo !== gizmoEnabled) { gizmoEnabled = !!gizmo; syncGizmo(); }
    },
    get interaction() { return { pick: pickEnabled, drag: dragEnabled, gizmo: gizmoEnabled }; },
    /** Explicitly allow objects below the floor (a pit): the lowest y an object may have, 0 to -5 metres. */
    setFloorLimit(y) { floorLimit = clamp(fin(y) ? Math.min(y, 0) : 0, -5, 0); },
    dispose,
  };

  // the container another module renders its "Place the human" section into (created on first use, so it exists before the Scene panel does)
  let place = null;
  function placeEl() {
    if (place) return place;
    if (typeof document === "undefined") return null;
    place = document.createElement("div");
    place.id = "hm-place-human";
    place.className = "hm-place";
    return place;
  }

  registry.set(viewport, sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------------------------------------------------
// one sandbox per viewport, reachable from any panel (each panel has a ctx of its own, so ctx.sandbox cannot be shared by assignment)
const registry = new WeakMap();
/** The sandbox of a ctx's viewport, created on first use. Also set as ctx.sandbox and (non-enumerable) ctx.state.sandbox. */
export function sandboxFor(ctx) {
  const vp = ctx?.viewport;
  if (!vp) throw new TypeError("sandboxFor: the ctx has no viewport");
  let sb = registry.get(vp);
  if (!sb || sb.disposed) {
    sb = createSandbox({ viewport: vp, ctx });
    sb.restore();
  }
  try { ctx.sandbox = sb; } catch { /* a frozen ctx */ }
  try { if (ctx.state && ctx.state.sandbox !== sb) Object.defineProperty(ctx.state, "sandbox", { value: sb, configurable: true, writable: true, enumerable: false }); } catch { /* state is not extensible */ }
  return sb;
}
/** The sandbox of a viewport or ctx if it exists (never creates one). */
export const peekSandbox = (vpOrCtx) => registry.get(vpOrCtx?.viewport ?? vpOrCtx) ?? null;
/** Count a user of the shared sandbox; the last release disposes it. Pair with releaseSandbox(). */
export function acquireSandbox(ctx) { const sb = sandboxFor(ctx); sb.refs++; return sb; }
export function releaseSandbox(ctx) { const sb = peekSandbox(ctx); if (!sb) return; if (--sb.refs <= 0) sb.dispose(); }
