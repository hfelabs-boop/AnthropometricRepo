// Joint-limit and library-style pose sweep (CPU skinning). A script that prints the worst cases.
//   BODIES=man50,woman5 node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.limits.mjs [json-out]
import fs from "node:fs";
import { fitBody } from "../../site/js/human/fit.js";
import { buildRig } from "../../site/js/human/rig.js";
import { buildSkin } from "../../site/js/human/body.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
import { volume, faceNormals } from "./body.adversarial.helpers.mjs";
import { BODIES, measurePose } from "./body.adversarial.poses.mjs";

const both = (id, a) => ({ [`${id}_L`]: a, [`${id}_R`]: a });
const FIST = (() => { const a = {}; for (const s of ["L", "R"]) { for (const f of ["index", "middle", "ring", "little"]) { a[`${f}_mcp_${s}`] = [85, 0]; a[`${f}_pip_${s}`] = [100]; a[`${f}_dip_${s}`] = [70]; } a[`thumb_cmc_${s}`] = [30, 20]; a[`thumb_mcp_${s}`] = [40]; a[`thumb_ip_${s}`] = [50]; } return a; })();
// library-style poses: root + angles (degrees, DOF order), spine as region totals via the vertebra lists below
const LIB = {
  "stand-attention": {},
  "sit-90": { angles: { ...both("hip", [90, 0, 0]), ...both("knee", [90, 0]) } },
  "sit-slump": { root: { flex: 15 }, angles: { ...both("hip", [75, 0, 0]), ...both("knee", [100, 0]), head: [20, 0, 0] }, spine: { lumbar: [-20, 0, 0], thoracic: [25, 0, 0] } },
  "sit-cross-legged": { angles: { ...both("hip", [100, 40, -30]), ...both("knee", [130, 0]), ...both("ankle", [0, 20, 0]) } },
  "deep-squat": { angles: { ...both("hip", [125, 15, 0]), ...both("knee", [150, 0]), ...both("ankle", [30, 0, 0]) } },
  "kneel-one": { angles: { hip_L: [90, 0, 0], knee_L: [90, 0], hip_R: [0, 0, 0], knee_R: [150, 0], ankle_R: [-45, 0, 0] } },
  "kneel-heels": { angles: { ...both("hip", [125, 0, 0]), ...both("knee", [155, 0]), ...both("ankle", [-50, 0, 0]) } },
  "lunge": { angles: { hip_L: [90, 0, 0], knee_L: [90, 0], hip_R: [-20, 0, 0], knee_R: [60, 0], ankle_R: [-30, 0, 0] } },
  "reach-up": { angles: { ...both("shoulder", [170, 0, 0]), ...both("elbow", [5]) }, spine: { thoracic: [-15, 0, 0], lumbar: [-10, 0, 0] } },
  "reach-fwd": { angles: { ...both("shoulder", [90, 0, 0]) }, spine: { thoracic: [20, 0, 0] } },
  "arms-cross": { angles: { shoulder_L: [60, -30, 40], shoulder_R: [60, -30, 40], elbow_L: [100], elbow_R: [100] } },
  "hands-behind-head": { angles: { ...both("shoulder", [150, 60, -60]), ...both("elbow", [140]) } },
  "hand-on-back": { angles: { ...both("shoulder", [-40, -20, 80]), ...both("elbow", [110]) } },
  "bend-over": { angles: { ...both("hip", [80, 0, 0]) }, spine: { lumbar: [50, 0, 0], thoracic: [30, 0, 0] } },
  "side-bend": { spine: { lumbar: [0, 25, 0], thoracic: [0, 20, 0], cervical: [0, 20, 0] }, angles: { ...both("shoulder", [0, 30, 0]) } },
  "twist": { spine: { lumbar: [0, 0, 30], thoracic: [0, 0, 40], cervical: [0, 0, 60] }, angles: { head: [0, 0, 20] } },
  "lift": { angles: { ...both("hip", [100, 0, 0]), ...both("knee", [110, 0]), ...both("shoulder", [60, 0, 0]), ...both("elbow", [30]) }, spine: { lumbar: [30, 0, 0], thoracic: [20, 0, 0] } },
  "pushup": { root: { flex: 90 }, angles: { ...both("shoulder", [-90, 0, 0]), ...both("elbow", [90]), ...both("wrist", [-70, 0]), ...both("ankle", [-40, 0, 0]) } },
  "crawl": { root: { flex: 90 }, angles: { ...both("shoulder", [-90, 0, 0]), ...both("hip", [90, 0, 0]), ...both("knee", [90, 0]), ...both("wrist", [-70, 0]) } },
  "prone": { root: { flex: 90 }, angles: {} },
  "lying-side": { root: { lat: 90 } },
  "lying-back": { root: { flex: -90 } },
  "salute": { angles: { shoulder_R: [20, 80, -60], elbow_R: [130], forearm_R: [60], wrist_R: [0, 10] } },
  "run": { angles: { hip_L: [60, 0, 0], knee_L: [100, 0], hip_R: [-20, 0, 0], knee_R: [30, 0], shoulder_L: [-30, 0, 0], shoulder_R: [40, 0, 0], elbow_L: [90], elbow_R: [90], ankle_R: [-30, 0, 0] } },
  "fist-forward": { angles: { ...both("shoulder", [90, 0, 0]), ...FIST } },
  "aim": { angles: { shoulder_R: [90, 10, 0], elbow_R: [20], shoulder_L: [60, 20, 0], elbow_L: [90], head: [0, 0, -10] }, spine: { cervical: [0, 0, -20] } },
  "tpose": { angles: { ...both("shoulder", [0, 90, 0]) } },
  "tpose-pron": { angles: { ...both("shoulder", [0, 90, 0]), ...both("forearm", [-90]) } },
  "legs-apart": { angles: { ...both("hip", [0, 40, 0]) } },
  "split-fwd": { angles: { hip_L: [120, 0, 0], hip_R: [-20, 0, 0] } },
  "foot-up": { angles: { hip_L: [100, 20, 0], knee_L: [130, 0], ankle_L: [20, 10, 0] } },
};
const SPINE_REGIONS = { lumbar: ["L5", "L4", "L3", "L2", "L1"] };

function apply(rig, def) {
  const root = { x: 0, y: 1, z: 0, heading: 0, flex: 0, lat: 0, rot: 0, ...(def.root ?? {}) };
  rig.setPose({ root, angles: def.angles ?? {} }, { clamp: true });
  if (def.spine) rig.setSpine(def.spine, null, { clamp: true });
}

const cases = [];
for (const j of JOINTS) {
  if (j.id === "pelvis" || /^(eye|jaw)/.test(j.id)) continue;
  if (j.side === "R") continue; // the right side is the mirror
  j.dof.forEach((d, i) => {
    for (const val of [d.min, d.max]) {
      const a = j.dof.map(() => 0); a[i] = val;
      cases.push({ id: `${j.id}.${d.key}=${val.toFixed(0)}`, def: { angles: { [j.id]: a } } });
    }
  });
}
for (const [id, def] of Object.entries(LIB)) cases.push({ id: `lib:${id}`, def });

const which = (process.env.BODIES ?? "man50,woman5,heavy,thin").split(",");
const rows = [];
for (const name of which) {
  const body = fitBody(BODIES[name]()), h = {};
  const rig = buildRig(body, { skeleton: false, quality: "high", skinBuilder: (b, bones, o) => (h.skin = buildSkin(b, bones, o)) });
  const skin = h.skin, geo = skin.mesh.geometry, rest = Float64Array.from(geo.attributes.position.array);
  const restFace = faceNormals(rest, geo.index.array, 0, geo.index.array.length / 3);
  const restVol = {}; for (const [n, p] of Object.entries(skin.mesh.userData.parts)) restVol[n] = volume(rest, geo.index.array, p.triStart, p.triEnd);
  for (const c of cases) {
    apply(rig, c.def);
    const m = measurePose(rig, skin, rest, restFace);
    let vmin = 9, vmax = 0, vp = "";
    for (const [n, v] of Object.entries(m.volRatio)) { const r = v / restVol[n]; if (r < vmin) { vmin = r; vp = n; } if (r > vmax) vmax = r; }
    rows.push({ body: name, id: c.id, nonfinite: m.nonfinite, stretch: m.stretchMax, stretchWhere: m.stretchWhere, shrink: m.shrinkMin, folded: m.folded, foldedPart: m.foldedPart, vmin, vmax, vp });
  }
  rig.dispose();
  console.error(name, "done", cases.length, "cases");
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(rows));
const top = (f, n = 14) => rows.slice().sort((a, b) => f(b) - f(a)).slice(0, n);
console.log("cases", cases.length, "rows", rows.length, "nonfinite rows", rows.filter((r) => r.nonfinite).length);
console.log("-- worst stretch (posed edge / rest edge)");
for (const r of top((r) => r.stretch)) console.log(` ${r.stretch.toFixed(2)} ${r.body} ${r.id} in ${r.stretchWhere}`);
console.log("-- worst shrink");
for (const r of top((r) => -r.shrink)) console.log(` ${r.shrink.toFixed(3)} ${r.body} ${r.id}`);
console.log("-- most folded triangles");
for (const r of top((r) => r.folded)) console.log(` ${r.folded} ${r.body} ${r.id} ${JSON.stringify(r.foldedPart)}`);
console.log("-- smallest part volume ratio");
for (const r of top((r) => -r.vmin)) console.log(` ${r.vmin.toFixed(3)} ${r.vp} ${r.body} ${r.id}`);
console.log("-- largest part volume ratio");
for (const r of top((r) => r.vmax)) console.log(` ${r.vmax.toFixed(3)} ${r.body} ${r.id}`);
