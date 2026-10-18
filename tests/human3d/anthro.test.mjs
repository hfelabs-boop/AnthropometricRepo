// Tests of site/js/human/anthro.js: the percentile maths against the Python service, the static files, real people from the SQLite database,
// import / export and editing.   node --import ./tests/human3d/register.mjs --test tests/human3d/anthro.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as A from "../../site/js/human/anthro.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "public");
const API = "api/v1";
const readJSON = rel => JSON.parse(fs.readFileSync(path.join(PUBLIC, rel), "utf8"));

// a fetchJSON that reads the built files, like the browser would over HTTP (404 -> error with .status)
let fetchCalls = 0;
async function fsFetch(url) {
  fetchCalls++;
  const f = path.join(PUBLIC, url);
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f)) { const e = new Error(`${url}: HTTP 404`); e.status = 404; throw e; }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
const rel = (x, y) => Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-300);
const index = await A.loadIndex(API, fsFetch);
const popFile = async (c, r, s, latest = false) => A.loadPopulation({ country_id: c, role_id: r, sex: s }, { latest, fetchJSON: fsFetch });

// ---------------------------------------------------------------------------------------------------------------- (3) normalQuantile
test("normalQuantile: known values within 1e-8", () => {
  const known = [[0.05, -1.6448536269514722], [0.5, 0], [0.95, 1.6448536269514722], [0.975, 1.959963984540054], [0.999, 3.090232306167813],
    [0.025, -1.959963984540054], [0.841344746068543, 1], [1e-10, -6.361340902404056], [0.001, -3.090232306167813]];
  for (const [p, z] of known) assert.ok(Math.abs(A.normalQuantile(p) - z) < 1e-8, `z(${p}) = ${A.normalQuantile(p)}, expected ${z}`);
});

test("normalQuantile: antisymmetric, increasing, and rejects p outside (0, 1)", () => {
  let prev = -Infinity;
  for (let i = 1; i < 1000; i++) {
    const p = i / 1000, z = A.normalQuantile(p);
    assert.ok(z > prev); prev = z;
    assert.ok(Math.abs(z + A.normalQuantile(1 - p)) < 1e-12);
  }
  assert.ok(Number.isFinite(A.normalQuantile(1e-300)));
  for (const bad of [0, 1, -0.1, 1.1, NaN, Infinity, undefined, "0.5x"]) assert.throws(() => A.normalQuantile(bad), RangeError);
});

// ---------------------------------------------------------------------------------------------------------------- Python cross-check
// One python3 process answers everything: AS241 on a grid, core.quantile on the file values, and Repo.design_values for the service's own numbers.
const PY = `
import json, sys, os
sys.path.insert(0, os.getcwd())
from statistics import NormalDist
from anthro_service import core
spec = json.load(sys.stdin)
out = {"z": [NormalDist().inv_cdf(p) for p in spec["probs"]], "pops": []}
repo = core.Repo()
for s in spec["pops"]:
    keys, pcts = s["keys"], s["pcts"]
    d = repo.design_values(s["country_id"], s["role_id"], s["sex"], measures=keys, percentiles=pcts, min_reliability="low", survey="latest" if s["latest"] else None)
    svc = {m["key"]: m["percentiles"] for m in d["measures"]}
    exact = {k: {core.pkey(p): core.quantile(v[0], v[1], v[2], p) for p in pcts} for k, v in s["file"].items()}
    out["pops"].append({"id": s["id"], "service": svc, "exact": exact})
json.dump(out, sys.stdout)
`;
const PCTS = [1, 5, 25, 50, 75, 95, 99];
const pyProbe = spawnSync("python3", ["-c", "import sys,os; sys.path.insert(0, os.getcwd()); import anthro_service.core"], { cwd: ROOT, encoding: "utf8" });
const PY_SKIP = pyProbe.status === 0 ? false : `python3 or anthro_service is unavailable (${(pyProbe.stderr || pyProbe.error?.message || "").split("\n").filter(Boolean).pop()})`;

// pick populations deterministically: a stride over the well-covered ones, plus two latest-survey files
async function pickPopulations() {
  const full = m => m.percentiles && ["p5", "p50", "p95"].every(k => Number.isFinite(m.percentiles[k]));
  const rich = [];
  for (const e of index.populations) if ((await A.loadPopulation(e, { fetchJSON: fsFetch })).measures.filter(full).length >= 10) rich.push(e);
  const stride = Math.floor(rich.length / 12);
  const picks = Array.from({ length: 12 }, (_, i) => ({ entry: rich[i * stride], latest: false }));
  for (const e of rich.filter(p => p.has_latest).slice(0, 2)) picks.push({ entry: e, latest: true });
  const specs = [];
  for (const { entry, latest } of picks) {
    const file = await A.loadPopulation(entry, { latest, fetchJSON: fsFetch });
    const ok = file.measures.filter(m => m.percentiles && ["p5", "p50", "p95"].every(k => Number.isFinite(m.percentiles[k])));
    const skewed = ok.filter(m => A.skewedPositive(m.percentiles.p5, m.percentiles.p50, m.percentiles.p95)).slice(0, 3);
    const rest = ok.filter(m => !skewed.includes(m)), want = 10 - skewed.length;
    const chosen = [...skewed, ...Array.from({ length: want }, (_, i) => rest[Math.floor(i * rest.length / want)])];
    specs.push({ id: `${entry.country_id}/${entry.role_id}/${entry.sex}${latest ? ".latest" : ""}`, country_id: entry.country_id, role_id: entry.role_id, sex: entry.sex, latest,
      keys: chosen.map(m => m.key), pcts: PCTS, file: Object.fromEntries(chosen.map(m => [m.key, [m.percentiles.p5, m.percentiles.p50, m.percentiles.p95]])), measures: chosen });
  }
  return specs;
}
const probs = [1e-12, 1e-6, 0.001, 0.01, 0.05, 0.2, 0.425, 0.5, 0.5750001, 0.9, 0.95, 0.999, 0.9999999, 1 - 1e-12, ...Array.from({ length: 99 }, (_, i) => (i + 1) / 100)];
let py = null;
const specs = await pickPopulations();
if (!PY_SKIP) {
  const r = spawnSync("python3", ["-c", PY], { cwd: ROOT, encoding: "utf8", input: JSON.stringify({ probs, pops: specs.map(({ measures, ...s }) => s) }), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("python helper failed: " + r.stderr);
  py = JSON.parse(r.stdout);
}

test("normalQuantile equals Python's NormalDist.inv_cdf on a grid (1e-14 relative)", { skip: PY_SKIP }, () => {
  probs.forEach((p, i) => assert.ok(rel(A.normalQuantile(p), py.z[i]) < 1e-14, `p=${p}: ${A.normalQuantile(p)} vs ${py.z[i]}`));
});

test("the sample covers 14 populations, 10 measures each, including skewed positive ones", () => {
  assert.ok(specs.length >= 12);
  for (const s of specs) assert.equal(s.keys.length, 10, s.id);
  assert.ok(specs.some(s => s.measures.some(m => A.skewedPositive(m.percentiles.p5, m.percentiles.p50, m.percentiles.p95))), "no skewed measure in the sample: the log tail is untested");
});

test("valueAtPercentile equals core.quantile on the same P5/P50/P95 (1e-9 relative), 1/5/25/50/75/95/99", { skip: PY_SKIP }, () => {
  let n = 0;
  for (const [i, s] of specs.entries()) {
    for (const m of s.measures) for (const p of PCTS) {
      const want = py.pops[i].exact[m.key]["p" + p], got = A.valueAtPercentile(m, p);
      assert.ok(rel(got.value, want) < 1e-9, `${s.id} ${m.key} p${p}: ${got.value} vs ${want}`);
      assert.equal(got.basis, p === 5 || p === 50 || p === 95 ? "reported" : p > 5 && p < 95 ? "interpolated" : "extrapolated");
      n++;
    }
  }
  assert.ok(n >= 12 * 10 * 7 * 0.7, `only ${n} comparisons`);
});

test("rounded like the service, the values agree with design_values up to the rounding of the file's P5/P50/P95", { skip: PY_SKIP }, () => {
  // the files hold rounded P5/P50/P95 (mm 0.1, others 0.01) while the service computes from unrounded rows, so the bound is the effect of
  // perturbing each input by half a rounding step (every corner), plus the two output roundings.
  let n = 0;
  for (const [i, s] of specs.entries()) {
    for (const m of s.measures) for (const p of PCTS) {
      const svc = py.pops[i].service[m.key]["p" + p];
      if (svc == null) continue;
      const d = m.unit === "mm" ? 1 : m.unit === "ratio" ? 3 : 2, e = 0.5 * 10 ** -d, [a, b, c] = s.file[m.key];
      const mine = A.roundValue(A.valueAtPercentile(m, p).value, m.unit), base = A.quantile(a, b, c, p);
      let tol = 2 * e + 1e-9;
      for (const da of [-e, e]) for (const db of [-e, e]) for (const dc of [-e, e]) tol = Math.max(tol, Math.abs(A.quantile(a + da, b + db, c + dc, p) - base) + 2 * e + 1e-9);
      assert.ok(Math.abs(mine - svc) <= tol, `${s.id} ${m.key} p${p}: ${mine} vs service ${svc} (tol ${tol})`);
      if (p === 5 || p === 50 || p === 95) assert.equal(mine, svc, `${s.id} ${m.key} p${p} is the file value itself`);
      n++;
    }
  }
  assert.ok(n > 500, `${n} comparisons`);
});

test("valueAtPercentile: missing percentiles, bad percentile, the log tail stays positive", () => {
  assert.deepEqual(A.valueAtPercentile({ percentiles: { p5: null, p50: null, p95: null } }, 50), { value: null, basis: "unavailable" });
  assert.deepEqual(A.valueAtPercentile({}, 50), { value: null, basis: "unavailable" });
  for (const bad of [0, 100, 0.05, 99.95, NaN, "50", null]) assert.throws(() => A.valueAtPercentile({ percentiles: { p5: 1, p50: 2, p95: 3 } }, bad), RangeError);
  const skinfold = { percentiles: { p5: 3, p50: 9, p95: 21 } }; // lower half 67% of the median: skewed
  assert.ok(A.skewedPositive(3, 9, 21));
  assert.ok(A.valueAtPercentile(skinfold, 0.1).value > 0 && A.valueAtPercentile(skinfold, 1).value > 0);
  assert.equal(A.valueAtPercentile({ percentiles: { p5: 3, p50: 9, p95: 21 } }, 95).value, 21);
  const lin = { percentiles: { p5: 100, p50: 150, p95: 200 } }; // symmetric: P25 is 150 - 0.6745/1.6449 * 50
  assert.ok(Math.abs(A.valueAtPercentile(lin, 25).value - (150 - 0.6744897501960817 / 1.6448536269514722 * 50)) < 1e-9);
});

test("roundValue uses the service's decimals", () => {
  assert.equal(A.roundValue(1749.349, "mm"), 1749.3);
  assert.equal(A.roundValue(76.3449, "kg"), 76.34);
  assert.equal(A.roundValue(0.123456, "ratio"), 0.123);
  assert.equal(A.roundValue(NaN, "mm"), null);
});

// ---------------------------------------------------------------------------------------------------------------- (1) static files
test("loadIndex: normalised populations and country tree", () => {
  const raw = readJSON("api/v1/index.json");
  assert.equal(index.populations.length, raw.populations.length);
  assert.ok(index.populations.length >= 170);
  const us = index.populations.find(p => p.country_id === "united-states" && p.role_id === "army" && p.sex === "M");
  assert.equal(us.country, "United States"); assert.equal(us.role, "Army"); assert.equal(us.has_latest, true); assert.ok(us.has_mannequin); assert.ok(us.measures > 100);
  assert.equal(us.url, "api/v1/populations/united-states/army/M.json");
  assert.equal(us.latest_url, "api/v1/populations/united-states/army/M.latest.json");
  const c = index.countries.find(x => x.id === "united-states");
  assert.equal(c.name, "United States");
  assert.deepEqual(c.roles.find(r => r.id === "army").sexes, ["M", "F", "both"].filter(s => index.populations.some(p => p.country_id === "united-states" && p.role_id === "army" && p.sex === s)));
  // the tree and the flat list describe the same set, sorted
  let n = 0;
  for (const cc of index.countries) for (const r of cc.roles) n += r.sexes.length;
  assert.equal(n, index.populations.length);
  assert.deepEqual(index.countries.map(x => x.name), [...index.countries.map(x => x.name)].sort((a, b) => a.localeCompare(b, "en")));
  const noLatest = index.populations.find(p => !p.has_latest);
  assert.equal(noLatest.latest_url, null);
});

test("every indexed population file exists and loads (all 176, plus the latest and the mannequin files)", async () => {
  for (const p of index.populations) {
    assert.ok(fs.existsSync(path.join(PUBLIC, p.url)), p.url);
    if (p.has_latest) assert.ok(fs.existsSync(path.join(PUBLIC, p.latest_url)), p.latest_url);
  }
  const f = await A.loadPopulation(index.populations[0], { fetchJSON: fsFetch });
  assert.ok(Array.isArray(f.measures) && f.population.country_id === index.populations[0].country_id);
  const latest = await popFile("united-states", "army", "M", true);
  assert.equal(latest.population.survey.id, "ansur-ii-2012");
});

test("loadPopulation: cached by URL, a failed load is retried, 404 and bad ids give clear errors", async () => {
  const counting = async u => { fetchCalls++; return fsFetch(u); };
  fetchCalls = 0;
  const e = { country_id: "united-states", role_id: "army", sex: "F" };
  const [a, b] = await Promise.all([A.loadPopulation(e, { fetchJSON: counting }), A.loadPopulation(e, { fetchJSON: counting })]);
  assert.equal(a, b);
  await A.loadPopulation(e, { fetchJSON: counting });
  assert.equal(fetchCalls, 2, "one fetch for the population (plus the counting wrapper's inner call)");
  await assert.rejects(A.loadPopulation({ country_id: "atlantis", role_id: "navy", sex: "M", country: "Atlantis", role: "Navy" }, { fetchJSON: fsFetch }), /No data file for Atlantis \/ Navy \/ M/);
  await assert.rejects(A.loadPopulation({ ...e, has_latest: false, country: "United States", role: "Army" }, { latest: true, fetchJSON: fsFetch }), /no latest-survey file/);
  for (const bad of [{ country_id: "../etc", role_id: "army", sex: "M" }, { country_id: "united-states", role_id: "a/b", sex: "M" }, { country_id: "united-states", role_id: "army", sex: "X" }, null, {}]) {
    await assert.rejects(A.loadPopulation(bad, { fetchJSON: fsFetch }), TypeError);
  }
  let calls = 0;
  const flaky = async u => { if (calls++ === 0) throw new Error("network down"); return fsFetch(u); };
  await assert.rejects(A.loadPopulation(e, { fetchJSON: flaky }), /Could not load .*network down/);
  assert.ok((await A.loadPopulation(e, { fetchJSON: flaky })).measures.length > 0);
  await assert.rejects(A.loadPopulation(e, { base: "nope", fetchJSON: fsFetch }), /not found/);
  await assert.rejects(A.loadPopulation(e, { fetchJSON: async () => ({ hello: 1 }) }), /not a populations file/);
});

test("the default fetch reports HTTP and network errors plainly", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    A.clearCache();
    await assert.rejects(A.loadIndex("somewhere/api/v1/"), /index was not found at somewhere\/api\/v1\/index.json/);
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(A.loadIndex("x"), /Could not reach x\/index.json/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    await assert.rejects(A.loadIndex("y"), /not valid JSON/);
    globalThis.fetch = async u => ({ ok: true, status: 200, json: async () => ({ populations: [], url: u }) });
    const idx = await A.loadIndex("z//");
    assert.deepEqual(idx, { populations: [], countries: [] });
  } finally { globalThis.fetch = real; A.clearCache(); }
});

test("loadMeasures registers names and units for labelOf / unitOf", async () => {
  const list = await A.loadMeasures(API, fsFetch);
  try {
    assert.ok(list.length > 500);
    assert.equal(A.labelOf("stature"), "Stature");
    assert.equal(A.labelOf("mass"), "Body mass");
    assert.equal(A.unitOf("mass"), "kg");
    assert.equal(A.unitOf("bmi"), "kg/m²");
    assert.equal(A.unitOf("stature"), "mm");
    assert.equal(A.labelOf("stature", list), A.labelOf("stature"));
    assert.equal(A.labelOf("other:lateral_malleolus_height", [{ key: "other:lateral_malleolus_height", name: "Lateral malleolus height" }]), "Lateral malleolus height");
  } finally { A.setMeasureCatalog([]); }
  // fallbacks without a catalog
  assert.equal(A.labelOf("other:wrist_height"), "Wrist height");
  assert.equal(A.labelOf("sitting_height"), "Sitting height");
  assert.equal(A.unitOf("other:weight_as_reported"), "kg");
  assert.equal(A.unitOf("other:fat_free_mass_kg"), "kg");
  assert.equal(A.unitOf("other:waist_hip_ratio"), "ratio");
  assert.equal(A.unitOf("other:something_unknown"), "mm");
});

test("SKELETON_MEASURES: the 54 inputs, unique, all exist in measures.json, frozen", () => {
  assert.equal(A.SKELETON_MEASURES.length, 54);
  assert.equal(new Set(A.SKELETON_MEASURES).size, 54);
  const keys = new Set(readJSON("api/v1/measures.json").map(m => m.key));
  assert.deepEqual(A.SKELETON_MEASURES.filter(k => !keys.has(k)), []);
  assert.ok(Object.isFrozen(A.SKELETON_MEASURES));
  assert.ok(A.SKELETON_MEASURES.includes("stature") && A.SKELETON_MEASURES.includes("other:wrist_height"));
});

// ---------------------------------------------------------------------------------------------------------------- percentile profiles
test("percentileProfile P50: the file's own medians, status follows the file's basis, filters like the service", async () => {
  const f = await popFile("united-states", "army", "M");
  const p = A.percentileProfile(f);
  assert.equal(p.sex, "M"); assert.equal(p.label, "United States · Army · men · P50");
  assert.equal(p.source.kind, "population"); assert.equal(p.source.percentile, 50);
  assert.equal(p.measures.stature.value, f.measures.find(m => m.key === "stature").percentiles.p50);
  assert.equal(p.measures.mass.unit, "kg");
  for (const m of f.measures) {
    const e = p.measures[m.key];
    if (m.reliability === "low" || !e) { assert.equal(e, undefined, `${m.key} is low reliability and must be hidden at medium`); continue; }
    assert.equal(e.value, m.percentiles.p50, m.key);
    assert.equal(e.status, m.percentile_basis.p50 === "estimated" ? "estimated" : "reported", m.key);
    assert.equal(e.reliability, m.reliability);
  }
  const all = A.percentileProfile(f, { minReliability: "low" }), high = A.percentileProfile(f, { minReliability: "high" });
  assert.ok(Object.keys(all.measures).length >= Object.keys(p.measures).length && Object.keys(p.measures).length >= Object.keys(high.measures).length);
  assert.ok(Object.values(high.measures).every(m => m.reliability === "high"));
  assert.deepEqual(Object.keys(A.percentileProfile(f, { minReliability: "all" }).measures), Object.keys(all.measures));
  assert.ok(p.notes.some(n => /reference body/.test(n)));
  assert.ok(p.notes.some(n => /1966 to 2010/.test(n)), "the vintage note of the file is kept");
  assert.ok(!p.notes.some(n => /^Population statistics for design studies/.test(n) || /^The static files/.test(n)));
});

test("percentileProfile P5..P95 interpolates, P1/P99 extrapolates and says so; P95 is the file's P95", async () => {
  const f = await popFile("united-states", "army", "M");
  const p95 = A.percentileProfile(f, { percentile: 95 }), p75 = A.percentileProfile(f, { percentile: 75 }), p99 = A.percentileProfile(f, { percentile: 99 }), p5 = A.percentileProfile(f, { percentile: 5 });
  const st = f.measures.find(m => m.key === "stature");
  assert.equal(p95.measures.stature.value, st.percentiles.p95);
  assert.equal(p5.measures.stature.value, st.percentiles.p5);
  assert.equal(p95.measures.stature.basis, "reported");
  assert.equal(p75.measures.stature.basis, "interpolated");
  assert.ok(p75.measures.stature.value > st.percentiles.p50 && p75.measures.stature.value < st.percentiles.p95);
  assert.equal(p99.measures.stature.basis, "extrapolated");
  assert.equal(p99.measures.stature.status, "estimated");
  assert.match(p99.measures.stature.note, /extrapolated/);
  assert.ok(p99.notes.some(n => /extrapolated/.test(n)) && p75.notes.some(n => /interpolated/.test(n)) && p95.notes.some(n => /boundary case/.test(n)));
  assert.equal(p75.measures.stature.status, "reported", "both anchors of the line are printed values");
  // interpolation status follows the anchors of the line it uses
  const mk = (b5, b50, b95) => ({ population: { country_id: "x", role_id: "y", sex: "M", country: "X", role: "Y" }, measures: [{ key: "stature", unit: "mm", reliability: "high", percentiles: { p5: 1500, p50: 1700, p95: 1900 }, percentile_basis: { p5: b5, p50: b50, p95: b95 } }] });
  assert.equal(A.percentileProfile(mk("estimated", "reported", "reported"), { percentile: 75 }).measures.stature.status, "reported");
  assert.equal(A.percentileProfile(mk("estimated", "reported", "reported"), { percentile: 25 }).measures.stature.status, "estimated");
  assert.equal(A.percentileProfile(mk("reported", "pooled", "estimated"), { percentile: 75 }).measures.stature.status, "estimated");
  assert.equal(A.percentileProfile(mk("reported", "pooled", "estimated"), { percentile: 95 }).measures.stature.status, "estimated");
  assert.equal(A.percentileProfile(mk("reported", "pooled", "estimated"), { percentile: 5 }).measures.stature.status, "reported");
  for (const bad of [0.5, 100, NaN, "50", null]) assert.throws(() => A.percentileProfile(f, { percentile: bad }), RangeError);
  assert.throws(() => A.percentileProfile(f, { minReliability: "bogus" }), RangeError);
  assert.throws(() => A.percentileProfile(f, { scaling: "bogus" }), RangeError);
  assert.throws(() => A.percentileProfile({}, {}), TypeError);
});

test("percentileProfile over every population at P5, P50, P95 and P99 never produces a non-finite or negative value", () => {
  for (const p of index.populations) {
    const f = readJSON(p.url);
    for (const pct of [1, 5, 50, 95, 99]) {
      const prof = A.percentileProfile(f, { percentile: pct, minReliability: "low" });
      for (const [k, m] of Object.entries(prof.measures)) {
        assert.ok(Number.isFinite(m.value), `${p.url} ${k} p${pct}`);
        if (f.measures.find(x => x.key === k).percentiles.p5 > 0) assert.ok(m.value > 0, `${p.url} ${k} p${pct} = ${m.value}`);
      }
    }
  }
});

test("percentileProfile proportional: the median scaled by the stature ratio (lengths x s, mass x s^3), stature as the percentile", async () => {
  const f = await popFile("united-states", "army", "M");
  const med = A.percentileProfile(f), prop = A.percentileProfile(f, { percentile: 95, scaling: "proportional" }), pct = A.percentileProfile(f, { percentile: 95 });
  const s = pct.measures.stature.value / med.measures.stature.value;
  assert.ok(s > 1.04 && s < 1.09);
  assert.equal(prop.measures.stature.value, pct.measures.stature.value);
  assert.ok(Math.abs(prop.measures.hand_length.value - med.measures.hand_length.value * s) < 0.11);
  assert.ok(Math.abs(prop.measures.waist_circumference.value - med.measures.waist_circumference.value * s) < 0.11);
  assert.ok(Math.abs(prop.measures.mass.value - med.measures.mass.value * s ** 3) < 0.02);
  assert.equal(prop.measures.mass.status, "estimated"); assert.equal(prop.measures.mass.basis, "scaled");
  assert.deepEqual(Object.keys(prop.measures), Object.keys(med.measures));
  assert.equal(prop.source.scaling, "proportional");
  assert.match(prop.label, /P95 stature, scaled median/);
  assert.ok(prop.notes[0].includes("geometric similarity") && /upper estimates/.test(prop.notes[0]));
  // proportions of the median are kept
  const ratio = (a, b, pr) => pr.measures[a].value / pr.measures[b].value;
  assert.ok(Math.abs(ratio("sitting_height", "stature", prop) - ratio("sitting_height", "stature", med)) < 2e-3);
  // unit-free measures keep their median
  for (const [k, m] of Object.entries(prop.measures)) if (!["mm", "kg", "kg/m²", "cm2", "N"].includes(m.unit)) assert.equal(m.value, med.measures[k].value, k);
  // at P50 it is the median itself; the profile of a population without stature refuses
  assert.deepEqual(A.percentileProfile(f, { percentile: 50, scaling: "proportional" }).measures, med.measures);
  const noStature = { ...f, measures: f.measures.filter(m => m.key !== "stature") };
  assert.throws(() => A.percentileProfile(noStature, { scaling: "proportional", percentile: 90 }), /needs a stature/);
  assert.ok(A.percentileProfile(noStature).notes.some(n => /no stature/.test(n)));
});

test("percentileProfile of the latest-survey file and of a mixed-sex file", async () => {
  const l = A.percentileProfile(await popFile("united-states", "army", "M", true));
  assert.match(l.label, /ANSUR II 2012/); assert.ok(l.id.endsWith(".latest@p50:medium"));
  const both = index.populations.find(p => p.sex === "both" && p.measures > 8);
  const b = A.percentileProfile(await A.loadPopulation(both, { fetchJSON: fsFetch }), { minReliability: "low" });
  assert.equal(b.sex, "both");
  assert.ok(b.notes.some(n => /neutral/.test(n)));
  assert.equal(A.percentileProfile(await popFile("united-states", "army", "M"), { label: "  My\u0000 body  " }).label, "My body");
});

// ---------------------------------------------------------------------------------------------------------------- (4) subjects
const dbPath = path.join(ROOT, "database", "anthro.sqlite");
let sqlite = null;
try { sqlite = fs.existsSync(dbPath) ? await import("node:sqlite") : null; } catch { sqlite = null; }
const DB_SKIP = sqlite ? false : "database/anthro.sqlite (python scripts/build_database.py) or node:sqlite is unavailable";
let db = null, queryFn = null;
if (sqlite) {
  db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  queryFn = async (sql, params = []) => { const st = db.prepare(sql); const columns = st.columns().map(c => c.name); st.setReturnArrays(true); return { columns, rows: st.all(...params) }; };
}

test("subjects: the whitelist matches the table (nothing identifying selected, every body column covered)", { skip: DB_SKIP }, () => {
  const cols = db.prepare("PRAGMA table_info(subjects)").all().map(c => c.name);
  for (const k of A.SUBJECT_MEASURES) assert.ok(cols.includes(k), k);
  const excluded = ["subject_key", "dataset", "source_id", "sex", "branch", "component", "handedness", "bmi", "age"];
  assert.deepEqual(cols.filter(c => !excluded.includes(c) && !A.SUBJECT_MEASURES.includes(c)), [], "a new column in subjects: add it to SUBJECT_MEASURES or to the excluded list");
  for (const d of db.prepare("SELECT DISTINCT dataset FROM subjects").all()) assert.ok(A.SUBJECT_DATASETS[d.dataset], d.dataset);
});

test("nearestSubject: the closest person by stature and mass (checked by brute force), honouring the filters", { skip: DB_SKIP }, async () => {
  const all = db.prepare("SELECT subject_key, dataset, sex, branch, stature, mass FROM subjects WHERE stature IS NOT NULL AND mass IS NOT NULL ORDER BY subject_key").all();
  const best = (rows, st, ms) => rows.reduce((b, r) => { const d = ((r.stature - st) / 65) ** 2 + ((r.mass - ms) / 12) ** 2; return d < b.d - 1e-12 ? { d, r } : b; }, { d: Infinity }).r;
  for (const [st, ms] of [[1750, 76], [1500, 45], [2040, 130], [1623.4, 61.2]]) {
    const got = await A.nearestSubject(queryFn, { stature: st, mass: ms });
    assert.equal(got.subject_key, best(all, st, ms).subject_key, `${st}/${ms}`);
    assert.ok(got.match_distance >= 0);
    const f = await A.nearestSubject(queryFn, { stature: st, mass: ms, sex: "F", dataset: "ansur_ii_2012" });
    assert.equal(f.subject_key, best(all.filter(r => r.sex === "F" && r.dataset === "ansur_ii_2012"), st, ms).subject_key);
    assert.equal(f.sex, "F"); assert.equal(f.dataset, "ansur_ii_2012");
  }
  const nearest = await A.nearestSubject(queryFn, { stature: 1750, mass: 76 });
  assert.ok(Math.abs(nearest.stature - 1750) < 25 && Math.abs(nearest.mass - 76) < 4, "a real person close to the target exists");
  const byStature = await A.nearestSubject(queryFn, { stature: 1801 });
  assert.ok(Math.abs(byStature.stature - 1801) <= 1);
  const army = await A.nearestSubject(queryFn, { stature: 1750, mass: 76, branch: "Army (Combat Arms)" });
  assert.equal(army.branch, "Army (Combat Arms)");
  assert.equal(await A.nearestSubject(queryFn, { stature: 1750, dataset: "nope" }), null);
  assert.equal(await A.nearestSubject(queryFn, { stature: 1750, branch: "'; DROP TABLE subjects; --" }), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM subjects").get().n, 13792);
  for (const bad of [{}, { stature: NaN }, { stature: "1750" }, { stature: 10 }, { stature: 1750, mass: -3 }]) await assert.rejects(A.nearestSubject(queryFn, bad), RangeError);
});

test("subjectById, listSubjects, subjectFilters", { skip: DB_SKIP }, async () => {
  const one = await A.subjectById(queryFn, 1);
  assert.equal(one.subject_key, 1); assert.equal(one.dataset, "ansur_1988"); assert.equal(one.stature, 1735); assert.equal(one.mass, 88.3);
  assert.deepEqual((await A.subjectById(queryFn, "1")).stature, 1735);
  assert.equal(await A.subjectById(queryFn, 99999999), null);
  for (const bad of [0, -1, 1.5, "1; DROP TABLE subjects", NaN, null]) await assert.rejects(A.subjectById(queryFn, bad), RangeError);
  const list = await A.listSubjects(queryFn, { dataset: "usaf_1967", sex: "M", limit: 25 });
  assert.equal(list.length, 25);
  assert.ok(list.every(r => r.dataset === "usaf_1967" && r.sex === "M") && list.every((r, i) => i === 0 || r.stature >= list[i - 1].stature));
  assert.deepEqual(Object.keys(list[0]), ["subject_key", "dataset", "sex", "branch", "stature", "mass"]);
  assert.equal((await A.listSubjects(queryFn, { sex: "F", limit: 99999 })).length, 4426 > 5000 ? 5000 : 4426);
  const f = await A.subjectFilters(queryFn);
  assert.equal(f.reduce((t, r) => t + r.n, 0), 13792);
});

test("subjectProfile: individual status, stature and mass, and nothing that identifies a person", { skip: DB_SKIP }, async () => {
  const row = await A.nearestSubject(queryFn, { stature: 1780, mass: 82, dataset: "ansur_ii_2012", sex: "M" });
  for (const hidden of ["source_id", "component", "handedness", "age", "bmi"]) assert.ok(!(hidden in row), `${hidden} must not even be selected`);
  const p = A.subjectProfile(row);
  assert.ok(p.measures.stature.value > 0 && p.measures.mass.value > 0);
  assert.equal(p.measures.mass.unit, "kg"); assert.equal(p.measures.stature.unit, "mm");
  assert.ok(Object.values(p.measures).every(m => m.status === "individual" && m.n === 1));
  assert.ok(Object.keys(p.measures).every(k => A.SUBJECT_MEASURES.includes(k)));
  assert.deepEqual(Object.keys(p.source).sort(), ["branch", "dataset", "kind", "sex", "subject_key"]);
  assert.equal(p.source.kind, "individual");
  assert.equal(p.sex, "M");
  assert.match(p.label, /^ANSUR II 2012 \(US Army\) · men · Army .* · person #\d+$/);
  assert.deepEqual(Object.keys(p).sort(), ["id", "label", "measures", "notes", "sex", "source"]);
  // even a row that carries extras (someone passing a SELECT *) leaks nothing
  const star = db.prepare("SELECT * FROM subjects WHERE subject_key = ?").get(row.subject_key);
  const text = JSON.stringify(A.subjectProfile({ ...star }));
  for (const hidden of ["source_id", "component", "handedness", "\"age\"", "\"bmi\""]) assert.ok(!text.includes(hidden), hidden);
  assert.ok(!("age" in A.subjectProfile(star).measures));
  assert.equal(A.subjectProfile({ ...row, sex: "?" }).sex, "both");
  assert.throws(() => A.subjectProfile(null), TypeError);
  assert.throws(() => A.subjectProfile({ stature: 1 }), TypeError);
  // round trip through the importers
  const back = A.parseImport(A.profileToJSON(p));
  assert.equal(back.measures.stature.value, p.measures.stature.value); assert.equal(back.measures.stature.status, "individual");
});

// ---------------------------------------------------------------------------------------------------------------- (5) import / export
const mannequin = readJSON("api/v1/mannequin/united-states/army/M.json");
const usFile = readJSON("api/v1/populations/united-states/army/M.json");
const med = A.percentileProfile(usFile);

test("parseImport: our populations JSON (median), the latest file", () => {
  const p = A.parseImport(fs.readFileSync(path.join(PUBLIC, "api/v1/populations/united-states/army/M.json"), "utf8"), "M.json");
  assert.equal(p.source.kind, "import"); assert.equal(p.source.format, "populations-json"); assert.equal(p.source.filename, "M.json");
  assert.equal(p.sex, "M");
  assert.equal(p.measures.stature.value, med.measures.stature.value);
  assert.equal(p.measures.mass.value, med.measures.mass.value);
  assert.deepEqual(Object.keys(p.measures), Object.keys(med.measures));
  assert.ok(p.notes[0].startsWith('Imported from "M.json"'));
  const l = A.parseImport(fs.readFileSync(path.join(PUBLIC, "api/v1/populations/united-states/army/F.latest.json"), "utf8"));
  assert.equal(l.sex, "F"); assert.ok(l.measures.stature.value > 1500 && l.measures.stature.value < 1800);
});

test("parseImport: the API mannequin JSON (static file with percentile sets, core only, and the live /v1/mannequin shape)", () => {
  const p = A.parseImport(JSON.stringify(mannequin), "mannequin.json");
  assert.equal(p.source.format, "mannequin-json");
  assert.equal(p.measures.stature.value, mannequin.percentiles.p50.values.stature);
  assert.equal(p.measures.mass.value, mannequin.percentiles.p50.values.mass);
  assert.equal(p.sex, "M");
  assert.equal(Object.keys(p.measures).length, Object.keys(mannequin.percentiles.p50.values).length);
  const est = Object.entries(mannequin.percentiles.p50.basis).find(([, b]) => b === "estimated");
  if (est) assert.equal(p.measures[est[0]].status, "estimated");
  assert.ok(p.measures.stature.reliability);
  const coreOnly = A.parseImport(JSON.stringify({ percentiles: { p50: { core: mannequin.percentiles.p50.core } } }));
  assert.equal(coreOnly.measures.stature.value, mannequin.percentiles.p50.core.stature_mm);
  assert.equal(coreOnly.measures.mass.value, mannequin.percentiles.p50.core.body_mass_kg);
  assert.equal(coreOnly.measures.sitting_height.value, mannequin.percentiles.p50.core.sitting_height_mm);
  const p95 = A.parseImport(JSON.stringify({ ...mannequin, percentiles: { p5: mannequin.percentiles.p5, p95: mannequin.percentiles.p95 } }));
  assert.equal(p95.measures.stature.value, mannequin.percentiles.p5.values.stature, "no p50 set: the first set");
  const live = { population: { sex: "F" }, percentile: 50, core: {}, values: { stature: 1650, mass: 60.5, "other:weight_as_reported": 61 }, units: { stature: "mm", mass: "kg", "other:weight_as_reported": "kg" },
    dimensions: [{ key: "stature", value: 1650, basis: "estimated", reliability: "high", n: 100, unit: "mm" }, { key: "mass", value: 60.5, basis: "reported", reliability: "medium", n: 90, unit: "kg" }] };
  const lp = A.parseImport(JSON.stringify(live));
  assert.equal(lp.sex, "F"); assert.equal(lp.measures.stature.status, "estimated"); assert.equal(lp.measures.mass.reliability, "medium"); assert.equal(lp.measures["other:weight_as_reported"].value, 61);
});

test("parseImport: flat JSON with units in the value, the unit field, the key suffix and the key", () => {
  const p = A.parseImport('{"stature": 1750, "mass": 75.5, "sex": "male", "label": "Test person"}');
  assert.deepEqual([p.measures.stature.value, p.measures.mass.value, p.sex, p.label], [1750, 75.5, "M", "Test person"]);
  assert.deepEqual(A.parseImport('{"stature": "175 cm", "mass": "165 lb", "hand_length": "7.5 in"}').measures,
    { stature: { value: 1750, unit: "mm", status: "reported" }, mass: { value: 74.843, unit: "kg", status: "reported" }, hand_length: { value: 190.5, unit: "mm", status: "reported" } });
  assert.equal(A.parseImport('{"measures": {"stature": {"value": 1.82, "unit": "m"}, "mass": {"value": 80, "unit": "kg"}}}').measures.stature.value, 1820);
  assert.equal(A.parseImport('{"stature_cm": 181, "body_mass_kg": 80, "sitting_height_mm": 940}').measures.stature.value, 1810);
  const k = A.parseImport('{"Stature (cm)": 181, "Body mass (lb)": 176, "wrist height": 800, "Hand Length": 190}');
  assert.deepEqual(Object.keys(k.measures).sort(), ["hand_length", "mass", "other:wrist_height", "stature"]);
  assert.equal(k.measures.stature.value, 1810);
  assert.equal(k.measures.mass.value, 79.832, "converted values are rounded to 0.001 kg");
  assert.equal(A.parseImport('{"height": 1800, "weight": 70}').measures.mass.value, 70);
  assert.equal(A.parseImport('{"stature": 1800, "other:fat_free_mass_kg": 60}').measures["other:fat_free_mass_kg"].value, 60, "a key that really ends in _kg keeps its name");
  const arr = A.parseImport('[{"key": "stature", "value": 1.7, "unit": "m"}, {"measure_key": "mass", "value": 70}]');
  assert.deepEqual([arr.measures.stature.value, arr.measures.mass.value], [1700, 70]);
  assert.equal(A.parseImport('{"stature": 1750, "age": 33}').measures.age.unit, "years");
  assert.equal(A.parseImport('{"stature": 1750, "sex": "both"}').sex, "both");
});

test("parseImport: profile JSON round trip keeps values, units, statuses, reliability, n and the edit history", () => {
  const edited = A.editMeasure(med, "stature", 1.8, "m");
  const back = A.parseImport(A.profileToJSON(edited), "p.json");
  assert.deepEqual(back.measures, edited.measures);
  assert.equal(back.sex, edited.sex); assert.equal(back.label, edited.label);
  assert.equal(back.source.kind, "import"); assert.equal(back.source.original, "population");
  assert.equal(back.measures.stature.status, "edited");
  assert.ok(JSON.parse(A.profileToJSON(edited)).format === "digital-human-profile");
  // a statuses / reliability outside the vocabulary falls back instead of leaking through
  const weird = A.parseImport('{"format":"digital-human-profile","sex":"M","measures":{"stature":{"value":1700,"unit":"mm","status":"<script>","reliability":"bogus","n":-4,"note":"x"}}}');
  assert.deepEqual(weird.measures.stature, { value: 1700, unit: "mm", status: "reported", note: "x" });
});

test("parseImport: CSV in every accepted layout", () => {
  const long = A.parseImport("key,value,unit\nstature,175,cm\nmass,70,kg\nhand_length,190,mm\n", "a.csv");
  assert.deepEqual([long.measures.stature.value, long.measures.mass.value, long.measures.hand_length.value, long.source.format], [1750, 70, 190, "csv"]);
  const mk = A.parseImport("measure_key,value\r\nstature,1801\r\nmass,82.5\r\nother:wrist_height,830\r\n");
  assert.deepEqual([mk.measures.stature.value, mk.measures.mass.value, mk.measures["other:wrist_height"].value], [1801, 82.5, 830]);
  const bom = A.parseImport("﻿key;value;unit\nstature;1,75;m\nmass;70,5;kg\n");
  assert.deepEqual([bom.measures.stature.value, bom.measures.mass.value], [1750, 70.5]);
  const quoted = A.parseImport('Key,Value,Unit,Note\n"stature",1750,mm,"measured, ""barefoot"""\nmass,"75 kg",,\n');
  assert.equal(quoted.measures.stature.note, 'measured, "barefoot"'); assert.equal(quoted.measures.mass.value, 75);
  const wide = A.parseImport("stature_cm,mass,sex\n176,71,F\n");
  assert.deepEqual([wide.measures.stature.value, wide.measures.mass.value, wide.sex, wide.source.format], [1760, 71, "F", "csv-wide"]);
  const meta = A.parseImport("# label: Test\n# sex: F\nkey,value\nstature,1650\n");
  assert.deepEqual([meta.sex, meta.label], ["F", "Test"]);
  const pubCsv = A.parseImport(fs.readFileSync(path.join(PUBLIC, "api/v1/populations/united-states/army/M.csv"), "utf8"), "M.csv");
  assert.equal(pubCsv.source.format, "populations-csv");
  assert.equal(pubCsv.measures.stature.value, usFile.measures.find(m => m.key === "stature").percentiles.p50);
  assert.equal(pubCsv.sex, "M");
  assert.ok(Object.keys(pubCsv.measures).length > 100);
});

test("profileToCSV / profileToJSON: round trip, formula-safe cells", () => {
  const edited = A.editMeasure(med, "mass", 80);
  const csv = A.profileToCSV(edited);
  assert.match(csv, /^# label: .*\(edited\)\n# sex: M\nkey,value,unit,status,reliability,n,note\n/);
  const back = A.parseImport(csv, "x.csv");
  assert.equal(back.sex, "M");
  assert.equal(back.measures.mass.status, "edited"); assert.equal(back.measures.mass.value, 80);
  assert.equal(back.measures.stature.value, edited.measures.stature.value);
  assert.deepEqual(Object.keys(back.measures), Object.keys(edited.measures));
  const nasty = { ...med, measures: { stature: { value: 1700, unit: "mm", status: "reported", note: '=HYPERLINK("http://x")' } } };
  const row = A.profileToCSV(nasty).split("\n")[3];
  assert.ok(row.includes(`"'=HYPERLINK(""http://x"")"`), row);
});

test("parseImport rejects malformed and hostile input with a plain message", () => {
  const bad = (text, re, name = "") => assert.throws(() => A.parseImport(text, name), re, JSON.stringify(String(text).slice(0, 40)));
  bad("", /empty/); bad("   \n\t ", /empty/); bad("﻿", /empty/);
  bad("<!doctype html><html><body>404</body></html>", /HTML or XML/);
  bad("<?xml version='1.0'?><a/>", /HTML or XML/);
  bad("{", /not valid JSON/); bad('{"stature": 1750,}', /not valid JSON/);
  bad("null", /CSV not recognised/); bad("42", /CSV|No measures|header/); bad('"stature"', /CSV|header/);
  bad("[]", /No measures/); bad("{}", /No measures/);
  bad('{"mass": 70}', /no stature/);
  bad('{"stature": "abc"}', /stature: "abc" is not a number/);
  bad('{"stature": "NaN"}', /not a number/); bad("key,value\nstature,NaN\n", /not a number/); bad("key,value\nstature,Infinity\n", /not a number/);
  bad('{"stature": 1e999}', /not a finite number/);
  bad('{"stature": 1e308}', /outside 0.8 to 2.5 m/);
  bad('{"stature": 175}', /175 mm is outside 0.8 to 2.5 m.*unit/);
  bad('{"stature": 17500}', /outside 0.8 to 2.5 m/);
  bad('{"stature": -1750}', /outside/); bad('{"stature": 0}', /outside/);
  bad('{"stature": 1750, "mass": 7000}', /outside 10 to 400 kg/); bad('{"stature": 1750, "mass": 7}', /outside 10 to 400 kg/);
  bad('{"stature": "175 furlongs"}', /Unknown unit "furlongs"/);
  bad('{"stature": 1750, "mass": "70 cm"}', /mass is measured in kg but was given in cm/);
  bad('{"stature": "70 kg"}', /stature is measured in mm but was given in kg/);
  bad('{"stature": 1750, "hand_length": 99999}', /outside 0 to 5 m/);
  bad('{"stature": 1750, "hand_length": -3}', /outside/);
  bad('{"stature": 1750, "hand_length": [1, 2]}', /hand_length/);
  bad("a,b\n1,2\n3,4\n", /CSV not recognised/); bad("a,b\n1,2\n", /no stature/); bad("hello world", /CSV|header/);
  bad("data.json contents", /named .json|CSV/, "data.json");
  bad("key,value\n", /No measures/);
  bad("A".repeat(A.MAX_IMPORT_CHARS + 1), /too large/);
  bad("x".repeat(5 * 1024 * 1024), /too large/);
  bad("key,value\n" + "stature,1750\n".repeat(4000), /Too many/);
  bad(JSON.stringify(Object.fromEntries(Array.from({ length: 3200 }, (_, i) => ["other:m" + i, 100]))), /Too many/);
  assert.throws(() => A.parseImport(null), /read as text/); assert.throws(() => A.parseImport({}), /read as text/);
});

test("parseImport: prototype pollution and key sanitising", () => {
  const p = A.parseImport('{"__proto__": {"polluted": 1}, "stature": 1750, "constructor": 5, "prototype": 2, "a b/c": 1, "toString": 1, "__x": 3, "<img src=x>": 4, "": 5}');
  assert.deepEqual(Object.keys(p.measures), ["stature"]);
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.polluted, undefined);
  assert.match(p.notes.join(" "), /unusable names were ignored/);
  assert.equal(Object.getPrototypeOf(p.measures), Object.prototype);
  assert.throws(() => A.parseImport('{"__proto__": 5}'), /No measures/);
  const csv = A.parseImport("key,value\n__proto__,5\nconstructor,5\nstature,1750\n");
  assert.deepEqual(Object.keys(csv.measures), ["stature"]);
  const viaMeasures = A.parseImport('{"measures": {"__proto__": {"value": 5}, "stature": {"value": 1700}}}');
  assert.deepEqual(Object.keys(viaMeasures.measures), ["stature"]);
  assert.equal(A.sanitiseKey("  Sitting  Height "), "sitting_height");
  assert.equal(A.sanitiseKey("other:Wrist-Height"), "other:wrist_height");
  for (const k of ["__proto__", "a.b", "a/b", "", " ", "x".repeat(81), "other:", "other:other:x", 5, null, "ünïcode", "constructor", "other:constructor"]) assert.equal(A.sanitiseKey(k), null, String(k));
  // a label or filename with markup stays plain text and is bounded
  const q = A.parseImport('{"stature": 1750, "label": "<b>x</b>\\u0000\\n' + "y".repeat(500) + '"}', "../../etc/<x>.json");
  assert.ok(q.label.length <= 100 && !/[\u0000-\u001f]/.test(q.label));
  assert.ok(!q.source.filename.includes("/"));
});

test("parseImport of a 2.9 MB hostile file is rejected quickly", () => {
  const t0 = Date.now();
  assert.throws(() => A.parseImport("key,value\n" + "stature,1750\n".repeat(220000)), /Too many/);
  assert.throws(() => A.parseImport('{"a":' + "[".repeat(100000) + "1" + "]".repeat(100000) + ',"stature":1750}'), /value|JSON|stature|not a number/);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

// ---------------------------------------------------------------------------------------------------------------- (6) immutability, manual
function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }

test("editMeasure returns a new profile and never touches the old one", () => {
  const base = deepFreeze(structuredClone(med));
  const snapshot = structuredClone(base);
  const e1 = A.editMeasure(base, "stature", 1800);
  assert.deepEqual(base, snapshot);
  assert.notEqual(e1, base); assert.notEqual(e1.measures, base.measures); assert.notEqual(e1.notes, base.notes); assert.notEqual(e1.source, base.source);
  assert.equal(e1.measures.stature.value, 1800); assert.equal(e1.measures.stature.status, "edited"); assert.equal(e1.measures.stature.unit, "mm");
  assert.deepEqual(e1.measures.stature.was, { value: base.measures.stature.value, status: base.measures.stature.status });
  assert.equal(e1.measures.stature.reliability, base.measures.stature.reliability);
  assert.equal(e1.measures.mass, base.measures.mass, "untouched entries are shared, they are never mutated");
  assert.match(e1.id, /~edited:[0-9a-f]+$/); assert.ok(e1.label.endsWith(" (edited)") && e1.notes.length === base.notes.length + 1);
  const e2 = A.editMeasure(e1, "stature", 1850);
  assert.deepEqual(e2.measures.stature.was, e1.measures.stature.was, "the value before the first edit is kept");
  assert.deepEqual([e2.label, e2.notes.length], [e1.label, e1.notes.length], "the markers are added once");
  assert.equal(e2.id.replace(/~edited:[0-9a-f]+$/, ""), base.id, "one ~edited suffix on the original id"); assert.notEqual(e2.id, e1.id, "another value, another id");
  assert.equal(A.editMeasure(base, "stature", 1850).id, e2.id, "the same values give the same id");
  assert.equal(e1.measures.stature.value, 1800);
  // units: cm, m, in, lb convert; a mass edited without a unit stays in kg; wrong class and nonsense throw
  assert.equal(A.editMeasure(base, "stature", 182, "cm").measures.stature.value, 1820);
  assert.equal(A.editMeasure(base, "stature", 1.79, "m").measures.stature.value, 1790);
  assert.equal(A.editMeasure(base, "stature", 70, "in").measures.stature.value, 1778);
  const m1 = A.editMeasure(base, "mass", 90);
  assert.deepEqual([m1.measures.mass.value, m1.measures.mass.unit], [90, "kg"]);
  assert.equal(A.editMeasure(base, "mass", 200, "lb").measures.mass.value, 90.718);
  const added = A.editMeasure(base, "other:Made Up Height", 840);
  assert.equal(added.measures["other:made_up_height"].value, 840); assert.equal(added.measures["other:made_up_height"].was, undefined);
  assert.equal(A.editMeasure(base, "wrist height", 840).measures["other:wrist_height"].was.value, base.measures["other:wrist_height"].value, "bare skeleton names resolve to the other: key");
  for (const [k, v, u] of [["stature", 175], ["stature", NaN], ["stature", Infinity], ["stature", "1800"], ["mass", 5], ["__proto__", 1], ["x y/z", 1], ["stature", 1800, "kg"], ["mass", 70, "cm"], ["hand_length", -2], ["hand_length", 1800, "parsec"]]) {
    assert.throws(() => A.editMeasure(base, k, v, u), Error, `${k} ${v} ${u}`);
  }
  assert.deepEqual(base, snapshot, "failed edits change nothing either");
  // revert
  const back = A.revertMeasure(A.editMeasure(base, "stature", 1800), "stature");
  assert.deepEqual(back.measures.stature, base.measures.stature, "an exact undo: n, basis and note come back too");
  assert.deepEqual(back, { ...base, id: base.id, label: base.label }, "no edit left: id, label and notes are as before");
  assert.equal(A.revertMeasure(added, "other:made_up_height").measures["other:made_up_height"], undefined);
  assert.equal(A.revertMeasure(base, "stature"), base, "nothing to revert");
});

test("manualProfile: stature and mass only, converted and validated", () => {
  const p = A.manualProfile({ sex: "F", stature: 1650, mass: 58 });
  assert.deepEqual(Object.keys(p.measures), ["stature", "mass"]);
  assert.deepEqual(p.source, { kind: "manual" });
  assert.equal(p.sex, "F"); assert.match(p.label, /women/); assert.equal(p.measures.mass.unit, "kg");
  assert.equal(A.manualProfile({ sex: "male", stature: 1.8, statureUnit: "m", mass: 176, massUnit: "lb" }).measures.stature.value, 1800);
  assert.deepEqual(Object.keys(A.manualProfile({ sex: "M", stature: 1800 }).measures), ["stature"]);
  assert.equal(A.manualProfile({ stature: 1700 }).sex, "both");
  for (const bad of [{ sex: "F", stature: 165 }, { sex: "F", stature: 1650, mass: 5 }, { sex: "robot", stature: 1700 }, { sex: "M" }, { sex: "M", stature: "tall" }, undefined]) assert.throws(() => A.manualProfile(bad), Error);
  // the manual profile can be edited, exported and imported again
  const e = A.editMeasure(p, "hand_length", 180);
  assert.equal(A.parseImport(A.profileToCSV(e)).measures.hand_length.value, 180);
  assert.equal(A.parseImport(A.profileToJSON(p)).sex, "F");
});

// ---------------------------------------------------------------------------------------------------------------- (7) regressions found in review
const lowOnly = { population: { country: "X", country_id: "x", role: "Y", role_id: "y", sex: "both" }, measures: [
  { key: "stature", unit: "mm", reliability: "low", percentiles: { p5: 1600, p50: 1700, p95: 1800 } }, { key: "mass", unit: "kg", reliability: "low", percentiles: { p5: 55, p50: 70, p95: 90 } }] };

test("a long digit string followed by junk is rejected in linear time (it was quadratic: 60k digits took 16 s)", () => {
  const t0 = performance.now();
  for (const junk of [" 5", ",", ".x", "e", ",,"]) {
    assert.throws(() => A.parseImport(JSON.stringify({ stature: "1".repeat(200000) + junk })), /not a number/);
    assert.throws(() => A.parseImport("key,value\nstature," + "1".repeat(200000) + junk + "\n"), /not a number/);
  }
  assert.equal(A.parseImport(JSON.stringify({ stature: "1750.5 mm" })).measures.stature.value, 1750.5);
  assert.ok(performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)} ms`);
});

test("a key with a long run of spaces (or any key longer than a real one) is handled in linear time and ignored", () => {
  const t0 = performance.now();
  for (const key of ["a" + " ".repeat(300000) + "x", "a" + " ".repeat(300000), " ".repeat(300000) + "(", "stature" + "(".repeat(100000)]) {
    const p = A.parseImport(JSON.stringify({ stature: 1750, [key]: 5 }));
    assert.deepEqual(Object.keys(p.measures), ["stature"]);
    assert.ok(p.notes.some(n => /unusable names/.test(n)));
    A.parseImport("key,value\nstature,1750\n" + JSON.stringify(key) + ",5\n"); // a CSV key is trimmed first, so "a   " is the valid key "a": only the time matters here
  }
  assert.ok(performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)} ms`);
});

test("lookups in the plain-object tables ignore Object.prototype (constructor, __proto__, toString, ...)", () => {
  const words = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
  for (const w of words) { assert.equal(A.parseSex(w), null, w); assert.equal(A.canonicalUnit(w), null, w); }
  assert.equal(A.parseImport('{"stature":1750,"sex":"constructor"}').sex, "both");
  assert.equal(A.parseImport("key,value\nstature,1750\nsex,__proto__\n").sex, "both");
  assert.throws(() => A.manualProfile({ sex: "constructor", stature: 1750 }), /Unknown sex/);
  for (const w of words) assert.throws(() => A.percentileProfile(lowOnly, { minReliability: w }), RangeError, w);
  for (const w of words) assert.throws(() => A.toDataUnit("stature", 1750, w), /Unknown unit/, w);
  // a unit taken from a file: proportional scaling must not turn it into NaN through SCALE_EXPONENT.constructor
  const odd = structuredClone(lowOnly); odd.measures[1].unit = "constructor";
  const p = A.percentileProfile(odd, { minReliability: "low", scaling: "proportional", percentile: 90 });
  assert.ok(Number.isFinite(p.measures.mass.value));
});

test("an all-low-reliability populations file says why it is empty, and minReliability 'low' imports it", async () => {
  const txt = JSON.stringify(lowOnly);
  assert.throws(() => A.parseImport(txt), e => /^No measures were found/.test(e.message) && /medium reliability/.test(e.message) && /minReliability/.test(e.message));
  const p = A.parseImport(txt, "x.json", { minReliability: "low" });
  assert.deepEqual(Object.keys(p.measures), ["stature", "mass"]);
  // stature only at low, other measures fine: the stature message names the level
  const mixed = structuredClone(lowOnly); mixed.measures[1].reliability = "high";
  assert.throws(() => A.parseImport(JSON.stringify(mixed)), /no stature at medium reliability or better/);
  assert.throws(() => A.parseImport(txt, "", { minReliability: "bogus" }), RangeError);
  // the real file of the report
  const angola = fs.readFileSync(path.join(PUBLIC, API, "populations/angola/cadets/both.json"), "utf8"); // mass at low reliability, no stature at all
  assert.throws(() => A.parseImport(angola), /No measures were found at medium reliability or better/);
  assert.throws(() => A.parseImport(angola, "", { minReliability: "low" }), /no stature/);
  let real = null;
  for (const e of index.populations) {
    const f = await popFile(e.country_id, e.role_id, e.sex);
    if (f.measures.some(m => m.key === "stature" && m.reliability === "low" && m.percentiles && [m.percentiles.p5, m.percentiles.p50, m.percentiles.p95].every(Number.isFinite)) && !A.percentileProfile(f).measures.stature) { real = f; break; }
  }
  assert.ok(real, "no population whose stature is low reliability");
  assert.throws(() => A.parseImport(JSON.stringify(real)), /reliab/);
  assert.ok(A.parseImport(JSON.stringify(real), "", { minReliability: "low" }).measures.stature);
  // a file with nothing at all keeps the plain message
  assert.throws(() => A.parseImport("{}"), /No measures were found/);
});

test("percentileProfile does not hand out references into the (cached) population file; the index is copied too", async () => {
  const raw = await popFile("united-states", "army", "M", true), before = structuredClone(raw);
  const p = A.percentileProfile(raw);
  assert.deepEqual(p.source.survey, raw.population.survey); assert.notEqual(p.source.survey, raw.population.survey);
  assert.deepEqual(p.source.surveys_combined, raw.population.surveys_combined); assert.notEqual(p.source.surveys_combined, raw.population.surveys_combined);
  p.source.survey.name = "changed"; p.source.surveys_combined.push("x");
  assert.deepEqual(raw, before, "editing the profile's source changed the cached file");
  const withYears = await A.loadPopulation({ country_id: "multiple-latin-america-18-countries", role_id: "tri-service", sex: "both" }, { fetchJSON: fsFetch });
  const py = A.percentileProfile(withYears, { minReliability: "low" });
  assert.deepEqual(py.source.years, withYears.population.years); assert.notEqual(py.source.years, withYears.population.years);
  const idx = await A.loadIndex(API, fsFetch), e = idx.populations.find(x => x.has_latest);
  e.latest_survey.name = "changed";
  assert.notEqual((await A.loadIndex(API, fsFetch)).populations.find(x => x.has_latest).latest_survey.name, "changed");
});

test("populationUrl and loadIndex refuse ids that are not strings", async () => {
  for (const id of [null, undefined, 5, true, ["ok"], { toString: () => "ok" }]) {
    assert.throws(() => A.populationUrl({ country_id: id, role_id: "ok", sex: "M" }), TypeError, String(id));
    assert.throws(() => A.populationUrl({ country_id: "ok", role_id: id, sex: "M" }), TypeError, String(id));
  }
  const idx = await A.loadIndex("b", async () => ({ populations: [{ country_id: null, role_id: "r", sex: "M", country: "N", role: "R" }, { country_id: 5, role_id: "r", sex: "M" }, { country_id: "ok", role_id: "r", sex: "M", country: "Ok", role: "R" }] }));
  assert.deepEqual(idx.populations.map(p => p.country_id), ["ok"]);
});

test("listSubjects: limit 0 is the minimum, only a missing or non-numeric limit is the default; nearestSubject: sex 'both' is any sex", { skip: DB_SKIP }, async () => {
  assert.equal((await A.listSubjects(queryFn, { limit: 0 })).length, 1);
  assert.equal((await A.listSubjects(queryFn, { limit: -3 })).length, 1);
  for (const lim of [undefined, null, "", NaN, "abc"]) assert.equal((await A.listSubjects(queryFn, { limit: lim })).length, 5000, String(lim)); // the default is the cap
  assert.equal((await A.listSubjects(queryFn, { limit: 3 })).length, 3);
  const any = await A.nearestSubject(queryFn, { stature: 1750, sex: "both" }), none = await A.nearestSubject(queryFn, { stature: 1750 });
  assert.equal(any.subject_key, none.subject_key);
  assert.equal((await A.nearestSubject(queryFn, { stature: 1750, sex: "male" })).sex, "M");
  assert.equal((await A.listSubjects(queryFn, { sex: "both", limit: 5 })).length, 5);
  assert.equal(await A.nearestSubject(queryFn, { stature: 1750, sex: "robot" }), null);
  const both = index.populations.find(p => p.sex === "both" && p.measures > 8);
  const prof = A.percentileProfile(await A.loadPopulation(both, { fetchJSON: fsFetch }), { minReliability: "low" });
  assert.ok(await A.nearestSubject(queryFn, { stature: prof.measures.stature.value, sex: prof.sex }), "a profile's own sex finds somebody");
});

test("revertMeasure is an exact undo: n, basis and note come back, and with no edit left the markers go", async () => {
  const pop = await popFile("united-states", "army", "M");
  for (const percentile of [73, 3, 50]) {
    const prof = A.percentileProfile(pop, { percentile });
    const e = A.editMeasure(A.editMeasure(prof, "stature", 1800), "mass", 90);
    const one = A.revertMeasure(e, "stature");
    assert.deepEqual(one.measures.stature, prof.measures.stature, `P${percentile}`);
    assert.ok(/~edited:[0-9a-f]+$/.test(one.id) && one.id !== e.id && one.label.endsWith("(edited)") && one.notes.length === prof.notes.length + 1, "one edit is left");
    const all = A.revertMeasure(one, "mass");
    assert.deepEqual(all, prof, "everything is as before the first edit");
  }
  // an entry with an optional field of every kind
  const rich = { ...A.manualProfile({ stature: 1700 }), measures: { stature: { value: 1700, unit: "mm", status: "estimated", reliability: "low", n: 12, basis: "interpolated", note: "a note" } } };
  assert.deepEqual(A.revertMeasure(A.editMeasure(rich, "stature", 1650), "stature"), rich);
  // the undo information survives profileToJSON / parseImport (it is validated on the way in)
  const viaJson = A.parseImport(A.profileToJSON(A.editMeasure(rich, "stature", 1650)));
  assert.deepEqual(A.revertMeasure(viaJson, "stature").measures.stature, rich.measures.stature);
  const hostile = JSON.parse(A.profileToJSON(A.editMeasure(rich, "stature", 1650)));
  hostile.measures.stature.orig = { value: "x", unit: "parsec", status: "reported", n: -4, basis: "made up", note: 5 };
  assert.equal(A.parseImport(JSON.stringify(hostile)).measures.stature.orig, undefined);
  hostile.measures.stature.orig = { value: 1, unit: "mm", status: "reported", n: -4, basis: "made up", reliability: "extreme", extra: 1, note: "\u0000ok" };
  assert.deepEqual(A.parseImport(JSON.stringify(hostile)).measures.stature.orig, { value: 1, unit: "mm", status: "reported", note: "ok" });
  // a file from before `orig` existed still reverts to value and status
  delete hostile.measures.stature.orig;
  assert.equal(A.revertMeasure(A.parseImport(JSON.stringify(hostile)), "stature").measures.stature.value, 1700);
});

test("percentileProfile ids (and labels) tell the reliability level apart", async () => {
  const pop = await popFile("united-states", "army", "M");
  const ids = ["high", "medium", "low", "all"].map(l => A.percentileProfile(pop, { minReliability: l }).id);
  assert.equal(new Set(ids).size, 3, "'all' is the same as 'low'");
  assert.equal(ids[2], ids[3]);
  assert.match(A.percentileProfile(pop, { minReliability: "high" }).label, /high reliability only/);
  assert.match(A.percentileProfile(pop, { minReliability: "low" }).label, /all reliability levels/);
  assert.doesNotMatch(A.percentileProfile(pop).label, /reliab/);
  assert.notEqual(A.percentileProfile(pop, { scaling: "proportional" }).id, A.percentileProfile(pop).id);
});

test("parseImport tells the user when a name appears twice or two names collide", () => {
  const p = A.parseImport("key,value\nstature,1700\nstature,1800\nhand length (left),190\nhand length (right),195\nmass,70\n");
  assert.equal(p.measures.stature.value, 1800); assert.equal(p.measures.hand_length.value, 195);
  const n = p.notes.find(x => /more than once/.test(x));
  assert.ok(n && /2 value\(s\)/.test(n) && /stature/.test(n) && /hand_length/.test(n), p.notes.join(" | "));
  assert.ok(!A.parseImport("key,value\nstature,1700\nmass,70\n").notes.some(x => /more than once/.test(x)));
  assert.ok(A.parseImport('{"stature": 1700, "Stature": 1800}').notes.some(x => /more than once/.test(x)));
});

test("profileToCSV: text that looks like a formula is guarded, and every note comes back exactly", () => {
  const notes = ["- cmd|' /C calc'!A0", "=1+1", "+1", "@SUM(1)", "'- already quoted", "''=x", "'plain", "a, \"b\"\nc", "-", "\tx", "'", "ok - fine"];
  let p = A.manualProfile({ sex: "M", stature: 1750 });
  p = { ...p, measures: { stature: { ...p.measures.stature, note: notes[0] }, ...Object.fromEntries(notes.slice(1).map((nt, i) => [`other:k${i}`, { value: 5 + i, unit: "mm", status: "reported", note: nt }])) } };
  const csv = A.profileToCSV(p);
  const back = A.parseImport(csv);
  for (const [k, m] of Object.entries(p.measures)) assert.equal(back.measures[k].note?.replace(/\s+/g, " "), m.note.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || undefined, k);
  // what is written never starts a cell with a formula character
  const cells = csv.split("\n").slice(3).flatMap(l => l.split(","));
  for (const c of cells) assert.ok(!/^[=+@\t\r-]/.test(c), c);
});

test("converted units are rounded (0.01 mm, 0.001 kg); values already in mm and kg are kept as given", () => {
  assert.equal(A.parseImport('{"stature":1750,"mass":"165 lbs"}').measures.mass.value, 74.843);
  assert.equal(A.parseImport('{"stature":"69\\""}').measures.stature.value, 1752.6);
  assert.equal(A.parseImport('{"stature":"68.9 in"}').measures.stature.value, 1750.06);
  assert.equal(A.toDataUnit("stature", 1.7523456, "m").value, 1752.35);
  assert.equal(A.toDataUnit("stature", 1750.123456, "mm").value, 1750.123456);
  assert.equal(A.toDataUnit("mass", 75.123456, "kg").value, 75.123456);
  assert.equal(A.toDataUnit("mass", 75.123456).value, 75.123456);
  assert.equal(A.manualProfile({ stature: 5 + 64.9, statureUnit: "in", mass: 150, massUnit: "lb" }).measures.mass.value, 68.039);
});

test("roundValue rounds exact decimal ties to even like Python, everything else like toFixed", { skip: PY_SKIP }, () => {
  const vals = [0.125, 0.375, 0.625, 0.875, 0.25, 0.75, 1.25, 2.25, 2.5, 0.0625, 1.0625, 0.1875, 123456.25, 123456.75, 0.5, 1.5, 3, 1.005, 2.675, 0.285, 1.115, 1e-7, 1750.05, 1750.15];
  const all = [...vals, ...vals.map(v => -v)];
  const r = spawnSync("python3", ["-c", "import json,sys; print(json.dumps([[round(v,1),round(v,2),round(v,3)] for v in json.load(sys.stdin)]))"], { encoding: "utf8", input: JSON.stringify(all) });
  const want = JSON.parse(r.stdout);
  all.forEach((v, i) => [["mm", 1], ["kg", 2], ["ratio", 3]].forEach(([u], j) => assert.ok(Object.is(A.roundValue(v, u) + 0, want[i][j] + 0), `${u} ${v}: ${A.roundValue(v, u)} vs ${want[i][j]}`)));
  assert.equal(A.roundValue(0.125, "kg"), 0.12); assert.equal(A.roundValue(-0.125, "kg"), -0.12); assert.equal(A.roundValue(0.375, "kg"), 0.38);
  assert.equal(A.roundValue(NaN, "kg"), null); assert.equal(A.roundValue(null, "mm"), null);
});

// ---------------------------------------------------------------------------------------------------------------- review round 3 regressions
const csvJsonPairs = [];
for (const e of index.populations) for (const latest of e.has_latest ? [false, true] : [false]) {
  const base = path.join(PUBLIC, API, "populations", e.country_id, e.role_id, e.sex + (latest ? ".latest" : ""));
  if (fs.existsSync(base + ".csv")) csvJsonPairs.push(base);
}

test("a populations CSV imports exactly like its JSON twin: same keys, values, units, status, reliability, n (all files, all levels)", () => {
  assert.ok(csvJsonPairs.length >= 120, `${csvJsonPairs.length} files`);
  let estimated = 0, low = 0;
  for (const base of csvJsonPairs) for (const minReliability of ["high", "medium", "low"]) {
    const run = ext => { try { return A.parseImport(fs.readFileSync(base + ext, "utf8"), "", { minReliability }); } catch (e) { return e; } };
    const j = run(".json"), c = run(".csv");
    if (j instanceof Error || c instanceof Error) { assert.equal(c instanceof Error && c.message, j instanceof Error && j.message, `${base} ${minReliability}`); continue; } // refused for the same reason
    assert.deepEqual(Object.keys(c.measures).sort(), Object.keys(j.measures).sort(), `${base} ${minReliability}`);
    for (const [k, m] of Object.entries(j.measures)) {
      const x = c.measures[k];
      assert.equal(x.value, m.value, `${base} ${k}`); assert.equal(x.unit, m.unit); assert.equal(x.status, m.status, `${base} ${k} status`);
      assert.equal(x.reliability, m.reliability); assert.equal(x.n, m.n);
      if (m.status === "estimated") estimated++;
      if (m.reliability === "low") low++;
    }
    assert.equal(c.sex, j.sex);
    assert.equal(c.notes.some(n => /hidden because/.test(n)), j.notes.some(n => /hidden because/.test(n)), `${base} ${minReliability} hidden note`);
  }
  assert.ok(estimated > 1000 && low > 20, `${estimated} estimated, ${low} low`);
});

test("populations CSV: the repro of the review (knee height is estimated), the reliability filter and its note, and minReliability 'low'", () => {
  const army = path.join(PUBLIC, API, "populations", "united-states", "army", "M.csv");
  const p = A.parseImport(fs.readFileSync(army, "utf8"));
  assert.equal(p.measures["other:knee_height_midpatella"].status, "estimated");
  assert.equal(p.measures["other:knee_height_midpatella"].note, "percentiles estimated from the mean and SD");
  assert.equal(p.measures.stature.status, "reported");
  const csv = "key,unit,n,p5,p50,p95,estimated_percentiles,percentile_basis,reliability\nstature,mm,100,1600,1750,1900,,p5:reported p50:reported p95:reported,high\nhand_length,mm,10,170,185,200,p50,p5:reported p50:estimated p95:reported,low\nfoot_length,mm,50,240,265,290,,p5:reported p50:reported p95:reported,medium\n";
  const m = A.parseImport(csv);
  assert.deepEqual(Object.keys(m.measures).sort(), ["foot_length", "stature"]);
  assert.ok(m.notes.includes("1 value(s) hidden because their reliability is below 'medium'."), m.notes.join("|"));
  const low = A.parseImport(csv, "", { minReliability: "low" });
  assert.equal(low.measures.hand_length.status, "estimated"); assert.equal(low.measures.hand_length.reliability, "low");
  const high = A.parseImport(csv, "", { minReliability: "high" });
  assert.deepEqual(Object.keys(high.measures), ["stature"]);
  // estimated_percentiles alone (no basis column) is enough; a stature that is only low reliability gets the same advice as the JSON route
  assert.equal(A.parseImport("key,p50,estimated_percentiles\nstature,1750,\nhand_length,185,p50 p95\n").measures.hand_length.status, "estimated");
  assert.throws(() => A.parseImport("key,p50,reliability\nstature,1750,low\nhand_length,185,high\n"), /no stature at medium reliability or better/);
  assert.throws(() => A.parseImport("key,p50,reliability\nstature,1750,low\n"), /all 1 values in this populations file are less reliable/);
  assert.throws(() => A.parseImport(csv, "", { minReliability: "bogus" }), RangeError);
});

test("a stature with a mean but no percentiles: opt-in in percentileProfile, used by parseImport (JSON and CSV) at 'low' reliability", async () => {
  const file = await popFile("bulgaria", "cadets", "M");
  const st = file.measures.find(m => m.key === "stature");
  assert.equal(st.percentiles.p50, null); assert.ok(st.mean > 1500);
  const plain = A.percentileProfile(file, { minReliability: "low" });
  assert.equal(plain.measures.stature, undefined); // the default stays the service's answer
  const on = A.percentileProfile(file, { minReliability: "low", meanStature: true });
  assert.equal(on.measures.stature.value, st.mean); assert.equal(on.measures.stature.status, "estimated");
  assert.ok(on.notes.some(n => /only a mean stature/.test(n)));
  const j = A.parseImport(JSON.stringify(file), "", { minReliability: "low" });
  assert.equal(j.measures.stature.value, st.mean);
  const base = path.join(PUBLIC, API, "populations", "bulgaria", "cadets", "M");
  const c = A.parseImport(fs.readFileSync(base + ".csv", "utf8"), "", { minReliability: "low" });
  assert.equal(c.measures.stature.value, st.mean); assert.equal(c.measures.stature.status, "estimated");
  assert.ok(c.notes.some(n => /only a mean stature/.test(n)));
  assert.throws(() => A.parseImport(JSON.stringify(file)), /less reliable|no stature/); // at medium the row is hidden as before
  // with an SD the other percentiles are spread by it
  const withSd = { ...file, measures: file.measures.map(m => (m.key === "stature" ? { ...m, sd: 70 } : m)) };
  const p95 = A.percentileProfile(withSd, { minReliability: "low", meanStature: true, percentile: 95 }).measures.stature.value;
  assert.ok(Math.abs(p95 - (st.mean + 70 * A.normalQuantile(0.95))) < 0.1, String(p95));
});

test("a populations file with hostile notes / survey / years fields: no TypeError, no one-letter notes, nothing but plain data in the profile", () => {
  const pop = (extra, info = {}) => JSON.stringify({ population: { country: "X", country_id: "x", role: "R", role_id: "r", sex: "M", ...info }, measures: [{ key: "stature", unit: "mm", reliability: "high", percentiles: { p5: 1600, p50: 1750, p95: 1900 } }], ...extra });
  for (const notes of [{ a: 1 }, "hello", 5, null, true, [1, { a: 1 }]]) {
    const p = A.parseImport(pop({ notes }));
    assert.equal(p.measures.stature.value, 1750);
    assert.ok(!p.notes.some(n => n.length === 1), JSON.stringify(notes));
  }
  assert.ok(A.parseImport(pop({ notes: ["keep me"] })).notes.includes("keep me"));
  const f = JSON.parse(pop({ notes: "hello" }, { surveys_combined: "abc", years: { a: 1 }, survey: "s", country: { a: 1 }, role_id: ["r"] }));
  const prof = A.percentileProfile(f);
  assert.deepEqual(prof.source.surveys_combined, []); assert.ok(!("years" in prof.source)); assert.equal(prof.source.survey, null);
  assert.ok(!prof.label.includes("[object") && !prof.id.includes("[object") && typeof prof.source.country === "string");
  assert.ok(!prof.notes.some(n => n.length === 1));
});

test("parseImport reads a file the same before and after loadMeasures (the catalog extends the built-in tables)", async () => {
  const list = JSON.parse(fs.readFileSync(path.join(PUBLIC, API, "measures.json"), "utf8"));
  // every measure of the catalog that is not a plain `other:` length has its unit built in
  A.setMeasureCatalog([]);
  for (const m of list) if (m.unit !== "mm") assert.equal(A.unitOf(m.key), m.unit, m.key);
  const txt = JSON.stringify({ stature_cm: 175, ear_length_cm: 6.2, "other:visceral_fat_level": 12, "other:body_fat_percent": 18, "other:handgrip_strength_left": 400, "other:seat_angle": 17, "other:skeletal_muscle_percent": 40, "other:visceral_adipose_tissue_area": 90, weight_kg: 70 });
  const before = A.parseImport(txt);
  A.setMeasureCatalog(list);
  try {
    const after = A.parseImport(txt);
    assert.deepEqual(before.measures, after.measures);
    assert.equal(before.measures.ear_length.value, 62); assert.equal(before.measures["other:visceral_fat_level"].unit, "au");
    assert.equal(before.measures["other:body_fat_percent"].unit, "%"); assert.equal(before.measures["other:handgrip_strength_left"].unit, "N");
    assert.equal(before.measures["other:seat_angle"].unit, "degrees"); assert.equal(before.measures.mass.value, 70);
    for (const k of list.filter(m => m.harmonized).map(m => m.key)) { // every bare key resolves to itself, with or without the catalog, and counts as known
      A.setMeasureCatalog([]);
      const a = A.parseImport(JSON.stringify({ stature: 1750, [k + (A.unitOf(k) === "mm" ? "_mm" : "")]: k === "stature" ? 1750 : A.unitOf(k) === "mm" ? 1000 : A.unitOf(k) === "years" ? 30 : A.unitOf(k) === "kg" ? 70 : 25 }));
      assert.ok(k in a.measures, k);
      assert.ok(!a.notes.some(n => /not in the measure list/.test(n)), k);
    }
  } finally { A.setMeasureCatalog([]); }
});

test("parseImport tells the user about names it does not know (bare names only: `other:` keys depend on the catalog)", () => {
  const p = A.parseImport('{"stature":1750,"torso":500,"leg_thing_cm":90,"other:something_else":12}');
  const note = p.notes.find(n => /not in the measure list/.test(n));
  assert.ok(note && /torso/.test(note) && /leg_thing_cm/.test(note) && !/something_else/.test(note), String(note));
  assert.ok(!A.parseImport('{"stature":1750,"hand_length":190}').notes.some(n => /not in the measure list/.test(n)));
});

test("lengths too small to be mm: left out of an import with a note, refused when set directly; stature keeps its own error", () => {
  const p = A.parseImport(JSON.stringify({ stature: "175 cm", hand_length: 19.2, waist_circumference: 0.85, "foot length (ft)": 0.9, sitting_height: 910, "other:triceps_skinfold": 12 }));
  assert.deepEqual(Object.keys(p.measures).sort(), ["other:triceps_skinfold", "sitting_height", "stature"]);
  const note = p.notes.find(n => /too small to be millimetres/.test(n));
  assert.ok(/hand_length 19.2/.test(note) && /waist_circumference 0.85/.test(note) && /foot_length 0.9/.test(note), String(note));
  assert.equal(A.parseImport('{"stature":1750,"hand_length":"19.2 cm"}').measures.hand_length.value, 192); // with the unit it is fine
  assert.equal(A.parseImport('{"stature":1750,"hand_length":"57 mm"}').measures.hand_length.value, 57);
  assert.throws(() => A.toDataUnit("hand_length", 19.2), /too small/);
  assert.throws(() => A.editMeasure(A.manualProfile({ stature: 1750 }), "hand_length", 19.2), /too small/);
  assert.equal(A.editMeasure(A.manualProfile({ stature: 1750 }), "hand_length", 19.2, "cm").measures.hand_length.value, 192);
  assert.throws(() => A.parseImport('{"stature":17.5}'), /outside 0.8 to 2.5 m/);
  // no real value is rejected: every measure of every populations file, and every person, is above its floor
  let seen = 0;
  for (const base of csvJsonPairs) {
    let q; try { q = A.parseImport(fs.readFileSync(base + ".json", "utf8"), "", { minReliability: "low" }); } catch { continue; } // a file with no usable stature
    assert.ok(!q.notes.some(n => /too small to be millimetres/.test(n)), base); seen++;
  }
  assert.ok(seen > 100);
});

test("listSubjects pages with offset and reaches the tallest person; countSubjects gives the total", { skip: DB_SKIP }, async () => {
  const f = { dataset: "ansur_ii_2012", sex: "M" };
  const total = await A.countSubjects(queryFn, f);
  assert.equal(total, 4082);
  const all = await A.listSubjects(queryFn, f);
  assert.equal(all.length, 4082);
  assert.equal(all.at(-1).stature, db.prepare("SELECT MAX(stature) AS m FROM subjects WHERE dataset = 'ansur_ii_2012' AND sex = 'M'").get().m);
  const a = await A.listSubjects(queryFn, { ...f, limit: 1000 }), b = await A.listSubjects(queryFn, { ...f, limit: 1000, offset: 1000 });
  assert.deepEqual(b[0], all[1000]); assert.deepEqual(b.at(-1), all[1999]); assert.notDeepEqual(a[0], b[0]);
  assert.equal((await A.listSubjects(queryFn, { ...f, limit: 1000, offset: 4000 })).length, 82);
  assert.equal((await A.listSubjects(queryFn, { ...f, offset: 99999 })).length, 0);
  for (const off of [-5, NaN, "abc", null, ""]) assert.deepEqual(await A.listSubjects(queryFn, { ...f, limit: 3, offset: off }), all.slice(0, 3), String(off));
  assert.equal(await A.countSubjects(queryFn), 13792);
  assert.equal(await A.countSubjects(queryFn, { sex: "both" }), 13792);
  assert.equal(await A.countSubjects(queryFn, { dataset: "nope" }), 0);
});

test("parseImport: null options, non-string label / filename, junk n and prototype-named mannequin units", () => {
  assert.doesNotThrow(() => A.parseImport('{"stature":1750}', "", null));
  assert.equal(A.parseImport('{"stature":1750}', null).source.filename, null);
  assert.equal(A.parseImport('{"stature":1750}', "", { minReliability: null }).measures.stature.value, 1750);
  for (const label of [{ a: 1 }, [1], true, null]) assert.equal(A.parseImport(JSON.stringify({ stature: 1750, label })).label, "Imported profile", JSON.stringify(label));
  assert.equal(A.parseImport('{"stature":1750,"label":"Mine"}').label, "Mine");
  const mk = n => A.parseImport(JSON.stringify({ format: "digital-human-profile", measures: { stature: { value: 1750, unit: "mm", status: "reported", n } } })).measures.stature;
  for (const n of [true, [5], 1e300, -1, 2.5, "x", {}]) assert.equal(mk(n).n, undefined, JSON.stringify(n));
  assert.equal(mk(25).n, 25);
  const pop = A.percentileProfile({ population: { country: "X", country_id: "x", role: "R", role_id: "r", sex: "M" }, measures: [{ key: "stature", unit: "mm", n: [5], reliability: "high", percentiles: { p5: 1600, p50: 1750, p95: 1900 } }] });
  assert.equal(pop.measures.stature.n, undefined);
  assert.doesNotThrow(() => A.percentileProfile({ population: { sex: "M" }, measures: [] }, null));
  const man = A.parseImport(JSON.stringify({ values: { stature: 1750, hand_length: 190 }, units: { isPrototypeOf: "mm", stature: "mm" } }));
  assert.equal(man.measures.stature.value, 1750);
  assert.doesNotThrow(() => A.parseImport(JSON.stringify({ values: { stature: 1750, isPrototypeOf: 5 }, units: "mm", dimensions: { constructor: 1 } })));
});

test("CSV: the key column is chosen by header priority, and a measure called sex or label survives the round trip", () => {
  const p = A.parseImport("name,key,value\nTorso,stature,1750\nHand,hand_length,190\n");
  assert.equal(p.measures.stature.value, 1750); assert.equal(p.measures.hand_length.value, 190); assert.ok(!("torso" in p.measures));
  assert.equal(A.parseImport("name,value\nstature,1750\n").measures.stature.value, 1750); // `name` alone still works
  assert.equal(A.parseImport("measure,key,value\nx,stature,1750\n").measures.stature.value, 1750);
  const prof = { id: "t", label: "t", sex: "M", source: { kind: "manual" }, notes: [], measures: { stature: { value: 1750, unit: "mm", status: "reported" }, label: { value: 12, unit: "mm", status: "reported" }, sex: { value: 7, unit: "mm", status: "reported" } } };
  const back = A.parseImport(A.profileToCSV(prof));
  assert.equal(back.measures.label.value, 12); assert.equal(back.measures.sex.value, 7); assert.equal(back.sex, "M"); assert.equal(back.label, "t");
  assert.equal(A.parseImport("key,value\nstature,1750\nsex,F\nlabel,Anna\n").sex, "F"); // text values are still metadata
  assert.equal(A.parseImport("key,value\nstature,1750\nlabel,Anna\n").label, "Anna");
});

test("proportional scaling: a documented rule for every mm measure (skinfolds included, not fitter inputs); percentileProfile accepts null options", () => {
  const file = { population: { country: "X", country_id: "x", role: "R", role_id: "r", sex: "M" }, measures: [
    { key: "stature", unit: "mm", reliability: "high", percentiles: { p5: 1600, p50: 1750, p95: 1900 } },
    { key: "other:triceps_skinfold", unit: "mm", reliability: "high", percentiles: { p5: 6, p50: 10, p95: 20 } }] };
  const p = A.percentileProfile(file, { scaling: "proportional", percentile: 95 });
  assert.equal(p.measures["other:triceps_skinfold"].basis, "scaled");
  assert.ok(!A.SKELETON_MEASURES.some(k => /skinfold/.test(k)));
  assert.equal(A.percentileProfile(file, null).measures.stature.value, 1750);
});

// ---------------------------------------------------------------------------------------------------------------- review round 4 regressions
const dvEntry = (key, unit, pcts, mean, extra = {}) => ({ key, name: key, category: "x", harmonized: true, unit, n: 100, mean, sd: mean / 20, percentiles: pcts,
  percentile_basis: Object.fromEntries(Object.keys(pcts).map(k => [k, "pooled"])), reliability: "high", ...extra });
const dvPop = { country: "X", country_id: "x", role: "R", role_id: "r", sex: "M", sex_name: "men", survey: null, surveys_combined: [], years: null };

test("a /v1/design-values answer for one percentile is read at that percentile (stature is not the mean, no measure is dropped)", () => {
  const resp = { population: dvPop, percentiles: ["p50"], min_reliability: "medium", notes: ["Population statistics for design studies are boundary cases.", "service note"],
    measures: [dvEntry("stature", "mm", { p50: 1749.3 }, 1750.3), dvEntry("mass", "kg", { p50: 76.34 }, 77.41), dvEntry("sitting_height", "mm", { p50: 910 }, 912)] };
  const p = A.parseImport(JSON.stringify(resp));
  assert.deepEqual([p.measures.stature.value, p.measures.mass.value, p.measures.sitting_height.value], [1749.3, 76.34, 910]);
  assert.equal(p.measures.stature.status, "reported"); assert.equal(p.source.format, "design-values-json"); assert.match(p.label, /P50$/);
  assert.ok(!p.notes.some(n => /no percentiles|mean/.test(n)), p.notes.join("|"));
  assert.ok(p.notes.includes("service note") && !p.notes.some(n => /^Population statistics for design studies/.test(n)));
  // percentiles=10,90: the first is used, the label and the note say which, opts.percentile picks the other
  const two = { ...resp, percentiles: ["p10", "p90"], measures: [dvEntry("stature", "mm", { p10: 1680, p90: 1820 }, 1750), dvEntry("mass", "kg", { p10: 66, p90: 90 }, 77)] };
  const a = A.parseImport(JSON.stringify(two)), b = A.parseImport(JSON.stringify(two), "", { percentile: 90 });
  assert.equal(a.measures.stature.value, 1680); assert.match(a.label, /P10$/); assert.ok(a.notes.some(n => /percentile 10 of that dimension/.test(n)) && a.notes.some(n => /P10 was used/.test(n)));
  assert.equal(b.measures.stature.value, 1820); assert.match(b.label, /P90$/);
  assert.throws(() => A.parseImport(JSON.stringify(two), "", { percentile: 75 }), /no percentile 75/);
  // the answer's own reliability level is kept (a low-reliability measure the user asked the service for is not dropped); an explicit level wins
  const lo = { ...resp, min_reliability: "low", measures: [...resp.measures, dvEntry("hand_length", "mm", { p50: 190 }, 190, { reliability: "low" })] };
  assert.equal(A.parseImport(JSON.stringify(lo)).measures.hand_length.value, 190);
  assert.ok(!A.parseImport(JSON.stringify(lo), "", { minReliability: "medium" }).measures.hand_length);
  // a stature with a mean only still gets a height; a measure without the percentile is left out and counted
  const mean = { ...resp, measures: [dvEntry("stature", "mm", { p50: null }, 1750), dvEntry("mass", "kg", { p50: null }, 77), dvEntry("hand_length", "mm", { p50: 190 }, 190)] };
  const m = A.parseImport(JSON.stringify(mean));
  assert.equal(m.measures.stature.value, 1750); assert.equal(m.measures.stature.status, "estimated"); assert.ok(!m.measures.mass);
  assert.ok(m.notes.some(n => /1 measure\(s\) have no value at P50/.test(n)));
});

test("a real design_values() answer for percentiles=50 (and 10,90) imports like percentileProfile at that percentile", { skip: PY_SKIP }, () => {
  const run = pcts => {
    const r = spawnSync("python3", ["-c", `import json,sys,os
sys.path.insert(0, os.getcwd())
from anthro_service import core
print(json.dumps(core.Repo().design_values('United States','Army','M',percentiles=${JSON.stringify(pcts)},measures=['stature','mass','sitting_height','hand_length'])))`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const ref = A.percentileProfile(readJSON("api/v1/populations/united-states/army/M.json"), { percentile: 50 });
  const p = A.parseImport(run([50]));
  for (const k of ["stature", "mass", "sitting_height", "hand_length"]) assert.equal(p.measures[k]?.value, ref.measures[k].value, k);
  const q = A.parseImport(run([10, 90]));
  assert.match(q.label, /P10$/); assert.ok(q.measures.stature.value < ref.measures.stature.value);
});

test("{\"measures\": [{key, value, unit}, ...]} is read like the bare list, with sex and label beside it", () => {
  const p = A.parseImport('{"sex":"F","label":"Anna","measures":[{"key":"stature","value":165,"unit":"cm"},{"key":"mass","value":60}]}');
  assert.deepEqual([p.measures.stature.value, p.measures.mass.value, p.sex, p.label], [1650, 60, "F", "Anna"]);
  assert.equal(A.parseImport('[{"key":"stature","value":1650}]').measures.stature.value, 1650);
  assert.throws(() => A.parseImport('{"measures":[]}'), /No measures/);
});

test("CSV: a value header with its unit ('Value (mm)', 'Value [cm]') is recognised and its unit is the default of the rows it fits", () => {
  const mm = A.parseImport("Measure,Value (mm)\nstature,1750\nmass,75\nhand_length,190");
  assert.deepEqual([mm.measures.stature.value, mm.measures.mass.value, mm.measures.mass.unit, mm.measures.hand_length.value], [1750, 75, "kg", 190]);
  const cm = A.parseImport("key;Value [cm]\nstature;175,5\nmass;75");
  assert.equal(cm.measures.stature.value, 1755); assert.equal(cm.measures.mass.value, 75);
  const both = A.parseImport("key,Value (cm),unit\nstature,1750,mm\nhand_length,19.5,\n");
  assert.deepEqual([both.measures.stature.value, both.measures.hand_length.value], [1750, 195], "the unit column wins over the header, an empty one falls back to it");
  assert.equal(A.parseImport("key,value (kg)\nstature,1750 mm\nmass,75 lb").measures.mass.value, 34.019, "a unit in the cell wins");
  assert.equal(A.parseImport("key,Value (furlong)\nstature,1750").measures.stature.value, 1750, "an unknown bracket is only dropped from the name");
});

test("proportional scaling of a population whose stature median is not positive (or whose line overflows) fails cleanly, no NaN or null", () => {
  const pop = (st, extra = []) => ({ population: { country: "X", country_id: "x", role: "r", role_id: "r", sex: "M" }, measures: [
    { key: "stature", unit: "mm", reliability: "high", percentiles: st }, { key: "hand_length", unit: "mm", reliability: "high", percentiles: { p5: 170, p50: 190, p95: 210 } }, ...extra] });
  for (const st of [{ p5: 0, p50: 0, p95: 0 }, { p5: -5, p50: -1, p95: 3 }]) assert.throws(() => A.percentileProfile(pop(st), { scaling: "proportional", percentile: 90 }), RangeError);
  assert.throws(() => A.percentileProfile(pop({ p5: -1.7e308, p50: 1, p95: 1.7e308 }), { scaling: "proportional", percentile: 99 }), RangeError);
  // percentile scaling: a measure whose interpolation overflows is left out and counted, the others stay finite
  const big = A.percentileProfile(pop({ p5: 1600, p50: 1750, p95: 1900 }, [{ key: "span", unit: "mm", reliability: "high", percentiles: { p5: -1.7e308, p50: 1, p95: 1.7e308 } }]), { percentile: 99 });
  assert.ok(!big.measures.span && Object.values(big.measures).every(m => Number.isFinite(m.value)));
  assert.ok(big.notes.some(n => /1 measure\(s\) left out because .* not a finite number/.test(n)) && !big.notes.some(n => /NaN|null/.test(n)));
});

test("profile ids say what the body is made of: manual, imported and edited profiles with other values get other ids", () => {
  const ids = [A.manualProfile({ stature: 1600 }), A.manualProfile({ stature: 1900 }), A.manualProfile({ stature: 1900, mass: 80 }), A.manualProfile({ sex: "F", stature: 1900 })].map(p => p.id);
  assert.equal(new Set(ids).size, 4, ids.join(" "));
  assert.equal(A.manualProfile({ stature: 1.9, statureUnit: "m" }).id, A.manualProfile({ stature: 1900 }).id, "same values, same id");
  const i1 = A.parseImport('{"stature":1600}', "a.json"), i2 = A.parseImport('{"stature":1900}', "a.json");
  assert.notEqual(i1.id, i2.id); assert.match(i1.id, /^import:a\.json:[0-9a-f]+$/);
  assert.equal(A.parseImport('{"stature":1600}', "a.json").id, i1.id); assert.notEqual(A.parseImport('{"stature":1600, "sex":"F"}', "a.json").id, i1.id);
  const base = A.manualProfile({ stature: 1750 });
  const e18 = A.editMeasure(base, "stature", 1800), e19 = A.editMeasure(base, "stature", 1900), e19b = A.editMeasure(e18, "stature", 1900);
  assert.notEqual(e18.id, e19.id); assert.equal(e19.id, e19b.id, "the id follows the values, not the history");
  assert.notEqual(A.editMeasure(e18, "mass", 80).id, e18.id);
  // revert: the remaining edits' id, then the original id
  const two = A.editMeasure(e18, "mass", 80), one = A.revertMeasure(two, "mass");
  assert.equal(one.id, e18.id); assert.equal(A.revertMeasure(one, "stature").id, base.id);
  // an edited id written by an older version ("<id>~edited") is not doubled
  assert.match(A.editMeasure({ ...base, id: "manual~edited" }, "stature", 1800).id, /^manual~edited:[0-9a-f]+$/);
});

test("a mannequin file's percentile is printed only when it is a number in the service's range", () => {
  const note = pct => A.parseImport(JSON.stringify({ percentile: pct, values: { stature: 1750 }, units: { stature: "mm" } })).notes.find(n => /^Taken from/.test(n));
  assert.match(note(95), /percentile 95 set/); assert.match(note("90"), /percentile 90 set/);
  for (const bad of [{ a: 1 }, "abc", [5], 0, 150, null, true]) assert.match(note(bad), /percentile 50 set/, JSON.stringify(bad));
});

test("clearCache(fetchJSON) forgets a custom fetcher's files; labelOf with a plain-object catalog indexes it once", async () => {
  let calls = 0;
  const f = async () => { calls++; return { populations: [] }; };
  await A.loadIndex("x/v1", f); await A.loadIndex("x/v1", f); assert.equal(calls, 1);
  A.clearCache(f); await A.loadIndex("x/v1", f); assert.equal(calls, 2);
  const cat = { stature: { name: "Stature (standing)" } };
  assert.equal(A.labelOf("stature", cat), "Stature (standing)"); assert.equal(A.labelOf("stature", cat), "Stature (standing)");
});
