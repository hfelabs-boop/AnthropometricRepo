// Adversarial checks of BVH / OBJ / STL / exchange JSON / tables with readers written in export.adversarial.helpers.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
const { THREE, JOINTS, JOINT_BY_ID } = H;

const profile = H.army("M", 50);
const rig = H.makeRig(profile);
const input = (def) => ({ rig, profile, posture: { id: def.id, name: def.name } });

test("BVH: own FK reproduces every joint centre and orientation in cm / mm / m, extreme poses and random poses", () => {
  const rnd = H.mulberry(7), worst = { pos: 0, rot: 0 };
  const poses = Object.values(H.POSTURES).map((d) => () => H.putPose(rig, d));
  for (let n = 0; n < 40; n++) poses.push(() => {
    const angles = {};
    for (const j of JOINTS) if (rnd() < 0.7) angles[j.id] = j.dof.map((d) => d.min + rnd() * (d.max - d.min));
    rig.setPose({ root: { x: rnd() - 0.5, y: 0.9 + rnd() * 0.3, z: rnd(), heading: rnd() * 720 - 360, flex: (n % 5 === 0 ? 90 : n % 7 === 0 ? -90 : rnd() * 180 - 90), lat: rnd() * 120 - 60, rot: rnd() * 160 - 80 }, angles }, { clamp: true });
  });
  for (const mk of poses) {
    mk();
    for (const [unit, scale] of [["cm", 0.01], ["mm", 0.001], ["m", 1]]) {
      const text = X.buildBVH({ rig, profile }, { unit, neutralFrame: true }).text;
      const b = H.parseBVH(text);
      assert.equal(b.nf, 2); assert.ok(Math.abs(b.frameTime - 1 / 30) < 1e-6);
      assert.equal(b.joints.length, 77);
      assert.deepEqual(b.joints.map((j) => j.name), JOINTS.map((j) => j.id));
      const W = H.bvhWorld(b, 0, scale);
      for (const j of JOINTS) {
        const p = new THREE.Vector3().setFromMatrixPosition(W.get(j.id)), q = rig.jointWorld(j.id);
        worst.pos = Math.max(worst.pos, p.distanceTo(q));
        const rq = new THREE.Quaternion().setFromRotationMatrix(W.get(j.id)), tq = rig.jointQuaternion(j.id);
        worst.rot = Math.max(worst.rot, 2 * Math.acos(Math.min(1, Math.abs(rq.dot(tq)))));
      }
      // frame 2 neutral
      const N = H.bvhWorld(b, 1, scale), neutral = H.makeRig(profile);
      for (const j of JOINTS) assert.ok(new THREE.Vector3().setFromMatrixPosition(N.get(j.id)).distanceTo(neutral.jointWorld(j.id)) < (unit === "mm" ? 6e-5 : 6e-5 * 1), `neutral ${j.id}`);
    }
  }
  assert.ok(worst.pos < 5e-5, `position error ${worst.pos} m`);
  assert.ok(worst.rot < 1e-4, `orientation error ${worst.rot} rad`);
});

test("BVH: structural rules of the format (strict reader)", () => {
  H.putPose(rig, H.POSTURES.squat);
  for (const header of [false, true]) {
    const text = X.buildBVH({ rig, profile, posture: { id: "x", name: "x" } }, { header }).text;
    assert.ok(!text.includes("\r"));
    if (!header) assert.ok(text.startsWith("HIERARCHY\n"));
    const b = H.parseBVH(text);
    assert.equal(b.joints.filter((j) => !j.parent).length, 1);
    assert.equal(b.joints[0].name, "pelvis");
    for (const j of b.joints) assert.ok(j.offset.length === 3 && j.offset.every(Number.isFinite));
    assert.equal(b.frames[0].length, 6 + 3 * 76);
    const leaves = b.joints.filter((j) => !b.joints.some((k) => k.parent === j.name));
    assert.ok(leaves.every((l) => l.end && l.end.length === 3), "End Site on each leaf");
    assert.equal(b.tail.filter((l) => l.trim()).length, 0, "no stray lines after the frames");
    assert.ok(b.frames[0].every(Number.isFinite));
  }
  // joint name tokens must not contain spaces
  assert.ok(JOINTS.every((j) => /^[A-Za-z0-9_]+$/.test(j.id)));
});

test("OBJ / STL: stature, units, axes, winding and shoulder breadth read back and compared with the profile", async () => {
  H.putPose(rig, H.POSTURES.neutral);
  const body = rig.body;
  const stats = {};
  for (const axes of ["y-up", "z-up", "x-front"]) for (const unit of ["mm", "m"]) {
    const k = unit === "mm" ? 1000 : 1;
    const obj = H.parseOBJ((await X.buildOBJ({ rig, profile, posture: { id: "n", name: "n" } }, { unit, axes })).text);
    const skin = obj.objects.find((o) => o.name === "skin");
    assert.ok(skin, "o skin");
    const idx = new Set(); for (const f of skin.faces) for (const c of f) idx.add(c[0]);
    const P = [...idx].map((i) => obj.v[i]);
    assert.ok(P.every((p) => p.every(Number.isFinite)));
    const up = axes === "y-up" ? 1 : 2;
    const lo = Math.min(...P.map((p) => p[up])), hi = Math.max(...P.map((p) => p[up]));
    assert.ok(Math.abs(lo) < 12 / 1000 * k, `soles ${lo}`);
    stats[`${axes}/${unit}`] = (hi - lo) / k;
    // volume positive (outward winding) for the skin shell
    const tris = []; for (const f of skin.faces) { assert.equal(f.length, 3); tris.push(f.map((c) => obj.v[c[0]])); }
    const vol = H.signedVolume(tris) / k ** 3;
    assert.ok(vol > 0.04 && vol < 0.2, `volume ${vol} m3 (${axes}/${unit})`);
    // header lines state unit and axes
    const head = obj.comments.join("\n");
    assert.match(head, new RegExp(unit === "mm" ? "millimetres" : "metres"));
    // direction of the face: nose is at +Z / -Y / +X
    const nose = rig.landmarkWorld(Object.keys(body.landmarks).find((l) => /nose|pronasale/i.test(l)) ?? "nose_tip");
    const front = Math.max(...P.map((p) => (axes === "y-up" ? p[2] : axes === "z-up" ? -p[1] : p[0])));
    const back = Math.min(...P.map((p) => (axes === "y-up" ? p[2] : axes === "z-up" ? -p[1] : p[0])));
    assert.ok(front / k > 0.05 && back / k < -0.05, "front/back extents");
    // left: hip_L must be on the +X (y-up, z-up) / +Y (x-front) side: compare the extent of the left hand
    const left = (p) => (axes === "x-front" ? p[1] : p[0]);
    const hipL = rig.jointWorld("hip_L"), hipR = rig.jointWorld("hip_R");
    assert.ok(hipL.x > hipR.x, "model: left is +X");
    // the skin must reach at least as far on the left side as the hip_L joint centre
    assert.ok(Math.max(...P.map(left)) / k > hipL.x, "left is +X / +Y in the file");
    // STL
    const stl = H.parseSTL((await X.buildSTL({ rig, profile, posture: { id: "n", name: "n" } }, { unit, axes })).data);
    assert.ok(!stl.header.startsWith("solid"));
    assert.match(stl.header, new RegExp(`units ${unit}`));
    const sv = H.signedVolume(stl.tris.map((t) => t.v)) / k ** 3;
    assert.ok(Math.abs(sv - vol) / vol < 0.1, `STL vs OBJ volume ${sv} ${vol}`); // STL includes eyes: slightly different
    let bad = 0; for (const t of stl.tris) { const a = t.v[0], b = t.v[1], c = t.v[2]; const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]; const l = Math.hypot(...n); if (l > 0 && (n[0] * t.n[0] + n[1] * t.n[1] + n[2] * t.n[2]) / l < 0.5) bad++; }
    assert.ok(bad / stl.tris.length < 0.02, `${bad} of ${stl.tris.length} STL normals disagree with winding`);
  }
  console.log("stature from OBJ/STL:", JSON.stringify(stats), "profile stature", profile.measures.stature.value, "model", body.stature * 1000);
  for (const v of Object.values(stats)) assert.ok(Math.abs(v - body.stature) < 0.02, `${v} vs ${body.stature}`);
  assert.ok(Math.abs(body.stature * 1000 - profile.measures.stature.value) < 15);
});

test("OBJ shoulder breadth against the profile", async () => {
  H.putPose(rig, H.POSTURES.neutral);
  const obj = H.parseOBJ((await X.buildOBJ({ rig, profile }, { unit: "mm" })).text), skin = obj.objects.find((o) => o.name === "skin");
  const idx = new Set(); for (const f of skin.faces) for (const c of f) idx.add(c[0]);
  const P = [...idx].map((i) => obj.v[i]);
  const acr = rig.landmarkWorld("acromion_L").y * 1000;
  const band = P.filter((p) => Math.abs(p[1] - acr) < 40);
  const width = Math.max(...band.map((p) => p[0])) - Math.min(...band.map((p) => p[0]));
  const m = profile.measures;
  console.log("skin width at acromion height", width.toFixed(0), "bideltoid", m.bideltoid_breadth?.value, "biacromial", m.biacromial_breadth?.value, "chest breadth", m.chest_breadth?.value);
  const target = m.bideltoid_breadth?.value ?? m.biacromial_breadth?.value;
  if (target) assert.ok(Math.abs(width - target) / target < 0.12, `${width} vs ${target}`);
});

test("exchange JSON: cross-check against rig.js and fit.js, validate, and the documented keys", () => {
  H.putPose(rig, H.POSTURES.squat);
  const doc = X.buildExchange({ rig, profile, posture: { id: "t-squat", name: "Deep squat" } });
  const v = X.validateExchange(JSON.stringify(doc));
  assert.deepEqual(v.errors, []);
  const body = rig.body;
  assert.ok(Math.abs(doc.body.stature_mm - body.stature * 1000) < 1e-6);
  assert.ok(Math.abs(doc.body.mass_kg - body.mass) < 1e-3);
  for (const j of doc.body.joints) {
    const p = rig.jointWorld(j.id), q = rig.jointQuaternion(j.id);
    assert.ok(Math.abs(j.position_mm[0] - p.x * 1000) < 6e-4 && Math.abs(j.position_mm[1] - p.y * 1000) < 6e-4 && Math.abs(j.position_mm[2] - p.z * 1000) < 6e-4, j.id);
    const o = j.orientation_xyzw, dq = Math.abs(q.x * o[0] + q.y * o[1] + q.z * o[2] + q.w * o[3]) / Math.hypot(...o);
    assert.ok(dq > 1 - 1e-12, `${j.id} orientation`);
    const ang = rig.getPose().angles[j.id];
    j.dof.forEach((d, i) => { assert.ok(Math.abs(d.value_deg - ang[i]) < 1e-4); const spec = JOINT_BY_ID[j.id].dof[i]; assert.equal(d.min_deg, Math.round(spec.min * 1000) / 1000); });
  }
  // landmarks
  for (const l of doc.body.landmarks) { const p = rig.landmarkWorld(l.id); assert.ok(Math.abs(l.position_mm[1] - p.y * 1000) < 6e-4); }
  assert.equal(doc.body.landmarks.length, Object.keys(body.landmarks).length);
  // segments sum to the body mass, com from the segments
  const m = doc.body.segments.reduce((s, x) => s + x.mass_kg, 0);
  assert.ok(Math.abs(m - doc.body.mass_kg) / doc.body.mass_kg < 0.02, `segment masses ${m} vs ${doc.body.mass_kg}`);
  const com = [0, 1, 2].map((k) => doc.body.segments.reduce((s, x) => s + x.mass_kg * x.com_position_mm[k], 0) / m);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(com[k] - doc.body.centre_of_mass.position_mm[k]) < 1.5, `com ${k}: ${com[k]} vs ${doc.body.centre_of_mass.position_mm[k]}`);
  // placement is the pelvis
  const pel = rig.jointWorld("pelvis");
  assert.ok(Math.abs(doc.placement.root.y_mm - pel.y * 1000) < 1e-3);
  // posture.angles reproduces the pose
  const pose = rig.getPose();
  for (const [id, a] of Object.entries(pose.angles)) { const named = doc.posture.angles[id]; if (a.some((x) => x)) { assert.ok(named, id); JOINT_BY_ID[id].dof.forEach((d, i) => assert.ok(Math.abs(named[d.key] - a[i]) < 1e-4)); } else assert.ok(!named); }
  // doc table keys: top-level + per-section
  assert.deepEqual(Object.keys(doc).filter((k) => !["created"].includes(k)).sort(), ["axes", "body", "format", "generator", "measurements", "note", "placement", "posture", "profile", "scene", "units", "units_detail", "version"].sort());
  assert.deepEqual(Object.keys(doc.profile).sort(), ["id", "label", "measures", "notes", "sex", "source"]);
  assert.deepEqual(Object.keys(doc.body.joints[1]).sort(), ["dof", "group", "id", "label", "orientation_xyzw", "parent", "position_mm", "rest_offset_mm", "rest_position_mm", "side"]);
  assert.deepEqual(Object.keys(doc.body).sort(), ["centre_of_mass", "dims", "form", "joints", "landmarks", "mass_kg", "segments", "stature_mm"]);
  // dims against fit report
  for (const d of doc.body.dims) { assert.ok(["mm", "kg", ""].includes(d.unit), `dim unit ${d.unit} (${d.id})`); assert.ok(Number.isFinite(d.value), d.id); }
  // profile measures survive untouched
  for (const [k, mm] of Object.entries(profile.measures)) if (Number.isFinite(mm.value)) assert.equal(doc.profile.measures[k].value, mm.value);
  // text has no NaN / null positions
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(doc)));
});
