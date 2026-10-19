"""Browser tests of the Export panel of the Digital human tab (site/js/human/panels/export.js and export.js): the real page in headless Chromium with WebGL
(SwiftShader), the real shell, fit.js, rig.js and the data under public/api/v1. Every download is made with page.expect_download and read back here:
GLB, OBJ, STL, BVH, the CSV and JSON tables, the exchange JSON, posture and scene files, the PNG images (decoded with Pillow: not blank, transparency, size,
the view put back afterwards), the mobile layout (390 x 800), the dark theme and the console.

    python -m pytest tests/human3d/test_export.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_export.py   # fail instead of skip when Playwright / Chromium / WebGL / the data is missing
    HM_SHOTS=/some/dir ...                                            # also save screenshots there
    CHROMIUM=/path/to/chrome ...                                      # default: /opt/pw-browsers/chromium (see shot.py)

The formats themselves are tested without a browser in tests/human3d/export.test.mjs (independent parsers, forward kinematics, a second skinning of the GLB).
"""
import contextlib
import io
import json
import os
import re
import struct
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
if "comingSoon" in (ROOT / "site/js/human/panels/export.js").read_text():
    _unavailable("panels/export.js is still the stub")

CLIPBOARD = ["clipboard-read", "clipboard-write"]
# the skin generator (body.js) belongs to another engineer and may be mid-edit; the shell then says so and shows the skeleton only
OTHER_MODULES = ("the skin generator (body.js) failed to load",)
SLUG = "united-states-army-men-p50"


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
    def __init__(self, page, logs, base):
        self.page, self.logs, self.base = page, logs, base

    def errors(self, allow=()):
        return [ln for ln in self.logs if (ln.startswith("[error]") or ln.startswith("[pageerror]")) and not any(a in ln for a in (*OTHER_MODULES, *allow))]

    def js(self, expr, *args):
        return self.page.evaluate(expr, *args) if args else self.page.evaluate(expr)

    def open(self, hash_="#/human?debug", sections=True):
        p = self.page
        p.goto(f"{self.base}/{hash_}")
        p.wait_for_function("window.__human && window.__human.state.rig && window.__human.viewport.renderer && !window.__human.state.busy", timeout=90000)
        p.get_by_role("tab", name="Export").click()
        p.wait_for_selector(".hm-ex .hm-ex-card", timeout=30000)
        if sections:
            self.open_sections()
        return self

    def open_sections(self):
        self.js("document.querySelectorAll('.hm-ex details.hm-section').forEach((d) => { d.open = true; })")

    def button(self, name, exact=False):
        return self.page.locator(".hm-ex").get_by_role("button", name=name, exact=exact)

    def grab(self, name, exact=False, timeout=120000):
        """Click a button and return (suggested file name, bytes) of the download it starts."""
        with self.page.expect_download(timeout=timeout) as info:
            self.button(name, exact).click()
        d = info.value
        return d.suggested_filename, Path(d.path()).read_bytes()

    def wait_idle(self, timeout=60000):
        self.page.wait_for_function("() => !document.querySelector('.hm-ex')?.hasAttribute('aria-busy')", timeout=timeout)

    def last(self):
        return self.page.locator(".hm-ex-last").inner_text()

    def shot(self, name, selector=".hm-ex"):
        if SHOTS:
            Path(SHOTS).mkdir(parents=True, exist_ok=True)
            self.page.locator(selector).first.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


@contextlib.contextmanager
def make_session(chromium, server, width=1280, height=900, dark=False, mobile=False):
    ctx = chromium.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", ignore_https_errors=True, is_mobile=mobile, has_touch=mobile,
                               device_scale_factor=1, accept_downloads=True)
    try:
        ctx.grant_permissions(CLIPBOARD, origin=server)
    except Exception:  # noqa: BLE001
        pass
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
        yield sess


def glb(data):
    """(json, bin) of a GLB, with the container rules checked."""
    assert data[:4] == b"glTF"
    version, total = struct.unpack("<II", data[4:12])
    assert version == 2 and total == len(data) and total % 4 == 0
    jl, jt = struct.unpack("<II", data[12:20])
    assert jt == 0x4E4F534A
    doc = json.loads(data[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack("<II", data[off:off + 8]) if off < len(data) else (0, 0)
    assert off + 8 + bl == len(data) if bl else off == len(data)
    return doc, data[off + 8:off + 8 + bl]


def png(data):
    pil = pytest.importorskip("PIL.Image")
    im = pil.open(io.BytesIO(data))
    im.load()
    return im


def settle(state):
    """The viewport state with the camera rounded to the nanometre: OrbitControls recomputes the position from spherical coordinates, which moves the last digits."""
    return {k: ([round(x, 9) for x in v] if k in ("pos", "target") else v) for k, v in state.items()}


def parse_csv(text):
    import csv
    return list(csv.reader(io.StringIO(text)))


# ---------------------------------------------------------------------------------------------------------------------------------- tests
def test_every_format_downloads_a_real_file(s):
    s.open()
    p = s.page
    joint_ids = s.js("import('/js/human/skeleton.js').then((m) => m.JOINTS.map((j) => j.id))")
    assert len(joint_ids) == 77
    s.js("window.__human.ctx.setPosture({ id: 'sit-upright-90', name: 'Seated upright (90-90-90)' })")
    p.wait_for_timeout(300)
    assert "Seated upright" in p.locator(".hm-ex-state").inner_text()

    # GLB
    name, data = s.grab("Download GLB")
    assert name == f"{SLUG}_sit-upright-90_figure.glb", name
    doc, bin_ = glb(data)
    assert [n["name"] for n in doc["nodes"] if n["name"] in joint_ids] and {n["name"] for n in doc["nodes"]} >= set(joint_ids)
    assert len(doc["skins"]) == 1 and doc["skins"][0]["joints"] and len(doc["skins"][0]["joints"]) == 77
    assert doc["asset"]["extras"]["units"] == "m" and doc["asset"]["extras"]["posture"]["id"] == "sit-upright-90"
    assert len(bin_) > 100000 and len(data) < 12e6
    assert "Saved" in s.last() and "77 joints" in s.last()
    s.shot("export-glb-done")

    # OBJ and STL (millimetres by default)
    name, data = s.grab("Download OBJ")
    assert name == f"{SLUG}_sit-upright-90_mesh_mm.obj", name
    text = data.decode("ascii")
    assert text.startswith("# Digital human OBJ export") and "Units: millimetres" in text and "up = +Y, the figure faces +Z" in text
    assert len(re.findall(r"^v ", text, re.M)) > 5000 and re.findall(r"^f ", text, re.M)
    name, data = s.grab("Download STL")
    assert name == f"{SLUG}_sit-upright-90_mesh_mm.stl", name
    n = struct.unpack("<I", data[80:84])[0]
    assert len(data) == 84 + 50 * n and n > 5000 and not data[:5] == b"solid" and b"units mm" in data[:80]

    # BVH, with and without the extras
    name, data = s.grab("Download BVH")
    assert name == f"{SLUG}_sit-upright-90_skeleton_cm.bvh", name
    text = data.decode("ascii")
    assert text.startswith("HIERARCHY\nROOT pelvis") and "MOTION\nFrames: 1\n" in text and text.count("JOINT ") == 76
    s.page.get_by_label("Add a second frame with the neutral standing pose").check()
    s.page.get_by_label("Comment lines at the top", exact=False).first.check()
    _, data = s.grab("Download BVH")
    text = data.decode("ascii")
    assert text.startswith("# Digital human BVH export") and "Frames: 2" in text and "Seated upright" in text

    # the tables
    expect = {
        "Download Joint centres and landmarks as CSV": ("points", ["type", "id", "label", "group", "kind", "attached_to", "x_mm", "y_mm", "z_mm"], 77 + 100),
        "Download Joint angles as CSV": ("angles", ["joint_id", "joint_label", "group", "side", "dof_key"], 100),
        "Download Dimensions (mapping table) as CSV": ("dimensions", ["id", "label", "value", "unit", "status"], 40),
        "Download Fit report as CSV": ("fit-report", ["id", "label", "kind", "posture", "unit", "input", "model"], 40),
        "Download Posture metrics as CSV": ("metrics", ["group", "key", "label", "unit", "value"], 50),
    }
    s.page.get_by_label("Comment lines (#) with profile").uncheck()
    for button, (what, columns, min_rows) in expect.items():
        name, data = s.grab(button)
        assert name == f"{SLUG}_sit-upright-90_{what}.csv", name
        rows = parse_csv(data.decode("utf-8"))
        assert rows[0][:len(columns)] == columns, rows[0]
        assert len(rows) - 1 >= min_rows and all(len(r) == len(rows[0]) for r in rows), (what, len(rows))
    name, data = s.grab("Download Joint angles as JSON")
    doc = json.loads(data)
    assert doc["format"] == "human-joint-angles" and doc["units"] == {"angle": "deg"} and doc["posture"]["id"] == "sit-upright-90" and len(doc["rows"]) > 100

    # the exchange JSON, checked by the validator of the same module
    name, data = s.grab("Download JSON", exact=True)
    assert name == f"{SLUG}_sit-upright-90_exchange.json", name
    res = s.js("(text) => import('/js/human/export.js').then((m) => m.validateExchange(text))", data.decode("utf-8"))
    assert res["ok"], res
    doc = json.loads(data)
    assert doc["units"] == "mm" and doc["axes"]["up"] == "+Y" and len(doc["body"]["joints"]) == 77 and doc["posture"]["id"] == "sit-upright-90"
    assert 1700 < doc["body"]["stature_mm"] < 1800

    # posture file
    name, data = s.grab("Download posture file")
    doc = json.loads(data)
    assert name == f"{SLUG}_sit-upright-90_posture.json" and doc["app"] == "digital-human-posture" and doc["version"] == 1
    assert doc["library_posture"] is False and doc["posture"]["id"] == "custom-sit-upright-90" and doc["shell"]["id"] == "sit-upright-90", "the figure is not in that library posture, so a custom posture is written"
    assert s.errors() == [], s.errors()


def test_glb_options_clip_skeleton_and_none(s):
    s.open()
    s.page.locator(".hm-ex").get_by_role("button", name="Neutral and clip").click()
    name, data = s.grab("Download GLB")
    assert name.endswith("_figure_clip.glb"), name
    doc, _ = glb(data)
    assert len(doc["animations"]) == 1 and len(doc["animations"][0]["channels"]) == 78
    assert all("rotation" not in n for n in doc["nodes"] if n["name"] in ("pelvis", "L5", "head")), "the bind pose of the file is neutral"
    s.page.locator(".hm-ex").get_by_role("button", name="Skeleton only").click()
    name, data = s.grab("Download GLB")
    doc, _ = glb(data)
    assert name.endswith("_skeleton_clip.glb") and [n["name"] for n in doc["nodes"] if "mesh" in n] == ["skeleton-sticks"] and len(data) < 400000
    s.page.locator(".hm-ex").get_by_role("button", name="None").click()
    s.button("Download GLB").click()
    s.page.wait_for_selector(".hm-ex-msgs [role=alert]", timeout=30000)
    assert "Nothing is selected" in s.page.locator(".hm-ex-msgs").inner_text()
    s.page.locator(".hm-ex-msgs button[aria-label^='Dismiss']").click()
    assert s.page.locator(".hm-ex-msgs").inner_text().strip() == ""
    # OBJ in metres with Z up
    s.page.locator(".hm-ex").get_by_role("button", name="Metres", exact=True).click()
    s.page.get_by_label("Axes", exact=True).select_option("z-up")
    name, data = s.grab("Download OBJ")
    text = data.decode("ascii")
    assert name.endswith("_mesh_m-z-up.obj") and "Units: metres" in text and "up = +Z, the figure faces -Y" in text
    zs = [float(m) for m in re.findall(r"^v \S+ \S+ (\S+)$", text, re.M)]
    assert 0.9 < max(zs) - min(zs) < 2.3, "the height of the figure is along Z, in metres"
    assert s.errors() == [], s.errors()


def test_mesh_quality_note_and_high_quality(s):
    s.open()
    p = s.page
    quality = s.js("window.__human.state.quality")
    if quality == "high":
        s.js("window.__human.ctx.setQuality('low')")
        p.wait_for_function("window.__human.state.rig && window.__human.state.rig.quality === 'low' && !window.__human.state.busy", timeout=60000)
    note = p.locator(".hm-ex-quality")
    p.wait_for_function("document.querySelector('.hm-ex-quality') && !document.querySelector('.hm-ex-quality').hidden", timeout=30000)
    assert "now low" in note.inner_text()
    s.grab("Download GLB")
    low = int(re.search(r"([\d,]+) vertices", s.last()).group(1).replace(",", ""))
    s.button("Use high quality").click()
    p.wait_for_function("window.__human.state.quality === 'high' && window.__human.state.rig.quality === 'high' && !window.__human.state.busy", timeout=90000)
    p.wait_for_function("document.querySelector('.hm-ex-quality').hidden", timeout=30000)
    s.grab("Download GLB")
    high = int(re.search(r"([\d,]+) vertices", s.last()).group(1).replace(",", ""))
    assert high > 2 * low, (low, high)
    assert "about" in p.locator(".hm-ex-size").first.inner_text()
    assert s.errors() == [], s.errors()


def test_options_are_remembered(s):
    s.open()
    s.page.locator(".hm-ex").get_by_role("button", name="Metres", exact=True).click()
    s.page.locator(".hm-ex").get_by_role("button", name="mm", exact=True).click()
    s.page.reload()
    s.page.wait_for_function("window.__human && window.__human.state.rig", timeout=90000)
    s.page.get_by_role("tab", name="Export").click()
    s.page.wait_for_selector(".hm-ex .hm-ex-card")
    s.open_sections()
    assert s.page.locator(".hm-ex").get_by_role("button", name="Metres", exact=True).get_attribute("aria-pressed") == "true"
    assert s.page.locator(".hm-ex").get_by_role("button", name="mm", exact=True).get_attribute("aria-pressed") == "true"


def test_png_images(s):
    pil = pytest.importorskip("PIL.Image")
    import numpy as np
    s.open()
    p = s.page
    before = s.js("""() => { const v = window.__human.viewport, r = v.renderer, view = v.getView(); return { w: r.domElement.width, h: r.domElement.height, pr: r.getPixelRatio(), pos: view.position.toArray(), target: view.target.toArray(), aspect: v.camera.aspect, grid: v.floor.children.map((c) => c.visible) }; }""")
    css_w, css_h = s.js("(() => { const c = window.__human.viewport.canvas; return [c.clientWidth, c.clientHeight]; })()")
    name, data = s.grab("Download PNG")
    assert name == f"{SLUG}_neutral-standing_view.png", name
    im = png(data)
    assert im.size == (css_w, css_h), (im.size, css_w, css_h)
    a = np.asarray(im.convert("RGB")).astype(int)
    assert a.std() > 8 and len(np.unique(a.reshape(-1, 3), axis=0)) > 200, "the picture is not blank"
    assert (a.sum(axis=2) < 700).mean() > 0.01, "the figure is in the picture"
    # the viewport was put back: same camera, same buffer, same visibility, and still drawing
    after = s.js("""() => { const v = window.__human.viewport, r = v.renderer, view = v.getView(); return { w: r.domElement.width, h: r.domElement.height, pr: r.getPixelRatio(), pos: view.position.toArray(), target: view.target.toArray(), aspect: v.camera.aspect, grid: v.floor.children.map((c) => c.visible) }; }""")
    assert settle(after) == settle(before), (before, after)
    # 2x, transparent, no grid, no shadow
    p.locator(".hm-ex").get_by_role("button", name="2×").click()
    p.locator(".hm-ex").get_by_role("button", name="Transparent").click()
    p.get_by_label("Grid and axes").uncheck()
    p.get_by_label("Floor shadow").uncheck()
    name, data = s.grab("Download PNG")
    assert name.endswith("_view_2x.png")
    im = png(data)
    assert im.mode == "RGBA" and (im.size == (2 * css_w, 2 * css_h) or max(im.size) == 4096), im.size
    alpha = np.asarray(im)[:, :, 3]
    assert alpha.min() == 0 and alpha.max() == 255, "transparent around the figure, opaque on it"
    assert 0.5 < (alpha == 0).mean() < 0.98, "mostly transparent: no floor, no grid, no background"
    assert ((alpha > 0) & (alpha < 255)).mean() > 0.0005, "soft edges"
    rgb = np.asarray(im)[:, :, :3][alpha == 255]
    assert rgb.std() > 8, "the figure has shading"
    assert "transparent" in s.last()
    # with the grid and the shadow on, a transparent PNG keeps both
    p.get_by_label("Grid and axes").check()
    p.get_by_label("Floor shadow").check()
    _, data = s.grab("Download PNG")
    alpha2 = np.asarray(png(data))[:, :, 3]
    assert (alpha2 > 0).mean() > (alpha > 0).mean() + 0.01, "the grid and the shadow add pixels"
    # four views
    p.locator(".hm-ex").get_by_role("button", name="Scene", exact=True).click()
    p.locator(".hm-ex").get_by_role("button", name="1×").click()
    name, data = s.grab("Download 4 views")
    assert name.endswith("_views.png")
    im = png(data)
    assert im.size == (4 * 480, 640), im.size
    quarters = [np.asarray(im.convert("RGB").crop((i * 480, 0, (i + 1) * 480, 640))).astype(int) for i in range(4)]
    assert all(q.std() > 8 for q in quarters), "no blank cell"
    assert np.abs(quarters[0] - quarters[3]).mean() > 3 and np.abs(quarters[0] - quarters[1]).mean() > 3, "the cells show different views"
    s.shot("export-images-done")
    after = s.js("""() => { const v = window.__human.viewport, r = v.renderer, view = v.getView(); return { w: r.domElement.width, h: r.domElement.height, pr: r.getPixelRatio(), pos: view.position.toArray(), target: view.target.toArray(), aspect: v.camera.aspect, grid: v.floor.children.map((c) => c.visible) }; }""")
    assert settle(after) == settle(before), (before, after)
    # the stage itself is not blank after all that
    stage = np.asarray(pil.open(io.BytesIO(p.locator(".hm-viewport").screenshot())).convert("RGB")).astype(int)
    assert stage.std() > 8
    assert s.errors() == [], s.errors()


def test_posture_file_round_trip_and_bad_files(s, tmp_path):
    s.open()
    p = s.page
    s.js("""() => { const rig = window.__human.state.rig; rig.setAngles({ elbow_L: [90], shoulder_R: [60, 15, 0], hip_L: [40, 5, 0], knee_L: [50, 0] }); rig.setRoot({ heading: 25 }); }""")
    p.wait_for_timeout(300)
    want = s.js("window.__human.state.rig.getPose()")
    name, data = s.grab("Download posture file")
    f = tmp_path / name
    f.write_bytes(data)
    s.js("window.__human.state.rig.resetPose()")
    assert s.js("window.__human.state.rig.getPose().angles.elbow_L[0]") == 0
    p.locator(".hm-ex input[type=file]").first.set_input_files(str(f))
    p.wait_for_function("window.__human.state.rig.getPose().angles.elbow_L[0] === 90", timeout=30000)
    got = s.js("window.__human.state.rig.getPose()")
    for jid in ("elbow_L", "shoulder_R", "hip_L", "knee_L"):
        assert got["angles"][jid] == pytest.approx(want["angles"][jid], abs=1e-4), jid
    assert got["root"]["heading"] == pytest.approx(25, abs=1e-4)
    assert "Loaded the posture" in s.last()
    # damaged files: a plain message, and the figure stays as it is
    bad = {"not json": "{ nope", "a scene": json.dumps({"app": "digital-human-scene", "version": 1, "objects": []}), "unknown joint": json.dumps({"angles": {"elbow": [1]}}),
           "newer": json.dumps({"app": "digital-human-posture", "version": 9, "pose": {}})}
    expect = {"not json": "not valid JSON", "a scene": "not a posture file", "unknown joint": "unknown joint", "newer": "newer version"}
    pose_before = s.js("window.__human.state.rig.getPose()")
    for key, text in bad.items():
        fb = tmp_path / f"{key.replace(' ', '_')}.json"
        fb.write_text(text)
        p.locator(".hm-ex input[type=file]").first.set_input_files(str(fb))
        p.wait_for_selector(".hm-ex-msgs [role=alert]", timeout=30000)
        assert expect[key] in p.locator(".hm-ex-msgs").inner_text(), (key, p.locator(".hm-ex-msgs").inner_text())
        assert s.js("window.__human.state.rig.getPose()") == pose_before
        s.wait_idle()
    # a file of 3 MB is refused before it is read
    big = tmp_path / "big.json"
    big.write_text(" " * 2_500_000 + "{}")
    p.locator(".hm-ex input[type=file]").first.set_input_files(str(big))
    p.wait_for_selector(".hm-ex-msgs [role=alert]", timeout=30000)
    assert "too large" in p.locator(".hm-ex-msgs").inner_text()
    assert s.errors(allow=("Failed to load resource",)) == [], s.errors()


def test_scene_file_and_scene_objects_in_the_exports(s, tmp_path):
    s.open()
    p = s.page
    assert s.button("Download scene file").is_disabled(), "no sandbox yet: nothing to save"
    assert "Scene objects (0)" in p.locator(".hm-ex").inner_text()
    s.js("""async () => { const m = await import('/js/human/sandbox.js'); const sb = m.sandboxFor(window.__human.ctx); sb.add('monitor', { position: [0, 0.74, 1.2], yaw: 180, name: 'Main display' }); sb.add('crate', { position: [1.2, 0, 0], params: { mass: 12.5 } }); }""")
    p.wait_for_selector("text=Scene objects (2)", timeout=10000)
    assert not s.button("Download scene file").is_disabled()
    name, data = s.grab("Download GLB")
    doc, _ = glb(data)
    scene_node = next(n for n in doc["nodes"] if n["name"] == "scene")
    objs = [doc["nodes"][i] for i in scene_node["children"]]
    assert [o["extras"]["digitalHuman"]["type"] for o in objs] == ["monitor", "crate"] and objs[1]["extras"]["digitalHuman"]["params"]["mass"] == 12.5
    name, data = s.grab("Download OBJ")
    assert b"o Main display" in data or b"Main display (mesh" in data
    s.page.get_by_label("The figure (posed skin)").uncheck()
    _, data = s.grab("Download STL")
    assert 84 < len(data) < 400000, "the scene objects alone"
    s.page.get_by_label("The figure (posed skin)").check()
    name, data = s.grab("Download scene file")
    f = tmp_path / name
    f.write_bytes(data)
    doc = json.loads(data)
    assert name == f"{SLUG}_neutral-standing_scene.json" and doc["app"] == "digital-human-scene" and [o["type"] for o in doc["objects"]] == ["monitor", "crate"]
    # clear, load again, load again into the scene
    s.js("import('/js/human/sandbox.js').then((m) => m.peekSandbox(window.__human.ctx).clear())")
    p.wait_for_selector("text=Scene objects (0)", timeout=10000)
    p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(f))
    p.wait_for_selector("text=Scene objects (2)", timeout=30000)
    assert "Loaded 2 objects" in s.last()
    p.get_by_label("Add to the current scene").check()
    p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(f))
    p.wait_for_selector("text=Scene objects (4)", timeout=30000)
    # a broken scene file: a message, the scene stays
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"app": "digital-human-scene", "version": 99, "objects": []}))
    p.locator(".hm-ex input[type=file]").nth(1).set_input_files(str(bad))
    p.wait_for_selector(".hm-ex-msgs [role=alert]", timeout=30000)
    assert "newer version" in p.locator(".hm-ex-msgs").inner_text()
    assert "Scene objects (4)" in p.locator(".hm-ex").inner_text()
    assert s.errors() == [], s.errors()


def test_copy_buttons_and_summary(s):
    s.open()
    p = s.page
    s.button("Copy summary").click()
    p.wait_for_function("() => document.querySelector('.hm-ex-last')?.textContent.includes('Copied the summary')", timeout=30000)
    text = s.js("navigator.clipboard.readText()")
    assert text.startswith("DIGITAL HUMAN SUMMARY") and "United States" in text and "Units: millimetres" in text and "Stature" in text
    p.locator(".hm-ex summary", has_text="Show the summary text").click()
    p.wait_for_function("document.querySelector('.hm-ex-pre').textContent.startsWith('DIGITAL HUMAN SUMMARY')", timeout=30000)
    s.button("Copy", exact=True).click()  # the BVH text
    p.wait_for_function("document.querySelector('.hm-ex-last').textContent.includes('BVH')", timeout=30000)
    assert s.js("navigator.clipboard.readText()").startswith("HIERARCHY")
    s.page.get_by_role("button", name="Copy Joint angles as CSV").click()
    p.wait_for_function("document.querySelector('.hm-ex-last').textContent.includes('CSV')", timeout=30000)
    assert s.js("navigator.clipboard.readText()").startswith("joint_id,joint_label")
    assert s.errors() == [], s.errors()


def test_busy_state_errors_and_keyboard(s):
    s.open()
    p = s.page
    # busy: set synchronously by the click, cleared afterwards
    seen = s.js("""() => new Promise((res) => { const b = [...document.querySelectorAll('.hm-ex button')].find((x) => x.textContent === 'Download BVH'); b.click(); res({ busy: document.querySelector('.hm-ex').getAttribute('aria-busy'), disabledAttr: b.getAttribute('aria-disabled'), text: document.querySelector('.hm-ex-busy').textContent }); })""")
    assert seen["busy"] == "true" and seen["disabledAttr"] == "true" and "BVH" in seen["text"]
    s.wait_idle()
    assert p.locator(".hm-ex-busy").is_hidden()
    # an error shows plainly, the panel recovers
    s.js("() => { window.__realCreate = URL.createObjectURL; URL.createObjectURL = () => { throw new Error('the disk is full'); }; }")
    s.button("Download BVH").click()
    p.wait_for_selector(".hm-ex-msgs [role=alert]", timeout=30000)
    msg = p.locator(".hm-ex-msgs").inner_text()
    assert "did not finish" in msg and "the disk is full" in msg and "TypeError" not in msg and "    at " not in msg, msg
    s.wait_idle()
    s.js("() => { URL.createObjectURL = window.__realCreate; }")
    assert not s.button("Download BVH").is_disabled()
    # keyboard: Tab reaches the buttons, Enter and Space press them
    s.button("Download BVH").focus()
    with p.expect_download(timeout=60000) as info:
        p.keyboard.press("Enter")
    assert info.value.suggested_filename.endswith(".bvh")
    s.wait_idle()
    s.button("Download GLB").focus()
    with p.expect_download(timeout=60000) as info:
        p.keyboard.press("Space")
    assert info.value.suggested_filename.endswith(".glb")
    # every control has a name
    unnamed = s.js("""() => [...document.querySelectorAll('.hm-ex button, .hm-ex input:not([hidden]), .hm-ex select')].filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.closest('.seg')?.getAttribute('aria-label'))).map((e) => e.outerHTML.slice(0, 80))""")
    assert unnamed == [], unnamed
    assert s.errors(allow=("the disk is full",)) == [], s.errors()


def test_mobile_layout_and_screenshots(chromium, server):
    with make_session(chromium, server, width=390, height=800, mobile=True) as s:
        s.open()
        s.page.wait_for_timeout(400)
        assert s.js("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "no horizontal scroll of the page"
        assert s.js("(() => { const e = document.querySelector('.hm-ex'); return e.scrollWidth <= e.clientWidth + 1; })()"), "no horizontal scroll inside the panel"
        wide = s.js("""() => { const vw = document.documentElement.clientWidth; return [...document.querySelectorAll('.hm-ex *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).map((e) => e.tagName + '.' + e.className).slice(0, 5); }""")
        assert wide == [], wide
        small = s.js("""() => [...document.querySelectorAll('.hm-ex button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 24); }).map((b) => b.textContent)""")
        assert small == [], small
        s.shot("export-mobile")
        s.page.locator(".hm-ex").get_by_role("button", name="2×").scroll_into_view_if_needed()
        s.shot("export-mobile-images", ".hm-ex-card:has-text('Images (PNG)')")
        name, data = s.grab("Download GLB")
        assert name.endswith(".glb")
        assert s.errors() == [], s.errors()
    with make_session(chromium, server, width=360, height=700, mobile=True) as s:
        s.open()
        s.page.wait_for_timeout(500)
        assert s.js("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), "no horizontal scroll at 360 px"
        over = s.js("""() => { const e = document.querySelector('.hm-ex'), r = e.getBoundingClientRect(); return { sw: e.scrollWidth, cw: e.clientWidth, out: [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > r.right + 0.5).map((x) => x.tagName + '.' + x.className).slice(0, 6) }; }""")
        assert over["sw"] <= over["cw"] + 1, over


def test_dark_theme(chromium, server):
    with make_session(chromium, server, dark=True) as s:
        s.open()
        bg = s.js("getComputedStyle(document.querySelector('.hm-ex-card')).backgroundColor")
        fg = s.js("getComputedStyle(document.querySelector('.hm-ex-desc')).color")
        nums = lambda c: [int(x) for x in re.findall(r"\d+", c)[:3]]  # noqa: E731
        assert sum(nums(bg)) / 3 < 60, f"dark card {bg}"
        assert sum(nums(fg)) / 3 > 140, f"readable text {fg}"
        primary = s.js("getComputedStyle(document.querySelector('.hm-ex .btn.primary')).backgroundColor")
        assert primary != bg
        s.shot("export-dark")
        _, data = s.grab("Download BVH")
        assert data.startswith(b"HIERARCHY")
        assert s.errors() == [], s.errors()


def test_panel_opened_before_the_figure_exists(s):
    p = s.page
    p.goto(f"{s.base}/#/human?debug")
    p.get_by_role("tab", name="Export").click()  # as early as the tab strip exists: the first figure is still being built
    p.wait_for_selector(".hm-ex .hm-ex-card", timeout=60000)
    p.wait_for_function("window.__human && window.__human.state.rig && !window.__human.state.busy", timeout=90000)
    s.open_sections()
    p.wait_for_function("() => { const b = [...document.querySelectorAll('.hm-ex button')].find((x) => x.textContent === 'Download GLB'); return b && !b.disabled; }", timeout=30000)
    assert "United States" in p.locator(".hm-ex-state").inner_text()
    name, data = s.grab("Download GLB")
    assert data[:4] == b"glTF" and name.endswith("_figure.glb")
    assert s.errors() == [], s.errors()


def test_the_panel_works_without_the_scene_tab_and_hides_cleanly(s):
    s.open()
    p = s.page
    p.get_by_role("tab", name="Profile").click()
    assert p.locator(".hm-ex").is_hidden()
    s.js("window.__human.state.rig.setAngles({ knee_L: [40, 0] })")
    p.get_by_role("tab", name="Export").click()
    p.wait_for_timeout(400)
    _, data = s.grab("Download BVH")
    assert data.startswith(b"HIERARCHY")
    assert s.errors() == [], s.errors()


# ---------------------------------------------------------------------------------------------------------------------------------- Blender
GEN_SAMPLES = r"""
import fs from "node:fs";
import { fitBody } from "{ROOT}/site/js/human/fit.js";
import { percentileProfile } from "{ROOT}/site/js/human/anthro.js";
import { buildRig } from "{ROOT}/site/js/human/rig.js";
import { buildSkin } from "{ROOT}/site/js/human/body.js";
import { expandPosture, placePose } from "{ROOT}/site/js/human/pose.js";
import { JOINTS } from "{ROOT}/site/js/human/skeleton.js";
import * as X from "{ROOT}/site/js/human/export.js";
const OUT = process.argv[2] + "/";
const pop = JSON.parse(fs.readFileSync("{ROOT}/public/api/v1/populations/united-states/army/M.json"));
const profile = percentileProfile(pop, { percentile: 50 });
const rig = buildRig(fitBody(profile, {}), { skinBuilder: buildSkin });
const x = expandPosture({ id: "t", name: "t", category: "Reference", tags: [], description: "d", source: "s", support: "seat+feet", spine: { lumbar: [10, 5, 3] },
  joints: { hip_L: [95, 10, 5], hip_R: [80, -5, 0], knee_LR: [90, 0], shoulder_L: [60, 30, 10], shoulder_R: [20, 80, 0], elbow_L: [80], forearm_L: [30], wrist_R: [20, 10], head: [10, 5, 5] } });
rig.setPose({ root: { ...placePose(rig.restBody, { root: { ...x.root, heading: 35 }, angles: x.angles }, { support: "seat+feet" }) }, angles: x.angles });
const input = { rig, profile, posture: { id: "t", name: "t" } };
const w = (n, d) => fs.writeFileSync(OUT + n, typeof d === "string" ? d : Buffer.from(d));
w("baked.glb", (await X.buildGLB(input, { pose: "baked" })).data);
w("clip.glb", (await X.buildGLB(input, { pose: "clip" })).data);
w("skeleton.glb", (await X.buildGLB(input, { figure: "skeleton" })).data);
w("mm.obj", (await X.buildOBJ(input)).text);
w("zup.obj", (await X.buildOBJ(input, { axes: "z-up" })).text);
w("mm.stl", (await X.buildSTL(input)).data);
w("zup.stl", (await X.buildSTL(input, { axes: "z-up" })).data);
w("cm.bvh", X.buildBVH(input, { neutralFrame: true }).text);
const skin = X.bakeSkin(rig).find((s) => s.name === "skin"), joints = {}, rest = {};
for (const j of JOINTS) { const p = rig.jointWorld(j.id); joints[j.id] = [p.x, p.y, p.z]; rest[j.id] = rig.restBody.positions[j.id]; }
w("expected.json", JSON.stringify({ joints, rest, skin: Array.from(skin.geometry.attributes.position.array) }));
"""

BLENDER_CHECK = r"""
import bpy, json, sys
from mathutils import Vector, kdtree
B = sys.argv[-1] + "/"
E = json.load(open(B + "expected.json")); J = E["joints"]
def reset(): bpy.ops.wm.read_factory_settings(use_empty=True)
G = lambda p: Vector((p[0], -p[2], p[1]))   # the glTF importer's mapping: model (x, y, z) -> Blender (x, -z, y)
exp_skin = [G(E["skin"][i:i + 3]) for i in range(0, len(E["skin"]), 3)]
def pts_of(o): return [o.matrix_world @ v.co for v in o.data.vertices]
def evaluated(o):
    ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get()); me = ev.to_mesh(); p = [ev.matrix_world @ v.co for v in me.vertices]; ev.to_mesh_clear(); return p
def one_way(expected, got):
    kd = kdtree.KDTree(len(got)); [kd.insert(p, i) for i, p in enumerate(got)]; kd.balance(); return max(kd.find(p)[2] for p in expected)
def meshes(): return {o.name: o for o in bpy.data.objects if o.type == "MESH"}
def armature(): return [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
out = {}
reset(); bpy.ops.import_scene.gltf(filepath=B + "baked.glb"); a = armature(); s = bpy.data.objects["skin"]
out["glb_bones"] = sorted(b.name for b in a.data.bones) == sorted(J)
out["glb_skin_modifier"] = [m.type for m in s.modifiers] == ["ARMATURE"] and len(s.vertex_groups) == 77
out["glb_baked_vertices"] = max(one_way(exp_skin, evaluated(s)), one_way(evaluated(s), exp_skin))
out["glb_baked_heads"] = max((a.matrix_world @ a.data.bones[k].head_local - G(v)).length for k, v in J.items())
reset(); bpy.ops.import_scene.gltf(filepath=B + "clip.glb"); a = armature(); s = bpy.data.objects["skin"]
out["glb_clip_rest_heads"] = max((a.matrix_world @ a.data.bones[k].head_local - G(E["rest"][k])).length for k in J)
bpy.context.scene.frame_set(0); bpy.context.view_layer.update()
out["glb_clip_vertices"] = max(one_way(exp_skin, evaluated(s)), one_way(evaluated(s), exp_skin))
out["glb_clip_heads"] = max((a.matrix_world @ a.pose.bones[k].head - G(v)).length for k, v in J.items())
reset(); bpy.ops.import_scene.gltf(filepath=B + "skeleton.glb"); out["glb_skeleton"] = len([o for o in bpy.data.objects if o.type == "ARMATURE"]) == 1 and "skeleton-sticks" in meshes()
reset(); bpy.ops.import_anim.bvh(filepath=B + "cm.bvh", global_scale=0.01)   # every other option at Blender's default
a = armature(); out["bvh_bones"] = len(a.data.bones); out["bvh_mode"] = a.pose.bones["pelvis"].rotation_mode; out["bvh_frames"] = list(a.animation_data.action.frame_range)
bpy.context.scene.frame_set(1); bpy.context.view_layer.update()
out["bvh_frame1"] = max((a.matrix_world @ a.pose.bones[k].head - G(v)).length for k, v in J.items())
bpy.context.scene.frame_set(2); bpy.context.view_layer.update()
out["bvh_frame2_neutral"] = max((a.matrix_world @ a.pose.bones[k].head - G(E["rest"][k])).length for k in J)
reset(); bpy.ops.wm.obj_import(filepath=B + "mm.obj", global_scale=0.001); o = meshes()
out["obj_y_up"] = one_way(exp_skin, pts_of(o["skin"])); out["obj_objects"] = sorted(o)
reset(); bpy.ops.wm.obj_import(filepath=B + "zup.obj", global_scale=0.001, forward_axis="Y", up_axis="Z"); out["obj_z_up"] = one_way(exp_skin, pts_of(meshes()["skin"]))
reset(); bpy.ops.wm.stl_import(filepath=B + "zup.stl", global_scale=0.001); out["stl_z_up"] = one_way(exp_skin, pts_of(list(meshes().values())[0]))
reset(); bpy.ops.wm.stl_import(filepath=B + "mm.stl", global_scale=0.001, forward_axis="NEGATIVE_Z", up_axis="Y"); out["stl_y_up"] = one_way(exp_skin, pts_of(list(meshes().values())[0]))
print("BLENDER_RESULT " + json.dumps(out))
"""


def test_blender_imports_the_files(tmp_path):
    """The files read by Blender's own importers (bpy, Blender as a Python module): glTF, BVH, OBJ and STL put the figure where the exporter says it is.
    Skipped when bpy is not importable (set REQUIRE_BLENDER=1 to fail instead)."""
    import shutil
    import subprocess
    try:
        probe = subprocess.run([sys.executable, "-c", "import bpy"], capture_output=True, timeout=120)
        have = probe.returncode == 0
    except Exception:  # noqa: BLE001
        have = False
    if not have:
        if os.environ.get("REQUIRE_BLENDER") == "1":
            pytest.fail("REQUIRE_BLENDER=1 but bpy cannot be imported", pytrace=False)
        pytest.skip("bpy (Blender as a Python module) is not installed")
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    (tmp_path / "gen.mjs").write_text(GEN_SAMPLES.replace("{ROOT}", str(ROOT)))
    (tmp_path / "check.py").write_text(BLENDER_CHECK)
    r = subprocess.run([node, "--import", str(ROOT / "tests/human3d/register.mjs"), str(tmp_path / "gen.mjs"), str(tmp_path)], capture_output=True, text=True, timeout=300, cwd=ROOT)
    assert r.returncode == 0, r.stderr[-2000:]
    r = subprocess.run([sys.executable, str(tmp_path / "check.py"), str(tmp_path)], capture_output=True, text=True, timeout=600)
    line = next((ln for ln in r.stdout.splitlines() if ln.startswith("BLENDER_RESULT ")), None)
    assert line, (r.stdout[-2000:], r.stderr[-2000:])
    out = json.loads(line[len("BLENDER_RESULT "):])
    assert out["glb_bones"] and out["glb_skin_modifier"] and out["glb_skeleton"], out
    for k in ("glb_baked_vertices", "glb_baked_heads", "glb_clip_rest_heads", "glb_clip_vertices", "glb_clip_heads", "obj_y_up", "obj_z_up", "stl_z_up", "stl_y_up"):
        assert out[k] < 1e-5, f"{k}: {out[k]} m"
    assert out["bvh_bones"] == 77 and out["bvh_mode"] == "ZXY" and out["bvh_frames"] == [1.0, 2.0], out
    assert out["bvh_frame1"] < 3e-5 and out["bvh_frame2_neutral"] < 3e-5, out   # a centimetre file with five decimals
    assert out["obj_objects"] == ["eyes", "skin"], out
