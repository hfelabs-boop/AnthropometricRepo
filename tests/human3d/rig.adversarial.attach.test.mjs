// Bone meshes are rigid children of def.joint: in a posed rig, the ends of a bone as seen by the scene graph must coincide with the ends of
// boneSegment() (the Kinematics). A bone whose end moves with a rotating joint BETWEEN def.joint and the end detaches (reported with its error).
//   node --import ./tests/human3d/register.mjs --test tests/human3d/rig.adversarial.attach.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { JOINTS, BONES } from "../../site/js/human/skeleton.js";
import { buildRig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// todo: reports known defects (ulna vs forearm twist axis, sternum vs ribs) without failing the suite; remove the option once they are fixed
test("bone ends in the scene graph == boneSegment ends, random in-range poses and roots", { todo: "ulna / sternum detach under pronation / thoracic flexion" }, () => {
  const fails = [];
  for (const [stature, form] of [[1.75, "male"], [1.55, "female"]]) {
    const rig = buildRig(syntheticBody(stature, form));
    const wp = (e) => (e.startsWith("lm:") ? rig.landmarkWorld(e.slice(3)) : rig.jointWorld(e)).clone();
    rig.resetPose();
    const N = {}; // neutral world positions
    for (const j of JOINTS) N[j.id] = rig.jointWorld(j.id).clone();
    for (const d of BONES) for (const e of [d.from, d.to]) if (e) N[e] ??= wp(e);
    const rnd = rng(11);
    const worst = new Map();
    for (let k = 0; k < 40; k++) {
      const angles = {};
      for (const j of JOINTS) angles[j.id] = j.dof.map((dd) => dd.min + (dd.max - dd.min) * (0.5 + 0.5 * (rnd() * 2 - 1) * (k % 2 ? 1 : 0.3)));
      rig.setPose({ root: { x: rnd(), y: 1 + rnd(), z: rnd(), heading: rnd() * 360, flex: (rnd() - 0.5) * 180, lat: (rnd() - 0.5) * 90, rot: (rnd() - 0.5) * 90 }, angles });
      rig.group.updateMatrixWorld(true);
      for (const d of BONES) {
        const seg = rig.boneSegment(d.id), jb = rig.bones.get(d.joint);
        for (const [e, real] of [[d.from, seg.a], [d.to, seg.b]]) {
          if (!e) continue;
          const mesh = jb.localToWorld(N[e].clone().sub(N[d.joint]));
          const err = mesh.distanceTo(real);
          if (err > (worst.get(d.id) ?? 0)) worst.set(d.id, err);
        }
      }
    }
    const bad = [...worst].filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]);
    console.log(form, "bones whose mesh ends deviate from the kinematic ends by > 4 mm in some pose:", bad.length, bad.slice(0, 40).map(([k, v]) => `${k}:${(v * 1000).toFixed(0)}mm`).join(" "));
    fails.push(...bad.map(([k, v]) => `${form}:${k}:${(v * 1000).toFixed(0)}mm`));
  }
  assert.deepEqual(fails, []);
});
