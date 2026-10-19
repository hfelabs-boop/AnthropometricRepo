// ADVERSARIAL verification of the posture editor engine (site/js/human/editor.js) and the pure helpers of panels/posture.js, independent of editor.test.mjs.
// Oracles written here, not taken from the code under test: an expansion of the library postures from the documented rules of POSE.md section 3 (own water-filling over the
// spine, own eye convention), the ranges of motion read from the joint table, a model of the history (a list of snapshots and a pointer), the rig scene graph for landmarks.
// Run: node --import ./tests/human3d/register.mjs --test "tests/human3d/editor.adversarial.test.mjs"
// Tests named DEFECT carry `todo`: they assert the behaviour a user needs, currently fail, and say why in the todo text.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { buildRig } from "../../site/js/human/rig.js";
import * as IK from "../../site/js/human/ik.js";
import * as METRICS from "../../site/js/human/metrics.js";
import { JOINTS, JOINT_BY_ID, REGIONS } from "../../site/js/human/skeleton.js";
import { POSTURES, GRIPS } from "../../site/js/human/postures.js";
import { createEditor, sliderBounds, regionRange, parseCustomStore, STORAGE_KEY } from "../../site/js/human/editor.js";
import { stickFigure } from "../../site/js/human/panels/posture.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = [["woman P5", army("F", 5)], ["man P50", army("M", 50)], ["man P95", army("M", 95)]];
const MAN = BODIES[1][1];

function makeClock() {
  let t = 0, id = 0;
  const q = new Map();
  return { now: () => t, raf: (f) => { q.set(++id, f); return id; }, caf: (i) => { q.delete(i); }, get pending() { return q.size; }, flush(ms = 1000) { const end = t + ms; while (q.size && t < end) { t += 16; const run = [...q]; q.clear(); for (const [, f] of run) f(t); } } };
}
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };
function setup(body = MAN, { animated = false, storage = memStorage(), ctx = null, coalesceMs, sandbox } = {}) {
  const rig = buildRig(body, {}), clock = makeClock();
  const ed = createEditor({ getRig: () => rig, ik: IK, metrics: METRICS, storage, ctx, coalesceMs, sandbox, scheduler: animated ? { raf: clock.raf, caf: clock.caf, now: clock.now } : { raf: null, caf: null, now: clock.now } });
  return { rig, ed, clock, storage };
}
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const copyAngles = (rig) => JSON.parse(JSON.stringify(rig.angles));
const maxAngleDiff = (a, b) => { let m = 0, at = ""; for (const [k, v] of Object.entries(a)) v.forEach((x, i) => { const d = Math.abs(x - b[k][i]); if (d > m) { m = d; at = `${k}[${i}]`; } }); return { deg: m, at }; };
const FEET = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R", "ball_sole_lateral_L", "ball_sole_lateral_R"];

// ---- an independent expansion of the library ------------------------------------------------------------------------------------------------------------------------------------------
function spread(total, w, lo, hi) { // water-filling of a region total over its vertebrae
  const n = w.length, x = new Array(n).fill(0), fixed = new Array(n).fill(false);
  for (let it = 0; it < 60; it++) {
    let rem = total, ws = 0;
    for (let i = 0; i < n; i++) if (fixed[i]) rem -= x[i]; else ws += w[i];
    if (ws <= 0) break;
    let changed = false;
    for (let i = 0; i < n; i++) if (!fixed[i]) {
      const v = (rem * w[i]) / ws;
      if (v > hi[i] + 1e-12) { x[i] = hi[i]; fixed[i] = true; changed = true; } else if (v < lo[i] - 1e-12) { x[i] = lo[i]; fixed[i] = true; changed = true; } else x[i] = v;
    }
    if (!changed) break;
  }
  return x;
}
function expandIndependently(p) {
  const A = {}, get = (id) => (A[id] ??= new Array(JOINT_BY_ID[id].dof.length).fill(0)), set = (id, arr) => { const a = get(id); arr.forEach((v, i) => { a[i] = v; }); };
  for (const s of ["L", "R"]) { const g = p.grips?.[s]; if (g) for (const [b, v] of Object.entries(GRIPS[g].joints)) set(`${b}_${s}`, v); }
  const joints = p.joints ?? {}, isVert = (k) => Object.values(REGIONS).some((r) => r.joints.includes(k));
  for (const [rname, rg] of Object.entries(REGIONS)) {
    const tot = p.spine?.[rname] ?? [0, 0, 0], W = [rg.weights, rg.weightsLat, rg.weightsRot], rows = rg.joints.map(() => [0, 0, 0]);
    for (let c = 0; c < 3; c++) {
      const add = rg.joints.map((id) => joints[id]?.[c] ?? 0);
      const lo = rg.joints.map((id, i) => Math.min(0, JOINT_BY_ID[id].dof[c].min - add[i])), hi = rg.joints.map((id, i) => Math.max(0, JOINT_BY_ID[id].dof[c].max - add[i]));
      const sh = spread(tot[c] ?? 0, W[c], lo, hi);
      rows.forEach((r, i) => { r[c] = sh[i] + add[i]; });
    }
    rg.joints.forEach((id, i) => set(id, rows[i]));
  }
  const eye = (key, arr) => (key.endsWith("_LR") ? [[`${key.slice(0, -3)}_L`, arr], [`${key.slice(0, -3)}_R`, key.startsWith("eye") ? [arr[0] ?? 0, -(arr[1] ?? 0)] : arr]] : key === "eye_R" ? [[key, [arr[0] ?? 0, -(arr[1] ?? 0)]]] : [[key, arr]]);
  const rest = Object.entries(joints).filter(([k]) => !isVert(k));
  for (const pass of [(k) => k.endsWith("_LR"), (k) => !k.endsWith("_LR")]) for (const [k, v] of rest.filter(([k]) => pass(k))) for (const [id, a] of eye(k, v)) set(id, a);
  return A;
}

test("every library posture on three bodies: the rig holds exactly the independently expanded and clamped angles, nothing else, and the pelvis orientation of the posture", () => {
  for (const [bn, body] of BODIES) {
    const { rig, ed } = setup(body);
    let compared = 0;
    for (const p of POSTURES) {
      ed.apply(p.id, { animate: false });
      const want = expandIndependently(p);
      for (const [id, arr] of Object.entries(want)) arr.forEach((v, i) => {
        const d = JOINT_BY_ID[id].dof[i], c = Math.min(d.max, Math.max(d.min, v));
        compared++;
        assert.ok(Math.abs(rig.angles[id][i] - c) < 1e-6, `${bn} ${p.id} ${id}[${i}]: want ${c}, got ${rig.angles[id][i]}`);
      });
      for (const [id, arr] of Object.entries(rig.angles)) if (!want[id]) assert.ok(arr.every((v) => Math.abs(v) < 1e-9), `${bn} ${p.id}: ${id} should be neutral`);
      for (const k of ["flex", "lat", "rot"]) assert.ok(Math.abs(rig.root[k] - (p.root?.[k] ?? 0)) < 1e-9, `${bn} ${p.id} root.${k}`);
    }
    assert.ok(compared > 10000);
  }
});

test("ranges of motion: for every degree of freedom the slider bounds are the joint table's range and the rig stops at exactly that; not enforced, the margin bounds are reachable", () => {
  const { rig, ed } = setup();
  for (const j of JOINTS) {
    if (j.id === "pelvis") continue;
    j.dof.forEach((d, i) => {
      const b = sliderBounds(d, true);
      assert.deepEqual([b.min, b.max, b.lo, b.hi], [d.min, d.max, d.min, d.max]);
      for (const [asked, want] of [[d.max + 500, d.max], [d.min - 500, d.min]]) {
        ed.neutral();
        ed.setJoint(j.id, i, asked);
        assert.ok(Math.abs(rig.angles[j.id][i] - want) < 1e-6, `${j.id} ${d.key}: asked ${asked} want ${want} got ${rig.angles[j.id][i]}`);
      }
      const u = sliderBounds(d, false);
      assert.ok(u.min <= d.min && u.max >= d.max && u.max - u.min <= 720);
      ed.setOption("enforceRom", false);
      ed.neutral();
      ed.setJoint(j.id, i, u.min);
      assert.ok(Math.abs(rig.angles[j.id][i] - u.min) < 1e-6, `${j.id} ${d.key}: the lower margin ${u.min} is not reachable`);
      ed.setOption("enforceRom", true);
    });
  }
});

test("symmetric edits: every paired joint and degree of freedom mirrors in both directions; the eyes keep looking the same way (the right eye's joint angle is the negation)", () => {
  const { rig, ed } = setup();
  for (const j of JOINTS) {
    if (j.side !== "L") continue;
    const twin = j.id.replace(/_L$/, "_R");
    j.dof.forEach((d, i) => {
      const v = (d.min + d.max) / 2 + (d.max - d.min) * 0.3, flip = j.id === "eye_L" && d.key === "azim";
      ed.neutral(); ed.setJoint(j.id, i, v, { symmetric: true });
      assert.ok(Math.abs(rig.angles[twin][i] - (flip ? -v : v)) < 1e-9, `${j.id}[${i}] -> ${twin}`);
      ed.neutral(); ed.setJoint(twin, i, v, { symmetric: true });
      assert.ok(Math.abs(rig.angles[j.id][i] - (flip ? -v : v)) < 1e-9, `${twin}[${i}] -> ${j.id}`);
    });
  }
  // the gaze direction of both eyes in the world is the same (kinematics from the rig, not from the editor)
  ed.neutral(); ed.setJoint("eye_L", "azim", 20, { symmetric: true }); ed.setJoint("eye_L", "elev", 10, { symmetric: true });
  const dir = (id) => new THREE.Vector3(0, 0, 1).applyQuaternion(rig.jointQuaternion(id, new THREE.Quaternion()));
  assert.ok(dir("eye_L").distanceTo(dir("eye_R")) < 1e-6);
  assert.ok(dir("eye_L").x > 0.3, "toward the figure's left (+X)");
  // mirror and copy keep the conjugate gaze, mirror twice is the identity on every library posture
  ed.mirror();
  assert.ok(dir("eye_L").distanceTo(dir("eye_R")) < 1e-6 && dir("eye_L").x < -0.3);
  for (const p of POSTURES) {
    ed.apply(p.id, { animate: false });
    const A = copyAngles(rig), R = { ...rig.root };
    ed.mirror(); ed.mirror();
    assert.ok(maxAngleDiff(A, rig.angles).deg < 1e-6, `${p.id}: mirror twice`);
    assert.ok(Math.abs(rig.root.heading - R.heading) < 1e-6 && Math.abs(rig.root.flex - R.flex) < 1e-6);
  }
});

test("spine regions: every channel from minimum to maximum is reachable with no clamp report and no vertebra outside its range; all three channels at their maximum together are legal", () => {
  const { rig, ed } = setup();
  for (const r of Object.keys(REGIONS)) {
    const rg = regionRange(r);
    for (let c = 0; c < 3; c++) for (const v of [rg[c][0], rg[c][1], 0, rg[c][1] / 2]) {
      ed.neutral();
      const vals = [null, null, null]; vals[c] = v;
      const res = ed.setRegion(r, vals);
      assert.ok(Math.abs(ed.regionTotals(r)[c] - v) < 1e-6 && res.clamped.length === 0, `${r}[${c}] = ${v}`);
      assert.equal(ed.info().romViolations.length, 0, `${r}[${c}] = ${v}`);
    }
    ed.neutral(); ed.setRegion(r, rg.map((x) => x[1]));
    assert.equal(ed.info().romViolations.length, 0, `${r} all channels at the maximum`);
  }
  void rig;
});

// ---- history against a model --------------------------------------------------------------------------------------------------------------------------------------------------------------
test("history: 4 seeds x 600 random operations (edits, applies, mirror, seat, heading, regions, grips, nudges, undo and redo bursts) agree with a list-of-snapshots model, past the 200 step limit", () => {
  const J = JOINTS.filter((j) => j.id !== "pelvis");
  for (const seed of [1, 2, 3, 4]) {
    const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
    const { rig, ed } = setup(MAN, { coalesceMs: 0 });
    const state = () => { const p = rig.getPose(); return JSON.stringify({ root: p.root, angles: Object.fromEntries(Object.entries(p.angles).map(([k, v]) => [k, Array.from(v).map((x) => Math.round(x * 1e6) / 1e6)]).filter(([, v]) => v.some((x) => x !== 0))), place: ed.place, base: ed.base }, (k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)); };
    let model = [state()], idx = 0;
    const rec = () => { model.length = idx + 1; model.push(state()); idx++; if (model.length > 201) { model.shift(); idx--; } };
    for (let n = 0; n < 600; n++) {
      const x = r();
      if (x < 0.45) { const j = pick(J), i = Math.floor(r() * j.dof.length), d = j.dof[i]; ed.setJoint(j.id, i, d.min + r() * (d.max - d.min), { symmetric: r() < 0.3 }); rec(); }
      else if (x < 0.52) { ed.apply(pick(POSTURES).id, { animate: false }); rec(); }
      else if (x < 0.57) { ed.mirror(); rec(); }
      else if (x < 0.60) { ed.setSeatHeight(0.3 + r() * 0.4); rec(); }
      else if (x < 0.63) { ed.setHeading(r() * 360 - 180); rec(); }
      else if (x < 0.66) { ed.setRegion(pick(["lumbar", "thoracic", "cervical"]), [r() * 20 - 5, r() * 10 - 5, r() * 10 - 5]); rec(); }
      else if (x < 0.68) { ed.neutral(); rec(); }
      else if (x < 0.70) { ed.resetToLibrary(); rec(); }
      else if (x < 0.73) { ed.setGrip(pick(["L", "R"]), pick(["fist", "open", "relaxed", "power"])); rec(); }
      else if (x < 0.76) { ed.nudgeHandle(pick(["palm_L", "palm_R", "foot_L", "foot_R", "chest", "pelvis"]), [r() * 0.1 - 0.05, r() * 0.1 - 0.05, r() * 0.1 - 0.05]); rec(); }
      else if (x < 0.88) { for (let q = 0, k = 1 + Math.floor(r() * 5); q < k && idx > 0; q++) { ed.undo(); idx--; } }
      else { for (let q = 0, k = 1 + Math.floor(r() * 4); q < k && idx < model.length - 1; q++) { ed.redo(); idx++; } }
      assert.equal(ed.history.index, idx, `seed ${seed} op ${n}: history index`);
      assert.equal(state(), model[idx], `seed ${seed} op ${n}: the state differs from the model`);
    }
    assert.ok(ed.history.steps <= 200);
  }
});

// ---- placement while editing -----------------------------------------------------------------------------------------------------------------------------------------------------------
test("editing keeps the figure on its support: 3 bodies, standing / seated / lying, 60 random edits each: the carrier never leaves its surface by more than 4 mm and a standing figure's lowest point stays at the floor", () => {
  const J = JOINTS.filter((j) => j.id !== "pelvis"), r = rng(7);
  for (const [bn, body] of BODIES) {
    const { rig, ed } = setup(body, { coalesceMs: 0 });
    for (const id of ["iso-7250-standing", "iso-7250-sitting", "sit-upright-90", "lie-supine", "lie-prone"]) {
      ed.apply(id, { animate: false });
      for (let n = 0; n < 60; n++) {
        const j = J[Math.floor(r() * J.length)], i = Math.floor(r() * j.dof.length), d = j.dof[i];
        ed.setJoint(j.id, i, d.min + r() * (d.max - d.min));
        const info = ed.info(), prim = Object.keys(info.place.carriers)[0];
        assert.ok(Math.abs(info.gaps[prim]) < 0.004, `${bn} ${id} after ${j.id}[${i}]: ${prim} gap ${info.gaps[prim]}`);
        if (id === "iso-7250-standing") assert.ok(Math.abs(rig.lowestY()) < 0.012, `${bn} standing: lowest point ${rig.lowestY()}`);
      }
    }
  }
});

// ---- custom postures: storage abuse --------------------------------------------------------------------------------------------------------------------------------------------------------
test("custom store: corrupt JSON, wrong shapes, prototype pollution, 150 entries, duplicate ids, 400 kB of text, deep nesting: never throws, drops what is bad, says why", () => {
  const good = (id, name = "N") => ({ id, name, category: "Standing", tags: ["a"], description: "d", source: "s", support: "feet", joints: { elbow_LR: [30] } });
  assert.equal(parseCustomStore("{{{").postures.length, 0);
  assert.equal(parseCustomStore("null").postures.length, 0);
  assert.equal(parseCustomStore('["a", 1, null]').problems.length, 3);
  const polluted = parseCustomStore(`{"postures":[{"id":"custom-x","name":"x","support":"feet","joints":{"__proto__":[1],"constructor":[1]}}, ${JSON.stringify(good("custom-ok"))}]}`);
  assert.deepEqual(polluted.postures.map((p) => p.id), ["custom-ok"]);
  assert.equal(({}).polluted, undefined);
  assert.equal(parseCustomStore(JSON.stringify({ postures: [{ ...good("custom-p"), joints: { elbow_LR: [1e308] } }] })).postures.length, 0);
  const many = parseCustomStore(JSON.stringify({ postures: Array.from({ length: 150 }, (_, i) => good(`custom-p${i}`)) }));
  assert.equal(many.postures.length, 100);
  assert.equal(parseCustomStore(JSON.stringify({ postures: [good("custom-a"), good("custom-a")] })).postures.length, 1);
  assert.match(parseCustomStore("x".repeat(400000)).problems[0], /too large/);
  assert.equal(parseCustomStore("[".repeat(100000)).postures.length, 0);
});

test("custom postures: quota errors keep them in memory and say so; the 101st is refused; the same name five times gives five ids; odd names give valid ids", async () => {
  const quota = { getItem() { throw new Error("denied"); }, setItem() { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); } };
  const a = setup(MAN, { storage: quota });
  a.ed.apply("iso-7250-standing", { animate: false });
  const r1 = await a.ed.saveCustom("A");
  assert.ok(r1.ok && r1.persistent === false && /would not store/.test(r1.warning));
  assert.deepEqual((await Promise.all([a.ed.saveCustom("A")])).map((r) => r.id), ["custom-a-2"]);
  assert.equal(a.ed.deleteCustom("custom-a"), true);
  assert.deepEqual(a.ed.listCustom().map((p) => p.id), ["custom-a-2"]);
  const st = memStorage(), b = setup(MAN, { storage: st });
  for (let i = 0; i < 100; i++) { b.ed.setJoint("elbow_R", 0, i); assert.ok((await b.ed.saveCustom(`P ${i}`)).ok); }
  const over = await b.ed.saveCustom("one too many");
  assert.ok(!over.ok && /At most 100/.test(over.error));
  assert.ok(st.m.get(STORAGE_KEY).length < 200_000);
  const c = setup(MAN, { storage: memStorage() }), ids = [];
  for (let i = 0; i < 5; i++) ids.push((await c.ed.saveCustom("Same")).id);
  assert.equal(new Set(ids).size, 5);
  for (const nm of ["!!!", "日本語", "a".repeat(100), "../../x", "__proto__", "constructor", "custom-custom-x"]) { const r = await c.ed.saveCustom(nm); assert.ok(r.ok && /^custom-[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id) && r.id.length <= 60, nm); }
  assert.ok(!(await c.ed.saveCustom("   ")).ok);
});

test("import: garbage, deep nesting, 50 MB, prototype pollution, NaN and absurd angles, a File that cannot be read: a plain error each time and the figure is untouched", async () => {
  const { rig, ed } = setup();
  await ed.ready;
  const before = JSON.stringify(rig.getPose());
  for (const input of ["not json", "", "null", "42", "[1,2]", "[".repeat(50000) + "]".repeat(50000), "x".repeat(50_000_000),
    JSON.stringify({ app: "digital-human-posture", version: 1, pose: { root: {}, angles: JSON.parse('{"__proto__":[1,2,3]}') } }),
    JSON.stringify({ app: "digital-human-posture", version: 1, pose: { root: {}, angles: { elbow_R: [1e999] } } }),
    JSON.stringify({ app: "digital-human-posture", version: 1, pose: { root: {}, angles: { elbow_R: [90000] } } }), { text() { throw new Error("denied"); } }]) {
    const res = await ed.importPosture(input);
    assert.equal(res.ok, false, String(input).slice(0, 30));
    assert.ok(res.errors.length >= 1);
  }
  assert.equal(JSON.stringify(rig.getPose()), before);
  assert.equal(({}).x, undefined);
});

// ---- DEFECTS ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const lap = (ed, handle, R, laps, plane = "xy") => { // drag a handle round a circle and home, one solve per move (the follow solver of a drag)
  const start = ed.handlePoint(handle).clone(), d = ed.createDrag(handle, { immediate: true }), n = 90;
  d.begin(start);
  for (let k = 0; k < laps * n; k++) { const a = (2 * Math.PI * k) / n, o = plane === "xy" ? [R * (Math.cos(a) - 1), R * Math.sin(a), 0] : [R * (Math.cos(a) - 1), 0, R * Math.sin(a)]; d.move(start.clone().add(new THREE.Vector3(...o))); }
  for (let k = 0; k < 40; k++) d.move(start);
  return d.end();
};

test("DEFECT drift: a hand dragged forward / up and back to where it started leaves the arm twisted (forearm pronation and shoulder rotation 25 to 45 degrees away from where they were)", { todo: "end() polishes only an unreached goal and nothing pulls the null-space joints back toward the drag-start pose when the handle is home" }, () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const A0 = copyAngles(rig), start = ed.handlePoint("palm_R").clone();
  const d = ed.createDrag("palm_R", { immediate: true });
  d.begin(start);
  for (const o of [[0, 0, 0.25], [0, 0.2, 0.25]]) { const t = start.clone().add(new THREE.Vector3(...o)); for (let i = 1; i <= 30; i++) d.move(start.clone().lerp(t, i / 30)); }
  for (let k = 0; k < 30; k++) d.move(start);
  d.end();
  assert.ok(ed.handlePoint("palm_R").distanceTo(start) < 0.002, "the hand is home");
  const { deg, at } = maxAngleDiff(A0, rig.angles);
  assert.ok(deg < 8, `after going out and back the arm differs from the start by ${deg.toFixed(1)} degrees (${at})`);
});

test("DEFECT drift: the pelvis dragged down and home leaves the knees and hips rotated (knee rotation about 34 degrees, hip rotation 24) with the feet pinned", { todo: "same cause: no relaxation toward the reference pose once the goal is reached" }, () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const A0 = copyAngles(rig);
  lap(ed, "pelvis", 0.06, 1);
  const { deg, at } = maxAngleDiff(A0, rig.angles);
  assert.ok(deg < 8, `the legs differ from the start by ${deg.toFixed(1)} degrees (${at})`);
});

test("DEFECT pinned feet during a pelvis drag: with one solve per pointer event the feet slide and sink through the floor while the pelvis goes down 30 cm in 3 mm steps", { todo: "the root jumps to the target at once and the legs follow 2.3 degrees per solve: the pins are only met again at release" }, () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const f0 = FEET.map((id) => rig.landmarkWorld(id).clone()), start = ed.handlePoint("pelvis").clone(), d = ed.createDrag("pelvis", { immediate: true });
  d.begin(start);
  let slide = 0, sink = 0;
  for (let i = 1; i <= 100; i++) {
    d.move(start.clone().add(new THREE.Vector3(0, -0.003 * i, 0)));
    slide = Math.max(slide, ...FEET.map((id, k) => rig.landmarkWorld(id).distanceTo(f0[k])));
    sink = Math.min(sink, rig.lowestY());
  }
  d.end();
  assert.ok(slide < 0.015 && sink > -0.015, `feet slid ${(slide * 1000).toFixed(0)} mm and went ${(-sink * 1000).toFixed(0)} mm below the floor during the drag`);
});

test("DEFECT a drag that is still on its way when the pointer stops does not go on: the figure stays short of the pointer until the button is released", { todo: "solveNow() never re-arms itself while the result is `limited`; only move() and end() solve" }, () => {
  const clock = makeClock();
  const rig = buildRig(MAN, {});
  const ed = createEditor({ getRig: () => rig, ik: IK, metrics: METRICS, storage: memStorage(), scheduler: { raf: clock.raf, caf: clock.caf, now: clock.now } });
  ed.apply("iso-7250-standing", { animate: false });
  const start = ed.handlePoint("palm_R").clone(), target = start.clone().add(new THREE.Vector3(0.12, 0.2, 0.05)), d = ed.createDrag("palm_R");
  d.begin(start);
  for (let i = 1; i <= 3; i++) d.move(start.clone().lerp(target, i / 3)); // a quick flick: three pointer events
  clock.flush(3000); // the pointer rests, the button stays down: three seconds of frames
  assert.ok(ed.handlePoint("palm_R").distanceTo(target) < 0.01, `the hand is ${(ed.handlePoint("palm_R").distanceTo(target) * 100).toFixed(0)} cm from the pointer after 3 s`);
  d.cancel();
});

test("DEFECT after sitting on a chair and then standing up, the figure still follows the chair when it is moved", { todo: "syncChair() looks only at place.seat.kind === 'object', not at the mode or the support" }, () => {
  let scene = () => {};
  const surface = { objectId: "o1", id: "seat_pan", name: "Seat pan", y: 0.42, polygon: [[0.2, 0.6], [0.6, 0.6], [0.6, 1.0], [0.2, 1.0]] };
  const sandbox = { supportsWorld: () => [surface], objects: new Map([["o1", { yaw: 0 }]]) };
  const ctx = { on: (evt, fn) => { if (evt === "scene") scene = fn; return () => {}; }, state: { sandbox }, setPosture() {} };
  const { rig, ed } = setup(MAN, { ctx });
  ed.apply("iso-7250-sitting", { animate: false });
  assert.ok(ed.sitOn("o1", "seat_pan"));
  ed.apply("iso-7250-standing", { animate: false });
  const x0 = rig.root.x, z0 = rig.root.z;
  surface.polygon = surface.polygon.map(([x, z]) => [x - 1, z - 0.5]);
  scene();
  assert.ok(Math.hypot(rig.root.x - x0, rig.root.z - z0) < 1e-6, `the standing figure moved ${(Math.hypot(rig.root.x - x0, rig.root.z - z0) * 100).toFixed(0)} cm with the chair`);
});

test("DEFECT a new profile in the middle of the 350 ms glide leaves the figure half way to its posture and says '(edited)'", { todo: "rigReplaced() cancels the animation with finish: false but the base is already the target posture" }, () => {
  const posted = [];
  const rigA = buildRig(BODIES[1][1], {}), rigB = buildRig(BODIES[0][1], {}), clock = makeClock();
  let cur = rigA;
  const ed = createEditor({ getRig: () => cur, ik: IK, metrics: METRICS, storage: memStorage(), ctx: { on: () => () => {}, state: {}, setPosture: (p) => posted.push(p) }, scheduler: { raf: clock.raf, caf: clock.caf, now: clock.now } });
  ed.apply("iso-7250-sitting");
  clock.flush(100);
  rigB.setPose(rigA.getPose(), { clamp: false }); // what the shell does when it rebuilds the figure: the pose moves to the new rig
  cur = rigB;
  ed.info();
  clock.flush(2000);
  assert.equal(ed.modified, false, "nobody edited anything");
  assert.ok(Math.abs(rigB.angles.hip_L[0] - 90) < 1e-6, `the hip is at ${rigB.angles.hip_L[0].toFixed(0)} degrees, the posture says 90`);
});

test("DEFECT choosing a library posture after a seat height was set (or a chair taken) keeps that seat instead of the posture's own: 'Long sitting on the floor' floats 53 cm above the floor", { todo: "present() resets the mode but not place.seat when its kind is 'height' or 'object'; EDITOR.md says only keepPlacement: true keeps the seat" }, () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-sitting", { animate: false });
  ed.setSeatHeight(0.55);
  ed.apply("sit-floor-long", { animate: false });
  assert.ok(Math.abs(ed.seatHeight() - 0.07) < 1e-6, `the seat is ${ed.seatHeight().toFixed(2)} m, the posture asks for 0.07 m (the lowest point of the figure is ${(rig.lowestY() * 100).toFixed(0)} cm above the floor)`);
});

// ---- stick figures -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test("thumbnails: the stick figure of every library posture on three bodies has the joints where the rig has them (relative to the pelvis, side or front view, heading undone), within 5 mm", () => {
  let n = 0;
  for (const [bn, body] of BODIES) {
    const { rig, ed } = setup(body);
    for (const p of POSTURES) {
      ed.apply(p.id, { animate: false });
      const g = stickFigure(body, p), P = rig.jointWorld("pelvis").clone(), hd = (rig.root.heading * Math.PI) / 180, c = Math.cos(hd), s = Math.sin(hd);
      const uv = (id) => { const w = rig.jointWorld(id).clone().sub(P), v = [w.x * c - w.z * s, w.y, w.x * s + w.z * c]; return g.view === "side" ? [v[2], v[1]] : [v[0], v[1]]; };
      const o = g.segments[0].pts[0], check = (pt, id) => { const w = uv(id); n++; assert.ok(Math.hypot(pt[0] - (o[0] + w[0]), pt[1] - (o[1] + w[1])) < 0.005, `${bn} ${p.id} ${id}`); };
      ["pelvis", "L5", "L3", "L1", "T11", "T8", "T5", "T2", "C7", "C4", "C1", "head"].forEach((id, i) => check(g.segments[0].pts[i], id));
      ["L", "R"].forEach((sd, k) => {
        ["clavicle", "shoulder", "elbow", "wrist"].forEach((b, i) => check(g.segments[1 + 3 * k].pts[i], `${b}_${sd}`));
        ["pelvis", "hip", "knee", "ankle"].forEach((b, i) => check(g.segments[2 + 3 * k].pts[i], b === "pelvis" ? b : `${b}_${sd}`));
      });
    }
  }
  assert.ok(n > 10000);
});
