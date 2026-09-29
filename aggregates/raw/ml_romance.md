# ml_romance – Romance-language military anthropometry search (Spanish, Portuguese, French, Italian, Romanian, Catalan)

Outputs: `aggregates/raw/ml_romance.csv` (238 rows, validated), `aggregates/raw/ml_romance_papers.csv` (41 papers examined, 25 with rows), 22 PDFs saved under `reports/openaccess/` (slug-named, not committed).

## Method

Search tools: WebSearch (queries written in each language), WebFetch, curl + pymupdf/rapidocr. The session's WebSearch budget ran out after ~25 queries, so the remainder of the search used database APIs directly: OpenAlex `works?search=` (queries in pt/es/fr/it/ro; the shared free budget was exhausted before the Italian/Romanian queries returned), HAL API (`api.archives-ouvertes.fr`), the RCAAP/Comum DSpace discovery API (Portugal), Dialnet document search (`dialnet.unirioja.es/buscar/documentos`), the medigraphic.com mirror of *Revista Cubana de Medicina Militar* (all 44 issue tables of contents scanned for anthropometry titles) and *Revista Cubana de Investigaciones Biomédicas*, Redalyc PDFs, SciELO Chile/Spain PDFs, and journal OJS sites (Cinergis, RBPFEX, Revista de Educação Física do Exército, ConScientiae Saúde, Rev. Científica Gen. José María Córdova).

Representative queries: "estudio antropométrico personal militar", "antropometría militares talla peso desviación estándar", "Revista Cubana de Medicina Militar antropometría soldados", "Ejército Mexicano antropometría", "Fuerza Aérea Ecuatoriana antropometría infantería", "levantamento antropométrico militares", "antropometria militares Exército Brasileiro estatura massa corporal desvio padrão", "cadetes AMAN antropometria", "Academia Militar Portugal cadetes antropometria", "anthropométrie militaires campagne de mensuration armée de terre", "Médecine et Armées anthropométrie", "antropometria militari Esercito statura peso deviazione standard Giornale di Medicina Militare", "studiu antropometric militari români Revista de Medicină Militară", "antropometria militars".

Extraction: PDFs read with pymupdf; the one image-only table (Barraza 2021, Rev Cubana Med Mil) and one scanned paper (Salem 2003, RBAFS) were OCR'd with RapidOCR and cross-checked (BMI recomputed; Table 1 vs Table 2 consistency) -> quality B. Web-only articles (SciELO Brazil, which serves a JavaScript bot challenge to curl; one thesis abstract) -> quality C. All other rows come from born-digital PDF tables -> quality A. Units converted to mm/kg/years; skinfolds and body-composition values as `other:` keys (skinfolds in mm, % values flagged in notes).

## Coverage by country (rows / papers with rows)

* Brazil – 14 papers with rows: Army (Haiti contingent 192 M; AMAN cadets 441; EsPCEx 287; CFS sergeant students 27; Ponta Grossa soldiers 40; Pernambuco army-police battalion 47; entering conscripts Santa Maria 198; army women 10 and 100), Air Force (Pirassununga recruits 139; São Paulo FAB personnel 1,241 – the largest sample), and three state Military Police samples (Mato Grosso recruits 82, Rio 32, Ceará shock battalion 25). Mostly stature/mass/BMI/waist/skinfolds.
* Colombia – 5 papers (Army officers 96; three formation schools 120; ESMIC cadets 51 and 69; alféreces 72). ESMIC 2015 gives a full ISAK profile (7 skinfolds, 3 girths, 3 breadths).
* Chile – 2 new papers (28 conscripts pre-training with 28 ISAK dimensions incl. sitting height and head girth; 57 infantry soldiers). Barraza 2020 skipped as instructed (but note: a full-text copy exists on the medigraphic mirror, `cmm-2020` issue 9562).
* Ecuador – 1 paper with rows (ESFORSE soldier-school aspirants, 153 M, 37 variables of which only the internally consistent ones were kept); 2 further Ecuadorian papers examined with 0 rows (cohort with image tables; paywalled Springer FAE chapter – no SciELO/Redalyc/Dialnet copy exists).
* Portugal – 4 theses (Air Base 11: 473 personnel by sex; Military Academy cadets 2024 abstract by sex; Military Academy 2014 means by year/sex; Army courses 2022 – 0 rows).
* Spain – 2 papers examined, 0 rows (Navy overweight intervention; historical 1858-1913 conscript provincial means).
* Mexico – 2 papers examined, 0 rows (somatotype regression only; RSM site blocked).
* Peru – 1 paper (military health personnel), 0 rows (image table, BMI categories only).
* France – 2 HAL documents identified (2012 mémoire on enlistment candidates; 2020 thesis), both blocked by the Anubis anti-bot challenge; no rows. No open "campagne de mensuration" report of the Armée de terre / DGA was found through HAL or web search; *Médecine et Armées* is not indexed full-text online.
* Italy, Romania, Catalan, Belgium, Switzerland (excluded), Canada-French, francophone Africa, Argentina, Venezuela, Cuba (Cuban samples), Angola/Mozambique – no eligible open document found (see limitations).

## Excluded and why

* Barraza-Gómez 2020 (Chile) – already in `openaccess_articles_papers.csv`.
* Studies of athletes (military pentathlon), firefighters (bombeiros militares) and civil police (ISCPSI Lisbon cadets) – outside the military-population definition.
* Papers whose only anthropometric statistics were intervention deltas, medians in image tables, or means without SD for selected sub-samples (listed in the papers CSV with 0 rows and the reason).
* Lemes 2014 (PMESP) – SDs printed are implausible (mass 73.8 ± 1 kg, stature 177 ± 0.6 cm); not used.
* Maldonado 2017 (Ecuador) rows whose mean lay outside the printed min–max or whose SD was implausible (eye height, shoulder height, elbow height, hand width, head girth, biceps girth, elbow width) were dropped; the retained rows are flagged in notes.

## Translation notes

`population` and `measure_label` keep the paper's own label where it is a plain dimension (Estatura, Massa corporal, IMC, Cintura ...). Portuguese "circunferência abdominal" (CA, at the umbilicus, EB manual) is kept as `other:abdominal_circumference` and distinguished from "cintura" (`waist_circumference`); AMAN pools abdominal (men) and waist (women) girths -> `other:abdominal_or_waist_circumference`. "Talla sentado" = sitting height. Spanish "perímetro cadera" -> `buttock_circumference`. ISAK skinfolds keep their site names as `other:skinfold_*`. Colombian officer paper prints "Altura m" with values in cm; noted. "Braço contraído / brazo en tensión / brazo flexión" -> `biceps_circumference_flexed`; relaxed arm girth -> `other:arm_circumference_relaxed`. Where flexed/relaxed forearm was not stated it is noted.

## Candidate surveys for the catalog

* **Spain, 1903-1906 military anthropometric survey** – Luis Sánchez-Fernández (Sanidad Militar) measured stature, weight and chest girth of 119,571 recruits born 1883-86 (results presented 1911). Provincial means are reproduced in Martínez-Carrión JM, Cámara AD, Pérez-Castroviejo PM. Nutr Hosp 2016;33(6):1477-1486, doi 10.20960/nh.812, https://www.redalyc.org/pdf/3092/309249472033.pdf. Historical whole-force conscript survey; no SD available in the secondary source.
* **Brazil, Brazilian Air Force São Paulo 2011** (Maria SHC, USP thesis) – 1,241 male FAB personnel (soldiers, NCOs, officers) measured for stature, weight, abdominal girth, skinfolds; a large single-service sample but limited to one garrison, so probably a paper-index item rather than a national survey.
* **Brazil, Brazilian Army 2001 fitness census** – "Medidas antropométricas segundo aptidão cardiorrespiratória em militares da ativa" (Rev Saúde Pública 2008, SciELO id 94mR49x5KvYPQcRkHGcjNQP) reports body mass, height and waist girth of 50,523 active Army men measured in 2001. Could not be read here (SciELO Brazil returned 403 to both curl and WebFetch); worth retrying from another network – it is the closest thing to a national Army anthropometric survey found in Portuguese.

## Limitations

* WebSearch budget exhausted mid-run; OpenAlex free budget exhausted before Italian and Romanian queries; SciELO Brazil (www.scielo.br) blocks scripted access; HAL PDF downloads and revistasanidadmilitar.org (Mexico) serve anti-bot challenges; revmedmilitar.sld.cu and scielo.sld.cu do not resolve through the proxy (medigraphic mirror used instead, which only covers issues up to 2022). RECYT (Retos) and RBQV returned login pages.
* No Italian (Giornale di Medicina Militare), Romanian (Revista de Medicină Militară – 2007/2010 issues downloaded and grepped: no anthropometric article), Catalan or francophone-African open military anthropometry paper was located; French coverage is limited to two inaccessible HAL documents.
* Several Latin-American papers give only a handful of dimensions (stature, mass, BMI, waist); only Barraza 2021 (Chile), Castañeda 2015 (Colombia), Maldonado 2017 (Ecuador) and Salem 2003 (Brazil) provide wider ISAK-style profiles, and their samples are small (10-153).
* Cuban military samples themselves were not found: the Cuban journal's anthropometry papers are by Brazilian, Chilean, Peruvian and Ecuadorian authors.
