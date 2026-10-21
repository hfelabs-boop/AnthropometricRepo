// Ergonomic correction: finds a nearby pose in which the flagged postural measures fall inside the acceptable limits of ISO 11226 (and the
// REBA / RULA neutral ranges, see metrics.js), while the hands stay on the task and every joint stays in its range of motion.
//
// Method: coordinate descent over the postural joints (spine, neck, head, shoulders, arms, hips, knees, ankles). The cost of a pose is
//   3 per "high" flag + 1 per "caution" flag  +  excess degrees beyond the limit / 10  +  20 per metre a palm moves beyond 5 cm  +  a tiny
// tie-break on the total angle change. A move is kept only when it lowers the cost; joints are clamped to their ranges with clampAngles.
// Pure (no DOM, no scene): the caller applies the result through the editor, which re-grounds the figure and checks balance.
//
// What it cannot do: change the task. The palms may move 5 cm free and never more than MAX_HAND_MOVE (15 cm); a flag that the joints cannot
// fix within that limit (a seat that is too low, a load held far away, a reach to a far target) remains, and the result says so.
import { postureMetrics, ergonomicFlags, ISO_11226 } from "./metrics.js";
import { JOINT_BY_ID, clampAngles } from "./skeleton.js";
import { landmarkPosition, expandPosture, placePose } from "./pose.js";

const D2R = Math.PI / 180;
export const HAND_TOLERANCE = 0.05; // m a palm may move without cost
export const MAX_HAND_MOVE = 0.15;  // m: a correction that moves a palm further is not offered
export const WEIGHT = Object.freeze({ high: 3, caution: 1, ok: 0 });

// The joints the search may move. The pelvis (the root) is not among them: moving it would change the placement, which the editor owns.
export const CORRECTABLE = Object.freeze([
  "L5", "L4", "L3", "L2", "L1", "T12", "T11", "T10", "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T1",
  "C7", "C6", "C5", "C4", "C3", "C2", "C1", "head",
  "clavicle_L", "clavicle_R", "shoulder_L", "shoulder_R", "elbow_L", "elbow_R", "wrist_L", "wrist_R",
  "hip_L", "hip_R", "knee_L", "knee_R", "ankle_L", "ankle_R",
]);

/** The degrees by which a flagged measure is beyond its acceptable limit (0 when it is not flagged). */
export function excessOf(flag) {
  if (!flag || flag.severity === "ok") return 0;
  const v = flag.value, id = flag.id;
  if (id === "trunk-inclination") return Math.max(0, Math.abs(v) - ISO_11226.trunk.acceptable);
  if (id === "head-inclination") return Math.max(0, v - ISO_11226.head.acceptable);
  if (id === "neck-flexion") return Math.max(0, v - ISO_11226.neck.acceptable, -v - ISO_11226.slackDeg);
  if (id === "trunk-symmetry") return Math.max(0, v - ISO_11226.trunkSymmetry.cautionDeg);
  if (id.startsWith("upper-arm-elevation")) return Math.max(0, v - ISO_11226.upperArm.acceptable);
  if (id.startsWith("knee-flexion")) return Math.max(0, v - ISO_11226.knee.cautionDeg);
  if (id.startsWith("elbow-")) { const [lo, hi] = ISO_11226.elbow.flexionRange; return Math.max(0, lo - v, v - hi); }
  if (id.startsWith("wrist-flexion")) return Math.max(0, Math.abs(v) - ISO_11226.wrist.flexionDeg);
  if (id.startsWith("wrist-deviation")) return Math.max(0, Math.abs(v) - ISO_11226.wrist.deviationDeg);
  return 0;
}

/** The verdict of a pose: "not-acceptable" (a high flag), "check" (a caution flag) or "acceptable". */
export function verdictOf(flags) {
  if (flags.some((f) => f.severity === "high")) return "not-acceptable";
  if (flags.some((f) => f.severity === "caution")) return "check";
  return "acceptable";
}

/** Flags of a pose, as the Posture panel shows them: { flags, verdict, counts: { high, caution, ok } }. */
export function assessPosture(body, pose, flagOptions = {}) {
  const m = postureMetrics(body, { root: pose.root, angles: pose.angles }, pose.root, {});
  const flags = ergonomicFlags(m, flagOptions);
  const counts = { high: 0, caution: 0, ok: 0 };
  for (const f of flags) counts[f.severity] += 1;
  return { flags, verdict: verdictOf(flags), counts, metrics: m };
}

function palms(body, pose) {
  const out = {};
  for (const s of ["L", "R"]) {
    try { out[s] = landmarkPosition(body, pose, pose.root, `palm_centre_${s}`).toArray(); } catch { out[s] = null; }
  }
  return out;
}

const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0);

/**
 * Search for the nearest acceptable pose. pose: { root, angles } (angles: every joint, degrees). options: { flagOptions (as ergonomicFlags:
 * seated, trunkSupport, headSupport, armSupport), sweeps (default 8), steps (degrees, default [10, 3]) }.
 * Returns { angles, before: flags, after: flags, verdictBefore, verdictAfter, cost: { before, after }, hands: { L, R } (metres each palm moved),
 * changed: number of joints moved, changedJoints: [ids], sweeps, evaluations }. `angles` is a fresh object; the input is never mutated.
 */
export function correctAngles(body, pose, options = {}) {
  const flagOptions = options.flagOptions ?? {};
  const sweeps = options.sweeps ?? 8, steps = options.steps ?? [10, 3];
  const root = pose.root;
  // a working copy with every correctable joint listed (missing joints are neutral)
  const start = {};
  for (const id of CORRECTABLE) start[id] = Array.from(pose.angles?.[id] ?? JOINT_BY_ID[id].dof.map(() => 0));
  const others = {};
  for (const [id, a] of Object.entries(pose.angles ?? {})) if (!(id in start)) others[id] = Array.from(a);
  const palm0 = palms(body, { root, angles: { ...others, ...start } });

  const vars = [];
  for (const id of CORRECTABLE) JOINT_BY_ID[id].dof.forEach((d, k) => vars.push({ id, k, min: d.min, max: d.max }));

  let evaluations = 0;
  const evaluate = (angles) => {
    evaluations += 1;
    const cur = { ...others, ...angles };
    const m = postureMetrics(body, { root, angles: cur }, root, {});
    const flags = ergonomicFlags(m, flagOptions);
    let c = 0;
    for (const f of flags) c += WEIGHT[f.severity] + excessOf(f) / 10;
    const p = palms(body, { root, angles: cur });
    for (const s of ["L", "R"]) c += 20 * Math.max(0, dist(p[s], palm0[s]) - HAND_TOLERANCE);
    // a palm moved further than MAX_HAND_MOVE would change the task: such a pose is never chosen
    for (const s of ["L", "R"]) if (dist(p[s], palm0[s]) > MAX_HAND_MOVE) c += 1000;
    return { c, flags };
  };

  const work = JSON.parse(JSON.stringify(start));
  const touched = new Set(); // joints the search actually moved: the others keep their values exactly
  const at = (v) => work[v.id][v.k];
  const first = evaluate(work);
  let best = first.c, bestFlags = first.flags;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (const v of vars) {
      if (bestFlags.length === 0) break;
      const original = at(v);
      for (const step of steps) {
        let moved = false;
        for (const sign of [1, -1]) {
          const next = Math.min(v.max, Math.max(v.min, original + sign * step));
          if (next === at(v)) continue;
          const old = work[v.id][v.k];
          work[v.id][v.k] = next;
          const clamped = clampAngles(v.id, work[v.id]).angles;
          work[v.id] = clamped;
          const r = evaluate(work);
          if (r.c < best - 1e-9) { best = r.c; bestFlags = r.flags; improved = true; moved = true; touched.add(v.id); break; }
          work[v.id][v.k] = old;
        }
        if (moved) break; // keep the first improvement at the coarse step, then refine
      }
    }
    if (!improved) break;
  }

  const angles = { ...others };
  const changedJoints = [];
  for (const id of CORRECTABLE) {
    if (!touched.has(id)) { angles[id] = Array.from(start[id]); continue; }
    angles[id] = clampAngles(id, work[id].map((v) => +v.toFixed(3))).angles; // clamp after rounding: rounding must not leave a value past its limit
    if (angles[id].some((v, k) => Math.abs(v - (start[id][k] ?? 0)) > 1e-6)) changedJoints.push(id);
  }
  const palm1 = palms(body, { root, angles: { ...others, ...angles } });
  const beforeFlags = assessPosture(body, { root, angles: { ...others, ...start } }, flagOptions).flags;
  const afterFlags = assessPosture(body, { root, angles }, flagOptions).flags;
  return {
    angles,
    before: beforeFlags,
    after: afterFlags,
    verdictBefore: verdictOf(beforeFlags),
    verdictAfter: verdictOf(afterFlags),
    cost: { before: first.c, after: best },
    hands: { L: dist(palm1.L, palm0.L), R: dist(palm1.R, palm0.R) },
    changed: changedJoints.length,
    changedJoints,
    evaluations,
  };
}

/** Flags that the correction fixed, kept, or made worse, matched by id: [{ id, label, before, after, status }]. */
export function compareFlags(before, after) {
  const A = new Map(after.map((f) => [f.id, f]));
  const rows = [];
  const ids = new Set([...before.map((f) => f.id), ...after.map((f) => f.id)]);
  for (const id of ids) {
    const b = before.find((f) => f.id === id), a = A.get(id);
    const label = (b ?? a).label;
    const rank = { ok: 0, caution: 1, high: 2 };
    const sb = b?.severity ?? "ok", sa = a?.severity ?? "ok";
    const status = rank[sa] < rank[sb] ? "fixed" : rank[sa] > rank[sb] ? "worse" : sa === "ok" ? "ok" : "unchanged";
    rows.push({ id, label, before: b ? { value: b.value, severity: sb } : null, after: a ? { value: a.value, severity: sa } : null, status });
  }
  const order = { worse: 0, unchanged: 1, fixed: 2, ok: 3 };
  return rows.sort((x, y) => order[x.status] - order[y.status] || x.label.localeCompare(y.label));
}


const VERDICTS = new WeakMap();
/**
 * The ergonomic verdict of a library posture on a body, as the library cards show it: { verdict, counts } (memoised per posture object and body).
 * Seated postures are judged seated. Never throws: a posture that cannot be placed on the body gets verdict null.
 */
export function postureVerdict(body, posture) {
  let m = VERDICTS.get(posture);
  if (!m) VERDICTS.set(posture, (m = new WeakMap()));
  if (m.has(body)) return m.get(body);
  let out;
  try {
    const e = expandPosture(posture);
    const pl = placePose(body, { root: e.root, angles: e.angles }, { support: posture.support });
    const seated = posture.support === "seat" || posture.support === "seat+feet";
    const a = assessPosture(body, { root: { ...e.root, ...pl }, angles: e.angles }, { seated });
    out = { verdict: a.verdict, counts: a.counts };
  } catch { out = { verdict: null, counts: null }; }
  m.set(body, out);
  return out;
}
