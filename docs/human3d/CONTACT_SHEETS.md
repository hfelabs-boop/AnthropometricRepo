# Contact sheets: looking at a posture

For people who write postures (`POSTURES.md`, `POSE.md`). A contact sheet draws postures on real fitted bodies, from several views, next to the verdict of
`validatePosture`, the gaps to their supports and the balance, so that a posture can be judged by eye before it is added to the library.
Files: `tests/human3d/contact_sheet.py` (CLI), `tests/human3d/pages/contact-sheet.html` (the renderer), `tests/human3d/test_contact_sheet.py` (tests).
The same simplified kinematic model as everywhere: a picture that looks right is not proof that a posture is comfortable or safe.

```
python3 tests/human3d/contact_sheet.py --ids iso-7250-sitting,t-pose --out sheet.png
python3 tests/human3d/contact_sheet.py --group Sitting --body united-states/army/M:50 --body united-states/army/F:50 --out sitting.png
python3 tests/human3d/contact_sheet.py --file my-postures.json --labels --out draft.png     # postures that are not in the library yet
python3 tests/human3d/contact_sheet.py --all --body united-states/army/M:50 --body united-states/army/F:50 --out all.png   # all-01.png, all-02.png, ...
```

Needs Python with Playwright, Chromium (`/opt/pw-browsers/chromium`, or `CHROMIUM=...`) and the built `public/api/v1` (the dev server in `devserver.py` serves it).
The whole run is one page load, one WebGL renderer and one rig per body.

## Options

| option | meaning |
| --- | --- |
| `--ids a,b` / `--group NAME` / `--all` / `--file F.json` | what to draw; they add up. A group is a category (`Sitting`, `"Lifting & carrying"`) or its id; `--group` may be repeated. At least one is required |
| `--file F.json` | an array of Posture objects (or `{ "postures": [...] }`, or one object). Expanded, clamped, placed and validated exactly like library postures, **never registered**. An id that also exists in the library gets a warning, a duplicate inside the file is an error |
| `--body COUNTRY/ROLE/SEX[:P]` | a populations file of `api/v1` at percentile P (1 to 99, default 50; the service interpolates 5 to 95, beyond it is extrapolated), e.g. `united-states/army/F:95`. Also `stature:1750[:M\|F[:kg]]`. Repeat it: the bodies of one posture are drawn side by side. Default `united-states/army/M:50`. The form (male / female / neutral) follows the sex of the population |
| `--views front,side` | `front back side left right top iso`. `side` = the figure's left side, facing left. Views are relative to the **figure**: `root.heading` turns the figure in the world, not the camera. Lying postures (`support: "body"`): front and back become `top` (head up the page), because looking along the body shows nothing |
| `--cols 4 --cell 240 --max-cells 12` | cells per row, the pixel size of the 3D square (labels are above it, 78 px at 240), cells per PNG (a posture's cells stay together on one sheet when they fit) |
| `--elev 10` | camera elevation in degrees for front/back/side views, so that the seat plane and the floor are seen as planes; `0` gives true elevations |
| `--fit-each` | frame every cell on its own figure. Default: **one scale for the whole run** (the same pixels per metre in every cell, the floor line of every horizontal view on the same baseline, each figure centred sideways), so heights and reaches can be compared across cells |
| `--labels` | also number the clamped joints (list in the corner of the cell: `1 shoulder_R flex 200->180`) and mark the contacts that carry the weight |
| `--dark`, `--skeleton`, `--quality high` | dark theme; bones and joints instead of the skin; finer skin (`low` is enough at 240 px) |
| `--strict` | exit code 1 when a posture is not ok (default 0; 1 is also returned for a page error, 2 for a usage error such as an unknown id, group, view or population) |

## Reading a cell

* **Label**: id and the verdict badge (green `OK`, amber `OK . n warn`, red `FAIL`; the cell is framed in red or amber too). Next line: category, support, view and body.
  Then the first error (else the first warning) with `(+n more)`, and the numbers: `gap seat 0 feet +54` = height of the lowest point of each support carrier above its
  surface in mm (the primary carrier is 0 by construction, + floats, - sinks), `bal +45` = distance of the centre of mass projection inside the support polygon in mm
  (negative = outside; `bal (-5)` in brackets = the rule does not apply to this support or the posture is `dynamic` / `externalSupport`, the number is only for information),
  `ROM x2` (orange) = joints that had to be clamped to their range of motion.
* **Figure**: the posture is placed as `validatePosture` places it (`placePoseDetailed`, floor and, for supports with `seat`, a seat plane of `hints.seat.height`).
  The **floor** is the grey line (and the faint 0.5 m grid); the **seat** is the translucent orange slab (not drawn when the seat height is 0); the **support polygon** is the
  blue outline on the floor (the contacts within 15 mm of their surface, the shins of kneeling within 30 mm, as in the balance rule); the **centre of mass** is the red ring, its
  projection the red dot on the floor (dashed plumb line between them); orange numbered rings mark the joints whose angle was clamped (the figure is drawn with the clamped
  angles, so it never shows an impossible joint). The bar in the corner is 0.5 m. A posture that cannot be expanded (unknown joint id, wrong array length) shows "no figure" and the message.

## Output for scripts

Stdout is JSON lines only (progress and notes go to stderr): one line per posture and body,
`{"type":"posture","id","body","category","support","source":"library|file","ok","errors","warnings","gaps" (mm per carrier),"balanceMargin" (mm, null when the rule is not applied),"clamped":[{joint,dof,requested,applied}],"views","sheet"}`,
then one `{"type":"sheet","file","width","height","cells","cols","rows","cell","labelHeight"}` per PNG. The width is `cols x cell`, the height `rows x (cell + labelHeight)`.

## Tips

* Time (SwiftShader, no GPU, one core): about 5 s for 12 postures x 2 views on one body including the browser start (two thirds of it is starting Chromium and building the
  skin), 8 s for 24 posture-body pairs at `--quality high`. A sheet costs 0.5 to 2 s; 120 postures x 2 bodies x 2 views is 40 sheets of 12 cells, measured at 40 s.
* Judge heights and reach on the default common scale, shapes on `--fit-each`. One tall posture (arms overhead) makes every other figure smaller: draw it on its own sheet.
* For a drafted posture work in a loop: edit the JSON, run with `--file` and `--labels`, read the first error and the `gap` numbers (they are what to aim at), repeat. Look at the
  median woman as well as the man, and at P5 / P95 once it passes (`--body united-states/army/F:5 --body united-states/army/M:95`).
* Failing to build the skin (`body.js`) falls back to the skeleton view with a note on stderr; the sheet is still produced.
* Tests: `python -m pytest tests/human3d/test_contact_sheet.py -q` (skipped with a message when Playwright, Pillow or Chromium is missing; `REQUIRE_BROWSER=1` makes that a failure).

## Limits

The framing uses the validator's capsules plus 35 mm (the skin is inside it by at least 14 mm in the bodies and postures tried), not the skin mesh, so a cell can be a little
looser than necessary. Long messages are cut at two lines in the picture (the JSON has them whole). Only horizontal supports are drawn (floor and seat plane); there are no walls, tables or
other objects (that is the sandbox). One seat slab size (0.50 m x 0.52 m, behind to in front of the sit bones) is used whatever the chair would be.
