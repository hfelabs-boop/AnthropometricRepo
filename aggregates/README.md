# Aggregate statistics by country and role

Only four surveys publish individual-level data. To cover more countries, services and roles, this folder holds the
**means and standard deviations printed in published papers**, extracted into one format (see [`SPEC.md`](SPEC.md)).

| File | What it is |
|---|---|
| `raw/*.csv` | Rows extracted from papers, one file per extraction run. `raw/*.md` describe how each run was done, what was dropped and why. |
| `aggregates.csv` | Everything merged, plus the statistics computed from the four raw datasets. `is_primary = 1` marks the row used when several sources describe the same population. |
| `rollup.csv` | One row per country × role × sex × measure: sample-size-weighted mean, pooled SD and the 5th / 50th / 95th percentiles (`p5`, `p50`, `p95`) over the primary rows. A group made of several surveys combines the surveys' distributions as a mixture weighted by sample size. Each survey's percentiles are the ones it reports; where it reports none they are estimated from its mean and SD (normal approximation). `pct_basis` says which: `reported` (every survey), `mixed`, or `estimated` (none); blank when a group has neither percentiles nor SDs. |
| `survey_groups.csv` | Says which populations in different papers are the same survey, so it is counted once. |

## Sources (rows)

| Run | Papers | Rows |
|---|---|---|
| `rp1024.csv` | NASA RP-1024 Vol. II (1978): 90 military and civilian populations, 21 countries | 5,832 |
| `usarmy.csv` | ANSUR 1988, ANSUR II, Army pilots, MC-ANSUR 2010 (US Marine Corps) | 1,213 |
| `aunz.csv` | NZDFAS (New Zealand), AWAS (Australian Army), ASRAN (Royal Australian Navy) | 991 |
| `foreign_1960s.csv` | Korea 1965, Thailand 1962, Latin American armed forces 1965 | 432 |
| `german_navy_usaf.csv` | German Air Force 1967-68, US Naval Aviators 1964, Canadian Forces | 223 |
| `openaccess_articles.csv` | English-language open-access journal articles: Iran, Poland, Germany, Finland, Czech Republic, Switzerland, Brazil, Chile, Angola, Taiwan, Saudi Arabia | 145 |
| `ml_germanic.csv` | German, Dutch, Nordic, Baltic, Hungarian, Turkish sources: Austrian, Danish and Norwegian conscript series, Finnish, Swiss, Dutch 1985 military survey, Hungarian recruits | 339 |
| `ml_slavic.csv` | Russian, Czech, Serbian, Polish, Bulgarian, Ukrainian sources: Czech Army preventive exams 1999-2015, Serbian cadets, Russian conscripts | 333 |
| `ml_romance.csv` | Spanish and Portuguese sources: Brazil, Colombia, Portugal, Chile, Ecuador | 238 |
| `ml_mideast_sasia.csv` | Hebrew, English (Middle East/South Asia): Israel, India, Iran, Pakistan | 122 |
| `ml_cjk.csv` | Japanese, Korean, Vietnamese, Thai, Indonesian, Chinese-language searches: JASDF 1988, Korea, Vietnam, Thailand, Indonesia | 143 |

## How reliable is it?

* Multilingual rows: the search was run in about 30 languages. Sources were read in the original and translated into English (population names, dimension names, notes); each run's `.md` lists the queries, translation notes and exclusions. Persian, Arabic and Chinese full texts were unreachable from the search environment (Iranian hosts, CNKI and others blocked automated access), so those languages are under-represented. Candidate surveys that could not be read are listed in [`../docs/candidate_surveys.md`](../docs/candidate_surveys.md).
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
