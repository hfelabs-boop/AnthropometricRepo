# Aggregate statistics by country and role

Only four surveys publish individual-level data. To cover more countries, services and roles, this folder holds the
**means and standard deviations printed in published papers**, extracted into one format (see [`SPEC.md`](SPEC.md)).

| File | What it is |
|---|---|
| `raw/*.csv` | Rows extracted from papers, one file per extraction run. `raw/*.md` describe how each run was done, what was dropped and why. |
| `aggregates.csv` | Everything merged, plus the statistics computed from the four raw datasets. `is_primary = 1` marks the row used when several sources describe the same population. |
| `rollup.csv` | One row per country × role × sex × measure: sample-size-weighted mean and pooled SD over the primary rows. |
| `survey_groups.csv` | Says which populations in different papers are the same survey, so it is counted once. |

## Sources (rows)

| Run | Papers | Rows |
|---|---|---|
| `rp1024.csv` | NASA RP-1024 Vol. II (1978): 90 military and civilian populations, 21 countries | 5,832 |
| `usarmy.csv` | ANSUR 1988, ANSUR II, Army pilots, MC-ANSUR 2010 (US Marine Corps) | 1,213 |
| `aunz.csv` | NZDFAS (New Zealand), AWAS (Australian Army), ASRAN (Royal Australian Navy) | 991 |
| `foreign_1960s.csv` | Korea 1965, Thailand 1962, Latin American armed forces 1965 | 432 |
| `german_navy_usaf.csv` | German Air Force 1967-68, US Naval Aviators 1964, Canadian Forces | 223 |
| `openaccess_articles.csv` | Open-access journal articles: Iran, Poland, Germany, Finland, Czech Republic, Switzerland, Brazil, Chile, Angola, Taiwan, Saudi Arabia, India | 145 |

## How reliable is it?

* **Grade A**: parsed from a born-digital table and checked. **B**: read by OCR from a scanned report; each row had to pass internal checks (for example the printed coefficient of variation must equal SD ÷ mean, the mean must lie inside the printed percentiles). **C**: read from the text of a web article.
* Where individual-level data exist, the extracted numbers were compared with them: the USAF 1967 rows in the NASA source book agree with the raw data to within 0.1 SD on all 47 comparable measures, and the ANSUR and ASRAN report tables agree to rounding.
* Rows that could not be verified were dropped, not repaired. Each run's `.md` counts them. Papers left out on purpose are listed there too (a clinical case-control study; a paper whose BMI contradicted its own weight and height).
* **Sex is `both` when a paper did not say.** Most 1960s-70s military samples were men, but the label is left as "Mixed / not stated" rather than guessed.
* **Roll-ups mix eras and methods.** Surveys span the 1940s to the 2020s, and measuring methods differ. Use the per-population rows to compare like with like.
* The NASA source book's metric pages print no units; the extraction assumed centimetres for lengths and kilograms for weights after checking magnitudes.

## Rebuilding

```bash
python scripts/build_database.py      # individual-level data -> database/anthro.sqlite
python scripts/validate_aggregates.py # check every raw/*.csv against SPEC.md
python scripts/build_aggregates.py    # merge -> aggregates.csv, rollup.csv
python scripts/build_papers.py        # paper index (needs the PDFs from scripts/fetch.py reports)
python scripts/build_database.py      # again, to load the aggregates and papers tables
```

Not covered: the scanned handbook DOD-HDBK-743A, CAESAR (no text layer), the Canadian Forces 2012 survey (report blocked) and
the UK, French, Dutch, Bundeswehr, Russian, Israeli, Indian, Indonesian, Malaysian, Singaporean and Japanese national surveys
(no public report was found). Several of these appear only as populations inside the NASA source book.
