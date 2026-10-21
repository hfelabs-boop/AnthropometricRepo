"""Query layer over the repository's aggregate statistics.

Standard library only, so the same code runs in the REST service, the MCP server and the static build on Vercel.

Data (all read-only, all tracked in the repository):
  aggregates/rollup.csv            one row per country x role x sex x measure: n-weighted mean, SD, P5/P50/P95, reliability
  aggregates/aggregates.csv        every source row (used to pick one survey instead of the combined values)
  aggregates/official_documents.csv  which official defence / standards document a survey comes from
  database/harmonized_measures.csv   measure names, units, categories
  catalog/surveys.csv, catalog/papers.csv   titles and links of the sources
"""
from __future__ import annotations

import csv
import difflib
import hashlib
import json
import math
import os
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from statistics import NormalDist

from .measurecat import category_of, category_order

VERSION = "1.1.0"
CALC_REVISION = 2  # bump when the maths, rounding or response contents change: part of data_version
REPOSITORY = "https://github.com/hfelabs-boop/AnthropometricRepo"
ATTRIBUTION = (
    "Compiled from published surveys; every value lists its sources. Open datasets: ANSUR 1988 and ANSUR II (US Army, public domain, via the "
    "Penn State OPEN Design Lab), ASRAN 2015 (© Commonwealth of Australia, CC BY 3.0 AU, via data.gov.au), USAF 1967 (US Government, via the "
    "CRAN Anthropometry package). Other values are statistics tabulated in the cited papers and reports."
)
DISCLAIMER = (
    "Population statistics for design studies, not measurements of any person. Each dimension is the requested percentile of that dimension "
    "alone: a person at the 95th percentile of stature is rarely at the 95th percentile of every other dimension, so a set of same-percentile "
    "dimensions is a boundary case, not a typical body. Surveys span the 1940s to the 2020s and use different landmark definitions."
)
RELIABILITY_LEVELS = {
    "high": "Every source is raw data, a validated table or an official defence document; the percentiles are printed by the source; 100 people or more.",
    "medium": "OCR of a published paper, percentiles estimated from the mean and SD, or 30 to 99 people.",
    "low": "Values read from a web article without consistency checks, fewer than 30 people, or no percentiles and no SD.",
}

Z95 = NormalDist().inv_cdf(0.95)
_ND = NormalDist()
LENGTH_UNITS = {"mm", "cm", "0.1 mm", "in", "m"}  # lengths are stored in mm
REL_RANK = {"high": 0, "medium": 1, "low": 2}
MIN_REL = {"high": {"high"}, "medium": {"high", "medium"}, "low": {"high", "medium", "low"}, "all": {"high", "medium", "low"}}
SEX_ALIASES = {"m": "M", "male": "M", "men": "M", "man": "M", "f": "F", "female": "F", "women": "F", "woman": "F",
               "both": "both", "mixed": "both", "b": "both", "unknown": "both", "not-stated": "both", "not stated": "both"}
COUNTRY_ALIASES = {"usa": "United States", "us": "United States", "u.s.": "United States", "united states of america": "United States", "america": "United States",
                   "uk": "United Kingdom", "great britain": "United Kingdom", "britain": "United Kingdom", "england": "United Kingdom",
                   "korea": "South Korea", "republic of korea": "South Korea", "czechia": "Czech Republic", "holland": "Netherlands",
                   "russian federation": "Russia", "ksa": "Saudi Arabia", "rsa": "South Africa", "viet nam": "Vietnam", "turkiye": "Turkey"}
# a few words people use that the measure names do not (query word -> words that are searched instead)
SYNONYMS = {"weight": ["mass"], "width": ["breadth"], "wide": ["breadth"], "tall": ["stature"], "height": ["stature"]}
MAX_QUERY_TERMS = 12
MAX_NAMES = 200  # entries in a comma separated list of countries or roles
VINTAGE_YEARS = 15  # combined values spanning more years than this get a warning, and a .latest static file
STOP_WORDS = {"to", "of", "the", "and", "a", "an", "in", "for", "on", "at", "by", "with"}
# whole queries -> harmonized keys that answer them (listed first in a search)
PHRASE_KEYS = {
    "shoulder breadth": ["bideltoid_breadth", "biacromial_breadth"], "shoulder width": ["bideltoid_breadth", "biacromial_breadth"],
    "hip width": ["hip_breadth_sitting", "bicristal_breadth"], "hip breadth": ["hip_breadth_sitting", "bicristal_breadth"],
    "seat depth": ["buttock_popliteal_length", "buttock_knee_length"], "seat length": ["buttock_popliteal_length"],
    "eye height": ["eye_height_sitting"], "sitting eye height": ["eye_height_sitting"], "body weight": ["mass"], "weight": ["mass"],
    "arm reach": ["thumbtip_reach", "span"], "reach": ["thumbtip_reach", "span"], "knee height": ["knee_height_sitting", "popliteal_height"],
    "chest width": ["chest_breadth"], "head size": ["head_circumference", "head_length", "head_breadth"],
    "height": ["stature"], "body height": ["stature"], "standing height": ["stature"], "tall": ["stature"], "how tall": ["stature"],
    "lower leg": ["popliteal_height", "knee_height_sitting"], "body mass": ["mass"], "body weight kg": ["mass"],
}
SEX_NAMES = {"M": "men", "F": "women", "both": "mixed / not stated"}
DEFAULT_PERCENTILES = (5, 50, 95)
MAX_PERCENTILES = 20
MAX_MEASURES = 600
DATA_FILES = ("aggregates/rollup.csv", "aggregates/aggregates.csv", "aggregates/official_documents.csv", "database/harmonized_measures.csv",
              "catalog/surveys.csv", "catalog/papers.csv")


class ApiError(Exception):
    """Base class: a request the service cannot answer. `status` is the HTTP status the REST layer uses."""
    status = 400
    code = "error"

    def __init__(self, message: str, hint: str | None = None, available: list | None = None, close: bool = False):
        """`available` lists the valid values, or (close=True) only the nearest matches to what was asked."""
        super().__init__(message)
        self.message, self.hint, self.available, self.close = message, hint, available, close

    def to_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.hint:
            d["hint"] = self.hint
        if self.available is not None:
            d["available"] = self.available
            if self.close:
                d["closest"] = True
        return d


class NotFound(ApiError):
    status = 404
    code = "not_found"


class BadRequest(ApiError):
    status = 422
    code = "bad_request"


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def _f(x):
    if x is None or x == "":
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def estimated_tails(m: float, sd: float):
    """P5 and P95 from a mean and SD: normal (mean +/- 1.645 SD); lognormal when that would reach zero (positive, skewed
    measures such as skinfolds). The third value is the lognormal median in that case, else None."""
    a, c = m - Z95 * sd, m + Z95 * sd
    if a > 0 or m <= 0:
        return a, c, None
    s2 = math.log(1 + (sd / m) ** 2)
    mu = math.log(m) - s2 / 2
    return math.exp(mu - Z95 * math.sqrt(s2)), math.exp(mu + Z95 * math.sqrt(s2)), math.exp(mu)


def row_dist(m, sd, p5, p50, p95):
    """(p5, p50, p95, printed) of one source row, `printed` = flags for the percentiles the source printed. Same rules as
    scripts/build_aggregates.py: printed tails are kept, a missing tail comes from the mean and SD, a missing median is the mean."""
    a, b, c = p5, p50, p95
    if a is not None and c is not None and a < c:
        rep = (True, True, True)
    elif m is not None and sd:
        ka = a is not None and a < m + Z95 * sd
        kc = c is not None and c > m - Z95 * sd
        ea, ec, em = estimated_tails(m, sd)
        a, c, rep = (a if ka else ea), (c if kc else ec), (ka, em is None, kc)
        if em is not None and b is None:
            b = em
    else:
        return None
    if b is None or not a <= b <= c:
        b, rep = (m if m is not None and a <= m <= c else (a + c) / 2), (rep[0], False, rep[2])
    return a, min(max(b, a + 1e-9), c - 1e-9), c, rep


Z_MIN = abs(_ND.inv_cdf(0.001))  # the lowest percentile the service allows (0.1)


def skewed_positive(p5: float, p50: float, p95: float) -> bool:
    """True when the straight line through P5, P50, P95 (linear in the normal score) would reach zero or below before P0.1, that is when the
    lower half of the distribution is wider than about 53% of the median (typical for skinfolds, body fat, ages). The tail below P5 is then
    extended on the log scale, which cannot go negative; it also replaces the (still positive) straight-line values between P0.1 and P5."""
    return p5 > 0 and p50 > p5 and p50 - Z_MIN / Z95 * (p50 - p5) <= 0


def quantile(p5: float, p50: float, p95: float, p: float) -> float:
    """Value at percentile p (0 < p < 100) on the line through (z(5), p5), (z(50), p50), (z(95), p95), linear in the normal score.
    Below P5 the line is replaced by its log-scale equivalent for measures whose lower half is very wide (see skewed_positive)."""
    if p == 5:
        return p5
    if p == 50:
        return p50
    if p == 95:
        return p95
    z = _ND.inv_cdf(p / 100)
    if z >= 0:
        return p50 + z / Z95 * (p95 - p50)
    if z < -Z95 and skewed_positive(p5, p50, p95):
        return math.exp(math.log(p50) + z / Z95 * (math.log(p50) - math.log(p5)))
    return p50 + z / Z95 * (p50 - p5)


def pkey(p: float) -> str:
    return "p" + (str(int(p)) if float(p).is_integer() else str(p))


def _round(v, unit: str):
    if v is None:
        return None
    return round(v, 1 if unit == "mm" else 3 if unit == "ratio" else 2)


def _split(s: str) -> list:
    return [x for x in (s or "").split("; ") if x]


class Repo:
    """All data in memory (about 20 MB, loaded in under a second). Methods return plain dicts and lists."""

    def __init__(self, data_dir: str | os.PathLike | None = None):
        root = Path(data_dir or os.environ.get("ANTHRO_DATA_DIR") or Path(__file__).resolve().parent.parent)
        self.root = root
        self._load(root)

    # ------------------------------------------------------------------ loading
    @staticmethod
    def _read(path: Path, required: bool = True) -> list:
        if not path.exists():
            if required:
                raise FileNotFoundError(f"data file not found: {path} (set ANTHRO_DATA_DIR to a checkout of the repository)")
            return []
        with open(path, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))

    def _load(self, root: Path):
        roll = self._read(root / "aggregates" / "rollup.csv")
        agg = self._read(root / "aggregates" / "aggregates.csv")
        harm = self._read(root / "database" / "harmonized_measures.csv")
        self._official = {r["source_id"]: r for r in self._read(root / "aggregates" / "official_documents.csv", False)}
        self._survey_catalog = {r["id"]: r for r in self._read(root / "catalog" / "surveys.csv", False)}
        self._papers = self._read(root / "catalog" / "papers.csv", False)
        h = hashlib.sha1(f"{VERSION}/{CALC_REVISION}".encode())
        for name in DATA_FILES:  # every file an answer can depend on; line endings do not matter
            f = root / name
            if f.exists():
                h.update(name.encode() + b"\0" + f.read_bytes().replace(b"\r\n", b"\n"))
        self.data_version = h.hexdigest()[:12]

        # measures: harmonized first, then the as-published keys
        self._measures: dict = {}
        for r in harm:
            self._measures[r["key"]] = {"key": r["key"], "name": r["label"], "category": r["category"], "unit": r["unit"], "note": r["note"] or None, "harmonized": True}
        other_unit: dict = {}
        for r in agg:
            if r["measure_key"].startswith("other:") and r["measure_key"] not in other_unit:
                other_unit[r["measure_key"]] = "mm" if r["unit_original"] in LENGTH_UNITS else r["unit_original"]
        votes: dict = defaultdict(lambda: defaultdict(int))
        for r in roll:
            if r["measure_key"].startswith("other:"):
                votes[r["measure_key"]][r["measure_label"]] += 1
        for r in agg:  # keys that never reached the roll-up (mean-only rows) can still be asked for with survey=... (same rows the single-survey path reads)
            if (r["is_primary"] == "1" and r["population_type"] != "civilian" and "#sub" not in r["survey_group"] and _f(r["mean"]) is not None
                    and r["measure_key"] not in self._measures and r["measure_key"] not in votes):
                votes[r["measure_key"]][r["measure_label"] or r["measure_key"]] += 1
        for k, v in votes.items():  # the most common label, English-looking ones first
            name = sorted(v.items(), key=lambda kv: (not kv[0].isascii(), -kv[1], kv[0]))[0][0]
            self._measures[k] = {"key": k, "name": name, "category": category_of(k), "unit": other_unit.get(k, "mm"), "note": None, "harmonized": False}
        for k, m in self._measures.items():
            m["category"] = category_of(k, m["category"] if m["harmonized"] else None)

        # roll-up: (country, role, sex) -> {measure_key: row}
        self._roll: dict = defaultdict(dict)
        self._groups: dict = {}
        for r in roll:
            row = {
                "key": r["measure_key"], "label": r["measure_label"], "n": int(float(r["n_total"])) if r["n_total"] else None,
                "mean": _f(r["mean"]), "sd": _f(r["sd"]), "p5": _f(r["p5"]), "p50": _f(r["p50"]), "p95": _f(r["p95"]),
                "estimated": set(r["pct_estimated"].split()), "reliability": r["reliability"], "reliability_note": r["reliability_note"] or None,
                "official": _split(r["official_docs"]), "sources": _split(r["sources"]), "surveys": json.loads(r["survey_groups"] or "[]"),
                "year_min": int(float(r["year_min"])) if r["year_min"] else None, "year_max": int(float(r["year_max"])) if r["year_max"] else None,
                "n_surveys": int(float(r["n_surveys"])) if r["n_surveys"] else 1, "mean_min": _f(r["mean_min"]), "mean_max": _f(r["mean_max"]),
            }
            self._roll[(r["country"], r["service_role"], r["sex"])][r["measure_key"]] = row
            g = self._groups.setdefault((r["country"], r["service_role"]), {"sexes": set(), "measures": set()})
            g["sexes"].add(r["sex"])
            g["measures"].add(r["measure_key"])
        cover: dict = defaultdict(set)
        for (c, role, sex), rows in self._roll.items():
            for k in rows:
                cover[k].add((c, role))
        self._cover = dict(cover)  # a plain dict: looking a key up must never add it

        # name indexes: ids (slugs) and display names, case-insensitive
        self._countries = sorted({c for c, _ in self._groups})
        self._country_ix = {}
        for c in self._countries:
            self._country_ix[c.lower()] = c
            self._country_ix[slug(c)] = c
        for alias, c in COUNTRY_ALIASES.items():
            if c in self._countries:
                self._country_ix[alias] = self._country_ix[slug(alias)] = c
        self._roles_of: dict = defaultdict(list)
        for c, role in sorted(self._groups):
            self._roles_of[c].append(role)
        self._role_ix: dict = {c: {} for c in self._countries}
        for c, roles in self._roles_of.items():
            for role in roles:
                self._role_ix[c][role.lower()] = role
                self._role_ix[c][slug(role)] = role
        self._all_roles = sorted({role for _, role in self._groups})
        self._name_pieces = max([n.count(",") + 1 for n in [*self._countries, *self._all_roles]] + [1])  # the most comma separated pieces of any name
        self._any_role_ix = {}
        for role in self._all_roles:
            self._any_role_ix[role.lower()] = role
            self._any_role_ix[slug(role)] = role

        # single surveys: primary, non-civilian, non-subgroup source rows
        self._survey_rows: dict = defaultdict(list)
        self._survey_info: dict = {}
        for r in agg:
            if r["is_primary"] != "1" or r["population_type"] == "civilian" or "#sub" in r["survey_group"] or _f(r["mean"]) is None:
                continue
            key = (r["country"], r["service_role"], r["survey_group"])
            self._survey_rows[key].append(r)
            s = self._survey_info.setdefault(key, {"name": r["population"], "year": None, "n": {}, "sexes": set(), "source_id": r["source_id"], "official": r["official_doc"] or None})
            s["sexes"].add(r["sex"])
            y = _f(r["year_start"])
            if y is not None and (s["year"] is None or y < s["year"]):
                s["year"] = int(y)
            n = _f(r["n"])
            if n:
                s["n"][r["sex"]] = max(s["n"].get(r["sex"], 0), int(n))
        used = defaultdict(set)
        for (c, role, sex), rows in self._roll.items():
            for row in rows.values():
                used[(c, role)].update(row["surveys"])
        self._survey_used = used
        self._survey_ix: dict = {}
        for (c, role, sg) in self._survey_info:
            self._survey_ix[(c, role, slug(sg))] = sg
            self._survey_ix[(c, role, sg.lower())] = sg
        self._survey_cache: dict = {}
        self._survey_count: dict = defaultdict(int)
        for (c, role, _sg) in self._survey_info:
            self._survey_count[(c, role)] += 1

    # ------------------------------------------------------------------ lookups
    def _country(self, name: str) -> str:
        c = self._country_ix.get(str(name).strip().lower()) or self._country_ix.get(slug(name))
        if not c:
            close = difflib.get_close_matches(str(name), self._countries, n=5, cutoff=0.75)
            raise NotFound(f"Unknown country '{name}'.", "List the countries first (GET /v1/countries, or the list_countries tool); ids, names and common aliases such as USA or UK work.", close or self._countries, bool(close))
        return c

    def _role(self, country: str, name: str) -> str:
        ix = self._role_ix[country]
        r = ix.get(str(name).strip().lower()) or ix.get(slug(name))
        if not r:
            roles = self._roles_of[country]
            raise NotFound(f"'{country}' has no role '{name}'.", "Roles are survey populations such as Army, Air Force, Aircrew, Pilots, Recruits/trainees.", roles)
        return r

    @staticmethod
    def _sex(sex: str) -> str:
        s = SEX_ALIASES.get(str(sex).strip().lower())
        if not s:
            raise BadRequest(f"Unknown sex '{sex}'.", "Use M, F or both (mixed / not stated).", ["M", "F", "both"])
        return s

    @staticmethod
    def _min_rel(level: str) -> str:
        lv = str(level).strip().lower()
        if lv not in MIN_REL:
            raise BadRequest(f"Unknown reliability level '{level}'.", "high = only high; medium = high and medium (default); low or all = everything.", ["high", "medium", "low", "all"])
        return "low" if lv == "all" else lv

    @staticmethod
    def _percentiles(values) -> list:
        if values is None:
            return list(DEFAULT_PERCENTILES)
        out = []
        for v in values:
            try:
                p = float(v)
            except (TypeError, ValueError):
                raise BadRequest(f"Percentile '{v}' is not a number.", "Use numbers between 0.1 and 99.9, for example 5,50,95.")
            if not 0.1 <= p <= 99.9:
                raise BadRequest(f"Percentile {p:g} is outside 0.1 to 99.9.", "Percentiles are percent of the population, for example 5, 50, 95.")
            p = int(p) if p.is_integer() else p
            if p not in out:
                out.append(p)
        if not out:
            raise BadRequest("No percentile given.", "For example percentiles=5,50,95.")
        if len(out) > MAX_PERCENTILES:
            raise BadRequest(f"At most {MAX_PERCENTILES} percentiles per request.")
        return out

    def _measure_key(self, m: str) -> str | None:
        """A measure key from what was typed: exact, other:-prefixed, or lower-cased with spaces as underscores (Stature, sitting height)."""
        for cand in (m, f"other:{m}", m.lower(), m.lower().replace(" ", "_"), f"other:{m.lower().replace(' ', '_')}"):
            if cand in self._measures:
                return cand
        return None

    def _measure_keys(self, measures) -> list:
        keys = []
        for m in measures:
            m = str(m).strip()
            if not m:
                continue
            k = self._measure_key(m)
            if k is None:
                close = [x["key"] for x in self.measures(q=m.replace("_", " "), limit=5)]  # the word search knows synonyms (weight = mass) and phrases (body height = stature)
                close += [x for x in difflib.get_close_matches(m, list(self._measures), n=5, cutoff=0.6) if x not in close]
                close = close[:5]
                raise NotFound(f"Unknown measure '{m}'.", "Search measures by name (GET /v1/measures?q=waist, or the search_measures tool). Keys look like stature, mass, sitting_height or other:waist_hip_ratio.",
                               close or None, bool(close))
            if k not in keys:
                keys.append(k)
        if not keys:
            raise BadRequest("No measure given.", "Give a measure key such as stature, mass or other:waist_hip_ratio.")
        if len(keys) > MAX_MEASURES:
            raise BadRequest(f"At most {MAX_MEASURES} measures per request.")
        return keys

    def split_names(self, text: str, kind: str = "country") -> list:
        """Split a comma separated list of countries or roles. Two country names contain commas ('Multiple: Turkey, Greece, Italy'), so neighbouring
        pieces are joined when the joined text is a known name; no name has more than `_name_pieces` pieces, which bounds the work."""
        known = self.knows_country if kind == "country" else self.knows_role
        pieces = [x.strip() for x in str(text).split(",") if x.strip()]
        if len(pieces) > MAX_NAMES:
            raise BadRequest(f"At most {MAX_NAMES} names per list.")
        out, i = [], 0
        while i < len(pieces):
            for j in range(min(len(pieces), i + self._name_pieces), i + 1, -1):  # the longest run (at least two pieces) that is a known name
                joined = ", ".join(pieces[i:j])
                if known(joined):
                    out.append(joined)
                    i = j
                    break
            else:
                out.append(pieces[i])
                i += 1
        return out

    def knows_country(self, name: str) -> bool:
        """True when `name` as a whole is a country (some names contain commas, so lists cannot be split blindly)."""
        return bool(self._country_ix.get(str(name).strip().lower()) or self._country_ix.get(slug(name)))

    def knows_role(self, name: str) -> bool:
        return bool(self._any_role_ix.get(str(name).strip().lower()) or self._any_role_ix.get(slug(name)))

    # ------------------------------------------------------------------ catalog queries
    def meta(self) -> dict:
        return {
            "name": "Military Anthropometry API", "version": VERSION, "data_version": self.data_version, "repository": REPOSITORY,
            "counts": {"countries": sum(1 for c in self._countries if not c.startswith("Multiple:")), "pooled_samples": sum(1 for c in self._countries if c.startswith("Multiple:")),
                       "country_role_groups": len(self._groups), "populations": len(self._roll), "measures": len(self._cover), "values": sum(len(r) for r in self._roll.values()),
                       "surveys": sum(n for k, n in self._survey_count.items() if k in self._groups)},
            "units": "Lengths in millimetres, body mass in kilograms, BMI in kg/m2, age in years; as-published measures keep their printed unit (%, ratio, degrees ...). Each measure lists its unit.",
            "reliability_levels": RELIABILITY_LEVELS,
            "percentile_methods": {
                "reported": "printed by the one survey the value comes from",
                "pooled": "P5, P50 and P95 of the n-weighted mixture of several surveys, each of which printed its percentiles: no single source prints this number",
                "estimated": "estimated from the mean and SD (normal; lognormal for positive skewed measures)",
                "interpolated": "between P5 and P95, on the line linear in the normal score through P5, P50 and P95",
                "extrapolated": "beyond P5 or P95 on the same line; where that line would reach zero before P0.1 (the lower half wider than about 53% of the median: skinfolds, body fat, ages) the part below P5 follows it on the log scale so it never goes below zero; less certain the further out",
            },
            "attribution": ATTRIBUTION, "disclaimer": DISCLAIMER,
        }

    def countries(self) -> list:
        out = []
        for c in self._countries:
            out.append({"id": slug(c), "name": c, "roles": [self._role_summary(c, r) for r in self._roles_of[c]]})
        return out

    def roles(self, country: str) -> dict:
        c = self._country(country)
        return {"id": slug(c), "name": c, "roles": [self._role_summary(c, r) for r in self._roles_of[c]]}

    def _role_summary(self, c: str, role: str) -> dict:
        g = self._groups[(c, role)]
        return {"id": slug(role), "name": role, "sexes": [s for s in ("M", "F", "both") if s in g["sexes"]], "measures": len(g["measures"]),
                "surveys": self._survey_count[(c, role)], "surveys_in_combined_values": len(self._survey_used[(c, role)])}

    def _category(self, name: str) -> str:
        known = {slug(m["category"]): m["category"] for m in self._measures.values()}
        c = known.get(slug(name))
        if c is None:
            raise NotFound(f"Unknown category '{name}'.", "List the categories first (GET /v1/categories, or the list_categories tool).", [x["name"] for x in self.categories()])
        return c

    def measures(self, category: str | None = None, q: str | None = None, country: str | None = None, role: str | None = None, sex: str | None = None,
                 limit: int | None = None) -> list:
        """Measures that have data, optionally narrowed by words in the name, category and population. With words, the best matches
        come first: the measures a phrase is known to mean (PHRASE_KEYS), then whole-word matches in the name, then harmonized measures
        before as-published ones, then those with the most populations."""
        c = self._country(country) if country else None
        rl = None
        if role:
            rl = self._role(c, role) if c else self._any_role_ix.get(str(role).strip().lower()) or self._any_role_ix.get(slug(role))
            if not rl:
                raise NotFound(f"Unknown role '{role}'.", None, self._all_roles)
        sx = self._sex(sex) if sex else None
        cat = self._category(category) if category else None
        raw = str(q or "").lower()[:200]
        terms = [t for t in dict.fromkeys(re.findall(r"[^\W_]+", raw)) if t not in STOP_WORDS]
        only_other = raw.strip() == "other:"
        if terms and terms[0] == "other" and raw.lstrip().startswith("other:"):
            terms = terms[1:]  # the key prefix, not a word of the name
        terms = terms[:MAX_QUERY_TERMS]
        if raw.strip() and not terms and not only_other:
            return []  # something was typed but nothing in it can be searched for (stop words, punctuation): no matches, not the whole catalog
        text = " ".join(terms)
        alts = [[t] + SYNONYMS.get(t, []) for t in terms]
        pats = [[re.compile(r"\b" + re.escape(a)) for a in group] for group in alts]
        phrase = [k for k in PHRASE_KEYS.get(text, []) if k in self._cover]
        order = category_order({m["category"] for m in self._measures.values()})
        out = []
        for k, m in self._measures.items():
            if k not in self._cover or (cat and m["category"] != cat) or (only_other and m["harmonized"]):
                continue
            hay = f"{m['name']} {k.replace('other:', '').replace('_', ' ')} {m['category']}".lower()
            if pats and k not in phrase and not all(any(p.search(hay) for p in group) for group in pats):
                continue
            groups = self._cover[k]  # (country, role) groups; k is in _cover (checked above)
            if c:
                groups = {g for g in groups if g[0] == c}
            if rl:
                groups = {g for g in groups if g[1] == rl}
            if sx:
                groups = {g for g in groups if k in self._roll.get((g[0], g[1], sx), {})}
            if (c or rl or sx) and not groups:
                continue
            words = set(re.findall(r"[a-z0-9]+", m["name"].lower()))
            exact = sum((2 if group[0] in words else 1) for group in alts if any(a in words for a in group))
            rank = (phrase.index(k) if k in phrase else len(phrase), -exact, not m["harmonized"], -len(groups), order.index(m["category"]), m["name"].lower()) if text else \
                   (order.index(m["category"]), not m["harmonized"], -len(groups), m["name"].lower())
            out.append((rank, {"key": k, "name": m["name"], "category": m["category"], "unit": m["unit"], "note": m["note"], "harmonized": m["harmonized"], "populations": len(groups)}))
        out.sort(key=lambda x: x[0])
        items = [x[1] for x in out]
        return items[: int(limit)] if limit else items

    def categories(self) -> list:
        cnt: dict = defaultdict(int)
        for k, m in self._measures.items():
            if k in self._cover:  # only measures that have values: the counts add up to meta.counts.measures
                cnt[m["category"]] += 1
        return [{"id": slug(c), "name": c, "measures": cnt[c]} for c in category_order(cnt)]

    def measure(self, key: str) -> dict:
        k = self._measure_keys([key])[0]
        if k not in self._cover:
            raise NotFound(f"'{k}' has no values in the combined data.", "It exists only as a mean in single surveys: ask for it with design-values and survey=<id>.")
        m = dict(self._measures[k])
        m["harmonized"] = m.pop("harmonized", False)
        pops = []
        for (c, role) in sorted(self._cover[k]):
            sexes = [s for s in ("M", "F", "both") if k in self._roll.get((c, role, s), {})]
            pops.append({"country": c, "country_id": slug(c), "role": role, "role_id": slug(role), "sexes": sexes})
        m["populations"] = pops
        return m

    def surveys(self, country: str, role: str) -> dict:
        c = self._country(country)
        r = self._role(c, role)
        out = []
        for (cc, rr, sg), info in self._survey_info.items():
            if (cc, rr) != (c, r):
                continue
            out.append({"id": slug(sg), "name": info["name"], "year": info["year"], "n": info["n"], "sexes": [s for s in ("M", "F", "both") if s in info["sexes"]],
                        "source_id": info["source_id"], "official_document": (self._official.get(info["source_id"]) or {}).get("document_id"),
                        "in_combined_values": sg in self._survey_used[(c, r)]})
        out.sort(key=lambda s: (-(s["year"] or 0), s["name"]))
        return {"country": c, "country_id": slug(c), "role": r, "role_id": slug(r), "surveys": out}

    def source(self, source_id: str) -> dict:
        sid = str(source_id).strip()
        if not sid:
            raise BadRequest("No source id given.", "Take an id from the 'sources' field of a value.")
        survey = self._survey_catalog.get(sid)
        papers = [p for p in self._papers if p["survey_id"] == sid or p["paper_id"] == sid]
        off = self._official.get(sid)
        if not (survey or papers or off):
            used = any(sid in row["sources"] for rows in self._roll.values() for row in rows.values())
            if not used:
                raise NotFound(f"Unknown source '{source_id}'.", "Source ids are listed in the 'sources' field of every value.")
        out = {"id": sid, "licence": (survey or {}).get("licence") or None}
        if not out["licence"]:
            out["licence_note"] = "No licence is recorded in the catalog for this source; check the publisher's terms before reuse."
        if survey:
            out["survey"] = {k: survey[k] for k in ("entry", "country", "service", "sexes", "year_start", "n_total", "measured", "published", "sample", "dimensions",
                                                    "data_access", "report_access", "licence", "verification", "citations", "report_urls", "data_urls") if survey.get(k)}
        if papers:
            out["documents"] = [{"title": p["title"], "language": p["language"], "original_url": p["original_url"] or None, "open_copy_url": p["open_copy_url"] or None} for p in papers]
        if off:
            out["official_document"] = {k: off[k] for k in ("document_id", "issuing_body", "doc_type", "reference", "title", "verified", "note") if off.get(k)}
        return out

    # ------------------------------------------------------------------ values
    def _latest_choice(self, country: str, role: str, sex: str) -> tuple:
        """(group of the most recent usable survey or None, newer sizeable surveys that were passed over, each with the reason).
        Candidates are the surveys that have medium or high reliability values for this sex; a population whose surveys are all low reliability falls back to
        all of them (so the usual 'hidden by the reliability filter' note appears instead of an error). Among the candidates: at least 100 people when any
        has that many, at least half as many measures as the best-covered one, and stature plus mass when any has both; then the newest dated survey
        (an undated one only when no dated one qualifies), preferring one that is part of the combined values, then the larger one."""
        cands, anyrows = [], []
        for (c, r, sg), info in self._survey_info.items():
            if (c, r) != (country, role) or sex not in info["sexes"]:
                continue
            rows = [x for x in self._survey_rows[(c, r, sg)] if x["sex"] == sex]
            keys = {x["measure_key"] for x in rows if x["reliability"] != "low"}
            if keys:
                cands.append((sg, info, len(keys), {"stature", "mass"} <= keys, keys))
            anyrows.append((sg, info, len({x["measure_key"] for x in rows}), {"stature", "mass"} <= {x["measure_key"] for x in rows}, {x["measure_key"] for x in rows}))
        cands = cands or anyrows
        if not cands:
            return None, []
        best = max(x[2] for x in cands)
        pool = [x for x in cands if x[2] * 2 >= best]
        pool = [x for x in pool if x[1]["n"].get(sex, 0) >= 100] or pool
        core_pool = [x for x in pool if x[3]]
        pool = core_pool or pool
        used = self._survey_used[(country, role)]
        chosen = max(pool, key=lambda x: (x[1]["year"] is not None, x[1]["year"] or 0, x[0] in used, x[1]["n"].get(sex, 0), x[2], x[0]))
        year = chosen[1]["year"]
        skipped = []
        if year is not None:  # nothing is called newer than a survey whose year is unknown
            for x in sorted((x for x in cands if x is not chosen and x[1]["year"] and x[1]["year"] > year and x[1]["n"].get(sex, 0) >= 100), key=lambda x: (-x[1]["year"], x[0])):
                if x[2] * 2 < best:
                    why = f"covers only {x[2]} of {best} measures"
                elif core_pool and not x[3]:
                    lacking = [lbl for lbl, key in (("stature", "stature"), ("body mass", "mass")) if key not in x[4]]
                    why = "has no " + " or ".join(lacking)
                else:
                    why = "ranks lower"
                skipped.append({"id": slug(x[0]), "name": x[1]["name"], "year": x[1]["year"], "n": x[1]["n"].get(sex, 0), "measures": x[2], "best": best, "why": why})
        return chosen[0], skipped

    def _latest_survey(self, country: str, role: str, sex: str) -> str | None:
        return self._latest_choice(country, role, sex)[0]

    def _single_survey(self, country: str, role: str, survey: str, sex: str) -> tuple:
        """(rows of one survey for one sex, the survey's group name). survey='latest' picks the most recent well-covered survey;
        for a sex it has no data for the rows are empty and the name is None."""
        if str(survey).strip().lower() == "latest":
            raw = self._latest_survey(country, role, sex)
            if raw is None:
                return {}, None
        else:
            raw = self._survey_ix.get((country, role, slug(survey))) or self._survey_ix.get((country, role, str(survey).lower()))
        if raw is None:
            ids = [s["id"] for s in self.surveys(country, role)["surveys"]]
            raise NotFound(f"'{country} / {role}' has no survey '{survey}'.", f"List the surveys first (GET /v1/populations/{slug(country)}/{slug(role)}/surveys, or the list_surveys tool); 'latest' picks the most recent.", ids)
        ck = (country, role, raw)
        if ck not in self._survey_cache:
            best: dict = {}
            for r in self._survey_rows[ck]:
                if r["measure_key"] not in self._measures:
                    continue
                d = row_dist(_f(r["mean"]), _f(r["sd"]), _f(r["p5"]), _f(r["p50"]), _f(r["p95"]))
                score = (REL_RANK[r["reliability"]], 0 if r["p5"] and r["p95"] else 1, -(_f(r["n"]) or 0))
                k = (r["sex"], r["measure_key"])
                if k not in best or score < best[k][0]:
                    best[k] = (score, r, d)
            rows: dict = defaultdict(dict)
            for (sx, mk), (_, r, d) in best.items():
                n = _f(r["n"])
                y = _f(r["year_start"])
                rows[sx][mk] = {
                    "key": mk, "label": r["measure_label"], "n": int(n) if n else None, "mean": _f(r["mean"]), "sd": _f(r["sd"]),
                    "p5": d[0] if d else None, "p50": d[1] if d else None, "p95": d[2] if d else None,
                    "estimated": {p for p, f in zip(("p5", "p50", "p95"), d[3]) if not f} if d else {"p5", "p50", "p95"},
                    "reliability": r["reliability"], "reliability_note": r["reliability_note"] or None,
                    "official": [r["official_doc"]] if r["official_doc"] else [], "sources": [r["source_id"]], "surveys": [raw],
                    "year_min": int(y) if y else None, "year_max": int(y) if y else None,
                    "n_surveys": 1, "mean_min": None, "mean_max": None,
                }
            self._survey_cache[ck] = rows
        return self._survey_cache[ck].get(sex, {}), raw

    def _entry(self, row: dict, percentiles: list, include_stats: bool) -> dict:
        m = self._measures[row["key"]]
        unit = m["unit"]
        have = row["p5"] is not None and row["p50"] is not None and row["p95"] is not None
        pooled = row["n_surveys"] > 1
        values, basis = {}, {}
        for p in percentiles:
            if have:
                values[pkey(p)] = _round(quantile(row["p5"], row["p50"], row["p95"], p), unit)
                if p in DEFAULT_PERCENTILES:
                    basis[pkey(p)] = "estimated" if pkey(p) in row["estimated"] else "pooled" if pooled else "reported"
                else:
                    basis[pkey(p)] = "interpolated" if 5 < p < 95 else "extrapolated"
            else:
                values[pkey(p)], basis[pkey(p)] = None, "unavailable"
        spread = None
        if pooled and row["mean"] and row["mean_min"] is not None and row["mean_max"] is not None:
            spread = round((row["mean_max"] - row["mean_min"]) / abs(row["mean"]) * 100, 1)
        e = {"key": row["key"], "name": m["name"], "category": m["category"], "harmonized": m["harmonized"], "unit": unit, "n": row["n"]}
        if include_stats:
            e["mean"], e["sd"] = _round(row["mean"], unit), _round(row["sd"], unit)
        e.update({"percentiles": values, "percentile_basis": basis, "reliability": row["reliability"], "reliability_note": row["reliability_note"],
                  "n_surveys": row["n_surveys"], "survey_spread_pct": spread,
                  "official_documents": row["official"], "sources": row["sources"], "years": [row["year_min"], row["year_max"]] if row["year_min"] else None})
        if row["label"] != m["name"] and not m["harmonized"]:
            e["printed_name"] = row["label"]
        return e

    def _vintage_note(self, c: str, r: str, sex: str, groups: set, years: list | None, row_groups: list | None = None) -> str | None:
        """Warn when the combined values mix surveys decades apart (body size and landmark definitions changed)."""
        if not years or years[1] - years[0] <= VINTAGE_YEARS:
            return None
        info = [(sg, self._survey_info[(c, r, sg)]) for sg in groups if (c, r, sg) in self._survey_info]
        total = sum(i["n"].get(sex, 0) for _, i in info)
        parts = [f"The combined values mix surveys from {years[0]} to {years[1]}."]
        if info and total:
            top_sg, top = max(info, key=lambda x: x[1]["n"].get(sex, 0))
            share = round(100 * top["n"].get(sex, 0) / total)
            behind = sum(1 for g in (row_groups or []) if top_sg in g)
            if share >= 30 and top["year"] and behind * 2 >= len(row_groups or [1]):  # only when it stands behind most of the returned values
                parts.append(f"{share}% of the people are from {top['name']} ({top['year']}).")
        latest, skipped = self._latest_choice(c, r, sex)
        if latest:
            li = self._survey_info[(c, r, latest)]
            when = f", {li['year']}" if li["year"] else ""
            if skipped:
                s0 = skipped[0]
                parts.append(f"survey=latest gives '{li['name']}'{when}, because the newer '{s0['name']}' ({s0['year']}, {s0['n']} people) {s0['why']}; "
                             f"request that survey by id ({s0['id']}) for the measures it has.")
            else:
                parts.append(f"Body size and landmark definitions changed over such a period: for current personnel use survey=latest (now '{li['name']}'{when}) or choose a survey from the survey list.")
        return " ".join(parts)

    def _latest_notes(self, c: str, r: str, sx: str, raw: str | None, returned: int, level: str, whole: bool) -> list:
        """What survey=latest cost: a thinner set than the combined values, or newer surveys that were passed over."""
        notes = []
        _, skipped = self._latest_choice(c, r, sx)
        for s0 in skipped[:2]:
            notes.append(f"A newer survey, '{s0['name']}' ({s0['year']}, {s0['n']} people), {s0['why']} and is not used by survey=latest; request it by id ({s0['id']}) for the measures it has.")
        chosen = self._latest_choice(c, r, sx)[0]
        if chosen and self._survey_info[(c, r, chosen)]["year"] is None:
            others = any(sg != chosen and (c2, r2) == (c, r) and sx in info["sexes"] for (c2, r2, sg), info in self._survey_info.items())
            notes.append("The year of this survey is not recorded" + (", so its recency could not be checked against the other surveys." if others else "."))
        if whole:
            combined = sum(1 for row in self._roll.get((c, r, sx), {}).values() if row["reliability"] in MIN_REL[level])
            if combined and returned < 0.7 * combined:
                notes.append(f"survey=latest has {returned} of the {combined} measures the combined values have at this reliability level; the others exist only in other surveys.")
        return notes

    def design_values(self, country: str, role: str, sex: str = "M", measures=None, categories=None, percentiles=None, min_reliability: str = "medium",
                      survey: str | None = None, include_stats: bool = True) -> dict:
        """Percentiles of every (or the chosen) measure for one population: the numbers a digital-human tool needs.
        survey: None = all surveys combined (as on the website); a survey id; or 'latest' = the most recent well-covered survey."""
        c = self._country(country)
        r = self._role(c, role)
        sx = self._sex(sex)
        ps = self._percentiles(percentiles)
        level = self._min_rel(min_reliability)
        keys = self._measure_keys(measures) if measures else None
        cats = {self._category(x) for x in categories} if categories else None
        survey_raw = None
        if survey:
            rows, survey_raw = self._single_survey(c, r, survey, sx)
        else:
            rows = self._roll.get((c, r, sx), {})
        if not rows:
            have = [s for s in ("M", "F", "both") if (self._single_survey(c, r, survey, s)[0] if survey else self._roll.get((c, r, s)))]
            raise NotFound(f"No {SEX_NAMES[sx]} data for {c} / {r}" + (f" in survey '{survey}'." if survey else "."), "Choose a sex that has data.", have)
        out, hidden, used, row_groups = [], 0, set(), []
        for k, row in rows.items():
            if keys is not None and k not in keys:
                continue
            if cats and self._measures[k]["category"] not in cats:
                continue
            if row["reliability"] not in MIN_REL[level]:
                hidden += 1
                continue
            out.append(self._entry(row, ps, include_stats))
            used.update(row["surveys"])
            row_groups.append(row["surveys"])
        dropped = [k for k in keys if k in rows and cats and self._measures[k]["category"] not in cats] if keys is not None else []
        missing = [k for k in keys if k not in rows] if keys is not None else []
        order = category_order({m["category"] for m in self._measures.values()})
        out.sort(key=lambda e: (order.index(e["category"]), not e["harmonized"], e["name"].lower()))
        years = [y for e in out if e["years"] for y in e["years"] if y]
        span = [min(years), max(years)] if years else None
        ref = lambda sg: {"id": slug(sg), "name": self._survey_info[(c, r, sg)]["name"], "year": self._survey_info[(c, r, sg)]["year"]}
        combined = [] if survey else sorted((ref(sg) for sg in used if (c, r, sg) in self._survey_info), key=lambda x: (-(x["year"] or 0), x["name"]))
        population = {"country": c, "country_id": slug(c), "role": r, "role_id": slug(r), "sex": sx, "sex_name": SEX_NAMES[sx],
                      "survey": ref(survey_raw) if survey else None, "surveys_combined": combined, "years": span}
        notes = [DISCLAIMER]
        if hidden:
            notes.append(f"{hidden} value(s) hidden because their reliability is below '{level}'; set min_reliability=low to include them.")
        if missing:
            notes.append("No data (or hidden by the reliability filter) for: " + ", ".join(missing) + ".")
        if dropped:
            notes.append("Named measures outside the chosen categories were left out (measures and categories are combined with AND; drop 'categories' to get them): "
                         + ", ".join(f"{k} ({self._measures[k]['category']})" for k in dropped) + ".")
        if any(p not in DEFAULT_PERCENTILES for p in ps):
            notes.append("Percentiles other than 5, 50 and 95 are interpolated or extrapolated from P5, P50 and P95; see percentile_basis.")
        if not survey:
            vintage = self._vintage_note(c, r, sx, used, span, row_groups)
            if vintage:
                notes.append(vintage)
            undated = [sg for sg in used if (c, r, sg) in self._survey_info and self._survey_info[(c, r, sg)]["year"] is None]
            if undated:
                notes.append(f"{len(undated)} of the {sum(1 for sg in used if (c, r, sg) in self._survey_info)} combined surveys have no recorded year, so 'years' may understate the span.")
        elif str(survey).strip().lower() == "latest":
            notes += self._latest_notes(c, r, sx, survey_raw, len(out), level, keys is None and cats is None)
        return {"population": population, "percentiles": [pkey(p) for p in ps], "min_reliability": level, "count": len(out), "hidden_by_reliability": hidden,
                "measures": out, "notes": notes}

    def _essentials_notes(self, country: str, role: str, sex: str, survey, by: dict, d: dict, p: float, min_reliability: str, count: int) -> list:
        """Say what a manikin set lacks and why: stature, body mass and sitting height by cause, and a short set as a whole.
        The cause is looked up in the rows the answer was built from: the combined roll-up, or the chosen survey."""
        c = self._country(country)
        r = self._role(c, role)
        sx = self._sex(sex)
        level = self._min_rel(min_reliability)
        rows_of = (lambda s2: self._single_survey(c, r, survey, s2)[0]) if survey else (lambda s2: self._roll.get((c, r, s2), {}))
        roll = rows_of(sx)
        where = "this survey" if survey else "this population"
        notes = []
        for label, key in (("Stature", "stature"), ("Body mass", "mass"), ("Sitting height", "sitting_height")):
            if key in by:
                continue
            alt = f"other:{key}_as_reported"
            filtered = any(k in roll and roll[k]["reliability"] not in MIN_REL[level] for k in (key, alt))
            other_sexes = [s2 for s2 in ("M", "F", "both") if s2 != sx and key in rows_of(s2)]
            elsewhere = [SEX_NAMES[s2] for s2 in other_sexes if rows_of(s2)[key]["reliability"] in MIN_REL[level] and rows_of(s2)[key]["p5"] is not None]
            below = [SEX_NAMES[s2] for s2 in other_sexes if SEX_NAMES[s2] not in elsewhere]
            if key in roll and roll[key]["p5"] is None:
                why = f"has only a mean in {where}, no percentiles"
            elif filtered:
                why = "is hidden by the reliability filter (min_reliability=low shows it)"
            elif alt in roll:
                why = f"is not available as a harmonized measure here, only as '{alt}'"
            elif elsewhere:
                why = "does not exist for this sex, only for " + " and ".join(elsewhere)
            elif below:
                why = "does not exist for this sex; for " + " and ".join(below) + " it exists only below the reliability filter (min_reliability=low shows it)"
            elif survey:
                why = "is not in this survey"
            else:
                why = "does not exist for this population at any reliability level"
            notes.append(f"{label} {why}.")
        if 0 < count < 30:
            seated = any(x["category"] == "Seated" for x in by.values())
            notes.append(f"Only {count} {'dimension is' if count == 1 else 'dimensions are'} available in {where}" + ("" if seated else ", none of them seated") +
                         ": check that they are enough for your manikin.")
        return notes

    def mannequin(self, country: str, role: str, sex: str = "M", percentile: float = 50, measures=None, categories=None, min_reliability: str = "medium",
                  survey: str | None = None) -> dict:
        """One value per dimension at a single percentile: the dimension set for a boundary or reference manikin."""
        ps = self._percentiles([percentile])
        if len(ps) != 1:
            raise BadRequest("Give one percentile.")
        d = self.design_values(country, role, sex, measures, categories, ps, min_reliability, survey, include_stats=True)
        pk = pkey(ps[0])
        dims, unavailable = [], []
        for e in d["measures"]:
            v = e["percentiles"][pk]
            if v is None:
                unavailable.append({"key": e["key"], "name": e["name"], "unit": e["unit"], "mean": e["mean"], "n": e["n"], "reliability": e["reliability"]})
                continue
            dims.append({"key": e["key"], "name": e["name"], "category": e["category"], "harmonized": e["harmonized"], "unit": e["unit"], "value": v, "basis": e["percentile_basis"][pk], "n": e["n"],
                         "reliability": e["reliability"], "years": e["years"], "sources": e["sources"], "n_surveys": e["n_surveys"], "survey_spread_pct": e["survey_spread_pct"]})
        by = {x["key"]: x for x in dims}
        core = {name: by[k]["value"] for name, k in (("stature_mm", "stature"), ("body_mass_kg", "mass"), ("sitting_height_mm", "sitting_height")) if k in by}
        caution = {}
        for x in dims:
            why = []
            if x["reliability"] != "high":
                why.append(f"{x['reliability']} reliability" + (" (estimated from mean and SD)" if x["basis"] == "estimated" else ""))
            elif x["basis"] == "estimated":
                why.append("estimated from mean and SD")
            if x["basis"] == "extrapolated":
                why.append("extrapolated beyond P5/P95")
            if x["survey_spread_pct"] is not None and x["survey_spread_pct"] > 5 and x["category"] != "Demographics":
                why.append(f"the surveys' means differ by {x['survey_spread_pct']:g}% (body size changed over time, or the landmarks differ; see survey=latest)")
            if x["key"] == "bmi" and "stature" in by and "mass" in by:
                why.append("derived from mass and stature: do not set it independently of them")
            if why:
                caution[x["key"]] = why
        notes = list(d["notes"])
        notes.append("Percentile 50 of each dimension: a reference body. Real people vary in proportions, so nobody has every dimension at the median." if ps[0] == 50 else
                     f"Every dimension is percentile {ps[0]:g} of that dimension alone: a boundary case, not a typical body.")
        if unavailable:
            names = ", ".join(x["name"] for x in unavailable[:8]) + (" ..." if len(unavailable) > 8 else "")
            notes.append(f"{len(unavailable)} measure(s) have a mean but no percentiles and are left out (listed under 'unavailable' in the JSON and XML answers): {names}.")
        if not measures and not categories:
            notes += self._essentials_notes(country, role, sex, survey, by, d, ps[0], min_reliability, len(dims))
        if caution:
            notes.append(f"{len(caution)} dimension(s) need care (see 'caution'): lower reliability, estimated or extrapolated values, surveys that differ, or derived values.")
        return {"population": d["population"], "percentile": ps[0], "min_reliability": d["min_reliability"], "count": len(dims), "hidden_by_reliability": d["hidden_by_reliability"],
                "core": core, "values": {x["key"]: x["value"] for x in dims}, "units": {x["key"]: x["unit"] for x in dims}, "caution": caution,
                "dimensions": dims, "unavailable": unavailable, "notes": notes}

    def compare(self, measure: str, sex: str = "M", percentile: float = 50, countries=None, roles=None, min_reliability: str = "medium", min_n: int = 0,
                limit: int | None = None, survey: str | None = None) -> dict:
        """The same measure and percentile across populations, highest first. survey='latest' compares each population's most recent
        survey instead of all its surveys combined (the combined values of some populations span decades)."""
        if survey is not None and str(survey).strip().lower() != "latest":
            raise BadRequest(f"Unknown survey option '{survey}'.", "Comparing populations takes survey=latest or nothing (combined values).", ["latest"])
        latest = survey is not None
        k = self._measure_keys([measure])[0]
        sx = self._sex(sex)
        p = self._percentiles([percentile])[0]
        level = self._min_rel(min_reliability)
        cset = {self._country(c) for c in countries} if countries else None
        rset = {self._any_role_ix.get(str(x).lower()) or self._any_role_ix.get(slug(x)) for x in roles} if roles else None
        if rset is not None and None in rset:
            raise NotFound("Unknown role in 'roles'.", None, self._all_roles)
        m = self._measures[k]
        usable = lambda row: row["reliability"] in MIN_REL[level] and (row["n"] or 0) >= int(min_n) and None not in (row["p5"], row["p50"], row["p95"])
        res, in_combined = [], set()
        for (c, role, s), rows in self._roll.items():
            if s != sx or (cset and c not in cset) or (rset and role not in rset):
                continue
            if k in rows and usable(rows[k]):
                in_combined.add((c, role))
            if latest:
                rows = self._single_survey(c, role, "latest", s)[0]
            if k not in rows or not usable(rows[k]):
                continue
            row = rows[k]
            e = self._entry(row, [p], True)
            res.append({"country": c, "country_id": slug(c), "role": role, "role_id": slug(role), "value": e["percentiles"][pkey(p)], "basis": e["percentile_basis"][pkey(p)],
                        "mean": e["mean"], "n": row["n"], "reliability": row["reliability"], "sources": row["sources"], "years": e["years"], "n_surveys": e["n_surveys"]})
        res.sort(key=lambda x: (-x["value"], x["country"], x["role"]))
        total = len(res)
        notes = [DISCLAIMER]
        years = [y for x in res if x["years"] for y in x["years"] if y]
        pooled = any(x["n_surveys"] > 1 for x in res)
        if latest:
            notes.append("Each population's most recent well-covered survey, not all its surveys combined; see 'years' for the year of each.")
            lost = sorted(in_combined - {(x["country"], x["role"]) for x in res})
            if lost:
                notes.append(f"{len(lost)} population(s) are in the combined comparison but their latest survey has no usable value for this measure (missing, or too unreliable, small or without percentiles), so they are left out: "
                             + "; ".join(f"{c} / {role}" for c, role in lost[:6]) + (" ..." if len(lost) > 6 else "") + ".")
        elif years and max(years) - min(years) > 15:
            notes.append(f"The rows come from surveys between {min(years)} and {max(years)}" + (" and some pool several surveys per population; for current personnel compare with survey=latest." if pooled else "."))
        no_data = {}
        if cset:
            no_data["countries"] = sorted(c for c in cset if not any(x["country"] == c for x in res))
        if rset:
            no_data["roles"] = sorted(r for r in rset if not any(x["role"] == r for x in res))
        no_data = {key: v for key, v in no_data.items() if v}
        if no_data:
            only_other, unusable = [], []
            for c in no_data.get("countries", []):
                good, poor = set(), set()
                for (c2, role2, s2), rows in self._roll.items():
                    if c2 != c or s2 == sx or (rset and role2 not in rset):
                        continue
                    other_rows = self._single_survey(c2, role2, "latest", s2)[0] if latest else rows
                    if k in other_rows:
                        (good if usable(other_rows[k]) else poor).add(SEX_NAMES[s2])
                if good:
                    only_other.append(f"{c} (only {' / '.join(sorted(good))})")
                elif poor:
                    unusable.append(c)
            reason = f"; with another sex there is usable data for: {', '.join(only_other)}" if only_other else ""
            if unusable:
                reason += f"; {', '.join(unusable)} have it for another sex only as values that are too unreliable, too small or without percentiles"
            notes.append("No result for " + "; ".join(f"{key}: {', '.join(v)}" for key, v in no_data.items()) +
                         f": no {SEX_NAMES[sx]} {m['name'].lower()} at this reliability level and sample size{reason}.")
        if limit and total > int(limit):
            res = res[: int(limit)]
            notes.append(f"Showing the first {len(res)} of {total} populations; raise 'limit' or narrow with countries, roles or min_n.")
        return {"measure": {"key": k, "name": m["name"], "unit": m["unit"], "category": m["category"]}, "sex": sx, "percentile": p, "min_reliability": level,
                "survey": "latest" if latest else None, "count": len(res), "total": total, "truncated": total > len(res), "no_data": no_data, "results": res, "notes": notes}


@lru_cache(maxsize=4)
def get_repo(data_dir: str | None = None) -> Repo:
    return Repo(data_dir)
