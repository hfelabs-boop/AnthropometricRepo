// Triangle quality: slivers (long edge / altitude), zero-length edges, duplicate vertices, per part. node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.slivers.mjs [stride]
import { fitBody } from "../../site/js/human/fit.js";
import { buildSkin } from "../../site/js/human/body.js";
import { allPopulations, popProfile, makeBones } from "./body.adversarial.helpers.mjs";
const stride = +(process.argv[2] ?? 4);
const agg = {};
let k = 0;
for (const [c, r, s] of allPopulations()) for (const pct of [5, 50, 95]) {
  if (k++ % stride) continue;
  const b = fitBody(popProfile(c, r, s, pct)), sk = buildSkin(b, makeBones(b), {}), pos = sk.mesh.geometry.attributes.position.array, idx = sk.mesh.geometry.index.array;
  for (const [name, p] of Object.entries(sk.mesh.userData.parts)) {
    const key = name.replace(/_[LR]$/, ""), a = (agg[key] ??= { tri: 0, sliver: 0, worst: 0, tiny: 0, minEdge: 1e9, worstWhere: "" });
    for (let t = p.triStart; t < p.triEnd; t++) {
      const i = idx[t * 3] * 3, j = idx[t * 3 + 1] * 3, l = idx[t * 3 + 2] * 3;
      const e = [Math.hypot(pos[i] - pos[j], pos[i + 1] - pos[j + 1], pos[i + 2] - pos[j + 2]), Math.hypot(pos[j] - pos[l], pos[j + 1] - pos[l + 1], pos[j + 2] - pos[l + 2]), Math.hypot(pos[l] - pos[i], pos[l + 1] - pos[i + 1], pos[l + 2] - pos[i + 2])];
      const ux = pos[j] - pos[i], uy = pos[j + 1] - pos[i + 1], uz = pos[j + 2] - pos[i + 2], vx = pos[l] - pos[i], vy = pos[l + 1] - pos[i + 1], vz = pos[l + 2] - pos[i + 2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx), longest = Math.max(...e), alt = (2 * area) / longest;
      a.tri++; const asp = longest / Math.max(alt, 1e-12);
      if (asp > 30) a.sliver++;
      if (asp > a.worst) { a.worst = asp; a.worstWhere = `${c}/${r}/${s} P${pct}`; }
      a.minEdge = Math.min(a.minEdge, ...e);
      if (Math.min(...e) < 1e-4) a.tiny++;
    }
  }
  sk.dispose();
}
for (const [k2, a] of Object.entries(agg)) console.log(k2.padEnd(8), `tris ${a.tri}  slivers(aspect>30) ${a.sliver} (${(100 * a.sliver / a.tri).toFixed(3)}%)  worst aspect ${a.worst.toFixed(0)} (${a.worstWhere})  edges<0.1mm ${a.tiny}  min edge ${(a.minEdge * 1000).toFixed(4)} mm`);
