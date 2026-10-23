// The MIL-STD-1472H report of the figure in its scene: reads the rig, the posture editor and the sandbox, turns them into plain facts and runs the checks of
// mil1472.js on them. No DOM: the Posture, Scene and Analysis panels call `complianceReport` and draw what it returns (docs/human3d/MIL_STD_1472H.md).
//
//   sceneFacts({ rig, editor, sandbox, profile })      -> the facts checkScene reads (stance, seat, hands on grips, displays in view, the load in the hands)
//   complianceReport({ rig, editor, sandbox, profile }) -> { summary, posture, interactions, objects, population, results }
//   reportCSV(report)                                   -> the report as CSV text, one row per result
import * as THREE from "three";
import { byType } from "./catalog.js";
import { viewInfo } from "./measure.js";
import { checkPosture, checkObject, checkScene, summarize, loadGeometry, postureLoad, LIFT, clauseRef, STANDARD, STATUS_WORD } from "./mil1472.js";

const LOAD_TYPES = new Set(["crate", "small_box", "ammo_can", "toolbox", "rucksack", "drum", "sandbag", "jerrycan", "pallet"]);
const DISPLAY_ANCHORS = ["screen_centre", "glass_centre", "panel_centre"];
export const HOLD_TOLERANCE = 0.03; // m: a grip centre this close to a grip of an object is a hand on that grip
const IN2M = 0.0254;
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
  const interactions = bySubject(scene.filter((r) => r.subject?.kind === "interaction"));
  const population = scene.filter((r) => r.subject?.kind === "population");
  const results = [...p.results, ...interactions.flatMap((g) => g.results), ...objects.flatMap((g) => g.results), ...population];
  return { standard: STANDARD, summary: summarize(results), posture: { subject: { kind: "posture", id: meta.id, name: meta.name }, results: p.results, summary: summarize(p.results), context: p.context }, interactions, objects, population, results, facts };
}

/** The interactions and the object's own results that concern one object: { results, summary } (for the Scene panel's rows). */
export function objectCompliance(report, objectId) {
  if (!report) return null;
  const own = report.objects.find((g) => g.object.id === objectId)?.results ?? [];
  const inter = report.interactions.filter((g) => String(g.subject?.id ?? "").split(":")[1] === objectId).flatMap((g) => g.results);
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
