// Skeleton panel of the Digital human tab: the 77 joints as a tree (angles, rest segment to the parent and whether that bone length was measured,
// derived or estimated), the range of motion of every degree of freedom, landmarks, and a CSV of every joint centre and landmark for CAD.
// Contract: docs/human3d/DESIGN.md 3.2; panel API: DESIGN.md 2.3b and shell.js. Everything above `// ---- panel` is pure (tested in Node by
// tests/human3d/panels-profile.test.mjs); the panel itself only touches the DOM inside mount().
//
// The joint inspector is a function the posture editor can replace: setJointDetailsRenderer(fn) with fn(container, ctx, jointId) -> { update?, dispose? } | void.
// While the renderer returns an update() it is called on every pose event (so a slider being dragged keeps its focus); without one the details are redrawn.
import * as THREE from "three";
import { h, toast, download, toCSV } from "../../util.js";
import { JOINTS, JOINT_BY_ID, BONES, REGIONS, GROUPS } from "../skeleton.js";
import { section, emptyState, nextId, chipButton, fmtLength } from "../ui.js";
import { impliedXray } from "../state.js";

// ---------------------------------------------------------------------------------------------------------------------
// styles: one sheet (site/human-profile.css) for both panels, injected once; a failed request is dropped so that the next mount asks again
const CSS_URL = new URL("../../../human-profile.css", import.meta.url).href;
export function ensureStyles() {
  let link = document.querySelector("link[data-hm-profile-css]");
  if (link?.dataset.failed) { link.remove(); link = null; }
  if (!link) {
    link = h("link", { rel: "stylesheet", href: CSS_URL, "data-hm-profile-css": "" });
    link.onerror = () => { link.dataset.failed = "1"; };
    document.head.append(link);
  }
  return new Promise((resolve) => {
    if (link.sheet) return resolve(true);
    if (link.dataset.failed) return resolve(false);
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(!link.dataset.failed), 3000); // never hold the panel back for a slow sheet
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// joint -> dimension mapping
// `dims` set the rest segment of the joint to its parent (the offset in body.joints), `also` move it a little (the arm tilts outward to clear the hips, so the
// shoulder width turns the elbow and wrist offsets; the thigh length follows the knee height when it is estimated, ...). Ids are those of body.dims (fit.js).
// A derived dimension stands for the dimensions it is built from (DERIVED_FROM), so that a test can check the table against fit.js: moving any
// dimension by a few millimetres must only move joints that list it, directly or through DERIVED_FROM (tests/human3d/panels-profile.test.mjs).
const entry = (dims, also = [], note = "") => ({ dims, also, note });
const FIXED_NOTE = "Placed by a model constant, not by a dimension of the profile.";
const ARM_TILT = "The arm hangs tilted outward just enough for the wrist to clear the hip, so the shoulder width and the hip breadth turn its direction a little.";
const SHOULDER_NOTE = "A profile with an arm span or a thumbtip reach makes the model solve the shoulder width and the protraction so that the span and reach come out exactly.";

/** Dimensions that are computed from other dimensions (fit.js DEFS with no measure and no estimate): what they stand for. */
export const DERIVED_FROM = Object.freeze({
  shank_length: ["knee_height", "ankle_height"], hip_height: ["knee_height", "femur_length"], trunk_length: ["c7_height", "hip_height", "l5_above_hip"],
  neck_length: ["head_pivot_depth", "c7_height"], head_pivot_depth: ["vertex_to_eye", "tragion_below_eye"], gh_halfwidth: ["acromion_halfwidth", "acromion_to_gh"],
  ball_length: ["foot_length"],
});

/** Derived dimensions whose edit is applied to another dimension (fit.js DERIVED_OVERRIDES): editing the first moves what the second moves. */
export const EDIT_AS = Object.freeze({ shank_length: "knee_height", hip_height: "femur_length", gh_halfwidth: "acromion_to_gh" });
// The arm tilts outward to clear the hip and the model solves the shoulder for a span or a reach, so a hand hangs differently when any of these changes.
const ARM_DIMS = ["acromion_halfwidth", "acromion_to_gh", "upper_arm_length", "forearm_length", "shoulder_height"];
// A longer thigh or a different L5 height leaves less of the stature for the neck and the shoulder girdle (found by moving each dimension and refitting).
const STATURE_SHARE = ["femur_length", "l5_above_hip"];

function buildJointDims() {
  const t = {};
  t.pelvis = entry(["hip_height"], [], "The root: its offset is the height of the hip centres above the floor.");
  t.L5 = entry(["l5_above_hip"], ["hip_height"], "When L5/S1 is placed from the iliac crest height, the iliac crest stays where it is, so a longer thigh shortens this segment.");
  for (const id of [...REGIONS.lumbar.joints.slice(1), ...REGIONS.thoracic.joints, "C7"]) t[id] = entry(["trunk_length"], [], "One of the 17 intervals between L5/S1 and C7/T1; together they add up to the trunk length.");
  for (const id of [...REGIONS.cervical.joints.slice(1), "head"]) t[id] = entry(["neck_length"], ["femur_length"], "One of the 7 intervals between C7/T1 and the occiput-C1 joint; together they add up to the neck length.");
  t.jaw = entry([], [], FIXED_NOTE);
  for (const s of ["L", "R"]) {
    t[`eye_${s}`] = entry(["interpupillary_breadth", "head_length"], ["tragion_below_eye", "vertex_to_eye"]);
    t[`clavicle_${s}`] = entry(["c7_height"], STATURE_SHARE, "The shoulder girdle follows the height of C7/T1.");
    t[`shoulder_${s}`] = entry(["shoulder_height", "gh_halfwidth", "shoulder_protraction"], ["c7_height", ...STATURE_SHARE, "knee_height", "buttock_back", "upper_arm_length", "forearm_length", "hand_length", "hand_breadth"], SHOULDER_NOTE);
    t[`elbow_${s}`] = entry(["upper_arm_length"], ["gh_halfwidth", "shoulder_height", "forearm_length", "hand_length"], ARM_TILT + " A length that comes from the acromion-radiale distance also follows the shoulder height.");
    t[`forearm_${s}`] = entry([], [], "At the elbow centre (offset zero): this joint turns the forearm about its own axis; the forearm bone is as long as the wrist joint is far from the elbow.");
    t[`wrist_${s}`] = entry(["forearm_length"], ["gh_halfwidth", "upper_arm_length", "shoulder_height", "hand_length"], ARM_TILT);
    t[`thumb_cmc_${s}`] = entry(["hand_length", "hand_breadth"], ARM_DIMS);
    t[`thumb_mcp_${s}`] = entry(["hand_length"], ARM_DIMS);
    t[`thumb_ip_${s}`] = entry(["hand_length"], ARM_DIMS);
    for (const f of ["index", "middle", "ring", "little"]) {
      t[`${f}_mcp_${s}`] = entry(["hand_length", "hand_breadth"], ARM_DIMS);
      t[`${f}_pip_${s}`] = entry(["hand_length"], ARM_DIMS);
      t[`${f}_dip_${s}`] = entry(["hand_length"], ARM_DIMS);
    }
    t[`hip_${s}`] = entry(["hip_halfwidth"], [], "Sideways from the pelvis midpoint to the hip joint centre.");
    t[`knee_${s}`] = entry(["femur_length"], ["knee_height"]);
    t[`ankle_${s}`] = entry(["shank_length"]);
    t[`mtp_${s}`] = entry(["foot_length", "ball_length"], ["ankle_height"]);
  }
  return t;
}
/** joint id -> { dims, also, note } for all 77 joints. */
export const JOINT_DIMS = Object.freeze(buildJointDims());

/** Dimension ids a dimension stands for (itself when it is not derived), recursively. */
export function expandDims(ids) {
  const out = new Set(), todo = [...ids];
  while (todo.length) {
    const id = todo.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const d of DERIVED_FROM[id] ?? []) todo.push(d);
  }
  return out;
}
/** Dimensions (own and secondary) that can move a joint, derived ones expanded: the set the tests compare with fit.js. */
export function jointInfluences(jointId) {
  const e = JOINT_DIMS[jointId];
  return e ? expandDims([...e.dims, ...e.also]) : new Set();
}
/** Joints whose rest segment a dimension sets or moves (the inverse of JOINT_DIMS, derived dimensions expanded). */
export function dimensionJoints(dimId) {
  const ids = [dimId, EDIT_AS[dimId]].filter(Boolean); // an edit of a derived dimension is applied to the one it stands for
  return JOINTS.map((j) => j.id).filter((id) => ids.some((d) => jointInfluences(id).has(d)));
}

/**
 * Whether the bone length to the parent was measured, derived or estimated: from the dimensions in `dims`. All measured -> measured, all estimated -> estimated,
 * anything else derived; "fixed" when no dimension sets it. body.dims is the mapping table of fit.js. Returns { status, dims: [{ id, label, status }] }.
 */
export function jointBoneStatus(jointId, body) {
  const e = JOINT_DIMS[jointId];
  if (!e) return { status: "unknown", dims: [] };
  if (!e.dims.length) return { status: "fixed", dims: [] };
  const list = e.dims.map((id) => body?.dims?.find((d) => d.id === id)).filter(Boolean).map((d) => ({ id: d.id, label: d.label, status: d.status }));
  if (!list.length) return { status: "unknown", dims: [] };
  const st = list.every((d) => d.status === "measured") ? "measured" : list.every((d) => d.status === "estimated") ? "estimated" : "derived";
  return { status: st, dims: list };
}

/** Length (mm) of the rest segment from the parent joint to this joint; for the root, its height above the floor. */
export function restSegmentMm(jointId, body) {
  const o = body?.joints?.[jointId]?.offset;
  if (!o) return null;
  return JOINT_BY_ID[jointId]?.parent ? Math.hypot(o[0], o[1], o[2]) * 1000 : o[1] * 1000;
}

// ---------------------------------------------------------------------------------------------------------------------
// the joint tree
const FINGERS = [["thumb", "Thumb"], ["index", "Index finger"], ["middle", "Middle finger"], ["ring", "Ring finger"], ["little", "Little finger"]];
const leaf = (jointId) => ({ id: `j:${jointId}`, joint: jointId, label: JOINT_BY_ID[jointId].label });

/** The tree of the panel: [{ id, label, children?, joint? }]. Every joint appears exactly once as a leaf (`joint` set). */
export function buildJointTree() {
  const tree = [{
    id: "g:spine", label: "Pelvis and spine", children: [
      leaf("pelvis"),
      ...["lumbar", "thoracic", "cervical"].map((r) => ({ id: `g:${r}`, label: `${REGIONS[r].label} spine`, children: REGIONS[r].joints.map(leaf) })),
    ],
  }, {
    id: "g:head", label: "Head and face", children: ["head", "jaw", "eye_L", "eye_R"].map(leaf),
  }];
  for (const [s, name] of [["L", "Left"], ["R", "Right"]]) {
    tree.push({
      id: `g:arm_${s}`, label: `${name} arm`, children: [
        ...["clavicle", "shoulder", "elbow", "forearm", "wrist"].map((n) => leaf(`${n}_${s}`)),
        { id: `g:hand_${s}`, label: `${name} hand`, children: FINGERS.map(([f, fl]) => ({
          id: `g:${f}_${s}`, label: fl, children: (f === "thumb" ? ["cmc", "mcp", "ip"] : ["mcp", "pip", "dip"]).map((k) => leaf(`${f}_${k}_${s}`)),
        })) },
      ],
    });
  }
  for (const [s, name] of [["L", "Left"], ["R", "Right"]]) tree.push({ id: `g:leg_${s}`, label: `${name} leg`, children: ["hip", "knee", "ankle", "mtp"].map((n) => leaf(`${n}_${s}`)) });
  return tree;
}
/** Joint ids of a (sub)tree in display order. */
export function treeJoints(nodes) {
  return nodes.flatMap((n) => (n.joint ? [n.joint] : treeJoints(n.children ?? [])));
}
/** The label of a joint without what its group already says ("Left shoulder (glenohumeral)" under "Left arm" -> "Shoulder (glenohumeral)"). */
export function shortJointLabel(jointId) {
  let s = JOINT_BY_ID[jointId].label.replace(/^(Left|Right) /, "").replace(/^(Lumbar|Thoracic|Cervical) /, "");
  s = s.replace(/^(thumb|index|middle|ring|little) /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Joint ids whose label, id or group matches every word of the query (case-insensitive); an empty query matches all. */
export function matchJoints(query, ids = JOINTS.map((j) => j.id)) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return ids.slice();
  return ids.filter((id) => {
    const j = JOINT_BY_ID[id];
    const hay = `${j.label} ${id} ${GROUPS.find((g) => g.id === j.group)?.label ?? j.group} ${j.dof.map((d) => d.label).join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
/** Ids of the groups on the way from the top to a joint (to open them when the joint gets selected). */
export function ancestorsOf(nodes, jointId, trail = []) {
  for (const n of nodes) {
    if (n.joint === jointId) return trail;
    const r = n.children ? ancestorsOf(n.children, jointId, [...trail, n.id]) : null;
    if (r) return r;
  }
  return null;
}

/** { joints, dof, bones } of the rig tables, for the summary line. */
export function skeletonCounts() {
  return { joints: JOINTS.length, dof: JOINTS.reduce((n, j) => n + j.dof.length, 0), bones: BONES.length };
}
export function summaryText(landmarkCount) {
  const c = skeletonCounts();
  return `${c.joints} joints, ${c.dof} degrees of freedom, ${c.bones} bones, ${landmarkCount ?? 0} landmarks`;
}

// ---------------------------------------------------------------------------------------------------------------------
// angles and ranges of motion
const num1 = (v) => Number(v.toFixed(1));
/** "12°", "−5.5°": a real minus sign, one decimal only when needed. */
export function fmtDeg(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(digits));
  return `${r < 0 ? "−" : ""}${Math.abs(r)}°`;
}
/** "neutral" or "flex 12°, abd −5°" (the DOF that are not zero, at most four, keys as in skeleton.js). */
export function angleSummary(jointId, angles) {
  const j = JOINT_BY_ID[jointId];
  const parts = j.dof.map((d, i) => [d.key, angles?.[i] ?? 0]).filter(([, v]) => Math.abs(v) >= 0.05);
  if (!parts.length) return "neutral";
  return parts.slice(0, 4).map(([k, v]) => `${k} ${fmtDeg(v)}`).join(", ") + (parts.length > 4 ? ", …" : "");
}
/** Where the zero mark and the current value sit on a range bar, 0 to 1 (values outside the range are held at the ends). */
export function romFractions(min, max, value) {
  const span = max - min;
  if (!(span > 0)) return { zero: 0, pos: 0 };
  const f = (v) => Math.min(1, Math.max(0, (v - min) / span));
  return { zero: f(0), pos: f(value ?? 0) };
}
/** "−35° to 60°" */
export const romText = (d) => `${fmtDeg(d.min, 0)} to ${fmtDeg(d.max, 0)}`;

// ---------------------------------------------------------------------------------------------------------------------
// points for CAD: every joint centre and landmark in world mm
export const POINT_COLUMNS = Object.freeze(["type", "id", "label", "group", "kind", "attached_to", "x_mm", "y_mm", "z_mm"]);
const mm1 = (m) => { const v = Math.round(m * 10000) / 10; return Object.is(v, -0) ? 0 : v; }; // metres -> mm with one decimal, no "-0"
/**
 * Rows for pointsCSV from a rig: all joints (centres) and all landmarks of the body, positions in world millimetres in the axes of DESIGN.md
 * (+X the figure's left, +Y up, +Z forward, floor at y = 0) in the pose the rig is in now.
 */
export function collectPoints(rig) {
  const rows = [];
  for (const j of JOINTS) {
    const p = rig.jointWorld(j.id);
    rows.push({ type: "joint", id: j.id, label: j.label, group: GROUPS.find((g) => g.id === j.group)?.label ?? j.group, kind: "centre", attached: j.parent ?? "", p: [p.x, p.y, p.z] });
  }
  for (const [id, l] of Object.entries(rig.body.landmarks)) {
    const p = rig.landmarkWorld(id);
    rows.push({ type: "landmark", id, label: l.label ?? id, group: l.group ?? "", kind: l.kind ?? "", attached: l.joint, p: [p.x, p.y, p.z] });
  }
  return rows;
}
/** CSV text (header + one row per point) of collectPoints rows. */
export function pointsCSV(rows) {
  return toCSV(POINT_COLUMNS, rows.map((r) => [r.type, r.id, r.label, r.group, r.kind, r.attached, ...r.p.map(mm1)]));
}
/** "x, y, z" in mm for the landmark list: "−85.2  1,402.9  15.3" */
export function fmtPointMm(p) {
  return p.map((v) => mm1(v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace("-", "−")).join("   ");
}
/** Landmark ids matching a search (label, id, group, kind; every word must match). */
export function matchLandmarks(landmarks, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const ids = Object.keys(landmarks ?? {});
  if (!words.length) return ids;
  return ids.filter((id) => {
    const l = landmarks[id];
    const hay = `${l.label ?? ""} ${id} ${l.group ?? ""} ${l.kind ?? ""} ${l.joint ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// flashing a point in the 3D view: landmark dots and X-ray on for a moment, and a bright marker through the skin at the point itself
let flashTimer = 0, flashMarker = null, flashViewport = null;
function restoreFlash(ctx) {
  clearTimeout(flashTimer);
  flashTimer = 0;
  if (flashMarker && flashViewport) {
    flashViewport.remove(flashMarker);
    flashMarker.geometry.dispose();
    flashMarker.material.dispose();
    flashViewport.requestRender();
  }
  flashMarker = flashViewport = null;
  const rig = ctx.getRig?.(), d = ctx.state.display;
  if (!rig || rig.display === undefined) return;
  try { rig.setDisplay({ landmarks: !!d.landmarks, xray: d.xray || impliedXray({ skin: d.skin && !!rig.skin, skeleton: d.skeleton, joints: d.joints }) }); } catch { /* disposed rig */ }
  ctx.requestRender();
}
/** Show where a landmark (or joint centre, `position` in world metres) is: the landmark dots of the rig for ~2 s and a marker on the point. */
export function flashPoint(ctx, position, ms = 2000) {
  const rig = ctx.getRig?.();
  if (!rig) return;
  restoreFlash(ctx);
  try { rig.setDisplay({ landmarks: true, xray: true }); } catch { /* disposed rig */ }
  try {
    const css = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1c5cab";
    flashMarker = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(css), depthTest: false, transparent: true, opacity: 0.95 }));
    flashMarker.position.copy(position);
    flashMarker.renderOrder = 999;
    flashViewport = ctx.viewport;
    flashViewport.add(flashMarker);
  } catch { flashMarker = flashViewport = null; }
  ctx.requestRender();
  flashTimer = setTimeout(() => restoreFlash(ctx), ms);
}
/** Select a landmark (the shell names it in the 3D view) and flash it. */
export function showLandmark(ctx, id) {
  const rig = ctx.getRig?.();
  if (!rig) return;
  let p;
  try { p = rig.landmarkWorld(id); } catch { return; }
  ctx.select({ kind: "landmark", id });
  flashPoint(ctx, p);
}

// ---------------------------------------------------------------------------------------------------------------------
// the joint inspector (replaceable)
const statusText = { measured: "measured", derived: "derived", estimated: "estimated", fixed: "fixed", unknown: "unknown" };
const statusTitle = {
  measured: "Every dimension that sets this bone length is a measure from the profile (or typed by you).",
  derived: "Computed from measures with a documented relation (or a mix of measured and estimated dimensions).",
  estimated: "No measure sets this bone length: it is estimated from stature, mass and sex.",
  fixed: "Placed by a model constant, not by a dimension of the profile.",
  unknown: "This body has no dimension table.",
};
export function statusChip(status, text = statusText[status] ?? status) {
  return h("span", { class: `hm-pf-st hm-st-${status}`, title: statusTitle[status] }, text);
}

/** A bar for a range of motion with the zero mark and the current value (decorative: the numbers beside it carry the information). */
function romBar(d, value) {
  const bar = h("span", { class: "hm-sk-rom", role: "img", "aria-label": "" },
    h("span", { class: "hm-sk-rom-fill" }), h("span", { class: "hm-sk-rom-zero" }), h("span", { class: "hm-sk-rom-pos" }));
  bar.setValue = (v) => {
    const g = romFractions(d.min, d.max, v), lo = Math.min(g.zero, g.pos), hi = Math.max(g.zero, g.pos);
    bar.style.setProperty("--zero", `${g.zero * 100}%`);
    bar.style.setProperty("--pos", `${g.pos * 100}%`);
    bar.firstChild.style.left = `${lo * 100}%`;
    bar.firstChild.style.width = `${(hi - lo) * 100}%`;
    bar.setAttribute("aria-label", `${fmtDeg(v)} in a range of ${romText(d)}`);
  };
  bar.setValue(value);
  return bar;
}

/**
 * Read-only details of a joint, drawn into `container`: degrees of freedom with value, range bar and source, the rest segment to the parent and where its
 * length comes from, the bones the joint moves, the landmarks on it, its neighbours. Returns { update() } that refreshes the numbers in place.
 * The posture editor replaces this with sliders through setJointDetailsRenderer().
 */
export function renderJointDetails(container, ctx, jointId) {
  const j = JOINT_BY_ID[jointId];
  const body = () => ctx.getBody(), rig = () => ctx.getRig();
  const bones = BONES.filter((b) => b.joint === jointId);
  const lms = Object.entries(body()?.landmarks ?? {}).filter(([, l]) => l.joint === jointId);
  const angles = () => rig()?.angles?.[jointId] ?? [];

  const dofRows = j.dof.map((d, i) => {
    const val = h("span", { class: "hm-sk-dofval" });
    const bar = romBar(d, 0);
    const row = h("div", { class: "hm-sk-dof" },
      h("div", { class: "hm-sk-doftop" }, h("span", { class: "hm-sk-dofname" }, d.label), h("code", { class: "hm-sk-dofkey", title: `Degree of freedom "${d.key}" (${d.role})` }, d.key), val),
      bar,
      h("div", { class: "hm-sk-romends" }, h("span", {}, fmtDeg(d.min, 0)), h("span", {}, "range of motion"), h("span", {}, fmtDeg(d.max, 0))),
      h("div", { class: "hm-sk-dofsign small muted" }, `+ ${d.pos}`, h("br"), `− ${d.neg}`),
      h("details", { class: "hm-sk-src small" }, h("summary", {}, "Where this range comes from"), h("p", { class: "muted" }, d.src, d.note ? ` ${d.note}` : "")));
    return { row, val, bar, i, d };
  });

  const segVal = h("span", {}), segChip = h("span", {}), segWhy = h("div", { class: "hm-sk-why small muted" });
  const segment = h("div", { class: "hm-sk-seg-box" },
    h("div", { class: "hm-sk-sect-title" }, j.parent ? "Rest segment to the parent" : "Height above the floor"),
    h("div", { class: "hm-sk-seg-line" }, segVal, segChip), segWhy);

  const boneRows = bones.map((b) => ({ b, len: h("span", { class: "hm-sk-boneLen" }) }));
  const boneBox = bones.length ? h("div", {}, h("div", { class: "hm-sk-sect-title" }, `Bones it moves (${bones.length})`),
    h("ul", { class: "hm-sk-list" }, boneRows.map((r) => h("li", {}, h("span", {}, r.b.label), r.len)))) : null;

  const lmBox = lms.length ? h("div", {}, h("div", { class: "hm-sk-sect-title" }, `Landmarks on it (${lms.length})`),
    h("ul", { class: "hm-sk-list hm-sk-lmlist" }, lms.map(([id, l]) => h("li", {}, h("button", { type: "button", class: "hm-sk-link", title: "Show this landmark in the 3D view", onclick: () => showLandmark(ctx, id) }, l.label ?? id))))) : null;

  const kids = JOINTS.filter((k) => k.parent === jointId).map((k) => k.id);
  const nav = h("div", { class: "hm-sk-nav small" },
    j.parent ? [h("span", { class: "muted" }, "Parent: "), h("button", { type: "button", class: "hm-sk-link", onclick: () => ctx.select({ kind: "joint", id: j.parent }) }, shortLabelOf(j.parent))] : h("span", { class: "muted" }, "Root of the skeleton"),
    kids.length ? [h("span", { class: "muted" }, "  Next: "), ...kids.flatMap((k, n) => [n ? ", " : "", h("button", { type: "button", class: "hm-sk-link", onclick: () => ctx.select({ kind: "joint", id: k }) }, shortLabelOf(k))])] : null);

  container.replaceChildren(
    h("div", { class: "hm-sk-meta small muted" }, `${GROUPS.find((g) => g.id === j.group)?.label ?? j.group} · ${j.dof.length} degree${j.dof.length === 1 ? "" : "s"} of freedom`, h("br"), `Joint id: ${jointId}`),
    nav, h("div", { class: "hm-sk-sect-title" }, "Degrees of freedom"), ...dofRows.map((r) => r.row), segment, ...[boneBox, lmBox].filter(Boolean), // (replaceChildren would print a null)
    h("p", { class: "small muted" }, "Read-only here: the Posture tab moves the joints."));

  function update() {
    const a = angles();
    for (const r of dofRows) { const v = a[r.i] ?? 0; r.val.textContent = fmtDeg(v); r.bar.setValue(v); }
    const b = body(), mm = restSegmentMm(jointId, b), st = jointBoneStatus(jointId, b), info = JOINT_DIMS[jointId];
    segVal.textContent = mm == null ? "—" : mm < 0.05 && j.parent ? "0 (at the parent's centre)" : fmtLength(mm, ctx.units);
    segChip.replaceChildren(statusChip(st.status));
    const names = st.dims.map((d) => `${d.label} (${d.status})`).join("; ");
    const lines = [st.dims.length ? `Set by: ${names}.` : info?.note || "", st.dims.length && info?.note ? info.note : "",
      info?.also?.length ? `Also moved a little by: ${info.also.map((id) => body()?.dims?.find((d) => d.id === id)?.label ?? id).join("; ")}.` : ""].filter(Boolean);
    segWhy.replaceChildren(...lines.flatMap((t, i) => (i ? [h("br"), t] : [t])));
    const r = rig();
    for (const x of boneRows) {
      let t = "";
      if (r && x.b.to) { try { const s = r.boneSegment(x.b.id); t = fmtLength(s.a.distanceTo(s.b) * 1000, ctx.units); } catch { /* bone without both ends in this body */ } }
      x.len.textContent = t;
    }
  }
  update();
  return { update };
}
const shortLabelOf = (id) => shortJointLabel(id);

let detailsRenderer = renderJointDetails;
/** Replace the joint inspector (the posture editor draws sliders instead). fn(container, ctx, jointId) -> { update?, dispose? } | void; null restores the default. */
export function setJointDetailsRenderer(fn) {
  detailsRenderer = typeof fn === "function" ? fn : renderJointDetails;
}

function renderLandmarkDetails(container, ctx, id) {
  const l = ctx.getBody()?.landmarks?.[id];
  if (!l) { container.replaceChildren(emptyState("This landmark is not on the current body.")); return null; }
  const pos = h("span", { class: "hm-sk-mono" });
  const jointBtn = JOINT_BY_ID[l.joint] ? h("button", { type: "button", class: "hm-sk-link", onclick: () => ctx.select({ kind: "joint", id: l.joint }) }, JOINT_BY_ID[l.joint].label) : l.joint;
  container.replaceChildren(
    h("dl", { class: "hm-kv" },
      h("dt", {}, "Group and kind"), h("dd", {}, `${l.group ?? "—"} · ${l.kind ?? "—"}`),
      h("dt", {}, "Moves with"), h("dd", {}, jointBtn),
      h("dt", {}, "World position, mm (x left, y up, z forward)"), h("dd", {}, pos)),
    h("button", { type: "button", class: "btn small", onclick: () => showLandmark(ctx, id) }, "Show in the 3D view"));
  const update = () => { try { pos.textContent = fmtPointMm(ctx.getRig().landmarkWorld(id).toArray()); } catch { pos.textContent = "—"; } };
  update();
  return { update };
}

// ---------------------------------------------------------------------------------------------------------------------
// ---- panel
async function mount(container, ctx) {
  await ensureStyles();
  const offs = [];
  let shown = false, disposed = false;
  let selJoint = null, selLandmark = null;
  let rafId = 0;

  const root = h("div", { class: "hm-sk" });
  container.replaceChildren(root);

  // ---- header and display toggles
  const summaryEl = h("p", { class: "hm-sk-summary small muted" });
  const displayDefs = [["skeleton", "Bones", "Show the bones"], ["joints", "Joint markers", "Show a marker on every joint (colour = degrees of freedom); you can click them"], ["labels", "Names", "Write the names of the joints and landmarks that are shown"], ["landmarks", "Landmark dots", "Show the anthropometric landmarks"]];
  const toggles = displayDefs.map(([k, label, title]) => ({ k, el: chipButton({ label, title, toggle: true, pressed: !!ctx.state.display[k], onClick: () => ctx.setDisplay({ [k]: !ctx.state.display[k] }) }) }));
  const showBar = h("div", { class: "hm-sk-show", role: "group", "aria-label": "Show on the model" }, h("span", { class: "hm-sk-showlabel small muted" }, "Show on the model"), toggles.map((t) => t.el));

  // ---- joint tree
  const tree = buildJointTree();
  const searchId = nextId("hm-sk-q");
  const search = h("input", { type: "search", class: "input", id: searchId, placeholder: "Search joints, e.g. shoulder or index", "aria-label": "Search joints", autocomplete: "off" });
  const treeEl = h("div", { class: "hm-sk-tree", role: "tree", "aria-label": "Joints of the skeleton" });
  const emptyEl = h("p", { class: "hm-sk-none small muted", hidden: true, role: "status" }, "No joint matches the search.");
  const nodes = []; // flat, in display order: { node, level, parentIdx, el, open, jointId?, angEl?, segEl?, chipEl? }
  const byId = new Map();
  const userOpen = new Set(["g:spine"]); // groups the user has opened (the first one starts open)
  let query = "", matchSet = null; // matchSet: Set of joint ids that match the search (null = no search)

  (function build(list, level, parentIdx) {
    list.forEach((n, i) => {
      const idx = nodes.length;
      const item = { node: n, level, parentIdx, idx, jointId: n.joint ?? null, size: list.length, pos: i + 1 };
      item.el = h("div", { class: `hm-sk-item ${n.joint ? "hm-sk-joint" : "hm-sk-group"}`, role: "treeitem", id: nextId("hm-sk-n"), tabindex: "-1", "aria-level": level, "aria-posinset": i + 1, "aria-setsize": list.length,
        dataset: { node: n.id } });
      item.el.style.setProperty("--lvl", String(level - 1)); // indentation (a custom property cannot be set through Object.assign(style))
      nodes.push(item);
      byId.set(n.id, item);
      if (n.joint) {
        const j = JOINT_BY_ID[n.joint];
        item.el.setAttribute("aria-selected", "false");
        item.angEl = h("span", { class: "hm-sk-ang" });
        item.segEl = h("span", { class: "hm-sk-segl" });
        item.chipEl = h("span", { class: "hm-sk-chipslot" });
        item.el.append(
          h("span", { class: "hm-sk-name" }, shortJointLabel(n.joint)),
          h("span", { class: "hm-sk-dofn", title: `${j.dof.length} degree${j.dof.length === 1 ? "" : "s"} of freedom: ${j.dof.map((d) => d.key).join(", ")}` }, `${j.dof.length} DOF`),
          item.angEl, h("span", { class: "hm-sk-segwrap" }, item.segEl, item.chipEl));
        item.el.title = j.label;
      } else {
        item.count = treeJoints(n.children).length;
        item.el.setAttribute("aria-expanded", "false");
        item.el.append(h("span", { class: "hm-sk-chev", "aria-hidden": "true" }), h("span", { class: "hm-sk-name" }, n.label), h("span", { class: "hm-sk-count small muted" }, `${item.count}`));
      }
      treeEl.append(item.el);
      if (n.children) build(n.children, level + 1, idx);
    });
  })(tree, 1, -1);
  let focusIdx = 0;

  function isOpen(item) { return matchSet ? true : userOpen.has(item.node.id); }
  function visibleItems() {
    const out = [];
    const hiddenBelow = [];
    for (const item of nodes) {
      let vis = true;
      // a node is visible when every ancestor group is open and (with a search) it, or a joint below it, matches
      let p = item.parentIdx;
      while (p >= 0) { if (!isOpen(nodes[p])) { vis = false; break; } p = nodes[p].parentIdx; }
      if (vis && matchSet) vis = item.jointId ? matchSet.has(item.jointId) : treeJoints(item.node.children).some((id) => matchSet.has(id));
      hiddenBelow.push(vis);
      if (vis) out.push(item);
    }
    return { out, vis: hiddenBelow };
  }
  function layoutTree() {
    const { out, vis } = visibleItems();
    nodes.forEach((item, i) => {
      item.el.hidden = !vis[i];
      if (!item.jointId) {
        const open = isOpen(item);
        item.el.setAttribute("aria-expanded", open ? "true" : "false");
        item.el.classList.toggle("is-open", open);
      }
    });
    emptyEl.hidden = out.length > 0;
    if (!out.includes(nodes[focusIdx])) focusIdx = out[0]?.idx ?? 0;
    setStop(nodes[focusIdx]);
  }
  function setStop(item) {
    for (const n of nodes) n.el.tabIndex = n === item ? 0 : -1;
    focusIdx = item?.idx ?? 0;
  }
  function focusItem(item) { setStop(item); item.el.focus({ preventScroll: false }); }

  // Only the angle text changes from one pose frame to the next: the rest segment, its units and the status chip depend on the body and the display units, so
  // they are redrawn when those change (poseOnly = false) and not for every frame of a slider drag.
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  function refreshRows({ poseOnly = false } = {}) {
    const body = ctx.getBody(), rig = ctx.getRig();
    for (const item of nodes) {
      if (!item.jointId) continue;
      setText(item.angEl, angleSummary(item.jointId, rig?.angles?.[item.jointId]));
      if (poseOnly) continue;
      const mm = restSegmentMm(item.jointId, body), st = jointBoneStatus(item.jointId, body);
      item.segEl.textContent = mm == null ? "" : !JOINT_BY_ID[item.jointId].parent ? `${fmtLength(mm, ctx.units)} up` : mm < 0.05 ? "at parent" : fmtLength(mm, ctx.units);
      item.segEl.title = JOINT_BY_ID[item.jointId].parent ? "Rest segment to the parent joint" : "Height of the hip centres above the floor";
      item.chipEl.replaceChildren(statusChip(st.status));
    }
    if (poseOnly) return;
    const lm = body?.landmarks ? Object.keys(body.landmarks).length : 0;
    summaryEl.textContent = summaryText(lm);
  }

  function toggleGroup(item) {
    if (userOpen.has(item.node.id)) userOpen.delete(item.node.id); else userOpen.add(item.node.id);
    layoutTree();
  }
  function activate(item) {
    if (item.jointId) ctx.select({ kind: "joint", id: item.jointId });
    else toggleGroup(item);
  }
  treeEl.addEventListener("click", (e) => {
    const el = e.target.closest?.("[role=treeitem]");
    if (!el || !treeEl.contains(el)) return;
    const item = byId.get(el.dataset.node);
    setStop(item);
    activate(item);
  });
  treeEl.addEventListener("focusin", (e) => { // however the focus got here (a click, a script, a screen reader), that item is the one tab stop
    const el = e.target.closest?.("[role=treeitem]");
    if (el && treeEl.contains(el)) setStop(byId.get(el.dataset.node));
  });
  treeEl.addEventListener("keydown", (e) => {
    const el = e.target.closest?.("[role=treeitem]");
    if (!el || e.altKey || e.ctrlKey || e.metaKey) return;
    const item = byId.get(el.dataset.node), { out } = visibleItems(), i = out.indexOf(item);
    let to = null;
    switch (e.key) {
      case "ArrowDown": to = out[Math.min(out.length - 1, i + 1)]; break;
      case "ArrowUp": to = out[Math.max(0, i - 1)]; break;
      case "Home": to = out[0]; break;
      case "End": to = out[out.length - 1]; break;
      case "ArrowRight":
        if (!item.jointId && !isOpen(item)) toggleGroup(item);
        else if (!item.jointId) to = out[i + 1];
        break;
      case "ArrowLeft":
        if (!item.jointId && isOpen(item) && !matchSet) toggleGroup(item);
        else if (item.parentIdx >= 0) to = nodes[item.parentIdx];
        break;
      case "Enter": case " ": activate(item); break;
      default: return;
    }
    e.preventDefault();
    if (to) focusItem(to);
  });
  search.addEventListener("input", () => {
    query = search.value.trim();
    matchSet = query ? new Set(matchJoints(query)) : null;
    layoutTree();
  });
  const expandAll = h("button", { type: "button", class: "btn small", onclick: () => { for (const n of nodes) if (!n.jointId) userOpen.add(n.node.id); layoutTree(); } }, "Expand all");
  const collapseAll = h("button", { type: "button", class: "btn small", onclick: () => { userOpen.clear(); layoutTree(); } }, "Collapse all");

  // ---- landmarks and export
  const lmSearch = h("input", { type: "search", class: "input", placeholder: "Search landmarks, e.g. acromion", "aria-label": "Search landmarks", autocomplete: "off" });
  const lmList = h("ul", { class: "hm-sk-lms", "aria-label": "Landmarks" });
  const lmNone = h("p", { class: "small muted", hidden: true, role: "status" }, "No landmark matches the search.");
  const lmRows = new Map(); // id -> { li, pos }
  let lmBuilt = null; // the landmarks object the list was built for
  function buildLandmarks() {
    const lms = ctx.getBody()?.landmarks;
    if (!lms || lmBuilt === lms) return;
    lmBuilt = lms;
    lmRows.clear();
    const frag = document.createDocumentFragment();
    for (const [id, l] of Object.entries(lms)) {
      const pos = h("span", { class: "hm-sk-mono hm-sk-lmpos" });
      const btn = h("button", { type: "button", class: "hm-sk-lm", title: `Show ${l.label ?? id} in the 3D view`, dataset: { lm: id }, onclick: () => showLandmark(ctx, id) },
        h("span", { class: "hm-sk-lmname" }, l.label ?? id), h("span", { class: "hm-sk-lmmeta small muted" }, `${l.group ?? ""} · ${l.kind ?? ""}`), pos);
      const li = h("li", {}, btn);
      lmRows.set(id, { li, pos });
      frag.append(li);
    }
    lmList.replaceChildren(frag);
    filterLandmarks();
    updateLandmarkPositions();
  }
  function filterLandmarks() {
    const ok = new Set(matchLandmarks(ctx.getBody()?.landmarks, lmSearch.value));
    for (const [id, r] of lmRows) r.li.hidden = !ok.has(id);
    lmNone.hidden = ok.size > 0 || lmRows.size === 0;
  }
  function updateLandmarkPositions() {
    const rig = ctx.getRig();
    if (!rig || !lmSec.open) return;
    for (const [id, r] of lmRows) {
      if (r.li.hidden) continue;
      let t = "";
      try { t = fmtPointMm(rig.landmarkWorld(id).toArray()); } catch { /* unknown landmark */ }
      setText(r.pos, t);
    }
  }
  lmSearch.addEventListener("input", () => { filterLandmarks(); updateLandmarkPositions(); });

  const csvStatus = h("p", { class: "small muted", role: "status" });
  function csvText() {
    const rig = ctx.getRig();
    if (!rig) throw new Error("There is no figure yet.");
    return pointsCSV(collectPoints(rig));
  }
  async function copyCsv() {
    let text;
    try { text = csvText(); } catch (e) { csvStatus.textContent = e.message; return; }
    const rows = text.trim().split("\n").length - 1;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // no clipboard permission (or an insecure page): the old way through a selection
      const ta = h("textarea", { "aria-hidden": "true", style: { position: "fixed", top: "0", left: "0", opacity: "0" } }, text);
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      if (!ok) { csvStatus.textContent = "The browser did not allow copying. Use Download instead."; return; }
    }
    csvStatus.textContent = `Copied ${rows} rows (joint centres and landmarks) as CSV.`;
    toast(`Copied ${rows} points as CSV`);
  }
  function downloadCsv() {
    try {
      const text = csvText();
      download(`digital-human-points-${(ctx.getProfile()?.id || "figure").replace(/[^\w.-]+/g, "_").slice(0, 60)}.csv`, text);
      csvStatus.textContent = `Saved ${text.trim().split("\n").length - 1} rows.`;
    } catch (e) { csvStatus.textContent = e.message; }
  }

  const jointsSec = section("Joints", [
    h("div", { class: "hm-sk-tools" }, search, h("div", { class: "hm-sk-treebtns" }, expandAll, collapseAll)), treeEl, emptyEl,
    h("p", { class: "small muted" }, "Click a joint to select it: the 3D view marks it and the Inspector shows its degrees of freedom. Arrow keys move through the list.")], { open: true });
  const lmSec = section("Landmarks", [lmSearch, h("div", { class: "hm-sk-lmwrap" }, lmList), lmNone,
    h("p", { class: "small muted" }, "Click a landmark to see it in the 3D view. Positions are in the current pose, in millimetres, x to the figure's left, y up, z forward.")], { open: false });
  const csvSec = section("Points for CAD", [
    h("p", { class: "small muted" }, "All joint centres and landmarks in the current pose as CSV: world millimetres, +X the figure's left, +Y up, +Z forward, floor at y = 0 (one row per point; the same axes as the Export tab)."),
    h("div", { class: "hm-sk-row" }, h("button", { type: "button", class: "btn primary small", onclick: copyCsv }, "Copy as CSV"), h("button", { type: "button", class: "btn small", onclick: downloadCsv }, "Download CSV")), csvStatus], { open: false });
  lmSec.addEventListener("toggle", () => { if (lmSec.open) { buildLandmarks(); updateLandmarkPositions(); } });

  // ---- details of the selection: in the inspector (the right-hand column) and, on a narrow screen where the inspector is folded away below the page, also
  // right under the joint list. The inspector node is persistent (the shell never re-inserts it, so a slider inside keeps its focus).
  const insp = h("div", { class: "hm-sk-insp" });
  const inspBody = h("div", { class: "hm-sk-inspbody" });
  insp.append(inspBody);
  const inlineTitle = h("span", {}), inlineBody = h("div", { class: "hm-sk-inspbody" });
  const inline = h("details", { class: "hm-sk-inline", open: true, hidden: true }, h("summary", {}, "Selected: ", inlineTitle), inlineBody);
  /** What is drawn into a details view: { key, title, renderer, draw(host) } for the selection now. */
  function currentSpec() {
    if (selJoint) return { key: `j:${selJoint}`, title: JOINT_BY_ID[selJoint].label, renderer: detailsRenderer, draw: (host) => detailsRenderer(host, ctx, selJoint) };
    if (selLandmark) return { key: `l:${selLandmark}`, title: ctx.getBody()?.landmarks?.[selLandmark]?.label ?? selLandmark, renderer: renderLandmarkDetails, draw: (host) => renderLandmarkDetails(host, ctx, selLandmark) };
    return { key: "none", title: "Skeleton", renderer: null, draw: (host) => { host.replaceChildren(emptyState("No joint selected.", "Choose a joint in the list, or turn on Joint markers and click one in the 3D view.")); } };
  }
  function makeView(host) {
    let cur = null; // { key, renderer, handle }
    const clear = () => { try { cur?.handle?.dispose?.(); } catch (e) { console.error(e); } cur = null; };
    return {
      clear,
      /** Draw the spec. Without `force` the details of the same thing are updated in place when their renderer can, else drawn again. */
      show(spec, force = false) {
        if (!force && cur?.key === spec.key && cur.renderer === spec.renderer) {
          if (cur.handle?.update) { cur.handle.update(); return; }
          if (spec.key === "none") return;
        }
        clear();
        let handle = null;
        try { handle = spec.draw(host) ?? null; } catch (e) { console.error(e); host.replaceChildren(emptyState("The details could not be drawn.")); }
        cur = { key: spec.key, renderer: spec.renderer, handle };
      },
      /** The pose changed: numbers only. A renderer without update() is drawn again to show the new angles. */
      pose(spec) { if (cur?.handle?.update) cur.handle.update(); else if (cur && cur.key !== "none") this.show(spec, true); },
    };
  }
  const inspView = makeView(inspBody), inlineView = makeView(inlineBody);
  root.append(h("h2", { class: "hm-panel-title" }, "Skeleton"), summaryEl, showBar, jointsSec, inline, lmSec, csvSec);
  const narrow = typeof matchMedia === "function" ? matchMedia("(max-width: 899px)") : { matches: false };
  let inspTitle = null;
  function renderInspector({ force = false } = {}) {
    const spec = currentSpec();
    if (spec.title !== inspTitle) { inspTitle = spec.title; ctx.inspector(insp, { title: spec.title }); }
    inspView.show(spec, force);
    inline.hidden = !narrow.matches;
    if (narrow.matches) { inlineTitle.textContent = spec.key === "none" ? "nothing yet" : spec.title; inlineView.show(spec, force); } else inlineView.clear();
  }
  const onNarrow = () => { if (shown) renderInspector({ force: true }); };
  narrow.addEventListener?.("change", onNarrow);
  offs.push(() => narrow.removeEventListener?.("change", onNarrow));
  function onPoseNow() {
    if (!shown) return;
    refreshRows({ poseOnly: true });
    const spec = currentSpec();
    inspView.pose(spec);
    if (narrow.matches) inlineView.pose(spec);
    if (lmSec.open) updateLandmarkPositions();
  }
  function onPose() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; if (!disposed) onPoseNow(); }); }

  // ---- selection from outside (3D view, other panels)
  function syncSelection(sel) {
    const jointSel = sel?.kind === "joint" && JOINT_BY_ID[sel.id] ? sel.id : null;
    selJoint = jointSel;
    selLandmark = sel?.kind === "landmark" ? sel.id : null;
    for (const item of nodes) if (item.jointId) item.el.setAttribute("aria-selected", item.jointId === selJoint ? "true" : "false");
    if (selJoint) {
      for (const g of ancestorsOf(tree, selJoint) ?? []) userOpen.add(g);
      if (matchSet && !matchSet.has(selJoint)) { search.value = ""; query = ""; matchSet = null; }
      layoutTree();
      const item = byId.get(`j:${selJoint}`);
      setStop(item);
      if (shown) item.el.scrollIntoView({ block: "nearest" });
    }
    renderInspector();
  }
  offs.push(ctx.on("selection", syncSelection));
  offs.push(ctx.on("pose", onPose));
  // the figure or the units changed: everything drawn from them is drawn again (while hidden, on the next onShow)
  const redrawAll = () => {
    lmBuilt = null;
    if (!shown) return;
    refreshRows();
    renderInspector({ force: true });
    if (lmSec.open) { buildLandmarks(); updateLandmarkPositions(); }
  };
  offs.push(ctx.on("units", redrawAll));
  offs.push(ctx.on("body", redrawAll));
  offs.push(ctx.on("rig", redrawAll));
  offs.push(ctx.on("display", () => { for (const t of toggles) t.el.setPressed(!!ctx.state.display[t.k]); }));

  layoutTree();
  refreshRows();
  syncSelection(ctx.state.selection);

  return {
    onShow() {
      shown = true;
      refreshRows();
      renderInspector({ force: true }); // the figure may have changed while this tab was hidden
      if (lmSec.open) { buildLandmarks(); updateLandmarkPositions(); }
      if (selJoint) byId.get(`j:${selJoint}`)?.el.scrollIntoView({ block: "nearest" });
    },
    onHide() { shown = false; restoreFlash(ctx); },
    dispose() {
      disposed = true;
      for (const f of offs) f();
      if (rafId) cancelAnimationFrame(rafId);
      restoreFlash(ctx);
      inspView.clear();
      inlineView.clear();
      try { ctx.inspector(null); } catch { /* shell gone */ }
    },
  };
}

export default { id: "skeleton", label: "Skeleton", order: 5, mount };
