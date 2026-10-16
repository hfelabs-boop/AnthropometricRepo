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


def pytest_importorskip(name: str):
    """The module, or skip the test (jsonschema comes with mcp, so this only skips on an odd install)."""
    try:
        return __import__(name)
    except ImportError:
        raise unittest.SkipTest(f"{name} is not installed") from None


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
            self.assertEqual(got["measures"], [mcp_server._slim(m) for m in json.loads(json.dumps(want["measures"]))])
        self.assertEqual(ok("get_design_values", {"country": "USA", "role": "Army", "measures": "stature", "percentiles": "5,97.5"})["percentiles"], ["p5", "p97.5"])

    def test_the_cap_puts_harmonized_first_and_says_what_it_left_out(self):
        m = ok("get_mannequin_dimensions", {"country": "United States", "role": "Army", "sex": "M", "percentile": 95, "limit": 5})
        full = REPO.mannequin("United States", "Army", "M", 95)
        self.assertEqual((len(m["dimensions"]), m["returned"], m["total"], m["truncated"]), (5, 5, full["count"], True))
        self.assertTrue(all(d["harmonized"] for d in m["dimensions"]))
        self.assertEqual(set(m["values"]), {d["key"] for d in m["dimensions"]})
        self.assertEqual(set(m["units"]), set(m["values"]))
        self.assertLessEqual(set(m["caution"]), set(m["values"]))  # caution is cut with the values
        self.assertEqual(m["core"], full["core"])  # core keeps stature and mass even when the list is cut
        self.assertRegex(m["notes"][-1], rf"Showing 5 of {full['count']} measures.*Left out: .*\d+ [A-Z]")
        d = ok("get_design_values", {"country": "United States", "role": "Army", "limit": 60})
        self.assertEqual((len(d["measures"]), d["truncated"]), (60, True))
        every = REPO.design_values("United States", "Army", "M")["measures"]
        self.assertEqual(sum(x["harmonized"] for x in d["measures"]), min(60, sum(x["harmonized"] for x in every)))  # all harmonized measures come before any as-published one
        self.assertIn("Left out", d["notes"][-1])

    def test_empty_fields_are_left_out_and_equal_bases_collapse(self):
        d = ok("get_design_values", {"country": "United States", "role": "Army", "measures": ["stature"], "survey": "latest"})["measures"][0]
        self.assertNotIn("reliability_note", d)
        self.assertNotIn("survey_spread_pct", d)
        self.assertEqual(d["basis"], "reported")
        self.assertNotIn("percentile_basis", d)
        mixed = ok("get_design_values", {"country": "United States", "role": "Air Force", "measures": ["sitting_height"], "percentiles": [5, 50, 95, 97.5]})["measures"][0]
        self.assertIn("percentile_basis", mixed)  # differing bases stay explicit
        sizes = len(call("get_design_values", {"country": "United States", "role": "Army"})[1])
        self.assertLess(sizes, 46000)

    def test_categories_are_capped_like_everything_unnamed(self):
        d = ok("get_design_values", {"country": "United States", "role": "Army", "categories": ["head-face"], "limit": 5})
        self.assertEqual((len(d["measures"]), d["truncated"]), (5, True))
        self.assertNotIn("choose categories", d["notes"][-1])  # the caller already did
        err, text = call("get_design_values", {"country": "United States", "role": "Army", "measures": [f"m{i}" for i in range(201)]})
        self.assertTrue(err)
        self.assertIn("at most 200", text)

    def test_misspelled_arguments_are_errors_not_silent_defaults(self):
        for tool, args in (("get_design_values", {"country": "US", "role": "Army", "percentile": 97.5}), ("get_design_values", {"country": "US", "role": "Army", "measure": "stature"}),
                           ("get_mannequin_dimensions", {"country": "US", "role": "Army", "percentiles": [95]}), ("compare_populations", {"measure": "stature", "country": "Germany"}),
                           ("search_measures", {"q": "head"})):
            err, text = call(tool, args)
            self.assertTrue(err, (tool, args))
            self.assertIn("Extra inputs are not permitted", text)
        schema = lambda t: getattr(t, "inputSchema", None) or t.input_schema
        self.assertTrue(all(schema(t).get("additionalProperties") is False for t in self.tools().values()))

    def test_every_default_in_every_schema_is_valid(self):
        jsonschema = pytest_importorskip("jsonschema")
        schema = lambda t: getattr(t, "inputSchema", None) or t.input_schema
        for name, t in self.tools().items():
            sch = schema(t)
            for prop, spec in sch["properties"].items():
                if "default" in spec:
                    jsonschema.validate(spec["default"], spec)  # an explicit null / the default must satisfy the property's own schema
            jsonschema.Draft202012Validator.check_schema(sch)
        jsonschema.validate({"measure": "stature", "survey": None, "sex": "F"}, schema(self.tools()["compare_populations"]))
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate({"measure": "stature", "survey": "ansur"}, schema(self.tools()["compare_populations"]))

    def test_country_names_with_commas_work_as_strings(self):
        for names in ("Multiple: Turkey, Greece, Italy", ["Multiple: Turkey, Greece, Italy"]):
            c = ok("compare_populations", {"measure": "stature", "countries": names, "survey": "latest"})
            self.assertEqual({r["country"] for r in c["results"]}, {"Multiple: Turkey, Greece, Italy"})
        c = ok("compare_populations", {"measure": "stature", "countries": "Germany, Japan", "limit": 50})
        self.assertEqual({r["country"] for r in c["results"]}, {"Germany", "Japan"})

    def test_get_measure_can_reach_every_population(self):
        m = ok("get_measure", {"key": "stature", "country": "Germany"})
        self.assertEqual({p["country"] for p in m["populations"]}, {"Germany"})
        self.assertFalse(m["truncated"])
        big = ok("get_measure", {"key": "stature", "limit": 200})
        self.assertEqual((len(big["populations"]), big["truncated"]), (big["total_populations"], False))
        small = ok("get_measure", {"key": "stature", "limit": 10})
        self.assertIn("Showing 10 of", small["note"])

    def test_an_unmatchable_measure_has_no_dangling_label(self):
        err, text = call("get_design_values", {"country": "United States", "role": "Army", "measures": ["zzzzqq"]})
        self.assertTrue(err)
        self.assertNotIn("(0)", text)
        self.assertNotIn("Closest matches", text)
        err, text = call("get_design_values", {"country": "United States", "role": "Army", "measures": ["weight"]})
        self.assertIn("Closest matches", text)
        self.assertIn("mass", text)

    def test_compare_accepts_latest_in_any_case_and_explains_other_values(self):
        for value in ("latest", "Latest", " LATEST "):
            self.assertEqual(ok("compare_populations", {"measure": "stature", "countries": "Germany", "survey": value})["survey"], "latest")
        err, text = call("compare_populations", {"measure": "stature", "survey": "ansur-ii-2012"})
        self.assertTrue(err)
        self.assertIn("takes survey=latest or nothing", text)  # the library's message, not pydantic's
        self.assertNotIn("pydantic", text)
        # the published schema still says 'latest' or null
        schema = lambda t: getattr(t, "inputSchema", None) or t.input_schema
        prop = schema(self.tools()["compare_populations"])["properties"]["survey"]
        self.assertEqual(prop["anyOf"], [{"const": "latest", "type": "string"}, {"type": "null"}])

    def test_measures_and_categories_say_when_they_intersect_to_nothing(self):
        d = ok("get_design_values", {"country": "US", "role": "Army", "measures": ["stature"], "categories": ["head-face"]})
        self.assertEqual(d["count"], 0)
        self.assertTrue(any("combined with AND" in n for n in d["notes"]))
        self.assertNotIn("core", ok("get_mannequin_dimensions", {"country": "US", "role": "Army", "measures": ["stature"], "categories": ["head-face"]}))

    def test_the_cap_note_only_offers_what_still_helps(self):
        note = lambda **kw: ok("get_design_values", {"country": "United States", "role": "Army", **kw})["notes"][-1]
        plain = note(limit=5)
        self.assertIn("name the ones you need in 'measures'", plain)
        self.assertIn("narrow with 'categories'", plain)
        self.assertIn("raise 'limit' (at most 200)", plain)
        with_categories = note(limit=5, categories=["head-face"])
        self.assertNotIn("narrow with 'categories'", with_categories)  # the caller already did
        at_max = note(limit=200)
        self.assertNotIn("raise 'limit'", at_max)  # nothing left to raise
        self.assertIn("name the ones you need in 'measures'", at_max)

    def test_empty_optional_fields_are_left_out_at_every_level(self):
        m = ok("get_mannequin_dimensions", {"country": "Israel", "role": "Army", "percentile": 50, "survey": "latest"})
        for empty in ("core", "caution", "unavailable"):
            if empty in m:
                self.assertTrue(m[empty], empty)  # present only when it holds something
        self.assertNotIn("surveys_combined", m["population"])  # [] for a single survey
        d = ok("get_design_values", {"country": "United States", "role": "Army", "measures": ["stature"], "survey": "latest"})
        self.assertEqual(d["population"]["survey"]["id"], "ansur-ii-2012")
        self.assertNotIn("surveys_combined", d["population"])
        combined = ok("get_design_values", {"country": "United States", "role": "Army", "measures": ["stature"]})
        self.assertNotIn("survey", combined["population"])  # null: not a single survey
        self.assertIn("surveys_combined", combined["population"])
        slim = mcp_server._slim({"a": 1, "b": None, "c": [], "d": {}, "e": 0, "percentile_basis": {"p5": "reported", "p50": "reported"}, "x": False})
        self.assertEqual(slim, {"a": 1, "d": {}, "e": 0, "x": False, "basis": "reported"})  # zero and False are values; None and [] are not

    def test_the_error_text_never_has_an_empty_choice_list(self):
        from anthro_service.core import ApiError
        for available, close in (([], True), ([], False), (None, False)):
            text = mcp_server._message(ApiError("Nothing.", "A hint.", available, close))
            self.assertNotIn("(0)", text)
            self.assertNotIn("Closest matches", text)
            self.assertNotIn("Valid values", text)
        self.assertIn("Closest matches (2): a; b", mcp_server._message(ApiError("x", None, ["a", "b"], True)))

    def test_blank_source_is_a_client_error(self):
        err, text = call("get_source", {"source_id": ""})
        self.assertTrue(err)
        self.assertIn("No source id given", text)

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
        self.assertLess(len(call("list_countries")[1]), 20000)  # the text the client receives (indented); the details are in list_roles
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
        return self.serve_transport("streamable-http", *extra)

    def serve_transport(self, transport: str, *extra):
        port = free_port()
        p = subprocess.Popen([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp", "--transport", transport, "--port", str(port), *extra],
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

    def post_origin(self, port: int, origin: str, host: str | None = None) -> int:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("POST", "/mcp", self.INIT, {"Host": host or f"127.0.0.1:{port}", "Origin": origin, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        status = c.getresponse().status
        c.close()
        return status

    def test_origins_are_enforced(self):
        port = self.serve()
        self.assertEqual(self.post_origin(port, "http://evil.example"), 403)
        self.assertEqual(self.post_origin(port, f"http://localhost:{port}"), 200)
        port = self.serve("--host", "0.0.0.0", "--allowed-host", "good.example", "--allowed-origin", "https://app.example.org/")
        self.assertEqual(self.post_origin(port, "https://app.example.org", f"good.example:{port}"), 200)
        self.assertEqual(self.post_origin(port, "https://evil.example", f"good.example:{port}"), 403)

    def test_sse_checks_hosts_too(self):
        port = self.serve_transport("sse", "--host", "0.0.0.0", "--allowed-host", "good.example")
        for host, want in ((f"good.example:{port}", 200), (f"evil.example:{port}", 421)):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            c.request("GET", "/sse", headers={"Host": host, "Accept": "text/event-stream"})
            r = c.getresponse()
            self.assertEqual(r.status, want, host)
            c.close()

    def test_allow_list_mistakes_stop_the_server_with_a_message(self):
        sec = mcp_server._security
        for hosts, origins in ((["*.example.org"], None), (["https://mcp.example.org"], None), (["a/b"], None), ([" "], None), (["a.example,b.example"], None), (["a.example;b.example"], None),
                               (["a.example:"], None), (["a.example:abc"], None), (["good.example"], ["mcp.example.org"]), (["good.example"], ["https://*.example.org"]),
                               (["good.example"], ["https://app.example,https://b.example"]), (["good.example"], ["https://app.example/app"]), (["good.example"], ["https://app.example:"])):
            with self.assertRaises(SystemExit) as cm:
                sec("0.0.0.0", hosts, origins)
            self.assertIn("anthro_service", str(cm.exception), (hosts, origins))
        tidy = sec("0.0.0.0", ["a.example"], ["https://app.example:443", "http://x.example:80/", "https://y.example:8443"])
        self.assertEqual(tidy.allowed_origins[3:], ["https://app.example", "http://x.example", "https://y.example:8443"])  # default ports are what browsers leave out
        self.assertEqual(tidy.allowed_origins[:3], ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"])  # localhost stays allowed
        with self.assertRaises(SystemExit) as cm:
            sec("0.0.0.0", None, ["https://app.example.org"])  # origins without hosts would lock every remote client out
        self.assertIn("--allowed-host", str(cm.exception))
        ok_ = sec("0.0.0.0", ["MCP.Example.org."], ["HTTPS://App.Example.org/"])  # case, a trailing dot and a trailing slash are tolerated
        self.assertIn("mcp.example.org:*", ok_.allowed_hosts)
        self.assertIn("https://app.example.org", ok_.allowed_origins)
        self.assertIsNotNone(sec("127.0.0.1", None, ["https://app.example.org"]))

    def test_ports_and_hosts_that_look_false_are_still_values(self):
        from unittest import mock
        from anthro_service import __main__ as cli
        with mock.patch.object(mcp_server, "main") as run:
            cli.main(["mcp", "--transport", "streamable-http", "--port", "0"])
        self.assertEqual(run.call_args.args[:3], ("streamable-http", "127.0.0.1", 0))
        with mock.patch.object(mcp_server, "main") as run:
            cli.main(["mcp", "--transport", "sse", "--host", "localhost", "--port", "9001", "--allowed-host", "x.example"])
        self.assertEqual(run.call_args.args[:3], ("sse", "localhost", 9001))
        with self.assertRaises(SystemExit):
            cli.main(["mcp", "--transport", "streamable-http", "--host", ""])
        p = subprocess.run([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp", "--port", "0"], cwd=ROOT, input="", capture_output=True, text=True, timeout=60)
        self.assertIn("only apply to the HTTP transports", p.stderr)

    def test_http_flags_are_ignored_on_stdio_with_a_warning(self):
        p = subprocess.run([sys.executable, "-W", "ignore", "-m", "anthro_service", "mcp", "--allowed-host", "x.example"], cwd=ROOT, input="", capture_output=True, text=True, timeout=60)
        self.assertIn("only apply to the HTTP transports", p.stderr)

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
            while not {1, 2, 3} <= {m.get("id") for m in lines}:  # notifications (no id) may arrive in between
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
