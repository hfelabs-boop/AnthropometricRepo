// Stub panel "Analysis": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "analysis",
  label: "Analysis",
  order: 6,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Analysis",
      blurb: "Check reach, visual angles, joint ranges used by the current posture and the centre of mass.",
      ctx,
      live: () => { const r = ctx.getRig(); if (!r) return "Waiting for the model."; const c = r.centerOfMass(); return `Whole-body mass ${c.mass.toFixed(1)} kg.`; },
    });
  },
};
