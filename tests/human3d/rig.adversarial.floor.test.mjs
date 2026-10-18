// lowestY() uses landmarks + contacts only: does the skeleton (and the landmark set) stay above the floor after grounding in lying / kneeling / crawling postures?
import test from "node:test";
import * as THREE from "three";
import { buildRig } from "../../site/js/human/rig.js";
import { syntheticBody } from "../../site/js/human/synthetic.js";
import { fitBody } from "../../site/js/human/fit.js";

const prof = { id: "x", label: "x", sex: "M", source: { kind: "manual" }, notes: [], measures: { stature: { value: 1750, unit: "mm" }, mass: { value: 78, unit: "kg" } } };
const bodies = { synthetic: syntheticBody(), fit: (() => { const b = fitBody(prof); return b; })() };
const POSES = {
  supine: { root: { flex: -90 } },
  prone: { root: { flex: 90 }, angles: { shoulder_L: [170, 0, 0], shoulder_R: [170, 0, 0] } },
  sideLeft: { root: { lat: 90 } },
  sideRight: { root: { lat: -90 }, angles: { hip_L: [40, 0, 0], knee_L: [50, 0] } },
  kneel: { angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [150, 0], knee_R: [150, 0], ankle_L: [-40, 0, 0], ankle_R: [-40, 0, 0] } },
  allFours: { root: { flex: 90 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [140, 0], knee_R: [140, 0], shoulder_L: [90, 0, 0], shoulder_R: [90, 0, 0], wrist_L: [-70, 0], wrist_R: [-70, 0] } },
  fold: { angles: { hip_L: [120, 0, 0], hip_R: [120, 0, 0] }, root: { flex: 20 } },
  handstand: { root: { flex: 180 }, angles: { shoulder_L: [180, 0, 0], shoulder_R: [180, 0, 0] } },
  headstand: { root: { flex: 180 } },
  crossLegged: { angles: { hip_L: [60, 40, -40], hip_R: [60, 40, -40], knee_L: [120, 0], knee_R: [120, 0] } },
};
for (const [name, body] of Object.entries(bodies)) {
  test(`grounding by lowestY: bone meshes vs floor (${name} body)`, () => {
    const rig = buildRig(body);
    const worst = [];
    for (const [pn, p] of Object.entries(POSES)) {
      rig.resetPose();
      rig.setPose({ root: { y: 0, ...(p.root || {}) }, angles: p.angles || {} });
      rig.setRoot({ y: -rig.lowestY() });
      rig.group.updateMatrixWorld(true);
      let miny = 1e9, who = "";
      const v = new THREE.Vector3();
      for (const m of rig.view.boneMeshes) { const P = m.geometry.attributes.position.array; for (let i = 0; i < P.length; i += 3) { v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m.matrixWorld); if (v.y < miny) { miny = v.y; who = m.userData.boneId; } } }
      let lmY = 1e9, lmW = "";
      for (const id of rig.landmarkIds) { const y = rig.landmarkWorld(id).y; if (y < lmY) { lmY = y; lmW = id; } }
      let jY = 1e9, jW = ""; for (const id of rig.bones.keys()) { const y = rig.jointWorld(id).y; if (y < jY) { jY = y; jW = id; } }
      worst.push(`${pn}: lowest bone vertex ${(miny * 1000).toFixed(0)} mm (${who}); lowest joint ${(jY * 1000).toFixed(0)} (${jW}); lowestY landmark ${lmW}`);
    }
    console.log(name + "\n" + worst.join("\n"));
  });
}
