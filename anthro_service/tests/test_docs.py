"""The documentation and the examples are claims about the data: check them against it. Standard library only."""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from anthro_service import ApiError, get_repo  # noqa: E402

REPO = get_repo()
SERVICE = ROOT / "anthro_service"
DOCS = [SERVICE / "README.md", ROOT / "README.md", *sorted((SERVICE / "examples").glob("*"))]
TEXT = {p: p.read_text(encoding="utf-8") for p in DOCS if p.suffix in (".md", ".py", ".ps1", ".bas", ".json")}


def pairs() -> list:
    """(file, country, role) for every population named in a command line, URL or example of the docs."""
    q = r'(?:"([^"]+)"|([^\s"\\]+))'
    out = []
    for path, text in TEXT.items():
        for m in re.finditer(r"--country\s+" + q + r"\s+--role\s+" + q, text):
            out.append((path, m.group(1) or m.group(2), m.group(3) or m.group(4)))
        for m in re.finditer(r"-Country\s+" + q + r"\s+-Role\s+" + q, text):
            out.append((path, m.group(1) or m.group(2), m.group(3) or m.group(4)))
        for m in re.finditer(r"country=([^&\s\"']+)&role=([^&\s\"']+)", text):
            out.append((path, unquote(m.group(1)), unquote(m.group(2))))
        for m in re.finditer(r"/populations/([a-z][a-z0-9-]+)/([a-z][a-z0-9-]+)/(?:M|F|both)\b", text):
            out.append((path, m.group(1), m.group(2)))
    return [x for x in out if not any(ch in x[1] + x[2] for ch in "${}<>…")]  # placeholders such as {country} or $Country are not populations


class Docs(unittest.TestCase):
    def test_every_documented_population_exists(self):
        found = pairs()
        self.assertGreater(len(found), 8)
        for path, country, role in found:
            try:
                REPO.roles(country)
                REPO.surveys(country, role)
            except ApiError as e:
                self.fail(f"{path.relative_to(ROOT)}: '{country}' / '{role}' does not exist: {e.message}")

    def test_documented_numbers_match_the_data(self):
        counts = REPO.meta()["counts"]
        text = TEXT[SERVICE / "README.md"]
        self.assertIn(f"{counts['measures']} measures in {counts['populations']} populations (country × role × sex; {counts['country_role_groups']} country × role groups)", text)
        self.assertIn(f"{counts['countries']} countries and {counts['pooled_samples']} pooled", text)
        self.assertIn(f"country × role groups ({counts['country_role_groups']}), populations ({counts['populations']}: with sex), measures that have data ({counts['measures']}), values ({counts['values']})", text)
        self.assertIn(f"surveys that can be listed ({counts['surveys']})", text)
        none = sum(1 for e in REPO.countries() for r in e["roles"] for sex in r["sexes"]
                   if not any(REPO.mannequin(e["id"], r["id"], sex, p)["dimensions"] for p in (5, 50, 95)))
        self.assertIn(f"{none} populations have none and no file", text)
        from anthro_service import formats
        self.assertGreater(len(formats.design_csv(REPO.design_values("United States", "Army", "M", percentiles=[5, 50, 95], min_reliability="low"))), 32767)  # WEBSERVICE's cell limit
        self.assertIn("which the largest files exceed", text)
        used = {s for rows in REPO._roll.values() for row in rows.values() for s in row["sources"]}
        with_licence = sum(1 for s in used if REPO.source(s).get("licence"))
        self.assertIn(f"{with_licence} of the {len(used)} sources", text)
        self.assertIn(f"{with_licence} of the {len(used)} source ids", text)
        harmonized = sum(1 for m in REPO.measures() if m["harmonized"])
        self.assertIn(f"{harmonized} *harmonized* measures", text)
        self.assertIn(f"{counts['measures'] - harmonized} more are *as published*", text)

    def test_relative_links_and_files_exist(self):
        text = TEXT[SERVICE / "README.md"]
        for target in re.findall(r"\]\(([^)#]+)\)", text):
            if "://" not in target:
                self.assertTrue((SERVICE / target).exists(), target)
        for name in re.findall(r"`(examples/[\w.]+)`", text):
            self.assertTrue((SERVICE / name).exists(), name)
        for f in (SERVICE / "openapi.json", ROOT / "Dockerfile", ROOT / ".gitattributes"):
            self.assertTrue(f.exists(), f)

    def test_the_example_json_in_the_readme_is_what_the_service_returns(self):
        text = TEXT[SERVICE / "README.md"]
        block = re.search(r"The first call returns \(abridged\):\n\n```json\n(.*?)```", text, re.S).group(1)
        shown = json.loads(re.sub(r',\s*"…"\]', "]", re.sub(r'"…"', '"…"', block)).replace(', "…"', "").replace('"…", ', ""))
        real = REPO.mannequin("United States", "Air Force", "M", 95, measures=["stature", "mass", "sitting_height"])
        for key in ("core", "values", "units", "caution", "unavailable"):
            self.assertEqual(shown[key], real[key], key)
        self.assertEqual(shown["population"]["years"], real["population"]["years"])
        self.assertEqual(shown["population"]["surveys_combined"], real["population"]["surveys_combined"])
        self.assertEqual(set(shown), {"population", "percentile", "core", "values", "units", "caution", "dimensions", "unavailable", "notes"})
        first = shown["dimensions"][0]
        self.assertEqual(first, {k: real["dimensions"][0][k] for k in first})  # dimensions are ordered by category, so the example starts with body mass
        self.assertEqual(first["key"], "mass")

    def test_the_vba_module_has_crlf_endings(self):
        raw = (SERVICE / "examples" / "AnthroApi.bas").read_bytes()
        self.assertTrue(raw.count(b"\r\n") > 20)
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))

    def test_the_mcp_config_does_not_depend_on_the_working_directory(self):
        cfg = json.loads((SERVICE / "examples" / "claude_desktop_config.json").read_text(encoding="utf-8"))["mcpServers"]["anthropometry"]
        self.assertIn("PYTHONPATH", cfg["env"])
        self.assertNotIn("cwd", cfg)


if __name__ == "__main__":
    unittest.main()
