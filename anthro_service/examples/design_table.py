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


SEXES = {"m": "M", "male": "M", "men": "M", "man": "M", "f": "F", "female": "F", "women": "F", "woman": "F",
         "both": "both", "mixed": "both", "b": "both", "unknown": "both", "not-stated": "both", "not stated": "both"}


def sex_code(text: str) -> str:
    code = SEXES.get(text.strip().lower())
    if not code:
        sys.exit(f"--sex must be M, F or both (male, female, men and women also work), not '{text}'.")
    return code


def static_url(base: str, country: str, role: str, sex: str, survey: str | None) -> str:
    """Static files are keyed by ids; the combined file always exists, the .latest file only where the combined values span more than 15 years (see index.json)."""
    return f"{base.rstrip('/')}/populations/{slug(country)}/{slug(role)}/{sex}{'.latest' if survey else ''}.json"


def fetch(base: str, country: str, role: str, sex: str, measures: str | None, min_reliability: str, survey: str | None) -> dict:
    """Live API: /v1/design-values (names or ids, any characters). Static files: /populations/{id}/{id}/{sex}[.latest].json (ids only)."""
    if base.rstrip("/").endswith("/api/v1"):  # static files: all reliability levels, filtered by the caller
        if survey not in (None, "latest"):
            sys.exit("The static files hold the combined values and the latest survey only; use the live API for other surveys.")
        url = static_url(base, country, role, sex_code(sex), survey)
    else:  # live API
        params = {"country": country, "role": role, "sex": sex_code(sex), "percentiles": "5,50,95", "min_reliability": min_reliability}
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
        message = f"{err.get('message', '')} {err.get('hint', '')}".strip()
        if not err and "/api/v1" in base:  # a static file that does not exist
            message = ("The static files are keyed by ids (see index.json: lower-case slugs such as united-states / air-force; aliases like UK are not understood there)."
                       + (" The .latest files exist only where the combined values span more than 15 years: drop --survey, or use the live API." if survey else ""))
        sys.exit(f"HTTP {e.code} for {url}\n{message}")
    except (urllib.error.URLError, TimeoutError) as e:  # HTTPError is a URLError: it is handled above
        sys.exit(f"cannot reach {base}: {getattr(e, 'reason', e)}\nStart the server with  python -m anthro_service serve  or check --base.")


def wanted_keys(measures: str, rows: list) -> list:
    """Match --measures entries (keys, names, any case, spaces for underscores) against the rows of a static file; say what matched nothing."""
    index = {}
    for m in rows:
        for alias in (m["key"], m["key"].replace("other:", ""), m["name"]):
            index[re.sub(r"[^a-z0-9]+", "_", alias.lower()).strip("_")] = m["key"]
    keys, missing = [], []
    for entry in (x for x in measures.split(",") if x.strip()):
        key = index.get(re.sub(r"[^a-z0-9]+", "_", entry.lower()).strip("_"))
        (keys if key else missing).append(key or entry.strip())
    if missing:
        print(f"no such measure in this file: {', '.join(missing)}", file=sys.stderr)
        if not keys:
            sys.exit(2)
    return keys


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--country", default="United States")
    ap.add_argument("--role", default="Army")
    ap.add_argument("--sex", default="M")
    ap.add_argument("--measures", help="comma-separated keys or names; default: every measure with data")
    ap.add_argument("--min-reliability", default="medium", choices=["high", "medium", "low"])
    ap.add_argument("--survey", help="'latest' = the most recent survey only (live API: or any survey id); default: all surveys combined")
    ap.add_argument("--out", default="-")
    a = ap.parse_args(argv)

    d = fetch(a.base, a.country, a.role, a.sex, a.measures, a.min_reliability, a.survey)
    static = "/api/v1" in a.base
    rows = [m for m in d["measures"] if RANK[m["reliability"]] <= RANK[a.min_reliability]]  # the live API has already applied --measures
    if static and a.measures:
        keep = set(wanted_keys(a.measures, d["measures"]))
        rows = [m for m in rows if m["key"] in keep]
    f = sys.stdout if a.out == "-" else open(a.out, "w", newline="", encoding="utf-8")
    w = csv.writer(f, lineterminator="\n" if f is sys.stdout else "\r\n")  # a text-mode stdout on Windows would turn \r\n into \r\r\n
    w.writerow(["parameter", "unit", "P5", "P50", "P95", "n", "reliability", "percentile_basis", "year_min", "year_max", "name"])
    for m in rows:
        p = m["percentiles"]
        y = m["years"] or ["", ""]
        w.writerow([MAPPING.get(m["key"], m["key"]), m["unit"], p["p5"], p["p50"], p["p95"], m["n"], m["reliability"], " ".join(f"{k}:{b}" for k, b in m["percentile_basis"].items()), y[0], y[1], m["name"]])
    if f is not sys.stdout:
        f.close()
    print(f"{len(rows)} dimensions for {d['population']['country']} / {d['population']['role']} / {d['population']['sex_name']}"
          f" ({d['population']['years'] and '-'.join(map(str, d['population']['years'])) or 'years not stated'})", file=sys.stderr)
    print("\n".join(d["notes"]), file=sys.stderr)


if __name__ == "__main__":
    main()
