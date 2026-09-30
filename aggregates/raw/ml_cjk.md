# ml_cjk — Chinese, Japanese, Korean, Vietnamese, Thai, Indonesian/Malay, Filipino military anthropometry

Run name `ml_cjk`. Outputs: `aggregates/raw/ml_cjk.csv` (143 rows, validator: 0 problems), `aggregates/raw/ml_cjk_papers.csv` (30 papers examined, 12 with rows), PDFs in `reports/openaccess/` (15 files, slugs in the paper index).

## Method

Tools that worked from this container: J-STAGE search API (`api.jstage.jst.go.jp/searchapi`), J-STAGE PDFs, CiNii OpenSearch (metadata only), KoreaScience PDFs by JAKO id, KCI article pages (WebFetch), Google Scholar via plain `scholar?hl=xx&q=` curl (Chinese, Korean, Japanese, Vietnamese, Thai, Indonesian, Malay queries), ThaiJO OJS journal search (`/search/index?query=`), Vietnamese OJS journals (jmpm.vn, yhqs.vn, tapchiyhocvietnam.vn), Garuda (Indonesia), CQVIP (维普) search pages via WebFetch (abstracts only; article pages do not render), IOP/AJK/KSEP open PDFs, Taiwan MND website PDFs (self-signed TLS; fetched through WebFetch), OSTI abstract pages.
Blocked or exhausted: the shared WebSearch budget ran out after ~25 queries; OpenAlex free daily budget was exhausted; Semantic Scholar returned nothing; Bing/DDG/Startpage/Mojeek scrapes were blocked; CNKI (`wap.cnki.net`, `kns.cnki.net`) and Wanfang return 503/JS shells; Baidu Xueshu needs a captcha; Airiti (Taiwan) and DBpia/RISS (Korea) are paywalled; KCI/KoreaScience site search returns unrelated hits for Korean terms.

Queries (examples, per language): 
* Japanese: 自衛隊 人体計測, 自衛官 体格 身長 体重, 航空自衛隊 パイロット 人体寸法, 操縦者 身体計測調査, 航空医学実験隊 身体計測, 防衛大学校 学生 体格, 海上自衛隊 乗員 体格, 自衛官 BMI 身長 体重 平均, 自衛隊 女性隊員 体格, JASDF anthropometric.
* Korean: 군인 인체측정 평균 표준편차, 사관생도 신체조성 신장 체중, 공군 조종사 인체측정 인체치수, 병사 전투복 인체치수 조사, 해군 인체측정, 방탄복 치수 체계.
* Chinese: 军人 人体尺寸 测量 均值 标准差, 士兵 人体测量, 新兵 体格 调查 身高 体重, 飞行员 人体测量 GJB 4856, 中国军人服装用人体尺寸数据库, 海军 舰员 人体尺寸, 國軍 官兵 人體計測 (Taiwan), 石裕川 國軍 人體計測.
* Vietnamese: nhân trắc học bộ đội / quân nhân / chiến sĩ mới, chỉ số nhân trắc học viên, phi công quân sự.
* Thai: สัดส่วนร่างกาย ทหาร ค่าเฉลี่ย ส่วนเบี่ยงเบนมาตรฐาน, ทหารกองประจำการ ดัชนีมวลกาย ส่วนสูง น้ำหนัก, นักเรียนนายร้อย, กำลังพล กองทัพบก (ThaiJO: เวชสารแพทย์ทหารบก).
* Indonesian/Malay: antropometri prajurit TNI, antropometri taruna Akmil/AAU, antropometri anggota tentera Malaysia ATM purata sisihan piawai.
* Filipino/English: anthropometric Filipino soldiers Philippine Army/PMA cadets.

## Coverage by country

| Country | Rows | Sources with rows | Notes |
|---|---|---|---|
| Japan | 38 | JASDF 3rd anthropometric survey 1988 (Kakimoto et al. 1990 abstract, 18 dims × 2 sexes + age) | Scanned abstract, values read from the printed tables (quality B). The full 1970/1988/1998-99 survey reports (Aeromedical Laboratory reports) are not online. |
| South Korea | 43 | female soldiers 2023 (5), KAFA female cadets 2019 (3), KAFA male cadets 2018 (12) and 2022 (14), ROKAF pilot facial dimensions 2011 (9, means only) | Small samples; no open-access survey-scale data found; military 3D-scan raw data exist on data.go.kr (see candidates). |
| Indonesia | 8 | Army Infantry Bn 112/Raider 2020 (n=268; stature, segment lengths, weight, age, with P5/P95) | English-language IOP paper. |
| Taiwan | 8 | ROC Army field-unit questionnaire 2018 (self-reported height/weight/BMI, 272 M / 60 F) | Flagged self-reported. |
| Thailand | 12 | RTA physical-fitness survey 2005 (n=4,030 M / 393 F: age, weight, height, BMI, waist, hip) | Age-band rows in the table were not extracted (n per band not printed). |
| Vietnam | 28 | VPAF military pilots 2023 (n=292, by aircraft type) and Military Medical Academy cadets 2024-25 (n=88) | |
| Malaysia | 6 | Malaysian Army personnel 2012 (n=378), abstract only, quality C | Height SD printed 0.6 m in the abstract (probable typo). |
| China (PRC) | 0 | — | Key sources identified (PLA clothing database 1997-99; 3rd pilot survey 1,739 pilots / GJB 4856-2003; recruit studies) but all full texts are on CNKI/CQVIP/Wanfang, not reachable; abstracts print no means. |
| Philippines | 0 | — | Nothing found beyond historical height studies (Murray 2002, Bassino 2018) and civilian workers. |

## Excluded / zero-row papers and why

* JASDF 1989 abstract (ratios only), JASDF 2006 PCA paper (individual model values only), JGSDF smoking/COPD 2005 (no height/weight table), 1963 JGSDF physique abstract (no numbers).
* Korean helicopter pilots 2007 proceedings (defence-confidential, no tables; the 2013 journal version is already indexed), CBRN suit survey 2022 (size distribution only), smoking/obesity 2018 (prevalence only).
* Malaysian security personnel 2017 (AiMT): circumferences in inches by age group, but the "SD" column is a standard error and the sample is university security staff, not armed forces.
* Thai RTA NCD review 2025, conscript heat-illness 2014, conscript bone-density 2010: no anthropometric means.
* Chinese abstracts (夏鹏泽 2001, 郭小朝 2003, 何英强 2002, 张敏 2007) and Taiwan ROCAF student pilots 1998: paywalled, abstracts without means.
* Korean open government datasets (below) are raw individual records, not published statistics; no rows were computed from them.

## Translation notes

* Japanese 座高 = sitting height; 座位眼高 = eye height sitting; 股下高 = crotch height; 座位膝高 = knee height sitting; 殿-膝関節距離 = buttock-knee length; 前方腕長 = "armreach" (forward reach, definition not given); 肩幅 = shoulder breadth (biacromial vs bideltoid not stated → `other:shoulder_breadth`); 腰幅 = hip breadth standing; 殿囲 = hip (buttock) circumference; 大腿囲 = thigh circumference; 大腿最少囲 / "lower thigh circumference" = knee-level thigh girth; 肩最大囲 = shoulder circumference.
* Korean 젖가슴둘레 = bust circumference (mapped to chest_circumference), 엉덩이둘레 = hip circumference, 얼굴너비 = face width (assumed bizygomatic), 얼굴수직길이 = face length (assumed menton-sellion), 머리두께 = head length (glabella-opisthocranion), 입너비 = lip width, 턱길이 = chin length.
* Thai รอบเอว/รอบสะโพก printed in inches (converted ×25.4); Vietnamese vòng bụng = abdominal/waist circumference; tuổi đời = age, tuổi nghề = years of service.
* Indonesian paper is in English; "shoulder high" mapped to acromion height, "leg length"/"spine length" kept as `other:`.

## Candidate surveys for the catalog

1. **JASDF anthropometric surveys (Aeromedical Laboratory, Tachikawa)** — 1961/62 (239 pilots, 107 items; 医実報告 2(2):71-114, 1962), 1st survey 1970 (1,221 JASDF personnel, 108 items, means/SD/CV; 医実報告 12(1):53-62, 1971; compendium 『航空自衛隊員の身体計測値 装備品等設計のための人間工学的資料』 1972, CiNii CRID 1970023484848309272), 2nd survey 1979, 3rd survey 1988 (273 pilots, 442 maintenance, 269 WAF, 118-125 items; 医実報告 32(3):53-104, 1991 and 33(1·2):13-27, 1992), 4th survey 1998-99 (男性操縦士及び女性操縦士相当の身体各部計測値, mean/SD/P5/P95 for all items; 医実報告 44(1·2):13-24, 2004; 2010 projections in 42(2·3):39-69, 2002). Source: annotated bibliography 医実報告 47(2):141-279 (J-STAGE, saved as `ja-2007-nittami-aeromedical-lab-reports.pdf`); J-STAGE only hosts vol. 46 (2006) onward.
2. **PLA "Chinese military clothing anthropometric database" (中国军人服装用人体尺寸数据库)** — 1997-1999, 12,058 men and 3,964 women, 36 dimensions; Xia Pengze, Zeng Changsong et al., 纺织学报 2001(2):16-18; 中国个体防护装备 2001(1):20-22 and 2002; 服装科技 2000(7):55-56 (CQVIP doc/journal/5044713). Full texts paywalled.
3. **3rd Chinese male pilot anthropometric survey / GJB 4856-2003 中国男性飞行员人体尺寸** — 1,739 active PLAAF pilots, 94 standing items + 30 head-face items (Guo Xiaochao, Liu Baoshan et al., 航天医学与医学工程 2003(1):48-54; 人类工效学 2002(4):1-7, 2003(2); 中华航空航天医学杂志 2002). A 2026 paper reports the first PLAAF **female pilot** database (44 pilots, 197 items; 航天医学与医学工程 2026(3):266-270). GJB 4856 also has a transport-pilot part (CQVIP 7105207934).
4. **Republic of Korea military 3D body-scan datasets (open data)** — 국방부_공군 신체측정정보(남/여) (Air Force, 3D full-body scanner, 15,885 male records, 22 measures, annual since 2018; data.go.kr/data/15090354 and 15090359) and 국방부_해병대 장병 측신정보 (Marine Corps, 9,669 records, height/chest/waist/sleeve, Jan 2024; data.go.kr/data/15106305). Raw CSVs, free licence; the Army has a similar KATS/Size Korea cooperation since 2018 (~30,000 conscripts/yr). Not yet in catalog (`korea` entry only covers the 1960s DTIC survey and Size Korea).
5. **Royal Thai Army physical-fitness survey 2005** (4,423 personnel from 10 units; RTA Medical Journal 59(1), 2006) — not a full anthropometric survey (6 body measures) but the largest open Thai military sample found.

## Limitations

* Search breadth was cut by the exhausted WebSearch/OpenAlex budgets; Google Scholar scraping worked but was paced (≈25 queries). DBpia, Airiti, CNKI and RISS full texts are inaccessible, which removes most Korean sizing studies (e.g. 육군 방탄복의 인체측정학적 치수 체계 개발 2014; 한국군 조종사의 인체측정치 비교분석 1994) and all PRC/Taiwan journal papers.
* The Japanese 1988 values come from a scanned two-page abstract (tables are images); every number was read visually from a 200-dpi render and cross-checked against the printed women/men ratios in Tab.2 (quality B).
* Korean pilot facial means are text-only (no SD); Taiwan 2018 heights are self-reported; Malaysian 2013 values are from an abstract.
* No Filipino-language or Philippine-military source with statistics was found; no Malay-language source with statistics was found (the Malaysian sources are English).
