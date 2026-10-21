// Skin generator: BodyModel (fit.js) + the rig's bones -> a smooth, closed, skinned mannequin (docs/human3d/MODEL.md section 6).
// Pure three.js, never touches the DOM. API: buildSkin(body, bones, { quality, color, eyes, detail }) -> { mesh, eyes, dispose(), stats }.
//   mesh   one THREE.SkinnedMesh, one MeshStandardMaterial, bound to a Skeleton of the rig's bones in skeleton.js JOINTS order;
//          mesh.userData.parts (= stats.parts) names the closed pieces and their vertex / triangle ranges (torso, head, ear_L/R, arm_L/R,
//          leg_L/R, foot_L/R, index_L ... thumb_R); tube parts also carry { cols, rows } (vertices per ring, rings)
//   eyes   a second SkinnedMesh (vertex colours: sclera, iris, pupil) on the same skeleton, skinned to eye_L / eye_R; it is a CHILD of mesh
//          (rig.js traverses the mesh, so visibility, x-ray and disposal follow); null with options.eyes === false
//   options.quality "high" (default, about 47,000 triangles) | "low" (about 18,000); options.color: any THREE.Color argument;
//   options.detail: false leaves the face smooth (no nose, brows, eyelids, mouth, chin: the head is the bare superellipsoid)
//
// How the surface is made. Every part is a lofted tube. The coarse superellipse rings of body.shape (5 to 10 per tube) are interpolated
// (C2 cubic splines for the limbs, whose rings are smooth; monotone cubic Hermite for the trunk, whose rings jump) into 25 to 70 rings per
// piece, denser at the joints; each ring is sampled at equal arc length (a boxy chest ring has as many vertices on its flat sides as on its
// corners) in a HORIZONTAL plane: the fit's rings are horizontal sections (measured and fitted so), and rings perpendicular to a leaning centre
// line lift the outer edge of a shoulder whose arm is pushed outward (a balloon above the trapezius) and fold a thigh whose centre jumps
// between two rings. Pieces the fit stores apart are welded into one tube: trunk + neck (crotch to inside the head), upper arm + forearm + palm
// (the elbow ring is shared, the shoulder is capped by a dome inside the trunk), thigh + shank (the two knee rings are averaged) + ankle. Closed
// ends are domes (a fan to an apex vertex). The head is a grid of cranium + face rings with smooth displacement fields (nose, brow, eyelids,
// mouth, chin); ears are small closed pieces; fingers are capsules with round tips; feet are lofted along z. Parts overlap where the body does
// (shoulder dome in the trunk, finger roots in the palm, shank in the foot, thigh tops in the pelvis): every part is a closed, consistently wound
// 2-manifold on its own and they intersect, they are never merged.
//
// The hip (the thigh into the pelvis) is where two lofts meet, and the fit's data do not agree there: the thigh is a circle of the measured
// girth whose centre lies forward so that its back meets the buttock, and in a woman it stands 11 mm (median) to 73 mm in front of the belly
// and wider than the hips. The torso ends in a bowl under the buttock ring (addBowl: a quarter ellipse of width, S curves of depth that run into
// the back of the thigh at the gluteal furrow) and fitLegToTrunk shapes the thigh from the furrow upward: its front is cut by a plane that leans
// back at 27 degrees from the trunk's front at the buttock ring, its outer edge is brought to the hip's, its back is brought out under the
// buttock, the medial faces are flattened where the fit lets the thighs cross the midline. The crease is a clean line at a clear angle, no ball
// is left in front of the pelvis, no shelf under it.
//
// Deviations from the data of fit.js, all deliberate and visible in the test log: the front of the shoulder ring is raised so the chest has
// no notch; the thigh is faired into the trunk as above (the thigh at the furrow, which is measured, is untouched; its girth is kept within
// 1.3 %); the upper arm has no skin wider than the measured half bideltoid breadth within 40 mm of the deltoid and above it (the fit's
// deltoid ring is up to 34 mm wider for a narrow shoulder); the head's dome is a superellipsoid, its back follows the cranium down to the tragion,
// face rings are smoothed (valleys filled, Gaussian 7 mm), the front of the face is flatter than the ring ellipses so that the pupils are on it;
// the last foot station (the toe tip) is widened, and the foot is 5 mm wider than the shank around the ankle; ring.bind is not used (below).
// Required of the BodyModel: positions (all joints), shape.tubes (torso with rings axilla, shoulder, trapezius, neck_base, buttock and optionally
// crotch; neck; upper_arm / forearm / thigh / shank _L and _R), shape.head (rings incl. brow, cranium, features), shape.hands, shape.feet,
// landmarks.crotch (optional), stature; optional: report (the measured bideltoid breadth).
//
// Skin weights are recomputed from the geometry (ring.bind is not used; docs/human3d/MODEL.md 6.4). The trunk and neck follow the spine chain
// (the two joints that bracket the height, as the fit does); the lateral shoulder rings also follow the clavicle. Limbs blend over about a fifth
// of the bone on each side of a joint (the fit's 15 % loses more volume at a bent knee), and the blend is 2.5 times wider on the inside of the
// bend (back of the knee, front of the elbow): when the knee bends 150 degrees the back of the thigh sinks 59 mm into the calf with the short
// blend, 11 to 27 mm with the wide one (body.test.mjs measures it). The arm and the thigh are rigid with their joint from the joint ring down,
// the dome above it fades to half and half with the clavicle / pelvis (a ring blended half and half collapses when the arm is raised 170
// degrees). The forearm roll joint carries the hand only (the forearm skin is skinned to elbow and wrist; the twist of a pronated forearm is a
// pinch at the wrist, "candy wrapper" is not modelled), each phalanx follows its own joint with a half-and-half blend at the knuckles, the foot
// follows the ankle and the toes the mtp joint. The jaw joint carries no skin. At most 4 influences per vertex, weights are multiples of 2^-16
// that sum to exactly 1 (so that skinning at rest returns every vertex bit for bit). Linear blend skinning loses volume where a joint bends far
// (a knee at 150 degrees keeps 88 % of the leg, a trunk bent 100 degrees 83 % of the heavy man's trunk) and folds a few triangles at the inner
// side: that is the method, a corrective shape would be needed to avoid it.
//
// Rest pose: the inverse bind matrices are translate(-neutral joint centre) from body.positions (identity rotations) and the bind matrix is
// the identity, so skinning at rest reproduces the geometry whatever pose the bones are in when buildSkin is called; the bones are not touched.
import * as THREE from "three";
import { JOINTS } from "./skeleton.js";

const PI = Math.PI;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth minimum (polynomial, C1): within k of each other the two values blend, so clamping a section to the trunk leaves no crease. */
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - 0.25 * k * h * h; };
const smax = (a, b, k) => -smin(-a, -b, k);
/** Perimeter of an ellipse of semi-axes a, b (Ramanujan's second approximation). */
const ellipseP = (a, b) => { const h = ((a - b) / (a + b)) ** 2; return PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))); };
const DEFAULT_COLOR = 0xcbbfb2; // warm light grey: reads on the light (#ecebe6) and the dark (#161615) viewport

// Resolution presets. cols = vertices around a tube (multiple of 4); d* = target ring spacing (m), coarse and near a joint.
const QUALITY = {
  high: {
    capV: 40000, capT: 90000,
    torso: { cols: 56, dBase: 0.015, dFine: 0.0075 },
    arm: { cols: 32, dBase: 0.011, dFine: 0.0055 },
    leg: { cols: 36, dBase: 0.013, dFine: 0.0065 },
    head: { cols: 80, dFace: 0.0035, dSkull: 0.0075, dome: 5, a: 0.42 },
    ear: { rings: 5, cols: 20 },
    finger: { cols: 16, tip: 4, dBase: 0.0045 },
    foot: { cols: 36, dz: 0.008, dome: 3 },
    eye: { cols: 20, rows: [0, 6, 11, 14, 20, 26, 31, 35, 45, 60, 80, 100, 120, 140, 160, 175, 180] },
    dome: 3,
  },
  low: {
    capV: 16000, capT: 36000,
    torso: { cols: 32, dBase: 0.026, dFine: 0.014 },
    arm: { cols: 20, dBase: 0.02, dFine: 0.011 },
    leg: { cols: 24, dBase: 0.024, dFine: 0.013 },
    head: { cols: 64, dFace: 0.0045, dSkull: 0.011, dome: 5, a: 0.58 },
    ear: { rings: 3, cols: 12 },
    finger: { cols: 8, tip: 2, dBase: 0.0075 },
    foot: { cols: 24, dz: 0.016, dome: 2 },
    eye: { cols: 12, rows: [0, 11, 20, 31, 45, 80, 120, 160, 180] },
    dome: 2,
  },
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Monotone cubic Hermite interpolation of several channels over the same knots.
function slopes(xs, ys, limited) {
  const n = xs.length, m = new Float64Array(n);
  if (n < 2) return m;
  const h = new Float64Array(n - 1), d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  if (n === 2) { m[0] = m[1] = d[0]; return m; }
  for (let i = 1; i < n - 1; i++) {
    if (limited) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
    } else m[i] = (h[i] * d[i - 1] + h[i - 1] * d[i]) / (h[i - 1] + h[i]); // Catmull-Rom tangent on uneven knots
  }
  const end = (h0, h1, d0, d1) => {
    const v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (!limited) return v;
    if (v * d0 <= 0) return 0;
    return d0 * d1 <= 0 && Math.abs(v) > 3 * Math.abs(d0) ? 3 * d0 : v;
  };
  m[0] = end(h[0], h[1], d[0], d[1]);
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** Slopes of the C2 cubic spline through (xs, ys) (tridiagonal solve): natural at the end without a given slope, clamped at the end with one. */
function slopesC2(xs, ys, m0, m1) {
  const n = xs.length, m = new Float64Array(n);
  if (n < 3) { for (let i = 0; i < n; i++) m[i] = n === 2 ? (ys[1] - ys[0]) / (xs[1] - xs[0]) : 0; if (m0 != null) m[0] = m0; if (m1 != null) m[n - 1] = m1; return m; }
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n);
  const h = (i) => xs[i + 1] - xs[i], dl = (i) => (ys[i + 1] - ys[i]) / h(i);
  for (let i = 1; i < n - 1; i++) { a[i] = h(i); b[i] = 2 * (h(i - 1) + h(i)); c[i] = h(i - 1); d[i] = 3 * (h(i) * dl(i - 1) + h(i - 1) * dl(i)); }
  if (m0 != null) { b[0] = 1; c[0] = 0; d[0] = m0; } else { b[0] = 2; c[0] = 1; d[0] = 3 * dl(0); }
  if (m1 != null) { b[n - 1] = 1; a[n - 1] = 0; d[n - 1] = m1; } else { b[n - 1] = 2; a[n - 1] = 1; d[n - 1] = 3 * dl(n - 2); }
  for (let i = 1; i < n; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
  m[n - 1] = d[n - 1] / b[n - 1];
  for (let i = n - 2; i >= 0; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
  return m;
}

class Spline {
  /** xs: strictly increasing knots; chans: arrays of values; limited[c]: apply the monotone limiter to channel c; first/last: optional end slopes per channel. */
  constructor(xs, chans, limited, first, last, c2 = false) {
    this.xs = xs; this.ys = chans; this.n = xs.length;
    this.m = chans.map((y, c) => (c2 ? slopesC2(xs, y, first ? first[c] : null, last ? last[c] : null) : slopes(xs, y, limited[c])));
    if (first) first.forEach((v, c) => { if (v != null) this.m[c][0] = v; });
    if (last) last.forEach((v, c) => { if (v != null) this.m[c][this.n - 1] = v; });
  }
  at(x, out) {
    const xs = this.xs, n = this.n;
    let i;
    if (x <= xs[0]) i = 0;
    else if (x >= xs[n - 1]) i = n - 2;
    else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; } i = lo; }
    const h = xs[i + 1] - xs[i], t = clamp((x - xs[i]) / h, 0, 1), t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    for (let c = 0; c < this.ys.length; c++) {
      const y = this.ys[c], m = this.m[c];
      out[c] = h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1];
    }
    return out;
  }
}

/** Ring parameters between knots: n_k = integral of ds / d(s) per interval (d = local target spacing), placed at equal steps of that integral; knots are always included. */
function distribute(knots, dens) {
  const out = [knots[0]];
  for (let k = 0; k < knots.length - 1; k++) {
    const a = knots[k], b = knots[k + 1], L = b - a;
    if (L < 1e-9) continue;
    const S = 12, cum = new Float64Array(S + 1);
    for (let i = 0; i < S; i++) cum[i + 1] = cum[i] + (L / S) / dens(a + (i + 0.5) * (L / S));
    const nn = Math.max(1, Math.round(cum[S]));
    for (let j = 1; j < nn; j++) {
      const target = (cum[S] * j) / nn;
      let i = 0;
      while (i < S - 1 && cum[i + 1] < target) i++;
      const f = (target - cum[i]) / (cum[i + 1] - cum[i] || 1);
      out.push(a + (i + f) * (L / S));
    }
    out.push(b);
  }
  return out;
}
/** d(s) = dFine within w of an anchor, growing smoothly to dBase. */
const densityOf = (anchors, dBase, dFine, w) => (s) => {
  let dist = Infinity;
  for (const a of anchors) { const d = Math.abs(s - a); if (d < dist) dist = d; }
  return dFine + (dBase - dFine) * sstep(dist / w);
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Geometry buffers (preallocated, grown only if the estimate is exceeded)
class Geo {
  constructor(capV, capT) {
    this.nv = 0; this.nt = 0;
    this.alloc(capV, capT);
    this.ti = new Int32Array(8); this.tw = new Float64Array(8);
  }
  alloc(cv, ct) {
    const old = this.pos ? this : null;
    const pos = new Float32Array(cv * 3), si = new Uint16Array(cv * 4), sw = new Float32Array(cv * 4), idx = new Uint32Array(ct * 3);
    if (old) { pos.set(old.pos.subarray(0, old.nv * 3)); si.set(old.si.subarray(0, old.nv * 4)); sw.set(old.sw.subarray(0, old.nv * 4)); idx.set(old.idx.subarray(0, old.nt * 3)); }
    this.capV = cv; this.capT = ct; this.pos = pos; this.si = si; this.sw = sw; this.idx = idx;
  }
  v(x, y, z) {
    if (this.nv >= this.capV) this.alloc(Math.ceil(this.capV * 1.5), this.capT);
    const o = this.nv * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    return this.nv++;
  }
  t(a, b, c) {
    if (this.nt >= this.capT) this.alloc(this.capV, Math.ceil(this.capT * 1.5));
    const o = this.nt * 3;
    this.idx[o] = a; this.idx[o + 1] = b; this.idx[o + 2] = c;
    return this.nt++;
  }
  /** Up to 4 influences: the 4 heaviest of the n given (indices unique), renormalised. */
  setW(v, wi, ww, n) {
    const o = v * 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1, bw = 0;
      for (let i = 0; i < n; i++) if (ww[i] > bw) { bw = ww[i]; best = i; }
      if (best < 0) { this.si[o + k] = 0; this.sw[o + k] = 0; continue; }
      this.si[o + k] = wi[best]; this.sw[o + k] = bw; sum += bw;
      ww[best] = -ww[best]; // mark as taken (restored below)
    }
    for (let i = 0; i < n; i++) if (ww[i] < 0) ww[i] = -ww[i];
    if (!(sum > 0)) { this.si[o] = wi[0] ?? 0; this.sw[o] = 1; this.sw[o + 1] = this.sw[o + 2] = this.sw[o + 3] = 0; return; }
    // Weights are multiples of 2^-16 and the heaviest takes the remainder: they are exact in a Float32, and their sum is exactly 1, so that
    // skinning at rest returns the vertex bit for bit (with weights rounded to floats the sum is off by 6e-8 and the whole body shrinks by that).
    const inv = 1 / sum;
    let rest = 1;
    for (let k = 3; k >= 1; k--) { const w = Math.round(this.sw[o + k] * inv * 65536) / 65536; this.sw[o + k] = w; rest -= w; }
    this.sw[o] = rest;
  }
}

// Superellipse |x/rx|^n + |z/rz|^n = 1 sampled at equal arc length: M points (multiple of 4), the first at +x, the (M/4)-th at +z.
const QN = 64;
const QX = new Float64Array(QN + 1), QZ = new Float64Array(QN + 1), QS = new Float64Array(QN + 1);
const RX = new Float64Array(512), RZ = new Float64Array(512);
function superRing(rx, rz, n, M, ox, oz) {
  const e = 2 / n;
  QS[0] = 0;
  for (let k = 0; k <= QN; k++) {
    const t = (k / QN) * (PI / 2);
    QX[k] = rx * Math.pow(Math.cos(t), e); QZ[k] = rz * Math.pow(Math.sin(t), e);
    if (k > 0) QS[k] = QS[k - 1] + Math.hypot(QX[k] - QX[k - 1], QZ[k] - QZ[k - 1]);
  }
  const Q = M >> 2, L = QS[QN];
  let k = 0;
  for (let j = 0; j <= Q; j++) {
    const target = (L * j) / Q;
    while (k < QN - 1 && QS[k + 1] < target) k++;
    const f = clamp((target - QS[k]) / (QS[k + 1] - QS[k] || 1), 0, 1);
    const x = lerp(QX[k], QX[k + 1], f), z = lerp(QZ[k], QZ[k + 1], f);
    ox[j] = x; oz[j] = z;
    if (j > 0 && j < Q) { // the other three quadrants by symmetry
      ox[2 * Q - j] = -x; oz[2 * Q - j] = z;
      ox[2 * Q + j] = -x; oz[2 * Q + j] = -z;
      ox[4 * Q - j] = x; oz[4 * Q - j] = -z;
    }
  }
  ox[2 * Q] = -ox[0]; oz[2 * Q] = 0;
  ox[3 * Q] = 0; oz[3 * Q] = -oz[Q];
  ox[Q] = 0; // exact pole
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rows: the refined rings of a tube. A row has its centre, radii, exponent, the frame of its plane, and its skin weights.
function makeRows(spline, params, sign) {
  // channels: 0 cx, 1 cz, 2 rx, 3 rz, 4 n; the parameter is y (sign +1: rows go up) or -y (rows go down)
  const out = [], v = new Float64Array(5);
  for (const s of params) {
    spline.at(s, v);
    out.push({ cx: v[0], cy: sign * s, cz: v[1], rx: Math.max(v[2], 0.003), rz: Math.max(v[3], 0.003), n: clamp(v[4], 1.6, 12), wi: null, ww: null, wn: 0 });
  }
  return out;
}
/** Tangent of the centre line and the frame (ex, ez) of every row; the plane is perpendicular to the tangent, or horizontal (the trunk: its rings are horizontal sections, measured and fitted so). */
function frames(rows, horizontal = false) {
  const R = rows.length;
  for (let r = 0; r < R; r++) {
    const a = rows[Math.max(r - 1, 0)], b = rows[Math.min(r + 1, R - 1)], w = rows[r];
    let tx = b.cx - a.cx, ty = b.cy - a.cy, tz = b.cz - a.cz;
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    w.tx = tx; w.ty = ty; w.tz = tz;
    if (horizontal) { w.exx = 1; w.exy = 0; w.exz = 0; w.ezx = 0; w.ezy = 0; w.ezz = 1; continue; }
    const s = ty < 0 ? -1 : 1, ux = s * tx, uy = s * ty, uz = s * tz; // pointing up
    let ex = 1 - ux * ux, ey = -ux * uy, ez = -ux * uz; // X minus its component along U
    const le = Math.hypot(ex, ey, ez) || 1;
    ex /= le; ey /= le; ez /= le;
    w.exx = ex; w.exy = ey; w.exz = ez; // ez = ex x U
    w.ezx = ey * uz - ez * uy; w.ezy = ez * ux - ex * uz; w.ezz = ex * uy - ey * ux;
  }
}
/** A dome of k rings and an apex closing one end of a row list (start: before the first row). Returns the apex { x, y, z }. */
function addDome(rows, atEnd, h, k, vertical = false) {
  const e = atEnd ? rows[rows.length - 1] : rows[0], dir = atEnd ? 1 : -1;
  const dx = vertical ? 0 : e.tx * dir, dy = vertical ? dir : e.ty * dir, dz = vertical ? 0 : e.tz * dir; // the trunk's rings are horizontal: its domes grow straight up or down
  const add = [];
  for (let i = 1; i <= k; i++) {
    const th = (PI / 2) * (i / (k + 1)), c = Math.cos(th), s = Math.sin(th);
    add.push({ ...e, cx: e.cx + dx * h * s, cy: e.cy + dy * h * s, cz: e.cz + dz * h * s, rx: e.rx * c, rz: e.rz * c });
  }
  if (atEnd) rows.push(...add); else rows.unshift(...add.reverse());
  return { x: e.cx + dx * h, y: e.cy + dy * h, z: e.cz + dz * h, row: e };
}

/** The pelvis: horizontal rings of k steps under the first row (the buttock ring), dropping by h to a point. The width shrinks like a quarter
 *  ellipse (a vertical tangent at the hip ring: no notch in the silhouette where the thigh takes over), the front retreats to fB and the back comes forward to bB
 *  along S curves with a vertical tangent at both ends: the lower buttock is a round form that runs into the back of the thigh at bB, not a
 *  shelf. Returns the apex. */
function addBowl(rows, h, k, zTarget, fB, bB) {
  const e = rows[0], add = [], F0 = e.cz + e.rz, B0 = e.cz - e.rz;
  for (let i = 1; i <= k; i++) {
    const t = i / (k + 1), u = sstep(t), F = lerp(F0, fB, u), B = lerp(B0, bB, u);
    add.push({ ...e, cy: e.cy - h * t, cz: 0.5 * (F + B), rx: e.rx * Math.sqrt(1 - t * t), rz: 0.5 * (F - B), n: lerp(e.n, 2, u) });
  }
  rows.unshift(...add.reverse());
  return { x: 0, y: e.cy - h, z: zTarget, row: e };
}

/** Vertices and triangles of a tube. up: the rows go up (+y). apexA / apexB close the first / last row with a fan. hook(row, x, y, z, j, wi, ww) -> n overrides the weights of a vertex. */
function emitTube(g, rows, M, up, apexA, apexB, hook) {
  const R = rows.length, v0 = g.nv, t0 = g.nt;
  for (let r = 0; r < R; r++) {
    const w = rows[r];
    superRing(w.rx, w.rz, w.n, M, RX, RZ);
    for (let j = 0; j < M; j++) {
      const a = RX[j], b = RZ[j];
      const x = w.cx + w.exx * a + w.ezx * b, y = w.cy + w.exy * a + w.ezy * b, z = w.cz + w.exz * a + w.ezz * b;
      const v = g.v(x, y, z);
      if (hook) { const n = hook(w, x, y, z, j, g.ti, g.tw); g.setW(v, g.ti, g.tw, n); }
      else { for (let i = 0; i < w.wn; i++) { g.ti[i] = w.wi[i]; g.tw[i] = w.ww[i]; } g.setW(v, g.ti, g.tw, w.wn); }
    }
  }
  for (let r = 0; r < R - 1; r++) {
    const A = v0 + r * M, B = A + M;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M, a = A + j, b = A + j1, c = B + j1, d = B + j;
      if (up) { g.t(a, c, b); g.t(a, d, c); } else { g.t(a, b, c); g.t(a, c, d); }
    }
  }
  const apex = (ap, row, ring0, atEnd) => {
    const v = g.v(ap.x, ap.y, ap.z);
    if (hook) { const n = hook(row, ap.x, ap.y, ap.z, 0, g.ti, g.tw); g.setW(v, g.ti, g.tw, n); }
    else { for (let i = 0; i < row.wn; i++) { g.ti[i] = row.wi[i]; g.tw[i] = row.ww[i]; } g.setW(v, g.ti, g.tw, row.wn); }
    for (let j = 0; j < M; j++) {
      const a = ring0 + j, b = ring0 + ((j + 1) % M);
      if (up !== atEnd) g.t(a, b, v); else g.t(b, a, v);
    }
  };
  if (apexA) apex(apexA, rows[0], v0, false);
  if (apexB) apex(apexB, rows[R - 1], v0 + (R - 1) * M, true);
  return { v0, v1: g.nv, t0, t1: g.nt, cols: M, nrows: R };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Skin weights. Everything is expressed with the indices of the skeleton's bone list.
class Weights {
  constructor(body, idx) {
    this.pos = body.positions; this.idx = idx;
  }
  I(id) {
    const i = this.idx.get(id);
    if (i === undefined) throw new Error(`buildSkin: the bone "${id}" is missing from the bones map`);
    return i;
  }
  y(id) { return this.pos[id][1]; }
  /** Spine chain: the two joints that bracket the height, linear in y (as fit.js bindAlong). */
  chain(y, out) {
    const ids = this.chainIds ??= ["pelvis", "L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1", "head"];
    const ys = this.chainY ??= ids.map((id) => this.y(id)), ix = this.chainI ??= ids.map((id) => this.I(id));
    const n = ids.length;
    if (y <= ys[0]) { out.i0 = ix[0]; out.i1 = -1; out.t = 0; return out; }
    for (let k = 1; k < n; k++) if (y <= ys[k]) { out.i0 = ix[k - 1]; out.i1 = ix[k]; out.t = (y - ys[k - 1]) / (ys[k] - ys[k - 1]); return out; }
    out.i0 = ix[n - 1]; out.i1 = -1; out.t = 0;
    return out;
  }
}

/** Weights of a limb at height y written to wi / ww (no allocation): bones[0] above the first joint, bones[k] between joint k and k+1, blended over +-hs[k] around joint height ys[k]. Returns the count. */
function limbW(y, bones, ys, hs, wi, ww) {
  let n = 0, prev = 1; // u_0 = 1
  for (let k = 0; k < bones.length; k++) {
    const u = k + 1 < bones.length ? sstep((ys[k + 1] + hs[k + 1] - y) / (2 * hs[k + 1])) : 0; // transition into bone k+1
    const w = prev - u;
    if (w > 1e-6) { wi[n] = bones[k]; ww[n] = w; n++; }
    prev = u;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Parts
const BACK_BLEND = 2.5, FRONT_BLEND = 2.5; // blend widening on the inner side of the knee (back) and the elbow (front), see buildLeg and buildArm

/** Merge ring lists (arrays of { y, c: [cx, cz, rx, rz, n] }) that are sorted by y descending or ascending, averaging rings closer than eps. */
function ringKnots(rings, sign) {
  const k = rings.map((r) => ({ s: sign * r.c[1], ch: [r.c[0], r.c[2], r.rx, r.rz, r.n] })).sort((a, b) => a.s - b.s);
  const out = [];
  for (const r of k) {
    const last = out[out.length - 1];
    if (last && r.s - last.s < 0.0015) { for (let c = 0; c < 5; c++) last.ch[c] = 0.5 * (last.ch[c] + r.ch[c]); last.s = 0.5 * (last.s + r.s); }
    else out.push({ s: r.s, ch: r.ch.slice() });
  }
  return out;
}
function splineOf(knots, c2 = false) {
  const xs = Float64Array.from(knots, (k) => k.s);
  const chans = [0, 1, 2, 3, 4].map((c) => Float64Array.from(knots, (k) => k.ch[c]));
  return new Spline(xs, chans, [false, false, true, true, true], null, null, c2);
}

/** Trunk + neck: one tube from the crotch up into the head. */
function buildTorso(ctx) {
  const { body, g, Q, W } = ctx, T = body.shape.tubes, q = Q.torso;
  const crotch = T.torso.rings.find((r) => r.id === "crotch");
  const rings = [...T.torso.rings.filter((r) => r.id !== "crotch"), ...T.neck.rings.slice(1)].map((r) => ({ ...r, c: r.c.slice() }));
  // The fit's "shoulder" ring is a flat ellipse centred behind the spine, so its front lies up to 25 mm behind the rings above and below it:
  // lofted through, the chest would end in a ledge and a notch. Above the axilla the front of every ring is raised to the one above it (the
  // front never recedes going up and then comes forward again); the back and the widths are untouched.
  {
    const i0 = rings.findIndex((r) => r.id === "axilla");
    let front = -Infinity;
    for (let i = rings.length - 1; i > i0 && i0 >= 0; i--) {
      const r = rings[i], f = r.c[2] + r.rz;
      if (f < front) { const back = r.c[2] - r.rz; r.rz = 0.5 * (front - back); r.c[2] = 0.5 * (front + back); } else front = f;
    }
  }
  const kn = ringKnots(rings, 1), sp = splineOf(kn);
  const s0 = kn[0].s, s1 = kn[kn.length - 1].s;
  const yOf = (id) => W.y(id);
  const anchors = [s0 + 0.01, yOf("pelvis"), yOf("L5"), ctx.ringY("torso", "neck_base")].filter((a) => a >= s0 && a <= s1);
  const params = distribute(kn.map((k) => k.s), densityOf(anchors, q.dBase, q.dFine, 0.05));
  const rows = makeRows(sp, params, 1);
  frames(rows, true);
  const tmp = {};
  for (const r of rows) {
    const c = W.chain(r.cy, tmp);
    r.wi = [c.i0]; r.ww = [c.i1 >= 0 ? 1 - c.t : 1]; r.wn = 1;
    if (c.i1 >= 0) { r.wi.push(c.i1); r.ww.push(c.t); r.wn = 2; }
  }
  // The pelvis ends in a bowl under the buttock ring instead of the fit's crotch ring (21 mm below it and 40 % narrower: lofted through, the
  // underside of the hips is a flat shelf that shows as wings when the thighs abduct, and the pelvis a flat plate between them). The bowl
  // (addBowl) is a quarter ellipse of width that leaves the buttock ring with a vertical tangent; it ends 12 mm below the crotch landmark, or
  // lower where the buttock overhangs the thigh (below); in the neutral pose the thighs cover all of it but the lower buttock and the crotch.
  const lm = body.landmarks?.crotch, yCrotch = lm ? body.positions.pelvis[1] + lm.offset[1] : (crotch ? crotch.c[1] - 0.02 : rows[0].cy - 0.06);
  const bottomY = Math.min(yCrotch - 0.012, rows[0].cy - 0.02), bowlZ = crotch ? crotch.c[2] : rows[0].cz + 0.03;
  // The bowl goes down to the furrow of the thigh where the buttock ends (the gluteal fold) when the buttock overhangs the back of the thigh
  // (the fit's thigh is a circle whose back is up to 140 mm in front of the buttock), and runs into the back of the thigh there; at least to
  // 12 mm under the crotch landmark.
  const b0 = rows[0], pre = prepLeg(ctx, "L"), furrow = pre.rows.reduce((m, r) => (Math.abs(r.cy - pre.yF) < Math.abs(m.cy - pre.yF) ? r : m)), thBack = furrow.cz - furrow.rz;
  const shelf = Math.max(thBack - (b0.cz - b0.rz), 0), bottom = Math.max(Math.min(bottomY, b0.cy - 0.8 * shelf), pre.yF + 0.01);
  const fB = lerp(b0.cz + b0.rz, bowlZ, 0.7), bB = Math.min(Math.max(thBack, b0.cz - b0.rz), fB - 0.04);
  const A = addBowl(rows, b0.cy - bottom, Q.dome + 3, bowlZ, fB, bB), B = addDome(rows, true, Math.max(0.012, rows[rows.length - 1].rz * 0.3), Q.dome, true);
  const iclL = W.I("clavicle_L"), iclR = W.I("clavicle_R");
  const yAx = ctx.ringY("torso", "axilla"), ySh = ctx.ringY("torso", "shoulder"), yTr = ctx.ringY("torso", "trapezius"), yNb = ctx.ringY("torso", "neck_base");
  const hook = (row, x, y, z, j, wi, ww) => {
    let n = row.wn;
    for (let i = 0; i < n; i++) { wi[i] = row.wi[i]; ww[i] = row.ww[i]; }
    // shoulder girdle: the lateral part of the shoulder / trapezius rings follows the clavicle
    const ax = Math.abs(x);
    const e = sstep((y - yAx) / (ySh - yAx)) * (1 - sstep((y - yTr) / (yNb - yTr)));
    const wc = 0.55 * e * sstep((ax - 0.07) / 0.09);
    if (wc > 1e-4) {
      for (let i = 0; i < n; i++) ww[i] *= 1 - wc;
      wi[n] = x > 0 ? iclL : iclR; ww[n] = wc; n++;
    }
    return n;
  };
  // the trunk's outline by height, for the legs (see buildLeg): rows are sorted by y ascending, the section is a superellipse
  const hy = rows.map((r) => r.cy);
  const at = (y) => { // the section between two rows, linear in y
    let i = 1;
    while (i < hy.length - 1 && y > hy[i]) i++;
    const a = rows[i - 1], b = rows[i], f = clamp((y - a.cy) / (b.cy - a.cy || 1), 0, 1);
    return { cz: lerp(a.cz, b.cz, f), rx: lerp(a.rx, b.rx, f), rz: lerp(a.rz, b.rz, f), n: lerp(a.n, b.n, f) };
  };
  const edge = (r, x) => Math.pow(Math.max(1 - Math.pow(Math.min(Math.abs(x) / (r.rx || 1), 0.8), r.n), 1e-6), 1 / r.n); // z of the superellipse at x, in units of rz
  ctx.trunk = {
    half: (y) => at(y).rx,
    hip: b0, // the buttock ring: the widest part of the pelvis
    // front / back of the trunk at height y over the lateral position x (beyond 0.8 of the half width the value at 0.8 is used)
    front: (y, x) => { const r = at(y); return r.cz + r.rz * edge(r, x); },
    back: (y, x) => { const r = at(y); return r.cz - r.rz * edge(r, x); },
  };
  return emitTube(g, rows, Q.torso.cols, true, A, B, hook);
}

/**
 * The deltoid is the widest part of the arm: its outer edge is at half the bideltoid breadth. The fit puts the ring there, except for a narrow
 * shoulder (it keeps the section at least 45 mm wide and 60 mm lateral to the axis: 34 mm too wide for a woman of the 5th percentile of the
 * US Army), and the rings below it are pushed outward to clear the trunk (armShift), a big estimated biceps adding to that, so the arm was up
 * to 70 mm wider across the biceps than across the shoulders. Here no skin within 40 mm of the deltoid (and none above it) reaches beyond the
 * measured half breadth (the ring's own edge when it is not measured); further down the outer edge may grow by 0.25 per unit of height, at
 * most 12 mm, down to the elbow. A section is narrowed from the outside and deepened to give back its girth.
 */
function fitArmToDeltoid(rows, dl, sgn, half, yElbow) {
  if (!dl) return;
  const yD = dl.c[1], outerD = Math.min(sgn * dl.c[0] + dl.rx, half ?? Infinity);
  for (const row of rows) {
    if (row.cy < yElbow) break; // the forearm and the hand hang where they hang (the rows run downward)
    const below = Math.max(yD - row.cy, 0);
    const inner = sgn * row.cx - row.rx, outer = sgn * row.cx + row.rx, limit = outerD + 0.0005 + Math.min(0.25 * Math.max(below - 0.04, 0), 0.012);
    if (outer <= limit) continue;
    const outer2 = Math.max(smin(outer, limit, 0.008), inner + 0.6 * row.rx), rx = 0.5 * (outer2 - inner), p0 = ellipseP(row.rx, row.rz);
    let rz = row.rz;
    for (let i = 0; i < 4; i++) rz *= p0 / ellipseP(rx, rz);
    row.rz = Math.min(rz, 1.3 * row.rz); row.rx = rx; row.cx = sgn * (inner + rx);
  }
}

/** Arm: shoulder dome, upper arm, forearm and palm as one tube. */
function buildArm(ctx, s) {
  const { body, g, Q, W } = ctx, T = body.shape.tubes, hand = body.shape.hands[s], q = Q.arm;
  const rings = [...T[`upper_arm_${s}`].rings, ...T[`forearm_${s}`].rings.slice(1)];
  for (const r of hand.palm.slice(1)) rings.push(r); // the forearm's own wrist ring stands for the palm's first ring
  const kn = ringKnots(rings, -1), sp = splineOf(kn, true); // C2 for the limbs: no overshoot there (<= 2 mm from the monotone one) and no rows in the shading
  const yS = W.y(`shoulder_${s}`), yE = W.y(`elbow_${s}`), yW = W.y(`wrist_${s}`);
  const anchors = [-yS, -yE, -yW];
  const params = distribute(kn.map((k) => k.s), densityOf(anchors, q.dBase, q.dFine, 0.05));
  const rows = makeRows(sp, params, -1);
  const bid = body.report?.find((r) => r.id === "bideltoid_breadth" && r.kind === "measure")?.input; // mm, null when it was not measured
  fitArmToDeltoid(rows, T[`upper_arm_${s}`].rings.find((r) => r.id === "ua_deltoid"), s === "L" ? 1 : -1, bid > 0 ? bid / 2000 : undefined, W.y(`elbow_${s}`));
  frames(rows, true); // the rings are horizontal sections: perpendicular rings of an arm that leans outward lift the outer edge of the shoulder (a balloon above the trapezius)
  const bones = [W.I(`shoulder_${s}`), W.I(`elbow_${s}`), W.I(`wrist_${s}`)], icl = W.I(`clavicle_${s}`);
  const hE = 0.2 * Math.min(yS - yE, yE - yW), hW = Math.min(0.09 * (yE - yW), 0.026);
  const capH = Math.max(0.02, rows[0].rx * 0.55);
  const A = addDome(rows, false, capH, Q.dome);
  const B = addDome(rows, true, Math.max(0.008, rows[rows.length - 1].rx * 0.8), Q.dome);
  // The elbow blend is FRONT_BLEND times wider on the inside of the bend (the front of the arm) than at the olecranon, as at the back of the knee.
  // The arm is rigid with the shoulder joint from the joint ring down (a linear-blend skin collapses a ring that is blended half and half
  // with the trunk when the arm is raised 170 degrees: the root of the arm pinched to a fin); the dome above the joint, which lies inside the
  // trunk's shoulder, fades to half and half with the clavicle at its apex, so that it neither dangles under the raised arm nor tears.
  const ysE = [0, yE, yW], hsE = [0, hE, hW];
  const hook = (row, x, y, z, j, wi, ww) => {
    const front = clamp(((z - row.cz) / row.rz + 0.6) / 1.6, 0, 1);
    hsE[1] = lerp(hE, FRONT_BLEND * hE, sstep(front));
    let n = limbW(y, bones, ysE, hsE, wi, ww);
    const c = y <= yS ? 0 : 0.5 * sstep((y - yS) / capH);
    if (c > 1e-4 && wi[0] === bones[0]) { const w0 = ww[0]; ww[0] = w0 * (1 - c); wi[n] = icl; ww[n] = w0 * c; n++; }
    return n;
  };
  return emitTube(g, rows, q.cols, false, A, B, hook);
}

/** The rows of the leg tube before it is fitted to the trunk (the torso needs the front of the thigh, buildLeg the whole of it). */
function prepLeg(ctx, s) {
  const cache = (ctx.legPre ??= {});
  if (cache[s]) return cache[s];
  const { body, Q, W } = ctx, T = body.shape.tubes, q = Q.leg;
  const rings = [...T[`thigh_${s}`].rings, ...T[`shank_${s}`].rings];
  const kn = ringKnots(rings, -1), sp = splineOf(kn, true);
  const yH = W.y(`hip_${s}`), yK = W.y(`knee_${s}`), yA = W.y(`ankle_${s}`);
  const params = distribute(kn.map((k) => k.s), densityOf([-yH, -yK, -yA], q.dBase, q.dFine, 0.06));
  const rows = makeRows(sp, params, -1);
  // the furrow ring (th_prox, the measured thigh girth) is the highest ring that stays as measured: the fairing into the trunk starts there
  const yF = T[`thigh_${s}`].rings.find((r) => r.id === "th_prox")?.c[1] ?? yH - 0.1;
  return (cache[s] = { rows, yH, yK, yA, yF });
}
/**
 * Fit the rows of a leg to the trunk (the thigh from the furrow upward, the hip dome included). The fit's thigh is a circle of the measured
 * girth whose centre lies forward so that its back meets the buttock; with a big thigh or a narrow trunk it stands up to 70 mm in front of
 * the belly and wider than the hips, and lofted as it is it shows as a ball in front of the pelvis and a ledge on the hip. Here the thigh is
 * cut by a plane that leans back at FAIR_SLOPE from the trunk's outline at the buttock ring (a clean crease, the groin, at a clear angle: two
 * surfaces that meet at a few degrees show a sawtooth), blended in from the furrow with a smooth minimum so that no kink is left; the back of
 * the thigh is brought out under the buttock so that the underside of the pelvis is not a shelf; the thighs may touch, not cross.
 */
const FAIR_SLOPE = 0.5;
function fitLegToTrunk(ctx, rows, pre, sgn) {
  const tr = ctx.trunk, { yF } = pre, yC = Math.max(tr.hip.cy - 0.02, yF + 0.03), hipHalf = tr.hip.rx; // yC: the crease line, 20 mm under the buttock ring (76 mm over the furrow at least in the data)
  for (const row of rows) {
    const w = sstep((row.cy - yF) / (yC - yF)), xc = Math.abs(row.cx), d = yC - row.cy; // d > 0 below the crease line
    let front = row.cz + row.rz, back = row.cz - row.rz, inner = sgn * row.cx - row.rx, outer = sgn * row.cx + row.rx;
    if (inner < 0.002) { // the thighs touch at most (the fit lets each cross the midline by up to 30 mm): the medial face is flattened and the depth grows to give back most of the girth
      const rx = 0.5 * (outer - 0.002), p1 = ellipseP(rx, row.rz), p0 = p1 + 0.85 * (ellipseP(row.rx, row.rz) - p1); // 85 % of the lost girth is given back
      let rz = row.rz;
      for (let i = 0; i < 4; i++) rz *= p0 / ellipseP(rx, rz);
      inner = 0.002; front = row.cz + rz; back = row.cz - rz;
    }
    if (row.cy > yF) {
      const up = tr.front(yC, xc) + FAIR_SLOPE * d, lo = Math.min(tr.front(row.cy, xc) - 0.004, up); // a thigh behind the belly is brought up to it
      front = lerp(front, smin(smax(front, lo, 0.012), up, 0.012), w);
      outer = lerp(outer, smin(outer, Math.min(hipHalf, tr.half(Math.max(row.cy, yC))) + 0.004 + FAIR_SLOPE * Math.min(d, 0), 0.012), w);
      back = lerp(back, Math.min(back, tr.back(row.cy, xc) - 0.003 - FAIR_SLOPE * Math.min(d, 0)), w);
    }
    outer = Math.max(outer, inner + 0.01); front = Math.max(front, back + 0.01);
    row.rx = 0.5 * (outer - inner); row.cx = sgn * (inner + row.rx);
    row.rz = 0.5 * (front - back); row.cz = 0.5 * (front + back);
  }
}

/** Leg: hip dome, thigh, shank and the ankle as one tube (the two knee rings are averaged). */
function buildLeg(ctx, s) {
  const { g, Q, W } = ctx, q = Q.leg, pre = prepLeg(ctx, s), { yH, yK, yA } = pre;
  const rows = pre.rows.map((r) => ({ ...r }));
  fitLegToTrunk(ctx, rows, pre, s === "L" ? 1 : -1);
  frames(rows, true); // the rings are horizontal sections, as measured (perpendicular rings of a leaning centre line fold on themselves)
  const bones = [W.I(`hip_${s}`), W.I(`knee_${s}`), W.I(`ankle_${s}`)], ipel = W.I("pelvis");
  const hK = 0.2 * Math.min(yH - yK, yK - yA), hA = Math.min(0.5 * yA, 0.4 * (yK - yA), 0.04);
  const capH = Math.max(0.03, rows[0].rx * 0.9);
  const A = addDome(rows, false, capH, Q.dome);
  const last = rows[rows.length - 1];
  const B = addDome(rows, true, Math.max(0.03, Math.min(0.045, last.cy * 0.5)), Q.dome); // inside the foot
  // Rigid with the hip joint from the joint ring down; the dome above it (inside the pelvis) fades to half and half with the pelvis. The blend at
  // the knee is BACK_BLEND times wider at the back of the leg than at the front: when the knee bends the back of the thigh and the back of the calf
  // come together and a short blend lets the two rigid tubes pass through each other (59 mm at 150 degrees); a long one lets the skin of both
  // slide toward the joint (11 mm; the front, which stretches, keeps its short blend, so the kneecap keeps its shape).
  const ysK = [0, yK, yA], hsK = [0, hK, hA];
  const hook = (row, x, y, z, j, wi, ww) => {
    const back = clamp(((row.cz - z) / row.rz + 0.6) / 1.6, 0, 1);
    hsK[1] = lerp(hK, BACK_BLEND * hK, sstep(back));
    let n = limbW(y, bones, ysK, hsK, wi, ww);
    const c = y <= yH ? 0 : 0.5 * sstep((y - yH) / capH);
    if (c > 1e-4 && wi[0] === bones[0]) { const w0 = ww[0]; ww[0] = w0 * (1 - c); wi[n] = ipel; ww[n] = w0 * c; n++; }
    return n;
  };
  return emitTube(g, rows, q.cols, false, A, B, hook);
}

/** One finger or the thumb: a capsule along its joints with a bone per phalanx. */
function buildFinger(ctx, s, name) {
  const { g, Q, W } = ctx, hand = ctx.body.shape.hands[s], f = hand.fingers[name], q = Q.finger;
  const P = [...f.points, f.tip];
  const seg = [0, 1, 2].map((i) => Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]));
  const L0 = seg[0], L1 = L0 + seg[1], Lt = L1 + seg[2];
  const r = f.radiusZ, th = f.thicknessRatio;
  const bones = f.joints.map((id) => W.I(id));
  // positions along the arc: extra rings around the two knuckles
  const d1 = Math.min(0.2 * seg[0], 0.005), d2 = Math.min(0.2 * seg[1], 0.005), d3 = Math.min(0.2 * seg[2], 0.005);
  const tipStart = Lt - 1.05 * r[3]; // a round tip: the dome is a hemisphere (0.55 r made the tips look like cut cylinders)
  const arcs = [0, 0.5 * L0, L0 - d1, L0, L0 + d2, 0.5 * (L0 + L1), L1 - d2, L1, L1 + d3, 0.5 * (L1 + tipStart), tipStart].filter((a, i, arr) => i === 0 || a > arr[i - 1] + 0.0008);
  if (q.dBase > 0.006) arcs.splice(0, arcs.length, 0, L0, L1, tipStart); // low quality: the joints only
  const pointAt = (a) => {
    const i = a <= L0 ? 0 : a <= L1 ? 1 : 2, a0 = i === 0 ? 0 : i === 1 ? L0 : L1, t = (a - a0) / seg[i];
    return [lerp(P[i][0], P[i + 1][0], t), lerp(P[i][1], P[i + 1][1], t), lerp(P[i][2], P[i + 1][2], t)];
  };
  const radius = (a) => {
    const base = a <= L0 ? lerp(r[0], r[1], a / L0) : a <= L1 ? lerp(r[1], r[2], (a - L0) / (L1 - L0)) : lerp(r[2], r[3], (a - L1) / (Lt - L1));
    const bump = Math.exp(-(((a - L0) / 0.004) ** 2)) + Math.exp(-(((a - L1) / 0.004) ** 2));
    return base * (1 + 0.07 * bump);
  };
  const rows = arcs.map((a) => {
    const p = pointAt(a), rr = radius(a);
    return { cx: p[0], cy: p[1], cz: p[2], rx: rr * th, rz: rr, n: 2, wi: null, ww: null, wn: 0, a };
  });
  frames(rows);
  const blend = (a, J, d) => sstep((a - (J - d)) / (2 * d)); // 0 before the knuckle, 1 after it
  for (const row of rows) {
    const u1 = blend(row.a, L0, Math.max(d1, 0.003)), u2 = blend(row.a, L1, Math.max(d2, 0.003));
    row.wi = []; row.ww = [];
    const w = [1 - u1, u1 - u2, u2];
    for (let k = 0; k < 3; k++) if (w[k] > 1e-6) { row.wi.push(bones[k]); row.ww.push(w[k]); }
    row.wn = row.wi.length;
  }
  const A = addDome(rows, false, 0.85 * r[0], 2);
  const B = addDome(rows, true, Lt - tipStart, q.tip);
  return emitTube(g, rows, q.cols, false, A, B, null);
}

/** Foot: stations lofted along z; sole flat on the floor, toes follow mtp, the rest the ankle. */
function buildFoot(ctx, s) {
  const { body, g, Q, W } = ctx, foot = body.shape.feet[s], q = Q.foot, M = q.cols;
  const st = foot.stations;
  const n = st.length;
  const dA = Math.min(0.011, 0.4 * (st[1].z - st[0].z)), dB = Math.min(0.012, 0.4 * (st[n - 1].z - st[n - 2].z));
  const zs = Float64Array.from(st, (p, i) => (i === 0 ? p.z + dA : i === n - 1 ? p.z - dB : p.z));
  // the last station is the tip of the longest toe, 14 mm half width: lofted to a point that is a nub; the toe end is made as wide as a
  // rounded forefoot is (0.62 of the section behind it) and closed by the dome
  // Around the ankle the foot is made 5 mm wider than the shank: the fit's foot is as wide as the shank there (37 mm half width both), two
  // vertical walls that meet at a tangent and the intersection is a zigzag around the ankle. Wider, the shank leaves the top of the foot at a
  // clear angle, along a smooth line (a sock).
  const shankLast = body.shape.tubes[`shank_${s}`].rings.at(-1), zA = W.pos[`ankle_${s}`][2], ankleW = shankLast.rx + 0.005;
  const rxs = Float64Array.from(st, (p, i) => {
    if (i === n - 1) return Math.max(p.rx, 0.62 * st[n - 2].rx);
    const g = 1 - sstep((Math.abs(p.z - zA) - 0.02) / 0.03);
    return Math.max(p.rx, lerp(p.rx, ankleW, g));
  });
  const sp = new Spline(zs, [Float64Array.from(st, (p) => p.cx), rxs, Float64Array.from(st, (p) => p.top), Float64Array.from(st, (p) => p.lift)], [false, true, true, true]);
  const params = distribute(Array.from(zs), () => q.dz);
  const iA = W.I(`ankle_${s}`), iM = W.I(foot.toesJoint), zM = W.pos[foot.toesJoint][2], hz = 0.014;
  const v4 = new Float64Array(4);
  const rows = params.map((z) => {
    sp.at(z, v4);
    const lift = Math.max(v4[3], 0), top = Math.max(v4[2], lift + 0.008), u = sstep((z - (zM - hz)) / (2 * hz));
    const row = { z, cx: v4[0], rx: Math.max(v4[1], 0.004), yc: 0.5 * (top + lift), hy: 0.5 * (top - lift), wi: [iA, iM], ww: [1 - u, u], wn: u < 1e-6 ? 1 : u > 1 - 1e-6 ? 1 : 2 };
    if (row.wn === 1) { if (u > 0.5) { row.wi = [iM]; row.ww = [1]; } else { row.wi = [iA]; row.ww = [1]; } }
    return row;
  });
  const addCap = (atEnd, depth) => {
    const e = atEnd ? rows[rows.length - 1] : rows[0], dir = atEnd ? 1 : -1, add = [];
    for (let i = 1; i <= q.dome; i++) {
      const th = (PI / 2) * (i / (q.dome + 1)), c = Math.cos(th), sn = Math.sin(th);
      add.push({ ...e, z: e.z + dir * depth * sn, rx: e.rx * c, hy: e.hy * c });
    }
    if (atEnd) rows.push(...add); else rows.unshift(...add.reverse());
    return { x: e.cx, y: e.yc, z: e.z + dir * depth, row: e };
  };
  const apexA = addCap(false, dA), apexB = addCap(true, dB);
  const v0 = g.nv, t0 = g.nt, px = new Float64Array(M), py = new Float64Array(M);
  const NT = 2.3, NB = 5;
  // the section: top half (exponent NT) and flat-soled bottom half (NB), each sampled at equal arc length from one extreme to the other, so that
  // the ring is symmetric about the foot's own axis and the right foot is the exact mirror image of the left
  const PT = 96, tx = new Float64Array(PT + 1), ty = new Float64Array(PT + 1), ts = new Float64Array(PT + 1), bx = new Float64Array(PT + 1), by = new Float64Array(PT + 1), bs = new Float64Array(PT + 1);
  const half = (row, sgn, n, X, Y, S) => {
    const e = 2 / n;
    for (let k = 0; k <= PT; k++) {
      const t = (k / PT) * PI, c = Math.cos(t), sn = Math.sin(t);
      X[k] = row.rx * Math.sign(c) * Math.pow(Math.abs(c), e); Y[k] = sgn * row.hy * Math.pow(Math.abs(sn), e);
      S[k] = k ? S[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]) : 0;
    }
  };
  const walk = (X, Y, S, from, nseg) => { // nseg equal-arc points of the half (the far end excluded)
    let k = 0;
    for (let j = 0; j < nseg; j++) {
      const target = (S[PT] * j) / nseg;
      while (k < PT - 1 && S[k + 1] < target) k++;
      const f = clamp((target - S[k]) / (S[k + 1] - S[k] || 1), 0, 1);
      px[from + j] = lerp(X[k], X[k + 1], f); py[from + j] = lerp(Y[k], Y[k + 1], f);
    }
  };
  const ring = (row) => {
    half(row, 1, NT, tx, ty, ts); half(row, -1, NB, bx, by, bs);
    const nTop = clamp(Math.round((M * ts[PT]) / (ts[PT] + bs[PT])), 2, M - 2), nBot = M - nTop;
    walk(tx, ty, ts, 0, nTop);
    // the bottom half runs from the -x extreme back to +x: reverse its parametrisation
    for (let k = 0; k <= PT; k++) bx[k] = -bx[k];
    walk(bx, by, bs, nTop, nBot);
  };
  for (const row of rows) {
    ring(row);
    for (let j = 0; j < M; j++) {
      const v = g.v(row.cx + px[j], row.yc + py[j], row.z);
      for (let i = 0; i < row.wn; i++) { g.ti[i] = row.wi[i]; g.tw[i] = row.ww[i]; }
      g.setW(v, g.ti, g.tw, row.wn);
    }
  }
  const R = rows.length;
  for (let r = 0; r < R - 1; r++) {
    const A = v0 + r * M, B = A + M;
    for (let j = 0; j < M; j++) { const j1 = (j + 1) % M; g.t(A + j, A + j1, B + j1); g.t(A + j, B + j1, B + j); }
  }
  const fan = (ap, row, ring0, atEnd) => {
    const v = g.v(ap.x, ap.y, ap.z);
    for (let i = 0; i < row.wn; i++) { g.ti[i] = row.wi[i]; g.tw[i] = row.ww[i]; }
    g.setW(v, g.ti, g.tw, row.wn);
    for (let j = 0; j < M; j++) { const a = ring0 + j, b = ring0 + ((j + 1) % M); if (atEnd) g.t(a, b, v); else g.t(b, a, v); }
  };
  fan(apexA, rows[0], v0, false);
  fan(apexB, rows[R - 1], v0 + (R - 1) * M, true);
  return { v0, v1: g.nv, t0, t1: g.nt };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Head
function buildHead(ctx) {
  const { body, g, Q, W } = ctx, sh = body.shape.head, F = sh.features, q = Q.head, M = q.cols, S = body.stature;
  const cr = sh.cranium, yc = cr.c[1], zc = cr.c[2], ax = cr.r[0], ay = cr.r[1], az = cr.r[2];
  const iH = W.I("head");
  const brow = sh.rings.find((r) => r.id === "brow");
  if (!brow) throw new Error("buildSkin: body.shape.head has no brow ring");
  // ---- profile of the base surface: front and back z, half width and exponent by height.
  // Two shapes are blended. The cranium is the fit's ellipsoid made a little fuller at the top (a superellipsoid of exponent DOME_P: the
  // ellipsoid itself made the head a bullet); it gives the top, the back and the sides down to the tragion and fades out over FADE below it.
  // The face is a C2 cubic spline through the face rings (brow, eye, ear, cheek, mouth, chin_top, chin); it gives the front below the brow and
  // everything below the fade. The rings are lumpy (the eye ring is 3 mm narrower than the ear ring, the cheek ring 2 mm behind the mouth ring,
  // the back of the head steps 12 mm in at the eye ring: lofted through, the head wears a headband): lumps that are valleys are filled.
  const DOME_P = 2.3, FADE = 0.045, yB = brow.c[1];
  const cran = (y, out) => {
    const u = clamp(Math.abs(y - yc) / ay, 0, 1), f = Math.pow(1 - Math.pow(u, DOME_P), 1 / DOME_P);
    out[0] = zc + az * f; out[1] = zc - az * f; out[2] = ax * f; out[3] = brow.n;
  };
  const kd = [];
  for (const r of sh.rings.filter((r) => r.c[1] <= yB + 1e-9 && r.id !== "crown" && r.id !== "upper_skull").sort((a, b) => b.c[1] - a.c[1])) {
    if (!kd.length || kd[kd.length - 1].y - r.c[1] > 0.0025) kd.push({ y: r.c[1], zf: r.c[2] + r.rz, zb: r.c[2] - r.rz, rx: r.rx, n: r.n });
  }
  for (let i = 1; i < kd.length - 1; i++) for (const key of ["rx", "zf"]) kd[i][key] = Math.max(kd[i][key], Math.min(kd[i - 1][key], kd[i + 1][key]));
  const asc = [...kd].reverse(), yBot = asc[0].y;
  const spl = new Spline(Float64Array.from(asc, (k) => k.y), [Float64Array.from(asc, (k) => k.zf), Float64Array.from(asc, (k) => k.zb), Float64Array.from(asc, (k) => k.rx), Float64Array.from(asc, (k) => k.n)],
    [true, true, true, true], null, [0, null, null, 0], true);
  const prof = new Float64Array(4), fa = new Float64Array(4), ca = new Float64Array(4);
  const profile = (y) => {
    cran(y, ca);
    spl.at(Math.min(y, yB), fa);
    const w = 1 - sstep((yc - y) / FADE), wf = sstep((y - yB) / 0.03); // w: cranium vs face (back, sides); wf: the same for the front above the brow
    prof[0] = lerp(fa[0], ca[0], wf);
    prof[1] = lerp(fa[1], ca[1], w);
    prof[2] = lerp(fa[2], ca[2], w);
    prof[3] = lerp(fa[3], ca[3], w);
    return prof;
  };
  // The rings are 9 to 45 mm apart and their values are lumpy at that scale (a dent of 3 mm at the ear ring, a step at the mouth ring): lofted
  // exactly through them the face is wavy and the shading shows rows. The profile is therefore smoothed along y (Gaussian, sigma SMOOTH, no
  // smoothing in the dome) before it is sampled; it moves by 1 to 2 mm at the kinks of the rings, the brow ring included.
  const SMOOTH = 0.007, yJ = yB + 0.03, GY0 = yBot - 0.03, GN = Math.round((S - GY0) / 0.001) + 1, raw = [0, 1, 2, 3].map(() => new Float64Array(GN)), sm = [0, 1, 2, 3].map(() => new Float64Array(GN));
  for (let i = 0; i < GN; i++) { profile(GY0 + i * 0.001); for (let c = 0; c < 4; c++) raw[c][i] = prof[c]; }
  for (let i = 0; i < GN; i++) {
    const y = GY0 + i * 0.001, sg = SMOOTH * (1 - sstep((y - yJ) / 0.04)), kw = Math.ceil(2.5 * sg / 0.001);
    for (let c = 0; c < 4; c++) {
      if (kw < 1) { sm[c][i] = raw[c][i]; continue; }
      let a = 0, wsum = 0;
      for (let k = -kw; k <= kw; k++) { const j = clamp(i + k, 0, GN - 1), w = Math.exp(-0.5 * ((k * 0.001) / sg) ** 2); a += w * raw[c][j]; wsum += w; }
      sm[c][i] = a / wsum;
    }
  }
  const smooth = (y, out) => {
    const f = clamp((y - GY0) / 0.001, 0, GN - 1.0001), i = Math.floor(f), t = f - i;
    for (let c = 0; c < 4; c++) out[c] = lerp(sm[c][i], sm[c][i + 1], t);
    return out;
  };
  const sprof = new Float64Array(4), profileS = (y) => smooth(y, sprof);
  const frontAt = (y) => profileS(y)[0];

  // ---- rows, top to bottom: the dome (equally spaced along the superellipse from the vertex to the junction), the face
  const ys = [], uJ = clamp((yJ - yc) / ay, 0, 1), thJ = Math.asin(Math.pow(uJ, DOME_P / 2)); // u = sin(th)^(2/p) on the dome superellipse
  for (let k = 1; k <= q.dome; k++) ys.push(yc + ay * Math.pow(Math.sin(lerp(PI / 2, thJ, k / (q.dome + 1))), 2 / DOME_P));
  ys.push(yJ);
  const yFaceTop = Math.min(F.brow.glabella[1] + 0.014, yJ - 0.004);
  for (let y = yJ - q.dSkull; y > yFaceTop + 0.5 * q.dSkull; y -= q.dSkull) ys.push(y);
  const nFace = Math.max(2, Math.round((yFaceTop - yBot) / q.dFace));
  const face = [];
  for (let i = 0; i <= nFace; i++) face.push(yFaceTop - ((yFaceTop - yBot) * i) / nFace);
  const forced = [F.nose.bridge[1], F.eyes.pupilL[1], F.nose.tip[1], F.nose.subnasale[1], F.mouth.stomion[1], F.chin.menton[1] + 0.006]
    .filter((y) => y < yFaceTop - 0.002 && y > yBot + 0.002);
  for (const f of forced) { // move the nearest row onto a landmark height (the rows are 3.5 mm apart: the landmark is then exact)
    let best = 1, bd = 1e9;
    for (let i = 1; i < face.length - 1; i++) { const d = Math.abs(face[i] - f); if (d < bd) { bd = d; best = i; } }
    if (bd < 0.5 * (yFaceTop - yBot) / nFace + 1e-9) face[best] = f;
  }
  face.sort((a, b) => b - a);
  for (const y of face) if (y < ys[ys.length - 1] - 0.0008) ys.push(y);
  const yMen = F.chin.menton[1], hBot = clamp(yBot - (yMen - 0.003), 0.004, 0.012);

  // ---- columns: denser in front (v = 0 at the front, +-1 at the back)
  const ccol = new Float64Array(M), scol = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    const jp = ((j - M / 4 + M / 2) % M + M) % M - M / 2, v = jp / (M / 2);
    const t = PI / 2 + PI * (q.a * v + (1 - q.a) * v * v * v);
    ccol[j] = Math.cos(t); scol[j] = Math.sin(t);
  }

  // ---- feature fields: displacements of the base surface, in neutral world coordinates
  const nose = F.nose, tip = nose.tip, nas = nose.bridge, sub = nose.subnasale, zTip = tip[2], zNas = nas[2], zSub = sub[2];
  // ridge of the nose: [height, z of the ridge, half width]; the protrusion is that z minus the face
  const ridge = [
    [nas[1] + 0.018, -1, 0.006], [nas[1], Math.max(zNas, frontAt(nas[1]) + 0.002), 0.0075], [lerp(nas[1], tip[1], 0.5), lerp(zNas, zTip, 0.5) - 0.002, 0.0105],
    [tip[1] + 0.005, zTip - 0.003, 0.0118], [tip[1], zTip, 0.0125], [tip[1] - 0.009, zTip - 0.005, 0.0165], [sub[1] + 0.004, zSub + 0.003, 0.0218],
    [sub[1] - 0.004, -1, 0.012], [sub[1] - 0.012, -1, 0.004],
  ].sort((a, b) => a[0] - b[0]);
  const noseP = ridge.map((r) => Math.max(r[1] < 0 ? 0 : r[1] - frontAt(r[0]), 0));
  const noseSp = new Spline(Float64Array.from(ridge, (r) => r[0]), [Float64Array.from(noseP), Float64Array.from(ridge, (r) => r[2])], [true, true]);
  const nv = new Float64Array(2), noseLo = ridge[0][0], noseHi = ridge[ridge.length - 1][0];
  const eyeCtr = [F.eyes.pupilL, F.eyes.pupilR], eyeR = F.eyes.radius;
  const mouthY = F.mouth.stomion[1], mouthHalf = 0.5 * F.mouth.width;
  const browY = F.brow.glabella[1], browHalf = F.brow.halfWidth, browH = F.brow.height;
  const men = F.chin.menton, chinY0 = men[1] + 0.01, chinHalf = Math.max(0.018, 0.9 * F.chin.width);
  const chinA = Math.max(men[2] - frontAt(Math.max(men[1] + 0.004, yBot)), 0.002) / Math.exp(-((0.006 / 0.015) ** 2));
  const features = (x, y, z, cz, rz, out) => {
    out[0] = 0; out[1] = 0; out[2] = 0;
    const front = sstep((z - cz) / (0.45 * rz)), ax_ = Math.abs(x); // 0 on the back half of the head, 1 on the front
    if (front > 0) {
      if (y > noseLo && y < noseHi && ax_ < 0.03) { // nose: a rounded ridge
        noseSp.at(y, nv);
        if (ax_ < nv[1] && nv[0] > 0) out[2] += nv[0] * Math.pow(1 - (ax_ / nv[1]) * (ax_ / nv[1]), 1.25) * front;
      }
      const bw = 1 - (x / browHalf) ** 2; // brow ridge
      if (bw > 0) out[2] += 0.7 * browH * bw * Math.exp(-(((y - (browY + 0.003)) / 0.0075) ** 2)) * front;
      for (let k = 0; k < 2; k++) { // eyes: lids that hug the eyeball and an almond opening that shows it
        const p = eyeCtr[k], dx = x - p[0], dy = y - p[1], d2 = dx * dx + dy * dy;
        if (d2 < eyeR * eyeR) {
          const zs = p[2] - eyeR + Math.sqrt(eyeR * eyeR - d2), ex = dx / 0.0095, ey = dy / 0.0040, rr = Math.sqrt(ex * ex + ey * ey);
          if (rr < 1) { if (z > zs - 0.0015) out[2] += (zs - 0.0015 - z) * front; } // the opening: the surface lies just behind the eyeball
          else if (z < zs + 0.0007) out[2] += (zs + 0.0007 - z) * front; // the lids: just in front of it, wherever the eyeball would come through
        }
      }
      const mw = 1 - (x / mouthHalf) ** 2; // mouth: a groove between two lips
      if (mw > 0) out[2] += (-0.0016 * Math.exp(-(((y - mouthY) / 0.0022) ** 2)) + 0.0018 * Math.exp(-(((y - (mouthY + 0.0055)) / 0.0045) ** 2)) + 0.0024 * Math.exp(-(((y - (mouthY - 0.0065)) / 0.0055) ** 2))) * Math.sqrt(mw) * front;
      if (y < men[1] + 0.05) out[2] += chinA * Math.exp(-((x / chinHalf) ** 2) - (((y - chinY0) / 0.015) ** 2)) * front; // chin
    }
  };

  // ---- vertices: the body rows, then a two-ring dome under the chin
  const v0 = g.nv, t0 = g.nt, D = new Float64Array(3);
  g.ti[0] = iH; g.tw[0] = 1;
  const yMouth = F.mouth.stomion[1];
  // The front half of the plan is flatter than the back from the brow down to the mouth (exponent FACE_N): the face is a plane across the
  // eyes, the nose and the mouth, and the pupils (x = +-31 mm) must be on it; the fit's rings are ellipses, 7 mm behind the pupils there.
  const FACE_N = 3.0, flat = (y) => sstep((yB - y) / 0.025) * (1 - sstep((yMouth - y) / 0.06));
  const emitRow = (y, scale, yShift) => {
    const pr = profileS(y), zf = pr[0], zb = pr[1], rx = pr[2] * scale, eB = 2 / pr[3], eF = 2 / lerp(pr[3], FACE_N, flat(y)), rz = 0.5 * (zf - zb) * scale, cz = 0.5 * (zf + zb);
    for (let j = 0; j < M; j++) {
      const c = ccol[j], s = scol[j], e = s >= 0 ? eF : eB;
      const x = rx * Math.sign(c) * Math.pow(Math.abs(c), e), z = cz + rz * Math.sign(s) * Math.pow(Math.abs(s), e);
      if (ctx.detail) features(x, y, z, cz, rz, D); else D[0] = D[2] = 0;
      const vv = g.v(x + D[0] * scale, y + yShift, z + D[2] * scale);
      g.tw[0] = 1; g.setW(vv, g.ti, g.tw, 1);
    }
  };
  for (const y of ys) emitRow(y, 1, 0);
  for (let k = 1; k <= 2; k++) { const th = (PI / 2) * (k / 3); emitRow(yBot, Math.cos(th), -hBot * Math.sin(th)); }
  const R = ys.length + 2;
  for (let r = 0; r < R - 1; r++) {
    const A = v0 + r * M, B = A + M;
    for (let j = 0; j < M; j++) { const j1 = (j + 1) % M; g.t(A + j, A + j1, B + j1); g.t(A + j, B + j1, B + j); }
  }
  const apexTop = g.v(0, S, zc), apexBot = g.v(0, yBot - hBot, 0.5 * (asc[0].zf + asc[0].zb));
  for (const a of [apexTop, apexBot]) { g.tw[0] = 1; g.setW(a, g.ti, g.tw, 1); }
  const last = v0 + (R - 1) * M;
  for (let j = 0; j < M; j++) { const j1 = (j + 1) % M; g.t(v0 + j1, v0 + j, apexTop); g.t(last + j, last + j1, apexBot); }
  const head = { v0, v1: g.nv, t0, t1: g.nt };

  // ---- ears: a rim with a hollow, standing off the side of the head; separate closed pieces (the head grid is too coarse at the sides for them)
  const ear = F.ears, earY = ear.tragion[1] + 0.12 * ear.length, earZ = ear.tragion[2] - 0.5 * ear.breadth;
  const sideX = (y, z) => { // x of the side of the head at (y, z)
    const pr = profileS(y), cz = 0.5 * (pr[0] + pr[1]), rz = 0.5 * (pr[0] - pr[1]), d = Math.abs(z - cz) / rz, n = z > cz ? lerp(pr[3], FACE_N, flat(y)) : pr[3];
    return pr[2] * Math.pow(Math.max(1 - Math.pow(Math.min(d, 1), n), 0), 1 / n);
  };
  const eh = (r) => ear.protrusion * Math.pow(1 - r * r, 0.6) * (0.4 + 0.6 * sstep((r - 0.12) / 0.6)); // height above the head at radius r (0..1)
  const earParts = [];
  const K = Q.ear.rings, Me = Q.ear.cols;
  for (const side of [1, -1]) {
    const ev0 = g.nv, et0 = g.nt;
    const put = (rho, phi, drop) => {
      const y = earY + rho * 0.5 * ear.length * Math.cos(phi), z = earZ + rho * 0.5 * ear.breadth * Math.sin(phi);
      const v = g.v(side * (sideX(y, z) + (drop ? -0.004 : eh(rho))), y, z);
      g.ti[0] = iH; g.tw[0] = 1; g.setW(v, g.ti, g.tw, 1);
      return v;
    };
    const top = put(0, 0, false);
    const rings = [];
    for (let k = 1; k <= K; k++) { rings.push(g.nv); for (let j = 0; j < Me; j++) put(k / K, (2 * PI * j) / Me, false); }
    rings.push(g.nv); for (let j = 0; j < Me; j++) put(1, (2 * PI * j) / Me, true); // collar inside the head
    const bottom = put(0, 0, true);
    for (let j = 0; j < Me; j++) g.t(top, rings[0] + (j + 1) % Me, rings[0] + j);
    for (let k = 0; k < rings.length - 1; k++) for (let j = 0; j < Me; j++) {
      const j1 = (j + 1) % Me, a = rings[k] + j, b = rings[k] + j1, c = rings[k + 1] + j1, d = rings[k + 1] + j;
      g.t(a, b, c); g.t(a, c, d);
    }
    const lastR = rings[rings.length - 1];
    for (let j = 0; j < Me; j++) g.t(lastR + j, lastR + (j + 1) % Me, bottom);
    if (meshVolumeRange(g, et0, g.nt) < 0) flipRange(g, et0, g.nt);
    earParts.push({ v0: ev0, v1: g.nv, t0: et0, t1: g.nt });
  }
  return { head, ears: earParts };
}

/** Signed volume of g's triangles [t0, t1) and a winding flip for them (for closed pieces whose orientation is easier to test than to derive). */
function meshVolumeRange(g, t0, t1) { return meshVolume(g.pos, g.idx.subarray(t0 * 3, t1 * 3)); }
function flipRange(g, t0, t1) { for (let t = t0; t < t1; t++) { const o = t * 3, b = g.idx[o + 1]; g.idx[o + 1] = g.idx[o + 2]; g.idx[o + 2] = b; } }

/** Two eyeballs (separate skinned mesh, vertex colours: white, iris, pupil), each skinned to its eye joint. */
function buildEyes(ctx, quality) {
  const { body, W } = ctx, Q = QUALITY[quality].eye, M = Q.cols, F = body.shape.head.features.eyes, R = F.radius;
  const rows = Q.rows;
  const nv = (2 * (rows.length - 2) * M + 4), geo = { pos: new Float32Array(nv * 3), col: new Float32Array(nv * 3), si: new Uint16Array(nv * 4), sw: new Float32Array(nv * 4), idx: [] };
  const colorAt = (deg) => {
    if (deg <= 11) return [0.012, 0.012, 0.015];
    if (deg <= 14) return [0.07, 0.04, 0.02];
    if (deg <= 26) return [0.16, 0.09, 0.045];
    if (deg <= 31) return [0.06, 0.04, 0.03];
    return [0.8, 0.78, 0.74];
  };
  let n = 0;
  for (const side of ["eye_L", "eye_R"]) {
    const c = body.positions[side], ib = W.I(side);
    const put = (x, y, z, deg) => {
      geo.pos.set([c[0] + R * x, c[1] + R * y, c[2] + R * z], n * 3);
      geo.col.set(colorAt(deg), n * 3);
      geo.si[n * 4] = ib; geo.sw[n * 4] = 1;
      return n++;
    };
    const front = put(0, 0, 1, 0);
    const ringStart = [];
    for (let r = 1; r < rows.length - 1; r++) {
      ringStart.push(n);
      const a = (rows[r] * PI) / 180;
      for (let j = 0; j < M; j++) { const b = (2 * PI * j) / M; put(Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a), rows[r]); }
    }
    const back = put(0, 0, -1, 180);
    for (let j = 0; j < M; j++) { const j1 = (j + 1) % M; geo.idx.push(front, ringStart[0] + j, ringStart[0] + j1); }
    for (let r = 0; r < ringStart.length - 1; r++) for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M, a = ringStart[r] + j, b = ringStart[r] + j1, cc = ringStart[r + 1] + j1, d = ringStart[r + 1] + j;
      geo.idx.push(a, d, b, b, d, cc);
    }
    const last = ringStart[ringStart.length - 1];
    for (let j = 0; j < M; j++) { const j1 = (j + 1) % M; geo.idx.push(back, last + j1, last + j); }
  }
  return { geo, count: n };
}

// ---------------------------------------------------------------------------------------------------------------------------------
/** Volume enclosed by a triangle list (divergence theorem; positive for outward windings). Exported for the tests. */
export function meshVolume(position, index) {
  let v = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ax = position[a], ay = position[a + 1], az = position[a + 2], bx = position[b], by = position[b + 1], bz = position[b + 2], cx = position[c], cy = position[c + 1], cz = position[c + 2];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Build the skin of a BodyModel on the bones of a rig.
 * @param {object} body    BodyModel of fit.js (shape, positions, stature are read)
 * @param {Map<string, THREE.Bone>} bones   joint id -> bone (the rig's `bones`); the skeleton is made in skeleton.js JOINTS order
 * @param {{quality?: "high"|"low", color?: number|string|THREE.Color, eyes?: boolean, detail?: boolean}} options  eyes: false builds no eyeballs; detail: false leaves the face smooth
 * @returns {{ mesh: THREE.SkinnedMesh, eyes: THREE.SkinnedMesh|null, dispose(): void, stats: object }}
 */
export function buildSkin(body, bones, options = {}) {
  const t0 = performance.now();
  if (!body || !body.shape || !body.positions) throw new TypeError("buildSkin: body must be a BodyModel with shape and positions");
  if (!(bones instanceof Map)) throw new TypeError("buildSkin: bones must be a Map of joint id -> THREE.Bone");
  const quality = options.quality === "low" ? "low" : "high", Q = QUALITY[quality];
  // skeleton: JOINTS order, only the bones the caller has
  const list = [], idx = new Map(), ids = [];
  for (const j of JOINTS) { const b = bones.get(j.id); if (b) { idx.set(j.id, list.length); list.push(b); ids.push(j.id); } }
  const W = new Weights(body, idx);
  const g = new Geo(Q.capV, Q.capT);
  const ringByTube = new Map();
  const ctx = {
    body, g, Q, W, detail: options.detail !== false,
    ringY: (tube, id) => { const k = `${tube}/${id}`; if (!ringByTube.has(k)) { const t = body.shape.tubes[tube], r = t.rings.find((x) => x.id === id); ringByTube.set(k, r ? r.c[1] : t.rings[0].c[1]); } return ringByTube.get(k); },
  };
  const parts = {};
  const mark = (name, p) => { parts[name] = { vertexStart: p.v0, vertexEnd: p.v1, triStart: p.t0, triEnd: p.t1, ...(p.cols ? { cols: p.cols, rows: p.nrows } : {}) }; };
  mark("torso", buildTorso(ctx));
  const hd = buildHead(ctx);
  mark("head", hd.head); mark("ear_L", hd.ears[0]); mark("ear_R", hd.ears[1]);
  for (const s of ["L", "R"]) {
    mark(`arm_${s}`, buildArm(ctx, s));
    mark(`leg_${s}`, buildLeg(ctx, s));
    mark(`foot_${s}`, buildFoot(ctx, s));
    for (const f of ["index", "middle", "ring", "little", "thumb"]) mark(`${f}_${s}`, buildFinger(ctx, s, f));
  }
  const nv = g.nv, nt = g.nt;
  const geometry = new THREE.BufferGeometry();
  const posArr = g.pos.slice(0, nv * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(g.si.slice(0, nv * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(g.sw.slice(0, nv * 4), 4));
  geometry.setIndex(new THREE.BufferAttribute(nv < 65536 ? Uint16Array.from(g.idx.subarray(0, nt * 3)) : g.idx.slice(0, nt * 3), 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(options.color ?? DEFAULT_COLOR), roughness: 0.62, metalness: 0, side: THREE.FrontSide });
  const inverses = ids.map((id) => { const p = body.positions[id]; return new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]); });
  const skeleton = new THREE.Skeleton(list, inverses);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "skin";
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.userData.parts = parts;

  let eyes = null, eyeGeo = null, eyeMat = null;
  if (options.eyes !== false && body.shape.head.features?.eyes && idx.has("eye_L") && idx.has("eye_R")) {
    const { geo, count } = buildEyes(ctx, quality);
    eyeGeo = new THREE.BufferGeometry();
    eyeGeo.setAttribute("position", new THREE.BufferAttribute(geo.pos.slice(0, count * 3), 3));
    eyeGeo.setAttribute("color", new THREE.BufferAttribute(geo.col.slice(0, count * 3), 3));
    eyeGeo.setAttribute("skinIndex", new THREE.BufferAttribute(geo.si.slice(0, count * 4), 4));
    eyeGeo.setAttribute("skinWeight", new THREE.BufferAttribute(geo.sw.slice(0, count * 4), 4));
    eyeGeo.setIndex(geo.idx);
    eyeGeo.computeVertexNormals();
    eyeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0 });
    eyes = new THREE.SkinnedMesh(eyeGeo, eyeMat);
    eyes.name = "eyes";
    eyes.castShadow = true; eyes.receiveShadow = true;
    eyes.bind(skeleton, new THREE.Matrix4());
    mesh.add(eyes); // a child of the skin: whoever shows, hides or disposes the skin handles the eyes with it (rig.js traverses the mesh)
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    geometry.dispose(); material.dispose();
    if (eyes) { eyeGeo.dispose(); eyeMat.dispose(); eyes.removeFromParent(); }
    skeleton.dispose();
  };
  return { mesh, eyes, dispose, stats: { vertices: nv, triangles: nt, buildMs: performance.now() - t0, quality, parts } };
}

