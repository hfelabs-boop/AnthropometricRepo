// Scene panel of the Digital human tab: the sandbox. Browse a catalogue of objects (chairs, displays, boxes, structures, tools, reference objects),
// add them, place and edit them (drag in the 3D view, gizmo, numeric fields, arrow keys), save / open scenes, start from a template.
// The logic lives in sandbox.js (scene manager) and catalog.js (objects); this file is the DOM. Styles: site/human-scene.css (prefix hm-sc- / hm-obj- / hm-ol- / hm-ed-).
//
// Layout. Left column: catalogue, templates, the object list, "Place the human" (a container another module fills, sandbox.placeContainer, id
// hm-place-human), snapping and gizmo settings, scene file. The settings of the SELECTED object (name, position, colour, parameters, attach) are one
// element that lives in the shell's inspector while that is on screen next to the 3D view (wide layout, inspector open) and otherwise inside this
// panel under the object list (createDock below; the Measure panel uses the same helper for its own details).
import * as THREE from "three";
import { h, download, toast } from "../../util.js";
import { sliderRow, section, segmented, chipButton, emptyState, notice, nextId, toUnit, fromUnit, unitDigits, UNIT_LABEL, roving } from "../ui.js";
import { CATALOG, CATEGORIES, byType, SWATCHES, buildObject, disposeObject } from "../catalog.js";
import { acquireSandbox, releaseSandbox, TEMPLATES, GRID_STEPS_MM, ANGLE_STEPS, MAX_OBJECTS, MAX_TEXT } from "../sandbox.js";
import { acquireMeasure, releaseMeasure } from "../measure.js";
import { mountPlace } from "../place.js";

const CSS_URL = new URL("../../../human-scene.css", import.meta.url).href;

// ---------------------------------------------------------------------------------------------------------------------
// shared helpers (also used by panels/measure.js)
/** Inject site/human-scene.css once and wait (briefly) for it. Resolves whether or not it loaded: the panel still works, only plainer. */
export function ensureSceneStyles() {
  let link = document.querySelector("link[data-hm-scene-css]");
  if (link?.dataset.hmFailed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-scene-css": "" });
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

const ICONS = {
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z", unlock: "M7 11V8a5 5 0 0 1 9.6-2M6 11h12v9H6z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off": "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.7C3.6 8.6 2 12 2 12s4 7 10 7c1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1", trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3", redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  plus: "M12 5v14M5 12h14", search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5", frame: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14", upload: "M12 16V4M7 9l5-5 5 5M5 20h14", close: "M6 6l12 12M18 6L6 18",
  ruler: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2", target: "M12 3v5M12 16v5M3 12h5M16 12h5", cube: "M12 3l8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10",
};
/** A decorative inline SVG icon (the button around it carries the accessible name). */
export function svgIcon(name, size = 16) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  p.setAttribute("d", ICONS[name] ?? ICONS.cube);
  svg.append(p);
  svg.classList.add("hm-icon");
  return svg;
}
/** A square icon button. `pressed` makes it a toggle (aria-pressed). */
export function iconButton({ icon, label, title, onClick, pressed, className = "" }) {
  const b = h("button", { type: "button", class: `hm-ib ${className}`.trim(), title: title ?? label, "aria-label": label }, svgIcon(icon, 15));
  if (pressed !== undefined) b.setAttribute("aria-pressed", pressed ? "true" : "false");
  if (onClick) b.addEventListener("click", (e) => onClick(e, b));
  return b;
}
/** Copy text to the clipboard (async API, then the old selection trick). Resolves true when it worked. */
export async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = h("textarea", { "aria-hidden": "true", tabindex: "-1", style: { position: "fixed", left: "-9999px", top: "0", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.("copy") === true;
    ta.remove();
    return ok;
  } catch { return false; }
}
/**
 * The settings element of a panel sits in the shell's inspector while that is beside the 3D view (wide layout, inspector open), else in `slot` inside the
 * panel. place(force) re-evaluates it (cheap when nothing changed); onPlace(inInspector) lets the panel hide its own section for the slot.
 */
export function createDock({ ctx, host, node, slot, getTitle, note, onPlace }) {
  const app = host.closest?.(".hm-app") ?? null, mq = matchMedia("(min-width: 1260px)");
  const summary = h("p", { class: "small muted" }, note);
  let disposed = false, last = "";
  const wide = () => mq.matches && app?.dataset.inspector !== "closed";
  function place(force = false) {
    if (disposed) return;
    const inInspector = wide(), title = inInspector ? getTitle() : "";
    const sig = `${inInspector}|${title}`;
    if (!force && sig === last) return;
    last = sig;
    if (inInspector) { slot.hidden = true; ctx.inspector(node, { title }); } else {
      if (node.parentNode !== slot) slot.append(node);
      slot.hidden = false;
      ctx.inspector(summary, { title: "Inspector" });
    }
    onPlace?.(inInspector);
  }
  const again = () => place(true);
  mq.addEventListener?.("change", again);
  const mo = app && typeof MutationObserver !== "undefined" ? new MutationObserver(again) : null;
  mo?.observe(app, { attributes: true, attributeFilter: ["data-inspector"] });
  return { place, dispose() { disposed = true; mq.removeEventListener?.("change", again); mo?.disconnect(); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// thumbnails: one small offscreen WebGL renderer, used lazily, once per type, and released a few seconds after the last request
const THUMB_PX = 96;
const thumbCache = new Map(); // type -> data URL ("" = could not be drawn)
let thumbGL = null, thumbQueue = [], thumbTimer = 0, thumbIdle = 0;
function thumbRenderer() {
  if (thumbGL) return thumbGL;
  if (thumbGL === false) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = THUMB_PX;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(THUMB_PX, THUMB_PX, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping; renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
    const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(2.5, 5, 3.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55); fill.position.set(-3, 2.5, -3.5);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 1.1), key, fill);
    thumbGL = { renderer, scene, camera };
    return thumbGL;
  } catch { thumbGL = false; return null; }
}
function releaseThumbRenderer() {
  if (!thumbGL) return;
  try { thumbGL.renderer.dispose(); thumbGL.renderer.forceContextLoss(); } catch { /* already gone */ }
  thumbGL = null;
}
function drawThumb(type) {
  const gl = thumbRenderer();
  if (!gl) return "";
  const g = buildObject(type, {});
  try {
    gl.scene.add(g);
    const sph = g.userData.bbox.getBoundingSphere(new THREE.Sphere()), r = Math.max(sph.radius, 0.05), dist = (r / Math.sin(THREE.MathUtils.degToRad(15))) * 1.04;
    const az = THREE.MathUtils.degToRad(35), el = THREE.MathUtils.degToRad(22);
    gl.camera.position.set(sph.center.x + dist * Math.sin(az) * Math.cos(el), sph.center.y + dist * Math.sin(el), sph.center.z + dist * Math.cos(az) * Math.cos(el));
    gl.camera.lookAt(sph.center); gl.camera.updateMatrixWorld();
    gl.renderer.render(gl.scene, gl.camera);
    return gl.renderer.domElement.toDataURL("image/png");
  } catch { return ""; } finally { gl.scene.remove(g); disposeObject(g); }
}
/** Ask for thumbnails of `types`; cb(type, url) is called for each (also for cached ones, asynchronously). One thumbnail per tick keeps the page responsive. */
function requestThumbs(types, cb) {
  for (const t of types) { if (thumbCache.has(t)) cb(t, thumbCache.get(t)); else thumbQueue.push([t, cb]); }
  if (!thumbTimer && thumbQueue.length) thumbTimer = setTimeout(pump, 20);
}
function pump() {
  thumbTimer = 0;
  const next = thumbQueue.shift();
  if (next) {
    const [type, cb] = next;
    if (!thumbCache.has(type)) thumbCache.set(type, drawThumb(type));
    cb(type, thumbCache.get(type));
  }
  if (thumbQueue.length) thumbTimer = setTimeout(pump, 16);
  else { clearTimeout(thumbIdle); thumbIdle = setTimeout(releaseThumbRenderer, 4000); }
}
function dropThumbRequests(owner) { thumbQueue = thumbQueue.filter(([, cb]) => cb.owner !== owner); }

// ---------------------------------------------------------------------------------------------------------------------
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const haystack = (t) => `${t.name} ${t.type.replace(/_/g, " ")} ${t.category} ${t.tags.join(" ")} ${t.description}`.toLowerCase();
const matches = (t, q) => words(q).every((w) => haystack(t).includes(w));
const isLength = (ps) => ps.unit === "m";
/** Landmarks and joints one can attach an object to, "common" ones first. */
const COMMON_ATTACH = [
  ["landmark", "palm_centre_L", "Left palm"], ["landmark", "palm_centre_R", "Right palm"], ["landmark", "grip_centre_L", "Left grip centre"], ["landmark", "grip_centre_R", "Right grip centre"],
  ["joint", "wrist_L", "Left wrist"], ["joint", "wrist_R", "Right wrist"], ["joint", "elbow_L", "Left elbow"], ["joint", "elbow_R", "Right elbow"],
  ["landmark", "vertex", "Top of the head"], ["landmark", "eye_mid", "Midpoint between the eyes"], ["landmark", "suprasternale", "Suprasternale (notch of the breastbone)"], ["joint", "pelvis", "Pelvis"],
  ["landmark", "ball_sole_medial_L", "Left ball of the foot"], ["landmark", "ball_sole_medial_R", "Right ball of the foot"],
];

export default {
  id: "scene",
  label: "Scene",
  order: 3,
  async mount(host, ctx) {
    await ensureSceneStyles();
    const sandbox = acquireSandbox(ctx);
    acquireMeasure(ctx); // registers the measurements section of the scene file even if the Measure tab is never opened
    const offs = [], owner = {};
    const on = (evt, fn) => offs.push(ctx.on(evt, fn));
    const id = { search: nextId("hm-sc-q"), tpl: nextId("hm-sc-tpl"), grid: nextId("hm-sc-grid"), angle: nextId("hm-sc-angle") };
    const state = { cat: CATEGORIES[0].name, q: "", pick: CATEGORIES[0].types[0], units: ctx.units, editor: null };
    const say = (t) => { live.textContent = ""; setTimeout(() => { live.textContent = t; }, 30); };
    const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });

    // ---- the catalogue ------------------------------------------------------------------------------------------
    const search = h("input", { type: "search", class: "input", id: id.search, placeholder: "Search: seat, display, ladder…", "aria-label": "Search objects", autocomplete: "off", oninput: () => { state.q = search.value.trim(); renderCatalog(); } });
    const catBtns = new Map(CATEGORIES.map((c) => [c.name, chipButton({ label: c.name, toggle: true, pressed: c.name === state.cat, title: `${c.types.length} objects`, onClick: () => { state.cat = c.name; search.value = ""; state.q = ""; renderCatalog(); } })]));
    const catBar = h("div", { class: "hm-obj-cats", role: "group", "aria-label": "Object categories" }, [...catBtns.values()]);
    const grid = h("div", { class: "hm-obj-grid", role: "group", "aria-label": "Object types" });
    const gridRoving = roving(grid, { selector: "button", orientation: "both" });
    const detail = h("div", { class: "hm-obj-detail" });
    const thumbs = new Map(); // type -> <img> / placeholder of the cards on screen

    function card(t) {
      const thumb = h("span", { class: "hm-obj-thumb", "aria-hidden": "true" }, svgIcon("cube", 22));
      thumbs.set(t.type, thumb);
      return h("button", {
        type: "button", class: "hm-obj-card", dataset: { type: t.type }, "aria-pressed": t.type === state.pick ? "true" : "false", title: `${t.name}: ${t.description}`,
        onclick: () => choose(t.type), ondblclick: () => addType(t.type),
        onkeydown: (e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); addType(t.type); } }, // Enter adds, Space chooses
      }, thumb, h("span", { class: "hm-obj-name" }, t.name));
    }
    function renderCatalog() {
      const list = state.q ? CATALOG.filter((t) => matches(t, state.q)) : CATALOG.filter((t) => t.category === state.cat);
      for (const [name, b] of catBtns) b.setPressed(!state.q && name === state.cat);
      thumbs.clear();
      dropThumbRequests(owner);
      grid.replaceChildren(...(list.length ? list.map(card) : [h("p", { class: "hm-empty small" }, `No object matches “${state.q}”.`)]));
      if (list.length && !list.some((t) => t.type === state.pick)) state.pick = list[0].type;
      renderDetail();
      for (const b of grid.querySelectorAll(".hm-obj-card")) b.setAttribute("aria-pressed", b.dataset.type === state.pick ? "true" : "false");
      gridRoving.refresh();
      const cb = (type, url) => { const el = thumbs.get(type); if (!el || !url) return; el.replaceChildren(h("img", { src: url, alt: "", width: 44, height: 44, draggable: "false" })); };
      cb.owner = owner;
      requestThumbs(list.map((t) => t.type), cb);
    }
    function choose(type) {
      state.pick = type;
      for (const b of grid.querySelectorAll(".hm-obj-card")) b.setAttribute("aria-pressed", b.dataset.type === type ? "true" : "false");
      renderDetail();
    }
    let addBtn = null;
    function renderDetail() {
      const t = byType(state.pick);
      if (!t) { detail.replaceChildren(); addBtn = null; return; }
      addBtn = h("button", { type: "button", class: "btn primary", onclick: () => addType(t.type) }, svgIcon("plus", 15), `Add ${t.name}`);
      detail.replaceChildren(
        h("div", { class: "hm-obj-detail-head" }, h("h3", {}, t.name), h("span", { class: "tag outline" }, t.category)),
        h("p", { class: "small" }, t.description),
        t.source ? h("p", { class: "small muted" }, `Source: ${t.source}`) : null, addBtn);
      updateAddState();
    }
    /** The Add button is not rebuilt when the scene changes (a keyboard user would lose the focus), only enabled or disabled. */
    function updateAddState() {
      if (!addBtn) return;
      const t = byType(state.pick), full = sandbox.objects.size >= MAX_OBJECTS;
      addBtn.disabled = full;
      addBtn.title = full ? `The scene is limited to ${MAX_OBJECTS} objects.` : `Add ${t.name} in front of the figure (double-click a card or press Enter)`;
    }
    function addType(type) {
      const o = sandbox.add(type, { select: true });
      if (!o) { say(`The scene is limited to ${MAX_OBJECTS} objects.`); return; }
      say(`${o.name} added.`);
      // bring the view along only when the new object is out of sight
      const c = new THREE.Vector3((o.bbox.min.x + o.bbox.max.x) / 2, (o.bbox.min.y + o.bbox.max.y) / 2, (o.bbox.min.z + o.bbox.max.z) / 2);
      const p = ctx.viewport.project?.(sandbox.localToWorld(o.id, c.toArray(), c));
      if (p && !p.visible) sandbox.frameObjects(null);
    }

    // ---- templates -----------------------------------------------------------------------------------------------------
    const tplSelect = h("select", { class: "input", id: id.tpl, "aria-label": "Template" }, TEMPLATES.map((t) => h("option", { value: t.id }, t.name)));
    const tplNote = h("p", { class: "small muted" });
    const showTpl = () => { tplNote.textContent = TEMPLATES.find((t) => t.id === tplSelect.value)?.description ?? ""; };
    tplSelect.addEventListener("change", showTpl);
    showTpl();
    const applyTpl = (merge) => {
      const t = TEMPLATES.find((x) => x.id === tplSelect.value);
      if (!t || !sandbox.applyTemplate(t.id, { merge })) return;
      sandbox.frameObjects?.(null);
      say(`${merge ? "Added" : "Loaded"} the template ${t.name}.`);
      toast(`${t.name}: ${merge ? "added to" : "loaded as"} the scene. Undo with Ctrl+Z.`);
    };
    const tplBody = h("div", { class: "hm-sc-stack" },
      h("div", { class: "field" }, h("label", { for: id.tpl }, "Start from a template"), tplSelect), tplNote,
      h("div", { class: "hm-sc-row" }, h("button", { type: "button", class: "btn", onclick: () => applyTpl(false), title: "Replace the scene with the template (undoable)" }, "Replace the scene"), h("button", { type: "button", class: "btn", onclick: () => applyTpl(true), title: "Add the template's objects to the scene" }, "Add to the scene")));

    // ---- the object list ---------------------------------------------------------------------------------------------------
    // Rows are created once per object and updated in place, so the button that was just pressed (lock, hide) keeps the keyboard focus.
    const list = h("ul", { class: "hm-ol", "aria-label": "Objects in the scene" });
    const listCount = h("span", { class: "tag outline" }, "0");
    const listEmpty = emptyState("No objects yet.", "Add one from the catalogue above, or start from a template.");
    const rowEls = new Map();
    let pendingFocus = null; // after a delete: the row index whose neighbour should get the focus
    const setBtn = (b, { icon, label, title, pressed }) => {
      if (b.dataset.icon !== icon) { b.replaceChildren(svgIcon(icon, 15)); b.dataset.icon = icon; }
      b.setAttribute("aria-label", label); b.title = title; b.setAttribute("aria-pressed", pressed ? "true" : "false");
    };
    function makeRow(oid) {
      const nameEl = h("span", { class: "hm-ol-name" }), typeEl = h("span", { class: "hm-ol-type" });
      const main = h("button", { type: "button", class: "hm-ol-main", onclick: () => sandbox.select(oid) }, nameEl, typeEl);
      const cur = () => sandbox.objects.get(oid);
      const lockB = h("button", { type: "button", class: "hm-ib", onclick: () => { const o = cur(); if (o) sandbox.setLocked(oid, !o.locked); } });
      const eyeB = h("button", { type: "button", class: "hm-ib", onclick: () => { const o = cur(); if (o) sandbox.setVisible(oid, !o.visible); } });
      const dupB = iconButton({ icon: "copy", label: "Duplicate", onClick: () => { const c = sandbox.duplicate(oid, { select: true }); if (c) say(`${c.name} added.`); } });
      const delB = iconButton({ icon: "trash", label: "Delete", title: "Delete it (undo with Ctrl+Z)", onClick: () => {
        const o = cur(), at = [...list.children].indexOf(li);
        if (o && sandbox.remove(oid)) { pendingFocus = at; say(`${o.name} deleted.`); }
      } });
      const li = h("li", { class: "hm-ol-row", dataset: { id: oid } }, main, lockB, eyeB, dupB, delB);
      li.addEventListener("pointerenter", () => sandbox.hover(oid));
      li.addEventListener("pointerleave", () => sandbox.hover(null));
      return { li, main, nameEl, typeEl, lockB, eyeB, dupB, delB };
    }
    function syncRow(r, o, sel) {
      const t = byType(o.type);
      r.nameEl.textContent = o.name;
      r.typeEl.textContent = `${t.name}${o.attachedTo ? ` · on ${o.attachedTo.id.replace(/_/g, " ")}` : ""}`;
      r.li.dataset.locked = o.locked ? "1" : ""; r.li.dataset.hidden = o.visible ? "" : "1";
      if (sel) r.li.setAttribute("aria-current", "true"); else r.li.removeAttribute("aria-current");
      r.main.setAttribute("aria-pressed", sel ? "true" : "false"); r.main.title = `Select ${o.name}`;
      setBtn(r.lockB, { icon: o.locked ? "lock" : "unlock", label: `${o.locked ? "Unlock" : "Lock"} ${o.name}`, title: o.locked ? "Locked: it cannot be moved. Press to unlock" : "Lock it in place", pressed: o.locked });
      setBtn(r.eyeB, { icon: o.visible ? "eye" : "eye-off", label: `${o.visible ? "Hide" : "Show"} ${o.name}`, title: o.visible ? "Hide it" : "Hidden. Press to show it", pressed: !o.visible });
      r.dupB.setAttribute("aria-label", `Duplicate ${o.name}`); r.delB.setAttribute("aria-label", `Delete ${o.name}`);
    }
    function renderList() {
      const sel = sandbox.selected, seen = new Set();
      let want = list.firstChild;
      for (const o of sandbox.objects.values()) {
        let r = rowEls.get(o.id);
        if (!r) { r = makeRow(o.id); rowEls.set(o.id, r); }
        syncRow(r, o, o.id === sel);
        if (r.li !== want) list.insertBefore(r.li, want); // only when the order really changed (moving a node would drop its focus)
        else want = want.nextSibling;
        seen.add(o.id);
      }
      for (const [oid, r] of rowEls) if (!seen.has(oid)) { r.li.remove(); rowEls.delete(oid); }
      listCount.textContent = String(rowEls.size);
      listEmpty.hidden = rowEls.size > 0;
      updateAddState();
      if (pendingFocus != null) {
        const rows = [...list.children], next = rows[Math.min(pendingFocus, rows.length - 1)];
        (next?.querySelector(".hm-ol-main") ?? search).focus();
        pendingFocus = null;
      }
    }

    // ---- undo / redo ---------------------------------------------------------------------------------------------------------
    const undoBtn = h("button", { type: "button", class: "btn small", onclick: () => { const l = sandbox.undoLabel; if (sandbox.undo()) say(`Undid: ${l}.`); } }, svgIcon("undo", 14), "Undo");
    const redoBtn = h("button", { type: "button", class: "btn small", onclick: () => { const l = sandbox.redoLabel; if (sandbox.redo()) say(`Redid: ${l}.`); } }, svgIcon("redo", 14), "Redo");
    function updateHistory() {
      undoBtn.disabled = !sandbox.canUndo; redoBtn.disabled = !sandbox.canRedo;
      undoBtn.title = sandbox.canUndo ? `Undo: ${sandbox.undoLabel} (Ctrl+Z)` : "Nothing to undo";
      redoBtn.title = sandbox.canRedo ? `Redo: ${sandbox.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo";
    }

    // ---- the settings of the selected object ----------------------------------------------------------------------------------------------
    const editorEl = h("div", { class: "hm-ed" });
    const editorSlot = h("div", { class: "hm-sc-slot" });

    const attachOptions = () => {
      const rig = ctx.getRig();
      const groups = [h("option", { value: "" }, "Not attached")];
      if (!rig) return groups;
      const lms = new Set(rig.landmarkIds ?? []), joints = rig.bones;
      const common = COMMON_ATTACH.filter(([k, i]) => (k === "landmark" ? lms.has(i) : joints?.has?.(i)));
      groups.push(h("optgroup", { label: "Common" }, common.map(([k, i, label]) => h("option", { value: `${k}:${i}` }, label))));
      groups.push(h("optgroup", { label: "All landmarks" }, [...lms].map((i) => h("option", { value: `landmark:${i}` }, rig.body?.landmarks?.[i]?.label ?? i))));
      groups.push(h("optgroup", { label: "All joints" }, [...(joints?.keys?.() ?? [])].map((i) => h("option", { value: `joint:${i}` }, i.replace(/_/g, " ")))));
      return groups;
    };

    function buildEditor(obj) {
      const spec = byType(obj.type), u = ctx.units, dg = unitDigits(u) + 1;
      const lenStep = u === "mm" ? 10 : u === "cm" ? 0.5 : 0.25;
      const posInputs = [];
      const posField = (axisKey, axisLabel, idx) => {
        const input = h("input", { type: "number", class: "input hm-num", id: nextId("hm-ed-pos"), step: lenStep, "aria-label": `${axisLabel} position in ${UNIT_LABEL[u]}`, inputmode: "decimal" });
        const show = (o) => { if (document.activeElement !== input) input.value = String(Number(toUnit(o.position[idx] * 1000, u).toFixed(dg))); };
        input.addEventListener("change", () => {
          const o = sandbox.objects.get(obj.id), v = Number(input.value);
          if (!o || input.value === "" || !Number.isFinite(v)) { show(o ?? obj); return; }
          sandbox.move(obj.id, { [axisKey]: fromUnit(v, u) / 1000 }, { snap: false });
          input.value = String(Number(toUnit(sandbox.objects.get(obj.id).position[idx] * 1000, u).toFixed(dg)));
        });
        posInputs.push(input);
        return { el: h("div", { class: "hm-ed-f" }, h("label", { for: input.id }, axisLabel), input), show };
      };
      const fx = posField("x", "X", 0), fy = posField("y", "Y (up)", 1), fz = posField("z", "Z", 2);
      const yaw = h("input", { type: "number", class: "input hm-num", id: nextId("hm-ed-yaw"), step: 5, "aria-label": "Yaw in degrees", inputmode: "decimal" });
      const showYaw = (o) => { if (document.activeElement !== yaw) yaw.value = String(Number(o.yaw.toFixed(2))); };
      yaw.addEventListener("change", () => { const v = Number(yaw.value); if (yaw.value === "" || !Number.isFinite(v)) { showYaw(sandbox.objects.get(obj.id) ?? obj); return; } sandbox.rotate(obj.id, v, { snap: false }); yaw.value = String(Number(sandbox.objects.get(obj.id).yaw.toFixed(2))); });

      const name = h("input", { type: "text", class: "input", id: nextId("hm-ed-name"), maxlength: 60, "aria-label": "Name", value: obj.name });
      name.addEventListener("change", () => { if (!sandbox.rename(obj.id, name.value)) name.value = sandbox.objects.get(obj.id)?.name ?? obj.name; });
      const locked = h("input", { type: "checkbox", id: nextId("hm-ed-lock") });
      locked.addEventListener("change", () => sandbox.setLocked(obj.id, locked.checked));
      const visible = h("input", { type: "checkbox", id: nextId("hm-ed-vis") });
      visible.addEventListener("change", () => sandbox.setVisible(obj.id, visible.checked));

      // colour
      const swatches = SWATCHES.map((s) => h("button", { type: "button", role: "radio", class: "hm-swatch", "aria-checked": "false", "aria-label": s.name, title: s.name, dataset: { hex: s.hex }, style: { background: s.hex }, onclick: () => sandbox.update(obj.id, { color: s.hex }, { label: "Change colour" }) }));
      const reset = h("button", { type: "button", role: "radio", class: "hm-swatch hm-swatch-default", "aria-checked": "false", "aria-label": "Default colour", title: "Default colour", style: { background: spec.defaultColor }, onclick: () => sandbox.update(obj.id, { color: null }, { label: "Reset colour" }) });
      const custom = h("input", { type: "color", class: "hm-swatch-custom", "aria-label": "Custom colour", title: "Custom colour", value: obj.color ?? spec.defaultColor });
      custom.addEventListener("change", () => sandbox.update(obj.id, { color: custom.value }, { label: "Change colour" }));
      const swatchBar = h("div", { class: "hm-swatches", role: "radiogroup", "aria-label": "Colour" }, reset, swatches, custom);
      roving(swatchBar, { selector: '[role="radio"]', orientation: "both" });
      const showColor = (o) => {
        const cur = (o.color ?? "").toLowerCase();
        reset.setAttribute("aria-checked", o.color ? "false" : "true");
        for (const b of swatches) b.setAttribute("aria-checked", b.dataset.hex.toLowerCase() === cur ? "true" : "false");
        if (document.activeElement !== custom) custom.value = o.color ?? spec.defaultColor;
      };

      // parameters
      const paramEls = [], syncs = [];
      for (const ps of spec.params) {
        if (ps.kind === "number") {
          const len = isLength(ps), conv = len ? { to: (v) => toUnit(v * 1000, u), from: (d) => fromUnit(d, u) / 1000 } : { to: (v) => v, from: (d) => d };
          const step = len ? (u === "mm" ? Math.max(1, ps.step * 1000) : u === "cm" ? Math.max(0.1, ps.step * 100) : Math.max(0.05, Math.round(ps.step * 39.37 * 20) / 20)) : ps.step;
          const row = sliderRow({
            label: ps.label, min: conv.to(ps.min), max: conv.to(ps.max), step, value: conv.to(obj.params[ps.key]), unit: len ? UNIT_LABEL[u] : ps.unit === "deg" ? "°" : ps.unit,
            digits: len ? unitDigits(u) : ps.digits ?? (ps.integer ? 0 : undefined),
            onInput: (d) => { sandbox.setParam(obj.id, ps.key, conv.from(d)); },
          });
          paramEls.push(row.el);
          syncs.push((o) => { if (document.activeElement !== row.input && document.activeElement !== row.number) row.set(conv.to(o.params[ps.key])); });
        } else if (ps.kind === "bool") {
          const cb = h("input", { type: "checkbox", id: nextId("hm-ed-p") });
          cb.addEventListener("change", () => sandbox.setParam(obj.id, ps.key, cb.checked));
          paramEls.push(h("label", { class: "check hm-ed-check", for: cb.id }, cb, h("span", { class: "lbl" }, ps.label)));
          syncs.push((o) => { cb.checked = !!o.params[ps.key]; });
        } else {
          const sel = h("select", { class: "input", id: nextId("hm-ed-p") }, ps.options.map((o) => h("option", { value: o.value }, o.label)));
          sel.addEventListener("change", () => sandbox.setParam(obj.id, ps.key, sel.value));
          paramEls.push(h("div", { class: "field" }, h("label", { for: sel.id }, ps.label), sel));
          syncs.push((o) => { sel.value = o.params[ps.key]; });
        }
      }

      // attach
      const attachSel = h("select", { class: "input", id: nextId("hm-ed-att"), "aria-label": "Attach to the figure" }, attachOptions());
      const follow = h("input", { type: "checkbox", id: nextId("hm-ed-fol") });
      const attachNote = h("p", { class: "small muted" });
      const doAttach = () => {
        const v = attachSel.value;
        if (!v) { sandbox.detach(obj.id); return; }
        const [kind, ...rest] = v.split(":");
        sandbox.attach(obj.id, { kind, id: rest.join(":") }, [0, 0, 0], { local: follow.checked, orient: follow.checked });
      };
      attachSel.addEventListener("change", doAttach);
      follow.addEventListener("change", () => { if (attachSel.value) doAttach(); });
      const showAttach = (o) => {
        const v = o.attachedTo ? `${o.attachedTo.kind}:${o.attachedTo.id}` : "";
        if (![...attachSel.options].some((x) => x.value === v) && v) attachSel.append(h("option", { value: v }, v.replace(/_/g, " ")));
        attachSel.value = v;
        follow.checked = !!o.attachedTo?.orient;
        follow.disabled = !o.attachedTo;
        attachNote.textContent = o.attachError ?? (o.attachedTo ? "It follows that point when the pose changes. The position fields move it relative to that point." : "Make the object follow a hand or another body point, for example a tool in the hand.");
      };

      const btn = (icon, label, fn, title) => h("button", { type: "button", class: "btn small", title, onclick: fn }, svgIcon(icon, 14), label);
      const dropB = btn("download", "Drop to floor", () => { sandbox.dropToFloor(obj.id); }, "Lower it until it touches the floor");
      const restB = btn("download", "Rest on a surface", () => { sandbox.dropToSurface(obj.id); }, "Lower it onto the highest surface below it (a desk, a pallet, a shelf) or the floor");
      const showB = h("button", { type: "button", class: "btn small", title: "Fit this object in the 3D view", onclick: () => sandbox.frameObjects(obj.id) }, svgIcon("frame", 14), "Show in view");
      const dupB = h("button", { type: "button", class: "btn small", onclick: () => sandbox.duplicate(obj.id, { select: true }) }, svgIcon("copy", 14), "Duplicate");
      const delB = h("button", { type: "button", class: "btn small", onclick: () => sandbox.remove(obj.id) }, svgIcon("trash", 14), "Delete");

      const anchors = Object.values(spec.anchors(obj.params)).map((a) => a.label), grips = spec.grips(obj.params), sup = spec.supports(obj.params);
      const el = h("div", { class: "hm-ed-body" },
        h("div", { class: "field" }, h("label", { for: name.id }, "Name"), name),
        h("p", { class: "small muted hm-ed-type" }, `${spec.name} · ${spec.category}`),
        h("div", { class: "hm-ed-checks" }, h("label", { class: "check", for: locked.id }, locked, h("span", { class: "lbl" }, "Locked")), h("label", { class: "check", for: visible.id }, visible, h("span", { class: "lbl" }, "Visible"))),
        h("fieldset", { class: "hm-ed-set" }, h("legend", {}, `Position (${UNIT_LABEL[u]}) and heading`), h("div", { class: "hm-ed-xyz" }, fx.el, fy.el, fz.el, h("div", { class: "hm-ed-f" }, h("label", { for: yaw.id }, "Yaw (°)"), yaw)),
          h("div", { class: "hm-sc-row" }, dropB, restB)),
        h("div", { class: "hm-ed-set" }, h("div", { class: "hm-ed-h" }, "Colour"), swatchBar),
        h("div", { class: "hm-ed-set" }, h("div", { class: "hm-ed-h" }, "Size and settings"), ...paramEls),
        h("div", { class: "hm-ed-set" }, h("div", { class: "hm-ed-h" }, h("label", { for: attachSel.id }, "Attach to the figure")), attachSel,
          h("label", { class: "check", for: follow.id }, follow, h("span", { class: "lbl" }, "Turn with the body part")), attachNote),
        h("div", { class: "hm-sc-row" }, showB, dupB, delB),
        h("details", { class: "hm-ed-about" }, h("summary", {}, "About this object"), h("p", { class: "small" }, spec.description), spec.source ? h("p", { class: "small muted" }, `Source: ${spec.source}`) : null,
          h("p", { class: "small muted" }, `Anchors you can measure from: ${anchors.join("; ")}.`),
          h("p", { class: "small muted" }, `${grips.length ? `Grips for hands: ${grips.map((g) => g.label).join("; ")}. ` : ""}${sup.length ? `Surfaces a body can rest on: ${sup.map((s) => s.label).join("; ")}.` : "No supporting surface."}`)));
      const sync = (o) => {
        fx.show(o); fy.show(o); fz.show(o); showYaw(o);
        if (document.activeElement !== name) name.value = o.name;
        locked.checked = o.locked; visible.checked = o.visible;
        // a locked object does not move; an attached one moves with its body point (the fields then change the offset, so only the drop buttons are off)
        for (const c of [...posInputs, yaw]) c.disabled = o.locked;
        for (const c of [dropB, restB]) c.disabled = o.locked || !!o.attachedTo;
        for (const f of syncs) f(o);
        showColor(o); showAttach(o);
      };
      return { id: obj.id, units: u, type: obj.type, el, sync };
    }

    const emptyEditor = () => emptyState("Nothing selected.", "Click an object in the 3D view or in the list. Drag it on the floor, hold Shift to lift it, use the arrow keys to nudge it.");
    function renderEditor() {
      const obj = sandbox.objects.get(sandbox.selected);
      if (!obj) {
        if (state.editor || !editorEl.firstChild) { state.editor = null; editorEl.replaceChildren(emptyEditor()); }
        dock.place();
        return;
      }
      if (!state.editor || state.editor.id !== obj.id || state.editor.units !== ctx.units || state.editor.type !== obj.type) { state.editor = buildEditor(obj); editorEl.replaceChildren(state.editor.el); }
      state.editor.sync(obj);
      dock.place();
    }
    const dock = createDock({ ctx, host, node: editorEl, slot: editorSlot, getTitle: () => sandbox.objects.get(sandbox.selected)?.name ?? "Scene", note: "The settings of the selected object are in the Scene panel, under the list of objects.", onPlace: (inInspector) => { editSection.hidden = inInspector; } });
    editorSlot.append(editorEl);

    // ---- snapping, gizmo, view -------------------------------------------------------------------------------------------------------------
    const gridSel = h("select", { class: "input", id: id.grid, "aria-label": "Grid snapping" }, GRID_STEPS_MM.map((v) => h("option", { value: v }, v ? `${v} mm` : "Off")));
    gridSel.addEventListener("change", () => sandbox.setSnap({ gridMm: Number(gridSel.value) }));
    const angleSel = h("select", { class: "input", id: id.angle, "aria-label": "Angle snapping" }, ANGLE_STEPS.map((v) => h("option", { value: v }, v ? `${v}°` : "Off")));
    angleSel.addEventListener("change", () => sandbox.setSnap({ angleDeg: Number(angleSel.value) }));
    const gizmoSeg = segmented({ label: "Gizmo in the 3D view", value: sandbox.gizmoMode, onChange: (v) => sandbox.setGizmoMode(v), options: [
      { value: "translate", label: "Move", title: "Move gizmo (W)" }, { value: "rotate", label: "Rotate", title: "Rotate about the vertical axis (E)" }, { value: "scale", label: "Resize", title: "Resize boxes, cylinders, walls and tiles (R)" }, { value: "none", label: "Off", title: "No gizmo: drag objects on the floor instead" }] });
    const namesCb = h("input", { type: "checkbox", id: nextId("hm-sc-names"), checked: sandbox.showNames ? true : null });
    namesCb.addEventListener("change", () => sandbox.setShowNames(namesCb.checked));
    const snapBody = h("div", { class: "hm-sc-stack" },
      h("div", { class: "hm-sc-2" }, h("div", { class: "field" }, h("label", { for: id.grid }, "Grid"), gridSel), h("div", { class: "field" }, h("label", { for: id.angle }, "Angle"), angleSel)),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Gizmo"), gizmoSeg.el),
      h("label", { class: "check", for: namesCb.id }, namesCb, h("span", { class: "lbl" }, "Show names of all objects in the 3D view")),
      h("p", { class: "small muted" }, "Objects never go below the floor. Drag an object on the floor; hold Shift to lift it. Locked objects stay where they are. Alt while dragging turns snapping off."));
    function syncSnap() {
      const s = sandbox.snap;
      gridSel.value = String(s.gridMm); angleSel.value = String(s.angleDeg);
      gizmoSeg.set(sandbox.gizmoMode);
      const o = sandbox.objects.get(sandbox.selected), scalable = !!(o && byType(o.type).scaleMap), b = gizmoSeg.el.querySelector('[data-value="scale"]');
      if (b) { b.disabled = !!o && !scalable; b.title = b.disabled ? "This object has no free size: use its size fields" : "Resize boxes, cylinders, walls and tiles (R)"; }
      namesCb.checked = sandbox.showNames;
    }

    // ---- scene file --------------------------------------------------------------------------------------------------------------------------------
    const fileMsg = h("div", { class: "hm-sc-msgs", "aria-live": "polite" });
    const fileInput = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", tabindex: "-1", "aria-hidden": "true" });
    const showMsgs = (level, title, items) => {
      fileMsg.replaceChildren(...(items.length ? [notice([h("strong", {}, title), h("ul", { class: "hm-sc-msg-list" }, items.slice(0, 8).map((m) => h("li", {}, m)), items.length > 8 ? h("li", {}, `… and ${items.length - 8} more.`) : null)], { level, onDismiss: () => fileMsg.replaceChildren() })] : []));
    };
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files?.[0];
      fileInput.value = "";
      if (!f) return;
      if (f.size > MAX_TEXT) { showMsgs("error", "This file is too large to be a scene.", [`The limit is ${Math.round(MAX_TEXT / 1e6)} MB.`]); return; }
      let text;
      try { text = await f.text(); } catch { showMsgs("error", "The file could not be read.", []); return; }
      const r = sandbox.fromJSON(text);
      if (!r.ok) { showMsgs("error", "This is not a scene this tool can open.", r.errors); return; }
      sandbox.frameObjects?.(null);
      toast(`Opened ${r.added} object${r.added === 1 ? "" : "s"}. Undo with Ctrl+Z.`);
      say(`Opened ${r.added} objects.`);
      showMsgs("warn", r.warnings.length ? "Opened, with notes:" : "", r.warnings);
    });
    const saveScene = () => { download("digital-human-scene.json", JSON.stringify(sandbox.toSceneFile(), null, 2), "application/json"); toast("Scene saved as digital-human-scene.json"); };
    const rememberCb = h("input", { type: "checkbox", id: nextId("hm-sc-rem"), checked: sandbox.remember ? true : null });
    rememberCb.addEventListener("change", () => { if (!sandbox.setRemember(rememberCb.checked)) { rememberCb.checked = false; toast("This browser does not allow saving the scene here."); } });
    const clearBtn = h("button", { type: "button", class: "btn", onclick: () => { if (sandbox.objects.size && sandbox.clear()) { say("The scene was cleared."); toast("Scene cleared. Undo with Ctrl+Z."); } } }, svgIcon("trash", 14), "Clear the scene");
    const fileBody = h("div", { class: "hm-sc-stack" },
      h("div", { class: "hm-sc-row" }, h("button", { type: "button", class: "btn", onclick: saveScene, title: "Download the objects, measurements and settings as a JSON file" }, svgIcon("download", 14), "Save scene"),
        h("button", { type: "button", class: "btn", onclick: () => fileInput.click(), title: "Open a scene file saved earlier" }, svgIcon("upload", 14), "Open scene…"), clearBtn),
      fileInput, fileMsg,
      h("label", { class: "check", for: rememberCb.id }, rememberCb, h("span", { class: "lbl" }, "Remember this scene in this browser")),
      h("p", { class: "small muted" }, "Off by default. When on, the scene is kept in this browser only (never uploaded) and opened again next time."));

    // ---- place the human (another module renders into this container) ----------------------------------------------------------------------------------------------
    const placeSection = section("Place the human", [sandbox.placeContainer ?? h("div", { id: "hm-place-human", class: "hm-place" })], { open: true, className: "hm-sc-place" });
    const placeEl = placeSection.querySelector("#hm-place-human");
    const placeMount = placeEl ? mountPlace(placeEl, ctx) : null;   // sit on a chair, grab with IK, reach checks (place.js)
    const checkPlace = () => { placeSection.hidden = !placeEl || placeEl.childElementCount === 0; };
    const placeMO = typeof MutationObserver !== "undefined" ? new MutationObserver(checkPlace) : null;
    placeMO?.observe(placeEl, { childList: true });
    checkPlace();

    const keys = h("details", { class: "hm-sc-keys" }, h("summary", {}, "Keyboard"), h("dl", { class: "hm-sc-kbd" },
      ...[["Arrow keys", "In the 3D view: nudge the selected object (10 mm; Shift ×10, Alt ×0.1)"], ["[ and ]", "In the 3D view: turn it left or right"], ["W, E, R", "In the 3D view: move, rotate, resize gizmo"], ["Delete", "In the 3D view: remove the selected object. On a row of the list: remove that object"], ["Ctrl+D", "Duplicate it"], ["Ctrl+Z, Ctrl+Shift+Z", "Undo, redo"], ["Esc", "Deselect (then the arrow keys move the camera again)"]].flatMap(([k, d]) => [h("dt", {}, h("kbd", { class: "hm-kbd" }, k)), h("dd", {}, d)])));

    // ---- assemble --------------------------------------------------------------------------------------------------------------------------------------------
    const addSection = section("Add an object", [h("div", { class: "field hm-obj-search" }, h("label", { for: id.search, class: "sr-only" }, "Search objects"), h("span", { class: "hm-obj-sicon" }, svgIcon("search", 14)), search), catBar, grid, detail], { open: true });
    const tplSection = section("Templates", [tplBody], { open: false });
    const objSection = section("Objects in the scene", [h("div", { class: "hm-sc-row" }, h("button", { type: "button", class: "btn small", onclick: () => sandbox.frameObjects(null), title: "Fit every object in the 3D view" }, svgIcon("frame", 14), "Show all")), listEmpty, list], { open: true });
    objSection.querySelector("summary").append(listCount);
    const editSection = section("Selected object", [editorSlot], { open: true });
    const snapSection = section("Move, snap and gizmo", [snapBody], { open: false });
    const fileSection = section("Scene file", [fileBody], { open: false });
    const root = h("div", { class: "hm-sc" }, h("div", { class: "hm-sc-head" }, h("h2", { class: "hm-panel-title" }, "Scene"), h("div", { class: "hm-sc-row" }, undoBtn, redoBtn)),
      h("p", { class: "small muted" }, "Place objects around the figure: seats, displays, loads, tools. Click or drag them in the 3D view; measure in the Measure tab."),
      addSection, tplSection, objSection, placeSection, editSection, snapSection, fileSection, keys, live);
    host.replaceChildren(root);

    // keys: with focus in this panel or in its settings only Ctrl+Z / Y / D work (undo, redo, duplicate). Delete, W, E, R, [ ] and the arrows belong to the
    // 3D view and to the control that has the focus: on a button, a card or a swatch they must not act on whichever object happens to be selected.
    const onKeys = (e) => { if (sandbox.onKey(e, { arrows: false, objectKeys: false })) { e.preventDefault(); e.stopPropagation(); } };
    root.addEventListener("keydown", onKeys);
    editorEl.addEventListener("keydown", onKeys);
    // Delete on a row of the list removes THAT row's object (the row is what has the focus; the selection may be another object)
    list.addEventListener("keydown", (e) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const li = e.target.closest?.(".hm-ol-row"), o = li && sandbox.objects.get(li.dataset.id);
      if (!o) return;
      e.preventDefault(); e.stopPropagation();
      if (o.locked) { toast(`"${o.name}" is locked. Unlock it to delete it.`); return; }
      const at = [...list.children].indexOf(li);
      if (sandbox.remove(o.id)) { pendingFocus = at; say(`${o.name} deleted.`); }
    });

    // ---- live updates -------------------------------------------------------------------------------------------------------------------------------------------
    let raf = 0, needList = false, needEditor = false, needHistory = false;
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
    function flush() {
      raf = 0;
      if (needList) renderList();
      if (needEditor || needList) renderEditor();
      if (needHistory || needList) { updateHistory(); syncSnap(); }
      needList = needEditor = needHistory = false;
    }
    const schedule = () => { if (!raf) raf = frame(flush); };
    on("scene", (e) => {
      switch (e.op) {
        case "move": needEditor = true; break; // a drag changes numbers, not the list
        case "history": needHistory = true; break;
        case "update": if (e.key) needEditor = true; else if (e.op2) needHistory = true; else needList = true; break; // a slider keeps its focus; a rename / lock / colour redraws the list
        default: needList = true; // add, remove, load, restore, clear, attach
      }
      schedule();
    });
    on("selection", () => { needList = true; schedule(); });
    on("units", () => { state.editor = null; needEditor = true; schedule(); });
    on("rig", () => { state.editor = null; needEditor = true; schedule(); });
    renderCatalog();
    renderList();
    renderEditor();
    updateHistory();
    syncSnap();

    // "Remember this scene" saves 600 ms after an edit; a page that is closed or put away before that must not lose the edit (the tab being left is flushed by the sandbox's dispose)
    const flushSave = () => { sandbox.flushSave(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flushSave(); };
    window.addEventListener("pagehide", flushSave);
    document.addEventListener("visibilitychange", onVisibility);

    return {
      onShow() {
        sandbox.setInteraction({ pick: true, drag: true, gizmo: true });
        dock.place(true);
        renderEditor();
        const cb = (type, url) => { const el = thumbs.get(type); if (el && url && !el.querySelector("img")) el.replaceChildren(h("img", { src: url, alt: "", width: 44, height: 44, draggable: "false" })); };
        cb.owner = owner;
        requestThumbs([...thumbs.keys()], cb);
      },
      onHide() {
        sandbox.setInteraction({ pick: false, drag: false, gizmo: false });
        sandbox.hover(null);
        dropThumbRequests(owner);
      },
      dispose() {
        for (const f of offs.splice(0)) f();
        window.removeEventListener("pagehide", flushSave);
        document.removeEventListener("visibilitychange", onVisibility);
        if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
        placeMO?.disconnect();
        placeMount?.dispose();
        dock.dispose();
        dropThumbRequests(owner);
        sandbox.setInteraction({ pick: false, drag: false, gizmo: false });
        releaseMeasure(ctx);
        releaseSandbox(ctx);
      },
    };
  },
};
