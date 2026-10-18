// Posture group "Sitting". Covers the POSTURES.md category "Sitting": seated upright 90-90-90 (ISO 7250), relaxed office, lumbar-supported
// (back rest 100 deg), reclined 105 / 115 / 125 / 135 deg, slumped, leaning forward to a desk (forearms on the desk), on the edge of the
// seat, perched on a high stool, legs crossed at the knee, legs crossed at the ankle, legs extended forward, long-sitting on the floor,
// cross-legged on the floor, kneeling-sitting on the heels (seiza), side-sitting on the floor, low squat-sitting, elbows on knees, bench
// with arms along the back rest, typing, mouse use, reading a tablet, reaching forward to a control panel. Driving belongs to vehicle.js.
// Supports: "seat+feet" with hints.seat.height "popliteal", "seat" with the feet off the floor (hints.seat.height 0 = sitting on the floor),
// "knees" for seiza.
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors:
// docs/human3d/POSTURES.md and POSE.md. Their `category` must be "Sitting"; the usual support here is "seat+feet".
// Empty for now: later engineers fill this array; tests/human3d/postures.test.mjs validates every entry on six bodies.
export default [];
