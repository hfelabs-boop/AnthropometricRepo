// MIL-STD-1472H (DoD Design Criteria Standard: Human Engineering, 15 September 2020) checks for the Digital human tab: every posture, every object of the
// scene and every interaction of the figure with the scene (sitting on a seat, a hand on a grip, looking at a display, holding a load) is tagged
// "compliant", "not compliant" or "check", with the clauses that decide it. Docs: docs/human3d/MIL_STD_1472H.md. The clause numbers, pages and limits
// come from standards/mil-std-1472h/requirements.json (tests/human3d/mil1472.test.mjs checks every limit below against it, so they cannot drift).
//
//   checkPosture(body, pose, posture?)  -> results for a pose: ranges of motion of Table XXXI (5.8.4.3) and the load the posture holds (5.20.3, 5.20.4)
//   checkObject(obj)                    -> results for a sandbox object { id, type, name, params }: its own dimensions (stairs, ladder, seats, desks, loads...)
//   checkScene(facts)                   -> results for the interactions of the figure with the scene (facts: plain data, see sceneFacts in panels/compliance.js)
//   summarize(results)                  -> { status: "compliant" | "not-compliant" | "check" | "none", clauses, failed, counts }
//   postureCompliance(body, posture)    -> the tag of a library posture on a body (memoised), as the library cards show it
//
// A result: { id, clause, ref, title, level: "shall" | "should", status: "pass" | "fail" | "check" | "input", value, limit, unit, note, page, subject }.
//   pass   the value meets the requirement
//   fail   a "shall" is not met                                    -> the subject is NOT COMPLIANT
//   check  a "should" is not met, or the value is in a grey zone   -> CHECK
//   input  the requirement applies but needs a value the site does not know (frequency, work type, clothing): listed, never counted as a pass
// Pure: three and the posture helpers only, no DOM. Lengths in metres in, millimetres or centimetres in the texts (as the standard prints them).
import { postureMetrics } from "./metrics.js";
import { expandPosture, placePose, landmarkPosition } from "./pose.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;
export const STANDARD = Object.freeze({ id: "MIL-STD-1472H", date: "2020-09-15", title: "Department of Defense Design Criteria Standard: Human Engineering" });

// ---------------------------------------------------------------------------------------------------------------------
// The clauses used here: paragraph (or table / figure), short title, shall / should, printed page. `ref` is the table or figure that holds the number.
const CL = (clause, title, level, page, ref = null) => Object.freeze({ clause, title, level, page, ref });
export const CLAUSES = Object.freeze({
  accommodation: CL("4.5.3", "Accommodation of the central 90 % (95 % preferred) of males and of females", "shall", 22),
  rom: CL("5.8.4.3", "Range of motion: tasks shall not require exceeding human range of motion", "shall", 241, "Table XXXI"),
  // stairs, ladders, doors, hatches, rails, platforms (5.11, 5.7.7)
  stairAngle: CL("5.11.8.1.2", "Angle of ascent of stairs", "shall", 316, "Table XXXIV"),
  ladderAngle: CL("5.11.8.1.2", "Angle of ascent of ladders", "shall", 316, "Table XXXIV"),
  stairRiser: CL("5.11.8.3.1", "Stair riser height", "shall", 319, "Figure 86"),
  stairTread: CL("5.11.8.3.1", "Stair tread depth", "shall", 319, "Figure 86"),
  stairWidth: CL("5.11.8.3.1", "Stair width (one-way)", "shall", 319, "Figure 86"),
  stairRailHeight: CL("5.11.8.3.1", "Stair handrail height", "shall", 319, "Figure 86"),
  stairRailDia: CL("5.11.8.3.1", "Stair handrail diameter", "shall", 319, "Figure 86"),
  handrailsBothSides: CL("5.11.8.1.8", "A handrail on each side of stairs and ramps", "shall", 316),
  landings: CL("5.11.8.3.2", "A landing every 10 to 12 treads", "should", 319),
  ladderSpacing: CL("5.11.8.5.1.1", "Fixed ladder rung spacing", "shall", 322, "Figure 88"),
  ladderRung: CL("5.11.8.5.1.1", "Fixed ladder rung thickness", "shall", 322, "Figure 88"),
  ladderWidth: CL("5.11.8.5.1.1", "Fixed ladder width between stringers", "shall", 322, "Figure 88"),
  ladderBottom: CL("5.11.8.5.1.1", "Fixed ladder: lower elevation to the bottom rung", "shall", 322, "Figure 88"),
  doorWidth: CL("5.11.7.2.1", "Hinged door width", "shall", 312, "Figure 82"),
  doorHeight: CL("5.11.7.2.1", "Hinged door height", "shall", 312, "Figure 82"),
  doorClear: CL("5.11.3.2.15", "Clear width of doors on accessible routes", "shall", 309),
  bodyAccessSide: CL("5.11.7.5.7", "Rectangular hatch: whole-body access opening", "shall", 313, "Figure 83"),
  stepDown: CL("5.11.7.6.2", "Step-down through an access opening without footholds", "shall", 315),
  guardrailHeight: CL("5.7.7.2.2", "Handrail or safety bar height around platforms", "shall", 223),
  guardrailDia: CL("5.11.6.3.2", "Guardrail diameter", "shall", 311),
  platformSize: CL("5.11.6.1.2", "Platform minimum dimensions", "shall", 310),
  fallProtection: CL("4.9.3", "Fall protection for elevated work (4 ft general industry)", "shall", 24),
  // seats, work surfaces, consoles (5.10)
  chairDepth: CL("5.10.3.12.1", "Chair seat pan depth", "shall", 297, "Figure 73"),
  chairWidth: CL("5.10.3.12.1", "Chair seat pan width", "shall", 297, "Figure 73"),
  chairBack: CL("5.10.3.12.1", "Chair backrest height", "shall", 297, "Figure 73"),
  backrestAngle: CL("5.10.3.12.8", "Backrest angle (seat to back)", "shall", 299),
  armrests: CL("5.10.3.12.11", "Armrests provided", "shall", 299),
  armrestHeight: CL("5.10.3.12.1", "Armrest height", "shall", 297, "Figure 73"),
  armrestGap: CL("5.10.3.12.11.2", "Distance between armrests", "shall", 299),
  stoolHeight: CL("5.10.3.13.4.2.3", "Stool seat height", "shall", 301),
  feetSupported: CL("5.10.3.12.5", "Feet firmly supported when seated", "shall", 299),
  vSeatWidth: CL("5.6.2.1", "Vehicle seat pan width", "shall", 180, "Figure 39"),
  vSeatDepth: CL("5.6.2.1", "Vehicle seat depth", "shall", 180, "Figure 39"),
  vSeatBack: CL("5.6.2.1", "Vehicle seat back height above the SRP", "shall", 180, "Figure 39"),
  vSeatAngle: CL("5.6.2.1", "Vehicle seat back-to-pan angle", "shall", 180, "Figure 39"),
  vSeatSlope: CL("5.6.2.1", "Vehicle seat pan slope", "shall", 180, "Figure 39"),
  vSeatHeight: CL("5.6.2.1", "Vehicle seat height", "shall", 180, "Figure 39"),
  deskHeight: CL("5.10.3.9.2.2", "Seated work surface height", "shall", 294),
  deskSize: CL("5.10.3.9.2.1", "Seated work surface width and depth", "shall", 294),
  benchHeight: CL("5.10.3.8.2.6.2", "Standing work surface height (light manual work)", "shall", 291),
  consoleWidth: CL("5.10.3.14.3.1", "Straight console panel width for one seated user", "shall", 301),
  // controls and displays (5.1, 5.2, 5.10)
  steeringDia: CL("5.1.4.1.2.5.6", "Vehicle steering wheel diameter", "shall", 79, "Table IX"),
  steeringRim: CL("5.1.4.1.2.5.6", "Steering wheel rim diameter", "shall", 79, "Table IX"),
  pedalAngle: CL("5.1.4.2.2.2.9", "Pedal angle from the floor", "shall", 101, "Figure 21"),
  pedalSep: CL("5.1.4.2.2.2.9", "Pedal separation (one foot, sequential)", "shall", 101, "Figure 21"),
  throttleKnob: CL("5.1.4.2.2.1", "Throttle lever spherical grip diameter", "shall", 97, "Table XI"),
  leverKnob: CL("5.1.4.2.2.1", "Lever grip diameter (hand grasp)", "shall", 95, "Figure 20"),
  ctrlStanding: CL("5.10.3.8.2.1", "Control mounting height, standing", "shall", 289),
  ctrlSeated: CL("5.10.3.9.1.1", "Control mounting height above the seat, seated", "shall", 293),
  ctrlKneeling: CL("5.10.3.7.2", "Control mounting height, kneeling", "shall", 287),
  ctrlSquatting: CL("5.10.3.7.3", "Control mounting height, squatting", "shall", 287),
  gripOverheadStanding: CL("5.10.3.8.2.4", "Overhead gripping reach, standing", "shall", 290),
  gripOverheadSeated: CL("5.10.3.9.1.3", "Overhead gripping reach above the seat, seated", "shall", 293),
  viewMax: CL("5.2.2.11.2", "Maximum viewing distance of individual displays (seated)", "shall", 110),
  viewMin: CL("5.2.2.11.4", "Minimum viewing distance", "shall", 110),
  viewLarge: CL("5.2.2.12.3", "Large-screen viewing distance to diagonal ratio", "shall", 111),
  displayDiag: CL("5.2.2.11.2", "Display diagonal at 70 cm viewing distance", "should", 110),
  displayFace: CL("5.2.1.1.9", "Display face angle to the line of sight", "shall", 106, "Figure 2"),
  dispStanding: CL("5.10.3.8.2.5", "Display mounting height, standing", "shall", 290),
  dispSeated: CL("5.10.3.9.1.5", "Display mounting height above the seat, seated", "shall", 294),
  dispKneeling: CL("5.10.3.6.5.1", "Display mounting height, kneeling", "shall", 284),
  dispSquatting: CL("5.10.3.6.5.2", "Display mounting height, squatting", "shall", 285),
  dispLateral: CL("5.10.3.9.3.2.1", "Lateral offset of a single display, seated", "shall", 296),
  // strength and handling (5.20, 5.9)
  liftOne: CL("5.20.3.2", "Maximum weight for one lifter", "shall", 417, "Table XLI"),
  liftEq: CL("5.20.3.3", "Maximum weight limit of the lifting equation", "shall", 418, "Tables XLII to XLVI"),
  liftInput: CL("5.20.3.4.2", "Lifting frequency, duration and travel distance", "shall", 422, "Table XLV"),
  carryLimit: CL("5.20.4.5", "Carrying weight limits", "shall", 424, "Table XLVII"),
  carryTwo: CL("5.20.4.2", "Two-person carry: double the carrying limit", "shall", 423),
  bodyLoad: CL("5.20.2.3.5.2.1", "Total body-borne load: 30 % of body weight (close combat), 45 % (marching)", "should", 416),
  carryHeight: CL("5.20.4.4", "Carry the load between mid-thigh and the bottom of the ribcage", "should", 424),
  handles: CL("5.20.7.1.1", "Two handles (or a handle and a grasp area)", "shall", 432),
  handleDia: CL("5.20.7.5", "Minimum handle diameter for the item weight", "shall", 434, "Figure 101"),
  handleClear: CL("5.20.7.2.1", "Handle clearance from obstructions", "shall", 432),
  handleLength: CL("5.20.7.5", "One-hand bar handle length", "shall", 433, "Figure 101"),
  weightLabel: CL("5.20.4.6", "Label items heavier than the one-person lift", "shall", 424),
  // maintenance access: equipment racks, cabinets and enclosures (5.4, 5.7, 5.9)
  workingLevel: CL("5.9.1.9.1", "Complete visual and physical access; favorable working level", "shall", 245),
  armAccess: CL("5.9.6.9.3", "Arm and hand access openings not smaller than Figure 57", "shall", 252, "Figure 57"),
  toolAccess: CL("5.9.6.7.2", "Access openings large enough for hands, arms and tools", "shall", 250, "Figure 56"),
  hingeOpen: CL("5.9.2.5", "Hinge-mounted units open their full distance and stay open without being held", "shall", 246),
  rollout: CL("5.9.3.6", "Items pulled out of their installed position on rollout racks, slides or hinges", "shall", 247),
  drawerForce: CL("5.9.3.6.2a", "Pull-out racks and drawers operate with less than 17.8 N", "shall", 247),
  coverLabels: CL("5.4.5.3", "Labels on the outside of covers and access openings", "shall", 148),
  maintObstruction: CL("5.7.5.4", "Maintenance workspace free of obstructions", "shall", 219),
  maintFloor: CL("5.9.6.8.4", "Floor space of at least 0.4 m² per maintainer", "shall", 251),
  storageTraffic: CL("5.7.5.6.1", "Storage racks in passageways do not impede traffic", "shall", 220),
  storageSharp: CL("5.7.5.6.2", "Storage racks: no protruding studs or sharp corners", "shall", 220),
  // crew stations: cabins, cockpits, imported models (5.6.2)
  vHeadClear: CL("5.6.2.1", "Vehicle seat: vertical head clearance above the SRP", "shall", 180, "Figure 39"),
  headImpact: CL("5.6.2.2.1", "Head (with gear) to the closest potential head impact: at least 50 mm", "shall", 182),
  clearFore: CL("5.6.2.2.2", "Body to hard surface, fore-aft: at least 50 mm", "shall", 182),
  clearLateral: CL("5.6.2.2.3", "Body to hard surface, lateral: at least 50 mm", "should", 182),
  clearVertical: CL("5.6.2.2.4", "Body to hard surface, vertical: at least 50 mm", "shall", 182),
  elbowRoom: CL("5.6.2.2.3", "Vehicle station: elbow (dynamic) clearance", "should", 182, "Table XXVI"),
  shoulderRoom: CL("5.6.2.2.3", "Vehicle station: shoulder clearance", "should", 182, "Table XXVI"),
  clothedClear: CL("5.6.1.5.1", "Clothed and equipped dimensions for clearances", "shall", 180),
  // seats, benches, workstations (5.6.2.8, 5.10)
  benchSpacing: CL("5.6.2.8.1", "Bench seat spacing per seated person", "shall", 184),
  unstableSeat: CL("5.10.3.12.3", "No unstable seating or standing devices", "shall", 298),
  cushion: CL("5.10.3.12.10.2", "Cushioned seats when seated for longer than 1 hour", "shall", 299),
  deskWall: CL("Figure 58", "Seated workspace: desk to wall (D)", "shall", 272),
  dispField: CL("5.10.3.6.1.5", "Display within 45° of the line of sight", "shall", 284, "Figure 2"),
  warnCone: CL("5.1.2.2.3.11", "Emergency and warning displays within the 30° cone about the normal line of sight", "shall", 41, "Figure 2"),
  dispObstruct: CL("5.18.7.2.1.1", "View to the display not obstructed by other equipment", "shall", 402),
  armObscure: CL("5.1.2.2.3.8", "The hand or arm does not obscure the display", "shall", 41),
  ctrlVisible: CL("5.10.3.7.1.6.4", "Control visible to check its position", "shall", 287),
  pointerLevel: CL("5.10.1.4.6", "Pointing device level with the keyboard (±2.5 cm)", "should", 272, "Figure 73"),
  keySlope: CL("5.1.3.2.4", "Slope of non-portable keyboards", "shall", 47),
  keySize: CL("Table VII", "Keyboard key size (bare hand)", "shall", 47),
  mouseSize: CL("Table VIII", "Mouse dimensions", "shall", 49),
  joyGripLen: CL("5.1.3.5.2.5.1", "Joystick hand grip length", "shall", 52),
  joyGripDia: CL("5.1.3.5.2.5.2", "Joystick hand grip diameter", "shall", 52),
  joyClear: CL("5.1.3.5.2.5.3", "Joystick hand clearance: 100 mm to the side, 50 mm to the rear", "shall", 52),
  // displays (5.2)
  hudEyebox: CL("5.2.2.15.4", "HUD eye-box at least 11.5 cm wide, 6.5 cm high, 15 cm deep", "shall", 115),
  hudFov: CL("5.2.2.15.7", "HUD field of view (land vehicles)", "shall", 115),
  largeMin: CL("5.2.2.12.5", "Large screen: no observer closer than half its width or height", "shall", 111),
  largeMax: CL("5.2.2.12.4", "Large screen: characters at least 2.9 mrad at the most distant observer", "shall", 111),
  // tools, weapons, optics (5.9.3, 5.9.5, 5.13)
  minimalTools: CL("5.9.3.2", "Minimal tools and only common hand tools for removal and replacement", "should", 246),
  knobsNotScrewdriver: CL("5.9.5.2", "Knobs, not screwdriver controls, for adjustments more often than monthly", "shall", 248),
  noFlashlight: CL("5.9.5.7", "Mirrors or flashlights not required for adjustments", "shall", 249),
  smallArms: CL("5.13.1.4.1.1", "Small arms operable by the central 90 % of clothed and equipped users in any firing position", "shall", 346),
  weaponSurfaces: CL("5.13.1.4.1.3", "Weapon contact surfaces smooth, without sharp edges", "shall", 346),
  binoIpd: CL("5.13.2.11.3", "Binocular eyepiece separation adjustable from 50 to 75 mm", "shall", 351),
  binoMass: CL("5.13.2.11.7", "Handheld binoculars not heavier than 1.5 kg (1 kg preferred)", "shall", 351),
  binoMag: CL("5.13.2.3.3", "Handheld, unstabilized binoculars not more than 8 power", "shall", 349),
});
/** The statement of an object to which no MIL-STD-1472H requirement applies (a measuring aid, a reference shape): listed, never a pass. */
const NO_CLAUSE = Object.freeze({ clause: "", title: "No MIL-STD-1472H requirement applies", level: "info", page: null, ref: null });

// ---------------------------------------------------------------------------------------------------------------------
// Table XXXI: range of human motion, degrees (lower limit = mean - 1 SD, upper limit = mean + 1 SD; semi-nude males, WADC-TR 55-159 and WADC-TN-57-311).
export const ROM_XXXI = Object.freeze({
  shoulderFlexion: [176, 190], shoulderExtension: [47, 75], shoulderLateralRotation: [21, 47], shoulderMedialRotation: [75, 119],
  elbowFlexion: [132, 152], forearmSupination: [91, 135], forearmPronation: [53, 101],
  wristFlexion: [78, 102], wristExtension: [86, 112], wristUlnar: [40, 54], wristRadial: [18, 36],
  hipFlexion: [100, 126], hipAdductionSupine: [19, 43], hipAbductionSupine: [41, 65], hipAbductionStanding: [16, 30], hipAdductionStanding: [15, 33],
  hipLateralRotationProne: [24, 44], hipMedialRotationProne: [29, 49], hipMedialRotationSitting: [22, 40], hipLateralRotationSitting: [21, 39],
  kneeFlexionProne: [115, 135], kneeFlexionStanding: [100, 126], kneeFlexionKneeling: [150, 168],
  anklePosterior: [26, 50], ankleAnterior: [28, 42],
  neckExtension: [44, 88], neckFlexion: [48, 72], neckLateralRight: [34, 48], neckLateralLeft: [34, 48], neckRotationRight: [65, 93], neckRotationLeft: [65, 93],
});
const ROM_LABEL = Object.freeze({
  shoulderFlexion: "Shoulder flexion", shoulderExtension: "Shoulder extension", shoulderLateralRotation: "Shoulder lateral rotation", shoulderMedialRotation: "Shoulder medial rotation",
  elbowFlexion: "Elbow flexion", forearmSupination: "Forearm supination", forearmPronation: "Forearm pronation",
  wristFlexion: "Wrist flexion", wristExtension: "Wrist extension", wristUlnar: "Wrist ulnar deviation", wristRadial: "Wrist radial deviation",
  hipFlexion: "Hip flexion", hipAdductionSupine: "Hip adduction (supine)", hipAbductionSupine: "Hip abduction (supine)", hipAbductionStanding: "Hip abduction (standing)", hipAdductionStanding: "Hip adduction (standing)",
  hipLateralRotationProne: "Hip lateral rotation (prone)", hipMedialRotationProne: "Hip medial rotation (prone)", hipMedialRotationSitting: "Hip medial rotation (sitting)", hipLateralRotationSitting: "Hip lateral rotation (sitting)",
  kneeFlexionProne: "Knee flexion (prone)", kneeFlexionStanding: "Knee flexion (standing)", kneeFlexionKneeling: "Knee flexion (kneeling)",
  anklePosterior: "Ankle, posterior tibial angle (plantar flexion)", ankleAnterior: "Ankle, anterior tibial angle (dorsiflexion)",
  neckExtension: "Neck extension", neckFlexion: "Neck flexion", neckLateralRight: "Neck lateral flexion (right)", neckLateralLeft: "Neck lateral flexion (left)", neckRotationRight: "Neck rotation (right)", neckRotationLeft: "Neck rotation (left)",
});

// lifting (Tables XLI, XLII, XLV, XLVI) and carrying (Table XLVII)
export const LIFT = Object.freeze({
  LC: 23, // kg, the load constant (5.20.3.2, 5.20.3.3)
  team: Object.freeze([23, 46, 63, 81, 98, 115]), // kg, Table XLI: 1 to 6 lifters
  // Table XLII (metric, H, V, D in cm, A in degrees); every multiplier is capped at 1.0
  HM: (H) => Math.min(1, 25 / H), VM: (V) => Math.min(1, 1 - 0.003 * Math.abs(V - 75)), DM: (D) => Math.min(1, 0.82 + 4.5 / D), AM: (A) => Math.min(1, 1 - 0.0032 * A),
  carryBest: 14, // kg, the highest cell of Table XLVII (one carry every 5 minutes, 2.1 m or less)
});
// Figure 101: minimum handle diameter by the weight of the item
export const HANDLE_DIA = Object.freeze([[6.8, 6], [9.0, 13], [18, 19], [Infinity, 25]]); // [up to kg, minimum mm]

// ---------------------------------------------------------------------------------------------------------------------
// results
const subj = (kind, id, name, extra = null) => ({ kind, id, name, ...(extra ?? {}) });
function res(key, c, status, { value = null, limit = "", unit = "", note = "", subject = null, id = null } = {}) {
  return { id: id ?? key, clause: c.clause, ref: c.ref, title: c.title, level: c.level, page: c.page, status, value: fin(value) ? value : null, limit, unit, note, subject };
}
/** A range test: pass inside [lo, hi] (either may be null); outside, "fail" for a shall and "check" for a should. */
function range(key, c, value, lo, hi, unit, opt = {}) {
  if (!fin(value)) return res(key, c, "input", { ...opt, limit: limitText(lo, hi, unit), unit, note: opt.note ?? "Value not available." });
  const ok = (lo == null || value >= lo - 1e-9) && (hi == null || value <= hi + 1e-9);
  const bad = opt.soft ? "check" : c.level === "shall" ? "fail" : "check";
  return res(key, c, ok ? "pass" : bad, { ...opt, value, limit: opt.limit ?? limitText(lo, hi, unit), unit });
}
export function limitText(lo, hi, unit) {
  const u = unit ? ` ${unit}` : "";
  if (lo != null && hi != null) return lo === hi ? `${lo}${u}` : `${lo} to ${hi}${u}`;
  if (lo != null) return `at least ${lo}${u}`;
  if (hi != null) return `at most ${hi}${u}`;
  return "";
}

/** Status of a list of results: not-compliant (a shall fails), check (a should fails or a grey zone), compliant (at least one pass and nothing else), none. */
export function summarize(results) {
  const counts = { pass: 0, fail: 0, check: 0, input: 0, na: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  // "review": requirements apply but every one needs a value the site does not have; "na": only statements that no requirement applies
  const status = counts.fail ? "not-compliant" : counts.check ? "check" : counts.pass ? "compliant" : counts.input ? "review" : counts.na ? "na" : "none";
  const uniq = (list) => [...new Set(list.filter((r) => r.clause).map(clauseRef))].sort(byClause);
  return { status, counts, clauses: uniq(results), failed: uniq(results.filter((r) => r.status === "fail")), toCheck: uniq(results.filter((r) => r.status === "check")), toEnter: uniq(results.filter((r) => r.status === "input")) };
}
/** "5.11.8.3.1 (Figure 86)" */
export const clauseRef = (r) => (!r.clause ? "" : r.ref ? `${r.clause} (${r.ref})` : r.clause);
const byClause = (a, b) => {
  const pa = a.split(/[ (]/)[0].split(".").map(Number), pb = b.split(/[ (]/)[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? -1) - (pb[i] ?? -1); if (d) return d; }
  return a.localeCompare(b);
};
export const STATUS_WORD = Object.freeze({ compliant: "Compliant", "not-compliant": "Not compliant", check: "Check", review: "Needs information", na: "Not applicable", none: "Not checked" });
/** One line: "Not compliant: 5.8.4.3 (Table XXXI), 5.20.3.3" / "Compliant with 5.8.4.3 (Table XXXI)". */
export function tagText(sum) {
  if (sum.status === "none") return "No MIL-STD-1472H clause applies that the model can check.";
  if (sum.status === "na") return "No MIL-STD-1472H requirement applies to it (a reference or measuring object).";
  if (sum.status === "review") return `Applies, needs information the model does not have: ${sum.toEnter.join(", ")}.`;
  if (sum.status === "not-compliant") return `Not compliant with ${sum.failed.join(", ")}${sum.toCheck.length ? `; check ${sum.toCheck.join(", ")}` : ""}.`;
  if (sum.status === "check") return `To check: ${sum.toCheck.join(", ")}. Meets ${sum.clauses.filter((c) => !sum.toCheck.includes(c)).join(", ") || "no other clause"}.`;
  return `Compliant with ${sum.clauses.join(", ")}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// postures: ranges of motion (Table XXXI) and the load held

/** The context that picks the Table XXXI column: "kneeling" (knee flexion with the body weight on it: kneeling and squatting), "lying", "seated" or "standing". */
export function romContext(posture, angles) {
  const sup = String(posture?.support ?? "feet"), cat = String(posture?.category ?? "");
  if (sup === "body" || /^Lying/.test(cat)) return "lying";
  if (/knees|shins/.test(sup)) return "kneeling";
  if (sup.startsWith("seat")) return "seated";
  const kf = Math.max(angles?.knee_L?.[0] ?? 0, angles?.knee_R?.[0] ?? 0);
  if (/Kneeling/.test(cat) || kf > 100) return "kneeling"; // a squat: the body weight flexes the knee as in kneeling
  return "standing";
}

/**
 * Range-of-motion results of a pose (5.8.4.3, Table XXXI). angles: the pose's joint angles (degrees, the rig's DOFs); metrics: postureMetrics (for the neck).
 * Each movement passes up to the lower limit (mean - 1 SD: about 84 % of the men measured reach it), is "check" up to the upper limit (mean + 1 SD) and fails
 * beyond it. Only movements that the posture uses (beyond 5 degrees) are listed.
 */
// Movements whose rig DOF is only close to the movement Table XXXI measured (the twist of a raised arm or thigh is not the clinical rotation; the ankle of a
// kneeling or squatting body is flexed by the body weight): beyond the upper limit they are "check", not "fail".
export const ROM_APPROX = Object.freeze(new Set(["shoulderLateralRotation", "shoulderMedialRotation", "hipLateralRotationProne", "hipMedialRotationProne", "hipMedialRotationSitting",
  "hipLateralRotationSitting", "hipAbductionStanding", "hipAdductionStanding", "hipAbductionSupine", "hipAdductionSupine", "anklePosterior", "ankleAnterior"]));

export function romResults(angles, metrics, context, subject = null) {
  const out = [], c = CLAUSES.rom;
  let used = 0;
  const add = (key, side, value) => {
    if (!fin(value) || value <= 5) return;
    used += 1;
    const [lo, hi] = ROM_XXXI[key], approx = ROM_APPROX.has(key);
    const status = value <= lo + 1e-9 ? "pass" : value <= hi + 1e-9 || approx ? "check" : "fail";
    const label = `${ROM_LABEL[key]}${side ? (side === "L" ? ", left" : ", right") : ""}`;
    const note = status === "pass" ? "" : status === "check"
      ? `Beyond the lower limit of Table XXXI (mean − 1 SD): about one person in six cannot reach ${r0(value)}°.`
      : `Beyond the upper limit of Table XXXI (mean + 1 SD): most people cannot reach ${r0(value)}°.${approx ? " (The model's joint is close to, not the same as, the movement measured: check it.)" : ""}`;
    out.push(res(`rom-${key}${side ? `-${side}` : ""}`, c, status, { value, limit: `${lo}° (mean − 1 SD), ${hi}° (mean + 1 SD)`, unit: "°", note: `${label}. ${note}`.trim(), subject }));
  };
  const A = (j, k) => angles?.[j]?.[k];
  for (const s of ["L", "R"]) {
    const f = A(`shoulder_${s}`, 0), rot = A(`shoulder_${s}`, 2);
    if (fin(f)) { if (f >= 0) add("shoulderFlexion", s, f); else add("shoulderExtension", s, -f); }
    if (fin(rot)) { if (rot >= 0) add("shoulderMedialRotation", s, rot); else add("shoulderLateralRotation", s, -rot); }
    add("elbowFlexion", s, A(`elbow_${s}`, 0));
    const pr = A(`forearm_${s}`, 0);
    if (fin(pr)) { if (pr >= 0) add("forearmPronation", s, pr); else add("forearmSupination", s, -pr); }
    const wf = A(`wrist_${s}`, 0), wd = A(`wrist_${s}`, 1);
    if (fin(wf)) { if (wf >= 0) add("wristFlexion", s, wf); else add("wristExtension", s, -wf); }
    if (fin(wd)) { if (wd >= 0) add("wristRadial", s, wd); else add("wristUlnar", s, -wd); }
    add("hipFlexion", s, A(`hip_${s}`, 0));
    const ab = A(`hip_${s}`, 1), hr = A(`hip_${s}`, 2);
    if (fin(ab)) {
      if (context === "lying") { if (ab >= 0) add("hipAbductionSupine", s, ab); else add("hipAdductionSupine", s, -ab); }
      else { if (ab >= 0) add("hipAbductionStanding", s, ab); else add("hipAdductionStanding", s, -ab); }
    }
    if (fin(hr)) {
      const sit = context === "seated";
      if (hr >= 0) add(sit ? "hipMedialRotationSitting" : "hipMedialRotationProne", s, hr); else add(sit ? "hipLateralRotationSitting" : "hipLateralRotationProne", s, -hr);
    }
    add(context === "kneeling" ? "kneeFlexionKneeling" : context === "standing" ? "kneeFlexionStanding" : "kneeFlexionProne", s, A(`knee_${s}`, 0));
    const an = A(`ankle_${s}`, 0);
    if (fin(an)) { if (an >= 0) add("ankleAnterior", s, an); else add("anklePosterior", s, -an); }
  }
  if (metrics) {
    const nf = metrics.neckFlexion, sb = metrics.neckSideBend, tw = metrics.neckTwist;
    if (fin(nf)) { if (nf >= 0) add("neckFlexion", null, nf); else add("neckExtension", null, -nf); }
    if (fin(sb)) { if (sb >= 0) add("neckLateralLeft", null, sb); else add("neckLateralRight", null, -sb); }
    if (fin(tw)) { if (tw >= 0) add("neckRotationLeft", null, tw); else add("neckRotationRight", null, -tw); }
  }
  if (!used) out.push(res("rom-all", c, "pass", { limit: "Table XXXI", note: "Every joint is within 5° of its neutral position.", subject }));
  return out;
}

/**
 * The lifting equation at one posture (5.20.3.3, Table XLII). H, V in metres (the hands' grip point: horizontal distance from the mid-point between the ankles,
 * height above the floor), A in degrees. D (vertical travel) and F (frequency) are not known from one posture: DM = FM = CM = 1 (an occasional lift with a good
 * grip), so WL is the HIGHEST limit the task can have. A load above it fails whatever the frequency; a load below it passes only for occasional lifting.
 */
export function liftLimit({ H, V, A = 0 }) {
  const Hc = Math.max(25, H * 100), Vc = V * 100;
  const HM = LIFT.HM(Hc), VM = Math.max(0, LIFT.VM(Vc)), AM = Math.max(0, LIFT.AM(Math.abs(A)));
  return { WL: LIFT.LC * HM * VM * AM, HM, VM, AM, H: Hc, V: Vc, A: Math.abs(A) };
}

/**
 * Results for a load held in the hands. load: { mass (kg), H, V, A (geometry of the hands, metres / degrees), carrying: bool, trunk: degrees, band: { lo, hi } metres
 * (mid-thigh and bottom of the ribcage) }. Lift: Table XLI (one lifter) and the lifting equation; carry: Table XLVII and the carry height of 5.20.4.4.
 */
export function loadResults(load, subject = null) {
  const out = [], m = load?.mass;
  if (!fin(m) || m <= 0) return out;
  if (m < 2.3) return out; // 5.20.3.1: the lifting limits apply to objects over 2.3 kg
  if (load.bodyWorn) {
    if (!fin(load.bodyMass)) return out;
    const share = (100 * m) / load.bodyMass;
    out.push(res("body-load", CLAUSES.bodyLoad, share <= 45 ? (share <= 30 ? "pass" : "check") : "check", { value: share, unit: "% of body weight", limit: "at most 30 % (close combat), 45 % (marching)", note: `${r1(m)} kg on a body of ${r1(load.bodyMass)} kg. For the 5th percentile body weight the total is capped at 18.5 kg (close combat) and 27.7 kg (marching) (5.20.2.3.5.2.3).`, subject }));
    return out;
  }
  if (load.carrying) {
    const n = load.carriers ?? 1, lim = LIFT.carryBest * Math.min(n, 2) * (n > 2 ? 1 + 0.375 * (n - 2) : 1);
    const c = n >= 2 ? CLAUSES.carryTwo : CLAUSES.carryLimit;
    out.push(res("carry-limit", c, m <= lim ? "pass" : "fail", { value: m, unit: "kg", limit: `at most ${r1(lim)} kg (${n >= 2 ? `${n} carriers, ` : ""}one carry every 5 minutes over 2.1 m or less; less for more often or further)`, note: m <= lim ? "Meets the most generous cell of Table XLVII; enter the carry frequency and distance to confirm." : n >= 2 ? "Too heavy for this team even at the most generous cell of Table XLVII." : "Heavier than every cell of Table XLVII: use two carriers (5.20.4.2) or a cart.", subject }));
    if (load.band && fin(load.V)) {
      const ok = load.V >= load.band.lo - 0.01 && load.V <= load.band.hi + 0.01;
      out.push(res("carry-height", CLAUSES.carryHeight, ok ? "pass" : "check", { value: load.V * 100, unit: "cm", limit: `${r0(load.band.lo * 100)} to ${r0(load.band.hi * 100)} cm (mid-thigh to the bottom of the ribcage of this body, approx.)`, note: "Hands' height above the floor.", subject }));
    }
    return out;
  }
  out.push(res("lift-one", CLAUSES.liftOne, m <= LIFT.LC ? "pass" : "fail", { value: m, unit: "kg", limit: `at most ${LIFT.LC} kg for one lifter (two: ${LIFT.team[1]} kg, three: ${LIFT.team[2]} kg)`, note: m <= LIFT.LC ? "" : `Needs ${LIFT.team.findIndex((w) => m <= w) + 1 || "more than 6"} lifters (Table XLI) or a lifting aid, and a weight label (5.20.4.6).`, subject }));
  if (fin(load.H) && fin(load.V)) {
    const L = liftLimit(load);
    out.push(res("lift-eq", CLAUSES.liftEq, m <= L.WL + 1e-9 ? "pass" : "fail", {
      value: m, unit: "kg", limit: `at most ${r1(L.WL)} kg here (23 kg × HM ${L.HM.toFixed(2)} × VM ${L.VM.toFixed(2)} × AM ${L.AM.toFixed(2)}; H ${r0(L.H)} cm, V ${r0(L.V)} cm, A ${r0(L.A)}°)`,
      note: m <= L.WL ? "For an occasional lift (at most one every 5 minutes) with good handles; the travel distance and frequency lower the limit." : "Too heavy for this hand position even for an occasional lift with good handles.", subject }));
    out.push(res("lift-input", CLAUSES.liftInput, "input", { limit: "lifts per minute, work duration, travel distance D, coupling", note: "Enter them to apply the frequency (Table XLV), distance and coupling (Table XLVI) multipliers.", subject }));
  }
  return out;
}

/** Hands and load geometry of a posed body: { H, V, A, band } from the landmarks (metres; A in degrees). hands: landmark ids holding the load. */
export function loadGeometry(point, hands, headingDeg = 0) {
  const pts = hands.map((id) => point(id)).filter(Boolean);
  if (!pts.length) return null;
  const hx = pts.reduce((a, p) => a + p[0], 0) / pts.length, hy = pts.reduce((a, p) => a + p[1], 0) / pts.length, hz = pts.reduce((a, p) => a + p[2], 0) / pts.length;
  const aL = point("lateral_malleolus_L") ?? point("heel_L"), aR = point("lateral_malleolus_R") ?? point("heel_R");
  if (!aL || !aR) return null;
  const mx = (aL[0] + aR[0]) / 2, mz = (aL[2] + aR[2]) / 2, dx = hx - mx, dz = hz - mz;
  const fwd = [Math.sin(headingDeg * D2R), Math.cos(headingDeg * D2R)];
  const along = dx * fwd[0] + dz * fwd[1], across = dx * fwd[1] - dz * fwd[0];
  const H = Math.hypot(dx, dz), A = H > 0.05 ? Math.abs(Math.atan2(across, Math.max(1e-6, along))) * R2D : 0;
  const yOf = (id) => point(id)?.[1];
  const thigh = (yOf("trochanterion_L") + yOf("knee_top_L") + yOf("trochanterion_R") + yOf("knee_top_R")) / 4;
  const ribs = (yOf("xiphoid") + yOf("omphalion")) / 2;
  return { H, V: hy, A, band: fin(thigh) && fin(ribs) ? { lo: thigh, hi: ribs } : null };
}

const CARRY_RE = /carry|march|walk/i;
/** The load a library posture holds: { mass, hands, carrying } or null. */
export function postureLoad(posture) {
  const L = posture?.hints?.load;
  if (!L || !fin(L.mass)) return null;
  const hands = Array.isArray(L.landmarks) && L.landmarks.length ? L.landmarks : ["grip_centre_L", "grip_centre_R"];
  const lifting = /^Lifting/.test(String(posture.category ?? "")) || /lift/i.test(String(posture.id ?? ""));
  const text = `${posture.id} ${posture.name}`, bodyWorn = /ruck|backpack/i.test(text);
  const carrying = CARRY_RE.test(text) || bodyWorn;
  if (!lifting && !carrying) return null; // holding a tool or a cup is not a lift (5.20.3.1: holding for more than 3 s is out of the lifting limits)
  return { mass: L.mass, hands, carrying, bodyWorn, carriers: /stretcher/i.test(text) ? 2 : 1 };
}

/**
 * The results of a pose: ranges of motion and the load. pose: { root, angles } (placed or not); posture: the library entry or { support, category, id, hints }.
 * Returns { results, context, metrics }.
 */
export function checkPosture(body, pose, posture = {}) {
  const subject = subj("posture", posture.id ?? null, posture.name ?? "Posture");
  const m = postureMetrics(body, { root: pose.root, angles: pose.angles }, pose.root, {});
  const context = romContext(posture, pose.angles);
  const results = romResults(pose.angles, m, context, subject);
  const load = postureLoad(posture);
  if (load) {
    const point = (id) => { try { return landmarkPosition(body, pose, pose.root, id).toArray(); } catch { return null; } };
    const g = loadGeometry(point, load.hands, m.bodyHeading ?? 0);
    results.push(...loadResults({ ...load, ...(g ?? {}), bodyMass: body.mass }, subject));
  }
  return { results, context, metrics: m };
}

const TAGS = new WeakMap();
/** The tag of a library posture on a body, as the library cards show it: { status, summary, results } (memoised per posture and body; never throws). */
export function postureCompliance(body, posture) {
  let m = TAGS.get(posture);
  if (!m) TAGS.set(posture, (m = new WeakMap()));
  if (m.has(body)) return m.get(body);
  let out;
  try {
    const e = expandPosture(posture);
    const pl = placePose(body, { root: e.root, angles: e.angles }, { support: posture.support });
    const { results } = checkPosture(body, { root: { ...e.root, ...pl }, angles: e.angles }, posture);
    const summary = summarize(results);
    out = { status: summary.status, summary, results };
  } catch { out = { status: null, summary: null, results: [] }; }
  m.set(body, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// objects: their own dimensions
const mm = (m) => m * 1000, cm = (m) => m * 100;
const LOAD_TYPES = new Set(["crate", "small_box", "ammo_can", "toolbox", "rucksack", "drum", "sandbag", "jerrycan", "pallet"]);
export const CONTROL_TYPES = new Set(["steering_wheel", "joystick", "throttle", "lever", "pedals", "keyboard_mouse", "instrument_panel", "console"]);
export const DISPLAY_TYPES = new Set(["monitor", "triple_monitor", "hud_panel", "tablet", "laptop", "wall_display", "instrument_panel"]);
const IN2M = 0.0254;

/** The grips an object type offers with their diameters (from the catalogue), passed in by the caller: checkObject(obj, { grips }). */
export function checkObject(obj, { grips = [] } = {}) {
  const p = obj?.params ?? {}, S = subj("object", obj?.id ?? null, obj?.name ?? obj?.type ?? "Object"), C = CLAUSES, o = { subject: S };
  const out = [];
  switch (obj?.type) {
    case "stairs":
    case "step": {
      const rise = mm(p.rise), tread = mm(p.tread ?? p.depth), width = mm(p.width);
      out.push(range("riser", C.stairRiser, rise, 130, 200, "mm", { ...o, note: rise >= 170 && rise <= 180 ? "In the preferred 170 to 180 mm." : "Preferred: 170 to 180 mm." }));
      out.push(range("tread", C.stairTread, tread, 280, 300, "mm", o));
      if (obj.type === "stairs") {
        out.push(range("width", C.stairWidth, width, 760, null, "mm", { ...o, note: "One-way stairs (910 mm preferred); two-way stairs need at least 1,220 mm." }));
        const ang = Math.atan2(p.rise, p.tread) * R2D;
        out.push(range("angle", C.stairAngle, ang, 30, 50, "°", { ...o, note: `Rise over tread; 38° preferred.` }));
        out.push(res("handrails", C.handrailsBothSides, p.handrails ? "pass" : "fail", { ...o, limit: "one on each side", value: p.handrails ? 2 : 0, unit: "", note: p.handrails ? "" : "Switch Handrails on." }));
        if (p.handrails) {
          out.push(range("rail-height", C.stairRailHeight, 900, 860, 940, "mm", { ...o, note: "The model's rail is 900 mm above the nosing line." }));
          out.push(range("rail-dia", C.stairRailDia, 38, 40, 80, "mm", { ...o, note: "The model's rail is 38 mm across (40 mm preferred)." }));
        }
        if (fin(p.steps)) out.push(range("landings", C.landings, p.steps, null, 12, "treads", { ...o, note: "A landing every 10 to 12 treads." }));
      }
      break;
    }
    case "ladder": {
      const ang = p.angle;
      out.push(res("angle", C.ladderAngle, ang >= 75 && ang <= 90 ? "pass" : ang >= 50 ? "check" : "fail", { ...o, value: ang, unit: "°", limit: "75 to 90° (90° preferred)", note: ang >= 75 ? "" : ang >= 50 ? "50 to 75° is the range of inclined stairs, which Table XXXIV does not recommend." : "Below 50° use stairs (Table XXXIV)." }));
      out.push(range("spacing", C.ladderSpacing, mm(p.spacing), 230, 300, "mm", { ...o, note: "300 mm preferred." }));
      out.push(range("rung", C.ladderRung, mm(p.rung), 19, 38, "mm", { ...o, note: "Protected metal rungs (wood 32 to 38 mm, corrosive metal 25 to 38 mm); 35 mm preferred." }));
      out.push(range("width", C.ladderWidth, mm(p.width), 395, 405, "mm", { ...o, limit: "400 mm", note: "Figure 88 gives 400 mm as minimum, maximum and preferred (±5 mm tolerance here)." }));
      out.push(range("bottom", C.ladderBottom, 150 * Math.sin((ang ?? 90) * D2R), null, 180, "mm", { ...o, note: "The model's first rung is 150 mm up the rails." }));
      break;
    }
    case "doorway": {
      const w = mm(p.width), h = p.height;
      out.push(res("width", C.doorWidth, w < 810 ? "fail" : w > 860 ? "check" : "pass", { ...o, value: w, unit: "mm", limit: "810 to 860 mm", note: w > 860 ? "Wider than the hinged door of Figure 82: fine for passage, check the door type." : "" }));
      out.push(range("clear", C.doorClear, w, 815, null, "mm", { ...o, note: "Clear opening with the door at 90° on an accessible route." }));
      out.push(res("height", C.doorHeight, h < 2.0 ? "fail" : h > 2.1 ? "check" : "pass", { ...o, value: h, unit: "m", limit: "2.0 to 2.1 m", note: h > 2.1 ? "Taller than the door of Figure 82." : "" }));
      break;
    }
    case "hatch": {
      const w = mm(p.width), h = mm(p.height), sill = mm(p.sill);
      out.push(range("height", C.bodyAccessSide, h, 660, null, "mm", { ...o, id: "access-height", note: "Light clothing; bulky clothing needs 740 mm." }));
      out.push(range("width", C.bodyAccessSide, w, 760, null, "mm", { ...o, id: "access-width", note: "Light clothing; bulky clothing needs 860 mm." }));
      out.push(range("sill", C.stepDown, sill, null, 690, "mm", { ...o, note: "Higher steps need footholds or steps on both sides." }));
      break;
    }
    case "handrail": {
      out.push(range("height", C.guardrailHeight, cm(p.height), 91, 110, "cm", { ...o, note: "Around platforms and catwalks. 5.11.6.3.2 asks for a top rail of at least 1.1 m; stair handrails are 860 to 940 mm (Figure 86)." }));
      out.push(range("dia", C.guardrailDia, mm(p.diameter), 37, 75, "mm", o));
      break;
    }
    case "grab_handle": {
      out.push(range("clear", C.handleClear, cm(p.standoff), 5, null, "cm", { ...o, note: "Clearance from the wall behind the bar." }));
      out.push(range("length", C.handleLength, mm(p.length), 111, null, "mm", { ...o, note: "One-hand bar, bare hand (gloved 125 mm, mittened 135 mm)." }));
      break;
    }
    case "floor_platform": {
      out.push(range("height", C.fallProtection, p.height / 0.3048, null, 4, "ft", { ...o, note: "Higher platforms need guardrails or other fall protection." }));
      out.push(range("width", C.platformSize, mm(Math.min(p.width, p.depth)), 610, null, "mm", { ...o, id: "size-width" }));
      out.push(range("length", C.platformSize, mm(Math.max(p.width, p.depth)), 910, null, "mm", { ...o, id: "size-length" }));
      break;
    }
    case "office_chair": {
      out.push(range("depth", C.chairDepth, cm(p.seatDepth), null, 40, "cm", o));
      out.push(range("width", C.chairWidth, cm(p.seatWidth), 38, null, "cm", o));
      out.push(range("back", C.chairBack, cm(p.backHeight), 38, null, "cm", o));
      out.push(range("angle", C.backrestAngle, 90 + p.recline, 100, 115, "°", { ...o, note: "Seat to back, with the seat pan level." }));
      out.push(res("armrests", C.armrests, p.armrests ? "pass" : "fail", { ...o, limit: "armrests", note: p.armrests ? "" : "Switch Armrests on." }));
      if (p.armrests) {
        out.push(range("arm-height", C.armrestHeight, cm(p.armHeight), 19, null, "cm", o));
        out.push(range("arm-gap", C.armrestGap, cm(p.seatWidth), 46, null, "cm", { ...o, note: "The model's armrests are at the sides of the seat pan." }));
      }
      break;
    }
    case "bar_stool": out.push(range("height", C.stoolHeight, cm(p.height), 71, 81, "cm", { ...o, note: "Stool of a sit-stand workstation." })); break;
    case "cabin_seat":
    case "jump_seat": {
      const width = mm(p.panWidth ?? p.width), depth = mm(p.panDepth ?? p.depth), height = mm(p.seatHeight), back = mm(p.backHeight);
      out.push(range("width", C.vSeatWidth, width, 460, 510, "mm", o));
      out.push(range("depth", C.vSeatDepth, depth, 380, 430, "mm", o));
      out.push(range("height", C.vSeatHeight, height, 150, 380, "mm", { ...o, note: "Seat pan above the floor (or the heel point)." }));
      out.push(range("back", C.vSeatBack, back, 460, 510, "mm", o));
      if (fin(p.recline)) out.push(range("angle", C.vSeatAngle, p.recline, 93, 103, "°", o));
      if (fin(p.panAngle)) out.push(range("slope", C.vSeatSlope, p.panAngle, 5, 8, "°", o));
      break;
    }
    case "desk": {
      out.push(range("height", C.deskHeight, cm(p.height), 74, 79, "cm", o));
      out.push(range("width", C.deskSize, cm(p.width), 76, null, "cm", { ...o, id: "size-width" }));
      out.push(range("depth", C.deskSize, cm(p.depth), 40, null, "cm", { ...o, id: "size-depth" }));
      break;
    }
    case "workbench": out.push(range("height", C.benchHeight, cm(p.height), 90, 95, "cm", { ...o, soft: true, note: "For light manual work; precision work needs an adjustable surface (95.2 to 123.1 cm), heavier work a lower one. Set the work type to decide." })); break;
    case "console": out.push(range("width", C.consoleWidth, cm(p.width), null, 112, "cm", { ...o, note: "Wider panels for one seated user need a wraparound console (Figure 75)." })); break;
    case "monitor": case "triple_monitor": case "laptop": case "tablet": {
      const diag = (p.diagonal ?? 0) * IN2M * 100;
      if (fin(diag) && diag > 0) out.push(range("diag", C.displayDiag, diag, null, 81.28, "cm", { ...o, note: "Individual displays seen from 70 cm: corners within 30° of the perpendicular." }));
      break;
    }
    case "steering_wheel": {
      out.push(range("dia", C.steeringDia, mm(p.diameter), 355, 510, "mm", { ...o, note: "Power steering 355 to 400 mm, non-power 400 to 510 mm." }));
      out.push(range("rim", C.steeringRim, 34, 19, 32, "mm", { ...o, note: "The model's rim is 34 mm across." }));
      break;
    }
    case "pedals": {
      out.push(range("angle", C.pedalAngle, p.angle, null, 60, "°", { ...o, note: "Above 20° from the horizontal the heel must rest on the floor or a heel rest (5.1.4.2.2.2.2.3)." }));
      out.push(range("sep", C.pedalSep, 30, 50, 100, "mm", { ...o, note: "The model's pads are 100 mm wide on 130 mm centres: 30 mm apart (random operation needs 100 to 150 mm)." }));
      break;
    }
    case "throttle": out.push(range("knob", C.throttleKnob, 40, 32, 44, "mm", { ...o, note: "The model's knob is 40 mm across." })); break;
    case "lever": out.push(range("knob", C.leverKnob, 44, 38, 75, "mm", { ...o, note: "The model's knob is 44 mm across." })); break;
    // ---- seating without its own figure in the standard
    case "stool":
    case "bench": {
      out.push(range("seat-height", C.feetSupported, cm(p.height), null, 46, "cm", { ...o, limit: "seat at most 46 cm above the foot support", note: "Figure 62 (F): above 46 cm the feet of small users hang; then add a footrest or heel catch." }));
      if (obj.type === "bench") {
        const seats = Math.floor(p.length / 0.55 + 1e-9);
        out.push(res("spacing", C.benchSpacing, seats >= 1 ? "pass" : "fail", { ...o, value: mm(p.length / Math.max(seats, 1)), unit: "mm", limit: "at least 550 mm per seat position (663 mm preferred)", note: `${seats} seat position${seats === 1 ? "" : "s"} at 550 mm; ${Math.floor(p.length / 0.663 + 1e-9)} at the preferred 663 mm.` }));
      }
      out.push(res("unstable", C.unstableSeat, "input", { ...o, limit: "a stable seat", note: "Confirm it does not rock, roll or tip (ball chairs and wobble boards are not allowed)." }));
      out.push(res("cushion", C.cushion, "input", { ...o, limit: "cushioned when seated for more than 1 hour", note: obj.type === "stool" ? "A bare stool is acceptable only for short spells." : "Enter how long people sit on it." }));
      break;
    }
    // ---- displays and panels
    case "hud_panel": {
      out.push(res("eyebox", C.hudEyebox, "input", { ...o, limit: "eye-box ≥ 11.5 × 6.5 × 15 cm", note: "A property of the HUD optics: enter it from the HUD's specification." }));
      out.push(res("fov", C.hudFov, "input", { ...o, limit: "≥ 6° up, 5° down, 12° left and right (land vehicles)", note: "From the HUD's specification." }));
      break;
    }
    case "wall_display": {
      const diag = (p.diagonal ?? 0) * IN2M, w = diag * (p.orientation === "portrait" ? 9 : 16) / Math.hypot(16, 9);
      out.push(res("min-distance", C.largeMin, "input", { ...o, limit: `no viewer closer than ${r0(cm(Math.max(w, diag * 16 / Math.hypot(16, 9)) / 2))} cm (half its larger side)`, note: "Checked in the scene when the figure looks at it (also 2 to 10 × the diagonal, 5.2.2.12.3)." }));
      out.push(res("characters", C.largeMax, "input", { ...o, limit: "characters ≥ 2.9 mrad (≥ 4.5 mrad preferred) for the most distant viewer", note: `About ${r0(mm(0.0029 * 3))} mm tall at 3 m: enter the character height of the content.` }));
      break;
    }
    case "instrument_panel": out.push(range("width", C.consoleWidth, cm(p.width), null, 112, "cm", { ...o, note: "For one seated user; wider panels need a wraparound layout (Figure 75)." })); break;
    case "side_console": {
      out.push(res("controls", C.ctrlSeated, "input", { ...o, limit: "controls 15 to 106.7 cm above the seat", note: "Checked when the figure sits beside it and a hand is on a control of the scene." }));
      out.push(range("height", C.ctrlStanding, cm(p.height), 76, 188, "cm", { ...o, soft: true, note: "Seen from a standing user; seated users are checked against the seat height in the scene." }));
      break;
    }
    // ---- structures
    case "shelving": {
      const top = p.height;
      out.push(range("top-shelf", C.gripOverheadStanding, cm(top), null, 181, "cm", { ...o, note: "The front edge of the top shelf as the highest grasp of a standing user." }));
      out.push(res("traffic", C.storageTraffic, "input", { ...o, limit: "out of the traffic flow", note: "In a passageway: place it so it does not narrow the walkway (measure the gap in the Measure tab)." }));
      out.push(res("sharp", C.storageSharp, "input", { ...o, limit: "no protruding studs or sharp corners", note: "A property of the real rack." }));
      break;
    }
    case "wall":
    case "partition": out.push(res("desk-wall", C.deskWall, "input", { ...o, limit: "at least 81 cm from a desk edge to the wall behind its user", note: "Checked in the scene for every desk that faces away from it." })); break;
    case "equipment_rack": {
      const base = Math.min(p.plinth, p.height - 0.2), b0 = Math.min(Math.max(Math.max(p.bayBottom, base + 0.02), base + 0.02), p.height - 0.1);
      const b1 = Math.min(Math.max(Math.max(p.bayTop, b0 + 0.08), b0 + 0.08), p.height - 0.03), mid = (b0 + b1) / 2;
      const wIn = p.width - 0.05, hIn = b1 - b0, depth = p.depth - 0.11;
      // the working level: the bay against the mounting heights of controls for each posture (5.10.3.8.2.1 standing, 5.10.3.7.2 kneeling)
      const standOk = cm(b0) >= 76 && cm(b1) <= 188, kneelOk = cm(b0) >= 45.7 && cm(b1) <= 145;
      out.push(res("working-level", C.workingLevel, standOk ? "pass" : kneelOk ? "check" : "fail", { ...o, value: cm(mid), unit: "cm", limit: "the work inside the bay at a favourable level: 76 to 188 cm standing (86.4 to 139.7 for frequent work), 45.7 to 145 cm kneeling",
        note: standOk ? (cm(b0) >= 86.4 && cm(b1) <= 139.7 ? "The whole bay is in the preferred standing range." : "Workable standing; part of the bay is outside the preferred 86.4 to 139.7 cm.") : kneelOk ? "Below the standing range: the maintainer must kneel (5.10.3.7.2). Raise the bay if the work is frequent." : "Outside the standing and kneeling ranges: the maintainer must squat, lie or reach overhead." }));
      out.push(range("arm-access-w", C.armAccess, mm(wIn), depth > 0.49 ? 500 : 200, null, "mm", { ...o, id: "arm-access-width", note: depth > 0.49 ? "Two arms to the shoulders (the bay is deeper than 490 mm)." : "Two hands, reaching 150 to 490 mm deep, light clothing (arctic: wider by 0.75 × the reach)." }));
      out.push(range("arm-access-h", C.armAccess, mm(hIn), 125, null, "mm", { ...o, id: "arm-access-height", note: "180 mm in arctic clothing." }));
      const tools = [["open-end wrench", 270, 200], ["T-handle wrench", 135, 155], ["screwdriver", 110, 120]], fit = tools.filter(([, w, hh]) => mm(wIn) >= w && mm(hIn) >= hh).map((t) => t[0]);
      out.push(res("tool-access", C.toolAccess, fit.length === tools.length ? "pass" : fit.length ? "check" : "fail", { ...o, value: mm(Math.min(wIn, hIn)), unit: "mm", limit: "open-end wrench 270 × 200 mm, T-handle 135 × 155, screwdriver 110 × 120",
        note: fit.length === tools.length ? "Every common tool fits through the bay." : fit.length ? `Fits: ${fit.join(", ")}; check which tools the task needs.` : "Too small for common hand tools." }));
      if (p.door !== "none") out.push(res("door-open", C.hingeOpen, "input", { ...o, limit: "opens fully and stays open without being held", note: p.door === "lift" || p.door === "gullwing" ? "A lifted lid or leaf needs a stay, a prop or a gas strut." : "A door check or detent." }));
      out.push(res("labels", C.coverLabels, "input", { ...o, limit: "labels on the outside of the cover naming what is inside", note: "A property of the real equipment." }));
      out.push(res("rollout", C.rollout, "input", { ...o, limit: "items pulled out ride on rollout racks, slides or hinges; less than 17.8 N to pull (5.9.3.6.2a)", note: "Enter it if units are pulled out of the rack." }));
      out.push(res("workspace", C.maintFloor, "input", { ...o, limit: "≥ 0.4 m² of free floor per maintainer, free of obstructions (5.7.5.4)", note: "Keep the floor in front of the bay clear (check it with the figure in place)." }));
      break;
    }
    case "cabin_shell": {
      out.push(range("elbow", C.elbowRoom, cm(p.width), 91, null, "cm", { ...o, note: "Table XXVI A: lateral span at elbow height for one occupant (static: 71 cm)." }));
      out.push(range("shoulder", C.shoulderRoom, cm(p.width), 58, null, "cm", { ...o, note: "Table XXVI C." }));
      out.push(res("head", C.vHeadClear, "input", { ...o, limit: "at least 1,070 mm from each seat's SRP to the roof", note: "Checked in the scene for every seat inside the cabin." }));
      out.push(res("body-clearance", C.clearVertical, "input", { ...o, limit: "≥ 50 mm from any body part to the cabin, with clothing and equipment", note: "Checked in the scene with the figure in its pose." }));
      break;
    }
    case "cad_model": {
      out.push(res("clearance", C.clothedClear, "input", { ...o, limit: "clearances from clothed and equipped body dimensions; ≥ 50 mm body to hard surface in crew stations (5.6.2.2.2 to 5.6.2.2.4)", note: "Measured in the scene from the figure to the model's surfaces; add clothing and equipment to the result." }));
      out.push(res("accommodation", C.accommodation, "input", { ...o, limit: "central 90 % (95 % preferred) of men AND of women", note: "Check the model with a small woman and a large man (Profile tab)." }));
      break;
    }
    // ---- controls and tools
    case "joystick": {
      out.push(range("grip-length", C.joyGripLen, 155, 110, 180, "mm", { ...o, note: "The model's grip is 155 mm long." }));
      out.push(range("grip-dia", C.joyGripDia, 48, null, 50, "mm", { ...o, note: "The model's grip is 48 mm across at its widest." }));
      out.push(res("hand-clear", C.joyClear, "input", { ...o, limit: "100 mm to the side, 50 mm to the rear", note: "Check the free space around the grip in the scene (Measure tab)." }));
      break;
    }
    case "keyboard_mouse": {
      const cols = Math.floor((p.width - 0.03) / 0.0185), key = mm(((p.width - 0.03) / cols) * 0.86);
      out.push(range("key", C.keySize, key, 10, 19, "mm", { ...o, note: `The model's keys are ${r1(key)} mm wide (gloves need 15 mm, arctic mittens 19 mm).` }));
      out.push(range("slope", C.keySlope, 0, 0, 25, "°", { ...o, note: "The model's keyboard lies flat (0 to 15° preferred)." }));
      out.push(range("mouse-w", C.mouseSize, 60, 40, 70, "mm", { ...o, id: "mouse-width", note: "The model's mouse is 60 × 105 × 30 mm (length 70 to 120, height 25 to 40)." }));
      out.push(range("pointer", C.pointerLevel, 0.2, -2.5, 2.5, "cm", { ...o, note: "The mouse sits on the keyboard's surface, its top 2 mm above the home row." }));
      break;
    }
    case "hammer": case "wrench": case "screwdriver": case "drill": case "shovel": {
      out.push(res("tools", C.minimalTools, "input", { ...o, limit: "minimal tools, common hand tools only", note: "Note which tools the task needs; special tools should be avoided." }));
      if (obj.type === "screwdriver") out.push(res("knobs", C.knobsNotScrewdriver, "input", { ...o, limit: "knobs instead of screwdriver adjustments done more than monthly", note: "Enter how often the adjustment is made." }));
      if (obj.type === "wrench" || obj.type === "screwdriver") out.push(res("opening", C.toolAccess, "input", { ...o, limit: obj.type === "wrench" ? "access opening ≥ 270 × 200 mm (open-end), 135 × 155 (T-handle)" : "access opening ≥ 110 × 120 mm", note: "The opening the tool is used through (an equipment rack checks its bay against these)." }));
      if (obj.type === "drill" || obj.type === "shovel" || obj.type === "hammer") out.push(res("accommodation", C.accommodation, "input", { ...o, limit: "usable by the central 90 % of men and of women, in gloves where worn", note: "Check the grip with a small and a large hand (Profile tab)." }));
      break;
    }
    case "flashlight": out.push(res("flashlight", C.noFlashlight, "check", { ...o, limit: "adjustments do not require a flashlight", note: "If the task needs it, provide lighting in the work area instead." })); break;
    case "rifle": case "pistol": {
      out.push(res("population", C.smallArms, "input", { ...o, limit: "central 90 % (95 % preferred) of clothed and equipped men and women, in every firing position", note: "Check the firing postures with a small woman and a large man in body armour." }));
      out.push(res("surfaces", C.weaponSurfaces, "input", { ...o, limit: "smooth contact surfaces, no sharp edges, hot parts insulated", note: "A property of the real weapon." }));
      break;
    }
    case "binoculars": {
      out.push(res("ipd", C.binoIpd, "input", { ...o, limit: "eyepieces adjustable from 50 to 75 mm apart", note: "The model's eyepieces are fixed about 64 mm apart." }));
      out.push(res("mass", C.binoMass, "input", { ...o, limit: "at most 1.5 kg (1 kg preferred)", note: "Enter the mass of the binoculars." }));
      out.push(res("power", C.binoMag, "input", { ...o, limit: "at most 8 power when hand-held and unstabilized", note: "Enter the magnification." }));
      break;
    }
    case "radio_handset": out.push(res("accommodation", C.accommodation, "input", { ...o, limit: "usable by the central 90 % of men and of women, in gloves where worn", note: "MIL-STD-1472H gives no handset dimensions; check the grip with a small and a large hand." })); break;
    case "horizontal_bar": {
      out.push(range("height", C.gripOverheadStanding, cm(p.height), null, 181, "cm", { ...o, note: "Highest grasp of a standing user; a bar for hanging or pull-ups is not a control." }));
      out.push(range("dia", C.guardrailDia, mm(p.diameter), 37, 75, "mm", { ...o, soft: true, note: "Rail diameter for a power grasp (as a guardrail)." }));
      break;
    }
    // ---- reference objects: a statement, never a pass
    case "cube_1m": case "measuring_pole": case "point_marker": case "box": case "cylinder": case "floor_tile":
      out.push(res("na", NO_CLAUSE, "na", { ...o, limit: "", note: { cube_1m: "A reference cube for judging sizes.", measuring_pole: "A stadiometer for reading stature (ISO 7250-1 conventions).", point_marker: "A marker of a point in space.", box: "A plain shape: if it stands for equipment, a load or a workspace, use the matching catalogue object to get its requirements.", cylinder: "A plain shape: if it stands for equipment, a load or a workspace, use the matching catalogue object to get its requirements.", floor_tile: "A floor marking or mat." }[obj.type] }));
      break;
    default: break;
  }
  if (LOAD_TYPES.has(obj?.type)) {
    const m = p.mass;
    if (!fin(m) || m <= 0) out.push(res("mass", C.liftOne, "input", { ...o, limit: `at most ${LIFT.LC} kg for one lifter`, note: "Enter the mass of the load." }));
    else {
      const lifters = LIFT.team.findIndex((w) => m <= w) + 1;
      out.push(res("mass", C.liftOne, m <= LIFT.LC ? "pass" : "fail", { ...o, value: m, unit: "kg", limit: `at most ${LIFT.LC} kg for one lifter`, note: m <= LIFT.LC ? "Occasional lift with good handles; the hand position and frequency lower the limit (lift it in the scene to see)." : lifters ? `A team of ${lifters} (Table XLI), or a lifting aid.` : "Heavier than six lifters may lift: mechanical handling." }));
      if (m > LIFT.LC) out.push(res("label", C.weightLabel, "input", { ...o, limit: "weight and lift limitation on the item", note: "Label it with its weight and the number of lifters or the mechanical lift." }));
      if (m > 4.5 && obj.type !== "pallet") out.push(range("handles", C.handles, grips.length, 2, null, "", { ...o, limit: "2 handles (or a handle and a grasp area)", note: grips.length ? "" : "This object has no handle in the model." }));
      const need = HANDLE_DIA.find(([kg]) => m <= kg)?.[1];
      for (const g of grips.slice(0, 1)) if (fin(g.diameter)) out.push(range("handle-dia", C.handleDia, mm(g.diameter), need, null, "mm", { ...o, note: `For an item of ${m} kg.` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// the scene: interactions of the figure with objects. facts (plain data, metres, degrees):
// {
//   body: { label, percentile, sex },  stance: "standing" | "seated" | "kneeling" | "squatting" | "lying",  heading,
//   eye: [x, y, z], seatHeight (seat plane, m, when seated), feetGap (m, lowest sole point above its support, when seated),
//   seat: { id, name, type } | null,
//   holds: [{ objectId, name, type, gripId, label, side: "L" | "R", position: [x, y, z], mass? }],
//   displays: [{ id, name, type, centre, distance, declination, incidence, lateral (m from the body's mid-plane), diagonal (m) | null, inFront: bool }],
//   load: { objectId, name, mass, H, V, A, band, carrying } | null,
//   pointAbove: (y) => ...
// }
const STANCE_CTRL = { standing: ["ctrlStanding", 76, 188], kneeling: ["ctrlKneeling", 45.7, 145], squatting: ["ctrlSquatting", 36, 125] };
const STANCE_DISP = { standing: ["dispStanding", 104, 177.8], kneeling: ["dispKneeling", 71, 145], squatting: ["dispSquatting", 50.8, 125] };
const INDIVIDUAL = new Set(["monitor", "triple_monitor", "laptop", "tablet", "instrument_panel"]);

const CLEAR_MM = 300, NEAR_MM = 150; // the search radii of compliance.js (CLEAR_RADIUS around cabins and imported models, NEAR_RADIUS elsewhere)
const CONTROL_SIGHT = 1.3; // m: controls this close to the eye are the figure's own
const BONE_WORD = { head: "head", jaw: "jaw", eye: "eye", shoulder: "upper arm", elbow: "forearm", forearm: "forearm", wrist: "wrist", hip: "thigh", knee: "lower leg", ankle: "foot", mtp: "toes", clavicle: "shoulder", pelvis: "pelvis" };
const LANDMARK_WORD = (id) => {
  const m = /^([A-Za-z]+?)(\d*)(?:_([LR]))?$/.exec(String(id));
  const side = m?.[3] === "L" ? "left " : m?.[3] === "R" ? "right " : "";
  if (m && BONE_WORD[m[1]] && !m[2]) return `${side}${BONE_WORD[m[1]]}`;
  if (m && /^[LT]$/.test(m[1]) && m[2]) return m[1] === "L" ? "lower back" : "upper back";
  if (m && m[1] === "C" && m[2]) return "neck";
  return String(id).replace(/_([LR])$/, (x, s) => (s === "L" ? " (left)" : " (right)")).replace(/_/g, " ");
};
export function checkScene(facts) {
  const out = [], C = CLAUSES;
  if (!facts) return out;
  const seated = facts.stance === "seated", sh = facts.seatHeight ?? 0;
  // seated: the feet
  if (seated && facts.seat) {
    const S = subj("interaction", `sit:${facts.seat.id}`, `Sitting on ${facts.seat.name}`);
    if (fin(facts.feetGap)) out.push(res("feet", C.feetSupported, facts.feetGap <= 0.01 ? "pass" : "fail", { value: mm(facts.feetGap), unit: "mm", limit: "feet on the floor or a footrest", note: facts.feetGap <= 0.01 ? "" : "The feet hang above the floor: lower the seat or add a footrest (5.10.3.12.13).", subject: S }));
  }
  // hands on grips
  for (const g of facts.holds ?? []) {
    const S = subj("interaction", `grip:${g.objectId}:${g.gripId}:${g.side}`, `${g.side === "L" ? "Left" : "Right"} hand on ${g.name}: ${g.label}`);
    const y = g.position[1];
    if (CONTROL_TYPES.has(g.type)) {
      if (seated) out.push(range("ctrl-height", C.ctrlSeated, cm(y - sh), 15, 106.7, "cm", { subject: S, note: "Above the seat; precise, frequent or emergency controls 20.3 to 86 cm." }));
      else if (STANCE_CTRL[facts.stance]) { const [k, lo, hi] = STANCE_CTRL[facts.stance]; out.push(range("ctrl-height", C[k], cm(y), lo, hi, "cm", { subject: S, note: "Above the floor." })); }
    }
    if (seated) out.push(range("overhead", C.gripOverheadSeated, cm(y - sh), null, 106.7, "cm", { subject: S, note: "Height above the seat of a knob or handle gripped overhead." }));
    else if (facts.stance === "standing") out.push(range("overhead", C.gripOverheadStanding, cm(y), null, 181, "cm", { subject: S, note: "Height above the floor of a knob or handle gripped overhead." }));
  }
  // displays in front of the figure
  for (const d of facts.displays ?? []) {
    if (!d.inFront) continue;
    const S = subj("interaction", `view:${d.id}`, `Looking at ${d.name}`);
    if (d.type === "wall_display" && fin(d.diagonal) && d.diagonal > 0) {
      out.push(range("ratio", C.viewLarge, d.distance / d.diagonal, 2, 10, "× diagonal", { subject: S, value: d.distance / d.diagonal, note: `Viewing distance ${r0(cm(d.distance))} cm over a ${r0(cm(d.diagonal))} cm diagonal; 3 to 6 preferred.` }));
    } else if (d.type !== "hud_panel") {
      const v = cm(d.distance);
      out.push(range("view-min", C.viewMin, v, 33, null, "cm", { subject: S, note: v >= 50 ? "" : "50 cm preferred." }));
      if (seated && INDIVIDUAL.has(d.type)) out.push(range("view-max", C.viewMax, v, null, 70, "cm", { subject: S, note: "Seated user, display near its controls (76 cm from an ejection seat)." }));
    }
    if (fin(d.incidence)) out.push(range("face", C.displayFace, 90 - d.incidence, 45, null, "°", { subject: S, note: "Angle between the display face and the line of sight (90° preferred)." }));
    if (seated) {
      out.push(range("disp-height", C.dispSeated, cm(d.centre[1] - sh), 15.2, 111.8, "cm", { subject: S, note: "Display centre above the seat; precise reading 35.6 to 90 cm." }));
      if (fin(d.lateral) && INDIVIDUAL.has(d.type)) out.push(range("disp-lateral", C.dispLateral, cm(Math.abs(d.lateral)), null, 53, "cm", { subject: S, note: "From the user's centreline." }));
    } else if (STANCE_DISP[facts.stance]) {
      const [k, lo, hi] = STANCE_DISP[facts.stance];
      out.push(range("disp-height", C[k], cm(d.centre[1]), lo, hi, "cm", { subject: S, note: "Display centre above the floor." }));
    }
  }
  // head room above each seat inside a cabin (Figure 39)
  for (const c of facts.cabins ?? []) {
    if (!c.seats.length) {
      out.push(res("headroom", C.vHeadClear, "na", { subject: subj("interaction", `headroom:${c.id}`, `Head room in ${c.name}`, { objects: [c.id], covers: [{ objectId: c.id, id: "head" }] }),
        limit: "at least 1,070 mm from each seat's SRP to the roof", note: "No seat inside this cabin: put a seat in it to check the head room." }));
      continue;
    }
    for (const s of c.seats) {
      const S = subj("interaction", `headroom:${c.id}:${s.id}`, `Head room above ${s.name} in ${c.name}`, { objects: [c.id, s.id], covers: [{ objectId: c.id, id: "head" }] });
      if (s.clearance == null) out.push(res("headroom", C.vHeadClear, "pass", { subject: S, unit: "mm", limit: "at least 1,070 mm from the SRP to the roof", note: "Nothing above the seat inside the cabin (open roof)." }));
      else out.push(range("headroom", C.vHeadClear, mm(s.clearance), 1070, null, "mm", { subject: S, note: "Vertically from the seat reference point to the roof or canopy (Figure 39); a helmet does not change this dimension." }));
    }
  }
  // the figure's skin to the surfaces of the objects near it (5.6.2.2.1 to 5.6.2.2.4); a cabin or an imported model lists all four directions
  for (const e of facts.clearances ?? []) {
    if (!e.near) continue;
    const full = e.type === "cabin_shell" || e.type === "cad_model";
    const covers = full ? [{ objectId: e.id, id: e.type === "cabin_shell" ? "body-clearance" : "clearance" }] : [];
    const S = subj("interaction", `clear:${e.id}`, `Figure to ${e.name}`, { objects: [e.id], covers });
    const far = `Nothing within ${r0(full ? CLEAR_MM : NEAR_MM)} mm.`;
    const row = (key, clause, hits, what) => {
      if (!hits.length) { if (full) out.push(res(key, clause, "pass", { subject: S, unit: "mm", limit: "at least 50 mm", note: `${what}: ${far}` })); return; }
      const h = hits.reduce((a, b) => (b.distance < a.distance ? b : a));
      const where = `closest at the ${LANDMARK_WORD(h.landmark)}`;
      const note = h.distance < 0 ? `${what}: the body is INSIDE the object (the ${LANDMARK_WORD(h.landmark)}, ${r0(-mm(h.distance))} mm deep). Move the figure or the object.`
        : `${what}: ${where}. Measured to the bare skin: add the thickness of the clothing, helmet and equipment worn (5.6.1.5.1).${e.crew ? "" : " 5.6.2.2 is written for crew stations: elsewhere it is a guide (Check), but the body must never be inside an object."}`;
      out.push(range(key, clause, mm(h.distance), 50, null, "mm", { subject: S, soft: !e.crew && h.distance >= 0, note }));
    };
    row("head-clear", C.headImpact, e.hits.filter((h) => h.part === "head"), "Head");
    const body = e.hits.filter((h) => h.part === "body");
    row("fore-aft", C.clearFore, body.filter((h) => h.axis === "fore-aft"), "Body, fore-aft");
    row("lateral", C.clearLateral, body.filter((h) => h.axis === "lateral"), "Body, sideways");
    row("vertical", C.clearVertical, body.filter((h) => h.axis === "vertical"), "Body, vertical (contact with the floor and the seat not counted)");
  }
  // line of sight to the displays in front of the figure and to the controls within reach (Figure 2)
  for (const t of facts.sight?.targets ?? []) {
    const block = t.blockedBy ? `Hidden behind ${t.blockedBy.name} (${r0(cm(t.blockedBy.distance))} cm from the eye).` : "Nothing in the way (glass does not count).";
    if (t.kind === "display") {
      if (Math.abs(t.horiz) > 90) continue;
      const S = subj("interaction", `view:${t.id}`, `Looking at ${t.name}`);
      out.push(range("los-field", C.dispField, t.angle, null, 45, "°", { subject: S, note: `Off the normal line of sight (15° below the head's horizontal): ${r0(t.angle)}°, ${r0(Math.abs(t.horiz))}° ${t.horiz >= 0 ? "left" : "right"} and ${r0(Math.abs(t.vert))}° ${t.vert >= 0 ? "above" : "below"} the horizontal.` }));
      out.push(res("los-cone", C.warnCone, t.angle <= 15 ? "pass" : "input", { subject: S, value: t.angle, unit: "°", limit: "within 15° of the normal line of sight for warning, emergency and critical displays",
        note: t.angle <= 15 ? "Inside the 30° cone: fit for warnings and critical indicators (5.2.3.1.11)." : "Outside the 30° cone: acceptable only if the display shows no warnings or critical indicators." }));
      out.push(res("unobstructed", C.dispObstruct, t.blockedBy ? "fail" : "pass", { subject: S, limit: "a clear line from the eye to the display", note: block }));
      out.push(res("arm", C.armObscure, t.arm ? "fail" : "pass", { subject: S, limit: "the hands and arms clear of the line of sight", note: t.arm ? `The ${t.arm} is in the line of sight to the display.` : "The arms are clear of the line of sight." }));
    } else if (t.distance <= CONTROL_SIGHT) {
      const S = subj("interaction", `see:${t.id}`, `Seeing ${t.name}`);
      out.push(res("visible", C.ctrlVisible, t.blockedBy ? "fail" : "pass", { subject: S, value: t.angle, unit: "°", limit: "a clear line from the eye to the control", note: `${block} ${r0(t.angle)}° off the normal line of sight.` }));
    }
  }
  // desk to wall (Figure 58 D)
  for (const d of facts.desks ?? []) {
    const S = subj("interaction", `deskwall:${d.id}:${d.wallId}`, `${d.name} to ${d.wallName}`, { objects: [d.id, d.wallId], covers: [{ objectId: d.wallId, id: "desk-wall" }] });
    out.push(range("desk-wall", C.deskWall, cm(d.distance), 81, null, "cm", { subject: S, note: "From the desk's user edge to the wall behind the user (armrest to wall: at least 61 cm, Figure 58 E)." }));
  }
  for (const w of facts.walls ?? []) {
    if (w.desks) continue;
    out.push(res("desk-wall", C.deskWall, "na", { subject: subj("interaction", `deskwall:${w.id}`, `Desks facing ${w.name}`, { objects: [w.id], covers: [{ objectId: w.id, id: "desk-wall" }] }),
      limit: "at least 81 cm from a desk edge to the wall behind its user", note: `No desk has its user's back to this ${w.name.toLowerCase().includes("partition") ? "partition" : "wall"} within 3 m.` }));
  }
  // a load in the hands
  if (facts.load) out.push(...loadResults(facts.load, subj("interaction", `load:${facts.load.objectId}`, `Holding ${facts.load.name}`)));
  // the population rule: always listed, it needs the boundary bodies
  if (facts.body) {
    out.push(res("population", C.accommodation, "input", { subject: subj("population", "population", "Accommodation"), limit: "central 90 % (95 % preferred) of men AND of women", note: `Checked on ${facts.body.label}. Repeat with the small and the large boundary (for example a 5th percentile woman and a 95th percentile man) and with the clothing and equipment worn.` }));
  }
  return out;
}
