# Individual-level datasets

Only four of the 49 catalogued surveys have individual-level data that anyone can download for free. Copies of all four are in this folder. Each file's checksum is in [`SHA256SUMS`](SHA256SUMS). Run `python scripts/fetch.py verify` to check your copies, or `python scripts/fetch.py data` to download them again from the original sources.

| Folder | Survey | Subjects | Variables | Source | Licence |
|---|---|---|---|---|---|
| [`ansur-1988/`](ansur-1988) | ANSUR 1988, US Army | 1,774 men, 2,208 women | 131 + subject number | Penn State OPEN Design Lab (ODL) | Public-domain US Government work |
| [`ansur-ii-2012/`](ansur-ii-2012) | ANSUR II 2012, US Army | 4,082 men, 1,986 women | 93 measured + 14 demographic + subject id | Penn State ODL | Public-domain US Government work |
| [`asran-2015/`](asran-2015) | ASRAN 2015, Royal Australian Navy | 1,090 men, 232 women | 87 (43 physical, 44 from 3D scans) | data.gov.au | CC BY 3.0 AU |
| [`usaf-1967/`](usaf-1967) | 1967 US Air Force flying personnel | 2,420 men | 202 | HSIAC file, via the CRAN *Anthropometry* package author | US Government data; R package GPL (>= 2) |

All files were downloaded on 2026-09-28.

## ANSUR 1988 (`ansur-1988/`)

- `ansurMen.csv` and `ansurWomen.csv` come from `https://tools.openlab.psu.edu/publicData/`. The landing page is https://www.openlab.psu.edu/ansur/.
- Lengths are in **mm**. `WEIGHT` is in **hectograms** (tenths of a kg). For example, a mean of 784.9 means 78.5 kg.
- The files are UTF-8 with a byte-order mark. In pandas, read them with `encoding="utf-8-sig"`.
- The variable codes are defined in UMTRI's `ANSUR_88_Codes.pdf`, linked from [`CATALOG.md`](../CATALOG.md).
- ODL's own links use `http://`, but those URLs now return the ODL web-app HTML page instead of the file. Use `https://`.

## ANSUR II 2012 (`ansur-ii-2012/`)

- `ANSUR_II_MALE_Public.csv` and `ANSUR_II_FEMALE_Public.csv` come from ODL. The landing page is https://www.openlab.psu.edu/ansur2/.
- Lengths are in **mm**. `weightkg` is in **hectograms**, despite its name.
- `Heightin` and `Weightlbs` are probably self-reported. One male record has `Weightlbs = 0`.
- The male file is **Latin-1** encoded, not UTF-8. Read it with `encoding="latin-1"`.
- The subject-id column is `subjectid` in the male file and `SubjectId` in the female file.
- The 39 derived dimensions described in NATICK/TR-15/007 are not in the public CSVs. Neither are the 3D scans, which were withheld for privacy.

## ASRAN 2015 (`asran-2015/`)

- `asran-2015-anthropometry-data_public-release.xlsx` is the original workbook. It has an overview sheet, one sheet each for females and males aged 18–54, and a sheet of sample-size calculations.
- `multivariate-virtual-fit-test-asran_nov2020.xlsx` is the multivariate accommodation tool by Parkinson & Reed, revised 12 November 2020.
- `ASRAN_2015_male.csv`, `ASRAN_2015_female.csv` and `ASRAN_2015_columns.csv` were extracted from the workbook by [`scripts/build_asran_csv.py`](../scripts/build_asran_csv.py). `ASRAN_2015_columns.csv` records whether each measure was taken physically or extracted from a 3D scan ("Digital Measure").
- Units are in the column names (mostly mm).
- **Licence: CC BY 3.0 AU.** Attribute the data to the Commonwealth of Australia (Defence Science and Technology Group) and data.gov.au.
- Landing page: https://data.gov.au/data/dataset/3e124b9c-4daa-4797-a265-ddbc5f36313c

## USAF 1967 (`usaf-1967/`)

- `AFFLY67.dat` is the raw fixed-width HSIAC file. It comes from `data_information.zip`, which the author of the CRAN *Anthropometry* package publishes at https://www.uv.es/vivigui/softw/data_information.zip.
- `USAF1967_variables.csv` is the data dictionary. It gives each variable's number, the matching column in the R package (`V1`…`V202`), the HSIAC code, the name, the alias, and the record and column position. It was transcribed from `AFFLY67.doc`, with two corrections:
  - The documentation leaves out the positions of 27 variables. Those positions were inferred and are marked `inferred`.
  - Two end columns were misprinted as 22 and have been corrected to 23: variable 132 (lateral malleolus height) and variable 158 (bitragion breadth).
- `USAF1967.csv` was built from the `.dat` file by [`scripts/build_usaf1967_csv.py`](../scripts/build_usaf1967_csv.py). It matches the `USAFSurvey` matrix in CRAN *Anthropometry* 1.22 exactly, cell for cell.
- The HSIAC documentation says variables 6, 9–11, 28, 76–95, 117 and 142 should be excluded from analysis. They are flagged `documented = no` in the dictionary.
- Most lengths are in mm, but some variables use other units, such as tenths of a year for age (recorded at bin midpoints, e.g. 235 = 23.5) and pounds for weight (mean 173.6). Check each variable against AGARD-AG-205 before analysis.
- The coded background variables are rank, aero rating, aircraft category, birthplace, race, handedness, blood type, Rh factor and command. Their codes are listed in `AFFLY67.doc`, which is inside the zip.

## Surveys whose data is not public

MC-ANSUR 2010, CFAS 2012, AWAS, NZDFAS and the UK Tri-Service survey have no public individual-level data. CAESAR is sold commercially by SAE International. See [`CATALOG.md`](../CATALOG.md) for the report links for these surveys.
