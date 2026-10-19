# Postures and poses: how a posture is defined, expanded, placed and validated

For people who write postures (`site/js/human/postures/*.js`) and for the code that uses them (`pose.js`, the editor, the sandbox).
Contract: `DESIGN.md` 2.4 (the Posture schema), rules: `POSTURES.md`, joint maths: `skeleton.js`. This file is the manual.
Tests: `node --import ./tests/human3d/register.mjs --test "tests/human3d/pose.test.mjs" "tests/human3d/postures.test.mjs"`.
To look at a posture (body, collision proxies, seat plane, support polygon, centre of mass): the page `tests/human3d/pages/pose-demo.html`, e.g.
`python3 tests/human3d/shot.py "/__pages/pose-demo.html?size=800" out.png --w 800 --h 800 --wait-fn window.__ready --eval 'window.__demo.library("iso-7250-sitting", { az: 70, dist: 3.2 })'`.

The model is a simplified kinematic visualisation (rigid links, approximate joint centres and ranges, no soft-tissue model). A posture
that passes the validator is geometrically sane for that body, not proven to be comfortable, safe or healthy.

## 1. Posture, pose, placement

* A **posture** is a library entry (`Posture`, below): author-friendly (`hip_LR`, spine regions, grip presets) plus what carries the weight.
* A **pose** is `{ root: { heading, flex, lat, rot }, angles: { [jointId]: number[] } }`: concrete joint ids, degrees, the DOF order
  of `skeleton.js`; exactly what `rig.setPose` takes, minus the root position. Joints that are not listed are 0.
* **Placement** adds the root position `x, y, z`: where the body stands, sits or lies, so that the support rests on a surface.
  A posture never stores a position.

```
Posture --expandPosture--> pose --clampPose--> pose --placePose(body, pose, {support, ...})--> root {x, y, z, heading, flex, lat, rot}
                                                               rig.setPose({ root, angles }, { clamp: true })
```

### The Posture object

```js
{
  id: "sit-reach-forward-panel",          // kebab-case, unique in the whole library
  name: "Seated, reaching forward to a panel",   // short and plain
  category: "Sitting",                    // the `name` of an entry of CATEGORIES (13, see below)
  tags: ["seat", "reach", "one-hand"],    // lower-case words
  description: "…one or two sentences: what it is and what it is for",
  source: "ISO 11226 …",                  // where the angles come from, or "illustrative"
  root:   { heading: 0, flex: 0, lat: 0, rot: 0 },             // pelvis orientation, degrees; NEVER a position
  spine:  { lumbar: [flex, lat, rot], thoracic: […], cervical: […] },   // region totals, degrees
  joints: { "hip_LR": [90, 0, 0], "knee_L": [80, 0], "head": [5, 0, 0], "L3": [2, 0, 0] },
  grips:  { L: "relaxed", R: "point" },   // a key of GRIPS (postures/grips.js)
  support: "seat+feet",                   // what carries the weight: a key of SUPPORT_CARRIERS
  contacts: ["heel_sole_L"],              // optional: landmarks that must touch (within 15 mm)
  hints:  { seat: { height: "popliteal" }, dynamic: false, externalSupport: false, contactTolerance: 0.015, load: { mass: 12 } },
}
```

Required: `id name category tags description source support`. Everything else defaults to "neutral". Unknown top-level keys draw a warning.

**Categories** (`CATEGORIES`, display order): Standing, Sitting, Leaning, Holding, Lifting & carrying, Reaching, Kneeling & squatting, Lying,
Locomotion, Work, Military, Vehicle & cockpit, Reference. The file `postures/<id>.js` of a group only holds postures of that category
(`standing sitting leaning holding lifting reaching kneeling lying locomotion work military vehicle reference`).

## 2. Angle conventions

* Degrees, in the **joint's DOF order** (the index column below). Trailing zeros may be omitted (`knee_LR: [90]`), an array longer than the DOF
  count or empty is an error. Flexion, abduction and internal rotation are **positive**; `_LR` means the same anatomical movement on both sides
  (the right joint is the mirror image of the left one), so a symmetric posture is written once. Explicit `_L` / `_R` entries override `_LR`.
* The **neutral pose** is every angle 0: standing, arms hanging at the sides (abducted 3 to 14 degrees: the model's arm, not the shoulder joint), forearms in
  mid-position, palms facing the thighs, feet flat and parallel, the spine in its natural standing curvature (lumbar `flex = 0` is the natural
  lordosis, not a straight back).
* **Spine** by region: `spine: { lumbar: [flex, lat, rot], … }` are *totals* over the region (5 lumbar, 12 thoracic, 7 cervical vertebrae), shared by
  the vertebrae with fixed weights (`REGIONS` in `skeleton.js`). Vertebra ids (`L3`, `T8`, `C5`) in `joints` are added on top. A vertebra that would leave its own range takes
  no more of the total and the rest is redistributed over the others (water-filling, exact: `expandSpine`); a total that the whole region cannot take is an error
  (`spine lumbar flex: requested 90°, the vertebrae of the region can take 60°`). **An explicit vertebra angle beyond that vertebra's own range is an error as well, and the
  vertebra keeps the value you wrote** (`L3 flex = 40° is outside the range of motion [-6.7, 11.5]`): it is never moved onto its neighbours. `head` (occiput-C1) is separate from `cervical`.
* **Root** (`root`): `heading` is the world yaw (+ = turn left), `flex` / `lat` / `rot` tilt and twist the pelvis, and with it the whole body, about the pelvis:
  `flex` −90 lies the body on its back (supine), +90 on its front (prone), `lat` ±90 on a side. They are not limited.
* **Eyes**: in a posture `eye_LR: [elev, azim]` has `azim` + = both eyes look toward the figure's left (the right eye's joint angle is the negation: `expandSides`). Raw joint angles
  (`rig.setAngles`, `Kinematics`) are lateral-positive on both sides.
* **Hands**: `grips: { L, R }` gives the 15 finger joints of a hand from a preset; list a finger joint in `joints` to override it.
* **`pelvis` is not a joint key** of a posture (the root drives it).
* A joint can have two swing DOF and a twist (shoulder, hip, ankle, vertebrae): the direction the bone points depends on the two swing DOF only; the twist (internal / external rotation,
  inversion, axial rotation) turns it about its own axis. Combined swing is capped at 180 degrees in total (shoulder flexion 150 plus abduction 150 is an error).

### The joints and their angles

Generated from `site/js/human/skeleton.js` by `scripts/human_dof_table.mjs`; do not edit it by hand. Regenerate this table with
`node scripts/human_dof_table.mjs --update-docs` (the test `pose.test.mjs` fails when it is out of date). The ranges are active ranges of the whole
joint complex, widened where the library needs it (deep squats, kneeling on the heels, cross-legged sitting); `approx.` sources are listed in `skeleton.js`.
Per-vertebra ranges are the region range times the level's share (`REGIONS`).

<!-- dof-table:begin -->
| Joint key in a posture | Index | DOF | Positive means | Negative means | Range (deg) |
| --- | --- | --- | --- | --- | --- |
| `root` | - | `heading` | turns to the figure's left | turns right | -180 to 180 |
| `root` | - | `flex` | tilts forward | tilts back | -180 to 180 (not limited) |
| `root` | - | `lat` | tilts to the figure's left | tilts right | -180 to 180 (not limited) |
| `root` | - | `rot` | twists to the figure's left | twists right | -180 to 180 (not limited) |
| `spine.lumbar` | 0 | `flex` | forward bend | extension | -35 to 60 (total over 5 vertebrae) |
| `spine.lumbar` | 1 | `lat` | bend to the figure's left | bend to the right | -25 to 25 (total over 5 vertebrae) |
| `spine.lumbar` | 2 | `rot` | turn to the figure's left | turn to the right | -12 to 12 (total over 5 vertebrae) |
| `spine.thoracic` | 0 | `flex` | forward bend | extension | -25 to 45 (total over 12 vertebrae) |
| `spine.thoracic` | 1 | `lat` | bend to the figure's left | bend to the right | -20 to 20 (total over 12 vertebrae) |
| `spine.thoracic` | 2 | `rot` | turn to the figure's left | turn to the right | -40 to 40 (total over 12 vertebrae) |
| `spine.cervical` | 0 | `flex` | forward bend | extension | -60 to 50 (total over 7 vertebrae) |
| `spine.cervical` | 1 | `lat` | bend to the figure's left | bend to the right | -35 to 35 (total over 7 vertebrae) |
| `spine.cervical` | 2 | `rot` | turn to the figure's left | turn to the right | -70 to 70 (total over 7 vertebrae) |
| `head` | 0 | `flex` | nod forward | tilt head back | -25 to 20 |
| `head` | 1 | `lat` | tilt to the figure's left | tilt right | -10 to 10 |
| `head` | 2 | `rot` | turn to the figure's left | turn right | -10 to 10 |
| `jaw` | 0 | `open` | opens | closes / protrudes | -5 to 35 |
| `eye_LR` | 0 | `elev` | looks up | looks down | -45 to 35 |
| `eye_LR` | 1 | `azim` | gaze toward the figure's left (both eyes; the right eye's joint angle is the negation, expandSides) | gaze toward the figure's right | -45 to 45 |
| `clavicle_LR` | 0 | `elev` | lateral end up | lateral end down | -10 to 45 |
| `clavicle_LR` | 1 | `prot` | lateral end forward (protraction) | lateral end back (retraction) | -25 to 25 |
| `shoulder_LR` | 0 | `flex` | arm forward / up | arm back (extension) | -60 to 180 |
| `shoulder_LR` | 1 | `abd` | arm out to the side | arm across the body (adduction) | -50 to 180 |
| `shoulder_LR` | 2 | `rot` | internal rotation | external rotation | -90 to 90 |
| `elbow_LR` | 0 | `flex` | forearm forward / up | hyperextension | -5 to 150 |
| `forearm_LR` | 0 | `pron` | pronation (palm turns back / down) | supination | -90 to 90 |
| `wrist_LR` | 0 | `flex` | palmar flexion (hand toward the palm side) | extension (dorsiflexion) | -70 to 80 |
| `wrist_LR` | 1 | `dev` | radial deviation (thumb side, forward) | ulnar deviation | -30 to 20 |
| `thumb_cmc_LR` | 0 | `flex` | thumb folds across the palm | extension (thumb out in the palm plane) | -25 to 50 |
| `thumb_cmc_LR` | 1 | `abd` | away from the palm plane, in front of the palm (toward the side the palm faces) | back toward the plane of the palm (adduction) | -10 to 70 |
| `thumb_mcp_LR` | 0 | `flex` | curls across the palm | extension | -5 to 55 |
| `thumb_ip_LR` | 0 | `flex` | curls across the palm | hyperextension | -15 to 85 |
| `{index,middle,ring,little}_mcp_LR` | 0 | `flex` | curls toward the palm | extension | -25 to 90 |
| `{index,middle,ring,little}_mcp_LR` | 1 | `abd` | away from the middle finger | toward the middle finger | -20 to 20 |
| `{index,middle,ring,little}_pip_LR` | 0 | `flex` | curls toward the palm | none (no hyperextension) | 0 to 110 |
| `{index,middle,ring,little}_dip_LR` | 0 | `flex` | curls toward the palm | hyperextension | -10 to 90 |
| `hip_LR` | 0 | `flex` | thigh forward | thigh back (extension) | -20 to 135 |
| `hip_LR` | 1 | `abd` | thigh out to the side | thigh across the midline (adduction) | -30 to 60 |
| `hip_LR` | 2 | `rot` | internal rotation (toes turn in) | external rotation (toes turn out) | -60 to 50 |
| `knee_LR` | 0 | `flex` | heel toward the buttock | hyperextension | -5 to 160 |
| `knee_LR` | 1 | `rot` | internal rotation | external rotation | -40 to 30 |
| `ankle_LR` | 0 | `dorsi` | toes up (dorsiflexion) | toes down (plantarflexion) | -60 to 35 |
| `ankle_LR` | 1 | `inv` | sole turns medially (inversion) | sole turns laterally (eversion) | -25 to 40 |
| `ankle_LR` | 2 | `rot` | toes turn in | toes turn out | -30 to 20 |
| `mtp_LR` | 0 | `dorsi` | toes bend up (heel raise) | toes curl down | -45 to 80 |
<!-- dof-table:end -->

Frequently needed: the **ankle** order is `[dorsi, inv, rot]` (inversion is the *second* value); the **knee** is `[flex, rot]`; the **elbow** has one value; **forearm** pronation
is its own joint (`forearm_LR: [pron]`) and the **wrist** is `[flex, dev]`; `hip_LR: [flex, abd, rot]` with `rot` + = internal rotation (toes in).

## 3. From posture to pose: `expandPosture`

`expandPosture(posture)` returns `{ root, angles, grips }`:

1. `root`: the four fields, default 0. `x`, `y`, `z` are an error ("a posture has no position").
2. `grips`: each hand's preset becomes its 15 finger joints (`thumb_cmc_L`, …, `little_dip_R`).
3. `spine` totals and vertebra ids in `joints` go through `expandSpine` (the exact version of `skeleton.js` `expandRegions`: a level pinned at its limit is freed again when the others would take more, and an addition beyond its vertebra's range stays as written).
4. `joints` goes through `expandSides` (`_LR` first, then explicit `_L` / `_R`), and overrides what the grips set.

`angles` lists only the joints that the posture specifies or that come out non-zero; every other joint is 0 (the rig treats missing as 0, and
`rig.setPose` resets the joints that are not listed). Each array has the joint's DOF count. The call throws an `Error` that names the posture id and the key
(`posture "x": joints.hip: unknown joint id: "hip" needs a side, write hip_LR (both), hip_L or hip_R`) for unknown ids, unknown grips, wrong array lengths and
non-finite numbers. `validatePosture` catches that error and reports it.

Other helpers of `pose.js` work on poses (never mutating their input): `clampPose(pose)` → `{ pose, clamped: [{ joint, dof, requested, applied }] }`,
`mirrorPose(pose)` (left and right exchanged; unpaired joints keep flexion and negate lateral bend and axial rotation; heading, root lat and rot are negated; an involution),
`copySide(pose, "L")` (the editor's "mirror left to right": the other side gets the same anatomical angles, the eyes keep looking the same way),
`blendPoses(a, b, t)` (joints with two swing DOF: the bone direction moves on the great circle when that provably stays inside the range of motion and away from the pole
(swing under 140 degrees), else along the straight line of the two swing angles, which cannot leave the box of the ranges; the twist linearly; hinges linearly; heading the short way
round; t = 0 and 1 exact; **the blend of two poses inside the ranges is inside them for every t**, so an animation between two library postures never needs `clamp`, and a raised arm does not
flick), `poseEquals(a, b, eps)`, `neutralPose()`, `figureOf(body)` (below).

**Which figure.** Everything in `pose.js` poses the figure the RIG draws, whether you pass a `fitBody` result or `rig.restBody`: the forearm twist axis is moved from the elbow to the
wrist and the sternum landmarks ride on T4, exactly as `rig.js` does (`rig.restBody` is that figure; for it the call changes nothing). Before this was done a pronated forearm put every forearm,
wrist, hand and fingertip landmark 20 to 50 mm off the drawn figure, more than the contact and hand-overlap tolerances. `figureOf(body)` returns the body in that form when you need the
matching offsets elsewhere (a `Kinematics`, `bodyProxies`). If `rig.js` ever rebases differently, `pose.test.mjs` ("a plain body gives the same figure") fails.

## 4. Support, placement and hints

`support` says what carries the weight. Placement (`placePose`) puts the **lowest point of the first carrier** (the primary one) exactly on its surface and the
horizontal centroid of ALL its contact points at the anchor (default x = z = 0). The other carriers are reported, and the validator requires them to touch.
`SUPPORT_CARRIERS` (and `SUPPORT_INFO`, one line each):

| `support` | carriers (set → surface), primary first | use for |
| --- | --- | --- |
| `feet` | `feet` → floor | standing, walking, squatting and stooping with the soles flat; one foot or both (the lowest sole point touches) |
| `seat` | `seat` → seat | sitting on a seat plane with the feet free; `hints.seat.height: 0` = sitting on the floor |
| `seat+feet` | `seat` → seat, `feet` → floor | sitting with the feet on the floor |
| `knees` | `knees` → floor | kneeling on one or both knees / shins, the feet free (kneeling on the heels) |
| `knees+toes` | `knees` → floor, `toes` → floor | kneeling upright with the toes on the floor |
| `knees+feet` | `knees` → floor, `feet` → floor | half kneeling: one knee down, the other foot flat |
| `hands-knees` | `knees` → floor, `palms` → floor | quadruped, crawling |
| `hands-feet` | `feet` → floor, `palms` → floor | push-up, bear crawl, plank |
| `elbows-knees` | `knees` → floor, `elbows` → floor | low crawl, kneeling on the forearms |
| `body` | `body` → floor | lying: the lowest points of the skin (the superellipse sections of the shape rings, `lowestSkinPoint`, plus fingers, foot and toes, the toe and finger tips counted at the tip landmark, not one end-sphere radius beyond it) and of every landmark rest on the floor; the sections are interpolated between the shape rings the way the skin is, so the rig's skin is within 5 mm of the floor in 99.8 % of 1,320 body x position checks (every fourth population x P5/P50/P95 x supine, prone, on either side, rolled 20, 45 and 70 degrees from supine and prone; worst 5.5 mm; the upper arm of those sections is narrowed to the measured bideltoid breadth like the skin, which removed floats of up to 16 mm for the 95th-percentile body of three populations lying on a side). Postures that are tilted only part of the way and lie on a wedge (root flex -20, or -45 with a roll of 45) are not what this support is for and sink up to 8 and 21 mm; the anchor is the horizontal position of the centre of mass |

The contact sets are those of `body.contacts` (MODEL.md section 5: `feet seat knees hands elbows back front side_L side_R head`) plus the derived `toes` (`toe_tip_L/R`),
`heels`, `palms` (`palm_centre_L/R`), `shins`, `kneecaps`. A support that you need and that is not in the table: ask for it in `pose.js` rather than faking it with `hints`.

`placePose(body, pose, options)` → root `{ x, y, z, heading, flex, lat, rot }`; `options`: `support` (default `"feet"`) or `posture`; `carriers` (`{ set: surfaceName }`);
`surfaces` (`{ floor: 0, seat: 0.45, desk: 0.74 }`, heights in metres of horizontal planes); `anchor` (`{ x, z }`); `heading` (degrees added to the posture's heading: the body turns about
the vertical through the anchor, the carrier centroid stays put). `placePoseDetailed` returns the report in the open: `{ root, gaps: { [set]: metres }, primary, carriers, surfaces }`
(`gaps` = height of the lowest point of each carrier above its surface: 0 for the primary, > 0 floats, < 0 sinks). `contactClearances(body, pose, root, surfaces, carriers)`
lists every contact point with its clearance. Support and surface names are looked up as own properties: `"toString"`, `"constructor"` and `"__proto__"` are errors like any other unknown name.

### The seat

For supports with a `seat` carrier the seat plane is `hints.seat.height`: a number in metres (a bench at 0.45; `0` = the floor), or `"popliteal"` (the default). **`"popliteal"` is the seat
height at which the ISO 7250-1 posture (hips 90, knees 90, ankles 0) has the soles on the floor**, per body (`seatHeightFor(body)`: the lowest point of the `seat` contact
set when that posture stands on the floor, about 350 to 450 mm). It is not the popliteal landmark of the body (they differ by −30 to +40 mm for population boundary cases) and it includes
no shoe. With it, the 90-90-90 posture touches the floor for every body, and your angles decide how much the feet float or press.

### Hints

| hint | meaning |
| --- | --- |
| `seat: { height }` | seat plane, see above |
| `dynamic: true` | a moment of a movement (swing phase, flight, push-off): the balance rule is not applied |
| `externalSupport: true` (or the name: `"wall"`, `"table"`) | something else carries part of the weight: the balance rule and the secondary carriers are not applied. Declared `contacts` still are |
| `contactTolerance: 0.03` | allowed gap for the secondary contacts (default 15 mm, at most 40 mm). For postures with several contacts (hands and knees, push-up) where body proportions make 15 mm impossible with fixed angles; the validator warns that it is used |
| `load: { mass: 12, landmarks? }` | a held weight in kg, added at the mean of the landmarks (default both `grip_centre`s) in the centre-of-mass check: a box, a tool, a rifle |

## 5. What the validator checks (`validatePosture`)

`validatePosture(body, posture, { library, seatHeight, contactTolerance })` → `{ ok, errors, warnings, metrics }`. It never throws for a bad posture. The options override the hints for one call: `seatHeight` is `"popliteal"` or 0 to 1.5 m, `contactTolerance` 0 to 0.1 m (a hint may only declare up to 0.04); a value outside that (NaN, a string, 5) is an error of the result, named `options.contactTolerance must be …`, and the default is used for the rest of the checks, so that nothing is waived silently. A missing `id`, `category` or `support` is reported as missing (`support is missing: it must be one of: …`). A gap is printed with one decimal when it is within a millimetre of its limit (`15.1 mm above the floor … within 15 mm`), and the right eye's azimuth in the convention you wrote (`eye_R azim = 60° is outside …`). `metrics`: `romViolations`, `regionShortfalls`, `gaps`
(per carrier), `clearances` (declared contacts), `penetrations`, `worstPenetration`, `balanceMargin` (m, positive = inside the support polygon), `seatHeight`, `root`, `com`.
`tests/human3d/postures.test.mjs` runs it on six bodies (median man, median woman, 5th-percentile woman, 95th-percentile man, a stature-only 1.70 m man, one real heavy man) for every
posture of the library; the test lists every problem as `body | posture id | message`.

| rule (POSTURES.md) | what is checked | typical message and the fix |
| --- | --- | --- |
| schema | kebab-case unique `id` (`options.library`), `category` in CATEGORIES, `name`, `description`, `source`, lower-case `tags`, known `support`, known landmarks in `contacts`, well-formed `hints` | `category "sitting" is not one of: …` → use the `name` of the category (capital S); `duplicate id "x" in the library` → rename |
| expansion | the errors of `expandPosture` | `posture "x": joints.bogus_LR: unknown joint id` → see the joint table; `joints.hip: … needs a side` → `hip_LR` |
| 2 range of motion | every angle inside its range, the 180 degree swing cap, spine region totals | `shoulder_R flex = 200° is outside the range of motion [-60, 180] (clamps to 180°)` → reduce it; `spine lumbar flex: requested 90°, the vertebrae of the region can take 60°` → put the rest in the thoracic region or the hips |
| 3 support | the posture is placed (floor, and a seat plane); the primary carrier touches by construction; every other carrier of the support and every landmark in `contacts` is at most 15 mm above its surface and not more than 5 mm below; no landmark is more than 5 mm below the floor; with a seat, no landmark of the pelvis, lower spine and hips behind the front of the contact points (as far back as the buttocks reach when the pelvis is tilted back) is more than 5 mm below the seat plane (`1 landmark would sink into the seat: buttock_extremity by 26 mm`; the greater trochanters are not counted: they are bony points on the side of the hip that ride on the hip joint, and external rotation of the thigh swings them up to 35 mm below the plane of the ischial tuberosities, where a real seat gives 20 mm or more; "behind" and "beside" are measured in the body's own horizontal frame, so turning the posture about the vertical, with `root.heading` or `root.rot`, never changes the verdict), and without a seat the skin is not more than 20 mm below the floor | `contact set "feet": its lowest point is 54 mm above the floor (the posture is placed by its seat on a seat plane of 428 mm; support "seat+feet" needs the feet to touch within 15 mm)` → change knee / ankle / hip angles until the feet land (the gap is a number to aim at; try the median body first); `6 landmarks are below the floor: toe_sole_L by 29 mm, …` → the pose pushes through the floor: wrong support, or an angle too large |
| 5 gross self-intersection | the 39 capsule proxies of `proxies.js`: hands (palm and five fingers), forearms, arms, legs, feet, head against the rest, with a tolerance per pair; two kinds of overlap are judged on the skin sections instead, because a capsule cannot do it (`skinPenetrations`): the **upper arm against the trunk** (the shoulder joint lies inside the chest capsule, so that pair cannot be tested there; an arm swung back through the thorax passed with 100 to 135 mm of skin inside the trunk) and a **hand against the head** (the head capsule is 87 mm in radius for the median man, 10 mm wider than the head at the temples and 11 mm short at the face; the palm capsule is 25 mm thick for a 12 mm palm). `upper_arm_L and trunk overlap by 89 mm (more than 50 mm): the upper arm passes through the trunk: check the shoulder angles`, `head and thumb_L overlap by 47 mm (more than 21 mm): a hand is inside the body`. A palm laid on the temple is fine (4 % of 212 sampled touching poses rejected, all with an edge of a tilted palm 22 to 35 mm inside the skull), a palm 25 to 70 mm inside is rejected in 97 % | `pelvis_R and palm_L overlap by 68 mm (more than 21 mm): a hand is inside the body: check the shoulder, elbow and wrist angles`. Hands may rest on the body (up to about 20 mm into it), arms hang against the trunk (up to 50 mm), thighs press into the belly and chest (up to 110 mm), legs may cross (up to 25 to 55 mm). All tolerances grow with the body-mass index, ×min(1.8, BMI / 24), and a pair that overlaps more than that in the reference postures of this very body (ISO 7250-1 standing and sitting, the T-pose; thighs of a boundary-case P5 body: 61 mm in the neutral pose, the neck against the raised arms of a 1.31 m woman of 180 kg) is allowed the depth it has there plus 6 mm, so the reference postures are never rejected for the body's own geometry. The hint names the hand for any of its parts (palm, thumb, index, middle, ring, little finger) |
| 6 balance | for supports on the feet, knees or hands (not `seat` alone, not `body`): the centre of mass projected on the floor is within 40 mm of the convex hull of the carrier points that touch (within 15 mm of their surface); `hints.dynamic` / `externalSupport` waive it, `hints.load` adds a held weight. For `support: "knees"` (feet free) the shin landmarks count as touching up to 30 mm, not 15: with the knee front on the floor the shin point of a shank lying on it is 25 mm up, and without it the support of an upright kneeling body would be the segment between the two knees. Kneeling on the heels (centre of mass 200 mm behind the knees) still needs `hints.externalSupport`. A body without `masses` gets an error instead (a centre of mass at the origin would be compared with the polygon) | `the centre of mass is 117 mm outside the support polygon (limit 40 mm; …)` → move the hips back / the weight over the feet; or declare `hints.dynamic`, `hints.externalSupport` or `hints.load` |
| 4 hands (warning) | a hand with neither a `grips` preset nor finger joints in `joints` | `no grip for the left hand (rule 4: choose a preset of GRIPS, e.g. grips: { L: "relaxed" })` |
| 7 symmetry (warnings) | tag `"symmetric"` with unequal sides; `_L` and `_R` written separately with equal values; sides that differ by less than 2° | `hip_L and hip_R are written separately with equal values: use hip_LR` |

How the proxies look (see `proxies.js`): head, neck, the trunk in three parts (pelvis, abdomen, chest) each a pair of capsules left and right of the midline (an ellipse in section is a
stadium), a shoulder-girdle capsule, buttock spheres, upper arms, forearms, palms and five finger capsules per hand (knuckle to tip, following the grip), thighs in two pieces, shanks, kneecaps, feet,
toes: 39 capsules. A limb capsule is fitted to all the rings of its tube (the rings are not on a line), radii come from the shape rings so they follow the body's girths. Measured against
the skin of `body.js` (the worst vertex outside every capsule, 16 bodies, neutral pose): limbs 13 to 32 mm, hands and fingers 2 to 21, buttocks 22, pelvis 40, head, neck, foot and toes 30 to 36,
chest 55 and abdomen 58 (corners of boxy sections, which a stadium cannot follow), the groin of a seated body 70. Coarse on purpose: the checks have tolerances, and the lowest point of a lying body
does not use the capsules but the skin sections themselves (`lowestSkinPoint`). `capsuleOverlap` is exact for tapered capsules (the maximum of r1 + r2 - distance over both axes, by a closed form along one
axis and a bisection along the other). Cost (Node 22, median man): `proxyWorld` + `lowestPoint` about 1 microsecond, + `lowestSkinPoint` 17, the 621 pair checks of `selfPenetrations` about 60.

The skin-section checks (`armTorsoDepth`, `handHeadDepth`, both called by `skinPenetrations`): the boundary of every section of the upper arm (12 points of the superellipse, the shoulder section excepted) is looked up in the posed stack of trunk and neck sections (the two sections whose planes enclose the point, the depth `(1 - f) * min(rx, rz)` in each, `f` the superellipse norm, interpolated by the distance to the planes), and the allowed depth is the 50 mm of soft tissue that may give (crossed arms, a hand on the opposite shoulder) or the depth the arm has in the reference postures of this very body plus 3 mm, whichever is more (a 95th-percentile man's hanging arm is 57 mm inside his trunk outline, a 5th-percentile woman's 9). A hand is tested against the head sections in the head joint's own frame: the palm by the boundary of its sections (12 points each), each finger by three spheres along its capsule (knuckle, middle, tip pulled back by its radius) whose radius is added to the depth of their centre, 20 mm of tolerance times the body-mass factor; the test is skipped when the middle of the palm is more than 0.4 m from the head joint. Cost: `armTorsoDepth` about 20 microseconds, `handHeadDepth` a few microseconds with the hands away from the head and about 20 with one near it.

The sections that carry a lying body (`lowestSkinPoint`) follow the skin of `body.js` in one more respect: the upper arm is narrowed to the measured bideltoid breadth exactly as `fitArmToDeltoid` does for the mesh (no section within 40 mm of the deltoid and above it reaches beyond half the breadth, further down the outer edge may grow by 0.25 per unit of height, at most 12 mm). The outer edge of the upper arm is what rests on the floor when the body lies on its side, and the fit's deltoid ring is up to 34 mm wider than the mesh; without this the 95th-percentile body of three populations floated 11 to 16 mm.

Known limits: (0) the 95th-percentile man's arm hangs 57 mm inside the outline of his trunk in the neutral pose (the fitted arm and trunk of a wide body overlap), so the upper-arm check allows him only 3 mm more adduction than that: crossed arms with the shoulders adducted more than a few degrees are rejected for him and not for the median man (use a little shoulder rotation or less adduction); the head capsule is still used for the pairs of the head with the arms, forearms, legs and trunk (a forearm along the temple can overlap it by 56 mm against a tolerance of 52). (1) the neutral centre of mass of a fitted body is only about 2 mm (-2 to +7) in front of the ankle joint centre, 11 % of the foot length from the heel, where quiet standing is 20 to 50 mm in front of it: the balance rule is a little too generous backwards and too strict forwards, on tiptoe and in a deep squat. The cause is the placement of the masses and landmarks in `fit.js` (`pose.test.mjs` has an open `todo` test for it). (2) The proxies are capsules: a hand 25 mm thick is judged by a fitted capsule, and the lowest point of a lying body is the loft of the sections, not the skin mesh (see the table). (3) A body far beyond the data (BMI above about 100) has more soft tissue than any tolerance here is meant for; the reference postures still pass because the tolerances adapt to them, other postures are judged at the capped factor of 1.8.

## 6. A worked example: seated, reaching forward

Goal: a seated posture, right arm reaching to a panel, left hand in the lap, feet on the floor.

```js
{
  id: "sit-reach-forward-panel",
  name: "Seated, reaching forward to a panel",
  category: "Sitting",
  tags: ["seat", "reach", "one-hand", "forward"],
  description: "Seated upright on a seat at popliteal height, the right arm reaching forward and slightly up to press a control; the left hand rests in the lap.",
  source: "illustrative",
  support: "seat+feet",                                  // seat carries the weight, the feet must touch the floor
  spine: { lumbar: [8, 0, 0], thoracic: [8, 0, 0] },     // 16 degrees of forward lean, shared by the vertebrae
  joints: {
    hip_LR: [90, 0, 0], knee_LR: [90, 0],                // 90-90-90 (ISO 7250-1): the feet land on the floor
    shoulder_R: [75, 0, 0], elbow_R: [15],               // right arm forward, almost straight
    shoulder_L: [15, 0, 0], elbow_L: [60],               // left forearm up, hand in the lap
    head: [-5, 0, 0],
  },
  grips: { L: "relaxed", R: "point" },                   // finger joints come from GRIPS; nothing to write
  // hints.seat.height defaults to "popliteal": the seat at which 90-90-90 puts the soles on the floor
}
```

Steps: (1) start from the closest reference (`iso-7250-sitting`: hips and knees 90); (2) add the spine lean as region totals, not as 24 vertebra values; (3) write the arms with
`_R` / `_L` because they differ (the symmetric legs use `_LR`); (4) pick grips; (5) run the validator on the median man, then on the six bodies of `postures.test.mjs`:

```js
import { validatePosture } from "../site/js/human/pose.js";
const r = validatePosture(body, posture, { library: POSTURES });   // r.ok, r.errors, r.warnings, r.metrics.gaps / balanceMargin
```

This one passes with `gaps: { seat: 0, feet: 0 }` and a balance margin of 76 to 97 mm on the six bodies. Change `knee_LR` to `[60, 0]` and the feet leave the floor:
`contact set "feet": its lowest point is 54 mm above the floor (…)`; change `shoulder_R` to `[200, 0, 0]` and the range of motion rule names the joint, the DOF and the range. (This example is
also run by `pose.test.mjs`, so it cannot rot.)

## 7. Checklist before you add a posture

1. `id` kebab-case and new (the aggregator throws at import time on a duplicate); `category` is the `name` of the group file's category.
2. `name` short and plain, `description` says what it is and what it is for, `source` cites the reference (ISO 7250-1, ISO 11226, RULA/REBA, NIOSH, SAE J826, TC 3-22.9, Winter, Perry,
   Kapandji, Pheasant and Haslegrave, …) or says `"illustrative"`; tags lower-case.
3. Angles in the model's convention (table above), `_LR` for symmetric parts, spine by region. Look at the posture in the viewer from the front and the side, on the median man and woman.
4. `support` is what really carries the weight; `seat.height` set for chairs that are not at popliteal height; `contacts` only for landmarks that must touch (`heel_sole_L`, `ball_sole_medial_L`,
   `toe_sole_L`, `ischial_L`, `knee_front_L`, `shin_L`, `palm_centre_L`, `scapula_back_L`: the `contact`-kind landmarks of MODEL.md section 5, not the bony points above the skin).
5. Hands: a `grips` preset per hand.
6. `hints.dynamic` for moments of a movement, `hints.externalSupport` when a wall, table, rail or the other hand carries weight, `hints.load` for a held mass.
7. `validatePosture` clean on the six bodies (`postures.test.mjs`); read the warnings too.

## 8. Reference

| name | in | what |
| --- | --- | --- |
| `CATEGORIES`, `SUPPORT_CARRIERS`, `SUPPORT_INFO` | `pose.js` | the 13 groups (`{ id, name, blurb }`), the supports and their carriers |
| `expandPosture`, `expandSpine`, `clampPose`, `mirrorPose`, `copySide`, `blendPoses`, `poseEquals`, `neutralPose` | `pose.js` | posture → pose and pose algebra; `expandSpine(spine, perVertebra)` is the region distribution on its own |
| `placePose`, `placePoseDetailed`, `contactClearances`, `seatHeightFor`, `solvePose`, `landmarkPosition`, `figureOf` | `pose.js` | placement on supports, clearances, the shared kinematics of a body, the figure the rig draws |
| `centerOfMass`, `balance` | `pose.js` | centre of mass (optionally with a held load), static balance against a support polygon |
| `validatePosture` | `pose.js` | the rules above |
| `bodyProxies`, `proxyWorld`, `lowestPoint`, `lowestSkinPoint`, `capsuleOverlap`, `overlapAt`, `selfPenetrations`, `skinPenetrations`, `armTorsoDepth`, `handHeadDepth`, `worldCapsule`, `pairTolerance`, `PROXY_GROUPS` | `proxies.js` | the 39 capsules and the skin sections of a body, and what is done with them; `skinPenetrations(proxies, kin, world, { slack, all })` has the form of `selfPenetrations` for the overlaps judged on the skin sections (upper arm against the trunk, hand against the head), `armTorsoDepth(proxies, kin)` → `{ L, R }` and `handHeadDepth(proxies, kin, world)` → `[{ part, depth }]` are the depths behind it (m, positive = inside) |
| `GRIPS`, `GRIP_NAMES`, `HAND_JOINTS`, `gripAngles` | `postures/grips.js` | hand presets: relaxed, open, flat, fist, power, precision, hook, trigger, point, wheel, pinch, cup, thumbsup, spread, tripod, lateral, spherical, typing, mouse; the open grips match their descriptions in size (median man, thumb tip to index fingertip: `spherical`, a 60 mm ball, 45 mm; `cup`, a 70 mm cup or ball, 51 mm; `power` 18 mm and `wheel` 1 mm, the pad-to-pad grips, 15 to 25 mm) |
| `POSTURES`, `GROUPS`, `CATEGORIES`, `GRIPS`, `byId`, `byCategory`, `search`, `indexGroups` | `postures.js` | the library, **deeply frozen** (copy a posture before you edit it: `structuredClone(p)`); every entry has `joints` and `spine` objects; `search("squat lift")` is case, diacritics and word-order insensitive (every word must occur in the name, description, tags or category) |

Cost (Node 22, one core, median man, measured with `performance.now` over thousands of calls): `kin.solve` 13 microseconds, `placePose` 20 (support `body`: 55), `centerOfMass` 20, `blendPoses` of two poses with all 77 joints 105, `validatePosture` 0.3 to 0.4 ms, so an editor can place the figure and look at the proxies on every drag event.
