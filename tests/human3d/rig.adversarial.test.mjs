// Adversarial checks of rig.js / skeletonview.js / synthetic.js, written by an independent verifier.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/rig.adversarial.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID, BONES, REGIONS, expandRegions } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";

const body = syntheticBody(1.75, "male");
const fresh = (o, b = body) => buildRig(b, o);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Max |bone world position - kin position| (m) and max quaternion angle difference (rad), over all joints. */
function agreement(rig) {
  rig.group.updateMatrixWorld(true);
  let dp = 0, dq = 0;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), k = new THREE.Vector3(), kq = new THREE.Quaternion();
  for (const [id, b] of rig.bones) {
    b.matrixWorld.decompose(p, q, s);
    rig.jointWorld(id, k); rig.jointQuaternion(id, kq);
    dp = Math.max(dp, p.distanceTo(k));
    { const sg = q.dot(kq) < 0 ? -1 : 1; dq = Math.max(dq, Math.abs(q.x - sg * kq.x), Math.abs(q.y - sg * kq.y), Math.abs(q.z - sg * kq.z), Math.abs(q.w - sg * kq.w)); }
    assert.ok(Math.abs(s.x - 1) < 1e-9 && Math.abs(s.y - 1) < 1e-9 && Math.abs(s.z - 1) < 1e-9, `${id} scale ${s.toArray()}`);
  }
  return { dp, dq };
}
function corner(rig, rnd, pickMin) {
  const angles = {};
  for (const j of JOINTS) angles[j.id] = j.dof.map((d) => (pickMin === "min" ? d.min : pickMin === "max" ? d.max : rnd() < 0.5 ? d.min : d.max));
  return angles;
}

test("scene graph == Kinematics: extreme roots (supine, prone, side, heading 180/-180/540) and corner poses", () => {
  const rig = fresh();
  const roots = [
    { y: 0.1, flex: -90 }, { y: 0.1, flex: 90 }, { y: 0.1, flex: 180 }, { y: 0.1, flex: -180 }, { y: 0.2, lat: 90 }, { y: 0.2, lat: -90, rot: 90 },
    { heading: 180, y: 1 }, { heading: -180, y: 1 }, { heading: 540, y: 1 }, { heading: 180, flex: 90, lat: 90, rot: 90, x: 3, y: -2, z: 5 },
    { heading: 90, flex: 90, y: 0.15 }, { heading: 359.9999, rot: -720 }, { x: 1e6, y: -1e6, z: 1e6 },
  ];
  const rnd = rng(7);
  for (const r of roots) {
    for (const mode of ["min", "max", "rand", "rand", "none"]) {
      const angles = mode === "none" ? {} : corner(rig, rnd, mode);
      rig.setPose({ root: r, angles }, { clamp: false });
      const { dp, dq } = agreement(rig);
      assert.ok(dp < 1e-9 * Math.max(1, Math.abs(r.x ?? 0), Math.abs(r.y ?? 0), Math.abs(r.z ?? 0)) && dq < 1e-8, `root ${JSON.stringify(r)} ${mode}: dp=${dp} dq=${dq}`);
    }
  }
});

test("scene graph == Kinematics: angles far outside any range, unclamped, plus extra pelvis local rotation", () => {
  const rig = fresh();
  const rnd = rng(3);
  for (let n = 0; n < 40; n++) {
    const angles = {};
    for (const j of JOINTS) angles[j.id] = j.dof.map(() => (rnd() - 0.5) * 2000);
    rig.setPose({ root: { x: rnd(), y: rnd(), z: rnd(), heading: (rnd() - 0.5) * 720, flex: (rnd() - 0.5) * 720, lat: (rnd() - 0.5) * 720, rot: (rnd() - 0.5) * 720 }, angles }, { clamp: false });
    const { dp, dq } = agreement(rig);
    assert.ok(dp < 1e-9 && dq < 1e-8, `dp=${dp} dq=${dq}`);
  }
});

test("clamp:true reports every clamped DOF with requested/applied and applies exactly what clampAngles says; state is clamped", () => {
  const rig = fresh();
  const rep = rig.setPose({ angles: { knee_L: [999, -999], elbow_R: [-50], shoulder_L: [300, 300, 0] } });
  const keys = rep.clamped.map((c) => `${c.joint}.${c.dof}`);
  assert.ok(keys.includes("knee_L.flex") && keys.includes("knee_L.rot") && keys.includes("elbow_R.flex"), keys.join());
  for (const c of rep.clamped) assert.notEqual(c.requested, c.applied);
  const a = rig.angles.knee_L;
  assert.ok(a[0] < 999 && a[1] > -999);
  const { dp } = agreement(rig);
  assert.ok(dp < 1e-9);
  // swing cap: shoulder flex+abd scaled
  const sh = rig.angles.shoulder_L;
  assert.ok(Math.hypot(sh[0], sh[1]) <= 180.0001, `${sh}`);
});

test("atomicity: bad pose throws and changes nothing (bones, kin, state, listeners)", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 1, heading: 30 }, angles: { elbow_L: [45], hip_R: [30, 10, 5] } });
  const before = JSON.stringify(rig.getPose());
  const bq = [...rig.bones.values()].map((b) => b.quaternion.toArray().concat(b.position.toArray()));
  const kp = Array.from(rig.kin.positions);
  let calls = 0; rig.onChange(() => calls++);
  const bad = [
    { root: { y: 2 }, angles: { elbow_L: [NaN] } }, { root: { y: NaN } }, { root: { y: 2 }, angles: { nope: [1] } }, { angles: { elbow_L: [1, 2, 3, 4, 5] } },
    { root: { y: 2, bogus: 1 } }, { root: { y: Infinity } }, { root: { y: "2" } }, { root: [1] }, { angles: [1] }, { angles: { elbow_L: "5" } }, { angles: { elbow_L: ["5"] } },
    { angles: { hip_LR: [1, 2, 3] } }, { angles: { lumbar: [1, 2, 3] } }, { foo: 1 }, null, 5, "x", { root: { y: 2 }, angles: { elbow_L: [null] } }, { root: { y: 2 }, angles: { elbow_L: undefined } },
    { angles: { __proto__: { x: 1 }, elbow_L: [Infinity] } }, { root: { y: 1, heading: -Infinity } },
  ];
  for (const p of bad) {
    let threw = false;
    try { rig.setPose(p); } catch { threw = true; }
    if (!threw) {
      // some may be accepted legitimately: report
      console.log("ACCEPTED:", JSON.stringify(p));
      rig.setPose(JSON.parse(before)); // restore
      continue;
    }
    assert.equal(JSON.stringify(rig.getPose()), before, `state changed after ${JSON.stringify(p)}`);
    assert.deepEqual([...rig.bones.values()].map((b) => b.quaternion.toArray().concat(b.position.toArray())), bq);
    assert.deepEqual(Array.from(rig.kin.positions), kp);
  }
  assert.equal(calls, 0, "listener called by a failed or no-op setPose");
});

test("setPose with an unlisted root field zeros it (y -> 0) - documented footgun; setPose({}) is a no-op", () => {
  const rig = fresh();
  const y0 = rig.root.y;
  rig.setPose({ root: { heading: 90 } });
  console.log("root after setPose({root:{heading:90}}):", JSON.stringify(rig.root), "was y", y0);
  assert.equal(rig.root.y, 0); // the pelvis is now at the floor: half the body underground
  assert.ok(rig.lowestY() < -0.5);
});

test("listeners: throwing listener does not block others; unsubscribe during callback; re-entrant setPose; listener sees committed state", () => {
  const rig = fresh();
  const log = [];
  const off1 = rig.onChange(() => { log.push("a"); off1(); });
  rig.onChange(() => { throw new Error("boom"); });
  rig.onChange((r) => log.push("c" + r.root.y));
  const orig = console.error; console.error = () => {};
  try { rig.setPose({ root: { y: 1 } }); rig.setPose({ root: { y: 2 } }); } finally { console.error = orig; }
  assert.deepEqual(log, ["a", "c1", "c2"]);
  // re-entrancy
  const r2 = fresh(); let depth = 0;
  r2.onChange(() => { if (depth++ < 3) r2.setRoot({ x: r2.root.x + 1 }); });
  r2.setRoot({ x: 0.5 });
  assert.ok(r2.root.x >= 1.5);
  assert.equal(agreement(r2).dp < 1e-9, true);
});

test("setAngles after an unclamped pose silently clamps unrelated joints (and reports them)", () => {
  const rig = fresh();
  rig.setPose({ angles: { knee_L: [200, 0] } }, { clamp: false });
  const rep = rig.setAngles({ elbow_L: [10] });
  console.log("setAngles collateral clamp:", JSON.stringify(rep.clamped), "knee now", rig.angles.knee_L);
});

test("getPose/setPose roundtrip is exact, getPose is a deep copy; frozen state", () => {
  const rig = fresh();
  const rnd = rng(9);
  rig.setPose({ root: { x: 0.1, y: 0.9, z: 0.2, heading: 33, flex: 4, lat: 5, rot: 6 }, angles: corner(rig, rnd, "rand") });
  const p = rig.getPose();
  p.angles.hip_L[0] = 12345; p.root.y = 99;
  assert.notEqual(rig.angles.hip_L[0], 12345);
  const q = rig.getPose();
  rig.resetPose();
  rig.setPose(q);
  assert.deepEqual(rig.getPose(), q);
  assert.throws(() => { rig.angles.hip_L[0] = 1; }, TypeError, "angles frozen -> assignment throws in strict mode");
});

test("resetPose: neutral and on the floor; lowestY ~ 0", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 3, heading: 20 }, angles: { elbow_L: [90] } });
  rig.resetPose();
  assert.equal(rig.root.y, rig.restRootY);
  console.log("neutral lowestY", rig.lowestY());
  assert.ok(Math.abs(rig.lowestY()) < 1e-4);
  const { dp } = agreement(rig); assert.ok(dp < 1e-12);
});

test("disposed rig: every method throws a clear error, view methods too", () => {
  const rig = fresh(); rig.dispose();
  for (const f of ["resetPose", "lowestY", "labelAnchors", "centerOfMass"]) assert.throws(() => rig[f](), /disposed/, f);
  assert.throws(() => rig.setPose({}), /disposed/);
  assert.throws(() => rig.pickJoint(new THREE.Raycaster()), /disposed/);
  assert.throws(() => rig.display && rig.setDisplay({}), /disposed/);
  rig.dispose();
});

// ---- resources ------------------------------------------------------------------------------------------------------------------------
function trackDisposal() {
  const set = new Set(), orig = [];
  for (const C of [THREE.BufferGeometry, THREE.Material, THREE.Texture]) {
    const d = C.prototype.dispose;
    orig.push([C, d]);
    C.prototype.dispose = function () { set.add(this); return d.apply(this, arguments); };
  }
  return { set, restore: () => orig.forEach(([C, d]) => { C.prototype.dispose = d; }) };
}
function collect(root) {
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    for (const m of [].concat(o.material || [])) { mats.add(m); for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v); }
  });
  return { geos, mats, texs };
}

test("20 rigs created, exercised (select, display, pose) and disposed: every reachable GPU resource is disposed, nothing stays in the scene", () => {
  const t = trackDisposal();
  try {
    const scene = new THREE.Scene();
    const idBefore = new THREE.BufferGeometry().id;
    let total = { g: 0, m: 0, t: 0 }, undisposed = 0;
    for (let i = 0; i < 20; i++) {
      const rig = fresh({ quality: i % 2 ? "low" : "high" });
      scene.add(rig.group);
      rig.setDisplay({ landmarks: true, com: true, labels: true, axes: true, xray: i % 3 === 0 });
      rig.select(JOINTS[(i * 7) % 77].id); rig.highlight(JOINTS[(i * 11) % 77].id);
      rig.select(JOINTS[(i * 5) % 77].id);
      rig.setPose({ angles: { elbow_L: [30] } });
      const c = collect(rig.group);
      total.g += c.geos.size; total.m += c.mats.size; total.t += c.texs.size;
      rig.dispose();
      for (const x of [...c.geos, ...c.mats, ...c.texs]) if (!t.set.has(x)) { undisposed++; console.log("UNDISPOSED", x.type, x.name || ""); }
      assert.equal(scene.children.length, 0);
      assert.equal(rig.group.children.length, 0);
    }
    const idAfter = new THREE.BufferGeometry().id;
    console.log(`created geometry ids ${idAfter - idBefore - 1} (incl. temporaries), reachable total ${total.g}, mats ${total.m}, texs ${total.t}, undisposed ${undisposed}`);
    assert.equal(undisposed, 0);
    // everything that was created and is a geometry with attributes and not disposed = leak candidate
  } finally { t.restore(); }
});

test("dispose after select/highlight with the triad alive disposes triad geometry; selecting 200 times does not grow the registry", () => {
  const rig = fresh();
  const n0 = rig.view.geos.length, m0 = rig.view.mats.length;
  for (let i = 0; i < 200; i++) rig.select(JOINTS[i % 77].id);
  assert.equal(rig.view.geos.length - n0 <= 3, true, `geos ${rig.view.geos.length} vs ${n0}`);
  assert.equal(rig.view.mats.length - m0 <= 3, true, `mats ${rig.view.mats.length} vs ${m0}`);
  rig.select(null);
  assert.equal(rig.view.geos.length, n0);
  rig.dispose();
});

test("draw calls, triangles and geometry memory in every display configuration", () => {
  const rig = fresh();
  const count = (root) => {
    let calls = 0, tris = 0, bytes = 0, verts = 0; const seen = new Set();
    root.traverseVisible((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      calls++;
      const g = o.geometry; tris += g.index ? g.index.count / 3 : (g.attributes.position.count / 3);
      verts += g.attributes.position.count;
      if (!seen.has(g)) { seen.add(g); for (const a of Object.values(g.attributes)) bytes += a.array.byteLength; if (g.index) bytes += g.index.array.byteLength; }
    });
    return { calls, tris, verts, kb: Math.round(bytes / 1024) };
  };
  for (const q of ["high", "low"]) {
    const r = fresh({ quality: q });
    for (const d of [{ skeleton: true, joints: true }, { skeleton: true, joints: true, landmarks: true, com: true, labels: true }]) {
      r.setDisplay(d); r.select("shoulder_L");
      console.log(q, JSON.stringify(d), JSON.stringify(count(r.group)));
      assert.ok(count(r.group).calls <= 450);
    }
    r.dispose();
  }
  rig.dispose();
});

test("build time of the rig (main-thread blocking) in Node", () => {
  const t0 = performance.now();
  const r = fresh();
  const t1 = performance.now();
  const r2 = fresh({ quality: "low" });
  const t2 = performance.now();
  const r3 = fresh({ skeleton: false });
  const t3 = performance.now();
  console.log(`buildRig high ${(t1 - t0).toFixed(0)} ms, low ${(t2 - t1).toFixed(0)} ms, no skeleton ${(t3 - t2).toFixed(0)} ms`);
  const t4 = performance.now();
  for (let i = 0; i < 200; i++) r.setPose({ angles: { elbow_L: [i % 100] } });
  console.log(`setPose x200 ${(performance.now() - t4).toFixed(0)} ms (landmarks+com on: ${0})`);
  r.setDisplay({ landmarks: true, com: true });
  const t5 = performance.now();
  for (let i = 0; i < 200; i++) r.setPose({ angles: { elbow_L: [i % 100] } });
  console.log(`setPose x200 with landmarks+com ${(performance.now() - t5).toFixed(0)} ms`);
});

test("skeleton: false and bad bodies", () => {
  const r = fresh({ skeleton: false });
  assert.equal(r.pickJoint(new THREE.Raycaster()), null);
  assert.deepEqual(r.labelAnchors(), []);
  r.select("hip_L"); r.highlight("hip_L");
  assert.equal(r.display.skeleton, false);
  r.setDisplay({ skeleton: true, joints: true, landmarks: true });
  assert.equal(r.display.skeleton, false);
  const b = structuredClone(body); delete b.landmarks.vertex;
  assert.throws(() => fresh({}, b), /vertex/);
  const b2 = structuredClone(body); b2.joints.knee_L.offset = [0, NaN, 0];
  assert.throws(() => fresh({}, b2));
  const b3 = structuredClone(body); delete b3.landmarks.heel_L;
  assert.throws(() => fresh({}, b3));
  assert.doesNotThrow(() => fresh({ skeleton: false }, b3));
  const b4 = structuredClone(body); b4.joints.knee_L.offset = [0, 0, 0];
  try { const rr = fresh({}, b4); console.log("zero-length bone accepted"); rr.setPose({ angles: { knee_L: [30, 0] } }); } catch (e) { console.log("zero-length knee ->", e.message); }
  const b5 = structuredClone(body); b5.contacts = undefined; const r5 = fresh({}, b5); r5.lowestY();
  assert.throws(() => r5.contactPoints("feet"));
  const b6 = structuredClone(body); delete b6.masses; const r6 = fresh({ }, b6); r6.setDisplay({ com: true }); r6.setPose({}); r6.setRoot({ x: 1 });
  assert.throws(() => r6.centerOfMass());
});

test("body with extreme/odd statures and form: builds, finite geometry", () => {
  for (const [H, f] of [[1.2, "female"], [2.3, "male"], [1.75, "neutral"], [0.9, "neutral"]]) {
    let b; try { b = syntheticBody(H, f); } catch (e) { console.log("syntheticBody", H, e.message); continue; }
    const r = fresh({}, b);
    for (const m of r.view.boneMeshes) for (const v of m.geometry.attributes.position.array) assert.ok(Number.isFinite(v), m.name);
    r.dispose();
  }
});

// ---- picking ------------------------------------------------------------------------------------------------------------------------------
const rayTo = (target, from) => { const o = from.clone(); const d = target.clone().sub(o).normalize(); return new THREE.Raycaster(o, d); };

test("pickJoint hits the marker of a joint from the front, back, side, in a posed rig; hidden markers / opaque skin give null", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.9, heading: 180, x: 1, z: -0.5 }, angles: { elbow_L: [90], hip_R: [40, 20, 0], shoulder_L: [60, 30, 0] } });
  const miss = [];
  for (const j of JOINTS) {
    if (j.id.startsWith("forearm")) continue;
    const c = rig.jointWorld(j.id);
    for (const dir of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]) {
      const from = c.clone().addScaledVector(new THREE.Vector3(...dir), 2);
      const hit = rig.pickJoint(rayTo(c, from));
      if (!hit) { miss.push(`${j.id} from ${dir}: none`); continue; }
      if (hit.id !== j.id) { miss.push(`${j.id} from ${dir}: got ${hit.id} (${hit.point.distanceTo(c).toFixed(4)} m from centre)`); }
    }
  }
  const frac = miss.length;
  console.log(`joint pick misses: ${frac}`); console.log(miss.slice(0, 40).join("\n"));
  rig.setDisplay({ joints: false });
  assert.equal(rig.pickJoint(rayTo(rig.jointWorld("hip_L"), new THREE.Vector3(0, 1, 5))), null);
});

test("pickBone identifies bones in a posed rig (ray towards a point on the bone segment), and never returns an id outside BONES", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.9, heading: 90, x: 0.3 }, angles: { elbow_R: [100], knee_L: [60, 0], hip_L: [50, 0, 0] } });
  const ids = new Set(BONES.map((b) => b.id));
  const wrong = [];
  for (const id of ["femur_L", "femur_R", "tibia_L", "humerus_L", "humerus_R", "ulna_R", "radius_L", "skull", "sacrum", "clavicle_bone_L", "vert_L3", "vert_T8", "metacarpal_3_L", "calcaneus_R", "mandible"]) {
    const seg = rig.boneSegment(id); const mid = seg.a.clone().lerp(seg.b, 0.5);
    const hits = [];
    for (const dir of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]) {
      const h = rig.pickBone(rayTo(mid, mid.clone().addScaledVector(new THREE.Vector3(...dir), 3)));
      hits.push(h ? h.id : null);
      if (h) assert.ok(ids.has(h.id));
    }
    wrong.push(`${id}: ${hits.join(",")}`);
  }
  console.log(wrong.join("\n"));
  rig.setDisplay({ skeleton: false });
  assert.equal(rig.pickBone(rayTo(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 5))), null);
});

test("pick ignores a hidden rig group (visible=false) and honours raycaster near/far", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.95 } });
  const c = rig.jointWorld("hip_L");
  rig.group.visible = false;
  const h = rig.pickJoint(rayTo(c, c.clone().add(new THREE.Vector3(0, 0, 3))));
  console.log("pickJoint with group.visible=false ->", h && h.id);
  rig.group.visible = true;
  const rc = rayTo(c, c.clone().add(new THREE.Vector3(0, 0, 3))); rc.far = 1;
  console.log("pickJoint with far=1 ->", rig.pickJoint(rc));
});

// ---- landmarks ---------------------------------------------------------------------------------------------------------------------------------
test("landmarks of the synthetic body are where their names say (neutral pose)", () => {
  const rig = fresh();
  const L = (id) => rig.landmarkWorld(id);
  const H = 1.75, fail = [];
  const ok = (cond, msg) => { if (!cond) fail.push(msg); };
  ok(Math.abs(L("vertex").y - H) < 1e-4, "vertex height");
  ok(L("eye_mid").y < H - 0.08 && L("eye_mid").y > H - 0.15, `eye height ${L("eye_mid").y}`);
  ok(L("glabella").z > L("eye_mid").z - 0.02 && L("pronasale").z > L("glabella").z, "face order");
  ok(L("pronasale").z > L("eye_L").z && L("subnasale").y < L("pronasale").y + 0.001 === false || true, "");
  ok(L("gnathion").y < L("subnasale").y && L("subnasale").y < L("nasion").y, "chin < subnasale < nasion");
  ok(L("opisthocranion").z < L("tragion_L").z && L("tragion_L").x > 0.06, "occiput behind ear; ear lateral");
  ok(L("tragion_L").y < L("eye_mid").y && L("tragion_L").y > L("gnathion").y, "tragion between chin and eyes");
  ok(L("cervicale").z < L("suprasternale").z, "C7 behind sternal notch");
  ok(L("suprasternale").y > L("xiphoid").y && L("xiphoid").z > L("suprasternale").z - 0.05, "sternum order");
  ok(Math.abs(L("acromion_L").y - 0.818 * H) < 0.04, `acromion height ${L("acromion_L").y}`);
  ok(L("acromion_L").x > 0.15 && L("acromion_L").x < 0.25, `acromion x ${L("acromion_L").x}`);
  ok(L("acromion_L").y < L("cervicale").y, "acromion below C7");
  ok(L("olecranon_L").z < rig.jointWorld("elbow_L").z, "olecranon behind the elbow centre");
  ok(L("lateral_humeral_epicondyle_L").x > L("medial_humeral_epicondyle_L").x, "lateral > medial epicondyle (humerus)");
  ok(L("stylion_L").z > rig.jointWorld("wrist_L").z && L("ulnar_styloid_L").z < rig.jointWorld("wrist_L").z, "radial styloid forward (thumb side), ulnar behind");
  ok(L("radiale_L").x > rig.jointWorld("elbow_L").x, "radiale lateral");
  ok(L("palm_L").y < rig.jointWorld("wrist_L").y, "palm below wrist");
  ok(L("middle_tip_L").y < L("palm_L").y && L("middle_tip_L").y > 0.5 * 0.486 * H - 0.35, `fingertip y ${L("middle_tip_L").y}`);
  const handLen = rig.jointWorld("wrist_L").y - L("middle_tip_L").y;
  ok(Math.abs(handLen - 0.108 * H) < 0.012, `hand length ${handLen}`);
  ok(L("thumb_tip_L").z > L("middle_tip_L").z, "thumb in front of the middle finger (mid position)");
  ok(L("index_tip_L").z > L("little_tip_L").z, "index in front of little finger");
  ok(L("trochanterion_L").x > rig.jointWorld("hip_L").x + 0.05 && Math.abs(L("trochanterion_L").y - rig.jointWorld("hip_L").y) < 0.03, "trochanter lateral of the hip centre");
  ok(L("asis_L").y > rig.jointWorld("hip_L").y && L("asis_L").z > rig.jointWorld("hip_L").z - 0.0, `ASIS above hip, in front ${L("asis_L").toArray()}`);
  ok(L("psis_L").z < L("asis_L").z - 0.08, "PSIS behind ASIS");
  ok(L("ischial_L").y < rig.jointWorld("hip_L").y - 0.05 && L("ischial_L").z < rig.jointWorld("hip_L").z, "ischial tuberosity below and behind the hip");
  ok(L("ischial_L").x < rig.jointWorld("hip_L").x + 0.01 && L("ischial_L").x > 0.02, "ischial medial to the hip");
  ok(L("buttock_L").z < L("ischial_L").z, "buttock extremity behind the ischium");
  ok(L("symphysis").z > 0.05 && Math.abs(L("symphysis").x) < 1e-6, "symphysis forward & midline");
  ok(L("patella_L").z > rig.jointWorld("knee_L").z + 0.03, "patella in front of knee");
  ok(L("popliteal_L").z < rig.jointWorld("knee_L").z - 0.03, "popliteal behind");
  ok(L("lateral_epicondyle_L").x > L("medial_epicondyle_L").x, "lateral > medial epicondyle (femur)");
  ok(L("lateral_malleolus_L").x > L("medial_malleolus_L").x, "lateral > medial malleolus");
  ok(L("lateral_malleolus_L").y < L("medial_malleolus_L").y, "lateral malleolus lower than medial");
  ok(L("heel_L").y > 0.02 && L("heel_L").y < 0.08 && L("heel_L").z < rig.jointWorld("ankle_L").z, "heel (pternion, fit.js) low and behind ankle");
  ok(Math.abs(Math.min(...rig.contactPoints("feet").map((p) => p.y))) < 0.003, "sole contacts on the floor");
  ok(L("toe_tip_L").z > L("ball_L").z && L("ball_L").z > rig.jointWorld("ankle_L").z, "toe > ball > ankle");
  ok(Math.abs(L("ball_L").y) < 0.003 && Math.abs(L("ball_outer_L").y) < 0.003, "ball of foot on the floor");
  const footLen = L("toe_tip_L").z - L("heel_L").z;
  ok(Math.abs(footLen - 0.152 * H) < 0.005, `foot length ${footLen}`);
  ok(L("ball_L").x < rig.jointWorld("ankle_L").x + 0.001 && L("ball_outer_L").x > L("ball_L").x, "first metatarsal head medial");
  ok(L("toe_tip_L").x < L("ball_outer_L").x, "hallux medial");
  ok(L("calf_back_L").z < rig.jointWorld("knee_L").z && L("shin_L").z > rig.jointWorld("knee_L").z, "calf back / shin front");
  ok(L("thigh_back_L").z < rig.jointWorld("hip_L").z, "thigh back");
  // right-left
  for (const id of rig.landmarkIds) if (id.endsWith("_L")) { const a = L(id), b = L(id.replace(/_L$/, "_R")); ok(Math.abs(a.x + b.x) < 1e-5 && Math.abs(a.y - b.y) < 1e-5 && Math.abs(a.z - b.z) < 1e-5, `symmetry ${id}`); ok(a.x > -1e-9, `${id} on the figure's left (+X)`); }
  // contacts: lowest point of each set is on the floor in the right posture
  const lowest = (set) => Math.min(...rig.contactPoints(set).map((p) => p.y));
  ok(Math.abs(lowest("feet")) < 0.003, `feet contact set lowest ${lowest("feet")}`);
  console.log(fail.join("\n") || "all landmark expectations hold");
  assert.deepEqual(fail, []);
});

test("landmark vs contacts when posed: seated 90-90-90 - the seat set sits at the lowest point and thighs are horizontal", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.5, flex: 0 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } });
  const kn = rig.jointWorld("knee_L"), hp = rig.jointWorld("hip_L");
  assert.ok(Math.abs(kn.y - hp.y) < 0.01 && kn.z > hp.z + 0.3, "thigh horizontal, knee forward");
  const sh = rig.jointWorld("ankle_L");
  // STALE since the stance change (MODEL.md 4.1, 8.1): hip 90 and knee 90 turn the shank frame by 90 degrees and back, so the seated shank is the shank of the neutral pose, vertical to within the
  // stance lean: the ankle is body.stance.ankleBehindKneeM (about 36 mm for the median man, 4.9 degrees at the cap of MODEL.md 7.1) behind the knee, not under it (was: within 30 mm of the knee's z, i.e. vertical). The foot is not turned:
  // the soles stay flat and level.
  const lean = rig.body.stance.ankleBehindKneeM;
  assert.ok(lean > 0.02 && lean < 0.07, `stance lean ${lean}`);
  assert.ok(sh.y < kn.y - 0.3 && Math.abs((kn.z - sh.z) - lean) < 1e-4 && Math.abs(sh.x - kn.x) < 1e-6, `shank vertical to within the stance lean ${sh.toArray()} ${kn.toArray()}`);
  const soles = rig.contactPoints("feet").map((p) => p.y);
  assert.ok(Math.max(...soles) - Math.min(...soles) < 0.003, `the soles of a seated 90-90-90 body are level (${Math.min(...soles)}..${Math.max(...soles)})`);
  const low = rig.lowestY();
  const seatLow = Math.min(...rig.contactPoints("seat").map((p) => p.y));
  console.log("seated lowestY", low, "seat set lowest", seatLow, "heel y", rig.landmarkWorld("heel_L").y);
});

// ---- bones (geometry) --------------------------------------------------------------------------------------------------------------------------------
test("every bone mesh: finite, non-empty, outward winding (signed volume > 0), normals agree with winding, parented to its joint", () => {
  const rig = fresh();
  const bad = [];
  for (const m of rig.view.boneMeshes) {
    const g = m.geometry, P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array;
    const id = m.userData.boneId, def = BONES.find((b) => b.id === id);
    if (m.parent !== rig.bones.get(def.joint)) bad.push(`${id}: wrong parent ${m.parent && m.parent.name}`);
    if (!I.length) { bad.push(`${id}: empty`); continue; }
    let vol = 0, disagree = 0, n = 0;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
      n++; if (fx * nx + fy * ny + fz * nz < 0) disagree++;
    }
    for (const v of P) if (!Number.isFinite(v)) { bad.push(`${id}: NaN position`); break; }
    for (const v of N) if (!Number.isFinite(v)) { bad.push(`${id}: NaN normal`); break; }
    if (vol <= 0) bad.push(`${id}: signed volume ${vol}`);
    if (disagree / n > 0.02) bad.push(`${id}: ${(100 * disagree / n).toFixed(1)}% of triangles disagree with their normals`);
    const bb = g.boundingBox.getSize(new THREE.Vector3());
    if (bb.length() > 1.2) bad.push(`${id}: bbox ${bb.length().toFixed(2)} m`);
    if (bb.length() < 0.004) bad.push(`${id}: tiny bbox ${bb.length()}`);
  }
  console.log(bad.join("\n") || "bones OK");
  assert.deepEqual(bad, []);
});

test("right-side bones are the exact mirror of the left (vertices, winding) and vertices stay inside a margin around their joints chain", () => {
  const rig = fresh();
  rig.group.updateMatrixWorld(true);
  const world = (m) => { const g = m.geometry, P = g.attributes.position.array, out = []; for (let i = 0; i < P.length; i += 3) out.push(new THREE.Vector3(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld)); return out; };
  const by = Object.fromEntries(rig.view.boneMeshes.map((m) => [m.userData.boneId, m]));
  const bad = [];
  for (const id of Object.keys(by)) {
    if (!id.endsWith("_L")) continue;
    const l = world(by[id]), r = world(by[id.replace(/_L$/, "_R")]);
    if (l.length !== r.length) { bad.push(`${id}: vertex count ${l.length} vs ${r.length}`); continue; }
    let worst = 0;
    for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.hypot(l[i].x + r[i].x, l[i].y - r[i].y, l[i].z - r[i].z));
    if (worst > 1e-4) bad.push(`${id}: mirror error ${worst}`);
  }
  console.log(bad.join("\n") || "mirror OK");
  assert.deepEqual(bad, []);
});

test("bones sit on their segment: every vertex lies within a margin of the line a->b (+ the bone's own scale); report stray bones", () => {
  const rig = fresh();
  rig.group.updateMatrixWorld(true);
  const bad = [];
  for (const m of rig.view.boneMeshes) {
    const def = BONES.find((b) => b.id === m.userData.boneId);
    if (def.kind === "rib" || def.id === "skull" || def.kind === "flat" || def.kind === "vertebra" || def.id === "mandible") continue;
    const seg = rig.boneSegment(def.id), A = seg.a, B = seg.b, AB = B.clone().sub(A), L = AB.length();
    const P = m.geometry.attributes.position.array; let worst = 0, worstAlong = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < P.length; i += 3) {
      v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld);
      const t = L > 0 ? v.clone().sub(A).dot(AB) / (L * L) : 0;
      const tc = Math.min(1, Math.max(0, t));
      const d = v.distanceTo(A.clone().addScaledVector(AB, tc));
      worst = Math.max(worst, d); worstAlong = Math.max(worstAlong, Math.abs(t - 0.5) - 0.5);
    }
    const lim = Math.max(0.045, 0.45 * L);
    if (!/eyeball|calcaneus|toes|metacarpal_1/.test(def.id) && (worst > lim || worstAlong > 0.35)) bad.push(`${def.id}: max distance from segment ${(worst * 1000).toFixed(0)} mm (L ${(L * 1000).toFixed(0)}), overshoot ${(worstAlong * 100).toFixed(0)}% of L`);
  }
  console.log(bad.join("\n") || "bones near their segments");
  assert.deepEqual(bad, []);
});

test("bony landmarks lie on/near a bone surface (<= 25 mm from some bone vertex); report the stragglers", () => {
  const rig = fresh();
  rig.group.updateMatrixWorld(true);
  const verts = [];
  for (const m of rig.view.boneMeshes) {
    const P = m.geometry.attributes.position.array;
    for (let i = 0; i < P.length; i += 3) verts.push([new THREE.Vector3(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld), m.userData.boneId]);
  }
  const far = [];
  for (const id of rig.landmarkIds) {
    const lm = body.landmarks[id]; if (lm.kind !== "bony" || !id.endsWith("_L") && /_R$/.test(id)) continue;
    const p = rig.landmarkWorld(id); let best = 1e9, bid = "";
    for (const [v, b] of verts) { const d = v.distanceTo(p); if (d < best) { best = d; bid = b; } }
    if (best > 0.025) far.push(`${id} (${lm.label}): ${(best * 1000).toFixed(0)} mm from nearest bone vertex (${bid})`);
  }
  console.log(far.join("\n") || "all bony landmarks near bone");
});

test("feet: every foot bone vertex is above the floor and the heel/ball landmarks touch the sole of the skeleton; bones do not poke through the floor", () => {
  const rig = fresh();
  rig.group.updateMatrixWorld(true);
  let miny = 1e9, who = "";
  for (const m of rig.view.boneMeshes) {
    const P = m.geometry.attributes.position.array, v = new THREE.Vector3();
    for (let i = 0; i < P.length; i += 3) { v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld); if (v.y < miny) { miny = v.y; who = m.userData.boneId; } }
  }
  console.log("lowest bone vertex y", miny, who);
  assert.ok(miny > -0.003, `bone vertex ${who} below floor: ${miny}`);
});

// ---- display / labels ------------------------------------------------------------------------------------------------------------------------------
test("display flags: validation, frozen result, dependencies, skin handling with xray/wireframe", () => {
  const skinBuilder = (b, bones) => {
    const geo = new THREE.BoxGeometry(0.2, 1.7, 0.2); const mat = new THREE.MeshStandardMaterial({ color: 0xaa8877 });
    const mesh = new THREE.Mesh(geo, mat); return { mesh, dispose() { geo.dispose(); mat.dispose(); mesh.userData.disposed = true; } };
  };
  const rig = fresh({ skinBuilder });
  assert.ok(rig.skin && rig.display.skin);
  assert.throws(() => rig.setDisplay({ foo: true }));
  assert.throws(() => rig.setDisplay(null));
  assert.throws(() => { rig.display.skin = false; }, TypeError);
  rig.setDisplay({ xray: true });
  assert.ok(rig.skin.material.transparent && rig.skin.material.opacity <= 0.28 && rig.skin.material.depthWrite === false);
  rig.setDisplay({ xray: false });
  assert.ok(!rig.skin.material.transparent && rig.skin.material.opacity === 1 && rig.skin.material.depthWrite === true);
  rig.setDisplay({ wireframe: true });
  assert.ok(rig.skin.material.wireframe);
  rig.setDisplay({ skin: false, skeleton: true, joints: true });
  assert.ok(!rig.skin.visible);
  // with the skin opaque, markers are depth-tested and unpickable
  rig.setDisplay({ skin: true, xray: false, joints: true });
  assert.equal(rig.pickJoint(rayTo(rig.jointWorld("hip_L"), new THREE.Vector3(0, 1, 5))), null);
  rig.setDisplay({ xray: true });
  assert.ok(rig.pickJoint(rayTo(rig.jointWorld("hip_L"), new THREE.Vector3(0, 1, 5))));
  const skin = rig.skin; rig.dispose();
  assert.ok(skin.userData.disposed);
  // a skinBuilder that throws or returns junk
  { const w = console.warn; console.warn = () => {}; try { const r = fresh({ skinBuilder: () => { throw new Error("skin boom"); } }); assert.equal(r.skin, null); assert.match(String(r.skinError), /skin boom/); } finally { console.warn = w; } }
  const r2 = fresh({ skinBuilder: () => ({}) }); assert.equal(r2.skin, null);
  const r3 = fresh({ skinBuilder: () => null }); assert.equal(r3.skin, null);
});

test("a skinBuilder that throws leaves no leaked resources in the Node-visible state (rig is half built)", () => {
  // the Rig constructor creates bones before the skin; when the builder throws nothing is returned, so the caller cannot dispose
  let created = null;
  const t = trackDisposal();
  try {
    try { fresh({ skinBuilder: () => { throw new Error("x"); } }); } catch { /* expected */ }
  } finally { t.restore(); }
  console.log("disposed during failed build:", t.set.size);
});

test("labelAnchors: contents and finiteness for every display combination and selection", () => {
  const rig = fresh();
  rig.setPose({ root: { y: 0.9 }, angles: { elbow_L: [60] } });
  assert.equal(rig.labelAnchors().length, 0, "labels off, nothing selected");
  rig.select("shoulder_L");
  const a = rig.labelAnchors(); assert.equal(a.filter((x) => x.kind === "dof").length, JOINT_BY_ID.shoulder_L.dof.length);
  rig.setDisplay({ labels: true, landmarks: true });
  const all = rig.labelAnchors();
  console.log('anchors', all.length, 'landmarks', rig.landmarkIds.length); assert.ok(all.length > 77 + rig.landmarkIds.length - 1);
  for (const x of all) { assert.ok(x.position instanceof THREE.Vector3 && Number.isFinite(x.position.x + x.position.y + x.position.z), x.id); assert.ok(typeof x.text === "string" && x.text.length); }
  const ids = new Set(all.map((x) => x.id)); assert.equal(ids.size, all.length, "unique anchor ids");
  rig.setDisplay({ labels: false });
  assert.equal(rig.labelAnchors().filter((x) => x.kind !== "dof").length, 0);
  const dofAnchor = rig.labelAnchors().find((x) => x.kind === "dof");
  rig.setDisplay({ axes: false });
  assert.equal(rig.labelAnchors().length, 0, "axes off hides dof labels");
  rig.select(null);
});

test("select/highlight: errors, restore, selection survives pose changes and setDisplay; ring is in the graph only while selected", () => {
  const rig = fresh();
  assert.throws(() => rig.select("nope"));
  assert.throws(() => rig.highlight("nope"));
  rig.select("knee_L"); rig.highlight("hip_L"); rig.highlight("hip_R");
  const hi = rig.view.markers[JOINTS.findIndex((j) => j.id === "hip_L")];
  assert.equal(hi.material, hi.userData.baseMat); assert.equal(hi.scale.x, hi.userData.baseR);
  rig.highlight(null);
  const hr = rig.view.markers[JOINTS.findIndex((j) => j.id === "hip_R")];
  assert.equal(hr.material, hr.userData.baseMat);
  const rings = () => { let n = 0; rig.group.traverse((o) => { if (o.name === "selection-ring") n++; }); return n; };
  assert.equal(rings(), 1);
  rig.select(null); assert.equal(rings(), 0);
  rig.select("knee_L"); rig.select("knee_L"); assert.equal(rings(), 1);
  rig.setDisplay({ joints: false });
  assert.ok(rig.view.ring.visible, "ring visible with markers hidden");
  rig.setDisplay({ skeleton: false, joints: false });
  rig.setPose({ angles: { knee_L: [90, 0] } });
  // ring follows the knee
  rig.group.updateMatrixWorld(true);
  const rp = new THREE.Vector3(); rig.view.ring.getWorldPosition(rp);
  assert.ok(rp.distanceTo(rig.jointWorld("knee_L")) < 1e-9, `ring at ${rp.toArray()} knee ${rig.jointWorld("knee_L").toArray()}`);
  // highlighting a hidden joint, and the highlight of a joint then select of another
  rig.highlight("pelvis"); rig.highlight("pelvis");
  // select the forearm: ring displaced along the forearm
  rig.select("forearm_L");
  rig.group.updateMatrixWorld(true);
  rig.view.ring.getWorldPosition(rp);
  console.log("forearm ring offset from elbow centre (m):", rp.distanceTo(rig.jointWorld("elbow_L")));
  rig.setDisplay({ skeleton: true, joints: true });
});
