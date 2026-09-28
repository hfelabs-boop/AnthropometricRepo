#!/usr/bin/env python3
"""Extract the ASRAN 2015 raw-data worksheets into plain CSV files.

The data.gov.au workbook has one worksheet per sex. Row 1 holds the measure
type ("Physical Measure" or 3D-scan extracted), row 2 the column names. The
measure type is kept in a separate column-metadata CSV.

Requires: pandas, openpyxl
Usage: python scripts/build_asran_csv.py
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "asran-2015"
WORKBOOK = DIR / "asran-2015-anthropometry-data_public-release.xlsx"
SHEETS = {"ASRAN Females Age 18-54": "ASRAN_2015_female.csv",
          "ASRAN Males Age 18-54": "ASRAN_2015_male.csv"}


def main():
    meta = None
    for sheet, name in SHEETS.items():
        raw = pd.read_excel(WORKBOOK, sheet_name=sheet, header=None)
        kinds, columns = raw.iloc[0].tolist(), [str(c).strip() for c in raw.iloc[1]]
        df = raw.iloc[2:].dropna(how="all")
        df.columns = columns
        df.to_csv(DIR / name, index=False)
        print(f"wrote {name}: {len(df)} subjects x {len(columns) - 1} measurements")
        if meta is None:
            meta = pd.DataFrame({"column": columns,
                                 "measure_type": ["" if pd.isna(k) else k for k in kinds]})
    meta.to_csv(DIR / "ASRAN_2015_columns.csv", index=False)


if __name__ == "__main__":
    main()
