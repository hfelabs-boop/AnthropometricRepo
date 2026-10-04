// Body map: male and female figures that show where a measurement is taken and zoom in to that part of the body.
// The figures are shaded views of two CC0 human base meshes (Blender Studio) in eight poses; bodymarks.js places the
// dimension lines, circumferences, arcs and skin-fold sites on landmarks measured on the same meshes.
import { h, fmtInt, fmtFixed } from "./util.js";
import { DATA } from "./bodydata.js";
import { resolve, CX, SEAT } from "./bodymarks.js";

export const specFor = resolve;

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};

// Each pose: the sprite, the whole-figure viewport (3:4; zooming shrinks the box around the marker) and the backdrop.
const STAND = { x: -72.5, y: -5, w: 345, h: 460 };
const POSES = {
  stand: { img: "stand", base: STAND, ground: "floor" },
  back: { img: "stand_back", base: STAND, ground: "floor" },
  side: { img: "stand_side", base: { x: -5, y: -5, w: 345, h: 460 }, ground: "floor" },
  reach: { img: "reach", base: { x: -5, y: -5, w: 345, h: 460 }, ground: "floor" },
  up: { img: "up", base: { x: -103, y: -100, w: 420, h: 560 }, ground: "floor" },
  sit: { img: "sit", base: { x: 0, y: 0, w: 300, h: 400 }, ground: "seat" },
  situp: { img: "situp", base: { x: -10, y: -96, w: 345, h: 460 }, ground: "seat" },
  sitleg: { img: "sitleg", base: { x: 5, y: 0, w: 345, h: 460 }, ground: "seat" },
};
const dataOf = sex => DATA[sex === "F" ? "F" : "M"];

// ---- drawing --------------------------------------------------------------------------------------
const ACC = { stroke: "var(--accent)", fill: "none", "vector-effect": "non-scaling-stroke", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" };
function markerEls(m, r) {
  const out = [], line = (x1, y1, x2, y2, extra = {}) => s("line", { ...ACC, x1, y1, x2, y2, ...extra });
  const lead = ([x1, y1, x2, y2]) => line(x1, y1, x2, y2, { "stroke-width": 1.4, "stroke-dasharray": "3 3", opacity: .8 });
  (m.leads || []).forEach(l => out.push(lead(l)));
  if (m.k === "v") out.push(line(m.x, m.y1, m.x, m.y2), line(m.x - r * 1.4, m.y1, m.x + r * 1.4, m.y1), line(m.x - r * 1.4, m.y2, m.x + r * 1.4, m.y2));
  if (m.k === "h") out.push(line(m.x1, m.y, m.x2, m.y), line(m.x1, m.y - r * 1.4, m.x1, m.y + r * 1.4), line(m.x2, m.y - r * 1.4, m.x2, m.y + r * 1.4));
  if (m.k === "d") {
    const dx = m.x2 - m.x1, dy = m.y2 - m.y1, n = Math.hypot(dx, dy) || 1, px = -dy / n * r * 1.4, py = dx / n * r * 1.4;
    out.push(line(m.x1, m.y1, m.x2, m.y2), line(m.x1 - px, m.y1 - py, m.x1 + px, m.y1 + py), line(m.x2 - px, m.y2 - py, m.x2 + px, m.y2 + py));
  }
  if (m.k === "p") out.push(s("path", { ...ACC, d: "M" + m.pts.map(p => `${p[0]} ${p[1]}`).join("L") }));
  if (m.k === "a") {
    out.push(s("path", { ...ACC, d: `M${m.x1} ${m.y1}A${m.rx} ${m.ry} 0 0 ${m.up ? 1 : 0} ${m.x2} ${m.y2}` }));
  }
  if (m.k === "c") {
    const { cx, cy, rx, ry } = m;
    const a = m.v ? `M${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}` : `M${cx - rx} ${cy}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}`;
    const b = m.v ? `M${cx} ${cy - ry}A${rx} ${ry} 0 0 0 ${cx} ${cy + ry}` : `M${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`;
    out.push(s("path", { ...ACC, d: a }), s("path", { ...ACC, d: b, "stroke-width": 1.6, "stroke-dasharray": "4 3", opacity: .8 }));
  }
  if (m.k === "r") out.push(s("ellipse", { cx: m.cx, cy: m.cy, rx: m.rx, ry: m.ry, fill: "var(--accent)", "fill-opacity": .16, stroke: "var(--accent)", "stroke-width": 1.6, "stroke-dasharray": "5 3", "vector-effect": "non-scaling-stroke" }));
  if (m.k === "s") {
    out.push(s("circle", { cx: m.x, cy: m.y, r: r * 3.2, fill: "var(--accent)", "fill-opacity": .18, stroke: "var(--accent)", "stroke-width": 1.6, "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke" }),
      line(m.x - r * 2, m.y, m.x + r * 2, m.y), line(m.x, m.y - r * 2, m.x, m.y + r * 2),
      s("circle", { cx: m.x, cy: m.y, r, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
  }
  if (m.k === "w") {
    out.push(line(m.x, m.y1, m.x, m.y2, { stroke: "var(--text-2)", "stroke-width": 3.5, opacity: .85 }));
    const n = 5; for (let i = 0; i <= n; i++) { const y = m.y1 + (m.y2 - m.y1) * i / n; out.push(line(m.x, y, m.x - r * 2.4, y + r * 2, { stroke: "var(--text-2)", "stroke-width": 1.4, opacity: .7 })); }
  }
  (m.dots || []).forEach(([x, y]) => out.push(s("circle", { cx: x, cy: y, r, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" })));
  return out;
}

function points(m) {
  const p = [];
  for (const q of m) {
    if (q.k === "v") p.push([q.x, q.y1], [q.x, q.y2]);
    if (q.k === "h") p.push([q.x1, q.y], [q.x2, q.y]);
    if (q.k === "d" || q.k === "a") p.push([q.x1, q.y1], [q.x2, q.y2]);
    if (q.k === "a") p.push([(q.x1 + q.x2) / 2, (q.y1 + q.y2) / 2 + (q.up ? -q.ry : q.ry)]);
    if (q.k === "p") q.pts.forEach(t => p.push(t));
    if (q.k === "c") p.push([q.cx - q.rx, q.cy - q.ry], [q.cx + q.rx, q.cy + q.ry]);
    if (q.k === "r") p.push([q.cx - q.rx, q.cy - q.ry], [q.cx + q.rx, q.cy + q.ry]);
    if (q.k === "s") p.push([q.x - 8, q.y - 8], [q.x + 8, q.y + 8]);
    if (q.k === "w") p.push([q.x, q.y1], [q.x, q.y2]);
    (q.leads || []).forEach(l => p.push([l[0], l[1]], [l[2], l[3]]));
  }
  return p;
}

function targetBox(pose, m) {
  const B = POSES[pose].base, pts = points(m);
  if (!pts.length) return B;
  if (pose === "stand" || pose === "back") pts.push([CX, pts[0][1]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(10, .25 * Math.max(x1 - x0, y1 - y0));
  let w = x1 - x0 + 2 * pad;
  const hh0 = y1 - y0 + 2 * pad;
  w = Math.max(w, hh0 * .75, 110);
  const hh = w / .75;
  if (w >= B.w || hh >= B.h) return B;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  return { x: clamp((x0 + x1) / 2 - w / 2, B.x, B.x + B.w - w), y: clamp((y0 + y1) / 2 - hh / 2, B.y, B.y + B.h - hh), w, h: hh };
}

const lastBox = new Map();
function animate(svg, key, to) {
  const from = lastBox.get(key) || POSES[to.pose].base;
  const set = v => { svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`); lastBox.set(key, v); };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || ["x", "y", "w", "h"].every(k => Math.abs(from[k] - to[k]) < .5)) return set(to);
  const t0 = performance.now(), D = 700;
  set(from);
  const step = now => {
    const p = Math.min(1, (now - t0) / D), q = 1 - (1 - p) ** 3;
    set(Object.fromEntries(["x", "y", "w", "h"].map(k => [k, from[k] + (to[k] - from[k]) * q])));
    if (p < 1 && (svg.isConnected || now - t0 < 150)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let maskId = 0;
function figure(sexCode, key, zoom, name) {
  const sex = sexCode === "F" ? "F" : "M", D = dataOf(sex);
  const spec = resolve(key, sex), PO = POSES[spec.pose], sp = D.sprite[PO.img];
  const box = zoom ? targetBox(spec.pose, spec.m) : PO.base;
  const r = box.w / 62;
  const svg = s("svg", { role: "img", "aria-label": `${name}: where it is measured on the ${sex === "F" ? "female" : "male"} body`, preserveAspectRatio: "xMidYMid meet" });
  const B = PO.base, img = () => s("image", { href: `img/body/${sex}_${PO.img}.webp`, x: sp.x, y: sp.y, width: sp.w, height: sp.h });
  if (PO.ground === "floor") svg.append(s("line", { x1: B.x + 20, y1: 451, x2: B.x + B.w - 20, y2: 451, stroke: "var(--line-strong)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
  else svg.append(s("path", { d: `M${D.wall.sit_back} 110V${SEAT + 1}H232M${B.x + 20} ${D.G.floorY}H${B.x + B.w - 10}`, fill: "none", stroke: "var(--line-strong)", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }));
  svg.append(img());
  if (spec.tint) {
    const id = `mq-mask-${++maskId}`;
    svg.append(s("mask", { id, maskUnits: "userSpaceOnUse", x: sp.x, y: sp.y, width: sp.w, height: sp.h }, img()),
      s("rect", { x: sp.x, y: sp.y, width: sp.w, height: sp.h, fill: "var(--accent)", opacity: .45, mask: `url(#${id})` }));
  }
  svg.append(s("g", {}, ...spec.m.flatMap(m => markerEls(m, r))));
  animate(svg, `${sexCode}|${spec.pose}`, { ...box, pose: spec.pose });
  return svg;
}

/** figures: [{ sex: "M" | "F" | "both", label, color, mean, people, groups }] */
export function bodyMap({ key, label, unit, figures, zoom, onZoom }) {
  const spec = resolve(key, figures[0] && figures[0].sex);
  const note = spec.kind === "region" ? "No single landmark for this measure: the body region is highlighted."
    : spec.kind === "none" ? (/^age$/.test(key) ? "Age is a demographic variable, not a body dimension." : "This measure is not tied to one place on the body.")
    : spec.desc || (spec.tint ? "A whole-body measure." : "");
  const fmt = v => v == null ? "—" : `${fmtFixed(v, unit === "mm" ? 0 : 1)} ${unit}`;
  return h("div", { class: "mq-card" },
    h("div", { class: "mq-head" }, h("b", {}, "Where it is measured"),
      h("button", { class: "btn small", type: "button", "aria-pressed": String(zoom), onclick: onZoom, title: "Zoom the figure to the measured area" }, zoom ? "Zoom: on" : "Zoom: off")),
    h("div", { class: "mq-figs" }, figures.map(f => h("figure", { class: "mq-fig" },
      figure(f.sex, key, zoom, label),
      h("figcaption", {},
        h("span", { class: "mq-sex" }, h("i", { class: "swatch-dot", style: { background: `var(${f.color})` } }), f.label),
        h("b", { class: "mq-val" }, fmt(f.mean)),
        f.pct ? h("span", { class: "mq-pct", title: "5th, 50th (median) and 95th percentile of the groups shown, combined and weighted by sample size" },
          [["P5", f.pct[0]], ["P50", f.pct[1]], ["P95", f.pct[2]]].map(([k, v]) => h("span", {}, h("i", {}, k), fmtFixed(v, unit === "mm" ? 0 : 1)))) : null,
        h("span", { class: "small muted" }, f.groups ? `${label} · mean of ${fmtInt(f.groups)} group${f.groups === 1 ? "" : "s"}${f.people ? `, ${fmtInt(f.people)} people` : ""}` : `${label} · no data for this selection`))))),
    note ? h("p", { class: "small muted", style: { margin: 0 } }, note) : null);
}
