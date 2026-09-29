# ml_mideast_sasia – Persian, Arabic, Hebrew, South Asian and African military anthropometry search

Run: `ml_mideast_sasia` (2026-09-29). Outputs: `aggregates/raw/ml_mideast_sasia.csv` (122 rows, validated),
`aggregates/raw/ml_mideast_sasia_papers.csv` (41 papers examined, 16 with rows), PDFs in `reports/openaccess/` (14 files).

## Method

Languages searched (queries written in the language): Persian (آنتروپومتری نظامیان / سربازان / دانشجویان دانشگاه افسری / خلبانان
نیروی هوایی / صدک / مجله طب نظامی / ابن‌سینا), Arabic (القياسات الجسمية / الأنثروبومترية للعسكريين / المجندين / طلبة الكلية العسكرية
/ الجيش العراقي / الجيش المصري / مؤشر كتلة الجسم), Hebrew (מדידות אנתרופומטריות חיילי צה"ל / מתגייסים / גובה משקל / הרפואה
הצבאית / חיל האוויר), Hindi/Urdu/Bengali material was only found through English-language South Asian journals (PAFMJ, JAFMC
Bangladesh, Indian Journal of Aerospace Medicine, DRDO journals); Amharic/Swahili queries returned only English-language
material (Ethiopian DSJ paper already in the index; Kenya Defence Forces hypertension study).

Databases/portals: WebSearch (200-call session budget exhausted about half-way; afterwards only APIs), Europe PMC REST
(search + fullTextXML for open-access articles), Crossref REST, DOAJ API, OpenAlex (429 rate-limited), scholar.archive.org
(rate-limited), PAFMJ site search (pafmj.org; readable only through WebFetch, not curl), BanglaJOL search, AJOL search,
Indian Journal of Aerospace Medicine site search, Brieflands (JAMM) and Crossref for Iranian English-language journals,
rmsjournal.org (Jordan RMS), IMA (Israeli Medical Association) file server for Hebrew "Journal of Israeli Military Medicine".

## Access problems (major limitation)

* Every Iranian host tried was unreachable from this environment: sid.ir (503), magiran.com (403), militarymedj.ir
  (DNS failure), militarymedj.bmsu.ac.ir, ebnesina.ajaums.ac.ir, journals.ajaums.ac.ir, jpmed.ir, civilica.com,
  noormags.ir, ensani.ir, jmm.iranjournals.ir, journal.iehfs.ir, tkj.ssu.ac.ir (all 000/503). Web-archive mirrors
  (web.archive.org) also failed and scholar.archive.org rate-limited after one call. **Persian full texts therefore could
  not be read**; the Persian priority targets (Ebnesina officer-cadet norms paper, Journal of Military Medicine anthropometry
  papers, Magiran/SID hits) are listed in the paper index with 0 rows and their URLs so they can be fetched from another
  network. Iranian data were instead taken from English-language Iranian journals hosted abroad (Brieflands JAMM) and PMC.
* Arabic portals IASJ (iasj.net), ASJP (asjp.cerist.dz) unreachable (000/503); Saudi Medical Journal PDF (Bin Horaib 2013,
  n=10 500 military personnel) returns 403; Kuwait BMJ Mil Health 2025 paywalled. No Arabic-language military
  anthropometry paper with mean±SD could be read.
* DRDO publications server (publicationsdrdo.in / publications.drdo.gov.in) blocked PDF downloads (Gorkha soldiers paper).
* Indian Journal of Aerospace Medicine: older articles are served only through a JS PDF viewer (403 to direct fetch);
  three relevant IJASM papers (Joshi et al. fighter-stream cadets; Kapur et al. compatibility assessment; Verma & Singh
  regional anthropometry) could not be retrieved.
* WebSearch budget (200 calls per session) was exhausted; the second half of the run relied on Europe PMC/Crossref APIs.

## Coverage by country (rows extracted)

| Country | Papers with rows | Rows | Content |
|---|---|---|---|
| Israel | 5 | 55 | Hebrew recruit-survey paper (Tsur 2019, n=5 250, height/weight/BMI by sex at first call-up and enlistment); Hollander 2020 (73 640 male conscripts by training group); IDF infantry recruits 2025 (n=786); IDF officer-school cadets 2020-21 (n=1 208, mixed sex); heat-tolerance soldiers (n=70) |
| India | 5 | 39 | IAF trainee pilots 2007 (n=115, two measurement rounds: stature, sitting height, IAF leg/thigh length, weight); IAF helicopter cadets 2013 (n=64); IAF aircrew head length/breadth (n=834); IAF IAM volunteers 15 manual dimensions (n=205, mixed sex); DIPAS mechanized-forces seated dimensions with percentiles (n=600) |
| Iran | 3 | 22 | Officer trainees junior/senior (n=75+75, JAMM 2013); military staff 30-60 y (n=400, BMC Psychiatry 2023); Navy personnel RCT (2x25) |
| Pakistan | 2 | 4 | PAFMJ soldiers at CMH Okara: mean age and BMI only (n=2 187 and 2 215) |
| Saudi Arabia | 1 | 2 | military cadets with stress fractures (age, BMI; case cohort) |
| Bangladesh, Jordan, Nigeria, Kenya, Ghana, South Africa, Kuwait, Sri Lanka | 0 | 0 | papers examined but no usable mean±SD (see index notes) |

## Exclusions and why

* Prevalence-only obesity papers (Bangladesh JAFMC 2018, Jordan JRMS 2018, Kenya ISRN 2013, Saudi SMJ 2025, Iran IJPH 2025):
  BMI categories only, no means.
* Nigerian para-military paper (Prestige J Educ 2020): NSCDC/FRSC/NIS are civil para-military services, means printed
  without SD, and the BMI table (14-16 kg/m²) is inconsistent with the height/weight means – excluded.
* Pakistan cut-off-heights paper (Anthropological Notebooks 2021): school students, not military.
* Chadha 2006 (IJASM): civil aircrew.
* PMC8419937 (Iran, BMC Cardiovasc Disord 2021): duplicate cohort of PMC10053979; waist/hip circumference printed as
  46/49 cm (unit error) – not used.
* Search snippets/abstract-only numbers (Ebnesina cadets 175.36±5.91 cm; SA soldiers 1711.5±61.6 mm; Sri Lanka BMI 21.4
  from a retracted BMC Res Notes paper) were **not** entered.
* Israeli pre-conscription adolescent BMI registries (e.g. 2.8 million 17-year-olds 1977-2020, PMC8715587) were noted
  but not extracted: examinees are pre-enlistment adolescents, and the papers give trends rather than plain mean±SD tables.

## Translation and definition notes

* Hebrew paper (Tsur 2019): גובה = height, משקל = weight, צו ראשון = first call-up (draft-board examination ~1.5 y before
  enlistment), יום הגיוס = enlistment day (Bakum induction base), מלש"בים = conscription candidates. Rows at first call-up
  are labelled as such; the enlistment-day rows are the military recruit values.
* IAF selection anthropometry (Sharma 2007, Sharma 2013, Chandran 2025): "leg length" = buttock-to-heel length and "thigh
  length" = buttock-to-knee length measured seated per IAF policy, not ISO 7250; stored as `other:leg_length_iaf` and
  `other:thigh_length_iaf`. "Sitting height" is erect sitting height (vertex to seat). Chandran 2025 "shoulder width" has no
  stated definition (stored as `other:shoulder_width`); "mid shoulder height" and relaxed eye height stored as `other:`.
* DIPAS mechanized forces (Kakkar 2024): "Hip breadth" measured seated (mapped to `hip_breadth_sitting`), "Sitting shoulder
  height from seat surface" mapped to `acromion_height_sitting`.
* Hollander 2020 height SDs (11-21 cm) come from an administrative database and are implausible; kept as printed with a
  warning. Kamran 2015 (CAD) age SD 1.501 for an 18-52-y sample is implausible; kept with warning. Sharma 2013 height SD
  printed as "24" was dropped (mean kept).
* Quality: A = born-digital PDF tables I checked (Tsur 2019, Sharma 2007, Chandran 2025, Kakkar 2024); C = values read
  from web/XML tables or from running text of PDFs.

## Candidate surveys for the catalog

* **Indian Air Force aircrew anthropometry survey 2013** – cited in Biswal & Dahiya 2019 (Indian J Aerosp Med 63(1):8-15,
  "833 fighter aircrews sourced from the IAF anthropometry survey 2013") and used in Biswal & Swamy 2020 (834 male aircrew,
  head length/breadth). Institute of Aerospace Medicine, Bengaluru. Dimensions include stature, sitting height, leg length,
  thigh length, buttock-knee length, eye height, head dimensions. Summary statistics not published in full; the catalog
  "India" entry should note this survey. Links: https://indjaerospacemed.com/principal-component-analysis-the-path-ahead-for-aircrew-aircraft-compatibility-at-the-institute-of-aerospace-medicine/ ,
  https://indjaerospacemed.com/content/110/2020/64/1/pdf/IJAM-64-018.pdf
* **DRDO-DIPAS Indian Army 3D anthropometric sizing survey** (7 956 male personnel scanned with SYMCAD; combat uniform
  sizing; "Digital avatar of Indian defence males", 2023) and **DIPAS mechanized-forces seated anthropometry** (600
  soldiers, 2024, IJISET 11(3):33-45) – see paper index; the 7 956-person survey itself was not retrieved (ResearchGate only).
* **IDF Medical Corps recruit anthropometric survey** (ענף בריאות הצבא) – ~5% sample of every enlistment cohort with height
  and weight at first call-up and at enlistment (2010-2012, 2015-2016 waves used by Tsur et al. 2019). Only height, weight,
  BMI. Source: Tsur et al. 2019, Journal of Israeli Military Medicine 16(1):16-21 (Hebrew).
* **Saudi Armed Forces obesity survey 2009-2011** (Bin Horaib et al. 2013, Saudi Med J 34:401-407; 10 500 active personnel,
  five military regions, WHO STEPS anthropometry) – full text not retrievable here (403).

## Limitations

The run reached almost none of its Persian/Arabic priority targets because of network blocking of .ir, Iraqi and Algerian
hosts, and the WebSearch budget ended before Hebrew-, Arabic- and Persian-specific follow-up searches could be run. The Israeli
aircrew 1981 survey: no published summary was found. No Egyptian, Iraqi, Sudanese, Emirati, Nepalese or Sri Lankan military
paper with anthropometric means was found in the reachable sources. All extracted rows come from documents actually read;
n values are study totals unless a per-group n is printed.
