#!/usr/bin/env python3
"""Build database/anthro.sqlite: one SQLite database holding the catalog and all open data.

Tables
  surveys          the 49 catalog entries (flattened from catalog/surveys.json)
  survey_links     every report/data link, one row per link
  datasets         the four open datasets and their provenance
  measures         harmonized measures: label, unit, category, source column per dataset
  subjects         one row per person across all datasets, harmonized measures in
                   common units (mm, kg, years), plus sex, branch and handedness
  raw_ansur_1988, raw_ansur_ii_2012, raw_asran_2015, raw_usaf_1967
                   the original columns, unchanged, keyed by subject_key
  raw_columns      description of every raw column

Harmonization is by dimension name. Measuring methods differ between surveys (landmark
definitions, and ASRAN's scan-extracted "Digital Measure" values), so compare means
across surveys with care. See database/harmonized_measures.csv.

Uses only the standard library.
Usage: python scripts/build_database.py [output-path]
"""
import csv
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DEFAULT_OUT = ROOT / "database" / "anthro.sqlite"
LB = 0.45359237

# dataset id -> list of (csv path, encoding, sex or None when a column holds it)
SOURCES = {
    "ansur_1988": [(DATA / "ansur-1988/ansurMen.csv", "utf-8-sig", "M"),
                   (DATA / "ansur-1988/ansurWomen.csv", "utf-8-sig", "F")],
    "ansur_ii_2012": [(DATA / "ansur-ii-2012/ANSUR_II_MALE_Public.csv", "latin-1", "M"),
                      (DATA / "ansur-ii-2012/ANSUR_II_FEMALE_Public.csv", "latin-1", "F")],
    "asran_2015": [(DATA / "asran-2015/ASRAN_2015_male.csv", "utf-8", "M"),
                   (DATA / "asran-2015/ASRAN_2015_female.csv", "utf-8", "F")],
    "usaf_1967": [(DATA / "usaf-1967/USAF1967.csv", "utf-8", "M")],
}
ID_COLUMN = {"ansur_1988": "SUBJECT_NUMBER", "ansur_ii_2012": "subjectid",
             "asran_2015": "Random ID", "usaf_1967": "V1_SUBJECT NUMBER"}
DATASETS = [
    # id, survey_id, name, country, branch, year_start, licence, source_url
    ("ansur_1988", "ansur-1988", "ANSUR 1988 (US Army)", "United States", "Army", 1987,
     "Public domain (US Government)", "https://www.openlab.psu.edu/ansur/"),
    ("ansur_ii_2012", "ansur-ii-2012", "ANSUR II 2012 (US Army)", "United States", "Army", 2010,
     "Public domain (US Government)", "https://www.openlab.psu.edu/ansur2/"),
    ("asran_2015", "asran-2015", "ASRAN 2015 (Royal Australian Navy)", "Australia", "Navy", 2015,
     "CC BY 3.0 AU", "https://data.gov.au/data/dataset/3e124b9c-4daa-4797-a265-ddbc5f36313c"),
    ("usaf_1967", "usaf-1967", "USAF 1967 (US Air Force flying personnel)", "United States",
     "Air Force", 1967, "US Government data", "https://cran.r-project.org/package=Anthropometry"),
]
# (measure key, dataset) -> multiplier from source units to harmonized units
SCALE = {("mass", "ansur_1988"): 0.1, ("mass", "ansur_ii_2012"): 0.1, ("mass", "usaf_1967"): LB,
         ("age", "usaf_1967"): 0.1, ("interpupillary_breadth", "ansur_ii_2012"): 0.1}
USAF_HANDEDNESS = {"1": "Right", "2": "Left", "3": "Ambidextrous"}


def num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x:  # NaN
        return None
    return int(x) if x.is_integer() else x  # integers store far smaller in SQLite


def read_rows(path, enc):
    with open(path, newline="", encoding=enc) as f:
        return list(csv.DictReader(f))


def load_csv_table(db, name, path, types, indexes=()):
    """Create table `name` from a CSV, converting the listed numeric columns."""
    rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
    cols = list(rows[0].keys()) if rows else []
    if not cols:
        return 0
    db.execute(f"CREATE TABLE {name} (" + ", ".join(f'"{c}" {types.get(c, "TEXT")}' for c in cols) + ")")
    conv = lambda c, v: (None if v == "" else (float(v) if types.get(c) == "REAL" else int(float(v)) if types.get(c) == "INTEGER" else v))
    db.executemany(f"INSERT INTO {name} VALUES ({','.join('?' * len(cols))})", [[conv(c, r[c]) for c in cols] for r in rows])
    for ix in indexes:
        db.execute(f"CREATE INDEX {name}_{ix.replace(',', '_')} ON {name}({ix})")
    return len(rows)


def load_extra_tables(db):
    """Aggregates extracted from papers, their rollup by country/role, and the paper index (if built)."""
    agg = ROOT / "aggregates"
    real = dict.fromkeys(["mean", "sd", "p5", "p50", "p95", "mean_min", "mean_max"], "REAL")
    ints = dict.fromkeys(["page", "year_start", "n", "is_primary", "n_total", "n_surveys", "year_min", "year_max", "pages", "aggregate_rows"], "INTEGER")
    if (agg / "aggregates.csv").exists():
        load_csv_table(db, "aggregates", agg / "aggregates.csv", {**real, **ints}, ["country,service_role", "measure_key", "source_id"])
        load_csv_table(db, "rollup", agg / "rollup.csv", {**real, **ints}, ["country,service_role", "measure_key"])
    if (ROOT / "catalog" / "papers.csv").exists():
        load_csv_table(db, "papers", ROOT / "catalog" / "papers.csv", {**ints, "size_mb": "REAL"})


def build(out):
    measures = list(csv.DictReader(open(ROOT / "database/harmonized_measures.csv", encoding="utf-8")))
    mkeys = [m["key"] for m in measures]
    catalog = json.loads((ROOT / "catalog/surveys.json").read_text(encoding="utf-8"))

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    db = sqlite3.connect(out)
    db.execute("PRAGMA page_size = 4096")

    # --- catalog ---------------------------------------------------------------
    db.execute("""CREATE TABLE surveys (id TEXT PRIMARY KEY, row INTEGER, region TEXT, country TEXT,
        service TEXT, sexes TEXT, year_start INTEGER, n_total INTEGER, entry TEXT, measured TEXT,
        published TEXT, sample TEXT, dimensions TEXT, data_access TEXT, report_access TEXT,
        licence TEXT, verification TEXT, citations TEXT, notes TEXT)""")
    db.execute("CREATE TABLE survey_links (survey_id TEXT, kind TEXT, label TEXT, url TEXT, local_path TEXT)")
    for s in catalog["surveys"]:
        db.execute("INSERT INTO surveys VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            s["id"], s["row"], s["region"], s.get("country"), s.get("service"), s.get("sexes"),
            s.get("year_start"), s.get("n_total"), s["entry"], s.get("measured"), s.get("published"),
            s.get("sample"), s.get("dimensions"), s["data_access"], s["report_access"], s.get("licence"),
            s["verification"], "\n".join(s["citations"]), s.get("notes")))
        for r in s.get("reports", []):
            db.execute("INSERT INTO survey_links VALUES (?,?,?,?,?)", (s["id"], "report", r["label"], r["url"], None))
        for d in s.get("data", []):
            db.execute("INSERT INTO survey_links VALUES (?,?,?,?,?)",
                       (s["id"], "data", d["label"], d.get("url"), d.get("local")))

    # --- measures ----------------------------------------------------------------
    ds_ids = [d[0] for d in DATASETS]
    db.execute("CREATE TABLE measures (key TEXT PRIMARY KEY, label TEXT, category TEXT, unit TEXT, note TEXT, "
               + ", ".join(f"src_{d} TEXT" for d in ds_ids) + ", sort INTEGER)")
    for i, m in enumerate(measures):
        db.execute(f"INSERT INTO measures VALUES ({','.join('?' * (6 + len(ds_ids)))})",
                   (m["key"], m["label"], m["category"], m["unit"], m["note"] or None,
                    *[m[d] or None for d in ds_ids], i))

    # --- subjects + raw tables ---------------------------------------------------------
    db.execute("CREATE TABLE subjects (subject_key INTEGER PRIMARY KEY, dataset TEXT NOT NULL, "
               "source_id TEXT, sex TEXT, branch TEXT, component TEXT, handedness TEXT, "
               + ", ".join(f"{k} REAL" for k in mkeys) + ")")
    db.execute("CREATE TABLE raw_columns (dataset TEXT, column_name TEXT, description TEXT)")
    db.execute("CREATE TABLE datasets (id TEXT PRIMARY KEY, survey_id TEXT, name TEXT, country TEXT, "
               "branch TEXT, year_start INTEGER, licence TEXT, source_url TEXT, n_subjects INTEGER, "
               "n_men INTEGER, n_women INTEGER, raw_table TEXT)")

    usaf_desc = {r["r_column"]: r for r in read_rows(DATA / "usaf-1967/USAF1967_variables.csv", "utf-8")}
    key = 0
    for ds_id, survey_id, name, country, branch, year, licence, url in DATASETS:
        rows = []
        for path, enc, sex in SOURCES[ds_id]:
            for r in read_rows(path, enc):
                if "SubjectId" in r:  # ANSUR II female file capitalizes the id column
                    r = {("subjectid" if k == "SubjectId" else k): v for k, v in r.items()}
                rows.append((sex, r))
        # raw table: all original columns, in order, plus sex for datasets split by file
        cols = list(rows[0][1].keys())
        raw = f"raw_{ds_id}"
        db.execute(f'CREATE TABLE {raw} (subject_key INTEGER PRIMARY KEY, sex TEXT, '
                   + ", ".join(f'"{c}"' for c in cols) + ")")
        for c in cols:
            desc = None
            if ds_id == "usaf_1967":
                v = usaf_desc.get(c.split("_", 1)[0])
                if v:
                    desc = v["variable_name"] + (" (exclude from analysis per HSIAC)" if v["documented"] != "yes" else "")
            db.execute("INSERT INTO raw_columns VALUES (?,?,?)", (ds_id, c, desc))
        src = {m["key"]: m[ds_id] for m in measures}
        n_m = n_f = 0
        for sex, r in rows:
            key += 1
            if ds_id == "ansur_ii_2012":
                sex = {"Male": "M", "Female": "F"}.get(r.get("Gender"), sex)
            n_m += sex == "M"
            n_f += sex == "F"
            vals = {}
            for k in mkeys:
                c = src[k]
                if c:
                    v = num(r.get(c))
                    if v is not None and v <= 0:  # 0 marks missing in these files
                        v = None
                    vals[k] = None if v is None else num(round(v * SCALE.get((k, ds_id), 1), 3))
            if vals.get("mass") and vals.get("stature"):
                vals["bmi"] = round(vals["mass"] / (vals["stature"] / 1000) ** 2, 2)
            b, comp, hand = branch, None, None
            if ds_id == "ansur_ii_2012":
                b = (r.get("Branch") or branch).replace("Combat Service Support", "Army (Combat Service Support)") \
                    .replace("Combat Support", "Army (Combat Support)").replace("Combat Arms", "Army (Combat Arms)")
                comp = r.get("Component")
                hand = (r.get("WritingPreference") or "").replace(" hand", "").strip() or None
            elif ds_id == "usaf_1967":
                hand = USAF_HANDEDNESS.get(r.get("V199_HANDEDNESS"))
            db.execute(f"INSERT INTO subjects VALUES ({','.join('?' * (7 + len(mkeys)))})",
                       (key, ds_id, r[ID_COLUMN[ds_id]], sex, b, comp, hand, *[vals.get(k) for k in mkeys]))
            db.execute(f"INSERT INTO {raw} VALUES ({','.join('?' * (2 + len(cols)))})",
                       (key, sex, *[num(r[c]) if num(r[c]) is not None else (r[c] or None) for c in cols]))
        db.execute("INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (ds_id, survey_id, name, country, branch, year, licence, url, n_m + n_f, n_m, n_f, raw))

    db.execute("CREATE INDEX subjects_dataset_sex ON subjects(dataset, sex)")
    # Convenience view: subjects with the dataset name and year attached.
    db.execute("""CREATE VIEW people AS SELECT d.name AS survey, d.year_start AS survey_year, s.*
                  FROM subjects s JOIN datasets d ON d.id = s.dataset""")
    load_extra_tables(db)
    db.commit()
    db.execute("VACUUM")
    n = db.execute("SELECT COUNT(*) FROM subjects").fetchone()[0]
    db.close()
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: "
          f"{n} subjects, {len(mkeys)} harmonized measures, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    build(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUT)
