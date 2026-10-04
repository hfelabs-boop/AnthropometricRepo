#!/usr/bin/env python3
"""Merge all aggregate statistics into aggregates/aggregates.csv and aggregates/rollup.csv.

Inputs
  aggregates/raw/*.csv           rows extracted from papers (see aggregates/SPEC.md)
  database/anthro.sqlite         individual-level data -> statistics computed here (origin = 'computed')
  aggregates/survey_groups.csv   maps a paper's population to the survey it describes, so a survey that
                                 appears in several papers is counted once in the rollup

Outputs
  aggregates/aggregates.csv   every row, with origin, survey_group and is_primary
  aggregates/rollup.csv       one row per country x service_role x sex x measure: n-weighted mean,
                              pooled SD and the 5th/50th/95th percentiles over the primary rows
                              (distinct surveys only)

Rules for `is_primary`: rows that describe the same population (same survey_group, country, role, sex
and measure) are duplicates: keep the one with the larger n, ties going to the better origin (computed
from raw data > paper quality A > B > C). Papers that print the same survey are unified through
aggregates/survey_groups.csv; without an entry a paper's rows are only compared with themselves.

Usage: python scripts/build_aggregates.py   (run scripts/build_database.py first)
"""
import csv
import math
import re
import sqlite3
import statistics
from collections import defaultdict
from statistics import NormalDist
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGG = ROOT / "aggregates"
import sys  # noqa: E402
sys.path.insert(0, str(ROOT / "scripts"))
from validate_aggregates import COLUMNS  # noqa: E402

OUT_COLUMNS = COLUMNS + ["origin", "survey_group", "is_primary"]
DATASETS = {  # dataset -> (survey_id, country, service_role, year_start, source_file)
    "ansur_1988": ("ansur-1988", "United States", "Army", 1987, "data/ansur-1988/"),
    "ansur_ii_2012": ("ansur-ii-2012", "United States", "Army", 2010, "data/ansur-ii-2012/"),
    "asran_2015": ("asran-2015", "Australia", "Navy", 2015, "data/asran-2015/"),
    "usaf_1967": ("usaf-1967", "United States", "Aircrew", 1967, "data/usaf-1967/"),
}
ORIGIN_RANK = {"computed": 0, "A": 1, "B": 2, "C": 3}


def load_measures():
    return list(csv.DictReader(open(ROOT / "database/harmonized_measures.csv", encoding="utf-8")))


def pct(sorted_vals, p):
    i = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(i), math.ceil(i)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)


def computed_rows():
    db = ROOT / "database" / "anthro.sqlite"
    if not db.exists():
        raise SystemExit("run scripts/build_database.py first")
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    measures = load_measures()
    rows = []
    for ds, (sid, country, role, year, folder) in DATASETS.items():
        groups = [("", "SELECT * FROM subjects WHERE dataset = ?", (ds,), "")]
        if ds == "ansur_ii_2012":  # by Army component and by branch group
            for comp in [r[0] for r in con.execute("SELECT DISTINCT component FROM subjects WHERE dataset = ? AND component IS NOT NULL", (ds,))]:
                groups.append((f" - {comp}", "SELECT * FROM subjects WHERE dataset = ? AND component = ?", (ds, comp), "component"))
            for br in [r[0] for r in con.execute("SELECT DISTINCT branch FROM subjects WHERE dataset = ? AND branch LIKE 'Army (%'", (ds,))]:
                groups.append((f" - {br.replace('Army (', '').rstrip(')')}", "SELECT * FROM subjects WHERE dataset = ? AND branch = ?", (ds, br), "branch"))
        for suffix, sql, params, kind in groups:
            data = con.execute(sql, params).fetchall()
            for sex in ("M", "F"):
                sub = [r for r in data if r["sex"] == sex]
                if not sub:
                    continue
                for m in measures:
                    k = m["key"]
                    vals = sorted(r[k] for r in sub if r[k] is not None)
                    if len(vals) < 20:
                        continue
                    mean = sum(vals) / len(vals)
                    sd = statistics.stdev(vals)
                    label = {"ansur_1988": "ANSUR 1988", "ansur_ii_2012": "ANSUR II 2012", "asran_2015": "ASRAN 2015", "usaf_1967": "USAF 1967"}[ds]
                    rows.append({
                        "source_id": sid, "source_file": folder, "page": "", "population": f"{label}{suffix}",
                        "country": country, "population_type": "military", "service_role": role, "sex": sex, "year_start": year,
                        "measure_key": k, "measure_label": m["label"], "unit_original": m["unit"],
                        "mean": round(mean, 2), "sd": round(sd, 2), "n": len(vals),
                        "p5": round(pct(vals, .05), 2), "p50": round(pct(vals, .5), 2), "p95": round(pct(vals, .95), 2),
                        "quality": "A", "notes": "computed from the individual-level data in this repository",
                        "origin": "computed", "survey_group": sid if not suffix else f"{sid}#sub{suffix}"})
    return rows


def paper_rows():
    mapping = []
    mp = AGG / "survey_groups.csv"
    if mp.exists():
        mapping = [(r["source_id"], re.compile(r["population_regex"], re.I), r["survey_group"]) for r in csv.DictReader(open(mp, encoding="utf-8"))]
    rows = []
    for f in sorted(AGG.glob("raw/*.csv")):
        if f.name.endswith(("_papers.csv", "_surveys.csv")):  # paper metadata, not statistics
            continue
        for r in csv.DictReader(open(f, encoding="utf-8")):
            if list(r.keys()) != COLUMNS:
                raise SystemExit(f"{f.name}: bad header")
            group = next((g for sid, rx, g in mapping if sid == r["source_id"] and rx.search(r["population"])), None)
            r["origin"] = r["quality"]
            r["survey_group"] = group or f"{r['source_id']}|{r['population']}"
            rows.append(r)
    return rows


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def mark_primary(rows):
    """One row per population x country x role x sex x measure; larger n wins, then better origin."""
    best = {}
    for i, r in enumerate(rows):
        measure = r["measure_key"] if not r["measure_key"].startswith("other:") else r["measure_label"].lower()
        key = (r["survey_group"], r["country"], r["service_role"], r["sex"], measure)
        score = (-(num(r["n"]) or 0), ORIGIN_RANK[r["origin"]])
        if key not in best or score < best[key][0]:
            best[key] = (score, i)
    keep = {i for _, i in best.values()}
    for i, r in enumerate(rows):
        r["is_primary"] = 1 if i in keep else 0


def part_of_total(rows):
    """Indexes of rows that are parts of a pooled total printed in the same source.

    Within one source, country, role, sex and measure, if the largest n equals the sum of the
    other rows' n (within 3%), the others are its parts (for example 'all pilots' 292 and the
    subsonic 188, supersonic 65 and helicopter 39 pilots). Only the total goes into the roll-up.
    """
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        if r["is_primary"] and num(r["n"]) and num(r["mean"]) is not None and r["population_type"] != "civilian":
            measure = r["measure_key"] if not r["measure_key"].startswith("other:") else r["measure_label"].lower()
            groups[(r["source_id"], r["country"], r["service_role"], r["sex"], measure)].append(i)
    parts = set()
    for idx in groups.values():
        if len(idx) < 3:
            continue
        idx = sorted(idx, key=lambda i: -num(rows[i]["n"]))
        top, rest = num(rows[idx[0]]["n"]), sum(num(rows[i]["n"]) for i in idx[1:])
        if rest and 0.97 <= top / rest <= 1.03:
            parts.update(idx[1:])
    return parts


_NORM = NormalDist()
Z95 = _NORM.inv_cdf(0.95)


def row_dist(r):
    """Distribution of one row as (p5, p50, p95, reported). The quantile function is linear in z through these
    three points, so the reported percentiles are reproduced exactly. Rows without percentiles are treated as normal
    (mean +/- 1.645 SD); a missing median is replaced by the mean. None when the row has neither percentiles nor an SD."""
    m, sd = num(r["mean"]), num(r["sd"])
    a, b, c = num(r["p5"]), num(r["p50"]), num(r["p95"])
    if a is not None and c is not None and a < c:
        mid = b if b is not None and a <= b <= c else (m if m is not None and a <= m <= c else (a + c) / 2)
        mid = min(max(mid, a + 1e-9), c - 1e-9)
        return a, mid, c, b is not None and a <= b <= c
    if m is not None and sd:
        return m - Z95 * sd, m, m + Z95 * sd, False
    return None


def _cdf(x, d):
    a, m, c, _ = d
    z = -Z95 * (m - x) / (m - a) if x < m else Z95 * (x - m) / (c - m)
    return _NORM.cdf(z)


def mixture_quantiles(dists, weights, ps=(0.05, 0.5, 0.95)):
    """Quantiles of the n-weighted mixture of the row distributions."""
    if len(dists) == 1:
        a, m, c, _ = dists[0]
        return [{0.05: a, 0.5: m, 0.95: c}[p] for p in ps]
    W = sum(weights)
    lo = min(d[0] - 3 * (d[1] - d[0]) for d in dists)
    hi = max(d[2] + 3 * (d[2] - d[1]) for d in dists)
    out = []
    for p in ps:
        l, h = lo, hi
        for _ in range(80):
            x = (l + h) / 2
            if sum(w * _cdf(x, d) for d, w in zip(dists, weights)) / W < p:
                l = x
            else:
                h = x
        out.append((l + h) / 2)
    return out


def rollup(rows):
    labels = {m["key"]: m["label"] for m in load_measures()}
    parts = part_of_total(rows)
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        if i in parts:
            continue
        # '#sub' rows are subgroups of a survey already counted in full; never add them to the rollup
        if not r["is_primary"] or "#sub" in r["survey_group"] or r["population_type"] == "civilian" or not r["mean"]:
            continue
        n, m = num(r["n"]), num(r["mean"])
        if not n or m is None:
            continue
        groups[(r["country"], r["service_role"], r["sex"], r["measure_key"], r["measure_label"] if r["measure_key"].startswith("other:") else "")].append(r)
    out = []
    for (country, role, sex, key, olabel), rs in groups.items():
        ns = [num(r["n"]) for r in rs]
        ms = [num(r["mean"]) for r in rs]
        N = sum(ns)
        M = sum(n * m for n, m in zip(ns, ms)) / N
        ss = sum((n - 1) * (num(r["sd"]) or 0) ** 2 for n, r in zip(ns, rs)) + sum(n * (m - M) ** 2 for n, m in zip(ns, ms))
        # A pooled SD is only meaningful when every contributing row has an SD.
        sd = math.sqrt(ss / (N - 1)) if N > 1 and all(num(r["sd"]) for r in rs) else None
        years = [int(r["year_start"]) for r in rs if r["year_start"]]
        dists = [row_dist(r) for r in rs]
        if all(dists):
            p5, p50, p95 = mixture_quantiles(dists, ns)
            basis = "reported" if all(d[3] for d in dists) else "estimated" if not any(d[3] for d in dists) else "mixed"
        else:
            p5 = p50 = p95 = None
            basis = ""
        out.append({
            "country": country, "service_role": role, "sex": sex, "measure_key": key,
            "measure_label": (olabel or rs[0]["measure_label"]) if key.startswith("other:") else labels[key],
            "n_total": int(N), "mean": round(M, 2), "sd": round(sd, 2) if sd is not None else "",
            "p5": round(p5, 2) if p5 is not None else "", "p50": round(p50, 2) if p50 is not None else "",
            "p95": round(p95, 2) if p95 is not None else "", "pct_basis": basis,
            "n_surveys": len({r["survey_group"] for r in rs}), "mean_min": round(min(ms), 2), "mean_max": round(max(ms), 2),
            "year_min": min(years) if years else "", "year_max": max(years) if years else "",
            "sources": "; ".join(sorted({r["source_id"] for r in rs}))})
    out.sort(key=lambda r: (r["country"], r["service_role"], r["sex"], r["measure_key"]))
    return out


def main():
    rows = computed_rows() + paper_rows()
    mark_primary(rows)
    with open(AGG / "aggregates.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    roll = rollup(rows)
    fields = ["country", "service_role", "sex", "measure_key", "measure_label", "n_total", "mean", "sd", "p5", "p50", "p95", "pct_basis", "n_surveys",
              "mean_min", "mean_max", "year_min", "year_max", "sources"]
    with open(AGG / "rollup.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(roll)
    prim = sum(r["is_primary"] for r in rows)
    print(f"aggregates.csv: {len(rows)} rows ({prim} primary) from {len({r['source_id'] for r in rows})} sources; "
          f"rollup.csv: {len(roll)} rows over {len({r['country'] for r in roll})} countries")


if __name__ == "__main__":
    main()
