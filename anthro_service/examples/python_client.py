#!/usr/bin/env python3
"""Smallest possible client (standard library only): the body dimensions of a boundary manikin.

    python python_client.py                                    # US Army men, P5 / P50 / P95 of the core dimensions
    python python_client.py --country "United States" --role "Air Force" --sex M --measures stature,mass,sitting_height,hand_length
    python python_client.py --survey latest                    # the most recent survey only, instead of all surveys combined
    python python_client.py --base https://YOUR-SITE.vercel.app     # any server running the API

Start a local server first with  python -m anthro_service serve
"""
import argparse
import json
import urllib.error
import urllib.parse
import urllib.request


def get(base: str, path: str, **params):
    url = base.rstrip("/") + path + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        err = json.load(e).get("error", {})
        raise SystemExit(f"{err.get('code', e.code)}: {err.get('message')}  {err.get('hint') or ''}  {err.get('available') or ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--country", default="United States")
    ap.add_argument("--role", default="Army")
    ap.add_argument("--sex", default="M", help="M, F or both")
    ap.add_argument("--measures", default="stature,mass,sitting_height,eye_height_sitting,buttock_knee_length,hand_length")
    ap.add_argument("--min-reliability", default="medium", choices=["high", "medium", "low"])
    ap.add_argument("--survey", help="a survey id from /v1/populations/{country}/{role}/surveys, or 'latest'; default: all surveys combined")
    a = ap.parse_args()

    # one call per percentile gives the flat {key: value} map a manikin needs
    sets = {p: get(a.base, "/v1/mannequin", country=a.country, role=a.role, sex=a.sex, percentile=p, measures=a.measures, min_reliability=a.min_reliability, survey=a.survey) for p in (5, 50, 95)}
    pop = sets[50]["population"]
    used = [pop["survey"]] if pop["survey"] else pop["surveys_combined"]
    print(f"{pop['country']} / {pop['role']} / {pop['sex_name']}  ({', '.join(s['name'] for s in used[:3])}{' ...' if len(used) > 3 else ''}; years {pop['years'] and '-'.join(map(str, pop['years']))})")
    print(f"{'dimension':34}{'unit':>7}{'P5':>10}{'P50':>10}{'P95':>10}  reliability")
    for d in sets[50]["dimensions"]:
        row = [sets[p]["values"].get(d["key"]) for p in (5, 50, 95)]
        print(f"{d['name']:34}{d['unit']:>7}" + "".join(f"{v:>10.1f}" if v is not None else f"{'-':>10}" for v in row) + f"  {d['reliability']}")
    flagged = {k: why for p in (5, 50, 95) for k, why in sets[p]["caution"].items()}
    if flagged:
        print("\nCare: " + "; ".join(f"{k} ({', '.join(why)})" for k, why in flagged.items()))
    print("\n" + "\n".join(sets[50]["notes"]))


if __name__ == "__main__":
    main()
