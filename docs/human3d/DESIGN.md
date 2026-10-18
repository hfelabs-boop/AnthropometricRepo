# Digital human: design contract

A new tab of the website (`#/human`, label **Digital human**): load an anthropometric profile, get a 3D human with a complete
rig, choose and edit a posture, place the human in a sandbox (cabin chair, displays, boxes, tools) and measure distances.

This document is the contract between the modules. The code is the source of truth once it exists: when code and this
document disagree, fix whichever is wrong and say so.

## 0. Ground rules

* **No build step.** Plain ES modules under `site/js/human/`, loaded lazily when the tab opens. three.js r180 is vendored in
  `site/vendor/three/` (MIT, module build + `OrbitControls`, `TransformControls`, `GLTFExporter` later); the page declares an
  import map (`"three"` → `./vendor/three/three.module.min.js`, `"three/addons/"` → `./vendor/three/addons/`).
  Do not add other runtime dependencies. Do not edit files in `site/vendor/`.
* **Pure modules are testable in Node 22** without a browser: `skeleton.js`, `anthro.js` (the non-DOM parts), `fit.js`,
  `pose.js`, `postures.js`, `ik.js`, `measure.js` (maths) and `rig.js` import only `three` and each other, never `document`.
  The DOM is touched only by `index.js`, `viewport.js`, `panels/*.js`. Tests live in `tests/human3d/` (outside `site/`, so they
  are not deployed) and run with
  `node --import ./tests/human3d/register.mjs --test "tests/human3d/*.test.mjs"`; the loader maps `three` / `three/addons/` to the
  vendored files. Browser checks use `tests/human3d/devserver.py` and `tests/human3d/shot.py` (headless Chromium with WebGL).
* **Units:** world units are **metres**; the UI and every exported table use **millimetres** (mass kg, angles degrees). Input
  measures arrive in the units of the data (mm, kg) and are converted once, in `fit.js`.
* **World axes (right handed):** `+Y` up, `+Z` anterior (the figure faces `+Z`), `+X` is the figure's **left**. The floor is
  `y = 0`. Suffixes `_L` / `_R` are the figure's own left / right (left = `+X`).
* **Code style:** match `site/js/*.js`: terse, comments explain why, `h()` from `../util.js` for DOM, no frameworks. Every
  user-visible string is plain English; numbers use the site's `fmtNum` / `fmtInt`.
* **Honest claims.** The model is a *simplified kinematic and anthropometric visualisation* (rigid links, approximate joint
  centres and ranges of motion, no soft-tissue deformation model, no strength or fatigue model). State that in the UI
  ("Model notes") and in the docs. Population profiles are boundary cases (see `anthro_service/README.md`).

## 1. Kinematic conventions

### 1.1 Neutral pose

The rig's rest ("neutral") pose has **every joint angle 0** and every local frame aligned with the world axes. The neutral
pose is a relaxed standing posture, arms hanging at the sides, forearms in mid-position (palms facing the thighs, thumbs
forward), feet flat and parallel pointing `+Z`, the spine in its natural standing curvature (lordosis / kyphosis are baked
into the rest offsets of the vertebrae, so lumbar `flex = 0` means "natural standing curvature", not "straight").
Because local frames are world-aligned at rest, the **rest offset of a joint is just the difference of the neutral world
positions of the joint centres**; bones are the segments between joint centres.

### 1.2 Joint parametrisation (swing-twist, no gimbal lock)

Every joint has 1–3 degrees of freedom (DOF), stored in **degrees**. A DOF has a unit `axis` (in the joint's neutral frame,
which is the world frame), a `role` and a range `[min, max]`:

* role `swing1` / `swing2`: the two **swing** DOFs of the joint. Their combined rotation is the exponential map
  `q_swing = exp(θ1·axis1 + θ2·axis2)`, i.e. a rotation about the axis `θ1·axis1 + θ2·axis2` by the length of that vector.
  The two axes of a joint are perpendicular.
* role `twist`: rotation about the third axis (the bone's long axis, usually `+Y`), applied **first** (innermost):
  `q = q_swing · q_twist`.
* a hinge has one `swing1` DOF (optionally plus a `twist`).

So the direction a bone points depends only on the swing DOFs, never on the twist.

### 1.3 Sides and mirroring

Paired joints are defined for the **left** side; the right side uses the mirrored joint: rest offset `x → −x`, every DOF axis
reflected as a pseudovector (`[ax, ay, az] → [ax, −ay, −az]`), ranges unchanged. The consequence, which the library relies
on: **the same angles on `_L` and `_R` mean the same anatomical movement** (flexion is flexion, abduction is away from the
midline, internal rotation is internal rotation), so a symmetric posture is written once.
Unpaired joints (spine, head, jaw, pelvis) use "`+` = toward the figure's left" for lateral bending and axial rotation and
"`+` = forward" for flexion.

### 1.4 The joints (77 DOF-bearing joints) and their DOF

A joint is named after the bone it moves; its centre is the joint with the proximal neighbour.
`flex` etc. are DOF keys; the sign column says what a **positive** value does (the test-suite checks each by moving the
distal end of the bone by a small positive angle and testing the direction).

| group | joint id(s) | parent | DOF (key: positive means) |
| --- | --- | --- | --- |
| pelvis | `pelvis` | world | root. Position `[x,y,z]` + `heading` (world yaw, + = turn left) · `flex` (+ = pelvis tilts forward) · `lat` (+ = tilt left) · `rot` (+ = twist left, about the pelvis's own Y) |
| lumbar | `L5` `L4` `L3` `L2` `L1` | `pelvis`, `L5`, … | ball: `flex` (+ forward bend) · `lat` (+ left) · `rot` (+ left). `L5` is the L5/S1 joint |
| thoracic | `T12` … `T1` | `L1`, `T12`, … | same, smaller ranges |
| cervical | `C7` … `C1` | `T1`, `C7`, … | same |
| head | `head` | `C1` | ball (occiput–C1): `flex` (+ nod forward) · `lat` · `rot` |
| face | `jaw` | `head` | hinge `open` (+ opens) |
| face | `eye_L` `eye_R` | `head` | gaze: `elev` (+ up) · `azim` (+ toward the figure's left); neutral gaze `+Z` |
| shoulder girdle | `clavicle_L/R` | `T4` | sternoclavicular, 2 DOF: `elev` (+ lateral end up) · `prot` (+ lateral end forward) |
| shoulder | `shoulder_L/R` | `clavicle` | glenohumeral ball: `flex` (+ arm forward) · `abd` (+ away from midline) · `rot` (+ internal rotation). Ranges are those of the whole shoulder complex (scapular motion is not modelled separately) |
| elbow | `elbow_L/R` | `shoulder` | hinge `flex` (+ forearm forward/up) |
| forearm | `forearm_L/R` | `elbow` | hinge at the wrist end, about the forearm axis: `pron` (+ pronation, 0 = mid-position, thumb forward) |
| wrist | `wrist_L/R` | `forearm` | `flex` (+ palmar flexion) · `dev` (+ radial deviation) |
| hand | `thumb_cmc`, `thumb_mcp`, `thumb_ip`, `index_mcp`, `index_pip`, `index_dip`, … `little_dip` each `_L/_R` | `wrist` / previous | MCP and thumb CMC: 2 DOF `flex` (+ curl toward the palm) · `abd` (+ away from the middle finger / from the palm); PIP, DIP, thumb MCP/IP: hinge `flex` |
| hip | `hip_L/R` | `pelvis` | ball: `flex` (+ thigh forward) · `abd` (+ away from midline) · `rot` (+ internal) |
| knee | `knee_L/R` | `hip` | `flex` (+ heel toward buttock) · `rot` (+ internal, small range) |
| ankle | `ankle_L/R` | `knee` | `dorsi` (+ toes up) · `inv` (+ sole turns medially) · `rot` (+ toe-in) |
| foot | `mtp_L/R` | `ankle` | hinge `dorsi` (+ toes bend up, as in a heel raise); negative = curl down |

That is 1 + 5 + 12 + 7 + 1 + 1 + 2 + 2 × (5 + 15) + 2 × 4 = **77** joints. Fixed bones without a joint (sacrum/pelvis,
sternum, rib pairs, scapulae, metacarpals, patellae, calcaneus/metatarsus as the foot) are attached to the nearest joint and
listed in `BONES` for the skeleton view and the mapping table.

Sign hints for the implementer (derived from the axes above, to be verified by tests): a rotation about `+X` by `+θ` turns
`+Y` toward `+Z`; about `+Z` turns `+X` toward `+Y`; about `+Y` turns `+Z` toward `+X`. Hanging bones point `−Y`, so
hip/shoulder/elbow/ankle flexion axes are `[−1,0,0]`, the knee's is `[+1,0,0]`, vertebrae (bones point up) flex about `[+1,0,0]`,
lateral bending (+ left) about `[0,0,−1]`, axial rotation (+ left) about `[0,+1,0]`.

### 1.5 Spine regions

Postures and the editor drive the spine by **region** (`lumbar`, `thoracic`, `cervical`): a region value `[flex, lat, rot]`
(degrees, the *total* over the region) is distributed over the region's vertebrae with fixed weights (sum 1) taken from the
literature; per-vertebra values are added on top (advanced editing). Each vertebra has its own range of motion and the
distribution is re-normalised when a vertebra is at its limit. The `head` joint is separate from `cervical`.

### 1.6 Root and placement

The root (`pelvis`) orientation is `Ry(heading) · swing(flex, lat) · twist(rot)`. A posture does not store the root position:
**placement** (`pose.js`) computes it so that the support contacts rest on the supporting surface and the support-point
centroid is at a requested horizontal anchor. Lying postures use the body's lowest point.

## 2. Modules and data shapes

```
site/js/human/
  index.js        initHuman() → { onShow(), onHide() }; owns UI state, render loop (paused when hidden)
  viewport.js     renderer, camera, lights, grid, orbit controls, picking, gizmo wiring, theme colours, labels overlay
  skeleton.js     JOINTS, BONES, REGIONS, joint maths (jointQuaternion, anglesFromQuaternion), mirror helpers   [pure]
  anthro.js       profile loading & percentile maths                                                          [pure + fetch]
  fit.js          profile → BodyModel: dims, neutral joint centres, landmarks, shape stations, masses, report  [pure]
  rig.js          BodyModel → three.js rig: Bone hierarchy, skinned skin, skeleton & joint visuals, FK, COM  [three]
  body.js         skin mesh generator used by rig.js                                                        [three]
  pose.js         pose data: expand, clamp, mirror, blend, place on supports, contacts                        [pure+three]
  postures.js     the posture library (data) + hand-grip presets                                              [data]
  ik.js           limb IK, look-at, pelvis/feet pinning                                                      [three]
  editor.js       posture editor panel (joint tree, sliders, IK handles, undo/redo, save/import)             [DOM]
  sandbox.js      scene objects, placement, supports, serialisation                                           [three]
  catalog.js      object catalogue (procedural geometry, anchors, grips, supports)                             [three]
  measure.js      measurements (point/landmark/angle), live updates, overlay labels                            [three]
  export.js       GLB, BVH, CSV, JSON, PNG exports
  panels/*.js     profile, posture, scene, measure, skeleton, analysis, export panels                         [DOM]
site/human.css    styles for the tab (prefix `hm-`); injected by index.js
tests/human3d/    node --test suites + Playwright smoke tests
```

### 2.1 Profile (`anthro.js`)

```js
Profile = {
  id: string, label: string,                       // "United States · Army · men · P50"
  sex: "M" | "F" | "both",
  source: { kind: "population"|"individual"|"import"|"manual", ...details },
  measures: { [key]: { value: number, unit: "mm"|"kg"|"…", status: "reported"|"estimated"|"edited"|"individual",
                       reliability?: "high"|"medium"|"low", n?: number, note?: string } },
  notes: string[],                                  // caveats to show (boundary case, mixed surveys, …)
}
```

Keys are the harmonized keys and `other:` keys of `api/v1` (`stature`, `mass`, `sitting_height`, `acromion_height`,
`other:lateral_malleolus_height`, …). Sources: the static files `api/v1/index.json`, `populations/{country}/{role}/{sex}.json`
(and `.latest.json`), the in-browser database (`db.js`, table `subjects`, real people), an imported JSON/CSV, manual entry.

### 2.2 Body model (`fit.js`)

`fitBody(profile, { form }) → BodyModel`, pure and deterministic:

* `dims`: every skeleton dimension actually used (name, metres or kg, `status` = `measured | derived | estimated`, the measure
  keys it came from, note). This is the **mapping table** shown in the UI.
* `joints[id].offset`: neutral rest offset relative to the parent joint centre (m); `positions[id]`: cumulative world position.
* `landmarks[id]`: `{ joint, offset, label, group }`: named body-surface and bony landmarks attached to joints (vertex,
  eye points, tragion, C7, suprasternale, acromion, olecranon, radiale, stylion, dactylion, trochanterion, patella,
  lateral epicondyle, malleolus, heel, ball of foot, toe tip, ischial tuberosities, buttock extremity, …) in the neutral frame.
* `shape`: lofting stations (half-breadth `rx`, half-depth `rz`, centre offsets) for skin generation, from girths where
  measured, estimated from stature/mass otherwise; masses and centres of mass per segment (de Leva 1996).
* `report`: **fit report**: for each standard measure the model can evaluate (stature, sitting height in the ISO 7250
  seated posture, acromion height, shoulder breadth, arm and forearm lengths, hand and foot length, buttock–knee length, …)
  the input value, the value measured on the built model, the delta and a status. This is both a UI panel and the main test.

### 2.3 Rig (`rig.js`)

`buildRig(body, options) → Rig` with at least: `group` (add to the scene), `bones` (Map id → `THREE.Bone`), `setAngles(angles)`,
`getAngles()`, `setRoot(root)`, `landmark(id, target)`, `jointWorld(id, target)`, `centerOfMass(target)`, `skin` (SkinnedMesh),
`setDisplay({ skin, skeleton, joints, labels, axes, wireframe, xray })`, `pick(raycaster)`, `dispose()`.

### 2.4 Posture (`pose.js`, `postures.js`)

```js
Posture = {
  id: "sit-upright-90",                  // kebab-case, unique
  name: "Seated upright (90-90-90)",
  category: "Sitting",                   // one of CATEGORIES
  tags: ["seat", "iso-7250"],
  description: "…",                      // one or two sentences, what it is and what it is for
  source: "ISO 7250-1 …",                // where the angles come from, or "illustrative"
  root: { heading: 0, flex: 0, lat: 0, rot: 0 },          // degrees
  spine: { lumbar: [flex, lat, rot], thoracic: [...], cervical: [...] },   // region totals, degrees
  joints: { head: [flex, lat, rot], "hip_LR": [flex, abd, rot], "knee_L": [flex, rot], … },
  grips: { L: "relaxed", R: "relaxed" }, // hand preset from GRIPS
  support: "feet" | "seat" | "knees" | "hands-knees" | "body" | "hands-feet" | …,   // what carries the weight
  contacts: ["heel_L", …],               // optional explicit support landmarks
  hints: { seat: { … } },                // optional: what the sandbox should do with it
}
```

`joints` keys are a joint id, or an id with the side replaced by `_LR` (both sides, same anatomical values), or `_L` / `_R`
(an explicit side overrides `_LR`). Values are arrays in the joint's DOF order; unspecified joints and trailing values are 0.

### 2.5 Sandbox scene (`sandbox.js`, `catalog.js`)

An object: `{ id, type, name, position[m], yaw/rotation, params (dimensions, adjustable settings), color, locked,
attachedTo? }`; the catalogue gives each type a geometry builder, editable parameters, **anchors** (named points used for
measuring and snapping), optional **grips** (hand targets for IK) and **supports** (horizontal surfaces a body can rest on).
Scenes serialise to JSON (`version`, `objects`, `measurements`, `human`), saved to `localStorage` (guarded) and to a file.

## 3. Product requirements

### 3.1 Profile
Load a profile from (1) a **population** (country, role, sex from `api/v1/index.json`; percentile 5–95 by interpolation of
P5/P50/P95 exactly as the service does, up to 1–99 flagged as extrapolated; reliability filter; combined or latest survey),
(2) an **individual** from the in-browser database (a real ANSUR/ASRAN/USAF person, chosen by survey, sex and either an id or
"closest to a stature and mass"), (3) an **import** of JSON/CSV (including the API's `mannequin` and `populations` files),
(4) **manual** entry with sliders over a base population. Show the mapping table (measure → dimension → bone) with
measured / derived / estimated, the fit report, caveats, and let the user override any dimension.

### 3.2 Model
77-joint rig, skinned mannequin built from the profile's girths, breadths and depths (male, female or neutral form),
skeleton display (bones, joint markers coloured by DOF count, labels, axes), landmarks, centre of mass, ground shadow.

### 3.3 Postures
A library of at least **120 postures** across: Standing, Sitting, Leaning, Holding, Lifting & carrying, Reaching, Kneeling /
crouching / squatting, Lying, Locomotion, Work, Military, Vehicle & cockpit, Reference. Searchable, filterable by category and
tag, with a description and source. Selecting one animates the figure into it and places it on the supporting surface.

### 3.3b Editing
Joint selection (click in the viewport or the tree), per-DOF sliders and numeric fields with range of motion limits
(enforce or warn), mirror left→right, region (lumbar/thoracic/cervical) controls, IK handles for hands, feet, head (look-at),
pelvis; pin feet/hands; undo/redo; reset; save custom postures (local) and export/import posture JSON.

### 3.4 Sandbox
Floor with grid, a **cabin chair** (seat, back recline, headrest, armrests, adjustable seat height/pan angle), office chair,
stool, bench, **displays** (single, multi-screen, HUD, tablet; diagonal and tilt adjustable), **boxes** (any size, mass label),
pallet, table/desk/workbench/console, shelf, wall, step/platform, ladder, **tools** (hammer, wrench, screwdriver, drill, rifle,
steering wheel, joystick/stick grip, lever, pedals, handles). Click or drag to select and move (floor-plane drag, gizmo for
translate/rotate, numeric fields, snapping, nudging, duplicate, delete, lock, attach to hand). Place the human: stand at a
spot, **sit on a chair** (adjust chair to the body), grab a tool or handle with IK, reach checks.

### 3.5 Measuring
Point-to-point on any surface, landmark or anchor (snapping), landmark-to-landmark from lists (eye point → display centre,
hand → control), height above floor, angle between three points, visual angle of a display; live while things move; list with
labels in mm/cm/in, delete, export CSV/JSON; Δx/Δy/Δz and horizontal distance.

### 3.6 Quality bars
Keyboard-operable controls, accessible names, dark/light theme, mobile layout (sidebar sheet), reduced motion respected,
no console errors, render loop paused when the tab is hidden, `dispose()` frees GPU memory, works offline once loaded.
