// The fallback body: a BodyModel of a typical adult of a given stature and form, for tests, demos and as the last resort of the build
// pipeline (state.js) when the fit of a real profile fails.
//
// It is NOT a second hand-made model. An earlier version had its own joint and landmark tables (91 landmark ids against fit.js's 120, other
// contact sets, other foot-sole geometry); every panel, measurement preset or placement keyed on fit.js ids then threw "unknown landmark id"
// the moment the fallback kicked in, and the skeleton builders were only ever exercised on proportions that fit.js does not produce. Now the
// fallback is fitBody() of a profile that contains nothing but stature and mass, so it has exactly the shape of every other body: same joint
// table, landmark ids, contact sets, masses, shape stations and fit report. Stature, mass and form follow the arguments.
//
// The body also carries a few landmark ids of the first synthetic body (asis_L, palm_L, ball_L, ...) as aliases of fit.js landmarks or of
// small offsets from them (LEGACY below): a superset of fit.js ids never hurts a consumer, and it keeps older code and tests working.
//
// Pure: imports fit.js (itself pure).
import { fitBody } from "./fit.js";

// body mass index by form: the mean adult body mass index of the ANSUR II men and women, rounded; the neutral form sits between them
const BMI = { male: 24.5, female: 22.5, neutral: 23.5 };
const SEX = { male: "M", female: "F", neutral: "both" };

// Legacy ids of the first synthetic body. Paired ones (name_L / name_R): either a copy of a fit.js landmark under the old name ("of"; the
// fit.js landmark keeps its own id too), or a landmark placed by an offset (m at 1.75 m, scaled with stature) from a joint. Only ids that
// fit.js lacks are added. NOTE heel_L is deliberately not here: fit.js has it with another meaning (pternion) and the fallback must agree.
const LEGACY = {
  asis: { of: "ASIS" }, psis: { of: "PSIS" }, thigh_back: { of: "thigh_under" }, palm: { of: "palm_centre" }, grip: { of: "grip_centre" },
  ball: { of: "ball_sole_medial" }, ball_outer: { of: "ball_sole_lateral" }, lateral_epicondyle: { of: "epicondyle_lateral" },
  medial_epicondyle: { of: "epicondyle_lateral", flipX: true, label: "medial epicondyle of the femur" },
  buttock: { of: "buttock_extremity", xFrom: "ischial" },
  lateral_humeral_epicondyle: { joint: "elbow", off: [0.037, 0.005, 0], label: "lateral epicondyle of the humerus", group: "arm", kind: "bony" },
  medial_humeral_epicondyle: { joint: "elbow", off: [-0.035, 0.005, 0], label: "medial epicondyle of the humerus", group: "arm", kind: "bony" },
  ulnar_styloid: { joint: "wrist", off: [-0.004, -0.002, -0.024], label: "ulnar styloid", group: "arm", kind: "bony" },
  knuckle: { joint: "wrist", off: [0.0083, -0.0798, 0], label: "middle knuckle (metacarpale III)", group: "hand", kind: "bony" },
  calf_back: { joint: "knee", off: [0, -0.120, -0.058], label: "calf (back, mid)", group: "leg", kind: "surface" },
  tibial_tuberosity: { joint: "knee", off: [0, -0.040, 0.044], label: "tibial tuberosity", group: "leg", kind: "bony" },
};
// midline ones: a landmark placed relative to another landmark ("from", + add) or to the joint ("off")
const LEGACY_MID = {
  symphysis: { joint: "pelvis", from: "crotch", add: [0, 0.04, 0.09], label: "Pubic symphysis (skin)", group: "pelvis", kind: "bony" },
  sacrum_back: { joint: "pelvis", add: [0, 0.05, -0.075], label: "Back of the sacrum", group: "pelvis", kind: "surface" },
};

function addLegacy(body, s) {
  const L = body.landmarks, r6 = (v) => Math.round(v * 1e6) / 1e6;
  const put = (id, l) => { if (!L[id]) L[id] = l; };
  for (const [name, d] of Object.entries(LEGACY)) {
    for (const sd of ["L", "R"]) {
      const side = sd === "L" ? "Left" : "Right", sx = sd === "L" ? 1 : -1;
      if (d.of) {
        const src = L[`${d.of}_${sd}`] ?? L[d.of];
        if (!src) continue;
        const off = [...src.offset];
        if (d.flipX) off[0] = -off[0];
        if (d.xFrom) off[0] = sx * Math.abs(L[`${d.xFrom}_L`].offset[0]);
        put(`${name}_${sd}`, { ...src, offset: off, label: `${side} ${d.label ?? src.label.replace(/^(Left|Right) /, "")}` });
      } else {
        const o = d.off.map((c) => r6(c * s));
        put(`${name}_${sd}`, { joint: `${d.joint}_${sd}`, offset: [sx * o[0], o[1], o[2]], label: `${side} ${d.label}`, group: d.group, kind: d.kind });
      }
    }
  }
  for (const [id, d] of Object.entries(LEGACY_MID)) {
    const base = d.from ? L[d.from].offset : [0, 0, 0];
    put(id, { joint: d.joint, offset: base.map((c, i) => r6(c + d.add[i] * s)), label: d.label, group: d.group, kind: d.kind });
  }
}

/**
 * @param {number} statureM stature in metres (default 1.75)
 * @param {"male"|"female"|"neutral"} form body form
 * @returns a fit.js BodyModel (see docs/human3d/MODEL.md) with `synthetic: true` and an extra warning saying that it is a generic body
 */
export function syntheticBody(statureM = 1.75, form = "male") {
  if (!(Number.isFinite(statureM) && statureM > 0.5 && statureM < 2.6)) throw new RangeError(`syntheticBody: stature ${statureM} m is not plausible`);
  if (!(form in BMI)) throw new RangeError(`syntheticBody: unknown form "${form}"`);
  const mass = Math.round(BMI[form] * statureM * statureM * 10) / 10;
  const profile = {
    id: `generic:${form}:${Math.round(statureM * 1000)}`, label: `Generic ${form} body, ${Math.round(statureM * 1000)} mm`, sex: SEX[form],
    source: { kind: "manual" }, notes: [],
    measures: { stature: { value: Math.round(statureM * 10000) / 10, unit: "mm", status: "reported" }, mass: { value: mass, unit: "kg", status: "estimated" } },
  };
  const body = fitBody(profile, { form });
  addLegacy(body, statureM / 1.75);
  body.synthetic = true;
  body.warnings = [...body.warnings, "This is a generic body of this stature: only the stature is the person's, every other dimension is typical."];
  return body;
}
