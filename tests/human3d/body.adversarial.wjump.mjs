// Weight gradients: adjacent vertices (one triangle edge): L1 distance of the dense weight vectors / edge length, in units of 100 per metre (1 = a complete handover of a vertex from one bone to another within 20 mm).
// A jump tears the skin as soon as the two bones move apart. Prints per part the count of edges above 0.3 / 0.6 / 1.0 and where the worst one is.
import { fitBody } from "../../site/js/human/fit.js";
import { buildSkin } from "../../site/js/human/body.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { popProfile, makeBones } from "./body.adversarial.helpers.mjs";
const ids = JOINTS.map((j) => j.id);
for (const [c, r, s, p] of [["united-states", "army", "M", 50], ["united-states", "army", "F", 5], ["united-states", "army", "M", 95]]) {
  const b = fitBody(popProfile(c, r, s, p)), sk = buildSkin(b, makeBones(b)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, si = g.attributes.skinIndex.array, sw = g.attributes.skinWeight.array;
  const dist = (a, bb) => { const m = new Map(); for (let k = 0; k < 4; k++) { if (sw[a * 4 + k]) m.set(si[a * 4 + k], (m.get(si[a * 4 + k]) ?? 0) + sw[a * 4 + k]); if (sw[bb * 4 + k]) m.set(si[bb * 4 + k], (m.get(si[bb * 4 + k]) ?? 0) - sw[bb * 4 + k]); } let d = 0; for (const v of m.values()) d += Math.abs(v); return d; };
  console.log(`== ${s} P${p}`);
  for (const [name, q] of Object.entries(sk.mesh.userData.parts)) {
    if (/_R$/.test(name)) continue;
    const seen = new Set(); let n3 = 0, n6 = 0, n10 = 0, worst = 0, where = [0, 0, 0, '-', '-'];
    for (let t = q.triStart; t < q.triEnd; t++) for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], bb = idx[t * 3 + (k + 1) % 3], key = a < bb ? a * 4194304 + bb : bb * 4194304 + a; if (seen.has(key)) continue; seen.add(key);
      const len = Math.hypot(pos[a*3]-pos[bb*3], pos[a*3+1]-pos[bb*3+1], pos[a*3+2]-pos[bb*3+2]); const d0 = dist(a, bb), d = d0 / Math.max(len, 1e-4) / 100; /* L1 per 10 mm... normalised: 1.0 = a full swap (2.0) within 20 mm */ if (d > 0.3) n3++; if (d > 0.6) n6++; if (d > 1.0) n10++;
      if (d > worst) { worst = d; where = [(pos[a * 3] + pos[bb * 3]) / 2, (pos[a * 3 + 1] + pos[bb * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[bb * 3 + 2]) / 2, ids[si[a * 4]], ids[si[bb * 4]]]; }
    }
    console.log(name.padEnd(8), `edges ${seen.size} >0.3: ${n3} >0.6: ${n6} >1.0: ${n10} worst ${worst.toFixed(2)} at ${where.map((x) => (typeof x === "number" ? x.toFixed(3) : x)).join(" ")}`);
  }
}
