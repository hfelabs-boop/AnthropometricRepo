"""Command line:  python -m anthro_service <command>

  serve      REST API on http://127.0.0.1:8000 (docs at /docs, OpenAPI at /openapi.json)      needs: pip install -r anthro_service/requirements.txt
  mcp        MCP server for AI assistants (stdio by default; --transport streamable-http for remote)   needs: the same
  snapshot   write the static JSON/CSV files (public/api/v1/); standard library only
  openapi    print the OpenAPI document (or write it with --out FILE)
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m anthro_service", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the REST API")
    s.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to accept connections from other machines (default 127.0.0.1)")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--reload", action="store_true", help="restart on code changes (development)")

    m = sub.add_parser("mcp", help="run the MCP server")
    m.add_argument("--transport", choices=["stdio", "streamable-http", "sse"], default="stdio")
    m.add_argument("--host", default="127.0.0.1")
    m.add_argument("--port", type=int, default=8001)
    m.add_argument("--allowed-host", action="append", default=[], metavar="NAME", help="HTTP transports: a Host header value to accept (repeatable), e.g. mcp.example.org or mcp.example.org:8001. "
                   "Without it, a non-loopback --host accepts any Host header (the server has no authentication).")
    m.add_argument("--allowed-origin", action="append", default=[], metavar="URL", help="HTTP transports: a browser Origin to accept (repeatable), e.g. https://app.example.org")

    sn = sub.add_parser("snapshot", help="write static JSON/CSV files")
    sn.add_argument("--out", default="public", help="directory that receives api/v1/ (default: public)")

    o = sub.add_parser("openapi", help="print the OpenAPI document")
    o.add_argument("--out", help="write to this file instead of printing")

    a = ap.parse_args(argv)
    if a.cmd == "snapshot":
        from . import snapshot
        snapshot.main(["--out", a.out])
        return 0

    try:
        if a.cmd == "serve":
            import uvicorn
            uvicorn.run("anthro_service.rest:app", host=a.host, port=a.port, reload=a.reload)
        elif a.cmd == "mcp":
            from .mcp_server import main as run_mcp
            run_mcp(a.transport, a.host, a.port, a.allowed_host, a.allowed_origin)
        else:
            from .rest import create_app
            text = json.dumps(create_app().openapi(), indent=2, ensure_ascii=False) + "\n"
            if a.out:
                with open(a.out, "w", encoding="utf-8", newline="\n") as f:
                    f.write(text)
            else:
                sys.stdout.write(text)
    except ImportError as e:
        sys.exit(f"Cannot import {e.name!r} ({e}). Install the service requirements into this Python:  pip install -r anthro_service/requirements.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
