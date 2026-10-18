// Stub panel "Profile": proves the panel registry works (lazy import, mount with ctx, live updates). Replace the body of mount().
import { comingSoon } from "../ui.js";

export default {
  id: "profile",
  label: "Profile",
  order: 1,
  mount(container, ctx) {
    return comingSoon(container, {
      title: "Profile",
      blurb: "Choose a population, a real person from the database, an imported file or a manual stature and mass, then see how every dimension was measured, derived or estimated.",
      ctx,
      live: () => { const p = ctx.getProfile(); return p ? `Current profile: ${p.label}` : "No profile loaded yet."; },
    });
  },
};
