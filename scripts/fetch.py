#!/usr/bin/env python3
"""Download sources listed in the catalog and check that links still work.

Subcommands
  verify        check committed data files against data/SHA256SUMS (offline)
  data          re-download every dataset that has both `url` and `local`,
                then verify it against data/SHA256SUMS
  reports       download every study PDF in the catalog into reports/<survey-id>/
                (reports/ is git-ignored; files are not committed)
  check-links   request every URL in the catalog and write catalog/link_status.csv

Requires: pyyaml (standard library otherwise)
Usage: python scripts/fetch.py {verify,data,reports,check-links}
"""
import argparse
import csv
import datetime as dt
import hashlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SUMS = ROOT / "data" / "SHA256SUMS"
UA = "Mozilla/5.0 (compatible; anthropometric-catalog/1.0)"
# Hosts behind bot protection that answer 403 to scripted requests even when the
# document is available in a browser. A 403 from these is reported as "blocked".
BOT_PROTECTED = {"apps.dtic.mil", "www.tandfonline.com", "doi.org", "www.sciencedirect.com",
                 "www.researchgate.net", "cradpdf.drdc-rddc.gc.ca"}


def catalog():
    surveys = yaml.safe_load(open(ROOT / "catalog" / "surveys.yaml", encoding="utf-8"))["surveys"]
    extra = yaml.safe_load(open(ROOT / "catalog" / "additional_reports.yaml", encoding="utf-8"))["reports"]
    return surveys, extra


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout)


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with get(url) as r, open(tmp, "wb") as f:
        ctype = r.headers.get("Content-Type", "")
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if "text/html" in ctype and dest.suffix.lower() in {".pdf", ".csv", ".xlsx", ".zip"}:
        tmp.unlink()
        raise RuntimeError(f"server returned an HTML page instead of {dest.suffix}")
    tmp.replace(dest)


def cmd_verify(_):
    bad = 0
    for line in SUMS.read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        path = ROOT / "data" / name.lstrip("*")
        ok = path.exists() and sha256(path) == digest
        bad += not ok
        print(("ok      " if ok else "MISMATCH") + f"  data/{name}")
    if bad:
        raise SystemExit(f"{bad} file(s) failed verification")


def cmd_data(args):
    surveys, _ = catalog()
    for s in surveys:
        for d in s.get("data", []):
            if "url" not in d or "local" not in d or d["url"].endswith(".zip"):
                continue
            print(f"GET {d['url']}")
            download(d["url"], ROOT / d["local"])
    cmd_verify(args)


def dtic_mirror(url):
    """DTIC blocks scripted requests; the Internet Archive mirrors DTIC reports as DTIC_<accession>."""
    m = re.search(r"/(AD[A-Z]?\d{6,7})\.pdf$", urllib.parse.urlparse(url).path, re.I)
    if urllib.parse.urlparse(url).hostname == "apps.dtic.mil" and m:
        acc = m.group(1).upper()
        return f"https://archive.org/download/DTIC_{acc}/DTIC_{acc}.pdf"
    return None


def report_dest(sid, url):
    """Where `fetch.py reports` stores a catalog report: reports/<survey-id>/<file>.pdf."""
    name = Path(urllib.parse.urlparse(url).path).name
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return ROOT / "reports" / sid / name


def is_pdf_link(url):
    return urllib.parse.urlparse(url).path.lower().endswith(".pdf") or "/download/" in url


def cmd_reports(_):
    surveys, extra = catalog()
    jobs = [(s["id"], r["url"]) for s in surveys for r in s.get("reports", [])]
    jobs += [(r.get("related") or "additional", r["url"]) for r in extra]
    failed = []
    for sid, url in jobs:
        if not is_pdf_link(url):
            continue  # landing pages
        dest = report_dest(sid, url)
        if dest.exists():
            print(f"have  {dest.relative_to(ROOT)}")
            continue
        try:
            try:
                download(url, dest)
            except Exception:
                mirror = dtic_mirror(url)
                if not mirror:
                    raise
                download(mirror, dest)
                print(f"mirror {mirror}")
            print(f"got   {dest.relative_to(ROOT)}")
        except Exception as e:  # keep going; some hosts refuse scripted requests
            failed.append((url, e))
            print(f"FAIL  {url}: {e}")
        time.sleep(1)
    if failed:
        print(f"\n{len(failed)} download(s) failed; see catalog/link_status.csv for known-blocked hosts.")


def cmd_check_links(_):
    surveys, extra = catalog()
    links = []
    for s in surveys:
        links += [(s["id"], "report", r["label"], r["url"]) for r in s.get("reports", [])]
        links += [(s["id"], "data", d["label"], d["url"]) for d in s.get("data", []) if "url" in d]
    links += [(r.get("related", ""), "additional", r["title"], r["url"]) for r in extra]
    today = dt.date.today().isoformat()
    rows = []
    for sid, kind, label, url in links:
        status, ctype, note = "", "", ""
        try:
            with get(url, timeout=60) as r:
                status, ctype = r.status, r.headers.get("Content-Type", "")
                r.read(1024)
            expected = Path(urllib.parse.urlparse(url).path).suffix.lower()
            if expected in {".pdf", ".csv", ".xlsx", ".zip"} and "text/html" in ctype:
                note = "HTML page served instead of file"
        except urllib.error.HTTPError as e:
            status, ctype = e.code, e.headers.get("Content-Type", "")
        except Exception as e:
            status, note = "error", type(e).__name__ + ": " + str(e)[:120]
        if status == 200 and not note:
            result = "ok"
        elif urllib.parse.urlparse(url).hostname in BOT_PROTECTED and status in (403, "error"):
            result = "blocked"
            note = note or "host refuses scripted requests; check in a browser"
        else:
            result = "broken"
        rows.append({"survey_id": sid, "kind": kind, "label": label, "url": url, "http_status": status,
                     "content_type": ctype.split(";")[0], "result": result,
                     "note": note, "checked": today})
        print(f"{result:<8}{status!s:>6}  {url}")
    out = ROOT / "catalog" / "link_status.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    counts = {k: sum(r["result"] == k for r in rows) for k in ("ok", "blocked", "broken")}
    print(f"\nwrote {out.relative_to(ROOT)}: " + ", ".join(f"{v} {k}" for k, v in counts.items()))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["verify", "data", "reports", "check-links"])
    args = p.parse_args()
    {"verify": cmd_verify, "data": cmd_data, "reports": cmd_reports,
     "check-links": cmd_check_links}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
