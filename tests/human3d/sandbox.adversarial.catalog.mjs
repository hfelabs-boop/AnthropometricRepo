// Adversarial sweep of the object catalogue: every type at default, all-min, all-max and each parameter alone at min / max.
// Run: node --import ./tests/human3d/register.mjs tests/human3d/sandbox.adversarial.catalog.mjs
import * as THREE from "three";
import { CATALOG, buildObject, disposeObject } from "../../site/js/human/catalog.js";

const out = [];
const bad = (t, msg) => out.push(`${t}: ${msg}`);
const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
let totalTris = 0;
const stats = [];
for (const spec of CATALOG) {
  const variants = [["default", {}]];
  const mn = {}, mx = {};
  for (const p of spec.params) {
    if (p.kind === "number") { mn[p.key] = p.min; mx[p.key] = p.max; }
    else if (p.kind === "bool") { mn[p.key] = false; mx[p.key] = true; }
    else { mn[p.key] = p.options[0].value; mx[p.key] = p.options.at(-1).value; }
  }
  variants.push(["allmin", mn], ["allmax", mx]);
  for (const p of spec.params) {
    if (p.kind === "number") { variants.push([`${p.key}=min`, { [p.key]: p.min }], [`${p.key}=max`, { [p.key]: p.max }]); }
    else if (p.kind === "bool") variants.push([`${p.key}=true`, { [p.key]: true }], [`${p.key}=false`, { [p.key]: false }]);
    else for (const o of p.options) variants.push([`${p.key}=${o.value}`, { [p.key]: o.value }]);
  }
  for (const [vn, params] of variants) {
    const tag = `${spec.type}[${vn}]`;
    let g;
    try { g = buildObject(spec.type, params); } catch (e) { bad(tag, "build threw " + e.message); continue; }
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty() || ![box.min, box.max].every((v) => Number.isFinite(v.x + v.y + v.z))) bad(tag, "bbox empty/NaN");
    if (box.min.y < -1e-4) bad(tag, `below floor ${box.min.y}`);
    const size = box.getSize(new THREE.Vector3());
    if (size.x > 12 || size.y > 12 || size.z > 12) bad(tag, `huge ${size.toArray()}`);
    let tris = 0, meshes = 0, nan = 0, degenerate = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const pos = o.geometry.attributes.position;
      tris += pos.count / 3;
      for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) nan++;
      const nr = o.geometry.attributes.normal.array;
      for (let i = 0; i < nr.length; i++) if (!Number.isFinite(nr[i])) nan++;
    });
    if (nan) bad(tag, `${nan} NaN in geometry`);
    if (meshes > 8) bad(tag, `${meshes} meshes (doc says 2 to 8)`);
    if (vn === "default") { stats.push([spec.type, meshes, tris, size.toArray().map((v) => +v.toFixed(3)).join("x"), +box.min.y.toFixed(3)]); totalTris += tris; }
    if (tris > 40000) bad(tag, `${tris} tris`);
    // anchors / grips / supports
    const anc = spec.anchors(params), grips = spec.grips(params), sup = spec.supports(params);
    const pad = new THREE.Box3().copy(box).expandByScalar(0.25);
    if (!Object.keys(anc).length) bad(tag, "no anchors");
    for (const [id, a] of Object.entries(anc)) {
      if (!finite3(a.position)) bad(tag, `anchor ${id} not finite`);
      else if (!pad.containsPoint(new THREE.Vector3(...a.position))) bad(tag, `anchor ${id} ${a.position} is >0.25 m outside bbox`);
      if (a.normal && !finite3(a.normal)) bad(tag, `anchor ${id} normal NaN`);
      if (!a.label) bad(tag, `anchor ${id} has no label`);
    }
    for (const gr of grips) {
      if (![gr.position, gr.normal, gr.axis].every(finite3) || !Number.isFinite(gr.diameter)) bad(tag, `grip ${gr.id} non-finite`);
      else {
        const n = new THREE.Vector3(...gr.normal), ax = new THREE.Vector3(...gr.axis);
        if (Math.abs(n.dot(ax)) > 0.2) bad(tag, `grip ${gr.id} normal not perpendicular to axis (dot ${n.dot(ax).toFixed(2)})`);
        if (!pad.containsPoint(new THREE.Vector3(...gr.position))) bad(tag, `grip ${gr.id} outside bbox`);
      }
    }
    for (const s of sup) {
      if (![s.y, ...s.size, ...s.center].every(Number.isFinite)) bad(tag, `support ${s.id} non-finite`);
      if (s.size[0] <= 0 || s.size[1] <= 0) bad(tag, `support ${s.id} empty`);
      if (s.y > box.max.y + 1e-3 || s.y < -1e-3) bad(tag, `support ${s.id} y=${s.y} outside bbox y 0..${box.max.y}`);
      // is there real geometry just under the support centre? raycast down
      const rc = new THREE.Raycaster(new THREE.Vector3(s.center[0], s.y + 1e-3 + 0.5, s.center[1]), new THREE.Vector3(0, -1, 0));
      const hits = rc.intersectObject(g, true).filter((h) => h.object.material && !h.object.material.transparent);
      if (!hits.length) bad(tag, `support ${s.id}: nothing solid below its centre (${s.center})`);
      else {
        const top = hits[0].point.y; // first thing hit from above 0.5 m over the support
        const supTop = s.y + (s.pitch ? 0 : 0);
        if (hits[0].point.y > supTop + 0.02 && !s.pitch) bad(tag, `support ${s.id}: geometry pokes ${(top - supTop).toFixed(3)} m above its support plane at centre`);
        if (hits[0].point.y < supTop - 0.02 && !s.pitch) bad(tag, `support ${s.id}: surface is ${(supTop - top).toFixed(3)} m BELOW claimed support y=${supTop.toFixed(3)} (floating support)`);
      }
    }
    disposeObject(g);
  }
}
console.log(stats.map((s) => s.join("\t")).join("\n"));
console.log("types", CATALOG.length, "total default tris", totalTris);
console.log(out.length ? out.join("\n") : "NO ISSUES");
