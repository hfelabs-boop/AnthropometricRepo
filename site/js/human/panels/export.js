// Stub panel "Export": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "export",
  label: "Export",
  order: 7,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Export",
      blurb: "Save the model and posture as GLB, BVH, CSV, JSON or a PNG screenshot.",
      ctx,
      live: () => { const p = ctx.getProfile(); return p ? `Ready to export ${p.label}.` : "Nothing to export yet."; },
    });
  },
};
