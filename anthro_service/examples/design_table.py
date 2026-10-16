#!/usr/bin/env python3
"""Write a design table (parameter, unit, P5, P50, P95) for CATIA / Excel / any tool that imports CSV.

Works with the live API or with the static files of the website (no server to run):

    python design_table.py --base http://127.0.0.1:8000 --country "United States" --role Army --sex M --out army_men.csv
    python design_table.py --base https://YOUR-SITE.vercel.app/api/v1 --country united-states --role army --sex M

The CSV has one row per dimension. `parameter` is the measure key; map it to the variable names of your tool in the
`MAPPING` dictionary below (left as an example: edit it for your manikin model).
"""
import argparse
import csv
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

# measure key -> the name your manikin / parameter set uses. Keys you do not list keep their own name.
MAPPING = {"stature": "Stature", "mass": "BodyMass", "sitting_height": "SittingHeight", "buttock_knee_length": "ButtockKneeLength"}
RANK = {"high": 0, "medium": 1, "low": 2}


def fetch(base: str, country: str, role: str, sex: str, measures: str | None, min_reliability: str) -> dict:
    q = urllib.parse.quote
    if base.rstrip("/").endswith("/api/v1"):  # static files: all reliability levels, filtered below
        url = f"{base.rstrip('/')}/populations/{q(country)}/{q(role)}/{q(sex)}.json"
    else:  # live API
        params = {"percentiles": "5,50,95", "min_reliability": min_reliability, **({"measures": measures} if measures else {})}
        url = f"{base.rstrip('/')}/v1/populations/{q(country)}/{q(role)}/{q(sex)}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} for {url}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--country", default="United States")
    ap.add_argument("--role", default="Army")
    ap.add_argument("--sex", default="M")
    ap.add_argument("--measures", help="comma-separated keys; default: every measure with data")
    ap.add_argument("--min-reliability", default="medium", choices=["high", "medium", "low"])
    ap.add_argument("--out", default="-")
    a = ap.parse_args()

    d = fetch(a.base, a.country, a.role, a.sex, a.measures, a.min_reliability)
    want = set(a.measures.split(",")) if a.measures else None
    rows = [m for m in d["measures"] if RANK[m["reliability"]] <= RANK[a.min_reliability] and (want is None or m["key"] in want)]
    f = sys.stdout if a.out == "-" else open(a.out, "w", newline="", encoding="utf-8")
    w = csv.writer(f)
    w.writerow(["parameter", "unit", "P5", "P50", "P95", "n", "reliability", "name"])
    for m in rows:
        p = m["percentiles"]
        w.writerow([MAPPING.get(m["key"], m["key"]), m["unit"], p["p5"], p["p50"], p["p95"], m["n"], m["reliability"], m["name"]])
    if f is not sys.stdout:
        f.close()
    print(f"{len(rows)} dimensions for {d['population']['country']} / {d['population']['role']} / {d['population']['sex_name']}"
          f" ({d['population']['years'] and '-'.join(map(str, d['population']['years'])) or 'years not stated'})", file=sys.stderr)
    print(d["notes"][0], file=sys.stderr)


if __name__ == "__main__":
    main()
