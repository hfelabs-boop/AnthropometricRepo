// Hand-grip presets: finger and thumb joint angles for the LEFT hand in the DOF order of skeleton.js; the right hand uses the same
// numbers (anatomical convention, DESIGN.md 1.3). A posture selects one per hand with `grips: { L: "fist", R: "relaxed" }`; pose.js
// expandPosture() turns it into the 15 finger joints of that hand, and explicit entries in `posture.joints` override single joints.
//
// Sources and honesty. The finger shapes follow the textbook descriptions of the hand at rest and of the grasp types, quoted as
// typical joint angles (Kapandji "Physiology of the Joints" vol. 1: position of function and the grips; Napier 1956 "The prehensile
// movements of the human hand", J Bone Joint Surg 38B:902: power versus precision grip; Cutkosky 1989 "On grasp choice, grasp models
// and the design of hands for manufacturing tasks", IEEE Trans Robot Autom 5:269: grasp taxonomy; Sancho-Bru et al. 2003 measured
// finger joint angles in grasps of cylinders). The numbers themselves are rounded, plausible values written from those descriptions,
// NOT read from the originals: every angle is "approx." and a grip is a look-alike, not a measurement. They were checked against the
// ROM of skeleton.js (no clamping) and against the geometry of the model (tests/human3d/pose.test.mjs: a fist closes onto the palm, an
// open hand is straight and spread).
//
// Sign conventions (skeleton.js): MCP / PIP / DIP `flex` + curls toward the palm; MCP `abd` + is AWAY from the middle finger (radial for
// the index, ulnar for the ring and little finger; the middle finger's + is radial); thumb CMC `flex` + folds the thumb across the palm
// (toward the little finger), CMC `abd` + is palmar abduction (the thumb comes out of the plane of the palm, in front of it), thumb MCP
// and IP `flex` + curl toward the palm. At angle 0 the thumb is splayed about 22 degrees forward of the index finger (fit.js neutral hand).
const FINGERS = ["index", "middle", "ring", "little"];

// Compact row per grip: thumb [cmc flex, cmc abd, mcp flex, ip flex] and per finger [mcp flex, mcp abd, pip flex, dip flex].
function hand({ thumb, index, middle, ring, little }) {
  const j = { thumb_cmc: [thumb[0], thumb[1]], thumb_mcp: [thumb[2]], thumb_ip: [thumb[3]] };
  for (const [name, f] of Object.entries({ index, middle, ring, little })) {
    j[`${name}_mcp`] = [f[0], f[1]];
    j[`${name}_pip`] = [f[2]];
    j[`${name}_dip`] = [f[3]];
  }
  return j;
}

const G = {
  relaxed: {
    label: "Relaxed",
    description: "The resting hand: every finger joint half flexed, more toward the little finger (the 'cascade'), thumb slightly flexed in front of the palm.",
    source: "Kapandji, position of rest of the hand (approx.)",
    joints: hand({ thumb: [10, 15, 10, 10], index: [20, 0, 25, 10], middle: [28, 0, 32, 12], ring: [36, 0, 38, 14], little: [44, 0, 40, 16] }),
  },
  open: {
    label: "Open",
    description: "Fingers straight and slightly spread, thumb abducted away from the palm: a hand ready to take or release something.",
    source: "illustrative (fingers extended, spread about 5-10 deg)",
    joints: hand({ thumb: [0, 25, 0, 0], index: [0, 6, 0, 0], middle: [0, 0, 0, 0], ring: [0, 5, 0, 0], little: [0, 10, 0, 0] }),
  },
  flat: {
    label: "Flat",
    description: "Fingers straight and together, thumb alongside the index finger: a hand laid flat on a surface, a palm push, a salute.",
    source: "illustrative",
    joints: hand({ thumb: [20, 0, 0, 0], index: [0, 0, 0, 0], middle: [0, 0, 0, 0], ring: [0, 0, 0, 0], little: [0, 0, 0, 0] }),
  },
  fist: {
    label: "Fist",
    description: "All four fingers curled into the palm, the thumb folded across the middle phalanges: a closed hand (MCP about 90, PIP about 100, DIP about 70).",
    source: "Kapandji, fist; joint angles approx.",
    joints: hand({ thumb: [15, 38, 25, 40], index: [88, 0, 102, 68], middle: [90, 0, 104, 70], ring: [90, 0, 105, 72], little: [90, 0, 105, 75] }),
  },
  power: {
    label: "Power grip",
    description: "Cylindrical power grasp (Napier, Cutkosky 'medium wrap'): fingers wrapped around a handle of about 35 mm, thumb closing on the other side.",
    source: "Napier 1956; Cutkosky 1989; angles for a 35 mm cylinder approx.",
    joints: hand({ thumb: [0, 45, 30, 45], index: [50, 0, 70, 40], middle: [55, 0, 75, 42], ring: [58, 0, 78, 45], little: [60, 0, 80, 48] }),
  },
  precision: {
    label: "Precision grip",
    description: "Fingers holding a small object by the pads (Napier precision, Cutkosky 'prismatic 2-finger / tripod'): thumb opposed to the index and middle finger, ring and little finger tucked.",
    source: "Napier 1956; Cutkosky 1989; approx.",
    joints: hand({ thumb: [25, 35, 5, 10], index: [32, 0, 42, 22], middle: [40, 0, 46, 22], ring: [60, 0, 70, 30], little: [65, 0, 75, 32] }),
  },
  hook: {
    label: "Hook grip",
    description: "Fingers hooked over a bar or handle (a carrying handle, a pull-up bar): MCP nearly straight, PIP and DIP strongly flexed; the thumb is not used.",
    source: "Cutkosky 1989 'hook'; Kapandji; approx.",
    joints: hand({ thumb: [10, 10, 5, 5], index: [10, 0, 85, 55], middle: [12, 0, 88, 55], ring: [14, 0, 88, 55], little: [16, 0, 85, 52] }),
  },
  trigger: {
    label: "Trigger finger",
    description: "A pistol or tool grip: middle, ring and little finger wrapped around the handle, the index finger half flexed with its pad on the trigger, the thumb along the frame.",
    source: "illustrative (power grip with the index released)",
    joints: hand({ thumb: [10, 35, 20, 25], index: [22, 0, 38, 12], middle: [55, 0, 75, 42], ring: [58, 0, 78, 45], little: [60, 0, 80, 48] }),
  },
  point: {
    label: "Point",
    description: "Index finger extended, the other fingers curled into the palm and the thumb folded over them: pointing, pressing a button.",
    source: "illustrative",
    joints: hand({ thumb: [15, 38, 25, 40], index: [0, 0, 0, 0], middle: [88, 0, 102, 68], ring: [90, 0, 104, 70], little: [90, 0, 104, 72] }),
  },
  wheel: {
    label: "Wheel rim",
    description: "Fingers wrapped around a steering-wheel rim (about 30 mm): a lighter wrap than the power grip, the thumb resting around the rim.",
    source: "illustrative (power grip, less flexed); cf. SAE J1138 hand positions",
    joints: hand({ thumb: [0, 40, 20, 35], index: [42, 0, 60, 32], middle: [46, 0, 64, 34], ring: [50, 0, 68, 36], little: [54, 0, 70, 38] }),
  },
  pinch: {
    label: "Pinch",
    description: "Thumb and index finger pad to pad (tip pinch), the other fingers loosely curled: picking up a small part.",
    source: "Kapandji, pulp-to-pulp pinch; approx.",
    joints: hand({ thumb: [20, 35, 5, 10], index: [35, 0, 45, 25], middle: [50, 0, 60, 28], ring: [58, 0, 68, 30], little: [64, 0, 72, 32] }),
  },
  cup: {
    label: "Cupped",
    description: "A shallow C-shape, fingers spread and gently flexed, thumb opposed to them: holding a cup or a ball of about 70 mm (thumb tip about 50 mm from the index fingertip), or water.",
    source: "Cutkosky 1989 'sphere' / Kapandji spherical grip; approx.",
    joints: hand({ thumb: [10, 40, 0, 5], index: [28, 6, 30, 5], middle: [32, 0, 34, 6], ring: [34, 5, 34, 6], little: [37, 10, 34, 6] }),
  },
  thumbsup: {
    label: "Thumb up",
    description: "Fist with the thumb extended away from the palm: a thumbs-up, hitchhiking.",
    source: "illustrative",
    joints: hand({ thumb: [0, 20, 0, 0], index: [88, 0, 102, 68], middle: [90, 0, 104, 70], ring: [90, 0, 105, 72], little: [90, 0, 105, 75] }),
  },
  spread: {
    label: "Spread",
    description: "Fingers straight and spread as wide as the joints allow, thumb abducted: a stretched hand, a hand placed flat to take weight.",
    source: "skeleton.js ROM (abduction 20 deg at the MCP joints, used to 70 %)",
    joints: hand({ thumb: [0, 45, 0, 0], index: [0, 14, 0, 0], middle: [0, 0, 0, 0], ring: [0, 12, 0, 0], little: [0, 15, 0, 0] }),
  },
  tripod: {
    label: "Tripod",
    description: "Thumb, index and middle finger pads together (the grip on a pen, a key or a screwdriver tip), ring and little finger curled under.",
    source: "Cutkosky 1989 'writing tripod'; approx.",
    joints: hand({ thumb: [25, 35, 5, 8], index: [32, 0, 40, 20], middle: [45, 0, 55, 28], ring: [62, 0, 72, 32], little: [66, 0, 76, 34] }),
  },
  lateral: {
    label: "Key pinch",
    description: "Thumb pad against the side of the index finger, the other fingers curled: turning a key, holding a card.",
    source: "Kapandji, lateral pinch; approx.",
    joints: hand({ thumb: [0, 25, 15, 45], index: [60, 0, 80, 40], middle: [78, 0, 92, 55], ring: [84, 0, 96, 60], little: [86, 0, 98, 62] }),
  },
  spherical: {
    label: "Ball grip",
    description: "All five digits around a ball or a knob of about 60 mm (Cutkosky 'spherical'): fingers spread and moderately flexed, the thumb tip about 45 mm from the index and middle fingertips.",
    source: "Cutkosky 1989; Kapandji spherical grip; angles approx., tuned so that the thumb and fingertips span a 60 mm ball (pose.test.mjs)",
    joints: hand({ thumb: [18, 21, 12, 10], index: [48, 8, 52, 25], middle: [51, 0, 54, 26], ring: [53, 6, 54, 26], little: [55, 12, 54, 26] }),
  },
  typing: {
    label: "Keyboard",
    description: "Fingers gently curved over keys, slightly spread, thumb relaxed beside the index finger.",
    source: "illustrative",
    joints: hand({ thumb: [15, 10, 8, 8], index: [28, 3, 32, 14], middle: [30, 0, 36, 16], ring: [32, 3, 36, 16], little: [34, 6, 34, 15] }),
  },
  mouse: {
    label: "Mouse",
    description: "Hand resting on a computer mouse: fingers gently arched over the buttons, thumb pressing the side.",
    source: "illustrative",
    joints: hand({ thumb: [15, 30, 15, 12], index: [22, 0, 25, 10], middle: [28, 0, 32, 12], ring: [45, 0, 52, 22], little: [50, 0, 56, 24] }),
  },
};

/** Names of the presets, in display order. */
export const GRIP_NAMES = Object.keys(G);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

/** { name: { label, description, source, joints: { thumb_cmc: [flex, abd], ... } } } for the LEFT hand (the right hand uses the same values). Deeply frozen. */
export const GRIPS = deepFreeze(G);

/** The 15 finger joint ids of a hand without the side suffix, in table order: thumb_cmc, thumb_mcp, thumb_ip, index_mcp, ... little_dip. */
export const HAND_JOINTS = Object.freeze(["thumb_cmc", "thumb_mcp", "thumb_ip", ...FINGERS.flatMap((f) => [`${f}_mcp`, `${f}_pip`, `${f}_dip`])]);

/**
 * Joint angles of a grip for one hand: { thumb_cmc_L: [flex, abd], ... } (fresh arrays). side is "L" or "R". Throws for an unknown grip
 * or side (the message lists the valid names).
 */
export function gripAngles(name, side) {
  if (side !== "L" && side !== "R") throw new Error(`grip side must be "L" or "R", got ${JSON.stringify(side)}`);
  const g = Object.hasOwn(GRIPS, name) ? GRIPS[name] : null;
  if (!g) throw new Error(`unknown grip "${String(name).slice(0, 40)}" (known: ${GRIP_NAMES.join(", ")})`);
  const out = {};
  for (const [id, a] of Object.entries(g.joints)) out[`${id}_${side}`] = [...a];
  return out;
}
