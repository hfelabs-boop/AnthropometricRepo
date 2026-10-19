// Khronos glTF-Validator (npm gltf-validator; GLTF_VALIDATOR=<dir of the package>) on every GLB flavour, with scene objects, attached objects and odd object names.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
const cand = [process.env.GLTF_VALIDATOR, "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad/validator/node_modules/gltf-validator"].filter(Boolean);
const dir = cand.find((c) => fs.existsSync(c));
const V = dir ? (await import(pathToFileURL(`${dir}/index.js`).href)).default ?? (await import(pathToFileURL(`${dir}/index.js`).href)) : null;
const profile = H.army("F", 5);

test("gltf-validator: no error or warning for any GLB flavour", { skip: !V }, async () => {
  const rig = H.makeRig(profile);
  const { sandbox, ctx } = H.sceneFixture(rig);
  const names = ["Crate", "Crate", "pelvis", "skin", "a\nb", "é", "", "x".repeat(200)];
  const cat = (await import("../../site/js/human/catalog.js")).CATALOG.map((t) => t.type);
  cat.forEach((t, i) => sandbox.add(t, { position: [i * 0.3 - 3, 0, 1.5], yaw: i * 17, name: names[i % names.length] || undefined }));
  const all = [...sandbox.objects.values()];
  all[0].visible = false; all[0].group.visible = false;
  for (const def of [H.POSTURES.neutral, H.POSTURES.squat, H.POSTURES.supine]) {
    H.putPose(rig, def);
    for (const o of [{ pose: "baked" }, { pose: "clip" }, { figure: "skeleton" }, { figure: "skeleton", pose: "clip" }, { figure: "none", scene: true }, { scene: true }, { scene: true, pose: "clip", measurements: true }]) {
      const out = await X.buildGLB({ rig, profile, posture: { id: def.id, name: def.name }, sandbox, measurements: [{ id: "m", kind: "distance", label: "d", value: 123.4, unit: "mm" }] }, o);
      const r = await V.validateBytes(new Uint8Array(out.data), { maxIssues: 50 });
      const bad = r.issues.messages.filter((m) => m.severity <= 1);
      if (bad.length) console.log(def.id, JSON.stringify(o), bad.slice(0, 5).map((m) => `${m.code} ${m.pointer} ${m.message}`));
      assert.equal(r.issues.numErrors, 0, `${def.id} ${JSON.stringify(o)}: ${JSON.stringify(r.issues.messages.slice(0, 3))}`);
      assert.equal(r.issues.numWarnings, 0, `${def.id} ${JSON.stringify(o)} warnings: ${JSON.stringify(r.issues.messages.filter((m) => m.severity === 1).slice(0, 3))}`);
    }
  }
});
