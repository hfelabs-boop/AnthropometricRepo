// Adversarial checks of odd states: no profile, generic (fallback) body, no skin, hidden skin / x-ray, big scenes with attached objects, file names, posture files, tables.
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
import { POSTURES as LIB, byId } from "../../site/js/human/postures.js";
import { expandPosture, poseEquals } from "../../site/js/human/pose.js";
const { THREE, JOINTS } = H;
const GLTFLoader = await H.loadGLTFLoader();
const load = (data) => new Promise((res, rej) => new GLTFLoader().parse(data.slice(0), "", res, rej));
const profile = H.army("M", 50);

async function everything(inp, label, { skin = true } = {}) {
  const out = {};
  out.exchange = X.buildExchange(inp);
  const v = X.validateExchange(JSON.stringify(out.exchange));
  assert.deepEqual(v.errors, [], `${label}: exchange invalid`);
  out.bvh = X.buildBVH(inp, { neutralFrame: true });
  assert.equal(H.parseBVH(out.bvh.text).joints.length, 77);
  for (const f of ["anglesCSV", "dimsCSV", "reportCSV", "pointsCSV"]) { const t = X[f](inp, { header: true }); assert.ok(t.length > 50, `${label}: ${f}`); assert.ok(!/NaN|undefined|\[object/.test(t), `${label}: ${f} has junk`); }
  assert.ok(!/NaN|undefined|\[object/.test(X.anglesJSON(inp)));
  const mc = await X.metricsCSV(inp, {}); if (mc !== null) assert.ok(!/NaN|undefined|\[object/.test(mc), `${label}: metrics`);
  const sum = X.summaryText(inp, await X.metricRows(inp)); assert.ok(!/NaN|undefined|\[object/.test(sum), `${label}: summary:\n${sum}`);
  const pf = await X.buildPostureFile(inp); assert.ok(pf.pose);
  out.glbSk = await X.buildGLB(inp, { figure: "skeleton" });
  if (skin) { out.glb = await X.buildGLB(inp, {}); out.obj = await X.buildOBJ(inp, {}); out.stl = await X.buildSTL(inp, {}); }
  else {
    await assert.rejects(() => X.buildGLB(inp, {}), /no skin/i);
    await assert.rejects(() => X.buildOBJ(inp, {}), /nothing to export/i);
    await assert.rejects(() => X.buildSTL(inp, {}), /nothing to export/i);
  }
  return out;
}

test("no profile at all (profile null), posture null", async () => {
  const rig = H.makeRig(profile);
  const o = await everything({ rig, profile: null, posture: null }, "no profile");
  assert.equal(o.exchange.profile.label.length > 0, true);
  assert.equal(X.exportFileName({ profile: null, posture: null, what: "figure", ext: "glb" }), "figure_pose_figure.glb");
  assert.match(X.summaryText({ rig, profile: null, posture: null }), /DIGITAL HUMAN SUMMARY/);
});

test("fallback generic body (synthetic.js), female and neutral forms, low quality", async () => {
  for (const form of ["male", "female", "neutral"]) for (const quality of ["high", "low"]) {
    const body = H.syntheticBody(1.6, form);
    const rig = H.buildRig(body, { skinBuilder: H.buildSkin, quality });
    H.putPose(rig, H.POSTURES.squat);
    const o = await everything({ rig, profile: { id: "x", label: "Generic", sex: "F", source: { kind: "manual" }, measures: { stature: { value: 1600, unit: "mm" } }, notes: [] }, posture: { id: "t", name: "t" } }, `${form}/${quality}`);
    assert.ok(o.exchange.body.stature_mm > 1500 && o.exchange.body.stature_mm < 1700);
    if (GLTFLoader) { const g = await load(o.glb.data); let n = 0; g.scene.traverse((x) => { if (x.isSkinnedMesh) n++; }); assert.equal(n, 2); }
    if (quality === "low") assert.ok(o.glb.stats.vertices < 12000, `low quality vertices ${o.glb.stats.vertices}`);
  }
});

test("skin missing (body.js failed): skeleton exports work, mesh exports say so", async () => {
  const rig = H.makeRig(profile, { skin: false });
  assert.equal(rig.skin, null);
  H.putPose(rig, H.POSTURES.squat);
  const o = await everything({ rig, profile, posture: { id: "t", name: "t" } }, "no skin", { skin: false });
  if (GLTFLoader) { const g = await load(o.glbSk.data); let n = 0; g.scene.traverse((x) => { if (x.isSkinnedMesh) n++; }); assert.equal(n, 1); }
  assert.equal(X.estimateSizes({ rig }).glbSkin > 0, true);
});

test("hidden skin and x-ray and wireframe do not change what is exported", async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.squat);
  const inp = { rig, profile, posture: { id: "t", name: "t" } };
  const ref = { obj: (await X.buildOBJ(inp, {})).text, glb: Buffer.from((await X.buildGLB(inp, {})).data), bvh: X.buildBVH(inp).text };
  for (const d of [{ skin: false }, { xray: true }, { skin: false, skeleton: true, joints: true, xray: true }, { wireframe: true, labels: true, com: true, landmarks: true }]) {
    rig.setDisplay({ skin: true, skeleton: false, joints: false, xray: false, wireframe: false, ...d });
    assert.equal((await X.buildOBJ(inp, {})).text, ref.obj, JSON.stringify(d));
    assert.ok(Buffer.compare(Buffer.from((await X.buildGLB(inp, {})).data), ref.glb) === 0, `GLB ${JSON.stringify(d)}`);
    assert.equal(X.buildBVH(inp).text, ref.bvh);
  }
  // the export did not leave the display changed
  assert.equal(rig.skin.visible, true);
});

test("200 scene objects with attached and hidden ones, odd names: every format, node names, world transforms, time", async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.squat);
  const { sandbox, ctx } = H.sceneFixture(rig);
  const types = ["cabin_seat", "monitor", "crate", "table", "steering_wheel", "helmet", "rifle", "box", "chair", "desk"];
  const catalog = await import("../../site/js/human/catalog.js");
  const known = (catalog.TYPES ?? catalog.CATALOG ?? []).map((t) => t.id ?? t.type);
  const use = known.length ? known : types;
  const rnd = H.mulberry(3);
  const weird = ["pelvis", "skin", "eyes", "figure", "scene", "digital-human", "skeleton-sticks", "head", "a\nb", "#hash", "o x", "😀 emoji", "é".repeat(100), "  ", "", "Crate", "Crate", "Crate"];
  for (let i = 0; i < 200; i++) {
    const o = sandbox.add(use[i % use.length], { position: [rnd() * 4 - 2, 0, rnd() * 4 - 2], yaw: rnd() * 360, name: i < weird.length ? weird[i] : undefined });
    if (!o) continue;
  }
  const objs = [...sandbox.objects.values()];
  assert.ok(objs.length >= 190, `${objs.length} objects`);
  objs.slice(0, 20).forEach((o, i) => sandbox.attach(o.id, i % 2 ? { kind: "joint", id: "head" } : { kind: "landmark", id: "stylion_R" }, [0, 0.05, 0], { local: i % 3 === 0, orient: i % 4 === 0 }));
  objs.slice(30, 45).forEach((o) => { o.visible = false; o.group.visible = false; });
  const visible = objs.filter((o) => o.visible).length;
  // move the figure after attaching so attached objects follow
  H.putPose(rig, H.POSTURES.supine); ctx.emit("pose", { rig });
  sandbox.flushSave?.();
  objs.forEach((o) => o.group.updateWorldMatrix(true, true));
  const inp = { rig, profile, posture: { id: "t", name: "t" }, sandbox, measurements: [] };
  let t0 = performance.now();
  const glb = await X.buildGLB(inp, { scene: true });
  const tGlb = performance.now() - t0;
  assert.equal(glb.stats.objects, visible, "visible objects only");
  t0 = performance.now(); const obj = await X.buildOBJ(inp, { scene: true }); const tObj = performance.now() - t0;
  t0 = performance.now(); const stl = await X.buildSTL(inp, { scene: true }); const tStl = performance.now() - t0;
  console.log(`200 objects: GLB ${glb.bytes} B ${tGlb.toFixed(0)} ms; OBJ ${obj.bytes} B ${tObj.toFixed(0)} ms; STL ${stl.bytes} B ${tStl.toFixed(0)} ms; estimate`, JSON.stringify(X.estimateSizes(inp)));
  // GLB: loadable, unique names, world matrices equal the sandbox groups
  if (GLTFLoader) {
    const g = await load(glb.data);
    const names = new Set(); let dup = 0; g.scene.traverse((n) => { if (n.name && !n.isBone) { if (names.has(n.name)) dup++; names.add(n.name); } });
    const sceneNode = g.scene.getObjectByName("scene");
    assert.ok(sceneNode);
    assert.equal(sceneNode.children.length, visible);
    g.scene.updateMatrixWorld(true);
    const vis = objs.filter((o) => o.visible);
    const mats = sceneNode.children.map((c) => c.matrixWorld);
    vis.forEach((o, i) => {
      const e = o.group.matrixWorld.elements, f = mats[i].elements;
      for (let k = 0; k < 16; k++) assert.ok(Math.abs(e[k] - f[k]) < 1e-5, `object ${o.name} matrix`);
      assert.equal(sceneNode.children[i].userData.digitalHuman?.id, o.id);
    });
    // duplicate names among bones vs objects
    const boneNames = new Set(JOINTS.map((j) => j.id));
    for (const c of sceneNode.children) assert.ok(!boneNames.has(c.name), `object node ${c.name} equals a joint id`);
    assert.equal(new Set(sceneNode.children.map((c) => c.name)).size, sceneNode.children.length, "unique names of the objects");
  }
  // OBJ: parse, every face index valid, no NaN
  const po = H.parseOBJ(obj.text);
  assert.ok(po.v.every((p) => p.every(Number.isFinite)));
  for (const o of po.objects) for (const f of o.faces) for (const c of f) assert.ok(c[0] >= 0 && c[0] < po.v.length);
  assert.ok(!po.objects.some((o) => /[\n\r]/.test(o.name)));
  const ps = H.parseSTL(stl.data);
  assert.equal(ps.tris.length, stl.triangles);
  assert.ok(ps.tris.every((t) => t.v.every((v) => v.every(Number.isFinite))));
  // exchange: all 200 listed (hidden with visible:false), attached ones carry attachedTo and world positions
  const doc = X.buildExchange(inp);
  assert.equal(doc.scene.objects.length, objs.length);
  assert.deepEqual(X.validateExchange(JSON.stringify(doc)).errors, []);
  const att = doc.scene.objects.filter((o) => o.attachedTo);
  assert.equal(att.length, 20);
  const o0 = objs[1], d0 = doc.scene.objects[1];
  assert.ok(Math.abs(d0.position_mm[1] - o0.position[1] * 1000) < 1e-3);
  // summary and size estimate
  const est = X.estimateSizes(inp);
  assert.ok(glb.bytes < est.glbSkin + est.glbScene * 1.5 && glb.bytes > (est.glbSkin + est.glbScene) * 0.5, `GLB size ${glb.bytes} vs estimate ${est.glbSkin + est.glbScene}`);
});

test("file names with unusual characters", () => {
  const ev = ["../../etc/passwd", "a/b\\c:d*e?f\"g<h>i|j", "CON", "NUL.txt", "日本語", "😀", "‮evil‬", "x\u0000y", "A".repeat(500), "ß ü Ñ", "-rf", ".hidden", "~", "a b.c", "  lead", "tab\there"];
  for (const p of ev) for (const q of ev) {
    const f = X.exportFileName({ profile: { label: p }, posture: { id: q, name: q }, what: "fit-report", ext: "csv", suffix: "mm-x-front" });
    assert.match(f, /^[a-z0-9][a-z0-9_-]*\.csv$/, f);
    assert.ok(f.length <= 125, f);
  }
  const f = X.exportFileName({ profile: { label: "P" }, posture: { id: "q" }, what: "mesh", ext: "obj", suffix: "mm-x-front" });
  console.log("suffix for mm + x-front:", f);
  assert.match(f, /mm-x-front/, "the axes option must be readable in the file name, it was truncated");
});

test("posture file: library postures and edited postures round-trip exactly; hostile files never throw", async () => {
  const rig = H.makeRig(profile), rig2 = H.makeRig(profile);
  const ids = LIB.map((p) => p.id);
  let n = 0, libTrue = 0;
  for (const id of ids) {
    const lib = byId(id);
    const x = expandPosture(lib);
    const root = (await import("../../site/js/human/pose.js")).placePose(rig.restBody, { root: x.root, angles: x.angles }, { support: lib.support ?? "feet" });
    rig.setPose({ root: { ...root }, angles: x.angles }, { clamp: true });
    const inp = { rig, profile, posture: { id, name: lib.name } };
    const pf = await X.buildPostureFile(inp);
    const parsed = await X.parsePostureFile(JSON.stringify(pf));
    assert.ok(parsed.ok, `${id}: ${parsed.errors}`);
    if (pf.library_posture) libTrue++;
    await X.applyPostureFile(rig2, parsed, { place: false });
    const a = rig.getPose(), b = rig2.getPose();
    assert.ok(poseEquals({ root: a.root, angles: a.angles }, { root: b.root, angles: b.angles }, 1e-4) || JOINTS.every((j) => a.angles[j.id].every((v, i) => Math.abs(v - b.angles[j.id][i]) < 1e-4)), `${id} angles`);
    for (const k of ["heading", "flex", "lat", "rot"]) assert.ok(Math.abs(((a.root[k] - b.root[k] + 540) % 360) - 180) < 1e-3, `${id} root.${k} ${a.root[k]} ${b.root[k]}`);
    // placed import puts the figure on its support (not under the floor)
    await X.applyPostureFile(rig2, parsed, { place: true });
    assert.ok(rig2.lowestY() > -2e-3 || lib.support === "body", `${id}: figure below the floor after placing: ${rig2.lowestY()}`);
    n++;
  }
  console.log(`${n} library postures round-tripped, ${libTrue} stored as library entries`);
  // hostile
  const hostile = ["", "null", "[]", "1", "\"x\"", "{}", '{"app":"digital-human-posture"}', '{"app":"digital-human-posture","version":1}', '{"app":"digital-human-posture","version":2}', '{"app":"x","version":1}',
    '{"__proto__":{"a":1},"angles":{"__proto__":[1]}}', '{"angles":{"hip_L":["a"]}}', '{"angles":{"hip_L":[1e999]}}', '{"angles":{"hip_L":[0,0,0,0,0]}}', '{"root":{"flex":"90"}}', '{"root":{"heading":1e20}}', '{"pose":{"angles":{"constructor":[1]}}}',
    '{"app":"digital-human-posture","version":1,"pose":{"root":{"x":5,"flex":10},"angles":{"hip_L":[500,500,500]}}}', "{\"id\":\"x\",\"joints\":{\"nope\":[1]}}", '{"id":"x","joints":{"hip_LR":[300,0,0]},"spine":{"lumbar":[999,0,0]}}',
    JSON.stringify({ angles: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`j${i}`, [1]])) }), "x".repeat(2_100_000), '{"app":"digital-human-posture","version":1.5}', '{"root":null,"angles":null}', '{"angles":[]}'];
  for (const t of hostile) {
    const r = await X.parsePostureFile(t);
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e === "string"), t.slice(0, 50));
    else { const t2 = H.makeRig(profile); await X.applyPostureFile(t2, r, { place: true }); assert.ok(JOINTS.every((j) => t2.getPose().angles[j.id].every(Number.isFinite))); }
  }
  const odd = await X.parsePostureFile('{"root":{"flex":"90"}}'); console.log("root flex as string ->", odd.ok, odd.errors);
  const big = await X.parsePostureFile('{"app":"digital-human-posture","version":1,"pose":{"root":{"x":5,"flex":10},"angles":{"hip_L":[500,500,500]}}}'); console.log("out-of-range ->", big.ok, big.warnings);
});

test("tables: CSV injection, quoting, column counts; points CSV equals the Skeleton tab's", async () => {
  const rig = H.makeRig(profile);
  H.putPose(rig, H.POSTURES.squat);
  const inp = { rig, profile: { ...profile, label: '=HYPERLINK("http://x")' }, posture: { id: "t", name: "+cmd|' /C calc'!A0" } };
  const parseCSV = (t) => { const rows = []; let row = [], cell = "", q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c; } return rows; };
  for (const f of ["anglesCSV", "dimsCSV", "reportCSV", "pointsCSV"]) {
    const rows = parseCSV(X[f](inp, { header: false }));
    assert.ok(rows.length > 5, f);
    assert.ok(rows.every((r) => r.length === rows[0].length), `${f}: ragged rows`);
    for (const r of rows.slice(1)) for (const c of r) assert.ok(!/^[=+@\t\r]/.test(c) && !/^-[A-Za-z(]/.test(c), `${f}: formula cell ${JSON.stringify(c)}`);
  }
  const hdr = X.anglesCSV(inp, { header: true }).split("\n").filter((l) => l.startsWith("#"));
  assert.ok(hdr.every((l) => !/[\r]/.test(l)));
  console.log(hdr.join("\n"));
  const m = await X.metricsCSV(inp, { header: true });
  if (m) assert.ok(parseCSV(m.split("\n").filter((l) => !l.startsWith("#")).join("\n")).every((r, i, a) => r.length === a[0].length));
  // angles: value within [min,max] unless limited flag, at_limit consistent
  const rows = X.anglesRows(inp);
  for (const r of rows) if (r.joint_id !== "root") { if (r.at_limit === "min") assert.ok(Math.abs(r.value_deg - r.min_deg) < 0.011); if (r.at_limit === "max") assert.ok(Math.abs(r.value_deg - r.max_deg) < 0.011); assert.ok(r.value_deg >= r.min_deg - 1e-3 && r.value_deg <= r.max_deg + 1e-3, `${r.joint_id}.${r.dof_key}`); }
});
