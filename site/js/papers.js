// Papers: every paper we could open, with the original link, an open copy, and how much data was extracted from it.
import { h, $, fmtInt, debounce, dataTable, toCSV, download } from "./util.js";
import { objects } from "./db.js";
import { DRIVE_FOLDER_URL } from "./config.js";

export async function initPapers() {
  const [papers, surveys] = await Promise.all([
    objects("SELECT * FROM papers ORDER BY source, survey_id, title"),
    objects("SELECT id, entry FROM surveys"),
  ]);
  const name = Object.fromEntries(surveys.map(s => [s.id, s.entry]));
  const root = $("#view-papers");
  const q = h("input", { class: "input", type: "search", placeholder: "Search title, survey, country…", "aria-label": "Search papers", style: { maxWidth: "340px" } });
  const only = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Filter" },
    [["", "All papers"], ["rows", "With extracted statistics"], ["ia", "Internet Archive copies"], ["oa", "Open-access articles"]].map(([v, t]) => h("option", { value: v }, t)));
  const langs = [...new Set(papers.map(p => p.language || "English"))].sort();
  const lang = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Language" },
    h("option", { value: "" }, `All languages (${langs.length})`), langs.map(l => h("option", { value: l }, `${l} (${papers.filter(p => (p.language || "English") === l).length})`)));
  const box = h("div");
  const totalMb = papers.reduce((a, p) => a + (p.size_mb || 0), 0);
  root.replaceChildren(
    h("div", { class: "hero" }, h("h1", {}, "Papers"),
      h("p", {}, `${papers.length} papers, theses and reports (${fmtInt(totalMb)} MB) in ${langs.length} languages that could be opened directly. `,
        "About a third are US Government reports from the Defense Technical Information Center (DTIC); DTIC blocks automated downloads, so each of those also links to a free copy on the Internet Archive. Papers in other languages show the English title first and the original title below. ",
        "The statistics extracted from them power ", h("a", { href: "#/compare" }, "By country & role"), ". The maintainer's Google Drive folder with the paper index is ",
        h("a", { href: DRIVE_FOLDER_URL, rel: "noopener", target: "_blank" }, "here"), " (private; access on request).")),
    h("div", { class: "toolbar" }, q, only, lang, h("div", { class: "grow" }), h("button", { class: "btn", type: "button", id: "papers-csv" }, "⤓ CSV")), box);

  function render() {
    const t = q.value.toLowerCase(), f = only.value, L = lang.value;
    const list = papers.filter(p => (!t || `${p.title} ${p.survey_id} ${name[p.survey_id] || ""} ${p.paper_id}`.toLowerCase().includes(t)) && (!L || (p.language || "English") === L) &&
      (!f || (f === "rows" && p.aggregate_rows > 0) || (f === "ia" && /Internet Archive/.test(p.open_copy_kind)) || (f === "oa" && /open access/i.test(p.open_copy_kind))));
    const cols = ["Paper", "Survey", "Language", "Pages", "MB", "Rows extracted", "Links"];
    box.replaceChildren(dataTable({
      columns: cols, numeric: new Set(["Pages", "MB", "Rows extracted"]), pageSize: 100, wrap: new Set(["Paper", "Survey"]),
      rows: list.map(p => [p, name[p.survey_id] || (p.survey_id ? p.survey_id : "—"), p.language || "English", p.pages, p.size_mb, p.aggregate_rows, p]),
      cellRender: (c, v) => {
        if (c === "Paper") {
          const m = /^(.*) \[original: (.*)\]$/.exec(v.title);
          return h("div", {}, m ? m[1] : v.title, m ? h("div", { class: "small muted", lang: "" }, m[2]) : null,
            h("div", { class: "small muted" }, v.text_layer && v.text_layer.startsWith("no") ? "scanned image, no text layer" : ""));
        }
        if (c === "Rows extracted") return v ? fmtInt(v) : "—";
        if (c === "Links") return /abstract only/.test(v.open_copy_kind)
          ? h("a", { href: v.original_url, target: "_blank", rel: "noopener", title: "Full text is behind a paywall" }, "Publisher page (abstract)")
          : h("span", {}, h("a", { href: v.open_copy_url, target: "_blank", rel: "noopener" }, "Open copy"), v.open_copy_url !== v.original_url ? [" · ",
            h("a", { href: v.original_url, target: "_blank", rel: "noopener" }, "Original")] : null);
        return v ?? "—";
      } }));
    $("#papers-csv").onclick = () => download("papers.csv", toCSV(["paper_id", "survey_id", "title", "original_url", "open_copy_url", "pages", "size_mb", "aggregate_rows"], list.map(p => [p.paper_id, p.survey_id, p.title, p.original_url, p.open_copy_url, p.pages, p.size_mb, p.aggregate_rows])));
  }
  q.addEventListener("input", debounce(render, 120));
  only.addEventListener("change", render);
  lang.addEventListener("change", render);
  render();
}
