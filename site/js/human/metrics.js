// Ergonomic angles and distances of a posed body: the shared vocabulary of posture tests, the Analysis panel and (later) RULA / REBA-style indications.
// Docs: docs/human3d/METRICS.md (every quantity is defined there, the table is generated from METRIC_DEFS below). Pure: three, pose.js only; no DOM.
//
//   postureMetrics(body, pose, root, options?) -> flat object { trunkInclination, elbowAngle_L, ... }   (degrees; metres; null when undefined)
//   ergonomicFlags(metrics, options?)          -> [{ id, label, value, severity: "ok" | "caution" | "high", note }]   ISO 11226 static-posture limits
//   rebaInputs(metrics, options?)              -> the angle bands REBA reads, as plain data (no score)
//
// Conventions. World: +Y up, +Z anterior, +X the figure's left, floor y = 0, metres. "Forward" and "left" are the body's HEADING frame: the horizontal
// facing direction of the pelvis (from the hip line, with the pelvis anterior axis as the fallback when the body lies on its side). An inclination from the
// vertical is split into a forward (sagittal, positive forward) and a sideways part (positive toward the figure's left) along the direction of the lean.
// Included angles (elbow, knee, hip, ankle) are between two segments at a joint:
// 180 = straight line, except the ankle (90 = shank perpendicular to the sole). Everything is measured on the figure the rig draws (pose.js figureOf),
// on joint centres and the landmarks of fit.js (MODEL.md section 5), and so inherits the model's simplifications (rigid segments, approximate centres).
import * as THREE from "three";
import { figureOf, solvePose, placePose, centerOfMass, balance } from "./pose.js";

const R2D = 180 / Math.PI;
const nz = (x) => (x === 0 ? 0 : x);
const wrap180 = (d) => { const w = ((((d + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w; };
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------------------------------------------------
// The definitions: the single source of the names, of the table in METRICS.md and of the test that keeps them in step.
// sided: the key exists as key_L and key_R. type: "deg" | "m" | "bool" | "string". std: the relation to ISO 11226 / REBA / RULA.
const D = (group, key, sided, type, label, def, std = "") => ({ group, key, sided, type, label, def, std });
export const METRIC_DEFS = Object.freeze([
  D("Frame", "bodyHeading", false, "deg", "Facing direction", "Azimuth of the heading frame's forward axis about the world vertical, 0 = +Z, positive turning left (toward +X). It is the pelvis facing direction that every forward and left of this file refers to."),

  D("Trunk and pelvis", "trunkInclination", false, "deg", "Trunk inclination (forward)", "Forward (sagittal) part of the inclination from the world vertical of the trunk line mid-hip to C7: the line runs from the midpoint of the two hip joint centres to the C7/T1 joint centre (rig joint `C7`); the angle from the vertical is split along the direction of the lean (see Conventions), so a lean in the sagittal plane gives exactly its angle. Positive = the shoulders are ahead of the hips; lying supine = -90, prone = +90.", "ISO 11226 trunk inclination alpha (Table 1, forward positive); REBA / RULA trunk flexion. Model neutral: about -0.5 degrees (C7/T1 is 5 mm behind the hip centres), not subtracted as ISO's 'difference from the reference posture' would."),
  D("Trunk and pelvis", "thoraxInclination", false, "deg", "Thorax inclination (forward)", "Forward part of the inclination from the world vertical of the up axis of the T1 segment (rig joint `T1` frame, the orientation of the upper trunk). Unlike the chord `trunkInclination` it is additive: for movements in the sagittal plane it equals `root.flex` plus the lumbar and thoracic flexion totals, and it is exactly 0 in the neutral pose. A uniformly curved spine bent by X degrees turns the chord by about X/2 but the thorax by X.", "The orientation of the upper trunk; ISO 11226 / REBA do not name it, observers usually judge the chord."),
  D("Trunk and pelvis", "trunkInclinationSide", false, "deg", "Trunk inclination (sideways)", "Sideways (frontal) part of the same inclination of the trunk line, split as above. Positive = the shoulders are to the figure's left of the hips.", "Side bending of REBA / RULA when the pelvis is level; ISO 11226 Table 1 item 1 (symmetrical trunk posture) is `trunkLateralFlexion`."),
  D("Trunk and pelvis", "trunkInclinationTotal", false, "deg", "Trunk inclination (total)", "Angle between the trunk line and the world vertical, 0 to 180, in any direction (0 = upright, 90 = horizontal, 180 = upside down).", "The direction-free inclination (the ISO / NIOSH 'trunk bent more than X degrees from vertical')."),
  D("Trunk and pelvis", "trunkFlexionRelativeToPelvis", false, "deg", "Trunk flexion relative to the pelvis", "Angle of the trunk line in the sagittal plane of the PELVIS frame (the pelvis joint's own axes, so independent of how the pelvis is tilted): atan2 of the line's component along the pelvis anterior axis and along the pelvis up axis. Positive = bent forward over the pelvis. It is the lumbar plus thoracic flexion seen as one chord, so it is not the sum of the two (curvature baked into the neutral spine; neutral about -0.5 degrees).", "REBA / RULA trunk flexion when the pelvis is held fixed (sitting against a backrest)."),
  D("Trunk and pelvis", "trunkLateralFlexion", false, "deg", "Trunk lateral flexion (thorax vs pelvis)", "Lateral component, in the pelvis frame, of the up axis of the T1 segment (rig joint `T1`): atan2 of its component along the pelvis left axis and the pelvis up axis. Positive = the thorax is bent to the figure's left relative to the pelvis.", "ISO 11226 Table 1 item 1, Figure 1 (2): a symmetrical trunk posture has neither lateral flexion nor axial rotation of the thorax against the pelvis. The standard gives no number in the part that could be read."),
  D("Trunk and pelvis", "trunkTwist", false, "deg", "Trunk axial rotation (thorax vs pelvis)", "Twist angle about the pelvis up axis of the rotation from the pelvis frame to the T1 frame (swing-twist decomposition: the part of the thorax rotation that is a turn about the long axis). Positive = the thorax turns to the figure's left.", "ISO 11226 Table 1 item 1, Figure 1 (1); REBA / RULA 'trunk twisted'."),
  D("Trunk and pelvis", "pelvisTilt", false, "deg", "Pelvic tilt", "Angle of the line from the midpoint of the two PSIS to the midpoint of the two ASIS landmarks above the horizontal in the sagittal plane of the heading frame, positive when the ASIS is lower than the PSIS (anterior tilt, the clinical convention). It is a world angle: it changes with `root.flex` but not with the hip or lumbar angles. Model neutral: about 17 degrees anterior (clinical standing values 5 to 15).", "Not an ISO / REBA quantity. Seated slumping shows as a decrease from the neutral value."),
  D("Trunk and pelvis", "lumbarFlexion", false, "deg", "Lumbar flexion", "Sagittal angle of the L1 segment's up axis (rig joint `L1`, the whole lumbar chain L5 to L1 applied) in the pelvis frame: positive = forward bend. Zero is the natural standing lordosis, not a straight spine, exactly like the posture `spine.lumbar` flex total (equal to it when lateral bend and rotation are 0).", "Clinical lumbar flexion measured from the standing curve (not a Cobb angle)."),
  D("Trunk and pelvis", "thoracicFlexion", false, "deg", "Thoracic flexion", "Sagittal angle of the T1 segment's up axis (the whole thoracic chain T12 to T1 applied) in the L1 frame: positive = forward bend (kyphosis increasing). Zero is the natural standing kyphosis.", "As lumbarFlexion; equals the posture `spine.thoracic` flex total when lateral bend and rotation are 0."),

  D("Head and neck", "neckInclination", false, "deg", "Neck inclination (C7 to ear)", "Forward part of the inclination from the world vertical of the line from the C7 spinous process (landmark `cervicale`) to the midpoint of the two tragions, positive = the ear is ahead of C7. 90 minus this angle is the craniovertebral angle of the clinical literature. A descriptor of the head-neck geometry, not a deviation: in the neutral pose it is about 37 degrees (craniovertebral angle 53).", "Not the ISO / REBA neck angle: use `headInclination` and `neckFlexion` for those."),
  D("Head and neck", "neckFlexion", false, "deg", "Neck flexion (head relative to trunk)", "headInclination minus trunkInclination: the forward tilt of the head beyond that of the trunk. Positive = flexed (chin toward the chest), negative = extended.", "ISO 11226 Table 3 item 3 (neck flexion / extension = head inclination minus trunk inclination); REBA / RULA neck flexion (the model measures the head against the trunk line, 0 at the neutral pose)."),
  D("Head and neck", "headInclination", false, "deg", "Head inclination (forward)", "Forward part of the inclination from the world vertical of the head's up axis (rig joint `head` frame: the head's own vertical, with the Frankfurt plane horizontal in the neutral pose). Positive = nodding forward. Exactly 0 in the neutral pose.", "ISO 11226 head inclination beta (Table 3 item 2); the standard's Frankfurt plane is the model's neutral head orientation to within a few degrees."),
  D("Head and neck", "headTilt", false, "deg", "Head tilt (sideways)", "Sideways part of the inclination from the world vertical of the head's up axis (the ear line from the horizontal, seen from the front). Positive = the head tilts to the figure's left (left ear down).", "ISO 11226 / REBA 'head side bending' (world-referenced; see `neckSideBend` for the relative angle)."),
  D("Head and neck", "neckSideBend", false, "deg", "Neck side bend (head vs thorax)", "Lateral component, in the T1 frame, of the head's up axis: atan2 of its component along the T1 left axis and the T1 up axis. Positive = the head bends to the figure's left relative to the thorax.", "REBA 'neck side-bending' (+1 modifier)."),
  D("Head and neck", "neckTwist", false, "deg", "Neck axial rotation (head vs thorax)", "Twist angle about the T1 up axis of the rotation from the T1 frame to the head frame (swing-twist). Positive = the face turns to the figure's left relative to the thorax.", "REBA / RULA 'neck twisted' (+1 modifier)."),
  D("Head and neck", "gazeElevation", false, "deg", "Gaze elevation", "Elevation above the horizontal of the mean direction of the two eye axes (the +Z axis of the rig joints `eye_L` and `eye_R`): positive = looking up. It includes the eye rotation in the head, so a head tilted down and eyes turned up can give 0.", "Sight-line and display design (approx.): the relaxed line of sight is below the horizontal; ISO 11226 uses the Frankfurt plane as the neutral head."),

  D("Arm", "shrug", true, "deg", "Shoulder girdle elevation", "Elevation angle of the clavicle joint (rig `clavicle_{L,R}` `elev` DOF, read from the pose): positive = lateral end of the clavicle up (shoulder raised).", "REBA / RULA 'shoulder raised' (+1)."),
  D("Arm", "shoulderElevation", true, "deg", "Arm elevation relative to the trunk", "Angle between the upper arm (glenohumeral joint centre to elbow joint centre) and the trunk's down axis (the reverse of the trunk line): 0 = hanging along the trunk, 90 = at right angles to it, 180 = straight up along the trunk.", "REBA / RULA upper arm position (bands 20, 45, 90) when the trunk is upright; ISO 11226 arm elevation is measured from the world vertical: `upperArmInclination`."),
  D("Arm", "shoulderFlexion", true, "deg", "Shoulder flexion component", "Forward part of the arm elevation `shoulderElevation`, split along the direction the arm leans from the trunk's down axis in the TRUNK frame (up = the trunk line, left = the line between the two glenohumeral centres made perpendicular to it, forward = left x up). Positive = forward (flexion), negative = backward (extension). The same construction as the exponential-map swing of the shoulder joint, so for an arm moved only by the `flex` DOF it is that value plus the effect of the rest abduction of 3 to 14 degrees.", "REBA / RULA upper arm flexion / extension (extension more than 20 degrees scores like 20 to 45 flexion)."),
  D("Arm", "shoulderAbduction", true, "deg", "Shoulder abduction component", "Sideways part of the arm elevation, split as `shoulderFlexion`; positive = away from the midline, negative = across the body. It is not the `abd` DOF when the arm is raised in another plane (the neutral arm already has 3 to 14 degrees).", "REBA / RULA 'upper arm abducted' (+1); ISO 11226 annex: abduction is listed with the awkward arm postures."),
  D("Arm", "upperArmInclination", true, "deg", "Upper arm inclination from vertical", "Angle between the upper arm (glenohumeral joint centre to elbow joint centre) and the world's downward vertical, 0 to 180: 0 = hanging, 90 = horizontal, 180 = straight up. Independent of the trunk.", "ISO 11226 upper arm elevation (reference: the vertical through the shoulder; the standard draws the line through the acromio-clavicular and humero-radial joints, the model uses the glenohumeral and elbow centres, a few degrees different). The model's neutral arm hangs abducted by 3 to 14 degrees (MODEL.md 4.5), so this is that angle, not 0, in the neutral pose."),
  D("Arm", "upperArmInclinationSagittal", true, "deg", "Upper arm inclination, sagittal", "Forward part of `upperArmInclination` (the inclination from the downward vertical split along the lean direction in the heading frame). Positive = forward, negative = backward (extension).", "ISO 11226 arm elevation 'extension / flexion' (extension beyond 20 degrees is not recommended)."),
  D("Arm", "elbowAngle", true, "deg", "Elbow included angle", "Included angle at the elbow between the upper arm and the forearm (elbow joint centre to the shoulder and wrist joint centres): 180 = straight, 90 = right angle, less = more flexed.", "REBA / RULA lower arm flexion = 180 minus this angle (band 60 to 100 degrees of flexion = 80 to 120 here)."),
  D("Arm", "wristFlexion", true, "deg", "Wrist flexion", "The `flex` DOF of the wrist joint (read from the pose): positive = palmar flexion, negative = extension.", "REBA / RULA wrist flexion / extension (band 15 degrees either way)."),
  D("Arm", "wristDeviation", true, "deg", "Wrist deviation", "The `dev` DOF of the wrist joint (read from the pose): positive = radial deviation (thumb side), negative = ulnar.", "REBA / RULA 'wrist deviated' (+1)."),
  D("Arm", "forearmPronation", true, "deg", "Forearm pronation", "The `pron` DOF of the forearm joint (read from the pose): 0 = mid-position (thumb forward), positive = pronation (palm toward the floor), negative = supination.", "RULA wrist twist (extreme pronation / supination)."),
  D("Arm", "shoulderHeight", true, "m", "Shoulder (glenohumeral) height", "Height above the floor (y = 0) of the glenohumeral joint centre.", ""),
  D("Arm", "handHeightAboveFloor", true, "m", "Hand height above the floor", "Height above the floor (y = 0) of the palm centre (landmark `palm_centre`).", "Grip height for lifting and control placement (NIOSH 'vertical location V' uses the hands' grip point, close to this)."),
  D("Arm", "handToShoulderForward", true, "m", "Hand forward of the shoulder", "Component along the heading frame's forward axis of the vector from the glenohumeral joint centre to the palm centre. Positive = in front.", ""),
  D("Arm", "handToShoulderLateral", true, "m", "Hand left of the shoulder", "Component along the heading frame's left axis of the same vector. Positive = toward the figure's left (so the left hand held out sideways is positive, the right hand negative).", ""),
  D("Arm", "handToShoulderUp", true, "m", "Hand above the shoulder", "Vertical component of the same vector. Positive = the palm is above the shoulder joint.", "Overhead work indicator (the hand above the shoulder joint); the upper arm bands of REBA / RULA are `shoulderElevation`."),
  D("Arm", "handReach", true, "m", "Horizontal reach from the shoulder", "Horizontal distance between the glenohumeral joint centre and the palm centre (the length of the forward and lateral components together).", ""),
  D("Arm", "reachFromAnkles", true, "m", "Horizontal reach from the ankles", "Horizontal distance from the midpoint of the two ankle joint centres to the palm centre (the reach a stander can make without stepping; a seated reach is measured from the seat reference point instead, not from here).", "Reach envelopes of Pheasant and Haslegrave (Bodyspace) are given from a standing position or a seat reference point."),
  D("Arm", "handAboveShoulder", true, "bool", "Hand above shoulder", "true when `handToShoulderUp` is greater than 0.", "Overhead work indicator; ISO 11226 arm elevation above 60 degrees is the stricter test."),
  D("Arm", "handAboveHead", true, "bool", "Hand above head", "true when the palm centre is higher than the vertex landmark of the head.", "Overhead work: hands above the head (ISO 11228-3 lists upper arm elevation guidelines)."),
  D("Arm", "handAboveHeadBy", true, "m", "Palm height above the vertex", "Height of the palm centre minus height of the vertex; negative when the hand is below the top of the head.", ""),

  D("Leg", "hipAngle", true, "deg", "Hip included angle (trunk-thigh)", "Included angle at the hip between the trunk line (mid-hip toward C7) and the thigh (hip joint centre toward the knee joint centre): 180 = standing straight, 90 = sitting upright with the thigh horizontal, less = more flexed.", "Hip angle of the ISO 7250-1 seated posture (90 degrees); REBA 'legs' when sitting."),
  D("Leg", "thighInclination", true, "deg", "Thigh inclination from horizontal", "Elevation angle of the thigh (hip joint centre toward knee joint centre) above the horizontal: -90 = hanging straight down (standing), 0 = horizontal (ISO seated), positive = the knee is higher than the hip (low seat).", "ISO 7250-1 seated posture: thighs horizontal."),
  D("Leg", "kneeAngle", true, "deg", "Knee included angle", "Included angle at the knee between the thigh and the shank (knee joint centre toward the hip and ankle joint centres): 180 = straight, 90 = bent at a right angle. Knee flexion is 180 minus this angle. The model's neutral shank leans forward about the ankle (MODEL.md 4.1), so the neutral pose reads about 175 degrees, not 180: a flexion of 5 degrees, under every REBA band.", "REBA legs: knee flexion 30 to 60 (+1) and over 60 (+2); ISO 7250-1 seated knee 90."),
  D("Leg", "shankInclination", true, "deg", "Shank inclination from vertical", "Forward part of the inclination from the downward vertical of the shank (knee joint centre toward ankle joint centre), in the heading frame: 0 = vertical, positive = the foot is ahead of the knee, negative = the foot is behind it (kneeling on the heels = -90). The model's neutral shank leans forward about the ankle (the knee is ahead of the ankle, MODEL.md 4.1), about -5.7 degrees.", "ISO 7250-1 seated posture: lower leg vertical."),
  D("Leg", "ankleAngle", true, "deg", "Ankle included angle", "Included angle between the shank (ankle joint centre toward the knee) and the sole line (from the heel sole point `heel_sole` toward the middle of the two ball-of-foot sole points): 90 = the sole at right angles to the shank, over 90 = plantar flexion (toes down), under 90 = dorsiflexion. The neutral pose reads about 85 degrees, not 90: the shank leans forward about the ankle by the stance lean (MODEL.md 4.1) while the foot is flat. The sole line, not the ankle-to-toe line, because the neutral foot is flat on the floor.", "ISO 7250-1 seated posture: ankle 90; ISO 11226 extreme positions: plantar flexion over 20 / dorsiflexion over 50 (secondary source)."),
  D("Leg", "kneeHeight", true, "m", "Knee height", "Height above the floor (y = 0) of the top of the knee (landmark `knee_top`, the ISO 7250-1 'knee height' point).", "Knee clearance under a desk or console."),

  D("Whole body", "hipHeight", false, "m", "Hip height", "Mean height above the floor of the two greater trochanters (landmark `trochanterion`).", "Anthropometric trochanteric height (ISO 7250-1)."),
  D("Whole body", "pelvisHeight", false, "m", "Pelvis height", "Height above the floor of the pelvis joint, the midpoint of the two hip joint centres.", ""),
  D("Whole body", "eyeHeight", false, "m", "Eye height", "Height above the floor of the cyclopean eye point (landmark `eye_mid`).", "Eye point for sight lines and display placement (ISO 7250-1 eye height)."),
  D("Whole body", "seatHeight", false, "m", "Ischial plane height", "Mean height above the floor of the two ischial tuberosity points (landmarks `ischial_L`, `ischial_R`): the seat plane height when the posture sits on a seat; for a standing posture just the height of the sit bones.", "The seat plane of the seated measurement posture of ISO 7250-1 (popliteal height); no cushion compression."),
  D("Whole body", "footSeparationMediolateral", false, "m", "Foot separation, mediolateral", "Left ankle joint centre minus right ankle joint centre along the heading frame's left axis: positive for a normal stance (the left foot is on the left), negative when the feet are crossed.", ""),
  D("Whole body", "footSeparationAnteroposterior", false, "m", "Foot separation, anteroposterior", "Left ankle joint centre minus right ankle joint centre along the heading frame's forward axis: positive = the left foot is ahead.", "Step length of a stance or stride."),
  D("Whole body", "stanceWidth", false, "m", "Stance width", "Width of the base of support: the extent along the heading frame's left axis of the eight foot sole points of both feet (`heel_sole`, both `ball_sole`, `toe_sole`), from the outermost point of one foot to the outermost point of the other.", "Wide stance versus shoulder width (a stance of 1 to 1.5 shoulder widths is the usual stable lifting stance)."),
  D("Whole body", "stanceLength", false, "m", "Stance length", "The extent of the same eight points along the heading frame's forward axis: the foot length for feet side by side, more for a stride.", ""),
  D("Whole body", "comHeight", false, "m", "Centre of mass height", "Height above the floor of the whole-body centre of mass (segment masses and centres of de Leva 1996, as `centerOfMass` of pose.js). null for a body without segment masses.", ""),
  D("Whole body", "comOverBase", false, "m", "Centre of mass over the base of support", "Margin of the centre of mass, projected on the floor, to the edge of the convex hull of the floor contact points: foot sole points, knee front and shin points, palm centres and elbow points that are within 20 mm of the floor (y = 0). Positive = inside by that distance, negative = outside by that distance; null when nothing touches the floor or the body has no masses. A seated person with the feet on the floor has a negative margin (the seat carries the weight): pass `options.seatHeight` to add the ischial and thigh points that lie on a seat plane of that height.", "Static balance indication (pose.js balance); POSTURES.md rule 6."),
  D("Whole body", "weightShareLeft", false, "number", "Weight share on the left foot", "Estimated fraction (0 to 1) of the body weight carried by the left foot, from the position of the centre of mass between the two feet: the horizontal projection of the centre of mass on the line from the right to the left foot centre (mean of the foot's four sole points), clamped to 0 to 1; 0 or 1 when only one foot touches the floor; null when no foot touches it or the body has no masses. A statics estimate from geometry, not a force measurement.", ""),
  D("Whole body", "legSupport", false, "string", "Leg support", "Which foot carries the weight: `\"left\"` or `\"right\"` when only that foot is within 20 mm of the floor or weightShareLeft is at least 0.65 or at most 0.35; `\"both\"` otherwise; `\"none\"` when neither foot touches the floor; null for a body without masses and both feet down.", "REBA legs: bilateral weight bearing versus unilateral support."),
]);

/** The keys of the object `postureMetrics` returns, in order. */
export function metricKeys() {
  return METRIC_DEFS.flatMap((d) => (d.sided ? [`${d.key}_L`, `${d.key}_R`] : [d.key]));
}

/** The Markdown table of METRICS.md (generated, so the document cannot drift; tests/human3d/metrics.test.mjs compares it). */
export function metricsTable() {
  const esc = (s) => s.replace(/\|/g, "\\|");
  const unit = { deg: "degrees", m: "metres", bool: "boolean", string: "text", number: "0 to 1" };
  const out = ["| Key | Unit | Definition | Standards |", "| --- | --- | --- | --- |"];
  let group = "";
  for (const d of METRIC_DEFS) {
    if (d.group !== group) { group = d.group; out.push(`| **${group}** | | | |`); }
    out.push(`| \`${d.key}${d.sided ? "_L` / `_R" : ""}\` | ${unit[d.type]} | ${esc(d.def)} | ${esc(d.std)} |`);
  }
  return `${out.join("\n")}\n`;
}


// ---------------------------------------------------------------------------------------------------------------------
// Scratch (the function is synchronous and not re-entrant: nothing is allocated per call except the returned object and a few small arrays)
const vec = () => new THREE.Vector3();
const UP = vec().set(0, 1, 0);
let SG = 0, LT = 0; // outputs of incline() in postureMetrics
const FWD = vec(), LEFT = vec(), HL = vec(), HR = vec(), MID = vec(), TRUNK = vec(), C7 = vec(), LAT = vec();
const XP = vec(), YP = vec(), ZP = vec(), XT = vec(), YT = vec(), YL = vec(), ZL = vec(), HU = vec();
const TL = vec(), TF = vec(), SH = vec(), EL = vec(), WR = vec(), AV = vec(), PALM = vec(), K = vec(), AK = vec(), U1 = vec(), U2 = vec(), CR = vec();
const PA = vec(), PB = vec(), PC = vec(), PD = vec(), PE = vec(), PF = vec(), PG = vec();
const AL = vec(), AR = vec(), COM = vec();
const QA = new THREE.Quaternion(), QB = new THREE.Quaternion(), QR = new THREE.Quaternion();
const FLOOR_LM = ["heel_sole", "ball_sole_medial", "ball_sole_lateral", "toe_sole", "knee_front", "shin", "palm_centre", "olecranon"];
const SOLE_LM = ["heel_sole", "ball_sole_medial", "ball_sole_lateral", "toe_sole"];
const SEAT_LM = ["ischial", "thigh_under"];
const FLOOR_TOL = 0.02; // a contact point within 2 cm of y = 0 counts as touching the floor
const SHARE_BAND = [0.35, 0.65]; // weight share on the left foot: at most / at least these = one-legged

// landmark table of a body: id -> [joint id, offset] on the figure the rig draws
const TABLES = new WeakMap();
function tableOf(body) {
  const view = figureOf(body);
  let t = TABLES.get(body);
  if (t && t.view === view && t.landmarks === view.landmarks) return t;
  const lm = new Map();
  for (const [id, l] of Object.entries(view.landmarks ?? {})) lm.set(id, [l.joint, Array.from(l.offset).slice(0, 3)]);
  t = { view, landmarks: view.landmarks, lm, hasMasses: !!view.masses && Object.keys(view.masses).length > 0 };
  TABLES.set(body, t);
  return t;
}

// the included angle between two vectors in degrees (atan2 of the cross and dot products: exact near 0 and 180); null for a zero vector
const between = (a, b) => (a.lengthSq() < 1e-18 || b.lengthSq() < 1e-18 ? null : Math.atan2(CR.crossVectors(a, b).length(), a.dot(b)) * R2D);
// the included angle at P between the segments to Q and to R
const included = (p, q, r) => between(U1.subVectors(q, p), U2.subVectors(r, p));

// the twist about the `from` frame's up axis of the rotation that takes joint `from`'s frame to joint `to`'s frame (swing-twist, degrees, + left)
function twistAbout(kin, from, to) {
  kin.quaternion(from, QA).invert();
  kin.quaternion(to, QB);
  QR.multiplyQuaternions(QA, QB);
  if (QR.w < 0) { QR.x = -QR.x; QR.y = -QR.y; QR.z = -QR.z; QR.w = -QR.w; }
  return nz(2 * Math.atan2(QR.y, QR.w) * R2D);
}

/**
 * Metrics of a posed body: the flat object of METRICS.md. `pose` is { root?, angles } of pose.js (concrete joint ids, degrees); `root` the full root
 * { x, y, z, heading, flex, lat, rot } (placePose, rig.root). Without a root height the posture is first placed on the floor by its feet (placePose, support
 * `options.support`, default "feet"), so that heights are above y = 0.
 * options: { out: an object to fill instead of a new one (no allocation), support, seatHeight: m, a seat plane that comOverBase should count }.
 * Returns an object with the keys of metricKeys(): degrees, metres, booleans, one string; null where undefined. Throws what solvePose throws for a malformed
 * pose or root. About 0.1 ms on a laptop.
 */
export function postureMetrics(body, pose, root, options) {
  const o = options ?? {};
  if (!root || !Number.isFinite(root.y)) {
    const p = { ...pose, root: { ...(pose?.root ?? {}), ...(root ?? {}) } };
    root = placePose(body, p, { support: o.support ?? "feet" });
  }
  const T = tableOf(body);
  const kin = solvePose(body, pose, root);
  const m = o.out ?? {};
  const angles = pose.angles ?? {};
  const dof = (id, i) => { const a = angles[id]; const x = a ? a[i] : 0; return typeof x === "number" ? x : 0; };
  const pos = (id, dst) => kin.position(id, dst);
  const lm = (id, dst) => { const e = T.lm.get(id); return e ? kin.toWorld(e[0], e[1], dst) : null; };
  const axis = (joint, x, y, z, dst) => dst.set(x, y, z).applyQuaternion(kin.quaternion(joint, QA));

  // ---- the heading frame: forward = the horizontal facing direction of the pelvis, left = up x forward
  pos("hip_L", HL); pos("hip_R", HR);
  MID.addVectors(HL, HR).multiplyScalar(0.5);
  LAT.subVectors(HL, HR).normalize(); // pelvis lateral axis, toward the left hip
  axis("pelvis", 1, 0, 0, XP); axis("pelvis", 0, 1, 0, YP); axis("pelvis", 0, 0, 1, ZP);
  const fx1 = -LAT.z, fz1 = LAT.x; // lateral axis x up: horizontal, as long as the hip line is horizontal (0 when the body lies on its side)
  FWD.set(fx1 + ZP.x, 0, fz1 + ZP.z); // plus the pelvis anterior axis, horizontal part (0 when it points up or down, as when lying on the back)
  if (FWD.lengthSq() < 1e-6) { // upside down: either one, else the root heading
    if (fx1 * fx1 + fz1 * fz1 > 1e-12) FWD.set(fx1, 0, fz1);
    else if (ZP.x * ZP.x + ZP.z * ZP.z > 1e-12) FWD.set(ZP.x, 0, ZP.z);
    else { const h = (root.heading ?? 0) / R2D; FWD.set(Math.sin(h), 0, Math.cos(h)); }
  }
  FWD.normalize();
  LEFT.set(FWD.z, 0, -FWD.x);
  // the angle theta of a vector from the vertical (the up axis, or the down axis when `dn`), split along the direction it leans: sagittal = theta cos(azimuth),
  // lateral = theta sin(azimuth), azimuth = atan2(left, forward) component. For a lean in one plane this is that plane's angle; for a mixed lean it is
  // well defined (a projected angle blows up when the vector is horizontal and its projection is ill-conditioned). Results in SG and LT, theta returned.
  const incline = (u, dn = false, fwd = FWD, left = LEFT, up = UP) => {
    const f = u.dot(fwd), l = u.dot(left), h = Math.hypot(f, l);
    const th = Math.atan2(h, dn ? -u.dot(up) : u.dot(up)) * R2D;
    if (h < 1e-12) { SG = 0; LT = 0; } else { SG = (th * f) / h; LT = (th * l) / h; }
    return th;
  };
  m.bodyHeading = nz(Math.atan2(FWD.x, FWD.z) * R2D);

  // ---- trunk and pelvis
  pos("C7", C7);
  TRUNK.subVectors(C7, MID).normalize();
  m.trunkInclinationTotal = incline(TRUNK);
  const tInc = SG;
  m.trunkInclination = tInc;
  m.trunkInclinationSide = LT;
  m.trunkFlexionRelativeToPelvis = Math.atan2(TRUNK.dot(ZP), TRUNK.dot(YP)) * R2D;
  axis("T1", 0, 1, 0, YT);
  incline(YT);
  m.thoraxInclination = SG;
  m.trunkLateralFlexion = Math.atan2(YT.dot(XP), YT.dot(YP)) * R2D;
  m.trunkTwist = twistAbout(kin, "pelvis", "T1");
  axis("T1", 1, 0, 0, XT);
  axis("L1", 0, 1, 0, YL); axis("L1", 0, 0, 1, ZL);
  m.lumbarFlexion = Math.atan2(YL.dot(ZP), YL.dot(YP)) * R2D;
  m.thoracicFlexion = Math.atan2(YT.dot(ZL), YT.dot(YL)) * R2D;
  m.pelvisTilt = null;
  if (lm("ASIS_L", PA) && lm("ASIS_R", PB) && lm("PSIS_L", PC) && lm("PSIS_R", PD)) {
    PE.addVectors(PA, PB).sub(PC).sub(PD).multiplyScalar(0.5); // from the mid PSIS to the mid ASIS
    m.pelvisTilt = Math.atan2(-PE.y, PE.dot(FWD)) * R2D;
  }

  // ---- head and neck
  axis("head", 0, 1, 0, HU);
  incline(HU);
  const hInc = SG;
  m.headInclination = hInc;
  m.headTilt = LT;
  m.neckFlexion = hInc - tInc;
  m.neckSideBend = Math.atan2(HU.dot(XT), HU.dot(YT)) * R2D;
  m.neckTwist = twistAbout(kin, "T1", "head");
  m.neckInclination = null;
  if (lm("cervicale", PA) && lm("tragion_L", PB) && lm("tragion_R", PC)) {
    PD.addVectors(PB, PC).multiplyScalar(0.5).sub(PA);
    incline(PD);
    m.neckInclination = SG;
  }
  axis("eye_L", 0, 0, 1, PA); axis("eye_R", 0, 0, 1, PB);
  PA.add(PB);
  m.gazeElevation = PA.lengthSq() > 1e-12 ? Math.atan2(PA.y, Math.hypot(PA.x, PA.z)) * R2D : null;

  // ---- arms. The trunk frame: up = the trunk line, left = the glenohumeral line made perpendicular to it, forward = left x up.
  pos("shoulder_L", AL); pos("shoulder_R", AR);
  TL.subVectors(AL, AR);
  TL.addScaledVector(TRUNK, -TL.dot(TRUNK)).normalize();
  TF.crossVectors(TL, TRUNK);
  pos("ankle_L", PA); pos("ankle_R", PB);
  PC.addVectors(PA, PB).multiplyScalar(0.5); // mid-ankle
  const vertexY = lm("vertex", PD) ? PD.y : null;
  for (const s of ["L", "R"]) {
    pos(`shoulder_${s}`, SH); pos(`elbow_${s}`, EL); pos(`wrist_${s}`, WR);
    AV.subVectors(EL, SH);
    m[`shrug_${s}`] = dof(`clavicle_${s}`, 0);
    m[`wristFlexion_${s}`] = dof(`wrist_${s}`, 0);
    m[`wristDeviation_${s}`] = dof(`wrist_${s}`, 1);
    m[`forearmPronation_${s}`] = dof(`forearm_${s}`, 0);
    // arm against the trunk frame
    m[`shoulderElevation_${s}`] = incline(AV, true, TF, TL, TRUNK); // from the trunk's down axis
    m[`shoulderFlexion_${s}`] = SG;
    m[`shoulderAbduction_${s}`] = s === "L" ? LT : -LT;
    // arm against the world
    m[`upperArmInclination_${s}`] = incline(AV, true);
    m[`upperArmInclinationSagittal_${s}`] = SG;
    m[`elbowAngle_${s}`] = included(EL, SH, WR);
    m[`shoulderHeight_${s}`] = SH.y;
    if (lm(`palm_centre_${s}`, PALM)) {
      PE.subVectors(PALM, SH);
      m[`handHeightAboveFloor_${s}`] = PALM.y;
      m[`handToShoulderForward_${s}`] = PE.dot(FWD);
      m[`handToShoulderLateral_${s}`] = PE.dot(LEFT);
      m[`handToShoulderUp_${s}`] = PE.y;
      m[`handReach_${s}`] = Math.hypot(PE.x, PE.z);
      m[`reachFromAnkles_${s}`] = Math.hypot(PALM.x - PC.x, PALM.z - PC.z);
      m[`handAboveShoulder_${s}`] = PE.y > 1e-6;
      m[`handAboveHead_${s}`] = vertexY !== null && PALM.y > vertexY + 1e-6;
      m[`handAboveHeadBy_${s}`] = vertexY !== null ? PALM.y - vertexY : null;
    } else {
      for (const k of ["handHeightAboveFloor", "handToShoulderForward", "handToShoulderLateral", "handToShoulderUp", "handReach", "reachFromAnkles", "handAboveHeadBy"]) m[`${k}_${s}`] = null;
      m[`handAboveShoulder_${s}`] = false; m[`handAboveHead_${s}`] = false;
    }
  }

  // ---- legs
  for (const s of ["L", "R"]) {
    const hip = s === "L" ? HL : HR;
    pos(`knee_${s}`, K); pos(`ankle_${s}`, AK);
    AV.subVectors(K, hip); // thigh
    m[`hipAngle_${s}`] = between(TRUNK, AV);
    m[`thighInclination_${s}`] = Math.atan2(AV.y, Math.hypot(AV.x, AV.z)) * R2D;
    m[`kneeAngle_${s}`] = included(K, hip, AK);
    EL.subVectors(AK, K); // shank
    incline(EL, true);
    m[`shankInclination_${s}`] = SG;
    m[`ankleAngle_${s}`] = null;
    if (lm(`heel_sole_${s}`, PE) && lm(`ball_sole_medial_${s}`, PF) && lm(`ball_sole_lateral_${s}`, PG)) {
      PF.add(PG).multiplyScalar(0.5).sub(PE); // sole line: heel to the middle of the ball
      m[`ankleAngle_${s}`] = between(WR.subVectors(K, AK), PF);
    }
    m[`kneeHeight_${s}`] = lm(`knee_top_${s}`, PE) ? PE.y : null;
  }

  // ---- whole body
  m.hipHeight = lm("trochanterion_L", PA) && lm("trochanterion_R", PB) ? (PA.y + PB.y) / 2 : null;
  m.pelvisHeight = MID.y;
  m.eyeHeight = lm("eye_mid", PA) ? PA.y : null;
  m.seatHeight = lm("ischial_L", PA) && lm("ischial_R", PB) ? (PA.y + PB.y) / 2 : null;
  pos("ankle_L", PA); pos("ankle_R", PB);
  PC.subVectors(PA, PB);
  m.footSeparationMediolateral = PC.dot(LEFT);
  m.footSeparationAnteroposterior = PC.dot(FWD);
  // the eight sole points: extents along the heading axes, the lowest point and the centre of each foot
  let minL = Infinity, maxL = -Infinity, minF = Infinity, maxF = -Infinity, have = true;
  const foot = { L: { y: Infinity, x: 0, z: 0, n: 0 }, R: { y: Infinity, x: 0, z: 0, n: 0 } };
  for (const s of ["L", "R"]) {
    for (const id of SOLE_LM) {
      if (!lm(`${id}_${s}`, PE)) { have = false; continue; }
      const l = PE.dot(LEFT), f = PE.dot(FWD), ft = foot[s];
      if (l < minL) minL = l; if (l > maxL) maxL = l; if (f < minF) minF = f; if (f > maxF) maxF = f;
      if (PE.y < ft.y) ft.y = PE.y;
      ft.x += PE.x; ft.z += PE.z; ft.n++;
    }
  }
  m.stanceWidth = have ? maxL - minL : null;
  m.stanceLength = have ? maxF - minF : null;
  m.comHeight = null; m.comOverBase = null; m.weightShareLeft = null; m.legSupport = null;
  const down = { L: foot.L.n > 0 && foot.L.y <= FLOOR_TOL, R: foot.R.n > 0 && foot.R.y <= FLOOR_TOL };
  if (T.hasMasses) {
    centerOfMass(body, pose, root, COM);
    m.comHeight = COM.y;
    // base of support: floor contact points (and the points on a seat plane when options.seatHeight is given)
    const pts = [];
    const take = (id) => { if (lm(id, PE) && (PE.y <= FLOOR_TOL || (o.seatHeight != null && Math.abs(PE.y - o.seatHeight) <= FLOOR_TOL && SEAT_LM.some((q) => id.startsWith(q))))) pts.push([PE.x, PE.y, PE.z]); };
    for (const base of FLOOR_LM) { take(`${base}_L`); take(`${base}_R`); }
    if (o.seatHeight != null) for (const base of SEAT_LM) { take(`${base}_L`); take(`${base}_R`); }
    if (pts.length) m.comOverBase = balance(body, pose, root, pts).margin;
    // the weight share of the feet: the centre of mass projected on the line between the two foot centres
    if (down.L || down.R) {
      let share;
      if (down.L && down.R) {
        const fl = foot.L, fr = foot.R;
        const dx = fl.x / fl.n - fr.x / fr.n, dz = fl.z / fl.n - fr.z / fr.n, d2 = dx * dx + dz * dz;
        share = d2 < 4e-4 ? 0.5 : clamp(((COM.x - fr.x / fr.n) * dx + (COM.z - fr.z / fr.n) * dz) / d2, 0, 1);
      } else share = down.L ? 1 : 0;
      m.weightShareLeft = share;
      m.legSupport = !down.R ? "left" : !down.L ? "right" : share >= SHARE_BAND[1] ? "left" : share <= SHARE_BAND[0] ? "right" : "both";
    } else m.legSupport = "none";
  } else if (!down.L && !down.R) m.legSupport = "none";
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// ISO 11226 indications
/**
 * The limits ergonomicFlags applies, as data. `status`: "verified" = read from the standard's own text (the free ISO 11226:2000 preview, Table 1) or from a
 * report that reproduces its table (Perosh 2018, Table 8.1 for the arm); "approx." = from secondary sources or a working tolerance of this model.
 */
export const ISO_11226 = Object.freeze({
  slackDeg: 2, // tolerance on every limit at 0 degrees: the model's neutral trunk line is -0.5 degrees, so "below 0" must not flag the neutral pose
  trunk: { acceptable: 20, notRecommended: 60, status: "verified (ISO 11226:2000 Table 1)", holding: "Table 2 / Figure 4 of the standard (not reproduced)" },
  trunkSymmetry: { cautionDeg: 10, highDeg: 20, status: "approx. (Table 1 item 1 gives no number in the readable text)" },
  head: { acceptable: 25, notRecommended: 85, status: "approx. (Table 3 item 2, from two application papers that quote the standard, PMC9696528 and PMC11939344; the table itself is not in the free preview)" },
  neck: { acceptable: 25, notRecommended: 40, status: "approx. (Table 3 item 3: 25 from secondary sources, 40 from one application study)" },
  upperArm: { acceptable: 20, notRecommended: 60, extension: 20, holdingMinutes: { 20: 4, 40: 2.5, 60: 1 }, status: "verified (Perosh 2018 Table 8.1, a report that reproduces the ISO 11226 table)" },
  elbow: { flexionRange: [60, 100], status: "REBA / RULA lower arm band (verified); ISO 11226 only lists extreme positions" },
  wrist: { flexionDeg: 15, deviationDeg: 10, status: "REBA / RULA 15 degrees (verified); the 10 degree deviation tolerance is approx." },
  knee: { cautionDeg: 30, highDeg: 60, status: "REBA legs (verified); ISO 11226 lists extreme knee flexion without a number in the readable text" },
});
const TAIL = " An indication for static postures (held longer than 4 s), not a risk assessment.";
const slack = ISO_11226.slackDeg;
const flag = (id, label, value, severity, note) => ({ id, label, value, severity, note: note + TAIL });
const fmt = (x) => `${Math.round(x * 10) / 10}`;

/**
 * Indications from the static-posture limits of ISO 11226:2000 (trunk, head, neck, upper arm) and the REBA / RULA neutral ranges (elbow, wrist, knee).
 * `metrics` is the result of postureMetrics. options: { trunkSupport, headSupport: true when a backrest, table or headrest carries the segment's weight
 * (ISO "full trunk / head support"); armSupport: true, false or { L, R }; seated: true when the legs are in a seated posture (default: the centre of mass is
 * more than 40 mm outside the floor base of support, or nothing touches the floor) }.
 * Returns [{ id, label, value, severity: "ok" | "caution" | "high", note }]; a flag whose metric is null is left out. "caution" = conditional (ISO "go to step 2":
 * acceptable for a limited holding time, or only with support); "high" = not recommended.
 */
export function ergonomicFlags(metrics, options) {
  const o = options ?? {}, m = metrics, out = [];
  const trunk = m.trunkInclination;
  if (trunk != null) {
    const sup = o.trunkSupport;
    let sev, note;
    if (trunk > ISO_11226.trunk.notRecommended) [sev, note] = ["high", `Forward inclination ${fmt(trunk)} degrees: over 60 degrees is not recommended (ISO 11226 Table 1).`];
    else if (trunk > ISO_11226.trunk.acceptable) [sev, note] = sup === true ? ["ok", `${fmt(trunk)} degrees forward with full trunk support: acceptable (Table 1).`] : ["caution", `${fmt(trunk)} degrees forward: 20 to 60 degrees without full trunk support needs the holding time limit of Table 2 (step 2).`];
    else if (trunk >= -slack) [sev, note] = ["ok", `${fmt(trunk)} degrees: 0 to 20 degrees is acceptable (Table 1).`];
    else [sev, note] = sup === true ? ["ok", `${fmt(trunk)} degrees backward with full trunk support (a backrest): acceptable (Table 1).`] : sup === false ? ["high", `${fmt(trunk)} degrees backward without full trunk support: not recommended (Table 1).`] : ["caution", `${fmt(trunk)} degrees backward: acceptable with full trunk support (a backrest), not recommended without it (Table 1).`];
    out.push(flag("trunk-inclination", "Trunk inclination", trunk, sev, note));
  }
  const asym = m.trunkLateralFlexion != null && m.trunkTwist != null ? Math.max(Math.abs(m.trunkLateralFlexion), Math.abs(m.trunkTwist)) : null;
  if (asym !== null) {
    const c = ISO_11226.trunkSymmetry;
    out.push(flag("trunk-symmetry", "Trunk symmetry (lateral flexion, rotation)", asym, asym > c.highDeg ? "high" : asym > c.cautionDeg ? "caution" : "ok",
      `Lateral flexion ${fmt(m.trunkLateralFlexion)} and axial rotation ${fmt(m.trunkTwist)} degrees of the thorax against the pelvis: ISO 11226 Table 1 item 1 calls an asymmetrical trunk posture not recommended; the ${c.cautionDeg} and ${c.highDeg} degree thresholds are approx.`));
  }
  const head = m.headInclination;
  if (head != null) {
    const h = ISO_11226.head;
    let sev, note;
    if (head > h.notRecommended) [sev, note] = ["high", `Head inclined ${fmt(head)} degrees: over 85 degrees is not recommended (ISO 11226 Table 3, approx.).`];
    else if (head > h.acceptable) [sev, note] = o.trunkSupport === true ? ["ok", `Head inclined ${fmt(head)} degrees with full trunk support: acceptable (Table 3, approx.).`] : ["caution", `Head inclined ${fmt(head)} degrees: 25 to 85 degrees needs the holding time of Table 4 (step 2; Table 3, approx.).`];
    else if (head >= -slack) [sev, note] = ["ok", `Head inclined ${fmt(head)} degrees: 0 to 25 degrees is acceptable (Table 3, approx.).`];
    else [sev, note] = o.headSupport === true ? ["ok", `Head tilted back ${fmt(-head)} degrees with full head support: acceptable (Table 3, approx.).`] : ["high", `Head tilted back ${fmt(-head)} degrees without full head support: not recommended (Table 3, approx.).`];
    out.push(flag("head-inclination", "Head inclination", head, sev, note));
  }
  const neck = m.neckFlexion;
  if (neck != null) {
    const n = ISO_11226.neck;
    const sev = neck > n.notRecommended ? "high" : neck > n.acceptable ? "caution" : neck < -slack ? "caution" : "ok";
    out.push(flag("neck-flexion", "Neck flexion (head against trunk)", neck, sev,
      neck < -slack ? `Neck extended ${fmt(-neck)} degrees against the trunk: extension is not neutral (ISO 11226 Table 3 item 3, approx.).` : `Neck flexed ${fmt(neck)} degrees against the trunk: 0 to 25 degrees is the neutral range of ISO 11226 Table 3 item 3 and REBA (approx.).`));
  }
  const sup = (s) => (o.armSupport != null && typeof o.armSupport === "object" ? o.armSupport[s] === true : o.armSupport === true);
  for (const s of ["L", "R"]) {
    const el = m[`upperArmInclination_${s}`], sagA = m[`upperArmInclinationSagittal_${s}`], a = ISO_11226.upperArm;
    if (el != null) {
      let sev, note;
      if (el > a.notRecommended) [sev, note] = ["high", `Upper arm ${fmt(el)} degrees from the vertical: over 60 degrees is not recommended (ISO 11226, arm elevation).`];
      else if (sagA < -a.extension && el > a.extension) [sev, note] = ["high", `Upper arm extended ${fmt(-sagA)} degrees behind the vertical: extension over 20 degrees is not recommended (ISO 11226, arm elevation).`];
      else if (el > a.acceptable) [sev, note] = sup(s) ? ["ok", `Upper arm ${fmt(el)} degrees with full arm support: acceptable (ISO 11226).`] : ["caution", `Upper arm ${fmt(el)} degrees: 20 to 60 degrees without full arm support is limited in holding time (about 4 min at 20, 2.5 min at 40, 1 min at 60 degrees).`];
      else [sev, note] = ["ok", `Upper arm ${fmt(el)} degrees from the vertical: up to 20 degrees is acceptable (ISO 11226).`];
      out.push(flag(`upper-arm-elevation-${s}`, `Upper arm elevation (${s === "L" ? "left" : "right"})`, el, sev, note));
    }
  }
  for (const s of ["L", "R"]) {
    const side = s === "L" ? "left" : "right";
    const ea = m[`elbowAngle_${s}`];
    if (ea != null) {
      const fl = 180 - ea, [lo, hi] = ISO_11226.elbow.flexionRange, hanging = (m[`upperArmInclination_${s}`] ?? 180) < ISO_11226.upperArm.acceptable;
      out.push(flag(`elbow-${s}`, `Elbow flexion (${side})`, fl, hanging || (fl >= lo && fl <= hi) ? "ok" : "caution",
        hanging ? `Elbow flexed ${fmt(fl)} degrees with the arm hanging: the lower arm band of REBA and RULA (60 to 100 degrees) is not applied to an arm at rest.` : `Elbow flexed ${fmt(fl)} degrees: 60 to 100 degrees is the neutral lower arm band of REBA and RULA.`));
    }
    const wf = m[`wristFlexion_${s}`], wd = m[`wristDeviation_${s}`], w = ISO_11226.wrist;
    if (wf != null) out.push(flag(`wrist-flexion-${s}`, `Wrist flexion / extension (${side})`, wf, Math.abs(wf) <= w.flexionDeg ? "ok" : "caution",
      `Wrist ${wf >= 0 ? "flexed" : "extended"} ${fmt(Math.abs(wf))} degrees: within 15 degrees of neutral is the REBA / RULA band.`));
    if (wd != null) out.push(flag(`wrist-deviation-${s}`, `Wrist deviation (${side})`, wd, Math.abs(wd) <= w.deviationDeg ? "ok" : "caution",
      `Wrist deviated ${fmt(Math.abs(wd))} degrees ${wd >= 0 ? "radially" : "ulnarly"}: REBA and RULA add a point for any deviation from the midline (the ${w.deviationDeg} degree tolerance is approx.).`));
  }
  const seated = o.seated ?? (m.comOverBase == null || m.comOverBase < -0.04);
  for (const s of ["L", "R"]) {
    const ka = m[`kneeAngle_${s}`];
    if (ka == null) continue;
    const fl = 180 - ka, k = ISO_11226.knee;
    const sev = seated ? "ok" : fl > k.highDeg ? "high" : fl > k.cautionDeg ? "caution" : "ok";
    out.push(flag(`knee-flexion-${s}`, `Knee flexion (${s === "L" ? "left" : "right"})`, fl, sev,
      seated ? `Knee flexed ${fmt(fl)} degrees while the weight is not on the feet (seated): REBA does not score knee flexion in sitting.` : `Knee flexed ${fmt(fl)} degrees on the feet: REBA adds 1 for 30 to 60 and 2 for over 60 degrees (squatting and kneeling are to be avoided, ISO 11226 3.1).`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// REBA angle bands
/**
 * The angle bands of REBA (Hignett and McAtamney 2000, Applied Ergonomics 31:201-205) as data, with where each edge was checked. No scores or tables.
 * Edges verified against the Ergonautas REBA help page and the worksheet of Hedge (ergo-plus.com); the RULA values are those of McAtamney and Corlett 1993
 * as given by Ergonautas. `approx`: numbers REBA does not give (it says "twisted", "abducted", "raised" without an angle).
 */
export const REBA_BANDS = Object.freeze({
  trunk: ["upright (0)", "0-20 flexion or extension", "20-60 flexion, or extension over 20", "over 60 flexion"],
  neck: ["0-20 flexion", "over 20 flexion, or extension"],
  legs: ["knee flexion under 30", "30-60", "over 60 (not when seated)"],
  upperArm: ["20 extension to 20 flexion", "extension over 20, or 20-45 flexion", "45-90 flexion", "over 90 flexion"],
  lowerArm: ["60-100 flexion", "under 60 or over 100"],
  wrist: ["0-15 flexion or extension", "over 15"],
  approx: { upright: 2, twistDeg: 10, sideBendDeg: 10, abductedDeg: 45, shoulderRaisedDeg: 10, wristDeviationDeg: 10, wristTwistDeg: 45, legsSeatedMarginM: -0.04 },
});

/**
 * The angles REBA reads and the band each falls in, as plain data (no score, no tables). `bandIndex` is the position in the REBA_BANDS list of the segment.
 * Trunk, neck and upper arm use the model's definitions (METRICS.md): trunk = trunkInclination, neck = neckFlexion, upper arm = the arm against the trunk
 * (extension when it points behind rather than to the side), lower arm = 180 minus elbowAngle, wrist = wristFlexion, knee flexion = 180 minus kneeAngle.
 * The modifiers REBA states without a number (twist, side bend, abducted, shoulder raised, wrist deviated or twisted) are given as the angle and as a flag
 * at the thresholds of REBA_BANDS.approx. `supported` of the arm is null: the metrics cannot know. options: { seated } as in ergonomicFlags.
 */
export function rebaInputs(metrics, options) {
  const m = metrics, o = options ?? {}, ap = REBA_BANDS.approx;
  const seated = o.seated ?? (m.comOverBase == null || m.comOverBase < ap.legsSeatedMarginM);
  const a = m.trunkInclination;
  const trunkBand = a == null ? null : Math.abs(a) <= ap.upright ? 0 : Math.abs(a) <= 20 ? 1 : a > 60 ? 3 : 2;
  const neckAngle = m.neckFlexion;
  const neckBand = neckAngle == null ? null : neckAngle >= -ap.upright && neckAngle <= 20 ? 0 : 1;
  const side = (s) => {
    const ua = m[`shoulderElevation_${s}`], fl = m[`shoulderFlexion_${s}`], ab = m[`shoulderAbduction_${s}`];
    const ext = ua != null && fl < 0 && -fl >= Math.abs(ab);
    const upper = ua == null ? null : (ext ? -ua : ua);
    const ub = upper == null ? null : upper <= 20 && upper >= -20 ? 0 : upper < -20 ? 1 : upper <= 45 ? 1 : upper <= 90 ? 2 : 3;
    const ea = m[`elbowAngle_${s}`], lower = ea == null ? null : 180 - ea;
    const lb = lower == null ? null : lower >= 60 && lower <= 100 ? 0 : 1;
    const wf = m[`wristFlexion_${s}`], wb = wf == null ? null : Math.abs(wf) <= 15 ? 0 : 1;
    const kn = m[`kneeAngle_${s}`], kf = kn == null ? null : 180 - kn;
    return {
      upperArm: { angle: upper, bandIndex: ub, direction: ext ? "extension" : "flexion", abduction: ab, abducted: ab != null && ab > ap.abductedDeg, shoulderRaised: (m[`shrug_${s}`] ?? 0) > ap.shoulderRaisedDeg, supported: null },
      lowerArm: { angle: lower, bandIndex: lb },
      wrist: { angle: wf, bandIndex: wb, deviation: m[`wristDeviation_${s}`], deviated: Math.abs(m[`wristDeviation_${s}`] ?? 0) > ap.wristDeviationDeg, twisted: Math.abs(m[`forearmPronation_${s}`] ?? 0) > ap.wristTwistDeg },
      knee: { flexion: kf, bandIndex: kf == null ? null : kf < 30 ? 0 : kf <= 60 ? 1 : 2 },
    };
  };
  const L = side("L"), R = side("R");
  const bilateral = m.legSupport === "both";
  return {
    source: "REBA, Hignett and McAtamney 2000, Applied Ergonomics 31:201-205 (angle bands only: no scores)",
    bands: REBA_BANDS,
    trunk: { angle: a, bandIndex: trunkBand, direction: a == null ? null : a < 0 ? "extension" : "flexion", twist: m.trunkTwist, twisted: Math.abs(m.trunkTwist ?? 0) > ap.twistDeg, sideBend: m.trunkLateralFlexion, sideBent: Math.abs(m.trunkLateralFlexion ?? 0) > ap.sideBendDeg },
    neck: { angle: neckAngle, bandIndex: neckBand, direction: neckAngle == null ? null : neckAngle < 0 ? "extension" : "flexion", twist: m.neckTwist, twisted: Math.abs(m.neckTwist ?? 0) > ap.twistDeg, sideBend: m.neckSideBend, sideBent: Math.abs(m.neckSideBend ?? 0) > ap.sideBendDeg },
    legs: { support: seated ? "seated" : m.legSupport === "none" || m.legSupport == null ? "none" : bilateral ? "bilateral" : "unilateral", seated, weightShareLeft: m.weightShareLeft, L: L.knee, R: R.knee },
    upperArm: { L: L.upperArm, R: R.upperArm },
    lowerArm: { L: L.lowerArm, R: R.lowerArm },
    wrist: { L: L.wrist, R: R.wrist },
  };
}
