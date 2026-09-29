# aunz.csv: NZDFAS, AWAS, ASRAN summary statistics

Output: `aggregates/raw/aunz.csv`, 991 rows, `scripts/validate_aggregates.py` reports 0 problems.
All rows are quality A. Every row's mean lies within p5..p95, p5 <= p50 <= p95 and sd/mean <= 0.6.

| source_id | rows | tables/pages parsed |
|---|---|---|
| nzdfas | 666 | PDF pp. 95-261 (odd pages), the 84 "summary statistics" tables |
| awas | 157 | PDF pp. 27-108 (section 4.4, M01-M85 univariate tables), minus pp. 100 and 102 |
| asran-2015 | 168 | PDF pp. 29-115 (chapter 4, 87 measures M01-M91) |

## NZDFAS (Kolose et al. 2021)
* One page per measure (84 measures), each with N, Mean, SD, Min, Max and P1-P99, in columns Male: All / Air Force / Army / Navy and Female: Air Force / Army / Navy / All (this column order was worked out from the N rows: service Ns sum to the "All" N).
* Populations kept: men and women for each of Army, Navy, Air Force, plus all-services pooled (`service_role` Tri-service). 84 measures x 8 groups = 672, 6 dropped (see below).
* year_start 2016 (data collection Feb-Sep 2016). Measurement type (automatic 3D-scan / physical / post-processed) is in `notes`.
* Text layer is column-scrambled, so values were assigned by row (4 values before the row label = men, 4 after = women). Checks per table/sex: service Ns sum to All N; Min <= P1 <= P50 <= P99 <= Max; mean in P1..P99; "All" mean between the service means. All 84 x 2 passed.
* Harmonized keys used only where the same dimension (e.g. Body height -> stature, Seated height -> sitting_height). Automatic-scan girths whose definition differs (waist girth, waist circumference preferred, thigh girth, ankle girth, sleeve outseam etc.), cervicale height sitting, and eye height (standing) are `other:`.
* Dropped: "Crotch waist preferred posterior", 6 of 8 groups (mean outside P5-P95, or sd/mean > 0.6: highly skewed, likely outliers). The other two groups of that measure were kept.
* Skipped: none of the age/rank sub-tables exist in the report (only sex x service).

## AWAS (Edwards et al. 2014, DSTO-TR-3006)
* Each page: FEMALES and MALES columns (n, mean, SE, SD, min, max, skewness, kurtosis, CV, P1-P99). Text layer is fragmented (overlapping duplicate glyphs), so values were rebuilt from character positions with duplicate glyphs removed. Every page gave exactly 34 rows per sex; SE = SD/sqrt(n) and CV = SD/mean checked for all pages, all consistent.
* Only one population: Army personnel by sex (no trade/corps sub-tables in the report). Female-only: M34, M58; male-only: M42 (women "not measured"). Percentiles p5/p50/p95 from printed table.
* year_start left blank: the report only says the survey was completed in 2012 (catalog gives 2010-2012 measurement).
* Skipped: p.100 (M75 Chest level / M76 Bust level) and p.102 (M78 Hip level female / M82 Hip level): one page holds two differently-defined dimensions, column assignment is not stated. M44/M45/M46/M47/M52-M55/M67/M81 have n around 1500 (subset measured).
* M85 Front Length is a derived dimension (M04 - M07), kept as `other:`; noted.
* No weighted statistics are given.

## ASRAN (DST-Group-TR-3564)
* Layout per measure: n, mean, SE, SD, max, min, skewness, kurtosis, CV, P99..P1, women left column, men right column. Titles carry the M-number; harmonized keys come from the `asran_2015` column of harmonized_measures.csv. Measures with "not measured" for a sex (M34, M58, M76, M78 men; M75, M82 women) have no row.
* Only unweighted statistics appear in the report (no "weighted" tables), so nothing to separate. Table 1 (1977 vs 2015 secular trend, age/occupation-matched subset n=593) not extracted: matched subset only.
* Boundary manikin tables (Tables 5-12) and PCA tables are not summary statistics and were skipped.

### Validation against raw data (data/asran-2015/ASRAN_2015_male.csv, _female.csv)
* 168 population x sex x measure rows compared with mean/SD/percentile recomputed from the individual data (NODATA excluded).
* Mean: max absolute difference 0.4997, mean 0.27 (report prints integers or 0.1 mm; all within half a printed unit = rounding). SD: max diff 0.499, mean 0.25. P50: max diff 0.5.
* n equal for 167 of 168; the only mismatch is male Stature: report n=1088, raw 1090 (report mean 1792 vs raw 1792.16, SD 70 vs 70.2, still consistent).
* Conclusion: parsing of the ASRAN tables is correct; no row disagreed beyond rounding.
