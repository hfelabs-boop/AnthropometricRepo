// Digital human tab: the shell proper. Layout (panel tabs | 3D view with toolbars | inspector, status bar), state store, build pipeline
// profile -> fitBody -> buildRig -> viewport, selection, keyboard, theme and visibility handling. Contract: docs/human3d/DESIGN.md 2.3b.
// Everything else is a module this file loads lazily: fit.js, rig.js, synthetic.js, body.js (skin) and panels/<id>.js.
// index.js is the tiny entry point the site imports; it loads THIS file (and with it three.js, ~700 kB) in the background, so that leaving the
// tab while the download is still running never waits for it.
//
// PANELS. panels/<id>.js (id: profile, posture, scene, measure, skeleton, analysis, export) exports
//   default { id, label, order, mount(container, ctx) -> { onShow?(), onHide?(), dispose?() } | void }
// mount() runs once, the first time the tab is opened, into a container of its own inside the tab panel (the shell's "Loading …" spinner sits next to it
// until mount() has settled); the container stays mounted (hidden) while another tab is active. ctx.inspector(node) content is mounted once and never re-inserted
// (pose events do not touch it), so a slider or field inside it keeps its focus while it drives the pose. onShow / onHide
// follow the tab AND the whole Digital human view (leaving for another site tab hides the active panel). A missing file shows "Coming soon",
// a file that fails to load or mount shows an error with Retry. ctx (one per panel):
//   state            plain object, read-only for panels: profile, body, rig, selection, units, display, posture, theme, quality, busy, notices
//   viewport         the Viewport of viewport.js (scene, camera, pick, project, attachGizmo, addLabelSource, on("click") ...)
//   getRig() getBody() getProfile()          current rig / BodyModel / Profile (null until the first build has finished)
//   setProfile(profile, { immediate }) -> Promise<{ ok, fallback }>   debounced (150 ms) unless immediate; rebuild() re-runs the current one
//   on(event, fn) -> off      events: profile(profile) body(body) rig(rig: the NEW rig, the old one is disposed afterwards) pose({ rig }, after
//                              every rig.setPose) selection({kind, id} | null) display({...flags}) units("mm"|"cm"|"in") theme({ dark })
//                              posture({ id, name }) quality("high"|"low") busy(bool) notices([...]);  emit(event, data) for your own
//   units, fmt(mm, { digits, suffix }), setUnits(u)                  display units and formatting (the model itself is metres)
//   select({ kind: "joint" | "object" | "landmark" | "handle", id } | null)    the one selection of the tab (joint -> rig.select)
//   inspector(node | string | null, { title })   content for the right-hand inspector while THIS panel's tab is active
//   setDisplay({ skin, skeleton, joints, labels, landmarks, com, xray, grid }), setView(name), frame(), setQuality(q), setPosture({ id, name })
//                      state.display.xray is the user's own choice; while the skin is on and skeleton or joints is on, the rig is told xray = true as well
//                      (markers and bones are depth-tested, an opaque skin would hide them and make them unpickable), see impliedXray in state.js
//   toast(text), notify(text, { level: "info" | "warn" | "error", id }), dismiss(id), requestRender()
// Viewport clicks: a panel that wants a click calls viewport.on("click", ev) and sets ev.handled = true; unhandled clicks clear the selection.
// When a new rig replaces the old one (profile change) the shell carries the angles and root over and keeps a grounded figure on the floor;
// a panel that places the figure (seat, ...) should do it again on "rig".
import * as THREE from "three";
import { h, toast, download } from "../util.js";
import { createViewport, VIEW_ORDER, VIEW_PRESETS } from "./viewport.js";
import { createStore, createPipeline, loadDefaultProfile, withTimeout, loadPrefs, savePrefs, prefsDisplay, impliedXray, LENGTH_UNITS, SKIN_STYLES } from "./state.js";
import { chipButton, segmented, roving, tablist, notice, emptyState, icon, fmtLength, UNIT_LABEL } from "./ui.js";
import { JOINT_BY_ID, BONE_BY_ID, GROUPS } from "./skeleton.js";

const CSS_URL = new URL("../../human.css", import.meta.url).href;

const PANELS = [
  { id: "profile", label: "Profile" }, { id: "posture", label: "Posture" }, { id: "scene", label: "Scene" }, { id: "measure", label: "Measure" },
  { id: "skeleton", label: "Skeleton" }, { id: "analysis", label: "Analysis" }, { id: "export", label: "Export" },
];

const DISPLAY_TOGGLES = [
  ["skin", "Skin", "Show the skin surface"],
  ["skeleton", "Skeleton", "Show the bones (the skin turns see-through while they are shown)"],
  ["joints", "Joints", "Show joint markers (colour = degrees of freedom); click one to select it. The skin turns see-through while they are shown"],
  ["labels", "Labels", "Name the joints and landmarks that are shown"],
  ["landmarks", "Landmarks", "Show anthropometric landmarks (acromion, olecranon, stylion, ...)"],
  ["com", "Centre of mass", "Show the whole-body centre of mass and its floor projection"],
  ["xray", "X-ray", "See through the skin"],
  ["grid", "Grid", "Show the floor grid (1 m and 0.1 m) and the axes"],
];

const MODEL_NOTES = [
  "Rigid links: the skeleton is a set of rigid segments between approximate joint centres, estimated from external measurements. Real joint centres differ by a few centimetres.",
  "Ranges of motion are rounded textbook values for healthy adults, widened in places so that deep squats and floor sitting can be shown. They are not clinical limits.",
  "The realistic skin is the Blender Studio Human Base Mesh (CC0) of the body's sex, rigged to this skeleton and scaled to the body's segment lengths, girths, head, hand and foot sizes. Its shape between the measured sections is that one person's, not the profile's; the Mannequin switch shows the shape built from the fitted sections alone.",
  "There is no soft-tissue model: the skin follows the bones but does not compress, bulge or fold, so contact with seats and objects is approximate.",
  "There is no strength, fatigue, comfort or injury model. This is a visualisation for design studies, not a safety or certification tool.",
  "Population profiles are boundary cases: a P95 body takes the 95th percentile of every measure on its own, which no real person has. Measures a survey does not publish are estimated from stature and mass and are marked as estimated.",
];

const HELP = [
  ["Keyboard", [
    [["1", "…", "6"], "Front, back, left, right, top and iso view"],
    [["F"], "Fit the figure in the view"], [["Esc"], "Clear the selection, or close this help"], [["?"], "Show or hide this help"],
    [["Arrows"], "Pan the camera (while the 3D view is focused)"], [["Shift", "Arrows"], "Orbit the camera"], [["+"], "Zoom in (also = and Page Up)"], [["−"], "Zoom out (also Page Down)"],
  ]],
  ["Mouse", [
    [["Drag"], "Orbit around the figure"], [["Right-drag"], "Pan (also Shift + drag)"], [["Wheel"], "Zoom (at the zoom limit it scrolls the page)"], [["Click"], "Select a joint marker (turn Joints on)"], [["Double-click"], "Fit the figure in the view"],
  ]],
  ["Touch", [[["One finger"], "Orbit"], [["Two fingers"], "Pan and pinch to zoom"], [["Tap"], "Select a joint marker"]]],
];

const isTyping = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const msg = (e) => String(e?.message ?? e ?? "unknown error").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 200); // no trailing full stop: it is quoted inside "(...)." sentences
const formOf = (p) => (p?.sex === "F" ? "female" : p?.sex === "M" ? "male" : "neutral");

/**
 * Inject human.css and wait (briefly) for it, so the viewport is created with its final size and theme. Resolves true when the sheet is
 * there (or still on its way after 4 s) and false when the request failed. A failure is NOT remembered: the dead link is dropped and the
 * next call asks again, so a transient network error cannot leave the tab unstyled for the whole session.
 */
function ensureStyles() {
  let link = document.querySelector("link[data-hm-css]");
  if (link?.dataset.hmFailed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-css": "" });
    link.onerror = () => { link.dataset.hmFailed = "1"; }; // a property, not a listener: it lives as long as the page and must not count as a leak
    document.head.append(link);
  }
  return new Promise((resolve) => {
    if (link.sheet) return resolve(true);
    if (link.dataset.hmFailed) return resolve(false);
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(!link.dataset.hmFailed), 4000);
  });
}

/**
 * Build the tab into #view-human and resolve with its controller { onShow(), onHide(), dispose(), shown }. If anything throws halfway, undo what
 * was done so that a retry starts clean (no stray listeners, no half-built DOM). Called by index.js, once per attempt.
 */
export async function createShell() {
  const undo = [];
  try { return await build(undo); } catch (e) {
    for (const f of undo.reverse()) { try { f(); } catch (e2) { console.error(e2); } }
    throw e;
  }
}

async function build(undo) {
  const host = document.getElementById("view-human");
  if (!host) throw new Error("The Digital human section (#view-human) is missing from the page.");
  const styled = await ensureStyles();

  const store = createStore({ prefs: loadPrefs() });
  const { state } = store;
  const disposers = [];
  undo.push(() => { for (const f of disposers) f(); });
  let disposed = false, shown = !host.hidden, framedHeight = 0, unsubPose = null, helpOpen = false, activeTab = null, skeletonAuto = false, autoDisplay = false, autoShown = null, stylesOk = styled, needsFrame = false, busyTimer = 0;
  const mqDark = matchMedia("(prefers-color-scheme: dark)");

  // ---- DOM skeleton ---------------------------------------------------------------------------------------------------
  const notesList = h("ul", {}, MODEL_NOTES.map((t) => h("li", {}, t)));
  const hero = h("div", { class: "hm-hero" },
    h("h1", {}, "Digital human"),
    h("p", {}, "Turn a survey population or a single person into a posable 3D mannequin, place it among simple cabin and workstation objects, and measure distances, all in your browser."),
    h("details", { class: "hm-notes" }, h("summary", {}, "Model notes"), notesList));

  const tabs = tablist({ label: "Digital human tools", tabs: PANELS, selected: PANELS[0].id, onSelect: (id) => showPanel(id), idPrefix: "hm-tab" });
  const panelsEl = h("div", { class: "hm-panels" });
  const left = h("aside", { class: "hm-left panel", "aria-label": "Tools" }, tabs.el, panelsEl);

  const viewportEl = h("div", { class: "hm-viewport-host" });
  // the ergonomic verdict of the figure, next to the model (set by the Posture panel through ctx.setVerdict)
  const verdictBadge = h("div", { class: "hm-verdict", hidden: true, role: "status", "aria-label": "Posture verdict" });
  viewportEl.append(verdictBadge);
  const viewBtns = VIEW_ORDER.map((name, i) => h("button", { type: "button", title: `${VIEW_PRESETS[name].title} (${i + 1})`, dataset: { view: name }, onclick: () => setView(name) }, VIEW_PRESETS[name].label));
  const viewSeg = h("div", { class: "seg hm-seg", role: "group", "aria-label": "View presets" }, viewBtns);
  const fitBtn = chipButton({ label: "Fit", title: "Fit the figure in the view (F)", icon: "fit", onClick: () => frameFigure(true) });
  const unitsSeg = segmented({ label: "Display units", options: LENGTH_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u], title: `Show lengths in ${{ mm: "millimetres", cm: "centimetres", in: "inches" }[u]}` })), value: state.units, onChange: (u) => ctx.setUnits(u) });
  const shotBtn = chipButton({ title: "Save the current view as a PNG image", ariaLabel: "Save a screenshot", icon: "camera", onClick: screenshot });
  const helpBtn = chipButton({ title: "Keyboard and mouse help (?)", ariaLabel: "Keyboard and mouse help", icon: "help", onClick: () => toggleHelp() });
  helpBtn.setAttribute("aria-haspopup", "dialog");
  helpBtn.setAttribute("aria-expanded", "false");
  const toggleBtns = {};
  for (const [key, label, title] of DISPLAY_TOGGLES) {
    toggleBtns[key] = chipButton({ label, title, toggle: true, pressed: state.display[key], onClick: () => ctx.setDisplay({ [key]: !state.display[key] }) });
  }
  const styleSeg = segmented({ label: "Skin style", value: state.skinStyle, onChange: (v) => ctx.setSkinStyle(v), options: [
    { value: "realistic", label: "Realistic", title: "A realistic body (Blender Studio Human Base Meshes, CC0) fitted to the profile's measurements" },
    { value: "mannequin", label: "Mannequin", title: "The procedural mannequin, built from the fitted body's sections" },
  ] });
  const viewGroup = h("div", { class: "hm-group", role: "toolbar", "aria-label": "Camera view" }, viewSeg, fitBtn);
  const toolGroup = h("div", { class: "hm-group", role: "toolbar", "aria-label": "Units and tools" }, unitsSeg.el, shotBtn, helpBtn);
  const dispGroup = h("div", { class: "hm-group", role: "toolbar", "aria-label": "Display options" }, Object.values(toggleBtns), styleSeg.el);
  const [, , dispRoving] = [viewGroup, toolGroup, dispGroup].map((g) => roving(g, { selector: "button" }));
  const busyText = h("span", {}, "Building the model…");
  const busyEl = h("div", { class: "hm-busy", role: "status", hidden: true }, h("div", {}, h("div", { class: "spinner" }), busyText));
  const helpEl = h("div", { class: "hm-help", role: "dialog", "aria-label": "Keyboard and mouse help", hidden: true, tabindex: "-1" },
    h("button", { type: "button", class: "hm-help-x", title: "Close this help (Esc)", "aria-label": "Close the help", onclick: () => toggleHelp(false) }, icon("close", 14)),
    h("h2", {}, "Keyboard and mouse"),
    HELP.map(([title, rows]) => [h("h3", {}, title), h("dl", {}, rows.map(([keys, text]) => [
      h("dt", {}, keys.map((k, i) => [i ? (k === "…" || keys[i - 1] === "…" ? " " : " + ") : "", k === "…" ? "to" : h("kbd", { class: "hm-kbd" }, k)])), h("dd", {}, text)]))]),
    h("p", { class: "small muted", style: { marginTop: "10px" } }, "Shortcuts are ignored while you type in a field."));
  const noticesEl = h("div", { class: "hm-notices", "aria-live": "polite", "aria-label": "Messages" });
  const stage = h("div", { class: "hm-stage" },
    h("div", { class: "hm-bar hm-bar-top" }, viewGroup, toolGroup), noticesEl, viewportEl, h("div", { class: "hm-bar hm-bar-bottom" }, dispGroup), busyEl, helpEl);
  const stat = (name, cls = "") => { const v = h("span", {}); return { el: h("span", { class: `hm-stat ${cls}`.trim() }, h("span", {}, name), v), v }; };
  const stProfile = stat("Profile", "hm-stat-grow"), stPosture = stat("Posture"), stSel = stat("Selection"), stUnits = stat("Units");
  const qualityBtn = h("button", { type: "button", class: "hm-quality", title: "Quality: switch between high and low (pixel ratio, shadows and mesh detail)", onclick: () => ctx.setQuality(state.quality === "high" ? "low" : "high") });
  // the WebGL text may be ellipsised in a narrow cell; the quality button is a flex item of its own so it is never clipped
  const stGL = h("span", { class: "hm-stat hm-stat-gl" }, h("span", {}, "Graphics"), h("span", { class: "hm-gl" }), h("span", { class: "hm-dot", "aria-hidden": "true" }, "·"), qualityBtn);
  const status = h("div", { class: "hm-status", role: "status", "aria-live": "polite", "aria-label": "Status" }, stProfile.el, stPosture.el, stSel.el, stUnits.el, stGL);
  const center = h("div", { class: "hm-center" }, h("div", { class: "hm-card" }, stage, status));

  const inspTitle = h("h2", { id: "hm-inspector-title" }, "Inspector");
  const inspBody = h("div", { class: "hm-inspector-body", id: "hm-inspector-body" });
  const inspToggle = h("button", { type: "button", class: "hm-inspector-x", "aria-controls": "hm-inspector-body", onclick: () => setInspectorOpen(app.dataset.inspector === "closed") });
  const inspector = h("aside", { class: "hm-inspector panel", "aria-label": "Inspector" }, h("div", { class: "hm-inspector-head" }, inspTitle, inspToggle), inspBody);

  const app = h("div", { class: "hm-app", dataset: { inspector: matchMedia("(max-width: 899px)").matches ? "closed" : "open" } }, left, center, inspector);
  const rootEl = h("div", { class: "hm-root", dataset: { hmState: "loading" } }, hero, app);
  host.replaceChildren(rootEl);
  undo.push(() => host.replaceChildren());

  // ---- viewport ---------------------------------------------------------------------------------------------------------
  const viewport = createViewport(viewportEl, { quality: state.quality });
  undo.push(() => viewport.dispose());
  if (!state.qualityChoice && viewport.info().software) { state.quality = "low"; viewport.setQuality("low"); } // software GL: keep it responsive
  viewport.setGrid(state.display.grid);
  // the rig decides what to label (its own `labels` flag; the DOF arrows of a selected joint are always named): importance 0..2 -> priority
  viewport.addLabelSource("rig", () => (state.rig?.labelAnchors?.() ?? []).map((a) => ({
    id: a.id, text: a.text, position: a.position, color: a.color, title: a.detail, cls: `hm-label-${a.kind ?? "joint"}`,
    priority: a.id === state.selection?.id ? 110 : Math.round((a.importance ?? 0.3) * 50), // 110: the selected joint's name is placed before its (pinned) DOF labels
  })));
  // the selected joint / landmark is always named (the rig only labels joints when its Labels flag is on, and never landmarks that are not shown)
  viewport.addLabelSource("selection", () => {
    const sel = state.selection, rig = state.rig;
    if (!sel || !rig || (sel.kind === "joint" && state.display.labels)) return [];
    try {
      if (sel.kind === "joint" && JOINT_BY_ID[sel.id]) return [{ id: sel.id, text: JOINT_BY_ID[sel.id].label, position: rig.jointWorld(sel.id), priority: 110 }];
      if (sel.kind === "landmark") return [{ id: sel.id, text: rig.body?.landmarks?.[sel.id]?.label ?? sel.id, position: rig.landmarkWorld(sel.id), priority: 110 }];
    } catch { /* the selection does not exist in this rig */ }
    return [];
  });
  viewport.setPickTargets(() => (state.rig?.skin ? [state.rig.skin] : []));
  viewport.setCursor("grab");
  const tip = h("div", { class: "hm-tip", hidden: true, role: "presentation" });
  viewport.overlay.append(tip);

  // ---- context handed to the panels -------------------------------------------------------------------------------------
  const inspectorBy = new Map();
  function makeCtx(panelId) {
    return {
      panelId, state, viewport,
      getRig: () => state.rig, getBody: () => state.body, getProfile: () => state.profile,
      setProfile: (p, o) => pipeline.setProfile(p, o),
      rebuild: () => pipeline.rebuild(),
      on: (evt, fn) => store.on(evt, fn),
      emit: (evt, data) => store.emit(evt, data),
      get units() { return state.units; },
      setUnits(u) { store.setUnits(u); },
      fmt: (mm, o) => fmtLength(mm, state.units, o),
      setDisplay(partial) { store.setDisplay(partial); },
      setSkinStyle(v) { if (v !== state.skinStyle && SKIN_STYLES.includes(v)) { state.skinStyle = v; styleSeg.set(v); store.emit("skinStyle", v); pipeline.rebuild(); } },
      setQuality(q) { if (q !== state.quality) { state.quality = state.qualityChoice = q; viewport.setQuality(q); store.emit("quality", q); pipeline.rebuild(); } },
      setView, frame: frameFigure,
      setVerdict(v) { if (state.postureVerdict !== v) { state.postureVerdict = v ?? null; store.emit("verdict", state.postureVerdict); } },
      setPosture({ id = null, name }) { state.posture = { id, name: String(name || "Custom posture") }; store.emit("posture", state.posture); },
      select: (sel) => select(sel),
      toast: (m) => toast(m),
      notify: (text, { level = "info", id } = {}) => store.addNotice({ id, level, text }),
      dismiss: (id) => store.dismissNotice(id),
      requestRender: () => viewport.requestRender(),
      /** Show `content` (Node, string or null) in the inspector while this panel's tab is active. */
      inspector(content, { title } = {}) { inspectorBy.set(panelId, content == null ? null : { content, title }); if (activeTab === panelId) renderInspector(); },
    };
  }
  const ctx = makeCtx("shell");

  // ---- build pipeline -----------------------------------------------------------------------------------------------------
  // The browser remembers a module that failed to load, for good: importing the same URL again after the network is back fails again. A retry
  // therefore asks for the module under a new query string (fine for these modules: their own static imports are loaded already). The module that
  // finally loaded is kept, so there is only ever one instance of it.
  const modules = new Map(), attempts = new Map();
  async function loadModule(name) {
    if (modules.has(name)) return modules.get(name);
    const n = attempts.get(name) ?? 0;
    attempts.set(name, n + 1);
    const url = new URL(n ? `./${name}.js?retry=${n}` : `./${name}.js`, import.meta.url).href;
    let m;
    try { m = await import(url); } catch (e) { if (e && typeof e === "object") e.hmUrl = url; throw e; }
    modules.set(name, m);
    return m;
  }
  /** True when the server answered 404 for `url`. The resource timing entry tells (no second request, so no second console error); HEAD is the fallback. */
  async function isMissing(url) {
    const st = performance.getEntriesByName(url).map((e) => e.responseStatus).filter((v) => typeof v === "number" && v > 0).pop();
    if (st != null) return st === 404 || st === 410;
    return fetch(url, { method: "HEAD", cache: "no-store" }).then((r) => r.status === 404 || r.status === 410, () => false);
  }
  // The skin generator is optional: while body.js does not exist the rig shows the skeleton only. A body.js that exists but is broken is a bug that
  // must not hide: it is logged and shown. A failed import is "missing" only when the module could not be fetched AND the server said 404 for it
  // (a fetch error also comes from a body.js whose own imports are broken, or from a network failure).
  let skinMissing = false, skinProblem = null;
  const fetchFailure = (e) => e instanceof TypeError && /fetch|import|module script/i.test(e.message);
  async function loadMannequin() {
    if (skinMissing) return undefined;
    try {
      const m = await loadModule("body");
      if (typeof m.buildSkin !== "function") throw new TypeError("body.js does not export buildSkin()");
      store.dismissNotice("skin");
      return m.buildSkin; // called by the rig as (body, bones, { quality })
    } catch (e) {
      if (fetchFailure(e) && e.hmUrl && await isMissing(e.hmUrl)) { skinMissing = true; return undefined; }
      if (skinProblem !== msg(e)) console.error("Digital human: the skin generator (body.js) failed to load:", e);
      skinProblem = msg(e);
      store.addNotice({ id: "skin", level: "warn", text: `The skin surface could not be loaded (${skinProblem}). Showing the skeleton only.` });
      return undefined;
    }
  }
  // The realistic skin needs realskin.js and the mesh of the body's sex (about 1.3 MB, fetched once). When either fails the mannequin is shown instead,
  // with a notice; the next build tries again.
  async function loadSkinBuilder(body) {
    if (state.skinStyle === "realistic") {
      try {
        const m = await loadModule("realskin");
        const asset = await m.loadRealSkin(m.skinSexOf(body));
        store.dismissNotice("realskin");
        const fallback = await loadMannequin();
        return (b, bones, opts) => {
          try { return m.buildRealSkin(asset, b, bones, opts); } catch (e) {
            if (!fallback) throw e;
            console.warn("Digital human: the realistic skin does not fit this body, showing the mannequin:", e);
            return fallback(b, bones, opts); // a body without the landmarks or sections the fitting reads (a generic body, an import)
          }
        };
      } catch (e) {
        console.warn("Digital human: the realistic skin could not be loaded, showing the mannequin:", e);
        store.addNotice({ id: "realskin", level: "warn", text: `The realistic skin could not be loaded (${msg(e)}). Showing the mannequin instead.` });
      }
    } else store.dismissNotice("realskin");
    return loadMannequin();
  }
  const deps = {
    async fit(profile) {
      const m = await loadModule("fit").catch(() => { throw new Error("the fitting module (fit.js) is not available"); });
      return m.fitBody(profile, { form: profile?.form ?? formOf(profile), overrides: profile?.overrides });
    },
    async synthetic(profile) {
      const m = await loadModule("synthetic").catch(() => { throw new Error("the generic body (synthetic.js) is not available"); });
      const mm = profile?.measures?.stature?.value;
      return m.syntheticBody(Number.isFinite(mm) ? mm / 1000 : 1.75, profile?.form ?? formOf(profile));
    },
    async buildRig(body, { quality }) {
      const m = await loadModule("rig").catch(() => { throw new Error("the rig module (rig.js) is not available"); });
      return m.buildRig(body, { skinBuilder: await loadSkinBuilder(body), skeleton: true, quality });
    },
    async swap(rig, previous) {
      let pose = null, grounded = false, lift = 0;
      try {
        pose = previous?.getPose?.() ?? null;
        grounded = !!pose && Math.abs(previous.lowestY?.() ?? 1) < 2e-3; // standing on the floor: stay on it, whatever the new stature
        lift = pose && Number.isFinite(previous.restRootY) ? pose.root.y - previous.restRootY : 0; // otherwise keep the height above the rest pose
      } catch { pose = null; }
      // The previous figure stays in the scene, with its pose subscription, until the new one is completely in place: if anything below throws, the
      // stage must not be left blank (the pipeline keeps the previous rig as the current one).
      viewport.add(rig.group);
      let unsub = null;
      try {
        if (!rig.skin && !skeletonAuto) { // no skin to look at: show the bones and joint markers (once, not remembered) so the tab is never empty
          skeletonAuto = autoDisplay = true;
          autoShown = { skeleton: state.display.skeleton, joints: state.display.joints }; // what to remember if the user never touches them
          try { store.setDisplay({ skeleton: true, joints: true }); } finally { autoDisplay = false; }
        }
        applyDisplay(rig);
        if (rig.skinError) store.addNotice({ id: "skin", level: "warn", text: `The skin surface could not be built (${msg(rig.skinError)}). Showing the skeleton only.` });
        if (pose) {
          try {
            if (Number.isFinite(rig.restRootY)) pose.root.y = rig.restRootY + lift;
            rig.setPose(pose);
            const low = rig.lowestY?.();
            if (grounded && Number.isFinite(low) && Math.abs(low) > 1e-6) rig.setRoot({ y: rig.root.y - low });
          } catch (e) { console.warn("Digital human: the previous pose does not fit the new body:", e); }
        }
        unsub = rig.onChange?.(() => { store.emit("pose", { rig }); viewport.requestRender(); }) ?? null;
        if (state.selection?.kind === "joint") { try { rig.select?.(state.selection.id); } catch { /* unknown joint in this rig */ } }
        // frame the first figure, and again when the new one is clearly taller or shorter; otherwise keep the user's camera
        const box = figureBox(rig), hgt = box.max.y - box.min.y, first = !framedHeight;
        if (!shown) needsFrame = true; // built while the tab is hidden: the view has no size yet, frame it when it is shown
        else if (first || Math.abs(hgt - framedHeight) / framedHeight > 0.08) { framedHeight = hgt; viewport.frame(box, { animate: !first, margin: 1.3 }); }
      } catch (e) {
        unsub?.();
        viewport.remove(rig.group);
        applyDisplay(previous);
        throw e;
      }
      unsubPose?.();
      unsubPose = unsub;
      if (previous?.group) viewport.remove(previous.group);
      viewport.requestRender();
    },
  };
  const pipeline = createPipeline(store, deps);
  undo.push(() => pipeline.dispose());

  function figureBox(rig = state.rig) {
    const fallback = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.45), new THREE.Vector3(0.5, 1.8, 0.45));
    if (!rig?.group) return fallback;
    try {
      rig.group.updateWorldMatrix(true, true);
      const b = new THREE.Box3().setFromObject(rig.group), s = b.getSize(new THREE.Vector3());
      if (b.isEmpty() || !(s.y > 0.5 && s.y < 3.5 && s.x < 4 && s.z < 4)) return fallback;
      return b.expandByPoint(new THREE.Vector3(-0.35, b.min.y, -0.35)).expandByPoint(new THREE.Vector3(0.35, b.max.y, 0.35));
    } catch { return fallback; }
  }
  function frameFigure(animate = true) { return viewport.frame(figureBox(), { animate, margin: 1.3 }); }
  function setView(name) { return viewport.setView(name); }

  // ---- display, units, selection --------------------------------------------------------------------------------------------
  function applyDisplay(rig = state.rig) {
    const d = state.display;
    viewport.setGrid(d.grid);
    const noSkin = !!rig && !rig.skin; // no skin generator in this build: the rig keeps `skin` false whatever is asked
    // bones and markers behind an opaque skin cannot be seen, hovered or clicked: showing them makes the skin see-through (X-ray, pressed and locked)
    const implied = !d.xray && impliedXray({ skin: d.skin && !noSkin, skeleton: d.skeleton, joints: d.joints });
    try { rig?.setDisplay?.({ skin: d.skin, skeleton: d.skeleton, joints: d.joints, labels: d.labels, landmarks: d.landmarks, com: d.com, xray: d.xray || implied }); } catch (e) { console.error("Digital human: setDisplay failed:", e); }
    for (const [k, b] of Object.entries(toggleBtns)) b.setPressed(k === "skin" && noSkin ? false : k === "xray" ? d.xray || implied : !!d[k]);
    toggleBtns.skin.disabled = noSkin;
    toggleBtns.xray.disabled = implied;
    toggleBtns.xray.title = implied ? "On while the bones or joint markers are shown, which would be hidden behind the skin otherwise" : DISPLAY_TOGGLES.find((t) => t[0] === "xray")[2];
    dispRoving.refresh();
    toggleBtns.skin.title = noSkin ? "The skin surface is not available in this build, so only the skeleton is shown" : DISPLAY_TOGGLES[0][2];
    viewport.requestRender();
  }
  /** Why a selection cannot exist (null when it is fine): a joint or landmark that is not part of the rig would show an inspector about nothing. */
  function selectionProblem(sel) {
    if (!sel) return null;
    if (sel.kind === "joint" && !JOINT_BY_ID[sel.id]) return `there is no joint "${sel.id}"`;
    const lms = state.rig?.body?.landmarks; // without a rig yet there is nothing to check a landmark against
    if (sel.kind === "landmark" && lms && !(sel.id in lms)) return `there is no landmark "${sel.id}" on this body`;
    return null;
  }
  function select(sel) {
    let changed;
    try {
      const problem = selectionProblem(sel);
      if (problem) { console.warn(`Digital human: select() ignored: ${problem}`); return false; }
      changed = store.select(sel);
    } catch (e) { console.error(e); return false; }
    return changed;
  }
  store.on("selection", (sel) => {
    try { state.rig?.select?.(sel?.kind === "joint" ? sel.id : null); } catch (e) { console.warn("Digital human: the rig cannot select", sel, e); }
    updateStatus();
    renderInspector();
    viewport.requestRender();
  });
  // The flags the shell switched on by itself are not the user's choice: until the user touches one it is saved as it was (see prefsDisplay).
  const persist = () => savePrefs({ ...state, display: prefsDisplay(state.display, autoShown) });
  store.on("display", () => {
    if (autoShown) for (const k of Object.keys(autoShown)) if (!state.display[k]) delete autoShown[k]; // switched off by the user: theirs from now on
    applyDisplay();
    if (!autoDisplay) persist();
  });
  store.on("units", (u) => { unitsSeg.set(u); updateStatus(); renderInspector(); persist(); });
  store.on("quality", () => { updateStatus(); persist(); });
  store.on("skinStyle", () => persist());
  store.on("profile", () => updateStatus());
  store.on("posture", () => updateStatus());
  store.on("verdict", () => updateStatus());
  store.on("verdict", () => {
    const v = state.postureVerdict, t = { "not-acceptable": "Not acceptable (ISO 11226)", check: "Check posture", acceptable: "Acceptable" }[v];
    verdictBadge.hidden = !t; verdictBadge.textContent = t ?? ""; verdictBadge.dataset.verdict = v ?? "";
  });
  store.on("rig", () => { rootEl.dataset.hmState = "ready"; updateStatus(); renderInspector(); });
  // a panel's own inspector content is left alone on pose events: it may hold the slider being dragged that causes them
  store.on("pose", () => { if (state.selection && !inspectorBy.get(activeTab)) renderInspector(); });
  store.on("busy", (b) => { // the spinner shows at once while there is no figure yet, after a short delay when one is being replaced (no flicker)
    clearTimeout(busyTimer);
    busyText.textContent = state.profile ? "Building the model…" : "Loading the profile…";
    if (!b) busyEl.hidden = true;
    else { if (!state.rig) rootEl.dataset.hmState = "loading"; busyTimer = setTimeout(() => { busyEl.hidden = false; }, state.rig ? 300 : 0); }
  });
  store.on("notices", renderNotices);

  // ---- viewport interaction ---------------------------------------------------------------------------------------------------
  const offVp = [
    viewport.on("click", (ev) => {
      const rig = state.rig;
      if (!rig) return;
      const ray = viewport.ray(ev.clientX, ev.clientY);
      let id = rig.pickJoint?.(ray)?.id ?? null;
      if (!id && state.display.skeleton) id = BONE_BY_ID[rig.pickBone?.(ray)?.id]?.joint ?? null; // a bone selects the joint that moves it
      if (id) { ev.handled = true; select({ kind: "joint", id }); }
    }),
    viewport.on("click-unhandled", () => { if (state.selection) select(null); }),
    viewport.on("dblclick", () => frameFigure(true)),
    viewport.on("pointermove", (ev) => scheduleHover(ev)),
    viewport.on("pointerleave", () => { hoverEv = null; setHover(null); }),
    viewport.on("pointerdown", () => { hoverEv = null; setHover(null); viewport.setCursor("grabbing"); }),
    viewport.on("pointerup", () => viewport.setCursor("grab")),
    viewport.on("context-restored", () => { updateStatus(); if (state.rig) rootEl.dataset.hmState = "ready"; }),
    viewport.on("context-lost", () => updateStatus()),
  ];
  let hoverEv = null, hoverRaf = 0, hoverId = null;
  function scheduleHover(ev) {
    if (ev.buttons || ev.pointerType === "touch") return; // dragging (orbit) or a finger: no hover
    hoverEv = ev;
    if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
  }
  function runHover() {
    hoverRaf = 0;
    const ev = hoverEv, rig = state.rig;
    if (!ev || !rig || !shown || !state.display.joints || !rig.pickJoint) return setHover(null);
    const hit = rig.pickJoint(viewport.ray(ev.clientX, ev.clientY));
    setHover(hit?.id ?? null, ev);
  }
  function setHover(id, ev) {
    if (id !== hoverId) {
      hoverId = id;
      try { state.rig?.highlight?.(id); } catch { /* rig without highlight */ }
      viewport.setCursor(id ? "pointer" : "grab");
      viewport.requestRender();
    }
    if (id && ev) {
      tip.textContent = JOINT_BY_ID[id]?.label ?? id;
      tip.hidden = false;
      // beside the pointer, flipped to its other side near the right / bottom edge (the overlay clips what sticks out)
      const w = tip.offsetWidth, hgt = tip.offsetHeight, vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
      let x = ev.x + 10, y = ev.y + 12;
      if (x + w > vw - 4) x = ev.x - 10 - w;
      if (y + hgt > vh - 4) y = ev.y - 12 - hgt;
      tip.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(Math.max(4, y))}px)`;
      tip.style.left = tip.style.top = "0";
    } else tip.hidden = true;
  }

  // ---- panels ---------------------------------------------------------------------------------------------------------------
  const mounted = new Map(); // id -> { body, api, ctx }
  const panelBody = (id) => h("div", { class: "hm-panel-body", role: "tabpanel", id: tabs.panelId(id), "aria-labelledby": tabs.tabId(id), hidden: true, tabindex: "-1" });
  for (const p of PANELS) {
    const m = { body: panelBody(p.id), api: null, ctx: null, tried: false };
    mounted.set(p.id, m);
    panelsEl.append(m.body);
  }

  async function mountPanel(id) {
    const m = mounted.get(id);
    if (m.tried) return;
    m.tried = true;
    const loading = h("div", { class: "loading" }, h("div", { class: "spinner" }), `Loading ${PANELS.find((p) => p.id === id).label}…`);
    m.body.replaceChildren(loading);
    let mod;
    // a module that failed once stays failed in the browser's module map: a retry needs a URL of its own
    const url = `./panels/${id}.js${(m.attempts = (m.attempts ?? 0) + 1) > 1 ? `?retry=${m.attempts}` : ""}`;
    try { mod = await import(url); } catch (e) {
      if (disposed) return;
      // a panel that does not exist yet is "coming soon"; one that exists but fails to load is a bug worth showing
      const exists = await fetch(new URL(`./panels/${id}.js`, import.meta.url), { method: "HEAD", cache: "no-store" }).then((r) => r.ok, () => false);
      if (disposed) return;
      if (exists) { showPanelError(id, m, e, "load"); return; }
      m.body.replaceChildren(comingSoonBox(id, e));
      return;
    }
    if (disposed) return;
    const def = mod.default;
    try {
      m.ctx = makeCtx(id);
      // the panel gets a host of its own and the spinner stays until mount() has settled (a slow or never-settling mount shows it, not a blank body)
      const host = h("div", { class: "hm-panel-host" });
      m.body.replaceChildren(loading, host);
      const api = (await def.mount(host, m.ctx)) ?? {};
      if (disposed) { try { api.dispose?.(); } catch (e) { console.error(e); } return; } // the tab was torn down while mount() was pending: nobody else will free it
      m.api = api;
      loading.remove();
      if (activeTab === id && shown) m.api.onShow?.();
    } catch (e) {
      showPanelError(id, m, e, "start");
    }
  }
  function showPanelError(id, m, e, what) {
    console.error(`Digital human: panel "${id}" failed to ${what}:`, e);
    m.api = null;
    m.body.replaceChildren(notice(`The ${PANELS.find((p) => p.id === id).label} panel could not ${what} (${msg(e)}).`, { level: "error" }),
      h("button", { type: "button", class: "btn", style: { marginTop: "8px" }, onclick: () => { m.tried = false; mountPanel(id); } }, "Retry"));
  }
  function comingSoonBox(id, err) {
    const label = PANELS.find((p) => p.id === id).label;
    return h("div", { class: "hm-soon" }, h("h2", { class: "hm-panel-title" }, label), emptyState("Coming soon", `The ${label} tools are not available in this build yet.`),
      err ? h("details", { class: "small muted" }, h("summary", {}, "Technical detail"), h("p", {}, msg(err))) : null);
  }
  function showPanel(id) {
    if (activeTab === id) return;
    if (activeTab) { const prev = mounted.get(activeTab); prev.body.hidden = true; if (shown) prev.api?.onHide?.(); }
    activeTab = id;
    const m = mounted.get(id);
    m.body.hidden = false;
    if (!m.tried) mountPanel(id); else if (shown) m.api?.onShow?.();
    renderInspector();
  }

  // ---- inspector ----------------------------------------------------------------------------------------------------------------
  function setInspectorOpen(open) {
    app.dataset.inspector = open ? "open" : "closed";
    inspToggle.setAttribute("aria-expanded", open ? "true" : "false");
    inspToggle.textContent = open ? "Hide" : "Inspector";
    inspToggle.title = open ? "Hide the inspector" : "Show the inspector";
    window.setTimeout(() => viewport.resize(), 0); // the stage changes width
  }
  function defaultInspector() {
    const sel = state.selection, rig = state.rig;
    if (!sel) return { title: "Inspector", node: emptyState("Nothing selected.", "Turn on Joints, then click a joint marker in the 3D view. Panels show their details here too.") };
    if (sel.kind === "joint" && JOINT_BY_ID[sel.id]) {
      const j = JOINT_BY_ID[sel.id], a = rig?.angles?.[sel.id] ?? [];
      const rows = [["Group", GROUPS.find((g) => g.id === j.group)?.label ?? j.group], ["Parent", j.parent ? JOINT_BY_ID[j.parent]?.label ?? j.parent : "World"]];
      const deg = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(v % 1 ? 1 : 0)}°`; // a real minus sign, one decimal only when needed
      j.dof.forEach((d, i) => rows.push([d.label, `${deg(a[i] ?? 0)} (range ${deg(Math.round(d.min))} to ${deg(Math.round(d.max))})`]));
      return { title: j.label, node: kv(rows) };
    }
    if (sel.kind === "landmark") {
      const lm = rig?.body?.landmarks?.[sel.id], rows = [];
      if (lm?.group) rows.push(["Group", lm.group]);
      try {
        const p = rig?.landmarkWorld?.(sel.id, new THREE.Vector3());
        if (p) rows.push(["Position (x, y, z)", [p.x, p.y, p.z].map((v) => fmtLength(v * 1000, state.units, { suffix: false })).join(", ") + " " + UNIT_LABEL[state.units]]);
      } catch { /* landmark not in this rig */ }
      return { title: lm?.label ?? sel.id, node: kv(rows) };
    }
    return { title: `Selected ${sel.kind}`, node: kv([["Id", sel.id]]) };
  }
  const kv = (rows) => h("dl", { class: "hm-kv" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  let inspText = null; // the string last shown (a panel can hand the inspector plain text)
  function renderInspector() {
    const own = inspectorBy.get(activeTab);
    const { title, node } = own ? { title: own.title ?? "Inspector", node: own.content } : defaultInspector();
    if (inspTitle.textContent !== title) inspTitle.textContent = title;
    if (node instanceof Node) {
      // already mounted: re-inserting would blur the focused control inside and cancel a pointer drag on its slider
      if (inspBody.childNodes.length !== 1 || inspBody.firstChild !== node) inspBody.replaceChildren(node);
      inspText = null;
    } else {
      const text = String(node ?? "");
      if (inspText !== text || inspBody.childNodes.length !== 1) inspBody.replaceChildren(h("p", {}, text));
      inspText = text;
    }
  }

  // ---- status bar and notices ----------------------------------------------------------------------------------------------------------
  function updateStatus() {
    const p = state.profile, sel = state.selection;
    stProfile.v.textContent = stProfile.v.title = p ? p.label : "loading…";
    const v = state.postureVerdict, vt = { "not-acceptable": " · not acceptable (ISO 11226)", check: " · check posture", acceptable: " · acceptable" }[v] ?? "";
    stPosture.v.textContent = state.posture.name + vt;   // the ergonomic verdict of the figure, next to the model (see panels/posture.js)
    stPosture.v.dataset.verdict = v ?? "";
    const selText = !sel ? "none" : sel.kind === "joint" ? JOINT_BY_ID[sel.id]?.label ?? sel.id : `${sel.kind} ${sel.id}`;
    stSel.v.textContent = stSel.v.title = selText;
    stUnits.v.textContent = UNIT_LABEL[state.units];
    const info = viewport.info();
    const gl = stGL.querySelector(".hm-gl");
    gl.textContent = info.failed ? "WebGL unavailable" : `WebGL ${info.webgl}`;
    gl.title = (info.renderer || "graphics adapter unknown") + (info.software ? " (software rendering)" : "");
    qualityBtn.textContent = state.quality;
    qualityBtn.setAttribute("aria-label", `Quality: ${state.quality}. Press to switch.`);
  }
  function renderNotices() {
    const actions = {
      retry: { label: "Retry", onClick: () => { store.dismissNotice("build"); pipeline.rebuild(); } },
      start: { label: "Retry", onClick: () => { store.dismissNotice("default-profile"); startDefaultProfile(); } },
      styles: { label: "Retry", onClick: () => retryStyles() },
    };
    noticesEl.replaceChildren(...state.notices.map((n) => notice(n.text, { level: n.level, id: n.id, onDismiss: () => store.dismissNotice(n.id), action: actions[n.action] })));
    if (state.notices.some((n) => n.level === "error") && !state.rig) rootEl.dataset.hmState = "error";
  }

  // ---- help, screenshot, keyboard -----------------------------------------------------------------------------------------------------------
  function toggleHelp(open = !helpOpen) {
    const had = helpEl.contains(document.activeElement); // read before hiding: a hidden element no longer holds the focus
    helpOpen = open;
    helpEl.hidden = !open;
    helpBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) helpEl.focus(); else if (had) helpBtn.focus();
  }
  async function screenshot() {
    const url = viewport.screenshot();
    if (!url) return toast("The 3D view is not available, so there is nothing to save.");
    const blob = await (await fetch(url)).blob();
    download(`digital-human-${(state.profile?.id || "figure").replace(/[^\w.-]+/g, "_")}.png`, blob);
    toast("Screenshot saved");
  }
  function onKeyDown(e) {
    if (!shown || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const k = e.key;
    if (/^[1-6]$/.test(k)) { setView(VIEW_ORDER[Number(k) - 1]); e.preventDefault(); }
    else if (k === "f" || k === "F") { frameFigure(true); e.preventDefault(); }
    else if (k === "?") { toggleHelp(); e.preventDefault(); }
    else if (k === "Escape") {
      if (helpOpen) { toggleHelp(false); e.preventDefault(); } else if (state.selection) { select(null); e.preventDefault(); }
    }
  }
  function onDocPointerDown(e) { if (helpOpen && !helpEl.contains(e.target) && !helpBtn.contains(e.target)) toggleHelp(false); }
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  disposers.push(() => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("pointerdown", onDocPointerDown, true); });

  // ---- theme ---------------------------------------------------------------------------------------------------------------------------------
  function onTheme() {
    if (disposed) return;
    const t = viewport.setTheme();
    state.theme = { dark: !!t?.dark };
    store.emit("theme", state.theme);
  }
  const mo = new MutationObserver(onTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  mqDark.addEventListener?.("change", onTheme);
  disposers.push(() => { mo.disconnect(); mqDark.removeEventListener?.("change", onTheme); });
  state.theme = { dark: !!viewport.theme?.dark };

  // ---- styles that failed to load, and the toolbar fade ---------------------------------------------------------------------------------
  // human.css is the only thing that lays the tab out. If its request failed the shell still works (plainly), says so, and asks again on Retry and
  // whenever the tab is shown again, so that a transient network error does not last the whole session.
  const stylesNotice = () => store.addNotice({ id: "styles", level: "warn", action: "styles", text: "The styles of this tab could not be loaded, so it looks plain. Check your connection and retry." });
  let stylesBusy = false;
  async function retryStyles() {
    if (stylesBusy || disposed) return;
    stylesBusy = true;
    try { stylesOk = await ensureStyles(); } finally { stylesBusy = false; }
    if (disposed) return;
    if (stylesOk) { store.dismissNotice("styles"); viewport.setTheme(); viewport.resize(); updateFades(); } else stylesNotice();
  }
  // In the stacked toolbar layout (narrow stage) a bar scrolls sideways and fades out at its right edge, but only while something is hidden there:
  // a bar that fits shows its last button at full strength, a faded button looks disabled.
  const bars = [...stage.querySelectorAll(".hm-bar")];
  function updateFades() { for (const b of bars) { const more = b.scrollWidth - b.clientWidth - b.scrollLeft > 1; if (more !== (b.dataset.more === "end")) { if (more) b.dataset.more = "end"; else delete b.dataset.more; } } }
  for (const b of bars) { b.addEventListener("scroll", updateFades, { passive: true }); disposers.push(() => b.removeEventListener("scroll", updateFades)); }
  if (typeof ResizeObserver !== "undefined") {
    const fadeRO = new ResizeObserver(updateFades);
    for (const b of bars) { fadeRO.observe(b); for (const g of b.children) fadeRO.observe(g); }
    disposers.push(() => fadeRO.disconnect());
  }

  // ---- go --------------------------------------------------------------------------------------------------------------------------------------
  setInspectorOpen(app.dataset.inspector !== "closed");
  applyDisplay(null);
  updateStatus();
  renderNotices();
  renderInspector();
  // ?panel=<id> in the address selects that panel (the top navigation's "Postures" link uses ?panel=posture); the hash is followed while open.
  const panelFromHash = () => { const id = new URLSearchParams(location.hash.split("?")[1] ?? "").get("panel"); return PANELS.some((p) => p.id === id) ? id : null; };
  tabs.select(panelFromHash() ?? PANELS[0].id);
  const onHashPanel = () => { const id = panelFromHash(); if (id && id !== activeTab && !disposed) tabs.select(id); };
  window.addEventListener("hashchange", onHashPanel);
  disposers.push(() => window.removeEventListener("hashchange", onHashPanel));
  if (!stylesOk) stylesNotice();
  updateFades();
  if (!shown) viewport.setActive(false);
  if (viewport.failed) { rootEl.dataset.hmState = "error"; }

  function startDefaultProfile() {
    return (async () => {
      if (state.profile) return;
      store.setBusy(true); // "Loading the profile…" at once: a slow or stalled request must not look like an empty stage
      let started = false;
      try {
        const anthro = await withTimeout(loadModule("anthro"), 8000, "the profile module");
        const { profile, notice: note } = await loadDefaultProfile(anthro);
        if (disposed || state.profile) return;
        if (note) store.addNotice({ id: "default-profile", level: "warn", text: note });
        started = true; // the pipeline owns the busy flag from here
        pipeline.setProfile(profile, { immediate: true });
      } finally {
        if (!started && !pipeline.pending) store.setBusy(false);
      }
    })().catch((e) => store.addNotice({ id: "default-profile", level: "error", action: "start", text: `The default profile could not be loaded (${msg(e)}).` }));
  }
  startDefaultProfile();

  if (/debug/.test(location.hash) || (() => { try { return !!localStorage.getItem("hm-debug"); } catch { return false; } })()) window.__human = { viewport, ctx, store, pipeline, state };

  const controller = {
    get shown() { return shown; },
    onShow() {
      if (disposed) return;
      shown = true;
      viewport.setActive(true);
      viewport.resize();
      updateFades();
      if (!stylesOk) retryStyles();
      if (needsFrame && state.rig) { needsFrame = false; const b = figureBox(); framedHeight = b.max.y - b.min.y; viewport.frame(b, { animate: false, margin: 1.3 }); }
      viewport.requestRender();
      mounted.get(activeTab)?.api?.onShow?.();
    },
    onHide() {
      if (disposed) return;
      shown = false;
      hoverEv = null;
      if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
      toggleHelp(false);
      viewport.setActive(false);
      mounted.get(activeTab)?.api?.onHide?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pipeline.dispose();
      clearTimeout(busyTimer);
      for (const f of offVp) f();
      unsubPose?.();
      for (const m of mounted.values()) { try { m.api?.dispose?.(); } catch (e) { console.error(e); } }
      for (const f of disposers) f();
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      const rig = state.rig;
      viewport.dispose();
      try { rig?.dispose?.(); } catch (e) { console.error(e); }
      state.rig = null;
      host.replaceChildren();
      if (window.__human?.viewport === viewport) delete window.__human;
    },
  };
  return controller;
}
