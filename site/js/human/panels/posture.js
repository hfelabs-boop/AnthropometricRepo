// Stub panel "Posture": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "posture",
  label: "Posture",
  order: 2,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Posture",
      blurb: "Pick one of the library postures or edit joint angles with range-of-motion limits, mirror left to right and pin hands and feet.",
      ctx,
      live: () => { const r = ctx.getRig(); return r ? `Model ready: ${r.bones.size} joints. Posture: ${ctx.state.posture.name}.` : "Waiting for the model."; },
    });
  },
};
