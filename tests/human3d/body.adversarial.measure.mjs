// Measurements taken on the mesh (not on the data): does the mannequin have the measured shoulder width, head size, hand size, chest, hip?
//   node --import ./tests/human3d/register.mjs tests/human3d/body.adversarial.measure.mjs [subjects|pops] [stride]
import { DatabaseSync } from "node:sqlite";
import { fitBody } from "../../site/js/human/fit.js";
import { subjectProfile } from "../../site/js/human/anthro.js";
import { buildSkin } from "../../site/js/human/body.js";
import { allPopulations, popProfile, makeBones, sliceY, rangeBox, DB_PATH } from "./body.adversarial.helpers.mjs";

const mode = process.argv[2] ?? "pops", stride = +(process.argv[3] ?? 1);
const jobs = [];
if (mode === "pops") for (const [c, r, s] of allPopulations()) for (const p of [5, 50, 95]) jobs.push({ label: `${c}/${r}/${s} P${p}`, make: () => popProfile(c, r, s, p) });
else { const db = new DatabaseSync(DB_PATH, { readOnly: true }); for (const r of db.prepare("select * from subjects order by dataset, subject_key").all()) jobs.push({ label: `${r.dataset}#${r.subject_key}`, make: () => subjectProfile(r) }); }
const rows = [];
for (let i = 0; i < jobs.length; i += stride) {
  const b = fitBody(jobs[i].make()), sk = buildSkin(b, makeBones(b)), g = sk.mesh.geometry, pos = g.attributes.position.array, idx = g.index.array, P = sk.mesh.userData.parts, T = b.shape.tubes, inp = b.inputs ?? {};
  const rec = { label: jobs[i].label, sex: b.form };
  // shoulder: widest arm skin within 40 mm below and anything above the deltoid ring
  const dl = T.upper_arm_L.rings.find((r) => r.id === "ua_deltoid"); let xo = 0;
  for (let v = P.arm_L.vertexStart; v < P.arm_L.vertexEnd; v++) if (pos[v * 3 + 1] > dl.c[1] - 0.04 && pos[v * 3 + 1] < dl.c[1] + 0.12) xo = Math.max(xo, pos[v * 3]);
  rec.bideltoid = inp.bideltoid_breadth != null ? 2000 * xo - inp.bideltoid_breadth * 1000 : null; rec.bideltoidModel = 2000 * xo;
  // head
  const hb = rangeBox(pos, P.head.vertexStart, P.head.vertexEnd);
  rec.headBreadth = inp.head_breadth != null ? (hb.hi[0] - hb.lo[0]) * 1000 - inp.head_breadth * 1000 : null;
  const ctr = (hb.hi[2] - hb.lo[2]) * 1000; rec.headLength = inp.head_length != null ? ctr - inp.head_length * 1000 : null;
  // hand: wrist joint to the longest fingertip
  const hl = []; for (const f of ["index", "middle", "ring", "little", "thumb"]) { const q = P[`${f}_L`]; const bx = rangeBox(pos, q.vertexStart, q.vertexEnd); hl.push(bx.lo[1]); }
  const wy = b.positions.wrist_L[1]; rec.handReach = (wy - Math.min(...hl)) * 1000;
  rec.handLenInput = inp.hand_length != null ? inp.hand_length * 1000 : b.d.hand_length * 1000;
  // chest / hip breadth at the ring heights, torso only (arms are separate parts)
  const ring = (id) => T.torso.rings.find((r) => r.id === id);
  const ch = sliceY(pos, idx, P.torso.triStart, P.torso.triEnd, ring("chest").c[1]); rec.chestB = (ch.x[1] - ch.x[0]) * 1000 - (inp.chest_breadth != null ? inp.chest_breadth * 1000 : NaN);
  // hip breadth (maximum): torso + legs at buttock-ring height and below
  let hx = 0; for (const part of ["torso", "leg_L"]) { const q = P[part]; for (let v = q.vertexStart; v < q.vertexEnd; v++) { const y = pos[v * 3 + 1]; if (y > T.torso.rings.find((r) => r.id === "buttock").c[1] - 0.12 && y < ring("buttock").c[1] + 0.04) hx = Math.max(hx, Math.abs(pos[v * 3])); } }
  rec.hipW = 2000 * hx; rec.hipIn = inp["other:hip_breadth"] != null ? inp["other:hip_breadth"] * 1000 : null;
  rec.hipVsBicristal = 2000 * hx - 2000 * b.d.hip_halfwidth;
  sk.dispose(); rows.push(rec);
}
const st = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return "n/a"; const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return `n=${a.length} min ${a[0].toFixed(1)} p5 ${q(0.05).toFixed(1)} p50 ${q(0.5).toFixed(1)} p95 ${q(0.95).toFixed(1)} max ${a[a.length - 1].toFixed(1)}`; };
for (const sex of ["male", "female", "neutral"]) { const r = rows.filter((x) => x.sex === sex); if (!r.length) continue; console.log(`== ${sex} (${r.length})`);
  console.log(" bideltoid mesh-input mm", st(r.map((x) => x.bideltoid)));
  console.log(" head breadth mesh-input mm", st(r.map((x) => x.headBreadth)), "\n head length mesh-input mm", st(r.map((x) => x.headLength)));
  console.log(" hand reach (wrist to tip) - hand length input mm", st(r.map((x) => x.handReach - x.handLenInput)));
  console.log(" chest breadth mesh-input mm", st(r.map((x) => x.chestB)));
  console.log(" max hip width (torso + thigh, buttock band) mm", st(r.map((x) => x.hipW)), " minus bicristal", st(r.map((x) => x.hipVsBicristal)));
}
const worst = (f, n = 5) => rows.map((r) => [f(r), r.label]).filter((x) => Number.isFinite(x[0])).sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => `${x[0].toFixed(1)} ${x[1]}`).join("; ");
console.log("worst bideltoid over", worst((r) => r.bideltoid), "\nworst bideltoid under", worst((r) => -r.bideltoid));
