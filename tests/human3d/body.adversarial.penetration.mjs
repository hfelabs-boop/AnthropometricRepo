// Interpenetration of body parts in the neutral pose (inside test by ray parity on the part's own triangles).
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.penetration.mjs [stride] [subjects]
import * as THREE from "three";
import { DatabaseSync } from "node:sqlite";
import { fitBody } from "../../site/js/human/fit.js";
import { subjectProfile } from "../../site/js/human/anthro.js";
import { buildSkin } from "../../site/js/human/body.js";
import { makeBones, DB_PATH } from "./body.adversarial.helpers.mjs";

const stride = +(process.argv[2] ?? 200);
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare("select * from subjects order by dataset, subject_key").all();
const dirs = [new THREE.Vector3(0.577, 0.577, 0.577), new THREE.Vector3(-0.3, 0.2, 0.93).normalize(), new THREE.Vector3(0.1, -0.95, 0.3).normalize()];
function partMesh(sk, name) {
  const g = sk.mesh.geometry, p = sk.mesh.userData.parts[name], pos = g.attributes.position.array, idx = g.index.array;
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  bg.setIndex(new THREE.BufferAttribute(idx.slice(p.triStart * 3, p.triEnd * 3), 1));
  const m = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); m.updateMatrixWorld(true);
  return m;
}
const inside = (mesh, v) => { // majority of three rays says inside
  let votes = 0; const rc = new THREE.Raycaster();
  for (const d of dirs) { rc.set(v, d); rc.near = 0; rc.far = 3; votes += rc.intersectObject(mesh, false).length % 2; }
  return votes >= 2;
};
const depthOf = (mesh, v) => { // distance to the surface along 6 axis directions: the smallest hit distance is a proxy for the depth
  let best = 9; const rc = new THREE.Raycaster();
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { rc.set(v, new THREE.Vector3(...d)); const h = rc.intersectObject(mesh, false); if (h.length) best = Math.min(best, h[0].distance); }
  return best;
};
const res = {};
for (let i = 0; i < rows.length; i += stride) {
  const b = fitBody(subjectProfile(rows[i])), sk = buildSkin(b, makeBones(b), {}), P = sk.mesh.userData.parts, pos = sk.mesh.geometry.attributes.position.array;
  const meshes = { leg_R: partMesh(sk, "leg_R"), leg_L: partMesh(sk, "leg_L"), torso: partMesh(sk, "torso") };
  const test = (label, part, target, step = 1, yMax = Infinity) => {
    const p = P[part]; let n = 0, ins = 0, deep = 0;
    for (let v = p.vertexStart; v < p.vertexEnd; v += step) { if (pos[v * 3 + 1] > yMax) continue; const pt = new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); n++; if (inside(meshes[target], pt)) { ins++; deep = Math.max(deep, depthOf(meshes[target], pt)); } }
    const r = (res[label] ??= { n: 0, ins: 0, maxDepth: 0, bodiesWith: 0, bodies: 0 }); r.n += n; r.ins += ins; r.bodies++; if (ins) r.bodiesWith++; r.maxDepth = Math.max(r.maxDepth, deep);
  };
  for (const f of ["index", "middle", "ring", "little", "thumb"]) { test(`finger_L ${f} in leg_L`, `${f}_L`, "leg_L"); }
  test("arm_L (palm..) in leg_L", "arm_L", "leg_L", 2);
  test("arm_L in torso", "arm_L", "torso", 2);
  test("arm_L below shoulder-40mm in torso", "arm_L", "torso", 1, b.positions.shoulder_L[1] - 0.04);
  test("arm_L below elbow in torso", "arm_L", "torso", 1, b.positions.elbow_L[1]);
  test("leg_L in leg_R", "leg_L", "leg_R", 2);
  sk.dispose();
}
for (const [k, r] of Object.entries(res)) console.log(k.padEnd(28), `bodies ${r.bodies} with penetration ${r.bodiesWith}  vertices inside ${r.ins}/${r.n}  max depth ~${(r.maxDepth * 1000).toFixed(1)} mm`);
