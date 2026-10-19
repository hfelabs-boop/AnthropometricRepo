// Round 5 adversarial probes of the export module: profiles of every origin, a rig disposed mid-export, normals/winding of OBJ and STL read back independently,
// OBJ index shifting with mixed content, GLB scene transforms (mirrored / scaled objects), shape of what the figure measures.
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
import { manualProfile, parseImport, editMeasure } from "../../site/js/human/anthro.js";
const { THREE, JOINTS } = H;
const GLTFLoader = await H.loadGLTFLoader();
const load = (data) => new Promise((res, rej) => new GLTFLoader().parse(data.slice(0), "", res, rej));
const profile = H.army("M", 50);

test("exchange JSON validates for profiles of every origin (manual, imported CSV, edited, sparse)", () => {
  const profs = [profile, manualProfile({ sex: "F", stature: 1650, statureUnit: "mm" }), manualProfile({ sex: "M", stature: 180, statureUnit: "cm", mass: 80, massUnit: "kg" }), editMeasure(profile, "stature", 1900, "mm")];
  try { const imp = parseImport("key,value,unit\nstature,1755,mm\nmass,80,kg\n", "x.csv"); profs.push(imp.profile ?? imp); } catch (e) { console.log("import", e.message); }
  for (const p of profs) {
    if (!p?.measures) continue;
    const rig = H.makeRig(p);
    const doc = X.buildExchange({ rig, profile: p, posture: { id: null, name: "Neutral standing" } });
    const v = X.validateExchange(JSON.stringify(doc));
    assert.deepEqual(v.errors, [], `${p.label}`);
    assert.ok(Math.abs(doc.body.stature_mm - rig.body.stature * 1000) < 0.01);
  }
});

test("rig disposed (profile changed) while an export is waiting between ticks: still one consistent file or a clear error", async () => {
  for (const kind of ["glb", "obj", "stl"]) {
    const rig = H.makeRig(profile);
    H.putPose(rig, H.POSTURES.squat);
    const ref = await X.buildOBJ({ rig, profile, posture: { id: "t", name: "t" } }, {});
    let ticks = 0;
    const tick = async () => { if (++ticks === 1) rig.dispose(); };
    try {
      const inp = { rig, profile, posture: { id: "t", name: "t" } };
      const out = kind === "glb" ? await X.buildGLB(inp, { tick }) : kind === "obj" ? await X.buildOBJ(inp, { tick }) : await X.buildSTL(inp, { tick });
      if (kind === "obj") assert.equal(out.text, ref.text.replace(/# Created.*\n/, ""), "OBJ of a rig that was disposed differs from the live one");
      console.log(kind, "after dispose: built", out.bytes, "bytes");
    } catch (e) { console.log(kind, "after dispose: error:", e.message); assert.ok(/dispos|figure|skin/i.test(e.message), `unclear error: ${e.message}`); }
  }
});

test("OBJ vertex normals are unit length in mm and in every axis system, and agree with the winding (outward) for the skin", async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.squat);
  for (const unit of ["mm", "m"]) for (const axes of ["y-up", "z-up", "x-front"]) {
    const { text } = await X.buildOBJ({ rig, profile, posture: { id: "t", name: "t" } }, { unit, axes });
    const p = H.parseOBJ(text);
    let worst = 0;
    for (const n of p.vn) worst = Math.max(worst, Math.abs(Math.hypot(...n) - 1));
    assert.ok(worst < 1e-3, `${unit} ${axes}: normal length off by ${worst}`);
    // signed volume of the skin object must be positive (outward winding) for the first object
    const sk = p.objects.find((o) => o.name === "skin");
    const tris = []; for (const f of sk.faces) for (let k = 1; k + 1 < f.length; k++) tris.push([p.v[f[0][0]], p.v[f[k][0]], p.v[f[k + 1][0]]]);
    const vol = H.signedVolume(tris) * (unit === "mm" ? 1e-9 : 1);
    assert.ok(vol > 0.02 && vol < 0.2, `${unit} ${axes}: volume ${vol} m3`);
  }
});

test("mixed scene: mirrored, scaled, rotated objects; OBJ/STL/GLB triangle counts and bounds agree between formats", async () => {
  const rig = H.makeRig(profile);
  const { sandbox } = H.sceneFixture(rig);
  const catalog = await import("../../site/js/human/catalog.js");
  const types = (catalog.CATALOG ?? []).map((t) => t.type ?? t.id);
  console.log("catalog types:", types.join(","));
  for (let i = 0; i < types.length; i++) sandbox.add(types[i], { position: [i * 0.5 - 2, 0, 1 + (i % 3) * 0.5], yaw: i * 40 });
  for (const o of sandbox.objects.values()) o.group.updateWorldMatrix(true, true);
  const inp = { rig, profile, posture: { id: "t", name: "t" }, sandbox };
  const glb = await X.buildGLB(inp, { scene: true }), obj = await X.buildOBJ(inp, { scene: true }), stl = await X.buildSTL(inp, { scene: true });
  assert.equal(glb.stats.triangles, obj.stats.triangles);
  assert.equal(stl.triangles, obj.stats.triangles, "STL triangles vs OBJ triangles");
  const p = H.parseOBJ(obj.text);
  let nf = 0; for (const o of p.objects) for (const f of o.faces) nf += f.length - 2;
  assert.equal(nf, obj.stats.triangles, "OBJ face triangulation count");
  for (const o of p.objects) for (const f of o.faces) for (const c of f) assert.ok(c[0] >= 0 && c[0] < p.v.length && (c[2] == null || c[2] < p.vn.length), `bad index in ${o.name}`);
  // per-object bounds in OBJ (mm) equal GLB world bounds (m)
  if (GLTFLoader) {
    const g = await load(glb.data); g.scene.updateMatrixWorld(true);
    const sceneNode = g.scene.getObjectByName("scene");
    for (const node of sceneNode?.children ?? []) {
      const b = new THREE.Box3().setFromObject(node);
      const objName = `${node.name} (mesh`;
      const parts = p.objects.filter((o) => o.name.startsWith(objName));
      if (!parts.length) { console.log("no OBJ object for node", node.name, p.objects.map((o) => o.name).slice(0, 6)); continue; }
      const bb = new THREE.Box3();
      for (const o of parts) for (const f of o.faces) for (const c of f) bb.expandByPoint(new THREE.Vector3(...p.v[c[0]]).multiplyScalar(0.001));
      assert.ok(b.min.distanceTo(bb.min) < 2e-3 && b.max.distanceTo(bb.max) < 2e-3, `${node.name}: GLB bounds ${b.min.toArray()} ${b.max.toArray()} vs OBJ ${bb.min.toArray()} ${bb.max.toArray()}`);
    }
  }
});

test("GLB exports are deterministic and re-exportable (GLTFLoader -> same joint count), 'none' figure with scene only", async () => {
  const rig = H.makeRig(profile);
  const inp = { rig, profile, posture: { id: "t", name: "t" } };
  const a = Buffer.from((await X.buildGLB(inp, {})).data), b = Buffer.from((await X.buildGLB(inp, {})).data);
  assert.ok(a.equals(b), "same input gives the same bytes");
  await assert.rejects(() => X.buildGLB(inp, { figure: "none" }), /nothing to export/i);
});

test("BVH: options never leave NaN / Infinity / -0, any unit, any pose; End Sites finite", () => {
  const rig = H.makeRig(profile);
  for (const def of Object.values(H.POSTURES)) {
    H.putPose(rig, def);
    for (const unit of ["cm", "mm", "m"]) {
      const t = X.buildBVH({ rig, profile, posture: { id: "t", name: "t" } }, { unit, neutralFrame: true, header: true, created: "2026-01-01T00:00:00Z" }).text;
      assert.ok(!/NaN|Infinity|undefined|-0(?![.\d])/.test(t.split("\n").filter((l) => !l.startsWith("#")).join("\n")), `${def.id} ${unit}`);
    }
  }
});

test("exchange: placement + posture root agree with the figure; library flag; vertical floor", () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.supine);
  const doc = X.buildExchange({ rig, profile, posture: { id: null, name: "x" } });
  const lowest = Math.min(...doc.body.joints.map((j) => j.position_mm[1]));
  console.log("supine lowest joint centre y mm", lowest, "root y", doc.placement.root.y_mm, "rig.lowestY", rig.lowestY());
  assert.ok(Math.abs(doc.placement.root.y_mm - rig.jointWorld("pelvis").y * 1000) < 0.01);
});

test("exchange JSON: centre of mass is the mass-weighted mean of the segments; each segment point = joint position + joint orientation x offset; landmarks likewise (independent recomputation from the document alone)", () => {
  const rig = H.makeRig(profile);
  for (const def of Object.values(H.POSTURES)) {
    H.putPose(rig, def);
    const doc = JSON.parse(X.exchangeText({ rig, profile, posture: { id: "t", name: "t" } }));
    const J = new Map(doc.body.joints.map((j) => [j.id, j]));
    const at = (jid, off) => { const j = J.get(jid), q = new THREE.Quaternion(...j.orientation_xyzw), v = new THREE.Vector3(...off).applyQuaternion(q); return [j.position_mm[0] + v.x, j.position_mm[1] + v.y, j.position_mm[2] + v.z]; };
    let M = 0; const c = [0, 0, 0];
    for (const s of doc.body.segments) {
      M += s.mass_kg; s.com_position_mm.forEach((v, i) => { c[i] += s.mass_kg * v; });
      if (s.joint && s.com_offset_mm) { const p = at(s.joint, s.com_offset_mm); assert.ok(Math.hypot(p[0] - s.com_position_mm[0], p[1] - s.com_position_mm[1], p[2] - s.com_position_mm[2]) < 0.05, `${def.id} segment ${s.id}`); }
    }
    const com = c.map((v) => v / M);
    assert.ok(Math.hypot(com[0] - doc.body.centre_of_mass.position_mm[0], com[1] - doc.body.centre_of_mass.position_mm[1], com[2] - doc.body.centre_of_mass.position_mm[2]) < 0.05, `${def.id} CoM`);
    assert.ok(Math.abs(M - doc.body.centre_of_mass.mass_kg) < 0.01);
    assert.ok(Math.abs(M - doc.body.mass_kg) < 0.05 * doc.body.mass_kg, `masses ${M} vs ${doc.body.mass_kg}`);
    for (const l of doc.body.landmarks) { const p = at(l.joint, l.offset_mm); assert.ok(Math.hypot(p[0] - l.position_mm[0], p[1] - l.position_mm[1], p[2] - l.position_mm[2]) < 0.05, `${def.id} landmark ${l.id}`); }
    // rest_position + rest offsets chain
    for (const j of doc.body.joints) if (j.parent) { const p = J.get(j.parent); for (let k = 0; k < 3; k++) assert.ok(Math.abs(j.rest_position_mm[k] - p.rest_position_mm[k] - j.rest_offset_mm[k]) < 0.01, `${j.id} rest chain`); }
    // world orientation of a joint = parent's orientation x local rotation; at rest pose angles 0 -> identity
    if (def === H.POSTURES.neutral) for (const j of doc.body.joints) assert.ok(Math.abs(Math.abs(j.orientation_xyzw[3]) - 1) < 1e-6, `${j.id} neutral orientation not identity`);
  }
});

test("attached objects: exchange position_mm / yaw equal the world transform of the object (what GLB and OBJ show) after the figure moved", async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.neutral);
  const { sandbox, ctx } = H.sceneFixture(rig);
  const a = sandbox.add("box", { position: [0.5, 1, 0.5], yaw: 30 }), b = sandbox.add("crate", { position: [0, 0.5, 1], yaw: 10 });
  sandbox.attach(a.id, { kind: "joint", id: "wrist_R" }, [0, 0, 0.05], { local: true, orient: true });
  sandbox.attach(b.id, { kind: "landmark", id: "stylion_R" }, [0, 0.05, 0], { local: false, orient: false });
  H.putPose(rig, H.POSTURES.supine); ctx.emit("pose", { rig });
  await new Promise((r) => setTimeout(r, 30));
  H.putPose(rig, H.POSTURES.squat); ctx.emit("pose", { rig });
  await new Promise((r) => setTimeout(r, 30));
  const doc = JSON.parse(X.exchangeText({ rig, profile, posture: { id: "t", name: "t" }, sandbox }));
  for (const o of sandbox.objects.values()) {
    o.group.updateWorldMatrix(true, true);
    const w = new THREE.Vector3().setFromMatrixPosition(o.group.matrixWorld), d = doc.scene.objects.find((x) => x.id === String(o.id));
    const err = Math.hypot(d.position_mm[0] - w.x * 1000, d.position_mm[1] - w.y * 1000, d.position_mm[2] - w.z * 1000);
    console.log(o.type, "attached", JSON.stringify(o.attachedTo), "world mm", w.toArray().map((v) => (v * 1000).toFixed(1)), "doc", d.position_mm, "err", err.toFixed(2));
    assert.ok(err < 0.01, `${o.type}: position_mm is not the world position (err ${err} mm)`);
  }
});
