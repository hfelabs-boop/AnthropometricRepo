// Stub panel "Measure": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "measure",
  label: "Measure",
  order: 4,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Measure",
      blurb: "Measure distances between points, landmarks and scene anchors, angles and heights above the floor, live while things move.",
      ctx,
      live: () => { const r = ctx.getRig(); return r ? `${r.landmarkIds.length} landmarks available to measure.` : "Waiting for the model."; },
    });
  },
};
