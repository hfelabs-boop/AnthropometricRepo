#!/usr/bin/env python3
"""Write a design table (parameter, unit, P5, P50, P95) for CATIA / Excel / any tool that imports CSV.

Works with the live API or with the static files of the website (no server to run):

    python design_table.py --base http://127.0.0.1:8000 --country "United States" --role Army --sex M --out army_men.csv
    python design_table.py --base https://YOUR-SITE.vercel.app/api/v1 --country "United States" --role Army --sex M --survey latest

The CSV has one row per dimension. `parameter` is the measure key; map it to the variable names of your tool in the
`MAPPING` dictionary below (left as an example: edit it for your manikin model).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# measure key -> the name your manikin / parameter set uses. Keys you do not list keep their own name.
MAPPING = {"stature": "Stature", "mass": "BodyMass", "sitting_height": "SittingHeight", "buttock_knee_length": "ButtockKneeLength"}
RANK = {"high": 0, "medium": 1, "low": 2}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fetch(base: str, country: str, role: str, sex: str, measures: str | None, min_reliability: str, survey: str | None) -> dict:
    """Live API: /v1/design-values (names or ids, any characters). Static files: /populations/{id}/{id}/{sex}[.latest].json (ids only)."""
    if base.rstrip("/").endswith("/api/v1"):  # static files: all reliability levels, filtered by the caller
        if survey not in (None, "latest"):
            sys.exit("The static files hold the combined values and the latest survey only; use the live API for other surveys.")
        url = f"{base.rstrip('/')}/populations/{slug(country)}/{slug(role)}/{sex.upper() if sex.upper() in ('M', 'F') else 'both'}{'.latest' if survey else ''}.json"
    else:  # live API
        params = {"country": country, "role": role, "sex": sex, "percentiles": "5,50,95", "min_reliability": min_reliability}
        if measures:
            params["measures"] = measures
        if survey:
            params["survey"] = survey
        url = f"{base.rstrip('/')}/v1/design-values?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
        except ValueError:
            err = {}
        sys.exit(f"HTTP {e.code} for {url}\n{err.get('message', '')} {err.get('hint', '')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--country", default="United States")
    ap.add_argument("--role", default="Army")
    ap.add_argument("--sex", default="M")
    ap.add_argument("--measures", help="comma-separated keys; default: every measure with data")
    ap.add_argument("--min-reliability", default="medium", choices=["high", "medium", "low"])
    ap.add_argument("--survey", help="'latest' = the most recent survey only (live API: or any survey id); default: all surveys combined")
    ap.add_argument("--out", default="-")
    a = ap.parse_args()

    d = fetch(a.base, a.country, a.role, a.sex, a.measures, a.min_reliability, a.survey)
    want = set(a.measures.split(",")) if a.measures else None
    rows = [m for m in d["measures"] if RANK[m["reliability"]] <= RANK[a.min_reliability] and (want is None or m["key"] in want)]
    f = sys.stdout if a.out == "-" else open(a.out, "w", newline="", encoding="utf-8")
    w = csv.writer(f)
    w.writerow(["parameter", "unit", "P5", "P50", "P95", "n", "reliability", "basis", "year_min", "year_max", "name"])
    for m in rows:
        p = m["percentiles"]
        y = m["years"] or ["", ""]
        w.writerow([MAPPING.get(m["key"], m["key"]), m["unit"], p["p5"], p["p50"], p["p95"], m["n"], m["reliability"], m["percentile_basis"]["p50"], y[0], y[1], m["name"]])
    if f is not sys.stdout:
        f.close()
    print(f"{len(rows)} dimensions for {d['population']['country']} / {d['population']['role']} / {d['population']['sex_name']}"
          f" ({d['population']['years'] and '-'.join(map(str, d['population']['years'])) or 'years not stated'})", file=sys.stderr)
    print("\n".join(d["notes"]), file=sys.stderr)


if __name__ == "__main__":
    main()
