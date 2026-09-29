# usarmy.csv: ANSUR II, MC-ANSUR, ANSUR II pilots, ANSUR 1988 (+ 1988 pilots)

Output: `aggregates/raw/usarmy.csv` (1213 rows, 20 SPEC columns, `scripts/validate_aggregates.py` reports 0 problems).
All rows: country United States, population_type military. Length values are converted cm to mm, mass to kg, rounded to 2 decimals.
p5/p50/p95 are given where the printed percentile rows were readable and passed the checks below.

## Sources, pages parsed, rows

| source_id | PDF | PDF pages parsed | populations | rows |
|---|---|---|---|---|
| ansur-ii-2012 | reports/ansur-ii-2012/ADA611869.pdf | 55-240 (Chapter IV, dimensions 1-93; stats on even pages, percentiles on the preceding page) | Army men (n=4082), Army women (n=1986) | 186 (93 x 2) |
| mc-ansur-2010 | reports/mc-ansur-2010/ADA581918.pdf | 56-243 (dimensions 1-94) | Marine men (n~1301), Marine women (n~620) | 188 (94 x 2) |
| ansur-ii-pilots | reports/ansur-ii-2012/ADA634277.pdf | 58-~420 (dimensions 1-93; Chapter IV) and 437-439 (Appendix I, Table I-1) | pilot men n=977 (93), pilot women augmented database n=395 (93), plus the 42 actually measured women pilots, weighted (Appendix I, mean/SD only, 92) | 278 |
| ansur-1988 | reports/ansur-1988/ADA225094.pdf | 87-350 (132 standard measurements, pairs of description+percentile page and statistics page); 480-575 (48 headboard measurements, H1-H48) | Army men (n=1774), Army women (n=2208) | 347 (256 standard + 91 headboard) |
| ansur-1988-pilots | reports/ansur-1988/ADA241952.pdf | 77-339 (standard measurements only; statistics and percentiles share one page) | 1988 Army pilot men (n=487); women = demographically matched subset of the female pool (n=334), NOT actual pilots | 214 |

Skipped everywhere: derived dimensions (ANSUR II D1-D39, MC-ANSUR D1-D41, ANSUR 1988 D1-D60), frequency tables, observer-error tables, and 1988-pilot headboard dimensions (scan text layer too broken, page order irregular).
Report-level breakdowns by Army component or MOS: none. ANSUR II reports only sample-composition tables (component, MOS group) not measurement statistics by component or MOS.

## Notes on the populations

* ANSUR II: the summary tables are for 4082 men / 1986 women, identical to the public data files. The abstract's 7435 men / 3922 women is not what the tables use, so the "larger full sample" comparison in the task does not arise for this report.
* MC-ANSUR: 94 measured dimensions (includes Acromion-wall depth, which ANSUR II lacks). Marine sample sizes vary 613-1301 by dimension.
* ANSUR II pilots: the printed "FEMALES" columns are the **augmented** database (n=395, women drawn from the ANSUR II female pool and weighted), not the 42 pilots actually measured. The 42 real women are in Appendix I (mean/SD/min/max only) and are given as a separate population. The report says the 42 should not be used for design.
* Appendix I skips: "Acromial height sitting" (a derived dimension, D2), "Acromion radiale length" (printed mean 107.4 mm is not consistent with 311 mm in the main tables, likely a misprint, dropped). Interpupillary breadth in Appendix I is printed in tenths of mm although the header says mm; divided by 10 and noted in the row.
* ANSUR 1988 pilots (ADA241952): the female column is a subset of the ANSUR female pool matched to pilot age and race, not real pilots. The report uses 2.2 lb per kg for weight (checked: lb/2.2 equals the printed kg), so weight consistency accepts either 2.2046 or 2.2.
* Quality flags: the task asked for `A` = passed all consistency checks (incl. agreement with raw data where available). SPEC.md defines `A` as born-digital and `B` as OCR that passed internal checks. I used `A` for every row that passed all applicable checks, except: ANSUR 1988 headboard rows (no raw data exist, scanned OCR) and the 7 ANSUR 1988 standard rows with no raw column (Vertical trunk circumference ASCC, and single-sex rows of a few dimensions whose partner-sex OCR was unreadable), which are `B`. The ANSUR II, MC-ANSUR and pilot PDFs have a clean born-digital text layer; ANSUR 1988 PDFs are OCR of scans.

## Validation applied to every row

1. Centimetre value must equal inch value x 2.54 (kg vs lb for weight) within rounding, for both mean and SD. This detects nearly every OCR digit error because the two numbers are printed independently.
2. Mean strictly between printed p5 and p95, p5 < p50 < p95, and percentile cm/inch pairs consistent. Otherwise the row is dropped if the mean was affected, else only the percentiles are omitted.
3. p95-p5 within 2.4-4.4 SD (soft flag, one row flagged and reviewed: ANSUR 1988 men Bizygomatic breadth, kept because raw data agree).
4. n within 1% of the sample size (pilot-1988: 85-100%).
5. Agreement with raw individual data (ANSUR II and ANSUR 1988 standard rows). Percentiles were additionally compared with the raw quantiles (tolerance max(1.5 mm, 5% SD)); 15 ANSUR 1988 percentile sets that disagreed (OCR digit errors) were blanked, the row kept.
6. Cross-source sanity: MC-ANSUR means differ from ANSUR II by at most 0.61 SD (SD ratios 0.71-1.37); pilot means differ from ANSUR II by at most 0.51 SD. 1988 pilots must be within 1.2 SD of the 1988 main sample and SD ratio 0.5-1.6 (7 rows dropped by this or by digit checks).
7. The 219 rows that map to harmonized keys for ansur-ii-2012 (112) and ansur-1988 (107) also agree with `database/anthro.sqlite` subjects (mean within 0.02 SD, n within 1%): 0 failures.

## Agreement with raw data

* ANSUR II (data/ansur-ii-2012/*.csv; male file latin-1; raw mm converted to cm, mass hectograms /10, interpupillary breadth stored in tenths of mm): 186/186 rows match. Max |mean difference| 0.005 cm, max |SD difference| 0.005 cm (rounding of the printed value), n identical (4082/1986). No OCR or unit errors found (the PDF text is born digital).
* ANSUR 1988 standard measurements (data/ansur-1988/*.csv; raw mm, WEIGHT in hg): 256 rows, all within 0.005 cm / 0.005 kg for the mean and within tolerance for the SD; n identical (1774 / 2208 or the printed lower n). Report dimension k maps to raw column by matching means, and the mapping is consistent with the names (checked all 131; the raw file has no column for Vertical trunk circumference ASCC, dimension 108). One raw variable order quirk: the printed order of dimension numbers 88-132 is shifted by one against the raw column list because dimension 88 (Scye circumference) is column SCYE_CIRC_OVER_ACROMION.
* MC-ANSUR, ANSUR II pilots, ANSUR 1988 headboard and 1988 pilots: no raw data exist in the repo (individual-level data are public only for ANSUR II and ANSUR 1988 standard); checks 1-4 and 6 above apply.

## Rows dropped or values omitted (all OCR problems in ANSUR 1988 scans)

Dropped, not repaired:
* ansur-1988 men: Biacromial breadth (SD cm unreadable "1.8C"), Head circumference (SD inch unreadable), Heel-ankle circumference (SD cm/in mismatch), Bimalleolar breadth H47 women Zygofrontale-back of head (mean cm/in mismatch).
* ansur-1988 women: Bustpoint/thelion-bustpoint breadth, Chest circumference at scye, Waist (natural indentation)-waist (omphalion) length (mean cm unreadable), Interscye I (SD cm/in mismatch), Sitting height (mean printed "65.20", inch 33.54; the digit is misread, so dropped).
* ansur-1988 headboard: Chin-top of head (stat page unparseable), Nose protrusion men and Pronasale-top of head women (tokens unreadable).
* ansur-1988-pilots: rows failing cm/inch checks (Foot breadth F, Waist front length NI M), n outlier (Ear breadth F 234), cross-check failures (Crotch length NI and omphalion, both sexes: values inconsistent with the 1988 main survey, likely swapped or misprinted), and about 55 dimension-sex rows whose text layer was missing or unreadable (see the source PDF pages 85-339).
* Percentiles are blank for 93 of 347 ANSUR 1988 rows, 167 of 214 1988-pilot rows (text layer garbled), and the Appendix I rows (not printed).

## Label handling

Labels are the report's printed dimension names (upper case in ANSUR/MC-ANSUR reports, sentence case in Appendix I). Where the OCR garbled a heading (ANSUR 1988: numbers 22, 26, 27, 41, 79, 85, 88, 93, 123, H11, H15) I reconstructed it from the second copy of the title (description page vs statistics page) and marked the row note "label reconstructed from garbled OCR". Asterisks in the ANSUR II/MC-ANSUR headings mean the definition differs from ANSUR 1988 (noted per row).

Measure keys: harmonized keys where the dimension name is the same as an entry in `database/harmonized_measures.csv` (through the ansur_ii_2012 or ansur_1988 column); everything else is `other:<snake_case label>`; the 1988 headboard measurements use `other:headboard_<name>` to avoid clashing with the same-named tape/caliper measures (for example Bizygomatic breadth, Menton-sellion length). No BMI, age or derived dimensions are included.

## Reproduction

Parsing and validation code lives in the session scratchpad (`.../scratchpad/usarmy/*.py`): word-position parsing of the PDF text layer (pymupdf), cm/inch cross-check, raw-data comparison, and CSV assembly. The CSV was regenerated from those scripts and validated with `python3 scripts/validate_aggregates.py aggregates/raw/usarmy.csv`.
