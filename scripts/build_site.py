#!/usr/bin/env python3
"""Build the static website into public/ (used by the Vercel deployment).

public/ contains:
  index.html, styles.css, js/   the single-page app (copied from site/)
  db/anthro.sqlite.gz           the SQLite database, gzip-compressed; the browser
                                decompresses it and queries it with sql.js
  catalog/                      surveys.json (read by the app) and CSV/JSON downloads
  data/                         the original open datasets, for direct download
  standards/mil-std-1472h/      the MIL-STD-1472H requirements the site can check (requirements.json / .csv)
  api/v1/                       read-only JSON/CSV copy of the API (anthro_service/snapshot.py): percentiles
                                per country, role and sex, for CAD / digital-human tools and scripts

Uses only the standard library, so the Vercel build needs no pip install.
Usage: python scripts/build_site.py
"""
import gzip
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public"


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "site", OUT)

    db = ROOT / "database" / "anthro.sqlite"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_database.py"), str(db)], check=True)
    (OUT / "db").mkdir()
    with open(db, "rb") as src, open(OUT / "db" / "anthro.sqlite.gz", "wb") as raw, \
            gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as dst:
        shutil.copyfileobj(src, dst)

    (OUT / "catalog").mkdir()
    for name in ("surveys.csv", "surveys.json", "additional_reports.csv", "link_status.csv", "papers.csv", "papers.json"):
        shutil.copy(ROOT / "catalog" / name, OUT / "catalog" / name)
    (OUT / "aggregates").mkdir()
    for name in ("aggregates.csv", "rollup.csv", "SPEC.md"):
        shutil.copy(ROOT / "aggregates" / name, OUT / "aggregates" / name)
    shutil.copytree(ROOT / "data", OUT / "data")
    (OUT / "standards" / "mil-std-1472h").mkdir(parents=True)
    for name in ("requirements.json", "requirements.csv"):
        shutil.copy(ROOT / "standards" / "mil-std-1472h" / name, OUT / "standards" / "mil-std-1472h" / name)

    sys.path.insert(0, str(ROOT))
    from anthro_service import snapshot
    api = snapshot.build(OUT)
    print(f"api/v1: {api['files']} files for {api['populations']} populations")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"built public/ ({size:.1f} MB)")


if __name__ == "__main__":
    main()
