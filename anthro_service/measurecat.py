"""Measure categories. A Python port of site/js/measurecat.js, so the API groups measures exactly as the website does.

Harmonized measures carry a category in database/harmonized_measures.csv. The as-published ones (key "other:...") are
placed by the words in their key. tests/test_core.py checks this port against the JavaScript on every measure key.
"""
from __future__ import annotations

OTHER = "Other (as published)"


def _set(s: str) -> frozenset:
    return frozenset(s.split(" "))


_W = {
    "comp": _set("skinfold fat muscle bone visceral lean"),
    "strength": _set("strength"),
    "angle": _set("angle slope inclination"),
    "ratio": _set("ratio somatotype"),
    "head": _set("head headboard bitragion bizygomatic bigonial nasal nose menton sellion tragion glabella ear face facial chin jaw interpupillary biocular frontotemporale zygion infraorbitale pronasale inion mouth lip cranial helmet ectocanthus canthus otobasion stomion subnasale philtrum cheilion nasion supramenton"),
    "seated": _set("sitting seated seat sit buttock popliteal lap"),
    "hand": _set("hand finger thumb palm knuckle metacarpale foot feet ball heel toe ankle instep glove boot wrist"),
    "armish": _set("sleeve shoulder spine elbow arm nape"),
    "circ": _set("circumference girth perimeter"),
    "breadth": _set("breadth width depth diameter thickness biacromial bideltoid interscye bispinous"),
    "trunk": _set("nape waist back front bust bustpoint thelion torso trunk crotch rise hip omphalion"),
    "limb": _set("reach span arm leg sleeve inseam forearm cubit acromion shoulder elbow thumbtip length distance"),
    "arc": _set("arc curvature contour excursion"),
    "size": _set("weight mass stature surface volume"),
    "limb_only": _set("sleeve arm leg shoulder elbow forearm thumbtip reach span inseam acromion cubit"),
}

ORDER = ["Body size", "Heights (standing)", "Seated", "Breadths & depths", "Circumferences", "Limbs & reach", "Trunk & garment lengths",
         "Head & face", "Hands & feet", "Arcs & contours", "Skinfolds & composition", "Strength", "Angles", "Ratios & indices", "Demographics", OTHER]


def _any(tokens, name: str) -> bool:
    s = _W[name]
    return any(t in s for t in tokens)


def category_of(key: str, known: str | None = None) -> str:
    """Category of a measure: the harmonized one if known, else guessed from the words in its key."""
    if known:
        return known
    k = key[6:] if key.startswith("other:") else key
    t = k.split("_")
    if len(t) == 1 and t[0] == "age":
        return "Demographics"
    if _any(t, "comp"):
        return "Skinfolds & composition"
    if _any(t, "strength"):
        return "Strength"
    if _any(t, "angle"):
        return "Angles"
    if _any(t, "ratio") or ("index" in t and "finger" not in t):
        return "Ratios & indices"
    if _any(t, "head"):
        return "Head & face"
    if _any(t, "seated"):
        return "Seated"
    height_like = "height" in t or "level" in t
    if _any(t, "hand") and not height_like and not ("wrist" in t and _any(t, "armish")):
        return "Hands & feet"
    if _any(t, "circ"):
        return "Circumferences"
    if _any(t, "breadth"):
        return "Breadths & depths"
    if height_like:
        return "Heights (standing)"
    if _any(t, "arc"):
        return "Arcs & contours"
    if _any(t, "trunk") and not _any(t, "limb_only"):
        return "Trunk & garment lengths"
    if _any(t, "limb"):
        return "Limbs & reach"
    if _any(t, "size"):
        return "Body size"
    return OTHER


def category_order(names) -> list:
    """Display order: the known categories first, then any others in the order given."""
    names = list(names)
    return [c for c in ORDER if c in names] + [c for c in names if c not in ORDER]
