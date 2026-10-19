// Analysis panel of the Digital human tab: live, compact readouts of the figure and its posture. Joint angles with the ISO 11226 indications, the REBA angle bands as data,
// the centre of mass over the base of support (a small top-view diagram and the margin in mm), the gaps of the contact sets, joints outside their range of motion, reach and
// view numbers, the posture's description and source, and the honest limits of the model. Manual: docs/human3d/PLACE_ANALYSIS.md. Styles: site/human-analysis.css (hm-an-).
//
// The top of the file is `computeAnalysis` (pure: a rig, the posture editor and the sandbox in, plain data out; tested in Node) and small formatting helpers; the panel below draws
// that data and refreshes it when the pose, the scene, the selection or the units change: at most 10 times a second, never while the tab is hidden. Only the headline verdict is a
// live region (it is spoken when its words change, not on every drag step).
import * as THREE from "three";
import { h, toast } from "../../util.js";
import { fmtLength, nextId } from "../ui.js";
import { postureMetrics, ergonomicFlags, rebaInputs, REBA_BANDS } from "../metrics.js";
import { balance } from "../pose.js";
import { editorFor, supportLabel } from "../editor.js";
import { viewInfo, peekMeasure, VIEW_NOTE } from "../measure.js";
import { peekSandbox } from "../sandbox.js";
import { ensureAnalysisStyles, planeHeightAt, fmtMm } from "../place.js";

const mm = (m) => m * 1000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const MINUS = "−";
const deg = (v, d = 0) => {
  if (!fin(v)) return "—";
  const k = 10 ** d, r = Math.round(v * k) / k;
  return `${r < 0 ? MINUS : ""}${Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}°`;
};
const SIDE_WORD = { L: "left", R: "right" };
export const MIN_INTERVAL_MS = 100; // at most 10 refreshes a second while the figure is dragged

/** The honest limits of the model (DESIGN.md 0): shown in the panel, copied by nobody's accident. */
export const MODEL_NOTES = Object.freeze([
  "A simplified kinematic and anthropometric visualisation: rigid links between approximate joint centres, estimated from external measures. Real joint centres differ by a few centimetres.",
  "Ranges of motion are rounded textbook values for healthy adults, widened in places so that deep squats and floor sitting can be shown. They are not clinical limits.",
  "No soft tissue: the skin follows the bones but does not compress or bulge, so contact with seats and objects is approximate. Gaps of a few millimetres are inside the model's error.",
  "No strength, fatigue, comfort or injury model. The ISO 11226 and REBA readings are indications for static postures, not a risk assessment, and they do not know about holding time, load or repetition.",
  "Balance is the centre of mass of rigid segments (de Leva 1996) over the hull of the contact points: a static sanity check, not a stability analysis.",
]);
const CONTACT_LABEL = Object.freeze({ feet: "Feet", seat: "Seat (sit bones and thighs)", knees: "Knees", hands: "Hands", palms: "Palms", elbows: "Elbows", body: "Body", toes: "Toes", heels: "Heels", shins: "Shins", kneecaps: "Kneecaps", back: "Back", front: "Front", head: "Head" });
const EXTRA_SETS = Object.freeze({ toes: ["toe_tip_L", "toe_tip_R"], heels: ["heel_sole_L", "heel_sole_R"], palms: ["palm_centre_L", "palm_centre_R"], shins: ["shin_L", "shin_R"], kneecaps: ["knee_front_L", "knee_front_R"] });
const DISPLAY_ANCHORS = Object.freeze(["screen_centre", "glass_centre", "panel_centre"]);
const EDGE_BASE = Object.freeze({ screen_centre: "", glass_centre: "", panel_centre: "" });
const SEV_ORDER = { ok: 0, caution: 1, high: 2 };
export const SEVERITY = Object.freeze({ ok: { word: "OK", kind: "good" }, caution: { word: "Check", kind: "warn" }, high: { word: "Not recommended", kind: "bad" } });

/** The rows of the angle table: how to read the value of each side from the metrics and which ISO 11226 flags belong to it. */
export const ANGLE_ROWS = Object.freeze([
  { id: "trunk", label: "Trunk inclination", hint: "Forward of the vertical, positive forward (ISO 11226 Table 1)", single: (m) => m.trunkInclination, flags: () => ["trunk-inclination"] },
  { id: "trunksym", label: "Trunk side bend or twist", hint: "The larger of lateral flexion and axial rotation of the thorax against the pelvis (ISO 11226: a symmetrical trunk)", single: (m) => (fin(m.trunkLateralFlexion) && fin(m.trunkTwist) ? Math.max(Math.abs(m.trunkLateralFlexion), Math.abs(m.trunkTwist)) : null), flags: () => ["trunk-symmetry"] },
  { id: "neck", label: "Neck flexion", hint: "Head against trunk, positive = chin toward the chest", single: (m) => m.neckFlexion, flags: () => ["neck-flexion"] },
  { id: "head", label: "Head inclination", hint: "Head from the vertical, positive = nodding forward", single: (m) => m.headInclination, flags: () => ["head-inclination"] },
  { id: "shoulder", label: "Upper arm elevation", hint: "Upper arm from the vertical: 0 = hanging, 90 = horizontal", side: (m, s) => m[`upperArmInclination_${s}`], flags: (s) => [`upper-arm-elevation-${s}`] },
  { id: "elbow", label: "Elbow flexion", hint: "0 = straight", side: (m, s) => (fin(m[`elbowAngle_${s}`]) ? 180 - m[`elbowAngle_${s}`] : null), flags: (s) => [`elbow-${s}`] },
  { id: "wrist", label: "Wrist flexion", hint: "Positive = palmar flexion, negative = extension", side: (m, s) => m[`wristFlexion_${s}`], flags: (s) => [`wrist-flexion-${s}`] },
  { id: "wristdev", label: "Wrist deviation", hint: "Positive = toward the thumb (radial), negative = toward the little finger", side: (m, s) => m[`wristDeviation_${s}`], flags: (s) => [`wrist-deviation-${s}`] },
  { id: "hip", label: "Hip angle", hint: "Included angle trunk to thigh: 180 = standing straight, 90 = sitting upright", side: (m, s) => m[`hipAngle_${s}`], flags: () => [] },
  { id: "knee", label: "Knee flexion", hint: "0 = straight (the model's neutral knee reads about 5)", side: (m, s) => (fin(m[`kneeAngle_${s}`]) ? 180 - m[`kneeAngle_${s}`] : null), flags: (s) => [`knee-flexion-${s}`] },
  { id: "ankle", label: "Ankle angle", hint: "Shank against the sole: 90 = a right angle, over 90 = toes down", side: (m, s) => m[`ankleAngle_${s}`], flags: () => [] },
]);

// ---------------------------------------------------------------------------------------------------------------------
// the data
function contactEntries(rig, set) {
  if (set === "body") return [];
  const ids = EXTRA_SETS[set];
  if (ids) return ids.map((id) => { const v = rig.landmarkWorld(id); return { id, x: v.x, y: v.y, z: v.z }; });
  const entries = rig.restBody?.contacts?.[set] ?? rig.body?.contacts?.[set];
  return rig.contactPoints(set).map((v, i) => ({ id: typeof entries?.[i] === "string" ? entries[i] : `${set}[${i}]`, x: v.x, y: v.y, z: v.z }));
}
/** The display the reach summary measures to: the selected object when it has a screen centre, else the only display in the scene. */
export function displayOf(sandbox, selection) {
  if (!sandbox) return null;
  const has = (o) => DISPLAY_ANCHORS.find((a) => Object.hasOwn(o._anchors ?? {}, a));
  const sel = selection?.kind === "object" ? sandbox.objects.get(selection.id) : null;
  if (sel && has(sel)) return { id: sel.id, name: sel.name, anchor: has(sel) };
  const all = [...sandbox.objects.values()].filter((o) => o.visible && has(o));
  return all.length === 1 ? { id: all[0].id, name: all[0].name, anchor: has(all[0]) } : null;
}
function chairSupport(sandbox, place) {
  const s = place.seat;
  if (!sandbox || s.kind !== "object") return null;
  const obj = sandbox.objects.get(s.objectId), sup = sandbox.supportsWorld().find((x) => x.objectId === s.objectId && x.id === s.supportId);
  return obj && sup ? { obj, sup } : null;
}

/**
 * Everything the panel shows, as plain data. env: { rig, editor, sandbox?, measure?, selection?, body?, profile? }. Never throws for a missing piece: that piece is null.
 * Lengths are in metres, angles in degrees. See docs/human3d/PLACE_ANALYSIS.md for the shape.
 */
export function computeAnalysis({ rig, editor, sandbox = null, measure = null, selection = null, body = null, profile = null }) {
  if (!rig) return { ready: false, verdict: "Waiting for the model to be built." };
  const info = editor.info(), pose = rig.getPose(), B = body ?? rig.restBody ?? rig.body, place = info.place;
  const carriers = place.carriers, seated = Object.values(carriers).includes("seat") && place.mode !== "free";
  const chair = chairSupport(sandbox, place);
  const anchors = chair?.obj._anchors ?? {}, backrest = seated && ("srp" in anchors || "back_top" in anchors), headrest = seated && "headrest_centre" in anchors;
  const m = info.metrics ?? postureMetrics(B, { root: pose.root, angles: pose.angles }, pose.root, {});
  const flagOpts = { seated, ...(backrest ? { trunkSupport: true } : {}), ...(headrest ? { headSupport: true } : {}) };
  const flags = ergonomicFlags(m, flagOpts), byId = new Map(flags.map((f) => [f.id, f]));
  const reba = rebaInputs(m, { seated });

  // angle table
  const rows = ANGLE_ROWS.map((r) => {
    const mk = (side) => {
      const v = r.single ? r.single(m) : r.side(m, side);
      const fl = r.flags(side).map((id) => byId.get(id)).filter(Boolean);
      const worst = fl.reduce((a, f) => (SEV_ORDER[f.severity] > SEV_ORDER[a] ? f.severity : a), "ok");
      return { value: fin(v) ? v : null, severity: fl.length ? worst : null, flags: fl.map((f) => f.id) };
    };
    return r.single ? { id: r.id, label: r.label, hint: r.hint, single: mk(null) } : { id: r.id, label: r.label, hint: r.hint, L: mk("L"), R: mk("R") };
  });

  // balance: the hull of the contact points that carry the weight, the centre of mass projected on the floor
  const surfaces = { floor: 0 };
  if (seated) surfaces.seat = editor.seatHeight() ?? 0;
  const pts = [];
  if (place.mode !== "free") {
    for (const [set, surf] of Object.entries(carriers)) {
      let list = [];
      try { list = contactEntries(rig, set); } catch { list = []; }
      for (const e of list) if (e.y - (surfaces[surf] ?? 0) <= (place.support === "knees" && /^shin_[LR]$/.test(e.id) ? 0.03 : 0.015)) pts.push(e);
    }
  }
  const bal = { applies: !!info.balance?.applies, reason: info.balance?.reason ?? "", status: info.balance?.status ?? null, limit: info.balance?.limit ?? 0.04, margin: null, inside: null, com: null, hull: [], points: pts.map((p) => [p.x, p.z]) };
  try {
    if (B.masses && pts.length) {
      const hints = editor.getPosture?.(info.base.id)?.hints ?? {};
      const b = balance(B, pose, pose.root, pts.map((p) => [p.x, p.y, p.z]), { load: hints.load });
      Object.assign(bal, { margin: b.margin, inside: b.inside, com: [b.com.x, b.com.y, b.com.z], hull: b.hull });
      if (!bal.status) bal.status = b.margin >= 0 ? "ok" : b.margin >= -bal.limit ? "edge" : "falls";
    } else if (B.masses) {
      const c = rig.centerOfMass(new THREE.Vector3());
      bal.com = [c.point?.x ?? c.x, c.point?.y ?? c.y, c.point?.z ?? c.z];
    }
  } catch { /* a body without masses: no diagram */ }
  if (bal.com && !bal.com.every(fin)) bal.com = null;

  // gaps of the contact sets
  const gaps = [];
  const primary = Object.keys(carriers)[0];
  for (const [set, g] of Object.entries(info.gaps ?? {})) {
    let gap = g, note = "";
    if (set === "seat" && chair) {
      const pl = rig.contactPoints("seat");
      gap = Math.min(...pl.map((p) => p.y - planeHeightAt(chair.sup, chair.obj.yaw, p.x, p.z)));
      note = chair.sup.pitch ? ` (against the tilted surface of ${chair.obj.name})` : ` (on ${chair.obj.name})`;
    }
    const surf = carriers[set] === "seat" ? "seat" : "floor";
    const state = Math.abs(mm(gap)) <= 5 ? "touch" : gap > 0 ? "float" : "press";
    const text = state === "touch" ? `rests on the ${surf}` : state === "float" ? `${fmtMm(gap)} above the ${surf}` : set === primary ? `${fmtMm(gap)} inside the ${surf} surface` : `would be ${fmtMm(gap)} below the ${surf}`;
    gaps.push({ set, label: CONTACT_LABEL[set] ?? set, gap, state, text: `${text}${note}`, primary: set === primary });
  }

  // joints outside their ranges
  const rom = (info.romViolations ?? []).map((v) => ({ joint: v.joint, dof: v.dof, label: v.label, value: v.value, min: v.min, max: v.max }));

  // reach and view
  const sh = {}, grip = {}, arm = {};
  for (const s of ["L", "R"]) {
    const p = (id) => rig.jointWorld(id, new THREE.Vector3());
    sh[s] = p(`shoulder_${s}`);
    grip[s] = rig.landmarkWorld(`grip_centre_${s}`, new THREE.Vector3());
    arm[s] = sh[s].distanceTo(p(`elbow_${s}`)) + p(`elbow_${s}`).distanceTo(p(`wrist_${s}`)) + p(`wrist_${s}`).distanceTo(grip[s]);
  }
  const hand = (s) => ({
    height: m[`handHeightAboveFloor_${s}`], aboveShoulder: m[`handToShoulderUp_${s}`], aboveHeadBy: m[`handAboveHeadBy_${s}`], above: !!m[`handAboveHead_${s}`],
    distance: sh[s].distanceTo(grip[s]), armLength: arm[s], fraction: arm[s] > 0 ? sh[s].distanceTo(grip[s]) / arm[s] : null,
  });
  let view = null;
  const disp = displayOf(sandbox, selection);
  if (disp) {
    const eye = rig.landmarkWorld("eye_mid", new THREE.Vector3()), c = sandbox.anchorWorld(disp.id, disp.anchor, new THREE.Vector3()), edges = {};
    if (c) {
      for (const k of ["left", "right", "top", "bottom"]) { const e = sandbox.anchorWorld(disp.id, `${EDGE_BASE[disp.anchor]}${k}_edge`, new THREE.Vector3()); if (e) edges[k] = e; }
      view = { name: disp.name, ...viewInfo(eye, c, { ...edges, normal: sandbox.anchorNormalWorld(disp.id, disp.anchor, new THREE.Vector3()) }) };
    }
  }
  const reach = { eyeHeight: m.eyeHeight, L: hand("L"), R: hand("R"), view };

  const base = info.base;
  let src = null;
  try { src = base.id ? editor.getPosture(base.id) : null; } catch { src = null; }
  const posture = { id: base.id, name: base.name, kind: base.kind, modified: !!info.modified, description: src?.description ?? "", source: src?.source ?? "", category: src?.category ?? "", support: place.support, supportLabel: supportLabel(place.support), mode: place.mode, seatName: chair?.obj.name ?? null };

  const notes = flags.filter((f) => f.severity !== "ok");
  const verdictParts = [`${posture.name}${posture.modified && !/\(edited\)$/.test(posture.name) ? " (edited)" : ""}`];
  if (bal.margin != null && bal.applies) verdictParts.push(bal.inside ? `centre of mass ${fmtMm(bal.margin)} inside the support` : `centre of mass ${fmtMm(bal.margin)} outside the support${bal.status === "falls" ? ", beyond the 40 mm tolerance" : ""}`);
  else if (bal.reason) verdictParts.push(bal.reason.replace(/\.$/, "").toLowerCase());
  const feet = gaps.find((g) => g.set === "feet");
  if (feet && feet.state !== "touch" && seated) verdictParts.push(`feet ${feet.text}`);
  verdictParts.push(rom.length ? `${rom.length} joint angle${rom.length === 1 ? "" : "s"} outside the range of motion` : "all joints inside their ranges");
  verdictParts.push(notes.length ? `${notes.length} posture note${notes.length === 1 ? "" : "s"} to check (an indication)` : "no ISO 11226 note");
  const verdict = `${verdictParts.join("; ")}.`;

  return { ready: true, posture, place: { mode: place.mode, support: place.support, carriers, seated, seat: place.seat }, metrics: m, flagOptions: flagOpts, flags, notes, rows, reba, balance: bal, gaps, rom, reach, verdict };
}

// ---------------------------------------------------------------------------------------------------------------------
// drawing
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); e.append(...kids); return e; };
const W = 260, H = 170;

/** The top-view diagram: contact points, the hull of the base of support, the centre of mass projected on the floor, the way the figure faces (up). x is the figure's left on the left of the page. */
function balanceDiagram() {
  const hull = svgEl("polygon", { class: "hm-an-hull", points: "" }), dots = svgEl("g", { class: "hm-an-dots" });
  const com = svgEl("g", { class: "hm-an-com" }, svgEl("circle", { r: 6 }), svgEl("path", { d: "M-10 0H10M0 -10V10", class: "hm-an-cross" }));
  const label = svgEl("text", { class: "hm-an-lbl", x: 8, y: 14 }, "Front");
  const bar = svgEl("g", { class: "hm-an-bar" }, svgEl("line", { x1: 0, x2: 0, y1: 0, y2: 0 }), svgEl("text", { x: 0, y: -4, "text-anchor": "middle" }, "100 mm"));
  const arrow = svgEl("path", { class: "hm-an-arrow", d: "M12 20V6M8 10l4-5 4 5" });
  const title = svgEl("title", {}, "Top view"), desc = svgEl("desc", {}, "");
  const empty = svgEl("text", { class: "hm-an-empty", x: W / 2, y: H / 2, "text-anchor": "middle" }, "");
  const svg = svgEl("svg", { class: "hm-an-svg", viewBox: `0 0 ${W} ${H}`, role: "img", preserveAspectRatio: "xMidYMid meet" }, title, desc, hull, dots, com, arrow, label, bar, empty);
  function update(b, unitFmt) {
    const all = [...b.hull, ...b.points, ...(b.com ? [[b.com[0], b.com[2]]] : [])];
    svg.dataset.state = b.status ?? "none";
    if (!all.length) {
      hull.setAttribute("points", ""); dots.replaceChildren(); com.setAttribute("visibility", "hidden"); bar.setAttribute("visibility", "hidden"); empty.textContent = "No support points to draw.";
      title.textContent = "Top view of the base of support"; desc.textContent = "There are no contact points on the floor or a seat."; svg.setAttribute("aria-label", "Top view of the base of support: no contact points."); return;
    }
    empty.textContent = "";
    const xs = all.map((p) => p[0]), zs = all.map((p) => p[1]), pad = 0.08, minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
    const sc = Math.min((W - 40) / Math.max(maxX - minX, 0.35), (H - 30) / Math.max(maxZ - minZ, 0.3)), cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const px = (x) => W / 2 - (x - cx) * sc, py = (z) => H / 2 + 6 - (z - cz) * sc; // +X (the figure's left) to the left of the page, +Z (front) up
    hull.setAttribute("points", b.hull.map(([x, z]) => `${px(x).toFixed(1)},${py(z).toFixed(1)}`).join(" "));
    dots.replaceChildren(...b.points.map(([x, z]) => svgEl("circle", { cx: px(x).toFixed(1), cy: py(z).toFixed(1), r: 2.2 })));
    if (b.com) { com.setAttribute("visibility", "visible"); com.setAttribute("transform", `translate(${px(b.com[0]).toFixed(1)} ${py(b.com[2]).toFixed(1)})`); } else com.setAttribute("visibility", "hidden");
    const len = 0.1 * sc;
    bar.setAttribute("visibility", "visible"); bar.setAttribute("transform", `translate(${W - 20 - len / 2} ${H - 8})`);
    const ln = bar.firstChild; ln.setAttribute("x1", -len / 2); ln.setAttribute("x2", len / 2);
    const txt = b.margin == null ? "" : b.inside ? `The centre of mass is ${fmtMm(b.margin)} inside the base of support.` : `The centre of mass is ${fmtMm(b.margin)} outside the base of support.`;
    title.textContent = "Top view of the base of support";
    desc.textContent = `${txt} The figure faces up the page; its left is on the left.`;
    svg.setAttribute("aria-label", `Top view of the base of support. ${txt}`);
  }
  return { svg, update };
}

/** A small severity chip: the word is the meaning, the colour only helps. */
function chip(severity, title) {
  const s = SEVERITY[severity] ?? SEVERITY.ok;
  return h("span", { class: `tag ${s.kind} hm-an-chip`, title }, s.word);
}

// ---------------------------------------------------------------------------------------------------------------------
export default {
  id: "analysis",
  label: "Analysis",
  order: 6,
  async mount(host, ctx) {
    ensureAnalysisStyles();
    const editor = editorFor(ctx);
    editor.refs = (editor.refs ?? 0) + 1;
    const offs = [];
    let shown = false, disposed = false, dirty = true, timer = 0, raf = 0, lastRun = 0, data = null;
    const ids = { verdict: nextId("hm-an-verdict") };
    const unit = () => ctx.units ?? "mm";
    const len = (m) => fmtLength(mm(m), unit());

    const verdict = h("p", { class: "hm-an-verdict", id: ids.verdict, role: "status", "aria-live": "polite", "aria-atomic": "true" }, "Waiting for the model to be built.");
    const copyBtn = h("button", { type: "button", class: "btn small", title: "Copy a plain-text summary of the profile, posture, key angles, scene and measurements", onclick: () => copySummary() }, "Copy summary");
    const copyNote = h("p", { class: "small muted hm-an-copynote" });
    const head = h("div", { class: "hm-an-head" }, h("h2", { class: "hm-panel-title" }, "Analysis"), copyBtn);

    const postureBox = h("div", { class: "hm-an-posture" });
    const angleTable = h("table", { class: "data hm-an-table" });
    const angleNotes = h("ul", { class: "hm-an-notes small" });
    const diagram = balanceDiagram();
    const balanceFacts = h("p", { class: "hm-an-fact" }), gapList = h("ul", { class: "hm-an-gaps small" });
    const romList = h("ul", { class: "hm-an-rom" });
    const reachList = h("ul", { class: "hm-an-reach small" });
    const rebaBox = h("div", { class: "hm-an-reba" });
    const modelBox = h("div", { class: "hm-an-model small" });

    const sec = (title, body, open = true) => h("details", { class: "hm-an-sec", open: open ? true : null }, h("summary", {}, title), h("div", { class: "hm-an-body" }, body));
    const root = h("div", { class: "hm-an" }, head, verdict, copyNote,
      sec("Posture", postureBox),
      sec("Joint angles and ISO 11226 indications", [
        h("p", { class: "small muted" }, "Chips are indications from a simplified model for postures held longer than 4 seconds, not a risk assessment."),
        h("div", { class: "hm-an-scroll" }, angleTable), angleNotes]),
      sec("Balance and support", [h("div", { class: "hm-an-balance" }, diagram.svg, h("div", {}, balanceFacts, gapList))]),
      sec("Joints outside their range of motion", romList),
      sec("Reach and view", [reachList, h("p", { class: "small muted" }, VIEW_NOTE)]),
      sec("REBA band inputs (data only, no score)", rebaBox, false),
      sec("Model notes and limits", modelBox, false));
    host.replaceChildren(root);

    // ---- drawing the data --------------------------------------------------------------------------------------------------------------------
    const sigs = new Map();
    /** Run `build` and replace the children of `box` only when `key` differs from the last time (nothing flickers, a focused control stays). */
    function put(box, key, build) {
      const k = JSON.stringify(key);
      if (sigs.get(box) === k) return;
      sigs.set(box, k);
      const kids = [].concat(build()).filter((k) => k != null && k !== false);
      box.replaceChildren(...kids);
    }
    const cell = (c) => {
      if (!c || c.value == null) return h("td", { class: "num" }, "—");
      return h("td", { class: "num", "data-sev": c.severity ?? "none" }, h("span", { class: "hm-an-val" }, deg(c.value)), c.severity ? chip(c.severity) : null);
    };
    function draw(d) {
      if (!d.ready) { if (verdict.textContent !== d.verdict) verdict.textContent = d.verdict; return; }
      if (verdict.textContent !== d.verdict) verdict.textContent = d.verdict;
      const p = d.posture;
      put(postureBox, [p.id, p.name, p.modified, p.description, p.source, p.supportLabel, p.seatName], () => [
        h("p", { class: "hm-an-pname" }, h("strong", {}, p.name.replace(/ \(edited\)$/, "")), p.modified ? h("span", { class: "tag outline" }, "edited") : null, p.category ? h("span", { class: "tag outline" }, p.category) : null),
        h("p", { class: "small" }, `${p.supportLabel}${p.seatName ? `, on ${p.seatName}` : ""}.`),
        p.description ? h("p", { class: "small" }, p.description) : h("p", { class: "small muted" }, p.kind === "neutral" ? "Every joint angle is 0: relaxed standing, arms at the sides." : "A custom or imported pose has no description."),
        p.source ? h("p", { class: "small muted" }, `Source: ${p.source}`) : null]);
      put(angleTable, d.rows.map((r) => [r.id, r.single?.value, r.L?.value, r.R?.value, r.single?.severity, r.L?.severity, r.R?.severity]), () => [
        h("caption", { class: "sr-only" }, "Joint angles of the figure in degrees, with the ISO 11226 indication for each"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Joint"), h("th", { scope: "col", class: "num" }, "Left"), h("th", { scope: "col", class: "num" }, "Right"))),
        h("tbody", {}, d.rows.map((r) => (r.single
          ? h("tr", {}, h("th", { scope: "row", title: r.hint }, r.label), h("td", { colspan: 2, class: "num", "data-sev": r.single.severity ?? "none" }, r.single.value == null ? "—" : [h("span", { class: "hm-an-val" }, deg(r.single.value)), " ", r.single.severity ? chip(r.single.severity) : null]))
          : h("tr", {}, h("th", { scope: "row", title: r.hint }, r.label), cell(r.L), cell(r.R))))),
      ]);
      put(angleNotes, d.notes.map((f) => [f.id, f.severity, f.note]), () => (d.notes.length
        ? d.notes.map((f) => h("li", {}, chip(f.severity), " ", h("strong", {}, `${f.label}: `), f.note))
        : [h("li", { class: "muted" }, "No joint with an ISO 11226 limit is outside its acceptable range (an indication on a simplified model).")]));
      // balance
      const b = d.balance;
      diagram.update(b);
      const bt = !b.com ? "The centre of mass is not available for this body." : b.margin == null ? "No support points: the centre of mass has nothing to be over." : b.inside ? `The centre of mass is ${fmtMm(b.margin)} inside the base of support.` : `The centre of mass is ${fmtMm(b.margin)} outside the base of support${b.applies ? (b.status === "falls" ? ": past the 40 mm tolerance of the posture rules" : ": within the 40 mm tolerance of the posture rules") : ""}.`;
      put(balanceFacts, [bt, b.applies, b.reason], () => [bt, b.applies ? null : h("span", { class: "muted" }, ` The balance rule does not apply here: ${String(b.reason).replace(/\.$/, "").toLowerCase() || "something else carries the weight"}.`)]);
      put(gapList, d.gaps.map((g) => [g.set, g.text]), () => (d.gaps.length ? d.gaps.map((g) => h("li", { "data-state": g.state }, h("strong", {}, `${g.label}: `), g.text)) : [h("li", { class: "muted" }, "The figure is not on a support (free placement).")]));
      // joints outside their range
      put(romList, d.rom.map((r) => [r.joint, r.dof, Math.round(r.value * 10)]), () => (d.rom.length
        ? d.rom.map((r) => h("li", {}, h("button", { type: "button", class: "hm-an-jump", title: "Select this joint in the 3D view", onclick: () => ctx.select({ kind: "joint", id: r.joint }) },
          h("span", {}, r.label), h("span", { class: "num" }, `${deg(r.value, 1)} (range ${deg(r.min)} to ${deg(r.max)})`))))
        : [h("li", { class: "muted" }, "Every joint angle is inside its range of motion.")]));
      // reach
      const R = d.reach, sideLine = (s) => {
        const x = R[s];
        const parts = [`${len(x.height)} above the floor`, `${x.aboveShoulder >= 0 ? len(x.aboveShoulder) + " above" : len(-x.aboveShoulder) + " below"} the shoulder joint`];
        if (x.above) parts.push(`${len(x.aboveHeadBy)} above the head`);
        if (x.fraction != null) parts.push(`${Math.round(x.fraction * 100)} % of the straight-arm reach (${Math.round(mm(x.distance))} of ${Math.round(mm(x.armLength))} mm)`);
        return h("li", {}, h("strong", {}, `${s === "L" ? "Left" : "Right"} hand: `), parts.join("; "), ".");
      };
      put(reachList, [R.eyeHeight, R.L.height, R.L.distance, R.R.height, R.R.distance, R.view?.distance, R.view?.declination, unit()], () => [
        h("li", {}, h("strong", {}, "Eye height: "), `${len(R.eyeHeight)} above the floor.`), sideLine("L"), sideLine("R"),
        R.view ? h("li", {}, h("strong", {}, `Eye to ${R.view.name}: `), `${len(R.view.distance)}, centre ${Math.abs(R.view.declination).toFixed(0)}° ${R.view.declination >= 0 ? "below" : "above"} the horizontal${R.view.visualH != null ? `, ${R.view.visualH.toFixed(1)}° wide${R.view.visualV != null ? ` and ${R.view.visualV.toFixed(1)}° high` : ""} at the eye` : ""}.`)
          : h("li", { class: "muted" }, "Select a display in the Scene tab to see the eye-to-display distance and visual angle."),
      ]);
      // REBA
      const rb = d.reba;
      const band = (list, i) => (i == null ? "—" : list[i] ?? "—");
      put(rebaBox, [rb.trunk.angle, rb.neck.angle, rb.upperArm.L.angle, rb.upperArm.R.angle, rb.lowerArm.L.angle, rb.lowerArm.R.angle, rb.wrist.L.angle, rb.wrist.R.angle, rb.legs.support, rb.legs.L.flexion], () => {
        const row = (name, angle, bands, idx, extra) => h("tr", {}, h("th", { scope: "row" }, name), h("td", { class: "num" }, deg(angle)), h("td", {}, band(bands, idx)), h("td", { class: "small" }, extra || ""));
        const mods = (o, keys) => keys.filter(([k]) => o[k]).map(([, t]) => t).join(", ");
        return [
          h("div", { class: "hm-an-scroll" }, h("table", { class: "data hm-an-table" },
            h("caption", { class: "sr-only" }, "REBA angle bands of the figure: the angle and the band it falls in, no score"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Segment"), h("th", { scope: "col", class: "num" }, "Angle"), h("th", { scope: "col" }, "Band"), h("th", { scope: "col" }, "Modifiers"))),
            h("tbody", {},
              row("Trunk", rb.trunk.angle, REBA_BANDS.trunk, rb.trunk.bandIndex, mods(rb.trunk, [["twisted", "twisted"], ["sideBent", "side bent"]])),
              row("Neck", rb.neck.angle, REBA_BANDS.neck, rb.neck.bandIndex, mods(rb.neck, [["twisted", "twisted"], ["sideBent", "side bent"]])),
              ...["L", "R"].flatMap((s) => [
                row(`Upper arm (${SIDE_WORD[s]})`, rb.upperArm[s].angle, REBA_BANDS.upperArm, rb.upperArm[s].bandIndex, mods(rb.upperArm[s], [["abducted", "abducted"], ["shoulderRaised", "shoulder raised"]])),
                row(`Lower arm (${SIDE_WORD[s]})`, rb.lowerArm[s].angle, REBA_BANDS.lowerArm, rb.lowerArm[s].bandIndex),
                row(`Wrist (${SIDE_WORD[s]})`, rb.wrist[s].angle, REBA_BANDS.wrist, rb.wrist[s].bandIndex, mods(rb.wrist[s], [["deviated", "deviated"], ["twisted", "twisted"]])),
              ]),
              ...["L", "R"].map((s) => row(`Knee (${SIDE_WORD[s]})`, rb.legs[s].flexion, REBA_BANDS.legs, rb.legs.seated ? null : rb.legs[s].bandIndex, rb.legs.seated ? "seated: knees are not scored" : ""))),
          )),
          h("p", { class: "small muted" }, `Legs: ${rb.legs.support}. ${rb.source}. Bands as in the REBA worksheets; the modifiers' thresholds are this tool's (approx.).`),
        ];
      });
    }
    // model notes: static list plus the caveats of this body and profile
    function drawModel() {
      const prof = ctx.getProfile(), body = ctx.getBody();
      const dims = body?.dims ?? [], est = dims.filter((x) => x.status === "estimated").length, der = dims.filter((x) => x.status === "derived").length;
      const extra = [];
      if (body?.synthetic) extra.push("This is a generic body: the profile could not be fitted, so proportions are plausible but not from the survey.");
      if (prof?.source?.kind === "population") extra.push(`Population profiles are boundary cases: each dimension is the ${prof.source.percentile ?? "chosen"}th percentile of that dimension alone, and no real person has all of them at once${(prof.source.percentile ?? 50) >= 95 || (prof.source.percentile ?? 50) <= 5 ? ". At the extremes the combination is least likely to exist, so treat fit and reach results as limits, not as a person" : ""}.`);
      if (est || der) extra.push(`Of ${dims.length} body dimensions, ${est} ${est === 1 ? "is" : "are"} estimated from stature and mass and ${der} derived from other measures; the rest were measured.`);
      for (const n of (prof?.notes ?? []).slice(0, 4)) if (typeof n === "string") extra.push(n);
      for (const n of (body?.warnings ?? []).slice(0, 3)) if (typeof n === "string") extra.push(n);
      put(modelBox, [prof?.id, body?.profileId, extra], () => [h("ul", {}, MODEL_NOTES.map((t) => h("li", {}, t))), extra.length ? h("p", { class: "hm-an-sub" }, "This body and profile") : null, extra.length ? h("ul", {}, extra.map((t) => h("li", {}, t))) : null]);
    }

    // ---- refreshing -----------------------------------------------------------------------------------------------------------------------------
    function run() {
      timer = 0; raf = 0;
      if (disposed || !shown) return;
      lastRun = performance.now();
      dirty = false;
      try {
        data = computeAnalysis({ rig: ctx.getRig(), editor, sandbox: peekSandbox(ctx), measure: peekMeasure(ctx), selection: ctx.state.selection, body: ctx.getBody(), profile: ctx.getProfile() });
        draw(data);
        drawModel();
      } catch (e) {
        if (!/not ready/.test(String(e?.message))) console.warn("analysis: refresh failed:", e);
        if (verdict.textContent === "") verdict.textContent = "The readouts could not be computed.";
      }
    }
    /** Ask for a refresh: coalesced, at most every MIN_INTERVAL_MS, on an animation frame, and not at all while the tab is hidden. */
    function request() {
      dirty = true;
      if (!shown || disposed || timer || raf) return;
      const wait = Math.max(0, lastRun + MIN_INTERVAL_MS - performance.now());
      timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(run); }, wait);
    }
    for (const evt of ["pose", "rig", "selection", "scene", "measure", "units", "posture", "profile", "body"]) offs.push(ctx.on(evt, request));
    for (const evt of ["change", "place", "history", "rig", "look"]) offs.push(editor.on(evt, request));

    // ---- copy summary ---------------------------------------------------------------------------------------------------------------------------------
    async function writeClipboard(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
      const ta = h("textarea", { "aria-hidden": "true", style: { position: "fixed", left: "-9999px", top: "0" } }, text);
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
    async function copySummary() {
      copyBtn.disabled = true;
      try {
        const X = await import("../export.js"), rig = ctx.getRig();
        if (!rig) throw new Error("There is no figure yet.");
        const measure = peekMeasure(ctx);
        let measurements = null;
        try { measurements = measure?.exportRows?.() ?? null; } catch { measurements = null; }
        const inp = { rig, profile: X.profileOf(rig, [ctx.getProfile()]), posture: X.effectivePosture(ctx.state.posture, rig), sandbox: peekSandbox(ctx), measurements };
        let rows = null;
        try { rows = await X.metricRows(inp); } catch { rows = null; }
        const text = X.summaryText(inp, rows);
        const ok = await writeClipboard(text);
        const msg = ok ? "Summary copied." : "The browser would not copy. Select the text in the export tab instead.";
        toast(msg); // the site's toast is a status message: it is the one announcement of the result (the headline verdict is the only live region of the panel)
        copyNote.textContent = msg;
        setTimeout(() => { copyNote.textContent = ""; }, 2500);
        root.dataset.copied = ok ? "1" : "0";
        root.__summary = text; // read by the browser test
      } catch (e) {
        console.error("analysis: copy failed:", e);
        toast(`Could not make the summary: ${String(e?.message ?? e).slice(0, 120)}`);
      } finally { copyBtn.disabled = false; }
    }

    return {
      onShow() { shown = true; if (dirty || !data) { lastRun = 0; request(); } },
      onHide() { shown = false; if (timer) { clearTimeout(timer); timer = 0; } if (raf) { cancelAnimationFrame(raf); raf = 0; } },
      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
        if (raf) cancelAnimationFrame(raf);
        for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
        if ((editor.refs = (editor.refs ?? 1) - 1) <= 0) { try { editor.dispose(); } catch { /* gone */ } }
        host.replaceChildren();
      },
    };
  },
};
