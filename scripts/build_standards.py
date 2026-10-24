#!/usr/bin/env python3
"""Validate standards/mil-std-1472h/requirements.json and regenerate the derived files.

requirements.json is the source of truth: the MIL-STD-1472H requirements the website could
check or report (see standards/mil-std-1472h/README.md). This script:
  - validates every requirement (unique ids, allowed levels and checkable classes, numeric limits)
  - rewrites requirements.json in canonical form (one requirement per line, so diffs stay readable)
  - writes requirements.csv (one row per requirement, values flattened to text)

Uses only the standard library.
Usage: python scripts/build_standards.py [--check]
  --check  fail if the files are invalid or not in canonical form (for CI)
"""
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "standards" / "mil-std-1472h"
SRC = DIR / "requirements.json"
CSV_OUT = DIR / "requirements.csv"

LEVELS = {"shall", "should", "info"}
CHECKABLE = {"auto", "semi", "manual", "na"}
REQUIRED = ["id", "section", "section_title", "para", "title", "level", "checkable", "category",
            "text", "values", "source", "page", "site_hook", "percentile_rule"]
CSV_FIELDS = ["id", "section", "para", "title", "level", "checkable", "category", "page", "source",
              "limits", "text", "site_hook", "percentile_rule"]


def validate(doc):
    errors = []
    reqs = doc.get("requirements", [])
    ids = [r.get("id") for r in reqs]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        errors.append(f"duplicate ids: {sorted(dup)[:5]}")
    for r in reqs:
        rid = r.get("id")
        for key in REQUIRED:
            if key not in r:
                errors.append(f"{rid}: missing {key}")
        if not re.fullmatch(r"[a-z0-9-]+", str(rid)):
            errors.append(f"{rid}: id must be lower-case letters, digits and hyphens")
        if r.get("level") not in LEVELS:
            errors.append(f"{rid}: level {r.get('level')!r} not in {sorted(LEVELS)}")
        if r.get("checkable") not in CHECKABLE:
            errors.append(f"{rid}: checkable {r.get('checkable')!r} not in {sorted(CHECKABLE)}")
        if not isinstance(r.get("page"), int):
            errors.append(f"{rid}: page must be an integer")
        for v in r.get("values") or []:
            for key in ("quantity", "min", "max", "preferred", "unit", "condition"):
                if key not in v:
                    errors.append(f"{rid}: value missing {key}")
            for key in ("min", "max", "preferred"):
                if v.get(key) is not None and not isinstance(v[key], (int, float)):
                    errors.append(f"{rid}: {key} must be a number or null")
            lo, hi = v.get("min"), v.get("max")
            if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo > hi and not v.get("misprint"):
                errors.append(f"{rid}: min {lo} > max {hi} for {v.get('quantity')!r}")
    return errors


def canonical_json(doc):
    """Header keys pretty-printed; one requirement per line."""
    head = {k: v for k, v in doc.items() if k != "requirements"}
    text = json.dumps(head, indent=1, ensure_ascii=False)[:-2]
    lines = [json.dumps(r, ensure_ascii=False, separators=(", ", ": ")) for r in doc["requirements"]]
    return text + ',\n "requirements": [\n' + ",\n".join(lines) + "\n ]\n}\n"


def limits_text(values):
    parts = []
    for v in values or []:
        lo, hi, pref = v.get("min"), v.get("max"), v.get("preferred")
        rng = f"{lo}-{hi}" if lo is not None and hi is not None else \
            f">= {lo}" if lo is not None else f"<= {hi}" if hi is not None else ""
        if pref is not None:
            rng = f"{rng} (preferred {pref})".strip()
        if not rng:
            continue
        cond = f" [{v['condition']}]" if v.get("condition") else ""
        parts.append(f"{v.get('quantity')}: {rng} {v.get('unit') or ''}".rstrip() + cond)
    return " | ".join(parts)


def build_csv(doc):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, lineterminator="\n")
    w.writeheader()
    for r in doc["requirements"]:
        row = {k: r.get(k) for k in CSV_FIELDS if k != "limits"}
        row["limits"] = limits_text(r.get("values"))
        w.writerow(row)
    return buf.getvalue()


def main():
    check = "--check" in sys.argv
    doc = json.loads(SRC.read_text(encoding="utf-8"))
    errors = validate(doc)
    if errors:
        print("\n".join(errors[:50]), file=sys.stderr)
        sys.exit(f"{len(errors)} error(s) in {SRC.relative_to(ROOT)}")
    outputs = {SRC: canonical_json(doc), CSV_OUT: build_csv(doc)}
    stale = [p for p, text in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
    if check:
        if stale:
            sys.exit("out of date (run python scripts/build_standards.py): "
                     + ", ".join(str(p.relative_to(ROOT)) for p in stale))
    else:
        for p in stale:
            p.write_text(outputs[p], encoding="utf-8")
    counts = {}
    for r in doc["requirements"]:
        counts[r["checkable"]] = counts.get(r["checkable"], 0) + 1
    print(f"{len(doc['requirements'])} requirements ({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))})")


if __name__ == "__main__":
    main()
