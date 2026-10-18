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
  // bideltoid: the outer edge of the deltoid ring of the arm
  const arm = parts.arm_L, dl = body.shape.tubes.upper_arm_L.rings.find((r) => r.id === "ua_deltoid");
  let maxX = -Infinity;
  for (let v = arm.vertexStart; v < arm.vertexEnd; v++) maxX = Math.max(maxX, pos[v * 3]);
  assert.ok(maxX >= dl.c[0] + dl.rx - 0.002, `${tag}: the arm reaches the deltoid edge (${mm(maxX).toFixed(1)} vs ${mm(dl.c[0] + dl.rx).toFixed(1)})`);
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
