// Body map: a mannequin (male or female) that shows where a measurement is taken and zooms in to that part of the body.
import { h, fmtInt, fmtFixed } from "./util.js";
import { DATA } from "./bodydata.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};

// ---- geometry ---------------------------------------------------------------------------------
// Standing figure, seen from the front: floor at y=450, top of head at y=10, so a height of f x stature sits at Y(f).
// The figures are shaded views of two CC0 human base meshes (Blender Studio): standing from the front, seated from the side.
// bodydata.js holds the landmarks and silhouettes measured on those meshes, in the same SVG units.
const Y = f => 450 - 440 * f;
const CX = 100;
// 3:4 viewports; the whole figure fits in BASE, zooming shrinks the box around the marker.
const BASE = { stand: { x: -72.5, y: -5, w: 345, h: 460 }, sit: { x: 0, y: 0, w: 300, h: 400 } };
const SEAT = 258;
const dataOf = sex => DATA[sex === "F" ? "F" : "M"];
const floorOf = sex => dataOf(sex).G.floorY;

// ---- where each measure is taken ----------------------------------------------------------------
const vdim = (x, y1, y2, leads = [], dots = []) => ({ k: "v", x, y1, y2, leads, dots });
const hdim = (y, x1, x2, leads = [], dots = []) => ({ k: "h", y, x1, x2, leads, dots });
const circ = (cx, cy, rx, ry = rx * .2, v = false) => ({ k: "c", cx, cy, rx, ry, v });
const stand = (...m) => ({ pose: "stand", m });
const sit = (...m) => ({ pose: "sit", m });
const near = (o, y) => o[Math.round(y / 2) * 2];

function buildSpec(sex) {
  const D = dataOf(sex), L = D.L, G = D.G, dz = G.eye[1] - L.eyeY;
  const hw = y => near(D.tw, y) ?? 40;
  const keys = Object.keys(D.runs).map(Number).sort((a, b) => a - b);
  const rowRuns = y => D.runs[keys.reduce((best, k) => Math.abs(k - y) < Math.abs(best - y) ? k : best, keys[0])];
  const midRun = y => rowRuns(y).find(([a, b]) => a <= CX && CX <= b) || [CX - 30, CX + 30];
  const right = y => rowRuns(y).filter(([a, b]) => a > CX || (a + b) / 2 > CX + 1);
  const outer = y => { const [a, b] = midRun(y); return (b - a) / 2; };
  const leg = y => { const r = right(y).filter(([a, b]) => (a + b) / 2 < 152 && b > CX); return r.length ? r.reduce((p, q) => Math.abs((q[0] + q[1]) / 2 - 130) < Math.abs((p[0] + p[1]) / 2 - 130) ? q : p) : [CX + 8, CX + 38]; };
  const armPts = [[L.shoulderX, Y(.815)], [L.elbowX, L.elbowY], [L.wristX, L.wristY], [L.fingerX, L.fingerY]];
  const armX = y => { for (let i = 0; i < 3; i++) { const [x0, y0] = armPts[i], [x1, y1] = armPts[i + 1]; if (y <= y1 || i === 2) return x0 + (x1 - x0) * Math.min(1, Math.max(0, (y - y0) / (y1 - y0))); } };
  const armHalf = (y, dflt) => { const r = right(y).filter(([a, b]) => (a + b) / 2 > armX(y) - 12 && (a + b) / 2 < armX(y) + 12); return r.length ? (r[0][1] - r[0][0]) / 2 : dflt; };
  const [yb, hb] = (() => { let best = [90, 0]; for (let y = 84; y <= 120; y += 2) if (outer(y) > best[1]) best = [y, outer(y)]; return best; })();
  const brow = L.eyeY - 9, headHalf = outer(brow);
  const heightTo = (y, lx) => stand(vdim(14, y, 450, [[14, y, lx, y]], [[lx, y]]));
  const breadth = (y, half) => stand(hdim(y, CX - half, CX + half, [], [[CX - half, y], [CX + half, y]]));
  const legCirc = y => { const [a, b] = leg(y); return stand(circ((a + b) / 2, y, (b - a) / 2)); };
  const armCirc = (y, dflt) => stand(circ(armX(y), y, armHalf(y, dflt), armHalf(y, dflt) * .22));
  const seatTo = (x, y, lx) => sit(vdim(x, y, SEAT, [[x, y, lx, y]], [[lx, y]]));
  const yf = G.floorY + 14, yBut = L.buttY + dz;
  const pop = [G.kneeJoint[0] - 13, G.kneeJoint[1] + 19];
  const [ex, ey] = G.elbow, [fx, fy] = G.finger, yFore = Math.max(fy, ey) + 14;
  const handLen = .108 * 440, wy = L.fingerY - handLen, handMid = wy + .55 * handLen, hx = y => L.wristX + (L.fingerX - L.wristX) * Math.min(1, Math.max(0, (y - L.wristY) / (L.fingerY - L.wristY)));
  const hy = wy + .5 * handLen, hhalf = .044 * L.u, h0 = armX(hy) - hhalf, h1 = armX(hy) + hhalf;
  const foot = leg(440);
  return {
    stature: heightTo(10, CX), cervicale_height: heightTo(Y(.85), CX - hw(Y(.85))), suprasternale_height: heightTo(Y(.815), CX), acromion_height: heightTo(L.acromionY, 200 - L.acromionX),
    trochanterion_height: heightTo(Y(.53), CX - outer(Y(.53))), iliocristale_height: heightTo(Y(.61), CX - hw(Y(.61))), crotch_height: heightTo(L.crotchY, CX), waist_height: heightTo(L.waistY, CX - hw(L.waistY)),
    mass: { pose: "stand", m: [], tint: true }, bmi: { pose: "stand", m: [], tint: true }, body_fat_percent: { pose: "stand", m: [], tint: true },

    chest_circumference: stand(circ(CX, L.chestY, hw(L.chestY))), waist_circumference: stand(circ(CX, L.waistY, hw(L.waistY))), buttock_circumference: stand(circ(CX, L.buttY, outer(L.buttY))),
    neck_circumference: stand(circ(CX, L.neckY, hw(L.neckY))), shoulder_circumference: stand(circ(CX, yb + 8, hb, 10)), head_circumference: stand(circ(CX, brow, headHalf, 4)),
    thigh_circumference: legCirc(276), lower_thigh_circumference: legCirc(305), knee_circumference: legCirc(L.kneeY),
    calf_circumference: legCirc(366), ankle_circumference: legCirc(L.ankleY), heel_ankle_circumference: legCirc(438),
    wrist_circumference: armCirc(wy + 3, 8), biceps_circumference_flexed: armCirc(Y(.815) + .45 * (L.elbowY - Y(.815)), 13), biceps_circumference_relaxed: armCirc(Y(.815) + .45 * (L.elbowY - Y(.815)), 13),
    forearm_circumference_flexed: armCirc(L.elbowY + .2 * (L.wristY - L.elbowY), 11), hand_circumference: stand(circ(armX(handMid), handMid, hhalf * .9, hhalf * .2)),
    vertical_trunk_circumference: stand(circ(CX, (L.neckY + L.crotchY) / 2, hw(L.waistY) * .7, (L.crotchY - L.neckY) / 2, true)),
    scye_circumference: stand(circ(CX + hw(122) + 4, 116, 8, 22, true)),
    ball_of_foot_circumference: sit(circ(G.footToeBall, G.floorY - 7, 7, 7, true)),

    bideltoid_breadth: breadth(yb, hb), biacromial_breadth: breadth(L.acromionY, L.acromionX - CX), chest_breadth: breadth(L.chestY, hw(L.chestY)), hip_breadth: breadth(L.hipY, outer(L.hipY)),
    hip_breadth_sitting: breadth(L.hipY, outer(L.hipY)), waist_breadth: breadth(L.waistY, hw(L.waistY)), head_breadth: breadth(brow, headHalf), bizygomatic_breadth: breadth(L.eyeY + 3, headHalf * .9),
    interpupillary_breadth: breadth(L.eyeY, 8),
    hand_breadth: stand(hdim(hy, h0, h1, [], [[h0, hy], [h1, hy]])), foot_breadth: stand(hdim(444, foot[0], foot[1], [], [[foot[0], 444], [foot[1], 444]])),
    hand_length: stand(vdim(L.fingerX + 16, wy, L.fingerY, [[L.fingerX + 16, wy, armX(wy) + 3, wy], [L.fingerX + 16, L.fingerY, L.fingerX + 3, L.fingerY]], [[armX(wy) + 3, wy], [L.fingerX + 3, L.fingerY]])),
    palm_length: stand(vdim(L.fingerX + 16, wy, handMid, [[L.fingerX + 16, wy, armX(wy) + 3, wy], [L.fingerX + 16, handMid, armX(handMid) + 8, handMid]], [[armX(wy) + 3, wy], [armX(handMid) + 8, handMid]])),
    span: stand(hdim(L.acromionY + 8, -40, 240, [], [[-40, L.acromionY + 8], [240, L.acromionY + 8]])),

    sitting_height: seatTo(40, G.headTop[1], G.headTop[0]), eye_height_sitting: seatTo(40, G.eye[1], G.eye[0] + 4), acromion_height_sitting: seatTo(40, G.acromion[1], G.acromion[0]),
    elbow_rest_height: seatTo(52, G.olecranonY, ex), thigh_clearance: sit(vdim(G.thighTop[0], G.thighTop[1], SEAT, [], [[G.thighTop[0], G.thighTop[1]]])),
    knee_height_sitting: sit(vdim(G.kneeFront[0] + 16, G.kneeTop[1], G.floorY, [[G.kneeFront[0] + 16, G.kneeTop[1], G.kneeTop[0], G.kneeTop[1]]], [[G.kneeTop[0], G.kneeTop[1]]])),
    popliteal_height: sit(vdim(pop[0] - 16, pop[1], G.floorY, [[pop[0] - 16, pop[1], pop[0], pop[1]]], [pop])),
    buttock_knee_length: sit(hdim(yf, 76, G.kneeFront[0], [[76, yBut, 76, yf], [G.kneeFront[0], G.kneeFront[1], G.kneeFront[0], yf]], [[76, yBut], G.kneeFront])),
    buttock_popliteal_length: sit(hdim(yf, 76, pop[0], [[76, yBut, 76, yf], [pop[0], pop[1], pop[0], yf]], [[76, yBut], pop])),
    chest_depth: sit(hdim(L.chestY + dz, near(D.td, L.chestY)[1], near(D.td, L.chestY)[0], [], [[near(D.td, L.chestY)[1], L.chestY + dz], [near(D.td, L.chestY)[0], L.chestY + dz]])),
    buttock_depth: sit(hdim(yBut, near(D.td, L.buttY)[1], near(D.td, L.buttY)[0], [], [[near(D.td, L.buttY)[1], yBut], [near(D.td, L.buttY)[0], yBut]])),
    shoulder_elbow_length: sit(vdim(56, G.acromion[1], ey, [[56, G.acromion[1], G.acromion[0], G.acromion[1]], [56, ey, ex, ey]], [G.acromion, G.elbow])),
    forearm_hand_length: sit(hdim(yFore, ex, fx, [[ex, ey, ex, yFore], [fx, fy, fx, yFore]], [G.elbow, G.finger])),
    foot_length: sit(hdim(yf, G.heel, G.toe, [[G.heel, G.floorY, G.heel, yf], [G.toe, G.floorY, G.toe, yf]], [[G.heel, G.floorY], [G.toe, G.floorY]])),
    head_length: sit(hdim(G.browZ, G.opistho, G.glabellaY, [], [[G.opistho, G.browZ], [G.glabellaY, G.browZ]])),
    menton_sellion_length: sit(vdim(G.sellion[0] + 14, G.sellion[1], G.menton[1], [[G.sellion[0] + 14, G.sellion[1], G.sellion[0], G.sellion[1]], [G.sellion[0] + 14, G.menton[1], G.menton[0], G.menton[1]]], [G.sellion, G.menton])),
    ear_length: sit(vdim(G.ear[0] - 16, G.ear[1], G.ear[2], [[G.ear[0] - 16, G.ear[1], G.ear[0], G.ear[1]], [G.ear[0] - 16, G.ear[2], G.ear[0], G.ear[2]]], [[G.ear[0], G.ear[1]], [G.ear[0], G.ear[2]]])),
    _regions: [
      [/foot|heel|instep|toe|ball_of/, "sit", { cx: (G.heel + G.toe) / 2, cy: G.floorY - 6, rx: (G.toe - G.heel) / 2 + 8, ry: 16 }],
      [/head|ear|face|zygom|sellion|menton|tragion|nose|mouth|chin|eye|interpupil|orbit|cranial|brow|lip/, "stand", { cx: CX, cy: 42, rx: 30, ry: 38 }],
      [/hand|palm|thumb|finger|knuckle|grip/, "stand", { cx: (L.wristX + L.fingerX) / 2, cy: (L.wristY + L.fingerY) / 2, rx: 16, ry: 30 }],
      [/thigh|knee|calf|leg|inseam|crotch|ankle|tibi|popliteal/, "stand", { cx: 200 - (leg(340)[0] + leg(340)[1]) / 2, cy: (L.crotchY + 440) / 2, rx: 30, ry: (440 - L.crotchY) / 2 + 6 }],
      [/sleeve|arm|elbow|biceps|forearm|axilla/, "stand", { cx: (L.shoulderX + L.wristX) / 2, cy: (Y(.815) + L.wristY) / 2, rx: 26, ry: (L.wristY - Y(.815)) / 2 + 8 }],
      [/waist|chest|hip|buttock|trunk|torso|rise|back|bust|shoulder|scye|stern|rib/, "stand", { cx: CX, cy: (yb + L.crotchY) / 2, rx: hb + 4, ry: (L.crotchY - yb) / 2 + 4 }],
    ],
  };
}

const specCache = {};
export function specFor(key, sex = "M") {
  const sx = sex === "F" ? "F" : "M";
  const SPEC = specCache[sx] || (specCache[sx] = buildSpec(sx));
  const k = key.replace(/^other:/, "");
  if (SPEC[k] && k !== "_regions") return { ...SPEC[k], kind: "exact" };
  if (/(^|_)(mass|weight|bmi|fat)(_|$)/.test(k)) return { ...SPEC.mass, kind: "exact" };
  const hit = SPEC._regions.find(([re]) => re.test(k));
  return hit ? { pose: hit[1], m: [{ k: "r", ...hit[2] }], kind: "region" } : { pose: "stand", m: [], kind: "none" };
}

// ---- drawing --------------------------------------------------------------------------------------
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

let maskId = 0;
function figure(sexCode, key, zoom, name) {
  const sex = sexCode === "F" ? "F" : "M";
  const spec = specFor(key, sex);
  const sp = dataOf(sex).sprite[spec.pose === "stand" ? "stand" : "sit"];
  const box = zoom ? targetBox(spec.pose, spec.m) : BASE[spec.pose];
  const r = box.w / 62;
  const svg = s("svg", { role: "img", "aria-label": `${name}: where it is measured on the ${sex === "F" ? "female" : "male"} body`, preserveAspectRatio: "xMidYMid meet" });
  const B = BASE[spec.pose];
  const img = () => s("image", { href: `img/body/${sex}_${spec.pose === "stand" ? "stand" : "sit"}.webp`, x: sp.x, y: sp.y, width: sp.w, height: sp.h });
  if (spec.pose === "stand") svg.append(s("line", { x1: B.x + 20, y1: 451, x2: B.x + B.w - 20, y2: 451, stroke: "var(--line-strong)", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
  else svg.append(
    s("path", { d: `M66 110V${SEAT + 1}H232M20 ${floorOf(sex)}H290`, fill: "none", stroke: "var(--line-strong)", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }));
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
  const spec = specFor(key, figures[0] && figures[0].sex);
  const note = spec.kind === "region" ? "No single landmark for this measure: the body region is highlighted."
    : spec.kind === "none" ? "This measure is not tied to one place on the body."
    : spec.tint ? "A whole-body measure." : "";
  const fmt = v => v == null ? "—" : `${fmtFixed(v, unit === "mm" ? 0 : 1)} ${unit}`;
  return h("div", { class: "mq-card" },
    h("div", { class: "mq-head" }, h("b", {}, "Where it is measured"),
      h("button", { class: "btn small", type: "button", "aria-pressed": String(zoom), onclick: onZoom, title: "Zoom the figure to the measured area" }, zoom ? "Zoom: on" : "Zoom: off")),
    h("div", { class: "mq-figs" }, figures.map(f => h("figure", { class: "mq-fig" },
      figure(f.sex, key, zoom, label),
      h("figcaption", {},
        h("span", { class: "mq-sex" }, h("i", { class: "swatch-dot", style: { background: `var(${f.color})` } }), f.label),
        h("b", { class: "mq-val" }, fmt(f.mean)),
        h("span", { class: "small muted" }, f.groups ? `${label} · mean of ${fmtInt(f.groups)} group${f.groups === 1 ? "" : "s"}${f.people ? `, ${fmtInt(f.people)} people` : ""}` : `${label} · no data for this selection`))))),
    note ? h("p", { class: "small muted", style: { margin: 0 } }, note) : null);
}
