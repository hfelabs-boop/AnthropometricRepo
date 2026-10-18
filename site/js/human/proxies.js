// Collision and support proxies of a body: about 30 capsules derived from the shape rings and the landmarks of a BodyModel (fit.js).
// They stand in for the skin where the posture library needs geometry: the lowest point of a lying body (support), and "is a hand
// inside the torso, a shin through the other shin, the head into the shoulders" (gross self-intersection, POSTURES.md rule 5).
// They are not a collision mesh: soft tissue gives, so every pair has a tolerance (selfPenetrations) and resting contact is allowed.
// Pure: three, skeleton.js and fk.js only; no DOM. Cost on one core: proxyWorld + lowestPoint about 1 microsecond, the 328 pair checks of
// selfPenetrations about 25 (pose.test.mjs asserts both stay under 0.3 ms).
//
// A capsule here is the convex hull of two spheres (a "sphere-cone"): end points A and B, radii ra and rb. Each end is attached to a
// joint frame (`{ joint, off }`, off = the neutral world offset from the joint centre, exactly like a landmark), so a proxy follows
// the pose through Kinematics. Limb capsules have both ends on the proximal joint of the segment (rigid, as the bone is); the three
// trunk parts have their ends on the spine joints at their heights, so they bend with the spine.
//
// Radii come from the shape rings of the body (half-breadth rx, half-depth rz, mean (rx + rz) / 2 per ring) so they follow the
// person's girths. The trunk is an ellipse in section, a capsule is round: each trunk part is a PAIR of capsules (left and right of
// the midline, offset by rx - rz, radius rz), whose union is a stadium, close to the elliptical section. The pelvis is such a pair plus a
// buttock sphere on each side (bottom on the ischial landmark, rear on the most posterior point of the buttock).
import * as THREE from "three";
import { JOINTS } from "./skeleton.js";
import { Kinematics } from "./fk.js";

const JIDX = new Map(JOINTS.map((j, i) => [j.id, i]));
const SPINE = JOINTS.filter((j) => j.region).map((j) => j.id); // L5 .. L1, T12 .. T1, C7 .. C1 (table order = bottom to top)

const fail = (msg) => { throw new Error(`bodyProxies: ${msg}`); };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rr = (ring) => 0.5 * (ring.rx + ring.rz);

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
    pair("pelvis", "pelvis", [buttock, lowAbd], buttock.rz, ischialY, waist.c[1], () => "pelvis");
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
    const first = (t) => t.rings[0], last = (t) => t.rings[t.rings.length - 1];
    add(`upper_arm_${s}`, "upper_arm", s, at(`shoulder_${s}`, first(ua).c), at(`shoulder_${s}`, last(ua).c), mean(ua.rings.slice(0, 2).map(rr)), rr(last(ua)));
    const faMax = ring(fa, "fa_max", 0.33), faWrist = last(fa);
    add(`forearm_${s}`, "forearm", s, at(`elbow_${s}`, first(fa).c), at(`elbow_${s}`, faWrist.c), rr(faMax), rr(faWrist));
    // hand: the palm from the wrist to the middle knuckle, the fingers from the knuckle to the fingertip (the fingers follow the grip)
    const hand = body.shape.hands?.[s];
    const pw = hand?.palm?.[0], pk = hand?.palm?.[hand.palm.length - 1];
    const mcp = P(`middle_mcp_${s}`), wrist = P(`wrist_${s}`);
    add(`palm_${s}`, "palm", s, at(`wrist_${s}`, wrist), at(`wrist_${s}`, mcp), pw ? rr(pw) : 0.025, pk ? rr(pk) : 0.029);
    add(`fingers_${s}`, "fingers", s, at(`middle_mcp_${s}`, mcp), at(`middle_dip_${s}`, LM(`middle_tip_${s}`)), 0.011, 0.008);
    add(`thigh_${s}`, "thigh", s, at(`hip_${s}`, first(th).c), at(`hip_${s}`, last(th).c), mean(th.rings.slice(0, 2).map(rr)), rr(last(th)));
    const calf = ring(sh, "sh_calf", 0.25), ankle = ring(sh, "sh_ankle", 0.75);
    add(`shank_${s}`, "shank", s, at(`knee_${s}`, first(sh).c), at(`knee_${s}`, ankle.c), rr(calf), rr(ankle));
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

  const byId = new Map(list.map((c, i) => [c.id, i]));
  const bmi = body.mass / (body.stature * body.stature), soft = Number.isFinite(bmi) ? Math.min(1.8, Math.max(1, bmi / 24)) : 1;
  const { pairs, tol } = selfPairs(list, soft);
  return { version: 1, list, n: list.length, byId, pairs, tol, softness: soft, joints: body.joints, landmarks: body.landmarks, shape: body.shape };
}

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
  if (is(ga, gb, "upper_arm", "shoulders") || is(ga, gb, "upper_arm", "chest")) return null; // the shoulder joint is inside the chest outline (and a wide chest is one sphere, whatever the side)
  if (is(ga, gb, "neck", "upper_arm") || is(ga, gb, "neck", "forearm")) return 0.035;
  const hand = HAND.has(ga) || HAND.has(gb), torso = TRUNK.has(ga) || TRUNK.has(gb), head = ga === "head" || gb === "head";
  const leg = LEG.has(ga) || LEG.has(gb), arm = ga === "forearm" || gb === "forearm" || ga === "upper_arm" || gb === "upper_arm";
  if (hand && (torso || head)) return 0.02; // a hand may rest on the body, not be inside it
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
 * avoid allocation. Returns { n, ids, ax, ay, az, bx, by, bz, ra, rb } (structure of arrays: ids[i] is the proxy id, the others are
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
  const w = out && out.n === n ? out : { n, ids: F.ids, ax: new Float64Array(n), ay: new Float64Array(n), az: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n), bz: new Float64Array(n), ra: F.ra, rb: F.rb };
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

const xyz = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
/**
 * Penetration depth (m) of two capsules: > 0 = overlapping by that much, < 0 = apart by that distance (surface to surface) { a, b, ra, rb } (a, b: Vector3, [x, y, z] or {x, y, z}; `r` sets both radii).
 * The radius is interpolated along each axis at the closest points (exact for a capsule, a good approximation for a tapered one).
 */
export function capsuleOverlap(c1, c2) {
  const a1 = xyz(c1.a), b1 = xyz(c1.b), a2 = xyz(c2.a), b2 = xyz(c2.b);
  const r1a = c1.ra ?? c1.r, r1b = c1.rb ?? c1.r, r2a = c2.ra ?? c2.r, r2b = c2.rb ?? c2.r;
  const k = closest(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], a2[0], a2[1], a2[2], b2[0], b2[1], b2[2]);
  return r1a + k.s * (r1b - r1a) + r2a + k.t * (r2b - r2a) - Math.sqrt(k.d2);
}

/** Depth of proxies i and j of a world result (index form of capsuleOverlap, allocation free). */
export function overlapAt(w, i, j) {
  const k = closest(w.ax[i], w.ay[i], w.az[i], w.bx[i], w.by[i], w.bz[i], w.ax[j], w.ay[j], w.az[j], w.bx[j], w.by[j], w.bz[j]);
  return w.ra[i] + k.s * (w.rb[i] - w.ra[i]) + w.ra[j] + k.t * (w.rb[j] - w.ra[j]) - Math.sqrt(k.d2);
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
    const depth = overlapAt(world, i, j), tol = T[k] + slack;
    if (all ? depth > 0 : depth > tol) out.push({ a: world.ids[i], b: world.ids[j], depth, tolerance: tol, excess: depth - tol });
  }
  return out.sort((x, y) => y.excess - x.excess);
}

/** A world capsule of a result as { id, a: Vector3, b: Vector3, ra, rb } (for drawing and for capsuleOverlap). */
export function worldCapsule(world, i) {
  return { id: world.ids[i], a: new THREE.Vector3(world.ax[i], world.ay[i], world.az[i]), b: new THREE.Vector3(world.bx[i], world.by[i], world.bz[i]), ra: world.ra[i], rb: world.rb[i] };
}
