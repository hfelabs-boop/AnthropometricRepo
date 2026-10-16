"""Host and origin strings for the browsers' CORS check (REST) and the DNS-rebinding check (MCP): one validation and normalisation for both.

Mistakes here do not fail loudly by themselves: a host or origin that no client can ever send just refuses everyone, so both servers
call these functions at start-up and stop with a message. Standard library only."""
from __future__ import annotations

import re

LABEL = r"[a-z0-9_-]+"  # underscores occur in container and intranet names (anthro_mcp)
HOST_RE = re.compile(rf"({LABEL}(\.{LABEL})*|\[[0-9a-f:.]+\])(:(\d{{1,5}}|\*))?")
ORIGIN_RE = re.compile(rf"(https?)://({LABEL}(\.{LABEL})*|\[[0-9a-f:.]+\])(:(\d{{1,5}}))?")


def _ascii(text: str) -> str:
    """Internationalised names travel as punycode (xn--...) in Host and Origin headers."""
    try:
        return ".".join(part.encode("idna").decode("ascii") if not part.isascii() else part for part in text.split("."))
    except UnicodeError:
        return text


def clean_host(value: str) -> str:
    """A Host header value such as mcp.example.org or mcp.example.org:8001: lower case, no trailing dot. ValueError when no client could send it."""
    h = _ascii(str(value).strip().lower().rstrip("."))
    if not HOST_RE.fullmatch(h):
        raise ValueError(f"'{value}' is not one host name such as mcp.example.org or mcp.example.org:8001 (no scheme, path, comma or wildcard; internationalised names as xn-- punycode)")
    return h


def clean_origin(value: str) -> str:
    """An Origin such as https://app.example.org or http://localhost:3000: lower case, no trailing slash, and without the default port (browsers leave it out)."""
    o = _ascii(str(value).strip().lower().rstrip("/"))
    m = ORIGIN_RE.fullmatch(o)
    if not m:
        raise ValueError(f"'{value}' is not one origin such as https://app.example.org (scheme, host and optional port; no path, comma or wildcard)")
    if m.group(5) and (m.group(1), m.group(5)) in (("https", "443"), ("http", "80")):
        o = f"{m.group(1)}://{m.group(2)}"
    return o
