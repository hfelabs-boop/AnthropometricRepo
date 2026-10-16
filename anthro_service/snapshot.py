"""Static read-only copy of the API: plain JSON and CSV files, one per population.

The website build (scripts/build_site.py) writes it to public/api/v1/, so the Vercel deployment answers
    /api/v1/index.json
    /api/v1/populations/{country}/{role}/{sex}.json|csv      P5, P50, P95 of every measure, all reliability levels, all surveys combined
    /api/v1/populations/{country}/{role}/{sex}.latest.json|csv   the same for the most recent survey alone (only where the combined values span more than 15 years)
    /api/v1/mannequin/{country}/{role}/{sex}.json            P5, P50, P95 boundary dimension sets (high and medium reliability): values, units,
                                                              basis, caution flags, and per dimension sample size, years and sources
without a server. Uses only the standard library. The population files are the live API's answer for P5/P50/P95 at every reliability
level; the mannequin file is the live /v1/mannequin answer reorganised to one file per population (see the README). Other percentiles,
filters and XML need the live service.

Usage: python -m anthro_service snapshot [--out DIR]
"""
from __future__ import annotations

import json
from pathlib import Path

from .core import ApiError, Repo, VERSION, get_repo
from .formats import design_csv

PERCENTILES = (5, 50, 95)
BASE = "api/v1"


def _dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def _write_csv(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:  # to_csv already ends rows with CRLF
        f.write(text)


def _write_population(repo: Repo, root: Path, c: dict, r: dict, sex: str, survey: str | None, suffix: str) -> dict | None:
    """Write the design-values (JSON, CSV) and mannequin files of one population; `survey` None = combined, 'latest' = the most recent survey."""
    try:
        values = repo.design_values(c["id"], r["id"], sex, percentiles=list(PERCENTILES), min_reliability="low", survey=survey)
    except ApiError:
        return None
    rel = f"populations/{c['id']}/{r['id']}/{sex}{suffix}"
    _dump(root / f"{rel}.json", values)
    _write_csv(root / f"{rel}.csv", design_csv(values))
    boundary, dims = {}, {}
    for p in PERCENTILES:
        try:
            m = repo.mannequin(c["id"], r["id"], sex, p, survey=survey)
        except ApiError:
            continue
        for d in m["dimensions"]:  # what does not depend on the percentile is written once per file
            dims.setdefault(d["key"], {k: d[k] for k in ("name", "category", "unit", "n", "reliability", "years", "sources", "n_surveys", "survey_spread_pct")})
        boundary[f"p{p}"] = {"core": m["core"], "values": m["values"], "basis": {d["key"]: d["basis"] for d in m["dimensions"]}, "caution": m["caution"],
                             "count": m["count"], "unavailable": m["unavailable"]}
    mannequin = {"population": values["population"], "min_reliability": "medium", "units": {k: d["unit"] for k, d in dims.items()}, "dimensions": dims, "percentiles": boundary,
                 "notes": values["notes"] + ["Each dimension is the stated percentile of that dimension alone: a boundary case, not a typical body."]}
    mrel = f"mannequin/{c['id']}/{r['id']}/{sex}{suffix}"
    _dump(root / f"{mrel}.json", mannequin)
    return {"values": values, "values_json": f"/{BASE}/{rel}.json", "values_csv": f"/{BASE}/{rel}.csv", "mannequin_json": f"/{BASE}/{mrel}.json"}


def build(out: str | Path, repo: Repo | None = None) -> dict:
    """Write the snapshot under <out>/api/v1/ and return {files, bytes, populations}."""
    repo = repo or get_repo()
    root = Path(out) / BASE
    files = 0
    populations = []
    for c in repo.countries():
        for r in c["roles"]:
            for sex in r["sexes"]:
                combined = _write_population(repo, root, c, r, sex, None, "")
                if combined is None:
                    continue
                files += 3
                entry = {"country": c["name"], "country_id": c["id"], "role": r["name"], "role_id": r["id"], "sex": sex, "measures": combined["values"]["count"],
                         "values_json": combined["values_json"], "values_csv": combined["values_csv"], "mannequin_json": combined["mannequin_json"],
                         "latest_survey": None}
                years = combined["values"]["population"]["years"]
                if years and years[1] - years[0] > 15:  # the combined values mix decades: also offer the most recent survey alone
                    latest = _write_population(repo, root, c, r, sex, "latest", ".latest")
                    if latest:
                        files += 3
                        entry.update({"latest_survey": latest["values"]["population"]["survey"], "latest_values_json": latest["values_json"], "latest_values_csv": latest["values_csv"],
                                      "latest_mannequin_json": latest["mannequin_json"]})
                populations.append(entry)

    meta = repo.meta()
    _dump(root / "meta.json", meta)
    _dump(root / "countries.json", repo.countries())
    _dump(root / "categories.json", repo.categories())
    _dump(root / "measures.json", repo.measures(limit=None))
    index = {
        "name": "Military anthropometry: read-only data files",
        "version": VERSION,
        "description": "Static copy of the anthropometry API. Percentiles of body measures by country, role and sex, with reliability and sources. "
                       "Lengths in mm, mass in kg. Filter by the 'reliability' field of each measure (high, medium, low).",
        "files": {"meta": f"/{BASE}/meta.json", "countries": f"/{BASE}/countries.json", "measures": f"/{BASE}/measures.json", "categories": f"/{BASE}/categories.json"},
        "populations": populations,
        "live_api": "Other percentiles, filters, XML and an OpenAPI description need the live service: python -m anthro_service serve",
        "attribution": meta.get("attribution"),
        "disclaimer": meta.get("disclaimer"),
    }
    _dump(root / "index.json", index)
    files += 5
    size = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())
    return {"files": files, "bytes": size, "populations": len(populations)}


def main(argv: list | None = None) -> None:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="public", help="directory that receives api/v1/ (default: public)")
    a = ap.parse_args(argv)
    r = build(a.out)
    print(f"wrote {r['files']} files for {r['populations']} populations ({r['bytes'] / 1e6:.1f} MB) to {Path(a.out) / BASE}")


if __name__ == "__main__":
    main()
