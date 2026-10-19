// Anchors, grips and supports against the drawn geometry, for every type at default, min and max parameters.
// A support must lie on a real surface: a ray cast straight down onto the support centre must hit within 6 mm of support.y.
// An anchor with a normal (screens) must lie on a surface: a ray from 0.3 m in front of it must hit within 6 mm.
// node --import ./tests/human3d/register.mjs tests/human3d/sandbox.adversarial.anchors2.mjs
import * as THREE from "three";
import { CATALOG, buildObject, byType } from "../../site/js/human/catalog.js";
const modes = { default: () => ({}), min: (t) => Object.fromEntries(t.params.map((p) => [p.key, p.kind === "number" ? p.min : p.kind === "bool" ? false : p.options[0].value])), max: (t) => Object.fromEntries(t.params.map((p) => [p.key, p.kind === "number" ? p.max : p.kind === "bool" ? true : p.options.at(-1).value])) };
const rc = new THREE.Raycaster();
let bad = 0;
for (const t of CATALOG) for (const [mode, f] of Object.entries(modes)) {
  const params = f(t), g = buildObject(t.type, params); g.updateMatrixWorld(true);
  const meshes = []; g.traverse((o) => { if (o.isMesh && !o.material.transparent) meshes.push(o); });
  const bb = g.userData.bbox.clone().expandByScalar(0.02);
  for (const [id, a] of Object.entries(t.anchors(params))) {
    const p = new THREE.Vector3(...a.position);
    if (!bb.containsPoint(p)) { bad++; console.log(`ANCHOR OUTSIDE bbox ${t.type}/${mode}/${id}`, a.position); }
    if (a.normal) {
      const n = new THREE.Vector3(...a.normal);
      rc.set(p.clone().addScaledVector(n, 0.3), n.clone().negate());
      const h = rc.intersectObjects(meshes, false)[0];
      if (!h || Math.abs(h.distance - 0.3) > 0.01) { bad++; console.log(`ANCHOR OFF SURFACE ${t.type}/${mode}/${id}: hit ${h ? (h.distance - 0.3).toFixed(4) : "none"}`); }
    }
  }
  for (const s of t.supports(params)) {
    // sample centre and 4 points inside
    const pts = [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]].map(([u, v]) => [s.center[0] + u * s.size[0] / 2, s.center[1] + v * s.size[1] / 2]);
    const pitch = (s.pitch ?? 0) * Math.PI / 180;
    for (const [x, z] of pts) {
      rc.set(new THREE.Vector3(x, s.y + 0.02, z), new THREE.Vector3(0, -1, 0));
      const h = rc.intersectObjects(meshes, false)[0];
      const expect = s.y + (s.pitch ? -(z - s.center[1]) * Math.tan(pitch) : 0);
      if (!h || Math.abs(h.point.y - expect) > 0.012) { bad++; console.log(`SUPPORT ${t.type}/${mode}/${s.id} at (${x.toFixed(2)},${z.toFixed(2)}): y=${s.y} pitch=${s.pitch ?? 0} expect ${expect.toFixed(3)} hit ${h ? h.point.y.toFixed(3) : "none"}`); break; }
    }
  }
  for (const gr of t.grips(params)) {
    const p = new THREE.Vector3(...gr.position);
    if (!bb.containsPoint(p)) { bad++; console.log(`GRIP OUTSIDE bbox ${t.type}/${mode}/${gr.id}`, gr.position); }
  }
}
console.log("issues:", bad);
