// Random and corner-combination fuzz of every catalogue type: finite geometry, y >= 0, anchors/grips/supports finite and sane, bbox not degenerate.
// node --import ./tests/human3d/register.mjs tests/human3d/sandbox.adversarial.fuzz2.mjs [rounds]
import * as THREE from "three";
import { CATALOG, buildObject, disposeObject } from "../../site/js/human/catalog.js";
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rounds = +process.argv[2] || 40;
let bad = 0, builds = 0, maxMs = 0, maxTris = 0, maxType = "";
const report = (m) => { bad++; if (bad < 60) console.log(m); };
function pick(t, how) {
  const p = {};
  for (const q of t.params) {
    if (q.kind === "number") p[q.key] = how === "corner" ? (rnd() < 0.5 ? q.min : q.max) : q.min + rnd() * (q.max - q.min);
    else if (q.kind === "bool") p[q.key] = rnd() < 0.5;
    else p[q.key] = q.options[Math.floor(rnd() * q.options.length)].value;
  }
  return p;
}
for (const t of CATALOG) for (let r = 0; r < rounds; r++) {
  const how = r % 2 ? "corner" : "random", params = pick(t, how);
  const t0 = performance.now();
  const g = buildObject(t.type, params);
  const ms = performance.now() - t0; builds++; if (ms > maxMs) maxMs = ms;
  const tag = `${t.type} ${how} ${JSON.stringify(params)}`;
  let tris = 0, meshes = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const pos = o.geometry.attributes.position.array, nor = o.geometry.attributes.normal.array;
    tris += pos.length / 9;
    for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) { report(`NaN position ${tag}`); break; }
    for (let i = 0; i < nor.length; i++) if (!Number.isFinite(nor[i])) { report(`NaN normal ${tag}`); break; }
  });
  if (tris > maxTris) { maxTris = tris; maxType = t.type; }
  const b = g.userData.bbox;
  if (b.isEmpty() || !Number.isFinite(b.min.x + b.max.x + b.min.y + b.max.y + b.min.z + b.max.z)) report(`bad bbox ${tag}`);
  else {
    if (b.min.y < -0.002) report(`below floor ${b.min.y.toFixed(4)} ${tag}`);
    const s = b.getSize(new THREE.Vector3());
    if (Math.min(s.x, s.y, s.z) < 1e-4 && t.type !== "point_marker") report(`flat bbox ${s.toArray()} ${tag}`);
    if (Math.max(s.x, s.y, s.z) > 12) report(`huge bbox ${s.toArray()} ${tag}`);
  }
  if (meshes > 10) report(`${meshes} meshes ${tag}`);
  const bb = b.clone().expandByScalar(0.03);
  for (const [id, a] of Object.entries(t.anchors(params))) {
    if (![...a.position, ...(a.normal ?? [])].every(Number.isFinite)) report(`anchor NaN ${id} ${tag}`);
    else if (!bb.containsPoint(new THREE.Vector3(...a.position))) report(`anchor ${id} outside bbox by >30mm ${JSON.stringify(a.position)} bbox ${JSON.stringify([b.min.toArray(), b.max.toArray()].map(v=>v.map(x=>+x.toFixed(3))))} ${tag}`);
  }
  for (const s of t.supports(params)) {
    if (![s.y, ...s.size, ...s.center].every(Number.isFinite) || s.size[0] <= 0 || s.size[1] <= 0) report(`support bad ${s.id} ${JSON.stringify(s)} ${tag}`);
    else if (s.y > b.max.y + 0.03 || s.y < b.min.y - 0.03) report(`support ${s.id} y ${s.y} outside bbox y [${b.min.y.toFixed(3)}, ${b.max.y.toFixed(3)}] ${tag}`);
  }
  for (const gr of t.grips(params)) {
    if (![...gr.position, ...gr.normal, ...gr.axis, gr.diameter].every(Number.isFinite)) report(`grip NaN ${gr.id} ${tag}`);
    else {
      const d = gr.normal[0] * gr.axis[0] + gr.normal[1] * gr.axis[1] + gr.normal[2] * gr.axis[2];
      if (Math.abs(d) > 1e-3) report(`grip ${gr.id} normal not perpendicular to axis (${d}) ${tag}`);
      if (!bb.containsPoint(new THREE.Vector3(...gr.position))) report(`grip ${gr.id} outside bbox ${JSON.stringify(gr.position)} ${tag}`);
    }
  }
  disposeObject(g);
}
console.log(`builds ${builds}, max build ${maxMs.toFixed(1)} ms, max triangles ${maxTris} (${maxType}), issues ${bad}`);
