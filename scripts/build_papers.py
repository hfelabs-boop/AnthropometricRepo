#!/usr/bin/env python3
"""Build the paper index: catalog/papers.csv and catalog/papers.json.

One row per paper that could be downloaded (PDFs in reports/, fetched with `fetch.py reports`)
plus open-access articles from every aggregates/raw/*_papers.csv (one per search run). For each paper:
the original link, an open copy (Internet Archive mirror for DTIC reports), size, page count,
SHA-256, whether it has a text layer, and how many aggregate rows were extracted from it.

The PDFs themselves are not committed (about 0.5 GB; most are public-domain US reports).
Requires: pymupdf, pyyaml
Usage: python scripts/build_papers.py [--drive-url URL]
"""
import csv
import hashlib
import json
import re
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

import pymupdf
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch import dtic_mirror, is_pdf_link, report_dest  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ["paper_id", "survey_id", "title", "language", "original_url", "open_copy_url", "open_copy_kind", "local_file",
          "size_mb", "pages", "text_layer", "sha256", "aggregate_rows", "source"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pdf_facts(path):
    try:
        doc = pymupdf.open(path)
        n = doc.page_count
        probe = [doc[i].get_text() for i in range(0, n, max(1, n // 6))][:6]
        return n, ("yes" if sum(len(t) for t in probe) / max(1, len(probe)) > 200 else "no (scan)")
    except Exception:
        return None, "unreadable"


def main():
    surveys = yaml.safe_load(open(ROOT / "catalog" / "surveys.yaml", encoding="utf-8"))["surveys"]
    extra = yaml.safe_load(open(ROOT / "catalog" / "additional_reports.yaml", encoding="utf-8"))["reports"]
    agg_rows = Counter()
    agg = ROOT / "aggregates" / "aggregates.csv"
    if agg.exists():
        for r in csv.DictReader(open(agg, encoding="utf-8")):
            agg_rows[r["source_file"]] += 1

    jobs = [(s["id"], r["label"], r["url"]) for s in surveys for r in s.get("reports", [])]
    jobs += [(r.get("related") or "additional", r["title"], r["url"]) for r in extra]
    rows, seen = [], set()
    for sid, label, url in jobs:
        if not is_pdf_link(url):
            continue
        dest = report_dest(sid, url)
        if not dest.exists():
            continue
        key = (dest.name, sid)
        if key in seen:
            continue
        seen.add(key)
        pages, text = pdf_facts(dest)
        mirror = dtic_mirror(url)
        direct = urllib.parse.urlparse(url).hostname != "apps.dtic.mil"
        rel = str(dest.relative_to(ROOT))
        rows.append({
            "paper_id": re.sub(r"\W+", "-", dest.stem).strip("-").lower(),
            "survey_id": sid, "title": label, "language": "English", "original_url": url,
            "open_copy_url": url if direct else mirror,
            "open_copy_kind": "publisher/agency" if direct else "Internet Archive mirror of DTIC",
            "local_file": rel, "size_mb": round(dest.stat().st_size / 1e6, 2), "pages": pages, "text_layer": text,
            "sha256": sha256(dest), "aggregate_rows": agg_rows.get(rel, 0), "source": "catalog",
        })

    # Open-access articles found by web search: every aggregates/raw/*_papers.csv
    for oa in sorted((ROOT / "aggregates" / "raw").glob("*_papers.csv")):
        for r in csv.DictReader(open(oa, encoding="utf-8")):
            local = r.get("local_pdf") or ""
            path = ROOT / local if local else None
            has = bool(path and path.exists())
            pages, text = pdf_facts(path) if has else (None, "")
            title = r["title"]
            if r.get("title_english") and r["title_english"] != title:
                title = f"{r['title_english']} [original: {title}]"
            rows.append({
                "paper_id": r["slug"], "survey_id": "", "title": title, "language": r.get("language") or "English", "original_url": r["url"],
                "open_copy_url": r.get("pdf_url") or r["url"],
                "open_copy_kind": ("publisher page (abstract only)" if r.get("accessibility", "").startswith("abstract")
                                   else f"open access ({r.get('license') or 'license not stated'})"),
                "local_file": local if has else "", "size_mb": round(path.stat().st_size / 1e6, 2) if has else "",
                "pages": pages or "", "text_layer": text, "sha256": sha256(path) if has else "",
                "aggregate_rows": int(r.get("rows_extracted") or 0), "source": "web search"})

    rows.sort(key=lambda r: (r["source"], r["survey_id"], r["title"]))
    out = ROOT / "catalog" / "papers.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    (ROOT / "catalog" / "papers.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    total = sum(float(r["size_mb"] or 0) for r in rows)
    print(f"wrote catalog/papers.csv: {len(rows)} papers, {total:.0f} MB")


if __name__ == "__main__":
    main()
