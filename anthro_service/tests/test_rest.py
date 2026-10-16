"""REST API tests. Need:  pip install -r anthro_service/requirements.txt   (skipped when fastapi or httpx is missing)."""
from __future__ import annotations

import csv
import io
import os
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    from fastapi.testclient import TestClient
    from anthro_service.rest import create_app
except ImportError:  # pragma: no cover
    TestClient = None

from anthro_service import get_repo  # noqa: E402

REPO = get_repo()
Q = {"country": "United States", "role": "Army", "sex": "M"}


@unittest.skipIf(TestClient is None, "fastapi / httpx not installed")
class Rest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop("ANTHRO_API_KEYS", None)
        cls.c = TestClient(create_app())

    def test_health_meta_and_headers(self):
        r = self.c.get("/v1/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data_version"], REPO.data_version)
        self.assertEqual(r.headers["x-data-version"], REPO.data_version)
        m = self.c.get("/v1/meta").json()
        self.assertEqual(m["counts"], REPO.meta()["counts"])
        self.assertEqual(self.c.get("/v1/meta").headers["cache-control"], "public, max-age=3600")

    def test_design_values_equal_the_library(self):
        for path in (f"/v1/populations/united-states/army/M", "/v1/populations/USA/Army/male"):
            self.assertEqual(self.c.get(path, params={"measures": "stature,mass"}).json()["count"], 2)
        r = self.c.get("/v1/design-values", params={**Q, "measures": "stature", "percentiles": "5,50,95,97.5"})
        self.assertEqual(r.status_code, 200)
        want = REPO.design_values("United States", "Army", "M", ["stature"], percentiles=[5, 50, 95, 97.5])
        self.assertEqual(r.json()["measures"][0]["percentiles"], want["measures"][0]["percentiles"])
        self.assertEqual(r.json()["population"]["country_id"], "united-states")

    def test_stats_false_drops_mean_and_sd(self):
        m = self.c.get("/v1/design-values", params={**Q, "measures": "stature", "stats": "false"}).json()["measures"][0]
        self.assertNotIn("mean", m)
        self.assertNotIn("sd", m)

    def test_csv_and_xml_by_suffix_and_by_format(self):
        a = self.c.get("/v1/populations/united-states/army/M.csv", params={"measures": "stature,mass"})
        b = self.c.get("/v1/design-values", params={**Q, "measures": "stature,mass", "format": "csv"})
        self.assertEqual(a.text, b.text)
        self.assertTrue(a.headers["content-type"].startswith("text/csv"))
        rows = list(csv.DictReader(io.StringIO(a.text)))
        self.assertEqual(sorted(r["key"] for r in rows), ["mass", "stature"])
        x = self.c.get("/v1/populations/united-states/army/M.xml", params={"measures": "stature"})
        self.assertTrue(x.headers["content-type"].startswith("application/xml"))
        self.assertTrue(len(ET.fromstring(x.content)))
        j = self.c.get("/v1/populations/united-states/army/M.json", params={"measures": "stature"})
        self.assertEqual(j.json()["count"], 1)

    def test_mannequin_and_compare(self):
        m = self.c.get("/v1/mannequin", params={**Q, "percentile": 95}).json()
        want = REPO.mannequin("United States", "Army", "M", 95)
        self.assertEqual(m["values"], want["values"])
        self.assertEqual(m["core"], want["core"])
        self.assertEqual(m["percentile"], 95)
        c = self.c.get("/v1/compare", params={"measure": "stature", "percentile": 95, "limit": 5, "format": "csv"})
        self.assertEqual(len(list(csv.DictReader(io.StringIO(c.text)))), 5)
        self.assertEqual(self.c.get("/v1/mannequin", params={**Q, "format": "xml"}).status_code, 200)

    def test_catalog_endpoints(self):
        self.assertTrue(any(c["id"] == "united-states" for c in self.c.get("/v1/countries").json()))
        roles = self.c.get("/v1/countries/USA").json()["roles"]
        self.assertIn("army", [r["id"] for r in roles])
        self.assertEqual(len(self.c.get("/v1/categories").json()), len(REPO.categories()))
        self.assertIn("sitting_height", [m["key"] for m in self.c.get("/v1/measures", params={"q": "sitting height"}).json()])
        self.assertEqual(self.c.get("/v1/measures/stature").json()["key"], "stature")
        other = next(k for k in REPO._measures if k.startswith("other:"))
        self.assertEqual(self.c.get(f"/v1/measures/{other}").json()["key"], other)
        self.assertTrue(self.c.get("/v1/measures", params={"limit": 3, "format": "csv"}).text.startswith("key,"))
        s = self.c.get("/v1/populations/united-states/army/surveys").json()
        self.assertIn("ansur-ii-2012", [x["id"] for x in s["surveys"]])
        self.assertEqual(self.c.get("/v1/sources/ansur-ii-2012").json()["id"], "ansur-ii-2012")

    def test_errors_have_one_json_shape(self):
        cases = [("/v1/design-values", {"country": "Narnia", "role": "Army"}, 404, "not_found"),
                 ("/v1/design-values", {**Q, "sex": "X"}, 422, "bad_request"),
                 ("/v1/design-values", {**Q, "percentiles": "abc"}, 422, "bad_request"),
                 ("/v1/design-values", {**Q, "min_reliability": "bogus"}, 422, "bad_request"),
                 ("/v1/design-values", {**Q, "measures": "no_such"}, 404, "not_found"),
                 ("/v1/design-values", {"role": "Army"}, 422, "bad_request"),
                 ("/v1/mannequin", {**Q, "percentile": 150}, 422, "bad_request"),
                 ("/v1/compare", {"measure": "stature", "limit": 0}, 422, "bad_request"),
                 ("/v1/measures/nope", {}, 404, "not_found"),
                 ("/v1/populations/united-states/army/surveys", {}, 200, None),
                 ("/v1/populations/united-states/nope/surveys", {}, 404, "not_found")]
        for path, params, status, code in cases:
            r = self.c.get(path, params=params)
            self.assertEqual(r.status_code, status, (path, params, r.text[:200]))
            if code:
                self.assertEqual(r.json()["error"]["code"], code, (path, params))
                self.assertTrue(r.json()["error"]["message"])

    def test_unknown_country_suggests_close_matches(self):
        e = self.c.get("/v1/design-values", params={"country": "Germny", "role": "Army"}).json()["error"]
        self.assertIn("Germany", e["available"])

    def test_cors(self):
        r = self.c.get("/v1/health", headers={"Origin": "http://example.com"})
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertIn("x-data-version", r.headers["access-control-expose-headers"].lower())
        pre = self.c.options("/v1/mannequin", headers={"Origin": "http://example.com", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-api-key"})
        self.assertEqual(pre.status_code, 200)

    def test_openapi_describes_every_endpoint(self):
        spec = self.c.get("/openapi.json").json()
        self.assertEqual(spec["info"]["title"], "Military Anthropometry API")
        for p in ("/v1/design-values", "/v1/mannequin", "/v1/compare", "/v1/populations/{country}/{role}/{sex}", "/v1/countries", "/v1/measures"):
            self.assertIn(p, spec["paths"])
        self.assertIn("DesignValues", spec["components"]["schemas"])
        self.assertEqual(self.c.get("/docs").status_code, 200)
        self.assertEqual(self.c.get("/").json()["openapi"], "/openapi.json")

    def test_committed_openapi_file_is_current(self):
        """anthro_service/openapi.json is what integrators import; regenerate it with  python -m anthro_service openapi --out anthro_service/openapi.json"""
        import json
        committed = json.loads((ROOT / "anthro_service" / "openapi.json").read_text(encoding="utf-8"))
        live = self.c.get("/openapi.json").json()
        self.assertEqual(sorted(committed["paths"]), sorted(live["paths"]))
        self.assertEqual(sorted(committed["components"]["schemas"]), sorted(live["components"]["schemas"]))
        for path, ops in live["paths"].items():
            for method, op in ops.items():
                have = [p["name"] for p in committed["paths"][path][method].get("parameters", [])]
                self.assertEqual(have, [p["name"] for p in op.get("parameters", [])], (path, method))
        self.assertEqual(committed["info"]["version"], live["info"]["version"])


@unittest.skipIf(TestClient is None, "fastapi / httpx not installed")
class RestWithKeys(unittest.TestCase):
    def setUp(self):
        os.environ["ANTHRO_API_KEYS"] = "alpha-key, beta-key"
        self.c = TestClient(create_app())

    def tearDown(self):
        os.environ.pop("ANTHRO_API_KEYS", None)

    def test_keys_are_required_on_v1_but_not_on_health(self):
        self.assertEqual(self.c.get("/v1/health").status_code, 200)
        r = self.c.get("/v1/meta")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (401, "unauthorized"))
        self.assertEqual(self.c.get("/v1/meta", headers={"X-API-Key": "wrong"}).status_code, 401)
        self.assertEqual(self.c.get("/v1/meta", headers={"X-API-Key": "alpha-key"}).status_code, 200)
        ok = self.c.get("/v1/meta", headers={"Authorization": "Bearer beta-key"})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(ok.headers["cache-control"].startswith("private"))
        self.assertEqual(self.c.get("/v1/meta", headers={"Authorization": "Basic beta-key"}).status_code, 401)
        self.assertEqual(self.c.get("/v1/design-values", params={"country": "x", "role": "y"}).status_code, 401)  # auth before lookups


if __name__ == "__main__":
    unittest.main()
