#!/usr/bin/env python3
"""Build the static website into public/ (used by the Vercel deployment).

public/ contains:
  index.html, styles.css, js/   the single-page app (copied from site/)
  db/anthro.sqlite.gz           the SQLite database, gzip-compressed; the browser
                                decompresses it and queries it with sql.js
  catalog/                      surveys.json (read by the app) and CSV/JSON downloads
  data/                         the original open datasets, for direct download

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
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"built public/ ({size:.1f} MB)")


if __name__ == "__main__":
    main()
