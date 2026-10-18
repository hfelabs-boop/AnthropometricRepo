// Object catalogue of the Digital human sandbox: parametric objects built from simple procedural geometry (boxes, cylinders, lathes,
// extrusions), each with editable parameters, ANCHORS (named points for measuring and snapping), GRIPS (hand targets for the later IK
// module) and SUPPORTS (horizontal surfaces a body can rest on). Contract: docs/human3d/DESIGN.md 2.5, 3.4. Imports only three.js and
// never touches the DOM, so it is tested in Node (tests/human3d/sandbox.test.mjs).
//
// Conventions (the same for every type)
//   * Units: metres and degrees in the model; a parameter's `unit` says what the UI shows ("m" = a length shown in the user's length unit).
//   * Local frame: +Y up, the origin is the point ON THE FLOOR under the object's reference (seat: the seat reference point; monitor: the
//     screen centre; pedals: the accelerator heel point; tools: under the grip, resting on their lowest point). Every object stays at
//     y >= 0 in its own frame (tests/human3d/sandbox.test.mjs checks it for every type, at default and extreme parameters).
//   * +Z is the object's FRONT: the side that faces its user (screen, wheel, desk, pedals, handle), and for seats the direction the
//     sitter faces. So a person using a display stands/sits at +Z of it, looking towards -Z; their left hand is then on -X.
//   * Anchors are { id: { label, position: [x, y, z], normal?: [x, y, z] } } (normal: the viewing / facing direction, e.g. of a screen).
//   * Grips are { id, label, hand: "L" | "R" | "both", position, normal, axis, diameter }: `normal` is the direction the palm faces
//     (from the hand towards the object), `axis` the direction of the bar the fingers wrap around, `diameter` that bar's diameter (0 = flat).
//     "L" / "R" are the person's own hands; "both" = either hand.
//   * Supports are { id, label, y, size: [w, d], center: [x, z], pitch? } in the local frame (`pitch`: degrees the surface is tilted about X,
//     for a seat pan with a pan angle; `y` is its height at `center`).
//   * Draw calls: every part is merged per material, so an object is 2 to 8 meshes whatever its detail.
// Dimensions are typical product / literature values; where a standard is the source the comment of the type says so. They are defaults for
// design studies, not statements of what a standard requires: check the current revision of the standard for compliance work.
import * as THREE from "three";

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// ---------------------------------------------------------------------------------------------------------------------
// shared palette: mid-tone colours that read on the light and on the dark floor. Materials are shared by all objects (never disposed
// by an object); only the per-object `main` material is owned.
const PALETTE = {
  dark: { color: 0x555c66, roughness: 0.6, metalness: 0.1 },
  rubber: { color: 0x3f4349, roughness: 0.92, metalness: 0 },
  metal: { color: 0xb4bbc3, roughness: 0.42, metalness: 0.3 },
  steel: { color: 0x8a929b, roughness: 0.5, metalness: 0.35 },
  wood: { color: 0xbb9462, roughness: 0.82, metalness: 0 },
  wood2: { color: 0x8f6c45, roughness: 0.86, metalness: 0 },
  white: { color: 0xe8e7e2, roughness: 0.6, metalness: 0 },
  cardboard: { color: 0xc89f6e, roughness: 0.92, metalness: 0 },
  tape: { color: 0xdcc9a0, roughness: 0.7, metalness: 0 },
  screen: { color: 0x172438, roughness: 0.22, metalness: 0, emissive: 0x24476f, emissiveIntensity: 0.85 },
  glass: { color: 0xa5cdea, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide },
  red: { color: 0xc0493d, roughness: 0.6, metalness: 0.05 },
  yellow: { color: 0xdcae2e, roughness: 0.6, metalness: 0.05 },
  orange: { color: 0xdd7b2c, roughness: 0.6, metalness: 0.05 },
  olive: { color: 0x6f7a50, roughness: 0.7, metalness: 0.05 },
  blue: { color: 0x3a74b8, roughness: 0.6, metalness: 0.05 },
  black: { color: 0x2f3237, roughness: 0.5, metalness: 0.2 },
};
const sharedMats = new Map();
function shared(key) {
  let m = sharedMats.get(key);
  if (!m) {
    const spec = PALETTE[key];
    if (!spec) throw new Error(`catalog: unknown material "${key}"`);
    m = new THREE.MeshStandardMaterial(spec);
    m.name = `hm-${key}`;
    m.userData.shared = true;
    sharedMats.set(key, m);
  }
  return m;
}

/** Colour swatches the Scene panel offers for the main colour of an object (hex strings; mid-tones that read in both themes). */
export const SWATCHES = Object.freeze([
  { name: "Slate", hex: "#56677c" }, { name: "Blue", hex: "#3a74b8" }, { name: "Olive", hex: "#6f7a50" }, { name: "Sand", hex: "#c9b98a" },
  { name: "Wood", hex: "#bb9462" }, { name: "Orange", hex: "#dd7b2c" }, { name: "Red", hex: "#c0493d" }, { name: "Yellow", hex: "#dcae2e" },
  { name: "Grey", hex: "#8a929b" }, { name: "Charcoal", hex: "#555c66" }, { name: "White", hex: "#e8e7e2" }, { name: "Green", hex: "#4f8a5b" },
]);
export const isHexColor = (c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);

// ---------------------------------------------------------------------------------------------------------------------
// geometry builder: parts are collected per material, transformed into the object's frame and merged at the end
const axisRot = (r) => (r === "x" ? [0, 0, 90] : r === "z" ? [90, 0, 0] : !r || r === "y" ? [0, 0, 0] : r);
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
/** Matrix of a local frame: position [x, y, z] metres, rotation [rx, ry, rz] degrees (XYZ order), optional scale. */
export function frameMatrix(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const r = axisRot(rot);
  return new THREE.Matrix4().compose(_p.set(pos[0], pos[1], pos[2]), _q.setFromEuler(_e.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, "XYZ")), _s.set(scale[0], scale[1], scale[2]));
}
/** The world position of `local` (array) in the frame { pos, rot }: keeps anchors in step with the geometry drawn in P.frame(pos, rot, ...). */
const at = (pos, rot, local) => { const v = V3(local).applyMatrix4(frameMatrix(pos, rot)); return [v.x, v.y, v.z]; };
const dirAt = (rot, local) => { const v = V3(local).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...axisRot(rot).map((a) => a * D2R), "XYZ"))); return [v.x, v.y, v.z]; };
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const add3 = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

function rrectShape(w, d, r) {
  const x = w / 2, y = d / 2;
  r = Math.max(1e-4, Math.min(r, x * 0.999, y * 0.999));
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y); s.lineTo(x - r, -y); s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r); s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y); s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r); s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  s.closePath();
  return s;
}

function mergeGeometries(list) {
  const parts = list.map((g) => { const n = g.index ? g.toNonIndexed() : g; if (n !== g) g.dispose(); return n; });
  const count = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

class Parts {
  constructor(color) { this.buckets = new Map(); this.M = new THREE.Matrix4(); this.color = color; }
  /** Draw inside a local frame (position, rotation in degrees); fn(p) gets this builder. */
  frame(pos, rot, fn, scale) {
    const saved = this.M;
    this.M = saved.clone().multiply(frameMatrix(pos, rot, scale));
    try { fn(this); } finally { this.M = saved; }
    return this;
  }
  _put(geo, mat, pos, rot, scale) {
    geo.applyMatrix4(this.M.clone().multiply(frameMatrix(pos, rot, scale)));
    let list = this.buckets.get(mat);
    if (!list) this.buckets.set(mat, (list = []));
    list.push(geo);
    return this;
  }
  box(size, pos = [0, 0, 0], mat = "main", rot) { return this._put(new THREE.BoxGeometry(size[0], size[1], size[2]), mat, pos, rot); }
  /** Cylinder: radius r (top), height h, axis Y unless rot is "x" / "z" or angles; o.r2 = bottom radius (taper), o.seg = radial segments. */
  cyl(r, h, pos = [0, 0, 0], mat = "main", rot, o = {}) { return this._put(new THREE.CylinderGeometry(r, o.r2 ?? r, h, o.seg ?? 20, 1, !!o.open), mat, pos, rot); }
  sph(r, pos = [0, 0, 0], mat = "main", scale = [1, 1, 1], seg = [16, 10]) { return this._put(new THREE.SphereGeometry(r, seg[0], seg[1]), mat, pos, undefined, scale); }
  /** Torus in the local XY plane (axis Z) unless rotated; R = ring radius, r = tube radius. */
  tor(R, r, pos = [0, 0, 0], mat = "main", rot, arc = Math.PI * 2, seg = [10, 32]) { return this._put(new THREE.TorusGeometry(R, r, seg[0], seg[1], arc), mat, pos, rot); }
  cap(r, len, pos = [0, 0, 0], mat = "main", rot) { return this._put(new THREE.CapsuleGeometry(r, len, 4, 10), mat, pos, rot); }
  /** Surface of revolution about Y: profile = [[radius, y], ...] from bottom to top. */
  lat(profile, pos = [0, 0, 0], mat = "main", rot, seg = 24) { return this._put(new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(Math.max(p[0], 1e-4), p[1])), seg), mat, pos, rot); }
  /** Prism: polygon [[x, y], ...] in the local XY plane extruded along Z by `depth` (centred on z = 0). */
  ext(poly, depth, pos = [0, 0, 0], mat = "main", rot) {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1]))), { depth, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -depth / 2);
    return this._put(g, mat, pos, rot);
  }
  /** Prism with holes: outer polygon and holes ([[x, y], ...] each) in the XY plane, extruded along Z by depth (centred). */
  extHoles(outer, holes, depth, pos = [0, 0, 0], mat = "main", rot) {
    const v2 = (pts) => pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const sh = new THREE.Shape(v2(outer));
    for (const h of holes) sh.holes.push(new THREE.Path(v2(h)));
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -depth / 2);
    return this._put(g, mat, pos, rot);
  }
  /** Side-profile prism: polygon [[z, y], ...] (front = +z) extruded across X by widthX, centred on x = xc. */
  side(poly, widthX, xc = 0, mat = "main") {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(poly.map((p) => new THREE.Vector2(-p[0], p[1]))), { depth: widthX, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -widthX / 2);
    return this._put(g, mat, [xc, 0, 0], [0, 90, 0]);
  }
  /** Flat plate lying on the floor plane: polygon [[x, z], ...] extruded up by `thick` from height y0. */
  flat(poly, thick, y0 = 0, mat = "main") {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], -p[1]))), { depth: thick, bevelEnabled: false, steps: 1 });
    g.rotateX(-Math.PI / 2); // (x, y, z) -> (x, z, -y): the plan's y becomes -z (so points are given as [x, z]), the extrusion becomes +y
    return this._put(g, mat, [0, y0, 0]);
  }
  /** Rounded box (cushions, bodies): size [w, h, d], corner radius rad. */
  rbox(size, rad, pos = [0, 0, 0], mat = "main", rot) {
    const [w, h, d] = size;
    const bv = Math.max(1e-4, Math.min(rad * 0.45, h * 0.3, w * 0.2, d * 0.2)), depth = Math.max(h - 2 * bv, 1e-4);
    const g = new THREE.ExtrudeGeometry(rrectShape(w - 2 * bv, d - 2 * bv, Math.max(rad - bv, 1e-3)), { depth, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelOffset: 0, bevelSegments: 2, curveSegments: 5, steps: 1 });
    g.translate(0, 0, -depth / 2);
    g.rotateX(Math.PI / 2); // extrusion axis z -> y (plan y -> z)
    return this._put(g, mat, pos, rot);
  }
  /** A slab of a cylindrical surface (curved screen): width along X, height along Y, thickness behind the front, radius of the front (concave towards +Z). */
  arc(width, height, thick, radius, pos = [0, 0, 0], mat = "main", rot, n = 14) {
    const front = [], back = [];
    for (let i = 0; i <= n; i++) {
      const x = -width / 2 + (width * i) / n, z = radius - Math.sqrt(Math.max(radius * radius - x * x, 1e-9));
      front.push(new THREE.Vector2(x, -z)); // the plan's y becomes -z after the rotation below
      back.push(new THREE.Vector2(x, -(z - thick)));
    }
    const g = new THREE.ExtrudeGeometry(new THREE.Shape([...front, ...back.reverse()]), { depth: height, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -height / 2);
    g.rotateX(-Math.PI / 2); // (x, y, z) -> (x, z, -y): the extrusion axis becomes +y, the plan's y becomes -z
    return this._put(g, mat, pos, rot);
  }
  /** Cylinder between two points of the current frame; ra at a, rb at b (default ra). */
  rod(a, b, ra, mat = "main", seg = 10, rb = ra) {
    const A = V3(a), B = V3(b), len = A.distanceTo(B);
    if (len < 1e-6) return this;
    const g = new THREE.CylinderGeometry(rb, ra, len, seg, 1);
    g.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize()), new THREE.Vector3(1, 1, 1)));
    return this._put(g, mat);
  }
  build(color) {
    const group = new THREE.Group(), own = [];
    for (const [key, list] of this.buckets) {
      let material;
      if (key === "main" || key === "mainT") {
        material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.62, metalness: 0.05, ...(key === "mainT" ? { transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide } : {}) });
        material.name = `hm-${key}`;
        own.push(material);
      } else material = shared(key);
      const mesh = new THREE.Mesh(mergeGeometries(list), material);
      mesh.name = key;
      mesh.castShadow = !material.transparent;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    group.userData.own = own;
    return group;
  }
}
// ---------------------------------------------------------------------------------------------------------------------
// parameter specs
const num = (key, label, unit, min, max, step, def, extra = {}) => ({ key, label, unit, min, max, step, default: def, kind: "number", ...(Number.isInteger(step) && step >= 1 && unit === "" ? { integer: true } : {}) /* counts are whole numbers; a step of 1 degree is only the slider's step */, ...extra });
const bool = (key, label, def = false) => ({ key, label, unit: "", kind: "bool", default: !!def });
const choice = (key, label, options, def) => ({ key, label, unit: "", kind: "choice", options: options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)), default: def });

/** Clamp / complete a parameter object against a type's spec. Unknown keys are dropped; non-finite numbers fall back to the default. */
export function clampParams(spec, params) {
  const out = {};
  const src = params && typeof params === "object" ? params : {};
  for (const ps of spec.params) {
    const has = Object.hasOwn(src, ps.key);
    let v = has ? src[ps.key] : ps.default;
    if (ps.kind === "number") {
      v = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof v !== "number" || !Number.isFinite(v)) v = ps.default;
      v = clamp(v, ps.min, ps.max);
      if (ps.integer) v = Math.round(v);
    } else if (ps.kind === "bool") v = has ? v === true || v === 1 || v === "true" : ps.default;
    else v = ps.options.some((o) => o.value === v) ? v : ps.default;
    out[ps.key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// registry
const REGISTRY = [];
const BY_TYPE = new Map();
/** Register a type. `spec.dims(p)` derives shared dimensions; build(P, p, d), anchors(p, d), grips(p, d), supports(p, d) use them. */
function def(spec) {
  const dims = spec.dims ?? ((p) => p);
  const entry = {
    type: spec.type, name: spec.name, category: spec.category, description: spec.description, source: spec.source ?? "",
    params: Object.freeze(spec.params.map((p) => Object.freeze(p))),
    defaultColor: spec.color ?? "#8a929b", defaultYaw: spec.yaw ?? 0,
    scaleMap: spec.scaleMap ?? null, // { x: "width", y: "height", z: "depth" }: parameters the resize gizmo drives
    hasMass: spec.params.some((p) => p.key === "mass"),
    tags: spec.tags ?? [],
    build(params, opts = {}) {
      const p = clampParams(entry, params), P = new Parts();
      spec.build(P, p, dims(p));
      const color = isHexColor(opts.color) ? opts.color : entry.defaultColor;
      const g = P.build(color);
      g.name = entry.type;
      g.userData.type = entry.type;
      g.updateMatrixWorld(true);
      g.userData.bbox = new THREE.Box3().setFromObject(g);
      return g;
    },
    anchors(params) { const p = clampParams(entry, params); return clean(spec.anchors(p, dims(p))); },
    grips(params) { const p = clampParams(entry, params); return (spec.grips ? spec.grips(p, dims(p)) : []).map(cleanGrip); },
    supports(params) { const p = clampParams(entry, params); return (spec.supports ? spec.supports(p, dims(p)) : []).map(cleanSupport); },
  };
  if (BY_TYPE.has(entry.type)) throw new Error(`catalog: duplicate type "${entry.type}"`);
  REGISTRY.push(entry);
  BY_TYPE.set(entry.type, entry);
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const arr3 = (a) => [r6(a[0]), r6(a[1]), r6(a[2])];
function clean(anchors) {
  const out = {};
  for (const [id, a] of Object.entries(anchors)) out[id] = { label: a.label, position: arr3(a.position), ...(a.normal ? { normal: arr3(unit(a.normal)) } : {}) };
  return out;
}
const grip = (id, label, hand, position, normal, axis, diameter) => ({ id, label, hand, position, normal, axis, diameter });
const cleanGrip = (g) => ({ ...g, position: arr3(g.position), normal: arr3(unit(g.normal)), axis: arr3(unit(g.axis)), diameter: r6(g.diameter) });
const support = (id, label, y, size, center, pitch) => ({ id, label, y, size, center, ...(pitch ? { pitch } : {}) });
const cleanSupport = (s) => ({ ...s, y: r6(s.y), size: [r6(s.size[0]), r6(s.size[1])], center: [r6(s.center[0]), r6(s.center[1])] });
const a = (label, position, normal) => ({ label, position, ...(normal ? { normal } : {}) });
/** The 8 top / bottom corners of a box centred on the floor footprint: shared by the many box-like types. */
const boxAnchors = (w, d, h, x0 = 0, z0 = 0) => ({
  top_centre: a("Top, centre", [x0, h, z0]), base_centre: a("Base, centre", [x0, 0, z0]),
  top_front: a("Top, front edge centre", [x0, h, z0 + d / 2]), top_back: a("Top, back edge centre", [x0, h, z0 - d / 2]),
  corner_fl: a("Top corner, front left (+X)", [x0 + w / 2, h, z0 + d / 2]), corner_fr: a("Top corner, front right (-X)", [x0 - w / 2, h, z0 + d / 2]),
  corner_bl: a("Top corner, back left (+X)", [x0 + w / 2, h, z0 - d / 2]), corner_br: a("Top corner, back right (-X)", [x0 - w / 2, h, z0 - d / 2]),
});

// =====================================================================================================================
// SEATING
// =====================================================================================================================
def({
  type: "cabin_seat", name: "Cabin seat", category: "Seating", color: "#56677c", tags: ["vehicle", "crew", "sit"],
  description: "Vehicle or crew seat: cushion, back, headrest and side bolsters. Origin: the floor point under the seat reference point (SRP). Adjust the seat height, pan angle and back angle to fit the occupant.",
  source: "SRP / H-point proxy after SAE J1100 and ISO 6549 (the seat pan top meets the back-rest centre plane). Ranges follow common car, truck and crew-seat practice.",
  params: [
    num("seatHeight", "Seat height (pan top at the SRP)", "m", 0.25, 0.60, 0.005, 0.40),
    num("panDepth", "Seat pan depth", "m", 0.35, 0.55, 0.005, 0.45),
    num("panWidth", "Seat pan width", "m", 0.40, 0.60, 0.005, 0.50),
    num("panAngle", "Seat pan angle (front up)", "deg", -5, 15, 0.5, 5),
    num("recline", "Back angle to the seat pan", "deg", 90, 140, 1, 105),
    num("backHeight", "Back height", "m", 0.45, 0.75, 0.005, 0.62),
    num("headrestHeight", "Headrest top, up the back", "m", 0.60, 1.00, 0.005, 0.78),
    bool("armrests", "Armrests"),
    num("armHeight", "Armrest height above the pan", "m", 0.15, 0.30, 0.005, 0.22),
  ],
  dims(p) {
    const al = p.panAngle * D2R, phi = (p.panAngle + p.recline) * D2R, t = 0.09, hr = 0.15;
    return { al, phi, t, hr, u: [0, Math.sin(al), Math.cos(al)], b: [0, Math.sin(phi), Math.cos(phi)], nb: [0, -Math.cos(phi), Math.sin(phi)], zc: (p.panDepth - 0.06) / 2 };
  },
  build(P, p, d) {
    const H = p.seatHeight, W = p.panWidth, D = p.panDepth, L = D + 0.06, Hb = p.backHeight, Wb = W + 0.02, tb = 0.1;
    P.frame([0, H, 0], [-p.panAngle, 0, 0], (q) => { // pan frame: x right, y pan normal, z along the pan
      q.rbox([W, d.t, L], 0.035, [0, -d.t / 2, d.zc], "main");
      for (const s of [-1, 1]) q.rbox([0.05, 0.034, L - 0.12], 0.014, [s * (W / 2 - 0.045), 0.012, d.zc - 0.02], "main"); // side bolsters
      q.box([W - 0.08, 0.025, L - 0.06], [0, -d.t - 0.0125, d.zc], "dark");
    });
    P.frame([0, H, 0], [-(p.panAngle + p.recline), 0, 0], (q) => { // back frame: x right, y AWAY from the sitter (contact plane at y = 0), z up the back
      q.rbox([Wb, tb, Hb + 0.04], 0.04, [0, tb / 2, (Hb - 0.04) / 2], "main");
      for (const s of [-1, 1]) q.rbox([0.06, 0.04, Hb - 0.12], 0.016, [s * (Wb / 2 - 0.042), -0.014, Hb / 2 - 0.02], "main");
      q.box([Wb - 0.06, 0.012, Hb - 0.14], [0, tb + 0.006, Hb / 2 - 0.02], "dark");
      const zc = p.headrestHeight - d.hr / 2, lo = zc - d.hr / 2 + 0.02, hi = Hb - 0.1;
      q.rbox([0.27, 0.11, d.hr], 0.04, [0, 0.03, zc], "main");
      if (lo - hi > 0.01) for (const s of [-1, 1]) q.cyl(0.009, lo - hi, [s * 0.07, tb / 2, (lo + hi) / 2], "metal", "y", { seg: 8 });
    });
    const yb = H + d.zc * Math.sin(d.al) - (d.t + 0.03) * Math.cos(d.al);
    P.box([0.44, 0.02, 0.54], [0, 0.01, 0.1], "dark");
    P.box([0.26, Math.max(yb - 0.02, 0.01), 0.3], [0, 0.02 + Math.max(yb - 0.02, 0.01) / 2, 0.1], "steel");
    for (const s of [-1, 1]) P.box([0.03, 0.03, 0.48], [s * 0.17, 0.035, 0.1], "metal");
    if (p.armrests) for (const s of [-1, 1]) {
      const x = s * (W / 2 + 0.05);
      P.box([0.06, 0.04, 0.3], [x, H + p.armHeight, 0.04], "dark");
      P.box([0.03, p.armHeight + 0.04, 0.04], [x, H + (p.armHeight - 0.04) / 2 - 0.02, -0.06], "steel");
    }
  },
  anchors(p, d) {
    const H = p.seatHeight, srp = [0, H, 0], hrC = p.headrestHeight - d.hr / 2;
    return {
      srp: a("Seat reference point (SRP)", srp),
      h_point: a("H-point proxy (= SRP)", srp),
      cushion_front_edge: a("Cushion front edge", add3(srp, d.u, p.panDepth)),
      pan_centre: a("Seat pan centre", add3(srp, d.u, d.zc)),
      back_top: a("Seat-back top", add3(srp, d.b, p.backHeight)),
      headrest_centre: a("Headrest centre", add3(add3(srp, d.b, hrC), d.nb, 0.025), d.nb),
    };
  },
  supports(p, d) {
    const zc = d.zc * Math.cos(d.al);
    return [support("seat_pan", "Seat pan", p.seatHeight + d.zc * Math.sin(d.al), [p.panWidth, (p.panDepth + 0.06) * Math.cos(d.al)], [0, zc], p.panAngle)];
  },
});

def({
  type: "office_chair", name: "Office chair", category: "Seating", color: "#3a6ea5", tags: ["sit", "workstation"],
  description: "Swivel task chair with five-star base and casters, adjustable seat height and back, optional armrests. Origin: the floor point under the seat reference point (SRP).",
  source: "Seat height range after EN 1335-1 and ANSI/HFES 100 (about 0.38 to 0.56 m); ISO 9241-5 for workstation seating.",
  params: [
    num("seatHeight", "Seat height", "m", 0.38, 0.56, 0.005, 0.46),
    num("seatWidth", "Seat width", "m", 0.42, 0.56, 0.005, 0.50),
    num("seatDepth", "Seat depth", "m", 0.38, 0.50, 0.005, 0.45),
    num("backHeight", "Back height", "m", 0.35, 0.65, 0.005, 0.48),
    num("recline", "Back lean from vertical", "deg", 0, 35, 1, 10),
    bool("armrests", "Armrests", true),
    num("armHeight", "Armrest height above the seat", "m", 0.18, 0.28, 0.005, 0.23),
  ],
  dims(p) { const r = p.recline * D2R; return { r, b: [0, Math.cos(r), -Math.sin(r)], nb: [0, Math.sin(r), Math.cos(r)], z0: -0.05, zc: (p.seatDepth - 0.1) / 2 }; },
  build(P, p, d) {
    const H = p.seatHeight, W = p.seatWidth, D = p.seatDepth, zc = d.zc;
    P.rbox([W, 0.07, D], 0.04, [0, H - 0.035, zc], "main");
    P.box([0.26, 0.04, 0.26], [0, H - 0.09, zc], "dark");
    P.cyl(0.026, H - 0.2, [0, 0.11 + (H - 0.2) / 2, zc], "steel", "y", { seg: 12 });
    P.cyl(0.04, 0.08, [0, 0.11, zc], "dark", "y", { seg: 12 });
    for (let k = 0; k < 5; k++) {
      const ang = (k * 72 + 18) * D2R, s = Math.sin(ang), c = Math.cos(ang);
      P.rod([0, 0.1, zc], [0.3 * s, 0.065, zc + 0.3 * c], 0.017, "dark", 8, 0.014);
      P.cyl(0.027, 0.022, [0.31 * s, 0.032, zc + 0.31 * c], "rubber", [0, k * 72 + 18, 90], { seg: 14 });
      P.cyl(0.012, 0.045, [0.3 * s, 0.056, zc + 0.3 * c], "steel", "y", { seg: 8 });
    }
    P.frame([0, H, 0], [-(90 + p.recline), 0, 0], (q) => { // back frame: y away from the sitter, z up the back
      q.rbox([W - 0.04, 0.06, p.backHeight], 0.04, [0, 0.03, 0.12 + p.backHeight / 2], "main");
    });
    P.rod([0, H - 0.04, -0.04], add3(add3([0, H, 0], d.b, 0.12), d.nb, -0.04), 0.014, "steel", 8);
    if (p.armrests) for (const s of [-1, 1]) {
      const x = s * (W / 2 + 0.03);
      P.box([0.06, 0.03, 0.26], [x, H + p.armHeight, zc - 0.03], "dark");
      P.rod([x, H - 0.05, zc - 0.05], [x, H + p.armHeight - 0.015, zc - 0.05], 0.012, "steel", 8);
    }
  },
  anchors(p, d) {
    const srp = [0, p.seatHeight, 0], top = add3(add3(srp, d.b, 0.12 + p.backHeight), d.nb, 0);
    const ah = p.seatHeight + p.armHeight;
    return {
      srp: a("Seat reference point (SRP)", srp), h_point: a("H-point proxy (= SRP)", srp),
      seat_front_edge: a("Seat front edge", [0, p.seatHeight, d.zc + p.seatDepth / 2]),
      back_top: a("Seat-back top", top, d.nb),
      ...(p.armrests ? { armrest_left: a("Armrest top, left (+X)", [p.seatWidth / 2 + 0.03, ah + 0.015, d.zc - 0.03]), armrest_right: a("Armrest top, right (-X)", [-p.seatWidth / 2 - 0.03, ah + 0.015, d.zc - 0.03]) } : {}),
    };
  },
  supports: (p, d) => [support("seat", "Seat pan", p.seatHeight, [p.seatWidth, p.seatDepth], [0, d.zc])],
});

def({
  type: "stool", name: "Stool", category: "Seating", color: "#bb9462", tags: ["sit"],
  description: "Round-topped four-legged stool with a leg ring. Origin: the floor under the centre of the seat.",
  source: "Typical shop and laboratory stool; seat heights 0.30 to 0.80 m.",
  params: [num("height", "Seat height", "m", 0.30, 0.80, 0.005, 0.45), num("diameter", "Seat diameter", "m", 0.25, 0.45, 0.005, 0.32)],
  build(P, p) {
    const h = p.height, r = p.diameter / 2;
    P.lat([[0.001, h - 0.04], [r * 0.96, h - 0.04], [r, h - 0.028], [r, h - 0.012], [r * 0.94, h], [0.001, h]], [0, 0, 0], "main", undefined, 28);
    const topR = r * 0.6, footR = r + 0.06, ringY = h * 0.34, ringR = footR + (topR - footR) * (ringY / (h - 0.04));
    for (let k = 0; k < 4; k++) {
      const ang = (k * 90 + 45) * D2R, s = Math.sin(ang), c = Math.cos(ang);
      P.rod([footR * s, 0.01, footR * c], [topR * s, h - 0.04, topR * c], 0.02, "wood2", 10, 0.024);
    }
    P.tor(ringR, 0.012, [0, ringY, 0], "wood2", [90, 0, 0]);
  },
  anchors: (p) => ({ seat_centre: a("Seat centre", [0, p.height, 0]), seat_front: a("Seat front edge", [0, p.height, p.diameter / 2]), base_centre: a("Base centre", [0, 0, 0]) }),
  supports: (p) => [support("seat", "Seat", p.height, [p.diameter, p.diameter], [0, 0])],
});

def({
  type: "bar_stool", name: "Bar stool", category: "Seating", color: "#c0493d", tags: ["sit"],
  description: "Tall stool with a foot ring and an optional low back. Origin: the floor under the centre of the seat.",
  source: "Typical counter and bar stool; seat heights 0.60 to 0.80 m.",
  params: [num("height", "Seat height", "m", 0.60, 0.80, 0.005, 0.75), num("diameter", "Seat diameter", "m", 0.30, 0.45, 0.005, 0.36), bool("back", "Low back")],
  build(P, p) {
    const h = p.height, r = p.diameter / 2, fh = h * 0.38;
    P.cyl(r, 0.06, [0, h - 0.04, 0], "main", "y", { seg: 28 });
    P.cyl(r * 0.8, 0.02, [0, h - 0.08, 0], "dark", "y", { seg: 24 });
    for (let k = 0; k < 4; k++) {
      const ang = (k * 90 + 45) * D2R, s = Math.sin(ang), c = Math.cos(ang);
      P.rod([0.26 * s, 0.004, 0.26 * c], [0.14 * s, h - 0.09, 0.14 * c], 0.014, "steel", 8, 0.016);
    }
    P.tor(0.2, 0.012, [0, fh, 0], "steel", [90, 0, 0], Math.PI * 2, [8, 28]);
    if (p.back) {
      P.rbox([p.diameter * 0.72, 0.16, 0.035], 0.03, [0, h + 0.17, -r + 0.03], "main");
      for (const s of [-1, 1]) P.rod([s * 0.1, h - 0.06, -r + 0.04], [s * 0.1, h + 0.1, -r + 0.03], 0.01, "steel", 8);
    }
  },
  anchors: (p) => ({ seat_centre: a("Seat centre", [0, p.height, 0]), footrest: a("Foot ring, front", [0, p.height * 0.38, 0.2]), ...(p.back ? { back_top: a("Back top", [0, p.height + 0.25, -p.diameter / 2 + 0.03]) } : {}) }),
  supports: (p) => [support("seat", "Seat", p.height, [p.diameter, p.diameter], [0, 0]), support("foot_ring", "Foot ring", p.height * 0.38 + 0.012, [0.42, 0.42], [0, 0])],
});

def({
  type: "bench", name: "Bench", category: "Seating", color: "#bb9462", tags: ["sit"],
  description: "Plank bench with end frames and an optional backrest. Origin: the floor under the centre of the seat. Front (+Z) is the side the sitter faces.",
  source: "Typical bench; seat height 0.30 to 0.55 m.",
  params: [num("length", "Length", "m", 0.5, 2.5, 0.01, 1.2), num("depth", "Seat depth", "m", 0.25, 0.5, 0.005, 0.35), num("height", "Seat height", "m", 0.30, 0.55, 0.005, 0.45), bool("backrest", "Backrest")],
  build(P, p) {
    const { length: l, depth: d, height: h } = p;
    P.box([l, 0.04, d], [0, h - 0.02, 0], "main");
    for (const s of [-1, 1]) {
      P.box([0.05, h - 0.04, d * 0.9], [s * (l / 2 - 0.12), (h - 0.04) / 2, 0], "wood2");
      P.box([0.05, 0.05, d + 0.06], [s * (l / 2 - 0.12), 0.025, 0], "wood2");
    }
    P.box([l - 0.4, 0.07, 0.025], [0, h - 0.075, -d * 0.32], "wood2");
    if (p.backrest) {
      for (const s of [-1, 1]) P.box([0.05, 0.42, 0.04], [s * (l / 2 - 0.12), h + 0.2, -d / 2 + 0.03], "wood2");
      P.box([l - 0.1, 0.12, 0.03], [0, h + 0.17, -d / 2 + 0.03], "main");
      P.box([l - 0.1, 0.12, 0.03], [0, h + 0.34, -d / 2 + 0.03], "main");
    }
  },
  anchors: (p) => ({ seat_centre: a("Seat centre", [0, p.height, 0]), seat_front: a("Seat front edge", [0, p.height, p.depth / 2]), end_left: a("Seat end, left (+X)", [p.length / 2, p.height, 0]), end_right: a("Seat end, right (-X)", [-p.length / 2, p.height, 0]), ...(p.backrest ? { back_top: a("Backrest top", [0, p.height + 0.4, -p.depth / 2 + 0.03]) } : {}) }),
  supports: (p) => [support("seat", "Seat", p.height, [p.length, p.depth], [0, 0])],
});

def({
  type: "jump_seat", name: "Jump seat", category: "Seating", color: "#6f7a50", tags: ["vehicle", "crew", "sit"],
  description: "Fold-down crew or troop seat on a wall rail, with a padded back and a floor strut. Origin: the floor under the seat reference point (SRP).",
  source: "Typical aircraft and vehicle jump seat; seat height 0.35 to 0.55 m.",
  params: [num("seatHeight", "Seat height", "m", 0.35, 0.55, 0.005, 0.45), num("width", "Seat width", "m", 0.35, 0.55, 0.005, 0.42), num("depth", "Seat depth", "m", 0.25, 0.40, 0.005, 0.30), num("backHeight", "Back height", "m", 0.30, 0.70, 0.005, 0.50)],
  build(P, p) {
    const H = p.seatHeight, W = p.width, D = p.depth;
    P.rbox([W, 0.06, D], 0.03, [0, H - 0.03, D / 2 - 0.05], "main");
    P.rbox([W - 0.04, 0.5 * p.backHeight, 0.05], 0.025, [0, H + 0.1 + p.backHeight * 0.25, -0.1], "main");
    P.rbox([W - 0.04, 0.5 * p.backHeight, 0.05], 0.025, [0, H + 0.12 + p.backHeight * 0.25, -0.1], "main");
    P.box([0.06, p.backHeight + 0.35, 0.03], [0, H + (p.backHeight - 0.1) / 2, -0.15], "dark");
    P.box([W + 0.1, 0.05, 0.03], [0, H - 0.02, -0.15], "steel");
    for (const s of [-1, 1]) P.rod([s * (W / 2 - 0.03), H - 0.05, -0.14], [s * (W / 2 - 0.03), H - 0.05, D - 0.1], 0.012, "steel", 8);
    P.rod([0, H - 0.07, D - 0.12], [0, 0.015, D - 0.04], 0.014, "steel", 8);
    P.box([0.16, 0.02, 0.12], [0, 0.01, D - 0.04], "dark");
  },
  anchors: (p) => ({ srp: a("Seat reference point (SRP)", [0, p.seatHeight, 0]), seat_front: a("Seat front edge", [0, p.seatHeight, p.depth - 0.05]), back_top: a("Seat-back top", [0, p.seatHeight + 0.1 + p.backHeight * 0.5, -0.1]) }),
  supports: (p) => [support("seat", "Seat pad", p.seatHeight, [p.width, p.depth], [0, p.depth / 2 - 0.05])],
});

// =====================================================================================================================
// DISPLAYS
// =====================================================================================================================
const ASPECTS = [{ value: "16:9", label: "16:9" }, { value: "16:10", label: "16:10" }, { value: "21:9", label: "21:9 ultrawide" }];
const aspectOf = (s) => { const [x, y] = s.split(":").map(Number); return [x, y]; };
const screenSize = (diagIn, ratio) => { const [x, y] = aspectOf(ratio), D = diagIn * 0.0254, n = Math.hypot(x, y); return [(D * x) / n, (D * y) / n]; };
const BZ_TOP = 0.009, BZ_BOT = 0.02, BZ_SIDE = 0.009;
/** Panel drawn in the current frame: screen face at z = 0 (facing +Z), centred on the screen centre. */
function panelDisplay(q, w, h, o = {}) {
  const th = o.thick ?? 0.026, W = w + 2 * BZ_SIDE, Hh = h + BZ_TOP + BZ_BOT, oy = (BZ_TOP - BZ_BOT) / 2;
  if (o.curved) {
    q.arc(W, Hh, th, o.radius, [0, oy, -0.0003], "dark", undefined, 16);
    q.arc(w, h, 0.0012, o.radius, [0, 0, 0.0009], "screen", undefined, 16);
  } else {
    q.box([W, Hh, th], [0, oy, -th / 2], "dark");
    q.box([w, h, 0.0012], [0, 0, 0.0006], "screen");
  }
  if (!o.noBack) q.rbox([W * 0.5, Hh * 0.62, 0.02], 0.01, [0, oy - 0.01, -th - 0.01], "dark");
}
/** One monitor on its stand, in a frame whose origin is on the floor under the screen centre. */
function monitorUnit(q, w, h, cH, tilt, o = {}) {
  const Hh = h + BZ_TOP + BZ_BOT, bw = clamp(w * 0.5, 0.18, 0.4);
  q.frame([0, cH, 0], [-tilt, 0, 0], (m) => panelDisplay(m, w, h, o));
  q.cyl(0.02, Math.min(0.07, w * 0.2), [0, cH - 0.005, -0.052], "steel", "x", { seg: 12 });
  q.box([0.05, Math.max(cH - 0.03 - 0.014, 0.01), 0.022], [0, 0.014 + Math.max(cH - 0.03 - 0.014, 0.01) / 2, -0.055], "steel");
  q.rbox([bw, 0.016, 0.2], 0.03, [0, 0.008, -0.04], "dark");
  return Hh;
}
const minCentre = (h, tilt) => ((h + BZ_TOP + BZ_BOT) / 2) * Math.cos(tilt * D2R) + 0.045;

def({
  type: "monitor", name: "Monitor", category: "Displays", color: "#555c66", yaw: 180, tags: ["screen", "display"],
  description: "Flat computer monitor with bezel, neck and foot. Its screen faces +Z; raise the object (Y) to stand it on a desk. Anchors: screen centre, edge centres and the viewing normal.",
  source: "Screen sizes from the diagonal and aspect ratio; viewing-geometry notes after ISO 9241-5 and ANSI/HFES 100 (shown in the Measure panel as information).",
  params: [
    num("diagonal", "Screen diagonal", "in", 15, 49, 0.5, 24, { digits: 1 }),
    choice("aspect", "Aspect ratio", ASPECTS, "16:9"),
    num("tilt", "Tilt back", "deg", -5, 25, 1, 5),
    num("centreHeight", "Screen centre height", "m", 0.3, 1.6, 0.005, 1.15),
  ],
  dims(p) { const [w, h] = screenSize(p.diagonal, p.aspect); return { w, h, cH: Math.max(p.centreHeight, minCentre(h, p.tilt)) }; },
  build: (P, p, d) => monitorUnit(P, d.w, d.h, d.cH, p.tilt),
  anchors(p, d) {
    const f = [0, d.cH, 0], r = [-p.tilt, 0, 0], n = dirAt(r, [0, 0, 1]), W = d.w / 2 + BZ_SIDE;
    return {
      screen_centre: a("Screen centre", f, n),
      top_edge: a("Screen top edge, centre", at(f, r, [0, d.h / 2, 0])),
      bottom_edge: a("Screen bottom edge, centre", at(f, r, [0, -d.h / 2, 0])),
      left_edge: a("Screen left edge centre (viewer's left)", at(f, r, [-d.w / 2, 0, 0])),
      right_edge: a("Screen right edge centre (viewer's right)", at(f, r, [d.w / 2, 0, 0])),
      viewing_normal: a("Viewing normal (screen centre)", f, n),
      base_centre: a("Foot centre", [0, 0.008, -0.04]),
    };
  },
});

def({
  type: "triple_monitor", name: "Triple monitor array", category: "Displays", color: "#555c66", yaw: 180, tags: ["screen", "display", "cockpit"],
  description: "Three monitors side by side, flat or curved, with an adjustable angle between neighbouring panels (180 degrees = flat). Origin: the floor under the centre of the middle screen.",
  source: "Common multi-monitor desk layout; curved panels use an 1800 mm radius.",
  params: [
    num("diagonal", "Diagonal of each screen", "in", 20, 34, 0.5, 24, { digits: 1 }),
    choice("aspect", "Aspect ratio", ASPECTS.slice(0, 2), "16:9"),
    num("panelAngle", "Angle between panels (180 = flat)", "deg", 120, 180, 1, 160),
    bool("curved", "Curved panels"),
    num("tilt", "Tilt back", "deg", -5, 25, 1, 5),
    num("centreHeight", "Screen centre height", "m", 0.3, 1.6, 0.005, 1.15),
  ],
  dims(p) {
    const [w, h] = screenSize(p.diagonal, p.aspect), turn = 180 - p.panelAngle, gap = 0.012, W = w + 2 * BZ_SIDE;
    const hx = W / 2 + gap / 2; // hinge x of the side panels (inner edges)
    return { w, h, cH: Math.max(p.centreHeight, minCentre(h, p.tilt)), turn, hx, R: 1.8 };
  },
  build(P, p, d) {
    const o = { curved: p.curved, radius: d.R };
    monitorUnit(P, d.w, d.h, d.cH, p.tilt, o);
    for (const s of [-1, 1]) P.frame([s * d.hx, 0, 0], [0, s * d.turn, 0], (q) => q.frame([s * (d.w / 2 + BZ_SIDE), 0, 0], [0, 0, 0], (m) => monitorUnit(m, d.w, d.h, d.cH, p.tilt, o)));
  },
  anchors(p, d) {
    const out = {}, n0 = dirAt([-p.tilt, 0, 0], [0, 0, 1]), f = [0, d.cH, 0];
    out.screen_centre = a("Centre screen, centre", f, n0);
    out.top_edge = a("Centre screen, top edge", at(f, [-p.tilt, 0, 0], [0, d.h / 2, 0]));
    out.bottom_edge = a("Centre screen, bottom edge", at(f, [-p.tilt, 0, 0], [0, -d.h / 2, 0]));
    for (const [id, s, name] of [["left", 1, "left (+X)"], ["right", -1, "right (-X)"]]) {
      const pos = [s * d.hx, 0, 0], rot = [0, s * d.turn, 0], loc = [s * (d.w / 2 + BZ_SIDE), d.cH, 0];
      const c = at(pos, rot, loc), nrm = dirAt(rot, n0);
      out[`${id}_screen`] = a(`Side screen ${name}, centre`, p.curved ? add3(c, nrm, 0) : c, nrm);
      out[`${id}_outer_edge`] = a(`Side screen ${name}, outer edge`, at(pos, rot, [s * (d.w / 2 + BZ_SIDE) + s * d.w / 2, d.cH, 0]));
    }
    return out;
  },
});

def({
  type: "hud_panel", name: "HUD panel", category: "Displays", color: "#9cc6e6", yaw: 180, tags: ["display", "cockpit", "vehicle"],
  description: "Head-up display combiner: a translucent glass plate on a projector unit and post. The glass faces +Z towards the viewer; anchors at its centre and edges.",
  source: "Generic combiner geometry; sizes typical of automotive and light-aircraft HUDs.",
  params: [
    num("width", "Glass width", "m", 0.15, 0.40, 0.005, 0.25),
    num("height", "Glass height", "m", 0.10, 0.30, 0.005, 0.18),
    num("centreHeight", "Glass centre height", "m", 0.9, 1.6, 0.005, 1.25),
    num("tilt", "Tilt back from vertical", "deg", 0, 45, 1, 25),
  ],
  build(P, p) {
    const cH = p.centreHeight;
    P.frame([0, cH, 0], [-p.tilt, 0, 0], (q) => {
      q.box([p.width, p.height, 0.004], [0, 0, 0], "glass");
      for (const s of [-1, 1]) q.box([0.01, p.height + 0.01, 0.014], [s * (p.width / 2 + 0.003), 0, 0], "dark");
      q.box([p.width + 0.02, 0.01, 0.014], [0, -p.height / 2 - 0.003, 0], "dark");
      q.box([p.width + 0.02, 0.008, 0.014], [0, p.height / 2 + 0.003, 0], "dark");
    });
    const by = cH - p.height / 2 * Math.cos(p.tilt * D2R) - 0.05;
    P.box([p.width * 0.8, 0.07, 0.11], [0, by, -0.06], "dark");
    P.box([0.05, by - 0.05, 0.04], [0, 0.025 + (by - 0.05) / 2, -0.08], "steel");
    P.rbox([0.3, 0.025, 0.24], 0.03, [0, 0.0125, -0.05], "dark");
  },
  anchors(p) {
    const f = [0, p.centreHeight, 0], r = [-p.tilt, 0, 0], n = dirAt(r, [0, 0, 1]);
    return {
      glass_centre: a("Glass centre", f, n), screen_centre: a("Glass centre (display centre)", f, n),
      top_edge: a("Glass top edge, centre", at(f, r, [0, p.height / 2, 0])), bottom_edge: a("Glass bottom edge, centre", at(f, r, [0, -p.height / 2, 0])),
      left_edge: a("Glass left edge (viewer's left)", at(f, r, [-p.width / 2, 0, 0])), right_edge: a("Glass right edge (viewer's right)", at(f, r, [p.width / 2, 0, 0])),
      viewing_normal: a("Viewing normal", f, n),
    };
  },
});

def({
  type: "tablet", name: "Tablet", category: "Displays", color: "#555c66", yaw: 180, tags: ["screen", "display", "handheld"],
  description: "Tablet computer on a floor stand: set the screen centre height and the tilt. Anchors: screen centre, edges, viewing normal; grips at the left and right edges for holding it.",
  source: "Screen size from the diagonal (ratio about 4:3); typical 7 to 13 inch devices.",
  params: [
    num("diagonal", "Screen diagonal", "in", 7, 13, 0.1, 10.2, { digits: 1 }),
    num("tilt", "Tilt back from vertical", "deg", 0, 80, 1, 30),
    num("centreHeight", "Screen centre height", "m", 0.3, 1.5, 0.005, 1.0),
  ],
  dims(p) { const [w, h] = screenSize(p.diagonal, "4:3"); return { w, h }; },
  build(P, p, d) {
    const cH = Math.max(p.centreHeight, (d.h / 2 + 0.02) * Math.cos(p.tilt * D2R) + 0.06);
    P.frame([0, cH, 0], [-p.tilt, 0, 0], (q) => {
      q.rbox([d.w + 0.02, d.h + 0.02, 0.008], 0.014, [0, 0, -0.004], "dark");
      q.box([d.w, d.h, 0.0012], [0, 0, 0.0006], "screen");
    });
    P.rod([0, 0.02, -0.06], [0, cH - 0.05, -0.012], 0.012, "steel", 8);
    P.rbox([0.22, 0.02, 0.2], 0.03, [0, 0.01, -0.04], "dark");
  },
  anchors(p, d) {
    const cH = Math.max(p.centreHeight, (d.h / 2 + 0.02) * Math.cos(p.tilt * D2R) + 0.06), f = [0, cH, 0], r = [-p.tilt, 0, 0], n = dirAt(r, [0, 0, 1]);
    return {
      screen_centre: a("Screen centre", f, n), top_edge: a("Screen top edge, centre", at(f, r, [0, d.h / 2, 0])), bottom_edge: a("Screen bottom edge, centre", at(f, r, [0, -d.h / 2, 0])),
      left_edge: a("Screen left edge (viewer's left)", at(f, r, [-d.w / 2, 0, 0])), right_edge: a("Screen right edge (viewer's right)", at(f, r, [d.w / 2, 0, 0])), viewing_normal: a("Viewing normal", f, n),
    };
  },
  grips(p, d) {
    const cH = Math.max(p.centreHeight, (d.h / 2 + 0.02) * Math.cos(p.tilt * D2R) + 0.06), f = [0, cH, 0], r = [-p.tilt, 0, 0], e = d.w / 2 + 0.01;
    return [
      grip("edge_left", "Left edge (viewer's left)", "L", at(f, r, [-e, 0, -0.004]), dirAt(r, [1, 0, 0]), dirAt(r, [0, 1, 0]), 0.008),
      grip("edge_right", "Right edge (viewer's right)", "R", at(f, r, [e, 0, -0.004]), dirAt(r, [-1, 0, 0]), dirAt(r, [0, 1, 0]), 0.008),
    ];
  },
});

def({
  type: "laptop", name: "Laptop", category: "Displays", color: "#9aa2ab", yaw: 180, tags: ["screen", "display", "keyboard"],
  description: "Laptop with keyboard deck, trackpad and a lid whose opening angle you set. Origin: the floor under the middle of the base; raise it (Y) to put it on a desk.",
  source: "Typical 11 to 17 inch laptop proportions (16:10 screen).",
  params: [num("diagonal", "Screen diagonal", "in", 11, 17, 0.5, 14, { digits: 1 }), num("lid", "Lid opening angle", "deg", 80, 150, 1, 110)],
  dims(p) {
    const [w, h] = screenSize(p.diagonal, "16:10"), depth = 0.7 * h + 0.06, z0 = -depth / 2, ph = p.lid * D2R;
    return { w, h, depth, bw: w + 0.016, th: 0.016, z0, d: [0, Math.sin(ph), Math.cos(ph)], n: [0, -Math.cos(ph), Math.sin(ph)] };
  },
  build(P, p, d) {
    P.rbox([d.bw, d.th, d.depth], 0.012, [0, d.th / 2, 0], "steel");
    P.box([d.bw - 0.03, 0.002, d.depth * 0.52], [0, d.th + 0.0005, -d.depth * 0.1], "dark");
    const cols = Math.round((d.bw - 0.05) / 0.021), rows = 4, kw = (d.bw - 0.05) / cols;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) P.box([kw * 0.86, 0.004, 0.0165], [-(d.bw - 0.05) / 2 + kw * (c + 0.5), d.th + 0.0036, -d.depth * 0.34 + r * 0.0195], "white");
    P.box([d.bw * 0.34, 0.002, d.depth * 0.22], [0, d.th + 0.0008, d.depth * 0.3], "dark");
    // lid frame: origin on the hinge, z up the lid, y = the lid's back (away from the user); the screen is its front face (y = 0, facing -y)
    P.frame([0, d.th, d.z0 + 0.004], [-p.lid, 0, 0], (q) => {
      q.rbox([d.bw, 0.008, d.h + 0.03], 0.008, [0, 0.004, (d.h + 0.03) / 2], "steel");
      q.box([d.w, 0.0012, d.h], [0, -0.0006, 0.012 + d.h / 2], "screen");
    });
  },
  anchors(p, d) {
    const hinge = [0, d.th, d.z0 + 0.004], r = [-p.lid, 0, 0], n = [0, -Math.cos(p.lid * D2R), Math.sin(p.lid * D2R)], zc = 0.012 + d.h / 2, y = -0.0012;
    return {
      screen_centre: a("Screen centre", at(hinge, r, [0, y, zc]), n),
      top_edge: a("Screen top edge, centre", at(hinge, r, [0, y, zc + d.h / 2])), bottom_edge: a("Screen bottom edge, centre", at(hinge, r, [0, y, zc - d.h / 2])),
      left_edge: a("Screen left edge (viewer's left)", at(hinge, r, [-d.w / 2, y, zc])), right_edge: a("Screen right edge (viewer's right)", at(hinge, r, [d.w / 2, y, zc])),
      viewing_normal: a("Viewing normal", at(hinge, r, [0, y, zc]), n),
      keyboard_centre: a("Keyboard centre", [0, d.th + 0.004, -d.depth * 0.2]),
      base_front: a("Base front edge, centre", [0, d.th, d.depth / 2]),
    };
  },
  grips: (p, d) => [
    grip("rest_left", "Left palm rest", "L", [d.bw * 0.2, d.th + 0.002, d.depth * 0.3], [0, -1, 0], [1, 0, 0], 0),
    grip("rest_right", "Right palm rest", "R", [-d.bw * 0.2, d.th + 0.002, d.depth * 0.3], [0, -1, 0], [1, 0, 0], 0),
  ],
});

def({
  type: "wall_display", name: "Wall display", category: "Displays", color: "#555c66", yaw: 180, tags: ["screen", "display"],
  description: "Large flat panel on a wall bracket, landscape or portrait. Origin: the floor under the screen centre. Place it against a Wall object.",
  source: "Signage and briefing displays, 32 to 98 inch, 16:9.",
  params: [
    num("diagonal", "Screen diagonal", "in", 32, 98, 1, 55),
    choice("orientation", "Orientation", [{ value: "landscape", label: "Landscape" }, { value: "portrait", label: "Portrait" }], "landscape"),
    num("centreHeight", "Screen centre height", "m", 0.8, 2.2, 0.005, 1.5),
  ],
  dims(p) { let [w, h] = screenSize(p.diagonal, "16:9"); if (p.orientation === "portrait") [w, h] = [h, w]; return { w, h, cH: Math.max(p.centreHeight, (h + BZ_TOP + BZ_BOT) / 2 + 0.03) }; },
  build(P, p, d) {
    P.frame([0, d.cH, 0], [0, 0, 0], (q) => {
      panelDisplay(q, d.w, d.h, { thick: 0.04, noBack: true });
      q.box([Math.min(d.w * 0.5, 0.45), Math.min(d.h * 0.5, 0.45), 0.02], [0, 0, -0.05], "steel");
      q.box([0.12, 0.05, 0.03], [0, -(d.h + BZ_BOT) / 2 - 0.001, -0.02], "dark");
    });
  },
  anchors(p, d) {
    const f = [0, d.cH, 0], n = [0, 0, 1];
    return { screen_centre: a("Screen centre", f, n), top_edge: a("Screen top edge, centre", [0, d.cH + d.h / 2, 0]), bottom_edge: a("Screen bottom edge, centre", [0, d.cH - d.h / 2, 0]), left_edge: a("Screen left edge (viewer's left)", [-d.w / 2, d.cH, 0]), right_edge: a("Screen right edge (viewer's right)", [d.w / 2, d.cH, 0]), viewing_normal: a("Viewing normal", f, n) };
  },
});

def({
  type: "instrument_panel", name: "Instrument panel", category: "Displays", color: "#555c66", yaw: 180, tags: ["display", "cockpit", "vehicle", "controls"],
  description: "Dashboard / cockpit panel with a row of round dials and a row of switches on a cowl. The panel faces +Z; set its width, height, tilt and centre height.",
  source: "Generic vehicle and cockpit panel; dimensions adjustable to the workspace under study.",
  params: [
    num("width", "Panel width", "m", 0.4, 1.6, 0.01, 0.9),
    num("height", "Panel height", "m", 0.15, 0.5, 0.005, 0.28),
    num("centreHeight", "Panel centre height", "m", 0.6, 1.4, 0.005, 0.95),
    num("tilt", "Tilt back from vertical", "deg", -10, 45, 1, 15),
    num("dials", "Number of dials", "", 2, 8, 1, 4),
    num("switches", "Number of switches", "", 0, 12, 1, 6),
  ],
  build(P, p) {
    const cH = p.centreHeight, w = p.width, h = p.height, cb = cH - (h / 2) * Math.cos(p.tilt * D2R) - 0.01;
    P.box([w + 0.06, Math.max(cb, 0.05), 0.3], [0, Math.max(cb, 0.05) / 2, -0.17], "rubber");
    P.frame([0, cH, 0], [-p.tilt, 0, 0], (q) => {
      q.rbox([w, h, 0.03], 0.012, [0, 0, -0.015], "dark");
      const rd = Math.min(h * 0.24, (w / p.dials) * 0.4), y = p.switches ? h * 0.12 : 0;
      for (let i = 0; i < p.dials; i++) {
        const x = -w / 2 + (w * (i + 0.5)) / p.dials, ang = -50 + ((i * 47) % 100);
        q.cyl(rd, 0.012, [x, y, 0.004], "metal", "z", { seg: 24 });
        q.cyl(rd * 0.86, 0.004, [x, y, 0.0105], "white", "z", { seg: 24 });
        q.box([0.004, rd * 0.7, 0.003], [x, y, 0.014], "red", [0, 0, ang], undefined);
      }
      for (let i = 0; i < p.switches; i++) {
        const x = -w / 2 + (w * (i + 0.5)) / p.switches, yy = -h * 0.3;
        q.cyl(0.011, 0.01, [x, yy, 0.005], "steel", "z", { seg: 10 });
        q.rod([x, yy, 0.008], [x + (i % 2 ? 0.004 : -0.004), yy + (i % 3 ? 0.012 : -0.012), 0.032], 0.0045, "orange", 6);
      }
    });
  },
  anchors(p) {
    const f = [0, p.centreHeight, 0], r = [-p.tilt, 0, 0], n = dirAt(r, [0, 0, 1]);
    return {
      panel_centre: a("Panel centre", f, n), screen_centre: a("Panel centre (display centre)", f, n),
      top_edge: a("Panel top edge, centre", at(f, r, [0, p.height / 2, 0])), bottom_edge: a("Panel bottom edge, centre", at(f, r, [0, -p.height / 2, 0])),
      left_edge: a("Panel left edge (viewer's left)", at(f, r, [-p.width / 2, 0, 0])), right_edge: a("Panel right edge (viewer's right)", at(f, r, [p.width / 2, 0, 0])),
      switch_row: a("Switch row, centre", at(f, r, [0, -p.height * 0.3, 0.02])), viewing_normal: a("Viewing normal", f, n),
    };
  },
});

// =====================================================================================================================
// BOXES AND LOADS
// =====================================================================================================================
const massParam = (def, max = 300) => num("mass", "Mass", "kg", 0, max, 0.5, def);
const dimParams = (w, d, h, lo = 0.1, hi = 1.5) => [num("width", "Width (X)", "m", lo, hi, 0.005, w), num("depth", "Depth (Z)", "m", lo, hi, 0.005, d), num("height", "Height (Y)", "m", lo, hi, 0.005, h)];
const SCALE_WDH = { x: "width", y: "height", z: "depth" };
const carryGrips = (w, h, y, d = 0) => [
  grip("side_left", "Side, left (+X)", "L", [w / 2, y, d], [-1, 0, 0], [0, 0, 1], 0.03),
  grip("side_right", "Side, right (-X)", "R", [-w / 2, y, d], [1, 0, 0], [0, 0, 1], 0.03),
];

def({
  type: "crate", name: "Crate", category: "Boxes and loads", color: "#bb9462", scaleMap: SCALE_WDH, tags: ["load", "lift", "carry"],
  description: "Wooden crate with corner posts, battens and end handles; set its size and mass (shown in the 3D view). Handles: carry it with the left hand on +X and the right hand on -X.",
  source: "Generic transport crate. Mass is for labelling only; there is no load model.",
  params: [...dimParams(0.6, 0.4, 0.4, 0.2, 1.5), massParam(20)],
  build(P, p) {
    const { width: w, depth: d, height: h } = p, t = 0.035;
    P.box([w - 0.01, h - 0.07, d - 0.01], [0, h / 2, 0], "main");
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.box([t, h, t], [sx * (w / 2 - t / 2), h / 2, sz * (d / 2 - t / 2)], "wood2");
    for (const y of [0.0175, h - 0.0175]) {
      for (const sz of [-1, 1]) P.box([w, 0.035, 0.03], [0, y, sz * (d / 2 - 0.015)], "wood2");
      for (const sx of [-1, 1]) P.box([0.03, 0.035, d], [sx * (w / 2 - 0.015), y, 0], "wood2");
    }
    for (const sz of [-1, 1]) {
      const len = Math.hypot(w - 0.1, h - 0.1);
      P.box([len, 0.03, 0.012], [0, h / 2, sz * (d / 2 + 0.002)], "wood2", [0, 0, Math.atan2(h - 0.1, w - 0.1) / D2R]);
    }
    for (const sx of [-1, 1]) P.box([0.012, 0.04, Math.min(0.16, d * 0.45)], [sx * (w / 2 + 0.001), h * 0.68, 0], "dark");
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => carryGrips(p.width, p.height, p.height * 0.68),
  supports: (p) => [support("top", "Top", p.height, [p.width, p.depth], [0, 0])],
});

def({
  type: "small_box", name: "Small box", category: "Boxes and loads", color: "#c89f6e", scaleMap: SCALE_WDH, tags: ["load", "lift", "carry"],
  description: "Cardboard box with a taped lid. Set its size and mass.",
  params: [...dimParams(0.3, 0.2, 0.2, 0.05, 0.6), massParam(5, 40)],
  build(P, p) {
    const { width: w, depth: d, height: h } = p;
    P.box([w, h, d], [0, h / 2, 0], "main");
    P.box([Math.min(0.05, w * 0.25), 0.002, d + 0.001], [0, h + 0.0005, 0], "tape");
    P.box([Math.min(0.05, w * 0.25), h * 0.9, 0.002], [0, h * 0.55, d / 2 + 0.0005], "tape");
    P.box([w + 0.001, 0.003, d + 0.001], [0, h - 0.0015, 0], "wood2");
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => carryGrips(p.width, p.height, p.height * 0.5).map((g) => ({ ...g, diameter: 0 })),
  supports: (p) => [support("top", "Top", p.height, [p.width, p.depth], [0, 0])],
});

def({
  type: "pallet", name: "Pallet", category: "Boxes and loads", color: "#c89f6e", tags: ["load", "lift", "forklift"],
  description: "Wooden pallet (default 1.2 by 0.8 m, 0.144 m high) with an optional wrapped load; set the load height and mass.",
  source: "EUR / EPAL 1 pallet 1200 x 800 x 144 mm; the 48 x 40 inch GMA pallet is 1219 x 1016 mm.",
  params: [num("length", "Length (X)", "m", 0.6, 1.4, 0.005, 1.2), num("width", "Width (Z)", "m", 0.6, 1.2, 0.005, 0.8), num("loadHeight", "Load height (0 = empty)", "m", 0, 1.8, 0.01, 0), massParam(0, 1500)],
  build(P, p) {
    const { length: l, width: w } = p, H = 0.144;
    for (let i = 0; i < 5; i++) P.box([0.145, 0.022, w], [-l / 2 + 0.0725 + (i * (l - 0.145)) / 4, H - 0.011, 0], "wood");
    for (const x of [-l / 2 + 0.0725, 0, l / 2 - 0.0725]) {
      P.box([0.145, 0.022, w], [x, 0.011, 0], "wood");
      for (const z of [-w / 2 + 0.05, 0, w / 2 - 0.05]) P.box([0.1, 0.1, 0.1], [x, 0.022 + 0.05, z], "wood2");
    }
    if (p.loadHeight > 0.01) {
      P.box([l - 0.04, p.loadHeight, w - 0.04], [0, H + p.loadHeight / 2, 0], "main");
      for (let y = 0.3; y < p.loadHeight - 0.05; y += 0.3) P.box([l - 0.036, 0.012, w - 0.036], [0, H + y, 0], "dark");
    }
  },
  anchors: (p) => {
    const top = 0.144 + (p.loadHeight > 0.01 ? p.loadHeight : 0);
    return { ...boxAnchors(p.length, p.width, top), deck_centre: a("Pallet deck, centre", [0, 0.144, 0]), ...(p.loadHeight > 0.01 ? { load_top: a("Load top, centre", [0, top, 0]) } : {}), label_point: a("Label (top centre)", [0, top, 0]) };
  },
  supports: (p) => (p.loadHeight > 0.01 ? [support("load_top", "Load top", 0.144 + p.loadHeight, [p.length - 0.04, p.width - 0.04], [0, 0])] : [support("deck", "Pallet deck", 0.144, [p.length, p.width], [0, 0])]),
});

def({
  type: "ammo_can", name: "Ammunition can", category: "Boxes and loads", color: "#6f7a50", tags: ["load", "carry", "military"],
  description: "Steel ammunition can with a latch and a folding top handle. Defaults approximate a .50 calibre can; mass is for labelling.",
  source: "Approximate size of a .50 cal M2A1 can (about 0.30 x 0.15 x 0.18 m); check the item data sheet for exact values.",
  params: [num("length", "Length (X)", "m", 0.2, 0.4, 0.005, 0.30), num("width", "Width (Z)", "m", 0.1, 0.2, 0.005, 0.15), num("height", "Height (Y)", "m", 0.1, 0.25, 0.005, 0.185), massParam(7, 25)],
  build(P, p) {
    const { length: l, width: w, height: h } = p;
    P.rbox([l, h, w], 0.012, [0, h / 2, 0], "main");
    P.box([l + 0.004, 0.012, w + 0.004], [0, h * 0.72, 0], "dark");
    P.box([0.05, 0.03, 0.012], [0, h * 0.72, w / 2 + 0.006], "metal");
    P.rod([-0.06, h + 0.022, 0], [0.06, h + 0.022, 0], 0.007, "metal", 8);
    for (const s of [-1, 1]) P.rod([s * 0.06, h, 0], [s * 0.06, h + 0.022, 0], 0.005, "metal", 6);
    P.box([l * 0.7, 0.006, w * 0.5], [0, h + 0.003, 0], "dark");
  },
  anchors: (p) => ({ ...boxAnchors(p.length, p.width, p.height), handle: a("Carry handle", [0, p.height + 0.022, 0]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("handle", "Carry handle", "both", [0, p.height + 0.022, 0], [0, -1, 0], [1, 0, 0], 0.014)],
  supports: (p) => [support("top", "Lid", p.height, [p.length, p.width], [0, 0])],
});

def({
  type: "toolbox", name: "Toolbox", category: "Boxes and loads", color: "#c0493d", tags: ["load", "carry", "tool"],
  description: "Hinged toolbox with an arched carry handle and two latches.",
  params: [num("length", "Length (X)", "m", 0.3, 0.7, 0.005, 0.45), num("width", "Width (Z)", "m", 0.15, 0.3, 0.005, 0.2), num("height", "Height (Y)", "m", 0.15, 0.3, 0.005, 0.2), massParam(8, 30)],
  build(P, p) {
    const { length: l, width: w, height: h } = p;
    P.rbox([l, h * 0.62, w], 0.015, [0, h * 0.31, 0], "main");
    P.rbox([l - 0.01, h * 0.38, w - 0.01], 0.03, [0, h * 0.62 + h * 0.19, 0], "dark");
    P.tor(Math.min(l * 0.17, 0.08), 0.008, [0, h, 0], "metal", [0, 0, 0], Math.PI, [6, 16]);
    for (const s of [-1, 1]) P.box([0.035, 0.05, 0.012], [s * l * 0.28, h * 0.6, w / 2 + 0.006], "metal");
  },
  anchors: (p) => ({ ...boxAnchors(p.length, p.width, p.height), handle: a("Carry handle", [0, p.height + Math.min(p.length * 0.17, 0.08), 0]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("handle", "Carry handle", "both", [0, p.height + Math.min(p.length * 0.17, 0.08), 0], [0, -1, 0], [1, 0, 0], 0.016)],
  supports: (p) => [support("top", "Lid", p.height, [p.length, p.width], [0, 0])],
});

def({
  type: "rucksack", name: "Rucksack", category: "Boxes and loads", color: "#6f7a50", tags: ["load", "carry", "wear"],
  description: "Field pack standing on its base: main compartment, lid, side pockets, shoulder straps on the -Z side and a top carry handle.",
  params: [num("height", "Height (Y)", "m", 0.35, 0.8, 0.005, 0.55), num("width", "Width (X)", "m", 0.25, 0.45, 0.005, 0.32), num("depth", "Depth (Z)", "m", 0.15, 0.3, 0.005, 0.22), massParam(15, 45)],
  build(P, p) {
    const { height: h, width: w, depth: d } = p;
    P.rbox([w, h * 0.86, d], 0.05, [0, h * 0.43, 0], "main");
    P.rbox([w + 0.01, h * 0.22, d + 0.014], 0.04, [0, h * 0.86 - 0.02, 0.003], "main");
    P.rbox([w * 0.8, h * 0.36, 0.05], 0.025, [0, h * 0.34, d / 2 + 0.02], "main");
    for (const s of [-1, 1]) {
      P.rbox([0.06, h * 0.4, d * 0.7], 0.025, [s * (w / 2 + 0.018), h * 0.24, 0], "main");
      P.rbox([0.07, h * 0.62, 0.018], 0.008, [s * w * 0.27, h * 0.5, -d / 2 - 0.01], "dark");
    }
    P.tor(0.05, 0.007, [0, h * 0.97, 0], "dark", [0, 0, 0], Math.PI, [6, 14]);
    P.box([w * 0.6, 0.012, 0.006], [0, h * 0.8, d / 2 + 0.01], "dark");
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), handle: a("Top carry handle", [0, p.height * 0.97 + 0.05, 0]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("handle", "Top carry handle", "both", [0, p.height * 0.97 + 0.05, 0], [0, -1, 0], [1, 0, 0], 0.014)],
  supports: (p) => [support("top", "Top", p.height, [p.width * 0.8, p.depth * 0.8], [0, 0])],
});

def({
  type: "drum", name: "Drum", category: "Boxes and loads", color: "#3a74b8", tags: ["load", "roll"],
  description: "Steel drum with rolling hoops, a lid and two bungs. Defaults are a 208 litre (55 US gallon) drum.",
  source: "55 US gallon (208 l) drum: about 0.585 m diameter and 0.88 m high.",
  params: [num("diameter", "Diameter", "m", 0.3, 0.7, 0.005, 0.585), num("height", "Height", "m", 0.4, 1.0, 0.005, 0.88), massParam(150, 300)],
  build(P, p) {
    const r = p.diameter / 2, h = p.height, rr = (y) => [r * 1.0, y], hoop = (y) => [[r * 0.985, y - 0.03], [r * 1.012, y - 0.012], [r * 1.012, y + 0.012], [r * 0.985, y + 0.03]];
    P.lat([[0.001, 0], [r * 0.97, 0], [r, 0.012], [r, 0.03], ...hoop(h * 0.27), ...hoop(h * 0.73), [r, h - 0.03], [r, h - 0.012], [r * 0.97, h], [0.001, h]], [0, 0, 0], "main", undefined, 32);
    P.cyl(r * 0.92, 0.01, [0, h - 0.004, 0], "dark", "y", { seg: 28 });
    P.cyl(0.03, 0.016, [r * 0.5, h + 0.003, 0], "metal", "y", { seg: 12 });
    P.cyl(0.02, 0.014, [-r * 0.45, h + 0.002, r * 0.2], "metal", "y", { seg: 12 });
  },
  anchors: (p) => ({ top_centre: a("Top, centre", [0, p.height, 0]), base_centre: a("Base, centre", [0, 0, 0]), top_front: a("Top rim, front", [0, p.height, p.diameter / 2]), top_back: a("Top rim, back", [0, p.height, -p.diameter / 2]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("rim_front", "Top rim, front", "both", [0, p.height, p.diameter / 2], [0, 0, -1], [1, 0, 0], 0.012), grip("rim_back", "Top rim, back", "both", [0, p.height, -p.diameter / 2], [0, 0, 1], [1, 0, 0], 0.012)],
  supports: (p) => [support("top", "Lid", p.height, [p.diameter * 0.9, p.diameter * 0.9], [0, 0])],
});

def({
  type: "sandbag", name: "Sandbag", category: "Boxes and loads", color: "#c9b98a", tags: ["load", "carry", "military"],
  description: "Filled sandbag, a flattened pillow with a tied end.",
  params: [num("length", "Length (X)", "m", 0.3, 0.7, 0.005, 0.5), num("width", "Width (Z)", "m", 0.2, 0.4, 0.005, 0.3), num("height", "Height (Y)", "m", 0.08, 0.2, 0.005, 0.12), massParam(20, 40)],
  build(P, p) {
    P.sph(1, [0, p.height / 2, 0], "main", [p.length / 2, p.height / 2, p.width / 2], [20, 12]);
    P.sph(0.02, [p.length / 2 - 0.01, p.height * 0.5, 0], "wood2", [1.4, 1, 1], [8, 6]);
  },
  anchors: (p) => ({ top_centre: a("Top, centre", [0, p.height, 0]), base_centre: a("Base, centre", [0, 0, 0]), end_tied: a("Tied end", [p.length / 2, p.height / 2, 0]), end_plain: a("Other end", [-p.length / 2, p.height / 2, 0]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("tied_end", "Tied end", "both", [p.length / 2 - 0.02, p.height / 2, 0], [-1, 0, 0], [0, 0, 1], 0.05)],
  supports: (p) => [support("top", "Top", p.height * 0.98, [p.length * 0.4, p.width * 0.4], [0, 0])],
});

def({
  type: "jerrycan", name: "Jerrycan", category: "Boxes and loads", color: "#6f7a50", tags: ["load", "carry", "military"],
  description: "20 litre fuel can with a three-bar handle, a spout and pressed ribs. Mass is for labelling.",
  source: "NATO-style 20 l can, about 0.34 x 0.16 x 0.46 m; check the item data sheet for exact values.",
  params: [num("height", "Height (Y)", "m", 0.3, 0.6, 0.005, 0.46), num("width", "Width (X)", "m", 0.25, 0.4, 0.005, 0.34), num("depth", "Depth (Z)", "m", 0.12, 0.22, 0.005, 0.16), massParam(16, 25)],
  build(P, p) {
    const { height: h, width: w, depth: d } = p;
    P.rbox([w, h, d], 0.02, [0, h / 2, 0], "main");
    for (const sz of [-1, 1]) {
      P.box([Math.hypot(w * 0.8, h * 0.7), 0.014, 0.004], [0, h * 0.5, sz * (d / 2)], "dark", [0, 0, Math.atan2(h * 0.7, w * 0.8) / D2R]);
      P.box([Math.hypot(w * 0.8, h * 0.7), 0.014, 0.004], [0, h * 0.5, sz * (d / 2)], "dark", [0, 0, -Math.atan2(h * 0.7, w * 0.8) / D2R]);
    }
    for (const dx of [-0.065, 0, 0.065]) P.box([0.03, 0.035, d * 0.85], [dx - 0.03, h + 0.015, 0], "main");
    P.box([0.2, 0.012, d * 0.85], [-0.03, h + 0.034, 0], "main");
    P.cyl(0.022, 0.05, [w * 0.33, h + 0.02, 0], "dark", "y", { seg: 14 });
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), handle: a("Handle", [-0.03, p.height + 0.034, 0]), label_point: a("Label (top centre)", [0, p.height, 0]) }),
  grips: (p) => [grip("handle", "Handle", "both", [-0.03, p.height + 0.034, 0], [0, -1, 0], [0, 0, 1], 0.03)],
  supports: (p) => [support("top", "Top", p.height, [p.width * 0.6, p.depth], [0, 0])],
});

// =====================================================================================================================
// STRUCTURES
// =====================================================================================================================
def({
  type: "floor_platform", name: "Floor platform", category: "Structures", color: "#8a929b", scaleMap: SCALE_WDH, tags: ["platform", "stand"],
  description: "Raised floor platform or deck. Use it for a raised floor, a seat base or a plinth; its top is a support surface.",
  params: [num("width", "Width (X)", "m", 0.5, 6, 0.01, 1.5), num("depth", "Depth (Z)", "m", 0.5, 6, 0.01, 1.5), num("height", "Height (Y)", "m", 0.02, 0.8, 0.005, 0.15)],
  build(P, p) {
    const { width: w, depth: d, height: h } = p, t = Math.min(0.012, h * 0.5);
    P.box([w, h - t, d], [0, (h - t) / 2, 0], "main");
    P.box([w, t, d], [0, h - t / 2, 0], "steel");
    P.box([w + 0.004, Math.min(0.03, h * 0.5), d + 0.004], [0, Math.min(0.03, h * 0.5) / 2, 0], "dark");
  },
  anchors: (p) => boxAnchors(p.width, p.depth, p.height),
  supports: (p) => [support("top", "Platform top", p.height, [p.width, p.depth], [0, 0])],
});

def({
  type: "step", name: "Step", category: "Structures", color: "#8a929b", tags: ["stairs", "stand"],
  description: "A single step with a non-slip tread edge. Origin: the floor under the middle of the tread. Its top is a support surface.",
  source: "Riser 0.12 to 0.25 m, tread at least 0.2 m (typical stair practice; see MIL-STD-1472 for stairways).",
  params: [num("width", "Width (X)", "m", 0.3, 1.5, 0.01, 0.8), num("depth", "Tread depth (Z)", "m", 0.2, 0.5, 0.005, 0.3), num("rise", "Rise (Y)", "m", 0.05, 0.45, 0.005, 0.18)],
  build(P, p) {
    const { width: w, depth: d, rise: h } = p;
    P.box([w, h, d], [0, h / 2, 0], "main");
    P.box([w, 0.012, 0.045], [0, h + 0.002, d / 2 - 0.0225], "dark");
    P.box([w + 0.004, Math.min(0.03, h * 0.5), d + 0.004], [0, Math.min(0.03, h * 0.5) / 2, 0], "dark");
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.rise), nosing: a("Tread nosing, centre", [0, p.rise, p.depth / 2]) }),
  supports: (p) => [support("tread", "Tread", p.rise, [p.width, p.depth], [0, 0])],
});

def({
  type: "stairs", name: "Stairs", category: "Structures", color: "#a9a79f", tags: ["stairs", "climb", "stand"],
  description: "Straight flight of stairs climbing along +Z, with optional handrails. Origin: the floor under the middle of the first riser. Every tread is a support surface.",
  source: "Ranges after MIL-STD-1472 stair guidance (riser about 0.12 to 0.20 m, tread at least 0.24 m, handrail about 0.9 m above the nosing line); check the current revision for compliance work.",
  params: [num("steps", "Number of steps", "", 2, 16, 1, 5), num("rise", "Rise per step", "m", 0.12, 0.25, 0.005, 0.18), num("tread", "Tread depth", "m", 0.20, 0.35, 0.005, 0.28), num("width", "Width", "m", 0.6, 1.5, 0.01, 0.9), bool("handrails", "Handrails")],
  build(P, p) {
    const { steps: n, rise: r, tread: t, width: w } = p;
    const prof = [[0, 0], [n * t, 0]];
    for (let i = n; i >= 1; i--) { prof.push([i * t, i * r]); prof.push([(i - 1) * t, i * r]); }
    P.side(prof, w, 0, "main");
    for (let i = 1; i <= n; i++) P.box([w + 0.004, 0.01, 0.04], [0, i * r + 0.002, (i - 0.5) * t + t / 2 - 0.02], "dark");
    if (p.handrails) for (const s of [-1, 1]) {
      const x = s * (w / 2 + 0.035), yr = (z) => 0.9 + (z / t) * r, idx = new Set([0, n - 1]);
      P.rod([x, yr(0), 0], [x, yr(n * t), n * t], 0.019, "steel", 10);
      for (let i = 0; i < n; i += Math.max(1, Math.round(1.1 / t))) idx.add(i);
      for (const i of idx) { const z = (i + 0.5) * t; P.rod([x, (i + 1) * r, z], [x, yr(z), z], 0.012, "steel", 8); }
    }
  },
  anchors: (p) => ({
    foot: a("Foot of the stairs (first riser)", [0, 0, 0]), first_tread: a("First tread, centre", [0, p.rise, p.tread / 2]),
    top_tread: a("Top tread, centre", [0, p.steps * p.rise, (p.steps - 0.5) * p.tread]), top_nosing: a("Top nosing, centre", [0, p.steps * p.rise, p.steps * p.tread]),
  }),
  grips(p) {
    if (!p.handrails) return [];
    const z = (p.steps * p.tread) / 2, y = 0.9 + (z / p.tread) * p.rise, ax = unit([0, p.rise, p.tread]);
    return [grip("rail_left", "Handrail, left (+X)", "L", [p.width / 2 + 0.035, y, z], [0, -1, 0], ax, 0.038), grip("rail_right", "Handrail, right (-X)", "R", [-p.width / 2 - 0.035, y, z], [0, -1, 0], ax, 0.038)];
  },
  supports: (p) => Array.from({ length: p.steps }, (_, i) => support(`tread_${i + 1}`, `Tread ${i + 1}`, (i + 1) * p.rise, [p.width, p.tread], [0, (i + 0.5) * p.tread])),
});

def({
  type: "ladder", name: "Ladder", category: "Structures", color: "#dcae2e", tags: ["climb"],
  description: "Leaning rung ladder. Origin: the middle of the foot on the floor; it leans towards +Z, the way the climber faces. Rungs are grip targets for both hands.",
  source: "Ranges after MIL-STD-1472 ladder guidance (rung spacing about 0.25 to 0.35 m, rung diameter about 20 to 40 mm, width at least 0.4 m); check the current revision for compliance work.",
  params: [num("length", "Ladder length", "m", 1.0, 4.0, 0.05, 2.4), num("angle", "Angle from the floor", "deg", 60, 90, 1, 75), num("spacing", "Rung spacing", "m", 0.25, 0.35, 0.005, 0.30), num("width", "Width between rails", "m", 0.35, 0.6, 0.005, 0.45), num("rung", "Rung diameter", "m", 0.02, 0.04, 0.001, 0.03)],
  dims(p) {
    const al = p.angle * D2R, dir = [0, Math.sin(al), Math.cos(al)], count = Math.max(1, Math.floor((p.length - 0.15) / p.spacing));
    return { al, dir, count };
  },
  build(P, p, d) {
    for (const s of [-1, 1]) {
      const x = s * p.width / 2;
      P.rod([x, 0.022 * Math.cos(d.al), 0], add3([x, 0, 0], d.dir, p.length), 0.022, "main", 10); // the cap of a leaning rod dips r*cos(angle) below its end point
      P.box([0.05, 0.03, 0.07], [x, 0.015, 0.0], "rubber");
    }
    for (let i = 1; i <= d.count; i++) { const c = add3([0, 0, 0], d.dir, 0.15 + (i - 1) * p.spacing); P.cyl(p.rung / 2, p.width, c, "metal", "x", { seg: 10 }); }
  },
  anchors: (p, d) => ({ foot_centre: a("Foot, centre", [0, 0, 0]), top_centre: a("Top end, centre", add3([0, 0, 0], d.dir, p.length)), mid_point: a("Middle of the ladder", add3([0, 0, 0], d.dir, p.length / 2)) }),
  grips: (p, d) => Array.from({ length: d.count }, (_, i) => grip(`rung_${i + 1}`, `Rung ${i + 1}`, "both", add3([0, 0, 0], d.dir, 0.15 + i * p.spacing), [0, -1, 0], [1, 0, 0], p.rung)),
});

def({
  type: "desk", name: "Desk", category: "Structures", color: "#bb9462", yaw: 180, tags: ["table", "workstation"],
  description: "Office desk with steel legs, an optional modesty panel and drawer pedestal. Origin: the floor under the middle of the top; the user sits at +Z.",
  source: "Fixed-height desk 0.72 to 0.74 m after EN 527 / ISO 9241-5; sit-stand desks span about 0.65 to 1.25 m.",
  params: [num("height", "Desk height", "m", 0.6, 1.3, 0.005, 0.74), num("width", "Width (X)", "m", 0.8, 2.2, 0.01, 1.4), num("depth", "Depth (Z)", "m", 0.5, 1.0, 0.01, 0.7), bool("drawers", "Drawer pedestal")],
  build(P, p) {
    const { height: h, width: w, depth: d } = p;
    P.box([w, 0.03, d], [0, h - 0.015, 0], "main");
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.box([0.045, h - 0.03, 0.045], [sx * (w / 2 - 0.05), (h - 0.03) / 2, sz * (d / 2 - 0.05)], "steel");
    for (const sz of [-1, 1]) P.box([w - 0.12, 0.04, 0.02], [0, h - 0.05, sz * (d / 2 - 0.05)], "steel");
    P.box([w - 0.2, 0.3, 0.015], [0, h - 0.2, -d / 2 + 0.06], "wood2");
    if (p.drawers) {
      const x = w / 2 - 0.25;
      P.box([0.4, h - 0.07, d - 0.12], [x, 0.0 + (h - 0.07) / 2 + 0.02, 0], "wood2");
      for (let i = 0; i < 3; i++) { const y = 0.1 + i * ((h - 0.2) / 3); P.box([0.36, 0.008, 0.01], [x, y + (h - 0.2) / 6, d / 2 - 0.058], "dark"); P.box([0.1, 0.014, 0.014], [x, y + (h - 0.2) / 6 - 0.02, d / 2 - 0.05], "metal"); }
    }
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), user_edge: a("Edge towards the user, centre", [0, p.height, p.depth / 2]), top_centre: a("Desk top, centre", [0, p.height, 0]) }),
  supports: (p) => [support("top", "Desk top", p.height, [p.width, p.depth], [0, 0])],
});

def({
  type: "workbench", name: "Workbench", category: "Structures", color: "#bb9462", yaw: 180, tags: ["table", "work"],
  description: "Heavy workbench with a thick top, steel frame, lower shelf and a bench vise at one end.",
  source: "Standing work heights about 0.85 to 1.0 m (precision work higher, heavy work lower).",
  params: [num("height", "Bench height", "m", 0.75, 1.1, 0.005, 0.9), num("width", "Width (X)", "m", 1.0, 3.0, 0.01, 1.8), num("depth", "Depth (Z)", "m", 0.5, 0.9, 0.01, 0.7)],
  build(P, p) {
    const { height: h, width: w, depth: d } = p;
    P.box([w, 0.05, d], [0, h - 0.025, 0], "main");
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.box([0.06, h - 0.05, 0.06], [sx * (w / 2 - 0.08), (h - 0.05) / 2, sz * (d / 2 - 0.08)], "steel");
    for (const sz of [-1, 1]) P.box([w - 0.2, 0.06, 0.04], [0, h - 0.08, sz * (d / 2 - 0.08)], "steel");
    P.box([w - 0.12, 0.03, d - 0.12], [0, 0.22, 0], "wood2");
    P.box([0.1, 0.09, 0.16], [w / 2 - 0.12, h + 0.04, d / 2 - 0.1], "dark");
    P.box([0.07, 0.05, 0.015], [w / 2 - 0.12, h + 0.04, d / 2 + 0.01], "metal");
  },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), user_edge: a("Edge towards the user, centre", [0, p.height, p.depth / 2]) }),
  supports: (p) => [support("top", "Bench top", p.height, [p.width, p.depth], [0, 0]), support("lower_shelf", "Lower shelf", 0.235, [p.width - 0.12, p.depth - 0.12], [0, 0])],
});

def({
  type: "shelving", name: "Shelving unit", category: "Structures", color: "#8a929b", yaw: 180, tags: ["storage", "reach"],
  description: "Open steel shelving with a choice of shelf count and bottom shelf height; every shelf top is a support surface for loads. The open front is +Z.",
  params: [num("width", "Width (X)", "m", 0.6, 1.5, 0.01, 0.9), num("depth", "Depth (Z)", "m", 0.3, 0.6, 0.01, 0.4), num("height", "Height (Y)", "m", 1.0, 2.4, 0.01, 1.8), num("shelves", "Number of shelves", "", 2, 8, 1, 4), num("bottom", "Bottom shelf height", "m", 0.1, 0.5, 0.01, 0.2)],
  dims(p) { const ys = Array.from({ length: p.shelves }, (_, i) => p.bottom + (i * (p.height - p.bottom)) / (p.shelves - 1)); return { ys }; },
  build(P, p, d) {
    const { width: w, depth: dp, height: h } = p;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.box([0.035, h, 0.035], [sx * (w / 2 - 0.0175), h / 2, sz * (dp / 2 - 0.0175)], "steel");
    for (const y of d.ys) P.box([w - 0.07, 0.03, dp], [0, y - 0.015, 0], "main");
    for (const sx of [-1, 1]) P.rod([sx * (w / 2 - 0.0175), 0.15, -dp / 2 + 0.02], [sx * (w / 2 - 0.0175) * -1, h - 0.15, -dp / 2 + 0.02], 0.007, "dark", 6);
  },
  anchors: (p, d) => Object.fromEntries([["top_centre", a("Top, centre", [0, p.height, 0])], ...d.ys.map((y, i) => [`shelf_${i + 1}`, a(`Shelf ${i + 1} top, front edge centre`, [0, y, p.depth / 2])])]),
  supports: (p, d) => d.ys.map((y, i) => support(`shelf_${i + 1}`, `Shelf ${i + 1}`, y, [p.width - 0.07, p.depth], [0, 0])),
});

def({
  type: "wall", name: "Wall", category: "Structures", color: "#c9b98a", scaleMap: { x: "width", y: "height", z: "thickness" }, tags: ["structure"],
  description: "Plain wall. Origin: the floor under the middle of its front face; the wall extends towards -Z.",
  params: [num("width", "Width (X)", "m", 1, 10, 0.05, 3), num("height", "Height (Y)", "m", 0.5, 4, 0.05, 2.5), num("thickness", "Thickness (Z)", "m", 0.05, 0.4, 0.01, 0.12)],
  build(P, p) {
    P.box([p.width, p.height, p.thickness], [0, p.height / 2, -p.thickness / 2], "main");
    P.box([p.width + 0.004, 0.08, p.thickness + 0.004], [0, 0.04, -p.thickness / 2 + 0.002], "dark");
  },
  anchors: (p) => ({
    top_centre: a("Top edge, front centre", [0, p.height, 0]), base_centre: a("Base, front centre", [0, 0, 0]), corner_left: a("Front top corner (+X)", [p.width / 2, p.height, 0]), corner_right: a("Front top corner (-X)", [-p.width / 2, p.height, 0]),
    mid_front: a("Middle of the front face", [0, p.height / 2, 0], [0, 0, 1]),
  }),
});

def({
  type: "doorway", name: "Doorway", category: "Structures", color: "#c9b98a", tags: ["structure", "access"],
  description: "Wall with a door opening, frame and threshold. Origin: the floor under the middle of the opening, wall centred on z = 0.",
  source: "Door openings about 0.8 to 1.2 m wide and 2.0 m high are typical; check local codes and MIL-STD-1472 for clearances.",
  params: [num("width", "Opening width", "m", 0.8, 1.2, 0.01, 0.9), num("height", "Opening height", "m", 1.8, 2.4, 0.01, 2.0), num("wallWidth", "Wall width", "m", 1.4, 4.0, 0.05, 2.4), num("wallHeight", "Wall height", "m", 2.2, 3.2, 0.05, 2.6), num("thickness", "Wall thickness", "m", 0.08, 0.3, 0.01, 0.15)],
  build(P, p) {
    const { width: w, height: h, wallWidth: W, wallHeight: H, thickness: t } = p, side = Math.max((W - w) / 2, 0.05);
    for (const s of [-1, 1]) P.box([side, H, t], [s * (w / 2 + side / 2), H / 2, 0], "main");
    P.box([w, Math.max(H - h, 0.05), t], [0, h + Math.max(H - h, 0.05) / 2, 0], "main");
    for (const s of [-1, 1]) P.box([0.04, h, t + 0.03], [s * (w / 2 + 0.02 - 0.0), h / 2, 0], "dark");
    P.box([w + 0.08, 0.04, t + 0.03], [0, h + 0.02, 0], "dark");
    P.box([w, 0.012, t + 0.02], [0, 0.006, 0], "steel");
  },
  anchors: (p) => ({ opening_centre: a("Opening, centre", [0, p.height / 2, 0]), opening_top: a("Opening top, centre", [0, p.height, 0]), jamb_left: a("Jamb, left (+X)", [p.width / 2, p.height / 2, 0]), jamb_right: a("Jamb, right (-X)", [-p.width / 2, p.height / 2, 0]), threshold: a("Threshold, centre", [0, 0.012, 0]) }),
  supports: (p) => [support("threshold", "Threshold", 0.012, [p.width, p.thickness + 0.02], [0, 0])],
});

def({
  type: "hatch", name: "Hatch opening", category: "Structures", color: "#8a929b", tags: ["structure", "access", "vehicle"],
  description: "Access hatch through a bulkhead: a rounded opening with a coaming, a raised sill and an open door leaf. Origin: the floor under the middle of the opening, wall centred on z = 0.",
  source: "Access openings are specified in MIL-STD-1472 (clearance for crawling and stepping through); the defaults are illustrative, not a requirement.",
  params: [num("width", "Opening width", "m", 0.5, 1.0, 0.01, 0.6), num("height", "Opening height", "m", 0.6, 1.4, 0.01, 0.9), num("sill", "Sill height", "m", 0, 0.9, 0.01, 0.4), num("wallWidth", "Wall width", "m", 1.2, 3.0, 0.05, 1.6), num("wallHeight", "Wall height", "m", 1.8, 3.0, 0.05, 2.2), num("thickness", "Wall thickness", "m", 0.08, 0.25, 0.01, 0.12)],
  dims(p) { const sill = Math.max(p.sill, 0.02); return { sill, top: sill + p.height, r: Math.min(0.1, p.width * 0.2, p.height * 0.2) }; },
  build(P, p, d) {
    const round = (w, h, r, cx, cy) => { const pts = [], cs = [[w / 2 - r, h / 2 - r, 0], [-(w / 2 - r), h / 2 - r, 90], [-(w / 2 - r), -(h / 2 - r), 180], [w / 2 - r, -(h / 2 - r), 270]]; for (const [x, y, a0] of cs) for (let k = 0; k <= 4; k++) { const ang = (a0 + k * 22.5) * D2R; pts.push([cx + x + r * Math.cos(ang), cy + y + r * Math.sin(ang)]); } return pts; };
    const cy = d.sill + p.height / 2, hole = round(p.width, p.height, d.r, 0, cy);
    P.extHoles([[-p.wallWidth / 2, 0], [p.wallWidth / 2, 0], [p.wallWidth / 2, p.wallHeight], [-p.wallWidth / 2, p.wallHeight]], [hole], p.thickness, [0, 0, 0], "main");
    const rlo = Math.max(0, d.sill - 0.045), rhi = d.top + 0.045;
    P.extHoles(round(p.width + 0.09, rhi - rlo, d.r + 0.045, 0, (rlo + rhi) / 2), [hole], p.thickness + 0.04, [0, 0, 0], "dark");
    const lo = Math.max(0, d.sill - 0.03), hi = d.top + 0.03; // door leaf hinged on the +X jamb, swung 70 degrees outwards
    P.frame([p.width / 2 + 0.045, (lo + hi) / 2, p.thickness / 2 + 0.02], [0, 70, 0], (q) => q.rbox([p.width + 0.06, hi - lo, 0.03], 0.02, [-(p.width + 0.06) / 2, 0, 0], "steel"));
  },
  anchors: (p, d) => ({ opening_centre: a("Opening, centre", [0, d.sill + p.height / 2, 0]), opening_top: a("Opening top, centre", [0, d.top, 0]), sill: a("Sill, centre", [0, d.sill, 0]), jamb_left: a("Opening edge, left (+X)", [p.width / 2, d.sill + p.height / 2, 0]), jamb_right: a("Opening edge, right (-X)", [-p.width / 2, d.sill + p.height / 2, 0]) }),
  supports: (p, d) => (d.sill > 0.03 ? [support("sill", "Sill", d.sill, [p.width, p.thickness], [0, 0])] : []),
});

def({
  type: "partition", name: "Partition", category: "Structures", color: "#3a74b8", tags: ["structure", "office"],
  description: "Free-standing screen or cubicle partition on two feet.",
  params: [num("width", "Width (X)", "m", 0.5, 3.0, 0.05, 1.5), num("height", "Height (Y)", "m", 0.8, 2.2, 0.05, 1.6), num("thickness", "Thickness (Z)", "m", 0.03, 0.1, 0.005, 0.05)],
  build(P, p) {
    P.rbox([p.width, p.height - 0.1, p.thickness], 0.015, [0, 0.1 + (p.height - 0.1) / 2, 0], "main");
    P.box([p.width + 0.01, 0.025, p.thickness + 0.01], [0, p.height - 0.0125, 0], "dark");
    for (const s of [-1, 1]) P.box([0.04, 0.04, 0.4], [s * (p.width / 2 - 0.15), 0.02, 0], "steel");
  },
  anchors: (p) => ({ top_centre: a("Top edge, centre", [0, p.height, 0]), base_centre: a("Base, centre", [0, 0, 0]), corner_left: a("Top corner (+X)", [p.width / 2, p.height, 0]), corner_right: a("Top corner (-X)", [-p.width / 2, p.height, 0]) }),
});

def({
  type: "handrail", name: "Handrail", category: "Structures", color: "#8a929b", tags: ["grip", "structure"],
  description: "Floor-mounted handrail on posts; three grip targets along it. Stand at +Z. Rail diameter and height are adjustable.",
  source: "Graspable rail diameter about 30 to 50 mm and rail height about 0.9 m are common (MIL-STD-1472 and stair codes); check the current revision for compliance work.",
  params: [num("length", "Length (X)", "m", 0.5, 3.0, 0.05, 1.5), num("height", "Rail height", "m", 0.7, 1.2, 0.005, 0.9), num("diameter", "Rail diameter", "m", 0.03, 0.05, 0.001, 0.038)],
  build(P, p) {
    const n = Math.ceil(p.length / 1.0) + 1;
    P.cyl(p.diameter / 2, p.length, [0, p.height, 0], "main", "x", { seg: 16 });
    for (const s of [-1, 1]) P.sph(p.diameter / 2, [s * p.length / 2, p.height, 0], "main", [1, 1, 1], [10, 8]);
    for (let i = 0; i < n; i++) { const x = -p.length / 2 + 0.05 + (i * (p.length - 0.1)) / (n - 1); P.cyl(0.015, p.height - p.diameter / 2, [x, (p.height - p.diameter / 2) / 2, 0], "steel", "y", { seg: 10 }); P.cyl(0.05, 0.01, [x, 0.005, 0], "dark", "y", { seg: 14 }); }
  },
  anchors: (p) => ({ rail_centre: a("Rail, centre", [0, p.height, 0]), rail_left: a("Rail end (+X)", [p.length / 2, p.height, 0]), rail_right: a("Rail end (-X)", [-p.length / 2, p.height, 0]) }),
  grips: (p) => [-1, 0, 1].map((k) => grip(`rail_${k + 2}`, `Rail ${["left third", "middle", "right third"][k + 1]}`, "both", [k * p.length / 3, p.height, 0], [0, -1, 0], [1, 0, 0], p.diameter)),
});

def({
  type: "console", name: "Console", category: "Structures", color: "#555c66", yaw: 180, tags: ["controls", "workstation"],
  description: "Operator console: a cabinet with a work surface in front and a sloped control panel with buttons at the back. The user stands or sits at +Z.",
  params: [num("width", "Width (X)", "m", 0.8, 2.0, 0.01, 1.2), num("depth", "Depth (Z)", "m", 0.5, 0.9, 0.01, 0.7), num("height", "Work surface height", "m", 0.65, 1.0, 0.005, 0.75), num("panelHeight", "Control panel rise", "m", 0.1, 0.6, 0.01, 0.35), num("panelAngle", "Panel angle from horizontal", "deg", 15, 70, 1, 40)],
  dims(p) { const run = Math.min(p.panelHeight / Math.tan(p.panelAngle * D2R), p.depth - 0.15); return { run, rise: run * Math.tan(p.panelAngle * D2R) }; },
  build(P, p, d) {
    const { width: w, depth: dp, height: h } = p, zb = -dp / 2, zf = zb + d.run;
    P.box([w, h - 0.03, dp - 0.06], [0, (h - 0.03) / 2, 0], "dark");
    P.box([w + 0.02, 0.03, dp], [0, h - 0.015, 0], "main");
    P.side([[zb, h], [zf, h], [zb, h + d.rise]], w + 0.02, 0, "main");
    const slope = Math.atan2(d.rise, d.run), len = Math.hypot(d.run, d.rise), cols = Math.max(3, Math.round(w / 0.1)), nrm = [0, d.run / len, d.rise / len];
    for (let r = 0; r < 3; r++) for (let c = 0; c < cols; c++) {
      const u = 0.2 + r * 0.3, x = -w / 2 + 0.06 + (c * (w - 0.12)) / (cols - 1);
      P.cyl(0.013, 0.012, add3([x, h + d.rise * u, zf - d.run * u], nrm, 0.004), ["red", "yellow", "white"][r], [slope / D2R, 0, 0], { seg: 10 });
    }
  },
  anchors: (p, d) => ({ ...boxAnchors(p.width, p.depth, p.height), panel_centre: a("Control panel, centre", [0, p.height + d.rise * 0.45, -p.depth / 2 + d.run * 0.55], [0, Math.sin(Math.atan2(d.rise, d.run)), Math.cos(Math.atan2(d.rise, d.run))]), user_edge: a("Work surface edge, centre", [0, p.height, p.depth / 2]) }),
  supports: (p, d) => [support("work_surface", "Work surface", p.height, [p.width, p.depth - d.run], [0, d.run / 2])],
});

// =====================================================================================================================
// TOOLS AND CONTROLS
// =====================================================================================================================
const sc = (k, v) => v.map((c) => c * k);

def({
  type: "steering_wheel", name: "Steering wheel", category: "Tools and controls", color: "#555c66", yaw: 180, tags: ["vehicle", "controls", "grip"],
  description: "Steering wheel on a raked column with a dash block and a floor stand. Grip targets at 9 and 3 o'clock as the driver sees it. Its face points to +Z; the driver is at +Z.",
  source: "Passenger-car wheels about 0.34 to 0.40 m, trucks and buses up to 0.50 m; column rake typically 15 to 30 degrees from vertical (SAE J1100 packaging dimensions).",
  params: [num("diameter", "Wheel diameter", "m", 0.30, 0.45, 0.005, 0.38), num("tilt", "Column tilt from vertical", "deg", 10, 70, 1, 25), num("centreHeight", "Hub height", "m", 0.5, 1.2, 0.005, 0.8), num("spokes", "Number of spokes", "", 2, 4, 1, 3)],
  dims(p) { const t = p.tilt * D2R, n = [0, Math.sin(t), Math.cos(t)], hub = [0, p.centreHeight, 0]; return { n, hub, E: add3(hub, n, -0.32), R: p.diameter / 2, rot: [-p.tilt, 0, 0] }; },
  build(P, p, d) {
    P.frame(d.hub, d.rot, (q) => {
      q.tor(d.R, 0.017, [0, 0, 0], "main", undefined, Math.PI * 2, [10, 36]);
      q.cyl(0.055, 0.05, [0, 0, -0.01], "dark", "z", { seg: 20 });
      const angs = p.spokes === 2 ? [0, 180] : p.spokes === 3 ? [180, 0, 270] : [180, 0, 90, 270];
      for (const ang of angs) q.rod([0, 0, -0.01], [d.R * Math.cos(ang * D2R), d.R * Math.sin(ang * D2R), 0], 0.011, "dark", 8);
      q.cyl(0.03, 0.34, [0, 0, -0.17], "steel", "z", { seg: 12 });
    });
    P.box([0.3, 0.16, 0.12], [0, d.E[1], d.E[2] - 0.04], "dark");
    P.box([0.1, d.E[1] - 0.08, 0.1], [0, (d.E[1] - 0.08) / 2, d.E[2] - 0.04], "steel");
    P.box([0.36, 0.02, 0.3], [0, 0.01, d.E[2] - 0.04], "dark");
  },
  anchors(p, d) {
    const R = d.R;
    return {
      hub: a("Hub, centre", d.hub, d.n), rim_top: a("Rim, 12 o'clock", at(d.hub, d.rot, [0, R, 0])), rim_bottom: a("Rim, 6 o'clock", at(d.hub, d.rot, [0, -R, 0])),
      rim_9: a("Rim, 9 o'clock (driver's left)", at(d.hub, d.rot, [-R, 0, 0])), rim_3: a("Rim, 3 o'clock (driver's right)", at(d.hub, d.rot, [R, 0, 0])),
    };
  },
  grips(p, d) {
    const ax = dirAt(d.rot, [0, 1, 0]);
    return [grip("rim_9", "Left hand, 9 o'clock", "L", at(d.hub, d.rot, [-d.R, 0, 0]), [1, 0, 0], ax, 0.034), grip("rim_3", "Right hand, 3 o'clock", "R", at(d.hub, d.rot, [d.R, 0, 0]), [-1, 0, 0], ax, 0.034)];
  },
});

def({
  type: "joystick", name: "Joystick", category: "Tools and controls", color: "#555c66", yaw: 180, tags: ["controls", "cockpit", "grip"],
  description: "Centre stick on a gaiter with a moulded grip, hat switch and trigger. Set the grip height and the lean towards the user. The user is at +Z.",
  params: [num("height", "Grip centre height", "m", 0.3, 1.1, 0.005, 0.55), num("tilt", "Lean towards the user", "deg", -15, 30, 1, 0)],
  dims(p) { const t = p.tilt * D2R; return { s: [0, Math.cos(t), Math.sin(t)], G: [0, p.height, p.height * Math.tan(t)], rot: [p.tilt, 0, 0] }; },
  build(P, p, d) {
    P.lat([[0.05, 0], [0.07, 0], [0.062, 0.03], [0.035, 0.08], [0.022, 0.1]], [0, 0, 0], "dark", undefined, 20);
    P.rod([0, 0.09, 0], add3(d.G, d.s, -0.07), 0.012, "steel", 10);
    P.frame(d.G, d.rot, (q) => {
      q.lat([[0.001, -0.075], [0.016, -0.075], [0.021, -0.06], [0.024, -0.02], [0.021, 0.03], [0.02, 0.06], [0.015, 0.078], [0.001, 0.08]], [0, 0, 0], "main", undefined, 18);
      q.cyl(0.008, 0.012, [0, 0.082, 0.004], "metal", "y", { seg: 10 });
      q.box([0.01, 0.025, 0.014], [0, 0.03, -0.024], "red");
    });
  },
  anchors: (p, d) => ({ grip_centre: a("Grip, centre", d.G, dirAt(d.rot, [0, 0, 1])), grip_top: a("Grip, top", add3(d.G, d.s, 0.08)), base: a("Base, centre", [0, 0.05, 0]) }),
  grips: (p, d) => [grip("grip", "Stick grip", "both", d.G, dirAt(d.rot, [0, 0, -1]), d.s, 0.042)],
});

def({
  type: "throttle", name: "Throttle lever", category: "Tools and controls", color: "#555c66", yaw: 180, tags: ["controls", "cockpit", "grip"],
  description: "Lever on a quadrant housing with a knob. Set the pivot height, lever length and the angle (positive = pushed forward, away from the user at +Z).",
  params: [num("height", "Pivot height", "m", 0.4, 1.1, 0.005, 0.7), num("length", "Lever length", "m", 0.1, 0.35, 0.005, 0.2), num("angle", "Lever angle from vertical", "deg", -40, 40, 1, 10)],
  dims(p) { const t = p.angle * D2R, l = [0, Math.cos(t), -Math.sin(t)], piv = [0, p.height, 0]; return { l, piv, tip: add3(piv, l, p.length) }; },
  build(P, p, d) {
    P.box([0.1, p.height - 0.01, 0.2], [0, (p.height - 0.01) / 2, 0], "dark");
    P.box([0.12, 0.02, 0.22], [0, p.height + 0.0, 0], "steel");
    P.box([0.02, 0.004, 0.16], [0, p.height + 0.0105, 0], "black");
    P.rod(d.piv, d.tip, 0.008, "steel", 8);
    P.sph(0.024, d.tip, "main", [0.9, 1.3, 0.9], [14, 10]);
  },
  anchors: (p, d) => ({ pivot: a("Lever pivot", d.piv), lever_tip: a("Knob, centre", d.tip) }),
  grips: (p, d) => [grip("knob", "Knob", "both", d.tip, [0, 0, -1], d.l, 0.04)],
});

def({
  type: "pedals", name: "Pedal set", category: "Tools and controls", color: "#8a929b", yaw: 180, tags: ["vehicle", "controls", "foot"],
  description: "Accelerator, brake and optional clutch pedals on a floor mat and firewall. Origin: the accelerator heel point (AHP) on the floor. The driver is at +Z and faces -Z; the accelerator is on the driver's right (+X).",
  source: "Accelerator heel point as in SAE J1100 packaging; pad spacing about 0.13 m between pedal centres.",
  params: [bool("clutch", "Clutch pedal", true), num("angle", "Pedal pad angle from horizontal", "deg", 30, 70, 1, 55)],
  dims(p) { const t = p.angle * D2R, xs = p.clutch ? -0.26 : -0.13; return { t, xs, wm: 0.2 + Math.abs(xs), cx: (xs - 0.1 + 0.1) / 2, dirA: [0, Math.sin(t), -Math.cos(t)], hinge: [0, 0.012, -0.03] }; },
  build(P, p, d) {
    P.box([d.wm, 0.01, 0.42], [d.cx, 0.005, -0.1], "rubber");
    P.box([d.wm, 0.5, 0.04], [d.cx, 0.25, -0.32], "steel");
    P.box([0.075, 0.015, 0.2], add3(d.hinge, d.dirA, 0.1), "main", [p.angle, 0, 0]);
    P.cyl(0.01, 0.08, d.hinge, "steel", "x", { seg: 8 });
    for (const x of p.clutch ? [-0.13, -0.26] : [-0.13]) {
      const pad = [x, 0.15, -0.17];
      P.box([0.1, 0.018, 0.075], pad, "main", [p.angle, 0, 0]);
      P.rod([x, 0.5, -0.3], pad, 0.01, "steel", 8);
    }
  },
  anchors(p, d) {
    const pads = { accel_pad: ["Accelerator pad, centre", add3(d.hinge, d.dirA, 0.12)], brake_pad: ["Brake pad, centre", [-0.13, 0.15, -0.17]], ...(p.clutch ? { clutch_pad: ["Clutch pad, centre", [-0.26, 0.15, -0.17]] } : {}) };
    return { heel_point: a("Accelerator heel point (AHP)", [0, 0.01, 0]), ...Object.fromEntries(Object.entries(pads).map(([k, [l, pos]]) => [k, a(l, pos, [0, Math.cos(d.t), Math.sin(d.t)])])) };
  },
  supports: (p, d) => [support("floor_mat", "Floor mat (heel rest)", 0.01, [d.wm, 0.42], [d.cx, -0.1])],
});

def({
  type: "hammer", name: "Hammer", category: "Tools and controls", color: "#bb9462", tags: ["tool", "hand", "grip"],
  description: "Claw hammer lying on the floor, head towards +Z. The handle is a hand target.",
  params: [num("length", "Overall length", "m", 0.25, 0.45, 0.005, 0.33)],
  build(P, p) {
    const L = p.length, y = 0.0165;
    P.cyl(0.0155, L - 0.03, [0, y, -0.0225], "main", "z", { seg: 14 });
    P.box([0.12, 0.034, 0.034], [0, 0.0175, L / 2 - 0.016], "steel");
    P.cyl(0.0172, 0.026, [0.065, 0.0175, L / 2 - 0.016], "metal", "x", { seg: 14 });
    P.box([0.06, 0.02, 0.03], [-0.085, 0.02, L / 2 - 0.016], "steel", [0, 0, 14]);
    P.box([0.034, 0.028, 0.018], [0, 0.02, L / 2 - 0.016 - 0.0], "steel");
    P.cyl(0.0175, 0.04, [0, 0.0175, -L / 2 + 0.02], "rubber", "z", { seg: 14 });
  },
  anchors: (p) => ({ head: a("Head, centre", [0, 0.0175, p.length / 2 - 0.016]), handle_end: a("Handle end", [0, 0.0165, -p.length / 2]), grip_centre: a("Grip, centre", [0, 0.0165, -p.length * 0.15]) }),
  grips: (p) => [grip("handle", "Handle", "both", [0, 0.0165, -p.length * 0.15], [0, -1, 0], [0, 0, 1], 0.031)],
});

def({
  type: "wrench", name: "Wrench", category: "Tools and controls", color: "#8a929b", tags: ["tool", "hand", "grip"],
  description: "Open-end spanner lying flat on the floor, jaws towards +Z.",
  params: [num("length", "Overall length", "m", 0.15, 0.5, 0.005, 0.28)],
  build(P, p) {
    const L = p.length, rh = clamp(L * 0.09, 0.02, 0.04), zh = L / 2 - rh, nw = rh * 0.8, hw = 0.011;
    P.flat([[-hw, -L / 2 + 0.01], [-0.008, -L / 2], [0.008, -L / 2], [hw, -L / 2 + 0.01], [0.014, zh - rh * 0.6], [rh * 0.95, zh - rh * 0.2], [rh, zh + rh * 0.3], [rh * 0.8, zh + rh * 0.85], [nw / 2 + 0.006, zh + rh * 0.99], [nw / 2, zh + rh * 0.99], [nw / 2, zh + rh * 0.1], [-nw / 2, zh + rh * 0.1], [-nw / 2, zh + rh * 0.99], [-nw / 2 - 0.006, zh + rh * 0.99], [-rh * 0.8, zh + rh * 0.85], [-rh, zh + rh * 0.3], [-rh * 0.95, zh - rh * 0.2], [-0.014, zh - rh * 0.6]], 0.008, 0, "main");
  },
  anchors: (p) => ({ jaw: a("Jaw opening", [0, 0.004, p.length / 2 - 0.01]), handle_end: a("Handle end", [0, 0.004, -p.length / 2]), grip_centre: a("Grip, centre", [0, 0.008, -p.length * 0.12]) }),
  grips: (p) => [grip("handle", "Handle", "both", [0, 0.008, -p.length * 0.12], [0, -1, 0], [0, 0, 1], 0.022)],
});

def({
  type: "screwdriver", name: "Screwdriver", category: "Tools and controls", color: "#dd7b2c", tags: ["tool", "hand", "grip"],
  description: "Screwdriver with a ribbed handle lying on the floor, tip towards +Z.",
  params: [num("length", "Overall length", "m", 0.18, 0.35, 0.005, 0.25)],
  build(P, p) {
    const L = p.length, y = 0.018;
    P.lat([[0.001, 0], [0.012, 0.004], [0.017, 0.02], [0.018, 0.06], [0.015, 0.095], [0.009, 0.1]], [0, y, -L / 2], "main", [90, 0, 0], 16);
    P.cyl(0.0035, L - 0.1, [0, y, -L / 2 + 0.1 + (L - 0.1) / 2], "metal", "z", { seg: 8 });
    P.box([0.0035, 0.0075, 0.014], [0, y, L / 2 - 0.007], "steel");
  },
  anchors: (p) => ({ tip: a("Tip", [0, 0.018, p.length / 2]), handle_end: a("Handle end", [0, 0.018, -p.length / 2]), grip_centre: a("Grip, centre", [0, 0.018, -p.length / 2 + 0.05]) }),
  grips: (p) => [grip("handle", "Handle", "both", [0, 0.018, -p.length / 2 + 0.05], [0, -1, 0], [0, 0, 1], 0.034)],
});

def({
  type: "drill", name: "Power drill", category: "Tools and controls", color: "#3a74b8", tags: ["tool", "hand", "grip"],
  description: "Cordless pistol-grip drill resting on its battery, chuck towards +Z. The pistol grip is a right-hand target.",
  params: [num("length", "Overall length", "m", 0.18, 0.30, 0.005, 0.245)],
  dims: (p) => ({ k: p.length / 0.245 }),
  build(P, p, d) {
    P.frame([0, 0, 0], [0, 0, 0], (q) => {
      q.box([0.05, 0.04, 0.075], [0, 0.02, -0.03], "dark");
      q.box([0.034, 0.1, 0.04], [0, 0.09, -0.035], "dark", [12, 0, 0]);
      q.rbox([0.06, 0.06, 0.13], 0.02, [0, 0.17, 0.0], "main");
      q.cyl(0.03, 0.05, [0, 0.17, -0.06], "dark", "z", { seg: 14 });
      q.cyl(0.015, 0.045, [0, 0.17, 0.0875], "steel", "z", { seg: 12 });
      q.cyl(0.004, 0.05, [0, 0.17, 0.135], "metal", "z", { seg: 6 });
      q.box([0.01, 0.025, 0.014], [0, 0.125, 0.0], "red");
    }, [d.k, d.k, d.k]);
  },
  anchors: (p, d) => ({ chuck: a("Chuck", sc(d.k, [0, 0.17, 0.0875])), bit_tip: a("Bit tip", sc(d.k, [0, 0.17, 0.16])), grip_centre: a("Pistol grip, centre", sc(d.k, [0, 0.095, -0.035])) }),
  grips: (p, d) => [grip("pistol_grip", "Pistol grip", "R", sc(d.k, [0, 0.095, -0.035]), [0, 0, 1], [0, Math.cos(12 * D2R), Math.sin(12 * D2R) * -1], 0.035 * d.k)],
});

def({
  type: "rifle", name: "Rifle / carbine", category: "Tools and controls", color: "#5b6446", tags: ["tool", "military", "grip", "weapon"],
  description: "Generic carbine (default 0.84 m overall) lying on its magazine, muzzle towards +Z. Grip targets: pistol grip (right hand) and handguard (left hand). A visualisation prop only.",
  source: "Overall length 0.84 m as for a typical 5.56 mm carbine with the stock extended; dimensions are generic, not a specific weapon's data.",
  params: [num("length", "Overall length", "m", 0.70, 1.10, 0.005, 0.84)],
  dims: (p) => ({ e: p.length - 0.84, yb: 0.235 }),
  build(P, p, d) {
    const e = d.e, yb = d.yb;
    P.rbox([0.038, 0.05, 0.2], 0.012, [0, yb, 0.03], "main");
    P.rbox([0.034, 0.058, 0.16], 0.012, [0, 0.19, 0.012], "main");
    P.box([0.024, 0.14, 0.07], [0, 0.0745, 0.065], "dark", [-6, 0, 0]);
    P.box([0.03, 0.1, 0.035], [0, 0.105, -0.035], "dark", [21.8, 0, 0]);
    P.box([0.008, 0.007, 0.07], [0, 0.152, 0.005], "dark");
    P.cyl(0.018, 0.22, [0, 0.205, -0.17], "dark", "z", { seg: 12 });
    P.box([0.04, 0.1, 0.16], [0, 0.17, -0.215], "dark");
    P.box([0.036, 0.12, 0.014], [0, 0.17, -0.298], "rubber");
    P.cyl(0.026, 0.28 + e, [0, yb, 0.28 + e / 2], "main", "z", { seg: 16 });
    P.cyl(0.0085, 0.12, [0, yb, 0.46 + e], "steel", "z", { seg: 8 });
    P.cyl(0.013, 0.05, [0, yb, 0.515 + e], "black", "z", { seg: 10 });
    P.box([0.012, 0.03, 0.12], [0, 0.28, 0.03], "dark");
    P.box([0.006, 0.05, 0.008], [0, 0.275, 0.45 + e], "dark");
    P.box([0.02, 0.025, 0.02], [0, yb, 0.43 + e], "dark");
  },
  anchors: (p, d) => ({ muzzle: a("Muzzle", [0, d.yb, 0.54 + d.e]), stock_butt: a("Stock butt plate", [0, 0.17, -0.3]), pistol_grip: a("Pistol grip, centre", [0, 0.105, -0.035]), handguard: a("Handguard, middle", [0, d.yb, 0.28 + d.e / 2]), rear_sight: a("Rear sight", [0, 0.295, 0.03]), magazine_bottom: a("Magazine bottom", [0, 0, 0.065]) }),
  grips: (p, d) => [
    grip("pistol_grip", "Pistol grip (right hand)", "R", [0, 0.105, -0.035], [0, 0, 1], [0, Math.cos(21.8 * D2R), Math.sin(21.8 * D2R)], 0.032),
    grip("handguard", "Handguard (left hand)", "L", [0, d.yb, 0.28 + d.e / 2], [0, 1, 0], [0, 0, 1], 0.052),
  ],
});

def({
  type: "pistol", name: "Pistol", category: "Tools and controls", color: "#3f4349", tags: ["tool", "military", "grip", "weapon"],
  description: "Generic semi-automatic pistol standing on the base of its magazine. The grip is a right-hand target. A visualisation prop only.",
  params: [num("length", "Overall length", "m", 0.16, 0.26, 0.005, 0.2)],
  dims: (p) => ({ k: p.length / 0.2 }),
  build(P, p, d) {
    P.frame([0, 0, 0], [0, 0, 0], (q) => {
      q.rbox([0.03, 0.036, 0.19], 0.008, [0, 0.135, 0.0], "main");
      q.box([0.026, 0.018, 0.15], [0, 0.11, 0.0], "dark");
      q.box([0.03, 0.115, 0.05], [0, 0.0625, -0.05], "dark", [-15, 0, 0]);
      q.box([0.012, 0.006, 0.05], [0, 0.098, 0.032], "dark");
      q.box([0.006, 0.018, 0.008], [0, 0.092, 0.016], "metal");
      q.cyl(0.005, 0.014, [0, 0.135, 0.1], "steel", "z", { seg: 8 });
      q.box([0.004, 0.008, 0.01], [0, 0.156, 0.085], "black");
    }, [d.k, d.k, d.k]);
  },
  anchors: (p, d) => ({ muzzle: a("Muzzle", sc(d.k, [0, 0.135, 0.107])), grip_centre: a("Grip, centre", sc(d.k, [0, 0.06, -0.05])), trigger: a("Trigger", sc(d.k, [0, 0.092, 0.016])) }),
  grips: (p, d) => [grip("grip", "Grip (right hand)", "R", sc(d.k, [0, 0.06, -0.05]), [0, 0, 1], [0, Math.cos(15 * D2R), -Math.sin(15 * D2R)], 0.032 * d.k)],
});

def({
  type: "binoculars", name: "Binoculars", category: "Tools and controls", color: "#3f4349", tags: ["tool", "optics", "grip"],
  description: "Field binoculars lying on the floor, objectives towards +Z. Grip targets on each barrel; anchors at the eyepieces for eye-relief checks.",
  params: [num("length", "Length", "m", 0.10, 0.20, 0.005, 0.15)],
  dims: (p) => ({ k: p.length / 0.15 }),
  build(P, p, d) {
    P.frame([0, 0, 0], [0, 0, 0], (q) => {
      for (const s of [-1, 1]) {
        q.cyl(0.026, 0.12, [s * 0.0345, 0.026, 0.04], "main", "z", { seg: 18 });
        q.cyl(0.0265, 0.012, [s * 0.0345, 0.026, 0.1], "steel", "z", { seg: 18 });
        q.cyl(0.0185, 0.045, [s * 0.0345, 0.026, -0.0425], "dark", "z", { seg: 14 });
        q.cyl(0.021, 0.008, [s * 0.0345, 0.026, -0.066], "rubber", "z", { seg: 14 });
      }
      q.cyl(0.008, 0.07, [0, 0.026, 0.02], "steel", "z", { seg: 8 });
      q.cyl(0.011, 0.02, [0, 0.05, 0.0], "dark", "z", { seg: 10 });
    }, [d.k, d.k, d.k]);
  },
  anchors: (p, d) => ({ eyepiece_left: a("Left eyepiece (+X)", sc(d.k, [0.0345, 0.026, -0.07])), eyepiece_right: a("Right eyepiece (-X)", sc(d.k, [-0.0345, 0.026, -0.07])), objective_left: a("Left objective (+X)", sc(d.k, [0.0345, 0.026, 0.106])), objective_right: a("Right objective (-X)", sc(d.k, [-0.0345, 0.026, 0.106])), centre: a("Centre of the pair", sc(d.k, [0, 0.026, 0.03])) }),
  grips: (p, d) => [grip("barrel_left", "Left barrel", "L", sc(d.k, [0.0345, 0.026, 0.035]), [-1, 0, 0], [0, 0, 1], 0.052 * d.k), grip("barrel_right", "Right barrel", "R", sc(d.k, [-0.0345, 0.026, 0.035]), [1, 0, 0], [0, 0, 1], 0.052 * d.k)],
});

def({
  type: "radio_handset", name: "Radio handset", category: "Tools and controls", color: "#6f7a50", tags: ["tool", "comms", "grip"],
  description: "Field handset with an ear cup, a mouthpiece and a press-to-talk bar, lying on the floor with the cups up.",
  params: [num("length", "Overall length", "m", 0.15, 0.25, 0.005, 0.2)],
  dims: (p) => ({ k: p.length / 0.2 }),
  build(P, p, d) {
    P.frame([0, 0, 0], [0, 0, 0], (q) => {
      q.rbox([0.036, 0.026, 0.12], 0.012, [0, 0.013, 0], "main");
      q.cyl(0.03, 0.034, [0, 0.017, -0.085], "dark", "y", { seg: 18 });
      q.cyl(0.026, 0.034, [0, 0.017, 0.085], "dark", "y", { seg: 18 });
      q.box([0.012, 0.01, 0.05], [0.015, 0.03, 0.0], "red");
    }, [d.k, d.k, d.k]);
  },
  anchors: (p, d) => ({ ear_cup: a("Ear cup, centre", sc(d.k, [0, 0.034, -0.085])), mouthpiece: a("Mouthpiece, centre", sc(d.k, [0, 0.034, 0.085])), grip_centre: a("Grip, centre", sc(d.k, [0, 0.026, 0])) }),
  grips: (p, d) => [grip("handle", "Handle", "both", sc(d.k, [0, 0.026, 0]), [0, -1, 0], [0, 0, 1], 0.036 * d.k)],
});

def({
  type: "shovel", name: "Shovel", category: "Tools and controls", color: "#bb9462", tags: ["tool", "hand", "grip"],
  description: "Long-handled shovel with a D handle lying on the floor, blade towards +Z. Grip targets: the shaft and the D handle.",
  params: [num("length", "Overall length", "m", 0.5, 1.4, 0.01, 1.15)],
  dims(p) { const z1 = p.length / 2 - 0.28, z2 = -p.length / 2 + 0.08; return { z1, z2, p1: [0, 0.03, z1], p2: [0, 0.12, z2] }; },
  build(P, p, d) {
    P.box([0.2, 0.004, 0.27], [0, 0.002, p.length / 2 - 0.135], "steel");
    P.box([0.2, 0.03, 0.004], [0, 0.015, p.length / 2 - 0.002], "steel");
    P.rod(d.p1, d.p2, 0.016, "main", 10);
    P.cyl(0.013, 0.13, d.p2, "main", "x", { seg: 10 });
    P.tor(0.065, 0.012, d.p2, "main", [0, 0, 0], Math.PI, [8, 18]);
  },
  anchors: (p, d) => ({ blade_tip: a("Blade tip", [0, 0.004, p.length / 2]), handle_top: a("D handle, top", add3(d.p2, [0, 1, 0], 0.065)), shaft_mid: a("Shaft, middle", [(d.p1[0] + d.p2[0]) / 2, (d.p1[1] + d.p2[1]) / 2, (d.p1[2] + d.p2[2]) / 2]) }),
  grips(p, d) {
    const m = [0, 0.075, d.z2 * 0.4 + d.z1 * 0.6 * 0.4 + d.z2 * 0.0];
    return [grip("shaft", "Shaft", "both", [0, d.p1[1] + (d.p2[1] - d.p1[1]) * 0.55, d.z1 + (d.z2 - d.z1) * 0.55], [0, -1, 0], unit([0, d.p2[1] - d.p1[1], d.z2 - d.z1]), 0.032), grip("d_handle", "D handle", "R", d.p2, [0, -1, 0], [1, 0, 0], 0.026)];
  },
});

def({
  type: "grab_handle", name: "Vertical grab handle", category: "Tools and controls", color: "#8a929b", tags: ["grip", "vehicle", "structure"],
  description: "Wall-mounted vertical grab handle with two stand-off brackets and a backing plate. Place it against a wall; the user is at +Z. Three grip targets along the bar.",
  source: "Graspable bar diameter about 25 to 50 mm with 40 to 100 mm clearance to the wall (MIL-STD-1472, ISO 9241 and building codes give similar ranges); check the current revision for compliance work.",
  params: [num("length", "Handle length", "m", 0.15, 2.0, 0.01, 0.4), num("diameter", "Bar diameter", "m", 0.025, 0.05, 0.001, 0.032), num("standoff", "Clearance to the wall", "m", 0.04, 0.1, 0.005, 0.06), num("centreHeight", "Centre height", "m", 0.5, 2.0, 0.01, 1.2)],
  dims: (p) => ({ cH: Math.max(p.centreHeight, p.length / 2 + 0.05) }),
  build(P, p, d) {
    P.cyl(p.diameter / 2, p.length, [0, d.cH, 0], "main", "y", { seg: 16 });
    P.box([0.05, p.length + 0.06, 0.012], [0, d.cH, -p.standoff - 0.006], "dark");
    for (const s of [-1, 1]) P.rod([0, d.cH + s * (p.length / 2 - 0.03), -p.standoff], [0, d.cH + s * (p.length / 2 - 0.03), 0], 0.009, "steel", 8);
  },
  anchors: (p, d) => ({ centre: a("Handle, centre", [0, d.cH, 0]), top: a("Handle, top", [0, d.cH + p.length / 2, 0]), bottom: a("Handle, bottom", [0, d.cH - p.length / 2, 0]) }),
  grips: (p, d) => [-1, 0, 1].map((k) => grip(["low", "mid", "high"][k + 1], ["Low grip", "Middle grip", "High grip"][k + 1], "both", [0, d.cH + (k * p.length) / 3, 0], [0, 0, -1], [0, 1, 0], p.diameter)),
});

def({
  type: "horizontal_bar", name: "Horizontal bar", category: "Tools and controls", color: "#8a929b", tags: ["grip", "structure", "exercise"],
  description: "Free-standing horizontal bar (pull-up bar or grab rail) on two posts. Grip targets at shoulder width. The user stands at +Z facing the bar.",
  params: [num("length", "Bar length", "m", 0.4, 2.0, 0.01, 1.0), num("height", "Bar height", "m", 1.0, 2.6, 0.01, 2.0), num("diameter", "Bar diameter", "m", 0.025, 0.04, 0.001, 0.032)],
  build(P, p) {
    P.cyl(p.diameter / 2, p.length, [0, p.height, 0], "metal", "x", { seg: 16 });
    for (const s of [-1, 1]) {
      P.cyl(0.025, p.height, [s * (p.length / 2 + 0.025), p.height / 2, 0], "main", "y", { seg: 12 });
      P.box([0.2, 0.015, 0.4], [s * (p.length / 2 + 0.025), 0.0075, 0], "dark");
      P.sph(0.03, [s * (p.length / 2 + 0.025), p.height, 0], "main", [1, 1, 1], [10, 8]);
    }
  },
  anchors: (p) => ({ bar_centre: a("Bar, centre", [0, p.height, 0]), bar_left: a("Bar end (+X)", [p.length / 2, p.height, 0]), bar_right: a("Bar end (-X)", [-p.length / 2, p.height, 0]) }),
  grips(p) {
    const x = Math.min(0.22, p.length / 2 - 0.03);
    return [grip("left", "Left hand (the user's left is -X)", "L", [-x, p.height, 0], [0, 0, -1], [1, 0, 0], p.diameter), grip("right", "Right hand", "R", [x, p.height, 0], [0, 0, -1], [1, 0, 0], p.diameter)];
  },
});

def({
  type: "lever", name: "Hand lever", category: "Tools and controls", color: "#555c66", yaw: 180, tags: ["controls", "grip"],
  description: "Floor-mounted hand lever (brake, gear or control lever) with a knob. Positive angle pushes it forward, away from the user at +Z.",
  params: [num("length", "Lever length", "m", 0.15, 0.8, 0.01, 0.4), num("angle", "Angle from vertical", "deg", -60, 60, 1, 20), num("height", "Pivot height", "m", 0.2, 1.2, 0.01, 0.5)],
  dims(p) { const t = p.angle * D2R, l = [0, Math.cos(t), -Math.sin(t)], piv = [0, p.height, 0]; return { l, piv, tip: add3(piv, l, p.length) }; },
  build(P, p, d) {
    P.box([0.08, p.height, 0.14], [0, p.height / 2, 0], "dark");
    P.cyl(0.02, 0.12, d.piv, "steel", "x", { seg: 12 });
    P.rod(d.piv, d.tip, 0.01, "steel", 8);
    P.sph(0.022, d.tip, "red", [1, 1.3, 1], [12, 10]);
  },
  anchors: (p, d) => ({ pivot: a("Pivot", d.piv), knob: a("Knob, centre", d.tip) }),
  grips: (p, d) => [grip("knob", "Knob", "both", d.tip, [0, 0, -1], d.l, 0.044)],
});

def({
  type: "keyboard_mouse", name: "Keyboard and mouse", category: "Tools and controls", color: "#555c66", yaw: 180, tags: ["computer", "workstation"],
  description: "Keyboard with a mouse on its right (+X, the user's right), lying on the floor or desk. Hand targets for typing and mousing. The user is at +Z.",
  source: "Keyboard about 0.44 x 0.14 m, key pitch 19 mm.",
  params: [num("width", "Keyboard width", "m", 0.30, 0.46, 0.005, 0.44)],
  dims(p) { return { cols: Math.floor((p.width - 0.03) / 0.0185), xm: p.width / 2 + 0.07 }; },
  build(P, p, d) {
    P.rbox([p.width, 0.022, 0.14], 0.008, [0, 0.011, 0], "main");
    const kw = (p.width - 0.03) / d.cols;
    for (let r = 0; r < 5; r++) {
      const z = (r - 2) * 0.0195 - 0.008;
      if (r === 4) { P.box([kw * d.cols * 0.5, 0.006, 0.0165], [0, 0.025, z], "white"); continue; }
      for (let c = 0; c < d.cols; c++) P.box([kw * 0.86, 0.006, 0.0165], [-(p.width - 0.03) / 2 + kw * (c + 0.5), 0.025, z], "white");
    }
    P.rbox([0.06, 0.03, 0.105], 0.02, [d.xm, 0.015, 0], "dark");
    P.box([0.002, 0.004, 0.04], [d.xm, 0.031, -0.025], "white");
  },
  anchors: (p, d) => ({ keyboard_centre: a("Keyboard, centre", [0, 0.028, -0.008]), home_row: a("Home row", [0, 0.028, 0.011]), mouse: a("Mouse, top", [d.xm, 0.03, 0]), user_edge: a("Keyboard edge towards the user", [0, 0.022, 0.07]) }),
  grips: (p, d) => [
    grip("home_left", "Left hand, home row", "L", [-0.075, 0.028, 0.012], [0, -1, 0], [1, 0, 0], 0),
    grip("home_right", "Right hand, home row", "R", [0.075, 0.028, 0.012], [0, -1, 0], [1, 0, 0], 0),
    grip("mouse", "Right hand, mouse", "R", [d.xm, 0.03, 0], [0, -1, 0], [0, 0, 1], 0),
  ],
});

def({
  type: "flashlight", name: "Flashlight", category: "Tools and controls", color: "#dcae2e", tags: ["tool", "hand", "grip"],
  description: "Torch lying on the floor, lens towards +Z.",
  params: [num("length", "Length", "m", 0.10, 0.30, 0.005, 0.16), num("diameter", "Body diameter", "m", 0.03, 0.05, 0.001, 0.04)],
  build(P, p) {
    const L = p.length, r = p.diameter / 2, rh = r * 1.35, y = rh, hl = 0.045;
    P.cyl(r, L - hl, [0, y, -hl / 2], "main", "z", { seg: 18 });
    P.cyl(rh, hl, [0, y, L / 2 - hl / 2], "steel", "z", { seg: 18, r2: r * 1.05 });
    P.cyl(rh * 0.82, 0.002, [0, y, L / 2 + 0.001], "white", "z", { seg: 18 });
    P.cyl(r * 1.05, 0.012, [0, y, -L / 2 + 0.006], "dark", "z", { seg: 18 });
    P.box([0.012, 0.008, 0.02], [0, y + r + 0.002, -L / 2 + 0.05], "red");
  },
  anchors: (p) => ({ lens: a("Lens, centre", [0, p.diameter * 0.675, p.length / 2]), tail: a("Tail cap", [0, p.diameter * 0.675, -p.length / 2]), grip_centre: a("Grip, centre", [0, p.diameter * 0.675, -p.length * 0.1]) }),
  grips: (p) => [grip("body", "Body", "both", [0, p.diameter * 0.675, -p.length * 0.1], [0, -1, 0], [0, 0, 1], p.diameter)],
});

// =====================================================================================================================
// REFERENCE
// =====================================================================================================================
def({
  type: "cube_1m", name: "1 m cube", category: "Reference", color: "#3a74b8", scaleMap: { x: "size", y: "size", z: "size" }, tags: ["reference", "scale"],
  description: "A translucent cube with dark edges, 1 m on a side by default, for judging sizes and clearances.",
  params: [num("size", "Edge length", "m", 0.1, 2, 0.01, 1)],
  build(P, p) {
    const s = p.size, e = Math.min(0.012, s * 0.05);
    P.box([s, s, s], [0, s / 2, 0], "mainT");
    for (const y of [e / 2, s - e / 2]) { for (const sz of [-1, 1]) P.box([s, e, e], [0, y, sz * (s / 2 - e / 2)], "dark"); for (const sx of [-1, 1]) P.box([e, e, s - 2 * e], [sx * (s / 2 - e / 2), y, 0], "dark"); }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P.box([e, s - 2 * e, e], [sx * (s / 2 - e / 2), s / 2, sz * (s / 2 - e / 2)], "dark");
  },
  anchors: (p) => ({ ...boxAnchors(p.size, p.size, p.size), base_corner_fl: a("Base corner, front left (+X)", [p.size / 2, 0, p.size / 2]), base_corner_fr: a("Base corner, front right (-X)", [-p.size / 2, 0, p.size / 2]), centre: a("Cube centre", [0, p.size / 2, 0]) }),
  supports: (p) => [support("top", "Top", p.size, [p.size, p.size], [0, 0])],
});

def({
  type: "measuring_pole", name: "Measuring pole", category: "Reference", color: "#dcae2e", tags: ["reference", "measure", "stature"],
  description: "Stadiometer: a graduated pole with a sliding head board. Subjects stand at +Z against the pole; set the head board height to read stature.",
  source: "Anthropometer / stadiometer layout (ISO 7250-1 measuring conventions); graduations every 0.1 m.",
  params: [num("height", "Pole height", "m", 1.0, 2.5, 0.05, 2.1), num("headboard", "Head board height", "m", 0.8, 2.4, 0.005, 1.75)],
  dims: (p) => ({ hb: Math.min(p.headboard, p.height - 0.05) }),
  build(P, p, d) {
    P.box([0.32, 0.02, 0.36], [0, 0.01, 0.1], "dark");
    P.box([0.045, p.height, 0.02], [0, p.height / 2, 0], "white");
    for (let y = 0.1; y < p.height; y += 0.1) { const major = Math.round(y * 10) % 5 === 0; P.box([major ? 0.04 : 0.025, 0.004, 0.004], [0, y, 0.0105], "dark"); }
    P.box([0.07, 0.07, 0.045], [0, d.hb + 0.045, 0.03], "dark");
    P.box([0.2, 0.01, 0.14], [0, d.hb + 0.005, 0.1], "main");
  },
  anchors: (p, d) => ({ headboard: a("Head board, underside", [0, d.hb, 0.1]), pole_top: a("Pole, top", [0, p.height, 0]), base: a("Base, centre", [0, 0.02, 0.1]) }),
  supports: () => [],
});

def({
  type: "point_marker", name: "Point marker", category: "Reference", color: "#c0493d", tags: ["reference", "measure"],
  description: "A small sphere at a chosen height on a thin stalk, to mark a point in space.",
  params: [num("radius", "Marker radius", "m", 0.005, 0.1, 0.001, 0.02), num("height", "Height above the floor", "m", 0, 3, 0.005, 1.0)],
  dims: (p) => ({ h: Math.max(p.height, p.radius) }),
  build(P, p, d) {
    P.sph(p.radius, [0, d.h, 0], "main", [1, 1, 1], [16, 12]);
    if (d.h - p.radius > 0.01) P.cyl(0.0015, d.h - p.radius, [0, (d.h - p.radius) / 2, 0], "steel", "y", { seg: 6 });
    P.tor(0.03, 0.002, [0, 0.002, 0], "steel", [90, 0, 0], Math.PI * 2, [4, 20]);
  },
  anchors: (p, d) => ({ point: a("Marker point", [0, d.h, 0]) }),
});

def({
  type: "box", name: "Box", category: "Reference", color: "#8a929b", scaleMap: SCALE_WDH, tags: ["reference", "free size"],
  description: "A plain box with free width, depth and height. Drag the resize handles in the 3D view or type exact sizes.",
  params: dimParams(0.5, 0.5, 0.5, 0.01, 10),
  build(P, p) { P.box([p.width, p.height, p.depth], [0, p.height / 2, 0], "main"); },
  anchors: (p) => ({ ...boxAnchors(p.width, p.depth, p.height), centre: a("Box centre", [0, p.height / 2, 0]) }),
  supports: (p) => [support("top", "Top", p.height, [p.width, p.depth], [0, 0])],
});

def({
  type: "cylinder", name: "Cylinder", category: "Reference", color: "#8a929b", scaleMap: { x: "diameter", y: "height", z: "diameter" }, tags: ["reference", "free size"],
  description: "A plain upright cylinder with free diameter and height.",
  params: [num("diameter", "Diameter", "m", 0.02, 5, 0.005, 0.4), num("height", "Height", "m", 0.01, 5, 0.005, 0.6)],
  build(P, p) { P.cyl(p.diameter / 2, p.height, [0, p.height / 2, 0], "main", "y", { seg: 32 }); },
  anchors: (p) => ({ top_centre: a("Top, centre", [0, p.height, 0]), base_centre: a("Base, centre", [0, 0, 0]), top_front: a("Top rim, front", [0, p.height, p.diameter / 2]), top_back: a("Top rim, back", [0, p.height, -p.diameter / 2]), centre: a("Cylinder centre", [0, p.height / 2, 0]) }),
  supports: (p) => [support("top", "Top", p.height, [p.diameter, p.diameter], [0, 0])],
});

def({
  type: "floor_tile", name: "Floor tile", category: "Reference", color: "#c9b98a", scaleMap: { x: "size", y: "thickness", z: "size" }, tags: ["reference", "floor"],
  description: "A flat square tile or mat, for marking a spot on the floor.",
  params: [num("size", "Side length", "m", 0.2, 3, 0.01, 0.6), num("thickness", "Thickness", "m", 0.005, 0.1, 0.005, 0.02)],
  build(P, p) {
    P.box([p.size, p.thickness, p.size], [0, p.thickness / 2, 0], "main");
    const b = Math.min(0.03, p.size * 0.1);
    P.box([p.size - 2 * b, 0.001, p.size - 2 * b], [0, p.thickness + 0.0005, 0], "white");
  },
  anchors: (p) => ({ centre: a("Tile, centre", [0, p.thickness, 0]), corner_fl: a("Corner, front left (+X)", [p.size / 2, p.thickness, p.size / 2]), corner_fr: a("Corner, front right (-X)", [-p.size / 2, p.thickness, p.size / 2]), corner_bl: a("Corner, back left (+X)", [p.size / 2, p.thickness, -p.size / 2]), corner_br: a("Corner, back right (-X)", [-p.size / 2, p.thickness, -p.size / 2]) }),
  supports: (p) => [support("top", "Tile top", p.thickness, [p.size, p.size], [0, 0])],
});

// =====================================================================================================================
// public API
// =====================================================================================================================
export const CATALOG = Object.freeze([...REGISTRY]);
const CATEGORY_ORDER = ["Seating", "Displays", "Boxes and loads", "Structures", "Tools and controls", "Reference"];
export const CATEGORIES = Object.freeze(CATEGORY_ORDER.map((name) => Object.freeze({ id: name.toLowerCase().replace(/[^a-z]+/g, "-"), name, types: Object.freeze(REGISTRY.filter((t) => t.category === name).map((t) => t.type)) })));

/** The catalogue entry of a type, or null. */
export const byType = (type) => (typeof type === "string" && BY_TYPE.has(type) ? BY_TYPE.get(type) : null);
/** Default (already complete) parameters of a type. */
export function defaultParams(type) { const t = byType(type); if (!t) throw new Error(`unknown object type "${type}"`); return clampParams(t, {}); }
/** Complete and clamp `params` for `type` (throws for an unknown type). */
export function normalizeParams(type, params) { const t = byType(type); if (!t) throw new Error(`unknown object type "${type}"`); return clampParams(t, params); }
/** Build the THREE.Group of a type. opts.color: hex string for the main material. The group's userData holds `bbox` (local Box3) and `own` (materials to dispose). */
export function buildObject(type, params, opts = {}) { const t = byType(type); if (!t) throw new Error(`unknown object type "${type}"`); return t.build(params, opts); }
/** Free the geometry and the owned materials of a built group (shared palette materials are left alone). */
export function disposeObject(root) {
  root?.traverse?.((o) => {
    o.geometry?.dispose?.();
    for (const m of [].concat(o.material ?? [])) if (m && !m.userData?.shared) m.dispose();
  });
}
/** Does a type's parameter list carry a mass (shown in its label)? */
export const hasMass = (type) => !!byType(type)?.hasMass;
