// Posture panel of the Digital human tab: pick a posture from the library (search, categories, tags, stick-figure cards), see and change the current one (undo, mirror, save,
// export, support and seat, live readouts), and edit it by joint (sliders with the range of motion, region sliders, hands) or by IK handles in the 3D view.
// Contract: docs/human3d/DESIGN.md 3.3 and 3.3b; the engine is editor.js (docs/human3d/EDITOR.md), published as ctx.posture. Styles: site/human-posture.css (prefix hm-pe-).
//
// Everything above `// ---- panel` is pure (no DOM; tested in Node by tests/human3d/editor.test.mjs). The panel itself touches the DOM only inside mount().
import * as THREE from "three";
import { h, download } from "../../util.js";
import { JOINT_BY_ID, REGIONS, mirrorId } from "../skeleton.js";
import { CATEGORIES, SUPPORT_CARRIERS, SUPPORT_INFO, expandPosture, clampPose, placePose, solvePose, landmarkPosition, validatePosture } from "../pose.js";
import { POSTURES, GRIPS } from "../postures.js";
import { GRIP_NAMES } from "../postures/grips.js";
import { editorFor, BACKUP_KEY, EDIT_TABS, HANDLES, FINGER_NAMES, createHandleLayer, sliderBounds, regionRange, regionTotals, supportLabel, supportShort, tabOfJoint, hasTwin, dofTitle, NUDGE_M } from "../editor.js";
import { section, tablist, badge, emptyState, notice, nextId, toUnit, fromUnit, unitDigits, UNIT_LABEL } from "../ui.js";
import { correctAngles, verdictOf, compareFlags, postureVerdict } from "../correct.js";
import { postureCompliance, checkPosture, summarize, tagText, clauseRef, STATUS_WORD } from "../mil1472.js";

const CSS_URL = new URL("../../../human-posture.css", import.meta.url).href;
const PREFS_KEY = "hm-posture-prefs-v1";

// ---------------------------------------------------------------------------------------------------------------------
// searching and filtering the library
/** Lower case without accents, for matching. */
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const HAY = new WeakMap();
const hayOf = (p) => { let t = HAY.get(p); if (t === undefined) { t = fold([p.name, p.description, (p.tags ?? []).join(" "), p.category].join(" ")); HAY.set(p, t); } return t; }; // what postures.js search() looks at
const isCustomId = (p) => typeof p.id === "string" && p.id.startsWith("custom-");
/**
 * The postures that match: every word of the query occurs in the name, description, tags or category (case and accents ignored: the same as postures.js search()), the category is the one chosen
 * ("all", "custom" or the name of a category), and every chosen tag is among the tags. `skip` leaves one criterion out ("category" or "tags": for the counts of the chips).
 */
export function filterPostures(list, { query = "", category = "all", tags = [], skip = null } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    if (skip !== "category" && category !== "all" && (category === "custom" ? !isCustomId(p) : p.category !== category)) return false;
    if (skip !== "tags" && tags.length && !tags.every((t) => (p.tags ?? []).includes(t))) return false;
    if (words.length) { const hay = hayOf(p); if (!words.every((w) => hay.includes(w))) return false; }
    return true;
  });
}
/** { all, custom, [category name]: n } for the postures that match the query and the tags (the category chip itself is not applied to its own count). */
export function categoryCounts(list, { query = "", tags = [] } = {}) {
  const base = filterPostures(list, { query, tags, skip: "category" }), out = { all: base.length, custom: 0 };
  for (const c of CATEGORIES) out[c.name] = 0;
  for (const p of base) { if (isCustomId(p)) out.custom++; if (Object.hasOwn(out, p.category)) out[p.category]++; }
  return out;
}
/** [[tag, n]] of the postures that match the query and the category, most used first (ties alphabetically); `limit` caps the list. */
export function tagCounts(list, { query = "", category = "all" } = {}, limit = 40) {
  const m = new Map();
  for (const p of filterPostures(list, { query, category, skip: "tags" })) for (const t of p.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
}
/** The part of a long list that has to exist in the DOM: rows [start, end) for a scroll position, with `overscan` rows around the window. */
export function windowRange(scrollTop, viewH, rowH, count, overscan = 3) {
  if (!(count > 0) || !(rowH > 0)) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowH)), last = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(viewH, rowH)) / rowH));
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}
/** Where an arrow, Home, End or Page key takes the active row of a list (-1 for no change). */
export function listMove(index, count, key, page = 5) {
  if (!(count > 0)) return -1;
  const last = count - 1, i = Math.min(last, Math.max(0, index));
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: last, PageDown: i + page, PageUp: i - page }[key];
  return to === undefined ? -1 : Math.min(last, Math.max(0, to));
}
/** The text and the tooltip of a source badge: the short reference ("ISO 7250-1", "illustrative", "RULA") and the whole source. */
export function sourceBadge(source) {
  const full = String(source ?? "").trim();
  if (!full) return { text: "no source", title: "No source is given" };
  if (/^illustrative/i.test(full)) return { text: "illustrative", title: full };
  const first = full.split(/[;(]/)[0].trim().replace(/\s+/g, " ");
  return { text: first.length > 22 ? `${first.slice(0, 21).trim()}…` : first, title: full };
}
/** The badge of a validatePosture() result: { kind: "good" | "warn" | "bad", text, title }. */
export function validatorBadge(res) {
  if (!res) return { kind: "", text: "…", title: "Checking the posture on this body" };
  if (res.errors?.length) return { kind: "bad", text: "fails", title: `On this body: ${res.errors.slice(0, 3).join(" ")}${res.errors.length > 3 ? ` (and ${res.errors.length - 3} more)` : ""}` };
  if (res.warnings?.length) return { kind: "warn", text: "ok, notes", title: `Valid on this body, with ${res.warnings.length} note${res.warnings.length > 1 ? "s" : ""}: ${res.warnings.slice(0, 2).join(" ")}` };
  return { kind: "good", text: "ok", title: "Passes the validator on this body: inside the ranges of motion, supported, balanced, no gross self-intersection" };
}
/** A length in metres as text in the display unit: "12 mm". `fmt` is ctx.fmt (millimetres in, text out). */
const mmText = (m, fmt) => fmt(m * 1000);

/** The balance chip: { kind, text }. */
export function balanceText(b, fmt = (mm) => `${Math.round(mm)} mm`) {
  if (!b) return { kind: "", text: "Balance: —" };
  if (!b.applies) return { kind: "", text: "Balance: not checked", title: b.reason };
  const d = fmt(Math.abs(b.margin) * 1000);
  if (b.status === "ok") return { kind: "good", text: `Balanced: centre of mass ${d} inside the base`, title: "The centre of mass, projected on the floor, is inside the convex hull of the contacts (a rigid-body check, not a stability analysis)" };
  if (b.status === "edge") return { kind: "warn", text: `At the edge: centre of mass ${d} outside the base`, title: "Outside the support polygon, but within the 40 mm that the posture rules allow" };
  return { kind: "bad", text: `Would fall: centre of mass ${d} outside the base`, title: "More than 40 mm outside the support polygon" };
}
/** Chips for the support gaps: a contact that floats or sinks by more than 3 mm. */
export function gapTexts(gaps, fmt = (mm) => `${Math.round(mm)} mm`) {
  const NAME = { feet: "Feet", seat: "Seat", knees: "Knees", toes: "Toes", palms: "Palms", elbows: "Elbows", body: "Body", hands: "Hands", heels: "Heels" };
  const out = [];
  for (const [set, g] of Object.entries(gaps ?? {})) {
    if (!Number.isFinite(g) || Math.abs(g) < 0.003) continue;
    const name = NAME[set] ?? set;
    out.push(g > 0 ? { kind: g > 0.015 ? "warn" : "", text: `${name} ${fmt(g * 1000)} above ${set === "seat" ? "the seat" : "the floor"}` } : { kind: "warn", text: `${name} ${fmt(-g * 1000)} below ${set === "seat" ? "the seat" : "the floor"}` });
  }
  return out;
}
/** A signed angle for people: "−12.5°" with a real minus sign, one decimal only when needed. */
export function fmtDeg(v, digits = 1) {
  if (!Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(digits));
  return `${r < 0 ? "−" : ""}${Math.abs(r).toFixed(r % 1 ? digits : 0)}°`;
}
/** The step of a key press on a slider: arrows 1 degree, Shift 10, Alt 0.1 (Page keys 10). */
export function keyStep(e) {
  if (e.altKey) return 0.1;
  if (e.shiftKey || e.key === "PageUp" || e.key === "PageDown") return 10;
  return 1;
}
/** The vector of an arrow key on a handle in metres, in the view's terms: left / right across the view, up / down, Page Up / Down away from / toward the camera. `right` and `fwd` are unit vectors. */
export function nudgeVector(key, { shift = false, alt = false } = {}, right = [1, 0, 0], fwd = [0, 0, 1]) {
  const step = NUDGE_M * (alt ? 0.1 : shift ? 10 : 1);
  const v = { ArrowRight: [...right], ArrowLeft: right.map((c) => -c), ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0], PageUp: [...fwd], PageDown: fwd.map((c) => -c) }[key];
  return v ? v.map((c) => c * step) : null;
}
/** The label of a handle for its nudge instructions. */
/** The sentence for the postures in the browser's store that could not be used (the first reasons, and where the original text is kept). */
export function customProblemsText(problems, backupKey = BACKUP_KEY) {
  const list = (problems ?? []).filter((x) => typeof x === "string");
  if (!list.length) return "";
  const shown = list.slice(0, 2).map((x) => x.replace(/\.$/, "")).join("; ");
  return `${list.length === 1 ? "A saved posture" : `${list.length} problems with the saved postures`} could not be used and ${list.length === 1 ? "is" : "are"} not listed (${shown}${list.length > 2 ? "; ..." : ""}). The next save or delete keeps a copy of what was stored in this browser under "${backupKey}".`;
}
/**
 * What "Save as custom" does with the name typed: { overwrite, duplicate }. The posture being edited is updated in place (`overwrite`: its id) only when it is a saved one and the name
 * is still its own. A name that another saved posture already has (`duplicate`) never overwrites anything: the form asks first and then keeps both.
 */
export function saveTarget(base, saved, typed) {
  const name = String(typed ?? "").replace(/\s+/g, " ").trim(), mine = base?.kind === "custom" ? saved.find((p) => p.id === base.id) : null;
  if (mine && mine.name === name) return { overwrite: mine.id, duplicate: false };
  return { overwrite: null, duplicate: saved.some((p) => p.name === name) };
}
export const handleHint = (hd) => `${hd.label}: arrow keys move it 10 mm across and up or down in the view, Page Up and Page Down away from and toward the camera; Shift ten times as far, Alt a tenth`;

// ---------------------------------------------------------------------------------------------------------------------
// stick figures
const SPINE_CHAIN = ["pelvis", "L5", "L3", "L1", "T11", "T8", "T5", "T2", "C7", "C4", "C1", "head"];
/**
 * The line drawing of a posture on a body: orthographic, from the side (the figure faces right) for upright, seated and lying-on-the-back postures, from the front
 * when the body lies on its side. The figure is placed on its support as in the editor (placePose, the floor and the seat of the posture). Returns
 * { view, segments: [{ pts: [[u, v] ...], tone: "spine" | "near" | "far" }], head: { u, v, r }, seat: { v, u0, u1 } | null, extent: { min, max, vmin, vmax } } in metres (u across, v up), or throws like expandPosture.
 */
export function stickFigure(body, posture) {
  const ex = expandPosture(posture), { pose } = clampPose({ root: ex.root, angles: ex.angles });
  const upright = { root: { ...pose.root, heading: 0 }, angles: pose.angles };
  const root = placePose(body, upright, { posture });
  const kin = solvePose(body, upright, root), P = {};
  const need = new Set([...SPINE_CHAIN, ..."LR".split("").flatMap((s) => [`clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `wrist_${s}`, `hip_${s}`, `knee_${s}`, `ankle_${s}`, `mtp_${s}`])]);
  for (const id of need) { const i = kin.index(id); P[id] = [kin.positions[3 * i], kin.positions[3 * i + 1], kin.positions[3 * i + 2]]; }
  const L = (id) => { const v = landmarkPosition(body, upright, root, id); return [v.x, v.y, v.z]; };
  P.vertex = L("vertex");
  for (const s of ["L", "R"]) { P[`tip_${s}`] = L(`middle_tip_${s}`); P[`toe_${s}`] = L(`toe_tip_${s}`); P[`heel_${s}`] = L(`heel_sole_${s}`); }
  const ax = P.head[0] - P.pelvis[0], ay = P.head[1] - P.pelvis[1], az = P.head[2] - P.pelvis[2];
  const view = Math.abs(ay) > 0.6 * Math.hypot(ax, ay, az) || Math.abs(az) >= Math.abs(ax) ? "side" : "front";
  const uv = (p) => (view === "side" ? [p[2], p[1]] : [p[0], p[1]]);
  const seg = (ids, tone) => ({ pts: ids.map((id) => uv(P[id])), tone });
  const segments = [seg([...SPINE_CHAIN, "vertex"], "spine")];
  for (const s of ["L", "R"]) {
    const tone = view === "side" && s === "L" ? "far" : "near"; // seen from the figure's right: the left limbs are behind
    segments.push(seg([`clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `wrist_${s}`, `tip_${s}`], tone));
    segments.push(seg(["pelvis", `hip_${s}`, `knee_${s}`, `ankle_${s}`, `toe_${s}`], tone));
    segments.push(seg([`ankle_${s}`, `heel_${s}`], tone));
  }
  const hv = uv(P.head), vv = uv(P.vertex);
  const head = { u: (hv[0] + vv[0]) / 2, v: (hv[1] + vv[1]) / 2, r: Math.max(0.05, Math.hypot(vv[0] - hv[0], vv[1] - hv[1]) / 2) };
  const rep = root.report, hasSeat = rep && Object.values(rep.carriers).includes("seat") && rep.surfaces.seat > 0.001, pu = uv(P.pelvis)[0];
  let min = Infinity, max = -Infinity, vmin = 0, vmax = 0;
  for (const s of segments) for (const [u, v] of s.pts) { if (u < min) min = u; if (u > max) max = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  vmax = Math.max(vmax, head.v + head.r);
  return { view, segments, head, seat: hasSeat ? { v: rep.surfaces.seat, u0: pu - (view === "side" ? 0.16 : 0.22), u1: pu + (view === "side" ? 0.34 : 0.22) } : null, extent: { min, max, vmin, vmax } };
}
/**
 * Draw a stick figure into a 2D context of w x h pixels: constant scale (the window is 1.12 times the stature, wider for a body lying down), the floor line at the bottom.
 * palette: { near, far, spine, floor, seat } as CSS colours; `dpr` scales the line widths.
 */
export function drawStick(g, geom, w, hgt, palette, stature = 1.75, dpr = 1) {
  g.clearRect(0, 0, w, hgt);
  const span = geom.extent.max - geom.extent.min, v0 = Math.min(0, geom.extent.vmin ?? 0), margin = 4 * dpr;
  const world = Math.max(stature * 1.12, span + 0.2, (geom.extent.vmax ?? 0) - v0 + 0.1);
  const s = (Math.min(w, hgt) - 2 * margin) / world, cu = (geom.extent.min + geom.extent.max) / 2;
  const X = (u) => w / 2 + (u - cu) * s, Y = (v) => hgt - margin - (v - v0) * s;
  g.lineCap = "round"; g.lineJoin = "round";
  g.strokeStyle = palette.floor; g.lineWidth = 1 * dpr;
  g.beginPath(); g.moveTo(margin, Y(0)); g.lineTo(w - margin, Y(0)); g.stroke();
  if (geom.seat !== null) {
    g.strokeStyle = palette.seat; g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(X(geom.seat.u0), Y(geom.seat.v)); g.lineTo(X(geom.seat.u1), Y(geom.seat.v)); g.stroke();
  }
  const order = { far: 0, spine: 1, near: 2 };
  for (const sg of [...geom.segments].sort((a, b) => order[a.tone] - order[b.tone])) {
    g.strokeStyle = palette[sg.tone]; g.lineWidth = (sg.tone === "spine" ? 2.4 : 1.8) * dpr;
    g.beginPath();
    sg.pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v))));
    g.stroke();
  }
  g.strokeStyle = palette.spine; g.lineWidth = 1.8 * dpr;
  g.beginPath(); g.arc(X(geom.head.u), Y(geom.head.v), geom.head.r * s, 0, Math.PI * 2); g.stroke();
}

/** Validator result of a posture on a body, memoised per posture object and body. Never throws. */
const VALID = new WeakMap();
export function validateCached(body, posture) {
  let m = VALID.get(posture);
  if (!m) VALID.set(posture, (m = new WeakMap()));
  let r = m.get(body);
  if (!r) { try { r = validatePosture(body, posture, {}); } catch (e) { r = { ok: false, errors: [String(e.message).slice(0, 120)], warnings: [] }; } m.set(body, r); }
  return r;
}
const STICK = new WeakMap();
/** stickFigure memoised per posture object and body (null when the posture cannot be drawn). */
export function stickCached(body, posture) {
  let m = STICK.get(posture);
  if (!m) STICK.set(posture, (m = new WeakMap()));
  if (!m.has(body)) { let g = null; try { g = stickFigure(body, posture); } catch { g = null; } m.set(body, g); }
  return m.get(body);
}

/** Where the three-dimensional camera's right and forward (horizontal) vectors point, for the keyboard nudges: from a camera quaternion-free pair of vectors. */
export function viewAxes(cameraDir) {
  const f = [cameraDir[0], 0, cameraDir[2]], l = Math.hypot(f[0], f[2]) || 1;
  f[0] /= l; f[2] /= l; // horizontal direction the camera looks along
  return { right: [-f[2], 0, f[0]].map((c) => (c === 0 ? 0 : c)), fwd: f };
}

// ---- panel ---------------------------------------------------------------------------------------------------------------------------------------------
/** Inject site/human-posture.css once and wait (briefly) for it. Resolves whether or not it loaded: the panel still works, only plainer. */
export function ensurePostureStyles() {
  let link = document.querySelector("link[data-hm-posture-css]");
  if (link?.dataset.hmFailed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-posture-css": "" });
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

/** The preferences read from storage, whatever was stored there: only known keys of the right type are kept (a hostile or old value is dropped, never thrown on). */
export function cleanPrefs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const own = (k) => (Object.hasOwn(raw, k) ? raw[k] : undefined);
  for (const k of ["ik", "poles", "ikOpen", "animate", "symmetric", "trunkAssist", "handFrame", "pinFeet", "pinHands"]) if (typeof own(k) === "boolean") out[k] = own(k);
  if (typeof own("tab") === "string") out.tab = own("tab").slice(0, 20);
  if (own("pelvisMode") === "bend" || own("pelvisMode") === "move") out.pelvisMode = own("pelvisMode");
  if (own("footPoint") === "ball" || own("footPoint") === "heel") out.footPoint = own("footPoint");
  const open = own("open");
  if (open && typeof open === "object" && !Array.isArray(open)) {
    out.open = {};
    for (const k of Object.keys(open)) if (/^[a-z]{1,12}$/.test(k) && typeof open[k] === "boolean") out.open[k] = open[k];
  }
  return out;
}
const loadPrefs = () => { try { return cleanPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null")); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ } };
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pctOf = (v, b) => clampNum(((v - b.min) / (b.max - b.min || 1)) * 100, 0, 100);
const typing = (el) => !!el && (el.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !(el.tagName === "INPUT" && /^(range|checkbox|radio|button)$/.test(el.type))));

/** A labelled on / off switch: a real checkbox with role switch. Returns { el, input, set(bool) }. */
function switchRow({ label, hint, checked = false, onChange, title }) {
  const id = nextId("hm-pe-sw");
  const input = h("input", { type: "checkbox", role: "switch", id, class: "hm-pe-switch", checked: checked ? true : null });
  const el = h("label", { class: "hm-pe-switchrow", for: id, title }, input, h("span", { class: "hm-pe-switchtxt" }, label, hint ? h("span", { class: "small muted hm-pe-hint" }, hint) : null));
  input.addEventListener("change", () => onChange?.(input.checked));
  return { el, input, set(v) { input.checked = !!v; } };
}
const ICONS = {
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3", redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3", trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14", upload: "M12 16V4M7 9l5-5 5 5M5 20h14", save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
};
/** A decorative inline SVG icon (the button around it carries the accessible name). */
function svgIcon(name, size = 14) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  path.setAttribute("d", ICONS[name] ?? ICONS.save);
  svg.append(path);
  svg.classList.add("hm-icon");
  return svg;
}
/** A small text button. */
function btn(label, { title, onClick, ic, className = "", disabled = false, ariaLabel } = {}) {
  const b = h("button", { type: "button", class: `btn small hm-pe-btn ${className}`.trim(), title, "aria-label": ariaLabel, disabled: disabled ? true : null }, ic ? svgIcon(ic, 14) : null, label != null ? h("span", {}, label) : null);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/**
 * One degree of freedom: a label, a number field, a slider whose track shows the range of motion (and the margin beyond it when the range is not enforced) with the zero
 * marked, and the limits underneath. Arrow keys on the slider step 1 degree, Shift 10, Alt 0.1; a pointer drag or a run of key presses is one history step.
 * spec: { label, hint, unit, get(), set(v), bounds() -> { min, max, lo, hi }, begin?() -> { end() }, step, digits, format?(v) }. Returns { el, update(), dispose() }.
 */
function dofRow(env, spec) {
  const id = nextId("hm-pe-dof"), unit = spec.unit ?? "°", step = spec.step ?? 0.1, digits = spec.digits ?? 2, fmt = spec.format ?? ((v) => (unit === "°" ? fmtDeg(v) : `${Number(v.toFixed(digits))}${unit}`));
  const rounded = (v) => Number(v.toFixed(digits));
  const lab = h("label", { class: "hm-pe-dof-label", id: `${id}-l`, for: id, title: spec.hint }, spec.label);
  const range = h("input", { type: "range", class: "hm-pe-range", id, step: String(step), "aria-labelledby": `${id}-l`, "aria-describedby": `${id}-lim` });
  const num = h("input", { type: "number", class: "input hm-pe-num", id: `${id}-n`, step: String(step), inputmode: "decimal", "aria-label": `${spec.label}, value${unit === "°" ? " in degrees" : ""}` });
  const lo = h("span", { class: "hm-pe-lim" }), hi = h("span", { class: "hm-pe-lim" }), zero = h("button", { type: "button", class: "hm-pe-zero", title: "Set this value to 0 (the neutral value)", "aria-label": `Set ${spec.label} to 0`, onclick: () => commit(0, true) }, "0");
  const note = h("div", { class: "hm-pe-dof-note small", hidden: true });
  const el = h("div", { class: "hm-pe-dof" }, h("div", { class: "hm-pe-dof-head" }, lab, h("span", { class: "hm-pe-dof-val" }, num, h("span", { class: "hm-pe-unit", "aria-hidden": "true" }, unit))), range,
    h("div", { class: "hm-pe-dof-foot", id: `${id}-lim` }, lo, zero, hi), note);
  let cur = 0, b = { min: -1, max: 1, lo: -1, hi: 1 }, gesture = null, noteTimer = 0, noteAt = NaN;
  // Typing 999 into an elbow field must not look like it worked: the field shows what was applied and the row says why it differs.
  function limited(asked, applied) {
    if (!(Math.abs(asked - applied) > Math.max(1e-6, 0.5 * 10 ** -digits))) { if (applied !== noteAt) note.hidden = true; return; } // (Enter and the browser's own change event both commit the corrected value: keep the note)
    clearTimeout(noteTimer);
    noteAt = applied;
    note.textContent = `Limited to ${fmt(applied)} ${spec.why ?? "by the range of motion"}`;
    note.hidden = false;
    noteTimer = setTimeout(() => { note.hidden = true; noteAt = NaN; }, 5000);
  }
  function layout() {
    b = spec.bounds();
    range.min = String(b.min); range.max = String(b.max);
    range.style.setProperty("--lo", `${pctOf(b.lo, b)}%`); range.style.setProperty("--hi", `${pctOf(b.hi, b)}%`); range.style.setProperty("--zero", `${pctOf(0, b)}%`);
    lo.textContent = fmt(b.lo); hi.textContent = fmt(b.hi);
    lo.title = `Lowest value of the range of motion: ${fmt(b.lo)}`; hi.title = `Highest value of the range of motion: ${fmt(b.hi)}`;
  }
  function show(v) {
    cur = v;
    range.value = String(clampNum(v, b.min, b.max));
    if (document.activeElement !== num) num.value = String(rounded(v));
    range.setAttribute("aria-valuetext", `${fmt(v)}${spec.flagOut !== false && (v < b.lo - 1e-6 || v > b.hi + 1e-6) ? ", outside the range of motion" : ""}`);
    const out = spec.flagOut !== false && (v < b.lo - 1e-6 || v > b.hi + 1e-6);
    el.classList.toggle("is-out", out);
    num.setAttribute("aria-invalid", out ? "true" : "false");
    el.dataset.out = out ? "1" : "";
  }
  function commit(v, record = true) {
    if (!Number.isFinite(v)) { show(cur); return; }
    try { spec.set(v, record); } catch (e) { env.say(`That value could not be set (${String(e.message).slice(0, 100)}).`, "error"); }
    show(spec.get());
    limited(v, cur);
  }
  range.addEventListener("input", () => commit(Number(range.value), true));
  range.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    commit(Number((cur + dir * keyStep(e)).toFixed(2)), true);
  });
  const open = () => { gesture?.end(); gesture = spec.begin?.() ?? null; };
  const close = () => { gesture?.end(); gesture = null; };
  range.addEventListener("pointerdown", open);
  for (const t of ["pointerup", "pointercancel", "change", "blur"]) range.addEventListener(t, close);
  num.addEventListener("change", () => { const v = Number(num.value); if (num.value.trim() === "" || !Number.isFinite(v)) { show(cur); num.value = String(rounded(cur)); return; } commit(v, true); num.value = String(rounded(spec.get())); });
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.dispatchEvent(new Event("change")); });
  layout();
  show(spec.get());
  return { el, update() { layout(); show(spec.get()); }, dispose() { close(); clearTimeout(noteTimer); }, get out() { return el.dataset.out === "1"; }, range, num };
}

/** The sliders of one joint with its name, a reset button and, when the symmetric option is on, the twin it also moves. Returns { el, update(), dispose(), rows }. */
function jointEditor(env, jointId, { heading = true, className = "" } = {}) {
  const j = JOINT_BY_ID[jointId], ed = env.editor;
  const rows = j.dof.map((d, i) => dofRow(env, {
    label: d.label, hint: `Positive: ${d.pos}. Negative: ${d.neg}. Range ${fmtDeg(d.min, 0)} to ${fmtDeg(d.max, 0)}.`,
    get: () => env.angle(jointId, i), set: (v, record) => ed.setJoint(jointId, i, v, { record }), bounds: () => sliderBounds(d, ed.options.enforceRom),
    begin: () => ed.beginGesture(`Edit ${dofTitle(jointId, i)}`, `joint:${jointId}:${i}`),
  }));
  const twin = h("span", { class: "hm-pe-twin small muted", hidden: true });
  const reset = btn("Reset", { title: `Set every angle of the ${j.label.toLowerCase()} to 0`, ariaLabel: `Reset ${j.label}`, onClick: () => { try { ed.resetJoint(jointId); } catch (e) { env.say(String(e.message), "error"); } } });
  const el = h("div", { class: `hm-pe-joint ${className}`.trim(), dataset: { joint: jointId } },
    heading ? h("div", { class: "hm-pe-joint-head" }, h("strong", { class: "hm-pe-joint-name" }, j.label), twin, reset) : h("div", { class: "hm-pe-joint-head" }, twin, reset), ...rows.map((r) => r.el));
  function update() {
    for (const r of rows) r.update();
    const tw = hasTwin(jointId) && ed.options.symmetric;
    twin.hidden = !tw;
    if (tw) twin.textContent = `also moves the ${JOINT_BY_ID[mirrorId(jointId)].label.toLowerCase()}`;
  }
  update();
  return { el, update, dispose() { for (const r of rows) r.dispose(); }, rows };
}

const CHANNELS = [["flex", "Flexion / extension"], ["lat", "Lateral bend"], ["rot", "Axial rotation"]];
/** The three totals of a spine region (lumbar, thoracic, cervical): one slider per channel, shared by the vertebrae. */
function regionEditor(env, region, { open = true } = {}) {
  const rg = REGIONS[region], ed = env.editor, ranges = regionRange(region);
  const rows = CHANNELS.map(([key, name], c) => dofRow(env, {
    label: `${rg.label} ${name.toLowerCase()}`, hint: `The total over the ${rg.joints.length} ${region} vertebrae, shared by them with the weights of the model; each vertebra stops at its own limit. Range ${fmtDeg(ranges[c][0], 0)} to ${fmtDeg(ranges[c][1], 0)} in all.`,
    get: () => regionTotals(env.angles(), region)[c],
    set: (v, record) => { const a = [null, null, null]; a[c] = v; ed.setRegion(region, a, { record }); },
    bounds: () => sliderBounds({ min: ranges[c][0], max: ranges[c][1] }, ed.options.enforceRom),
    begin: () => ed.beginGesture(`Edit ${rg.label.toLowerCase()} ${key}`, `region:${region}:${c}`),
  }));
  const el = h("div", { class: "hm-pe-joint hm-pe-region", dataset: { region } }, h("div", { class: "hm-pe-joint-head" }, h("strong", { class: "hm-pe-joint-name" }, `${rg.label} spine`), h("span", { class: "small muted" }, `${rg.joints.length} vertebrae`)), ...rows.map((r) => r.el));
  void open;
  return { el, update() { for (const r of rows) r.update(); }, dispose() { for (const r of rows) r.dispose(); }, rows };
}

/** The orientation of the whole figure about the pelvis (the root of the rig): forward / back, sideways and twist. */
function rootEditor(env) {
  const ed = env.editor;
  const rows = [["flex", "Tilt forward / back", "tilts the whole body forward (positive) or back about the pelvis; −90 lies it on its back, +90 on its front"], ["lat", "Tilt sideways", "tilts the whole body to its left (positive) or right; ±90 lies it on its side"], ["rot", "Twist", "twists the whole body about the pelvis, left (positive) or right"]].map(([key, name, hint]) => dofRow(env, {
    label: name, hint, get: () => env.rig()?.root?.[key] ?? 0, set: (v, record) => ed.setRoot({ [key]: v }, { record }), bounds: () => ({ min: -180, max: 180, lo: -180, hi: 180 }),
    begin: () => ed.beginGesture(`Edit pelvis ${key}`, `root:${key}`),
  }));
  const el = h("div", { class: "hm-pe-joint", dataset: { joint: "pelvis" } }, h("div", { class: "hm-pe-joint-head" }, h("strong", { class: "hm-pe-joint-name" }, "Pelvis tilt"), h("span", { class: "small muted" }, "turns the whole body")), ...rows.map((r) => r.el));
  return { el, update() { for (const r of rows) r.update(); }, dispose() { for (const r of rows) r.dispose(); }, rows };
}

/** One hand: a grip preset, one curl slider per finger (open hand to fist), and the sliders of every finger joint behind a disclosure. */
function handEditor(env, side) {
  const ed = env.editor, S = side === "L" ? "left" : "right";
  const grip = h("select", { class: "input hm-pe-select", id: nextId("hm-pe-grip"), "aria-label": `Grip of the ${S} hand` },
    h("option", { value: "" }, "Custom"), GRIP_NAMES.map((n) => h("option", { value: n, title: GRIPS[n].description }, GRIPS[n].label)));
  grip.addEventListener("change", () => { if (!grip.value) return; try { ed.setGrip(side, grip.value); } catch (e) { env.say(String(e.message), "error"); } });
  const gripDesc = h("p", { class: "small muted hm-pe-gripdesc" });
  const FN = { thumb: "Thumb", index: "Index finger", middle: "Middle finger", ring: "Ring finger", little: "Little finger" };
  const curls = FINGER_NAMES.map((f) => dofRow(env, {
    label: `${FN[f]} curl`, hint: "From the open hand (0) to the fist (100): every joint of the finger moves between the two grip presets.", unit: "%", step: 1, digits: 0, flagOut: false, why: "by the open hand and the fist", format: (v) => `${Math.round(v)}%`,
    get: () => ed.fingerCurl(side, f) * 100, set: (v, record) => ed.setFingerCurl(side, f, v / 100, { record }), bounds: () => ({ min: 0, max: 100, lo: 0, hi: 100 }),
    begin: () => ed.beginGesture(`${S} ${f} finger`, `curl:${side}:${f}`),
  }));
  const joints = ["thumb_cmc", "thumb_mcp", "thumb_ip", ...["index", "middle", "ring", "little"].flatMap((f) => [`${f}_mcp`, `${f}_pip`, `${f}_dip`])].map((b) => jointEditor(env, `${b}_${side}`));
  const detail = h("details", { class: "hm-pe-details" }, h("summary", {}, "Every finger joint"), ...joints.map((j) => j.el));
  const wrist = jointEditor(env, `wrist_${side}`), forearm = jointEditor(env, `forearm_${side}`);
  const el = h("div", { class: "hm-pe-hand", dataset: { side } },
    h("div", { class: "hm-pe-field" }, h("label", { for: grip.id, class: "hm-pe-flabel" }, `Grip of the ${S} hand`), grip), gripDesc, ...curls.map((c) => c.el), detail, wrist.el, forearm.el);
  function update() {
    const g = ed.gripOf(side);
    grip.value = g ?? "";
    gripDesc.textContent = g ? GRIPS[g].description : "The fingers are in no preset: choose one above or move the finger sliders.";
    for (const c of curls) c.update();
    if (detail.open) for (const j of joints) j.update();
    wrist.update(); forearm.update();
  }
  detail.addEventListener("toggle", () => { if (detail.open) for (const j of joints) j.update(); });
  update();
  return { el, update, dispose() { for (const c of curls) c.dispose(); for (const j of [...joints, wrist, forearm]) j.dispose(); } };
}

// ---- the library -------------------------------------------------------------------------------------------------------------------------------------------
const ROW_H = 80, THUMB = 64;
/** Search box, category and tag chips, and a windowed list of cards (name, description, badges, a stick figure of the posture on the current body). Returns { el, refresh(), dispose() }. */
function libraryView(env) {
  const { ctx, editor } = env, uid = nextId("hm-pe-lib");
  const st = { query: "", category: "all", tags: [], items: [], filtered: [], active: 0 };
  const search = h("input", { type: "search", class: "input hm-pe-searchbox", id: `${uid}-q`, placeholder: "Search by name, description or tag", autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
  const chipBar = h("div", { class: "hm-pe-chips", role: "group", "aria-label": "Category" });
  const tagBar = h("div", { class: "hm-pe-chips", role: "group", "aria-label": "Tags" });
  const tagCount = h("span", { class: "tag outline" }, "0");
  const tagsDetails = h("details", { class: "hm-pe-tags" }, h("summary", {}, "Tags ", tagCount), tagBar);
  const count = h("p", { class: "hm-pe-count small muted", role: "status", "aria-live": "polite" });
  const spacer = h("div", { class: "hm-pe-spacer" });
  const empty = h("div", { class: "hm-pe-empty", hidden: true }, emptyState("No posture matches.", "Clear the search or the filters to see the whole library."), btn("Clear the filters", { onClick: () => { st.query = ""; search.value = ""; st.category = "all"; st.tags = []; refilter(); } }));
  const list = h("div", { class: "hm-pe-list", role: "listbox", tabindex: "0", "aria-label": "Postures. Up and down arrow keys choose, Enter shows the posture on the figure.", id: `${uid}-list` }, spacer);
  const problemsEl = h("div", { class: "hm-pe-problems" });
  const el = h("div", { class: "hm-pe-lib" }, h("div", { class: "hm-pe-search" }, h("label", { for: `${uid}-q`, class: "sr-only" }, "Search postures"), search), chipBar, tagsDetails, problemsEl, count, list, empty);

  const chipEls = new Map();
  const mkChip = (value, label) => {
    const b = h("button", { type: "button", class: "hm-pe-chip", "aria-pressed": "false", dataset: { value } }, h("span", {}, label), h("span", { class: "hm-pe-n" }));
    b.addEventListener("click", () => { st.category = st.category === value && value !== "all" ? "all" : value; refilter(); });
    chipEls.set(value, b);
    return b;
  };
  chipBar.append(mkChip("all", "All"), ...CATEGORIES.map((c) => mkChip(c.name, c.name.replace(" & ", " & "))), mkChip("custom", "Custom"));
  for (const c of CATEGORIES) chipEls.get(c.name).title = c.blurb;

  let customList = [];
  const buildItems = () => {
    customList = editor.listCustom();
    st.items = [...customList, ...POSTURES];
    problemsEl.replaceChildren(...(() => { const pr = editor.customProblems(); return pr.length ? [notice(customProblemsText(pr), { level: "warn" })] : []; })());
  };
  buildItems();

  // ---- rows
  const rows = new Map();
  let io = null, pending = [], pumpId = 0, palette = null, geomBody = null;
  const body = () => ctx.getBody();
  const readPalette = () => {
    const cs = getComputedStyle(list), v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return (palette = { near: v("--hm-pe-near", "#444"), far: v("--hm-pe-far", "#999"), spine: v("--hm-pe-spine", "#222"), floor: v("--hm-pe-floor", "#bbb"), seat: v("--hm-pe-seat", "#1c5cab") });
  };
  const dpr = () => Math.min(2, globalThis.devicePixelRatio || 1);
  function drawThumb(canvas, p, b) {
    const g = canvas.getContext("2d"), geom = stickCached(b, p), d = dpr();
    if (canvas.width !== THUMB * d) { canvas.width = THUMB * d; canvas.height = THUMB * d; }
    if (!geom) { g.clearRect(0, 0, canvas.width, canvas.height); canvas.dataset.state = "none"; return; }
    drawStick(g, geom, canvas.width, canvas.height, palette ?? readPalette(), b.stature ?? 1.75, d);
    canvas.dataset.state = "drawn";
  }
  function fillBadge(rowEl, p, b) {
    const slot = rowEl.querySelector(".hm-pe-valid");
    if (!slot) return;
    const v = validatorBadge(validateCached(b, p));
    slot.className = `tag hm-pe-valid ${v.kind}`.trim();
    slot.textContent = v.text;
    slot.title = v.title;
    slot.dataset.state = v.kind || "pending";
  }
  const ERGO = { "not-acceptable": ["bad", "not acceptable"], check: ["warn", "check"], acceptable: ["good", "acceptable"] };
  function fillErgo(rowEl, p, b) {
    const slot = rowEl.querySelector(".hm-pe-ergo");
    if (!slot) return;
    const r = postureVerdict(b, p), [kind, text] = ERGO[r.verdict] ?? ["", "…"];
    slot.className = `tag hm-pe-ergo ${kind}`.trim();
    slot.textContent = r.verdict ? text : "n/a";
    slot.title = r.verdict ? `Ergonomic verdict on this body: ${text} (ISO 11226 indication, not a risk assessment). ${r.counts.high} not acceptable, ${r.counts.caution} to check.` : "Could not be placed on this body";
    slot.dataset.state = r.verdict ?? "none";
  }
  const MIL = { compliant: "1472H ✓", "not-compliant": "1472H ✗", check: "1472H check", review: "1472H info", na: "1472H n/a", none: "1472H —" };
  function fillMil(rowEl, p, b) {
    const slot = rowEl.querySelector(".hm-pe-mil");
    if (!slot) return;
    const r = postureCompliance(b, p);
    slot.textContent = r.status ? MIL[r.status] : "n/a";
    slot.title = r.status ? `MIL-STD-1472H on this body: ${STATUS_WORD[r.status]}. ${tagText(r.summary)} Clauses checked: ${r.summary.clauses.join(", ")}.` : "Could not be placed on this body";
    slot.dataset.state = r.status ?? "none";
  }
  function pump() {
    pumpId = 0;
    const b = body();
    if (!b) return;
    if (io) pending.sort((a, c) => (c.el._vis ? 1 : 0) - (a.el._vis ? 1 : 0));
    const t0 = performance.now();
    while (pending.length && performance.now() - t0 < 7) {
      const { el: r, p } = pending.shift();
      if (!r.isConnected || r.dataset.id !== p.id) continue;
      drawThumb(r.querySelector("canvas"), p, b);
      fillBadge(r, p, b);
      fillErgo(r, p, b);
      fillMil(r, p, b);
    }
    if (pending.length) pumpId = requestAnimationFrame(pump);
  }
  const queue = (r, p) => { pending.push({ el: r, p }); if (!pumpId) pumpId = requestAnimationFrame(pump); };
  function makeRow(p, i) {
    const src = p.id.startsWith("custom-") ? { text: "custom", title: `Your own posture, saved in this browser. ${p.source ?? ""}` } : sourceBadge(p.source);
    const sup = supportShort(p.support);
    const r = h("div", { class: "hm-pe-card", role: "option", id: `${uid}-o${i}`, "aria-selected": "false", dataset: { id: p.id, index: String(i) } },
      h("canvas", { class: "hm-pe-thumb", width: THUMB, height: THUMB, "aria-hidden": "true" }),
      h("div", { class: "hm-pe-card-body" },
        h("div", { class: "hm-pe-card-name" }, h("span", { class: "hm-pe-card-title" }, p.name), h("span", { class: "hm-pe-edited", hidden: true, title: "You have edited this posture" }, "edited")),
        h("div", { class: "hm-pe-card-desc" }, p.description),
        h("div", { class: "hm-pe-card-badges" }, badge(sup, "outline", `${supportLabel(p.support)}: ${SUPPORT_INFO[p.support] ?? ""}`), h("span", { class: "tag hm-pe-valid", title: "Checking the posture on this body" }, "…"), h("span", { class: "tag hm-pe-mil", title: "MIL-STD-1472H on this body" }, "…"), h("span", { class: "tag hm-pe-ergo", title: "Ergonomic verdict on this body (ISO 11226 indication)" }, "…"), badge(src.text, "outline", src.title))));
    io?.observe(r);
    queue(r, p);
    return r;
  }
  function rowState(r, i) {
    const p = st.filtered[i], base = editor.base, applied = !!p && p.id === base.id && base.kind !== "neutral";
    r.setAttribute("aria-selected", applied ? "true" : "false");
    r.classList.toggle("is-active", i === st.active);
    r.querySelector(".hm-pe-edited").hidden = !(applied && editor.modified);
  }
  function renderWindow({ force = false } = {}) {
    const n = st.filtered.length, { start, end } = windowRange(list.scrollTop, list.clientHeight || 360, ROW_H, n);
    for (const [i, r] of rows) if (force || i < start || i >= end || r.dataset.id !== st.filtered[i]?.id) { io?.unobserve(r); r.remove(); rows.delete(i); }
    for (let i = start; i < end; i++) {
      let r = rows.get(i);
      if (!r) { r = makeRow(st.filtered[i], i); r.style.transform = `translateY(${i * ROW_H}px)`; spacer.append(r); rows.set(i, r); }
      rowState(r, i);
    }
    const act = rows.get(st.active);
    if (act) list.setAttribute("aria-activedescendant", act.id); else list.removeAttribute("aria-activedescendant");
  }
  function setActive(i, { announce = false } = {}) {
    if (!(st.filtered.length > 0)) return;
    st.active = clampNum(i, 0, st.filtered.length - 1);
    const top = st.active * ROW_H, vh = list.clientHeight || 360;
    if (top < list.scrollTop) list.scrollTop = top; else if (top + ROW_H > list.scrollTop + vh) list.scrollTop = top + ROW_H - vh;
    renderWindow();
    if (announce) env.say(st.filtered[st.active].name);
  }
  function applyAt(i) {
    const p = st.filtered[i];
    if (!p) return;
    st.active = i;
    env.applyPosture(p.id);
  }
  list.addEventListener("scroll", () => { if (!list._raf) list._raf = requestAnimationFrame(() => { list._raf = 0; renderWindow(); }); }, { passive: true });
  list.addEventListener("click", (e) => { const r = e.target.closest?.(".hm-pe-card"); if (r) { list.focus({ preventScroll: true }); applyAt(Number(r.dataset.index)); } });
  list.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyAt(st.active); return; }
    const to = listMove(st.active, st.filtered.length, e.key, Math.max(1, Math.floor((list.clientHeight || 360) / ROW_H)));
    if (to >= 0) { e.preventDefault(); setActive(to); }
  });
  list.addEventListener("focus", () => renderWindow());
  list.addEventListener("blur", () => renderWindow());
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((entries) => { for (const en of entries) en.target._vis = en.isIntersecting; }, { root: list, rootMargin: "40px" });
  }

  // ---- filtering
  let countTimer = 0;
  function refilter({ keepScroll = false, announce = true } = {}) {
    st.filtered = filterPostures(st.items, st);
    const cc = categoryCounts(st.items, st);
    for (const [value, b] of chipEls) {
      b.setAttribute("aria-pressed", st.category === value ? "true" : "false");
      b.lastChild.textContent = String(cc[value] ?? 0);
      b.hidden = value === "custom" && !cc.custom && st.category !== "custom";
      b.classList.toggle("is-empty", !cc[value] && value !== "all");
    }
    const tc = tagCounts(st.items, st), shown = [...new Set([...st.tags, ...tc.map(([t]) => t)])].slice(0, 40), counts = new Map(tc);
    tagBar.replaceChildren(...shown.map((t) => {
      const b = h("button", { type: "button", class: "hm-pe-chip hm-pe-tagchip", "aria-pressed": st.tags.includes(t) ? "true" : "false" }, h("span", {}, t), h("span", { class: "hm-pe-n" }, String(counts.get(t) ?? 0)));
      b.addEventListener("click", () => { st.tags = st.tags.includes(t) ? st.tags.filter((x) => x !== t) : [...st.tags, t]; refilter(); });
      return b;
    }));
    tagCount.textContent = String(st.tags.length);
    st.active = clampNum(st.active, 0, Math.max(0, st.filtered.length - 1));
    spacer.style.height = `${st.filtered.length * ROW_H}px`;
    if (!keepScroll) { list.scrollTop = 0; st.active = 0; }
    empty.hidden = st.filtered.length > 0;
    list.hidden = st.filtered.length === 0;
    const text = `${st.filtered.length} of ${st.items.length} postures${st.category !== "all" || st.query || st.tags.length ? " match" : ""}`;
    count.textContent = text;
    clearTimeout(countTimer);
    if (!announce) count.setAttribute("aria-live", "off"); else count.setAttribute("aria-live", "polite");
    renderWindow({ force: true });
  }
  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { st.query = search.value; refilter(); }, 120); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ""; st.query = ""; refilter(); }
    else if (e.key === "ArrowDown" && st.filtered.length) { e.preventDefault(); list.focus(); setActive(st.active); }
    else if (e.key === "Enter" && st.filtered.length) { e.preventDefault(); clearTimeout(searchTimer); st.query = search.value; refilter(); list.focus(); }
  });

  refilter({ announce: false });
  return {
    el, state: st, list,
    /** The applied posture, a custom posture or the body changed: draw again what is shown. */
    refresh({ items = false, body: bodyChanged = false } = {}) {
      if (items) { buildItems(); refilter({ keepScroll: true, announce: false }); return; }
      if (bodyChanged) { palette = null; pending = []; renderWindow({ force: true }); return; }
      renderWindow();
    },
    redraw() { palette = null; for (const r of rows.values()) { const p = st.filtered[Number(r.dataset.index)]; if (p && body()) { drawThumb(r.querySelector("canvas"), p, body()); } } },
    revealBase() {
      const i = st.filtered.findIndex((p) => p.id === editor.base.id);
      if (i >= 0) setActive(i);
    },
    dispose() { io?.disconnect(); if (pumpId) cancelAnimationFrame(pumpId); clearTimeout(searchTimer); if (list._raf) cancelAnimationFrame(list._raf); },
  };
}

// ---- the current posture ----------------------------------------------------------------------------------------------------------------------------------------
/** Name, history, mirror and save, support and seat, heading, and the live readouts. Returns { el, update(), dispose() }. */
function currentView(env, lib) {
  const { ctx, editor } = env, uid = nextId("hm-pe-cur");
  const nameEl = h("strong", { class: "hm-pe-curname" }), dot = h("span", { class: "hm-pe-dot", hidden: true, title: "Edited", role: "img", "aria-label": "edited" }), baseEl = h("p", { class: "hm-pe-curbase small muted" });
  const undoB = btn("Undo", { title: "Undo the last change (Ctrl+Z)", onClick: () => { editor.undo(); env.say(`Undone. ${editor.history.canUndo ? "" : "Nothing more to undo."}`.trim()); }, className: "hm-pe-undo", ic: "undo" });
  const redoB = btn("Redo", { title: "Redo (Ctrl+Shift+Z or Ctrl+Y)", onClick: () => { editor.redo(); }, className: "hm-pe-redo", ic: "redo" });
  const resetB = btn("Reset", { title: "Back to the posture this one started from, keeping the place and the seat", onClick: () => { editor.resetToLibrary(); env.say(`Reset to ${editor.base.name}.`); } });
  const neutralB = btn("Neutral", { title: "Every joint at 0: relaxed standing, arms at the sides", onClick: () => { editor.neutral(); env.say("Neutral standing."); lib.refresh(); } });
  const mirrorB = btn("Mirror", { title: "Swap left and right (the mirror image of the posture)", onClick: () => { editor.mirror(); env.say("Mirrored left and right."); } });
  const copyLR = btn("Copy L → R", { title: "Give the right side the angles of the left side", onClick: () => { editor.copySide("L"); env.say("Copied the left side to the right."); } });
  const copyRL = btn("Copy R → L", { title: "Give the left side the angles of the right side", onClick: () => { editor.copySide("R"); env.say("Copied the right side to the left."); } });

  // save / delete / export / import
  const saveName = h("input", { type: "text", class: "input", id: `${uid}-name`, maxlength: "60", placeholder: "Name of the posture", autocomplete: "off" });
  const saveCat = h("select", { class: "input hm-pe-select", id: `${uid}-cat`, "aria-label": "Category of the new posture" }, CATEGORIES.map((c) => h("option", { value: c.name }, c.name)));
  const saveMsg = h("p", { class: "small hm-pe-formmsg", role: "status" });
  const saveForm = h("form", { class: "hm-pe-form", hidden: true, novalidate: "" },
    h("label", { class: "hm-pe-flabel", for: saveName.id }, "Save as a custom posture"), saveName, h("label", { class: "hm-pe-flabel", for: saveCat.id }, "Category"), saveCat,
    h("div", { class: "hm-pe-row" }, btn("Save", { className: "primary" }), btn("Cancel", { onClick: (e) => { e.preventDefault(); closeSave(); } })), saveMsg);
  saveForm.querySelector("button.primary").type = "submit";
  const saveB = btn("Save as custom…", { title: "Keep this pose in the Custom group of the library (kept in this browser only)", onClick: () => { openSave(); }, ic: "save" });
  let dupAsked = "";
  saveName.addEventListener("input", () => { dupAsked = ""; });
  function openSave() {
    dupAsked = "";
    saveForm.hidden = false; saveB.setAttribute("aria-expanded", "true");
    const b = editor.base;
    saveName.value = b.kind === "custom" ? b.name : b.kind === "neutral" ? "My posture" : `${b.name} (edited)`.slice(0, 60);
    saveCat.value = (editor.getPosture(b.id ?? "")?.category) ?? "Reference";
    saveMsg.textContent = "";
    saveName.focus(); saveName.select();
  }
  function closeSave() { saveForm.hidden = true; saveB.setAttribute("aria-expanded", "false"); saveB.focus(); }
  saveB.setAttribute("aria-expanded", "false"); saveB.setAttribute("aria-controls", saveForm.id = `${uid}-saveform`);
  saveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { overwrite, duplicate } = saveTarget(editor.base, editor.listCustom(), saveName.value);
    if (duplicate && dupAsked !== saveName.value.trim()) { // a second posture with the name of a saved one: ask once, nothing is overwritten either way
      dupAsked = saveName.value.trim();
      saveMsg.textContent = `A saved posture is already called "${dupAsked}". Press Save again to keep both, or choose another name.`;
      saveMsg.classList.add("is-error");
      saveName.focus();
      return;
    }
    const r = await editor.saveCustom(saveName.value, { category: saveCat.value, overwrite });
    if (!r.ok) { saveMsg.textContent = r.error; saveMsg.classList.add("is-error"); return; }
    saveMsg.classList.remove("is-error");
    env.say(`Saved as the custom posture "${r.posture.name}".${r.warning ? ` ${r.warning}` : ""}`);
    if (r.warning) env.notify(r.warning);
    closeSave();
  });
  saveForm.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSave(); } });
  const delB = btn("Delete", { title: "Delete this custom posture from the library", className: "hm-pe-del", ic: "trash", onClick: () => { delConfirm.hidden = false; delB.hidden = true; delYes.focus(); } });
  const delYes = btn("Delete it", { className: "hm-pe-danger", onClick: () => { const id = editor.base.id, nm = editor.base.name; if (editor.deleteCustom(id)) env.say(`Deleted "${nm}".`); delConfirm.hidden = true; delB.hidden = false; update(); (delB.hidden ? saveB : delB).focus(); } });
  const delNo = btn("Keep it", { onClick: () => { delConfirm.hidden = true; delB.hidden = false; delB.focus(); } });
  const delConfirm = h("div", { class: "hm-pe-row hm-pe-confirm", hidden: true, role: "group", "aria-label": "Confirm deleting the custom posture" }, h("span", { class: "small" }, "Delete this posture for good?"), delYes, delNo);
  const exportB = btn("Export", { title: "Download the pose as a posture JSON file (the same file as the Export tab)", ic: "download", onClick: async () => {
    try {
      const { exportFileName } = await import("../export.js");
      const text = await editor.exportPostureText();
      download(exportFileName({ profile: ctx.getProfile(), posture: ctx.state.posture, what: "posture", ext: "json" }), text, "application/json");
      env.say("Posture file saved.");
    } catch (e) { env.say(`The posture file could not be made (${String(e.message).slice(0, 120)}).`, "error"); }
  } });
  const fileIn = h("input", { type: "file", accept: "application/json,.json", class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
  const importB = btn("Import…", { title: "Show a posture file (also a bare posture or pose JSON) on the figure", ic: "upload", onClick: () => fileIn.click() });
  const importMsg = h("div", { class: "hm-pe-importmsg", role: "status" });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    fileIn.value = "";
    if (!f) return;
    const r = await editor.importPosture(f);
    importMsg.replaceChildren(r.ok ? notice(`Showing "${r.name}".${r.warnings?.length ? ` ${r.warnings.slice(0, 3).join(" ")}` : ""}`, { level: r.warnings?.length ? "warn" : "info", onDismiss: () => importMsg.replaceChildren() }) : notice(`That file cannot be used. ${r.errors.slice(0, 3).join(" ")}`, { level: "error", onDismiss: () => importMsg.replaceChildren() }));
    if (r.ok) env.say(`Imported "${r.name}".`);
  });
  // ergonomic correction: the verdict chip sits next to the name; the switch shows the corrected posture and the before/after table
  const verdictChip = h("span", { class: "tag hm-pe-verdict", hidden: true, role: "status" });
  // MIL-STD-1472H: the chip next to the name and the clauses of the current pose (ranges of motion of Table XXXI, the posture's load)
  const milChip = h("span", { class: "tag hm-pe-mil", hidden: true });
  const milList = h("ul", { class: "hm-pe-millist small" });
  const milBox = h("details", { class: "hm-pe-details hm-pe-milbox" }, h("summary", {}, "MIL-STD-1472H clauses of this posture"), milList,
    h("p", { class: "small muted" }, "Ranges of motion of Table XXXI (5.8.4.3) and the load the posture holds (5.20.3, 5.20.4), on this body. The scene's objects and interactions are in the Analysis tab."));
  let corr = null; // { original: { angles }, result, applied } while the corrected posture is on the figure
  const corrMsg = h("p", { class: "small hm-pe-corrmsg", role: "status" });
  const corrTable = h("div", { class: "hm-pe-corrtable", hidden: true, role: "region", "aria-label": "Before and after the correction" });
  const corrSwitch = switchRow({ label: "Show corrected posture", hint: "Moves the joints toward the ISO 11226 limits; the palms stay within 15 cm and the figure is re-grounded. One undo step.", checked: false, onChange: (v) => setCorrection(v) });
  // the figure may round the angles a little when it clamps them: compare within 0.05 degrees
  const sameAngles = (a, b) => { if (!a || !b) return false; for (const k of Object.keys(b)) { const x = a[k] ?? [], y = b[k] ?? []; for (let i = 0; i < y.length; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 0.05) return false; } return true; };
  const rigAngles = () => { const r = ctx.getRig(); if (!r) return null; const p = r.getPose(); return Object.fromEntries(Object.entries(p.angles).map(([k, a]) => [k, Array.from(a)])); };
  function setCorrection(on) {
    if (!on) {
      if (corr) { try { editor.setPose({ angles: corr.original.angles }, { record: true }); } catch (e) { env.say(String(e.message), "error"); } }
      corr = null; corrMsg.textContent = ""; corrTable.hidden = true; return;
    }
    const r = ctx.getRig(), body = ctx.getBody?.() ?? r?.restBody ?? r?.body;
    if (!r || !body) { corrSwitch.set(false); return; }
    const pose = r.getPose(), info = editor.info(), seated = Object.values(info.place.carriers ?? {}).includes("seat");
    let res;
    try { res = correctAngles(body, { root: pose.root, angles: pose.angles }, { flagOptions: { seated } }); }
    catch (e) { corrSwitch.set(false); corrMsg.textContent = `The correction could not be worked out (${String(e.message).slice(0, 100)}).`; return; }
    if (res.changed === 0 || res.cost.after >= res.cost.before - 1e-9) { corrSwitch.set(false); corrMsg.textContent = "No change within the limits makes this posture more acceptable: the flags come from the support or the task, not from the joints."; return; }
    corr = { original: { angles: pose.angles }, result: res, applied: false };
    editor.setPose({ angles: res.angles }, { record: true });
    const after = editor.info();
    if (after.balance?.status === "falls") { // the corrected figure would fall over: keep the original
      editor.setPose({ angles: pose.angles }, { record: true }); corr = null; corrSwitch.set(false);
      corrMsg.textContent = "The corrected posture would fall over, so the original is kept. Change the support or the stance first.";
      return;
    }
    corr.applied = true; corr.corrected = res.angles;
    env.say("Showing the corrected posture.");
    update();
  }
  function corrTableRender(info) {
    if (!corr?.applied) { corrTable.hidden = true; return; }
    const rows = compareFlags(corr.result.before, info.flags ?? []).filter((r) => r.status !== "ok");
    const word = { "not-acceptable": "not acceptable", check: "check", acceptable: "acceptable" };
    const { verdictBefore: vb, verdictAfter: va, hands, changed } = corr.result;
    const verdict = vb === va ? `Still ${word[va]}: the flags are reduced, not removed.` : `Verdict: ${word[vb]} → ${word[va]}.`;
    const sev = (f) => f ? h("span", { class: `tag ${f.severity === "high" ? "bad" : f.severity === "caution" ? "warn" : "good"}` }, `${Math.round(f.value * 10) / 10}° ${f.severity === "high" ? "not acceptable" : f.severity === "caution" ? "check" : "ok"}`) : h("span", { class: "muted" }, "—");
    const res = { fixed: "fixed", worse: "worse", unchanged: "still flagged" };
    corrTable.replaceChildren(
      h("p", { class: "small hm-pe-corrsum" }, verdict, ` Palms moved ${Math.round(hands.L * 1000)} mm (left) and ${Math.round(hands.R * 1000)} mm (right); ${changed} joints changed.`),
      rows.length ? h("ul", { class: "hm-pe-corrlist", "aria-label": "Measures before and after" }, rows.map((r) => h("li", { class: `hm-pe-corrrow is-${r.status}` },
        h("span", { class: "hm-pe-corrlabel" }, r.label),
        h("span", { class: "hm-pe-corrvals" }, sev(r.before), h("span", { class: "hm-pe-arrow", "aria-hidden": "true" }, "→"), sev(r.after), h("span", { class: "hm-pe-corrres small muted" }, res[r.status] ?? r.status))))) : h("p", { class: "small muted" }, "No flag remains."));
    corrTable.hidden = false;
  }

  const animate = switchRow({ label: "Animate", hint: "Glide into a posture (off with reduced motion)", checked: editor.options.animate, onChange: (v) => { editor.setOption("animate", v); env.savePrefs(); } });
  const stay = switchRow({ label: "Stay on the floor or seat", hint: "Re-ground the figure after every edit", checked: editor.options.stick, onChange: (v) => { editor.setStick(v); } });

  // placement
  const supportSel = h("select", { class: "input hm-pe-select", id: `${uid}-support`, "aria-label": "What carries the weight" }, Object.keys(SUPPORT_CARRIERS).map((k) => h("option", { value: k, title: SUPPORT_INFO[k] }, supportLabel(k))));
  supportSel.addEventListener("change", () => { try { editor.setSupport(supportSel.value); } catch (e) { env.say(String(e.message), "error"); } });
  const modeSeg = h("div", { class: "seg hm-seg hm-pe-seg", role: "group", "aria-label": "Surface under the figure" },
    ...[["floor", "Floor", "Everything rests on the floor (a seat is the floor)"], ["seat", "Seat", "Sit on a seat of the height below, or on a chair of the scene"], ["free", "Free", "The figure is not placed: it stays where you put it"]].map(([value, label, title]) =>
      h("button", { type: "button", dataset: { value }, title, "aria-pressed": "false", onclick: () => { try { editor.setMode(value); } catch (e) { env.say(String(e.message), "error"); } } }, label)));
  const modeNote = h("p", { class: "small muted hm-pe-modenote" });
  const chairSel = h("select", { class: "input hm-pe-select", id: `${uid}-chair`, "aria-label": "Sit on" });
  chairSel.addEventListener("change", () => {
    const v = chairSel.value;
    if (!v) { editor.setSeatHeight(editor.seatHeight() ?? 0.43); return; }
    const [objectId, supportId] = v.split("\u0000");
    if (!editor.sitOn(objectId, supportId)) env.say("That seat is no longer in the scene.", "error");
  });
  const chairRow = h("div", { class: "hm-pe-field", hidden: true }, h("label", { for: chairSel.id, class: "hm-pe-flabel" }, "Sit on"), chairSel);
  let seatRow = null;
  const seatHost = h("div", { class: "hm-pe-seathost" });
  function makeSeatRow() {
    seatRow?.dispose();
    const u = ctx.units;
    seatRow = dofRow(env, {
      label: "Seat height", why: "by the allowed seat heights", unit: UNIT_LABEL[u], step: u === "mm" ? 5 : u === "cm" ? 0.5 : 0.25, format: (v) => `${Number(v.toFixed(unitDigits(u)))} ${UNIT_LABEL[u]}`,
      hint: "Height of the seat plane above the floor. The posture's own seat (the popliteal height of this body) is the default.",
      get: () => toUnit((editor.seatHeight() ?? 0) * 1000, u), set: (v, record) => editor.setSeatHeight(Math.min(1.5, Math.max(0, fromUnit(v, u) / 1000)), { record }),
      bounds: () => ({ min: 0, max: toUnit(1500, u), lo: 0, hi: toUnit(1500, u) }),
      begin: () => editor.beginGesture("Seat height", "seat-height"),
    });
    seatHost.replaceChildren(seatRow.el);
  }
  makeSeatRow();
  const headingRow = dofRow(env, {
    label: "Heading", hint: "Turn the figure about its support. 0 faces the front of the grid (+Z); positive turns it to its left.",
    get: () => editor.place.heading, set: (v, record) => editor.setHeading(v, { record }), bounds: () => ({ min: -180, max: 180, lo: -180, hi: 180 }), begin: () => editor.beginGesture("Heading", "heading"), step: 1,
  });
  const resetPlace = btn("Seat of the posture", { title: "Use the seat height that the posture itself asks for", onClick: () => { editor.useSeatOfPosture(); } });

  // readouts
  const balanceEl = h("span", { class: "tag hm-pe-balance" }), gapsEl = h("span", { class: "hm-pe-gaps" }), romEl = h("div", { class: "hm-pe-rom", role: "status", "aria-live": "polite" });
  const clampEl = h("p", { class: "hm-pe-clamp small", role: "status", "aria-live": "polite" });
  const anglesEl = h("dl", { class: "hm-pe-angles" }), flagsEl = h("div", { class: "hm-pe-flags" });
  const angleBox = h("details", { class: "hm-pe-details" }, h("summary", {}, "Key angles and indications"), anglesEl, flagsEl, h("p", { class: "small muted" }, "A kinematic indication on a simplified model (ISO 11226 limits), not a risk assessment."));
  const col = (a) => h("div", { class: "hm-pe-block" }, ...a);
  const el = h("div", { class: "hm-pe-cur" },
    h("div", { class: "hm-pe-curhead" }, nameEl, dot, verdictChip, milChip), baseEl,
    h("div", { class: "hm-pe-row hm-pe-actions", role: "group", "aria-label": "History and reset" }, undoB, redoB, resetB, neutralB),
    h("div", { class: "hm-pe-row hm-pe-actions", role: "group", "aria-label": "Mirror" }, mirrorB, copyLR, copyRL),
    h("div", { class: "hm-pe-row hm-pe-actions", role: "group", "aria-label": "Save and files" }, saveB, delB, exportB, importB, fileIn), saveForm, delConfirm, importMsg,
    h("div", { class: "hm-pe-switches" }, corrSwitch.el, animate.el, stay.el), corrMsg, corrTable,
    col([h("h3", { class: "hm-pe-h3" }, "Placement"), h("div", { class: "hm-pe-field" }, h("label", { for: supportSel.id, class: "hm-pe-flabel" }, "Carried by"), supportSel), modeSeg, modeNote, chairRow, seatHost, h("div", { class: "hm-pe-row" }, resetPlace), headingRow.el]),
    col([h("h3", { class: "hm-pe-h3" }, "Live readouts"), h("div", { class: "hm-pe-chiprow" }, balanceEl, gapsEl), romEl, clampEl, angleBox, milBox]));

  let lastSig = "", clampTimer = 0;
  /** The MIL-STD-1472H chip and clause list of the current pose. */
  function updateMil(info) {
    const r = ctx.getRig(), body = ctx.getBody?.() ?? r?.restBody ?? r?.body;
    if (!r || !body) { milChip.hidden = true; return; }
    let res;
    try {
      const pose = r.getPose(), src = info.base.id ? editor.getPosture(info.base.id) : null;
      res = checkPosture(body, { root: pose.root, angles: pose.angles }, { ...(src ?? {}), id: info.base.id, name: info.base.name, support: info.place.support, category: src?.category ?? "" }).results;
    } catch { milChip.hidden = true; return; }
    const sum = summarize(res);
    milChip.hidden = false;
    milChip.textContent = `1472H: ${STATUS_WORD[sum.status]}`;
    milChip.dataset.state = sum.status;
    milChip.title = tagText(sum);
    ctx.setMilVerdict?.({ status: sum.status, failed: sum.failed, toCheck: sum.toCheck });
    const shown = res.filter((x) => x.status !== "pass");
    const sig = JSON.stringify(res.map((x) => [x.id, x.status, Math.round((x.value ?? 0) * 10)]));
    if (milList._sig === sig) return;
    milList._sig = sig;
    const word = { pass: "Meets", fail: "Fails", check: "Check", input: "Needs input", na: "N/A" };
    milList.replaceChildren(
      h("li", {}, h("strong", {}, `${STATUS_WORD[sum.status]}. `), tagText(sum)),
      ...shown.map((x) => h("li", { "data-status": x.status }, h("span", { class: `tag hm-pe-milst`, dataset: { state: x.status } }, word[x.status]), " ", h("strong", {}, clauseRef(x)), `: ${x.note || x.title}`, x.value != null ? ` (${Math.round(x.value * 10) / 10}${x.unit === "°" ? "°" : ` ${x.unit}`}; limit ${x.limit})` : x.limit ? ` (${x.limit})` : "")),
      ...(shown.length ? [] : [h("li", { class: "muted" }, `Every checked clause is met (${sum.counts.pass} checks).`)]));
  }
  angleBox.addEventListener("toggle", () => { anglesEl._sig = flagsEl._sig = null; if (angleBox.open) update(); });
  function update() {
    const info = (() => { try { return editor.info(); } catch { return null; } })();
    const base = editor.base, mod = !!info?.modified;
    const saved = base.kind === "custom" && editor.listCustom().some((p) => p.id === base.id); // a custom posture that was deleted is still on the figure, but there is nothing left to delete
    nameEl.textContent = base.name;
    if (info) {
      const v = verdictOf(info.flags ?? []), label = { "not-acceptable": "Not acceptable", check: "Check posture", acceptable: "Acceptable" }[v];
      verdictChip.hidden = false; verdictChip.textContent = label; verdictChip.className = `tag hm-pe-verdict ${v === "not-acceptable" ? "bad" : v === "check" ? "warn" : "good"}`;
      verdictChip.title = "ISO 11226 indication for the static posture (not a risk assessment); see the flags in Key angles and indications";
      corrSwitch.el.querySelector("input").disabled = v === "acceptable" && !corr;
      if (corr?.applied && !sameAngles(rigAngles(), corr.corrected)) { corr = null; corrSwitch.set(false); corrMsg.textContent = "The posture was changed by hand, so the correction is cleared."; }
      corrTableRender(info);
      if (ctx.setVerdict && ctx.state.postureVerdict !== v) ctx.setVerdict(v);
      updateMil(info);
    }
    dot.hidden = !mod;
    baseEl.textContent = mod ? `Edited from ${base.kind === "neutral" ? "neutral standing" : base.kind === "custom" ? (saved ? "your custom posture" : "a custom posture that is no longer saved") : base.kind === "imported" ? "an imported posture" : "the library posture"}.` : { library: "Library posture.", custom: saved ? "Your custom posture, saved in this browser." : "A custom posture that is no longer saved. Use Save as custom to keep it.", imported: "Imported from a file.", neutral: "Every joint at 0." }[base.kind] ?? "";
    const h_ = editor.history;
    undoB.disabled = !h_.canUndo; redoB.disabled = !h_.canRedo;
    undoB.title = h_.canUndo ? `Undo: ${h_.undoLabel} (Ctrl+Z)` : "Nothing to undo"; redoB.title = h_.canRedo ? `Redo: ${h_.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo";
    resetB.disabled = !mod;
    delB.hidden = !saved || !delConfirm.hidden; if (!saved) delConfirm.hidden = true;
    const o = editor.options, place = editor.place;
    animate.set(o.animate); stay.set(place.stick);
    if (supportSel.value !== place.support) supportSel.value = place.support;
    for (const b of modeSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.value === place.mode ? "true" : "false");
    const hasSeat = Object.values(SUPPORT_CARRIERS[place.support] ?? {}).includes("seat");
    modeNote.textContent = place.mode === "free" ? "Free: nothing re-grounds the figure. Move it with the pelvis handle or the heading." : !hasSeat && place.mode === "seat" ? "This posture does not use a seat." : place.mode === "floor" && hasSeat ? "Sitting on the floor." : "";
    seatHost.hidden = !(hasSeat && place.mode === "seat");
    resetPlace.hidden = seatHost.hidden || place.seat.kind === "auto";
    // chairs of the scene
    const seats = editor.seatSurfaces(), sel = ctx.state.selection;
    chairRow.hidden = !seats.length || !hasSeat;
    const chairSig = JSON.stringify([seats.map((s) => [s.objectId, s.id, s.name, Math.round(s.y * 1000)]), place.seat.kind, place.seat.objectId, place.seat.supportId, sel?.kind === "object" ? sel.id : null]);
    if (chairSig !== lastSig) {
      lastSig = chairSig;
      chairSel.replaceChildren(h("option", { value: "" }, "A seat of this height (above)"), ...seats.map((s) => h("option", { value: `${s.objectId}\u0000${s.id}` }, `${s.name} (${ctx.fmt(s.y * 1000)})${sel?.kind === "object" && sel.id === s.objectId ? ", selected" : ""}`)));
      chairSel.value = place.seat.kind === "object" ? `${place.seat.objectId}\u0000${place.seat.supportId}` : "";
    }
    if (!seatHost.hidden) seatRow.update();
    headingRow.update();
    if (!info) return;
    // the readouts are rebuilt only when their text changes (they update at the rate of a slider drag; a focused chip must keep its focus)
    const once = (el, sig, build) => { if (el._sig !== sig) { el._sig = sig; el.replaceChildren(...build()); } };
    const bal = balanceText(info.balance, ctx.fmt);
    balanceEl.className = `tag hm-pe-balance ${bal.kind}`.trim(); balanceEl.textContent = bal.text; balanceEl.title = bal.title ?? "";
    const gaps = gapTexts(info.gaps, ctx.fmt);
    once(gapsEl, JSON.stringify(gaps), () => gaps.map((g) => h("span", { class: `tag ${g.kind}`.trim() }, g.text)));
    const rom = info.romViolations;
    once(romEl, JSON.stringify(rom.map((v) => [v.joint, v.dof, fmtDeg(v.value)])), () => (rom.length ? [h("span", { class: "hm-pe-romhead" }, `${rom.length} outside the range of motion:`), ...rom.slice(0, 12).map((v) => h("button", { type: "button", class: "tag bad hm-pe-romchip", title: `${v.label}: ${fmtDeg(v.value)}, range ${fmtDeg(v.min, 0)} to ${fmtDeg(v.max, 0)}. Click to select the joint.`, onclick: () => env.selectJoint(v.joint) }, `${v.label.replace(/^[^:]*: /, "")} (${JOINT_BY_ID[v.joint]?.label ?? v.joint}) ${fmtDeg(v.value)}`)), ...(rom.length > 12 ? [h("span", { class: "small muted" }, `and ${rom.length - 12} more`)] : [])] : []));
    if (angleBox.open) once(anglesEl, JSON.stringify(info.angles.map((a) => [a.key, fmtDeg(a.value)])), () => info.angles.flatMap((a) => [h("dt", {}, a.label), h("dd", {}, a.unit === "m" ? ctx.fmt(a.value * 1000) : fmtDeg(a.value))]));
    const fl = info.flags.filter((f) => f.severity !== "ok");
    if (angleBox.open) once(flagsEl, JSON.stringify(info.flags.map((f) => [f.id, f.severity, f.value])), () => (info.flags.length ? (fl.length ? fl.map((f) => h("span", { class: `tag ${f.severity === "high" ? "bad" : "warn"}`, title: f.note }, `${f.label}: ${typeof f.value === "number" ? fmtDeg(f.value) : f.value}`)) : [h("span", { class: "tag good" }, "No ISO 11226 indication")]) : []));
  }
  function showClamps(list) {
    clearTimeout(clampTimer);
    if (!list?.length) { clampEl.textContent = ""; return; }
    clampEl.textContent = `Limited by the range of motion: ${list.slice(0, 3).map((c) => `${c.joint in JOINT_BY_ID ? JOINT_BY_ID[c.joint].label : `${c.joint} spine`} ${c.dof} ${fmtDeg(c.requested)} became ${fmtDeg(c.applied)}`).join("; ")}${list.length > 3 ? `; and ${list.length - 3} more` : ""}.`;
    clampTimer = setTimeout(() => { clampEl.textContent = ""; }, 6000);
  }
  return { el, update, showClamps, openSave, units() { makeSeatRow(); update(); }, dispose() { clearTimeout(clampTimer); seatRow?.dispose(); headingRow.dispose(); } };
}

// ---- editing: tabs of sliders and the IK handles ------------------------------------------------------------------------------------------------------------------
/** The Edit section: switches, the eight body-region tabs and the IK handle controls. Returns { el, update(), showJoint(id), dispose() }. */
function editView(env, layer, prefs) {
  const { ctx, editor } = env;
  const views = new Map();
  const romSw = switchRow({ label: "Enforce range of motion", hint: "Off: sliders go past the limits, in red", checked: editor.options.enforceRom, onChange: (v) => { editor.setOption("enforceRom", v); env.refreshNow(); env.say(v ? "Range of motion is enforced." : "Range of motion is not enforced: angles beyond the limits are shown in red."); } });
  const symSw = switchRow({ label: "Symmetric", hint: "An edit also moves the other side", checked: editor.options.symmetric, onChange: (v) => { editor.setOption("symmetric", v); env.savePrefs(); env.refreshNow(); } });
  const outBadge = h("span", { class: "tag bad hm-pe-outcount", hidden: true, role: "status" });
  const tabs = tablist({ label: "Body region", tabs: EDIT_TABS.map((t) => ({ id: t.id, label: t.short })), selected: EDIT_TABS.some((t) => t.id === prefs.tab) ? prefs.tab : "spine", onSelect: (id) => showTab(id), idPrefix: nextId("hm-pe-tab") });
  tabs.el.classList.add("hm-pe-tabs");
  for (const t of EDIT_TABS) { const b = tabs.tabEl(t.id); b.title = t.label; b.setAttribute("aria-label", t.label); }
  // One panel element per tab (only the selected one is shown), so that the aria-controls of every tab names an element that exists.
  const panels = new Map(EDIT_TABS.map((t) => [t.id, h("div", { class: "hm-pe-tabpanel", role: "tabpanel", tabindex: "-1", id: tabs.panelId(t.id), "aria-labelledby": tabs.tabId(t.id), hidden: true })]));
  const panel = h("div", { class: "hm-pe-tabpanels" }, ...panels.values());

  function build(id) {
    const t = EDIT_TABS.find((x) => x.id === id), parts = [];
    const add = (v) => { parts.push(v); return v; };
    if (t.root) add(rootEditor(env));
    for (const r of t.regions ?? []) add(regionEditor(env, r));
    if (t.grips) add(handEditor(env, t.side));
    for (const j of t.joints) add(jointEditor(env, j));
    let extra = null;
    if (t.id === "spine") {
      let built = null;
      const ids = ["L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1"];
      const box = h("div", { class: "hm-pe-vertebrae" });
      extra = h("details", { class: "hm-pe-details hm-pe-vdetails" }, h("summary", {}, "Individual vertebrae"), box);
      extra.addEventListener("toggle", () => {
        if (extra.open && !built) { built = ids.map((v) => jointEditor(env, v)); box.append(...built.map((b) => b.el)); parts.push(...built); }
        if (extra.open) for (const b of built ?? []) b.update();
      });
    }
    const el = h("div", { class: "hm-pe-tabbody", dataset: { tab: id } }, ...parts.map((p) => p.el), extra);
    return { el, parts, update() { for (const p of parts) p.update(); }, dispose() { for (const p of parts) p.dispose(); }, extra };
  }
  function showTab(id) {
    if (!views.has(id)) views.set(id, build(id));
    const v = views.get(id);
    for (const [k, p] of panels) { p.hidden = k !== id; if (k === id && !p.firstChild) p.append(v.el); }
    v.update();
    prefs.tab = id;
    env.savePrefs();
  }

  // ---- IK handles
  const ikSw = switchRow({ label: "IK handles", hint: "Drag the coloured handles in the 3D view", checked: prefs.ik !== false, onChange: (v) => { setIk(v); } });
  const pelvisSeg = h("div", { class: "seg hm-seg hm-pe-seg", role: "group", "aria-label": "What the pelvis handle does" },
    ...[["bend", "Bend, feet stay", "Move the pelvis and let the legs follow, the feet staying where they are (a squat, a stoop)"], ["move", "Move figure", "Slide the whole figure over its support"]].map(([value, label, title]) =>
      h("button", { type: "button", dataset: { value }, title, "aria-pressed": "false", onclick: () => { editor.setOption("pelvisMode", value); env.savePrefs(); update(); } }, label)));
  const footSeg = h("div", { class: "seg hm-seg hm-pe-seg", role: "group", "aria-label": "Point of the foot that the handle holds" },
    ...[["ball", "Ball of foot", "The foot handle holds the ball of the foot (the sole stays flat near the floor)"], ["heel", "Heel", "The foot handle holds the heel"]].map(([value, label, title]) =>
      h("button", { type: "button", dataset: { value }, title, "aria-pressed": "false", onclick: () => { editor.setOption("footPoint", value); env.savePrefs(); update(); } }, label)));
  const mk = (key, label, hint, optKey = key) => switchRow({ label, hint, checked: !!editor.options[optKey], onChange: (v) => { editor.setOption(optKey, v); env.savePrefs(); } });
  const pinFeet = mk("pinFeet", "Keep the feet in place", "While moving the pelvis"), pinHands = mk("pinHands", "Keep the hands in place", "While moving the pelvis or the chest");
  const assist = mk("trunkAssist", "Lean the body to reach", "A hand or the gaze may use the trunk"), keepHand = mk("handFrame", "Keep the hand's orientation", "While a hand handle moves");
  const polesSw = switchRow({ label: "Elbow and knee handles", checked: prefs.poles !== false, onChange: (v) => { layer.setPoles(v); prefs.poles = v; env.savePrefs(); } });
  const lookSw = switchRow({ label: "Look-at target", hint: "A point 1 m in front of the eyes; drag it and the head and eyes follow", checked: editor.lookActive, onChange: (v) => { editor.toggleLook(v); update(); } });
  const lookObj = btn("Look at the selected object", { title: "Turn the head and eyes toward the centre of the object selected in the Scene tab", onClick: () => env.lookAt("object") });
  const lookMeas = btn("Look at the measurement point", { title: "Turn the head and eyes toward the point of the selected measurement that is not on the figure", onClick: () => env.lookAt("measure") });
  const hint = h("p", { class: "small muted hm-pe-hint" }, "Press on a handle in the 3D view and drag. Every drag is one undo step. Tab to a handle below and use the arrow keys instead of the mouse.");
  const status = h("p", { class: "hm-pe-ikstatus small", role: "status", "aria-live": "polite" });
  const hbtns = new Map();
  const handleBar = h("div", { class: "hm-pe-handles", role: "group", "aria-label": "Handles. Tab to one, then arrow keys move it 10 mm; Shift 100 mm, Alt 1 mm. Page Up and Page Down move it away from and toward the camera." });
  for (const hd of HANDLES) {
    const b = h("button", { type: "button", class: "hm-pe-handlebtn", dataset: { handle: hd.id }, "aria-pressed": "false", title: handleHint(hd) }, h("span", { class: `hm-pe-swatch hm-pe-sw-${hd.color}`, "aria-hidden": "true" }), h("span", {}, hd.label));
    b.addEventListener("click", () => ctx.select({ kind: "handle", id: hd.id }));
    b.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey) return;
      const dir = ctx.viewport.camera.getWorldDirection(new THREE.Vector3()), ax = viewAxes([dir.x, dir.y, dir.z]);
      const v = nudgeVector(e.key, { shift: e.shiftKey, alt: e.altKey }, ax.right, ax.fwd);
      if (!v) return;
      e.preventDefault();
      env.nudge(hd.id, v);
    });
    b.addEventListener("focus", () => { if (ctx.state.selection?.id !== hd.id || ctx.state.selection?.kind !== "handle") ctx.select({ kind: "handle", id: hd.id }); });
    hbtns.set(hd.id, b);
    handleBar.append(b);
  }
  const ikBody = h("div", { class: "hm-pe-ikbody" }, pelvisSeg, footSeg, pinFeet.el, pinHands.el, assist.el, keepHand.el, polesSw.el, lookSw.el, h("div", { class: "hm-pe-row" }, lookObj, lookMeas), hint, handleBar, status);
  const ikDetails = h("details", { class: "hm-pe-details hm-pe-ik", open: prefs.ikOpen === true }, h("summary", {}, "Handle options and keyboard controls"), ikBody);
  ikDetails.addEventListener("toggle", () => { prefs.ikOpen = ikDetails.open; env.savePrefs(); });
  function setIk(on_) {
    prefs.ik = on_;
    layer.setEnabled(on_ && env.shown());
    ikBody.classList.toggle("is-off", !on_);
    for (const el of ikBody.querySelectorAll("button, input, select")) el.disabled = !on_ || (el.dataset.handle === "gaze" && !editor.lookActive);
    env.savePrefs();
    update();
  }
  function showIkStatus(e) {
    const s = e.status;
    if (e.phase === "begin") { status.textContent = ""; status.classList.remove("is-bad"); return; }
    if (e.phase === "cancel") { status.textContent = "Drag cancelled."; status.classList.remove("is-bad"); return; }
    if (!s) return;
    const bad = s.state === "short";
    if (e.phase === "move" && !bad) { if (status.classList.contains("is-bad")) { status.textContent = ""; status.classList.remove("is-bad"); } return; }
    status.classList.toggle("is-bad", bad);
    status.textContent = bad ? `Cannot reach: ${s.short}. ${s.message}${s.note ? ` ${s.note}` : ""}` : e.phase === "end" ? `${s.label}: reached.${s.note ? ` ${s.note}` : ""}` : "";
  }

  function update() {
    const o = editor.options;
    romSw.set(o.enforceRom); symSw.set(o.symmetric); pinFeet.set(o.pinFeet); pinHands.set(o.pinHands); assist.set(o.trunkAssist); keepHand.set(o.handFrame); lookSw.set(editor.lookActive);
    for (const b of pelvisSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.value === o.pelvisMode ? "true" : "false");
    for (const b of footSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.value === o.footPoint ? "true" : "false");
    const sel = ctx.state.selection;
    for (const [id, b] of hbtns) {
      b.setAttribute("aria-pressed", sel?.kind === "handle" && sel.id === id ? "true" : "false");
      if (id === "gaze") b.disabled = !prefs.ik || !editor.lookActive;
      b.classList.toggle("is-unavailable", !editor.handleAvailable(id) && id !== "gaze");
    }
    const ik = editor.ikReady;
    ikSw.input.disabled = !ik;
    ikSw.el.title = ik ? "" : "The inverse kinematics module is still loading";
    lookObj.disabled = !prefs.ik || !ik; lookMeas.disabled = !prefs.ik || !ik;
    let n = 0;
    try { n = editor.info().romViolations.length; } catch { /* no figure */ }
    outBadge.hidden = !n; outBadge.textContent = `${n} outside the range`;
    views.get(tabs.selected)?.update();
  }
  const el = h("div", { class: "hm-pe-edit" }, h("div", { class: "hm-pe-switches" }, romSw.el, symSw.el, ikSw.el, outBadge), status, tabs.el, panel, ikDetails);
  showTab(tabs.selected);
  setIk(prefs.ik !== false);
  return {
    el, update, showIkStatus, setIk,
    /** Select a joint: its tab opens and its sliders scroll into view. */
    showJoint(jointId) {
      const tabId = tabOfJoint(jointId);
      if (!tabId) return;
      if (tabs.selected !== tabId) tabs.select(tabId);
      const v = views.get(tabId);
      if (REGIONS_OF_VERTEBRAE.has(jointId) && v?.extra && !v.extra.open) v.extra.open = true;
      requestAnimationFrame(() => {
        const node = panels.get(tabs.selected)?.querySelector(`[data-joint="${jointId}"]`);
        if (node) { node.scrollIntoView({ block: "nearest" }); node.classList.add("is-flash"); setTimeout(() => node.classList.remove("is-flash"), 1600); }
      });
    },
    dispose() { for (const v of views.values()) v.dispose(); },
  };
}
const REGIONS_OF_VERTEBRAE = new Set(Object.values(REGIONS).flatMap((r) => r.joints));

// ---- the inspector (right-hand column) ----------------------------------------------------------------------------------------------------------------------------
/** The joint editor (or the handle controls) for the selection. Returns { el, title(), update(), dispose() }. */
function inspectorView(env) {
  const { ctx, editor } = env;
  const root = h("div", { class: "hm-pe-insp" });
  let cur = null, sk = null;
  const legend = () => h("div", { class: "hm-pe-inspempty" }, emptyState("Nothing selected.", "Turn on Joints in the toolbar under the 3D view and click a joint marker, choose a joint in the Skeleton tab, or click a handle on the figure, to edit it here."),
    h("ul", { class: "hm-pe-legend small" }, ...HANDLES.filter((x) => x.kind !== "gaze").map((x) => h("li", {}, h("span", { class: `hm-pe-swatch hm-pe-sw-${x.color}`, "aria-hidden": "true" }), `${x.label}: ${{ reach: "drag to reach", foot: "drag to place the foot", pelvis: "drag to squat or slide", chest: "drag to lean the trunk", pole: "drag to swivel" }[x.kind]}`))));
  function handleView(id) {
    const hd = HANDLES.find((x) => x.id === id);
    const pos = h("p", { class: "small hm-pe-handlepos" });
    const stepSel = h("select", { class: "input hm-pe-select", "aria-label": "Size of a step" }, [["1", "1 mm"], ["10", "10 mm"], ["100", "100 mm"]].map(([v, t]) => h("option", { value: v, selected: v === "10" ? true : null }, t)));
    stepSel.value = "10";
    const moves = [["←", "Left", (a) => a.right.map((c) => -c)], ["→", "Right", (a) => a.right], ["↑", "Up", () => [0, 1, 0]], ["↓", "Down", () => [0, -1, 0]], ["⇡", "Away from the camera", (a) => a.fwd], ["⇣", "Toward the camera", (a) => a.fwd.map((c) => -c)]];
    const pad = h("div", { class: "hm-pe-pad", role: "group", "aria-label": `Move ${hd.label}` }, moves.map(([glyph, name, dir]) => h("button", { type: "button", class: "btn small", title: name, "aria-label": `${name}, ${stepSel.value} mm`, onclick: () => {
      const d = ctx.viewport.camera.getWorldDirection(new THREE.Vector3()), ax = viewAxes([d.x, d.y, d.z]);
      env.nudge(id, dir(ax).map((c) => c * Number(stepSel.value) / 1000));
    } }, glyph)));
    const el = h("div", { class: "hm-pe-handleinsp" }, h("p", { class: "small muted" }, handleHint(hd)), pos, h("label", { class: "hm-pe-flabel" }, "Step ", stepSel), pad,
      id === "gaze" ? h("p", { class: "small muted" }, "The look-at target is a point in space; the head and eyes turn toward it.") : null);
    return { el, update() { try { const p = editor.handlePoint(id); pos.textContent = `Position (x, y, z): ${[p.x, p.y, p.z].map((v) => ctx.fmt(v * 1000, { suffix: false })).join(", ")} ${UNIT_LABEL[ctx.units]}`; } catch { pos.textContent = ""; } }, dispose() {} };
  }
  async function jointDetails(host, jointId) {
    try {
      sk ??= await import("./skeleton.js");
      const box = h("div", {});
      host.append(h("details", { class: "hm-pe-details" }, h("summary", {}, "Joint details (read-only)"), box));
      sk.renderJointDetails(box, ctx, jointId);
    } catch { /* the details are an extra */ }
  }
  function show() {
    const sel = ctx.state.selection, key = sel ? `${sel.kind}:${sel.id}` : "none";
    if (cur?.key === key) { cur.view?.update?.(); return; }
    cur?.view?.dispose?.();
    let view = null, title = "Posture";
    if (sel?.kind === "joint" && JOINT_BY_ID[sel.id]) {
      view = jointEditor(env, sel.id, { heading: false });
      title = JOINT_BY_ID[sel.id].label;
      const wrap = h("div", { class: "hm-pe-jointinsp" }, view.el);
      jointDetails(wrap, sel.id);
      root.replaceChildren(wrap);
    } else if (sel?.kind === "handle" && HANDLES.some((x) => x.id === sel.id)) {
      view = handleView(sel.id);
      title = HANDLES.find((x) => x.id === sel.id).label;
      root.replaceChildren(view.el);
      view.update();
    } else root.replaceChildren(legend());
    cur = { key, view, title };
    ctx.inspector(root, { title });
  }
  return { el: root, show, get title() { return cur?.title ?? "Posture"; }, update() { cur?.view?.update?.(); }, dispose() { cur?.view?.dispose?.(); cur = null; } };
}

// ---- mount ------------------------------------------------------------------------------------------------------------------------------------------------------------
function themeColors() {
  const probe = h("span", { style: { position: "absolute", width: "0", height: "0", visibility: "hidden", pointerEvents: "none" } });
  document.body.append(probe);
  const get = (v, d) => { probe.style.color = ""; probe.style.color = `var(${v})`; const c = getComputedStyle(probe).color; return c && c !== "rgba(0, 0, 0, 0)" ? c : d; };
  try {
    return { hand: get("--s1", "#2a78d6"), foot: get("--s3", "#1baf7a"), pelvis: get("--s4", "#eda100"), trunk: get("--s7", "#7c5cd6"), gaze: get("--s5", "#e87ba4"), pole: get("--text-3", "#8a8983"), bad: get("--bad", "#d6342a"), outline: get("--surface", "#ffffff"), select: get("--accent", "#1c5cab") };
  } finally { probe.remove(); }
}

export default {
  id: "posture",
  label: "Posture",
  order: 2,
  async mount(container, ctx) {
    await ensurePostureStyles();
    const editor = editorFor(ctx);
    editor.refs = (editor.refs ?? 0) + 1;
    const prefs = loadPrefs();
    for (const k of ["animate", "symmetric", "pelvisMode", "trunkAssist", "handFrame", "footPoint", "pinFeet", "pinHands"]) if (prefs[k] !== undefined) { try { editor.setOption(k, prefs[k]); } catch { /* an old value */ } }
    let shown = false, disposed = false, raf = 0, dirty = false, noteTimer = 0;
    const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    const note = h("div", { class: "hm-pe-note", role: "status", "aria-live": "polite" });
    const env = {
      ctx, editor,
      rig: () => ctx.getRig(),
      angles: () => ctx.getRig()?.angles ?? {},
      angle: (id, i) => ctx.getRig()?.angles?.[id]?.[i] ?? 0,
      shown: () => shown,
      say(text, level = "info") {
        live.textContent = "";
        setTimeout(() => { live.textContent = text; }, 30);
        if (level === "error") ctx.notify(text, { level: "warn", id: "posture-error" });
      },
      notify(text) { ctx.notify(text, { level: "info", id: "posture" }); },
      savePrefs() { prefs.animate = editor.options.animate; prefs.symmetric = editor.options.symmetric; prefs.pelvisMode = editor.options.pelvisMode; prefs.trunkAssist = editor.options.trunkAssist; prefs.handFrame = editor.options.handFrame; prefs.footPoint = editor.options.footPoint; prefs.pinFeet = editor.options.pinFeet; prefs.pinHands = editor.options.pinHands; savePrefs(prefs); },
      refreshNow() { cancel(); refresh(); },
      selectJoint(id) { ctx.select({ kind: "joint", id }); },
      applyPosture(id) {
        if (!ctx.getRig()) { env.say("The figure is still being built.", "error"); return; }
        try {
          const res = editor.apply(id), p = editor.getPosture(id);
          env.say(`Showing ${p.name}. ${supportLabel(p.support)}.${res.clamped.length ? ` ${res.clamped.length} angle${res.clamped.length > 1 ? "s were" : " was"} limited to the range of motion.` : ""}`);
        } catch (e) { env.say(`That posture could not be shown (${String(e.message).slice(0, 140)}).`, "error"); }
        refresh();
      },
      nudge(id, v) {
        try {
          const st = editor.nudgeHandle(id, v);
          if (st) edit.showIkStatus({ phase: "end", status: st, handle: id });
          else env.say("The handles need the inverse kinematics module, which is still loading.", "error");
        } catch (e) { env.say(String(e.message), "error"); }
      },
      lookAt(what) {
        try {
          const p = what === "object" ? selectedObjectCentre(ctx) : measurePoint(ctx);
          if (!p) { env.say(what === "object" ? "Select an object in the Scene tab first." : "Select a measurement that has a point away from the figure first.", "error"); return; }
          const st = editor.lookAtPoint(p);
          env.say(st?.reachable ? "Looking at it." : st ? `The gaze falls ${st.short ?? "short"}: ${st.message}` : "The inverse kinematics module is still loading.");
        } catch (e) { env.say(String(e.message), "error"); }
      },
    };
    const layer = createHandleLayer({ viewport: ctx.viewport, editor, colors: themeColors(), onSelect: (id) => setTimeout(() => ctx.select({ kind: "handle", id }), 0) });
    editor.handleLayer = layer; // for tests and other panels: the handles of the 3D view
    layer.setPoles(prefs.poles !== false);
    const lib = libraryView(env), cur = currentView(env, lib), edit = editView(env, layer, prefs), insp = inspectorView(env);

    const sec = (key, title, body, extra) => { const s = section(title, body, { open: prefs.open?.[key] !== false, className: `hm-pe-sec hm-pe-sec-${key}` }); if (extra) s.querySelector("summary").prepend(extra); s.addEventListener("toggle", () => { (prefs.open = prefs.open && typeof prefs.open === "object" ? prefs.open : {})[key] = s.open; savePrefs(prefs); }); return s; };
    const waiting = emptyState("Waiting for the model.", "The figure is being built; the postures can be chosen as soon as it is on the stage.");
    const root = h("div", { class: "hm-pe", dataset: { ready: "0" } }, h("h2", { class: "hm-panel-title" }, "Posture"), note, waiting,
      sec("lib", "Library", [lib.el]), sec("cur", "Current posture", [cur.el]), sec("edit", "Edit", [edit.el]), live);
    container.replaceChildren(root);

    function refresh() {
      raf = 0;
      if (disposed) return;
      const ready = !!ctx.getRig();
      root.dataset.ready = ready ? "1" : "0";
      waiting.hidden = ready;
      if (!shown) { dirty = true; return; }
      dirty = false;
      if (!ready) return;
      try { cur.update(); edit.update(); insp.update(); lib.refresh(); } catch (e) { console.error("Posture panel:", e); }
    }
    function cancel() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(refresh); };

    const offs = [];
    const sub = (evt, fn) => offs.push(ctx.on(evt, fn));
    offs.push(editor.on("change", schedule), editor.on("external", schedule), editor.on("history", schedule), editor.on("place", schedule), editor.on("options", schedule), editor.on("animation", schedule));
    offs.push(editor.on("custom", () => { lib.refresh({ items: true }); schedule(); }));
    offs.push(editor.on("clamp", (e) => cur.showClamps(e.clamped)));
    offs.push(editor.on("drag", (e) => edit.showIkStatus(e)));
    offs.push(editor.on("look", schedule));
    offs.push(editor.on("rig", () => {
      lib.refresh({ body: true });
      const name = editor.base.name;
      note.replaceChildren(notice(`The figure was rebuilt for the new profile. The posture "${name}"${editor.modified ? " (edited)" : ""} and its placement were kept.`, { level: "info", onDismiss: () => note.replaceChildren() }));
      clearTimeout(noteTimer); noteTimer = setTimeout(() => note.replaceChildren(), 8000);
      schedule();
    }));
    sub("pose", schedule);
    sub("rig", () => { schedule(); layer.update(); });
    sub("body", () => lib.refresh({ body: true }));
    sub("scene", schedule);
    sub("units", () => { cur.units(); insp.show(); schedule(); });
    sub("theme", () => { layer.setColors(themeColors()); lib.redraw(); });
    sub("selection", (sel) => {
      layer.setSelected(sel?.kind === "handle" ? sel.id : null);
      if (sel?.kind === "joint" && shown) edit.showJoint(sel.id);
      insp.show();
      edit.update();
    });
    const onKey = (e) => {
      if (!shown || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { if (editor.undo()) env.say("Undone."); e.preventDefault(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { if (editor.redo()) env.say("Redone."); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey);
    editor.loadIk().then(() => { if (!disposed) { edit.update(); layer.update(); schedule(); if (shown && typeof requestIdleCallback === "function") requestIdleCallback(() => { try { if (!disposed) editor.warmUp(); } catch { /* the warm-up is an extra */ } }, { timeout: 2000 }); } });

    // the Skeleton tab's inspector shows the same sliders for the selected joint
    let skeletonMod = null;
    import("./skeleton.js").then((m) => {
      if (disposed) return;
      skeletonMod = m;
      m.setJointDetailsRenderer((host, _ctx, jointId) => {
        const view = jointEditor(env, jointId, { heading: false }), box = h("div", {});
        host.replaceChildren(view.el, h("details", { class: "hm-pe-details" }, h("summary", {}, "Joint details (read-only)"), box));
        try { m.renderJointDetails(box, ctx, jointId); } catch { /* an extra */ }
        return { update() { view.update(); }, dispose() { view.dispose(); } };
      });
    }, () => {});

    insp.show();
    refresh();
    return {
      onShow() {
        shown = true;
        layer.setEnabled(prefs.ik !== false);
        ctx.inspector(insp.el, { title: insp.title });
        insp.show();
        lib.refresh({ body: true });
        refresh();
        lib.revealBase();
        const sel = ctx.state.selection;
        if (sel?.kind === "joint") edit.showJoint(sel.id);
      },
      onHide() {
        shown = false;
        layer.cancel();
        layer.setEnabled(false);
        editor.endGesture();
      },
      dispose() {
        disposed = true;
        cancel();
        clearTimeout(noteTimer);
        for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
        document.removeEventListener("keydown", onKey);
        try { skeletonMod?.setJointDetailsRenderer(null); } catch { /* gone */ }
        try { ctx.inspector(null); } catch { /* the shell is gone */ }
        layer.dispose();
        if (editor.handleLayer === layer) delete editor.handleLayer;
        lib.dispose(); cur.dispose(); edit.dispose(); insp.dispose();
        if (--editor.refs <= 0) editor.dispose();
      },
    };
  },
};

/** The centre of the object selected in the scene, in world coordinates, or null. */
function selectedObjectCentre(ctx) {
  const sel = ctx.state.selection, sb = ctx.state.sandbox ?? ctx.sandbox, id = sel?.kind === "object" ? sel.id : sb?.selected;
  const o = id && sb?.objects?.get?.(id);
  if (!o) return null;
  const c = o.bbox?.getCenter ? o.bbox.getCenter(new (o.bbox.min.constructor)()) : null;
  const p = c ? sb.localToWorld(id, c.toArray()) : sb.localToWorld(id, [0, 0, 0]);
  return p ? [p.x, p.y, p.z] : null;
}
/** The first point of the selected (or the last) measurement that is not on the figure, or null. */
function measurePoint(ctx) {
  const m = ctx.state.measure ?? ctx.measure;
  if (!m?.items?.length) return null;
  const item = m.items.find((i) => i.id === m.selected) ?? m.items[m.items.length - 1];
  for (const key of ["a", "b", "c"]) {
    const ref = item[key];
    if (!ref || ref.kind === "joint" || ref.kind === "landmark") continue;
    const r = m.resolve(ref);
    if (r?.ok) return [r.p.x, r.p.y, r.p.z];
  }
  return null;
}
