// Floating boxes over the 3D view (the help, the verdict chips, the RULA / REBA and line-of-sight legends, the notices) get a title bar with a grip that
// moves them and a button that minimises them to the bar, so none of them hides the part of the figure you need to see. No other module needed.
//
//   makeFloating(el, { key, title, storage }) -> { body, bar, setMinimized(bool), minimized, reset(), refresh(), dispose() }
//     el       an absolutely positioned element; its children move into `body` (render into body from then on, not into el)
//     key      where the position and the minimised state are remembered (localStorage "hm-float:<key>"); null: not remembered
//   Drag the grip (mouse, pen or touch), or focus it and use the arrow keys (Shift: 5 times further); Home or a double-click puts the box back.
//   The box is kept inside its offset parent (all of it when it fits), also when either is resized. Where the stylesheet takes the box out of absolute positioning (a narrow
//   stage stacks it in the flow), moving is off and only minimising works.
import { h } from "../util.js";

const STEP = 10;
let raised = 0;
const GRIP = "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"; // six dots
const svg = (d, size = 14) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.6"); s.setAttribute("stroke-linecap", "round");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p);
  return s;
};
const ICON = { min: "M6 12h12", max: "M6 12h12M12 6v12" };

function load(storage, key) {
  if (!key || !storage) return null;
  try { const v = JSON.parse(storage.getItem(`hm-float:${key}`) ?? "null"); return v && typeof v === "object" ? v : null; } catch { return null; }
}
function save(storage, key, v) {
  if (!key || !storage) return;
  try { storage.setItem(`hm-float:${key}`, JSON.stringify(v)); } catch { /* private window, quota: the box still works, it is just not remembered */ }
}
const defaultStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function makeFloating(el, { key = null, title = "", storage = defaultStorage(), extra = [] } = {}) {
  const body = h("div", { class: "hm-float-body" });
  body.append(...el.childNodes);
  const grip = h("button", { type: "button", class: "hm-float-grip", title: `Move: drag, or use the arrow keys. Double-click or Home puts it back`, "aria-label": `Move ${title}` }, svg(GRIP));
  const minBtn = h("button", { type: "button", class: "hm-float-min", "aria-expanded": "true" });
  const label = h("span", { class: "hm-float-title" }, title);
  const bar = h("div", { class: "hm-float-bar" }, grip, label, minBtn, ...extra);
  el.classList.add("hm-float");
  el.prepend(bar);
  el.append(body);

  const saved = load(storage, key) ?? {};
  let pos = Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : null, minimized = !!saved.min;
  const movable = () => getComputedStyle(el).position === "absolute" && !!el.offsetParent;
  const persist = () => save(storage, key, { ...(pos ?? {}), min: minimized });

  function place() {
    if (!pos || !movable()) { el.style.left = el.style.top = el.style.right = el.style.bottom = ""; return; }
    const parent = el.offsetParent, maxX = Math.max(0, parent.clientWidth - el.offsetWidth), maxY = Math.max(0, parent.clientHeight - el.offsetHeight);
    pos = { x: Math.min(Math.max(0, pos.x), maxX), y: Math.min(Math.max(0, pos.y), maxY) };
    Object.assign(el.style, { left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto" });
  }
  function setMinimized(v) {
    minimized = !!v;
    body.hidden = minimized;
    el.dataset.min = minimized ? "1" : "";
    minBtn.replaceChildren(svg(minimized ? ICON.max : ICON.min));
    minBtn.setAttribute("aria-expanded", minimized ? "false" : "true");
    minBtn.setAttribute("aria-label", `${minimized ? "Expand" : "Minimise"} ${title}`);
    minBtn.title = minimized ? "Expand" : "Minimise to the title bar";
    persist();
    place();
  }
  function reset() { pos = null; persist(); place(); }
  const current = () => ({ x: el.offsetLeft, y: el.offsetTop });

  minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMinimized(!minimized); });
  // the box last touched comes to the front of the other floating boxes
  const front = () => { el.style.zIndex = String(10 + (++raised % 1000)); };
  el.addEventListener("pointerdown", front, true);
  el.addEventListener("focusin", front);
  let drag = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !movable()) return;
    e.preventDefault(); e.stopPropagation();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ...current() };
    grip.setPointerCapture?.(e.pointerId);
    el.dataset.dragging = "1";
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pos = { x: drag.x + e.clientX - drag.sx, y: drag.y + e.clientY - drag.sy };
    place();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; el.dataset.dragging = "";
    grip.releasePointerCapture?.(e.pointerId);
    persist();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", (e) => { e.preventDefault(); reset(); });
  grip.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.key === "Home") { reset(); e.preventDefault(); e.stopPropagation(); return; }
    if (!d || !movable()) return;
    const k = e.shiftKey ? STEP * 5 : STEP, c = pos ?? current();
    pos = { x: c.x + d[0] * k, y: c.y + d[1] * k };
    place(); persist();
    e.preventDefault(); e.stopPropagation(); // the 3D view's own arrow keys (camera, nudge) must not fire as well
  });
  // keep it inside the stage when the stage or the box changes size (a narrower window, a longer legend)
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : null;
  let watched = null;
  const watch = () => { if (!ro || watched === el.offsetParent) return; ro.disconnect(); ro.observe(el); watched = el.offsetParent; if (watched) ro.observe(watched); };
  watch();
  setMinimized(minimized);
  return {
    el, body, bar,
    get minimized() { return minimized; },
    setMinimized, reset,
    refresh() { watch(); place(); },
    dispose() { ro?.disconnect(); },
  };
}
