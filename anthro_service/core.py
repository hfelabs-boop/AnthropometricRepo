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

VERSION = "1.0.0"
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
SEX_NAMES = {"M": "men", "F": "women", "both": "mixed / not stated"}
DEFAULT_PERCENTILES = (5, 50, 95)
MAX_PERCENTILES = 20
MAX_MEASURES = 600


class ApiError(Exception):
    """Base class: a request the service cannot answer. `status` is the HTTP status the REST layer uses."""
    status = 400
    code = "error"

    def __init__(self, message: str, hint: str | None = None, available: list | None = None):
        super().__init__(message)
        self.message, self.hint, self.available = message, hint, available

    def to_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.hint:
            d["hint"] = self.hint
        if self.available is not None:
            d["available"] = self.available
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


def quantile(p5: float, p50: float, p95: float, p: float) -> float:
    """Value at percentile p (0 < p < 100) on the line through (z(5), p5), (z(50), p50), (z(95), p95), linear in the normal score."""
    if p == 5:
        return p5
    if p == 50:
        return p50
    if p == 95:
        return p95
    z = _ND.inv_cdf(p / 100)
    return p50 + z / Z95 * (p95 - p50) if z >= 0 else p50 + z / Z95 * (p50 - p5)


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
        h = hashlib.sha1()
        for name in ("aggregates/rollup.csv", "aggregates/aggregates.csv"):
            h.update((root / name).read_bytes())
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
            }
            self._roll[(r["country"], r["service_role"], r["sex"])][r["measure_key"]] = row
            g = self._groups.setdefault((r["country"], r["service_role"]), {"sexes": set(), "measures": set()})
            g["sexes"].add(r["sex"])
            g["measures"].add(r["measure_key"])
        self._cover: dict = defaultdict(set)
        for (c, role, sex), rows in self._roll.items():
            for k in rows:
                self._cover[k].add((c, role))

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

    # ------------------------------------------------------------------ lookups
    def _country(self, name: str) -> str:
        c = self._country_ix.get(str(name).strip().lower()) or self._country_ix.get(slug(name))
        if not c:
            close = difflib.get_close_matches(str(name), self._countries, n=5, cutoff=0.75)
            raise NotFound(f"Unknown country '{name}'.", "List the countries first (GET /v1/countries, or the list_countries tool); ids, names and common aliases such as USA or UK work.", close or self._countries)
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

    def _measure_keys(self, measures) -> list:
        keys = []
        for m in measures:
            m = str(m).strip()
            if not m:
                continue
            k = m if m in self._measures else f"other:{m}" if f"other:{m}" in self._measures else None
            if k is None:
                close = [x for x in difflib.get_close_matches(m, list(self._measures), n=5, cutoff=0.6)]
                raise NotFound(f"Unknown measure '{m}'.", "Search measures by name (GET /v1/measures?q=waist, or the search_measures tool). Keys look like stature, mass, sitting_height or other:waist_hip_ratio.", close)
            if k not in keys:
                keys.append(k)
        if len(keys) > MAX_MEASURES:
            raise BadRequest(f"At most {MAX_MEASURES} measures per request.")
        return keys

    # ------------------------------------------------------------------ catalog queries
    def meta(self) -> dict:
        return {
            "name": "Military Anthropometry API", "version": VERSION, "data_version": self.data_version, "repository": REPOSITORY,
            "counts": {"countries": len(self._countries), "populations": len(self._groups), "measures": len(self._measures), "values": sum(len(r) for r in self._roll.values()),
                       "surveys": len(self._survey_info)},
            "units": "Lengths in millimetres, body mass in kilograms, BMI in kg/m2, age in years; as-published measures keep their printed unit (%, ratio, degrees ...). Each measure lists its unit.",
            "reliability_levels": RELIABILITY_LEVELS,
            "percentile_methods": {
                "reported": "printed by the source",
                "estimated": "estimated from the mean and SD (normal; lognormal for positive skewed measures)",
                "interpolated": "between P5 and P95, on the line linear in the normal score through P5, P50 and P95",
                "extrapolated": "beyond P5 or P95 on the same line; less certain the further out",
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
                "surveys": len(self._survey_used[(c, role)])}

    def measures(self, category: str | None = None, q: str | None = None, country: str | None = None, role: str | None = None, sex: str | None = None,
                 limit: int | None = None) -> list:
        c = self._country(country) if country else None
        rl = None
        if role:
            rl = self._role(c, role) if c else self._any_role_ix.get(str(role).strip().lower()) or self._any_role_ix.get(slug(role))
            if not rl:
                raise NotFound(f"Unknown role '{role}'.", None, self._all_roles)
        sx = self._sex(sex) if sex else None
        terms = str(q or "").lower().split()
        out = []
        for k, m in self._measures.items():
            if category and slug(m["category"]) != slug(category) and m["category"].lower() != category.lower():
                continue
            hay = f"{m['name']} {k.replace('other:', '').replace('_', ' ')} {m['category']}".lower()
            if terms and not all(t in hay for t in terms):
                continue
            groups = self._cover[k]
            if c:
                groups = {g for g in groups if g[0] == c}
            if rl:
                groups = {g for g in groups if g[1] == rl}
            if sx:
                groups = {g for g in groups if k in self._roll.get((g[0], g[1], sx), {})}
            if (c or rl or sx) and not groups:
                continue
            out.append({"key": k, "name": m["name"], "category": m["category"], "unit": m["unit"], "note": m["note"], "populations": len(groups)})
        order = category_order({m["category"] for m in self._measures.values()})
        out.sort(key=lambda m: (order.index(m["category"]), not self._measures[m["key"]]["harmonized"], -m["populations"], m["name"].lower()))
        return out[: int(limit)] if limit else out

    def categories(self) -> list:
        cnt: dict = defaultdict(int)
        for m in self._measures.values():
            cnt[m["category"]] += 1
        return [{"id": slug(c), "name": c, "measures": cnt[c]} for c in category_order(cnt)]

    def measure(self, key: str) -> dict:
        k = self._measure_keys([key])[0]
        m = dict(self._measures[k])
        m.pop("harmonized", None)
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
        sid = str(source_id)
        survey = self._survey_catalog.get(sid)
        papers = [p for p in self._papers if p["survey_id"] == sid or p["paper_id"] == sid]
        off = self._official.get(sid)
        if not (survey or papers or off):
            used = any(sid in row["sources"] for rows in self._roll.values() for row in rows.values())
            if not used:
                raise NotFound(f"Unknown source '{source_id}'.", "Source ids are listed in the 'sources' field of every value.")
        out = {"id": sid}
        if survey:
            out["survey"] = {k: survey[k] for k in ("entry", "country", "service", "sexes", "year_start", "n_total", "measured", "published", "sample", "dimensions",
                                                    "data_access", "report_access", "licence", "verification", "citations", "report_urls", "data_urls") if survey.get(k)}
        if papers:
            out["documents"] = [{"title": p["title"], "language": p["language"], "original_url": p["original_url"] or None, "open_copy_url": p["open_copy_url"] or None} for p in papers]
        if off:
            out["official_document"] = {k: off[k] for k in ("document_id", "issuing_body", "doc_type", "reference", "title", "verified", "note") if off.get(k)}
        return out

    # ------------------------------------------------------------------ values
    def _single_survey(self, country: str, role: str, survey: str, sex: str) -> tuple:
        raw = self._survey_ix.get((country, role, slug(survey))) or self._survey_ix.get((country, role, str(survey).lower()))
        if raw is None:
            ids = [s["id"] for s in self.surveys(country, role)["surveys"]]
            raise NotFound(f"'{country} / {role}' has no survey '{survey}'.", f"List the surveys first (GET /v1/populations/{slug(country)}/{slug(role)}/surveys, or the list_surveys tool).", ids)
        ck = (country, role, raw)
        if ck not in self._survey_cache:
            best: dict = {}
            for r in self._survey_rows[ck]:
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
                }
            self._survey_cache[ck] = rows
        return self._survey_cache[ck].get(sex, {}), raw

    def _entry(self, row: dict, percentiles: list, include_stats: bool) -> dict:
        m = self._measures[row["key"]]
        unit = m["unit"]
        have = row["p5"] is not None and row["p50"] is not None and row["p95"] is not None
        values, basis = {}, {}
        for p in percentiles:
            if have:
                values[pkey(p)] = _round(quantile(row["p5"], row["p50"], row["p95"], p), unit)
                basis[pkey(p)] = (("estimated" if pkey(p) in row["estimated"] else "reported") if p in DEFAULT_PERCENTILES else "interpolated" if 5 < p < 95 else "extrapolated")
            else:
                values[pkey(p)], basis[pkey(p)] = None, "unavailable"
        e = {"key": row["key"], "name": m["name"], "category": m["category"], "unit": unit, "n": row["n"]}
        if include_stats:
            e["mean"], e["sd"] = _round(row["mean"], unit), _round(row["sd"], unit)
        e.update({"percentiles": values, "percentile_basis": basis, "reliability": row["reliability"], "reliability_note": row["reliability_note"],
                  "official_documents": row["official"], "sources": row["sources"], "years": [row["year_min"], row["year_max"]] if row["year_min"] else None})
        if row["label"] != m["name"] and not m["harmonized"]:
            e["printed_name"] = row["label"]
        return e

    def design_values(self, country: str, role: str, sex: str = "M", measures=None, categories=None, percentiles=None, min_reliability: str = "medium",
                      survey: str | None = None, include_stats: bool = True) -> dict:
        """Percentiles of every (or the chosen) measure for one population: the numbers a digital-human tool needs."""
        c = self._country(country)
        r = self._role(c, role)
        sx = self._sex(sex)
        ps = self._percentiles(percentiles)
        level = self._min_rel(min_reliability)
        keys = self._measure_keys(measures) if measures else None
        cats = {slug(x) for x in categories} if categories else None
        if cats:
            known = {slug(m["category"]) for m in self._measures.values()}
            bad = [x for x in categories if slug(x) not in known]
            if bad:
                raise NotFound(f"Unknown category '{bad[0]}'.", "See GET /v1/categories (or the search_measures tool).", [c["name"] for c in self.categories()])
        survey_raw = None
        if survey:
            rows, survey_raw = self._single_survey(c, r, survey, sx)
        else:
            rows = self._roll.get((c, r, sx), {})
        if not rows:
            have = [s for s in ("M", "F", "both") if (self._roll.get((c, r, s)) if not survey else self._single_survey(c, r, survey, s)[0])]
            raise NotFound(f"No {SEX_NAMES[sx]} data for {c} / {r}" + (f" in survey '{survey}'." if survey else "."), "Choose a sex that has data.", have)
        out, hidden, missing = [], 0, []
        for k, row in rows.items():
            if keys is not None and k not in keys:
                continue
            if cats and slug(self._measures[k]["category"]) not in cats:
                continue
            if row["reliability"] not in MIN_REL[level]:
                hidden += 1
                continue
            out.append(self._entry(row, ps, include_stats))
        if keys is not None:
            missing = [k for k in keys if k not in rows]
        order = category_order({m["category"] for m in self._measures.values()})
        out.sort(key=lambda e: (order.index(e["category"]), not self._measures[e["key"]]["harmonized"], e["name"].lower()))
        years = [y for e in out if e["years"] for y in e["years"] if y]
        combined = [] if survey else [{"id": slug(sg), "name": self._survey_info[(c, r, sg)]["name"], "year": self._survey_info[(c, r, sg)]["year"]}
                                      for sg in sorted(self._survey_used[(c, r)]) if (c, r, sg) in self._survey_info]
        population = {"country": c, "country_id": slug(c), "role": r, "role_id": slug(r), "sex": sx, "sex_name": SEX_NAMES[sx],
                      "survey": None if not survey else {"id": slug(survey_raw), "name": self._survey_info[(c, r, survey_raw)]["name"], "year": self._survey_info[(c, r, survey_raw)]["year"]},
                      "surveys_combined": combined, "years": [min(years), max(years)] if years else None}
        notes = [DISCLAIMER]
        if hidden:
            notes.append(f"{hidden} value(s) hidden because their reliability is below '{level}'; set min_reliability=low to include them.")
        if missing:
            notes.append("No data (or hidden by the reliability filter) for: " + ", ".join(missing) + ".")
        if any(p not in DEFAULT_PERCENTILES for p in ps):
            notes.append("Percentiles other than 5, 50 and 95 are interpolated or extrapolated from P5, P50 and P95; see percentile_basis.")
        return {"population": population, "percentiles": [pkey(p) for p in ps], "min_reliability": level, "count": len(out), "hidden_by_reliability": hidden,
                "measures": out, "notes": notes}

    def mannequin(self, country: str, role: str, sex: str = "M", percentile: float = 50, measures=None, categories=None, min_reliability: str = "medium",
                  survey: str | None = None) -> dict:
        """One value per dimension at a single percentile: the dimension set for a boundary or reference manikin."""
        ps = self._percentiles([percentile])
        if len(ps) != 1:
            raise BadRequest("Give one percentile.")
        d = self.design_values(country, role, sex, measures, categories, ps, min_reliability, survey, include_stats=False)
        pk = pkey(ps[0])
        dims = [{"key": e["key"], "name": e["name"], "category": e["category"], "unit": e["unit"], "value": e["percentiles"][pk], "basis": e["percentile_basis"][pk],
                 "n": e["n"], "reliability": e["reliability"]} for e in d["measures"] if e["percentiles"][pk] is not None]
        by = {x["key"]: x for x in dims}
        core = {name: by[k]["value"] for name, k in (("stature_mm", "stature"), ("body_mass_kg", "mass"), ("sitting_height_mm", "sitting_height"), ("bmi", "bmi")) if k in by}
        notes = d["notes"] + ["Every dimension is the same percentile of that dimension alone; use for boundary cases, not as a typical person."]
        return {"population": d["population"], "percentile": ps[0], "min_reliability": d["min_reliability"], "count": len(dims), "hidden_by_reliability": d["hidden_by_reliability"],
                "core": core, "values": {x["key"]: x["value"] for x in dims}, "dimensions": dims, "notes": notes}

    def compare(self, measure: str, sex: str = "M", percentile: float = 50, countries=None, roles=None, min_reliability: str = "medium", min_n: int = 0,
                limit: int | None = None) -> dict:
        """The same measure and percentile across populations, highest first."""
        k = self._measure_keys([measure])[0]
        sx = self._sex(sex)
        p = self._percentiles([percentile])[0]
        level = self._min_rel(min_reliability)
        cset = {self._country(c) for c in countries} if countries else None
        rset = {self._any_role_ix.get(str(x).lower()) or self._any_role_ix.get(slug(x)) for x in roles} if roles else None
        if rset is not None and None in rset:
            raise NotFound("Unknown role in 'roles'.", None, self._all_roles)
        m = self._measures[k]
        res = []
        for (c, role, s), rows in self._roll.items():
            if s != sx or k not in rows or (cset and c not in cset) or (rset and role not in rset):
                continue
            row = rows[k]
            if row["reliability"] not in MIN_REL[level] or (row["n"] or 0) < int(min_n) or row["p5"] is None or row["p50"] is None or row["p95"] is None:
                continue
            e = self._entry(row, [p], True)
            res.append({"country": c, "country_id": slug(c), "role": role, "role_id": slug(role), "value": e["percentiles"][pkey(p)], "basis": e["percentile_basis"][pkey(p)],
                        "mean": e["mean"], "n": row["n"], "reliability": row["reliability"], "sources": row["sources"], "years": e["years"]})
        res.sort(key=lambda x: (-x["value"], x["country"], x["role"]))
        if limit:
            res = res[: int(limit)]
        return {"measure": {"key": k, "name": m["name"], "unit": m["unit"], "category": m["category"]}, "sex": sx, "percentile": p, "min_reliability": level, "count": len(res),
                "results": res, "notes": [DISCLAIMER]}


@lru_cache(maxsize=4)
def get_repo(data_dir: str | None = None) -> Repo:
    return Repo(data_dir)
