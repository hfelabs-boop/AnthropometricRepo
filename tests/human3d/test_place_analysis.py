"""Browser tests of "Place the human" (site/js/human/place.js, the Scene panel's section) and of the Analysis panel (site/js/human/panels/analysis.js) on the real site:
headless Chromium with WebGL (SwiftShader), the real shell, fit.js, rig.js, ik.js, the sandbox and the posture editor. Slow (a build takes a second or two).

    python -m pytest tests/human3d/test_place_analysis.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_place_analysis.py     # fail instead of skip when Playwright / Chromium / WebGL / the data is missing
    HM_SHOTS=/some/dir ...                                                        # also save screenshots there (light and dark, 1280 x 800 and 390 x 800)
    CHROMIUM=/path/to/chrome ...                                                  # default: /opt/pw-browsers/chromium (see shot.py)

The tests read the figure through window.__human (the debug hook of the shell: #/human?debug), the sandbox through window.__human.state.sandbox and the posture editor through
window.__human.state.postureEditor. The Scene panel is expected to mount the placing controls into its "Place the human" section (docs/human3d/PLACE_ANALYSIS.md, "Integration");
until it does, `open_scene` mounts them itself and `test_the_scene_panel_mounts_the_controls` is reported as xfail.
"""
import contextlib
import os
import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
REQUIRE = os.environ.get("REQUIRE_BROWSER") == "1"
SHOTS = os.environ.get("HM_SHOTS")

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
if not (ROOT / "public" / "api" / "v1" / "index.json").exists():
    _unavailable("public/api/v1 is not built (python scripts/build_site.py)")
for f in ("site/js/human/place.js", "site/js/human/panels/analysis.js"):
    if not (ROOT / f).exists() or "comingSoon" in (ROOT / f).read_text():
        _unavailable(f"{f} is missing or still the stub")

# The skin generator (body.js) is another engineer's module and may be mid-edit; the shell then logs that it failed to load and shows the skeleton only.
OTHER_MODULES = ("the skin generator (body.js) failed to load",)
HUMAN = "window.__human"
ED = "window.__human.state.postureEditor"
SB = "window.__human.state.sandbox"
RIG = "window.__human.ctx.getRig()"
PL = "window.__place.placer"

LEAK_INIT = """
(() => {
  window.__raf = new Set();
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => { let id; id = raf((t) => { window.__raf.delete(id); f(t); }); window.__raf.add(id); return id; };
  window.cancelAnimationFrame = (id) => { window.__raf.delete(id); caf(id); };
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener, reg = new WeakMap();
  window.__lid = 0; window.__nl = 0;
  const longLived = (t) => t === window || t === document || t === document.documentElement || t === document.body || (!!window.__human && t === window.__human.viewport.canvas);
  const id = (type, fn, o) => type + '|' + (typeof o === 'boolean' ? o : !!(o && o.capture)) + '|' + (fn.__id ??= ++window.__lid);
  EventTarget.prototype.addEventListener = function (type, fn, o) { if (fn && !(o && o.once) && longLived(this)) { let m = reg.get(this); if (!m) reg.set(this, m = new Set()); const k = id(type, fn, o); if (!m.has(k)) { m.add(k); window.__nl++; } } return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { if (fn && longLived(this)) { const m = reg.get(this); if (m && m.delete(id(type, fn, o))) window.__nl--; } return rem.call(this, type, fn, o); };
})();
"""

MOUNT = """async () => {
  const { sandboxFor } = await import('/js/human/sandbox.js');
  const sb = sandboxFor(window.__human.ctx);
  const m = await import('/js/human/place.js');
  const mount = m.mountPlace(sb.placeContainer, window.__human.ctx);
  await mount.ready;
  window.__place = mount;
}"""

# every number the page reports about the seat and the feet is measured on the figure, not read from the controls
SEAT_STATE = """async () => {
  const w = window.__human, rig = w.ctx.getRig(), sb = w.state.sandbox, ed = w.state.postureEditor, m = await import('/js/human/place.js');
  const pl = ed.place, o = sb.objects.get(pl.seat.objectId);
  const out = { mode: pl.mode, heading: rig.root.heading, objectId: pl.seat.objectId, feetGapMm: Math.min(...rig.contactPoints('feet').map((p) => p.y)) * 1000 };
  if (o) {
    const sup = sb.supportsWorld().find((s) => s.objectId === o.id);
    out.yaw = o.yaw; out.pitch = sup.pitch ?? 0;
    out.seatGapMm = Math.min(...rig.contactPoints('seat').map((p) => p.y - m.planeHeightAt(sup, o.yaw, p.x, p.z))) * 1000;
    out.seatHeight = o.params.seatHeight;
    out.ischialInside = ['ischial_L', 'ischial_R'].every((id) => { const p = rig.landmarkWorld(id); return sb.supportsWorld().some((s) => s.objectId === o.id && p.x >= Math.min(...s.polygon.map((q) => q[0])) - 1e-6 && p.x <= Math.max(...s.polygon.map((q) => q[0])) + 1e-6); });
  }
  return out;
}"""

GRIP_STATE = """() => {
  const w = window.__human, rig = w.ctx.getRig(), sb = w.state.sandbox;
  const wheel = [...sb.objects.values()].find((o) => o.type === 'steering_wheel');
  return sb.gripsWorld(wheel.id).map((g) => ({ id: g.id, hand: g.hand, errMm: rig.landmarkWorld('grip_centre_' + g.hand).distanceTo(g.position) * 1000 }));
}"""


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
    def __init__(self, page, logs, base, tag):
        self.page, self.logs, self.base, self.tag = page, logs, base, tag
        self.mounted_by_scene = None

    def errors(self, allow=()):
        return [ln for ln in self.logs if (ln.startswith("[error]") or ln.startswith("[pageerror]")) and not any(a in ln for a in (*OTHER_MODULES, *allow))]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def boot(self, timeout=90000):
        p = self.page
        p.goto(f"{self.base}/#/human?debug")
        p.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
        return self

    def open_scene(self):
        """The Scene tab, with the placing controls in its "Place the human" section (mounted here when the Scene panel does not do it yet)."""
        p = self.page
        p.get_by_role("tab", name="Scene").click()
        p.wait_for_selector(".hm-sc", timeout=60000)
        p.wait_for_timeout(300)
        if self.mounted_by_scene is None:
            self.mounted_by_scene = self.js("(document.querySelector('#hm-place-human')?.childElementCount ?? 0) > 0")
            if not self.mounted_by_scene:
                self.js(MOUNT)
        p.wait_for_function("window.__place ? !!window.__place.placer : document.querySelectorAll('#hm-place-human .hm-pl').length > 0", timeout=30000)
        return self

    def placer_ready(self):
        """Wait until the controls have loaded their engine (the buttons are enabled by the first refresh)."""
        self.page.wait_for_function("document.querySelector('#hm-place-human .hm-pl') && !!document.querySelector('#hm-place-human .hm-pl select')", timeout=30000)
        self.page.wait_for_timeout(300)

    def add_from_catalogue(self, query, card_text, button):
        """Add an object the way a user does: search the catalogue, pick the card, press the Add button."""
        p = self.page
        p.fill(".hm-sc input[type=search]", query)
        card = p.locator(".hm-obj-card", has_text=card_text).first
        card.wait_for(timeout=10000)
        card.click()
        p.get_by_role("button", name=button).click()
        p.wait_for_timeout(200)
        p.fill(".hm-sc input[type=search]", "")

    def section(self, title):
        sec = self.page.locator("#hm-place-human .hm-pl-sec").filter(has_text=title).first
        sec.evaluate("e => { e.open = true; }")
        sec.scroll_into_view_if_needed()
        return sec

    def press(self, title, button):
        """Press a button of a section of the placing controls."""
        sec = self.section(title)
        sec.get_by_role("button", name=button, exact=False).first.click()
        self.page.wait_for_timeout(150)
        return sec

    def result(self, title):
        return self.section(title).locator(".hm-pl-out").inner_text()

    def settle(self, ms=450):
        self.page.wait_for_function(f"!{ED}.animating", timeout=10000)
        self.page.wait_for_timeout(ms)

    def side_view(self):
        """A side view of the seat, the wheel and the figure for the screenshots (the view turns first, then the camera frames them)."""
        self.js("window.__human.ctx.setView('right')")
        self.page.wait_for_timeout(900)
        self.js("""() => { const w = window.__human, box = w.state.sandbox.bounds(), rb = new box.constructor().setFromObject(w.ctx.getRig().group); box.union(rb); box.expandByScalar(0.1); w.viewport.frame(box, { animate: false, margin: 1.0 }); w.ctx.requestRender(); }""")
        self.page.wait_for_timeout(600)

    def shot(self, name, selector=None, full_panel=False):
        if not SHOTS:
            return
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        path = str(Path(SHOTS) / f"place-{name}-{self.tag}.png")
        if full_panel:  # the left column scrolls inside itself: let it grow for the picture
            self.page.add_style_tag(content=".hm-left{max-height:none!important;overflow:visible!important}.hm-panels{overflow:visible!important}")
            self.page.wait_for_timeout(200)
        (self.page.locator(selector) if selector else self.page).screenshot(path=path)


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=800, dark=False, mobile=False, init=()):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                               device_scale_factor=1, reduced_motion="no-preference")
    page = ctx.new_page()
    raw_wait = page.wait_for_timeout

    def wait_for_timeout(ms):  # a refresh runs on an animation frame, and a frame of software WebGL can take a few hundred ms: two frames go by after every real wait
        raw_wait(ms)
        if ms >= 100:
            page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.wait_for_timeout = wait_for_timeout
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    for script in init:
        page.add_init_script(script)
    try:
        yield Session(page, logs, server, f"{'dark' if dark else 'light'}-{width}")
    finally:
        ctx.close()


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        yield sess


def cab(sess):
    """The cab of the cab template, built through the catalogue like a user: a cabin seat and a steering wheel in front of it. The seat is selected last."""
    sess.open_scene()
    sess.add_from_catalogue("cabin", "Cabin seat", "Add Cabin seat")
    sess.add_from_catalogue("steering", "Steering wheel", "Add Steering wheel")
    sess.js("""() => { const sb = window.__human.state.sandbox, seat = [...sb.objects.values()].find((o) => o.type === 'cabin_seat'), wheel = [...sb.objects.values()].find((o) => o.type === 'steering_wheel');
      sb.rotate(seat.id, 0, { snap: false });
      sb.move(wheel.id, { x: seat.position[0], y: 0, z: seat.position[2] + 0.6 }, { snap: false }); sb.rotate(wheel.id, 180, { snap: false });
      sb.setParams(wheel.id, { centreHeight: 0.72, tilt: 25 });
      window.__human.ctx.select({ kind: 'object', id: seat.id }); }""")
    sess.placer_ready()
    sess.page.wait_for_timeout(300)


def open_analysis(sess, text="centre of mass"):
    """The Analysis tab, once its headline has the first real reading."""
    sess.page.get_by_role("tab", name="Analysis").click()
    sess.page.wait_for_selector(".hm-an-verdict", timeout=30000)
    sess.page.wait_for_function("(t) => document.querySelector('.hm-an-verdict').textContent.includes(t)", arg=text, timeout=30000)


def sit_and_fit(sess):
    sess.press("Sit on the selected seat", "Sit on it")
    sess.settle(300)
    sess.press("Sit on the selected seat", "Adjust seat height to this body")
    sess.settle(300)


# ---------------------------------------------------------------------------------------------------------------------------------- the controls
def test_the_scene_panel_mounts_the_controls(s):
    """The Scene panel hands its "Place the human" container to place.js (mountPlace): see docs/human3d/PLACE_ANALYSIS.md, Integration."""
    s.boot()
    s.page.get_by_role("tab", name="Scene").click()
    s.page.wait_for_selector(".hm-sc", timeout=60000)
    s.page.wait_for_timeout(1500)
    n = s.js("document.querySelectorAll('#hm-place-human .hm-pl').length")
    if n == 0:
        pytest.xfail("scene.js does not call mountPlace(sandbox.placeContainer, ctx) yet (integration step of docs/human3d/PLACE_ANALYSIS.md)")
    assert n == 1
    assert s.js("!!document.querySelector('.hm-sc-place:not([hidden])')"), "the section is visible once it has content"


def test_sit_on_the_cabin_seat_adjust_to_the_body_and_hold_the_wheel(s):
    s.boot()
    cab(s)
    assert s.js(f"{ED}.place.mode") == "floor"
    # sit: on the seat, turned the way the seat faces, the sit bones on the surface, the feet gap reported
    sec = s.press("Sit on the selected seat", "Sit on it")
    s.settle(300)
    st = s.js(SEAT_STATE)
    assert st["mode"] == "seat" and st["objectId"], st
    assert abs(st["heading"] - st["yaw"]) < 1e-6, f"the figure faces the way the seat faces: {st}"
    assert abs(st["seatGapMm"]) < 12, f"the sit bones are {st['seatGapMm']:.1f} mm from the (tilted) seat surface"
    assert st["ischialInside"], st
    text = s.result("Sit on the selected seat") + " " + sec.locator(".hm-pl-facts").inner_text()
    assert "Sitting on Cabin seat" in text
    feet = st["feetGapMm"]
    assert (f"{abs(feet):.0f} mm" in text) or abs(feet) <= 5, f"the readout names the feet gap ({feet:.1f} mm): {text}"
    # adjust the seat to this body (the popliteal rule): the feet reach the floor
    s.press("Sit on the selected seat", "Adjust seat height to this body")
    s.settle(300)
    st2 = s.js(SEAT_STATE)
    assert abs(st2["feetGapMm"]) < 12, f"feet gap after the adjustment: {st2['feetGapMm']:.1f} mm"
    assert abs(st2["seatHeight"] - st["seatHeight"]) > 0.0005 or abs(feet) < 1, "the seat height changed"
    assert abs(st2["seatGapMm"]) < 12
    s.press("Sit on the selected seat", "Adjust seat to the feet")
    s.settle(300)
    assert abs(s.js(SEAT_STATE)["feetGapMm"]) < 3
    # the figure follows the seat: raise it by 20 mm through the Scene tab's own API
    before = s.js(SEAT_STATE)
    s.js(f"() => {{ const sb = {SB}; const id = {ED}.place.seat.objectId; sb.setParam(id, 'seatHeight', sb.objects.get(id).params.seatHeight + 0.02); }}")
    s.settle(200)
    assert abs(s.js(SEAT_STATE)["seatGapMm"] - before["seatGapMm"]) < 1.5, "the figure rose with the seat"
    s.js(f"() => {{ const sb = {SB}; const id = {ED}.place.seat.objectId; sb.setParam(id, 'seatHeight', sb.objects.get(id).params.seatHeight - 0.02); }}")
    s.settle(200)
    # grab: both hands on the wheel
    s.js("window.__human.ctx.select({ kind: 'object', id: [...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').id })")
    s.page.wait_for_timeout(300)
    sec = s.section("Grab with the hands")
    assert sec.locator("select").first.input_value() != "", "the wheel is chosen: it is the selected object"
    s.press("Grab with the hands", "Grab with IK")
    s.settle(300)
    errs = s.js(GRIP_STATE)
    assert len(errs) == 2 and all(e["errMm"] < 1.0 for e in errs), errs
    assert s.js(f"[{ED}.gripOf('L'), {ED}.gripOf('R')]") == ["wheel", "wheel"]
    assert "Both hands hold" in s.result("Grab with the hands")
    # still on the seat after the grab, feet unmoved
    assert abs(s.js(SEAT_STATE)["feetGapMm"]) < 3
    # one history step each in the posture editor: undo the grab, the hands let go of the wheel
    assert s.js(f"{ED}.history.undoLabel") == "Hold Steering wheel"
    s.js(f"{ED}.undo()")
    s.page.wait_for_timeout(200)
    assert s.js(GRIP_STATE)[0]["errMm"] > 10
    s.js(f"{ED}.redo()")
    s.page.wait_for_timeout(200)
    assert all(e["errMm"] < 1.0 for e in s.js(GRIP_STATE))
    s.side_view()
    s.shot("sit-and-grab")
    s.shot("controls", ".hm-left")
    assert s.errors() == [], s.errors()


def test_analysis_panel_shows_live_values_that_follow_the_posture(s):
    s.boot()
    cab(s)
    sit_and_fit(s)
    p = s.page
    p.get_by_role("tab", name="Analysis").click()
    p.wait_for_selector(".hm-an-verdict", timeout=30000)
    p.wait_for_function("document.querySelector('.hm-an-verdict').textContent.includes('centre of mass')", timeout=20000)
    verdict = p.locator(".hm-an-verdict")
    v1 = verdict.inner_text()
    assert "inside the support" in v1 and "inside their ranges" in v1, v1
    assert verdict.get_attribute("role") == "status" and verdict.get_attribute("aria-live") == "polite"
    assert s.js("document.querySelectorAll('.hm-an [aria-live]').length") == 1, "only the headline verdict is a live region"
    # the angle table: values, severity chips with words, a caption for screen readers
    rows = s.js("[...document.querySelectorAll('.hm-an-table')][0].querySelectorAll('tbody tr').length")
    assert rows >= 10
    assert s.js("!!document.querySelector('.hm-an-table caption')")
    trunk1 = p.locator(".hm-an-table tbody tr").first.inner_text()
    assert "Trunk inclination" in trunk1 and "°" in trunk1
    assert s.js("[...document.querySelectorAll('.hm-an-chip')].every((c) => ['OK', 'Check', 'Not recommended'].includes(c.textContent))")
    assert "indication" in p.locator(".hm-an").inner_text().lower()
    # balance diagram: an svg with a name, a hull, the centre of mass; the margin in mm in the text
    svg = p.locator(".hm-an-svg")
    assert "centre of mass" in (svg.get_attribute("aria-label") or "")
    assert s.js("document.querySelectorAll('.hm-an-hull').length") == 1 and s.js("document.querySelector('.hm-an-hull').getAttribute('points').split(' ').length") >= 4
    assert "mm" in p.locator(".hm-an-fact").inner_text()
    gaps = p.locator(".hm-an-gaps").inner_text()
    assert "Seat" in gaps and "Feet" in gaps, gaps
    # the values change when the posture changes
    before = {"verdict": v1, "angles": p.locator(".hm-an-table").first.inner_text(), "balance": p.locator(".hm-an-fact").inner_text()}
    s.js(f"{ED}.apply('sit-slumped', {{ animate: false }})")
    p.wait_for_function("(v) => document.querySelector('.hm-an-verdict').textContent !== v", arg=v1, timeout=20000)
    p.wait_for_timeout(400)
    after = {"verdict": verdict.inner_text(), "angles": p.locator(".hm-an-table").first.inner_text(), "balance": p.locator(".hm-an-fact").inner_text()}
    assert after["angles"] != before["angles"] and after["verdict"] != before["verdict"]
    assert "Slumped" in p.locator(".hm-an-posture").inner_text() or "slump" in p.locator(".hm-an-posture").inner_text().lower()
    # the table agrees with the figure (trunk inclination of the model)
    trunk = s.js("async () => { const m = await import('/js/human/metrics.js'), r = window.__human.ctx.getRig(), po = r.getPose(); return m.postureMetrics(r.restBody, { root: po.root, angles: po.angles }, po.root).trunkInclination; }")
    shown = p.locator(".hm-an-table tbody tr").first.inner_text().replace("−", "-")
    assert f"{round(trunk)}°" in shown, (trunk, shown)
    # a joint outside its range: listed, and a click selects the joint
    s.js(f"() => {{ {ED}.setOption('enforceRom', false); {ED}.setJoint('elbow_R', 'flex', 170, {{ clamp: false }}); }}")
    p.wait_for_selector(".hm-an-jump", timeout=20000)
    assert "Right elbow" in p.locator(".hm-an-jump").first.inner_text()
    p.locator(".hm-an-jump").first.click()
    p.wait_for_timeout(200)
    assert s.js(f"{HUMAN}.state.selection") == {"kind": "joint", "id": "elbow_R"}
    s.js(f"() => {{ {ED}.setOption('enforceRom', true); {ED}.undo(); }}")
    p.wait_for_function("!document.querySelector('.hm-an-jump')", timeout=20000)
    # reach and view: a display of the scene gives the eye-to-display line
    s.js("""() => { const sb = window.__human.state.sandbox; const seat = [...sb.objects.values()].find((o) => o.type === 'cabin_seat'); const m = sb.add('instrument_panel', { position: [seat.position[0], 0, seat.position[2] + 1.1], yaw: 180, params: { centreHeight: 0.95, tilt: 15, width: 0.9 } }); window.__human.ctx.select({ kind: 'object', id: m.id }); }""")
    p.wait_for_function("document.querySelector('.hm-an-reach').textContent.includes('Eye to')", timeout=20000)
    reach = p.locator(".hm-an-reach").inner_text()
    assert "Eye height" in reach and "Left hand" in reach and "% of the straight-arm reach" in reach, reach
    # REBA data (no score) and model notes
    p.evaluate("document.querySelectorAll('.hm-an-sec').forEach((d) => { d.open = true; })")
    reba = p.locator(".hm-an-reba").inner_text()
    assert "Trunk" in reba and "Upper arm" in reba and "no score" in reba.lower()
    assert re.search(r"(final |total )?score\s*[:=]?\s*\d", reba.lower()) is None, "REBA bands are shown as data: no score"
    notes = p.locator(".hm-an-model").inner_text().lower()
    assert "rigid links" in notes and "no soft tissue" in notes and "boundary case" in notes, notes
    # copy the summary
    p.get_by_role("button", name="Copy summary").click()
    p.wait_for_function("document.querySelector('.hm-an').dataset.copied !== undefined", timeout=20000)
    text = s.js("document.querySelector('.hm-an').__summary")
    assert text.startswith("DIGITAL HUMAN SUMMARY") and "Posture:" in text and "Units: millimetres" in text, text[:200]
    s.shot("analysis", ".hm-left", full_panel=True)
    assert s.errors() == [], s.errors()


def test_unreachable_trunk_move_envelope_attach_and_the_posture_object(s):
    s.boot()
    s.open_scene()
    p = s.page
    s.js(f"() => {{ {ED}.apply('iso-7250-standing', {{ animate: false }}); }}")
    s.js("""() => { const sb = window.__human.state.sandbox; const w = sb.add('steering_wheel', { position: [0, 0, 2.4], yaw: 180, params: { centreHeight: 1.0 } }); window.__human.ctx.select({ kind: 'object', id: w.id }); }""")
    s.placer_ready()
    p.wait_for_timeout(300)
    # out of reach: the shortfall in mm, and the two offers
    s.press("Grab with the hands", "Grab with IK")
    out = s.result("Grab with the hands")
    assert "out of reach" in out and "mm short" in out, out
    sec = s.section("Grab with the hands")
    assert sec.get_by_role("button", name="Move the object within reach").count() == 1 and sec.get_by_role("button", name="Free the trunk and try again").count() == 1
    before = s.js("window.__human.state.sandbox.objects.get([...window.__human.state.sandbox.objects.keys()].pop()).position[2]")
    sec.get_by_role("button", name="Move the object within reach").click()
    p.wait_for_timeout(300)
    assert "Both hands hold" in s.result("Grab with the hands"), s.result("Grab with the hands")
    after = s.js("window.__human.state.sandbox.objects.get([...window.__human.state.sandbox.objects.keys()].pop()).position[2]")
    assert after < before - 1.0, (before, after)
    assert all(e["errMm"] < 1.0 for e in s.js(GRIP_STATE))
    # attach: the wheel follows the hand
    sec.get_by_role("button", name="Attach to hand").click()
    p.wait_for_timeout(200)
    assert s.js("[...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').attachedTo?.id") in ("grip_centre_L", "grip_centre_R")
    assert sec.get_by_role("button", name="Attach to hand").get_attribute("aria-pressed") == "true"
    pos = s.js("[...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').position")
    side = s.js("[...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').attachedTo.id").split("_")[-1]
    s.js(f"{ED}.setJoint('shoulder_{side}', 'flex', 20, {{ clamp: true }})")
    p.wait_for_timeout(200)
    assert s.js("[...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').position") != pos, "the wheel follows the hand it is attached to"
    sec.get_by_role("button", name="Attach to hand").click()
    assert s.js("[...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').attachedTo") is None
    # reach check: each hand, from the stance, to the selected object
    s.js("""() => { const sb = window.__human.state.sandbox; const t = sb.add('floor_tile', { position: [-0.1, 1.0, 0.3] }); const far = sb.add('floor_tile', { position: [0, 1.4, 1.8] }); window.__human.ctx.select({ kind: 'object', id: t.id }); window.__far = far.id; }""")
    p.wait_for_timeout(300)
    s.press("Reach check", "Check reach")
    lines = s.section("Reach check").locator(".hm-pl-facts li").all_inner_texts()
    assert len(lines) == 2 and lines[1].startswith("Right hand") and "reaches it" in lines[1], lines
    s.js("window.__human.ctx.select({ kind: 'object', id: window.__far })")
    p.wait_for_timeout(300)
    s.press("Reach check", "Check reach")
    lines = s.section("Reach check").locator(".hm-pl-facts li").all_inner_texts()
    assert all("cannot reach it" in t and "mm short" in t for t in lines), lines
    # the reach envelope: two translucent clouds in the 3D scene, and gone when switched off
    n0 = s.js("window.__human.viewport.scene.children.length")
    chip = s.section("Reach check").get_by_role("button", name="Show the reach envelope")
    chip.click()
    p.wait_for_timeout(600)
    assert s.js("window.__human.viewport.scene.children.filter((c) => c.name.startsWith('hm-reach-envelope')).length") == 2
    assert s.js("window.__human.viewport.scene.getObjectByName('hm-reach-envelope-R').getObjectByName('points').material.transparent")
    s.shot("envelope")
    s.js(f"{ED}.setHeading(60)")
    p.wait_for_timeout(900)  # rebuilt after the figure has been still
    assert s.js("window.__human.viewport.scene.children.filter((c) => c.name.startsWith('hm-reach-envelope')).length") == 2
    chip.click()
    p.wait_for_timeout(300)
    assert s.js("window.__human.viewport.scene.children.length") == n0
    # the object of the posture: pick a holding posture, press the button, the hands close on the new object
    s.js(f"{ED}.apply('hold-box-chest', {{ animate: false }})")
    p.wait_for_timeout(300)
    sec = s.section("Object of the posture")
    assert "crate" in sec.inner_text().lower()
    n = s.js("window.__human.state.sandbox.objects.size")
    sec.get_by_role("button", name="Add the object this posture uses").click()
    p.wait_for_timeout(400)
    assert s.js("window.__human.state.sandbox.objects.size") == n + 1
    assert s.js("[...window.__human.state.sandbox.objects.values()].pop().type") == "crate"
    assert "Added Crate" in s.result("Object of the posture"), s.result("Object of the posture")
    s.js(f"{HUMAN}.state.sandbox.undo()")
    assert s.js("window.__human.state.sandbox.objects.size") == n, "the sandbox undo removes the object"
    assert s.errors() == [], s.errors()


def test_stand_face_drag_look_at_and_a_new_profile(s):
    s.boot()
    s.open_scene()
    p = s.page
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    s.js("""() => { const sb = window.__human.state.sandbox; const m = sb.add('monitor', { position: [1.5, 0.9, 1.6], yaw: 180 }); window.__human.ctx.select({ kind: 'object', id: m.id }); window.__mon = m.id; }""")
    s.placer_ready()
    # stand at a spot: numeric fields, the middle of the feet goes there
    sec = s.section("Stand at a spot")
    fields = sec.locator("input[type=number]")
    fields.nth(0).fill("500")
    fields.nth(0).dispatch_event("change")
    fields.nth(1).fill("-700")
    fields.nth(1).dispatch_event("change")
    fields.nth(2).fill("120")
    fields.nth(2).dispatch_event("change")
    p.wait_for_timeout(300)
    st = s.js("() => { const r = window.__human.ctx.getRig(), f = r.contactPoints('feet'); return { x: f.reduce((a, q) => a + q.x, 0) / f.length, z: f.reduce((a, q) => a + q.z, 0) / f.length, heading: r.root.heading, low: Math.min(...f.map((q) => q.y)) }; }")
    assert abs(st["x"] - 0.5) < 1e-3 and abs(st["z"] + 0.7) < 1e-3 and abs(st["heading"] - 120) < 1e-6 and abs(st["low"]) < 1e-6, st
    # face the selected object
    s.press("Stand at a spot", "Face the selected object")
    h = s.js("window.__human.ctx.getRig().root.heading")
    exp = s.js("() => { const sb = window.__human.state.sandbox, o = sb.objects.get(window.__mon), a = window.__human.state.postureEditor.place.anchor, c = sb.localToWorld(o.id, o.bbox.getCenter(new o.bbox.min.constructor()).toArray()); return Math.atan2(c.x - a.x, c.z - a.z) * 180 / Math.PI; }")
    assert abs(h - exp) < 1e-6, (h, exp)
    # drag the figure over the floor with the real mouse
    s.js("window.__human.ctx.select(null)")
    s.js("window.__human.ctx.setView('top'); window.__human.ctx.frame(false)")
    p.wait_for_timeout(500)
    chip = s.section("Stand at a spot").get_by_role("button", name="Drag the figure on the floor")
    chip.click()
    assert chip.get_attribute("aria-pressed") == "true"
    xy = s.js("() => { const w = window.__human, a = w.state.postureEditor.place.anchor, o = w.viewport.project(new w.viewport.camera.position.constructor(a.x, 1.0, a.z), {}), rc = w.viewport.canvas.getBoundingClientRect(); return { x: rc.left + o.x, y: rc.top + o.y, visible: o.visible }; }")
    assert xy["visible"], xy
    hist = s.js(f"{ED}.history.steps")
    p.mouse.move(xy["x"], xy["y"])
    p.mouse.down()
    for i in range(1, 13):
        p.mouse.move(xy["x"] + 6 * i, xy["y"] + 3 * i)
        p.wait_for_timeout(30)
    p.mouse.up()
    p.wait_for_timeout(400)
    after = s.js("window.__human.state.postureEditor.place.anchor")
    assert abs(after["x"] - 0.5) > 0.02 or abs(after["z"] + 0.7) > 0.02, f"the figure moved: {after}"
    assert s.js(f"{ED}.history.steps") == hist + 1 and s.js(f"{ED}.history.undoLabel") == "Move the figure"
    chip.click()
    s.js(f"{ED}.undo()")
    # look at the display
    s.js("window.__human.ctx.setView('iso')")
    s.js("window.__human.ctx.select({ kind: 'object', id: window.__mon })")
    p.wait_for_timeout(300)
    sec = s.section("Line of sight")
    assert "Distance eye to display" in sec.locator(".hm-pl-facts").inner_text()
    sec.get_by_role("button", name="Look at the selected display").click()
    p.wait_for_timeout(300)
    assert "Looking at Monitor" in s.result("Line of sight")
    err = s.js("""async () => { const w = window.__human, r = w.ctx.getRig(), sb = w.state.sandbox, q = new r.group.quaternion.constructor(), d = new r.group.position.constructor(); for (const id of ['eye_L', 'eye_R']) d.add(new d.constructor(0, 0, 1).applyQuaternion(r.jointQuaternion(id, q))); d.normalize(); const t = sb.anchorWorld(window.__mon, 'screen_centre'), e = r.landmarkWorld('eye_mid'); return d.angleTo(t.clone().sub(e).normalize()) * 180 / Math.PI; }""")
    assert err < 1.0, f"the gaze is {err:.2f} degrees off the screen centre"
    sec.get_by_role("button", name="Add a viewing measurement").click()
    p.get_by_role("tab", name="Measure").click()
    p.wait_for_selector(".hm-ms-item", timeout=20000)
    assert "View of Monitor" in p.locator(".hm-ms-name").first.input_value()
    assert "above level" in p.locator(".hm-ms-list").inner_text() or "below level" in p.locator(".hm-ms-list").inner_text()
    # a new profile: the rig is replaced, the controls and the Analysis panel keep working
    p.get_by_role("tab", name="Scene").click()
    s.js(f"{ED}.apply('iso-7250-standing', {{ animate: false }})")
    seat_id = s.js("() => { const sb = window.__human.state.sandbox; return sb.add('stool', { position: [-1, 0, 0] }).id; }")
    s.js(f"window.__human.ctx.select({{ kind: 'object', id: '{seat_id}' }})")
    s.press("Sit on the selected seat", "Sit on it")
    old = s.js("window.__human.ctx.getRig().body.profileId")
    s.js("""async () => { const a = await import('/js/human/anthro.js'); await window.__human.ctx.setProfile(a.manualProfile({ sex: 'F', stature: 1580, mass: 58 }), { immediate: true }); }""")
    p.wait_for_function("(old) => { const w = window.__human, b = w.ctx.getBody(); return b && b.profileId !== old && !w.state.busy && w.ctx.getRig().body === b; }", arg=old, timeout=60000)
    p.wait_for_timeout(800)
    st = s.js(SEAT_STATE)
    assert st["mode"] == "seat" and abs(st["seatGapMm"]) < 12, f"the new figure sits on the stool: {st}"
    s.press("Sit on the selected seat", "Adjust seat height to this body")
    assert abs(s.js(SEAT_STATE)["feetGapMm"]) < 12
    open_analysis(s)
    assert s.errors() == [], s.errors()


@pytest.mark.parametrize("width,height,dark", [(1280, 800, True), (390, 800, False), (390, 800, True)])
def test_screenshots_dark_and_phone_and_no_sideways_scroll(chromium, server, width, height, dark):
    with make_session(chromium, server, width=width, height=height, dark=dark, mobile=width < 500) as m:
        m.boot()
        cab(m)
        sit_and_fit(m)
        m.js("window.__human.ctx.select({ kind: 'object', id: [...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').id })")
        m.page.wait_for_timeout(300)
        m.press("Grab with the hands", "Grab with IK")
        m.settle(300)
        assert all(e["errMm"] < 1.0 for e in m.js(GRIP_STATE))
        m.side_view()
        m.shot("sit-and-grab")
        m.shot("stage", ".hm-card")
        m.shot("controls", ".hm-left", full_panel=True)
        if width < 500:
            doc = m.js("document.documentElement.scrollWidth")
            assert doc <= width + 1, f"the Scene tab scrolls sideways: {doc} px in a {width} px window"
            wide = m.js("""(w) => [...document.querySelectorAll('.hm-pl *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && !e.closest('[hidden]'); }).slice(0, 5).map((e) => e.className + ' ' + Math.round(e.getBoundingClientRect().right))""", width)
            assert wide == [], wide
        open_analysis(m)
        m.page.evaluate("document.querySelectorAll('.hm-an-sec').forEach((d) => { d.open = true; })")
        m.page.wait_for_timeout(500)
        m.shot("analysis", ".hm-left", full_panel=True)
        if width < 500:
            doc = m.js("document.documentElement.scrollWidth")
            assert doc <= width + 1, f"the Analysis tab scrolls sideways: {doc} px in a {width} px window"
            wide = m.js("""(w) => [...document.querySelectorAll('.hm-an *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && !e.closest('[hidden]') && !e.closest('.hm-an-scroll'); }).slice(0, 5).map((e) => e.className + ' ' + Math.round(e.getBoundingClientRect().right))""", width)
            assert wide == [], wide
        # dark and light use the page tokens: the verdict box and the diagram are not the other theme's colours
        bg = m.js("getComputedStyle(document.querySelector('.hm-an-svg')).backgroundColor")
        r, g, b = [int(v) for v in bg.replace("rgb(", "").replace(")", "").split(",")[:3]]
        assert ((r + g + b) / 3 < 90) == dark, f"diagram background {bg} in a {'dark' if dark else 'light'} theme"
        assert m.errors() == [], m.errors()


def test_twenty_cycles_leave_no_extra_loops_listeners_geometries_or_canvases(chromium, server):
    with make_session(chromium, server, init=[LEAK_INIT]) as a:
        a.boot()
        cab(a)
        p = a.page
        a.js("window.__human.ctx.select({ kind: 'object', id: [...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').id })")
        sit_and_fit(a)
        a.press("Grab with the hands", "Grab with IK")
        open_analysis(a)
        p.get_by_role("tab", name="Scene").click()
        p.wait_for_timeout(1500)
        stats = "() => ({ raf: window.__raf.size, listeners: window.__nl, canvases: document.querySelectorAll('canvas').length, nodes: document.querySelectorAll('*').length, geometries: window.__human.viewport.renderer.info.memory.geometries, textures: window.__human.viewport.renderer.info.memory.textures, scene: window.__human.viewport.scene.children.length })"
        base = a.js(stats)
        for i in range(20):
            p.get_by_role("tab", name="Scene").click()
            a.press("Sit on the selected seat", "Sit on it")
            a.press("Sit on the selected seat", "Adjust seat to the feet")
            a.js("window.__human.ctx.select({ kind: 'object', id: [...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'steering_wheel').id })")
            a.press("Grab with the hands", "Grab with IK")
            chip = a.section("Reach check").get_by_role("button", name="Show the reach envelope")
            chip.click()
            p.wait_for_timeout(120)
            chip.click()
            p.get_by_role("tab", name="Analysis").click()
            p.wait_for_timeout(120)
            a.js(f"{ED}.apply(['sit-upright-90', 'sit-slumped'][{i} % 2], {{ animate: false, keepPlacement: true }})")
            a.js("window.__human.ctx.select({ kind: 'object', id: [...window.__human.state.sandbox.objects.values()].find((o) => o.type === 'cabin_seat').id })")
        p.get_by_role("tab", name="Scene").click()
        p.wait_for_timeout(1500)
        after = a.js(stats)
        assert after["raf"] <= base["raf"] + 1, f"animation frames still scheduled: {after} vs {base}"
        assert after["listeners"] == base["listeners"], f"listeners leaked: {after} vs {base}"
        assert after["canvases"] == base["canvases"]
        assert after["geometries"] <= base["geometries"] + 2 and after["textures"] <= base["textures"], f"GPU memory grew: {after} vs {base}"
        assert after["scene"] == base["scene"], f"objects of the 3D scene leaked: {after} vs {base}"
        assert after["nodes"] <= base["nodes"] + 30, f"DOM nodes grew: {after} vs {base}"
        # mounting and unmounting the controls leaves nothing behind either
        a.js("""async () => { const m = await import('/js/human/place.js'), sb = window.__human.state.sandbox; for (let i = 0; i < 20; i++) { const host = document.createElement('div'); document.body.append(host); const x = m.mountPlace(host, window.__human.ctx); await x.ready; x.placer.showEnvelope(true); x.placer.setFloorDrag(true); x.dispose(); host.remove(); } }""")
        p.wait_for_timeout(800)
        again = a.js(stats)
        assert again["listeners"] == base["listeners"] and again["scene"] == base["scene"] and again["geometries"] <= base["geometries"] + 2, f"{again} vs {base}"
        assert a.errors() == [], a.errors()
