// The posture editor engine (site/js/human/editor.js): apply, edit, history, placement, custom postures, IK drags, readouts. Manual: docs/human3d/EDITOR.md.
//   node --import ./tests/human3d/register.mjs --test "tests/human3d/editor.test.mjs"
// A real rig (no skin) on three bodies, a manual clock and animation-frame queue, an in-memory storage, a fake sandbox and a fake viewport: no browser.
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
import { POSTURES, search as librarySearch } from "../../site/js/human/postures.js";
import { expandPosture, expandSpine, clampPose, poseEquals, mirrorPose, contactClearances, placePose } from "../../site/js/human/pose.js";
import { parsePostureFile } from "../../site/js/human/export.js";
import * as ED from "../../site/js/human/editor.js";
import * as PANEL from "../../site/js/human/panels/posture.js";
import { createEditor, createHandleLayer, editorFor, peekEditor, sanitizePosture, parseCustomStore, customIdFor, sliderBounds, regionTotals, tabOfJoint, seatSurfaces, HANDLES, EDIT_TABS, MAX_HISTORY, MAX_CUSTOM, MAX_CUSTOM_BYTES, STORAGE_KEY } from "../../site/js/human/editor.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const army = (sex, percentile) => fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army", `${sex}.json`))), { percentile }));
const BODIES = [["woman P5", army("F", 5)], ["man P50", army("M", 50)], ["man P95", army("M", 95)]];
const MAN = BODIES[1][1];

// ---- helpers -----------------------------------------------------------------------------------------------------------------------------
/** A manual clock and animation-frame queue: flush(ms) runs frames of 16 ms for that long. */
function makeClock() {
  let t = 0, id = 0;
  const q = new Map();
  return {
    now: () => t, raf: (f) => { q.set(++id, f); return id; }, caf: (i) => { q.delete(i); },
    advance(ms) { t += ms; },
    get pending() { return q.size; },
    flush(ms = 1000) { const end = t + ms; while (q.size && t < end) { t += 16; const run = [...q]; q.clear(); for (const [, f] of run) f(t); } },
  };
}
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
/** An editor on a fresh rig. `animated: true` gives it the manual animation queue; otherwise nothing animates. */
function setup(body = MAN, { animated = false, storage = memStorage(), ctx = null, coalesceMs, reducedMotion } = {}) {
  const rig = buildRig(body, {});
  const clock = makeClock();
  const ed = createEditor({ getRig: () => rig, ik: IK, metrics: METRICS, storage, ctx, coalesceMs, reducedMotion, scheduler: animated ? { raf: clock.raf, caf: clock.caf, now: clock.now } : { raf: null, caf: null, now: clock.now } });
  return { rig, ed, clock, storage };
}
const orient = (root) => ({ heading: root.heading, flex: root.flex, lat: root.lat, rot: root.rot });
const rel = (rig) => { const p = rig.getPose(); return { root: orient(p.root), angles: p.angles }; };
const expanded = (posture) => { const ex = expandPosture(posture); return clampPose({ root: ex.root, angles: ex.angles }); };
const v3 = (rig, id) => rig.landmarkWorld(id).clone();
const primaryClearance = (ed, rig) => {
  const info = ed.info(), primary = Object.keys(info.place.carriers)[0];
  return info.gaps[primary];
};
const approx = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);

// ---- apply every posture of the library ---------------------------------------------------------------------------------------------------
test("every library posture can be applied to three bodies: the pose is the expanded one, inside the ranges, and the figure is on its support", async () => {
  for (const [name, body] of BODIES) {
    const { rig, ed } = setup(body);
    await ed.ready;
    const problems = [];
    for (const p of POSTURES) {
      const res = ed.apply(p.id, { animate: false });
      const exp = expanded(p);
      if (!poseEquals(rel(rig), exp.pose, 1e-9)) problems.push(`${p.id}: the pose is not the expanded pose`);
      if (res.clamped.length) problems.push(`${p.id}: ${res.clamped.length} angles clamped`);
      const info = ed.info();
      if (info.romViolations.length) problems.push(`${p.id}: ${info.romViolations.length} angles outside their range`);
      if (Math.abs(primaryClearance(ed, rig)) > 1e-6) problems.push(`${p.id}: the primary carrier is ${primaryClearance(ed, rig)} m from its surface`);
      if (rig.lowestY() < -0.012) problems.push(`${p.id}: a landmark is ${(-rig.lowestY() * 1000).toFixed(1)} mm below the floor`);
      if (ed.modified) problems.push(`${p.id}: reported as modified right after applying it`);
      if (ed.base.id !== p.id) problems.push(`${p.id}: base is ${ed.base.id}`);
    }
    assert.deepEqual(problems, [], `${name}: ${problems.slice(0, 6).join("; ")}`);
  }
});

test("apply: placement follows the support (floor, seat at the popliteal height, lying), keeps the anchor and heading, and the name goes to the shell", () => {
  const posted = [];
  const ctx = { setPosture: (p) => posted.push(p), on: () => () => {}, state: {} };
  const { rig, ed } = setup(MAN, { ctx });
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(ed.place.mode, "floor");
  assert.deepEqual(posted.at(-1), { id: "iso-7250-standing", name: ed.base.name });
  ed.apply("iso-7250-sitting", { animate: false });
  assert.equal(ed.place.mode, "seat");
  assert.equal(ed.place.support, "seat+feet");
  const seat = ed.seatHeight();
  assert.ok(seat > 0.35 && seat < 0.5, `popliteal seat ${seat}`);
  ed.setAnchor({ x: 0.3, z: -0.2 });
  ed.setHeading(40);
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(ed.place.mode, "floor");
  approx(rig.root.heading, 40, 1e-9, "heading kept");
  assert.deepEqual(ed.place.anchor, { x: 0.3, z: -0.2 });
  const c = ["heel_sole_L", "heel_sole_R"].map((id) => v3(rig, id));
  assert.ok(Math.hypot((c[0].x + c[1].x) / 2 - 0.3, (c[0].z + c[1].z) / 2 + 0.2) < 0.2, "the feet are around the anchor");
  ed.apply("lie-supine", { animate: false });
  assert.equal(ed.place.support, "body");
  assert.ok(Math.abs(rig.lowestY()) < 0.012, "lying on the floor");
  assert.throws(() => ed.apply("no-such-posture"), /unknown posture/);
  assert.throws(() => ed.apply({ id: "x", name: "x", joints: { bogus_LR: [1] }, support: "feet" }), /bogus/);
  assert.equal(ed.base.id, "lie-supine", "a failed apply changes nothing");
});

test("a posture object (not in the library) is shown as an imported base; editing it names it 'edited' in the shell", () => {
  const posted = [];
  const ctx = { setPosture: (p) => posted.push(p), on: () => () => {}, state: {} };
  const { rig, ed } = setup(MAN, { ctx });
  const custom = { id: "my-pose", name: "My pose", category: "Reference", tags: [], description: "d", source: "s", support: "feet", joints: { elbow_LR: [90] } };
  ed.apply(custom, { animate: false });
  assert.equal(ed.base.kind, "imported");
  assert.equal(rig.angles.elbow_R[0], 90);
  assert.equal(ed.modified, false);
  ed.setJoint("elbow_R", 0, 80);
  assert.equal(ed.modified, true);
  assert.deepEqual(posted.at(-1), { id: null, name: "My pose (edited)" });
  ed.setJoint("elbow_R", 0, 90);
  assert.equal(ed.modified, false, "putting the angle back is not a modification");
  assert.deepEqual(posted.at(-1), { id: "my-pose", name: "My pose" });
});

// ---- editing ------------------------------------------------------------------------------------------------------------------------------------
test("setJoint: by index or key, clamps to the range of motion and says so, or goes beyond it with the range not enforced", () => {
  const { rig, ed } = setup();
  let r = ed.setJoint("elbow_R", "flex", 100);
  assert.equal(rig.angles.elbow_R[0], 100);
  assert.deepEqual(r.clamped, []);
  r = ed.setJoint("elbow_R", 0, 200);
  assert.equal(rig.angles.elbow_R[0], 150);
  assert.deepEqual(r.clamped, [{ joint: "elbow_R", dof: "flex", requested: 200, applied: 150 }]);
  assert.deepEqual(ed.clamps, r.clamped);
  r = ed.setJoint("elbow_R", 0, 200, { clamp: false });
  assert.equal(rig.angles.elbow_R[0], 200);
  assert.equal(ed.info().romViolations.length, 1);
  assert.match(ed.info().romViolations[0].label, /elbow/i);
  ed.setOption("enforceRom", false);
  ed.setJoint("shoulder_L", "flex", 250);
  assert.equal(rig.angles.shoulder_L[0], 250);
  ed.setOption("enforceRom", true);
  ed.setJoint("shoulder_L", "flex", 250);
  assert.equal(rig.angles.shoulder_L[0], 180);
  for (const bad of [["nope", 0, 1], ["elbow_R", 3, 1], ["elbow_R", "bogus", 1], ["elbow_R", 0, NaN], ["elbow_R", 0, "10"], ["elbow_R", 0, Infinity], ["__proto__", 0, 1], ["constructor", 0, 1]]) {
    assert.throws(() => ed.setJoint(...bad), /unknown joint|no degree of freedom|finite number/, JSON.stringify(bad));
  }
});

test("setJoint symmetric: the twin gets the same anatomical angle; the eyes keep looking the same way (posture convention)", () => {
  const { rig, ed } = setup();
  ed.setJoint("shoulder_L", "abd", 40, { symmetric: true });
  assert.deepEqual([rig.angles.shoulder_L[1], rig.angles.shoulder_R[1]], [40, 40]);
  ed.setJoint("hip_R", "flex", 30, { symmetric: true });
  assert.deepEqual([rig.angles.hip_L[0], rig.angles.hip_R[0]], [30, 30]);
  ed.setJoint("eye_L", "azim", 20, { symmetric: true });
  assert.deepEqual([rig.angles.eye_L[1], rig.angles.eye_R[1]], [20, -20], "both eyes look to the figure's left: the right eye's joint angle is the negation");
  ed.setJoint("eye_R", "azim", 10, { symmetric: true });
  assert.deepEqual([rig.angles.eye_L[1], rig.angles.eye_R[1]], [-10, 10]);
  ed.setJoint("eye_L", "elev", 15, { symmetric: true });
  assert.deepEqual([rig.angles.eye_L[0], rig.angles.eye_R[0]], [15, 15]);
  // the option makes it the default; an unpaired joint has no twin; the limits of the twin hold
  ed.setOption("symmetric", true);
  ed.setJoint("head", "lat", 5);
  assert.equal(rig.angles.head[1], 5);
  ed.setJoint("clavicle_L", "elev", 80);
  assert.equal(rig.angles.clavicle_R[0], 45);
  ed.resetJoint("shoulder_L");
  assert.deepEqual([rig.angles.shoulder_L, rig.angles.shoulder_R], [[0, 0, 0], [0, 0, 0]]);
  // the posture library's own symmetric posture stays symmetric under copySide
  ed.setOption("symmetric", false);
  ed.setJoint("eye_L", "azim", 25);
  ed.copySide("L");
  assert.deepEqual([rig.angles.eye_L[1], rig.angles.eye_R[1]], [25, -25]);
});

test("setRegion: the total is shared by the vertebrae as expandSpine does, other channels stay, and a total that does not fit is reported", () => {
  const { rig, ed } = setup();
  ed.setJoint("L3", "lat", 3);
  const r = ed.setRegion("lumbar", [40, null, null]);
  const want = expandSpine({ lumbar: [40, 0, 0] }).angles;
  for (const id of REGIONS.lumbar.joints) {
    approx(rig.angles[id][0], want[id][0], 1e-9, `${id} flex`);
    assert.equal(rig.angles[id][1], id === "L3" ? 3 : 0, "the channels that were not given stay");
  }
  assert.deepEqual(regionTotals(rig.angles, "lumbar").map((v) => Math.round(v * 1e6) / 1e6), [40, 3, 0]);
  assert.deepEqual(r.applied, [40, 3, 0]);
  const over = ed.setRegion("lumbar", [100, 0, 0]);
  assert.deepEqual(over.clamped, [{ joint: "lumbar", dof: "flex", requested: 100, applied: 60 }]);
  approx(ed.regionTotals("lumbar")[0], 60, 1e-9);
  ed.setRegion("thoracic", [10, -5, 20]);
  assert.deepEqual(ed.regionTotals("thoracic").map((v) => Math.round(v * 1e6) / 1e6), [10, -5, 20]);
  ed.setRegion("cervical", [-30, 0, 0]);
  approx(ed.regionTotals("cervical")[0], -30, 1e-9);
  ed.setOption("enforceRom", false);
  ed.setRegion("lumbar", [100, 0, 0]);
  approx(ed.regionTotals("lumbar")[0], 100, 1e-9, "not enforced: the total goes beyond the ranges of the vertebrae");
  assert.ok(ed.info().romViolations.some((v) => /L[1-5]/.test(v.joint)));
  assert.throws(() => ed.setRegion("sacral", [1, 0, 0]), /unknown spine region/);
  assert.throws(() => ed.setRegion("lumbar", [NaN, 0, 0]), /finite/);
  assert.throws(() => ed.setRegion("__proto__", [1]), /unknown spine region/);
});

test("setRoot: orientation, heading about the anchor, and positions only when the placement is free", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const y0 = rig.root.y;
  ed.setRoot({ flex: 10, lat: -5, rot: 3 });
  assert.deepEqual([rig.root.flex, rig.root.lat, rig.root.rot], [10, -5, 3]);
  const a0 = ed.place.anchor.x, x0 = rig.root.x;
  ed.setRoot({ y: 5, x: 0.4 });
  approx(rig.root.y, y0, 0.2, "the height is the support's, not the caller's");
  assert.notEqual(rig.root.y, 5);
  approx(ed.place.anchor.x, a0 + 0.4 - x0, 1e-12, "x moves the figure: the anchor moves with it");
  approx(rig.root.x, 0.4, 1e-9, "... and the pelvis is where it was asked to be");
  ed.setHeading(90);
  assert.equal(rig.root.heading, 90);
  assert.equal(ed.place.heading, 90);
  ed.setHeading(-170);
  assert.equal(rig.root.heading, -170);
  ed.setMode("free");
  ed.setRoot({ y: 1.2, x: 1, z: 2 });
  assert.deepEqual([rig.root.x, rig.root.y, rig.root.z], [1, 1.2, 2]);
  ed.setJoint("hip_L", "flex", 60);
  assert.equal(rig.root.y, 1.2, "free: nothing re-grounds");
  assert.throws(() => ed.setRoot({ bogus: 1 }), /unknown root field/);
  assert.throws(() => ed.setRoot({ flex: NaN }), /finite/);
});

test("grips: presets per hand, recognised again, finger curl between the open hand and the fist, single finger joints", () => {
  const { rig, ed } = setup();
  ed.setGrip("R", "fist");
  assert.equal(ed.gripOf("R"), "fist");
  assert.equal(ed.gripOf("L"), null);
  assert.deepEqual(rig.angles.index_pip_R, [102]);
  assert.deepEqual(rig.angles.index_pip_L, [0], "the other hand is untouched");
  ed.setGrip("L", "open");
  assert.equal(ed.gripOf("L"), "open");
  const r = ed.setFingerCurl("R", "index", 0);
  assert.ok(Math.abs(r.curl) < 1e-9);
  assert.equal(ed.gripOf("R"), null, "one finger open: no longer a preset");
  ed.setFingerCurl("R", "index", 0.5);
  approx(rig.angles.index_pip_R[0], 51, 1e-9);
  approx(ed.fingerCurl("R", "index"), 0.5, 1e-9);
  ed.setFingerAngle("L", "middle_dip", 0, 45);
  assert.equal(rig.angles.middle_dip_L[0], 45);
  assert.equal(rig.angles.middle_dip_R[0], 70, "the other hand (a fist) is untouched");
  assert.throws(() => ed.setGrip("R", "no-such-grip"), /unknown grip/);
  assert.throws(() => ed.setGrip("X", "fist"), /side/);
  assert.throws(() => ed.setFingerCurl("R", "toe", 1), /unknown finger/);
  assert.throws(() => ed.setFingerAngle("R", "wrist", 0, 1), /unknown finger joint/);
});

test("mirror and copySide: left and right exchange (twice is the identity), the heading offset of the placement stays", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  ed.setHeading(30);
  ed.setJoint("shoulder_R", "flex", 80);
  ed.setJoint("hip_L", "flex", 40);
  ed.setJoint("head", "rot", 6);
  ed.setJoint("eye_L", "azim", 12);
  ed.setRegion("thoracic", [0, 0, 20]);
  const before = rig.getPose();
  ed.mirror();
  assert.deepEqual(rig.angles.shoulder_L, [80, 0, 0]);
  assert.deepEqual(rig.angles.hip_R[0], 40);
  assert.equal(rig.angles.head[2], -6);
  assert.equal(rig.root.heading, 30, "the figure does not turn");
  approx(ed.regionTotals("thoracic")[2], -20, 1e-9);
  ed.mirror();
  for (const [id, a] of Object.entries(before.angles)) a.forEach((v, i) => approx(rig.angles[id][i], v, 1e-9, `${id}[${i}] after mirroring twice`));
  ed.copySide("R");
  assert.deepEqual(rig.angles.shoulder_L, rig.angles.shoulder_R);
  assert.deepEqual(rig.angles.hip_L, rig.angles.hip_R);
  assert.throws(() => ed.copySide("X"), /copySide/);
});

test("neutral and resetToLibrary: neutral standing; reset goes back to the posture the pose started from and keeps the placement", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-sitting", { animate: false });
  ed.setSeatHeight(0.5);
  ed.setJoint("shoulder_R", "flex", 90);
  ed.resetToLibrary();
  assert.equal(ed.modified, false);
  assert.deepEqual(rig.angles.shoulder_R, [0, 0, 0]);
  assert.equal(ed.place.seat.kind, "height", "the seat the user chose stays");
  ed.neutral();
  assert.equal(ed.base.kind, "neutral");
  assert.deepEqual(ed.place.mode, "floor");
  assert.ok(poseEquals(rel(rig), { root: { heading: 0, flex: 0, lat: 0, rot: 0 }, angles: {} }, 1e-9));
  ed.setJoint("elbow_L", 0, 50);
  ed.resetToLibrary();
  assert.equal(rig.angles.elbow_L[0], 0, "reset of a neutral base is neutral");
});

// ---- history --------------------------------------------------------------------------------------------------------------------------------------
test("history: undo and redo restore the pose AND the placement; a new edit clears the redo; labels say what a step was", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-sitting", { animate: false });
  const afterApply = rig.getPose(), placeA = ed.place;
  ed.setSeatHeight(0.55);
  ed.setAnchor({ x: 0.3, z: 0.2 });
  ed.setHeading(25);
  ed.setJoint("elbow_R", 0, 70);
  assert.equal(ed.history.steps, 5);
  assert.equal(ed.history.undoLabel, "Edit Right elbow: Flexion / extension");
  const full = rig.getPose(), placeFull = ed.place;
  for (let i = 0; i < 4; i++) assert.ok(ed.undo());
  assert.deepEqual(rig.getPose(), afterApply, "undo restores the pose exactly");
  assert.deepEqual(ed.place, placeA, "... and the support, the seat, the anchor and the heading");
  assert.ok(ed.canRedo);
  for (let i = 0; i < 4; i++) assert.ok(ed.redo());
  assert.deepEqual(rig.getPose(), full);
  assert.deepEqual(ed.place, placeFull);
  assert.equal(ed.redo(), false);
  ed.undo(); ed.undo();
  ed.setJoint("wrist_R", 0, 20);
  assert.equal(ed.canRedo, false, "a new edit clears the redo");
  assert.equal(ed.redo(), false);
  while (ed.undo());
  assert.equal(ed.history.index, 0);
  assert.equal(ed.base.kind, "neutral", "all the way back: the state before the first edit");
  assert.equal(ed.place.mode, "floor");
  assert.equal(ed.undo(), false);
});

test("history: a gesture (a slider drag, a handle drag) is ONE step; edits of one control within 600 ms merge; the history is bounded to 200 steps", () => {
  const { rig, ed, clock } = setup();
  const g = ed.beginGesture("Drag the elbow slider", "joint:elbow_R:0");
  for (let v = 10; v <= 90; v += 10) ed.setJoint("elbow_R", 0, v, { record: false });
  ed.setJoint("elbow_R", 0, 95); // record true inside a gesture: still one step
  assert.equal(ed.history.steps, 0, "nothing recorded while the gesture runs");
  g.end();
  assert.equal(ed.history.steps, 1);
  assert.equal(ed.history.undoLabel, "Drag the elbow slider");
  ed.undo();
  assert.equal(rig.angles.elbow_R[0], 0);
  ed.redo();
  // keystrokes on one control: merged while they come within 600 ms
  for (let i = 0; i < 5; i++) { ed.setJoint("shoulder_R", "flex", 10 + i); clock.advance(100); }
  assert.equal(ed.history.steps, 2, "five quick edits of one control: one step");
  clock.advance(2000);
  ed.setJoint("shoulder_R", "flex", 30);
  assert.equal(ed.history.steps, 3, "a pause starts a new step");
  ed.setJoint("shoulder_L", "flex", 30);
  assert.equal(ed.history.steps, 4, "another control: a new step");
  // record: false then commit
  ed.setJoint("hip_L", "flex", 20, { record: false });
  ed.setJoint("hip_L", "flex", 25, { record: false });
  assert.equal(ed.history.steps, 4);
  ed.commit("Hip");
  assert.equal(ed.history.steps, 5);
  // the bound
  for (let i = 0; i < 300; i++) { clock.advance(1000); ed.setJoint("knee_L", "flex", i % 100); }
  assert.equal(ed.history.steps, MAX_HISTORY);
  let n = 0;
  while (ed.undo()) n++;
  assert.equal(n, MAX_HISTORY, "exactly 200 steps can be undone");
  assert.equal(ed.canUndo, false);
});

test("history: undo of an apply goes back to the previous posture; a different body restores the pose and re-grounds it", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  ed.apply("iso-7250-sitting", { animate: false });
  ed.undo();
  assert.equal(ed.base.id, "iso-7250-standing");
  assert.ok(Math.abs(rig.lowestY()) < 1e-9);
  ed.redo();
  assert.equal(ed.base.id, "iso-7250-sitting");
  assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-9);
});

// ---- stick to support -----------------------------------------------------------------------------------------------------------------------------
test("stay on the support: bending the trunk, the hips or the pelvis never lifts the figure off the floor or its seat, and the support stays at the anchor", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  ed.setAnchor({ x: 0.25, z: -0.4 });
  const anchorOf = (set) => { const pts = rig.contactPoints(set); return [pts.reduce((t, p) => t + p.x, 0) / pts.length, pts.reduce((t, p) => t + p.z, 0) / pts.length]; };
  for (const edit of [() => ed.setRegion("lumbar", [60, 0, 0]), () => ed.setRegion("thoracic", [30, 0, 0]), () => ed.setJoint("hip_L", "flex", 60, { symmetric: true }), () => ed.setJoint("knee_L", "flex", 80, { symmetric: true }), () => ed.setRoot({ flex: 20 }), () => ed.setJoint("ankle_L", "dorsi", 30), () => ed.setHeading(70)]) {
    edit();
    approx(primaryClearance(ed, rig), 0, 1e-9, "feet on the floor");
    const [cx, cz] = anchorOf("feet");
    approx(cx, 0.25, 1e-9, "feet centroid x at the anchor");
    approx(cz, -0.4, 1e-9, "feet centroid z at the anchor");
  }
  // seated: the sit bones stay on the seat plane
  ed.apply("iso-7250-sitting", { animate: false });
  const seat = ed.seatHeight();
  for (const edit of [() => ed.setRegion("lumbar", [-20, 0, 0]), () => ed.setRoot({ flex: 15 }), () => ed.setJoint("hip_L", "flex", 110, { symmetric: true }), () => ed.setRoot({ lat: 8 })]) {
    edit();
    approx(Math.min(...rig.contactPoints("seat").map((p) => p.y)), seat, 1e-9, "sit bones on the seat plane");
    assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-9);
  }
  // switched off, nothing re-grounds, and the readouts show the gap
  ed.setStick(false);
  const y = rig.root.y;
  ed.setRoot({ flex: -15 });
  ed.setJoint("hip_L", "flex", 40, { symmetric: true });
  assert.equal(rig.root.y, y);
  assert.ok(Math.abs(ed.info().gaps.feet) > 0.005, "the feet no longer touch the floor and the readout says so");
  ed.setStick(true);
  approx(primaryClearance(ed, rig), 0, 1e-9, "switching it on grounds the figure at once");
  // lying
  ed.apply("lie-supine", { animate: false });
  ed.setJoint("hip_L", "flex", 80, { symmetric: true });
  assert.ok(Math.abs(rig.lowestY()) < 0.01);
  assert.ok(rig.lowestY() > -0.01);
});

test("a seat height of the user is kept for the next sitting posture; the floor mode sits on the floor; the free mode does not ground", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-sitting", { animate: false });
  ed.setSeatHeight(0.6);
  approx(Math.min(...rig.contactPoints("seat").map((p) => p.y)), 0.6, 1e-9);
  assert.equal(ed.place.mode, "seat");
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(ed.place.mode, "floor");
  ed.apply("iso-7250-sitting", { animate: false });
  assert.equal(ed.place.mode, "seat");
  approx(ed.seatHeight(), 0.6, 1e-12);
  ed.setMode("floor");
  approx(Math.min(...rig.contactPoints("seat").map((p) => p.y)), 0, 1e-9, "floor mode: sitting on the floor");
  ed.useSeatOfPosture();
  ed.setMode("seat");
  assert.ok(ed.seatHeight() < 0.5, "back to the popliteal height of the posture");
  ed.setMode("free");
  const y = rig.root.y;
  ed.setJoint("hip_L", "flex", 20, { symmetric: true });
  assert.equal(rig.root.y, y);
  assert.throws(() => ed.setMode("sky"), /mode is/);
  assert.throws(() => ed.setSeatHeight(2), /seat height/);
  assert.throws(() => ed.setSeatHeight(NaN), /seat height/);
  assert.throws(() => ed.setSupport("toString"), /unknown support/);
  ed.setSupport("knees");
  assert.equal(ed.place.support, "knees");
});

// ---- the chair of the sandbox ----------------------------------------------------------------------------------------------------------------------
function fakeSandbox() {
  const sb = { y: 0.42, centre: [0.1, 0.6], yaw: 0, visible: true };
  const box = (c, hw = 0.2) => [[c[0] - hw, c[1] - hw], [c[0] + hw, c[1] - hw], [c[0] + hw, c[1] + hw], [c[0] - hw, c[1] + hw]];
  sb.objects = new Map([["o1", { id: "o1", yaw: 0 }]]);
  sb.supportsWorld = () => (sb.visible ? [
    { objectId: "o1", id: "seat", name: "Cabin seat: Seat pan", y: sb.y, polygon: box(sb.centre), size: [0.4, 0.4], pitch: 0 },
    { objectId: "o2", id: "foot_ring", name: "Stool: Foot ring", y: 0.2, polygon: box([2, 2]), size: [0.4, 0.4], pitch: 0 },
    { objectId: "o3", id: "tread", name: "Step: Tread", y: 0.15, polygon: box([3, 2]), size: [0.4, 0.4], pitch: 0 },
    { objectId: "o4", id: "seat", name: "Stool: Seat", y: 1.2, polygon: box([4, 2]), size: [0.4, 0.4], pitch: 0 },
  ] : []);
  return sb;
}
test("sitting on a surface of the sandbox: the figure goes to it, faces the way it faces, follows it when it moves, turns, is adjusted or removed", () => {
  const sb = fakeSandbox(), handlers = new Map(), toasts = [];
  const ctx = { state: { sandbox: sb }, on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e); }, toast: (t) => toasts.push(t), setPosture() {} };
  const { rig, ed } = setup(MAN, { ctx });
  assert.deepEqual(seatSurfaces(sb).map((s) => `${s.objectId}:${s.id}`), ["o1:seat"], "only seat-like surfaces at a sitting height");
  ed.apply("iso-7250-sitting", { animate: false });
  assert.equal(ed.sitOn("o9", "seat"), false);
  assert.equal(ed.sitOn("o1", "seat"), true);
  assert.equal(ed.place.seat.kind, "object");
  approx(ed.place.anchor.x, 0.1, 1e-9);
  approx(ed.place.anchor.z, 0.6, 1e-9);
  approx(Math.min(...rig.contactPoints("seat").map((p) => p.y)), 0.42, 1e-9);
  const seatCentre = () => { const pts = rig.contactPoints("seat"); return [pts.reduce((t, p) => t + p.x, 0) / pts.length, pts.reduce((t, p) => t + p.z, 0) / pts.length]; };
  approx(seatCentre()[0], 0.1, 1e-9); approx(seatCentre()[1], 0.6, 1e-9);
  // the chair moves, is raised
  sb.centre = [0.5, 0.9]; sb.y = 0.48;
  handlers.get("scene")({ op: "move" });
  approx(Math.min(...rig.contactPoints("seat").map((p) => p.y)), 0.48, 1e-9);
  approx(seatCentre()[0], 0.5, 1e-9); approx(seatCentre()[1], 0.9, 1e-9);
  // turned by 90 degrees about its centre: the figure turns with it
  sb.yaw = 90; sb.objects.get("o1").yaw = 90;
  handlers.get("scene")({ op: "move" });
  approx(rig.root.heading, 90, 1e-9);
  approx(seatCentre()[0], 0.5, 1e-9); approx(seatCentre()[1], 0.9, 1e-9);
  // undo: the figure is back where it was (history holds the placement, and the chair is looked up again)
  ed.undo();
  assert.equal(ed.place.seat.kind === "object" || ed.place.seat.kind === "auto", true);
  // removed: the height stays and the user is told
  ed.sitOn("o1", "seat");
  sb.visible = false;
  handlers.get("scene")({ op: "remove" });
  assert.equal(ed.place.seat.kind, "height");
  assert.ok(toasts.some((t) => /removed/.test(t)));
  approx(ed.seatHeight(), 0.48, 1e-9);
});

// ---- animation --------------------------------------------------------------------------------------------------------------------------------------
test("animation: a blend over 350 ms that ends exactly on the target, stays inside the ranges and above the floor, and is finished by any edit", async () => {
  const { rig, ed, clock } = setup(MAN, { animated: true, reducedMotion: () => false });
  ed.apply("iso-7250-standing", { animate: false });
  const target = expanded(POSTURES.find((p) => p.id === "lie-supine"));
  const res = ed.apply("lie-supine");
  assert.equal(ed.animating, true);
  assert.ok(clock.pending > 0);
  let frames = 0, minLow = 0;
  while (ed.animating && frames < 100) {
    clock.flush(16);
    frames++;
    const cur = rig.getPose();
    assert.equal(clampPose({ root: orient(cur.root), angles: cur.angles }).clamped.length, 0, "every frame is inside the ranges of motion");
    minLow = Math.min(minLow, rig.lowestY());
  }
  assert.ok(frames >= 20 && frames <= 26, `350 ms of frames, got ${frames}`);
  assert.equal(await res.done, "done");
  assert.ok(poseEquals(rel(rig), target.pose, 1e-12), "ends exactly on the target");
  assert.ok(minLow > -0.006, `never dips through the floor on its way (${minLow})`);
  assert.equal(ed.history.steps, 2, "the step is recorded once, at the start");
  // an edit while it runs finishes it first, the edit lands on the target
  ed.apply("iso-7250-standing");
  clock.flush(100);
  assert.equal(ed.animating, true);
  ed.setJoint("elbow_R", 0, 33);
  assert.equal(ed.animating, false);
  assert.equal(rig.angles.elbow_R[0], 33);
  assert.equal(Math.abs(rig.root.flex), 0);
  // undo while it runs
  ed.apply("lie-supine");
  clock.flush(50);
  ed.undo();
  assert.equal(ed.animating, false);
  // cancelAnimation({ finish: false }) leaves it where it is
  ed.apply("iso-7250-standing");
  clock.flush(80);
  const mid = rig.getPose();
  ed.cancelAnimation({ finish: false });
  assert.deepEqual(rig.getPose(), mid);
  assert.equal(ed.animating, false);
  clock.flush(1000);
  assert.deepEqual(rig.getPose(), mid, "no frame runs after the cancel");
});

test("animation: the shell is told the posture's name, not \"(edited)\", once the figure has arrived", async () => {
  const posted = [], ctx = { setPosture: (p) => posted.push(p), on: () => () => {}, state: {} };
  const { ed, clock } = setup(MAN, { animated: true, reducedMotion: () => false, ctx });
  ed.apply("iso-7250-standing", { animate: false });
  const res = ed.apply("lie-supine");
  clock.flush(100);
  assert.equal(posted.at(-1).id, "lie-supine", "on its way the shell already names the posture it is going to, never \"(edited)\"");
  clock.flush(1000);
  assert.equal(await res.done, "done");
  assert.deepEqual(posted.at(-1), { id: "lie-supine", name: ed.base.name });
  ed.setJoint("elbow_R", 0, 33);
  assert.equal(posted.at(-1).id, null);
  assert.match(posted.at(-1).name, /\(edited\)$/);
});

test("animation: skipped with animate false, with the option off, under reduced motion, and without a frame scheduler; a pose that is already there is not animated", async () => {
  const a = setup(MAN, { animated: true, reducedMotion: () => true });
  a.ed.apply("iso-7250-sitting");
  assert.equal(a.ed.animating, false);
  assert.equal(await a.ed.apply("iso-7250-standing").done, "done");
  const b = setup(MAN, { animated: true, reducedMotion: () => false });
  b.ed.setOption("animate", false);
  b.ed.apply("iso-7250-sitting");
  assert.equal(b.ed.animating, false);
  b.ed.setOption("animate", true);
  b.ed.apply("iso-7250-standing", { animate: false });
  assert.equal(b.ed.animating, false);
  b.ed.apply("iso-7250-standing");
  assert.equal(b.ed.animating, false, "already there");
  const c = setup(MAN, { animated: false });
  c.ed.apply("iso-7250-sitting");
  assert.equal(c.ed.animating, false);
});

// ---- custom postures --------------------------------------------------------------------------------------------------------------------------------
test("custom postures: save, list in a new session, apply, overwrite, delete; ids are unique and prefixed", async () => {
  const storage = memStorage();
  const a = setup(MAN, { storage });
  a.ed.apply("iso-7250-sitting", { animate: false });
  a.ed.setJoint("shoulder_R", "flex", 75);
  a.ed.setJoint("eye_L", "azim", 14, { symmetric: true });
  a.ed.setSeatHeight(0.5);
  a.ed.setGrip("R", "point");
  const r1 = await a.ed.saveCustom("My reach", { category: "Reaching" });
  assert.deepEqual([r1.ok, r1.id, r1.persistent], [true, "custom-my-reach", true]);
  assert.equal(a.ed.base.kind, "custom");
  assert.equal(a.ed.modified, false);
  const r2 = await a.ed.saveCustom("My reach");
  assert.equal(r2.id, "custom-my-reach-2", "same name: a second id");
  const r3 = await a.ed.saveCustom("   ");
  assert.equal(r3.ok, false);
  const r4 = await a.ed.saveCustom("日本語");
  assert.equal(r4.id, "custom-posture");
  const stored = JSON.parse(storage.m.get(STORAGE_KEY));
  assert.equal(stored.version, 1);
  assert.equal(stored.postures.length, 3);
  assert.ok(stored.postures.every((p) => /^custom-/.test(p.id)));
  assert.equal(stored.postures[0].category, "Reaching");
  assert.equal(stored.postures[0].support, "seat+feet");
  assert.equal(stored.postures[0].hints.seat.height, 0.5);
  // a new session: the posture is there and gives the same pose
  const b = setup(MAN, { storage });
  assert.deepEqual(b.ed.listCustom().map((p) => p.id), ["custom-my-reach", "custom-my-reach-2", "custom-posture"]);
  b.ed.apply("custom-my-reach", { animate: false });
  assert.equal(b.ed.base.kind, "custom");
  assert.equal(b.rig.angles.shoulder_R[0], 75);
  assert.deepEqual([b.rig.angles.eye_L[1], b.rig.angles.eye_R[1]], [14, -14], "the eyes survive the round trip in their convention");
  approx(b.ed.seatHeight(), 0.5, 1e-9);
  assert.equal(b.ed.gripOf("R"), "point");
  for (const [id, arr] of Object.entries(a.rig.getPose().angles)) arr.forEach((v, i) => approx(b.rig.angles[id][i], v, 1e-5, `${id}[${i}]`));
  // overwrite and delete
  b.ed.setJoint("elbow_L", 0, 40);
  const r5 = await b.ed.saveCustom("Renamed", { overwrite: "custom-my-reach" });
  assert.equal(r5.id, "custom-my-reach");
  assert.equal(b.ed.listCustom().length, 3);
  assert.equal(b.ed.listCustom()[0].name, "Renamed");
  assert.equal(b.ed.deleteCustom("custom-my-reach-2"), true);
  assert.equal(b.ed.deleteCustom("custom-my-reach-2"), false);
  assert.equal(b.ed.deleteCustom("iso-7250-standing"), false, "a library posture cannot be deleted");
  assert.deepEqual(b.ed.listCustom().map((p) => p.id), ["custom-my-reach", "custom-posture"]);
  // the list is a copy
  b.ed.listCustom()[0].name = "hacked";
  assert.equal(b.ed.listCustom()[0].name, "Renamed");
});

test("custom postures: corrupt JSON, the wrong shape, hostile entries, unknown keys and too much text give a shorter list, never an exception", () => {
  const polluted = () => ({}).polluted === undefined && Object.prototype.polluted === undefined;
  const ok = { id: "custom-ok", name: "Ok", support: "feet", joints: { elbow_LR: [30] } };
  const cases = {
    "not json": "{{{", "a number": "42", "null": "null", "a string": '"x"', "wrong shape": '{"postures": 5}', "no list": "{}",
    "proto key": '{"postures":[{"id":"custom-x","name":"x","support":"feet","joints":{"__proto__":[1],"constructor":[2]}}]}',
    "wrong id": JSON.stringify({ postures: [{ ...ok, id: "constructor" }, { ...ok, id: "custom-A B" }, { ...ok, id: 5 }, { ...ok, id: "custom-" + "x".repeat(80) }] }),
    "bad support": JSON.stringify({ postures: [{ ...ok, support: "toString" }, { ...ok, support: "nope" }] }),
    "bad angles": JSON.stringify({ postures: [{ ...ok, joints: { elbow_LR: [1e9] } }, { ...ok, joints: { elbow_LR: ["a"] } }, { ...ok, joints: { elbow_LR: [] } }, { ...ok, joints: { elbow_LR: [1, 2, 3, 4] } }, { ...ok, joints: { pelvis: [1] } }, { ...ok, joints: { nope: [1] } }] }),
    "bad root": JSON.stringify({ postures: [{ ...ok, root: { heading: "a" } }, { ...ok, root: { flex: 1e9 } }, { ...ok, root: [] }] }),
    "bad entries": JSON.stringify({ postures: [null, 5, "x", [], {}, { id: "custom-q" }] }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = parseCustomStore(text);
    assert.deepEqual(r.postures, [], `${name}: nothing survives`);
    assert.ok(polluted(), `${name}: Object.prototype is untouched`);
  }
  // a pollution attempt: the posture itself is fine and survives, without the hostile parts
  const pol = parseCustomStore('{"__proto__":{"polluted":1},"postures":[{"id":"custom-x","name":"x","support":"feet","root":{"__proto__":{"polluted":1},"flex":5},"hints":{"__proto__":{"polluted":1},"dynamic":true},"joints":{"elbow_LR":[3]},"constructor":{"prototype":{"polluted":2}}}]}');
  assert.equal(pol.postures.length, 1);
  assert.deepEqual(pol.postures[0].root, { flex: 5 });
  assert.deepEqual(pol.postures[0].hints, { dynamic: true });
  assert.equal(Object.hasOwn(pol.postures[0], "constructor"), false);
  assert.ok(polluted(), "Object.prototype is untouched");
  // one good entry among bad ones survives, extra keys are dropped, text is cleaned
  const mixed = JSON.stringify({ postures: [null, { ...ok, name: " Ok\u0000 \n pose ", evil: { a: 1 }, tags: ["a", 5, "UPPER", "fine"], description: "x".repeat(900), category: "Nonsense" }, ok, { ...ok, id: "custom-ok2", hints: { seat: { height: 9 }, load: { mass: 999 }, dynamic: "yes" } }] });
  const r = parseCustomStore(mixed);
  assert.deepEqual(r.postures.map((p) => p.id), ["custom-ok", "custom-ok2"], "a duplicate id is dropped");
  assert.equal(r.postures[0].name, "Ok pose");
  assert.equal(Object.hasOwn(r.postures[0], "evil"), false);
  assert.deepEqual(r.postures[0].tags, ["a", "fine"]);
  assert.equal(r.postures[0].description.length, 400);
  assert.equal(r.postures[0].category, "Reference");
  assert.equal(r.postures[1].hints, undefined, "invalid hints are dropped, not trusted");
  assert.ok(r.problems.length >= 2);
  assert.deepEqual(sanitizePosture({ ...ok, root: { x: 5, flex: 2 } }).root, { flex: 2 }, "a position is dropped: a posture has none");
  assert.equal(sanitizePosture({ ...ok }).support, "feet");
  assert.throws(() => sanitizePosture({ ...ok, id: "plain-id" }), /bad id/);
  assert.equal(sanitizePosture({ ...ok, id: "plain-id" }, { custom: false }).id, "plain-id");
  // too much text, too many entries
  assert.deepEqual(parseCustomStore("x".repeat(MAX_CUSTOM_BYTES * 2)).postures, []);
  const many = Array.from({ length: 150 }, (_, i) => ({ ...ok, id: `custom-n${i}` }));
  const m = parseCustomStore(JSON.stringify({ postures: many }));
  assert.equal(m.postures.length, MAX_CUSTOM);
  assert.ok(m.problems.some((p) => /first 100/.test(p)));
  // through an editor: a corrupt store means an empty list and a note
  const { ed } = setup(MAN, { storage: memStorage({ [STORAGE_KEY]: "{{{" }) });
  assert.deepEqual(ed.listCustom(), []);
  assert.ok(ed.customProblems().length >= 1);
  assert.throws(() => ed.apply("custom-ok"), /unknown posture/);
});

test("custom postures: storage that throws (blocked, quota) keeps them for the session and says so; the limits of 100 postures and 200 kB hold", async () => {
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); } };
  const a = setup(MAN, { storage: bad });
  assert.deepEqual(a.ed.listCustom(), []);
  const r = await a.ed.saveCustom("Session only");
  assert.equal(r.ok, true);
  assert.equal(r.persistent, false);
  assert.match(r.warning, /until the page is closed/);
  assert.equal(a.ed.listCustom().length, 1);
  assert.equal(a.ed.customPersistent, false);
  const none = setup(MAN, { storage: null });
  assert.equal((await none.ed.saveCustom("No storage")).persistent, false);
  // a store that was written by another tab is read again
  const st = memStorage();
  const t1 = setup(MAN, { storage: st }), t2 = setup(MAN, { storage: st });
  await t1.ed.saveCustom("From tab one");
  assert.deepEqual(t2.ed.listCustom().map((p) => p.id), ["custom-from-tab-one"]);
  // 200 kB: heavy poses (every joint non-zero) until the store is full
  const h = setup(MAN, { storage: memStorage() });
  const rnd = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const angles = {};
  for (const j of JOINTS) if (j.id !== "pelvis") angles[j.id] = j.dof.map((d) => +(d.min * 0.2 + rnd() * (d.max - d.min) * 0.2).toFixed(4));
  h.ed.setPose({ angles }, { clamp: true });
  let saved = 0, last = null;
  for (let i = 0; i < MAX_CUSTOM + 5; i++) {
    last = await h.ed.saveCustom(`Heavy ${i}`);
    if (!last.ok) break;
    saved++;
  }
  assert.equal(last.ok, false);
  assert.match(last.error, /kB|At most/);
  assert.ok(saved >= 10 && saved <= MAX_CUSTOM, `${saved} heavy postures`);
  assert.ok(h.storage.m.get(STORAGE_KEY).length <= MAX_CUSTOM_BYTES, "the stored text never exceeds the limit");
  assert.equal(h.ed.listCustom().length, saved, "a refused save changes nothing");
  // 100 small ones
  const s = setup(MAN, { storage: memStorage() });
  let n = 0;
  for (; n < MAX_CUSTOM + 3; n++) { const r2 = await s.ed.saveCustom(`P${n}`); if (!r2.ok) break; }
  assert.equal(n, MAX_CUSTOM);
  assert.match((await s.ed.saveCustom("one more")).error, /At most 100/);
  assert.equal((await s.ed.saveCustom("P3", { overwrite: "custom-p3" })).ok, true, "overwriting works when the list is full");
});

test("posture files: export is the Export tab's file, import reads it back (also a bare posture, a bare pose); a bad file changes nothing", async () => {
  const profile = { id: "p", label: "Test profile" };
  const ctx = { getProfile: () => profile, state: { posture: { id: "iso-7250-sitting", name: "Seated" } }, on: () => () => {} };
  const a = setup(MAN, { ctx });
  a.ed.apply("iso-7250-sitting", { animate: false });
  a.ed.setJoint("shoulder_R", "flex", 66);
  a.ed.setJoint("eye_L", "azim", 9, { symmetric: true });
  const file = await a.ed.exportPosture();
  assert.equal(file.app, "digital-human-posture");
  assert.equal(file.pose.angles.shoulder_R[0], 66);
  const text = await a.ed.exportPostureText();
  assert.equal((await parsePostureFile(text)).ok, true);
  const b = setup(MAN);
  const imp = await b.ed.importPosture(text);
  assert.equal(imp.ok, true, JSON.stringify(imp));
  assert.equal(b.ed.base.kind, "imported");
  for (const [id, arr] of Object.entries(a.rig.getPose().angles)) arr.forEach((v, i) => approx(b.rig.angles[id][i], v, 1e-5, `${id}[${i}]`));
  assert.equal(b.ed.place.support, "seat+feet");
  assert.ok(Math.abs(primaryClearance(b.ed, b.rig)) < 1e-9);
  assert.equal(b.ed.history.steps, 1);
  // bare posture and bare pose, with a File-like object
  const bare = await b.ed.importPosture({ text: async () => JSON.stringify({ id: "x-pose", name: "X pose", support: "feet", joints: { hip_LR: [20] } }) });
  assert.equal(bare.ok, true);
  assert.equal(b.rig.angles.hip_R[0], 20);
  const pose = await b.ed.importPosture(JSON.stringify({ root: { heading: 10 }, angles: { knee_L: [200] } }));
  assert.equal(pose.ok, true);
  assert.equal(b.rig.angles.knee_L[0], 160, "clamped to the range, and said so");
  assert.ok(pose.warnings.length >= 1);
  // save on import
  const kept = await b.ed.importPosture(text, { save: true });
  assert.equal(kept.saved.ok, true);
  // bad files
  const before = JSON.stringify(b.rig.getPose());
  for (const bad of ["{{{", "[]", "42", '{"app":"other"}', '{"angles":{"bogus":[1]}}', JSON.stringify({ id: "x", joints: { bogus_LR: [1] } }), "x".repeat(2_100_000), { text: async () => { throw new Error("denied"); } }]) {
    const res = await b.ed.importPosture(bad);
    assert.equal(res.ok, false);
    assert.ok(res.errors.length >= 1);
  }
  assert.equal(JSON.stringify(b.rig.getPose()), before, "nothing changed");
});

// ---- readouts ----------------------------------------------------------------------------------------------------------------------------------------
test("info(): ROM violations by joint, the balance rule with its margin, support gaps, key angles from metrics.js, ergonomic flags", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  let info = ed.info();
  assert.deepEqual(info.romViolations, []);
  assert.equal(info.balance.applies, true);
  assert.equal(info.balance.inside, true);
  assert.equal(info.balance.status, "ok");
  assert.ok(info.balance.margin > 0.04 && info.balance.margin < 0.12, `margin ${info.balance.margin}`);
  approx(info.gaps.feet, 0, 1e-9);
  const trunk = info.angles.find((a) => a.key === "trunkInclination");
  assert.ok(Math.abs(trunk.value + 0.5) < 0.3, "neutral trunk inclination is about -0.5 degrees (METRICS.md)");
  assert.equal(trunk.unit, "deg");
  assert.ok(Array.isArray(info.flags) && info.flags.every((f) => f.id && f.severity));
  assert.deepEqual(info.grips, { L: "relaxed", R: "relaxed" });
  // lean forward: the weight leaves the feet
  ed.setRoot({ flex: 14 });
  info = ed.info();
  assert.equal(info.balance.inside, false);
  assert.ok(info.balance.margin < 0);
  assert.ok(["edge", "falls"].includes(info.balance.status));
  // sitting on a seat: the rule is not applied
  ed.apply("iso-7250-sitting", { animate: false });
  assert.equal(ed.info().balance.applies, true, "seat+feet: the feet and sit bones are carriers");
  ed.setSupport("seat");
  assert.equal(ed.info().balance.applies, false);
  assert.match(ed.info().balance.reason, /seat/i);
  ed.setSupport("seat+feet");
  // a seat above the feet: the feet float and the readout says by how much
  ed.setSeatHeight(0.6);
  approx(ed.info().gaps.feet, 0.6 - ed.info().gaps.seat - ed.seatHeight() + (ed.seatHeight() - 0.43), 0.2, "feet gap exists");
  assert.ok(ed.info().gaps.feet > 0.1);
  ed.setMode("free");
  assert.equal(ed.info().balance.applies, false);
  assert.deepEqual(ed.info().gaps, {});
  // a violation is named
  ed.setOption("enforceRom", false);
  ed.setJoint("knee_L", 0, 175);
  const v = ed.info().romViolations;
  assert.deepEqual(v.map((x) => [x.joint, x.dof, x.value, x.max]), [["knee_L", "flex", 175, 160]]);
  assert.match(v[0].label, /knee/i);
  // lying: the balance rule does not apply
  ed.apply("lie-supine", { animate: false });
  assert.equal(ed.info().balance.applies, false);
  void rig;
});

test("info() on a posture with hints: a dynamic or externally supported posture has no balance rule; a held load moves the margin", () => {
  const { ed } = setup();
  const dyn = POSTURES.find((p) => p.hints?.dynamic);
  if (dyn) { ed.apply(dyn.id, { animate: false }); assert.equal(ed.info().balance.applies, false); assert.match(ed.info().balance.reason, /movement/); }
  const ext = POSTURES.find((p) => p.hints?.externalSupport && !p.hints?.dynamic);
  if (ext) { ed.apply(ext.id, { animate: false }); assert.equal(ed.info().balance.applies, false); }
  assert.ok(dyn || ext, "the library has postures with hints");
});

// ---- IK ------------------------------------------------------------------------------------------------------------------------------------------------
const P = (x, y, z) => new THREE.Vector3(x, y, z);
test("IK drag of a hand: begin / move / end follows the point, ends on it, is ONE history step, and undo puts the arm back", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const before = rig.getPose(), steps = ed.history.steps;
  const feet0 = Object.fromEntries(["heel_sole_L", "heel_sole_R", "ball_sole_medial_L"].map((id) => [id, v3(rig, id)]));
  const d = ed.createDrag("palm_R", { immediate: true });
  const p0 = ed.handlePoint("palm_R");
  assert.equal(d.begin(p0), true);
  assert.equal(d.active, true);
  assert.equal(ed.dragging, true);
  const target = p0.clone().add(P(-0.25, 0.3, 0.4));
  for (let i = 1; i <= 25; i++) d.move(p0.clone().lerp(target, i / 25));
  const st = d.end();
  assert.equal(st.reachable, true);
  assert.equal(st.state, "ok");
  assert.ok(ed.handlePoint("palm_R").distanceTo(target) < 0.001, `the palm is ${ed.handlePoint("palm_R").distanceTo(target) * 1000} mm from the point`);
  assert.ok(rig.angles.elbow_R[0] > 5, "the elbow bends");
  assert.equal(ed.history.steps, steps + 1);
  assert.equal(ed.history.undoLabel, "Move right hand");
  assert.equal(ed.dragging, false);
  assert.equal(clampPose({ root: orient(rig.root), angles: rig.getPose().angles }).clamped.length, 0, "inside the ranges");
  // the feet stayed
  for (const id of ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L"]) assert.ok(v3(rig, id).distanceTo(feet0[id]) < 1e-9, `${id} stayed`);
  ed.undo();
  assert.deepEqual(rig.getPose(), before);
  assert.equal(ed.history.index, steps);
  // the left hand with a click in place changes nothing and records nothing
  const d2 = ed.createDrag("palm_L", { immediate: true });
  d2.begin(ed.handlePoint("palm_L")); d2.end();
  assert.equal(ed.history.index, steps, "a click in place records nothing");
  assert.deepEqual(rig.getPose(), before);
});

test("IK drag, unreachable: the closest pose, a red state with the shortfall in millimetres and a sentence that names the limit", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const d = ed.createDrag("palm_R", { immediate: true });
  const p0 = ed.handlePoint("palm_R");
  d.begin(p0);
  for (let i = 1; i <= 40; i++) d.move(p0.clone().add(P(0, 0, 0.03 * i)));
  const st = d.status;
  assert.equal(st.reachable, false);
  assert.equal(st.state, "short");
  assert.match(st.short, /^\d+ mm short$/);
  assert.ok(st.amount > 500);
  assert.match(st.message, /right hand/i);
  assert.match(st.message, /short of the target/);
  d.end();
  assert.equal(ed.history.steps, 2, "even an unreachable drag is one step: the figure ends on the closest pose");
  assert.equal(clampPose({ root: orient(rig.root), angles: rig.getPose().angles }).clamped.length, 0);
  assert.ok(Number.isFinite(rig.landmarkWorld("palm_centre_R").x));
});

test("IK drag: a path through the whole reach zone moves no joint by more than a few degrees per frame (no jumps), and the elbow no more than 4 cm", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const d = ed.createDrag("palm_R", { immediate: true });
  const p0 = ed.handlePoint("palm_R");
  d.begin(p0);
  let prev = rig.getPose(), prevElbow = rig.jointWorld("elbow_R").clone(), maxDeg = 0, maxElbow = 0, frames = 0;
  const pts = [];
  for (let i = 0; i <= 160; i++) { const a = (i / 160) * 2 * Math.PI; pts.push(P(-0.25 + 0.2 * Math.cos(a), 1.2 + 0.25 * Math.sin(a), 0.4 + 0.15 * Math.sin(2 * a))); }
  for (const p of pts) {
    d.move(p);
    const cur = rig.getPose();
    for (const [id, a] of Object.entries(cur.angles)) a.forEach((v, k) => { maxDeg = Math.max(maxDeg, Math.abs(v - prev.angles[id][k])); });
    const e = rig.jointWorld("elbow_R");
    maxElbow = Math.max(maxElbow, e.distanceTo(prevElbow));
    prevElbow = e.clone(); prev = cur; frames++;
  }
  d.end();
  assert.ok(maxDeg < 12, `largest change of a joint angle in one frame ${maxDeg.toFixed(1)} degrees`);
  assert.ok(maxElbow < 0.04, `largest elbow move ${(maxElbow * 1000).toFixed(0)} mm`);
  assert.equal(frames, 161);
});

test("IK drag: a hand pulled up the side of the body from a straight hanging arm does not stay stuck in the corner of the ranges (it glides to a pose that reaches)", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const T = P(-0.4265, 1.2111, -0.0267), p0 = ed.handlePoint("palm_R");
  for (const n of [12, 20, 40, 100]) {
    const d = ed.createDrag("palm_R", { immediate: true });
    d.begin(p0);
    let prev = rig.getPose(), maxDeg = 0;
    for (let i = 1; i <= n; i++) {
      d.move(p0.clone().lerp(T, i / n));
      const cur = rig.getPose();
      for (const [id, a] of Object.entries(cur.angles)) a.forEach((v, k) => { maxDeg = Math.max(maxDeg, Math.abs(v - prev.angles[id][k])); });
      prev = cur;
    }
    const st = d.end();
    assert.equal(st.state, "ok", `${n} steps: ${st.message}`);
    assert.ok(ed.handlePoint("palm_R").distanceTo(T) < 0.001, `${n} steps: ${(ed.handlePoint("palm_R").distanceTo(T) * 1000).toFixed(1)} mm off`);
    assert.ok(rig.angles.elbow_R[0] > 60, `${n} steps: the elbow bent (${rig.angles.elbow_R[0].toFixed(0)})`);
    assert.ok(maxDeg <= 12.5, `${n} steps: no frame moves a joint by more than ${maxDeg.toFixed(1)} degrees`);
    ed.undo();
  }
});

test("IK drag of the pelvis: the feet stay within 0.5 mm (bend), the figure slides on its support (move), and the support is re-read afterwards", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const ids = ["heel_sole_L", "ball_sole_medial_L", "ball_sole_lateral_L", "heel_sole_R", "ball_sole_medial_R", "ball_sole_lateral_R"];
  const base = ids.map((id) => v3(rig, id));
  const d = ed.createDrag("pelvis", { immediate: true });
  const q0 = ed.handlePoint("pelvis");
  d.begin(q0);
  for (let i = 1; i <= 40; i++) d.move(q0.clone().add(P(0, -0.005 * i, 0)));
  const st = d.end();
  approx(rig.root.y, q0.y - 0.2, 0.003, "the pelvis went down 20 cm");
  assert.equal(st.reachable, true);
  ids.forEach((id, k) => assert.ok(v3(rig, id).distanceTo(base[k]) < 0.0005, `${id} moved ${(v3(rig, id).distanceTo(base[k]) * 1000).toFixed(3)} mm`));
  assert.ok(rig.angles.knee_L[0] > 40 && rig.angles.hip_L[0] > 20, "a squat");
  assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-6);
  assert.equal(ed.history.undoLabel, "Move pelvis");
  // without the pin the feet follow nothing but the legs stay as they were
  ed.undo();
  ed.setOption("pinFeet", false);
  const d2 = ed.createDrag("pelvis", { immediate: true });
  d2.begin(ed.handlePoint("pelvis"));
  d2.move(ed.handlePoint("pelvis").add(P(0, -0.1, 0)));
  d2.end();
  ed.setOption("pinFeet", true);
  // move the whole figure
  ed.undo();
  ed.setOption("pelvisMode", "move");
  const a0 = { ...ed.place.anchor }, ang0 = JSON.stringify(rig.getPose().angles);
  const d3 = ed.createDrag("pelvis", { immediate: true });
  const r0 = ed.handlePoint("pelvis");
  d3.begin(r0);
  d3.move(r0.clone().add(P(0.3, 0.5, -0.2)));
  d3.end();
  approx(ed.place.anchor.x, a0.x + 0.3, 1e-9);
  approx(ed.place.anchor.z, a0.z - 0.2, 1e-9);
  assert.equal(JSON.stringify(rig.getPose().angles), ang0, "no joint moved");
  assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-9, "a drag up does not lift a figure that stands on the floor");
  assert.throws(() => ed.setOption("pelvisMode", "fly"), /pelvisMode/);
});

test("IK drag of a foot (the ball or the heel), pole handles (elbow, knee), the chest and the look-at target", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  // a foot: lifted and moved forward, the other stays; the support is re-read
  const fb = v3(rig, "ball_sole_medial_R"), fl = v3(rig, "heel_sole_L");
  const d = ed.createDrag("foot_L", { immediate: true }), f0 = ed.handlePoint("foot_L");
  d.begin(f0);
  for (let i = 1; i <= 20; i++) d.move(f0.clone().add(P(0, 0.006 * i, 0.012 * i)));
  assert.equal(d.end().reachable, true);
  approx(ed.handlePoint("foot_L").y, f0.y + 0.12, 0.001);
  approx(ed.handlePoint("foot_L").z, f0.z + 0.24, 0.001);
  assert.ok(v3(rig, "ball_sole_medial_R").distanceTo(fb) < 1e-6, "the other foot stays");
  assert.ok(v3(rig, "heel_sole_L").y >= -1e-9 && v3(rig, "heel_sole_L").y < ed.handlePoint("foot_L").y, "the heel stays lower than the lifted ball");
  assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-9, "the right foot is still on the floor");
  // a foot cannot go below the floor
  const d1 = ed.createDrag("foot_R", { immediate: true }), g0 = ed.handlePoint("foot_R");
  d1.begin(g0); d1.move(g0.clone().add(P(0, -0.3, 0))); d1.end();
  assert.ok(ed.handlePoint("foot_R").y > -0.002, `ball ${ed.handlePoint("foot_R").y}`);
  ed.setOption("footPoint", "heel");
  assert.ok(ed.handlePoint("foot_L").distanceTo(v3(rig, "heel_sole_L")) < 1e-9, "the heel is the handle now");
  ed.setOption("footPoint", "ball");
  // an elbow: the hand stays, the elbow swivels toward the point
  ed.apply("iso-7250-standing", { animate: false });
  ed.createDrag("palm_R", { immediate: true });
  const reach = ed.createDrag("palm_R", { immediate: true }), h0 = ed.handlePoint("palm_R");
  reach.begin(h0); for (let i = 1; i <= 20; i++) reach.move(h0.clone().lerp(P(-0.15, 1.25, 0.35), i / 20)); reach.end();
  const hand = ed.handlePoint("palm_R"), elbow = ed.handlePoint("elbow_R");
  const pole = ed.createDrag("elbow_R", { immediate: true });
  pole.begin(elbow);
  const to = elbow.clone().add(P(-0.08, 0.06, 0));
  for (let i = 1; i <= 30; i++) pole.move(elbow.clone().lerp(to, i / 30));
  pole.end();
  assert.ok(ed.handlePoint("palm_R").distanceTo(hand) < 0.002, `the hand moved ${ed.handlePoint("palm_R").distanceTo(hand) * 1000} mm`);
  assert.ok(ed.handlePoint("elbow_R").distanceTo(elbow) > 0.03, "the elbow swivelled");
  assert.ok(ed.handlePoint("elbow_R").x < elbow.x, "... outward, toward the point");
  // a knee
  ed.apply("iso-7250-standing", { animate: false });
  ed.setJoint("knee_L", 0, 40, { symmetric: true });
  const kb = v3(rig, "heel_sole_L"), knee = ed.handlePoint("knee_L"), kd = ed.createDrag("knee_L", { immediate: true });
  kd.begin(knee);
  const kt = knee.clone().add(P(0.1, 0, 0));
  for (let i = 1; i <= 20; i++) kd.move(knee.clone().lerp(kt, i / 20));
  kd.end();
  assert.ok(v3(rig, "heel_sole_L").distanceTo(kb) < 0.002, "the foot stays");
  assert.ok(ed.handlePoint("knee_L").x > knee.x + 0.01, "the knee moved outward");
  // the chest
  ed.apply("iso-7250-standing", { animate: false });
  const cd = ed.createDrag("chest", { immediate: true }), c0 = ed.handlePoint("chest");
  cd.begin(c0);
  const ct = c0.clone().add(P(0, -0.12, 0.12)); // (a point farther from the hips than the chest is cannot be reached by bending: the readout says so)
  for (let i = 1; i <= 30; i++) cd.move(c0.clone().lerp(ct, i / 30));
  cd.end();
  assert.ok(ed.handlePoint("chest").distanceTo(ct) < 0.003, `the chest is ${ed.handlePoint("chest").distanceTo(ct) * 1000} mm off`);
  assert.ok(ed.regionTotals("lumbar")[0] + ed.regionTotals("thoracic")[0] > 15, "the trunk leaned");
  assert.ok(Math.abs(primaryClearance(ed, rig)) < 1e-9, "the chest drag leaves the feet where they were, on the floor");
});

test("the look-at target: 1 m in front of the eyes by default, dragged, head and eyes follow; lookAtPoint aims at a point; off again", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(ed.lookActive, false);
  assert.equal(ed.handleAvailable("gaze"), false);
  assert.equal(ed.toggleLook(true), true);
  const t = ed.lookTarget(), eye = rig.landmarkWorld("eye_mid");
  approx(P(...t).distanceTo(eye), 1, 1e-9, "1 m in front of the eyes");
  assert.ok(t[2] > eye.z + 0.9);
  assert.equal(ed.handleAvailable("gaze"), true);
  const d = ed.createDrag("gaze", { immediate: true }), g0 = ed.handlePoint("gaze");
  d.begin(g0);
  const to = P(0.5, 1.9, 1.0);
  for (let i = 1; i <= 20; i++) d.move(g0.clone().lerp(to, i / 20));
  const st = d.end();
  assert.ok(st.reachable, JSON.stringify(st));
  approx(ed.handlePoint("gaze").distanceTo(to), 0, 1e-9, "the target is where it was dragged");
  const dir = P(0, 0, 1).applyQuaternion(rig.jointQuaternion("eye_L")).add(P(0, 0, 1).applyQuaternion(rig.jointQuaternion("eye_R"))).normalize();
  const want = to.clone().sub(rig.landmarkWorld("eye_mid")).normalize();
  assert.ok(dir.angleTo(want) * 180 / Math.PI < 1.5, `gaze error ${dir.angleTo(want) * 180 / Math.PI} degrees`);
  const s2 = ed.lookAtPoint([-1, 1.5, 2]);
  assert.ok(s2.reachable);
  assert.deepEqual(ed.lookTarget(), [-1, 1.5, 2]);
  assert.equal(ed.toggleLook(false), false);
  assert.equal(ed.lookTarget(), null);
});

test("IK drag, cancel: the pose, the placement and the history are exactly what they were; a second drag cancels the first; Esc / dispose cancel too", () => {
  const { rig, ed } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  ed.setJoint("elbow_L", 0, 70); // a straight arm has nothing to swivel
  const before = JSON.stringify(rig.getPose()), place = JSON.stringify(ed.place), steps = ed.history.steps;
  for (const [h, delta] of [["palm_L", P(0.1, 0.3, 0.3)], ["foot_R", P(0, 0.1, 0.2)], ["pelvis", P(0.05, -0.15, 0.05)], ["chest", P(0, -0.1, 0.2)], ["elbow_L", P(0.1, 0.1, 0)]]) {
    const d = ed.createDrag(h, { immediate: true }), p0 = ed.handlePoint(h);
    d.begin(p0);
    for (let i = 1; i <= 10; i++) d.move(p0.clone().addScaledVector(delta, i / 10));
    assert.notEqual(JSON.stringify(rig.getPose()), before, `${h} moved the figure`);
    d.cancel();
    assert.equal(JSON.stringify(rig.getPose()), before, `${h}: cancel restores the pose exactly`);
    assert.equal(JSON.stringify(ed.place), place);
    assert.equal(ed.history.steps, steps);
    assert.equal(ed.dragging, false);
  }
  const a = ed.createDrag("palm_L", { immediate: true }), b = ed.createDrag("palm_R", { immediate: true });
  a.begin(ed.handlePoint("palm_L")); a.move(ed.handlePoint("palm_L").add(P(0, 0.3, 0.2)));
  b.begin(ed.handlePoint("palm_R"));
  assert.equal(a.active, false, "the second drag cancelled the first");
  assert.equal(JSON.stringify(rig.getPose()), before);
  b.move(ed.handlePoint("palm_R").add(P(0, 0.2, 0.2)));
  ed.undo();
  assert.equal(ed.dragging, false, "undo cancels a drag");
  assert.throws(() => ed.createDrag("no-such-handle"), /unknown handle/);
  assert.throws(() => ed.handlePoint("toString"), /unknown handle/);
});

test("nudge handles from the keyboard: 10 mm steps move a handle by 10 mm; nudges of one handle within 600 ms merge into one history step", () => {
  const { rig, ed, clock } = setup();
  ed.apply("iso-7250-standing", { animate: false });
  const p0 = ed.handlePoint("palm_R"), steps = ed.history.steps;
  ed.nudgeHandle("palm_R", [0.01, 0, 0]);
  const p1 = ed.handlePoint("palm_R");
  approx(p1.x - p0.x, 0.01, 0.0015, "10 mm");
  approx(p1.y, p0.y, 0.0015);
  ed.nudgeHandle("palm_R", [0, 0.01, 0]);
  ed.nudgeHandle("palm_R", [0, 0, 0.001]);
  assert.equal(ed.history.steps, steps + 1, "three quick nudges: one step");
  approx(ed.handlePoint("palm_R").y - p0.y, 0.01, 0.0015);
  approx(ed.handlePoint("palm_R").z - p0.z, 0.001, 0.0015);
  clock.advance(1500);
  ed.nudgeHandle("palm_R", [0, 0.1, 0]);
  assert.equal(ed.history.steps, steps + 2);
  ed.nudgeHandle("foot_L", [0, 0, 0.01]);
  assert.equal(ed.history.steps, steps + 3, "another handle: another step");
  ed.undo(); ed.undo();
  approx(ed.handlePoint("palm_R").y - p0.y, 0.01, 0.0015);
  assert.throws(() => ed.nudgeHandle("nope", [0, 0, 0]), /unknown handle/);
  void rig;
});

test("IK needs the solver: without it the handles are unavailable and a drag does not begin", () => {
  const rig = buildRig(MAN, {});
  const ed = createEditor({ getRig: () => rig, ik: null, metrics: null, storage: null, scheduler: { raf: null } });
  assert.equal(ed.ikReady, false);
  assert.equal(ed.handleAvailable("palm_R"), false);
  assert.equal(ed.createDrag("palm_R").begin(ed.handlePoint("palm_R")), false);
  assert.equal(ed.nudgeHandle("palm_R", [0.01, 0, 0]), null);
  assert.equal(ed.lookAtPoint([0, 1, 2]), null);
  ed.setJoint("elbow_R", 0, 20);
  assert.equal(rig.angles.elbow_R[0], 20, "everything else works");
  assert.deepEqual(ed.info().angles, [], "no metrics module: no key angles");
});

// ---- the rig is replaced --------------------------------------------------------------------------------------------------------------------------
test("a new figure (another profile): the posture and the placement are kept and applied to the new body; the history survives", () => {
  const rigs = [buildRig(BODIES[1][1], {}), buildRig(BODIES[0][1], {}), buildRig(BODIES[2][1], {})];
  let cur = 0;
  const handlers = new Map(), seen = [];
  const ctx = { on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e); }, setPosture() {}, toast() {}, state: {} };
  const ed = createEditor({ getRig: () => rigs[cur], ik: IK, metrics: METRICS, storage: memStorage(), ctx, scheduler: { raf: null } });
  ed.on("rig", () => seen.push("rig"));
  ed.apply("iso-7250-sitting", { animate: false });
  ed.setJoint("shoulder_R", "flex", 70);
  const seat0 = ed.seatHeight();
  for (const k of [1, 2]) {
    const old = rigs[cur].getPose();
    cur = k;
    rigs[cur].setPose(old); // what the shell does: the angles and the root are carried over
    handlers.get("rig")(rigs[cur]);
    assert.equal(seen.length, k);
    assert.equal(ed.base.id, "iso-7250-sitting");
    assert.equal(rigs[cur].angles.shoulder_R[0], 70);
    assert.equal(ed.modified, true);
    const info = ed.info();
    approx(info.gaps.seat, 0, 1e-9, "the new body sits on its own popliteal seat");
    approx(info.gaps.feet, 0, 1e-9);
    assert.notEqual(ed.seatHeight(), seat0, "the seat height follows the body");
  }
  assert.equal(ed.history.steps, 2, "the history survives");
  cur = 1;
  ed.undo();
  assert.equal(rigs[1].angles.shoulder_R[0], 0);
  approx(ed.info().gaps.seat, 0, 1e-9);
  // a listener of the old rig is gone
  assert.equal(rigs[0]._listeners.size, 0);
});

test("dispose: the rig listener and the ctx subscriptions are removed, a drag and an animation end, the registry forgets the editor", () => {
  const handlers = new Map();
  const state = {};
  const ctx = { viewport: {}, state, on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e); }, getRig: () => rig, getBody: () => MAN, setPosture() {}, toast() {} };
  const rig = buildRig(MAN, {});
  const ed = editorFor(ctx, { ik: IK, storage: memStorage(), scheduler: { raf: null } });
  assert.equal(editorFor(ctx), ed, "one editor per viewport");
  assert.equal(peekEditor(ctx), ed);
  assert.equal(ctx.posture, ed, "published as ctx.posture");
  assert.equal(state.postureEditor, ed, "and reachable from other panels through the shared state");
  assert.equal(Object.keys(state).includes("postureEditor"), false, "not enumerable");
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(rig._listeners.size, 1);
  assert.equal(handlers.size, 2);
  const d = ed.createDrag("palm_R", { immediate: true });
  d.begin(ed.handlePoint("palm_R"));
  ed.dispose();
  assert.equal(d.active, false);
  assert.equal(rig._listeners.size, 0);
  assert.equal(handlers.size, 0);
  assert.equal(ed.disposed, true);
  assert.equal(peekEditor(ctx), null);
  assert.throws(() => ed.apply("iso-7250-sitting"), /disposed/);
  const ed2 = editorFor(ctx, { ik: IK, storage: memStorage() });
  assert.notEqual(ed2, ed);
  ed2.dispose();
  assert.throws(() => editorFor({}), /ctx/);
});

// ---- the handles in the 3D view --------------------------------------------------------------------------------------------------------------------
function fakeViewport() {
  const cam = new THREE.PerspectiveCamera(35, 800 / 600, 0.05, 120);
  cam.position.set(2.2, 1.5, 3.6); cam.lookAt(0, 0.9, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const listeners = new Map(), sources = new Map(), scene = new THREE.Scene(), cursors = [];
  const rc = { left: 0, top: 0, width: 800, height: 600 };
  const vp = {
    camera: cam, scene, container: { clientHeight: 600 }, controls: { enabled: true }, active: true, gizmoDragging: false, cursors,
    canvas: { clientHeight: 600, getBoundingClientRect: () => rc, setPointerCapture() {}, releasePointerCapture() {}, addEventListener() {}, removeEventListener() {} },
    add: (o) => scene.add(o), remove: (o) => scene.remove(o), requestRender() {}, setCursor: (c) => cursors.push(c),
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    emit(type, ev) { for (const f of [...(listeners.get(type) ?? [])]) f(ev); },
    project(v, out = {}) { const p = v.clone().project(cam); out.x = (p.x * 0.5 + 0.5) * 800; out.y = (-p.y * 0.5 + 0.5) * 600; out.depth = 1; out.visible = p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1; return out; },
    ray(cx, cy) { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2((cx / 800) * 2 - 1, -(cy / 600) * 2 + 1), cam); return r; },
    addLabelSource: (k, fn) => sources.set(k, fn), removeLabelSource: (k) => sources.delete(k), sources, listeners,
  };
  return vp;
}
const ptr = (x, y, extra = {}) => ({ clientX: x, clientY: y, button: 0, buttons: 1, pointerType: "mouse", originalEvent: { isPrimary: true, pointerId: 1 }, ...extra });
const screenOf = (vp, p) => { const o = vp.project(p, {}); return [o.x, o.y]; };

test("the handle layer: handles of constant screen size at the right places, picked in screen space, hands before poles", () => {
  const { rig, ed } = setup();
  const vp = fakeViewport();
  const layer = createHandleLayer({ viewport: vp, editor: ed, scheduler: { raf: null } });
  ed.apply("iso-7250-standing", { animate: false });
  assert.equal(layer.group.visible, false);
  layer.setEnabled(true);
  assert.equal(layer.group.visible, true);
  const holders = Object.fromEntries([...layer.items].map(([id, it]) => [id, it.holder]));
  for (const h of HANDLES) assert.equal(holders[h.id].visible, h.kind !== "gaze", `${h.id} visibility`);
  for (const h of HANDLES) if (h.kind !== "gaze") assert.ok(holders[h.id].position.distanceTo(ed.handlePoint(h.id)) < 1e-9);
  // the same size on the screen near and far
  const sizeAt = (dist) => { vp.camera.position.copy(new THREE.Vector3(0, 0.9, 0).add(new THREE.Vector3(0, 0, 1).multiplyScalar(dist))); vp.camera.lookAt(0, 0.9, 0); vp.camera.updateMatrixWorld(true); const h = holders.palm_R; h.position.set(0, 0.9, 0); h.updateMatrixWorld(true); return h.scale.x / dist; };
  approx(sizeAt(2) / sizeAt(6), 1, 1e-6, "scale is proportional to the distance");
  vp.camera.position.set(2.2, 1.5, 3.6); vp.camera.lookAt(0, 0.9, 0); vp.camera.updateMatrixWorld(true);
  layer.update();
  const [x, y] = screenOf(vp, ed.handlePoint("palm_R"));
  assert.equal(layer.pick(x + 4, y - 3), "palm_R");
  assert.equal(layer.pick(x + 60, y), null);
  const [fx, fy] = screenOf(vp, ed.handlePoint("foot_L"));
  assert.equal(layer.pick(fx, fy), "foot_L");
  layer.setPoles(false);
  assert.equal(holders.elbow_R.visible, false);
  assert.equal(layer.pick(...screenOf(vp, ed.handlePoint("elbow_R"))) === "elbow_R", false, "hidden handles are not picked");
  layer.setPoles(true);
  assert.equal(layer.pick(...screenOf(vp, ed.handlePoint("elbow_R"))), "elbow_R");
  ed.toggleLook(true);
  layer.update();
  assert.equal(holders.gaze.visible, true);
  layer.setEnabled(false);
  assert.equal(layer.group.visible, false);
  assert.equal(layer.pick(x, y), null);
  layer.dispose();
  assert.equal(vp.scene.children.includes(layer.group), false);
  assert.equal(vp.sources.has("posture-handles"), false);
  void rig;
});

test("the handle layer: a drag with the pointer follows the mouse on a plane facing the camera, holds the orbit controls, is one step, and Esc / pointercancel cancel it", () => {
  const { rig, ed } = setup();
  const vp = fakeViewport();
  const selected = [];
  const layer = createHandleLayer({ viewport: vp, editor: ed, onSelect: (id) => selected.push(id), scheduler: { raf: null } });
  ed.apply("iso-7250-standing", { animate: false });
  layer.setEnabled(true);
  const before = JSON.stringify(rig.getPose()), steps = ed.history.steps;
  const p0 = ed.handlePoint("palm_R"), [x0, y0] = screenOf(vp, p0);
  vp.emit("pointerdown", ptr(x0 + 2, y0 + 2));
  assert.equal(layer.dragging, true);
  assert.equal(vp.controls.enabled, false, "orbit is held while a handle is dragged");
  assert.ok(vp.cursors.includes("grabbing"));
  // a point on the screen where we want the hand: pick it from a target in the plane through the handle
  const target = p0.clone().add(P(-0.1, 0.25, 0.1));
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(vp.camera.getWorldDirection(new THREE.Vector3()), p0);
  const inPlane = new THREE.Vector3();
  plane.projectPoint(target, inPlane);
  const steps_ = 15, sx = screenOf(vp, p0), ex = screenOf(vp, inPlane);
  for (let i = 1; i <= steps_; i++) vp.emit("pointermove", ptr(sx[0] + ((ex[0] - sx[0]) * i) / steps_ + 2, sx[1] + ((ex[1] - sx[1]) * i) / steps_ + 2));
  vp.emit("pointerup", ptr(ex[0] + 2, ex[1] + 2, { buttons: 0 }));
  assert.equal(layer.dragging, false);
  assert.equal(vp.controls.enabled, true, "orbit is back");
  assert.ok(ed.handlePoint("palm_R").distanceTo(inPlane) < 0.004, `the palm is ${(ed.handlePoint("palm_R").distanceTo(inPlane) * 1000).toFixed(1)} mm from the pointer's point`);
  assert.equal(ed.history.steps, steps + 1);
  assert.deepEqual(selected, ["palm_R"]);
  // a click that does not move: selected, nothing recorded
  const [cx, cy] = screenOf(vp, ed.handlePoint("foot_R"));
  vp.emit("pointerdown", ptr(cx, cy)); vp.emit("pointerup", ptr(cx, cy, { buttons: 0 }));
  assert.equal(ed.history.steps, steps + 1);
  assert.deepEqual(selected, ["palm_R", "foot_R"]);
  // pointercancel and a second pointer cancel; a press on empty space is left to the viewport
  const mid = JSON.stringify(rig.getPose());
  const [qx, qy] = screenOf(vp, ed.handlePoint("palm_L"));
  vp.emit("pointerdown", ptr(qx, qy));
  vp.emit("pointermove", ptr(qx + 30, qy - 40));
  assert.notEqual(JSON.stringify(rig.getPose()), mid);
  vp.emit("pointerdown", ptr(qx, qy, { originalEvent: { isPrimary: false, pointerId: 2 } }));
  assert.equal(layer.dragging, false);
  assert.equal(JSON.stringify(rig.getPose()), mid, "a second finger cancels the drag");
  assert.equal(vp.controls.enabled, true);
  vp.emit("pointerdown", ptr(20, 20));
  assert.equal(layer.dragging, false);
  assert.equal(vp.controls.enabled, true, "a press away from every handle leaves the orbit alone");
  vp.emit("pointerdown", ptr(qx, qy, { button: 2 }));
  assert.equal(layer.dragging, false, "only the primary button");
  layer.setEnabled(false);
  vp.emit("pointerdown", ptr(x0, y0));
  assert.equal(layer.dragging, false, "disabled");
  layer.dispose();
  void before;
});

test("the handle layer: an unreachable drag turns the handle red and names the shortfall in its label", () => {
  const { ed } = setup();
  const vp = fakeViewport();
  const layer = createHandleLayer({ viewport: vp, editor: ed, scheduler: { raf: null } });
  ed.apply("iso-7250-standing", { animate: false });
  layer.setEnabled(true);
  const p0 = ed.handlePoint("palm_R"), [x0, y0] = screenOf(vp, p0);
  vp.emit("pointerdown", ptr(x0, y0));
  const far = p0.clone().add(P(-0.2, 0.5, 1.2)), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(vp.camera.getWorldDirection(new THREE.Vector3()), p0);
  for (let i = 1; i <= 30; i++) { const q = new THREE.Vector3(); plane.projectPoint(p0.clone().lerp(far, i / 30), q); const [sx, sy] = screenOf(vp, q); vp.emit("pointermove", ptr(sx, sy)); }
  const item = layer.items.get("palm_R");
  layer.update();
  assert.equal(item.material.color.getHex(), new THREE.Color("#d6342a").getHex(), "the handle is red");
  const labels = vp.sources.get("posture-handles")();
  assert.ok(labels.some((l) => l.id === "palm_R" && /cannot reach|short/.test(l.text)), JSON.stringify(labels.map((l) => l.text)));
  vp.emit("pointerup", ptr(0, 0, { buttons: 0 }));
  layer.dispose();
});

// ---- pure helpers -------------------------------------------------------------------------------------------------------------------------------------
test("pure helpers: slider bounds, edit tabs cover every joint of the model once, handles are well formed, custom ids", () => {
  const d = JOINT_BY_ID.shoulder_R.dof[0];
  assert.deepEqual(sliderBounds(d, true), { min: -60, max: 180, lo: -60, hi: 180 });
  const loose = sliderBounds(d, false);
  assert.ok(loose.min < -60 && loose.max > 180 && loose.max <= 360 && loose.lo === -60 && loose.hi === 180);
  const tiny = sliderBounds(JOINT_BY_ID.jaw.dof[0], false);
  assert.ok(tiny.min <= -25 && tiny.max >= 55, "at least 20 degrees of margin");
  const tabs = new Set();
  for (const j of JOINTS) {
    const t = tabOfJoint(j.id);
    if (j.id === "pelvis") { assert.equal(t, "spine"); continue; }
    assert.ok(EDIT_TABS.some((x) => x.id === t), `${j.id} has a tab (${t})`);
    tabs.add(t);
  }
  assert.equal(tabs.size, EDIT_TABS.length);
  const listed = EDIT_TABS.flatMap((t) => t.joints);
  assert.equal(new Set(listed).size, listed.length, "no joint twice");
  for (const id of listed) assert.ok(JOINT_BY_ID[id], id);
  assert.equal(tabOfJoint("L3"), "spine");
  assert.equal(tabOfJoint("C4"), "head");
  assert.equal(tabOfJoint("index_pip_R"), "hand_R");
  assert.equal(tabOfJoint("nope"), null);
  assert.deepEqual(HANDLES.map((h) => h.id), ["palm_L", "palm_R", "foot_L", "foot_R", "pelvis", "chest", "gaze", "elbow_L", "elbow_R", "knee_L", "knee_R"]);
  assert.equal(customIdFor("My Reach!"), "custom-my-reach");
  assert.equal(customIdFor("custom-thing"), "custom-thing");
  assert.equal(customIdFor("x", new Set(["custom-x", "custom-x-2"])), "custom-x-3");
  assert.equal(customIdFor("", new Set()), "custom-posture");
  assert.equal(ED.supportLabel("seat+feet"), "Sits, feet on the floor");
  assert.equal(ED.supportShort("body"), "lies");
  assert.equal(ED.supportShort("zzz"), "zzz");
  assert.match(ED.dofTitle("shoulder_R", 0), /Right shoulder.*Flexion/);
});

// ---- the panel's pure helpers (panels/posture.js above `// ---- panel`) ----------------------------------------------------------------------------------
test("panel: filtering the library by words, accents, category, tags and custom; counts of the chips; tag counts", () => {
  const list = [...POSTURES, { id: "custom-q", name: "Café reach", category: "Reaching", tags: ["custom", "reach", "one-hand"], description: "Reaching for a cup", source: "custom", support: "feet", joints: {}, spine: {} }];
  assert.equal(PANEL.filterPostures(list, {}).length, list.length);
  const sit = PANEL.filterPostures(list, { query: "sit upright" });
  assert.ok(sit.length > 0 && sit.every((p) => /sit/i.test(`${p.name} ${p.description} ${p.tags.join(" ")} ${p.category}`)));
  assert.deepEqual(PANEL.filterPostures(list, { query: "cafe" }).map((p) => p.id), ["custom-q"], "accents and case are ignored");
  assert.deepEqual(PANEL.filterPostures(list, { query: "CAFÉ  reach" }).map((p) => p.id), ["custom-q"], "word order and blanks do not matter");
  for (const q of ["squat", "squat lift", "ISO 7250", "LYING back", "  seat  ", "pédale", "reach one-hand", ""]) {
    assert.deepEqual(PANEL.filterPostures(POSTURES, { query: q }).map((p) => p.id), librarySearch(q).map((p) => p.id), `"${q}" finds what postures.js search() finds`);
  }
  assert.equal(PANEL.filterPostures(list, { query: "zzzzqqq" }).length, 0);
  assert.ok(PANEL.filterPostures(list, { category: "Lying" }).every((p) => p.category === "Lying"));
  assert.deepEqual(PANEL.filterPostures(list, { category: "custom" }).map((p) => p.id), ["custom-q"]);
  assert.deepEqual(PANEL.filterPostures(list, { tags: ["custom", "reach"] }).map((p) => p.id), ["custom-q"], "tags are ANDed");
  assert.equal(PANEL.filterPostures(list, { tags: ["no-such-tag"] }).length, 0);
  const cc = PANEL.categoryCounts(list, {});
  assert.equal(cc.all, list.length);
  assert.equal(cc.custom, 1);
  assert.equal(Object.keys(cc).length, 2 + CATEGORIES_N());
  assert.equal(CATEGORIES_SUM(cc), list.length, "every posture is in exactly one category");
  const cq = PANEL.categoryCounts(list, { query: "lie" });
  assert.equal(cq.all, PANEL.filterPostures(list, { query: "lie" }).length);
  assert.equal(cq.Lying, PANEL.filterPostures(list, { query: "lie", category: "Lying" }).length, "the count of a chip does not apply that chip's own filter to the others");
  const tc = PANEL.tagCounts(list, {}, 10);
  assert.equal(tc.length, 10);
  assert.ok(tc.every((t, i) => i === 0 || tc[i - 1][1] >= t[1]), "most used first");
  assert.ok(PANEL.tagCounts(list, { category: "custom" }).every(([, n]) => n === 1));
});
function CATEGORIES_N() { return ED.CATEGORIES.length; }
function CATEGORIES_SUM(cc) { return ED.CATEGORIES.reduce((t, c) => t + cc[c.name], 0); }

test("panel: windowing a long list, list keys, badges, readout texts, key steps and nudge vectors", () => {
  assert.deepEqual(PANEL.windowRange(0, 400, 80, 300, 3), { start: 0, end: 8 });
  assert.deepEqual(PANEL.windowRange(800, 400, 80, 300, 3), { start: 7, end: 18 });
  assert.deepEqual(PANEL.windowRange(24000, 400, 80, 300, 3).end, 300);
  assert.deepEqual(PANEL.windowRange(0, 400, 80, 0), { start: 0, end: 0 });
  assert.deepEqual(PANEL.windowRange(-50, 400, 80, 3, 0), { start: 0, end: 3 });
  const rows = (n) => { const r = PANEL.windowRange(n * 80 * 0.37, 400, 80, 5000, 3); return r.end - r.start; };
  assert.ok(rows(10) <= 12 && rows(2000) <= 12, "never more rows than the window needs, whatever the length");
  assert.equal(PANEL.listMove(0, 10, "ArrowDown"), 1);
  assert.equal(PANEL.listMove(0, 10, "ArrowUp"), 0);
  assert.equal(PANEL.listMove(9, 10, "ArrowDown"), 9);
  assert.equal(PANEL.listMove(3, 10, "Home"), 0);
  assert.equal(PANEL.listMove(3, 10, "End"), 9);
  assert.equal(PANEL.listMove(3, 10, "PageDown", 5), 8);
  assert.equal(PANEL.listMove(3, 10, "PageUp", 5), 0);
  assert.equal(PANEL.listMove(3, 10, "a"), -1);
  assert.equal(PANEL.listMove(0, 0, "ArrowDown"), -1);
  assert.deepEqual(PANEL.sourceBadge("illustrative (fingers extended)"), { text: "illustrative", title: "illustrative (fingers extended)" });
  assert.equal(PANEL.sourceBadge("ISO 7250-1 (standing posture); the neutral pose of skeleton.js").text, "ISO 7250-1");
  assert.ok(PANEL.sourceBadge("A very very long reference title indeed").text.length <= 22);
  assert.equal(PANEL.sourceBadge("").text, "no source");
  assert.equal(PANEL.validatorBadge({ errors: [], warnings: [] }).kind, "good");
  assert.equal(PANEL.validatorBadge({ errors: [], warnings: ["w"] }).kind, "warn");
  assert.match(PANEL.validatorBadge({ errors: ["e1", "e2", "e3", "e4"], warnings: [] }).title, /and 1 more/);
  assert.equal(PANEL.validatorBadge(null).text, "…");
  const fmt = (mm) => `${Math.round(mm)} mm`;
  assert.equal(PANEL.balanceText({ applies: true, margin: 0.062, status: "ok" }, fmt).kind, "good");
  assert.match(PANEL.balanceText({ applies: true, margin: -0.02, status: "edge" }, fmt).text, /20 mm outside/);
  assert.equal(PANEL.balanceText({ applies: true, margin: -0.09, status: "falls" }, fmt).kind, "bad");
  assert.equal(PANEL.balanceText({ applies: false, reason: "x" }, fmt).title, "x");
  assert.deepEqual(PANEL.gapTexts({ feet: 0, seat: 0.0004 }, fmt), []);
  assert.deepEqual(PANEL.gapTexts({ feet: 0.02 }, fmt), [{ kind: "warn", text: "Feet 20 mm above the floor" }]);
  assert.deepEqual(PANEL.gapTexts({ seat: -0.01 }, fmt), [{ kind: "warn", text: "Seat 10 mm below the seat" }]);
  assert.equal(PANEL.fmtDeg(-12.5), "−12.5°");
  assert.equal(PANEL.fmtDeg(30), "30°");
  assert.equal(PANEL.fmtDeg(0.04), "0°");
  assert.equal(PANEL.fmtDeg(NaN), "—");
  assert.equal(PANEL.keyStep({}), 1);
  assert.equal(PANEL.keyStep({ shiftKey: true }), 10);
  assert.equal(PANEL.keyStep({ altKey: true }), 0.1);
  assert.equal(PANEL.keyStep({ key: "PageUp" }), 10);
  assert.equal(PANEL.keyStep({ altKey: true, shiftKey: true }), 0.1);
  const ax = PANEL.viewAxes([0, -0.3, -1]);
  assert.deepEqual(ax.fwd, [0, 0, -1]);
  assert.deepEqual(ax.right, [1, 0, 0].map((c) => (c === 0 ? 0 : c)));
  assert.deepEqual(PANEL.nudgeVector("ArrowRight", {}, ax.right, ax.fwd), [0.01, 0, 0]);
  assert.deepEqual(PANEL.nudgeVector("ArrowLeft", { shift: true }, ax.right, ax.fwd).map((v) => +v.toFixed(6)), [-0.1, 0, 0]);
  assert.deepEqual(PANEL.nudgeVector("ArrowUp", { alt: true }, ax.right, ax.fwd).map((v) => +v.toFixed(6)), [0, 0.001, 0]);
  assert.deepEqual(PANEL.nudgeVector("PageUp", {}, ax.right, ax.fwd), [0, 0, -0.01], "Page Up: away from the camera");
  assert.equal(PANEL.nudgeVector("a", {}), null);
  assert.match(PANEL.handleHint(HANDLES[0]), /Left hand: arrow keys move it 10 mm/);
});

/** A 2D context that records the points it is asked to draw. */
function fakeG() {
  const pts = [], g = { pts, lineWidth: 1, strokeStyle: "", clearRect() {}, beginPath() {}, stroke() {}, moveTo(x, y) { pts.push([x, y]); }, lineTo(x, y) { pts.push([x, y]); }, arc(x, y, r) { pts.push([x - r, y - r], [x + r, y + r]); } };
  return g;
}
test("panel: a stick figure of every library posture on three bodies: finite, on the floor line, the seat drawn for seated postures, and it fits in its thumbnail", () => {
  const palette = { near: "#000", far: "#888", spine: "#000", floor: "#ccc", seat: "#00f" };
  const problems = [], views = { side: 0, front: 0 };
  for (const [name, body] of BODIES) {
    const stature = body.stature ?? 1.75;
    for (const p of POSTURES) {
      let geom;
      try { geom = PANEL.stickFigure(body, p); } catch (e) { problems.push(`${name} ${p.id}: ${e.message}`); continue; }
      views[geom.view]++;
      const all = geom.segments.flatMap((s) => s.pts);
      if (!all.every(([u, v]) => Number.isFinite(u) && Number.isFinite(v))) problems.push(`${name} ${p.id}: not finite`);
      const vmin = Math.min(...all.map((q) => q[1])), vmax = Math.max(...all.map((q) => q[1]));
      if (vmin < -0.04) problems.push(`${name} ${p.id}: ${(vmin * 1000).toFixed(0)} mm below the floor`);
      if (vmax > 2.6) problems.push(`${name} ${p.id}: ${vmax.toFixed(2)} m high`);
      const hasSeat = Object.values(ED.SUPPORT_CARRIERS[p.support]).includes("seat");
      if (hasSeat && !(p.hints?.seat?.height === 0) && !geom.seat) problems.push(`${name} ${p.id}: no seat drawn`);
      if (!hasSeat && geom.seat) problems.push(`${name} ${p.id}: a seat for a posture without one`);
      if (geom.seat && geom.seat.v > 1.1) problems.push(`${name} ${p.id}: a seat ${geom.seat.v} m high`);
      const g = fakeG();
      PANEL.drawStick(g, geom, 128, 128, palette, stature, 2);
      const out = g.pts.filter(([x, y]) => x < -0.5 || y < -0.5 || x > 128.5 || y > 128.5);
      if (out.length) problems.push(`${name} ${p.id}: ${out.length} points outside the 128 px thumbnail (${out[0].map((v) => v.toFixed(0))})`);
      if (PANEL.stickCached(body, p) !== PANEL.stickCached(body, p)) problems.push(`${p.id}: not cached`);
    }
  }
  assert.deepEqual(problems, [], problems.slice(0, 8).join("\n"));
  assert.ok(views.side > views.front * 4, `most are drawn from the side (${JSON.stringify(views)})`);
  assert.ok(views.front >= 3, "the postures lying on the side are drawn from the front");
  // the validator badge input is cached per posture and body
  const a = PANEL.validateCached(MAN, POSTURES[0]);
  assert.equal(PANEL.validateCached(MAN, POSTURES[0]), a);
  assert.notEqual(PANEL.validateCached(BODIES[0][1], POSTURES[0]), a);
  assert.equal(PANEL.validateCached(MAN, { id: "bogus", name: "x", support: "nope" }).ok, false, "a posture that cannot be validated gives a failure, not an exception");
});
