"""Browser tests of the Digital human tab: the viewport (render on demand, camera presets, picking, gizmo, labels, context loss) and the shell
(layout, panel registry, tabs, toggles, selection, keyboard, theme, visibility, leaks). Headless Chromium with WebGL through SwiftShader
(slow, but it works: about 4 minutes for the whole file).

    python -m pytest tests/human3d/test_viewer.py -q                  # or: python tests/human3d/test_viewer.py
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_viewer.py   # fail instead of skip when Playwright / Chromium / WebGL is missing
    CHROMIUM=/path/to/chrome ...                                       # default: /opt/pw-browsers/chromium (see shot.py)
    HM_STUB=1 ...                                                      # use the fixtures of tests/human3d/pages/stubs even if the real modules exist

The tests use the site's real rig.js, fit.js, synthetic.js and body.js. While one of them does not exist yet, the fixture of the same name in
pages/stubs/ is served in its place (the shell never knows) and pytest prints a warning naming it. The tests only rely on the documented API
(DESIGN.md 2.3 / 2.3b) and on the debug hook window.__human = { viewport, ctx, store, pipeline, state }, which the shell sets only when the URL
hash contains "debug" (or localStorage "hm-debug" is set).
"""
import contextlib
import json
import math
import os
import sys
import warnings
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
STUBS = HERE / "pages" / "stubs"
REQUIRE = os.environ.get("REQUIRE_BROWSER") == "1"

try:  # noqa: SIM105
    from playwright.sync_api import sync_playwright
    import shot
    from devserver import serve
    _IMPORT_ERROR = None
except Exception as e:  # Playwright not installed
    sync_playwright = shot = serve = None
    _IMPORT_ERROR = e


def _unavailable(reason):
    if REQUIRE:
        pytest.fail(f"REQUIRE_BROWSER=1 but the browser tests cannot run: {reason}", pytrace=False)
    pytest.skip(f"browser tests skipped: {reason} (set REQUIRE_BROWSER=1 to make this a failure)", allow_module_level=True)


if _IMPORT_ERROR is not None:
    _unavailable(f"Playwright is not importable ({_IMPORT_ERROR})")
if not Path(shot.CHROME).exists():
    _unavailable(f"no Chromium at {shot.CHROME} (set CHROMIUM=/path/to/chrome)")

MODULES = ("rig", "fit", "synthetic", "body")
REAL = {m: (ROOT / "site" / "js" / "human" / f"{m}.js").exists() for m in MODULES}
# body.js (the optional skin generator) is only stubbed to keep the console free of the 404 of its optional import
STUBBED = [m for m in MODULES if os.environ.get("HM_STUB") == "1" or not REAL[m]]


# ---------------------------------------------------------------------------------------------------------------------------------- plumbing
@pytest.fixture(scope="session")
def server():
    if STUBBED:
        warnings.warn(f"digital human: test fixtures (tests/human3d/pages/stubs) stand in for {', '.join(m + '.js' for m in STUBBED)}; "
                      "these tests then say nothing about the real modules", stacklevel=1)
    with serve() as base:
        yield base


@pytest.fixture(scope="session")
def chromium():
    with sync_playwright() as p:
        proxy = {"server": os.environ["HTTPS_PROXY"], "bypass": "127.0.0.1,localhost"} if os.environ.get("HTTPS_PROXY") else None
        try:
            b = p.chromium.launch(executable_path=shot.CHROME, args=shot.ARGS, proxy=proxy)
        except Exception as e:
            _unavailable(f"Chromium does not start ({e})")
        try:
            pg = b.new_page()
            ok = pg.evaluate("!!document.createElement('canvas').getContext('webgl2')")
            pg.close()
        except Exception as e:
            ok = False
            _unavailable(f"cannot probe WebGL ({e})")
        if not ok:
            b.close()
            _unavailable("this Chromium has no WebGL 2 (headless SwiftShader needs --use-angle=swiftshader)")
        yield b
        b.close()


class Session:
    def __init__(self, page, logs, base):
        self.page, self.logs, self.base = page, logs, base

    def errors(self, allow=()):
        return [line for line in self.logs if (line.startswith("[error]") or line.startswith("[pageerror]")) and not any(a in line for a in allow)]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def open(self, hash_="#/human?debug", wait=True, timeout=90000):
        self.page.goto(f"{self.base}/{hash_}")
        if wait:
            self.page.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
            self.settle()
        return self

    def settle(self, ms=450):
        """Let camera animations and the debounced renders finish."""
        self.page.wait_for_timeout(ms)

    def view(self):
        return self.js("(() => { const v = window.__human.viewport.getView(); return { az: v.azimuth, polar: v.polar, dist: v.distance, pos: v.position.toArray(), target: v.target.toArray() } })()")

    def settle_view(self, timeout=8000):
        """Wait until the camera has stopped (damping keeps moving it for a few frames after an input)."""
        last, still, waited = None, 0, 0
        while waited < timeout:
            now = self.view()
            cur = now["pos"] + now["target"]
            if last is not None and max(abs(a - b) for a, b in zip(cur, last)) < 1e-4:
                still += 1
                if still >= 3:
                    return now
            else:
                still = 0
            last = cur
            self.page.wait_for_timeout(120)
            waited += 120
        return self.view()

    def wait_view(self, az, polar=None, tol=2.0, timeout=6000):
        try:
            self.page.wait_for_function(
                """([az, polar, tol]) => { const v = window.__human.viewport.getView(); const d = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
                return d(v.azimuth, az) < tol && (polar === null || Math.abs(v.polar - polar) < tol); }""", arg=[az, polar, tol], timeout=timeout)
        except Exception as e:
            raise AssertionError(f"the camera never reached azimuth {az}, polar {polar}: it is at {self.view()}") from e


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=800, dark=False, mobile=False, reduced_motion=False, init=(), stubs=None, extra_routes=None):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True,
                               is_mobile=mobile, has_touch=mobile, device_scale_factor=1, reduced_motion="reduce" if reduced_motion else "no-preference",
                               accept_downloads=True)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    for script in init:
        page.add_init_script(script)
    for name in (STUBBED if stubs is None else stubs):
        page.route(f"**/js/human/{name}.js", lambda route, request, n=name: route.fulfill(path=str(STUBS / f"{n}.js"), content_type="text/javascript"))
    for pattern, handler in (extra_routes or {}).items():  # registered last: Playwright runs the most recent matching route first
        page.route(pattern, handler)
    try:
        yield Session(page, logs, server)
    finally:
        ctx.close()


def set_display(s, **flags):
    """Put the display toggles into a known state (a rig without skin starts with the skeleton on): through the shell's ctx, then wait for the buttons."""
    s.js("(f) => window.__human.ctx.setDisplay(f)", flags)
    s.settle(150)


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


PIXELS = """async () => {
  const url = window.__human.viewport.screenshot({ labels: false });
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, sum2 = 0, n = 0; const seen = new Set();
  for (let i = 0; i < d.length; i += 28) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sum2 += l * l; n++; seen.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)); }
  const mean = sum / n;
  return { w: img.width, h: img.height, mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), colours: seen.size, corner: [d[0], d[1], d[2]] };
}"""

RAF_COUNTER = """(() => { window.__raf = 0; const o = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => { window.__raf++; return o(cb); }; })();"""
LISTENER_COUNTER = """(() => {
  // counts the listeners that are still registered on targets that are alive: window, document, other non-node targets and connected nodes
  // (a detached node keeps its listeners until it is garbage collected, which says nothing about leaks)
  const all = new Map(); let ctx = 0;
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const key = (type, o) => type + '|' + (typeof o === 'boolean' ? o : !!(o && o.capture));
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (fn && !(o && o.once)) { let m = all.get(this); if (!m) all.set(this, m = new Map()); let st = m.get(fn); if (!st) m.set(fn, st = new Set()); st.add(key(type, o)); }
    return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    const m = all.get(this), st = m && m.get(fn); if (st) st.delete(key(type, o)); return rem.call(this, type, fn, o); };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { const r = gc.call(this, type, ...a); if (r && /webgl/.test(type)) ctx++; return r; };
  window.__listeners = () => { let n = 0; for (const [t, m] of all) { if (t instanceof Node && !t.isConnected) continue; for (const st of m.values()) n += st.size; } return n; };
  window.__glContexts = () => ctx;
})();"""
NO_WEBGL = """(() => { const gc = HTMLCanvasElement.prototype.getContext; window.__noGL = true;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { if (window.__noGL && /webgl/.test(type)) return null; return gc.call(this, type, ...a); }; })();"""


def px_dark(px):
    return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2] < 90


# ---------------------------------------------------------------------------------------------------------------------------------- tests
def test_boots_renders_and_logs_no_errors(s):
    s.open()
    assert s.js("document.querySelector('.hm-root').dataset.hmState") == "ready"
    assert s.js("document.querySelectorAll('canvas').length") == 1
    info = s.js(PIXELS)
    assert info["w"] > 300 and info["h"] > 300, info
    assert info["std"] > 4 and info["colours"] > 12, f"the canvas looks blank: {info}"
    assert s.js("window.__human.viewport.info().webgl") == 2
    assert s.errors() == [], s.errors()
    # the profile came from anthro.js (United States / Army / men / P50) unless the data could not be loaded
    label = s.js("window.__human.state.profile.label")
    assert "United States" in label or "Manual" in label, label
    # the pipeline built exactly one rig and the status bar shows the profile
    assert label in s.js("document.querySelector('.hm-status').textContent")


def test_render_is_on_demand_no_frames_while_idle(chromium, server):
    with make_session(chromium, server, init=[RAF_COUNTER]) as s:
        s.open()
        s.settle(1200)
        before = s.js("window.__raf")
        s.page.wait_for_timeout(1500)
        assert s.js("window.__raf") - before == 0, "an idle viewport must not request animation frames"
        # one request makes exactly one frame, many requests coalesce into one
        frames = s.js("window.__human.viewport.renderer.info.render.frame")
        s.js("(() => { const v = window.__human.viewport; for (let i = 0; i < 50; i++) v.requestRender(); })()")
        s.page.wait_for_timeout(300)
        assert s.js("window.__human.viewport.renderer.info.render.frame") - frames == 1
        assert s.js("window.__raf") - before == 1


def test_view_presets_move_the_camera(s):
    s.open()
    expected = {"front": (0, 90), "back": (180, 90), "left": (90, 90), "right": (-90, 90), "top": (0, 0.5), "iso": (35, 68)}
    keys = {"front": "1", "back": "2", "left": "3", "right": "4", "top": "5", "iso": "6"}
    d0 = s.view()["dist"]
    for name in ("back", "left", "right", "top", "iso", "front"):
        s.page.locator(f"button[data-view='{name}']").click()
        s.wait_view(*expected[name])
        assert abs(s.view()["dist"] - d0) < 1e-6, "a preset keeps the distance"
    # keys 1-6 do the same (focus is on the page, not in a field)
    s.page.mouse.click(2, 300)
    for name, k in keys.items():
        s.page.keyboard.press(k)
        s.wait_view(*expected[name])
    # F frames the figure and keeps the viewing direction
    s.page.keyboard.press("3")
    s.wait_view(90, 90)
    c = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    s.page.mouse.move(*c)
    for _ in range(3):
        s.page.mouse.wheel(0, 300)  # zoom out
    s.settle(600)
    far = s.view()["dist"]
    assert far > d0 * 1.2
    s.page.keyboard.press("f")
    s.page.wait_for_function("(far) => window.__human.viewport.getView().distance < far * 0.8", arg=far, timeout=4000)
    s.settle(600)
    v = s.view()
    assert abs(v["az"] - 90) < 2 and abs(v["polar"] - 90) < 2, "F keeps the viewing direction"
    # the figure is in the view: the head and the feet project inside the canvas
    ends = s.js("""() => { const { viewport, ctx } = window.__human; const T = viewport.camera.position.constructor; const b = ctx.getRig().group;
      return [0.05, 1.6].map((y) => viewport.project(new T(0, y, 0))).map((p) => [p.visible, p.x, p.y]); }""")
    assert all(e[0] for e in ends), ends
    assert s.errors() == [], s.errors()


def test_view_preset_is_instant_with_reduced_motion(chromium, server):
    with make_session(chromium, server, reduced_motion=True, init=[RAF_COUNTER]) as s:
        s.open()
        s.settle(800)
        before = s.js("window.__raf")
        s.page.locator("button[data-view='back']").click()
        s.page.wait_for_timeout(120)
        v = s.view()
        assert abs(v["az"] - 180) < 0.5, "no animation: the camera is already there"
        assert s.js("window.__raf") - before <= 2, "a jump needs at most one render frame, no animation loop"
        assert s.js("window.__human.viewport.controls.enableDamping") is False


def test_display_toggles_and_units(s):
    s.open()
    set_display(s, skin=True, skeleton=False, joints=False, labels=False, landmarks=False, com=False, xray=False, grid=True)
    has_skin = s.js("!!window.__human.ctx.getRig().skin")
    for key, label in [("skeleton", "Skeleton"), ("joints", "Joints"), ("labels", "Labels"), ("landmarks", "Landmarks"), ("com", "Centre of mass"), ("xray", "X-ray")]:
        btn = s.page.get_by_role("button", name=label, exact=True)
        assert btn.get_attribute("aria-pressed") == "false", label
        btn.click()
        assert btn.get_attribute("aria-pressed") == "true", label
        assert s.js(f"window.__human.state.display['{key}']") is True
        assert s.js(f"window.__human.ctx.getRig().display['{key}']") is True, f"rig.display.{key}"
        btn.click()
        assert btn.get_attribute("aria-pressed") == "false"
        assert s.js(f"window.__human.state.display['{key}']") is False
        assert s.js(f"window.__human.ctx.getRig().display['{key}']") is False, f"rig.display.{key}"
    skin = s.page.get_by_role("button", name="Skin", exact=True)
    if has_skin:
        skin.click()
        assert s.js("window.__human.ctx.getRig().display.skin") is False
        skin.click()
        assert s.js("window.__human.ctx.getRig().display.skin") is True
    else:
        assert skin.is_disabled() and skin.get_attribute("aria-pressed") == "false", "without a skin generator the Skin toggle is disabled"
    grid = s.page.get_by_role("button", name="Grid", exact=True)
    assert grid.get_attribute("aria-pressed") == "true"
    assert s.js("window.__human.viewport.floor.getObjectByName('hm-grid').visible") is True
    grid.click()
    assert s.js("window.__human.viewport.floor.getObjectByName('hm-grid').visible") is False
    assert s.js("window.__human.viewport.floor.getObjectByName('hm-axes').visible") is False
    grid.click()
    assert s.js("window.__human.viewport.floor.getObjectByName('hm-grid').visible") is True
    # a toggle changes what is drawn: the bones appear when Skeleton goes on (with the skin out of the way)
    set_display(s, skin=False, skeleton=False, joints=False)
    s.settle(300)
    a = s.js(PIXELS)
    s.page.get_by_role("button", name="Skeleton", exact=True).click()
    s.settle(400)
    b = s.js(PIXELS)
    assert abs(a["mean"] - b["mean"]) > 0.02 or a["colours"] != b["colours"], "showing the skeleton changes the picture"
    # units: the segmented control, the status bar and the saved preference
    assert s.page.locator(".hm-seg button[data-value='mm']").get_attribute("aria-pressed") == "true"
    s.page.locator(".hm-seg button[data-value='in']").click()
    assert s.js("window.__human.ctx.units") == "in"
    assert "in" in s.js("document.querySelector('.hm-status').textContent")
    assert json.loads(s.js("localStorage.getItem('hm-prefs')"))["units"] == "in"
    s.page.reload()
    s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    assert s.js("window.__human.state.units") == "in", "the unit is remembered"
    assert s.page.locator(".hm-seg button[data-value='in']").get_attribute("aria-pressed") == "true"
    assert s.js("window.__human.state.display.skeleton") is True, "the display choices are remembered too"
    assert s.errors() == [], s.errors()


def test_every_control_can_be_reached_with_the_keyboard(s):
    s.open()
    seen = set()
    s.page.locator("button[role=tab][data-tab=profile]").focus()
    for _ in range(40):
        s.page.keyboard.press("Tab")
        seen.add(s.js("document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim()"))
    for needle in ("Front", "mm", "Quality: ", "Hide"):  # one stop per toolbar (roving), the canvas, the status bar, the inspector
        assert any(needle in x for x in seen), f"Tab never reaches '{needle}': {sorted(seen)}"
    assert any(x.startswith("3D view") for x in seen), "the canvas is focusable"
    assert any(x in seen for x in ("Skin", "Skeleton", "Joints", "Labels")), f"the display toolbar is skipped: {sorted(seen)}"
    # inside a toolbar the arrow keys move and wrap, Home / End jump, and the stop follows
    s.page.locator(".hm-bar-bottom button", has_text="Skeleton").focus()
    s.page.keyboard.press("ArrowRight")
    assert s.js("document.activeElement.textContent") == "Joints"
    s.page.keyboard.press("End")
    assert s.js("document.activeElement.textContent") == "Grid"
    s.page.keyboard.press("ArrowRight")
    first = s.js("document.activeElement.textContent")
    assert first in ("Skin", "Skeleton"), "wraps to the first enabled control (Skin is disabled without a skin generator)"
    s.page.keyboard.press("Home")
    assert s.js("document.activeElement.textContent") == first
    assert s.js("[...document.querySelectorAll('.hm-bar-bottom button')].filter((b) => b.tabIndex === 0).length") == 1
    s.page.keyboard.press("Space")  # a real button: Space / Enter toggle it
    assert s.js("document.activeElement.getAttribute('aria-pressed')") in ("true", "false")
    assert s.errors() == [], s.errors()


def test_labels_overlay_follows_the_camera_and_never_overlaps(s):
    s.open()
    set_display(s, skeleton=True, joints=True, labels=True)
    s.settle(500)
    labels = s.page.locator(".hm-overlay .hm-label:not(.hm-label-axis)")
    n = labels.count()
    assert n >= 3, f"labels shown: {n}"
    boxes = s.js("[...document.querySelectorAll('.hm-overlay .hm-label')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, e.textContent]; })")
    c = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()")
    for x0, y0, x1, y1, text in boxes:
        assert x1 > c[0] and x0 < c[2] and y1 > c[1] and y0 < c[3], f"label '{text}' is outside the view"
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            ox, oy = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
            assert not (ox > 3 and oy > 3), f"labels overlap: {a[4]} / {b[4]} ({ox:.0f} x {oy:.0f} px)"
    before = s.js("[...document.querySelectorAll('.hm-overlay .hm-label')].map(e => e.style.transform).join('|')")
    s.page.keyboard.press("2")
    s.settle(900)
    after = s.js("[...document.querySelectorAll('.hm-overlay .hm-label')].map(e => e.style.transform).join('|')")
    assert before != after, "labels move with the camera"
    set_display(s, labels=False)
    s.page.wait_for_function("document.querySelectorAll('.hm-overlay .hm-label:not(.hm-label-axis)').length === 0", timeout=8000)
    assert s.errors() == [], s.errors()


def _joint_screen(s, joint="knee_L"):
    return s.js("""(joint) => { const { viewport, ctx } = window.__human; const T = viewport.camera.position.constructor; const rig = ctx.getRig();
      const w = rig.jointWorld(joint, new T()); const p = viewport.project(w); const r = viewport.canvas.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y, visible: p.visible, world: [w.x, w.y, w.z] }; }""", joint)


def test_click_selects_a_joint_marker_and_escape_clears_it(s):
    s.open()
    set_display(s, joints=True)
    s.settle(400)
    p = _joint_screen(s, "knee_L")
    assert p["visible"]
    s.page.mouse.move(p["x"] - 25, p["y"] - 25)
    s.page.mouse.move(p["x"], p["y"])
    s.settle(250)
    assert s.page.locator(".hm-tip").is_visible(), "hovering a marker names it"
    hovered = s.js("window.__human.ctx.getRig().highlighted")
    assert hovered in (None, "knee_L"), hovered  # a rig that tracks the hover emphasis (the real one) has it on the marker under the pointer
    if hovered is not None:
        assert math.dist(s.js("(id) => window.__human.ctx.getRig().jointWorld(id, new window.__human.viewport.camera.position.constructor()).toArray()", hovered), p["world"]) < 0.03
    assert s.js("document.querySelector('.hm-canvas').style.cursor") == "pointer"
    s.page.mouse.click(p["x"], p["y"])
    s.settle(300)
    sel = s.js("window.__human.state.selection")
    assert sel and sel["kind"] == "joint", sel
    # the selected joint is the one that was clicked (or one that sits at the same place)
    near = s.js("""(id) => { const { ctx } = window.__human; const T = window.__human.viewport.camera.position.constructor; return ctx.getRig().jointWorld(id, new T()).toArray(); }""", sel["id"])
    assert math.dist(near, p["world"]) < 0.03, (sel, near, p["world"])
    assert s.page.locator(".hm-stat", has_text="Selection").inner_text().strip() != "Selection none"
    assert s.js("window.__human.state.display.labels") is False
    name = s.js("document.querySelector('#hm-inspector-title').textContent")
    s.page.wait_for_function("(n) => [...document.querySelectorAll('.hm-overlay .hm-label')].some((e) => e.textContent === n)", arg=name, timeout=5000)  # named even with Labels off
    assert s.js("document.querySelector('#hm-inspector-title').textContent") not in ("Inspector", "")
    s.page.keyboard.press("Escape")
    s.settle(200)
    assert s.js("window.__human.state.selection") is None
    assert s.js("document.querySelector('#hm-inspector-title').textContent") == "Inspector"
    assert s.errors() == [], s.errors()


def test_a_drag_orbits_and_is_not_a_click(s):
    s.open()
    set_display(s, joints=True)
    s.settle(300)
    p = _joint_screen(s, "knee_L")
    before = s.view()
    s.page.mouse.move(p["x"], p["y"])
    s.page.mouse.down()
    s.page.mouse.move(p["x"] + 60, p["y"] + 10, steps=6)
    s.page.mouse.up()
    s.settle(500)
    after = s.view()
    assert abs(after["az"] - before["az"]) > 5, "the drag orbited"
    assert s.js("window.__human.state.selection") is None, "an orbit drag must not select what it started on"
    # (a slow press that does not move IS a click: test_a_slow_press_still_selects_a_joint)
    # clicking empty space clears a selection
    s.js("window.__human.ctx.select({ kind: 'joint', id: 'head' })")
    assert s.js("window.__human.state.selection")["id"] == "head"
    r = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    s.page.mouse.click(r[0] + 40, r[1] + r[3] * 0.5)  # empty floor beside the figure (not under a toolbar)
    s.settle(200)
    assert s.js("window.__human.state.selection") is None


def test_shortcuts_are_ignored_while_typing(s):
    s.open()
    s.page.keyboard.press("2")
    s.wait_view(180, 90)
    s.js("(() => { const i = document.createElement('input'); i.id = 'tmp-input'; document.querySelector('main').append(i); })()")
    s.page.locator("#tmp-input").focus()
    s.page.keyboard.type("1f?3")
    s.settle(500)
    assert s.page.locator("#tmp-input").input_value() == "1f?3"
    v = s.view()
    assert abs(v["az"] - 180) < 2, "typing in a field did not change the view"
    assert s.js("document.querySelector('.hm-help').hidden") is True
    s.js("document.querySelector('#tmp-input').remove()")


def test_help_popover(s):
    s.open()
    help_btn = s.page.get_by_role("button", name="Keyboard and mouse help")
    assert help_btn.get_attribute("aria-expanded") == "false"
    s.page.mouse.click(2, 300)
    s.page.keyboard.press("?")
    dlg = s.page.get_by_role("dialog", name="Keyboard and mouse help")
    assert dlg.is_visible()
    assert help_btn.get_attribute("aria-expanded") == "true"
    text = dlg.inner_text()
    for needle in ("Front, back, left, right, top and iso view", "Fit the figure", "Clear the selection", "Pan the camera", "Orbit around the figure", "Zoom", "pinch"):
        assert needle in text, needle
    s.page.keyboard.press("Escape")
    assert not dlg.is_visible()
    assert help_btn.get_attribute("aria-expanded") == "false"
    help_btn.click()
    assert dlg.is_visible()
    s.page.mouse.click(5, 300)  # outside closes it
    assert not dlg.is_visible()
    assert s.errors() == [], s.errors()


def test_panel_tabs_arrow_key_navigation(s):
    s.open()
    ids = ["profile", "posture", "scene", "measure", "skeleton", "analysis", "export"]
    tabs = s.page.get_by_role("tab")
    assert tabs.count() == 7
    assert [t.get_attribute("data-tab") for t in tabs.all()] == ids
    assert s.page.get_by_role("tablist").first.get_attribute("aria-label")
    assert [t.get_attribute("tabindex") for t in tabs.all()].count("0") == 1, "roving tab index: one tab stop"

    def selected():
        return [t.get_attribute("data-tab") for t in tabs.all() if t.get_attribute("aria-selected") == "true"]

    assert selected() == ["profile"]
    s.page.locator("button[role=tab][data-tab=profile]").focus()
    for expect in ids[1:]:
        s.page.keyboard.press("ArrowRight")
        assert selected() == [expect]
        assert s.js("document.activeElement.dataset.tab") == expect, "focus follows the selection"
        panel = s.page.locator(f"#hm-tab-panel-{expect}")
        assert not panel.is_hidden()
        s.page.wait_for_function("(id) => document.querySelector('#hm-tab-panel-' + id).textContent.trim().length > 0", arg=expect, timeout=8000)
        assert s.page.locator("[role=tabpanel]:visible").count() == 1, "exactly one panel is shown"
    s.page.keyboard.press("ArrowRight")
    assert selected() == ["profile"], "wraps around"
    s.page.keyboard.press("ArrowLeft")
    assert selected() == ["export"]
    s.page.keyboard.press("Home")
    assert selected() == ["profile"]
    s.page.keyboard.press("End")
    assert selected() == ["export"]
    assert [t.get_attribute("aria-controls") for t in tabs.all()] == [f"hm-tab-panel-{i}" for i in ids]
    for i in ids:
        assert s.js(f"document.getElementById('hm-tab-panel-{i}').getAttribute('aria-labelledby')") == f"hm-tab-{i}"
        assert s.js(f"document.getElementById('hm-tab-panel-{i}').querySelector('.hm-notice-error')") is None
    assert s.errors() == [], s.errors()


def test_panel_context_works_and_panels_see_events(s):
    s.open()
    s.page.locator("button[role=tab][data-tab=scene]").click()
    s.page.wait_for_function("document.querySelector('#hm-tab-panel-scene').textContent.trim().length > 0")
    s.js("window.__human.ctx.select({ kind: 'object', id: 'box-1' })")
    s.settle(200)
    assert "Selected object" in s.js("document.querySelector('#hm-inspector-title').textContent")
    s.js("window.__human.ctx.inspector('hello inspector', { title: 'Mine' })")  # the shell's own ctx is panel "shell": not the active tab
    assert s.js("document.querySelector('#hm-inspector-title').textContent") != "Mine"
    s.js("window.__human.ctx.setPosture({ id: 'x', name: 'Seated upright' })")
    assert "Seated upright" in s.js("document.querySelector('.hm-status').textContent")


def _layout(s):
    return s.js("""() => { const r = (sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      return { left: r('.hm-left'), center: r('.hm-center'), vp: r('.hm-viewport'), insp: r('.hm-inspector'), sw: document.documentElement.scrollWidth, iw: window.innerWidth, ih: window.innerHeight }; }""")


@pytest.mark.parametrize("width,height", [(1280, 800), (1260, 800), (1259, 800), (900, 700), (899, 800), (700, 800), (390, 800), (360, 740)])
def test_responsive_layout_has_no_horizontal_scroll(chromium, server, width, height):
    with make_session(chromium, server, width=width, height=height, mobile=width < 700) as s:
        s.open()
        set_display(s, skeleton=True, joints=True, labels=True)
        s.page.keyboard.press("?")
        s.settle(500)
        L = _layout(s)
        assert L["sw"] <= L["iw"], f"horizontal page scroll at {width}px: scrollWidth {L['sw']} > {L['iw']}"
        for name in ("left", "center", "insp"):
            assert L[name]["r"] <= L["iw"] + 0.5 and L[name]["l"] >= -0.5, f"{name} leaves the screen at {width}px: {L[name]}"
        if width >= 1260:  # three columns: panel | viewport | inspector
            assert L["left"]["r"] <= L["center"]["l"] + 1 and L["center"]["r"] <= L["insp"]["l"] + 1
            assert abs(L["left"]["t"] - L["center"]["t"]) < 40
        elif width >= 900:  # two columns, inspector under the viewport
            assert L["left"]["r"] <= L["center"]["l"] + 1
            assert L["insp"]["t"] >= L["center"]["b"] - 1 and abs(L["insp"]["l"] - L["center"]["l"]) < 2
        else:  # one column: viewport first, then the panel, then the inspector
            assert L["center"]["t"] < L["left"]["t"] < L["insp"]["t"]
            assert abs(L["left"]["l"] - L["center"]["l"]) < 2
            assert L["vp"]["h"] >= 0.55 * L["ih"] - 1, f"viewport {L['vp']['h']} px < 55vh ({0.55 * L['ih']})"
            strip = s.js("(() => { const t = document.querySelector('.hm-tabs'); return [t.scrollWidth > t.clientWidth, getComputedStyle(t).overflowX]; })()")
            assert strip[1] in ("auto", "scroll"), "the tab strip scrolls horizontally on a phone"
        # the canvas is as big as its container
        c = s.js("(() => { const v = window.__human.viewport; return [v.canvas.clientWidth, v.canvas.clientHeight, v.container.clientWidth, v.container.clientHeight]; })()")
        assert abs(c[0] - c[2]) <= 1 and abs(c[1] - c[3]) <= 1, c
        assert s.errors() == [], s.errors()


def test_resize_updates_canvas_and_aspect(s):
    s.open()
    a = s.js("(() => { const v = window.__human.viewport; return [v.canvas.width, v.canvas.height]; })()")
    s.page.set_viewport_size({"width": 1000, "height": 700})
    s.settle(700)
    b = s.js("(() => { const v = window.__human.viewport; return [v.canvas.width, v.canvas.height, v.camera.aspect, v.container.clientWidth, v.container.clientHeight]; })()")
    assert b[0] != a[0] or b[1] != a[1], "the drawing buffer follows the container"
    assert abs(b[2] - b[3] / b[4]) < 0.01, "the camera aspect matches the container"
    assert abs(b[0] - b[3]) <= 1 and abs(b[1] - b[4]) <= 1, "dpr 1: the drawing buffer matches the CSS size"
    assert s.errors() == [], s.errors()


def test_dark_theme_renders_and_theme_changes_are_followed(chromium, server):
    with make_session(chromium, server, dark=True) as s:
        s.open()
        assert s.js("window.__human.viewport.theme.dark") is True
        dark = s.js(PIXELS)
        assert px_dark(dark["corner"]), f"background should be dark: {dark['corner']}"
        assert dark["std"] > 4
        events = s.js("(() => { window.__themeEvents = []; window.__human.ctx.on('theme', (t) => window.__themeEvents.push(t.dark)); return 1; })()")
        s.page.locator("#theme-toggle").click()  # the site's toggle sets data-theme="light"
        s.page.wait_for_function("window.__human.viewport.theme.dark === false", timeout=3000)
        s.settle(400)
        light = s.js(PIXELS)
        assert not px_dark(light["corner"]), f"background should be light: {light['corner']}"
        assert s.js("window.__themeEvents") == [False]
        assert light["std"] > 4
        s.page.locator("#theme-toggle").click()
        s.page.wait_for_function("window.__human.viewport.theme.dark === true", timeout=3000)
        assert s.errors() == [], s.errors()


def test_system_colour_scheme_change_is_followed(s):
    s.open()
    assert s.js("window.__human.viewport.theme.dark") is False
    s.page.emulate_media(color_scheme="dark")
    s.page.wait_for_function("window.__human.viewport.theme.dark === true", timeout=3000)
    s.settle(300)
    assert px_dark(s.js(PIXELS)["corner"])


def test_hidden_tab_does_no_work_and_comes_back(chromium, server):
    with make_session(chromium, server, init=[RAF_COUNTER]) as s:
        s.open()
        s.settle(800)
        set_display(s, skeleton=True, joints=True)
        s.settle(400)
        s.page.evaluate("location.hash = '#/about'")
        s.page.wait_for_function("window.__human.viewport.active === false", timeout=3000)
        s.settle(500)
        n0 = s.js("window.__raf")
        frames0 = s.js("window.__human.viewport.renderer.info.render.frame")
        # even a flood of render requests and a camera change must not schedule anything while hidden
        s.js("(() => { const v = window.__human.viewport; for (let i = 0; i < 20; i++) v.requestRender(); v.setView('back'); })()")
        s.page.wait_for_timeout(1000)
        assert s.js("window.__raf") - n0 == 0, "no animation frames while the tab is hidden"
        assert s.js("window.__human.viewport.renderer.info.render.frame") == frames0
        assert s.js("window.__human.viewport.controls.enabled") is False
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_function("window.__human.viewport.active === true", timeout=3000)
        s.settle(400)
        assert s.js("window.__human.viewport.renderer.info.render.frame") > frames0, "showing the tab renders once"
        assert s.js("window.__human.viewport.controls.enabled") is True
        n1 = s.js("window.__raf")
        s.page.wait_for_timeout(1200)
        assert s.js("window.__raf") - n1 == 0, "idle again after coming back"
        assert s.errors() == [], s.errors()


def test_round_trips_do_not_leak_canvases_contexts_or_listeners(chromium, server):
    with make_session(chromium, server, init=[LISTENER_COUNTER]) as s:
        s.open()
        s.settle(800)
        s.page.locator("button[role=tab][data-tab=skeleton]").click()  # mount a panel before the baseline
        s.page.evaluate("location.hash = '#/about'")  # and build the other view (About renders itself on first use)
        s.page.wait_for_function("window.__human.viewport.active === false", timeout=3000)
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_function("window.__human.viewport.active === true", timeout=3000)
        s.settle(500)
        base = s.js("({ l: window.__listeners(), c: document.querySelectorAll('canvas').length, g: window.__glContexts(), mem: { ...window.__human.viewport.renderer.info.memory }, nodes: document.querySelectorAll('*').length })")
        assert base["c"] == 1 and base["g"] == 1, base
        for _ in range(10):
            s.page.evaluate("location.hash = '#/about'")
            s.page.wait_for_function("window.__human.viewport.active === false", timeout=3000)
            s.page.evaluate("location.hash = '#/human?debug'")
            s.page.wait_for_function("window.__human.viewport.active === true", timeout=3000)
            s.page.wait_for_timeout(120)
        s.settle(500)
        now = s.js("({ l: window.__listeners(), c: document.querySelectorAll('canvas').length, g: window.__glContexts(), mem: { ...window.__human.viewport.renderer.info.memory }, nodes: document.querySelectorAll('*').length })")
        assert now["c"] == 1, now
        assert now["g"] == 1, f"a round trip created another WebGL context: {now}"
        assert now["l"] == base["l"], f"listeners grew from {base['l']} to {now['l']}"
        assert now["mem"] == base["mem"], f"GPU resources grew: {base['mem']} -> {now['mem']}"
        assert now["nodes"] == base["nodes"], f"DOM nodes grew from {base['nodes']} to {now['nodes']}"
        assert s.errors() == [], s.errors()


def test_init_is_idempotent_and_dispose_frees_everything(chromium, server):
    with make_session(chromium, server, init=[LISTENER_COUNTER]) as s:
        s.page.goto(f"{s.base}/#/about?debug")
        s.page.wait_for_selector("#view-about:not([hidden])")
        s.settle(500)
        base = s.js("({ l: window.__listeners(), c: document.querySelectorAll('canvas').length, g: window.__glContexts() })")
        r = s.js("""async () => { const m = await import('/js/human/index.js'); const a = await m.initHuman(), b = await m.initHuman(); await a.ready;
          return { same: a === b, roots: document.querySelectorAll('.hm-root').length, canvases: document.querySelectorAll('canvas').length, l: window.__listeners() }; }""")
        assert r["same"] and r["roots"] == 1 and r["canvases"] == base["c"] + 1, r
        assert r["l"] > base["l"] + 10
        s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
        s.js("window.__human.ctx.setDisplay({ labels: true, joints: true })")
        s.js("document.querySelector('button[role=tab][data-tab=scene]').click()")  # mounts a panel (the view itself is hidden here)
        s.settle(400)
        gone = s.js("""async () => { const m = await import('/js/human/index.js'); m.disposeHuman(); await new Promise((r) => setTimeout(r, 300));
          return { roots: document.querySelectorAll('.hm-root').length, canvases: document.querySelectorAll('canvas').length, hook: !!window.__human, l: window.__listeners() }; }""")
        assert gone["roots"] == 0 and gone["canvases"] == base["c"] and gone["hook"] is False, gone
        assert gone["l"] == base["l"], f"dispose left listeners behind: {base['l']} -> {gone['l']}"
        again = s.js("""async () => { const m = await import('/js/human/index.js'); await m.initHuman(); await new Promise(r => setTimeout(r, 200)); return document.querySelectorAll('.hm-root').length; }""")
        assert again == 1, "after dispose, initHuman builds a fresh tab"
        s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
        assert s.errors() == [], s.errors()


def test_a_failed_start_cleans_up_and_can_be_retried(chromium, server):
    # initHuman() resolves at once with a controller (the router must never wait for the 3D code); the failure arrives on controller.ready
    # and is shown in the section with a Retry button; whatever the half-built shell had done is undone
    breaker = """(() => { const RO = window.ResizeObserver; window.__roFail = true;
      window.ResizeObserver = class extends RO { constructor(cb) { if (window.__roFail) throw new Error('observers are broken'); super(cb); } }; })();"""
    with make_session(chromium, server, init=[LISTENER_COUNTER, breaker]) as s:
        s.page.goto(f"{s.base}/#/about?debug")
        s.page.wait_for_selector("#view-about:not([hidden])")
        s.settle(500)
        base = s.js("({ l: window.__listeners(), c: document.querySelectorAll('canvas').length, g: window.__glContexts() })")
        r = s.js("""async () => { const m = await import('/js/human/index.js'); const c = window.__first = await m.initHuman(); const quick = typeof c.ready.then === 'function'; let msg = null;
          try { await c.ready; } catch (e) { msg = e.message; }
          return { quick, msg, roots: document.querySelectorAll('.hm-root').length, state: document.querySelector('.hm-root').dataset.hmState, canvases: document.querySelectorAll('canvas').length, hook: !!window.__human, l: window.__listeners(), g: window.__glContexts() }; }""")
        assert r["quick"] and r["msg"] == "observers are broken", r
        assert r["roots"] == 1 and r["state"] == "error" and r["canvases"] == base["c"] and r["hook"] is False, r
        assert r["l"] <= base["l"] + 1, f"listeners leaked by the failed start: {base['l']} -> {r['l']}"  # the Retry button's own handler is the only addition
        assert "observers are broken" in s.js("document.getElementById('view-human').innerText")
        s.js("window.__roFail = false")
        s.js("document.querySelector('#view-human button.btn').click()")  # the section is hidden here (the About tab is showing)
        s.page.wait_for_function("window.__human && window.__human.state.rig && document.querySelector('.hm-root').dataset.hmState === 'ready'", timeout=90000)
        assert s.js("document.querySelectorAll('.hm-root').length") == 1 and s.js("document.querySelectorAll('canvas').length") == base["c"] + 1
        # regression: the retry started a NEW controller while the router kept the first one, so the live shell never got onHide / onShow
        # (hidden tab: viewport still active, shortcut keys still acted on it)
        r = s.js("""async () => { const m = await import('/js/human/index.js'); const c = await m.initHuman(); const v = window.__human.viewport;
          const res = { same: c === window.__first, active0: v.active };
          window.__first.onShow(); res.activeShown = v.active; window.__first.onHide(); res.activeHidden = v.active;
          return res; }""")
        assert r["same"] is True, "initHuman() always hands out the same controller"
        assert r["active0"] is False and r["activeShown"] is True and r["activeHidden"] is False, r  # the router's controller drives the live shell
        az = s.js("window.__human.viewport.getView().azimuth")
        s.page.keyboard.press("2")  # the About tab is showing: the hidden view must ignore shortcuts
        s.settle(600)
        assert abs(s.js("window.__human.viewport.getView().azimuth") - az) < 1e-6
        assert [e for e in s.errors() if "observers are broken" not in e] == [], s.errors()


def test_inspector_can_be_collapsed_and_the_view_grows(s):
    s.open()
    btn = s.page.locator(".hm-inspector-x")
    assert btn.get_attribute("aria-expanded") == "true" and btn.inner_text() == "Hide"
    w0 = s.js("window.__human.viewport.container.clientWidth")
    btn.click()
    s.page.wait_for_function("(w0) => window.__human.viewport.container.clientWidth > w0 + 100", arg=w0, timeout=5000)
    assert btn.get_attribute("aria-expanded") == "false" and btn.inner_text() == "Inspector"
    assert not s.page.locator("#hm-inspector-body").is_visible()
    assert s.js("document.documentElement.scrollWidth <= window.innerWidth")
    btn.click()
    s.page.wait_for_function("(w0) => Math.abs(window.__human.viewport.container.clientWidth - w0) < 3", arg=w0, timeout=5000)
    assert s.page.locator("#hm-inspector-body").is_visible()
    s.settle(300)
    assert s.js(PIXELS)["std"] > 4
    assert s.errors() == [], s.errors()


def test_screenshot_is_a_png_and_the_button_downloads_it(s):
    s.open()
    url = s.js("window.__human.viewport.screenshot()")
    assert url.startswith("data:image/png;base64,") and len(url) > 3000
    with s.page.expect_download() as d:
        s.page.get_by_role("button", name="Save a screenshot").click()
    name = d.value.suggested_filename
    assert name.startswith("digital-human-") and name.endswith(".png"), name
    data = Path(d.value.path()).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 3000


def test_fit_failure_falls_back_to_a_generic_body_with_a_visible_notice(chromium, server):
    def bad_fit(route, request):
        # the generic fallback body is itself made by fitBody() (synthetic.js): only the fit of a real profile fails, the fallback uses the real one
        route.fulfill(body="import * as real from '/js/human/fit.js?real'; export * from '/js/human/fit.js?real'; "
                           "export function fitBody(p, o) { if (!String(p && p.id).startsWith('generic:')) throw new Error('boom'); return real.fitBody(p, o); }", content_type="text/javascript")
    with make_session(chromium, server, extra_routes={"**/js/human/fit.js": bad_fit}) as s:
        s.open()
        notice = s.page.locator(".hm-notice", has_text="Could not fit the profile")
        assert notice.count() == 1
        assert notice.inner_text().strip().startswith("Could not fit the profile (boom). Showing a generic body.")
        assert s.js("document.querySelector('.hm-root').dataset.hmState") == "ready", "the tab is not blank: a generic body was built"
        assert s.js("!!window.__human.ctx.getRig()") is True
        notice.get_by_role("button", name="Dismiss this message").click()
        assert s.page.locator(".hm-notice").count() == 0
        assert s.errors() == [], s.errors()


def test_missing_modules_leave_a_usable_tab(chromium, server):
    def gone(route, request):
        route.fulfill(status=404, body="not found")
    with make_session(chromium, server, stubs=[], extra_routes={"**/js/human/rig.js": gone, "**/js/human/fit.js": gone, "**/js/human/synthetic.js": gone}) as s:
        s.open(wait=False)
        s.page.wait_for_function("document.querySelector('.hm-root') && document.querySelector('.hm-root').dataset.hmState === 'error'", timeout=60000)
        assert s.page.locator(".hm-notice-error").count() >= 1, "an error notice explains"
        assert s.js("window.__human.viewport.failed") is False
        s.page.locator("button[data-view='top']").click()  # the viewport, toolbar and tabs still work
        s.page.get_by_role("tab", name="Export").click()
        assert s.page.locator("#hm-tab-panel-export").is_visible()
        assert s.js(PIXELS)["std"] > 2, "the floor is drawn"
        assert [e for e in s.errors() if "404" not in e and "dynamically imported" not in e] == []


def test_webgl_unavailable_shows_a_message_and_retry_rebuilds(chromium, server):
    with make_session(chromium, server, init=[NO_WEBGL]) as s:
        s.open(wait=False)
        s.page.wait_for_selector(".hm-vp-msg", timeout=60000)
        msg = s.page.locator(".hm-vp-msg")
        assert "WebGL" in msg.inner_text()
        assert msg.get_by_role("button", name="Retry").is_visible()
        assert s.js("document.querySelectorAll('canvas').length") == 0
        assert "WebGL unavailable" in s.js("document.querySelector('.hm-status').textContent")
        # the rest of the tab keeps working
        s.page.get_by_role("tab", name="Scene").click()
        assert s.page.locator("#hm-tab-panel-scene").is_visible()
        s.js("window.__noGL = false")
        msg.get_by_role("button", name="Retry").click()
        s.page.wait_for_function("window.__human.viewport.renderer && document.querySelectorAll('canvas').length === 1", timeout=20000)
        assert s.page.locator(".hm-vp-msg").count() == 0
        s.page.wait_for_function("window.__human.state.rig", timeout=60000)
        s.settle(500)
        assert s.js(PIXELS)["std"] > 4
        assert [e for e in s.errors() if "WebGL" not in e] == [], s.errors()


def test_context_loss_shows_a_message_and_recovers(s):
    s.open()
    s.js("window.__lose = window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context')")
    if not s.js("!!window.__lose"):
        pytest.skip("WEBGL_lose_context is not available in this browser")
    s.js("window.__lose.loseContext()")
    s.page.wait_for_selector(".hm-vp-msg", timeout=5000)
    assert "interrupted" in s.page.locator(".hm-vp-msg").inner_text()
    frames = s.js("window.__human.viewport.renderer.info.render.frame")
    s.js("window.__human.viewport.requestRender()")
    s.page.wait_for_timeout(300)
    assert s.js("window.__human.viewport.renderer.info.render.frame") == frames, "no rendering on a lost context"
    s.js("window.__lose.restoreContext()")
    s.page.wait_for_function("!document.querySelector('.hm-vp-msg')", timeout=8000)
    s.settle(500)
    assert s.js(PIXELS)["std"] > 4, "rendering resumed"
    # Retry (rebuild) also works from a lost context
    s.js("window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context').loseContext()")
    s.page.wait_for_selector(".hm-vp-msg")
    s.page.locator(".hm-vp-msg").get_by_role("button", name="Retry").click()
    s.page.wait_for_function("!document.querySelector('.hm-vp-msg') && document.querySelectorAll('canvas').length === 1", timeout=20000)
    s.settle(500)
    assert s.js(PIXELS)["std"] > 4
    assert [e for e in s.errors() if "CONTEXT_LOST" not in e and "context lost" not in e.lower()] == [], s.errors()


def test_quality_switch_rebuilds_the_rig(s):
    s.open()
    q0 = s.js("window.__human.state.quality")
    rig0 = s.js("window.__rigId = (window.__rigId || 0) + 1; window.__human.ctx.getRig().__id = window.__rigId")
    s.page.get_by_role("button", name=f"Quality: {q0}. Press to switch.").click()
    s.page.wait_for_function("(id) => window.__human.ctx.getRig() && window.__human.ctx.getRig().__id !== id", arg=rig0, timeout=60000)
    q1 = s.js("window.__human.state.quality")
    assert q1 != q0 and s.js("window.__human.viewport.quality") == q1
    s.settle(300)
    assert s.js(PIXELS)["std"] > 4
    assert s.errors() == [], s.errors()


def test_profile_changes_are_debounced_and_replace_the_rig(s):
    s.open()
    n = s.js("""async () => { const { ctx, state } = window.__human; const a = await import('/js/human/anthro.js'); window.__builds = 0;
      ctx.on('rig', () => window.__builds++);
      const ps = [1650, 1700, 1750, 1800, 1850].map((mm) => ctx.setProfile(a.manualProfile({ sex: 'M', stature: mm, mass: 80 })));
      const rs = await Promise.all(ps); return { builds: window.__builds, ok: rs.every((r) => r.ok), label: state.profile.label }; }""")
    assert n["ok"] and n["builds"] == 1, n
    assert "1850" in n["label"]
    assert s.errors() == [], s.errors()


CUSTOM_PANEL = """
export default {
  id: 'measure', label: 'Measure', order: 4,
  mount(container, ctx) {
    window.__panel = { shows: 0, hides: 0, events: [], disposed: 0, ctx };
    const p = document.createElement('p'); p.id = 'custom-body'; p.textContent = 'custom panel'; container.append(p);
    const off1 = ctx.on('selection', (s) => window.__panel.events.push(['selection', s]));
    const off2 = ctx.on('units', (u) => window.__panel.events.push(['units', u]));
    const insp = document.createElement('div'); insp.id = 'custom-insp'; insp.textContent = 'from the panel';
    ctx.inspector(insp, { title: 'Measurements' });
    return { onShow() { window.__panel.shows++; }, onHide() { window.__panel.hides++; }, dispose() { window.__panel.disposed++; off1(); off2(); } };
  }
};"""


def _serve_js(body, status=200):
    return lambda route, request: route.fulfill(status=status, body=body, content_type="text/javascript")


def test_a_panel_module_gets_a_working_context_and_lifecycle(chromium, server):
    with make_session(chromium, server, extra_routes={"**/js/human/panels/measure.js": _serve_js(CUSTOM_PANEL)}) as s:
        s.open()
        s.page.get_by_role("tab", name="Measure").click()
        s.page.wait_for_selector("#custom-body")
        assert s.js("window.__panel.shows") == 1
        assert s.js("document.querySelector('#hm-inspector-title').textContent") == "Measurements"
        assert s.page.locator("#hm-inspector-body #custom-insp").is_visible()
        # another tab: its own (default) inspector, the panel is told it is hidden
        s.page.get_by_role("tab", name="Profile").click()
        assert s.js("window.__panel.hides") == 1
        assert s.js("document.querySelector('#hm-inspector-title').textContent") == "Inspector"
        assert not s.page.locator("#custom-body").is_visible()
        s.page.get_by_role("tab", name="Measure").click()
        assert s.js("window.__panel.shows") == 2 and s.page.locator("#custom-insp").is_visible()
        # events and helpers of ctx
        s.js("window.__human.ctx.select({ kind: 'joint', id: 'head' })")
        s.js("window.__human.ctx.setUnits('cm')")
        assert s.js("window.__panel.events") == [["selection", {"kind": "joint", "id": "head"}], ["units", "cm"]]
        assert s.js("window.__panel.ctx.units") == "cm" and s.js("window.__panel.ctx.fmt(1755)") == "175.5 cm"
        assert s.js("window.__panel.ctx.getRig() === window.__human.ctx.getRig() && window.__panel.ctx.viewport === window.__human.viewport")
        s.js("window.__panel.ctx.select({ kind: 'landmark', id: 'vertex' })")
        assert s.js("window.__human.state.selection")["kind"] == "landmark"
        # hiding the whole tab hides the active panel, showing it shows it again
        s.page.evaluate("location.hash = '#/about'")
        s.page.wait_for_function("window.__panel.hides === 2", timeout=3000)
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_function("window.__panel.shows === 3", timeout=3000)
        s.js("window.__panel.ctx.inspector(null)")
        assert s.js("document.querySelector('#hm-inspector-title').textContent") != "Measurements"
        assert s.errors() == [], s.errors()


def test_a_missing_panel_is_coming_soon_and_a_broken_one_is_an_error_with_retry(chromium, server):
    gone = lambda route, request: route.fulfill(status=404, body="not found")  # noqa: E731
    broken = "throw new Error('boom at load');"
    bad_mount = "export default { mount() { throw new Error('boom at mount'); } };"
    good = "export default { mount(c) { c.textContent = 'recovered'; } };"
    state = {"scene": broken}
    routes = {
        "**/js/human/panels/posture.js": gone,
        "**/js/human/panels/scene.js*": lambda route, request: route.fulfill(body=state["scene"], content_type="text/javascript"),
        "**/js/human/panels/measure.js": _serve_js(bad_mount),
    }
    with make_session(chromium, server, extra_routes=routes) as s:
        s.open()
        s.page.get_by_role("tab", name="Posture").click()
        panel = s.page.locator("#hm-tab-panel-posture")
        panel.get_by_text("Coming soon").wait_for()
        assert panel.locator(".hm-notice-error").count() == 0, "a panel that does not exist is not an error"
        s.page.get_by_role("tab", name="Scene").click()
        err = s.page.locator("#hm-tab-panel-scene .hm-notice-error")
        err.wait_for()
        assert "could not load (boom at load)" in err.inner_text()
        state["scene"] = good
        s.page.locator("#hm-tab-panel-scene").get_by_role("button", name="Retry").click()
        s.page.wait_for_function("document.querySelector('#hm-tab-panel-scene').textContent.includes('recovered')", timeout=5000)
        s.page.get_by_role("tab", name="Measure").click()
        err = s.page.locator("#hm-tab-panel-measure .hm-notice-error")
        err.wait_for()
        assert "could not start (boom at mount)" in err.inner_text()
        s.page.get_by_role("tab", name="Profile").click()  # the rest keeps working
        assert s.page.locator("#hm-tab-panel-profile").is_visible()
        real = [e for e in s.errors() if "404" not in e and "boom" not in e and "dynamically imported" not in e]
        assert real == [], s.errors()


def test_default_profile_falls_back_to_a_manual_man_when_the_data_is_missing(chromium, server):
    def gone(route, request):
        route.fulfill(status=404, body="not found")
    with make_session(chromium, server, extra_routes={"**/api/v1/index.json": gone}) as s:
        s.open()
        p = s.js("window.__human.state.profile")
        assert p["source"]["kind"] == "manual" and p["measures"]["stature"]["value"] == 1755 and p["measures"]["mass"]["value"] == 80, p
        note = s.page.locator(".hm-notice", has_text="Could not load the population data")
        assert note.count() == 1
        assert "Starting from a generic man, 1755 mm tall and 80 kg" in note.inner_text()
        assert s.js("document.querySelector('.hm-root').dataset.hmState") == "ready", "the tab still shows a figure"
        assert "Manual" in s.js("document.querySelector('.hm-status').textContent")
        assert [e for e in s.errors() if "404" not in e] == [], s.errors()


@pytest.mark.parametrize("storage", ["corrupt", "blocked"])
def test_unusable_local_storage_does_not_break_the_tab(chromium, server, storage):
    init = {
        "corrupt": "try { localStorage.setItem('hm-prefs', '{not json'); } catch (e) {}",
        "blocked": "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });",
    }[storage]
    with make_session(chromium, server, init=[init]) as s:
        s.open()
        assert s.js("window.__human.state.units") == "mm"
        s.page.locator(".hm-seg button[data-value='cm']").click()  # saving the preference fails silently
        assert s.js("window.__human.state.units") == "cm"
        s.page.get_by_role("button", name="Grid", exact=True).click()
        assert s.js(PIXELS)["std"] > 2
        assert s.errors() == [], s.errors()


def test_pose_survives_a_profile_change(s):
    s.open()
    r = s.js("""async () => { const { ctx } = window.__human; const a = await import('/js/human/anthro.js');
      ctx.getRig().setPose({ angles: { elbow_L: [40] } });
      await ctx.setProfile(a.manualProfile({ sex: 'F', stature: 1620, mass: 62 }), { immediate: true });
      return ctx.getRig().getPose().angles.elbow_L; }""")
    assert abs(r[0] - 40) < 1e-6, r


def test_pan_zoom_limits_and_keyboard_pan(s):
    s.open()
    c = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * 0.6]; })()")
    v0 = s.settle_view()
    s.page.mouse.move(*c)
    s.page.mouse.down(button="right")
    s.page.mouse.move(c[0] + 90, c[1] + 20, steps=6)
    s.page.mouse.up(button="right")
    v1 = s.settle_view()
    assert math.dist(v0["target"], v1["target"]) > 0.05, "right-drag pans"
    assert abs(v1["az"] - v0["az"]) < 1 and abs(v1["polar"] - v0["polar"]) < 1, "panning does not orbit"
    s.page.locator(".hm-canvas").focus()
    for _ in range(4):
        s.page.keyboard.press("ArrowLeft")
    v2 = s.settle_view()
    assert math.dist(v1["target"], v2["target"]) > 0.02, "the arrow keys pan while the 3D view has focus"
    assert abs(v2["az"] - v1["az"]) < 1
    for _ in range(8):
        s.page.keyboard.press("Shift+ArrowLeft")
    v3 = s.settle_view()
    assert abs(v3["az"] - v2["az"]) > 2, "Shift + arrows orbit"
    # limits: zoom in and out as far as the wheel goes, orbit past the poles, pan far away
    s.page.mouse.move(*c)
    for _ in range(20):
        s.page.mouse.wheel(0, 2000)
    assert s.settle_view()["dist"] <= 12.0001
    for _ in range(20):
        s.page.mouse.wheel(0, -2000)
    assert s.settle_view()["dist"] >= 0.3999
    s.page.mouse.down()
    s.page.mouse.move(c[0], c[1] + 700, steps=8)
    s.page.mouse.up()
    assert s.settle_view()["polar"] <= 100.01, "no orbiting far below the floor"
    s.page.mouse.down()
    s.page.mouse.move(c[0], c[1] - 1500, steps=8)
    s.page.mouse.up()
    assert s.settle_view()["polar"] >= 0.0
    s.js("(() => { const v = window.__human.viewport; v.controls.target.set(80, 40, -90); v.camera.position.set(81, 41, -89); v.controls.dispatchEvent({ type: 'change' }); })()")
    t = s.settle_view()["target"]
    assert abs(t[0]) <= 6.001 and abs(t[2]) <= 6.001 and 0 <= t[1] <= 3.001, f"the target stays near the figure: {t}"
    assert s.errors() == [], s.errors()


def _touch(s, cdp, kind, points):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(points)]})


def test_touch_tap_selects_a_joint_but_a_two_finger_gesture_does_not(chromium, server):
    with make_session(chromium, server, width=390, height=800, mobile=True) as s:
        s.open()
        set_display(s, skeleton=True, joints=True)
        s.js("window.__human.viewport.canvas.scrollIntoView({ block: 'center' })")
        s.settle(400)
        p = _joint_screen(s, "knee_L")
        assert p["visible"]
        cdp = s.page.context.new_cdp_session(s.page)
        _touch(s, cdp, "touchStart", [(p["x"], p["y"])])
        _touch(s, cdp, "touchEnd", [])
        s.settle(400)
        sel = s.js("window.__human.state.selection")
        assert sel and sel["kind"] == "joint", f"a tap selects: {sel}"
        s.js("window.__human.ctx.select(null)")
        # two fingers put down and lifted without moving: that is a (failed) pinch, not a click
        _touch(s, cdp, "touchStart", [(p["x"], p["y"]), (p["x"] + 40, p["y"] + 30)])
        _touch(s, cdp, "touchEnd", [])
        s.settle(400)
        assert s.js("window.__human.state.selection") is None
        # a one-finger drag orbits and is not a tap
        v0 = s.view()
        _touch(s, cdp, "touchStart", [(p["x"], p["y"])])
        for k in range(1, 7):
            _touch(s, cdp, "touchMove", [(p["x"] + 12 * k, p["y"])])
        _touch(s, cdp, "touchEnd", [])
        s.settle(500)
        assert abs(s.view()["az"] - v0["az"]) > 3, "one finger orbits"
        assert s.js("window.__human.state.selection") is None
        assert s.errors() == [], s.errors()


def test_a_figure_built_while_the_tab_is_hidden_is_framed_when_shown(chromium, server):
    with make_session(chromium, server) as s:
        s.page.goto(f"{s.base}/#/human?debug")
        s.page.wait_for_function("window.__human && window.__human.viewport", timeout=60000)
        s.page.evaluate("location.hash = '#/about'")  # leave before the default profile has been fitted and built
        s.page.wait_for_function("window.__human.viewport.active === false", timeout=5000)
        s.page.wait_for_function("window.__human.state.rig", timeout=60000)
        assert s.js("window.__human.viewport.container.clientWidth") == 0, "the tab is hidden: the view has no size"
        frames = s.js("window.__human.viewport.renderer.info.render.frame")
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_function("window.__human.viewport.active && window.__human.viewport.container.clientWidth > 100", timeout=10000)
        s.settle(900)
        ends = s.js("""() => { const { viewport } = window.__human; const T = viewport.camera.position.constructor; const r = viewport.canvas;
          return [0.02, 1.7].map((y) => { const p = viewport.project(new T(0, y, 0)); return [p.visible, p.y / r.clientHeight]; }); }""")
        assert all(e[0] for e in ends), f"head and feet are in the view: {ends}"
        assert 0.1 < ends[1][1] < 0.5 and 0.55 < ends[0][1] < 0.97, f"the figure fills the view: {ends}"
        assert s.js("window.__human.viewport.renderer.info.render.frame") > frames
        assert s.errors() == [], s.errors()


def test_ui_helpers_in_a_browser(chromium, server):
    with make_session(chromium, server, stubs=[]) as s:
        s.page.goto(f"{s.base}/__pages/viewer-ui.html")
        s.page.wait_for_function("window.__ready", timeout=30000)
        log = lambda: s.js("window.log")  # noqa: E731
        # slider row: the label is tied to the range, the number field has its own name, keyboard and typing work, values are clamped
        rng = s.page.get_by_label("Elbow flexion", exact=True)
        assert rng.get_attribute("type") == "range" and rng.get_attribute("aria-valuetext") == "20 °"
        num = s.page.get_by_role("spinbutton", name="Elbow flexion value in °")
        assert num.input_value() == "20"
        rng.focus()
        s.page.keyboard.press("ArrowRight")
        assert ["input", 20.5] in log() and ["change", 20.5] in log()
        assert num.input_value() == "20.5", "the number follows the slider"
        num.fill("400")
        num.press("Tab")
        assert rng.input_value() == "150" and num.input_value() == "150", "clamped to the range"
        assert log()[-1] == ["change", 150]
        num.fill("-99")
        num.press("Enter")
        s.page.get_by_role("button", name="Joints").focus()
        assert num.input_value() == "-5"
        before = len(log())
        num.fill("")
        s.page.get_by_role("button", name="Joints").focus()
        assert num.input_value() == "-5" and len(log()) == before, "an empty field keeps the old value and reports nothing"
        s.js("window.__ui.sl.set(42.25)")
        assert rng.input_value() == "42.5", "the range snaps to its step"
        assert s.js("window.__ui.sl.get()") == 42.25 and num.input_value() == "42.3" and len(log()) == before, "set() keeps the exact value (shown with the step's decimals) and is silent by default"
        s.js("window.__ui.sl.set(1000, { silent: false })")
        assert log()[-1] == ["change", 150]
        assert s.js("window.__ui.sl.get()") == 150
        # integer slider: no decimals shown
        s.page.get_by_label("Stature", exact=True).fill("1800")
        assert s.page.get_by_role("spinbutton", name="Stature value in mm").input_value() == "1800"
        # section, badge, notice, empty state
        assert s.page.locator("details.hm-section").first.get_attribute("open") is not None
        assert s.page.locator("details.hm-section").nth(1).get_attribute("open") is None
        s.page.locator("details.hm-section").nth(1).locator("summary").click()
        assert s.page.get_by_text("hidden until opened").is_visible()
        assert s.page.locator(".tag.good").inner_text() == "measured" and s.page.locator(".tag.warn").inner_text() == "estimated"
        s.page.get_by_role("button", name="Dismiss this message").click()
        assert log()[-1] == ["dismiss"]
        assert s.page.locator(".hm-empty").inner_text().startswith("Nothing here")
        # segmented control and chip toggle
        s.page.get_by_role("button", name="cm", exact=True).click()
        assert log()[-1] == ["seg", "cm"] and s.js("window.__ui.seg.get()") == "cm"
        assert s.page.get_by_role("button", name="cm", exact=True).get_attribute("aria-pressed") == "true"
        assert s.page.get_by_role("button", name="mm", exact=True).get_attribute("aria-pressed") == "false"
        s.page.get_by_role("button", name="cm", exact=True).click()
        assert log().count(["seg", "cm"]) == 1, "pressing the active option again changes nothing"
        s.page.get_by_role("button", name="Joints").click()
        assert log()[-1] == ["chip", "true"]
        # tab list: automatic activation by arrow keys, no listener leak in the stub's live text
        s.page.get_by_role("tab", name="Alpha").focus()
        s.page.keyboard.press("ArrowRight")
        assert log()[-1] == ["tab", "b"] and s.js("window.__ui.tl.selected") == "b"
        s.page.keyboard.press("End")
        assert s.js("window.__ui.tl.selected") == "c"
        assert s.js("window.__ui.fmtLength(1755, 'in')") == "69.09 in"
        # comingSoon: live text refreshes on events, dispose unsubscribes
        assert "live" in s.page.locator(".hm-live").inner_text()
        s.js("window.__fire()")
        assert s.js("window.__n") == 2
        s.js("window.__soon.dispose()")
        assert ["off", "profile"] in log()
        assert s.errors() == [], s.errors()


# ------------------------------------------------------------------------------------------------------------------------- viewport alone
def test_gizmo_attach_modes_snap_and_orbit_suspension(chromium, server):
    with make_session(chromium, server, stubs=[]) as s:
        s.page.goto(f"{s.base}/__pages/viewer-basic.html?gizmo=translate")
        s.page.wait_for_function("window.__ready", timeout=60000)
        r = s.js("""() => { const vp = window.vp; const g = vp.gizmo; return { attached: !!g.object, name: g.object && g.object.name, inScene: !!g.getHelper().parent, mode: g.mode, space: g.space }; }""")
        assert r == {"attached": True, "name": "standin", "inScene": True, "mode": "translate", "space": "world"}, r
        r = s.js("""() => { const vp = window.vp; const o = vp.scene.getObjectByName('standin');
          vp.attachGizmo(o, { mode: 'rotate', space: 'local', snap: { translate: 0.05, rotate: 15, scale: 0.1 } });
          const g = vp.gizmo; return { mode: g.mode, space: g.space, t: g.translationSnap, r: g.rotationSnap, s: g.scaleSnap }; }""")
        assert r["mode"] == "rotate" and r["space"] == "local" and r["t"] == 0.05 and abs(r["r"] - math.radians(15)) < 1e-12 and r["s"] == 0.1, r
        r = s.js("""() => { const vp = window.vp; vp.attachGizmo(vp.scene.getObjectByName('standin'), { mode: 'translate' }); const g = vp.gizmo; return { t: g.translationSnap, r: g.rotationSnap }; }""")
        assert r == {"t": None, "r": None}, "re-attaching without snap clears the snapping"
        # orbit is suspended while the gizmo drags, and the events fire in order
        r = s.js("""() => { const vp = window.vp; window.events.length = 0; const was = vp.controls.enabled; vp.gizmo.dragging = true; const during = vp.controls.enabled;
          vp.gizmo.dragging = false; return { was, during, after: vp.controls.enabled, events: [...window.events] }; }""")
        assert r["was"] is True and r["during"] is False and r["after"] is True, r
        assert r["events"] == ["gizmo-start", "gizmo-end"], r
        s.js("window.vp.detachGizmo()")
        assert s.js("window.vp.gizmo.object") is None
        assert s.errors() == [], s.errors()


def test_gizmo_drag_moves_the_object_without_orbiting_or_clicking(chromium, server):
    with make_session(chromium, server, stubs=[]) as s:
        s.page.goto(f"{s.base}/__pages/viewer-basic.html?gizmo=translate&view=front")
        s.page.wait_for_function("window.__ready", timeout=60000)
        s.settle(300)
        # find a pixel where the X handle can be grabbed: TransformControls sets `axis` on hover
        found = s.js("""async () => { const vp = window.vp, o = vp.scene.getObjectByName('standin'); const T = window.THREE;
          const c = vp.project(o.getWorldPosition(new T.Vector3())); const r = vp.canvas.getBoundingClientRect(); return { cx: r.left + c.x, cy: r.top + c.y }; }""")
        hit = None
        for dx in range(20, 140, 6):
            s.page.mouse.move(found["cx"] + dx, found["cy"])
            if s.js("window.vp.gizmo.axis") == "X":
                hit = dx
                break
        assert hit is not None, "no X handle found near the object"
        x0 = s.js("window.vp.scene.getObjectByName('standin').position.x")
        cam0 = s.js("window.vp.camera.position.toArray()")
        s.js("window.events.length = 0")
        s.page.mouse.down()
        s.page.mouse.move(found["cx"] + hit + 40, found["cy"], steps=5)
        s.page.mouse.up()
        s.settle(300)
        x1 = s.js("window.vp.scene.getObjectByName('standin').position.x")
        assert abs(x1 - x0) > 0.05, f"the object did not move ({x0} -> {x1})"
        assert s.js("window.vp.camera.position.toArray()") == cam0, "the camera did not orbit while the gizmo was dragged"
        ev = s.js("window.events")
        assert ev[0] == "pointerdown" and "gizmo-start" in ev and "gizmo-change" in ev and "gizmo-end" in ev, ev
        assert "click" not in ev, "releasing a gizmo drag is not a click"
        assert s.errors() == [], s.errors()


def test_viewport_click_events_and_pick(chromium, server):
    with make_session(chromium, server, stubs=[]) as s:
        s.page.goto(f"{s.base}/__pages/viewer-basic.html?view=front")
        s.page.wait_for_function("window.__ready", timeout=60000)
        s.settle(300)
        pos = s.js("""() => { const vp = window.vp, T = window.THREE; const j = vp.scene.getObjectByName('joint-demo'); const p = vp.project(j.getWorldPosition(new T.Vector3()));
          const r = vp.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }""")
        s.js("""() => { const vp = window.vp; window.clicks = []; vp.on('click', (e) => window.clicks.push({ hit: e.hit && e.hit.object.name, shift: e.shift, button: e.button, x: Math.round(e.x), y: Math.round(e.y) })); }""")
        s.page.mouse.click(pos["x"], pos["y"])
        s.page.keyboard.down("Shift")
        s.page.mouse.click(pos["x"], pos["y"])
        s.page.keyboard.up("Shift")
        s.page.mouse.click(pos["x"] + 200, pos["y"] + 200)  # empty floor
        s.page.mouse.click(pos["x"], pos["y"], button="right")
        clicks = s.js("window.clicks")
        assert len(clicks) == 3, clicks  # the right button never clicks
        assert clicks[0]["hit"] == "joint-demo" and clicks[0]["shift"] is False
        assert clicks[1]["shift"] is True
        assert clicks[2]["hit"] is None
        assert s.js("window.events.filter(e => e === 'click-unhandled').length") == 3
        # pick() with explicit targets, on a client position
        r = s.js("""() => { const vp = window.vp; const j = vp.scene.getObjectByName('joint-demo'); const p = vp.project(j.getWorldPosition(new window.THREE.Vector3())); const rc = vp.canvas.getBoundingClientRect();
          const hits = vp.pick(rc.left + p.x, rc.top + p.y, [j]); const miss = vp.pick(rc.left + p.x + 100, rc.top + p.y, [j]); const none = vp.pick(0, 0, []);
          return { hit: hits.length, name: hits[0] && hits[0].object.name, miss: miss.length, none: none.length }; }""")
        assert r == {"hit": 1, "name": "joint-demo", "miss": 0, "none": 0}, r
        assert s.errors() == [], s.errors()


def test_viewport_screenshot_includes_labels_and_respects_theme(chromium, server):
    with make_session(chromium, server, stubs=[], dark=True) as s:
        s.page.goto(f"{s.base}/__pages/viewer-basic.html?labels=1&theme=dark")
        s.page.wait_for_function("window.__ready", timeout=60000)
        s.settle(300)
        n = s.js("document.querySelectorAll('.hm-overlay .hm-label').length")
        assert n >= 3
        plain = s.js("window.vp.screenshot({ labels: false })")
        with_labels = s.js("window.vp.screenshot()")
        assert plain != with_labels, "labels are drawn into the PNG"
        assert s.js("window.vp.theme.dark") is True
        assert s.errors() == [], s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- regressions
# (defects found by the independent verifier of the viewport and shell; each test failed before its fix)
def test_escape_in_the_help_popover_returns_the_focus_to_its_button(s):
    s.open()
    s.js("document.querySelector('button[aria-label=\"Keyboard and mouse help\"]').focus()")
    s.page.keyboard.press("Enter")
    assert s.js("document.activeElement.getAttribute('role')") == "dialog", "opening moves the focus into the popover"
    s.page.keyboard.press("Escape")
    assert s.js("document.activeElement.getAttribute('aria-label')") == "Keyboard and mouse help", "closing with Escape puts it back on the button"
    s.js("document.querySelector('.hm-canvas').focus()")
    s.page.keyboard.press("?")
    assert s.js("document.activeElement.getAttribute('role')") == "dialog"
    s.page.keyboard.press("Escape")
    assert s.js("document.activeElement.getAttribute('aria-label')") == "Keyboard and mouse help"
    # the popover has a close button of its own (touch users have no Escape key)
    s.page.keyboard.press("?")
    s.page.get_by_role("button", name="Close the help").click()
    assert not s.page.locator(".hm-help").is_visible()
    assert s.js("document.activeElement.getAttribute('aria-label')") == "Keyboard and mouse help"
    assert s.errors() == [], s.errors()


@pytest.mark.parametrize("dark", [False, True])
def test_the_canvas_shows_a_focus_ring_for_keyboard_users(chromium, server, dark):
    with make_session(chromium, server, dark=dark) as s:
        s.open()
        s.js("document.querySelector('.hm-canvas').focus()")
        r = s.js("(() => { const c = document.querySelector('.hm-canvas'), cs = getComputedStyle(c); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), inline: c.style.outline, focusVisible: c.matches(':focus-visible') }; })()")
        assert r["focusVisible"] and r["style"] != "none" and r["width"] >= 2 and r["inline"] == "", r


@pytest.mark.parametrize("width,height,mobile", [(1280, 800, False), (390, 800, True)])
def test_without_webgl_every_control_stays_reachable(chromium, server, width, height, mobile):
    # the message covers the stage; the toolbars (and the Quality toggle in the status bar) must stay above it and clickable
    with make_session(chromium, server, width=width, height=height, mobile=mobile, init=[NO_WEBGL]) as s:
        s.open(wait=False)
        s.page.wait_for_selector(".hm-vp-msg", timeout=60000)
        s.settle(300)
        for sel in ("button[aria-label='Save a screenshot']", ".hm-bar-top .hm-seg button", ".hm-bar-bottom .hm-chip:not([disabled])", ".hm-quality"):
            for i in range(s.page.locator(sel).count()):
                s.page.locator(sel).nth(i).click(trial=True, timeout=3000)  # raises when another element would receive the click
        before = s.js("document.querySelector('.hm-quality').textContent")
        s.page.locator(".hm-quality").click()
        s.page.wait_for_function("(b) => document.querySelector('.hm-quality').textContent !== b", arg=before, timeout=5000)
        assert "WebGL unavailable" in s.js("document.querySelector('.hm-gl').textContent")


@pytest.mark.parametrize("width,height", [(390, 800), (320, 640)])
def test_the_quality_toggle_is_not_clipped_in_a_narrow_status_bar(chromium, server, width, height):
    with make_session(chromium, server, width=width, height=height, mobile=True) as s:
        s.open()
        q = s.page.locator(".hm-quality")
        q.scroll_into_view_if_needed()
        q.click(trial=True, timeout=3000)
        r = s.js("(() => { const b = document.querySelector('.hm-quality'), c = b.closest('.hm-stat').getBoundingClientRect(), r = b.getBoundingClientRect(); return { inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5, w: r.width, h: r.height }; })()")
        assert r["inside"], r
        assert r["h"] >= 32 and r["w"] >= 32, f"touch target {r}"
        inspector_toggle = s.js("(() => { const r = document.querySelector('.hm-inspector-x').getBoundingClientRect(); return [r.width, r.height]; })()")
        assert min(inspector_toggle) >= 32, inspector_toggle


INSPECTOR_PANEL = """
export default { id: 'posture', label: 'Posture', order: 2, mount(el, ctx) {
  const inp = document.createElement('input'); inp.type = 'range'; inp.id = 'adv-slider'; inp.min = 0; inp.max = 100; inp.value = 10;
  const num = document.createElement('input'); num.type = 'number'; num.id = 'adv-num'; const box = document.createElement('div'); box.append(inp, num);
  window.__node = box;
  inp.addEventListener('input', () => ctx.getRig().setAngles({ knee_L: [Number(inp.value)] }));
  ctx.inspector(box, { title: 'Posture details' }); el.textContent = 'x'; } };"""


def test_a_panels_inspector_content_survives_pose_events(chromium, server):
    with make_session(chromium, server, extra_routes={"**/js/human/panels/posture.js": _serve_js(INSPECTOR_PANEL)}) as s:
        s.open()
        s.page.get_by_role("tab", name="Posture").click()
        s.page.wait_for_selector("#adv-slider")
        s.js("window.__human.ctx.select({ kind: 'joint', id: 'knee_L' })")
        s.settle(200)
        s.js("window.__marks = 0; new MutationObserver((l) => { window.__marks += l.length; }).observe(document.getElementById('hm-inspector-body'), { childList: true })")
        s.page.focus("#adv-slider")
        s.page.keyboard.press("ArrowRight")
        s.page.keyboard.press("ArrowRight")
        s.settle(200)
        assert s.js("window.__human.state.rig.angles.knee_L[0]") > 10, "the slider moved the pose"
        assert s.js("document.activeElement.id") == "adv-slider", "a pose event must not blur the control being used"
        assert s.js("document.getElementById('hm-inspector-body').firstChild === window.__node")
        assert s.js("window.__marks") == 0, "the node was not re-inserted"
        s.page.focus("#adv-num")
        s.page.keyboard.type("5")
        s.js("window.__human.state.rig.setAngles({ knee_L: [12] })")
        s.settle(150)
        assert s.js("document.activeElement.id") == "adv-num"
        assert s.js("document.getElementById('hm-inspector-body').firstChild === window.__node")
        # the default inspector (no panel content) still follows the pose
        s.page.get_by_role("tab", name="Profile").click()
        s.js("window.__human.state.rig.setAngles({ knee_L: [33] })")
        s.settle(100)
        assert "33" in s.js("document.getElementById('hm-inspector-body').textContent")
        assert s.errors() == [], s.errors()


def test_a_stalled_default_profile_request_ends_in_a_notice_and_a_figure(chromium, server):
    with make_session(chromium, server, extra_routes={"**/api/v1/index.json": lambda route, request: None}) as s:  # never answered
        s.open(wait=False)
        s.page.wait_for_function("!!window.__human", timeout=60000)
        s.settle(600)
        assert s.js("window.__human.state.busy") is True, "a spinner shows while the profile loads"
        assert "Loading the profile" in s.js("document.querySelector('.hm-busy').textContent")
        assert s.js("document.querySelector('.hm-busy').hidden") is False
        s.page.wait_for_function("window.__human.state.rig", timeout=60000)  # the 8 s timeout, then the generic man is built
        notes = s.js("window.__human.state.notices.map((n) => n.text)")
        assert any("did not answer" in n and "generic man" in n for n in notes), notes
        assert s.js("window.__human.state.busy") is False
        assert [e for e in s.errors() if "ERR_" not in e] == [], s.errors()


def test_the_viewport_ignores_non_finite_camera_input(s):
    s.open()
    r = s.js("""async () => {
      const v = window.__human.viewport, T = v.camera.position.constructor, B = v.scene.constructor === undefined ? null : null;
      const V = (x, y, z) => new T(x, y, z), Box = window.__human.ctx.getRig().group.constructor === undefined ? null : null;
      const ok = () => [...v.camera.position.toArray(), ...v.controls.target.toArray()].every(Number.isFinite);
      const THREE = await import('three');
      const out = {};
      const base = v.getView();
      const box = (a, b) => new THREE.Box3(a, b);
      v.frame(box(V(NaN, 0, 0), V(1, 1, 1)), { animate: false }); out.nanBox = ok();
      v.frame(box(V(-Infinity, 0, 0), V(Infinity, 1, 1)), { animate: false }); out.infBox = ok();
      v.frame(box(V(0, 0, 0), V(1, 1, 1)), { animate: false, margin: NaN }); out.nanMargin = ok();
      await v.frame(box(V(NaN, 0, 0), V(1, 1, 1)), { animate: true }); out.nanAnimated = ok();
      v.setView('front', { distance: NaN, animate: false }); out.nanDistance = ok();
      v.setView('front', { distance: -3, animate: false }); out.negDistance = ok();
      v.moveTo(V(NaN, 1, 1), V(0, 0, 0), { animate: false }); out.nanPosition = ok();
      v.moveTo(V(1, 1, 1), V(0, Infinity, 0), { animate: false }); out.infTarget = ok();
      v.moveTo([1, 2, 3], [0, 0, 0], { animate: false }); out.arrays = ok();
      out.unmoved = v.getView().distance > 0.3;
      v.frame(box(V(0, 0, -0.3), V(0.5, 1.8, 0.3)), { animate: false }); out.stillWorks = ok() && v.getView().distance < 12;
      return out;
    }""")
    assert all(r.values()), r
    s.settle(200)
    assert s.js(PIXELS)["std"] > 4, "the view still renders after the bad input"
    assert s.errors() == [], s.errors()


def test_the_phone_layout_does_not_scroll_the_page_when_the_tab_opens_or_a_tab_is_chosen(chromium, server):
    with make_session(chromium, server, width=390, height=800, mobile=True) as s:
        s.open()
        assert s.js("window.scrollY") == 0, "the page loads at the top, with the title visible"
        s.js("document.querySelector('.hm-tab[data-tab=\"export\"]').click()")
        s.settle(250)
        assert s.js("window.scrollY") == 0, "choosing a tab does not scroll the page"
        assert s.js("document.querySelector('.hm-tab[data-tab=\"export\"]').getAttribute('aria-selected')") == "true"
        # the strip itself scrolls so that the chosen tab is visible
        r = s.js("(() => { const t = document.querySelector('.hm-tabs'), e = document.querySelector('.hm-tab[data-tab=\"export\"]').getBoundingClientRect(), c = t.getBoundingClientRect(); return [e.left >= c.left - 1, e.right <= c.right + 1, t.scrollLeft]; })()")
        assert r[0] and r[1] and r[2] > 0, r
        assert s.js("window.scrollY") == 0


def test_pinned_labels_of_a_selected_joint_do_not_overprint_each_other(s):
    s.open()
    set_display(s, skeleton=True, joints=True, labels=True)
    for joint in ("knee_L", "shoulder_L", "hip_R", "head"):
        s.js("(id) => window.__human.ctx.select({ kind: 'joint', id })", joint)
        s.settle(500)
        rects = s.js("""() => [...window.__human.viewport.overlay.querySelectorAll('.hm-label')].map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, cls: e.className, l: r.left, r: r.right, top: r.top, b: r.bottom }; })""")
        dof = [x for x in rects if "hm-label-dof" in x["cls"]]
        assert dof, f"the DOF names of {joint} are shown"
        for i, a in enumerate(rects):
            for b in rects[i + 1:]:
                overlap = a["l"] < b["r"] - 1 and a["r"] > b["l"] + 1 and a["top"] < b["b"] - 1 and a["b"] > b["top"] + 1
                assert not overlap, f"{joint}: {a['t']!r} overprints {b['t']!r}"


def test_axis_labels_have_enough_contrast_in_both_themes(chromium, server):
    for dark in (False, True):
        with make_session(chromium, server, dark=dark) as s:
            s.open()
            ratios = s.js("""() => {
              const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
              const rgb = (c) => { const p = document.createElement('span'); p.style.color = c; document.body.append(p); const v = getComputedStyle(p).color.match(/[\\d.]+/g).slice(0, 3).map(Number); p.remove(); return v; };
              const labels = [...document.querySelectorAll('.hm-label-axis')]; if (!labels.length) return null;
              const root = getComputedStyle(document.querySelector('.hm-viewport'));
              // the label sits on the floor disc (--surface) or the scene background (--surface-2): the worse of the two counts
              return labels.map((l) => { const fg = lum(rgb(getComputedStyle(l).color)); return [root.getPropertyValue('--surface'), root.getPropertyValue('--surface-2')].map((c) => { const bg = lum(rgb(c.trim())); const hi = Math.max(fg, bg), lo = Math.min(fg, bg); return (hi + 0.05) / (lo + 0.05); }); }).flat();
            }""")
            assert ratios, "axis labels are shown"
            assert min(ratios) >= 4.5, (dark, min(ratios))


def test_retry_after_a_lost_context_does_not_make_three_warn(s):
    s.open()
    s.js("window.__lose = window.__human.viewport.renderer.getContext().getExtension('WEBGL_lose_context')")
    if not s.js("!!window.__lose"):
        pytest.skip("WEBGL_lose_context is not available in this browser")
    s.js("window.__lose.loseContext()")
    s.page.wait_for_selector(".hm-vp-msg", timeout=5000)
    s.page.locator(".hm-vp-msg").get_by_role("button", name="Retry").click()
    s.page.wait_for_function("!document.querySelector('.hm-vp-msg') && document.querySelectorAll('canvas').length === 1", timeout=20000)
    s.settle(300)
    assert [l for l in s.logs if "WEBGL_lose_context" in l] == [], s.logs
    # a healthy context is still released on Retry (no leaked contexts)
    s.js("window.__human.viewport.rebuild()")
    s.settle(300)
    assert s.js("document.querySelectorAll('canvas').length") == 1


def test_the_panel_spinner_stays_until_mount_has_settled(chromium, server):
    slow = "export default { id: 'export', mount() { return new Promise(() => {}); } };"
    with make_session(chromium, server, extra_routes={"**/js/human/panels/export.js": _serve_js(slow)}) as s:
        s.open()
        s.page.get_by_role("tab", name="Export").click()
        s.settle(600)
        txt = s.js("document.querySelector('#hm-tab-panel-export').innerText")
        assert "Loading Export" in txt, txt
    done = "export default { id: 'export', mount(el) { el.textContent = 'export ready'; return new Promise((r) => setTimeout(() => r({}), 400)); } };"
    with make_session(chromium, server, extra_routes={"**/js/human/panels/export.js": _serve_js(done)}) as s:
        s.open()
        s.page.get_by_role("tab", name="Export").click()
        s.page.wait_for_function("document.querySelector('#hm-tab-panel-export').innerText.includes('export ready')", timeout=5000)
        s.page.wait_for_function("!document.querySelector('#hm-tab-panel-export .loading')", timeout=5000)
        assert s.js("document.querySelector('#hm-tab-panel-export').innerText.includes('Loading')") is False


@pytest.mark.parametrize("width", [1100, 1200, 1260])
def test_the_toolbars_leave_most_of_the_stage_to_the_figure(chromium, server, width):
    with make_session(chromium, server, width=width, height=700) as s:
        s.open()
        r = s.js("(() => { const q = (s) => document.querySelector(s).getBoundingClientRect(); return { stage: q('.hm-stage').height, w: q('.hm-stage').width, top: q('.hm-bar-top').height, bottom: q('.hm-bar-bottom').height }; })()")
        assert r["w"] >= 500, r
        assert r["top"] < 60 and r["bottom"] < 60, f"each toolbar is a single row: {r}"
        assert (r["top"] + r["bottom"]) / r["stage"] < 0.25, r


# ---------------------------------------------------------------------------------------------------------------------------------- round-2 fixes
DEBUG_FLAG = "try { localStorage.setItem('hm-debug', '1'); } catch (e) { /* no storage */ }"  # the shell sets window.__human for any hash while this is set


@pytest.mark.parametrize("hold_ms", [100, 700, 1500])
def test_a_slow_press_still_selects_a_joint(s, hold_ms):
    # regression: isClick() demanded the pointer-up within 400 ms, so a deliberate slow press (tremor, switch device, long tap) selected nothing
    s.open()
    set_display(s, joints=True)
    s.settle(300)
    p = _joint_screen(s, "knee_L")
    s.js("window.__human.ctx.select(null)")
    s.page.mouse.move(p["x"], p["y"])
    s.page.mouse.down()
    s.page.wait_for_timeout(hold_ms)
    s.page.mouse.up()
    s.settle(200)
    sel = s.js("window.__human.state.selection")
    assert sel and sel["kind"] == "joint", (hold_ms, sel)


def test_camera_move_promises_always_settle(s):
    # regression: cancelAnim() dropped the promise's resolve, so anything awaiting setView()/frame() hung when the user touched the view or a second move arrived
    s.open()
    r = s.js("""async () => {
      const v = window.__human.viewport, res = {};
      const track = (p) => { const o = { v: 'pending' }; p.then((x) => { o.v = x; }); return o; };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const a = track(v.setView('back')), b = track(v.setView('left'));            // superseded by a second move
      await wait(1200);
      res.superseded = [a.v, b.v];
      const c = track(v.setView('right')); await wait(30);
      v.canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, button: 0, clientX: 100, clientY: 100, bubbles: true }));  // the user grabs the view
      v.canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, button: 0, clientX: 100, clientY: 100, bubbles: true }));
      await wait(1200);
      res.grabbed = c.v;
      const d = track(v.setView('front')); await wait(30);
      v.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));                                                   // the wheel
      await wait(1200);
      res.wheel = d.v;
      const e = track(window.__human.ctx.frame(true)); const f = track(v.setView('top')); await wait(1200);   // frame() superseded by setView()
      res.frame = [e.v, f.v];
      const g = track(v.setView('iso', { animate: false }));                                                  // instant: arrived
      await wait(50);
      res.instant = g.v;
      const h = track(v.setView('back')); await wait(30); v.setActive(false);                                // hiding the tab jumps to the end and says so
      await wait(50);
      res.hidden = h.v; v.setActive(true);
      return res;
    }""")
    assert r["superseded"] == [False, True], r
    assert r["grabbed"] is False and r["wheel"] is False, r
    assert r["frame"] == [False, True], r
    assert r["instant"] is True and r["hidden"] is True, r


def test_the_view_can_be_zoomed_with_the_keyboard(s):
    # regression: only the wheel and a pinch zoomed (OrbitControls' keyboard mode pans and rotates); WCAG 2.1.1
    s.open()
    s.page.focus(".hm-canvas")
    s.settle_view()
    d0 = s.view()["dist"]
    for key, sign in (("+", -1), ("=", -1), ("PageUp", -1), ("-", 1), ("_", 1), ("PageDown", 1)):
        s.page.keyboard.press(key)
        s.settle_view()
        d1 = s.view()["dist"]
        assert (d1 - d0) * sign > 0.05, (key, d0, d1)
        d0 = d1
    for _ in range(40):
        s.page.keyboard.press("+")
    assert s.view()["dist"] >= 0.4 - 1e-6, "keyboard zoom respects the minimum distance"
    for _ in range(80):
        s.page.keyboard.press("-")
    s.settle_view()
    assert s.view()["dist"] <= 12 + 1e-6, "and the maximum"
    az0 = s.view()["az"]
    s.page.keyboard.press("Shift+ArrowLeft")
    s.settle_view()
    assert abs(s.view()["az"] - az0) > 1.5, "one Shift+arrow turns the view by a visible amount"
    s.js("window.__human.viewport.moveTo(window.__human.viewport.getView().position, window.__human.viewport.getView().target, { animate: false })")
    d = s.view()["dist"]
    s.page.keyboard.press("Control+Equal")  # a browser shortcut is not ours
    s.settle_view()
    assert abs(s.view()["dist"] - d) < 1e-6
    assert "plus and minus" in s.js("document.querySelector('.hm-canvas').getAttribute('aria-label')")
    s.page.get_by_role("button", name="Keyboard and mouse help").click()
    txt = s.js("document.querySelector('.hm-help').innerText")
    assert "Zoom in" in txt and "Zoom out" in txt, txt
    assert s.errors() == [], s.errors()


def test_the_wheel_scrolls_the_page_once_the_zoom_has_reached_its_limit(s):
    s.open()
    s.js("document.body.style.minHeight = '3000px'")  # make the page scrollable whatever the window
    s.js("window.__human.viewport.zoomBy(100)")
    s.settle_view()
    assert s.view()["dist"] >= 12 - 1e-6
    s.js("window.scrollTo(0, 0)")
    box = s.page.locator(".hm-canvas").bounding_box()
    s.page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 100)
    s.page.mouse.wheel(0, 400)
    s.page.wait_for_timeout(500)
    assert s.js("window.scrollY") > 0, "zoomed out as far as it goes: the wheel scrolls the page instead of being swallowed"
    s.js("window.scrollTo(0, 300)")
    s.page.mouse.move(box["x"] + box["width"] / 2, 300)
    s.page.mouse.wheel(0, -300)  # the other direction still zooms, and the page stays put
    s.settle_view()
    assert s.view()["dist"] < 12 - 0.1
    assert s.js("window.scrollY") == 300


def test_a_broken_skin_module_is_reported_and_a_missing_one_is_silent(chromium, server):
    broken = "export function buildSkin() { return null; }\nthrow new Error('skin boom');"
    with make_session(chromium, server, extra_routes={"**/js/human/body.js*": _serve_js(broken)}) as s:
        s.open()
        n = s.page.locator(".hm-notice", has_text="skin")
        assert n.count() == 1 and "skin boom" in n.inner_text(), n.all_inner_texts()
        assert any("skin generator (body.js) failed to load" in e for e in s.errors()), s.logs
        assert s.js("document.querySelector('.hm-root').dataset.hmState") == "ready", "the skeleton-only figure is still shown"
    gone = lambda route, request: route.fulfill(status=404, body="not found")  # noqa: E731
    with make_session(chromium, server, extra_routes={"**/js/human/body.js*": gone}) as s:
        s.open()
        assert s.page.locator(".hm-notice").count() == 0, "a skin generator that does not exist yet is not an error"
        assert [e for e in s.errors() if "404" not in e] == [], s.errors()
        assert s.js("document.querySelector('.hm-chip[title*=\"skin surface\"]').disabled") is True
        n404 = s.js("performance.getEntriesByType('resource').filter((e) => e.name.includes('/body.js')).length")
        s.js("window.__human.ctx.rebuild()")
        s.settle(1500)
        assert s.js("performance.getEntriesByType('resource').filter((e) => e.name.includes('/body.js')).length") == n404, "a missing skin module is asked for once, not on every rebuild"
    # a body.js that loads but whose skin builder fails inside the rig: the rig says so (skinError) and the shell shows it
    failing = "export function buildSkin() { throw new Error('mesh boom'); }"
    with make_session(chromium, server, extra_routes={"**/js/human/body.js*": _serve_js(failing)}) as s:
        s.open()
        n = s.page.locator(".hm-notice", has_text="could not be built")
        assert n.count() == 1 and "mesh boom" in n.inner_text(), s.js("document.querySelector('.hm-notices').innerText")


def test_leaving_the_tab_while_the_3d_module_loads_does_not_wait_for_it(chromium, server):
    # regression: the router awaits the init promise of the tab it leaves; a stalled three.js download froze every tab switch
    import time
    gate = {"open": False}
    def slow(route, request):
        deadline = time.time() + 10
        while not gate["open"] and time.time() < deadline:
            s.page.wait_for_timeout(100)
        route.continue_()
    with make_session(chromium, server, init=[DEBUG_FLAG], extra_routes={"**/vendor/three/three.module.min.js": slow}) as s:
        s.page.goto(f"{s.base}/#/catalog")
        s.page.wait_for_selector("#view-catalog:not([hidden])")
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_selector(".hm-root[data-hm-state=loading]")
        assert "Loading" in s.js("document.getElementById('view-human').innerText")
        t0 = time.time()
        s.page.click('a.tab[data-view="about"]')
        s.page.wait_for_selector("#view-about:not([hidden])", timeout=3000)
        assert time.time() - t0 < 3, "the About view is shown while three.js is still downloading"
        assert s.js("document.getElementById('view-human').hidden") is True
        gate["open"] = True  # the download ends while the tab is hidden: the tab is built, inactive, and starts when shown
        s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=60000)
        assert s.js("window.__human.viewport.active") is False
        s.page.evaluate("location.hash = '#/human?debug'")
        s.page.wait_for_function("window.__human.viewport.active === true && document.querySelector('.hm-root').dataset.hmState === 'ready'", timeout=20000)
        assert s.js(PIXELS)["std"] > 4
        assert s.errors() == [], s.errors()


@pytest.mark.parametrize("what", ["**/vendor/three/three.module.min.js", "**/js/human/viewport.js"])
def test_a_failed_module_load_shows_retry_and_retry_recovers(chromium, server, what):
    # the browser caches a failed module import for the life of the page, so Retry reloads the page
    gate = {"block": True}
    def handler(route, request):
        route.abort() if gate["block"] else route.continue_()
    with make_session(chromium, server, extra_routes={what: handler}) as s:
        s.page.goto(f"{s.base}/#/human?debug")
        err = s.page.locator("#view-human .notice.error")
        err.wait_for(timeout=30000)
        assert "Could not load the 3D module" in err.inner_text()
        assert s.js("document.querySelector('.hm-root').dataset.hmState") == "error"
        gate["block"] = False
        s.page.locator("#view-human button.btn").click()
        s.page.wait_for_function("window.__human && window.__human.state.rig && document.querySelector('.hm-root').dataset.hmState === 'ready'", timeout=90000)
        assert s.js("document.location.hash").startswith("#/human"), "Retry stays on the Digital human tab"


def test_a_failed_model_build_offers_retry_that_works_after_the_module_is_back(chromium, server):
    gate = {"block": True}
    def handler(route, request):
        route.abort() if gate["block"] else route.continue_()
    with make_session(chromium, server, stubs=[], extra_routes={"**/js/human/rig.js*": handler}) as s:
        s.open(wait=False)
        s.page.wait_for_function("document.querySelector('.hm-root') && document.querySelector('.hm-root').dataset.hmState === 'error'", timeout=60000)
        notices = s.page.locator(".hm-notice")
        assert notices.count() == 1, notices.all_inner_texts()  # one message, not a warning plus an error saying the same
        assert "could not be built" in notices.first.inner_text()
        gate["block"] = False
        notices.first.get_by_role("button", name="Retry").click()
        s.page.wait_for_function("window.__human.state.rig && document.querySelector('.hm-root').dataset.hmState === 'ready'", timeout=60000)
        assert s.page.locator(".hm-notice").count() == 0, "the error goes away with the successful build"
        assert s.js(PIXELS)["std"] > 4


def test_notices_do_not_move_the_stage_and_their_text_is_clean(chromium, server):
    # regression: notices were rendered above the stage, so one arriving after the first paint pushed the view and its toolbars down by 90-215 px
    with make_session(chromium, server, extra_routes={"**/api/v1/**": lambda route, request: route.abort()}) as s:
        s.open()
        n = s.page.locator(".hm-notice", has_text="Could not load the population data")
        assert n.count() == 1
        assert ".)." not in n.inner_text() and ").)" not in n.inner_text(), n.inner_text()
        top0 = s.js("document.querySelector('.hm-stage').getBoundingClientRect().top")
        bar0 = s.js("document.querySelector('.hm-bar-bottom').getBoundingClientRect().bottom")
        s.js("window.__human.ctx.notify('A second, rather long message that wraps over more than one line in a narrow stage, to be sure it does not matter.', { level: 'error', id: 'x' })")
        s.settle(200)
        assert s.js("document.querySelector('.hm-stage').getBoundingClientRect().top") == top0
        assert s.js("document.querySelector('.hm-bar-bottom').getBoundingClientRect().bottom") == bar0, "the toolbars stay where they were"
        r = s.js("""(() => { const q = (s) => document.querySelector(s).getBoundingClientRect(); const st = q('.hm-stage'), nt = q('.hm-notices'), tb = q('.hm-bar-top');
          return { inside: nt.left >= st.left && nt.right <= st.right && nt.top >= st.top && nt.bottom <= st.bottom, belowToolbar: nt.top >= tb.bottom - 1 }; })()""")
        assert r["inside"] and r["belowToolbar"], r


def test_the_bottom_toolbar_is_one_row_at_every_width(chromium, server):
    # regression: at 900 px the display toolbar wrapped to two rows over the lower part of the view
    for width in (360, 600, 900, 1000, 1280):
        with make_session(chromium, server, width=width, height=800, mobile=width < 500) as s:
            s.open()
            r = s.js("""(() => { const q = (s) => document.querySelector(s).getBoundingClientRect(); const v = q('.hm-viewport'), b = q('.hm-bar-bottom'), t = q('.hm-bar-top');
              const chips = [...document.querySelectorAll('.hm-bar-bottom .hm-chip')].map((c) => Math.round(c.getBoundingClientRect().top));
              return { rows: new Set(chips).size, topH: t.height, botH: b.height, view: v.height }; })()""")
            assert r["rows"] == 1 and r["botH"] < 60 and r["topH"] < 60, (width, r)


def test_the_tooltip_stays_inside_the_view(s):
    # regression: the hover tooltip was placed at pointer + 10 px with no edge flip and was clipped at the right edge
    s.open()
    set_display(s, joints=True)
    s.js("(() => { const v = window.__human.viewport; const t = v.controls.target.clone(); t.x -= 0.55; const d = v.camera.position.clone().sub(v.controls.target); v.moveTo(t.clone().add(d), t, { animate: false }); })()")
    s.settle(500)
    p = _joint_screen(s, "shoulder_L")
    box = s.page.locator(".hm-canvas").bounding_box()
    # park the pointer near the right edge on the joint nearest to it
    s.page.mouse.move(p["x"] - 30, p["y"])
    s.page.mouse.move(p["x"], p["y"], steps=4)
    s.settle(400)
    r = s.js("(() => { const t = document.querySelector('.hm-tip'), o = document.querySelector('.hm-overlay').getBoundingClientRect(), b = t.getBoundingClientRect(); return { hidden: t.hidden, l: b.left, r: b.right, t: b.top, b: b.bottom, ol: o.left, or: o.right, ot: o.top, ob: o.bottom, text: t.textContent }; })()")
    assert not r["hidden"], r
    assert r["l"] >= r["ol"] - 0.5 and r["r"] <= r["or"] + 0.5 and r["t"] >= r["ot"] - 0.5 and r["b"] <= r["ob"] + 0.5, r
    assert p["x"] > box["x"] + box["width"] - 260, "the test really is near the right edge"


@pytest.mark.parametrize("width,mobile", [(1280, False), (390, True)])
def test_labels_never_stick_out_of_the_view_and_axis_labels_have_a_backing(chromium, server, width, mobile):
    with make_session(chromium, server, width=width, mobile=mobile) as s:
        s.open()
        s.settle(500)
        r = s.js("""() => { const o = document.querySelector('.hm-overlay').getBoundingClientRect();
          const els = [...document.querySelectorAll('.hm-overlay .hm-label')].map((e) => { const b = e.getBoundingClientRect(); return { t: e.textContent, cls: e.className, out: b.right > o.right + 0.5 || b.left < o.left - 0.5, bg: getComputedStyle(e).backgroundColor }; });
          return els; }""")
        assert r, "labels are shown"
        assert [x["t"] for x in r if x["out"]] == [], r
        for x in r:
            if "hm-label-axis" in x["cls"]:
                assert x["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), x  # a bare 'Y' vanished against the bones
        s.page.set_viewport_size({"width": 700 if not mobile else 360, "height": 800})
        s.settle(800)
        r = s.js("""() => { const o = document.querySelector('.hm-overlay').getBoundingClientRect(); return [...document.querySelectorAll('.hm-overlay .hm-label')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > o.right + 0.5 || b.left < o.left - 0.5; }).map((e) => e.textContent); }""")
        assert r == [], r


def test_the_screenshot_draws_a_flipped_label_inside_the_image(s):
    s.open()
    s.js("(() => { const v = window.__human.viewport; const t = v.controls.target.clone(); t.x -= 1.3; const d = v.camera.position.clone().sub(v.controls.target); v.moveTo(t.clone().add(d), t, { animate: false }); })()")
    s.settle(500)
    assert s.js("document.querySelectorAll('.hm-label-flip').length") >= 1, "a label near the right edge sits to the left of its anchor"
    assert s.js("window.__human.viewport.screenshot().startsWith('data:image/png')")


def test_invalid_selections_are_refused(s):
    # regression: ctx.select({kind:'joint', id:'nope'}) put 'Selected joint / Id nope' in the inspector
    s.open()
    before = s.js("document.querySelector('.hm-inspector-body').innerText")
    for bad in ({"kind": "joint", "id": "nope"}, {"kind": "landmark", "id": "not_a_landmark"}):
        assert s.js("(sel) => window.__human.ctx.select(sel)", bad) is False
        assert s.js("window.__human.state.selection") is None
    assert s.js("document.querySelector('.hm-inspector-body').innerText") == before
    assert any("select() ignored" in l for l in s.logs if l.startswith("[warning]")), s.logs
    assert s.js("window.__human.ctx.select({ kind: 'joint', id: 'knee_L' })") is True
    assert s.js("window.__human.ctx.select({ kind: 'landmark', id: 'vertex' })") is True
    assert s.js("window.__human.ctx.select({ kind: 'object', id: 'chair-1' })") is True, "objects and handles belong to the sandbox: not checked here"


def test_a_panel_that_finishes_mounting_after_dispose_is_disposed(chromium, server):
    late = "window.__late = { disposed: 0 }; export default { id: 'export', mount() { return new Promise((r) => { window.__finish = () => r({ dispose() { window.__late.disposed++; } }); }); } };"
    with make_session(chromium, server, extra_routes={"**/js/human/panels/export.js": _serve_js(late)}) as s:
        s.open()
        s.page.get_by_role("tab", name="Export").click()
        s.page.wait_for_function("typeof window.__finish === 'function'")
        s.js("import('/js/human/index.js').then((m) => m.disposeHuman())")
        s.settle(400)
        s.js("window.__finish()")
        s.settle(300)
        assert s.js("window.__late.disposed") == 1, "the api that arrived after dispose was handed to nobody and must be freed"


def test_a_swap_that_fails_leaves_the_previous_figure_on_the_stage(s):
    # regression: the previous rig was removed from the viewport and unsubscribed before the new one was in place
    s.open()
    r = s.js("""async () => {
      const { viewport, ctx, state } = window.__human; const old = state.rig, oldBody = state.body;
      const frame = viewport.frame; viewport.frame = () => { throw new Error('framing exploded'); };   // the swap frames a figure that is clearly taller or shorter
      const p = JSON.parse(JSON.stringify(state.profile)); p.id = 'short'; p.measures.stature.value = 1500;
      let res; try { res = await ctx.setProfile(p, { immediate: true }); } finally { viewport.frame = frame; }
      const inScene = (g) => { let o = g; while (o) { if (o === viewport.scene) return true; o = o.parent; } return false; };
      return { ok: res.ok, same: state.rig === old, sameBody: state.body === oldBody, oldInScene: inScene(old.group), groups: viewport.scene.children.filter((c) => c.name === 'rig').length,
        notice: state.notices.map((n) => n.id + ':' + n.level + ':' + (n.action || '')), oldPose: typeof old.onChange === 'function' };
    }""")
    assert r["ok"] is False and r["same"] and r["sameBody"] and r["oldInScene"] and r["groups"] == 1, r
    assert any(n.startswith("build:error:retry") for n in r["notice"]), r
    s.js("window.__human.ctx.setDisplay({ joints: true })")  # still alive: the old rig keeps following the shell
    assert s.js(PIXELS)["std"] > 4


def _knee_xy(s):
    return s.js("""(() => { const V = window.__human.viewport, R = window.__human.ctx.getRig(); const b = V.canvas.getBoundingClientRect(); const p = V.project(R.jointWorld('knee_L'));
      return [b.left + p.x, b.top + p.y]; })()""")


def test_joints_and_bones_are_visible_and_pickable_with_the_skin_on(s):
    # regression: with the (opaque) skin shown, Joints / Skeleton drew nothing and a click on a joint selected nothing until X-ray was also switched on
    s.open()
    if not s.js("!!window.__human.ctx.getRig().skin"):
        pytest.skip("no skin generator: the markers are drawn over the bones anyway")
    set_display(s, skin=True, skeleton=False, joints=False, xray=False)
    xray = s.page.get_by_role("button", name="X-ray", exact=True)
    assert xray.get_attribute("aria-pressed") == "false" and xray.is_enabled()
    s.page.get_by_role("button", name="Joints", exact=True).click()
    s.settle(400)
    assert xray.get_attribute("aria-pressed") == "true" and xray.is_disabled(), "the skin is see-through while the markers are shown, and the chip says why"
    assert "markers" in (xray.get_attribute("title") or "")
    assert s.js("window.__human.state.display.xray") is False, "the user's own X-ray choice is untouched"
    assert s.js("window.__human.ctx.getRig().display.xray") is True
    x, y = _knee_xy(s)
    s.page.mouse.move(x, y)
    s.settle(300)
    assert s.js("!document.querySelector('.hm-tip').hidden") is True, "hovering a marker names it"
    s.page.mouse.click(x, y)
    s.settle(300)
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "knee_L"}
    s.page.get_by_role("button", name="Joints", exact=True).click()  # off again: the skin is opaque again and the chip is free
    s.settle(300)
    assert xray.get_attribute("aria-pressed") == "false" and xray.is_enabled()
    assert s.js("window.__human.ctx.getRig().display.xray") is False
    s.js("window.__human.ctx.select(null)")
    s.page.locator(".hm-bar-bottom").get_by_role("button", name="Skeleton", exact=True).click()  # the bones alone have the same effect
    s.settle(300)
    assert xray.get_attribute("aria-pressed") == "true" and xray.is_disabled()
    assert json.loads(s.js("localStorage.getItem('hm-prefs')"))["display"]["xray"] is False, "the implied X-ray is not saved as a preference"
    assert s.errors() == [], s.errors()


def test_the_display_flags_switched_on_by_the_shell_are_not_saved(chromium, server):
    # regression: without a skin the shell shows bones and markers by itself; the first later toggle of any other option saved them as preferences
    gone = lambda route, request: route.fulfill(status=404, body="not found")  # noqa: E731
    with make_session(chromium, server, extra_routes={"**/js/human/body.js*": gone}) as s:
        s.open()
        assert s.js("window.__human.state.display.skeleton && window.__human.state.display.joints"), "no skin: bones and markers are on"
        s.page.get_by_role("button", name="Landmarks", exact=True).click()
        saved = json.loads(s.js("localStorage.getItem('hm-prefs')"))["display"]
        assert saved["landmarks"] is True and saved["skeleton"] is False and saved["joints"] is False, saved
        s.page.locator(".hm-bar-bottom").get_by_role("button", name="Skeleton", exact=True).click()  # the user switches the bones off, then on: theirs now
        s.page.locator(".hm-bar-bottom").get_by_role("button", name="Skeleton", exact=True).click()
        saved = json.loads(s.js("localStorage.getItem('hm-prefs')"))["display"]
        assert saved["skeleton"] is True and saved["joints"] is False, saved


def test_a_stylesheet_that_failed_to_load_is_asked_for_again(chromium, server):
    # regression: the failed request was remembered for the whole session, the tab stayed unstyled even after the network was back and said nothing
    gate = {"block": True}
    def handler(route, request):
        route.abort() if gate["block"] else route.continue_()
    with make_session(chromium, server, extra_routes={"**/human.css": handler}) as s:
        s.open()
        n = s.page.locator(".hm-notice", has_text="styles")
        assert n.count() == 1, s.js("document.querySelector('.hm-notices').innerText")
        assert s.js("getComputedStyle(document.querySelector('.hm-app')).display") == "block", "unstyled while the file is missing"
        s.page.get_by_role("button", name="Retry").click()  # still down: the message stays
        s.settle(600)
        assert s.page.locator(".hm-notice", has_text="styles").count() == 1
        gate["block"] = False
        s.page.get_by_role("button", name="Retry").click()
        s.page.wait_for_function("getComputedStyle(document.querySelector('.hm-app')).display === 'grid'", timeout=10000)
        assert s.page.locator(".hm-notice", has_text="styles").count() == 0
        assert s.js("document.querySelectorAll('link[data-hm-css]').length") == 1, "the dead link was replaced, not piled up"
        gate["block"] = True  # and the other way: it comes back by itself when the tab is shown again
    with make_session(chromium, server, extra_routes={"**/human.css": handler}) as s:
        gate["block"] = True
        s.open()
        assert s.page.locator(".hm-notice", has_text="styles").count() == 1
        gate["block"] = False
        s.js("location.hash = '#/about'")
        s.settle(300)
        s.js("location.hash = '#/human?debug'")
        s.page.wait_for_function("getComputedStyle(document.querySelector('.hm-app')).display === 'grid'", timeout=10000)
        assert s.page.locator(".hm-notice", has_text="styles").count() == 0


@pytest.mark.parametrize("width", [900, 390])
def test_the_toolbar_fade_only_appears_where_a_button_is_cut_off(chromium, server, width):
    # regression: the stacked toolbars were always faded at their right end, so the last button (Help) looked disabled even when everything fit
    with make_session(chromium, server, width=width, height=800, mobile=width < 500) as s:
        s.open()
        s.settle(500)
        r = s.js("""[...document.querySelectorAll('.hm-bar')].map((b) => { const m = getComputedStyle(b).maskImage; return { cut: b.scrollWidth - b.clientWidth > 1, more: b.dataset.more || null, masked: !!m && m !== 'none' }; })""")
        for bar in r:
            assert bar["masked"] == bar["cut"] and (bar["more"] == "end") == bar["cut"], (width, r)
        if width == 390:
            assert all(bar["cut"] for bar in r), "a phone cannot show all buttons at once"
            s.js("(() => { const b = document.querySelector('.hm-bar-top'); b.scrollLeft = b.scrollWidth; })()")
            s.settle(200)
            assert s.js("document.querySelector('.hm-bar-top').dataset.more || null") is None, "scrolled to the end: nothing is hidden any more"
        else:
            top = s.js("document.querySelector('.hm-bar-top').dataset.more || null")
            assert top is None, "the top toolbar fits at 900 px: no fade on the Help button"


if __name__ == "__main__":  # run without pytest being on the path of the caller
    sys.exit(pytest.main([__file__, "-q", *sys.argv[1:]]))
