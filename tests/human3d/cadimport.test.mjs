// CAD / 3D import (site/js/human/cadimport.js), the "cad_model" catalogue type and the environment presets of the Scene panel.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/cadimport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { formatOf, guessUnits, CAD_ACCEPT, importCadFile, getAsset, parseCad, collectLayers, occtToThree, embedAssets, restoreAssets, hashBuffer } from "../../site/js/human/cadimport.js";
import { byType, buildObject, disposeObject, normalizeParams, notifyAssetReady } from "../../site/js/human/catalog.js";
import { createSandbox, TEMPLATES, TEMPLATE_GROUPS } from "../../site/js/human/sandbox.js";
import { byId } from "../../site/js/human/postures.js";
import { surfaceIndex, nearestSurface, rayHit, insideSurface } from "../../site/js/human/clearance.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** A small two-part model in millimetres: a 1000 x 500 x 200 body and a stick on top. */
function model() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1000, 500, 200)); body.name = "Body";
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(50, 50, 300)); stick.name = "Stick"; stick.position.set(0, 400, 0);
  g.add(body, stick);
  g.updateMatrixWorld(true);
  return g;
}
const objFile = () => ({ name: "console.obj", buffer: new TextEncoder().encode(new OBJExporter().parse(model())).buffer });
const stlFile = () => ({ name: "console.stl", buffer: ab(new STLExporter().parse(model(), { binary: true })) });

test("formats: names map to formats, the accept list covers them, units and up axes are guessed by format and size", () => {
  assert.equal(formatOf("Cockpit.STEP").id, "step");
  assert.equal(formatOf("a.stp").id, "step");
  assert.equal(formatOf("b.glb").id, "gltf");
  assert.equal(formatOf("c.igs").id, "iges");
  assert.equal(formatOf("d.fbx").id, "fbx");
  assert.equal(formatOf("e.docx"), null);
  for (const e of ["glb", "gltf", "step", "stp", "iges", "igs", "stl", "obj", "ply", "fbx", "3mf", "dae", "brep"]) assert.ok(CAD_ACCEPT.split(",").includes(`.${e}`), e);
  assert.equal(guessUnits("stl", 2400)[0], "mm");
  assert.equal(guessUnits("obj", 240)[0], "mm");
  assert.equal(guessUnits("obj", 45)[0], "cm");
  assert.equal(guessUnits("obj", 2.4)[0], "m");
  assert.equal(guessUnits("gltf", 5000)[0], "m", "glTF is metres whatever its size");
  assert.equal(guessUnits("step", 3)[0], "m", "OpenCascade converts STEP to metres");
  assert.equal(guessUnits("fbx", 240)[0], "cm");
  assert.equal(guessUnits("fbx", 2)[0], "m");
});

test("import: OBJ parts become layers; units are guessed (millimetres here) and the model is kept under its SHA-256", async () => {
  const f = objFile();
  const r = await importCadFile(f);
  assert.equal(r.id, await hashBuffer(f.buffer));
  assert.equal(r.units, "mm");
  assert.equal(r.up, "y");
  assert.match(r.unitsWhy, /across/);
  assert.equal(r.fresh, true);
  assert.deepEqual(r.asset.layers.map((l) => l.name), ["Body", "Stick"]);
  assert.ok(r.asset.triangles > 12);
  assert.equal(r.stored, false, "Node has no IndexedDB: the import still works, without a stored copy");
  assert.equal(getAsset(r.id), r.asset);
  const again = await importCadFile(objFile());
  assert.equal(again.asset, r.asset, "the same file is read once");
  assert.equal(again.fresh, false);
  const forced = await importCadFile(objFile(), { units: "cm", up: "z" });
  assert.deepEqual([forced.units, forced.up, forced.unitsWhy], ["cm", "z", "chosen"]);
});

test("import: STL is taken as Z-up millimetres; a file of an unknown format, or with no surfaces, is refused with a reason", async () => {
  const r = await importCadFile(stlFile());
  assert.deepEqual([r.units, r.up], ["mm", "z"]);
  assert.equal(r.asset.layers.length, 1);
  await assert.rejects(importCadFile({ name: "notes.docx", buffer: new ArrayBuffer(8) }), /not a format/);
  await assert.rejects(parseCad(new TextEncoder().encode("# nothing here\n").buffer, "empty.obj"), /no surfaces|no model/);
});

test("cad_model: built in metres on the floor, centred; the up axis turns it; layers hide; opacity and one-colour mode; the asset survives disposal", async () => {
  const { id } = await importCadFile(objFile());
  const base = { asset: id, units: "mm", up: "y" };
  const g = buildObject("cad_model", base), b = g.userData.bbox;
  for (const [v, w] of [[b.min.x, -0.5], [b.max.x, 0.5], [b.min.y, 0], [b.max.y, 0.55 + 0.25], [b.max.z - b.min.z, 0.2]]) assert.ok(Math.abs(v - w) < 1e-6, `${v} vs ${w}`);
  const z = buildObject("cad_model", { ...base, up: "z" }).userData.bbox;
  assert.ok(Math.abs(z.max.y - 0.2) < 1e-6 && Math.abs(z.max.z - z.min.z - 0.8) < 1e-6, "Z-up: the file's Y becomes the depth");
  const cm = buildObject("cad_model", { ...base, units: "cm" }).userData.bbox;
  assert.ok(Math.abs(cm.max.x - 5) < 1e-6, "centimetres: ten times larger");
  const file = buildObject("cad_model", { ...base, origin: "file" }).userData.bbox;
  assert.ok(Math.abs(file.min.y + 0.25) < 1e-6, "the file's own origin is kept (the body is centred on it, half below the floor)");
  const hid = buildObject("cad_model", { ...base, hidden: "1" });
  const shown = []; hid.traverse((o) => { if (o.isMesh) { let v = true; for (let p = o; p; p = p.parent) v &&= p.visible; if (v) shown.push(o.name); } });
  assert.deepEqual(shown, ["Body"]);
  const t = buildObject("cad_model", { ...base, opacity: 0.4, colors: "uniform" }, { color: "#ff0000" });
  t.traverse((o) => { if (o.isMesh) { assert.equal(o.material.transparent, true); assert.ok(Math.abs(o.material.opacity - 0.4) < 1e-9); assert.equal(o.material.color.getHexString(), "ff0000"); } });
  const anchors = byType("cad_model").anchors(base);
  assert.deepEqual(Object.keys(anchors), ["top_centre", "base_centre", "centre", "front_centre", "back_centre", "origin"]);
  assert.ok(Math.abs(anchors.top_centre.position[1] - 0.8) < 1e-6);
  disposeObject(g);
  assert.ok(getAsset(id).object.children[0].geometry.attributes.position.count > 0, "the shared geometry is not disposed with a copy");
  assert.equal(normalizeParams("cad_model", { asset: "not-a-hash" }).asset, "", "only a SHA-256 is kept as an asset id");
  assert.equal(normalizeParams("cad_model", { hidden: "1,2;drop" }).hidden, "");
});

test("cad_model: an object whose model is not loaded is a placeholder, and the sandbox rebuilds it when the asset arrives", async () => {
  const vp = { scene: new THREE.Scene(), container: new EventTarget(), add(o) { this.scene.add(o); }, remove(o) { this.scene.remove(o); }, requestRender() {}, on: () => () => {}, setCursor() {}, addLabelSource: () => () => {}, removeLabelSource() {}, detachGizmo() {}, frame() {} };
  const ctx = { state: {}, viewport: vp, on: () => () => {}, emit() {}, select() {}, getRig: () => null, toast() {}, units: "mm" };
  const sb = createSandbox({ viewport: vp, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  const f = { name: "late.obj", buffer: new TextEncoder().encode(new OBJExporter().parse(model()).replace("Body", "Hull")).buffer };
  const idLate = await hashBuffer(f.buffer);
  const o = sb.add("cad_model", { params: { asset: idLate, file: "late.obj", units: "mm" }, position: [0, 0, 1] });
  assert.equal(o.model.userData.missing, true);
  assert.ok(Math.abs(o.bbox.max.x - 0.25) < 1e-6, "a 0.5 m placeholder box");
  await importCadFile(f); // registers the asset: the catalogue tells the sandbox
  assert.ok(!o.model.userData.missing && Math.abs(o.bbox.max.x - 0.5) < 1e-6, "rebuilt with the model");
  notifyAssetReady("0".repeat(64)); // an unrelated asset: nothing breaks
  sb.dispose();
});

test("clearance: the nearest surface of an imported model and a ray to it, in the world, after a move and a turn; hidden layers and placeholders do not count", async () => {
  const vp = { scene: new THREE.Scene(), container: new EventTarget(), add(o) { this.scene.add(o); }, remove(o) { this.scene.remove(o); }, requestRender() {}, on: () => () => {}, setCursor() {}, addLabelSource: () => () => {}, removeLabelSource() {}, detachGizmo() {}, frame() {} };
  const ctx = { state: {}, viewport: vp, on: () => () => {}, emit() {}, select() {}, getRig: () => null, toast() {}, units: "mm" };
  const sb = createSandbox({ viewport: vp, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  const { id } = await importCadFile(objFile());
  // the body is 1.0 x 0.5 x 0.2 m on the floor, the stick (0.1 m across) stands on it to 0.8 m
  const o = sb.add("cad_model", { params: { asset: id, units: "mm", up: "y" }, position: [2, 0, 3], yaw: 90 });
  const idx = surfaceIndex(o);
  assert.ok(idx && idx.count > 12);
  assert.equal(surfaceIndex(o), idx, "cached per model");
  const above = nearestSurface(idx, [2.4, 0.6, 3], 0.3); // turned 90°: the 0.2 m deep body runs along world Z, so 0.4 m along X is clear
  assert.equal(above, null, "the body is only 0.2 m deep after the turn: 0.4 m to the side is out of reach");
  const top = nearestSurface(idx, [2, 0.9, 3], 0.3);
  assert.ok(top && Math.abs(top.distance - 0.1) < 1e-4, `above the stick: ${top?.distance}`);
  const side = nearestSurface(idx, [2, 0.3, 3 + 0.6], 0.3);
  assert.ok(side && Math.abs(side.distance - 0.1) < 1e-4, `beside the end of the body along world Z: ${side?.distance}`);
  assert.ok(Math.abs(rayHit(idx, [2, 2, 3], [0, -1, 0]) - 1.2) < 1e-4, "down onto the stick");
  assert.ok(Math.abs(rayHit(idx, [2, 0.4, 3], [0, 1, 0]) - 0.1) < 1e-4, "from inside the body, its top face (seen from behind) counts");
  assert.equal(rayHit(idx, [5, 0.3, 3], [1, 0, 0]), null);
  sb.setParam(o.id, "hidden", "1");
  const noStick = surfaceIndex(o);
  assert.notEqual(noStick, idx);
  assert.ok(Math.abs(nearestSurface(noStick, [2, 0.9, 3], 0.5).distance - 0.4) < 1e-4, "the hidden stick is not a surface");
  const missing = sb.add("cad_model", { params: { asset: "f".repeat(64), units: "mm" }, position: [0, 0, 0] });
  assert.equal(surfaceIndex(missing), null, "a placeholder box is not the model");
  sb.dispose();
});

test("STEP: the OpenCascade result becomes an assembly with named parts as layers (the vendored converter, run in Node)", async () => {
  const require = createRequire(import.meta.url);
  const occt = await require(path.join(ROOT, "site/vendor/occt/occt-import-js.js"))();
  const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(path.join(ROOT, "tests/human3d/fixtures/as1_pe_203.stp"))), { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
  assert.equal(res.success, true);
  const obj = occtToThree(res), layers = collectLayers(obj);
  assert.deepEqual(layers.map((l) => l.name), ["PLATE", "L_BRACKET_ASSEMBLY_ASM", "L_BRACKET_ASSEMBLY_ASM (2)", "ROD_ASM"]);
  assert.ok(layers.every((l) => l.triangles > 100));
  let meshes = 0; obj.traverse((o) => { if (o.isMesh) { meshes++; assert.ok(o.geometry.attributes.normal && o.geometry.index); } });
  assert.equal(meshes, res.meshes.length);
});

test("scene files: models are embedded as base64 and come back only when their content matches their id", async () => {
  const { id } = await importCadFile(objFile());
  const e = embedAssets([id, id, "f".repeat(64)]);
  assert.deepEqual(Object.keys(e.assets), [id]);
  assert.deepEqual(e.missing, ["f".repeat(64)]);
  const back = await restoreAssets(e.assets);
  assert.deepEqual(back, { loaded: ["console.obj"], failed: [] });
  const forged = { ["a".repeat(64)]: { ...e.assets[id] } };
  const bad = await restoreAssets(forged);
  assert.equal(bad.loaded.length, 0);
  assert.match(bad.failed[0], /does not match/);
  assert.deepEqual(await restoreAssets(null), { loaded: [], failed: [] });
  assert.equal(embedAssets([id], { maxBytes: 10 }).skipped.length, 1, "a model over the size limit is left out, and said so");
});

test("presets: every preset that places the figure names a library posture and, when seated, a seat of its own", () => {
  const withFigure = TEMPLATES.filter((t) => t.figure);
  assert.ok(withFigure.length >= 11);
  for (const t of withFigure) {
    assert.ok(byId(t.figure.posture), `${t.id}: posture ${t.figure.posture}`);
    if (Number.isInteger(t.figure.sitOn)) {
      const d = t.objects[t.figure.sitOn];
      assert.ok(byType(d.type).supports(normalizeParams(d.type, d.params)).length, `${t.id}: ${d.type} has a surface to sit on`);
    } else assert.ok(Array.isArray(t.figure.stand) && t.figure.stand.length === 2, `${t.id}: a standing spot`);
  }
  for (const g of ["Workstations", "Cockpits and cabins", "Maintenance"]) assert.ok(TEMPLATES.filter((t) => t.group === g).length >= 3, g);
  assert.ok(TEMPLATE_GROUPS.includes("Other"));
  // every preset parameter is inside its type's range (nothing is clamped on load)
  for (const t of TEMPLATES) for (const d of t.objects) {
    const n = normalizeParams(d.type, d.params);
    for (const [k, v] of Object.entries(d.params ?? {})) assert.equal(n[k], v, `${t.id}: ${d.type}.${k}`);
  }
});

test("equipment rack: the service bay sits between its heights, every door style builds, and a lid opened past 90 degrees rises above the bay", () => {
  for (const door of ["side", "lift", "gullwing", "none"]) {
    const p = normalizeParams("equipment_rack", { door, bayBottom: 0.9, bayTop: 1.5, doorAngle: 115 }), g = buildObject("equipment_rack", p), b = g.userData.bbox;
    assert.ok(b.min.y > -1e-6 && b.max.y >= 1.99, door);
    if (door === "lift") assert.ok(b.max.y > 1.5 + 0.2 || b.max.z > 0.4 + 0.5, "the lid is up and out");
    const a = byType("equipment_rack").anchors(p);
    assert.ok(Math.abs(a.bay_bottom.position[1] - 0.9) < 1e-9 && Math.abs(a.bay_top.position[1] - 1.5) < 1e-9);
    disposeObject(g);
  }
  const low = byType("equipment_rack").anchors(normalizeParams("equipment_rack", { height: 1.0, bayBottom: 0, bayTop: 3, plinth: 0.1 }));
  assert.ok(low.bay_bottom.position[1] >= 0.12 - 1e-9 && low.bay_top.position[1] <= 0.97 + 1e-9, "the bay is kept inside the cabinet");
  const shell = buildObject("cabin_shell", {}).userData.bbox;
  assert.ok(Math.abs(shell.max.y - 1.5) < 0.05 && shell.min.y > -1e-6, "the canopy rises to the inside height");
});

test("clearance: lines of sight pass through glass; a point inside a closed part is inside, a point under an open canopy is not", () => {
  const vp = { scene: new THREE.Scene(), container: new EventTarget(), add(o) { this.scene.add(o); }, remove(o) { this.scene.remove(o); }, requestRender() {}, on: () => () => {}, setCursor() {}, addLabelSource: () => () => {}, removeLabelSource() {}, detachGizmo() {}, frame() {} };
  const ctx = { state: {}, viewport: vp, on: () => () => {}, emit() {}, select() {}, getRig: () => null, toast() {}, units: "mm" };
  const sb = createSandbox({ viewport: vp, ctx, scheduler: (fn) => { const t = setTimeout(fn, 0); return () => clearTimeout(t); } });
  const cab = sb.add("cabin_shell", { position: [0, 0, 0], params: { roof: "canopy", height: 1.4 } });
  const idx = surfaceIndex(cab);
  const up = rayHit(idx, [0, 0.5, 0], [0, 1, 0], 5);
  assert.ok(up != null && up > 0.5, `the canopy stops a plain ray: ${up}`);
  assert.equal(rayHit(idx, [0, 0.5, 0], [0, 1, 0], 5, { seeThrough: true }), null, "but not a line of sight");
  assert.equal(insideSurface(idx, [0, 0.8, 0]), false, "the middle of the cabin is open space");
  const box = sb.add("box", { position: [3, 0, 0] }), bh = box.bbox.max.y;
  assert.equal(insideSurface(surfaceIndex(box), [3, bh / 2, 0]), true, "the middle of a solid box");
  assert.equal(insideSurface(surfaceIndex(box), [3, bh + 0.1, 0]), false, "above it");
  assert.ok(Math.abs(nearestSurface(surfaceIndex(box), [3, bh - 0.02, 0], 0.3).distance - 0.02) < 1e-4, "2 cm under its top face");
  sb.dispose();
});
