// Stub panel "Skeleton": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "skeleton",
  label: "Skeleton",
  order: 5,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Skeleton",
      blurb: "Browse the 77 joints and their ranges of motion, and show bones, joint markers, labels and landmarks on the model.",
      ctx,
      live: () => { const d = ctx.state.display; return `Display: skin ${d.skin ? "on" : "off"}, skeleton ${d.skeleton ? "on" : "off"}, joints ${d.joints ? "on" : "off"}.`; },
    });
  },
};
