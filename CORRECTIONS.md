# Corrections and open questions

This file lists what the September 2026 verification pass changed or could not confirm, compared with the earlier version of the survey page. Each item also appears in the `notes` field of its entry in [`catalog/surveys.yaml`](catalog/surveys.yaml).

## Corrections

| Entry | Earlier value | Corrected value |
|---|---|---|
| Latin American armed forces (#37) | USATTC 729002 | USATTC **7209002** |
| Canadian Forces aircrew 1985 (#20) | author not given | **L.E. Stewart**, DCIEM TR 85-12-01 |
| USAF flying personnel 1950 (#10) | published 1950 | published **1954** (WADC TR 52-321) |
| Naval Aviators 1964 (#8) | published 1964 | published **1965** (NAEC-ACEL-533) |
| Air Force women 1968 (#12) | published 1968 | published **1972** (AMRL-TR-70-5) |
| USMC 1966 (#6) | published 1966 | published **1977** (CEMEL-115) |
| ANSUR II (#2) | TR-15/007 dated 2015 | ODL dates it 2015 and DTIC dates it **2014**. Both dates are recorded. |
| UK Tri-Service (#16) | the *Ergonomics* 68(5) paper reports survey results | The paper covers requirements and **pilot studies** only. The planned scope was "over 2,750 personnel" and "over 180 measurements" (QinetiQ, 22 Feb 2023). |
| USAF 1967 (#11) | Grunhöfer & Kroh ran the survey | Grunhöfer & Kroh **compiled** the data. AMRL ran the survey. |

## Found while building this repository (2026-09-28)

- **ODL links need https.** Requests for `http://tools.openlab.psu.edu/publicData/...` now return the ODL web-app HTML page, with status 200 and a size of 645 bytes, instead of the file. The `https://` URLs still serve the CSVs and PDFs, so the catalog uses them.
- **ASRAN direct XLSX URLs are now verified.** They were resolved through the data.gov.au CKAN API (`package_show`) and downloaded. See [`catalog/surveys.yaml`](catalog/surveys.yaml).
- **ASRAN counts are confirmed from the data.** The data has 1,090 men and 232 women (1,322 in total) and 87 measurements: 43 physical and 44 digital.
- **The ANSUR 1988 CSVs have 131 variables plus a subject number,** fewer than the "140+" measures described in the report.
- **The ANSUR II CSVs have 93 measured dimensions and 14 demographic columns.** The 39 derived dimensions are not included. The male CSV is Latin-1 encoded.
- **The USAF 1967 HSIAC documentation has two layout typos.** Variables 132 and 158 end at column 23, not 22. With that correction, the fixed-width file matches the CRAN `USAFSurvey` matrix exactly. The file also ends with a trailer record (subject −13) that repeats the last subject.

## Still unconfirmed

- UK Tri-Service final figures: 1,886 personnel and 194 measurements.
- AWAS sample size of 2,138. The 84 dimensions are confirmed.
- CAESAR Vol. II report number: AFRL-HE-WP-TR-2002-0170 or -0173.
- The following details come from search snippets, not from opening the PDFs. Re-open the PDFs before publishing: USMC 1966, Iran, Latin America, Korea, and the CFAS DRDC report.
- Rows 7, 9, 15, 17–19, 23, 29–33, 35, 36, 39–46 and 48 give only the best available citation. "Not found" means not verified; it does not prove that no copy exists. Search the DTIC bibliography ADA529930 and the DTIC R&E Gateway for accession numbers.

## Link-check caveat

The automated checker (`python scripts/fetch.py check-links`) gets HTTP 403 from `apps.dtic.mil`, Taylor & Francis, ScienceDirect, ResearchGate, and DOIs that resolve to those sites. These hosts use bot protection that rejects scripted requests from cloud IP addresses. [`catalog/link_status.csv`](catalog/link_status.csv) marks these links as `blocked`, not `broken`. Check them in a browser. DTIC also sometimes serves a "scheduled maintenance" page instead of the PDF.
