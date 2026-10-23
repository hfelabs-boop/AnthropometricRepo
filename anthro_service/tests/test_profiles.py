"""Pushed profiles (anthro_service/profiles.py): the store, the REST endpoints /v1/profiles, the MCP tools and the push / pull / profiles commands.

The fixture data/exchange_us_army_f_p5_seated.json is a real human-exchange document of the website (US Army women P5, seated upright), made by export.js buildExchange.
The REST and MCP parts are skipped when fastapi / mcp are missing (unless REQUIRE_SERVICE_DEPS=1)."""
from __future__ import annotations

import asyncio
import csv
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from anthro_service.core import BadRequest, NotFound  # noqa: E402
from anthro_service.profiles import MAX_BYTES, ProfileStore, TooLarge, get_store, validate, view_csv, view_xml  # noqa: E402

DOC_PATH = Path(__file__).parent / "data" / "exchange_us_army_f_p5_seated.json"
DOC_TEXT = DOC_PATH.read_text(encoding="utf-8")
DOC = json.loads(DOC_TEXT)

try:
    from fastapi.testclient import TestClient
    from anthro_service.rest import create_app
except ImportError:  # pragma: no cover
    if os.environ.get("REQUIRE_SERVICE_DEPS") == "1":
        raise
    TestClient = None
HAVE_MCP = importlib.util.find_spec("mcp") is not None


class Store(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.st = ProfileStore(self.dir, max_profiles=3)

    def test_push_keeps_the_document_and_a_summary(self):
        m = self.st.push(DOC_TEXT, received_from="127.0.0.1")
        self.assertRegex(m["id"], r"^\d{8}-\d{6}-united-states-army-women-p5-[0-9a-f]{4}$")
        self.assertEqual(m["label"], DOC["profile"]["label"])
        self.assertEqual((m["sex"], m["stature_mm"], m["mass_kg"], m["measures"]), ("F", DOC["body"]["stature_mm"], DOC["body"]["mass_kg"], len(DOC["profile"]["measures"])))
        self.assertEqual(m["posture"], {"id": "sit-upright-90", "name": "Seated upright, hands on thighs"})
        self.assertEqual(self.st.document(m["id"]), DOC)  # stored exactly as sent
        self.assertEqual(self.st.meta("latest")["id"], m["id"])
        self.assertEqual(sorted(p.name for p in Path(self.dir).iterdir()), sorted([f"{m['id']}.json", f"{m['id']}.meta.json"]))

    def test_views_values_dims_angles_points(self):
        self.st.push(DOC)
        v = self.st.view("latest", "values")
        measures = DOC["profile"]["measures"]
        self.assertEqual(v["values"], {k: m["value"] for k, m in measures.items()})
        self.assertEqual(v["units"]["stature"], "mm")
        self.assertEqual(v["core"]["stature_mm"], measures["stature"]["value"])
        self.assertEqual(len(self.st.view("latest", "dims")["rows"]), len(DOC["body"]["dims"]))
        angles = self.st.view("latest", "angles")["rows"]
        self.assertEqual(len(angles), 4 + sum(len(j["dof"]) for j in DOC["body"]["joints"]))  # root, then every degree of freedom
        knee = next(r for r in angles if r["joint_id"] == "knee_L" and r["dof_key"] == "flex")
        self.assertEqual(knee["value_deg"], DOC["posture"]["angles"]["knee_L"]["flex"])
        pts = self.st.view("latest", "points")["rows"]
        self.assertEqual(len(pts), len(DOC["body"]["joints"]) + len(DOC["body"]["landmarks"]))
        self.assertEqual(pts[0]["y_mm"], DOC["body"]["joints"][0]["position_mm"][1])
        s = self.st.view("latest", "summary")
        self.assertIn("percentile 5", " ".join(s["notes"]))
        self.assertEqual(self.st.view("latest", "document"), DOC)
        with self.assertRaises(BadRequest):
            self.st.view("latest", "mesh")

    def test_csv_and_xml(self):
        self.st.push(DOC)
        rows = list(csv.DictReader(io.StringIO(view_csv("values", self.st.view("latest", "values")))))
        self.assertEqual(float(next(r for r in rows if r["key"] == "stature")["value"]), DOC["profile"]["measures"]["stature"]["value"])
        x = ET.fromstring(view_xml("values", self.st.view("latest", "values")).split("?>", 1)[1])
        self.assertEqual(float(x.find("measure[@key='stature']").text), DOC["profile"]["measures"]["stature"]["value"])
        a = ET.fromstring(view_xml("angles", self.st.view("latest", "angles")).split("?>", 1)[1])
        self.assertEqual(float(a.find("row[@joint_id='knee_L'][@dof_key='flex']").get("value_deg")), DOC["posture"]["angles"]["knee_L"]["flex"])
        # formula injection: a label starting with = is defused in CSV
        doc = json.loads(DOC_TEXT)
        doc["body"]["dims"][0]["label"] = "=HYPERLINK(\"x\")"
        self.st.push(doc)
        self.assertIn("'=HYPERLINK", view_csv("dims", self.st.view("latest", "dims")))

    def test_oldest_profiles_go_first_and_delete(self):
        ids = []
        for i in range(5):
            ids.append(self.st.push(DOC)["id"])  # five pushes within a second keep their order
        self.assertEqual([m["id"] for m in self.st.list()], ids[::-1][:3])
        self.assertEqual(self.st.delete("latest"), {"deleted": ids[-1]})
        self.assertEqual(self.st.meta("latest")["id"], ids[-2])
        with self.assertRaises(NotFound) as e:
            self.st.meta(ids[0])
        self.assertIn(ids[-2], e.exception.available)
        self.assertEqual(self.st.clear(), 2)
        with self.assertRaises(NotFound):
            self.st.meta("latest")

    def test_refuses_what_it_cannot_use(self):
        bad = [("not json", "not valid JSON"), ('{"format":"other","version":1}', "format must be"), ("[1,2]", "JSON object"), ('{"a": NaN}', "not valid JSON")]
        for text, msg in bad:
            with self.assertRaises(BadRequest) as e:
                self.st.push(text)
            self.assertIn(msg, e.exception.message)
        for path, value, msg in ((("body", "stature_mm"), 30, "stature_mm"), (("units",), "m", "units"), (("profile", "label"), "", "label"),
                                 (("body", "joints"), [{"id": "x"}], "joints[0]"), (("profile", "measures"), {"stature": {"value": "tall"}}, "stature")):
            doc = json.loads(DOC_TEXT)
            target = doc
            for k in path[:-1]:
                target = target[k]
            target[path[-1]] = value
            errs = validate(doc)
            self.assertTrue(any(msg in e for e in errs), (path, errs))
        with self.assertRaises(TooLarge):
            self.st.push(b" " * (MAX_BYTES + 1))
        with self.assertRaises(NotFound):
            self.st.meta("../../etc/passwd")
        self.assertEqual(list(Path(self.dir).iterdir()), [])

    def test_a_profile_file_of_the_profile_tab_has_values_only(self):
        prof = {"format": "digital-human-profile", "version": 1, "label": "Manual · man · 1800 mm", "sex": "M", "source": {"kind": "manual"},
                "measures": {"stature": {"value": 1800, "unit": "mm"}, "mass": {"value": 80, "unit": "kg"}}}
        m = self.st.push(prof)
        self.assertEqual((m["stature_mm"], m["mass_kg"], m["posture"]), (1800, 80, None))
        self.assertEqual(self.st.view("latest", "values")["values"], {"stature": 1800, "mass": 80})
        a = self.st.view("latest", "angles")
        self.assertEqual(a["rows"], [])
        self.assertIn("measures only", a["notes"][0])


@unittest.skipIf(TestClient is None, "fastapi / httpx not installed")
class Rest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        patch = mock.patch.dict(os.environ, {"ANTHRO_PROFILE_DIR": self.dir}, clear=False)
        patch.start()
        self.addCleanup(patch.stop)
        for k in ("ANTHRO_API_KEYS", "ANTHRO_PROFILES"):
            os.environ.pop(k, None)
        app = create_app()
        self.local = TestClient(app, client=("127.0.0.1", 50000))
        self.remote = TestClient(app, client=("203.0.113.9", 50000))

    def push(self, c=None, **kw):
        return (c or self.local).post("/v1/profiles", content=DOC_TEXT.encode(), headers={"Content-Type": "application/json", **kw.pop("headers", {})}, **kw)

    def test_push_then_read_every_view(self):
        r = self.push()
        self.assertEqual(r.status_code, 201)
        pid = r.json()["id"]
        self.assertEqual(r.headers["location"], f"/v1/profiles/{pid}")
        self.assertEqual(r.json()["links"]["values_csv"], f"/v1/profiles/{pid}/values?format=csv")
        s = self.local.get("/v1/profiles/latest")
        self.assertEqual(s.headers["cache-control"], "no-store")  # profiles change: never cached
        self.assertEqual(s.json()["profile"]["id"], pid)
        self.assertEqual(s.json()["values"]["stature"], DOC["profile"]["measures"]["stature"]["value"])
        self.assertEqual(next(m for m in s.json()["measures"] if m["key"] == "stature")["name"], "Stature")  # names from the measure catalog
        for view, fmt, ctype in (("values", "csv", "text/csv"), ("values", "xml", "application/xml"), ("angles", "csv", "text/csv"), ("points", "json", "application/json"),
                                 ("dims", "xml", "application/xml"), ("document", "json", "application/json")):
            r = self.local.get(f"/v1/profiles/{pid}/{view}", params={"format": fmt})
            self.assertEqual(r.status_code, 200, (view, fmt, r.text[:200]))
            self.assertTrue(r.headers["content-type"].startswith(ctype), (view, r.headers["content-type"]))
        self.assertEqual(self.local.get(f"/v1/profiles/{pid}/document").json(), DOC)
        lst = self.local.get("/v1/profiles").json()
        self.assertEqual((lst["count"], lst["profiles"][0]["id"]), (1, pid))
        self.assertIn(pid, self.local.get("/v1/profiles", params={"format": "csv"}).text)
        self.assertEqual(self.local.delete(f"/v1/profiles/{pid}").json(), {"deleted": pid})
        self.assertEqual(self.local.get("/v1/profiles/latest").status_code, 404)

    def test_errors(self):
        self.assertEqual(self.local.post("/v1/profiles", content=b'{"format":"x"}').json()["error"]["code"], "bad_request")
        big = self.local.post("/v1/profiles", content=b" " * (MAX_BYTES + 10))
        self.assertEqual((big.status_code, big.json()["error"]["code"]), (413, "payload_too_large"))
        self.assertEqual(self.local.get("/v1/profiles/nothing-here").status_code, 404)
        self.assertEqual(self.local.get("/v1/profiles/latest/mesh").status_code, 422)
        self.assertEqual(self.local.get("/v1/profiles", params={"fromat": "csv"}).status_code, 422)  # unknown parameters are errors, as elsewhere
        self.assertEqual(self.local.put("/v1/profiles").status_code, 405)
        self.assertEqual(self.local.post("/v1/meta").status_code, 405)  # the rest of the API stays read-only

    def test_this_computer_only_without_keys_anyone_with_a_key(self):
        r = self.push(self.remote)
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (403, "forbidden"))
        self.assertIn("ANTHRO_API_KEYS", r.json()["error"]["hint"])
        self.assertEqual(self.remote.get("/v1/profiles").status_code, 403)
        self.assertEqual(self.remote.get("/v1/meta").status_code, 200)  # the population data stay public
        with mock.patch.dict(os.environ, {"ANTHRO_API_KEYS": "k1"}):
            self.assertEqual(self.push(self.remote).status_code, 401)
            self.assertEqual(self.push(self.remote, headers={"X-API-Key": "k1"}).status_code, 201)
            self.assertEqual(self.remote.get("/v1/profiles", headers={"Authorization": "Bearer k1"}).json()["count"], 1)
            self.assertEqual(self.push(headers={}).status_code, 401)  # with keys, this computer needs one too
        with mock.patch.dict(os.environ, {"ANTHRO_PROFILES": "open"}):
            self.assertEqual(self.remote.get("/v1/profiles").status_code, 200)
        with mock.patch.dict(os.environ, {"ANTHRO_PROFILES": "off"}):
            self.assertEqual(self.local.get("/v1/profiles").status_code, 404)
            self.assertIn("ANTHRO_PROFILES=off", self.local.get("/v1/profiles").json()["error"]["message"])

    def test_a_public_website_may_push_to_this_computer(self):
        """The CORS and Private Network Access preflight Chrome sends before the website's POST to http://127.0.0.1."""
        r = self.local.options("/v1/profiles", headers={"Origin": "https://antrorepo.vercel.app", "Access-Control-Request-Method": "POST",
                                                        "Access-Control-Request-Headers": "content-type,x-api-key", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-private-network"], "true")
        self.assertIn("POST", r.headers["access-control-allow-methods"])
        p = self.push(headers={"Origin": "https://antrorepo.vercel.app"})
        self.assertEqual(p.headers["access-control-allow-origin"], "*")
        self.assertIn("location", p.headers["access-control-expose-headers"].lower())

    def test_the_profiles_endpoints_are_in_the_openapi_document(self):
        paths = self.local.get("/openapi.json").json()["paths"]
        self.assertIn("post", paths["/v1/profiles"])
        self.assertIn("delete", paths["/v1/profiles/{profile_id}"])
        self.assertIn("/v1/profiles/{profile_id}/{view}", paths)


@unittest.skipIf(not HAVE_MCP, "mcp not installed")
class Mcp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        patch = mock.patch.dict(os.environ, {"ANTHRO_PROFILE_DIR": self.dir})
        patch.start()
        self.addCleanup(patch.stop)

    def test_tools_see_what_was_pushed(self):
        from anthro_service import mcp_server as m
        self.assertEqual(m.list_pushed_profiles(5)["count"], 0)
        self.assertIn("Send to CAD", m.list_pushed_profiles(5)["note"])
        pid = get_store().push(DOC)["id"]
        self.assertEqual(m.list_pushed_profiles(5)["profiles"][0]["id"], pid)
        v = m.get_pushed_profile("latest", "values", ["stature", "sitting_height", "wingspan"])
        self.assertEqual(v["values"], {k: DOC["profile"]["measures"][k]["value"] for k in ("stature", "sitting_height")})
        self.assertEqual(v["missing"], ["wingspan"])
        a = m.get_pushed_profile(pid, "angles", None, 10)
        self.assertEqual((a["returned"], a["total"] > 10), (10, True))
        from anthro_service.mcp_server import ToolError
        with self.assertRaises(ToolError):
            m.get_pushed_profile("nope")
        with self.assertRaises(ToolError):
            m.get_pushed_profile("latest", "document")

    def test_tools_are_listed_with_their_schemas(self):
        from anthro_service.mcp_server import mcp

        async def go():
            try:
                from mcp import Client
                async with Client(mcp) as c:
                    return [t.name for t in (await c.list_tools()).tools]
            except ImportError:
                return [t.name for t in await mcp.list_tools()]
        names = asyncio.run(go())
        self.assertIn("list_pushed_profiles", names)
        self.assertIn("get_pushed_profile", names)


class Cli(unittest.TestCase):
    def run_cli(self, *args, env=None):
        return subprocess.run([sys.executable, "-m", "anthro_service", *args], cwd=ROOT, capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(ROOT), **(env or {})}, timeout=120)

    def test_push_local_without_a_server(self):
        d = tempfile.mkdtemp()
        r = self.run_cli("push", str(DOC_PATH), "--local", "--dir", d)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Pushed 'United States", r.stdout)
        self.assertEqual(len(list(Path(d).glob("*.meta.json"))), 1)
        r = self.run_cli("push", str(DOC_PATH), "--server", "http://127.0.0.1:9")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("python -m anthro_service serve", r.stderr)

    @unittest.skipIf(TestClient is None, "fastapi / uvicorn not installed")
    def test_push_pull_and_list_against_a_live_server(self):
        d = tempfile.mkdtemp()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = {**os.environ, "PYTHONPATH": str(ROOT), "ANTHRO_PROFILE_DIR": d}
        env.pop("ANTHRO_API_KEYS", None)
        proc = subprocess.Popen([sys.executable, "-m", "anthro_service", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(proc.wait, 10)
        self.addCleanup(proc.terminate)
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{base}/v1/health", timeout=1).close()
                break
            except OSError:
                time.sleep(0.2)
        r = self.run_cli("push", str(DOC_PATH), "--server", base)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("/v1/profiles/latest/values?format=csv", r.stdout)
        r = self.run_cli("profiles", "--server", base)
        self.assertIn("Seated upright", r.stdout)
        r = self.run_cli("pull", "--server", base, "--view", "angles")
        self.assertTrue(r.stdout.startswith("joint_id,joint_label"), r.stdout[:100])
        out = Path(d) / "values.xml"
        r = self.run_cli("pull", "latest", "--server", base, "--format", "xml", "--out", str(out))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("<measure key=\"stature\"", out.read_text(encoding="utf-8"))
        r = self.run_cli("pull", "nope", "--server", base)
        self.assertIn("404", r.stderr)


if __name__ == "__main__":
    unittest.main()
