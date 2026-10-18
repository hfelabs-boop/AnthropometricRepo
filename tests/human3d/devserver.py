"""Static dev server for the website: serves site/ first and falls back to public/ (the built database, api/v1, catalog) so that
edits under site/ show up without rebuilding. Build public/ once with `python scripts/build_site.py`.

    python tests/human3d/devserver.py [port]          # blocks; http://127.0.0.1:<port>/
or from Python:  with serve() as base: ...             # picks a free port
"""
import contextlib
import functools
import http.server
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Overlay(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        rel = http.server.SimpleHTTPRequestHandler.translate_path(self, path)
        rel = Path(rel).relative_to(Path.cwd()) if Path(rel).is_relative_to(Path.cwd()) else Path(rel)
        for base in (ROOT / "site", ROOT / "public"):
            candidate = base / rel
            if candidate.exists():
                return str(candidate)
        return str(ROOT / "site" / rel)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


@contextlib.contextmanager
def serve(port=0):
    handler = functools.partial(Overlay)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    import os
    os.chdir(ROOT)
    with serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8780) as base:
        print(base, flush=True)
        threading.Event().wait()
