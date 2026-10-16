"""MCP server: lets an AI assistant (or any MCP client) look up military anthropometry while it drives a CAD or digital-human tool.

Run:  python -m anthro_service mcp                       (stdio, for Claude Desktop, Claude Code, Cursor ...)
      python -m anthro_service mcp --transport streamable-http --port 8001     (remote, http://host:8001/mcp)

Works with mcp 1.x (FastMCP) and mcp 2.x (MCPServer).
"""
from __future__ import annotations

from typing import Annotated

from .core import ApiError, get_repo

try:  # mcp 2.x
    from mcp.server.mcpserver import MCPServer as _Server
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server
    from mcp.server.fastmcp.exceptions import ToolError

INSTRUCTIONS = """\
Body-measurement statistics of military populations (country x role x sex) for digital-human and mannequin work: percentiles of stature,
sitting height, body mass and hundreds of other dimensions, from published surveys such as ANSUR II, with sample size, reliability and sources.

Typical flow: list_countries -> pick a country and role (Army, Air Force, Aircrew, Pilots, Recruits/trainees ...) -> search_measures if you need a
dimension by name -> get_design_values for P5/P50/P95 (or other percentiles) or get_mannequin_dimensions for one value per dimension at a single
percentile. compare_populations ranks countries on one measure.

Units: millimetres and kilograms unless a measure says otherwise. Every value has a reliability (high, medium, low), a basis (reported,
estimated, interpolated, extrapolated) and sources: report them to the user. By default only high and medium reliability values are returned.
Each dimension is the requested percentile of that dimension alone, so a set of same-percentile dimensions is a boundary case, not a typical
person; say so when building a manikin from it.
"""

mcp = _Server("anthro-military-anthropometry", instructions=INSTRUCTIONS)


def _run(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ApiError as e:
        parts = [e.message]
        if e.hint:
            parts.append(e.hint)
        if e.available:
            parts.append("Valid values: " + "; ".join(map(str, e.available[:40])))
        raise ToolError(" ".join(parts)) from None


def _cap(result: dict, limit: int | None) -> dict:
    """Keep an AI client's context small: return at most `limit` measures, and say so."""
    key = "measures" if "measures" in result else "dimensions"
    total = len(result[key])
    if not limit or total <= limit:
        return result
    kept = result[key][:limit]
    out = {**result, key: kept, "truncated": True, "returned": limit}
    if "values" in result:
        out["values"] = {x["key"]: x["value"] for x in kept}
    out["notes"] = result["notes"] + [f"Showing the first {limit} of {total} measures. Narrow with 'measures' or 'categories', or raise 'limit'."]
    return out


@mcp.tool()
def about() -> dict:
    """Version, counts, units, the meaning of the reliability levels and percentile bases, attribution and the usage caveat."""
    return get_repo().meta()


@mcp.tool()
def list_countries() -> dict:
    """All countries with their roles (survey populations), the sexes that have data, and the number of measures. Start here."""
    countries = [{"id": c["id"], "name": c["name"], "roles": [{"id": r["id"], "name": r["name"], "sexes": r["sexes"], "measures": r["measures"]} for r in c["roles"]]}
                 for c in get_repo().countries()]
    return {"count": len(countries), "countries": countries}


@mcp.tool()
def list_surveys(country: str, role: str) -> dict:
    """The individual surveys behind a country and role: id, year, sample size per sex, official document. Pass an id as 'survey' to the value tools to use one survey instead of the combined values."""
    return _run(get_repo().surveys, country, role)


@mcp.tool()
def search_measures(query: str | None = None, category: str | None = None, country: str | None = None, role: str | None = None, sex: str | None = None,
                    limit: int = 25) -> dict:
    """Find measures by words in the name (for example 'sitting height', 'waist hip', 'hand breadth'). Filter by category (heights-standing, seated, circumferences, ...) and optionally by population. Returns key, name, unit and category; use the key in the other tools."""
    found = _run(get_repo().measures, category, query, country, role, sex, limit)
    return {"count": len(found), "measures": found}


@mcp.tool()
def get_design_values(country: str, role: str, sex: str = "M", measures: list[str] | None = None, categories: list[str] | None = None,
                      percentiles: list[float] | None = None, min_reliability: str = "medium", survey: str | None = None, limit: int = 60) -> dict:
    """Percentiles (default 5, 50, 95; any from 0.1 to 99.9) of the chosen measures for one population, with mean, SD, sample size, reliability, basis and sources.
    sex is M, F or both (mixed / not stated). measures are keys such as stature, mass, sitting_height; or choose categories. min_reliability is high, medium (default) or low. Without measures or categories the first 'limit' measures are returned."""
    return _cap(_run(get_repo().design_values, country, role, sex, measures, categories, percentiles, min_reliability, survey, True), limit)


@mcp.tool()
def get_mannequin_dimensions(country: str, role: str, sex: str = "M", percentile: float = 50, measures: list[str] | None = None, categories: list[str] | None = None,
                             min_reliability: str = "medium", survey: str | None = None, limit: int = 60) -> dict:
    """One value per dimension at a single percentile, plus core stature, body mass and sitting height: the dimension set for a reference or boundary manikin (call with 5, 50 and 95 for small, medium and large)."""
    return _cap(_run(get_repo().mannequin, country, role, sex, percentile, measures, categories, min_reliability, survey), limit)


@mcp.tool()
def compare_populations(measure: str, sex: str = "M", percentile: float = 50, countries: list[str] | None = None, roles: list[str] | None = None,
                        min_reliability: str = "medium", min_n: int = 0, limit: int = 15) -> dict:
    """Rank populations on one measure at one percentile, highest first (for example stature P95 of men across armies). Use min_n to ignore small samples."""
    return _run(get_repo().compare, measure, sex, percentile, countries, roles, min_reliability, min_n, limit)


@mcp.tool()
def get_source(source_id: str) -> dict:
    """Title, links and official document of a source id taken from the 'sources' field of a value."""
    return _run(get_repo().source, source_id)


def main(transport: str = "stdio", host: str = "127.0.0.1", port: int = 8001) -> None:
    if transport == "stdio":
        mcp.run()
        return
    try:
        mcp.run(transport, host=host, port=port)
    except TypeError:  # mcp 1.x keeps host and port in settings
        mcp.settings.host, mcp.settings.port = host, port
        mcp.run(transport)


if __name__ == "__main__":
    main()
