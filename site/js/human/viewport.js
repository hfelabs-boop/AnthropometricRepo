// The 3D viewport of the Digital human tab: renderer, camera, lights, floor, orbit controls, picking, gizmo, HTML label layer.
// API contract: docs/human3d/DESIGN.md 2.3b. It depends only on three; the shell (index.js) owns everything else.
//
// Rendering is ON DEMAND: nothing runs while nothing changes. requestRender() coalesces any number of calls into one
// requestAnimationFrame; OrbitControls' 'change' event requests a render; with damping the loop continues only until the inertia has
// died out (controls.update() stops dispatching 'change'). A camera move animation and nothing else owns a private frame loop,
// and it ends by itself. setActive(false) cancels all of it (tab hidden).
//
// The top of the file is PURE (no document/window): view presets, frame maths, click classification, label overlap reduction,
// CSS colour parsing, projection. They are unit-tested in Node (tests/human3d/viewport.test.mjs). Axes: +Y up, +Z anterior, +X is the
// figure's LEFT (so the "left" view looks at the figure from +X and the "front" view from +Z).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------------
// view presets
/** Camera directions as azimuth (degrees about +Y from +Z towards +X) and polar angle (degrees from +Y). */
export const VIEW_PRESETS = Object.freeze(Object.fromEntries(Object.entries({
  front: { label: "Front", title: "Front view", azimuth: 0, polar: 90 },
  back: { label: "Back", title: "Back view", azimuth: 180, polar: 90 },
  left: { label: "Left", title: "View of the figure's left side", azimuth: 90, polar: 90 },
  right: { label: "Right", title: "View of the figure's right side", azimuth: -90, polar: 90 },
  top: { label: "Top", title: "Top view", azimuth: 0, polar: 0.5 }, // not exactly 0: the up vector would be undefined
  iso: { label: "Iso", title: "Three-quarter view", azimuth: 35, polar: 68 },
}).map(([k, v]) => [k, Object.freeze(v)])));
export const VIEW_ORDER = Object.freeze(["front", "back", "left", "right", "top", "iso"]);

/** Unit vector from the target towards the camera for a preset name. */
export function viewDirection(name, out = new THREE.Vector3()) {
  const p = VIEW_PRESETS[name];
  if (!p) throw new RangeError(`unknown view "${name}" (use ${VIEW_ORDER.join(", ")})`);
  const a = p.azimuth * D2R, t = p.polar * D2R;
  return out.set(Math.sin(t) * Math.sin(a), Math.cos(t), Math.sin(t) * Math.cos(a));
}

/** Camera position of a preset: `target + direction * distance`. */
export function viewPosition(name, target, distance, out = new THREE.Vector3()) {
  return viewDirection(name, out).multiplyScalar(distance).add(target);
}

/**
 * Distance from the box centre to the camera at which a box with the given half extents (world axes) fits the view when seen along
 * `dir` (unit vector from the centre to the camera): exact for the box, every corner is inside and the tightest one touches the edge.
 * A corner at offset c lies at depth (c . dir) in front of the centre, so with the camera at distance d it needs
 * d - depth >= max(|c . right| / tanH, |c . up| / tanV). `margin` > 1 leaves room around it.
 */
export function frameDistance(half, dir, fovDeg, aspect, margin = 1.1) {
  const hx = Math.abs(half.x ?? half[0]), hy = Math.abs(half.y ?? half[1]), hz = Math.abs(half.z ?? half[2]);
  const d = new THREE.Vector3(dir.x ?? dir[0], dir.y ?? dir[1], dir.z ?? dir[2]).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(d); // camera right = up x (towards camera)
  if (right.lengthSq() < 1e-10) right.set(1, 0, 0); // looking straight down or up
  right.normalize();
  const up = new THREE.Vector3().crossVectors(d, right);
  const tanV = Math.tan(0.5 * fovDeg * D2R), tanH = tanV * Math.max(aspect, 1e-3);
  let need = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const cx = sx * hx, cy = sy * hy, cz = sz * hz;
    const depth = cx * d.x + cy * d.y + cz * d.z;
    const x = Math.abs(cx * right.x + cy * right.y + cz * right.z), y = Math.abs(cx * up.x + cy * up.y + cz * up.z);
    need = Math.max(need, depth + Math.max(x / tanH, y / tanV));
  }
  return need * margin;
}

// ---------------------------------------------------------------------------------------------------------------------
// pointer: click versus drag
/**
 * A click is a pointer-up within `maxDist` pixels of the pointer-down (so an orbit drag is not a click). There is no time limit by default:
 * a slow press, a long tap or a press with a tremor or a switch device is still a deliberate selection (`maxMs` stays available for callers
 * that want to tell a press-and-hold apart).
 */
export function isClick(down, up, { maxDist = 4, maxMs = Infinity } = {}) {
  if (!down || !up) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) <= maxDist && up.t - down.t <= maxMs && up.t >= down.t;
}

// ---------------------------------------------------------------------------------------------------------------------
// labels
/**
 * Placement for the HTML label layer. `items` are in priority order, each {x, y, w, h, ax?, ay?, pin?}: the label rectangle (top-left
 * x, y) and optionally its anchor point. Returns [{ keep, dy }] aligned with `items`.
 * An ordinary item is dropped when its rectangle (grown by `pad`) overlaps the rectangle of a kept item, or when its anchor lies within
 * `minDist` pixels of a kept anchor. A `pin`ned item (the selected joint, the names of its DOF arrows) is not subject to the anchor test,
 * and when its rectangle collides it is moved up or down (`dy`, in steps of one label height, at most `maxNudge` steps each way) to the
 * first free place instead of being dropped, so two pinned labels near one joint never overprint each other; it is dropped only when
 * there is no free place within reach. Kept items, nudged ones included, block the items after them.
 */
export function placeLabels(items, { minDist = 12, pad = 2, maxNudge = 3 } = {}) {
  const out = [];
  const kept = [];
  const md2 = minDist * minDist;
  const hit = (a, y, b) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && y < b.y + b.h + pad && y + a.h + pad > b.y;
  for (const a of items) {
    let dy = 0, ok = true;
    if (!a.pin) {
      for (const b of kept) {
        if (hit(a, a.y, b)) { ok = false; break; }
        if (a.ax != null && b.ax != null && (a.ax - b.ax) ** 2 + (a.ay - b.ay) ** 2 < md2) { ok = false; break; }
      }
    } else {
      const step = a.h + pad, tries = [0];
      for (let i = 1; i <= maxNudge; i++) tries.push(i * step, -i * step);
      ok = false;
      for (const d of tries) if (!kept.some((b) => hit(a, a.y + d, b))) { dy = d; ok = true; break; }
    }
    if (ok) kept.push({ ...a, y: a.y + dy });
    out.push({ keep: ok, dy: ok ? dy : 0 });
  }
  return out;
}
/** `placeLabels` reduced to the keep flags (booleans aligned with `items`). */
export function reduceLabelOverlap(items, opts) { return placeLabels(items, opts).map((r) => r.keep); }

/** True when every component of a Vector3-like ({x, y, z} or [x, y, z]) is a finite number. */
export function isFiniteVec(v) {
  if (!v) return false;
  const x = v.x ?? v[0], y = v.y ?? v[1], z = v.z ?? v[2];
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/** Screen position (CSS pixels in a w x h view) of a world point; `visible` is false behind the camera, beyond the far plane or off screen. */
export function projectPoint(camera, p, w, h, out = {}) {
  const v = _p.set(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]).applyMatrix4(camera.matrixWorldInverse);
  const depth = -v.z; // distance in front of the camera
  v.applyMatrix4(camera.projectionMatrix);
  out.x = (v.x * 0.5 + 0.5) * w;
  out.y = (-v.y * 0.5 + 0.5) * h;
  out.depth = depth;
  out.visible = depth > camera.near && depth < camera.far && v.x >= -1.02 && v.x <= 1.02 && v.y >= -1.02 && v.y <= 1.02;
  return out;
}
const _p = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------------------------------
// colours
/** CSS colour string -> [r, g, b] in 0..1 sRGB, or null. Handles #rgb, #rrggbb, rgb()/rgba() (comma or space syntax) and color(srgb r g b). */
export function parseCssColor(s) {
  if (typeof s !== "string") return null;
  s = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(\s*(-?[\d.]+)(%?)[\s,]+(-?[\d.]+)(%?)[\s,]+(-?[\d.]+)(%?)/.exec(s);
  if (m) return [[m[1], m[2]], [m[3], m[4]], [m[5], m[6]]].map(([v, pc]) => Math.min(1, Math.max(0, pc ? parseFloat(v) / 100 : parseFloat(v) / 255)));
  m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (m) return [1, 2, 3].map((i) => Math.min(1, Math.max(0, parseFloat(m[i]))));
  return null;
}

/** Relative luminance (WCAG) of an sRGB triple in 0..1. */
export function luminance([r, g, b]) {
  const f = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Light intensities that look right on a light and on a dark background (the materials are the same in both themes). */
export function lightPreset(dark) {
  return dark
    ? { hemi: 0.85, key: 2.3, fill: 0.5, head: 0.45, shadow: 0.5 }
    : { hemi: 1.1, key: 2.1, fill: 0.55, head: 0.4, shadow: 0.26 };
}

const THEME_VARS = { bg: "--bg", surface: "--surface", surface2: "--surface-2", line: "--line", lineStrong: "--line-strong", text: "--text", text3: "--text-3", accent: "--accent", good: "--good", bad: "--bad" };
const THEME_FALLBACK = {
  light: { bg: "#f6f6f4", surface: "#fcfcfb", surface2: "#f0efec", line: "#dddcd7", lineStrong: "#c4c3bd", text: "#0b0b0b", text3: "#75746f", accent: "#1c5cab", good: "#0f7a2e", bad: "#b3261e" },
  dark: { bg: "#121211", surface: "#1a1a19", surface2: "#232321", line: "#32322f", lineStrong: "#4a4a46", text: "#ffffff", text3: "#9a998f", accent: "#7fb0ff", good: "#5fd08a", bad: "#ff8a80" },
};

/** Resolve the site's CSS variables (as seen from `el`) into sRGB triples; falls back to the site's own defaults when a variable is missing. */
function readTheme(el) {
  const cs = getComputedStyle(el);
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;forced-color-adjust:none"; // authored colours even in forced-colors mode
  el.append(probe);
  const out = {};
  const prefersDark = !!globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches;
  try {
    for (const [k, name] of Object.entries(THEME_VARS)) {
      let rgb = null;
      if (cs.getPropertyValue(name).trim()) {
        probe.style.color = "";
        probe.style.color = `var(${name})`; // lets the browser resolve color-mix(), named colours, ...
        rgb = parseCssColor(getComputedStyle(probe).color);
      }
      out[k] = rgb;
    }
  } finally {
    probe.remove();
  }
  const dark = out.bg ? luminance(out.bg) < 0.25 : prefersDark;
  const fb = THEME_FALLBACK[dark ? "dark" : "light"];
  const theme = { dark };
  for (const k of Object.keys(THEME_VARS)) {
    const rgb = out[k] ?? parseCssColor(fb[k]);
    theme[k] = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    theme[k + "Css"] = "#" + theme[k].getHexString(THREE.SRGBColorSpace);
  }
  return theme;
}

// ---------------------------------------------------------------------------------------------------------------------
// floor grid: 1 m major lines, 0.1 m minor lines, faded with distance and when lines get denser than a few pixels
const GRID_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vXZ = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GRID_FRAG = /* glsl */ `
uniform vec3 uLine; uniform vec3 uFloor; uniform float uRadius; uniform float uMinor; uniform float uMajor; uniform float uDisc;
varying vec2 vXZ;
float lines(vec2 p, float size) {
  vec2 q = p / size;
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-6));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}
void main() {
  float r = length(vXZ);
  float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, r);
  float px = max(length(fwidth(vXZ)), 1e-6);      // metres per pixel
  float minorFade = smoothstep(3.0, 9.0, 0.1 / px); // cell size in pixels
  float majorFade = smoothstep(2.0, 6.0, 1.0 / px);
  float line = max(lines(vXZ, 0.1) * uMinor * minorFade, lines(vXZ, 1.0) * uMajor * majorFade) * fade;
  float disc = uDisc * (1.0 - smoothstep(uRadius * 0.15, uRadius * 0.9, r));
  float a = max(line, disc);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uFloor, uLine, clamp(line / a, 0.0, 1.0)), a);
  #include <colorspace_fragment>
}`;

function makeGrid(radius = 12) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uLine: { value: new THREE.Color() }, uFloor: { value: new THREE.Color() }, uRadius: { value: radius }, uMinor: { value: 0.35 }, uMajor: { value: 0.75 }, uDisc: { value: 0.7 } },
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), mat);
  m.position.y = 0.0004; // above the shadow catcher
  m.renderOrder = -2;
  m.name = "hm-grid";
  m.raycast = () => {}; // never a pick target
  return m;
}

function makeAxes() {
  const g = new THREE.Group();
  g.name = "hm-axes";
  const len = 0.3, shaft = new THREE.CylinderGeometry(0.004, 0.004, len, 8).translate(0, len / 2, 0), tip = new THREE.ConeGeometry(0.012, 0.045, 12).translate(0, len + 0.0225, 0);
  const axes = { x: [0, 0, -Math.PI / 2], y: [0, 0, 0], z: [Math.PI / 2, 0, 0] };
  for (const [k, rot] of Object.entries(axes)) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const arrow = new THREE.Group();
    arrow.name = "axis-" + k;
    arrow.add(new THREE.Mesh(shaft, mat), new THREE.Mesh(tip, mat));
    arrow.rotation.set(...rot);
    arrow.userData.material = mat;
    g.add(arrow);
  }
  g.traverse((o) => { o.raycast = () => {}; });
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
const reduced = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerpAngle = (a, b, t) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function disposeMaterial(m) {
  if (!m) return;
  for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
  if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) u.value.dispose();
  m.dispose();
}
function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach(disposeMaterial); else disposeMaterial(o.material);
    o.skeleton?.dispose?.();
  });
}

/**
 * createViewport(container, options) -> Viewport (see DESIGN.md 2.3b). `container` must have a size (the shell gives it one);
 * options: { quality: "high" | "low", pixelRatioMax = 2, grid = true, keyboard = true, label }.
 * Extras beyond the contract: ray(), setPickTargets(), addLabelSource()/removeLabelSource(), setGrid(), setQuality(), info(),
 * getView(), zoomBy(), setCursor(), the 'render' / 'resize' / 'view-change' / 'theme' / 'click-unhandled' events.
 * setView() / frame() / moveTo() return a promise that always settles: true when the camera arrived, false when the move was interrupted.
 */
export function createViewport(container, options = {}) {
  const opts = { quality: "high", pixelRatioMax: 2, grid: true, keyboard: true, label: "3D view of the digital human. Drag to orbit, right-drag or arrow keys to pan, Shift and arrow keys to orbit, scroll, pinch or plus and minus keys to zoom.", ...options };
  let quality = opts.quality === "low" ? "low" : "high";
  let active = true, disposed = false, lost = false, frameId = 0, dirty = false;
  let renderer = null, controls = null, gizmo = null, canvas = null, msgEl = null;
  let theme = null, gridOn = !!opts.grid, anim = null;
  const size = { w: 0, h: 0, dpr: 0 };
  const listeners = new Map();
  const disposers = [];
  const sources = new Map(), labelEls = new Map(), shownLabels = [];
  let pickTargets = [];
  let cursor = "";
  let gizmoState = null; // { object, opts }: re-attached when the renderer is rebuilt

  container.classList.add("hm-viewport"); // human.css positions it; the inline fallback below is for pages without that stylesheet
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  container.style.isolation = "isolate"; // own stacking context: the message and overlay z-indices stay below the shell's toolbars (z-index 2)

  // ---- scene -------------------------------------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.name = "hm-scene";
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 120);
  const HOME_TARGET = new THREE.Vector3(0, 0.9, 0);
  camera.position.copy(viewPosition("iso", HOME_TARGET, 4.2));
  camera.lookAt(HOME_TARGET);
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(2.5, 5, 3.5);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -2.6, right: 2.6, top: 2.6, bottom: -2.6, near: 0.5, far: 16 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.015;
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-3, 2.5, -3.5);
  const head = new THREE.DirectionalLight(0xffffff, 0.4); // follows the camera, so no side of the figure is ever unlit
  camera.add(head);
  head.position.set(0.5, 0.8, 0.4);
  head.target = new THREE.Object3D();
  scene.add(hemi, key, key.target, fill, head.target);
  const lights = { hemi, key, fill, head };

  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.3, transparent: true, depthWrite: false });
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), shadowMat);
  shadowPlane.receiveShadow = true;
  shadowPlane.renderOrder = -3;
  shadowPlane.name = "hm-shadow-catcher";
  shadowPlane.raycast = () => {};
  const grid = makeGrid();
  const axes = makeAxes();
  const floor = new THREE.Group();
  floor.name = "hm-floor";
  floor.add(shadowPlane, grid, axes);
  scene.add(floor);

  const overlay = document.createElement("div");
  overlay.className = "hm-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none";
  container.append(overlay);

  // ---- events --------------------------------------------------------------------------------------------------------
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }
  function off(type, fn) { listeners.get(type)?.delete(fn); }
  function emit(type, ev = {}) {
    const set = listeners.get(type);
    if (!set) return ev;
    for (const fn of [...set]) {
      try { fn(ev); } catch (e) { console.error(`viewport "${type}" listener failed:`, e); }
    }
    return ev;
  }

  // ---- rendering -----------------------------------------------------------------------------------------------------
  function requestRender() {
    if (disposed || lost || !renderer) return;
    dirty = true;
    if (!active || frameId) return;
    frameId = requestAnimationFrame(onFrame);
  }
  function onFrame() {
    frameId = 0;
    if (!active || disposed || lost || !renderer) return;
    renderNow();
  }
  function renderNow() {
    if (!renderer || disposed || lost) return;
    dirty = false;
    controls.update(); // applies damping; dispatches 'change' (-> requestRender) only while the camera is still moving
    head.target.position.copy(controls.target);
    renderer.render(scene, camera);
    updateLabels();
    emit("render", {});
  }

  function resize() {
    if (!renderer || disposed) return false;
    const w = container.clientWidth, h = container.clientHeight;
    if (w < 2 || h < 2) return false; // hidden tab: keep the last size
    const dpr = quality === "low" ? 1 : Math.min(globalThis.devicePixelRatio || 1, opts.pixelRatioMax);
    if (w === size.w && h === size.h && dpr === size.dpr) return false;
    size.w = w; size.h = h; size.dpr = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    emit("resize", { width: w, height: h });
    requestRender();
    return true;
  }

  // ---- WebGL lifecycle -----------------------------------------------------------------------------------------------
  function showMessage(text, retry = true) {
    hideMessage();
    msgEl = document.createElement("div");
    msgEl.className = "hm-vp-msg";
    msgEl.setAttribute("role", "alert");
    msgEl.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;z-index:5";
    const p = document.createElement("p");
    p.textContent = text;
    msgEl.append(p);
    if (retry) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = "Retry";
      b.addEventListener("click", () => rebuild());
      msgEl.append(b);
    }
    container.append(msgEl);
  }
  function hideMessage() { msgEl?.remove(); msgEl = null; }

  function onContextLost(e) {
    e.preventDefault(); // allows the browser to restore the context
    lost = true;
    if (frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    showMessage("The 3D display was interrupted (the graphics context was lost). It may recover by itself; press Retry to rebuild it now.");
    emit("context-lost", {});
  }
  function onContextRestored() {
    lost = false;
    hideMessage();
    size.w = 0; // force a fresh setSize
    resize();
    requestRender();
    emit("context-restored", {});
  }

  function initGL() {
    let r;
    try {
      r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (e) {
      showMessage(`This browser could not start WebGL, which the 3D view needs (${e?.message || e}). Check that hardware acceleration is on, or try another browser.`);
      return false;
    }
    renderer = r;
    canvas = r.domElement;
    canvas.className = "hm-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", opts.label);
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none"; // no inline outline: human.css draws the :focus-visible ring (an inline outline:none would beat it)
    if (cursor) canvas.style.cursor = cursor;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    applyQualityToRenderer();
    container.insertBefore(canvas, container.firstChild);

    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { capture: true, passive: true }); // capture: runs before OrbitControls' own wheel handler
    canvas.addEventListener("keydown", onKeyDown);

    controls = new OrbitControls(camera, canvas);
    controls.target.copy(anim?.to?.target ?? savedTarget ?? HOME_TARGET);
    controls.enableDamping = !reduced();
    controls.dampingFactor = 0.14;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.4;
    controls.maxDistance = 12;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 100 * D2R; // a little below the horizon: the floor is see-through
    controls.keyPanSpeed = 12;
    controls.keyRotateSpeed = 6; // the default (1) turns the view by under half a degree per key press
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    if (opts.keyboard) controls.listenToKeyEvents(canvas);
    controls.addEventListener("change", onControlsChange);
    controls.enabled = active;
    controls.update();
    return true;
  }

  let savedTarget = null;
  const PAN_MIN = new THREE.Vector3(-6, 0, -6), PAN_MAX = new THREE.Vector3(6, 3, 6);
  function onControlsChange() {
    // keep the target near the figure: a stray pan must never lose it (the camera moves with the target, as in a pan)
    const t = controls.target;
    if (t.x < PAN_MIN.x || t.x > PAN_MAX.x || t.y < PAN_MIN.y || t.y > PAN_MAX.y || t.z < PAN_MIN.z || t.z > PAN_MAX.z) {
      const c = _t.copy(t).clamp(PAN_MIN, PAN_MAX), d = c.sub(t);
      t.add(d); camera.position.add(d);
    }
    requestRender();
  }
  const _t = new THREE.Vector3();

  // keyboard zoom: OrbitControls' keyboard mode only pans and rotates, and WCAG 2.1.1 wants every pointer operation to have a key equivalent
  const KEY_ZOOM = { "+": 1, "=": 1, Add: 1, PageUp: 1, "-": -1, _: -1, Subtract: -1, PageDown: -1 };
  const KEY_STEP = 0.85;
  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !controls || !controls.enabled) return;
    const dir = KEY_ZOOM[e.key];
    if (!dir) return;
    e.preventDefault(); // PageUp / PageDown would scroll the page
    zoomBy(dir > 0 ? KEY_STEP : 1 / KEY_STEP);
  }
  /** Multiply the camera distance by `factor` (< 1 zooms in) about the orbit target, within the zoom limits. Returns the new distance. */
  function zoomBy(factor) {
    if (!controls || !(factor > 0) || !Number.isFinite(factor)) return currentDistance();
    cancelAnim();
    const off = _z.copy(camera.position).sub(controls.target);
    const d = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * factor));
    camera.position.copy(controls.target).addScaledVector(off.normalize(), d);
    controls.update();
    requestRender();
    emit("view-change", getView());
    return d;
  }
  const _z = new THREE.Vector3();

  // The wheel zooms the view (the convention of every 3D viewer). Once the zoom has hit its limit in the wheel's direction the event is not
  // handed to OrbitControls (which would swallow it), so the page scrolls on instead of staying stuck under the pointer.
  function onWheel(e) {
    cancelAnim();
    if (!controls || !controls.enabled) return;
    const d = currentDistance(), eps = 1e-3;
    if ((e.deltaY > 0 && d >= controls.maxDistance - eps) || (e.deltaY < 0 && d <= controls.minDistance + eps)) e.stopImmediatePropagation();
  }

  function teardownGL() {
    if (!renderer) return;
    savedTarget = controls ? controls.target.clone() : null;
    cancelAnim();
    if (frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    detachGizmoObject();
    if (gizmo) {
      scene.remove(gizmo.getHelper());
      gizmo.dispose();
      gizmo = null;
    }
    controls?.removeEventListener("change", onControlsChange);
    controls?.dispose();
    controls = null;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    for (const [t, f] of [["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerUp], ["pointercancel", onPointerCancel], ["pointerleave", onPointerLeave], ["dblclick", onDblClick], ["keydown", onKeyDown]]) canvas.removeEventListener(t, f);
    canvas.removeEventListener("wheel", onWheel, { capture: true });
    renderer.dispose();
    // forceContextLoss on a context that is already lost makes three log a warning, so it is skipped then
    let gone = lost;
    try { gone ||= !!renderer.getContext()?.isContextLost?.(); } catch { gone = true; }
    if (!gone) { try { renderer.forceContextLoss(); } catch { /* not supported */ } }
    canvas.remove();
    renderer = null;
    canvas = null;
    size.w = size.h = size.dpr = 0;
  }

  /** Rebuild the renderer from scratch (Retry button). Scene content survives; its GPU resources are re-uploaded. */
  function rebuild() {
    if (disposed) return;
    teardownGL();
    lost = false;
    hideMessage();
    if (initGL()) {
      scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
      resize();
      applyTheme();
      if (gizmoState?.object?.parent) attachGizmo(gizmoState.object, gizmoState.opts);
      emit("context-restored", {});
    }
  }

  function applyQualityToRenderer() {
    if (!renderer) return;
    const high = quality === "high";
    renderer.shadowMap.type = high ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    key.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    key.shadow.map?.dispose();
    key.shadow.map = null;
    scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
  }
  function setQuality(q) {
    q = q === "low" ? "low" : "high";
    if (q === quality) return;
    quality = q;
    applyQualityToRenderer();
    size.dpr = 0; // re-apply the pixel ratio
    resize();
    requestRender();
  }

  // ---- theme ---------------------------------------------------------------------------------------------------------
  function applyTheme() {
    theme = readTheme(container);
    scene.background = theme.surface2.clone();
    grid.material.uniforms.uLine.value.copy(theme.lineStrong);
    grid.material.uniforms.uFloor.value.copy(theme.surface);
    axes.children[0].userData.material.color.copy(theme.bad);
    axes.children[1].userData.material.color.copy(theme.good);
    axes.children[2].userData.material.color.copy(theme.accent);
    const p = lightPreset(theme.dark);
    hemi.intensity = p.hemi; key.intensity = p.key; fill.intensity = p.fill; head.intensity = p.head;
    hemi.groundColor.copy(theme.surface2).multiplyScalar(theme.dark ? 1.4 : 0.55);
    shadowMat.opacity = p.shadow;
    container.style.setProperty("--hm-vp-bg", theme.surface2Css);
    requestRender();
    emit("theme", { theme });
    return theme;
  }
  function setTheme() { return applyTheme(); }

  // ---- camera --------------------------------------------------------------------------------------------------------
  // The promise of a camera move always settles: true when the camera got where it was going, false when the move was interrupted (the user
  // grabbed the view, a newer move replaced it, the renderer was torn down). A panel that awaits setView()/frame() must never hang.
  function cancelAnim() {
    if (!anim) return;
    const a = anim;
    anim = null;
    cancelAnimationFrame(a.id);
    a.resolve(false);
  }
  function finishAnim() {
    if (!anim) return;
    const a = anim;
    cancelAnimationFrame(a.id);
    anim = null;
    camera.position.copy(a.to.position);
    controls.target.copy(a.to.target);
    controls.update();
    requestRender();
    a.resolve(true);
    emit("view-change", getView());
  }

  /**
   * Move the camera to `position`/`target`, animated (an orbit about the target, not a straight line through the figure) unless reduced motion.
   * A non-finite position or target is ignored: one NaN would be copied into the camera and the controls and the view would stay blank for good.
   * Returns a promise of whether the camera arrived (see cancelAnim).
   */
  function moveTo(position, target, { animate = true, ms = 420 } = {}) {
    if (!isFiniteVec(position) || !isFiniteVec(target)) return Promise.resolve(false);
    position = new THREE.Vector3(position.x ?? position[0], position.y ?? position[1], position.z ?? position[2]); // also accepts [x, y, z] and plain objects
    target = new THREE.Vector3(target.x ?? target[0], target.y ?? target[1], target.z ?? target[2]);
    if (!controls) { camera.position.copy(position); savedTarget = target.clone(); camera.lookAt(target); return Promise.resolve(true); }
    cancelAnim();
    const to = { position: position.clone(), target: target.clone() };
    if (!animate || reduced() || !active) {
      camera.position.copy(to.position);
      controls.target.copy(to.target);
      controls.update();
      requestRender();
      emit("view-change", getView());
      return Promise.resolve(true);
    }
    const fromT = controls.target.clone();
    const so = new THREE.Spherical().setFromVector3(camera.position.clone().sub(fromT));
    const eo = new THREE.Spherical().setFromVector3(to.position.clone().sub(to.target));
    const t0 = performance.now();
    return new Promise((resolve) => {
      const a = { to, resolve, id: 0 };
      const step = () => {
        if (anim !== a) return;
        const k = Math.min(1, (performance.now() - t0) / ms), e = ease(k);
        controls.target.lerpVectors(fromT, to.target, e);
        const s = new THREE.Spherical(so.radius + (eo.radius - so.radius) * e, so.phi + (eo.phi - so.phi) * e, lerpAngle(so.theta, eo.theta, e));
        camera.position.setFromSpherical(s.makeSafe()).add(controls.target);
        controls.update();
        renderNow();
        if (k >= 1) { anim = null; resolve(true); emit("view-change", getView()); } else a.id = requestAnimationFrame(step);
      };
      anim = a;
      a.id = requestAnimationFrame(step);
    });
  }

  function currentDistance() { return camera.position.distanceTo(controls ? controls.target : HOME_TARGET); }
  function getView() {
    const t = controls ? controls.target : HOME_TARGET, s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(t));
    return { position: camera.position.clone(), target: t.clone(), distance: s.radius, azimuth: s.theta / D2R, polar: s.phi / D2R };
  }

  /** Orbit to a preset about the current target, keeping the distance. */
  function setView(name, { animate = true, distance } = {}) {
    const t = controls ? controls.target.clone() : HOME_TARGET.clone();
    return moveTo(viewPosition(name, t, Number.isFinite(distance) && distance > 0 ? distance : currentDistance()), t, { animate });
  }

  function boxOf(objOrBox) {
    if (objOrBox && objOrBox.isBox3) return objOrBox.clone();
    if (objOrBox && objOrBox.isObject3D) { objOrBox.updateWorldMatrix(true, true); return new THREE.Box3().setFromObject(objOrBox); }
    if (objOrBox && objOrBox.min && objOrBox.max) return new THREE.Box3(new THREE.Vector3().copy(objOrBox.min), new THREE.Vector3().copy(objOrBox.max));
    return new THREE.Box3();
  }
  /** Fit a Box3 or Object3D in view along the current direction (or `view`), with margin. */
  function frame(objectOrBox, { animate = true, margin = 1.12, view } = {}) {
    const box = boxOf(objectOrBox);
    // Box3.isEmpty() is false for a box with NaN (every comparison is false) or an infinite extent: both would wedge the camera
    if (box.isEmpty() || !isFiniteVec(box.min) || !isFiniteVec(box.max)) return Promise.resolve(false);
    const center = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const dir = view ? viewDirection(view) : camera.position.clone().sub(controls ? controls.target : HOME_TARGET).normalize();
    if (!(dir.lengthSq() > 0.5)) dir.copy(viewDirection("iso"));
    const fd = frameDistance(half, dir, camera.fov, camera.aspect, margin);
    const dist = Math.min(controls ? controls.maxDistance : 12, Math.max(controls ? controls.minDistance : 0.4, Number.isFinite(fd) ? fd : currentDistance())); // a NaN margin must not reach the camera
    return moveTo(center.clone().addScaledVector(dir, dist), center, { animate });
  }

  // ---- picking and projection ------------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line.threshold = 0.01;
  raycaster.params.Points.threshold = 0.01;
  const ndc = new THREE.Vector2();
  /** The (shared) raycaster through a client position; valid until the next call. For rig.pickJoint(raycaster) and friends. */
  function ray(clientX, clientY) {
    const r = (canvas ?? container).getBoundingClientRect();
    ndc.set(((clientX - r.left) / Math.max(r.width, 1)) * 2 - 1, -((clientY - r.top) / Math.max(r.height, 1)) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
  }
  function pick(clientX, clientY, targets, recursive = true) {
    if (!renderer) return [];
    const list = (Array.isArray(targets) ? targets : targets ? [targets] : []).filter(Boolean);
    return list.length ? ray(clientX, clientY).intersectObjects(list, recursive) : [];
  }
  function project(v, out = {}) {
    camera.updateMatrixWorld();
    return projectPoint(camera, v, size.w || container.clientWidth, size.h || container.clientHeight, out);
  }
  const targetsNow = () => (typeof pickTargets === "function" ? pickTargets() : pickTargets) || [];

  // ---- pointer events --------------------------------------------------------------------------------------------------
  let down = null, gizmoTouched = false;
  const pointers = new Set();
  function mkEvent(type, e) {
    const r = canvas.getBoundingClientRect();
    const ev = { type, clientX: e.clientX, clientY: e.clientY, x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, buttons: e.buttons,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pointerType: e.pointerType, originalEvent: e, handled: false };
    let hit; // computed on first use: most listeners do not need it
    Object.defineProperty(ev, "hit", { enumerable: true, get() { if (hit === undefined) hit = pick(e.clientX, e.clientY, targetsNow())[0] ?? null; return hit; } });
    return ev;
  }
  function onPointerDown(e) {
    cancelAnim();
    pointers.add(e.pointerId);
    gizmoTouched = false;
    if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, t: e.timeStamp, button: e.button, id: e.pointerId };
    else if (down) down.multi = true; // a pinch or two-finger pan is never a click
    emit("pointerdown", mkEvent("pointerdown", e));
  }
  function onPointerMove(e) { emit("pointermove", mkEvent("pointermove", e)); }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    const ev = mkEvent("pointerup", e);
    emit("pointerup", ev);
    const d = down;
    if (d && d.id === e.pointerId) {
      down = null;
      if (d.button === 0 && !d.multi && !gizmoTouched && isClick(d, { x: e.clientX, y: e.clientY, t: e.timeStamp })) {
        const c = mkEvent("click", e);
        emit("click", c);
        if (!c.handled) emit("click-unhandled", c);
      }
    }
  }
  function onPointerCancel(e) { pointers.delete(e.pointerId); down = null; }
  function onPointerLeave(e) { emit("pointerleave", mkEvent("pointerleave", e)); }
  function onDblClick(e) { emit("dblclick", mkEvent("dblclick", e)); }
  function setCursor(c) { cursor = c || ""; if (canvas) canvas.style.cursor = cursor; }
  function setPickTargets(t) { pickTargets = t || []; }

  // ---- gizmo -----------------------------------------------------------------------------------------------------------
  function ensureGizmo() {
    if (gizmo || !renderer) return gizmo;
    gizmo = new TransformControls(camera, canvas);
    gizmo.setSize(0.8);
    scene.add(gizmo.getHelper());
    gizmo.addEventListener("change", requestRender);
    gizmo.addEventListener("dragging-changed", (e) => {
      if (controls) controls.enabled = !e.value && active; // orbit is suspended while dragging
      if (e.value) gizmoTouched = true;
      emit(e.value ? "gizmo-start" : "gizmo-end", { object: gizmo.object, mode: gizmo.mode, space: gizmo.space });
    });
    gizmo.addEventListener("objectChange", () => emit("gizmo-change", { object: gizmo.object, mode: gizmo.mode, space: gizmo.space }));
    return gizmo;
  }
  function setGizmoOptions({ mode, space, snap, size: sz } = {}) {
    if (!gizmo) return;
    if (mode) gizmo.setMode(mode);
    if (space) gizmo.setSpace(space);
    if (sz != null) gizmo.setSize(sz);
    if (snap !== undefined) {
      const s = snap || {};
      gizmo.setTranslationSnap(s.translate ?? null);
      gizmo.setRotationSnap(s.rotate != null ? s.rotate * D2R : null);
      gizmo.setScaleSnap(s.scale ?? null);
    }
    requestRender();
  }
  /** Attach the transform gizmo to an object. snap: { translate: metres, rotate: degrees, scale: step } (null/omitted = free). */
  function attachGizmo(object, o = {}) {
    gizmoState = { object, opts: o };
    if (!ensureGizmo()) return null;
    gizmo.attach(object);
    setGizmoOptions({ mode: o.mode ?? "translate", space: o.space ?? "world", snap: o.snap ?? null, size: o.size });
    return gizmo;
  }
  function detachGizmoObject() { if (gizmo?.object) gizmo.detach(); }
  function detachGizmo() { gizmoState = null; detachGizmoObject(); requestRender(); }

  // ---- labels ----------------------------------------------------------------------------------------------------------
  function addLabelSource(keyName, fn) { sources.set(keyName, fn); requestRender(); return () => removeLabelSource(keyName); }
  function removeLabelSource(keyName) { sources.delete(keyName); requestRender(); }
  const warned = new Set();
  const pr = {};
  function updateLabels() {
    if (!sources.size && !labelEls.size) return;
    const cand = [];
    camera.updateMatrixWorld();
    for (const [src, fn] of sources) {
      let items;
      try { items = fn(); } catch (e) { if (!warned.has(src)) { warned.add(src); console.error(`label source "${src}" failed:`, e); } continue; }
      for (const it of items || []) {
        if (!it || !it.position || !it.text) continue;
        projectPoint(camera, it.position, size.w, size.h, pr);
        if (!pr.visible) continue;
        cand.push({ k: src + "\u0000" + it.id, it, x: pr.x, y: pr.y, depth: pr.depth });
      }
    }
    // important labels first, then the nearer ones: the far side of the body loses its labels first
    cand.sort((a, b) => (b.it.priority || 0) - (a.it.priority || 0) || a.depth - b.depth);
    const rects = cand.map((c) => {
      const w = Math.min(220, c.it.text.length * 6.3 + 12), h = 18;
      // a label that would run past the right edge goes to the left of its anchor instead (it would be clipped, e.g. "1 m" on a phone)
      c.flip = c.x + 7 + w > size.w - 2 && c.x - 7 - w >= 2;
      return { x: c.flip ? c.x - 7 - w : c.x + 7, y: c.y - h / 2, w, h, ax: c.x, ay: c.y, pin: (c.it.priority || 0) >= 100 };
    });
    const placed = placeLabels(rects, { minDist: 12 });
    const seen = new Set();
    shownLabels.length = 0;
    cand.forEach((c, i) => {
      if (!placed[i].keep) return;
      const dy = placed[i].dy; // pinned labels that would overprint another one are moved a label height up or down
      let el = labelEls.get(c.k);
      if (!el) {
        el = document.createElement("div");
        el.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;will-change:transform";
        overlay.append(el);
        labelEls.set(c.k, el);
      }
      const cls = "hm-label" + (c.it.cls ? " " + c.it.cls : "") + (c.flip ? " hm-label-flip" : "");
      if (el._c !== cls) { el.className = cls; el._c = cls; }
      if (el._t !== c.it.text) { el.textContent = c.it.text; el._t = c.it.text; }
      const col = c.it.color == null ? "" : typeof c.it.color === "number" ? "#" + c.it.color.toString(16).padStart(6, "0") : String(c.it.color); // a hex number or a CSS colour
      if (el._k !== col) { if (col) el.style.setProperty("--hm-label-accent", col); else el.style.removeProperty("--hm-label-accent"); el._k = col; }
      if (el._h !== c.it.title) { if (c.it.title) el.title = c.it.title; else el.removeAttribute("title"); el._h = c.it.title; }
      el.style.transform = `translate(${Math.round(c.x * 2) / 2}px, ${Math.round((c.y + dy) * 2) / 2}px)`;
      seen.add(c.k);
      shownLabels.push({ text: c.it.text, x: c.x, y: c.y + dy, cls: c.it.cls || "", flip: !!c.flip });
    });
    for (const [k, el] of labelEls) if (!seen.has(k)) { el.remove(); labelEls.delete(k); }
  }

  // ---- misc API --------------------------------------------------------------------------------------------------------
  function add(obj) { if (obj?.isObject3D) scene.add(obj); requestRender(); return obj; } // anything else is ignored: three would log an error for it
  function remove(obj) { scene.remove(obj); requestRender(); return obj; }

  function setActive(v) {
    v = !!v;
    if (v === active) return;
    active = v;
    if (!v) {
      if (frameId) { cancelAnimationFrame(frameId); frameId = 0; }
      finishAnim();
      if (controls) controls.enabled = false;
      if (gizmo) gizmo.enabled = false;
    } else {
      if (controls) controls.enabled = !gizmo?.dragging;
      if (gizmo) gizmo.enabled = true;
      resize();
      requestRender();
    }
    emit("active", { active });
  }
  function setGrid(v) {
    gridOn = !!v;
    grid.visible = gridOn;
    axes.visible = gridOn;
    requestRender();
  }
  // axis names and a scale along +X and +Z (the grid is 1 m / 0.1 m): lowest priority, so any other label wins a collision
  const SCALE = [1, 2].flatMap((m) => [{ id: `x${m}`, text: `${m} m`, position: [m, 0.01, 0] }, { id: `z${m}`, text: `${m} m`, position: [0, 0.01, m] }]);
  sources.set("viewport:axes", () => (!gridOn ? [] : [
    { id: "x", text: "X (left)", position: [0.36, 0.01, 0], cls: "hm-label-axis", priority: -1 },
    { id: "y", text: "Y (up)", position: [0, 0.36, 0], cls: "hm-label-axis", priority: -1 },
    { id: "z", text: "Z (front)", position: [0, 0.01, 0.36], cls: "hm-label-axis", priority: -1 },
    ...SCALE.map((t) => ({ ...t, cls: "hm-label-axis", priority: -2 })),
  ]));

  /** PNG data URL of the current view. `labels` (default true) also draws the HTML labels that are on screen. */
  function screenshot({ labels = true } = {}) {
    if (!renderer || lost) return null;
    renderNow(); // toDataURL must run in the same task as the render (no preserveDrawingBuffer)
    if (!labels || !shownLabels.length) return canvas.toDataURL("image/png");
    const c2 = document.createElement("canvas");
    c2.width = canvas.width; c2.height = canvas.height;
    const g = c2.getContext("2d");
    g.drawImage(canvas, 0, 0);
    const k = canvas.width / Math.max(size.w, 1), fs = 11 * k;
    g.font = `${fs}px ${getComputedStyle(container).fontFamily || "sans-serif"}`;
    g.textBaseline = "middle";
    for (const l of shownLabels) {
      const w = g.measureText(l.text).width + 10 * k, x = l.flip ? (l.x - 7) * k - w : (l.x + 7) * k, y = l.y * k;
      g.fillStyle = theme.surfaceCss; g.globalAlpha = 0.85;
      g.fillRect(x, y - 9 * k, w, 18 * k);
      g.globalAlpha = 1;
      g.fillStyle = l.cls.includes("axis") ? theme.text3Css : theme.textCss;
      g.fillText(l.text, x + 5 * k, y);
    }
    return c2.toDataURL("image/png");
  }

  function info() {
    const out = { webgl: 0, renderer: "", software: false, quality, pixelRatio: size.dpr, width: size.w, height: size.h, calls: 0, triangles: 0, failed: !renderer, lost };
    if (!renderer) return out;
    try {
      const gl = renderer.getContext();
      out.webgl = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? 2 : 1;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || "");
    } catch { /* privacy settings can hide the renderer name */ }
    out.software = SOFTWARE_GL.test(out.renderer);
    out.calls = renderer.info.render.calls;
    out.triangles = renderer.info.render.triangles;
    return out;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    teardownGL();
    hideMessage();
    for (const d of disposers.splice(0)) d();
    disposeTree(scene);
    scene.clear();
    for (const el of labelEls.values()) el.remove();
    labelEls.clear();
    sources.clear();
    overlay.remove();
    listeners.clear();
    container.classList.remove("hm-viewport");
  }

  // ---- go --------------------------------------------------------------------------------------------------------------
  try { // a failure halfway must not leave a renderer, observers or listeners behind
    grid.visible = gridOn;
    axes.visible = gridOn;
    applyTheme();
    initGL();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => resize());
      ro.observe(container);
      disposers.push(() => ro.disconnect());
    }
    window.addEventListener("resize", resize); // also fires when the page moves to a screen with another pixel ratio
    disposers.push(() => window.removeEventListener("resize", resize));
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq) {
      const f = () => { if (controls) controls.enableDamping = !mq.matches; };
      mq.addEventListener?.("change", f);
      disposers.push(() => mq.removeEventListener?.("change", f));
    }
    resize();
    requestRender();
  } catch (e) {
    try { dispose(); } catch { /* best effort */ }
    throw e;
  }

  const api = {
    scene, camera, lights, floor, overlay, container,
    get renderer() { return renderer; },
    get controls() { return controls; },
    get canvas() { return canvas; },
    get theme() { return theme; },
    get gizmo() { return gizmo; },
    get active() { return active; },
    get failed() { return !renderer; },
    get quality() { return quality; },
    add, remove, requestRender, renderNow, setActive, setView, frame, getView, moveTo, zoomBy, pick, ray, project, setPickTargets,
    on, off, attachGizmo, detachGizmo, setGizmoOptions, setTheme, setQuality, setGrid, setCursor, screenshot, resize, info, rebuild, dispose,
    addLabelSource, removeLabelSource,
    get gridVisible() { return gridOn; },
    get gizmoDragging() { return !!gizmo?.dragging; },
  };
  return api;
}
