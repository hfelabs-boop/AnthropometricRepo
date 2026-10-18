// The posture library: the 13 group files of postures/ in the order of CATEGORIES, the hand-grip presets and lookups.
// Data only: every entry is a Posture (typedef in pose.js, DESIGN.md 2.4); validatePosture() in pose.js is the acceptance test
// (tests/human3d/postures.test.mjs runs it on six bodies). An id that occurs twice is an Error at import time, so that a collision is
// found by whoever adds the second one.
import { CATEGORIES } from "./pose.js";
import { GRIPS } from "./postures/grips.js";
import standing from "./postures/standing.js";
import sitting from "./postures/sitting.js";
import leaning from "./postures/leaning.js";
import holding from "./postures/holding.js";
import lifting from "./postures/lifting.js";
import reaching from "./postures/reaching.js";
import kneeling from "./postures/kneeling.js";
import lying from "./postures/lying.js";
import locomotion from "./postures/locomotion.js";
import work from "./postures/work.js";
import military from "./postures/military.js";
import vehicle from "./postures/vehicle.js";
import reference from "./postures/reference.js";

export { CATEGORIES, GRIPS };

/** The group files by category id (the ids of CATEGORIES), in display order: [{ id, category (name), postures }]. */
export const GROUPS = Object.freeze(
  Object.entries({ standing, sitting, leaning, holding, lifting, reaching, kneeling, lying, locomotion, work, military, vehicle, reference }).map(([id, postures]) => {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (!cat) throw new Error(`postures.js: group file "${id}" has no entry in CATEGORIES`);
    if (!Array.isArray(postures)) throw new Error(`postures/${id}.js must export default an array of postures`);
    return Object.freeze({ id, category: cat.name, postures });
  })
);

/** Every posture of the library, in group order. */
export const POSTURES = Object.freeze(GROUPS.flatMap((g) => g.postures));

/**
 * Index postures by id; throws an Error naming both files when an id occurs twice (or an entry has no string id). Runs at import time on the
 * real library; exported so that the tests can check it on a made-up one.
 * @param {{id: string, postures: object[]}[]} groups
 * @returns {Map<string, {posture: object, file: string}>}
 */
export function indexGroups(groups) {
  const index = new Map();
  for (const g of groups) {
    for (const p of g.postures) {
      const id = p?.id;
      if (typeof id !== "string") throw new Error(`postures/${g.id}.js: a posture has no string id (${JSON.stringify(p)?.slice(0, 80)})`);
      if (index.has(id)) throw new Error(`duplicate posture id "${id}" (in postures/${g.id}.js and postures/${index.get(id).file}.js)`);
      index.set(id, { posture: p, file: g.id });
    }
  }
  return index;
}
const BY_ID = indexGroups(GROUPS);

/** The posture with this id, or undefined. */
export function byId(id) {
  return BY_ID.get(id)?.posture;
}

/** { [category name]: Posture[] } for all 13 categories in display order (empty arrays included). */
export function byCategory() {
  return Object.fromEntries(GROUPS.map((g) => [g.category, g.postures.slice()]));
}

const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/**
 * Postures matching a query: every word (separated by blanks) must occur in the name, description, tags or category, case and diacritics
 * ignored ("squat lift" finds the postures that contain both words anywhere). An empty query returns the whole library.
 */
export function search(query) {
  const words = fold(query ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return POSTURES.slice();
  return POSTURES.filter((p) => {
    const hay = fold([p.name, p.description, (p.tags ?? []).join(" "), p.category].join(" "));
    return words.every((w) => hay.includes(w));
  });
}
