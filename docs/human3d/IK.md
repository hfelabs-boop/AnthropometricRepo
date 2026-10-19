# Inverse kinematics: reach, place, look, squat

For the code that moves the figure to a goal (the posture editor's IK handles, the sandbox's "grab this grip / put the foot on that pedal / look at that
display / move the pelvis and keep the feet"). Module: `site/js/human/ik.js`. Contract: `DESIGN.md`; joints, ranges, regions: `skeleton.js`, `POSE.md`.
Tests: `node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.test.mjs"`. Look at it: `tests/human3d/pages/ik-demo.html`
(`python3 tests/human3d/shot.py "/__pages/ik-demo.html?size=900" out.png --w 900 --h 900 --wait-fn window.__ready --eval 'window.__demo.reach("R", [-0.28, 1.45, 0.55], { az: 35 })'`).

The model is a simplified kinematic visualisation. The solver finds *a* pose inside the ranges of motion that puts the goals where you asked; it knows nothing about
collisions, comfort, strength or balance. A result is geometrically sane, not proven healthy or safe. Check it with `pose.js` (`validatePosture`, `selfPenetrations`,
`balance`) when that matters.

## 1. Quick start

```js
import { createSolver, reachHand, placeFoot, lookAt, movePelvis, handFrameFromGrip, describeResult, DRAG_OPTIONS } from "./ik.js";

const solver = createSolver(body);                    // body: fit.js BodyModel or rig.restBody. One per body: cheap (1 to 3 ms), keep it
const start = rig.getPose();                          // { root: { x, y, z, heading, flex, lat, rot }, angles: { [jointId]: [deg...] } }

const r = reachHand(solver, start, "R", [-0.25, 1.35, 0.55]);   // the right grip centre to a world point (metres)
rig.setPose(r.pose);                                  // r.pose = { root, angles }: every joint of `start` is in it, so nothing becomes neutral
if (!r.reachable) toast(describeResult(r, { hand_R: "The right hand" })[0]);   // "The right hand: 120 mm short of the target (limited by Right clavicle ... prot at its maximum)."
```

World frame (`DESIGN.md` 0): metres, `+Y` up, `+Z` anterior, `+X` the figure's left, floor `y = 0`. Angles are degrees in the DOF order of `skeleton.js`.
`solve()` never changes its inputs (`start`, `goals`, `options` may be frozen) and returns fresh objects.

## 2. The method in one page

*Variables.* The free DOF, in radians: every DOF of a free joint (`shoulder_R.flex`, `elbow_R.flex`, ...), the **totals of the spine regions** (`lumbar.flex`, `thoracic.rot`,
`cervical.lat`, ...: 3 per region, spread over the vertebrae with the `REGIONS` weights and exact water-filling at the per-vertebra limits, **on top of what the vertebrae
already have**, so a posture with a set curvature keeps it), and optionally the pelvis: `x, y, z` (metres) and `heading, flex, lat, rot`.
Fingers, jaw and toes are variables only when you name them.

*Objective.* Damped least squares (Levenberg-Marquardt with Nielsen's gain-ratio rule) on

```
F(x) = 1/2 |r(x)|^2  +  mu/2 * sum_k s_k (x_k - x0_k)^2   [ + reference pull ]  [ + elbow / knee pole ]
```

`r` stacks the goal residuals (a position goal is 3 rows in metres, a direction 3 rows of unit-vector difference times `angleScale`, default 0.3 m/rad, so one degree is
about 5 mm). `x0` is the start. `s_k = c_k^2` is the **stiffness**: `c_k` is the cost length in metres of goal error per radian of motion. Distal joints are cheap, the
clavicle and the spine dear, so a reaching hand uses the arm first, then the clavicle, then the trunk, and the pelvis last (table in section 5). Redundancy (an arm has 7
DOF for 3 coordinates) is spent where it is cheap, and the posture stays close to the start: this is what "posture preserving" means here.

*Limits.* Every returned pose is inside every range of motion and inside the 180 degree cap of the combined swing (`clampAngles`): a variable at a limit whose gradient pushes
outward is frozen for the step, variables that would cross a limit are clipped and frozen and the step is re-solved (active set); the cap of the shoulder is a constraint of
the step (a stiff penalty on its radial direction while it is active) followed by a projection. A start outside its ranges is repaired for the free joints; a joint that is
not free keeps exactly what the caller gave it (documented, `changed` says which joints moved).

*Jacobian.* Geometric, not by forward differences (a deviation from the first design, for speed): one `Kinematics.solve` per iteration plus the closed-form angular velocity
of every free DOF (the derivative of `exp(swing) * twist` is the left Jacobian of SO(3) applied to the DOF axis; the root orientation, the region totals with their
water-filling and the elbow / knee swivel term have their own columns). The test compares every kind of column with central differences of the forward kinematics: they agree to
1e-9. A whole-body column set costs a few dozen flops per column; forward differences would need 50 forward passes (0.9 ms) per iteration.

*Soft preferences are relaxed when they get in the way.* The stiffness, the reference pull and the pole are scaled by `mu`. If the penalised problem is stationary and a goal
is still out of tolerance, `mu` is divided by 10 (up to three times, to 0.001) and the iteration goes on. So the pose stays as close to the start as the goals allow, and the goals
are met to the tolerance whenever they can be met at all. (The finest tolerance that can be met is about 1e-7 m.)

*Restarts, deterministically.* From a far start (a hand from the hanging arm to over the head) a local method can end in a corner of the ranges. When the first run is not within
tolerance the solver tries, in this order: the analytic two-bone solution (shoulder-elbow-wrist and hip-knee-ankle, the elbow and the knee on the side of the pole direction, the
swivel about the chord sampled inside the range of motion), the other of {given start, analytic start}, the best of 40 random poses ranked by cost (seeded `mulberry32`, option
`seed`), the opposite sign of line goals (a bar axis has no direction). It stops at the first success, or when three restarts end where the best run ended (that is as close as the
pose can get), or when the best is within 3 cm and three restarts in a row did not improve it. A goal farther from the base of its chain than the straight chain is long
(`result.provablyUnreachable`) gets no restarts. No `Math.random` anywhere: same input, same bits.

*Poles.* An elbow (a knee) is kept on the side of a pole direction by a soft term (weight `poleWeight`, 0.003): defaults are down, out and a little back for the elbows, forward and a little
outward for the knees, turned with the heading of the pelvis. Override with `pole: { elbow_R: [x, y, z] }` (a world direction), switch off with `pole: { elbow_R: false }` or `poleWeight: 0`.
The pole is a preference of the swivel (null space): it never costs the goal its tolerance (the relaxation above).

## 3. Goals

`goals` is an array of objects. Common fields: `id` (a name for `result.error`, default the landmark or joint, made unique with `#2`), `weight` (default 1, 100 for a `pin`; `0` = ignored;
a goal counts `weight` times in the sum of squares, so two goals that cannot both be met are traded by weight), `tolerance` (metres, default 0.0005; a `pin` a fifth of that),
`angTolerance` (radians, default 0.002 = 0.11 degrees).

| `type` | fields | what it asks | error in `result.error[id]` |
| --- | --- | --- | --- |
| `position` | `landmark` (a landmark id of `fit.js`, or the virtual `ball_centre_L/R`) or `joint` + `local` [x, y, z] (a point in the joint's neutral frame), `target` [x, y, z] | the point is at the target | metres |
| `pin` | as `position`, `target` optional | the point stays where it is in `start` (or at `target`): almost hard (weight 100) | metres |
| `height` | `landmark` / `joint`, `height`, `direction` (default up) | the point is `height` metres along `direction` (a plane): free to move in it | metres |
| `direction` | `joint`, `axis` (a named axis or [x, y, z] in the joint frame), `target` [x, y, z] (a world direction), `line` (true: the sign does not matter) | the joint axis points along the world direction | radians |
| `aim` | `landmark` / `joint` + `local`, `axis` (default [0, 0, 1], in the joint frame), `target` (a world POINT) | the axis points from the point toward the target | radians |
| `lookAt` | `target` (a world point), `eyes` (true: each eye's gaze axis through its pupil at the target, so the eyes converge; false: the cyclopean axis of the head, `eye_mid`) | the gaze goes to the target | radians (the larger of the two eyes) |
| `frame` | `joint`, then `axes: [{ local, world, line?, weight? }, ...]` or `quaternion` [x, y, z, w] or `frame: { x, y, z }` (world directions of the joint's x, y, z), and optionally `landmark`/`local` + `target` for a position | the joint frame has this orientation (and the point is at the target) | with a position: `id` in metres and `id.rot` in radians (the worst axis); without: `id` in radians |

**Named axes** (a string for `axis` / `local`): `wrist_*`: `palm_normal`, `finger_axis`, `hand_across`; `ankle_*`, `mtp_*`: `foot_forward` (+Z at rest), `foot_up`, `sole_normal`
(down at rest); `head`, `eye_*`: `gaze` (+Z at rest), `head_up`; every other joint: `forward`, `up`, `left`. A joint's neutral frame is the world frame, so an array is a world direction in
the neutral pose.

**The hand frame** (`solver.handFrame(side)`, in the wrist frame, derived from the knuckle joints of the body): `finger_axis` runs from the wrist to the centre of the four
knuckles (an open middle finger is 9 degrees off it: the middle finger starts on the thumb side of the knuckle centre); `hand_across` is the line of the knuckles from the little
finger to the index finger, **the axis the fingers curl about**, so the axis of a gripped bar; `palm_normal` is the direction the open palm faces (toward the midline for both hands in the
neutral pose), the side the fingers curl to. Checked on the `fist`, `power`, `hook` and `open` presets of `postures/grips.js`: seen along `hand_across` the four fingertips line up (3.7 to
12 mm of spread against 25 mm along the other axes), and the fingertips are on the `palm_normal` side of the wrist.

**A grip of the catalogue.** `handFrameFromGrip({ position, normal, axis, diameter }, side)` returns the `frame` goal: `normal` (the direction the palm faces, from the hand toward the object) is
`palm_normal`, `axis` (the bar the fingers wrap around, its sign is free) is `hand_across`, and the point that goes to `position` is `grip_centre` (the axis of a handle held in the fist),
or `palm_centre` for a flat contact (`diameter` 0).

```js
const goal = handFrameFromGrip(grip, "R");            // { type: "frame", id: "hand_R", joint: "wrist_R", landmark: "grip_centre_R", target, axes: [...] }
const r = solver.solve(pose, [goal], { free: ["arm_R", "clavicle_R"] });
// r.error.hand_R = metres of the grip centre, r.error["hand_R.rot"] = radians of the palm normal / bar axis
```

With the `power` preset the four fingertips end 40 to 57 mm from the bar axis through `grip_centre` (a 30 mm bar): the closed hand of `grips.js` and the grip point of `fit.js` do not wrap a
30 mm bar tightly (decimetre order of the difference between the presets and the point, not an error of the solver).

Examples:

```js
{ type: "position", id: "hand", landmark: "grip_centre_R", target: [-0.25, 1.3, 0.5] }
{ type: "pin", landmark: "heel_sole_L" }                                  // the heel stays where it is now
{ type: "lookAt", target: displayCentre }                                 // head, neck and eyes
{ type: "direction", joint: "wrist_R", axis: "finger_axis", target: [0, 1, 0.3] }
{ type: "frame", joint: "head", quaternion: q.toArray() }
{ type: "height", landmark: "ASIS_L", height: 0.8 }                       // the pelvis at 0.8 m, free to move sideways
```

## 4. `solve(start, goals, options)` and the Result

```js
const result = solver.solve(start, goals, { free: ["arm_R", "clavicle_R"], lock: ["wrist_R.dev"], maxIterations: 60, tolerance: 0.0005 });
```

`start`: `{ root: { x, y, z, heading, flex, lat, rot }, angles: { [jointId]: number[] } }` (what `rig.getPose()` returns). Missing root fields are 0, a missing `root` is the standing body,
joints that are not listed are 0. Unknown ids and non-finite numbers throw an `Error` naming the key. **NaN, Infinity, a wrong type or an unknown landmark in a goal throw (never a silent
NaN pose)**.

| option | meaning (default) |
| --- | --- |
| `free` | what may move: names below, joint ids (`"elbow_R"`), `"joint.dof"` (`"shoulder_R.rot"`, `"lumbar.flex"`). Default `["auto"]`: the joints on the chains from the root to the goal points (no pelvis) |
| `lock` | names removed from `free` (a locked vertebra of a free region carries none of its total) |
| `maxIterations` (60), `tolerance` (0.0005 m), `angTolerance` (0.002 rad), `damping` (1e-3, initial lambda), `stepMax` (0.4: the largest change of one variable per iteration, rad or m), `angleScale` (0.3) | the iteration |
| `restarts` | most restarts. Default automatic: 8, or 1 when the worst goal error at the start is below 5 cm (a drag follows a path). `0` = none |
| `warmStart` (true), `seed` | the analytic start; the seed of the random poses |
| `stiffness` | cost lengths (m per rad), keys: a group of the table in section 5 (`"clavicle"`, `"lumbar"`), a joint id, `"joint.dof"`, `"pelvis.y"` ... |
| `reference` | a pose `{ root, angles }` the free redundancy is pulled toward (a posture the user chose: stops a drag from drifting); `referenceWeight` (0.25 of the stiffness) |
| `pole`, `poleWeight` | see section 2 |
| `rootRange` | how far the pelvis may travel from the start when it is free, 1.5 m (so that a goal a kilometre away does not launch the figure) |

**Groups for `free` / `lock`:** `arm_L arm_R arms` (shoulder, elbow, forearm, wrist), `clavicle_L clavicle_R clavicles`, `hand_L hand_R hands` (15 finger joints), `leg_L leg_R legs` (hip, knee, ankle),
`toes_L toes_R`, `trunk` (lumbar + thoracic regions), `lumbar thoracic cervical spine`, `neck` (cervical region + the head joint), `head`, `eye_L eye_R eyes`, `jaw`,
`pelvis-y`, `pelvis-xz`, `pelvis-xyz`, `pelvis-heading`, `pelvis-tilt` (flex, lat, rot), `pelvis-rot` (all four), `all` (arms, clavicles, legs, trunk, neck, eyes: no fingers, jaw, toes, pelvis),
`auto`. `FREE_GROUPS` lists them. A vertebra id (`"L3"`) is one joint with its own DOF; it is part of its region when the region is free. Individual vertebrae are the answer when the
posture has per-vertebra angles that are not the weighted shares of a region total (a region is a 3-parameter family: random per-vertebra poses are not all in it).

**Result:**

| field | meaning |
| --- | --- |
| `root`, `angles`, `pose` | the pose (`pose = { root, angles }` is what `rig.setPose` takes). `angles` holds every joint of `start` and every joint the solver touched |
| `reachable` | every goal within its tolerance |
| `converged` | the iteration ended at a stationary point or at the tolerance (false only when `maxIterations` ran out first): a best effort with `converged` and `!reachable` is final |
| `error` | per goal `id`: metres (position, pin, height, the point of a frame), radians (direction, aim, look-at, `id.rot` of a frame). `units[id]` is `"m"` or `"rad"`, `tolerance[id]` the tolerance |
| `residual` | the norm of the weighted goal residuals |
| `clamped` | the variables at a limit: `{ joint, dof, value, limit: "min" \| "max", bound, blocking }`. `blocking` is true when the goals push against it (the reason a goal is short). Regions appear as `{ joint: "lumbar", dof: "flex", region: true }`, the 180 degree cap of a shoulder as `{ dof: "swing", cap: true }` |
| `changed` | the joint ids whose angles changed; `rootChanged` |
| `iterations`, `ms` | all iterations including restarts; wall time of the call |
| `provablyUnreachable` | present (true) when a goal is farther from the base of its chain than the straight chain is long |

## 5. Stiffness (cost lengths, metres per radian)

Defaults, in `ik.js` `COST` (a joint id, `"joint.dof"` or a group overrides them with `stiffness`):

| | c | | c |
| --- | --- | --- | --- |
| shoulder (flex, abd; rot x1.5) | 0.004 | hip (flex; abd x1.2, rot x1.5) | 0.006 |
| elbow | 0.004 | knee (flex; rot x2) | 0.005 |
| forearm (pronation) | 0.006 | ankle (dorsi; inv, rot x2) | 0.006 |
| wrist (flex; dev x1.2) | 0.005 | toes (mtp) | 0.01 |
| fingers | 0.004 | head | 0.008 |
| clavicle | 0.012 | cervical region | 0.012 |
| lumbar region, thoracic region | 0.03 | eyes | 0.06 |
| individual vertebra | 0.04 | pelvis x, z (metres per metre) | 0.15 |
| pelvis y (squat) | 0.05 | pelvis heading, tilt | 0.03 |

The relative order is what matters: with equal need, the motion is shared inversely to the stiffness (so the eyes take a gaze only when the neck is out of range, and a step is the last resort).

## 6. Helpers

| function | does |
| --- | --- |
| `createSolver(body)` | the solver for a body. `solver.solve`, `solver.worldPoint(pose, landmarkOrPoint)`, `solver.handFrame(side)`, `solver.landmarkIds`, `solver.restRoot`, `solver.jacobian(...)` (diagnostics), `solver.reachEnvelope(...)` |
| `reachHand(solver, start, side, target, options)` | the hand (`landmark`: `"grip_centre"` default, `"palm_centre"`, `"index_tip"`...) to a point. Free: arm + clavicle of the side; `trunk: true` adds the spine, `pelvis: "pelvis-xz"` the steps; `frame: { normal, axis }` also orients the hand |
| `handFrameFromGrip(grip, side, options)` | the `frame` goal of a catalogue grip |
| `placeFoot(solver, start, side, { position, landmark: "ball_centre", heading, flat: true, soleNormal }, options)` | a foot on a pedal or the floor: the ball (or `heel_sole`, `toe_sole`...) at `position`, the sole horizontal (or facing `soleNormal`), the foot pointing `heading` degrees. Free: the leg |
| `lookAt(solver, start, target, { eyes: true, trunk: false, ... })` | head, neck and eyes (neck and eyes free; `trunk: true` adds the trunk). Error: radians of the gaze |
| `movePelvis(solver, start, { dy } \| { dx, dy, dz } \| { target }, { pinFeet: true, pinHands: false, pin: [ids] })` | moves the root by hand, then re-solves the legs so that the heel and both balls of each foot (and the grips with `pinHands`) stay: the squat and stand-up solver. `root.y` is exactly the requested height |
| `pinGoals(solver, start, landmarkIds)` | `pin` goals with the positions of `start` |
| `maxReach(solver, start, side, { direction, from: "shoulder", trunk })` | the farthest the hand goes from the shoulder along a direction (default: forward of the pelvis): a scan inward from the straight-chain bound, then bisection. `{ distance, point, origin, direction, result }` |
| `reachEnvelope(solver, start, side, { samples: 2000, seed: 1, trunk, clavicle, rangeFraction: 1, landmark })` | random in-ROM poses of the arm (and the trunk): `{ points: Float32Array, bounds, centroid, origin, maxDistance, farthest, hull: { vertices, faces } }`. No IK: forward kinematics of random poses (1500 points in 110 ms). `rangeFraction` < 1 samples the middle of the ranges |
| `convexHull(points)` | the 3D hull used above (closed triangle mesh, outward counter-clockwise) |
| `describeResult(result, labels)` | plain-English lines for what failed (section 8) |
| `DRAG_OPTIONS` | `{ restarts: 0, maxIterations: 24 }` for a live drag |

## 7. Examples

```js
// Hands on a grip of the catalogue, feet where they are, look at the display: three goals, one solve
const goals = [handFrameFromGrip(wheelL, "L"), handFrameFromGrip(wheelR, "R"), { type: "lookAt", id: "display", target: display }, ...pinGoals(solver, pose, ["heel_sole_R"])];
const r = solver.solve(pose, goals, { free: ["arms", "clavicles", "trunk", "neck", "eyes", "leg_L"], reference: postureOfTheLibrary });

// A drag: every frame from the previous result, no restarts, the posture the user chose as the reference
let cur = rig.getPose();
onDrag((p) => { const r = reachHand(solver, cur, "R", p, { ...DRAG_OPTIONS, reference: chosenPosture }); cur = r.pose; rig.setPose(r.pose); show(r); });

// Squat: the pelvis 0.2 m lower with both feet pinned, the trunk may tilt back to keep the balance
const sq = movePelvis(solver, pose, { dy: -0.2 }, { free: ["legs", "pelvis-tilt"] });

// Elbow pointing out, for a hand on a wall
reachHand(solver, pose, "R", wall, { pole: { elbow_R: [-1, -0.2, 0] } });
```

## 8. Failure modes and how to show them

`solve()` never throws for a goal that cannot be met and never returns a pose outside the ranges; it returns the **closest feasible pose** with `reachable: false` and the error per goal.
It throws for input that is not a goal at all (NaN, a wrong type, an unknown name). Show a failure with the numbers, never silently:

| what happened | how to see it | what to tell the user |
| --- | --- | --- |
| a goal is out of reach | `reachable` false, `error[id]` in metres, `clamped` with `blocking` joints | "The right hand cannot reach this point: 120 mm short (shoulder flexion at its maximum, clavicle protraction at its maximum)." `describeResult(r, labels)` writes it |
| the target is beyond the straight chain | `provablyUnreachable` true | "This point is farther than the arm can stretch." (no restarts were spent: instant) |
| the squat is too deep | `reachable` false, pins' `error` > tolerance (`pin:heel_sole_L` ...) | "The feet cannot stay flat this low: the ankle is at its dorsiflexion limit." The pose is the closest squat and the pins are off by the reported millimetres |
| a gaze beyond neck and eyes | `reachable` false, `error.lookAt` in radians | "The eyes cannot turn this far: 25 degrees short." |
| a posture the ranges do not allow | the pose is repaired for the free joints (`changed`), the others are unchanged | check the start with `pose.js` `clampPose` before |
| not converged | `converged` false (the iteration budget ran out) | raise `maxIterations`; rarely needed (the median is 2 to 11 iterations) |
| two goals in conflict | both `error`s above tolerance | the heavier goal (`weight`) is the closer one |

Goals the solver cannot know about: collisions (a hand inside the trunk, an elbow through the thigh: `selfPenetrations`), balance (`balance`), comfort. The ranges are a box per DOF plus the 180 degree
swing cap, so the neck, with extension, rotation and lateral bend each at their limit at once, can look nearly straight back (and the shoulder reaches farther overhead than a person with a
frozen scapula): a look at the output of the solver is still a look at a model.

## 9. Measured (Node 22, one core, this repository's bodies; `ik.test.mjs` prints them)

* **Reachable targets from the standing pose** (150 random in-ROM poses x 6 bodies: P5 woman, P50 man, P95 man, a 2.0 m man and a 1.50 m woman from stature only, one real 134.6 kg man): right palm with arm and clavicle free
  **99.3 to 99.7 %** (894 to 897 of 900 within 1 mm; the misses: 2 to 16 mm, extreme poses with several joints at a limit at once), with the trunk free (random region totals) 99.7 %, left heel with the leg free
  **100 %**, gaze (neck and eyes, error < 0.5 degree) **100 %**. Without the restarts and the analytic start the same arm test solves about 70 %: from the hanging arm, a hand over the head sits behind a singularity.
* **Hard limits**: 1,000 random goals (129 up to a kilometre away, 103 below the floor, 138 inside the body, frames, look-ats, pins; random free sets with the pelvis): 0 poses out of range, 0 non-finite numbers, 839 not reachable and reported as such.
* **Speed**: arm reach from the standing pose median **0.2 to 0.5 ms** (max 3 ms in the run printed by the test, up to 16 ms for the rare hard poses that use the restarts); a drag step of the arm 0.27 ms; whole body (5 pins, a hand goal, a look-at, every joint and the pelvis height free, 51 variables) from standing median **3.6 ms** (p90 5.7 ms), a drag step of that **0.74 ms**; a squat with pinned feet 1 to 2 ms (a squat too deep: 8 to 20 ms because of the restarts; `DRAG_OPTIONS`: 2 ms); a goal beyond the reach with the trunk free: default median 3.0 ms (max 14), `DRAG_OPTIONS` 1.8 ms.
  `createSolver` 1 to 3.5 ms. Allocation: the iteration loop is garbage-free in the parts that matter (the Jacobian, the normal equations and the line search work on typed arrays; measured with a 1 MB young generation, 19 extra iterations per solve add under 0.3 KB per iteration); a solve allocates on the order of 100 KB for the compiled problem and the pose objects of the Result, independent of the number of iterations. `maxReach` about 35 ms (90 ms with the trunk), a 1500-point envelope with hull 110 ms (do it once, not per frame).
* **Pinned feet**: the pelvis 0.2 m lower with both feet flat: the heel and both balls of each foot move less than 0.5 mm on all six bodies (hips 33 to 41, knees 74 to 88, ankles at the 35 degree dorsiflexion limit);
  0.3 m is possible for the 2.0 m man only (the others are limited by the ankle: reported with 0.6 to 7 mm of pin error).
* **Hand frame goals**: palm normal within 0.05 degree and knuckle line within 0.07 degree of the bar where the grip is reachable (31 of 36 test grips; the others are reported with the error and the limits).
* **Look-at**: gaze error < 0.5 degree for all the test directions on all six bodies; beyond the neck (80 degrees of rotation alone) the eyes take the rest (20 degrees at 100) and then the shortfall is reported.

## 10. What another module has to do, and what the solver does not

* Rebuild the solver when the body changes (`createSolver(rig.restBody)` or the `fitBody` result: both are the same figure); the solver reads `pose.js` `figureOf(body)`, so the forearm twist axis and the sternum are those the rig draws (the test sets the pose of a solve on a real rig and compares the landmarks: 1e-9 m).
* Pass `{ ...DRAG_OPTIONS }` while a handle is dragged and the default options when it is released.
* Apply the result with `rig.setPose(result.pose)`; the finger joints (grips of `postures/grips.js`) are in `start` and are returned unchanged. Set the grip after the solve if it should follow the goal.
* Placement on supports, seat height, balance and collisions stay in `pose.js`; the solver moves the pelvis only when you free it (`pelvis-*`) or call `movePelvis`.
* The ranges are `skeleton.js`'s: if a range is widened there the solver follows without a change.

Known limits: (1) a local method: a goal that needs a configuration far from the start can be missed (0.3 to 0.7 % of random in-ROM targets in the tests; the misses are reported as unreachable with the error, never as success).
(2) The pole is a preference of the swivel: a hand goal beyond the reach pulls the elbow straight regardless. (3) Region totals are a 3-parameter family per region; free the vertebrae one by one (`free: ["L1", "L2", ...]`)
for per-vertebra control. (4) The root rotation variables have no ranges but a 90 degree window about the start (heading 180). (5) `lookAt` aims the pupil axes; the cyclopean point `eye_mid` is used only with `eyes: false`.
(6) The eyes' joint `azim` is lateral-positive for both eyes (raw joint convention), so converging eyes have negative azimuth on both: use `pose.js` `copySide` / `mirrorPose` for the posture convention.
