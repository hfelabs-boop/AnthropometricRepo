// Template bodies for scripts/human_skin: the US Army 50th-percentile man and woman of fit.js, with what rig_mesh.py and pack.py need
// (joints in skeleton.js order with their parents and neutral centres, landmarks, tube sections, rigid-region measures).
// Usage: node --import ./tests/human3d/register.mjs scripts/human_skin/template.mjs <work dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { bodyDims, tubeStations, landmarkRest, regionOfJoint, REGIONS } from "../../site/js/human/realskin.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = process.argv[2] || "/tmp/hm/skin";
fs.mkdirSync(work, { recursive: true });
for (const sex of ["M", "F"]) {
  const pop = JSON.parse(fs.readFileSync(path.join(ROOT, `public/api/v1/populations/united-states/army/${sex}.json`)));
  const body = fitBody(percentileProfile(pop, { percentile: 50 }));
  const landmarks = Object.fromEntries(Object.keys(body.landmarks).map((id) => [id, landmarkRest(body, id)]));
  const out = {
    sex, stature: body.stature, profile: body.label,
    joints: JOINTS.map((j) => ({ id: j.id, parent: j.parent ?? null, p: body.positions[j.id], region: regionOfJoint(j.id) })),
    regions: REGIONS, landmarks, stations: tubeStations(body), dims: bodyDims(body),
  };
  fs.writeFileSync(path.join(work, `template-${sex}.json`), JSON.stringify(out));
  console.log(sex, body.label, "stature", body.stature.toFixed(4));
}
