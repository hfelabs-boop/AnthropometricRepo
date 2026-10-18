// Digital human tab: placeholder until the module is built (see docs/human3d/DESIGN.md).
import { h } from "../util.js";

export function initHuman() {
  const root = document.getElementById("view-human");
  root.replaceChildren(h("div", { class: "hero" }, h("h1", {}, "Digital human"), h("p", {}, "Under construction.")));
  return { onShow() {}, onHide() {} };
}
