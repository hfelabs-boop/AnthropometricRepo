# ml_germanic: German, Dutch, Nordic, Baltic, Hungarian, Greek and Turkish military anthropometry search

Run name `ml_germanic`. Outputs: `aggregates/raw/ml_germanic.csv` (339 rows, validated with `scripts/validate_aggregates.py`, 0 problems), `aggregates/raw/ml_germanic_papers.csv` (37 sources examined, 15 with rows), PDFs in `reports/openaccess/` (not committed).

## Method

Web searches (WebSearch, budget of 200 queries exhausted) written in each assigned language, followed by direct fetches with curl/WebFetch, PDF text extraction with PyMuPDF and page rendering where tables were embedded as images (Bundeswehr 2024 Table 1, Honvédorvos 2017 Table II, Finnish weight chart, Dutch 1989 figures were checked against the rendered page).

Queries used (abridged):
* German: "Bundeswehr anthropometrische Vermessung Soldaten Körpermaße Mittelwert Standardabweichung", "Wehrmedizinische Monatsschrift Anthropometrie Soldaten Körpergröße Körpergewicht BMI", "Körpermaße Bundeswehr Bekleidung Größensystem Reihenmessung Bundesamt Ausrüstung", "3D-Reihenmessung Bundeswehr Ergebnisse", "Wehrwissenschaftliches Institut Sitzhöhe Reichweite", "Bundesheer Rekruten Körpergröße Stellungspflichtige Studie Österreich", "Anthropometrie Bundesheer Heerespersonalamt", "Schweizer Armee Rekruten Körpergrösse Gewicht BMI Rekrutierung Mittelwert", "Stellungspflichtige Statistik Austria durchschnittliche Körpergröße Geburtsjahrgang".
* Dutch: "TNO antropometrisch onderzoek militairen Koninklijke Landmacht lichaamsmaten rapport", "DINED antropometrische database militairen 3D scan", "TNO rapport antropometrie Nederlandse militairen kleding maatsysteem publications.tno.nl", "Nederlandse militairen lichaamsmaten gemiddelde standaarddeviatie".
* Swedish: "antropometrisk undersökning Försvarsmakten värnpliktiga kroppsmått FOI rapport", "diva-portal antropometri värnpliktiga flygförare Flygmedicin", "FOI rapport antropometriska mått svenska soldater uniform storlekssystem", "GIH diva antropometri soldater längd vikt medelvärde".
* Norwegian: "FFI rapport antropometri Forsvaret soldater kroppsmål høyde vekt", "Forsvarets sanitet FFI kroppssammensetning Krigsskolen kadetter", "brage.unit.no kadetter høyde vekt fettprosent", "Krigsskolen Sjøkrigsskolen Luftkrigsskolen kadetter høyde vekt ±".
* Danish: "Forsvaret værnepligtige antropometri højde vægt BMI undersøgelse rapport", "Danish conscripts height weight mean SD Forsvarets Dag", "Danmark soldater højde vægt kropssammensætning Forsvarets Sundhedstjeneste".
* Finnish: "varusmiesten antropometria pituus paino kehon koostumus Puolustusvoimat", "sotilaslääketieteen aikakauslehti antropometria kadetit pituus paino keskihajonta", "Sotilaslääketieteen aikakauslehti varusmiesten pituus paino vyötärönympärys taulukko", "Maanpuolustuskorkeakoulu kadetit kehon koostumus".
* Icelandic: "Landhelgisgæslan líkamsmælingar hæð þyngd" (Iceland has no army; nothing found for the Coast Guard).
* Estonian/Latvian/Lithuanian: "Eesti kaitseväe ajateenijate antropomeetrilised näitajad pikkus kehakaal", "Kaitseväe Akadeemia toimetised ajateenijate kehalised näitajad", "Latvijas Nacionālie bruņotie spēki karavīru antropometriskie rādītāji", "Latvijas karavīri zemessargi antropometrija ĶMI RSU", "Lietuvos kariuomenė karių antropometriniai rodikliai ūgis svoris".
* Hungarian: "katonák antropometriai vizsgálata testmagasság testtömeg Magyar Honvédség Honvédorvos", "Honvédorvos katonák testösszetétel testtömegindex átlag szórás állomány".
* Greek: "ανθρωπομετρικά χαρακτηριστικά στρατιωτών Ελληνικός Στρατός ύψος βάρος μελέτη", "σωματομετρικά Ευέλπιδες Ναυτικοί Δόκιμοι Ικάρων μέση τιμή τυπική απόκλιση", "στρατεύσιμοι ανθρωπομετρικές μετρήσεις νεοσύλλεκτοι", "Σχολή Ευελπίδων σωματομετρικά τυπική απόκλιση δοκίμων".
* Turkish: "askeri personel antropometrik ölçümler ortalama standart sapma dergipark", "pilot antropometrik ölçümleri Türk Hava Kuvvetleri kokpit", "Harp Okulu öğrencileri antropometrik boy kilo vücut yağ", "askerlik yükümlüleri boy kilo ortalaması er erbaş Gülhane", "dergipark askeri öğrenci harp okulu astsubay antropometrik ortalama±SS", "Türk Silahlı Kuvvetleri personeli antropometrik ölçüm koruyucu giysi tez", "pilot antropometrik Hava Kuvvetleri tez YÖK oturma yüksekliği", "Kayış Özok 1991 Türk askerleri antropometrik ölçüm raporu".

Portals used directly: DiVA (blocked, see below), FOI/FFI publication pages, publications.tno.nl, militairespectator.nl, DTIC (blocked), Wehrmedizinische Monatsschrift (wmm.pic-mediaserver.de, OPUS/FIZBw repository, military-medicine.com), puolustusvoimat.fi / logistiikkalaitos.fi / julkari.fi / jyx.jyu.fi, real.mtak.hu and epa.oszk.hu (Honvédorvos), DergiPark, portalcris.lsmuni.lt, digar.ee and dspace.ut.ee, rsu.lv, statistik.at, forsvaret.dk, ssb.no, bag.admin.ch.

## Coverage by country (rows)

| Country | Source(s) | Rows | Content |
|---|---|---|---|
| Austria | Statistik Austria Stellungsergebnisse (cohorts 1972-2006) | 104 | mean height, weight, waist of all men liable for service per birth cohort (n 36-48 k per cohort, no SD) |
| Denmark | Forsvarets Dag statistics Oct 2025 | 87 | mean measured height per session half-year, men 1852-2025 and women 2006-2025 (no SD) |
| Finland | Reservist study 2015 (report 2016); VARU conscript study 2007 (KTL 2008); KRITOKY 2020; DF fitness statistics 2021 | 71 | reservists men/women height, weight, BMI, waist, fat% with SD (2003/2008/2015); conscripts 2007 BMI/waist/fat% by brigade; peacekeepers; yearly mean conscript weight 1993-2021 |
| Switzerland | Matthes/Staub 2020 BLV/BAG report | 18 | 2019 conscription examinees by age group: height, BMI, waist, WHtR with SD and n (n=24 419) |
| Norway | SSB table SÅ 108 | 15 | mean height 1910-2010 and weight 2000-2010 measured at session (no SD) |
| Hungary | Honvédorvos 2025 (Novák), 2017 (Juhász) | 24 | 2024 basic-training recruits (n=265) age/height/weight/waist/hip/fat/muscle/grip with SD; obese programme participants by sex |
| Netherlands | Schuffel 1989 (Dutchmil '85) | 8 | 1985 KL soldiers: stature, weight, eye heights, elbow rest, popliteal height, buttock-popliteal and buttock-knee length (mean, SD) |
| Germany | Scheit 2024 WMM; Scheit 2020 WMM | 5 | 40 165 Bundeswehr soldiers 2018-22 age/BMI/waist mean, SD, median; medical officers' waist by sex |
| Turkey | Ulaş & Genç 2010 | 4 | military hospital personnel (mixed) age/height/weight/BMI |
| Lithuania | Česnavičienė 2007 thesis | 3 | conscripts mean height/weight/age (no SD) |
| Sweden, Estonia, Latvia, Greece, Iceland | – | 0 | see below |

## Excluded / not extractable and why

* Sweden: the key sources exist on DiVA – FMV Försökscentralen/Flygmedicinsk rapport FM 72:7 (anthropometric-morphological survey of c. 900 conscripts at Göteborg, Solna, Boden 1971-72), a companion hand-measurement report (diva2:1138182, photographic hand measurements of conscripts at enrolment 1971) and diva2:1138180, plus GIH soldier physiology reports. Every request to diva-portal.org (www, gih, su, kth mirrors; https and http; Wayback) ended in "connection reset by peer" or HTTP 503, so nothing could be read. These are the top retry targets.
* Norway: Brage (fhs.brage.unit.no, nih.brage.unit.no) was unreachable through the proxy (CONNECT 502 / DNS failure); FFI 2017 report has no anthropometric tables; SSB values from 2011 on are self-reported and were not extracted.
* Netherlands: TNO 3D-scan/clothing reports are on DTIC, which returns 403; Ellens 1993 contains only civilian CBS trends. The Dutchmil '85 database itself is unpublished; only Schuffel's summary was usable.
* Germany: the 2010 BFT evaluation study (4 863 soldiers) tabulates height/weight/BMI/waist by sex but Table 1 is served only as an image that returned 404; the Bundeswehr 3D-Reihenmessung 2022 (Avalution, c. 2 500 soldiers) has no published statistics; wehrmed.de articles redirect to a portal front page; Truppendienst 2003 (147 female Bundesheer soldiers) is a dead link.
* Finland: six issues of Sotilaslääketieteen aikakauslehti (2020-2025) were text-screened without finding mean/SD anthropometric tables; the VAFYKO 2022 report gives only change scores; the Lääkärilehti 2019 register study is civilian primary-care data. The two Finnish PMC papers already in the repository were skipped as instructed. Heights in the DF 2021 weight/height chart are unlabelled and were not extracted.
* Estonia: Novikov 2005 (567 conscripts) gives ranges and decile BMI changes only; Jürgenstein 2025 gives test scores only.
* Latvia/Lithuania: the RSU dissertation is civilian; the 2017 Pļaviņa abstract on combat-endurance course participants could not be retrieved; the Lithuanian volunteer-forces PMC paper was already extracted; a Lithuanian sports-science article on rowers was a false positive.
* Greece: only admission standards (height/BMI limits on mod.mil.gr, geetha.mil.gr, PD 11/2014) surfaced; a UoA thesis found by the query was on handball players. No Greek-language military study with statistics was found.
* Turkey: no Turkish-language report of the Kayış & Özok 1989-91 army survey (5 109 soldiers, 51 dimensions) was found; Kaya & Özok 2017 only cites it. The police-candidate anthropometry paper (POMEM) was excluded as non-military. Regulatory height/weight tables (TSK Sağlık Yeteneği Yönetmeliği) are limits, not statistics.
* Iceland has no armed forces; nothing on the Coast Guard.
* Denmark: BMI is published only as category percentages; DST analysis page yielded no numbers.

## Translation notes

* Dutch "zithoogte" in Schuffel 1989 is the seat (popliteal) height (E5 in his figure), not sitting height; "zitdiepte" = buttock-popliteal length; "bil-kniediepte" = buttock-knee length; "elleboog-zitvlakhoogte" = elbow rest height.
* Finnish "vyötärönympärys" (waist, measured midway between iliac crest and lowest rib in the VARU and reservist studies) was mapped to `waist_circumference` with a note; "rasvaprosentti" = body-fat %.
* Hungarian "testzsírfrakció (kg%)" / "testizomfrakció" are body-fat and muscle percentages of body mass; "derékkörfogat" = waist, "csípőkörfogat" = hip; "marokszorító erő" = handgrip strength (newtons).
* German "Stellungspflichtige" (Austria/Switzerland) = men liable for military service examined at conscription; "Taillenumfang"/"Bauchumfang" = waist circumference; Ø = mean.
* Danish "sessionshalvår" = half-year session period; "gennemsnitshøjde" = mean height.
* Austrian year_start = birth cohort + 18 (Hauptstellungsjahr), flagged in notes as an approximation.

## Limitations

* Many rows (Austria, Denmark, Norway SSB, Finnish yearly weights, Finnish VARU tables) are population means without SD; they are large-sample official statistics rather than per-subject datasets.
* Quality B rows: Dutch 1989 figure values (scanned article with text layer, checked against the page image) and Hungarian 2017 Table II (image, transcribed visually).
* Quality C rows: Scheit 2020 (values quoted in article text), SSB SÅ 108 (web table), Lithuanian thesis (means only).
* The Danish women's height table starts with a row labelled "1. halvår 2023" that is evidently "1. halvår 2025" (noted in the row).
* Search budget was exhausted before the Turkish pilot/Harp Okulu, Greek cadet and Baltic academy searches could be deepened.

## Candidate surveys for the catalog (not in catalog/surveys.yaml)

1. **Dutchmil '85** (Netherlands, Koninklijke Landmacht): 1985 anthropometric survey of 1 010 male soldiers, c. 80 dimensions (80 000 measurements) for the PSU'80 combat-clothing sizing system; selection 1.57-1.99 m; TNO Instituut voor Zintuigfysiologie, Soesterberg. Summary: Schuffel H., Militaire Spectator 158(1), 1989, pp. 13-18 (https://www.militairespectator.nl/sites/default/files/bestanden/uitgaven/1989/1989-0013-01-0010.PDF). The catalog's "Dutch military 3D scan paper" entry is a different, later source.
2. **Swedish conscript anthropometry 1971-72** (FMV Försökscentralen / Flygmedicinsk rapport FM 72:7): anthropometric-morphological field study of about 300 conscripts at each of Göteborg, Solna and Boden, aimed at uniforms, personal equipment, vehicle space and reach; companion photographic hand-measurement study of conscripts at enrolment autumn 1971. DiVA records diva2:1138137, diva2:1138182, diva2:1138180 (not readable in this session).
3. **Bundeswehr 3D-Reihenmessung 2022** (Germany): 3D body-scan survey of c. 2 500 soldiers commissioned by BAAINBw and executed by Avalution for clothing/equipment sizing (esut.de 2023, wehrtechnik.info 2022); no statistics published yet.
4. **Kayış & Özok Turkish army survey 1989** (Turkey): 51 dimensions on 5 109 soldiers, published in Applied Ergonomics 22(1):49-54, 1991 (paywalled); the catalog's "Turkish army men" entry may already refer to this – check.
5. **Statistik Austria Stellungsergebnisse** (Austria): annual medical examination of all men liable for service (c. 37 000-48 000 per cohort since 1972) with height, weight, waist (from cohort 1990), BMI and WHtR; only means and class distributions are published (ODS files on statistik.at).
6. **Danish Forsvarets Dag statistics** (Denmark): measured height and BMI of every man attending the conscription day (c. 25 000-35 000 per year) and volunteering women, published semi-annually by the Ministry of Defence Personnel Agency.
7. **Kokare I. (1998) Latvian soldiers 1939 and 1996** (Latvia): doctoral thesis "Latvijas karavīru bioloģiskā statusa izvērtējums, pamatojoties uz 1939. un 1996. gada izpētes datiem", Riga, 187 pp., based on anthropological measurements of Latvian Army soldiers in 1939 and 1996 (cited in the RSU dissertation; not online).
