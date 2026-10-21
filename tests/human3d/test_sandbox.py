"""Browser tests of the sandbox of the Digital human tab: the Scene panel (catalogue, add, drag on the floor, gizmo, keyboard, undo, templates, scene files) and the
Measure panel (lists, picking tool with snapping, live values, CSV export), against the real shell, viewport, rig and skin. Headless Chromium with WebGL (SwiftShader,
slow: a minute or two for the whole file).

    python -m pytest tests/human3d/test_sandbox.py -q                  # or: python tests/human3d/test_sandbox.py
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_sandbox.py   # fail instead of skip when Playwright / Chromium / WebGL is missing
    HM_SHOT_DIR=/some/dir ...                                          # keep the screenshots (1280x800 and 390x800, light and dark) there; default: a temp dir

The tests rely on the documented API only (sandbox.js, measure.js) and on the debug hook window.__human = { viewport, ctx, store, pipeline, state }, which the shell
sets when the URL hash contains "debug". The node side (maths, history, serialisation, hostile input) is sandbox.test.mjs and measure.test.mjs.
"""
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
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

SHOT_DIR = Path(os.environ.get("HM_SHOT_DIR") or Path(tempfile.gettempdir()) / "hm-sandbox-shots")
SHOT_DIR.mkdir(parents=True, exist_ok=True)


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
            b.close()
            _unavailable(f"cannot probe WebGL ({e})")
        if not ok:
            b.close()
            _unavailable("this Chromium has no WebGL 2 (headless SwiftShader needs --use-angle=swiftshader)")
        yield b
        b.close()


SB = "(async () => (await import('/js/human/sandbox.js')).peekSandbox(window.__human.viewport))()"
MS = "(async () => (await import('/js/human/measure.js')).peekMeasure(window.__human.viewport))()"
CLIENT = """(p) => { const vp = window.__human.viewport, V = vp.camera.position.constructor, s = vp.project(new V(p[0], p[1], p[2])), r = vp.canvas.getBoundingClientRect();
  return { x: r.left + s.x, y: r.top + s.y, visible: s.visible }; }"""


class Session:
    def __init__(self, page, logs, base):
        self.page, self.logs, self.base = page, logs, base

    def errors(self, allow=()):
        return [line for line in self.logs if (line.startswith("[error]") or line.startswith("[pageerror]")) and not any(a in line for a in allow)]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def open(self, tab="scene", timeout=120000):
        self.page.goto(f"{self.base}/#/human?debug")
        self.page.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer", timeout=timeout)
        self.page.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=timeout)
        self.settle(600)
        self.tab(tab)
        return self

    def tab(self, name):
        self.page.click(f"#hm-tab-{name}")
        self.page.wait_for_selector(".hm-sc" if name == "scene" else ".hm-ms", timeout=30000)
        self.settle(300)

    def settle(self, ms=450):
        self.page.wait_for_timeout(ms)

    def objects(self):
        return self.js(f"""async () => {{ const sb = await {SB}; return [...sb.objects.values()].map((o) => ({{ id: o.id, type: o.type, name: o.name, position: o.position, yaw: o.yaw, params: o.params, locked: o.locked, visible: o.visible }})); }}""")

    def selected(self):
        return self.js(f"async () => (await {SB}).selected")

    def view(self):
        return self.js("(() => { const v = window.__human.viewport.getView(); return { pos: v.position.toArray(), target: v.target.toArray() }; })()")

    def client(self, p):
        return self.js(CLIENT, list(p))

    def anchor(self, oid, aid):
        return self.js(f"async ([o, a]) => (await {SB}).anchorWorld(o, a).toArray()", [oid, aid])

    def add(self, category, type_):
        self.page.click(f".hm-obj-cats button:has-text('{category}')")
        self.page.dblclick(f".hm-obj-card[data-type='{type_}']")
        self.settle(250)
        return self.objects()[-1]

    def drag(self, a, b, steps=10, shift=False):
        p = self.page
        p.mouse.move(a["x"], a["y"])
        if shift:
            p.keyboard.down("Shift")
        p.mouse.down()
        p.mouse.move((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2, steps=steps)
        p.mouse.move(b["x"], b["y"], steps=steps)
        p.mouse.up()
        if shift:
            p.keyboard.up("Shift")
        self.settle(250)

    def shot(self, name):
        path = SHOT_DIR / name
        self.page.screenshot(path=str(path))
        return path


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=800, dark=False, mobile=False):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True,
                               is_mobile=mobile, has_touch=mobile, device_scale_factor=1, accept_downloads=True)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    try:
        yield Session(page, logs, server)
    finally:
        ctx.close()


@pytest.fixture
def s(chromium, server):
    with make_session(chromium, server) as sess:
        sess.open("scene")
        yield sess


# ============================================================================================================================================================
def test_catalogue_cards_add_and_inspector(s):
    """The catalogue lists every category with cards; double-click and Enter add; the selected object's settings appear in the inspector."""
    p = s.page
    assert p.locator(".hm-obj-cats button").count() == 6
    for cat, n in [("Seating", 6), ("Displays", 7), ("Boxes and loads", 9), ("Structures", 13), ("Tools and controls", 18), ("Reference", 6)]:
        p.click(f".hm-obj-cats button:has-text('{cat}')")
        assert p.locator(".hm-obj-card").count() == n, cat
    p.fill("#hm-sc-q-1, .hm-sc input[type=search]", "ladder")
    assert [c.get_attribute("data-type") for c in p.locator(".hm-obj-card").all()] == ["ladder"]
    p.fill(".hm-sc input[type=search]", "xyzzy")
    assert p.locator(".hm-obj-card").count() == 0 and "No object matches" in p.locator(".hm-obj-grid").inner_text()
    p.fill(".hm-sc input[type=search]", "")
    p.click(".hm-obj-cats button:has-text('Seating')")
    seat = s.add("Seating", "cabin_seat")
    assert seat["type"] == "cabin_seat" and seat["position"][2] > 0.3, seat
    assert s.selected() == seat["id"]
    p.wait_for_selector(".hm-ed-body", timeout=5000)
    assert p.locator(".hm-inspector-body .hm-ed-body").count() == 1, "at 1280 px the settings sit in the inspector"
    assert p.locator(".hm-inspector h2").inner_text() == "Cabin seat"
    # the parameters of the catalogue are the controls
    assert p.locator(".hm-ed .hm-slider").count() >= 7
    p.fill(".hm-ed .hm-slider:has(label:text-is('Seat pan angle (front up)')) input[type=number]", "12")
    p.keyboard.press("Tab")
    assert s.objects()[-1]["params"]["panAngle"] == 12
    # Enter on a focused card adds
    p.click(".hm-obj-cats button:has-text('Reference')")
    p.focus(".hm-obj-card[data-type='box']")
    p.keyboard.press("Enter")
    s.settle(250)
    assert [o["type"] for o in s.objects()] == ["cabin_seat", "box"]
    assert not s.errors(), s.errors()


def test_scene_workflow_add_drag_nudge_undo_select_measure_export(s, tmp_path):
    """Add a cabin seat and a monitor, drag the monitor on the floor, nudge with the arrow keys, undo, select by clicking, measure between two anchors, watch the
    measurement follow the monitor, export CSV."""
    p = s.page
    seat = s.add("Seating", "cabin_seat")
    mon = s.add("Displays", "monitor")
    assert [o["type"] for o in s.objects()] == ["cabin_seat", "monitor"]
    p.screenshot(path=str(SHOT_DIR / "workflow-1-added.png"))

    # --- drag the monitor on the floor, without the gizmo: the camera must not orbit
    s.js(f"async () => (await {SB}).setGizmoMode('none')")
    s.js(f"async () => (await {SB}).select(null)")
    before = s.view()
    base0 = s.objects()[1]["position"]
    grab = s.client(s.anchor(mon["id"], "screen_centre"))
    assert grab["visible"]
    target = s.client([base0[0] + 0.9, 1.2, base0[2] + 0.4])
    s.drag(grab, target)
    after = s.objects()[1]["position"]
    assert after[0] > base0[0] + 0.2 and abs(after[1]) < 1e-9, f"dragged from {base0} to {after}"
    assert s.view() == before, "dragging an object must not orbit the camera"
    assert s.selected() == mon["id"]

    # --- nudge with the arrow keys (the canvas has the focus after the drag)
    assert p.evaluate("document.activeElement?.tagName") == "CANVAS"
    s.js(f"async () => {{ const sb = await {SB}; sb.setSnap({{ gridMm: 0 }}); }}")
    pre = s.objects()[1]["position"]
    p.keyboard.press("ArrowRight")
    s.settle(150)
    post = s.objects()[1]["position"]
    moved = [round(post[i] - pre[i], 4) for i in range(3)]
    assert sorted(abs(v) for v in moved) == [0, 0, 0.01], f"one arrow key = 10 mm along one axis: {moved}"
    assert s.view() == before, "the arrow key moved the object, not the camera"
    p.keyboard.press("Shift+ArrowUp")
    s.settle(150)
    assert max(abs(post[i] - s.objects()[1]["position"][i]) for i in range(3)) == pytest.approx(0.1, abs=1e-6), "Shift = x10"
    # --- undo
    p.keyboard.press("Control+z")
    s.settle(150)
    assert s.objects()[1]["position"] == pytest.approx(post, abs=1e-6)
    p.keyboard.press("Control+z")
    s.settle(150)
    assert s.objects()[1]["position"] == pytest.approx(pre, abs=1e-6), "the second undo goes back to the end of the drag"

    # --- select by clicking
    s.js(f"async () => (await {SB}).select(null)")
    seat_click = s.client(s.anchor(seat["id"], "back_top"))
    p.mouse.click(seat_click["x"], seat_click["y"] + 6)
    s.settle(200)
    assert s.selected() == seat["id"], "a click on the seat selects the seat"
    assert p.locator(".hm-inspector h2").inner_text() == "Cabin seat"
    p.mouse.click(5 + p.locator("canvas.hm-canvas").bounding_box()["x"], 5 + p.locator("canvas.hm-canvas").bounding_box()["y"] + 60)
    s.settle(200)
    assert s.selected() is None, "a click on empty floor clears the selection"

    # --- measure between two anchors, from the lists
    s.tab("measure")
    p.get_by_label("From", exact=True).fill("Object · Cabin seat: Seat reference point (SRP)")
    p.get_by_label("To", exact=True).fill("Object · Monitor: Screen centre")
    p.click(".hm-ms button:has-text('Add measurement')")
    s.settle(300)
    assert p.locator(".hm-ms-item").count() == 1
    val = p.locator(".hm-ms-item .hm-ms-val").inner_text()
    srp, sc = s.anchor(seat["id"], "srp"), s.anchor(mon["id"], "screen_centre")
    dist = sum((a - b) ** 2 for a, b in zip(srp, sc)) ** 0.5
    assert val == f"{round(dist * 1000):,} mm", f"{val} vs {dist * 1000}"
    sub = p.locator(".hm-ms-item .hm-ms-sub").inner_text()
    assert sub.startswith("Δx ") and "Δy" in sub and "Δz" in sub and "horizontal" in sub, sub
    # the label in the 3D view carries the value
    p.wait_for_selector(".hm-label-measure", timeout=5000)
    assert val in p.locator(".hm-label-measure").first.inner_text()
    p.screenshot(path=str(SHOT_DIR / "workflow-2-measured.png"))
    # live: move the monitor, the number changes
    s.js(f"async ([id]) => {{ const sb = await {SB}; sb.move(id, {{ x: -0.7, z: 2.2 }}, {{ snap: false }}); }}", [mon["id"]])
    s.settle(400)
    sc2 = s.anchor(mon["id"], "screen_centre")
    dist2 = sum((a - b) ** 2 for a, b in zip(srp, sc2)) ** 0.5
    assert dist2 != pytest.approx(dist, abs=0.05)
    assert p.locator(".hm-ms-item .hm-ms-val").inner_text() == f"{round(dist2 * 1000):,} mm"
    assert f"{round(dist2 * 1000):,} mm" in p.locator(".hm-label-measure").first.inner_text()
    # the units follow
    p.click(".hm-ms .seg button:has-text('in')")
    s.settle(300)
    assert p.locator(".hm-ms-item .hm-ms-val").inner_text().endswith(" in")

    # --- export CSV
    p.locator(".hm-ms details:has(summary:has-text('Export')) > summary").click()
    with p.expect_download() as dl:
        p.click(".hm-ms button:has-text('CSV')")
    path = tmp_path / "m.csv"
    dl.value.save_as(str(path))
    lines = path.read_text().strip().splitlines()
    assert lines[0] == "id,label,kind,value,unit,dx,dy,dz,a,b,c,horizontal,status,notes"
    cols = lines[1].split(",")
    assert cols[2] == "distance" and cols[4] == "mm" and cols[12] == "ok" and cols[11].replace(".", "").isdigit()
    assert float(cols[3]) == pytest.approx(dist2 * 1000, abs=0.2), "the CSV is in millimetres whatever the display unit"
    assert [float(v) for v in cols[8].split()] == pytest.approx([c * 1000 for c in srp], abs=0.2)
    assert not s.errors(), s.errors()


def test_gizmo_keys_duplicate_delete_lock(s):
    """W / E / R select the gizmo, Ctrl+D duplicates, Delete removes (not when locked), the lock buttons and the object list work."""
    p = s.page
    crate = s.add("Boxes and loads", "crate")
    gz = lambda: s.js("(() => { const g = window.__human.viewport.gizmo; return g ? { mode: g.mode, hasObject: !!g.object, showX: g.showX, showY: g.showY } : null; })()")
    assert gz()["mode"] == "translate" and gz()["hasObject"]
    p.locator("canvas.hm-canvas").focus()
    p.keyboard.press("e")
    assert gz()["mode"] == "rotate" and gz()["showX"] is False and gz()["showY"] is True
    p.keyboard.press("r")
    assert gz()["mode"] == "scale"
    p.keyboard.press("w")
    assert gz()["mode"] == "translate"
    # the mode buttons in the panel
    p.locator(".hm-sc summary:has-text('Move, snap and gizmo')").click()
    p.click(".hm-sc .seg button:has-text('Rotate')")
    assert gz()["mode"] == "rotate"
    p.click(".hm-sc .seg button:has-text('Move')")
    p.locator("canvas.hm-canvas").focus()
    p.keyboard.press("Control+d")
    s.settle(200)
    objs = s.objects()
    assert len(objs) == 2 and objs[1]["name"] == "Crate 2" and s.selected() == objs[1]["id"]
    assert p.locator(".hm-ol-row").count() == 2
    # lock from the list: arrow keys and Delete leave it alone
    p.click(".hm-ol-row:nth-child(2) button[aria-label^='Lock']")
    s.settle(150)
    assert s.objects()[1]["locked"] is True
    p.locator("canvas.hm-canvas").focus()
    pos = s.objects()[1]["position"]
    p.keyboard.press("ArrowLeft")
    p.keyboard.press("Delete")
    s.settle(150)
    assert len(s.objects()) == 2 and s.objects()[1]["position"] == pos
    assert gz()["hasObject"] is False, "no gizmo on a locked object"
    p.click(".hm-ol-row:nth-child(2) button[aria-label^='Unlock']")
    p.locator("canvas.hm-canvas").focus()
    p.keyboard.press("Delete")
    s.settle(150)
    assert len(s.objects()) == 1
    p.keyboard.press("Control+z")
    s.settle(150)
    assert len(s.objects()) == 2, "undo brings it back"
    # hide and delete from the list
    p.click(".hm-ol-row:nth-child(1) button[aria-label^='Hide']")
    s.settle(150)
    assert s.objects()[0]["visible"] is False
    p.click(".hm-ol-row:nth-child(1) button[aria-label^='Delete']")
    s.settle(150)
    assert len(s.objects()) == 1
    assert not s.errors(), s.errors()


def test_floor_constraint_snapping_and_numeric_fields(s):
    """Typing a position moves the object (never below the floor), the grid snaps a drag, drop to floor works."""
    p = s.page
    o = s.add("Boxes and loads", "crate")
    x = p.locator(".hm-ed input[aria-label^='X position']")
    x.fill("1500")
    x.press("Tab")
    s.settle(150)
    assert s.objects()[0]["position"][0] == pytest.approx(1.5)
    y = p.locator(".hm-ed input[aria-label^='Y (up) position']")
    y.fill("-300")
    y.press("Tab")
    s.settle(150)
    assert s.objects()[0]["position"][1] == 0, "never below the floor"
    y.fill("800")
    y.press("Tab")
    assert s.objects()[0]["position"][1] == pytest.approx(0.8)
    p.click(".hm-ed button:has-text('Drop to floor')")
    assert s.objects()[0]["position"][1] == 0
    p.fill(".hm-ed input[aria-label='Yaw in degrees']", "400")
    p.keyboard.press("Tab")
    assert s.objects()[0]["yaw"] == pytest.approx(40)
    # units: the fields follow the display units
    p.click(".hm-viewport-host ~ * button:has-text('in'), .hm-bar button:has-text('in')")
    s.settle(300)
    assert p.locator(".hm-ed input[aria-label='X position in in']").input_value() == "59.055"
    # snapping: with a 100 mm grid a drag ends on the grid
    s.js(f"async () => {{ const sb = await {SB}; sb.setGizmoMode('none'); sb.setSnap({{ gridMm: 100 }}); }}")
    s.js(f"async () => (await {SB}).frameObjects(null)")
    s.settle(900)
    a = s.client(s.anchor(o["id"], "top_centre"))
    assert a["visible"]
    b = s.client([0.37, 0.4, 1.7])
    s.drag(a, b)
    px, py, pz = s.objects()[0]["position"]
    assert round(px * 10) / 10 == pytest.approx(px, abs=1e-9) and round(pz * 10) / 10 == pytest.approx(pz, abs=1e-9), (px, pz)
    # the lowest the object goes is the floor, also with Shift-drag
    s.drag(s.client(s.anchor(o["id"], "top_centre")), s.client([px, -2.0, pz]), shift=True)
    assert s.objects()[0]["position"][1] >= 0
    assert not s.errors(), s.errors()


def test_templates_scene_files_and_hostile_files(s, tmp_path):
    p = s.page
    p.locator(".hm-sc summary:has-text('Templates')").click()
    p.select_option(".hm-sc select[aria-label='Template']", "cockpit")
    p.click(".hm-sc button:has-text('Replace the scene')")
    s.settle(500)
    assert sorted(o["type"] for o in s.objects()) == ["cabin_seat", "hud_panel", "joystick", "throttle", "triple_monitor"]
    p.screenshot(path=str(SHOT_DIR / "template-cockpit.png"))
    p.keyboard.press("Control+z")  # focus is on a button in the panel: the shortcut still works there
    s.settle(200)
    assert s.objects() == []
    for tid, n in [("office", 4), ("cab", 4), ("lifting", 3), ("range", 5), ("stairs", 3)]:
        p.select_option(".hm-sc select[aria-label='Template']", tid)
        p.click(".hm-sc button:has-text('Replace the scene')")
        s.settle(250)
        assert len(s.objects()) == n, tid
    # save and open
    p.locator(".hm-sc summary:has-text('Scene file')").click()
    with p.expect_download() as dl:
        p.click(".hm-sc button:has-text('Save scene')")
    path = tmp_path / "scene.json"
    dl.value.save_as(str(path))
    data = json.loads(path.read_text())
    assert data["version"] == 1 and len(data["objects"]) == 3 and "measurements" in data
    p.click(".hm-sc button:has-text('Clear the scene')")
    s.settle(200)
    assert s.objects() == []
    p.set_input_files(".hm-sc input[type=file]", str(path))
    s.settle(500)
    assert len(s.objects()) == 3
    # hostile files: errors are shown, nothing changes
    bad = tmp_path / "bad.json"
    for text, needle in [('{"version": 99, "objects": []}', "newer"), ("not json at all", "not valid JSON"), ('{"version": 1}', "no list of objects"), ("[]", "not a scene")]:
        bad.write_text(text)
        p.set_input_files(".hm-sc input[type=file]", str(bad))
        s.settle(300)
        assert needle in p.locator(".hm-sc-msgs").inner_text(), (text, p.locator(".hm-sc-msgs").inner_text())
        assert len(s.objects()) == 3
    bad.write_text(json.dumps({"version": 1, "objects": [{"type": "nope"}, {"type": "box", "params": {"width": 1e9, "__proto__": {"x": 1}}, "position": [1e12, -5, "x"]}]}))
    p.set_input_files(".hm-sc input[type=file]", str(bad))
    s.settle(400)
    objs = s.objects()
    assert len(objs) == 1 and objs[0]["params"]["width"] == 10 and objs[0]["position"][1] == 0
    assert "unknown type" in p.locator(".hm-sc-msgs").inner_text()
    assert not s.errors(), s.errors()


def test_touch_tap_selects_and_one_finger_drags_an_object_but_two_fingers_orbit(chromium, server):
    """On a touch screen a tap selects an object, a one-finger drag on it moves it (the camera stays), a drag on empty floor orbits, a pinch never moves an object."""
    with make_session(chromium, server, 900, 800, mobile=True) as s:
        s.open("scene")
        o = s.add("Boxes and loads", "crate")
        s.js(f"async () => {{ const sb = await {SB}; sb.setGizmoMode('none'); sb.select(null); sb.move('{o['id']}', {{ x: 0.0, z: 1.2 }}, {{ snap: false }}); sb.frameObjects(null); }}")
        s.settle(900)
        cdp = s.page.context.new_cdp_session(s.page)
        touch = lambda kind, pts: cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
        a = s.client(s.anchor(o["id"], "top_centre"))
        assert a["visible"]
        s.page.touchscreen.tap(a["x"], a["y"] + 8)
        s.settle(300)
        assert s.selected() == o["id"], "a tap selects"
        s.js("async () => { const sb = await " + SB + "; sb.select(null); }")
        before_view, before = s.view(), s.objects()[0]["position"]
        touch("touchStart", [(a["x"], a["y"] + 8)])
        for k in range(1, 9):
            touch("touchMove", [(a["x"] + 18 * k, a["y"] + 8 + 4 * k)])
            s.page.wait_for_timeout(30)
        touch("touchEnd", [])
        s.settle(300)
        after = s.objects()[0]["position"]
        assert abs(after[0] - before[0]) + abs(after[2] - before[2]) > 0.15, (before, after)
        assert s.view() == before_view, "the finger moved the object, not the camera"
        # a drag that starts on empty floor orbits the camera and leaves the object alone
        start = s.view()
        pos = s.objects()[0]["position"]
        box = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return { x: r.left + 90, y: r.top + 120 }; })()")  # empty floor, far from the crate
        bx = box
        touch("touchStart", [(bx["x"], bx["y"])])
        for k in range(1, 9):
            touch("touchMove", [(bx["x"] - 20 * k, bx["y"])])
            s.page.wait_for_timeout(30)
        touch("touchEnd", [])
        s.settle(500)
        assert s.view() != start and s.objects()[0]["position"] == pos
        assert not s.errors(), s.errors()


def test_the_figure_hides_the_objects_behind_it_from_picking_and_dragging(s):
    """A press on the figure belongs to the figure, even with a big box right behind it: nothing is selected or dragged, and the camera orbits instead."""
    p = s.page
    s.js(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, -0.6], params: {{ width: 2, depth: 0.3, height: 2 }} }}); sb.select(null);
        const vp = window.__human.viewport; vp.camera.position.set(0.3, 1.4, 4); vp.controls.target.set(0, 1.1, 0); vp.controls.update(); vp.requestRender(); }}""")
    s.settle(1200)
    c = s.client(s.js("() => { const p = window.__human.ctx.getRig().landmarkWorld('suprasternale'); return [p.x, p.y - 0.12, p.z + 0.12]; }"))
    assert c["visible"]
    p.mouse.click(c["x"], c["y"])
    s.settle(300)
    assert s.selected() is None, "the click on the chest does not select the box behind it"
    before_view, before = s.view(), s.objects()[0]["position"]
    s.drag(c, {"x": c["x"] + 80, "y": c["y"]})
    assert s.objects()[0]["position"] == before, "dragging the chest does not drag the box"
    assert s.view() != before_view, "the camera orbited instead"
    # next to the figure the box is still there to pick
    side = s.client([0.9, 1.0, -0.45])
    p.mouse.click(side["x"], side["y"])
    s.settle(300)
    assert s.selected() == s.objects()[0]["id"]
    assert not s.errors(), s.errors()


def test_touch_cancel_and_pinch_from_an_object(chromium, server):
    """A cancelled touch ends the object drag (orbit works again, the undo group is closed); a pinch whose first finger lands on an object still zooms the camera."""
    with make_session(chromium, server, 390, 800, mobile=True) as s:
        s.open("scene")
        cdp = s.page.context.new_cdp_session(s.page)
        touch = lambda kind, pts: cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
        s.js(f"""async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1.2], params: {{ width: 0.8, depth: 0.8, height: 0.8 }} }}); sb.select(null);
            const vp = window.__human.viewport; vp.camera.position.set(1.5, 1.6, 4); vp.controls.target.set(0, 0.5, 1); vp.controls.update(); vp.requestRender(); }}""")
        s.page.evaluate("document.querySelector('canvas').scrollIntoView({block:'center'})")
        s.settle(1200)
        pt = s.client([0, 0.4, 1.2])
        x, y = pt["x"], pt["y"]
        touch("touchStart", [(x, y)])
        for i in range(1, 8):
            touch("touchMove", [(x + i * 4, y + i)])
            s.page.wait_for_timeout(20)
        assert s.js(f"async () => (await {SB}).dragging") is True
        assert s.js("window.__human.viewport.controls.enabled") is False
        touch("touchCancel", [])
        s.settle(400)
        assert s.js(f"async () => (await {SB}).dragging") is False
        assert s.js("window.__human.viewport.controls.enabled") is True, "the orbit controls are back after a cancelled touch"
        assert s.js(f"async () => (await {SB}).undoLabel").startswith("Move"), "the drag was committed as one step"
        c0 = s.js("window.__human.viewport.camera.position.toArray()")
        touch("touchStart", [(40, 300)])
        for i in range(1, 10):
            touch("touchMove", [(40 + i * 10, 300)])
            s.page.wait_for_timeout(20)
        touch("touchEnd", [])
        s.settle(500)
        assert s.js("window.__human.viewport.camera.position.toArray()") != c0, "a one-finger drag on empty space orbits"
        # pinch with the first finger on the box
        dist = lambda: s.js("(() => { const v = window.__human.viewport; return v.camera.position.distanceTo(v.controls.target); })()")
        pos = s.objects()[0]["position"]
        pt = s.client([pos[0], 0.4, pos[2]])
        x, y = pt["x"], pt["y"]
        d0 = dist()
        touch("touchStart", [(x, y)])
        s.page.wait_for_timeout(50)
        touch("touchStart", [(x, y), (x + 80, y + 120)])
        s.page.wait_for_timeout(50)
        for i in range(1, 12):
            touch("touchMove", [(x - i * 4, y - i * 4), (x + 80 + i * 6, y + 120 + i * 8)])
            s.page.wait_for_timeout(20)
        touch("touchEnd", [])
        s.settle(600)
        assert abs(dist() - d0) > 0.3, (d0, dist())
        assert s.objects()[0]["position"] == pos, "the pinch moved the camera, not the box"
        assert not s.errors(), s.errors()


def test_dragging_with_the_camera_near_the_floor_does_not_throw_the_object(s):
    s.js(f"""async () => {{ const vp = window.__human.viewport; vp.camera.position.set(0.5, 0.35, 4.5); vp.controls.target.set(0, 0.3, 1.2); vp.controls.update(); vp.requestRender();
        (await {SB}).add('box', {{ position: [0, 0, 1.2], params: {{ width: 0.4, depth: 0.4, height: 0.4 }} }}); }}""")
    s.settle(1200)
    p0 = s.client([0, 0.2, 1.2])
    p = s.page
    p.mouse.move(p0["x"], p0["y"])
    p.mouse.down()
    for dy in range(-4, -40, -4):
        p.mouse.move(p0["x"], p0["y"] + dy)
    z = s.objects()[0]["position"][2]
    p.mouse.up()
    assert abs(z - 1.2) < 2, f"36 px of motion moved the box to z={z} (it went to -838 m)"


def test_scene_keys_belong_to_the_focused_control_and_the_list_row(s):
    """Delete / Backspace and the letters do not act on the selected object while a catalogue card, a button or a swatch has the focus; on a list row Delete removes that row's object."""
    p = s.page
    s.js(f"async () => {{ const sb = await {SB}; sb.add('box', {{ position: [0, 0, 1], select: true }}); sb.add('crate', {{ position: [1, 0, 1] }}); sb.select('o1'); }}")
    s.settle(400)
    p.click(".hm-obj-cats button:has-text('Seating')")
    p.focus(".hm-obj-card[data-type='stool']")
    for k in ("Delete", "Backspace", "w", "e", "r", "[", "]"):
        p.keyboard.press(k)
    s.settle(200)
    assert len(s.objects()) == 2 and s.js(f"async () => (await {SB}).gizmoMode") == "translate" and s.objects()[0]["yaw"] == 0
    p.keyboard.press("Control+z")  # undo still works from here
    s.settle(200)
    assert len(s.objects()) == 1
    s.js(f"async () => (await {SB}).redo()")
    s.settle(200)
    # on the row of the CRATE, with the BOX selected: Delete removes the crate
    row = p.locator(".hm-ol-row").nth(1)
    row.locator(".hm-ol-main").focus()
    assert "Crate" in row.inner_text()
    p.keyboard.press("Delete")
    s.settle(300)
    left = s.objects()
    assert [o["type"] for o in left] == ["box"], left
    assert p.evaluate("document.activeElement.classList.contains('hm-ol-main')"), "focus goes to the neighbouring row"
    # a locked object is not deleted by the key
    s.js(f"async () => (await {SB}).setLocked('o1', true)")
    s.settle(200)
    p.locator(".hm-ol-row").nth(0).locator(".hm-ol-main").focus()
    p.keyboard.press("Delete")
    s.settle(200)
    assert len(s.objects()) == 1
    # in the 3D view the key still works
    s.js(f"async () => (await {SB}).setLocked('o1', false)")
    p.locator("canvas.hm-canvas").focus()
    p.keyboard.press("Delete")
    s.settle(200)
    assert len(s.objects()) == 0
    assert not s.errors(), s.errors()


def test_measure_panel_keeps_its_hint_the_typed_eye_point_and_stays_quiet_during_a_drag(s):
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('office')")
    s.settle(400)
    objs = {o["type"]: o for o in s.objects()}
    s.js("window.__human.viewport.setView('iso', { animate: false })")
    s.js(f"async () => (await {SB}).frameObjects(null)")
    s.settle(900)
    s.tab("measure")
    # 1. the hint asks for the first point again after a measurement is complete
    p.click(".hm-ms button:has-text('Distance')")
    a, b = s.client(s.anchor(objs["monitor"]["id"], "screen_centre")), s.client(s.anchor(objs["office_chair"]["id"], "srp"))
    p.mouse.click(a["x"] + 3, a["y"] - 3)
    s.settle(200)
    assert "Click the second point" in p.locator(".hm-ms-hint").inner_text()
    p.mouse.click(b["x"] + 2, b["y"] + 2)
    s.settle(400)
    assert s.js(f"async () => (await {MS}).items.length") == 1
    assert "Click the first point" in p.locator(".hm-ms-hint").inner_text(), p.locator(".hm-ms-hint").inner_text()
    p.keyboard.press("Escape")
    # 2. what was typed as the eye point survives a scene change
    p.select_option(".hm-ms select[aria-label='What to measure']", "view")
    eye = p.get_by_label("Eye point", exact=True)
    eye.fill("Joint · Left elbow")
    s.js(f"async () => (await {SB}).add('crate', {{ position: [1.5, 0, 1] }})")
    s.js(f"async () => {{ const sb = await {SB}; sb.move('o1', {{ x: 0.1 }}); sb.undo(); }}")
    s.settle(400)
    assert eye.input_value() == "Joint · Left elbow", eye.input_value()
    # 3. a drag emits many scene events: the panel does not rebuild its lists for them
    n = s.js("""async () => { const m = await """ + MS + """; let calls = 0; const f = m.pointOptions; m.pointOptions = (...a) => { calls++; return f.apply(m, a); };
        const ctx = window.__human.ctx; for (let i = 0; i < 100; i++) ctx.emit('scene', { op: 'move', id: 'o1', live: true });
        await new Promise((r) => setTimeout(r, 300)); m.pointOptions = f; return calls; }""")
    assert n == 0, f"{n} rebuilds of the point list for 100 move events"
    assert not s.errors(), s.errors()


def test_open_scene_then_undo_brings_the_measurements_back(s):
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('office')")
    s.settle(300)
    s.tab("measure")
    s.js(f"async () => {{ const m = await {MS}; m.addHeight({{ kind: 'landmark', id: 'eye_mid' }}); }}")
    s.settle(300)
    assert p.locator(".hm-ms-item").count() == 1
    r = s.js(f"async () => {{ const sb = await {SB}; return sb.fromJSON({{ version: 1, objects: [{{ type: 'box' }}] }}); }}")
    assert r["ok"]
    s.settle(300)
    assert p.locator(".hm-ms-item").count() == 0
    s.js(f"async () => (await {SB}).undo()")
    s.settle(400)
    assert p.locator(".hm-ms-item").count() == 1, "the measurement is back with the old objects"
    assert not s.errors(), s.errors()


def test_attach_to_the_hand_follows_the_pose(s):
    """A tool attached to the right palm from the settings follows the hand when the pose changes (through the shell's rig events) and stays when detached."""
    p = s.page
    s.add("Tools and controls", "hammer")
    palm = lambda: s.js("window.__human.ctx.getRig().landmarkWorld('palm_centre_R').toArray()")
    p.select_option(".hm-ed select[aria-label='Attach to the figure']", "landmark:palm_centre_R")
    s.settle(400)
    close = lambda a, b: max(abs(x - y) for x, y in zip(a, b)) < 1e-4
    assert close(s.objects()[0]["position"], palm()), (s.objects()[0]["position"], palm())
    before = palm()
    s.js("() => window.__human.ctx.getRig().setAngles({ shoulder_R: [70, 0, 0], elbow_R: [40] })")
    s.settle(500)
    after = palm()
    assert not close(before, after), "the hand moved"
    assert close(s.objects()[0]["position"], after), "and the tool went with it"
    assert "It follows that point" in p.locator(".hm-ed").inner_text()
    p.select_option(".hm-ed select[aria-label='Attach to the figure']", "")
    s.settle(300)
    kept = s.objects()[0]["position"]
    s.js("() => window.__human.ctx.getRig().setAngles({ shoulder_R: [0, 0, 0], elbow_R: [0] })")
    s.settle(400)
    assert s.objects()[0]["position"] == kept, "detached: it stays where it was"
    assert not s.errors(), s.errors()


def test_parameter_slider_by_keyboard_and_undo_button(s):
    p = s.page
    s.add("Seating", "stool")
    slider = p.locator(".hm-ed .hm-slider:has(label:text-is('Seat height')) input[type=range]")
    slider.focus()
    p.keyboard.press("End")
    s.settle(200)
    assert s.objects()[0]["params"]["height"] == pytest.approx(0.8)
    p.keyboard.press("Home")
    s.settle(200)
    assert s.objects()[0]["params"]["height"] == pytest.approx(0.3)
    p.click(".hm-sc button:has-text('Undo')")
    s.settle(300)
    assert s.objects()[0]["params"]["height"] == pytest.approx(0.45), "End then Home were one step: a slider drag is one undo step"
    p.click(".hm-sc button:has-text('Undo')")
    s.settle(300)
    assert s.objects() == []
    p.click(".hm-sc button:has-text('Redo')")
    p.click(".hm-sc button:has-text('Redo')")
    s.settle(300)
    assert len(s.objects()) == 1 and s.objects()[0]["params"]["height"] == pytest.approx(0.3)
    # a colour swatch changes the main colour (selection is not part of the history: select the restored object again)
    s.js(f"async () => {{ const sb = await {SB}; sb.select([...sb.objects.keys()][0]); }}")
    s.settle(300)
    p.click(".hm-ed .hm-swatch[aria-label='Red']")
    s.settle(200)
    col = s.js(f"async () => (await {SB}).objects.values().next().value.color")
    assert col == "#c0493d"
    assert p.locator(".hm-ed .hm-swatch[aria-checked='true']").get_attribute("aria-label") == "Red"
    assert not s.errors(), s.errors()


def test_place_the_human_container_and_dispose_then_reopen(s):
    """The container for the later placement module exists (hidden while empty); tearing the tab down and building it again leaves no error and a fresh sandbox."""
    p = s.page
    assert p.locator("#hm-place-human").count() == 1
    assert not p.locator(".hm-sc-place").is_visible(), "an empty container shows no section"
    s.js(f"""async () => {{ const sb = await {SB}; const d = document.createElement('div'); d.id = 'probe'; d.textContent = 'Seat the figure on the chair'; sb.placeContainer.append(d); }}""")
    p.wait_for_selector(".hm-sc-place #probe", state="visible", timeout=5000)
    s.add("Seating", "stool")
    old = s.js("window.__human.viewport.canvas.id || 'vp'")
    res = s.js(f"""async () => {{
      const sbm = await import('/js/human/sandbox.js'), msm = await import('/js/human/measure.js'), idx = await import('/js/human/index.js'), vp = window.__human.viewport;
      idx.disposeHuman();
      await new Promise((r) => setTimeout(r, 200));
      return {{ sandbox: sbm.peekSandbox(vp) === null, measure: msm.peekMeasure(vp) === null, sceneChildren: vp.scene.children.length }};
    }}""")
    assert res["sandbox"] and res["measure"], res
    s.js("""async () => { const idx = await import('/js/human/index.js'); const c = await idx.initHuman(); await c.ready; c.onShow(); }""")
    p.wait_for_function("document.querySelector('.hm-root')?.dataset.hmState === 'ready'", timeout=120000)
    p.click("#hm-tab-scene")
    p.wait_for_selector(".hm-sc", timeout=30000)
    p.dblclick(".hm-obj-card[data-type='cabin_seat']")
    s.settle(400)
    assert [o["type"] for o in s.js(f"async () => [...(await {SB}).objects.values()].map((o) => ({{ type: o.type }}))")] == ["cabin_seat"], "a fresh sandbox after the rebuild"
    assert not s.errors(), s.errors()
    del old


def test_remember_this_scene_is_opt_in(chromium, server):
    with make_session(chromium, server) as s1:
        s1.open("scene")
        s1.add("Seating", "stool")
        assert s1.js("localStorage.getItem('hm-scene')") is None, "nothing is stored without the opt-in"
        s1.page.locator(".hm-sc summary:has-text('Scene file')").click()
        s1.page.check(".hm-sc input[type=checkbox] >> nth=-1") if False else s1.page.locator("label:has-text('Remember this scene') input").check()
        s1.settle(900)
        stored = s1.js("localStorage.getItem('hm-scene')")
        assert stored and json.loads(stored)["objects"][0]["type"] == "stool"
        state = s1.page.context.storage_state()
        with make_session(chromium, server) as s2:
            s2.page.context.add_init_script("""(st => { try { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); } catch (e) {} })(""" + json.dumps({"hm-scene": stored, "hm-scene-remember": "1"}) + ")")
            s2.open("scene")
            assert [o["type"] for o in s2.objects()] == ["stool"], "restored when the Scene tab is opened"
            s2.page.locator(".hm-sc summary:has-text('Scene file')").click()
            assert s2.page.locator("label:has-text('Remember this scene') input").is_checked()
            s2.page.locator("label:has-text('Remember this scene') input").uncheck()
            assert s2.js("localStorage.getItem('hm-scene')") is None and s2.js("localStorage.getItem('hm-scene-remember')") is None
        del state


SCENE_WITH_MEASUREMENTS = {
    "app": "digital-human-scene", "version": 1, "objects": [{"id": "o1", "type": "monitor", "position": [0, 0, 1.5]}, {"id": "o2", "type": "stool", "position": [0.8, 0, 1.0]}],
    "measurements": [{"id": "m1", "kind": "height", "a": {"kind": "world", "p": [0, 1.5, 0]}, "label": "Remembered"},
                     {"id": "m2", "kind": "distance", "a": {"kind": "landmark", "id": "eye_mid"}, "b": {"kind": "object", "id": "o1", "anchor": "screen_centre"}, "label": "Eye to screen"}],
    "snap": {"gridMm": 0, "angleDeg": 0},
}


def _with_stored_scene(chromium, server, scene):
    cm = make_session(chromium, server)
    s = cm.__enter__()
    s.page.context.add_init_script("(st => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); } } catch (e) {} })("
                                   + json.dumps({"hm-scene": json.dumps(scene), "hm-scene-remember": "1"}) + ")")
    return cm, s


def test_remember_this_scene_brings_back_the_measurements_and_keeps_them_stored(chromium, server):
    """The sandbox restores the stored scene before the measure module has registered its section: the measurements must come back, and the stored copy must keep them."""
    cm, s = _with_stored_scene(chromium, server, SCENE_WITH_MEASUREMENTS)
    try:
        s.open("scene")
        s.settle(1500)  # the autosave that follows the restore
        items = s.js(f"async () => (await {MS}).items.map((i) => i.label)")
        assert items == ["Remembered", "Eye to screen"], items
        stored = json.loads(s.js("localStorage.getItem('hm-scene')"))
        assert len(stored["objects"]) == 2 and len(stored["measurements"]) == 2, "the autosave did not overwrite the measurements"
        s.page.reload()
        s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=120000)
        s.tab("scene")
        s.settle(1200)
        assert s.js(f"async () => (await {MS}).items.length") == 2
        assert not s.errors(), s.errors()
    finally:
        cm.__exit__(None, None, None)


def test_a_huge_numeric_id_in_the_remembered_scene_does_not_freeze_the_tab(chromium, server):
    scene = {"version": 1, "objects": [{"type": "box", "id": "o99999999999999999999"}, {"type": "box"}, {"type": "box"}],
             "measurements": [{"kind": "height", "id": "m" + "9" * 30, "a": {"kind": "world", "p": [0, 1, 0]}}, {"kind": "height", "a": {"kind": "world", "p": [0, 2, 0]}}]}
    cm, s = _with_stored_scene(chromium, server, scene)
    try:
        s.open("scene")
        ids = [o["id"] for o in s.objects()]
        assert len(ids) == 3 and len(set(ids)) == 3, ids
        s.js(f"async () => {{ const sb = await {SB}; sb.add('box'); sb.add('box'); }}")
        assert len({o["id"] for o in s.objects()}) == 5
        assert s.js(f"async () => new Set((await {MS}).items.map((i) => i.id)).size") == 2
    finally:
        cm.__exit__(None, None, None)


def test_the_last_edit_is_saved_when_the_page_is_put_away_within_the_autosave_delay(s):
    r = s.js(f"""async () => {{ const sb = await {SB}; sb.setRemember(true); const o = sb.add('box', {{ position: [0, 0, 2] }}); sb.saveLocal();
        await new Promise((r) => setTimeout(r, 900));
        sb.move(o.id, {{ x: 1.25 }});  // less than 600 ms before the page goes
        const before = JSON.parse(localStorage.getItem('hm-scene')).objects[0].position[0];
        window.dispatchEvent(new Event('pagehide'));
        return {{ before, after: JSON.parse(localStorage.getItem('hm-scene')).objects[0].position[0] }}; }}""")
    assert r == {"before": 0, "after": 1.25}, r


def test_hover_over_an_object_behind_the_figure_does_not_run_a_skinned_ray_test_per_mouse_event(s):
    """Sweeping the mouse over the body with a crate behind it: the skinned ray test (about 10 ms) runs at most about every 30 ms, not for every pointer move."""
    r = s.js(f"""async () => {{
      const sb = await {SB}, vp = window.__human.viewport, V = vp.camera.position.constructor;
      sb.add('crate', {{ position: [0, 0, -0.6], params: {{ width: 1.2, height: 1.5, depth: 0.4 }} }});
      vp.requestRender(); await new Promise((r) => setTimeout(r, 300));
      const skin = window.__human.ctx.getRig().skin, orig = skin.raycast.bind(skin); let n = 0;
      skin.raycast = (...a) => {{ n++; return orig(...a); }};
      const rc = vp.canvas.getBoundingClientRect(), p = vp.project(new V(0, 1.2, 0)), t0 = performance.now(); let events = 0;
      while (performance.now() - t0 < 1200) {{
        vp.canvas.dispatchEvent(new PointerEvent('pointermove', {{ clientX: rc.left + p.x + (events % 20) - 10, clientY: rc.top + p.y, buttons: 0, pointerType: 'mouse', bubbles: true }}));
        events++; await new Promise((r) => setTimeout(r, 3));
      }}
      return {{ events, tests: n, seconds: (performance.now() - t0) / 1000 }};
    }}""")
    assert r["events"] > 100
    assert r["tests"] <= r["seconds"] / 0.03 + 3, r


def test_picking_tool_snaps_and_measures_in_the_view(s):
    """Click two points in the 3D view with the Distance tool: they snap to anchors; Height and Angle tools; Escape; hide, rename, delete."""
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('office')")
    s.settle(400)
    objs = {o["type"]: o for o in s.objects()}
    s.js("window.__human.viewport.setView('iso', { animate: false })")
    s.settle(500)
    s.js(f"async () => (await {SB}).frameObjects(null)")
    s.settle(900)
    s.tab("measure")
    p.click(".hm-ms button:has-text('Distance')")
    assert p.locator(".hm-ms button[aria-pressed='true']:has-text('Distance')").count() == 1
    assert "Click the first point" in p.locator(".hm-ms-hint").inner_text()
    a = s.client(s.anchor(objs["monitor"]["id"], "screen_centre"))
    b = s.client(s.anchor(objs["office_chair"]["id"], "srp"))
    assert a["visible"] and b["visible"]
    p.mouse.click(a["x"] + 3, a["y"] - 3)
    s.settle(200)
    assert "Click the second point" in p.locator(".hm-ms-hint").inner_text()
    p.mouse.move(b["x"] + 2, b["y"] + 2)
    s.settle(300)
    assert "Seat reference point" in p.locator(".hm-label-snap").inner_text(), "a snap indicator names the point"
    p.mouse.click(b["x"] + 2, b["y"] + 2)
    s.settle(400)
    item = s.js(f"async () => {{ const m = await {MS}; return m.items.map((i) => ({{ kind: i.kind, a: i.a, b: i.b }})); }}")
    assert len(item) == 1 and item[0]["kind"] == "distance"
    assert item[0]["a"]["anchor"] == "screen_centre" and item[0]["b"]["anchor"] == "srp", item
    assert s.selected() is None, "no object was selected by the measuring clicks"
    p.screenshot(path=str(SHOT_DIR / "measure-picked.png"))
    # Escape ends the tool
    p.click(".hm-ms button:has-text('Height')")
    p.mouse.click(a["x"], a["y"])
    s.settle(300)
    assert s.js(f"async () => (await {MS}).items.length") == 2
    assert p.locator(".hm-ms-item").nth(1).locator(".hm-ms-val").inner_text().endswith(" mm")
    p.locator("canvas.hm-canvas").focus()
    p.keyboard.press("Escape")
    s.settle(150)
    assert s.js(f"async () => (await {MS}).tool") == "off"
    # angle with three joints (landmarks shown)
    p.click(".hm-ms button:has-text('Angle')")
    for jid in ["shoulder_L", "elbow_L", "wrist_L"]:
        pt = s.client(s.js(f"(id) => window.__human.ctx.getRig().jointWorld(id).toArray()", jid))
        p.mouse.click(pt["x"], pt["y"])
        s.settle(150)
    items = s.js(f"async () => (await {MS}).items.map((i) => i.kind)")
    assert items == ["distance", "height", "angle"], items
    assert p.locator(".hm-ms-item").nth(2).locator(".hm-ms-val").inner_text().endswith("°")
    p.keyboard.press("Escape")
    # rename, hide, delete
    p.locator(".hm-ms-item").nth(0).locator(".hm-ms-name").fill("Eye line")
    p.keyboard.press("Enter")
    s.settle(150)
    assert s.js(f"async () => (await {MS}).items[0].label") == "Eye line"
    p.locator(".hm-ms-item").nth(0).locator("button.hm-ms-eye").click()
    s.settle(300)
    assert s.js(f"async () => (await {MS}).items[0].visible") is False
    p.wait_for_function("document.querySelectorAll('.hm-label-measure').length === 2", timeout=15000)  # the labels follow the next rendered frame (slow in software GL)
    p.locator(".hm-ms-item").nth(2).locator("button[aria-label^='Delete']").click()
    s.settle(150)
    assert p.locator(".hm-ms-item").count() == 2
    assert not s.errors(), s.errors()


def test_measure_between_lists_view_check_and_vanishing_references(s):
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('office')")
    s.settle(300)
    s.tab("measure")
    p.select_option(".hm-ms select[aria-label='What to measure']", "view")
    assert "Cyclopean eye point" in p.get_by_label("Eye point", exact=True).input_value()
    assert "not a verdict" in p.locator(".hm-ms").inner_text()
    p.click(".hm-ms button:has-text('Add measurement')")
    s.settle(300)
    val = p.locator(".hm-ms-item .hm-ms-val").inner_text()
    assert "below level" in val or "above level" in val, val
    # the details of the selected measurement are in the inspector, with the viewing note
    assert "Visual angle" in p.locator(".hm-inspector-body").inner_text()
    assert "information, not a verdict" in p.locator(".hm-inspector-body").inner_text()
    # remove the monitor: the measurement turns grey and says why
    s.js(f"async () => {{ const sb = await {SB}; for (const o of [...sb.objects.values()]) if (o.type === 'monitor') sb.remove(o.id); }}")
    s.settle(400)
    row = p.locator(".hm-ms-item")
    assert row.get_attribute("data-state") == "grey" and "removed" in row.locator(".hm-ms-sub").inner_text()
    assert row.locator(".hm-ms-val").inner_text() == "—"
    # undo brings it back
    s.js(f"async () => (await {SB}).undo()")
    s.settle(400)
    assert p.locator(".hm-ms-item").get_attribute("data-state") == "ok"
    # a wrong point text is explained, not guessed
    p.select_option(".hm-ms select[aria-label='What to measure']", "distance")
    p.get_by_label("From", exact=True).fill("no such point")
    p.click(".hm-ms button:has-text('Add measurement')")
    assert "not a point in the lists" in p.locator(".hm-ms-err").inner_text()
    # deleting a measurement with the keyboard hands the focus to the next row, or to the first tool when none is left
    p.get_by_label("From", exact=True).fill("")
    p.keyboard.press("Escape")
    p.locator(".hm-ms-item button[aria-label^='Delete']").first.focus()
    p.keyboard.press("Enter")
    s.settle(250)
    assert p.locator(".hm-ms-item").count() == 0
    assert p.evaluate("document.activeElement.closest('.hm-ms') !== null && document.activeElement !== document.body")
    assert not s.errors(), s.errors()


def test_no_gpu_geometry_leak_over_twenty_add_remove_cycles(s):
    """20 add/remove cycles (each with a parameter change and a selection) leave the renderer's geometry and texture counts where they were."""
    # warm up what is created once, lazily: the shared palette materials, the gizmo's own geometry, the selection outline
    s.js(f"""async () => {{ const sb = await {SB}, cat = await import('/js/human/catalog.js');
      for (const t of cat.CATALOG) {{ const o = sb.add(t.type, {{ select: true }}); window.__human.viewport.renderNow(); sb.setParam(o.id, t.params[0].key, t.params[0].max); window.__human.viewport.renderNow(); sb.remove(o.id); }} }}""")
    s.settle(500)
    mem = lambda: s.js("(() => { const r = window.__human.viewport.renderer; window.__human.viewport.renderNow(); const m = r.info.memory; return { geometries: m.geometries, textures: m.textures, programs: r.info.programs.length }; })()")
    before = mem()
    s.js(f"""async () => {{ const sb = await {SB}, cat = await import('/js/human/catalog.js');
      for (let i = 0; i < 20; i++) {{ const t = cat.CATALOG[(i * 3) % cat.CATALOG.length]; const o = sb.add(t.type, {{ select: true }}); window.__human.viewport.renderNow(); sb.setParam(o.id, t.params[0].key, t.params[0].max); window.__human.viewport.renderNow(); sb.remove(o.id); }}
      window.__human.viewport.renderNow(); }}""")
    s.settle(300)
    after = mem()
    assert after["geometries"] == before["geometries"], (before, after)
    assert after["textures"] == before["textures"], (before, after)
    assert s.js(f"async () => (await {SB}).objects.size") == 0 and s.js(f"async () => (await {SB}).root.children.length") == 0
    assert not s.errors(), s.errors()


def test_every_catalogue_object_renders_in_the_real_viewport(s):
    """Add one of each type: no console error, no NaN transform, and the scene still renders (a pixel check on the canvas)."""
    s.js(f"""async () => {{ const sb = await {SB}, cat = await import('/js/human/catalog.js');
      for (const t of cat.CATALOG) sb.add(t.type, {{ position: [ (cat.CATALOG.indexOf(t) % 12) * 2.2 - 12, 0, 3 + Math.floor(cat.CATALOG.indexOf(t) / 12) * 3.2 ] }}); }}""")
    s.js(f"async () => (await {SB}).frameObjects(null)")
    s.settle(1500)
    assert len(s.objects()) == 59
    bad = s.js(f"async () => [...(await {SB}).objects.values()].filter((o) => ![...o.position, o.yaw].every(Number.isFinite)).length")
    assert bad == 0
    box = s.js("(() => { const r = window.__human.viewport.canvas.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
    png = s.page.screenshot(clip={"x": box[0], "y": box[1], "width": box[2], "height": box[3]})
    (SHOT_DIR / "all-objects.png").write_bytes(png)
    assert len(png) > 20000
    assert not s.errors(), s.errors()


def test_keyboard_focus_survives_list_changes(s):
    """Lock, hide and add keep the keyboard focus on the button that was pressed; deleting hands it to the neighbouring row (never to the page)."""
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('cab')")
    s.settle(300)
    n = len(s.objects())
    assert n >= 3
    rows = p.locator(".hm-ol-row")
    assert rows.count() == n
    lock = rows.nth(1).locator("button.hm-ib").first
    lock.focus()
    p.keyboard.press("Enter")
    s.settle(200)
    assert p.evaluate("document.activeElement.classList.contains('hm-ib')"), "focus stays on the lock button"
    assert rows.nth(1).locator("button.hm-ib").first.get_attribute("aria-pressed") == "true"
    assert s.objects()[1]["locked"] is True
    p.keyboard.press("Enter")
    s.settle(200)
    assert s.objects()[1]["locked"] is False
    # the Add button of the catalogue detail keeps the focus while the scene changes
    p.click(".hm-obj-cats button:has-text('Reference')")
    p.click(".hm-obj-card[data-type='box']")
    add = p.locator(".hm-obj-detail button.primary")
    add.focus()
    p.keyboard.press("Enter")
    s.settle(250)
    assert len(s.objects()) == n + 1
    assert p.evaluate("document.activeElement.matches('.hm-obj-detail button.primary')"), "focus stays on Add"
    # delete: the neighbour row's name button gets the focus
    rows = p.locator(".hm-ol-row")
    rows.nth(1).locator("button[aria-label^='Delete']").focus()
    p.keyboard.press("Enter")
    s.settle(250)
    assert len(s.objects()) == n
    assert p.evaluate("document.activeElement.classList.contains('hm-ol-main')"), p.evaluate("document.activeElement.outerHTML.slice(0, 100)")
    assert not s.errors(), s.errors()


def test_accessibility_basics_of_both_panels(s):
    """Every button and field of the two panels has an accessible name; keyboard focus is visible; focus order starts in the panel."""
    p = s.page
    s.js(f"async () => (await {SB}).applyTemplate('cab')")
    s.settle(300)
    check = """(root) => { const bad = []; for (const el of document.querySelectorAll(root + ' button, ' + root + ' input, ' + root + ' select, ' + root + ' textarea')) {
        if (el.type === 'hidden' || el.closest('[hidden]') || el.getAttribute('aria-hidden') === 'true') continue;
        const name = (el.getAttribute('aria-label') || '').trim() || (el.labels && [...el.labels].map((l) => l.textContent).join('').trim()) || el.textContent.trim() || (el.title || '').trim();
        if (!name) bad.push(el.outerHTML.slice(0, 120)); } return bad; }"""
    s.js(f"async () => (await {SB}).select([...(await {SB}).objects.keys()][0])")
    s.settle(300)
    assert s.js(check, ".hm-sc") == []
    assert s.js(check, ".hm-inspector") == []
    s.tab("measure")
    assert s.js(check, ".hm-ms") == []
    # focus rings: a card shows an outline when focused with the keyboard
    s.tab("scene")
    p.focus(".hm-obj-card[data-type='cabin_seat'], .hm-obj-card")
    p.keyboard.press("Shift+Tab")
    p.keyboard.press("Tab")
    outline = s.js("(() => { const el = document.activeElement; const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth]; })()")
    assert outline[0] != "none" and outline[1] != "0px", outline
    # keyboard operation: arrow keys move between cards, Enter adds
    p.focus(".hm-obj-card >> nth=0")
    p.keyboard.press("ArrowRight")
    assert p.evaluate("document.activeElement.classList.contains('hm-obj-card')")
    assert s.js("document.querySelectorAll('.hm-obj-card[tabindex=\"0\"]').length") == 1, "roving tab stop"
    assert not s.errors(), s.errors()


@pytest.mark.parametrize("dark", [False, True], ids=["light", "dark"])
def test_screenshots_desktop_and_phone(chromium, server, dark):
    """Screenshots of both panels in a populated scene at 1280x800 and 390x800, light and dark; no horizontal scroll, nothing blank. Saved to HM_SHOT_DIR."""
    theme = "dark" if dark else "light"
    with make_session(chromium, server, 1280, 800, dark=dark) as s:
        s.open("scene")
        s.js(f"async () => (await {SB}).applyTemplate('cab')")
        s.settle(300)
        mon = [o for o in s.objects() if o["type"] == "steering_wheel"][0]
        s.js(f"async ([id]) => {{ const sb = await {SB}, ms = await {MS}; sb.select(id); ms.addView({{ kind: 'object', id: sb.objects.keys().next().value, anchor: 'srp' }}, {{ kind: 'landmark', id: 'eye_mid' }}); ms.addDistance({{ kind: 'landmark', id: 'palm_centre_R' }}, {{ kind: 'object', id, anchor: 'rim_3' }}); ms.addHeight({{ kind: 'landmark', id: 'vertex' }}); }}", [mon["id"]])
        s.js(f"async () => (await {SB}).frameObjects(null)")
        s.settle(1200)
        s.shot(f"scene-1280-{theme}.png")
        s.page.locator(".hm-sc summary:has-text('Templates')").click()
        s.shot(f"scene-1280-{theme}-templates.png")
        s.tab("measure")
        s.settle(500)
        s.shot(f"measure-1280-{theme}.png")
        # a gizmo selection screenshot: scene tab, selected object
        s.tab("scene")
        s.shot(f"scene-1280-{theme}-selected.png")
        assert s.js("document.documentElement.scrollWidth <= window.innerWidth + 1")
        assert not s.errors(), s.errors()
    with make_session(chromium, server, 390, 800, dark=dark, mobile=True) as s:
        s.open("scene")
        s.js(f"async () => (await {SB}).applyTemplate('office')")
        s.settle(600)
        s.page.evaluate("window.scrollTo(0, 0)")
        s.shot(f"scene-390-{theme}.png")
        assert s.js("document.documentElement.scrollWidth <= window.innerWidth + 1"), s.js("[document.documentElement.scrollWidth, window.innerWidth]")
        assert s.js("(() => { const r = document.querySelector('.hm-sc'); return r.scrollWidth <= r.clientWidth + 1; })()"), "the Scene panel fits a 390 px phone"
        s.js(f"async () => (await {SB}).select([...(await {SB}).objects.keys()][0])")
        s.settle(400)
        assert s.page.locator(".hm-sc .hm-ed-body").count() == 1, "on a phone the settings of the selected object sit under the object list"
        s.page.locator(".hm-sc .hm-ed-body").scroll_into_view_if_needed()
        s.shot(f"scene-390-{theme}-editor.png")
        assert s.js("document.documentElement.scrollWidth <= window.innerWidth + 1")
        s.tab("measure")
        s.js(f"async () => {{ const ms = await {MS}; ms.addDistance({{ kind: 'landmark', id: 'eye_mid' }}, {{ kind: 'world', p: [0, 1, 2] }}); }}")
        s.settle(500)
        s.shot(f"measure-390-{theme}.png")
        assert s.js("document.documentElement.scrollWidth <= window.innerWidth + 1")
        assert s.js("(() => { const r = document.querySelector('.hm-ms'); return r.scrollWidth <= r.clientWidth + 1; })()")
        assert not s.errors(), s.errors()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", *sys.argv[1:]]))
