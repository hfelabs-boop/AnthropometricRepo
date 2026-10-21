"""The example scripts are code people copy: run them against a real server and against the static files, in-process. Standard library only
(the live-server tests need fastapi and uvicorn and are skipped without them unless REQUIRE_SERVICE_DEPS=1)."""
from __future__ import annotations

import contextlib
import csv
import http.server
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from anthro_service import get_repo, snapshot  # noqa: E402

REPO = get_repo()


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "anthro_service" / "examples" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(module, argv: list):
    """(exit code or None, stdout, stderr) of module.main(argv)."""
    out, err, code = io.StringIO(), io.StringIO(), None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main(argv)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue(), err.getvalue()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class StaticFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        snapshot.build(cls.tmp.name)
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        handler = partial(Quiet, directory=cls.tmp.name)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/api/v1"
        cls.table = load("design_table")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def rows(self, *argv):
        code, out, err = run(self.table, ["--base", self.base, *argv])
        self.assertIsNone(code, err)
        return list(csv.DictReader(io.StringIO(out))), err

    def test_sex_aliases_reach_the_right_file_not_the_mixed_one(self):
        men, err = self.rows("--country", "Czech Republic", "--role", "Army", "--sex", "male", "--measures", "age")
        self.assertIn("/ men (", err)  # the summary line names the population; 'men' alone also occurs in 'measurements'
        self.assertNotIn("mixed / not stated", err)
        both, err = self.rows("--country", "Czech Republic", "--role", "Army", "--sex", "not stated", "--measures", "age")
        self.assertIn("mixed / not stated", err)
        self.assertNotEqual([r["P50"] for r in men], [r["P50"] for r in both])
        code, out, err = run(self.table, ["--base", self.base, "--sex", "x"])
        self.assertIn("--sex must be M, F or both", str(code))

    def test_latest_file_and_the_hint_when_there_is_none(self):
        rows, err = self.rows("--country", "United States", "--role", "Army", "--sex", "M", "--survey", "latest", "--measures", "stature")
        self.assertEqual([(r["parameter"], r["year_min"]) for r in rows], [("Stature", "2010")])
        code, out, err = run(self.table, ["--base", self.base, "--country", "United States", "--role", "Air Force", "--sex", "M", "--survey", "latest"])
        self.assertIn("HTTP 404", str(code))
        self.assertIn("exist only where the combined values span more than 15 years", str(code))
        self.assertIn("keyed by ids", str(code))

    def test_measures_may_be_names_in_any_case_and_unknown_ones_are_reported(self):
        rows, err = self.rows("--measures", "Stature, Sitting Height ,BODY MASS")
        self.assertEqual({r["parameter"] for r in rows}, {"Stature", "SittingHeight", "BodyMass"})
        rows, err = self.rows("--measures", "stature,wingspan")
        self.assertEqual([r["parameter"] for r in rows], ["Stature"])
        self.assertIn("no such measure in this file: wingspan", err)
        code, out, err = run(self.table, ["--base", self.base, "--measures", "wingspan"])
        self.assertEqual(code, 2)

    def test_every_key_of_a_static_file_selects_itself(self):
        """A name must never take over an exact key; a name shared by a harmonized and an other: row prefers the harmonized one."""
        for country, role, sex in (("united-states", "army", "M"), ("united-states", "pilots", "M"), ("united-states", "aircrew", "M"), ("serbia", "cadets", "M")):
            with open(Path(self.tmp.name) / "api" / "v1" / "populations" / country / role / f"{sex}.json", encoding="utf-8") as f:
                rows = json.load(f)["measures"]
            for m in rows:
                self.assertEqual(self.table.wanted_keys(m["key"], rows), [m["key"]], (country, role, m["key"]))
        rows = json.load(open(Path(self.tmp.name) / "api" / "v1" / "populations" / "united-states" / "army" / "M.json", encoding="utf-8"))["measures"]
        self.assertEqual(self.table.wanted_keys("Waist circumference (omphalion)", rows), ["waist_circumference"])  # the printed name
        self.assertEqual(self.table.wanted_keys("waist circumference natural indentation", rows), ["other:waist_circumference_natural_indentation"])  # key without 'other:'
        self.assertEqual(self.table.wanted_keys("WAIST BACK LENGTH (NATURAL INDENTATION)", rows), ["other:waist_back_length_natural_indentation"])  # name in any case
        with self.assertRaises(SystemExit):
            self.table.wanted_keys("-", rows)  # a name that normalises to nothing must not select a random row

    def test_a_static_survey_id_and_a_filtered_level_are_explained(self):
        code, out, err = run(self.table, ["--base", self.base, "--survey", "ansur-ii-2012"])
        self.assertIn("latest survey only", str(code))  # only the combined file and 'latest' exist as static files
        code, out, err = run(self.table, ["--base", self.base, "--country", "Netherlands", "--role", "Army", "--sex", "M", "--measures", "stature", "--min-reliability", "high"])
        self.assertIsNone(code, err)
        self.assertRegex(err, r"\d+ value\(s\) below 'high' reliability left out; use --min-reliability low")

    def test_stdout_lines_end_in_a_single_newline(self):
        code, out, err = run(self.table, ["--base", self.base, "--measures", "stature"])
        self.assertNotIn("\r", out)  # a Windows text-mode stdout would otherwise write \r\r\n

    def test_unreachable_server_and_non_api_server_are_messages(self):
        code, out, err = run(self.table, ["--base", f"http://127.0.0.1:{free_port()}"])
        self.assertIn("cannot reach", str(code))
        client = load("python_client")
        with self.assertRaises(SystemExit) as cm:
            client.get(f"http://127.0.0.1:{free_port()}", "/v1/meta")
        self.assertIn("cannot reach", str(cm.exception))
        with self.assertRaises(SystemExit) as cm:
            client.get(self.base.replace("/api/v1", ""), "/v1/meta")  # the static site has no /v1
        self.assertIn("not the live API", str(cm.exception))


class LiveServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import fastapi, uvicorn  # noqa: F401, E401
        except ImportError:
            if os.environ.get("REQUIRE_SERVICE_DEPS") == "1":
                raise
            raise unittest.SkipTest("fastapi / uvicorn are not installed")
        port = free_port()
        cls.proc = subprocess.Popen([sys.executable, "-W", "ignore", "-m", "anthro_service", "serve", "--port", str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            cls.proc.kill()
            raise RuntimeError("the server did not start")
        cls.base = f"http://127.0.0.1:{port}"

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)

    def test_design_table_does_not_refilter_what_the_server_already_selected(self):
        table = load("design_table")
        code, out, err = run(table, ["--base", self.base, "--measures", "Stature,Sitting Height"])  # names and a space: the server understands them
        self.assertIsNone(code, err)
        self.assertEqual({r["parameter"] for r in csv.DictReader(io.StringIO(out))}, {"Stature", "SittingHeight"})
        code, out, err = run(table, ["--base", self.base, "--measures", "stature, mass"])
        self.assertEqual({r["parameter"] for r in csv.DictReader(io.StringIO(out))}, {"Stature", "BodyMass"})

    def test_slash_roles_and_aliases_work_live(self):
        table = load("design_table")
        code, out, err = run(table, ["--base", self.base, "--country", "Israel", "--role", "Recruits/trainees", "--sex", "men", "--measures", "mass"])
        self.assertIsNone(code, err)
        self.assertEqual([r["parameter"] for r in csv.DictReader(io.StringIO(out))], ["BodyMass"])

    def test_python_client_prints_the_table_and_the_caution(self):
        client = load("python_client")
        code, out, err = run(client, ["--base", self.base, "--country", "United States", "--role", "Air Force", "--sex", "M"])
        self.assertIsNone(code, err)
        self.assertIn("Body mass", out)
        self.assertIn("Care: sitting_height", out)
        code, out, err = run(client, ["--base", self.base, "--country", "Narnia"])
        self.assertIn("not_found", str(code))


if __name__ == "__main__":
    unittest.main()
