"""REST API tests. Need:  pip install -r anthro_service/requirements.txt   (skipped when fastapi or httpx is missing)."""
from __future__ import annotations

import csv
import http.client
import importlib.util
import io
import os
import socket
import subprocess
import sys
import time
import unittest
import json
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    from fastapi.testclient import TestClient
    from anthro_service.rest import create_app
except ImportError:  # pragma: no cover
    if os.environ.get("REQUIRE_SERVICE_DEPS") == "1":
        raise
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
        self.assertEqual(self.c.get("/v1/health").headers["cache-control"], "no-store")  # a liveness check must not be cached

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
        """anthro_service/openapi.json is what integrators import; regenerate it with  python -m anthro_service openapi --out anthro_service/openapi.json
        Compares the structure (paths, parameters, response types, security, model fields), not the formatting, so a FastAPI upgrade does not fail it."""
        import json
        committed = json.loads((ROOT / "anthro_service" / "openapi.json").read_text(encoding="utf-8"))
        live = self.c.get("/openapi.json").json()
        self.assertEqual(sorted(committed["paths"]), sorted(live["paths"]))
        for path, ops in live["paths"].items():
            for method, op in ops.items():
                old = committed["paths"][path][method]
                self.assertEqual([p["name"] for p in old.get("parameters", [])], [p["name"] for p in op.get("parameters", [])], (path, method))
                self.assertEqual(sorted(old["responses"]["200"].get("content", {})), sorted(op["responses"]["200"].get("content", {})), (path, method))
                self.assertEqual(old.get("security"), op.get("security"), (path, method))
        self.assertEqual(sorted(committed["components"]["schemas"]), sorted(live["components"]["schemas"]))
        for name, schema in live["components"]["schemas"].items():
            self.assertEqual(sorted(committed["components"]["schemas"][name].get("properties", {})), sorted(schema.get("properties", {})), name)
        self.assertEqual(sorted(committed["components"].get("securitySchemes", {})), sorted(live["components"].get("securitySchemes", {})))
        self.assertEqual(committed["info"]["version"], live["info"]["version"])

    def test_openapi_documents_security_and_the_csv_xml_answers(self):
        spec = self.c.get("/openapi.json").json()
        self.assertEqual(sorted(spec["components"]["securitySchemes"]), ["APIKeyHeader", "HTTPBearer"])
        self.assertTrue(spec["paths"]["/v1/meta"]["get"]["security"])
        self.assertNotIn("security", spec["paths"]["/v1/health"]["get"])
        for path in ("/v1/mannequin", "/v1/design-values", "/v1/compare", "/v1/populations/{country}/{role}/{sex}"):
            self.assertEqual(sorted(spec["paths"][path]["get"]["responses"]["200"]["content"]), ["application/json", "application/xml", "text/csv"], path)

    def test_every_failure_is_a_json_error(self):
        from unittest import mock
        quiet = TestClient(create_app(), raise_server_exceptions=False)
        for method, path, status, code in (("GET", "/v1/nonexistent", 404, "not_found"), ("POST", "/v1/meta", 405, "method_not_allowed"), ("PUT", "/v1/design-values", 405, "method_not_allowed"),
                                           ("GET", "/v1/measures/", 422, "bad_request"), ("GET", "/v1/measures/%20", 422, "bad_request"),
                                           ("GET", "/v1/compare?measure=", 422, "bad_request"), ("GET", "/v1/compare?measure=%20", 422, "bad_request")):
            r = quiet.request(method, path)
            self.assertEqual((r.status_code, r.json()["error"]["code"]), (status, code), (method, path, r.text[:100]))
            self.assertTrue(r.headers["content-type"].startswith("application/json"))
        with mock.patch("anthro_service.core.Repo.meta", side_effect=RuntimeError("boom")):
            r = quiet.get("/v1/meta")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (500, "internal_error"))
        self.assertNotIn("boom", r.text)  # no internals in the answer

    def test_a_misspelled_parameter_is_an_error_not_a_silent_default(self):
        for path, params, want in (("/v1/mannequin", {**Q, "percentiles": "95"}, "percentile"), ("/v1/compare", {"measure": "stature", "country": "Germany"}, "countries"),
                                   ("/v1/mannequin", {**Q, "percentile": 95, "measure": "stature"}, "measures"), ("/v1/design-values", {**Q, "percentile": 95}, "percentiles"),
                                   ("/v1/measures", {"query": "head"}, "q"), ("/v1/measures/stature", {"x": 1}, None)):
            r = self.c.get(path, params=params)
            self.assertEqual(r.status_code, 422, (path, params))
            e = r.json()["error"]
            self.assertEqual(e["code"], "bad_request")
            self.assertIn("Unknown parameter", e["message"])
            if want:
                self.assertIn(f"'{want}'", e["hint"])
        self.assertEqual(self.c.get("/v1/mannequin", params={**Q, "percentile": 95, "format": "csv"}).status_code, 200)  # every declared parameter still works

    def test_json_declares_utf8_and_the_spec_stays_plain(self):
        for path in ("/v1/meta", "/v1/nonexistent", "/v1/design-values?country=Narnia&role=x"):
            self.assertEqual(self.c.get(path).headers["content-type"], "application/json; charset=utf-8", path)
        r = self.c.get("/v1/design-values", params={**Q, "measures": "bmi"})
        self.assertIn("kg/m²", r.content.decode("utf-8"))
        spec = self.c.get("/openapi.json").json()
        self.assertIn("application/json", spec["paths"]["/v1/meta"]["get"]["responses"]["200"]["content"])

    def test_a_crash_is_a_json_500_with_the_usual_headers(self):
        from unittest import mock
        quiet = TestClient(create_app(), raise_server_exceptions=False)
        with mock.patch("anthro_service.core.Repo.meta", side_effect=RuntimeError("boom")):
            r = quiet.get("/v1/meta", headers={"Origin": "https://tool.example.org"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (500, "internal_error"))
        self.assertEqual(r.headers["x-data-version"], REPO.data_version)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")

    def test_the_texts_of_the_spec_match_the_behaviour(self):
        spec = self.c.get("/openapi.json").json()
        text = json.dumps(spec)
        self.assertNotIn("BMI)", spec["paths"]["/v1/mannequin"]["get"]["description"])
        self.assertIn("(stature, body mass, sitting height)", spec["paths"]["/v1/mannequin"]["get"]["description"])
        measures = spec["paths"]["/v1/measures"]["get"]["responses"]["200"]
        self.assertNotIn("XML", measures["description"])
        self.assertEqual(sorted(measures["content"]), ["application/json", "text/csv"])
        self.assertEqual(self.c.get("/v1/measures", params={"format": "xml"}).status_code, 422)
        self.assertIn("latest", text)

    def test_csv_headers_are_clean_ascii(self):
        r = self.c.get("/v1/mannequin", params={"country": "Czech Republic", "role": "Army", "sex": "M", "percentile": 95, "min_reliability": "all", "format": "csv"})
        self.assertEqual(r.status_code, 200)
        notes = r.headers["x-notes"]
        self.assertTrue(notes.isascii() and "?" not in notes.split("(listed")[0] and not any(ord(ch) < 32 for ch in notes))
        self.assertIn("JSON and XML answers", notes)  # the CSV has no unavailable rows: it says where they are
        self.assertIn("kozni", notes)  # accents are dropped, not turned into '?'

    def test_head_and_read_only(self):
        for path in ("/v1/health", "/v1/meta", "/v1/mannequin?country=USA&role=Army&sex=M"):
            r = self.c.head(path)
            self.assertEqual((r.status_code, r.content), (200, b""), path)
            self.assertEqual(r.headers["x-data-version"], REPO.data_version)
        self.assertEqual(self.c.head("/v1/nonexistent").status_code, 404)

    def test_role_names_with_a_slash_work_in_paths(self):
        for path in ("/v1/populations/united-states/Recruits/trainees/M", "/v1/populations/United%20States/Recruits%2Ftrainees/M", "/v1/populations/united-states/recruits-trainees/M"):
            r = self.c.get(path, params={"measures": "stature"})
            self.assertEqual((r.status_code, r.json()["population"]["role"]), (200, "Recruits/trainees"), path)
        r = self.c.get("/v1/populations/united-states/Recruits/trainees/surveys")
        self.assertEqual((r.status_code, r.json()["role"]), (200, "Recruits/trainees"))
        self.assertEqual(self.c.get("/v1/populations/united-states/army/surveys").json()["role"], "Army")
        self.assertEqual(self.c.get("/v1/populations/united-states/Recruits/trainees/M.csv", params={"measures": "stature"}).status_code, 200)
        self.assertEqual(self.c.get("/v1/populations/united-states/nope/M").json()["error"]["code"], "not_found")

    def test_survey_latest_total_count_and_compare(self):
        r = self.c.get("/v1/design-values", params={**Q, "measures": "stature", "survey": "latest"}).json()
        self.assertEqual(r["population"]["survey"]["id"], "ansur-ii-2012")
        self.assertEqual(r["measures"][0]["percentile_basis"]["p50"], "reported")
        combined = self.c.get("/v1/design-values", params={**Q, "measures": "stature"}).json()
        self.assertEqual(combined["measures"][0]["percentile_basis"]["p50"], "pooled")
        self.assertTrue(any("survey=latest" in n for n in combined["notes"]))
        m = self.c.get("/v1/measures", params={"q": "head", "limit": 2})
        self.assertEqual((len(m.json()), m.headers["x-total-count"]), (2, str(len(REPO.measures(q="head")))))
        self.assertEqual(self.c.get("/v1/measures", params={"category": "zzz"}).status_code, 404)
        c = self.c.get("/v1/compare", params={"measure": "sitting_height", "countries": "United States,Germany,Israel", "limit": 1}).json()
        self.assertEqual((c["count"], c["truncated"]), (1, True))
        self.assertGreater(c["total"], 1)
        self.assertIn("Israel", c["no_data"]["countries"])

    def test_csv_and_xml_carry_the_notes(self):
        r = self.c.get("/v1/mannequin", params={**Q, "percentile": 95, "format": "csv"})
        self.assertIn("boundary case", r.headers["x-disclaimer"])
        self.assertIn("x-hidden-by-reliability", r.headers)
        self.assertIn("survey=latest", r.headers["x-notes"])
        header = r.text.splitlines()[0].split(",")
        self.assertTrue({"year_min", "year_max", "sources", "caution", "n_surveys"} <= set(header))
        x = ET.fromstring(self.c.get("/v1/mannequin", params={**Q, "percentile": 95, "format": "xml"}).content)
        self.assertGreater(len(x.findall("notes/note")), 1)
        self.assertIn("hiddenByReliability", x.attrib)
        d = ET.fromstring(self.c.get("/v1/design-values", params={**Q, "measures": "stature", "format": "xml"}).content)
        m = d.find("measure")
        self.assertTrue({"sources", "nSurveys", "yearMin", "officialDocuments"} <= set(m.attrib))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(TestClient is None, "fastapi / httpx not installed")
class RealServer(unittest.TestCase):
    """HEAD through a real uvicorn, on both HTTP backends: the TestClient cannot show the httptools failure (a body-less answer with a Content-Length)."""

    def run_server(self, backend: str):
        if backend == "httptools" and importlib.util.find_spec("httptools") is None:
            if os.environ.get("REQUIRE_SERVICE_DEPS") == "1":
                self.fail("httptools is required (REQUIRE_SERVICE_DEPS=1) but not installed")
            self.skipTest("httptools is not installed")
        port = free_port()
        p = subprocess.Popen([sys.executable, "-W", "ignore", "-m", "uvicorn", "anthro_service.rest:app", "--port", str(port), "--http", backend, "--log-level", "warning"],
                             cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (p.terminate(), p.wait(10)))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                return port, p
            except OSError:
                time.sleep(0.1)
        self.fail("the server did not start")

    def check(self, backend: str):
        port, proc = self.run_server(backend)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        for _ in range(3):  # the same keep-alive connection: one broken HEAD would close it
            conn.request("HEAD", "/v1/meta")
            r = conn.getresponse()
            self.assertEqual((r.status, r.read()), (200, b""))
            head_length = r.getheader("content-length")
            conn.request("GET", "/v1/meta")
            g = conn.getresponse()
            self.assertEqual(g.status, 200)
            self.assertEqual(str(len(g.read())), head_length)
        conn.request("HEAD", "/v1/nonexistent")
        self.assertEqual(conn.getresponse().status, 404)
        conn.close()
        proc.terminate()
        err = proc.stderr.read()
        self.assertNotIn("Exception in ASGI application", err)
        self.assertNotIn("Content-Length", err)

    def test_head_with_h11(self):
        self.check("h11")

    def test_head_with_httptools(self):
        self.check("httptools")


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
        self.assertIn("Bearer", self.c.get("/v1/meta").headers["www-authenticate"])
        self.assertEqual(self.c.get("/v1/measures/stature", headers={"X-API-Key": "alpha-key"}).status_code, 200)  # a path parameter called `key` must not collide with the credential
        self.assertEqual(self.c.head("/v1/meta", headers={"X-API-Key": "alpha-key"}).status_code, 200)
        self.assertEqual(self.c.head("/v1/meta").status_code, 401)
        self.assertEqual(self.c.get("/v1/design-values", params={"country": "x", "role": "y"}).status_code, 401)  # auth before lookups


if __name__ == "__main__":
    unittest.main()
