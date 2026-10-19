// Profile panel of the Digital human tab: choose who the figure is (a survey population at a percentile, a real person of the in-browser database, an imported
// JSON or CSV file, or a stature and mass typed in), see how every dimension of the model was set (measured, derived or estimated; edit any of them), the fit
// report that compares the built model with the profile, the warnings, and the body form. Contract: docs/human3d/DESIGN.md 3.1, MODEL.md 1 and 8.
//
// Everything above `// ---- panel` is pure (no DOM; tested in Node by tests/human3d/panels-profile.test.mjs). The panel itself touches the DOM only inside mount().
//
// EXTENSION FIELDS. A Profile may carry two optional fields the shell has to pass on to fitBody(profile, opts): `form` ("male" | "female" | "neutral": opts.form)
// and `overrides` ({ dimensionId: metres }: opts.overrides, the edits of the mapping table that no measure can express). This panel sets them and, after every
// build, checks that the body has them; when it has not, it says so (see extrasNotice). shell.js deps.fit should read them (it does not yet: until then the
// body form and the edits of the 33 dimensions that are not profile measures have no effect, and the panel says so):
//   fitBody(profile, { form: profile.form ?? formOf(profile), overrides: profile.overrides })
import { h, toast, download, fmtInt } from "../../util.js";
import * as anthro from "../anthro.js";
import { DIM_DEFS, evaluateMeasures, fitBody } from "../fit.js";
import { section, segmented, sliderRow, notice, nextId, toUnit, fromUnit, unitDigits, fmtLength, UNIT_LABEL } from "../ui.js";
import { ensureStyles, showLandmark, statusChip } from "./skeleton.js";

// ---------------------------------------------------------------------------------------------------------------------
// numbers and units
/** A number from user text: "1,755", "175,5" (decimal comma), " 80 ". NaN for anything else (including the empty string). */
export function parseNumber(text) {
  if (typeof text === "number") return Number.isFinite(text) ? text : NaN;
  let s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s) return NaN;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replaceAll(",", ""); // 1,755.5
  else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", "."); // 175,5
  return /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN;
}
export const STATURE_UNITS = Object.freeze(["mm", "cm", "m", "in"]);
export const MASS_UNITS = Object.freeze(["kg", "lb"]);
const TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
/** A length in mm from a value in mm, cm, m or in. */
export const toMm = (v, unit = "mm") => v * (TO_MM[unit] ?? NaN);
/** A signed difference with a real minus sign: "+1.2", "−0.4", "0.0". */
export function fmtSigned(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(digits));
  if (r === 0) return (0).toFixed(digits);
  return `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(digits)}`;
}
/** Decimals for a difference between two lengths in `unit`: one more than the lengths themselves. */
export const deltaDigits = (unit) => unitDigits(unit) + 1;
/** "76.3 kg" */
export const fmtKg = (kg) => (kg == null || !Number.isFinite(kg) ? "—" : `${kg.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`);
/** Display text of a report or dimension number: lengths in the display unit, masses in kg, ratios plain. `v` is in mm / kg / ratio. */
export function fmtQuantity(v, kind, unit = "mm", digits) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (kind === "kg") return fmtKg(v);
  if (kind === "ratio") return v.toFixed(3);
  return fmtLength(v, unit, { digits });
}

// ---------------------------------------------------------------------------------------------------------------------
// populations
export const SEX_LABEL = Object.freeze({ M: "Men", F: "Women", both: "Mixed" });
export const RELIABILITY_OPTIONS = Object.freeze([
  ["high", "High only", "Only values the surveys measured with high confidence; the model estimates the rest."],
  ["medium", "Medium and high (default)", "Leaves out the least reliable values (small samples, unclear definitions)."],
  ["low", "Everything, even low reliability", "Uses every published value, including those from small or old samples."],
]);
export const SCALING_OPTIONS = Object.freeze([
  ["percentile", "Each dimension at this percentile (boundary case)", "Every measure at its own percentile, as the data service does: P95 arms and P95 legs together."],
  ["proportional", "Typical person of this stature (proportional)", "The median person scaled to this stature, proportions kept; girths and mass run high."],
]);
export const FEW_MEASURES = 10;

/**
 * Country / role / sex choices from the loaded index (anthro.loadIndex), forced to a combination that exists: an unknown country becomes the first, a role the
 * country does not have becomes its first, a sex the role does not have prefers the same sex, then men, then the first. Returns the lists, the corrected
 * selection and the index entry of the population.
 */
export function populationOptions(index, sel = {}) {
  const countries = (index?.countries ?? []).map((c) => ({ id: c.id, name: c.name }));
  const c = index?.countries?.find((x) => x.id === sel.country) ?? index?.countries?.[0];
  const r = c?.roles.find((x) => x.id === sel.role) ?? c?.roles[0];
  const sexes = r?.sexes ?? [];
  const sex = sexes.includes(sel.sex) ? sel.sex : sexes.includes("M") ? "M" : sexes[0];
  const entry = index?.populations?.find((p) => p.country_id === c?.id && p.role_id === r?.id && p.sex === sex) ?? null;
  const count = (s) => index.populations.find((p) => p.country_id === c?.id && p.role_id === r?.id && p.sex === s)?.measures ?? 0;
  // the number of published measures goes into the label: it says how much of the body the survey really measured
  return { countries, roles: (c?.roles ?? []).map((x) => ({ id: x.id, name: x.name })), sexes: sexes.map((s) => ({ id: s, label: `${SEX_LABEL[s] ?? s} · ${fmtInt(count(s))} measure${count(s) === 1 ? "" : "s"}`, measures: count(s) })), sel: { country: c?.id, role: r?.id, sex }, entry };
}
/** How rich a population is: { measures, few, text } (few: so little is published that most of the body is estimated). */
export function populationHint(entry) {
  const n = entry?.measures ?? 0;
  if (!entry) return { measures: 0, few: true, text: "" };
  const few = n < FEW_MEASURES;
  const text = few
    ? `Only ${n} measure${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} published for this population, so most of the body is estimated from stature and mass (the dimension list says which).`
    : `${fmtInt(n)} measures are published for this population (the fewer, the more of the body the model has to estimate).`;
  return { measures: n, few, text };
}
/** anthro.percentileProfile cuts the ids it stores in `source` at 100 characters; a pooled population (many countries in one) has a longer id. */
export const SOURCE_ID_MAX = 100;
/** The entry of `list` ({ id }) that an id from a profile source means: the exact id, or the only one it is the cut-off start of. Else null. */
export function resolveSourceId(list, id) {
  if (typeof id !== "string" || !Array.isArray(list)) return null;
  const exact = list.find((x) => x.id === id);
  if (exact) return exact;
  const longer = id.length >= SOURCE_ID_MAX ? list.filter((x) => x.id.length > id.length && x.id.startsWith(id)) : [];
  return longer.length === 1 ? longer[0] : null;
}
/**
 * The selection a population profile came from, to put the controls back when another part of the page loads one. null for other profiles. With the loaded
 * `index` the ids that the profile cut short are completed (see SOURCE_ID_MAX), so that the controls keep showing the population that is on the stage.
 */
export function selectionOfProfile(profile, index) {
  const s = profile?.source;
  if (s?.kind !== "population") return null;
  const level = ["high", "medium", "low"].includes(s.minReliability) ? s.minReliability : "medium";
  let country = s.country_id, role = s.role_id;
  if (index?.countries) {
    const c = resolveSourceId(index.countries, country);
    if (c) { country = c.id; role = resolveSourceId(c.roles, role)?.id ?? role; }
  }
  return { country, role, sex: s.sex, percentile: Number(s.percentile) || 50, scaling: s.scaling === "proportional" ? "proportional" : "percentile", reliability: level, survey: s.survey ? "latest" : "combined" };
}

/**
 * A pooled sample is named after its member countries ("Multiple: Bolivia, Brazil, ... Venezuela"): too long for a label, and anthro.percentileProfile cuts the
 * label it builds at 100 characters, in the middle of a name. "Multiple (15 countries)" says the same in a line; any other name is returned as it is.
 */
export function shortCountry(name) {
  const m = /^Multiple:\s*(.+)$/i.exec(String(name ?? "").trim());
  if (!m) return String(name ?? "");
  const n = m[1].split(",").map((x) => x.trim()).filter(Boolean).length;
  return n > 1 ? `Multiple (${n} countries)` : String(name).trim();
}
/** The profile with the (cut) country at the start of its label replaced by the short name of a pooled sample; any other profile is returned as it is. */
export function tidyPopulationLabel(profile, entry) {
  const full = String(entry?.country ?? ""), short = shortCountry(full);
  if (!profile || short === full || typeof profile.label !== "string") return profile;
  const cut = full.replace(/\s+/g, " ").trim().slice(0, 100); // what anthro.cleanText wrote into the label
  return profile.label.startsWith(cut) ? { ...profile, label: short + profile.label.slice(cut.length) } : profile;
}

const LAST_KEY = "hm-profile-last";
const SLUG = /^[a-z0-9][a-z0-9-]{0,200}$/;
/** The remembered country / role / sex (only these three select values are ever stored), or null. localStorage may be blocked or corrupt. */
export function readLast(storage) {
  try {
    storage ??= globalThis.localStorage;
    const v = JSON.parse(storage?.getItem(LAST_KEY) ?? "null");
    if (v && SLUG.test(v.country) && SLUG.test(v.role) && ["M", "F", "both"].includes(v.sex)) return { country: v.country, role: v.role, sex: v.sex };
  } catch { /* no storage */ }
  return null;
}
export function writeLast(sel, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage?.setItem(LAST_KEY, JSON.stringify({ country: sel.country, role: sel.role, sex: sel.sex }));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// the dimension table (the mapping)
export const DIM_GROUPS = Object.freeze([
  { id: "overall", label: "Overall" }, { id: "head", label: "Head and neck" }, { id: "arms", label: "Shoulders and arms" }, { id: "hands", label: "Hands" },
  { id: "trunk", label: "Pelvis and trunk" }, { id: "legs", label: "Legs and feet" }, { id: "seated", label: "Seated posture" }, { id: "girths", label: "Girths (skin sections)" }, { id: "other", label: "Other" },
]);
const G = (group, ids) => Object.fromEntries(ids.map((i) => [i, group]));
export const DIM_GROUP = Object.freeze({
  ...G("overall", ["stature", "mass", "adiposity"]),
  ...G("head", ["vertex_to_eye", "tragion_below_eye", "head_pivot_depth", "neck_length", "head_length", "head_breadth", "bizygomatic_breadth", "menton_sellion_length", "interpupillary_breadth"]),
  ...G("arms", ["shoulder_height", "acromion_halfwidth", "acromion_to_gh", "gh_halfwidth", "shoulder_protraction", "upper_arm_length", "olecranon_drop", "forearm_length"]),
  ...G("hands", ["hand_length", "hand_breadth"]),
  ...G("trunk", ["c7_height", "trunk_length", "l5_above_hip", "hip_halfwidth", "hip_height"]),
  ...G("legs", ["femur_length", "knee_height", "shank_length", "ankle_height", "foot_length", "foot_breadth", "ball_length"]),
  ...G("seated", ["hip_to_seat", "knee_top_front", "popliteal_below_knee", "thigh_thickness", "buttock_back", "popliteal_setback"]),
});
export const groupOfDim = (id) => DIM_GROUP[id] ?? (id.startsWith("ring_") ? "girths" : "other");

/** What selecting a dimension shows in the 3D view: a joint or a landmark (ids of skeleton.js / MODEL.md section 5). */
export const DIM_TARGET = Object.freeze({
  stature: { landmark: "vertex" }, mass: { joint: "pelvis" }, adiposity: { joint: "pelvis" },
  vertex_to_eye: { landmark: "ectocanthus_L" }, tragion_below_eye: { landmark: "tragion_L" }, head_pivot_depth: { joint: "head" }, neck_length: { joint: "C4" }, head_length: { landmark: "glabella" },
  head_breadth: { landmark: "euryon_L" }, bizygomatic_breadth: { landmark: "zygion_L" }, menton_sellion_length: { landmark: "menton" }, interpupillary_breadth: { joint: "eye_L" },
  shoulder_height: { joint: "shoulder_L" }, acromion_halfwidth: { landmark: "acromion_L" }, acromion_to_gh: { joint: "shoulder_L" }, gh_halfwidth: { joint: "shoulder_L" }, shoulder_protraction: { joint: "shoulder_L" },
  upper_arm_length: { joint: "elbow_L" }, olecranon_drop: { landmark: "olecranon_L" }, forearm_length: { joint: "wrist_L" },
  hand_length: { landmark: "dactylion_L" }, hand_breadth: { landmark: "metacarpale_radiale_L" },
  c7_height: { joint: "C7" }, trunk_length: { joint: "T12" }, l5_above_hip: { joint: "L5" }, hip_halfwidth: { joint: "hip_L" }, hip_height: { joint: "pelvis" },
  femur_length: { joint: "knee_L" }, knee_height: { joint: "knee_L" }, shank_length: { joint: "ankle_L" }, ankle_height: { joint: "ankle_L" },
  foot_length: { landmark: "toe_tip_L" }, foot_breadth: { landmark: "metatarsale_tibiale_L" }, ball_length: { joint: "mtp_L" },
  hip_to_seat: { landmark: "ischial_L" }, knee_top_front: { landmark: "knee_top_L" }, popliteal_below_knee: { landmark: "popliteal_L" }, thigh_thickness: { landmark: "thigh_top_L" },
  buttock_back: { landmark: "buttock_extremity" }, popliteal_setback: { landmark: "popliteal_L" },
  ring_buttock: { joint: "pelvis" }, ring_waist: { landmark: "omphalion" }, ring_chest: { landmark: "chest_front" }, ring_neck_base: { landmark: "cervicale" }, ring_neck: { joint: "C4" },
  ring_biceps: { joint: "shoulder_L" }, ring_forearm: { joint: "elbow_L" }, ring_wrist: { joint: "wrist_L" }, ring_thigh: { joint: "hip_L" }, ring_knee: { joint: "knee_L" },
  ring_calf: { joint: "knee_L" }, ring_ankle: { joint: "ankle_L" }, ring_head: { joint: "head" },
});

/** Dimensions that ARE a profile measure (a typed value goes into the profile as that measure, so it also shows in the export). id -> measure keys, preferred first. */
export const DIRECT_MEASURE = Object.freeze({
  stature: ["stature"], mass: ["mass"], ankle_height: ["other:lateral_malleolus_height", "other:ankle_height"], knee_height: ["other:lateral_femoral_epicondyle_height"],
  hand_length: ["hand_length"], hand_breadth: ["hand_breadth"], foot_length: ["foot_length"], foot_breadth: ["foot_breadth"], head_length: ["head_length"], head_breadth: ["head_breadth"],
  bizygomatic_breadth: ["bizygomatic_breadth"], menton_sellion_length: ["menton_sellion_length"], interpupillary_breadth: ["interpupillary_breadth"], thigh_thickness: ["thigh_clearance"],
});
/** Dimensions computed from others (fit.js DEFS with no measure, no estimate and no override rule): editing them is refused; edit what they come from. */
export const PURE_DERIVED = Object.freeze({
  trunk_length: ["c7_height", "l5_above_hip", "femur_length"], neck_length: ["c7_height", "vertex_to_eye", "tragion_below_eye"], head_pivot_depth: ["vertex_to_eye", "tragion_below_eye"], ball_length: ["foot_length"],
});
/** Derived dimensions that fit.js turns into an edit of the dimension they come from (DERIVED_OVERRIDES). */
export const ALIASED_OVERRIDES = Object.freeze({ shank_length: "knee_height", hip_height: "femur_length", gh_halfwidth: "acromion_to_gh" });

const BAND = Object.fromEntries(DIM_DEFS.map((d) => [d.id, [typeof d.lo === "number" ? d.lo : null, typeof d.hi === "number" ? d.hi : null]]));
/** The plausible band of a dimension in metres, [lo, hi], with null for an edge that depends on other dimensions. */
export const bandOf = (id) => BAND[id] ?? [null, null];

/**
 * How a dimension can be edited: { kind: "measure", key, unit } (the value becomes that profile measure), { kind: "override" } (a fit override, metres), or
 * { kind: "none" | "derived", why, from? }. `row` needs id, status and via.
 */
export function editability(row) {
  const id = row.id;
  if (id === "adiposity") return { kind: "none", why: "A factor the model solves so that the volume of the body matches its mass." };
  if (id === "ring_head") return { kind: "none", why: "The head girth follows from the head length, the head breadth and a head circumference in the profile: edit those." };
  if (PURE_DERIVED[id]) return { kind: "derived", from: PURE_DERIVED[id], why: "Computed from other dimensions: edit those instead." };
  const keys = DIRECT_MEASURE[id];
  if (keys) {
    const key = row.status === "measured" && row.via?.length === 1 && keys.includes(row.via[0]) ? row.via[0] : keys[0];
    return { kind: "measure", key, unit: id === "mass" ? "kg" : "mm" };
  }
  return { kind: "override" };
}

/** The catalogue's name of a measure, in sentence case when the data has it in capitals ("TRAGION - TOP OF HEAD"). */
export function niceLabel(key, catalog) {
  const t = anthro.labelOf(key, catalog);
  return t.length > 3 && t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}

/** Rows of the dimension list from a BodyModel and the Profile it was built from. Values: lengths in metres (`value`) plus `mm`, mass in kg. */
export function dimensionRows(body, profile, catalog) {
  const meas = profile?.measures ?? {}, ov = profile?.overrides ?? {};
  return (body?.dims ?? []).map((d) => {
    const via = d.via ?? [];
    const row = {
      id: d.id, label: d.label, unit: d.unit, value: d.value, status: d.status, via, note: d.note ?? "", formula: d.formula ?? "", alt: d.alt ?? [],
      mm: d.unit === "m" ? d.value * 1000 : null, kind: d.unit === "kg" ? "kg" : d.unit === "ratio" ? "ratio" : "mm",
      viaLabels: via.map((k) => niceLabel(k, catalog)),
      edited: Object.hasOwn(ov, d.id) || (!!ALIASED_OVERRIDES[d.id] && Object.hasOwn(ov, ALIASED_OVERRIDES[d.id])) || via.some((k) => meas[k]?.status === "edited"),
      group: groupOfDim(d.id), target: DIM_TARGET[d.id] ?? null, band: bandOf(d.id),
      ...(d.id === "gh_halfwidth" ? { acromionHalfwidth: body.dims.find((x) => x.id === "acromion_halfwidth")?.value } : {}),
    };
    row.editability = editability(row);
    return row;
  });
}
/** Counts by status and edited, for the chips and the "estimated: N of M" summary. */
export function statusCounts(rows) {
  const c = { all: rows.length, measured: 0, derived: 0, estimated: 0, edited: 0 };
  for (const r of rows) { c[r.status] = (c[r.status] ?? 0) + 1; if (r.edited) c.edited++; }
  return c;
}
/** Rows with the status (or "edited") and every word of the query in the label, id, source measures or note. */
export function filterRows(rows, { status = "all", query = "" } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (status === "edited" ? !r.edited : status !== "all" && r.status !== status) return false;
    if (!words.length) return true;
    const hay = `${r.label} ${r.id} ${r.viaLabels.join(" ")} ${r.via.join(" ")} ${r.note} ${r.status}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
/** Rows grouped by body region in DIM_GROUPS order (empty groups left out): [{ group, label, rows }]. */
export function groupRows(rows) {
  return DIM_GROUPS.map((g) => ({ group: g.id, label: g.label, rows: rows.filter((r) => r.group === g.id) })).filter((g) => g.rows.length);
}
/** The "from" text of a row: the measures it came from, "estimated from stature, mass and sex", or "set by you". */
export function sourceText(row) {
  if (row.edited && !row.via.length) return "set by you";
  if (row.status === "estimated" || !row.via.length) return row.status === "estimated" ? "estimated from stature, mass and sex" : "derived from other dimensions";
  const l = row.viaLabels;
  return `from ${l.slice(0, 2).join(", ")}${l.length > 2 ? ` and ${l.length - 2} more` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// profile extras (form, dimension overrides), ids and labels
const hash53 = (str) => { // cyrb53: a short fingerprint for ids (not for security)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};
export const FORMS = Object.freeze(["male", "female", "neutral"]);
/** The form the fitter uses when none is chosen: from the profile's sex. */
export const defaultForm = (profile) => (profile?.sex === "M" ? "male" : profile?.sex === "F" ? "female" : "neutral");
const NOTE_EDIT = "Some values were edited by hand; the status of each measure says which.";
const NOTE_OVERRIDES = "Some dimensions of the model were set by hand (marked edited in the dimension list); the profile's measures do not show them.";
const noteForm = (form, auto) => `Body form: ${form} (chosen by you; the profile's sex would give ${auto}). The form changes the typical proportions, section shapes and mass distribution that fill in what is not measured.`;
const isOwnNote = (n) => n === NOTE_OVERRIDES || n.startsWith("Body form: ");

/**
 * The profile with its edits made consistent: id and label say what is in it (so that nothing keyed on the id mixes two bodies), the notes mention overrides and
 * a chosen form. `extras` = { form, overrides } replaces the fields when given (form: null clears it). Never changes the profile it is given.
 */
export function finalizeProfile(profile, extras = {}) {
  const p = { ...profile, measures: { ...profile.measures }, source: { ...profile.source }, notes: [...(profile.notes ?? [])] };
  if ("form" in extras) { if (FORMS.includes(extras.form)) p.form = extras.form; else delete p.form; }
  if ("overrides" in extras) { if (extras.overrides && Object.keys(extras.overrides).length) p.overrides = { ...extras.overrides }; else delete p.overrides; }
  if (p.form && !FORMS.includes(p.form)) delete p.form;
  const ovKeys = Object.keys(p.overrides ?? {}).sort();
  const edited = Object.values(p.measures).some((m) => m.status === "edited");
  const form = p.form && p.form !== defaultForm(p) ? p.form : null;
  if (!form) delete p.form; // the same as the default is no choice
  const base = String(profile.id ?? "profile").replace(/(~(edited|form|ov)(:[^~]*)?)+$/, "");
  const fingerprint = hash53(JSON.stringify([p.sex, Object.keys(p.measures).sort().map((k) => [k, p.measures[k].value, p.measures[k].unit]), ovKeys.map((k) => [k, p.overrides[k]]), form]));
  p.id = `${base}${edited || ovKeys.length ? `~edited:${fingerprint}` : ""}${ovKeys.length ? "~ov" : ""}${form ? `~form:${form}` : ""}`;
  let label = String(profile.label ?? "").replace(/( \(edited\)| · (male|female|neutral) form)+$/, "");
  if (form) label += ` · ${form} form`;
  if (edited || ovKeys.length) label += " (edited)";
  p.label = label;
  p.notes = p.notes.filter((n) => !isOwnNote(n));
  if (ovKeys.length) { if (!edited) p.notes = p.notes.filter((n) => n !== NOTE_EDIT); p.notes.push(NOTE_OVERRIDES); }
  if (!edited && !ovKeys.length) p.notes = p.notes.filter((n) => n !== NOTE_EDIT);
  else if (edited && !p.notes.includes(NOTE_EDIT)) p.notes.push(NOTE_EDIT);
  if (form) p.notes.push(noteForm(form, defaultForm(p)));
  return p;
}
/** How many things the person changed by hand in a profile: edited measures plus overridden dimensions. */
export function countEdits(profile) {
  return Object.values(profile?.measures ?? {}).filter((m) => m.status === "edited").length + Object.keys(profile?.overrides ?? {}).length;
}
/** A note or message with its first letter in capitals ("the model's arm hangs..." -> "The model's arm hangs..."). */
export const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
/**
 * The name to show for the figure on the stage: the profile's label, without " · female form" when the body was built in another form (a shell that does not
 * pass the form on): the label must not say what the figure is not.
 */
export function shownLabel(profile, body) {
  const label = String(profile?.label ?? "");
  if (profile?.form && body?.form && body.form !== profile.form && (body.profileId == null || body.profileId === profile.id)) return label.replace(` · ${profile.form} form`, "");
  return label;
}
/** Two profiles the fitter would turn into the same body (same id, form and overrides). */
export function sameProfile(a, b) {
  return !!a && !!b && a.id === b.id && (a.form ?? null) === (b.form ?? null) && JSON.stringify(a.overrides ?? {}) === JSON.stringify(b.overrides ?? {});
}

/** The name of a dimension for messages: the label without its parenthesis ("Hand length (stylion to the tip of the middle finger)" -> "Hand length"). */
export const plainLabel = (row) => String(row.label ?? row.id).replace(/\s*\(.*$/, "");
const LIMIT_MM = 5000;
/** "120 to 260 mm", "at least 20 mm", "at most 90 mm" for a plausible band in metres (null for an open edge). */
export function bandText(lo, hi) {
  const f = (m) => fmtLength(m * 1000, "mm", { suffix: false });
  return lo != null && hi != null ? `${f(lo)} to ${f(hi)} mm` : lo != null ? `at least ${f(lo)} mm` : hi != null ? `at most ${f(hi)} mm` : "range of a person";
}
let signedOk;
/**
 * Whether fitBody takes an override of zero or less (fit.js resolve() reads only `ov > 0`, although the plausible band of the shoulder protraction is -80 to +80 mm).
 * Probed once on a small body, so that nothing here has to change on the day fit.js learns it.
 */
export function fitTakesSignedOverrides() {
  if (signedOk === undefined) {
    try {
      const b = fitBody(anthro.manualProfile({ sex: "M", stature: 1750 }), { overrides: { shoulder_protraction: -0.02 } });
      signedOk = Math.abs((b.dims.find((d) => d.id === "shoulder_protraction")?.value ?? NaN) + 0.02) < 1e-6;
    } catch { signedOk = false; }
  }
  return signedOk;
}
/**
 * The profile with the dimension set to `value` (in `unit`: mm, cm, m or in; kg or lb for the mass). Throws an Error with a plain message when it cannot.
 * An edit of the shoulder half-width is stored as the acromion offset it comes from (the row carries the acromion half-width of its body): the fitter's
 * arm-span solver leaves that one alone, whereas it would undo an override of the derived half-width.
 */
export function editDimension(profile, row, value, unit = row.kind === "kg" ? "kg" : "mm") {
  const ed = row.editability ?? editability(row);
  if (ed.kind !== "measure" && ed.kind !== "override") throw new Error(ed.why ?? "This dimension cannot be edited.");
  const v = typeof value === "number" ? value : parseNumber(value);
  if (!Number.isFinite(v)) throw new Error("Enter the value as a number.");
  const name = row.kind === "kg" ? "Body mass" : plainLabel(row);
  const [lo, hi] = bandOf(row.id);
  if (row.kind === "kg") {
    const kg = unit === "lb" ? v * 0.45359237 : v;
    if (!(kg > 0)) throw new Error(`${name} must be more than zero.`);
  } else {
    const mm = toMm(v, unit);
    if (!Number.isFinite(mm)) throw new Error(`Unknown unit “${unit}”.`);
    const mayBeNegative = lo != null && lo < 0; // a signed offset (the shoulder protraction): zero and negative values are real
    if (Math.abs(mm) > LIMIT_MM) throw new Error("A dimension of a person is between 0 and 5 metres.");
    if (!mayBeNegative && !(mm > 0)) throw new Error(`${name} must be more than zero.`);
    // a signed offset is a real thing, but a fitter that drops it would also skip its own solver for the dimension and leave the figure with a value nobody
    // asked for: refuse with the reason instead of storing an edit that does nothing
    if (mayBeNegative && !(mm > 0) && !fitTakesSignedOverrides()) throw new Error(`The model cannot use a value of zero or less for “${name}” yet (the fitting module ignores it, so the figure would not change). Enter a value above zero (the range is ${bandText(lo, hi)}) or leave it as it is.`);
    // a measure outside the plausible band would be refused by the model (it falls back to another route) while the profile, and its export, keep the value
    if (ed.kind === "measure" && row.id !== "stature" && ((lo != null && mm < lo * 1000) || (hi != null && mm > hi * 1000))) {
      throw new Error(`${name} of ${fmtLength(mm, "mm")} is outside the ${bandText(lo, hi)} that the model accepts for this dimension.`);
    }
  }
  if (ed.kind === "measure") return finalizeProfile(anthro.editMeasure(profile, ed.key, v, unit)); // its range errors (stature, mass) are plain already
  const mm = toMm(v, unit);
  const ov = { ...(profile.overrides ?? {}) };
  if (row.id === "gh_halfwidth") {
    const half = row.acromionHalfwidth;
    if (Number.isFinite(half)) { // a half-width wider than the acromion leaves no offset: the smallest positive one lets the model hold it at its lower limit and say so
      ov.acromion_to_gh = Math.max(1e-6, half - mm / 1000);
      delete ov.gh_halfwidth;
      return finalizeProfile(profile, { overrides: ov });
    }
  }
  ov[row.id] = mm / 1000;
  return finalizeProfile(profile, { overrides: ov });
}
/** Undo the edit of one dimension (its measure back to the value it had, or its override removed). */
export function revertDimension(profile, row) {
  const ed = row.editability ?? editability(row);
  if (ed.kind === "measure") {
    const key = [ed.key, ...(row.via ?? [])].find((k) => profile.measures[k]?.status === "edited");
    return key ? finalizeProfile(anthro.revertMeasure(profile, key)) : profile;
  }
  const ov = { ...(profile.overrides ?? {}) }, from = ALIASED_OVERRIDES[row.id];
  delete ov[row.id];
  if (from) delete ov[from]; // the row is marked edited by an edit of the dimension it comes from
  const p = finalizeProfile(profile, { overrides: ov });
  if (!from) return p;
  const src = { id: from, via: row.via ?? [], status: "derived" }; // that dimension may be a profile measure (knee height): its edit goes too
  src.editability = editability(src);
  return src.editability.kind === "measure" ? revertDimension(p, src) : p;
}
/** Undo every edit: edited measures back to their values, overrides removed. */
export function revertAll(profile) {
  let p = profile;
  for (const [k, m] of Object.entries(profile.measures)) if (m.status === "edited") p = anthro.revertMeasure(p, k);
  return finalizeProfile(p, { overrides: {} });
}
// The warning fit.js adds when it had to move an edited dimension or girth into its plausible range (fit.js inBand, ringOverride).
const heldWarning = (body, ...names) => (body?.warnings ?? []).some((t) => names.some((n) => t.startsWith(`The edited ${n} (`)));
const ringName = (id) => id.slice(5).replace("_", " ") + " girth"; // fit.js ringOverride: ring_neck_base -> "neck base girth"
/** The ids of the overrides of `profile` that the model did not apply, [] when all were. An edit that was applied and then held in its range counts as applied. */
export function unappliedOverrides(profile, body) {
  if (!profile || !body) return [];
  return Object.entries(profile.overrides ?? {}).filter(([id, v]) => {
    const d = body.dims?.find((x) => x.id === id);
    if (!d) return false;
    if (/limited to|plausible|clamp/.test(d.note ?? "")) return false; // applied, then held inside the band
    if (id.startsWith("ring_")) return Math.abs(d.value - v) > 0.02 * v && !heldWarning(body, ringName(id)); // a girth is held within 1.5 % by the section; fit.js clamps extreme ones (0.4 to 2.2 x typical) and says so only in the warnings
    // an alias (shank length, hip height, ...) is an edit of the dimension it is derived from: that one carries the note
    const target = ALIASED_OVERRIDES[id] ? body.dims.find((x) => x.id === ALIASED_OVERRIDES[id]) : d;
    return !(target?.note ?? "").includes("overridden by the user");
  }).map(([id]) => id);
}
/** Edits the model did not apply (a shell that does not pass `form` or `overrides` on to fitBody): ["the body form", "the dimension edits"], empty when all is applied. */
export function verifyExtras(profile, body) {
  const out = [];
  if (!profile || !body) return out;
  if (profile.form && body.form && body.form !== profile.form) out.push("the body form");
  if (unappliedOverrides(profile, body).length) out.push("the dimension edits");
  return out;
}
const labelOfDim = (body, id) => `“${plainLabel(body?.dims?.find((d) => d.id === id) ?? { id, label: id })}”`;
/**
 * What to tell the person when the model did not apply their body form or dimension edits, or null when it did. Says which: a shell that passes nothing on
 * (the form and every edit missing) is a different problem from one edit the fitter cannot take (a zero or negative offset).
 */
export function extrasNotice(profile, body) {
  const missing = verifyExtras(profile, body);
  if (!missing.length) return null;
  const ids = unappliedOverrides(profile, body), all = Object.keys(profile.overrides ?? {});
  const signed = ids.filter((id) => !(profile.overrides[id] > 0)); // fit.js ignores an override of zero or less
  const rest = ids.filter((id) => !signed.includes(id));
  const bits = [];
  if (missing.includes("the body form")) bits.push("the body form");
  const shellDrops = missing.includes("the body form") ? rest.length > 0 : rest.length > 0 && rest.length === all.filter((id) => !signed.includes(id)).length;
  if (rest.length) bits.push(shellDrops ? "the dimension edits" : `your edit of ${rest.slice(0, 3).map((id) => labelOfDim(body, id)).join(", ")}${rest.length > 3 ? ` and ${rest.length - 3} more` : ""}`);
  let text = "";
  if (bits.length) {
    text = `The model ignored ${bits.join(" and ")}${shellDrops ? ": this build of the Digital human view passes only the measures of the profile to the fitting module. Edit the measures instead (for example the stature) or ask for the update." : ": the fitting module did not use it for the profile in use."}`;
    // a form has no edit to revert: the way back is the Auto choice of the Body form control
    if (missing.includes("the body form")) text += " Choose Auto under Body form to go back to the form the profile's sex gives.";
    if (rest.length && !shellDrops) text += " Revert the edit to clear this message.";
  }
  if (signed.length) text += `${text ? " " : ""}The fitting module does not take a value of zero or less for ${signed.map((id) => labelOfDim(body, id)).join(", ")} yet, so that edit was not applied. Revert it to get the earlier shape back.`;
  return text;
}

/**
 * Whether the model built the edited dimension as asked. `askedMm` is the value that was typed in mm (kg for the mass). Returns null when it did, else
 * { level: "warn", text } saying what happened: held at the edge of the plausible range, the edit not applied, or built a little differently.
 */
export function explainEdit(row, askedMm, body, unit = "mm") {
  const d = body?.dims?.find((x) => x.id === row.id);
  if (!d || !Number.isFinite(askedMm)) return null;
  const kg = row.kind === "kg", built = kg ? d.value : d.value * 1000;
  const show = (v) => (kg ? fmtKg(v) : fmtLength(v, unit));
  const name = kg ? "Body mass" : plainLabel(row);
  const tol = Math.max(kg ? 0.05 : 1, Math.abs(askedMm) * 0.003);
  if (Math.abs(built - askedMm) <= tol) return null;
  const alias = ALIASED_OVERRIDES[row.id] ? body.dims.find((x) => x.id === ALIASED_OVERRIDES[row.id]) : null;
  const edge = [d, alias].some((x) => x && /limited to/.test(x.note ?? "")) || heldWarning(body, d.label, alias?.label ?? "", ...(row.id.startsWith("ring_") ? [ringName(row.id)] : []));
  if (edge) return { level: "warn", text: `${name} was held to ${show(built)}: ${show(askedMm)} is outside the range the model accepts for this dimension.` };
  if (row.editability?.kind === "override") {
    const ring = row.id.startsWith("ring_"); // a girth is solved with its section: its note does not say "overridden", and it is held within 1.5 %
    if (!ring && ![d, alias].some((x) => (x?.note ?? "").includes("overridden by the user"))) return { level: "warn", text: `The model did not apply this edit: ${name} is ${show(built)}.` };
    if (ring && Math.abs(built - askedMm) <= 0.02 * Math.abs(askedMm)) return { level: "info", text: `${name} was fitted as ${show(built)}: the body section cannot hold ${show(askedMm)} exactly (it holds a girth within 1.5 %).` };
    if (ring) return { level: "warn", text: `The model did not apply this edit: ${name} is ${show(built)}.` };
    return { level: "warn", text: `${name} was built as ${show(built)} instead of ${show(askedMm)}: other dimensions it depends on limit it.` };
  }
  return { level: "warn", text: `The model did not accept ${show(askedMm)} for ${name} and used ${show(built)} from another route (see the note of the dimension).` };
}

// ---------------------------------------------------------------------------------------------------------------------
// fit report
const RANK = { off: 0, warn: 1, ok: 2, "n/a": 3 };
/** Rows ordered by status (off, warn, ok, n/a), the model's own order inside a status. */
export function sortReport(rows) {
  return rows.map((r, i) => [r, i]).sort((a, b) => (RANK[a[0].status] ?? 9) - (RANK[b[0].status] ?? 9) || a[1] - b[1]).map((x) => x[0]);
}
export const splitReport = (rows) => ({ measures: rows.filter((r) => r.kind === "measure"), checks: rows.filter((r) => r.kind === "check") });
/** { evaluated, ok, warn, off, na, text, detail }: "38 of 41 checks within tolerance" counts every row that has an input (measures and cross-checks). */
export function reportSummary(rows) {
  const c = { ok: 0, warn: 0, off: 0, na: 0 };
  for (const r of rows) { if (r.status === "n/a") c.na++; else if (r.status in c) c[r.status]++; }
  const evaluated = c.ok + c.warn + c.off;
  const bits = [];
  if (c.warn) bits.push(`${c.warn} close (warn)`);
  if (c.off) bits.push(`${c.off} off`);
  if (c.na) bits.push(`${c.na} without an input value`);
  // a population that publishes next to nothing leaves nothing to compare: "0 of 0 checks within tolerance" would read like a failure
  return { evaluated, ...c, text: evaluated ? `${c.ok} of ${evaluated} checks within tolerance` : "Nothing to check: the profile has none of the measures the report compares", detail: bits.join(", ") };
}

// ---------------------------------------------------------------------------------------------------------------------
// the in-browser database: pickers and paging
export const PAGE_SIZE = 20;
/** Paging maths for a list of `total` items, 0-based `page`: the page is held inside the list; from/to are 1-based for "Showing 21 to 40 of 1,774". */
export function pageInfo(total, page = 0, size = PAGE_SIZE) {
  const n = Math.max(0, Math.trunc(total) || 0), s = Math.max(1, Math.trunc(size) || PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(n / s));
  const p = Math.min(pages - 1, Math.max(0, Math.trunc(page) || 0));
  const offset = p * s;
  return { page: p, pages, size: s, offset, from: n ? offset + 1 : 0, to: Math.min(n, offset + s), total: n, hasPrev: p > 0, hasNext: p < pages - 1 };
}
/**
 * Choices of the person picker from anthro.subjectFilters rows ({ dataset, sex, branch, n }), forced to a combination that exists:
 * { datasets: [{ id, name, n }], sexes: [{ id, label, n }], branches: [{ id, n }], sel: { dataset, sex, branch }, n } (n: people with the selection).
 */
export function subjectOptions(filters, sel = {}) {
  const rows = Array.isArray(filters) ? filters : [];
  const order = Object.keys(anthro.SUBJECT_DATASETS);
  const total = (f) => f.reduce((a, r) => a + (Number(r.n) || 0), 0);
  const ids = [...new Set(rows.map((r) => r.dataset))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const datasets = ids.map((id) => ({ id, name: anthro.SUBJECT_DATASETS[id] ?? id, n: total(rows.filter((r) => r.dataset === id)) }));
  const dataset = ids.includes(sel.dataset) ? sel.dataset : ids[0] ?? null;
  const inD = rows.filter((r) => r.dataset === dataset);
  const sexIds = [...new Set(inD.map((r) => r.sex))].sort();
  const sex = sexIds.includes(sel.sex) ? sel.sex : sexIds.includes("M") ? "M" : sexIds[0] ?? null;
  const sexes = sexIds.map((id) => ({ id, label: SEX_LABEL[id] ?? id, n: total(inD.filter((r) => r.sex === id)) }));
  const inS = inD.filter((r) => r.sex === sex);
  const branchIds = [...new Set(inS.map((r) => r.branch).filter((b) => b != null && b !== ""))].sort();
  const branch = branchIds.includes(sel.branch) ? sel.branch : null;
  const branches = branchIds.map((id) => ({ id, n: total(inS.filter((r) => r.branch === id)) }));
  return { datasets, sexes, branches, sel: { dataset, sex, branch }, n: total(inS.filter((r) => branch == null || r.branch === branch)) };
}
/** One line of the person list: "#3045 · 1,762 mm · 78.2 kg". People stay anonymous: only the survey's own number is shown. */
export function subjectLabel(row, unit = "mm") {
  return `#${row.subject_key} · ${fmtLength(row.stature, unit)} · ${row.mass == null ? "mass not measured" : fmtKg(row.mass)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// import and manual entry
export const IMPORT_EXTENSIONS = Object.freeze([".json", ".csv", ".tsv", ".txt"]);
export const EXAMPLE_CSV = "key,value,unit\nstature,1755,mm\nmass,80,kg\nsitting_height,925,mm\nbuttock_knee_length,590,mm\nhand_length,190,mm\nfoot_length,268,mm\n";
export const EXAMPLE_JSON = JSON.stringify({ sex: "M", label: "Example person", stature: "1755 mm", mass: "80 kg", sitting_height: "925 mm", buttock_knee_length: "590 mm", hand_length: "190 mm", foot_length: "268 mm" }, null, 2) + "\n";
/** Why a file cannot be imported before it is even read (null when it can): the wrong type, empty, or too large. */
export function checkImportFile(file) {
  if (!file) return "No file was given.";
  const name = String(file.name ?? ""), ext = (/\.[^./\\]+$/.exec(name)?.[0] ?? "").toLowerCase();
  if (ext && !IMPORT_EXTENSIONS.includes(ext)) return `“${name.slice(0, 40)}” is a ${ext} file. Only JSON and CSV files can be imported (export a spreadsheet as CSV first).`;
  if (file.size === 0) return `“${name.slice(0, 40)}” is empty.`;
  if (file.size > anthro.MAX_IMPORT_CHARS) return `“${name.slice(0, 40)}” is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${anthro.MAX_IMPORT_CHARS / 1e6} MB.`;
  return null;
}
/** { message, hint } for an error thrown by anthro.parseImport (or by reading the file): the message as is, plus what to do about it when we know. */
export function explainImportError(err) {
  const message = String(err?.message ?? err ?? "The file could not be read.").replace(/\s+/g, " ").trim();
  const rules = [
    [/no stature/i, "Add a row such as stature,1750,mm (or a “stature” entry in JSON)."],
    [/not valid JSON|is named \.json/i, "Look for a missing comma, quote or bracket. A CSV file needs a header line such as key,value,unit."],
    [/too large/i, "Cut the file down to the measures you need (stature, mass, lengths)."],
    [/outside|too small|too large for|not a number|Unknown unit|is measured in/i, "Give the unit next to each number (mm, cm, m, in, kg or lb) or in a unit column."],
    [/No measures|CSV not recognised|has no rows/i, "Use one row per measure: key,value,unit, for example stature,1750,mm. “Download an example” shows the format."],
    [/HTML or XML/i, "Save the data itself (JSON or CSV), not a web page."],
    [/less reliable/i, "Choose a lower reliability level below and try again."],
  ];
  const hint = rules.find(([re]) => re.test(message))?.[1] ?? "";
  return { message, hint };
}
/**
 * Profile from the manual form: { sex: "M" | "F" | "both", stature, statureUnit, mass, massUnit } (values as typed). Throws an Error that says what to fix.
 * The model is built for statures from 1.3 m to 2.5 m; anything else it would replace by an average body, so it is refused here with the reason.
 */
export function manualFromForm({ sex = "both", stature, statureUnit = "mm", mass, massUnit = "kg" } = {}) {
  const st = parseNumber(stature);
  if (!Number.isFinite(st)) throw new Error("Enter the stature as a number.");
  if (!STATURE_UNITS.includes(statureUnit)) throw new Error(`Unknown stature unit “${statureUnit}”.`);
  const mm = toMm(st, statureUnit);
  if (!(mm >= 1300 && mm <= 2500)) throw new Error(`A stature of ${fmtInt(mm)} mm is outside the 1,300 to 2,500 mm the model is built for (adults). Check the number and the unit.`);
  let m;
  if (String(mass ?? "").trim() !== "") {
    m = parseNumber(mass);
    if (!Number.isFinite(m)) throw new Error("Enter the body mass as a number, or leave it empty.");
    if (!MASS_UNITS.includes(massUnit)) throw new Error(`Unknown mass unit “${massUnit}”.`);
  }
  return anthro.manualProfile({ sex, stature: st, statureUnit, mass: m, massUnit });
}

// ---------------------------------------------------------------------------------------------------------------------
// ---- panel
export const MODEL_NOTES = Object.freeze([
  "A simplified kinematic and anthropometric visualisation: rigid links between approximate joint centres, estimated from external measurements. Real joint centres differ by a few centimetres.",
  "Ranges of motion are rounded textbook values for healthy adults, widened in places so that deep squats and floor sitting can be shown. They are not clinical limits.",
  "No soft-tissue deformation: the skin follows the bones but does not compress, bulge or fold, so contact with seats and objects is approximate.",
  "No strength, fatigue, comfort or injury model. This is a visualisation for design studies, not a safety or certification tool.",
  "Population profiles are boundary cases: a P95 body takes the 95th percentile of every measure on its own, which nobody has. Measures a survey does not publish are estimated from stature and mass and marked estimated.",
]);

let subjectQuery; // injectable for tests and demo pages: (sql, params) -> { columns, rows }; the default is the site's sql.js database
export function setSubjectQuery(fn) { subjectQuery = typeof fn === "function" ? fn : undefined; }

const el = (tag, cls, ...kids) => h(tag, { class: cls }, ...kids);
const msgOf = (e) => String(e?.message ?? e ?? "unknown error").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 300);

async function mount(container, ctx) {
  await ensureStyles();
  let disposed = false;
  const offs = [];
  anthro.loadMeasures().then(() => { if (!disposed) renderDims(); }).catch(() => { /* labels fall back to the key */ });
  const seen = new Map(); // profile id -> profile, so that the dimension list can tell which profile its body came from
  const note = (p) => { if (p?.id) { seen.set(p.id, p); if (seen.size > 12) seen.delete(seen.keys().next().value); } };

  // ---- panel state
  const initial = selectionOfProfile(ctx.getProfile());
  const last = readLast();
  const pop = { country: initial?.country ?? last?.country ?? "united-states", role: initial?.role ?? last?.role ?? "army", sex: initial?.sex ?? last?.sex ?? "M", percentile: initial?.percentile ?? 50, extended: false,
    scaling: initial?.scaling ?? "percentile", reliability: initial?.reliability ?? "medium", survey: initial?.survey ?? "combined" };
  pop.extended = pop.percentile < 5 || pop.percentile > 95;
  let formChoice = ctx.getProfile()?.form ?? null;
  const dimState = { filter: "all", query: "", open: null };
  let src = initial ? "population" : (({ individual: "individual", import: "import", manual: "manual", population: "population" })[ctx.getProfile()?.source?.kind] ?? "population");
  let editResult = null; // what the model did with the last dimension edit, shown in the row it was made in: { rowId, profileId, level, text }
  let poseRows = null; // fit report rows evaluated in the current pose (id -> row), or null
  let rows = []; // dimension rows of the current body

  const root = el("div", "hm-pf");
  container.replaceChildren(root);

  // ---- status line (loading / errors / what was built)
  const status = el("div", "hm-pf-status small");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  let statusKind = "ok", building = 0, editNote = false; // building: submits in flight; editNote: the line is the result of a dimension edit
  const setStatus = (kind, content) => {
    statusKind = kind;
    editNote = false;
    status.className = `hm-pf-status small hm-pf-status-${kind}`;
    status.replaceChildren(...[].concat(content ?? []).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  };
  /** The line after a build: what is shown, and what of the person's choices the model did not take. */
  function showBuilt(fallbackLabel) {
    const cur = ctx.getProfile(), b = ctx.getBody();
    const miss = cur && b && (b.profileId == null || b.profileId === cur.id) ? verifyExtras(cur, b) : [];
    const label = (cur ? shownLabel(cur, b) : null) ?? fallbackLabel;
    if (miss.length) setStatus("warn", `Showing ${label}, but the model did not apply ${miss.join(" and ")} (the message above the 3D view says why).`);
    else setStatus("ok", `Showing ${label}`);
  }
  const retryBtn = (fn) => h("button", { type: "button", class: "btn small", onclick: fn }, "Retry");

  // ---- the profile in use
  const curName = el("div", "hm-pf-name"), curFacts = el("div", "hm-pf-facts small"), curMeter = el("div", "hm-pf-meter"), curMeterText = el("div", "hm-pf-metertext small");
  curMeter.setAttribute("role", "img");
  const current = el("div", "hm-pf-card", curName, curFacts, curMeter, curMeterText);
  function renderCurrent() {
    const p = ctx.getProfile(), b = ctx.getBody();
    curName.textContent = (p ? shownLabel(p, b) : null) ?? "Loading the profile…";
    const facts = [];
    if (b) {
      facts.push(h("span", {}, "Stature ", h("b", {}, ctx.fmt(b.stature * 1000))), h("span", {}, "Mass ", h("b", {}, fmtKg(b.mass))), h("span", {}, "Form ", h("b", {}, b.form)));
    }
    curFacts.replaceChildren(...facts);
    const c = statusCounts(rows);
    curMeter.replaceChildren(...["measured", "derived", "estimated"].map((s) => h("i", { class: `hm-pf-seg hm-st-${s}`, style: { flexGrow: String(c[s] || 0) } })));
    curMeter.style.display = c.all ? "" : "none";
    curMeter.setAttribute("aria-label", `${c.measured} measured, ${c.derived} derived, ${c.estimated} estimated of ${c.all} dimensions`);
    curMeterText.textContent = c.all ? `Estimated: ${c.estimated} of ${c.all} dimensions · derived ${c.derived} · measured ${c.measured}${c.edited ? ` · edited ${c.edited}` : ""}` : "";
  }

  // ---- submit a profile to the shell (the one place that calls ctx.setProfile)
  let submitGen = 0;
  async function submit(profile, { immediate = true, quiet = false } = {}) {
    const p = finalizeProfile(profile, { form: formChoice });
    note(p);
    if (sameProfile(p, ctx.getProfile())) { if (!quiet) setStatus("ok", `Showing ${p.label}`); return { ok: true, same: true }; }
    const my = ++submitGen;
    setStatus("busy", [h("span", { class: "spinner", "aria-hidden": "true" }), " Building the model…"]);
    let res;
    building++;
    try { res = await ctx.setProfile(p, { immediate }); } catch (e) { res = { ok: false, error: e }; } finally { building--; }
    if (disposed || my !== submitGen) return res;
    if (res?.ok === false && res.superseded !== true) setStatus("error", `The model could not be built (${msgOf(res.error ?? "see the message above the 3D view")}).`);
    else showBuilt(p.label);
    return res;
  }

  // =====================================================================================================================
  // source: population
  const popView = el("div", "hm-pf-view");
  let index = null, indexState = "idle", popGen = 0, popTimer = 0, popEntry = null;
  const ids = { country: nextId("hm-pf-country"), role: nextId("hm-pf-role"), sex: nextId("hm-pf-sex"), rel: nextId("hm-pf-rel") };
  const selCountry = h("select", { class: "input", id: ids.country }), selRole = h("select", { class: "input", id: ids.role }), selSex = h("select", { class: "input", id: ids.sex });
  const popHint = el("p", "hm-pf-hint small muted"), poolNote = el("p", "small muted");
  const sliderHost = el("div", "hm-pf-slider");
  const quick = [5, 50, 95].map((v) => h("button", { type: "button", class: "btn small", "aria-pressed": "false", title: `Percentile ${v}`, onclick: () => setPercentile(v, true) }, `P${v}`));
  const extToggle = h("input", { type: "checkbox", id: nextId("hm-pf-ext") });
  const radios = SCALING_OPTIONS.map(([v, title, why]) => {
    const input = h("input", { type: "radio", name: "hm-pf-scaling", value: v });
    input.addEventListener("change", () => { if (input.checked) { pop.scaling = v; schedulePop(0); } });
    return { v, input, el: h("label", { class: "hm-pf-radio" }, input, h("span", {}, h("span", { class: "hm-pf-radio-t" }, title), h("span", { class: "small muted" }, why))) };
  });
  const selRel = h("select", { class: "input", id: ids.rel }, RELIABILITY_OPTIONS.map(([v, t]) => h("option", { value: v }, t)));
  const relHint = el("p", "small muted");
  const surveyHost = el("div", "hm-pf-survey");
  let surveySeg = null;

  function buildSlider() {
    const lo = pop.extended ? 1 : 5, hi = pop.extended ? 99 : 95;
    pop.percentile = Math.min(hi, Math.max(lo, Math.round(pop.percentile)));
    const sl = sliderRow({ label: "Percentile", min: lo, max: hi, step: 1, value: pop.percentile, unit: "", hint: pop.extended ? "extrapolated outside 5 to 95" : "", onInput: (v) => setPercentile(v, false), onChange: (v) => setPercentile(v, true) });
    sliderHost.replaceChildren(sl.el);
    sliderHost.slider = sl;
    syncQuick();
  }
  function syncQuick() { for (const b of quick) b.setAttribute("aria-pressed", String(b.textContent === `P${pop.percentile}`)); }
  function setPercentile(v, commit) {
    pop.percentile = Math.round(v);
    sliderHost.slider?.set(pop.percentile);
    syncQuick();
    if (commit) schedulePop(0); else schedulePop(140);
  }
  extToggle.addEventListener("change", () => { pop.extended = extToggle.checked; buildSlider(); schedulePop(0); });

  function fillSelect(sel, items, value) {
    sel.replaceChildren(...items.map((it) => h("option", { value: it.id, title: it.title ?? null }, it.name ?? it.label)));
    sel.value = value ?? "";
  }
  function renderPopulationChoices() {
    const o = populationOptions(index, pop);
    Object.assign(pop, o.sel);
    popEntry = o.entry;
    fillSelect(selCountry, o.countries.map((c) => ({ id: c.id, name: shortCountry(c.name), title: shortCountry(c.name) === c.name ? null : c.name })), pop.country);
    const full = String(popEntry?.country ?? "");
    poolNote.textContent = shortCountry(full) === full ? "" : `Pooled sample of ${full.replace(/^Multiple:\s*/i, "")}.`; // the short name hides the members
    poolNote.hidden = !poolNote.textContent;
    fillSelect(selRole, o.roles, pop.role);
    fillSelect(selSex, o.sexes, pop.sex);
    const hint = populationHint(popEntry);
    popHint.textContent = hint.text;
    popHint.classList.toggle("hm-pf-warnline", hint.few);
    if (popEntry && !popEntry.has_latest) pop.survey = "combined";
    surveyHost.replaceChildren();
    surveySeg = null;
    if (popEntry?.has_latest) {
      const ls = popEntry.latest_survey;
      surveySeg = segmented({ label: "Which survey", value: pop.survey, options: [{ value: "combined", label: "Combined surveys", title: "All surveys of this population together" }, { value: "latest", label: "Latest survey", title: "Only the most recent survey" }],
        onChange: (v) => { pop.survey = v; schedulePop(0); } });
      surveyHost.append(el("div", "field-label", "Survey"), surveySeg.el, el("p", "small muted", ls ? `Latest: ${ls.name}${ls.year ? ` (${ls.year})` : ""}.` : ""));
    }
    for (const r of radios) r.input.checked = pop.scaling === r.v;
    selRel.value = pop.reliability;
    relHint.textContent = RELIABILITY_OPTIONS.find((r) => r[0] === pop.reliability)?.[2] ?? "";
    extToggle.checked = pop.extended;
  }
  async function loadIndex() {
    indexState = "loading";
    renderPopulationView();
    try {
      index = await anthro.loadIndex();
      indexState = "ready";
      const sel = selectionOfProfile(ctx.getProfile(), index); // a population profile that arrived while the list was loading
      if (sel) { Object.assign(pop, sel); pop.extended = pop.percentile < 5 || pop.percentile > 95; }
    } catch (e) {
      indexState = "error";
      index = null;
      popView.errorText = msgOf(e);
    }
    if (disposed) return;
    renderPopulationView();
  }
  function renderPopulationView() {
    if (indexState === "loading" || indexState === "idle") { popView.replaceChildren(h("div", { class: "loading", role: "status" }, el("div", "spinner"), "Loading the list of populations…")); return; }
    if (indexState === "error") {
      popView.replaceChildren(notice(`The list of populations could not be loaded (${popView.errorText}). You can still import a file or type a stature and mass.`, { level: "warn" }), h("p", {}, retryBtn(loadIndex)));
      return;
    }
    renderPopulationChoices();
    popView.replaceChildren(
      el("div", "field", h("label", { for: ids.country }, "Country"), selCountry),
      el("div", "field", h("label", { for: ids.role }, "Branch or role"), selRole),
      el("div", "field", h("label", { for: ids.sex }, "Sex"), selSex),
      poolNote, popHint,
      sliderHost, el("div", "hm-pf-quick", el("span", "small muted", "Quick:"), quick, h("label", { class: "hm-pf-check small", for: extToggle.id }, extToggle, "Extended 1 to 99 (extrapolated)")),
      h("fieldset", { class: "hm-pf-fieldset" }, h("legend", {}, "How to scale"), radios.map((r) => r.el)),
      el("div", "field", h("label", { for: ids.rel }, "Reliability filter"), selRel, relHint),
      surveyHost);
    buildSlider();
  }
  for (const [sel, key] of [[selCountry, "country"], [selRole, "role"], [selSex, "sex"]]) {
    sel.addEventListener("change", () => {
      pop[key] = sel.value;
      if (key === "country") pop.role = null; // the first role of the new country; the sex is kept when the role has it (populationOptions)
      renderPopulationChoices();
      writeLast(pop);
      schedulePop(120);
    });
  }
  selRel.addEventListener("change", () => { pop.reliability = selRel.value; relHint.textContent = RELIABILITY_OPTIONS.find((r) => r[0] === pop.reliability)?.[2] ?? ""; schedulePop(0); });

  function schedulePop(ms) {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => { popTimer = 0; applyPopulation(); }, ms);
  }
  /** Load the population file (cached by anthro), take the percentile, build. Only the newest request may finish: an older one that returns late is dropped. */
  async function applyPopulation() {
    clearTimeout(popTimer);
    popTimer = 0;
    if (!popEntry || disposed) return;
    const my = ++popGen, entry = popEntry, opts = { percentile: pop.percentile, scaling: pop.scaling, minReliability: pop.reliability, meanStature: true };
    const latest = pop.survey === "latest" && entry.has_latest;
    setStatus("busy", [h("span", { class: "spinner", "aria-hidden": "true" }), ` Loading ${shortCountry(entry.country)} · ${entry.role}…`]);
    let profile, file;
    try {
      file = await anthro.loadPopulation(entry, { latest });
    } catch (e) { // the network, a missing file: asking again can help
      if (my !== popGen || disposed) return;
      setStatus("error", [`${msgOf(e)}. `, retryBtn(applyPopulation)]);
      return;
    }
    if (my !== popGen || disposed) return;
    try {
      profile = tidyPopulationLabel(anthro.percentileProfile(file, opts), entry);
    } catch (e) { // the data cannot give this profile (no stature to scale by): another choice is needed, not another try
      setStatus("error", `${msgOf(e)}. Choose another way to scale or another reliability level.`);
      return;
    }
    if (my !== popGen) return;
    writeLast(pop);
    const before = ctx.getProfile(), lost = countEdits(before);
    const res = await submit(profile, { immediate: true });
    // a new population is a new body: the edits of the old one cannot follow (they are values of that body). Say so, and offer the way back.
    if (lost && my === popGen && !disposed && res?.ok !== false && !res?.same && ctx.getProfile()?.id !== before?.id) {
      setStatus("warn", [`Loaded ${profile.label}. Your ${lost} edit${lost === 1 ? "" : "s"} to the previous profile ${lost === 1 ? "was" : "were"} not carried over. `,
        h("button", { type: "button", class: "btn small", onclick: () => submit(before) }, "Go back to the previous profile")]);
    }
  }

  // =====================================================================================================================
  // source: individual (the in-browser database)
  const indView = el("div", "hm-pf-view");
  const ind = { closest: { stature: null, mass: null }, number: "", state: "idle", filters: null, sel: { dataset: null, sex: null, branch: null }, method: "closest", page: 0, total: 0, listRows: [], gen: 0, message: null, error: null };
  const iids = { ds: nextId("hm-pf-ds"), sex: nextId("hm-pf-isex"), br: nextId("hm-pf-br"), st: nextId("hm-pf-ist"), ms: nextId("hm-pf-ims"), num: nextId("hm-pf-inum") };
  async function loadFilters() {
    ind.state = "loading";
    renderIndividual();
    try {
      ind.filters = await anthro.subjectFilters(subjectQuery);
      ind.state = "ready";
      ind.error = null;
    } catch (e) {
      ind.state = "error";
      ind.error = msgOf(e);
    }
    if (disposed) return;
    renderIndividual();
    if (ind.state === "ready") refreshCount();
  }
  async function refreshCount() {
    const my = ++ind.gen, o = subjectOptions(ind.filters, ind.sel);
    try {
      const n = await anthro.countSubjects(subjectQuery, o.sel);
      if (my !== ind.gen || disposed) return;
      ind.total = n;
      if (ind.method === "list") await loadPage(0);
      else renderIndividual();
    } catch (e) { if (my === ind.gen) { ind.message = { level: "error", text: msgOf(e) }; renderIndividual(); } }
  }
  async function loadPage(page) {
    const my = ++ind.gen, pi = pageInfo(ind.total, page);
    try {
      const o = subjectOptions(ind.filters, ind.sel);
      const rowsNow = await anthro.listSubjects(subjectQuery, { ...o.sel, limit: pi.size, offset: pi.offset });
      if (my !== ind.gen || disposed) return;
      ind.page = pi.page; ind.listRows = rowsNow;
    } catch (e) { if (my !== ind.gen) return; ind.message = { level: "error", text: msgOf(e) }; }
    renderIndividual();
  }
  async function useSubject(key) {
    const my = ++ind.gen;
    setStatus("busy", [h("span", { class: "spinner", "aria-hidden": "true" }), " Loading the person…"]);
    try {
      const row = await anthro.subjectById(subjectQuery, key);
      if (my !== ind.gen || disposed) return;
      if (!row) throw new Error("That person is not in the database.");
      const p = anthro.subjectProfile(row);
      ind.message = { level: "ok", text: `Showing person #${row.subject_key}: stature ${ctx.fmt(row.stature)}, mass ${row.mass == null ? "not measured" : fmtKg(row.mass)}.` };
      renderIndividual();
      await submit(p);
    } catch (e) { if (my !== ind.gen) return; ind.message = { level: "error", text: msgOf(e) }; setStatus("error", msgOf(e)); renderIndividual(); }
  }
  async function findClosest() {
    const o = subjectOptions(ind.filters, ind.sel);
    const st = toMm(parseNumber(indView.querySelector(`#${iids.st}`)?.value), ctx.units), ms = indView.querySelector(`#${iids.ms}`)?.value.trim();
    const mass = ms ? parseNumber(ms) : null;
    if (!Number.isFinite(st)) { ind.message = { level: "error", text: "Enter the stature you are looking for." }; renderIndividual(); return; }
    if (ms && !Number.isFinite(mass)) { ind.message = { level: "error", text: "Enter the mass as a number of kilograms, or leave it empty." }; renderIndividual(); return; }
    const my = ++ind.gen;
    setStatus("busy", [h("span", { class: "spinner", "aria-hidden": "true" }), " Searching the database…"]);
    try {
      const row = await anthro.nearestSubject(subjectQuery, { ...o.sel, stature: st, mass: mass ?? undefined });
      if (my !== ind.gen || disposed) return;
      if (!row) throw new Error("Nobody in this group has a stature and a mass.");
      ind.message = { level: "ok", text: `Closest: person #${row.subject_key}, stature ${ctx.fmt(row.stature)} (you asked for ${ctx.fmt(st)}), mass ${row.mass == null ? "not measured" : fmtKg(row.mass)}.` };
      renderIndividual();
      await submit(anthro.subjectProfile(row));
    } catch (e) { if (my !== ind.gen) return; ind.message = { level: "error", text: msgOf(e) }; setStatus("error", msgOf(e)); renderIndividual(); }
  }
  async function pickRandom() {
    if (!ind.total) return;
    const my = ++ind.gen, o = subjectOptions(ind.filters, ind.sel);
    try {
      const [r] = await anthro.listSubjects(subjectQuery, { ...o.sel, limit: 1, offset: Math.floor(Math.random() * ind.total) });
      if (my !== ind.gen || disposed) return;
      if (r) await useSubject(r.subject_key);
    } catch (e) { if (my === ind.gen) { ind.message = { level: "error", text: msgOf(e) }; renderIndividual(); } }
  }
  async function findByNumber() {
    const text = String(ind.number ?? "").trim().replace(/^#/, "");
    if (!/^\d{1,9}$/.test(text) || Number(text) < 1) { ind.message = { level: "error", text: "Enter the number as a whole number above zero, for example 3045 (the number after the # in the list)." }; renderIndividual(); return; }
    ind.message = null;
    await useSubject(Number(text));
  }
  function renderIndividual() {
    if (ind.state === "idle") { indView.replaceChildren(); return; }
    if (ind.state === "loading") {
      indView.replaceChildren(h("div", { class: "loading", role: "status" }, el("div", "spinner"), "Loading the database (about 5 MB, only the first time)…"));
      return;
    }
    if (ind.state === "error") {
      indView.replaceChildren(notice(`The database could not be loaded (${ind.error}). The population, import and manual sources work without it.`, { level: "warn" }), h("p", {}, retryBtn(loadFilters)));
      return;
    }
    // the whole view is rebuilt: put the keyboard focus back on the same control (by id, or by data-focus-key for the buttons that have none)
    const act = indView.contains(document.activeElement) ? document.activeElement : null, focusId = act?.id, focusKey = act?.dataset?.focusKey, listScroll = indView.querySelector(".hm-pf-people")?.scrollTop ?? 0;
    const o = subjectOptions(ind.filters, ind.sel);
    ind.sel = o.sel;
    const sel = (id, items, value, label, onChange, extra) => {
      const s = h("select", { class: "input", id }, extra, items.map((it) => h("option", { value: it.id }, it.name ?? it.label)));
      s.value = value ?? "";
      s.addEventListener("change", () => onChange(s.value));
      return el("div", "field", h("label", { for: id }, label), s);
    };
    const parts = [
      sel(iids.ds, o.datasets, o.sel.dataset, "Survey", (v) => { ind.sel = { dataset: v, sex: ind.sel.sex, branch: null }; ind.page = 0; refreshCount(); renderIndividual(); }),
      sel(iids.sex, o.sexes, o.sel.sex, "Sex", (v) => { ind.sel = { ...ind.sel, sex: v, branch: null }; ind.page = 0; refreshCount(); renderIndividual(); }),
    ];
    if (o.branches.length) parts.push(sel(iids.br, o.branches.map((b) => ({ id: b.id, name: `${b.id} (${fmtInt(b.n)})` })), o.sel.branch ?? "", "Branch", (v) => { ind.sel = { ...ind.sel, branch: v || null }; ind.page = 0; refreshCount(); renderIndividual(); }, h("option", { value: "" }, "Any branch")));
    parts.push(el("p", "small muted", `${fmtInt(ind.total || o.n)} people with a stature in this group. People stay anonymous: only the survey's own number is shown.`));
    const seg = segmented({ label: "How to choose a person", value: ind.method, options: [{ value: "closest", label: "Closest match" }, { value: "list", label: "From a list" }, { value: "number", label: "By number", title: "The survey's own number of a person, as shown in the list" }, { value: "random", label: "Random" }],
      onChange: (v) => { ind.method = v; ind.message = null; if (v === "list") loadPage(0); else renderIndividual(); } });
    for (const b of seg.el.querySelectorAll("button")) b.dataset.focusKey = `method:${b.dataset.value}`;
    parts.push(seg.el);
    if (ind.method === "closest") {
      const cur = ctx.getBody();
      const stIn = h("input", { class: "input", id: iids.st, type: "number", step: "any", inputmode: "decimal", value: ind.closest.stature ?? (cur ? Number(toUnit(cur.stature * 1000, ctx.units).toFixed(unitDigits(ctx.units))) : "") });
      const msIn = h("input", { class: "input", id: iids.ms, type: "number", step: "any", inputmode: "decimal", value: ind.closest.mass ?? (cur ? Number(cur.mass.toFixed(1)) : "") });
      stIn.addEventListener("input", () => { ind.closest.stature = stIn.value; }); // what was typed survives a redraw (a failed search, a unit change)
      msIn.addEventListener("input", () => { ind.closest.mass = msIn.value; });
      parts.push(el("div", "hm-pf-two",
        el("div", "field", h("label", { for: iids.st }, `Stature (${UNIT_LABEL[ctx.units]})`), stIn),
        el("div", "field", h("label", { for: iids.ms }, "Mass (kg), optional"), msIn)),
        h("button", { type: "button", class: "btn primary small", "data-focus-key": "closest", onclick: findClosest }, "Find the closest person"));
    } else if (ind.method === "number") {
      const numIn = h("input", { class: "input", id: iids.num, type: "text", inputmode: "numeric", autocomplete: "off", placeholder: "3045", value: ind.number });
      numIn.addEventListener("input", () => { ind.number = numIn.value; });
      parts.push(h("form", { class: "hm-pf-form", novalidate: true, onsubmit: (e) => { e.preventDefault(); findByNumber(); } },
        el("div", "field", h("label", { for: iids.num }, "Number of the person in the survey"), numIn),
        h("button", { type: "submit", class: "btn primary small", "data-focus-key": "number" }, "Show this person"),
        el("p", "small muted", "The number after the # in the list. It works for any survey of the database; the survey, sex and branch above only matter for the other ways to choose.")));
    } else if (ind.method === "random") {
      parts.push(h("button", { type: "button", class: "btn primary small", "data-focus-key": "random", disabled: ind.total ? null : true, onclick: pickRandom }, "Pick a random person"));
    } else {
      const pi = pageInfo(ind.total, ind.page);
      parts.push(el("p", "small muted", ind.total ? `Shortest first. Showing ${fmtInt(pi.from)} to ${fmtInt(pi.to)} of ${fmtInt(pi.total)}.` : "Nobody in this group."),
        h("ul", { class: "hm-pf-people", "aria-label": "People in this group" }, ind.listRows.map((r) => h("li", {}, h("button", { type: "button", class: "hm-pf-person", "data-focus-key": `person:${r.subject_key}`, onclick: () => useSubject(r.subject_key) }, subjectLabel(r, ctx.units), r.branch ? h("span", { class: "small muted" }, ` · ${r.branch}`) : null)))),
        el("div", "hm-pf-pager", h("button", { type: "button", class: "btn small", "data-focus-key": "pager:prev", disabled: pi.hasPrev ? null : true, onclick: () => loadPage(pi.page - 1) }, "Previous"),
          el("span", "small", `Page ${fmtInt(pi.page + 1)} of ${fmtInt(pi.pages)}`), h("button", { type: "button", class: "btn small", "data-focus-key": "pager:next", disabled: pi.hasNext ? null : true, onclick: () => loadPage(pi.page + 1) }, "Next")));
    }
    if (ind.message) parts.push(h("p", { class: `small hm-pf-msg hm-pf-msg-${ind.message.level}`, role: ind.message.level === "error" ? "alert" : "status" }, ind.message.text));
    indView.replaceChildren(...parts);
    const list = indView.querySelector(".hm-pf-people");
    if (list) list.scrollTop = listScroll; // clicking a person must not throw the list back to the top
    if (focusId) indView.querySelector(`#${CSS.escape(focusId)}`)?.focus();
    else if (focusKey) {
      // a pager button that is disabled now (the last page was reached) hands the focus to the other one, so that the keyboard user stays at the pager
      const chain = focusKey === "pager:next" ? [focusKey, "pager:prev"] : focusKey === "pager:prev" ? [focusKey, "pager:next"] : [focusKey];
      for (const k of chain) {
        const target = indView.querySelector(`[data-focus-key="${CSS.escape(k)}"]`);
        if (target && !target.disabled) { target.focus(); break; }
      }
    }
  }

  // =====================================================================================================================
  // source: import
  const impView = el("div", "hm-pf-view");
  const impErr = el("div", "hm-pf-importerr"), impOk = el("p", "small hm-pf-msg hm-pf-msg-ok");
  impErr.setAttribute("role", "alert");
  impOk.setAttribute("role", "status");
  const fileId = nextId("hm-pf-file"), pasteId = nextId("hm-pf-paste"), impRelId = nextId("hm-pf-imprel");
  const fileInput = h("input", { type: "file", id: fileId, class: "sr-only", accept: ".json,.csv,.tsv,.txt,application/json,text/csv,text/plain" });
  const paste = h("textarea", { class: "input hm-pf-paste", id: pasteId, rows: 5, spellcheck: "false", placeholder: "key,value,unit\nstature,1750,mm\nmass,78,kg" });
  const impRel = h("select", { class: "input", id: impRelId }, RELIABILITY_OPTIONS.map(([v, t]) => h("option", { value: v }, t)));
  impRel.value = "medium";
  const dropzone = el("div", "hm-pf-drop");
  function showImportError(err) {
    const { message, hint } = explainImportError(err);
    impOk.textContent = "";
    impErr.replaceChildren(el("div", "notice error hm-pf-errbox", h("b", {}, "Could not import: "), message, hint ? el("div", "hm-pf-errhint", hint) : null));
  }
  async function importText(text, name) {
    impErr.replaceChildren();
    impOk.textContent = "";
    let profile;
    try { profile = anthro.parseImport(text, name, { minReliability: impRel.value }); } catch (e) { showImportError(e); return; }
    const n = Object.keys(profile.measures).length;
    impOk.textContent = `Read ${n} measure${n === 1 ? "" : "s"} from ${name ? `“${name}”` : "the pasted text"}.`;
    await submit(profile);
  }
  async function importFile(file) {
    const bad = checkImportFile(file);
    if (bad) { showImportError(new Error(bad)); return; }
    let text;
    try { text = await file.text(); } catch (e) { showImportError(new Error(`The file could not be read (${msgOf(e)}).`)); return; }
    if (disposed) return;
    await importText(text, file.name);
  }
  fileInput.addEventListener("change", async () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) await importFile(f); });
  let dragDepth = 0;
  dropzone.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; dropzone.classList.add("is-over"); });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  dropzone.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropzone.classList.remove("is-over"); });
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("is-over");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) { showImportError(new Error("Drop a JSON or CSV file here (dropped text and links are not read).")); return; }
    await importFile(files[0]);
    if (files.length > 1) impOk.textContent += " Only the first file was used.";
  });
  function exportProfile(kind) {
    const p = ctx.getProfile();
    if (!p) return;
    const safe = String(p.id).replace(/[^\w.-]+/g, "_").slice(0, 60) || "profile";
    if (kind === "json") download(`digital-human-${safe}.json`, anthro.profileToJSON(p), "application/json");
    else download(`digital-human-${safe}.csv`, anthro.profileToCSV(p));
    toast(`Saved the profile as ${kind.toUpperCase()}`);
  }
  impView.append(
    dropzone,
    el("div", "field", h("label", { for: pasteId }, "Or paste JSON or CSV"), paste),
    el("div", "hm-pf-row", h("button", { type: "button", class: "btn primary small", onclick: () => importText(paste.value, "") }, "Use the pasted text")),
    el("div", "field", h("label", { for: impRelId }, "Reliability (populations files only)"), impRel),
    impErr, impOk,
    el("p", "small muted", "The file needs a stature; everything else is optional. Units: mm, cm, m, in, kg, lb (in a unit column, after the number, or as a key suffix such as stature_cm)."),
    el("div", "hm-pf-row small",
      h("button", { type: "button", class: "btn ghost small", onclick: () => download("digital-human-example.csv", EXAMPLE_CSV) }, "Download an example CSV"),
      h("button", { type: "button", class: "btn ghost small", onclick: () => download("digital-human-example.json", EXAMPLE_JSON, "application/json") }, "Download an example JSON")),
    el("div", "hm-pf-sub", "Export the current profile"),
    el("div", "hm-pf-row", h("button", { type: "button", class: "btn small", onclick: () => exportProfile("json") }, "Download JSON"), h("button", { type: "button", class: "btn small", onclick: () => exportProfile("csv") }, "Download CSV")),
    el("p", "small muted", "The file holds the measures, including values you edited. Edits of derived dimensions and the body form are not part of it."));
  dropzone.append(el("div", "hm-pf-drop-t", "Drop a JSON or CSV file here"), h("label", { class: "btn small", for: fileId }, "Choose a file"), fileInput,
    el("div", "small muted", "Also reads the populations and mannequin files of the data API."));
  fileInput.addEventListener("focus", () => dropzone.classList.add("has-focus"));
  fileInput.addEventListener("blur", () => dropzone.classList.remove("has-focus"));

  // =====================================================================================================================
  // source: manual
  const manView = el("div", "hm-pf-view");
  const mids = { sex: nextId("hm-pf-msex"), st: nextId("hm-pf-mst"), stu: nextId("hm-pf-mstu"), ms: nextId("hm-pf-mms"), msu: nextId("hm-pf-mmsu") };
  const cur0 = ctx.getBody();
  const manSex = h("select", { class: "input", id: mids.sex }, h("option", { value: "M" }, "Man"), h("option", { value: "F" }, "Woman"), h("option", { value: "both" }, "Not stated (neutral body)"));
  manSex.value = ctx.getProfile()?.sex === "F" ? "F" : ctx.getProfile()?.sex === "both" ? "both" : "M";
  let manDirty = false; // the person typed here: do not overwrite with the current body
  // text fields, not number fields: a number field reads "175,5" as 1755 in some browsers, and manualFromForm reads a decimal comma itself
  const manSt = h("input", { class: "input", id: mids.st, type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "1755", value: cur0 ? Math.round(cur0.stature * 1000) : "" });
  const manStU = h("select", { class: "input hm-pf-unit", id: mids.stu, "aria-label": "Stature unit" }, STATURE_UNITS.map((u) => h("option", { value: u }, u)));
  const manMs = h("input", { class: "input", id: mids.ms, type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "80", value: cur0 ? Number(cur0.mass.toFixed(1)) : "" });
  const manMsU = h("select", { class: "input hm-pf-unit", id: mids.msu, "aria-label": "Mass unit" }, MASS_UNITS.map((u) => h("option", { value: u }, u)));
  const manErr = el("p", "small hm-pf-msg hm-pf-msg-error");
  manErr.setAttribute("role", "alert");
  function applyManual(e) {
    e?.preventDefault();
    manErr.textContent = "";
    let p;
    try { p = manualFromForm({ sex: manSex.value, stature: manSt.value, statureUnit: manStU.value, mass: manMs.value, massUnit: manMsU.value }); } catch (err) { manErr.textContent = err.message; return; }
    submit(p);
  }
  // Sliders over the same two values (DESIGN.md 3.1): they move the fields in the unit chosen there, and the fields move them. The rest of the body is the
  // model's estimate for that stature, mass and sex (the regressions of the survey data), so the sliders are the base-population part of the choice.
  const sliderMm = (unitEl) => TO_MM[unitEl.value] ?? 1;
  const stSlider = sliderRow({ label: "Adjust stature", min: 1400, max: 2100, step: 1, value: cur0 ? Math.min(2100, Math.max(1400, Math.round(cur0.stature * 1000))) : 1755, unit: "mm",
    onInput: (v) => { manSt.value = String(Number((v / sliderMm(manStU)).toFixed(manStU.value === "mm" ? 0 : 2))); manDirty = true; }, onChange: () => applyManual() });
  const msSlider = sliderRow({ label: "Adjust body mass", min: 40, max: 150, step: 1, value: cur0 ? Math.min(150, Math.max(40, Math.round(cur0.mass))) : 80, unit: "kg",
    onInput: (v) => { manMs.value = String(Number((manMsU.value === "lb" ? v / 0.45359237 : v).toFixed(manMsU.value === "lb" ? 0 : 1))); manDirty = true; }, onChange: () => applyManual() });
  /** The sliders show what the fields say (left where they are when a field is empty or not a number). */
  function syncSliders() {
    const st = parseNumber(manSt.value), ms = parseNumber(manMs.value);
    if (Number.isFinite(st)) stSlider.set(st * sliderMm(manStU));
    if (Number.isFinite(ms)) msSlider.set(manMsU.value === "lb" ? ms * 0.45359237 : ms);
  }
  for (const e of [manSt, manMs, manStU, manMsU]) e.addEventListener("input", syncSliders);
  manStU.addEventListener("change", syncSliders);
  manMsU.addEventListener("change", syncSliders);
  manView.append(el("div", "hm-pf-mansliders", stSlider.el, msSlider.el), h("form", { class: "hm-pf-form", onsubmit: applyManual, novalidate: true },
    el("div", "field", h("label", { for: mids.sex }, "Sex"), manSex),
    el("div", "field", h("label", { for: mids.st }, "Stature"), el("div", "hm-pf-withunit", manSt, manStU)),
    el("div", "field", h("label", { for: mids.ms }, "Body mass (optional)"), el("div", "hm-pf-withunit", manMs, manMsU)),
    manErr,
    h("button", { type: "submit", class: "btn primary small" }, "Build this body"),
    el("p", "small muted", "Only the values you type are measured; every other dimension is estimated from stature, mass and sex. The model is built for adults of 1,300 to 2,500 mm.")));
  manView.addEventListener("input", () => { manDirty = true; });
  manView.addEventListener("change", (e) => { if (e.target === manSt || e.target === manMs) applyManual(); });
  /** Start the manual form from the figure on the stage (until the person types something). */
  function prefillManual() {
    const b = ctx.getBody(), p = ctx.getProfile();
    if (manDirty || !b) return;
    manSt.value = String(Math.round(b.stature * 1000));
    manStU.value = "mm";
    manMs.value = String(Number(b.mass.toFixed(1)));
    manMsU.value = "kg";
    manSex.value = p?.sex === "F" ? "F" : p?.sex === "both" ? "both" : "M";
    syncSliders();
  }

  // =====================================================================================================================
  // the source section
  const views = { population: popView, individual: indView, import: impView, manual: manView };
  const viewHost = el("div", "hm-pf-viewhost");
  const srcSeg = segmented({ label: "Profile source", value: src, className: "hm-pf-srcseg", options: [
    { value: "population", label: "Population", title: "A country, branch and sex of the surveys, at a percentile" },
    { value: "individual", label: "Individual", title: "One real, anonymous person of the in-browser database" },
    { value: "import", label: "Import", title: "A JSON or CSV file or pasted text" },
    { value: "manual", label: "Manual", title: "Type a stature and mass" }], onChange: (v) => showSource(v) });
  function showSource(v) {
    src = v;
    viewHost.replaceChildren(views[v]);
    srcSeg.set(v);
    if (v === "population" && indexState === "idle") loadIndex();
    if (v === "individual" && ind.state === "idle") loadFilters();
    if (v === "manual") prefillManual();
  }
  const sourceSec = section("Who is the figure?", [srcSeg.el, viewHost, status], { open: true });

  // =====================================================================================================================
  // body form
  const formSeg = segmented({ label: "Body form", className: "hm-pf-formseg", value: formChoice ?? "auto", options: [
    { value: "auto", label: "Auto", title: "From the sex of the profile" }, { value: "male", label: "Male" }, { value: "female", label: "Female" }, { value: "neutral", label: "Neutral", title: "The average of the male and female forms" }],
    onChange: (v) => setForm(v === "auto" ? null : v) });
  const formHint = el("p", "small muted");
  function renderForm() {
    const p = ctx.getProfile(), b = ctx.getBody();
    formSeg.set(formChoice ?? p?.form ?? "auto");
    formHint.textContent = p ? `Auto follows the sex of the profile (here: ${defaultForm(p)}). The form only changes what is not measured: typical proportions, section shapes and mass distribution. Measured dimensions stay as they are.${b?.form ? ` The body now uses the ${b.form} form.` : ""}` : "";
  }
  async function setForm(v) {
    formChoice = v;
    const p = ctx.getProfile();
    if (!p) return;
    await submit(p);
    renderForm(); // a form equal to the one the sex gives leaves the profile unchanged (no event), but the person's choice stays visible
  }
  const formSec = section("Body form", [formSeg.el, formHint], { open: false });

  // =====================================================================================================================
  // dimensions
  const qId = nextId("hm-pf-dq");
  const dimSearch = h("input", { type: "search", class: "input", id: qId, placeholder: "Search, e.g. thigh or hand", "aria-label": "Search dimensions", autocomplete: "off" });
  const chipDefs = [["all", "All"], ["measured", "Measured"], ["derived", "Derived"], ["estimated", "Estimated"], ["edited", "Edited"]];
  const chipEls = new Map(chipDefs.map(([k, label]) => [k, h("button", { type: "button", class: "hm-chip hm-pf-fchip", "aria-pressed": k === "all" ? "true" : "false", dataset: { filter: k }, onclick: () => { dimState.filter = k; renderDims(); } }, label)]));
  const dimList = el("div", "hm-pf-dims");
  const dimSummary = el("p", "small muted hm-pf-dimsum");
  const revertAllBtn = h("button", { type: "button", class: "btn small", hidden: true, "data-focus-key": "revertall", onclick: () => { editResult = null; if (editNote) showBuilt(); submit(revertAll(ctx.getProfile())); } }, "Revert all edits");
  const dimLegend = el("p", "small muted", "Measured: the value is a measure of the profile (or typed by you). Derived: computed from measures with a documented relation. Estimated: no measure, so the model uses a typical value for the stature, mass and sex. Select a row to see where it came from and to edit it; the 3D view shows what it moves.");
  dimSearch.addEventListener("input", () => { dimState.query = dimSearch.value; renderDims(); });

  const profileFor = (body) => seen.get(body?.profileId) ?? ctx.getProfile();
  let hoverJoint = null;
  function highlightTarget(row, on) {
    const j = row.target?.joint;
    if (!j) return;
    try { ctx.getRig()?.highlight?.(on ? j : null); ctx.requestRender(); hoverJoint = on ? j : null; } catch { /* rig without highlight */ }
  }
  function selectDim(row) {
    const t = row.target;
    if (!t) return;
    if (t.joint) ctx.select({ kind: "joint", id: t.joint });
    else if (t.landmark) showLandmark(ctx, t.landmark);
  }
  function dimDetail(row) {
    const p = ctx.getProfile(), ed = row.editability, u = ctx.units;
    const parts = [];
    const dl = h("dl", { class: "hm-pf-dl" });
    const add = (k, v) => { if (v != null && v !== "") dl.append(h("dt", {}, k), h("dd", {}, v)); };
    const cap = capFirst;
    const noteRepeats = row.formula && row.note.toLowerCase().startsWith(row.formula.toLowerCase());
    add(noteRepeats ? "How it was set" : "Route used", noteRepeats ? cap(row.note) : row.formula ? cap(row.formula) : row.status === "estimated" ? "Estimated from stature, mass and sex" : "");
    if (row.via.length) {
      add("Measures used", h("ul", { class: "hm-pf-via" }, row.via.map((k, i) => {
        const m = ctx.getProfile()?.measures?.[k];
        const text = m ? (m.unit === "mm" ? fmtLength(m.value, u) : `${m.value} ${m.unit}`) : "";
        return h("li", {}, row.viaLabels[i], text ? h("span", { class: "muted" }, ` · ${text}`) : null, m?.status && m.status !== "reported" ? h("span", { class: "tag outline", style: { marginLeft: "6px" } }, m.status) : null);
      })));
    }
    if (!noteRepeats) add("Note", cap(row.note));
    if (row.alt.length) {
      add("Other routes", h("ul", { class: "hm-pf-via" }, row.alt.map((a) => h("li", {}, `${a.via}: ${ctx.fmt(a.value * 1000)}`, h("span", { class: "muted" }, ` (${fmtSigned(toUnit(-a.delta * 1000, u), deltaDigits(u))} ${UNIT_LABEL[u]} from the value used)`)))));
    }
    if (row.target) {
      const name = row.target.joint ? `joint ${row.target.joint}` : `landmark ${row.target.landmark}`;
      add("Shown in 3D as", h("span", {}, name, " ", h("button", { type: "button", class: "hm-sk-link", onclick: () => selectDim(row) }, "Show again")));
    }
    if (row.editability.kind === "override" || row.editability.kind === "measure") {
      const [lo, hi] = row.band;
      if (lo != null && hi != null) add("Plausible range", `${ctx.fmt(lo * 1000)} to ${ctx.fmt(hi * 1000)}`);
      else if (lo != null || hi != null) add("Plausible range", lo != null ? `at least ${ctx.fmt(lo * 1000)}; the upper limit follows from the other dimensions` : `at most ${ctx.fmt(hi * 1000)}`);
      // said before the person types: the value shown may itself be one the fitting module cannot take back
      if (lo != null && lo < 0 && !fitTakesSignedOverrides()) add("Limit", "Only values above zero can be applied for now: the fitting module ignores an offset of zero or less.");
    }
    parts.push(dl);

    // editor
    if (ed.kind === "measure" || ed.kind === "override") {
      const kg = row.kind === "kg";
      const id = nextId("hm-pf-ed");
      // type text, not number: a number field reads "175,5" as 1755 in some browsers, and the panel reads a decimal comma itself (parseNumber)
      const input = h("input", { type: "text", class: "input hm-pf-edit", id, inputmode: "decimal", autocomplete: "off", "data-focus-key": `edit:${row.id}`,
        value: kg ? Number(row.value.toFixed(1)) : Number(toUnit(row.mm, u).toFixed(unitDigits(u) + (u === "mm" ? 1 : 0))) });
      const msg = el("div", "small hm-pf-msg hm-pf-msg-error");
      msg.setAttribute("role", "alert");
      const say = (text, kind = "error") => { msg.className = `small hm-pf-msg hm-pf-msg-${kind}`; msg.setAttribute("role", kind === "error" ? "alert" : "status"); msg.textContent = text; };
      const shown = parseNumber(input.value); // what the field was filled with (rounded to the display): typing it again is no edit
      // what the model did with the last edit of this row, next to the field that was edited (the status line is far above, and gone when its section is closed)
      const res = editResult && editResult.rowId === row.id && editResult.profileId === ctx.getProfile()?.id ? editResult : null;
      const result = res ? h("div", { class: `small hm-pf-result hm-pf-result-${res.level}`, role: res.level === "warn" ? "alert" : "status" }, res.text) : null;
      const apply = async () => {
        say("");
        if (editNote) showBuilt(); // the result of the previous edit is not the result of this one
        const v = parseNumber(input.value);
        if (!Number.isFinite(v)) { say("Enter a number."); return; }
        // the field is rounded (a tenth of a centimetre is a millimetre): sending the same text back would store a change of up to half a millimetre as an edit
        if (v === shown) { say("This is the value the model already uses. Type a different value to change it.", "info"); return; }
        let next;
        try { next = editDimension(ctx.getProfile(), row, v, kg ? "kg" : u); } catch (e) { say(e.message); return; }
        dimState.open = row.id;
        editResult = null;
        const done = await submit(next);
        const b = ctx.getBody(), cur = ctx.getProfile();
        if (disposed || done?.ok === false || !b || (b.profileId != null && b.profileId !== cur?.id)) return;
        // say what the model did with the value when it is not what was typed (held at an edge, not applied, built another way)
        const ex = explainEdit(row, kg ? v : fromUnit(v, u), b, u);
        if (ex) {
          setStatus(ex.level === "info" ? "ok" : "warn", ex.text);
          editNote = true;
          editResult = { rowId: row.id, profileId: cur.id, level: ex.level === "info" ? "info" : "warn", text: ex.text };
          renderDims();
        }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      parts.push(el("div", "hm-pf-editor", h("label", { for: id, class: "small" }, `Set ${kg ? "the mass" : "this dimension"} to`), el("div", "hm-pf-editrow", input, el("span", "hm-unit", kg ? "kg" : UNIT_LABEL[u]),
        h("button", { type: "button", class: "btn primary small", "data-focus-key": `apply:${row.id}`, onclick: apply }, "Apply"),
        row.edited ? h("button", { type: "button", class: "btn small", "data-focus-key": `revert:${row.id}`, onclick: async () => { dimState.open = row.id; editResult = null; if (editNote) showBuilt(); await submit(revertDimension(ctx.getProfile(), row)); } }, "Revert") : null), msg, result,
        ed.kind === "measure" ? el("div", "small muted", `Stored as the profile measure “${niceLabel(ed.key)}”.`) : el("div", "small muted", "Applied to the model; the profile's measures stay as they are.")));
    } else if (ed.kind === "derived") {
      parts.push(el("div", "hm-pf-editor", el("div", "small muted", ed.why), el("div", "hm-pf-fromlinks", ed.from.map((id2) => {
        const r2 = rows.find((r) => r.id === id2);
        return r2 ? h("button", { type: "button", class: "btn ghost small", onclick: () => { dimState.open = id2; dimState.filter = "all"; dimState.query = ""; dimSearch.value = ""; renderDims(); selectDim(r2); } }, r2.label) : null;
      }))));
    } else if (ed.kind === "none") parts.push(el("div", "hm-pf-editor small muted", ed.why));
    return parts;
  }
  /**
   * Put the keyboard focus back where it was after the list was redrawn. A control that is gone (Revert once nothing is edited, "Revert all edits" when it
   * hides) hands the focus to the nearest thing that is left: the value field of the same row, the row itself, the search field.
   */
  function restoreFocus(key) {
    if (!key) return;
    const id = key.slice(key.indexOf(":") + 1);
    const chain = [key, ...(/^(apply|revert):/.test(key) ? [`edit:${id}`] : []), ...(/^(apply|revert|edit):/.test(key) ? [`row:${id}`] : [])];
    for (const k of chain) {
      const el = root.querySelector(`[data-focus-key="${CSS.escape(k)}"]`);
      if (!el || el.hidden) continue;
      el.focus();
      if (document.activeElement === el) return;
    }
    if (key === "revertall") dimSearch.focus();
  }
  function renderDims() {
    if (disposed) return;
    const focusKey = document.activeElement?.dataset?.focusKey ?? null;
    const body = ctx.getBody();
    if (!body?.dims) {
      dimList.replaceChildren(el("p", "small muted", "The dimension list appears as soon as the model is built."));
      dimSummary.textContent = "";
      return;
    }
    rows = dimensionRows(body, profileFor(body));
    const c = statusCounts(rows);
    for (const [k, b] of chipEls) { b.setAttribute("aria-pressed", String(dimState.filter === k)); b.firstChild.textContent = b.firstChild.textContent.replace(/ \(\d+\)$/, "") + ` (${c[k] ?? 0})`; b.disabled = k === "edited" && !c.edited && dimState.filter !== "edited"; }
    revertAllBtn.hidden = !c.edited;
    const shownRows = filterRows(rows, { status: dimState.filter, query: dimState.query });
    dimSummary.textContent = `Estimated: ${c.estimated} of ${c.all} dimensions.${shownRows.length !== rows.length ? ` Showing ${shownRows.length}.` : ""}`;
    const sections = groupRows(shownRows).map((g) => {
      const items = g.rows.map((row) => {
        const open = dimState.open === row.id, detailId = nextId("hm-pf-dd");
        const btn = h("button", { type: "button", class: "hm-pf-dimbtn", "aria-expanded": String(open), "aria-controls": open ? detailId : null, "data-focus-key": `row:${row.id}`, dataset: { dim: row.id },
          onclick: () => { dimState.open = open ? null : row.id; renderDims(); if (!open) selectDim(row); } },
          h("span", { class: "hm-pf-dimname" }, row.label),
          h("span", { class: "hm-pf-dimval" }, fmtQuantity(row.kind === "mm" ? row.mm : row.value, row.kind, ctx.units)),
          h("span", { class: "hm-pf-dimmeta" }, statusChip(row.status), row.edited ? h("span", { class: "hm-pf-st hm-st-edited", title: "You changed this value or one it comes from" }, "edited") : null, h("span", { class: "hm-pf-from small muted", title: sourceText(row) }, sourceText(row))));
        btn.addEventListener("pointerenter", () => highlightTarget(row, true));
        btn.addEventListener("pointerleave", () => highlightTarget(row, false));
        btn.addEventListener("focus", () => highlightTarget(row, true));
        btn.addEventListener("blur", () => highlightTarget(row, false));
        const li = h("li", { class: `hm-pf-dim${open ? " is-open" : ""}`, dataset: { status: row.status } }, btn);
        if (open) li.append(h("div", { class: "hm-pf-dimdetail", id: detailId }, dimDetail(row)));
        return li;
      });
      return h("div", { class: "hm-pf-dimgrp" }, h("h3", { class: "hm-pf-grp" }, g.label, h("span", { class: "small muted" }, ` ${g.rows.length}`)), h("ul", { class: "hm-pf-dimlist" }, items));
    });
    dimList.replaceChildren(...(sections.length ? sections : [el("p", "small muted", "No dimension matches.")]));
    restoreFocus(focusKey);
    renderCurrent();
    const cnt = dimSec.querySelector("summary .tag");
    if (cnt) cnt.textContent = String(rows.length);
  }
  const dimSec = section("Dimensions", [
    el("div", "hm-pf-dimtools", dimSearch), h("div", { class: "hm-pf-chips", role: "group", "aria-label": "Show dimensions by status" }, [...chipEls.values()]),
    dimSummary, el("div", "hm-pf-row", revertAllBtn), dimList, dimLegend], { open: true, count: 0 });

  // =====================================================================================================================
  // fit report
  const repSummary = el("p", "hm-pf-repsum"), repDetail = el("p", "small muted"), repList = el("ul", "hm-pf-rep"), chkList = el("ul", "hm-pf-rep");
  const chkDetails = h("details", { class: "hm-pf-chk" }, h("summary", {}, "Cross-checks of other routes"), el("p", "small muted", "Where the profile gives more than one way to get a dimension (for example the thigh from the trochanter height and from the sitting height), only the first is used; these rows show how far the others would have been. Nothing is averaged."), chkList);
  const poseBtn = h("button", { type: "button", class: "btn small", onclick: recomputePose, title: "Measure the model again in the posture it is in now (Posture tab)" }, "Recompute in current pose");
  const poseOff = h("button", { type: "button", class: "btn small", hidden: true, onclick: () => { poseRows = null; renderReport(); } }, "Back to the reference postures");
  const repNote = el("p", "small muted", "The report re-measures the built model the way the surveys measured people (for example sitting height in the ISO 7250 seated posture, with the model placed in that posture) and compares it with the profile. ok: within max(5 mm, 0.5 %). warn: within max(15 mm, 2 %). off: beyond that. A difference is not always an error: a rigid trunk cannot slump, and survey landmarks are defined differently; the note says why.");
  function recomputePose() {
    const rig = ctx.getRig(), body = ctx.getBody();
    if (!rig || !body) return;
    try {
      poseRows = new Map(evaluateMeasures(body, rig.getPose()).map((r) => [r.id, r]));
    } catch (e) { setStatus("error", `The pose could not be measured (${msgOf(e)}).`); return; }
    renderReport();
  }
  function reportRow(r) {
    const u = ctx.units, k = r.unit === "kg" ? "kg" : "mm", pr = poseRows?.get(r.id);
    // one decimal more than the lengths elsewhere: the report is about differences of a few millimetres
    const num = (label, v, signed) => h("span", { class: "hm-pf-num" }, h("i", {}, label), " ", signed ? (v == null ? "—" : `${fmtSigned(k === "kg" ? v : toUnit(v, u), k === "kg" ? 2 : deltaDigits(u))}${k === "kg" ? " kg" : ""}`) : fmtQuantity(v, k, u, deltaDigits(u)));
    return h("li", { class: "hm-pf-rrow", dataset: { status: r.status, id: r.id } },
      el("div", "hm-pf-rtop", h("span", { class: "hm-pf-rname" }, r.label), h("span", { class: `hm-pf-st hm-rs-${r.status.replace("/", "")}`, title: { ok: "Within tolerance", warn: "Close but outside the tolerance", off: "Further off than the warning limit", "n/a": "The profile has no value to compare with" }[r.status] }, r.status)),
      el("div", "hm-pf-rnums", num("input", r.input), num("model", r.model), num("Δ", r.delta, true), pr ? num("in this pose", pr.model) : null, pr ? num("Δ in pose", pr.delta, true) : null),
      r.note && r.status !== "ok" ? el("div", "hm-pf-rnote small muted", capFirst(r.note)) : null);
  }
  function renderReport() {
    const body = ctx.getBody();
    if (!body?.report) { repSummary.textContent = "The report appears as soon as the model is built."; repDetail.textContent = ""; repList.replaceChildren(); chkList.replaceChildren(); return; }
    const sum = reportSummary(body.report), { measures, checks } = splitReport(body.report);
    repSummary.textContent = sum.text;
    repSummary.dataset.state = sum.off ? "off" : sum.warn ? "warn" : "ok";
    repDetail.textContent = [sum.detail, poseRows ? "The extra values are the same measures taken on the model in the pose it is in now. They only make sense in the posture a measure is defined for (sitting heights need a seated pose)." : ""].filter(Boolean).join(". ");
    repList.replaceChildren(...sortReport(measures).map(reportRow));
    chkList.replaceChildren(...sortReport(checks).map(reportRow));
    chkDetails.hidden = !checks.length;
    chkDetails.querySelector("summary").textContent = `Cross-checks of other routes (${checks.length})`;
    poseOff.hidden = !poseRows;
    const cnt = repSec.querySelector("summary .tag");
    if (cnt) cnt.textContent = String(sum.evaluated);
  }
  const repSec = section("Fit report", [repSummary, repDetail, el("div", "hm-pf-row", poseBtn, poseOff), repList, chkDetails, repNote], { open: false, count: 0 });

  // =====================================================================================================================
  // warnings and notes
  const warnList = el("ul", "hm-pf-notes"), noteList = el("ul", "hm-pf-notes"), warnTitle = el("div", "hm-pf-sub", "Warnings"), noteTitle = el("div", "hm-pf-sub", "About this profile");
  const noWarn = el("p", "small muted", "The model reported no warnings for this profile.");
  function renderNotes() {
    const body = ctx.getBody(), p = ctx.getProfile();
    const w = body?.warnings ?? [], n = p?.notes ?? [];
    warnList.replaceChildren(...w.map((t) => h("li", {}, capFirst(t))));
    noWarn.hidden = !body || w.length > 0;
    noteList.replaceChildren(...n.map((t) => h("li", {}, capFirst(t))));
    noteTitle.hidden = !n.length;
    warnTitle.hidden = !body;
    const cnt = notesSec.querySelector("summary .tag");
    if (cnt) cnt.textContent = String(w.length + n.length);
  }
  const notesSec = section("Warnings and notes", [warnTitle, warnList, noWarn, noteTitle, noteList,
    h("details", { class: "hm-pf-model" }, h("summary", {}, "Model notes: what this model is not"), h("ul", { class: "hm-pf-notes" }, MODEL_NOTES.map((t) => h("li", {}, t))))], { open: true, count: 0 });

  // ---- assemble
  root.append(h("h2", { class: "hm-panel-title" }, "Profile"), current, sourceSec, formSec, dimSec, repSec, notesSec);

  // ---- events
  const noExtrasId = "profile-extras";
  function checkExtras() {
    const p = ctx.getProfile(), b = ctx.getBody();
    if (!p || !b || (b.profileId != null && b.profileId !== p.id)) return;
    const text = extrasNotice(p, b);
    if (text) ctx.notify(text, { level: "warn", id: noExtrasId });
    else ctx.dismiss(noExtrasId);
  }
  offs.push(ctx.on("profile", (p) => {
    note(p);
    if (editResult && p?.id !== editResult.profileId) editResult = null; // it described the body of another profile
    formChoice = p?.form ?? (formChoice && formChoice === defaultForm(p) ? formChoice : null); // an explicit choice that equals the default is not stored in the profile
    const sel = selectionOfProfile(p, index);
    // a population profile that came from somewhere else (not from these controls): put the controls back. When it is what the controls already say, leave
    // them alone: redrawing a slider while it is being dragged would drop the drag.
    if (sel && indexState === "ready" && !popTimer && !["country", "role", "sex", "percentile", "scaling", "reliability", "survey"].every((k) => pop[k] === sel[k])) {
      Object.assign(pop, sel);
      pop.extended = pop.percentile < 5 || pop.percentile > 95;
      renderPopulationView();
    }
    renderForm();
    renderCurrent();
    // a profile that another part of the page loaded: the status line must not keep naming the old one
    if (!building && !editNote && (statusKind === "ok" || statusKind === "warn")) showBuilt(p?.label);
  }));
  offs.push(ctx.on("body", () => {
    poseRows = null; renderDims(); renderReport(); renderNotes(); renderForm(); checkExtras();
    if (!building && !editNote && (statusKind === "ok" || statusKind === "warn") && ctx.getProfile()) showBuilt();
  }));
  // the "in this pose" columns belong to the pose they were measured in: any later pose change makes them wrong, so they go (cheap: nothing to do without them)
  offs.push(ctx.on("pose", () => { if (poseRows) { poseRows = null; renderReport(); } }));
  offs.push(ctx.on("units", () => { ind.closest.stature = null; renderDims(); renderReport(); renderCurrent(); if (ind.state === "ready") renderIndividual(); }));
  offs.push(ctx.on("rig", () => { /* a new figure: the pose columns belong to the old body and were dropped on "body" */ }));

  // ---- start
  showSource(src);
  renderDims();
  renderReport();
  renderNotes();
  renderForm();
  renderCurrent();
  if (src === "population" && indexState === "idle") loadIndex();

  return {
    onShow() { renderCurrent(); },
    onHide() {
      if (hoverJoint) { try { ctx.getRig()?.highlight?.(null); } catch { /* ignore */ } hoverJoint = null; }
    },
    dispose() {
      disposed = true;
      clearTimeout(popTimer);
      for (const f of offs) f();
      ctx.dismiss(noExtrasId);
    },
  };
}

export default { id: "profile", label: "Profile", order: 1, mount };
