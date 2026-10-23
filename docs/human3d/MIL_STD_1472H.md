# MIL-STD-1472H in the Digital human tab

Every posture, every object of the scene and every interaction of the figure with the scene carries a **MIL-STD-1472H** tag. The tag is **Compliant**, **Not compliant** or **Check**, and it lists the clauses that decide it. The standard is *DoD Design Criteria Standard: Human Engineering*, 15 September 2020.

| Where | What is tagged |
|---|---|
| 3D view, top left | Two small chips over the model: `ISO 11226: …` and `MIL-STD-1472H: …` for the current posture. The MIL chip names up to three failed (or to-check) clauses. The status bar repeats both. |
| Posture tab, library cards | Every library posture on the current body. The badge reads `1472H ✓` / `1472H ✗` / `1472H check`; its tooltip lists the clauses. |
| Posture tab, current posture | A chip next to the posture name, and *MIL-STD-1472H clauses of this posture* under Live readouts: each clause that fails or needs checking, with its value and limit. |
| Scene tab, object list | A badge on each object. It covers the object's own dimensions and the figure's interactions with it. |
| Scene tab, selected object | A *MIL-STD-1472H* section listing every check of that object: clause, value, limit and a note. |
| Analysis tab | A *MIL-STD-1472H compliance* section: the overall status, then the posture, each interaction, each object and the population rule. The headline also names the failed clauses. *Download report (CSV)* saves every result. |

The code is in three files:
- `site/js/human/mil1472.js`: the rules. It is pure: no DOM, no scene.
- `site/js/human/compliance.js`: reads the rig, the posture editor and the sandbox, and builds the report.
- The panels: `panels/posture.js`, `panels/scene.js` and `panels/analysis.js`.

The clauses, pages and limits come from [`standards/mil-std-1472h/requirements.json`](../../standards/mil-std-1472h/requirements.json). `tests/human3d/mil1472.test.mjs` checks the limits used in the code against that file.

## Statuses

Each check returns one result with one of four statuses:

| Result | Meaning | Effect on the tag |
|---|---|---|
| **Meets** (`pass`) | The value is within the limit. | — |
| **Fails** (`fail`) | A *shall* is not met. | **Not compliant** |
| **Check** (`check`) | A *should* is not met, or the value is in a grey zone (see range of motion). | **Check** |
| **Needs input** (`input`) | The clause applies, but the site does not know a value it needs, such as lifting frequency, work type or clothing. | Listed, never counted as a pass |

A subject is **Compliant** when at least one check passes and nothing fails or needs checking.

## Posture checks

### Range of motion (5.8.4.3, Table XXXI)

Every movement the pose uses (more than 5° from neutral) is compared with Table XXXI:
- up to the lower limit (mean − 1 SD) it **meets** the clause;
- up to the upper limit (mean + 1 SD) it is **Check**, because about one person in six cannot reach it;
- beyond the upper limit it **fails**.

How the model's joints map to the table:
- **Direct readings.** Shoulder flexion and extension, elbow flexion, forearm pronation and supination, wrist flexion, extension and deviation, hip flexion and knee flexion are the rig's own degrees of freedom.
- **Neck.** Neck flexion, extension, lateral flexion and rotation come from `metrics.js` (head against the thorax).
- **Knee column.** *Kneeling* applies to kneeling and squatting postures, where the body weight flexes the knee (knee flexion over 100° standing on the feet). *Standing* applies otherwise. *Prone* applies when seated or lying.
- **Hip columns.** Hip rotation uses the sitting columns when seated and the prone columns otherwise. Hip abduction uses the supine columns when lying and the standing columns otherwise.
- **Approximate mappings.** For shoulder and hip rotation, hip abduction and adduction, and the ankle, the rig's degree of freedom is close to the movement Table XXXI measured but not the same. These stop at **Check** and never fail, and their note says so.
- **Not checked.** Shoulder horizontal abduction and adduction.

Table XXXI comes from 1950s data on semi-nude men. The standard itself warns that it may not represent today's population.

### Load held (5.20.3, 5.20.4)

These checks apply to postures of the *Lifting & carrying* group, or with *lift* or *carry* in the name, that hold a load (`hints.load.mass`).

**Lifting**
- The single-lifter limit is 23 kg (5.20.3.2, Table XLI).
- The lifting equation (5.20.3.3) is WL = 23 kg × HM × VM × AM.
  - H is the horizontal distance from the midpoint between the ankles to the hands' grip point. V is the height of the grip point. A is the asymmetry angle.
  - The travel distance, frequency and coupling are not known from one posture, so DM, FM and CM are taken as 1. That makes WL the highest limit the task can have.
  - A load above WL **fails** whatever the frequency. A load below it **meets** the clause for an occasional lift only, and *5.20.3.4.2 Needs input* asks for the frequency, duration, distance and coupling.

**Carrying**
- Table XLVII allows at most 14 kg; this is the most generous cell. Two carriers may take double (5.20.4.2).
- 5.20.4.4: carry the load between mid-thigh and the bottom of the ribcage. The bottom of the ribcage is taken halfway between the xiphoid and the navel (approx.).

**Body-borne loads (rucksack)**
- 5.20.2.3.5.2.1: at most 30 % of body weight for close combat and 45 % for marching.

Holding a tool or a cup is not a lift: holding for more than 3 s is out of the lifting limits (5.20.3.1).

## Object checks

These use the object's own parameters, as set in the Scene tab.

| Object | Clauses |
|---|---|
| Stairs, step | Riser 130–200 mm, tread 280–300 mm, width ≥ 760 mm, handrail 860–940 mm high and 40–80 mm across (5.11.8.3.1, Figure 86). Angle 30–50° (5.11.8.1.2, Table XXXIV). A handrail on each side (5.11.8.1.8). A landing every 10 to 12 treads (5.11.8.3.2, *should*). |
| Ladder | Angle 75–90°; 50–75° is the range of inclined stairs, which is not recommended (Table XXXIV). Rung spacing 230–300 mm, rung 19–38 mm, 400 mm between stringers, bottom rung ≤ 180 mm (5.11.8.5.1.1, Figure 88). |
| Doorway | 810–860 mm wide (wider: Check) and 2.0–2.1 m high (5.11.7.2.1, Figure 82). Clear width ≥ 815 mm (5.11.3.2.15). |
| Hatch | Whole-body side access ≥ 660 mm high × 760 mm wide in light clothing (5.11.7.5.7, Figure 83). Sill ≤ 690 mm without footholds (5.11.7.6.2). |
| Handrail | Platform rail 91–110 cm (5.7.7.2.2), diameter 37–75 mm (5.11.6.3.2). |
| Grab handle | Clearance ≥ 5 cm (5.20.7.2.1). One-hand bar ≥ 111 mm long (5.20.7.5, Figure 101). |
| Floor platform | Under 4 ft without fall protection (4.9.3). At least 610 × 910 mm (5.11.6.1.2). |
| Office chair | Seat depth ≤ 40 cm, width ≥ 38 cm, backrest ≥ 38 cm, armrests ≥ 19 cm high (5.10.3.12.1, Figure 73). Backrest 100–115° (5.10.3.12.8). Armrests (5.10.3.12.11), ≥ 46 cm apart (5.10.3.12.11.2). |
| Bar stool | 71–81 cm (5.10.3.13.4.2.3). |
| Cabin seat, jump seat | Width 460–510 mm, depth 380–430 mm, height 150–380 mm, back 460–510 mm, back-to-pan 93–103°, pan slope 5–8° (5.6.2.1, Figure 39). |
| Desk | Height 74–79 cm (5.10.3.9.2.2). At least 76 × 40 cm (5.10.3.9.2.1). |
| Workbench | 90–95 cm for light work; Check, since the work type decides (5.10.3.8.2.6.2). |
| Console | Straight panel ≤ 112 cm for one seated user (5.10.3.14.3.1). |
| Monitor, laptop, tablet | Diagonal ≤ 81.28 cm at 70 cm (5.2.2.11.2, *should*). |
| Steering wheel | Diameter 355–510 mm; rim 19–32 mm, and the model's 34 mm rim fails (5.1.4.1.2.5.6, Table IX). |
| Pedals | Pad angle ≤ 60° and separation 50–100 mm (5.1.4.2.2.2.9, Figure 21). The model's pads are 30 mm apart. |
| Throttle, lever | Knob 32–44 mm (Table XI) and 38–75 mm (Figure 20), under 5.1.4.2.2.1. |
| Loads (crate, box, ammo can, toolbox, rucksack, drum, sandbag, jerrycan, pallet) | One lifter ≤ 23 kg (5.20.3.2, Table XLI). Heavier items need a weight label (5.20.4.6, Needs input). Two handles over 4.5 kg (5.20.7.1.1). Handle diameter by mass (5.20.7.5, Figure 101). A load without a mass: Needs input. |

## Interaction checks

These come from the figure in the scene (`compliance.js` `sceneFacts`).

**Stance.** *Seated* (the support includes a seat), *kneeling*, *squatting* (knee flexion over 100° on the feet), *lying* or *standing*.

**Sitting on a seat**
- 5.10.3.12.5: the feet must be on the floor or a footrest (the feet gap of the editor ≤ 10 mm).

**A hand on a grip** (a grip centre within 30 mm of a grip of an object)
- Controls (steering wheel, joystick, throttle, lever, pedals, keyboard, instrument panel, console) are mounted at:
  - standing: 76–188 cm (5.10.3.8.2.1);
  - seated: 15–106.7 cm above the seat (5.10.3.9.1.1);
  - kneeling: 45.7–145 cm (5.10.3.7.2);
  - squatting: 36–125 cm (5.10.3.7.3).
- Any grip gripped overhead: at most 181 cm standing (5.10.3.8.2.4), or 106.7 cm above the seat (5.10.3.9.1.3).

**A display in front of the eyes** (each visible monitor, laptop, tablet, instrument panel, HUD or wall display whose centre is ahead of the figure)
- Distance at least 33 cm (5.2.2.11.4), and at most 70 cm for a seated user at an individual display (5.2.2.11.2).
- Wall displays: distance 2 to 10 times the diagonal (5.2.2.12.3).
- Display face at least 45° to the line of sight (5.2.1.1.9).
- Display centre height:
  - standing: 104–177.8 cm (5.10.3.8.2.5);
  - seated: 15.2–111.8 cm above the seat (5.10.3.9.1.5);
  - kneeling: 71–145 cm (5.10.3.6.5.1);
  - squatting: 50.8–125 cm (5.10.3.6.5.2).
- Seated: at most 53 cm from the centreline (5.10.3.9.3.2.1).

**A load in the hands** (a load object with a mass and at least one hand on its grips)
- The lifting checks above, with the real hand position.

**The population (4.5.3)**
- Always listed as *Needs input*. The check ran on one body, while 4.5.3 asks for the central 90 % (95 % preferred) of men and of women in their clothing and equipment.
- Repeat the check with the small and the large boundary bodies, for example a 5th percentile woman and a 95th percentile man (Profile tab).

## Limits

- **One body only.** The report checks the body on screen. Compliance with 4.5.3 needs the boundary bodies (above).
- **No clothing or equipment allowances.** 5.8.4.2.3 asks for them; the body is semi-nude survey data.
- **The model's simplifications** (`DESIGN.md` 0) apply: rigid links, approximate joint centres, no soft tissue, no collision between the body and objects. So clearance clauses (5.8.4.2.4, Table XXVI, 5.6.2.2) are not checked yet.
- **Paraphrases.** The texts paraphrase the standard and keep its numbers. Read the clause, at the page given, before you rely on a result. Where the standard contradicts itself (guardrail height, stair angle, ramp angle), the README of the requirements lists both values.
- **Not covered.** Most of the 1,726 requirements in the catalogue are checklist items or need inputs the site does not have yet: forces, frequencies, labels, lighting, noise. They are not shown as tags.

## Tests

- `node --import ./tests/human3d/register.mjs --test tests/human3d/mil1472.test.mjs` covers:
  - every clause and limit against the catalogue;
  - the edges of each object rule;
  - all 316 library postures on two bodies;
  - the real rig, editor and sandbox: seat, display distance, a hand on a handle, a load.
- `REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_mil1472.py` (run it on its own, like the other browser test files) covers the real site in Chromium: the library badges, the current posture chip, the Scene rows and selected object, and the Analysis section and its CSV download.
