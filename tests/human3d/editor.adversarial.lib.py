"""Shared plumbing of the adversarial browser tests of the posture editor (editor.adversarial.*.py): opens the real site on the Posture tab in headless Chromium (SwiftShader).
    from editor_adversarial_lib import ... is not importable (dots in the name): the scripts do  exec(open(...).read())  or  importlib; see load() below.
"""
import contextlib
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import shot  # noqa: E402
from devserver import serve  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ED = "window.__human.state.postureEditor"
RIG = "window.__human.ctx.getRig()"
SCRATCH = Path(os.environ.get("HM_SCRATCH", "/tmp/claude-0/-home-user-AnthropometricRepo/47fa7a9b-9f20-5ccb-be11-268d4792d952/scratchpad"))


@contextlib.contextmanager
def session(width=1280, height=900, dark=False, mobile=False, reduced_motion=False, init=(), storage_state=None):
    with contextlib.ExitStack() as stack:
        base = stack.enter_context(serve())
        p = stack.enter_context(sync_playwright())
        proxy = {"server": os.environ["HTTPS_PROXY"], "bypass": "127.0.0.1,localhost"} if os.environ.get("HTTPS_PROXY") else None
        b = p.chromium.launch(executable_path=shot.CHROME, args=shot.ARGS, proxy=proxy)
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                            device_scale_factor=1, reduced_motion="reduce" if reduced_motion else "no-preference", accept_downloads=True, storage_state=storage_state)
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        for s in init:
            page.add_init_script(s)
        page.base = base
        try:
            yield page, logs, ctx
        finally:
            b.close()


def open_posture(page, hash_="#/human?debug", timeout=120000):
    page.goto(f"{page.base}/{hash_}")
    page.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
    page.get_by_role("tab", name="Posture").click()
    page.wait_for_selector(".hm-pe .hm-pe-card", timeout=60000)
    page.wait_for_function(f"window.__human.state.postureEditor && {ED}.ikReady", timeout=60000)
    page.wait_for_timeout(300)


def handle_xy(page, handle):
    return page.evaluate("""(h) => { const w = window.__human, p = w.state.postureEditor.handlePoint(h), o = w.viewport.project(p, {}), rc = w.viewport.canvas.getBoundingClientRect(); return { x: rc.left + o.x, y: rc.top + o.y, visible: o.visible, p: p.toArray() }; }""", handle)


def errors(logs, allow=()):
    return [ln for ln in logs if (ln.startswith("[error]") or ln.startswith("[pageerror]")) and "body.js" not in ln and not any(a in ln for a in allow)]
