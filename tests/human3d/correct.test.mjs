// Ergonomic correction (site/js/human/correct.js): flags, verdicts and the nearest acceptable pose.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitBody } from "../../site/js/human/fit.js";
import { percentileProfile } from "../../site/js/human/anthro.js";
import { expandPosture, placePose } from "../../site/js/human/pose.js";
import { POSTURES, byId } from "../../site/js/human/postures.js";
import { clampAngles, JOINT_BY_ID } from "../../site/js/human/skeleton.js";
import { ISO_11226 } from "../../site/js/human/metrics.js";
import { correctAngles, assessPosture, verdictOf, compareFlags, excessOf, CORRECTABLE, MAX_HAND_MOVE, postureVerdict } from "../../site/js/human/correct.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const body = fitBody(percentileProfile(JSON.parse(fs.readFileSync(path.join(ROOT, "public/api/v1/populations/united-states/army/M.json"))), { percentile: 50 }));

/** A library posture placed on its support, as the editor would show it. */
function placed(id) {
  const p = byId(id), e = expandPosture(p);
  const pl = placePose(body, { root: e.root, angles: e.angles }, { support: p.support });
  return { p, pose: { root: { ...e.root, ...pl }, angles: e.angles } };
}
const seatedOf = (p) => p.support === "seat" || p.support === "seat+feet";

test("verdicts: a high flag makes the posture not acceptable, a caution flag makes it check, otherwise acceptable", () => {
  assert.equal(verdictOf([{ severity: "ok" }, { severity: "high" }, { severity: "caution" }]), "not-acceptable");
  assert.equal(verdictOf([{ severity: "ok" }, { severity: "caution" }]), "check");
  assert.equal(verdictOf([{ severity: "ok" }]), "acceptable");
  assert.equal(verdictOf([]), "acceptable");
});

test("excess degrees are zero for an acceptable flag and measure the distance beyond the limit for a flagged one", () => {
  assert.equal(excessOf({ id: "trunk-inclination", value: 10, severity: "ok" }), 0);
  assert.equal(excessOf({ id: "trunk-inclination", value: 80, severity: "high" }), 80 - ISO_11226.trunk.acceptable);
  assert.equal(excessOf({ id: "trunk-inclination", value: -30, severity: "caution" }), 30 - ISO_11226.trunk.acceptable, "backward counts too");
  assert.equal(excessOf({ id: "upper-arm-elevation-L", value: 90, severity: "high" }), 90 - ISO_11226.upperArm.acceptable);
  assert.equal(excessOf({ id: "elbow-R", value: 30, severity: "caution" }), ISO_11226.elbow.flexionRange[0] - 30);
  assert.equal(excessOf({ id: "knee-flexion-L", value: 50, severity: "caution" }), 50 - ISO_11226.knee.cautionDeg);
  assert.equal(excessOf({ id: "something-else", value: 50, severity: "high" }), 0, "an unknown flag has no excess to remove");
});

test("a neutral standing figure is acceptable and the search leaves it unchanged", () => {
  const { pose } = placed("stand-relaxed");
  assert.equal(assessPosture(body, pose).verdict, "acceptable");
  const r = correctAngles(body, pose, { flagOptions: { seated: false } });
  assert.equal(r.changed, 0, "nothing flagged, nothing moved");
  assert.equal(r.verdictBefore, "acceptable");
  assert.equal(r.verdictAfter, "acceptable");
});

test("a stooped lift is improved: the cost falls, the trunk moves toward the limit and no flag gets worse", () => {
  const { pose } = placed("lift-stoop-start");
  const before = assessPosture(body, pose, { seated: false });
  const r = correctAngles(body, pose, { flagOptions: { seated: false } });
  assert.ok(r.cost.after < r.cost.before, `cost ${r.cost.before} -> ${r.cost.after}`);
  assert.ok(r.changed > 0, "some joints moved");
  const trunkBefore = before.flags.find((f) => f.id === "trunk-inclination").value;
  const trunkAfter = r.after.find((f) => f.id === "trunk-inclination").value;
  assert.ok(trunkAfter < trunkBefore, `trunk ${trunkBefore} -> ${trunkAfter}`);
  const rank = { ok: 0, caution: 1, high: 2 };
  for (const row of compareFlags(r.before, r.after)) assert.notEqual(row.status, "worse", `${row.label} got worse`);
});

test("the palms never move further than the task allows", () => {
  for (const id of ["reach-overhead-one-hand", "t-pose", "mil-plf-landing", "reach-lateral"]) {
    const { pose } = placed(id);
    const r = correctAngles(body, pose, { flagOptions: { seated: byId(id).support.startsWith("seat") } });
    assert.ok(Math.max(r.hands.L, r.hands.R) <= MAX_HAND_MOVE + 1e-9, `${id}: palm moved ${(Math.max(r.hands.L, r.hands.R) * 1000).toFixed(0)} mm`);
  }
});

test("every corrected joint stays inside its range of motion, and the input is never mutated", () => {
  const { pose } = placed("lift-stoop-start");
  const snapshot = JSON.stringify(pose);
  const r = correctAngles(body, pose, { flagOptions: { seated: false } });
  assert.equal(JSON.stringify(pose), snapshot, "the input pose is unchanged");
  for (const id of CORRECTABLE) {
    const a = r.angles[id];
    assert.ok(Array.isArray(a) && a.length === JOINT_BY_ID[id].dof.length, `${id} has one value per degree of freedom`);
    const clamped = clampAngles(id, a).angles;
    for (let k = 0; k < a.length; k++) assert.ok(Math.abs(clamped[k] - a[k]) < 1e-6, `${id}[${k}] = ${a[k]} is inside its range`);
  }
});

test("the correction is deterministic and reports the joints it changed", () => {
  const { pose } = placed("sit-slumped");
  const a = correctAngles(body, pose, { flagOptions: { seated: true } });
  const b = correctAngles(body, pose, { flagOptions: { seated: true } });
  assert.deepEqual(a.angles, b.angles);
  assert.equal(a.changed, a.changedJoints.length);
  for (const id of a.changedJoints) assert.ok(CORRECTABLE.includes(id), `${id} is a correctable joint`);
});

test("one correction takes less than three seconds on a median man", () => {
  const { pose } = placed("lift-overhead-end");
  const t0 = performance.now();
  correctAngles(body, pose, { flagOptions: { seated: false } });
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

test("compareFlags lists each measure once, with its status", () => {
  const before = [{ id: "a", label: "A", value: 50, severity: "high" }, { id: "b", label: "B", value: 30, severity: "caution" }];
  const after = [{ id: "a", label: "A", value: 22, severity: "caution" }, { id: "b", label: "B", value: 40, severity: "high" }, { id: "c", label: "C", value: 5, severity: "ok" }];
  const rows = Object.fromEntries(compareFlags(before, after).map((r) => [r.id, r.status]));
  assert.equal(rows.a, "fixed");
  assert.equal(rows.b, "worse");
  assert.equal(rows.c, "ok");
});

test("the library postures are all assessed without error", () => {
  let n = 0;
  for (const p of POSTURES) {
    try {
      const e = expandPosture(p);
      const pl = placePose(body, { root: e.root, angles: e.angles }, { support: p.support });
      assessPosture(body, { root: { ...e.root, ...pl }, angles: e.angles }, { seated: seatedOf(p) });
      n++;
    } catch (err) { if (!/does not|no seat|needs/i.test(String(err.message))) throw err; }
  }
  assert.ok(n > POSTURES.length * 0.9, `${n} of ${POSTURES.length} assessed`);
});

test("the library cards' verdict: a stooped lift is not acceptable, a relaxed stance is acceptable, and the result is memoised", () => {
  assert.equal(postureVerdict(body, byId("lift-stoop-start")).verdict, "not-acceptable");
  assert.equal(postureVerdict(body, byId("stand-relaxed")).verdict, "acceptable");
  const p = byId("lift-stoop-start");
  assert.strictEqual(postureVerdict(body, p), postureVerdict(body, p), "memoised per posture and body");
});
