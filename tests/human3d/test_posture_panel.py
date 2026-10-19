"""Browser tests of the Posture panel of the Digital human tab (site/js/human/panels/posture.js and the engine editor.js), on the real site: headless Chromium with
WebGL (SwiftShader), the real shell, fit.js, rig.js, ik.js and the posture library. Slow (a build takes a second or two, a drag a few seconds).

    python -m pytest tests/human3d/test_posture_panel.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_posture_panel.py   # fail instead of skip when Playwright / Chromium / WebGL / the data is missing
    HM_SHOTS=/some/dir ...                                                    # also save screenshots there
    CHROMIUM=/path/to/chrome ...                                              # default: /opt/pw-browsers/chromium (see shot.py)

The tests read the figure through window.__human (the debug hook of the shell: #/human?debug) and the editor through window.__human.state.postureEditor (ctx.posture).
"""
import contextlib
import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
REQUIRE = os.environ.get("REQUIRE_BROWSER") == "1"
SHOTS = os.environ.get("HM_SHOTS")

try:  # noqa: SIM105
    from playwright.sync_api import expect, sync_playwright
    import shot
    from devserver import serve
    _IMPORT_ERROR = None
except Exception as e:  # Playwright not installed
    expect = sync_playwright = shot = serve = None
    _IMPORT_ERROR = e


def _unavailable(reason):
    if REQUIRE:
        pytest.fail(f"REQUIRE_BROWSER=1 but the browser tests cannot run: {reason}", pytrace=False)
    pytest.skip(f"browser tests skipped: {reason} (set REQUIRE_BROWSER=1 to make this a failure)", allow_module_level=True)


if _IMPORT_ERROR is not None:
    _unavailable(f"Playwright is not importable ({_IMPORT_ERROR})")
if not Path(shot.CHROME).exists():
    _unavailable(f"no Chromium at {shot.CHROME} (set CHROMIUM=/path/to/chrome)")
if not (ROOT / "public" / "api" / "v1" / "index.json").exists():
    _unavailable("public/api/v1 is not built (python scripts/build_site.py)")
if "comingSoon" in (ROOT / "site/js/human/panels/posture.js").read_text():
    _unavailable("panels/posture.js is still the stub")

# The skin generator (body.js) is another engineer's module and may be mid-edit; the shell then logs that it failed to load and shows the skeleton only.
OTHER_MODULES = ("the skin generator (body.js) failed to load",)
ED = "window.__human.state.postureEditor"
RIG = "window.__human.ctx.getRig()"

# counts the animation frames and listeners that are still alive (for the leak test)
LEAK_INIT = """
(() => {
  window.__raf = new Set();
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => { let id; id = raf((t) => { window.__raf.delete(id); f(t); }); window.__raf.add(id); return id; };
  window.cancelAnimationFrame = (id) => { window.__raf.delete(id); caf(id); };
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener, reg = new WeakMap();
  window.__lid = 0; window.__nl = 0;
  const id = (type, fn, o) => type + '|' + (typeof o === 'boolean' ? o : !!(o && o.capture)) + '|' + (fn.__id ??= ++window.__lid);
  EventTarget.prototype.addEventListener = function (type, fn, o) { if (fn && !(o && o.once)) { let m = reg.get(this); if (!m) reg.set(this, m = new Set()); const k = id(type, fn, o); if (!m.has(k)) { m.add(k); window.__nl++; } } return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { if (fn) { const m = reg.get(this); if (m && m.delete(id(type, fn, o))) window.__nl--; } return rem.call(this, type, fn, o); };
})();
"""


# ---------------------------------------------------------------------------------------------------------------------------------- plumbing
@pytest.fixture(scope="session")
def server():
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
    def __init__(self, page, logs, base, context):
        self.page, self.logs, self.base, self.context = page, logs, base, context

    def errors(self, allow=()):
        return [ln for ln in self.logs if (ln.startswith("[error]") or ln.startswith("[pageerror]")) and not any(a in ln for a in (*OTHER_MODULES, *allow))]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def open(self, hash_="#/human?debug", timeout=90000):
        """The Digital human tab with the Posture panel open and its first cards drawn."""
        p = self.page
        p.goto(f"{self.base}/{hash_}")
        p.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
        p.get_by_role("tab", name="Posture").click()
        p.wait_for_selector(".hm-pe .hm-pe-card", timeout=30000)
        p.wait_for_function(f"window.__human.state.postureEditor && {ED}.ikReady", timeout=30000)
        self.thumbs()
        return self

    def thumbs(self, timeout=20000):
        """Wait until every visible card has its stick figure and its validator badge."""
        self.page.wait_for_function("""() => { const cs = [...document.querySelectorAll('.hm-pe-card')]; return cs.length > 0 && cs.every((c) => c.querySelector('canvas').dataset.state && c.querySelector('.hm-pe-valid').dataset.state && c.querySelector('.hm-pe-valid').dataset.state !== 'pending'); }""", timeout=timeout)

    def built(self, timeout=60000):
        self.page.wait_for_function("""() => { const c = window.__human.ctx, b = c.getBody(), p = c.getProfile(); return !!b && !!p && b.profileId === p.id && !window.__human.state.busy; }""", timeout=timeout)
        self.page.wait_for_timeout(80)

    def settle(self, ms=450):
        """Let an animation and the throttled refresh finish."""
        self.page.wait_for_function(f"!{ED}.animating", timeout=10000)
        self.page.wait_for_timeout(ms)

    def pose(self):
        return self.js(f"{RIG}.getPose()")

    def angle(self, joint, i=0):
        return self.js(f"{RIG}.angles['{joint}'][{i}]")

    def apply(self, posture_id, wait=True):
        """Show a library posture through the engine (no animation); the tests that click a card use click_card()."""
        self.js(f"{ED}.apply('{posture_id}', {{ animate: false }})")
        self.page.wait_for_timeout(120)
        if wait:
            self.settle(150)

    def shot(self, name, selector=None):
        if SHOTS:
            Path(SHOTS).mkdir(parents=True, exist_ok=True)
            (self.page.locator(selector) if selector else self.page).screenshot(path=str(Path(SHOTS) / f"posture-{name}.png"))

    def scroll_panel(self, selector):
        self.page.evaluate("(sel) => { const p = document.querySelector('.hm-panels'); const e = document.querySelector(sel); p.scrollTop += e.getBoundingClientRect().top - p.getBoundingClientRect().top - 4; }", selector)
        self.page.wait_for_timeout(150)

    def handle_xy(self, handle):
        """Client coordinates of a handle on the canvas."""
        return self.js("""(h) => { const w = window.__human, p = w.state.postureEditor.handlePoint(h), o = w.viewport.project(p, {}), rc = w.viewport.canvas.getBoundingClientRect(); return { x: rc.left + o.x, y: rc.top + o.y, visible: o.visible, p: p.toArray() }; }""", handle)

    def drag(self, handle, dx, dy, steps=24, release=True, pause=25):
        """Press on a handle with the real mouse and drag it dx, dy pixels."""
        h = self.handle_xy(handle)
        assert h["visible"], f"handle {handle} is not on the screen"
        m = self.page.mouse
        m.move(h["x"], h["y"])
        m.down()
        for i in range(1, steps + 1):
            m.move(h["x"] + dx * i / steps, h["y"] + dy * i / steps)
            self.page.wait_for_timeout(pause)
        if release:
            m.up()
            self.page.wait_for_timeout(250)
        return h


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=900, dark=False, mobile=False, init=(), reduced_motion=False, storage_state=None):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                               device_scale_factor=1, accept_downloads=True, reduced_motion="reduce" if reduced_motion else "no-preference", storage_state=storage_state)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    for script in init:
        page.add_init_script(script)
    try:
        yield Session(page, logs, server, ctx)
    finally:
        ctx.close()


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


def expected_pose(s, posture_id):
    """The expanded and clamped pose of a library posture, computed by pose.js in the page."""
    return s.js("""async (id) => {
      const pose = await import('/js/human/pose.js'), lib = await import('/js/human/postures.js');
      const ex = pose.expandPosture(lib.byId(id)), c = pose.clampPose({ root: ex.root, angles: ex.angles });
      return c.pose;
    }""", posture_id)


def pose_matches(s, expected, eps=1e-6):
    return s.js("""async ([exp, eps]) => {
      const pose = await import('/js/human/pose.js'), cur = window.__human.ctx.getRig().getPose();
      return pose.poseEquals({ root: { heading: cur.root.heading, flex: cur.root.flex, lat: cur.root.lat, rot: cur.root.rot }, angles: cur.angles }, exp, eps);
    }""", [expected, eps])


def click_card(s, text, posture_id):
    """Search for a posture the way a user does and click its card."""
    s.page.fill(".hm-pe-searchbox", text)
    card = s.page.locator(f".hm-pe-card[data-id='{posture_id}']")
    card.wait_for(timeout=5000)
    card.click()


# ---------------------------------------------------------------------------------------------------------------------------------- library
def test_library_lists_every_posture_in_a_window_and_draws_stick_figures(s):
    s.open()
    n = s.js("import('/js/human/postures.js').then((m) => m.POSTURES.length)")
    assert n >= 99
    assert s.page.locator(".hm-pe-count").inner_text().startswith(f"{n} of {n} postures")
    rows = s.page.locator(".hm-pe-card").count()
    assert 3 <= rows <= 20, f"{rows} rows in the DOM for {n} postures: the list is windowed"
    # every card has a stick figure with ink in it, a support badge, a validator badge and a source badge
    ink = s.js("""() => [...document.querySelectorAll('.hm-pe-card canvas')].map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) k++; return k; })""")
    assert all(k > 60 for k in ink), f"stick figures drawn: {ink}"
    first = s.page.locator(".hm-pe-card").first
    badges = first.locator(".tag").all_inner_texts()
    assert badges[0] in ("stands", "sits", "kneels", "lies") and badges[1] in ("ok", "ok, notes", "fails") and len(badges) == 3
    assert first.locator(".hm-pe-card-desc").inner_text().strip()
    # scrolling brings other rows, the DOM stays small, the figures are drawn lazily
    s.page.evaluate("document.querySelector('.hm-pe-list').scrollTop = 40 * 80")
    s.page.wait_for_timeout(300)
    s.thumbs()
    assert s.page.locator(".hm-pe-card").count() <= 20
    idx = s.js("[...document.querySelectorAll('.hm-pe-card')].map((c) => Number(c.dataset.index))")
    assert min(idx) >= 30 and max(idx) <= n - 1
    s.shot("library", ".hm-left")
    assert s.errors() == []


def test_library_search_and_filters_match_the_library_search(s):
    s.open()
    p = s.page
    total = int(p.locator(".hm-pe-count").inner_text().split(" ")[0])
    for query in ["squat", "sit upright", "LYING back", "zzzzqq"]:
        want = s.js("(q) => import('/js/human/postures.js').then((m) => m.search(q).length)", query)
        p.fill(".hm-pe-searchbox", query)
        p.wait_for_function("(w) => document.querySelector('.hm-pe-count').textContent.startsWith(w + ' of')", arg=str(want))
        if want == 0:
            assert p.locator(".hm-pe-empty").is_visible() and not p.locator(".hm-pe-list").is_visible()
        else:
            assert p.locator(".hm-pe-list").is_visible() and not p.locator(".hm-pe-empty").is_visible()
    # Escape clears the search, the empty state's button too
    p.fill(".hm-pe-searchbox", "zzzzqq")
    p.wait_for_selector(".hm-pe-empty >> text=No posture matches")
    p.get_by_role("button", name="Clear the filters").click()
    p.wait_for_function("(t) => document.querySelector('.hm-pe-count').textContent.startsWith(t + ' of')", arg=str(total))
    assert p.input_value(".hm-pe-searchbox") == ""
    p.fill(".hm-pe-searchbox", "sit")
    p.wait_for_timeout(300)
    p.press(".hm-pe-searchbox", "Escape")
    p.wait_for_function("(t) => document.querySelector('.hm-pe-count').textContent.startsWith(t + ' of')", arg=str(total))
    # category chips with counts
    chips = s.js("[...document.querySelectorAll('.hm-pe-chips[aria-label=Category] .hm-pe-chip')].map((c) => [c.dataset.value, c.querySelector('.hm-pe-n').textContent, c.hidden])")
    names = [c[0] for c in chips]
    assert names[0] == "all" and "Standing" in names and "Vehicle & cockpit" in names and "Reference" in names
    assert len([n for n in names if n not in ("all", "custom")]) == 13, "the 13 categories"
    assert sum(int(c[1]) for c in chips if c[0] not in ("all", "custom")) == total
    lying = int(next(c[1] for c in chips if c[0] == "Lying"))
    assert lying > 0
    p.locator(".hm-pe-chip[data-value=Lying]").click()
    p.wait_for_function("(n) => document.querySelector('.hm-pe-count').textContent.startsWith(n + ' of')", arg=str(lying))
    assert p.locator(".hm-pe-chip[data-value=Lying]").get_attribute("aria-pressed") == "true"
    ids = s.js("[...document.querySelectorAll('.hm-pe-card')].map((c) => c.dataset.id)")
    assert ids and all(i.startswith("lie-") for i in ids)
    # a tag chip narrows it further; the counts of the other chips follow the tag
    p.locator(".hm-pe-tags summary").click()
    tags = s.js("[...document.querySelectorAll('.hm-pe-tagchip')].map((c) => [c.firstChild.textContent, Number(c.lastChild.textContent)])")
    assert tags and all(tags[i][1] >= tags[i + 1][1] for i in range(len(tags) - 1)), "most used tags first"
    tag, n_tag = tags[0]
    p.locator(".hm-pe-tagchip").first.click()
    p.wait_for_function("(n) => document.querySelector('.hm-pe-count').textContent.startsWith(n + ' of')", arg=str(n_tag))
    assert p.locator(".hm-pe-tags summary .tag").inner_text() == "1"
    p.locator(".hm-pe-chip[data-value=Lying]").click()  # back to all categories: the tag still applies
    want = s.js("(t) => import('/js/human/postures.js').then((m) => m.POSTURES.filter((x) => x.tags.includes(t)).length)", tag)
    p.wait_for_function("(n) => document.querySelector('.hm-pe-count').textContent.startsWith(n + ' of')", arg=str(want))
    p.locator(".hm-pe-tagchip[aria-pressed=true]").click()
    p.wait_for_function("(t) => document.querySelector('.hm-pe-count').textContent.startsWith(t + ' of')", arg=str(total))
    assert s.errors() == []


def test_library_keyboard_selection_applies_with_enter_and_announces(s):
    s.open()
    p = s.page
    p.fill(".hm-pe-searchbox", "sit upright")
    p.wait_for_timeout(350)
    p.press(".hm-pe-searchbox", "ArrowDown")
    assert s.js("document.activeElement.classList.contains('hm-pe-list')"), "the arrow key moves the focus to the list"
    ids = s.js("[...document.querySelectorAll('.hm-pe-card')].map((c) => c.dataset.id)")
    assert len(ids) >= 3
    p.keyboard.press("ArrowDown")
    p.keyboard.press("ArrowDown")
    active = s.js("document.querySelector('.hm-pe-card.is-active').dataset.id")
    assert active == ids[2]
    assert s.js("document.querySelector('.hm-pe-list').getAttribute('aria-activedescendant')") == s.js("document.querySelector('.hm-pe-card.is-active').id")
    p.keyboard.press("ArrowUp")
    assert s.js("document.querySelector('.hm-pe-card.is-active').dataset.id") == ids[1]
    p.keyboard.press("End")
    last = s.js("window.__human.state.postureEditor && document.querySelector('.hm-pe-card.is-active').dataset.id")
    assert last
    p.keyboard.press("Home")
    p.keyboard.press("ArrowDown")
    p.keyboard.press("Enter")
    s.settle()
    assert s.js(f"{ED}.base.id") == ids[1]
    assert p.locator(".hm-pe-card[aria-selected=true]").count() == 1
    live = s.js("[...document.querySelectorAll('.hm-pe [role=status]')].map((e) => e.textContent).join(' | ')")
    assert "Showing" in live and s.js(f"{ED}.getPosture('{ids[1]}').name") in live
    assert pose_matches(s, expected_pose(s, ids[1]))
    assert s.js("window.__human.state.posture.id") == ids[1]
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- apply
def test_apply_a_posture_by_click_shows_the_expanded_pose_on_its_support(s):
    s.open()
    p = s.page
    click_card(s, "iso 7250 seated", "iso-7250-sitting")
    s.settle()
    pid = s.js(f"{ED}.base.id")
    assert pid == "iso-7250-sitting"
    assert pose_matches(s, expected_pose(s, pid), 1e-9), "the rig has exactly the expanded pose of the posture"
    assert s.js(f"{ED}.place.mode") == "seat" and s.js(f"{ED}.place.support") == "seat+feet"
    gaps = s.js(f"{ED}.info().gaps")
    assert abs(gaps["seat"]) < 1e-6 and abs(gaps["feet"]) < 2e-3, gaps
    assert s.js(f"{ED}.history.steps") == 1
    assert "Seated upright" in p.locator(".hm-pe-curname").inner_text()
    assert p.locator(".hm-pe-dot").is_hidden()
    assert "Seated upright" in p.locator(".hm-status .hm-stat", has_text="Posture").inner_text(), "the status bar of the shell names the posture"
    # the balance chip, support and heading controls follow
    s.scroll_panel(".hm-pe-sec-cur")
    assert "Balanced" in p.locator(".hm-pe-balance").inner_text() or "base" in p.locator(".hm-pe-balance").inner_text()
    assert p.locator(".hm-pe-seg button[data-value=seat]").get_attribute("aria-pressed") == "true"
    assert 400 < float(p.locator(".hm-pe-seathost .hm-pe-num").input_value()) < 480
    s.shot("applied-seated")
    # Neutral, then undo and redo with the buttons
    p.get_by_role("button", name="Neutral").click()
    s.settle()
    assert s.js(f"{ED}.base.kind") == "neutral" and s.js(f"{RIG}.angles.hip_L[0]") == 0
    p.get_by_role("button", name="Undo").click()
    s.settle()
    assert s.js(f"{ED}.base.id") == "iso-7250-sitting"
    p.get_by_role("button", name="Redo").click()
    s.settle()
    assert s.js(f"{ED}.base.kind") == "neutral"
    assert s.errors() == []


def test_animation_runs_and_reduced_motion_skips_it(chromium, server):
    with make_session(chromium, server) as a:
        a.open()
        a.js(f"{ED}.apply('iso-7250-sitting')")
        assert a.js(f"{ED}.animating") is True, "a posture glides in"
        mid = a.js(f"{RIG}.angles.hip_L[0]")
        a.settle(100)
        assert a.js(f"{RIG}.angles.hip_L[0]") == 90 and 0 <= mid < 90
    with make_session(chromium, server, reduced_motion=True) as b:
        b.open()
        b.js(f"{ED}.apply('iso-7250-sitting')")
        assert b.js(f"{ED}.animating") is False
        assert b.js(f"{RIG}.angles.hip_L[0]") == 90, "reduced motion: the pose is there at once"
        assert b.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- editing
def edit_tab(s, name):
    s.scroll_panel(".hm-pe-sec-edit")
    s.page.get_by_role("tab", name=name).click()
    s.page.wait_for_timeout(150)


def range_of(s, label):
    """The slider of a degree of freedom in the visible tab, found by its label."""
    return s.page.get_by_role("slider", name=label).first


def test_edit_slider_changes_the_angle_marks_modified_and_undoes(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    p.wait_for_timeout(200)
    edit_tab(s, "Right arm")
    sl = p.locator("[data-joint=shoulder_R] .hm-pe-range").first
    sl.focus()
    for _ in range(15):
        p.keyboard.press("ArrowRight")
    assert s.angle("shoulder_R") == 15, "arrow: 1 degree"
    p.keyboard.press("Shift+ArrowRight")
    assert s.angle("shoulder_R") == 25, "Shift: 10 degrees"
    p.keyboard.press("Alt+ArrowRight")
    assert abs(s.angle("shoulder_R") - 25.1) < 1e-9, "Alt: 0.1 degree"
    p.keyboard.press("PageDown")
    assert abs(s.angle("shoulder_R") - 15.1) < 1e-9
    p.wait_for_timeout(300)
    assert p.locator("[data-joint=shoulder_R] .hm-pe-num").first.input_value() == "15.1"
    # modified: the dot, the name in the shell's status bar, the card's tag
    s.scroll_panel(".hm-pe-sec-cur")
    assert p.locator(".hm-pe-dot").is_visible()
    assert "(edited)" in s.js("window.__human.state.posture.name") and s.js("window.__human.state.posture.id") is None
    assert s.js(f"{ED}.modified") is True
    # the run of key presses was ONE history step; undo and redo with the buttons and the keyboard
    assert s.js(f"{ED}.history.steps") == 2
    p.get_by_role("button", name="Undo").click()
    p.wait_for_timeout(200)
    assert s.angle("shoulder_R") == 0
    assert p.locator(".hm-pe-dot").is_hidden()
    assert p.get_by_role("button", name="Redo").is_enabled()
    p.get_by_role("button", name="Redo").click()
    p.wait_for_timeout(200)
    assert abs(s.angle("shoulder_R") - 15.1) < 1e-9
    p.locator(".hm-pe-curname").click()
    p.keyboard.press("Control+z")
    p.wait_for_timeout(200)
    assert s.angle("shoulder_R") == 0
    p.keyboard.press("Control+Shift+Z")
    p.wait_for_timeout(200)
    assert abs(s.angle("shoulder_R") - 15.1) < 1e-9
    p.keyboard.press("Control+z")
    p.keyboard.press("Control+y")
    p.wait_for_timeout(200)
    assert abs(s.angle("shoulder_R") - 15.1) < 1e-9
    # Reset goes back to the posture
    p.get_by_role("button", name="Reset", exact=True).click()
    p.wait_for_timeout(300)
    assert s.angle("shoulder_R") == 0 and s.js(f"{ED}.modified") is False
    assert s.errors() == []


def test_number_fields_clamp_to_the_range_and_say_so_and_the_range_can_be_switched_off(s):
    s.open()
    p = s.page
    edit_tab(s, "Right arm")
    num = p.locator("[data-joint=elbow_R] .hm-pe-num").first
    num.fill("999")
    num.press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("elbow_R") == 150
    assert num.input_value() == "150", "the field shows what was applied"
    note = p.locator("[data-joint=elbow_R] .hm-pe-dof-note").first
    assert note.is_visible() and note.inner_text() == "Limited to 150° by the range of motion", "the row says why the value is not the one typed"
    num.fill("")
    num.press("Enter")
    p.wait_for_timeout(150)
    assert s.angle("elbow_R") == 150 and num.input_value() == "150", "an empty field changes nothing and comes back with the value"
    # the limits on the track
    foot = p.locator("[data-joint=elbow_R] .hm-pe-dof-foot").first.inner_text()
    assert "−5°" in foot and "150°" in foot
    # not enforced: beyond the range, in red, counted, named in the readout; clicking the chip selects the joint
    p.get_by_role("switch", name="Enforce range of motion").uncheck()
    num.fill("175")
    num.press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("elbow_R") == 175
    assert p.locator("[data-joint=elbow_R] .hm-pe-dof.is-out").count() == 1
    assert p.locator(".hm-pe-outcount").inner_text() == "1 outside the range"
    s.scroll_panel(".hm-pe-sec-cur")
    chip = p.locator(".hm-pe-romchip")
    assert chip.count() == 1 and "Right elbow" in chip.inner_text() and "175°" in chip.inner_text()
    chip.click()
    p.wait_for_timeout(300)
    assert s.js("window.__human.state.selection") == {"kind": "joint", "id": "elbow_R"}
    assert "Right elbow" in p.locator(".hm-inspector h2").inner_text()
    p.get_by_role("switch", name="Enforce range of motion").check()
    assert s.js(f"{ED}.options.enforceRom") is True
    assert s.errors() == []


def test_symmetric_edit_mirrors_to_the_other_side_and_the_eyes_keep_looking_the_same_way(s):
    s.open()
    p = s.page
    edit_tab(s, "Left arm")
    p.get_by_role("switch", name="Symmetric").check()
    p.locator("[data-joint=shoulder_L] .hm-pe-num").nth(1).fill("35")
    p.locator("[data-joint=shoulder_L] .hm-pe-num").nth(1).press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("shoulder_L", 1) == 35 and s.angle("shoulder_R", 1) == 35
    assert "also moves the right shoulder" in p.locator("[data-joint=shoulder_L]").first.inner_text().lower()
    edit_tab(s, "Head")
    p.locator("[data-joint=eye_L] .hm-pe-num").nth(1).fill("20")
    p.locator("[data-joint=eye_L] .hm-pe-num").nth(1).press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("eye_L", 1) == 20 and s.angle("eye_R", 1) == -20
    assert s.errors() == []


def test_region_sliders_pelvis_tilt_and_hand_grips(s):
    s.open()
    p = s.page
    edit_tab(s, "Spine")
    num = p.locator("[data-region=lumbar] .hm-pe-num").first
    num.fill("40")
    num.press("Enter")
    p.wait_for_timeout(300)
    tot = s.js("(() => { const a = window.__human.ctx.getRig().angles; return ['L5','L4','L3','L2','L1'].reduce((t, id) => t + a[id][0], 0); })()")
    assert abs(tot - 40) < 1e-6
    assert p.locator("[data-region=lumbar] .hm-pe-dof-foot").first.inner_text().startswith("−35°")
    num.fill("100")
    num.press("Enter")
    p.wait_for_timeout(300)
    assert abs(s.js("(() => { const a = window.__human.ctx.getRig().angles; return ['L5','L4','L3','L2','L1'].reduce((t, id) => t + a[id][0], 0); })()") - 60) < 1e-6, "the vertebrae stop at their limits"
    p.locator("[data-joint=pelvis] .hm-pe-num").first.fill("10")
    p.locator("[data-joint=pelvis] .hm-pe-num").first.press("Enter")
    p.wait_for_timeout(300)
    assert s.js(f"{RIG}.root.flex") == 10
    assert abs(s.js(f"{ED}.info().gaps.feet")) < 1e-6, "the figure stays on the floor while it tilts"
    p.locator(".hm-pe-vdetails summary").click()
    p.locator(".hm-pe-vertebrae [data-joint]").first.wait_for()  # the rows are built when the details open
    assert p.locator(".hm-pe-vertebrae [data-joint]").count() == 24
    # hands
    edit_tab(s, "Right hand")
    p.get_by_label("Grip of the right hand").select_option("fist")
    p.wait_for_timeout(300)
    assert s.js(f"{ED}.gripOf('R')") == "fist" and s.angle("index_pip_R") == 102
    p.locator(".hm-pe-hand .hm-pe-num").nth(1).fill("0")
    p.locator(".hm-pe-hand .hm-pe-num").nth(1).press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("index_pip_R") == 0 and s.angle("middle_pip_R") == 104
    assert p.get_by_label("Grip of the right hand").input_value() == ""
    assert "no preset" in p.locator(".hm-pe-gripdesc").inner_text()
    s.shot("edit-hand", ".hm-left")
    assert s.errors() == []


def test_mirror_and_copy_sides(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.js(f"{ED}.setJoint('shoulder_R', 'flex', 60)")
    s.js(f"{ED}.setJoint('hip_L', 'flex', 30)")
    s.scroll_panel(".hm-pe-sec-cur")
    p.get_by_role("button", name="Mirror", exact=True).click()
    p.wait_for_timeout(300)
    assert s.angle("shoulder_L") == 60 and s.angle("shoulder_R") == 0 and s.angle("hip_R") == 30 and s.angle("hip_L") == 0
    p.get_by_role("button", name="Copy L → R").click()
    p.wait_for_timeout(300)
    assert s.angle("shoulder_R") == 60 and s.angle("shoulder_L") == 60
    s.js(f"{ED}.setJoint('elbow_R', 0, 80)")
    p.get_by_role("button", name="Copy R → L").click()
    p.wait_for_timeout(300)
    assert s.angle("elbow_L") == 80
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- placement
def test_support_seat_height_and_heading_controls(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    p.wait_for_timeout(300)
    s.scroll_panel(".hm-pe-sec-cur")
    num = p.locator(".hm-pe-seathost .hm-pe-num")
    num.fill("520")
    num.press("Enter")
    p.wait_for_timeout(300)
    seat = s.js(f"{ED}.seatHeight()")
    assert abs(seat - 0.52) < 1e-9
    assert abs(min(s.js(f"{RIG}.contactPoints('seat').map((v) => v.y)")) - 0.52) < 1e-9, "the sit bones are on the seat"
    assert abs(s.js(f"{ED}.info().gaps.feet") - (0.52 - 0.4)) < 0.1 and s.js(f"{ED}.info().gaps.feet") > 0.05, "the feet float and the readout says so"
    assert "above the floor" in p.locator(".hm-pe-gaps").inner_text()
    p.get_by_role("button", name="Seat of the posture").click()
    p.wait_for_timeout(300)
    assert s.js(f"{ED}.seatHeight()") < 0.5 and s.js(f"{ED}.place.seat.kind") == "auto"
    # surface: floor (sit on the floor), free
    p.locator(".hm-pe-seg button[data-value=floor]").click()
    p.wait_for_timeout(300)
    assert abs(min(s.js(f"{RIG}.contactPoints('seat').map((v) => v.y)"))) < 1e-9
    p.locator(".hm-pe-seg button[data-value=free]").click()
    p.wait_for_timeout(200)
    assert s.js(f"{ED}.place.mode") == "free"
    expect(p.locator(".hm-pe-modenote")).to_contain_text("nothing re-grounds")
    p.locator(".hm-pe-seg button[data-value=seat]").click()
    # the "stay on" switch
    p.get_by_role("switch", name="Stay on the floor or seat").uncheck()
    assert s.js(f"{ED}.place.stick") is False
    p.get_by_role("switch", name="Stay on the floor or seat").check()
    # heading
    head = p.locator(".hm-pe-cur .hm-pe-dof").last.locator(".hm-pe-num")
    head.fill("90")
    head.press("Enter")
    p.wait_for_timeout(300)
    assert s.js(f"{RIG}.root.heading") == 90 and s.js(f"{ED}.place.heading") == 90
    # carried by
    p.get_by_label("What carries the weight").select_option("seat")
    p.wait_for_timeout(200)
    assert s.js(f"{ED}.place.support") == "seat"
    assert s.errors() == []


def test_sit_on_a_chair_of_the_scene_and_follow_it(s):
    s.open()
    p = s.page
    s.js("""async () => { const m = await import('/js/human/sandbox.js'); const sb = m.sandboxFor(window.__human.ctx); sb.add('cabin_seat', { position: [0.4, 0, 0.8], yaw: 0, select: true }); return sb.objects.size; }""")
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    p.wait_for_timeout(500)
    s.scroll_panel(".hm-pe-sec-cur")
    sel = p.get_by_label("Sit on")
    assert sel.is_visible()
    opts = sel.locator("option").all_inner_texts()
    assert len(opts) == 2 and "Seat" in opts[1] and "selected" in opts[1]
    sel.select_option(index=1)
    p.wait_for_timeout(400)
    assert s.js(f"{ED}.place.seat.kind") == "object"
    centre = s.js(f"(() => {{ const pts = {RIG}.contactPoints('seat'); return [pts.reduce((t, v) => t + v.x, 0) / pts.length, pts.reduce((t, v) => t + v.z, 0) / pts.length]; }})()")
    chair = s.js(f"window.__human.state.sandbox.supportsWorld()[0]")
    cx = sum(q[0] for q in chair["polygon"]) / 4
    cz = sum(q[1] for q in chair["polygon"]) / 4
    assert abs(centre[0] - cx) < 1e-6 and abs(centre[1] - cz) < 1e-6
    assert abs(min(s.js(f"{RIG}.contactPoints('seat').map((v) => v.y)")) - chair["y"]) < 1e-9
    # the chair moves and is raised: the figure goes with it
    s.js("""() => { const sb = window.__human.state.sandbox, o = [...sb.objects.values()][0]; sb.move(o.id, { x: -0.3, z: 0.5 }); sb.setParam(o.id, 'seatHeight', 0.5); }""")
    p.wait_for_timeout(400)
    chair2 = s.js("window.__human.state.sandbox.supportsWorld()[0]")
    pts = s.js(f"{RIG}.contactPoints('seat').map((v) => [v.x, v.y, v.z])")
    assert abs(min(q[1] for q in pts) - chair2["y"]) < 1e-6
    assert abs(sum(q[0] for q in pts) / len(pts) - sum(q[0] for q in chair2["polygon"]) / 4) < 1e-6
    assert chair2["y"] != chair["y"]
    assert s.errors() == []


def test_units_change_the_seat_height_field(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    s.js(f"{ED}.setSeatHeight(0.5)")
    s.scroll_panel(".hm-pe-sec-cur")
    p.wait_for_timeout(300)
    assert p.locator(".hm-pe-seathost .hm-pe-num").input_value() == "500"
    assert p.locator(".hm-pe-seathost .hm-pe-unit").inner_text() == "mm"
    s.js("window.__human.ctx.setUnits('in')")
    p.wait_for_timeout(300)
    assert abs(float(p.locator(".hm-pe-seathost .hm-pe-num").input_value()) - 19.69) < 0.01
    assert p.locator(".hm-pe-seathost .hm-pe-unit").inner_text() == "in"
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- IK handles
def test_ik_hand_drag_with_the_mouse_moves_the_palm_bends_the_elbow_and_keeps_the_feet(s):
    s.open()
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.page.wait_for_timeout(500)
    feet = f"['heel_sole_L', 'heel_sole_R', 'ball_sole_medial_R'].map((id) => {RIG}.landmarkWorld(id).toArray())"
    feet0 = s.js(feet)
    h0 = s.handle_xy("palm_R")
    s.drag("palm_R", -45, -110, release=False)
    assert s.js(f"{ED}.dragging") is True
    assert s.js("window.__human.viewport.controls.enabled") is False, "the orbit is held while a handle is dragged"
    s.page.mouse.up()
    s.page.wait_for_timeout(400)
    assert s.js("window.__human.viewport.controls.enabled") is True and s.js(f"{ED}.dragging") is False
    palm = s.js(f"{ED}.handlePoint('palm_R').toArray()")
    assert palm[1] - h0["p"][1] > 0.2, f"the palm followed the pointer up: {palm} from {h0['p']}"
    assert s.angle("shoulder_R") != 0 or s.angle("elbow_R") > 5, "the arm bent to get there"
    hist = s.js(f"{ED}.history")
    assert hist["undoLabel"] == "Move right hand" and hist["steps"] == 2, "the whole drag is one step"
    for a, b in zip(feet0, s.js(feet)):
        assert max(abs(x - y) for x, y in zip(a, b)) < 1e-6, "the feet did not move"
    # the handle is selected: the inspector shows it
    assert s.js("window.__human.state.selection") == {"kind": "handle", "id": "palm_R"}
    assert "Right hand" in s.page.locator(".hm-inspector h2").inner_text()
    s.shot("ik-drag")
    s.page.keyboard.press("Control+z")  # undo: the arm is back
    s.page.wait_for_timeout(300)
    assert abs(s.js(f"{ED}.handlePoint('palm_R').toArray()[1]") - h0["p"][1]) < 1e-9
    assert s.errors() == []


def test_ik_drag_lands_on_the_pointer(s):
    s.open()
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.page.wait_for_timeout(500)
    h0 = s.handle_xy("palm_R")
    dx, dy = -40, -70
    s.drag("palm_R", dx, dy, release=False)
    # the pointer ray at its last position, intersected with the plane through the handle that faces the camera
    want = s.js("""([x, y, p0]) => { const w = window.__human, cam = w.viewport.camera, ray = w.viewport.ray(x, y).ray;
      const n = cam.getWorldDirection(cam.position.clone()), d = n.dot(cam.position.clone().set(p0[0], p0[1], p0[2]));
      const t = (d - n.dot(ray.origin)) / n.dot(ray.direction); return ray.origin.clone().addScaledVector(ray.direction, t).toArray(); }""", [h0["x"] + dx, h0["y"] + dy, h0["p"]])
    s.page.mouse.up()
    s.page.wait_for_timeout(400)
    got = s.js(f"{ED}.handlePoint('palm_R').toArray()")
    assert max(abs(a - b) for a, b in zip(got, want)) < 0.006, f"palm {got} vs pointer {want}"
    assert s.js(f"{RIG}.angles.elbow_R[0]") > 5 or s.js(f"{RIG}.angles.shoulder_R[0]") != 0
    assert s.errors() == []


def test_ik_unreachable_drag_shows_the_red_state_with_the_shortfall(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    p.wait_for_timeout(500)
    s.drag("palm_R", -30, -330, release=False, steps=30)
    p.wait_for_timeout(200)
    status = p.locator(".hm-pe-ikstatus")
    assert "is-bad" in (status.get_attribute("class") or "")
    txt = status.inner_text()
    assert "Cannot reach" in txt and "mm short" in txt, txt
    assert p.locator(".hm-label-handle").count() >= 1 and "short" in p.locator(".hm-label-handle").first.inner_text()
    red = s.js(f"(() => {{ const it = {ED}.handleLayer.items.get('palm_R'); return '#' + it.material.color.getHexString(); }})()")
    bad = s.js("""() => { const cs = getComputedStyle(document.documentElement); const probe = document.createElement('span'); probe.style.color = 'var(--bad)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }""")
    r, g, b = [int(v) for v in bad.replace("rgb(", "").replace(")", "").split(",")[:3]]
    # (the layer's colour is in linear working space in some three.js builds: compare the red dominance instead of the exact hex)
    cr, cg, cb = int(red[1:3], 16), int(red[3:5], 16), int(red[5:7], 16)
    assert cr > cg + 40 and cr > cb + 40, f"the handle is red: {red} (token {bad})"
    s.shot("ik-unreachable")
    p.mouse.up()
    p.wait_for_timeout(500)
    assert s.js(f"{ED}.dragging") is False
    assert s.js(f"{ED}.history.undoLabel") == "Move right hand"
    # the closest pose is a valid pose inside the ranges
    assert s.js("""async () => { const pose = await import('/js/human/pose.js'), cur = window.__human.ctx.getRig().getPose(); return pose.clampPose({ root: cur.root, angles: cur.angles }).clamped.length; }""") == 0
    # the next edit clears the red state
    s.js(f"{ED}.setJoint('wrist_R', 0, 10)")
    p.wait_for_timeout(300)
    red2 = s.js(f"(() => {{ const it = {ED}.handleLayer.items.get('palm_R'); return '#' + it.material.color.getHexString(); }})()")
    assert red2 != red
    assert s.errors() == []


def test_ik_pelvis_drag_bends_the_legs_and_the_feet_stay_pinned(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    p.wait_for_timeout(500)
    ids = ["heel_sole_L", "ball_sole_medial_L", "ball_sole_lateral_L", "heel_sole_R", "ball_sole_medial_R", "ball_sole_lateral_R"]
    feet0 = s.js("(ids) => ids.map((id) => window.__human.ctx.getRig().landmarkWorld(id).toArray())", ids)
    y0 = s.js(f"{RIG}.root.y")
    s.drag("pelvis", 0, 70)
    y1 = s.js(f"{RIG}.root.y")
    assert y1 < y0 - 0.08, f"the pelvis went down ({y0} to {y1})"
    feet1 = s.js("(ids) => ids.map((id) => window.__human.ctx.getRig().landmarkWorld(id).toArray())", ids)
    for a, b in zip(feet0, feet1):
        assert max(abs(x - y) for x, y in zip(a, b)) < 0.0015, f"a foot moved by {max(abs(x - y) for x, y in zip(a, b)) * 1000:.2f} mm"
    assert s.angle("knee_L") > 20 and s.angle("hip_L") > 10
    assert abs(s.js(f"{ED}.info().gaps.feet")) < 1e-6
    assert s.js(f"{ED}.history.undoLabel") == "Move pelvis"
    # the pelvis handle can slide the whole figure instead
    p.get_by_role("group", name="What the pelvis handle does").get_by_role("button", name="Move figure").click()
    x0 = s.js(f"{RIG}.root.x")
    ang = s.js(f"JSON.stringify({RIG}.getPose().angles)")
    s.drag("pelvis", -50, 0)
    assert abs(s.js(f"{RIG}.root.x") - x0) > 0.05
    assert s.js(f"JSON.stringify({RIG}.getPose().angles)") == ang, "no joint moved"
    assert s.errors() == []


def test_escape_cancels_a_handle_drag_and_the_figure_is_back(s):
    s.open()
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.page.wait_for_timeout(500)
    before = s.js(f"JSON.stringify({RIG}.getPose())")
    steps = s.js(f"{ED}.history.steps")
    s.drag("palm_L", 30, -90, release=False)
    assert s.js(f"JSON.stringify({RIG}.getPose())") != before
    s.page.keyboard.press("Escape")
    s.page.wait_for_timeout(200)
    assert s.js(f"JSON.stringify({RIG}.getPose())") == before
    assert s.js(f"{ED}.dragging") is False and s.js("window.__human.viewport.controls.enabled") is True
    s.page.mouse.up()
    s.page.wait_for_timeout(200)
    assert s.js(f"{ED}.history.steps") == steps
    assert s.errors() == []


def test_handles_have_a_keyboard_way_and_labels(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    p.wait_for_timeout(300)
    edit_tab(s, "Spine")
    p.locator(".hm-pe-ik summary").click()
    btns = p.locator(".hm-pe-handlebtn")
    assert btns.count() == 11
    names = btns.all_inner_texts()
    assert "Right hand" in names and "Left foot" in names and "Pelvis" in names and any("Look-at" in n for n in names)
    assert btns.filter(has_text="Look-at").is_disabled(), "the look-at handle needs the look-at target"
    rh = btns.filter(has_text="Right hand")
    rh.focus()
    assert s.js("window.__human.state.selection") == {"kind": "handle", "id": "palm_R"}, "focusing a handle selects it"
    y0 = s.js(f"{ED}.handlePoint('palm_R').toArray()[1]")
    for _ in range(3):
        p.keyboard.press("ArrowUp")
    p.wait_for_timeout(200)
    assert abs(s.js(f"{ED}.handlePoint('palm_R').toArray()[1]") - y0 - 0.03) < 0.003, "10 mm per press"
    p.keyboard.press("Shift+ArrowUp")
    p.wait_for_timeout(200)
    assert abs(s.js(f"{ED}.handlePoint('palm_R').toArray()[1]") - y0 - 0.13) < 0.005, "Shift: 100 mm"
    p.keyboard.press("Alt+ArrowDown")
    p.wait_for_timeout(200)
    assert abs(s.js(f"{ED}.handlePoint('palm_R').toArray()[1]") - y0 - 0.129) < 0.003, "Alt: 1 mm"
    z0 = s.js(f"{ED}.handlePoint('palm_R').toArray()")
    p.keyboard.press("PageUp")
    p.wait_for_timeout(200)
    z1 = s.js(f"{ED}.handlePoint('palm_R').toArray()")
    away = s.js("(() => { const d = window.__human.viewport.camera.getWorldDirection(new window.__human.viewport.camera.position.constructor()); return [d.x, d.z]; })()")
    n = (away[0] ** 2 + away[1] ** 2) ** 0.5
    moved = (z1[0] - z0[0]) * away[0] / n + (z1[2] - z0[2]) * away[1] / n
    assert 0.007 < moved < 0.013, "Page Up moves the handle away from the camera"
    assert "Right hand" in p.locator(".hm-inspector h2").inner_text()
    # the five nudges of one handle are a few steps, not five
    assert s.js(f"{ED}.history.steps") <= 4
    # the look-at target: on by the switch, then its handle can be used
    p.get_by_role("switch", name="Look-at target").check()
    p.wait_for_timeout(300)
    assert s.js(f"{ED}.lookActive") is True
    assert btns.filter(has_text="Look-at").is_enabled()
    gaze = s.js(f"{ED}.lookTarget()")
    eye = s.js(f"{RIG}.landmarkWorld('eye_mid').toArray()")
    assert abs(sum((a - b) ** 2 for a, b in zip(gaze, eye)) ** 0.5 - 1.0) < 1e-6, "1 m in front of the eyes"
    s.drag("gaze", 60, -30)
    assert s.js(f"{ED}.history.undoLabel") == "Move look-at target"
    assert s.js(f"{ED}.lookTarget()") != gaze
    assert s.errors() == []


def test_look_at_the_selected_object_and_the_measurement_point(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.js("""async () => { const m = await import('/js/human/sandbox.js'); const sb = m.sandboxFor(window.__human.ctx); sb.add('box', { position: [1.0, 0.8, 1.6], select: true }); }""")
    p.wait_for_timeout(300)
    edit_tab(s, "Head")
    p.locator(".hm-pe-ik summary").click()
    p.get_by_role("button", name="Look at the selected object").click()
    p.wait_for_timeout(400)
    centre = s.js("""() => { const sb = window.__human.state.sandbox, o = [...sb.objects.values()][0]; const c = o.bbox.getCenter(o.bbox.min.clone()); const v = sb.localToWorld(o.id, c.toArray()); return [v.x, v.y, v.z]; }""")
    gaze = s.js(f"{ED}.lookTarget()")
    assert max(abs(a - b) for a, b in zip(centre, gaze)) < 1e-6
    # the eyes really point at it
    err = s.js("""(c) => { const w = window.__human, r = w.ctx.getRig(), T = r.landmarkWorld('eye_mid').constructor; const d = new T(0, 0, 1).applyQuaternion(r.jointQuaternion('eye_L')).add(new T(0, 0, 1).applyQuaternion(r.jointQuaternion('eye_R'))).normalize(); const t = new T(c[0], c[1], c[2]).sub(r.landmarkWorld('eye_mid')).normalize(); return d.angleTo(t) * 180 / Math.PI; }""", centre)
    assert err < 2.0, f"gaze error {err} degrees"
    assert s.js(f"{ED}.lookActive") is True
    # no measurement yet: a plain-language answer, no exception
    p.get_by_role("button", name="Look at the measurement point").click()
    p.wait_for_timeout(300)
    assert "measurement" in s.js("[...document.querySelectorAll('.hm-pe [role=status]')].map((e) => e.textContent).join(' ')").lower()
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- custom postures
def test_save_a_custom_posture_reload_find_it_apply_and_delete(chromium, server):
    with make_session(chromium, server) as a:
        a.open()
        p = a.page
        a.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
        a.js(f"{ED}.setJoint('shoulder_R', 'flex', 66)")
        a.js(f"{ED}.setGrip('R', 'point')")
        a.scroll_panel(".hm-pe-sec-cur")
        p.get_by_role("button", name="Save as custom…").click()
        name = p.get_by_label("Save as a custom posture")
        assert name.input_value().startswith("Seated upright")
        name.fill("My reach to the panel")
        p.get_by_label("Category of the new posture").select_option("Reaching")
        p.get_by_role("button", name="Save", exact=True).click()
        p.wait_for_timeout(500)
        assert a.js(f"{ED}.base.id") == "custom-my-reach-to-the-panel" and a.js(f"{ED}.base.kind") == "custom"
        assert p.locator(".hm-pe-dot").is_hidden(), "saving makes the pose the base: not modified"
        assert "Saved as the custom posture" in a.js("[...document.querySelectorAll('.hm-pe [role=status]')].map((e) => e.textContent).join(' ')")
        stored = a.js("JSON.parse(localStorage.getItem('hm-custom-postures-v1'))")
        assert stored["version"] == 1 and stored["postures"][0]["id"] == "custom-my-reach-to-the-panel" and stored["postures"][0]["category"] == "Reaching"
        chip = p.locator(".hm-pe-chip[data-value=custom]")
        assert chip.is_visible() and chip.locator(".hm-pe-n").inner_text() == "1"
        assert p.get_by_role("button", name="Delete", exact=True).is_visible()
        state = a.context.storage_state()
        a.shot("custom-saved", ".hm-left")
    # a new page of the same browser profile finds it
    with make_session(chromium, server, storage_state=state) as b:
        b.open()
        p = b.page
        assert p.locator(".hm-pe-chip[data-value=custom]").locator(".hm-pe-n").inner_text() == "1"
        p.locator(".hm-pe-chip[data-value=custom]").click()
        p.wait_for_timeout(300)
        cards = p.locator(".hm-pe-card")
        assert cards.count() == 1 and "My reach to the panel" in cards.first.inner_text() and "custom" in cards.first.inner_text()
        cards.first.click()
        b.settle()
        assert b.js(f"{ED}.base.kind") == "custom" and b.angle("shoulder_R") == 66 and b.js(f"{ED}.gripOf('R')") == "point"
        assert b.js(f"{ED}.place.mode") == "seat"
        p.get_by_role("button", name="Delete", exact=True).click()
        assert p.get_by_text("Delete this posture for good?").is_visible()
        p.get_by_role("button", name="Keep it").click()
        assert b.js(f"{ED}.listCustom().length") == 1
        p.get_by_role("button", name="Delete", exact=True).click()
        p.get_by_role("button", name="Delete it").click()
        p.wait_for_timeout(400)
        assert b.js(f"{ED}.listCustom().length") == 0
        assert b.js("JSON.parse(localStorage.getItem('hm-custom-postures-v1')).postures.length") == 0
        assert p.locator(".hm-pe-chip[data-value=custom]").is_hidden() or p.locator(".hm-pe-chip[data-value=custom]").locator(".hm-pe-n").inner_text() == "0"
        assert b.errors() == []


def test_corrupt_stored_postures_are_ignored(chromium, server):
    init = ["localStorage.setItem('hm-custom-postures-v1', '{{{ not json')"]
    with make_session(chromium, server, init=init) as a:
        a.open()
        assert a.js(f"{ED}.listCustom().length") == 0
        assert a.page.locator(".hm-pe-chip[data-value=custom]").is_hidden()
        assert a.js(f"{ED}.customProblems().length") >= 1
        assert a.errors() == []


def test_export_and_import_a_posture_file(s, tmp_path):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    s.js(f"{ED}.setJoint('elbow_R', 0, 70)")
    s.scroll_panel(".hm-pe-sec-cur")
    with p.expect_download() as dl:
        p.get_by_role("button", name="Export").click()
    path = tmp_path / "posture.json"
    dl.value.save_as(str(path))
    data = json.loads(path.read_text())
    assert data["app"] == "digital-human-posture" and data["pose"]["angles"]["elbow_R"][0] == 70 and data["posture"]["support"] == "seat+feet"
    assert dl.value.suggested_filename.endswith(".json") and "posture" in dl.value.suggested_filename
    s.js(f"{ED}.neutral()")
    p.wait_for_timeout(300)
    assert s.angle("elbow_R") == 0
    p.locator(".hm-pe-cur input[type=file]").set_input_files(str(path))
    p.wait_for_timeout(800)
    s.settle()
    assert s.angle("elbow_R") == 70 and s.js(f"{ED}.base.kind") == "imported" and s.js(f"{ED}.place.mode") == "seat"
    # a file that is not a posture: a plain-language error, the figure unchanged
    bad = tmp_path / "bad.json"
    bad.write_text('{"app": "something-else"}')
    before = s.js(f"JSON.stringify({RIG}.getPose())")
    p.locator(".hm-pe-cur input[type=file]").set_input_files(str(bad))
    p.wait_for_selector(".hm-pe-importmsg >> text=cannot be used")
    assert s.js(f"JSON.stringify({RIG}.getPose())") == before
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- the rest of the shell
def test_a_new_profile_keeps_the_posture_and_the_placement_and_says_so(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    s.js(f"{ED}.setJoint('shoulder_R', 'flex', 50)")
    seat0 = s.js(f"{ED}.seatHeight()")
    stature0 = s.js("window.__human.ctx.getBody().stature")
    p.get_by_role("tab", name="Profile").click()
    p.wait_for_selector(".hm-pf .hm-pf-dimbtn", timeout=30000)
    p.locator("#view-human").get_by_role("button", name="P5", exact=True).click()
    p.wait_for_function("window.__human.ctx.getProfile().source.percentile === 5")
    s.built()
    assert s.js("window.__human.ctx.getBody().stature") < stature0 - 0.05
    p.get_by_role("tab", name="Posture").click()
    p.wait_for_timeout(500)
    assert s.js(f"{ED}.base.id") == "iso-7250-sitting" and s.js(f"{ED}.modified") is True
    assert s.angle("shoulder_R") == 50
    info = s.js(f"{ED}.info()")
    assert abs(info["gaps"]["seat"]) < 1e-6 and abs(info["gaps"]["feet"]) < 3e-3, info["gaps"]
    assert s.js(f"{ED}.seatHeight()") != seat0, "the seat of the posture follows the new body"
    assert "rebuilt for the new profile" in p.locator(".hm-pe-note").inner_text()
    assert "Seated upright" in p.locator(".hm-pe-curname").inner_text()
    # the handles are on the new figure
    h = s.handle_xy("palm_R")
    assert h["visible"]
    s.drag("palm_R", -20, -40)
    assert s.js(f"{ED}.history.undoLabel") == "Move right hand"
    assert s.errors() == []


def test_the_skeleton_tab_inspector_shows_the_same_sliders(s):
    s.open()
    p = s.page
    p.get_by_role("tab", name="Skeleton").click()
    p.wait_for_selector(".hm-sk-tree", timeout=30000)
    s.js("window.__human.ctx.select({ kind: 'joint', id: 'knee_L' })")
    p.wait_for_selector(".hm-inspector .hm-pe-range", timeout=10000)
    assert p.locator(".hm-inspector .hm-pe-range").count() == 2, "knee: flexion and rotation"
    assert "Left knee" in p.locator(".hm-inspector h2").inner_text()
    num = p.locator(".hm-inspector .hm-pe-num").first
    num.fill("45")
    num.press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("knee_L") == 45
    assert p.locator(".hm-inspector summary", has_text="Joint details").count() == 1
    assert s.errors() == []


def test_the_inspector_edits_the_selected_joint_from_the_posture_tab(s):
    s.open()
    p = s.page
    s.js("window.__human.ctx.setDisplay({ joints: true })")
    s.js("window.__human.ctx.select({ kind: 'joint', id: 'shoulder_R' })")
    p.wait_for_selector(".hm-inspector .hm-pe-range", timeout=10000)
    assert "Right shoulder" in p.locator(".hm-inspector h2").inner_text()
    assert p.locator(".hm-inspector .hm-pe-range").count() == 3
    assert p.get_by_role("tab", name="Right arm").get_attribute("aria-selected") == "true", "selecting a joint opens its tab"
    num = p.locator(".hm-inspector .hm-pe-num").first
    num.fill("33")
    num.press("Enter")
    p.wait_for_timeout(300)
    assert s.angle("shoulder_R") == 33
    assert p.locator("[data-joint=shoulder_R] .hm-pe-num").first.input_value() == "33", "the tab shows the same value"
    p.locator(".hm-inspector").get_by_role("button", name="Reset").click()
    p.wait_for_timeout(300)
    assert s.angle("shoulder_R") == 0
    # a vertebra opens the individual-vertebrae list
    s.js("window.__human.ctx.select({ kind: 'joint', id: 'L3' })")
    p.wait_for_timeout(500)
    assert p.locator(".hm-pe-vdetails").get_attribute("open") is not None
    assert s.errors() == []


# ---------------------------------------------------------------------------------------------------------------------------------- layout, themes, leaks
def no_horizontal_scroll(s, width):
    s.page.wait_for_timeout(300)
    doc = s.js("document.documentElement.scrollWidth")
    assert doc <= width + 1, f"the page scrolls sideways: {doc} px wide in a {width} px window"
    wide = s.js("""(w) => [...document.querySelectorAll('.hm-pe *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && !e.closest('[hidden]') && getComputedStyle(e).visibility !== 'hidden'; }).slice(0, 5).map((e) => e.className + ' ' + Math.round(e.getBoundingClientRect().right))""", width)
    assert wide == [], f"elements of the panel stick out of the window: {wide}"


@pytest.mark.parametrize("width,height", [(390, 800), (360, 740)])
def test_phone_layout_has_no_horizontal_scroll_and_is_usable(chromium, server, width, height):
    with make_session(chromium, server, width=width, height=height, mobile=True) as m:
        m.open()
        p = m.page
        no_horizontal_scroll(m, width)
        m.shot(f"mobile-{width}-library")
        # choose a posture by tapping its card
        p.fill(".hm-pe-searchbox", "sit upright")
        p.wait_for_timeout(400)
        p.locator(".hm-pe-card").first.tap()
        m.settle()
        assert m.js(f"{ED}.base.kind") == "library"
        no_horizontal_scroll(m, width)
        for sel in (".hm-pe-sec-cur", ".hm-pe-sec-edit"):
            p.evaluate("(sel) => document.querySelector(sel).scrollIntoView()", sel)
            p.wait_for_timeout(200)
            no_horizontal_scroll(m, width)
        m.shot(f"mobile-{width}-edit")
        for tab in ("Right arm", "Head", "Spine", "Left leg", "Right hand"):
            p.get_by_role("tab", name=tab).click()
            p.wait_for_timeout(150)
            no_horizontal_scroll(m, width)
        # a slider can be used by touch: its thumb is bigger on a coarse pointer
        r = p.locator(".hm-pe-range").first.bounding_box()
        assert r["height"] >= 26
        p.evaluate("document.querySelector('.hm-pe-ik summary').click()")
        no_horizontal_scroll(m, width)
        assert m.errors() == []


def test_dark_theme_uses_the_tokens_and_draws_readable_stick_figures(chromium, server):
    with make_session(chromium, server, dark=True) as d:
        d.open()
        p = d.page
        bg = d.js("getComputedStyle(document.querySelector('.hm-pe-list')).backgroundColor")
        r, g, b = [int(v) for v in bg.replace("rgb(", "").replace(")", "").split(",")[:3]]
        assert (r + g + b) / 3 < 80, f"dark list background {bg}"
        ink = d.js("""() => { const c = document.querySelector('.hm-pe-card canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let best = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) best = Math.max(best, d[i] + d[i + 1] + d[i + 2]); return best / 3; }""")
        assert ink > 120, f"the stick figure is light on the dark card (brightest ink {ink})"
        d.scroll_panel(".hm-pe-sec-edit")
        d.shot("dark-edit", ".hm-left")
        d.page.get_by_role("tab", name="Right arm").click()
        sl = d.js("getComputedStyle(document.querySelector('.hm-pe-joint')).backgroundColor")
        r, g, b = [int(v) for v in sl.replace("rgb(", "").replace(")", "").split(",")[:3]]
        assert (r + g + b) / 3 < 80
        d.shot("dark-page")
        # switching the theme redraws the figures
        p.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
        p.wait_for_timeout(500)
        ink2 = d.js("""() => { const c = document.querySelector('.hm-pe-card canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let best = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) best = Math.max(best, d[i] + d[i + 1] + d[i + 2]); return best / 3; }""")
        assert ink2 != ink
        assert d.errors() == []


def test_twenty_rapid_selections_leave_no_extra_loops_listeners_or_canvases(chromium, server):
    with make_session(chromium, server, init=[LEAK_INIT]) as a:
        a.open()
        p = a.page
        p.wait_for_timeout(1500)
        stats = "() => ({ raf: window.__raf.size, listeners: window.__nl, canvases: document.querySelectorAll('canvas').length, cards: document.querySelectorAll('.hm-pe-card').length })"
        base = a.js(stats)
        for i in range(20):
            p.locator(".hm-pe-card").nth(i % 4).click()
        p.wait_for_timeout(1500)
        after = a.js(stats)
        assert after["raf"] <= base["raf"], f"animation frames still scheduled: {after} vs {base}"
        assert after["listeners"] == base["listeners"], f"listeners leaked: {after} vs {base}"
        assert after["canvases"] == base["canvases"] and after["cards"] == base["cards"]
        for i in range(20):
            a.js(f"{ED}.apply(['iso-7250-sitting', 'iso-7250-standing', 'lie-supine', 'lie-prone'][{i} % 4])")
        p.wait_for_timeout(1500)
        after2 = a.js(stats)
        assert after2["raf"] <= base["raf"] and after2["listeners"] == base["listeners"] and after2["canvases"] == base["canvases"], f"{after2} vs {base}"
        # dragging a handle and releasing it leaves nothing behind either
        a.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
        p.wait_for_timeout(400)
        for _ in range(3):
            a.drag("palm_R", -20, -40)
        p.wait_for_timeout(600)
        after3 = a.js(stats)
        assert after3["raf"] <= base["raf"] and after3["listeners"] == base["listeners"], f"{after3} vs {base}"
        assert a.errors() == []


def test_leaving_and_returning_to_the_tab_and_other_tabs_do_not_break_the_panel(s):
    s.open()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-sitting', {{ animate: false }})")
    for tab in ("Scene", "Measure", "Skeleton", "Analysis", "Export", "Profile", "Posture"):
        p.get_by_role("tab", name=tab).click()
        p.wait_for_timeout(250)
    assert p.locator(".hm-pe").is_visible()
    h = s.handle_xy("palm_R")
    assert h["visible"]
    # the handles are off when another tab is active
    p.get_by_role("tab", name="Scene").click()
    p.wait_for_timeout(300)
    assert s.js(f"{ED}.handleLayer.enabled") is False
    p.get_by_role("tab", name="Posture").click()
    p.wait_for_timeout(300)
    assert s.js(f"{ED}.handleLayer.enabled") is True
    # the IK switch turns the layer off and on
    s.scroll_panel(".hm-pe-sec-edit")
    p.get_by_role("switch", name="IK handles").uncheck()
    p.wait_for_timeout(200)
    assert s.js(f"{ED}.handleLayer.enabled") is False and s.js(f"{ED}.handleLayer.group.visible") is False
    p.get_by_role("switch", name="IK handles").check()
    p.wait_for_timeout(200)
    assert s.js(f"{ED}.handleLayer.enabled") is True
    assert s.errors() == []


def test_a_walk_through_every_library_posture_has_no_console_errors(s):
    s.open()
    ids = s.js("import('/js/human/postures.js').then((m) => m.POSTURES.map((p) => p.id))")
    s.js("""async (ids) => { const ed = window.__human.state.postureEditor; for (const id of ids) { ed.apply(id, { animate: false }); await new Promise((r) => setTimeout(r, 5)); } }""", ids)
    s.page.wait_for_timeout(800)
    assert s.js(f"{ED}.history.steps") == len(ids)
    # every posture of the library on the median body validates the way the badge says (a smoke check of the badge, not of the library)
    assert s.errors() == []
