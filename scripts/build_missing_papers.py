#!/usr/bin/env python3
"""Build the hand-off files for papers this project could not read.

Input:  docs/papers_to_obtain.yaml
Output: docs/papers_to_obtain.md          reference list (APA 7) with direct links, to send to a colleague
        docs/papers_to_obtain.csv         same list as a manifest (id, apa, doi, links, folder, file, ...)
        docs/download_agent_prompt.md     prompt for a computer-use / coding agent that downloads them
        docs/papers_to_obtain.txt         plain-text version of the list (for pasting into a Google Doc)

Requires: pyyaml
Usage: python scripts/build_missing_papers.py
"""
import csv
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
GROUPS = {"journal": "Journal articles (empirical studies)", "report": "Reports, book monographs and other grey literature", "dataset": "Open datasets that need a person to download them (portal check)"}


def apa_text(entry, markdown):
    """APA text with en dashes in page ranges (only before the URL, so DOIs stay intact)."""
    text = entry["apa"]
    head, sep, tail = text.partition(" https://")
    head = re.sub(r"(?<=\d)-(?=\d+\.(?: |$))", "\u2013", head)  # page ranges only (they end the citation)
    text = head + sep + tail
    return text if markdown else text.replace("*", "")


def link_of(entry):
    return entry["links"][0]


def link_label(entry):
    return "Where to search (no direct link found)" if entry.get("link_kind") == "search" else "Direct link"


def main():
    papers = yaml.safe_load(open(DOCS / "papers_to_obtain.yaml", encoding="utf-8"))["papers"]
    ids = [p["id"] for p in papers]
    assert len(set(ids)) == len(ids), "duplicate ids"

    # ---- markdown reference list --------------------------------------------------
    md = ["# Papers to obtain",
          "",
          "Papers that the project could not read in full text (paywalled, blocked for automated tools, or not found online).",
          "Citations are APA 7. Journal-article details were checked against Crossref on 2026-09-29. **Direct link** is the DOI (or the best available URL).",
          "Entries marked *(citation incomplete)* need their title page checked once the PDF is in hand.",
          ""]
    n = 0
    for key, title in GROUPS.items():
        items = [p for p in papers if p["group"] == key]
        md += [f"## {title}", ""]
        for p in items:
            n += 1
            md += [f"{n}. {apa_text(p, True)}" + (" *(citation incomplete)*" if p["verified"] == "partial" else ""),
                   f"   - **{link_label(p)}:** <{link_of(p)}>",
                   *[f"   - Alternative: <{u}>" for u in p["links"][1:]],
                   f"   - Access: {p['access']}. Why the project has no full text: {p['why']}",
                   f"   - Save as: `{p['folder']}/{p['file']}`", ""]
    (DOCS / "papers_to_obtain.md").write_text("\n".join(md), encoding="utf-8")

    # ---- plain text for a Google Doc ---------------------------------------------------
    tx = ["Papers to obtain - military anthropometry project", "",
          "Please download the PDF of each paper below (institutional access is fine) and save it as named. Citations are APA 7.", ""]
    n = 0
    for key, title in GROUPS.items():
        tx += [title.upper(), ""]
        for p in [p for p in papers if p["group"] == key]:
            n += 1
            tx += [f"{n}. {apa_text(p, False)}" + (" (citation incomplete: check title page)" if p["verified"] == "partial" else ""),
                   f"   {link_label(p)}: {link_of(p)}",
                   *[f"   Alternative: {u}" for u in p["links"][1:]],
                   f"   Access: {p['access']}", f"   Save as: {p['folder']}/{p['file']}", ""]
    (DOCS / "papers_to_obtain.txt").write_text("\n".join(tx), encoding="utf-8")

    # ---- manifest CSV -------------------------------------------------------------------
    with open(DOCS / "papers_to_obtain.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "group", "country", "citation_apa", "doi", "direct_link", "alternative_links", "access", "save_as", "why_not_read", "citation_status"])
        for p in papers:
            w.writerow([p["id"], p["group"], p["country"], apa_text(p, False), p["doi"], link_of(p), " | ".join(p["links"][1:]),
                        p["access"], f"{p['folder']}/{p['file']}", p["why"], "incomplete" if p["verified"] == "partial" else "verified"])

    # ---- agent prompt ------------------------------------------------------------------
    rows = "\n".join(f"{i}\t{p['id']}\t{link_of(p)}\t{' | '.join(p['links'][1:]) or '-'}\t{p['folder']}/{p['file']}\t{apa_text(p, False)[:150]}"
                     for i, p in enumerate(papers, 1))
    prompt = PROMPT.replace("__COUNT__", str(len(papers))).replace("__ROWS__", rows)
    (DOCS / "download_agent_prompt.md").write_text(prompt, encoding="utf-8")
    print(f"wrote docs/: {len(papers)} papers ({sum(p['group'] == 'journal' for p in papers)} journal articles)")


PROMPT = """# Prompt for a computer-use / coding agent: download the papers

Copy everything below the line into the agent (Codex, Claude computer use, or similar). Run it in a **browser session that is already signed in with the university or library access you want used**.

---

## Role and goal

You are a careful research assistant with control of a web browser and a file system. Download the full-text PDF of each of the __COUNT__ items in the table below and save each in the directory tree described here. Do this only through legitimate routes: the publisher's own page, the open-access copy the publisher or a repository provides, or the institutional access already active in this browser.

## Rules you must follow

1. **Legitimate access only.** Never use Sci-Hub, LibGen, shadow libraries, or any site that offers a paper without the publisher's or author's permission. Do not try to defeat a paywall, a CAPTCHA, or bot protection.
2. **Never type or handle passwords, one-time codes or payment details.** If a page asks you to sign in, pay, or approve cookies beyond "reject non-essential", stop that paper, mark it `needs_login`, and go on to the next one. If the browser session is not signed in, say so in the final report; do not try to sign in yourself.
3. **Do not submit anyone's email address, name or institution to any website** (including open-access finder tools that ask for an email). Use only the links in the table.
4. **Download only the PDF of each paper (or, for the entries whose save_as ends in .csv, the CSV file the portal offers).** Do not install software, run downloaded files, accept browser extensions, or click ads. The Korean data-portal entries sit behind a captcha/session check: if a captcha appears, do not solve it; mark the entry `captcha_or_blocked`.
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
__ROWS__
```
"""


if __name__ == "__main__":
    main()
