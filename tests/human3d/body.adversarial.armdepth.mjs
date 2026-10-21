// True penetration depth (distance to the nearest torso triangle of arm vertices that lie inside the torso), neutral pose, below the shoulder joint.
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.armdepth.mjs
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { buildSkin } from "../../site/js/human/body.js";
import { popProfile, makeBones } from "./body.adversarial.helpers.mjs";
const P = (st, sex, mass) => ({ id: "t", label: "t", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: st, unit: "mm" }, mass: { value: mass, unit: "kg" } } });
const cases = [["M50", popProfile("united-states", "army", "M", 50)], ["F50", popProfile("united-states", "army", "F", 50)], ["F5", popProfile("united-states", "army", "F", 5)], ["M95", popProfile("united-states", "army", "M", 95)], ["heavy 1780/150", P(1780, "M", 150)], ["heavyF 1650/130", P(1650, "F", 130)], ["thin 1780/52", P(1780, "M", 52)]];
const tri = new THREE.Triangle(), pt = new THREE.Vector3(), cp = new THREE.Vector3(), a = new THREE.Vector3(), b2 = new THREE.Vector3(), c = new THREE.Vector3();
for (const [lab, prof] of cases) {
  const body = fitBody(prof), sk = buildSkin(body, makeBones(body)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, parts = sk.mesh.userData.parts;
  const T = parts.torso, arm = parts.arm_L;
  const tris = []; for (let t = T.triStart; t < T.triEnd; t++) tris.push(t);
  // inside test: ray parity along +x (lateral, outward for the left arm): the arm is lateral to the torso, so a vertex medial of the torso side wall has an odd count
  const rc = new THREE.Raycaster(), tm = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  tm.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3)); tm.geometry.setIndex(new THREE.BufferAttribute(idx.slice(T.triStart * 3, T.triEnd * 3), 1)); tm.updateMatrixWorld(true);
  const bins = {}; let maxD = 0, maxAt = null, nIn = 0;
  const yS = body.positions.shoulder_L[1];
  for (let v = arm.vertexStart; v < arm.vertexEnd; v++) {
    const y = pos[v * 3 + 1]; if (y > yS - 0.04) continue;
    pt.set(pos[v * 3], y, pos[v * 3 + 2]); rc.set(pt, new THREE.Vector3(1, 0, 0)); rc.far = 1;
    const odd = rc.intersectObject(tm, false).length % 2 === 1; if (!odd) continue;
    nIn++;
    let best = 9;
    for (const t of tris) { a.fromArray(pos, idx[t * 3] * 3); b2.fromArray(pos, idx[t * 3 + 1] * 3); c.fromArray(pos, idx[t * 3 + 2] * 3); tri.set(a, b2, c); tri.closestPointToPoint(pt, cp); const d = cp.distanceTo(pt); if (d < best) best = d; }
    if (best > maxD) { maxD = best; maxAt = [pt.x, pt.y, pt.z]; }
  }
  console.log(lab.padEnd(16), `arm vertices inside torso (below shoulder-40mm): ${nIn}, deepest ${(maxD * 1000).toFixed(1)} mm at (${maxAt?.map((x) => x.toFixed(3))}), shoulder y ${yS.toFixed(3)} elbow y ${body.positions.elbow_L[1].toFixed(3)}`);
  sk.dispose();
}
