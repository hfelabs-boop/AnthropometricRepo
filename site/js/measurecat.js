// Groups every measure into a category. Harmonized measures carry one in the database; the as-published ones
// (key "other:...") are placed by the words in their name, using the same category names where they overlap.
export const OTHER = "Other (as published)";
const set = s => new Set(s.split(" "));
const W = {
  comp: set("skinfold fat muscle bone visceral lean"),
  strength: set("strength"),
  angle: set("angle slope inclination"),
  ratio: set("ratio somatotype"),
  head: set("head headboard bitragion bizygomatic bigonial nasal nose menton sellion tragion glabella ear face facial chin jaw interpupillary biocular frontotemporale zygion infraorbitale pronasale inion mouth lip cranial helmet ectocanthus canthus otobasion stomion subnasale philtrum cheilion nasion supramenton"),
  seated: set("sitting seated seat sit buttock popliteal lap"),
  hand: set("hand finger thumb palm knuckle metacarpale foot feet ball heel toe ankle instep glove boot wrist"),
  armish: set("sleeve shoulder spine elbow arm nape"),
  circ: set("circumference girth perimeter"),
  breadth: set("breadth width depth diameter thickness biacromial bideltoid interscye bispinous"),
  height: set("height level stature"),
  trunk: set("nape waist back front bust bustpoint thelion torso trunk crotch rise hip omphalion"),
  limb: set("reach span arm leg sleeve inseam forearm cubit acromion shoulder elbow thumbtip length distance"),
  arc: set("arc curvature contour excursion"),
  size: set("weight mass stature surface volume"),
  limbOnly: set("sleeve arm leg shoulder elbow forearm thumbtip reach span inseam acromion cubit"),
};
const any = (t, s) => t.some(w => s.has(w));

/** Category of a measure: the harmonized one if known, else guessed from the words in its key. */
export function categoryOf(key, known) {
  if (known) return known;
  const t = key.replace(/^other:/, "").split("_");
  if (t.length === 1 && t[0] === "age") return "Demographics";
  if (any(t, W.comp)) return "Skinfolds & composition";
  if (any(t, W.strength)) return "Strength";
  if (any(t, W.angle)) return "Angles";
  if (any(t, W.ratio) || (t.includes("index") && !t.includes("finger"))) return "Ratios & indices";
  if (any(t, W.head)) return "Head & face";
  if (any(t, W.seated)) return "Seated";
  const heightLike = t.includes("height") || t.includes("level");
  if (any(t, W.hand) && !heightLike && !(t.includes("wrist") && any(t, W.armish))) return "Hands & feet";
  if (any(t, W.circ)) return "Circumferences";
  if (any(t, W.breadth)) return "Breadths & depths";
  if (heightLike) return "Heights (standing)";
  if (any(t, W.arc)) return "Arcs & contours";
  if (any(t, W.trunk) && !any(t, W.limbOnly)) return "Trunk & garment lengths";
  if (any(t, W.limb)) return "Limbs & reach";
  if (any(t, W.size)) return "Body size";
  return OTHER;
}

const ORDER = ["Body size", "Heights (standing)", "Seated", "Breadths & depths", "Circumferences", "Limbs & reach", "Trunk & garment lengths",
  "Head & face", "Hands & feet", "Arcs & contours", "Skinfolds & composition", "Strength", "Angles", "Ratios & indices", "Demographics", OTHER];
/** Category display order; unknown names (from the database) keep their given order after the known ones. */
export function categoryOrder(names) {
  return [...ORDER.filter(c => names.includes(c)), ...names.filter(c => !ORDER.includes(c))];
}
