// How far does each dimension move the ankle / mtp offsets through the new stance lean (fit.js leanLegs)? node --import ./tests/human3d/register.mjs <this>
import fs from "node:fs";
import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
const pop = (c, r, s, pc = 50) => anthro.percentileProfile(JSON.parse(fs.readFileSync(`public/api/v1/populations/${c}/${r}/${s}.json`)), { percentile: pc, meanStature: true });
const base = P.finalizeProfile(pop("united-states", "army", "M"), {});
const b0 = fitBody(base, { form: "male" });
console.log("stance", JSON.stringify(b0.stance));
const rows = P.dimensionRows(b0, base);
const out = [];
for (const row of rows) {
  if (!["override", "measure"].includes(row.editability.kind) || row.id.startsWith("ring_") || row.id === "mass") continue;
  const prof = { ...base, overrides: { [row.id]: row.mm * 1.05 / 1000 } };
  const b1 = fitBody(prof, { form: "male", overrides: prof.overrides });
  const claimed = new Set(S.dimensionJoints(row.id));
  for (const j of ["ankle_L", "mtp_L", "knee_L"]) {
    const o0 = b0.joints[j].offset, o1 = b1.joints[j].offset;
    const d = Math.hypot(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]) * 1000;
    if (d > 0.3 && !claimed.has(j)) out.push(`${row.id} +5% moves ${j} by ${d.toFixed(2)} mm, table silent`);
  }
}
console.log(out.join("\n") || "none above 0.3 mm");
console.log("test threshold in author's test: 1.2 mm");
