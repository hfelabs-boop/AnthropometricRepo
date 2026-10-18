// Profile -> body model: turns the measures of an anthropometric Profile (any subset, in the data's units mm and kg) into everything the
// rig needs: the 77 neutral joint centres, named landmarks, contact sets, lofting data for the skin, segment masses and a fit report that
// compares every measure the model can evaluate with the profile. Pure: imports only skeleton.js and fk.js, never touches the DOM.
// Contract: docs/human3d/DESIGN.md 2.2; derivations, constants and sources: docs/human3d/MODEL.md (read it before changing a constant).
//
// How the fit is organised (the order of precedence is the order of the code):
//   1. inputs      readInputs()          mm / kg -> m / kg, aliases, plausibility screen (|z| > 6 SD of the regression below: ignored)
//   2. dimensions  DEFS / resolve()      every skeleton DIMENSION is resolved from the profile by an ordered list of routes (most direct
//                                         measure first); a dimension without a usable route is ESTIMATED from stature, mass and sex
//                                         (regressions on the 13,792 real subjects of database/anthro.sqlite, table REG below). The
//                                         routes that were not used but could have been are kept as `alt` (a check with its delta).
//   3. layout      layout()              joint centres: legs, pelvis, spine curve (lordosis / kyphosis baked in), arms, hands, head
//   4. landmarks   landmarks()           bony / surface landmarks placed so that the standard measure definitions evaluate to the profile
//   5. shape       shape()               girth rings (superellipses) for the skin generator; an `adiposity` scalar closes the mass
//   6. masses      masses()              de Leva (1996) segment masses and centres of mass
//   7. report      evaluateMeasures()    the measures re-measured on the built model in their reference postures
// Conventions: metres, kilograms, degrees; +Y up, +Z anterior, +X is the figure's LEFT; `_L` joints/landmarks are on +X, the right side
// is the mirror image (x -> -x).
import { JOINTS, mirrorId } from "./skeleton.js";
import { Kinematics } from "./fk.js";

// ---------------------------------------------------------------------------------------------------------------------
// Regression tables. Source: database/anthro.sqlite (13,792 real adults: ANSUR 1988, ANSUR II 2012, ASRAN 2015, USAF 1967; men 9,366,
// women 4,426), ordinary least squares per sex on  value[mm] = a + bs * stature[mm] + bm * mass[kg]. Row = [men, women], each
// [a, bs, bm, residual SD (mm), n] or null. Keys are the profile keys without the `other:` prefix; the measures that the table `subjects`
// does not have (profile keys `other:...`: waist breadth, hip breadth, malleolus height, ...) were taken from the survey tables raw_*
// (ANSUR 1988 + II, plus ASRAN / USAF where they have the measure), hence their smaller n. Reproduced by tests/human3d/fit.test.mjs.
const REG_DATA = {
  abdominal_depth_sitting: [[317.7,-0.1589,2.553,18.6,6944],[283.4,-0.1428,2.707,17,4426]],
  acromion_height: [[-76.6,0.8449,0.3846,16.5,9364],[-74.3,0.8519,0.3175,14.1,4426]],
  acromion_height_sitting: [[122.5,0.2532,0.4206,22.1,5282],[87.1,0.2683,0.5167,21.2,2440]],
  acromion_radiale_length: [[6.8,0.1807,0.1118,12.2,9362],[-11.8,0.1937,0.1126,10.7,4426]],
  ankle_circumference: [[153.1,0.004364,0.7996,9.8,9362],[140.4,0.005792,0.9407,11.1,4426]],
  axilla_height: [[-150.8,0.8416,-0.007222,15.2,5856],[-122.9,0.8346,-0.00729,14,4194]],
  ball_of_foot_length: [[40.7,0.08194,0.1729,7.9,6939],[32.4,0.08189,0.227,7,4426]],
  biacromial_breadth: [[229.9,0.07,0.6742,16.4,9362],[153,0.1125,0.4222,14.8,4426]],
  biceps_circumference_flexed: [[382,-0.1291,2.325,18.4,9364],[343.8,-0.1461,2.89,13.5,4426]],
  bicristal_breadth: [[103.4,0.06174,0.794,15.2,7588],[153.5,0.01861,1.322,16.1,2218]],
  bideltoid_breadth: [[443.6,-0.07268,2.218,16.1,9364],[364.6,-0.04917,2.41,14,4425]],
  bimalleolar_breadth: [[30.9,0.01927,0.113,3.3,5856],[29.4,0.01657,0.1426,2.8,4194]],
  bizygomatic_breadth: [[135.6,-0.007746,0.243,5.1,9364],[123.5,-0.004809,0.259,4.9,4426]],
  buttock_circumference: [[787.7,-0.1286,5.372,24.3,9364],[827.4,-0.1827,7.149,28.6,4425]],
  buttock_depth: [[238.7,-0.07712,1.728,12.4,8276],[246.4,-0.0963,2.167,11.8,4194]],
  buttock_height: [[-187.6,0.6196,-0.1461,25.7,8276],[-121.5,0.583,0.1232,25.2,4194]],
  buttock_knee_length: [[89.2,0.2568,0.8699,17.2,9364],[92.7,0.2555,1.234,17.9,4426]],
  buttock_popliteal_length: [[18.9,0.2576,0.3469,17.9,9357],[25.5,0.2549,0.6437,18.5,4425]],
  calf_circumference: [[351.9,-0.07534,2.006,15.5,9362],[306,-0.0609,2.41,16.5,4426]],
  cervicale_height: [[-38.6,0.8698,0.2967,13.1,9364],[-87.6,0.9177,-0.08591,12.2,4426]],
  chest_breadth: [[154.3,0.05105,0.7894,25.8,9364],[201,-0.003686,1.241,16.2,4426]],
  chest_circumference: [[1046,-0.3178,6.534,34.2,9364],[965.5,-0.3103,7.181,38.6,4426]],
  chest_depth: [[243.4,-0.0783,1.757,12.5,9364],[269.5,-0.1056,2.251,14.1,4426]],
  chest_height: [[-87.3,0.7732,0.1673,18.7,8276],[-156,0.8357,-0.4966,21.2,4194]],
  crotch_height: [[-211.4,0.6136,-0.2742,23.5,9343],[-192.1,0.5992,-0.1067,24.3,4418]],
  ear_length: [[43.7,0.008481,0.07542,4.3,9364],[41.2,0.008608,0.06663,3.7,4425]],
  elbow_rest_height: [[156.6,0.02296,0.5496,27.3,9364],[156.3,0.02218,0.526,26.4,4426]],
  eye_height_sitting: [[169.8,0.3511,0.1771,22.2,9364],[151.2,0.3553,0.2032,21.8,4426]],
  foot_breadth: [[59.7,0.01375,0.2001,4.5,9364],[55.3,0.01248,0.2382,4.3,4426]],
  foot_circumference: [[132.2,0.04523,0.4723,9.7,5856],[121.1,0.04224,0.5519,9.2,4194]],
  foot_length: [[52.1,0.1152,0.1857,8.9,9361],[45.6,0.1124,0.2533,8.6,4426]],
  forearm_circumference_flexed: [[256.9,-0.03317,1.293,12.6,9363],[222.4,-0.03789,1.51,10.2,4426]],
  forearm_forearm_breadth: [[594.4,-0.1767,3.384,28.1,9364],[460.4,-0.1299,3.578,23.1,4426]],
  gluteal_furrow_height: [[-191.6,0.5786,-0.224,22.3,4194],[-184.8,0.5826,-0.3244,24,2208]],
  hand_breadth: [[47.2,0.0187,0.1062,3.7,9361],[40.3,0.01986,0.09407,3.3,4426]],
  hand_circumference: [[119.5,0.03918,0.2997,8.4,9360],[106.1,0.03607,0.3288,7.1,4425]],
  hand_length: [[45.6,0.07841,0.1043,7.4,9362],[36.6,0.08251,0.1401,8,4426]],
  head_breadth: [[140,0.001358,0.1543,5.8,9362],[133.5,0.0003848,0.192,5.5,4426]],
  head_circumference: [[472.2,0.03433,0.4938,13.6,9364],[463.7,0.02598,0.7265,16.4,4426]],
  head_length: [[148.8,0.02152,0.1481,6.4,9363],[138.1,0.02379,0.1792,6.4,4426]],
  heel_ankle_circumference: [[120.4,0.09634,0.6307,10.3,5856],[116.5,0.08751,0.7467,10.3,4194]],
  heel_breadth: [[54.2,-0.00007315,0.2124,4.7,5856],[51.4,-0.003351,0.2942,4.6,4194]],
  hip_breadth: [[195,0.02629,1.288,13.9,8276],[248.7,-0.02267,2.104,14.5,4194]],
  hip_breadth_sitting: [[243.9,-0.01227,1.872,14.4,9363],[298.9,-0.04965,2.681,17.1,4426]],
  iliocristale_height: [[-179.2,0.7246,-0.3122,22.5,9363],[-125.5,0.6782,0.1865,20.3,4426]],
  interpupillary_breadth: [[55.3,0.001775,0.06563,3.5,9360],[49.3,0.005658,0.05371,3.6,4423]],
  knee_circumference: [[255.1,-0.002921,1.74,11.4,5276],[244.2,-0.01589,2.375,13.1,2438]],
  knee_height_midpatella: [[-125.7,0.3608,-0.1734,16.9,5856],[-111.2,0.3532,-0.1548,15,4194]],
  knee_height_sitting: [[-51.6,0.3348,0.2094,12.9,9364],[-54.5,0.3393,0.2281,13.5,4425]],
  lateral_femoral_epicondyle_height: [[-104.8,0.3472,-0.1221,14.1,5856],[-69,0.3201,0.1692,14.9,4194]],
  lateral_malleolus_height: [[14.5,0.02612,0.1287,5.4,5856],[9.8,0.0297,0.05272,4.8,4194]],
  lower_thigh_circumference: [[343.4,-0.06909,2.182,14.4,5856],[343.2,-0.09517,3.095,17.2,4194]],
  menton_sellion_length: [[78.3,0.01982,0.1081,6.4,9355],[73.1,0.02024,0.1119,5.7,4426]],
  neck_circumference: [[380.1,-0.07134,1.663,15.1,9359],[284.6,-0.03874,1.567,12.5,4425]],
  neck_circumference_base: [[349.5,-0.02896,1.551,18,6944],[271.8,-0.01015,1.598,15.4,4426]],
  omphalion_height: [[-189.3,0.7285,-0.4176,20.1,8276],[-202.8,0.7472,-0.5141,19.6,4194]],
  palm_length: [[29.3,0.04578,0.07873,4.9,4082],[27,0.04603,0.09874,4.7,1986]],
  popliteal_height: [[-127.4,0.3357,-0.3868,12.7,9361],[-132.9,0.3418,-0.5442,13.3,4426]],
  radiale_stylion_length: [[-4.5,0.1532,0.03164,10.8,9362],[-17.4,0.1579,0.0383,11.3,4426]],
  shoulder_circumference: [[856.5,0.00008633,3.91,35.1,8276],[718.4,0.02859,4.056,31.6,4194]],
  shoulder_elbow_length: [[2.8,0.2017,0.06817,11.7,8276],[-20.5,0.2172,0.02722,10.2,4194]],
  shoulder_length: [[29,0.07641,-0.1163,12.5,9364],[33.2,0.07131,-0.1432,10.8,4426]],
  sitting_height: [[202.8,0.402,0.1354,22.1,9364],[197.8,0.3963,0.1768,22.3,4426]],
  sleeve_outseam: [[-48,0.3689,-0.04479,18.8,6942],[-43.9,0.3587,0.07844,18.7,4426]],
  span: [[70.5,0.9777,0.3525,47.9,5856],[3.3,1.01,0.2731,49.2,4194]],
  suprasternale_height: [[-44.7,0.8294,0.2963,13.1,9363],[-59.2,0.842,0.2635,10.9,4426]],
  thigh_circumference: [[592.7,-0.1897,4.266,21.8,9222],[569.4,-0.1963,5.38,21,4378]],
  thigh_clearance: [[171.9,-0.05166,1.132,8.9,9364],[149.3,-0.04109,1.248,7.7,4426]],
  thumbtip_reach: [[112.7,0.3632,0.645,31.9,9360],[88.9,0.3695,0.7234,28.7,4426]],
  tragion_top_of_head: [[103.2,0.01396,0.03998,6,4082],[98.2,0.01328,0.0983,6.3,1986]],
  trochanterion_height: [[-226.8,0.6768,-0.5749,26.6,9356],[-129.6,0.6128,-0.2305,24.8,4426]],
  vertical_trunk_circumference: [[655.8,0.3628,4.482,43.5,8276],[716.4,0.3077,5.043,38.4,4194]],
  waist_breadth: [[285.3,-0.09157,2.363,14.7,8276],[291,-0.1068,2.743,18.4,4194]],
  waist_circumference: [[971.9,-0.4145,8.102,42.4,9364],[961.3,-0.4585,9.434,48.9,4426]],
  waist_depth: [[279.8,-0.1327,2.254,15.2,8276],[284.4,-0.1523,2.655,16.2,4194]],
  wrist_circumference: [[93.3,0.02713,0.4284,7,9362],[81.1,0.02531,0.4773,5.5,4426]],
  wrist_height: [[-61.6,0.5021,0.3653,21.5,8276],[-19.3,0.485,0.331,20.1,4194]],
  wrist_to_grip: [[19,0.02272,0.1709,6.3,2862],[29.5,0.01843,0.1161,5.1,2439]],
  wrist_to_thumbtip: [[44.9,0.0449,-0.03616,7.8,2862],[32.7,0.05251,-0.03261,7.1,2439]],
};
const REL_DATA = {
  hip_over_crotch: [[66.3,25,9337],[71.5,20.5,4418]],
  seat_below_hip: [[73.7,23.7,9356],[74.5,16.4,4426]],
  bkl_minus_femur: [[207.9,25.2,5856],[204.2,24.3,4194]],
  bkl_minus_bpl: [[112.1,13.7,9359],[106.7,9.9,4425]],
  knee_top_over_knee: [[60.9,9.2,5856],[50.1,9.8,4194]],
  knee_over_popliteal: [[63.6,9.9,5856],[74.5,11.6,4194]],
  midpatella_over_knee: [[-1.3,9.3,5856],[-9.3,10.5,4194]],
  cervicale_over_suprasternale: [[77.3,13.8,9365],[72.5,13.1,4426]],
  cervicale_over_acromion: [[74.5,14.7,9366],[67.8,15.1,4426]],
  olecranon_drop: [[40.9,5.6,8276],[35.5,4.8,4194]],
  fhl_minus_hand_rsl: [[19.5,6.3,5856],[18.3,5.9,4194]],
  vertex_to_eye: [[119.4,12.1,9364],[111.7,8.8,4426]],
  eye_over_tragion: [[-17.4,8.1,4082],[-17.5,7.8,1986]],
  iliocristale_over_hip: [[158.7,20.3,9357],[143,20.7,4426]],
  omphalion_over_hip: [[146.3,25.5,8276],[132.3,22.2,4194]],
  buttock_over_trochanter: [[-26.5,19.7,8276],[-17.7,13.6,4194]],
  gluteal_over_trochanter: [[-122.3,15.4,4194],[-117.3,13.8,2208]],
  hip_over_hipbr_ratio: [[0.9232,0.028,8276],[0.8901,0.0285,4194]],
  wrist_below_arm: [[-11.5,12.8,8276],[-11.9,10.8,4194]],
  ball_ratio: [[0.7367,0.0161,6941],[0.7365,0.0134,4426]],
  deltoid_extent: [[44.7,11.7,9364],[38.6,11.1,4425]],
};

// lookup tables are prototype-free: a profile key such as "constructor" or "__proto__" must not find an inherited member
const REG = Object.create(null);
for (const [k, [m, w]] of Object.entries(REG_DATA)) {
  const row = (r) => r && { a: r[0], bs: r[1], bm: r[2], sd: r[3], n: r[4] };
  REG[k] = { M: row(m), F: row(w) };
}
// Relations between measures that the geometry needs (men, women): [mean mm, SD mm, n] from the same subjects, with the model's own constants
// (hip joint centre = trochanterion - 5 mm, radiale 12 mm below the elbow centre, ...). They are means, not regressions: against stature and
// mass their R2 is below 0.1 except where noted in MODEL.md. Reproduced by the test from the database.
/** The regression table (men, women): { key: [[a, bs, bm, SD mm, n], [...]] }, and the relation table { name: [[mean, SD, n], [...]] }: documented in MODEL.md, reproduced by the tests. */
export const REGRESSIONS = REG_DATA, RELATIONS = REL_DATA;
const REL = Object.create(null);
for (const [k, [m, w]] of Object.entries(REL_DATA)) REL[k] = { M: m, F: w };

// Mass the model supports (kg), and the BMI range of the people the regressions were fitted on (BMI P0.5 to P99.5 of the database, see MODEL.md 2.1).
const MASS_RANGE = [25, 300];
const BMI_FIT = [16, 40];
// Median BMI of the same 13,792 people (men 26.2, women 24.0 kg/m2): the mass of a profile without mass or BMI.
const BMI_MEDIAN = { M: 26.16, F: 24.04 };
// Median stature (mm) of the same people, used only when a profile has no usable length at all.
const STATURE_DEFAULT = { M: 1.764, F: 1.629 };

// ---------------------------------------------------------------------------------------------------------------------
// Constants of the model. Every offset between a joint centre and the landmark a survey measures to is here, with its source.
// "approx." = could not be verified against the original paper while writing; the values are physically reasonable and tested only
// for consistency (MODEL.md section 3 lists them with the reasoning).
const K = {
  hjcAboveTroch: -0.005,    // hip joint centre vs the trochanterion (top of the greater trochanter, palpated on the skin). Radiographic studies found by search
                            // (papers not opened, so not cited) put the tip of the trochanter about 3 to 8 mm ABOVE the femoral head centre (one study 10 mm below);
                            // the skin adds a few mm: the centre is taken 5 mm below the landmark (approx.; Winter 2009 puts the hip at the trochanter)
  asis: 0.87,               // inter-ASIS distance / bicristal breadth (approx.; the iliac crest is wider than the ASIS)
  radialeBelowElbow: 0.012, // radiale (top of the radial head) below the elbow axis (approx.)
  elbowWristOverRadialeStylion: 0.031, // elbow-wrist length minus radiale-stylion length (approx.: US aircrew, pilots and navigators P50 files, the only ones that report both: 29.4 to 31.5 mm)
  ghBelowAcromion: 0.035,   // glenohumeral centre below the acromion tip: de Leva's upper arm (282 mm) vs ANSUR acromion-radiale (327 mm) (approx.)
  ghInsideAcromion: 0.05,  // ... and medial to it (approx.; with the arms raised to the horizontal the span of a profile without a span is unbiased within 10 mm: MODEL.md 4.5)
  ghAhead: 0.015,           // glenohumeral centre ahead of the C7/T1 centre in the standing posture (approx.)
  // The survey thumbtip reach is measured against a wall, to the thumb tip (some surveys: with the thumb pinching the index finger; the exact definition could not be
  // verified). The model's thumb is extended and its trunk rigid, so a profile without a reach had a model reach 25 mm (men) / 33 mm (women) too long on average. This is the
  // setback of the thumb tip in the definition, CALIBRATED on the 13,792 people (pooled bias of stature-and-mass profiles -3 / -1 mm; MODEL.md 4.5):
  reachSetbackMen: 0.0275,
  reachSetbackWomen: 0.033,
  c7BelowCervicale: 0.015,  // C7/T1 disc centre below the C7 spinous tip (approx.)
  l5BelowIliocristale: 0.035, // L5/S1 below the iliac crest line (L4/L5 level) (approx.)
  ocBelowTragion: 0.018,    // occiput-C1 axis below the tragion (approx.)
  patellaAhead: 0.07,       // patella front (skin) ahead of the knee axis with the knee flexed 90 degrees (approx.; 52 mm standing, more when flexed)
  spineBack: { lumbar: 0.095, thoracic: 0.095, cervical: 0.052 }, // vertebral body centre to the skin of the back (approx.; the lumbar value is also tuned so that the
                            // abdominal depth sitting, measured against a wall, is 20 mm more than the standing waist depth as in the surveys)
  // spine curve: angles of the vertebral centre line from the vertical, + = leaning forward going up
  t1Slope: 24,              // T1 upper end plate slope (approx.; healthy adults about 25 degrees)
  kyphosis: 38,             // T1-T12 Cobb angle: mean 36.0 +- 10.1 in Yukawa et al. 2018 (626 asymptomatic Japanese adults, via search summary; paper not opened);
                            // 38 is 2 degrees above that mean (0.2 SD), the rounding is approx.
  lordosis: 50,             // T12-S1 lumbar lordosis: 49.7 +- 11.2 (same cohort)
  cervical: 18,             // total lordotic change from C7/T1 to the occiput-C1 joint (approx.; C2-C7 4 degrees in the Yukawa cohort, 14-20 elsewhere)
  sva: 0.02,                // C7/T1 centre ahead of the L5/S1 centre (sagittal vertical axis, approx.; healthy adults 0 +- 25 mm)
  l5Behind: 0.025,          // L5/S1 centre behind the hip joint centres (pelvic tilt 14.5 degrees, pelvic radius ~0.1 m; Yukawa tilt, approx.)
  // vertebral level pitch (vertebra + disc) relative weights, L5 vertebra first ... T1; then C7 ... C1
  pitchTrunk: [1.0, 1.02, 1.02, 1.0, 0.98, 0.84, 0.82, 0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66, 0.64, 0.62],
  pitchNeck: [1.05, 1.0, 1.0, 1.0, 1.0, 1.1, 0.85],
  density: 1050,            // kg/m3, whole-body density (the task's 1.05 kg/L; real adults 1.01-1.09 depending on fat)
};
/** The constants of the model (offsets between joint centres and survey landmarks, spine curve angles, ...), for the documentation and the tests. */
export const CONSTANTS = K;

// ---------------------------------------------------------------------------------------------------------------------
// small maths
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mirror3 = (a) => [-a[0], a[1], a[2]];
const finite3 = (a) => a.every(Number.isFinite);
// metres to the micrometre: keeps the output tidy and deterministic across platforms. Ties round away from zero (Math.round rounds -x.5 up), so r6(-x) === -r6(x)
// and the mirrored joints of the right side are exact images of the left ones.
const r6 = (x) => Math.sign(x) * (Math.round(Math.abs(x) * 1e6) / 1e6) + 0;
// A band whose edges cross (relative bands of a very short or very contradictory body) has no valid value: take the middle, which keeps the order of the joints.
const clampBand = (x, lo, hi) => (lo > hi ? 0.5 * (lo + hi) : clamp(x, lo, hi));
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** Perimeter of an ellipse with semi-axes a, b: Ramanujan's second approximation (relative error < 1e-5 for the shapes of a body). */
export function ellipsePerimeter(a, b) {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}
const QUARTER = 36; // segments per quadrant of the polyline that measures a superellipse
const QCOS = [], QSIN = [];
for (let i = 0; i <= QUARTER; i++) { const t = (i / QUARTER) * (Math.PI / 2); QCOS.push(Math.cos(t)); QSIN.push(Math.sin(t)); }
const QPOW = new Map(); // exponent n -> the quadrant's points (x, z) of the unit superellipse |x|^n + |z|^n = 1
function quadrant(n) {
  let q = QPOW.get(n);
  if (!q) {
    q = QCOS.map((c, i) => [Math.pow(c, 2 / n), Math.pow(QSIN[i], 2 / n)]);
    if (QPOW.size > 4000) QPOW.clear();
    QPOW.set(n, q);
  }
  return q;
}
/** Perimeter of the superellipse |x/a|^n + |z/b|^n = 1 (n = 2 is the ellipse, larger n is boxier), by a 144-segment polyline. */
export function ringPerimeter(a, b, n = 2) {
  if (Math.abs(n - 2) < 1e-9) return ellipsePerimeter(a, b);
  const q = quadrant(n);
  let s = 0;
  for (let i = 1; i < q.length; i++) s += Math.hypot((q[i][0] - q[i - 1][0]) * a, (q[i][1] - q[i - 1][1]) * b);
  return 4 * s;
}
/** Area of the superellipse (shoelace on the same polyline). */
export function ringArea(a, b, n = 2) {
  if (Math.abs(n - 2) < 1e-9) return Math.PI * a * b;
  const q = quadrant(n);
  let s = 0;
  for (let i = 1; i < q.length; i++) s += q[i - 1][0] * q[i][1] - q[i][0] * q[i - 1][1];
  return 2 * s * a * b; // quadrant area (s/2) x 4
}
// Bisection on a monotone function.
function bisect(f, lo, hi, target, it = 44) {
  const up = f(hi) >= f(lo);
  for (let i = 0; i < it; i++) {
    const m = 0.5 * (lo + hi);
    if (f(m) < target === up) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

// Exponent range of a section, and the share of the girth that may be left out instead of growing the section. 12 is a rounded rectangle: its perimeter is 1.212 x the ellipse
// for a 0.8 depth / breadth (n = 5 held 1.143, the rectangle holds 1.269); the polyline that measures the perimeter is accurate to 0.2 % up to n = 16. The ANSUR II men's
// chest tape is 1.237 x the ellipse through their own chest breadth and depth (median), more than any believable section holds.
const N_MIN = 1.8, N_MAX = 12, GIRTH_SLACK = 0.015;
/**
 * Cross-section of a body part from any of breadth B, depth D, girth G (all metres, undefined = unknown) plus the typical shape.
 * Measured values are not changed except in one case: B and D and G all given. Then the exponent n is solved so that the perimeter is G (breadth, depth AND girth
 * reproduced). When no n in [1.8, 12] reaches G the section is as boxy as it may be and the girth is met by the smallest change: up to 1.5 % of the girth is left out
 * (`short` = G minus the ring's girth, m, which the fit report shows as "warn" at worst), beyond that breadth and depth are scaled together, keeping their ratio, until the
 * girth is within 1.5 % (`k` records the factor: the tape and the calipers disagree, and this is the compromise that keeps all three within 2 %); a girth more than 5 %
 * beyond the bounding rectangle of B and D (impossible for any convex section: a typing slip or another landmark) is reproduced exactly by scaling. B and D only: typical
 * boxiness `n0`. G and one axis: the other axis is solved for n0. G alone: depth/breadth ratio `ratio` (typical), scaled to G.
 * Returns { rx, rz, n, girth, k, short }.
 */
export function sectionFrom({ B, D, G, ratio, n0 = 2 }) {
  let rx, rz, n = n0, k = 1;
  if (B && D && G) {
    rx = B / 2; rz = D / 2;
    const hi = ringPerimeter(rx, rz, N_MAX), lo = ringPerimeter(rx, rz, N_MIN);
    // more than 5 % beyond the bounding rectangle (4 (rx + rz)) no convex section through B and D holds G at all: a typing slip or another landmark, the girth wins exactly
    if (G > hi) { k = G > 1.05 * 4 * (rx + rz) ? G / hi : Math.max(1, G * (1 - GIRTH_SLACK) / hi); rx *= k; rz *= k; n = N_MAX; }
    else if (G < lo) { k = G / lo; rx *= k; rz *= k; n = N_MIN; }
    else n = bisect((x) => ringPerimeter(rx, rz, x), N_MIN, N_MAX, G, 34);
  }
  else if (B && D) { rx = B / 2; rz = D / 2; }
  else if (G && B) {
    rx = B / 2; rz = bisect((z) => ringPerimeter(rx, z, n0), 0.15 * rx, 4 * rx, G, 36);
    if (rz < 0.4 * rx) { const r = ratio ?? 1, x2 = G / ringPerimeter(1, r, n0); k = x2 / rx; rx = x2; rz = r * x2; } // the girth wins: no section is that flat
  } else if (G && D) {
    rz = D / 2; rx = bisect((x) => ringPerimeter(x, rz, n0), 0.15 * rz, 4 * rz, G, 36);
    if (rx < 0.4 * rz) { const r = ratio ?? 1, x2 = G / ringPerimeter(1, r, n0); k = x2 / rx; rx = x2; rz = r * x2; }
  }
  else if (G) {
    const r = ratio ?? 1, p = ringPerimeter(1, r, n0);
    rx = G / p; rz = r * rx;
  } else if (B) { rx = B / 2; rz = rx * (ratio ?? 1); } else { rz = D / 2; rx = rz / (ratio ?? 1); }
  const girth = ringPerimeter(rx, rz, n);
  return { rx, rz, n, girth, k, short: B && D && G ? G - girth : 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// inputs
const nullProto = (o) => Object.assign(Object.create(null), o);
const TO_M = nullProto({ mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254 });
const TO_KG = nullProto({ kg: 1, lb: 0.45359237, lbs: 0.45359237 });
// profile keys that mean the same as the key the model reads
const ALIAS = nullProto({
  "other:hip_breadth_standing": "other:hip_breadth", "other:tragion_to_top_of_head": "other:tragion_top_of_head",
  "other:waist_height_omphalion": "other:omphalion_height", "other:stylion_wrist_height": "other:wrist_height",
  "other:nipple_chest_height": "other:chest_height", "other:waist_depth_standing": "other:waist_depth",
  "other:waist_omphalion_breadth": "other:waist_breadth", "other:waist_omphalion_depth": "other:waist_depth",
  "other:knee_circumference_standing": "other:knee_circumference",
  // the bare names of the measures this module reads under an "other:" key: anthro.js turns a bare import column into an "other:" key only for the names in its
  // SKELETON_MEASURES, which lacks these, so a CSV with a column "waist_depth" would otherwise reach us unrecognised (and be ignored without a word)
  ...Object.fromEntries(["hip_breadth", "waist_breadth", "waist_depth", "buttock_depth", "knee_circumference", "ankle_height", "tragion_top_of_head", "elbow_wrist_length",
    "forearm_hand_length", "omphalion_height", "chest_height"].map((k) => [k, `other:${k}`])),
});
const bare = (k) => k.replace(/^other:/, "");
const MAX_LENGTH = 10; // m; the longest measure (span, stature) of any person is under 3 m
const BMI_UNITS = new Set(["kg/m\u00b2", "kg/m2", "kg/m^2"]);

/**
 * The stature range the model accepts (m). The absolute floors of the skeleton (shank 0.30 m, thigh 0.30 m, trunk 0.30 m, neck 0.07 m, with an ankle 56 mm
 * high and the head pivot 155 mm below the vertex) add up to about 1.31 m for men (swept over mass 25 to 300 kg; women from 1.27 m). From 1.31 m all four hold;
 * between 1.30 and 1.31 m the shank gives way (to 294 mm at the worst, see knee_height) and the other three hold. Further down the shortfall grows (25 mm at 1.2 m,
 * thigh 250, trunk 275, neck 45 mm) and for 0.8 to 1.0 m the spine inverts, so such a stature is refused like a missing one. An adult shorter than 1.30 m is a
 * medical condition that the regressions of the database (adults of 1.45 to 2.05 m) do not describe anyway.
 */
const STATURE_RANGE = [1.3, 2.5];

/**
 * A guarded copy of the parts of a profile the fit reads (id, label, sex, source, measures), taken once at the top of fitBody: a getter or a valueOf that throws,
 * a Symbol, a Proxy that refuses a key all read as "absent" (fitBody never throws, MODEL.md section 1). Measures become an array of [key, { value, unit }]
 * because a key such as "__proto__" cannot be stored in an object.
 */
function snapshot(profile) {
  const get = (o, k) => { try { return o?.[k]; } catch { return undefined; } };
  const num = (v) => { try { return Number(v); } catch { return NaN; } };
  const str = (v) => { if (v === undefined || v === null) return undefined; try { return typeof v === "symbol" ? undefined : String(v); } catch { return undefined; } };
  const entries = [];
  try {
    const m = get(profile, "measures");
    if (m && typeof m === "object") for (const key of Object.keys(m)) {
      const e = get(m, key);
      if (!e || typeof e !== "object") continue;
      entries.push([key, { value: num(get(e, "value")), unit: str(get(e, "unit")) }]);
    }
  } catch { /* an object that cannot even list its keys has no measures */ }
  const src = get(profile, "source"), sex = get(profile, "sex");
  return {
    id: get(profile, "id") ?? null, label: str(get(profile, "label")) ?? "", sex: typeof sex === "string" ? sex : undefined,
    source: src && typeof src === "object" ? { kind: get(src, "kind"), scaling: get(src, "scaling"), percentile: get(src, "percentile") } : undefined, entries,
  };
}
/** The options of fitBody, read through the same guard: form and the overrides (a prototype-free copy). */
function snapshotOptions(opts) {
  const get = (o, k) => { try { return o?.[k]; } catch { return undefined; } };
  const out = { form: get(opts, "form"), overrides: Object.create(null) };
  try {
    const ov = get(opts, "overrides");
    if (ov && typeof ov === "object") for (const k of Object.keys(ov)) { out.overrides[k] = get(ov, k); }
  } catch { /* unreadable overrides are no overrides */ }
  return out;
}

function readInputs(snap, warn) {
  const out = new Map();
  for (const [key, e] of snap.entries) {
    let k = ALIAS[key] ?? key;
    if (k === "other:weight_as_reported") k = "mass";
    const v = e.value;
    if (!(v > 0) || !Number.isFinite(v)) continue;
    // units are matched without case and spaces ("MM", " kg "); a unit nobody knows drops the value, and says so for the measures the model reads.
    // A value without a unit is in the unit of its measure: kg, kg/m2 or mm.
    const u = (e.unit ?? (k === "mass" ? "kg" : k === "bmi" ? "kg/m2" : "mm")).trim().toLowerCase();
    let si;
    if (k === "mass") si = TO_KG[u] ? v * TO_KG[u] : undefined;
    else if (k === "bmi") si = BMI_UNITS.has(u) ? v : undefined;
    else si = TO_M[u] ? v * TO_M[u] : undefined;
    if (si === undefined) {
      if (isReadKey(k)) warn.push(`${key}: the unit "${e.unit.slice(0, 12)}" is not understood (${k === "mass" ? "kg or lb" : k === "bmi" ? "kg/m2" : "mm, cm, m or in"}): the value was ignored.`);
      continue;
    }
    // no length of a person is metres long: 1e308 m survives the unit conversion but not the multiplication by 1000 of the fit report (Infinity)
    if (k !== "mass" && k !== "bmi" && si > MAX_LENGTH) {
      if (isReadKey(k)) warn.push(`${key}: ${si.toPrecision(3)} m is not a length of a person: the value was ignored.`);
      continue;
    }
    if (out.has(k) && k !== key) continue; // the canonical name wins over an alias
    out.set(k, si);
  }
  return out;
}

/** Regression estimate of a measure (m) for a person of stature S (m), mass (kg) and form factor f (1 = male, 0 = female, 0.5 = neutral). */
function regPredict(key, S, mass, f) {
  const r = REG[bare(key)];
  if (!r) return undefined;
  const one = (c) => (c ? (c.a + c.bs * S * 1000 + c.bm * mass) / 1000 : undefined);
  const pm = one(r.M), pf = one(r.F);
  return pm === undefined ? pf : pf === undefined ? pm : f * pm + (1 - f) * pf;
}
function regSd(key, f) {
  const r = REG[bare(key)];
  if (!r) return undefined;
  const sm = r.M?.sd, sf = r.F?.sd;
  return (sm === undefined ? sf : sf === undefined ? sm : f * sm + (1 - f) * sf) / 1000;
}
function relValue(name, f) {
  const r = REL[name];
  if (!r) throw new Error(`unknown relation ${name}`);
  const unit = name.endsWith("_ratio") ? 1 : 1e-3;
  return (f * r.M[0] + (1 - f) * r.F[0]) * unit;
}

/** SD (m) of the difference of two routes that read the relations `a` and `b`: a relation both read cancels, the others add in quadrature (independent, approx.). Ratios are skipped (unitless). */
function relSd(a, b, f) {
  let v = 0;
  for (const n of new Set([...a, ...b])) {
    if (a.has(n) && b.has(n) || n.endsWith("_ratio")) continue;
    const r = REL[n], sd = (f * r.M[1] + (1 - f) * r.F[1]) * 1e-3;
    v += sd * sd;
  }
  return Math.sqrt(v);
}

// Measures that predict stature well (R2 > 0.7 on the database), for a profile without stature: median of the inverse regressions.
const STATURE_PROXIES = ["cervicale_height", "acromion_height", "suprasternale_height", "iliocristale_height", "trochanterion_height", "crotch_height",
  "knee_height_sitting", "popliteal_height", "other:lateral_femoral_epicondyle_height", "other:axilla_height", "other:chest_height", "other:wrist_height",
  "other:knee_height_midpatella", "buttock_knee_length", "span", "sitting_height"];
function estimateStature(inp, f) {
  let S = 1.7, used = [];
  for (let it = 0; it < 3; it++) {
    const m0 = (f * BMI_MEDIAN.M + (1 - f) * BMI_MEDIAN.F) * S * S, est = [];
    used = [];
    for (const k of STATURE_PROXIES) {
      const v = inp.get(k), r = REG[bare(k)];
      if (v === undefined || !r) continue;
      const a = f * (r.M?.a ?? r.F.a) + (1 - f) * (r.F?.a ?? r.M.a), bs = f * (r.M?.bs ?? r.F.bs) + (1 - f) * (r.F?.bs ?? r.M.bs), bm = f * (r.M?.bm ?? r.F.bm) + (1 - f) * (r.F?.bm ?? r.M.bm);
      est.push((v * 1000 - a - bm * m0) / bs / 1000); used.push(k);
    }
    if (!est.length) return { S: undefined, used: [] };
    est.sort((x, y) => x - y);
    S = clamp(est.length % 2 ? est[(est.length - 1) / 2] : 0.5 * (est[est.length / 2 - 1] + est[est.length / 2]), STATURE_RANGE[0], 2.3); // clamped at each pass so that a garbage input cannot make the mass guess explode
  }
  return { S, used };
}

// ---------------------------------------------------------------------------------------------------------------------
// The dimension table. Every dimension is `def(id, label, unit, routes, estimate, band)`:
//   routes   ordered, most direct measure first; a route is usable when all its measure keys are in the profile (and not rejected) and its
//            value lies in the plausible band. The first usable route sets the dimension; the other usable ones are kept as checks (`alt`).
//   estimate used when no route is usable: stature, mass and sex (regressions of REG, relations of REL).
// `c` in the formulas is the Fit context: c.d (resolved dimensions, m), c.S (stature), c.E(key) (regression estimate), c.R(name) (relation).
const DEFS = [];
const route = (keys, via, f, status = "derived", dep = null) => ({ k: keys, via, f, status, dep });
const estim = (via, f) => ({ via, f });
function def(id, label, unit, routes, est, band = {}) { DEFS.push({ id, label, unit, routes, est, ...band }); }

/** Documentation of every dimension (id, label, unit, formula per route, required measure keys, fallback), in resolution order. */
export const DIM_DEFS = [];

// ---------------------------------------------------------------------------------------------------------------------
// The Fit context: reads the profile, resolves DEFS in order, keeps the dimension table.
class Fit {
  constructor(profile, opts = {}) {
    this.profile = profile; // a snapshot (see fitBody)
    this.warnings = [];
    this.dims = [];
    this.d = Object.create(null);
    this.rejected = new Map();
    this.refined = new Map(); // id -> { note, value0, whys }: refine() always works from the first value, so repeated layouts do not stack
    const sex = typeof this.profile.sex === "string" ? this.profile.sex.trim().toLowerCase() : "";
    this.form = opts.form === "male" || opts.form === "female" || opts.form === "neutral" ? opts.form : /^(m|male|men|man)$/.test(sex) ? "male" : /^(f|female|women|woman)$/.test(sex) ? "female" : "neutral";
    this.f = this.form === "male" ? 1 : this.form === "female" ? 0 : 0.5;
    this.overrides = opts.overrides;
    this.inp = readInputs(this.profile, this.warnings);
    this.unknownKeys();
    this.stature();
    this.massDim();
    this.screen();
    this.checkOverrideKeys();
  }
  stature() {
    let S = this.inp.get("stature"), status = "measured", via = ["stature"], note = "stature as given: the vertex of the model is exactly at this height";
    const given = S;
    if (!(S >= STATURE_RANGE[0] && S <= STATURE_RANGE[1])) {
      S = undefined;
      if (given !== undefined) {
        this.warnings.push(`Stature ${Math.round(given * 1000)} mm is outside the ${STATURE_RANGE[0] * 1000} to ${STATURE_RANGE[1] * 1000} mm the model supports (it is built for adults) and was ignored.`);
        this.rejected.set("stature", `${Math.round(given * 1000)} mm is outside the ${STATURE_RANGE[0] * 1000} to ${STATURE_RANGE[1] * 1000} mm the model supports`);
      }
      const e = estimateStature(this.inp, this.f);
      if (e.S) {
        S = clamp(e.S, STATURE_RANGE[0], 2.3); status = "estimated"; via = e.used;
        note = `no stature in the profile: median of the inverse regressions of ${e.used.length} other measure(s) on stature`;
        this.warnings.push("The profile has no stature: it was estimated from other measures. Enter a stature for a reliable model.");
      } else {
        S = STATURE_DEFAULT.M * this.f + STATURE_DEFAULT.F * (1 - this.f); status = "estimated"; via = [];
        note = "no stature and no measure that predicts it: the median stature of the 13,792 people of the database for this sex";
        this.warnings.push("The profile has no stature and no length that predicts it: the model is an average adult of this sex.");
      }
    }
    if (S < 1.45 || S > 2.05) this.warnings.push(`Stature ${Math.round(S * 1000)} mm is outside the adult range the proportions were fitted on (1.45 to 2.05 m): proportions are extrapolated.`);
    this.S = S;
    this.dims.push({ id: "stature", label: "Stature (vertex height)", unit: "m", value: S, status, via, note });
    this.d.stature = S;
  }
  massDim() {
    let m = this.inp.get("mass"), status = "measured", via = ["mass"], note = "body mass as given";
    if (!(m >= 10 && m <= 400)) {
      const given = m, bmi = this.inp.get("bmi");
      if (given !== undefined) {
        // a mass that was given and refused is said so; "no body mass" would be false
        const why = `${given < 10 ? given.toFixed(1) : given.toPrecision(3)} kg is outside the 10 to 400 kg the model accepts`;
        this.rejected.set("mass", why);
        this.warnings.push(`Body mass ${why} and was ignored.`);
      }
      if (bmi > 8 && bmi < 80) { m = bmi * this.S * this.S; status = "derived"; via = ["bmi"]; note = "BMI x stature squared"; }
      else {
        m = (this.f * BMI_MEDIAN.M + (1 - this.f) * BMI_MEDIAN.F) * this.S * this.S; status = "estimated"; via = [];
        note = `no mass: median BMI of the 13,792 people of the database (${(this.f * BMI_MEDIAN.M + (1 - this.f) * BMI_MEDIAN.F).toFixed(1)} kg/m2 for this form) x stature squared`;
        if (given === undefined) this.warnings.push("The profile has no body mass: it was estimated from stature and the median BMI of the survey people.");
        else this.warnings.push("The body mass of the profile was ignored: it was estimated from stature and the median BMI of the survey people.");
      }
    }
    this.mass = clamp(m, MASS_RANGE[0], MASS_RANGE[1]);
    if (this.mass !== m) {
      // the value in the table is no longer the one that was given: say so instead of calling it "as given"
      note = `${note}; clamped from ${m.toFixed(1)} kg to the ${MASS_RANGE[0]} to ${MASS_RANGE[1]} kg the model supports`;
      status = "derived";
      this.warnings.push(`Body mass ${m.toFixed(1)} kg is outside the ${MASS_RANGE[0]} to ${MASS_RANGE[1]} kg the model supports: ${this.mass} kg was used.`);
    }
    this.massStatus = status;
    // The regressions of heights and lengths on mass describe soft tissue over the bones of the people of the database (BMI 16 to 40): beyond that range
    // they are extrapolations, and fat does not change bone lengths. They are evaluated at the nearest mass inside the range; girths use the real mass.
    const bmiNow = this.mass / (this.S * this.S);
    this.massFit = this.fitMass(this.mass);
    if (this.massFit !== this.mass) {
      this.warnings.push(`BMI ${bmiNow.toFixed(1)} (${this.mass.toFixed(0)} kg at ${Math.round(this.S * 1000)} mm) is outside the ${BMI_FIT[0]} to ${BMI_FIT[1]} the proportions were fitted on: bone lengths and heights were estimated as for ${this.massFit.toFixed(0)} kg, only girths follow the real mass.`);
    }
    this.dims.push({ id: "mass", label: "Body mass", unit: "kg", value: this.mass, status, via, note });
    this.d.mass = this.mass;
  }
  // Inputs that are more than 6 residual SD from what stature and sex predict, for the mass in the profile AND for the typical mass of this stature
  // (so that a mass that does not go with the girths does not make the girths look wrong), are almost certainly a unit or typing slip.
  screen() {
    const typical = (this.f * BMI_MEDIAN.M + (1 - this.f) * BMI_MEDIAN.F) * this.S * this.S;
    for (const [k, v] of this.inp) {
      const p = this.pred(k, this.mass), q = this.pred(k, typical), sd = regSd(k, this.f);
      if (p === undefined || k === "stature" || k === "mass") continue;
      const near = Math.abs(v - p) <= Math.abs(v - q) ? p : q, z = (v - near) / sd;
      if (Math.abs(z) > 6) {
        this.rejected.set(k, `${(v * 1000).toFixed(0)} mm is ${z.toFixed(1)} residual SD from the ${(near * 1000).toFixed(0)} mm expected for this stature and mass`);
        this.warnings.push(`${k} = ${(v * 1000).toFixed(0)} mm looks implausible (${z.toFixed(1)} SD from the expected ${(near * 1000).toFixed(0)} mm) and was not used.`);
      }
    }
  }
  /**
   * Keys the model does not read, in a typed-in or imported profile: a misspelt column would otherwise vanish without a word. Population and individual profiles
   * carry some hundred measures the model has no use for, so they are not listed.
   */
  unknownKeys() {
    const kind = this.profile.source?.kind;
    if (kind !== "import" && kind !== "manual") return;
    const unknown = this.profile.entries.filter(([k, e]) => e.value > 0 && !isReadKey(k) && !(k in ALIAS) && k !== "other:weight_as_reported").map(([k]) => String(k).slice(0, 40));
    if (unknown.length) this.warnings.push(`${unknown.length} measure(s) in the profile are not used by the model and were ignored: ${unknown.slice(0, 6).join(", ")}${unknown.length > 6 ? ", ..." : ""}.`);
  }
  /** Overrides that name nothing the model can edit are reported instead of silently dropped. */
  checkOverrideKeys() {
    for (const k of Object.keys(this.overrides)) {
      if (k === "stature" || k === "mass") this.warnings.push(`The override of ${k} was ignored: edit the ${k} in the profile.`);
      else if (!OVERRIDABLE().has(k)) this.warnings.push(`The override "${String(k).slice(0, 40)}" is not a dimension of the model and was ignored.`);
    }
  }
  g(k) { return this.rejected.has(k) ? undefined : this.inp.get(k); }
  has(k) { return this.g(k) !== undefined; }
  /** The mass at which a regression is evaluated: heights and lengths stay inside the fitted BMI range (see massDim), girths and breadths use the real mass. */
  fitMass(m) { return clamp(m, BMI_FIT[0] * this.S * this.S, BMI_FIT[1] * this.S * this.S); }
  pred(k, mass) { return regPredict(k, this.S, /height|length|span|reach/.test(k) ? this.fitMass(mass) : mass, this.f); }
  E(k) { return this.pred(k, this.mass); }
  R(n) { this._rels?.add(n); return relValue(n, this.f); }
  /** Resolve one DEFS entry. */
  resolve(def) {
    const lo = typeof def.lo === "function" ? def.lo(this) : def.lo ?? -Infinity, hi = typeof def.hi === "function" ? def.hi(this) : def.hi ?? Infinity;
    let chosen = null;
    const alt = [], rejected = [];
    for (const r of def.routes) {
      if (!r.k.every((k) => this.g(k) !== undefined)) continue;
      // the relations a route reads are remembered: their spread (SD) is the natural disagreement between two routes (see relSd)
      const rels = (this._rels = new Set());
      const v = r.f(this, ...r.k.map((k) => this.g(k)));
      this._rels = null;
      if (!Number.isFinite(v)) continue;
      if (v < lo || v > hi) { rejected.push(`${r.via} gave ${(v * 1000).toFixed(0)} mm, outside the plausible ${(lo * 1000).toFixed(0)} to ${(hi * 1000).toFixed(0)} mm`); continue; }
      const why = def.accept ? def.accept(this, v, r) : null; // a route can be refused because of what it implies for another measure
      if (why) { rejected.push(`${r.via} gave ${(v * 1000).toFixed(0)} mm, which ${why}`); continue; }
      if (!chosen) chosen = { r, v, rels }; else alt.push({ via: r.via, keys: r.k.slice(), value: v, rels });
    }
    let value, status, via, note, formula;
    if (chosen) {
      const r = chosen.r;
      value = chosen.v; formula = r.via;
      if (r.k.length) { status = r.status; via = r.k.slice(); }
      else {
        const deps = r.dep ?? [];
        status = deps.length && deps.every((x) => this.dimById(x)?.status === "estimated") ? "estimated" : "derived";
        via = [...new Set(deps.flatMap((x) => this.dimById(x)?.via ?? []))];
      }
      note = formula + (rejected.length ? `; a more direct route was rejected: ${rejected.join("; ")}` : "");
    } else {
      if (!def.est) throw new Error(`dimension ${def.id} has no usable route and no estimate`);
      value = clampBand(def.est.f(this), lo, hi);
      status = "estimated"; via = []; formula = def.est.via;
      note = `estimated: ${formula}` + (rejected.length ? `; ${rejected.join("; ")}` : "");
    }
    const ov = this.overrides[def.id], pure = !def.est && def.routes.length === 1 && def.routes[0].k.length === 0;
    if (typeof ov === "number" && Number.isFinite(ov) && ov > 0) {
      if (!pure) {
        note = `overridden by the user (the profile gave ${(value * 1000).toFixed(1)} mm, ${status})`;
        // the heights are absolute: an edit outside the plausible band would not move the figure, it would eat the trunk or the neck and invert the spine
        value = this.inBand(def, ov, lo, hi);
        if (value !== ov) note += `; limited to ${(value * 1000).toFixed(0)} mm, the edge of the plausible band`;
        status = "measured"; via = [];
      } else if (DERIVED_OVERRIDES[def.id]) DERIVED_OVERRIDES[def.id](this, ov);
      else this.warnings.push(`The override of ${def.label} was ignored: it is derived from other dimensions (${def.routes[0].dep.join(", ")}); edit those.`);
    }
    if (pure && DERIVED_OVERRIDES[def.id] && Number.isFinite(ov)) { value = def.routes[0].f(this); note = `${formula}; recomputed from the edited dimensions`; }
    if (def.warnLo !== undefined && (value < def.warnLo || value > def.warnHi)) this.warnings.push(def.warnText(this, value));
    const rec = { id: def.id, label: def.label, unit: def.unit, value, status, via, note, formula };
    // sd: the SD (m) of the difference of the chosen route and this one that is due to the relations only one of them uses (the routes that are pure
    // measures have sd 0); the "measures conflict" warning is raised at 2 SD, not at a fixed 15 mm that the relations alone exceed for most people
    if (alt.length) rec.alt = alt.map(({ rels, ...a }) => ({ ...a, delta: a.value - value, sd: relSd(rels, chosen ? chosen.rels : new Set(), this.f) }));
    this.dims.push(rec);
    this.d[def.id] = value;
    return value;
  }
  /** An edit of a dimension, limited to its plausible band (with a warning when it had to be moved). */
  inBand(def, v, lo, hi) {
    const x = clampBand(v, lo, hi);
    if (x !== v) this.warnings.push(`The edited ${def.label} (${(v * 1000).toFixed(0)} mm) is outside the plausible ${(lo * 1000).toFixed(0)} to ${(hi * 1000).toFixed(0)} mm: ${(x * 1000).toFixed(0)} mm was used.`);
    return x;
  }
  bandOf(id) {
    const def = DEFS.find((d) => d.id === id);
    return [typeof def.lo === "function" ? def.lo(this) : def.lo ?? -Infinity, typeof def.hi === "function" ? def.hi(this) : def.hi ?? Infinity, def];
  }
  /** Replace the value of a resolved dimension by a refined one (a solved landmark distance); the record keeps the reason. */
  refine(id, value, why, via) {
    const rec = this.dimById(id);
    if (!rec || !Number.isFinite(value)) return;
    let r = this.refined.get(id);
    if (!r && Math.abs(value - rec.value) < 1e-9) return;
    if (!r) this.refined.set(id, (r = { note: rec.note, value0: rec.value, whys: [] }));
    if (!r.whys.includes(why)) r.whys.push(why);
    rec.note = `${r.note}${r.whys.map((w) => `; ${w}`).join("")} (${((value - r.value0) * 1000).toFixed(1)} mm)`;
    if (via) { rec.status = "derived"; rec.via = via; }
    rec.value = value; this.d[id] = value;
    this.realign(rec);
  }
  /** The value a dimension had before any refinement (the layout is run more than once and always starts from here). */
  v0(id) { return this.refined.get(id)?.value0 ?? this.d[id]; }
  /** The girth sections that depend on the profile only, built once (see sectionsOf). */
  sections() { return (this._sections ??= sectionsOf(this)); }
  /** The user's edit of a girth (`ring_<name>`, m): limited to 0.4 to 2.2 times what stature, mass and sex give, with a warning when it had to be moved. */
  ringOverride(id) {
    const v = this.overrides[`ring_${id}`];
    if (!(Number.isFinite(v) && v > 0)) return undefined;
    const e = this.E(RING_KEY[id]), x = clamp(v, 0.4 * e, 2.2 * e);
    if (x !== v) this.warnings.push(`The edited ${id.replace("_", " ")} girth (${(v * 1000).toFixed(0)} mm) is outside the plausible ${(0.4e3 * e).toFixed(0)} to ${(2.2e3 * e).toFixed(0)} mm: ${(x * 1000).toFixed(0)} mm was used.`);
    return x;
  }
  /** Set a dimension to a value the user typed: status "measured", no measure behind it. The value stays inside the plausible band. */
  force(id, value, why) {
    const rec = this.dimById(id);
    if (!rec) return;
    const [lo, hi, def] = this.bandOf(id);
    const v = this.inBand(def, value, lo, hi);
    rec.note = `overridden by the user (${why}; was ${(rec.value * 1000).toFixed(1)} mm, ${rec.status})${v !== value ? `; limited to ${(v * 1000).toFixed(0)} mm, the edge of the plausible band` : ""}`;
    rec.value = v; rec.status = "measured"; rec.via = []; this.d[id] = v;
    this.realign(rec);
  }
  /** The alternatives of a record are checks against its value: after a refinement their deltas follow the new value. */
  realign(rec) { for (const a of rec.alt ?? []) a.delta = a.value - rec.value; }
  dimById(id) { return this.dims.find((x) => x.id === id); }
  /** Register a dimension that was solved elsewhere (a ring). */
  note(id, label, unit, value, status, via, note) {
    this.dims.push({ id, label, unit, value, status, via, note });
    this.d[id] = value;
  }
}

// An override of a derived dimension edits the dimension it is derived from.
const DERIVED_OVERRIDES = {
  shank_length: (c, v) => c.force("knee_height", c.d.ankle_height + v, "shank length"),
  hip_height: (c, v) => c.force("femur_length", v - c.d.knee_height, "hip height"),
  gh_halfwidth: (c, v) => c.force("acromion_to_gh", c.d.acromion_halfwidth - v, "shoulder joint half-width"),
};

// =====================================================================================================================
// The dimensions, in dependency order. Lengths in metres.
const same = (key, tail = "") => route([key], `${bare(key).replaceAll("_", " ")}${tail}`, (c, v) => v, "measured");
function simple(id, label, key, lo, hi) {
  def(id, label, "m", [same(key)], estim(`regression of ${bare(key).replaceAll("_", " ")} on stature, mass and sex`, (c) => c.E(key)), { lo, hi });
}

// What the body above the hip needs of the stature (m): L5 above the hip, the trunk floor (0.30 m), the neck floor (0.07 m) and the head pivot depth. Typical values of the relations.
const upperBudget = (c) => c.R("iliocristale_over_hip") - K.l5BelowIliocristale + 0.3 + 0.07 + c.R("vertex_to_eye") - c.R("eye_over_tragion") + K.ocBelowTragion;

// ---- leg: floor -> ankle -> knee -> hip
def("ankle_height", "Ankle joint centre above the sole", "m",
  [route(["other:lateral_malleolus_height"], "lateral malleolus height (the ankle centre is put at the malleolus tip, as de Leva 1996 does)", (c, v) => v, "measured"),
   route(["other:ankle_height"], "ankle height (the malleolus in the Australian files; a higher value is another landmark and is refused)", (c, v) => v, "measured")],
  estim("regression of the lateral malleolus height on stature, mass and sex", (c) => c.E("other:lateral_malleolus_height")),
  // Two meanings of "ankle height" are in the data: 67 to 75 mm in the Australian files (the malleolus) and 110 to 136 mm in the US, Turkish, Greek, Italian and UK files
  // (a higher landmark: not the malleolus, 70 mm in the same people). Only a value that can be a malleolus is used.
  { lo: 0.035, hi: 0.12, accept: (c, v, r) => (r.k[0] === "other:ankle_height" && v > 0.09 ? "is higher than any lateral malleolus (90 mm): in that survey the ankle height is a different, higher landmark" : null) });
def("knee_height", "Knee joint centre above the sole", "m",
  [route(["other:lateral_femoral_epicondyle_height"], "lateral femoral epicondyle height", (c, v) => v, "measured"),
   route(["other:knee_height_midpatella"], "mid-patella height - (mid-patella above the epicondyle)", (c, v) => v - c.R("midpatella_over_knee")),
   route(["knee_height_sitting"], "knee height sitting - (top of the knee above the knee axis)", (c, v) => v - c.R("knee_top_over_knee")),
   route(["popliteal_height"], "popliteal height + (knee axis above the popliteal point)", (c, v) => v + c.R("knee_over_popliteal"))],
  estim("regression of the lateral femoral epicondyle height on stature, mass and sex", (c) => c.E("other:lateral_femoral_epicondyle_height")),
  // The shank floor (0.30 m) gives way to the absolute floors of the thigh, trunk and neck (see femur_length) when a short stature cannot hold all four: the knee
  // is lowered by the few millimetres missing (never more than 30 mm below the floor, and not at all for a stature from 1.31 m up).
  { lo: (c) => Math.min(c.d.ankle_height + 0.3, Math.max(c.S - 0.3 - upperBudget(c), c.d.ankle_height + 0.27)),
    hi: (c) => Math.min(c.d.ankle_height + 0.58, Math.max(c.S - 0.3 - upperBudget(c), c.d.ankle_height + 0.27)) });
def("shank_length", "Shank (knee centre to ankle centre)", "m",
  [route([], "knee height - ankle height", (c) => c.d.knee_height - c.d.ankle_height, "derived", ["knee_height", "ankle_height"])]);
def("femur_length", "Thigh (hip centre to knee centre)", "m",
  [route(["trochanterion_height"], "trochanterion height - 5 mm (hip centre below the trochanter landmark) - knee height", (c, v) => v + K.hjcAboveTroch - c.d.knee_height),
   route(["crotch_height"], "crotch height + (hip centre above the crotch: 66 mm men / 71 mm women) - knee height", (c, v) => v + c.R("hip_over_crotch") - c.d.knee_height),
   route(["sitting_height"], "stature - sitting height + (hip centre above the seat plane: 74 mm) - knee height", (c, v) => c.S - v + c.R("seat_below_hip") - c.d.knee_height),
   route(["buttock_knee_length"], "buttock-knee length - (mean of buttock-knee length minus thigh length: 208 mm men / 204 mm women)", (c, v) => v - c.R("bkl_minus_femur"))],
  estim("regression of the trochanterion height - 5 mm - knee height", (c) => c.E("trochanterion_height") + K.hjcAboveTroch - c.d.knee_height),
  // with a sitting height in the profile a leg length that would put the hip joint 14 cm or more above (or less than 2 cm above) the seat plane
  // contradicts it: the sitting height is a closure requirement, so the next route (ultimately the one built on the sitting height) is used
  // hi: the thigh must leave room above the hip for L5, the trunk (0.30 m), the neck (0.07 m) and the head pivot, or the spine inverts (heights are absolute)
  { lo: 0.3, hi: (c) => Math.min(0.62, c.S - c.d.knee_height - upperBudget(c)), accept: (c, v, r) => {
    const sh = c.g("sitting_height");
    if (sh === undefined || r.k[0] === "sitting_height") return null;
    const d = sh - c.S + c.d.knee_height + v;
    return d >= 0.02 && d <= 0.14 ? null : `puts the hip joint ${(d * 1000).toFixed(0)} mm above the seat plane (typical 74 mm) and so contradicts the sitting height`;
  } });
def("hip_height", "Hip joint centre above the sole (= pelvis root)", "m",
  [route([], "knee height + thigh length", (c) => c.d.knee_height + c.d.femur_length, "derived", ["knee_height", "femur_length"])]);
const hjcX = (asisBreadth) => 0.33 * asisBreadth + 0.0073; // Harrington et al. 2007, J Biomech 40:595, equation 1 (medio-lateral), via the Visual3D wiki
def("hip_halfwidth", "Half the distance between the hip joint centres", "m",
  [route(["bicristal_breadth"], "Harrington 2007: 0.33 x ASIS breadth + 7.3 mm, ASIS breadth = 0.87 x bicristal breadth (approx.)", (c, v) => hjcX(K.asis * v)),
   route(["hip_breadth_sitting"], "same, bicristal breadth = hip breadth sitting / 1.36 (men) or 1.46 (women)", (c, v) => hjcX(K.asis * v / (c.f * 1.3623 + (1 - c.f) * 1.4643))),
   route(["other:hip_breadth"], "same, bicristal breadth = standing hip breadth / 1.26 (men) or 1.30 (women)", (c, v) => hjcX(K.asis * v / (c.f * 1.2603 + (1 - c.f) * 1.2978)))],
  estim("regression of the bicristal breadth on stature, mass and sex, then Harrington", (c) => hjcX(K.asis * c.E("bicristal_breadth"))),
  { lo: 0.06, hi: 0.14 });
def("hip_to_seat", "Hip joint centre above the seat plane (ISO 7250 seated)", "m",
  [route(["sitting_height"], "sitting height - (stature - hip height): the model's trunk and head are rigid, so the seat plane absorbs the difference", (c, v) => v - c.S + c.d.hip_height)],
  estim("mean of the 13,792 people (74 mm)", (c) => c.R("seat_below_hip")),
  { lo: 0.01, hi: 0.18, warnLo: 0.035, warnHi: 0.125,
    warnText: (c, v) => `Sitting height and the standing leg heights disagree: the hip joint would be ${(v * 1000).toFixed(0)} mm above the seat (typical 74 mm).` });

// ---- trunk and head heights
def("l5_above_hip", "L5/S1 joint above the hip centres", "m",
  [route(["iliocristale_height"], "iliocristale height - hip height - 35 mm (L5/S1 is below the iliac crest line)", (c, v) => v - c.d.hip_height - K.l5BelowIliocristale)],
  estim("relation: iliocristale above the hip centre (159 mm men, 143 mm women) - 35 mm", (c) => c.R("iliocristale_over_hip") - K.l5BelowIliocristale),
  { lo: 0.05, hi: 0.17 });
def("vertex_to_eye", "Vertex to the outer eye corner (ectocanthus)", "m",
  [route(["sitting_height", "eye_height_sitting"], "sitting height - eye height sitting", (c, a, b) => a - b),
   route(["eye_height_sitting"], "(stature - hip height + hip-to-seat) - eye height sitting", (c, v) => c.S - c.d.hip_height + c.d.hip_to_seat - v),
   route(["other:tragion_top_of_head"], "tragion-to-top-of-head - 17 mm (the tragion is below the eye corner)", (c, v) => v + c.R("eye_over_tragion"))],
  estim("relation: mean of the 13,792 people (119 mm men, 112 mm women)", (c) => c.R("vertex_to_eye")),
  { lo: 0.08, hi: 0.17 });
def("tragion_below_eye", "Tragion below the eye corner", "m",
  [route(["other:tragion_top_of_head"], "tragion-to-top-of-head - vertex-to-eye", (c, v) => v - c.d.vertex_to_eye)],
  estim("relation: 17 mm (ANSUR II)", (c) => -c.R("eye_over_tragion")),
  { lo: 0, hi: 0.05 });
def("head_pivot_depth", "Vertex to the occiput-C1 joint", "m",
  [route([], "vertex-to-eye + tragion-below-eye + 18 mm (the occipital condyles are below the tragion)", (c) => c.d.vertex_to_eye + c.d.tragion_below_eye + K.ocBelowTragion, "derived", ["vertex_to_eye", "tragion_below_eye"])]);
def("c7_height", "C7/T1 joint above the sole", "m",
  [route(["cervicale_height"], "cervicale height - 15 mm (the C7 spinous tip is above the C7/T1 disc centre)", (c, v) => v - K.c7BelowCervicale),
   route(["suprasternale_height"], "suprasternale height + (cervicale above suprasternale, 77 mm men / 72 mm women) - 15 mm", (c, v) => v + c.R("cervicale_over_suprasternale") - K.c7BelowCervicale),
   route(["acromion_height"], "acromion height + (cervicale above acromion, 75 / 68 mm) - 15 mm", (c, v) => v + c.R("cervicale_over_acromion") - K.c7BelowCervicale),
   route(["acromion_height_sitting"], "acromion height sitting + hip height - hip-to-seat + (cervicale above acromion) - 15 mm", (c, v) => v + c.d.hip_height - c.d.hip_to_seat + c.R("cervicale_over_acromion") - K.c7BelowCervicale)],
  estim("regression of the cervicale height on stature, mass and sex - 15 mm", (c) => c.E("cervicale_height") - K.c7BelowCervicale),
  { lo: (c) => Math.max(c.d.hip_height + c.d.l5_above_hip + 0.3, c.S - c.d.head_pivot_depth - 0.18), hi: (c) => Math.min(c.d.hip_height + c.d.l5_above_hip + 0.6, c.S - c.d.head_pivot_depth - 0.07) });
def("trunk_length", "Trunk (L5/S1 to C7/T1, vertical)", "m",
  [route([], "C7/T1 height - L5/S1 height", (c) => c.d.c7_height - c.d.hip_height - c.d.l5_above_hip, "derived", ["c7_height", "l5_above_hip"])]);
def("neck_length", "Neck (C7/T1 to the occiput-C1 joint, vertical)", "m",
  [route([], "stature - head pivot depth - C7/T1 height", (c) => c.S - c.d.head_pivot_depth - c.d.c7_height, "derived", ["head_pivot_depth", "c7_height"])]);

// ---- shoulder girdle and arm
def("shoulder_height", "Glenohumeral centre above the sole", "m",
  [route(["acromion_height"], "acromion height - 35 mm (the humeral head centre is below the acromion tip)", (c, v) => v - K.ghBelowAcromion),
   route(["cervicale_height"], "cervicale height - (cervicale above acromion) - 35 mm", (c, v) => v - c.R("cervicale_over_acromion") - K.ghBelowAcromion),
   route(["suprasternale_height"], "suprasternale height + (cervicale-acromion difference) - 35 mm", (c, v) => v + c.R("cervicale_over_suprasternale") - c.R("cervicale_over_acromion") - K.ghBelowAcromion),
   route(["acromion_height_sitting"], "acromion height sitting + hip height - hip-to-seat - 35 mm", (c, v) => v + c.d.hip_height - c.d.hip_to_seat - K.ghBelowAcromion)],
  estim("regression of the acromion height on stature, mass and sex - 35 mm", (c) => c.E("acromion_height") - K.ghBelowAcromion),
  { lo: (c) => c.d.c7_height - 0.16, hi: (c) => c.d.c7_height - 0.03 });
def("acromion_halfwidth", "Half the biacromial breadth (acromion tip to the midline)", "m",
  [route(["biacromial_breadth"], "biacromial breadth / 2", (c, v) => v / 2, "measured"),
   route(["bideltoid_breadth"], "bideltoid breadth / 2 - (deltoid beyond the acromion, 45 mm men / 39 mm women)", (c, v) => v / 2 - c.R("deltoid_extent"))],
  estim("regression of the biacromial breadth on stature, mass and sex", (c) => c.E("biacromial_breadth") / 2),
  { lo: 0.11, hi: 0.27 });
def("acromion_to_gh", "Acromion tip to the glenohumeral centre (sideways)", "m", [],
  estim("constant 50 mm (approx.); with a span in the profile it is solved so that the arm span in the T-pose is exactly the measure", () => K.ghInsideAcromion), { lo: 0.02, hi: 0.085 });
def("gh_halfwidth", "Half the distance between the glenohumeral centres", "m",
  [route([], "acromion half-width - acromion-to-glenohumeral offset", (c) => c.d.acromion_halfwidth - c.d.acromion_to_gh, "derived", ["acromion_halfwidth", "acromion_to_gh"])]);
def("shoulder_protraction", "Glenohumeral centre ahead of its standard place (sagittal)", "m", [],
  estim("0; with a thumbtip reach in the profile it is solved so that the reach with the arm forward is exactly the measure", () => 0), { lo: -0.08, hi: 0.08 });
def("upper_arm_length", "Upper arm (glenohumeral centre to elbow centre)", "m",
  [route(["acromion_radiale_length"], "acromion-radiale length - 35 mm - 12 mm (acromion above the shoulder centre, radiale below the elbow axis)", (c, v) => v - K.ghBelowAcromion - K.radialeBelowElbow),
   route(["shoulder_elbow_length"], "shoulder-elbow length - 35 mm - (olecranon below the elbow axis, 41 mm men / 36 mm women)", (c, v) => v - K.ghBelowAcromion - c.R("olecranon_drop"))],
  estim("regression of the acromion-radiale length on stature, mass and sex - 47 mm", (c) => c.E("acromion_radiale_length") - K.ghBelowAcromion - K.radialeBelowElbow),
  { lo: 0.19, hi: 0.42 });
def("olecranon_drop", "Elbow axis to the lowest point of the olecranon (elbow at 90 degrees)", "m",
  [route(["shoulder_elbow_length"], "shoulder-elbow length - 35 mm - upper arm length", (c, v) => v - K.ghBelowAcromion - c.d.upper_arm_length)],
  estim("relation: mean of the 13,792 people (41 mm men, 36 mm women)", (c) => c.R("olecranon_drop")),
  { lo: 0.015, hi: 0.07 });
simple("hand_length", "Hand length (stylion to the tip of the middle finger)", "hand_length", 0.12, 0.26);
def("forearm_length", "Forearm (elbow centre to wrist centre)", "m",
  [route(["radiale_stylion_length"], "radiale-stylion length + 12 mm (radiale below the elbow axis; the wrist centre is at the stylion level, de Leva 1996)", (c, v) => v + K.radialeBelowElbow),
   route(["other:elbow_wrist_length"], "elbow-wrist length - 31 mm (= radiale-stylion length in the four populations that report both: 29.4 to 31.5 mm; approx.) + 12 mm", (c, v) => v - K.elbowWristOverRadialeStylion + K.radialeBelowElbow),
   route(["other:forearm_hand_length", "hand_length"], "forearm-hand length - hand length - (mean of forearm-hand length minus hand length minus radiale-stylion length: 19.5 mm men / 18.3 mm women) + 12 mm", (c, fh, hl) => fh - hl - c.R("fhl_minus_hand_rsl") + K.radialeBelowElbow)],
  estim("regression of the radiale-stylion length on stature, mass and sex + 12 mm", (c) => c.E("radiale_stylion_length") + K.radialeBelowElbow),
  { lo: 0.17, hi: 0.36 });
simple("hand_breadth", "Hand breadth (across the metacarpal heads)", "hand_breadth", 0.06, 0.13);

// ---- foot, head
simple("foot_length", "Foot length (heel to the longest toe)", "foot_length", 0.18, 0.36);
simple("foot_breadth", "Foot breadth (across the metatarsal heads)", "foot_breadth", 0.06, 0.14);
def("ball_length", "Heel to the first metatarsal head", "m",
  [route([], "foot length x 0.737 (ball-of-foot length / foot length of 11,365 people)", (c) => c.d.foot_length * c.R("ball_ratio"), "derived", ["foot_length"])]);
simple("head_length", "Head length (glabella to opisthocranion)", "head_length", 0.15, 0.25);
simple("head_breadth", "Head breadth (euryon to euryon)", "head_breadth", 0.12, 0.2);
simple("bizygomatic_breadth", "Bizygomatic breadth", "bizygomatic_breadth", 0.1, 0.18);
simple("menton_sellion_length", "Menton-sellion length", "menton_sellion_length", 0.08, 0.16);
simple("interpupillary_breadth", "Interpupillary breadth", "interpupillary_breadth", 0.04, 0.09);

// ---- offsets that make the seated measures come out by construction
def("knee_top_front", "Top of the thigh above the knee axis (seated knee height - knee axis height)", "m",
  [route(["knee_height_sitting"], "knee height sitting - knee height", (c, v) => v - c.d.knee_height)],
  estim("relation: 61 mm men / 50 mm women", (c) => c.R("knee_top_over_knee")), { lo: 0.02, hi: 0.13 });
def("popliteal_below_knee", "Underside of the thigh behind the knee below the knee axis", "m",
  [route(["popliteal_height"], "knee height - popliteal height", (c, v) => c.d.knee_height - v)],
  estim("relation: 64 mm men / 75 mm women", (c) => c.R("knee_over_popliteal")), { lo: 0.02, hi: 0.14 });
def("thigh_thickness", "Thigh thickness at its thickest (thigh clearance)", "m",
  [same("thigh_clearance")], estim("regression of the thigh clearance on stature, mass and sex", (c) => c.E("thigh_clearance")), { lo: 0.08, hi: 0.3 });
def("buttock_back", "Hip centre to the most posterior point of the buttocks", "m",
  [route(["buttock_knee_length"], "buttock-knee length - thigh length - 70 mm (patella front ahead of the knee axis, knee at 90 degrees)", (c, v) => v - c.d.femur_length - K.patellaAhead)],
  estim("relation: buttock-knee length - thigh length = 208 mm (men) / 204 mm (women), - 70 mm", (c) => c.R("bkl_minus_femur") - K.patellaAhead), { lo: 0.06, hi: 0.22 });
def("popliteal_setback", "Popliteal point proximal to the knee axis (along the thigh)", "m",
  [route(["buttock_popliteal_length"], "thigh length + buttock back - buttock-popliteal length", (c, v) => c.d.femur_length + c.d.buttock_back - v)],
  estim("relation: (buttock-knee - buttock-popliteal length = 112 mm men / 107 mm women) - 70 mm", (c) => c.R("bkl_minus_bpl") - K.patellaAhead), { lo: 0, hi: 0.14 });

const RING_DOC = [
  ["buttock", "Hip / buttock section (breadth, buttock depth, buttock girth)", ["other:hip_breadth", "hip_breadth_sitting", "other:buttock_depth", "buttock_circumference"]],
  ["waist", "Waist section at the omphalion", ["other:waist_breadth", "other:waist_depth", "waist_circumference"]],
  ["chest", "Chest section at the nipple level", ["chest_breadth", "chest_depth", "chest_circumference"]],
  ["neck_base", "Neck base section", ["neck_circumference_base"]], ["neck", "Neck section", ["neck_circumference"]],
  ["biceps", "Upper arm section", ["biceps_circumference_flexed"]], ["forearm", "Forearm section", ["forearm_circumference_flexed"]], ["wrist", "Wrist section", ["wrist_circumference"]],
  ["thigh", "Thigh section", ["thigh_circumference", "thigh_clearance"]], ["knee", "Knee section", ["other:knee_circumference"]],
  ["calf", "Calf section", ["calf_circumference"]], ["ankle", "Ankle section", ["ankle_circumference"]], ["head", "Head section at the brow", ["head_circumference", "head_breadth", "head_length"]],
];
// girth id -> the regression key of its circumference (for the plausibility band of an edited girth)
const RING_KEY = { buttock: "buttock_circumference", waist: "waist_circumference", chest: "chest_circumference", neck_base: "neck_circumference_base", neck: "neck_circumference",
  biceps: "biceps_circumference_flexed", forearm: "forearm_circumference_flexed", wrist: "wrist_circumference", thigh: "thigh_circumference", knee: "other:knee_circumference",
  calf: "calf_circumference", ankle: "ankle_circumference" };
let _overridable, _readKeys;
/** Ids the user may override: every dimension of the table and the girths (`ring_<name>`; not the head's). */
function OVERRIDABLE() {
  return (_overridable ??= new Set([...DEFS.map((d) => d.id), ...RING_DOC.filter(([id]) => id !== "head").map(([id]) => `ring_${id}`)]));
}
/** A profile key the model reads (so that an unreadable unit on it is worth a warning). */
function isReadKey(k) {
  if (k === "stature" || k === "mass" || k === "bmi") return true;
  _readKeys ??= new Set([...Object.keys(REG_DATA).flatMap((x) => [x, `other:${x}`]), ...DEFS.flatMap((d) => d.routes.flatMap((r) => r.k)), ...MEASURES.map((m) => m.id)]);
  return _readKeys.has(k);
}
DIM_DEFS.push(
  { id: "stature", label: "Stature (vertex height)", unit: "m", formula: ["stature"], requires: ["stature"], fallback: "median of the inverse regressions of the other heights on stature; else the median stature of the 13,792 people (men 1764 mm, women 1629 mm, neutral: mean)" },
  { id: "mass", label: "Body mass", unit: "kg", formula: ["mass", "BMI x stature^2"], requires: ["mass", "bmi"], fallback: "median BMI of the 13,792 people (men 26.2, women 24.0 kg/m2) x stature^2" },
  ...RING_DOC.map(([id, label, requires]) => ({ id: `ring_${id}`, label: `${label} (girth)`, unit: "m", formula: ["superellipse through the measured breadth, depth and girth (the exponent is solved when all three are given; the girth wins when no exponent reaches it)"], requires, fallback: "regression of the girth on stature, mass and sex with the typical depth/breadth ratio" })),
  { id: "adiposity", label: "Adiposity factor on the estimated sections", unit: "ratio", formula: ["sqrt((mass / (1050 kg/m3 x calibration) - fixed volume) / estimated volume), only when at least 25 % of the volume is estimated"], requires: ["mass"], fallback: "1" },
);
DIM_DEFS.push(...DEFS.map((d) => ({
  id: d.id, label: d.label, unit: d.unit,
  formula: d.routes.length ? d.routes.map((r) => r.via) : ["no measure drives it: see the fallback"],
  requires: [...new Set(d.routes.flatMap((r) => r.k))],
  fallback: d.est ? d.est.via : "derived from other dimensions (always available)",
  lo: typeof d.lo === "function" ? "relative" : d.lo, hi: typeof d.hi === "function" ? "relative" : d.hi,
})));

// =====================================================================================================================
// Layout of the neutral standing pose. All joint centres in world coordinates (m); the offsets of skeleton.js are differences of these.
// Feet flat on y = 0, legs vertical, arms hanging along the body (slightly abducted so that the hands clear the hips), forearms in
// mid-position (palms face the thighs, thumbs forward), spine in its natural standing curvature.
const G = {
  heelToAnkle: 0.2,        // heel (pternion) to the ankle centre, fraction of foot length (approx.; lateral malleolus is 55-60 mm from the back of the heel)
  mtpHeight: 0.026,        // centre of the metatarsal heads above the sole (m, for a 0.27 m foot; scaled by foot length) (approx.)
  mt5Behind: 0.022,        // fifth metatarsal head behind the first (m, scaled) (approx.)
  heelPoint: 0.045,        // height of the pternion above the sole (scaled) (approx.)
  armGap: 0.04,            // wrist centre at least this far outside the hip edge, so that hands do not hang inside the thighs
  maxArmTilt: 14 * D2R,    // largest abduction of the hanging arm that the neutral pose uses
  minArmTilt: 3 * D2R,     // natural abduction/carrying angle of the hanging arm
  armClear: 0.016,         // the skin of the hanging arm may press this far into the trunk's skin (soft tissue gives; approx.), no more
  armShiftMax: 0.05,       // the skin of the arm is moved outward (away from the bone axis) by up to this much to clear the trunk (approx.)
  scX: 0.019, ssAhead: 0.08, // sternoclavicular joint x; suprasternale ahead of the spine axis (approx.)
  // hand: positions as fractions of hand length (along) and hand breadth (across, + toward the thumb). Palm = wrist -> MCP (0.456 of the hand
  // length for the middle finger, approx. from de Leva's hand segment of 86 mm in 189 mm, recalled not re-read); tip = fraction of hand length of the
  // finger tip from the wrist. Bone shares PP:MP:DP and the other fractions are typical proportions (approx., no source).
  fingers: {
    index:  { palm: 0.435, across: 0.385, tip: 0.93,  share: [0.45, 0.28, 0.27], halfW: 0.11 },
    middle: { palm: 0.456, across: 0.13,  tip: 1.0,   share: [0.45, 0.28, 0.27], halfW: 0.115 },
    ring:   { palm: 0.435, across: -0.12, tip: 0.955, share: [0.45, 0.28, 0.27], halfW: 0.105 },
    little: { palm: 0.4,   across: -0.36, tip: 0.8,   share: [0.47, 0.27, 0.26], halfW: 0.09 },
  },
  thumb: { cmcAlong: 0.1, cmcAcross: 0.33, lengths: [0.255, 0.175, 0.15], splay: 22 * D2R, palmar: 0.08 },
};

const OFF = { // landmark offsets from the joint centres (m, neutral frame) that nothing measures (approx.)
  acromionZ: 0.005, radiale: [0.01, -K.radialeBelowElbow, 0.012], stylion: [0.004, 0, 0.021], olecranonUp: 0.005,
  trochanterOut: 0.065, ischialX: 0.055, ischialBack: 0.045, grip: [-0.015, 0, 0],
};

/** Piecewise-linear z of the spine axis at height y (the spine joints are sorted by height). */
function spineProfile(P) {
  const ids = ["pelvis", "L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1", "head"];
  const ys = ids.map((i) => P[i][1]), zs = ids.map((i) => P[i][2]);
  return (y) => {
    if (y <= ys[0]) return zs[0];
    for (let i = 1; i < ys.length; i++) if (y <= ys[i]) return zs[i - 1] + ((y - ys[i - 1]) / (ys[i] - ys[i - 1])) * (zs[i] - zs[i - 1]);
    return zs[zs.length - 1];
  };
}

/**
 * The spine from L5/S1 to the occiput-C1 joint. Pitch of each level follows K.pitchTrunk / K.pitchNeck, the curve is built from the
 * direction of the vertebral centre line (T1 slope, kyphosis, lordosis, cervical lordosis) and a uniform rotation `phi` that is solved
 * so that C7/T1 lies K.sva ahead of L5/S1 (a balanced standing spine). The level pitches are scaled so that the vertical extent is exactly
 * the one the heights prescribe (L5/S1 to C7/T1, C7/T1 to the head pivot): the vertical closure on stature.
 */
function buildSpine(yL5, yC7, yOC) {
  const wT = K.pitchTrunk, wN = K.pitchNeck;
  const th = (phi) => {
    const t1 = K.t1Slope + phi, t12 = t1 - K.kyphosis, l5 = t12 + K.lordosis;
    const trunk = wT.map((_, i) => (i < 5 ? l5 - (K.lordosis * (i + 0.5)) / 5 : t12 + (K.kyphosis * (i - 5 + 0.5)) / 12));
    const neck = wN.map((_, q) => t1 - (K.cervical * (q + 0.5)) / wN.length);
    return { trunk, neck };
  };
  const trunkDz = (phi) => {
    const { trunk } = th(phi);
    let sc = 0, sz = 0;
    trunk.forEach((t, i) => { sc += wT[i] * Math.cos(t * D2R); sz += wT[i] * Math.sin(t * D2R); });
    return ((yC7 - yL5) / sc) * sz;
  };
  const phi = bisect(trunkDz, -40, 25, K.sva, 40);
  const { trunk, neck } = th(phi);
  const pos = [[0, yL5, -K.l5Behind]];
  const kT = (yC7 - yL5) / trunk.reduce((a, t, i) => a + wT[i] * Math.cos(t * D2R), 0);
  trunk.forEach((t, i) => { const p = pos[pos.length - 1]; pos.push([0, p[1] + kT * wT[i] * Math.cos(t * D2R), p[2] + kT * wT[i] * Math.sin(t * D2R)]); });
  const kN = (yOC - yC7) / neck.reduce((a, t, q) => a + wN[q] * Math.cos(t * D2R), 0);
  neck.forEach((t, q) => { const p = pos[pos.length - 1]; pos.push([0, p[1] + kN * wN[q] * Math.cos(t * D2R), p[2] + kN * wN[q] * Math.sin(t * D2R)]); });
  return { pos, phi };
}
const SPINE_IDS = ["L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1", "head"];

/** Heights of the surface landmarks the surveys measure to: the measured value when the profile has one and it is plausible, else derived. */
function surfaceHeights(c) {
  const d = c.d, out = {};
  const pick = (key, derived, tol = 0.07) => {
    const v = c.g(key);
    if (v === undefined) return derived;
    if (Math.abs(v - derived) <= tol) return v;
    c.warnings.push(`${key} (${Math.round(v * 1000)} mm) is ${Math.round(Math.abs(v - derived) * 1000)} mm from where the other measures put it: the landmark was placed at the model's own height instead.`);
    return derived;
  };
  out.cervicale = pick("cervicale_height", d.c7_height + K.c7BelowCervicale);
  out.suprasternale = pick("suprasternale_height", out.cervicale - c.R("cervicale_over_suprasternale"));
  out.acromion = pick("acromion_height", d.shoulder_height + K.ghBelowAcromion);
  out.trochanterion = pick("trochanterion_height", d.hip_height - K.hjcAboveTroch);
  out.crotch = pick("crotch_height", d.hip_height - c.R("hip_over_crotch"), 0.1);
  out.iliocristale = pick("iliocristale_height", d.hip_height + d.l5_above_hip + K.l5BelowIliocristale);
  out.omphalion = pick("other:omphalion_height", d.hip_height + c.R("omphalion_over_hip"));
  out.chest = pick("other:chest_height", c.E("other:chest_height"));
  out.axilla = pick("other:axilla_height", c.E("other:axilla_height"));
  out.buttock = d.hip_height - K.hjcAboveTroch + c.R("buttock_over_trochanter");
  out.gluteal = out.trochanterion + c.R("gluteal_over_trochanter");
  return out;
}

function layout(c) {
  const d = c.d, S = c.S;
  const P = { pelvis: [0, d.hip_height, 0] };
  const put = (idL, p) => { P[idL] = p; P[mirrorId(idL)] = mirror3(p); };
  const hx = d.hip_halfwidth;

  // ---- legs and feet
  put("hip_L", [hx, d.hip_height, 0]);
  put("knee_L", [hx, d.knee_height, 0]);
  put("ankle_L", [hx, d.ankle_height, 0]);
  const fs = d.foot_length / 0.27; // scale of the foot constants
  const heelZ = -G.heelToAnkle * d.foot_length;
  put("mtp_L", [hx, G.mtpHeight * fs, heelZ + d.ball_length - 0.5 * G.mt5Behind * fs]);

  // ---- spine
  const yL5 = d.hip_height + d.l5_above_hip, yOC = S - d.head_pivot_depth;
  const sp = buildSpine(yL5, d.c7_height, yOC);
  SPINE_IDS.forEach((id, i) => { P[id] = sp.pos[i]; });
  const zAt = spineProfile(P);

  // ---- head: tragion is 12 mm ahead of the occiput-C1 axis; the face is half a head length ahead of the tragion
  const zTr = P.head[2] + 0.012, yEcto = S - d.vertex_to_eye, yTr = yEcto - d.tragion_below_eye;
  const hl = d.head_length;
  const zGl = zTr + 0.5 * hl;
  P.jaw = [0, yTr + 0.005, zTr + 0.012];
  const ipd = d.interpupillary_breadth;
  const yPupil = yEcto - 0.002, zPupil = zGl - 0.005;
  put("eye_L", [ipd / 2, yPupil, zPupil - 0.012]);

  // ---- shoulder girdle and arms
  const hs = surfaceHeights(c);
  const zC7 = P.C7[2], zGH = zC7 + K.ghAhead + d.shoulder_protraction;
  const ssY = hs.suprasternale;
  put("clavicle_L", [G.scX, ssY - 0.006, zAt(ssY) + G.ssAhead - 0.008]);
  const gh = [d.gh_halfwidth, d.shoulder_height, zGH];
  put("shoulder_L", gh);
  const hipEdge = 0.5 * (c.g("other:hip_breadth") ?? (c.has("hip_breadth_sitting") ? c.g("hip_breadth_sitting") * c.R("hip_over_hipbr_ratio") : c.E("other:hip_breadth")));
  // the arm hangs abducted just enough for the wrist to clear the hips (G.armGap outside the hip edge); the skin of the arm clears the trunk by its own lateral offset (buildShape)
  const armGeom = (Lua, Lfa) => {
    const need = hipEdge + G.armGap - gh[0];
    const beta = clamp(Math.asin(clamp(need / (Lua + Lfa), 0, 0.5)), G.minArmTilt, G.maxArmTilt);
    const u = [Math.sin(beta), -Math.cos(beta), 0]; // direction of the hanging arm, forearm and hand
    const elbow = add3(gh, mul3(u, Lua)), wrist = add3(elbow, mul3(u, Lfa));
    return { beta, u, elbow, wrist, acr: [gh[0] + d.acromion_to_gh, hs.acromion, gh[2] + OFF.acromionZ], rad: add3(elbow, OFF.radiale), sty: add3(wrist, OFF.stylion) };
  };
  // acromion-radiale and radiale-stylion lengths are distances between landmarks, not between joint centres: solve the bone lengths so that the landmark distances
  // are exactly the measures (4 fixed-point steps; the offsets are 12 to 47 mm so this converges at once). A length the user typed is not refined; neither is one that
  // is an estimate (the measure was rejected or is absent) or was built from another measure; a refinement stays within 12 mm of the formula of 2.4.
  const Lua0 = c.v0("upper_arm_length"), Lfa0 = c.v0("forearm_length");
  let Lua = Lua0, Lfa = Lfa0, A = armGeom(Lua, Lfa);
  const ua = c.dimById("upper_arm_length"), fa = c.dimById("forearm_length"), fixed = (id) => Number.isFinite(c.overrides[id]) || c.dimById(id)?.status === "estimated";
  const ARL = ua.via.includes("acromion_radiale_length") ? c.g("acromion_radiale_length") : undefined, RSL = fa.via.includes("radiale_stylion_length") ? c.g("radiale_stylion_length") : undefined;
  for (let it = 0; it < 4; it++) {
    if (ARL !== undefined && !fixed("upper_arm_length")) Lua = clamp(Lua + ARL - dist3(A.acr, A.rad), Lua0 - 0.012, Lua0 + 0.012);
    A = armGeom(Lua, Lfa);
    if (RSL !== undefined && !fixed("forearm_length")) Lfa = clamp(Lfa + RSL - dist3(A.rad, A.sty), Lfa0 - 0.012, Lfa0 + 0.012);
    A = armGeom(Lua, Lfa);
  }
  c.refine("upper_arm_length", Lua, "refined so that the acromion-radiale distance between the landmarks is exactly the measure");
  c.refine("forearm_length", Lfa, "refined so that the radiale-stylion distance between the landmarks is exactly the measure");
  const { beta, u, elbow, wrist } = A;
  put("elbow_L", elbow);
  put("forearm_L", elbow);
  put("wrist_L", wrist);
  // olecranon drop: the shoulder-elbow length is acromion -> lowest point of the olecranon with the elbow at 90 degrees (the olecranon
  // offset (0, +5 mm, -o) turns into (0, -o, -5 mm)); solve o so that this distance is the measure
  const SEL = c.g("shoulder_elbow_length");
  if (SEL !== undefined && !fixed("olecranon_drop")) {
    const v = sub3(A.acr, elbow), o = Math.sqrt(Math.max(SEL * SEL - v[0] * v[0] - (v[2] + OFF.olecranonUp) ** 2, 0)) - v[1];
    if (o > 0.015 && o < 0.07) c.refine("olecranon_drop", o, "solved so that the acromion-olecranon distance with the elbow at 90 degrees is exactly the shoulder-elbow length");
  }

  // ---- hand (left), straight fingers hanging along u, thumb splayed forward
  const HL = d.hand_length, HB = d.hand_breadth;
  const alongP = (s, z = 0, x = 0) => [wrist[0] + u[0] * s + x, wrist[1] + u[1] * s, wrist[2] + z];
  // the stylion is OFF.stylion from the wrist centre, the middle fingertip lies across by G.fingers.middle.across * HB: solve the distance T along
  // the hand axis so that |dactylion - stylion| is exactly the hand length
  const sx = OFF.stylion[0], tipDz = G.fingers.middle.across * HB - OFF.stylion[2], sb = Math.sin(beta);
  const midTip = sx * sb + Math.sqrt(Math.max(sx * sx * sb * sb - sx * sx - tipDz * tipDz + HL * HL, 0.001));
  const hand = { tipOf: {} };
  for (const [name, fg] of Object.entries(G.fingers)) {
    const total = name === "middle" ? midTip : fg.tip * HL;
    const mcpS = fg.palm * HL, fl = total - mcpS, z = fg.across * HB;
    const b = fg.share.map((s) => s * fl);
    put(`${name}_mcp_L`, alongP(mcpS, z));
    put(`${name}_pip_L`, alongP(mcpS + b[0], z));
    put(`${name}_dip_L`, alongP(mcpS + b[0] + b[1], z));
    hand.tipOf[name] = alongP(total, z);
  }
  {
    const t = G.thumb, dir = [Math.sin(beta) * Math.cos(t.splay) - t.palmar, -Math.cos(beta) * Math.cos(t.splay), Math.sin(t.splay)];
    const n = len3(dir), tu = mul3(dir, 1 / n);
    const cmc = alongP(t.cmcAlong * HL, t.cmcAcross * HB);
    const mcp = add3(cmc, mul3(tu, t.lengths[0] * HL)), ip = add3(mcp, mul3(tu, t.lengths[1] * HL));
    put("thumb_cmc_L", cmc); put("thumb_mcp_L", mcp); put("thumb_ip_L", ip);
    hand.tipOf.thumb = add3(ip, mul3(tu, t.lengths[2] * HL));
  }
  const spine = { balanceRotationDeg: r6(sp.phi), t1SlopeDeg: K.t1Slope + r6(sp.phi), kyphosisDeg: K.kyphosis, lordosisDeg: K.lordosis, cervicalDeg: K.cervical, sagittalOffsetM: K.sva, l5BehindHipM: K.l5Behind };
  return { P, zAt, hs, beta, u, hand, heelZ, fs, sp, spine, yEcto, yTr, zTr, zGl, yPupil, zPupil, ssY };
}

/** Joint offsets of a layout: each joint relative to its parent (the pelvis offset is its height above the floor). */
function offsetsOf(P) {
  const out = {};
  for (const j of JOINTS) out[j.id] = { offset: (j.parent ? sub3(P[j.id], P[j.parent]) : [P.pelvis[0], P.pelvis[1], P.pelvis[2]]).map(r6) };
  return out;
}

// =====================================================================================================================
// Shape: girth rings for the skin generator (documented in MODEL.md section 6).
// A ring is the superellipse |x/rx|^n + |z/rz|^n = 1 in a horizontal plane, centred at `c` (world coordinates of the neutral pose, m);
// the limbs are within 14 degrees of vertical, so a ring is perpendicular to its tube up to that tilt. n = 2 is an ellipse; trunk rings have
// n up to 5 because a chest or waist is boxier than an ellipse (the measured girths are 4 to 16 % longer than the ellipse through the
// measured breadth and depth, see SHAPE). `src`: "measured" (breadth, depth and girth all from the profile), "derived" (some from the profile,
// none altered), "estimated" (regressions only: only these are scaled by the adiposity factor). `bind` = skin weights [[joint, w], ...].
const SHAPE = { // [men, women]: perimeter of the measured section / perimeter of the ellipse through breadth and depth; depth / breadth
  chest: { per: [1.1634, 1.1346], db: [0.8127, 0.8846] },
  waist: { per: [1.0425, 1.0359], db: [0.7259, 0.7065] },
  hip: { per: [1.0704, 1.0822], db: [0.7051, 0.6608] },
  head: { per: [1.0271, 1.0468], db: [1.287, 1.287] },
};
// Depth / breadth of the standing thigh section at the gluteal furrow: circular (approx.; no survey measures the breadth of the thigh).
const THIGH_RATIO = 1.0;
const nCache = new Map();
function typicalN(name, f) {
  const k = `${name}:${f}`;
  if (!nCache.has(k)) {
    const s = SHAPE[name], one = (i) => bisect((n) => ringPerimeter(1, s.db[i], n) / ellipsePerimeter(1, s.db[i]), 1.8, 5, s.per[i], 30);
    nCache.set(k, f * one(0) + (1 - f) * one(1));
  }
  return nCache.get(k);
}

/**
 * Section of one body part. o: { B, D, G: measured values (m) or undefined; eB, eD, eG: estimates; ratio: depth/breadth when only the
 * girth is known; shape: key of SHAPE; keys: [keyB, keyD, keyG] for the mapping table }. Measured values are never altered.
 */
function girthRing(c, o) {
  const n0 = o.shape ? typicalN(o.shape, c.f) : 2;
  const ratio = o.ratio ?? o.eD / o.eB;
  const via = (o.keys ?? []).filter((k, i) => k && [o.B, o.D, o.G][i] !== undefined);
  if (o.B !== undefined || o.D !== undefined || o.G !== undefined) {
    const b = o.B ?? (o.G === undefined ? o.eB : undefined), dd = o.D ?? (o.G === undefined ? o.eD : undefined);
    const sec = sectionFrom({ B: b, D: dd, G: o.G, ratio, n0 });
    const all = o.need.every((x) => [o.B, o.D, o.G][x] !== undefined) && Math.abs(sec.short) < 1e-3 && sec.k === 1; // reproduced: breadth, depth AND girth
    return { ...sec, status: all ? "measured" : "derived", via };
  }
  return { ...sectionFrom({ G: o.eG, ratio, n0 }), status: "estimated", via };
}
// a section scaled from another one (derived: it inherits the status)
const scaled = (sec, kx, kz, n = sec.n) => ({ rx: sec.rx * kx, rz: sec.rz * kz, n, girth: ringPerimeter(sec.rx * kx, sec.rz * kz, n), status: sec.status === "estimated" ? "estimated" : "derived", via: sec.via });

const TORSO_CHAIN = ["pelvis", "L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1", "C7", "C6", "C5", "C4", "C3", "C2", "C1", "head"];
function bindAlong(P, chain, y) {
  if (y <= P[chain[0]][1]) return [[chain[0], 1]];
  for (let i = 1; i < chain.length; i++) {
    const y0 = P[chain[i - 1]][1], y1 = P[chain[i]][1];
    if (y <= y1) { const t = (y - y0) / (y1 - y0); return [[chain[i - 1], r6(1 - t)], [chain[i], r6(t)]]; }
  }
  return [[chain[chain.length - 1], 1]];
}
/** Skin weights for a ring at fraction t (0..1) along a limb bone: it follows `own`, blended with the proximal joint over the first 15 % and
 * with the distal joint over the last 15 %. */
function bindLimb(prev, own, next, t) {
  const a = prev ? 0.5 * (1 - smooth(t / 0.15)) : 0, b = next ? 0.5 * smooth((t - 0.85) / 0.15) : 0;
  const out = [[own, r6(1 - a - b)]];
  if (a > 1e-6) out.push([prev, r6(a)]);
  if (b > 1e-6) out.push([next, r6(b)]);
  return out;
}

/** Volume (m3) of a tube from its rings (trapezoid rule along the centre line), split into the part that scales with s^2 and the rest. */
function tubeVolume(rings) {
  let fixed = 0, est = 0;
  rings.forEach((r, i) => {
    const a = i > 0 ? dist3(r.c, rings[i - 1].c) : 0, b = i < rings.length - 1 ? dist3(r.c, rings[i + 1].c) : 0;
    const v = 0.5 * (a + b) * ringArea(r.rx, r.rz, r.n);
    if (r._scal) est += v; else fixed += v;
  });
  return { fixed, est };
}

/**
 * The girth sections that depend on the profile alone (not on the layout): hip, waist, chest, neck base, neck, upper arm, forearm, wrist. They are needed before the
 * layout (the arm must hang clear of the trunk) and again by the shape, so they are built once per fit (`Fit.sections()`).
 */
function sectionsOf(c) {
  const g = (k) => c.g(k), ov = (id) => c.ringOverride(id);
  const hipBsit = g("hip_breadth_sitting");
  const hipB = g("other:hip_breadth") ?? (hipBsit !== undefined ? hipBsit * c.R("hip_over_hipbr_ratio") : undefined);
  const keyHip = g("other:hip_breadth") !== undefined ? "other:hip_breadth" : "hip_breadth_sitting";
  const hipSec = girthRing(c, { B: hipB, D: g("other:buttock_depth"), G: ov("buttock") ?? g("buttock_circumference"), eB: c.E("other:hip_breadth"), eD: c.E("other:buttock_depth"), eG: c.E("buttock_circumference"), shape: "hip", keys: [keyHip, "other:buttock_depth", "buttock_circumference"], need: [0, 1, 2] });
  const waistSec = girthRing(c, { B: g("other:waist_breadth"), D: g("other:waist_depth"), G: ov("waist") ?? g("waist_circumference"), eB: c.E("other:waist_breadth"), eD: c.E("other:waist_depth"), eG: c.E("waist_circumference"), shape: "waist", keys: ["other:waist_breadth", "other:waist_depth", "waist_circumference"], need: [0, 1, 2] });
  const chestSec = girthRing(c, { B: g("chest_breadth"), D: g("chest_depth"), G: ov("chest") ?? g("chest_circumference"), eB: c.E("chest_breadth"), eD: c.E("chest_depth"), eG: c.E("chest_circumference"), shape: "chest", keys: ["chest_breadth", "chest_depth", "chest_circumference"], need: [0, 1, 2] });
  const nbSec = girthRing(c, { G: ov("neck_base") ?? g("neck_circumference_base"), eG: c.E("neck_circumference_base"), ratio: 0.88, keys: [null, null, "neck_circumference_base"], need: [2] });
  const neckSec = girthRing(c, { G: ov("neck") ?? g("neck_circumference"), eG: c.E("neck_circumference"), ratio: 0.95, keys: [null, null, "neck_circumference"], need: [2] });
  const bicepsSec = girthRing(c, { G: ov("biceps") ?? g("biceps_circumference_flexed"), eG: c.E("biceps_circumference_flexed"), ratio: 1.0, keys: [null, null, "biceps_circumference_flexed"], need: [2] });
  const foreSec = girthRing(c, { G: ov("forearm") ?? g("forearm_circumference_flexed"), eG: c.E("forearm_circumference_flexed"), ratio: 1.08, keys: [null, null, "forearm_circumference_flexed"], need: [2] });
  const wristSec = girthRing(c, { G: ov("wrist") ?? g("wrist_circumference"), eG: c.E("wrist_circumference"), ratio: 1.45, keys: [null, null, "wrist_circumference"], need: [2] });
  return { hipSec, waistSec, chestSec, nbSec, neckSec, bicepsSec, foreSec, wristSec };
}

/**
 * Every ring of the body for adiposity factor `s`, as tubes (arrays of rings, ordered along the tube), plus the head, hand and foot
 * descriptions and the volume. `record` registers the girth dimensions in the mapping table (last pass only).
 */
function buildShape(c, geo, s, record) {
  const d = c.d, P = geo.P, hs = geo.hs, zAt = geo.zAt;
  const vol = { fixed: 0, est: 0 };
  const addVol = (v) => { vol.fixed += v.fixed; vol.est += v.est; };
  const g = (k) => c.g(k);
  const ov = (id) => c.ringOverride(id); // the user's edit of a girth
  const note = (id, label, sec) => {
    if (record) c.note(`ring_${id}`, label, "m", sec.girth, sec.status, sec.via,
      `section ${(2 * sec.rx * 1000).toFixed(0)} x ${(2 * sec.rz * 1000).toFixed(0)} mm, exponent ${sec.n.toFixed(2)}, girth ${(sec.girth * 1000).toFixed(0)} mm${sec.status === "estimated" ? ", scaled by the adiposity factor" : ""}`
      + (Math.abs(sec.short) > 1e-3 ? `; the measured girth is ${((sec.girth + sec.short) * 1000).toFixed(0)} mm, ${(100 * sec.short / (sec.girth + sec.short)).toFixed(1)} % more than the section holds (the tape picked up more than a section of the measured breadth and depth with an exponent up to ${N_MAX} can hold)` : "")
      + (sec.k > 1 ? `; breadth and depth were scaled by ${sec.k.toFixed(3)} to bring the girth within ${(GIRTH_SLACK * 100).toFixed(1)} %` : ""));
  };
  const ring = (id, y, sec, center, bind) => {
    const sc = sec.status === "estimated" ? s : 1;
    const rx = sec.rx * sc, rz = sec.rz * sc, cc = center(rx, rz);
    const r = { id, c: [r6(cc[0]), r6(y ?? cc[1]), r6(cc[2])], rx: r6(rx), rz: r6(rz), n: r6(sec.n), src: sec.status, bind };
    Object.defineProperty(r, "_scal", { value: sec.status === "estimated", enumerable: false });
    return r;
  };
  const sections = {};

  // ---------------------------------------------------------------- trunk (rings ordered upward)
  const { hipSec, waistSec, chestSec, nbSec, neckSec, bicepsSec, foreSec, wristSec } = c.sections();
  sections.hip = hipSec; sections.waist = waistSec; sections.chest = chestSec; sections.neck_base = nbSec; sections.neck = neckSec;
  note("buttock", "Hip / buttock section (breadth, buttock depth, buttock girth)", hipSec);
  note("waist", "Waist section at the omphalion", waistSec);
  note("chest", "Chest section at the nipple level", chestSec);
  note("neck_base", "Neck base section", nbSec);
  note("neck", "Neck section", neckSec);

  const t = (id, y, sec, center) => ring(id, y, sec, center, bindAlong(P, TORSO_CHAIN, y));
  const lvl = []; // [id, y, section, centre fn]
  const yHip = hs.buttock, yW = hs.omphalion, yC = hs.chest, yAx = hs.axilla, yAc = hs.acromion - 0.02, yCv = hs.cervicale - 0.01;
  const sBack = d.buttock_back;
  const crotchSec = scaled(hipSec, 0.62, 0.8, 2);
  lvl.push(["crotch", hs.crotch + 0.02, crotchSec, (rx, rz) => [0, 0, -0.55 * sBack + rz]]);
  lvl.push(["buttock", yHip, hipSec, (rx, rz) => [0, 0, -sBack + rz]]);
  lvl.push(["waist", yW, waistSec, (rx, rz) => [0, 0, zAt(yW) - K.spineBack.lumbar + rz]]);
  lvl.push(["chest", yC, chestSec, (rx, rz) => [0, 0, zAt(yC) - K.spineBack.thoracic + rz]]);
  lvl.push(["axilla", yAx, scaled(chestSec, 0.97, 0.93), (rx, rz) => [0, 0, zAt(yAx) - K.spineBack.thoracic + rz]]);
  const shoulderSec = { rx: 0.88 * d.acromion_halfwidth, rz: 0.66 * chestSec.rz, n: 2.4, status: chestSec.status === "estimated" ? "estimated" : "derived", via: chestSec.via };
  shoulderSec.girth = ringPerimeter(shoulderSec.rx, shoulderSec.rz, shoulderSec.n);
  lvl.push(["shoulder", yAc, shoulderSec, (rx, rz) => [0, 0, zAt(yAc) - 0.85 * K.spineBack.thoracic + rz]]);
  const trapSec = { rx: 0.5 * (shoulderSec.rx * 0.8 + nbSec.rx), rz: 0.5 * (shoulderSec.rz + nbSec.rz), n: 2.2, status: "derived", via: [] };
  trapSec.girth = ringPerimeter(trapSec.rx, trapSec.rz, trapSec.n);
  const yTr = 0.5 * (yAc + yCv) + 0.01;
  lvl.push(["trapezius", yTr, trapSec, (rx, rz) => [0, 0, zAt(yTr) - K.spineBack.cervical + rz]]);
  lvl.push(["neck_base", yCv, nbSec, (rx, rz) => [0, 0, zAt(yCv) - K.spineBack.cervical + rz]]);
  // strictly ascending: a measured landmark height can reorder two close rings; push the upper one up
  for (let i = 1; i < lvl.length; i++) if (lvl[i][1] < lvl[i - 1][1] + 0.012) lvl[i][1] = lvl[i - 1][1] + 0.012;
  const main = lvl.map(([id, y, sec, cf]) => t(id, y, sec, (rx, rz) => cf(rx, rz)));
  main.forEach((r) => { r.c[1] = r6(r.c[1]); });
  // two intermediate rings (lower abdomen between the buttock and waist rings, upper abdomen between the waist and chest rings) so that a loft
  // through the rings has the right silhouette; they interpolate their neighbours and scale with them
  const between = (id, a, b, tt) => {
    const y = a.c[1] + (b.c[1] - a.c[1]) * tt, m = (k) => a[k] + (b[k] - a[k]) * tt;
    const r = { id, c: [0, r6(y), r6(a.c[2] + (b.c[2] - a.c[2]) * tt)], rx: r6(m("rx")), rz: r6(m("rz")), n: r6(m("n")), src: a.src === "estimated" && b.src === "estimated" ? "estimated" : "derived", bind: bindAlong(P, TORSO_CHAIN, y) };
    Object.defineProperty(r, "_scal", { value: a._scal || b._scal, enumerable: false });
    return r;
  };
  const byId = (id) => main.find((r) => r.id === id);
  const torso = [];
  for (const r of main) {
    torso.push(r);
    if (r.id === "buttock") torso.push(between("lower_abdomen", r, byId("waist"), 0.5));
    if (r.id === "waist") torso.push(between("upper_abdomen", r, byId("chest"), 0.5));
  }
  addVol(tubeVolume(torso));

  // ---------------------------------------------------------------- neck
  // neck_mid at half the neck, neck_top inside the head; both above the top torso ring, whose height is the measured cervicale height when the profile has one
  // (it can be higher than the model's own C7 when the survey's landmarks disagree with the other heights): the loft must not fold
  const yBase = torso[torso.length - 1].c[1], yN0 = Math.max(d.c7_height + 0.5 * d.neck_length, yBase + 0.012), yN1 = Math.max(P.head[1] + 0.012, yN0 + 0.012);
  const neck = [torso[torso.length - 1],
    ring("neck_mid", yN0, neckSec, (rx, rz) => [0, 0, zAt(yN0) - K.spineBack.cervical + rz], bindAlong(P, TORSO_CHAIN, yN0)),
    ring("neck_top", yN1, scaled(neckSec, 0.93, 0.93), (rx, rz) => [0, 0, zAt(yN1) - K.spineBack.cervical + rz], bindAlong(P, TORSO_CHAIN, yN1))];
  neck[1].c[1] = r6(yN0); neck[2].c[1] = r6(yN1);
  addVol(tubeVolume(neck.slice(1))); // the first ring belongs to the torso

  // ---------------------------------------------------------------- arms (left, built from the joints; right = mirror)
  const gh = P.shoulder_L, el = P.elbow_L, wr = P.wrist_L;
  const bideltoid = g("bideltoid_breadth");
  note("biceps", "Upper arm section (flexed biceps girth, used for the relaxed arm)", bicepsSec);
  note("forearm", "Forearm section (maximum forearm girth)", foreSec);
  note("wrist", "Wrist section", wristSec);
  sections.biceps = bicepsSec; sections.forearm = foreSec; sections.wrist = wristSec;
  const onAxis = (A, B, tt) => lerp3(A, B, tt);
  // The skin of the hanging arm must not sink into the trunk's skin (the glenohumeral centre is inside the chest's width, so the bone axis alone would put the biceps ring
  // 40 mm and more into the chest ring): each arm ring is moved outward, away from the bone axis, by what it takes to leave at most G.armClear of overlap with the trunk at
  // its height (rings of the torso from the buttock to the axilla, at the adiposity factor of this pass), up to G.armShiftMax. The bones are not moved.
  const side = torso.filter((r) => ["buttock", "lower_abdomen", "waist", "upper_abdomen", "chest", "axilla"].includes(r.id));
  const trunkHalf = (y) => {
    if (y <= side[0].c[1]) return side[0].rx;
    for (let i = 1; i < side.length; i++) if (y <= side[i].c[1]) return side[i - 1].rx + ((y - side[i - 1].c[1]) / (side[i].c[1] - side[i - 1].c[1])) * (side[i].rx - side[i - 1].rx);
    return side[side.length - 1].rx;
  };
  const clearOf = (p) => (rx) => clamp(trunkHalf(p[1]) + rx - G.armClear - p[0], 0, G.armShiftMax);
  const uaRing = (id, tt, sec, cx = 0, cz = 0) => {
    const p = onAxis(gh, el, tt);
    return ring(id, null, sec, (rx, rz) => [p[0] + cx(rx), p[1], p[2] + cz(rz)], bindLimb("clavicle_L", "shoulder_L", "elbow_L", tt));
  };
  // deltoid: the lateral surface of the deltoid is at half the bideltoid breadth
  const eBid = c.E("bideltoid_breadth");
  const xMax = (bideltoid ?? eBid) / 2, ttD = 0.17, axD = onAxis(gh, el, ttD)[0];
  const lat = Math.max(0.06, xMax - axD), rxD = Math.max(0.045, 0.72 * lat);
  const deltSec = { rx: rxD, rz: 0.95 * rxD, n: 2, status: bideltoid !== undefined ? "derived" : "estimated", via: bideltoid !== undefined ? ["bideltoid_breadth"] : [] };
  deltSec.girth = ringPerimeter(deltSec.rx, deltSec.rz);
  const upper = [
    uaRing("ua_top", 0, scaled(deltSec, 0.9, 0.9), (rx) => 0.2 * rx, () => 0),
    uaRing("ua_deltoid", ttD, deltSec, (rx) => lat - rx, () => 0), // the outer edge stays at half the bideltoid breadth
    uaRing("ua_biceps", 0.5, bicepsSec, clearOf(onAxis(gh, el, 0.5)), () => 0),
    uaRing("ua_distal", 0.88, scaled(foreSec, 0.98, 0.98, 2), clearOf(onAxis(gh, el, 0.88)), () => 0),
    uaRing("ua_elbow", 1, scaled(foreSec, 0.95, 0.95, 2), clearOf(el), () => 0),
  ];
  const faRing = (id, tt, sec, cx = () => 0, cz = () => 0) => {
    const p = onAxis(el, wr, tt);
    return ring(id, null, sec, (rx, rz) => [p[0] + cx(rx), p[1], p[2] + cz(rz)], bindLimb("elbow_L", "forearm_L", "wrist_L", tt));
  };
  const wG = wristSec.girth, fG = foreSec.girth;
  const midSec = { ...sectionFrom({ G: wG + 0.45 * (fG - wG), ratio: 1.25 }), status: foreSec.status === "estimated" && wristSec.status === "estimated" ? "estimated" : "derived", via: [] };
  const fore = [
    faRing("fa_elbow", 0, scaled(foreSec, 0.95, 0.95, 2), clearOf(el)), // the same ring as ua_elbow
    faRing("fa_max", 0.18, foreSec, clearOf(onAxis(el, wr, 0.18))),
    faRing("fa_mid", 0.55, midSec, clearOf(onAxis(el, wr, 0.55))),
    faRing("fa_wrist", 1, wristSec),
  ];
  addVol(tubeVolume(upper)); addVol(tubeVolume(fore)); addVol(tubeVolume(upper)); addVol(tubeVolume(fore)); // both sides

  // ---------------------------------------------------------------- legs
  const hp = P.hip_L, kn = P.knee_L, an = P.ankle_L, hx = hp[0];
  const dSeat = d.hip_to_seat, aK = d.knee_top_front, bK = d.popliteal_below_knee;
  // The standing section is built from the girth alone with a typical depth / breadth (THIGH_RATIO). The thigh clearance (seated, compressed against the seat by the
  // body weight) is NOT its depth: it is 10 to 20 % thinner than the standing section, and using it made the thigh 213 mm wide for a 346 mm hip ring. The seated
  // thigh clearance is carried by the landmark thigh_top, not by the ring.
  const thighSec = girthRing(c, { G: ov("thigh") ?? g("thigh_circumference"), eG: c.E("thigh_circumference"), ratio: THIGH_RATIO, keys: [null, null, "thigh_circumference"], need: [2] });
  note("thigh", "Thigh section at the gluteal furrow (thigh girth, typical depth / breadth)", thighSec);
  const lowG = c.E("lower_thigh_circumference") / c.E("thigh_circumference") * thighSec.girth; // distal thigh girth in proportion to the proximal one
  const kneeD = aK + bK;
  const lowSec = { ...sectionFrom({ D: kneeD, G: lowG }), status: thighSec.status === "estimated" ? "estimated" : "derived", via: thighSec.via };
  const kneeG = ov("knee") ?? g("other:knee_circumference");
  const kneeSec = { ...sectionFrom({ D: kneeD * 1.0, G: kneeG ?? c.E("other:knee_circumference") }), status: kneeG !== undefined ? "derived" : thighSec.status === "estimated" ? "estimated" : "derived", via: kneeG !== undefined ? ["other:knee_circumference"] : [] };
  kneeSec.girth = ringPerimeter(kneeSec.rx, kneeSec.rz, 2);
  lowSec.girth = ringPerimeter(lowSec.rx, lowSec.rz, 2);
  const Lf = d.femur_length, tG = clamp((hp[1] - (hs.gluteal)) / Lf, 0.18, 0.5);
  const thRing = (id, tt, sec, cfn) => {
    const p = onAxis(hp, kn, tt);
    return ring(id, null, sec, (rx, rz) => { const cc = cfn(rx, rz); return [p[0] + cc[0], p[1], p[2] + cc[1]]; }, bindLimb("pelvis", "hip_L", "knee_L", tt));
  };
  // the thigh must not stick out of the hips: its outer edge is at most 6 mm beyond the hip ring, so a wide thigh overlaps its twin at the midline instead; but never
  // by more than 30 mm (past that the thigh is moved outward again: it sticks out of the hip ring rather than through its twin)
  const hipHalf = hipSec.rx * (hipSec.status === "estimated" ? s : 1);
  const inner = (rx) => Math.max(Math.min(hipHalf + 0.006 - hx - rx, 0), rx - 0.03 - hx);
  const cantFront = (rz, back) => rz - Math.min(back, 1.6 * rz);
  const thigh = [
    thRing("th_top", 0, scaled(thighSec, 0.92, 0.95, 2), (rx, rz) => [inner(rx), cantFront(rz, dSeat)]),
    thRing("th_prox", tG, thighSec, (rx, rz) => [inner(rx), cantFront(rz, dSeat)]),
    thRing("th_mid", 0.6, scaled(thighSec, 0.86, 0.9, 2), (rx, rz) => [inner(rx), cantFront(rz, 0.85 * dSeat)]),
    thRing("th_low", 0.9, lowSec, (rx, rz) => [0, (aK - bK) / 2 * (lowSec.status === "estimated" ? s : 1)]),
    thRing("th_knee", 1, kneeSec, (rx, rz) => [0, (aK - bK) / 2 * (kneeSec.status === "estimated" ? s : 1)]),
  ];
  note("knee", "Knee section", kneeSec);
  const calfSec = girthRing(c, { G: ov("calf") ?? g("calf_circumference"), eG: c.E("calf_circumference"), ratio: 1.0, keys: [null, null, "calf_circumference"], need: [2] });
  const ankleSec = girthRing(c, { G: ov("ankle") ?? g("ankle_circumference"), eG: c.E("ankle_circumference"), ratio: 0.95, keys: [null, null, "ankle_circumference"], need: [2] });
  note("calf", "Calf section (maximum calf girth)", calfSec);
  note("ankle", "Ankle section (minimum ankle girth)", ankleSec);
  sections.thigh = thighSec; sections.knee = kneeSec; sections.calf = calfSec; sections.ankle = ankleSec;
  const shRing = (id, tt, sec, cfn = () => 0) => {
    const p = onAxis(kn, an, tt);
    return ring(id, null, sec, (rx, rz) => [p[0], p[1], p[2] + cfn(rz)], bindLimb("hip_L", "knee_L", "ankle_L", tt));
  };
  const gl = calfSec.girth - 0.7 * (calfSec.girth - ankleSec.girth); // 70 % of the way from the calf girth to the ankle girth
  const lowCalf = { ...sectionFrom({ G: gl, ratio: 0.975 }), status: calfSec.status === "estimated" && ankleSec.status === "estimated" ? "estimated" : "derived", via: [] };
  const bimal = g("other:bimalleolar_breadth") ?? c.E("other:bimalleolar_breadth");
  const malSec = { ...sectionFrom({ B: bimal, G: ankleSec.girth * 1.08 }), status: ankleSec.status === "estimated" ? "estimated" : "derived", via: ankleSec.via };
  malSec.girth = ringPerimeter(malSec.rx, malSec.rz, 2);
  const shank = [
    shRing("sh_knee", 0, scaled(kneeSec, 0.97, 0.97, 2), () => (aK - bK) / 2 * 0.5),
    shRing("sh_calf", 0.3, calfSec, (rz) => -0.15 * rz),
    shRing("sh_low", 0.72, lowCalf, (rz) => -0.1 * rz),
    shRing("sh_ankle", 0.9, ankleSec),
    shRing("sh_malleolus", 1, malSec),
  ];
  addVol(tubeVolume(thigh)); addVol(tubeVolume(shank)); addVol(tubeVolume(thigh)); addVol(tubeVolume(shank));
  return { torso, neck, upper, fore, thigh, shank, vol, sections };
}

// =====================================================================================================================
// Landmarks. Each is attached to the joint that moves it and stored as an offset from that joint's centre in the neutral frame.
// They are placed so that the standard measure definitions (ISO 7250-1, Gordon et al. 1989) evaluate to the profile by construction: the
// ones that carry a survey height are put at that height (when it is plausible), the seated ones are set by the offsets of the
// dimension table (hip_to_seat, knee_top_front, popliteal_below_knee, thigh_thickness, buttock_back, popliteal_setback).

function landmarks(c, geo, shp) {
  const P = geo.P, d = c.d, hs = geo.hs, zAt = geo.zAt, S = c.S;
  const L = {}, W = {};
  const sz = S / 1.76;
  const spineJoint = (y) => { let best = "pelvis"; for (const id of SPINE_IDS.slice(0, 17)) if (P[id][1] <= y) best = id; return best; };
  const put = (id, joint, pos, label, group, kind = "bony") => {
    if (!finite3(pos)) throw new Error(`landmark ${id} is not finite`);
    W[id] = pos;
    L[id] = { joint, offset: sub3(pos, P[joint]).map(r6), label, group, kind };
  };
  const putLR = (base, joint, pos, label, group, kind) => {
    put(`${base}_L`, joint, pos, `Left ${label}`, group, kind);
    // the right twin is the exact mirror image of the rounded left offset (not an independent rounding of the mirrored position)
    const l = L[`${base}_L`];
    W[`${base}_R`] = mirror3(pos);
    L[`${base}_R`] = { joint: mirrorId(joint), offset: [-l.offset[0] + 0, l.offset[1], l.offset[2]], label: `Right ${label}`, group, kind: l.kind };
  };
  const ring = (arr, id) => arr.find((r) => r.id === id);
  const { torso, upper } = shp;

  // ---------------------------------------------------------------- head (Frankfurt plane level)
  const { zTr, yTr, yEcto, zGl, yPupil, zPupil } = geo;
  const hl = d.head_length, hb = d.head_breadth, bz = d.bizygomatic_breadth, ipd = d.interpupillary_breadth;
  const ySell = yEcto + 0.004, zSell = zGl - 0.006, yGl = ySell + 0.012;
  put("vertex", "head", [0, S, zTr - 0.005], "Vertex (top of the head)", "head");
  put("glabella", "head", [0, yGl, zGl], "Glabella", "head");
  put("opisthocranion", "head", [0, yGl, zGl - hl], "Opisthocranion (back of the head)", "head");
  put("sellion", "head", [0, ySell, zSell], "Sellion", "head");
  put("nasion", "head", [0, ySell + 0.004, zSell + 0.002], "Nasion", "head");
  put("pronasale", "head", [0, ySell - 0.026, zGl + 0.022], "Pronasale (tip of the nose)", "head", "surface");
  put("subnasale", "head", [0, ySell - 0.052, zGl + 0.004], "Subnasale", "head", "surface");
  put("stomion", "head", [0, ySell - 0.07, zGl], "Stomion (mouth centre)", "head", "surface");
  const msl = d.menton_sellion_length, dzM = 0.01, dyM = Math.sqrt(Math.max(msl * msl - dzM * dzM, 1e-4));
  put("menton", "jaw", [0, ySell - dyM, zSell - dzM], "Menton (bottom of the chin)", "head");
  put("gnathion", "jaw", [0, ySell - dyM + 0.002, zSell - dzM - 0.003], "Gnathion", "head");
  putLR("ectocanthus", "head", [ipd / 2 + 0.0135, yEcto, zGl - 0.02], "ectocanthus (outer eye corner)", "head");
  putLR("pupil", "eye_L", [ipd / 2, yPupil, zPupil], "pupil (eye point)", "head");
  putLR("eye", "eye_L", [ipd / 2, yPupil, zPupil], "eye point (same as the pupil)", "head");
  put("eye_mid", "head", [0, yPupil, zPupil], "Cyclopean eye point", "head", "surface");
  putLR("tragion", "head", [hb / 2 - 0.006, yTr, zTr], "tragion", "head");
  putLR("euryon", "head", [hb / 2, yTr + 0.035, zTr - 0.01], "euryon", "head");
  putLR("zygion", "head", [bz / 2, yEcto - 0.012, zTr + 0.045], "zygion", "head");
  putLR("gonion", "jaw", [0.0525 * (hb / 0.152), yTr - 0.055, zTr - 0.005], "gonion (angle of the jaw)", "head");

  // ---------------------------------------------------------------- trunk
  put("cervicale", "C7", [0, hs.cervicale, P.C7[2] - K.spineBack.cervical], "Cervicale (C7 spinous process)", "trunk");
  const ssY = hs.suprasternale;
  put("suprasternale", "T4", [0, ssY, zAt(ssY) + G.ssAhead], "Suprasternale (top of the breast bone)", "trunk");
  const chestR = ring(torso, "chest"), waistR = ring(torso, "waist"), hipR = ring(torso, "buttock");
  const chestFront = chestR.c[2] + chestR.rz, chestBack = chestR.c[2] - chestR.rz;
  const yX = ssY - 0.2 * sz;
  put("xiphoid", spineJoint(yX), [0, yX, chestFront - 0.015], "Xiphoid process (substernale)", "trunk");
  put("substernale", spineJoint(yX), [0, yX, chestFront - 0.015], "Substernale (bottom of the breast bone)", "trunk");
  put("chest_front", spineJoint(chestR.c[1]), [0, chestR.c[1], chestFront], "Chest front (deepest point at the nipple level)", "trunk", "surface");
  put("chest_back", spineJoint(chestR.c[1]), [0, chestR.c[1], chestBack], "Chest back at the nipple level", "trunk", "surface");
  putLR("thelion", spineJoint(chestR.c[1]), [0.62 * chestR.rx, chestR.c[1], chestFront - 0.005], "thelion (nipple)", "trunk", "surface");
  put("omphalion", spineJoint(waistR.c[1]), [0, waistR.c[1], waistR.c[2] + waistR.rz], "Omphalion (navel)", "trunk", "surface");
  put("abdomen_front", spineJoint(waistR.c[1]), [0, waistR.c[1], waistR.c[2] + waistR.rz], "Abdomen front (most protruding point)", "trunk", "surface");
  put("waist_back", spineJoint(waistR.c[1]), [0, waistR.c[1], waistR.c[2] - waistR.rz], "Waist back", "trunk", "surface");
  const scY = P.shoulder_L[1] - 0.19 * sz;
  putLR("scapula_inferior", "clavicle_L", [P.shoulder_L[0] - 0.045, scY, zAt(scY) - K.spineBack.thoracic + 0.012], "inferior angle of the scapula", "trunk");
  const sbY = P.shoulder_L[1] - 0.1 * sz;
  putLR("scapula_back", spineJoint(sbY), [0.075, sbY, zAt(sbY) - K.spineBack.thoracic], "back at the scapula (wall contact)", "trunk", "contact");

  // ---------------------------------------------------------------- pelvis
  // Without a bicristal breadth the pelvis width follows the hip joint centres (which were derived from the hip breadth sitting or standing when the profile has
  // one: Harrington's equation inverted) instead of a regression of the bicristal breadth: ANSUR 1988 has no bicristal breadth, and its measured hip breadth sitting
  // brings the model inter-ASIS distance to within 3 mm of the surveyed bispinous breadth (MODEL.md section 11)
  const bic = c.g("bicristal_breadth") ?? c.E("bicristal_breadth"), hip = d.hip_height;
  const pw = c.g("bicristal_breadth") !== undefined || !(c.has("hip_breadth_sitting") || c.has("other:hip_breadth")) ? K.asis * bic : (d.hip_halfwidth - 0.0073) / 0.33;
  putLR("ASIS", "pelvis", [pw / 2, hip + 0.3 * pw + 0.0109, 0.24 * 0.4 * pw + 0.0099], "anterior superior iliac spine", "pelvis");
  putLR("PSIS", "pelvis", [0.17 * pw, hip + 0.3 * pw + 0.0109 + 0.03, 0.24 * 0.4 * pw + 0.0099 - 0.4 * pw], "posterior superior iliac spine", "pelvis");
  putLR("iliocristale", "pelvis", [bic / 2, hs.iliocristale, zAt(hs.iliocristale) - 0.01], "iliocristale (top of the iliac crest)", "pelvis");
  put("crotch", "pelvis", [0, hs.crotch, 0.01], "Crotch", "pelvis", "surface");
  put("buttock_extremity", "pelvis", [0, hs.buttock, -d.buttock_back], "Buttock extremity (most posterior point)", "pelvis", "surface");
  putLR("ischial", "pelvis", [OFF.ischialX, hip - d.hip_to_seat, -OFF.ischialBack], "ischial tuberosity (seat contact)", "pelvis", "contact");
  const hbs = c.g("hip_breadth_sitting") ?? (2 * hipR.rx) / c.R("hip_over_hipbr_ratio");
  putLR("hip_sitting", "pelvis", [hbs / 2, hs.buttock, hipR.c[2]], "widest point of the hips (sitting)", "pelvis", "surface");

  // ---------------------------------------------------------------- legs and feet
  const hx = P.hip_L[0], ky = d.knee_height, ay = d.ankle_height, Lf = d.femur_length;
  putLR("trochanterion", "hip_L", [hx + OFF.trochanterOut, hs.trochanterion, -0.02], "trochanterion (top of the greater trochanter)", "leg");
  putLR("thigh_top", "hip_L", [hx, hip - 0.12, Math.max(d.thigh_thickness - d.hip_to_seat, 0.02)], "top of the thigh (thigh clearance)", "leg", "surface");
  putLR("thigh_under", "hip_L", [hx, hip - 0.12, -d.hip_to_seat], "underside of the thigh (seat contact)", "leg", "contact");
  putLR("knee_top", "hip_L", [hx, hip - (Lf - 0.03), d.knee_top_front], "top of the knee (knee height sitting)", "leg", "surface");
  putLR("knee_front", "hip_L", [hx, ky - K.patellaAhead, 0.045], "front of the knee (buttock-knee length)", "leg", "contact");
  putLR("popliteal", "hip_L", [hx, hip - (Lf - d.popliteal_setback), -d.popliteal_below_knee], "popliteal point (back of the knee)", "leg", "surface");
  const kneeR = ring(shp.thigh, "th_knee");
  putLR("epicondyle_lateral", "hip_L", [hx + Math.max(kneeR.rx - 0.006, 0.04), ky, 0], "lateral femoral epicondyle", "leg");
  putLR("patella", "knee_L", [hx, c.g("other:knee_height_midpatella") ?? ky + c.R("midpatella_over_knee"), 0.052], "patella (mid-patella)", "leg", "surface");
  putLR("shin", "knee_L", [hx, ky - 0.16 * (d.shank_length / 0.42), 0.045], "shin (kneeling contact)", "leg", "contact");
  const bm = c.g("other:bimalleolar_breadth") ?? c.E("other:bimalleolar_breadth");
  putLR("lateral_malleolus", "ankle_L", [hx + bm / 2, ay, 0], "lateral malleolus", "foot");
  putLR("medial_malleolus", "ankle_L", [hx - bm / 2, ay + 0.012, 0], "medial malleolus", "foot");
  const fs = geo.fs, heelZ = geo.heelZ, FL = d.foot_length, FB = d.foot_breadth, ballZ = heelZ + d.ball_length;
  putLR("heel", "ankle_L", [hx, G.heelPoint * fs, heelZ], "pternion (back of the heel)", "foot");
  putLR("heel_sole", "ankle_L", [hx, 0, heelZ + 0.03 * fs], "centre of the heel (sole)", "foot", "contact");
  putLR("metatarsale_tibiale", "ankle_L", [hx - FB / 2, 0.03 * fs, ballZ], "medial ball of the foot (first metatarsal head)", "foot");
  putLR("metatarsale_fibulare", "ankle_L", [hx + FB / 2, 0.028 * fs, ballZ - G.mt5Behind * fs], "lateral ball of the foot (fifth metatarsal head)", "foot");
  putLR("ball_sole_medial", "ankle_L", [hx - FB / 2 + 0.014, 0, ballZ], "medial ball of the foot (sole)", "foot", "contact");
  putLR("ball_sole_lateral", "ankle_L", [hx + FB / 2 - 0.014, 0, ballZ - G.mt5Behind * fs], "lateral ball of the foot (sole)", "foot", "contact");
  putLR("toe_tip", "mtp_L", [hx - 0.2 * FB, 0.018 * fs, heelZ + FL], "akropodion (tip of the longest toe)", "foot");
  putLR("toe_sole", "mtp_L", [hx - 0.2 * FB, 0, heelZ + FL - 0.025 * fs], "toes (sole)", "foot", "contact");

  // ---------------------------------------------------------------- arms and hands
  const gh = P.shoulder_L, el = P.elbow_L, wr = P.wrist_L, HL = d.hand_length, HB = d.hand_breadth, u = geo.u;
  putLR("acromion", "clavicle_L", [gh[0] + d.acromion_to_gh, hs.acromion, gh[2] + OFF.acromionZ], "acromion", "arm");
  const delt = ring(upper, "ua_deltoid");
  putLR("deltoid", "shoulder_L", [delt.c[0] + delt.rx, gh[1] - 0.05, gh[2]], "deltoid (lateral surface)", "arm", "surface");
  putLR("olecranon", "elbow_L", [el[0], el[1] + OFF.olecranonUp, el[2] - d.olecranon_drop], "olecranon (point of the elbow)", "arm");
  putLR("radiale", "elbow_L", add3(el, OFF.radiale), "radiale (top of the radius)", "arm");
  putLR("stylion", "forearm_L", add3(wr, OFF.stylion), "stylion (radial styloid)", "arm");
  const tip = geo.hand.tipOf;
  putLR("dactylion", "middle_dip_L", tip.middle, "dactylion (tip of the middle finger)", "hand");
  putLR("middle_tip", "middle_dip_L", tip.middle, "middle fingertip", "hand");
  putLR("index_tip", "index_dip_L", tip.index, "index fingertip", "hand");
  putLR("ring_tip", "ring_dip_L", tip.ring, "ring fingertip", "hand");
  putLR("little_tip", "little_dip_L", tip.little, "little fingertip", "hand");
  putLR("thumb_tip", "thumb_ip_L", tip.thumb, "thumb tip", "hand");
  const alongW = (s, z = 0, x = 0) => [wr[0] + u[0] * s + x, wr[1] + u[1] * s, wr[2] + z];
  putLR("metacarpale_radiale", "wrist_L", alongW(0.42 * HL, HB / 2), "metacarpale radiale (index knuckle)", "hand");
  putLR("metacarpale_ulnare", "wrist_L", alongW(0.42 * HL, -HB / 2), "metacarpale ulnare (little finger knuckle)", "hand");
  putLR("palm_centre", "wrist_L", alongW(0.3 * HL, 0, -0.016), "centre of the palm (surface)", "hand", "contact");
  const wg = c.E("wrist_to_grip");
  putLR("grip_centre", "wrist_L", alongW(wg, 0, OFF.grip[0]), "grip centre (axis of a handle held in the fist)", "hand", "surface");
  return { L, W };
}

/** Named sets of landmark ids used for grounding and support (placement computes the root from these). */
function contactSets(L) {
  const lr = (...b) => b.flatMap((x) => [`${x}_L`, `${x}_R`]);
  const sets = {
    feet: lr("heel_sole", "ball_sole_medial", "ball_sole_lateral", "toe_sole"),
    seat: lr("ischial", "thigh_under"), // coplanar in the seated posture; the buttock extremity is a back contact (set `back`)
    knees: lr("knee_front", "shin"),
    hands: lr("palm_centre", "grip_centre"),
    elbows: lr("olecranon"),
    back: [...lr("scapula_back"), "buttock_extremity", "opisthocranion"],
    front: ["chest_front", "abdomen_front", ...lr("knee_front", "thelion")],
    side_L: ["deltoid_L", "trochanterion_L", "lateral_malleolus_L", "epicondyle_lateral_L", "tragion_L", "euryon_L"],
    side_R: ["deltoid_R", "trochanterion_R", "lateral_malleolus_R", "epicondyle_lateral_R", "tragion_R", "euryon_R"],
    head: ["vertex", "opisthocranion", "glabella", ...lr("euryon")],
  };
  for (const [k, v] of Object.entries(sets)) for (const id of v) if (!L[id]) throw new Error(`contact set ${k}: unknown landmark ${id}`);
  return sets;
}

// ---------------------------------------------------------------------------------------------------------------------
// Head, hand and foot descriptions (left side for the paired ones; the right side is the mirror image) and the shape assembly.
const VOL_CAL = 0.917; // volume of the union of the tubes relative to the sum of their volumes (overlaps at shoulders and hips, simplified sections): fitted on the database (MODEL.md section 6)

function headShape(c, geo, W) {
  const d = c.d, S = c.S, hl = d.head_length, hb = d.head_breadth, bz = d.bizygomatic_breadth;
  const { zTr, yTr, yEcto, zGl } = geo;
  const yGl = W.glabella[1], yMen = W.menton[1], ySub = W.subnasale[1], yMouth = W.stomion[1];
  // stomion is a fixed 70 mm below the sellion, menton is menton-sellion length (80 to 160 mm) below it: for a short face the two are only 10 mm apart and
  // the chin rings (30 and 4 mm above the menton) would cross the mouth ring and fold the loft. They are squeezed into the gap, unchanged when it is 60 mm or more.
  const gap = Math.max(yMouth - yMen, 0.004);
  const yc = yTr, ry = S - yc; // the cranium ellipsoid is centred at the tragion level and reaches the vertex
  // the head dimensions in `d` are already measured or estimated; only the girth (hat size) is added here
  const sec = sectionFrom({ B: hb, D: hl, G: c.g("head_circumference") ?? undefined, n0: typicalN("head", c.f) });
  const cranium = (y) => { const u = (y - yc) / ry; return Math.sqrt(Math.max(1 - u * u, 0)); };
  const ring = (id, y, rx, zf, zb, n = 2.1) => ({ id, c: [0, r6(y), r6((zf + zb) / 2)], rx: r6(rx), rz: r6((zf - zb) / 2), n: r6(n), bind: [["head", 1]], src: "derived" });
  const rings = [
    ring("crown", S - 0.012, hb / 2 * cranium(S - 0.012), zTr + 0.5 * hl * cranium(S - 0.012), zTr - 0.5 * hl * cranium(S - 0.012)),
    ring("upper_skull", S - 0.04, hb / 2 * cranium(S - 0.04), zTr + 0.5 * hl * cranium(S - 0.04), zTr - 0.5 * hl * cranium(S - 0.04)),
    { ...ring("brow", yGl, sec.rx, zGl - hl / 2 + sec.rz, zGl - hl / 2 - sec.rz, sec.n), src: c.g("head_circumference") !== undefined ? "derived" : "estimated" }, // girth = head circumference
    ring("eye", yEcto, 0.5 * (hb / 2 + bz / 2), zGl - 0.004, zGl - hl + 0.012),
    ring("ear", yTr, hb / 2 - 0.002, zGl - 0.012, zTr - 0.5 * hl + 0.012),
    ring("cheek", yEcto - 0.022, bz / 2, zGl - 0.014, zTr - 0.074),
    ring("mouth", yMouth, 0.42 * bz, zGl - 0.012, zTr - 0.07),
    ring("chin_top", yMen + Math.min(0.03, 0.5 * gap), 0.3 * bz, zGl - 0.022, zTr - 0.06),
    ring("chin", yMen + Math.min(0.004, 0.2 * gap), 0.14 * bz, zGl - 0.034, zTr - 0.05),
  ];
  rings.forEach((r) => { Object.defineProperty(r, "_scal", { value: false, enumerable: false }); });
  const earL = c.g("ear_length") ?? c.E("ear_length");
  return {
    joint: "head", label: "Head", rings,
    cranium: { c: [0, r6(yc), r6(zTr)], r: [r6(hb / 2), r6(ry), r6(hl / 2)], note: "ellipsoid from the vertex down to twice the tragion-to-vertex height; the rings below give the face" },
    features: {
      nose: { tip: W.pronasale.map(r6), bridge: W.nasion.map(r6), subnasale: W.subnasale.map(r6), width: r6(0.31 * bz) },
      brow: { glabella: W.glabella.map(r6), halfWidth: r6(0.38 * bz), height: 0.012 },
      ears: { tragion: W.tragion_L.map(r6), length: r6(earL), breadth: r6(0.58 * earL), protrusion: 0.02 },
      chin: { menton: W.menton.map(r6), width: r6(0.28 * bz) },
      eyes: { pupilL: W.pupil_L.map(r6), pupilR: W.pupil_R.map(r6), radius: 0.012, socketRadius: 0.019 },
      mouth: { stomion: W.stomion.map(r6), width: r6(0.36 * bz) },
    },
    eyeSocketHint: "eyeballs are skinned to eye_L / eye_R (radius 12 mm, centre 12 mm behind the pupil)",
  };
}

function handShape(c, geo) {
  const d = c.d, HL = d.hand_length, HB = d.hand_breadth, P = geo.P, wr = P.wrist_L, u = geo.u;
  const at = (s, z = 0, x = 0) => [r6(wr[0] + u[0] * s + x), r6(wr[1] + u[1] * s), r6(wr[2] + z)];
  const palmRing = (id, s, rzF, rxF) => ({ id, c: at(s), rx: r6(rxF * HB), rz: r6(rzF * HB), n: 2.3, bind: [["wrist_L", 1]], src: "derived" });
  const fingers = {};
  for (const [name, fg] of Object.entries(G.fingers)) {
    const j = [`${name}_mcp_L`, `${name}_pip_L`, `${name}_dip_L`];
    const r = fg.halfW * HB;
    fingers[name] = { joints: j, tip: geo.hand.tipOf[name].map(r6), points: j.map((x) => P[x].map(r6)), radiusZ: [r6(r), r6(0.93 * r), r6(0.85 * r), r6(0.7 * r)], thicknessRatio: 0.92 };
  }
  const t = G.thumb, tj = ["thumb_cmc_L", "thumb_mcp_L", "thumb_ip_L"];
  fingers.thumb = { joints: tj, tip: geo.hand.tipOf.thumb.map(r6), points: tj.map((x) => P[x].map(r6)), radiusZ: [r6(0.12 * HB), r6(0.115 * HB), r6(0.1 * HB), r6(0.085 * HB)], thicknessRatio: 0.95 };
  return {
    joint: "wrist_L", label: "Left hand", width: r6(HB), length: r6(HL),
    palm: [palmRing("wrist", 0, 0.36, 0.21), palmRing("mid", 0.22 * HL, 0.46, 0.19), palmRing("knuckles", 0.456 * HL, 0.5, 0.155)],
    fingers, thumbSplayDeg: r6(t.splay / D2R),
    note: "palm rings are perpendicular to the hand axis (the hanging arm direction); rz across the hand (thumb side +z), rx the half thickness (palm faces -x)",
  };
}

function footShape(c, geo) {
  const d = c.d, P = geo.P, hx = P.ankle_L[0], FL = d.foot_length, FB = d.foot_breadth, fs = geo.fs, heelZ = geo.heelZ;
  const hb = c.g("other:heel_breadth") ?? c.E("other:heel_breadth"), bm = c.g("other:bimalleolar_breadth") ?? c.E("other:bimalleolar_breadth");
  const ay = d.ankle_height;
  // stations from the heel to the toes: [fraction of foot length, half width, top height above the sole, sole lift (arch)]
  const tab = [[0, 0.5 * hb * 0.55, 0.04 * fs, 0], [0.07, 0.5 * hb, 0.075 * fs, 0], [0.2, 0.5 * bm, ay + 0.035, 0.004], [0.36, 0.43 * FB, 0.07 * fs, 0.016 * fs],
    [0.55, 0.46 * FB, 0.056 * fs, 0.008 * fs], [d.ball_length / FL, 0.5 * FB, 0.034 * fs, 0], [0.88, 0.4 * FB, 0.027 * fs, 0], [1, 0.14 * FB, 0.018 * fs, 0]];
  return {
    joint: "ankle_L", label: "Left foot", length: r6(FL), breadth: r6(FB), heelBreadth: r6(hb),
    stations: tab.map(([fr, hw, top, lift]) => ({ z: r6(heelZ + fr * FL), cx: r6(hx), rx: r6(hw), top: r6(top), lift: r6(lift) })),
    toesJoint: "mtp_L", toesFrom: r6(heelZ + d.ball_length),
    note: "z in world coordinates (the ankle centre is at z = 0); each station is a cross-section with half width rx about x = cx, flat sole at y = lift, top at y = top; toes (z beyond toesFrom) are skinned to mtp_L",
  };
}

const mirrorRing = (r) => ({ ...r, id: r.id, c: mirror3(r.c), bind: r.bind.map(([j, w]) => [mirrorId(j), w]) });
const mirrorTube = (rings) => rings.map((r) => { const m = mirrorRing(r); Object.defineProperty(m, "_scal", { value: r._scal, enumerable: false }); return m; });

/** Volume of the head, hands and feet (m3): not scaled by the adiposity factor. */
function fixedVolume(c) {
  const d = c.d, HL = d.hand_length, HB = d.hand_breadth, FL = d.foot_length, FB = d.foot_breadth;
  const head = (4 / 3) * Math.PI * (d.head_breadth / 2) * (0.5 * (d.vertex_to_eye + 0.1)) * (d.head_length / 2) * 1.1;
  const hand = 0.9 * HL * HB * 0.31 * HB, foot = 0.7 * FL * FB * 0.052 * (FL / 0.27);
  return head + 2 * hand + 2 * foot;
}

// =====================================================================================================================
// Segment masses and centres of mass: de Leva (1996), "Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters", J Biomech 29:1223.
// [mass / body mass, centre of mass as a fraction of the segment length from its proximal end], [men, women]. Values from the adjusted
// tables as transcribed by the Visual3D documentation (wiki.has-motion.com) and a second transcription found by search; the paper itself could
// not be opened, so the segment END POINTS below are as remembered from it (head: vertex to C7/T1, trunk: C7/T1 to the hip centres,
// limbs: joint centre to joint centre, hand: wrist centre to the middle knuckle, foot: heel to toe tip) and are marked approx. The men's
// 14 masses add up to 1.0000, the women's to 0.9999 (0.0668 + 0.4257 + 2 x 0.2537, as published: rounding in the paper). The fractions are NOT
// renormalised: the segments of a woman weigh 0.01 kg less than her body mass per 100 kg (massInfo.fractionSum says so), and the published
// fractions stay reproducible to the last digit.
const DE_LEVA = {
  head: [[0.0694, 0.5002], [0.0668, 0.4841]],
  trunk: [[0.4346, 0.5138], [0.4257, 0.4964]],
  upper_arm: [[0.0271, 0.5772], [0.0255, 0.5754]],
  forearm: [[0.0162, 0.4574], [0.0138, 0.4559]],
  hand: [[0.0061, 0.79], [0.0056, 0.7474]],
  thigh: [[0.1416, 0.4095], [0.1478, 0.3612]],
  shank: [[0.0433, 0.4395], [0.0481, 0.4352]],
  foot: [[0.0137, 0.4415], [0.0129, 0.4014]],
};
// The trunk is split into three rigid parts so that bending the spine moves the mass: shares of the trunk mass and boundaries along the
// C7 -> pelvis line (upper / middle / lower trunk of de Leva's 15-segment model, 15.96 / 16.33 / 11.17 % of body mass for men and
// 15.45 / 14.65 / 12.47 % for women, lengths 170.7 / 215.5 / 145.7 mm; remembered, approx.). The part centres are shifted together along the line so
// that the combined centre of mass is exactly the (verified) whole-trunk value.
const TRUNK_PARTS = {
  shares: [[15.96 / 43.46, 16.33 / 43.46, 11.17 / 43.46], [15.45 / 42.57, 14.65 / 42.57, 12.47 / 42.57]],
  bounds: [0, 170.7 / 531.9, 386.2 / 531.9, 1],
  com: [[0.5066, 0.4502, 0.6115], [0.505, 0.4512, 0.492]],
};

function massModel(c, geo) {
  const P = geo.P, mass = c.mass, f = c.f;
  const mix = (name) => { const [m, w] = DE_LEVA[name]; return [f * m[0] + (1 - f) * w[0], f * m[1] + (1 - f) * w[1]]; };
  const seg = {};
  const add = (id, label, key, joint, a, b, frac, extra = {}) => {
    const [mf] = mix(key), com = lerp3(a, b, frac);
    seg[id] = { label, mass: r6(mass * mf * (extra.share ?? 1)), fraction: r6(mf * (extra.share ?? 1)), com: { joint, offset: sub3(com, P[joint]).map(r6) }, comFraction: r6(frac), proximal: extra.proximal, distal: extra.distal };
  };
  const vertex = [0, c.S, geo.zTr - 0.005];
  add("head", "Head and neck", "head", "head", vertex, P.C7, mix("head")[1], { proximal: "vertex", distal: "C7" });
  // trunk, three parts along the C7 -> hip-centre-midpoint line
  const [, trunkCom] = mix("trunk"), top = P.C7, bot = P.pelvis;
  const shares = [0, 1, 2].map((i) => f * TRUNK_PARTS.shares[0][i] + (1 - f) * TRUNK_PARTS.shares[1][i]);
  const centres = [0, 1, 2].map((i) => TRUNK_PARTS.bounds[i] + (f * TRUNK_PARTS.com[0][i] + (1 - f) * TRUNK_PARTS.com[1][i]) * (TRUNK_PARTS.bounds[i + 1] - TRUNK_PARTS.bounds[i]));
  const shift = trunkCom - centres.reduce((a, x, i) => a + shares[i] * x, 0);
  const names = ["trunk_upper", "trunk_middle", "trunk_lower"], labels = ["Upper trunk (thorax)", "Middle trunk (abdomen)", "Lower trunk (pelvis)"];
  const nearest = (p) => { let best = "pelvis", bd = Infinity; for (const id of ["pelvis", ...SPINE_IDS.slice(0, 17)]) { const dd = Math.abs(P[id][1] - p[1]); if (dd < bd) { bd = dd; best = id; } } return best; };
  names.forEach((nm, i) => {
    const p = lerp3(top, bot, clamp(centres[i] + shift, 0, 1)), j = nearest(p);
    seg[nm] = { label: labels[i], mass: r6(mass * mix("trunk")[0] * shares[i]), fraction: r6(mix("trunk")[0] * shares[i]), com: { joint: j, offset: sub3(p, P[j]).map(r6) }, comFraction: r6(clamp(centres[i] + shift, 0, 1)), proximal: "C7", distal: "pelvis" };
  });
  for (const s of ["L", "R"]) {
    const m = (id) => P[id];
    add(`upper_arm_${s}`, `${s === "L" ? "Left" : "Right"} upper arm`, "upper_arm", `shoulder_${s}`, m(`shoulder_${s}`), m(`elbow_${s}`), mix("upper_arm")[1], { proximal: `shoulder_${s}`, distal: `elbow_${s}` });
    add(`forearm_${s}`, `${s === "L" ? "Left" : "Right"} forearm`, "forearm", `elbow_${s}`, m(`elbow_${s}`), m(`wrist_${s}`), mix("forearm")[1], { proximal: `elbow_${s}`, distal: `wrist_${s}` });
    add(`hand_${s}`, `${s === "L" ? "Left" : "Right"} hand`, "hand", `wrist_${s}`, m(`wrist_${s}`), m(`middle_mcp_${s}`), mix("hand")[1], { proximal: `wrist_${s}`, distal: `middle_mcp_${s}` });
    add(`thigh_${s}`, `${s === "L" ? "Left" : "Right"} thigh`, "thigh", `hip_${s}`, m(`hip_${s}`), m(`knee_${s}`), mix("thigh")[1], { proximal: `hip_${s}`, distal: `knee_${s}` });
    add(`shank_${s}`, `${s === "L" ? "Left" : "Right"} shank`, "shank", `knee_${s}`, m(`knee_${s}`), m(`ankle_${s}`), mix("shank")[1], { proximal: `knee_${s}`, distal: `ankle_${s}` });
    const sgn = s === "L" ? 1 : -1;
    const heel = [sgn * P.ankle_L[0], 0.045 * geo.fs, geo.heelZ], toe = [sgn * (P.ankle_L[0] - 0.2 * c.d.foot_breadth), 0.018 * geo.fs, geo.heelZ + c.d.foot_length];
    add(`foot_${s}`, `${s === "L" ? "Left" : "Right"} foot`, "foot", `ankle_${s}`, heel, toe, mix("foot")[1], { proximal: "heel", distal: "toe tip" });
  }
  let total = 0, com = [0, 0, 0];
  for (const sg of Object.values(seg)) { total += sg.mass; com = add3(com, mul3(add3(P[sg.com.joint], sg.com.offset), sg.mass)); }
  // `segments` is body.masses (id -> { mass, com: { joint, offset } }, the shape rig.js and synthetic.js use); the rest is body.massInfo
  return { segments: seg, info: { total: r6(total), fractionSum: r6(Object.values(seg).reduce((a, x) => a + x.fraction, 0)), com: mul3(com, 1 / total).map(r6), source: "de Leva 1996 (Zatsiorsky-Seluyanov adjusted), see MODEL.md section 7", form: c.form } };
}

// =====================================================================================================================
// Fit report: the standard measures re-measured on the built model, each in its reference posture (ISO 7250-1 / ANSUR protocol), with
// Kinematics. `evaluateMeasures(body)` gives the report in those postures; `evaluateMeasures(body, pose)` evaluates the same definitions in
// any pose { root, angles } (heights are then above the lowest foot contact, seat heights above the lowest ischial contact).
const MEASURES = [];
function measure(id, label, posture, fn, why, unit = "mm") { MEASURES.push({ id, label, posture, fn, why, unit }); }
const ELBOWS = { elbow_L: [90], elbow_R: [90] };
const SEATED = { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] };
const POSTURES = nullProto({
  stand: { label: "standing, neutral", angles: {} },
  arm90: { label: "standing, elbows bent 90 degrees", angles: ELBOWS },
  seat: { label: "ISO 7250 seated: hips 90, knees 90, ankles 0, trunk upright", angles: SEATED },
  seat_arm: { label: "seated, upper arms vertical, elbows 90", angles: { ...SEATED, ...ELBOWS } },
  tpose: { label: "arms out to the sides (shoulder abduction 90)", angles: { shoulder_L: [0, 90, 0], shoulder_R: [0, 90, 0] } },
  forward: { label: "arms forward (shoulder flexion 90)", angles: { shoulder_L: [90, 0, 0], shoulder_R: [90, 0, 0] } },
});
/**
 * Shoulder angles (degrees, the same for both sides) that bring the arm of this body to the horizontal, for the two survey postures that need it: arms out to the
 * side ("tpose", the arm span) and the arm straight forward ("forward", the thumbtip reach). The neutral arm hangs abducted by beta from the vertical (3 to 30 degrees,
 * more for a large trunk), so a plain "abduction 90" would stop beta short of the horizontal and a plain "flexion 90" would leave the arm beta off the midline:
 * the span and the reach would shrink by L (1 - cos beta). T-pose: abduction 90 - beta. Forward: flexion 90 with the adduction that puts the arm in the sagittal
 * plane (solved on the kinematics, the swing is an exponential map). `kin` is any Kinematics with the body's offsets.
 */
function raisedArms(kin) {
  const root = { x: 0, y: 0, z: 0 }, S = [0, 0, 0], strict = kin.strict;
  kin.strict = false; // our own angles, finite by construction: the allocation-free path of fk.js
  const dir = (angles) => { kin.solve(angles, root); const a = kin.toWorld("shoulder_L", S), e = kin.toWorld("elbow_L", S); return [e.x - a.x, e.y - a.y]; };
  const [bx, by] = dir({}), beta = Math.atan2(bx, -by) / D2R;
  // the arm's x component grows with the abduction: secant steps from the nominal adduction (-beta) converge in a few steps
  const ang = [90, -beta, 0], fx = (a) => { ang[1] = a; return dir({ shoulder_L: ang })[0]; };
  let a0 = -beta, f0 = fx(a0), a1 = a0 + 0.5, f1 = fx(a1);
  for (let i = 0; i < 12 && Math.abs(f1) > 1e-10 && f1 !== f0; i++) { const a2 = a1 - (f1 * (a1 - a0)) / (f1 - f0); a0 = a1; f0 = f1; a1 = a2; f1 = fx(a1); }
  kin.strict = strict;
  return { beta, tpose: [0, 90 - beta, 0], forward: [90, a1, 0] };
}
const withArms = (angles, name, raised) => (name === "tpose" || name === "forward" ? { ...angles, shoulder_L: raised[name].slice(), shoulder_R: raised[name].slice() } : angles);

const reachSetback = (f) => f * K.reachSetbackMen + (1 - f) * K.reachSetbackWomen;
const dx = (a, b) => Math.abs(a[0] - b[0]);
const ringOf = (body, id) => { for (const t of [...Object.values(body.shape.tubes), body.shape.head]) { const r = t.rings.find((x) => x.id === id); if (r) return r; } return null; };
const girthOf = (body, id) => { const r = ringOf(body, id); return ringPerimeter(r.rx, r.rz, r.n); };
const H = (id) => (m) => m.w(id)[1] - m.floor; // height above the floor

measure("stature", "Stature", "stand", (m) => m.w("vertex")[1] - m.floor, "the vertex is exactly at the stature");
measure("cervicale_height", "Cervicale height", "stand", H("cervicale"));
measure("suprasternale_height", "Suprasternale height", "stand", H("suprasternale"));
measure("acromion_height", "Acromion height", "stand", H("acromion_L"));
measure("iliocristale_height", "Iliocristale height", "stand", H("iliocristale_L"));
measure("trochanterion_height", "Trochanterion height", "stand", H("trochanterion_L"));
measure("crotch_height", "Crotch height", "stand", H("crotch"));
measure("other:omphalion_height", "Omphalion (waist) height", "stand", H("omphalion"));
measure("other:chest_height", "Chest (nipple) height", "stand", H("thelion_L"));
measure("other:lateral_malleolus_height", "Lateral malleolus height", "stand", H("lateral_malleolus_L"));
measure("other:lateral_femoral_epicondyle_height", "Lateral femoral epicondyle height", "stand", H("epicondyle_lateral_L"));
measure("other:knee_height_midpatella", "Mid-patella height", "stand", H("patella_L"));
measure("other:wrist_height", "Wrist (stylion) height", "stand", H("stylion_L"), "the model's arm hangs along a straight line: real arms hang with a slightly bent elbow, so the wrist is about 12 mm higher than shoulder height minus the arm bones");
measure("biacromial_breadth", "Biacromial breadth", "stand", (m) => dx(m.w("acromion_L"), m.w("acromion_R")));
measure("bideltoid_breadth", "Bideltoid breadth", "stand", (m) => dx(m.w("deltoid_L"), m.w("deltoid_R")));
measure("bicristal_breadth", "Bicristal breadth", "stand", (m) => dx(m.w("iliocristale_L"), m.w("iliocristale_R")));
measure("chest_breadth", "Chest breadth", "stand", (m) => 2 * ringOf(m.body, "chest").rx);
measure("chest_depth", "Chest depth", "stand", (m) => m.w("chest_front")[2] - m.w("chest_back")[2]);
measure("other:waist_breadth", "Waist breadth", "stand", (m) => 2 * ringOf(m.body, "waist").rx);
measure("other:waist_depth", "Waist depth", "stand", (m) => m.w("abdomen_front")[2] - m.w("waist_back")[2]);
measure("other:hip_breadth", "Hip breadth (standing)", "stand", (m) => 2 * ringOf(m.body, "buttock").rx);
measure("other:buttock_depth", "Buttock depth", "stand", (m) => 2 * ringOf(m.body, "buttock").rz);
measure("chest_circumference", "Chest circumference", "stand", (m) => girthOf(m.body, "chest"), "the tape picked up more than a section of the measured breadth and depth can hold (exponent up to 12): up to 1.5 % of the girth is left out, beyond that the breadth and depth grow (MODEL.md 6.1)");
measure("waist_circumference", "Waist circumference", "stand", (m) => girthOf(m.body, "waist"), "the tape picked up more than a section of the measured breadth and depth can hold (exponent up to 12): up to 1.5 % of the girth is left out, beyond that the breadth and depth grow (MODEL.md 6.1)");
measure("buttock_circumference", "Buttock circumference", "stand", (m) => girthOf(m.body, "buttock"), "the tape picked up more than a section of the measured breadth and depth can hold (exponent up to 12): up to 1.5 % of the girth is left out, beyond that the breadth and depth grow (MODEL.md 6.1)");
measure("neck_circumference", "Neck circumference", "stand", (m) => girthOf(m.body, "neck_mid"));
measure("neck_circumference_base", "Neck circumference at the base", "stand", (m) => girthOf(m.body, "neck_base"));
measure("thigh_circumference", "Thigh circumference (gluteal furrow)", "stand", (m) => girthOf(m.body, "th_prox"));
measure("other:knee_circumference", "Knee circumference", "stand", (m) => girthOf(m.body, "th_knee"));
measure("calf_circumference", "Calf circumference", "stand", (m) => girthOf(m.body, "sh_calf"));
measure("ankle_circumference", "Ankle circumference", "stand", (m) => girthOf(m.body, "sh_ankle"));
measure("biceps_circumference_flexed", "Biceps circumference, flexed", "stand", (m) => girthOf(m.body, "ua_biceps"), "the neutral arm is drawn with the flexed girth; a relaxed biceps is 5 to 8 % smaller");
measure("forearm_circumference_flexed", "Forearm circumference, flexed", "stand", (m) => girthOf(m.body, "fa_max"));
measure("wrist_circumference", "Wrist circumference", "stand", (m) => girthOf(m.body, "fa_wrist"));
measure("head_circumference", "Head circumference", "stand", (m) => girthOf(m.body, "brow"));
measure("acromion_radiale_length", "Acromion-radiale length", "stand", (m) => dist3(m.w("acromion_L"), m.w("radiale_L")));
measure("radiale_stylion_length", "Radiale-stylion length", "stand", (m) => dist3(m.w("radiale_L"), m.w("stylion_L")));
measure("hand_length", "Hand length", "stand", (m) => dist3(m.w("stylion_L"), m.w("dactylion_L")));
measure("hand_breadth", "Hand breadth", "stand", (m) => dist3(m.w("metacarpale_radiale_L"), m.w("metacarpale_ulnare_L")));
measure("foot_length", "Foot length", "stand", (m) => m.w("toe_tip_L")[2] - m.w("heel_L")[2]);
measure("foot_breadth", "Foot breadth", "stand", (m) => dx(m.w("metatarsale_tibiale_L"), m.w("metatarsale_fibulare_L")));
measure("head_length", "Head length", "stand", (m) => dist3(m.w("glabella"), m.w("opisthocranion")));
measure("head_breadth", "Head breadth", "stand", (m) => dx(m.w("euryon_L"), m.w("euryon_R")));
measure("bizygomatic_breadth", "Bizygomatic breadth", "stand", (m) => dx(m.w("zygion_L"), m.w("zygion_R")));
measure("menton_sellion_length", "Menton-sellion length", "stand", (m) => dist3(m.w("menton"), m.w("sellion")));
measure("interpupillary_breadth", "Interpupillary breadth", "stand", (m) => dx(m.w("pupil_L"), m.w("pupil_R")));
measure("shoulder_elbow_length", "Shoulder-elbow length", "arm90", (m) => dist3(m.w("acromion_L"), m.w("olecranon_L")));
measure("sitting_height", "Sitting height", "seat", (m) => m.w("vertex")[1] - m.seat, "the seat plane absorbs the difference between standing and sitting trunk length (hip_to_seat)");
measure("eye_height_sitting", "Eye height sitting", "seat", (m) => m.w("ectocanthus_L")[1] - m.seat);
measure("acromion_height_sitting", "Acromion height sitting", "seat", (m) => m.w("acromion_L")[1] - m.seat, "the trunk is rigid: people sit with a slightly lower shoulder than they stand with (about 2 mm lower on average, SD 12 mm)");
measure("elbow_rest_height", "Elbow rest height", "seat_arm", (m) => m.w("olecranon_L")[1] - m.seat, "= acromion height sitting - shoulder-elbow length: differs when the sitting shoulder height does");
measure("thigh_clearance", "Thigh clearance", "seat", (m) => m.w("thigh_top_L")[1] - m.seat);
measure("knee_height_sitting", "Knee height sitting", "seat", (m) => m.w("knee_top_L")[1] - m.floor);
measure("popliteal_height", "Popliteal height", "seat", (m) => m.w("popliteal_L")[1] - m.floor);
measure("buttock_knee_length", "Buttock-knee length", "seat", (m) => m.w("knee_front_L")[2] - m.w("buttock_extremity")[2]);
measure("buttock_popliteal_length", "Buttock-popliteal length", "seat", (m) => m.w("popliteal_L")[2] - m.w("buttock_extremity")[2]);
measure("hip_breadth_sitting", "Hip breadth sitting", "seat", (m) => dx(m.w("hip_sitting_L"), m.w("hip_sitting_R")));
measure("abdominal_depth_sitting", "Abdominal depth sitting", "seat", (m) => m.w("abdomen_front")[2] - m.wall(), "measured against a wall: the lumbar hollow and the sitting slump are not in the rigid model");
measure("span", "Arm span (fingertip to fingertip)", "tpose", (m) => dist3(m.w("dactylion_L"), m.w("dactylion_R")), "depends on shoulder width and the arm bones, each driven by its own measure; real shoulders also move outward when the arms are raised");
measure("thumbtip_reach", "Thumbtip reach", "forward", (m) => m.w("thumb_tip_L")[2] - m.wall() - reachSetback(m.body.formFactor), "depends on the back wall (the most posterior of buttocks and shoulder blades) and on the thumb pose");
measure("mass", "Body mass (volume x 1.05 kg/L)", "stand", (m) => m.body.shape.volume.mass, "from the volume of the skin sections; the mass of the profile is only matched through the adiposity factor when girths are estimated", "kg");

/** The standard measures of the fit report: id (the profile's key), label, reference posture, unit, why it can differ from the profile. */
export const REPORT_MEASURES = Object.freeze(MEASURES.map(({ id, label, posture, unit, why }) => Object.freeze({ id, label, posture, unit, why: why ?? null })));
/** The reference postures of the report: id -> { label, angles } in the joint-angle convention of skeleton.js (see referencePose for the root). */
// (copies, deeply frozen: the report keeps using its own POSTURES, which nobody outside the module can reach)
export const REFERENCE_POSTURES = deepFreeze(Object.fromEntries(Object.entries(POSTURES).map(([k, v]) => [k, { label: v.label, angles: JSON.parse(JSON.stringify(v.angles)) }])));

const tolMm = (input) => Math.max(5, 0.005 * Math.abs(input));
const warnMm = (input) => Math.max(15, 0.02 * Math.abs(input));

/**
 * Re-measure the model. Returns an array of rows { id, label, unit, kind, posture, input, model, delta, tolerance, status, note } (mm; kg for the
 * mass): kind "measure" for each standard measure, input = the profile's value (null when the profile does not have it) and model = the
 * value measured on the model; status "ok" within max(5 mm, 0.5 %), "warn" within max(15 mm, 2 %), "off" beyond, "n/a" without an input.
 * With `pose` ({ root?, angles? } as rig.getPose()) every measure is taken in that pose instead of its reference posture.
 */
export function evaluateMeasures(body, pose) {
  const offsets = {};
  for (const j of JOINTS) if (j.parent) offsets[j.id] = body.joints[j.id].offset;
  const kin = new Kinematics(offsets);
  const L = body.landmarks;
  const hip0 = body.joints.pelvis.offset;
  const solved = new Map();
  let raised;
  const state = (name) => {
    if (!solved.has(name)) {
      const p = pose ?? { angles: withArms(POSTURES[name].angles, name, (raised ??= raisedArms(kin))), root: { x: 0, y: name.startsWith("seat") ? body.d.knee_height : hip0[1], z: 0 } };
      kin.solve(p.angles ?? {}, p.root ?? { x: hip0[0], y: hip0[1], z: hip0[2] });
      const cache = new Map();
      // The definitions read breadths from x, depths and lengths from z (the figure faces +Z): turn the figure back by its heading, so that the values do not
      // depend on where it looks (heights and distances between points are unchanged by a turn about the vertical).
      const hd = (p.root?.heading ?? 0) * D2R, hc = Math.cos(hd), hs = Math.sin(hd);
      const w = (id) => {
        let v = cache.get(id);
        if (!v) {
          if (!L[id]) throw new Error(`landmark ${id} missing`);
          v = kin.toWorld(L[id].joint, L[id].offset).toArray();
          if (hd) v = [v[0] * hc - v[2] * hs, v[1], v[0] * hs + v[2] * hc];
          cache.set(id, v);
        }
        return v;
      };
      const floor = pose ? Math.min(...body.contacts.feet.map((id) => w(id)[1])) : 0;
      const seat = pose ? Math.min(w("ischial_L")[1], w("ischial_R")[1]) : w("ischial_L")[1];
      // the subject stands or sits with shoulder blades and buttocks against the wall; a rigid trunk cannot touch with both, so the wall is their mean
      const wall = () => 0.5 * (0.5 * (w("scapula_back_L")[2] + w("scapula_back_R")[2]) + w("buttock_extremity")[2]);
      solved.set(name, { w, floor, seat, wall, body });
    }
    return solved.get(name);
  };
  const rows = [];
  for (const ms of MEASURES) {
    const m = state(pose ? "given" : ms.posture);
    let model = ms.fn(m);
    if (!Number.isFinite(model)) continue;
    const kg = ms.unit === "kg";
    const inp = body.inputs[ms.id];
    const input = inp === undefined ? null : kg ? inp : inp * 1000;
    model = kg ? model : model * 1000;
    const delta = input === null ? null : model - input;
    const tol = kg ? 0.05 * (input ?? model) : tolMm(input ?? model);
    const wtol = kg ? 2 * tol : warnMm(input ?? model);
    const rej = body.rejected?.[ms.id];
    let status = input === null ? "n/a" : Math.abs(delta) <= tol ? "ok" : Math.abs(delta) <= wtol ? "warn" : "off";
    let note = ms.why && status !== "ok" && status !== "n/a" ? ms.why : "";
    if (rej && input !== null) { note = `not used to build the model (${rej})`; if (status === "ok") status = "warn"; }
    if (pose) note = (note ? note + "; " : "") + "evaluated in the given pose";
    rows.push({ id: ms.id, label: ms.label, unit: kg ? "kg" : "mm", kind: "measure", posture: pose ? "given" : ms.posture, input: input === null ? null : r6(input), model: r6(model), delta: delta === null ? null : r6(delta), tolerance: r6(tol), status, note });
  }
  return rows;
}

// =====================================================================================================================
const cleanRing = (r) => { const { _scal, ...rest } = r; return { ...rest, c: r.c.slice(), bind: r.bind.map((b) => b.slice()) }; };
const mirrorHand = (h) => {
  const m = (p) => mirror3(p);
  return { ...h, joint: "wrist_R", label: "Right hand", palm: h.palm.map((r) => ({ ...r, c: m(r.c), bind: [["wrist_R", 1]] })),
    fingers: Object.fromEntries(Object.entries(h.fingers).map(([k, f]) => [k, { ...f, joints: f.joints.map(mirrorId), tip: m(f.tip), points: f.points.map(m) }])) };
};
const mirrorFoot = (f) => ({ ...f, joint: "ankle_R", label: "Right foot", toesJoint: "mtp_R", stations: f.stations.map((s) => ({ ...s, cx: -s.cx })) });

/** Arm span in the T-pose and thumbtip reach with the arm forward, measured on a layout (for the shoulder tuning). */
function armMeasures(c, geo) {
  const P = geo.P, kin = new Kinematics(Object.fromEntries(JOINTS.filter((j) => j.parent).map((j) => [j.id, sub3(P[j.id], P[j.parent])])));
  const root = { x: 0, y: P.pelvis[1], z: 0 }, raised = raisedArms(kin);
  kin.solve({ shoulder_L: raised.tpose }, root);
  const span = 2 * kin.toWorld("middle_dip_L", sub3(geo.hand.tipOf.middle, P.middle_dip_L)).x;
  kin.solve({ shoulder_L: raised.forward }, root);
  const thumbZ = kin.toWorld("thumb_ip_L", sub3(geo.hand.tipOf.thumb, P.thumb_ip_L)).z;
  const sbY = P.shoulder_L[1] - 0.1 * (c.S / 1.76), wall = 0.5 * (geo.zAt(sbY) - K.spineBack.thoracic - c.d.buttock_back);
  return { span, reach: thumbZ - wall - reachSetback(c.f) };
}
/** Solve the two shoulder parameters that the arm span and the thumbtip reach (when the profile has them) make exact. */
function tuneShoulder(c, geo) {
  const span = c.g("span"), reach = c.g("thumbtip_reach");
  if (span === undefined && reach === undefined) return geo;
  for (let it = 0; it < 6; it++) {
    const m = armMeasures(c, geo);
    let moved = false;
    if (span !== undefined && !Number.isFinite(c.overrides.acromion_to_gh) && Math.abs(span - m.span) > 2e-4) {
      const v = clamp(c.d.acromion_to_gh - (span - m.span) / 2, 0.02, 0.085);
      if (Math.abs(v - c.d.acromion_to_gh) > 1e-6) { c.refine("acromion_to_gh", v, "solved so that the arm span in the T-pose is exactly the measure", ["span"]); c.d.gh_halfwidth = c.d.acromion_halfwidth - v; c.refine("gh_halfwidth", c.d.gh_halfwidth, "follows"); moved = true; }
    }
    if (reach !== undefined && !Number.isFinite(c.overrides.shoulder_protraction) && Math.abs(reach - m.reach) > 2e-4) {
      const v = clamp(c.d.shoulder_protraction + (reach - m.reach), -0.08, 0.08);
      if (Math.abs(v - c.d.shoulder_protraction) > 1e-6) { c.refine("shoulder_protraction", v, "solved so that the thumbtip reach with the arm forward is exactly the measure", ["thumbtip_reach"]); moved = true; }
    }
    if (!moved) break;
    geo = layout(c);
  }
  return geo;
}

/**
 * { root, angles } of a reference posture of the fit report for this body: "stand" (neutral), "seat" (ISO 7250: hips 90, knees 90, ankles 0,
 * trunk upright, feet on the floor), "seat_arm" (seated, elbows 90), "arm90", "tpose", "forward". The root is placed so that the soles
 * are on y = 0 and the pelvis is at x = z = 0.
 */
export function referencePose(body, name) {
  const p = POSTURES[name];
  if (!p) throw new Error(`unknown reference posture "${String(name).slice(0, 40)}" (${Object.keys(POSTURES).join(", ")})`);
  let angles = JSON.parse(JSON.stringify(p.angles));
  if (name === "tpose" || name === "forward") {
    const offsets = {};
    for (const j of JOINTS) if (j.parent) offsets[j.id] = body.joints[j.id].offset;
    angles = withArms(angles, name, raisedArms(new Kinematics(offsets)));
  }
  return { root: { x: 0, y: name.startsWith("seat") ? body.d.knee_height : body.joints.pelvis.offset[1], z: 0, heading: 0, flex: 0, lat: 0, rot: 0 }, angles, label: p.label };
}

/** The factor s that scales the estimated sections so that the model weighs the profile's mass (only when a quarter of the volume is estimated: a few small estimated sections must not swallow the whole difference). */
function adiposity(c, pass0) {
  const vFixed = pass0.vol.fixed + fixedVolume(c), vEst = pass0.vol.est, target = c.mass / (K.density * VOL_CAL);
  const share = vEst / (vFixed + vEst), adjust = share >= 0.25;
  const s = adjust ? clamp(Math.sqrt(Math.max(target - vFixed, 0.15 * vEst) / vEst), 0.75, 1.35) : 1;
  return { s, adjust, share, vFixed, vEst };
}

/**
 * Fit a body model to a profile.
 * @param {object} profile  a Profile (anthro.js): { sex, measures: { key: { value, unit } }, source, notes, ... }, any subset of measures
 * @param {{form?: "male"|"female"|"neutral", overrides?: object}} opts  form: default from profile.sex ("both" -> neutral, the mean of the two
 *   templates); overrides: { [dimensionId]: metres } force a dimension (the user's edit of the mapping table), status becomes "measured"
 * @returns {object} BodyModel, see MODEL.md section 1
 */
export function fitBody(profile, opts) {
  const snap = snapshot(profile), c = new Fit(snap, snapshotOptions(opts));
  for (const def of DEFS) c.resolve(def);
  const geo = tuneShoulder(c, layout(c));

  // ---- shape and the adiposity factor: scale the ESTIMATED sections so that volume x 1.05 kg/L is the mass; measured sections are untouched
  const pass0 = buildShape(c, geo, 1, false);
  const { s, adjust, share, vFixed, vEst } = adiposity(c, pass0);
  const shp = buildShape(c, geo, s, true);
  const volume = vFixed + s * s * vEst, modelMass = volume * K.density * VOL_CAL;
  c.note("adiposity", "Adiposity factor on the estimated sections", "ratio", s, "derived", [],
    adjust ? `the estimated sections are scaled by ${s.toFixed(3)} so that volume x 1.05 kg/L reproduces ${c.mass.toFixed(1)} kg (model volume ${(volume * 1000).toFixed(1)} L)`
      : `${(100 * share).toFixed(0)} % of the volume is estimated (less than 25 %): nothing is scaled; the model weighs ${modelMass.toFixed(1)} kg against ${c.mass.toFixed(1)} kg in the profile`);

  const { L, W } = landmarks(c, geo, shp);
  const head = headShape(c, geo, W);
  c.note("ring_head", "Head section at the brow (head circumference)", "m", head.rings.find((r) => r.id === "brow") ? ringPerimeter(head.rings.find((r) => r.id === "brow").rx, head.rings.find((r) => r.id === "brow").rz, head.rings.find((r) => r.id === "brow").n) : 0,
    c.has("head_circumference") ? "derived" : "estimated", c.has("head_circumference") ? ["head_circumference"] : [], "superellipse through head breadth and head length with the girth of the profile");
  const handL = handShape(c, geo), footL = footShape(c, geo);
  const P = geo.P;
  const tubes = {
    torso: { joint: "pelvis", label: "Trunk: crotch to the base of the neck", closed: ["bottom", "top"], rings: shp.torso.map(cleanRing) },
    neck: { joint: "C7", label: "Neck", closed: ["top"], rings: shp.neck.map(cleanRing) },
  };
  for (const [name, label, joint, rings] of [["upper_arm", "upper arm", "shoulder", shp.upper], ["forearm", "forearm", "elbow", shp.fore], ["thigh", "thigh", "hip", shp.thigh], ["shank", "shank", "knee", shp.shank]]) {
    tubes[`${name}_L`] = { joint: `${joint}_L`, label: `Left ${label}`, closed: name === "upper_arm" ? ["top"] : [], rings: rings.map(cleanRing) };
    tubes[`${name}_R`] = { joint: `${joint}_R`, label: `Right ${label}`, closed: name === "upper_arm" ? ["top"] : [], rings: mirrorTube(rings).map(cleanRing) };
  }
  const shape = {
    units: "m", frame: "neutral world pose (+Y up, +Z anterior, +X left), centres in world coordinates",
    adiposity: r6(s), form: c.form,
    tubes, head, hands: { L: handL, R: mirrorHand(handL) }, feet: { L: footL, R: mirrorFoot(footL) },
    volume: { m3: r6(volume), mass: r6(modelMass), density: K.density, calibration: VOL_CAL, scalable: r6(s * s * vEst), fixed: r6(vFixed) },
  };
  const joints = offsetsOf(P);
  const positions = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.map(r6)]));
  const massM = massModel(c, geo);
  const contacts = contactSets(L);

  const inputs = {};
  for (const [k, v] of c.inp) inputs[k] = v;
  const rejected = Object.fromEntries(c.rejected);
  const body = {
    version: 1, profileId: snap.id, label: snap.label, sex: snap.sex ?? "both", form: c.form, formFactor: c.f,
    stature: c.S, mass: c.mass, dims: c.dims, d: { ...c.d }, joints, positions, landmarks: L, contacts, shape, masses: massM.segments, massInfo: massM.info, inputs, rejected, warnings: c.warnings,
  };
  // ---- report
  const rows = evaluateMeasures(body);
  for (const dm of c.dims) {
    for (const a of dm.alt ?? []) {
      const scale = dm.unit === "kg" ? 1 : 1000, input = a.value * scale, model = dm.value * scale, delta = model - input, tol = tolMm(input);
      rows.push({ id: `check:${dm.id}`, label: `${dm.label}: check by ${a.keys.join(" + ")}`, unit: dm.unit === "kg" ? "kg" : "mm", kind: "check", posture: "-", input: r6(input), model: r6(model), delta: r6(delta), tolerance: r6(tol),
        status: Math.abs(delta) <= tol ? "ok" : Math.abs(delta) <= warnMm(input) ? "warn" : "off", note: `driven by: ${dm.formula}. Alternative: ${a.via} would give ${input.toFixed(0)} mm (the first was used, nothing is averaged)` });
    }
  }
  body.report = rows;
  const meas = rows.filter((r) => r.kind === "measure");
  body.reportSummary = {
    measures: meas.length, ok: meas.filter((r) => r.status === "ok").length, warn: meas.filter((r) => r.status === "warn").length, off: meas.filter((r) => r.status === "off").length,
    na: meas.filter((r) => r.status === "n/a").length, checks: rows.length - meas.length, checksOff: rows.filter((r) => r.kind === "check" && r.status !== "ok").length,
    dims: { total: c.dims.length, measured: c.dims.filter((x) => x.status === "measured").length, derived: c.dims.filter((x) => x.status === "derived").length, estimated: c.dims.filter((x) => x.status === "estimated").length },
  };
  const rowOf = (id) => rows.find((r) => r.id === id && r.kind === "measure");
  body.reportSummary.closure = {
    stature_mm: rowOf("stature")?.delta ?? null,
    sitting_height_mm: rowOf("sitting_height")?.delta ?? null,
    note: "stature is exact by construction; the sitting height is exact when a sitting height is in the profile and the hip-to-seat dimension stays inside its plausible range",
  };
  body.spine = geo.spine;
  addWarnings(c, body, snap);
  body.warnings = [...new Set(body.warnings)];
  return body;
}

function addWarnings(c, body, profile) {
  const w = c.warnings;
  const skel = body.dims.filter((x) => x.unit === "m" && !x.id.startsWith("ring_"));
  const est = skel.filter((x) => x.status === "estimated").length;
  if (skel.length && est / skel.length > 0.5) w.push(`${est} of ${skel.length} skeleton dimensions (${Math.round((100 * est) / skel.length)} %) are estimated from stature, mass and sex: the body is a typical one of this size, not this person.`);
  for (const dm of body.dims) if (dm.note.includes("was rejected")) w.push(`${dm.label}: ${dm.note.slice(dm.note.indexOf("a more direct route")).replace("a more direct route was rejected: ", "a more direct measure was rejected: ")}`);
  for (const dm of body.dims) for (const a of dm.alt ?? []) if (Math.abs(a.delta) > Math.max(0.015, 2 * (a.sd ?? 0))) w.push(`${dm.label}: ${a.via} would give ${(a.value * 1000).toFixed(0)} mm, ${(Math.abs(a.delta) * 1000).toFixed(0)} mm ${a.delta < 0 ? "less" : "more"} than the ${(dm.value * 1000).toFixed(0)} mm used: the measures conflict.`);
  // heights are absolute: a long thigh (an edit, or a contradicting measure) is taken out of the trunk and the neck
  if (body.d.trunk_length < 0.3 + 1e-6 || body.d.neck_length < 0.07 + 1e-6) w.push(`The heights leave only ${Math.round(body.d.trunk_length * 1000)} mm for the trunk and ${Math.round(body.d.neck_length * 1000)} mm for the neck (typical 460 and 90 mm): the spine is squeezed. A leg or head length was edited, or the measures disagree.`);
  const src = profile.source;
  if (src?.kind === "population" && src.scaling !== "proportional") {
    w.push(src.percentile === 50 ? "Population profile at P50: every dimension is the median of that dimension alone, a reference body; nobody has every dimension at the median."
      : "Population profile: every dimension is a percentile of its own distribution, so the body is a boundary case; real people do not have all dimensions at the same percentile.");
  }
  const mr = body.reportSummary && body.report.find((r) => r.id === "mass");
  if (mr && body.shape.adiposity === 1 && Math.abs(mr.model - c.mass) > 0.1 * c.mass && c.massStatus === "measured") w.push(`The measured girths imply ${mr.model.toFixed(0)} kg, the profile says ${c.mass.toFixed(0)} kg (model volume x 1.05 kg/L).`);
  if (body.shape.adiposity <= 0.76 || body.shape.adiposity >= 1.34) w.push(`The adiposity factor (${body.shape.adiposity.toFixed(2)}) hit its limit: stature and mass do not go together in the regressions; check the mass.`);
  const bad = body.report.filter((r) => r.kind === "measure" && r.status === "off");
  if (bad.length) w.push(`${bad.length} measure(s) differ from the model by more than max(15 mm, 2 %): ${bad.slice(0, 6).map((r) => r.label).join(", ")}${bad.length > 6 ? ", ..." : ""}.`);
}

// The exported tables are shared: nobody may edit them behind the fitter's back.
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
deepFreeze(REG_DATA); deepFreeze(REL_DATA); deepFreeze(K); deepFreeze(DIM_DEFS);
