// Aggregates the jsonl output of body.adversarial.sweep.mjs:  node tests/human3d/body.adversarial.summary.mjs file.jsonl [...]
import fs from "node:fs";
const recs = [];
for (const f of process.argv.slice(2)) for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l) recs.push(JSON.parse(l));
const stat = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return "n/a"; const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return `n=${a.length} min ${a[0].toFixed(2)} p1 ${q(0.01).toFixed(2)} p50 ${q(0.5).toFixed(2)} p99 ${q(0.99).toFixed(2)} max ${a[a.length - 1].toFixed(2)}`; };
console.log("fits", recs.length, "errors", recs.filter((r) => r.error).length);
for (const r of recs.filter((r) => r.error).slice(0, 5)) console.log(" ERR", r.label, r.error);
const probs = new Map();
for (const r of recs) for (const p of [...(r.problems ?? []), ...(r.low?.problems ?? []).map((x) => "low:" + x)]) { const k = p.replace(/:\d+$/, ""); const e = probs.get(k) ?? { n: 0, ex: r.label }; e.n++; probs.set(k, e); }
console.log("problems:", [...probs].map(([k, v]) => `${k}=${v.n} (${v.ex})`).join("; ") || "none");
const ok = recs.filter((r) => !r.error);
console.log("tri high", stat(ok.map((r) => r.tri)), "\ntri low", stat(ok.map((r) => r.low?.tri)), "\nvert high", stat(ok.map((r) => r.vert)));
console.log("build ms high", stat(ok.map((r) => r.ms)), "\nbuild ms low", stat(ok.map((r) => r.low?.ms)));
console.log("volRatio", stat(ok.map((r) => r.volRatio)));
console.log("statureErr mm", stat(ok.map((r) => r.statureErr)), "\nsoleErr mm", stat(ok.map((r) => r.soleErr)));
const cr = new Map();
for (const r of ok) for (const [k, v] of Object.entries(r.crease ?? {})) { const kk = k.replace(/_[LR]$/, ""); const e = cr.get(kk) ?? []; e.push(v); cr.set(kk, e); }
for (const [k, a] of cr) console.log(`creases(>90deg) ${k}: fits ${a.length}, max ${Math.max(...a)}, median ${a.sort((x, y) => x - y)[a.length >> 1]}`);
for (const id of ["chest", "waist", "buttock", "neck_mid", "ua_biceps", "fa_max", "th_prox", "sh_calf", "sh_ankle", "th_knee"]) {
  const g = ok.map((r) => r.girth?.[id]).filter(Boolean);
  const vsRing = g.map((x) => (x.mesh / x.ring - 1) * 100), inp = g.filter((x) => x.input).map((x) => (x.mesh / x.input - 1) * 100);
  console.log(`girth ${id}: mesh/ring % ${stat(vsRing)} | mesh/input % ${stat(inp)}`);
}
for (const k of ["chestDepth", "chestBreadth", "hipBreadth", "bideltoid"]) {
  const g = ok.map((r) => r[k]).filter((x) => x && x.input);
  console.log(`${k} mesh-input mm: ${stat(g.map((x) => x.mesh - x.input))}`);
}
console.log("foot len err mm", stat(ok.map((r) => r.foot.len - r.foot.input)), "\nfoot width vs input mm", stat(ok.filter((r) => r.foot.bin).map((r) => r.foot.w - r.foot.bin)));
for (let k = 0; k < 4; k++) console.log(`leg gap ${k} (negative = left and right thigh skins overlap) mm`, stat(ok.map((r) => r.legGap?.[k])));
const worst = (f, n = 5) => ok.map((r) => [f(r), r.label]).filter((x) => Number.isFinite(x[0])).sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => `${x[0].toFixed(2)} ${x[1]}`).join("; ");
console.log("worst volRatio:", worst((r) => Math.abs(r.volRatio - 1)));
console.log("worst thigh girth vs input:", worst((r) => { const g = r.girth.th_prox; return g.input ? Math.abs(g.mesh / g.input - 1) * 100 : NaN; }));
console.log("worst calf girth vs input:", worst((r) => { const g = r.girth.sh_calf; return g.input ? Math.abs(g.mesh / g.input - 1) * 100 : NaN; }));
console.log("worst head crease:", worst((r) => r.crease?.head ?? 0));
