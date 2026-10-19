// Posture group "Sitting". Covers the POSTURES.md category "Sitting": seated upright 90-90-90 (ISO 7250), relaxed office, lumbar-supported
// (back rest 100 deg), reclined 105 / 115 / 125 / 135 deg, slumped, leaning forward to a desk (forearms on the desk), on the edge of the
// seat, perched on a high stool, legs crossed at the knee, legs crossed at the ankle, legs extended forward, long-sitting on the floor,
// cross-legged on the floor, kneeling-sitting on the heels (seiza), side-sitting on the floor, low squat-sitting, elbows on knees, bench
// with arms along the back rest, typing, mouse use, reading a tablet, reaching forward to a control panel. Driving belongs to vehicle.js.
// Supports: "seat+feet" with hints.seat.height "popliteal", "seat" with the feet off the floor (hints.seat.height 0 = sitting on the floor),
// "knees" for seiza.
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors:
// docs/human3d/POSTURES.md and POSE.md. Their `category` must be "Sitting"; the usual support here is "seat+feet".
//
// How the angles are written. Hip flexion is relative to the PELVIS, and the pelvis tilts back with the trunk in a reclined posture (root.flex < 0
// tilts the whole body back about the hips, which swings the thighs forward by the same angle), so a horizontal thigh needs hip flexion = 90 + root.flex.
// The backrest angle of a seat (seat pan to back rest: 90 = upright, 105 office chair, 115 to 135 reclined) leans the trunk back by (angle - 90) degrees.
// Sources in each entry; "illustrative" where the angles are the author's own. All values are an indication on a simplified kinematic model.
const REL = { L: "relaxed", R: "relaxed" };

// Seat back angle family: the trunk leans back by (angle - 90) degrees. The pelvis takes 80 % of it (a posterior tilt that swings the thighs
// forward by the same angle, so the hips are flexed 90 + root.flex to keep the thighs level), the thoracic and lumbar spine 10 % each as extension
// (the back follows the back rest instead of sitting on it); the neck bends forward so that the head stays near level, as in a car seat. The arms
// rest on the thighs (their angles were fitted so that the palm lies on the middle of the thigh, then rounded). The back rest carries part of the
// weight (hints.externalSupport), the feet stay on the floor (contacts).
function reclined(angle, name, description, tags) {
  const lean = angle - 90, root = -Math.min(8, Math.round(0.4 * lean)), neck = Math.round(0.8 * lean);
  const rest = Math.max(0, lean - 3 + root), lumExt = Math.round(0.4 * rest), thoExt = rest - lumExt;
  return {
    id: `sit-recline-${angle}`,
    name,
    category: "Sitting",
    tags: ["seat", "recline", "back-rest", "static", "symmetric", "feet-on-floor", ...tags],
    description,
    source: `illustrative: seat back angle ${angle} deg (trunk ${lean} deg from vertical); back rest ranges after Grandjean (1980) and the lumbar disc pressure studies of Andersson, Ortengren and Nachemson (1974-75), approx.`,
    support: "seat+feet",
    root: { flex: root },
    spine: { lumbar: [-lumExt, 0, 0], thoracic: [-thoExt, 0, 0], cervical: [Math.round(0.7 * neck), 0, 0] },
    joints: { hip_LR: [90 + root, 0, 0], knee_LR: [85, 0], head: [Math.round(0.3 * neck), 0, 0], shoulder_LR: [-8, 4, 10], elbow_LR: [75 - Math.round(0.65 * (lean - 15))], forearm_LR: [35] },
    grips: { L: "flat", R: "flat" },
    contacts: ["heel_sole_L", "heel_sole_R"],
    hints: { seat: { height: "popliteal" }, externalSupport: "back rest", prop: { type: "cabin_seat", params: { recline: angle }, role: "support", note: `Back rest ${angle} degrees to the seat pan; the sandbox seat is adjusted to the body.` } },
  };
}

export default [
  reclined(105, "Seat back reclined 105 degrees", "Trunk leaning back 15 degrees against the back rest, thighs level, hands on the thighs: the setting of an office chair or a car seat that is only slightly reclined. Reference for back rest angle and eye height.", ["office"]),
  reclined(115, "Seat back reclined 115 degrees", "Trunk leaning back 25 degrees, head supported, hands on the thighs: the seat back angle of a typical car driver's seat (SAE design torso angle 20 to 25 degrees) and of a relaxed armchair.", ["vehicle"]),
  reclined(125, "Seat back reclined 125 degrees", "Trunk leaning back 35 degrees, the pelvis rolled back and the neck bent forward to keep the eyes on the horizon: a lounge or aircraft seat in rest position.", ["lounge"]),
  reclined(135, "Seat back reclined 135 degrees", "Trunk leaning back 45 degrees, almost a half lying posture with the legs forward and the head resting on the head rest: a deeply reclined seat for resting or sleeping.", ["lounge", "rest"]),
  {
    id: "sit-upright-90",
    name: "Seated upright, hands on thighs",
    category: "Sitting",
    tags: ["seat","iso-7250","upright","static","symmetric","feet-on-floor"],
    description: "Sitting erect on a seat at popliteal height, hips, knees and ankles at about 90 degrees, head level, hands resting on the thighs. The neutral working posture for seat height, knee clearance and seat depth checks.",
    source: "ISO 7250-1 seated measurement posture (90-90-90) with the hands on the thighs; illustrative arm position",
    joints: { hip_LR: [90], knee_LR: [90], shoulder_LR: [-10, 8, 20], elbow_LR: [90], forearm_LR: [30], wrist_LR: [15, -10] },
    grips: { L: "flat", R: "flat" },
    support: "seat+feet",
    hints: { seat: { height: "popliteal" } },
  },
  {
    id: "sit-relaxed-office",
    name: "Relaxed office sitting",
    category: "Sitting",
    tags: ["seat","office","relaxed","static","symmetric","back-rest","feet-on-floor"],
    description: "Leaning back against an office chair set at about 100 degrees, the lower back rounded a little, forearms on the arm rests, feet a little forward of the knees. The posture people settle into during long desk work.",
    source: "illustrative; back rest about 100 deg and arm rests at elbow height after office-chair practice (ISO 9241-5, ANSI/HFES 100), lumbar and neck flexion within the range of observed relaxed sitting",
    root: { flex: -8 },
    spine: { lumbar: [3, 0, 0], thoracic: [3, 0, 0], cervical: [6, 0, 0] },
    joints: { hip_LR: [83], knee_LR: [82], head: [3], shoulder_LR: [-10, 12], elbow_LR: [85], forearm_LR: [10], wrist_LR: [10] },
    grips: { L: "relaxed", R: "relaxed" },
    support: "seat+feet",
    contacts: ["heel_sole_L","heel_sole_R"],
    hints: { seat: { height: "popliteal" }, externalSupport: "back rest", prop: { type: "office_chair", params: { recline: 10, armrests: true }, role: "support", note: "Back rest about 100 degrees to the seat pan, arm rests at elbow height." } },
  },
  {
    id: "sit-lumbar-supported-100",
    name: "Seated, lumbar supported (back rest 100)",
    category: "Sitting",
    tags: ["seat","office","lumbar","static","symmetric","back-rest","feet-on-floor"],
    description: "Sitting against a back rest at 100 degrees with the hollow of the lower back filled by a lumbar support, head level, hands resting on the thighs. The recommended office posture for long sitting: the back rest takes part of the weight and the lumbar curve is kept.",
    source: "illustrative; back rest 100 to 110 deg with a lumbar support after Andersson, Ortengren and Nachemson 1974-75 (lowest lumbar disc pressure) and ISO 9241-5; angles approx.",
    root: { flex: -6 },
    spine: { lumbar: [-7, 0, 0], cervical: [2, 0, 0] },
    joints: { hip_LR: [84], knee_LR: [88], shoulder_LR: [-10, 8, 20], elbow_LR: [75], forearm_LR: [50], wrist_LR: [15, 10] },
    grips: { L: "flat", R: "flat" },
    support: "seat+feet",
    contacts: ["heel_sole_L","heel_sole_R"],
    hints: { seat: { height: "popliteal" }, externalSupport: "back rest", prop: { type: "office_chair", params: { recline: 10, armrests: false }, role: "support", note: "Back rest about 100 degrees with the lumbar support at the waist." } },
  },
  {
    id: "sit-slumped",
    name: "Slumped sitting",
    category: "Sitting",
    tags: ["seat","slumped","slouch","static","symmetric","rula-high","feet-on-floor"],
    description: "The collapsed posture of long sitting: pelvis rolled back, lower and upper back rounded, shoulders forward, head poked out to look ahead, arms hanging. Shows what a seat does when it lets the sitter slide, and is the bad reference for lumbar and neck angles.",
    source: "illustrative; flexed lumbar and thoracic spine of slumped sitting after Pynt, Higgs and Mackey 2001 and Dolan and Adams, approx.; ISO 11226 neck flexion over 25 deg",
    root: { flex: -8 },
    spine: { lumbar: [24, 0, 0], thoracic: [26, 0, 0] },
    joints: { hip_LR: [83], knee_LR: [84], head: [-22], clavicle_LR: [0, 10], shoulder_LR: [6, 4], elbow_LR: [12], forearm_LR: [10] },
    grips: { L: "relaxed", R: "relaxed" },
    support: "seat+feet",
    contacts: ["heel_sole_L","heel_sole_R"],
    hints: { seat: { height: "popliteal" }, externalSupport: "back rest" },
  },
  {
    id: "sit-lean-forward-desk",
    name: "Seated, leaning forward to a desk",
    category: "Sitting",
    tags: ["seat","desk","forearms-supported","forward","two-hand","static","symmetric","feet-on-floor"],
    description: "Sitting forward of the back rest with the trunk inclined about 20 degrees, both forearms lying on the desk, head tilted to look down at the work. A reading, writing or drawing posture; the desk carries the arms and part of the trunk weight.",
    source: "illustrative; trunk 20 deg forward is the upper edge of ISO 11226 'acceptable without support' (0 to 20 deg), the forearm support makes 20 to 60 deg acceptable; neck flexion 25 to 30 deg approx.",
    root: { flex: 12 },
    spine: { lumbar: [8, 0, 0], thoracic: [10, 0, 0], cervical: [6, 0, 0] },
    joints: { hip_LR: [103], knee_LR: [90], head: [4], shoulder_LR: [40, 16, 10], elbow_LR: [90], forearm_LR: [40], wrist_LR: [15, 10] },
    grips: { L: "flat", R: "flat" },
    support: "seat+feet",
    hints: { seat: { height: "popliteal" }, externalSupport: "desk", prop: { type: "desk", params: { height: 0.74 }, role: "support", note: "Desk top about 0.3 m above the seat plane, forearms resting on it; the sandbox sets the height from the body." } },
  },
  {
    id: "sit-edge-of-seat",
    name: "On the edge of the seat",
    category: "Sitting",
    tags: ["seat","edge","alert","forward","static","symmetric","feet-on-floor"],
    description: "Perched on the front of the seat, trunk upright and a little forward, feet drawn back under the knees, hands on the knees: the ready or attentive posture, free of the back rest, used before getting up or while waiting.",
    source: "illustrative; knee about 100 deg, ankle dorsiflexed, trunk 8 deg forward",
    root: { flex: 5 },
    spine: { lumbar: [4, 0, 0], thoracic: [3, 0, 0] },
    joints: { hip_LR: [101], knee_LR: [105], ankle_LR: [-8], head: [-2], shoulder_LR: [0, 8, 20], elbow_LR: [90], forearm_LR: [30], wrist_LR: [15, 10] },
    grips: { L: "flat", R: "flat" },
    support: "seat+feet",
    hints: { seat: { height: "popliteal" } },
  },
];
