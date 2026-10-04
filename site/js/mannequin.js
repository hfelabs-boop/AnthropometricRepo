// Body map: a mannequin (male or female) that shows where a measurement is taken and zooms in to that part of the body.
import { h, fmtInt, fmtFixed } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};

// ---- geometry ---------------------------------------------------------------------------------
// Standing figure, seen from the front: floor at y=450, top of head at y=10, so a height of f x stature sits at Y(f).
const Y = f => 450 - 440 * f;
const CX = 100;
// 3:4 viewports; the whole figure fits in BASE, zooming shrinks the box around the marker.
const BASE = { stand: { x: -72.5, y: -5, w: 345, h: 460 }, sit: { x: 0, y: 0, w: 300, h: 400 } };
const SEAT = 258, FLOOR = 360;

function closed(pts) {
  const n = pts.length;
  let d = `M${pts[0]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2}`;
  }
  return d + "Z";
}
// Right half of a symmetric outline (first and last point on the centre line) -> full closed outline.
const sym = R => [...R.map(([x, y]) => [CX + x, y]), ...R.slice(1, -1).reverse().map(([x, y]) => [CX - x, y])];
const mirror = p => p.l ? { l: [200 - p.l[0], p.l[1], 200 - p.l[2], p.l[3], p.l[4]] } : { e: [200 - p.e[0], ...p.e.slice(1)] };

function standParts(sex) {
  const F = sex === "F";
  const torso = closed(sym(F
    ? [[0, 86], [24, 90], [49, 95], [51, 105], [45, 132], [38, 160], [34, 177], [41, 205], [50, 224], [44, 243], [0, 247]]
    : [[0, 86], [26, 90], [55, 95], [57, 105], [48, 130], [43, 160], [39, 178], [44, 210], [46, 224], [40, 243], [0, 247]]));
  const half = F
    ? [{ l: [146, 102, 154, 170, 17] }, { l: [154, 170, 160, 240, 12] }, { l: [160, 240, 162, 276, 9] },
       { l: [79, 238, 81, 322, 37] }, { l: [81, 326, 84, 432, 22] }, { e: [85, 444, 11, 6.5] }]
    : [{ l: [150, 102, 159, 172, 19] }, { l: [159, 172, 165, 243, 14] }, { l: [165, 243, 167, 282, 10] },
       { l: [79, 238, 81, 322, 38] }, { l: [81, 326, 84, 432, 24] }, { e: [85, 444, 11, 6.5] }];
  // The left-hand limbs are drawn from the right-hand ones by mirroring about x = 100.
  const rightArm = half.slice(0, 3), leg = half.slice(3);
  return [
    { e: [CX, 38, F ? 17.5 : 19, F ? 27.5 : 28.5] }, { d: "M91 58L109 58L112 94L88 94Z" }, { d: torso },
    ...rightArm, ...rightArm.map(mirror), ...leg, ...leg.map(mirror),
  ];
}

function sitParts(sex) {
  const F = sex === "F";
  const torso = closed(F
    ? [[100, 92], [126, 96], [140, 112], [147, 128], [138, 152], [134, 185], [140, 216], [140, SEAT], [88, SEAT], [72, 234], [76, 196], [82, 150], [88, 112]]
    : [[100, 92], [128, 96], [141, 118], [142, 150], [138, 185], [141, 216], [140, SEAT], [88, SEAT], [76, 234], [78, 196], [84, 150], [88, 112]]);
  return [
    { e: [120, 56, F ? 21.5 : 23, F ? 28 : 29] }, { d: "M141 52L150 62L141 65Z" }, { l: [116, 82, 113, 100, 17] }, { d: torso },
    { l: [110, 106, 116, 184, F ? 15 : 17] }, { l: [116, 184, 170, 190, F ? 11 : 13] }, { l: [170, 190, 196, 192, 9] },
    { l: [98, 236, 205, 236, F ? 42 : 44] }, { l: [205, 236, 201, 336, F ? 26 : 28] }, { l: [201, 336, 200, 348, 19] }, { l: [200, 352, 243, 352, 14] },
  ];
}

// ---- where each measure is taken ----------------------------------------------------------------
const vdim = (x, y1, y2, leads = [], dots = []) => ({ k: "v", x, y1, y2, leads, dots });
const hdim = (y, x1, x2, leads = [], dots = []) => ({ k: "h", y, x1, x2, leads, dots });
const circ = (cx, cy, rx, ry = rx * .2, v = false) => ({ k: "c", cx, cy, rx, ry, v });
const stand = (...m) => ({ pose: "stand", m });
const sit = (...m) => ({ pose: "sit", m });
// Height of a landmark above the floor (fraction of stature); dimension line on the left, landmark at x = lx.
const heightTo = (f, lx) => stand(vdim(14, Y(f), 450, [[14, Y(f), lx, Y(f)]], [[lx, Y(f)]]));
const breadth = (y, half) => stand(hdim(y, CX - half, CX + half, [], [[CX - half, y], [CX + half, y]]));
// Distance from the seat up to a landmark, seated.
const seatTo = (x, y, lx) => sit(vdim(x, y, SEAT, [[x, y, lx, y]], [[lx, y]]));
const floorTo = (x, y, lx) => sit(vdim(x, y, FLOOR, [[x, y, lx, y]], [[lx, y]]));

const SPEC = {
  stature: heightTo(1, CX), cervicale_height: heightTo(.85, 93), suprasternale_height: heightTo(.815, CX), acromion_height: heightTo(.818, 45),
  trochanterion_height: heightTo(.53, 56), iliocristale_height: heightTo(.61, 62), crotch_height: heightTo(.47, CX), waist_height: heightTo(.62, 62),
  mass: { pose: "stand", m: [], tint: true }, bmi: { pose: "stand", m: [], tint: true }, body_fat_percent: { pose: "stand", m: [], tint: true },

  chest_circumference: stand(circ(CX, 133, 50)), waist_circumference: stand(circ(CX, 176, 41)), buttock_circumference: stand(circ(CX, 224, 49)),
  neck_circumference: stand(circ(CX, 86, 14)), shoulder_circumference: stand(circ(CX, 108, 62, 10)), head_circumference: stand(circ(CX, 28, 20, 4)),
  thigh_circumference: stand(circ(79, 262, 21)), lower_thigh_circumference: stand(circ(80, 305, 17)), knee_circumference: stand(circ(81, 325, 17)),
  calf_circumference: stand(circ(82, 362, 14)), ankle_circumference: stand(circ(84, 425, 12)), heel_ankle_circumference: stand(circ(84, 437, 14)),
  wrist_circumference: stand(circ(165, 244, 8)), biceps_circumference_flexed: stand(circ(156, 125, 12)), biceps_circumference_relaxed: stand(circ(156, 125, 12)),
  forearm_circumference_flexed: stand(circ(161, 193, 10)), hand_circumference: stand(circ(167, 268, 7)),
  vertical_trunk_circumference: stand(circ(CX, 170, 28, 98, true)), scye_circumference: stand(circ(148, 112, 9, 22, true)),
  ball_of_foot_circumference: sit(circ(222, 352, 8, 8, true)),

  bideltoid_breadth: breadth(98, 62), biacromial_breadth: breadth(90, 49), chest_breadth: breadth(133, 48), hip_breadth: breadth(222, 46),
  hip_breadth_sitting: breadth(222, 46), waist_breadth: breadth(177, 39), head_breadth: breadth(40, 19), bizygomatic_breadth: breadth(46, 16),
  interpupillary_breadth: breadth(36, 9),
  hand_breadth: stand(hdim(268, 161, 173, [], [[161, 268], [173, 268]])), foot_breadth: stand(hdim(444, 74, 96, [], [[74, 444], [96, 444]])),
  hand_length: stand(vdim(180, 245, 283, [[180, 245, 163, 245], [180, 283, 168, 283]], [[163, 245], [168, 283]])),
  palm_length: stand(vdim(180, 245, 268, [[180, 245, 163, 245], [180, 268, 168, 268]], [[163, 245], [168, 268]])),
  span: stand(hdim(120, -40, 240, [], [[-40, 120], [240, 120]])),

  sitting_height: seatTo(40, 27, 97), eye_height_sitting: seatTo(40, 50, 138), acromion_height_sitting: seatTo(40, 104, 108),
  elbow_rest_height: seatTo(50, 192, 116), thigh_clearance: sit(vdim(165, 214, SEAT, [], [[165, 214]])),
  knee_height_sitting: floorTo(250, 214, 220), popliteal_height: sit(vdim(176, SEAT, FLOOR, [], [[176, SEAT]])),
  buttock_knee_length: sit(hdim(290, 76, 227, [[76, 240, 76, 290], [227, 258, 227, 290]], [[76, 240], [227, 236]])),
  buttock_popliteal_length: sit(hdim(310, 76, 190, [[76, 240, 76, 310], [190, 258, 190, 310]], [[76, 240], [190, SEAT]])),
  chest_depth: sit(hdim(135, 85, 142, [], [[85, 135], [142, 135]])), buttock_depth: sit(hdim(236, 76, 142, [], [[76, 236], [142, 236]])),
  shoulder_elbow_length: sit(vdim(104, 104, 192, [], [[104, 104], [116, 192]])),
  forearm_hand_length: sit(hdim(206, 116, 201, [[116, 192, 116, 206], [201, 194, 201, 206]], [[116, 190], [201, 192]])),
  foot_length: sit(hdim(372, 193, 250, [[193, 360, 193, 372], [250, 360, 250, 372]], [[193, 359], [250, 359]])),
  head_length: sit(hdim(46, 97, 143, [], [[97, 46], [143, 46]])), menton_sellion_length: sit(vdim(150, 46, 84, [[150, 46, 142, 46], [150, 84, 138, 84]], [[142, 46], [138, 84]])),
  ear_length: sit(vdim(100, 48, 68, [], [[100, 48], [100, 68]])),
};

// Measures without an exact landmark: highlight the body region they belong to.
const REGIONS = [
  [/foot|heel|instep|toe|ball_of/, "sit", { cx: 222, cy: 350, rx: 38, ry: 16 }],
  [/head|ear|face|zygom|sellion|menton|tragion|nose|mouth|chin|eye|interpupil|orbit|cranial|brow|lip/, "stand", { cx: CX, cy: 38, rx: 30, ry: 38 }],
  [/hand|palm|thumb|finger|knuckle|grip/, "stand", { cx: 167, cy: 268, rx: 16, ry: 28 }],
  [/thigh|knee|calf|leg|inseam|crotch|ankle|tibi|popliteal/, "stand", { cx: 82, cy: 340, rx: 30, ry: 105 }],
  [/sleeve|arm|elbow|biceps|forearm|axilla/, "stand", { cx: 158, cy: 175, rx: 22, ry: 95 }],
  [/waist|chest|hip|buttock|trunk|torso|rise|back|bust|shoulder|scye|stern|rib/, "stand", { cx: CX, cy: 160, rx: 60, ry: 85 }],
];

export function specFor(key) {
  const k = key.replace(/^other:/, "");
  if (SPEC[k]) return { ...SPEC[k], kind: "exact" };
  if (/(^|_)(mass|weight|bmi|fat)(_|$)/.test(k)) return { ...SPEC.mass, kind: "exact" };
  const hit = REGIONS.find(([re]) => re.test(k));
  return hit ? { pose: hit[1], m: [{ k: "r", ...hit[2] }], kind: "region" } : { pose: "stand", m: [], kind: "none" };
}

// ---- drawing --------------------------------------------------------------------------------------
const OUTLINE = 2.6;
function partsGroup(parts, mode, extra = {}) {
  const g = s("g", extra);
  for (const p of parts) {
    const stroke = mode === "line";
    if (p.l) {
      const [x1, y1, x2, y2, w] = p.l;
      g.append(s("line", { x1, y1, x2, y2, "stroke-width": w + (stroke ? OUTLINE : 0), "stroke-linecap": "round", stroke: stroke ? "var(--text-3)" : mode === "tint" ? "var(--accent)" : "var(--surface)" }));
    } else {
      const el = p.e ? s("ellipse", { cx: p.e[0], cy: p.e[1], rx: p.e[2], ry: p.e[3] }) : s("path", { d: p.d });
      if (stroke) { el.setAttribute("fill", "var(--text-3)"); el.setAttribute("stroke", "var(--text-3)"); el.setAttribute("stroke-width", OUTLINE); el.setAttribute("stroke-linejoin", "round"); }
      else el.setAttribute("fill", mode === "tint" ? "var(--accent)" : "var(--surface)");
      g.append(el);
    }
  }
  return g;
}

const ACC = { stroke: "var(--accent)", fill: "none", "vector-effect": "non-scaling-stroke", "stroke-width": 2.5, "stroke-linecap": "round" };
function markerEls(m, r) {
  const out = [], line = (x1, y1, x2, y2, extra = {}) => s("line", { ...ACC, x1, y1, x2, y2, ...extra });
  const lead = ([x1, y1, x2, y2]) => line(x1, y1, x2, y2, { "stroke-width": 1.4, "stroke-dasharray": "3 3", opacity: .8 });
  (m.leads || []).forEach(l => out.push(lead(l)));
  if (m.k === "v") out.push(line(m.x, m.y1, m.x, m.y2), line(m.x - r * 1.4, m.y1, m.x + r * 1.4, m.y1), line(m.x - r * 1.4, m.y2, m.x + r * 1.4, m.y2));
  if (m.k === "h") out.push(line(m.x1, m.y, m.x2, m.y), line(m.x1, m.y - r * 1.4, m.x1, m.y + r * 1.4), line(m.x2, m.y - r * 1.4, m.x2, m.y + r * 1.4));
  if (m.k === "c") {
    const { cx, cy, rx, ry } = m;
    const a = m.v ? `M${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}` : `M${cx - rx} ${cy}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}`;
    const b = m.v ? `M${cx} ${cy - ry}A${rx} ${ry} 0 0 0 ${cx} ${cy + ry}` : `M${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`;
    out.push(s("path", { ...ACC, d: a }), s("path", { ...ACC, d: b, "stroke-width": 1.6, "stroke-dasharray": "4 3", opacity: .8 }));
  }
  if (m.k === "r") out.push(s("ellipse", { cx: m.cx, cy: m.cy, rx: m.rx, ry: m.ry, fill: "var(--accent)", "fill-opacity": .16, stroke: "var(--accent)", "stroke-width": 1.6, "stroke-dasharray": "5 3", "vector-effect": "non-scaling-stroke" }));
  (m.dots || []).forEach(([x, y]) => out.push(s("circle", { cx: x, cy: y, r, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" })));
  return out;
}

function points(m) {
  const p = [];
  for (const q of m) {
    if (q.k === "v") p.push([q.x, q.y1], [q.x, q.y2]);
    if (q.k === "h") p.push([q.x1, q.y], [q.x2, q.y]);
    if (q.k === "c") p.push([q.cx - q.rx, q.cy - q.ry], [q.cx + q.rx, q.cy + q.ry]);
    if (q.k === "r") p.push([q.cx - q.rx, q.cy - q.ry], [q.cx + q.rx, q.cy + q.ry]);
    (q.leads || []).forEach(l => p.push([l[0], l[1]], [l[2], l[3]]));
  }
  return p;
}

function targetBox(pose, m) {
  const B = BASE[pose], pts = points(m);
  if (!pts.length) return B;
  if (pose === "stand") pts.push([CX, pts[0][1]]);
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
  const from = lastBox.get(key) || BASE[to.pose];
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

function figure(sexCode, spec, zoom, name) {
  const sex = sexCode === "F" ? "F" : "M";
  const parts = spec.pose === "stand" ? standParts(sex) : sitParts(sex);
  const box = zoom ? targetBox(spec.pose, spec.m) : BASE[spec.pose];
  const r = box.w / 62;
  const svg = s("svg", { role: "img", "aria-label": `${name}: where it is measured on the ${sex === "F" ? "female" : "male"} body`, preserveAspectRatio: "xMidYMid meet" });
  const B = BASE[spec.pose];
  if (spec.pose === "stand") svg.append(s("line", { x1: B.x + 20, y1: 451, x2: B.x + B.w - 20, y2: 451, stroke: "var(--line-strong)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
  else svg.append(
    s("path", { d: `M66 110V${SEAT + 1}H232M20 ${FLOOR}H290`, fill: "none", stroke: "var(--line-strong)", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }));
  svg.append(partsGroup(parts, "line"), partsGroup(parts, "fill"));
  if (spec.tint) svg.append(partsGroup(parts, "tint", { opacity: .32 }));
  svg.append(s("g", {}, ...spec.m.flatMap(m => markerEls(m, r))));
  animate(svg, `${sexCode}|${spec.pose}`, { ...box, pose: spec.pose });
  return svg;
}

/** figures: [{ sex: "M" | "F" | "both", label, color, mean, people, groups }] */
export function bodyMap({ key, label, unit, figures, zoom, onZoom }) {
  const spec = specFor(key);
  const note = spec.kind === "region" ? "No single landmark for this measure: the body region is highlighted."
    : spec.kind === "none" ? "This measure is not tied to one place on the body."
    : spec.tint ? "A whole-body measure." : "";
  const fmt = v => v == null ? "—" : `${fmtFixed(v, unit === "mm" ? 0 : 1)} ${unit}`;
  return h("div", { class: "mq-card" },
    h("div", { class: "mq-head" }, h("b", {}, "Where it is measured"),
      h("button", { class: "btn small", type: "button", "aria-pressed": String(zoom), onclick: onZoom, title: "Zoom the figure to the measured area" }, zoom ? "Zoom: on" : "Zoom: off")),
    h("div", { class: "mq-figs" }, figures.map(f => h("figure", { class: "mq-fig" },
      figure(f.sex, spec, zoom, label),
      h("figcaption", {},
        h("span", { class: "mq-sex" }, h("i", { class: "swatch-dot", style: { background: `var(${f.color})` } }), f.label),
        h("b", { class: "mq-val" }, fmt(f.mean)),
        h("span", { class: "small muted" }, f.groups ? `${label} · mean of ${fmtInt(f.groups)} group${f.groups === 1 ? "" : "s"}${f.people ? `, ${fmtInt(f.people)} people` : ""}` : `${label} · no data for this selection`))))),
    note ? h("p", { class: "small muted", style: { margin: 0 } }, note) : null);
}
