// Entry point of the Digital human tab: initHuman() -> controller { onShow(), onHide(), dispose(), ready }. Contract: docs/human3d/DESIGN.md 2.3b.
//
// This file is deliberately tiny and imports nothing heavy. The shell proper (shell.js, which pulls in three.js, the viewport and the rest) is
// loaded in the background: initHuman() resolves AT ONCE with a controller whose `ready` promise settles when the shell exists. The site's
// router awaits the controller of the tab it is leaving before it switches views, so an init that waited for a slow or stalled three.js download
// would freeze every tab switch until the download ended.
//   * onShow / onHide are remembered until the shell exists and then forwarded; a tab left while loading starts inactive and does no work.
//   * A failure to load shell.js or one of its static imports (three.js, viewport.js, ...) shows a message with Retry in the section. The
//     browser caches a failed module import for the life of the page and a query string cannot reach the static imports of the module, so
//     Retry reloads the page (the address, #/human, is kept). Any other failure (the shell throwing while it builds) retries in place.
import { h } from "../util.js";

let current = null; // the controller of the attempt in progress or finished

/** Start (or return) the tab in #view-human. Idempotent; rejects only when the page lacks the section. Never waits for the 3D code. */
export function initHuman() {
  const host = document.getElementById("view-human");
  if (!host) return Promise.reject(new Error("The Digital human section (#view-human) is missing from the page."));
  if (current && !host.querySelector(".hm-root")) { current.dispose(); current = null; } // someone replaced the section's content
  if (!current) current = start(host);
  return Promise.resolve(current);
}

/** Tear the tab down completely (viewport, rig, listeners). For tests and for a future "reload the 3D module" action. */
export function disposeHuman() {
  const c = current;
  current = null;
  c?.dispose();
}

const msgOf = (e) => String(e?.message ?? e ?? "unknown error").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200);

function start(host) {
  let disposed = false, wantShown = !host.hidden, inner = null, slowTimer = 0;
  const hint = h("span", {}, "Loading the 3D module…");
  const placeholder = h("div", { class: "hm-root", dataset: { hmState: "loading" } }, h("div", { class: "loading", role: "status" }, h("div", { class: "spinner" }), hint));
  host.replaceChildren(placeholder);
  slowTimer = setTimeout(() => { hint.textContent = "Still loading the 3D module… this can take a while on a slow connection. You can use the other tabs meanwhile."; }, 10000);

  const controller = {
    ready: null,
    get shell() { return inner; },
    onShow() { wantShown = true; inner?.onShow(); },
    onHide() { wantShown = false; inner?.onHide(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(slowTimer);
      if (current === controller) current = null;
      const c = inner;
      inner = null;
      if (c) c.dispose(); else if (placeholder.isConnected) host.replaceChildren();
    },
  };

  async function load() {
    let mod;
    try { mod = await import("./shell.js"); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { hmGraph: true }); }
    if (disposed) return null;
    const shell = await mod.createShell();
    clearTimeout(slowTimer);
    if (disposed) { shell.dispose(); return null; }
    inner = shell;
    // onShow / onHide that arrived while the shell was being built
    if (wantShown && !shell.shown) shell.onShow(); else if (!wantShown && shell.shown) shell.onHide();
    return controller;
  }

  controller.ready = load().catch((e) => {
    clearTimeout(slowTimer);
    if (current === controller) current = null; // the next initHuman() starts a fresh attempt
    if (!disposed) {
      console.error("Digital human: the 3D module could not start:", e);
      showError(host, e);
    }
    throw e;
  });
  controller.ready.catch(() => {}); // the error is shown in the page; nobody has to await `ready` for it to count as handled
  return controller;
}

function showError(host, e) {
  const reload = !!e?.hmGraph;
  const retry = () => { if (reload) location.reload(); else initHuman(); };
  host.replaceChildren(h("div", { class: "hm-root", dataset: { hmState: "error" } },
    h("div", { class: "notice error", role: "alert" }, `Could not load the 3D module: ${msgOf(e)}${reload ? ". Check your connection and try again." : ""}`),
    h("button", { type: "button", class: "btn", style: { marginTop: "8px" }, onclick: retry }, reload ? "Retry (reloads the page)" : "Retry")));
}
