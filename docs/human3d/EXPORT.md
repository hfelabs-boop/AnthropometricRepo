# Export: GLB, OBJ, STL, BVH, tables, exchange JSON, posture and scene files, PNG images

For people who take the digital human into CAD, digital-human-modelling and motion tools, and for whoever changes the Export tab. Contract: `DESIGN.md` (units, axes). Code:
`site/js/human/export.js` (pure: three + skeleton.js, runs in Node), `site/js/human/panels/export.js` (the panel, the downloads and the PNG images, which need the viewport's
renderer), `site/human-export.css` (prefix `hm-ex-`). Everything is made in the browser; nothing is sent anywhere (a test greps `export.js` for `fetch`, `XMLHttpRequest`, `document`, ...), except by *Send to CAD* (`cadlink.js`), which posts the exchange JSON to the server the user names.

The model is a simplified kinematic and anthropometric visualisation (rigid links, approximate joint centres and ranges of motion, no soft tissue). Every file says so where its format has room
for it, and says which units, axes, profile, posture and version it holds.

```
node --import ./tests/human3d/register.mjs --test tests/human3d/export.test.mjs     # the formats, read back by parsers written in the test (about 12 s)
python -m pytest tests/human3d/test_export.py -q                                  # the real page: every download, the PNGs, mobile, dark, Blender (about 80 s)
GLTF_LOADER=<three>/examples/jsm/loaders/GLTFLoader.js GLTF_VALIDATOR=<node_modules>/gltf-validator node --import ... --test tests/human3d/export.test.mjs   # optional extra readers
REQUIRE_BROWSER=1 / REQUIRE_BLENDER=1                                              # fail instead of skip when Playwright / Chromium / bpy is missing
tests/human3d/pages/export-demo.html                                               # the panel with a real figure and viewport, no shell: ?sex=F&p=95&posture=<id>&quality=low&dark=1
```

## 1. Conventions

| | |
| --- | --- |
| model | metres, kilograms, degrees; **+Y up, +Z in front of the figure, +X the figure's left**, right-handed, floor at y = 0 (DESIGN.md section 0) |
| glTF | the same axes and metres (glTF is Y up, front +Z): nothing to convert |
| OBJ, STL | millimetres (default) or metres; three axis systems (`AXES`): `y-up` (the model, default), `z-up` (up +Z, the figure looks along -Y, its left is +X: Blender's own, the usual in CAD), `x-front` (X forward, Y left, Z up: SAE J670 / vehicle). All three are proper rotations: the winding of the triangles is kept |
| BVH | Y up, +Z in front, +X left; centimetres (default), millimetres or metres for OFFSET and the root position; degrees |
| tables, exchange JSON | millimetres (mass kg, angles degrees), axes of the model |
| file names | `<profile-slug>_<posture-id>_<what>[_<suffix>].<ext>`, all `a-z0-9-_`, under 125 characters (the suffix, up to 12 characters, is the unit and axes: `..._mesh_mm-x-front.obj`): `united-states-army-men-p50_sit-upright-90_figure.glb`. A posture that is not in the library (id `null`) uses the slug of its name (`neutral-standing`), an empty profile becomes `figure`. **A figure that has left the posture the shell names is `custom-pose`** (section 2, "Labels") |

The meshes follow the quality of the 3D view (`rig.quality`): about 24,000 vertices at `high`, 9,600 at `low`; the shell switches to `low` on software rendering. The panel says so and offers
"Use high quality" (`ctx.setQuality`). The skeleton, the angles and every table do not depend on it.

## 2. The formats

### Labels: which profile and which posture a file claims

A file states its profile and posture (name, headers, metadata); they must describe the content next to them. Two things in the shell make that untrue unless the export checks:

* **The profile.** `ctx.getProfile()` is the new profile as soon as the user picks it, `ctx.getRig()` is the old figure until the rebuild (seconds) has swapped it in. The export takes the profile **of the rig**: `profileOf(rig, candidates)` returns the first candidate whose `id` is the id the body was fitted from (`rig.body.profileId`), else a description made from the body (label, sex, no survey measures). The panel keeps the last 8 profiles the shell held, so a file made while the next figure builds says the old profile and holds the old figure. A generic fallback body (`body.synthetic`) is described by itself. After the file the status line says when the profile was changed meanwhile.
* **The posture.** The shell's `state.posture` is changed only by whoever loads a posture: sliders and IK drags do not touch it (the Posture tab is still a stub). `effectivePosture(posture, rig)` compares the name with the figure, in the same synchronous step that reads the pose: a library id against that posture's pose, the default `Neutral standing` against all angles 0, a `posture.pose` (`{ root, angles }`, what the Export panel remembers for a posture file it loaded) against the figure (0.01 degree; the heading is not part of a posture name). A figure that has left it is `{ id: null, name: "Custom pose", edited: true, basedOn: { id, name } }`: the file name has `custom-pose`, headers say `Custom pose (edited from Neutral standing)`, the GLB `asset.extras.posture`, the exchange `posture` and the posture file `shell` carry `edited_from: { id, name }`, `posture.library` is false. A custom id the export cannot check (a posture of a file loaded by another tool) is trusted as it is. Every builder resolves the posture itself (`need()`); `buildGLB` does it again after its last `tick` and returns the posture it used (`result.posture`), as do OBJ, STL and BVH, so the panel names the file after what the content says.

### GLB (`buildGLB(input, options)`)

Binary glTF 2.0 made with `GLTFExporter` (vendored, unmodified) and then tidied: one skin for the body and the eyes, no unused accessors, `asset.generator` and `asset.extras` (units, axes, profile,
posture, pose mode, version, optional date).

* **Skeleton**: 77 nodes named by the joint ids of `skeleton.js` (`pelvis`, `L5` ... `eye_L`, `thumb_cmc_R`), the hierarchy of the rig, `pelvis` the root and the `skeleton` of the skin. Rotations are quaternions, no scale.
* **Skin**: `skin` (24,056 vertices at high quality: position, normal, 4 joint indices, 4 weights summing to 1, triangles) and `eyes` (vertex colours), standard PBR material `skin`. Both are skinned meshes at the root of the scene (glTF validators warn otherwise).
* `figure`: `skin` (default), `skeleton` (the joints and thin octahedral bone sticks skinned to them: a visible skeleton in any viewer, and Blender builds an Armature), `none` (scene objects only).
* `pose`: `baked` (default): the joint nodes are in the current pose **and that pose is the bind pose** (inverse bind matrices of the pose, vertices posed), so viewers that ignore skins show the figure in the posture, and small changes to the nodes work from it. It is **not** the neutral body with a pose on top: skinning from a posed bind is not the inverse of the original skinning, so putting every joint node back to its neutral rotation gives a mesh up to 54 mm (deep squat), 40 mm (lying on the side) or 34 mm (prone) away from the neutral body of the viewer (2 mm for supine). For retargeting, animation or posing from neutral use `clip`; `clip`: neutral standing bind pose
  (nodes at rest, the rig's own inverse bind matrices) plus one animation `pose-<posture id>` with a single keyframe at t = 0 (77 rotations and the pelvis position). Both display the same figure.
* `scene`: the visible sandbox objects as one node each (name = object name, made unique and never a joint id) with the **current world transform** and `extras.digitalHuman = { id, type, name, params, color, locked, units: "m" }`; their meshes are named `<name> (mesh)`.
  Geometry and materials are those of the catalogue minus the unused texture coordinates. Hidden objects are not exported, an object with a broken transform is skipped (`stats.skippedObjects`).
* `measurements`: the rows of `measure.exportRows()` in `scenes[0].extras.digitalHuman.measurements` (millimetres and degrees).
* A figure that the shell **replaced** (profile or quality changed: the old rig is disposed and has no skin any more) while the page breathed gives "The figure was replaced while the file was being made ... Click the button again", not "no skin". OBJ, STL, BVH and the tables read the rig before their first breath and are not affected.
* One pose per file: every read of the rig (bones, skin vertices, clip tracks, scene objects) happens in one synchronous block, after all the `tick`s, because the 3D view and the IK drag stay live while the page breathes. The file holds the pose the figure had after the last tick before that block; a drag that goes on while the file is being encoded does not reach it.
* Size: 1.5 MB for the figure at high quality; 200 scene objects of the catalogue (a mix of eight types) add 10 to 11 MB and take 0.5 to 1 s (measured 11 to 12.4 MB in total, 0.5 to 1.0 s, Node and headless Chromium); the tests allow 16 MB. Draco, textures and morph targets are not written.

Importing. **Blender**: File > Import > glTF 2.0; it builds an Armature with the 77 bones, a mesh `skin` with an Armature modifier and 77 vertex groups, and converts to Z up (+Y front is -Y). Blender also adds a custom-shape helper object called `Icosphere`
that its importer always creates for bones. For `clip` the pose is in the action `pose-...` at frame 0. **three.js / Babylon.js / Windows 3D Viewer** open it directly. **Unity** needs a glTF package (glTFast or UnityGLTF), **Unreal** its glTF importer: both not tested here.

### OBJ and STL (`buildOBJ`, `buildSTL`)

The skin in the current pose as static triangles (CPU skinning of the posed rig, normals skinned too; checked against three.js's own `applyBoneTransform` to 1e-7 m), optionally with the scene objects. `OBJExporter` and `STLExporter` of three.js (vendored, unmodified) write the files.

* options: `unit` `mm` (default) | `m`, `axes` (above), `skin`, `scene`.
* OBJ: `o skin`, `o eyes` and one object per scene mesh, vertices, normals, faces; no MTL file. A header of `#` lines gives generator, profile, posture, unit and axes (ASCII only). About 4.8 MB at high quality. **200 scene objects add about 50 to 58 MB** (53 to 63 MB in all, 1.3 to 4 s; the exporter writes every number with full precision), so the default "Scene objects" gives a big file for a big scene: the panel's size estimate says "Large file" from 25 MB. The text is written one skin mesh / one scene object at a time (`objChunks`, byte for byte what one `OBJExporter` call writes) and the page breathes between the pieces, so no single step blocks it for long: with 200 objects the longest task in headless SwiftShader went from 2.1 s to 0.55 s (the posed skin, a single mesh, is the biggest piece).
* STL: binary, no unit field: the **80-byte header** carries `Digital human STL | units mm | up +Y front +Z | <posture> | <profile>` (it never starts with `solid`, which would make readers take the file for ASCII). 2.5 MB (8.8 MB with 200 scene objects).

Importing. **Blender 4/5**: File > Import > Wavefront (.obj) or STL: set Scale 0.001 for millimetres. Blender's OBJ importer defaults (Forward -Z, Up Y) take the `y-up` file upright, exactly where the glTF import puts it; its STL importer defaults to Z up, so use the `z-up` option
for STL (or set Up = Y, Forward = -Z); an OBJ in `z-up` needs Forward = Y, Up = Z. Other CAD, DCC and mesh tools (AutoCAD, CATIA, SolidWorks, Rhino, MeshLab ...) read OBJ and STL as **mesh** geometry, not as solids or manikins: choose the unit and the up axis in their import dialog, or pick the matching option here.
Not tested here (only Blender and the parsers below were available).

### BVH (`buildBVH(input, options)`)

```
HIERARCHY
ROOT pelvis
{
	OFFSET 0 0 0
	CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
	JOINT L5
	{
		OFFSET 0 12.62 -2.5
		CHANNELS 3 Zrotation Xrotation Yrotation
		...                      (77 joints, depth first, parents first; an End Site on every leaf)
MOTION
Frames: 2
Frame Time: 0.0333333
<234 numbers>             (frame 1: the posture; frame 2, optional: the neutral standing pose)
```

* OFFSET is the **rest offset** of the joint from its parent (`rig.restOffsets`); the root OFFSET is 0 and its position channels hold the world position of the pelvis joint centre (the placement of the figure). End Sites sit at the landmark the bone ends at (fingertip, toe tip, chin, pupil).
* Rotations: **R = Rz(Z) * Rx(X) * Ry(Y)** of the joint's LOCAL rotation relative to its parent, degrees, written from the local quaternion with `Euler.setFromQuaternion(q, "ZXY")`. In this rig every local frame is aligned with the world at rest, so the BVH rotation of a joint is exactly its rotation in the parent's frame and OFFSET is
  the rest offset: the conversion is **exact**, including at the gimbal pose (hips at 90 degrees are an Euler X of exactly 90). The test walks the file with its own forward kinematics and compares all 77 joint centres to `Kinematics` (below 0.05 mm, in cm, mm and m files), the 77 world orientations (1e-5 rad) and the End Sites against the landmarks.
* Numbers: 5 decimals for cm, 4 for mm, 6 for m (about 1 micrometre); frame time 1/30 s; LF line ends.
* A comment header (`#` lines: profile, posture, units, axes) is **off by default**: Blender's reader insists that the first word is `HIERARCHY` and other tools are as strict. Switch "Comment lines at the top" on when the tool is happy with it; otherwise the file name carries profile, posture and unit, and this page the rest.

Importing. **Blender**: File > Import > Motion Capture (.bvh), Scale 0.01 for the centimetre file (1.0 for metres, 0.001 for millimetres), everything else at its default (Forward -Z, Up Y, rotation mode Native): the figure stands where the glTF import puts it, the pose is frame 1 (frame 2 the neutral pose);
Blender drops the End Sites. MotionBuilder, Maya, 3ds Max, Siemens Jack, OpenSim (it has no BVH reader of its own; converters exist): not tested. A tool that expects Z up needs the axes rotated on import.

### Tables (`anglesCSV`, `anglesJSON`, `dimsCSV`, `reportCSV`, `metricsCSV`, `pointsCSV`)

Millimetres, degrees, kilograms; comma separated, UTF-8, `\n`; a cell that starts with `= + - @` gets a quote in front (spreadsheets would run it). Optional `#` comment lines (profile, posture, units, axes) at the top: off by default, because spreadsheets and CAD macros show them as rows.

| table | columns | one row per |
| --- | --- | --- |
| points (the Skeleton tab's own `pointsCSV` when it is there, else `pointsCSV` of export.js: the same numbers) | `type, id, label, group, kind, attached_to, x_mm, y_mm, z_mm` | 77 joint centres + the landmarks (197 for the standard body), posed, world |
| angles | `joint_id, joint_label, group, side, dof_key, dof_label, role, value_deg, min_deg, max_deg, at_limit, axis_x, axis_y, axis_z, positive_means` | degree of freedom: `root` (heading, flex, lat, rot) then the joints in skeleton order; `at_limit` is `min` / `max` within 0.01 degree; the pelvis' own angles only when not 0 |
| dimensions | `id, label, value, unit, status, measure_keys, formula` | row of the mapping table (`body.dims`); lengths in mm, mass kg, ratios unitless; status measured / derived / estimated |
| fit report | `id, label, kind, posture, unit, input, model, delta, tolerance, status, note` | `body.report`: the profile value against the value measured on the built model |
| posture metrics (`metrics.js`; skipped gracefully when the file is missing) | `group, key, label, unit, value` | metric of `postureMetrics` (angles in deg, lengths in mm) |

### Exchange JSON, `human-exchange` version 1 (`buildExchange`, `validateExchange`)

One self-describing document for other programs; 205 kB. `validateExchange(doc | text)` returns `{ ok, errors, warnings }` and never throws; the panel runs it on every file it writes and refuses to save one that fails its own check.

| path | content |
| --- | --- |
| `format`, `version`, `generator`, `created?` | `"human-exchange"`, `1`, text, ISO date (only when the caller passes `created`: otherwise the output is byte for byte reproducible) |
| `units`, `units_detail` | `"mm"`, `{ length: "mm", mass: "kg", angle: "deg" }` |
| `axes` | `{ up: "+Y", front: "+Z", left: "+X", handedness: "right", origin, note }` (the validator requires exactly these four values) |
| `profile` | `{ id, label, sex, source (as in anthro.js), notes[], measures: { key: { value, unit, status, reliability?, n?, note? } } }`: the survey measures in the units of the data |
| `body.form`, `stature_mm`, `mass_kg` | male / female / neutral, millimetres, kilograms |
| `body.dims[]` | `{ id, label, value, unit ("mm" | "kg" | ""), status, measure_keys[] }` |
| `body.joints[]` (77, skeleton order, parents first) | `{ id, label, group, side, parent, rest_offset_mm[3] (from the parent; the pelvis: its rest position), rest_position_mm[3], position_mm[3] (posed, world), orientation_xyzw[4] (posed, world, unit, w >= 0), dof[] }` with `dof[] = { key, label, role, axis[3] (in the rest frame), value_deg, min_deg, max_deg, at_limit: null | "min" | "max", positive_means }` |
| `body.landmarks[]` | `{ id, label, group, kind, joint, offset_mm[3] (in the joint's rest frame), position_mm[3] (posed, world) }` |
| `body.segments[]`, `body.centre_of_mass` | `{ id, label, joint, mass_kg, com_offset_mm, com_position_mm }` (de Leva, 16 segments); `{ position_mm, mass_kg }` |
| `posture` | `{ id, name, edited_from?, library, root: { heading_deg, flex_deg, lat_deg, rot_deg }, angles: { jointId: { dofKey: deg } } }` (joints that are not 0); `id` is the library id or null, `library` is true only for an id that is in the library and whose pose the figure is in; a figure that has left the posture the shell names is `"Custom pose"` with `edited_from` (see Labels); `angles` are always the truth |
| `placement.root` | `{ x_mm, y_mm, z_mm }` world position of the pelvis joint centre |
| `scene.objects[]` | `{ id, type, name, params, color, locked, visible, position_mm[3], yaw_deg, orientation_xyzw[4], attachedTo }` (the catalogue type and its parameters in the units of the catalogue: metres, degrees). `position_mm` and `orientation_xyzw` (unit quaternion, w >= 0, optional for older files) are the **world** transform, what the GLB and OBJ show. `yaw_deg` is the object's own heading as the Scene tab keeps it: for an object attached with `orient` it is relative to the joint's frame, and the pitch and roll of the joint are only in `orientation_xyzw` |
| `measurements[]` | the rows of `measure.exportRows()` (mm, deg) |

What `validateExchange` checks: format, version (a newer one is refused), units, axes, the profile and its measures, 77 joints in skeleton order with the right parents, finite coordinates below 100 m, unit quaternions (1e-5), the degrees of freedom of every joint (keys, finite values,
`min <= max`; a value outside its range is a warning), **rigid links** (the distance of a joint to its parent equals its rest offset within 0.05 mm: a moved joint is an error), landmarks that name a joint and are unique, a plausible stature (500 to 3000 mm, a warning outside 1300 to 2500),
segment masses that add up to the body mass within 5 %, posture angles that name real joints and degrees of freedom, placement, scene objects and measurements.

### Send to CAD (`cadlink.js`, the Export panel's *Send to CAD* section)

Posts the exchange JSON above to an `anthro_service` REST server (`POST /v1/profiles`): usually the one on the CAD computer itself (`python -m anthro_service serve`,
`http://127.0.0.1:8000`). CATIA and other tools then read the body back: `/v1/profiles/latest/values` (the measures, with the keys and units of `/v1/mannequin`),
`/angles` (every joint degree of freedom), `/points` (joint centres and landmarks), as JSON, CSV or XML; the VBA module `anthro_service/examples/AnthroApi.bas` has
`AnthroProfile`, `AnthroProfileAngles` and `AnthroProfileToParameters`. The panel has the server address (remembered in this browser), an API key field (never saved),
*Test connection* (`/v1/health`, then `/v1/profiles?limit=1`, which checks the key and the access rule) and *Send profile and posture*; the answer lists the URLs to
copy into a macro. Failures say what to do: start the server, enter the key, use https for a server on another computer, or download the JSON and run
`python -m anthro_service push FILE.json` (Safari blocks requests from the https site to `http://127.0.0.1`). This is the only part of the panel that sends anything;
it sends only to the address you type. Server side: `anthro_service/README.md`, "Pushed profiles". Tests: `tests/human3d/cadlink.test.mjs` (fake fetch) and
`tests/human3d/test_send_to_cad.py` (the panel in Chromium against a live server).

### Posture file (`buildPostureFile`, `parsePostureFile`, `applyPostureFile`)

`{ app: "digital-human-posture", version: 1, posture, library_posture, shell, pose: { root: { heading, flex, lat, rot }, angles: { jointId: [degrees in DOF order] } }, placement, profile, ... }`.
`posture` is the library entry when the figure is exactly in a library posture (`library_posture: true`), else a **custom** Posture object (DESIGN.md 2.4: id `custom-...`, made once: a loaded `custom-foo` is saved again as `custom-foo`, never `custom-custom-foo`; category `Reference`, `joints` listing every non-zero joint by its own id so that it reproduces the pose exactly, the right eye in the posture convention).
`pose` is exact and is what the importer reads first. Importing accepts the wrapper, a bare Posture object or a bare pose; it never throws and answers with plain English: the file is not JSON, is a scene file, has a newer version, names an unknown joint, has a joint with too many or non-numeric values, an unknown root
field, an angle beyond 3600 degrees (named as such), is larger than 2 MB. Angles beyond the range of motion are limited and listed as warnings, a root position is ignored with a warning (a posture has no position). Applying places the figure on its support (`placePose`: floor, the seat height of the posture, or the body for lying postures) unless "Place the figure..." is off.

### Scene file

`sandbox.toSceneFile()` (objects, snapping, measurements; metres) as it is, and `sandbox.fromJSON(text, { merge })` to load it (replace, or add to the scene; the validation messages of `sandbox.js` are shown). Nothing is duplicated here. The panel creates the sandbox (and the measurement section) when a scene file is loaded before the Scene tab was opened.

### PNG images (`panels/export.js`)

The viewport's own renderer, resized for the moment of the capture (`setPixelRatio(1)`, `setSize`), the floor items and the gizmo hidden as asked, **everything put back afterwards and the view drawn again in the same task**. Labels and selection outlines are not special: what the 3D view draws is in the image, the HTML labels are not (the camera button of the toolbar keeps them).

* size: 1x = the 3D view in the page (CSS pixels), 2x = twice that, never above 4096 on a side or what the GPU allows (the message says when it was reduced).
* background `scene` (the theme's own) or **transparent**: the view is rendered twice, over black and over white, and `matteFromPair` recovers colour and alpha (`a = 1 - (white - black)`, `F = black / a`): exact for anti-aliased edges, soft shadows and glass, with no fringes; the renderer has no alpha channel (`alpha: false`) and is not touched.
* grid and axes on/off, floor shadow on/off (a transparent PNG with the shadow has a soft, semi-transparent shadow to lay over a page).
* "4 views": front, left side, back and top in one strip (480 x 640 per cell at 1x), each camera framing the figure (and the scene objects when they do not make the box huge) with `frameDistance`; captions on the opaque strip only.

### Summary (`summaryText`)

About 20 lines of plain text for a report: profile, key dimensions (the survey value, or the model's when the survey has none), posture, root, the largest joint angles, a few posture metrics, scene objects, measurements, the units and axes and the model note.

## 3. The panel

Sections: **3D model** (GLB, OBJ and STL cards with options, size estimates and the quality note), **BVH**, **Tables**, **Exchange JSON**, **Posture and scene files**, **Images**, **Summary**. Each card has a one-line description and who uses it. Options are remembered in this browser (`localStorage`, guarded).
While a file is built the page breathes between the steps (`tick`: an animation frame, backed by a timer for hidden tabs), the panel is `aria-busy`, a status line says what is going on, the buttons stay focusable (`aria-disabled`; a click is ignored, but the status line and a toast say why; focus is not lost) and the result or the error is announced
(`role=status` / `role=alert`): "Building the GLB did not finish. <reason>." A failing download leaves the panel usable. Buttons and fields are real controls with names; narrow screens (360 px) have no horizontal scroll, every control is at least 24 px high (checkboxes are 24 x 24 px), coarse pointers get larger ones, light and dark themes use the site's tokens only.

**Capture.** Each export takes the rig, the profile that belongs to that rig, the posture label checked against the pose, the sandbox and the measurements together in one synchronous step (`capture()`), right before the builder reads the rig, and names the file from that same snapshot. If the shell replaces the figure afterwards (profile or quality changed), the file is still about the figure captured; if the old rig was disposed before it could be read, the message says so ("The figure was replaced while the file was being made ... Click the button again"). The state line at the top shows the profile and posture the files will carry (`Custom pose (edited from ...)` after a slider or IK edit) and says when the model is being rebuilt for another profile.

`ctx` use: `getRig()`, `getProfile()`, `state.posture`, `viewport`, `on()`, `toast()`, `setPosture()` (after loading a posture), `setQuality()`. **The sandbox and the measurements are not on `ctx`** (`ctx.sandbox` exists only on the ctx of a panel that called `sandboxFor`): the panel uses `peekSandbox(ctx)` and
`peekMeasure(ctx)` (so it exports what the user can see: no Scene tab visit, no scene) and `acquireSandbox` / `acquireMeasure` only when a scene file is loaded.

## 4. What was verified, and with what

| | verified with |
| --- | --- |
| GLB | a parser written in the test (header, chunks, accessor and buffer-view bounds, min/max, node names and hierarchy, joints, weights sum to 1, indices); the file **skinned again from its own nodes and accessors** (and, for `clip`, with its animation) against the vertices of the live rig drawn by three.js's own skinning: 2e-6 m, 20 figures; the Khronos **glTF-Validator** 2.0.0-dev.3.10 (no error, warning, info or hint); three.js r180 `GLTFLoader` (vertices 1e-7 m); **Blender 5.0.1** (`bpy`, `import_scene.gltf`): 77 bones, 77 vertex groups, vertices and bone heads within 5e-7 m, `clip` at frame 0; trimesh 5.1.1 and pygltflib |
| OBJ, STL | parsers in the test (counts, indices, bounds in mm and m, stature, header, the three axis systems against each other, winding, binary size, normals against the winding); Blender 5.0.1 OBJ and STL importers and trimesh (vertices within 2e-7 m) |
| BVH | a parser and forward kinematics written in the test: all 77 joint centres within 0.05 mm of `Kinematics`, orientations, End Sites, neutral frame, gimbal poses, all joints at their limits; **Blender 5.0.1 `import_anim.bvh`**: 77 bones, rotation mode ZXY, bone heads within 7e-6 m for frame 1 and frame 2 |
| tables, JSON | parsers, column and unit checks, the validator on 20 figures and 23 kinds of broken document, determinism |
| panel | headless Chromium: every button downloads a real file whose content is checked; PNG: decoded with Pillow (not blank, transparent where it should be, soft edges, 2x, the viewport put back); keyboard; errors; 390 x 800 and 360 x 700; dark theme; no console errors |

**Not tested** (not available here): Unity, Unreal, MotionBuilder, Maya, 3ds Max, Siemens Jack, RAMSIS, CATIA (Human Builder or the mesh workbenches), AutoCAD, SolidWorks, Rhino, OpenSim, MeshLab, Windows 3D Viewer. What this page says about them is what the formats allow, not a report of an import.

## 5. Decisions and deviations from the brief

* **BVH has no comment header by default** (the brief: every export states units, axes, profile, posture and version "in its header or metadata"): a BVH has no metadata field, Blender refuses a file whose first word is not `HIERARCHY`, so the statement is in the file name, in the panel and in the optional `#` header.
  The same holds for CSV (column names carry the units; `#` lines optional); JSON, GLB, OBJ and STL carry it by default.
* **OBJ and STL use the three.js addons** as asked; the exporters print every number with full precision, so the OBJ is 4.8 MB (a writer with fixed decimals would need well under half of that). The header is prepended / patched by us.
* **Skeleton-only GLB has bone sticks**: nodes without a skinned mesh are empties in Blender and invisible in viewers.
* **The posture file stores `pose` and `posture`**, and the importer trusts `pose`: a Posture object cannot always say what the figure did after editing, and regenerating spine totals from vertebra angles would be lossy.
* **`export.js` loads `pose.js` and `postures.js` at the top (top-level `await`, a missing module just means "cannot check")**: the posture label is decided synchronously, in the same block that reads the pose, which a lazy `import()` inside the sync builders (`buildBVH`, `buildExchange`, `summaryText`) could not do.
* **Labels follow the figure, not the shell** (section 2, Labels): the panel does not trust `state.posture` or `getProfile()` for what a file says. The Posture tab, when it exists, should call `ctx.setPosture` for every posture it applies; the export then keeps the library name as long as the figure is in that posture.
* **No Draco, no textures** (out of scope, none needed). Joint ids are the node names, not "mixamo" or other rig names: retargeting tools need a mapping.
* `GLTFExporter` finishes through `FileReader`, which Node lacks: `export.js` installs a four-line stand-in **only when there is no FileReader** (tests, scripts).

## 6. Limits

* The mesh follows the quality of the viewport; the skin is one surface (no separate clothing, no teeth, no hand detail beyond the model's), without UV coordinates or textures.
* The PNG has no labels, no selection outline control and no Retina scaling beyond "2x"; a hidden 3D view cannot be captured (the message says so); very large captures are reduced to 4096 on a side.
* BVH: the pelvis is the root, so the hip-centre world position is in the position channels, which some tools take for a "hips" bone offset. The neutral frame is frame 2, not frame 0 (the brief's order); T-pose-first tools need the two frames swapped.
* Posture files from a body with other proportions are placed on their support, not at the old position; clamping to the ranges of motion may change a posture made for another body.
* The exchange JSON is not a schema in the JSON-Schema sense; `validateExchange` is the authority. Version 2 will change `version` and the validator will refuse older and newer files it cannot read.
* Several downloads at once are not supported: one export runs at a time. A click on another export button meanwhile does nothing but says so (status line and toast).
* **The PNG images block the page** while they are drawn: the renderer of the 3D view has to be resized and put back in one task. On a real GPU it should be much shorter (not measured here). In headless Chromium on software rendering (SwiftShader) with the **default, empty scene** the longest task measured was 0.7 to 1.6 s for a single PNG (1.5 s at 2x transparent), and for the 4 views 1.6 s (1x opaque), 3.0 s (1x transparent), 2.0 s (2x opaque) and 3.9 s (2x transparent: eight renders); a big scene adds to it (2.7 s measured with 200 objects, 4 views, 1x opaque). The busy message is shown first and the page cannot be scrolled or clicked until the image is saved. The formats above breathe between their steps instead.

## 7. `export.js` reference

`exportFileName`, `slug`, `postureSlug`, `ascii`, `AXES`, `axesMatrix`, `UNIT_SCALE`; `skinnedMeshes`, `bakeSkin(rig)` (posed static geometry), `visibleObjects`, `sceneInfo`; `buildGLB`, `parseGLB`, `packGLB`; `buildOBJ`, `objChunks`, `buildSTL`; `buildBVH`;
`pointsCSV`, `anglesRows/CSV/JSON`, `dimsRows/CSV`, `reportRows/CSV`, `metricRows`, `metricsCSV`, `csvHeader`; `buildExchange`, `exchangeText`, `validateExchange`; `posturePostureOf`, `buildPostureFile`, `parsePostureFile`, `applyPostureFile`, `sceneFileText`;
`summaryText`; `effectivePosture`, `profileOf`, `CUSTOM_POSE_NAME`; `matteFromPair`; `estimateSizes`, `formatBytes`. `input = { rig, profile?, posture?: { id, name }, sandbox?, measurements? }`; every builder reads the live rig, changes nothing and throws an `Error` with a plain message (`There is no figure to export yet`, `Unknown unit "in"`, `There is nothing to export`).
Panel: `capturePNG(viewport, options)`, `captureViews(viewport, box, options)`, `ensureExportStyles()`.
