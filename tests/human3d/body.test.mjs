// Tests of site/js/human/body.js (the skin generator). Run with
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/body.test.mjs"
// The sweeps use the built website data (public/api/v1) and the real subjects of database/anthro.sqlite; they are skipped when the data is absent.
// Deformation is checked with CPU skinning (a transcription of the vertex shader, itself checked against SkinnedMesh.applyBoneTransform).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile, subjectProfile } from "../../site/js/human/anthro.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin, meshVolume } from "../../site/js/human/body.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = path.join(ROOT, "database/anthro.sqlite"), POP_DIR = path.join(ROOT, "public/api/v1/populations");
const HAVE_DB = fs.existsSync(DB_PATH), HAVE_POPS = fs.existsSync(POP_DIR);
let _db;
const db = () => (_db ??= new DatabaseSync(DB_PATH, { readOnly: true }));
const mm = (x) => x * 1000;
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---- bodies ---------------------------------------------------------------------------------------------------------------------------
const P = (stature, sex = "M", mass) => ({ id: `t:${sex}:${stature}:${mass ?? ""}`, label: "test", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: stature, unit: "mm" }, ...(mass ? { mass: { value: mass, unit: "kg" } } : {}) } });
const popFile = (c, r, s) => path.join(POP_DIR, c, r, `${s}.json`);
const popProfile = (c, r, s, pct) => percentileProfile(JSON.parse(fs.readFileSync(popFile(c, r, s), "utf8")), { percentile: pct });
/** Up to 4 (country, role) pairs that have men's and women's files, the US Army first. */
function popsWithBothSexes() {
  if (!HAVE_POPS) return [];
  const out = [["united-states", "army"]];
  for (const c of fs.readdirSync(POP_DIR).sort()) {
    for (const r of fs.readdirSync(path.join(POP_DIR, c)).sort()) {
      if (out.length < 4 && !out.some(([cc]) => cc === c) && fs.existsSync(popFile(c, r, "M")) && fs.existsSync(popFile(c, r, "F"))) out.push([c, r]);
    }
  }
  return out;
}
const POPS = popsWithBothSexes();

function profiles25() {
  const out = [
    ["stature 1750 M", P(1750, "M")], ["stature 1620 F", P(1620, "F")], ["stature 1450 F", P(1450, "F")], ["stature 2050 M", P(2050, "M")], ["stature 1750 both", P(1750, "both")],
    ["1750 M 80 kg", P(1750, "M", 80)], ["1780 M 150 kg", P(1780, "M", 150)], ["1780 M 52 kg", P(1780, "M", 52)], ["1620 F 60 kg", P(1620, "F", 60)], ["1500 F 45 kg", P(1500, "F", 45)], ["1950 M 125 kg", P(1950, "M", 125)],
  ];
  if (HAVE_POPS) for (const [c, r] of POPS) for (const s of ["M", "F"]) if (fs.existsSync(popFile(c, r, s))) for (const pct of [5, 50, 95]) out.push([`${c}/${r}/${s} P${pct}`, popProfile(c, r, s, pct)]);
  return out;
}

/** The bones of a rig-less test: JOINTS hierarchy, rest offsets from body.positions, identity rotations. */
function makeBones(body) {
  const m = new Map();
  for (const j of JOINTS) {
    const b = new THREE.Bone(); b.name = j.id;
    const p = body.positions[j.id];
    if (j.parent) { const q = body.positions[j.parent]; b.position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]); m.get(j.parent).add(b); } else b.position.set(p[0], p[1], p[2]);
    m.set(j.id, b);
  }
  m.get("pelvis").updateMatrixWorld(true);
  return m;
}

// ---- the checks ----------------------------------------------------------------------------------------------------------------------------
function edgeReport(index, t0, t1) {
  // an oriented closed manifold: every directed edge appears once and its reverse appears once
  const seen = new Map();
  let bad = 0;
  for (let t = t0; t < t1; t++) {
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)], key = a < b ? a * 2097152 + b : b * 2097152 + a, e = seen.get(key) ?? [0, 0];
      e[a < b ? 0 : 1]++; seen.set(key, e);
    }
  }
  for (const e of seen.values()) if (e[0] !== 1 || e[1] !== 1) bad++;
  return { bad, edges: seen.size };
}

function structure(body, skin, tag) {
  const geo = skin.mesh.geometry, pos = geo.attributes.position.array, nor = geo.attributes.normal.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, idx = geo.index.array;
  const nv = pos.length / 3, nt = idx.length / 3, nb = skin.mesh.skeleton.bones.length;
  assert.equal(nv, skin.stats.vertices, tag); assert.equal(nt, skin.stats.triangles, tag);
  for (let i = 0; i < pos.length; i++) assert.ok(Number.isFinite(pos[i]) && Number.isFinite(nor[i]), `${tag}: finite position / normal ${i}`);
  for (let i = 0; i < idx.length; i++) assert.ok(idx[i] < nv, `${tag}: index ${i}`);
  let worstSum = 0, worstN = 0, inf4 = 0;
  for (let v = 0; v < nv; v++) {
    let s = 0;
    for (let k = 0; k < 4; k++) { const w = sw[v * 4 + k]; assert.ok(w >= 0, `${tag}: negative weight`); s += w; if (w > 0) assert.ok(si[v * 4 + k] < nb, `${tag}: skin index`); }
    worstSum = Math.max(worstSum, Math.abs(s - 1));
    const l = Math.hypot(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
    worstN = Math.max(worstN, Math.abs(l - 1));
    if (sw[v * 4 + 3] > 0) inf4++;
  }
  assert.ok(worstSum < 1e-5, `${tag}: weights sum to 1 within ${worstSum}`);
  assert.ok(worstN < 1e-4, `${tag}: unit normals within ${worstN}`);
  // oriented closed parts
  let degenerate = 0, minArea = Infinity;
  for (const [name, p] of Object.entries(skin.mesh.userData.parts)) {
    const r = edgeReport(idx, p.triStart, p.triEnd);
    assert.equal(r.bad, 0, `${tag}: part ${name} has ${r.bad} edges that are not shared by two consistently wound triangles`);
    assert.ok(meshVolume(pos, idx.subarray(p.triStart * 3, p.triEnd * 3)) > 0, `${tag}: part ${name} has a negative volume (inside out)`);
  }
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area < 1e-10) degenerate++;
    if (area < minArea) minArea = area;
  }
  assert.ok(degenerate <= 2, `${tag}: ${degenerate} degenerate triangles (min area ${minArea})`);
  return { nv, nt, inf4, minArea };
}

function bbox(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < lo[k]) lo[k] = pos[i + k]; if (pos[i + k] > hi[k]) hi[k] = pos[i + k]; }
  return { lo, hi };
}

/** Horizontal extent of the vertices of a part within `eps` of height y: { x: [min, max], z: [min, max] }. */
function slice(pos, part, y, eps = 0.0006) {
  const r = { x: [Infinity, -Infinity], z: [Infinity, -Infinity], n: 0 };
  for (let v = part.vertexStart; v < part.vertexEnd; v++) {
    if (Math.abs(pos[v * 3 + 1] - y) > eps) continue;
    r.n++;
    r.x = [Math.min(r.x[0], pos[v * 3]), Math.max(r.x[1], pos[v * 3])];
    r.z = [Math.min(r.z[0], pos[v * 3 + 2]), Math.max(r.z[1], pos[v * 3 + 2])];
  }
  return r;
}

function dimensions(body, skin, tag) {
  const pos = skin.mesh.geometry.attributes.position.array, bb = bbox(pos);
  assert.ok(Math.abs(bb.hi[1] - bb.lo[1] - body.stature) < 0.015, `${tag}: bounding box height ${mm(bb.hi[1] - bb.lo[1]).toFixed(1)} mm for a stature of ${mm(body.stature).toFixed(1)}`);
  assert.ok(bb.lo[1] > -0.002 && bb.lo[1] < 0.002, `${tag}: the soles are on the floor (${mm(bb.lo[1]).toFixed(1)} mm)`);
  const parts = skin.mesh.userData.parts;
  // the horizontal sections of the trunk are the rings of the fit (the rings are knots of the loft)
  for (const id of ["buttock", "waist", "chest"]) {
    const ring = body.shape.tubes.torso.rings.find((r) => r.id === id), s = slice(pos, parts.torso, ring.c[1]);
    assert.ok(s.n >= 8, `${tag}: ring ${id} is in the mesh`);
    assert.ok(Math.abs(s.x[1] - s.x[0] - 2 * ring.rx) < 0.0015, `${tag}: ${id} breadth ${mm(s.x[1] - s.x[0]).toFixed(1)} vs ${mm(2 * ring.rx).toFixed(1)} mm`);
    assert.ok(Math.abs(s.z[1] - s.z[0] - 2 * ring.rz) < 0.0015, `${tag}: ${id} depth ${mm(s.z[1] - s.z[0]).toFixed(1)} vs ${mm(2 * ring.rz).toFixed(1)} mm`);
  }
  // report values that the skin has a say in: chest depth, hip breadth (the report row of the fit; its tolerance is the fit's)
  for (const [id, ringId, axis] of [["chest_depth", "chest", "z"], ["other:hip_breadth", "buttock", "x"], ["chest_breadth", "chest", "x"]]) {
    const row = body.report.find((r) => r.id === id && r.kind === "measure");
    if (!row || row.input === null || row.status === "n/a") continue;
    const ring = body.shape.tubes.torso.rings.find((r) => r.id === ringId), s = slice(pos, parts.torso, ring.c[1]);
    const w = mm(axis === "z" ? s.z[1] - s.z[0] : s.x[1] - s.x[0]);
    assert.ok(Math.abs(w - row.model) < Math.max(3, 1.5 * row.tolerance), `${tag}: ${id} ${w.toFixed(1)} mm in the skin vs ${row.model} in the fit report (input ${row.input})`);
  }
  // bideltoid: the outer edge of the deltoid ring of the arm, or half the measured breadth where the fit's ring is wider (a narrow shoulder: the fit keeps
  // the section 45 mm wide and 60 mm lateral to the axis); no skin of the upper arm within 40 mm of the deltoid or above it reaches further out
  const arm = parts.arm_L, dl = body.shape.tubes.upper_arm_L.rings.find((r) => r.id === "ua_deltoid");
  const bid = body.report.find((r) => r.id === "bideltoid_breadth" && r.kind === "measure")?.input, edge = Math.min(dl.c[0] + dl.rx, bid > 0 ? bid / 2000 : Infinity);
  let maxX = -Infinity, winX = -Infinity;
  for (let v = arm.vertexStart; v < arm.vertexEnd; v++) {
    maxX = Math.max(maxX, pos[v * 3]);
    if (pos[v * 3 + 1] >= dl.c[1] - 0.04 && pos[v * 3 + 1] <= dl.c[1] + 0.06) winX = Math.max(winX, pos[v * 3]);
  }
  assert.ok(maxX >= edge - 0.002, `${tag}: the arm reaches the deltoid edge (${mm(maxX).toFixed(1)} vs ${mm(edge).toFixed(1)})`);
  assert.ok(winX <= edge + 0.003, `${tag}: the skin within 40 mm of the deltoid is ${mm(winX - edge).toFixed(1)} mm wider than the deltoid edge / half the bideltoid breadth`);
  // foot length and hand length
  const foot = parts.foot_L;
  let zlo = Infinity, zhi = -Infinity;
  for (let v = foot.vertexStart; v < foot.vertexEnd; v++) { zlo = Math.min(zlo, pos[v * 3 + 2]); zhi = Math.max(zhi, pos[v * 3 + 2]); }
  assert.ok(Math.abs(zhi - zlo - body.d.foot_length) < 0.004, `${tag}: foot length ${mm(zhi - zlo).toFixed(1)} vs ${mm(body.d.foot_length).toFixed(1)}`);
  const hand = parts.middle_L; // the tip of the middle finger is the dactylion of the fit
  let ymin = Infinity;
  for (let v = hand.vertexStart; v < hand.vertexEnd; v++) ymin = Math.min(ymin, pos[v * 3 + 1]);
  const dac = body.shape.hands.L.fingers.middle.tip[1];
  assert.ok(Math.abs(ymin - dac) < 0.001, `${tag}: middle fingertip ${mm(ymin).toFixed(1)} vs ${mm(dac).toFixed(1)}`);
}

function checkVolume(body, skin, tag) {
  const geo = skin.mesh.geometry, v = meshVolume(geo.attributes.position.array, geo.index.array), ref = body.shape.volume.m3;
  assert.ok(Math.abs(v / ref - 1) < 0.12, `${tag}: mesh volume ${(v * 1000).toFixed(1)} L vs shape.volume ${(ref * 1000).toFixed(1)} L (${((v / ref - 1) * 100).toFixed(1)} %)`);
  return v / ref;
}

function checkRest(skin, tag) {
  // the neutral pose is reproduced exactly: skinning at rest leaves every vertex where it is
  const mesh = skin.mesh, geo = mesh.geometry, pos = geo.attributes.position, v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  let worst = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const x = v.x, y = v.y, z = v.z;
    mesh.applyBoneTransform(i, v);
    worst = Math.max(worst, Math.abs(v.x - x), Math.abs(v.y - y), Math.abs(v.z - z));
  }
  assert.ok(worst < 1e-9, `${tag}: skinning at rest moved a vertex by ${worst}`);
  if (skin.eyes) {
    const ep = skin.eyes.geometry.attributes.position;
    let w = 0;
    for (let i = 0; i < ep.count; i++) { v.fromBufferAttribute(ep, i); const x = v.x, y = v.y, z = v.z; skin.eyes.applyBoneTransform(i, v); w = Math.max(w, Math.abs(v.x - x), Math.abs(v.y - y), Math.abs(v.z - z)); }
    assert.ok(w < 1e-9, `${tag}: the eyes at rest`);
  }
}

// ---- CPU skinning --------------------------------------------------------------------------------------------------------------------------
const TMP = new THREE.Matrix4();
function boneMatrices(mesh) {
  const sk = mesh.skeleton, n = sk.bones.length, M = new Float64Array(n * 16);
  for (let i = 0; i < n; i++) { TMP.multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]); M.set(TMP.elements, i * 16); }
  return M;
}
function skinAll(mesh, M, out) {
  const geo = mesh.geometry, pos = geo.attributes.position.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, nv = pos.length / 3;
  out ??= new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k];
      if (w === 0) continue;
      const o = si[v * 4 + k] * 16;
      ax += w * (M[o] * x + M[o + 4] * y + M[o + 8] * z + M[o + 12]);
      ay += w * (M[o + 1] * x + M[o + 5] * y + M[o + 9] * z + M[o + 13]);
      az += w * (M[o + 2] * x + M[o + 6] * y + M[o + 10] * z + M[o + 14]);
    }
    out[v * 3] = ax; out[v * 3 + 1] = ay; out[v * 3 + 2] = az;
  }
  return out;
}
const rigOf = (body, quality = "high", handle = {}) => buildRig(body, { skeleton: false, quality, skinBuilder: (b, bones, o) => (handle.skin = buildSkin(b, bones, o)) });

function posedVolume(mesh, posed) {
  const idx = mesh.geometry.index.array;
  return meshVolume(posed, idx);
}
function partVolume(mesh, posed, p) { return meshVolume(posed, mesh.geometry.index.array.subarray(p.triStart * 3, p.triEnd * 3)); }

const D = (id) => id;
const both = (id, a) => ({ [`${id}_L`]: a, [`${id}_R`]: a });
const FIST = (() => {
  const a = {};
  for (const s of ["L", "R"]) {
    for (const f of ["index", "middle", "ring", "little"]) { a[`${f}_mcp_${s}`] = [85, 0]; a[`${f}_pip_${s}`] = [100]; a[`${f}_dip_${s}`] = [70]; }
    a[`thumb_cmc_${s}`] = [30, 20]; a[`thumb_mcp_${s}`] = [40]; a[`thumb_ip_${s}`] = [50];
  }
  return a;
})();
/** The extreme postures of the library (angles in degrees, DOF order of skeleton.js); `spine` is region totals. */
const EXTREME = {
  "deep squat": { angles: { ...both("hip", [130, 0, 0]), ...both("knee", [150, 0]), ...both("ankle", [30, 0, 0]) } },
  "arm raised 170": { angles: both("shoulder", [170, 0, 0]) },
  "arm abducted 170": { angles: both("shoulder", [0, 170, 0]) },
  "elbow 140": { angles: { ...both("shoulder", [60, 0, 0]), ...both("elbow", [140]) } },
  "trunk bent forward 100 + hips 60": { spine: { lumbar: [60, 0, 0], thoracic: [40, 0, 0] }, angles: both("hip", [60, 0, 0]) },
  "trunk bent forward on straight legs": { root: { flex: 60 }, spine: { lumbar: [30, 0, 0], thoracic: [10, 0, 0] }, angles: both("hip", [-20, 0, 0]) },
  "seated 90-90-90": { angles: { ...both("hip", [90, 0, 0]), ...both("knee", [90, 0]) } },
  "kneeling on the heels": { angles: { ...both("hip", [95, 0, 0]), ...both("knee", [155, 0]), ...both("ankle", [-50, 0, 0]) } },
  "lying": { root: { flex: -90 } },
  "neck flexion + rotation": { spine: { cervical: [45, 0, 70] }, angles: { head: [20, 0, 10] } },
  "wrist flexion": { angles: both("wrist", [80, 20]) },
  "fist": { angles: FIST },
  "hip abduction 45": { angles: both("hip", [0, 45, 0]) },
  "ankle plantarflexion": { angles: both("ankle", [-50, 0, 0]) },
  "forearm pronation 90": { angles: { ...both("forearm", [90]), ...both("elbow", [90]) } },
  "knee 150": { angles: both("knee", [150, 0]) },
};
/** Is vertex v of the posed positions inside the closed trunk (ray along +y, parity of the crossings)? */
function insideTrunk(mesh, posed, v) {
  const t = mesh.userData.parts.torso, idx = mesh.geometry.index.array, px = posed[v * 3], py = posed[v * 3 + 1], pz = posed[v * 3 + 2];
  let hits = 0;
  for (let i = t.triStart; i < t.triEnd; i++) {
    const a = idx[i * 3] * 3, b = idx[i * 3 + 1] * 3, c = idx[i * 3 + 2] * 3;
    // Moller-Trumbore with the direction (0, 1, 0)
    const e1x = posed[b] - posed[a], e1y = posed[b + 1] - posed[a + 1], e1z = posed[b + 2] - posed[a + 2], e2x = posed[c] - posed[a], e2y = posed[c + 1] - posed[a + 1], e2z = posed[c + 2] - posed[a + 2];
    // h = d x e2 with d = (0,1,0): (e2z, 0, -e2x)
    const hx = e2z, hz = -e2x, det = e1x * hx + e1z * hz;
    if (Math.abs(det) < 1e-14) continue;
    const f = 1 / det, sx = px - posed[a], sy = py - posed[a + 1], sz = pz - posed[a + 2], u = f * (sx * hx + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, w = f * qy;
    if (w < 0 || u + w > 1) continue;
    if (f * (e2x * qx + e2y * qy + e2z * qz) > 1e-9) hits++;
  }
  return hits % 2 === 1;
}

function applyPose(rig, def) {
  rig.setPose({ root: def.root ?? {}, angles: def.angles ?? {} }, { clamp: false });
  if (def.spine) rig.setSpine(def.spine, null, { clamp: false });
  rig.group.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
test("API: buildSkin returns { mesh, eyes, dispose, stats } and does not touch the bones", () => {
  const body = fitBody(P(1750, "M", 80)), bones = makeBones(body);
  const before = [...bones.values()].map((b) => b.matrix.toArray().join());
  const skin = buildSkin(body, bones);
  assert.ok(skin.mesh.isSkinnedMesh && skin.eyes.isSkinnedMesh && typeof skin.dispose === "function");
  assert.ok(skin.stats.vertices > 5000 && skin.stats.triangles > 10000 && skin.stats.buildMs >= 0);
  assert.deepEqual([...bones.values()].map((b) => b.matrix.toArray().join()), before, "the bones are untouched");
  assert.ok(skin.mesh.material.isMeshStandardMaterial && skin.eyes.material.isMeshStandardMaterial);
  assert.equal(skin.mesh.material.side, THREE.FrontSide);
  assert.ok(skin.mesh.castShadow && skin.mesh.receiveShadow && skin.eyes.castShadow);
  assert.equal(skin.eyes.skeleton, skin.mesh.skeleton, "the eyes share the skeleton");
  assert.equal(skin.eyes.parent, skin.mesh, "the eyes ride on the skin (rig.js traverses the mesh)");
  assert.equal(skin.mesh.skeleton.bones.length, JOINTS.length);
  JOINTS.forEach((j, i) => assert.equal(skin.mesh.skeleton.bones[i], bones.get(j.id), `bone ${i} is ${j.id}`));
  assert.ok(skin.mesh.bindMatrix.equals(new THREE.Matrix4()), "identity bind matrix");
  const noEyes = buildSkin(body, bones, { eyes: false });
  assert.equal(noEyes.eyes, null);
  const colored = buildSkin(body, bones, { color: 0xff0000 });
  assert.equal(colored.mesh.material.color.getHex(), 0xff0000);
  for (const s of [skin, noEyes, colored]) s.dispose();
  assert.throws(() => buildSkin({}, bones), /BodyModel/);
  assert.throws(() => buildSkin(body, new Map([["pelvis", bones.get("pelvis")]])), /missing/);
});

test("dispose frees the geometry, the materials and the bone texture (and may be called twice)", () => {
  const body = fitBody(P(1750, "M", 80)), h = {}, rig = rigOf(body, "high", h), skin = rig.skin, handle = h.skin;
  assert.ok(handle && handle.mesh === skin);
  let events = 0;
  const geo = skin.geometry, mat = skin.material, eg = skin.children[0].geometry, em = skin.children[0].material;
  for (const o of [geo, mat, eg, em]) o.addEventListener("dispose", () => events++);
  const sk = skin.skeleton;
  sk.computeBoneTexture();
  assert.ok(sk.boneTexture);
  rig.dispose();
  assert.equal(events, 4, "geometry and material of the skin and of the eyes disposed");
  assert.equal(sk.boneTexture, null, "the bone texture is freed");
  handle.dispose();
  assert.equal(events, 4, "idempotent");
});

test("the skin builds on bones in any pose, and the bind does not depend on it", () => {
  const body = fitBody(P(1750, "M", 80));
  const rest = buildSkin(body, makeBones(body));
  const bones = makeBones(body), rnd = rng(3);
  for (const b of bones.values()) { b.quaternion.setFromEuler(new THREE.Euler((rnd() - 0.5) * 2, (rnd() - 0.5) * 2, (rnd() - 0.5) * 2)); b.position.x += 0.1; }
  bones.get("pelvis").updateMatrixWorld(true);
  const posed = buildSkin(body, bones);
  const a = rest.mesh.geometry.attributes.position.array, b = posed.mesh.geometry.attributes.position.array;
  assert.deepEqual(a, b, "the geometry is the neutral body");
  for (let i = 0; i < rest.mesh.skeleton.boneInverses.length; i++) assert.ok(rest.mesh.skeleton.boneInverses[i].equals(posed.mesh.skeleton.boneInverses[i]), `inverse bind ${i}`);
  // put the bones back at rest: every vertex is where it was
  for (const [id, bn] of bones) { bn.quaternion.identity(); const p = body.positions[id], q = JOINTS.find((j) => j.id === id).parent; if (q) { const pp = body.positions[q]; bn.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]); } else bn.position.set(p[0], p[1], p[2]); }
  bones.get("pelvis").updateMatrixWorld(true);
  checkRest(posed, "rest after posed bind");
  rest.dispose(); posed.dispose();
});

test("quality: triangle counts, and the build time of the median man", () => {
  const body = fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), bones = makeBones(body);
  buildSkin(body, bones).dispose(); // warm up
  const times = [];
  let hi, lo;
  for (let i = 0; i < 7; i++) { const t = performance.now(); const s = buildSkin(body, bones); times.push(performance.now() - t); hi = s.stats; s.dispose(); }
  lo = buildSkin(body, bones, { quality: "low" }); const lstats = lo.stats; lo.dispose();
  times.sort((a, b) => a - b);
  console.log(`  high: ${hi.vertices} vertices, ${hi.triangles} triangles, median ${times[3].toFixed(0)} ms (min ${times[0].toFixed(0)}, max ${times[6].toFixed(0)}); low: ${lstats.vertices} vertices, ${lstats.triangles} triangles`);
  assert.ok(hi.triangles <= 60000 && lstats.triangles <= 25000, "triangle budgets");
  assert.ok(lstats.triangles / hi.triangles > 0.25 && lstats.triangles / hi.triangles < 0.6, `low is roughly 40 % of high: ${(lstats.triangles / hi.triangles).toFixed(2)}`);
  assert.ok(times[3] < 250, `buildSkin takes ${times[3].toFixed(0)} ms`);
});

test("the skin of 35 profiles (stature, stature + mass, populations): structure, dimensions, volume, rest pose", () => {
  const list = profiles25();
  assert.ok(list.length >= 25);
  const ratios = [];
  for (const [label, prof] of list) {
    const body = fitBody(prof), bones = makeBones(body);
    for (const quality of ["high", "low"]) {
      const skin = buildSkin(body, bones, { quality });
      const tag = `${label} ${quality}`;
      structure(body, skin, tag);
      dimensions(body, skin, tag);
      if (quality === "high") { ratios.push(checkVolume(body, skin, tag)); checkRest(skin, tag); }
      else assert.ok(skin.stats.triangles <= 25000, `${tag}: ${skin.stats.triangles} triangles`);
      skin.dispose();
    }
  }
  console.log(`  mesh volume / shape.volume over ${list.length} profiles: ${Math.min(...ratios).toFixed(3)} .. ${Math.max(...ratios).toFixed(3)}`);
});

function pick(dataset, n) {
  const rows = db().prepare("select * from subjects where dataset = ? and stature is not null and mass is not null order by subject_key").all(dataset);
  const chosen = new Map();
  const add = (r) => chosen.set(r.subject_key, r);
  const bmi = (r) => r.mass / (r.stature / 1000) ** 2;
  for (const key of [(r) => bmi(r), (r) => r.stature]) {
    const s = [...rows].sort((a, b) => key(a) - key(b));
    for (let i = 0; i < 5; i++) { add(s[i]); add(s[s.length - 1 - i]); }
  }
  const step = Math.max(1, Math.floor(rows.length / n));
  for (let i = 0; i < rows.length && chosen.size < n; i += step) add(rows[i]);
  return [...chosen.values()].slice(0, n);
}
for (const ds of ["ansur_1988", "ansur_ii_2012", "asran_2015", "usaf_1967"]) {
  test(`sweep: 60 real people of ${ds}, extreme BMI and stature included`, { skip: !HAVE_DB }, () => {
    const people = pick(ds, 60);
    assert.ok(people.length >= 55);
    const ratios = [];
    for (const r of people) {
      const body = fitBody(subjectProfile(r)), skin = buildSkin(body, makeBones(body)), tag = `${ds} #${r.subject_key} (${r.stature} mm, ${r.mass} kg)`;
      structure(body, skin, tag);
      dimensions(body, skin, tag);
      ratios.push(checkVolume(body, skin, tag));
      if (r.subject_key % 7 === 0) checkRest(skin, tag);
      skin.dispose();
    }
    console.log(`  ${ds}: mesh volume / shape.volume ${Math.min(...ratios).toFixed(3)} .. ${Math.max(...ratios).toFixed(3)}`);
  });
}

test("weights: the forearm roll joint carries no skin; the eyes follow the eye joints; the toes follow mtp; the fingers their phalanges", () => {
  const body = fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), bones = makeBones(body), skin = buildSkin(body, bones);
  const ids = JOINTS.map((j) => j.id), geo = skin.mesh.geometry, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, pos = geo.attributes.position.array;
  const used = new Set();
  for (let v = 0; v < sw.length / 4; v++) for (let k = 0; k < 4; k++) if (sw[v * 4 + k] > 0) used.add(ids[si[v * 4 + k]]);
  assert.ok(!used.has("forearm_L") && !used.has("forearm_R"), "the forearm roll joint rotates the hand only");
  for (const id of ["pelvis", "L5", "T12", "C7", "head", "clavicle_L", "shoulder_R", "elbow_L", "wrist_R", "hip_L", "knee_R", "ankle_L", "mtp_R", "index_pip_L", "thumb_ip_R", "little_dip_L"]) assert.ok(used.has(id), `${id} carries skin`);
  const heavy = (v) => { let b = 0, bw = 0; for (let k = 0; k < 4; k++) if (sw[v * 4 + k] > bw) { bw = sw[v * 4 + k]; b = si[v * 4 + k]; } return ids[b]; };
  // toes: foot vertices well beyond the ball follow mtp, the heel follows the ankle
  const foot = skin.mesh.userData.parts.foot_L, zBall = body.shape.feet.L.toesFrom;
  for (let v = foot.vertexStart; v < foot.vertexEnd; v++) {
    const z = pos[v * 3 + 2];
    if (z > zBall + 0.03) assert.equal(heavy(v), "mtp_L", `toe vertex ${v}`);
    if (z < zBall - 0.05) assert.equal(heavy(v), "ankle_L", `foot vertex ${v}`);
  }
  // every finger vertex at the tip follows the distal phalanx
  for (const f of ["index", "middle", "ring", "little"]) {
    const p = skin.mesh.userData.parts[`${f}_L`];
    let low = p.vertexStart;
    for (let v = p.vertexStart; v < p.vertexEnd; v++) if (pos[v * 3 + 1] < pos[low * 3 + 1]) low = v;
    assert.equal(heavy(low), `${f}_dip_L`, `${f} tip`);
  }
  // the eyes
  const eg = skin.eyes.geometry, ei = eg.attributes.skinIndex.array, ew = eg.attributes.skinWeight.array, ep = eg.attributes.position.array, n = ep.length / 3;
  for (let v = 0; v < n; v++) { assert.equal(ew[v * 4], 1); assert.equal(ids[ei[v * 4]], ep[v * 3] > 0 ? "eye_L" : "eye_R"); }
  assert.equal(edgeReport(eg.index.array, 0, eg.index.array.length / 3).bad, 0, "the eyes are closed manifolds");
  assert.ok(meshVolume(ep, eg.index.array) > 0);
  // the eyeball is at the eye joint, with the radius of the fit
  const c = body.positions.eye_L, R = body.shape.head.features.eyes.radius;
  let dmax = 0, dmin = Infinity;
  for (let v = 0; v < n / 2; v++) { const d = Math.hypot(ep[v * 3] - c[0], ep[v * 3 + 1] - c[1], ep[v * 3 + 2] - c[2]); dmax = Math.max(dmax, d); dmin = Math.min(dmin, d); }
  assert.ok(Math.abs(dmax - R) < 1e-5 && Math.abs(dmin - R) < 1e-5);
  skin.dispose();
});

test("the skin passes through the surface landmarks of the fit (contacts, nipples, navel, heels, toes, fingertips, ...)", () => {
  const out = [];
  for (const body of [fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), fitBody(HAVE_POPS ? popProfile("united-states", "army", "F", 5) : P(1500, "F", 48)), fitBody(P(1780, "M", 150))]) {
    const skin = buildSkin(body, makeBones(body)), pos = skin.mesh.geometry.attributes.position.array;
    let worst = 0, worstId = "";
    for (const [id, l] of Object.entries(body.landmarks)) {
      if (l.kind !== "surface" && l.kind !== "contact") continue;
      const j = body.positions[l.joint], p = [j[0] + l.offset[0], j[1] + l.offset[1], j[2] + l.offset[2]];
      let best = Infinity;
      for (let v = 0; v < pos.length; v += 3) best = Math.min(best, Math.hypot(pos[v] - p[0], pos[v + 1] - p[1], pos[v + 2] - p[2]));
      if (best > worst) { worst = best; worstId = id; }
      assert.ok(best < 0.03, `${body.label}: the ${kind(l)} landmark ${id} is ${mm(best).toFixed(0)} mm from the nearest skin vertex`);
    }
    out.push(`${mm(worst).toFixed(0)} mm (${worstId})`);
    skin.dispose();
  }
  console.log(`  farthest surface landmark from the nearest skin vertex: ${out.join(", ")}`);
});
const kind = (l) => l.kind;

test("left and right are mirror images", () => {
  const body = fitBody(HAVE_POPS ? popProfile("united-states", "army", "F", 50) : P(1620, "F", 60)), skin = buildSkin(body, makeBones(body));
  const pos = skin.mesh.geometry.attributes.position.array, key = (x, y, z) => `${Math.round(x * 2e4)},${Math.round(y * 2e4)},${Math.round(z * 2e4)}`;
  const set = new Set();
  for (let i = 0; i < pos.length; i += 3) set.add(key(pos[i], pos[i + 1], pos[i + 2]));
  let hit = 0, total = 0;
  for (let i = 0; i < pos.length; i += 3) { total++; if (set.has(key(-pos[i], pos[i + 1], pos[i + 2])) || set.has(key(-pos[i] + 5e-5, pos[i + 1], pos[i + 2])) || set.has(key(-pos[i] - 5e-5, pos[i + 1], pos[i + 2]))) hit++; }
  assert.ok(hit / total > 0.97, `${(100 * hit / total).toFixed(1)} % of the vertices have a mirror twin`);
  skin.dispose();
});

test("CPU skinning agrees with SkinnedMesh.applyBoneTransform", () => {
  const body = fitBody(P(1750, "M", 80)), rig = rigOf(body), rnd = rng(11);
  const angles = {};
  for (const j of JOINTS) angles[j.id] = j.dof.map((d) => d.min * 0.4 + (d.max - d.min) * 0.4 * rnd());
  rig.setPose({ root: { x: 0.3, y: 1, z: -0.2, heading: 40, flex: 20, lat: 10, rot: 5 }, angles });
  rig.group.updateMatrixWorld(true);
  const mesh = rig.skin, mine = skinAll(mesh, boneMatrices(mesh)), v = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < mesh.geometry.attributes.position.count; i += 37) {
    v.fromBufferAttribute(mesh.geometry.attributes.position, i);
    mesh.applyBoneTransform(i, v);
    worst = Math.max(worst, Math.abs(v.x - mine[i * 3]), Math.abs(v.y - mine[i * 3 + 1]), Math.abs(v.z - mine[i * 3 + 2]));
  }
  assert.ok(worst < 1e-9, `worst ${worst}`);
  rig.dispose();
});

test("40 random in-range poses: no vertex flies away, no part turns inside out, the volume stays", () => {
  const people = [fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), fitBody(HAVE_POPS ? popProfile("united-states", "army", "F", 5) : P(1500, "F", 48)), fitBody(P(1780, "M", 150))];
  let worstOver = -Infinity, worstVol = 0;
  for (const body of people) {
    const rig = rigOf(body), mesh = rig.skin, geo = mesh.geometry, pos = geo.attributes.position.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array;
    const parts = mesh.userData.parts, rest = meshVolume(pos, geo.index.array), restPart = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, partVolume(mesh, pos, p)]));
    const rnd = rng(1234 + body.mass), nv = pos.length / 3, out = new Float64Array(nv * 3), rigid = new Float64Array(nv * 3);
    for (let n = 0; n < 40; n++) {
      const angles = {};
      for (const j of JOINTS) angles[j.id] = j.dof.map((d) => d.min + (d.max - d.min) * rnd());
      rig.setPose({ root: { x: rnd(), y: 1 + rnd(), z: rnd(), heading: rnd() * 720 - 360, flex: rnd() * 360 - 180, lat: rnd() * 180 - 90, rot: rnd() * 180 - 90 }, angles });
      rig.group.updateMatrixWorld(true);
      const M = boneMatrices(mesh);
      skinAll(mesh, M, out);
      // each vertex is a convex combination of its bones' rigid images; it may not be farther from the heaviest one's image than the spread of those images (+ 5 mm)
      for (let v = 0; v < nv; v++) {
        let hb = 0, hw = -1;
        for (let k = 0; k < 4; k++) if (sw[v * 4 + k] > hw) { hw = sw[v * 4 + k]; hb = k; }
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], o = si[v * 4 + hb] * 16;
        const hx = M[o] * x + M[o + 4] * y + M[o + 8] * z + M[o + 12], hy = M[o + 1] * x + M[o + 5] * y + M[o + 9] * z + M[o + 13], hz = M[o + 2] * x + M[o + 6] * y + M[o + 10] * z + M[o + 14];
        let spread = 0;
        for (let k = 0; k < 4; k++) {
          if (!(sw[v * 4 + k] > 0)) continue;
          const q = si[v * 4 + k] * 16;
          spread = Math.max(spread, Math.hypot(M[q] * x + M[q + 4] * y + M[q + 8] * z + M[q + 12] - hx, M[q + 1] * x + M[q + 5] * y + M[q + 9] * z + M[q + 13] - hy, M[q + 2] * x + M[q + 6] * y + M[q + 10] * z + M[q + 14] - hz));
        }
        const dev = Math.hypot(out[v * 3] - hx, out[v * 3 + 1] - hy, out[v * 3 + 2] - hz);
        worstOver = Math.max(worstOver, dev - (spread + 0.005));
        assert.ok(Number.isFinite(dev));
      }
      const vol = meshVolume(out, geo.index.array);
      worstVol = Math.max(worstVol, Math.abs(vol / rest - 1));
      for (const [k, p] of Object.entries(parts)) assert.ok(partVolume(mesh, out, p) > 0, `pose ${n} of ${body.label}: part ${k} is inside out`);
    }
    void restPart;
    rig.dispose();
  }
  console.log(`  worst vertex excess over the bound: ${mm(worstOver).toFixed(2)} mm; worst volume change of the random poses: ${(100 * worstVol).toFixed(1)} %`);
  assert.ok(worstOver <= 1e-9, `a vertex flew ${mm(worstOver)} mm beyond its bound`);
});

test("extreme postures of the library: finite, volume within 25 %, nothing collapsed or inside out", () => {
  const bodies = [["P50 man", fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80))], ["P5 woman", fitBody(HAVE_POPS ? popProfile("united-states", "army", "F", 5) : P(1500, "F", 48))],
    ["heavy man", fitBody(P(1780, "M", 150))], ["thin man", fitBody(P(1780, "M", 52))]];
  const rows = [];
  let stretch = 0;
  for (const [who, body] of bodies) {
    const rig = rigOf(body), mesh = rig.skin, geo = mesh.geometry, pos = geo.attributes.position.array, rest = meshVolume(pos, geo.index.array);
    const restPart = Object.fromEntries(Object.entries(mesh.userData.parts).map(([k, p]) => [k, partVolume(mesh, pos, p)]));
    const out = new Float64Array(pos.length), capsInside = {};
    for (const s of ["L", "R"]) for (const tube of ["arm", "leg"]) capsInside[`${tube}_${s}`] = insideTrunk(mesh, pos, mesh.userData.parts[`${tube}_${s}`].vertexEnd - 2); // at rest (the woman's shoulder dome pokes out of her narrow trunk)
    for (const [name, def] of Object.entries(EXTREME)) {
      applyPose(rig, def);
      skinAll(mesh, boneMatrices(mesh), out);
      for (let i = 0; i < out.length; i++) assert.ok(Number.isFinite(out[i]), `${who} / ${name}: finite`);
      const vol = meshVolume(out, geo.index.array), r = vol / rest;
      rows.push([who, name, r]);
      assert.ok(Math.abs(r - 1) < 0.25, `${who} / ${name}: the volume changes by ${((r - 1) * 100).toFixed(1)} %`);
      for (const [k, p] of Object.entries(mesh.userData.parts)) {
        const pv = partVolume(mesh, out, p) / restPart[k];
        assert.ok(pv > 0.4 && pv < 2.2, `${who} / ${name}: part ${k} keeps ${(pv * 100).toFixed(0)} % of its volume`);
      }
      // no vertex flies away: no edge stretches to more than 4 times its length (the outside of a knee bent to 150 degrees stretches 3 times), and (almost) none is crushed
      const idx = geo.index.array;
      let maxS = 0, crushed = 0, total = 0;
      for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
        const a = idx[t + k] * 3, b = idx[t + (k + 1) % 3] * 3, r0 = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
        if (r0 < 1e-5) continue;
        const s = Math.hypot(out[a] - out[b], out[a + 1] - out[b + 1], out[a + 2] - out[b + 2]) / r0;
        total++; if (s > maxS) maxS = s; if (s < 0.15) crushed++;
      }
      assert.ok(maxS < 4, `${who} / ${name}: an edge stretches ${maxS.toFixed(2)} times`);
      assert.ok(crushed / total < 0.002, `${who} / ${name}: ${crushed} of ${total} edges are crushed to less than 15 %`);
      stretch = Math.max(stretch, maxS);
      // the shoulder and hip caps stay inside the trunk (no hole where the arm or the thigh leaves it)
      for (const s of ["L", "R"]) for (const tube of ["arm", "leg"]) {
        const p = mesh.userData.parts[`${tube}_${s}`], v = p.vertexEnd - 2; // the first apex: the shoulder / hip dome
        if (capsInside[`${tube}_${s}`]) assert.ok(insideTrunk(mesh, out, v), `${who} / ${name}: the ${tube === "arm" ? "shoulder" : "hip"} cap of ${s} left the trunk`);
      }
      // the posed mesh stays within a body's reach of the pelvis
      const c = rig.jointWorld("pelvis");
      let far = 0;
      for (let v = 0; v < out.length; v += 3) far = Math.max(far, Math.hypot(out[v] - c.x, out[v + 1] - c.y, out[v + 2] - c.z));
      assert.ok(far < 1.6 * body.stature * 0.9, `${who} / ${name}: a vertex is ${far.toFixed(2)} m from the pelvis`);
    }
    rig.dispose();
  }
  const worst = rows.reduce((a, b) => (Math.abs(b[2] - 1) > Math.abs(a[2] - 1) ? b : a));
  console.log(`  longest edge stretch in the extreme postures: ${stretch.toFixed(2)}x`);
  console.log(`  volume of the posed skin / rest: ${rows.map((r) => r[2]).reduce((a, b) => Math.min(a, b)).toFixed(3)} .. ${rows.map((r) => r[2]).reduce((a, b) => Math.max(a, b)).toFixed(3)} (worst: ${worst[0]} / ${worst[1]} ${worst[2].toFixed(3)})`);
});

/** Signed distance from point q to the nearest of the triangles `tris` (flat array of vertex ids) of the posed positions: negative behind the surface (inside). */
function signedDistance(posed, tris, q) {
  let best = Infinity, sign = 1;
  for (let i = 0; i < tris.length; i += 3) {
    const A = tris[i] * 3, B = tris[i + 1] * 3, C = tris[i + 2] * 3;
    const ab = [posed[B] - posed[A], posed[B + 1] - posed[A + 1], posed[B + 2] - posed[A + 2]], ac = [posed[C] - posed[A], posed[C + 1] - posed[A + 1], posed[C + 2] - posed[A + 2]];
    const ap = [q[0] - posed[A], q[1] - posed[A + 1], q[2] - posed[A + 2]];
    // closest point on the triangle (Ericson, Real-Time Collision Detection 5.1.5)
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let u, v;
    const d1 = dot(ab, ap), d2 = dot(ac, ap), bp = [ap[0] - ab[0], ap[1] - ab[1], ap[2] - ab[2]], d3 = dot(ab, bp), d4 = dot(ac, bp), cp = [ap[0] - ac[0], ap[1] - ac[1], ap[2] - ac[2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
    else if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
    else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
    else {
      const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
      else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { v = (d4 - d3) / (d4 - d3 + d5 - d6); u = 1 - v; }
      else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den; }
    }
    const cx = posed[A] + u * ab[0] + v * ac[0], cy = posed[A + 1] + u * ab[1] + v * ac[1], cz = posed[A + 2] + u * ab[2] + v * ac[2];
    const d = Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz);
    if (d < best) {
      best = d;
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      sign = (q[0] - cx) * n[0] + (q[1] - cy) * n[1] + (q[2] - cz) * n[2] >= 0 ? 1 : -1;
    }
  }
  return sign * best;
}

test("knee flexion 150: how far the calf and the thigh interpenetrate at the back of the knee", () => {
  const body = fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), rig = rigOf(body), mesh = rig.skin, geo = mesh.geometry;
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, idx = geo.index.array, leg = mesh.userData.parts.leg_L, M = leg.cols;
  const yK = body.positions.knee_L[1], rowOf = (v) => Math.floor((v - leg.vertexStart) / M), yRow = (r) => pos[(leg.vertexStart + r * M) * 3 + 1];
  applyPose(rig, { angles: both("knee", [150, 0]) });
  const out = skinAll(mesh, boneMatrices(mesh));
  // the calf: the triangles of the leg tube below the knee; the thigh's back: its vertices above it that face backward at rest
  const calf = [];
  for (let t = leg.triStart; t < leg.triEnd; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if ([a, b, c].every((v) => v < leg.vertexEnd - 2 && yRow(rowOf(v)) < yK - 0.01)) calf.push(a, b, c);
  }
  const bins = [[0.02, 0.05], [0.05, 0.1], [0.1, 0.2]], worst = bins.map(() => 0);
  for (let v = leg.vertexStart; v < leg.vertexEnd - 2; v++) {
    const y = pos[v * 3 + 1] - yK, bi = bins.findIndex(([lo, hi]) => y >= lo && y < hi);
    if (bi < 0 || nor[v * 3 + 2] > -0.5 || (v - leg.vertexStart) % 2) continue; // the back of the thigh (every other vertex)
    const d = signedDistance(out, calf, [out[v * 3], out[v * 3 + 1], out[v * 3 + 2]]);
    if (-d > worst[bi]) worst[bi] = -d;
  }
  console.log(`  knee 150: the back of the thigh sinks into the calf by up to ${bins.map(([lo, hi], i) => `${mm(worst[i]).toFixed(0)} mm at ${mm(lo).toFixed(0)}-${mm(hi).toFixed(0)} mm`).join(", ")} above the knee (linear blend skinning: the blend zone pinches the back of the knee, further up two rigid tubes whose axes are 30 degrees apart overlap; no soft-tissue compression)`);
  assert.ok(worst.every(Number.isFinite));
  assert.ok(Math.max(...worst) < 0.075, `the thigh sinks ${mm(Math.max(...worst)).toFixed(1)} mm into the calf`);
  rig.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Regressions of the defects an independent verifier found (hip, thigh, deltoid, shoulder limit, deep flexion, ankle, fingertips, low quality).
/** Cross-section of the triangles [t0, t1) with the plane y = y0: { x: [lo, hi], z: [lo, hi], per (m), n (segments) }. Exact between the vertices. */
function cut(pos, idx, part, y0) {
  const r = { x: [Infinity, -Infinity], z: [Infinity, -Infinity], per: 0, n: 0 }, P = [0, 0, 0, 0];
  for (let t = part.triStart; t < part.triEnd; t++) {
    const v = [idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3];
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], ya = pos[a + 1] - y0, yb = pos[b + 1] - y0;
      if ((ya < 0) !== (yb < 0)) { const f = ya / (ya - yb); if (m < 2) { P[m * 2] = pos[a] + f * (pos[b] - pos[a]); P[m * 2 + 1] = pos[a + 2] + f * (pos[b + 2] - pos[a + 2]); } m++; }
    }
    if (m !== 2) continue;
    r.n++; r.per += Math.hypot(P[0] - P[2], P[1] - P[3]);
    for (const o of [0, 2]) { r.x = [Math.min(r.x[0], P[o]), Math.max(r.x[1], P[o])]; r.z = [Math.min(r.z[0], P[o + 1]), Math.max(r.z[1], P[o + 1])]; }
  }
  return r;
}
/** Number of interior edges of the triangles [t0, t1) whose two faces make a dihedral angle of more than 90 degrees (a crease or a fold in the surface). */
function creaseCount(pos, idx, part) {
  const first = new Map(), n = [];
  for (let t = part.triStart; t < part.triEnd; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
    n.push(x / l, y / l, z / l, l);
  }
  let count = 0;
  for (let t = part.triStart; t < part.triEnd; t++) for (let k = 0; k < 3; k++) {
    const a = idx[t * 3 + k], b = idx[t * 3 + (k + 1) % 3], key = Math.min(a, b) * 4194304 + Math.max(a, b), o = first.get(key);
    if (o === undefined) { first.set(key, t); continue; }
    const i = (t - part.triStart) * 4, j = (o - part.triStart) * 4;
    if (n[i + 3] < 1e-12 || n[j + 3] < 1e-12) continue;
    if (n[i] * n[j] + n[i + 1] * n[j + 1] + n[i + 2] * n[j + 2] < 0) count++;
  }
  return count;
}
/** Triangles of `part` whose posed face normal points against the blended, transformed rest normals of their vertices (a fold: the skin turned inside out there). */
function foldedTriangles(mesh, M, posed, part) {
  const geo = mesh.geometry, idx = geo.index.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array, nrm = geo.attributes.normal.array, sn = new Float64Array(posed.length);
  for (let v = 0; v < posed.length / 3; v++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k]; if (!w) continue;
      const o = si[v * 4 + k] * 16, nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      x += w * (M[o] * nx + M[o + 4] * ny + M[o + 8] * nz); y += w * (M[o + 1] * nx + M[o + 5] * ny + M[o + 9] * nz); z += w * (M[o + 2] * nx + M[o + 6] * ny + M[o + 10] * nz);
    }
    sn[v * 3] = x; sn[v * 3 + 1] = y; sn[v * 3 + 2] = z;
  }
  let folded = 0;
  for (let t = part.triStart; t < part.triEnd; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = posed[b] - posed[a], uy = posed[b + 1] - posed[a + 1], uz = posed[b + 2] - posed[a + 2], vx = posed[c] - posed[a], vy = posed[c + 1] - posed[a + 1], vz = posed[c + 2] - posed[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, fl = Math.hypot(fx, fy, fz);
    let x = 0, y = 0, z = 0;
    for (const q of [a, b, c]) { x += sn[q]; y += sn[q + 1]; z += sn[q + 2]; }
    const l = Math.hypot(x, y, z) || 1;
    if (fl > 1e-12 && (fx * x + fy * y + fz * z) / (fl * l) < -0.3) folded++;
  }
  return folded;
}
function hipBodies() {
  const out = [["1780 M 52 kg", P(1780, "M", 52)], ["1780 M 150 kg", P(1780, "M", 150)], ["1600 F 120 kg", P(1600, "F", 120)], ["1450 F", P(1450, "F")], ["2050 M", P(2050, "M")]];
  if (HAVE_POPS) for (const [c, r, s, pct] of [["united-states", "army", "F", 50], ["united-states", "army", "F", 5], ["united-states", "army", "M", 50], ["united-states", "army", "M", 95], ["united-states", "officers", "M", 5], ["united-states", "air-force", "F", 50], ["united-states", "aircrew", "both", 50]]) if (fs.existsSync(popFile(c, r, s))) out.push([`${c}/${r}/${s} P${pct}`, popProfile(c, r, s, pct)]);
  return out;
}

test("regression, the hip: no thigh in front of the pelvis, no shelf under it, no ledge on its side, no overlap of the thighs, no crease in the leg", () => {
  const rows = [];
  for (const [label, prof] of hipBodies()) {
    const body = fitBody(prof), skin = buildSkin(body, makeBones(body)), geo = skin.mesh.geometry, pos = geo.attributes.position.array, idx = geo.index.array, parts = skin.mesh.userData.parts;
    const yh = body.positions.hip_L[1], yb = body.shape.tubes.torso.rings.find((r) => r.id === "buttock").c[1];
    // at the hip joint the trunk is the front, the back and the side of the body: the thigh is inside it (it used to stand up to 81 mm in front of the belly and 5 mm out of the hip)
    const t = cut(pos, idx, parts.torso, yh), l = cut(pos, idx, parts.leg_L, yh);
    assert.ok(l.z[1] - t.z[1] <= 0.005, `${label}: the thigh is ${mm(l.z[1] - t.z[1]).toFixed(0)} mm in front of the trunk at the hip joint`);
    assert.ok(l.x[1] - t.x[1] <= 0.0005, `${label}: the thigh is ${mm(l.x[1] - t.x[1]).toFixed(0)} mm wider than the trunk at the hip joint`);
    // 30 mm under the buttock ring the back of the thigh runs into the buttock (it used to be 89 mm in front of it: the underside of the pelvis was a shelf)
    const tb = cut(pos, idx, parts.torso, yb - 0.03), lb = cut(pos, idx, parts.leg_L, yb - 0.03);
    assert.ok(lb.z[0] - tb.z[0] <= 0.03, `${label}: the back of the thigh is ${mm(lb.z[0] - tb.z[0]).toFixed(0)} mm in front of the back of the buttock 30 mm under its ring`);
    // the thighs touch at most (up to 60 mm overlap before)
    for (const dy of [0.04, 0.12, 0.25]) {
      const a = cut(pos, idx, parts.leg_L, yh - dy), b = cut(pos, idx, parts.leg_R, yh - dy);
      if (a.n && b.n) assert.ok(a.x[0] - b.x[1] >= 0.003, `${label}: the thighs overlap by ${mm(b.x[1] - a.x[0]).toFixed(0)} mm ${mm(dy).toFixed(0)} mm under the hip`);
    }
    // no crease (a dihedral angle of more than 90 degrees) in the leg: the outer edge was narrowed in steps and the dome joined the ring at a kink (62 creases per leg)
    for (const s of ["L", "R"]) assert.ok(creaseCount(pos, idx, parts[`leg_${s}`]) <= 2, `${label}: leg_${s} has ${creaseCount(pos, idx, parts[`leg_${s}`])} creased edges`);
    // the measured thigh ring (the furrow) is kept to 2 % of its girth
    const ring = body.shape.tubes.thigh_L.rings.find((r) => r.id === "th_prox"), c = cut(pos, idx, parts.leg_L, ring.c[1]);
    assert.ok(Math.abs(c.per / ringPerimeterOf(ring) - 1) < 0.02, `${label}: the thigh girth at the furrow is ${((c.per / ringPerimeterOf(ring) - 1) * 100).toFixed(1)} % off the ring`);
    rows.push([l.z[1] - t.z[1], lb.z[0] - tb.z[0]]);
    skin.dispose();
  }
  console.log(`  hip, ${rows.length} bodies: the thigh front is ${mm(Math.max(...rows.map((r) => r[0]))).toFixed(0)} mm in front of the trunk at worst (was +81), the back of the thigh ${mm(Math.max(...rows.map((r) => r[1]))).toFixed(0)} mm in front of the buttock (was 89)`);
});
const ringPerimeterOf = (r) => { const a = r.rx, b = r.rz, h = ((a - b) / (a + b)) ** 2; return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))); }; // n = 2 (the thigh rings are ellipses)

test("regression, the thigh of a very large thigh does not fold on itself (ANSUR II #6275: a ring of 814 mm was lofted to 1252 mm)", { skip: !HAVE_DB }, () => {
  const row = db().prepare("select * from subjects where dataset = ? and subject_key = ?").get("ansur_ii_2012", 6275);
  if (!row) return;
  const body = fitBody(subjectProfile(row)), skin = buildSkin(body, makeBones(body)), geo = skin.mesh.geometry, pos = geo.attributes.position.array, idx = geo.index.array, leg = skin.mesh.userData.parts.leg_L;
  const ring = body.shape.tubes.thigh_L.rings.find((r) => r.id === "th_prox"), c = cut(pos, idx, leg, ring.c[1]);
  assert.ok(c.per / ringPerimeterOf(ring) < 1.03 && c.per / ringPerimeterOf(ring) > 0.97, `thigh section ${mm(c.per).toFixed(0)} mm for a ring of ${mm(ringPerimeterOf(ring)).toFixed(0)}`);
  // the section never exceeds 1.2 times the ring anywhere between the hip and the knee
  const yk = body.positions.knee_L[1];
  for (let y = body.positions.hip_L[1]; y > yk; y -= 0.02) { const s = cut(pos, idx, leg, y); assert.ok(s.per < 1.2 * ringPerimeterOf(ring) * 1.1, `thigh section ${mm(s.per).toFixed(0)} mm at ${mm(y).toFixed(0)} mm`); }
  assert.ok(creaseCount(pos, idx, leg) <= 2);
  skin.dispose();
});

test("regression, the shoulder: no arm skin within 40 mm of the deltoid, nor above it, is wider than the measured bideltoid breadth (+16 mm median before, 68 mm at worst)", { skip: !HAVE_POPS }, () => {
  const worst = [];
  for (const [c, r, s, pct] of [["united-states", "officers", "M", 5], ["united-states", "army", "F", 5], ["united-states", "army", "M", 50], ["united-states", "army", "F", 95], ["united-states", "air-force", "F", 5]]) {
    if (!fs.existsSync(popFile(c, r, s))) continue;
    const body = fitBody(popProfile(c, r, s, pct)), skin = buildSkin(body, makeBones(body)), pos = skin.mesh.geometry.attributes.position.array, arm = skin.mesh.userData.parts.arm_L;
    const bid = body.report.find((q) => q.id === "bideltoid_breadth" && q.kind === "measure"), dl = body.shape.tubes.upper_arm_L.rings.find((q) => q.id === "ua_deltoid");
    if (!bid || bid.input === null) continue;
    let w = 0;
    for (let v = arm.vertexStart; v < arm.vertexEnd; v++) if (pos[v * 3 + 1] >= dl.c[1] - 0.04 && pos[v * 3 + 1] <= dl.c[1] + 0.06) w = Math.max(w, pos[v * 3]);
    worst.push(mm(2 * w) - bid.input);
    assert.ok(Math.abs(mm(2 * w) - bid.input) < 8, `${c}/${r}/${s} P${pct}: the mesh is ${(mm(2 * w) - bid.input).toFixed(1)} mm wider across the deltoids than the measured ${bid.input} mm`);
    skin.dispose();
  }
  assert.ok(worst.length >= 3);
});

test("regression, shoulder abduction 180: the root of the arm does not collapse or stretch (an edge shrank to 0.000 of its length, others stretched 3.1 times)", () => {
  for (const [who, prof] of [["man", P(1750, "M", 80)], ["heavy man", P(1780, "M", 150)]]) {
    const body = fitBody(prof), rig = rigOf(body), mesh = rig.skin, geo = mesh.geometry, pos = geo.attributes.position.array, idx = geo.index.array, arm = mesh.userData.parts.arm_L;
    applyPose(rig, { angles: { shoulder_L: [0, 180, 0] } });
    const out = skinAll(mesh, boneMatrices(mesh));
    let lo = Infinity, hi = 0;
    for (let t = arm.triStart; t < arm.triEnd; t++) for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k] * 3, b = idx[t * 3 + (k + 1) % 3] * 3, r0 = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
      if (r0 < 0.0015) continue;
      const r = Math.hypot(out[a] - out[b], out[a + 1] - out[b + 1], out[a + 2] - out[b + 2]) / r0;
      lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    assert.ok(lo > 0.05 && hi < 2.4, `${who}: edges of the arm go from ${lo.toFixed(3)} to ${hi.toFixed(2)} times their length at abduction 180`);
    rig.dispose();
  }
});

test("regression, deep flexion: a bent knee keeps its volume (88 % of the leg, 84.5 before) and folds fewer triangles; a trunk bent forward folds less", () => {
  const POSES = {
    "kneeling on the heels": { angles: { ...both("hip", [125, 0, 0]), ...both("knee", [155, 0]), ...both("ankle", [-50, 0, 0]) } },
    "deep squat": { angles: { ...both("hip", [125, 15, 0]), ...both("knee", [150, 0]), ...both("ankle", [30, 0, 0]) } },
  };
  for (const [who, prof] of [["man", P(1750, "M", 80)], ["heavy man", P(1780, "M", 150)]]) {
    const body = fitBody(prof), rig = rigOf(body), mesh = rig.skin, geo = mesh.geometry, pos = geo.attributes.position.array, parts = mesh.userData.parts;
    for (const [name, def] of Object.entries(POSES)) {
      applyPose(rig, def);
      const M = boneMatrices(mesh), out = skinAll(mesh, M);
      for (const s of ["L", "R"]) {
        const p = parts[`leg_${s}`], ratio = partVolume(mesh, out, p) / partVolume(mesh, pos, p), folded = foldedTriangles(mesh, M, out, p);
        assert.ok(ratio > 0.86, `${who} / ${name}: leg_${s} keeps ${(ratio * 100).toFixed(1)} % of its volume`);
        assert.ok(folded <= 95, `${who} / ${name}: ${folded} triangles of leg_${s} are folded`);
      }
    }
    if (who === "heavy man") {
      applyPose(rig, { angles: both("hip", [80, 0, 0]), spine: { lumbar: [50, 0, 0], thoracic: [30, 0, 0] } });
      const M = boneMatrices(mesh), out = skinAll(mesh, M), p = parts.torso, ratio = partVolume(mesh, out, p) / partVolume(mesh, pos, p), folded = foldedTriangles(mesh, M, out, p);
      assert.ok(ratio > 0.8 && folded <= 250, `heavy man bent over: the trunk keeps ${(ratio * 100).toFixed(1)} % of its volume, ${folded} triangles are folded`);
    }
    rig.dispose();
  }
});

test("regression, polish: the foot is wider than the shank at the ankle (no zigzag line), the fingertips are round, the low-quality head is smooth and keeps its face rows", () => {
  const body = fitBody(HAVE_POPS ? popProfile("united-states", "army", "M", 50) : P(1750, "M", 80)), bones = makeBones(body), skin = buildSkin(body, bones), geo = skin.mesh.geometry, pos = geo.attributes.position.array, idx = geo.index.array, parts = skin.mesh.userData.parts;
  // ankle: the foot's half width at the ankle is at least the shank's + 4.5 mm (it was equal: two walls meeting at a tangent)
  const foot = parts.foot_L, last = body.shape.tubes.shank_L.rings.at(-1), zA = body.positions.ankle_L[2];
  let wide = 0;
  for (let v = foot.vertexStart; v < foot.vertexEnd; v++) if (Math.abs(pos[v * 3 + 2] - zA) < 0.004) wide = Math.max(wide, Math.abs(pos[v * 3] - last.c[0]));
  assert.ok(wide >= last.rx + 0.0045, `the foot is ${mm(wide).toFixed(1)} mm wide (half) at the ankle for a shank of ${mm(last.rx).toFixed(1)}`);
  // fingertips: 0.15 r above the tip the section is already narrower than 0.62 r (a hemisphere: 0.53 r; the 0.55 r dome of before: 0.68 r)
  for (const f of ["index", "middle", "ring", "little", "thumb"]) {
    const p = parts[`${f}_L`], r3 = body.shape.hands.L.fingers[f].radiusZ[3];
    let ymin = Infinity;
    for (let v = p.vertexStart; v < p.vertexEnd; v++) ymin = Math.min(ymin, pos[v * 3 + 1]);
    const s = cut(pos, idx, p, ymin + 0.15 * r3);
    assert.ok(s.n > 0 && Math.max(s.x[1] - s.x[0], s.z[1] - s.z[0]) / 2 <= 0.62 * r3, `${f}: the tip is ${(Math.max(s.x[1] - s.x[0], s.z[1] - s.z[0]) / 2 / r3).toFixed(2)} r wide 0.15 r above its end`);
  }
  skin.dispose();
  // low quality: the top of the skull has no facets of more than 19 degrees, and the face has 12 rows from the glabella to the subnasale (10 before)
  const lo = buildSkin(body, bones, { quality: "low" }), lg = lo.mesh.geometry, lp = lg.attributes.position.array, li = lg.index.array, hd = lo.mesh.userData.parts.head;
  const yTop = body.shape.head.cranium.c[1] + 0.6 * body.shape.head.cranium.r[1], nrm = new Map(), tri = [];
  for (let t = hd.triStart; t < hd.triEnd; t++) {
    const a = li[t * 3] * 3, b = li[t * 3 + 1] * 3, c = li[t * 3 + 2] * 3;
    const ux = lp[b] - lp[a], uy = lp[b + 1] - lp[a + 1], uz = lp[b + 2] - lp[a + 2], vx = lp[c] - lp[a], vy = lp[c + 1] - lp[a + 1], vz = lp[c + 2] - lp[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
    tri.push([x / l, y / l, z / l]);
    for (let k = 0; k < 3; k++) {
      const p = li[t * 3 + k], q = li[t * 3 + (k + 1) % 3], key = Math.min(p, q) * 4194304 + Math.max(p, q);
      if (lp[p * 3 + 1] > yTop && lp[q * 3 + 1] > yTop) { const o = nrm.get(key); if (o === undefined) nrm.set(key, t - hd.triStart); else nrm.set(key, [o, t - hd.triStart]); }
    }
  }
  let worstAngle = 0;
  for (const v of nrm.values()) if (Array.isArray(v)) { const d = tri[v[0]][0] * tri[v[1]][0] + tri[v[0]][1] * tri[v[1]][1] + tri[v[0]][2] * tri[v[1]][2]; worstAngle = Math.max(worstAngle, (Math.acos(Math.min(1, d)) * 180) / Math.PI); }
  assert.ok(worstAngle < 19, `the top of the low-quality skull has a facet angle of ${worstAngle.toFixed(1)} degrees`);
  const gl = body.landmarks.glabella, sn = body.landmarks.subnasale, yg = body.positions[gl.joint][1] + gl.offset[1], ys = body.positions[sn.joint][1] + sn.offset[1], rows = new Set();
  for (let v = hd.vertexStart; v < hd.vertexEnd; v++) if (Math.abs(lp[v * 3]) < 0.0025 && lp[v * 3 + 1] <= yg && lp[v * 3 + 1] >= ys && lp[v * 3 + 2] > 0.05) rows.add(lp[v * 3 + 1].toFixed(5));
  assert.ok(rows.size >= 12, `${rows.size} face rows between the glabella and the subnasale`);
  assert.ok(lo.stats.triangles < 20000, `${lo.stats.triangles} triangles in low quality`);
  lo.dispose();
});
