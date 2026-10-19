# Posture metrics: the ergonomic angles and distances of a posed body (`metrics.js`)

Module: `site/js/human/metrics.js` (pure: imports `three` and `pose.js` only). Tests: `node --import ./tests/human3d/register.mjs --test "tests/human3d/metrics.test.mjs"`.
Contract of the figure it measures: `DESIGN.md` 1, `POSE.md`; landmarks and contact sets: `MODEL.md` 5.

This is the shared vocabulary for (a) the semantic tests of posture authors ("reclined 115 degrees means the trunk is inclined 25 degrees"), (b) the Analysis panel, which
shows the angles of the current posture, and (c) RULA / REBA style indications later. It is a **kinematic indication on a simplified model** (rigid segments, approximate joint
centres, see `DESIGN.md` 0): it says what angle the figure has, not whether a person doing the task is at risk.

## 1. Use

```js
import { postureMetrics, ergonomicFlags, rebaInputs } from "./metrics.js";
import { placePose } from "./pose.js";

const pose = { root: { heading: 0, flex: 0, lat: 0, rot: 0 }, angles: { hip_L: [90, 0, 0], hip_R: [90, 0, 0], knee_L: [90, 0], knee_R: [90, 0] } };
const root = placePose(body, pose, { posture });           // or rig.root: the full root with x, y, z
const m = postureMetrics(body, pose, root);                // { trunkInclination: -0.5, hipAngle_L: 90.5, kneeAngle_L: 85.1, seatHeight: 0.43, ... }
const flags = ergonomicFlags(m, { trunkSupport: true });   // [{ id: "trunk-inclination", label, value, severity: "ok", note }, ...]
const reba = rebaInputs(m);                                // { trunk: { angle, bandIndex, ... }, neck, legs, upperArm: { L, R }, lowerArm, wrist }  (no scores)
```

* `postureMetrics(body, pose, root, options?)` returns a **flat object** with the keys of `metricKeys()` (below). Values are numbers (degrees, or metres for heights and
  distances), booleans (`handAbove*`) or one string (`legSupport`); `null` where a quantity is undefined for that body (a body without `masses` has no `comHeight`; a body that
  lacks a landmark has no quantity that needs it). `pose` is `{ root?, angles }` as in `pose.js` (concrete joint ids, degrees, `expandPosture` output), `root` the full root
  `{ x, y, z, heading, flex, lat, rot }`. **Without a root height** (`root` undefined or without `y`) the pose is first placed on the floor by its feet (`placePose`, support
  `options.support`, default `"feet"`; the heading and tilt of a partial `root` are kept): then every height is above the floor `y = 0`. A lying posture needs
  `support: "body"`, a seated one `"seat+feet"` or `"seat"`; or place it yourself and pass the root. `options.out` is an object to fill instead of a new one (no allocation
  per call); `options.seatHeight` (m) adds the ischial points on a seat plane of that height to the base of support of `comOverBase`.
* It throws what `pose.js` `solvePose` throws (unknown joint id, non-finite number) and nothing else. Cost: about 0.06 to 0.1 ms with a root, 0.2 ms when it has to place the
  body (Node 22, one core; `metrics.test.mjs` asserts under 0.3 ms). The per-body landmark table is cached in a `WeakMap`.
* `ergonomicFlags(metrics, options?)` and `rebaInputs(metrics, options?)` read only the metrics object, so they can run on a stored result.

## 2. Conventions

* **World, units.** Metres and degrees; `+Y` up, `+Z` the way the figure faces, `+X` the figure's left; the floor is `y = 0` (so heights assume the figure stands on the floor
  plane; for a platform subtract its height). The figure measured is the one the rig draws (`pose.js` `figureOf`): joint centres from the kinematics, landmarks of `fit.js`.
* **The heading frame.** Forward and left in this file mean the horizontal facing direction of the **pelvis**: the hip line (right hip to left hip) crossed with the vertical, plus
  the horizontal part of the pelvis anterior axis (which takes over when the body lies on its side, where the hip line is vertical); `left = up x forward`. It follows
  `root.heading`, the tilt of the pelvis and the twist of the pelvis, so a posture that is turned in the world has the same metrics (`bodyHeading` reports it). Upside down it
  falls back to the root heading. A twisted thorax is therefore measured against the pelvis, not against itself.
* **Inclination from the vertical, split.** An inclination of a line from the vertical is one angle `theta` (0 to 180) in the direction the line leans. Reported as a
  **forward part** (`theta cos(azimuth)`, positive forward) and a **sideways part** (`theta sin(azimuth)`, positive to the figure's left), where the azimuth is the direction of
  the lean in the heading frame. For a lean in one plane this is exactly that plane's angle (a trunk bent 30 degrees forward: 30 and 0). For a mixed lean it is well defined, which a
  "projected angle" is not: the projection on the sagittal plane of a nearly horizontal line is meaningless. Lying on the back: the trunk is inclined 90 degrees backward
  (`trunkInclination` = -90), lying on the front +90, on the left side `trunkInclinationSide` = +90.
* **Included angles** (elbow, hip, knee, ankle) are the angle between two segments meeting at a joint, 0 to 180: 180 = a straight line, except the ankle (shank against the sole,
  90 = a right angle). Flexion is `180 - angle` for elbow, hip and knee.
* **Joint angles read from the pose.** `wristFlexion`, `wristDeviation`, `forearmPronation`, `shrug` are the `wrist` `flex`, `dev`, `forearm` `pron`, `clavicle` `elev` DOF of
  `skeleton.js` (their sign: palmar flexion +, radial deviation +, pronation +, shoulder raised +). Everything else is measured on the posed figure.
* **Sides.** Paired metrics exist as `key_L` and `key_R` (the figure's own left and right). Mirroring a pose (`mirrorPose`) swaps them: lateral and twist quantities change sign,
  `weightShareLeft` becomes `1 - x` (`metrics.test.mjs` checks every key on 32 poses).
* **Landmarks used:** hand = `palm_centre` (the centre of the palm surface; a held handle is better represented by `grip_centre`, about 15 mm further along the hand);
  trochanter = `trochanterion`; eye = `eye_mid`; `vertex`, `cervicale` (C7 spinous process), `tragion`, `ASIS`, `PSIS`, `ischial`, `knee_top`, the sole points `heel_sole`,
  `ball_sole_medial`, `ball_sole_lateral`, `toe_sole`, `knee_front`, `shin`, `olecranon` (contact set of the balance quantities).

## 3. The quantities

Generated from `METRIC_DEFS` in `metrics.js`; the test fails when this table is out of date (`UPDATE_DOCS=1 node --import ./tests/human3d/register.mjs --test
"tests/human3d/metrics.test.mjs"` rewrites it). The last column says how the quantity relates to ISO 11226, ISO 11228, REBA (Hignett and McAtamney 2000) and RULA
(McAtamney and Corlett 1993), and where the model's definition differs.

<!-- metrics-table:begin -->
| Key | Unit | Definition | Standards |
| --- | --- | --- | --- |
| **Frame** | | | |
| `bodyHeading` | degrees | Azimuth of the heading frame's forward axis about the world vertical, 0 = +Z, positive turning left (toward +X). It is the pelvis facing direction that every forward and left of this file refers to. |  |
| **Trunk and pelvis** | | | |
| `trunkInclination` | degrees | Forward (sagittal) part of the inclination from the world vertical of the trunk line mid-hip to C7: the line runs from the midpoint of the two hip joint centres to the C7/T1 joint centre (rig joint `C7`); the angle from the vertical is split along the direction of the lean (see Conventions), so a lean in the sagittal plane gives exactly its angle. Positive = the shoulders are ahead of the hips; lying supine = -90, prone = +90. | ISO 11226 trunk inclination alpha (Table 1, forward positive); REBA / RULA trunk flexion. Model neutral: about -0.5 degrees (C7/T1 is 5 mm behind the hip centres), not subtracted as ISO's 'difference from the reference posture' would. |
| `thoraxInclination` | degrees | Forward part of the inclination from the world vertical of the up axis of the T1 segment (rig joint `T1` frame, the orientation of the upper trunk). Unlike the chord `trunkInclination` it is additive: for movements in the sagittal plane it equals `root.flex` plus the lumbar and thoracic flexion totals, and it is exactly 0 in the neutral pose. A uniformly curved spine bent by X degrees turns the chord by about X/2 but the thorax by X. | The orientation of the upper trunk; ISO 11226 / REBA do not name it, observers usually judge the chord. |
| `trunkInclinationSide` | degrees | Sideways (frontal) part of the same inclination of the trunk line, split as above. Positive = the shoulders are to the figure's left of the hips. | Side bending of REBA / RULA when the pelvis is level; ISO 11226 Table 1 item 1 (symmetrical trunk posture) is `trunkLateralFlexion`. |
| `trunkInclinationTotal` | degrees | Angle between the trunk line and the world vertical, 0 to 180, in any direction (0 = upright, 90 = horizontal, 180 = upside down). | The direction-free inclination (the ISO / NIOSH 'trunk bent more than X degrees from vertical'). |
| `trunkFlexionRelativeToPelvis` | degrees | Angle of the trunk line in the sagittal plane of the PELVIS frame (the pelvis joint's own axes, so independent of how the pelvis is tilted): atan2 of the line's component along the pelvis anterior axis and along the pelvis up axis. Positive = bent forward over the pelvis. It is the lumbar plus thoracic flexion seen as one chord, so it is not the sum of the two (curvature baked into the neutral spine; neutral about -0.5 degrees). | REBA / RULA trunk flexion when the pelvis is held fixed (sitting against a backrest). |
| `trunkLateralFlexion` | degrees | Lateral component, in the pelvis frame, of the up axis of the T1 segment (rig joint `T1`): atan2 of its component along the pelvis left axis and the pelvis up axis. Positive = the thorax is bent to the figure's left relative to the pelvis. | ISO 11226 Table 1 item 1, Figure 1 (2): a symmetrical trunk posture has neither lateral flexion nor axial rotation of the thorax against the pelvis. The standard gives no number in the part that could be read. |
| `trunkTwist` | degrees | Twist angle about the pelvis up axis of the rotation from the pelvis frame to the T1 frame (swing-twist decomposition: the part of the thorax rotation that is a turn about the long axis). Positive = the thorax turns to the figure's left. | ISO 11226 Table 1 item 1, Figure 1 (1); REBA / RULA 'trunk twisted'. |
| `pelvisTilt` | degrees | Angle of the line from the midpoint of the two PSIS to the midpoint of the two ASIS landmarks above the horizontal in the sagittal plane of the heading frame, positive when the ASIS is lower than the PSIS (anterior tilt, the clinical convention). It is a world angle: it changes with `root.flex` but not with the hip or lumbar angles. Model neutral: about 17 degrees anterior (clinical standing values 5 to 15). | Not an ISO / REBA quantity. Seated slumping shows as a decrease from the neutral value. |
| `lumbarFlexion` | degrees | Sagittal angle of the L1 segment's up axis (rig joint `L1`, the whole lumbar chain L5 to L1 applied) in the pelvis frame: positive = forward bend. Zero is the natural standing lordosis, not a straight spine, exactly like the posture `spine.lumbar` flex total (equal to it when lateral bend and rotation are 0). | Clinical lumbar flexion measured from the standing curve (not a Cobb angle). |
| `thoracicFlexion` | degrees | Sagittal angle of the T1 segment's up axis (the whole thoracic chain T12 to T1 applied) in the L1 frame: positive = forward bend (kyphosis increasing). Zero is the natural standing kyphosis. | As lumbarFlexion; equals the posture `spine.thoracic` flex total when lateral bend and rotation are 0. |
| **Head and neck** | | | |
| `neckInclination` | degrees | Forward part of the inclination from the world vertical of the line from the C7 spinous process (landmark `cervicale`) to the midpoint of the two tragions, positive = the ear is ahead of C7. 90 minus this angle is the craniovertebral angle of the clinical literature. A descriptor of the head-neck geometry, not a deviation: in the neutral pose it is about 37 degrees (craniovertebral angle 53). | Not the ISO / REBA neck angle: use `headInclination` and `neckFlexion` for those. |
| `neckFlexion` | degrees | headInclination minus trunkInclination: the forward tilt of the head beyond that of the trunk. Positive = flexed (chin toward the chest), negative = extended. | ISO 11226 Table 3 item 3 (neck flexion / extension = head inclination minus trunk inclination); REBA / RULA neck flexion (the model measures the head against the trunk line, 0 at the neutral pose). |
| `headInclination` | degrees | Forward part of the inclination from the world vertical of the head's up axis (rig joint `head` frame: the head's own vertical, with the Frankfurt plane horizontal in the neutral pose). Positive = nodding forward. Exactly 0 in the neutral pose. | ISO 11226 head inclination beta (Table 3 item 2); the standard's Frankfurt plane is the model's neutral head orientation to within a few degrees. |
| `headTilt` | degrees | Sideways part of the inclination from the world vertical of the head's up axis (the ear line from the horizontal, seen from the front). Positive = the head tilts to the figure's left (left ear down). | ISO 11226 / REBA 'head side bending' (world-referenced; see `neckSideBend` for the relative angle). |
| `neckSideBend` | degrees | Lateral component, in the T1 frame, of the head's up axis: atan2 of its component along the T1 left axis and the T1 up axis. Positive = the head bends to the figure's left relative to the thorax. | REBA 'neck side-bending' (+1 modifier). |
| `neckTwist` | degrees | Twist angle about the T1 up axis of the rotation from the T1 frame to the head frame (swing-twist). Positive = the face turns to the figure's left relative to the thorax. | REBA / RULA 'neck twisted' (+1 modifier). |
| `gazeElevation` | degrees | Elevation above the horizontal of the mean direction of the two eye axes (the +Z axis of the rig joints `eye_L` and `eye_R`): positive = looking up. It includes the eye rotation in the head, so a head tilted down and eyes turned up can give 0. | Sight-line and display design (approx.): the relaxed line of sight is below the horizontal; ISO 11226 uses the Frankfurt plane as the neutral head. |
| **Arm** | | | |
| `shrug_L` / `_R` | degrees | Elevation angle of the clavicle joint (rig `clavicle_{L,R}` `elev` DOF, read from the pose): positive = lateral end of the clavicle up (shoulder raised). | REBA / RULA 'shoulder raised' (+1). |
| `shoulderElevation_L` / `_R` | degrees | Angle between the upper arm (glenohumeral joint centre to elbow joint centre) and the trunk's down axis (the reverse of the trunk line): 0 = hanging along the trunk, 90 = at right angles to it, 180 = straight up along the trunk. | REBA / RULA upper arm position (bands 20, 45, 90) when the trunk is upright; ISO 11226 arm elevation is measured from the world vertical: `upperArmInclination`. |
| `shoulderFlexion_L` / `_R` | degrees | Forward part of the arm elevation `shoulderElevation`, split along the direction the arm leans from the trunk's down axis in the TRUNK frame (up = the trunk line, left = the line between the two glenohumeral centres made perpendicular to it, forward = left x up). Positive = forward (flexion), negative = backward (extension). The same construction as the exponential-map swing of the shoulder joint, so for an arm moved only by the `flex` DOF it is that value plus the effect of the rest abduction of 3 to 14 degrees. | REBA / RULA upper arm flexion / extension (extension more than 20 degrees scores like 20 to 45 flexion). |
| `shoulderAbduction_L` / `_R` | degrees | Sideways part of the arm elevation, split as `shoulderFlexion`; positive = away from the midline, negative = across the body. It is not the `abd` DOF when the arm is raised in another plane (the neutral arm already has 3 to 14 degrees). | REBA / RULA 'upper arm abducted' (+1); ISO 11226 annex: abduction is listed with the awkward arm postures. |
| `upperArmInclination_L` / `_R` | degrees | Angle between the upper arm (glenohumeral joint centre to elbow joint centre) and the world's downward vertical, 0 to 180: 0 = hanging, 90 = horizontal, 180 = straight up. Independent of the trunk. | ISO 11226 upper arm elevation (reference: the vertical through the shoulder; the standard draws the line through the acromio-clavicular and humero-radial joints, the model uses the glenohumeral and elbow centres, a few degrees different). The model's neutral arm hangs abducted by 3 to 14 degrees (MODEL.md 4.5), so this is that angle, not 0, in the neutral pose. |
| `upperArmInclinationSagittal_L` / `_R` | degrees | Forward part of `upperArmInclination` (the inclination from the downward vertical split along the lean direction in the heading frame). Positive = forward, negative = backward (extension). | ISO 11226 arm elevation 'extension / flexion' (extension beyond 20 degrees is not recommended). |
| `elbowAngle_L` / `_R` | degrees | Included angle at the elbow between the upper arm and the forearm (elbow joint centre to the shoulder and wrist joint centres): 180 = straight, 90 = right angle, less = more flexed. | REBA / RULA lower arm flexion = 180 minus this angle (band 60 to 100 degrees of flexion = 80 to 120 here). |
| `wristFlexion_L` / `_R` | degrees | The `flex` DOF of the wrist joint (read from the pose): positive = palmar flexion, negative = extension. | REBA / RULA wrist flexion / extension (band 15 degrees either way). |
| `wristDeviation_L` / `_R` | degrees | The `dev` DOF of the wrist joint (read from the pose): positive = radial deviation (thumb side), negative = ulnar. | REBA / RULA 'wrist deviated' (+1). |
| `forearmPronation_L` / `_R` | degrees | The `pron` DOF of the forearm joint (read from the pose): 0 = mid-position (thumb forward), positive = pronation (palm toward the floor), negative = supination. | RULA wrist twist (extreme pronation / supination). |
| `shoulderHeight_L` / `_R` | metres | Height above the floor (y = 0) of the glenohumeral joint centre. |  |
| `handHeightAboveFloor_L` / `_R` | metres | Height above the floor (y = 0) of the palm centre (landmark `palm_centre`). | Grip height for lifting and control placement (NIOSH 'vertical location V' uses the hands' grip point, close to this). |
| `handToShoulderForward_L` / `_R` | metres | Component along the heading frame's forward axis of the vector from the glenohumeral joint centre to the palm centre. Positive = in front. |  |
| `handToShoulderLateral_L` / `_R` | metres | Component along the heading frame's left axis of the same vector. Positive = toward the figure's left (so the left hand held out sideways is positive, the right hand negative). |  |
| `handToShoulderUp_L` / `_R` | metres | Vertical component of the same vector. Positive = the palm is above the shoulder joint. | Overhead work indicator (the hand above the shoulder joint); the upper arm bands of REBA / RULA are `shoulderElevation`. |
| `handReach_L` / `_R` | metres | Horizontal distance between the glenohumeral joint centre and the palm centre (the length of the forward and lateral components together). |  |
| `reachFromAnkles_L` / `_R` | metres | Horizontal distance from the midpoint of the two ankle joint centres to the palm centre (the reach a stander can make without stepping; a seated reach is measured from the seat reference point instead, not from here). | Reach envelopes of Pheasant and Haslegrave (Bodyspace) are given from a standing position or a seat reference point. |
| `handAboveShoulder_L` / `_R` | boolean | true when `handToShoulderUp` is greater than 0. | Overhead work indicator; ISO 11226 arm elevation above 60 degrees is the stricter test. |
| `handAboveHead_L` / `_R` | boolean | true when the palm centre is higher than the vertex landmark of the head. | Overhead work: hands above the head (ISO 11228-3 lists upper arm elevation guidelines). |
| `handAboveHeadBy_L` / `_R` | metres | Height of the palm centre minus height of the vertex; negative when the hand is below the top of the head. |  |
| **Leg** | | | |
| `hipAngle_L` / `_R` | degrees | Included angle at the hip between the trunk line (mid-hip toward C7) and the thigh (hip joint centre toward the knee joint centre): 180 = standing straight, 90 = sitting upright with the thigh horizontal, less = more flexed. | Hip angle of the ISO 7250-1 seated posture (90 degrees); REBA 'legs' when sitting. |
| `thighInclination_L` / `_R` | degrees | Elevation angle of the thigh (hip joint centre toward knee joint centre) above the horizontal: -90 = hanging straight down (standing), 0 = horizontal (ISO seated), positive = the knee is higher than the hip (low seat). | ISO 7250-1 seated posture: thighs horizontal. |
| `kneeAngle_L` / `_R` | degrees | Included angle at the knee between the thigh and the shank (knee joint centre toward the hip and ankle joint centres): 180 = straight, 90 = bent at a right angle. Knee flexion is 180 minus this angle. The model's neutral shank leans forward about the ankle (MODEL.md 4.1), so the neutral pose reads about 175 degrees, not 180: a flexion of 5 degrees, under every REBA band. | REBA legs: knee flexion 30 to 60 (+1) and over 60 (+2); ISO 7250-1 seated knee 90. |
| `shankInclination_L` / `_R` | degrees | Forward part of the inclination from the downward vertical of the shank (knee joint centre toward ankle joint centre), in the heading frame: 0 = vertical, positive = the foot is ahead of the knee, negative = the foot is behind it (kneeling on the heels = -90). The model's neutral shank leans forward about the ankle (the knee is ahead of the ankle, MODEL.md 4.1), about -4.9 degrees (the lean is capped at 4.9, MODEL.md 7.1). | ISO 7250-1 seated posture: lower leg vertical. |
| `ankleAngle_L` / `_R` | degrees | Included angle between the shank (ankle joint centre toward the knee) and the sole line (from the heel sole point `heel_sole` toward the middle of the two ball-of-foot sole points): 90 = the sole at right angles to the shank, over 90 = plantar flexion (toes down), under 90 = dorsiflexion. The neutral pose reads about 85 degrees, not 90: the shank leans forward about the ankle by the stance lean (MODEL.md 4.1) while the foot is flat. The sole line, not the ankle-to-toe line, because the neutral foot is flat on the floor. | ISO 7250-1 seated posture: ankle 90; ISO 11226 extreme positions: plantar flexion over 20 / dorsiflexion over 50 (secondary source). |
| `kneeHeight_L` / `_R` | metres | Height above the floor (y = 0) of the top of the knee (landmark `knee_top`, the ISO 7250-1 'knee height' point). | Knee clearance under a desk or console. |
| **Whole body** | | | |
| `hipHeight` | metres | Mean height above the floor of the two greater trochanters (landmark `trochanterion`). | Anthropometric trochanteric height (ISO 7250-1). |
| `pelvisHeight` | metres | Height above the floor of the pelvis joint, the midpoint of the two hip joint centres. |  |
| `eyeHeight` | metres | Height above the floor of the cyclopean eye point (landmark `eye_mid`). | Eye point for sight lines and display placement (ISO 7250-1 eye height). |
| `seatHeight` | metres | Mean height above the floor of the two ischial tuberosity points (landmarks `ischial_L`, `ischial_R`): the seat plane height when the posture sits on a seat; for a standing posture just the height of the sit bones. | The seat plane of the seated measurement posture of ISO 7250-1 (popliteal height); no cushion compression. |
| `footSeparationMediolateral` | metres | Left ankle joint centre minus right ankle joint centre along the heading frame's left axis: positive for a normal stance (the left foot is on the left), negative when the feet are crossed. |  |
| `footSeparationAnteroposterior` | metres | Left ankle joint centre minus right ankle joint centre along the heading frame's forward axis: positive = the left foot is ahead. | Step length of a stance or stride. |
| `stanceWidth` | metres | Width of the base of support: the extent along the heading frame's left axis of the eight foot sole points of both feet (`heel_sole`, both `ball_sole`, `toe_sole`), from the outermost point of one foot to the outermost point of the other. | Wide stance versus shoulder width (a stance of 1 to 1.5 shoulder widths is the usual stable lifting stance). |
| `stanceLength` | metres | The extent of the same eight points along the heading frame's forward axis: the foot length for feet side by side, more for a stride. |  |
| `comHeight` | metres | Height above the floor of the whole-body centre of mass (segment masses and centres of de Leva 1996, as `centerOfMass` of pose.js). null for a body without segment masses. |  |
| `comOverBase` | metres | Margin of the centre of mass, projected on the floor, to the edge of the convex hull of the floor contact points: foot sole points, knee front and shin points, palm centres and elbow points that are within 20 mm of the floor (y = 0). Positive = inside by that distance, negative = outside by that distance; null when nothing touches the floor or the body has no masses. A seated person with the feet on the floor has a negative margin (the seat carries the weight): pass `options.seatHeight` to add the ischial and thigh points that lie on a seat plane of that height. | Static balance indication (pose.js balance); POSTURES.md rule 6. |
| `weightShareLeft` | 0 to 1 | Estimated fraction (0 to 1) of the body weight carried by the left foot, from the position of the centre of mass between the two feet: the horizontal projection of the centre of mass on the line from the right to the left foot centre (mean of the foot's four sole points), clamped to 0 to 1; 0 or 1 when only one foot touches the floor; null when no foot touches it or the body has no masses. A statics estimate from geometry, not a force measurement. |  |
| `legSupport` | text | Which foot carries the weight: `"left"` or `"right"` when only that foot is within 20 mm of the floor or weightShareLeft is at least 0.65 or at most 0.35; `"both"` otherwise; `"none"` when neither foot touches the floor; null for a body without masses and both feet down. | REBA legs: bilateral weight bearing versus unilateral support. |
<!-- metrics-table:end -->

### Values in the neutral and the ISO seated pose

The median US Army man (P50, `united-states/army/M.json`). The neutral pose is relaxed quiet standing (`DESIGN.md` 1.1): **the feet are flat, but the shank leans forward about
the ankle** (since the neutral layout puts the centre of mass 37.5 % of the foot length from the heel with the shank lean capped at 4.9 degrees, `fit.js` `leanLegs`, `MODEL.md` 4.1), the spine has its natural curvature
and the arms hang abducted by 3 to 14 degrees. So the neutral values are not the "textbook" zeros: the knee reads 175 degrees, the ankle 85, the shank -5, the pelvis is tilted
17 degrees forward, the upper arm is 6 degrees off the vertical, and the ISO 7250-1 seated posture (hips 90, knees 90, ankles 0 as DOF) has an included knee angle of 85 degrees
and a hip angle of 90.5 degrees. A test that wants "knee 90" must allow about 5 degrees. Over the 176 population medians the neutral trunk inclination is -0.55 to -0.45 degrees,
the knee 175.1 and the ankle 85.1 (the same for every one: the shank lean is at its cap of 4.9 degrees, `MODEL.md` 4.1), the pelvic tilt 15 to 22. The table is generated by the test and checked to 3 degrees / 3 cm.

<!-- neutral-values:begin -->
| Key | Unit | Standing (ISO 7250-1) | Seated (ISO 7250-1) |
| --- | --- | --- | --- |
| `trunkInclination` | deg | -0.5 | -0.5 |
| `thoraxInclination` | deg | 0.0 | 0.0 |
| `trunkFlexionRelativeToPelvis` | deg | -0.5 | -0.5 |
| `pelvisTilt` | deg | 17.4 | 17.4 |
| `neckInclination` | deg | 37.2 | 37.2 |
| `headInclination` | deg | 0.0 | 0.0 |
| `gazeElevation` | deg | 0.0 | 0.0 |
| `shoulderElevation_L` | deg | 6.4 | 6.4 |
| `upperArmInclination_L` | deg | 6.4 | 6.4 |
| `elbowAngle_L` | deg | 180.0 | 180.0 |
| `hipAngle_L` | deg | 179.5 | 90.5 |
| `thighInclination_L` | deg | -90.0 | 0.0 |
| `kneeAngle_L` | deg | 175.1 | 85.1 |
| `shankInclination_L` | deg | -4.9 | -4.9 |
| `ankleAngle_L` | deg | 85.1 | 85.1 |
| `pelvisHeight` | m | 0.903 | 0.494 |
| `hipHeight` | m | 0.908 | 0.474 |
| `kneeHeight_L` | m | 0.524 | 0.547 |
| `seatHeight` | m | 0.837 | 0.428 |
| `eyeHeight` | m | 1.629 | 1.220 |
| `shoulderHeight_L` | m | 1.403 | 0.994 |
| `handHeightAboveFloor_L` | m | 0.778 | 0.369 |
| `reachFromAnkles_L` | m | 0.209 | 0.399 |
| `stanceWidth` | m | 0.244 | 0.244 |
| `stanceLength` | m | 0.214 | 0.214 |
| `comHeight` | m | 0.973 | 0.658 |
| `comOverBase` | m | 0.072 | -0.242 |
<!-- neutral-values:end -->

## 4. Relation to the standards

### ISO 11226:2000, Ergonomics: evaluation of static working postures

Static postures (held longer than 4 s), without or with minimal external force. Step 1 judges the body angles (acceptable / go to step 2 / not recommended), step 2 the holding time.
**Read from the standard's own text** (the free ISO preview, `cdn.standards.iteh.ai/samples/25573/...ISO-11226-2000.pdf`: scope, definitions, procedure and Table 1):

* Reference posture (2.10): "sitting or standing posture with a non-rotated upright trunk and the arms hanging freely, while looking straight forward along the horizontal"; neutral
  posture (2.8): upright trunk, upper arms hanging freely, head according to the Frankfurt plane (2.2). The model's neutral pose is that posture: `headInclination` and
  `thoraxInclination` are exactly 0 there, `trunkInclination` -0.5 degrees. ISO measures the trunk and head inclinations as the **difference between the working and the reference
  posture**; the model does not subtract the reference value (0.5 degrees for the trunk line), it reports the angle from the vertical.
* **Table 1, trunk** (inclination alpha, forward positive, seen from the side): over 60 degrees not recommended; 20 to 60 degrees go to step 2 without full trunk support, acceptable
  with full trunk support; 0 to 20 degrees acceptable; below 0 degrees (backward) not recommended without full trunk support, acceptable with it; a symmetrical trunk posture (no axial
  rotation and no lateral flexion of the thorax against the pelvis, Figure 1) acceptable, an asymmetrical one not recommended; for sitting a convex lumbar spine posture is not
  recommended (the model has `lumbarFlexion` but no limit for the convex lumbar spine). Full trunk support (2.5): the weight carried by a backrest (backward) or, for a forward
  inclination, indirectly through arm support. The holding times (Table 2, Figure 4) are in the standard and are not reproduced here.

**From a report that reproduces the standard's table** (Perosh, "Assessing arm elevation at work with technical systems", 2018, Table 8.1): upper arm elevation between the vertical and the line
through the acromio-clavicular and humero-radial joints (the model uses the glenohumeral and elbow centres: a few degrees different); -20 to 20 degrees (extension-flexion) acceptable;
20 to 60 degrees acceptable with full arm support, otherwise a maximum holding time (4 min at 20, 2.5 min at 40, 1 min at 60 degrees); over 60 degrees not recommended; awkward arm
postures such as extension over 20 degrees, adduction, extreme external rotation, elevated shoulders not recommended.

**From two application papers that quote the standard** (PMC9696528 and PMC11939344; the standard's Table 3 is not in the preview; **approx.**): head inclination beta (relative to the
reference posture): over 85 or below 0 degrees not recommended without full trunk / head support, 0 to 25 acceptable, 25 to 85 go to step 2; neck flexion = beta minus alpha (head inclination
minus trunk inclination): 0 to 25 degrees the neutral range (PMC11939344 reads over 40 as not recommended); lateral flexion limits of 10 degrees appear in the application papers, not in the part
of the standard that could be read. Lower limbs (3.7): kneeling and crouching are to be avoided (3.1); one application paper quotes plantar flexion over 20, dorsiflexion over 50 degrees and
"extreme knee flexion" as extreme positions without a number for the knee. **None of the numbers in this paragraph could be checked against the standard.**

**How `ergonomicFlags` applies it** (`ISO_11226` in the module holds the limits; every flag note ends with "An indication for static postures (held longer than 4 s), not a risk assessment."):

| flag id | metric | ok | caution ("go to step 2" or conditional) | high ("not recommended") | status of the limits |
| --- | --- | --- | --- | --- | --- |
| `trunk-inclination` | `trunkInclination` | -2 to 20 (or any backward angle / 20 to 60 with `trunkSupport: true`) | 20 to 60 without support; backward with `trunkSupport` unknown | over 60; backward below -2 with `trunkSupport: false` | verified (Table 1); the 2 degree slack is the model's tolerance at 0 |
| `trunk-symmetry` | larger of `trunkLateralFlexion`, `trunkTwist` (absolute) | up to 10 | 10 to 20 | over 20 | approx. (Table 1 item 1 is binary; the 10 / 20 degree steps are this model's) |
| `head-inclination` | `headInclination` | -2 to 25 (or 25 to 85 with `trunkSupport: true`, or backward with `headSupport: true`) | 25 to 85 | over 85; below -2 without `headSupport` | approx. (secondary sources) |
| `neck-flexion` | `neckFlexion` | -2 to 25 | 25 to 40; extension below -2 | over 40 | approx. |
| `upper-arm-elevation-L/R` | `upperArmInclination` (and its sagittal part) | up to 20 (or 20 to 60 with `armSupport`) | 20 to 60 without support (note gives the holding times) | over 60; extension over 20 degrees | verified (Perosh Table 8.1) |
| `elbow-L/R` | 180 - `elbowAngle` | 60 to 100 degrees of flexion, or the arm hanging (upper arm under 20) | outside | - | REBA / RULA lower arm band (verified); not an ISO limit |
| `wrist-flexion-L/R` | `wristFlexion` | within 15 | beyond 15 | - | REBA / RULA 15 degrees (verified) |
| `wrist-deviation-L/R` | `wristDeviation` | within 10 | beyond 10 | - | approx. (REBA / RULA add a point for any deviation) |
| `knee-flexion-L/R` | 180 - `kneeAngle` | up to 30, or seated | 30 to 60 | over 60 | REBA legs (verified); seated = `options.seated`, else the centre of mass is more than 40 mm outside the floor base (or nothing touches the floor) |

`options`: `trunkSupport`, `headSupport`, `armSupport` (`true` or `{ L, R }`), `seated`. A flag whose metric is `null` is omitted. A caller that knows the support (a backrest in the scene, a desk
under the forearms) must pass it: the metrics cannot see it.

### REBA (Hignett and McAtamney 2000, Applied Ergonomics 31:201-205)

`rebaInputs` returns, for each segment, the angle and the band it falls in (`bandIndex` = position in `REBA_BANDS`), plus the modifiers as angles and flags; **no score, no table lookup** (out of scope
for now). Band edges verified on the Ergonautas REBA help page (`ergonautas.upv.es/metodos/reba/reba-ayuda.php`) and the worksheet of A. Hedge (`ergo-plus.com/wp-content/uploads/REBA.pdf`):

| segment | metric used | bands (`bandIndex` 0, 1, 2, 3) |
| --- | --- | --- |
| trunk | `trunkInclination` | upright (0, here within 2 degrees) / 0 to 20 flexion or extension / 20 to 60 flexion, or extension over 20 / over 60 flexion |
| neck | `neckFlexion` | 0 to 20 flexion / over 20 flexion, or extension |
| legs | 180 - `kneeAngle` (per side) | under 30 / 30 to 60 / over 60 (not when seated); support `bilateral` / `unilateral` / `seated` / `none` from `legSupport` and the seated rule |
| upper arm | arm against the trunk: `shoulderElevation`, extension when the flexion part is negative and not smaller than the abduction part | 20 extension to 20 flexion / extension over 20, or 20 to 45 flexion / 45 to 90 / over 90 |
| lower arm | 180 - `elbowAngle` | 60 to 100 flexion / under 60 or over 100 |
| wrist | `wristFlexion` | 0 to 15 either way / over 15 |

The modifiers REBA gives without a number are flags at **approx.** thresholds (`REBA_BANDS.approx`): trunk or neck twisted or side bent beyond 10 degrees; upper arm abducted beyond 45
degrees of abduction; shoulder raised beyond 10 degrees of `shrug`; wrist deviated beyond 10 degrees or twisted (forearm pronation) beyond 45; the arm "supported" is `null` (unknown).
RULA (McAtamney and Corlett 1993) bands for reference (Ergonautas RULA help): upper arm as REBA; lower arm 60 to 100 / outside; wrist 0 / 0 to 15 / over 15; neck 0 to 10 / 10 to 20 / over 20 / extension;
trunk 0 / 0 to 20 / 20 to 60 / over 60: not computed.

### ISO 11228 and NIOSH

Perosh lists ISO 11228-3 with ISO 11226 as the guidelines for upper arm elevation, and EN 1005-4 uses the same arm-elevation categories as ISO 11226. The NIOSH lifting equation (Waters et al.
1993) takes the vertical location of the hands above the floor and their horizontal distance from the midpoint between the ankles: `handHeightAboveFloor` and `reachFromAnkles` are those two
quantities with the palm centre as the hands' point (from memory of the equation's definitions, not re-checked online).

## 5. Where the model's definition differs (and what that means for a test)

1. **The trunk line is a chord.** `trunkInclination` runs from the mid-hip to C7/T1; a spine bent by X degrees uniformly turns that chord by about X/2 (lumbar 30: 20 degrees; thoracic 30: 9; lumbar 60 plus
   thoracic 45: 56) because the lower part of the spine stays with the pelvis. For the additive quantity use `thoraxInclination` (= `root.flex` + lumbar + thoracic totals for sagittal movements) or the pieces.
2. **Neutral pose is not "textbook straight"** (section 3): knee 175, ankle 85, shank -5 at rest; the trunk line -0.5; `pelvisTilt` 17; upper arm 6. Compare with the neutral values of the same body, or allow 5 degrees.
3. **Projected components are not DOF values.** `shoulderFlexion` / `shoulderAbduction` are parts of the arm elevation in the trunk frame (the same construction as the exponential-map swing of the
   shoulder joint, so equal to the `flex` / `abd` DOF only for an arm moved in one plane from a hanging arm that is not abducted: the model's rest abduction of 3 to 14 degrees shows up).
4. **`headInclination`** is the orientation of the head frame (Frankfurt plane horizontal in the neutral pose within a few degrees: tragion to ectocanthus rises 9 degrees in the model), not an angle between landmarks.
5. **`neckInclination`** (C7 spinous process to the ear, 37 degrees in the neutral pose, craniovertebral angle 53) is a descriptor of head-neck geometry. It is not a deviation: use `headInclination` / `neckFlexion`.
6. **Weight share and balance are statics from geometry.** `weightShareLeft` assumes the weight acts through the foot centres (mean of the four sole points) and is shared linearly along the line between them; `legSupport`
   thresholds 0.35 / 0.65 are this model's. `comOverBase` counts floor contact points within 20 mm of `y = 0`; it is not the validator's balance rule (which knows the support of the posture).
7. **ISO's difference from the reference posture is not subtracted.** `trunkInclination` has an offset of -0.5 degrees in the neutral pose, `headInclination` none; the flags have 2 degrees of slack at 0.

## 6. Sources and how they were checked

| source | used for | status |
| --- | --- | --- |
| ISO 11226:2000, free preview (`cdn.standards.iteh.ai/samples/25573/2abcc229c27d4a1daa69ce1930a901a0/ISO-11226-2000.pdf`) | scope, definitions 2.2, 2.5, 2.8, 2.10, procedure, Table 1 (trunk) | read in full (11 pages: Table 3 onward are not in the preview) |
| Perosh, Assessing arm elevation at work with technical systems, 2018 (`perosh.eu/wp-content/uploads/2018/12/Report-Arm-Elevation.pdf`), Table 8.1 | upper arm elevation limits and holding times of ISO 11226 | read; secondary |
| "Development of a New Procedure for Evaluating Working Postures" (`pmc.ncbi.nlm.nih.gov/articles/PMC9696528/`), "Use of Wearable Inertial Sensors to Assess Trunk and Cervical Postures Among Surgeons" (`PMC11939344`) | head inclination limits, neck flexion = beta - alpha, alpha and beta as differences from the reference posture | read; secondary; approx. |
| Ergonautas REBA help (`ergonautas.upv.es/metodos/reba/reba-ayuda.php`), Hedge's REBA worksheet (`ergo-plus.com/wp-content/uploads/REBA.pdf`) | REBA bands | read; both agree; the original paper (Hignett and McAtamney 2000) was not opened |
| Ergonautas RULA help (`ergonautas.upv.es/metodos/rula/rula-ayuda.php`) | RULA bands | read; secondary |

## 7. Limits

* Static, one posture at a time: no duration, repetition, force or load (ISO 11226 step 2, REBA load and activity scores, NIOSH multipliers are out of scope).
* Rigid segments and approximate joint centres: angles of a few degrees are inside the model's error; the flags' limits (20, 60, 25, 85 degrees) are coarse enough for that, the 2 degree slack is not a measurement tolerance.
* The metrics do not know the support: `trunkSupport`, `headSupport`, `armSupport` and `seated` come from the caller (or the heuristics above); seat height and surfaces other than the floor are not known (`options.seatHeight` only for the base of support).
* `handAboveShoulder` and `handAboveHead` are strict comparisons with 1 micrometre of tolerance: an arm raised exactly to the horizontal is on the boundary.
* Spine angles are measured on the rigid vertebral chain; the lumbar and thoracic flexion are relative to the natural standing curves (`DESIGN.md` 1.1), not Cobb angles.
