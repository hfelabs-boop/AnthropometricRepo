#!/usr/bin/env python3
"""Convert the fixed-width 1967 USAF survey file (AFFLY67.dat) into a named CSV.

Each subject occupies 9 consecutive 80-column records. Column positions come
from data/usaf-1967/USAF1967_variables.csv, which was transcribed from the
HSIAC file description (AFFLY67.doc). Positions for the 27 variables that the
HSIAC documentation omits were inferred from their neighbours.

The raw file ends with a trailer block (subject number -13) that repeats the
last subject's measurements; it is dropped, leaving the 2,420 subjects that
the CRAN Anthropometry package ships as USAFSurvey.

Usage: python scripts/build_usaf1967_csv.py
"""
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "usaf-1967"
RECORDS_PER_SUBJECT = 9


def main():
    variables = list(csv.DictReader(open(DIR / "USAF1967_variables.csv", newline="")))
    lines = [l.rstrip("\r\n") for l in open(DIR / "AFFLY67.dat", encoding="ascii")]
    lines = [l for l in lines if l.strip()]
    if len(lines) % RECORDS_PER_SUBJECT:
        raise SystemExit(f"{len(lines)} non-blank lines is not a multiple of {RECORDS_PER_SUBJECT}")

    header = [
        f"V{int(v['var_no']) + 1}_{v['variable_name']}" if v["documented"] == "yes"
        else f"V{int(v['var_no']) + 1}_UNDOCUMENTED"
        for v in variables
    ]
    out = DIR / "USAF1967.csv"
    n = 0
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for s in range(0, len(lines), RECORDS_PER_SUBJECT):
            block = [l.ljust(80) for l in lines[s:s + RECORDS_PER_SUBJECT]]
            row = []
            for v in variables:
                rec, a, b = int(v["record"]), int(v["start_col"]), int(v["end_col"])
                row.append(block[rec - 1][a - 1:b].strip())
            if int(row[0]) < 0:  # trailer block
                continue
            w.writerow(row)
            n += 1
    print(f"wrote {out.relative_to(ROOT)}: {n} subjects x {len(header)} variables")


if __name__ == "__main__":
    main()
