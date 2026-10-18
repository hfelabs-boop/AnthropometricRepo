// Round-4 adversarial probes of rig.js / skeletonview.js / synthetic.js.
//   node --import ./tests/human3d/register.mjs --test tests/human3d/rig.adversarial.round4.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, JOINT_BY_ID } from "../../site/js/human/skeleton.js";
import { Kinematics } from "../../site/js/human/fk.js";
import { buildRig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";

const body = syntheticBody(1.75, "male");

test("rig vs body: forearm joint centre and wrist under pronation vs a Kinematics built from body offsets", () => {
  const rig = buildRig(body);
  const offs = {}; for (const j of JOINTS) if (j.parent) offs[j.id] = body.joints[j.id].offset;
  const kin = new Kinematics(offs);
  const ang = { forearm_L: [80], elbow_L: [90] };
  rig.setPose({ root: { y: body.joints.pelvis.offset[1] }, angles: ang });
  kin.solve({ ...Object.fromEntries(JOINTS.map((j) => [j.id, j.dof.map(() => 0)])), ...ang }, { x: 0, y: body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 });
  const a = rig.jointWorld("forearm_L"), b = kin.position("forearm_L", new THREE.Vector3());
  const wa = rig.jointWorld("wrist_L"), wb = kin.position("wrist_L", new THREE.Vector3());
  const ha = rig.jointWorld("middle_mcp_L"), hb = kin.position("middle_mcp_L", new THREE.Vector3());
  console.log("forearm joint rig vs body", a.distanceTo(b) * 1000, "wrist", wa.distanceTo(wb) * 1000, "mcp", ha.distanceTo(hb) * 1000, "mm");
  console.log("body.positions.forearm_L", body.positions.forearm_L, "rig", a.toArray());
});

test("prototype keys as ids", () => {
  const rig = buildRig(body);
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    for (const [n, f] of Object.entries({
      select: () => rig.select(k), highlight: () => rig.highlight(k), jointWorld: () => rig.jointWorld(k), jq: () => rig.jointQuaternion(k),
      landmark: () => rig.landmarkWorld(k), contact: () => rig.contactPoints(k), bone: () => rig.boneSegment(k),
      pose: () => rig.setPose({ angles: JSON.parse(`{"${k}":[1]}`) }), angles: () => rig.setAngles(JSON.parse(`{"${k}":[1]}`)),
    })) {
      try { f(); console.log("NO THROW", n, k); } catch (e) { console.log(n, k, "->", e.constructor.name, String(e.message).slice(0, 70)); }
    }
  }
  const bad = structuredClone(body); bad.landmarks.zzz = { joint: "constructor", offset: [0, 0, 0] };
  try { buildRig(bad); console.log("bad landmark joint 'constructor' accepted"); } catch (e) { console.log("bad joint ->", e.message.slice(0, 90)); }
});

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test("random poses (50 % of range): after grounding by lowestY, how far do bone meshes poke below the floor", () => {
  const rig = buildRig(syntheticBody(1.75, "male"));
  const rnd = rng(7), v = new THREE.Vector3();
  const stats = [];
  for (let k = 0; k < 60; k++) {
    const angles = {};
    for (const j of JOINTS) angles[j.id] = j.dof.map((d) => (d.min + d.max) / 2 + (d.max - d.min) * 0.5 * (rnd() * 2 - 1) * 0.6);
    rig.setPose({ root: { y: 1, heading: rnd() * 360, flex: (rnd() - 0.5) * 180, lat: (rnd() - 0.5) * 120, rot: 0 }, angles });
    rig.setRoot({ y: rig.root.y - rig.lowestY() });
    rig.group.updateMatrixWorld(true);
    let miny = 1e9, who = "";
    for (const m of rig.view.boneMeshes) { const P = m.geometry.attributes.position.array; for (let i = 0; i < P.length; i += 3) { v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld); if (v.y < miny) { miny = v.y; who = m.userData.boneId; } } }
    stats.push([miny, who]);
  }
  stats.sort((a, b) => a[0] - b[0]);
  console.log("worst penetrations (mm, bone):", stats.slice(0, 8).map(([y, w]) => `${(y * 1000).toFixed(0)} ${w}`).join(" | "));
});

test("realistic foot postures: bone mesh vs floor after grounding by lowestY", () => {
  for (const [bn, body] of [["synthetic", syntheticBody(1.75, "male")], ["female", syntheticBody(1.6, "female")]]) {
    const rig = buildRig(body), v = new THREE.Vector3();
    const P = {
      heelRaise: { angles: { ankle_L: [-45, 0, 0], ankle_R: [-45, 0, 0], mtp_L: [50], mtp_R: [50] } },
      kneelToesTucked: { angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [-30, 0, 0], ankle_R: [-30, 0, 0], mtp_L: [70], mtp_R: [70] } },
      toesCurled: { angles: { mtp_L: [-40], mtp_R: [-40] } },
      kneelToesFlat: { angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [-50, 0, 0], ankle_R: [-50, 0, 0], mtp_L: [-30], mtp_R: [-30] } },
      seated: { angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } },
      squatDeep: { angles: { hip_L: [120, 0, 0], hip_R: [120, 0, 0], knee_L: [140, 0], knee_R: [140, 0], ankle_L: [30, 0, 0], ankle_R: [30, 0, 0], mtp_L: [30], mtp_R: [30] } },
    };
    const lines = [];
    for (const [n, p] of Object.entries(P)) {
      rig.resetPose(); rig.setPose({ root: { y: 0 }, angles: p.angles }); rig.setRoot({ y: -rig.lowestY() }); rig.group.updateMatrixWorld(true);
      let miny = 1e9, who = ""; for (const m of rig.view.boneMeshes) { const A = m.geometry.attributes.position.array; for (let i = 0; i < A.length; i += 3) { v.set(A[i], A[i + 1], A[i + 2]).applyMatrix4(m.matrixWorld); if (v.y < miny) { miny = v.y; who = m.userData.boneId; } } }
      lines.push(`${n}: ${(miny * 1000).toFixed(1)} mm ${who}`);
    }
    console.log(bn, lines.join(" | "));
  }
});

test("scene graph vs Kinematics, positions AND orientations, extreme roots with unclamped limit poses, two bodies", () => {
  const roots = [{ heading: 180 }, { heading: 540, flex: 90 }, { flex: -90 }, { flex: 90, lat: 90 }, { lat: -90, rot: 180 }, { heading: -270, flex: 179.999, lat: 0.001 }, { flex: 90, heading: 90, lat: 89.9999 }];
  let wp = 0, wq = 0;
  for (const b of [syntheticBody(1.75, "male"), syntheticBody(1.4, "female")]) {
    const rig = buildRig(b);
    const rnd = rng(3);
    for (const root of roots) for (const mode of ["min", "max", "rand", "beyond"]) {
      const angles = {};
      for (const j of JOINTS) angles[j.id] = j.dof.map((d) => (mode === "min" ? d.min : mode === "max" ? d.max : mode === "beyond" ? (rnd() < 0.5 ? d.min - 90 : d.max + 90) : d.min + (d.max - d.min) * rnd()));
      rig.setPose({ root: { x: 2.5, y: 1.2, z: -3, ...root }, angles }, { clamp: mode !== "beyond" });
      rig.group.updateMatrixWorld(true);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), qk = new THREE.Quaternion();
      for (const j of JOINTS) {
        const bone = rig.bones.get(j.id);
        bone.getWorldPosition(p); bone.getWorldQuaternion(q);
        wp = Math.max(wp, p.distanceTo(rig.jointWorld(j.id)));
        rig.jointQuaternion(j.id, qk);
        const d = q.clone().multiply(qk.clone().invert()); wq = Math.max(wq, 2 * Math.asin(Math.min(1, Math.hypot(d.x, d.y, d.z)))); // acos near 1 would lose 8 digits
      }
    }
  }
  console.log("max position error m", wp, "max orientation error rad", wq);
  assert.ok(wp < 1e-9 && wq < 1e-9);
});

test("buildRig / pose / display / dispose never mutate the body (deep-frozen body accepted)", () => {
  const b = syntheticBody(1.8, "female");
  const before = JSON.stringify(b);
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  deepFreeze(b);
  const rig = buildRig(b, { skeleton: true });
  rig.setPose({ root: { y: 1 }, angles: { elbow_L: [90], forearm_L: [40] } });
  rig.setDisplay({ skeleton: true, landmarks: true, com: true, labels: true }); rig.select("hip_L"); rig.labelAnchors(); rig.centerOfMass(); rig.lowestY();
  rig.dispose();
  assert.equal(JSON.stringify(b), before);
});

test("two rigs of one body are independent (shared body object, shared nothing else)", () => {
  const b = syntheticBody(1.75, "male");
  const r1 = buildRig(b), r2 = buildRig(b);
  r1.setPose({ root: { y: 1, heading: 90 }, angles: { elbow_L: [90] } });
  assert.equal(r2.angles.elbow_L[0], 0);
  assert.notEqual(r1.group, r2.group);
  assert.equal(r2.jointWorld("wrist_L").x, buildRig(b).jointWorld("wrist_L").x);
  r1.dispose();
  r2.setPose({ angles: { elbow_L: [45] } }); // still alive
  assert.ok(Number.isFinite(r2.jointWorld("wrist_L").y));
});

function skinBuilder(body, bones) {
  const list = [...bones.values()], sk = new THREE.Skeleton(list);
  const g = new THREE.BoxGeometry(0.4, 0.4, 0.4); g.translate(0, body.joints.pelvis.offset[1], 0);
  const n = g.attributes.position.count, si = [], sw = [];
  for (let i = 0; i < n; i++) { si.push(0, 0, 0, 0); sw.push(1, 0, 0, 0); }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); mesh.bind(sk);
  return { mesh, dispose() { g.dispose(); mesh.material.dispose(); } };
}

test("a skin from a builder still renders and can be picked after the root moves away from the origin", { todo: "rig.js never sets skin.frustumCulled = false nor refreshes its bounding sphere (the root moves through the pelvis bone only)" }, () => {
  const rig = buildRig(syntheticBody(1.75, "male"), { skinBuilder });
  const y = rig.restRootY;
  const hits = (x) => new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1)).intersectObject(rig.skin, false).length;
  assert.ok(hits(0) > 0);
  rig.setRoot({ x: 3 }); rig.group.updateMatrixWorld(true);
  assert.equal(rig.skin.frustumCulled, false, "culled by the bind-pose bounding sphere at the origin");
  assert.ok(hits(3) > 0, "raycast against the stale bounding sphere");
});

test("dispose frees the skin's Skeleton (bone texture), also when the builder's dispose() forgets it", { todo: "rig.dispose() calls skin.skeleton.dispose() nowhere: one DataTexture leaks per rebuild" }, () => {
  const rig = buildRig(syntheticBody(1.75, "male"), { skinBuilder });
  let disposed = 0;
  const sk = rig.skin.skeleton, orig = sk.dispose.bind(sk); sk.dispose = () => { disposed++; orig(); };
  rig.dispose();
  assert.equal(disposed, 1);
});
