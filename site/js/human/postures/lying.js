// Posture group "Lying". Covers the POSTURES.md category "Lying": supine, prone, on the left side, on the right side, fetal, supine with
// knees up, prone with head up, on a mechanic's creeper under a vehicle, supine with arms overhead, prone with arms forward, semi-reclined
// with legs raised. Support "body": the pelvis root lays the figure down (flex -90 = supine, +90 = prone, lat +-90 = on a side) and
// placement puts the lowest points of the body on the floor.
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors:
// docs/human3d/POSTURES.md and POSE.md. Their `category` must be "Lying"; the usual support here is "body".
// Empty for now: later engineers fill this array; tests/human3d/postures.test.mjs validates every entry on six bodies.
export default [];
