import * as P from "../../site/js/human/panels/profile.js";
import * as anthro from "../../site/js/human/anthro.js";
import { fitBody } from "../../site/js/human/fit.js";
import { JOINT_BY_ID } from "../../site/js/human/skeleton.js";
for (const sex of ["M", "F", "both"]) {
  const p = P.finalizeProfile(anthro.manualProfile({ sex, stature: 1700, mass: 70 }), {});
  const b = fitBody(p, { form: P.defaultForm(p) });
  const rows = P.dimensionRows(b, p);
  const miss = [];
  for (const r of rows) {
    if (!r.target) { miss.push(r.id + " no target"); continue; }
    if (r.target.joint && !JOINT_BY_ID[r.target.joint]) miss.push(r.id + " bad joint " + r.target.joint);
    if (r.target.landmark && !b.landmarks[r.target.landmark]) miss.push(r.id + " bad landmark " + r.target.landmark);
  }
  const ids = new Set(rows.map((r) => r.id));
  const stale = Object.keys(P.DIM_TARGET).filter((k) => !ids.has(k));
  // do target landmarks lie near where the dimension is? print a few
  console.log(sex, "rows", rows.length, "problems", miss, "DIM_TARGET ids not in body.dims:", stale);
  // landmark vs dimension plausibility for lengths measured at a landmark
  const lm = (id) => b.landmarks[id], pos = (id) => b.positions?.[lm(id).joint];
  const v = (id) => { const l = lm(id); const j = b.positions[l.joint]; return [j[0] + l.offset[0], j[1] + l.offset[1], j[2] + l.offset[2]]; };
  if (sex === "M") {
    console.log("vertex y", v("vertex")[1], "stature", b.stature);
    console.log("acromion_L x", v("acromion_L")[0], "acromion_halfwidth", rows.find((r) => r.id === "acromion_halfwidth").value);
    console.log("olecranon_L y", v("olecranon_L")[1], "olecranon_drop", rows.find((r) => r.id === "olecranon_drop").value, "shoulder y", b.positions.shoulder_L[1]);
    console.log("popliteal_L y", v("popliteal_L")[1], "popliteal_below_knee", rows.find((r) => r.id === "popliteal_below_knee").value);
    console.log("ischial_L y", v("ischial_L")[1], "hip_to_seat", rows.find((r) => r.id === "hip_to_seat").value, "hip y", b.positions.hip_L[1]);
  }
}
