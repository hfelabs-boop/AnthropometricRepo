"""MCP server tests: in-memory client, a real stdio process and the HTTP transport; mcp 1.x and 2.x.

Skipped only when the `mcp` package is not installed (and then only if REQUIRE_SERVICE_DEPS is not 1); a broken install or a broken module fails."""
from __future__ import annotations

import asyncio
import http.client
import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

HAVE_MCP = importlib.util.find_spec("mcp") is not None
if HAVE_MCP:
    from anthro_service import mcp_server
    from anthro_service.mcp_server import mcp
elif os.environ.get("REQUIRE_SERVICE_DEPS") == "1":
    raise ImportError("mcp is required (REQUIRE_SERVICE_DEPS=1) but not installed")

from anthro_service import get_repo  # noqa: E402

REPO = get_repo()


@asynccontextmanager
async def client():
    try:  # mcp 2.x
        from mcp import Client
        async with Client(mcp) as c:
            yield c
    except ImportError:  # mcp 1.x
        from mcp.shared.memory import create_connected_server_and_client_session
        async with create_connected_server_and_client_session(mcp._mcp_server) as c:
            yield c


def call(tool: str, args: dict | None = None):
    """(is_error, text) of one tool call."""
    async def go():
        async with client() as c:
            r = await c.call_tool(tool, args or {})
            return bool(getattr(r, "is_error", getattr(r, "isError", False))), "".join(x.text for x in r.content if getattr(x, "text", None))
    return asyncio.run(go())


def ok(tool: str, args: dict | None = None) -> dict:
    err, text = call(tool, args)
    assert not err, text
    return json.loads(text)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipIf(not HAVE_MCP, "mcp is not installed")
class Tools(unittest.TestCase):
    def tools(self):
        async def go():
            async with client() as c:
                return (await c.list_tools()).tools
        return {t.name: t for t in asyncio.run(go())}

    def test_tools_have_descriptions_schemas_annotations_and_titles(self):
        tools = self.tools()
        self.assertEqual(set(tools), {"about", "list_countries", "list_roles", "list_categories", "list_surveys", "search_measures", "get_measure", "get_design_values",
                                      "get_mannequin_dimensions", "compare_populations", "get_source"})
        for name, t in tools.items():
            self.assertGreater(len(t.description or ""), 40, name)
            self.assertNotIn("\n", t.description, name)
            ann = t.annotations
            self.assertTrue(getattr(ann, "readOnlyHint", None) or getattr(ann, "read_only_hint", None), name)
            self.assertTrue(t.title, name)
        schema = lambda t: getattr(t, "inputSchema", None) or t.input_schema  # 1.x / 2.x
        props = schema(tools["get_mannequin_dimensions"])["properties"]
        self.assertEqual(props["sex"]["enum"], ["M", "F", "both"])
        self.assertEqual(props["min_reliability"]["enum"], ["high", "medium", "low"])
        self.assertTrue(all(p.get("description") for p in props.values()), [k for k, p in props.items() if not p.get("description")])
        self.assertEqual(props["limit"]["maximum"], 200)
        self.assertEqual(set(schema(tools["get_design_values"])["required"]), {"country", "role"})

    def test_server_reports_the_service_version(self):
        server = getattr(mcp, "_mcp_server", None) or mcp._lowlevel_server  # mcp 1.x / 2.x
        self.assertEqual(server.version, mcp_server.VERSION)

    def test_design_values_match_the_library_and_accept_comma_strings(self):
        want = REPO.design_values("United States", "Army", "M", ["stature", "mass"], percentiles=[5, 50, 95])
        for names in (["stature", "mass"], "stature,mass"):
            got = ok("get_design_values", {"country": "USA", "role": "Army", "sex": "M", "measures": names, "percentiles": [5, 50, 95]})
            self.assertEqual(got["measures"], json.loads(json.dumps(want["measures"])))
        self.assertEqual(ok("get_design_values", {"country": "USA", "role": "Army", "measures": "stature", "percentiles": "5,97.5"})["percentiles"], ["p5", "p97.5"])

    def test_the_cap_puts_harmonized_first_and_says_what_it_left_out(self):
        m = ok("get_mannequin_dimensions", {"country": "United States", "role": "Army", "sex": "M", "percentile": 95, "limit": 5})
        full = REPO.mannequin("United States", "Army", "M", 95)
        self.assertEqual((len(m["dimensions"]), m["returned"], m["total"], m["truncated"]), (5, 5, full["count"], True))
        self.assertTrue(all(d["harmonized"] for d in m["dimensions"]))
        self.assertEqual(set(m["values"]), {d["key"] for d in m["dimensions"]})
        self.assertEqual(set(m["units"]), set(m["values"]))
        self.assertEqual(m["core"], full["core"])  # core keeps stature and mass even when the list is cut
        self.assertRegex(m["notes"][-1], rf"Showing 5 of {full['count']} measures.*Left out: .*\d+ [A-Z]")
        d = ok("get_design_values", {"country": "United States", "role": "Army", "limit": 60})
        self.assertEqual((len(d["measures"]), d["truncated"]), (60, True))
        every = REPO.design_values("United States", "Army", "M")["measures"]
        self.assertEqual(sum(x["harmonized"] for x in d["measures"]), min(60, sum(x["harmonized"] for x in every)))  # all harmonized measures come before any as-published one
        self.assertIn("Left out", d["notes"][-1])

    def test_named_measures_are_never_cut_and_limits_are_validated(self):
        names = ["stature", "mass", "sitting_height"]
        d = ok("get_design_values", {"country": "United States", "role": "Army", "measures": names, "limit": 1})
        self.assertEqual((len(d["measures"]), d["truncated"]), (3, False))
        for bad in (0, -1, 201):
            err, text = call("get_design_values", {"country": "United States", "role": "Army", "limit": bad})
            self.assertTrue(err, bad)
            self.assertIn("limit", text)
        err, text = call("search_measures", {"query": "head", "limit": 0})
        self.assertTrue(err)

    def test_errors_reach_the_model_with_every_choice(self):
        err, text = call("get_design_values", {"country": "Narnia", "role": "Army"})
        self.assertTrue(err)
        self.assertIn("Unknown country 'Narnia'", text)
        self.assertIn(f"Valid values ({len(REPO.countries())})", text)
        for c in REPO.countries():
            self.assertIn(c["name"], text)  # none cut: the list is the point of the message
        err, text = call("get_design_values", {"country": "Germny", "role": "Army"})
        self.assertIn("Closest matches", text)
        self.assertIn("Germany", text)
        err, text = call("get_design_values", {"country": "United States", "role": "Army", "measures": ["statur"]})
        self.assertIn("Closest matches", text)
        self.assertIn("stature", text)
        err, text = call("get_design_values", {"country": "United Kingdom", "role": "Army", "sex": "M"})
        self.assertIn("No men data", text)
        err, text = call("get_design_values", {"country": "United States", "role": "Army", "percentiles": "abc"})
        self.assertTrue(err)
        self.assertIn("percentiles", text)

    def test_unexpected_exceptions_are_readable_too(self):
        with mock.patch.object(mcp_server, "get_repo", side_effect=KeyError("boom")):
            for tool, args in (("about", {}), ("list_countries", {}), ("get_design_values", {"country": "x", "role": "y"})):
                err, text = call(tool, args)
                self.assertTrue(err, tool)
                self.assertIn("KeyError", text, tool)

    def test_discovery_tools_and_totals(self):
        c = ok("list_countries")
        self.assertEqual(c["count"], len(REPO.countries()))
        self.assertLess(len(json.dumps(c)), 20000)  # compact: the details are in list_roles
        r = ok("list_roles", {"country": "Israel"})
        self.assertEqual(r["name"], "Israel")
        self.assertIn("surveys", r["roles"][0])
        self.assertEqual(len(ok("list_categories")["categories"]), len(REPO.categories()))
        s = ok("search_measures", {"query": "head", "limit": 3})
        self.assertEqual((s["returned"], s["truncated"], s["total"]), (3, True, len(REPO.measures(q="head"))))
        self.assertIn("Showing 3 of", s["note"])
        self.assertEqual(s["measures"][0]["key"], "head_circumference")
        self.assertEqual(ok("search_measures", {"query": "weight", "limit": 1})["measures"][0]["key"], "mass")
        err, text = call("search_measures", {"category": "zzz"})
        self.assertTrue(err)
        self.assertIn("Unknown category", text)
        m = ok("get_measure", {"key": "stature"})
        self.assertEqual((m["key"], m["harmonized"]), ("stature", True))
        self.assertGreater(m["total_populations"], 60)
        self.assertEqual((len(m["populations"]), m["truncated"]), (60, True))
        cmp = ok("compare_populations", {"measure": "sitting_height", "limit": 1, "countries": ["United States", "Germany", "Israel"]})
        self.assertEqual((cmp["count"], cmp["truncated"]), (1, True))
        self.assertIn("Israel", cmp["no_data"]["countries"])
        self.assertIn("survey=latest", " ".join(ok("get_design_values", {"country": "US", "role": "Army", "measures": "stature"})["notes"]))
        self.assertIn("ansur-ii-2012", ok("list_surveys", {"country": "United States", "role": "Army"})["surveys"][0]["id"])
        self.assertFalse(call("get_source", {"source_id": "ansur-ii-2012"})[0])
        self.assertIn("boundary", call("about")[1].lower())

    def test_compare_latest_through_the_tool(self):
        c = ok("compare_populations", {"measure": "stature", "countries": "United States", "roles": "Army", "survey": "latest"})
        self.assertEqual((c["survey"], c["results"][0]["n_surveys"]), ("latest", 1))
        err, text = call("compare_populations", {"measure": "stature", "survey": "ansur-ii-2012"})
        self.assertTrue(err)

    def test_survey_latest_through_the_tools(self):
        d = ok("get_mannequin_dimensions", {"country": "US", "role": "Army", "sex": "F", "percentile": 50, "survey": "latest", "measures": "stature"})
        self.assertEqual(d["population"]["survey"]["id"], "ansur-ii-2012")


@unittest.skipIf(not HAVE_MCP, "mcp is not installed")
class Transports(unittest.TestCase):
    INIT = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})

    def test_security_settings(self):
        sec = mcp_server._security
        local = sec("127.0.0.1", None, None)  # set explicitly: mcp 1.22 has no default protection at all
        self.assertTrue(local.enable_dns_rebinding_protection)
        self.assertEqual(local.allowed_hosts, ["127.0.0.1:*", "localhost:*", "[::1]:*"])
        off = sec("0.0.0.0", None, None)
        self.assertFalse(off.enable_dns_rebinding_protection)
        on = sec("0.0.0.0", ["mcp.example.org", "other.example:9000"], ["https://app.example.org"])
        self.assertTrue(on.enable_dns_rebinding_protection)
        self.assertIn("mcp.example.org:*", on.allowed_hosts)
        self.assertIn("other.example:9000", on.allowed_hosts)
        self.assertIn("127.0.0.1:*", on.allowed_hosts)
        self.assertIn("https://app.example.org", on.allowed_origins)

    def post(self, port: int, host_header: str) -> int:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("POST", "/mcp", self.INIT, {"Host": host_header, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        status = c.getresponse().status
        c.close()
        return status

    def serve(self, *extra):
        port = free_port()
        p = subprocess.Popen([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp", "--transport", "streamable-http", "--port", str(port), *extra],
                             cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (p.terminate(), p.wait(10), p.stderr.close()))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                return port
            except OSError:
                time.sleep(0.1)
        self.fail("the HTTP server did not start")

    def test_remote_host_is_served_when_bound_to_all_interfaces(self):
        port = self.serve("--host", "0.0.0.0")
        self.assertEqual(self.post(port, f"127.0.0.1:{port}"), 200)
        self.assertEqual(self.post(port, f"my.server.lan:{port}"), 200)  # mcp 1.x used to answer 421 here

    def test_allowed_hosts_are_enforced(self):
        port = self.serve("--host", "0.0.0.0", "--allowed-host", "good.example")
        self.assertEqual(self.post(port, f"good.example:{port}"), 200)
        self.assertEqual(self.post(port, "good.example"), 200)
        self.assertEqual(self.post(port, f"evil.example:{port}"), 421)

    def test_loopback_server_refuses_foreign_hosts(self):
        port = self.serve()
        self.assertEqual(self.post(port, f"127.0.0.1:{port}"), 200)
        self.assertEqual(self.post(port, f"evil.example:{port}"), 421)

    def test_stdout_of_the_stdio_server_is_protocol_only(self):
        """Talk to a real stdio server and read until every request is answered: every stdout line must be JSON-RPC (a stray print breaks real clients)."""
        import threading
        msgs = [json.loads(self.INIT), {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_design_values", "arguments": {"country": "Narnia", "role": "Army"}}}]
        p = subprocess.Popen([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        timer = threading.Timer(60, p.kill)
        timer.start()
        try:
            p.stdin.write("\n".join(json.dumps(m) for m in msgs) + "\n")
            p.stdin.flush()
            lines = []
            while {m.get("id") for m in lines} < {1, 2, 3}:
                line = p.stdout.readline()
                self.assertTrue(line, "the server closed stdout before answering")
                lines.append(json.loads(line))  # a non-JSON line raises here
        finally:
            timer.cancel()
            p.stdin.close()
            p.wait(30)
        by_id = {m["id"]: m for m in lines}
        self.assertEqual(len(by_id[2]["result"]["tools"]), 11)
        self.assertTrue(by_id[3]["result"]["isError"])
        self.assertIn("Unknown country", by_id[3]["result"]["content"][0]["text"])

    def test_a_missing_data_directory_stops_the_server_at_start(self):
        env = {**os.environ, "ANTHRO_DATA_DIR": "/nonexistent/data"}
        p = subprocess.run([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp"], cwd=ROOT, env=env, input="", capture_output=True, text=True, timeout=60)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("cannot load the data", p.stderr)
        self.assertIn("ANTHRO_DATA_DIR", p.stderr)


if __name__ == "__main__":
    unittest.main()
