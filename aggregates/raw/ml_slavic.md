# ml_slavic: Slavic-language military anthropometry search (Russian, Ukrainian, Belarusian, Polish, Czech, Slovak, Serbian/Croatian/Bosnian, Slovenian, Bulgarian)

Outputs: `aggregates/raw/ml_slavic.csv` (333 rows, validated), `aggregates/raw/ml_slavic_papers.csv` (27 sources examined, 14 with rows), PDFs in `reports/openaccess/` (26 files, slug-named).

## Method

Searches were written in each language (web search, then site searches and Crossref/journal APIs once the web-search budget was exhausted). Queries used, by language:

* **Russian**: «антропометрические показатели военнослужащих», «антропометрические показатели призывников длина тела масса тела», «антропометрические характеристики курсантов военного вуза», «антропометрические показатели лётчиков рост сидя», «физическое развитие военнослужащих по призыву окружность грудной клетки», «соматотип военнослужащих контрактной службы», «типовые фигуры военнослужащих ГОСТ», «Военно-медицинский журнал антропометрическое обследование». Sources: CyberLeninka (HTML full text readable; the `/pdf` endpoint works for some articles and returns a CAPTCHA page for others), science-education.ru (redirect loop, unreadable), BSMU Minsk PDF server, Zenodo, meganorm.ru (GOST scans), Crossref.
* **Ukrainian**: «антропометричні показники курсантів військовослужбовців зріст маса тіла», «Український журнал військової медицини антропометричні», «курсанти ВВНЗ довжина тіла маса тіла M±m». Sources: journals.uzhnu.uz.ua (OJS, PDF served), ujmm.org.ua (site search returned nothing), znp-vo.nuou.org.ua (503), Crossref for ISSN 2708-6623.
* **Belarusian/Russian (Belarus)**: BSMU «Военная медицина» PDFs.
* **Polish**: «pomiary antropometryczne żołnierzy kadetów wysokość ciała masa ciała Lekarz Wojskowy», «podchorążowie badania somatyczne WAT AWL», «Polish Journal of Aviation Medicine pilots anthropometric». Sources: lekarzwojskowy.wim.mil.pl (PDF served), Zenodo/JEHS, CEJSH (403), Crossref for ISSN 0024-0745. The three Polish PMC papers already in `openaccess_articles` were skipped.
* **Czech/Slovak**: «antropometrické charakteristiky vojáků AČR tělesná výška hmotnost», «Vojenské zdravotnické listy», «Univerzita obrany studenti antropometrie», «Akadémia ozbrojených síl kadeti telesná výška hmotnosť», «Vojenské reflexie». Sources: mmsl.cz (PDFs served), mo.gov.cz (Vojenské rozhledy issue PDFs), journals.muni.cz, Crossref for ISSN 0372-7025 and 1210-3292.
* **Serbian/Croatian/Bosnian/Montenegrin**: «antropometrijske karakteristike vojnika pitomaca Vojnosanitetski pregled», «kadeti Vojne akademije telesna visina», «pripadnici Vojske Srbije morfološke karakteristike», «Hrvatska vojska antropometrija vojnici hrcak», «Vojska Crne Gore morfološke karakteristike». Sources: SCIndeks (scindeks-clanci.ceon.rs served all VSP and Vojno delo PDFs; doiSerbia itself returned 503/000 to every request), siz-au.com, sportnaukaipraksa.vss.edu.rs, Crossref for ISSN 0042-8450 and free-text Crossref queries (which surfaced the Vojno delo cadet papers). Hrčak answered HTTP 418 to all requests, so Croatian journals could not be read.
* **Slovenian**: «antropometrijske značilnosti vojakov Slovenska vojska telesna višina», «Slovenska vojska vojaki antropometrija ITM». The only substantive hit (KIMDPŠ report «Analiza zdravstvenega stanja poklicnih vojakov») sits behind a browser-verification page.
* **Bulgarian**: «антропометрични показатели военнослужещи курсанти ръст тегло», «Военна медицина антропометрични военнослужещи Българска армия», «Naval Academy Varna cadets anthropometric». Sources: journals.mu-varna.bg (PDF served), conf.uni-ruse.bg (proceedings PDF served).

Extraction rule: only numbers read in the fetched full text (tables or explicit text). Scanned PDFs (Kazakov 2007; the Glavač 2015 table image) were OCR'd with RapidOCR and every used cell was checked against a second source (the CyberLeninka HTML text, or the printed mean differences in the table); those rows are quality B. Everything else from born-digital PDFs is quality A; the one HTML-only article is quality C.

## Coverage by country

| Country | Sources with rows | Rows | What |
|---|---|---|---|
| Czech Republic | Fajfrová 2016 (VSP), Fajfrová 2017 (MMSL), Soumar & Oberman 2010 (Vojenské rozhledy), Kinkorová & Vrba 2015 | 210 | Whole-army preventive-examination means (age, height, weight, BMI, waist) for men and women each year 1999-2009 and 2015; CASRI combat/non-combat/elite/basic-training/battalion samples (circumferences, skinfolds, %fat, WHR); military PE students |
| Serbia | Marić 2018, Vajić 2019 (Vojno delo), Glavač 2015 (VSP) | 67 | Military Academy cadets at entry (2004, 2014) and at graduation (2008, 2018): height, arm/leg length, mass, chest and forearm girth, 3 skinfolds; Military High School boys 15-18 y (height, mass, BMI, abdominal girth) |
| Russia | Gaivoronsky & Semenov 2022 (women), Gaivoronsky et al. 2022 (men), Kazakov 2007 | 26 | 17-y applicants to a military university (height, sitting height, head dimensions, chest girth, mass); conscripts in Murmansk 2005 (height, mass, chest girth, BMI with SE-derived SD and P50) |
| Poland | Lenart 2016 | 21 | Land Forces officer cadets, Wrocław (height, weight, BMI, BIA components) |
| Ukraine | Fedyk et al. 2026 | 4 | Zhytomyr Military Institute cadets: BMI only |
| Bulgaria | Nikolova et al. 2020 | 4 | Naval Academy first-year cadets: mean height and weight by sex (no SD) |
| Belarus | Lebedev & Moschik (2007 draft) | 1 | Conscript BMI mean/SD/median |

Zero-row sources (all listed in the papers index with the reason): Shirko et al. 2015 (scoring method only), Pravdová 2018 (programme description), Krutišová 2024 and Novák 2024 (percentages / tiny clinical sample), Gawron 2025 (review), Marić 2013 and Golubović 2021 (fitness tests only), Pelva 2018 (BMI without sub-group n), Idrizović & Banjević 2013 Montenegro (regression coefficients only), Stoyanova 2025 (student paper, ranges only), Bobojonova 2022 Uzbekistan (internally inconsistent foot table), GOST 20881-91 and GOST 23167-91 (size-class tables, no means).

## Exclusions and things not found

* **Russian Air Force / pilots**: no open article with mean ± SD body dimensions of Russian military aircrew was found; hits were regulations (VLEK height limits 160-190 cm, sitting height ≤ 95 cm) and ergonomics textbooks. eLibrary.ru abstracts were not reachable through the proxy; «Военно-медицинский журнал» and «Вестник Российской ВМедА» archives are not full-text searchable from outside.
* **Russian GOST/OST**: GOST 20881-91 and GOST 23167-91 were downloaded (meganorm scans) and inspected. They contain the typological composition (height classes 152-194 cm × chest girth 84-124 cm × waist classes) and per-size-class values of ~60 dimensions for five categories of Soviet servicemen (officers/warrant officers, cadets, conscripts, marine/airborne conscripts, servicewomen), plus percentage size scales for head, hand girth and foot length. They carry no sample means, SDs or n and were therefore not converted to rows; see "Candidate surveys" below.
* **Slovakia**: nothing readable. The only Slovak military anthropometric numbers seen are secondary (Kinkorová & Vrba 2015, Tab. 3: 45 Armed Forces Academy students, 180.6 ± 5.0 cm, 79.4 ± 8.8 kg, citing an Olomouc thesis by Mašková 2009); not extracted.
* **Croatia, Bosnia, Slovenia**: Hrčak blocked scripted access (HTTP 418) and the Slovenian KIMDPŠ report is behind a JS challenge; no rows.
* **Montenegro**: the JASPE paper "Morphological and functional characteristics of army recruits and professional soldiers of Montenegro Armed Forces" and PMC7475623 (BMI and body fat of Montenegrin armed forces personnel by age) are in English and were left to the English-language pass; the 2023 Int. J. Morphology paper on "naval saboteurs and ground special forces" (10.4067/s0717-95022023000100156) is another English lead.
* CyberLeninka search pages and several article PDFs return a CAPTCHA; the HTML article pages remain readable with a browser user-agent.
* Web-search budget (200 calls) was exhausted about two thirds of the way through; the remaining discovery used Crossref (`/journals/{issn}/works?query=`) and journal-site URLs.

## Translation and unit notes

* Serbian cadet tables (Vojno delo) print no units: heights, lengths and girths are in mm, body mass in 0.1 kg (text quotes 58-109.3 kg against table 580-1093) and skinfolds in 0.1 mm (table 40-400); rows were converted accordingly and the assumption is stated in `notes`. «Максимални обим подлактице» (maximum forearm girth) and «дужина руке/ноге» (arm/leg length, landmarks not defined) are recorded as `other:` keys.
* Russian «M±m» / «M±mx» means mean ± standard error. For Kazakov 2007 and Fedyk 2026 the SD column is m × √n and is flagged in `notes`. In the two Gaivoronsky 2022 papers the printed ± values contradict the printed coefficients of variation (e.g. stature 165.5 ± 4.4 cm with Cv 15.7 %), so only the means were entered and the ± value is quoted in `notes`.
* Glavač 2015 "AC" is the abdominal circumference at navel level (tape), mapped to `waist_circumference` with a note; Kazakov's «обхват груди в паузе» is chest girth at rest.
* CASRI (Soumar & Oberman 2010) skinfold sites (tvář = cheek, pod bradou = chin, kl. kost = clavicle, pod prsy = chest, lopatka = subscapular, spina = suprailiac, nadloktí = upper arm, předloktí = forearm, lýtko = calf) and circumferences are recorded as `other:` / harmonized keys with the Czech label kept in `measure_label`; side and arm flexion are not stated.
* Fajfrová 2016/2017 samples are the age-triggered extended preventive examinations (soldiers aged 25, 30, 33, 36 and ≥ 39), so they over-represent soldiers over 35; this is noted on every row.
* The Bulgarian 2020 table prints only means and ranges (recorded with blank SD); the Bulgarian cadets are "Military Doctor" / naval cadets of the Naval Academy (ВВМУ).

## Candidate surveys for the catalog

* **Czech Army preventive-examination database (AČR, Agentura vojenského zdravotnictví / Univerzita obrany)** — annual compulsory examinations of all professional soldiers since 1999; Fajfrová et al. 2016 (Vojnosanit Pregl 73(5):422-428, doi 10.2298/VSP141120112F) tabulate height, weight, BMI and waist circumference (mean ± SD) for 4056-7496 men and 330-975 women per year 1999-2009; Fajfrová et al. 2017 (Mil Med Sci Lett 86(2):52-57, doi 10.31482/mmsl.2017.009) give 2015 (9009 men, 1248 women). Dimensions: age, stature, mass, BMI, waist. Links: https://scindeks-clanci.ceon.rs/data/pdf/0042-8450/2016/0042-84501605422F.pdf ; https://www.mmsl.cz/pdfs/mms/2017/02/02.pdf. Not a dimensional survey but a whole-force height/weight register.
* **CASRI long-term testing of Czech soldiers 1993-2007** — Soumar L, Oberman Č. Vojenské rozhledy 2010;19(4):174-189: 9622 soldiers (of 15133 tested persons) with height, weight, BMI, WHR, 10 skinfolds, 8 circumferences, %fat, strength and ergometry; only sub-sample tables printed. Link: https://www.mo.gov.cz/assets/multimedia-a-knihovna/casopisy/vojenske-rozhledy/vr4_10.pdf.
* **Soviet military clothing-size standards GOST 20881-91 and GOST 23167-91 (1991)** — the public face of the Soviet/Russian military anthropometric survey underlying the catalog entry "Russian GOST/OST standards": typical-figure dimension tables (~60 dimensions incl. head, hand and foot) for officers, cadets, conscripts, marines/airborne and women, with percentage size distributions. Links: https://meganorm.ru/Data2/1/4294832/4294832689.pdf ; https://meganorm.ru/Data/385/38507.pdf. The underlying survey report (sample, year) is not identified in the standards.

## Limitations

* No usable data for Slovakia, Croatia, Bosnia and Herzegovina, Slovenia; Ukraine and Belarus only yielded BMI.
* Russian material is thin because the large Russian literature (VMedA theses, «Военно-медицинский журнал») is not open access and CyberLeninka search is CAPTCHA-protected; the two Gaivoronsky papers have ambiguous dispersion statistics.
* Several Czech rows (Tab. 2, 4 of Soumar & Oberman) are means without SD, and the basic-training table has no n.
* Percentiles for the Kazakov conscripts exist at P3/P10/P25/P50/P75/P90/P97; only P50 fits the schema.
