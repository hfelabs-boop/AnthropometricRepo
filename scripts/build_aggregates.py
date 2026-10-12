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
import json
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

OUT_COLUMNS = COLUMNS + ["origin", "survey_group", "is_primary", "official_doc", "official_body", "official_basis", "reliability", "reliability_note"]
DATASETS = {  # dataset -> (survey_id, country, service_role, year_start, source_file)
    "ansur_1988": ("ansur-1988", "United States", "Army", 1987, "data/ansur-1988/"),
    "ansur_ii_2012": ("ansur-ii-2012", "United States", "Army", 2010, "data/ansur-ii-2012/"),
    "asran_2015": ("asran-2015", "Australia", "Navy", 2015, "data/asran-2015/"),
    "usaf_1967": ("usaf-1967", "United States", "Aircrew", 1967, "data/usaf-1967/"),
}
ORIGIN_RANK = {"computed": 0, "A": 1, "B": 2, "C": 3}
REL_RANK = {"high": 0, "medium": 1, "low": 2}


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


def mark_official(rows):
    """Flag rows whose survey is documented in an official defence or standards document (aggregates/official_documents.csv).
    official_basis: 'document table' = values read from the document; 'survey microdata' = computed from the survey's public individual-level data."""
    reg = {r["source_id"]: r for r in csv.DictReader(open(AGG / "official_documents.csv", encoding="utf-8"))}
    for r in rows:
        o = reg.get(r["source_id"])
        r["official_doc"] = o["document_id"] if o else ""
        r["official_body"] = o["issuing_body"] if o else ""
        r["official_basis"] = ("survey microdata" if r["origin"] == "computed" else "document table") if o else ""


def source_tier(r):
    """verified: computed from raw data, a validated born-digital table, or an official defence document's table (OCR that
    passed the consistency checks); checked: OCR of a published paper that passed the consistency checks; unchecked: read from
    a web article's text or tables without the consistency checks."""
    if r["origin"] in ("computed", "A") or (r["origin"] == "B" and r["official_doc"]):
        return "verified"
    return "checked" if r["origin"] == "B" else "unchecked"


def reliability(tiers, basis, n):
    """(grade, reasons). high: every source verified, percentiles reported by the sources (not estimated), at least 100 people.
    low: a source that was not cross-checked, fewer than 30 people (or n not reported), or neither percentiles nor an SD.
    medium: everything in between. Reasons list what keeps the grade below high."""
    why = []
    if "unchecked" in tiers:
        why.append("values read from a web article, not cross-checked")
    if n is None:
        why.append("sample size not reported")
    elif n < 30:
        why.append("fewer than 30 people")
    if not basis:
        why.append("no percentiles or SD reported")
    if why:
        return "low", "; ".join(why)
    if "checked" in tiers:
        why.append("OCR of a published paper (passed the consistency checks)")
    if basis == "estimated":
        why.append("percentiles estimated from mean and SD")
    elif basis == "mixed":
        why.append("some percentiles estimated from mean and SD")
    if n < 100:
        why.append("fewer than 100 people")
    return ("medium" if why else "high"), "; ".join(why)


def mark_reliability(rows):
    for r in rows:
        d = row_dist(r)
        basis = "" if d is None else basis_of([d[3]])
        r["reliability"], r["reliability_note"] = reliability({source_tier(r)}, basis, num(r["n"]))


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def mark_primary(rows):
    """One row per population x country x role x sex x measure (the measure key already merges spelling variants of one
    dimension): printed percentiles win, then the larger n, then the better origin."""
    best = {}
    for i, r in enumerate(rows):
        key = (r["survey_group"], r["country"], r["service_role"], r["sex"], r["measure_key"])
        score = (0 if num(r["p5"]) is not None and num(r["p95"]) is not None else 1, -(num(r["n"]) or 0), ORIGIN_RANK[r["origin"]])
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
        if r["is_primary"] and num(r["n"]) and num(r["mean"]) is not None and r["population_type"] != "civilian" and r["source_id"] != "rp1024-vol2":
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


def estimated_tails(m, sd):
    """P5 and P95 estimated from a mean and SD: normal (mean +/- 1.645 SD); when that would reach zero or below (a strictly
    positive, skewed measure such as a skinfold or body fat) lognormal with the same mean and SD. The third value is the
    lognormal median in that case (a median estimate, since it is not the mean), else None."""
    a, c = m - Z95 * sd, m + Z95 * sd
    if a > 0 or m <= 0:
        return a, c, None
    s2 = math.log(1 + (sd / m) ** 2)
    mu = math.log(m) - s2 / 2
    return math.exp(mu - Z95 * math.sqrt(s2)), math.exp(mu + Z95 * math.sqrt(s2)), math.exp(mu)


def row_dist(r):
    """Distribution of one row as (p5, p50, p95, reported), reported = (p5, p50, p95) flags, True where the source printed
    that percentile. The quantile function is linear in z through the three points, so printed percentiles are reproduced
    exactly. Missing P5 and P95 come from mean +/- 1.645 SD (normal); a missing median is the mean. None when the row has
    neither P5 and P95 nor an SD."""
    m, sd = num(r["mean"]), num(r["sd"])
    a, b, c = num(r["p5"]), num(r["p50"]), num(r["p95"])
    if a is not None and c is not None and a < c:
        rep = (True, True, True)
    elif m is not None and sd:
        # a lone printed tail is kept (when it is on the right side of the estimate's mean); only the missing one is estimated
        ka, kc = a is not None and a < m + Z95 * sd, c is not None and c > m - Z95 * sd
        ea, ec, em = estimated_tails(m, sd)
        a, c, rep = (a if ka else ea), (c if kc else ec), (ka, em is None and True, kc)
        if em is not None and b is None:
            b = em
    else:
        return None
    if b is None or not a <= b <= c:
        b, rep = (m if m is not None and a <= m <= c else (a + c) / 2), (rep[0], False, rep[2])
    return a, min(max(b, a + 1e-9), c - 1e-9), c, rep


def basis_of(flags):
    """'reported' when every percentile of every row was printed, 'estimated' when none was, else 'mixed'."""
    flat = [f for fl in flags for f in fl]
    return "reported" if all(flat) else "estimated" if not any(flat) else "mixed"


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
        groups[(r["country"], r["service_role"], r["sex"], r["measure_key"])].append(r)
    out = []
    for (country, role, sex, key), rs in groups.items():
        # Low-reliability rows are left out when the group has better ones, so they neither drag the grade down nor
        # (rows with a mean only) block the percentiles of the whole group.
        dropped = sum(r["reliability"] == "low" for r in rs)
        if 0 < dropped < len(rs):
            rs = [r for r in rs if r["reliability"] != "low"]
        else:
            dropped = 0
        # A survey that prints one measure under two spellings counts once: keep its best row (grade, printed percentiles, n).
        best = {}
        for r in rs:
            d = row_dist(r)
            score = (-REL_RANK[r["reliability"]], sum(d[3]) if d else -1, num(r["n"]) or 0)
            if r["survey_group"] not in best or score > best[r["survey_group"]][0]:
                best[r["survey_group"]] = (score, r)
        rs = [r for _, r in best.values()]
        # 'other:' measures are printed under several spellings; label the group with an English one from the largest sample.
        olabel = min(rs, key=lambda r: (not r["measure_label"].isascii(), -(num(r["n"]) or 0)))["measure_label"]
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
            basis = basis_of([d[3] for d in dists])
            estimated = " ".join(p for i, p in enumerate(("p5", "p50", "p95")) if not all(d[3][i] for d in dists))
        else:
            p5 = p50 = p95 = None
            basis = estimated = ""
        off = [r for r in rs if r["official_doc"]]
        grade, why = reliability({source_tier(r) for r in rs}, basis, N)
        if dropped:
            why = "; ".join(filter(None, [why, f"excludes {dropped} low-reliability source row{'s' if dropped > 1 else ''}"]))
        out.append({
            "reliability": grade, "reliability_note": why,
            "official_docs": "; ".join(sorted({r["official_doc"] for r in off})),
            "official_share": round(sum(num(r["n"]) for r in off) / N, 2),
            "country": country, "service_role": role, "sex": sex, "measure_key": key,
            "measure_label": olabel if key.startswith("other:") else labels[key],
            "n_total": int(N), "mean": round(M, 2), "sd": round(sd, 2) if sd is not None else "",
            "p5": round(p5, 2) if p5 is not None else "", "p50": round(p50, 2) if p50 is not None else "",
            "p95": round(p95, 2) if p95 is not None else "", "pct_basis": basis, "pct_estimated": estimated,
            "n_surveys": len({r["survey_group"] for r in rs}), "mean_min": round(min(ms), 2), "mean_max": round(max(ms), 2),
            "year_min": min(years) if years else "", "year_max": max(years) if years else "",
            "sources": "; ".join(sorted({r["source_id"] for r in rs})),
            "survey_groups": json.dumps(sorted({r["survey_group"] for r in rs}), ensure_ascii=False)})
    out.sort(key=lambda r: (r["country"], r["service_role"], r["sex"], r["measure_key"]))
    return out


def main():
    rows = computed_rows() + paper_rows()
    mark_primary(rows)
    mark_official(rows)
    mark_reliability(rows)
    with open(AGG / "aggregates.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    roll = rollup(rows)
    fields = ["country", "service_role", "sex", "measure_key", "measure_label", "n_total", "mean", "sd", "p5", "p50", "p95", "pct_basis", "pct_estimated", "reliability", "reliability_note", "official_docs", "official_share", "n_surveys",
              "mean_min", "mean_max", "year_min", "year_max", "sources", "survey_groups"]
    with open(AGG / "rollup.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(roll)
    prim = sum(r["is_primary"] for r in rows)
    print(f"aggregates.csv: {len(rows)} rows ({prim} primary) from {len({r['source_id'] for r in rows})} sources; "
          f"rollup.csv: {len(roll)} rows over {len({r['country'] for r in roll})} countries")


if __name__ == "__main__":
    main()
