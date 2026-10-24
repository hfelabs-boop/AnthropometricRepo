// MIL-STD-1472H checks (site/js/human/mil1472.js, compliance.js): every clause and limit against standards/mil-std-1472h/requirements.json, the tags of
// the posture library, the objects of the catalogue, and the interactions of the REAL rig, posture editor and sandbox (seat, grips, displays, a load).
//   node --import ./tests/human3d/register.mjs --test tests/human3d/mil1472.test.mjs
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
import { POSTURES, byId } from "../../site/js/human/postures.js";
import { createEditor } from "../../site/js/human/editor.js";
import { createSandbox } from "../../site/js/human/sandbox.js";
import { createStore } from "../../site/js/human/state.js";
import { CATALOG, byType, defaultParams } from "../../site/js/human/catalog.js";
import {
  CLAUSES, ROM_XXXI, LIFT, HANDLE_DIA, checkObject, checkPosture, checkScene, summarize, postureCompliance, romResults, liftLimit, loadResults, tagText, clauseRef,
} from "../../site/js/human/mil1472.js";
import { complianceReport, reportCSV, sceneFacts, objectCompliance, stanceOf } from "../../site/js/human/compliance.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQ = JSON.parse(fs.readFileSync(path.join(ROOT, "standards/mil-std-1472h/requirements.json"), "utf8")).requirements;
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const MAN = army("M", 50), WOMAN = army("F", 5);

/** The values of the catalogue entries whose para (or title) matches. */
function vals(para, title = null) {
  const rows = REQ.filter((r) => r.para === para && (!title || title.test(r.title)));
  assert.ok(rows.length, `no catalogue entry ${para} ${title ?? ""}`);
  return rows.flatMap((r) => r.values);
}
const val = (para, title, quantity) => {
  const v = vals(para, title).find((x) => quantity.test(x.quantity));
  assert.ok(v, `no value ${quantity} in ${para}`);
  return v;
};
const statusOf = (results, id) => results.find((r) => r.id === id)?.status;

// ---------------------------------------------------------------------------------------------------------------------------------------- clauses
test("every clause cited exists in the requirements catalogue, with its table or figure and page", () => {
  for (const [key, c] of Object.entries(CLAUSES)) {
    // the paragraph itself, or (for values printed only in a figure or table, which the catalogue lists under the figure) the figure or table it cites
    const hit = REQ.some((r) => r.para === c.clause || r.para.split(/[ /,-]+/).includes(c.clause) || r.text.includes(c.clause)) || (c.ref && REQ.some((r) => r.para === c.ref));
    assert.ok(hit, `${key}: clause ${c.clause} is not in the catalogue`);
    if (c.ref) for (const ref of c.ref.split(/ to | and /)) {
      const r = ref.startsWith("Table") || ref.startsWith("Figure") ? ref : `Table ${ref}`;
      if (/Tables XLII/.test(c.ref)) continue;
      assert.ok(REQ.some((x) => x.para === r || x.source?.includes(r)), `${key}: ${r} is not in the catalogue`);
    }
    assert.ok(Number.isInteger(c.page) && c.page > 0 && c.page < 440, `${key}: page`);
    assert.ok(["shall", "should"].includes(c.level));
  }
});

test("Table XXXI: the 36 ranges of motion equal the catalogue", () => {
  const rows = REQ.filter((r) => r.para === "Table XXXI");
  assert.equal(rows.length, 36);
  const label = { shoulderFlexion: /shoulder flexion$/, shoulderExtension: /shoulder extension/, elbowFlexion: /elbow flexion/, forearmPronation: /forearm pronation/, forearmSupination: /forearm supination/,
    wristFlexion: /wrist flexion/, wristExtension: /wrist extension/, wristUlnar: /ulnar/, wristRadial: /radial/, hipFlexion: /hip flexion/, kneeFlexionStanding: /knee flexion \(standing\)/,
    kneeFlexionKneeling: /knee flexion \(kneeling\)/, kneeFlexionProne: /knee flexion \(prone\)/, neckFlexion: /neck flexion/, neckExtension: /neck extension/, ankleAnterior: /anterior tibial/, anklePosterior: /posterior tibial/ };
  for (const [key, re] of Object.entries(label)) {
    const r = rows.find((x) => re.test(x.title.toLowerCase()));
    assert.ok(r, key);
    assert.deepEqual(ROM_XXXI[key], [r.values[0].max, r.values[1].max], key);
  }
});

test("lifting and handle tables equal the catalogue (Tables XLI, XLII, XLVII, Figure 101)", () => {
  assert.deepEqual(LIFT.team, vals("Table XLI").map((v) => v.max));
  assert.equal(LIFT.LC, val("5.20.3.3", null, /load constant/).max);
  // Table XLII formulas: 25/H, 1 - 0.003|V-75|, 0.82 + 4.5/D, 1 - 0.0032A, capped at 1
  assert.equal(LIFT.HM(50), 0.5); assert.equal(LIFT.HM(20), 1);
  assert.ok(Math.abs(LIFT.VM(25) - 0.85) < 1e-12); assert.equal(LIFT.VM(75), 1);
  assert.ok(Math.abs(LIFT.DM(45) - 0.92) < 1e-12); assert.equal(LIFT.DM(10), 1);
  assert.ok(Math.abs(LIFT.AM(90) - 0.712) < 1e-12);
  assert.equal(LIFT.carryBest, Math.max(...vals("Table XLVII").map((v) => v.max)));
  assert.deepEqual(HANDLE_DIA.map(([, d]) => d), vals("Figure 101", /diameter by item weight/).filter((v) => /handle diameter D/.test(v.quantity)).map((v) => v.min));
});

// ---------------------------------------------------------------------------------------------------------------------------------------- objects
/** Pass at both limits, fail just outside them (the limits taken from the catalogue). */
function edges(type, param, scale, lo, hi, id, extra = {}) {
  const at = (v) => statusOf(checkObject({ id: "o", type, name: type, params: { ...defaultParams(type), ...extra, [param]: v / scale } }, { grips: byType(type).grips?.({ ...defaultParams(type), [param]: v / scale }) ?? [] }), id);
  if (lo != null) { assert.equal(at(lo), "pass", `${type}.${param} at ${lo}`); assert.notEqual(at(lo - 1), "pass", `${type}.${param} below ${lo}`); }
  if (hi != null) { assert.equal(at(hi), "pass", `${type}.${param} at ${hi}`); assert.notEqual(at(hi + 1), "pass", `${type}.${param} above ${hi}`); }
}

test("stairs and steps: riser, tread and width follow Figure 86; the angle Table XXXI V; the model's 38 mm rail fails 40 to 80 mm", () => {
  const riser = val("Figure 86", /riser/, /riser/), tread = val("Figure 86", /tread/, /tread/), width = val("Figure 86", /one-way/, /width/);
  edges("stairs", "rise", 1000, riser.min, riser.max, "riser", { tread: 0.29 });
  edges("stairs", "tread", 1000, tread.min, tread.max, "tread", { rise: 0.17 });
  edges("stairs", "width", 1000, width.min, null, "width");
  edges("step", "rise", 1000, riser.min, riser.max, "riser", { depth: 0.29 });
  const st = checkObject({ id: "s", type: "stairs", name: "Stairs", params: { ...defaultParams("stairs"), handrails: true } });
  const dia = val("Figure 86", /diameter/, /diameter/);
  assert.equal(dia.min, 40);
  assert.equal(statusOf(st, "rail-dia"), "fail", "38 mm is below the 40 mm minimum");
  assert.equal(statusOf(st, "rail-height"), "pass");
  const ang = vals("Table XXXIV", /Stairs$/)[0];
  assert.deepEqual([ang.min, ang.max], [30, 50]);
  const steep = checkObject({ id: "s", type: "stairs", name: "S", params: { ...defaultParams("stairs"), rise: 0.2, tread: 0.2 } });
  assert.equal(statusOf(steep, "angle"), "pass", "45 degrees");
  const off = checkObject({ id: "s", type: "stairs", name: "S", params: { ...defaultParams("stairs"), handrails: false } });
  assert.equal(statusOf(off, "handrails"), "fail");
  assert.equal(summarize(off).status, "not-compliant");
});

test("ladder (Figure 88, Table XXXIV), door (Figure 82), hatch (Figure 83), seats (Figures 39, 73), desk (5.10.3.9.2.2)", () => {
  const sp = val("Figure 88", /rung spacing/, /spacing/);
  edges("ladder", "spacing", 1000, sp.min, sp.max, "spacing");
  assert.equal(statusOf(checkObject({ type: "ladder", params: { ...defaultParams("ladder"), angle: 70 } }), "angle"), "check", "inclined stairs range");
  assert.equal(statusOf(checkObject({ type: "ladder", params: { ...defaultParams("ladder"), angle: 80 } }), "angle"), "pass");
  const dw = val("Figure 82", /clear width/, /door width/);
  assert.deepEqual([dw.min, dw.max], [810, 860]);
  assert.equal(statusOf(checkObject({ type: "doorway", params: { ...defaultParams("doorway"), width: 0.8 } }), "width"), "fail");
  assert.equal(statusOf(checkObject({ type: "doorway", params: { ...defaultParams("doorway"), width: 0.84 } }), "width"), "pass");
  const side = vals("Figure 83", /side access/);
  assert.equal(side[0].min, 660); assert.equal(side[1].min, 760);
  const hatch = checkObject({ type: "hatch", params: { ...defaultParams("hatch"), width: 0.76, height: 0.66 } });
  assert.equal(statusOf(hatch, "access-height"), "pass"); assert.equal(statusOf(hatch, "access-width"), "pass");
  assert.equal(statusOf(checkObject({ type: "hatch", params: defaultParams("hatch") }), "access-width"), "fail", "the default 600 mm hatch");
  const pan = val("Figure 39", /pan width/, /width/);
  edges("cabin_seat", "panWidth", 1000, pan.min, pan.max, "width");
  const depth = val("Figure 73", /seat pan depth/i, /depth/);
  edges("office_chair", "seatDepth", 100, null, depth.max, "depth");
  const desk = val("5.10.3.9.2.2", null, /height/);
  edges("desk", "height", 100, desk.min, desk.max, "height");
});

test("loads: one-lifter limit (Table XLI), two handles over 4.5 kg, handle diameter by mass (Figure 101); controls: steering rim, pedals", () => {
  const crate = (mass) => checkObject({ type: "crate", params: { ...defaultParams("crate"), mass } }, { grips: byType("crate").grips(defaultParams("crate")) });
  assert.equal(statusOf(crate(23), "mass"), "pass");
  assert.equal(statusOf(crate(24), "mass"), "fail");
  assert.equal(statusOf(crate(24), "label"), "input");
  assert.equal(statusOf(crate(10), "handles"), "pass");
  const tb = checkObject({ type: "toolbox", params: { ...defaultParams("toolbox"), mass: 8 } }, { grips: byType("toolbox").grips(defaultParams("toolbox")) });
  assert.equal(statusOf(tb, "handles"), "fail", "one handle on an 8 kg toolbox");
  assert.equal(statusOf(checkObject({ type: "small_box", params: { ...defaultParams("small_box"), mass: 0 } }), "mass"), "input");
  const sw = checkObject({ type: "steering_wheel", params: defaultParams("steering_wheel") });
  assert.equal(statusOf(sw, "rim"), "fail", "34 mm rim, 19 to 32 mm");
  assert.equal(statusOf(sw, "dia"), "pass");
  assert.equal(statusOf(checkObject({ type: "pedals", params: { ...defaultParams("pedals"), angle: 65 } }), "angle"), "fail");
  assert.equal(statusOf(checkObject({ type: "pedals", params: defaultParams("pedals") }), "sep"), "fail");
});

test("every catalogue type gets a 1472H statement with its default parameters: a clause, or 'no requirement applies' for reference objects", () => {
  let n = 0;
  for (const t of CATALOG) {
    const p = defaultParams(t.type), res = checkObject({ id: "x", type: t.type, name: t.name, params: p }, { grips: t.grips?.(p) ?? [] });
    assert.ok(res.length, `${t.type}: no statement`);
    for (const r of res) {
      assert.ok(["pass", "fail", "check", "input", "na"].includes(r.status), `${t.type} ${r.id}`);
      if (r.status === "na") assert.ok(r.title && r.note && !r.clause, `${t.type} ${r.id}`);
      else assert.ok(r.clause && r.title && r.page, `${t.type} ${r.id}`);
      if (r.value != null) assert.ok(Number.isFinite(r.value));
    }
    const s = summarize(res);
    assert.ok(s.status !== "none", `${t.type}: summary none`);
    assert.ok(tagText(s).length > 10, `${t.type}: tag`);
    n += res.length;
  }
  assert.ok(n > 150, `${n} checks`);
});

test("new object checks: rack working level and access openings, cabin room, seat height, keyboard and joystick sizes", () => {
  const rack = (o) => checkObject({ type: "equipment_rack", params: { ...defaultParams("equipment_rack"), ...o } });
  assert.ok(rack({}).some((r) => r.clause === "5.9.1.9.1"));
  const sh = (o) => checkObject({ type: "cabin_shell", params: { ...defaultParams("cabin_shell"), ...o } });
  assert.equal(statusOf(sh({ width: 0.5 }), "elbow"), "check", "a should clause");
  assert.equal(statusOf(sh({}), "elbow"), "pass");
  const st = checkObject({ type: "stool", params: { ...defaultParams("stool"), height: 0.75 } });
  assert.ok(st.some((r) => r.status === "fail"), "a 75 cm stool without a footrest");
  for (const t of ["cube_1m", "measuring_pole", "point_marker"]) assert.equal(summarize(checkObject({ type: t, params: defaultParams(t) })).status, "na", t);
  assert.equal(summarize(checkObject({ type: "cad_model", params: defaultParams("cad_model") })).status, "review");
});

// ---------------------------------------------------------------------------------------------------------------------------------------- postures
test("ranges of motion: pass up to mean - 1 SD, check to mean + 1 SD, fail beyond (approximate mappings stop at check)", () => {
  const r = (angles, ctx = "standing") => romResults(angles, null, ctx);
  assert.equal(r({ elbow_L: [130] })[0].status, "pass");
  assert.equal(r({ elbow_L: [140] })[0].status, "check");
  assert.equal(r({ elbow_L: [155] })[0].status, "fail");
  assert.equal(r({ knee_L: [140] }, "kneeling")[0].status, "pass", "kneeling column 150 to 168");
  assert.equal(r({ knee_L: [140] }, "standing")[0].status, "fail", "standing column 100 to 126");
  assert.equal(r({ shoulder_L: [0, 0, -60] })[0].status, "check", "shoulder rotation is an approximate mapping");
  assert.equal(r({})[0].id, "rom-all");
});

test("the posture library: every posture gets a tag on two bodies; neutral standing is compliant; heavy lifts fail the lifting equation", () => {
  for (const body of [MAN, WOMAN]) {
    const counts = {};
    for (const p of POSTURES) {
      const t = postureCompliance(body, p);
      assert.ok(["compliant", "not-compliant", "check"].includes(t.status), `${p.id}: ${t.status}`);
      assert.ok(t.summary.clauses.length > 0);
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    assert.ok(counts.compliant > 50 && counts["not-compliant"] > 5, JSON.stringify(counts));
  }
  assert.equal(postureCompliance(MAN, byId("stand-relaxed")).status, "compliant");
  const stoop = postureCompliance(MAN, byId("lift-stoop-start"));
  assert.equal(stoop.status, "not-compliant");
  assert.ok(stoop.summary.failed.some((c) => c.startsWith("5.20.3.3")), stoop.summary.failed.join());
  const eq = stoop.results.find((x) => x.id === "lift-eq");
  assert.ok(eq.value > 0 && /H \d+ cm, V \d+ cm/.test(eq.limit));
  assert.match(tagText(stoop.summary), /^Not compliant with 5\.20\.3\.3/);
});

test("the lifting equation: an ideal lift allows 23 kg, a low far lift much less; frequency is listed as an input", () => {
  assert.ok(Math.abs(liftLimit({ H: 0.25, V: 0.75, A: 0 }).WL - 23) < 1e-9);
  const low = liftLimit({ H: 0.5, V: 0.1, A: 45 });
  assert.ok(low.WL < 10, `${low.WL}`);
  const r = loadResults({ mass: 12, H: 0.5, V: 0.1, A: 45 });
  assert.equal(statusOf(r, "lift-one"), "pass"); assert.equal(statusOf(r, "lift-eq"), "fail"); assert.equal(statusOf(r, "lift-input"), "input");
  assert.deepEqual(loadResults({ mass: 2 }), [], "below 2.3 kg the limits do not apply");
  assert.equal(statusOf(loadResults({ mass: 20, carrying: true }), "carry-limit"), "fail");
  assert.equal(statusOf(loadResults({ mass: 20, carrying: true, carriers: 2 }), "carry-limit"), "pass");
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the scene
function stubViewport() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.05, 120);
  const handlers = new Map(), container = new EventTarget();
  return {
    scene, camera, container, controls: { enabled: true }, active: true, gizmo: null, gizmoDragging: false, canvas: null, cursor: "",
    theme: { accent: new THREE.Color(0x2a78d6), good: new THREE.Color(0x0f7a2e) },
    add(o) { scene.add(o); }, remove(o) { scene.remove(o); }, requestRender() {},
    on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
    emit() {}, ray() { return new THREE.Raycaster(); }, toClient() { return { clientX: 0, clientY: 0 }; },
    attachGizmo() {}, detachGizmo() {}, setGizmoOptions() {}, setCursor() {}, addLabelSource() { return () => {}; }, removeLabelSource() {}, frame() {},
  };
}
function world(body = MAN) {
  const rig = buildRig(body, {}), store = createStore(), viewport = stubViewport();
  const ctx = { state: store.state, viewport, on: (e, f) => store.on(e, f), emit: (e, d) => store.emit(e, d), select: (s) => store.select(s), getRig: () => rig, getBody: () => rig.body, toast() {}, units: "mm", setPosture() {} };
  rig.onChange(() => ctx.emit("pose", { rig }));
  const sb = createSandbox({ viewport, ctx, storage: null, scheduler: () => () => {} });
  ctx.sandbox = sb;
  const ed = createEditor({ getRig: () => rig, getBody: () => rig.body, ik: IK, metrics: METRICS, ctx, storage: null, scheduler: { raf: null, caf: null, now: () => 0 }, coalesceMs: 0 });
  return { rig, sb, ed, ctx, profile: { label: "US Army man P50", sex: "M", source: { kind: "population", percentile: 50 } } };
}

test("a seated figure: feet support, a display too far away, a display face at an angle; the population rule is always listed", () => {
  const w = world();
  w.ed.apply("sit-upright-90");
  const seat = w.sb.add("office_chair", { position: [0, 0, 0], yaw: 0 });
  assert.ok(w.ed.sitOn(seat.id), "sits on the chair");
  const f0 = sceneFacts({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  assert.equal(f0.stance, "seated");
  assert.equal(f0.seat.id, seat.id);
  // a monitor 1.2 m in front of the eyes, at eye height
  const eye = w.rig.landmarkWorld("eye_mid").clone();
  const heading = w.ed.place.heading * Math.PI / 180, fx = Math.sin(heading), fz = Math.cos(heading);
  const mon = w.sb.add("monitor", { position: [eye.x + fx * 1.2, 0, eye.z + fz * 1.2], yaw: w.ed.place.heading + 180 });
  w.sb.setParam(mon.id, "centreHeight", eye.y);
  const rep = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  const view = rep.interactions.find((g) => g.subject.id === `view:${mon.id}`);
  assert.ok(view, "the monitor is an interaction");
  const far = view.results.find((r) => r.id === "view-max");
  assert.equal(far.status, "fail", `${far.value} cm`);
  assert.ok(far.value > 110 && far.value < 130);
  assert.equal(view.results.find((r) => r.id === "face").status, "pass", "facing the figure");
  assert.ok(rep.population.length === 1 && rep.population[0].status === "input");
  assert.match(rep.population[0].note, /US Army man P50/);
  // move it to 60 cm: the distance passes
  w.sb.move(mon.id, { x: eye.x + fx * 0.6, z: eye.z + fz * 0.6 }, { snap: false });
  const rep2 = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  assert.equal(rep2.interactions.find((g) => g.subject.id === `view:${mon.id}`).results.find((r) => r.id === "view-max").status, "pass");
  const own = objectCompliance(rep2, mon.id);
  assert.ok(own.results.some((r) => r.subject.kind === "interaction") && own.results.some((r) => r.subject.kind === "object"));
  // the feet: a bar stool at its highest leaves them hanging
  const csv = reportCSV(rep2);
  assert.match(csv.split("\n")[3], /^subject_kind,subject,clause/);
  assert.ok(csv.split("\n").length > 8);
});

test("hands on grips: a standing figure gripping a handle above 181 cm fails 5.10.3.8.2.4; a load in the hands is checked with the lifting equation", () => {
  const w = world();
  w.ed.apply("stand-relaxed");
  const g = w.rig.landmarkWorld("grip_centre_R").clone();
  // a grab handle whose middle grip sits exactly at the right hand: the hand is "on" it
  const bar = w.sb.add("grab_handle", { position: [0, 0, 0], yaw: 0 });
  w.sb.setParam(bar.id, "centreHeight", g.y);
  const gr = w.sb.gripsWorld(bar.id).find((x) => x.id === "mid");
  w.sb.move(bar.id, { x: g.x - gr.position.x, z: g.z - gr.position.z }, { snap: false });
  const f = sceneFacts({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  const hold = f.holds.find((x) => x.objectId === bar.id);
  assert.ok(hold, `the hand is on the bar: ${JSON.stringify(f.holds)}`);
  const res = checkScene({ ...f, holds: [{ ...hold, position: [hold.position[0], 1.9, hold.position[2]] }] });
  assert.equal(res.find((r) => r.id === "overhead").status, "fail");
  const ok = checkScene(f).find((r) => r.id === "overhead");
  assert.equal(ok.status, "pass", `${ok.value} cm`);
  // a 30 kg crate held at the hands' height fails the one-lifter limit
  const facts = { ...f, holds: [], displays: [], load: { objectId: "c", name: "Crate", mass: 30, H: 0.4, V: 0.8, A: 0 } };
  const lr = checkScene(facts);
  assert.equal(lr.find((r) => r.id === "lift-one").status, "fail");
  assert.equal(summarize(lr).status, "not-compliant");
  assert.equal(stanceOf({ carriers: { feet: "floor" }, support: "feet" }, null, { knee_L: [120] }), "squatting");
});

test("the report of an empty scene lists the posture and the population rule; it is fast", () => {
  const w = world();
  w.ed.apply("lift-stoop-start");
  const t0 = performance.now();
  const rep = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  assert.ok(performance.now() - t0 < 200);
  assert.equal(rep.objects.length, 0);
  assert.equal(rep.posture.summary.status, "not-compliant", "the posture's 15 kg lift");
  assert.ok(rep.summary.failed.some((c) => c.startsWith("5.20.3.3")));
  assert.ok(rep.results.every((r) => typeof clauseRef(r) === "string"));
});

// ---------------------------------------------------------------------------------------------------------------------------------------- relations
test("relations in the scene: head room above a seat in a cabin (Figure 39), the figure to the cabin's surfaces (5.6.2.2), a desk to the wall (Figure 58 D)", () => {
  for (const [tpl, roof] of [["cockpit", "canopy"], ["helicopter", "flat"]]) {
    const w = world();
    w.sb.applyTemplate(tpl);
    const objs = [...w.sb.objects.values()], cab = objs.find((o) => o.type === "cabin_shell"), seat = objs.find((o) => o.type === "cabin_seat");
    assert.ok(cab && seat, tpl);
    assert.equal(cab.params.roof, roof);
    w.ed.apply("sit-upright-90");
    assert.ok(w.ed.sitOn(seat.id), `${tpl}: sits`);
    const t0 = performance.now();
    const rep = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
    assert.ok(performance.now() - t0 < 1500, `${tpl}: ${performance.now() - t0} ms`);
    const head = rep.interactions.find((g) => g.subject.id === `headroom:${cab.id}:${seat.id}`);
    assert.ok(head, `${tpl}: head room above the seat`);
    const hr = head.results[0];
    assert.ok(hr.value > 600 && hr.value < 2000, `${tpl}: ${hr.value} mm`);
    const clear = rep.interactions.find((g) => g.subject.id === `clear:${cab.id}`);
    assert.ok(clear, `${tpl}: the figure is in the cabin`);
    assert.deepEqual(clear.results.map((r) => r.id), ["head-clear", "fore-aft", "lateral", "vertical"]);
    for (const r of clear.results) assert.ok(["pass", "fail", "check"].includes(r.status), `${tpl} ${r.id} ${r.status}`);
    // the cabin's own "needs information" items are answered by the scene
    const own = objectCompliance(rep, cab.id);
    assert.ok(!own.results.some((r) => r.status === "input"), `${tpl}: ${own.results.filter((r) => r.status === "input").map((r) => r.id)}`);
    assert.ok(own.results.some((r) => r.clause === "5.6.2.1") && own.results.some((r) => r.clause === "5.6.2.2.1"));
    assert.ok(objectCompliance(rep, seat.id).results.some((r) => r.clause === "5.6.2.1"), "the seat shows its head room too");
    // lower the roof onto the head: the head room and the head clearance fail
    w.sb.setParam(cab.id, "height", 0.9);
    const low = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
    assert.equal(low.interactions.find((g) => g.subject.id === `headroom:${cab.id}:${seat.id}`).results[0].status, "fail", tpl);
  }
  // an empty cabin: no seat, no figure in it
  const w = world();
  w.ed.apply("stand-relaxed");
  const cab = w.sb.add("cabin_shell", { position: [5, 0, 5], yaw: 0 });
  const rep = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  const own = objectCompliance(rep, cab.id);
  assert.equal(own.results.find((r) => r.clause === "5.6.2.1").status, "na");
  assert.equal(own.results.find((r) => r.id === "body-clearance").status, "input", "the figure is not in it");
  // desk to wall: 50 cm fails, 1 m passes; a wall nobody faces says so
  const wall = w.sb.add("wall", { position: [0, 0, 0], yaw: 180 });
  const desk = w.sb.add("desk", { position: [0, 0, -0.5 - 0.35], yaw: 0 });
  let r = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  let dw = r.interactions.find((g) => g.subject.id === `deskwall:${desk.id}:${wall.id}`);
  assert.ok(dw, JSON.stringify(r.facts.desks));
  assert.ok(Math.abs(dw.results[0].value - 50) < 1.5, `${dw.results[0].value} cm`);
  assert.equal(dw.results[0].status, "fail");
  assert.ok(objectCompliance(r, wall.id).results.every((x) => x.status !== "input"));
  assert.ok(!r.objects.some((g) => g.object.id === wall.id), "the wall's only item is the relation: no empty object group");
  assert.ok(r.objects.every((g) => g.results.length && g.summary.status !== "none"));
  w.sb.move(desk.id, { x: 0, z: -1.0 - 0.35 }, { snap: false });
  r = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  assert.equal(r.interactions.find((g) => g.subject.id === `deskwall:${desk.id}:${wall.id}`).results[0].status, "pass");
  const wall2 = w.sb.add("wall", { position: [8, 0, 8], yaw: 0 });
  r = complianceReport({ rig: w.rig, editor: w.ed, sandbox: w.sb, profile: w.profile });
  assert.equal(objectCompliance(r, wall2.id).summary.status, "na");
});
