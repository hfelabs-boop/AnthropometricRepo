// Stub panel "Scene": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "scene",
  label: "Scene",
  order: 3,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Scene",
      blurb: "Add a cabin chair, displays, boxes and tools to the floor, move them with the gizmo and place the figure on a seat or at a control.",
      ctx,
      live: () => { return "Selection: " + (ctx.state.selection ? `${ctx.state.selection.kind} ${ctx.state.selection.id}` : "none") + ". Units: " + ctx.units + "."; },
    });
  },
};
