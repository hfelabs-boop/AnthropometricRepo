// Collision and support proxies of a body: about 40 capsules derived from the shape rings and the landmarks of a BodyModel (fit.js), and the rings
// themselves for the lowest point of a lying body. The capsules stand in for the skin where the posture library needs geometry: "is a hand inside the
// torso, a shin through the other shin, the head into the shoulders" (gross self-intersection, POSTURES.md rule 5). They are not a collision mesh: soft tissue
// gives, so every pair has a tolerance (selfPenetrations) and resting contact is allowed. How far the skin of body.js lies outside the capsules in the neutral
// pose (the worst vertex per capsule over 16 bodies, mm): limbs 13 to 32, hands and fingers 2 to 21, buttocks 22, pelvis 40, head, neck, foot, toes 30 to 36,
// chest 55 and abdomen 58 (the corners of their boxy sections: a capsule pair is a stadium, the section is a superellipse of exponent up to 11), 70 at the groin
// of a seated body. Tolerances are set for that. Where the exact lowest point matters (the support of a lying body) the skin sections themselves are used: lowestSkinPoint.
// Two overlaps are not judged on capsules but on the skin sections (skinPenetrations): the upper arm against the trunk (armTorsoDepth: the shoulder joint is inside the chest
// capsule) and a hand against the head (handHeadDepth: the head capsule is 10 mm too wide at the temples, the palm capsule twice as thick as the palm).
// Pure: three, skeleton.js, fk.js and postures/grips.js and postures/reference.js (data) only; no DOM. Cost on one core (Node 22, median man): proxyWorld + lowestPoint about 1 microsecond,
// + lowestSkinPoint 17, the 621 pair checks of selfPenetrations about 60 (pose.test.mjs asserts that both stay under 0.3 ms).
//
// A capsule here is the convex hull of two spheres (a "sphere-cone"): end points A and B, radii ra and rb. Each end is attached to
// a joint frame (`{ joint, off }`, off = the neutral world offset from the joint centre, exactly like a landmark), so a proxy follows
// the pose through Kinematics. Limb capsules have both ends on the proximal joint of the segment (rigid, as the bone is); the three
// trunk parts have their ends on the spine joints at their heights, so they bend with the spine; each finger runs from its knuckle (on the
// MCP joint) to its tip (on the DIP or IP joint).
//
// Radii come from the shape rings of the body (half-breadth rx, half-depth rz, mean (rx + rz) / 2 per ring) so they follow the
// person's girths. A limb capsule is FITTED to all the rings of its tube (fitTube): the rings are not on a line (a thigh bulges forward, the deltoid
// ring is lateral of the arm's axis), and the thigh is two capsules. The trunk is an ellipse in section, a capsule is round: each trunk part is a PAIR of
// capsules (left and right of the midline, offset by rx - rz, radius rz), whose union is a stadium, close to the elliptical section. The pelvis is such a pair plus a
// buttock sphere on each side (bottom on the ischial landmark, rear on the most posterior point of the buttock).
//
// Tolerances (pairTolerance) are the soft tissue allowed to overlap, times min(1.8, BMI / 24); in addition a pair gets the depth it has in the reference
// postures of the library (ISO 7250-1 standing and sitting with relaxed hands, the T-pose, and the rest of the Reference group of postures/reference.js) plus 6 mm if that is more: the fitted body itself decides what the
// reference postures look like (a 1.31 m woman of 180 kg, BMI 105, has a neck wider than the gap to her raised arms).
import * as THREE from "three";
import { JOINTS } from "./skeleton.js";
import { Kinematics } from "./fk.js";
import { gripAngles } from "./postures/grips.js";
import REFERENCE_GROUP from "./postures/reference.js"; // data only (no imports): the reference postures the tolerances learn from

const SUB_RINGS = 3; // interpolated sections between two neighbouring rings of a tube, for the lowest point of the skin
const JIDX = new Map(JOINTS.map((j, i) => [j.id, i]));
const SPINE = JOINTS.filter((j) => j.region).map((j) => j.id); // L5 .. L1, T12 .. T1, C7 .. C1 (table order = bottom to top)

const fail = (msg) => { throw new Error(`bodyProxies: ${msg}`); };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rr = (ring) => 0.5 * (ring.rx + ring.rz);

// The skin of body.js narrows the upper arm to the measured bideltoid breadth (fitArmToDeltoid: no skin within 40 mm of the deltoid and above it reaches beyond
// half the breadth, further down the outer edge may grow by 0.25 per unit of height, at most 12 mm, down to the elbow; a section is narrowed from the outside and
// deepened to give back its girth). The fit's deltoid ring is up to 34 mm wider than that for a narrow shoulder, and the outer edge of the upper arm is what carries a body
// lying on its side: without the same narrowing here the body floated up to 16 mm. Same formulas as body.js (duplicated: that module exports only buildSkin).
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - 0.25 * k * h * h; };
const ellipseP = (a, b) => { const h = ((a - b) / (a + b)) ** 2; return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))); };
// Returns (c, rx, rz) => { c, rx, rz } for the sections of the upper arm tube of side s, or null when the tube has no deltoid ring.
function deltoidFit(body, tube, s, yElbow) {
  const dl = tube.rings.find((r) => r.id === "ua_deltoid");
  if (!dl) return null;
  const sgn = s === "L" ? 1 : -1, bid = body.report?.find?.((r) => r.id === "bideltoid_breadth" && r.kind === "measure")?.input, half = bid > 0 ? bid / 2000 : Infinity;
  const yD = dl.c[1], outerD = Math.min(sgn * dl.c[0] + dl.rx, half);
  return (c, rx, rz) => {
    if (c[1] < yElbow) return { c, rx, rz };
    const below = Math.max(yD - c[1], 0), inner = sgn * c[0] - rx, outer = sgn * c[0] + rx, limit = outerD + 0.0005 + Math.min(0.25 * Math.max(below - 0.04, 0), 0.012);
    if (outer <= limit) return { c, rx, rz };
    const outer2 = Math.max(smin(outer, limit, 0.008), inner + 0.6 * rx), rx2 = 0.5 * (outer2 - inner), p0 = ellipseP(rx, rz);
    let rz2 = rz;
    for (let i = 0; i < 4; i++) rz2 *= p0 / ellipseP(rx2, rz2);
    return { c: [sgn * (inner + rx2), c[1], c[2]], rx: rx2, rz: Math.min(rz2, 1.3 * rz) };
  };
}

// The straight tapered capsule that stands in for a tube (a limb segment). The rings of a tube are not on one line (a thigh bulges forward at the
// mid-thigh, the deltoid ring lies lateral of the arm's axis), so an axis through the first and last ring centre misses the skin by the offset of the
// rings between them (40 to 55 mm for the median woman's thigh). Here the axis has the direction of the weighted principal axis of the ring centres and
// is then moved to the middle of their spread (the centre of the smallest ball around the perpendicular offsets, Badoiu-Clarkson), so no ring is further
// off it than half the spread; the radius is the weighted least-squares line through the ring radii along the axis, kept inside their range. Returns
// { a, b: [x, y, z] (neutral world), ra, rb, spread (largest offset of a ring centre from the axis) }.
function fitTube(rings) {
  const n = rings.length, C = rings.map((r) => r.c), R = rings.map(rr);
  const w = C.map((_, i) => Math.max(1e-6, 0.5 * Math.hypot(...C[Math.min(n - 1, i + 1)].map((v, k) => v - C[Math.max(0, i - 1)][k]))));
  const W = w.reduce((s, v) => s + v, 0), m = [0, 1, 2].map((k) => C.reduce((s, c, i) => s + w[i] * c[k], 0) / W);
  let u = [0, 1, 2].map((k) => C[n - 1][k] - C[0][k]);
  for (let it = 0; it < 12; it++) { // power iteration on the weighted covariance
    const v = [0, 0, 0];
    C.forEach((c, i) => { const d = [0, 1, 2].map((k) => c[k] - m[k]), t = d[0] * u[0] + d[1] * u[1] + d[2] * u[2]; for (let k = 0; k < 3; k++) v[k] += w[i] * t * d[k]; });
    const L = Math.hypot(...v);
    if (L < 1e-15) break;
    u = v.map((x) => x / L);
  }
  const L0 = Math.hypot(...u) || 1;
  u = u.map((x) => x / L0);
  if ([0, 1, 2].reduce((s, k) => s + u[k] * (C[n - 1][k] - C[0][k]), 0) < 0) u = u.map((x) => -x);
  const T = C.map((c) => [0, 1, 2].reduce((s, k) => s + u[k] * (c[k] - m[k]), 0));
  const O = C.map((c, i) => [0, 1, 2].map((k) => c[k] - m[k] - T[i] * u[k])); // perpendicular offsets from the principal axis
  const z = O[0].slice();
  for (let it = 1; it <= 64; it++) { // centre of the smallest ball around the offsets
    let far = 0, fd = -1;
    O.forEach((o, i) => { const d = Math.hypot(o[0] - z[0], o[1] - z[1], o[2] - z[2]); if (d > fd) { fd = d; far = i; } });
    for (let k = 0; k < 3; k++) z[k] += (O[far][k] - z[k]) / (it + 1);
  }
  const spread = Math.max(...O.map((o) => Math.hypot(o[0] - z[0], o[1] - z[1], o[2] - z[2])));
  const at = (t) => [0, 1, 2].map((k) => m[k] + z[k] + t * u[k]);
  // weighted least squares line r(t) = r0 + g t through (T_i, R_i)
  const tb = T.reduce((s, t, i) => s + w[i] * t, 0) / W, rb = R.reduce((s, r, i) => s + w[i] * r, 0) / W;
  const sxx = T.reduce((s, t, i) => s + w[i] * (t - tb) ** 2, 0), sxy = T.reduce((s, t, i) => s + w[i] * (t - tb) * (R[i] - rb), 0), g = sxx > 1e-12 ? sxy / sxx : 0;
  const lo = Math.min(...R), hi = Math.max(...R), rad = (t) => Math.min(hi, Math.max(lo, rb + g * (t - tb)));
  return { a: at(T[0]), b: at(T[n - 1]), ra: rad(T[0]), rb: rad(T[n - 1]), spread };
}

// Monotone cubic Hermite slopes (limited) or Catmull-Rom slopes on uneven knots, as body.js uses to loft the skin through the shape rings (duplicated here:
// body.js is a three.js module with no exports for it, and this one stays small and pure).
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
    } else m[i] = (h[i] * d[i - 1] + h[i - 1] * d[i]) / (h[i - 1] + h[i]);
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
// The section between rings i and i + 1 of a tube at t in [0, 1]: { c: [x, y, z], rx, rz, n }, or null when the rings are too close together (or too few) to interpolate.
function loft(rs) {
  const N = rs.length, xs = new Float64Array(N);
  for (let i = 1; i < N; i++) xs[i] = xs[i - 1] + Math.hypot(rs[i].c[0] - rs[i - 1].c[0], rs[i].c[1] - rs[i - 1].c[1], rs[i].c[2] - rs[i - 1].c[2]);
  if (N < 2 || xs.some((x, i) => i > 0 && x - xs[i - 1] < 1e-4)) return null;
  const ys = [0, 1, 2].map((k) => Float64Array.from(rs, (r) => r.c[k])).concat([Float64Array.from(rs, (r) => r.rx), Float64Array.from(rs, (r) => r.rz), Float64Array.from(rs, (r) => r.n ?? 2)]);
  const ms = ys.map((y, k) => slopes(xs, y, k >= 3));
  return (i, t) => {
    const h = xs[i + 1] - xs[i], t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const v = ys.map((y, k) => h00 * y[i] + h10 * h * ms[k][i] + h01 * y[i + 1] + h11 * h * ms[k][i + 1]);
    return { c: [v[0], v[1], v[2]], rx: Math.max(v[3], 0.003), rz: Math.max(v[4], 0.003), n: Math.min(12, Math.max(1.6, v[5])) };
  };
}

/** The pair classes: which proxies may overlap how much. See pairTolerance. */
export const PROXY_GROUPS = Object.freeze(["head", "neck", "chest", "abdomen", "pelvis", "shoulders", "buttock", "upper_arm", "forearm", "palm", "fingers", "thigh", "shank", "foot", "toes", "kneecap"]);

/**
 * Build the proxies of a body. Cached per body object (a BodyModel is treated as immutable: build a new one with fitBody when a
 * dimension changes). Returns
 * { list: [{ id, group, side, a: { joint, off }, b: { joint, off }, ra, rb }], n, byId: Map, pairs: Int16Array (i, j, ...), tol: Float64Array, softness }
 * (`pairs` / `tol` are the self-collision pairs and their tolerances in metres, see selfPenetrations; `softness` = min(1.8, BMI / 24) is the factor applied to them). Throws an Error naming the
 * missing ring or landmark for a body that lacks the data.
 */
export function bodyProxies(body) {
  let p = CACHE.get(body);
  if (p && p.joints === body.joints && p.landmarks === body.landmarks && p.shape === body.shape) return p;
  p = build(body);
  CACHE.set(body, p);
  return p;
}
const CACHE = new WeakMap();

function build(body) {
  if (!body || !body.joints || !body.landmarks || !body.shape?.tubes) fail("needs a BodyModel with joints, landmarks and shape.tubes (fit.js)");
  const offsets = {};
  for (const j of JOINTS) if (j.parent) offsets[j.id] = body.joints[j.id].offset;
  const kin = new Kinematics(offsets);
  kin.solve({}, { x: 0, y: body.joints.pelvis.offset[1], z: 0 }); // neutral world positions of the joints
  const P = (id) => { const v = kin.position(id); return [v.x, v.y, v.z]; };
  const LM = (id) => {
    const l = body.landmarks[id];
    if (!l) fail(`landmark "${id}" is missing`);
    const v = kin.toWorld(l.joint, l.offset);
    return [v.x, v.y, v.z];
  };
  const tube = (name) => body.shape.tubes[name] ?? fail(`shape.tubes.${name} is missing`);
  const ring = (t, id, fallback) => t.rings.find((r) => r.id === id) ?? t.rings[Math.min(t.rings.length - 1, Math.max(0, Math.round(fallback * (t.rings.length - 1))))];
  // a point given in the neutral world frame, attached to a joint (an offset in that joint's frame, like a landmark)
  const at = (joint, w) => { const q = P(joint); return { joint, off: [w[0] - q[0], w[1] - q[1], w[2] - q[2]] }; };
  // the highest spine joint at or below height y: the vertebra a trunk point rides on (as fit.js does for the trunk landmarks)
  const spineAt = (y) => { let best = SPINE[0]; for (const id of SPINE) if (P(id)[1] <= y + 1e-9) best = id; return best; };

  const list = [];
  const add = (id, group, side, a, b, ra, rb = ra) => list.push({ id, group, side, a, b, ra, rb });
  const sphere = (id, group, side, joint, w, r) => add(id, group, side, at(joint, w), at(joint, w), r);

  // ---- head and neck ------------------------------------------------------------------------------------------------------
  {
    const head = body.shape.head?.rings ?? fail("shape.head.rings is missing");
    const brow = head.find((r) => r.id === "brow") ?? head[Math.floor(head.length / 2)];
    const r = rr(brow), vertex = LM("vertex"), menton = LM("menton");
    const cz = brow.c[2], top = vertex[1] - r, bot = menton[1] + 0.9 * r;
    const yb = Math.max(top, bot), ya = Math.min(top, bot); // a short axis, or a sphere when the head is not taller than it is wide
    add("head", "head", null, at("head", [0, ya, cz]), at("head", [0, yb, cz]), r);
    const t = tube("neck"), r0 = ring(t, "neck_base", 0), r1 = t.rings[t.rings.length - 1];
    add("neck", "neck", null, at(spineAt(r0.c[1]), r0.c), at(spineAt(r1.c[1]), r1.c), rr(r0), rr(r1));
  }

  // ---- trunk: pelvis, abdomen, chest as pairs of capsules; shoulder girdle -----------------------------------------------------
  {
    const t = tube("torso");
    const buttock = ring(t, "buttock", 0.1), lowAbd = ring(t, "lower_abdomen", 0.3), waist = ring(t, "waist", 0.5), upAbd = ring(t, "upper_abdomen", 0.65);
    const chest = ring(t, "chest", 0.75), axilla = ring(t, "axilla", 0.8);
    const ischialY = Math.min(LM("ischial_L")[1], LM("ischial_R")[1]);
    // zone [lo, hi] filled by a capsule of radius r: the end spheres sit r inside the zone (a single sphere when the zone is lower than 2 r)
    const zone = (lo, hi, r) => (hi - lo <= 2 * r ? [(lo + hi) / 2, (lo + hi) / 2] : [lo + r, hi - r]);
    const pair = (name, group, rings, r, lo, hi, attach) => {
      const cx = mean(rings.map((q) => q.c[0])), cz = mean(rings.map((q) => q.c[2])), dx = Math.max(0, mean(rings.map((q) => q.rx)) - r);
      const [ya, yb] = zone(lo, hi, r);
      for (const [s, sx] of [["L", dx], ["R", -dx]]) {
        const a = [cx + sx, ya, cz], b = [cx + sx, yb, cz];
        add(`${name}_${s}`, group, s, at(attach(ya), a), at(attach(yb), b), r);
      }
    };
    pair("pelvis", "pelvis", [buttock, lowAbd], buttock.rz, ischialY - 0.03, waist.c[1], () => "pelvis"); // the gluteal bowl hangs 20 to 40 mm below the ischial tuberosities when standing (the capsules do not carry weight: the support is the skin sections, lowestSkinPoint)
    {
      const r = mean([lowAbd.rz, waist.rz, upAbd.rz]);
      pair("abdomen", "abdomen", [lowAbd, waist, upAbd], r, lowAbd.c[1], 0.5 * (upAbd.c[1] + chest.c[1]) + 0.04, spineAt);
    }
    {
      const r = mean([chest.rz, axilla.rz]);
      pair("chest", "chest", [chest, axilla], r, upAbd.c[1] + 0.03, axilla.c[1] + 0.115, spineAt);
    }
    const aL = LM("acromion_L"), aR = LM("acromion_R");
    add("shoulders", "shoulders", null, at("clavicle_R", aR), at("clavicle_L", aL), 0.04);
    // buttock spheres: the bottom touches the ischial landmark, the rear touches the most posterior point of the buttock
    const bz = LM("buttock_extremity")[2], rb = 0.075;
    for (const s of ["L", "R"]) {
      const x = LM(`ischial_${s}`);
      sphere(`buttock_${s}`, "buttock", s, "pelvis", [Math.sign(x[0]) * 0.04, x[1] + rb, bz + rb], rb);
    }
  }

  // ---- limbs ------------------------------------------------------------------------------------------------------------------
  for (const s of ["L", "R"]) {
    const ua = tube(`upper_arm_${s}`), fa = tube(`forearm_${s}`), th = tube(`thigh_${s}`), sh = tube(`shank_${s}`);
    const fit = (id, group, joint, t, rings = t.rings) => { const f = fitTube(rings); add(id, group, s, at(joint, f.a), at(joint, f.b), f.ra, f.rb); };
    fit(`upper_arm_${s}`, "upper_arm", `shoulder_${s}`, ua);
    fit(`forearm_${s}`, "forearm", `elbow_${s}`, fa);
    // hand: the palm from the wrist to the middle knuckle; every finger from its knuckle to its tip (the fingers follow the grip, so each end
    // rides on its own joint: the chord from the knuckle to the tip shortens when the finger curls)
    const hand = body.shape.hands?.[s];
    const pw = hand?.palm?.[0], pk = hand?.palm?.[hand.palm.length - 1];
    const mcp = P(`middle_mcp_${s}`), wrist = P(`wrist_${s}`);
    add(`palm_${s}`, "palm", s, at(`wrist_${s}`, wrist), at(`wrist_${s}`, mcp), pw ? rr(pw) : 0.025, pk ? rr(pk) : 0.029);
    for (const [f, base, tip] of [["middle", "middle_mcp", "middle_dip"], ["index", "index_mcp", "index_dip"], ["ring", "ring_mcp", "ring_dip"], ["little", "little_mcp", "little_dip"], ["thumb", "thumb_mcp", "thumb_ip"]]) {
      const rz = hand?.fingers?.[f]?.radiusZ, r0 = rz?.[0] ?? (f === "thumb" ? 0.011 : 0.0085), r1 = rz?.[rz.length - 1] ?? 0.6 * r0;
      add(f === "middle" ? `fingers_${s}` : `${f}_${s}`, "fingers", s, at(`${base}_${s}`, P(`${base}_${s}`)), at(`${tip}_${s}`, LM(`${f}_tip_${s}`)), Math.max(0.007, r0), Math.max(0.0055, r1));
    }
    // the thigh in two pieces (hip to mid-thigh, mid-thigh to knee): its front slopes by up to 100 mm over the lower half in some bodies (fit.js moves the lower rings
    // back so that the thigh meets the buttock), which one straight capsule cannot follow
    const mid = Math.min(th.rings.length - 1, Math.max(1, Math.ceil((th.rings.length - 1) / 2)));
    fit(`thigh_${s}`, "thigh", `hip_${s}`, th, th.rings.slice(0, mid + 1));
    fit(`thigh_lo_${s}`, "thigh", `hip_${s}`, th, th.rings.slice(mid));
    const ankle = ring(sh, "sh_ankle", 0.75); // the shank ends at the ankle ring; the malleolus ring below it belongs to the foot
    fit(`shank_${s}`, "shank", `knee_${s}`, sh, sh.rings.slice(0, sh.rings.indexOf(ankle) + 1));
    // foot: a capsule resting on the sole from the heel to the ball; toes: a thin one from the toe joint to the toe tip
    const heel = LM(`heel_sole_${s}`), bm = LM(`ball_sole_medial_${s}`), bl = LM(`ball_sole_lateral_${s}`), ts = LM(`toe_sole_${s}`), tt = LM(`toe_tip_${s}`);
    const rf = Math.min(0.045, Math.max(0.028, 0.55 * (body.shape.feet?.[s]?.heelBreadth ?? 0.07))), sole = Math.min(heel[1], bm[1], bl[1]);
    const xc = 0.5 * (bm[0] + bl[0]);
    add(`foot_${s}`, "foot", s, at(`ankle_${s}`, [heel[0], sole + rf, heel[2] + 0.6 * rf]), at(`ankle_${s}`, [xc, sole + rf, 0.5 * (bm[2] + bl[2])]), rf);
    const rt = 0.014, mtp = P(`mtp_${s}`);
    add(`toes_${s}`, "toes", s, at(`mtp_${s}`, [ts[0], ts[1] + rt, mtp[2]]), at(`mtp_${s}`, [tt[0], ts[1] + rt, tt[2]]), rt);
    const pat = LM(`patella_${s}`);
    sphere(`kneecap_${s}`, "kneecap", s, `knee_${s}`, [pat[0], pat[1], pat[2] - 0.04], 0.04);
  }

  // ---- support rings: the sections of the skin, for the lowest point of a lying body ------------------------------------------
  const rings = [];
  {
    const tubes = body.shape.tubes;
    // each ring is a superellipse |x/rx|^n + |z/rz|^n = 1 in the plane perpendicular to its tube's centre line (the plane the skin builder uses), x the
    // lateral and z the anterior direction of the neutral pose; it rides on one joint like a landmark. The torso and neck rings ride on the spine joint below them.
    const frame = (a, b) => { // the section plane of a ring whose neighbours are at a and b
      let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const lu = Math.hypot(...u) || 1;
      u = u.map((v) => v / lu);
      let ex = [1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2]];
      const le = Math.hypot(...ex) || 1;
      ex = ex.map((v) => v / le);
      let ez = [u[1] * ex[2] - u[2] * ex[1], u[2] * ex[0] - u[0] * ex[2], u[0] * ex[1] - u[1] * ex[0]];
      if (ez[2] < 0) ez = ez.map((v) => -v);
      return { ex, ez };
    };
    // Between two neighbouring rings the skin is a loft of sections whose breadth, depth and exponent follow a smooth curve through the rings (body.js: monotone cubic
    // Hermite for breadth, depth and exponent, Catmull-Rom for the centre), and a section between a boxy chest and a rounder shoulder reaches lower on a diagonal (a body
    // rolled half way onto its side) than either of them, by up to 11 mm: so SUB_RINGS sections per interval are interpolated the same way and added to the rings.
    // `tube` names the loft a ring belongs to and `u` is its position along it (the index of the ring below, plus the fraction to the next): armTorsoDepth picks the
    // sections of the upper arms and the stack of the trunk by them. `up` is the direction from the ring to the next one (the normal of the section plane).
    const addRings = (rs, jointOf, tube, adjust = null) => {
      const at = loft(rs), nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
      const ring = (c0, rx0, rz0, nn, f, u) => { const { c, rx, rz } = adjust ? adjust(c0, rx0, rz0) : { c: c0, rx: rx0, rz: rz0 }; const j = jointOf({ c }), q = P(j), n = Math.max(1.05, nn ?? 2); rings.push({ joint: j, ji: JIDX.get(j), off: [c[0] - q[0], c[1] - q[1], c[2] - q[2]], ex: f.ex, ez: f.ez, rx, rz, q: n / (n - 1), n, tube, u, ns: f.ex[2] * f.ez[0] - f.ex[0] * f.ez[2] < 0 ? -1 : 1 }); };
      rs.forEach((r, i) => {
        const f = frame(rs[Math.max(0, i - 1)].c, rs[Math.min(rs.length - 1, i + 1)].c);
        ring(r.c, r.rx, r.rz, r.n, f, i);
        if (i + 1 >= rs.length || !at) return;
        const f1 = frame(rs[i].c, rs[Math.min(rs.length - 1, i + 2)].c);
        for (let k = 1; k <= SUB_RINGS; k++) {
          const t = k / (SUB_RINGS + 1), m = at(i, t);
          ring(m.c, m.rx, m.rz, m.n, { ex: nrm(f.ex.map((v, d) => v + (f1.ex[d] - v) * t)), ez: nrm(f.ez.map((v, d) => v + (f1.ez[d] - v) * t)) }, i + t);
        }
      });
    };
    const trunkJoint = (r) => { let best = "pelvis"; for (const id of SPINE) if (P(id)[1] <= r.c[1] + 1e-9) best = id; return best; };
    {
      // trunk and neck are one loft in body.js (the crotch ring is a loft guide below the pelvis: the skin ends in a bowl above it), and above the axilla the front of
      // every section is raised to the one above it so that the chest has no ledge (body.js buildTorso); the same here, so that the sections are those of the skin
      const tn = [...tubes.torso.rings.filter((r) => r.id !== "crotch"), ...tubes.neck.rings.slice(1)].map((r) => ({ ...r, c: r.c.slice() }));
      const i0 = tn.findIndex((r) => r.id === "axilla");
      let front = -Infinity;
      for (let i = tn.length - 1; i > i0 && i0 >= 0; i--) {
        const r = tn[i], fr = r.c[2] + r.rz;
        if (fr < front) { const back = r.c[2] - r.rz; r.rz = 0.5 * (front - back); r.c[2] = 0.5 * (front + back); } else front = fr;
      }
      addRings(tn, trunkJoint, "trunk");
    }
    addRings(body.shape.head.rings, () => "head", "head");
    for (const s of ["L", "R"]) {
      addRings(tubes[`upper_arm_${s}`].rings, () => `shoulder_${s}`, `upper_arm_${s}`, deltoidFit(body, tubes[`upper_arm_${s}`], s, P(`elbow_${s}`)[1]));
      addRings(tubes[`forearm_${s}`].rings, () => `elbow_${s}`, `forearm_${s}`);
      if (body.shape.hands?.[s]?.palm) addRings(body.shape.hands[s].palm, () => `wrist_${s}`, `palm_${s}`);
      addRings(tubes[`thigh_${s}`].rings, () => `hip_${s}`, `thigh_${s}`);
      addRings(tubes[`shank_${s}`].rings, () => `knee_${s}`, `shank_${s}`);
    }
  }
  const byId = new Map(list.map((c, i) => [c.id, i]));
  const bmi = body.mass / (body.stature * body.stature), soft = Number.isFinite(bmi) ? Math.min(1.8, Math.max(1, bmi / 24)) : 1;
  const { pairs, tol } = selfPairs(list, soft);
  const stack = [], armRings = { L: [], R: [] };
  const nTorso = tube("torso").rings.filter((r) => r.id !== "crotch").length; // the trunk loft goes on into the neck, which the neck capsule covers (an arm raised beside the head)
  rings.forEach((r, i) => {
    if (r.tube === "trunk" && r.u <= nTorso - 1) stack.push(i);
    else if (r.tube === "upper_arm_L" && r.u >= 1) armRings.L.push(i); // the section at the shoulder joint (u < 1) is inside the trunk's outline by construction
    else if (r.tube === "upper_arm_R" && r.u >= 1) armRings.R.push(i);
  });
  const arm = { stack, rings: armRings, tol: { L: ARM_TORSO, R: ARM_TORSO }, buf: new Float64Array(12 * stack.length) };
  // The head for the hands: its sections in the head joint's own frame, bottom to top (the head is rigid, so no pose is needed), and a dome above the top section up to the vertex
  const hr = rings.filter((r) => r.tube === "head").sort((a, b) => a.off[1] - b.off[1]);
  const vy = LM("vertex")[1] - P("head")[1];
  const head = { ji: JIDX.get("head"), y: Float64Array.from(hr, (r) => r.off[1]), cx: Float64Array.from(hr, (r) => r.off[0]), cz: Float64Array.from(hr, (r) => r.off[2]), rx: Float64Array.from(hr, (r) => r.rx), rz: Float64Array.from(hr, (r) => r.rz), n: Float64Array.from(hr, (r) => r.n), top: Math.max(vy, hr.length ? hr[hr.length - 1].off[1] : 0), tol: HEAD_HAND * soft };
  // the parts of each hand that are tested against it: the palm's sections (the palm capsule is 50 mm thick, a palm 25 mm), and the five fingers' capsules
  const hands = { L: { palm: [], caps: [] }, R: { palm: [] , caps: [] } };
  rings.forEach((r, i) => { if (r.tube === "palm_L") hands.L.palm.push(i); else if (r.tube === "palm_R") hands.R.palm.push(i); });
  list.forEach((c, i) => { if (c.group === "fingers") hands[c.side].caps.push(i); });
  const p = { version: 1, list, n: list.length, byId, pairs, tol, softness: soft, rings, arm, head, hands, joints: body.joints, landmarks: body.landmarks, shape: body.shape };
  // The reference postures of the library (ISO 7250-1 standing and sitting, T-pose, and the rest of the Reference group) must never be rejected for what the fitted body itself does in them: a P5 body whose
  // thighs overlap by 61 mm in the neutral pose (ring half-breadths 99 + 99 mm, ring centres 138 mm apart), a 130 kg man whose belly lies on his thighs.
  // A pair that overlaps by more than its tolerance there gets the depth it has plus 6 mm: the tolerance describes soft tissue, and this body has more.
  const W = proxyWorld(p, kin, null);
  for (const pose of REFERENCE_POSES) {
    kin.solve(pose, { x: 0, y: body.joints.pelvis.offset[1], z: 0 });
    proxyWorld(p, kin, W);
    for (let k = 0; k < tol.length; k++) tol[k] = Math.max(tol[k], overlapAt(W, pairs[2 * k], pairs[2 * k + 1]) + REFERENCE_MARGIN);
    const d = armTorsoDepth(p, kin);
    for (const s of ["L", "R"]) arm.tol[s] = Math.max(arm.tol[s], d[s] + ARM_MARGIN);
  }
  return p;
}
const RELAXED = { ...gripAngles("relaxed", "L"), ...gripAngles("relaxed", "R") }; // the hands of the reference postures of the library
const OPEN = { ...gripAngles("open", "L"), ...gripAngles("open", "R") };
// ISO 7250-1 standing / sitting and the T-pose (arms 84 degrees out, open hands: the arm hangs 3 to 14 degrees abducted, so 84 puts it horizontal for most bodies): the postures that define the
// model, listed here so that the tolerances do not depend on the library file being intact.
const BASE_REFERENCE_POSES = [{ ...RELAXED }, { ...RELAXED, hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] }, { ...OPEN, shoulder_L: [0, 84, 0], shoulder_R: [0, 84, 0] }];
/**
 * The joint angles of a posture of the Reference group of the library (postures/reference.js): its grips and its joints, `_LR` first and an explicit `_L` / `_R` over it. Not the spine, the root,
 * the eyes or the hints: how deep two capsules lie in each other does not depend on where the body stands, and the eyes have no capsule. Unknown joints and grips are skipped (the validator
 * reports them for the posture itself).
 */
function referencePose(p) {
  const a = {};
  for (const side of ["L", "R"]) {
    const g = p?.grips?.[side];
    if (typeof g === "string") { try { Object.assign(a, gripAngles(g, side)); } catch { /* an unknown grip */ } }
  }
  const put = (id, v) => { if (JIDX.has(id) && !id.startsWith("eye_") && Array.isArray(v) && v.length && v.every(Number.isFinite)) a[id] = v.slice(); };
  const entries = Object.entries(p?.joints ?? {});
  for (const [k, v] of entries) { const m = /^(.+)_LR$/.exec(k); if (m) { put(`${m[1]}_L`, v); put(`${m[1]}_R`, v); } else put(k, v); }
  for (const [k, v] of entries) if (/_[LR]$/.test(k) && !/_LR$/.test(k)) put(k, v);
  return a;
}
// All of them: the three above and every posture of the Reference group (A-pose, anatomical position, Vitruvian figure with the arms 25 degrees above the horizontal, the two arm-reach postures,
// the NIOSH lift origin and destination, the RULA neutral posture). A reference posture is never rejected for the geometry of the body itself, so each of them teaches the tolerances: it was
// the T-pose and the two ISO postures only, and the Vitruvian figure (neck against the raised arms) or the arms forward (forearm against the chest) of a body of BMI 35 to 175 failed.
const REFERENCE_POSES = Object.freeze([...BASE_REFERENCE_POSES, ...(Array.isArray(REFERENCE_GROUP) ? REFERENCE_GROUP.map(referencePose) : [])]);
const REFERENCE_MARGIN = 0.006;
// The upper arm against the trunk is judged on the skin sections, not on capsules (see armTorsoDepth): 50 mm of soft tissue of the chest and the armpit that may give
// (the arm pressed against the chest: crossed arms, a hand on the opposite shoulder), or the depth the arm has in the reference postures of THIS body plus a margin,
// whichever is more. No BMI factor: the reference depth already carries the body's own geometry (the 95th-percentile man's hanging arm is 56 mm inside his trunk's
// outline, the 5th-percentile woman's 9), and the margin is smaller than REFERENCE_MARGIN because a check on the sections of the skin has no coarse proxy to allow for.
const ARM_TORSO = 0.05;
const ARM_MARGIN = 0.003;
// A hand against the head is judged on the skin as well (handHeadDepth): the head capsule is a circle of the mean of the half-breadth and half-depth (87 mm for the median man),
// 10 mm wider than the head at the temples, and the palm capsule 25 mm thick, so a palm laid on the temple overlapped the pair by 21 to 41 mm; in front of the face the same capsule is
// 11 mm short of the skin. 20 mm of soft tissue that may give (a hand pressed on the head, a finger in the hair), times the body-mass factor like every pair.
const HEAD_HAND = 0.02;

// ---------------------------------------------------------------------------------------------------------------------
// Self-collision pairs and their tolerances (metres of allowed overlap = soft tissue plus resting contact). Rules, first match wins:
const TRUNK = new Set(["pelvis", "abdomen", "chest", "buttock", "shoulders", "neck"]);
const HAND = new Set(["palm", "fingers"]);
const LEG = new Set(["thigh", "shank", "foot", "toes", "kneecap"]);
const ADJACENT = [["upper_arm", "forearm"], ["forearm", "palm"], ["palm", "fingers"], ["thigh", "shank"], ["shank", "foot"], ["foot", "toes"], ["thigh", "kneecap"], ["shank", "kneecap"], ["shank", "toes"]];

/**
 * Tolerance (m) for two proxies, or null when the pair is never tested (same part, or neighbours that overlap by construction). These are the
 * values for a body of body-mass index 24 or less; bodyProxies multiplies them by min(1.8, BMI / 24) because the soft tissue that gives
 * grows with the fat (a 134 kg man's belly rests on his thighs when he sits).
 * Not tested here: the upper arm against the chest and the shoulder girdle (armTorsoDepth judges it on the skin) and a hand against the head (handHeadDepth).
 */
export function pairTolerance(a, b) {
  const [ga, gb, sa, sb] = [a.group, b.group, a.side, b.side];
  const same = sa === sb && sa !== null;
  const is = (x, y, p, q) => (x === p && y === q) || (x === q && y === p);
  if (ga === gb && same) return null; // the two halves of a trunk part
  if (TRUNK.has(ga) && TRUNK.has(gb)) return null; // the trunk bends and compresses as one
  if (is(ga, gb, "head", "neck")) return null;
  if (same && ADJACENT.some(([p, q]) => is(ga, gb, p, q))) return null;
  if (is(ga, gb, "pelvis", "thigh") || is(ga, gb, "buttock", "thigh")) return null; // the thighs hang from the pelvis, both sides
  if (is(ga, gb, "upper_arm", "shoulders") || is(ga, gb, "upper_arm", "chest")) return null; // the shoulder joint is inside the chest outline (and a wide chest is one sphere, whatever the side): the upper arm against the trunk is judged on the skin, armTorsoDepth
  if (is(ga, gb, "neck", "upper_arm") || is(ga, gb, "neck", "forearm")) return 0.035;
  const hand = HAND.has(ga) || HAND.has(gb), torso = TRUNK.has(ga) || TRUNK.has(gb), head = ga === "head" || gb === "head";
  const leg = LEG.has(ga) || LEG.has(gb), arm = ga === "forearm" || gb === "forearm" || ga === "upper_arm" || gb === "upper_arm";
  if (hand && head) return null; // judged on the skin sections (handHeadDepth)
  if (hand && torso) return 0.02; // a hand may rest on the body, not be inside it
  if (hand && leg) return 0.035; // a hand hanging against the thigh, or resting on it
  if (hand && (HAND.has(ga) && HAND.has(gb))) return 0.025; // clasped hands touch
  if (hand) return 0.03;
  if (arm && (torso || head)) return 0.05; // the arms hang against the trunk: their skin overlaps the trunk's by up to 25 mm in the neutral pose
  if (arm && leg) return 0.03;
  if (head && (torso || leg)) return 0.03;
  if (leg && torso) return 0.11; // thighs and calves press into the belly and chest in sitting, a deep squat or a forward bend (soft tissue)
  if (leg && same) return 0.05; // heel under the buttock, thigh on the calf
  if (ga === "thigh" && gb === "thigh") return 0.055;
  if (leg) return 0.025;
  return 0.03;
}

function selfPairs(list, soft) {
  const pairs = [], tol = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const t = pairTolerance(list[i], list[j]);
      if (t !== null) { pairs.push(i, j); tol.push(t * soft); }
    }
  }
  return { pairs: Int16Array.from(pairs), tol: Float64Array.from(tol) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation in a pose
/**
 * World capsules of the proxies for a SOLVED Kinematics (kin.solve was called with the pose). `out` (a previous result) is reused to
 * avoid allocation; it is used only when it came from the same proxies (a result of another body is not reused: its radii and ids would be that body's). Returns { n, ids, ax, ay, az, bx, by, bz, ra, rb } (structure of arrays: ids[i] is the proxy id, the others are
 * Float64Arrays; ra / rb are copied from the proxies). The result is valid until the next call with the same `out`.
 */
export function proxyWorld(proxies, kin, out) {
  const n = proxies.n;
  if (!proxies.flat) {
    const ja = new Int16Array(n), jb = new Int16Array(n), off = new Float64Array(6 * n), ra = new Float64Array(n), rb = new Float64Array(n);
    proxies.list.forEach((c, i) => {
      ja[i] = JIDX.get(c.a.joint); jb[i] = JIDX.get(c.b.joint);
      off.set(c.a.off, 6 * i); off.set(c.b.off, 6 * i + 3);
      ra[i] = c.ra; rb[i] = c.rb;
    });
    Object.defineProperty(proxies, "flat", { value: { ja, jb, off, ra, rb, ids: proxies.list.map((c) => c.id) }, enumerable: false });
  }
  const F = proxies.flat;
  const w = out && out.ids === F.ids ? out : { n, ids: F.ids, ax: new Float64Array(n), ay: new Float64Array(n), az: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n), bz: new Float64Array(n), ra: F.ra, rb: F.rb };
  const P = kin.positions, Q = kin.quaternions, off = F.off;
  for (let i = 0; i < n; i++) {
    for (let e = 0; e < 2; e++) {
      const j = e === 0 ? F.ja[i] : F.jb[i], o = 6 * i + 3 * e, j3 = 3 * j, j4 = 4 * j;
      const vx = off[o], vy = off[o + 1], vz = off[o + 2], x = Q[j4], y = Q[j4 + 1], z = Q[j4 + 2], qw = Q[j4 + 3];
      const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
      const px = P[j3] + vx + qw * tx + (y * tz - z * ty), py = P[j3 + 1] + vy + qw * ty + (z * tx - x * tz), pz = P[j3 + 2] + vz + qw * tz + (x * ty - y * tx);
      if (e === 0) { w.ax[i] = px; w.ay[i] = py; w.az[i] = pz; } else { w.bx[i] = px; w.by[i] = py; w.bz[i] = pz; }
    }
  }
  return w;
}

/** The lowest point of the swept volume of the world capsules: { y, point: Vector3, proxy: id }. */
export function lowestPoint(world, out = new THREE.Vector3()) {
  let y = Infinity, k = -1, atA = true;
  for (let i = 0; i < world.n; i++) {
    const ya = world.ay[i] - world.ra[i], yb = world.by[i] - world.rb[i];
    if (ya < y) { y = ya; k = i; atA = true; }
    if (yb < y) { y = yb; k = i; atA = false; }
  }
  if (k < 0) return { y: Infinity, point: out.set(0, Infinity, 0), proxy: null };
  out.set(atA ? world.ax[k] : world.bx[k], y, atA ? world.az[k] : world.bz[k]);
  return { y, point: out, proxy: world.ids[k] };
}

const SUPPORT_CAPSULES = new Set(["fingers", "foot", "toes"]); // the parts that are thinner than their section rings or have none: the hand's fingers, the foot, the toes
const TIP_CAPSULES = new Set(["fingers", "toes"]); // capsules whose b end is a tip landmark
const SKIN_MARGIN = 0.003; // the skin between two rings swells a little beyond the rings (cubic interpolation of the sections)
/**
 * The lowest point of the SKIN of a posed body (for a body lying on the floor): { y, point: Vector3 (x and z of the section centre, not the exact
 * point), proxy: "ring:<joint>" | the id of a capsule }. The skin is a loft of the superellipse sections of body.shape (the same data as the
 * rings of `proxies`), so the lowest point of a section is exact: centre height minus the support function of the superellipse in the vertical
 * direction, (|rx ex_y|^q + |rz ez_y|^q)^(1/q) with q = n / (n - 1) and ex, ez the section's axes after the rotation of its joint. The rings of a tube are
 * joined by SUB_RINGS interpolated sections each (the skin lofts a smooth curve through them: a body rolled half way sank up to 11 mm without them). Fingers, foot
 * and toes (not sections) use their capsules, the tip end of a finger or toe pulled back by its radius (the tip landmark is on the skin, the end sphere is centred
 * on it, 14 mm beyond it for a toe). This replaces the lowest point of the capsules (`lowestPoint`), which are 5 to 15 mm off the
 * skin where a limb is not round (a hand is 25 mm thick and 80 mm wide). `world` is proxyWorld(proxies, kin) of the same pose. A test compares it
 * with the lowest vertex of the skin of body.js (lying postures within 5 mm for 98 % of 792 bodies x positions, worst 7 mm: pose.test.mjs, pose.adversarial2.test.mjs).
 */
export function lowestSkinPoint(proxies, kin, world, out = new THREE.Vector3()) {
  const P = kin.positions, Q = kin.quaternions;
  let y = Infinity, k = -1, atX = 0, atZ = 0, rk = null;
  for (let i = 0; i < proxies.rings.length; i++) {
    const r = proxies.rings[i], j3 = 3 * r.ji, j4 = 4 * r.ji, x = Q[j4], yy = Q[j4 + 1], z = Q[j4 + 2], w = Q[j4 + 3];
    // y component of the rotated vector v (and the centre's x and z): v' = v + w t + q x t, t = 2 q x v
    const yOf = (v) => { const tx = 2 * (yy * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - yy * v[0]); return v[1] + w * ty + (z * tx - x * tz); };
    const ex = yOf(r.ex), ez = yOf(r.ez), cy = P[j3 + 1] + yOf(r.off);
    const low = cy - ((Math.abs(r.rx * ex) ** r.q + Math.abs(r.rz * ez) ** r.q) ** (1 / r.q) + SKIN_MARGIN);
    if (low < y) { y = low; k = i; }
  }
  if (k >= 0) { const r = proxies.rings[k], j3 = 3 * r.ji, j4 = 4 * r.ji, x = Q[j4], yy = Q[j4 + 1], z = Q[j4 + 2], w = Q[j4 + 3], v = r.off;
    const tx = 2 * (yy * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - yy * v[0]);
    atX = P[j3] + v[0] + w * tx + (yy * tz - z * ty); atZ = P[j3 + 2] + v[2] + w * tz + (x * ty - yy * tx); rk = `ring:${r.joint}`; }
  for (let i = 0; i < world.n; i++) {
    const group = proxies.list[i].group;
    if (!SUPPORT_CAPSULES.has(group)) continue;
    // The b end of a finger or a toe is the tip landmark, which lies ON the skin, but its end sphere is centred on it and so sticks out by its radius (14 mm for
    // the toes): a toe pointing at the floor would put the body 14 mm too high. The sphere is pulled back along the axis until it touches the tip.
    let bx = world.bx[i], by = world.by[i], bz = world.bz[i];
    if (TIP_CAPSULES.has(group)) {
      const dx = bx - world.ax[i], dy = by - world.ay[i], dz = bz - world.az[i], len = Math.hypot(dx, dy, dz), k = len > 1e-9 ? Math.min(world.rb[i], len) / len : 0;
      bx -= dx * k; by -= dy * k; bz -= dz * k;
    }
    const ya = world.ay[i] - world.ra[i], yb = by - world.rb[i];
    if (ya < y) { y = ya; atX = world.ax[i]; atZ = world.az[i]; rk = world.ids[i]; }
    if (yb < y) { y = yb; atX = bx; atZ = bz; rk = world.ids[i]; }
  }
  out.set(atX, y, atZ);
  return { y, point: out, proxy: rk };
}

const ARM_ANGLES = 12; // points on the boundary of each section of the upper arm
const _q = new Float64Array(3);
// v rotated by the quaternion at Q[j4..j4+3] into _q
function rotTo(Q, j4, vx, vy, vz) {
  const x = Q[j4], y = Q[j4 + 1], z = Q[j4 + 2], w = Q[j4 + 3];
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  _q[0] = vx + w * tx + (y * tz - z * ty); _q[1] = vy + w * ty + (z * tx - x * tz); _q[2] = vz + w * tz + (x * ty - y * tx);
}
/**
 * How far the skin of each upper arm lies inside the skin of the trunk in a SOLVED pose (`kin`): { L, R } in metres (positive = inside; -Infinity when the arm is
 * nowhere near the trunk). The capsules cannot do this job: the shoulder joint lies inside the chest's outline, so a capsule pair has to be excused from the
 * upper arm / chest test altogether (it was: an arm swung back through the thorax passed with 100 to 135 mm of skin inside the trunk). Here the sections of the
 * arm's tube (the shoulder section excepted) are sampled on their boundary (12 points of the superellipse each) and every point is looked up in the posed stack of
 * trunk and neck sections: the two sections whose planes enclose it, the depth `(1 - f) * min(rx, rz)` in each (f = the superellipse norm of the point in the
 * section's own axes) and the mean of the two by the distance to the planes. Cost about 20 microseconds. bodyProxies learns the allowed depth per body and side from the reference
 * postures (proxies.arm.tol, m).
 */
export function armTorsoDepth(proxies, kin, out = { L: -Infinity, R: -Infinity }) {
  const { stack, rings: armRings, buf } = proxies.arm, R = proxies.rings, P = kin.positions, Q = kin.quaternions, N = stack.length;
  for (let i = 0; i < N; i++) { // the stack in the pose: centre, lateral axis, anterior axis, normal (towards the head) of every trunk section
    const r = R[stack[i]], j3 = 3 * r.ji, j4 = 4 * r.ji, o = 12 * i;
    rotTo(Q, j4, r.off[0], r.off[1], r.off[2]); buf[o] = P[j3] + _q[0]; buf[o + 1] = P[j3 + 1] + _q[1]; buf[o + 2] = P[j3 + 2] + _q[2];
    rotTo(Q, j4, r.ex[0], r.ex[1], r.ex[2]); buf[o + 3] = _q[0]; buf[o + 4] = _q[1]; buf[o + 5] = _q[2];
    rotTo(Q, j4, r.ez[0], r.ez[1], r.ez[2]); buf[o + 6] = _q[0]; buf[o + 7] = _q[1]; buf[o + 8] = _q[2];
    const sg = r.ns; // ex x ez points up or down depending on how frame() oriented the axes; ns turns it towards the head
    buf[o + 9] = sg * (buf[o + 4] * buf[o + 8] - buf[o + 5] * buf[o + 7]); buf[o + 10] = sg * (buf[o + 5] * buf[o + 6] - buf[o + 3] * buf[o + 8]); buf[o + 11] = sg * (buf[o + 3] * buf[o + 7] - buf[o + 4] * buf[o + 6]);
  }
  for (const side of ["L", "R"]) {
    let worst = -Infinity;
    for (const ri of armRings[side]) {
      const r = R[ri], j3 = 3 * r.ji, j4 = 4 * r.ji;
      rotTo(Q, j4, r.off[0], r.off[1], r.off[2]);
      const cx = P[j3] + _q[0], cy = P[j3 + 1] + _q[1], cz = P[j3 + 2] + _q[2];
      rotTo(Q, j4, r.ex[0], r.ex[1], r.ex[2]); const ex = _q[0], ey = _q[1], ez_ = _q[2];
      rotTo(Q, j4, r.ez[0], r.ez[1], r.ez[2]); const fx = _q[0], fy = _q[1], fz = _q[2];
      const e = 2 / r.n;
      for (let a = 0; a < ARM_ANGLES; a++) {
        const th = (a * 2 * Math.PI) / ARM_ANGLES, c = Math.cos(th), s = Math.sin(th), u = r.rx * Math.sign(c) * Math.abs(c) ** e, v = r.rz * Math.sign(s) * Math.abs(s) ** e;
        const px = cx + u * ex + v * fx, py = cy + u * ey + v * fy, pz = cz + u * ez_ + v * fz;
        const d = trunkDepth(proxies, px, py, pz);
        if (d > worst) worst = d;
      }
    }
    out[side] = worst;
  }
  return out;
}
// depth (positive = inside) of a world point in the posed stack of trunk sections of armTorsoDepth; -Infinity above, below or beside the stack
function trunkDepth(proxies, px, py, pz) {
  const { stack, buf } = proxies.arm, R = proxies.rings, N = stack.length;
  let s0 = (px - buf[0]) * buf[9] + (py - buf[1]) * buf[10] + (pz - buf[2]) * buf[11];
  for (let i = 0; i + 1 < N; i++) {
    const o1 = 12 * (i + 1), s1 = (px - buf[o1]) * buf[o1 + 9] + (py - buf[o1 + 1]) * buf[o1 + 10] + (pz - buf[o1 + 2]) * buf[o1 + 11];
    if (s0 >= 0 && s1 < 0) {
      const t = s0 / (s0 - s1);
      return (1 - t) * sectionDepth(R[stack[i]], buf, 12 * i, px, py, pz, s0) + t * sectionDepth(R[stack[i + 1]], buf, o1, px, py, pz, s1);
    }
    s0 = s1;
  }
  return -Infinity;
}
// depth of the world point p in the section r (posed data at buf[o..o+11]); s = its signed distance to the section plane
function sectionDepth(r, buf, o, px, py, pz, s) {
  const dx = px - buf[o] - s * buf[o + 9], dy = py - buf[o + 1] - s * buf[o + 10], dz = pz - buf[o + 2] - s * buf[o + 11];
  const a = Math.abs((dx * buf[o + 3] + dy * buf[o + 4] + dz * buf[o + 5]) / r.rx), b = Math.abs((dx * buf[o + 6] + dy * buf[o + 7] + dz * buf[o + 8]) / r.rz);
  return (1 - (a ** r.n + b ** r.n) ** (1 / r.n)) * Math.min(r.rx, r.rz);
}

// ---------------------------------------------------------------------------------------------------------------------
// Hands against the head, on the skin
// depth (positive = inside, m) of a point given relative to the head joint in the neutral orientation, in the lofted sections of the head; -Infinity above the vertex or below the chin section
function headDepth(H, x, y, z) {
  const ys = H.y, N = ys.length;
  if (!N || y < ys[0] || y > H.top) return -Infinity;
  let cx, cz, rx, rz, n;
  if (y > ys[N - 1]) { // the dome above the top section is an ellipsoid cap
    const k = Math.sqrt(Math.max(0, 1 - ((y - ys[N - 1]) / Math.max(1e-6, H.top - ys[N - 1])) ** 2));
    cx = H.cx[N - 1]; cz = H.cz[N - 1]; rx = H.rx[N - 1] * k; rz = H.rz[N - 1] * k; n = H.n[N - 1];
  } else {
    let i = 0;
    while (i < N - 2 && ys[i + 1] < y) i++;
    const t = Math.min(1, Math.max(0, (y - ys[i]) / Math.max(1e-9, ys[i + 1] - ys[i]))), L = (a) => a[i] + (a[i + 1] - a[i]) * t;
    cx = L(H.cx); cz = L(H.cz); rx = L(H.rx); rz = L(H.rz); n = L(H.n);
  }
  if (rx < 1e-4 || rz < 1e-4) return -Infinity;
  return (1 - (Math.abs((x - cx) / rx) ** n + Math.abs((z - cz) / rz) ** n) ** (1 / n)) * Math.min(rx, rz);
}

/**
 * How far each part of each hand lies inside the head in a SOLVED pose (`kin`, `world` = proxyWorld of it): an array of { part: "palm_L" | "fingers_R" | "thumb_L" | ..., depth }
 * (m, positive = inside, only the parts within reach of the head; `out` is reused). The palm is judged by the boundary of its sections (12 points each, skin on the
 * palm side), a finger by three spheres along its capsule (knuckle, middle, and the tip pulled back by its radius, as lowestSkinPoint does: the tip landmark is on the skin)
 * whose radius is added to the depth of their centre. The head is the loft of its sections (the same data as the skin), which is 10 mm narrower at the temples than its capsule
 * and 11 mm deeper at the face. Cost: a few microseconds when the hands are away from the head, about 20 when one is near it.
 */
export function handHeadDepth(proxies, kin, world, out = []) {
  out.length = 0;
  const H = proxies.head, P = kin.positions, Q = kin.quaternions, j3 = 3 * H.ji, j4 = 4 * H.ji;
  const hx = P[j3], hy = P[j3 + 1], hz = P[j3 + 2], qx = -Q[j4], qy = -Q[j4 + 1], qz = -Q[j4 + 2], qw = Q[j4 + 3];
  const R = proxies.rings;
  // world point -> relative to the head joint, in its neutral orientation (rotation by the conjugate quaternion) -> depth
  const depthAt = (x, y, z) => {
    const dx = x - hx, dy = y - hy, dz = z - hz, tx = 2 * (qy * dz - qz * dy), ty = 2 * (qz * dx - qx * dz), tz = 2 * (qx * dy - qy * dx);
    return headDepth(H, dx + qw * tx + (qy * tz - qz * ty), dy + qw * ty + (qz * tx - qx * tz), dz + qw * tz + (qx * ty - qy * tx));
  };
  for (const side of ["L", "R"]) {
    const hd = proxies.hands[side], pi = proxies.byId.get(`palm_${side}`);
    const mx = 0.5 * (world.ax[pi] + world.bx[pi]), my = 0.5 * (world.ay[pi] + world.by[pi]), mz = 0.5 * (world.az[pi] + world.bz[pi]);
    if (Math.hypot(mx - hx, my - hy, mz - hz) > REACH) continue; // the hand is nowhere near the head (the hand and the fingers reach 0.2 m from the middle of the palm, the head 0.15 m from its joint)
    let palm = -Infinity;
    for (const ri of hd.palm) {
      const r = R[ri], rj3 = 3 * r.ji, rj4 = 4 * r.ji;
      rotTo(Q, rj4, r.off[0], r.off[1], r.off[2]); const cx = P[rj3] + _q[0], cy = P[rj3 + 1] + _q[1], cz = P[rj3 + 2] + _q[2];
      rotTo(Q, rj4, r.ex[0], r.ex[1], r.ex[2]); const ex = _q[0], ey = _q[1], ez_ = _q[2];
      rotTo(Q, rj4, r.ez[0], r.ez[1], r.ez[2]); const fx = _q[0], fy = _q[1], fz = _q[2];
      const e = 2 / r.n;
      for (let a = 0; a < ARM_ANGLES; a++) {
        const th = (a * 2 * Math.PI) / ARM_ANGLES, c = Math.cos(th), sn = Math.sin(th), u = r.rx * Math.sign(c) * Math.abs(c) ** e, v = r.rz * Math.sign(sn) * Math.abs(sn) ** e;
        const d = depthAt(cx + u * ex + v * fx, cy + u * ey + v * fy, cz + u * ez_ + v * fz);
        if (d > palm) palm = d;
      }
    }
    if (palm > -Infinity) out.push({ part: `palm_${side}`, depth: palm });
    for (const ci of hd.caps) {
      const ax = world.ax[ci], ay = world.ay[ci], az = world.az[ci], dx = world.bx[ci] - ax, dy = world.by[ci] - ay, dz = world.bz[ci] - az, len = Math.hypot(dx, dy, dz);
      const ra = world.ra[ci], rb = world.rb[ci], s1 = len > 1e-9 ? Math.max(0, 1 - rb / len) : 0;
      let best = -Infinity;
      for (const s of [0, 0.5 * s1, s1]) {
        const d = depthAt(ax + dx * s, ay + dy * s, az + dz * s) + ra + (rb - ra) * s;
        if (d > best) best = d;
      }
      if (best > -Infinity) out.push({ part: world.ids[ci], depth: best });
    }
  }
  return out;
}
const REACH = 0.4;

/**
 * The overlaps that are judged on the skin sections rather than on capsules, in the form of selfPenetrations: [{ a, b, depth, tolerance, excess }] (ids; m), deepest excess first.
 * The upper arm against the trunk (`a` = "upper_arm_L", `b` = "trunk", armTorsoDepth) and a hand against the head (`a` = "head", `b` = "palm_L" | "thumb_R" | ..., handHeadDepth).
 * `kin` is solved for the pose, `world` = proxyWorld(proxies, kin). `slack` is added to every tolerance; `all: true` returns every positive depth, not only those beyond the tolerance.
 */
export function skinPenetrations(proxies, kin, world, { slack = 0, all = false } = {}) {
  const out = [], arms = armTorsoDepth(proxies, kin);
  for (const side of ["L", "R"]) {
    const tol = proxies.arm.tol[side] + slack, depth = arms[side];
    if (all ? depth > 0 : depth > tol) out.push({ a: `upper_arm_${side}`, b: "trunk", depth, tolerance: tol, excess: depth - tol });
  }
  const tol = proxies.head.tol + slack;
  for (const h of handHeadDepth(proxies, kin, world)) if (all ? h.depth > 0 : h.depth > tol) out.push({ a: "head", b: h.part, depth: h.depth, tolerance: tol, excess: h.depth - tol });
  return out.sort((x, y) => y.excess - x.excess);
}

/** Squared distance between two segments and the parameters of the closest points (Ericson, Real-Time Collision Detection 5.1.9). */
const CP = { s: 0, t: 0, d2: 0 };
function closest(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z, d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s, t;
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = cl(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = cl(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > EPS ? cl((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = cl(-c / a); } else if (t > 1) { t = 1; s = cl((b - c) / a); }
    }
  }
  const cx = p1x + d1x * s - (p2x + d2x * t), cy = p1y + d1y * s - (p2y + d2y * t), cz = p1z + d1z * s - (p2z + d2z * t);
  CP.s = s; CP.t = t; CP.d2 = cx * cx + cy * cy + cz * cz;
  return CP;
}

// Depth of two capsules: max over s, t in [0, 1] of r1(s) + r2(t) - |p1(s) - p2(t)| (radius linear along each axis). The function is concave in (s, t)
// (a norm of an affine map, minus an affine function), so g(s) = max over t of it is concave too, and the maximum is found exactly:
// for a given s the best t has a closed form (`slide`), and g'(s) = k1 - w.d1 / |w| (w = p1(s) - p2(t*), envelope theorem) is non-increasing, so a bisection
// on its sign finds s. For constant radii the closest points of the axes are already the answer. Along one axis,
// h(s) = |w + s d| - s k is minimised where (a s + b) / |w + s d| = k (a = d.d, b = d.w, k = the radius change along the axis), a quadratic in u = a s + b.
function slide(dx, dy, dz, wx, wy, wz, k) { // the s in [0, 1] that minimises |w + s d| - s k
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-18 || k * k >= a) return k > 0 ? 1 : 0;
  const b = dx * wx + dy * wy + dz * wz, c = wx * wx + wy * wy + wz * wz, D = Math.max(0, a * c - b * b);
  const u = k === 0 ? 0 : Math.sign(k) * Math.abs(k) * Math.sqrt(D / (a - k * k)), s = (u - b) / a;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}
const Q = new Float64Array(16); // p1 (0-2), d1 (3-5), r1a (6), k1 (7), p2 (8-10), d2 (11-13), r2a (14), k2 (15) of the pair being evaluated
let GP = 0; // g'(s) of the last evalS
function evalS(s) { // g(s); g'(s) in GP
  const wx = Q[0] + Q[3] * s - Q[8], wy = Q[1] + Q[4] * s - Q[9], wz = Q[2] + Q[5] * s - Q[10];
  const t = slide(-Q[11], -Q[12], -Q[13], wx, wy, wz, Q[15]);
  const ex = wx - Q[11] * t, ey = wy - Q[12] * t, ez = wz - Q[13] * t, L = Math.sqrt(ex * ex + ey * ey + ez * ez);
  GP = Q[7] - (L > 1e-15 ? (ex * Q[3] + ey * Q[4] + ez * Q[5]) / L : 0);
  return Q[6] + Q[7] * s + Q[14] + Q[15] * t - L;
}
// `floor`: a depth at or below it is of no interest (the caller only asks whether the pair overlaps by more than that); then an upper bound is returned when it is below the floor
function depth(p1x, p1y, p1z, q1x, q1y, q1z, r1a, r1b, p2x, p2y, p2z, q2x, q2y, q2z, r2a, r2b, floor = -Infinity) {
  const c = closest(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z), k1 = r1b - r1a, k2 = r2b - r2a;
  const dist = Math.sqrt(c.d2), base = r1a + k1 * c.s + r2a + k2 * c.t - dist;
  if (k1 === 0 && k2 === 0) return base;
  const bound = Math.max(r1a, r1b) + Math.max(r2a, r2b) - dist; // no point of the two axes is closer than `dist`, no radius is larger than the larger end
  if (bound <= floor) return bound;
  Q[0] = p1x; Q[1] = p1y; Q[2] = p1z; Q[3] = q1x - p1x; Q[4] = q1y - p1y; Q[5] = q1z - p1z; Q[6] = r1a; Q[7] = k1;
  Q[8] = p2x; Q[9] = p2y; Q[10] = p2z; Q[11] = q2x - p2x; Q[12] = q2y - p2y; Q[13] = q2z - p2z; Q[14] = r2a; Q[15] = k2;
  let best = Math.max(base, evalS(0)), gp0 = GP;
  if (gp0 <= 0) return best;
  best = Math.max(best, evalS(1));
  if (GP >= 0) return best;
  let lo = 0, hi = 1;
  for (let it = 0; it < 20; it++) {
    const m = 0.5 * (lo + hi), g = evalS(m);
    if (g > best) best = g;
    if (GP > 0) lo = m; else hi = m;
  }
  return best;
}

const xyz = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
/**
 * Penetration depth (m) of two capsules: > 0 = overlapping by that much, < 0 = apart by that distance (surface to surface) { a, b, ra, rb } (a, b: Vector3, [x, y, z] or {x, y, z}; `r` sets both radii).
 * Exact for the hull of the two end spheres (the radius changes linearly along the axis): the maximum over the two axis parameters of r1 + r2 - distance.
 */
export function capsuleOverlap(c1, c2) {
  const a1 = xyz(c1.a), b1 = xyz(c1.b), a2 = xyz(c2.a), b2 = xyz(c2.b);
  return depth(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], c1.ra ?? c1.r, c1.rb ?? c1.r, a2[0], a2[1], a2[2], b2[0], b2[1], b2[2], c2.ra ?? c2.r, c2.rb ?? c2.r);
}

/** Depth of proxies i and j of a world result (index form of capsuleOverlap, allocation free). With `floor`, a depth that is not above it may come back as an upper bound instead (selfPenetrations uses it to skip pairs that are far apart). */
export function overlapAt(w, i, j, floor = -Infinity) {
  return depth(w.ax[i], w.ay[i], w.az[i], w.bx[i], w.by[i], w.bz[i], w.ra[i], w.rb[i], w.ax[j], w.ay[j], w.az[j], w.bx[j], w.by[j], w.bz[j], w.ra[j], w.rb[j], floor);
}

/**
 * The pairs of proxies that overlap by more than their tolerance (soft tissue and resting contact are allowed): array of
 * { a, b, depth, tolerance, excess } (ids; metres), deepest excess first. `slack` (m, default 0) is added to every tolerance;
 * `all: true` returns every positive depth of the tested pairs, not only those beyond the tolerance.
 */
export function selfPenetrations(proxies, world, { slack = 0, all = false } = {}) {
  const out = [], P = proxies.pairs, T = proxies.tol;
  for (let k = 0; k < T.length; k++) {
    const i = P[2 * k], j = P[2 * k + 1];
    const tol = T[k] + slack, depth = overlapAt(world, i, j, all ? 0 : tol);
    if (all ? depth > 0 : depth > tol) out.push({ a: world.ids[i], b: world.ids[j], depth, tolerance: tol, excess: depth - tol });
  }
  return out.sort((x, y) => y.excess - x.excess);
}

/** A world capsule of a result as { id, a: Vector3, b: Vector3, ra, rb } (for drawing and for capsuleOverlap). */
export function worldCapsule(world, i) {
  return { id: world.ids[i], a: new THREE.Vector3(world.ax[i], world.ay[i], world.az[i]), b: new THREE.Vector3(world.bx[i], world.by[i], world.bz[i]), ra: world.ra[i], rb: world.rb[i] };
}
