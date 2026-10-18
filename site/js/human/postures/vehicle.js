// Posture group "Vehicle & cockpit". Covers the POSTURES.md category "Vehicle and cockpit": driver hands 10-and-2, relaxed driver,
// accelerator, left foot on the clutch, brake reach, seat-belt reach, mirror adjustment (arm up), door opening reach, entry (leg in), exit
// (step out), cockpit stick-and-throttle, looking over the shoulder, reclined tank driver, turret gunner standing, rear bench passenger.
// Sources: SAE J826, Reed et al. driver posture. The seat plane is hints.seat.height (the sandbox cabin chair places the figure on the real
// seat).
// Each entry is a Posture (typedef in ../pose.js, DESIGN.md 2.4); ../postures.js collects the 13 groups. Rules and checklist for authors:
// docs/human3d/POSTURES.md and POSE.md. Their `category` must be "Vehicle & cockpit"; the usual support here is "seat+feet".
// Empty for now: later engineers fill this array; tests/human3d/postures.test.mjs validates every entry on six bodies.
export default [];
