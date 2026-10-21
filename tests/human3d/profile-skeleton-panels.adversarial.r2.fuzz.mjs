// Round 2: random imports (any subset of the model's measures, values 0.5x..1.6x of typical, some inconsistent) -> panel pipeline (finalize, fit, rows, report, summary) must neither throw nor leak NaN.
// node --import ./tests/human3d/register.mjs tests/human3d/profile-skeleton-panels.adversarial.r2.fuzz.mjs [N]
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import { JOINTS } from "../../site/js/human/skeleton.js";
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const base = anthro.percentileProfile(JSON.parse((await import("node:fs")).readFileSync("public/api/v1/populations/united-states/army/M.json")), { percentile: 50 });
const keys = Object.keys(base.measures);
const N = Number(process.argv[2]) || 1500; const bad = new Map(); const note = (k, m) => { const a = bad.get(k) ?? []; if (a.length < 3) a.push(m); bad.set(k, a); };
const fin = (o, p = "") => { if (typeof o === "number") { if (!Number.isFinite(o)) return p; } else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { const r = fin(v, p + "." + k); if (r) return r; } return null; };
for (let i = 0; i < N; i++) {
  const sel = keys.filter(() => rnd() < (i % 3 === 0 ? 0.05 : i % 3 === 1 ? 0.3 : 0.9));
  const obj = { sex: ["M", "F", "both", "x"][i % 4], stature: base.measures.stature.value * (0.78 + rnd() * 0.5) + "mm" };
  for (const k of sel) { const m = base.measures[k]; if (k === "stature") continue; const f = rnd() < 0.15 ? 0.5 + rnd() * 1.2 : 0.9 + rnd() * 0.2; obj[k] = `${(m.value * f).toFixed(1)} ${m.unit}`; }
  let prof; try { prof = anthro.parseImport(JSON.stringify(obj), "f.json"); } catch (e) { continue; }
  let fp, body; try { fp = P.finalizeProfile(prof, { form: ["male", "female", "neutral", null][i % 4] }); body = fitBody(fp, { form: fp.form ?? P.defaultForm(fp), overrides: fp.overrides }); } catch (e) { note("throw", `${i}: ${e.message.slice(0, 100)}`); continue; }
  const bad1 = fin(body.dims, "dims") ?? fin(body.report, "report") ?? fin(body.joints, "joints") ?? fin(body.landmarks, "lm") ?? fin(body.masses, "masses"); if (bad1) note("NaN", `${i}: ${bad1}`);
  try {
    const rows = P.dimensionRows(body, fp); P.statusCounts(rows); P.filterRows(rows, { query: "a b" }); P.groupRows(rows); for (const r of rows) { P.sourceText(r); P.fmtQuantity(r.kind === "mm" ? r.mm : r.value, r.kind, "in"); }
    P.reportSummary(body.report); P.sortReport(body.report); P.extrasNotice(fp, body); P.verifyExtras(fp, body);
    for (const j of JOINTS) { S.jointBoneStatus(j.id, body); S.restSegmentMm(j.id, body); }
  } catch (e) { note("panel-throw", `${i}: ${e.stack.split("\n").slice(0, 2).join(" ")}`); }
  if (body.stature < 1.2 || body.stature > 2.7) note("stature", `${i}: ${body.stature} for ${obj.stature}`);
  const ids = new Set(body.dims.map((d) => d.id)); if (ids.size !== body.dims.length) note("dup-dims", `${i}`);
}
console.log("done", N); for (const [k, v] of bad) console.log("PROBLEM", k, v.join(" | "));
