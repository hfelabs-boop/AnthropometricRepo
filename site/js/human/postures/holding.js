// Posture group "Holding" (ids hold-*): the hands carry or aim something: a box at chest, waist or overhead, a bag at the side, a hammer, a drill, a tray,
// a phone or radio handset, binoculars, a tablet, a clipboard, a cup, a pistol (Isosceles and Weaver), a rifle (low ready, high ready, port arms, sling carry,
// shouldered aim), a shield, a joystick, a lever, a grab handle, an overhead bar, a flashlight, a screwdriver.
// Each posture names the object (hints.prop: catalog type, parameters, role, and the grip ids of that catalog type: the sandbox can close the hands on them with
// the inverse kinematics of ik.js) and says in the note where the object is for the median man. The arm and hand angles were solved with ik.js on the median man (US Army
// men, 50th percentile) for the real grips of catalog.js and rounded to whole degrees; the stance (legs, ankles) was tuned so that both soles lie flat on the floor of the
// 5th-percentile woman, the median man and the 95th-percentile man at once. A held mass goes in hints.load (the balance rule of the validator counts it).
// Not here: lifting and carrying (lifting.js), the rifle firing positions (military.js), hand tools at a workstation (work.js).
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors: docs/human3d/POSTURES.md and POSE.md.
// Support is "feet"; `contacts` lists the sole landmarks that must be on the floor.
const FEET = ["heel_sole_L", "heel_sole_R", "ball_sole_medial_L", "ball_sole_medial_R", "ball_sole_lateral_L", "ball_sole_lateral_R"];
export default [
  {
    id: "hold-box-chest",
    name: "Holding a box at chest height",
    category: "Holding",
    tags: ["hold", "box", "load", "two-hand", "chest", "static", "symmetric", "carry"],
    description: "Standing upright with a 10 kg box held in both hands against the chest, the elbows bent about ninety degrees and the trunk leaning back a few degrees to balance it. The way a box is carried over a short distance or held while looking for where to put it.",
    source: "illustrative; NIOSH recommends keeping the load close to the body (horizontal distance H of 25 cm at the origin)",
    support: "feet",
    spine: { lumbar: [-3, 0, 0] },
    joints: { hip_LR: [0, 7, -5], ankle_LR: [-1, 7, 0], head: [-2], clavicle_LR: [0], shoulder_LR: [-14, 23, 21], elbow_LR: [122], forearm_LR: [-14], wrist_LR: [-21, -8] },
    grips: { L: "flat", R: "flat" },
    contacts: FEET,
    hints: { load: { mass: 10 }, prop: { type: "crate", params: { width: 0.34, depth: 0.3, height: 0.25, mass: 10 }, role: "held", grips: { L: "side_left", R: "side_right" }, note: "box 0.34 x 0.3 x 0.25 m, 10 kg, its centre 1.22 m above the floor and 0.17 m in front of the chest of the median man" } },
  },
  {
    id: "hold-box-waist",
    name: "Holding a box at waist height",
    category: "Holding",
    tags: ["hold", "box", "load", "two-hand", "waist", "static", "symmetric", "carry"],
    description: "Standing upright with a 10 kg box held in both hands in front of the hips, the elbows bent about ninety degrees and the trunk leaning back a few degrees. The usual way to carry a light box: the load is close to the body and at the height of the hips, the lowest hand position that keeps the forearms horizontal.",
    source: "illustrative; NIOSH (Waters et al. 1993): vertical hand location 75 cm and horizontal distance 25 cm are the best for lifting",
    support: "feet",
    spine: { lumbar: [-4, 0, 0] },
    joints: { hip_LR: [0, 7, -5], ankle_LR: [-1, 7, 0], head: [-2], clavicle_LR: [-10, 11], shoulder_LR: [5, 2, -30], elbow_LR: [68], forearm_LR: [15], wrist_LR: [21, 20] },
    grips: { L: "flat", R: "flat" },
    contacts: FEET,
    hints: { load: { mass: 10 }, prop: { type: "crate", params: { width: 0.42, depth: 0.3, height: 0.25, mass: 10 }, role: "held", grips: { L: "side_left", R: "side_right" }, note: "box 0.42 x 0.3 x 0.25 m, 10 kg, its centre 0.99 m above the floor and 0.24 m in front of the abdomen of the median man" } },
  },
  {
    id: "hold-box-overhead",
    name: "Holding a box overhead",
    category: "Holding",
    tags: ["hold", "box", "load", "two-hand", "overhead", "static", "symmetric", "carry"],
    description: "Standing with a 5 kg box held in both hands above the head, the arms nearly straight and raised about 160 degrees, the trunk and neck leaning back a little. Placing a box on a high shelf or in a rack and holding it there; the posture of the end of an overhead lift.",
    source: "illustrative; NIOSH (Waters et al. 1993) limits the vertical hand location to 175 cm; ISO 11226 does not recommend upper arm elevation above 60 degrees for more than a short time",
    support: "feet",
    spine: { lumbar: [-6, 0, 0], thoracic: [-4, 0, 0] },
    joints: { hip_LR: [0, 7, -5], ankle_LR: [-1, 7, 0], head: [-6], clavicle_LR: [24, -25], shoulder_LR: [136, 39, 13], elbow_LR: [-5], forearm_LR: [-70], wrist_LR: [18, -30] },
    grips: { L: "flat", R: "flat" },
    contacts: FEET,
    hints: { load: { mass: 5 }, prop: { type: "crate", params: { width: 0.34, depth: 0.3, height: 0.25, mass: 5 }, role: "held", grips: { L: "side_left", R: "side_right" }, note: "box 0.34 x 0.3 x 0.25 m, 5 kg, its base 0.12 m above the head of the median man (1.87 m above the floor) and 0.12 m in front of it" } },
  },
  {
    id: "hold-bag-side",
    name: "Carrying a toolbox in the right hand",
    category: "Holding",
    tags: ["hold", "toolbox", "load", "one-hand", "side", "carry", "static", "asymmetric"],
    description: "Standing with an 8 kg toolbox hanging from the right hand beside the right leg, the trunk bent about three degrees to the left and the left arm held out a little to balance it. A bag, bucket or case carried at the side; the arm hangs straight, the grip is a hook of the fingers around the handle.",
    source: "illustrative; the lateral trunk bend of about 3 deg and the abducted counter-arm are the usual compensation for a load in one hand (compare ISO 11228-1 on asymmetric loads)",
    support: "feet",
    spine: { lumbar: [0, 3, 0], thoracic: [0, 2, 0] },
    joints: { hip_LR: [0, 7, -5], ankle_LR: [-1, 7, 0], shoulder_L: [0, 12, 0], elbow_L: [8], clavicle_R: [3], shoulder_R: [-6, 2, -1], elbow_R: [0], forearm_R: [1], wrist_R: [17, 12] },
    grips: { L: "relaxed", R: "hook" },
    contacts: FEET,
    hints: { load: { mass: 8, landmarks: ["grip_centre_R"] }, prop: { type: "toolbox", params: { length: 0.45, width: 0.2, height: 0.2, mass: 8 }, role: "held", grips: { R: "handle" }, note: "toolbox 0.45 x 0.2 x 0.2 m, 8 kg, hanging from the right hand: handle 0.8 m above the floor (the median man), beside the right thigh, its long side along the walking direction" } },
  },
  {
    id: "hold-hammer-ready",
    name: "Holding a hammer ready",
    category: "Holding",
    tags: ["hold", "hammer", "tool", "one-hand", "static", "asymmetric", "workshop"],
    description: "Standing square to the work with the right hand around the handle of a hammer held in front of the chest, the head of the hammer up and forward, the elbow bent a little more than a right angle, the left hand free. The posture before a blow or while looking at where to strike.",
    source: "illustrative",
    support: "feet",
    spine: { thoracic: [3, 0, 0] },
    joints: { hip_LR: [0, 7, -5], ankle_LR: [-1, 7, 0], head: [3], shoulder_L: [-58, 20, 18], shoulder_R: [-13, 22, 23], elbow_L: [105], elbow_R: [112], forearm_L: [0], forearm_R: [-30], wrist_L: [6, 4], wrist_R: [-2, -23], clavicle_LR: [1] },
    grips: { L: "relaxed", R: "power" },
    contacts: FEET,
    hints: { prop: { type: "hammer", params: { length: 0.33 }, role: "held", grips: { R: "handle" }, note: "claw hammer 0.33 m long, grip 1.12 m above the floor, 0.15 m to the right of the mid-line and 0.17 m in front of the chest, the head 55 degrees above the horizontal" } },
  },
];
