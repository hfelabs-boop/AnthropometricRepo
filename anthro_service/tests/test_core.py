"""Core library tests: standard library only. Run:  python -m unittest discover -s anthro_service/tests -t .

The data checks compare the service output with the CSV files it reads, with the roll-up rules in
scripts/build_aggregates.py and with the website's category rules in site/js/measurecat.js."""
from __future__ import annotations

import csv
import json
import math
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from anthro_service import ApiError, BadRequest, NotFound, Repo, get_repo  # noqa: E402
from anthro_service import formats, snapshot  # noqa: E402
from anthro_service.core import DISCLAIMER, quantile, row_dist, slug  # noqa: E402
from anthro_service.measurecat import category_of  # noqa: E402

REPO = get_repo()


def read(name: str) -> list:
    with open(ROOT / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(x):
    return None if x in (None, "") else float(x)


def tol(unit: str) -> float:
    return 0.051 if unit == "mm" else 0.0051 if unit != "ratio" else 0.00051


class Values(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.roll = read("aggregates/rollup.csv")

    def test_every_rollup_value_is_served(self):
        by_pop: dict = {}
        for r in self.roll:
            by_pop.setdefault((r["country"], r["service_role"], r["sex"]), {})[r["measure_key"]] = r
        self.assertEqual(sum(len(v) for v in by_pop.values()), len(self.roll))
        checked = 0
        for (c, role, sex), rows in by_pop.items():
            d = REPO.design_values(c, role, sex, min_reliability="low")
            got = {m["key"]: m for m in d["measures"]}
            self.assertEqual(set(got), set(rows), (c, role, sex))
            for k, r in rows.items():
                m, u = got[k], got[k]["unit"]
                self.assertEqual(m["reliability"], r["reliability"])
                self.assertEqual(m["n"], int(float(r["n_total"])) if r["n_total"] else None)
                for p in ("p5", "p50", "p95"):
                    want = num(r[p])
                    if want is not None:
                        self.assertAlmostEqual(m["percentiles"][p], want, delta=tol(u), msg=(c, role, sex, k, p))
                        checked += 1
        self.assertGreater(checked, 15000)

    def test_reliability_filter(self):
        n = {lv: REPO.design_values("United States", "Army", "M", min_reliability=lv) for lv in ("high", "medium", "low", "all")}
        self.assertLessEqual(n["high"]["count"], n["medium"]["count"])
        self.assertLessEqual(n["medium"]["count"], n["low"]["count"])
        self.assertEqual(n["low"]["count"], n["all"]["count"])
        for lv, allowed in (("high", {"high"}), ("medium", {"high", "medium"})):
            self.assertLessEqual({m["reliability"] for m in n[lv]["measures"]}, allowed)
            self.assertEqual(n[lv]["count"] + n[lv]["hidden_by_reliability"], n["low"]["count"])

    def test_default_percentiles_and_extra_percentiles(self):
        d = REPO.design_values("United States", "Army", "M", ["stature"], percentiles=[5, 50, 95, 97.5, 1])
        m = d["measures"][0]
        self.assertEqual(list(m["percentiles"]), ["p5", "p50", "p95", "p97.5", "p1"])
        self.assertEqual([m["percentile_basis"][k] for k in ("p97.5", "p1")], ["extrapolated", "extrapolated"])
        self.assertLess(m["percentiles"]["p1"], m["percentiles"]["p5"])
        self.assertGreater(m["percentiles"]["p97.5"], m["percentiles"]["p95"])
        d = REPO.design_values("United States", "Army", "M", ["stature"], percentiles=[10, 90])
        self.assertEqual(set(d["measures"][0]["percentile_basis"].values()), {"interpolated"})

    def test_mannequin_matches_design_values(self):
        d = REPO.design_values("United States", "Army", "M", percentiles=[95])
        m = REPO.mannequin("United States", "Army", "M", 95)
        want = {x["key"]: x["percentiles"]["p95"] for x in d["measures"] if x["percentiles"]["p95"] is not None}
        self.assertEqual(m["values"], want)
        self.assertEqual(m["count"], len(want))
        self.assertAlmostEqual(m["core"]["stature_mm"], m["values"]["stature"])
        self.assertTrue(any("boundary" in n for n in m["notes"]))

    def test_compare_is_sorted_and_filtered(self):
        c = REPO.compare("stature", "M", 95, min_n=500)
        vals = [x["value"] for x in c["results"]]
        self.assertEqual(vals, sorted(vals, reverse=True))
        self.assertTrue(all((x["n"] or 0) >= 500 for x in c["results"]))
        only = REPO.compare("stature", "M", 50, countries=["USA", "Japan"])
        self.assertEqual({x["country"] for x in only["results"]}, {"United States", "Japan"})

    def test_notes_and_units(self):
        d = REPO.design_values("United States", "Army", "M", min_reliability="high")
        self.assertEqual(d["notes"][0], DISCLAIMER)
        self.assertIn("boundary", DISCLAIMER.lower())
        units = {m["key"]: m["unit"] for m in d["measures"]}
        self.assertEqual((units["stature"], units["mass"], units["bmi"]), ("mm", "kg", "kg/m²"))
        low = REPO.design_values("United States", "Army", "M", min_reliability="low")
        self.assertEqual(low["hidden_by_reliability"], 0)
        self.assertFalse(any("hidden" in n for n in low["notes"]))
        self.assertTrue(any("hidden" in n for n in d["notes"]))


class Quantiles(unittest.TestCase):
    def test_skewed_positive_tails_never_go_negative(self):
        """P5=40, P50=117, P95=180 (a real waist-hip distance): the straight line reaches zero before P0.1, the log scale does not."""
        v = [quantile(40, 117, 180, p) for p in (0.1, 0.5, 1, 2.5, 5, 10, 50, 95, 99.9)]
        self.assertTrue(all(x > 0 for x in v), v)
        self.assertEqual(v, sorted(v))
        self.assertEqual((v[4], v[6], v[7]), (40, 117, 180))
        self.assertAlmostEqual(v[0], 15.576, places=2)

    def test_symmetric_measures_keep_the_straight_line(self):
        z = 1.6448536269514722
        self.assertAlmostEqual(quantile(1600, 1750, 1900, 0.1), 1750 - 3.090232306167813 / z * 150, places=6)

    def test_no_served_value_is_negative_for_a_positive_measure(self):
        """Tiny positive tails may round to 0.0 (a skinfold at P0.1); none may be below zero."""
        bad = []
        for r in read("aggregates/rollup.csv"):
            if r["p5"] and r["p50"] and r["p95"] and float(r["p5"]) > 0:
                d = REPO.design_values(r["country"], r["service_role"], r["sex"], [r["measure_key"]], percentiles=[0.1, 1, 2.5], min_reliability="low")
                for m in d["measures"]:
                    bad += [(r["country"], r["service_role"], m["key"], p, v) for p, v in m["percentiles"].items() if v is not None and v < 0]
        self.assertEqual(bad, [], bad[:5])

    def test_exact_at_printed_points(self):
        self.assertEqual((quantile(1600, 1750, 1900, 5), quantile(1600, 1750, 1900, 50), quantile(1600, 1750, 1900, 95)), (1600, 1750, 1900))

    def test_standard_normal_recovers_z(self):
        z = 1.6448536269514722
        self.assertAlmostEqual(quantile(-z, 0, z, 97.5), 1.959963984540054, places=9)
        self.assertAlmostEqual(quantile(-z, 0, z, 2.5), -1.959963984540054, places=9)

    def test_monotone_and_skew_aware(self):
        ps = [0.1, 1, 2.5, 5, 10, 25, 50, 75, 90, 95, 97.5, 99, 99.9]
        v = [quantile(1600, 1720, 1900, p) for p in ps]
        self.assertEqual(v, sorted(v))
        self.assertLess(1720 - quantile(1600, 1720, 1900, 25), quantile(1600, 1720, 1900, 75) - 1720)  # right-skewed: longer upper tail

    def test_row_dist_matches_build_aggregates(self):
        import build_aggregates as ba
        rows = read("aggregates/aggregates.csv")
        self.assertGreater(len(rows), 10000)
        for r in rows:
            want = ba.row_dist(r)
            got = row_dist(num(r["mean"]), num(r["sd"]), num(r["p5"]), num(r["p50"]), num(r["p95"]))
            self.assertEqual(want is None, got is None, r["source_id"])
            if want:
                for a, b in zip(want[:3], got[:3]):
                    self.assertAlmostEqual(a, b, places=9)
                self.assertEqual(tuple(want[3]), tuple(got[3]))

    def test_lognormal_for_skewed_positive_measures(self):
        a, b, c = row_dist(10, 8, None, None, None)[:3]
        self.assertGreater(a, 0)
        self.assertLess(a, b)
        self.assertLess(b, c)


class SingleSurvey(unittest.TestCase):
    def test_single_survey_groups_equal_the_rollup(self):
        """For a population that is one survey, asking for that survey gives the combined (roll-up) numbers."""
        checked = 0
        for r in read("aggregates/rollup.csv"):
            groups = json.loads(r["survey_groups"])
            if len(groups) != 1 or r["measure_key"] not in ("stature", "mass", "sitting_height"):
                continue
            sg = groups[0]
            d = REPO.design_values(r["country"], r["service_role"], r["sex"], [r["measure_key"]], survey=slug(sg), min_reliability="low")
            m = d["measures"][0]
            for p in ("p5", "p50", "p95"):
                if r[p]:
                    self.assertAlmostEqual(m["percentiles"][p], float(r[p]), delta=0.051, msg=(r["country"], r["service_role"], sg, p))
            checked += 1
        self.assertGreater(checked, 20)

    def test_survey_listing_and_selection(self):
        s = REPO.surveys("United States", "Army")
        self.assertIn("ansur-ii-2012", [x["id"] for x in s["surveys"]])
        d = REPO.design_values("United States", "Army", "M", ["stature"], survey="ansur-ii-2012")
        self.assertEqual(d["population"]["survey"]["id"], "ansur-ii-2012")
        self.assertEqual(d["population"]["surveys_combined"], [])
        self.assertNotAlmostEqual(d["measures"][0]["percentiles"]["p50"], REPO.design_values("United States", "Army", "M", ["stature"])["measures"][0]["percentiles"]["p50"], places=2)


class Lookups(unittest.TestCase):
    def test_names_ids_aliases_and_case(self):
        for c in ("United States", "united-states", "UNITED STATES", "USA", "US", "America"):
            self.assertEqual(REPO.design_values(c, "army", "male", ["stature"])["population"]["country"], "United States")
        uk = next(k for k in REPO._roll if k[0] == "United Kingdom")
        self.assertEqual(REPO.design_values("UK", uk[1], uk[2], min_reliability="low")["population"]["country"], "United Kingdom")

    def test_errors_are_structured(self):
        for fn, args, cls, code in (
                (REPO.design_values, ("Narnia", "Army"), NotFound, "not_found"),
                (REPO.design_values, ("United States", "Cavalry"), NotFound, "not_found"),
                (REPO.design_values, ("United States", "Army", "X"), BadRequest, "bad_request"),
                (REPO.design_values, ("United States", "Army", "M", ["no_such_measure"]), NotFound, "not_found"),
                (REPO.design_values, ("United States", "Army", "M", None, None, [0]), BadRequest, "bad_request"),
                (REPO.design_values, ("United States", "Army", "M", None, None, [100]), BadRequest, "bad_request"),
                (REPO.design_values, ("United States", "Army", "M", None, None, ["abc"]), BadRequest, "bad_request"),
                (REPO.design_values, ("United States", "Army", "M", None, None, None, "bogus"), BadRequest, "bad_request"),
                (REPO.design_values, ("United States", "Army", "M", None, ["nope"]), NotFound, "not_found"),
                (REPO.mannequin, ("United States", "Army", "M", 0), BadRequest, "bad_request"),
                (REPO.source, ("no-such-source",), NotFound, "not_found")):
            with self.assertRaises(cls) as cm:
                fn(*args)
            self.assertEqual(cm.exception.to_dict()["code"], code)
            self.assertTrue(cm.exception.to_dict()["message"])

    def test_missing_sex_lists_available(self):
        with self.assertRaises(NotFound) as cm:
            REPO.design_values("United Kingdom", "Army", "M")
        self.assertTrue(cm.exception.available)

    def test_measure_search(self):
        keys = [m["key"] for m in REPO.measures(q="sitting height")]
        self.assertIn("sitting_height", keys)
        seated = REPO.measures(category="seated")
        self.assertTrue(seated)
        self.assertEqual({m["category"] for m in seated}, {"Seated"})
        self.assertTrue(all(m["populations"] > 0 for m in REPO.measures(country="Japan")))
        self.assertEqual(len(REPO.measures(limit=3)), 3)
        self.assertEqual(len(REPO.measures()), REPO.meta()["counts"]["measures"])

    def test_every_source_id_resolves(self):
        d = REPO.design_values("United States", "Army", "M", min_reliability="low")
        ids = {s for m in d["measures"] for s in m["sources"]}
        self.assertTrue(ids)
        for sid in ids:
            self.assertEqual(REPO.source(sid)["id"], sid)

    def test_missing_optional_files_do_not_break_loading(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            for name in ("aggregates/rollup.csv", "aggregates/aggregates.csv", "database/harmonized_measures.csv"):
                (t / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / name, t / name)
            r = Repo(t)
            self.assertEqual(r.meta()["counts"]["measures"], REPO.meta()["counts"]["measures"])
            self.assertRegex(r.meta()["data_version"], r"^[0-9a-f]{12}$")
        with self.assertRaises(Exception):
            Repo("/nonexistent/path")


class Provenance(unittest.TestCase):
    def test_every_survey_of_every_population_can_be_queried(self):
        """list_surveys offers an id: asking for it must never crash, at any reliability level (a mean-only measure once raised KeyError)."""
        n = 0
        for c in REPO.countries():
            for role in c["roles"]:
                for sv in REPO.surveys(c["id"], role["id"])["surveys"]:
                    for sex in sv["sexes"]:
                        d = REPO.design_values(c["id"], role["id"], sex, survey=sv["id"], min_reliability="low")
                        REPO.mannequin(c["id"], role["id"], sex, 50, survey=sv["id"], min_reliability="low")
                        self.assertEqual(d["population"]["survey"]["id"], sv["id"])
                        n += 1
        self.assertGreater(n, 300)

    def test_surveys_combined_are_the_surveys_of_the_returned_values(self):
        for c, role, sex, kw in (("United States", "Army", "M", {}), ("United States", "Army", "F", {}), ("Australia", "Army", "M", {}), ("Japan", "Air Force", "F", {}),
                                 ("Germany", "Tri-service", "M", {}), ("United States", "Army", "M", {"measures": ["stature"]}), ("United States", "Army", "M", {"min_reliability": "high"})):
            d = REPO.design_values(c, role, sex, **kw)
            ids = {s["id"] for s in d["population"]["surveys_combined"]}
            used = {slug(sg) for m in d["measures"] for sg in REPO._roll[(c, role, sex)][m["key"]]["surveys"] if (c, role, sg) in REPO._survey_info}
            self.assertEqual(ids, used, (c, role, sex, kw))
            self.assertTrue(ids)
        men = {s["id"] for s in REPO.design_values("United States", "Army", "M")["population"]["surveys_combined"]}
        self.assertNotIn("rp1024-vol2-s5-wac-separatee-1946", men)  # a women's survey is not part of the men's values

    def test_basis_pooled_versus_reported(self):
        multi = REPO.design_values("United States", "Army", "M", ["stature"])["measures"][0]
        self.assertGreater(multi["n_surveys"], 1)
        self.assertEqual(set(multi["percentile_basis"].values()), {"pooled"})
        single = REPO.design_values("United States", "Army", "M", ["stature"], survey="ansur-ii-2012")["measures"][0]
        self.assertEqual((single["n_surveys"], set(single["percentile_basis"].values())), (1, {"reported"}))
        self.assertIsNone(single["survey_spread_pct"])
        self.assertIsNotNone(multi["survey_spread_pct"])

    def test_latest_survey_and_the_vintage_note(self):
        combined = REPO.design_values("United States", "Army", "M", ["stature"])
        self.assertTrue(any("survey=latest" in n and "1966 to 2010" in n for n in combined["notes"]), combined["notes"])
        latest = REPO.design_values("United States", "Army", "M", ["stature"], survey="latest")
        self.assertEqual(latest["population"]["survey"]["id"], "ansur-ii-2012")
        self.assertFalse(any("survey=latest" in n for n in latest["notes"]))
        self.assertEqual(REPO.mannequin("United States", "Army", "F", 50, survey="latest")["population"]["survey"]["id"], "ansur-ii-2012")
        for c in REPO.countries():  # 'latest' never crashes and never picks a survey without data for the sex
            for role in c["roles"]:
                for sex in role["sexes"]:
                    try:
                        d = REPO.design_values(c["id"], role["id"], sex, survey="latest", min_reliability="low")
                    except NotFound:
                        continue
                    self.assertGreater(d["count"], 0)

    def test_mannequin_reports_what_it_leaves_out(self):
        m = REPO.mannequin("Israel", "Tri-service", "M", 95, measures=["stature", "mass"], min_reliability="low")
        self.assertEqual([u["key"] for u in m["unavailable"]], ["stature"])
        self.assertIsNotNone(m["unavailable"][0]["mean"])
        self.assertTrue(any("mean but no percentiles" in n for n in m["notes"]))
        self.assertNotIn("stature_mm", m["core"])

    def test_mannequin_carries_provenance_units_and_cautions(self):
        m = REPO.mannequin("United States", "Army", "M", 95)
        self.assertNotIn("bmi", m["core"])  # bmi is not mass / stature^2 of the percentile values; it stays a plain dimension
        self.assertEqual(set(m["units"]), set(m["values"]))
        self.assertEqual(m["units"]["mass"], "kg")
        d = next(x for x in m["dimensions"] if x["key"] == "suprasternale_height")
        self.assertEqual(d["years"], [1987, 2010])
        self.assertTrue(d["sources"])
        self.assertIn("mass", m["caution"])  # soldiers got heavier between the surveys
        self.assertTrue(any("differ" in why for why in m["caution"]["mass"]))
        self.assertIn("Percentile 50", " ".join(REPO.mannequin("United States", "Army", "M", 50)["notes"]))
        self.assertIn("percentile 95", " ".join(m["notes"]))

    def test_counts_agree_with_what_can_be_listed(self):
        counts = REPO.meta()["counts"]
        listed = sum(len(REPO.surveys(c["id"], r["id"])["surveys"]) for c in REPO.countries() for r in c["roles"])
        self.assertEqual(counts["surveys"], listed)
        self.assertEqual(counts["countries"] + counts["pooled_samples"], len(REPO.countries()))
        self.assertEqual(counts["measures"], len(REPO.measures()))
        for c in REPO.countries():
            for r in c["roles"]:
                self.assertEqual(r["surveys"], len(REPO.surveys(c["id"], r["id"])["surveys"]))
                self.assertLessEqual(r["surveys_in_combined_values"], r["surveys"])


class Search(unittest.TestCase):
    def keys(self, q, n=3):
        return [m["key"] for m in REPO.measures(q=q, limit=n)]

    def test_relevance(self):
        self.assertEqual(set(self.keys("head")), {"head_circumference", "head_breadth", "head_length"})
        self.assertEqual(self.keys("shoulder breadth", 2), ["bideltoid_breadth", "biacromial_breadth"])
        self.assertEqual(self.keys("weight", 1), ["mass"])
        self.assertEqual(self.keys("waist", 1), ["waist_circumference"])
        self.assertEqual(self.keys("seat depth", 1), ["buttock_popliteal_length"])
        self.assertFalse(any("garment" in m["key"] for m in REPO.measures(q="arm")))  # 'arm' is not a word start in 'garment'
        self.assertTrue(REPO.measures(q="HEAD"))  # case does not matter

    def test_filters_and_flags(self):
        self.assertTrue(all("harmonized" in m for m in REPO.measures(limit=5)))
        with self.assertRaises(NotFound) as cm:
            REPO.measures(category="zzz")
        self.assertTrue(cm.exception.available)
        self.assertEqual({m["category"] for m in REPO.measures(category="heights-standing")}, {"Heights (standing)"})
        self.assertEqual(REPO.measures(q="zzzzz"), [])

    def test_blank_measure_keys_are_a_client_error(self):
        for fn, args in ((REPO.measure, ("",)), (REPO.measure, ("  ",)), (REPO.compare, ("",)), (REPO.design_values, ("United States", "Army", "M", [""]))):
            with self.assertRaises(BadRequest):
                fn(*args)


class Compare(unittest.TestCase):
    def test_total_truncation_and_missing_countries(self):
        full = REPO.compare("stature", "M", 95)
        part = REPO.compare("stature", "M", 95, limit=5)
        self.assertEqual((part["count"], part["total"], part["truncated"]), (5, full["total"], True))
        self.assertGreater(full["total"], 5)
        self.assertEqual(part["results"], full["results"][:5])
        self.assertTrue(any("first 5 of" in n for n in part["notes"]))
        c = REPO.compare("sitting_height", "M", 50, countries=["United States", "Germany", "Israel"])
        self.assertIn("Israel", c["no_data"].get("countries", []))
        self.assertTrue(any("Israel" in n for n in c["notes"]))


    def test_compare_latest_uses_each_populations_most_recent_survey(self):
        combined = REPO.compare("stature", "M", 50, countries=["United States"], roles=["Army"])["results"][0]
        latest = REPO.compare("stature", "M", 50, countries=["United States"], roles=["Army"], survey="latest")
        self.assertEqual(latest["survey"], "latest")
        row = latest["results"][0]
        self.assertEqual((row["n_surveys"], row["basis"]), (1, "reported"))
        self.assertEqual(row["value"], REPO.design_values("United States", "Army", "M", ["stature"], survey="latest")["measures"][0]["percentiles"]["p50"])
        self.assertNotEqual(row["value"], combined["value"])
        self.assertTrue(any("most recent" in n for n in latest["notes"]))
        wide = REPO.compare("stature", "M", 50)
        self.assertTrue(any("survey=latest" in n for n in wide["notes"]), wide["notes"])
        with self.assertRaises(BadRequest):
            REPO.compare("stature", survey="ansur-ii-2012")


class DataVersion(unittest.TestCase):
    def make(self, t: Path) -> Path:
        for name in ("aggregates/rollup.csv", "aggregates/aggregates.csv", "aggregates/official_documents.csv", "database/harmonized_measures.csv",
                     "catalog/surveys.csv", "catalog/papers.csv"):
            (t / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / name, t / name)
        return t

    def test_every_input_counts_and_line_endings_do_not(self):
        with tempfile.TemporaryDirectory() as t:
            t = self.make(Path(t))
            base = Repo(t).data_version
            for name in ("aggregates/official_documents.csv", "database/harmonized_measures.csv", "catalog/surveys.csv", "catalog/papers.csv"):
                f = t / name
                text = f.read_bytes()
                f.write_bytes(text + b"\n#")
                self.assertNotEqual(Repo(t).data_version, base, name)
                f.write_bytes(text)
            self.assertEqual(Repo(t).data_version, base)
            f = t / "aggregates/rollup.csv"
            f.write_bytes(f.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
            self.assertEqual(Repo(t).data_version, base)


class Categories(unittest.TestCase):
    def test_same_as_the_website(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        with tempfile.TemporaryDirectory() as t:
            shutil.copy(ROOT / "site/js/measurecat.js", Path(t) / "measurecat.mjs")
            known = {k: m["category"] for k, m in REPO._measures.items() if m["harmonized"]}
            (Path(t) / "run.mjs").write_text(
                "import {categoryOf} from './measurecat.mjs';\nimport fs from 'fs';\n"
                "const keys = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
                "console.log(JSON.stringify(keys.map(([k, c]) => categoryOf(k, c))));\n")
            keys = [[k, known.get(k)] for k in REPO._measures]
            out = subprocess.run([node, str(Path(t) / "run.mjs")], input=json.dumps(keys), capture_output=True, text=True, check=True).stdout
        js = json.loads(out)
        py = [category_of(k, c) for k, c in keys]
        bad = [(k, a, b) for (k, _), a, b in zip(keys, js, py) if a != b]
        self.assertEqual(bad, [], bad[:5])
        self.assertGreater(len(keys), 500)


class Formats(unittest.TestCase):
    def test_csv_is_crlf_utf8_and_round_trips(self):
        d = REPO.design_values("United States", "Army", "M", ["stature", "mass"])
        text = formats.design_csv(d)
        self.assertIn("\r\n", text)
        rows = list(csv.DictReader(text.splitlines()))
        self.assertEqual({r["key"] for r in rows}, {"stature", "mass"})
        st = next(r for r in rows if r["key"] == "stature")
        want = next(m for m in d["measures"] if m["key"] == "stature")
        self.assertAlmostEqual(float(st["p50"]), want["percentiles"]["p50"])
        self.assertEqual(st["unit"], "mm")

    def test_csv_quotes_commas_and_empty_is_blank(self):
        text = formats.to_csv(["a", "b", "c"], [{"a": "x,y", "b": None, "c": 'say "hi"'}])
        self.assertEqual(text, 'a,b,c\r\n"x,y",,"say ""hi"""\r\n')

    def test_xml_is_well_formed(self):
        for text in (formats.design_xml(REPO.design_values("United States", "Army", "M")),
                     formats.mannequin_xml(REPO.mannequin("United States", "Army", "M", 50)),
                     formats.compare_xml(REPO.compare("stature", "M", 50, limit=5))):
            root = ET.fromstring(text.encode("utf-8"))
            self.assertTrue(len(root))


class Snapshot(unittest.TestCase):
    def test_snapshot_matches_the_live_values(self):
        with tempfile.TemporaryDirectory() as t:
            r = snapshot.build(t)
            base = Path(t) / "api" / "v1"
            index = json.loads((base / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(r["populations"], len(index["populations"]))
            self.assertEqual(r["populations"], len({(x["country_id"], x["role_id"], x["sex"]) for x in index["populations"]}))
            self.assertEqual(r["populations"], len(REPO._roll))
            for entry in random.Random(1).sample(index["populations"], 12):
                got = json.loads((base / entry["values_json"].split("/api/v1/")[1]).read_text(encoding="utf-8"))
                want = REPO.design_values(entry["country_id"], entry["role_id"], entry["sex"], percentiles=[5, 50, 95], min_reliability="low")
                self.assertEqual(got, json.loads(json.dumps(want)))
                self.assertTrue((base / entry["values_csv"].split("/api/v1/")[1]).read_text(encoding="utf-8").startswith("country,role,sex"))
                m = json.loads((base / entry["mannequin_json"].split("/api/v1/")[1]).read_text(encoding="utf-8"))
                self.assertEqual(m["percentiles"]["p95"]["values"], REPO.mannequin(entry["country_id"], entry["role_id"], entry["sex"], 95)["values"])
            for name in ("meta", "countries", "measures", "categories"):
                self.assertTrue(json.loads((base / f"{name}.json").read_text(encoding="utf-8")))
            self.assertEqual(len(json.loads((base / "measures.json").read_text(encoding="utf-8"))), REPO.meta()["counts"]["measures"])

    def test_the_build_needs_no_third_party_packages(self):
        code = "import sys, builtins\nreal = builtins.__import__\n" \
               "def guard(name, *a, **k):\n    if name.split('.')[0] in ('fastapi', 'pydantic', 'mcp', 'starlette', 'uvicorn'):\n        raise ImportError(name)\n    return real(name, *a, **k)\n" \
               "builtins.__import__ = guard\nsys.path.insert(0, sys.argv[1])\nfrom anthro_service import snapshot\nprint(snapshot.build(sys.argv[2])['populations'])\n"
        with tempfile.TemporaryDirectory() as t:
            out = subprocess.run([sys.executable, "-I", "-c", code, str(ROOT), t], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)


if __name__ == "__main__":
    unittest.main()
