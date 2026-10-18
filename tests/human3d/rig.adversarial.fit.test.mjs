// rig.js against REAL BodyModels from fit.js (not the synthetic body): contract of masses/contacts/landmarks, skeleton geometry sanity, agreement.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { fitBody } from "../../site/js/human/fit.js";
import { buildRig } from "../../site/js/human/rig.js";
import { JOINTS, BONES } from "../../site/js/human/skeleton.js";

const P = (stature, sex = "M", mass, extra = {}) => ({ id: `t:${sex}:${stature}`, label: "test", sex, source: { kind: "manual" }, notes: [], measures: { stature: { value: stature, unit: "mm", status: "reported" }, ...(mass ? { mass: { value: mass, unit: "kg", status: "reported" } } : {}), ...extra } });
const cases = [P(1750, "M", 78), P(1500, "F", 45), P(1950, "M", 120), P(1620, "F", 95), P(1400, "both", 40), P(2050, "M", 70)];

test("rig on real fit.js bodies: builds, agrees with kinematics, finite bones, masses / contacts / COM / lowestY", () => {
  for (const prof of cases) {
    const b = fitBody(prof);
    const rig = buildRig(b);
    const tag = prof.id;
    // masses
    const com = rig.centerOfMass();
    assert.ok(Number.isFinite(com.mass) && com.mass > 0 && Math.abs(com.mass - b.mass) / b.mass < 0.1, `${tag}: com mass ${com.mass} vs ${b.mass}`);
    const frac = com.point.y / b.stature;
    assert.ok(frac > 0.5 && frac < 0.64, `${tag}: COM height fraction ${frac}`);
    for (const set of Object.keys(b.contacts)) { const pts = rig.contactPoints(set); assert.ok(pts.length && pts.every((p) => Number.isFinite(p.x + p.y + p.z)), `${tag} ${set}`); }
    console.log(tag, "contact sets", Object.keys(b.contacts).join(","), "lowestY", rig.lowestY().toFixed(5), "COM", com.point.toArray().map((x) => x.toFixed(3)).join(","), "mass", com.mass.toFixed(1));
    assert.ok(Math.abs(rig.lowestY()) < 0.01, `${tag}: neutral lowest ${rig.lowestY()}`);
    // bones
    for (const m of rig.view.boneMeshes) for (const v of m.geometry.attributes.position.array) assert.ok(Number.isFinite(v), `${tag} ${m.name}`);
    // poses: agreement
    const angles = {}; for (const j of JOINTS) angles[j.id] = j.dof.map((d) => d.max);
    rig.setPose({ root: { y: 0.4, flex: -90, heading: 180 }, angles }, { clamp: false });
    rig.group.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    for (const [id, bone] of rig.bones) { bone.getWorldPosition(p); assert.ok(p.distanceTo(rig.jointWorld(id)) < 1e-9, `${tag} ${id}`); }
    // bones within the body's reach
    rig.dispose();
  }
});

test("contacts format of fit.js vs what rig.js accepts: entries are strings or {joint, offset}", () => {
  const b = fitBody(P(1750, "M", 78));
  for (const [k, set] of Object.entries(b.contacts)) for (const c of set) assert.ok(typeof c === "string" ? b.landmarks[c] : (c.joint && c.offset), `${k}: ${JSON.stringify(c)}`);
  const m = b.masses; console.log("masses sample:", JSON.stringify(Object.entries(m)[0]));
  const l = b.landmarks.heel_L; console.log("landmark sample:", JSON.stringify(l));
});

test("CONTRACT: buildRig(fitBody(profile)) works as is (fit.js masses = { total, fractionSum, com, segments: {...} })", () => {
  const b = fitBody(P(1750, "M", 78));
  const rig = buildRig(b); // currently throws: buildRig: body.masses[total] needs { mass (kg), com: { joint, offset } }
  assert.ok(Math.abs(rig.centerOfMass().mass - 78) < 1);
  rig.dispose();
});
