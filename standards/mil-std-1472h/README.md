# MIL-STD-1472H requirements for the website

This folder lists every requirement in **MIL-STD-1472H** (*Department of Defense Design Criteria Standard: Human Engineering*, 15 September 2020, Distribution A) that the website could check or report. It is the basis for a future feature: the site would report, for a scene built in the **Digital human** tab, which requirements are met, which are not, and which still need information from the user.

| File | What it is |
|---|---|
| [`requirements.json`](requirements.json) | The source of truth: 1,726 requirements, one per line. Each has its paragraph, title, `shall`/`should`/`info` level, numeric limits, page, how checkable it is, and how the site would check it. |
| [`requirements.csv`](requirements.csv) | The same list flattened for a spreadsheet; it is generated. |
| `../../scripts/build_standards.py` | Validates the JSON and regenerates the CSV. `--check` runs in CI. |

**In the website.** The Digital human tab now applies these requirements: every library posture, the current posture, every object of the scene and every interaction of the figure with it carry a *Compliant / Not compliant / Check* tag with the clauses that decide it, and the Analysis tab has the full report with a CSV download. What is checked, and how, is in [`docs/human3d/MIL_STD_1472H.md`](../../docs/human3d/MIL_STD_1472H.md); the rules are `site/js/human/mil1472.js`, and `tests/human3d/mil1472.test.mjs` keeps their limits equal to `requirements.json`.

> **This is not the standard.** Each `text` field is a close paraphrase that keeps every number and unit as printed. Read the paragraph in the standard before you make a compliance claim. Revision H is the current one (it supersedes G with Change 1, January 2019). Check [ASSIST](https://quicksearch.dla.mil/) for later changes. The PDF is free from [EverySpec](https://everyspec.com/MIL-STD/MIL-STD-1400-1499/MIL-STD-1472H_57041/).

## How the list was made

- The whole standard (456 pages) was read section by section. Many dimensional tables in 1472H are printed only as figures, and 46 pages have little or no text layer. Every dimensional figure was rendered and read from the image.
- Each requirement records the **printed page number** (PDF page = printed page + 17) and its paragraph, table or figure.
- Values were checked against the page images for these tables and figures:
  - Stairs (Fig 86), fixed ladders (Fig 88), vehicle seat (Fig 39) and consoles (Fig 62).
  - Team-lift limits (Table XLI), lifting multipliers (Tables XLII and XLV) and carrying limits (Table XLVII).
  - Character height (Tables XVIII and XIX) and handwheels (Table IX).
  - Viewing distance (5.2.2.11), the accommodation rules (4.5.3, 5.8) and range of motion (Table XXXI).

  Every value checked matched. For the 1,338 requirements tied to a numbered paragraph, the page number was recomputed from the text: 1,333 match, and the other five belong to paragraphs that start on one page and continue onto the next. The other 388 requirements cite a table or figure.
- Where the standard is inconsistent, the value is kept **as printed** and flagged; see [Errata](#errata-and-ambiguities-in-the-standard). Three limits whose printed minimum exceeds the printed maximum carry `"misprint": true`.

### Checkability classes

| `checkable` | Meaning | Count |
|---|---|---|
| `auto` | Computable from what the site already has: object dimensions, the mannequin at a chosen percentile, joint angles, eye point, reach | 596 |
| `semi` | Computable once the user enters a value the site does not have yet (force, frequency, control type, clothing, criticality), or once a new object type exists | 590 |
| `manual` | A yes/no checklist item (materials, labelling, behaviour) | 474 |
| `na` | Recorded for completeness; does not apply to a body-geometry website | 66 |

### Coverage by section

| § | Section | Items | auto | semi | manual | na |
|---|---|---|---|---|---|---|
| 3 | Definitions | 2 | 1 | 0 | 1 | 0 |
| 4 | General requirements | 15 | 2 | 4 | 6 | 3 |
| 5.1 | Controls | 215 | 46 | 79 | 83 | 7 |
| 5.2 | Visual displays | 116 | 24 | 62 | 28 | 2 |
| 5.3 | Speech and audio systems | 15 | 2 | 1 | 7 | 5 |
| 5.4 | Labeling and marking | 61 | 9 | 28 | 24 | 0 |
| 5.5 | Environment | 64 | 4 | 43 | 15 | 2 |
| 5.6 | Ground vehicles | 209 | 112 | 49 | 42 | 6 |
| 5.7 | Warnings, hazards, and safety | 57 | 4 | 22 | 27 | 4 |
| 5.8 | Anthropometric accommodation (incl. Table XXXI range of motion) | 53 | 46 | 5 | 2 | 0 |
| 5.9 | Design for maintainability | 184 | 28 | 85 | 71 | 0 |
| 5.10 | Workspace and workstation design | 237 | 163 | 36 | 38 | 0 |
| 5.11 | Physical environment design | 190 | 57 | 90 | 42 | 1 |
| 5.12 | Virtual, remote, automated and unmanned systems | 15 | 3 | 2 | 2 | 8 |
| 5.13 | Weapons systems and optics | 53 | 8 | 25 | 9 | 11 |
| 5.14 | Ship and industrial structure valves | 53 | 27 | 10 | 16 | 0 |
| 5.15 | Habitability | 11 | 1 | 0 | 6 | 4 |
| 5.18 | Ship bridge design | 50 | 21 | 10 | 11 | 8 |
| 5.19 | Handheld and wearable PEDs | 36 | 7 | 11 | 14 | 4 |
| 5.20 | Strength and handling | 89 | 31 | 27 | 30 | 1 |
| 6 | Notes (6.2 acquisition parameters) | 1 | 0 | 1 | 0 | 0 |

The following parts of the standard are deliberately left out or kept brief:
- **5.16 Cybersecurity and 5.17 Information systems** concern software dialogs, not body geometry. Only the items about viewing geometry are noted below.
- **Section 5.3** audio-signal coding and the electrical, chemical and toxic hazards of **5.7.8 to 5.7.20**.
- Material and corrosion rules.

## What "compliant" means in 1472H

A compliance report has to apply the standard's accommodation rules, not just compare single numbers:

1. **Default population rule (4.5.3, 5.8.3.1).** Designs must fit the **multivariate central 90 %** (95 % preferred) of *suitably clothed and equipped* **males**, and separately of **females**, of the target population. When only one dimension matters this means P5 to P95 of each sex (3.2.10). The P5 female is usually the small boundary and the P95 male the large one.
2. **Life-critical items use the central 99 % (5.8.3.2).** Examples are safety interlocks, ejection clearances and mask fit. Hatch location and operability use the central 98 % (5.11.7.5.5.2).
3. **Several dimensions at once need multivariate methods (5.8.4.2.6).** Percentiles do not add up. 1472H asks for boundary cases on a multivariate envelope, PCA, 3-D models of those cases, or parametric models.
   - **The site can already do this.** 5.8.4.2.2 names *NATICK/TR-15/007*, which is **ANSUR II 2012**, as the Army database, and the site holds ANSUR II's individual records.
   - A check can therefore run over every real subject and report the **percentage of men and of women accommodated**, which is the standard's own measure.
4. **Clothing and equipment allowances (5.8.4.2.3).** The survey data are semi-nude, so allowances for uniform, helmet, boots, body armour and load carriage must be added. The values come from NATICK/TR-14/019. The site has no ensemble setting yet.
5. **Clearances use the largest boundary case; reaches use the smallest (5.8.4.2.4).** Anything adjustable must cover the whole range of users (5.8.4.2.5).
6. **Range of motion (5.8.4.3, Table XXXI).** No task may need a joint beyond the human range of motion. Table XXXI gives mean − 1 SD and mean + 1 SD for 36 movements of the shoulder, elbow, forearm, wrist, hip, knee, ankle and neck. The mean − 1 SD value is the conservative limit to check posture joint angles against.
7. **Whole-body space (5.8.4.4.2).** If a task needs forces over 13.6 kg or fore-aft control travel over 380 mm, there must be space to move the whole body.
8. **Safety limits win (5.8.4.2.1).** When a safety or health limit is stricter than an accommodation limit, use the safety limit.

A report therefore needs these **project settings** (from 6.2):
- target population(s) and sex
- accommodation level (90 %, 95 %, 98 % or 99 %)
- anthropometric database
- clothing and equipment ensemble
- which items are life-critical
- task frequency and duration (for lifting)
- work-surface heights and armrest ranges when the procuring activity sets them

## Map to the website's features

The site already has parametric sandbox objects (`site/js/human/catalog.js`), live measurements (`measure.js`), reach, grab and sit checks (`place.js`), posture metrics and flags (`metrics.js`, `correct.js`), and an Analysis panel and exports. The tables below give the 1472H requirements each feature can check.

### Ready now: compare an object or measurement with a limit

| Site feature | 1472H requirements (printed page) | Limits |
|---|---|---|
| `stairs`, `step` | Fig 86 (p 319), Table XXXIV (p 316), 5.11.8.3 | Tread 280–300 mm. Riser 130–200 mm (170–180 preferred). Width ≥ 760 mm one-way (910 preferred), ≥ 1,220 mm two-way. Handrail height 860–940 mm, diameter 40–80 mm (40 preferred), ≥ 80 mm from the wall. Overhead clearance ≥ 1,930 mm. Stair angle 30–50° (38° preferred; Table XXXIV), computed as atan(rise/tread). Risers uniform. |
| `ladder` | Fig 88 (p 322), Table XXXIV (p 316), Fig 87 stair ladders, Fig 89/90 portable ladders | Rung spacing 230–300 mm. Rung thickness 19 to 32 mm minimum (depends on material) up to 38 mm maximum. 400 mm between stringers. Clear width ≥ 610 mm (760 preferred). 200 mm behind the ladder. Bottom rung ≤ 180 mm. Vertical ladder 75–90° (90° preferred). Inclined stairs 50–75° (not recommended). Loads over 13 kg should not be carried on stairs, and nothing should be carried up a ladder (5.11.8.1.3). |
| `doorway` | Fig 82, 5.11.7.2, 5.11.3.2.15 | Hinged door 810–860 mm wide, 2.0–2.1 m high. Accessible clear opening ≥ 815 mm. Hinge-to-wall 100–300 mm. Equipment ≥ 75 mm from the swing path. |
| `hatch` | Fig 83 (whole-body access), 5.11.7.5.6.1 (escape), 5.6.8.3.3 (vehicles), Fig 60 (temporary workspace) | Top/bottom opening ≥ 330 × 580 mm (light clothing) or 410 × 690 mm (bulky). Side opening ≥ 660 × 760 or 740 × 860 mm. Escape hatch ≥ 405 × 610 mm (510 × 710 preferred), square ≥ 460 mm. Vehicle hatch ≥ 700 mm round or 650 × 700 mm rectangular. Operating force ≤ 90 N (≤ 220 N overhead). |
| `handrail`, platforms | 5.7.7.2.2, 5.11.6.3.2 | Guardrail 91–110 cm (5.7.7) and top rail ≥ 1.1 m (5.11.6); these two paragraphs conflict. Rail diameter 37–75 mm. Edge set-back ≤ 65 mm. Toe board ≥ 150 mm. |
| `office_chair`, `stool` | Fig 73, 5.10.3.12 | Seat depth ≤ 40 cm. Seat width ≥ 38 cm. Armrests ≥ 46 cm apart. Backrest 100–115° to the pan. Backrest height ≥ 38 cm. Swivel base ≥ 46 cm. Feet supported: compare seat height with the user's popliteal height. |
| `cabin_seat`, `jump_seat` | Fig 39 (p 180), Table XXVI, 5.6.2.2 | Pan and back width 460–510 mm. Depth 380–430 mm. Back-to-pan angle 93–103°. Pan slope 5–8°. Height 150–380 mm. Head clearance ≥ 1,070 mm above the SRP. ≥ 50 mm from clothed body to any hard surface. |
| `desk`, `workbench` | 5.10.3.9.2, Fig 58, 5.10.3.8.2.6, Fig 69 | Seated surface 74–79 cm high, ≥ 76 × 40 cm. Knee room ≥ 64 × 51 × 46 cm. Standing surface: precision work 95.2–123.1 cm (adjustable), light work 90–95 cm, or relative to the user's elbow height (Fig 69). |
| `console` | Fig 62 (pp 281–282), 5.10.3 | Five console types (sit / sit-stand / stand, with or without vision over the top), each with maximum height, panel height, shelf height, seat height and width. Knee clearance 46 cm. Thigh clearance 19 cm. Foot support ≤ 46 cm below the seat. Seat adjustment 15 cm. Eye to console front 40 cm. Kick space ≥ 10 × 10 cm. |
| `monitor`, `instrument_panel`, `hud_panel` and the Measure *view* tool | 5.2.2.11, 5.2.1.1.9, Fig 2, 5.2.2.12, 5.2.2.15 | Eye-to-display distance ≥ 33 cm (50 preferred) and ≤ 70 cm seated (76 cm for ejection seats). Display face ≥ 45° to the normal line of sight, which is 15° below horizontal; 90° preferred. Display corners ≤ 30° off axis. Large screens: distance/diagonal 2–10 (3–6 preferred). HUD eye-box ≥ 11.5 × 6.5 × 15 cm. |
| Label legibility (new text-size field) | 5.4.7.1, Tables XVIII and XIX | Character height ≥ 0.004 × distance (0.006 preferred). Table XVIII bands: 2.3 / 4.7 / 9.4 / 18 / 38 mm for < 0.5, 0.5–1, 1–2, 2–4 and 4–9 m. |
| Posture joint angles (`metrics.js`) | Table XXXI (pp 241–242) | 36 range-of-motion limits. Mean − 1 SD examples: shoulder flexion 176°, elbow flexion 132°, wrist flexion 78°, hip flexion 100°, knee flexion (standing) 100°, neck flexion 48°. |
| Reach (`place.js` `reachCheck`, `envelope`) | 5.1.1.1.1.1, 5.10.3.5.1, Fig 61, 5.10.3.8.2.x, 5.10.3.9.1.x | Controls reachable by the small boundary (P5 female). Grasped items ≤ 61 cm from the front of the body. Overhead push-button ≤ 191.2 cm standing (117 cm above the seat). Overhead grip ≤ 181 cm (106.7 cm above the seat). ≤ 53 cm lateral of the centreline. |
| Mounting heights for kneeling and squatting work | Figs 63–68, 70, 71 | Ranges for controls and displays above the floor (standing, kneeling, squatting) or above the seat reference point (seated). Each figure gives an emergency/precise range and a wider general range. |
| Rear and side clearances | 5.10.2.6.5, 5.10.3.x | ≥ 122 cm behind a chair (137 preferred). ≥ 127 cm behind a stool (142 preferred). ≥ 122 cm of free floor in front of consoles and racks. |

### Needs a small addition (`semi`)

| Addition | Unlocks |
|---|---|
| **Lifting calculator.** Read H, V, D and A from the mannequin's hands and feet at the start and end of the lift; the user enters frequency, duration and coupling. | 5.20.3. WL = 23 kg × HM × VM × DM × AM × FM × CM, with HM = 25/H, VM = 1 − 0.003·\|V − 75\|, DM = 0.82 + 4.5/D, AM = 1 − 0.0032·A (cm and degrees, each multiplier capped at 1.0). FM from Table XLV (18 frequencies × 3 durations × 2 height classes) and CM from Table XLVI; all cells are in the JSON. |
| Team lift and carrying | Table XLI: 23 / 46 / 63 / 81 / 98 / 115 kg for 1 to 6 lifters. Maximum lifters = round(perimeter in cm / 60). Table XLVII carrying limits (7–14 kg by distance and frequency). Carry the load between mid-thigh and the bottom of the ribcage. Body-borne load ≤ 30 % (close combat) or ≤ 45 % (march) of body mass. |
| **Box mass and handles.** The mass parameter already exists. | 5.9.3.11: one-person items < 13.6 kg (should) and < 20.5 kg (shall). Items over 20.5 kg need two-person handling; over 40.8 kg, hoist lugs. Handle size and clearance from Fig 101 (one-hand bar ≥ 48 × 111 × 75 mm bare-handed, more with gloves or mittens). Handle diameter by item mass: 6 / 13 / 19 / 25 mm. Weight and CG placards over 13.6 kg and 45.5 kg. |
| **Access opening task.** Hand or tool, clothing and depth on the `hatch` object. | Fig 56 tool openings (screwdriver 110 × 120 mm, open-end wrench 270 × 200 mm, and others) and Fig 57 hand and arm openings (bare, gloved, arctic mitten; to the wrist, elbow or shoulder). |
| Control objects (push button, toggle, rotary knob, handwheel, crank, pedal, lever) with size, travel and resistance | Table I and Figs 6–24 (dimensions, displacement and resistance per control type). Table III minimum separations. Table IX handwheels (rim 19–32 mm, 75 mm hand clearance). Pedals (Fig 21; heel rest above 20° pad angle). Valve heights (5.14: vertical stem 150–1,250 mm, horizontal stem 225–1,800 mm). |
| Clothing and equipment ensemble | 5.8.4.2.3 and every clearance, hatch and corridor item that depends on clothing, such as the light-versus-bulky rows of Fig 83. |
| Corridor, catwalk and crawl-space objects | Fig 77 corridors: 510 mm minimum (760 preferred) for one person, 1.22–1.37 m for two. 5.11.5 catwalks. Fig 60 temporary workspaces (supine, squatting, kneeling, prone and crawl envelopes). Ramps: Table XXXIV, 7–15° for personnel (7–8° preferred) and 4–7° for material (Fig 85 allows up to 20°). |
| Body-to-object collision | 5.8.4.4.1 trunk movement space, 5.6.2.2 50 mm body clearance, Table XXVI vehicle station clearances. |
| Vehicle field of view from the eye point | 5.6.5. Fields of regard (≥ 180° horizontal, ≥ 15° up), ground intercepts (≤ 3, 6 or 10 m by station type), and the indirect-vision display 0–15° below the line of sight. |

## The site today: values that disagree with 1472H

These sandbox sliders and source notes cite MIL-STD-1472 without a revision, and a few say "from memory". `clampParams` holds every value inside the slider range, so a checker cannot flag a value the slider does not allow. These ranges need fixing first:

| Object (`catalog.js`) | Site today | MIL-STD-1472H |
|---|---|---|
| `stairs` tread | 0.20–0.35 m; the source note says "tread at least 0.24 m" | 280–300 mm (Fig 86) |
| `stairs` rise | 0.12–0.25 m; the source note says "about 0.12 to 0.20 m" | 130–200 mm, 170–180 preferred |
| `stairs` width | 0.6–1.5 m | ≥ 760 mm one-way, ≥ 1,220 mm two-way |
| `stairs` handrail grip | fixed 38 mm | 40–80 mm diameter (38 mm fails) |
| `ladder` rung spacing | 0.25–0.35 m | 230–300 mm (Fig 88) |
| `ladder` width between rails | 0.35–0.6 m; the source note says "at least 0.4 m" | 400 mm exactly between stringers (fixed ladder) |
| `ladder` angle | 60–90° | Vertical ladders 75–90° (90° preferred); 50–75° counts as inclined stairs, which are not recommended (Table XXXIV) |
| `doorway` | 0.8–1.2 × 1.8–2.4 m | Hinged door 810–860 mm × 2.0–2.1 m (Fig 82) |
| `handrail` diameter | 30–50 mm | Stairs and ramps 40–80 mm; guardrails 37–75 mm; stair ladders 32–75 mm |
| `office_chair` seat depth | 0.38–0.50 m | ≤ 40 cm (Fig 73) |
| `office_chair` recline | 0–35° from vertical | Backrest 100–115° to the seat pan |
| `cabin_seat` | height 0.25–0.60 m, depth 0.35–0.55 m, back-to-pan 90–140° | Fig 39: 150–380 mm, 380–430 mm, 93–103° |
| `desk` | 0.6–1.3 m (default 0.74) | Seated work surface 74–79 cm |
| Measure view zone (`VIEW_ZONE`) | 0.5–0.75 m, 0–30° below horizontal (ISO 9241-5 note) | 1472H: ≥ 33 cm (50 preferred), ≤ 70 cm seated. Display face ≥ 45° to the normal line of sight, which is 15° below horizontal. |
| Postures citing 1472 | "hand-wheel clearance 25–35 cm (from memory)" (work.js); "handle 25–50 mm, standoff 40–100 mm (from memory)" (holding.js); "aircrew station dimensions (approx., not re-read)" (vehicle.js) | See Table IX (handwheels), Fig 101 (handles) and Fig 39 / Table XXVI (vehicle station). |

## Suggested build order

1. **Rule engine and report panel.** A frozen rule table, generated from `requirements.json`, in the same shape as `ISO_11226` and `ergonomicFlags`: `{id, para, severity: ok | caution | high, value, limit, note}`. The panel is a "MIL-STD-1472H" section in the Analysis panel, and the report reuses the export `REPORT_COLUMNS` shape: requirement, measured, limit, status, note.
   - Status values: *pass*, *fail*, *needs input* (semi), *checklist* (manual).
   - Report the number of shall/should items passed, failed and unchecked. Never report "compliant" while any applicable item is unchecked.
2. **Project settings.** Population, sex, 90 / 95 / 98 / 99 %, database, clothing ensemble and life-critical flags. Run every body-dependent check for the small and large boundary of **each sex**.
3. **Object checks** from the "Ready now" table, after widening the slider ranges listed above.
4. **Posture checks.** Table XXXI range of motion on the current posture. Reach to every grip and control for the small boundary. Clearances for the large boundary.
5. **Multivariate accommodation.** Run the checks over every ANSUR II subject (the Army database 1472H names) and report the percentage of men and of women accommodated.
6. **Lifting and carrying calculators**, then **control objects and separations**, **access openings**, and **vehicle fields of view**.

## Errata and ambiguities in the standard

These were found during extraction and are kept as printed in the JSON:
- **Inch conversions that don't match the metric value:**
  - Fig 57: arctic clenched hand "180 mm (5 in)".
  - Fig 88 J: "180 mm (15 in)".
  - Fig 72: "72.6 cm (30 in)".
  - Fig 74: "143.2 cm (55 in)".
  - 5.6.4.1.1: "38 mm (15 in)", probably 381 mm.
  - 5.13.1.3.8.6: "340 N (250 lbf)".
  - 5.1.3.8.4.1: "0.05 mm (0.2 in)".
- **Minimum larger than maximum:**
  - Fig 17 legend-switch travel: "min 7 mm, max 1 mm" and "min 5 mm, max 1 mm".
  - Fig 24 J-handle torque: max 0.14 N·m, below the 0.7 N·m minimum.
- **Paragraphs that disagree:**
  - Guardrail height: 91–110 cm in 5.7.7.2.2, ≥ 1.1 m in 5.11.6.3.2.
  - Stair angle: 20–50° on the Fig 86 drawing, 30–50° in Table XXXIV.
  - Ramp angle: up to 20° in Fig 85, 7–15° in Table XXXIV.
  - Vehicle seat: Fig 39 and Table XXVI give different seat depth and height references.
- **Wrong cross-references:**
  - 5.11.7.2.3 cites Fig 83 for a dimension drawn on Fig 82.
  - 5.10.3.6.1.2 cites Fig 69 for standing display heights, where Fig 68 is meant.
  - 5.14.5.7.4 cites Fig 94 for the 450 mm value shown on Fig 93.
  - Table III's thumbwheel cell points to Fig 12.
- **Missing or unreadable values:**
  - Table XLII prints no validity ranges for H, V, D or A. The NIOSH manual it is based on uses H 25–63 cm, V 0–175 cm, D 25–175 cm and A 0–135°.
  - Fig 61 (seated reach points) has no numeric table; its points are estimated from the grid and marked approximate.
  - Fig 22 (leg-force curves) and Fig 48 (burn curves) are graphs without printed values.
  - 5.15 Habitability gives no berth or space dimensions; it refers to T9640-AC-DSP-010/HAB and JSSG-2010.

## Updating

Edit `requirements.json`, keeping one requirement per line, then run:

```bash
python scripts/build_standards.py          # validate, normalise the JSON, regenerate requirements.csv
python scripts/build_standards.py --check  # what CI runs
```
