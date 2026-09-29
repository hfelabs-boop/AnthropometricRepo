# german_navy_usaf.csv - extraction notes

Output: `aggregates/raw/german_navy_usaf.csv` (223 rows, `scripts/validate_aggregates.py`: 0 problems).

| source_id | rows | quality | source pages |
|---|---|---|---|
| german-air-force-1967-68 | 109 | B | ADA010674.pdf pp. 29-102 (one summary-statistics block per dimension, two per landscape page) |
| naval-aviators-1964 | 96 | B | AD0626322.pdf pp. 18-113 (one page per measure, numbers 1-96) |
| canada-cf-1996 | 18 | A | ADA310612.pdf pp. 67-69 (Table 29, "CF Validation" rows) |
| usaf-1967 | 0 | - | not extractable, see below |
| usaf-1946-army | 0 | - | report is a bibliography, see below |

## 1. AGARD-AG-205 (german-air-force-1967-68)
* Layout: each dimension has a landscape "Summary statistics and frequency tables" block (frequency table, GAF and USAF percentile columns, then SUMMARY STATISTICS: mean and SD in cm and in inches, skewness, kurtosis, CV, N). Scan is a 1-bit dot-matrix print and the PDF text layer is garbage (also RapidOCR fails on the numbers), so the summary blocks were rendered at 300 dpi, rotated, and read visually from image crops.
* **The summary statistics (mean, SD, N) are printed for the GAF sample only (N about 1,465; 1,459-1,464 for foot dimensions).** The USAF sample appears only as a percentile column (1st-99th), so there is no USAF mean/SD/n in the report and no USAF rows are written (mean is a required field). The report does not split pilots from other aircrew, so GAF is a single population (service_role Aircrew).
* Acceptance gate per row: inch and cm printed mean agree within 0.15 cm, inch and cm SD agree within ~0.08 cm, and 100*SD/mean matches the printed coefficient of variation within rounding. Value stored is the cm print where legible, else the inch print converted (cm 25.4/10 mm). Rows failing the gate were dropped.
* Rows: 109 written. Dropped (38): 28 blocks with unreadable digits (weight, skinfolds and other blocks on pp. 26-28 are not listed as they were skipped outright, thigh clearance, neck circumference, several face/ear/head-height/"to wall" measures, head length, biocular, interpupillary, bizygomatic), plus suprasternale, waist height, iliocristale height, shoulder-elbow length, bigonial (cm/in conflict), trochanterion height, patella-bottom height, medial malleolus height (CV mismatch), and biacromial breadth (mean -9% vs USAF and SD 3.6 cm; implausible). Full list is reproducible from the page images.
* Weight: kg/lb columns not verifiable (lb 164.63, SD 17.84 read but kg digits illegible), so dropped.
* Three measures whose GAF mean differs from the USAF raw mean by more than 7% (bi-iliocristale breadth +15%, shoulder length -20%, menton-sellion +7%) are kept under `other:` keys to avoid contaminating harmonized comparisons. Some titles were cropped in the scan (instep length, foot breadth, bimalleolar breadth, ball-of-foot circumference); labels were inferred from the printed definition and are marked in notes.
* `n` is blank where the last digit of N was not legible.

### USAF raw-data agreement
The report's USAF percentile columns are in cm/inches and cover 2,420 men. Spot check of the stature block (p. 29): report USAF 1st/5th/50th/95th/99th percentiles 163.15/167.25/~177.3/187.70/191.91 cm vs raw `V14_STATURE` (mm) percentiles 163.3/167.2/177.4/187.6/192.06 cm, i.e. agreement within about 0.2 cm; raw mean 177.34 cm, SD 6.19 cm, n 2,420. Additionally, GAF means were compared with USAF raw means (`usaf_1967` in the database) for 36 shared dimensions: 27 within 4%, the outliers being those listed above. The raw file is in mm and lb (V3 weight), 2,420 men.

## 2. Naval aviators 1964 (naval-aviators-1964)
* Text layer is usable (one page per measure: mean, SD, range, SE, CV, percentiles, both in/cm or lb/kg). 83 pages parsed directly with checks: cm = 2.54 x in for both mean and SD, weight kg = 0.4536 x lb. 13 pages had corrupted text-layer digits and were re-read with RapidOCR on the page image (22, 25, 29, 38, 42, 45, 46, 50, 54, 57, 73, 91, 96), and passed the same in/cm checks (notes say so).
* cm printed values used (mm = cm x 10); weight in kg; skinfolds (93-96) converted cm to mm and put under `other:`.
* n = 1,549 for every row (survey total; per-measure n is not printed). Population "Navy aviators (US Naval and Marine Corps aviators) 1964", service_role Aircrew, sex M.
* Percentiles (p5/p50/p95) were not extracted (optional field).
* Key mapping: shoulder height sitting, hip breadth (standing), neck circumference etc. were mapped only where the definition matches; others are `other:`.

## 3. ADA239831 (usaf-1946-army): skipped
This PDF is "An Annotated Bibliography of U.S. Army Natick Anthropology (1947-1991)" (NATICK/TR-91/044), not the 1946 survey report. It only cites the 1946 surveys (105,062 men / 8,864 women) in abstracts; no mean/SD/n tables. Nothing extracted.

## 4. ADA310612 (canada-cf-1996)
NATICK/TR-96/031 is a validation study but Table 29 (pp. 67-69) tabulates n, min, max, mean, SD (mm, weight in kg) for the 18 measured variables in the CF Validation sample (Canadian Forces men measured at US posts, 1993-94), alongside ANSUR comparison samples. Only the "CF Validation" rows were taken (18 rows, quality A, born-digital, n 529-534). year_start 1993 (project window Jan 1993 - Apr 1994). Table 10 (height/weight/BMI by rostered vs substitute) and Table 20 (by age category vs Express database) were not extracted.
