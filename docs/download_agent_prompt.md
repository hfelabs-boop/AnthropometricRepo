# Prompt for a computer-use / coding agent: download the papers

Copy everything below the line into the agent (Codex, Claude computer use, or similar). Run it in a **browser session that is already signed in with the university or library access you want used**.

---

## Role and goal

You are a careful research assistant with control of a web browser and a file system. Download the full-text PDF of each of the 19 papers in the table below and save each in the directory tree described here. Do this only through legitimate routes: the publisher's own page, the open-access copy the publisher or a repository provides, or the institutional access already active in this browser.

## Rules you must follow

1. **Legitimate access only.** Never use Sci-Hub, LibGen, shadow libraries, or any site that offers a paper without the publisher's or author's permission. Do not try to defeat a paywall, a CAPTCHA, or bot protection.
2. **Never type or handle passwords, one-time codes or payment details.** If a page asks you to sign in, pay, or approve cookies beyond "reject non-essential", stop that paper, mark it `needs_login`, and go on to the next one. If the browser session is not signed in, say so in the final report; do not try to sign in yourself.
3. **Do not submit anyone's email address, name or institution to any website** (including open-access finder tools that ask for an email). Use only the links in the table.
4. **Download PDFs only.** Do not install software, run downloaded files, accept browser extensions, or click ads.
5. Be polite: wait 8-15 seconds between requests to the same site, and make at most 2 attempts per link.
6. If something looks wrong (a login wall you did not expect, a page asking for personal data, a download that is not a PDF), stop that item and report it.

## Where to save

Create a directory `military-anthropometry-papers/` (use the browser's download folder if you cannot choose one, then move the files). Inside it, create one sub-directory per country/topic and save each PDF under the name in the `save_as` column. Example: `military-anthropometry-papers/Oman/AlWardi_2016_Oman_military_aviation_anthropometry.pdf`. If a paper's citation is marked incomplete, save it under the given name anyway.

## Steps for each paper (in table order)

1. Open the **direct link**. If it is a DOI (`https://doi.org/...`) it will redirect to the publisher.
2. Look for a **PDF** or **Download PDF** button, or a "Full text (PDF)" link. Prefer the publisher's version. If there is a free "Open access" or "PMC" version, use it.
3. If the publisher page has no PDF for you (paywall), try the **alternative links** in order (repository copies, PubMed Central, SciELO, institutional repositories). Stop at the first that gives a real full-text PDF.
4. **Check the file** before keeping it:
   - it opens as a PDF with more than one page (abstract-only stubs are 1-2 pages: mark those `abstract_only`);
   - the first page shows the paper's title or the citation's title/authors (compare with the table);
   - the file is larger than 50 KB and is not an HTML page saved with a .pdf name.
5. Save it under the `save_as` path. If a file with that name exists, do not overwrite it; append `_2`.
6. Add one line to `manifest.csv` (see below) and go to the next paper.

A few entries have no direct link (marked "search" in the alternative-links column as well): search for the exact title on the listed sites for at most 5 minutes; if it is not found, mark `not_found`.

If a paper has no PDF you can legitimately get, do not force it: record the reason and move on. The person who sent you this list will fetch those by another route.

## Manifest (required)

Write `military-anthropometry-papers/manifest.csv` with one row per paper and these columns:

`id, status, saved_path, source_url_used, pages, size_kb, title_check, note`

- `status` is one of: `downloaded`, `abstract_only`, `needs_login`, `paywalled`, `captcha_or_blocked`, `not_found`, `wrong_paper`, `error`.
- `title_check` is `match` or `mismatch` (whether the first page matches the citation).
- `note` is one short sentence when the status is not `downloaded`.

## Final report

When finished, reply with: how many papers have status `downloaded`; a list of the others with their statuses and the one-line notes; any paper whose first page did not match its citation; and the full path of the directory and manifest. Do not include the contents of any paper.

## The papers

Tab-separated. Columns: number, id, direct link, alternative links (`|` separated), save_as, citation (start).

```
1	alwardi2016-oman	https://doi.org/10.1080/23311916.2016.1269384	https://www.tandfonline.com/doi/pdf/10.1080/23311916.2016.1269384?needAccess=true	Oman/AlWardi_2016_Oman_military_aviation_anthropometry.pdf	Al Wardi, Y. M., Jeevarathinam, S., & Al Sabei, S. H. (2016). Eastern bodies in western cockpits: An anthropometric study in the Oman military aviatio
2	dasilva2017-brazil-pilots	https://doi.org/10.1080/00140139.2017.1301575	https://pubmed.ncbi.nlm.nih.gov/28271959/	Brazil/daSilva_2017_Brazilian_Air_Force_pilots.pdf	da Silva, G. V., Halpern, M., & Gordon, C. C. (2017). Anthropometry of Brazilian Air Force pilots. Ergonomics, 60(10), 1445–1457. https://doi.org/10.1
3	dasilva2018-brazil-us	https://doi.org/10.1016/j.ergon.2018.01.016	https://www.sciencedirect.com/science/article/abs/pii/S016981411730433X	Brazil/daSilva_2018_Brazilian_vs_US_military_flight_deck.pdf	da Silva, G. V., Gordon, C. C., & Halpern, M. (2018). Comparison of anthropometry of Brazilian and US military population for flight deck design. Inte
4	lee2013-korea-helicopter	https://doi.org/10.1080/00140139.2013.776703	-	South_Korea/Lee_2013_Korean_male_helicopter_pilots.pdf	Lee, W., Jung, K., Jeong, J., Park, J., Cho, J., Kim, H., Park, S., & You, H. (2013). An anthropometric analysis of Korean male helicopter pilots for 
5	evans2025-uk-tri-service	https://doi.org/10.1080/00140139.2024.2378365	https://pubmed.ncbi.nlm.nih.gov/39082614/	United_Kingdom/Evans_2025_UK_Tri-Service_Anthropometry_survey.pdf	Evans, L., Pringle, R., & Lewis, E. (2025). Women are not small men: The UK's new, comprehensive Tri-Service Anthropometry survey. Ergonomics, 68(5), 
6	kayis1991-turkey	https://doi.org/10.1016/0003-6870(91)90012-7	-	Turkey/Kayis_1991_Turkish_army_men.pdf	Kayış, B., & Özok, A. F. (1991). The anthropometry of Turkish army men. Applied Ergonomics, 22(1), 49–54. https://doi.org/10.1016/0003-6870(91)90012-7
7	wibneh2020-ethiopia	https://doi.org/10.14429/dsj.70.15435	https://publications.drdo.gov.in/ojs/index.php/dsj/article/download/15435/7316	Ethiopia/Wibneh_2020_Ethiopian_army_personnel.pdf	Wibneh, A., Singh, A. K., & Karmakar, S. (2020). Anthropometric measurement and comparative analysis of Ethiopian army personnel across age, ethnicity
8	barraza2020-chile	https://revmedmilitar.sld.cu/index.php/mil/article/view/514	http://scielo.sld.cu/scielo.php?pid=S0138-65572020000200003&script=sci_abstract&tlng=en | https://repositorio.uvm.cl/items/a567b1b7-ad19-4d0a-b4ab-9c660fb00f25	Chile/Barraza_2020_Chilean_male_military_personnel.pdf	Barraza Gómez, F., Yáñez Sepúlveda, R., Tuesta Roa, M., Hecht Chau, G., Báez San Martín, E., & Henríquez Valenzuela, M. (2020). Características antrop
9	alzahrani2023-saudi	https://doi.org/10.7759/cureus.46593	https://pmc.ncbi.nlm.nih.gov/articles/PMC10625793/	Saudi_Arabia/Alzahrani_2023_Saudi_medical_recruits_fitness.pdf	Alzahrani, E., & Alyazedi, F. M. (2023). The impact of a 10-week military training course on Saudi medical recruits' fitness and physical activity lev
10	vaidya2009-india	https://pmc.ncbi.nlm.nih.gov/articles/PMC4921355/	https://doi.org/10.1016/S0377-1237(09)80090-7	India/Vaidya_2009_Indian_armed_forces_anthropometry.pdf	Vaidya, R., Bhalwar, R., & Bobdey, S. (2009). Anthropometric parameters of armed forces personnel. Medical Journal Armed Forces India, 65(4), 313–318.
11	shu2015-canada-cfas	https://doi.org/10.1016/j.promfg.2015.07.813	https://nrc-publications.canada.ca/eng/view/accepted/?id=828ecbbf-d18d-48ae-970e-9f8ffa9c453b | https://www.sciencedirect.com/science/article/pii/S2351978915008148	Canada/Shu_2015_Canadian_Forces_3D_anthropometric_survey.pdf	Shu, C., Xi, P., & Keefe, A. (2015). Data processing and analysis for the 2012 Canadian Forces 3D anthropometric survey. Procedia Manufacturing, 3, 37
12	oliveira2008-brazil-military	https://doi.org/10.1590/S0034-89102008000200005	https://www.scielo.br/j/rsp/a/94mR49x5KvYPQcRkHGcjNQP/?lang=pt&format=pdf | https://pubmed.ncbi.nlm.nih.gov/18372973/	Brazil/Oliveira_2008_Brazilian_active_duty_military.pdf	Oliveira, E. A. M., & Anjos, L. A. dos. (2008). Medidas antropométricas segundo aptidão cardiorrespiratória em militares da ativa, Brasil. Revista de 
13	mangan2018-cfas-lessons	https://publications.gc.ca/site/eng/9.881239/publication.html	https://publications.gc.ca/collections/collection_2019/rddc-drdc/D68-3-056-2018-eng.pdf	Canada/Mangan_2018_CFAS_lessons_learned.pdf	Mangan, B., Szyszlo, K., & Angel, H. (2018). 2012 Canadian Forces anthropometric survey - Lessons learned (January - April 2012) (Contract Report DRDC
14	drdc-cfas-report	https://cradpdf.drdc-rddc.gc.ca/PDFS/unc328/p803174_A1b.pdf	-	Canada/DRDC_CFAS_report_p803174.pdf	Defence Research and Development Canada. (n.d.). [Report on the 2012 Canadian Forces anthropometric survey; authors, title and report number not confi
15	hertzberg1963-nato	https://archive.org/details/lccn_63-17517	https://apps.dtic.mil/sti/citations/AD0421428	NATO_Turkey_Greece_Italy/Hertzberg_1963_AGARDograph73_Turkey_Greece_Italy.pdf	Hertzberg, H. T. E., Churchill, E., Dupertuis, C. W., White, R. M., & Damon, A. (1963). Anthropometric survey of Turkey, Greece, and Italy (AGARDograp
16	stewart1985-canada-aircrew	https://cradpdf.drdc-rddc.gc.ca/	https://apps.dtic.mil/sti/search	Canada/Stewart_1985_Canadian_Forces_aircrew.pdf	Stewart, L. E. (1985). 1985 anthropometric survey of the Canadian Forces aircrew (DCIEM Technical Report 85-12-01) [Report number as given in the rese
17	bolton1973-raf	https://apps.dtic.mil/sti/search	https://discovery.nationalarchives.gov.uk/	United_Kingdom/Bolton_1973_RAF_aircrew_1970-71.pdf	Bolton, C. B., et al. (1973). An anthropometric survey of 2000 Royal Air Force aircrew 1970/71. Royal Aircraft Establishment [Report number not verifi
18	dtic-ad0654762	https://apps.dtic.mil/sti/tr/pdf/AD0654762.pdf	https://apps.dtic.mil/sti/citations/AD0654762	Latin_America/DTIC_AD0654762_Latin_American_trainees_1965-66.pdf	[Earlier US Army report on Latin American armed forces trainees, 1965-66; title and authors not verified.] (1966). Defense Technical Information Cente
19	dtic-ad1100615	https://apps.dtic.mil/sti/tr/pdf/AD1100615.pdf	https://apps.dtic.mil/sti/citations/AD1100615	United_States/DTIC_AD1100615_Army_sizing_ANSUR_II_2020.pdf	[US Army sizing system memorandum based on ANSUR II, 2020; title and authors not verified.] (2020). Defense Technical Information Center, accession AD
```
