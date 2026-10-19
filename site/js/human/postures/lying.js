// Posture group "Lying" (ids lie-*). The body on a floor, a mat, a bed or a creeper: supine, prone, on either side, fetal, recovery position, with the knees
// up or the legs raised, with the arms overhead, out to the sides, behind the head or on the chest, propped on the elbows, reaching forward on the front,
// semi-reclined and on a mechanic's creeper under a vehicle.
// Support "body": the pelvis root lays the figure down (root flex -90 = supine, +90 = prone, lat +-90 = on a side) and placement (pose.js placePose) puts the
// lowest points of the skin on the floor, so that nothing sinks below it. What is NOT guaranteed by the support is that the other parts of the body
// touch it too: the rigid model has no soft tissue, so the shoulder blades, the sacrum, the back of the head and the heels lie in one plane only
// approximately. The angles of the trunk, neck and arms below were solved against the heights of those points above the floor for five bodies (the 5th-
// and 50th-percentile woman, the median man, the 95th percentile man and a stature-only 1.70 m man) so that they are within about 20 mm of the
// floor for them; the arms rest 30 to 80 mm above it (the shoulder joint is 120 mm above the floor and the arm is a rigid tube).
// The very wide test body (BMI 41) floats 60 to 100 mm at the shoulders and heels: its back is not flat in the model.
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors:
// docs/human3d/POSTURES.md and POSE.md. Their `category` must be "Lying".

// The mirror image of a posture (left and right exchanged; flexion, abduction and the like keep their sign, lateral bend, axial rotation, the root
// heading, lat and rot and the azimuth of both eyes change it), exactly what pose.js mirrorPose does to a pose (tests check it). Used for the two sides.
const UNPAIRED = { head: [1, 2], jaw: [], eye_LR: [1] };
function mirrored(p, id, name, tags, description) {
  const neg = (a, idx) => a.map((v, i) => (idx.includes(i) ? -v : v));
  const swap = (k) => (k.endsWith("_L") ? `${k.slice(0, -1)}R` : k.endsWith("_R") ? `${k.slice(0, -1)}L` : k);
  const joints = {};
  for (const [k, v] of Object.entries(p.joints ?? {})) joints[swap(k)] = Object.hasOwn(UNPAIRED, k) ? neg(v, UNPAIRED[k]) : /^[LTC]\d+$/.test(k) ? neg(v, [1, 2]) : v;
  const spine = {};
  for (const [k, v] of Object.entries(p.spine ?? {})) spine[k] = neg(v, [1, 2]);
  const root = {};
  for (const [k, v] of Object.entries(p.root ?? {})) root[k] = k === "flex" ? v : -v;
  const grips = p.grips ? { L: p.grips.R, R: p.grips.L } : undefined;
  return { ...p, id, name, tags, description, joints, spine, root, ...(grips ? { grips } : {}) };
}

const SIDE_LEFT = {
  id: "lie-side-left",
  name: "Lying on the left side",
  category: "Lying",
  tags: ["lying", "static", "asymmetric", "side", "rest", "floor", "bed"],
  description: "Lying on the left side with the left arm stretched overhead and bent under the head, the right arm resting on the hip, the legs slightly bent and the upper leg further forward than the lower. The usual resting side posture on a mat or a bed; mirrored for the right side.",
  source: "illustrative; angles solved so that the left shoulder, hip, knee and ankle lie within 60 mm of the floor on five bodies (a rigid body cannot lie flat on its side: the shoulders are wider than the hips)",
  support: "body",
  root: { lat: 86 },
  // retuned by a coordinate search on 510 bodies (176 population medians, the P5/P95 of the others and persons of the database): hand edit of cervical 29 / head 3 -8 / shoulder_L 171 39 / elbow_L 85 (were 35 / 0 -5 / 165 45 / 91); the head was in the forearm on 7 of them (also lie-side-right, its mirror), now none
  spine: { lumbar: [0, -9, 0], thoracic: [0, 15, 0], cervical: [0, 29, 0] },
  joints: {
    head: [3, -8, 0],
    hip_L: [32, 0, 0], knee_L: [17, 0], ankle_LR: [-12, 0, 0],
    hip_R: [60, 0, 0], knee_R: [45, 0],
    shoulder_L: [171, 39, 0], elbow_L: [85],
    shoulder_R: [-10, 0, 0], elbow_R: [32], forearm_R: [36], wrist_R: [30, 0],
  },
  grips: { L: "relaxed", R: "relaxed" },
};

export default [
  {
    id: "lie-supine",
    name: "Lying on the back (supine)",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "rest", "floor", "bed"],
    description: "Lying flat on the back, legs straight and a little apart with the feet relaxed, arms beside the trunk with the palms up, head resting. The basic rest and examination posture on a mat, a bed or an examination table; the figure's length and the height of its parts above the surface are what a bed or a berth is designed around.",
    source: "illustrative; angles solved so that the shoulder blades, sacrum and back of the head lie within 20 mm of the floor and the elbows within 40 mm on five bodies (the model has no soft tissue: the arms rest 40 to 80 mm above the floor)",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -8],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [-16, 19, 5], elbow_LR: [7], forearm_LR: [-79],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-arms-overhead",
    name: "Lying on the back, arms overhead",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "overhead", "stretch", "floor"],
    description: "Lying flat on the back with both arms stretched above the head along the floor, elbows slightly bent, legs straight. A stretch, a sleeping posture and the working position of someone reaching along the floor above the head; it is the longest the lying figure gets.",
    source: "illustrative; shoulder flexion 160 deg (the range is 180) with 25 deg of abduction",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -10],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [160, 25, 0], elbow_LR: [20],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-arms-abducted",
    name: "Lying on the back, arms out to the sides",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "arms-out", "table", "patient", "floor"],
    description: "Lying flat on the back with both arms out to the sides at about 75 degrees from the trunk, palms up, legs straight. The patient position on an operating or examination table with the arms on arm boards (abduction kept to 90 degrees or less), and the widest the supine figure gets: the width that a table, a bunk or a stretcher with arm rests has to take.",
    source: "ASA task force on perioperative peripheral neuropathies (supine arm abduction limited to 90 degrees to protect the brachial plexus); angles illustrative",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [-3, -3],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [-14, 76, -15], elbow_LR: [9], forearm_LR: [-79],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-hands-behind-head",
    name: "Lying on the back, hands behind the head",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "arms", "rest", "two-hand", "bunk"],
    description: "Lying on the back with the hands resting beside and behind the head, elbows out to the sides and low, legs straight. The relaxed resting posture on a bunk or a berth; the elbows add about half a metre to the width of the figure, which a narrow bunk or a sleeping bag has to allow.",
    source: "illustrative; the arm angles of stand-hands-behind-head with the shoulder abducted 103 deg instead of 125 so that the elbows rest low (the head lies on the floor, so the palms end up at its sides, 0.1 to 0.2 m from the back of the head)",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    // retuned by a coordinate search on 510 bodies (176 population medians, the P5/P95 of the others and persons of the database): hand edit of the shoulder (was 18 103 -62): fingers in the head on 4 of them, now none
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -2],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [21, 100, -62], elbow_LR: [131], forearm_LR: [17], wrist_LR: [-35, -16],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-knees-up",
    name: "Lying on the back, knees up (hook-lying)",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "knees-up", "hook-lying", "floor", "exercise"],
    description: "Lying on the back with the hips and knees bent and the feet flat on the floor about a foot-length apart, arms beside the trunk. The starting position of floor exercises and of low back rest (the bent legs flatten the lumbar curve); also a casualty or patient position for examining the abdomen.",
    source: "illustrative; hip flexion 55 deg, knee flexion 134 deg, ankle dorsiflexion so that the soles lie flat (tuned on five bodies: within 10 mm for the medium and tall ones, the 5th-percentile woman's feet are 45 mm above the floor)",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -8],
      hip_LR: [55, 6, -5], knee_LR: [134, 0], ankle_LR: [-15, -6, 0],
      shoulder_LR: [-16, 19, 5], elbow_LR: [7], forearm_LR: [-79],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-legs-raised",
    name: "Lying on the back, calves on a chair (90-90)",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "legs-raised", "90-90", "rest", "chair"],
    description: "Lying on the back with the hips and the knees bent to a right angle and the lower legs resting horizontally on a chair seat, arms beside the trunk. A rest position that unloads the lumbar spine and the legs; also the shock-and-faint first-aid position (legs raised above the heart) when the chair is higher.",
    source: "illustrative; hip and knee flexion 92 and 91 deg so that the shanks are horizontal (the seat of the chair is about 0.5 m high for the median man)",
    support: "body",
    hints: { externalSupport: "chair", prop: { type: "office_chair", params: { seatHeight: 0.5 }, role: "support", note: "the calves rest on the seat, the chair stands with its seat at the knee end of the figure" } },
    root: { flex: -95 },
    spine: { lumbar: [8, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -8],
      hip_LR: [92, 6, -5], knee_LR: [91, 0], ankle_LR: [-4, 0, 0],
      shoulder_LR: [-16, 19, 5], elbow_LR: [7], forearm_LR: [-79],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-supine-hands-on-chest",
    name: "Lying on the back, hands on the chest",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "rest", "casualty", "stretcher", "two-hand"],
    description: "Lying flat on the back, legs straight, forearms folded on the lower chest with the hands together. The usual posture of a casualty on a stretcher or a patient on a table, and of a resting figure that takes the least width; the stretcher bearers' figure of the Lifting group carries this one.",
    source: "illustrative; hands on the xiphoid area, tuned on five bodies",
    support: "body",
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [-4, 0, 0] },
    // retuned by a coordinate search on 510 bodies (176 population medians, the P5/P95 of the others and persons of the database), the palm kept within the limits of the semantic test: hand edit of the shoulder (was 2 35 61): the palms overlapped on 94 of them, now 2
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -9],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [-1, 38, 58], elbow_LR: [128], forearm_LR: [-30], wrist_LR: [12, -17],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-prone",
    name: "Lying on the front (prone)",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "prone", "rest", "floor", "bed"],
    description: "Lying face down, the head turned to the left, arms beside the trunk with the palms up, legs straight with the feet relaxed. A rest and sleeping posture, and the base of the prone working positions (under a vehicle, along a floor); the head turn keeps the airway free.",
    source: "illustrative; angles solved so that the chest, the knees, the toes and the right cheek lie near the floor on five bodies (the arms rest 80 to 130 mm above it: the shoulder joint is 120 mm above the chest front)",
    support: "body",
    root: { flex: 96 },
    spine: { lumbar: [2, 0, 0], thoracic: [-1, 0, 0], cervical: [-17, 0, 50] },
    joints: {
      head: [14, 0, 8],
      clavicle_LR: [-1, 3],
      hip_LR: [20, 3, -6], knee_LR: [15, 0], ankle_LR: [-44, 0, 0],
      shoulder_LR: [4, 19, 38], elbow_LR: [0], forearm_LR: [-60],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-prone-arms-forward",
    name: "Lying on the front, arms forward",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "prone", "arms-forward", "reach", "floor"],
    description: "Lying face down with both arms stretched forward along the floor, palms down, legs straight, head turned to the left. The glide position of a swimmer, the reach of someone working a cable or a tool along the floor or under an obstacle, and a stretch.",
    source: "illustrative; shoulder flexion 170 deg with 39 deg of abduction, solved so that the hands lie within 50 mm of the floor on four of five bodies",
    support: "body",
    root: { flex: 96 },
    spine: { lumbar: [2, 0, 0], thoracic: [-1, 0, 0], cervical: [-17, 0, 50] },
    joints: {
      head: [14, 0, 8],
      clavicle_LR: [-10, -10],
      hip_LR: [20, 3, -6], knee_LR: [15, 0], ankle_LR: [-44, 0, 0],
      shoulder_LR: [170, 39, -23], elbow_LR: [17], forearm_LR: [47], wrist_LR: [30, 0],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-prone-one-arm-forward",
    name: "Lying on the front, reaching forward with the right arm",
    category: "Lying",
    tags: ["lying", "static", "asymmetric", "prone", "reach", "one-hand", "confined-space", "rescue"],
    description: "Lying face down, the right arm stretched forward along the floor, the left forearm folded beside the head, the head turned to the right, legs straight. The posture of reaching under a vehicle, into a crawl space or toward a casualty trapped under debris; mirrorPose reaches with the left arm.",
    source: "illustrative; the right arm of lie-prone-arms-forward, the left arm folded as in the start of a push-up, head turned toward the reaching arm",
    support: "body",
    root: { flex: 96 },
    spine: { lumbar: [2, 0, 0], thoracic: [-1, 0, 0], cervical: [-17, 0, -50] },
    joints: {
      head: [14, 0, -8],
      clavicle_LR: [-1, 3],
      hip_LR: [20, 3, -6], knee_LR: [15, 0], ankle_LR: [-44, 0, 0],
      shoulder_R: [170, 39, -23], elbow_R: [17], forearm_R: [47], wrist_R: [30, 0],
      shoulder_L: [27, 102, -62], elbow_L: [119], forearm_L: [-69],
    },
    grips: { L: "relaxed", R: "open" },
  },
  {
    id: "lie-prone-on-elbows",
    name: "Lying on the front, propped on the elbows",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "prone", "elbows", "sphinx", "reading", "floor"],
    description: "Lying on the front with the chest raised on the forearms, elbows under the shoulders, the lumbar spine in extension and the head up. Reading, watching and looking ahead from the floor, and the low position of a person working on a surface in front of them (a creeper, a bunk); the lumbar and neck extension are the thing to check.",
    source: "illustrative; the 'sphinx' position of back-extension exercise (McKenzie): lumbar extension 30 deg, thoracic 25 deg; solved so that the elbows and the abdomen touch the floor on five bodies",
    support: "body",
    root: { flex: 93 },
    spine: { lumbar: [-30, 0, 0], thoracic: [-25, 0, 0], cervical: [-28, 0, 0] },
    joints: {
      head: [-1, 0, 0],
      clavicle_LR: [0, 12],
      hip_LR: [11, 3, -6], knee_LR: [3, 0], ankle_LR: [-55, 0, 0],
      shoulder_LR: [76, 3, 0], elbow_LR: [70], forearm_LR: [-4],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-fetal",
    name: "Lying curled up on the side (fetal)",
    category: "Lying",
    tags: ["lying", "static", "asymmetric", "side", "fetal", "curled", "rest", "floor"],
    description: "Lying on the left side curled up: spine flexed, head bent forward, hips and knees drawn up, arms folded in front of the chest. A resting and a protective posture (cold, pain, shelter); it is the most compact the lying figure gets, which is what a berth, a locker or a crawl space has to take.",
    source: "illustrative; spine flexion lumbar 32, thoracic 35, cervical 42 deg, hips 95 to 100 deg, knees 125 to 128 deg; arm angles chosen so that the forearms lie in front of the chest without touching the thighs",
    support: "body",
    root: { lat: 90 },
    spine: { lumbar: [32, 0, 0], thoracic: [35, 12, 0], cervical: [42, 0, 0] },
    // shoulder rotation 22 (was 25): hand edit by a coordinate search on 510 bodies, the palms kept within 0.32 m of the chest and the lowest landmark under 55 mm; the hands were in the head or the thigh on 10 of them, now 7
    joints: {
      head: [20, 0, 0],
      hip_L: [95, 10, 0], knee_L: [125, 0], hip_R: [100, 0, 0], knee_R: [128, 0], ankle_LR: [-40, 0, 0],
      shoulder_LR: [55, 20, 22], elbow_LR: [120],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-recovery-position",
    name: "Recovery position (lateral recumbent)",
    category: "Lying",
    tags: ["lying", "static", "asymmetric", "side", "first-aid", "recovery", "rescue", "airway"],
    description: "The first-aid recovery position on the left side: the lower arm out in front with the elbow bent and the hand beside the head, the upper hand under the cheek, the upper leg bent at hip and knee to a right angle in front, the head tilted back to keep the airway open. For an unconscious casualty who is breathing; the posture stabilises the body on its side so that it cannot roll and the mouth drains.",
    source: "NHS and St John Ambulance first-aid guidance, and the European Resuscitation Council (recovery position: arm nearest the rescuer at a right angle with the elbow bent, the other hand against the cheek, the far knee bent to a right angle, head tilted back, chin lifted); angles illustrative",
    support: "body",
    root: { lat: 88 }, // lat 88 (was 89): hand edit; with 89 the trochanter of the 95th-percentile man lay 101 mm above the floor, the test asks for under 100
    spine: { lumbar: [0, -17, 0], thoracic: [0, 20, 0], cervical: [-8, 35, 5] },
    joints: {
      head: [-3, 10, 8],
      hip_L: [30, 3, 0], knee_L: [43, 0], hip_R: [85, 3, 0], knee_R: [85, 0], ankle_LR: [-12, 0, 0],
      shoulder_L: [95, 20, 0], elbow_L: [80], forearm_L: [-40], shoulder_R: [54, 27, 41], elbow_R: [132],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-creeper-reaching-up",
    name: "Lying on a creeper, reaching up",
    category: "Lying",
    tags: ["lying", "static", "asymmetric", "supine", "creeper", "workshop", "overhead", "under-vehicle", "tool"],
    description: "Lying on the back on a low mechanic's creeper under a vehicle, head lifted to see, the right arm reaching straight up with a tool, the left forearm held in front of the chest. The standard under-vehicle working posture; it sets the clearance between the floor and the underside of a vehicle (the body plus the creeper is about 0.3 m thick) and the reach of the arm over the chest.",
    source: "illustrative; shoulder flexion 105 deg with a straight elbow (about 40 cm above the chest), neck flexion about 20 deg to look up the length of the body; creeper height after common practice (0.1 m)",
    support: "body",
    hints: { prop: { type: "floor_platform", params: { width: 0.5, depth: 1.0, height: 0.1 }, role: "support", note: "the creeper board: lay the figure on its top face (0.1 m above the floor); the vehicle underside is a separate object above the figure" } },
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [22, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -8],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_R: [105, 12, 0], elbow_R: [15], shoulder_L: [35, 12, 0], elbow_L: [100], forearm_L: [30],
    },
    grips: { L: "relaxed", R: "power" },
  },
  {
    id: "lie-creeper-both-arms-up",
    name: "Lying on a creeper, both hands overhead",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "supine", "creeper", "workshop", "overhead", "under-vehicle", "two-hand", "tool"],
    description: "Lying on the back on a mechanic's creeper with the head lifted and both arms raised, upper arms almost vertical and elbows bent, hands above the face as when turning a bolt on the underside of a vehicle. The two-handed under-vehicle working posture: the hands work 0.35 to 0.5 m above the shoulders.",
    source: "illustrative; shoulder flexion 90 deg with 45 deg of elbow flexion, neck flexion about 20 deg to look at the work; creeper height after common practice (0.1 m)",
    support: "body",
    hints: { prop: { type: "floor_platform", params: { width: 0.5, depth: 1.0, height: 0.1 }, role: "support", note: "the creeper board: lay the figure on its top face (0.1 m above the floor); the vehicle underside is a separate object above the figure" } },
    root: { flex: -94 },
    spine: { lumbar: [7, 0, 0], thoracic: [-12, 0, 0], cervical: [22, 0, 0] },
    joints: {
      head: [-2, 0, 0],
      clavicle_LR: [0, -8],
      hip_LR: [-4, 3, -10], ankle_LR: [-12, 0, 0],
      shoulder_LR: [90, 12, 0], elbow_LR: [45], forearm_LR: [10],
    },
    grips: { L: "power", R: "power" },
  },
  {
    id: "lie-semi-reclined-legs-raised",
    name: "Semi-reclined, legs raised",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "semi-reclined", "recliner", "legs-raised", "rest", "seat"],
    description: "Half lying in a recliner: the trunk 40 degrees above the horizontal, the hips bent, the legs raised on a leg rest to about the height of the hips, arms resting on the armrests. The comfortable rest posture of a reclining seat, a crew rest bunk or a medical chair; the figure that a recliner or a zero-gravity seat is designed for.",
    source: "illustrative; 'zero-gravity' neutral posture of about 120 deg trunk-thigh angle with the legs raised (NASA-STD-3000 is for weightlessness and is not used); trunk 40 deg above horizontal, hips 60 deg, knees 25 deg",
    support: "body",
    hints: { externalSupport: "recliner", prop: { type: "cabin_seat", params: { recline: 125, panAngle: 15, seatHeight: 0.3 }, role: "support", note: "a reclined seat: the back is 40 deg above the horizontal (125 deg to the pan with the pan tilted 15 deg up), a leg rest continues the pan so that the thighs rise about 20 deg and the shanks lie about horizontal" } },
    root: { flex: -50 },
    spine: { cervical: [28, 0, 0] },
    joints: {
      head: [5, 0, 0],
      hip_LR: [60, 4, -6], knee_LR: [25, 0], ankle_LR: [-8, 0, 0],
      shoulder_LR: [18, 14, 0], elbow_LR: [80], forearm_LR: [30],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "lie-semi-fowler",
    name: "Propped up in bed (semi-Fowler)",
    category: "Lying",
    tags: ["lying", "static", "symmetric", "semi-reclined", "bed", "fowler", "patient", "rest"],
    description: "Lying in a bed with the head end raised so that the trunk is 45 degrees above the horizontal and the knees slightly bent over a raised knee rest, hands in the lap. The usual hospital bed position for eating, reading and breathing; a width and length reference for beds and bunks.",
    source: "Fowler's position of hospital beds (semi-Fowler: head of bed raised 30 to 45 deg, knee gatch about 15 deg); angles illustrative",
    support: "body",
    hints: { externalSupport: "bed", prop: { type: "cabin_seat", params: { recline: 135, panAngle: 0, seatHeight: 0.5 }, role: "support", note: "stands for a bed with a head section raised 45 deg (the back is 135 deg to the flat pan); a flat support at the same height carries the legs, and the knee section raises the knees 15 deg" } },
    root: { flex: -45 },
    spine: { cervical: [22, 0, 0] },
    joints: {
      head: [8, 0, 0],
      hip_LR: [45, 4, -6], knee_LR: [28, 0], ankle_LR: [-14, 0, 0],
      shoulder_LR: [20, 12, 20], elbow_LR: [75], forearm_LR: [40],
    },
    grips: { L: "relaxed", R: "relaxed" },
  },
  SIDE_LEFT,
  mirrored(SIDE_LEFT, "lie-side-right", "Lying on the right side", ["lying", "static", "asymmetric", "side", "rest", "floor", "bed"],
    "Lying on the right side with the right arm stretched overhead and bent under the head, the left arm resting on the hip, the legs slightly bent and the upper leg further forward than the lower. The mirror image of lying on the left side, for the other side of a bed or a berth."),
];
