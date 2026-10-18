// Posture group "Reference". Covers the POSTURES.md category "Reference": ISO 7250-1 standing, ISO 7250-1 sitting, A-pose, T-pose,
// Vitruvian, NIOSH lift origin, NIOSH lift destination, RULA neutral. Written so far: the three examples that define the style of a posture
// (iso-7250-standing, iso-7250-sitting, t-pose); the rest is for later engineers. Typical support: "feet".
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4). Rules and checklist for authors: docs/human3d/POSTURES.md and POSE.md.
export default [
  {
    id: "iso-7250-standing",
    name: "Standing erect (ISO 7250-1)",
    category: "Reference",
    tags: ["iso-7250", "reference", "standing", "static", "symmetric"],
    description: "The standing measurement posture of ISO 7250-1: erect, looking straight ahead, shoulders relaxed, arms hanging at the sides, hands relaxed, feet flat. Every joint angle is 0, which is the neutral pose of the model; stature and the standing heights are measured in it.",
    source: "ISO 7250-1 (standing posture); the neutral pose of skeleton.js / fit.js",
    support: "feet",
    grips: { L: "relaxed", R: "relaxed" },
  },
  {
    id: "iso-7250-sitting",
    name: "Seated upright (ISO 7250-1)",
    category: "Reference",
    tags: ["iso-7250", "reference", "seat", "static", "symmetric"],
    description: "The seated measurement posture of ISO 7250-1: trunk upright, thighs horizontal, knees at 90 degrees, lower legs vertical, feet flat on the floor, arms hanging. On a seat at popliteal height; sitting height, knee height and buttock-knee length are measured in it.",
    source: "ISO 7250-1 (sitting posture); the 'seat' reference posture of fit.js (hips 90, knees 90, ankles 0)",
    support: "seat+feet",
    joints: { hip_LR: [90, 0, 0], knee_LR: [90, 0] },
    grips: { L: "relaxed", R: "relaxed" },
    hints: { seat: { height: "popliteal" } },
  },
  {
    id: "t-pose",
    name: "T-pose",
    category: "Reference",
    tags: ["reference", "standing", "static", "symmetric", "calibration"],
    description: "Arms raised sideways to the horizontal, palms down, fingers straight, standing erect: the calibration pose of motion capture and the posture of the arm-span measurement. The neutral arm hangs abducted by 3 to 14 degrees, so 84 degrees of shoulder abduction is the horizontal arm of the median person (within 7 degrees, acromion to stylion, for every population median).",
    source: "common mocap and anthropometry reference; 84 deg = the median over the 176 population medians of the abduction that makes the arm horizontal (fit.js referencePose(body, 'tpose'): 79 to 87 deg, the exact angle per body)",
    support: "feet",
    joints: { shoulder_LR: [0, 84, 0] },
    grips: { L: "open", R: "open" },
  },
];
