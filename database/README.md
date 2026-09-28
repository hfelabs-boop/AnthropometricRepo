# Database

`python scripts/build_database.py` builds **`database/anthro.sqlite`**, a single SQLite database containing the whole catalog and all four open datasets. The file is git-ignored because it is generated, and it takes a few seconds to build using only the Python standard library. The website build (`scripts/build_site.py`) also builds it and ships a gzip copy that the browser queries with sql.js.

| Table | Rows | What it holds |
|---|---|---|
| `subjects` | 13,792 | One row per person. Includes `dataset`, `source_id`, `sex` (`M`/`F`), `branch`, `component`, `handedness`, and 59 harmonized measures in common units: mm, kg, years, and kg/m² for BMI. |
| `people` (view) | 13,792 | `subjects` with the survey name and start year added. |
| `measures` | 59 | Each harmonized measure: label, unit, category, note, and its source column in each survey (`src_<dataset>`). |
| `datasets` | 4 | Provenance, licence, and subject counts. |
| `raw_ansur_1988`, `raw_ansur_ii_2012`, `raw_asran_2015`, `raw_usaf_1967` | | Every original column, unchanged, keyed by `subject_key`. |
| `raw_columns` | | Descriptions of the raw columns. USAF 1967 variables include their HSIAC names. |
| `surveys`, `survey_links` | 49, … | The full catalog and every report and data link. |

## Harmonization

[`harmonized_measures.csv`](harmonized_measures.csv) maps each measure to its source column in every survey. The build applies these unit fixes:

- ANSUR 1988 and ANSUR II store mass in hectograms. It is divided by 10.
- USAF 1967 stores mass in pounds. It is multiplied by 0.45359237.
- USAF 1967 stores age in tenths of a year. It is divided by 10.
- ANSUR II stores interpupillary breadth in tenths of a mm. It is divided by 10.

The source files use zero to mean missing, so zeros become `NULL`. BMI is derived from measured stature and mass.

Harmonization goes by dimension name. Measuring methods still differ between surveys: landmark definitions, posture, and ASRAN's 44 measures extracted from 3D scans. Compare surveys with care. For example, ANSUR II chest breadth runs about 30 mm below the other surveys.

## Example

```python
import sqlite3
db = sqlite3.connect("database/anthro.sqlite")
db.execute("""SELECT dataset, sex, COUNT(*), ROUND(AVG(stature)), ROUND(AVG(mass), 1)
              FROM subjects GROUP BY 1, 2""").fetchall()
```
