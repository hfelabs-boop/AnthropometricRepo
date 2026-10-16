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
from anthro_service.core import DISCLAIMER, VINTAGE_YEARS, quantile, row_dist, slug  # noqa: E402
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


class LatestSurvey(unittest.TestCase):
    def test_a_skipped_newer_survey_is_named_not_hidden(self):
        """Thailand's 2005 survey (n=4030) has 6 of 53 measures: `latest` is the 1962 survey, and both the answer and the vintage note say so."""
        d = REPO.design_values("Thailand", "Army", "M", ["stature", "mass"], survey="latest")
        self.assertEqual(d["population"]["survey"]["year"], 1962)
        text = " ".join(d["notes"])
        self.assertIn("A newer survey", text)
        self.assertIn("2005", text)
        self.assertIn("covers only 6 of 53 measures", text)
        combined = " ".join(REPO.design_values("Thailand", "Army", "M", ["stature", "mass"])["notes"])
        self.assertIn("survey=latest gives", combined)
        self.assertNotIn("for current personnel use survey=latest", combined)  # it would hand out the older survey
        good = " ".join(REPO.design_values("United States", "Army", "M", ["stature"])["notes"])
        self.assertIn("for current personnel use survey=latest (now 'ANSUR II 2012', 2010)", good)

    def test_the_choice_is_usable_deterministic_and_has_the_core_dimensions(self):
        # Germany Tri-service: a dropped low-reliability duplicate must not win the alphabetical tie-break
        d = REPO.design_values("Germany", "Tri-service", "both", survey="latest")
        self.assertEqual(d["count"], REPO.design_values("Germany", "Tri-service", "both")["count"])
        self.assertIn(d["population"]["survey"]["id"], {s["id"] for s in REPO.surveys("Germany", "Tri-service")["surveys"] if s["in_combined_values"]})
        # Japan Pilots: the undated survey that has stature beats a dated one that has none
        self.assertIn("stature", REPO.mannequin("Japan", "Pilots", "both", 50, survey="latest")["values"])
        # populations whose latest survey was all low reliability must fall back to a usable one
        for c, role, sex in (("Chile", "Recruits/trainees", "M"), ("Brazil", "Cadre/other military", "M")):
            self.assertGreater(REPO.design_values(c, role, sex, survey="latest")["count"], 0, (c, role))
        for c in REPO.countries():
            for role in c["roles"]:
                for sex in role["sexes"]:
                    first = REPO._latest_choice(c["name"], role["name"], sex)
                    self.assertEqual(first, REPO._latest_choice(c["name"], role["name"], sex))

    def test_a_thinner_set_than_the_combined_values_is_announced(self):
        """The note appears exactly when `latest` has under 70% of the measures the combined values have."""
        seen = set()
        for c, role, sex in (("Japan", "Pilots", "both"), ("Israel", "Recruits/trainees", "M"), ("United States", "Army", "M"), ("Thailand", "Army", "M"), ("Germany", "Tri-service", "both")):
            lat = REPO.design_values(c, role, sex, survey="latest")
            whole = sum(1 for r in REPO._roll[(c, role, sex)].values() if r["reliability"] in ("high", "medium"))
            said = any("measures the combined values have" in n for n in lat["notes"])
            self.assertEqual(said, lat["count"] < 0.7 * whole, (c, role))
            seen.add(said)
        self.assertEqual(seen, {True, False})  # the check is exercised in both directions

    def test_undated_surveys_are_flagged(self):
        d = REPO.design_values("Ecuador", "Recruits/trainees", "M", ["stature"])
        self.assertTrue(any("no recorded year" in n for n in d["notes"]), d["notes"])


class Hygiene(unittest.TestCase):
    def test_reading_a_measure_never_changes_the_catalog(self):
        before = (REPO.meta()["counts"], len(REPO.measures()), REPO.categories())
        orphans = [k for k in REPO._measures if k not in REPO._cover]
        self.assertTrue(orphans)
        for k in orphans:
            with self.assertRaises(NotFound):
                REPO.measure(k)
        self.assertEqual((REPO.meta()["counts"], len(REPO.measures()), REPO.categories()), before)
        self.assertEqual(sum(c["measures"] for c in REPO.categories()), REPO.meta()["counts"]["measures"])
        for c in REPO.categories():
            self.assertEqual(len(REPO.measures(category=c["id"])), c["measures"], c["name"])
        # ... yet a measure that has only a mean in one survey can still be asked for with survey=
        self.assertIn("other:eye_height_standing", REPO._measures)

    def test_blank_source_id_is_a_client_error(self):
        for blank in ("", "  "):
            with self.assertRaises(BadRequest):
                REPO.source(blank)
        self.assertEqual(REPO.source("ansur-ii-2012")["id"], "ansur-ii-2012")

    def test_search_understands_what_people_type(self):
        k = lambda q, n=3: [m["key"] for m in REPO.measures(q=q, limit=n)]
        self.assertEqual(k("height", 1), ["stature"])
        self.assertEqual(k("body height", 1), ["stature"])
        self.assertEqual(k("standing height", 1), ["stature"])
        self.assertEqual(k("sitting_height", 1), ["sitting_height"])
        self.assertEqual(k("other:waist_hip_ratio", 1), ["other:waist_hip_ratio"])
        self.assertEqual(k("eye height (sitting)", 1), ["eye_height_sitting"])
        self.assertIn("other:waist_hip_ratio", k("waist-to-hip ratio"))
        self.assertEqual(k("STATURE", 1), ["stature"])
        self.assertEqual(k("weight", 1), ["mass"])
        self.assertEqual(k("weight", 2)[1], "other:weight_as_reported")  # the plain word in a name beats bmi, which matches only through the synonym
        import time
        t = time.time()
        self.assertTrue(REPO.measures(q=" ".join(["a"] * 20000)) is not None)
        self.assertLess(time.time() - t, 1.0)  # terms are capped and de-duplicated
        for nothing in ("(*", "???", "the", "of", "身高", "((("):  # something was typed but nothing in it can be searched for: no matches, not the whole catalog
            self.assertEqual(REPO.measures(q=nothing), [], nothing)
        self.assertEqual(len(REPO.measures(q="")), len(REPO.measures()))  # nothing typed: the whole catalog
        self.assertTrue(all(not m["harmonized"] for m in REPO.measures(q="other:")))

    def test_unknown_measures_get_useful_suggestions(self):
        for typed, want in (("weight", "mass"), ("body_height", "stature"), ("statur", "stature")):
            with self.assertRaises(NotFound) as cm:
                REPO.design_values("United States", "Army", "M", [typed])
            self.assertIn(want, cm.exception.available, typed)
            self.assertTrue(cm.exception.close)
        with self.assertRaises(NotFound) as cm:
            REPO.design_values("United States", "Army", "M", ["zzzzqq"])
        self.assertFalse(cm.exception.available)  # nothing to suggest: no empty list
        self.assertEqual(REPO.design_values("United States", "Army", "M", ["STATURE", "Sitting Height"])["count"], 2)

    def test_notes_say_why_something_is_missing(self):
        def notes(*a, **kw):
            return " ".join(REPO.mannequin(*a, **kw)["notes"])
        self.assertIn("Body mass does not exist for this sex, only for mixed / not stated", notes("Germany", "Aircrew", "M", 95))
        self.assertIn("Stature is not available as a harmonized measure here, only as 'other:stature_as_reported'", notes("United States", "Air Force", "F", 95))
        self.assertIn("Sitting height does not exist for this population at any reliability level", notes("Israel", "Recruits/trainees", "M", 95))
        self.assertIn("Only 4 dimensions are available in this population, none of them seated", notes("Israel", "Recruits/trainees", "M", 95))
        self.assertIn("hidden by the reliability filter", notes("Switzerland", "Recruits/trainees", "M", 50))
        self.assertNotIn("Only", notes("United States", "Army", "M", 50))
        self.assertNotIn("does not exist", notes("United States", "Army", "M", 50, measures=["stature"]))  # asked for one thing: no essentials lecture

    def test_caution_is_not_noise(self):
        m = REPO.mannequin("United States", "Army", "M", 95)
        self.assertNotIn("age", m["caution"])  # a sample descriptor, not a body dimension
        self.assertTrue(any("do not set it independently" in w for w in m["caution"]["bmi"]))
        for why in m["caution"].values():
            self.assertFalse("medium reliability" in " ".join(why) and any(w == "estimated from mean and SD" for w in why))  # one reason, not two for the same fact

    def test_compare_notes_follow_the_data(self):
        single = REPO.compare("stature", "M", 50, countries=["New Zealand", "Multiple: Turkey, Greece, Italy"], min_reliability="high")
        self.assertTrue(all(x["n_surveys"] == 1 for x in single["results"]))
        self.assertFalse(any("pool" in n or "combine" in n for n in single["notes"]), single["notes"])
        gb = REPO.compare("stature", "M", 95, countries=["United Kingdom", "France", "United States"])
        self.assertTrue(any("mixed / not stated" in n and "United Kingdom" in n for n in gb["notes"]), gb["notes"])

    def test_counts_name_their_unit(self):
        c = REPO.meta()["counts"]
        self.assertEqual((c["country_role_groups"], c["populations"]), (len(REPO._groups), len(REPO._roll)))
        self.assertGreater(c["populations"], c["country_role_groups"])

    def test_the_implausible_malaysian_sd_is_gone(self):
        d = REPO.design_values("Malaysia", "Army", "M", ["stature"], min_reliability="low")["measures"][0]
        self.assertIsNone(d["sd"])
        self.assertIsNone(d["percentiles"]["p95"])


class Round3(unittest.TestCase):
    def test_latest_works_for_every_population_and_never_with_a_false_error(self):
        """survey=latest used to be a 404 ('choose a sex that has data') for the 48 populations whose surveys are all low reliability."""
        low_only = 0
        for c in REPO.countries():
            for role in c["roles"]:
                for sex in role["sexes"]:
                    args = (c["id"], role["id"], sex)
                    combined = REPO.design_values(*args, min_reliability="low")
                    default = REPO.design_values(*args)
                    latest_low = REPO.design_values(*args, survey="latest", min_reliability="low")
                    latest = REPO.design_values(*args, survey="latest")
                    self.assertGreater(latest_low["count"], 0, args)
                    if default["count"] == 0:
                        low_only += 1
                        self.assertEqual(latest["count"], 0, args)
                        self.assertTrue(any("hidden because their reliability" in n for n in latest["notes"]), args)  # the same explanation as the combined answer
                        self.assertTrue(any("hidden because their reliability" in n for n in default["notes"]), args)
                    self.assertIsNotNone(REPO._latest_choice(c["name"], role["name"], sex)[0], args)
        self.assertGreater(low_only, 40)
        self.assertEqual(REPO.compare("stature", "M", 50, min_reliability="low", survey="latest")["total"] >= REPO.compare("stature", "M", 50, survey="latest")["total"], True)

    def test_why_a_survey_was_passed_over_is_stated_correctly(self):
        japan = " ".join(REPO.design_values("Japan", "Pilots", "both", survey="latest")["notes"])
        self.assertNotIn("newer", japan)  # the chosen survey is undated: nothing is called newer than it
        self.assertIn("not recorded", japan)
        s83 = REPO._latest_choice("Japan", "Pilots", "both")
        self.assertEqual(s83[1], [])
        us = REPO._latest_choice("United States", "Aircrew", "M")[1]
        self.assertTrue(us and "covers only" in us[0]["why"], us)
        thai = REPO._latest_choice("Thailand", "Army", "M")[1]
        self.assertEqual((thai[0]["year"], thai[0]["measures"], thai[0]["best"]), (2005, 6, 53))
        self.assertEqual(thai[0]["why"], "covers only 6 of 53 measures")
        self.assertTrue(any("not recorded" in n for n in REPO.design_values("Ecuador", "Recruits/trainees", "M", survey="latest")["notes"]))

    def test_the_documented_latest_rules_hold(self):
        """README: usable (medium/high) surveys, at least 100 people when any has, half the best measure count, stature plus mass when any has both,
        the newest dated one (undated only when no dated one qualifies), then part of the combined values, then the larger one. Re-implemented here from the CSV."""
        survey = {}
        for r in read("aggregates/aggregates.csv"):
            if r["is_primary"] != "1" or r["population_type"] == "civilian" or "#sub" in r["survey_group"] or num(r["mean"]) is None:
                continue
            d = survey.setdefault((r["country"], r["service_role"], r["sex"], r["survey_group"]), {"all": set(), "usable": set(), "n": 0, "year": None})
            d["all"].add(r["measure_key"])
            if r["reliability"] != "low":
                d["usable"].add(r["measure_key"])
            d["n"] = max(d["n"], int(float(r["n"])) if r["n"] else 0)
            if r["year_start"]:
                d["year"] = min(d["year"] or 9999, int(float(r["year_start"])))
        in_combined = {}
        for r in read("aggregates/rollup.csv"):
            for g in json.loads(r["survey_groups"]):
                in_combined.setdefault((r["country"], r["service_role"]), set()).add(g)
        by_pop = {}
        for (c, role, sex, sg), d in survey.items():
            by_pop.setdefault((c, role, sex), []).append((sg, d))
        checked = differences = 0
        for (c, role, sex), items in by_pop.items():
            usable = [(sg, d, d["usable"]) for sg, d in items if d["usable"]] or [(sg, d, d["all"]) for sg, d in items]
            best = max(len(k) for _, _, k in usable)
            pool = [x for x in usable if len(x[2]) * 2 >= best]
            pool = [x for x in pool if x[1]["n"] >= 100] or pool
            pool = [x for x in pool if {"stature", "mass"} <= x[2]] or pool
            top = max(pool, key=lambda x: (x[1]["year"] is not None, x[1]["year"] or 0, x[0] in in_combined.get((c, role), ()), x[1]["n"], len(x[2]), x[0]))
            got = REPO._latest_choice(c, role, sex)[0]
            checked += 1
            if got != top[0]:
                differences += 1
                self.fail(f"{c}/{role}/{sex}: service picks {got!r}, the documented rules pick {top[0]!r}")
        self.assertGreater(checked, 150)
        self.assertEqual(differences, 0)

    def test_the_essentials_notes_follow_the_survey_path_too(self):
        n = " ".join(REPO.mannequin("Netherlands", "Army", "M", 95, survey="latest")["notes"])
        self.assertIn("Body mass is hidden by the reliability filter", n)  # not 'is not in this survey'
        self.assertNotIn("Body mass is not in this survey", n)
        self.assertIn("Only 1 dimension is available in this survey", n)
        mv = " ".join(REPO.mannequin("Malaysia", "Army", "M", 50, min_reliability="low", survey=REPO.surveys("Malaysia", "Army")["surveys"][0]["id"])["notes"])
        self.assertIn("Stature has only a mean in this survey", mv)
        self.assertNotIn("Stature is not in this survey", mv)
        self.assertIn("Sitting height is not in this survey", mv)

    def test_measures_and_categories_combine_with_and_say_so(self):
        d = REPO.design_values("United States", "Army", "M", ["stature"], categories=["head-face"])
        self.assertEqual(d["count"], 0)
        self.assertTrue(any("combined with AND" in n and "stature (Heights (standing))" in n for n in d["notes"]), d["notes"])
        self.assertFalse(any("No data" in n for n in d["notes"]))
        self.assertFalse(any("combined with AND" in n for n in REPO.design_values("United States", "Army", "M", ["stature"], categories=["heights-standing"])["notes"]))

    def test_comma_aware_name_lists(self):
        pooled = "Multiple: Turkey, Greece, Italy"
        self.assertEqual(REPO.split_names(pooled), [pooled])
        self.assertEqual(REPO.split_names(f"Germany,{pooled},Poland"), ["Germany", pooled, "Poland"])
        self.assertEqual(REPO.split_names("Turkey, Greece, Italy"), ["Turkey", "Greece", "Italy"])
        self.assertEqual(REPO.split_names("Army, Navy", "role"), ["Army", "Navy"])
        self.assertEqual(REPO.split_names(" , "), [])
        self.assertEqual({x["country"] for x in REPO.compare("stature", countries=REPO.split_names(f"Germany, {pooled}"))["results"]}, {"Germany", pooled})

    def test_compare_hints_use_the_same_rules_as_the_results(self):
        # Austria women: the only other sex (men) has a stature that is mean-only, i.e. unusable: the hint must not send the user there
        n = " ".join(REPO.compare("stature", "F", 50, countries=["Austria"], min_reliability="low")["notes"])
        self.assertNotIn("usable data for: Austria", n)
        self.assertIn("too unreliable, too small or without percentiles", n)
        n2 = " ".join(REPO.compare("stature", "M", 95, countries=["United Kingdom"])["notes"])
        self.assertIn("usable data for: United Kingdom (only mixed / not stated)", n2)

    def test_implausible_sds_are_caught_at_the_source(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import validate_aggregates as va
        known, ranges = va.keys_and_ranges()
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "x.csv"
            row = dict.fromkeys(va.COLUMNS, "")
            row.update(source_id="s", source_file="f", population="p", country="Colombia", population_type="military", service_role="Officers", sex="both", measure_key="mass",
                       measure_label="Peso", unit_original="kg", mean="78.7", sd="0.14", n="55", quality="A")
            for sd, ok_ in (("0.14", False), ("12", True), ("", True)):
                row["sd"] = sd
                with open(f, "w", newline="", encoding="utf-8") as fh:
                    w = csv.DictWriter(fh, fieldnames=va.COLUMNS)
                    w.writeheader()
                    w.writerow(row)
                problems, _ = va.validate(f, known, ranges)
                self.assertEqual(not problems, ok_, (sd, problems))
        bad = [r for r in read("aggregates/aggregates.csv") if r["measure_key"] in va.CV_BOUNDS and r["sd"] and r["mean"] and
               not va.CV_BOUNDS[r["measure_key"]][0] <= float(r["sd"]) / abs(float(r["mean"])) <= va.CV_BOUNDS[r["measure_key"]][1]]
        self.assertEqual(bad, [])

    def test_a_snapshot_rebuild_leaves_no_stale_files(self):
        with tempfile.TemporaryDirectory() as t:
            first = snapshot.build(t)
            stray = Path(t) / "api" / "v1" / "mannequin" / "stale" / "x" / "M.json"
            stray.parent.mkdir(parents=True)
            stray.write_text("{}")
            other = Path(t) / "keep.txt"
            other.write_text("not ours")
            second = snapshot.build(t)
            self.assertFalse(stray.exists())
            self.assertTrue(other.exists())  # only <out>/api/v1 is touched
            self.assertEqual(first["files"], second["files"])
            self.assertEqual(second["files"], sum(1 for f in (Path(t) / "api" / "v1").rglob("*") if f.is_file()))


class Round4(unittest.TestCase):
    def test_splitting_a_name_list_costs_time_in_proportion_to_its_length(self):
        import time
        self.assertEqual(REPO._name_pieces, max(n.count(",") + 1 for n in [*REPO._countries, *REPO._all_roles]))
        t = time.time()
        REPO.split_names(",".join(["Germany"] * 200))
        REPO.split_names(",".join(["a"] * 200), "role")
        self.assertLess(time.time() - t, 1.0)  # it was cubic: 800 names took 24 s
        with self.assertRaises(BadRequest):
            REPO.split_names(",".join(["Germany"] * 201))
        self.assertEqual(REPO.split_names("Multiple: Turkey, Greece, Italy, Multiple: Turkey, Greece, Italy"), ["Multiple: Turkey, Greece, Italy"] * 2)

    def test_a_missing_year_is_only_compared_when_there_is_something_to_compare_with(self):
        only = " ".join(REPO.design_values("Angola", "Cadets", "both", survey="latest", min_reliability="low")["notes"])
        self.assertIn("The year of this survey is not recorded.", only)
        self.assertNotIn("other surveys", only)
        several = " ".join(REPO.design_values("Ecuador", "Recruits/trainees", "M", survey="latest")["notes"])
        self.assertIn("not recorded, so its recency could not be checked against the other surveys", several)

    def test_the_other_sex_hint_is_not_a_dead_end(self):
        korea = " ".join(REPO.mannequin("South Korea", "Army", "M", 50)["notes"])
        self.assertIn("Stature does not exist for this sex; for women it exists only below the reliability filter", korea)
        self.assertNotIn("only for women", korea)  # women's values are low reliability too: switching sex would return nothing as well
        self.assertNotIn("Only 0 dimensions", korea)
        self.assertIn("only for mixed / not stated", " ".join(REPO.mannequin("Germany", "Aircrew", "M", 50)["notes"]))

    def test_corrected_source_rows(self):
        men = REPO.design_values("Australia", "Army", "M", ["other:front_length"])["measures"][0]
        women = REPO.design_values("Australia", "Army", "F", ["other:front_length"])["measures"][0]
        self.assertEqual((men["mean"], men["sd"], men["percentiles"]["p50"]), (362.0, 24.0, 362.0))  # mean and SD had been swapped between the sexes
        self.assertEqual((women["mean"], women["sd"], women["percentiles"]["p50"]), (332.0, 20.8, 332.0))
        leg = REPO.design_values("Indonesia", "Army", "M", ["other:leg_length"], min_reliability="low")["measures"][0]
        self.assertEqual((leg["mean"], leg["sd"], leg["percentiles"]["p95"]), (1027.1, None, None))  # P95 1450 was 3.6 SD above the mean
        self.assertNotIn("other:leg_length", REPO.mannequin("Indonesia", "Army", "M", 95)["values"])

    def test_inconsistent_percentiles_are_caught_at_the_source(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import validate_aggregates as va
        known, ranges = va.keys_and_ranges()

        def problems(**fields):
            with tempfile.TemporaryDirectory() as t:
                f = Path(t) / "x.csv"
                row = dict.fromkeys(va.COLUMNS, "")
                row.update(source_id="s", source_file="f", population="p", country="Australia", population_type="military", service_role="Army", sex="M", measure_key="other:front_length",
                           measure_label="Front length", unit_original="mm", quality="A")
                row.update(fields)
                with open(f, "w", newline="", encoding="utf-8") as fh:
                    w = csv.DictWriter(fh, fieldnames=va.COLUMNS)
                    w.writeheader()
                    w.writerow(row)
                return va.validate(f, known, ranges)[0]
        self.assertTrue(problems(mean="332", sd="20.8", n="100", p5="323", p50="362", p95="403"))  # the swapped AWAS row
        self.assertTrue(problems(mean="1027.1", sd="117.4", n="268", p5="940", p95="1450"))  # P95 3.6 SD above the mean
        self.assertFalse(problems(mean="362", sd="24", n="100", p5="323", p50="362", p95="403"))
        self.assertFalse(problems(mean="332", sd="20.8", n="100"))  # no percentiles: nothing to contradict
        self.assertFalse(problems(mean="548", sd="37", n="100", p5="438", p50="558", p95="558", measure_key="other:crotch_waist_preferred_posterior"))  # preference scales are not body dimensions

    def test_host_and_origin_strings(self):
        from anthro_service.origins import clean_host, clean_origin
        self.assertEqual(clean_host("Anthro_MCP:8001"), "anthro_mcp:8001")  # container names use underscores
        self.assertEqual(clean_host("Bücher.example"), "xn--bcher-kva.example")
        self.assertEqual(clean_host("mcp.example.org."), "mcp.example.org")
        self.assertEqual(clean_origin("https://App.Example:443/"), "https://app.example")
        self.assertEqual(clean_origin("http://my_web:3000"), "http://my_web:3000")
        self.assertEqual(clean_origin("http://x.example:80"), "http://x.example")
        self.assertEqual(clean_origin("https://x.example:8443"), "https://x.example:8443")
        for bad in ("a,b", "*.x", "a:", "a/b", "https://x", "", " "):
            with self.assertRaises(ValueError):
                clean_host(bad)
        for bad in ("x.example", "https://x.example/app", "https://*.x", "https://a,https://b", "ftp://x", "https://x:"):
            with self.assertRaises(ValueError):
                clean_origin(bad)


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
    def check_values_file(self, got: dict, live: dict, in_latest_file: bool):
        self.assertEqual({k: v for k, v in got.items() if k != "notes"}, json.loads(json.dumps({k: v for k, v in live.items() if k != "notes"})))
        self.assert_static_notes(got["notes"])
        self.assertEqual(got["notes"][0], live["notes"][0])  # the disclaimer is untouched
        self.assertEqual(len(got["notes"]), len(live["notes"]) + 1)  # one note per live note, plus what the static files hold
        span = live["population"]["years"] or [0, 0]
        for g, l in zip(got["notes"], live["notes"]):
            self.assertEqual(g, snapshot.static_note(l, in_latest_file, span[1] - span[0] > VINTAGE_YEARS))

    def check_mannequin_notes(self, got: list, live: list, in_latest_file: bool):
        self.assert_static_notes(got)
        self.assertFalse(any(n.startswith(("Percentile 50 of each", "Every dimension is percentile")) for n in got))  # those belong to one percentile
        self.assertEqual(sum(1 for n in got if n.startswith("Each dimension is the stated percentile")), 1)
        kept = [n for n in live if not n.startswith(("Percentile 50 of each", "Every dimension is percentile"))]
        self.assertEqual(len(got), len(kept) + 2)  # the boundary line and the static sentence

    def assert_static_notes(self, notes: list):
        text = " ".join(notes)
        for live_only in ("by id", "survey list", "survey=latest", "set min_reliability"):
            self.assertNotIn(live_only, text)  # advice a static reader cannot follow
        self.assertEqual(notes[-1], snapshot.STATIC_SENTENCE)

    def test_static_notes_and_files_have_the_documented_shape(self):
        """Literal expectations for a few populations (the live-versus-static comparison above uses the same functions, so it cannot catch a wrong rewrite)."""
        with tempfile.TemporaryDirectory() as t:
            snapshot.build(t)
            base = Path(t) / "api" / "v1"
            get = lambda rel: json.loads((base / rel).read_text(encoding="utf-8"))
            army = get("populations/united-states/army/M.json")
            self.assertIn("The combined values mix surveys from 1966 to 2010. Body size and landmark definitions changed over such a period: for current personnel use the .latest file "
                          "(now 'ANSUR II 2012', 2010).", army["notes"])
            thai = get("populations/thailand/army/M.json")
            self.assertTrue(any(("The .latest file is 'Royal Thai Army 1962-63', 1962, because the newer 'Royal Thai Army personnel, men, 20-60 y' (2005, 4030 people) covers only 6 of 53 "
                                             "measures; that newer survey is only available from the live API.") in n for n in thai["notes"]), thai["notes"])
            korea = get("mannequin/south-korea/cadets/M.json") if (base / "mannequin/south-korea/cadets/M.json").exists() else None
            self.assertIsNone(korea)  # all low reliability: no mannequin file
            swiss = get("mannequin/switzerland/recruits-trainees/M.json")
            self.assertIn("every reliability level is in the populations file of this population", " ".join(swiss["notes"]))
            m = get("mannequin/united-states/army/M.json")
            self.assertEqual(set(m), {"population", "min_reliability", "hidden_by_reliability", "units", "dimensions", "percentiles", "notes"})
            self.assertEqual(set(m["dimensions"]["stature"]), {"name", "category", "unit", "n", "reliability", "years", "sources", "n_surveys", "survey_spread_pct"})
            self.assertEqual(set(m["percentiles"]["p95"]), {"core", "values", "basis", "caution", "count", "unavailable"})
            self.assertIn("(body size changed over time, or the landmarks differ; see the .latest file)", " ".join(w for why in m["percentiles"]["p95"]["caution"].values() for w in why))
            index = get("index.json")
            entry = next(e for e in index["populations"] if (e["country_id"], e["role_id"], e["sex"]) == ("united-states", "army", "M"))
            self.assertEqual(set(entry), {"country", "country_id", "role", "role_id", "sex", "measures", "values_json", "values_csv", "mannequin_json", "latest_survey",
                                          "latest_values_json", "latest_values_csv", "latest_mannequin_json"})
            self.assertEqual(entry["latest_survey"], {"id": "ansur-ii-2012", "name": "ANSUR II 2012", "year": 2010})
            self.assertEqual(entry["latest_values_json"], "/api/v1/populations/united-states/army/M.latest.json")
            self.assertIsNotNone(index.get("attribution"))
            raw = (base / "populations/serbia/cadets/M.json").read_text(encoding="utf-8")
            self.assertNotIn("\\u04", raw)  # non-ASCII names stay readable instead of \\uXXXX escapes

    def test_snapshot_matches_the_live_values(self):
        """Every population, every file: the static files say what the live service says (values, mannequin, latest variants, links)."""
        with tempfile.TemporaryDirectory() as t:
            r = snapshot.build(t)
            base = Path(t) / "api" / "v1"
            load = lambda url: json.loads((base / url.split("/api/v1/")[1]).read_text(encoding="utf-8"))
            index = load("/api/v1/index.json")
            self.assertEqual(r["populations"], len(index["populations"]))
            self.assertEqual(r["populations"], len(REPO._roll))
            self.assertEqual(r["populations"], REPO.meta()["counts"]["populations"])
            self.assertEqual(r["files"], sum(1 for f in base.rglob("*") if f.is_file()))
            empty = latest_files = 0
            for e in index["populations"]:
                args = (e["country_id"], e["role_id"], e["sex"])
                want = REPO.design_values(*args, percentiles=[5, 50, 95], min_reliability="low")
                self.check_values_file(load(e["values_json"]), want, False)
                self.assertTrue((base / e["values_csv"].split("/api/v1/")[1]).read_text(encoding="utf-8").startswith("country,role,sex"))
                variants = [(e["mannequin_json"], None)]
                span = want["population"]["years"] or [0, 0]
                self.assertEqual(bool(e["latest_survey"]), span[1] - span[0] > VINTAGE_YEARS, args)  # the one constant shared with the vintage note
                if e["latest_survey"]:
                    latest_files += 1
                    self.check_values_file(load(e["latest_values_json"]), REPO.design_values(*args, percentiles=[5, 50, 95], min_reliability="low", survey="latest"), True)
                    variants.append((e["latest_mannequin_json"], "latest"))
                for url, survey in variants:
                    answers = {p: REPO.mannequin(*args, p, survey=survey) for p in (5, 50, 95)}
                    if not any(a["dimensions"] for a in answers.values()):  # nothing at high or medium reliability: no file, and the index says so
                        empty += 1
                        self.assertIsNone(url, args)
                        continue
                    f = load(url)
                    m50 = answers[50]
                    self.check_mannequin_notes(f["notes"], m50["notes"], survey == "latest")
                    self.assertEqual(f["population"], m50["population"], args)  # the surveys and years behind THESE dimensions
                    self.assertEqual(f["hidden_by_reliability"], m50["hidden_by_reliability"], args)
                    span_years = (want["population"]["years"] or [0, 0])
                    for p, a in answers.items():
                        got = f["percentiles"][f"p{p}"]
                        live_caution = {k: [snapshot.static_caution(w, survey == "latest", span_years[1] - span_years[0] > VINTAGE_YEARS) for w in why] for k, why in a["caution"].items()}
                        self.assertEqual((got["values"], got["core"], got["caution"], got["unavailable"], got["count"]), (a["values"], a["core"], live_caution, a["unavailable"], a["count"]), (args, p))
                        self.assertNotIn("survey=latest", json.dumps(got["caution"]))  # a static reader cannot pass it
                        if survey != "latest" and not e["latest_survey"]:
                            self.assertNotIn(".latest file", json.dumps(got["caution"]))  # and must not be sent to a file that does not exist
                        self.assertEqual(got["basis"], {d["key"]: d["basis"] for d in a["dimensions"]})
                    for key, d in f["dimensions"].items():
                        want_d = next(x for x in m50["dimensions"] if x["key"] == key)
                        self.assertEqual({k: d[k] for k in ("unit", "n", "reliability", "years", "sources")}, {k: want_d[k] for k in ("unit", "n", "reliability", "years", "sources")})
                        self.assertEqual(f["units"][key], d["unit"])
            self.assertGreater(empty, 0)
            self.assertGreater(latest_files, 5)
            for name in ("meta", "countries", "measures", "categories"):
                self.assertTrue(json.loads((base / f"{name}.json").read_text(encoding="utf-8")))
            self.assertEqual(len(json.loads((base / "measures.json").read_text(encoding="utf-8"))), REPO.meta()["counts"]["measures"])
            self.assertEqual(sum(c["measures"] for c in json.loads((base / "categories.json").read_text(encoding="utf-8"))), REPO.meta()["counts"]["measures"])

    def test_the_build_needs_no_third_party_packages(self):
        code = "import sys, builtins\nreal = builtins.__import__\n" \
               "def guard(name, *a, **k):\n    if name.split('.')[0] in ('fastapi', 'pydantic', 'mcp', 'starlette', 'uvicorn'):\n        raise ImportError(name)\n    return real(name, *a, **k)\n" \
               "builtins.__import__ = guard\nsys.path.insert(0, sys.argv[1])\nfrom anthro_service import snapshot\nprint(snapshot.build(sys.argv[2])['populations'])\n"
        with tempfile.TemporaryDirectory() as t:
            out = subprocess.run([sys.executable, "-I", "-c", code, str(ROOT), t], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)


if __name__ == "__main__":
    unittest.main()
