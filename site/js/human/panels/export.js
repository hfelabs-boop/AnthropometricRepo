// Export panel of the Digital human tab: take the figure, its posture and the scene into CAD, digital-human-modelling and motion tools.
// The formats themselves are built by ../export.js (pure, tested in Node); this file adds the options, the downloads, the busy and error states, posture and
// scene files that can be loaded again, and the PNG images, which need the viewport's renderer. Everything is made in the browser; nothing is sent anywhere.
// Panel contract: shell.js (default { id, label, order, mount(container, ctx) }). Styles: site/human-export.css (prefix hm-ex-), injected once.
// Manual: docs/human3d/EXPORT.md.
import * as THREE from "three";
import { h, download, toast } from "../../util.js";
import { section, segmented, notice, emptyState, nextId } from "../ui.js";
import { peekSandbox, acquireSandbox, releaseSandbox, MAX_TEXT } from "../sandbox.js";
import { peekMeasure, acquireMeasure, releaseMeasure } from "../measure.js";
import { viewDirection, frameDistance } from "../viewport.js";
import * as X from "../export.js";

const CSS_URL = new URL("../../../human-export.css", import.meta.url).href;

/** Inject site/human-export.css once and wait (briefly) for it. Resolves whether or not it loaded: the panel works without it, only plainer. */
export function ensureExportStyles() {
  let link = document.querySelector("link[data-hm-export-css]");
  if (link?.dataset.hmFailed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-export-css": "" });
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

// ---------------------------------------------------------------------------------------------------------------------
// options, remembered in this browser only (a per-viewer convenience; the panel works without storage)
const KEY = "hm-export-opts";
const DEFAULTS = {
  glbFigure: "skin", glbPose: "baked", glbScene: true, glbMeas: true,
  meshUnit: "mm", meshAxes: "y-up", meshSkin: true, meshScene: true,
  bvhUnit: "cm", bvhNeutral: false, bvhHeader: false,
  csvHeader: false,
  imgScale: 1, imgBackground: "scene", imgGrid: true, imgShadow: true,
  postPlace: true, sceneAdd: false,
};
const CHOICES = { glbFigure: ["skin", "skeleton", "none"], glbPose: ["baked", "clip"], meshUnit: ["mm", "m"], meshAxes: Object.keys(X.AXES), bvhUnit: ["cm", "mm", "m"], imgScale: [1, 2], imgBackground: ["scene", "transparent"] };
function loadOpts() {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") for (const [k, d] of Object.entries(DEFAULTS)) if (Object.hasOwn(raw, k) && (CHOICES[k] ? CHOICES[k].includes(raw[k]) : typeof raw[k] === typeof d)) out[k] = raw[k];
  } catch { /* no storage, or corrupt: defaults */ }
  return out;
}
function saveOpts(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode: the options are just not remembered */ } }

// ---------------------------------------------------------------------------------------------------------------------
// small helpers
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
/** Let the page paint between two steps of a slow export (requestAnimationFrame stops in a hidden browser tab, so a timer backs it up). */
const frame = () => new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } }; requestAnimationFrame(f); setTimeout(f, 60); });
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through to the old way */ }
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
const blobOf = (data, type) => new Blob([data], { type });
const message = (e) => String(e?.message ?? e ?? "unknown error").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 240);

// ---------------------------------------------------------------------------------------------------------------------
// images: the viewport's own renderer, resized for the moment of the capture and put back (nothing stays changed)
const IMG_MAX = 4096; // longest side of the renderer, a safe limit for every GPU and for software rendering
const STRIP_VIEWS = [["front", "Front"], ["left", "Left side"], ["back", "Back"], ["top", "Top"]];

/** Run `fn(renderer, camera, scene)` with the floor items (grid / shadow) and the gizmo hidden as asked; whatever it changes is restored and the view is drawn again. */
function withViewport(vp, { grid = true, shadow = true }, fn) {
  const r = vp.renderer, cam = vp.camera, sc = vp.scene;
  if (!r || !vp.canvas) throw new Error("The 3D view is not available, so there is no image to save. Check that WebGL works in this browser.");
  const size = r.getSize(new THREE.Vector2());
  if (size.x < 2 || size.y < 2) throw new Error("The 3D view is hidden or too small. Make it visible and try again.");
  const keep = { pr: r.getPixelRatio(), w: size.x, h: size.y, aspect: cam.aspect, pos: cam.position.clone(), quat: cam.quaternion.clone(), up: cam.up.clone(), bg: sc.background };
  const hidden = [];
  for (const c of vp.floor?.children ?? []) if (c.name === "hm-shadow-catcher" ? !shadow : !grid) { hidden.push([c, c.visible]); c.visible = false; }
  const helper = vp.gizmo?.getHelper?.();
  if (helper) { hidden.push([helper, helper.visible]); helper.visible = false; }
  try { return fn(r, cam, sc, keep); } finally {
    for (const [o, v] of hidden) o.visible = v;
    sc.background = keep.bg;
    r.setPixelRatio(keep.pr); r.setSize(keep.w, keep.h, false);
    cam.aspect = keep.aspect; cam.updateProjectionMatrix();
    cam.position.copy(keep.pos); cam.quaternion.copy(keep.quat); cam.up.copy(keep.up); cam.updateMatrixWorld(true);
    vp.renderNow(); // the view must not stay blank until the next animation frame
  }
}
const canvas2d = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
/** One render at w x h pixels into a 2D canvas; `bg` = a colour to clear to, or null for the theme's own background. */
function pass(r, cam, sc, w, h, bg, g2) {
  r.setPixelRatio(1); r.setSize(w, h, false);
  cam.aspect = w / h; cam.updateProjectionMatrix();
  if (bg !== null) sc.background = new THREE.Color(bg);
  r.render(sc, cam);
  g2.clearRect(0, 0, w, h);
  g2.drawImage(r.domElement, 0, 0); // same task as the render: the drawing buffer is still valid
  return g2.getImageData(0, 0, w, h);
}
/** The pixels of the current camera at w x h: opaque (theme background) or transparent (a render over black and one over white, see matteFromPair). */
function shot(r, cam, sc, w, h, transparent) {
  const g = canvas2d(w, h).getContext("2d", { willReadFrequently: true });
  if (!transparent) return pass(r, cam, sc, w, h, null, g);
  const black = pass(r, cam, sc, w, h, 0x000000, g).data, white = pass(r, cam, sc, w, h, 0xffffff, g).data;
  return new ImageData(X.matteFromPair(black, white), w, h);
}
const toPNG = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("The browser could not encode the image."))), "image/png"));
function limitSize(w, h, r) {
  const cap = Math.min(IMG_MAX, r.capabilities?.maxTextureSize ?? IMG_MAX), k = Math.min(1, cap / Math.max(w, h));
  return [Math.max(2, Math.floor(w * k)), Math.max(2, Math.floor(h * k)), k < 1];
}

/** PNG of the 3D view as it is: scale x the size of the view in the page, with or without a background, grid and floor shadow. Returns { blob, width, height, limited }. */
export async function capturePNG(vp, { scale = 1, transparent = false, grid = true, shadow = true } = {}) {
  let out;
  withViewport(vp, { grid, shadow }, (r, cam, sc, keep) => {
    const [w, h, limited] = limitSize(Math.round(keep.w * scale), Math.round(keep.h * scale), r), img = shot(r, cam, sc, w, h, transparent);
    const c = canvas2d(w, h);
    c.getContext("2d").putImageData(img, 0, 0);
    out = { canvas: c, width: w, height: h, limited };
  });
  return { blob: await toPNG(out.canvas), width: out.width, height: out.height, limited: out.limited };
}

/** Front, left, back and top of the figure (and the scene) in one PNG strip, each in its own cell with the camera framing the whole figure. */
export async function captureViews(vp, box, { scale = 1, transparent = false, grid = true, shadow = true } = {}) {
  let out;
  withViewport(vp, { grid, shadow }, (r, cam, sc) => {
    const [cw, ch, limited] = limitSize(480 * scale, 640 * scale, r), strip = canvas2d(cw * STRIP_VIEWS.length, ch), g = strip.getContext("2d"), th = vp.theme ?? {};
    STRIP_VIEWS.forEach(([name, label], i) => {
      const centre = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5), dir = viewDirection(name);
      cam.up.set(0, 1, 0);
      cam.position.copy(centre).addScaledVector(dir, frameDistance(half, dir, cam.fov, cw / ch, 1.12));
      cam.lookAt(centre); cam.updateMatrixWorld(true);
      g.putImageData(shot(r, cam, sc, cw, ch, transparent), i * cw, 0);
      if (!transparent) { // a caption on the opaque strip (a transparent one is meant to be laid over something else)
        const k = scale, fs = 13 * k;
        g.font = `600 ${fs}px ${getComputedStyle(vp.container).fontFamily || "sans-serif"}`;
        g.textBaseline = "middle";
        const wd = g.measureText(label).width + 12 * k;
        g.globalAlpha = 0.85; g.fillStyle = th.surfaceCss || "#ffffff"; g.fillRect(i * cw + 8 * k, 8 * k, wd, 22 * k);
        g.globalAlpha = 1; g.fillStyle = th.textCss || "#000000"; g.fillText(label, i * cw + 14 * k, 19 * k);
      }
    });
    out = { canvas: strip, width: strip.width, height: strip.height, limited };
  });
  return { blob: await toPNG(out.canvas), width: out.width, height: out.height, limited: out.limited };
}
/** The box the strip frames: the figure, plus the scene objects when that does not make the box huge. */
function frameBox(rig, sandbox) {
  const fallback = new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.6), new THREE.Vector3(0.6, 1.9, 0.6)), ok = (b) => !b.isEmpty() && b.getSize(new THREE.Vector3()).toArray().every((v) => Number.isFinite(v) && v < 20);
  rig.group.updateMatrixWorld(true);
  const fig = new THREE.Box3().setFromObject(rig.group);
  const box = ok(fig) ? fig : fallback;
  const objs = X.visibleObjects(sandbox);
  if (objs.length) {
    const all = box.clone();
    for (const o of objs) { o.group.updateMatrixWorld(true); all.union(new THREE.Box3().setFromObject(o.group)); }
    if (ok(all) && all.getSize(new THREE.Vector3()).length() < 8) return all;
  }
  return box.expandByVector(new THREE.Vector3(0.12, 0.05, 0.12));
}

// ---------------------------------------------------------------------------------------------------------------------
export default {
  id: "export",
  label: "Export",
  order: 7,
  async mount(host, ctx) {
    await ensureExportStyles();
    const opt = loadOpts(), offs = [], buttons = [], ids = (n) => nextId(`hm-ex-${n}`);
    let disposed = false, visible = false, busy = false, timer = 0, hasRig = false, objects = 0, sandboxRef = null, measureRef = null, summaryOpen = false;

    // ---- plumbing: the figure, busy state, errors -------------------------------------------------------------------------
    const getInput = () => {
      const rig = ctx.getRig();
      if (!rig) throw new Error("There is no figure to export yet. Wait for the model to finish building.");
      const sandbox = peekSandbox(ctx), measure = peekMeasure(ctx);
      let measurements = null;
      try { measurements = measure?.exportRows?.() ?? null; } catch { measurements = null; }
      return { rig, profile: ctx.getProfile(), posture: ctx.state.posture, sandbox, measurements };
    };
    const fname = (what, ext, suffix) => X.exportFileName({ profile: ctx.getProfile(), posture: ctx.state.posture, what, ext, suffix });
    const stamp = () => new Date().toISOString();

    const busyText = h("span", {});
    const busyEl = h("p", { class: "hm-ex-busy", role: "status", hidden: true }, h("span", { class: "spinner", "aria-hidden": "true" }), busyText);
    const last = h("p", { class: "hm-ex-last", role: "status", "aria-live": "polite" });
    const msgs = h("div", { class: "hm-ex-msgs", "aria-live": "polite" });
    const stateEl = h("div", { class: "hm-ex-state" });

    function showIssues(title, lines, level = "error") {
      const el = notice([title, lines.length ? h("ul", {}, lines.slice(0, 10).map((t) => h("li", {}, t))) : null], { level, onDismiss: () => el.remove() });
      el.setAttribute("role", level === "error" ? "alert" : "status");
      msgs.replaceChildren(el);
    }
    function say(text) { last.textContent = text; ctx.toast(text.length > 90 ? `${text.slice(0, 87)}…` : text); }
    async function run(label, task) {
      if (busy || disposed) return;
      busy = true;
      root.setAttribute("aria-busy", "true");
      applyEnabled();
      busyText.textContent = `${label}…`;
      busyEl.hidden = false;
      msgs.replaceChildren();
      last.textContent = "";
      try {
        await frame(); // let the busy message appear before the heavy work starts
        const done = await task(async (t) => { if (t) busyText.textContent = `${t}…`; await frame(); });
        if (done) say(done);
      } catch (e) {
        console.warn("Digital human export failed:", e);
        showIssues(`${label} did not finish.`, [`${message(e)}.`]);
      } finally {
        busy = false;
        busyEl.hidden = true;
        root.removeAttribute("aria-busy");
        applyEnabled();
      }
    }
    function save(name, blob) { download(name, blob, blob.type); }
    async function copy(text, what) { const ok = await copyText(text); ctx.toast(ok ? `Copied ${what} to the clipboard.` : "The browser blocked copying. Use the download button instead."); if (ok) last.textContent = `Copied ${what} (${X.formatBytes(text.length)}).`; return ok; }

    // ---- building blocks of the UI -----------------------------------------------------------------------------------------
    const reg = (el, when) => { buttons.push({ el, when }); return el; };
    const button = (label, onClick, { primary = false, title, when, ariaLabel } = {}) => reg(h("button", { type: "button", class: `btn${primary ? " primary" : ""} small hm-ex-btn`, title, "aria-label": ariaLabel, onclick: () => { if (busy) return; onClick(); } }, label), when);
    const check = (key, label, { when } = {}) => {
      const input = h("input", { type: "checkbox", checked: opt[key] ? true : null, onchange: () => { opt[key] = input.checked; saveOpts(opt); refresh(); } });
      const text = h("span", {}, label);
      return { el: h("label", { class: "hm-ex-check" }, input, text), input, text, when };
    };
    const seg = (key, label, options, { onPick } = {}) => {
      const s = segmented({ label, options, value: opt[key], onChange: (v) => { opt[key] = v; saveOpts(opt); onPick?.(v); refresh(); } });
      return { ...s, field: h("div", { class: "hm-ex-field" }, h("span", { class: "hm-ex-lbl", "aria-hidden": "true" }, label), s.el) };
    };
    const select = (key, label, options) => {
      const id = ids(key), el = h("select", { class: "input", id, onchange: () => { opt[key] = el.value; saveOpts(opt); refresh(); } }, options.map(([v, t]) => h("option", { value: v, selected: opt[key] === v ? true : null }, t)));
      return { el, field: h("div", { class: "hm-ex-field" }, h("label", { for: id }, label), el) };
    };
    const card = (title, who, desc, ...rest) => h("div", { class: "hm-ex-card" }, h("div", { class: "hm-ex-head" }, h("h3", {}, title), who ? h("span", { class: "tag outline hm-ex-who" }, who) : null), desc ? h("p", { class: "hm-ex-desc" }, desc) : null, ...rest);
    const sizeEl = () => h("span", { class: "hm-ex-size" });

    // ---- 1. 3D model: GLB, OBJ, STL --------------------------------------------------------------------------------------------
    const glbFigure = seg("glbFigure", "Figure", [{ value: "skin", label: "Skin and skeleton", title: "The skinned body and its 77-joint skeleton" }, { value: "skeleton", label: "Skeleton only", title: "The 77 joints and thin bone sticks, no skin" }, { value: "none", label: "None", title: "Only the scene objects" }]);
    const glbPose = seg("glbPose", "Pose", [{ value: "baked", label: "Baked in", title: "Skeleton and skin in the current pose (it is the bind pose of the file)" }, { value: "clip", label: "Neutral and clip", title: "Neutral standing bind pose and the current pose as a one-frame animation" }]);
    const glbScene = check("glbScene", "Scene objects");
    const glbMeas = check("glbMeas", "Measurements as extra data");
    const glbSize = sizeEl();
    const glbBtn = button("Download GLB", () => run("Building the GLB", async (tick) => {
      const inp = getInput(), figure = opt.glbFigure, withScene = opt.glbScene && objects > 0;
      if (figure === "none" && !withScene) throw new Error("Nothing is selected: choose the figure or include scene objects");
      const out = await X.buildGLB(inp, { figure, pose: opt.glbPose, scene: withScene, measurements: opt.glbMeas, created: stamp(), tick });
      const name = fname(figure === "none" ? "scene" : figure === "skeleton" ? "skeleton" : "figure", "glb", figure !== "none" && opt.glbPose === "clip" ? "clip" : "");
      save(name, blobOf(out.data, "model/gltf-binary"));
      return `Saved ${name} (${X.formatBytes(out.bytes)}): ${out.stats.joints} joints, ${fmtInt(out.stats.vertices)} vertices${out.stats.objects ? `, ${out.stats.objects} scene object${out.stats.objects === 1 ? "" : "s"}` : ""}. Metres, +Y up, the figure faces +Z.`;
    }), { primary: true, title: "Binary glTF 2.0: skinned mesh and skeleton" });
    const glbCard = card("GLB (glTF 2.0)", "Blender, Unity, Unreal, web viewers",
      "Skinned mesh with the full 77-joint skeleton (node names are the joint ids). Metres, +Y up, the figure faces +Z.",
      h("div", { class: "hm-ex-opts" }, glbFigure.field, glbPose.field, glbScene.el, glbMeas.el),
      h("div", { class: "hm-ex-actions" }, glbBtn, glbSize));

    const meshUnit = seg("meshUnit", "Unit", [{ value: "mm", label: "Millimetres", title: "1 unit = 1 mm (usual in CAD)" }, { value: "m", label: "Metres", title: "1 unit = 1 m" }]);
    const meshAxes = select("meshAxes", "Axes", Object.entries(X.AXES).map(([k, a]) => [k, a.label]));
    const meshSkin = check("meshSkin", "The figure (posed skin)");
    const meshScene = check("meshScene", "Scene objects");
    const objSize = sizeEl(), stlSize = sizeEl();
    const meshOptions = () => ({ unit: opt.meshUnit, axes: opt.meshAxes, skin: opt.meshSkin, scene: opt.meshScene && objects > 0, created: stamp() });
    const meshSuffix = () => `${opt.meshUnit}${opt.meshAxes === "y-up" ? "" : `-${opt.meshAxes}`}`;
    const objBtn = button("Download OBJ", () => run("Building the OBJ", async (tick) => {
      const out = await X.buildOBJ(getInput(), { ...meshOptions(), tick });
      const name = fname("mesh", "obj", meshSuffix());
      save(name, blobOf(out.text, "text/plain;charset=utf-8"));
      return `Saved ${name} (${X.formatBytes(out.bytes)}): ${fmtInt(out.stats.vertices)} vertices, ${fmtInt(out.stats.triangles)} triangles. The unit and the axes are written in the first lines.`;
    }), { primary: true, title: "Wavefront OBJ: the posed skin as a static mesh" });
    const stlBtn = button("Download STL", () => run("Building the STL", async (tick) => {
      const out = await X.buildSTL(getInput(), { ...meshOptions(), tick });
      const name = fname("mesh", "stl", meshSuffix());
      save(name, blobOf(out.data, "model/stl"));
      return `Saved ${name} (${X.formatBytes(out.bytes)}): ${fmtInt(out.triangles)} triangles, binary. STL has no unit field: this file is in ${opt.meshUnit === "mm" ? "millimetres" : "metres"}.`;
    }), { title: "Binary STL: triangles only" });
    const meshCard = card("OBJ and STL (static mesh)", "CAD, CATIA / AutoCAD import, 3D printing",
      "The skin in the current pose as triangles, with the scene objects if you like. Check the unit and the up axis in the import dialog of your tool.",
      h("div", { class: "hm-ex-opts" }, meshUnit.field, meshAxes.field, meshSkin.el, meshScene.el),
      h("div", { class: "hm-ex-actions" }, objBtn, objSize, stlBtn, stlSize));

    // the meshes follow the quality of the 3D view (fit.js builds the same body; body.js samples it more finely at "high")
    const qualityText = h("span", {});
    const qualityBtn = reg(h("button", { type: "button", class: "btn small hm-ex-btn", onclick: () => { if (!busy) ctx.setQuality("high"); } }, "Use high quality"), () => true);
    const qualityNote = h("div", { class: "hm-ex-quality", hidden: true }, qualityText, qualityBtn);

    // ---- 2. BVH ---------------------------------------------------------------------------------------------------------------
    const bvhUnit = seg("bvhUnit", "Unit of OFFSET and position", [{ value: "cm", label: "cm" }, { value: "mm", label: "mm" }, { value: "m", label: "m" }]);
    const bvhNeutral = check("bvhNeutral", "Add a second frame with the neutral standing pose");
    const bvhHeader = check("bvhHeader", "Comment lines at the top (profile, posture, units, axes). Several tools refuse them");
    const bvhOpts = () => ({ unit: opt.bvhUnit, neutralFrame: opt.bvhNeutral, header: opt.bvhHeader, created: stamp() });
    const bvhBtn = button("Download BVH", () => run("Building the BVH", async () => {
      const out = X.buildBVH(getInput(), bvhOpts()), name = fname("skeleton", "bvh", opt.bvhUnit);
      save(name, blobOf(out.text, "text/plain;charset=utf-8"));
      return `Saved ${name} (${X.formatBytes(out.bytes)}): ${out.joints} joints, ${out.frames} frame${out.frames === 1 ? "" : "s"}, ${opt.bvhUnit}, rotations Z X Y in degrees. Y up, +Z in front of the figure.`;
    }), { primary: true, title: "Biovision hierarchy: the skeleton and the posture as one frame" });
    const bvhCopy = button("Copy", () => run("Copying the BVH", async () => { await copy(X.buildBVH(getInput(), bvhOpts()).text, "the BVH text"); }), { title: "Copy the BVH text to the clipboard" });
    const bvhCard = card("BVH (Biovision hierarchy)", "Motion-capture and digital-human-modelling tools",
      "The 77-joint skeleton with OFFSETs and one frame of rotations (ZXY Euler, degrees). Y up, +Z in front of the figure, +X the figure's left, right-handed.",
      h("div", { class: "hm-ex-opts" }, bvhUnit.field, bvhNeutral.el, bvhHeader.el),
      h("div", { class: "hm-ex-actions" }, bvhBtn, bvhCopy));

    // ---- 3. tables --------------------------------------------------------------------------------------------------------------
    const csvHeader = check("csvHeader", "Comment lines (#) with profile, posture, units and axes at the top of CSV files. Spreadsheets show them as rows");
    async function pointsText(inp, header) {
      try { // the Skeleton tab's own CSV ("Points for CAD") when it is there: the same file from both tabs
        const m = await import("./skeleton.js");
        if (typeof m.collectPoints === "function" && typeof m.pointsCSV === "function") return (header ? X.csvHeader(inp, "Joint centres and landmarks", "millimetres") : "") + m.pointsCSV(m.collectPoints(inp.rig));
      } catch { /* use ours */ }
      return X.pointsCSV(inp, { header });
    }
    const TABLES = [
      { id: "points", name: "Joint centres and landmarks", info: "World positions in mm: 77 joint centres and the landmarks, in the current pose.", what: "points", text: (i, hd) => pointsText(i, hd), json: null },
      { id: "angles", name: "Joint angles", info: "Every degree of freedom: value, range of motion, whether it is at a limit.", what: "angles", text: (i, hd) => X.anglesCSV(i, { header: hd }), json: (i) => X.anglesJSON(i, { created: stamp() }) },
      { id: "dims", name: "Dimensions (mapping table)", info: "Every body dimension the model uses, in mm, with its source: measured, derived or estimated.", what: "dimensions", text: (i, hd) => X.dimsCSV(i, { header: hd }), json: null },
      { id: "report", name: "Fit report", info: "Each survey measure against the same measure on the built model.", what: "fit-report", text: (i, hd) => X.reportCSV(i, { header: hd }), json: null },
      { id: "metrics", name: "Posture metrics", info: "Trunk, neck, arm and leg angles, heights, reach and balance of this posture.", what: "metrics", text: async (i, hd) => { const t = await X.metricsCSV(i, { header: hd }); if (t === null) throw new Error("Posture metrics are not available in this build"); return t; }, json: null },
    ];
    const tableRows = TABLES.map((t) => {
      const buildText = async () => t.text(getInput(), opt.csvHeader);
      const acts = [
        button("Copy", () => run(`Copying ${t.name.toLowerCase()}`, async () => { await copy(await buildText(), `${t.name} (CSV)`); }), { ariaLabel: `Copy ${t.name} as CSV`, title: "Copy as CSV text" }),
        button("CSV", () => run(`Making the ${t.name.toLowerCase()} table`, async () => {
          const text = await buildText(), name = fname(t.what, "csv");
          save(name, blobOf(text, "text/csv;charset=utf-8"));
          return `Saved ${name} (${X.formatBytes(text.length)}, ${fmtInt(text.trim().split("\n").length - 1)} rows).`;
        }), { primary: true, ariaLabel: `Download ${t.name} as CSV`, title: "Download as CSV" }),
      ];
      if (t.json) acts.push(button("JSON", () => run(`Making the ${t.name.toLowerCase()} file`, async () => {
        const text = t.json(getInput()), name = fname(t.what, "json");
        save(name, blobOf(text, "application/json"));
        return `Saved ${name} (${X.formatBytes(text.length)}).`;
      }), { ariaLabel: `Download ${t.name} as JSON`, title: "Download as JSON" }));
      return h("div", { class: "hm-ex-row" }, h("div", {}, h("b", {}, t.name), h("span", {}, t.info)), h("div", { class: "hm-ex-actions" }, acts));
    });
    const tablesCard = card("Tables (CSV, JSON)", "Spreadsheets, scripts, CAD macros", "Millimetres, degrees, kilograms. Axes: +X the figure's left, +Y up, +Z in front, floor at y = 0.",
      h("div", { class: "hm-ex-rows" }, tableRows), csvHeader.el);

    // ---- 4. exchange JSON -----------------------------------------------------------------------------------------------------------
    const jsonSize = sizeEl();
    const jsonBtn = button("Download JSON", () => run("Building the exchange file", async () => {
      const inp = getInput(), text = X.exchangeText(inp, { created: stamp() }), check1 = X.validateExchange(text), name = fname("exchange", "json");
      if (!check1.ok) throw new Error(`the file failed its own check: ${check1.errors[0]}`);
      save(name, blobOf(text, "application/json"));
      return `Saved ${name} (${X.formatBytes(text.length)}). Checked: valid human-exchange v1${check1.warnings.length ? `, ${check1.warnings.length} warning${check1.warnings.length === 1 ? "" : "s"}` : ""}.`;
    }), { primary: true, title: "One self-describing JSON file" });
    const jsonCard = card("Exchange JSON (human-exchange v1)", "For scripts and other programs",
      "One self-describing file: profile and measures, the dimension table, 77 joints with positions, orientations and ranges, landmarks, segment masses, posture, placement, scene and measurements. Millimetres, kilograms, degrees.",
      h("div", { class: "hm-ex-actions" }, jsonBtn, jsonSize));

    // ---- 5. posture and scene files --------------------------------------------------------------------------------------------------
    const fileInput = (accept, onFile) => {
      const el = h("input", { type: "file", accept, hidden: true, tabindex: "-1", "aria-hidden": "true", onchange: async () => { const f = el.files?.[0]; el.value = ""; if (f) await onFile(f); } });
      return el;
    };
    const postPlace = check("postPlace", "Place the figure on its support after loading (floor, seat height, or lying)");
    const sceneAdd = check("sceneAdd", "Add to the current scene instead of replacing it");
    const postFile = fileInput("application/json,.json", (f) => loadPosture(f)), sceneFile = fileInput("application/json,.json", (f) => loadScene(f));
    async function readFile(f, limit, what) {
      if (f.size > limit) throw new Error(`the ${what} file is too large (${X.formatBytes(f.size)}; the limit is ${X.formatBytes(limit)})`);
      return f.text();
    }
    function loadPosture(f) {
      return run("Loading the posture", async () => {
        const rig = ctx.getRig();
        if (!rig) throw new Error("there is no figure yet");
        const parsed = await X.parsePostureFile(await readFile(f, X.MAX_POSTURE_TEXT, "posture"));
        if (!parsed.ok) { showIssues(`${f.name} could not be loaded as a posture.`, parsed.errors); return null; }
        const res = await X.applyPostureFile(rig, parsed, { place: opt.postPlace });
        ctx.setPosture({ id: parsed.id, name: parsed.name });
        const notes = [...parsed.warnings, ...(res.clamped?.length && !parsed.clamped.length ? [`${res.clamped.length} angle${res.clamped.length === 1 ? " was" : "s were"} limited to the range of motion of this body.`] : [])];
        if (notes.length) showIssues(`Loaded "${parsed.name}" with notes:`, notes, "warn");
        return `Loaded the posture "${parsed.name}" from ${f.name}.`;
      });
    }
    function loadScene(f) {
      return run("Loading the scene", async () => {
        const text = await readFile(f, MAX_TEXT, "scene");
        sandboxRef ??= acquireSandbox(ctx); // creates the sandbox if the Scene tab was never opened; released when the tab is closed
        measureRef ??= acquireMeasure(ctx); // so that the measurements of the file find their section
        const r = sandboxRef.fromJSON(text, { merge: opt.sceneAdd });
        if (!r.ok) { showIssues(`${f.name} could not be loaded as a scene.`, r.errors); return null; }
        if (r.warnings.length) showIssues(`Loaded ${r.added} object${r.added === 1 ? "" : "s"} with notes:`, r.warnings, "warn");
        return `Loaded ${r.added} object${r.added === 1 ? "" : "s"} from ${f.name}${opt.sceneAdd ? " into the current scene" : ""}. Undo is in the Scene tab.`;
      });
    }
    const postDown = button("Download posture file", () => run("Making the posture file", async () => {
      const file = await X.buildPostureFile(getInput(), { created: stamp() }), text = JSON.stringify(file, null, 2) + "\n", name = fname("posture", "json");
      save(name, blobOf(text, "application/json"));
      return `Saved ${name} (${X.formatBytes(text.length)}). It holds the joint angles${file.library_posture ? " and the library posture" : ""}; load it again with "Load posture file".`;
    }), { primary: true, title: "Joint angles and the Posture object as JSON" });
    const postCopy = button("Copy", () => run("Copying the posture", async () => { await copy(JSON.stringify(await X.buildPostureFile(getInput()), null, 2), "the posture file"); }), { ariaLabel: "Copy the posture file as text" });
    const postLoad = button("Load posture file…", () => postFile.click(), { title: "Open a posture file saved here, a Posture object or a pose" });
    const sceneDown = button("Download scene file", () => run("Making the scene file", async () => {
      const text = X.sceneFileText(peekSandbox(ctx)), name = fname("scene", "json");
      save(name, blobOf(text, "application/json"));
      return `Saved ${name} (${X.formatBytes(text.length)}): ${objects} object${objects === 1 ? "" : "s"} and the measurements.`;
    }), { primary: true, when: () => !!peekSandbox(ctx), title: "The scene file of the Scene tab: objects, settings and measurements (metres)" });
    const sceneLoad = button("Load scene file…", () => sceneFile.click(), { title: "Open a scene file saved by the Scene tab or here" });
    const filesCard = card("Posture and scene files", "Keep, share and reload your work",
      "Posture files hold the joint angles of this figure (and the library posture when it is one). Scene files are the ones of the Scene tab.",
      h("div", { class: "hm-ex-opts" }, postPlace.el, sceneAdd.el),
      h("p", { class: "hm-ex-sub" }, "Posture"), h("div", { class: "hm-ex-actions" }, postDown, postCopy, postLoad),
      h("p", { class: "hm-ex-sub" }, "Scene"), h("div", { class: "hm-ex-actions" }, sceneDown, sceneLoad), postFile, sceneFile);

    // ---- 6. images --------------------------------------------------------------------------------------------------------------------
    const imgScale = seg("imgScale", "Size", [{ value: 1, label: "1×", title: "As large as the 3D view in the page" }, { value: 2, label: "2×", title: "Twice as large" }]);
    const imgBg = seg("imgBackground", "Background", [{ value: "scene", label: "Scene", title: "The colour of the 3D view" }, { value: "transparent", label: "Transparent", title: "A PNG with transparency (soft edges and shadow included)" }]);
    const imgGrid = check("imgGrid", "Grid and axes");
    const imgShadow = check("imgShadow", "Floor shadow");
    const imgOpts = () => ({ scale: opt.imgScale, transparent: opt.imgBackground === "transparent", grid: opt.imgGrid, shadow: opt.imgShadow });
    const imgNote = (r) => (r.limited ? " The size was reduced to what this graphics card can draw." : "");
    const pngBtn = button("Download PNG", () => run("Drawing the image", async () => {
      const r = await capturePNG(ctx.viewport, imgOpts()), name = fname("view", "png", opt.imgScale === 2 ? "2x" : "");
      save(name, r.blob);
      return `Saved ${name} (${r.width} × ${r.height} px, ${X.formatBytes(r.blob.size)}${opt.imgBackground === "transparent" ? ", transparent" : ""}).${imgNote(r)}`;
    }), { primary: true, title: "The 3D view as a PNG image" });
    const stripBtn = button("Download 4 views", () => run("Drawing the four views", async () => {
      const inp = getInput(), r = await captureViews(ctx.viewport, frameBox(inp.rig, inp.sandbox), imgOpts()), name = fname("views", "png", opt.imgScale === 2 ? "2x" : "");
      save(name, r.blob);
      return `Saved ${name}: front, left side, back and top, ${r.width} × ${r.height} px, ${X.formatBytes(r.blob.size)}.${imgNote(r)}`;
    }), { title: "Front, left side, back and top side by side in one PNG" });
    const imgCard = card("Images (PNG)", "Reports and slides", "What the 3D view shows (the camera, the display options and the scene), without labels. The camera button of the toolbar saves the view with its labels.",
      h("div", { class: "hm-ex-opts" }, imgScale.field, imgBg.field, imgGrid.el, imgShadow.el),
      h("div", { class: "hm-ex-actions" }, pngBtn, stripBtn));

    // ---- 7. summary ---------------------------------------------------------------------------------------------------------------------
    const summaryPre = h("pre", { class: "hm-ex-pre", tabindex: "0", "aria-label": "Summary text" });
    async function summary() { const inp = getInput(); let rows = null; try { rows = await X.metricRows(inp); } catch { rows = null; } return X.summaryText(inp, rows); }
    const sumBtn = button("Copy summary", () => run("Writing the summary", async () => { await copy(await summary(), "the summary"); }), { primary: true, title: "A short plain-text summary for a report" });
    const sumDetails = h("details", {}, h("summary", {}, "Show the summary text"), summaryPre);
    sumDetails.addEventListener("toggle", async () => { summaryOpen = sumDetails.open; if (summaryOpen) await refreshSummary(); });
    async function refreshSummary() { try { summaryPre.textContent = await summary(); } catch (e) { summaryPre.textContent = message(e); } }
    const sumCard = card("Summary", "Reports", "Profile, key dimensions, posture, the largest joint angles, scene objects and measurements as plain text.", h("div", { class: "hm-ex-actions" }, sumBtn), sumDetails);

    // ---- layout -------------------------------------------------------------------------------------------------------------------------
    const intro = h("p", { class: "small muted hm-ex-intro" }, "Take the figure, its posture and the scene into CAD, digital-human and motion tools. Every file names the units and axes it uses. Files are made in your browser; nothing is uploaded.");
    const note = h("p", { class: "hm-ex-note" }, "The model is a simplified kinematic and anthropometric visualisation (rigid links, approximate joint centres, no soft tissue). Check the scale and the axes after importing.");
    const root = h("div", { class: "hm-ex" }, h("h2", { class: "hm-panel-title" }, "Export"), intro, stateEl, busyEl, last, msgs,
      section("3D model: GLB, OBJ, STL", [qualityNote, glbCard, meshCard], { open: true }),
      section("Skeleton and motion: BVH", [bvhCard], { open: false }),
      section("Tables: CSV and JSON", [tablesCard], { open: false }),
      section("Exchange JSON", [jsonCard], { open: false }),
      section("Posture and scene files", [filesCard], { open: false }),
      section("Images: PNG", [imgCard], { open: false }),
      section("Summary", [sumCard], { open: false }),
      note);
    host.replaceChildren(root);

    // ---- state: what is available, sizes ----------------------------------------------------------------------------------------------------
    function applyEnabled() {
      for (const b of buttons) {
        const off = !hasRig || (b.when ? !b.when() : false);
        b.el.disabled = off;
        if (busy && !off) b.el.setAttribute("aria-disabled", "true"); else b.el.removeAttribute("aria-disabled"); // busy: still focusable, the click is ignored
      }
      for (const c of [glbMeas, meshSkin, bvhNeutral, bvhHeader, csvHeader, imgGrid, imgShadow, postPlace, sceneAdd]) c.input.disabled = busy;
      glbScene.input.disabled = meshScene.input.disabled = busy || objects === 0; // nothing to include when the scene is empty
      glbScene.input.checked = opt.glbScene && objects > 0; meshScene.input.checked = opt.meshScene && objects > 0;
    }
    function refresh() {
      timer = 0;
      if (disposed) return;
      const rig = ctx.getRig(), profile = ctx.getProfile(), posture = ctx.state.posture;
      hasRig = !!rig;
      let sandbox = null, est = null;
      try { sandbox = peekSandbox(ctx); objects = X.visibleObjects(sandbox).length; if (rig) est = X.estimateSizes({ rig, sandbox }); } catch { objects = 0; }
      stateEl.replaceChildren(...(rig ? [h("b", {}, profile?.label ?? "Figure"), h("span", {}, `${posture?.name ?? "Neutral standing"} · ${objects} scene object${objects === 1 ? "" : "s"}${rig.skin ? "" : " · no skin (skeleton only)"}`)] : [h("span", {}, "Waiting for the figure to be built…")]));
      const verts = est ? X.skinnedMeshes(rig).reduce((n, m) => n + m.geometry.getAttribute("position").count, 0) : 0;
      qualityNote.hidden = !(rig && rig.quality === "low");
      qualityText.textContent = `The meshes follow the quality of the 3D view: now low, ${fmtInt(verts)} vertices. High gives about 2.5 times as many.`;
      glbScene.text.textContent = `Scene objects (${objects})`;
      meshScene.text.textContent = `Scene objects (${objects})`;
      glbFigure.el.querySelector('[data-value="skin"]').disabled = !rig?.skin;
      if (rig && !rig.skin && opt.glbFigure === "skin") { opt.glbFigure = "skeleton"; glbFigure.set("skeleton"); }
      const sceneOn = opt.glbScene && objects > 0;
      if (est) {
        const glb = (opt.glbFigure === "skin" ? est.glbSkin : opt.glbFigure === "skeleton" ? est.glbSkeleton : 0) + (sceneOn ? est.glbScene : 0);
        glbSize.textContent = `about ${X.formatBytes(glb)}`;
        const meshScenePart = opt.meshScene && objects > 0, figure = opt.meshSkin;
        objSize.textContent = `about ${X.formatBytes((figure ? est.obj : 0) + (meshScenePart ? est.objScene : 0))}`;
        stlSize.textContent = `about ${X.formatBytes((figure ? est.stl : 0) + (meshScenePart ? est.stlScene : 0))}`;
        jsonSize.textContent = `about ${X.formatBytes(est.json)}`;
      }
      applyEnabled();
      if (summaryOpen && visible) refreshSummary();
    }
    const mark = () => { if (visible && !timer && !disposed) timer = setTimeout(refresh, 120); };
    for (const evt of ["rig", "profile", "posture", "pose", "scene", "measure"]) offs.push(ctx.on(evt, mark));
    refresh();

    return {
      onShow() { visible = true; refresh(); },
      onHide() { visible = false; clearTimeout(timer); timer = 0; },
      dispose() {
        disposed = true;
        clearTimeout(timer);
        for (const f of offs) f();
        if (measureRef) releaseMeasure(ctx);
        if (sandboxRef) releaseSandbox(ctx);
        host.replaceChildren();
      },
    };
  },
};
