"""Static read-only copy of the API: plain JSON and CSV files, one per population.

The website build (scripts/build_site.py) writes it to public/api/v1/, so the Vercel deployment answers
    /api/v1/index.json
    /api/v1/populations/{country}/{role}/{sex}.json|csv      P5, P50, P95 of every measure, all reliability levels, all surveys combined
    /api/v1/populations/{country}/{role}/{sex}.latest.json|csv   the same for the most recent survey alone (only where the combined values span more than 15 years)
    /api/v1/mannequin/{country}/{role}/{sex}.json            P5, P50, P95 boundary dimension sets (high and medium reliability; absent when there are none): values, units,
                                                              basis, caution flags, and per dimension sample size, years and sources
without a server. Uses only the standard library. The population files are the live API's answer for P5/P50/P95 at every reliability
level; the mannequin file is the live /v1/mannequin answer reorganised to one file per population (see the README). Other percentiles,
filters and XML need the live service.

Usage: python -m anthro_service snapshot [--out DIR]
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from .core import ApiError, Repo, VERSION, VINTAGE_YEARS, get_repo
from .formats import design_csv

PERCENTILES = (5, 50, 95)
BASE = "api/v1"


STATIC_SENTENCE = ("The static files hold the combined values and, where the combined values span many years, the latest survey (the .latest files); the populations files hold every "
                   "reliability level; other surveys and other percentiles need the live API.")


def static_note(note: str, in_latest_file: bool, has_latest: bool) -> str:
    """The live notes tell the reader to pass survey=latest or a survey id, or min_reliability=low; a static reader can only fetch another file."""
    ref, Ref = ("this file", "This file") if in_latest_file else ("the .latest file", "The .latest file") if has_latest else ("the live API (survey=latest)", "The live API (survey=latest)")
    note = re.sub(r"for current personnel use survey=latest \(now ('[^']*'(?:, \d{4})?)\) or choose a survey from the survey list\.", rf"for current personnel use {ref} (now \1).", note)
    note = re.sub(r"survey=latest gives ('[^']*'(?:, \d{4})?), because (.*?); request that survey by id \([^)]*\) for the measures it has\.",
                  rf"{Ref} is \1, because \2; that newer survey is only available from the live API.", note)
    note = re.sub(r"and is not used by survey=latest; request it by id \([^)]*\) for the measures it has\.", "and is not used here; it is only available from the live API.", note)
    note = note.replace("survey=latest has ", "This latest-survey file has " if in_latest_file else "The latest survey has ")
    note = re.sub(r"; set min_reliability=low to include them\.", "; every reliability level is in the populations file of this population.", note)
    note = re.sub(r"\(min_reliability=low shows it\)", "(the populations file of this population has every reliability level)", note)
    return note.replace("(see 'caution')", "(see 'caution' under each percentile)")


def static_caution(text: str, in_latest_file: bool, has_latest: bool) -> str:
    """Caution reasons end in '; see survey=latest)': a static reader is pointed to the .latest file when there is one, and to nothing otherwise."""
    if in_latest_file or not has_latest:
        return text.replace("; see survey=latest)", ")")
    return text.replace("; see survey=latest)", "; see the .latest file)")


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
    pspan = values["population"]["years"] or [0, 0]
    values = {**values, "notes": [static_note(n, bool(survey), pspan[1] - pspan[0] > VINTAGE_YEARS) for n in values["notes"]] + [STATIC_SENTENCE]}
    rel = f"populations/{c['id']}/{r['id']}/{sex}{suffix}"
    _dump(root / f"{rel}.json", values)
    _write_csv(root / f"{rel}.csv", design_csv(values))
    boundary, dims, answers = {}, {}, {}
    pop_years = values["population"]["years"] or [0, 0]
    spread_years = pop_years[1] - pop_years[0]
    for p in PERCENTILES:
        try:
            m = repo.mannequin(c["id"], r["id"], sex, p, survey=survey)
        except ApiError:
            continue
        answers[p] = m
        for d in m["dimensions"]:  # what does not depend on the percentile is written once per file
            dims.setdefault(d["key"], {k: d[k] for k in ("name", "category", "unit", "n", "reliability", "years", "sources", "n_surveys", "survey_spread_pct")})
        boundary[f"p{p}"] = {"core": m["core"], "values": m["values"], "basis": {d["key"]: d["basis"] for d in m["dimensions"]}, "caution": {k: [static_caution(w, bool(survey), spread_years > VINTAGE_YEARS) for w in why] for k, why in m["caution"].items()},
                             "count": m["count"], "unavailable": m["unavailable"]}
    result = {"values": values, "values_json": f"/{BASE}/{rel}.json", "values_csv": f"/{BASE}/{rel}.csv", "mannequin_json": None}
    if not dims:  # nothing at high or medium reliability: no file rather than an empty one (the design-values file still has everything)
        return result
    p50 = answers.get(50) or next(iter(answers.values()))
    span = p50["population"]["years"] or [0, 0]
    notes = [static_note(n, bool(survey), span[1] - span[0] > VINTAGE_YEARS) for n in p50["notes"] if not n.startswith(("Percentile 50 of each", "Every dimension is percentile"))]
    mannequin = {"population": p50["population"], "min_reliability": "medium", "hidden_by_reliability": p50["hidden_by_reliability"],
                 "units": {k: d["unit"] for k, d in dims.items()}, "dimensions": dims, "percentiles": boundary,
                 "notes": notes + ["Each dimension is the stated percentile of that dimension alone: a boundary case, not a typical body.", STATIC_SENTENCE]}
    mrel = f"mannequin/{c['id']}/{r['id']}/{sex}{suffix}"
    _dump(root / f"{mrel}.json", mannequin)
    result["mannequin_json"] = f"/{BASE}/{mrel}.json"
    return result


def build(out: str | Path, repo: Repo | None = None) -> dict:
    """Write the snapshot under <out>/api/v1/ and return {files, bytes, populations}."""
    repo = repo or get_repo()
    root = Path(out) / BASE
    shutil.rmtree(root, ignore_errors=True)  # only <out>/api/v1: a re-run must not leave files of an older layout behind
    files = 0
    populations = []
    for c in repo.countries():
        for r in c["roles"]:
            for sex in r["sexes"]:
                combined = _write_population(repo, root, c, r, sex, None, "")
                if combined is None:
                    continue
                files += 2 + bool(combined["mannequin_json"])
                entry = {"country": c["name"], "country_id": c["id"], "role": r["name"], "role_id": r["id"], "sex": sex, "measures": combined["values"]["count"],
                         "values_json": combined["values_json"], "values_csv": combined["values_csv"], "mannequin_json": combined["mannequin_json"],
                         "latest_survey": None}
                years = combined["values"]["population"]["years"]
                if years and years[1] - years[0] > VINTAGE_YEARS:  # the combined values mix decades: also offer the most recent survey alone
                    latest = _write_population(repo, root, c, r, sex, "latest", ".latest")
                    if latest:
                        files += 2 + bool(latest["mannequin_json"])
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
