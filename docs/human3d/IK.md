# Inverse kinematics: reach, place, look, squat

For the code that moves the figure to a goal (the posture editor's IK handles, the sandbox's "grab this grip / put the foot on that pedal / look at that
display / move the pelvis and keep the feet"). Module: `site/js/human/ik.js`. Contract: `DESIGN.md`; joints, ranges, regions: `skeleton.js`, `POSE.md`.
Tests: `node --import ./tests/human3d/register.mjs --test "tests/human3d/ik.test.mjs"` (and the independent `ik.adversarial.test.mjs`). Look at it: `tests/human3d/pages/ik-demo.html`
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
the step (a stiff penalty on its radial direction while it is active) followed by a projection. A start outside its ranges is repaired for the free joints (a vertebra of a free region
included: the region total is on top of the repaired values); a joint that is not free, and a locked vertebra, keeps exactly what the caller gave it (documented, `changed` says which joints
moved); a free shoulder that starts beyond the 180 degree cap is repaired even when the goals are already met (the one case in which an already-met start is not returned untouched). Finite but absurd start values
(a root position or a root angle, or a joint angle, beyond 1e7 metres or degrees) are an error naming the field: their squares would not fit in the sums of the solver. A start that sits exactly on the 180 degree cap is scaled by 1 - 1e-12 when the joint moves (1e-10 degrees, below the `changed` threshold of 1e-9).

*Jacobian.* Geometric, not by forward differences (a deviation from the first design, for speed): one `Kinematics.solve` per iteration plus the closed-form angular velocity
of every free DOF (the derivative of `exp(swing) * twist` is the left Jacobian of SO(3) applied to the DOF axis; the root orientation, the region totals with their
water-filling and the elbow / knee swivel term have their own columns). The test compares every kind of column with central differences of the forward kinematics: they agree to
1e-9. A whole-body column set costs a few dozen flops per column; forward differences would need 50 forward passes (0.9 ms) per iteration.

*Soft preferences are relaxed when they get in the way.* The stiffness, the reference pull and the pole are scaled by `mu`. If the penalised problem is stationary and a goal
is still out of tolerance, `mu` is divided by 10 (up to three times, to 0.001) and the iteration goes on. So the pose stays as close to the start as the goals allow, and the goals
are met to the tolerance whenever they can be met at all. (The finest tolerance that can be met is about 1e-7 m.)

*Settling.* A run stops at the first iterate within tolerance, and that iterate is on the way to the goals, not at the pose the soft preferences select among the poses that meet them: the redundancy
(the axial twist of a squatting leg, the swivel of an elbow) kept whatever the first large steps left in it, so two goals 2 mm apart could end in two poses, and a pose that was a tenth of a millimetre short of its pins
was the start of the next call. So the winner of the search is **settled**: up to 12 more iterations, with an almost undamped Gauss-Newton step, on the penalised problem (the preferences as strong as in the run that
met the goals, in the trust region of that run), and a step is taken only if it lowers F and does not make any goal worse than it was or than a quarter of its tolerance. The goals end within microns instead of tenths
of a millimetre, a squat has no twist where a twist-free squat exists (the stiffness of the axial DOF of the leg is 3 to 5 times that of the flexion), and the same pose is found from any path. It costs 1 to 5 iterations
(arm reach from standing: median 1.1 ms instead of 0.8; whole body 7 ms, as before). A start that already meets the goals is still returned untouched (no iteration at all).

*Free DOF that no goal depends on are not variables.* A finger, an eye or the other leg in a free set (`free: ["all", "hands"]` with a goal on one hand) cannot help any goal and costs time (the normal matrix grows with the
square of the variables, the Cholesky factor with the cube): such a DOF keeps the value it has, and still appears in the result. Not with a `reference` (that pulls every free variable toward the chosen posture), and
not when its start is outside its range (a free joint is repaired). `free: ["all", "hands", "pelvis-xyz"]` with conflicting goals and `restarts: 10` took a median 170 ms (p99 1 s); it takes 20 ms (p99 165 ms).

*Restarts, deterministically.* From a far start (a hand from the hanging arm to over the head) a local method can end in a corner of the ranges. The first run starts from the pose as given, unless the goals are 20 cm or more away (then there is no posture to keep and the analytic pose is the better start: elbows on the pole side, 4 iterations where the
hanging arm needs 12) or `analyticStart: true` is set (the squat: a straight leg that has to bend is a singular point, the first steps from it leave the plane of the leg). When that run is not within
tolerance the solver tries, in this order: the analytic two-bone solution (shoulder-elbow-wrist and hip-knee-ankle, the elbow and the knee on the side of the pole direction, the
swivel about the chord sampled inside the range of motion), the opposite sign of line goals from the pose as given, the best of 40 random poses ranked by cost (seeded `mulberry32`, option
`seed`). A line goal (a bar axis has no direction) takes, in **every evaluation**, the sign that is nearer to the direction the axis is at, so a wrong choice at the start is repaired on the way (the
sign used to be chosen once, from the start, and reused by every restart: 12 % of the 6D grips that are reachable by construction were missed, 2 % are now, against 1 % with the sign given). It stops at the first success, or when three restarts end where the best run ended, two of them from random poses (that is as close as the
pose can get: the runs from the start and from the analytic poses can all fall into the same corner of the ranges, and a stop on their agreement alone left some overhead targets missed by 0.4 to 0.57 m), or when the best is within 3 cm and three restarts in a row did not improve it.
**Agreement is not proof**, though: a corner (the shoulder swing at its 180 degree cap with the clavicle at the end of its range) can attract the start, the analytic poses and the best random poses alike, while a pose nowhere near them meets a goal that is reachable by construction
(2 of 7,440 targets were missed by 64 and 97 mm, and `restarts: 40` changed nothing because the list of restarts ended after 14). So a goal that is still 5 mm or more off after that gets up to 8 more random poses from the rest of the pool of 40
(`EXTRA_RESTARTS`; with an explicit `restarts` it gets what is left of that number, so `restarts` stays the most; not for a goal beyond the reach, whose closest pose has its own budget, not while following, and not for `movePelvis`: pins that cannot all be kept are over-constrained, not in a corner, and a slider calls it for every frame). A goal that the ranges do not allow, though it is not beyond the straight chain (a hand behind the back, two conflicting goals, a gaze behind the head), costs those restarts too: median 2 to 20 ms, p90 up to 40 ms, instead of 2 to 10. The misses of the same 7,440 targets: 43 before, 5 now, none over 5 mm. No `Math.random` anywhere: same input, same bits.

*A goal beyond the reach* (farther from the base of its chain than the straight chain is long: `result.provablyUnreachable`, the goals in `result.beyondReach`) cannot be met, but
the **closest pose** is still searched for: the distance to the goal has local minima (the extension limit of the shoulder, the 180 degree cap), and one run from the start sits in the
nearest one (an arm left at shoulder height, stretched backward, for a hand goal almost straight up). So the random poses come first in the restarts and the budget is spent in full
(up to 10 restarts, 20 to 60 ms), unless the first run is already as close as the straight chain allows (its cost is within 2 % of the least any pose can have). Measured against
the best of 8,000 random in-ROM arm poses (forward kinematics only): no unreachable target ends farther than the best sampled pose (46 targets; the one almost straight up and slightly back,
0.84 m from the shoulder, ends 93 mm away where 20,000 random poses give 152 mm and the single run from the start gave 803 mm). With `DRAG_OPTIONS` there are no restarts: the previous frame is the start and the arm is stretched toward the goal.

*Following a pose (a drag).* A handle moves a few millimetres per frame and the figure must follow without a visible jump, although a continuous solution exists. A local
method is not continuous by itself: the soft preferences that are absolute rather than relative to the start (the pole of the elbow) and the Gauss-Newton step (the stiffness is about 4 mm per radian,
so the first step of an iteration that starts near a joint limit is the whole way to the least squares solution: 25 degrees in one step) can carry the pose to another branch in one call. So the first run of every
solve stays in a **trust region** around the start (0.03 rad + 4 rad per metre of starting error, widened x4 at a time when the goals push a variable against its border and relaxing the preferences (mu / 10, up to three times) has not brought the worst goal error down by a tenth, or when the preferences
are exhausted and a variable sits on the border; the preferences then start over at full strength in the wider region: a squat from straight legs needs the wider region first, a hand 1 cm away does not), the start is not replaced by an analytic pose unless the goals are 20 cm or more away, and the elbows and knees keep the side they are on (below). `maxMove` bounds the change of every variable per call
(a translation counts 0.5 m per radian). With `follow: true` (or automatically, fading out between 2 and 5 cm of starting error, so that the pose is a continuous function of the goal where the
automatic follow switches on: 4.9 cm and 5.1 cm used to give postures 14 degrees apart, the median joint) a soft **avoidance of the ends of the ranges** (`limitStiffness`, 0.05 m/rad,
scaled by `mu` like the other preferences, so a goal that needs the end of a range gets it) keeps the redundant joints out of the corners where the figure would stop following (a joint at its limit,
the clavicle at both of its limits, the shoulder at the 180 degree cap). The zone of an end is the outer quarter of the range, and the avoidance is **relative to the start of the call**: it resists a joint going *deeper* into a zone than it was
(quadratic in the extra depth, so the joints that have room take the motion), and it never pulls a joint that sits in a zone out of it. The first version was an absolute pull toward the edge of the zone, and an absolute preference is what makes a pose discontinuous:
a posture that sat in a zone was carried away by a hand move of 1 cm (with the default options 114 of 243 moves of 1 cm from library postures turned some joint more than 10 degrees, 22 of them more than 40; from solved poses, 26 % of the moves of 1 to 2 cm turned one more than 10, p99 86 degrees), and a handle held still beyond the reach made the figure slide in the null
space of the arm for hundreds of frames, 2.3 degrees a frame, often in an exact two-frame cycle with `limited` true (56 % of 900 held goals still moved after 150 frames). Now a 1 to 2 cm move turns a joint 4.8 degrees at p90 and 8.2 at most (the wrist takes the move: the cheapest joint), and no
held goal (48 beyond the reach, 40 reachable ones that a drag cannot reach) moves or cycles after 260 frames. `follow: false` has none of it; it also decides the number of restarts when the first run fails (1 while following, otherwise 8). `DRAG_OPTIONS` sets `maxMove` to 0.04 rad (2.3 degrees): a handle that jumps, or a pose that is stuck, makes the figure glide toward the
goal over a few frames (`result.limited`) instead of snapping. The call returns early (status stalled) when the region is full and a goal is still 100 tolerances off, because relaxing the preferences cannot help then.
Measured, `DRAG_OPTIONS`, three bodies, 120 smooth random paths of 200 points through the whole reach zone (some through the trunk) and the head circles: the elbow moves at most 31 mm and any joint
frame 9 degrees per frame (a hand step of up to 27 mm), no path has a jump (the verifier found 54 of 120 with a jump of up to 561 mm and 176 degrees); foot and gaze drags: 20 mm and 8 degrees.

*Poles.* An elbow (a knee) is kept on the side of a pole direction by a soft term (weight `poleWeight`, 0.003). Which direction, in this order: `pole: { elbow_R: [x, y, z] }` (a world direction, not zero;
`false` switches the limb's pole off, so does `poleWeight: 0`); the side the limb has in the `reference` pose when one is given (the default pole pulled an elbow away from a chosen posture 30 times harder than the reference pull
held it: a 3 mm wiggle of the hand for 60 drag frames moved a raised elbow 227 mm; it moves 2 mm now; and the avoidance of the ends of the ranges is off for the variables whose reference value is inside the zone of an end);
otherwise the side it has in the start pose, mixed with the default as the goal gets farther (all of it up to 5 cm of error, none of it from 20 cm; `follow: true` keeps the start's side, `follow: false` takes the default; a
limb with less than 10 degrees of flexion has no side and takes the default: the hanging arm, the standing leg). The defaults are down, out and a little back for the elbows, forward and a little
outward for the knees, turned with the heading of the pelvis. The pole is a preference of the swivel (null space): it never costs the goal its tolerance (the relaxation above).

## 3. Goals

`goals` is an array of objects. Common fields: `id` (a name for `result.error`, default the landmark or joint, made unique with `#2`), `weight` (default 1, 100 for a `pin`; `0` = ignored; a finite number from 0 to 1e12, also the `weight` of an entry of `axes` and `normalWeight` / `axisWeight` of `handFrameFromGrip` (the product with the goal weight must stay within it);
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

**Named axes** (a string for `axis` / `local`): `wrist_*`: `palm_normal`, `finger_axis`, `hand_across`, `knuckle_line`; `ankle_*`, `mtp_*`: `foot_forward` (+Z at rest), `foot_up`, `sole_normal`
(down at rest); `head`, `eye_*`: `gaze` (+Z at rest), `head_up`; every other joint: `forward`, `up`, `left`. A joint's neutral frame is the world frame, so an array is a world direction in
the neutral pose.

**The hand frame** (`solver.handFrame(side)`, in the wrist frame, derived from the knuckle joints of the body): `finger_axis` runs from the wrist to the centre of the four
knuckles (an open middle finger is 9 degrees off it: the middle finger starts on the thumb side of the knuckle centre); `hand_across` is the line of the knuckles from the little
finger to the index finger, **the axis the fingers curl about**, so the axis of a gripped bar; `palm_normal` is the direction the open palm faces (toward the midline for both hands in the
neutral pose), the side the fingers curl to. `knuckle_line` is the line through the landmarks `metacarpale_radiale_*` / `metacarpale_ulnare_*` (what a measurement along the knuckles
sees, as in `measure.js`): in the neutral pose it is 5.8 degrees (man) to 6.3 degrees (woman) from `hand_across` (the joints of the knuckles and the heads of the metacarpals are not on one line); `solver.handFrame(side).line` is it.
The palm normal is the same in both conventions (0.0 degrees). Grips use `hand_across` (the fingers curl about the joints); name `knuckle_line` for a direction goal that follows the landmarks. Checked on the `fist`, `power`, `hook` and `open` presets of `postures/grips.js`: seen along `hand_across` the four fingertips line up (3.7 to
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
| `maxIterations` (60), `tolerance` (0.0005 m), `angTolerance` (0.002 rad), `damping` (1e-3, initial lambda), `stepMax` (0.4: the largest change of one variable per iteration, rad or m), `angleScale` (0.3) | the iteration. Every number is checked: a string, NaN, Infinity (a tolerance), zero or a negative `stepMax`, a float `seed` or `maxIterations` throw |
| `restarts` | most restarts. Default automatic: 8, or 1 when the worst goal error at the start is below 5 cm (a drag follows a path), or 10 for a goal beyond the reach (the closest pose is searched for), plus up to 8 more random poses for a goal that is still 5 mm off or more (section 2). `0` = none. Always 0 with `maxMove` |
| `follow` | `true`: the start is the previous frame of a drag (the avoidance of the ends of the ranges at full strength, the side of the elbows and knees of the start, 1 restart); `false`: none of that (the default side of the elbows and knees, 8 restarts); default automatic (the worst start error is below 5 cm, the avoidance fading out between 2 and 5 cm). See section 2 |
| `maxMove` | the largest change of any variable per call, radians (a translation counts 0.5 m per radian); `result.limited` says the figure is still on its way. Default unlimited; `DRAG_OPTIONS`: 0.04 |
| `limitStiffness` | cost length of the soft avoidance of the ends of the ranges, 0.05 m/rad; only while following a pose unless given |
| `warmStart` (true), `analyticStart` (false), `seed` | `warmStart`: the analytic two-bone poses may be used (as restarts, and as the first run from 20 cm of error); `analyticStart: true`: the first run starts from the analytic pose (what `movePelvis` does: a straight limb that has to bend is a singular point of the pose as given); not with `maxMove`; the seed of the random poses |
| `stiffness` | an object of cost lengths (m per rad). Keys (a key that is not one of these is an error, a typo is not ignored): a group of the table in section 5 (`"clavicle"`, `"shoulder"` for both sides, `"lumbar"`, `"hand"` for all the finger joints, `"vertebra"` for every individual vertebra), a joint id (`"shoulder_R"`, `"L3"`), `"joint.dof"` of a sided joint, of both sides or of a vertebra (`"shoulder_R.flex"`, `"shoulder.flex"`, `"L3.flex"`, `"eye_L.azim"`), a region with its channel (`"lumbar.flex"`), the pelvis (`"pelvis"`, `"pelvis.x"`, `"pelvis.y"`, `"pelvis.heading"`, `"pelvis.tilt"` = flex, lat and rot). The most specific key wins: `"shoulder_R.flex"` over `"shoulder.flex"` over `"shoulder_R"` over `"shoulder"` |
| `reference` | a pose `{ root, angles }` the free redundancy is pulled toward (a posture the user chose: stops a drag from drifting; the sides of its elbows and knees become their poles, section 2); `referenceWeight` (0.25 of the stiffness: a joint moves a fifth of the way per call; 4 holds it tight; a number >= 0, checked also without a reference). `null` or absent: none. Unknown joints, non-finite angles and root fields throw |
| `pole`, `poleWeight` | `pole`: `{ elbow_R: [x, y, z] \| false, ... }` (an object, not zero vectors), `poleWeight` 0.003; see section 2 |
| `rootRange` | how far the pelvis may travel from the start along **each** of x, y and z when it is free, 1.5 m (so that a goal a kilometre away does not launch the figure; in the plane it ends at most 1.5 m x sqrt 2 away) |

**Groups for `free` / `lock`:** `arm_L arm_R arms` (shoulder, elbow, forearm, wrist), `clavicle_L clavicle_R clavicles`, `hand_L hand_R hands` (15 finger joints), `leg_L leg_R legs` (hip, knee, ankle),
`toes_L toes_R`, `trunk` (lumbar + thoracic regions), `lumbar thoracic cervical spine`, `neck` (cervical region + the head joint), `head`, `eye_L eye_R eyes`, `jaw`,
`pelvis-y`, `pelvis-xz`, `pelvis-xyz`, `pelvis-heading`, `pelvis-tilt` (flex, lat, rot), `pelvis-rot` (all four), `all` (arms, clavicles, legs, trunk, neck, eyes: no fingers, jaw, toes, pelvis),
`auto`. `FREE_GROUPS` lists them. A vertebra id (`"L3"`) is one joint with its own DOF; it is part of its region when the region is free. Individual vertebrae are the answer when the
posture has per-vertebra angles that are not the weighted shares of a region total (a region is a 3-parameter family: random per-vertebra poses are not all in it).

**Result:**

| field | meaning |
| --- | --- |
| `root`, `angles`, `pose` | the pose (`pose = { root, angles }` is what `rig.setPose` takes). `angles` holds every joint of `start` and every joint the solver touched. `pose` is a copy: editing `result.root` or `result.angles` in place does not change `result.pose` (and the other way round); the inputs are never aliased either |
| `reachable` | every goal within its tolerance |
| `converged` | the iteration ended at a stationary point or at the tolerance (false only when `maxIterations` ran out first): a best effort with `converged` and `!reachable` is final |
| `error` | per goal `id`: metres (position, pin, height, the point of a frame), radians (direction, aim, look-at, `id.rot` of a frame). `units[id]` is `"m"` or `"rad"`, `tolerance[id]` the tolerance |
| `residual` | the norm of the weighted goal residuals |
| `clamped` | the variables at a limit: `{ joint, dof, value, limit: "min" \| "max", bound, blocking, pushedBy }`. `blocking` is true when the goals push against it (the reason a goal is short); `pushedBy` lists `{ goal, force }` for each goal that pushes on it, strongest first (the limits of the right foot's pins are not the left knee's). Regions appear as `{ joint: "lumbar", dof: "flex", region: true }`, the 180 degree cap of a shoulder as `{ dof: "swing", cap: true }` |
| `changed` | the joint ids whose angles changed; `rootChanged` |
| `iterations`, `ms` | all iterations including restarts; wall time of the call |
| `provablyUnreachable`, `beyondReach` | present (true, and the ids of those goals) when a goal is farther from the base of its chain than the straight chain is long: the pose is the closest the search found |
| `limited` | present (true) when `maxMove` stopped the figure short of the goal, a variable ended on the border of its region: it is still on its way, call again with the pose. A pose that does not move any more (a local minimum of a drag: the goal is reachable, the drag is stuck) is **not** limited, so a caller can tell "on its way" from "stuck" and fall back to a full solve (`editor.js` does) |

## 5. Stiffness (cost lengths, metres per radian)

Defaults, in `ik.js` `COST` (the keys of `stiffness` that override them are listed in section 4: a group, a joint id, `"joint.dof"`, a region with its channel, the pelvis; a value given for a key applies to every DOF it names, without the `x1.5`-type factors of the table):

| | c | | c |
| --- | --- | --- | --- |
| shoulder (flex, abd; rot x1.5) | 0.004 | hip (flex; abd x2, rot x4) | 0.006 |
| elbow | 0.004 | knee (flex; rot x5) | 0.005 |
| forearm (pronation) | 0.006 | ankle (dorsi; inv x3, rot x5) | 0.006 |
| wrist (flex; dev x1.2) | 0.005 | toes (mtp) | 0.01 |
| fingers | 0.004 | head | 0.008 |
| clavicle | 0.012 | cervical region | 0.012 |
| lumbar region, thoracic region | 0.03 | eyes | 0.06 |
| individual vertebra | 0.04 | pelvis x, z (metres per metre) | 0.15 |
| pelvis y (squat) | 0.05 | pelvis heading, tilt | 0.03 |

The relative order is what matters: with equal need, the motion is shared inversely to the stiffness (so the eyes take a gaze only when the neck is out of range, and a step is the last resort).
`stiffness: { "shoulder_R.flex": 5 }` makes one DOF dear (the elbow and the clavicle take the reach), `{ "pelvis": 0.0005 }` makes a step cheap, `{ "L3.flex": 0.0005, "L4.flex": 5 }` shares a lean between individual vertebrae you freed.

## 6. Helpers

| function | does |
| --- | --- |
| `createSolver(body)` | the solver for a body. `solver.solve`, `solver.worldPoint(pose, landmarkOrPoint)`, `solver.handFrame(side)`, `solver.landmarkIds`, `solver.restRoot`, `solver.jacobian(...)` (diagnostics), `solver.reachEnvelope(...)` |
| `reachHand(solver, start, side, target, options)` | the hand (`landmark`: `"grip_centre"` default, `"palm_centre"`, `"index_tip"`...) to a point. Free: arm + clavicle of the side; `trunk: true` adds the spine, `pelvis: "pelvis-xz"` the steps; `frame: { normal, axis }` also orients the hand |
| `handFrameFromGrip(grip, side, options)` | the `frame` goal of a catalogue grip |
| `placeFoot(solver, start, side, { position, landmark: "ball_centre", heading, flat: true, soleNormal }, options)` | a foot on a pedal or the floor: the ball (or `heel_sole`, `toe_sole`...) at `position`, the sole horizontal (or facing `soleNormal`), the foot pointing `heading` degrees. Free: the leg |
| `lookAt(solver, start, target, { eyes: true, trunk: false, ... })` | head, neck and eyes (neck and eyes free; `trunk: true` adds the trunk). Error: radians of the gaze |
| `movePelvis(solver, start, { dy } \| { dx, dy, dz } \| { target }, { pinFeet: true, pinHands: false, pin: [ids], anchor })` | moves the root by hand, then re-solves the legs so that the heel and both balls of each foot (and the grips with `pinHands`) stay: the squat and stand-up solver. `root.y` is exactly the requested height. The pinned points stay where `anchor` (a pose, default `start`) has them: **a slider that calls this for every height passes the pose it started from as `anchor`** (and the pose of the previous call as `start`), otherwise each call pins the feet where the previous one left them, a few micrometres short of the pins, and 250 calls of 1 mm let them creep 10 mm (0.35 mm now; 0.001 mm with the anchor). It starts the legs from the analytic two-bone pose (a straight leg that has to bend is a singular point of the pose as given) and has no avoidance of the ends of the ranges (the squat comes near the ankle's dorsiflexion limit by design). Do not pass `DRAG_OPTIONS`: `maxMove` bounds the joints of the legs, not the root, and a straight leg does not start to bend under a bounded step, so the feet stay behind the pelvis (200 mm at 10 mm per frame); the squat costs 1 to 4 ms, call it with the default options for every frame |
| `pinGoals(solver, start, landmarkIds)` | `pin` goals with the positions of `start` |
| `maxReach(solver, start, side, { direction, from: "shoulder", trunk })` | the farthest the hand goes from the shoulder along a direction (default: forward of the pelvis): a scan inward from the straight-chain bound, then bisection; every probe is a `reachHand` with the automatic restarts (it used 3, and a backward direction such as `[0, 0.3, -1]` was underestimated by 3 cm in 8 of 180 cases). `{ distance, point, origin, direction, result }` |
| `reachEnvelope(solver, start, side, { samples: 2000, seed: 1, trunk, clavicle, rangeFraction: 1, landmark })` | random in-ROM poses of the arm (and the trunk): `{ points: Float32Array, bounds, centroid, origin, maxDistance, farthest, hull: { vertices, faces } }`. No IK: forward kinematics of random poses (1500 points in 110 ms). `rangeFraction` < 1 samples the middle of the ranges |
| `convexHull(points)` | the 3D hull used above (closed triangle mesh, outward counter-clockwise) |
| `describeResult(result, labels)` | plain-English lines for what failed (section 8). `labels`: an object `{ goalId: words }` or a function (`goalLabel`); without one the id is shown |
| `goalLabel(id)` | a goal id in words: `"pin:heel_sole_R"` -> "Right heel sole (pinned)", `"hand_R.rot"` -> "Right hand orientation" |
| `warmUp(solver, rounds = 2)` | runs the hot paths on throw-away poses so that the JIT has compiled them: the first 100 solves of a page take up to 25 to 40 ms (a drag stutters), later ones 1 ms. Call it once after `createSolver` when the page is idle (130 ms on a quiet machine, 330 to 570 ms measured on a loaded one). Changes nothing else; returns the ms |
| `DRAG_OPTIONS` | `{ restarts: 0, maxIterations: 24, follow: true, maxMove: 0.04 }` for a live drag (frozen): no jump of the figure, section 2 |

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

// A squat slider: every frame from the previous pose, the feet pinned where the pose the slider started from had them (no creep), default options
const home = rig.getPose();
let cur = home;
onSlider((height) => { const r = movePelvis(solver, cur, { target: [home.root.x, height, home.root.z] }, { anchor: home }); cur = r.pose; rig.setPose(cur); });

// Elbow pointing out, for a hand on a wall
reachHand(solver, pose, "R", wall, { pole: { elbow_R: [-1, -0.2, 0] } });
```

## 8. Failure modes and how to show them

`solve()` never throws for a goal that cannot be met and never returns a pose outside the ranges; it returns the **closest feasible pose** with `reachable: false` and the error per goal.
It throws for input that is not a goal at all (NaN, a wrong type, an unknown name). Show a failure with the numbers, never silently:

| what happened | how to see it | what to tell the user |
| --- | --- | --- |
| a goal is out of reach | `reachable` false, `error[id]` in metres, `clamped` with `blocking` joints and their `pushedBy` | "The right hand cannot reach this point: 120 mm short (shoulder flexion at its maximum, clavicle protraction at its maximum)." `describeResult(r, labels)` writes it, naming for each goal the limits that push against that goal |
| the figure is still on its way | `limited` true | "still on its way": a drag step moves a joint a few degrees at most; keep calling with the result as the start |
| the target is beyond the straight chain | `provablyUnreachable` true | "This point is farther than the arm can stretch." (no restarts were spent: instant) |
| the squat is too deep | `reachable` false, pins' `error` > tolerance (`pin:heel_sole_L` ...) | "The feet cannot stay flat this low: the ankle is at its dorsiflexion limit." The pose is the closest squat and the pins are off by the reported millimetres |
| a gaze beyond neck and eyes | `reachable` false, `error.lookAt` in radians | "The eyes cannot turn this far: 25 degrees short." |
| a posture the ranges do not allow | the pose is repaired for the free joints (`changed`), the others are unchanged | check the start with `pose.js` `clampPose` before |
| not converged | `converged` false (the iteration budget ran out) | raise `maxIterations`; rarely needed (the median is 2 to 11 iterations) |
| two goals in conflict | both `error`s above tolerance | the heavier goal (`weight`) is the closer one |

Goals the solver cannot know about: collisions (a hand inside the trunk, an elbow through the thigh: `selfPenetrations`), balance (`balance`), comfort. In particular a drag has no collision model and the side of the elbow is a soft preference (the pole, kept as the start has it by `follow`): a hand dragged across the body can carry the elbow through the trunk, continuously (not as a flip; the elbow moves at most 64 mm per frame). Measured with `DRAG_OPTIONS` on 150 random hand paths of 200 points: in 9 paths (60 of 29,850 frames) the elbow came within 7 cm of the pelvis-to-C7 axis while the hand was more than 30 cm from it. A reach from a standing start has 0 such poses in 1,568 solves. Check a posture with `selfPenetrations` when it matters. The ranges are a box per DOF plus the 180 degree
swing cap, so the neck, with extension, rotation and lateral bend each at their limit at once, can look nearly straight back (and the shoulder reaches farther overhead than a person with a
frozen scapula): a look at the output of the solver is still a look at a model.

## 9. Measured (Node 22, one core, this repository's bodies; `ik.test.mjs` prints them)

* **Reachable targets from the standing pose** (150 random in-ROM poses x 6 bodies: P5 woman, P50 man, P95 man, a 2.0 m man and a 1.50 m woman from stature only, one real 134.6 kg man): right palm with arm and clavicle free
  **99.4 to 99.8 %** (895 to 898 of 900 within 1 mm; the misses: 2 to 16 mm, extreme poses with several joints at a limit at once; over 7,440 arm solves on 186 bodies, the 176 population medians and 10 real people, both arms:
  **99.93 %** within 1 mm, 5 misses (1 to 5 mm), none over 5 mm; before the extra restarts of section 2 it was 99.42 %, 43 misses, 27 over 10 mm, two of 64 and 97 mm). An earlier version missed some overhead targets by 0.4 to 0.57 m (the shoulder swing at 180 degrees, the elbow bent: a corner of the ranges, and restarts that all ended in it); they are solved now (the restarts do not stop before two random poses have been tried). Targets 0.45 m or more above the shoulder, reachable by construction: 358/360 within 1 mm, the worst miss 4 mm), with the trunk free (random region totals) 99.7 %, left heel with the leg free
  **100 %**, gaze (neck and eyes, error < 0.5 degree) **100 %**. Without the restarts and the analytic start the same arm test solves about 70 %: from the hanging arm, a hand over the head sits behind a singularity.
* **Hard limits**: 1,000 random goals (129 up to a kilometre away, 103 below the floor, 138 inside the body, frames, look-ats, pins; random free sets with the pelvis): 0 poses out of range, 0 non-finite numbers, 839 not reachable and reported as such.
* **Speed** (a quiet machine; the figures of an earlier version in brackets): arm reach from the standing pose median **0.9 to 1.2 ms** (0.4 to 0.7; max 5 ms in the run printed by the test, up to 20 ms for the rare hard poses that use the restarts, 40 to 190 ms for the rarest ones that use the extra random restarts); a drag step of the arm 0.4 ms (p99 1.1 to 2.2 ms); whole body (5 pins, a hand goal, a look-at, every joint and the pelvis height free, 51 variables) from standing median **7 ms** (5.4; p90 11 ms), a drag step of that median **2 to 2.7 ms** (1.2 to 2.3; p95 6 ms, p99 8.5 ms on a quiet machine; on a loaded 4-core one (load average 9 to 12) p95 up to 9 and p99 up to 13 ms, against a frame budget of 12; a frame that hits the 24-iteration cap costs about 17 ms, and a whole body with two hands and the pelvis rotation free reached p99 19 ms. the first frames of a drag that starts far from the goal glide over some 15 frames, each of 10 to 20 iterations); a squat with pinned feet 1 to 4 ms (a squat too deep: 8 to 20 ms because of the restarts); a goal beyond the reach with the trunk free: default median 23 ms (max 40 to 70, the closest pose is searched for with up to 10 restarts), `DRAG_OPTIONS` 1.0 ms.
  `createSolver` 1 to 3.5 ms (median 1 ms, max 7 ms over 184 bodies). The first ~100 solves of a page are JIT-cold (up to 25 to 40 ms for a drag frame): `warmUp(solver)` once when the page is idle (130 ms on a quiet machine, 330 to 570 ms on one at a load of 9 to 12; the first solve then takes 1 to 50 ms and the worst of the first 100 25 to 70 ms). Allocation: the iteration loop is garbage-free in the parts that matter (the Jacobian, the normal equations and the line search work on typed arrays; measured with a 1 MB young generation, 19 extra iterations per solve add under 0.3 KB per iteration); a solve allocates on the order of 100 KB for the compiled problem and the pose objects of the Result, independent of the number of iterations. `maxReach` about 70 to 110 ms (340 ms at worst, more with the trunk: every probe is a solve with the automatic restarts), a 1500-point envelope with hull 110 ms (do it once, not per frame).
* **Pinned feet**: the pelvis 0.2 m lower with both feet flat: the heel and both balls of each foot move less than 0.5 mm on all six bodies (hips 33 to 41, knees 74 to 88, ankles at the 35 degree dorsiflexion limit);
  0.3 m is possible for the 2.0 m man only (the others are limited by the ankle: reported with 0.6 to 7 mm of pin error). Down to 0.1 m (0.15 m for most bodies) the squat is the sagittal one: axial twist of hip, knee and ankle
  0.2 to 1.0 degree (it was 4 to 26) on all six bodies, the same pose with `follow: true`; beyond the depth at which the ankle's dorsiflexion limit is reached (0.2 m for a man P50) the legs have to splay (hip abduction and rotation 15 to 38 degrees:
  reachable only so, `lock` of the axial DOF is not reachable there). Scrubbing the height in steps of 3 mm: no joint turns more than 4 to 5 degrees between reachable heights, except at the one height where the knees-out branch stops being
  reachable and the knock-kneed one is (a man P50 at 0.279 m: 77 degrees; the pose set is not connected there). 250 calls of 1 mm from the previous pose: the feet creep 0.35 mm (10 mm before), with `anchor` 0.001 mm.
* **Posture preservation**: the hand 8 cm from the hand of each of the 99 library postures (both hands, six directions, about 1,400 reachable cases): about 35 turn a joint more than 40 degrees (225 before); 33 of them are a straight limb that has to bend
  (the hanging arm, the hand 8 cm up: the chord must be 8 cm shorter, which is 45 to 60 degrees of elbow whatever the solver does) and turn as far with `follow: true`. Goals 4.7 and 5.3 cm from the hand give postures 1.2 degrees apart (median joint, p90 2.8; 14 before). A goal 1 cm from the hand, default options: 2 to 4 of 250 moves turn a joint more than 10 degrees (the wrist of an arm that hangs almost straight), none more than 14 (114 of 243 and 22 over 40 before; from solved poses, 1 to 2 cm: p90 4.8, p99 7, max 8 degrees against 39, 86 and 177).
  A 3 mm wiggle of the hand for 60 drag frames moves a raised elbow 1.7 mm with `reference`, 10 mm without (227 and 237 before); out and back by 15 cm with `reference: start` the elbow ends 0.7 mm from where it was (median; 40 mm).
* **Hand frame goals**: palm normal within 0.05 degree and knuckle line within 0.07 degree of the bar where the grip is reachable (31 of 36 test grips; the 5 others are wall-push grips with the arm almost stretched, at the extension limit of the shoulder: 1 to 8 mm and below 1 degree short, and neither 40 restarts nor either sign of the axis solves them: they are not a sign artefact; reported with the error and the limits). Grips that are reachable by
  construction (position, palm normal and bar axis of a random in-ROM arm pose, the sign of the axis free), solved from the standing start: 293 of 300 (98 %; 257 before), against 296 with the sign given (the misses are 1 to 37 mm and 0.5 to 8 degrees, poses with several joints at a limit).
* **Look-at**: gaze error < 0.5 degree for all the test directions on all six bodies; beyond the neck (80 degrees of rotation alone) the eyes take the rest (20 degrees at 100) and then the shortfall is reported.

## 10. What another module has to do, and what the solver does not

* Rebuild the solver when the body changes (`createSolver(rig.restBody)` or the `fitBody` result: both are the same figure); the solver reads `pose.js` `figureOf(body)`, so the forearm twist axis and the sternum are those the rig draws (the test sets the pose of a solve on a real rig and compares the landmarks: 1e-9 m).
* Pass `{ ...DRAG_OPTIONS }` while a handle is dragged and the default options when it is released; pass the posture the user chose as `reference` to both (the sides of its elbows and knees are kept, and the release is not a jump: from within 20 cm of error the default options start from the pose as it is, in a trust region, and settle it). `movePelvis` is not a drag: default options, `anchor`.
* Apply the result with `rig.setPose(result.pose)`; the finger joints (grips of `postures/grips.js`) are in `start` and are returned unchanged. Set the grip after the solve if it should follow the goal.
* Placement on supports, seat height, balance and collisions stay in `pose.js`; the solver moves the pelvis only when you free it (`pelvis-*`) or call `movePelvis`.
* The ranges are `skeleton.js`'s: if a range is widened there the solver follows without a change.

Known limits: (1) a local method: a goal that needs a configuration far from the start can be missed (0.07 % of random in-ROM targets in the tests, up to 5 mm; the misses are reported as unreachable with the error, never as success).
(1b) The pose is not a continuous function of the goal for a solve that starts far from it (from 20 cm of error): the arm has a continuum of solutions, the analytic start picks one, and the run that follows stays near it, which
depends on the path of the iteration. 2 mm apart, from the same hanging arm, about 8 % of pairs of in-ROM targets differ by more than 5 degrees or 3 cm at the elbow, 1.7 % by more than 30 degrees or 10 cm, 0.3 % by more than 90 degrees
(smaller steps halve this and cost iterations; no setting removes it). A drag does not have this problem (section 2: it follows); do not call a far solve per frame. For the same reason, mirrored goals pick a different arm configuration for L and R in about 1 of 450 cases.
(2) The pole is a preference of the swivel: a hand goal beyond the reach pulls the elbow straight regardless. (3) Region totals are a 3-parameter family per region; free the vertebrae one by one (`free: ["L1", "L2", ...]`)
for per-vertebra control. (4) The root rotation variables have no ranges but a 90 degree window about the start (heading 180). (5) `lookAt` aims the pupil axes; the cyclopean point `eye_mid` is used only with `eyes: false`.
(6) The eyes' joint `azim` is lateral-positive for both eyes (raw joint convention), so converging eyes have negative azimuth on both: use `pose.js` `copySide` / `mirrorPose` for the posture convention.
(7) `lookAt` with `eyes: false` and the target at `eye_mid` itself throws (the direction is undefined), like an `aim` at the point that aims. (8) The first ~100 solves of a page are JIT-cold: `warmUp`.
(9) A limb that is straight and has to bend is a singular point (a straight leg shortens with the square of the bend): a local step from it stalls or leaves the plane of the limb. `movePelvis` (`analyticStart`) and goals 20 cm or more away start from the analytic pose; a call with `maxMove`
cannot (the legs stay behind the pelvis, `limited` or not). (10) The penalised problem has more than one local minimum along the manifold of the solutions (the knees out or in at a depth the ankle cannot take); the solver finds the one its start leads to, which is the
twist-free one for every squat tried down to 0.1 m. (11) The pole mix is a function of the error of the goal, not of the pose: a hand that is dragged slowly away from its start for 20 cm changes the side of its elbow gradually, not at once.
(12) The time of a solve is not bounded by a clock (the result must not depend on the speed of the machine): a click-to-solve call with some 70 variables that matter (a whole body free with a hand, a foot, a look-at and conflicting goals) and `restarts: 10` can take 0.1 to 0.5 s (idle variables cost nothing now); `restarts`, `maxIterations` (the budget of each run: 100,000 with conflicting goals takes seconds) and the free set are the knobs.
(13) A drag has no collision model: the elbow can pass through the trunk while the hand crosses the body (section 8).
