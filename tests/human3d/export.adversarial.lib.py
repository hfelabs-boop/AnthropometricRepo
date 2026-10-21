"""Helpers of the adversarial browser checks of the Export tab (tests/human3d/export.adversarial.*.py). Plain scripts: run `python tests/human3d/export.adversarial.<name>.py`."""
import contextlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import shot  # noqa: E402
from devserver import serve  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SCRATCH = Path(os.environ.get("HM_SCRATCH", "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad"))


class S:
    def __init__(self, page, logs, base):
        self.page, self.logs, self.base = page, logs, base

    def errors(self):
        return [ln for ln in self.logs if ln.startswith("[error]") or ln.startswith("[pageerror]")]

    def js(self, expr, *a):
        return self.page.evaluate(expr, *a) if a else self.page.evaluate(expr)

    def open(self, hash_="#/human?debug", tab="Export", sections=True, wait_rig=True):
        p = self.page
        p.goto(f"{self.base}/{hash_}")
        if wait_rig:
            p.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer && !window.__human.state.busy", timeout=90000)
        if tab:
            p.get_by_role("tab", name=tab).click()
            p.wait_for_selector(".hm-ex .hm-ex-card", timeout=30000)
            if sections:
                self.js("document.querySelectorAll('.hm-ex details.hm-section').forEach((d) => { d.open = true; })")
        return self

    def button(self, name, exact=False):
        return self.page.locator(".hm-ex").get_by_role("button", name=name, exact=exact)

    def grab(self, name, exact=False, timeout=120000):
        with self.page.expect_download(timeout=timeout) as info:
            self.button(name, exact).click()
        d = info.value
        return d.suggested_filename, Path(d.path()).read_bytes()

    def idle(self, timeout=90000):
        self.page.wait_for_function("() => !document.querySelector('.hm-ex')?.hasAttribute('aria-busy')", timeout=timeout)


@contextlib.contextmanager
def session(width=1280, height=900, dark=False, mobile=False, route=None, reduced=False):
    with serve() as base, sync_playwright() as p:
        proxy = {"server": os.environ["HTTPS_PROXY"], "bypass": "127.0.0.1,localhost"} if os.environ.get("HTTPS_PROXY") else None
        b = p.chromium.launch(executable_path=shot.CHROME, args=shot.ARGS, proxy=proxy)
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                            device_scale_factor=1, accept_downloads=True, reduced_motion="reduce" if reduced else "no-preference")
        try:
            ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
        except Exception:  # noqa: BLE001
            pass
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        if route:
            route(ctx)
        try:
            yield S(page, logs, base)
        finally:
            b.close()
