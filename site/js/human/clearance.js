// Distances from the figure to the surfaces of an object of the scene, for MIL-STD-1472H 5.6.2 (head and body clearance in crew stations, the head room
// above a seat) and Figure 58 D (desk to wall). No DOM. The triangles of an object's model are kept in a uniform grid in the object's own frame, built once
// per model (the sandbox builds a new model when a parameter or a hidden layer changes), so moving the object or the figure costs only the queries.
//
//   surfaceIndex(obj)                      -> the index of a sandbox object's visible triangles, or null (no model, an imported model not loaded, too big)
//   nearestSurface(index, worldPoint, r)   -> { distance, point } (world, metres) of the closest surface point within r, or null
//   rayHit(index, worldOrigin, worldDir)   -> the distance to the first surface along the ray (both faces count), or null
import * as THREE from "three";

export const MAX_TRIANGLES = 3_000_000;
const MAX_CELLS_AXIS = 96;
const cache = new WeakMap(); // model -> index | null

/** The grid of a sandbox object's visible triangles, in the frame of its group (rigid: position and yaw). */
export function surfaceIndex(obj) {
  const model = obj?.model;
  if (!model) return null;
  if (cache.has(model)) return cache.get(model);
  let index = null;
  try { index = buildIndex(obj.group, model); } catch { index = null; }
  cache.set(model, index);
  return index;
}

function buildIndex(group, model) {
  let missing = false, count = 0;
  const meshes = [];
  const walk = (o) => {
    if (!o.visible) return;
    if (o.userData?.missing) missing = true;
    if (o.isMesh && !o.isInstancedMesh && o.geometry?.attributes?.position) {
      const g = o.geometry, n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      count += Math.floor(n);
      meshes.push(o);
    }
    for (const c of o.children) walk(c);
  };
  walk(model);
  if (missing || !count || count > MAX_TRIANGLES) return null;
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const tri = new Float32Array(count * 9);
  let t = 0;
  for (const mesh of meshes) {
    m.multiplyMatrices(inv, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index, n = Math.floor((idx ? idx.count : pos.count) / 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i * 3 + k) : i * 3 + k).applyMatrix4(m);
        tri[t * 9 + k * 3] = v.x; tri[t * 9 + k * 3 + 1] = v.y; tri[t * 9 + k * 3 + 2] = v.z;
      }
      t++;
    }
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3) for (let a = 0; a < 3; a++) { if (tri[i + a] < min[a]) min[a] = tri[i + a]; if (tri[i + a] > max[a]) max[a] = tri[i + a]; }
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
  const cell = Math.max(0.05, ext / MAX_CELLS_AXIS);
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / cell) + 1));
  const cells = new Map();
  const ci = (x, a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((x - min[a]) / cell)));
  for (let i = 0; i < t; i++) {
    const o = i * 9;
    const lo = [0, 1, 2].map((a) => ci(Math.min(tri[o + a], tri[o + 3 + a], tri[o + 6 + a]), a));
    const hi = [0, 1, 2].map((a) => ci(Math.max(tri[o + a], tri[o + 3 + a], tri[o + 6 + a]), a));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = (x * dims[1] + y) * dims[2] + z;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(i);
    }
  }
  return { group, tri, count: t, min, max, cell, dims, cells, stamp: new Uint32Array(t), visit: 0 };
}

const _p = new THREE.Vector3(), _inv = new THREE.Matrix4();
/** The closest surface point within `radius` of a world point: { distance, point: [x, y, z] (world) }, or null. */
export function nearestSurface(index, world, radius = 0.3) {
  if (!index) return null;
  _inv.copy(index.group.matrixWorld).invert();
  _p.set(world[0], world[1], world[2]).applyMatrix4(_inv);
  const { min, max, cell, dims, cells, tri, stamp } = index, P = [_p.x, _p.y, _p.z];
  for (let a = 0; a < 3; a++) if (P[a] < min[a] - radius || P[a] > max[a] + radius) return null;
  const lo = P.map((x, a) => Math.max(0, Math.floor((x - radius - min[a]) / cell))), hi = P.map((x, a) => Math.min(dims[a] - 1, Math.floor((x + radius - min[a]) / cell)));
  if (++index.visit >= 0xffffffff) { stamp.fill(0); index.visit = 1; }
  const visit = index.visit, out = [0, 0, 0];
  let best = radius * radius, bp = null;
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
    const list = cells.get((x * dims[1] + y) * dims[2] + z);
    if (!list) continue;
    for (const i of list) {
      if (stamp[i] === visit) continue;
      stamp[i] = visit;
      const d2 = closestOnTriangle(P, tri, i * 9, out);
      if (d2 < best) { best = d2; bp = [out[0], out[1], out[2]]; }
    }
  }
  if (!bp) return null;
  const w = new THREE.Vector3(...bp).applyMatrix4(index.group.matrixWorld);
  return { distance: Math.sqrt(best), point: w.toArray() };
}

/** Distance along a world ray to the first triangle (either face), or null. Brute force: for the small models of rooms and cabins. */
export function rayHit(index, origin, dir, maxDist = Infinity) {
  if (!index) return null;
  _inv.copy(index.group.matrixWorld).invert();
  const o = new THREE.Vector3(...origin).applyMatrix4(_inv), d = new THREE.Vector3(...dir).transformDirection(_inv);
  const { tri, count } = index;
  let best = maxDist;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), h = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Vector3(), a = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const k = i * 9;
    a.set(tri[k], tri[k + 1], tri[k + 2]);
    e1.set(tri[k + 3], tri[k + 4], tri[k + 5]).sub(a);
    e2.set(tri[k + 6], tri[k + 7], tri[k + 8]).sub(a);
    h.crossVectors(d, e2);
    const det = e1.dot(h);
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det;
    s.subVectors(o, a);
    const u = f * s.dot(h);
    if (u < 0 || u > 1) continue;
    q.crossVectors(s, e1);
    const v = f * d.dot(q);
    if (v < 0 || u + v > 1) continue;
    const tt = f * e2.dot(q);
    if (tt > 1e-6 && tt < best) best = tt;
  }
  return best < maxDist ? best : null;
}

/** Squared distance from P to triangle i (offset o in tri); the closest point goes to out (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(P, tri, o, out) {
  const ax = tri[o], ay = tri[o + 1], az = tri[o + 2], bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5], cx = tri[o + 6], cy = tri[o + 7], cz = tri[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = P[0] - ax, apy = P[1] - ay, apz = P[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let x, y, z;
  if (d1 <= 0 && d2 <= 0) { x = ax; y = ay; z = az; } else {
    const bpx = P[0] - bx, bpy = P[1] - by, bpz = P[2] - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { x = bx; y = by; z = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); x = ax + v * abx; y = ay + v * aby; z = az + v * abz; } else {
        const cpx = P[0] - cx, cpy = P[1] - cy, cpz = P[2] - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { x = cx; y = cy; z = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); x = ax + w * acx; y = ay + w * acy; z = az + w * acz; } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); x = bx + w * (cx - bx); y = by + w * (cy - by); z = bz + w * (cz - bz); } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              x = ax + abx * v + acx * w; y = ay + aby * v + acy * w; z = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  out[0] = x; out[1] = y; out[2] = z;
  return (P[0] - x) ** 2 + (P[1] - y) ** 2 + (P[2] - z) ** 2;
}
