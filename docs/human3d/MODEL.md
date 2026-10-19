# Human body model: from an anthropometric profile to a rigged, measured body (`fit.js`)

Module: `site/js/human/fit.js` (pure, no DOM; imports only `skeleton.js` and `fk.js`). Contract: `docs/human3d/DESIGN.md` 2.2.
Tests: `node --import ./tests/human3d/register.mjs --test "tests/human3d/fit.test.mjs"`.

This document is written for the engineer who builds the rig and the skin (`rig.js`, `body.js`) and for whoever changes a constant: section 1 is the
output contract, sections 2 to 4 say where every number comes from and in what order the inputs are used, section 5 to 8 describe landmarks, shape,
masses and the fit report, section 9 lists the data tables, section 10 the validation, section 11 what the model is not.

Conventions (all of them): metres, kilograms, degrees (profiles are in millimetres, `fit.js` converts); +Y up, +Z anterior (the way the figure faces), +X is the
figure's LEFT; every `_L` joint, landmark or ring is on +X and its `_R` twin is the exact mirror image (`x -> -x`); the neutral pose has every joint angle
0 and every local frame aligned with the world, so the rest offset of a joint is the difference of the neutral world positions of the joint centres;
numbers are rounded to the micrometre (`r6`) so that the output is the same on every platform; nothing is random: the same profile gives the same body.

## 1. The BodyModel (what `fitBody(profile, opts)` returns)

`fitBody(profile, { form, overrides })`. `profile` is a Profile of `anthro.js` (`{ id, label, sex, source, measures: { key: { value, unit } } }`; any subset of
measures, even none). `form`: `"male" | "female" | "neutral"` (default from `profile.sex`: `M` male, `F` female, `both` or unknown neutral; neutral is the mean of the two
templates, section 2.2). `overrides`: `{ dimensionId: metres }` (the user's edits of the mapping table, section 2.3) and `ring_<name>: metres` (girths).
It never throws for any profile or options (even `undefined`, `null`, an empty object, NaN, unknown units, keys or units named like `constructor` or `__proto__`: the lookup tables have no prototype; Symbols, `valueOf` or getters that throw, proxies that refuse: the profile and the options are read once through a guarded copy, and what cannot be read counts as absent): it falls back to the median adult of the form and says so in `warnings`. It takes 3 to 5 ms.

| field | content |
|---|---|
| `version` | 1 |
| `profileId`, `label`, `sex` | copied from the profile (`sex` is `"both"` when absent) |
| `form`, `formFactor` | `male`/`female`/`neutral` and 1 / 0 / 0.5: the weight of the men's template |
| `stature`, `mass` | m, kg as used (stature exact; mass clamped to 25..300 kg, and the dimension record says so) |
| `dims` | the mapping table: array of dimension records (1.2) |
| `d` | the same values by id, `d.femur_length` etc. (m; `mass` in kg): convenient for code |
| `joints` | `{ jointId: { offset: [x, y, z] } }` for all 77 joints of `skeleton.js` (1.1) |
| `positions` | `{ jointId: [x, y, z] }` neutral world positions (the cumulative sum of the offsets, plus the pelvis offset) |
| `landmarks` | `{ id: { joint, offset, label, group, kind } }`, 120 of them (section 5) |
| `contacts` | named sets of landmark ids: `feet, seat, knees, hands, elbows, back, front, side_L, side_R, head` (section 5) |
| `shape` | lofting data for the skin: tubes of superellipse rings, head, hands, feet, volume (1.3, section 6) |
| `masses` | `{ segmentId: { label, mass, fraction, com: { joint, offset }, comFraction, proximal, distal } }`, 16 segments (section 7); this is the shape `rig.js` reads |
| `massInfo` | `{ total, fractionSum, com, source, form }`: whole-body totals of the segments (standing COM in world coordinates) |
| `inputs` | `{ key: value }` the profile measures that were understood, in m / kg |
| `rejected` | `{ key: reason }` inputs ignored because they are implausible (2.1); a stature outside 1.3 to 2.5 m and a mass outside 10 to 400 kg are among them |
| `warnings` | array of strings, de-duplicated; to be shown to the user |
| `report` | fit report rows (section 8) |
| `reportSummary` | counts of ok / warn / off / n/a, dimension counts by status, `closure` (stature and sitting height deltas in mm) |
| `spine` | `{ balanceRotationDeg, t1SlopeDeg, kyphosisDeg, lordosisDeg, cervicalDeg, sagittalOffsetM, l5BehindHipM }` the curve that was baked in |
| `stance` | `{ ankleBehindKneeM, shankLeanDeg, comAheadOfAnkleM, comFromHeel, ankleFromHeel }`: how far the ankles are behind the knees in the neutral pose (the lean of quiet standing, 4.1), the neutral centre of mass in front of the ankle joint centre and as a fraction of the foot length from the heel (7.1), and the ankle axis as a fraction of the foot length from the heel (4.1) |

### 1.1 Joints

* `joints[id].offset` is the rest offset relative to the parent joint (`skeleton.js` `JOINTS[].parent`). The pelvis has no parent: its offset is the
  position of the pelvis (the hip-joint midpoint) in the world, `[0, hip_height, 0]`, so the feet are flat on `y = 0` and the figure stands on the floor.
* The neutral pose is quiet standing, and quiet standing leans forward about the ankles: the thigh is vertical (hip over knee) and the **shank leans**, so the ankle (and the foot) is
  `stance.ankleBehindKneeM` (36 mm, 4.9 degrees for the median man) behind the knee and the hip: `positions.ankle_L[2] = -stance.ankleBehindKneeM`. The whole-body centre of mass is 34 to 40 % (median 37.5) of
  the foot length from the heel (4.1, 7.1). Every height is what it would be with upright legs.
* The 77 joints are all laid out: pelvis; hip, knee, ankle, mtp (metatarsophalangeal, the toe joint) x2; the 25 spine joints `L5` (L5/S1) to `T1`, `C7` (C7/T1) to `C1`, and
  `head` (the occiput-C1 joint); `jaw`; `eye_L/R`; `clavicle`, `shoulder` (glenohumeral), `elbow`, `forearm`, `wrist` x2; index, middle, ring, little finger `mcp, pip, dip` x2 sides; thumb `cmc, mcp, ip` x2 sides.
* `forearm_*` is the pronation/supination joint: its offset is `[0, 0, 0]` (it is at the elbow centre, as `skeleton.js` documents), the wrist is its child one forearm length down.
* The spine curvature is baked in: lumbar `flex = 0` means the natural standing curvature, not a straight spine (4.3). The sacro-iliac / pelvis geometry is represented by
  the pelvis joint at the hip centres and `L5` 25 mm behind and `l5_above_hip` above it.
* The arms hang abducted by 3 to 14 degrees (whatever clears the wrists off the hips; the bones follow only that rule, the SKIN of the arm clears the trunk by its own lateral offset, 6.3), the forearms are in mid-position (palms face the thighs, thumbs forward); fingers straight, the thumb splayed 22 degrees forward.
* Run `new Kinematics(offsets).solve(angles, root)` (`fk.js`) on these offsets to pose the body; `referencePose(body, name)` gives the root and angles of the report postures (section 8). The joint offsets are rounded to the micrometre with ties away from zero, so the right side is the exact negation of the left one in `x` for every person.

### 1.2 Dimension records (the mapping table)

`body.dims` is an array in resolution order; a record is

```
{ id, label, unit: "m" | "kg" | "ratio", value,
  status: "measured" | "derived" | "estimated",
  via: [measure keys the value came from],         // [] when estimated or edited by the user
  formula: "the route that set it",                // e.g. "trochanterion height - 5 mm (hip centre below the trochanter landmark) - knee height"
  note: "formula; plus why a more direct route was rejected / what refinement moved it, in mm",
  alt?: [{ via, keys, value, delta, sd }] }        // other usable routes (they only check the chosen one: nothing is averaged); delta = value - the record's FINAL value (after refinement);
                                                   // sd (m) = SD of the difference of the two routes that is due to the relations (RELATIONS) only one of them reads, 0 for two pure measures
```

`measured`: the value IS a profile measure (or the user typed it). `derived`: computed from measures (or from other derived dimensions) with a documented relation.
`estimated`: no measure could set it; it comes from stature, mass and sex (regressions, section 9). A derived dimension without measure keys (`shank_length`, `hip_height`, `trunk_length`, ...) is
`estimated` when every dimension it is built from is, else `derived`. The UI mapping table is this array; the section rings and the adiposity factor are rows too (`ring_<name>`, `adiposity`).

### 1.3 Shape in one page (details in section 6)

`shape = { units: "m", frame, adiposity, form, tubes, head, hands: { L, R }, feet: { L, R }, volume }`.

* `tubes[name] = { joint, label, closed: [ends], rings: [ring...] }` with `name` in `torso, neck, upper_arm_L/R, forearm_L/R, thigh_L/R, shank_L/R`. Rings are ordered along the tube
  (upward for torso and neck, proximal to distal for limbs). The right-hand tubes are the mirror images of the left-hand ones (`c.x` negated, joint ids mirrored).
* `ring = { id, c: [x, y, z], rx, rz, n, src, bind }`: the superellipse `|x'/rx|^n + |z'/rz|^n = 1` in the horizontal plane through `c` (world coordinates of the neutral pose; `x'`, `z'` are measured
  from `c`; `rx` half-breadth, `rz` half-depth; `n = 2` is an ellipse, up to 12 is a rounded rectangle). The limbs are within 14 degrees of vertical, so a ring is perpendicular to its limb up to that tilt:
  loft the ring in the plane perpendicular to the segment of the centre line if you want to be exact. `src` is `"measured"` (breadth, depth and girth of this ring all from the profile), `"derived"` or `"estimated"`.
  `bind = [[jointId, weight], ...]` are the skin weights of every vertex of the ring (weights sum to 1 within 1e-6; section 6.4). The ring's own `girth` is not stored: `ringPerimeter(rx, rz, n)` (exported) gives it.
* To loft a ring: `vertex(t) = c + [ rx * sgn(cos t) * |cos t|^(2/n), 0, rz * sgn(sin t) * |sin t|^(2/n) ]`, `t` from 0 to 2 pi (`t = 0` points to +x, the figure's left, `t = pi/2` to +z, the front). Each vertex is in the neutral world frame; to skin it, give the bone of every joint in `bind` the bind matrix
  `translate(positions[joint])` (identity rotation at rest) and the vertex weights `bind`. The rings are strictly ordered along the tube, so a quad strip between consecutive rings with the same number of vertices closes the surface; `closed` says which ends need a cap.
* `closed`: the ends of the tube that the loft caps. The torso is closed at the crotch (bottom) and its top ring (`neck_base`) is also the first ring of the neck (the cap is inside the neck); the neck is closed at the top
  (inside the head); the upper arm is closed at the shoulder; the other ends are covered by the next part (the hand covers the forearm's wrist ring, the foot covers the shank's malleolus ring) or continue it (upper arm / forearm at the elbow
  share the same ring; thigh and shank at the knee differ by 3 % in size and half in the depth offset: weld them by averaging if you want one closed surface).
* `head = { joint: "head", rings, cranium, features }` (an ellipsoid for the cranium plus rings for the face and landmarks for nose, brows, ears, chin, eyes, mouth); `hands.L`/`R` palm rings and finger capsules;
  `feet.L`/`R` cross-section stations from heel to toe (the toes are skinned to `mtp`); `volume = { m3, mass, density, calibration, scalable, fixed }`. `head.eyeSocketHint`: the eyeballs (radius 12 mm, centre 12 mm behind the pupil) are skinned to `eye_L`/`eye_R`.

### 1.4 Exports of `fit.js`

| name | what |
|---|---|
| `fitBody(profile, opts)` | the function above |
| `evaluateMeasures(body, pose?)` | the fit report rows, in the reference postures or in a given pose; independent of the figure's heading and position (section 8) |
| `referencePose(body, name)` | `{ root, angles, label }` of a reference posture (8.1); the angles are a fresh copy, and for `tpose` / `forward` they are the ones that bring THIS body's arm to the horizontal |
| `REPORT_MEASURES`, `REFERENCE_POSTURES` | the measures of the report (id, label, posture, unit, why) and the nominal postures (label, angles); both deeply frozen |
| `DIM_DEFS` | documentation of every dimension: id, label, unit, formula (one string per route), requires (measure keys), fallback, band `lo`/`hi` (`"relative"` when it depends on other dimensions) |
| `REGRESSIONS`, `RELATIONS`, `CONSTANTS` | the data tables of section 9 and the constants of section 3 (frozen) |
| `ellipsePerimeter(a, b)`, `ringPerimeter(a, b, n)`, `ringArea(a, b, n)`, `sectionFrom({ B, D, G, ratio, n0 })` | the section maths of section 6.1 |

## 2. From the profile to the dimensions

### 2.1 Inputs

* Keys are the harmonised keys and `other:` keys of the website API (`anthro.js` `SKELETON_MEASURES` lists the ones the module is meant to receive). Units `mm`, `cm`, `m`, `in` for lengths, `kg`, `lb` for mass; `bmi` in `kg/m2`; matched without case or spaces (`MM`, ` Cm `). A value without a unit is taken in the unit of its measure (kg for the mass, kg/m2 for `bmi`, mm for the rest). A value with another unit is dropped, and for a measure the model reads a warning says which unit was not understood.
  A non-positive or non-finite value is ignored. Aliases: `other:hip_breadth_standing` = `other:hip_breadth`, `other:tragion_to_top_of_head`, `other:waist_height_omphalion`, `other:stylion_wrist_height`,
  `other:nipple_chest_height`, `other:waist_depth_standing`, `other:waist_omphalion_breadth/depth`, `other:knee_circumference_standing`; `other:weight_as_reported` is the mass when `mass` is absent. The canonical name wins over an alias. The bare names `hip_breadth, waist_breadth, waist_depth, buttock_depth, knee_circumference, ankle_height, tragion_top_of_head, elbow_wrist_length, forearm_hand_length, omphalion_height, chest_height` are aliases of their `other:` keys (the import code of `anthro.js` prefixes only the names of its `SKELETON_MEASURES`, which lacks these); a test checks that every `other:` key the module reads is understood bare. A length above 10 m (1e308 m survives the unit conversion but not the report's multiplication by 1000) is ignored with a warning for the measures the model reads. In a profile whose `source.kind` is `import` or `manual` (not for population or individual profiles, which carry some hundred measures the model does not use) the keys that nothing reads are listed in one warning (`2 measure(s) in the profile are not used by the model and were ignored: bogus_key, ...`, at most 6 names), so that a misspelt column does not vanish silently.
* Stature must be 1.3 to 2.5 m. The absolute floors of the skeleton (shank 0.30 m, thigh 0.30 m, trunk 0.30 m, neck 0.07 m, with an ankle 56 mm high and the head pivot 155 mm below the vertex) add up to about 1.31 m for men: from 1.31 m all four floors hold for both sexes and every mass (checked for 25 to 300 kg; the women's from 1.27 m); between 1.30 and 1.31 m the shank gives way (to 294 mm at the worst, at 1.30 m: the lower band of the knee height is lowered by the missing millimetres, never below the ankle height + 270 mm) and the thigh, trunk and neck keep theirs; at 1.2 m the shortfall is 25 mm (thigh 250, trunk 275, neck 45 mm) and for 0.8 to 1.0 m the spine would invert (L5 above C7). A stature below 1.3 m is refused with a warning (and listed in `rejected`) like a missing one. Without it, the median of the inverse regressions of every stature proxy in the profile (`cervicale_height, acromion_height, suprasternale_height, iliocristale_height, trochanterion_height, crotch_height, knee_height_sitting, popliteal_height`, `other:` leg heights, `buttock_knee_length, span, sitting_height`) is used (3 passes, each re-guessing the mass from the previous stature); without any proxy, the median stature of the form (men 1764 mm, women 1629 mm). Both cases are `estimated` with a warning.
  A stature outside 1.45 to 2.05 m warns that the proportions are extrapolated (the regressions are fitted on adults of that range).
* Mass: `mass`, else `bmi x stature^2` (`derived`), else the median BMI of the form x stature^2 (`estimated`, men 26.16, women 24.04 kg/m2). A mass outside 25 to 300 kg is clamped; the record becomes `derived`, its note says `clamped from X kg` and a warning names both values. A mass outside 10 to 400 kg is not believed (a typing or unit slip): it is ignored with a warning that names it (`Body mass 5.0 kg is outside the 10 to 400 kg the model accepts and was ignored`), listed in `rejected.mass`, and replaced by the BMI route or the median BMI (the `no body mass` warning is only for a profile that gave none).
* **Mass beyond the fitted range.** The regressions of heights and lengths on mass are linear and describe soft tissue over the bones of people with BMI 15.4 to 43.5 (99.8 % between 16 and 40); fat does not change bone lengths. Heights and lengths (keys containing `height`, `length`, `span`, `reach`) are therefore evaluated at the nearest mass inside BMI 16 to 40 for the stature (`Fit.fitMass`), with a warning (`BMI 65.3 (200 kg at 1750 mm) is outside the 16 to 40 ...`). Girths, breadths and depths use the real mass (the adiposity factor closes the volume, 6.5). A 1750 mm man of 200 kg has the skeleton of one of 123 kg: thigh 394 mm and trunk 499 mm against 414 and 460 at 78 kg (they were 359 and 564 before).
* Plausibility screen: every other input for which a regression exists is compared with the value predicted from stature, sex and the profile's mass, AND with the one predicted for the typical mass of that stature (a mass that does not go with the girths must not discard the girths); an input more than
  6 residual SD from the nearer prediction is almost certainly a unit or typing slip. It goes to `body.rejected` with the reason, is not used to build the model and is reported in the fit report as "not used to build the model".

### 2.2 Form (sex)

`male` / `female` use their own regressions, relations, de Leva fractions and typical section shapes. `neutral` uses the weighted mean with weight `f = 0.5` for every one of them (regressions are averaged, not the dimensions
of two bodies). Nothing else depends on sex. An explicit `opts.form` wins over `profile.sex`.

### 2.3 Precedence: how a dimension gets its value

Every skeleton dimension (`DIM_DEFS`, resolved in dependency order, table in 2.4) has an ordered list of routes, the most direct measure first.

1. A route is usable when every measure key it needs is in the profile and not rejected (2.1). It must produce a finite value inside the dimension's plausible band; a value outside the band is rejected and the reason goes into the note.
   `femur_length` has one more test (`accept`): with a sitting height in the profile a leg length that would put the hip joint less than 20 mm or more than 140 mm above the seat plane contradicts the sitting height,
   so the next route is used (ultimately the one built on the sitting height). The ISO 7250 sitting height is a closure requirement (4.7); the legs yield.
2. The FIRST usable route sets the value (`status` from the route: `measured` when the dimension is the measure itself, else `derived`).
3. Any other usable routes are kept as `alt` entries with their value and the delta to the chosen one. Nothing is ever averaged. Each `alt` is a row in the fit report (`kind: "check"`), and a difference above max(15 mm, 2 SD) adds a warning
   ("the measures conflict"), where SD is the `sd` of the `alt` entry: the spread of the relations (section 9.3) that the two routes do not share, in quadrature (a route that is pure measure has `sd` 0, so two measures that differ by more than 15 mm always warn).
   A relation such as "buttock-knee length minus thigh length" has an SD of 25 mm: a 40 mm difference between a thigh built on it and one built on the trochanter is ordinary variation between people, a 95 mm one is a contradiction. With the flat 15 mm threshold 95 % of 1,971 real people (every 7th of the four surveys) got at least one such warning (4.1 per person); at 2 SD a third do (0.5 per person; each relation route has a 5 % chance of exceeding 2 SD by chance alone).
   This is how conflicting inputs of one person show up instead of being smoothed over. The wording follows the sign ("would give X mm, Y mm more / less than the Z mm used").
4. With no usable route, the dimension is `estimated` from stature, mass and form: a regression (`REGRESSIONS`, section 9.2) or a mean relation (`RELATIONS`, 9.3), clamped to the band.
5. The user's override (`opts.overrides[id]`, metres, positive) replaces the value: `status: "measured"`, `via: []`, the note says what the profile would have given. A dimension that is purely derived from other dimensions has no value of its own:
   overriding `shank_length` edits `knee_height`, `hip_height` edits `femur_length`, `gh_halfwidth` edits `acromion_to_gh`; for the other pure derivations (`trunk_length`, `neck_length`, `head_pivot_depth`, `ball_length`) the override is ignored with a warning
   that names the dimensions to edit. **An override outside the plausible band is limited to the edge of the band, with a warning** (`The edited Thigh (1000 mm) is outside the plausible 300 to 608 mm: 608 mm was used`; the note says `limited to`): the heights are absolute, so a 1.0 m thigh does not raise the figure, it eats the trunk (hip at 1.49 m, L5 above C7), and a value that inverts the spine is never applied. The same limit applies to the edits that go through a derived dimension (`hip_height: 3` limits the thigh). A band whose edges cross (a very short or contradictory body) takes the middle. An edit inside the band is applied as typed; when the heights then leave less than 300 mm for the trunk or 70 mm for the neck a warning says the spine is squeezed.
   Girths are overridden with `ring_<name>` (`buttock, waist, chest, neck_base, neck, biceps, forearm, wrist, thigh, knee, calf, ankle`; the head girth cannot), limited to 0.4 to 2.2 times what stature, mass and sex give (warning). Stature and mass are not overrides (edit them in the profile) and neither is an unknown id: each is reported in `warnings` instead of being dropped silently.
   Overrides win over the profile and over the refinements of 4.5 (an overridden or estimated length is never refined).

The outcome is deterministic and has no hidden state: the same profile and options give the same record array.

### 2.4 The dimensions

| id | meaning | routes, most direct first (the first usable one sets the value) | estimate when no route is usable | plausible band (m) |
|---|---|---|---|---|
| `ankle_height` | Ankle joint centre above the sole | 1. lateral malleolus height (the ankle centre is put at the malleolus tip, as de Leva 1996 does)<br>2. ankle height, only when it can be a malleolus (at most 90 mm: 67 to 75 mm in the Australian files; the 110 to 136 mm of the US, Turkish, Greek, Italian and UK files is a higher landmark and is refused with a note) <br>needs: `other:lateral_malleolus_height`, `other:ankle_height` | regression of the lateral malleolus height on stature, mass and sex | 0.035 to 0.12 |
| `knee_height` | Knee joint centre above the sole | 1. lateral femoral epicondyle height<br>2. mid-patella height - (mid-patella above the epicondyle)<br>3. knee height sitting - (top of the knee above the knee axis)<br>4. popliteal height + (knee axis above the popliteal point) <br>needs: `other:lateral_femoral_epicondyle_height`, `other:knee_height_midpatella`, `knee_height_sitting`, `popliteal_height` | regression of the lateral femoral epicondyle height on stature, mass and sex | ankle height + 0.30 to + 0.58 |
| `shank_length` | Shank (knee centre to ankle centre) | knee height - ankle height | derived from other dimensions (always available) | none |
| `femur_length` | Thigh (hip centre to knee centre) | 1. trochanterion height - 5 mm (hip centre below the trochanter landmark) - knee height<br>2. crotch height + (hip centre above the crotch: 66 mm men / 71 mm women) - knee height<br>3. stature - sitting height + (hip centre above the seat plane: 74 mm) - knee height<br>4. buttock-knee length - (mean of buttock-knee length minus thigh length: 208 mm men / 204 mm women) <br>needs: `trochanterion_height`, `crotch_height`, `sitting_height`, `buttock_knee_length` | regression of the trochanterion height - 5 mm - knee height | 0.3 to min(0.62, stature - knee height - 0.648 (typical L5 offset 0.124 + trunk 0.30 + neck 0.07 + head pivot 0.154)): the thigh must leave room above the hip, or the spine inverts; also: with a sitting height the route must put the hip joint 0.02 to 0.14 above the seat plane |
| `hip_height` | Hip joint centre above the sole (= pelvis root) | knee height + thigh length | derived from other dimensions (always available) | none |
| `hip_halfwidth` | Half the distance between the hip joint centres | 1. Harrington 2007: 0.33 x ASIS breadth + 7.3 mm, ASIS breadth = 0.87 x bicristal breadth (approx.)<br>2. same, bicristal breadth = hip breadth sitting / 1.36 (men) or 1.46 (women)<br>3. same, bicristal breadth = standing hip breadth / 1.26 (men) or 1.30 (women) <br>needs: `bicristal_breadth`, `hip_breadth_sitting`, `other:hip_breadth` | regression of the bicristal breadth on stature, mass and sex, then Harrington | 0.06 to 0.14 |
| `hip_to_seat` | Hip joint centre above the seat plane (ISO 7250 seated) | 1. sitting height - (stature - hip height): the model's trunk and head are rigid, so the seat plane absorbs the difference <br>needs: `sitting_height` | mean of the 13,792 people (74 mm) | 0.01 to 0.18; warning outside 0.035 to 0.125 |
| `l5_above_hip` | L5/S1 joint above the hip centres | 1. iliocristale height - hip height - 35 mm (L5/S1 is below the iliac crest line) <br>needs: `iliocristale_height` | relation: iliocristale above the hip centre (159 mm men, 143 mm women) - 35 mm | 0.05 to 0.17 |
| `vertex_to_eye` | Vertex to the outer eye corner (ectocanthus) | 1. sitting height - eye height sitting<br>2. (stature - hip height + hip-to-seat) - eye height sitting<br>3. tragion-to-top-of-head - 17 mm (the tragion is below the eye corner) <br>needs: `sitting_height`, `eye_height_sitting`, `other:tragion_top_of_head` | relation: mean of the 13,792 people (119 mm men, 112 mm women) | 0.08 to 0.17 |
| `tragion_below_eye` | Tragion below the eye corner | 1. tragion-to-top-of-head - vertex-to-eye <br>needs: `other:tragion_top_of_head` | relation: 17 mm (ANSUR II) | 0 to 0.05 |
| `head_pivot_depth` | Vertex to the occiput-C1 joint | vertex-to-eye + tragion-below-eye + 18 mm (the occipital condyles are below the tragion) | derived from other dimensions (always available) | none |
| `c7_height` | C7/T1 joint above the sole | 1. cervicale height - 15 mm (the C7 spinous tip is above the C7/T1 disc centre)<br>2. suprasternale height + (cervicale above suprasternale, 77 mm men / 72 mm women) - 15 mm<br>3. acromion height + (cervicale above acromion, 75 / 68 mm) - 15 mm<br>4. acromion height sitting + hip height - hip-to-seat + (cervicale above acromion) - 15 mm <br>needs: `cervicale_height`, `suprasternale_height`, `acromion_height`, `acromion_height_sitting` | regression of the cervicale height on stature, mass and sex - 15 mm | max(hip + L5 + 0.30, S - head pivot - 0.18) to min(hip + L5 + 0.60, S - head pivot - 0.07) |
| `trunk_length` | Trunk (L5/S1 to C7/T1, vertical) | C7/T1 height - L5/S1 height | derived from other dimensions (always available) | none |
| `neck_length` | Neck (C7/T1 to the occiput-C1 joint, vertical) | stature - head pivot depth - C7/T1 height | derived from other dimensions (always available) | none |
| `shoulder_height` | Glenohumeral centre above the sole | 1. acromion height - 35 mm (the humeral head centre is below the acromion tip)<br>2. cervicale height - (cervicale above acromion) - 35 mm<br>3. suprasternale height + (cervicale-acromion difference) - 35 mm<br>4. acromion height sitting + hip height - hip-to-seat - 35 mm <br>needs: `acromion_height`, `cervicale_height`, `suprasternale_height`, `acromion_height_sitting` | regression of the acromion height on stature, mass and sex - 35 mm | C7 height - 0.16 to - 0.03 |
| `acromion_halfwidth` | Half the biacromial breadth (acromion tip to the midline) | 1. biacromial breadth / 2<br>2. bideltoid breadth / 2 - (deltoid beyond the acromion, 45 mm men / 39 mm women) <br>needs: `biacromial_breadth`, `bideltoid_breadth` | regression of the biacromial breadth on stature, mass and sex | 0.11 to 0.27 |
| `acromion_to_gh` | Acromion tip to the glenohumeral centre (sideways) | no measure drives it: see the fallback | constant 50 mm (approx.); with a span in the profile it is solved so that the arm span with the arms horizontal is exactly the measure | 0.02 to 0.085 |
| `gh_halfwidth` | Half the distance between the glenohumeral centres | acromion half-width - acromion-to-glenohumeral offset | derived from other dimensions (always available) | none |
| `shoulder_protraction` | Glenohumeral centre ahead of its standard place (sagittal) | no measure drives it: see the fallback | 0; with a thumbtip reach in the profile it is solved so that the reach with the arm raised forward is exactly the measure | -0.08 to 0.08 |
| `upper_arm_length` | Upper arm (glenohumeral centre to elbow centre) | 1. acromion-radiale length - 35 mm - 12 mm (acromion above the shoulder centre, radiale below the elbow axis)<br>2. shoulder-elbow length - 35 mm - (olecranon below the elbow axis, 41 mm men / 36 mm women) <br>needs: `acromion_radiale_length`, `shoulder_elbow_length` | regression of the acromion-radiale length on stature, mass and sex - 47 mm | 0.19 to 0.42 |
| `olecranon_drop` | Elbow axis to the lowest point of the olecranon (elbow at 90 degrees) | 1. shoulder-elbow length - 35 mm - upper arm length <br>needs: `shoulder_elbow_length` | relation: mean of the 13,792 people (41 mm men, 36 mm women) | 0.015 to 0.07 |
| `hand_length` | Hand length (stylion to the tip of the middle finger) | 1. hand length <br>needs: `hand_length` | regression of hand length on stature, mass and sex | 0.12 to 0.26 |
| `forearm_length` | Forearm (elbow centre to wrist centre) | 1. radiale-stylion length + 12 mm (radiale below the elbow axis; the wrist centre is at the stylion level, de Leva 1996)<br>2. elbow-wrist length - 31 mm (= radiale-stylion length in the four populations that report both: 29.4 to 31.5 mm; approx.) + 12 mm<br>3. forearm-hand length - hand length - (mean of forearm-hand length minus hand length minus radiale-stylion length: 19.5 mm men / 18.3 mm women) + 12 mm <br>needs: `radiale_stylion_length`, `other:elbow_wrist_length`, `other:forearm_hand_length` + `hand_length` | regression of the radiale-stylion length on stature, mass and sex + 12 mm | 0.17 to 0.36 |
| `hand_breadth` | Hand breadth (across the metacarpal heads) | 1. hand breadth <br>needs: `hand_breadth` | regression of hand breadth on stature, mass and sex | 0.06 to 0.13 |
| `foot_length` | Foot length (heel to the longest toe) | 1. foot length <br>needs: `foot_length` | regression of foot length on stature, mass and sex | 0.18 to 0.36 |
| `foot_breadth` | Foot breadth (across the metatarsal heads) | 1. foot breadth <br>needs: `foot_breadth` | regression of foot breadth on stature, mass and sex | 0.06 to 0.14 |
| `ball_length` | Heel to the first metatarsal head | foot length x 0.737 (ball-of-foot length / foot length of 11,365 people) | derived from other dimensions (always available) | none |
| `head_length` | Head length (glabella to opisthocranion) | 1. head length <br>needs: `head_length` | regression of head length on stature, mass and sex | 0.15 to 0.25 |
| `head_breadth` | Head breadth (euryon to euryon) | 1. head breadth <br>needs: `head_breadth` | regression of head breadth on stature, mass and sex | 0.12 to 0.2 |
| `bizygomatic_breadth` | Bizygomatic breadth | 1. bizygomatic breadth <br>needs: `bizygomatic_breadth` | regression of bizygomatic breadth on stature, mass and sex | 0.1 to 0.18 |
| `menton_sellion_length` | Menton-sellion length | 1. menton sellion length <br>needs: `menton_sellion_length` | regression of menton sellion length on stature, mass and sex | 0.08 to 0.16 |
| `interpupillary_breadth` | Interpupillary breadth | 1. interpupillary breadth <br>needs: `interpupillary_breadth` | regression of interpupillary breadth on stature, mass and sex | 0.04 to 0.09 |
| `knee_top_front` | Top of the thigh above the knee axis (seated knee height - knee axis height) | 1. knee height sitting - knee height <br>needs: `knee_height_sitting` | relation: 61 mm men / 50 mm women | 0.02 to 0.13 |
| `popliteal_below_knee` | Underside of the thigh behind the knee below the knee axis | 1. knee height - popliteal height <br>needs: `popliteal_height` | relation: 64 mm men / 75 mm women | 0.02 to 0.14 |
| `thigh_thickness` | Thigh thickness at its thickest (thigh clearance) | 1. thigh clearance <br>needs: `thigh_clearance` | regression of the thigh clearance on stature, mass and sex | 0.08 to 0.3 |
| `buttock_back` | Hip centre to the most posterior point of the buttocks | 1. buttock-knee length - thigh length - 70 mm (patella front ahead of the knee axis, knee at 90 degrees) <br>needs: `buttock_knee_length` | relation: buttock-knee length - thigh length = 208 mm (men) / 204 mm (women), - 70 mm | 0.06 to 0.22 |
| `popliteal_setback` | Popliteal point proximal to the knee axis (along the thigh) | 1. thigh length + buttock back - buttock-popliteal length <br>needs: `buttock_popliteal_length` | relation: (buttock-knee - buttock-popliteal length = 112 mm men / 107 mm women) - 70 mm | 0 to 0.14 |

Notes on the table. "Hip centre" = hip joint centre = trochanterion height minus 5 mm (`K.hjcAboveTroch`, section 3). "Seat plane" is where the ischial tuberosities rest in the ISO 7250 seated posture.
`hip_to_seat` also gets a warning outside 35 to 125 mm (typical 74 mm): sitting height and leg heights then disagree. The relations quoted in the table (for example "77 mm men / 72 mm women") are the means of the table in 9.3.

### 2.5 Section dimensions (girth rings)

The skin sections have their own dimension records (`ring_<name>`), resolved in `buildShape` (6.1) from breadth, depth and girth; `value` is the girth of the ring that was built, `status` is `measured` when the breadth, the depth and the girth of that section all came from the profile, `derived` when some did, `estimated` when none did (only the estimated sections are scaled by the adiposity factor, 6.5).

| id | section | profile measures it reads |
|---|---|---|
| `ring_buttock` | Hip / buttock section (breadth, buttock depth, buttock girth) | `other:hip_breadth`, `hip_breadth_sitting`, `other:buttock_depth`, `buttock_circumference` |
| `ring_waist` | Waist section at the omphalion | `other:waist_breadth`, `other:waist_depth`, `waist_circumference` |
| `ring_chest` | Chest section at the nipple level | `chest_breadth`, `chest_depth`, `chest_circumference` |
| `ring_neck_base` | Neck base section | `neck_circumference_base` |
| `ring_neck` | Neck section | `neck_circumference` |
| `ring_biceps` | Upper arm section | `biceps_circumference_flexed` |
| `ring_forearm` | Forearm section | `forearm_circumference_flexed` |
| `ring_wrist` | Wrist section | `wrist_circumference` |
| `ring_thigh` | Thigh section (circular, from the girth alone; the seated thigh clearance is carried by the landmark `thigh_top`) | `thigh_circumference` |
| `ring_knee` | Knee section | `other:knee_circumference` |
| `ring_calf` | Calf section | `calf_circumference` |
| `ring_ankle` | Ankle section | `ankle_circumference` |
| `ring_head` | Head section at the brow | `head_circumference`, `head_breadth`, `head_length` |

### 2.6 A worked example (check the code by hand)

A man of 1750 mm and 78 kg, nothing else (`form: male`). All numbers in mm, from the men's rows of 9.2 and 9.3:

```
ankle height   = 14.5 + 0.02612 x 1750 + 0.1287 x 78            = 70.2     (lateral malleolus height regression)
knee height    = -104.8 + 0.3472 x 1750 - 0.1221 x 78           = 493.3    (lateral femoral epicondyle height regression)
trochanterion  = -226.8 + 0.6768 x 1750 - 0.5749 x 78           = 912.8
thigh (femur)  = trochanterion - 5 - knee height                = 414.5
hip height     = knee height + thigh                            = 907.8    (= trochanterion - 5)
hip_to_seat    = 73.7 (mean of 9,356 men)
seated sitting height of the model = (1750 - 907.8) + 73.7      = 915.9    (the regression says 916.9)
```

`fitBody` gives `d.ankle_height = 0.07025`, `d.knee_height = 0.49328`, `d.femur_length = 0.41448`, `d.hip_height = 0.90776` and the stature row of the report 1750.001 mm. The test file repeats this calculation.

## 3. Constants and where they come from

`CONSTANTS` is exported (`fit.js`) and frozen. Status: **verified** = the value or the relation was found in a source I could read through a search summary (the original paper was not opened in this environment);
**approx.** = a physically reasonable value that no source was checked for; it is used because the model needs a number, and the tests only check consistency. Nothing here is a clinical value.

| constant | value | meaning | source and status |
|---|---|---|---|
| `hjcAboveTroch` | -0.005 m | hip joint centre relative to the trochanterion (the top of the greater trochanter, palpated) | radiographic studies found by search put the trochanter tip 3 to 8 mm above the femoral head centre (one study 10 mm below); the skin adds a few mm. Papers not opened, no citation. approx. (Winter 2009 puts the hip at the trochanter itself) |
| Harrington hip width | `0.33 x PW + 7.3 mm` | lateral position of the hip centre from the midline, PW = inter-ASIS distance | Harrington et al. 2007 (J Biomech 40:595), medio-lateral term of equation 1 as printed on the Visual3D documentation page (the paper was not opened). The equation's other two terms (anterior, vertical) are not used: the hip is placed from the leg heights |
| `asis` | 0.87 | inter-ASIS distance / bicristal breadth | approx. (the iliac crest is wider than the ASIS); gives a hip half-width of 85.8 mm for the median man |
| `radialeBelowElbow` | 0.012 m | radiale (top of the radius) below the elbow axis | approx. |
| `elbowWristOverRadialeStylion` | 0.031 m | elbow-wrist length minus radiale-stylion length | approx.: the US aircrew, pilots and navigators P50 files are the only ones that report both (29.4 to 31.5 mm); one route of `forearm_length` |
| `ghBelowAcromion` | 0.035 m | glenohumeral centre below the acromion tip | approx.; chosen so that the model's upper arm is de Leva's 282 mm when the ANSUR acromion-radiale length is 327 mm (47 mm = 35 + 12), both recalled |
| `ghInsideAcromion` | 0.05 m | glenohumeral centre medial to the acromion tip | approx.; with the arms raised to the horizontal (8.1) the span of a profile without a span is unbiased within 10 mm (men +8, women -8 mm over 1,117 people); with a span in the profile it is solved (4.5), clamp 20 to 85 mm |
| `ghAhead` | 0.015 m | glenohumeral centre ahead of the C7/T1 centre, standing | approx. |
| `reachSetbackMen` | 0.0275 m | setback of the thumb tip in the thumbtip-reach definition (the survey reach is shorter than the straight arm and extended thumb of the model) | CALIBRATED on the 13,792 people (4.5): the reach of a profile with stature and mass only has a pooled bias of -3 mm (was +25); by survey -10 to +10 mm. Some surveys measure to the thumb tip pinching the index finger; the exact definition could not be verified, so this is a fitted offset, not a measurement |
| `reachSetbackWomen` | 0.033 m | same, women | CALIBRATED the same way: pooled bias -1 mm (was +32), ASRAN women (25 people, scan based) +28 mm |
| `c7BelowCervicale` | 0.015 m | C7/T1 disc centre below the C7 spinous tip (cervicale) | approx. |
| `l5BelowIliocristale` | 0.035 m | L5/S1 below the iliac crest line | approx. |
| `ocBelowTragion` | 0.018 m | occiput-C1 axis below the tragion | approx. |
| `patellaAhead` | 0.07 m | skin over the patella ahead of the knee axis, knee flexed 90 degrees | approx. (about 52 mm standing, more when flexed) |
| `ankleFromHeel` | 0.24 | ankle joint centre (the talocrural axis) in front of the pternion, fraction of foot length | A scanner study of 20 people (40 feet, mean foot length 250.4 mm; "Validation of an Automated Optical Scanner for a Comprehensive Anthropometric Analysis of the Foot and Ankle", PMC10451213): the lateral malleolus is 54.0 mm (21.6 %) and the medial malleolus 60.7 mm (24.2 %) from the pternion along the foot axis, their midpoint 22.9 %. Inman (1976, quoted by a clinical text found by search, the book not opened): the axis passes 8 mm in front of the lateral tip (24.8 % of that foot). 24 % lies between the two. It was 0.20, the lateral tip alone (which is why the ankle sat 11 mm too far back in the foot). verified (the scanner values), approx. (the choice inside 22.9 to 24.8 %) |
| `malleolusBehindAxis` | 0.008 m | lateral malleolus tip behind the ankle axis, for a 0.27 m foot (scaled by the foot length) | Inman (1976), same remark: the axis is 8 mm in front of and 3 mm below the lateral tip. The model keeps the ankle centre at the lateral tip's height (de Leva) and puts the medial malleolus on the axis in depth. approx. |
| `comFromHeel` | 0.4 | whole-body centre of mass of the neutral (quiet standing) pose from the heel, fraction of foot length: the TARGET of `leanLegs`, which `leanMaxDeg` stops short of for 97 % of the bodies (the result is 37.5 % for the median) | Kawai et al. (congress abstract P-3-09-21, 1997, National Rehabilitation Center for the Disabled, Japan; 20 healthy people for the base of support, 14 young men for the landmarks): the centre of gravity at the 39.6th percentile of the base of support from its rear edge, 56 mm in front of the lateral malleolus, over the greater trochanter and the acromion. Di Giulio and Baltzopoulos 2019 (Front Physiol 10:625, doi 10.3389/fphys.2019.00625, 13 adults): 47 mm (0.5 s after the feet are flat) to 58 mm (7.6 s) in front of the ankle joint centre, the hip joint centre within 2 to 5 mm of that line. Hellebrandt (1940, quoted by a 2010 paper): 40 to 50 mm. 0.40 of a 265 mm foot is 106 mm from the heel, 42 mm in front of the ankle axis: the low end of the measured means. The fit puts the ankles back until the model is here, or until the shank leans `leanMaxDeg` (4.1, 7.1). approx. (the rounding of 39.6) |
| `leanMaxDeg` | 4.9 degrees | upper limit of the lean of the neutral shank from the vertical | The leg of quiet standing leans 3 to 4 degrees as a whole (Di Giulio and Baltzopoulos 2019: the knee 21 to 26 mm in front of the ankle, 0.43 m shank); with the thigh vertical the hip is as far forward as the knee, so the 40 % (a lean of 5.9 degrees for the median body, 4.5 to 7.3 over 1,128 bodies) would be twice the measured lean. 4.9 is the measured 3 to 4 plus about 1 degree for the vertical thigh, and just under the 5 degrees that the checks of the test suite allow (the angle is computed from positions rounded to 1 micrometre: 4.9 stays under 5). It binds for 97 % of the bodies of 7.1 (2,832 of 2,928). approx. |
| `spineBack` | 95 / 95 / 52 mm | vertebral centre line to the skin of the back, lumbar / thoracic / cervical | approx.; the lumbar value is also tuned so that the abdominal depth sitting measured against the wall is 20 mm more than the standing waist depth, as in the surveys |
| `t1Slope` | 24 degrees | slope of the T1 upper end plate from the horizontal | approx. (healthy adults about 25 degrees) |
| `kyphosis` | 38 degrees | T1 to T12 thoracic kyphosis (change of direction of the vertebral centre line) | Yukawa et al. 2018 (Eur Spine J, 626 asymptomatic Japanese adults): mean 36.0, SD 10.1 degrees, via a search summary; the model's 38 is 0.2 SD above that mean (approx. rounding) |
| `lordosis` | 50 degrees | T12 to S1 lumbar lordosis | same cohort: 49.7, SD 11.2 degrees; verified |
| `cervical` | 18 degrees | lordotic change of direction from C7/T1 to the occiput-C1 joint | approx. (the cohort's C2-C7 lordosis is 4.1 degrees; other studies give more for the whole neck) |
| `sva` | 0.02 m | C7/T1 centre ahead of the L5/S1 centre (sagittal vertical axis) | approx. (healthy adults 0 +- 25 mm); sets the balance rotation of the whole curve |
| `l5Behind` | 0.025 m | L5/S1 behind the hip centres | approx. (cohort pelvic tilt 14.5 degrees, pelvic radius about 0.1 m) |
| `pitchTrunk`, `pitchNeck` | weights | relative vertebra + disc heights, L5 to T1 and C7 to C1 | approx.; the weights only shape the curve, the vertical extent is fixed by the measured heights |
| `density` | 1050 kg/m3 | whole-body density for the mass check | the 1.05 kg/L of the task statement (real adults range about 1.01 to 1.09 with the fat fraction) |
| `VOL_CAL` | 0.917 | volume of the union of the tubes / the sum of their volumes (overlaps at shoulders and hips, simplified sections) | fitted on 4,597 real people with most girths measured (6.6) |
| de Leva 1996 fractions | section 7 | segment masses and centres of mass | de Leva, J Biomech 29:1223, adjusted Zatsiorsky-Seluyanov tables, values read from the Visual3D documentation and a second transcription; the end points of the segments and the three-part trunk split are recalled: approx. |
| `SHAPE` | table in 6.2 | perimeter of the measured section / ellipse perimeter, depth / breadth | recomputed from the database (6.2); verified |
| landmark offsets (`G`, `OFF`) | see 4.6, 5 | stylion, radiale, trochanter lateral offset, ischial offsets, hand and finger fractions, heel and toe heights | approx. |

Further constants of the arm in `G` (approx.): `armGap` 40 mm (the wrist is at least this far outside the hip edge), `minArmTilt` 3 and `maxArmTilt` 14 degrees (abduction of the hanging arm), `armClear` 16 mm (the skin of the arm may press this far into the trunk's skin, soft tissue gives) and `armShiftMax` 50 mm (the largest outward offset of the arm's skin, 6.3). In the section maths (6.1): the exponent range 1.8 to 12 and the 1.5 % girth slack.

The offsets in `OFF` and `G` (acromion 5 mm ahead of the glenohumeral centre, radiale at `[10, -12, 12]` mm from the elbow centre, stylion at `[4, 0, 21]` mm from the wrist centre, trochanter 65 mm lateral,
ischial tuberosities 55 mm lateral and 45 mm behind the hip centre, heel point 45 mm high, metatarsal heads 26 mm high, finger fractions) are approx.; every one of them is a single named constant in the source with a comment.

## 4. The layout of the neutral pose

All numbers below are in `layout(c)`; `c.d` are the resolved dimensions of 2.4. `hip_height` = `knee_height + femur_length`.

### 4.1 Legs and feet

Hip centres at `x = +-hip_halfwidth`, height `hip_height`; knee centres **directly below them** (the thigh is vertical) at `knee_height`; ankle centres at `ankle_height` (the lateral malleolus height) and
**behind the knee by the stance lean** `stance.ankleBehindKneeM`: the shank leans forward about the ankle, because the neutral pose is quiet standing (7.1). The lean is solved in `leanLegs()`:
the ankles, the feet and the toe joints go back, the knees, the hips and everything above stay, until the neutral whole-body centre of mass lies `comFromHeel` = 40 % of the foot length from the
heel (16 % of it, 42 mm for a 265 mm foot, in front of the ankle axis) **or until the shank leans `leanMaxDeg` = 4.9 degrees**, whichever comes first. The second one comes first for 97 % of the bodies (the 40 % would
be a lean of 4.5 to 7.3 degrees, median 5.9; see the next paragraph), so in practice the shank of every body leans 4.9 degrees and the centre of mass lies where that puts it: 36 mm in front of the ankle for the median man
(26 to 47 mm over the 528 population bodies and the 2,400 real people), 37.5 % of the foot from the heel (34 to 40 %). The knee is still `knee_height - ankle_height` above the ankle (`shank_length` is that vertical distance; the bone is
lean^2 / (2 L) = 1.6 mm longer), so every height and every seated measure of the fit report is what it would be with an upright shank (in the 2,928 bodies of 7.1 no value of the report moves by more than 0.007 mm: the calf girth, the one
ring that sits on the slanted shank; the volume by less than 1 cm3, the mass not at all), and the report statuses and the warnings are the same.

Why the thigh stays vertical and the shank carries the lean: every posture is written against a vertical thigh (`hip flex = 90` is the ISO 7250-1 horizontal thigh, `DESIGN.md` 1.1), and the seat plane
of the seated posture is `knee_height - hip_to_seat`. Real legs lean as a whole (Di Giulio and Baltzopoulos: the knee 21 to 26 mm and the hip 45 to 64 mm in front of the ankle, 3 to 4 degrees for the leg); here
the thigh is upright, so the hip is as far in front of the ankle as the knee, and a hip 42 mm ahead (the centre of mass is within 5 mm of the hip line, in the people and in the model) would mean a knee 42 mm ahead,
a shank 5.9 degrees off the vertical and a neutral knee angle of 174: twice the measured lean, and a deep fold of the leg against the thigh when the knee is flexed to its range. The cap of 4.9 degrees gives up
the last 6 mm of the centre of mass in front of the ankle (36 mm instead of 42) to keep the knee within 10 to 15 mm of its measured place; the posture library, which was first written against the 5.9 degrees, feels
the difference in the feet of the seated and pedal postures with the net shank rotation away from 0 (1 degree of lean is 7 mm of shank times sin(beta): up to 8 mm; the pedal and seiza postures of the library
that sat at the edge of their tolerance now miss it by a few mm on some bodies, `docs/human3d/POSE.md` "Balance and the stance"). A tilted thigh would give both the centre of mass and the lean, but it would put the knee of every
"hip 90" posture 20 mm below the hip and break the seat plane, so it is not done. A posture whose shank frame is not turned (hip 90 with knee 90, ankle 0) has the
ankle behind the knee by the lean in every pose; one whose net shank rotation is beta has the foot moved, of the order of `lean x sin(beta)`, in height (a seated posture with the hips at 90 and the knees at 60:
the feet float 26 to 34 mm above the floor instead of 54 mm), which is how the posture library feels the stance.

Foot: the heel (pternion) is `ankleFromHeel` = 0.24 x `foot_length` behind the ankle axis (the midpoint of the malleoli; the lateral malleolus tip is `malleolusBehindAxis` = 8 mm (scaled by `foot_length /
0.27 m`) behind the axis, 21 % of the foot from the heel, the medial one level with it in depth), the toe tip `foot_length` ahead of the heel, the first metatarsal head `ball_length = 0.737 x foot_length`
(the mean of 11,365 people) from the heel; the `mtp` joint is at 26 mm height (scaled by `foot_length / 0.27 m`), 11 mm (scaled) behind the first metatarsal head (midway between the first and fifth heads).
Soles are on `y = 0`. The ankle axis was at 0.20 of the foot length (the lateral tip alone, 54 mm of a 270 mm foot); the measured lateral tip is at 0.216 and the axis at 0.23 to 0.25, so the foot moved 4 % of
its length (11 mm) back relative to the ankle. The foot length, breadth, ball length, heel and malleolus heights are driving inputs and are reproduced exactly as before (tests).

### 4.2 Pelvis and the hip

`hip_halfwidth` = Harrington 2007 (the table in section 3): `0.33 x (0.87 x bicristal breadth) + 7.3 mm`. The bicristal breadth is the profile's, or `hip_breadth_sitting / 1.36` (men) or `/ 1.46` (women), or the standing hip breadth `/ 1.26` / `/ 1.30`, or the regression. The pelvis joint is the midpoint of the hip centres.
`ASIS` and `PSIS` landmarks (section 5) follow the same inter-ASIS width. The hip joint rotates the thigh; the trochanterion landmark is 65 mm lateral and 20 mm behind the hip centre at `trochanterion_height`.

### 4.3 The spine

The spine runs from `L5` (L5/S1, height `hip_height + l5_above_hip`, 25 mm behind the hip centres) through 17 intervals (5 lumbar L5-L4 ... L1-T12, 11 thoracic T12-T11 ... T2-T1, and T1 to C7) up to `C7` (C7/T1) at `c7_height`, then 7 intervals (C7 to C1, and C1 to the
`head` joint) up to the occiput-C1 joint at `stature - head_pivot_depth`. Each interval is a straight segment; its direction from the vertical (positive = leaning forward going up) is

```
T1 direction  t1 = t1Slope + phi          T12 direction  t12 = t1 - kyphosis          L5 direction  l5 = t12 + lordosis
lumbar interval i (i = 0..4, L5 upward):  l5 - lordosis x (i + 0.5) / 5
thoracic interval i (i = 5..16):          t12 + kyphosis x (i - 5 + 0.5) / 12
neck interval q (q = 0..6, C7 upward):    t1 - cervical x (q + 0.5) / 7
```

The length of an interval is its weight (`pitchTrunk[i]`, `pitchNeck[q]`) times a common factor that makes the vertical extent exact (L5 to C7: `c7_height - (hip_height + l5_above_hip)`; C7 to head joint). `phi` is the one rotation that balances the trunk: it is solved by bisection (range -40 to +25 degrees) so that
C7/T1 lies `sva` = 20 mm ahead of L5/S1. Typical result: `phi` = -4 degrees, T1 slope 20 degrees. The values are in `body.spine`. The vertical heights are exact whatever the curve, so the stature closes (4.7).

### 4.4 Head and face

The head joint (occiput-C1) is `head_pivot_depth = vertex_to_eye + tragion_below_eye + ocBelowTragion` (18 mm) below the vertex. The tragion is 12 mm ahead of the joint axis; the glabella is half the head length ahead of the tragion;
the ectocanthus (outer eye corner) is `vertex_to_eye` below the vertex; sellion 4 mm above the eye corner level; menton is `menton_sellion_length` from the sellion (10 mm behind it; the jaw joint carries it); eye joints and pupils are `interpupillary_breadth` apart, 12 mm behind the pupil.
The vertex is 5 mm behind the tragion plane and exactly at `stature`.

### 4.5 Shoulder girdle and arms

* `clavicle` joint: at the suprasternale level (6 mm below), 19 mm lateral, 72 mm ahead of the spine axis. `shoulder` (glenohumeral): `x = gh_halfwidth = acromion_halfwidth - acromion_to_gh`, `y = shoulder_height`, `z` = `ghAhead` = 15 mm ahead of C7 plus `shoulder_protraction`.
* The hanging arm is abducted by `beta` so that the wrist is 40 mm outside the hip edge, clamped to 3 to 14 degrees: the arm, forearm and hand points along `u = [sin beta, -cos beta, 0]`.
* Landmark-to-landmark lengths: the survey lengths acromion-radiale and radiale-stylion are distances between SKIN landmarks, not between joint centres. The bone lengths `upper_arm_length` and `forearm_length` start from the formulas of 2.4 and are refined by up to 12 mm in 4 fixed-point steps so that the landmark distances of the finished model are EXACTLY the measures (the refinement is written in the dimension's note).
  A length that is overridden, estimated or built from another measure (shoulder-elbow length, elbow-wrist length, forearm-hand length) is not refined. The refinement may move a bone by 12 mm at most; `refine()` always starts from the formula's value, so the repeated layouts of the shoulder tuning do not accumulate and the note of the record carries the reason once.
* `olecranon_drop` (shoulder-elbow length, acromion to the lowest olecranon point with the elbow at 90 degrees) is solved the same way when a shoulder-elbow length is given (within 15 to 70 mm).
* `span` and `thumbtip_reach` are made exact by solving two shoulder parameters (`tuneShoulder`): `acromion_to_gh` (clamp 20 to 85 mm) makes the fingertip span with the arms horizontal exact, `shoulder_protraction` (clamp -80 to +80 mm) the thumbtip reach with the arm raised forward against the wall. When a parameter reaches its clamp the measure is
  approximated (see the span and thumbtip reach rows of 8.3 for how often); the report shows how far. The solves are skipped for overridden parameters.
* **The two arm postures are horizontal arms.** The neutral arm hangs abducted by `beta` (3 to 14 degrees), so "shoulder abduction 90" would stop `beta` short of the horizontal and "flexion 90" would leave the arm `beta` off the midline: the span and the reach would shrink by `L (1 - cos beta)`. The span posture is abduction `90 - beta`; the reach posture is flexion 90 with the adduction (about -`beta`, solved on the kinematics because the swing is an exponential map) that puts the arm in the sagittal plane (`raisedArms`, used by the fit report, `referencePose` and the shoulder tuning).
* **Calibration of the defaults.** A profile without a span or a reach gets the standard shoulder: `acromion_to_gh` 50 mm (the model's span of stature-and-mass profiles is then +8 mm (men) / -8 mm (women) from the survey spans, SD 49 mm, 1,117 people) and `shoulder_protraction` 0. The thumbtip reach of such a profile was 25 mm (men) / 33 mm (women) too long (+14 to +52 mm by survey and sex): the model's thumb is extended and its trunk rigid, the survey reach is measured against a wall. The definition of the model's reach therefore subtracts a fitted setback (`reachSetbackMen/Women`, section 3), applied in the report and in the shoulder tuning alike; the shoulder joint itself stays where the anatomy puts it. Result: pooled bias -3 / -1 mm, by survey -10 to +10 mm (ASRAN women +28), residual SD 24 to 39 mm (the regression's own is 29 to 32). The calibration is to the pooled database: a survey that measures the reach differently keeps its offset; the report shows it. With a reach in the profile the solved protraction averages 0 (men) and -3 mm (women), SD 24 mm, so the clamp of 80 mm is rarely met.

### 4.6 Hands

The hand hangs along `u`. Hand length (stylion to the middle fingertip, ISO) is exact through the distance from the stylion landmark (offset `[4, 0, 21]` mm from the wrist centre) to `dactylion`, solved for the middle finger length; hand breadth is the distance between the metacarpale radiale and ulnare landmarks (42 % of the hand length from the wrist). The four fingers
start at knuckle fractions `palm = [0.435, 0.456, 0.435, 0.40]` of the hand length (index to little finger), spread by `across = [0.385, 0.13, -0.12, -0.36] x hand breadth` (positive toward the thumb), their tips at `[0.93, 1.0, 0.955, 0.80]` of the hand length; the three bones share the finger as 45:28:27 (little finger 47:27:26).
Thumb: carpometacarpal joint at 10 % of the hand length, 33 % of the breadth toward the thumb; bones 25.5 %, 17.5 %, 15 % of the hand length; splayed 22 degrees forward and 0.08 palmar. All approx. (typical proportions, no source).

### 4.7 Closure: stature, sitting height, and the seat plane

* **Stature** is exact by construction: the vertex height is `stature` whatever the spine curve; `report` shows the stature delta (< 0.01 mm).
* **Sitting height** (ISO 7250-1, seated, thighs horizontal, trunk upright, measured from the seat) is closed through `hip_to_seat = sitting_height - (stature - hip_height)`: the model's trunk, neck and head are rigid links, so the seat plane absorbs the difference between the standing trunk length and the person's sitting height
  (over the 13,792 people this offset is 74 mm on average, SD 24 mm for men and 16 mm for women: it contains the real compression of the trunk when sitting and the differences in landmark definitions). The ischial landmarks sit `hip_to_seat` below the hip centres, so in the `seat` posture the vertex is exactly `sitting_height` above the lowest ischial point.
  Without a sitting height `hip_to_seat` is the mean (estimated). Outside 35 to 125 mm a warning says that sitting height and leg heights disagree (this happens for population percentile profiles, which combine percentiles of different dimensions); the band of the dimension is 10 to 180 mm.
* The seated landmarks follow from `hip_to_seat`, `knee_top_front` (knee height sitting minus knee height), `popliteal_below_knee`, `thigh_thickness`, `buttock_back` and `popliteal_setback` (2.4), so that in the `seat` posture `knee_height_sitting`, `popliteal_height`, `thigh_clearance`, `buttock_knee_length` and `buttock_popliteal_length` evaluate to the profile.

## 5. Landmarks and contact sets

`landmarks[id] = { joint, offset: [x, y, z], label, group, kind }`: a point attached to the joint that moves it, expressed as an offset from the joint centre in the neutral frame (rotate with the joint's frame, not the world). `group` is `head | trunk | pelvis | leg | foot | arm | hand`.
`kind`: `bony` (a palpable bone point), `surface` (a skin point such as the nipple or the abdomen front), `contact` (a point where the body touches a support). Every landmark that a bone of `skeleton.js` ends at (`BONE_LANDMARKS`) is present.
They are placed so that the standard measure definitions (ISO 7250-1; Gordon et al. 1989 for the ANSUR landmarks) evaluate to the profile by construction: points that carry a survey height are put at that height when it is plausible (within 70 mm, 100 mm for the crotch, of where the other measures put it; else the model's own height and a warning),
the seated points come from the dimension table. `{L,R}` = the pair `X_L`, `X_R` (the right one is the exact mirror of the rounded left offset). Aliases: `eye_L/R` = `pupil_L/R` (the eye point).

**Head** (18 rows, 25 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `vertex` | `head` | bony | Vertex (top of the head) |
| `glabella` | `head` | bony | Glabella |
| `opisthocranion` | `head` | bony | Opisthocranion (back of the head) |
| `sellion` | `head` | bony | Sellion |
| `nasion` | `head` | bony | Nasion |
| `pronasale` | `head` | surface | Pronasale (tip of the nose) |
| `subnasale` | `head` | surface | Subnasale |
| `stomion` | `head` | surface | Stomion (mouth centre) |
| `menton` | `jaw` | bony | Menton (bottom of the chin) |
| `gnathion` | `jaw` | bony | Gnathion |
| `ectocanthus_{L,R}` | `head` | bony | ectocanthus (outer eye corner) |
| `pupil_{L,R}` | `eye_{L,R}` | bony | pupil (eye point) |
| `eye_{L,R}` | `eye_{L,R}` | bony | eye point (same as the pupil) |
| `eye_mid` | `head` | surface | Cyclopean eye point |
| `tragion_{L,R}` | `head` | bony | tragion |
| `euryon_{L,R}` | `head` | bony | euryon |
| `zygion_{L,R}` | `head` | bony | zygion |
| `gonion_{L,R}` | `jaw` | bony | gonion (angle of the jaw) |

**Trunk** (12 rows, 15 landmarks). The carrying joint of a trunk landmark is not fixed: `spineJoint(y)` takes the highest spine joint (L5 ... T1) that is at or below the landmark's height, so that it moves with the vertebra it sits next to. The joints listed are those of a 1750 mm / 78 kg man; a taller or heavier body can be one level up or down (a 1900 mm / 100 kg man has T9 for the chest and T8 for the shoulder blades). A posture engine must use `landmarks[id].joint`, never this table.

| id | joint | kind | meaning |
|---|---|---|---|
| `cervicale` | `C7` | bony | Cervicale (C7 spinous process) |
| `suprasternale` | `T4` | bony | Suprasternale (top of the breast bone) |
| `xiphoid` | `T11` | bony | Xiphoid process (substernale) |
| `substernale` | `T11` | bony | Substernale (bottom of the breast bone) |
| `chest_front` | `T10` | surface | Chest front (deepest point at the nipple level) |
| `chest_back` | `T10` | surface | Chest back at the nipple level |
| `thelion_{L,R}` | `T10` | surface | thelion (nipple) |
| `omphalion` | `L5` | surface | Omphalion (navel) |
| `abdomen_front` | `L5` | surface | Abdomen front (most protruding point) |
| `waist_back` | `L5` | surface | Waist back |
| `scapula_inferior_{L,R}` | `clavicle_{L,R}` | bony | inferior angle of the scapula |
| `scapula_back_{L,R}` | `T9` | contact | back at the scapula (wall contact) |

**Pelvis** (7 rows, 12 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `ASIS_{L,R}` | `pelvis` | bony | anterior superior iliac spine |
| `PSIS_{L,R}` | `pelvis` | bony | posterior superior iliac spine |
| `iliocristale_{L,R}` | `pelvis` | bony | iliocristale (top of the iliac crest) |
| `crotch` | `pelvis` | surface | Crotch |
| `buttock_extremity` | `pelvis` | surface | Buttock extremity (most posterior point) |
| `ischial_{L,R}` | `pelvis` | contact | ischial tuberosity (seat contact) |
| `hip_sitting_{L,R}` | `pelvis` | surface | widest point of the hips (sitting) |

**Leg** (9 rows, 18 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `trochanterion_{L,R}` | `hip_{L,R}` | bony | trochanterion (top of the greater trochanter) |
| `thigh_top_{L,R}` | `hip_{L,R}` | surface | top of the thigh (thigh clearance) |
| `thigh_under_{L,R}` | `hip_{L,R}` | contact | underside of the thigh (seat contact) |
| `knee_top_{L,R}` | `hip_{L,R}` | surface | top of the knee (knee height sitting) |
| `knee_front_{L,R}` | `hip_{L,R}` | contact | front of the knee (buttock-knee length) |
| `popliteal_{L,R}` | `hip_{L,R}` | surface | popliteal point (back of the knee) |
| `epicondyle_lateral_{L,R}` | `hip_{L,R}` | bony | lateral femoral epicondyle |
| `patella_{L,R}` | `knee_{L,R}` | surface | patella (mid-patella) |
| `shin_{L,R}` | `knee_{L,R}` | contact | shin (kneeling contact) |

**Foot** (10 rows, 20 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `lateral_malleolus_{L,R}` | `ankle_{L,R}` | bony | lateral malleolus |
| `medial_malleolus_{L,R}` | `ankle_{L,R}` | bony | medial malleolus |
| `heel_{L,R}` | `ankle_{L,R}` | bony | pternion (back of the heel) |
| `heel_sole_{L,R}` | `ankle_{L,R}` | contact | centre of the heel (sole) |
| `metatarsale_tibiale_{L,R}` | `ankle_{L,R}` | bony | medial ball of the foot (first metatarsal head) |
| `metatarsale_fibulare_{L,R}` | `ankle_{L,R}` | bony | lateral ball of the foot (fifth metatarsal head) |
| `ball_sole_medial_{L,R}` | `ankle_{L,R}` | contact | medial ball of the foot (sole) |
| `ball_sole_lateral_{L,R}` | `ankle_{L,R}` | contact | lateral ball of the foot (sole) |
| `toe_tip_{L,R}` | `mtp_{L,R}` | bony | akropodion (tip of the longest toe) |
| `toe_sole_{L,R}` | `mtp_{L,R}` | contact | toes (sole) |

The foot landmarks are placed as 4.1 says: the heel 0.24 of the foot length behind the `ankle` joint centre (the ankle axis, midway between the malleoli), the lateral malleolus 8 mm (scaled) behind that centre at its height, the medial one level with it in depth and 12 mm higher. Both feet are
`positions.ankle_L[2]` (= minus the stance lean) behind the pelvis in the neutral pose.

**Arm** (5 rows, 10 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `acromion_{L,R}` | `clavicle_{L,R}` | bony | acromion |
| `deltoid_{L,R}` | `shoulder_{L,R}` | surface | deltoid (lateral surface) |
| `olecranon_{L,R}` | `elbow_{L,R}` | bony | olecranon (point of the elbow) |
| `radiale_{L,R}` | `elbow_{L,R}` | bony | radiale (top of the radius) |
| `stylion_{L,R}` | `forearm_{L,R}` | bony | stylion (radial styloid) |

**Hand** (10 rows, 20 landmarks)

| id | joint | kind | meaning |
|---|---|---|---|
| `dactylion_{L,R}` | `middle_dip_{L,R}` | bony | dactylion (tip of the middle finger) |
| `middle_tip_{L,R}` | `middle_dip_{L,R}` | bony | middle fingertip |
| `index_tip_{L,R}` | `index_dip_{L,R}` | bony | index fingertip |
| `ring_tip_{L,R}` | `ring_dip_{L,R}` | bony | ring fingertip |
| `little_tip_{L,R}` | `little_dip_{L,R}` | bony | little fingertip |
| `thumb_tip_{L,R}` | `thumb_ip_{L,R}` | bony | thumb tip |
| `metacarpale_radiale_{L,R}` | `wrist_{L,R}` | bony | metacarpale radiale (index knuckle) |
| `metacarpale_ulnare_{L,R}` | `wrist_{L,R}` | bony | metacarpale ulnare (little finger knuckle) |
| `palm_centre_{L,R}` | `wrist_{L,R}` | contact | centre of the palm (surface) |
| `grip_centre_{L,R}` | `wrist_{L,R}` | surface | grip centre (axis of a handle held in the fist) |

### Contact sets

`body.contacts[name]` is an array of landmark ids; the grounding and support code (rig.js, the posture engine) takes the lowest / the plane through these points.

| set | landmarks |
|---|---|
| `feet` | `heel_sole_L`, `heel_sole_R`, `ball_sole_medial_L`, `ball_sole_medial_R`, `ball_sole_lateral_L`, `ball_sole_lateral_R`, `toe_sole_L`, `toe_sole_R` |
| `seat` | `ischial_L`, `ischial_R`, `thigh_under_L`, `thigh_under_R` |
| `knees` | `knee_front_L`, `knee_front_R`, `shin_L`, `shin_R` |
| `hands` | `palm_centre_L`, `palm_centre_R`, `grip_centre_L`, `grip_centre_R` |
| `elbows` | `olecranon_L`, `olecranon_R` |
| `back` | `scapula_back_L`, `scapula_back_R`, `buttock_extremity`, `opisthocranion` |
| `front` | `chest_front`, `abdomen_front`, `knee_front_L`, `knee_front_R`, `thelion_L`, `thelion_R` |
| `side_L` | `deltoid_L`, `trochanterion_L`, `lateral_malleolus_L`, `epicondyle_lateral_L`, `tragion_L`, `euryon_L` |
| `side_R` | `deltoid_R`, `trochanterion_R`, `lateral_malleolus_R`, `epicondyle_lateral_R`, `tragion_R`, `euryon_R` |
| `head` | `vertex`, `opisthocranion`, `glabella`, `euryon_L`, `euryon_R` |

A posture that names explicit support landmarks should use the `contact`-kind points (`heel_sole_L`, `ball_sole_medial_L`, `toe_sole_L`, `ischial_L`, `thigh_under_L`, `knee_front_L`, `shin_L`, `palm_centre_L`, `scapula_back_L`, ...): the bony points are not on the skin that touches the support (`heel_L`, the pternion, is 45 mm above the sole).

`feet` ground the body (neutral: every point on `y = 0`); `seat`: sitting on a flat seat (ischial tuberosities and the underside of the thighs: coplanar in the seated posture, within 0.1 mm; the most posterior buttock point is 52 mm above that plane and belongs to `back`); `knees`: kneeling or the knee against a panel; `hands`: holding (palm centre; the grip centre is the axis of a handle held in the fist, put `wrist_to_grip` along the hand from the wrist: the regression estimate, about 70 mm, never a measure);
`elbows`: leaning on the elbows; `back`: against a backrest or wall (the shoulder blades, buttocks, back of the head); `front`: leaning forward on a table; `side_L`/`side_R`: lying on a side; `head`: head contacts (headrest, ceiling clearance).

## 6. Shape (the data for the skin generator)

### 6.1 Sections: how breadth, depth and girth make a ring

A section is the superellipse `|x/rx|^n + |z/rz|^n = 1`. `ringPerimeter(a, b, n)` measures it by a 144-segment polyline (exact for `n = 2` through Ramanujan's second approximation, `ellipsePerimeter`); `ringArea` is the shoelace area.
`sectionFrom({ B, D, G, ratio, n0 })` (exported) builds a section from whichever of breadth `B`, depth `D`, girth `G` are known:

* B, D and G all known: `rx = B/2`, `rz = D/2`, and the exponent `n` in [1.8, 12] is solved so that the perimeter is exactly `G`. All three measures are reproduced. A tape measure picks up 4 to 16 % more than the ellipse through the same breadth and depth (6.2); exponent 5 adds 14 % at a 0.8 depth / breadth, exponent 12 adds 21.2 % (the bounding rectangle 26.9 %). When even that cannot reach `G` (the tape and the calipers of the survey disagree) the section is as boxy as it may be and the smallest change is made:
  1. `G` is at most 5 % beyond the bounding rectangle `2 (B + D)`: breadth and depth are scaled together by `k = max(1, 0.985 G / perimeter(n=12))`, ratio kept, `n = 12`: up to 1.5 % of the girth is left out (`short` = G minus the ring's girth, which the report shows as "warn" at worst) and only the rest is paid for by growing breadth and depth;
  2. `G` is more than 5 % beyond the rectangle (impossible for any convex section through B and D: a typing slip, another landmark): the GIRTH wins exactly, `k = G / perimeter(n=12)`.
  Why: ANSUR II men's chest tape is 1.237 x (median) the ellipse through their own chest breadth and depth (ANSUR 1988 men 1.11, USAF 1.09; the ANSUR II chest breadth is about 30 mm smaller than in the other surveys). With exponent 5 only and the girth winning, their chest was 24 mm too wide and 21 mm too deep and 87 % of them were "off" in the report; now the mean error is +3.8 mm (breadth) and +3.5 mm (depth), 7 % are "off", the tape is within 2 % for all of them, and their chest ring has an exponent of 11.4 on average (a rounded rectangle). For everybody else the exponent stays below 8 (ANSUR 1988 men 4.3, women 4.0, USAF men 3.6, ANSUR II women 6.5).
* B and D without a girth: `n = n0`, the typical exponent of the section (`typicalN`, from 6.2). If only one of B, D is known (no girth) the other is the regression estimate.
* G and one axis: the other axis is solved for the typical exponent. If that would make the section flatter than 0.4 : 1 the girth wins: the section is rescaled to the typical depth / breadth `ratio` with the girth `G`.
* G alone: the typical `ratio` (depth / breadth) is used and the section is scaled to `G`.
* Nothing known: the regression estimate of the girth with the depth / breadth ratio of the regression estimates of the two axes (`status: "estimated"`).

Measured values are never altered except in the two cases above, which are recorded in the ring's dimension note (`breadth and depth were scaled by k`, `the measured girth is X mm, Y % more than the section holds`). A girth shorter than the exponent 1.8 holds (below `lo`) shrinks breadth and depth the same way.

### 6.2 Typical section shapes (`SHAPE`, from the database)

Perimeter of the measured section / perimeter of the ellipse through breadth and depth, and depth / breadth, for [men, women], over the subjects that have all three measures:

| section | perimeter ratio | depth / breadth |
|---|---|---|
| chest (nipple level) | 1.1634, 1.1346 | 0.8127, 0.8846 |
| waist (omphalion) | 1.0425, 1.0359 | 0.7259, 0.7065 |
| hip / buttock | 1.0704, 1.0822 | 0.7051, 0.6608 |
| head (brow) | 1.0271, 1.0468 | 1.287, 1.287 (pooled mean; men 1.284, women 1.288) |

The exponent `typicalN` is the `n` that reproduces the perimeter ratio at that depth / breadth (bisection, cached). Round parts (limbs, neck) use `n = 2`; the thigh is a circle (6.3). The ANSUR II chest breadth is about 30 mm smaller than the other surveys (`database/README.md`: the survey methods differ), so the typical chest is slightly too boxy for those people; their own measures are handled in 6.1.

### 6.3 The tubes

| tube | joint | closed ends | rings, in order along the tube |
|---|---|---|---|
| `torso` | `pelvis` | bottom, top | crotch, buttock, lower_abdomen, waist, upper_abdomen, chest, axilla, shoulder, trapezius, neck_base |
| `neck` | `C7` | top | neck_base, neck_mid, neck_top |
| `upper_arm_{L,R}` | `shoulder_{L,R}` | top | ua_top, ua_deltoid, ua_biceps, ua_distal, ua_elbow |
| `forearm_{L,R}` | `elbow_{L,R}` | none | fa_elbow, fa_max, fa_mid, fa_wrist |
| `thigh_{L,R}` | `hip_{L,R}` | none | th_top, th_prox, th_mid, th_low, th_knee |
| `shank_{L,R}` | `knee_{L,R}` | none | sh_knee, sh_calf, sh_low, sh_ankle, sh_malleolus |
| `head` (shape.head.rings) | `head` | - | crown, upper_skull, brow, eye, ear, cheek, mouth, chin_top, chin |

Placement rules (heights are of the neutral pose; for `L` limbs, the right is the mirror):

* **Torso.** `crotch`: crotch height + 20 mm, the hip section scaled 0.62 x 0.8, centred 0.55 buttock-back ahead of the back. `buttock`: at the buttock height (trochanterion height plus the mean offset, -26 / -18 mm; the buttock extremity landmark is here), the back at `-buttock_back` behind the hip centres. `waist`: omphalion height; `chest`: nipple height; `axilla`: axilla height (chest section x 0.97 x 0.93); `shoulder`: acromion
  height - 20 mm (half-breadth 0.88 x acromion half-width, depth 0.66 x chest depth, exponent 2.4); `trapezius` between the shoulder and the neck base; `neck_base`: cervicale - 10 mm. `lower_abdomen` and `upper_abdomen` interpolate their neighbours. From the waist up the back of each section lies a fixed distance (95 mm lumbar and thoracic, 52 mm cervical, `spineBack`) behind the spine centre line, so the
  trunk follows the spine curvature; the front is `2 x rz` further. Heights are kept at least 12 mm apart (a measured landmark height can reorder two close rings; the upper one is pushed up).
* **Neck.** `neck_base` (shared with the torso), `neck_mid` at C7/T1 + half the neck length, `neck_top` at the head joint + 12 mm (0.93 x the neck section). Both are kept at least 12 mm above the ring below: the top torso ring is at the measured cervicale height - 10 mm, which can be higher than the model's own C7 when the survey's landmarks disagree, and the neck used to fold for 5 of the 13,792 people.
* **Upper arm.** Along the line from the glenohumeral centre to the elbow, at fractions 0, 0.17, 0.5, 0.88, 1 of the upper arm length: `ua_top` (deltoid section x 0.9, shifted laterally by 0.2 rx), `ua_deltoid` (a section whose outer edge is exactly at half the bideltoid breadth: `lat = max(60 mm, bideltoid / 2 - axis x)`, `rx = max(45 mm, 0.72 lat)`),
  `ua_biceps` (the FLEXED biceps girth, used for the relaxed arm too, see 8.3), `ua_distal` and `ua_elbow` (the forearm section x 0.98 and 0.95). **Forearm.** `fa_elbow` (x 0.95, identical to `ua_elbow`), `fa_max` at 0.18 (maximum forearm girth, ratio 1.08), `fa_mid` at 0.55 (girth between the wrist and forearm girths), `fa_wrist` at 1 (wrist girth, ratio 1.45).
  **Clearance of the trunk.** The glenohumeral centre is inside the width of the chest, so the bone axis alone put the biceps ring 43 mm (1750 mm / 78 kg man; 59 mm at 110 kg, 66 mm at BMI 46) into the chest ring. Each ring of `ua_biceps`, `ua_distal`, `ua_elbow`, `fa_elbow`, `fa_max`, `fa_mid` is therefore moved outward, away from the bone axis (the bones are not moved), by what it takes to leave at most `armClear` = 16 mm of overlap with the trunk's half-breadth at its height (the torso rings from the buttock to the axilla, at the adiposity factor of that pass), up to `armShiftMax` = 50 mm. Result: 16 mm of overlap at the biceps for the 4 body types of the test, 10 to 17 mm along the arm; a BMI 46 man keeps 30 mm at the elbow. `ua_elbow` and `fa_elbow` get the same offset (they stay one ring); the right arm is the mirror image. The skin of a posed arm is the ring offset carried by the bone: in a T-pose it sits up to 50 mm above the bone axis, which is inside the arm's soft tissue (ring radius 45 to 70 mm).
* **Thigh.** Along hip to knee at 0, `tG`, 0.6, 0.9, 1. `th_prox` is the thigh section where the thigh circumference is measured (just below the gluteal furrow: `tG = clamp((hip height - gluteal furrow height) / femur length, 0.18, 0.5)`): a CIRCLE of the thigh girth (depth / breadth `THIGH_RATIO` = 1, approx.: no survey measures the breadth of the thigh). It used to be as deep as the thigh clearance, which is the thickness of the thigh SEATED, compressed by the body weight, 10 to 20 % thinner than the standing section; with the girth fixed that made the thigh 213 mm wide (for a 346 mm hip ring) and the pair of thighs overlapped by about 70 mm. Now the median man's thigh is 198 mm wide and 198 deep (the girth of 616 mm). The seated thigh clearance is still exact: it is carried by the landmark `thigh_top`; in a seated pose the skin is on average 12 mm thicker than the clearance (the ring is the uncompressed section).
  The rings are moved medially/laterally so that the thigh does not stick out more than 6 mm beyond the hip ring, but never so that the left thigh crosses the midline by more than 30 mm (`inner(rx)`: a thigh that would is moved outward again and sticks out of the hip ring instead; the bound used to be violated by the first rule winning, up to 82 mm), and the back of the thigh rings lies `hip_to_seat` behind the hip-knee line (at most 1.6 rz) so that the thigh meets the buttock. `th_low` (lower thigh girth in proportion), `th_knee` (knee girth, depth = knee top to popliteal underside).
* **Shank.** `sh_knee` (knee x 0.97), `sh_calf` at 0.3 (calf girth, centre 15 % of rz behind the axis), `sh_low` at 0.72 (70 % of the way from the calf girth to the ankle girth), `sh_ankle` at 0.9 (ankle girth, ratio 0.95), `sh_malleolus` at 1 (bimalleolar breadth, 1.08 x the ankle girth). The ring centres lie on the knee-ankle line, which leans (4.1); the rings stay in horizontal planes, as for every tube.
* **Head.** `crown` (12 mm below the vertex) and `upper_skull` (40 mm) are scaled ellipsoid slices (`cranium`: centre at the tragion level, semi-axes head breadth / 2, tragion-to-vertex height, head length / 2); `brow` at the glabella (a superellipse through head breadth and length with the head circumference), `eye`, `ear`, `cheek`, `mouth`, `chin_top`, `chin`. The stomion is a fixed 70 mm below the sellion and the menton `menton_sellion_length` (80 to 160 mm) below it, so the gap between the menton and the mouth ring is `menton_sellion_length` - 70 mm (10 mm at the lower end of the band). Fixed offsets of 30 and 4 mm for `chin_top` and `chin` crossed the mouth ring below 100 mm (90 of the 13,792 people): both are now placed at 50 % and 20 % of the gap between the menton and the mouth ring (30 mm and 4 mm above the menton when the gap is 60 mm or more, i.e. for a menton-sellion length of 130 mm or more) so that the rings stay strictly ordered from the crown down and the loft does not fold.
  `features` gives the nose (tip, bridge, width), brows, ears (tragion, length, breadth, protrusion), chin, eyes (pupils, eyeball radius 12 mm, socket 19 mm), mouth.
* **Hands.** `hands.L`: `palm` rings `wrist`, `mid` (22 % of the length), `knuckles` (45.6 %); `fingers[name] = { joints, tip, points, radiusZ, thicknessRatio }` for index, middle, ring, little, thumb: capsules along the finger joints with the given radii (z across the hand). **Feet.** `feet.L.stations[]`: 8 cross-sections from heel to toe (the third, at `ankleFromHeel` of the foot length, is the ankle station; `z` is a world coordinate, the heel is at `positions.ankle_L[2] - 0.24 x foot_length`)
  `{ z, cx, rx, top, lift }` (half-width `rx` about `x = cx`, flat sole at `y = lift`, top at `y = top`); beyond `toesFrom` the toes are skinned to `mtp_L`.

### 6.4 Skin weights

The fit gives every ring a `bind` (the weights below). **`body.js` does not use them**: it recomputes the weights of every vertex from the geometry (so that the rows it inserts between the rings, the domes and the bowl get weights too, and the blends can differ where the loft needs it). What `body.js` does, and where it differs from the `bind` of the fit:

* Torso and neck: the spine chain (pelvis, L5 ... T1, C7 ... C1, head), the two joints that bracket the height of the vertex, weights linear in height (as `bindAlong`). The lateral part of the shoulder / trapezius rings (|x| > 70 mm, the rows between the axilla and the neck base) also follows the clavicle, with up to 55 %. The pelvis bowl under the buttock ring follows the pelvis.
* Limb vertices (per vertex, not per ring): the bone's own joint (`shoulder`, `elbow` for the forearm and the hand, `hip`, `knee` for the shank, `ankle` below it) takes the weight; the neighbouring joint takes part over a blend of **20 %** of the shorter bone on each side of the knee and the elbow (the fit's 15 % loses more volume at a bent knee; at most 40 mm at the ankle, 26 mm at the wrist), widened 2.5 times on the inside of the bend (the back of the knee, the front of the elbow), where the two tubes come together: a half-and-half blend exactly at the joint, so a linear-blend skin bends smoothly. The `forearm` (roll) joint carries the hand only: the skin of the forearm itself is weighted to `elbow` and `wrist`.
* The upper arm and the thigh are rigid with their joint from the joint ring down (no `a` from the clavicle / pelvis: a ring blended half and half collapses when the arm is raised 170 degrees); the dome above the joint, inside the trunk, fades to half and half with the clavicle / pelvis.
* Head: the `head` joint (the jaw carries no skin). Palm: the wrist. Each phalanx follows its own joint, half and half at a knuckle. The foot follows the ankle, the toes `mtp`.
* At most 4 influences per vertex; weights are multiples of 2^-16 and sum to exactly 1, so skinning at rest returns every vertex bit for bit.

The original rule of the fit, for reference: limb rings at fraction `t` along the bone: the bone's own joint takes `1 - a - b`, the proximal neighbour (`clavicle`, `elbow`, `pelvis`, `hip`) takes `a = 0.5 x (1 - smoothstep(t / 0.15))` and the distal neighbour (`elbow`, `wrist`, `knee`, `ankle`) takes `b = 0.5 x smoothstep((t - 0.85) / 0.15)`.

**The skin of `body.js` where the rings are not the whole story** (tests: `tests/human3d/body.test.mjs`, `body.adversarial.test.mjs`):

* The rings are loft sections in **horizontal** planes for every tube (the fit's rings are horizontal sections): perpendicular-to-the-centre-line rings fold a thigh whose centre jumps between two rings (ANSUR II #6275: 1252 mm at the furrow for a ring of 814 mm) and lift the outer edge of a shoulder whose arm is pushed outward (a balloon above the trapezius).
* **The hip.** The torso ends in a bowl under the buttock ring (a quarter ellipse of width, the depth on S curves with a vertical tangent at both ends: the front retreats to the crotch, the back comes forward to the back of the thigh at the gluteal furrow), not in the `crotch` ring (a loft guide). The thigh is shaped from the furrow (`th_prox`, which is untouched) upward: its front is cut by a plane that leans back at 27 degrees from the trunk's front at the buttock ring (a thigh behind the belly is brought up to it), its outer edge is limited to the hip ring's, its back is brought out under the buttock, and the medial faces stay 2 mm from the midline (the fit lets each thigh cross it by up to 30 mm; the girth is given back to 85 % by a deeper section). Over the 176 populations at P5, P50, P95 the thigh section at the furrow is 0.6 % (median) to 1.3 % (worst) below the girth of the fit; before, the thigh stood up to 73 mm in front of the trunk at the hip and the two thighs overlapped by up to 60 mm.
* **The shoulder.** No skin of the upper arm, within 40 mm of the deltoid ring and above it, is wider than half the **measured** bideltoid breadth (`report`): the fit's deltoid ring keeps the section 45 mm wide and 60 mm lateral to the bone axis, which for a narrow shoulder is up to 34 mm too wide (US Army women P5); below, the outer edge may grow by 0.25 per unit of height, at most 12 mm, down to the elbow. The forearm and the hand hang where the fit puts them (the arm of the neutral pose leans out a little, so the whole arm is wider than the bideltoid breadth).
* The foot is 5 mm wider than the shank around the ankle (the fit's foot is as wide as the shank there and the two walls meet at a tangent: a zigzag).
* Linear blend skinning loses volume where a joint bends far: a knee at 150 degrees keeps about 88 % of the leg, a heavy man bent forward 100 degrees 83 % of his trunk, with a few folded triangles at the inner side. A corrective shape would be needed to avoid it.

### 6.5 Adiposity and the mass closure

The skin volume has a fixed part (every ring with `src` of `measured` or `derived`, the head, hands and feet) and a part that scales (the `estimated` rings). The model weight is `volume x 1050 kg/m3 x VOL_CAL`. When at least 25 % of the volume is estimated, the estimated rings
are scaled in both axes by the adiposity factor `s = sqrt((mass / (1050 x VOL_CAL) - V_fixed) / V_est)` (clamped to 0.75 to 1.35, and a floor of 15 % of `V_est`), so the body weighs what the profile says; below 25 % nothing is scaled (a few small estimated rings must not swallow the whole mass difference).
The volume of the shank is summed over its rings as if the ankle were under the knee: the lean of 4.1 would add lean^2 / (2 L) = 0.37 % to the distances along its axis, but leaning a rigid shank does not change its volume
(horizontal sections: Cavalieri) and `VOL_CAL` was fitted with upright shanks; so the mass of the report, the adiposity factor and the girths of the estimated sections do not depend on the lean.
Measured and derived sections are NEVER scaled. So a profile with every girth measured keeps its measured shape and its model mass may differ from the profile mass (report row `mass`, 8.3); a profile with only stature and mass gets `s` from the mass (about 1.00 for a typical BMI; 0.88 to 1.18 over the population files). `body.shape.adiposity` and the dimension `adiposity` carry `s`.

### 6.6 Calibration of `VOL_CAL`

The rings are lofted with the trapezoid rule along each tube; hips, shoulders and the thigh-torso overlaps are counted twice and the sections are simplified, so the raw ring volume exceeds the body volume. `VOL_CAL = 0.917` was fitted on every third person of the database whose profile leaves less than 25 % of the volume estimated (so the adiposity factor is 1; 4,563 people with the current sections: it was 4,597) so that the model mass is close to the profile mass on average (all together 1.0014, SD 0.033). The fixes of the thigh (a circle instead of the compressed seated thickness) and of the chest changed the mean by +0.2 % only, so the constant was kept. The result per sex and survey (mean ratio 0.97 to 1.03, SD 0.023 to 0.032):

| group | n | mean model / profile mass | SD |
|---|---|---|---|
| ANSUR 1988 men | 592 | 1.0011 | 0.0292 |
| ANSUR 1988 women | 736 | 1.0138 | 0.0287 |
| ANSUR II 2012 men | 1360 | 0.9998 | 0.0295 |
| ANSUR II 2012 women | 662 | 1.0277 | 0.0324 |
| ASRAN 2015 men | 345 | 0.9898 | 0.0259 |
| ASRAN 2015 women | 61 | 1.0289 | 0.0263 |
| USAF 1967 men | 807 | 0.9745 | 0.0235 |

## 7. Masses and centres of mass (de Leva 1996)

`body.masses[id] = { label, mass, fraction, com: { joint, offset }, comFraction, proximal, distal }`. `mass` is kg, `fraction` the share of body mass, `com` the centre of mass as an offset in the frame of the joint that carries the segment (so it moves with that joint in any pose; `rig.js` `centerOfMass()` sums `mass x world(com)`), `comFraction` the distance from the proximal end as a fraction of the segment length,
`proximal`/`distal` the end points the length is taken between. `massInfo` has the totals (`total` is the body mass, `fractionSum` is within 1e-4 of 1 (the men's fractions add up to 1.0000, the women's to 0.9999 as published, and are not renormalised: the segments of a woman weigh 0.01 kg less than her mass per 100 kg), `com` is the standing whole-body centre of mass in the world frame, 0.55 to 0.58 of stature).

Fractions from de Leva (1996), "Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters", J Biomech 29:1223 (values read from the Visual3D documentation page of the adjusted table and a second transcription; the paper was not opened). [fraction of body mass, COM from the proximal end], men | women:

| segment | men | women | segment ends (approx.: recalled from the paper) |
|---|---|---|---|
| head (and neck) | 0.0694, 0.5002 | 0.0668, 0.4841 | vertex to C7/T1 (carried by `head`) |
| trunk | 0.4346, 0.5138 | 0.4257, 0.4964 | C7/T1 to the hip-centre midpoint; split below |
| upper arm | 0.0271, 0.5772 | 0.0255, 0.5754 | glenohumeral to elbow centre |
| forearm | 0.0162, 0.4574 | 0.0138, 0.4559 | elbow to wrist centre |
| hand | 0.0061, 0.79 | 0.0056, 0.7474 | wrist centre to the middle knuckle (`middle_mcp`) |
| thigh | 0.1416, 0.4095 | 0.1478, 0.3612 | hip to knee centre |
| shank | 0.0433, 0.4395 | 0.0481, 0.4352 | knee to ankle centre |
| foot | 0.0137, 0.4415 | 0.0129, 0.4014 | heel to toe tip |

The trunk is cut into three rigid parts so that bending the spine moves its mass: `trunk_upper` (thorax), `trunk_middle` (abdomen), `trunk_lower` (pelvis), with shares 15.96 / 16.33 / 11.17 % of body mass (men) and 15.45 / 14.65 / 12.47 % (women) of de Leva's 15-segment model, boundaries at 0, 32.1, 72.6 and 100 % of the C7 to hip-midpoint line
(170.7, 215.5 and 145.7 mm segment lengths; recalled, approx.), each part's centre at its own fraction of its part; the three centres are then shifted together along the line so that the combined centre of mass is exactly the verified whole-trunk value. Each part is carried by the spine joint (or pelvis) nearest to its centre. There are 16 segments: the head, the 3 trunk parts and, on each side (`_L`, `_R`), upper arm, forearm, hand, thigh, shank and foot. The part centres inside the three parts are at 50.7 / 45.0 / 61.2 % (men) and 50.5 / 45.1 / 49.2 % (women) of the part length before the common shift.
Neutral pose COM of a 1.75 m, 78 kg man: 0.975 m (0.557 of stature), 0.3 mm behind the hip midpoint and 36.0 mm in front of the ankle joint centre, 37.4 % of the foot length from the heel (7.1; it was 2.4 mm ahead of the hip midpoint
and 2.4 mm ahead of the ankle before the ankles went back). No inertia tensors are provided.

### 7.1 The centre of mass of quiet standing (the stance)

**Finding.** For the 528 bodies (176 populations x P5, P50, P95) the neutral whole-body centre of mass lay -1.6 to +7.5 mm (median 2.3) in front of the ankle joint centre, 19 to 23 % of the foot length from the heel
(the report that opened this question quoted 11 %: the ankle was 20 % of the foot length from the heel and the centre of mass 2 mm in front of it, so 21 %); for 2,400 real people (600 of each survey) -5.5 to +10.7 mm (median 2.7).
Quiet standing has it 40 to 58 mm in front of the ankle and about 40 % of the foot length from the heel:

| source | what | value |
|---|---|---|
| Di Giulio and Baltzopoulos 2019, Front Physiol 10:625 (13 adults, centre of gravity from the filtered centre of pressure, ankle centre from the malleoli markers and their distance) | centre of gravity in front of the ankle / the knee / the hip joint centre | 47.3 +- 4.1 mm at 0.5 s after the feet are flat, 58.3 +- 5.3 mm at 7.6 s / 25.8 and 32.3 mm / 1.8 and -5.3 mm (so the knee is 21 to 26 mm and the hip 45 to 64 mm in front of the ankle) |
| Kawai et al., congress abstract (Japan, 1997; 20 people, 14 men for the landmarks, video) | centre of gravity | 39.6th percentile of the base of support from its rear edge; 56 mm in front of the lateral malleolus; over the greater trochanter and the acromion |
| Hellebrandt (1940), quoted by Journal of Human Kinetics 2010 (pregnancy posture), not opened | centre of gravity | 40 to 50 mm in front of the line joining the lateral malleoli |
| Winter 1995 (Gait & Posture 3:193) and his textbook | the same, by the inverted pendulum | not retrieved in this environment: no number from them is used |

**Which of the four suspects it was.** (a) The ankle along the foot: the model had the ankle axis 0.20 of the foot length from the heel; the data say 0.23 to 0.25 (4.1, section 3). That moves the foot 11 mm relative to the ankle, not the
centre of mass relative to the ankle: a correction of the foot, now made, and a 4 % shift of the centre of mass along the foot. (b) The foot rings and stations follow the heel, the ankle, the ball and the toes and are not to blame (the ankle
station moved with the ankle). (c) The de Leva fractions and centres reproduce the published values (tests) and the whole-body centre of mass is -5 to +4 mm from the hip joint line in the model against +2 and -5 mm of Di Giulio and
Baltzopoulos: the upper body, with its masses and the 25 mm L5 set-back, is right. (d) **The legs were upright**: hip directly over the ankle, so the centre of mass could not be more than the 2 mm it lies in front of the hip. Real people lean forward about
the ankles in quiet standing, the hip 45 to 64 mm in front of the ankle. That is the cause, and the fix is in the placement of the ankles, in `leanLegs()` (4.1).

**Result** (`stance`; mm unless said; min, P5, P25, median, P75, P95, max). The target `comFromHeel` = 40 % of the foot, with the shank lean capped at `leanMaxDeg` = 4.9 degrees:

| | 528 population bodies | 2,400 real people |
|---|---|---|
| centre of mass in front of the ankle | 27.1, 31.1, 33.6, 35.6, 36.3, 39.4, 44.0 (before: -1.6, 1.0, 2.1, 2.3, 2.4, 4.0, 7.5) | 24.9, 30.5, 33.6, 36.1, 38.8, 42.6, 47.1 (before: -5.5, -1.5, 0.8, 2.7, 5.0, 8.7, 10.7) |
| centre of mass from the heel, % of the foot | 35.9, 36.9, 37.4, 37.5, 37.7, 38.3, 39.5 (before: 19.4, 20.4, 20.8, 20.9, 20.9, 21.5, 22.6) | 33.9, 35.9, 36.9, 37.6, 38.5, 39.8, 40.0 (before: 17.9, 19.4, 20.3, 21.0, 21.9, 23.3, 24.2) |
| hip joint centre (= the knee) in front of the ankle (the lean) | 27.1, 31.4, 34.1, 36.1, 36.6, 39.6, 41.6 | 25.8, 32.3, 34.4, 35.9, 37.5, 39.6, 43.1 |
| centre of mass in front of the hip joint centre | -4.2, -1.6, -0.6, -0.3, -0.2, 1.4, 4.5 | -8.4, -4.2, -1.9, 0.0, 2.4, 6.1, 8.1 |
| shank lean, degrees | 4.90 in all | 4.24, 4.90, 4.90, 4.90, 4.90, 4.90, 4.90 |

All 528 bodies and all 2,400 people are inside 20 to 50 mm. The cap binds for all the 528 bodies and 2,304 of the 2,400 people (the other 96 reach the 40 % first, with a lean of 4.2 to 4.9 degrees). The centre of mass is 0.135 of the foot length
in front of the ankle for the median man (36 mm for a 268 mm foot), against 0.16 (42 mm) for the 40 %: below the measured 47 to 58 mm (means 47, 56 and 58 mm) by 11 to 22 mm, 2.5 % of the foot below the 40 % of Kawai.

**Why the lean is capped (the choice between the 40 % and the measured lean).** The first version of the stance solved the 40 % without a cap: 44 mm behind the knee for the median man, a shank lean of 4.5 to 7.3 degrees over 1,128 bodies (median 5.9, 1,103 of them above
5 degrees), a neutral knee angle of 174.3 and ankle angle of 84.3, and a seated ISO 7250-1 shank 5.9 degrees off the vertical. The measurements put the knee 21 to 26 mm in front of the ankle (3 degrees of a 0.43 m shank) and the hip 45 to 64 mm: a leg
that leans 3 to 4 degrees as a whole, with the thigh leaning as well. A model with a vertical thigh has the hip and the knee equally far forward, so it can match the hip (and the centre of mass: 40 %) or the knee (3 degrees), not both, and the first version
matched the centre of mass at twice the measured lean. Trade-off, the candidates measured over the 1,128 bodies (528 populations + 600 real people), the target in the first column:

| target (% of the foot from the heel), cap | shank lean (median, range) | centre of mass in front of the ankle (median, range) | bodies above 5 degrees | library validations failing (99 postures x 176 medians) |
|---|---|---|---|---|
| 40 %, no cap (first version) | 5.9 deg, 4.5 to 7.3 | 42 mm, 35 to 49 | 1,103 | 304 |
| 40 %, cap 4.9 deg (**now**) | 4.9 deg, 4.5 to 4.9 | 35 mm, 26 to 46 | 0 | 528 |
| 34 %, no cap | 3.6 deg, 2.3 to 4.9 | 26 mm, 22 to 31 | 0 | 1,238 |
| 33 %, no cap | 3.2 deg, 1.9 to 4.4 | 24 mm, 20 to 28 | 0 | not run |
| thigh vertical, upright shank (before the stance) | 0 | 2 mm | 0 | 3,580 |

(The last column counts the postures of the library as it stood when it was measured, 19 October 2026; the failures are mostly postures that the authors of `postures/sitting.js` and `postures/vehicle.js` tuned on six bodies against the 5.9 degrees and that sit at the
edge of their 15 mm of tolerance on other bodies, and the seiza, whose toes end 6 to 10 mm below the floor.) The measured lean of 3 to 4 degrees needs a target of 34 %, at which the library written for the 5.9 degrees fails four times as often and the balance rule judges a tiptoe or a
lean back 16 mm more strictly than quiet standing; the cap of 4.9 degrees keeps the check of the lean (1 to 5 degrees), keeps the centre of mass within 2.5 % of the foot of the measured 40 %, and leaves the posture library within 8 mm of where it was tuned. It is a compromise, and `leanMaxDeg`
and `comFromHeel` are the two numbers to change if the library or the measurements ask for another (the tests read both from `CONSTANTS`).

**What the lean does to the checks of the posture engine** (`pose.js` `balance` over the contact points of both feet; US Army man P50 / man P95 / woman P5 / woman P50; before and after, margin in mm, negative = outside the support polygon):
standing 28 / 31 / 24 / 23 to 72 / 79 / 62 / 64; on tiptoe (ankles plantar-flexed 45, toe joints dorsiflexed 45, ball and toes) -33 / -33 / -31 / -34 to -7 / -5 / +5 / +4 (a person on tiptoe is balanced; the upright model fell backward, and this one is within 7 mm of the ball line);
a flat-footed deep squat with the trunk upright (hips 120, knees 145, ankles 30) -84 / -95 / -95 / -66 to -43 / -50 / -59 / -28 (still outside: a real squat leans the trunk or reaches forward). The full table is in `POSE.md`, "Balance and the stance".

**What did not change** (all 2,928 bodies of the sweeps, the measure rows of the fit report before and after): no model value moved by more than 0.007 mm (the calf girth), not one report status changed, no warning appeared (the lean moves the ankle only: heights, the seated
posture, the seat plane, the sitting height, the volume (at most 1 cm3) and the mass are as they were, 4.1, 6.5).

**Limits.** The target is a calibration (`comFromHeel`, `leanMaxDeg`), not a measurement on the model: the evidence is that the lean is within the measured 3 to 4 degrees plus 1 and the centre of mass within 2.5 % of the foot of the measured 40 %, in a model whose upper body already matched the hip line. Quiet standing only: the centre of mass moves 20 mm or so in sway and
50 to 100 mm when a person leans deliberately. The shank carries the whole lean (4.1): the knee angle of the neutral pose is 175 and the leg has a 4.9 degree angle there; real legs lean as a whole, so the knee is 10 to 15 mm too far forward and the hip 10 to 25 mm too far back, and the ankle is dorsiflexed 1 to 2 degrees more than
a person's in the same stance. Di Giulio and Baltzopoulos derive the centre of gravity from the centre of pressure and Kawai's source is a congress abstract; the Winter numbers could not be retrieved (see the table).

## 8. The fit report

`body.report` is an array of rows `{ id, label, unit, kind, posture, input, model, delta, tolerance, status, note }` (mm; kg for the mass):

* `kind: "measure"`: a standard measure (the ids are the profile keys) re-measured on the BUILT model in its reference posture with the same landmark definition as the survey: `input` the profile value (null when the profile has none), `model` the value measured on the model, `delta = model - input`,
  `tolerance = max(5 mm, 0.5 % of the input)` (mass: 5 %), `status` `ok` within the tolerance, `warn` within `max(15 mm, 2 %)` (mass 10 %), `off` beyond, `n/a` without an input. `note` carries the reason why a measure cannot be exact when it is not (8.3) or "not used to build the model" for a rejected input.
* `kind: "check"`, `id: "check:<dimension>"`: an alternative route of a dimension (2.3) against the one that was used.

`reportSummary` counts the measure rows by status, the checks that are not ok (`checksOff`), the dimension statuses and the closure deltas. The report is both a UI panel and the main test: if a number here is wrong the model is wrong.

`evaluateMeasures(body, pose?)` (exported) recomputes the measure rows with `Kinematics`. Without `pose` each measure is taken in its reference posture. With `pose = { root, angles }` (the shape of `rig.getPose()`) every measure is evaluated in that pose: heights above the lowest foot contact, seat heights above the lowest ischial point, notes say "evaluated in the given pose".
`referencePose(body, name)` returns `{ root, angles, label }` of a reference posture; `REFERENCE_POSTURES` and `REPORT_MEASURES` (id, label, posture, unit, why) are exported tables.

### 8.1 Reference postures

| id | posture | joint angles (degrees) |
|---|---|---|
| `stand` | standing, neutral | all 0 |
| `arm90` | standing, elbows bent 90 degrees | elbow_L [90], elbow_R [90] |
| `seat` | ISO 7250 seated: hips 90, knees 90, ankles 0, trunk upright | hip_L [90, 0, 0], hip_R [90, 0, 0], knee_L [90, 0], knee_R [90, 0] |
| `seat_arm` | seated, upper arms vertical, elbows 90 | hip_L [90, 0, 0], hip_R [90, 0, 0], knee_L [90, 0], knee_R [90, 0], elbow_L [90], elbow_R [90] |
| `tpose` | arms out to the sides (shoulder abduction 90) | shoulder_L [0, 90, 0], shoulder_R [0, 90, 0] |
| `forward` | arms forward (shoulder flexion 90) | shoulder_L [90, 0, 0], shoulder_R [90, 0, 0] |

The table is the NOMINAL definition of the postures (`REFERENCE_POSTURES`). For `tpose` and `forward` the angles are corrected for this body's neutral abduction `beta` (4.5): `referencePose(body, 'tpose')` returns `shoulder_L/R [0, 90 - beta, 0]` and `referencePose(body, 'forward')` returns `shoulder_L/R [90, a, 0]` with the adduction `a` (about -`beta`) that puts the arm in the sagittal plane, so that the arm is horizontal and the span and reach are not shortened by `L (1 - cos beta)`. The report uses these.

In the seated postures the root is at the knee height of the body (thighs horizontal, hips and knees at 90 degrees, ankles 0), the seat plane is the lowest ischial landmark, and the floor under the feet. The shank of a seated body is the shank of the neutral pose (hip 90 and knee 90 turn its frame
by 90 degrees and back), so the lower leg leans back by the stance lean (4.9 degrees, the ankle 36 mm behind the knee) instead of being vertical as ISO 7250-1 draws it; the feet are flat and every height is what it is with a vertical shank. A strictly vertical shank would be knee `90 - lean`, ankle `-lean`
degrees, and its bone, 1.6 mm longer than the vertical distance, would put the soles 1.6 mm below the floor; the wall for thumbtip reach and abdominal depth sitting is the mean of the shoulder-blade extremity and the buttock extremity (a rigid trunk cannot touch with both).

### 8.2 What is exact and what is not (by design)

The rows of 8.3 whose mean and SD are 0.0 are exact by construction: stature; the surface heights cervicale, suprasternale, acromion; biacromial breadth; the waist, thigh, calf, ankle, biceps, forearm, neck-base and head girths; radiale-stylion; hand and foot length and breadth;
head length and breadth, bizygomatic breadth, menton-sellion, interpupillary breadth; sitting height; knee height sitting; and, for the people who have them, the `other:` heights, the waist and hip breadths and depths. Rows with an SD of a few mm are exact except for the people whose profile is
contradictory (a route was rejected, a landmark height was moved, a clamp was reached): the dimension's note and the warnings say which. Differences that remain are posture or definition differences, not fitting error, and the report says so in the `note`:

* `acromion_height_sitting`, `elbow_rest_height`: people sit with a slightly different shoulder height from standing (2 mm lower on average, SD 13 to 15 mm); the rigid trunk cannot.
* `abdominal_depth_sitting`: measured against a wall, includes the sitting slump and the lumbar hollow; the rigid model gets it right on average (the lumbar `spineBack` constant is tuned for that) with an SD of 17 mm.
* `chest_breadth`, `chest_depth`, `chest_circumference` (and the waist and hip rows when they have all three measures): exact unless the tape is longer than a section of the measured breadth and depth with an exponent up to 12 can hold; then up to 1.5 % of the girth is left out (the circumference row says "warn") and the rest is paid for by growing breadth and depth (6.1). This concerns the ANSUR II men (mean +1.1 mm breadth over everybody; +3.8 mm for the men alone, was +23.7 mm).
* `other:wrist_height`: the model arm hangs straight, a real arm has a slightly bent elbow (about 7 to 12 mm higher wrist).
* `biceps_circumference_flexed`: the relaxed arm of the neutral pose is drawn with the flexed girth, which is 5 to 8 % larger than a relaxed one.
* `span`, `thumbtip_reach`: depend on the shoulder width and on how the shoulder girdle moves when the arms rise; exact when the two shoulder parameters are inside their clamps. Without them in the profile they are estimates with the biases of 4.5 (the reach: pooled -3 / -1 mm, SD 24 to 39 mm by survey).
* `mass`: from the volume of the sections; exact only through the adiposity factor when girths are estimated (6.5).
* The buttock-knee length, buttock-popliteal length and eye height sitting of about 1 % of people are inconsistent with the rest of their profile; warnings name the conflicting measures.

### 8.3 Measures, postures and validation

Statistics: model minus input, for people sampled evenly from the four surveys (every 6th of 13,792 ordered by subject key: 2,299; `other:` measures only for the ANSUR II people of the sample, whose raw columns were attached: 1,011): mean and SD in mm, and the share ok / warn / off. Reproduce with a loop over `subjectProfile(row)` and `fitBody` (3.4 ms per fit on average, 4 ms with the report).

| measure (profile key) | posture | what is measured on the model | exact? (mean / SD of model - input, mm; % ok / warn / off; n) |
|---|---|---|---|
| `stature` | stand | Stature: the vertex is exactly at the stature | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `cervicale_height` | stand | Cervicale height | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `suprasternale_height` | stand | Suprasternale height | -0.0 / 0.0; 100 / 0 / 0; 2298 |
| `acromion_height` | stand | Acromion height | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `iliocristale_height` | stand | Iliocristale height | -0.1 / 3.3; 100 / 0 / 0; 2298 |
| `trochanterion_height` | stand | Trochanterion height | 0.0 / 3.3; 100 / 0 / 0; 2297 |
| `crotch_height` | stand | Crotch height | -0.0 / 2.2; 100 / 0 / 0; 2294 |
| `other:omphalion_height` | stand | Omphalion (waist) height | 0.1 / 5.6; 100 / 0 / 0; 1011 |
| `other:chest_height` | stand | Chest (nipple) height | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:lateral_malleolus_height` | stand | Lateral malleolus height | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:lateral_femoral_epicondyle_height` | stand | Lateral femoral epicondyle height | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:knee_height_midpatella` | stand | Mid-patella height | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:wrist_height` | stand | Wrist (stylion) height: the model's arm hangs along a straight line: real arms hang with a slightly bent elbow, so the wrist is about 12 mm higher than shoulder height minus the arm bones | -8.2 / 10.8; 26 / 52 / 23; 1011 |
| `biacromial_breadth` | stand | Biacromial breadth | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `bideltoid_breadth` | stand | Bideltoid breadth | 0.3 / 2.6; 98 / 1 / 1; 2299 |
| `bicristal_breadth` | stand | Bicristal breadth | 0.0 / 0.0; 100 / 0 / 0; 1635 |
| `chest_breadth` | stand | Chest breadth | 1.1 / 3.1; 91 / 8 / 1; 2299 |
| `chest_depth` | stand | Chest depth | 1.0 / 2.9; 92 / 7 / 1; 2299 |
| `other:waist_breadth` | stand | Waist breadth | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:waist_depth` | stand | Waist depth | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:hip_breadth` | stand | Hip breadth (standing) | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `other:buttock_depth` | stand | Buttock depth | 0.0 / 0.0; 100 / 0 / 0; 1011 |
| `chest_circumference` | stand | Chest circumference | -3.4 / 6.4; 78 / 22 / 0; 2299 |
| `waist_circumference` | stand | Waist circumference | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `buttock_circumference` | stand | Buttock circumference | 0.1 / 3.8; 100 / 0 / 0; 2299 |
| `neck_circumference` | stand | Neck circumference | -0.0 / 2.1; 100 / 0 / 0; 2298 |
| `neck_circumference_base` | stand | Neck circumference at the base | -0.0 / 0.0; 100 / 0 / 0; 1896 |
| `thigh_circumference` | stand | Thigh circumference (gluteal furrow) | 0.0 / 0.0; 100 / 0 / 0; 2267 |
| `other:knee_circumference` | stand | Knee circumference | not sampled |
| `calf_circumference` | stand | Calf circumference | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `ankle_circumference` | stand | Ankle circumference | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `biceps_circumference_flexed` | stand | Biceps circumference, flexed: the neutral arm is drawn with the flexed girth; a relaxed biceps is 5 to 8 % smaller | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `forearm_circumference_flexed` | stand | Forearm circumference, flexed | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `wrist_circumference` | stand | Wrist circumference | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `head_circumference` | stand | Head circumference | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `acromion_radiale_length` | stand | Acromion-radiale length | -0.0 / 1.2; 100 / 0 / 0; 2299 |
| `radiale_stylion_length` | stand | Radiale-stylion length | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `hand_length` | stand | Hand length | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `hand_breadth` | stand | Hand breadth | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `foot_length` | stand | Foot length | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `foot_breadth` | stand | Foot breadth | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `head_length` | stand | Head length | 0.0 / 0.0; 100 / 0 / 0; 2298 |
| `head_breadth` | stand | Head breadth | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `bizygomatic_breadth` | stand | Bizygomatic breadth | 0.0 / 0.0; 100 / 0 / 0; 2299 |
| `menton_sellion_length` | stand | Menton-sellion length | 0.0 / 0.0; 100 / 0 / 0; 2298 |
| `interpupillary_breadth` | stand | Interpupillary breadth | 0.0 / 0.0; 100 / 0 / 0; 2297 |
| `shoulder_elbow_length` | arm90 | Shoulder-elbow length | 0.0 / 0.0; 100 / 0 / 0; 2078 |
| `sitting_height` | seat | Sitting height: the seat plane absorbs the difference between standing and sitting trunk length (hip_to_seat) | -0.0 / 0.0; 100 / 0 / 0; 2299 |
| `eye_height_sitting` | seat | Eye height sitting | 0.1 / 2.6; 100 / 0 / 0; 2299 |
| `acromion_height_sitting` | seat | Acromion height sitting: the trunk is rigid: people sit with a slightly lower shoulder than they stand with (about 2 mm lower on average, SD 12 mm) | 1.5 / 12.1; 38 / 43 / 19; 1288 |
| `elbow_rest_height` | seat_arm | Elbow rest height: = acromion height sitting - shoulder-elbow length: differs when the sitting shoulder height does | -0.3 / 13.7; 33 / 44 / 24; 2299 |
| `thigh_clearance` | seat | Thigh clearance | 0.0 / 0.2; 100 / 0 / 0; 2299 |
| `knee_height_sitting` | seat | Knee height sitting | 0.0 / 0.7; 100 / 0 / 0; 2299 |
| `popliteal_height` | seat | Popliteal height | -0.0 / 0.9; 100 / 0 / 0; 2299 |
| `buttock_knee_length` | seat | Buttock-knee length | 0.4 / 8.1; 99 / 0 / 1; 2299 |
| `buttock_popliteal_length` | seat | Buttock-popliteal length | -0.3 / 5.0; 99 / 0 / 1; 2299 |
| `hip_breadth_sitting` | seat | Hip breadth sitting | -0.1 / 2.4; 100 / 0 / 0; 2299 |
| `abdominal_depth_sitting` | seat | Abdominal depth sitting: measured against a wall: the lumbar hollow and the sitting slump are not in the rigid model | 2.8 / 17.3; 24 / 38 / 39; 1896 |
| `span` | tpose | Arm span (fingertip to fingertip): depends on shoulder width and the arm bones, each driven by its own measure; real shoulders also move outward when the arms are raised | 0.6 / 4.2; 97 / 2 / 0; 1675 |
| `thumbtip_reach` | forward | Thumbtip reach: depends on the back wall (the most posterior of buttocks and shoulder blades) and on the thumb pose | -0.3 / 4.1; 99 / 1 / 1; 2299 |
| `mass` | stand | Body mass (volume x 1.05 kg/L): from the volume of the skin sections; the mass of the profile is only matched through the adiposity factor when girths are estimated | -0.0 / 2.5; 89 / 11 / 0; 2299 |

## 9. Data tables (all computed from `database/anthro.sqlite`)

### 9.1 Provenance

13,792 real adults: ANSUR 1988 (US Army, 3,982: men 1,774, women 2,208), ANSUR II 2012 (US Army, 6,068: men 4,082, women 1,986), ASRAN 2015 (Royal Australian Navy, 1,322: men 1,090, women 232; 44 of its measures extracted from 3D scans), USAF 1967 (flying personnel, 2,420 men). Men 9,366, women 4,426. Harmonised by `database/README.md`
(mass hectograms and pounds converted, interpupillary breadth tenths of a mm, ...). The survey methods differ (landmarks, posture, scans): the regressions pool them, so each carries the between-survey difference in its residual SD; the surveys are not US-civilian or global samples, they are military populations of their time (the model's "average adult" is a serving soldier, sailor or airman).
Measures that the table `subjects` does not carry (`other:` keys) were read from the raw tables of the surveys: `lateral_malleolus_height`, `lateral_femoral_epicondyle_height`, `knee_height_midpatella`, `wrist_height`, `buttock_depth`, `waist_depth`, `waist_breadth`, `hip_breadth`, `omphalion_height`, `chest_height`, `axilla_height`, `buttock_height`, `knee_circumference`,
`bimalleolar_breadth`, `heel_breadth`, `ball_of_foot_length`, `gluteal_furrow_height`, `lower_thigh_circumference`, `wrist_to_grip`, `wrist_to_thumbtip`, `palm_length`, `tragion_top_of_head` etc. from ANSUR 1988 and II (and USAF / ASRAN where they have the column), hence the smaller n. Mean stature and BMI: men 1764 mm (range 1491 to 2049), BMI median 26.16 (P5 21.0, P95 33.3);
women 1629 mm (1409 to 1875), BMI 24.04 (P5 19.7, P95 30.3).

### 9.2 Regressions (`REGRESSIONS`)

Ordinary least squares per sex: `value [mm] = a + bS x S [mm] + bM x M [kg]`; SD is the residual standard deviation in mm; n the subjects. The test `regression and relation tables reproduce from the database` recomputes every row.

| measure (profile key without `other:`) | men | women |
|---|---|---|
| `abdominal_depth_sitting` | 317.7 - 0.1589 S + 2.553 M, SD 18.6, n 6944 | 283.4 - 0.1428 S + 2.707 M, SD 17, n 4426 |
| `acromion_height` | -76.6 + 0.8449 S + 0.3846 M, SD 16.5, n 9364 | -74.3 + 0.8519 S + 0.3175 M, SD 14.1, n 4426 |
| `acromion_height_sitting` | 122.5 + 0.2532 S + 0.4206 M, SD 22.1, n 5282 | 87.1 + 0.2683 S + 0.5167 M, SD 21.2, n 2440 |
| `acromion_radiale_length` | 6.8 + 0.1807 S + 0.1118 M, SD 12.2, n 9362 | -11.8 + 0.1937 S + 0.1126 M, SD 10.7, n 4426 |
| `ankle_circumference` | 153.1 + 0.004364 S + 0.7996 M, SD 9.8, n 9362 | 140.4 + 0.005792 S + 0.9407 M, SD 11.1, n 4426 |
| `axilla_height` | -150.8 + 0.8416 S - 0.007222 M, SD 15.2, n 5856 | -122.9 + 0.8346 S - 0.00729 M, SD 14, n 4194 |
| `ball_of_foot_length` | 40.7 + 0.08194 S + 0.1729 M, SD 7.9, n 6939 | 32.4 + 0.08189 S + 0.227 M, SD 7, n 4426 |
| `biacromial_breadth` | 229.9 + 0.07 S + 0.6742 M, SD 16.4, n 9362 | 153 + 0.1125 S + 0.4222 M, SD 14.8, n 4426 |
| `biceps_circumference_flexed` | 382 - 0.1291 S + 2.325 M, SD 18.4, n 9364 | 343.8 - 0.1461 S + 2.89 M, SD 13.5, n 4426 |
| `bicristal_breadth` | 103.4 + 0.06174 S + 0.794 M, SD 15.2, n 7588 | 153.5 + 0.01861 S + 1.322 M, SD 16.1, n 2218 |
| `bideltoid_breadth` | 443.6 - 0.07268 S + 2.218 M, SD 16.1, n 9364 | 364.6 - 0.04917 S + 2.41 M, SD 14, n 4425 |
| `bimalleolar_breadth` | 30.9 + 0.01927 S + 0.113 M, SD 3.3, n 5856 | 29.4 + 0.01657 S + 0.1426 M, SD 2.8, n 4194 |
| `bizygomatic_breadth` | 135.6 - 0.007746 S + 0.243 M, SD 5.1, n 9364 | 123.5 - 0.004809 S + 0.259 M, SD 4.9, n 4426 |
| `buttock_circumference` | 787.7 - 0.1286 S + 5.372 M, SD 24.3, n 9364 | 827.4 - 0.1827 S + 7.149 M, SD 28.6, n 4425 |
| `buttock_depth` | 238.7 - 0.07712 S + 1.728 M, SD 12.4, n 8276 | 246.4 - 0.0963 S + 2.167 M, SD 11.8, n 4194 |
| `buttock_height` | -187.6 + 0.6196 S - 0.1461 M, SD 25.7, n 8276 | -121.5 + 0.583 S + 0.1232 M, SD 25.2, n 4194 |
| `buttock_knee_length` | 89.2 + 0.2568 S + 0.8699 M, SD 17.2, n 9364 | 92.7 + 0.2555 S + 1.234 M, SD 17.9, n 4426 |
| `buttock_popliteal_length` | 18.9 + 0.2576 S + 0.3469 M, SD 17.9, n 9357 | 25.5 + 0.2549 S + 0.6437 M, SD 18.5, n 4425 |
| `calf_circumference` | 351.9 - 0.07534 S + 2.006 M, SD 15.5, n 9362 | 306 - 0.0609 S + 2.41 M, SD 16.5, n 4426 |
| `cervicale_height` | -38.6 + 0.8698 S + 0.2967 M, SD 13.1, n 9364 | -87.6 + 0.9177 S - 0.08591 M, SD 12.2, n 4426 |
| `chest_breadth` | 154.3 + 0.05105 S + 0.7894 M, SD 25.8, n 9364 | 201 - 0.003686 S + 1.241 M, SD 16.2, n 4426 |
| `chest_circumference` | 1046 - 0.3178 S + 6.534 M, SD 34.2, n 9364 | 965.5 - 0.3103 S + 7.181 M, SD 38.6, n 4426 |
| `chest_depth` | 243.4 - 0.0783 S + 1.757 M, SD 12.5, n 9364 | 269.5 - 0.1056 S + 2.251 M, SD 14.1, n 4426 |
| `chest_height` | -87.3 + 0.7732 S + 0.1673 M, SD 18.7, n 8276 | -156 + 0.8357 S - 0.4966 M, SD 21.2, n 4194 |
| `crotch_height` | -211.4 + 0.6136 S - 0.2742 M, SD 23.5, n 9343 | -192.1 + 0.5992 S - 0.1067 M, SD 24.3, n 4418 |
| `ear_length` | 43.7 + 0.008481 S + 0.07542 M, SD 4.3, n 9364 | 41.2 + 0.008608 S + 0.06663 M, SD 3.7, n 4425 |
| `elbow_rest_height` | 156.6 + 0.02296 S + 0.5496 M, SD 27.3, n 9364 | 156.3 + 0.02218 S + 0.526 M, SD 26.4, n 4426 |
| `eye_height_sitting` | 169.8 + 0.3511 S + 0.1771 M, SD 22.2, n 9364 | 151.2 + 0.3553 S + 0.2032 M, SD 21.8, n 4426 |
| `foot_breadth` | 59.7 + 0.01375 S + 0.2001 M, SD 4.5, n 9364 | 55.3 + 0.01248 S + 0.2382 M, SD 4.3, n 4426 |
| `foot_circumference` | 132.2 + 0.04523 S + 0.4723 M, SD 9.7, n 5856 | 121.1 + 0.04224 S + 0.5519 M, SD 9.2, n 4194 |
| `foot_length` | 52.1 + 0.1152 S + 0.1857 M, SD 8.9, n 9361 | 45.6 + 0.1124 S + 0.2533 M, SD 8.6, n 4426 |
| `forearm_circumference_flexed` | 256.9 - 0.03317 S + 1.293 M, SD 12.6, n 9363 | 222.4 - 0.03789 S + 1.51 M, SD 10.2, n 4426 |
| `forearm_forearm_breadth` | 594.4 - 0.1767 S + 3.384 M, SD 28.1, n 9364 | 460.4 - 0.1299 S + 3.578 M, SD 23.1, n 4426 |
| `gluteal_furrow_height` | -191.6 + 0.5786 S - 0.224 M, SD 22.3, n 4194 | -184.8 + 0.5826 S - 0.3244 M, SD 24, n 2208 |
| `hand_breadth` | 47.2 + 0.0187 S + 0.1062 M, SD 3.7, n 9361 | 40.3 + 0.01986 S + 0.09407 M, SD 3.3, n 4426 |
| `hand_circumference` | 119.5 + 0.03918 S + 0.2997 M, SD 8.4, n 9360 | 106.1 + 0.03607 S + 0.3288 M, SD 7.1, n 4425 |
| `hand_length` | 45.6 + 0.07841 S + 0.1043 M, SD 7.4, n 9362 | 36.6 + 0.08251 S + 0.1401 M, SD 8, n 4426 |
| `head_breadth` | 140 + 0.001358 S + 0.1543 M, SD 5.8, n 9362 | 133.5 + 0.0003848 S + 0.192 M, SD 5.5, n 4426 |
| `head_circumference` | 472.2 + 0.03433 S + 0.4938 M, SD 13.6, n 9364 | 463.7 + 0.02598 S + 0.7265 M, SD 16.4, n 4426 |
| `head_length` | 148.8 + 0.02152 S + 0.1481 M, SD 6.4, n 9363 | 138.1 + 0.02379 S + 0.1792 M, SD 6.4, n 4426 |
| `heel_ankle_circumference` | 120.4 + 0.09634 S + 0.6307 M, SD 10.3, n 5856 | 116.5 + 0.08751 S + 0.7467 M, SD 10.3, n 4194 |
| `heel_breadth` | 54.2 - 0.00007315 S + 0.2124 M, SD 4.7, n 5856 | 51.4 - 0.003351 S + 0.2942 M, SD 4.6, n 4194 |
| `hip_breadth` | 195 + 0.02629 S + 1.288 M, SD 13.9, n 8276 | 248.7 - 0.02267 S + 2.104 M, SD 14.5, n 4194 |
| `hip_breadth_sitting` | 243.9 - 0.01227 S + 1.872 M, SD 14.4, n 9363 | 298.9 - 0.04965 S + 2.681 M, SD 17.1, n 4426 |
| `iliocristale_height` | -179.2 + 0.7246 S - 0.3122 M, SD 22.5, n 9363 | -125.5 + 0.6782 S + 0.1865 M, SD 20.3, n 4426 |
| `interpupillary_breadth` | 55.3 + 0.001775 S + 0.06563 M, SD 3.5, n 9360 | 49.3 + 0.005658 S + 0.05371 M, SD 3.6, n 4423 |
| `knee_circumference` | 255.1 - 0.002921 S + 1.74 M, SD 11.4, n 5276 | 244.2 - 0.01589 S + 2.375 M, SD 13.1, n 2438 |
| `knee_height_midpatella` | -125.7 + 0.3608 S - 0.1734 M, SD 16.9, n 5856 | -111.2 + 0.3532 S - 0.1548 M, SD 15, n 4194 |
| `knee_height_sitting` | -51.6 + 0.3348 S + 0.2094 M, SD 12.9, n 9364 | -54.5 + 0.3393 S + 0.2281 M, SD 13.5, n 4425 |
| `lateral_femoral_epicondyle_height` | -104.8 + 0.3472 S - 0.1221 M, SD 14.1, n 5856 | -69 + 0.3201 S + 0.1692 M, SD 14.9, n 4194 |
| `lateral_malleolus_height` | 14.5 + 0.02612 S + 0.1287 M, SD 5.4, n 5856 | 9.8 + 0.0297 S + 0.05272 M, SD 4.8, n 4194 |
| `lower_thigh_circumference` | 343.4 - 0.06909 S + 2.182 M, SD 14.4, n 5856 | 343.2 - 0.09517 S + 3.095 M, SD 17.2, n 4194 |
| `menton_sellion_length` | 78.3 + 0.01982 S + 0.1081 M, SD 6.4, n 9355 | 73.1 + 0.02024 S + 0.1119 M, SD 5.7, n 4426 |
| `neck_circumference` | 380.1 - 0.07134 S + 1.663 M, SD 15.1, n 9359 | 284.6 - 0.03874 S + 1.567 M, SD 12.5, n 4425 |
| `neck_circumference_base` | 349.5 - 0.02896 S + 1.551 M, SD 18, n 6944 | 271.8 - 0.01015 S + 1.598 M, SD 15.4, n 4426 |
| `omphalion_height` | -189.3 + 0.7285 S - 0.4176 M, SD 20.1, n 8276 | -202.8 + 0.7472 S - 0.5141 M, SD 19.6, n 4194 |
| `palm_length` | 29.3 + 0.04578 S + 0.07873 M, SD 4.9, n 4082 | 27 + 0.04603 S + 0.09874 M, SD 4.7, n 1986 |
| `popliteal_height` | -127.4 + 0.3357 S - 0.3868 M, SD 12.7, n 9361 | -132.9 + 0.3418 S - 0.5442 M, SD 13.3, n 4426 |
| `radiale_stylion_length` | -4.5 + 0.1532 S + 0.03164 M, SD 10.8, n 9362 | -17.4 + 0.1579 S + 0.0383 M, SD 11.3, n 4426 |
| `shoulder_circumference` | 856.5 + 0.00008633 S + 3.91 M, SD 35.1, n 8276 | 718.4 + 0.02859 S + 4.056 M, SD 31.6, n 4194 |
| `shoulder_elbow_length` | 2.8 + 0.2017 S + 0.06817 M, SD 11.7, n 8276 | -20.5 + 0.2172 S + 0.02722 M, SD 10.2, n 4194 |
| `shoulder_length` | 29 + 0.07641 S - 0.1163 M, SD 12.5, n 9364 | 33.2 + 0.07131 S - 0.1432 M, SD 10.8, n 4426 |
| `sitting_height` | 202.8 + 0.402 S + 0.1354 M, SD 22.1, n 9364 | 197.8 + 0.3963 S + 0.1768 M, SD 22.3, n 4426 |
| `sleeve_outseam` | -48 + 0.3689 S - 0.04479 M, SD 18.8, n 6942 | -43.9 + 0.3587 S + 0.07844 M, SD 18.7, n 4426 |
| `span` | 70.5 + 0.9777 S + 0.3525 M, SD 47.9, n 5856 | 3.3 + 1.01 S + 0.2731 M, SD 49.2, n 4194 |
| `suprasternale_height` | -44.7 + 0.8294 S + 0.2963 M, SD 13.1, n 9363 | -59.2 + 0.842 S + 0.2635 M, SD 10.9, n 4426 |
| `thigh_circumference` | 592.7 - 0.1897 S + 4.266 M, SD 21.8, n 9222 | 569.4 - 0.1963 S + 5.38 M, SD 21, n 4378 |
| `thigh_clearance` | 171.9 - 0.05166 S + 1.132 M, SD 8.9, n 9364 | 149.3 - 0.04109 S + 1.248 M, SD 7.7, n 4426 |
| `thumbtip_reach` | 112.7 + 0.3632 S + 0.645 M, SD 31.9, n 9360 | 88.9 + 0.3695 S + 0.7234 M, SD 28.7, n 4426 |
| `tragion_top_of_head` | 103.2 + 0.01396 S + 0.03998 M, SD 6, n 4082 | 98.2 + 0.01328 S + 0.0983 M, SD 6.3, n 1986 |
| `trochanterion_height` | -226.8 + 0.6768 S - 0.5749 M, SD 26.6, n 9356 | -129.6 + 0.6128 S - 0.2305 M, SD 24.8, n 4426 |
| `vertical_trunk_circumference` | 655.8 + 0.3628 S + 4.482 M, SD 43.5, n 8276 | 716.4 + 0.3077 S + 5.043 M, SD 38.4, n 4194 |
| `waist_breadth` | 285.3 - 0.09157 S + 2.363 M, SD 14.7, n 8276 | 291 - 0.1068 S + 2.743 M, SD 18.4, n 4194 |
| `waist_circumference` | 971.9 - 0.4145 S + 8.102 M, SD 42.4, n 9364 | 961.3 - 0.4585 S + 9.434 M, SD 48.9, n 4426 |
| `waist_depth` | 279.8 - 0.1327 S + 2.254 M, SD 15.2, n 8276 | 284.4 - 0.1523 S + 2.655 M, SD 16.2, n 4194 |
| `wrist_circumference` | 93.3 + 0.02713 S + 0.4284 M, SD 7, n 9362 | 81.1 + 0.02531 S + 0.4773 M, SD 5.5, n 4426 |
| `wrist_height` | -61.6 + 0.5021 S + 0.3653 M, SD 21.5, n 8276 | -19.3 + 0.485 S + 0.331 M, SD 20.1, n 4194 |
| `wrist_to_grip` | 19 + 0.02272 S + 0.1709 M, SD 6.3, n 2862 | 29.5 + 0.01843 S + 0.1161 M, SD 5.1, n 2439 |
| `wrist_to_thumbtip` | 44.9 + 0.0449 S - 0.03616 M, SD 7.8, n 2862 | 32.7 + 0.05251 S - 0.03261 M, SD 7.1, n 2439 |

### 9.3 Relations (`RELATIONS`)

Means (not regressions) of differences or ratios the geometry needs, with the model's own constants in them (hip centre = trochanterion - 5 mm, radiale 12 mm below the elbow centre). Against stature and mass their R2 is below 0.1 except: `bkl_minus_femur` (0.32 men, 0.42 women), `bkl_minus_bpl` (0.25, 0.38), `knee_top_over_knee` (0.20 men), `knee_over_popliteal` (0.14, 0.33),
`hip_over_hipbr_ratio` (0.21 men), `deltoid_extent` (0.59, 0.63: the deltoid grows with the mass; the mean is used only when a bideltoid breadth is given without a biacromial breadth), `cervicale_over_suprasternale` (0.11 women), `iliocristale_over_hip` (0.13 women), `omphalion_over_hip` (0.11 women).
Units: mm, except the two ratios.

| name | meaning | men: mean, SD, n | women: mean, SD, n |
|---|---|---|---|
| `hip_over_crotch` | hip joint centre (trochanterion - 5 mm) above the crotch | 66.3, 25, 9337 | 71.5, 20.5, 4418 |
| `seat_below_hip` | sitting height - stature + hip joint height: the hip joint centre above the seat plane that closes the sitting height (4.7) | 73.7, 23.7, 9356 | 74.5, 16.4, 4426 |
| `bkl_minus_femur` | buttock-knee length - (hip centre to lateral femoral epicondyle height) | 207.9, 25.2, 5856 | 204.2, 24.3, 4194 |
| `bkl_minus_bpl` | buttock-knee length - buttock-popliteal length | 112.1, 13.7, 9359 | 106.7, 9.9, 4425 |
| `knee_top_over_knee` | knee height sitting - lateral femoral epicondyle height (top of the knee above the knee axis) | 60.9, 9.2, 5856 | 50.1, 9.8, 4194 |
| `knee_over_popliteal` | lateral femoral epicondyle height - popliteal height | 63.6, 9.9, 5856 | 74.5, 11.6, 4194 |
| `midpatella_over_knee` | mid-patella height - lateral femoral epicondyle height | -1.3, 9.3, 5856 | -9.3, 10.5, 4194 |
| `cervicale_over_suprasternale` | cervicale height - suprasternale height | 77.3, 13.8, 9365 | 72.5, 13.1, 4426 |
| `cervicale_over_acromion` | cervicale height - acromion height | 74.5, 14.7, 9366 | 67.8, 15.1, 4426 |
| `olecranon_drop` | shoulder-elbow length - acromion-radiale length + 12 mm (radiale is 12 mm below the elbow axis) | 40.9, 5.6, 8276 | 35.5, 4.8, 4194 |
| `fhl_minus_hand_rsl` | forearm-hand length - hand length - radiale-stylion length (the people of ANSUR 1988 and II: the raw tables carry the forearm-hand length) | 19.5, 6.3, 5856 | 18.3, 5.9, 4194 |
| `vertex_to_eye` | sitting height - eye height sitting | 119.4, 12.1, 9364 | 111.7, 8.8, 4426 |
| `eye_over_tragion` | (sitting height - eye height sitting) - tragion-to-top-of-head (negative: the tragion is below the eye corner) | -17.4, 8.1, 4082 | -17.5, 7.8, 1986 |
| `iliocristale_over_hip` | iliocristale height - hip joint height | 158.7, 20.3, 9357 | 143, 20.7, 4426 |
| `omphalion_over_hip` | omphalion height - hip joint height | 146.3, 25.5, 8276 | 132.3, 22.2, 4194 |
| `buttock_over_trochanter` | buttock height - trochanterion height | -26.5, 19.7, 8276 | -17.7, 13.6, 4194 |
| `gluteal_over_trochanter` | gluteal furrow height - trochanterion height | -122.3, 15.4, 4194 | -117.3, 13.8, 2208 |
| `hip_over_hipbr_ratio` | standing hip breadth / hip breadth sitting (ratio) | 0.9232, 0.028, 8276 | 0.8901, 0.0285, 4194 |
| `wrist_below_arm` | acromion height - wrist height - (acromion-radiale + radiale-stylion length): the arm hangs slightly bent | -11.5, 12.8, 8276 | -11.9, 10.8, 4194 |
| `ball_ratio` | ball-of-foot length / foot length (ratio) | 0.7367, 0.0161, 6941 | 0.7365, 0.0134, 4426 |
| `deltoid_extent` | (bideltoid - biacromial breadth) / 2 | 44.7, 11.7, 9364 | 38.6, 11.1, 4425 |

## 10. Validation

Reproduce with the test file; the sweeps need `public/api/v1/populations` and `database/anthro.sqlite` (skipped when absent).

* **176 population files x P5/P50/P95** (every country / branch / sex file of `public/api/v1/populations`; the test fits 528 bodies, the full check 1,056 with both reliability filters): no exception, no NaN, stature exact, all bones plausible (shank 0.30 to 0.58, thigh 0.30 to 0.62, upper arm 0.19 to 0.42, forearm 0.17 to 0.36, trunk 0.33 to 0.58, neck 0.07 to 0.18 m). Mean fit time about 2 ms.
  Population percentile profiles combine percentiles of different dimensions and are not coherent bodies: `hip_to_seat` falls outside 40 to 160 mm in 54 of the 1,056 fits (warned), the thigh outside 0.33 to 0.6 m in 8.
* **600 real people per survey** (ANSUR 1988, ANSUR II, ASRAN, USAF; and a random subset of the measure keys): no exception, no NaN, stature exact, sitting height within 2 mm, measured limb lengths within 2 mm, tests pass. In the sample of 2,299 people the mean fit time is 3.4 ms, the mean model mass error is -0.0 kg (SD 2.5 kg, 89 % within 5 %).
  Of the 30,765 alternative-route checks, 5,717 are off by more than max(15 mm, 2 %): surveys contain contradictory measures, and the report shows them rather than hiding them.
* **Unit tests** (the original ones and one regression test per defect of the two independent verifications): contract (77 joints, mirrored offsets, Kinematics positions, flat feet), landmarks and contacts, the contract with `rig.js` (masses is a segment map), the worked example of 2.6 and a 1.75 m man whose proportions are checked against published ranges, women and neutral forms, a complete typical profile, seated closure, over-determined profiles, determinism and purity (no mutation of the input),
  symmetry, proportional versus percentile scaling of populations, overrides win, section maths (`ellipsePerimeter`, `sectionFrom`, `ringPerimeter`, `ringArea`), shape (rings, girths, adiposity), landmark/ring consistency, masses, spine, regression and relation reproduction from the database, implausible and missing inputs, `DIM_DEFS` coverage, report statuses, fit time under 15 ms; and, for the fixes: heading and position independence of the report, the ANSUR II chest, the reach bias per survey, horizontal arms, arm-trunk clearance, thigh width, override limits, mass beyond the BMI range, null options and prototype-named keys, deep-frozen tables, exact mirroring, ascending neck rings from 1.3 m, stale deltas, mass clamp labels, the direct forearm and ankle routes, the seat plane.
  The independent suite `tests/human3d/fit.adversarial.test.mjs` (written by the verifier) passed before the stance of 4.1 and 7.1; of its 23 `todo` known-defect tests 20 passed (the rest are documented limitations: the female segment mass deficit of 0.01 %, the survey-dependent thigh length and the overhead reach, section 11).
  Three of its tests encoded the upright legs and the old centre of mass and failed by design after the stance change; they were rewritten for the new truth and still assert something: "neutral posture ..." now wants the thigh vertical (hip over knee), the shank leaning forward by `stance.shankLeanDeg` (3.5 to 4.9 degrees, the ankle 25 to 45 mm behind the knee) and the centre of mass 20 to 50 mm in front of the ankle and 33 to 40 % of the foot from the heel; "ISO 7250 seated posture ..." wants the seated shank to be the neutral one (the ankle behind the knee by the lean, the knee `shank_length` above the ankle, 4.9 degrees at most); the line of "MODEL.md versus code" that pinned the centre of mass at 2 +- 1 mm in front of the hip midpoint now pins it at 0.3 mm behind it and 36.0 mm in front of the ankle, 37.4 % of the foot from the heel, and the lean of that body at its cap of 4.9 degrees. (The first reconciliation had accepted 2.5 to 8.5 degrees, a band no body came near the ends of; an independent check asked for 1 to 5 and the lean was capped, 7.1.) The fourth failure of the first run after the change, the 8 ms fit-time test, was the load of other test processes (4.3 ms per fit alone).
* **The stance** (7.1): for the 528 bodies and 2,400 real people the centre of mass is 20 to 50 mm in front of the ankle and 34 to 40 % of the foot length from the heel, the shank leans 4.2 to 4.9 degrees, the hip is over the knee, the knee is `knee_height - ankle_height` above the ankle, the ankle axis is 24 % of the foot length from the heel (`sane()` of the test file checks it for every body of every sweep); the report rows of 2,928 bodies are unchanged (to 0.007 mm, statuses identical); tiptoe is within 7 mm of balanced.

## 11. What the model is not (limitations)

* **A kinematic stick-and-skin visualisation, not a biomechanical model.** Rigid links between joint centres; no soft-tissue deformation (the skin is rings with linear skin weights, so deep flexion folds and twists); the sections do not change in a posture (a flexed arm does not bulge); no muscles; no inertia tensors, only segment masses and centres of mass; no joint stiffness. Joint ranges of motion belong to `skeleton.js`.
* **The thigh length carries the trochanterion definition of the survey.** The first route of `femur_length` is trochanterion height - 5 mm - knee height, and it wins whenever a profile has a trochanterion height (nothing is averaged). The surveys do not place that landmark alike: its height as a fraction of stature is 513 per mille for ANSUR II men (519 women), 529 / 530 for ANSUR 1988 men / women, 530 for USAF 1967 men and 522 / 524 for ASRAN 2015 men / women. The mean model thigh of men (mean statures 1757 to 1789 mm) is therefore 404 mm for ANSUR II, 425 mm for ANSUR 1988, 431 mm for ASRAN and 438 mm for USAF (women: 378 mm ANSUR II, 392 mm ANSUR 1988, 403 mm ASRAN; every 4th person of the database), a spread of up to 34 mm, and the hip centre is about 20 to 25 mm lower for an ANSUR II man than for an ANSUR 1988 man of the same size. The other routes disagree with the chosen one in different directions per survey (ANSUR II men: sitting height 419 mm, buttock-knee 411 mm, crotch 420 mm; ANSUR 1988 men: 417, 408 and 406 mm), so no single correction is right. Seated reach and sitting geometry inherit the difference. The bias is not corrected because a profile does not say which survey's definition its trochanterion height follows (the `alt` checks and the warnings show the disagreement when it is large).
* **Joint centres come from regressions and conventions**, not from imaging: the hip from the trochanter and Harrington's pelvis-width equation, the shoulder from the acromion, the spine from a typical curve scaled to the person's trunk and neck lengths. The error for an individual can be of the order of a centimetre or more; the constants marked approx. in section 3 are not validated.
* **The trunk is rigid between the hip and the head in a posture**, so a sitting height different from the standing trunk length is absorbed by `hip_to_seat` (a seat-plane offset), not by bending the spine; slump, shoulder motion and the difference between standing and sitting acromion height (SD 13 to 15 mm) are not modelled.
* **The shoulder girdle does not rise by itself.** A reference posture with the shoulder at 180 degrees flexion puts the dactylion 102 mm (men, SD 40 mm, n = 1,361) / 89 mm (women, SD 36 mm, n = 662) lower than the ANSUR II overhead fingertip reach sitting that the people actually reached (the model's dactylion height above the ischial plane minus the measure; measure not read by `fit.js`): real shoulders elevate and rotate (clavicle and scapula) when the arm goes overhead, and the glenohumeral ball joint of the model does not. Reach checks above the head (shelves, overhead controls) under-reach by about 10 cm unless the posture also raises the clavicle (`clavicle_L/R` `elev`), and the posture engine does not do this by default; the same applies, less, to any posture with the arm above the horizontal.
* **Population profiles are boundary cases.** Each dimension is the percentile of its own distribution, so the P95 body of a country is a person that does not exist (tall legs, short trunk...); the module warns. A P50 body is a reference, not a person. A real subject of a survey (`subjectProfile`) is the faithful case.
* **Estimates are typical, not personal.** A profile with only stature and mass produces the median body of that sex, stature and mass (97 % of the skeleton dimensions estimated; the warning says so). The residual SDs of the regressions (3 to 25 mm for the skeleton dimensions, section 9.2) apply.
* **Pooled military surveys.** The data are US Army, US Air Force and Royal Australian Navy people of 1967 to 2015, 68 % men; other populations (civilians, other ethnicities, women of other builds, children, the elderly) are extrapolated; the model is for adults 1.45 to 2.05 m (a stature below 1.3 m is refused, above 2.5 m too; BMI beyond 16 to 40 is extrapolated for the girths and held at the edge for the bones, 2.1).
* **Sections are approximations of what a tape and calipers measure.** The ANSUR II men's chest is a rounded rectangle (exponent 11 on average) because their tape, breadth and depth cannot all be true for a believable section; the thigh is a circle (nobody measures its breadth); the arm's skin is offset from its bone by up to 50 mm to clear the trunk; the thigh is the uncompressed standing section, about 12 mm thicker than the seated thigh clearance when sitting. The thumbtip reach of a profile without it is unbiased on average for the pooled surveys, not for each (ASRAN women +28 mm).
* **The arm hangs straight.** Upper arm, forearm and hand are collinear in the neutral pose (3 to 14 degrees from the vertical); real arms hang with a slightly bent elbow, so the wrist of a person is about 8 mm higher than the model's (`other:wrist_height`).
* **Symmetry.** Left and right are identical (a mirror image); surveys measure one side. Handedness, scoliosis, leg-length differences are not modelled.
* **The stance is a calibration and the shank carries the whole lean** (7.1, 4.1): the neutral pose is quiet standing with the centre of mass 37.5 % of the foot length from the heel (the measured 40 % would need a shank leaning 5.9 degrees: capped at 4.9); the thigh is vertical, the shank leans 4.9 degrees, the knee is 10 to 15 mm too far forward, the hip and the centre of mass 10 to 25 mm too far back and the
  ankle dorsiflexed 1 to 2 degrees more than a real person in the same stance; a posture with a net shank rotation moves the feet by lean x sin(rotation) relative to an upright shank (23 mm in a seated posture with the knees at 60, 0 for hips 90 and knees 90). The ISO 7250-1 seated lower leg is 4.9 degrees off vertical.
* **Hands and feet are simplified**: straight fingers (no grip pose until the posture engine bends them), thumb splayed at a fixed angle, a fixed arch, toes as one joint. Finger lengths are proportional to the hand length.
* **Face and head are schematic**: an ellipsoid cranium and rings; ears, nose and eyes are features, not a scanned face.
* **Mass distribution is a population average** (de Leva): the segment masses scale with the profile mass, but fat and muscle distribution of the person are not modelled; the mass of a model with measured girths is whatever the volume gives (8.2).
* **No clothing or equipment, no growth, no pregnancy, no prostheses.**
* **The ASIS landmarks are about 3 to 9 mm wider than the surveyed bispinous breadth.** `K.asis` = 0.87 (inter-ASIS distance / bicristal breadth, approx.) was checked against the `BISPINOUS_BRTH` column of the raw ANSUR 1988 table (1,774 men, 2,208 women; the survey has no bicristal breadth). With the bicristal breadth regression the model was 8.6 (men) / 11.1 mm (women) too wide (SD 17 to 21 mm); since the width now follows the hip centres derived from the measured hip breadth sitting when a profile has no bicristal breadth (Harrington inverted), the bias is +2.9 (men) / +8.6 mm (women). The constant itself is kept at 0.87 for profiles that do have a bicristal breadth (a test pins the Harrington formulas), the women's remainder comes from the `hip breadth sitting / 1.46` ratio, and the effect on the hip joint centres is 0.33 times the error, about 3 mm.
* **Constants.** Values marked approx. in section 3 and in the `G`/`OFF` blocks of `fit.js` were not verified against the original papers (this environment could not open them); treat them as defaults and change them in one place.

## 12. Changing the model

1. A constant: edit `K` (or `G`/`OFF`) and its comment, run the test file and the sweep: the report statistics (8.3) move; the tests that pin the model (hand-checkable man, closure, ranges) must still pass.
2. A new profile measure: add the key to `SKELETON_MEASURES` in `anthro.js` (lead), to the `REG_DATA` table (regenerate from the database with an OLS on stature and mass per sex), add a `DEFS` route, a landmark and a `MEASURES` entry for the report, and a test.
3. A new dimension: add a `def(...)` in dependency order (the routes, the band, the estimate), a record in `DIM_DEFS` appears automatically; the test "DIM_DEFS documents every dimension of the table" checks it.
4. Never edit `REG_DATA` / `REL_DATA` by hand: the test recomputes them from the database and fails.
5. Keep `fit.js` pure (no `document`, no `window`): `rig.js` and the posture engine import it in the browser and `node --test` imports it unchanged.
