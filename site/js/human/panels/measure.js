// Measure panel of the Digital human tab: distances, heights above the floor, angles and display viewing checks between points of the figure (landmarks,
// joint centres, skin) and of the sandbox objects (anchors, corners, any surface), live while things move. The logic is measure.js; this file is the DOM.
// Two ways to measure: click points in the 3D view (they snap to joints, landmarks when shown, anchors and box corners), or choose two (three) points by name
// from searchable lists ("eye point" to "display centre", "palm" to a control, "ischial point" to a pedal). Values follow the display units of the tab; exports are
// always millimetres and degrees. The selected measurement is described in the inspector (or under the list on a narrow layout), like the Scene panel does.
import { h, download, toast } from "../../util.js";
import { section, segmented, chipButton, emptyState, notice, nextId, fmtLength, UNIT_LABEL } from "../ui.js";
import { LENGTH_UNITS } from "../state.js";
import { acquireSandbox, releaseSandbox } from "../sandbox.js";
import { acquireMeasure, releaseMeasure, formatDeltas, formatResult, fmtM, DASH, VIEW_NOTE, VIEW_ZONE, COLOR_TOKENS } from "../measure.js";
import { ensureSceneStyles, svgIcon, iconButton, copyText, createDock } from "./scene.js";

const KIND_OPTIONS = [
  ["distance", "Distance between two points"], ["height", "Height of a point above the floor"], ["angle", "Angle at a point (three points)"], ["view", "Viewing check: eye to a display"],
];
const TOKEN_NAMES = { accent: "Blue", bad: "Red", good: "Green", text: "Black / white" };
const HINTS = {
  off: "Choose a tool, then click points in the 3D view. Points snap to joints, anchors and the corners and middles of boxes; show the landmarks to snap to those too.",
  distance: ["Click the first point.", "Click the second point."], height: ["Click a point to read its height above the floor."], angle: ["Click the first point.", "Click the vertex, the corner of the angle.", "Click the third point."],
};

export default {
  id: "measure",
  label: "Measure",
  order: 4,
  async mount(host, ctx) {
    await ensureSceneStyles();
    const sandbox = acquireSandbox(ctx), measure = acquireMeasure(ctx);
    const offs = [], rows = new Map(); // item id -> { row, name, val, sub, sw, dot }
    const on = (evt, fn) => offs.push(ctx.on(evt, fn));
    const ids = { kind: nextId("hm-ms-kind"), dl: nextId("hm-ms-points") };
    const unit = () => ctx.units;
    const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const say = (t) => { live.textContent = ""; setTimeout(() => { live.textContent = t; }, 30); };
    const num = (v) => fmtLength(v * 1000, unit(), { suffix: false });
    const coords = (p) => (p ? `${[p.x, p.y, p.z].map(num).join(", ")} ${UNIT_LABEL[unit()]}` : DASH);

    // ---- units -------------------------------------------------------------------------------------------------------
    const unitsSeg = segmented({ label: "Display units", value: ctx.units, options: LENGTH_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u], title: `Show lengths in ${{ mm: "millimetres", cm: "centimetres", in: "inches" }[u]}` })), onChange: (u) => ctx.setUnits(u) });

    // ---- picking tools in the 3D view ---------------------------------------------------------------------------------------
    const hint = h("p", { class: "small muted hm-ms-hint", role: "status", "aria-live": "polite" });
    const tools = {
      distance: chipButton({ label: "Distance", toggle: true, title: "Click two points in the 3D view", onClick: () => toggleTool("distance") }),
      height: chipButton({ label: "Height", toggle: true, title: "Click a point to read its height above the floor", onClick: () => toggleTool("height") }),
      angle: chipButton({ label: "Angle", toggle: true, title: "Click three points: the angle is at the second", onClick: () => toggleTool("angle") }),
    };
    for (const b of Object.values(tools)) b.prepend(svgIcon("ruler", 14));
    const landmarksBtn = chipButton({ label: "Show landmarks", toggle: true, pressed: !!ctx.state.display?.landmarks, title: "Show the anthropometric landmarks, so that clicks can snap to them", onClick: () => ctx.setDisplay({ landmarks: !ctx.state.display.landmarks }) });
    function toggleTool(t) { measure.setTool(measure.tool === t ? "off" : t); }
    function syncTool() {
      for (const [k, b] of Object.entries(tools)) b.setPressed(measure.tool === k);
      const h2 = HINTS[measure.tool], text = measure.tool === "off" ? HINTS.off : `${h2[Math.min(measure.pending.length, h2.length - 1)]} Esc cancels.`;
      if (hint.textContent !== text) hint.textContent = text; // a live region: say it once, when it changes
    }

    // ---- measure between points chosen from lists -------------------------------------------------------------------------------
    const datalist = h("datalist", { id: ids.dl });
    const kindSel = h("select", { class: "input", id: ids.kind, "aria-label": "What to measure" }, KIND_OPTIONS.map(([v, l]) => h("option", { value: v }, l)));
    const fieldsEl = h("div", { class: "hm-sc-stack" });
    const formErr = h("p", { class: "hm-ms-err small", role: "alert", hidden: true });
    let form = null; // { kind, inputs: [...], display?: select }
    function refreshOptions() { datalist.replaceChildren(...measure.pointOptions().map((o) => h("option", { value: o.text }))); }
    function pointInput(label, value = "") {
      const input = h("input", { type: "text", class: "input", id: nextId("hm-ms-pt"), list: ids.dl, autocomplete: "off", spellcheck: "false", placeholder: "Type to search, e.g. eye, elbow, screen", value });
      input.addEventListener("focus", refreshOptions);
      return { input, el: h("div", { class: "field" }, h("label", { for: input.id }, label), input) };
    }
    function eyeDefault() { const o = measure.pointOptions().find((x) => x.ref.kind === "landmark" && x.ref.id === "eye_mid"); return o?.text ?? ""; }
    const displayNodes = (opts) => (opts.length ? opts.map((o) => h("option", { value: o.key }, o.label)) : [h("option", { value: "" }, "No display in the scene")]);
    // The displays in the scene change when objects come and go; the eye point the user typed must stay. So the display list is updated in place.
    function syncDisplays() {
      if (form?.kind !== "view") return;
      const opts = measure.displayOptions(), keep = form.display.value, same = opts.length === form.options.length && opts.every((o, i) => o.key === form.options[i].key && o.label === form.options[i].label);
      form.options = opts;
      if (same) return;
      form.display.replaceChildren(...displayNodes(opts));
      if (opts.some((o) => o.key === keep)) form.display.value = keep;
      form.noDisplay.hidden = opts.length > 0;
    }
    function renderForm() {
      const kind = kindSel.value;
      formErr.hidden = true;
      if (kind === "view") {
        const eye = pointInput("Eye point", eyeDefault()), opts = measure.displayOptions();
        const sel = h("select", { class: "input", id: nextId("hm-ms-disp"), "aria-label": "Display to look at" }, displayNodes(opts));
        const noDisplay = h("p", { class: "small muted" }, "Add a monitor, tablet, laptop, wall display, HUD or instrument panel in the Scene tab first.");
        noDisplay.hidden = opts.length > 0;
        form = { kind, inputs: [eye.input], display: sel, options: opts, noDisplay };
        fieldsEl.replaceChildren(eye.el, h("div", { class: "field" }, h("label", { for: sel.id }, "Display point"), sel), noDisplay, h("p", { class: "small muted" }, VIEW_NOTE));
      } else {
        const labels = kind === "distance" ? ["From", "To"] : kind === "height" ? ["Point"] : ["First point", "Vertex (the corner of the angle)", "Third point"];
        const fs = labels.map((l) => pointInput(l));
        form = { kind, inputs: fs.map((f) => f.input) };
        fieldsEl.replaceChildren(...fs.map((f) => f.el), h("p", { class: "small muted" }, "Points are landmarks and joint centres of the figure, and the anchors of the objects in the scene."));
      }
      refreshOptions();
    }
    function addFromForm() {
      formErr.hidden = true;
      const fail = (m) => { formErr.textContent = m; formErr.hidden = false; };
      let item = null;
      if (form.kind === "view") {
        const eye = measure.matchPoint(form.inputs[0].value), disp = form.options.find((o) => o.key === form.display.value);
        if (!eye) return fail(`“${form.inputs[0].value}” is not a point in the lists. Start typing and pick one of the suggestions.`);
        if (!disp) return fail("There is no display in the scene to look at.");
        item = measure.addView(disp.ref, eye.ref);
      } else {
        const refs = [];
        for (const input of form.inputs) {
          const m = measure.matchPoint(input.value);
          if (!m) return fail(input.value.trim() ? `“${input.value}” is not a point in the lists. Start typing and pick one of the suggestions.` : "Choose every point first: start typing and pick one of the suggestions.");
          refs.push(m.ref);
        }
        item = form.kind === "distance" ? measure.addDistance(refs[0], refs[1]) : form.kind === "height" ? measure.addHeight(refs[0]) : measure.addAngle(refs[0], refs[1], refs[2]);
      }
      if (!item) return fail("The measurement could not be added (at most 200 are kept).");
      measure.select(item.id);
      say(`${item.label} added: ${measure.format(measure.evaluate(item))}.`);
    }
    kindSel.addEventListener("change", renderForm);
    const addBtn = h("button", { type: "button", class: "btn primary", onclick: addFromForm }, svgIcon("plus", 14), "Add measurement");
    const listBody = h("div", { class: "hm-sc-stack" }, h("div", { class: "field" }, h("label", { for: ids.kind }, "Measure"), kindSel), fieldsEl, formErr, addBtn, datalist);

    // ---- the list of measurements ----------------------------------------------------------------------------------------------------
    const list = h("ul", { class: "hm-ms-list", "aria-label": "Measurements" });
    const empty = emptyState("No measurements yet.", "Pick a tool above and click two points, or choose points from the lists.");
    const count = h("span", { class: "tag outline" }, "0");
    const dotColor = (it, ok) => (ok ? `var(--${it.color ?? "accent"})` : "var(--text-3)");
    function subText(it, res) {
      if (!res.ok) return res.why;
      if (it.kind === "distance") return formatDeltas(res, unit());
      if (it.kind === "height") return "Height above the floor";
      if (it.kind === "angle") return "Angle at the second point";
      return `${fmtM(res.horizontal, unit())} horizontal`;
    }
    function buildRow(it) {
      const name = h("input", { type: "text", class: "hm-ms-name", value: it.label, maxlength: 80, "aria-label": `Name of ${it.label}` });
      name.addEventListener("change", () => { if (!measure.rename(it.id, name.value)) name.value = it.label; });
      name.addEventListener("focus", () => measure.select(it.id));
      const dot = h("span", { class: "hm-ms-dot", "aria-hidden": "true" });
      const sw = h("button", { type: "button", class: "hm-ib hm-ms-eye", "aria-pressed": it.visible ? "false" : "true", onclick: () => measure.setVisible(it.id, !it.visible) }, dot);
      const val = h("button", { type: "button", class: "hm-ms-val", onclick: () => measure.select(it.id), title: "Select it: it is highlighted in the 3D view" });
      const sub = h("div", { class: "hm-ms-sub small" });
      const del = iconButton({ icon: "trash", label: `Delete ${it.label}`, title: "Delete this measurement", onClick: () => {
        const at = [...list.children].indexOf(row), label = it.label;
        if (!measure.remove(it.id)) return;
        say(`${label} deleted.`);
        const rows2 = [...list.children]; // the list was redrawn: give the focus to the neighbour, not to nothing
        (rows2[Math.min(at, rows2.length - 1)]?.querySelector(".hm-ms-name") ?? tools.distance).focus();
      } });
      const res = h("div", { class: "hm-ms-res" }, val, sub);
      const row = h("li", { class: "hm-ms-item", dataset: { id: it.id } }, h("div", { class: "hm-ms-line" }, sw, name, del), res);
      row.addEventListener("click", (e) => { if (e.target === row || e.target === sub || e.target === res) measure.select(it.id); });
      rows.set(it.id, { row, name, val, sub, sw, dot, del });
      return row;
    }
    function syncRow(it) {
      const r = rows.get(it.id);
      if (!r) return;
      const res = measure.evaluate(it), sel = measure.selected === it.id;
      // this runs for every row on every pose or scene change: write only what differs (a write, even of the same text, costs layout)
      const put = (el, prop, v) => { if (el[prop] !== v) el[prop] = v; }, attr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
      if (document.activeElement !== r.name) put(r.name, "value", it.label);
      attr(r.name, "aria-label", `Name of ${it.label}`);
      put(r.val, "textContent", measure.format(res));
      put(r.sub, "textContent", subText(it, res));
      put(r.row.dataset, "state", res.ok ? "ok" : "grey");
      if (sel) attr(r.row, "aria-current", "true"); else r.row.removeAttribute("aria-current");
      put(r.dot.style, "background", dotColor(it, res.ok));
      attr(r.sw, "aria-pressed", it.visible ? "false" : "true");
      attr(r.sw, "aria-label", `${it.visible ? "Hide" : "Show"} ${it.label} in the 3D view`);
      put(r.sw, "title", it.visible ? "Hide it in the 3D view" : "Hidden. Press to show it");
      put(r.row.dataset, "hidden", it.visible ? "" : "1");
    }
    function renderList() {
      rows.clear();
      list.replaceChildren(...measure.items.map(buildRow));
      for (const it of measure.items) syncRow(it);
      count.textContent = String(measure.items.length);
      empty.hidden = measure.items.length > 0;
    }

    // ---- the selected measurement (inspector, or under the list) --------------------------------------------------------------------------
    const detailEl = h("div", { class: "hm-ms-detail" });
    const detailSlot = h("div", { class: "hm-sc-slot" });
    let detail = null; // { id, refresh }
    function pointRows(it, res) {
      const P = res.points ?? {}, out = [];
      const names = { distance: { a: "From", b: "To" }, height: { a: "Point" }, angle: { a: "First point", b: "Vertex", c: "Third point" }, view: { a: "Eye point", b: "Display point" } }[it.kind];
      for (const [k, label] of Object.entries(names)) out.push([label, h("span", {}, measure.refLabel(it[k], `${it.id}:${k}`), h("br"), h("span", { class: "muted small" }, coords(P[k])))]);
      return out;
    }
    function buildDetail(it) {
      const dl = h("dl", { class: "hm-kv" }), big = h("div", { class: "hm-ms-big", "aria-live": "off" });
      const name = h("input", { type: "text", class: "input", id: nextId("hm-ms-dn"), value: it.label, maxlength: 80, "aria-label": "Name" });
      name.addEventListener("change", () => { if (!measure.rename(it.id, name.value)) name.value = it.label; });
      const swatches = COLOR_TOKENS.map((t) => h("button", { type: "button", role: "radio", class: "hm-swatch", "aria-checked": it.color === t ? "true" : "false", "aria-label": TOKEN_NAMES[t], title: TOKEN_NAMES[t], style: { background: `var(--${t})` }, onclick: () => measure.setColor(it.id, t) }));
      const vis = h("label", { class: "check" }, h("input", { type: "checkbox", checked: it.visible ? true : null, onchange: (e) => measure.setVisible(it.id, e.target.checked) }), h("span", { class: "lbl" }, "Shown in the 3D view"));
      const del = h("button", { type: "button", class: "btn small", onclick: () => measure.remove(it.id) }, svgIcon("trash", 14), "Delete");
      const note = h("p", { class: "small muted" });
      const el = h("div", { class: "hm-ms-detail-body" }, h("div", { class: "field" }, h("label", { for: name.id }, "Name"), name), big, dl, note,
        h("div", { class: "hm-ed-set" }, h("div", { class: "hm-ed-h" }, "Colour"), h("div", { class: "hm-swatches", role: "radiogroup", "aria-label": "Colour" }, swatches)), vis, h("div", { class: "hm-sc-row" }, del));
      function refresh() {
        const cur = measure.items.find((x) => x.id === it.id);
        if (!cur) return;
        const res = measure.evaluate(cur), u = unit(), rowsOut = [];
        if (big.textContent !== measure.format(res)) big.textContent = measure.format(res);
        big.dataset.state = res.ok ? "ok" : "grey";
        if (!res.ok) { rowsOut.push(["Status", res.why], ...pointRows(cur, res)); note.textContent = "A measurement that cannot be resolved is shown in grey and is not drawn. It resolves again when its points come back (for example after Undo)."; } else {
          if (note.textContent) note.textContent = "";
          if (cur.kind === "distance") rowsOut.push(["Distance", fmtM(res.value, u)], ["Horizontal distance", fmtM(res.horizontal, u)], ["Δx (towards the figure's left)", fmtM(res.dx, u)], ["Δy (up)", fmtM(res.dy, u)], ["Δz (in front of the figure)", fmtM(res.dz, u)]);
          else if (cur.kind === "height") rowsOut.push(["Height above the floor", fmtM(res.value, u)]);
          else if (cur.kind === "angle") rowsOut.push(["Angle", formatResult(res, u)]);
          else {
            const v = res.view, deg = (x) => (x == null ? DASH : `${(Math.round(x * 10) / 10).toLocaleString("en-US")}°`);
            rowsOut.push(["View distance", fmtM(v.distance, u)], ["Horizontal distance", fmtM(v.horizontal, u)], [v.declination >= 0 ? "Screen centre is below the horizontal by" : "Screen centre is above the horizontal by", deg(Math.abs(v.declination))],
              ["Screen size seen", v.width == null ? "Unknown for this point" : `${fmtM(v.width, u)} × ${fmtM(v.height, u)}`], ["Visual angle (width × height)", v.visualH == null ? DASH : `${deg(v.visualH)} × ${deg(v.visualV)}`],
              ["Line of sight to the screen normal", deg(v.incidence)]);
            const z = v.zone, [d0, d1] = VIEW_ZONE.distance, [a0, a1] = VIEW_ZONE.declination;
            note.textContent = `For information: the view distance is ${z.distance === "within" ? "within" : `${z.distance} than`} the commonly cited ${fmtM(d0, u)} to ${fmtM(d1, u)}, and the screen centre is ${z.declination === "within" ? "within" : z.declination === "above" ? "above" : "below"} the ${a0} to ${a1} degrees below the horizontal. ${VIEW_NOTE}`;
          }
          rowsOut.push(...pointRows(cur, res));
        }
        const sig = rowsOut.map(([k, v]) => `${k}\u0001${typeof v === "string" ? v : v.textContent}`).join("\u0002");
        if (sig !== dl.dataset.sig) { dl.dataset.sig = sig; dl.replaceChildren(...rowsOut.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])); }
        if (document.activeElement !== name) name.value = cur.label;
        swatches.forEach((b, i) => b.setAttribute("aria-checked", cur.color === COLOR_TOKENS[i] ? "true" : "false"));
        vis.querySelector("input").checked = cur.visible;
      }
      return { id: it.id, el, refresh };
    }
    function renderDetail() {
      const it = measure.items.find((x) => x.id === measure.selected);
      if (!it) { detail = null; detailEl.replaceChildren(emptyState("No measurement selected.", "Select one in the list or click its label in the 3D view.")); dock.place(); return; }
      if (!detail || detail.id !== it.id) { detail = buildDetail(it); detailEl.replaceChildren(detail.el); }
      detail.refresh();
      dock.place();
    }
    const dock = createDock({ ctx, host, node: detailEl, slot: detailSlot, getTitle: () => measure.items.find((x) => x.id === measure.selected)?.label ?? "Measurement", note: "The selected measurement is described in the Measure panel, under the list.", onPlace: (inInspector) => { detailSection.hidden = inInspector; } });
    detailSlot.append(detailEl);

    // ---- export ----------------------------------------------------------------------------------------------------------------------------------
    const exp = (label, icon, fn, title) => h("button", { type: "button", class: "btn", title, onclick: fn }, svgIcon(icon, 14), label);
    const copyTo = async (text, what) => { toast((await copyText(text)) ? `${what} copied to the clipboard.` : "The browser blocked copying. Use Download instead."); };
    const exportBody = h("div", { class: "hm-sc-stack" },
      h("div", { class: "hm-sc-row" }, exp("CSV", "download", () => { download("measurements.csv", measure.toCSV(), "text/csv;charset=utf-8"); toast("Saved measurements.csv"); }, "Download the table (millimetres and degrees)"),
        exp("JSON", "download", () => { download("measurements.json", measure.toResultsJSON(), "application/json"); toast("Saved measurements.json"); }, "Download the results and their definitions as JSON"),
        exp("Copy CSV", "copy", () => copyTo(measure.toCSV(), "The table"), "Copy the table to the clipboard"), exp("Copy JSON", "copy", () => copyTo(measure.toResultsJSON(), "The JSON"), "Copy the results to the clipboard")),
      h("div", { class: "hm-sc-row" }, h("button", { type: "button", class: "btn", onclick: () => { if (measure.clear()) { say("All measurements deleted."); } } }, svgIcon("trash", 14), "Delete all")),
      h("p", { class: "small muted" }, "Exports are in millimetres and degrees, in the axes of the 3D view: x towards the figure's left, y up, z in front of the figure, origin on the floor. The measurements are also saved in the scene file (Scene tab)."));

    // ---- assemble ----------------------------------------------------------------------------------------------------------------------------------------
    const toolSection = section("Measure in the 3D view", [h("div", { class: "hm-sc-row" }, ...Object.values(tools), landmarksBtn), hint], { open: true });
    const listSection = section("Measure between points from lists", [listBody], { open: true });
    const itemsSection = section("Measurements", [empty, list], { open: true });
    itemsSection.querySelector("summary").append(count);
    const detailSection = section("Selected measurement", [detailSlot], { open: true });
    const exportSection = section("Export", [exportBody], { open: false });
    const root = h("div", { class: "hm-ms" }, h("div", { class: "hm-sc-head" }, h("h2", { class: "hm-panel-title" }, "Measure"), unitsSeg.el),
      h("p", { class: "small muted" }, "Distances, heights, angles and display viewing checks that follow the figure and the objects when they move."),
      toolSection, itemsSection, detailSection, listSection, exportSection, live);
    host.replaceChildren(root);
    renderForm();
    renderList();
    renderDetail();
    syncTool();

    // ---- live updates ---------------------------------------------------------------------------------------------------------------------------------------
    // While another tab is shown nothing here is visible, so nothing is updated; onShow brings the panel up to date (`stale`).
    let shown = false, stale = false, shownSel = null;
    offs.push(measure.onChange((e) => {
      if (e.op === "tool") { syncTool(); return; }
      if (!shown) { stale = true; return; }
      switch (e.op) {
        case "values": for (const it of measure.items) syncRow(it); detail?.refresh(); break;
        case "select": { for (const id of new Set([shownSel, measure.selected])) { const it = measure.items.find((x) => x.id === id); if (it) syncRow(it); } shownSel = measure.selected; renderDetail(); break; }
        case "update": { const it = measure.items.find((x) => x.id === e.id); if (it) syncRow(it); detail?.refresh(); dock.place(); break; }
        default: renderList(); shownSel = measure.selected; renderDetail(); syncTool(); // a measurement was just completed: the hint must ask for the first point again
      }
    }));
    on("units", (u) => { unitsSeg.set(u); if (!shown) { stale = true; return; } for (const it of measure.items) syncRow(it); detail?.refresh(); });
    on("display", () => landmarksBtn.setPressed(!!ctx.state.display.landmarks));
    // A scene event comes with every pointer move of a drag: moving an object changes no name, so it is ignored here; the rest is done once per frame.
    // The suggestions of the point fields are rebuilt when a field gets the focus (pointInput), so only a field that already has it needs them now.
    let sceneRaf = 0;
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
    function refreshScene() {
      sceneRaf = 0;
      if (!shown) { stale = true; return; }
      syncDisplays();
      if (form && form.inputs.includes(document.activeElement)) refreshOptions();
    }
    on("scene", (e) => { if (e.op === "move" || e.op === "history") return; if (!sceneRaf) sceneRaf = frame(refreshScene); });
    on("rig", () => { if (shown && form?.inputs.includes(document.activeElement)) refreshOptions(); if (form?.kind === "view" && !form.inputs[0].value) form.inputs[0].value = eyeDefault(); syncDisplays(); });

    root.addEventListener("keydown", (e) => { if (e.key === "Escape" && measure.tool !== "off") { measure.cancel(); e.preventDefault(); e.stopPropagation(); } });

    return {
      onShow() {
        shown = true;
        sandbox.setInteraction({ pick: true, drag: false, gizmo: false });
        dock.place(true);
        if (stale) { stale = false; syncDisplays(); renderList(); syncTool(); }
        shownSel = measure.selected;
        renderDetail();
      },
      onHide() { shown = false; measure.setTool("off"); sandbox.setInteraction({ pick: false, drag: false, gizmo: false }); },
      dispose() {
        shown = false;
        measure.setTool("off");
        for (const f of offs.splice(0)) f();
        dock.dispose();
        sandbox.setInteraction({ pick: false, drag: false, gizmo: false });
        releaseMeasure(ctx);
        releaseSandbox(ctx);
      },
    };
  },
};
