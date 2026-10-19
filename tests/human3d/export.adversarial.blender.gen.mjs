// Writes the files for tests/human3d/export.adversarial.blender.py: node --import ./tests/human3d/register.mjs tests/human3d/export.adversarial.blender.gen.mjs <outdir>
import fs from "node:fs";
import * as H from "./export.adversarial.helpers.mjs";
import * as X from "../../site/js/human/export.js";
const out = process.argv[2], profile = H.army("M", 50), rig = H.makeRig(profile);
H.putPose(rig, H.POSTURES.squat);
rig.setPose({ ...rig.getPose(), angles: { ...rig.getPose().angles, shoulder_L: [70, 20, 10], elbow_R: [90] } }, { clamp: true });
const inp = { rig, profile, posture: { id: "t", name: "Squat" } };
const w = (n, d) => fs.writeFileSync(`${out}/${n}`, typeof d === "string" ? d : Buffer.from(d));
w("baked.glb", (await X.buildGLB(inp, { pose: "baked" })).data);
w("clip.glb", (await X.buildGLB(inp, { pose: "clip" })).data);
w("skel.glb", (await X.buildGLB(inp, { figure: "skeleton" })).data);
for (const axes of ["y-up", "z-up", "x-front"]) {
  w(`mesh_${axes}.obj`, (await X.buildOBJ(inp, { axes })).text);
  w(`mesh_${axes}.stl`, (await X.buildSTL(inp, { axes })).data);
}
w("mesh_m.obj", (await X.buildOBJ(inp, { unit: "m" })).text);
for (const unit of ["cm", "mm", "m"]) w(`skel_${unit}.bvh`, X.buildBVH(inp, { unit, neutralFrame: true }).text);
w("skel_hdr.bvh", X.buildBVH(inp, { header: true }).text);
const joints = Object.fromEntries(H.JOINTS.map((j) => [j.id, rig.jointWorld(j.id).toArray()]));
const sk = X.bakeSkin(rig)[0].geometry; sk.computeBoundingBox();
w("truth.json", JSON.stringify({ joints, bbox: [sk.boundingBox.min.toArray(), sk.boundingBox.max.toArray()], nverts: sk.getAttribute("position").count }));
