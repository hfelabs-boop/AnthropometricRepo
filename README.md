# Military Anthropometric Surveys: Sources and Open Data

This repository collects **49 military anthropometric surveys** from around the world. For each survey it records the study report (with a PDF link where one exists), the citation, the corrected survey facts, and the status of the individual-level data. Where that data can be downloaded for free, a copy is included.

- **[CATALOG.md](CATALOG.md)**: the master table of all 49 surveys, grouped by region.
- **[data/](data)**: the four surveys whose individual-level data is freely available, with checksums and notes on units and encoding.
- **[CORRECTIONS.md](CORRECTIONS.md)**: what the September 2026 verification pass changed, and what is still unconfirmed.
- **[catalog/](catalog)**: the catalog in machine-readable form (`surveys.yaml` is the source of truth; `surveys.csv` and `surveys.json` are generated from it), plus `link_status.csv`, the latest automated link check.

## TL;DR

| | Count |
|---|---|
| Surveys catalogued | 49 |
| Individual-level data free to download (copies in `data/`) | 4: ANSUR 1988, ANSUR II 2012, ASRAN 2015, USAF 1967 |
| Free study PDF or open-access paper | 22 |
| Commercial data | 1 (CAESAR, sold by SAE International) |
| Entries fully verified / partly verified / not verified | 13 / 13 / 23 |

### The four open datasets

| Survey | Subjects | Variables | Files | Licence |
|---|---|---|---|---|
| ANSUR 1988 (US Army) | 1,774 men, 2,208 women | 131 | [`data/ansur-1988/`](data/ansur-1988) | Public domain (US Government) |
| ANSUR II 2012 (US Army) | 4,082 men, 1,986 women | 93 measured + 14 demographic | [`data/ansur-ii-2012/`](data/ansur-ii-2012) | Public domain (US Government) |
| ASRAN 2015 (Royal Australian Navy) | 1,090 men, 232 women | 87 | [`data/asran-2015/`](data/asran-2015) | CC BY 3.0 AU |
| USAF 1967 (flying personnel) | 2,420 men | 202 | [`data/usaf-1967/`](data/usaf-1967) | US Government data; the R package is GPL (>= 2) |

> ⚠️ **Units:** In both ANSUR datasets, body mass is stored in **hectograms**, even in the ANSUR II column named `weightkg`. Divide by 10 to get kg. Lengths are in mm. The ANSUR II male CSV is Latin-1 encoded. See [data/README.md](data/README.md) for more.

## Quick start

**Python**

```python
import pandas as pd

ansur2_m = pd.read_csv("data/ansur-ii-2012/ANSUR_II_MALE_Public.csv", encoding="latin-1")
ansur2_m["mass_kg"] = ansur2_m["weightkg"] / 10

ansur88_w = pd.read_csv("data/ansur-1988/ansurWomen.csv", encoding="utf-8-sig")
asran_f = pd.read_csv("data/asran-2015/ASRAN_2015_female.csv")
usaf67 = pd.read_csv("data/usaf-1967/USAF1967.csv")

catalog = pd.read_csv("catalog/surveys.csv")
catalog[catalog.data_access == "public"]
```

**R**

```r
ansur2_f <- read.csv("data/ansur-ii-2012/ANSUR_II_FEMALE_Public.csv")
usaf67   <- read.csv("data/usaf-1967/USAF1967.csv", check.names = FALSE)
# The same USAF 1967 data ships with CRAN:
# install.packages("Anthropometry"); data(USAFSurvey, package = "Anthropometry")
```

## Scripts

Install the dependencies with `pip install -r requirements.txt`.

| Command | What it does |
|---|---|
| `python scripts/build_catalog.py` | Validates `catalog/*.yaml` and regenerates `surveys.csv`, `surveys.json`, `additional_reports.csv` and `CATALOG.md`. Add `--check` to run it in CI. |
| `python scripts/fetch.py verify` | Checks the committed datasets against `data/SHA256SUMS`. Works offline. |
| `python scripts/fetch.py data` | Downloads the datasets again from their original sources, then verifies them. |
| `python scripts/fetch.py reports` | Downloads every study PDF in the catalog to `reports/<survey-id>/`. This folder is git-ignored. |
| `python scripts/fetch.py check-links` | Requests every link and writes `catalog/link_status.csv`, marking each one `ok`, `blocked` or `broken`. |
| `python scripts/build_asran_csv.py` | Extracts per-sex CSVs from the ASRAN workbook. |
| `python scripts/build_usaf1967_csv.py` | Converts the fixed-width `AFFLY67.dat` into a CSV with named columns. |

**About DTIC links.** Most study PDFs are hosted on the Defense Technical Information Center (`apps.dtic.mil`). DTIC and some publishers reject scripted requests from cloud IP addresses with HTTP 403, so the link checker marks their links `blocked`, not `broken`. Open them in a browser. DTIC also sometimes shows a "scheduled maintenance" page, so test the links again before you cite them. The study PDFs are linked rather than committed, apart from the report copies that ODL hosts. You can download those with `fetch.py reports`.

## Coverage by region

| Region | Entries |
|---|---|
| United States | 14 |
| United Kingdom | 4 |
| Canada / Australia / New Zealand | 8 |
| Europe / Other | 11 |
| Asia-Pacific / Middle East / Latin America | 12 |

## Website (Vercel)

`vercel.json` deploys a searchable version of the catalog as a static site. `python scripts/build_site.py` builds it into `public/` (git-ignored), using only the Python standard library. To preview it locally:

```bash
python scripts/build_site.py && python -m http.server -d public 8000
```

To deploy: in Vercel choose **Add New → Project**, import this repository, and keep the settings from `vercel.json` (no framework, output directory `public`). Every push to `main` redeploys.

## Contributing

To add a source or fix an entry:

1. Edit `catalog/surveys.yaml`.
2. Run `python scripts/build_catalog.py`.
3. Commit the YAML together with the regenerated files.

If you add a dataset, put it under `data/<survey-id>/`, add its `local:` path to the catalog entry, and update `data/SHA256SUMS`.

## Licences

The datasets keep their original licences, listed above and in [data/README.md](data/README.md). If you use ASRAN, you must credit the Commonwealth of Australia (Defence Science and Technology Group) under CC BY 3.0 AU. The US Government reports and datasets are in the public domain. The NZDFAS monograph is CC BY-NC 4.0.
