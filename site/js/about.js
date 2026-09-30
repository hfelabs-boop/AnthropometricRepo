// About page: provenance, database schema, caveats and downloads.
import { h } from "./util.js";

const REPO = "https://github.com/hfelabs-boop/AnthropometricRepo";

export function renderAbout(root) {
  const p = (...kids) => h("p", {}, ...kids);
  const a = (href, text) => h("a", { href, rel: "noopener" }, text);
  const code = t => h("code", {}, t);
  root.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "About this site"),
      p("A catalog of 49 military anthropometric surveys, a database built from the four that publish individual-level data, and statistics from about 110 published papers in 30 languages covering nearly 60 countries and groupings. Everything runs in your browser: the SQLite database (about 5 MB compressed) downloads once and is queried locally with ", a("https://sql.js.org", "sql.js"), ".")),

    h("h2", {}, "The four open datasets"),
    h("div", { class: "table-wrap", style: { maxHeight: "none" } }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, ["Survey", "People", "Source", "Licence"].map(t => h("th", {}, t)))),
      h("tbody", {}, [
        ["ANSUR 1988 (US Army)", "1,774 men · 2,208 women", a("https://www.openlab.psu.edu/ansur/", "Penn State OPEN Design Lab"), "Public domain"],
        ["ANSUR II 2012 (US Army)", "4,082 men · 1,986 women", a("https://www.openlab.psu.edu/ansur2/", "Penn State OPEN Design Lab"), "Public domain"],
        ["ASRAN 2015 (Royal Australian Navy)", "1,090 men · 232 women", a("https://data.gov.au/data/dataset/3e124b9c-4daa-4797-a265-ddbc5f36313c", "data.gov.au"), "CC BY 3.0 AU, © Commonwealth of Australia (DST Group)"],
        ["USAF 1967 (flying personnel)", "2,420 men", a("https://cran.r-project.org/package=Anthropometry", "CRAN Anthropometry package"), "US Government data"],
      ].map(r => h("tr", {}, r.map(c => h("td", {}, c))))))),

    h("h2", {}, "How the data were harmonized"),
    h("ul", {},
      h("li", {}, "59 measures that appear in at least two surveys share one column name and unit in the ", code("subjects"), " table: lengths in mm, mass in kg, age in years, BMI in kg/m²."),
      h("li", {}, "Unit fixes: ANSUR mass is stored in hectograms (÷10); USAF 1967 mass is in pounds (×0.4536) and age in tenths of a year (÷10); ANSUR II interpupillary breadth is in tenths of a mm (÷10)."),
      h("li", {}, "Zero values, which these files use for missing data, become NULL. BMI is derived from measured stature and mass."),
      h("li", {}, "Every original column is kept unchanged in the ", code("raw_*"), " tables, keyed by ", code("subject_key"), ".")),

    h("h2", {}, "Caveats"),
    h("ul", {},
      h("li", {}, "Same name does not guarantee identical method. Landmarks, posture and instruments differ between surveys, and 44 ASRAN measures were extracted from 3D scans. For example, chest breadth in ANSUR II runs about 30 mm below the other surveys."),
      h("li", {}, "Survey samples reflect each service's population at the time of measuring. They are not representative of other forces or of civilians."),
      h("li", {}, "Measures not recorded in a survey are NULL. A condition on such a measure excludes that survey's people. The query builder warns you when this happens."),
      h("li", {}, "The catalog's 'not verified' entries give only the best available citation. See ", a(`${REPO}/blob/main/CORRECTIONS.md`, "CORRECTIONS.md"), ".")),

    h("h2", {}, "Statistics from published papers"),
    p("Only four surveys publish individual-level data. To cover more countries and roles, tables of means and standard deviations were extracted from about 110 of the papers listed under ", a("#/papers", "Papers"),
      ": NASA's 1978 source book of 91 populations, US Army and Marine Corps surveys, the Australian, New Zealand, German, Korean, Thai and Latin American reports, and open-access articles, theses and official statistics found by searching in Russian, Czech, Serbian, Polish, German, Dutch, Nordic languages, Hungarian, Hebrew, Spanish, Portuguese, Japanese, Korean, Vietnamese, Thai and others. Foreign-language sources were read in the original and translated into English (dimension names and titles)."),
    h("ul", {},
      h("li", {}, "Each row keeps its source file and page number so it can be checked. Rows read from scanned pages (grade B) had to pass consistency checks, for example the printed coefficient of variation must equal SD ÷ mean."),
      h("li", {}, "Where the individual-level data exist, extracted numbers were compared with them. The NASA source book's USAF 1967 rows match the raw data to within 0.1 SD on all 47 comparable measures. ANSUR and ASRAN report tables match to rounding."),
      h("li", {}, "Roll-ups on ", a("#/compare", "By country & role"), " combine the surveys of one country and role, weighted by sample size. Surveys span the 1940s to the 2020s, so they mix eras. Use ", h("i", {}, "Every population"), " to compare like with like."),
      h("li", {}, "Some populations in the older reports do not state the sex of the sample. These are shown as 'Mixed / not stated' rather than guessed."),
      h("li", {}, "Papers whose numbers could not be verified or were not representative (for example a clinical case-control study) were left out. See ", a(`${REPO}/blob/main/aggregates/raw/openaccess_articles.md`, "the notes"), ".")),

    h("h2", {}, "Database tables"),
    h("ul", {},
      h("li", {}, code("subjects"), ": one row per person, harmonized measures plus sex, branch, component and handedness. The ", code("people"), " view adds the survey name and year."),
      h("li", {}, code("aggregates"), ": every extracted statistic (mean, SD, n, percentiles) with country, role, source paper and page. ", code("rollup"), ": the country × role × sex × measure averages."),
      h("li", {}, code("papers"), ": the paper index. ", code("measures"), ": label, unit, category and the source column in each survey."),
      h("li", {}, code("datasets"), ", ", code("surveys"), ", ", code("survey_links"), ": provenance and the full 49-survey catalog."),
      h("li", {}, code("raw_ansur_1988"), ", ", code("raw_ansur_ii_2012"), ", ", code("raw_asran_2015"), ", ", code("raw_usaf_1967"), " and ", code("raw_columns"), ": original columns with descriptions.")),

    h("h2", {}, "Downloads"),
    h("ul", {},
      h("li", {}, a("db/anthro.sqlite.gz", "Full SQLite database (gzip)"), " — open it with any SQLite tool, Python ", code("sqlite3"), ", R ", code("RSQLite"), " or DB Browser for SQLite."),
      h("li", {}, a("catalog/surveys.csv", "Survey catalog (CSV)"), " · ", a("catalog/surveys.json", "JSON"), " · ", a("catalog/papers.csv", "Paper index (CSV)")),
      h("li", {}, a("aggregates/aggregates.csv", "All extracted statistics (CSV)"), " · ", a("aggregates/rollup.csv", "Country × role roll-up (CSV)"), " · ", a("aggregates/SPEC.md", "column definitions")),
      h("li", {}, "Original data files: ", a("data/ansur-1988/ansurMen.csv", "ANSUR 88 men"), ", ", a("data/ansur-1988/ansurWomen.csv", "women"), " · ",
        a("data/ansur-ii-2012/ANSUR_II_MALE_Public.csv", "ANSUR II men"), ", ", a("data/ansur-ii-2012/ANSUR_II_FEMALE_Public.csv", "women"), " · ",
        a("data/asran-2015/asran-2015-anthropometry-data_public-release.xlsx", "ASRAN workbook"), " · ", a("data/usaf-1967/USAF1967.csv", "USAF 1967"))),
    p("Source code, build scripts and data checksums: ", a(REPO, "GitHub repository"), "."));
}
