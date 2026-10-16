"""Static read-only copy of the API: plain JSON and CSV files, one per population.

The website build (scripts/build_site.py) writes it to public/api/v1/, so the Vercel deployment answers
    /api/v1/index.json
    /api/v1/populations/{country}/{role}/{sex}.json|csv      P5, P50, P95 of every measure, all reliability levels
    /api/v1/mannequin/{country}/{role}/{sex}.json            P5, P50, P95 boundary dimension sets, high and medium reliability
without a server. Uses only the standard library. The files carry the same fields as the live API; only the
query options (other percentiles, filters, XML) need the live service.

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


def build(out: str | Path, repo: Repo | None = None) -> dict:
    """Write the snapshot under <out>/api/v1/ and return {files, bytes, populations}."""
    repo = repo or get_repo()
    root = Path(out) / BASE
    files = 0
    populations = []
    for c in repo.countries():
        for r in c["roles"]:
            for sex in r["sexes"]:
                try:
                    values = repo.design_values(c["id"], r["id"], sex, percentiles=list(PERCENTILES), min_reliability="low")
                except ApiError:
                    continue
                rel = f"populations/{c['id']}/{r['id']}/{sex}"
                _dump(root / f"{rel}.json", values)
                _write_csv(root / f"{rel}.csv", design_csv(values))
                boundary = {}
                for p in PERCENTILES:
                    try:
                        m = repo.mannequin(c["id"], r["id"], sex, p)
                    except ApiError:
                        continue
                    boundary[f"p{p}"] = {"core": m["core"], "values": m["values"], "count": m["count"]}
                mannequin = {"population": values["population"], "min_reliability": "medium", "units": "millimetres and kilograms unless a measure says otherwise",
                             "percentiles": boundary, "notes": values["notes"][:1] + ["Each dimension is the stated percentile of that dimension alone: a boundary case, not a typical body."]}
                _dump(root / f"mannequin/{c['id']}/{r['id']}/{sex}.json", mannequin)
                files += 3
                populations.append({"country": c["name"], "country_id": c["id"], "role": r["name"], "role_id": r["id"], "sex": sex, "measures": values["count"],
                                    "values_json": f"/{BASE}/{rel}.json", "values_csv": f"/{BASE}/{rel}.csv", "mannequin_json": f"/{BASE}/mannequin/{c['id']}/{r['id']}/{sex}.json"})

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
