// Round 2: is the model's own shoulder_protraction ever <= 0 (then the editor prefills a value that editDimension refuses)? node --import ./tests/human3d/register.mjs <this file>
import fs from "node:fs";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import * as P from "../../site/js/human/panels/profile.js";
const idx = JSON.parse(fs.readFileSync("public/api/v1/index.json"));
let n = 0, neg = [], zero = 0; const vals = [];
for (const e of idx.populations) {
  const file = JSON.parse(fs.readFileSync(`public/api/v1/populations/${e.country_id}/${e.role_id}/${e.sex}.json`));
  for (const pc of [5, 50, 95]) {
    let prof; try { prof = anthro.percentileProfile(file, { percentile: pc, meanStature: true }); } catch { continue; }
    const b = fitBody(P.finalizeProfile(prof, {}), { form: P.defaultForm(prof) });
    const d = b.dims.find((x) => x.id === "shoulder_protraction"); n++; vals.push(d.value * 1000);
    if (!(d.value > 0)) neg.push(`${e.country_id}/${e.role_id}/${e.sex} P${pc}: ${(d.value * 1000).toFixed(2)} mm (${d.status})`);
  }
}
vals.sort((a, b) => a - b);
console.log("bodies", n, "protraction min/median/max mm", vals[0].toFixed(1), vals[vals.length >> 1].toFixed(1), vals.at(-1).toFixed(1), "<=0:", neg.length, neg.slice(0, 5));
