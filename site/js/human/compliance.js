// The MIL-STD-1472H report of the figure in its scene: reads the rig, the posture editor and the sandbox, turns them into plain facts and runs the checks of
// mil1472.js on them. No DOM: the Posture, Scene and Analysis panels call `complianceReport` and draw what it returns (docs/human3d/MIL_STD_1472H.md).
//
//   sceneFacts({ rig, editor, sandbox, profile })      -> the facts checkScene reads (stance, seat, hands on grips, displays in view, the load in the hands)
//   complianceReport({ rig, editor, sandbox, profile }) -> { summary, posture, interactions, objects, population, results }
//   reportCSV(report)                                   -> the report as CSV text, one row per result
import * as THREE from "three";
import { byType } from "./catalog.js";
import { viewInfo } from "./measure.js";
import { surfaceIndex, nearestSurface, rayHit } from "./clearance.js";
import { checkPosture, checkObject, checkScene, summarize, loadGeometry, postureLoad, LIFT, clauseRef, STANDARD, STATUS_WORD } from "./mil1472.js";

const LOAD_TYPES = new Set(["crate", "small_box", "ammo_can", "toolbox", "rucksack", "drum", "sandbag", "jerrycan", "pallet"]);
const DISPLAY_ANCHORS = ["screen_centre", "glass_centre", "panel_centre"];
export const HOLD_TOLERANCE = 0.03; // m: a grip centre this close to a grip of an object is a hand on that grip
const IN2M = 0.0254;
// body-to-surface clearance (5.6.2.2): skin landmarks of the head and of the body; hands are left out (they touch the controls on purpose)
export const HEAD_MARKS = ["vertex", "glabella", "opisthocranion", "euryon_L", "euryon_R", "pronasale", "menton"];
export const BODY_MARKS = ["acromion_L", "acromion_R", "deltoid_L", "deltoid_R", "olecranon_L", "olecranon_R", "chest_front", "scapula_back_L", "scapula_back_R",
  "trochanterion_L", "trochanterion_R", "knee_front_L", "knee_front_R", "knee_top_L", "knee_top_R", "toe_tip_L", "toe_tip_R", "heel_L", "heel_R", "buttock_extremity"];
// landmarks that rest on a support: a surface below them (the floor, a seat pan) or behind the back (a seat back) is contact, not a clearance
const RESTS_BELOW = new Set(["toe_tip_L", "toe_tip_R", "heel_L", "heel_R", "buttock_extremity"]), RESTS_BEHIND = new Set(["scapula_back_L", "scapula_back_R", "buttock_extremity"]);
export const CLEAR_RADIUS = 0.3; // m: surfaces farther than this from every landmark are "clear"
const CLEARANCE_TYPES = new Set(["cabin_shell", "cad_model"]), DESK_TYPES = new Set(["desk", "console"]), WALL_TYPES = new Set(["wall", "partition"]);
const DESK_WALL_RANGE = 3; // m: a wall farther than this behind a desk's user is not part of that workspace
const fin = (v) => typeof v === "number" && Number.isFinite(v);

/** The stance that picks the mounting-height figures: "seated", "kneeling", "squatting", "lying" or "standing". */
export function stanceOf(place, posture, angles) {
  const carriers = Object.values(place?.carriers ?? {});
  const sup = String(place?.support ?? posture?.support ?? "feet");
  if (carriers.includes("seat") && place?.mode !== "free") return "seated";
  if (sup === "body") return "lying";
  if (/knees|shins/.test(sup)) return "kneeling";
  const kf = Math.max(angles?.knee_L?.[0] ?? 0, angles?.knee_R?.[0] ?? 0);
  if (kf > 100) return "squatting";
  return "standing";
}

/** A short name of the body for the report: the profile's label (population, percentile, sex). */
export function bodyLabel(profile, body) {
  const p = profile ?? {};
  const pct = p.source?.percentile;
  return p.label || (fin(pct) ? `P${pct} ${p.sex === "F" ? "woman" : "man"}` : body?.label ?? "this body");
}

/** The facts of the scene that checkScene reads (plain data, metres and degrees). Never throws for a missing piece. */
export function sceneFacts({ rig, editor, sandbox = null, profile = null }) {
  if (!rig || !editor) return null;
  const info = editor.info(), place = info.place, pose = rig.getPose();
  let posture = null;
  try { posture = info.base.id ? editor.getPosture(info.base.id) : null; } catch { posture = null; }
  const stance = stanceOf(place, posture, pose.angles);
  const v = new THREE.Vector3();
  const L = (id) => { try { return rig.landmarkWorld(id, v).toArray(); } catch { return null; } };
  const heading = info.metrics?.bodyHeading ?? place.heading ?? 0;
  const fwd = [Math.sin(heading * Math.PI / 180), Math.cos(heading * Math.PI / 180)];
  const eye = L("eye_mid"), pelvis = (() => { try { return rig.jointWorld("pelvis", new THREE.Vector3()).toArray(); } catch { return null; } })();
  const seatObj = place.seat?.kind === "object" && sandbox ? sandbox.objects.get(place.seat.objectId) : null;
  const facts = {
    body: { label: bodyLabel(profile, rig.restBody ?? rig.body), percentile: profile?.source?.percentile ?? null, sex: profile?.sex ?? null },
    stance, heading, eye,
    seatHeight: stance === "seated" ? editor.seatHeight?.() ?? null : null,
    feetGap: stance === "seated" && fin(info.gaps?.feet) ? info.gaps.feet : null,
    seat: seatObj ? { id: seatObj.id, name: seatObj.name, type: seatObj.type } : null,
    holds: [], displays: [], load: null,
  };
  if (!sandbox) return facts;
  const grip = { L: L("grip_centre_L"), R: L("grip_centre_R") };
  const held = new Map(); // objectId -> sides
  for (const o of sandbox.objects.values()) {
    if (!o.visible) continue;
    // hands on grips
    let grips = [];
    try { grips = sandbox.gripsWorld(o.id); } catch { grips = []; }
    for (const s of ["L", "R"]) {
      if (!grip[s]) continue;
      let best = null, bd = HOLD_TOLERANCE;
      for (const g of grips) { const d = g.position.distanceTo(v.set(...grip[s])); if (d <= bd) { bd = d; best = g; } }
      if (best) {
        facts.holds.push({ objectId: o.id, name: o.name, type: o.type, gripId: best.id, label: best.label, side: s, position: best.position.toArray() });
        held.set(o.id, [...(held.get(o.id) ?? []), s]);
      }
    }
    // displays
    const anchor = DISPLAY_ANCHORS.find((a) => Object.hasOwn(o._anchors ?? {}, a));
    if (anchor && eye) {
      const c = sandbox.anchorWorld(o.id, anchor, new THREE.Vector3());
      if (c) {
        const edges = {};
        for (const k of ["left", "right", "top", "bottom"]) { const e = sandbox.anchorWorld(o.id, `${k}_edge`, new THREE.Vector3()); if (e) edges[k] = e; }
        const vi = viewInfo(new THREE.Vector3(...eye), c, { ...edges, normal: sandbox.anchorNormalWorld(o.id, anchor, new THREE.Vector3()) });
        const dx = c.x - eye[0], dz = c.z - eye[2], along = dx * fwd[0] + dz * fwd[1];
        const lateral = pelvis ? (c.x - pelvis[0]) * fwd[1] - (c.z - pelvis[2]) * fwd[0] : null;
        const diag = o.type === "wall_display" && fin(o.params?.diagonal) ? o.params.diagonal * IN2M : null;
        facts.displays.push({ id: o.id, name: o.name, type: o.type, centre: c.toArray(), distance: vi.distance, declination: vi.declination, incidence: vi.incidence, lateral, diagonal: diag, inFront: along > 0.05 });
      }
    }
  }
  relationFacts(facts, sandbox, L, fwd);
  // the load in the hands: a load object held by at least one hand
  for (const [oid, sides] of held) {
    const o = sandbox.objects.get(oid);
    if (!LOAD_TYPES.has(o.type) || !fin(o.params?.mass) || o.params.mass <= 0) continue;
    const g = loadGeometry(L, sides.map((s) => `grip_centre_${s}`), heading);
    const pl = postureLoad({ ...(posture ?? {}), hints: { load: { mass: o.params.mass } } });
    facts.load = { objectId: o.id, name: o.name, mass: o.params.mass, ...(g ?? {}), carrying: !!pl?.carrying && !pl?.bodyWorn, carriers: 1 };
    break;
  }
  return facts;
}

/**
 * The relations between objects and between the figure and an object that 1472H measures in the scene (facts.cabins, facts.clearances, facts.desks,
 * facts.walls): the head room above each seat inside a cabin (Figure 39), the gap from the figure's skin to the surfaces of a cabin or an imported model
 * (5.6.2.2.1 to 5.6.2.2.4) and the space from a desk's user edge to the wall behind its user (Figure 58 D).
 */
function relationFacts(facts, sandbox, L, fwd) {
  const all = [...sandbox.objects.values()].filter((o) => o.visible);
  const box = new THREE.Box3(), pt = new THREE.Vector3(), dir = new THREE.Vector3();
  facts.cabins = []; facts.clearances = []; facts.desks = []; facts.walls = [];
  // head room above every seat inside a cabin
  const seats = all.filter((o) => Object.hasOwn(o._anchors ?? {}, "srp"));
  for (const c of all.filter((o) => o.type === "cabin_shell")) {
    const idx = surfaceIndex(c), entry = { id: c.id, name: c.name, seats: [] };
    for (const s of seats) {
      const srp = sandbox.anchorWorld(s.id, "srp", new THREE.Vector3());
      if (!srp) continue;
      const lp = sandbox.worldToLocal(c.id, srp.clone());
      const p = c.params, f = p.floor ?? 0;
      if (Math.abs(lp.x) > p.width / 2 + 0.01 || Math.abs(lp.z) > p.length / 2 || lp.y < f - 0.05 || lp.y > f + p.height) continue;
      entry.seats.push({ id: s.id, name: s.name, clearance: rayHit(idx, srp.toArray(), [0, 1, 0], 5) });
    }
    facts.cabins.push(entry);
  }
  // the figure's skin to the surfaces of cabins and imported models
  const marks = [...HEAD_MARKS.map((id) => [id, "head"]), ...BODY_MARKS.map((id) => [id, "body"])].map(([id, part]) => ({ id, part, p: L(id) })).filter((m) => m.p);
  const fig = new THREE.Box3();
  for (const m of marks) fig.expandByPoint(pt.set(...m.p));
  const side = [fwd[1], -fwd[0]];
  for (const o of all.filter((x) => CLEARANCE_TYPES.has(x.type))) {
    const idx = surfaceIndex(o), entry = { id: o.id, name: o.name, type: o.type, measured: false, near: false, hits: [] };
    facts.clearances.push(entry);
    if (!idx || fig.isEmpty()) continue;
    entry.measured = true;
    box.setFromObject(o.model).expandByScalar(CLEAR_RADIUS);
    if (!box.intersectsBox(fig)) continue;
    entry.near = true;
    for (const m of marks) {
      const h = nearestSurface(idx, m.p, CLEAR_RADIUS);
      if (!h) continue;
      const d = [m.p[0] - h.point[0], m.p[1] - h.point[1], m.p[2] - h.point[2]];
      const fore = d[0] * fwd[0] + d[2] * fwd[1], lat = d[0] * side[0] + d[2] * side[1], vert = d[1];
      const axis = Math.abs(vert) >= Math.abs(fore) && Math.abs(vert) >= Math.abs(lat) ? "vertical" : Math.abs(fore) >= Math.abs(lat) ? "fore-aft" : "lateral";
      if (axis === "vertical" && vert > -0.03 && RESTS_BELOW.has(m.id)) continue; // standing or sitting on it (or sunk a little into a floor slab)
      if (axis === "fore-aft" && fore > 0 && RESTS_BEHIND.has(m.id)) continue; // leaning on a seat back
      entry.hits.push({ landmark: m.id, part: m.part, axis, distance: h.distance });
    }
  }
  // desk to wall: from each desk's user edge, along the direction its user faces away from it, to the nearest wall or partition
  const walls = all.filter((o) => WALL_TYPES.has(o.type)), facing = new Map(walls.map((w) => [w.id, 0]));
  for (const d of all.filter((o) => DESK_TYPES.has(o.type))) {
    const edge = sandbox.anchorWorld(d.id, "user_edge", new THREE.Vector3());
    if (!edge) continue;
    d.group.updateMatrixWorld(true);
    dir.set(0, 0, 1).transformDirection(d.group.matrixWorld).setY(0).normalize();
    const origin = [edge.x, Math.min(edge.y, 0.9), edge.z];
    let best = null;
    for (const w of walls) {
      const t = rayHit(surfaceIndex(w), origin, dir.toArray(), DESK_WALL_RANGE);
      if (t != null && (!best || t < best.distance)) best = { wallId: w.id, wallName: w.name, distance: t };
    }
    if (!best) continue;
    facing.set(best.wallId, facing.get(best.wallId) + 1);
    facts.desks.push({ id: d.id, name: d.name, type: d.type, ...best });
  }
  for (const w of walls) facts.walls.push({ id: w.id, name: w.name, desks: facing.get(w.id) });
}

/** Group results by their subject: [{ subject, results, summary }] in first-seen order. */
function bySubject(results) {
  const map = new Map();
  for (const r of results) {
    const k = r.subject?.id ?? r.subject?.name ?? "?";
    if (!map.has(k)) map.set(k, { subject: r.subject, results: [] });
    map.get(k).results.push(r);
  }
  return [...map.values()].map((g) => ({ ...g, summary: summarize(g.results) }));
}

/**
 * The whole report: the current pose (ranges of motion, the posture's load), every visible object (its dimensions), every interaction (seat, grips,
 * displays, the load in the hands) and the population rule. { summary, posture, interactions, objects, population, results, facts }.
 */
export function complianceReport({ rig, editor, sandbox = null, profile = null }) {
  if (!rig || !editor) return null;
  const info = editor.info(), pose = rig.getPose(), body = rig.restBody ?? rig.body;
  let posture = null;
  try { posture = info.base.id ? editor.getPosture(info.base.id) : null; } catch { posture = null; }
  const meta = { ...(posture ?? {}), id: info.base.id, name: `${info.base.name}${info.modified && !/\(edited\)$/.test(info.base.name) ? " (edited)" : ""}`, support: info.place.support, category: posture?.category ?? "" };
  // a library load only while nothing of the scene is held (the scene's object then says what the load is)
  const facts = sceneFacts({ rig, editor, sandbox, profile });
  if (facts?.load) meta.hints = { ...(meta.hints ?? {}), load: undefined };
  const p = checkPosture(body, { root: pose.root, angles: pose.angles }, meta);
  const objects = [];
  if (sandbox) {
    for (const o of sandbox.objects.values()) {
      if (!o.visible) continue;
      let grips = [];
      try { grips = byType(o.type).grips(o.params); } catch { grips = []; }
      const results = checkObject(o, { grips });
      if (results.length) objects.push({ object: { id: o.id, name: o.name, type: o.type }, results, summary: summarize(results) });
    }
  }
  const scene = checkScene(facts);
  // a statement measured in the scene replaces the object's own "needs information" item it answers (subject.covers)
  const covered = new Set(scene.flatMap((r) => (r.subject?.covers ?? []).map((c) => `${c.objectId}|${c.id}`)));
  for (const g of objects) {
    const kept = g.results.filter((r) => !covered.has(`${g.object.id}|${r.id}`));
    if (kept.length !== g.results.length) { g.results = kept; g.summary = summarize(kept); }
  }
  // an object whose every item was answered in the scene (a wall: desk to wall) is reported under that relation only
  for (let i = objects.length - 1; i >= 0; i--) if (!objects[i].results.length) objects.splice(i, 1);
  const interactions = bySubject(scene.filter((r) => r.subject?.kind === "interaction"));
  const population = scene.filter((r) => r.subject?.kind === "population");
  const results = [...p.results, ...interactions.flatMap((g) => g.results), ...objects.flatMap((g) => g.results), ...population];
  return { standard: STANDARD, summary: summarize(results), posture: { subject: { kind: "posture", id: meta.id, name: meta.name }, results: p.results, summary: summarize(p.results), context: p.context }, interactions, objects, population, results, facts };
}

/** The interactions and the object's own results that concern one object: { results, summary } (for the Scene panel's rows). */
export function objectCompliance(report, objectId) {
  if (!report) return null;
  const own = report.objects.find((g) => g.object.id === objectId)?.results ?? [];
  const concerns = (sj) => (sj?.objects ?? [String(sj?.id ?? "").split(":")[1]]).includes(objectId);
  const inter = report.interactions.filter((g) => concerns(g.subject)).flatMap((g) => g.results);
  const results = [...own, ...inter];
  return results.length ? { results, summary: summarize(results) } : null;
}

const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** CSV of the report: subject, clause, title, level, status, value, unit, limit, note, page. */
export function reportCSV(report) {
  const head = ["subject_kind", "subject", "clause", "title", "level", "status", "value", "unit", "limit", "note", "page"];
  const rows = (report?.results ?? []).map((r) => [r.subject?.kind, r.subject?.name, clauseRef(r), r.title, r.level, r.status, r.value == null ? "" : Math.round(r.value * 100) / 100, r.unit, r.limit, r.note, r.page]);
  const top = [`# ${STANDARD.id} (${STANDARD.date}) check of the Digital human scene: ${STATUS_WORD[report?.summary?.status] ?? "not checked"}`, `# Body: ${report?.facts?.body?.label ?? ""}`, "# Checked on a simplified model; read the clause in the standard before you rely on a result."];
  return `${top.join("\n")}\n${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

export { LIFT };
