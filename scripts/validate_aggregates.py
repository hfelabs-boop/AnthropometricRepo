#!/usr/bin/env python3
"""Validate aggregates/raw/*.csv against aggregates/SPEC.md.

Checks the header, controlled vocabularies, numeric ranges, and that each row's mean lies in
a plausible range for its measure (taken from the individual-level data in database/anthro.sqlite
when that file exists). Exit status 1 if any row fails.

Usage: python scripts/validate_aggregates.py [file.csv ...]
"""
import csv
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLUMNS = ["source_id", "source_file", "page", "population", "country", "population_type", "service_role", "sex",
           "year_start", "measure_key", "measure_label", "unit_original", "mean", "sd", "n", "p5", "p50", "p95",
           "quality", "notes"]
ROLES = {"Army", "Navy", "Marine Corps", "Air Force", "Tri-service", "Aircrew", "Pilots", "Navigators", "Officers",
         "Enlisted", "Recruits/trainees", "Nurses", "Cadets", "Cadre/other military", "Civilian"}


def keys_and_ranges():
    known = {r["key"] for r in csv.DictReader(open(ROOT / "database/harmonized_measures.csv", encoding="utf-8"))}
    ranges = {}
    db = ROOT / "database" / "anthro.sqlite"
    if db.exists():
        con = sqlite3.connect(db)
        for k in known:
            lo, hi = con.execute(f"SELECT MIN({k}), MAX({k}) FROM subjects").fetchone()
            if lo is not None:
                ranges[k] = (lo, hi)
    return known, ranges


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def validate(path, known, ranges):
    problems, n_rows = [], 0
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        if rd.fieldnames != COLUMNS:
            return [f"{path.name}: header must be exactly {COLUMNS}, got {rd.fieldnames}"], 0
        for i, r in enumerate(rd, start=2):
            n_rows += 1
            p = lambda msg: problems.append(f"{path.name}:{i}: {msg} [{r['population']} / {r['measure_label']}]")
            if r["sex"] not in {"M", "F", "both"}: p(f"bad sex {r['sex']!r}")
            if r["population_type"] not in {"military", "civilian", "mixed"}: p("bad population_type")
            if r["service_role"] not in ROLES: p(f"bad service_role {r['service_role']!r}")
            if r["quality"] not in {"A", "B", "C"}: p("bad quality")
            if not r["country"]: p("missing country")
            if not r["source_id"] or not r["source_file"]: p("missing source")
            k = r["measure_key"]
            if not (k in known or k.startswith("other:")): p(f"unknown measure_key {k!r}")
            m, sd, n = num(r["mean"]), num(r["sd"]), num(r["n"])
            if m is None: p("mean missing"); continue
            if r["sd"] and (sd is None or sd < 0): p("bad sd")
            if r["n"] and (n is None or n < 1 or n != int(n)): p("bad n")
            if sd is not None and m and k in ranges and sd > abs(m): p("sd larger than mean")
            if k in ranges:
                lo, hi = ranges[k]
                if not (0.55 * lo <= m <= 1.6 * hi): p(f"mean {m} outside plausible range {lo}..{hi} (check units)")
            for c in ("p5", "p50", "p95"):
                if r[c] and num(r[c]) is None: p(f"bad {c}")
            if r["p5"] and r["p95"] and num(r["p5"]) is not None and num(r["p95"]) is not None and num(r["p5"]) > num(r["p95"]): p("p5 > p95")
    return problems, n_rows


def main():
    files = [Path(a) for a in sys.argv[1:]] or sorted((ROOT / "aggregates" / "raw").glob("*.csv"))
    known, ranges = keys_and_ranges()
    bad = 0
    for f in files:
        problems, n = validate(f, known, ranges)
        print(f"{f.name}: {n} rows, {len(problems)} problems")
        for line in problems[:25]:
            print("  " + line)
        if len(problems) > 25:
            print(f"  ... {len(problems) - 25} more")
        bad += len(problems)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
