// Anthropometric profiles for the Digital human tab: load a population (static api/v1 files), pick a percentile, take a real person from
// the in-browser database, import/export JSON or CSV, edit a value. Pure module: no DOM; fetch and the SQL query function are injectable.
// Profile shape: docs/human3d/DESIGN.md 2.1. Lengths stay in mm and mass in kg (fit.js converts to metres).

// ---------------------------------------------------------------------------------------------------------------- percentile maths
// The website must agree with the API, so this is a port of anthro_service/core.py (quantile, skewed_positive, Z95, Z_MIN, _round).

// Wichura (1988), "Algorithm AS241: The Percentage Points of the Normal Distribution", Applied Statistics 37(3), PPND16, the same routine
// as Python's statistics.NormalDist.inv_cdf (coefficients copied from CPython 3.11). Relative error about 1e-16. Highest order first.
const A = [2.5090809287301226727e+3, 3.3430575583588128105e+4, 6.7265770927008700853e+4, 4.5921953931549871457e+4, 1.3731693765509461125e+4, 1.9715909503065514427e+3, 1.3314166789178437745e+2, 3.3871328727963666080e+0];
const B = [5.2264952788528545610e+3, 2.8729085735721942674e+4, 3.9307895800092710610e+4, 2.1213794301586595867e+4, 5.3941960214247511077e+3, 6.8718700749205790830e+2, 4.2313330701600911252e+1, 1];
const C = [7.74545014278341407640e-4, 2.27238449892691845833e-2, 2.41780725177450611770e-1, 1.27045825245236838258e+0, 3.64784832476320460504e+0, 5.76949722146069140550e+0, 4.63033784615654529590e+0, 1.42343711074968357734e+0];
const D = [1.05075007164441684324e-9, 5.47593808499534494600e-4, 1.51986665636164571966e-2, 1.48103976427480074590e-1, 6.89767334985100004550e-1, 1.67638483018380384940e+0, 2.05319162663775882187e+0, 1];
const E = [2.01033439929228813265e-7, 2.71155556874348757815e-5, 1.24266094738807843860e-3, 2.65321895265761230930e-2, 2.96560571828504891230e-1, 1.78482653991729133580e+0, 5.46378491116411436990e+0, 6.65790464350110377720e+0];
const F = [2.04426310338993978564e-15, 1.42151175831644588870e-7, 1.84631831751005468180e-5, 7.86869131145613259100e-4, 1.48753612908506148525e-2, 1.36929880922735805310e-1, 5.99832206555887937690e-1, 1];
const horner = (c, x) => c.reduce((acc, k) => acc * x + k, 0);

/** Inverse of the standard normal CDF for 0 < p < 1 (AS241, ~1e-16 relative accuracy). Throws RangeError outside (0, 1). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in the range 0 < p < 1");
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return q * horner(A, r) / horner(B, r);
  }
  let r = Math.sqrt(-Math.log(q <= 0 ? p : 1 - p));
  let x;
  if (r <= 5) { r -= 1.6; x = horner(C, r) / horner(D, r); }
  else { r -= 5; x = horner(E, r) / horner(F, r); }
  return q < 0 ? -x : x;
}

const Z95 = normalQuantile(0.95);
const Z_MIN = Math.abs(normalQuantile(0.001)); // the service allows percentiles 0.1 to 99.9
export const MIN_PERCENTILE = 0.1, MAX_PERCENTILE = 99.9;

/** core.skewed_positive: the straight line through P5, P50, P95 would reach zero before P0.1 (skinfolds, body fat, ages). */
export function skewedPositive(p5, p50, p95) {
  return p5 > 0 && p50 > p5 && p50 - Z_MIN / Z95 * (p50 - p5) <= 0;
}

/** core.quantile: value at percentile p (percent) on the line through (z5, p5), (z50, p50), (z95, p95), linear in the normal score; below P5 the
 * line is replaced by its log-scale equivalent for skewed positive measures so it never goes negative. */
export function quantile(p5, p50, p95, p) {
  if (p === 5) return p5;
  if (p === 50) return p50;
  if (p === 95) return p95;
  const z = normalQuantile(p / 100);
  if (z >= 0) return p50 + z / Z95 * (p95 - p50);
  if (z < -Z95 && skewedPositive(p5, p50, p95)) return Math.exp(Math.log(p50) + z / Z95 * (Math.log(p50) - Math.log(p5)));
  return p50 + z / Z95 * (p50 - p5);
}

/** core._round: the decimals the service prints (mm 1, ratio 3, everything else 2). Python rounds the exact binary value and, on an exact decimal tie
 * (0.125 to 2 decimals), to the even digit; toFixed picks the larger one, so ties are handled here. A tie is only possible when |v| is j / 2^(d+1)
 * with j odd (then v * 10^d is exactly j * 5^d / 2), which is checked without any inexact multiplication. */
export function roundValue(v, unit) {
  if (v == null || !Number.isFinite(v)) return null;
  const d = unit === "mm" ? 1 : unit === "ratio" ? 3 : 2, j = Math.abs(v) * 2 ** (d + 1);
  if (Number.isSafeInteger(j) && j % 2 === 1 && Number.isSafeInteger(j * 5 ** d)) {
    let n = Math.floor(j * 5 ** d / 2);
    if (n % 2) n++;
    return (v < 0 ? -n : n) / 10 ** d;
  }
  return Number(v.toFixed(d));
}

const basisOf = pct => (pct === 5 || pct === 50 || pct === 95 ? "reported" : pct > 5 && pct < 95 ? "interpolated" : "extrapolated");
const finite3 = p => p && [p.p5, p.p50, p.p95].every(x => typeof x === "number" && Number.isFinite(x));

/** Value of one measure of a populations file ({percentiles:{p5,p50,p95}, ...}) at percentile `pct` (0.1 to 99.9), unrounded, exactly the service's
 * maths. basis: "reported" at 5/50/95 (what the file's own percentile_basis says is handled by percentileProfile), "interpolated" between,
 * "extrapolated" outside P5..P95; value null and basis "unavailable" when the file has no percentiles for the measure. */
export function valueAtPercentile(measure, pct) {
  if (typeof pct !== "number" || !(pct >= MIN_PERCENTILE && pct <= MAX_PERCENTILE)) throw new RangeError(`Percentile must be a number from ${MIN_PERCENTILE} to ${MAX_PERCENTILE}.`);
  const p = measure?.percentiles;
  if (!finite3(p)) return { value: null, basis: "unavailable" };
  return { value: quantile(p.p5, p.p50, p.p95, pct), basis: basisOf(pct) };
}

// ---------------------------------------------------------------------------------------------------------------- units, keys, labels
// The lookup tables below are plain objects keyed by text from files, so "constructor" or "__proto__" must not find Object.prototype members.
const own = (table, k) => (typeof k === "string" && Object.hasOwn(table, k) ? table[k] : undefined);
const ownIn = (obj, k) => (obj && typeof obj === "object" ? own(obj, k) : undefined); // for objects that come from a file: may be null or a string
const LENGTH_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const MASS_TO_KG = { kg: 1, lb: 0.45359237 };
const UNIT_ALIASES = {
  millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm", centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  meter: "m", meters: "m", metre: "m", metres: "m", inch: "in", inches: "in", '"': "in", kilogram: "kg", kilograms: "kg", kgs: "kg",
  pound: "lb", pounds: "lb", lbs: "lb", percent: "%", deg: "degrees", degree: "degrees", "°": "degrees", year: "years", yr: "years", yrs: "years", y: "years",
  "kg/m2": "kg/m²", "cm²": "cm2", n: "N", newton: "N", newtons: "N",
};
const OTHER_UNITS = new Set(["%", "ratio", "degrees", "years", "kg/m²", "cm2", "N", "au"]); // as-published units that pass through unchanged

/** Canonical unit string ("mm", "cm", "m", "in", "kg", "lb", "%", ...) or null when it is not one we know. */
export function canonicalUnit(u) {
  if (u == null) return null;
  const s = String(u).trim().toLowerCase().replace(/\.$/, "");
  const a = own(UNIT_ALIASES, s) ?? (s === "n" ? "N" : s);
  return own(LENGTH_TO_MM, a) || own(MASS_TO_KG, a) || OTHER_UNITS.has(a) ? a : null;
}

// Measures the fitting module uses as inputs (fit.js reads them; the lead engineer extends the list). Names are the harmonized and other: keys of api/v1.
export const SKELETON_MEASURES = Object.freeze([
  "stature", "mass", "sitting_height", "eye_height_sitting", "cervicale_height", "acromion_height", "suprasternale_height", "iliocristale_height",
  "trochanterion_height", "crotch_height", "other:lateral_femoral_epicondyle_height", "other:knee_height_midpatella", "other:lateral_malleolus_height",
  "other:wrist_height", "other:axilla_height", "buttock_knee_length", "buttock_popliteal_length", "popliteal_height", "knee_height_sitting",
  "thigh_clearance", "elbow_rest_height", "acromion_height_sitting", "hip_breadth_sitting", "biacromial_breadth", "bideltoid_breadth", "bicristal_breadth",
  "chest_breadth", "chest_depth", "abdominal_depth_sitting", "shoulder_elbow_length", "acromion_radiale_length", "radiale_stylion_length", "hand_length",
  "hand_breadth", "foot_length", "foot_breadth", "head_length", "head_breadth", "head_circumference", "bizygomatic_breadth", "menton_sellion_length",
  "neck_circumference", "chest_circumference", "waist_circumference", "buttock_circumference", "thigh_circumference", "calf_circumference",
  "biceps_circumference_flexed", "forearm_circumference_flexed", "wrist_circumference", "ankle_circumference", "span", "thumbtip_reach", "sleeve_outseam",
]);
const SKELETON_SET = new Set(SKELETON_MEASURES);
const BARE_TO_OTHER = new Map(SKELETON_MEASURES.filter(k => k.startsWith("other:")).map(k => [k.slice(6), k]));
const KEY_ALIASES = { height: "stature", body_height: "stature", standing_height: "stature", weight: "mass", body_weight: "mass", body_mass: "mass" };

// measures.json, once loaded (loadMeasures) or handed to setMeasureCatalog: key -> { name, unit, ... }
let catalogIndex = new Map();
const indexCache = new WeakMap();
function indexOf(catalog) {
  if (!catalog) return catalogIndex;
  if (catalog instanceof Map) return catalog;
  if (!Array.isArray(catalog)) return new Map(Object.entries(catalog));
  if (!indexCache.has(catalog)) indexCache.set(catalog, new Map(catalog.filter(m => m && typeof m.key === "string").map(m => [m.key, m])));
  return indexCache.get(catalog);
}
/** Remember the measure catalog (api/v1/measures.json) so labelOf / unitOf and the importers use the data's names and units. */
export function setMeasureCatalog(list) { catalogIndex = indexOf(list ?? []); }

/** Human label of a measure key: the catalog's name when known, else the key with `other:` dropped and underscores turned into spaces. */
export function labelOf(key, catalog) {
  const m = indexOf(catalog).get(key);
  if (m?.name) return String(m.name);
  const t = String(key).replace(/^other:/, "").replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// The measures of api/v1/measures.json whose unit is not mm (22 of 571), built in so that parseImport reads a file the same way before and after
// loadMeasures: the catalog extends these tables, it never changes the meaning of what they cover. Every other `other:` key is a length in mm.
const BUILTIN_UNITS = Object.freeze({
  mass: "kg", bmi: "kg/m²", age: "years", "other:weight_as_reported": "kg", "other:fat_free_mass": "kg", "other:fat_mass": "kg", "other:bone_mass": "kg",
  "other:lean_body_mass": "kg", "other:total_muscle_mass_kg": "kg", "other:fat_free_mass_kg": "kg", "other:muscle_mass": "kg", "other:skeletal_muscle_mass": "kg",
  "other:body_fat_percent": "%", "other:body_fat_percent_dexa": "%", "other:skeletal_muscle_percent": "%", "other:visceral_adipose_tissue_area": "cm2",
  "other:visceral_fat_level": "au", "other:handgrip_strength_left": "N", "other:handgrip_strength_right": "N", "other:seat_angle": "degrees",
  "other:waist_hip_ratio": "ratio", "other:waist_to_height_ratio": "ratio",
});

/** Unit of a measure key: the catalog's, else the built-in table above, else kg for masses and weights, else mm (lengths are stored in mm). */
export function unitOf(key, catalog) {
  const m = indexOf(catalog).get(key);
  if (m?.unit) return String(m.unit);
  const k = String(key);
  if (own(BUILTIN_UNITS, k)) return BUILTIN_UNITS[k];
  if (k === "bmi") return "kg/m²";
  if (/(^|[:_])age(_|$)/.test(k)) return "years";
  if (/(^|[:_])ratio(_|$)/.test(k)) return "ratio";
  if (/(^|[:_])(mass|weight)(_|$)/.test(k) && !/(^|_)(height|length|breadth|depth|circumference)(_|$)/.test(k)) return "kg";
  return "mm";
}
// bare (harmonized) keys: the fitter's inputs and the columns of the subjects table together cover every harmonized key of measures.json but bmi and age
const isKnownKey = (k, catalog) => k === "bmi" || k === "age" || SKELETON_SET.has(k) || SUBJECT_SET.has(k) || !!own(BUILTIN_UNITS, k) || indexOf(catalog).has(k);

const MAX_KEY = 80;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype", "tostring", "valueof", "hasownproperty"]);
/** A safe measure key from user text, or null: trimmed, lower case, spaces and hyphens as underscores, only a-z 0-9 _ and one leading `other:`. */
export function sanitiseKey(raw) {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_");
  if (!/^(other:)?[a-z0-9][a-z0-9_]*$/.test(k) || k.length > MAX_KEY || k.startsWith("__")) return null;
  return BLOCKED_KEYS.has(k.replace(/^other:/, "")) ? null : k;
}

/** Resolve a user's key to a harmonized or other: key and a unit hint from a suffix (stature_cm -> stature, cm). The suffix is cut only when what is left
 * is a key we know, because keys such as other:fat_free_mass_kg really end in a unit. */
function resolveKey(raw, catalog) {
  let k = sanitiseKey(raw);
  if (!k) return null;
  let hint = null;
  const m = /^(.+)_(mm|cm|m|in|kg|lb|lbs)$/.exec(k);
  if (m && !k.startsWith("other:") && !indexOf(catalog).has(k)) {
    const base = own(KEY_ALIASES, m[1]) ?? m[1];
    if (isKnownKey(base, catalog) || BARE_TO_OTHER.has(base)) { k = m[1]; hint = canonicalUnit(m[2]); }
  }
  k = own(KEY_ALIASES, k) ?? k;
  if (!k.startsWith("other:") && !isKnownKey(k, catalog) && BARE_TO_OTHER.has(k)) k = BARE_TO_OTHER.get(k);
  return { key: k, hint };
}

const LIMITS = {
  stature: { min: 800, max: 2500, unit: "mm", what: "0.8 to 2.5 m" },
  mass: { min: 10, max: 400, unit: "kg", what: "10 to 400 kg" },
};
// Smallest believable value (mm) of each length the fitter or the subjects table uses: 0.4 x the smallest value in this repo's data (13,792 people of
// four surveys and every populations file, P5/P50/P95; approx., adults of military populations), rounded down. A number below it is almost surely in cm,
// m or in with the unit left out (19.2 for a hand length, 0.85 for a waist), which would become a 19 mm hand. Lengths that are not listed (skinfolds,
// thicknesses, ...) only have to be positive. Stature has the wider LIMITS below, which also allow children.
const MIN_MM = Object.freeze({
  sitting_height: 299, eye_height_sitting: 253, cervicale_height: 473, acromion_height: 446, suprasternale_height: 452, iliocristale_height: 326,
  trochanterion_height: 264, crotch_height: 237, "other:lateral_femoral_epicondyle_height": 166, "other:knee_height_midpatella": 163,
  "other:lateral_malleolus_height": 19, "other:wrist_height": 291, "other:axilla_height": 458, buttock_knee_length: 186,
  buttock_popliteal_length: 146, popliteal_height: 119, knee_height_sitting: 162, thigh_clearance: 41, elbow_rest_height: 49,
  acromion_height_sitting: 185, hip_breadth_sitting: 107, biacromial_breadth: 113, bideltoid_breadth: 142, bicristal_breadth: 78, chest_breadth: 76,
  chest_depth: 56, abdominal_depth_sitting: 61, shoulder_elbow_length: 108, acromion_radiale_length: 99, radiale_stylion_length: 62, hand_length: 57,
  hand_breadth: 26, foot_length: 79, foot_breadth: 29, head_length: 63, head_breadth: 50, head_circumference: 200, bizygomatic_breadth: 44,
  menton_sellion_length: 36, neck_circumference: 108, chest_circumference: 268, waist_circumference: 239, buttock_circumference: 293,
  thigh_circumference: 164, calf_circumference: 106, biceps_circumference_flexed: 85, forearm_circumference_flexed: 80, wrist_circumference: 49,
  ankle_circumference: 62, span: 529, thumbtip_reach: 240, sleeve_outseam: 164, forearm_forearm_breadth: 149, neck_circumference_base: 119,
  shoulder_circumference: 340, vertical_trunk_circumference: 529, shoulder_length: 42, hand_circumference: 60, interpupillary_breadth: 18, ear_length: 17,
});

/** Convert a user's number to the data's unit (mm, kg, or an as-published unit) and reject nonsense. Throws Error with a message that says what to fix. */
export function toDataUnit(key, value, unit, catalog) {
  const want = unitOf(key, catalog), known = isKnownKey(key, catalog) || key === "stature" || key === "mass";
  const u = unit == null || unit === "" ? null : canonicalUnit(unit);
  if (unit != null && unit !== "" && !u) throw new Error(`Unknown unit "${String(unit).slice(0, 20)}" for ${key}. Use mm, cm, m, in, kg or lb.`);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The value for ${key} is not a finite number.`);
  let v = value, out = u ?? want;
  // converted values are rounded (0.01 mm, 0.001 kg: far below any measurement error) so 165 lb is 74.843 kg, not 74.84274105; a value already in mm or kg is kept as given
  if (u && LENGTH_TO_MM[u]) {
    if (known && want !== "mm") throw new Error(`${key} is measured in ${want} but was given in ${u}.`);
    v = u === "mm" ? value : Number((value * LENGTH_TO_MM[u]).toFixed(2)); out = "mm";
  } else if (u && MASS_TO_KG[u]) {
    if (known && want !== "kg") throw new Error(`${key} is measured in ${want} but was given in ${u}.`);
    v = u === "kg" ? value : Number((value * MASS_TO_KG[u]).toFixed(3)); out = "kg";
  } else if (u && known && u !== want) throw new Error(`${key} is measured in ${want} but was given in ${u}.`);
  const lim = own(LIMITS, key);
  if (lim && out === lim.unit) {
    if (!(v >= lim.min && v <= lim.max)) throw new Error(`${labelOf(key, catalog)} ${Math.round(v * 10) / 10} ${out} is outside ${lim.what}. Give the unit (mm, cm, m, in${out === "kg" ? ", lb" : ""}) if the number is in another one.`);
  } else if (out === "mm") {
    if (!(v > 0 && v <= 5000)) throw new Error(`${key} = ${Math.round(v * 10) / 10} mm is outside 0 to 5 m.`);
    const floor = own(MIN_MM, key);
    if (floor && v < floor) throw Object.assign(new Error(`${labelOf(key, catalog)} ${Math.round(v * 100) / 100} mm is too small for a person (at least ${floor} mm). Give the unit (cm, m, in) if the number is in another one.`), { tooSmall: true });
  } else if (out === "kg") {
    if (!(v > 0 && v <= 500)) throw new Error(`${key} = ${Math.round(v * 100) / 100} kg is outside 0 to 500 kg.`);
  } else if (Math.abs(v) > 1e6) throw new Error(`${key} = ${v} is out of range.`);
  else if (out === "years" && v < 0) throw new Error(`${key} is negative.`);
  return { value: v, unit: out };
}

// ---------------------------------------------------------------------------------------------------------------- profile helpers
export const STATUSES = Object.freeze(["reported", "estimated", "edited", "individual"]);
const BASES = new Set(["reported", "interpolated", "extrapolated", "scaled"]);
const RELIABILITIES = new Set(["high", "medium", "low"]);
const SEX_NAMES = { M: "men", F: "women", both: "mixed" };
const SEX_WORDS = { m: "M", male: "M", men: "M", man: "M", f: "F", female: "F", women: "F", woman: "F", both: "both", mixed: "both", b: "both", unknown: "both", "not stated": "both", "not-stated": "both" };
/** "M" | "F" | "both" from the words people use, else null. */
export function parseSex(s) { return typeof s === "string" ? own(SEX_WORDS, s.trim().toLowerCase()) ?? null : null; }

const cleanText = (s, max = 100) => (typeof s === "string" || typeof s === "number" ? String(s) : "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A sample size from a file: a whole number from 0 to 1e9 (or digits in a string, as in a CSV cell), else undefined. true, [5], 1e300 and "" are not sizes. */
const cleanN = v => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : undefined;
};

/** Reliability filter exactly as core.MIN_REL: high = high only, medium = high + medium, low / all = everything. */
const MIN_REL = { high: ["high"], medium: ["high", "medium"], low: ["high", "medium", "low"], all: ["high", "medium", "low"] };

const SURVEY_NOTES_DROP = [/^Population statistics for design studies/, /^The static files hold/];
const EST_NOTE = "percentiles estimated from the mean and SD";
const meanStatureNote = (percentile, sd) => "This file gives only a mean stature, no percentiles: the mean is used" + (percentile === 50 ? "" : sd ? ", spread by its SD at other percentiles" : " at every percentile") + ".";
const hiddenNote = (n, level) => `${n} value(s) hidden because their reliability is below '${level}'.`;
/** The reliability levels a populations file is read at: { allowed, level } for "high" | "medium" | "low" | "all" (any case), RangeError otherwise. */
function reliabilityFilter(minReliability) {
  const name = String(minReliability).toLowerCase(), allowed = own(MIN_REL, name);
  if (!allowed) throw new RangeError(`Unknown reliability level "${cleanText(minReliability, 20)}" (use high, medium, low or all).`);
  return { allowed, level: name === "all" ? "low" : name };
}
const fmt1 = v => (Math.round(v * 100) / 100).toString();

// proportional scaling: exponent of the stature ratio s = stature(P) / stature(P50) per unit (geometric similarity)
const SCALE_EXPONENT = { mm: 1, kg: 3, "kg/m²": 1, cm2: 2, N: 2 };

function statusFor(m, p) {
  const basis = m.percentile_basis || {};
  const est = k => basis[k] === "estimated";
  if (p === 5 || p === 50 || p === 95) return est("p" + p) ? "estimated" : "reported";
  if (p < 5 || p > 95) return "estimated"; // extrapolated
  return (p < 50 ? ["p5", "p50"] : ["p50", "p95"]).some(est) ? "estimated" : "reported"; // the two anchors the line between uses
}

/**
 * Profile of a population at a percentile, from a populations file (loadPopulation).
 * scaling "percentile": every measure at that percentile of its own distribution, the API's boundary case.
 * scaling "proportional": the median person scaled to the requested STATURE percentile by geometric similarity (s = stature(P)/stature(P50)):
 *   lengths, breadths, girths and heights x s, mass x s^3, areas (cm2) and forces (N) x s^2, BMI x s, ratios, %, degrees and years unchanged.
 *   Chosen because it keeps the median person's proportions (the usual way a reference manikin is scaled) and stays self-consistent for the
 *   fitter (girth, mass and volume agree). It is not how people vary: within a survey and sex mass rises only about stature^1.6 to ^2.2 (log-log
 *   slope over the repo's subjects table: 1.61 ASRAN women ... 2.19 ANSUR II women, approx.), well below the cube, and the head hardly scales
 *   at all, so tall scaled bodies are heavier than real tall people. Every mm measure is scaled, skinfolds and thicknesses included (they are
 *   not fitter inputs, see SKELETON_MEASURES, and stay one rule: geometric similarity).
 * Options: percentile (1 to 99), minReliability, scaling, label, and meanStature (default false, so that the result is the service's): use a stature given
 * only as a mean (no percentiles) instead of leaving the profile without a height; status "estimated", with a note.
 */
export function percentileProfile(pop, opts) {
  const { percentile = 50, minReliability = "medium", scaling = "percentile", label, meanStature = false } = opts ?? {};
  if (!pop || !Array.isArray(pop.measures) || !pop.population) throw new TypeError("percentileProfile needs a populations file (api/v1/populations/<country>/<role>/<sex>.json).");
  if (typeof percentile !== "number" || !(percentile >= 1 && percentile <= 99)) throw new RangeError("Percentile must be a number from 1 to 99.");
  if (scaling !== "percentile" && scaling !== "proportional") throw new RangeError(`Unknown scaling "${scaling}" (use "percentile" or "proportional").`);
  const { allowed, level } = reliabilityFilter(minReliability);
  const info = pop.population;
  const sex = info.sex === "M" || info.sex === "F" ? info.sex : "both";
  const usable = [];
  let hidden = 0, unavailable = 0, statureFromMean = false, statureSd = 0;
  for (const m of pop.measures) {
    const key = sanitiseKey(m?.key);
    if (!key) continue;
    if (!allowed.includes(m.reliability)) { hidden++; continue; }
    if (!finite3(m.percentiles)) {
      // opt-in (the service does not do this, and the website must agree with it): the model needs a stature and 16 small samples publish only its mean
      // (Bulgaria cadets, Malaysia army, ...), so use the mean (mean + z SD at other percentiles when an SD is given) rather than return no height
      if (meanStature && key === "stature" && typeof m.mean === "number" && m.mean > 0 && Number.isFinite(m.mean)) {
        const sd = typeof m.sd === "number" && Number.isFinite(m.sd) && m.sd > 0 ? m.sd : 0;
        usable.push({ m: { ...m, percentiles: { p5: m.mean - Z95 * sd, p50: m.mean, p95: m.mean + Z95 * sd }, percentile_basis: { p5: "estimated", p50: "estimated", p95: "estimated" } }, key });
        statureFromMean = true; statureSd = sd;
      } else unavailable++;
      continue;
    }
    usable.push({ m, key });
  }

  let s = 1, statureP = null;
  if (scaling === "proportional") {
    const st = usable.find(x => x.key === "stature");
    if (!st) throw new Error("Proportional scaling needs a stature in this population at this reliability level; use per-measure percentiles instead.");
    statureP = valueAtPercentile(st.m, percentile).value;
    s = statureP / st.m.percentiles.p50;
  }

  const measures = {};
  for (const { m, key } of usable) {
    const unit = String(m.unit ?? unitOf(key));
    const entry = { value: 0, unit, status: "reported", reliability: m.reliability };
    if (scaling === "percentile") {
      const r = valueAtPercentile(m, percentile);
      entry.value = roundValue(r.value, unit);
      entry.status = statusFor(m, percentile);
      entry.basis = r.basis;
      if (r.basis === "extrapolated") entry.note = "extrapolated beyond P5/P95";
      else if (entry.status === "estimated") entry.note = EST_NOTE;
    } else {
      const e = own(SCALE_EXPONENT, unit) ?? 0, p50 = m.percentiles.p50;
      if (key === "stature") { entry.value = roundValue(statureP, unit); entry.status = statusFor(m, percentile); entry.basis = basisOf(percentile); }
      else if (e && s !== 1) { entry.value = roundValue(p50 * s ** e, unit); entry.status = "estimated"; entry.basis = "scaled"; entry.note = `median x ${fmt1(s)}${e > 1 ? "^" + e : ""}`; }
      else { entry.value = roundValue(p50, unit); entry.status = statusFor(m, 50); entry.basis = "reported"; if (entry.status === "estimated") entry.note = EST_NOTE; }
    }
    const n = cleanN(m.n);
    if (n !== undefined) entry.n = n;
    measures[key] = entry;
  }

  const notes = [];
  const pct = `P${percentile}`;
  if (scaling === "percentile") {
    notes.push(percentile === 50
      ? "Percentile 50 of each dimension: a reference body. Real people vary in proportions, so nobody has every dimension at the median."
      : `Every dimension is percentile ${percentile} of that dimension alone: a boundary case, not a typical body.`);
    if (percentile < 5 || percentile > 95) notes.push(`${pct} lies outside the P5 to P95 the surveys report: values are extrapolated on the same line (linear in the normal score) and are less certain the further out.`);
    else if (percentile !== 5 && percentile !== 50 && percentile !== 95) notes.push("Percentiles other than 5, 50 and 95 are interpolated from P5, P50 and P95.");
  } else {
    notes.push(`The median person scaled to the stature of ${pct} (${roundValue(statureP, "mm")} mm, factor ${fmt1(s)}): lengths and girths x ${fmt1(s)}, mass x ${fmt1(s ** 3)} (geometric similarity). ` +
      "This keeps the median's proportions but is not how people vary: taller people are relatively slimmer and have relatively smaller heads, so scaled mass and girths are upper estimates.");
    if (percentile < 5 || percentile > 95) notes.push(`${pct} stature is extrapolated beyond P5/P95 and is less certain the further out.`);
  }
  if (sex === "both") notes.push("Mixed or sex-not-stated population: the body form will be neutral.");
  if (hidden) notes.push(hiddenNote(hidden, level));
  if (unavailable) notes.push(`${unavailable} measure(s) have a mean but no percentiles and are left out.`);
  if (statureFromMean) notes.push(meanStatureNote(percentile, statureSd));
  if (Array.isArray(pop.notes)) for (const n of pop.notes) if (typeof n === "string" && !SURVEY_NOTES_DROP.some(r => r.test(n))) notes.push(n);
  if (!measures.stature) notes.push("This population has no stature at this reliability level: enter one by hand, the model needs it.");

  // fields of a file are untrusted: text only where text is expected, so a hostile file cannot put objects into the id, label or source
  const isObj = o => o && typeof o === "object" && !Array.isArray(o);
  const latest = isObj(info.survey), country = cleanText(info.country), role = cleanText(info.role), countryId = cleanText(info.country_id), roleId = cleanText(info.role_id);
  const where = [country, role, SEX_NAMES[sex]].filter(Boolean).join(" · ") + (latest && cleanText(info.survey.name) ? ` · ${cleanText(info.survey.name)}` : "");
  // the reliability level decides which measures exist, so it is part of the id (a cache keyed on the id must not return the body of another level)
  const relLabel = level === "medium" ? "" : level === "high" ? " · high reliability only" : " · all reliability levels";
  return {
    id: `pop:${countryId}/${roleId}/${sex}${latest ? ".latest" : ""}@p${percentile}${scaling === "proportional" ? "-prop" : ""}:${level}`,
    label: cleanText(label) || `${where} · ${pct}${scaling === "proportional" ? " stature, scaled median" : ""}${relLabel}`,
    sex,
    source: {
      kind: "population", country, country_id: countryId, role, role_id: roleId, sex, percentile, scaling, minReliability: level,
      // copies: the population file is cached and shared by every caller, a UI editing profile.source must not change it
      survey: latest ? structuredClone(info.survey) : null, surveys_combined: Array.isArray(info.surveys_combined) ? structuredClone(info.surveys_combined.filter(isObj)) : [],
      ...(Array.isArray(info.years) && info.years.every(Number.isFinite) ? { years: structuredClone(info.years) } : {}),
    },
    measures, notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------- loading the static files
const SLUG = /^[a-z0-9][a-z0-9-]{0,200}$/; // the longest real id (a pooled Latin-American sample) is 140 characters
const SEXES = ["M", "F", "both"];
const isSlug = id => typeof id === "string" && SLUG.test(id); // not String(id): null, undefined, numbers and objects with a toString are no ids

async function defaultFetch(url) {
  let res;
  try { res = await fetch(url); } catch (e) { throw new Error(`Could not reach ${url}: ${e?.message ?? e}`); }
  if (!res.ok) { const err = new Error(`${url}: HTTP ${res.status}`); err.status = res.status; throw err; }
  try { return await res.json(); } catch { throw new Error(`${url} is not valid JSON.`); }
}

const caches = new WeakMap(); // fetchJSON function -> Map(url -> Promise): a different fetcher (tests, another origin) never sees stale answers
function cached(fetchJSON, url) {
  let m = caches.get(fetchJSON);
  if (!m) caches.set(fetchJSON, m = new Map());
  if (!m.has(url)) {
    const p = Promise.resolve().then(() => fetchJSON(url));
    p.catch(() => m.delete(url)); // a failed load is retried next time
    m.set(url, p);
  }
  return m.get(url);
}
/** Forget every cached file (for tests, or after the site was redeployed). */
export function clearCache() { caches.delete(defaultFetch); }

const trimBase = b => String(b).replace(/\/+$/, "");

/** URL of a population's file relative to `base` (`.latest` is the most recent survey alone). Throws TypeError for ids that could leave the data directory. */
export function populationUrl(entry, { latest = false, base = "api/v1" } = {}) {
  if (!entry || !isSlug(entry.country_id) || !isSlug(entry.role_id) || !SEXES.includes(entry.sex)) {
    throw new TypeError("A population needs country_id, role_id (ids from the index) and sex M, F or both.");
  }
  return `${trimBase(base)}/populations/${entry.country_id}/${entry.role_id}/${entry.sex}${latest ? ".latest" : ""}.json`;
}

/** The index of the static data: every population with its measures count, and the same grouped by country and role. */
export async function loadIndex(base = "api/v1", fetchJSON = defaultFetch) {
  const url = `${trimBase(base)}/index.json`;
  let raw;
  try { raw = await cached(fetchJSON, url); } catch (e) { throw new Error(e.status === 404 ? `The data index was not found at ${url}.` : `Could not load the data index (${e.message}).`); }
  if (!raw || !Array.isArray(raw.populations)) throw new Error(`${url} is not an api/v1 index (no populations list).`);
  const populations = [];
  for (const p of raw.populations) {
    if (!p || !isSlug(p.country_id) || !isSlug(p.role_id) || !SEXES.includes(p.sex)) continue;
    const e = { country: String(p.country), country_id: p.country_id, role: String(p.role), role_id: p.role_id, sex: p.sex, measures: Number(p.measures) || 0,
      has_latest: !!p.latest_survey, latest_survey: structuredClone(p.latest_survey ?? null), has_mannequin: !!p.mannequin_json };
    e.url = populationUrl(e, { base });
    e.latest_url = e.has_latest ? populationUrl(e, { base, latest: true }) : null;
    populations.push(e);
  }
  const byCountry = new Map();
  for (const p of populations) {
    if (!byCountry.has(p.country_id)) byCountry.set(p.country_id, { id: p.country_id, name: p.country, roles: new Map() });
    const c = byCountry.get(p.country_id);
    if (!c.roles.has(p.role_id)) c.roles.set(p.role_id, { id: p.role_id, name: p.role, sexes: [] });
    c.roles.get(p.role_id).sexes.push(p.sex);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, "en");
  const countries = [...byCountry.values()].sort(byName).map(c => ({
    id: c.id, name: c.name,
    roles: [...c.roles.values()].sort(byName).map(r => ({ ...r, sexes: SEXES.filter(s => r.sexes.includes(s)) })),
  }));
  return { populations, countries };
}

/** Raw populations file (P5/P50/P95 of every measure at every reliability level). `entry` is a loadIndex population or {country_id, role_id, sex}. */
export async function loadPopulation(entry, { latest = false, base = "api/v1", fetchJSON = defaultFetch } = {}) {
  if (latest && entry?.has_latest === false) throw new Error(`${entry.country} / ${entry.role} has no latest-survey file: its combined values do not span many years.`);
  const url = populationUrl(entry, { latest, base });
  const name = `${entry.country ?? entry.country_id} / ${entry.role ?? entry.role_id} / ${entry.sex}${latest ? " (latest survey)" : ""}`;
  let raw;
  try { raw = await cached(fetchJSON, url); } catch (e) { throw new Error(e.status === 404 ? `No data file for ${name} (${url} not found).` : `Could not load ${name} (${e.message}).`); }
  if (!raw || !Array.isArray(raw.measures) || !raw.population) throw new Error(`${url} is not a populations file (no measures list).`);
  return raw;
}

/** api/v1/measures.json; also registered for labelOf / unitOf. */
export async function loadMeasures(base = "api/v1", fetchJSON = defaultFetch) {
  const url = `${trimBase(base)}/measures.json`;
  let raw;
  try { raw = await cached(fetchJSON, url); } catch (e) { throw new Error(`Could not load the measure list (${e.message}).`); }
  if (!Array.isArray(raw)) throw new Error(`${url} is not a measure list.`);
  setMeasureCatalog(raw);
  return raw;
}

// ---------------------------------------------------------------------------------------------------------------- real people (db.js, table subjects)
// Only these columns ever leave the database: dataset, sex, branch, subject_key and the body measures. source_id, component, handedness and age could
// help to identify a person, and bmi is derived, so they are not selected at all.
export const SUBJECT_MEASURES = Object.freeze([
  "stature", "mass", "cervicale_height", "acromion_height", "suprasternale_height", "iliocristale_height", "trochanterion_height", "crotch_height",
  "sitting_height", "eye_height_sitting", "acromion_height_sitting", "elbow_rest_height", "thigh_clearance", "knee_height_sitting", "popliteal_height",
  "buttock_knee_length", "buttock_popliteal_length", "abdominal_depth_sitting", "hip_breadth_sitting", "biacromial_breadth", "bideltoid_breadth",
  "forearm_forearm_breadth", "chest_breadth", "chest_depth", "bicristal_breadth", "chest_circumference", "waist_circumference", "buttock_circumference",
  "neck_circumference", "neck_circumference_base", "shoulder_circumference", "biceps_circumference_flexed", "forearm_circumference_flexed", "wrist_circumference",
  "thigh_circumference", "calf_circumference", "ankle_circumference", "vertical_trunk_circumference", "shoulder_elbow_length", "acromion_radiale_length",
  "radiale_stylion_length", "sleeve_outseam", "shoulder_length", "thumbtip_reach", "span", "hand_length", "hand_breadth", "hand_circumference", "foot_length",
  "foot_breadth", "head_circumference", "head_length", "head_breadth", "bizygomatic_breadth", "menton_sellion_length", "interpupillary_breadth", "ear_length",
]);
export const SUBJECT_DATASETS = Object.freeze({
  ansur_1988: "ANSUR 1988 (US Army)", ansur_ii_2012: "ANSUR II 2012 (US Army)", asran_2015: "ASRAN 2015 (Royal Australian Navy)", usaf_1967: "USAF 1967 (US Air Force flying personnel)",
});
const SUBJECT_SET = new Set(SUBJECT_MEASURES);
// approx. standard deviations of stature (mm) and mass (kg) in the four datasets (60 to 70 mm and 8 to 14 kg by dataset and sex in this repo's subjects table):
// they put a stature difference and a mass difference on one scale for "closest person"
const NEAREST_SCALE = { stature: 65, mass: 12 };
const SUBJECT_COLS = ["subject_key", "dataset", "sex", "branch", ...SUBJECT_MEASURES];
const colsSql = cols => cols.map(c => `"${c}"`).join(", ");

async function runner(queryFn) {
  if (typeof queryFn === "function") return queryFn;
  const m = await import("../db.js"); // the site's sql.js helper; only reached in the browser
  return m.query;
}
function toObjects({ columns, rows }) { return rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]]))); }
const nz = v => (v == null || v === "" ? null : v);
const filterSql = "(? IS NULL OR dataset = ?) AND (? IS NULL OR sex = ?) AND (? IS NULL OR branch = ?)";
// sex "both" / "mixed" (what a profile's own sex field says) is "any sex", not a value of the column; other text is passed on and matches nobody
const sexFilter = sex => { const w = parseSex(sex); return w === "both" ? null : w ?? nz(sex); };
const filterParams = ({ dataset, sex, branch }) => { const sx = sexFilter(sex); return [nz(dataset), nz(dataset), sx, sx, nz(branch), nz(branch)]; };

/** Distinct datasets / sexes / branches in the subjects table with their counts, for the pickers. */
export async function subjectFilters(queryFn) {
  const q = await runner(queryFn);
  return toObjects(await q("SELECT dataset, sex, branch, COUNT(*) AS n FROM subjects GROUP BY dataset, sex, branch ORDER BY dataset, sex, branch", []));
}

const MAX_LIST = 5000;
/** Short rows (subject_key, dataset, sex, branch, stature, mass) of people matching the filters, shortest first. `limit` (default and cap 5000; the biggest
 * group of one survey and sex has 4,082 people, all 13,792 are three pages) and `offset` (default 0) page through the list; countSubjects gives the total, so a picker never
 * has to hide the tall end of a group behind a cap. */
export async function listSubjects(queryFn, { dataset, sex, branch, limit = MAX_LIST, offset = 0 } = {}) {
  const q = await runner(queryFn);
  // an explicit 0 is the minimum (1), only a missing or non-numeric limit means the default
  const n = Math.trunc(Number(limit)), lim = limit == null || limit === "" || !Number.isFinite(n) ? MAX_LIST : Math.max(1, Math.min(MAX_LIST, n));
  const o = Math.trunc(Number(offset)), off = offset == null || offset === "" || !Number.isFinite(o) ? 0 : Math.max(0, Math.min(1e9, o));
  const res = await q(`SELECT subject_key, dataset, sex, branch, stature, mass FROM subjects WHERE stature IS NOT NULL AND ${filterSql} ORDER BY stature, subject_key LIMIT ${lim} OFFSET ${off}`, filterParams({ dataset, sex, branch }));
  return toObjects(res);
}

/** How many people listSubjects can return for these filters (those with a stature). */
export async function countSubjects(queryFn, { dataset, sex, branch } = {}) {
  const q = await runner(queryFn);
  const res = await q(`SELECT COUNT(*) AS n FROM subjects WHERE stature IS NOT NULL AND ${filterSql}`, filterParams({ dataset, sex, branch }));
  return Number(res.rows[0]?.[0]) || 0;
}

/** The person closest to a stature (mm) and optionally a body mass (kg), among those matching the filters. Distance = stature and mass differences in
 * units of NEAREST_SCALE, added in quadrature; ties go to the lower subject_key. Row has subject_key, dataset, sex, branch, the measures and match_distance. */
export async function nearestSubject(queryFn, { dataset, sex, stature, mass, branch } = {}) {
  if (typeof stature !== "number" || !(stature >= 500 && stature <= 3000)) throw new RangeError("Give the stature in mm (500 to 3000) to find the closest person.");
  const hasMass = mass != null;
  if (hasMass && !(typeof mass === "number" && mass > 0 && mass < 500)) throw new RangeError("Body mass must be a number of kg between 0 and 500.");
  const q = await runner(queryFn);
  const d = hasMass ? `(("stature" - ?) * ("stature" - ?)) / ${NEAREST_SCALE.stature * NEAREST_SCALE.stature}.0 + (("mass" - ?) * ("mass" - ?)) / ${NEAREST_SCALE.mass * NEAREST_SCALE.mass}.0`
    : `(("stature" - ?) * ("stature" - ?)) / ${NEAREST_SCALE.stature * NEAREST_SCALE.stature}.0`;
  const sql = `SELECT ${colsSql(SUBJECT_COLS)}, ${d} AS match_distance FROM subjects WHERE "stature" IS NOT NULL${hasMass ? ' AND "mass" IS NOT NULL' : ""} AND ${filterSql} ORDER BY match_distance, subject_key LIMIT 1`;
  const rows = toObjects(await q(sql, [stature, stature, ...(hasMass ? [mass, mass] : []), ...filterParams({ dataset, sex, branch })]));
  if (rows[0]) rows[0].match_distance = Math.sqrt(rows[0].match_distance);
  return rows[0] ?? null;
}

/** One person by subject_key, or null. */
export async function subjectById(queryFn, subjectKey) {
  const id = typeof subjectKey === "string" && /^\d{1,9}$/.test(subjectKey.trim()) ? Number(subjectKey) : subjectKey;
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("subject_key must be a positive whole number.");
  const q = await runner(queryFn);
  const rows = toObjects(await q(`SELECT ${colsSql(SUBJECT_COLS)} FROM subjects WHERE subject_key = ?`, [id]));
  return rows[0] ?? null;
}

/** Profile of one real person. People are anonymous: the profile carries dataset, sex, branch, subject_key and the measures, nothing else. */
export function subjectProfile(row, meta = {}) {
  if (!row || !Number.isSafeInteger(row.subject_key)) throw new TypeError("subjectProfile needs a row from nearestSubject / subjectById.");
  const sex = row.sex === "M" || row.sex === "F" ? row.sex : "both";
  const dataset = cleanText(row.dataset, 40);
  const dname = cleanText(meta.datasetName ?? SUBJECT_DATASETS[dataset] ?? dataset, 80);
  const branch = row.branch == null ? null : cleanText(row.branch, 60);
  const measures = {};
  for (const k of SUBJECT_MEASURES) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) measures[k] = { value: v, unit: k === "mass" ? "kg" : "mm", status: "individual", n: 1 };
  }
  return {
    id: `subject:${dataset}:${row.subject_key}`,
    label: `${dname} · ${SEX_NAMES[sex]}${branch ? " · " + branch : ""} · person #${row.subject_key}`,
    sex,
    source: { kind: "individual", dataset, subject_key: row.subject_key, sex, branch },
    measures,
    notes: ["A real, anonymous person from the survey's open data, measured with that survey's landmark definitions and posture.",
      "Measures the survey did not take are estimated by the model from stature and mass."],
  };
}

// ---------------------------------------------------------------------------------------------------------------- import / export
export const MAX_IMPORT_CHARS = 3_000_000; // the biggest populations file is 0.13 MB
const MAX_ENTRIES = 3000;
const META_KEYS = new Set(["sex", "gender", "label", "name", "id", "notes", "note", "source", "format", "version", "population", "units", "comment", "description"]);

function numberFrom(text, decimalComma = false) {
  let s = String(text).trim();
  if (decimalComma && /^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  return /^[+-]?(\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN; // digits are split between the groups in one way only: no backtracking blow-up
}
const MAX_CELL = 100; // longest text taken for a quantity ("1750.00000000 mm" is 16): a longer cell cannot be a number, so it is never matched
/** "175 cm", "12.5 kg", 1750 or {value, unit} -> { value, unit } (unit may be undefined); null for an empty value; throws for text that is no quantity. */
function quantityFrom(v, decimalComma = false) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return { value: v, unit: undefined };
  if (typeof v === "string") {
    // \d+(?:[.,]\d*)? and not \d+[.,]?\d*: the latter can split a digit run in n ways, so 60k digits then junk took seconds (quadratic)
    const m = v.length > MAX_CELL ? null : /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*([^\d\s].{0,15})?\s*$/i.exec(v);
    const n = m ? numberFrom(m[1], decimalComma) : NaN;
    if (!m || Number.isNaN(n)) throw new Error(`"${cleanText(v, 30)}" is not a number.`);
    return { value: n, unit: m[2]?.trim() };
  }
  if (typeof v === "object" && !Array.isArray(v) && "value" in v) {
    const q = quantityFrom(v.value, decimalComma);
    return q && { ...q, unit: v.unit ?? q.unit, status: v.status, reliability: v.reliability, n: v.n, note: v.note, was: v.was, orig: v.orig, basis: v.basis };
  }
  throw new Error("not a number");
}

const statusOk = s => STATUSES.includes(s);
const MAX_RAW_KEY = 200;

/** A measure entry from untrusted JSON, reduced to the fields an entry has (and valid ones), or null. Used for `orig`, the entry before an edit. */
function cleanEntry(o) {
  if (!o || typeof o !== "object" || !Number.isFinite(o.value) || !statusOk(o.status)) return null;
  const u = canonicalUnit(o.unit);
  if (!u) return null;
  const e = { value: o.value, unit: u, status: o.status };
  if (RELIABILITIES.has(o.reliability)) e.reliability = o.reliability;
  if (Number.isInteger(o.n) && o.n >= 0) e.n = o.n;
  if (BASES.has(o.basis)) e.basis = o.basis;
  if (typeof o.note === "string" && o.note.trim()) e.note = cleanText(o.note, 200);
  return e;
}

/** Collects entries {key, value, unit, ...} into measures with the sanitising and range checks of toDataUnit. */
class Collector {
  constructor(defaultStatus = "reported") { this.measures = {}; this.ignored = []; this.notes = []; this.dups = []; this.unknown = []; this.tooSmall = []; this.defaultStatus = defaultStatus; this.count = 0; }
  add(rawKey, q, extra = {}) {
    if (q == null) return;
    if (++this.count > MAX_ENTRIES) throw new Error(`Too many values (limit ${MAX_ENTRIES}).`);
    let hint = null, key;
    // a key longer than any real one (MAX_KEY is 80 after cleaning) is refused before the regex: the unit-hint pattern is quadratic on runs of spaces
    const r = typeof rawKey === "string" && rawKey.length <= MAX_RAW_KEY ? resolveKey(rawKey.replace(/\s*[([]\s*([^)\]]{1,12}?)\s*[)\]]\s*$/, (_, u) => { hint = canonicalUnit(u) ?? hint; return ""; })) : null;
    if (r) { key = r.key; hint = hint ?? r.hint; }
    if (!key) { this.ignored.push(cleanText(rawKey, 24) || "(blank)"); return; }
    let d;
    try { d = toDataUnit(key, q.value, q.unit ?? hint ?? undefined); } catch (e) {
      // a secondary length that is too small to be mm (19.2 for a hand: cm, no unit) is left out and reported, the fitter estimates it; the rest of the file is still good
      if (e.tooSmall) { this.tooSmall.push(`${key} ${Math.round(q.value * 100) / 100}`); return; }
      throw e;
    }
    if (!key.startsWith("other:") && !isKnownKey(key)) this.unknown.push(key); // `other:` keys are the catalog's long tail: whether one exists depends on the catalog, a bare name does not
    const e = { value: d.value, unit: d.unit, status: statusOk(q.status ?? extra.status) ? (q.status ?? extra.status) : this.defaultStatus };
    const rel = q.reliability ?? extra.reliability;
    if (RELIABILITIES.has(rel)) e.reliability = rel;
    const n = cleanN(q.n ?? extra.n);
    if (n !== undefined) e.n = n;
    const note = q.note ?? extra.note;
    if (typeof note === "string" && note.trim()) e.note = cleanText(note, 200);
    if (BASES.has(q.basis)) e.basis = q.basis;
    if (q.was && typeof q.was === "object" && Number.isFinite(q.was.value) && statusOk(q.was.status)) e.was = { value: q.was.value, status: q.was.status };
    const orig = e.was && cleanEntry(q.orig);
    if (orig) e.orig = orig;
    if (Object.hasOwn(this.measures, key)) this.dups.push(key); // the later value wins, the user is told
    this.measures[key] = e;
  }
}

// profileToCSV puts an apostrophe before text a spreadsheet would read as a formula; the same test undoes exactly that one apostrophe
const FORMULA_START = /^'*[=+@\t\r-]/;
const unguard = t => (typeof t === "string" && t.startsWith("'") && FORMULA_START.test(t) ? t.slice(1) : t);

function csvRows(text, delim) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
    } else if (c === '"' && cell === "") inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ENTRIES + 50) throw new Error(`Too many rows (limit ${MAX_ENTRIES}).`);
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== "")) rows.push(row);
  return rows;
}

function parseCSV(text, col, minReliability) {
  // "# sex: M" and "# label: ..." comment lines (written by profileToCSV) come before the header; other comment lines are skipped
  const meta = {};
  const lines = text.split(/\r\n|\n|\r/);
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trim().startsWith("#"))) {
    const m = /^#\s*(sex|label)\s*:\s*(.*)$/i.exec(lines[start].trim());
    if (m) meta[m[1].toLowerCase()] = m[2];
    start++;
  }
  const body = lines.slice(start).join("\n");
  const head = body.split("\n", 1)[0] ?? "";
  const count = ch => head.split(ch).length - 1;
  const delim = [",", ";", "\t"].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = csvRows(body, delim);
  if (rows.length < 1) throw new Error("The CSV has no rows.");
  const names = rows[0].map(x => x.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  // the first candidate that is a column wins, not the leftmost column of any candidate: in `name,key,value` the key is `key`
  const find = (...c) => { for (const n of c) { const i = names.indexOf(n); if (i >= 0) return i; } return -1; };
  const kcol = find("key", "measure_key", "measure", "dimension", "name", "measure_name");
  const vcol = find("value", "val", "amount", "measurement");
  const pcol = find("p50");
  const dc = delim !== ",";
  if (kcol >= 0 && (vcol >= 0 || pcol >= 0)) {
    const ucol = find("unit", "units");
    const scol = find("status"), rcol = find("reliability"), ncol = find("n"), ocol = find("note");
    const useP50 = vcol < 0; // a populations CSV from api/v1: the median column
    if (useP50) col.notes.push("The CSV is a populations table: the median (p50) column was used.");
    // a populations CSV is read like its JSON twin: reliability filter, and a median that was estimated from mean and SD stays "estimated"
    const filter = useP50 && reliabilityFilter(minReliability);
    const bcol = find("percentile_basis"), ecol = find("estimated_percentiles"), mcol = find("mean");
    const hidden = [];
    let hiddenRows = 0, meanStature = false;
    for (const r of rows.slice(1)) {
      const k = (r[kcol] ?? "").trim();
      if (!k) continue;
      let cellv = (r[useP50 ? pcol : vcol] ?? "").trim();
      const lk = k.toLowerCase();
      // metadata rows, unless the value is a number: then it is a measure that happens to be called sex or label
      if ((lk === "sex" || lk === "gender" || lk === "label") && Number.isNaN(numberFrom(cellv, dc))) { meta[lk === "label" ? "label" : "sex"] = cellv; continue; }
      let est = false, fromMean = false;
      if (useP50) {
        // as percentileProfile({meanStature: true}): a stature with a mean but no percentiles
        if (cellv === "" && resolveKey(k)?.key === "stature" && mcol >= 0 && (r[mcol] ?? "").trim() !== "") { cellv = (r[mcol] ?? "").trim(); fromMean = true; }
        const rel = rcol >= 0 ? (r[rcol] ?? "").trim().toLowerCase() : "";
        if (rel && !filter.allowed.includes(rel)) { // blank means the file does not say
          if (cellv !== "") { hiddenRows++; hidden.push(resolveKey(k)?.key ?? k); }
          continue;
        }
        const basis = /(?:^|\s)p50:(\w+)/.exec(bcol >= 0 ? r[bcol] ?? "" : "")?.[1];
        est = fromMean || (basis ? basis === "estimated" : ecol >= 0 && (r[ecol] ?? "").split(/[\s,;|]+/).includes("p50"));
        meanStature ||= fromMean;
      }
      let q;
      try { q = quantityFrom(cellv, dc); } catch (e) { throw new Error(`${cleanText(k, 40)}: ${e.message}`); }
      if (q && ucol >= 0 && (r[ucol] ?? "").trim()) q.unit = r[ucol].trim();
      const extra = { status: est ? "estimated" : scol >= 0 ? (r[scol] ?? "").trim() : undefined, reliability: rcol >= 0 ? (r[rcol] ?? "").trim() : undefined, n: ncol >= 0 ? (r[ncol] ?? "").trim() : undefined,
        note: ocol >= 0 ? unguard(r[ocol]) : est ? EST_NOTE : undefined };
      col.add(k, q, extra);
    }
    if (meanStature) col.notes.push(meanStatureNote(50, 0));
    if (hiddenRows) col.notes.push(hiddenNote(hiddenRows, filter.level));
    const scol2 = find("sex");
    if (scol2 >= 0 && !meta.sex) meta.sex = (rows[1]?.[scol2] ?? "").trim();
    return { meta, format: useP50 ? "populations-csv" : "csv", ...(useP50 ? { level: filter.level, hidden } : {}) };
  }
  if (rows.length === 2) { // wide: header = keys, one row of values
    rows[0].forEach((k, i) => {
      const kk = k.trim().toLowerCase();
      const v = (rows[1][i] ?? "").trim();
      if (kk === "sex" || kk === "gender") { meta.sex = v; return; }
      if (kk === "label" || kk === "name" || kk === "id") { if (kk === "label") meta.label = v; return; }
      let q;
      try { q = quantityFrom(v, dc); } catch (e) { throw new Error(`${cleanText(k, 40)}: ${e.message}`); }
      col.add(k, q);
    });
    return { meta, format: "csv-wide" };
  }
  throw new Error("CSV not recognised: the header needs a key column (key or measure_key) and a value column (value), for example `key,value,unit`.");
}

function fromPopulation(obj, col, minReliability) {
  // median, medium reliability and above by default, as the website does; a stature given only as a mean is used (the model needs one)
  const p = percentileProfile(obj, { minReliability, meanStature: true });
  for (const [k, m] of Object.entries(p.measures)) col.add(k, { value: m.value, unit: m.unit, status: m.status, reliability: m.reliability, n: m.n, note: m.note });
  col.notes.push(...p.notes);
  // what the filter hid, so that an empty result can say why instead of "no measures"
  const hidden = Object.keys(percentileProfile(obj, { minReliability: "low", meanStature: true }).measures).filter(k => !p.measures[k]);
  return { meta: { sex: p.sex, label: p.label }, format: "populations-json", level: p.source.minReliability, hidden };
}

function fromMannequin(obj, col) {
  let values = obj.values, units = obj.units, basis = null, core = obj.core, pk = null;
  if (obj.percentiles && typeof obj.percentiles === "object" && !Array.isArray(obj.percentiles)) {
    const keys = Object.keys(obj.percentiles).filter(k => /^p\d+(\.\d+)?$/.test(k));
    pk = keys.includes("p50") ? "p50" : keys[0];
    const node = pk && obj.percentiles[pk];
    if (!node || typeof node !== "object") throw new Error("The mannequin file has no percentile sets.");
    values = node.values; basis = node.basis; core = node.core;
  } else if (Array.isArray(obj.dimensions)) basis = Object.fromEntries(obj.dimensions.filter(d => d && d.key).map(d => [d.key, d.basis]));
  const rels = Array.isArray(obj.dimensions) ? Object.fromEntries(obj.dimensions.filter(d => d?.key).map(d => [d.key, d])) : obj.dimensions && typeof obj.dimensions === "object" ? obj.dimensions : {};
  if (values && typeof values === "object" && Object.keys(values).length) {
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== "number") continue;
      const b = ownIn(basis, k), dim = ownIn(rels, k);
      col.add(k, { value: v, unit: ownIn(units, k) ?? dim?.unit }, { status: b === "estimated" || b === "extrapolated" ? "estimated" : "reported", reliability: dim?.reliability, n: dim?.n });
    }
  } else if (core && typeof core === "object") {
    for (const [k, v] of Object.entries(core)) if (typeof v === "number") col.add(k, { value: v });
  } else throw new Error("The mannequin file has no values.");
  const pn = obj.percentile ?? (pk ? Number(pk.slice(1)) : null);
  return { meta: { sex: obj.population?.sex }, format: "mannequin-json", percentile: pn };
}

function fromProfileJSON(obj, col) {
  for (const [k, v] of Object.entries(obj.measures ?? {})) {
    if (!v || typeof v !== "object") continue;
    try { col.add(k, quantityFrom({ value: v.value, unit: v.unit, status: v.status, reliability: v.reliability, n: v.n, note: v.note, was: v.was, orig: v.orig, basis: v.basis })); } catch (e) { throw new Error(`${cleanText(k, 40)}: ${e.message}`); }
  }
  col.notes.push(...(Array.isArray(obj.notes) ? obj.notes.filter(n => typeof n === "string").slice(0, 20).map(n => cleanText(n, 400)) : []));
  return { meta: { sex: obj.sex, label: obj.label }, format: "profile-json", original: obj.source && typeof obj.source === "object" ? cleanText(obj.source.kind, 20) : null };
}

function fromFlat(obj, col) {
  const src = obj.measures && typeof obj.measures === "object" && !Array.isArray(obj.measures) ? obj.measures : obj;
  const list = Array.isArray(src) ? src.map(e => [e?.key ?? e?.measure_key, e]) : Object.entries(src);
  for (const [k, v] of list) {
    if (typeof k !== "string") continue;
    if (src === obj && META_KEYS.has(k.toLowerCase())) continue;
    if (v == null || typeof v === "boolean") continue;
    if (typeof v === "object" && !Array.isArray(v) && !("value" in v)) continue; // nested notes etc.
    let q;
    try { q = quantityFrom(v); } catch (e) { throw new Error(`${cleanText(k, 40)}: ${e.message}`); }
    col.add(k, q);
  }
  return { meta: { sex: obj.sex ?? obj.gender, label: obj.label ?? obj.name }, format: "json" };
}

/**
 * Profile from the text of a file: our populations JSON (median), the API's mannequin JSON (p50 values, or only core), a flat {key: number} or
 * {measures: {key: {value, unit}}} JSON (or a list of {key, value, unit}), a profile written by profileToJSON, or a CSV (key,value[,unit], also the
 * api/v1 populations CSV (median) and a one-row table with the keys as header). Units mm, cm, m, in, kg, lb come from a unit column, a "175 cm" value,
 * a key suffix (stature_cm) or a "(cm)" in the key; lengths default to mm and mass to kg. Throws Error with a plain message for anything it will not
 * accept: nothing is evaluated, keys are sanitised, and values outside plausible ranges (stature 0.8 to 2.5 m, mass 10 to 400 kg) are rejected.
 * A populations file is read at `minReliability` (default "medium", like the percentile picker); a file whose values are all below it is refused with
 * an error that says so.
 */
export function parseImport(text, filename = "", opts) {
  const minReliability = opts?.minReliability ?? "medium";
  if (typeof text !== "string") throw new Error("The file could not be read as text.");
  if (text.length > MAX_IMPORT_CHARS) throw new Error(`The file is too large (${(text.length / 1e6).toFixed(1)} MB; the limit is ${MAX_IMPORT_CHARS / 1e6} MB).`);
  const t = text.replace(/^﻿/, "");
  if (!t.trim()) throw new Error("The file is empty.");
  const first = t.trimStart()[0];
  if (first === "<") throw new Error("This looks like an HTML or XML page, not JSON or CSV. Export the data as a JSON or CSV file.");
  const col = new Collector();
  const fname = typeof filename === "string" ? cleanText(filename.split(/[\\/]/).pop(), 60) : "";
  let info;
  if (first === "{" || first === "[") {
    let obj;
    try { obj = JSON.parse(t); } catch (e) { throw new Error(`The file is not valid JSON (${cleanText(e.message, 80)}).`); }
    if (!obj || typeof obj !== "object") throw new Error("The JSON must be an object or a list of measures.");
    if (!Array.isArray(obj) && obj.format === "digital-human-profile") info = fromProfileJSON(obj, col);
    else if (!Array.isArray(obj) && Array.isArray(obj.measures) && obj.population && typeof obj.population === "object" && obj.measures.some(m => m && m.percentiles)) info = fromPopulation(obj, col, minReliability);
    else if (!Array.isArray(obj) && ((obj.percentiles && typeof obj.percentiles === "object" && !Array.isArray(obj.percentiles)) || (obj.values && typeof obj.values === "object" && !Array.isArray(obj.values) && obj.units) || (obj.core && !obj.measures))) info = fromMannequin(obj, col);
    else info = fromFlat(obj, col);
  } else {
    if (/\.json$/i.test(fname)) throw new Error("The file is named .json but does not start with { or [.");
    info = parseCSV(t, col, minReliability);
  }

  const measures = col.measures;
  const lvl = info.level, hid = info.hidden ?? [];
  if (!Object.keys(measures).length && hid.length) throw new Error(`No measures were found at ${lvl} reliability or better: all ${hid.length} values in this populations file are less reliable. Import it again with minReliability "low" to use them.`);
  if (!Object.keys(measures).length) throw new Error("No measures were found. A file needs keys such as stature and mass with numeric values (JSON {\"stature\": 1750, \"mass\": 75} or CSV `key,value,unit`).");
  if (!measures.stature && hid.includes("stature")) throw new Error(`The file has no stature at ${lvl} reliability or better (its stature is less reliable), which the model needs. Import it again with minReliability "low" to use it, or add a stature row.`);
  if (!measures.stature) throw new Error("The file has no stature, which the model needs. Add a stature row (for example stature,1750,mm).");
  const sex = parseSex(info.meta.sex) ?? "both";
  const notes = [`Imported from ${fname ? `"${fname}"` : "pasted text"} (${info.format}). Values are used as given; units were converted to mm and kg.`];
  if (info.format === "mannequin-json") notes.push(`Taken from the percentile ${info.percentile ?? 50} set of a mannequin file: every dimension is that percentile of its own distribution, a boundary case.`);
  if (col.ignored.length) notes.push(`${col.ignored.length} entr${col.ignored.length === 1 ? "y" : "ies"} with unusable names were ignored: ${[...new Set(col.ignored)].slice(0, 5).join(", ")}${col.ignored.length > 5 ? ", ..." : ""}.`);
  if (sex === "both" && !parseSex(info.meta.sex)) notes.push("No sex given: the body form will be neutral.");
  if (col.dups.length) notes.push(`${col.dups.length} value(s) used a name that appeared more than once (${[...new Set(col.dups)].slice(0, 5).join(", ")}${new Set(col.dups).size > 5 ? ", ..." : ""}): names that differ only in case, spaces or a bracketed unit or side count as the same, and the last one was kept.`);
  if (col.tooSmall.length) notes.push(`${col.tooSmall.length} value(s) left out as too small to be millimetres (probably cm, m or in with the unit missing; give the unit): ${col.tooSmall.slice(0, 5).join(", ")}${col.tooSmall.length > 5 ? ", ..." : ""}.`);
  if (col.unknown.length) {
    const u = [...new Set(col.unknown)];
    notes.push(`${u.length} name${u.length === 1 ? " is" : "s are"} not in the measure list, so the model does not use ${u.length === 1 ? "it" : "them"}: ${u.slice(0, 5).join(", ")}${u.length > 5 ? ", ..." : ""}. Check the spelling (and the unit suffix).`);
  }
  notes.push(...col.notes.filter(n => !n.startsWith("Imported from")));
  return {
    id: `import:${fname || "text"}`,
    label: cleanText(info.meta.label) || (fname ? `Imported · ${fname}` : "Imported profile"),
    sex,
    source: { kind: "import", format: info.format, filename: fname || null, ...(info.original ? { original: info.original } : {}) },
    measures, notes,
  };
}

/** The profile as JSON text (round-trips through parseImport). */
export function profileToJSON(profile) {
  return JSON.stringify({ format: "digital-human-profile", version: 1, id: profile.id, label: profile.label, sex: profile.sex, source: profile.source, measures: profile.measures, notes: profile.notes }, null, 2);
}

const csvCell = v => {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = "'" + s; // a spreadsheet must not read text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The profile as CSV: `# sex:` and `# label:` comment lines, then key,value,unit,status,reliability,n,note (parseImport reads it back). */
export function profileToCSV(profile) {
  const lines = [`# label: ${cleanText(profile.label, 200)}`, `# sex: ${profile.sex}`, "key,value,unit,status,reliability,n,note"];
  for (const [k, m] of Object.entries(profile.measures)) lines.push([k, m.value, m.unit, m.status, m.reliability, m.n, m.note].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------- editing, manual entry
/** New profile with one measure set by hand (status "edited", the value before the first edit kept as `was`). `unit` defaults to the measure's own unit
 * (mm for lengths, kg for mass); cm, m, in, lb are converted. The profile passed in is not changed. */
export function editMeasure(profile, key, value, unit) {
  const r = resolveKey(key);
  if (!r) throw new Error(`"${cleanText(key, 30)}" is not a usable measure key.`);
  const cur = profile.measures[r.key];
  const d = toDataUnit(r.key, value, unit ?? r.hint ?? cur?.unit ?? undefined);
  const entry = { value: d.value, unit: d.unit, status: "edited" };
  if (cur?.reliability) entry.reliability = cur.reliability;
  if (cur) {
    entry.was = cur.was ?? { value: cur.value, status: cur.status };
    const { was: _w, orig: _o, ...whole } = cur;
    entry.orig = cur.orig ?? whole; // the whole entry (n, basis, note, ...) so that revertMeasure is an exact undo
  }
  const notes = profile.notes.includes(EDIT_NOTE) ? [...profile.notes] : [...profile.notes, EDIT_NOTE];
  return {
    ...profile,
    id: profile.id.endsWith("~edited") ? profile.id : profile.id + "~edited",
    label: profile.label.endsWith(" (edited)") ? profile.label : profile.label + " (edited)",
    source: { ...profile.source },
    measures: { ...profile.measures, [r.key]: entry },
    notes,
  };
}
const EDIT_NOTE = "Some values were edited by hand; the status of each measure says which.";

/** Undo editMeasure for one measure: back to the value it had before the first edit (removed again if it did not exist). */
export function revertMeasure(profile, key) {
  const r = resolveKey(key);
  const cur = r && profile.measures[r.key];
  if (!cur || cur.status !== "edited") return profile;
  const measures = { ...profile.measures };
  if (cur.orig) measures[r.key] = { ...cur.orig };
  else if (cur.was) measures[r.key] = { value: cur.was.value, unit: cur.unit, status: cur.was.status, ...(cur.reliability ? { reliability: cur.reliability } : {}) }; // an older file without `orig`
  else delete measures[r.key];
  const out = { ...profile, source: { ...profile.source }, measures, notes: [...profile.notes] };
  if (!Object.values(measures).some(m => m.status === "edited")) { // nothing edited any more: drop the markers editMeasure added
    out.id = out.id.replace(/~edited$/, ""); out.label = out.label.replace(/ \(edited\)$/, ""); out.notes = out.notes.filter(n => n !== EDIT_NOTE);
  }
  return out;
}

/** A profile with only stature (mm) and optionally mass (kg); fit.js estimates everything else. Units: pass statureUnit / massUnit for cm, m, in, lb. */
export function manualProfile({ sex, stature, mass, statureUnit, massUnit } = {}) {
  const sx = parseSex(sex) ?? (sex == null ? "both" : null);
  if (!sx) throw new Error(`Unknown sex "${cleanText(sex, 20)}" (use M, F or both).`);
  const st = toDataUnit("stature", stature, statureUnit);
  const measures = { stature: { value: st.value, unit: "mm", status: "reported", note: "entered by hand" } };
  if (mass != null) { const m = toDataUnit("mass", mass, massUnit); measures.mass = { value: m.value, unit: "kg", status: "reported", note: "entered by hand" }; }
  return {
    id: "manual", label: `Manual · ${SEX_NAMES[sx]} · ${Math.round(st.value)} mm`, sex: sx, source: { kind: "manual" }, measures,
    notes: ["Only the values you entered are measured; every other dimension is estimated from stature" + (mass != null ? " and mass" : "") + " by the model."],
  };
}
