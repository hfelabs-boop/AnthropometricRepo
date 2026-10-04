# Aggregate statistics extracted from published papers

Each extraction writes one CSV to `aggregates/raw/<source>.csv` with these columns (in this order).
`scripts/validate_aggregates.py` checks them, and `scripts/build_aggregates.py` merges them into
`aggregates/aggregates.csv` and the `aggregates` table of the database.

| Column | Meaning |
|---|---|
| `source_id` | Catalog survey id from `catalog/surveys.yaml` when the paper reports that survey, otherwise a new slug such as `pmc7767597-iran-military`. |
| `source_file` | Repo-relative path of the PDF in `reports/`, or the URL of an open-access web article. |
| `page` | 1-based PDF page number of the table the row came from (blank for web articles). |
| `population` | Name of the sample as the paper calls it, e.g. `Army men 1966`, `TURKISH MIL. 60/61`. |
| `country` | English country name (`United States`, `Australia`, `New Zealand`, `Iran`, `Turkey`, `Greece`, `Italy`, `Germany`, `Sweden`, `South Korea`, `Vietnam`, `Thailand`, `India`, `Japan`, `Brazil`, `Oman`, ...). Multinational samples: `Multiple: <list>`. |
| `population_type` | `military`, `civilian` or `mixed`. |
| `service_role` | One of: `Army`, `Navy`, `Marine Corps`, `Air Force`, `Tri-service`, `Aircrew`, `Pilots`, `Navigators`, `Officers`, `Enlisted`, `Recruits/trainees`, `Nurses`, `Cadets`, `Cadre/other military`, `Civilian`. Pick the closest. Put detail in `population`. |
| `sex` | `M`, `F` or `both`. |
| `year_start` | First year of measuring (integer), blank if unknown. |
| `measure_key` | A key from `database/harmonized_measures.csv` when the dimension is the same measurement, else `other:<snake_case_name>`. |
| `measure_label` | The dimension name exactly as the paper prints it. |
| `unit_original` | Unit printed in the paper (`mm`, `cm`, `in`, `lb`, `kg`, `years`, ...). |
| `mean`, `sd` | **Converted** to the harmonized unit: length in mm, mass in kg, age in years, BMI in kg/m². Round to 2 decimals. |
| `n` | Number of subjects for this measure (integer, blank if not given). |
| `p5`, `p50`, `p95` | Optional percentiles, converted the same way. |
| `quality` | `A` = parsed from a born-digital table and validated; `B` = OCR, passed the internal consistency checks; `C` = read from a web article's text/tables. |
| `notes` | Anything a user must know (bilateral side, derived value, sample sub-group, etc.). |

Rules
* Never guess. If a value is unreadable, drop that row. Do not fix OCR errors by hand unless the paper's own numbers (percentiles, CV, other rows) prove the right value.
* One row per population x sex x measure. Keep sub-populations (officers, pilots, ...) as separate populations.
* Conversions: 1 in = 25.4 mm, 1 cm = 10 mm, 1 lb = 0.45359237 kg, 1 hectogram = 0.1 kg.
* Skinfolds, angles and strengths are allowed as `other:` keys with the unit converted to mm (skinfolds) or left as printed (angles, strength), with the unit named in `notes`.
