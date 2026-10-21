# Place the human, and the Analysis panel

For people who change the "Place the human" section of the Scene tab or the Analysis tab of the Digital human page. Contract: `DESIGN.md` 3.4 (sandbox), 3.5, 3.6; the figure and
its placement: `POSE.md`; the solver: `IK.md`; the numbers of the Analysis tab: `METRICS.md`; the editor that every pose change goes through: `EDITOR.md`.

| File | What it is |
| --- | --- |
| `site/js/human/place.js` | The engine (`createPlacer`, no DOM) and the controls (`mountPlace`). Imports three.js, `catalog.js`, `sandbox.js`, `pose.js`, `measure.js`, `ui.js`; loads `editor.js`, `ik.js`, `metrics.js`, `postures.js` on demand. |
| `site/js/human/panels/analysis.js` | The Analysis panel (`id: "analysis"`). `computeAnalysis` at the top is pure and tested in Node. |
| `site/human-analysis.css` | Styles of both, prefixes `hm-pl-` (placing) and `hm-an-` (analysis); tokens of the site only, light and dark. Injected with a `<link>` by `ensureAnalysisStyles()`. |
| `tests/human3d/place.test.mjs` | 22 Node tests: the real rig, sandbox, editor, `ik.js`, `metrics.js` on three bodies, a stub viewport. |
| `tests/human3d/test_place_analysis.py` | Playwright tests on the real tab (`#/human?debug`), screenshots, leaks. |

The model is a simplified kinematic visualisation (`DESIGN.md` 0). Everything below places and reads a rigid figure: it says where the sit bones, hands and eyes are, not whether the
posture is comfortable, healthy or safe.

```
node --import ./tests/human3d/register.mjs --test tests/human3d/place.test.mjs
python -m pytest tests/human3d/test_place_analysis.py -q                     # skipped without Playwright, Chromium or WebGL
REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_place_analysis.py     # fail instead of skip
HM_SHOTS=/some/dir REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_place_analysis.py   # also save screenshots (light and dark, 1280 x 800 and 390 x 800)
```

## Integration (one step the Scene panel has to take)

`sandbox.placeContainer` (id `hm-place-human`) is the element the Scene panel shows under "Place the human"; the panel hides the section while the container is empty. Something has to
fill it. `place.js` does that with `mountPlace(container, ctx)`; the Scene panel (`panels/scene.js`, not owned by this module) has to call it. The change, in three lines:

```js
import { mountPlace } from "../place.js";                          // next to the other imports of panels/scene.js
// after `const placeEl = placeSection.querySelector("#hm-place-human");`
const placeMount = mountPlace(placeEl, ctx);
// in dispose(), next to `placeMO?.disconnect();`
placeMount.dispose();
```

Until then the section stays hidden, and `test_the_scene_panel_mounts_the_controls` is reported as xfail (the other browser tests mount the controls themselves with the same call).
`mountPlace` returns at once; `.ready` settles when `ik.js` and the editor are loaded (the buttons work from then on; a click before that says "The controls are still loading").
It takes a reference on the sandbox and the posture editor (`editor.refs`, like `panels/posture.js`) and releases them in `dispose()`: the editor is disposed with its last user.

## What the controls do ("Place the human", six sections)

Every change of the pose goes through the posture editor (`ctx.posture`, `editorFor(ctx)`), as **one history step**, so Undo in the Posture tab (and Ctrl+Z there) takes it back and
the status bar names the posture "(edited)". Every change of an object goes through the sandbox (its own history: Undo in the Scene tab).

**Stand at a spot.** The middle of the feet (the centroid of the carrier points, the editor's anchor) at x, z in the display unit, and the heading in degrees (0 faces +Z, + turns
left). A seated, kneeling-on-a-chair or free figure stands up first (neutral standing, the chair is let go). "Face the selected object" turns the figure about its support to the
middle of the selected object. "Drag the figure on the floor" switches a drag mode on: a press on the figure (the skin when there is one, else the floor within 0.4 m of the anchor)
moves it over the floor; an object in front of the figure is dragged by the sandbox instead (the press is not taken), the orbit controls are held while dragging, one history step
per drag, and it only works while the figure stands on the floor.

**Sit on the selected seat.** Seats are the surfaces `editor.seatSurfaces()` finds (a seat, bench, stool or box lid 0.15 to 0.9 m high). "Sit on it" does, in one step:
(1) a seated posture: the chosen one, else the current one when it has a seat carrier, else `sit-upright-90`; (2) `editor.sitOn`: heading = the seat's yaw, the contact centroid of the
seat set (sit bones and the thighs' undersides) at the middle of the seat surface, the figure follows the seat from then on (moved, turned, raised: `editor.syncChair`);
(3) for a seat with a reference point (`srp`: cabin seat, office chair, jump seat) the figure moves along the seat's forward axis until the **buttock extremity touches the back-rest
plane** at the reference point (a seat without one, a stool or a bench, keeps the centroid placement). The seat height is not changed: the readout says what the feet do.

The readout (and `placer.seatReport()`): the lowest seat contact against the **tilted** seat surface (`planeHeightAt`: the support's height at its centre plus `tan(pan angle)` along
the seat's forward axis), the lowest foot point against the floor (+ above, - below), whether the sit bones are over the surface, and sentences such as "The feet are 12 mm above the
floor: the seat is too high for this body and posture." The placement puts the seat contacts on the seat at its centre height, so a seat with a pan angle (the cabin seat: 5 degrees,
front up) leaves the sit bones up to about 10 mm off the real surface (the pan is tilted, the pelvis is not): that is reported, not hidden.

* **Adjust seat height to this body** sets the seat parameter (`seatHeight` or `height`) so that the seat surface is at the popliteal height of the body (`pose.seatHeightFor`: the
  height at which the ISO 7250-1 posture, hips 90, knees 90, ankles 0, has its soles on the floor, including the pan offset). For a posture other than the 90-90-90 one the feet gap
  after it is not zero: that is the posture's, and the next button is for it.
* **Adjust seat to the feet** sets the height at which the feet of the *present* pose touch the floor (`placePoseDetailed` on the feet, then the lowest seat contact at that root).
* A seat that cannot go there (a bar stool has a range of 600 to 800 mm, an office chair 380 to 560 mm: a 5th-percentile woman needs less) is set to the end of its range and the
  message says how far short it is ("The seat height of Bar stool can only go up to 600 mm, 207 mm short of what this body needs."); the feet gap is reported as it is.

**Grab with the hands (IK).** Choose an object with grips (`sandbox.gripsWorld`: steering wheel rims, rifle pistol grip and handguard, handles, levers, tools), the hand (Left, Right,
Both) and a grip (Automatic: each hand takes the first free grip made for it, then one that either hand can take; a named grip goes to the chosen hand, with a note when it was made
for the other one). The solver (`ik.js`, one per body, rebuilt on a new profile) gets one `frame` goal per hand (`handFrameFromGrip`: grip centre on the grip point, palm normal and
finger axis along the grip's `normal` and `axis`), pins on the heel and both balls of each foot (weight 100), `reference` = the start pose (the posture is kept), and these free
joints: arm and clavicle of each hand used; the trunk with **Free the trunk**; legs, pelvis position and tilt with **Free the pelvis** (standing only: while sitting the seat holds the
pelvis and the note says so). The result is applied through `editor.setPose` and the fingers are closed with a preset (`wheel` on a steering wheel, `trigger` on a pistol grip,
`flat` for a flat contact, else `power`: `editor.setGrip`), all in one history step ("Hold <object>"). What is reported is measured on the figure after that: the distance of
`grip_centre_<side>` to the grip point and the orientation error of the solver.

When a grip cannot be reached the **closest pose is shown** and the notice says how far ("Steering wheel is out of reach: 1,867 mm short. The left hand: ... (limited by ...)"), with two
buttons: **Move the object within reach** (the object moves by the shortfall vector of the hands, the grab is repeated, up to 4 times; one sandbox step "Move <object> within reach";
refused for a locked or attached object) and **Free the trunk and try again**. **Attach to hand** toggles `sandbox.attach` (landmark `grip_centre_<side>`, the side of the last grab;
the offset is the object's present offset from the hand, so nothing jumps; the object follows the hand's position and keeps its own heading).

**Object of the posture.** When the library posture on the figure has `hints.prop` ({ type, params, role, grips, note }, `POSTURES.md`), "Add the object this posture uses" creates it
(catalogue type, parameters clamped to their ranges) and places it:

| the prop | placed |
| --- | --- |
| has named `grips` (a crate with `side_left` / `side_right`, a hammer, a steering wheel, a rifle) | the yaw and position that fit its grips on the hands of the posture (least squares, `fitYaw`); the height comes from the fit unless it is within 60 mm of the floor (a prop whose height is a parameter has its origin on the floor). Then the hands close on the named grips (arm and clavicle, then with the trunk when that fails) |
| `role: "held"`, no grips (a tray, a cup, a clipboard: a box stands in) | its middle at the mean of the palm centres of the hands that hold something (not the relaxed or open ones), turned to the figure's heading |
| `role: "support"`, no grips (a wall, a desk, a rail) | beside the figure as its note says (`parsePropNote`: "0.37 m behind the heels", "on the figure's left", else in front, 0.3 m from the feet), its front facing the figure |

The supports placed from the note are a starting point: the note says where the contact is for the median man and the placement does not move the figure to touch it.

**Reach check.** The target is the selected object (each hand aims at its nearest grip made for it, else the middle of the object) or the selected measurement's first point that is not
on the figure. For each hand: can the arm and clavicle alone put the grip centre there (`reachHand`)? If not, with the trunk free? The answer is a sentence with the numbers: the
distance from the shoulder as a percentage of the straight arm (`armLength`: shoulder to elbow to wrist to grip centre), and the shortfall in mm. **Show the reach envelope** draws,
around each shoulder, 1,200 random poses of the arm and clavicle within their ranges (`ik.reachEnvelope`: forward kinematics, no solver) as a translucent point cloud and a faint convex
shell (left: the accent colour, right: the green of the theme). The cloud follows the shoulder at once when the figure moves and is recomputed after 280 ms without a pose change; it is
freed when switched off, when the placer is disposed and when the rig is replaced (then it is rebuilt around the new shoulders). Points can lie up to the travel of the clavicle (about 10 cm) beyond the straight arm from the *present* shoulder.

**Line of sight.** "Look at the selected display" turns head, neck and eyes to the screen centre (`editor.lookAtPoint`: `ik.lookAt`, one history step "Look at a point"; the target is
also the editor's look-at handle) and shows the viewing numbers of `measure.js` `viewInfo`: distance, how many degrees below the horizontal the centre is, the visual angle of the
screen width and height, the line of sight against the screen normal. "Add a viewing measurement" adds the `view` item (eye point to display centre, once per display) to the Measure
tab. The numbers are information with the commonly cited guidance next to them (0.5 to 0.75 m, 0 to 30 degrees below), not a verdict.

## Engine API (`createPlacer`, `placeFor(ctx)`)

```js
import { createPlacer, placeFor, acquirePlace, releasePlace, peekPlace, mountPlace } from "./place.js";
const placer = createPlacer({ ctx, sandbox, editor, ik, metrics, scheduler: { later(fn, ms) { ... return cancel; } } });   // tests inject the scheduler
const placer = await acquirePlace(ctx);                                  // the shared one of a viewport (loads ik.js and the editor); releasePlace(ctx) when done
```

Every method returns a plain object `{ ok, message, ... }` (and `headline`, the first sentence, where the controls show only that) and never throws for a user error (no seat, no grips, a NaN).
Lengths in metres, angles in degrees, +Y up, +Z in front of the figure, +X its left.

| Method | Returns |
| --- | --- |
| `selectedObject()`, `seats()`, `gripObjects()`, `displays()`, `spot()` | the Scene tab's selected object; seats of the scene (`{ objectId, id, name, y, polygon, centre, objectName, type }`); objects with grips; objects with a screen centre; `{ x, z, heading, mode, support, floor }` |
| `standAt({ x, z, heading })`, `faceObject(idOrPoint)`, `setFloorDrag(on)` | `{ ok, x, z, heading, message }`; `{ ok, heading }`; the new state |
| `sitOn(objectId, { supportId, posture, face })`, `seatReport()` | `{ ok, report, message }`; `{ sitting, objectId, objectName, supportId, seatHeight, seatGap, feetGap, gaps, onSeat, messages, param: { key, label, value, min, max } }` |
| `adjustSeatToBody(objectId)`, `adjustSeatToFeet(objectId)` | `{ ok, clamped, param, from, to, wanted, report, message }` |
| `grab({ objectId, hand, gripId, assignments, freeTrunk, freePelvis, preset })`, `grabFreeTrunk()`, `moveWithinReach()` | `{ ok, reachable, hands: [{ side, gripId, label, errorMm, rotDeg, reachable, target, reached }], worstMm, messages, message, canFreeTrunk, canMove }`; `moveWithinReach` adds `moved: [dx, dy, dz]` |
| `toggleAttach(objectId, side)` | `{ ok, attached, side, message }` |
| `postureProp()`, `addPostureProp()` | `{ posture: { id, name }, prop }` or null; `{ ok, object, role, placed, grab, message }` |
| `armLength(side)`, `reachTargets()`, `reachCheck(points, { sides })`, `envelope(side, samples)`, `showEnvelope(on)` | metres; `[{ key, label, points: { L, R } }]`; `{ L: { reachable, withTrunk, shortMm, shortTrunkMm, distance, armLength, fraction, message }, R }`; the `ik.reachEnvelope` result; the new state |
| `displayTarget(id)`, `viewOf(id)`, `lookAtObject(id)`, `addViewMeasurement(id)` | `{ id, anchor, point, name }`; `{ target, distance, declination, visualH, visualV, incidence, zone, ... }`; `{ ok, reachable, status, view, message }`; the measure item or null |
| `onChange(fn)`, `dispose()` | unsubscribe; frees every listener, the drag mode and the envelope; a second call is harmless |

Pure helpers (exported, tested without a figure): `headingToward`, `forwardOf`, `planeHeightAt`, `polygonCentre`, `assignGrips`, `gripPreset`, `ikGrip`, `fitYaw`, `propOf`,
`parsePropNote`, `feetSentence`, `seatSentence`, `fmtMm`.

## The Analysis panel

`computeAnalysis({ rig, editor, sandbox, measure, selection, body, profile })` returns plain data (metres, degrees):

```
{ ready, verdict,                                   // the headline sentence
  posture: { id, name, kind, modified, description, source, category, support, supportLabel, mode, seatName },
  metrics, flagOptions, flags, notes,               // metrics.js postureMetrics; ergonomicFlags with { seated, trunkSupport, headSupport }; the flags that are not "ok"
  rows: [{ id, label, hint, single | L, R: { value, severity, flags } }],   // the angle table
  reba,                                             // rebaInputs: angles, bands and modifiers, no score
  balance: { applies, reason, status, limit, margin, inside, com: [x, y, z], hull: [[x, z]], points: [[x, z]] },
  gaps: [{ set, label, gap, state: "touch" | "float" | "press", text, primary }],
  rom: [{ joint, dof, label, value, min, max }],
  reach: { eyeHeight, L: { height, aboveShoulder, aboveHeadBy, above, distance, armLength, fraction }, R, view } }
```

* **Headline** (the only live region of the panel, `role="status" aria-live="polite" aria-atomic`): posture name, the margin of the centre of mass to the support, the feet when seated and
  off the floor, ROM violations, number of ISO notes. It is spoken when its words change, not on every drag step.
* **Angles**: trunk inclination, trunk side bend or twist, neck flexion, head inclination, upper arm elevation, elbow flexion, wrist flexion and deviation, hip angle, knee flexion, ankle
  angle (left and right where paired), each with its ISO 11226 chip (OK / Check / Not recommended: the word carries the meaning, the colour only helps) and, below the table, the note of
  every flag that is not OK, in plain English. Every note says that it is an indication on a simplified model. ISO limits that are **approx.** in `METRICS.md` (head, neck, wrist deviation,
  trunk symmetry) say so in their note. A seat with a back-rest (anchor `srp` or `back_top`) passes `trunkSupport: true`, one with a headrest `headSupport: true`; arm support is unknown
  and never assumed.
* **REBA band inputs**: segment, angle, band, modifiers, as data. No score and no table lookup (`METRICS.md` 4).
* **Balance**: a top view (SVG, `role="img"` with the margin in its name): the contact points that carry the weight (within 15 mm of their surface, 30 mm for shins when kneeling), the convex
  hull of them, the centre of mass projected on the floor (green inside, amber within the 40 mm tolerance of the posture rules, red beyond), the way the figure faces (up the page, its
  left on the left), a 100 mm bar. The text gives the margin in mm and says when the rule does not apply (lying, a held weight, something else carries the weight). The margin is the one
  of `editor.info().balance` (a test compares them). The gaps of the contact sets follow: for the seat against the real (tilted) surface of the chair the figure sits on.
* **Joints outside their range**: one button per violation (joint, DOF, value, range); a click selects the joint (`ctx.select`).
* **Reach and view**: eye height; per hand its height, above or below the shoulder joint, above the head by, and the distance from the shoulder as a percentage of the straight arm; the eye to
  the selected display (or the only display of the scene): distance, angle below the horizontal, visual angle across and high.
* **Posture**: name, "edited", category, support, description and source of the library posture (custom and imported ones have none).
* **Model notes and limits** (closed by default): the limits of `DESIGN.md` 0 in five sentences, then what is true of *this* body: a generic fallback body, the boundary-case warning of a
  population profile (with the percentile; at 5 and 95 or beyond it says the combination is least likely to exist), how many dimensions were estimated or derived, the profile's own notes.
* **Copy summary**: `export.js` `summaryText` with the metrics rows, to the clipboard (a hidden textarea and `execCommand` when the async clipboard is refused); the result is a toast.

Refresh: on `pose`, `rig`, `selection`, `scene`, `measure`, `units`, `posture`, `profile`, `body` and the editor's `change`, `place`, `history`, `rig`, `look`; coalesced to **at most one
refresh per 100 ms** (a timer, then an animation frame); nothing runs while the tab is hidden (a flag marks it dirty, `onShow` refreshes). Sections are rebuilt only when their data changed
(`put`), so a focused button and an open `<details>` stay. A refresh costs 2 to 4 ms (220 postures, Node; `place.test.mjs` asserts under 120 ms for the slowest).

## What the tests show (Node, at the time of writing)

* **Sit** (6 seat types x woman P5, man P50, man P95): the seat contacts are within 1 mm of the surface for flat seats (stool, office chair, bench, jump seat, bar stool) and within 12 mm of the
  tilted surface of the cabin seat (measured 4.5 mm for the median man); the heading is the seat's yaw to 1e-6 degrees; the reported seat gap and feet gap are the ones measured on the
  figure; after "adjust to this body" the feet touch the floor within 1.5 mm (12 mm on the cabin seat) except where the seat's range stops it (bar stool for all three bodies, office chair
  and jump seat for the woman P5), where the report names the shortfall and the feet gap has its sign. Median man on the default cabin seat (400 mm): feet 11 mm below the floor; after the adjustment (411 mm) 0.
* **Grab**: both hands on the steering wheel of the cab (median man, seated): 0.1 mm and 0.02 degrees; the feet and the pelvis do not move; the legs and the spine keep the posture's angles. The
  right hand on the pistol grip of a rifle held standing: within 1 mm. Both hands on the rifle: the left hand cannot hold the handguard (the palm faces up under the handguard, across the body):
  the best of nine placements was 61 mm short, reported with the orientation error. A wheel 2.4 m away: 1,867 mm short, "Move the object within reach" brings it and the hands close within 1 mm;
  a joystick at shoulder height 0.8 m ahead is out of reach for the arm alone (233 mm) and reachable with the trunk.
* **Objects of postures**: for the 180 library postures that have a prop (the library is still growing), 82 name grips, 78 of them close within 1 mm; the others (`sit-typing`, `sit-mouse`,
  `sit-laptop-on-lap`, `ref-rula-neutral`: flat hands on a keyboard, mouse or laptop) stay 14 mm short because the wrist cannot extend enough: reported.
* **Envelope**: samples within the straight arm plus the clavicle's travel (and within the straight arm exactly with the clavicle fixed); the cloud follows the shoulder, is rebuilt, freed.
* **Lifecycle**: a replaced rig rebuilds the solver and the cloud; 20 create / use / dispose cycles leave no listener on the ctx or the viewport and nothing in the scene.

The browser tests (Chromium, SwiftShader) add: the controls in the real Scene tab (a cabin seat and a steering wheel added through the catalogue), Sit on it, the sit bones and feet measured on the
figure, the seat adjusted, the figure following the seat, both hands on the wheel within 1 mm, one history step (undo lets go of the wheel), an unreachable wheel and the two offers, attach,
reach check, the envelope in the 3D scene, the posture's object, stand at a spot with the numeric fields, face, a real-mouse drag of the figure, look at a display, a new profile (the stool is
still sat on), the Analysis panel (values change with the posture, ROM click selects the joint, REBA data without a score, model notes, Copy summary), screenshots in light and dark at 1280 x 800
and 390 x 800, no sideways scroll at 390 px, no console error, and 20 cycles of sit / grab / envelope / tab switches with no leaked frame, listener, canvas, geometry or scene object.

## Decisions, deviations and limits

* **The Scene panel has to mount the controls** (see Integration): this module owns neither `scene.js` nor `sandbox.js`.
* **The editor's history does not record the figure following a chair** (`syncChair`): after a seat height edit made elsewhere, an Undo in the Posture tab puts the figure back at the height it had
  before that edit. The seat buttons of this module commit a history step after they change the seat (`editor.commit`) so that their own undo is right; an edit made with the Scene
  panel's fields is not covered (an editor change, recommended in the report).
* **Pan angle**: a seat with a pan angle leaves the sit bones up to about 10 mm off the real surface; the editor's seat model is a horizontal plane at the height of the surface at its centre.
  Reported in the readout, not corrected.
* **Seat reference**: backed seats (`srp`) put the buttock extremity on the back-rest plane; the others keep the editor's contact-centroid placement, which for a bar stool or bench leaves the
  buttocks within a centimetre or two of the seat edge for the largest bodies. The back-rest's recline is not matched by the posture: choose "Seated, reclined 105" for a cabin seat set at 105.
* **Grab**: orientation matters. A hand cannot take every grip frame within its range of motion (flat hands on a keyboard, a left hand under a rifle handguard); the position error is
  reported in mm and the orientation error in degrees (`rotDeg`), `reachable` needs both (1 mm, 2 degrees). The fingers are a preset; they do not wrap the grip individually. No collision:
  the arm may pass through the seat's armrest or the trunk (`IK.md` 8).
* **Attach** follows the hand's position, not its orientation (`sandbox.attach` with `orient` would replace the object's orientation with the wrist's).
* **Props placed by note** (supports without grips) are approximate; nothing moves the figure to touch them.
* **Reach is a kinematic check**: no strength, no comfort, no collision; the envelope is random sampling (1,200 points per hand: a shell, not a proof of its edge; `maxReach` would give the exact edge in one direction in about 100 ms).
* **The reach percentage** is against the straight arm (the rigid links of this model), not against a measured maximum functional reach.
* **Balance** is a static sanity check on rigid segments (`POSE.md` 5), shown for what the posture rules cover; for a seated figure the hull spans the sit bones, thighs and feet.
* **ISO 11226 and REBA** are indications for static postures on a simplified model; holding time, load and repetition are not known. Limits marked approx. in `METRICS.md` are marked so in the notes.
* The drag mode of the figure and the floor drag handle of the Posture tab (the pelvis ring in "Move figure" mode) are independent: switch one off while using the other.
