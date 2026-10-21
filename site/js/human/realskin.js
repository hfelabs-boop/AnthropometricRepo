// Realistic skin: the Blender Studio "Human Base Meshes" (v1.4.1, CC0; male and female realistic bodies) rigged to the 77 joints of skeleton.js
// and fitted, at build time of every rig, to the BodyModel of fit.js. Same contract as body.js: buildRealSkin(body, bones, { quality, color })
// -> { mesh, eyes, dispose(), stats }. Pure three.js, never touches the DOM; the mesh data are loaded once by loadRealSkin() (fetch).
//
// The assets (site/assets/human/skin-M.bin, skin-F.bin and their .json manifests) are made by scripts/human_skin: the mesh is scaled to the
// stature of a template body (US Army 50th percentile of that sex), rigged in Blender (bone heat weights on the 77 joints, the A-pose
// arms and the legs turned to the neutral pose of the template, with volume-preserving skinning) and its cross-sections are measured at the
// heights of the template's shape rings. The manifest holds those sections, the template joint centres and measures; the binary holds the
// vertices in the neutral pose, the triangles, four skin weights per vertex and up to two fitting regions per vertex.
//
// Fitting a body (fitVertices). Every vertex belongs to one or two regions (weights smoothed over the surface, so that regions blend):
//   tubes  torso, neck, upper arm, forearm, thigh, shank: the horizontal section through the vertex is interpolated between the measured
//          sections of the mesh (centre cx, cz and half extents rx, rz at each ring height) and the vertex is written as a position relative
//          to it, ((x - cx) / rx, (z - cz) / rz); the same section of the body (its fit.js rings, same ids, same interpolation) gives the new
//          position. At the ring heights the skin then has the fitted centre and breadth / depth of the body; between them it keeps the shape
//          of the mesh, scaled. Heights map piecewise linearly from ring to ring.
//   head   scaled about the head joint by the body's head breadth, height and length relative to the template's (the face keeps its proportions).
//   hands  scaled about the wrist in the hand's own frame (length along the hand, breadth across the knuckles) to the body's hand length and
//          breadth, and turned to the body's hand direction.
//   feet   scaled about the ankle to the body's foot length, ball breadth and ankle height (the sole stays on the floor), and turned like the foot.
// Skinning: linear blend, at most 4 joints per vertex, bound in the neutral pose with translate(-joint centre) inverse bind matrices (as body.js).
// Joints that carry no skin: jaw, eye_L / eye_R (the eyeballs follow the head), forearm_* (the forearm follows the elbow and the wrist).
import * as THREE from "three";
import { JOINTS } from "./skeleton.js";

export const TUBES = Object.freeze(["torso", "neck", "upper_arm_L", "upper_arm_R", "forearm_L", "forearm_R", "thigh_L", "thigh_R", "shank_L", "shank_R"]);
export const RIGID = Object.freeze(["head", "hand_L", "hand_R", "foot_L", "foot_R"]);
/** Fitting regions, in the order of the region ids stored in the assets. */
export const REGIONS = Object.freeze([...TUBES, ...RIGID]);

/** The fitting region of a joint's skin. */
export function regionOfJoint(id) {
  const s = id.endsWith("_L") ? "L" : id.endsWith("_R") ? "R" : "";
  if (id === "pelvis" || /^[LT]\d+$/.test(id) || id.startsWith("clavicle")) return "torso";
  if (/^C\d$/.test(id)) return "neck";
  if (id === "head" || id === "jaw" || id.startsWith("eye")) return "head";
  if (id.startsWith("shoulder")) return `upper_arm_${s}`;
  if (id.startsWith("elbow") || id.startsWith("forearm")) return `forearm_${s}`;
  if (id.startsWith("hip")) return `thigh_${s}`;
  if (id.startsWith("knee")) return `shank_${s}`;
  if (id.startsWith("ankle") || id.startsWith("mtp")) return `foot_${s}`;
  return `hand_${s}`; // wrist and fingers
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Rest (neutral) world position of a landmark of a BodyModel. */
export function landmarkRest(body, id) {
  const l = body.landmarks[id];
  if (!l) throw new Error(`the body has no landmark "${id}"`);
  const p = body.positions[l.joint];
  return [p[0] + l.offset[0], p[1] + l.offset[1], p[2] + l.offset[2]];
}

/** The measures the rigid regions are scaled by (metres): head breadth / length / height, hand length / breadth, foot length / breadth. */
export function bodyDims(body) {
  const L = (id) => landmarkRest(body, id);
  const out = {
    head: {
      breadth: L("euryon_L")[0] - L("euryon_R")[0],
      length: L("glabella")[2] - L("opisthocranion")[2],
      height: L("vertex")[1] - L("menton")[1],
    },
  };
  for (const s of ["L", "R"]) {
    out[`hand_${s}`] = { length: len(sub(L(`dactylion_${s}`), body.positions[`wrist_${s}`])), breadth: len(sub(L(`metacarpale_radiale_${s}`), L(`metacarpale_ulnare_${s}`))) };
    out[`foot_${s}`] = { length: L(`toe_tip_${s}`)[2] - L(`heel_${s}`)[2], breadth: len(sub(L(`metatarsale_tibiale_${s}`), L(`metatarsale_fibulare_${s}`))), ankle: body.positions[`ankle_${s}`][1] };
  }
  return out;
}

/** The horizontal sections of a body's tubes: { tube: [{ id, y, cx, cz, rx, rz }] } (fit.js shape rings). */
export function tubeStations(body) {
  const out = {};
  for (const t of TUBES) {
    const tube = body.shape?.tubes?.[t];
    out[t] = tube ? tube.rings.map((r) => ({ id: r.id, y: r.c[1], cx: r.c[0], cz: r.c[2], rx: r.rx, rz: r.rz })) : [];
  }
  return out;
}

// ---- assets ---------------------------------------------------------------------------------------------------------------------------------
/** The asset a body is dressed in: the female mesh for a female form (formFactor below 0.5), the male mesh otherwise. */
export const skinSexOf = (body) => (body?.form === "female" || (typeof body?.formFactor === "number" && body.formFactor < 0.5) ? "F" : "M");

const TYPED = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array };

/** Decode a manifest and its binary (an ArrayBuffer) into the arrays fitVertices and buildRealSkin read. */
export function decodeAsset(manifest, buffer) {
  if (!manifest || manifest.version !== 1) throw new Error("realskin: unsupported asset manifest");
  const view = (name) => {
    const l = manifest.layout[name];
    if (!l) throw new Error(`realskin: the asset lacks "${name}"`);
    const C = TYPED[l.type];
    if (!C || l.offset + l.length * C.BYTES_PER_ELEMENT > buffer.byteLength) throw new Error(`realskin: "${name}" does not fit the binary`);
    return new C(buffer, l.offset, l.length);
  };
  const { origin, step } = manifest.quant;
  const dequant = (q) => {
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i += 3) for (let k = 0; k < 3; k++) out[i + k] = origin[k] + q[i + k] * step[k];
    return out;
  };
  const n = manifest.vertices;
  const asset = {
    manifest, sex: manifest.sex,
    position: dequant(view("position")), index: view("index"),
    skinIndex: view("skinIndex"), skinWeight: view("skinWeight"),
    region: view("region"), regionWeight: view("regionWeight"),
    eyes: ["L", "R"].map((s) => ({ position: dequant(view(`eye${s}Position`)), index: view(`eye${s}Index`) })),
  };
  if (asset.position.length !== n * 3 || asset.skinIndex.length !== n * 4 || asset.region.length !== n * 2) throw new Error("realskin: the asset's arrays disagree on the vertex count");
  return asset;
}

const loading = new Map();
/** Fetch and decode the asset of one sex ("M" | "F") once; later calls share the promise (a failed load is forgotten so that it can be retried). */
export function loadRealSkin(sex, base = new URL("../../assets/human/", import.meta.url)) {
  const key = `${base}|${sex}`;
  if (!loading.has(key)) {
    const p = (async () => {
      const get = async (name, kind) => {
        const r = await fetch(new URL(name, base));
        if (!r.ok) throw new Error(`realskin: ${name}: HTTP ${r.status}`);
        return kind === "json" ? r.json() : r.arrayBuffer();
      };
      const [manifest, buffer] = await Promise.all([get(`skin-${sex}.json`, "json"), get(`skin-${sex}.bin`, "bin")]);
      return decodeAsset(manifest, buffer);
    })();
    p.catch(() => loading.delete(key));
    loading.set(key, p);
  }
  return loading.get(key);
}

// ---- fitting ----------------------------------------------------------------------------------------------------------------------------------
const unit3 = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A hand frame from the joint centres: a along the hand (wrist -> middle knuckle), b across it toward the index, c = a x b. */
function handFrame(P, s) {
  const a = unit3(sub(P[`middle_mcp_${s}`], P[`wrist_${s}`]));
  const w = sub(P[`index_mcp_${s}`], P[`little_mcp_${s}`]);
  const b = unit3(sub(w, a.map((x) => x * dot(w, a))));
  return { o: P[`wrist_${s}`], a, b, c: cross(a, b) };
}
/** A foot frame: u along the foot (ankle -> ball, horizontal), up, lat = up x u. */
function footFrame(P, s) {
  const d = sub(P[`mtp_${s}`], P[`ankle_${s}`]);
  const u = unit3([d[0], 0, d[2]]);
  return { o: P[`ankle_${s}`], a: u, b: [0, 1, 0], c: cross([0, 1, 0], u) };
}

/** The joints each tube follows, from one end to the other. */
export const CHAINS = Object.freeze({
  torso: ["pelvis", "L3", "L1", "T10", "T6", "T3", "T1", "C7", "C4", "C1"],
  ...Object.fromEntries(["L", "R"].flatMap((s) => [
    [`upper_arm_${s}`, [`shoulder_${s}`, `elbow_${s}`]], [`forearm_${s}`, [`elbow_${s}`, `wrist_${s}`]],
    [`thigh_${s}`, [`hip_${s}`, `knee_${s}`]], [`shank_${s}`, [`knee_${s}`, `ankle_${s}`]],
  ])),
});

/** A chain of joint centres as a function of height: coord(y) -> s (segment index + fraction, extrapolated past the ends), at(s) -> point. */
function chainOf(P, ids) {
  const pts = ids.map((id) => P[id]);
  const n = pts.length;
  const coord = (y) => {
    let k = 0;
    const up = pts[n - 1][1] > pts[0][1];
    while (k < n - 2 && (up ? y > pts[k + 1][1] : y < pts[k + 1][1])) k++;
    const d = pts[k + 1][1] - pts[k][1];
    return k + (Math.abs(d) > 1e-9 ? (y - pts[k][1]) / d : 0);
  };
  const at = (s) => {
    const k = Math.min(Math.max(Math.floor(s), 0), n - 2), f = s - k, A = pts[k], B = pts[k + 1];
    return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
  };
  return { coord, at };
}

/** Piecewise-linear interpolation of ys over sorted xs, constant past the ends. */
function interp(xs, ys, x) {
  const n = xs.length;
  if (!n) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let k = 0;
  while (x > xs[k + 1]) k++;
  return ys[k] + ((ys[k + 1] - ys[k]) * (x - xs[k])) / (xs[k + 1] - xs[k]);
}
const clampN = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * One tube's map. A vertex is placed by its height along the tube's joint chain (pelvis ... C1, or the two joints of a limb segment): the mesh's
 * chain (asset joints) gives its chain coordinate, the body's chain at the same coordinate gives its new height and axis point, and the vertex keeps
 * its offset from the axis, scaled across by the body's ring half-breadth and half-depth over the template's (fit.js rings with the same id, placed on
 * the template's chain; ratios kept within 0.5 to 2). The trunk scales about the mesh's own section centres (not the spine, which lies at the back)
 * and moves them as the body's ring centres move relative to its spine, by at most 40 mm. A joint of the chain maps exactly onto the body's joint.
 */
function chainMap(tube, man, PB, bodyRings) {
  const ids = CHAINS[tube], tr = man.template.rings[tube] ?? [];
  const cM = chainOf(man.joints, ids), cT = chainOf(man.template.joints, ids), cB = chainOf(PB, ids);
  const byId = new Map(bodyRings.map((r) => [r.id, r]));
  const rows = tr.filter((t) => byId.has(t.id) && t.rx > 0 && t.rz > 0).map((t) => {
    const b = byId.get(t.id), sT = cT.coord(t.y), sB = cB.coord(b.y);
    return { s: sT, kx: clampN(b.rx / t.rx, 0.5, 2), kz: clampN(b.rz / t.rz, 0.5, 2), dz: clampN(b.cz - cB.at(sB)[2] - (t.cz - cT.at(sT)[2]), -0.04, 0.04) };
  }).sort((p, q) => p.s - q.s);
  const S = rows.map((r) => r.s), KX = rows.map((r) => r.kx), KZ = rows.map((r) => r.kz), DZ = rows.map((r) => r.dz);
  const trunk = tube === "torso";
  const sec = trunk ? (man.stations.torso ?? []).map((m) => ({ s: cM.coord(m.y), cx: m.cx, cz: m.cz })).sort((p, q) => p.s - q.s) : [];
  const SS = sec.map((m) => m.s), CX = sec.map((m) => m.cx), CZ = sec.map((m) => m.cz);
  return (x, y, z, out, w) => {
    const s = cM.coord(y), am = cM.at(s), ab = cB.at(s);
    const kx = rows.length ? interp(S, KX, s) : 1, kz = rows.length ? interp(S, KZ, s) : 1;
    let ox = am[0], oz = am[2], dz = 0;
    if (trunk && sec.length) { ox = interp(SS, CX, s); oz = interp(SS, CZ, s); dz = rows.length ? interp(S, DZ, s) : 0; }
    out[0] += w * (ab[0] + (ox - am[0]) + (x - ox) * kx);
    out[1] += w * ab[1];
    out[2] += w * (ab[2] + (oz - am[2]) + dz + (z - oz) * kz);
  };
}

/** A rigid region's map: from the mesh frame to the body's, scaled by (ka, kb, kc) along the frame's axes. */
function frameMap(M, B, ka, kb, kc) {
  return (x, y, z, out, w) => {
    const q = [x - M.o[0], y - M.o[1], z - M.o[2]];
    const qa = dot(q, M.a) * ka, qb = dot(q, M.b) * kb, qc = dot(q, M.c) * kc;
    for (let i = 0; i < 3; i++) out[i] += w * (B.o[i] + B.a[i] * qa + B.b[i] * qb + B.c[i] * qc);
  };
}

/** The region maps of an asset for a body: an array in REGIONS order of fn(x, y, z, out, weight) that ADD weight * mapped point to out. */
export function regionMaps(asset, body) {
  const man = asset.manifest, PM = man.joints, PB = body.positions;
  const dims = bodyDims(body), st = tubeStations(body);
  const trunk = [...new Map([...st.torso, ...st.neck].map((r) => [r.id, r])).values()]; // the assets fit trunk and neck as one tube
  const torso = chainMap("torso", man, PB, trunk);
  return REGIONS.map((r) => {
    if (r === "torso" || r === "neck") return torso;
    if (TUBES.includes(r)) return chainMap(r, man, PB, st[r]);
    if (r === "head") {
      const h = man.dims.head, b = dims.head;
      return frameMap({ o: PM.head, a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] }, { o: PB.head, a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] }, b.breadth / h.breadth, b.height / h.height, b.length / h.length);
    }
    const s = r.slice(-1), m = man.dims[r], b = dims[r];
    if (r.startsWith("hand")) return frameMap(handFrame(PM, s), handFrame(PB, s), b.length / m.length, b.breadth / m.breadth, b.breadth / m.breadth);
    return frameMap(footFrame(PM, s), footFrame(PB, s), b.length / m.length, b.ankle / man.meshDims[r].ankle, b.breadth / m.breadth); // the sole stays at y = 0
  });
}

/**
 * The mesh's own joint centres carried to the body by the maps of their regions. The skin is bound there (inverse bind = translate(-Q)), so each
 * segment bends about its own joint and is carried onto the body's joint by the bone: at rest a vertex lands at its fitted position plus the
 * weighted difference (body joint - Q), a smooth field of a few millimetres to a few centimetres.
 */
export function meshJoints(asset, body, maps = regionMaps(asset, body)) {
  const out = {}, acc = [0, 0, 0];
  for (const j of JOINTS) {
    const p = asset.manifest.joints[j.id];
    acc[0] = acc[1] = acc[2] = 0;
    maps[REGIONS.indexOf(regionOfJoint(j.id))](p[0], p[1], p[2], acc, 1);
    out[j.id] = [acc[0], acc[1], acc[2]];
  }
  return out;
}

/** The asset's neutral vertices fitted to a body: a new Float32Array (3 per vertex). `src` defaults to the asset's own positions. */
export function fitVertices(asset, body, maps = regionMaps(asset, body)) {
  const P = asset.position, n = P.length / 3, out = new Float32Array(P.length), acc = [0, 0, 0];
  const R = asset.region, RW = asset.regionWeight;
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2], w = RW[i] / 255;
    acc[0] = acc[1] = acc[2] = 0;
    maps[R[2 * i]](x, y, z, acc, w);
    if (w < 1) maps[R[2 * i + 1]](x, y, z, acc, 1 - w);
    out[3 * i] = acc[0]; out[3 * i + 1] = acc[1]; out[3 * i + 2] = acc[2];
  }
  return out;
}

function fitPoints(P, map) {
  const out = new Float32Array(P.length), acc = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) {
    acc[0] = acc[1] = acc[2] = 0;
    map(P[i], P[i + 1], P[i + 2], acc, 1);
    out[i] = acc[0]; out[i + 1] = acc[1]; out[i + 2] = acc[2];
  }
  return out;
}

/** Vertex colours of an eyeball: sclera, iris and pupil by the angle from the eye's forward axis (+z). */
function eyeColours(P) {
  const n = P.length / 3, c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += P[3 * i + k] / n;
  const col = new Float32Array(P.length);
  for (let i = 0; i < n; i++) {
    const d = unit3([P[3 * i] - c[0], P[3 * i + 1] - c[1], P[3 * i + 2] - c[2]]);
    const rgb = d[2] > 0.975 ? [0.05, 0.04, 0.04] : d[2] > 0.88 ? [0.32, 0.22, 0.15] : [0.93, 0.91, 0.88];
    col.set(rgb, 3 * i);
  }
  return col;
}

export const DEFAULT_SKIN_COLOR = 0xcfae98; // a light skin tone; options.color overrides it

/**
 * Build the realistic skin of a BodyModel on the bones of a rig (the contract of body.js buildSkin). asset: a decoded asset (loadRealSkin).
 * options: { color, eyes = true }. Returns { mesh, eyes, dispose(), stats }.
 */
export function buildRealSkin(asset, body, bones, options = {}) {
  const t0 = performance.now();
  if (!body || !body.positions || !body.landmarks) throw new TypeError("buildRealSkin: body must be a BodyModel with positions and landmarks");
  if (!(bones instanceof Map)) throw new TypeError("buildRealSkin: bones must be a Map of joint id -> THREE.Bone");
  const list = JOINTS.map((j) => {
    const b = bones.get(j.id);
    if (!b) throw new Error(`buildRealSkin: the rig has no bone "${j.id}"`);
    return b;
  });
  const maps = regionMaps(asset, body);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(fitVertices(asset, body, maps), 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(asset.skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(asset.skinWeight, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(asset.index, 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(options.color ?? DEFAULT_SKIN_COLOR), roughness: 0.58, metalness: 0, side: THREE.FrontSide });
  const Q = meshJoints(asset, body, maps);
  const inverses = JOINTS.map((j) => { const p = Q[j.id]; return new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]); });
  const skeleton = new THREE.Skeleton(list, inverses);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "skin";
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.userData.style = "realistic";

  let eyes = null, eyeGeo = null, eyeMat = null;
  if (options.eyes !== false) {
    const head = JOINTS.findIndex((j) => j.id === "head");
    const parts = asset.eyes.map((e) => ({ p: fitPoints(e.position, maps[REGIONS.indexOf("head")]), i: e.index }));
    const nv = parts.reduce((s, e) => s + e.p.length / 3, 0), ni = parts.reduce((s, e) => s + e.i.length, 0);
    const pos = new Float32Array(nv * 3), idx = new Uint16Array(ni), col = new Float32Array(nv * 3);
    let v = 0, t = 0;
    for (const e of parts) {
      pos.set(e.p, v * 3); col.set(eyeColours(e.p), v * 3);
      for (let k = 0; k < e.i.length; k++) idx[t + k] = e.i[k] + v;
      v += e.p.length / 3; t += e.i.length;
    }
    const si = new Uint8Array(nv * 4), sw = new Uint8Array(nv * 4);
    for (let k = 0; k < nv; k++) { si[4 * k] = head; sw[4 * k] = 255; }
    eyeGeo = new THREE.BufferGeometry();
    eyeGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    eyeGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    eyeGeo.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
    eyeGeo.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4, true));
    eyeGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    eyeGeo.computeVertexNormals();
    eyeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0 });
    eyes = new THREE.SkinnedMesh(eyeGeo, eyeMat);
    eyes.name = "eyes";
    eyes.castShadow = true;
    eyes.bind(skeleton, new THREE.Matrix4());
    mesh.add(eyes); // a child of the skin, as in body.js: visibility, x-ray and disposal follow it
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    geometry.dispose(); material.dispose();
    if (eyes) { eyeGeo.dispose(); eyeMat.dispose(); eyes.removeFromParent(); }
    skeleton.dispose();
  };
  return { mesh, eyes, dispose, stats: { vertices: asset.manifest.vertices, triangles: asset.manifest.triangles, buildMs: performance.now() - t0, style: "realistic", sex: asset.sex } };
}
