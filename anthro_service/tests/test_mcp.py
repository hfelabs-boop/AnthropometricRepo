"""MCP server tests (in-memory client; works with mcp 1.x and 2.x). Skipped when mcp is not installed."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    from anthro_service.mcp_server import mcp
except ImportError:  # pragma: no cover
    mcp = None

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


@unittest.skipIf(mcp is None, "mcp is not installed")
class McpServer(unittest.TestCase):
    def test_tools_are_listed_with_descriptions_and_schemas(self):
        async def go():
            async with client() as c:
                return (await c.list_tools()).tools
        tools = {t.name: t for t in asyncio.run(go())}
        self.assertEqual(set(tools), {"about", "list_countries", "list_surveys", "search_measures", "get_design_values", "get_mannequin_dimensions",
                                      "compare_populations", "get_source"})
        for t in tools.values():
            self.assertGreater(len(t.description or ""), 40, t.name)
        schema = getattr(tools["get_design_values"], "inputSchema", None) or tools["get_design_values"].input_schema  # 1.x / 2.x
        props = schema["properties"]
        self.assertEqual(set(schema["required"]), {"country", "role"})
        self.assertIn("percentiles", props)

    def test_design_values_match_the_library(self):
        err, text = call("get_design_values", {"country": "USA", "role": "Army", "sex": "M", "measures": ["stature", "mass"], "percentiles": [5, 50, 95]})
        self.assertFalse(err)
        got = json.loads(text)
        want = REPO.design_values("United States", "Army", "M", ["stature", "mass"], percentiles=[5, 50, 95])
        self.assertEqual(got["measures"], json.loads(json.dumps(want["measures"])))

    def test_mannequin_and_limit(self):
        err, text = call("get_mannequin_dimensions", {"country": "United States", "role": "Army", "sex": "M", "percentile": 95, "limit": 5})
        self.assertFalse(err)
        m = json.loads(text)
        full = REPO.mannequin("United States", "Army", "M", 95)
        self.assertEqual(len(m["dimensions"]), 5)
        self.assertEqual(list(m["values"]), [d["key"] for d in m["dimensions"]])
        self.assertTrue(m["truncated"])
        self.assertEqual(m["core"], full["core"])  # core keeps stature and mass even when the list is cut
        self.assertEqual(m["count"], full["count"])
        self.assertIn(f"first 5 of {full['count']}", m["notes"][-1])

    def test_unlimited_when_measures_are_named(self):
        err, text = call("get_design_values", {"country": "US", "role": "Army", "sex": "M", "measures": ["stature"], "limit": 1})
        self.assertFalse(err)
        self.assertNotIn("truncated", json.loads(text))

    def test_errors_reach_the_model_with_choices(self):
        err, text = call("get_design_values", {"country": "Narnia", "role": "Army"})
        self.assertTrue(err)
        self.assertIn("Unknown country 'Narnia'", text)
        self.assertIn("Valid values", text)
        err, text = call("get_design_values", {"country": "United Kingdom", "role": "Army", "sex": "M"})
        self.assertTrue(err)
        self.assertIn("No men data", text)

    def test_catalog_and_compare_tools(self):
        err, text = call("list_countries")
        self.assertFalse(err)
        self.assertEqual(len(json.loads(text)["countries"]), len(REPO.countries()))
        err, text = call("search_measures", {"query": "sitting height", "limit": 5})
        self.assertIn("sitting_height", [m["key"] for m in json.loads(text)["measures"]])
        err, text = call("compare_populations", {"measure": "stature", "percentile": 95, "limit": 3})
        self.assertFalse(err)
        self.assertEqual(len(json.loads(text)["results"]), 3)
        err, text = call("list_surveys", {"country": "United States", "role": "Army"})
        self.assertIn("ansur-ii-2012", text)
        err, text = call("get_source", {"source_id": "ansur-ii-2012"})
        self.assertFalse(err)
        err, text = call("about")
        self.assertIn("boundary", text.lower())


if __name__ == "__main__":
    unittest.main()
