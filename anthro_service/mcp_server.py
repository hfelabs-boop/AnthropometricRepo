"""MCP server: lets an AI assistant (or any MCP client) look up military anthropometry while it drives a CAD or digital-human tool.

Run:  python -m anthro_service mcp                                                     (stdio, for Claude Desktop, Claude Code, Cursor ...)
      python -m anthro_service mcp --transport streamable-http --host 0.0.0.0 --port 8001 --allowed-host my.server.example     (remote: http://my.server.example:8001/mcp)

Works with mcp 1.x (FastMCP, 1.22 and later) and mcp 2.x (MCPServer).
"""
from __future__ import annotations

import logging
import sys
from collections import Counter
from typing import Annotated, Literal

from pydantic import Field

from .core import ApiError, VERSION, get_repo

try:  # mcp 2.x
    from mcp.server.mcpserver import MCPServer as _Server
    from mcp.server.mcpserver.exceptions import ToolError
    IS_V2 = True
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server
    from mcp.server.fastmcp.exceptions import ToolError
    IS_V2 = False
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

log = logging.getLogger("anthro_service")

INSTRUCTIONS = (
    "Body-measurement statistics of military populations (country x role x sex) for digital-human and mannequin work: percentiles of stature, sitting height, body mass and "
    "hundreds of other dimensions, from published surveys such as ANSUR II, with sample size, reliability and sources.\n\n"
    "Typical flow: list_countries -> list_roles for the country -> search_measures if you need a dimension by name (prefer harmonized measures, which are defined the same way in "
    "every survey) -> get_design_values for P5/P50/P95 (or other percentiles) or get_mannequin_dimensions for one value per dimension at a single percentile. "
    "compare_populations ranks populations on one measure.\n\n"
    "Units: millimetres and kilograms unless a measure says otherwise (see 'units'). Every value has a reliability (high, medium, low), a basis (reported, pooled, estimated, "
    "interpolated, extrapolated) and sources: report them to the user. By default only high and medium reliability values are returned.\n\n"
    "Two cautions to pass on. (1) Each dimension is the requested percentile of that dimension alone, so a set of same-percentile dimensions is a boundary case, not a typical "
    "person. (2) By default the values combine every survey of a population, which can span decades; the notes say so. For current personnel use survey='latest' or pick a "
    "survey with list_surveys. Read the 'notes' and 'caution' fields of every answer."
)


def _make():
    try:
        return _Server("anthro-military-anthropometry", instructions=INSTRUCTIONS, version=VERSION)
    except TypeError:  # mcp 1.x FastMCP has no version argument: the low-level server carries it
        server = _Server("anthro-military-anthropometry", instructions=INSTRUCTIONS)
        try:
            server._mcp_server.version = VERSION
        except AttributeError:  # pragma: no cover
            pass
        return server


mcp = _make()

READ_ONLY = ToolAnnotations(readOnlyHint=True, idempotentHint=True, destructiveHint=False, openWorldHint=False)

Country = Annotated[str, Field(description="Country name or id, e.g. 'United States', 'united-states' or 'USA'. See list_countries.")]
Role = Annotated[str, Field(description="Role (survey population) of that country, e.g. 'Army', 'Air Force', 'Aircrew', 'Recruits/trainees'. See list_roles.")]
Sex = Annotated[str, Field(description="M (men), F (women) or both (mixed or not stated).", json_schema_extra={"enum": ["M", "F", "both"]})]
MinRel = Annotated[str, Field(description="Lowest reliability to include: high, medium (default) or low (everything).", json_schema_extra={"enum": ["high", "medium", "low"]})]
Survey = Annotated[str | None, Field(description="Use one survey instead of the combined values: an id from list_surveys, or 'latest' for the most recent well-covered survey.")]
Names = Annotated[list[str] | str | None, Field(description="List of measure keys such as ['stature','mass','sitting_height'] (a comma separated string also works). See search_measures.")]
Cats = Annotated[list[str] | str | None, Field(description="List of category names or ids, e.g. ['seated','circumferences']. See list_categories.")]
Limit = Annotated[int, Field(ge=1, le=200, description="Maximum number of items to return (1 to 200).")]


MAX_NAMED = 200


def _as_list(x) -> list | None:
    if x is None:
        return None
    items = [p.strip() for p in x.split(",")] if isinstance(x, str) else [str(p).strip() for p in x]
    items = [p for p in items if p]
    if len(items) > MAX_NAMED:
        raise ToolError(f"Give at most {MAX_NAMED} names per call.")
    return items or None


def _as_names(x, known) -> list | None:
    """Like _as_list, but a string that is itself a known name is one name: two countries are called 'Multiple: Turkey, Greece, Italy' and the like."""
    if isinstance(x, str) and known(x):
        return [x.strip()]
    return _as_list(x)


def _as_floats(x) -> list | None:
    items = _as_list(x)
    if items is None:
        return None
    try:
        return [float(p) for p in items]
    except ValueError:
        raise ToolError("percentiles must be numbers between 0.1 and 99.9, for example [5, 50, 95].") from None


def _message(e: ApiError) -> str:
    parts = [e.message]
    if e.hint:
        parts.append(e.hint)
    if e.available:
        n = len(e.available)
        label = "Closest matches" if e.close else "Valid values"
        shown = e.available if n <= 80 else e.available[:40]
        parts.append(f"{label} ({n}" + ("" if n <= 80 else "; first 40 shown, use the list tools for the rest") + "): " + "; ".join(map(str, shown)))
    return " ".join(parts)


def _run(fn, *a, **kw):
    """Call the library; every failure becomes a ToolError, whose text mcp 1.x and 2.x both hand to the model."""
    try:
        return fn(*a, **kw)
    except ApiError as e:
        raise ToolError(_message(e)) from None
    except ToolError:
        raise
    except Exception as e:  # a bug or a broken data directory: say what it was instead of mcp 2.x's bare 'Error executing tool'
        log.exception("tool failed")
        raise ToolError(f"Internal error ({type(e).__name__}: {e}). This is a bug or a data problem on the server.") from None


def _cap(result: dict, limit: int, named: bool) -> dict:
    """Keep an AI client's context small: at most `limit` measures when none were named (harmonized ones first), and say what was left out."""
    key = "measures" if "measures" in result else "dimensions"
    items = result[key]
    total = len(items)
    if named or total <= limit:
        return {**result, "total": total, "returned": total, "truncated": False}
    keep = {e["key"] for e in sorted(items, key=lambda e: not e.get("harmonized"))[:limit]}
    kept = [e for e in items if e["key"] in keep]
    left = Counter(e["category"] for e in items if e["key"] not in keep)
    out = {**result, key: kept, "total": total, "returned": len(kept), "truncated": True}
    if "values" in result:
        for field in ("values", "units"):
            out[field] = {k: v for k, v in result[field].items() if k in keep}
        out["caution"] = {k: v for k, v in result["caution"].items() if k in keep}
    out["notes"] = result["notes"] + [f"Showing {len(kept)} of {total} measures (harmonized ones first). Left out: " + ", ".join(f"{n} {c}" for c, n in left.most_common()) +
                                      ". Name the ones you need with 'measures', narrow with 'categories', or raise 'limit' (at most 200)."]
    return out


def _slim(e: dict) -> dict:
    """Drop what is empty and collapse a basis that is the same for every percentile: the same facts in fewer tokens."""
    out = {k: v for k, v in e.items() if v is not None and v != []}
    basis = out.get("percentile_basis")
    if basis and len(set(basis.values())) == 1:
        out["basis"] = next(iter(basis.values()))
        del out["percentile_basis"]
    return out


def _slimmed(result: dict) -> dict:
    for key in ("measures", "dimensions"):
        if key in result:
            result = {**result, key: [_slim(e) for e in result[key]]}
    return result


@mcp.tool(title="About this data", annotations=READ_ONLY,
          description="Version, counts, units, the meaning of the reliability levels and percentile bases (reported, pooled, estimated, interpolated, extrapolated), attribution and the usage caveat. Read once per session.")
def about() -> dict:
    return _run(lambda: get_repo().meta())


@mcp.tool(title="List countries", annotations=READ_ONLY,
          description="All countries with data, each with its roles (survey populations such as Army, Air Force, Aircrew) and the sexes that have data. Start here, then list_roles for the details of one country.")
def list_countries() -> dict:
    def go():
        countries = [{"id": c["id"], "name": c["name"], "roles": [{"name": r["name"], "sexes": r["sexes"]} for r in c["roles"]]} for c in get_repo().countries()]
        return {"count": len(countries), "countries": countries}
    return _run(go)


@mcp.tool(title="List roles of a country", annotations=READ_ONLY,
          description="The roles (survey populations) of one country with the sexes that have data, the number of measures and of surveys.")
def list_roles(country: Country) -> dict:
    return _run(lambda: get_repo().roles(country))


@mcp.tool(title="List measure categories", annotations=READ_ONLY,
          description="The measure categories (Heights (standing), Seated, Breadths & depths, Circumferences, Limbs & reach, Head & face, Hands & feet ...) with the number of measures in each. Use them as 'category' in search_measures or 'categories' in the value tools.")
def list_categories() -> dict:
    return _run(lambda: {"categories": get_repo().categories()})


@mcp.tool(title="List surveys of a population", annotations=READ_ONLY,
          description="The individual surveys behind a country and role: id, year, sample size per sex, official document, and whether it is part of the combined values. Pass an id (or 'latest') as 'survey' to the value tools to use one survey instead of the combined values.")
def list_surveys(country: Country, role: Role) -> dict:
    return _run(lambda: get_repo().surveys(country, role))


@mcp.tool(title="Search measures", annotations=READ_ONLY,
          description="Find measures by words in the name (for example 'sitting height', 'shoulder breadth', 'hand length'; 'weight' finds mass). Best matches first, harmonized measures before as-published ones. "
                      "Optionally narrow by category and by population. Returns key, name, unit, category and the number of populations that have it; use the key in the other tools.")
def search_measures(query: Annotated[str | None, Field(description="Words in the name, e.g. 'waist' or 'sitting height'.")] = None,
                    category: Annotated[str | None, Field(description="Category name or id, see list_categories.")] = None,
                    country: Annotated[str | None, Field(description="Only measures this country has.")] = None,
                    role: Annotated[str | None, Field(description="Only measures this role has.")] = None,
                    sex: Annotated[str | None, Field(description="Only measures with data for this sex: M, F or both.")] = None,
                    limit: Limit = 25) -> dict:
    def go():
        everything = get_repo().measures(category, query, country, role, sex)
        found = everything[:limit]
        out = {"total": len(everything), "returned": len(found), "truncated": len(everything) > len(found), "measures": found}
        if out["truncated"]:
            out["note"] = f"Showing {len(found)} of {len(everything)} matches; add words to 'query', set 'category', or raise 'limit'."
        return out
    return _run(go)


@mcp.tool(title="Get one measure", annotations=READ_ONLY,
          description="One measure by key: name, unit, category, and the populations (country, role, sexes) that have data for it. At most 'limit' populations (default 60, alphabetical); "
                      "'country' narrows the list to one country, and 'total_populations' tells how many there are in all.")
def get_measure(key: Annotated[str, Field(description="Measure key, e.g. 'stature' or 'other:waist_hip_ratio'.")],
                country: Annotated[str | None, Field(description="Only the populations of this country.")] = None, limit: Limit = 60) -> dict:
    def go():
        repo = get_repo()
        m = repo.measure(key)
        pops = m["populations"]
        if country:
            c = repo._country(country)
            pops = [p for p in pops if p["country"] == c]
        out = {**m, "populations": pops[:limit], "total_populations": len(pops), "truncated": len(pops) > limit}
        if out["truncated"]:
            out["note"] = f"Showing {limit} of {len(pops)} populations; pass 'country' for one country or raise 'limit' (at most 200)."
        return out
    return _run(go)


@mcp.tool(title="Get design values", annotations=READ_ONLY,
          description="Percentiles (default 5, 50, 95; any from 0.1 to 99.9) of the chosen measures for one population, with mean, SD, sample size, reliability, basis, years and sources. "
                      "At most 'limit' measures are returned (harmonized ones first) unless you name them in 'measures'. Read 'notes': they say when the combined values span decades. Empty fields are omitted.")
def get_design_values(country: Country, role: Role, sex: Sex = "M", measures: Names = None, categories: Cats = None,
                      percentiles: Annotated[list[float] | str | None, Field(description="Percentiles between 0.1 and 99.9, e.g. [5, 50, 95, 97.5] (default [5, 50, 95]).")] = None,
                      min_reliability: MinRel = "medium", survey: Survey = None, limit: Limit = 60) -> dict:
    names = _as_list(measures)
    return _slimmed(_cap(_run(lambda: get_repo().design_values(country, role, sex, names, _as_list(categories), _as_floats(percentiles), min_reliability, survey, True)), limit, bool(names)))


@mcp.tool(title="Get manikin dimensions", annotations=READ_ONLY,
          description="One value per dimension at a single percentile, plus 'core' (stature, body mass, sitting height), 'units', 'caution' and per-dimension years and sources: the dimension set for a reference or boundary manikin. "
                      "Call with 5, 50 and 95 for small, medium and large. At most 'limit' dimensions are returned (harmonized ones first) unless you name them in 'measures'. Empty fields are omitted.")
def get_mannequin_dimensions(country: Country, role: Role, sex: Sex = "M",
                             percentile: Annotated[float, Field(ge=0.1, le=99.9, description="Percentile between 0.1 and 99.9, e.g. 5, 50 or 95.")] = 50,
                             measures: Names = None, categories: Cats = None, min_reliability: MinRel = "medium", survey: Survey = None, limit: Limit = 60) -> dict:
    names = _as_list(measures)
    return _slimmed(_cap(_run(lambda: get_repo().mannequin(country, role, sex, percentile, names, _as_list(categories), min_reliability, survey)), limit, bool(names)))


@mcp.tool(title="Compare populations", annotations=READ_ONLY,
          description="Rank populations on one measure at one percentile, highest first (for example stature P95 of men across armies). Use min_n to ignore small samples. "
                      "'total' is the number of matching populations before 'limit'; 'no_data' lists requested countries or roles that have none. Combined values can span decades: use survey='latest' to compare current data.")
def compare_populations(measure: Annotated[str, Field(description="Measure key, e.g. 'stature'.")], sex: Sex = "M",
                        percentile: Annotated[float, Field(ge=0.1, le=99.9, description="Percentile between 0.1 and 99.9.")] = 50,
                        countries: Annotated[list[str] | str | None, Field(description="Only these countries (names that contain commas, such as 'Multiple: Turkey, Greece, Italy', work as a single string or in a list).")] = None,
                        roles: Annotated[list[str] | str | None, Field(description="Only these roles.")] = None,
                        min_reliability: MinRel = "medium", min_n: Annotated[int, Field(ge=0, description="Ignore populations with fewer people than this.")] = 0, limit: Limit = 15,
                        survey: Annotated[Literal["latest"] | None, Field(description="'latest' = compare each population's most recent survey instead of all its surveys combined; omit for the combined values.")] = None) -> dict:
    def go():
        repo = get_repo()
        return repo.compare(measure, sex, percentile, _as_names(countries, repo.knows_country), _as_names(roles, repo.knows_role), min_reliability, min_n, limit, survey)
    return _run(go)


@mcp.tool(title="Get a source", annotations=READ_ONLY,
          description="Title, links, licence (where the catalog records one) and official document of a source id taken from the 'sources' field of a value.")
def get_source(source_id: Annotated[str, Field(description="A source id such as 'ansur-ii-2012'.")]) -> dict:
    return _run(lambda: get_repo().source(source_id))


def _forbid_unknown_arguments() -> None:
    """The SDK ignores arguments a tool does not have, so a misspelled `percentile` would silently give the default answer: make them errors,
    and publish that in the schema (additionalProperties false). Written against the private tool registry of mcp 1.22 to 2.x; if a later SDK moves it, this does nothing."""
    tools = getattr(getattr(mcp, "_tool_manager", None), "_tools", None) or {}
    for tool in tools.values():
        model = tool.fn_metadata.arg_model
        model.model_config["extra"] = "forbid"
        model.model_rebuild(force=True)
        tool.parameters = model.model_json_schema(by_alias=True)


_forbid_unknown_arguments()

LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _clean_host(v: str) -> str:
    h = v.strip().rstrip("/.").lower()
    if not h or "://" in h or any(ch in h for ch in "/* \t"):
        sys.exit(f"anthro_service: --allowed-host expects a host name such as mcp.example.org or mcp.example.org:8001, not '{v}'.")
    return h


def _clean_origin(v: str) -> str:
    o = v.strip().rstrip("/").lower()
    if not o.startswith(("http://", "https://")) or " " in o or "*" in o.split("://", 1)[1].split(":")[0]:
        sys.exit(f"anthro_service: --allowed-origin expects a URL such as https://app.example.org, not '{v}'.")
    return o


def _security(host: str, allowed_hosts, allowed_origins) -> TransportSecuritySettings:
    """Host and origin checks (DNS-rebinding protection) for the HTTP transports, set explicitly so every supported mcp version behaves the same
    (mcp 1.22 has none by default, 1.23+ and 2.x only for localhost binds). The SDK checks Host and Origin together.
    Loopback bind: localhost names only. Allow-lists given: those plus localhost. Any other bind without allow-lists: no checking, with a warning."""
    hosts = [_clean_host(h) for h in (allowed_hosts or [])]
    origins = [_clean_origin(o) for o in (allowed_origins or [])]
    local_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    local_origins = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]
    if origins and not hosts and host not in LOOPBACK:
        sys.exit("anthro_service: --allowed-origin without --allowed-host would refuse every remote client (Host and Origin are checked together); add --allowed-host NAME.")
    if hosts or origins:
        patterns = local_hosts + [h if ":" in h.rsplit("]", 1)[-1] else f"{h}:*" for h in hosts] + hosts
        return TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=list(dict.fromkeys(patterns)), allowed_origins=local_origins + origins)
    if host in LOOPBACK:
        return TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=local_hosts, allowed_origins=local_origins)
    print(f"anthro_service: listening on {host} without host or origin checking; add --allowed-host NAME (repeatable) to restrict it. The server has no authentication.", file=sys.stderr)
    return TransportSecuritySettings(enable_dns_rebinding_protection=False)


def main(transport: str = "stdio", host: str = "127.0.0.1", port: int = 8001, allowed_hosts=None, allowed_origins=None) -> None:
    try:
        get_repo()  # fail now, with the reason, rather than on the first tool call
    except (OSError, ValueError, KeyError) as e:
        sys.exit(f"anthro_service: cannot load the data: {e}")
    if transport == "stdio":
        mcp.run()
        return
    security = _security(host, allowed_hosts, allowed_origins)
    if IS_V2:
        mcp.run(transport, host=host, port=port, transport_security=security)
    else:
        mcp.settings.host, mcp.settings.port = host, port
        mcp.settings.transport_security = security
        mcp.run(transport)


if __name__ == "__main__":
    main()
