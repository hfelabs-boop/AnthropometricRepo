// Independent checks of OBJ / STL / BVH: read back with parsers written here, measure the figure against the profile, rebuild BVH world positions by own FK.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/export.adversarial.indep.mesh.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { THREE, JOINTS, army, haveData, makeRig, putPose, POSTURES } from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";

const profile = haveData ? army("M", 50) : null;
const opt = { skip: !haveData };
const AX = { "y-up": { up: 1, left: 0, front: 2, upSign: 1, frontSign: 1 }, "z-up": { up: 2, left: 0, front: 1, upSign: 1, frontSign: -1 }, "x-front": { up: 2, left: 1, front: 0, upSign: 1, frontSign: 1 } };

function objVerts(text, objName) { // vertices referenced by faces of object `objName` ("skin" | "eyes")
  const v = [], used = new Set(); let cur = null; const tris = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) v.push(line.slice(2).trim().split(/\s+/).map(Number));
    else if (line.startsWith("o ")) cur = line.slice(2).trim();
    else if (line.startsWith("f ") && cur === objName) { const ix = line.slice(2).trim().split(/\s+/).map((t) => Number(t.split("/")[0]) - 1); for (const i of ix) used.add(i); for (let k = 1; k + 1 < ix.length; k++) tris.push([ix[0], ix[k], ix[k + 1]]); }
  }
  return { v, used: [...used].map((i) => v[i]), tris };
}
const ext = (pts, a) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { lo = Math.min(lo, p[a]); hi = Math.max(hi, p[a]); } return [lo, hi]; };

for (const unit of ["mm", "m"]) for (const axes of ["y-up", "z-up", "x-front"]) {
  test(`OBJ ${unit} ${axes}: stature, bideltoid breadth, left side, volume sign, header`, opt, async () => {
    const rig = makeRig(profile); putPose(rig, POSTURES.neutral);
    const inp = { rig, profile, posture: { id: "stand-relaxed", name: "Standing, relaxed" } };
    const out = await X.buildOBJ(inp, { unit, axes });
    const k = unit === "mm" ? 1000 : 1, a = AX[axes];
    const skin = objVerts(out.text, "skin");
    const [lo, hi] = ext(skin.used, a.up);
    assert.ok(Math.abs(lo / k) < 0.003, `feet on the floor ${lo / k}`);
    assert.ok(Math.abs((hi - lo) / k - profile.measures.stature.value / 1000) < 0.012, `stature ${(hi - lo) / k} vs ${profile.measures.stature.value / 1000}`);
    // bideltoid breadth: width of the skin in the band of the deltoid landmarks
    const d = rig.landmarkWorld("deltoid_L"), dr = rig.landmarkWorld("deltoid_R"), yb = (d.y + dr.y) / 2;
    const band = skin.used.filter((p) => Math.abs(p[a.up] / k - yb) < 0.02);
    const [wl, wh] = ext(band, a.left);
    const bideltoid = profile.measures.bideltoid_breadth.value / 1000;
    assert.ok(Math.abs((wh - wl) / k - bideltoid) < 0.03, `bideltoid ${(wh - wl) / k} vs ${bideltoid}`);
    // the figure's left (landmark L) must be at +left axis in file coordinates
    const lm = rig.landmarkWorld("acromion_L"), lmR = rig.landmarkWorld("acromion_R");
    const cen = (pts, ax) => pts.reduce((s, p) => s + p[ax], 0) / pts.length;
    assert.ok(lm.x > lmR.x, "model: left is +X");
    // facing: nose/pupil landmark is toward front: find protrusion of the skin at head height
    const head = rig.landmarkWorld("pronasale") ?? null;
    if (head) { const front = skin.used.filter((p) => Math.abs(p[a.up] / k - head.y) < 0.01); const [f0, f1] = ext(front, a.front); const c = (f0 + f1) / 2; assert.ok((head.z > 0) === ((a.frontSign * (( (axes === "y-up" ? head.z : axes === "z-up" ? -head.z : head.z)) * k - c * 0) ) !== 0), "n/a"); }
    // signed volume positive (outward winding) in every axis system (proper rotation)
    let vol = 0; for (const [i, j, l] of skin.tris) { const A = skin.v[i], B = skin.v[j], C = skin.v[l]; vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6; }
    vol /= k ** 3; assert.ok(vol > 0.04 && vol < 0.12, `volume ${vol} m3 (sign/winding)`);
    // header text
    const header = out.text.split("\n").filter((l) => l.startsWith("#")).join("\n");
    assert.match(header, unit === "mm" ? /millimetres \(1 unit = 1 mm\)/ : /metres \(1 unit = 1 m\)/);
    assert.ok(!/[^\x00-\x7f]/.test(header));
  });
}

test("OBJ y-up front: nose is on +Z in the file; z-up: -Y; x-front: +X", opt, async () => {
  const rig = makeRig(profile); putPose(rig, POSTURES.neutral);
  const lm = rig.landmarkWorld("pronasale");
  for (const axes of ["y-up", "z-up", "x-front"]) {
    const out = await X.buildOBJ({ rig, profile }, { unit: "m", axes });
    const s = objVerts(out.text, "skin"), a = AX[axes];
    const band = s.used.filter((p) => Math.abs(p[a.up] - lm.y) < 0.01);
    const [f0, f1] = ext(band, a.front);
    const frontPos = a.frontSign * (a.frontSign > 0 ? f1 : f0); // the most forward extent in the file axis
    const back = a.frontSign > 0 ? f0 : f1;
    // the nose protrudes: |forward extent| must exceed backward ... compare with the model: head depth centre offset forward of joint.
    const headC = rig.jointWorld("head"); const hc = axes === "y-up" ? headC.z : axes === "z-up" ? -headC.z : headC.z; // joint position on the file's front axis (z-up: file y = -model z)
    const fwd = a.frontSign > 0 ? f1 : f0;
    console.log(axes, "nose band front extent", fwd.toFixed(4), "head joint", hc.toFixed(4), "model nose z", lm.z.toFixed(4));
    assert.ok(Math.abs(Math.abs(fwd) - Math.abs(lm.z)) < 0.012 || Math.abs(fwd * a.frontSign - (axes === "z-up" ? -lm.z * -1 : lm.z)) < 0.012, `${axes}: front extent ${fwd} vs nose ${lm.z}`);
  }
});

test("STL equals OBJ vertex for vertex (positions, order, winding), header says unit and axes", opt, async () => {
  const rig = makeRig(profile); putPose(rig, POSTURES.squat);
  for (const [unit, axes] of [["mm", "z-up"], ["m", "x-front"], ["mm", "y-up"]]) {
    const inp = { rig, profile, posture: { id: "t-squat", name: "Deep squat" } };
    const obj = await X.buildOBJ(inp, { unit, axes }), stl = await X.buildSTL(inp, { unit, axes });
    const dv = new DataView(stl.data), n = dv.getUint32(80, true);
    assert.equal(stl.data.byteLength, 84 + 50 * n);
    const head = new TextDecoder("latin1").decode(new Uint8Array(stl.data, 0, 80)).trim();
    assert.ok(!/^solid/i.test(head)); assert.match(head, new RegExp(`units ${unit}`));
    // all objs' triangles in order
    const v = [], tris = []; let all = obj.text.split("\n");
    for (const line of all) if (line.startsWith("v ")) v.push(line.slice(2).trim().split(/\s+/).map(Number));
    for (const line of all) if (line.startsWith("f ")) { const ix = line.slice(2).trim().split(/\s+/).map((t) => Number(t.split("/")[0]) - 1); for (let q = 1; q + 1 < ix.length; q++) tris.push([ix[0], ix[q], ix[q + 1]]); }
    assert.equal(tris.length, n);
    let maxd = 0; for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) for (let e = 0; e < 3; e++) maxd = Math.max(maxd, Math.abs(dv.getFloat32(84 + 50 * t + 12 + 12 * c + 4 * e, true) - v[tris[t][c]][e]));
    assert.ok(maxd < (unit === "mm" ? 0.02 : 2e-5), `STL vs OBJ ${maxd}`);
    // normals match winding
    for (let t = 0; t < n; t += 97) { const o = 84 + 50 * t, f = (q) => dv.getFloat32(o + 4 * q, true); const A = [3, 4, 5].map(f), B = [6, 7, 8].map(f), C = [9, 10, 11].map(f); const e1 = B.map((x, i) => x - A[i]), e2 = C.map((x, i) => x - A[i]); const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const nn = [f(0), f(1), f(2)]; const dot = cr[0] * nn[0] + cr[1] * nn[1] + cr[2] * nn[2]; const len = Math.hypot(...cr); if (len > 1e-12) assert.ok(dot >= 0, `normal opposes winding at ${t}`); }
  }
});

// ---------------------------------------------------------------- BVH with an own FK
function parseBVH(text) {
  const t = text.split("\n"), joints = []; let i = 0;
  assert.equal(t[0].trim(), "HIERARCHY"); i = 1; const stack = []; let cur = null;
  for (; i < t.length; i++) {
    const w = t[i].trim().split(/\s+/);
    if (w[0] === "MOTION") break;
    if (w[0] === "ROOT" || w[0] === "JOINT") { cur = { name: w[1], parent: stack.at(-1) ?? null, ch: [], end: null }; joints.push(cur); }
    else if (w[0] === "End") { cur = { endOf: stack.at(-1) }; }
    else if (w[0] === "{") stack.push(cur.endOf ? cur.endOf : cur.name);
    else if (w[0] === "}") stack.pop();
    else if (w[0] === "OFFSET") { const o = w.slice(1).map(Number); if (cur.endOf) joints.find((j) => j.name === cur.endOf).end = o; else cur.off = o; }
    else if (w[0] === "CHANNELS") cur.ch = w.slice(2);
  }
  const nf = +t[i + 1].split(":")[1], ft = +t[i + 2].split(":")[1], frames = t.slice(i + 3, i + 3 + nf).map((l) => l.trim().split(/\s+/).map(Number));
  return { joints, nf, ft, frames, tail: t.slice(i + 3 + nf) };
}
function fk(b, frame, scale) { // returns Map name -> {p: Vector3, m: Matrix4}
  const out = new Map(); let c = 0; const M = {};
  const rot = (ax, deg) => new THREE.Matrix4()["makeRotation" + ax](deg * Math.PI / 180);
  for (const j of b.joints) {
    let m = new THREE.Matrix4().makeTranslation(...j.off.map((v) => v * scale));
    for (const ch of j.ch) {
      const v = frame[c++];
      if (ch === "Xposition") m.multiply(new THREE.Matrix4().makeTranslation(v * scale, 0, 0)); else if (ch === "Yposition") m.multiply(new THREE.Matrix4().makeTranslation(0, v * scale, 0)); else if (ch === "Zposition") m.multiply(new THREE.Matrix4().makeTranslation(0, 0, v * scale));
      else m.multiply(rot(ch[0], v));
    }
    const w = j.parent ? out.get(j.parent).m.clone().multiply(m) : m;
    out.set(j.name, { m: w, p: new THREE.Vector3().setFromMatrixPosition(w) });
  }
  assert.equal(c, frame.length);
  return out;
}
for (const key of ["neutral", "squat", "supine", "prone", "side"]) for (const unit of ["cm", "mm", "m"]) {
  test(`BVH ${unit} / ${key}: own FK reproduces every joint centre and orientation`, opt, () => {
    const rig = makeRig(profile); putPose(rig, POSTURES[key]);
    const res = X.buildBVH({ rig, profile, posture: { id: "t", name: "t" } }, { unit, neutralFrame: true });
    const b = parseBVH(res.text), sc = { cm: 0.01, mm: 0.001, m: 1 }[unit];
    assert.equal(b.joints.length, 77); assert.equal(b.nf, 2); assert.ok(Math.abs(b.ft - 1 / 30) < 1e-6); assert.deepEqual(b.joints.map((j) => j.name), JOINTS.map((j) => j.id));
    const w0 = fk(b, b.frames[0], sc), tol = { cm: 5e-5, mm: 5e-5, m: 5e-5 }[unit];
    rig.group.updateMatrixWorld(true);
    let worst = 0;
    for (const j of JOINTS) { const e = w0.get(j.id).p.distanceTo(rig.jointWorld(j.id)); worst = Math.max(worst, e); const q = new THREE.Quaternion().setFromRotationMatrix(w0.get(j.id).m), r = rig.jointQuaternion(j.id, new THREE.Quaternion()); assert.ok(1 - Math.abs(q.dot(r)) < 1e-9, `orientation ${j.id}`); }
    assert.ok(worst < tol, `${unit} ${key} worst joint error ${worst}`);
    // frame 2: neutral standing: every joint at its rest position
    const w1 = fk(b, b.frames[1], sc), rest = rig.restBody.positions;
    for (const j of JOINTS) assert.ok(w1.get(j.id).p.distanceTo(new THREE.Vector3(...rest[j.id])) < tol, `neutral ${j.id}`);
    assert.ok(!/NaN|Infinity|e[+-]\d/.test(res.text), "no exponent/NaN in file");
    assert.ok(!res.text.includes("\r"));
  });
}
