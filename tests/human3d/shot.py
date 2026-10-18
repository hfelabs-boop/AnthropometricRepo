"""Headless Chromium (WebGL via SwiftShader) helper: open a page of the dev server, optionally run JavaScript, save a screenshot.

    python tests/human3d/shot.py "#/human" out.png [--w 1280] [--h 800] [--dark] [--wait-ms 1500] [--eval "js"] [--wait-fn "js condition"] [--selector css]
Prints console messages and page errors, and the JSON result of --eval. Exit code 1 if the page raised an error.
From Python:  from shot import browser   (a context manager yielding (page, logs) already pointed at the dev server).
"""
import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from devserver import serve  # noqa: E402

CHROME = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--ignore-certificate-errors"]


@contextlib.contextmanager
def browser(width=1280, height=800, dark=False, mobile=False, base=None):
    from playwright.sync_api import sync_playwright
    proxy = {"server": os.environ["HTTPS_PROXY"], "bypass": "127.0.0.1,localhost"} if os.environ.get("HTTPS_PROXY") else None
    with contextlib.ExitStack() as stack:
        url = base or stack.enter_context(serve())
        p = stack.enter_context(sync_playwright())
        b = p.chromium.launch(executable_path=CHROME, args=ARGS, proxy=proxy)
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True,
                            is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        page.base = url
        try:
            yield page, logs
        finally:
            b.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("route", help="hash route such as '#/human' or a path such as '/index.html#/human'")
    ap.add_argument("out")
    ap.add_argument("--w", type=int, default=1280)
    ap.add_argument("--h", type=int, default=800)
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--mobile", action="store_true")
    ap.add_argument("--wait-ms", type=int, default=1500)
    ap.add_argument("--wait-fn", help="JavaScript expression that must become truthy before the screenshot")
    ap.add_argument("--eval", help="JavaScript run before the screenshot; its JSON-able result is printed")
    ap.add_argument("--selector", help="screenshot only this element")
    a = ap.parse_args()
    with browser(a.w, a.h, a.dark, a.mobile) as (page, logs):
        page.goto(page.base + "/" + a.route if a.route.startswith("#") else page.base + a.route)
        if a.wait_fn:
            page.wait_for_function(a.wait_fn, timeout=60000)
        page.wait_for_timeout(a.wait_ms)
        if a.eval:
            print(json.dumps(page.evaluate(a.eval), indent=1, default=str))
            page.wait_for_timeout(300)
        (page.locator(a.selector) if a.selector else page).screenshot(path=a.out)
        for line in logs:
            print(line)
        sys.exit(1 if any(l.startswith("[pageerror]") for l in logs) else 0)


if __name__ == "__main__":
    main()
