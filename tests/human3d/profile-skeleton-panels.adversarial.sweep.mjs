// Adversarial sweep (not a node:test file; run directly):
//   node --import ./tests/human3d/register.mjs tests/human3d/profile-skeleton-panels.adversarial.sweep.mjs [maxPops]
// Every population of public/api/v1/index.json x percentile x scaling x reliability goes through the REAL pipeline pieces the Profile panel uses
// (anthro.percentileProfile -> panel finalizeProfile -> fitBody -> dimensionRows / report) and is checked for NaN leaks, unmapped dims, dead DIM_TARGET ids.
import fs from "node:fs";
import path from "node:path";
import * as P from "../../site/js/human/panels/profile.js";
import * as S from "../../site/js/human/panels/skeleton.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import { JOINTS } from "../../site/js/human/skeleton.js";

const DATA = path.resolve("public/api/v1");
const fetchJSON = async (url) => JSON.parse(fs.readFileSync(path.join(DATA, url.replace(/^api\/v1\//, "")), "utf8"));
const index = await anthro.loadIndex("api/v1", fetchJSON);
const cat = JSON.parse(fs.readFileSync(path.join(DATA, "measures.json"), "utf8"));
anthro.setMeasureCatalog(cat);
const max = Number(process.argv[2]) || 1e9;
const problems = new Map();
const bad = (k, msg) => { if (!problems.has(k)) problems.set(k, []); const a = problems.get(k); if (a.length < 6) a.push(msg); else if (a.length === 6) a.push("..."); };
const finiteDeep = (o, p, k, depth = 0) => {
  if (depth > 6 || o == null) return;
  if (typeof o === "number") { if (!Number.isFinite(o)) bad(k, `${p} = ${o}`); return; }
  if (typeof o === "object") for (const [kk, v] of Object.entries(o)) finiteDeep(v, `${p}.${kk}`, k, depth + 1);
};
let n = 0, built = 0, threw = 0, t0 = Date.now();
const targetMissing = new Set(), unmapped = new Set(), groupOther = new Set();
for (const e of index.populations.slice(0, max)) {
  for (const latest of e.has_latest ? [false, true] : [false]) {
    let file;
    try { file = await anthro.loadPopulation(e, { latest, fetchJSON }); } catch (err) { bad("load", `${e.url}: ${err.message}`); continue; }
    for (const pct of [1, 5, 50, 95, 99]) for (const scaling of ["percentile", "proportional"]) for (const rel of (pct === 50 ? ["high", "medium", "low"] : ["medium"])) {
      n++;
      let prof;
      try { prof = anthro.percentileProfile(file, { percentile: pct, scaling, minReliability: rel, meanStature: true }); }
      catch (err) { threw++; bad("percentileProfile-throws-"+scaling, `${e.country_id}/${e.role_id}/${e.sex}${latest ? ".latest" : ""} P${pct} ${scaling} ${rel}: ${err.message}`); continue; }
      let fin;
      try { fin = P.finalizeProfile(prof, {}); } catch (err) { bad("finalize", `${err.message}`); continue; }
      let body;
      try { body = fitBody(fin, { form: P.defaultForm(fin) }); } catch (err) { bad("fitBody-throws", `${e.country_id}/${e.role_id}/${e.sex} P${pct} ${scaling} ${rel}: ${err.message}`); continue; }
      built++;
      const tag = `${e.country_id}/${e.role_id}/${e.sex}${latest ? ".latest" : ""} P${pct} ${scaling} ${rel}`;
      finiteDeep(body.dims, "dims", "NaN-dims"); finiteDeep(body.report, "report", "NaN-report"); finiteDeep(body.joints, "joints", "NaN-joints"); finiteDeep(body.landmarks, "landmarks", "NaN-landmarks");
      if (!(body.stature > 1.2 && body.stature < 2.6)) bad("stature-range", `${tag}: ${body.stature}`);
      if (!(body.mass > 25 && body.mass < 250)) bad("mass-range", `${tag}: ${body.mass}`);
      const rows = P.dimensionRows(body, fin, cat);
      for (const r of rows) {
        if (!r.target) targetMissing.add(r.id);
        else if (r.target.landmark && !body.landmarks[r.target.landmark]) bad("dead-landmark-target", `${r.id} -> ${r.target.landmark}`);
        else if (r.target.joint && !JOINTS.find((j) => j.id === r.target.joint)) bad("dead-joint-target", `${r.id} -> ${r.target.joint}`);
        if (r.group === "other") groupOther.add(r.id);
        if (!Number.isFinite(r.value)) bad("row-NaN", `${tag} ${r.id}`);
        if (r.editability.kind === "measure" && r.kind === "kg" && r.id !== "mass") bad("kg-row", r.id);
      }
      // the report is internally consistent
      for (const rr of body.report) {
        if (rr.status === "n/a" && rr.input != null) bad("report-na-with-input", `${tag} ${rr.id}`);
        if (rr.status !== "n/a" && (rr.input == null || rr.model == null || rr.delta == null)) bad("report-eval-null", `${tag} ${rr.id} ${rr.status} ${JSON.stringify([rr.input, rr.model, rr.delta])}`);
        if (rr.input != null && rr.model != null && rr.delta != null && Math.abs((rr.model - rr.input) - rr.delta) > 1e-6 * Math.max(1, Math.abs(rr.input))) bad("report-delta-sign", `${tag} ${rr.id} in ${rr.input} model ${rr.model} delta ${rr.delta}`);
      }
      // every dim must be reachable from some joint in the mapping (or be non-skeleton)
      for (const r of rows) if (!JOINTS.some((j) => S.jointInfluences(j.id).has(r.id)) && !r.id.startsWith("ring_") && !["stature", "mass", "adiposity", "head_length", "head_breadth", "bizygomatic_breadth", "menton_sellion_length", "thigh_thickness", "foot_breadth", "hip_to_seat", "knee_top_front", "popliteal_below_knee", "buttock_back", "popliteal_setback", "olecranon_drop", "tragion_below_eye", "vertex_to_eye", "acromion_to_gh", "hand_breadth"].includes(r.id)) unmapped.add(r.id);
    }
  }
}
console.log(`combos ${n}, built ${built}, threw ${threw}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log("dims with no 3D target:", [...targetMissing].join(", ") || "none");
console.log("dims in group 'other':", [...groupOther].join(", ") || "none");
console.log("dims influencing no joint (not in ignore list):", [...unmapped].join(", ") || "none");
for (const [k, v] of problems) console.log(`PROBLEM ${k}:`, v.join(" | "));
