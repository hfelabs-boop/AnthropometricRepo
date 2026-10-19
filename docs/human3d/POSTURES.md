# Posture library: plan and rules for authors

The library lives in `site/js/human/postures/*.js` (one file per group, each exporting an array of `Posture` objects as in
`DESIGN.md` 2.4) and `site/js/human/postures.js` (aggregates them, exports `POSTURES`, `CATEGORIES`, `GRIPS`, `byId`).
This file lists what must exist. It is a floor, not a ceiling: add postures that people designing workstations, vehicles,
cockpits, weapons stations, stores and workshops would reach for.

## Rules

1. **Angles are anatomical joint angles in the model's own convention** (`skeleton.js`): flexion/abduction/internal rotation
   positive, `_LR` = both sides the same movement. Region values for the spine (`lumbar`, `thoracic`, `cervical`) are totals
   over the region, relative to the natural standing curvature.
2. **Every angle must be inside the range of motion** (the validator rejects it) and plausible for a healthy adult doing that
   task. Use literature where it exists and cite it in `source`: ISO 11226 (static working postures), ISO 7250-1 (measurement
   postures), RULA/REBA (McAtamney & Corlett 1993; Hignett & McAtamney 2000), NIOSH lifting equation postures (Waters et al.
   1993), SAE J826 / Reed et al. (driver and occupant posture), MIL-STD-1472, NASA-STD-3000 (neutral body posture in
   weightlessness is *not* used here), Winter (gait cycle), Perry (gait), TC 3-22.9 / FM 3-22.9 (rifle positions), Pheasant
   & Haslegrave "Bodyspace" (reach and working postures), Kapandji. If it is illustrative, say `source: "illustrative"`.
3. **Support must be consistent**: the declared `support` and `contacts` decide placement. A standing posture rests on the
   soles; a seated one on the ischial tuberosities with feet either on the floor (declare `hints.seat.height: "popliteal"`)
   or off the floor; kneeling on knees/shins and toes; lying on the body's lowest points. The validator places every posture on
   a flat floor (and on a seat of the hinted height) and fails if any support landmark ends up more than 15 mm above the
   supporting surface, or any body landmark more than 5 mm below it.
4. **Hands**: choose a `grips` preset for each hand (`relaxed`, `open`, `flat`, `fist`, `power`, `precision`, `hook`,
   `trigger`, `point`, `wheel`, `pinch`, `cup`, …); the grip joints are expanded from `GRIPS`.
5. **No self-intersection of gross kind**: hands not inside the torso, feet not through the shins, the head not through the
   shoulders (the validator checks capsule overlap with a tolerance; arms resting on the thighs/torso are allowed to touch).
6. **Balance**: a posture whose support is the feet must have its centre of mass projected inside (or within 40 mm of) the
   support polygon unless `hints.dynamic: true` (running, jumping, leaning on something: then declare what carries the
   weight with `hints.externalSupport`). The model stands with its centre of mass 27 to 44 mm (median 36) in front of the ankle and 37.5 % of the
   foot length from the heel, near quiet standing (MODEL.md 7.1): the edge of the soles is then about 4.6 degrees of lean about
   the ankles backward and 8.6 forward, and the 40 mm are the allowance for what the model does not know (POSE.md, "Balance and
   the stance", has the margins of tiptoe, leaning, squatting and bending with a load). A held weight goes in `hints.load`.
7. **Symmetry**: write symmetric postures with `_LR`; asymmetric ones state both sides explicitly.
8. **Names** are short and plain: "Seated upright (90-90-90)", "Squat lift: start", "Prone firing position". `description`
   says in one or two sentences what the posture is and what it is used for. `tags` are lower-case words
   (`seat`, `rifle`, `niosh`, `iso-7250`, `rula`, `gait`, `one-hand`, `two-hand`, `overhead`, `floor`, `load`, `static`, `dynamic`).
9. **Parametric families**: where a posture has a natural parameter (seat-back recline, trunk flexion, squat depth, reach
   height) author the named instances below; the editor lets the user dial the rest.

## Required postures (ids are suggestions; keep them kebab-case and unique)

**Standing**: neutral (anatomical reference), relaxed, attention, at ease, parade rest, A-pose, T-pose, hands on hips, arms
crossed, hands behind back, hands in pockets, weight on one leg, wide stance, one foot forward, slouched, erect (military
bearing), looking up, looking down, Vitruvian (arms and legs spread).

**Sitting** (chair, stool, floor): seated upright 90-90-90 (ISO 7250), relaxed office, lumbar-supported (back rest 100°),
reclined 105°/115°/125°/135°, slumped, leaning forward to a desk (forearms on the desk), on the edge of the seat, perched on
a high stool, legs crossed at the knee, legs crossed at the ankle, legs extended forward, long-sitting on the floor,
cross-legged on the floor, kneeling-sitting on the heels (seiza), side-sitting on the floor, low squat-sitting, driving (hands
9-and-3 on the wheel, right foot on a pedal), relaxed driving (one hand 12), elbows on knees, bench with arms along the
back rest, typing, mouse use, reading a tablet, reaching forward to a control panel.

**Leaning**: leaning forward with hands on a table, leaning back against a wall, hip against a desk, on one forearm at a
counter, both forearms on a rail, stooped with hands on knees, one hand on a wall, over a workbench (45°), pushing a wall,
leaning sideways (left/right), standing against a chair back, leaning on a door frame, arched back.

**Holding**: box at chest height, box at waist height, box overhead, one-hand bag at the side, hammer ready, drill forward,
two-hand tool at the waist, steering wheel, vertical grab handle, overhead bar (hanging), tray, phone to ear, binoculars,
tablet, radio handset, clipboard, cup, pistol two-hand (Isosceles and Weaver), rifle low ready, high ready, sling carry,
shouldered aim, shield, rope, joystick, lever.

**Lifting and carrying**: squat lift (start / mid / end), stoop lift (start / mid / end), semi-squat lift, one-hand "golfer's"
lift, lift to shoulder height, lift overhead (start / end), lift to a high shelf, lower to the floor, carry in front, carry at
the side (bucket), carry on the shoulder, carry a rucksack, push a cart, pull a rope, drag, push against a wall, two-person
stretcher carry (front/rear bearer), fireman's carry (carrier).

**Reaching**: forward at shoulder height, forward low, forward high, overhead, lateral, across the body, behind the back, to the
floor (stooped / squatting), seated forward / overhead / lateral / to the floor, back to the seat belt, on tiptoe to a shelf,
foot reach to a pedal, lateral bend to the floor.

**Kneeling, crouching, squatting**: deep squat, half squat (thighs horizontal), quarter squat, tactical crouch, half-kneeling
(one knee), two knees upright, kneeling on the heels, kneeling with forward lean (floor work), hands-and-knees (quadruped),
high crawl, low crawl, forward lunge, side lunge, plumber's squat, kneeling with torso rotation, bear crawl, push-up (up/down).

**Lying**: supine, prone, on the left side, on the right side, fetal, supine with knees up, prone with head up, on a mechanic's
creeper under a vehicle, supine with arms overhead, prone with arms forward, semi-reclined with legs raised.

**Locomotion**: the eight phases of walking (initial contact, loading response, mid-stance, terminal stance, pre-swing, initial
swing, mid-swing, terminal swing; Perry/Winter angles), running (contact, flight, push-off), step up, step down, stairs up and
down, ladder climbing (two rung phases), jump preparation and landing, high-step march, side-step, crouch walking.

**Work and workstation** (including RULA/REBA reference postures): overhead drilling, overhead painting, kneeling at floor
level, crouching under something, bent over a bench, standing at a workbench (elbows 90°), seated precision work with forearm
support, microscope/inspection (head forward), welding crouch, under-vehicle work, confined-space crawl, wrench pull, hammering
down, sawing, shovelling, ladder work, pushing a screwdriver, opening a hatch; RULA/REBA: trunk 0-20°, 20-60°, over 60°, upper
arm 20°, 45°, 90°, over 90°, neck 10°, 20°, over 20°, wrist neutral and 15°+.

**Military**: attention, parade rest, at ease, salute, standing fire, kneeling fire, prone fire, sitting (supported) fire, low
ready, high ready, crouch / tactical, high crawl, low crawl, sprint start, dive to prone, grenade throw, bayonet stance, ruck
march, sentry, vehicle climb, hatch stand (commander), parachute landing.

**Vehicle and cockpit**: driver hands 10-and-2, relaxed driver, accelerator, left foot on the clutch, brake reach, seat-belt
reach, mirror adjustment (arm up), door opening reach, entry (leg in), exit (step out), cockpit stick-and-throttle, looking over
the shoulder, reclined tank driver, turret gunner standing, rear bench passenger.

**Reference**: ISO 7250-1 standing, ISO 7250-1 sitting, A-pose, T-pose, Vitruvian, NIOSH lift origin, NIOSH lift destination,
RULA neutral.

The validator (`tests/human3d/postures.test.mjs`) is the acceptance test; a contact sheet of every posture (front and side
views of a 50th-percentile male and female) is rendered by `tests/human3d/contact_sheet.py` and must be looked at by the author.
