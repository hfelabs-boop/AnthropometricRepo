"""Command line:  python -m anthro_service <command>

  serve      REST API on http://127.0.0.1:8000 (docs at /docs, OpenAPI at /openapi.json)      needs: pip install -r anthro_service/requirements.txt
  mcp        MCP server for AI assistants (stdio by default; --transport streamable-http for remote)   needs: the same
  snapshot   write the static JSON/CSV files (public/api/v1/); standard library only
  openapi    print the OpenAPI document (or write it with --out FILE)
  push       send a profile (the human-exchange JSON of the website's Export tab) to a server, or with --local straight into this computer's store
  pull       fetch a pushed profile (values, dims, angles, points or the document) as JSON, CSV or XML
  profiles   list the pushed profiles
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_SERVER = os.environ.get("ANTHRO_SERVER", "http://127.0.0.1:8000")


def _request(method: str, url: str, key: str | None, body: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json", **({"X-API-Key": key} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (the user names the server)
            return r.read()
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8"))["error"]
            msg = err["message"] + (f" {err['hint']}" if err.get("hint") else "")
        except Exception:  # not one of our errors
            msg = str(e)
        sys.exit(f"anthro_service: the server answered {e.code}: {msg}")
    except urllib.error.URLError as e:
        sys.exit(f"anthro_service: cannot reach {url} ({e.reason}). Start the server with:  python -m anthro_service serve   (or use push --local)")


def _profiles_cli(a) -> int:
    base = a.server.rstrip("/")
    key = a.key or os.environ.get("ANTHRO_KEY") or None
    if a.cmd == "push":
        data = sys.stdin.buffer.read() if a.file == "-" else open(a.file, "rb").read()
        if a.local:
            from .profiles import ProfileStore
            meta = ProfileStore(a.dir).push(data, received_from="cli")
        else:
            meta = json.loads(_request("POST", f"{base}/v1/profiles", key, data))
        print(f"Pushed {meta['label']!r} as {meta['id']}" + ("" if a.local else f"\n  values: {base}/v1/profiles/{meta['id']}/values?format=csv\n  latest: {base}/v1/profiles/latest/values?format=csv"))
        return 0
    if a.cmd == "profiles":
        items = json.loads(_request("GET", f"{base}/v1/profiles", key))["profiles"]
        if not items:
            print("No profile has been pushed yet.")
        for m in items:
            print(f"{m['id']}  {m['label']}  {m.get('stature_mm') or '?'} mm  {m.get('mass_kg') or '?'} kg  {(m.get('posture') or {}).get('name') or ''}")
        return 0
    path = f"/v1/profiles/{urllib.parse.quote(a.id)}" + ("" if a.view == "summary" else f"/{a.view}")
    text = _request("GET", f"{base}{path}?format={a.format}" if a.view != "document" else f"{base}{path}", key)
    if a.out:
        with open(a.out, "wb") as f:
            f.write(text)
        print(f"Wrote {a.out}")
    else:
        sys.stdout.write(text.decode("utf-8"))
    return 0


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m anthro_service", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the REST API")
    s.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to accept connections from other machines (default 127.0.0.1)")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--reload", action="store_true", help="restart on code changes (development)")

    m = sub.add_parser("mcp", help="run the MCP server")
    m.add_argument("--transport", choices=["stdio", "streamable-http", "sse"], default="stdio")
    m.add_argument("--host", help="HTTP transports: address to listen on (default 127.0.0.1)")
    m.add_argument("--port", type=int, help="HTTP transports: port (default 8001)")
    m.add_argument("--allowed-host", action="append", default=[], metavar="NAME", help="HTTP transports: a Host header value to accept (repeatable), e.g. mcp.example.org or mcp.example.org:8001. "
                   "Without it, a non-loopback --host accepts any Host header (the server has no authentication).")
    m.add_argument("--allowed-origin", action="append", default=[], metavar="URL", help="HTTP transports: a browser Origin to accept (repeatable), e.g. https://app.example.org")

    sn = sub.add_parser("snapshot", help="write static JSON/CSV files")
    sn.add_argument("--out", default="public", help="directory that receives api/v1/ (default: public)")

    o = sub.add_parser("openapi", help="print the OpenAPI document")
    o.add_argument("--out", help="write to this file instead of printing")

    def remote(p):
        p.add_argument("--server", default=DEFAULT_SERVER, help=f"the REST server (default {DEFAULT_SERVER}, or $ANTHRO_SERVER)")
        p.add_argument("--key", help="API key when the server sets ANTHRO_API_KEYS (or $ANTHRO_KEY)")

    pu = sub.add_parser("push", help="send a profile file to the server (or the local store)")
    pu.add_argument("file", help="human-exchange JSON of the Export tab, or a profile file of the Profile tab; - reads standard input")
    remote(pu)
    pu.add_argument("--local", action="store_true", help="write straight into this computer's profile store (no server needed)")
    pu.add_argument("--dir", help="the store directory for --local (default $ANTHRO_PROFILE_DIR or ~/.anthro_service/profiles)")
    pl = sub.add_parser("pull", help="fetch a pushed profile")
    pl.add_argument("id", nargs="?", default="latest", help="profile id or latest (default)")
    pl.add_argument("--view", choices=["summary", "values", "dims", "angles", "points", "document"], default="values")
    pl.add_argument("--format", choices=["json", "csv", "xml"], default="csv")
    pl.add_argument("--out", help="write to this file instead of printing")
    remote(pl)
    ls = sub.add_parser("profiles", help="list the pushed profiles")
    remote(ls)

    a = ap.parse_args(argv)
    if a.cmd in ("push", "pull", "profiles"):
        return _profiles_cli(a)
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
            if a.host == "":
                ap.error("--host must not be empty")
            if a.transport == "stdio" and (a.host is not None or a.port is not None or a.allowed_host or a.allowed_origin):
                print("anthro_service: --host, --port, --allowed-host and --allowed-origin only apply to the HTTP transports; ignored for stdio.", file=sys.stderr)
            run_mcp(a.transport, "127.0.0.1" if a.host is None else a.host, 8001 if a.port is None else a.port, a.allowed_host, a.allowed_origin)
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
