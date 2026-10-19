"""Browser tests of the contact-sheet renderer (tests/human3d/contact_sheet.py, pages/contact-sheet.html, docs/human3d/CONTACT_SHEETS.md): the real CLI, the real
rig, skin and validator, headless Chromium with WebGL (SwiftShader). About a minute for the whole file.

    python -m pytest tests/human3d/test_contact_sheet.py -q
    REQUIRE_BROWSER=1 python -m pytest tests/human3d/test_contact_sheet.py   # fail instead of skip when Playwright / Chromium / Pillow is missing
    HM_SHOT_DIR=/some/dir ...                                                # keep the sheets there; default: a temp dir of the test run
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REQUIRE = os.environ.get("REQUIRE_BROWSER") == "1"
LIBRARY = ["iso-7250-standing", "iso-7250-sitting", "t-pose"]  # what the library holds today; the tests use only these (the library grows)

try:  # noqa: SIM105
    import playwright.sync_api  # noqa: F401
    import shot
    from PIL import Image
    _IMPORT_ERROR = None
except Exception as e:  # Playwright or Pillow not installed
    shot = Image = None
    _IMPORT_ERROR = e


def _unavailable(reason):
    if REQUIRE:
        pytest.fail(f"REQUIRE_BROWSER=1 but the browser tests cannot run: {reason}", pytrace=False)
    pytest.skip(f"browser tests skipped: {reason} (set REQUIRE_BROWSER=1 to make this a failure)", allow_module_level=True)


if _IMPORT_ERROR is not None:
    _unavailable(f"Playwright or Pillow is not importable ({_IMPORT_ERROR})")
if not Path(shot.CHROME).exists():
    _unavailable(f"no Chromium at {shot.CHROME} (set CHROMIUM=/path/to/chrome)")

CELL_BG = {False: (247, 246, 242), True: (29, 29, 27)}  # light / dark cell background of the page


@pytest.fixture(scope="session")
def outdir():
    keep = os.environ.get("HM_SHOT_DIR")
    if keep:
        Path(keep).mkdir(parents=True, exist_ok=True)
        yield Path(keep)
    else:
        with tempfile.TemporaryDirectory(prefix="hm-contact-") as d:
            yield Path(d)


def cli(*args, expect=0):
    """Run the CLI; returns (records, sheets, stderr). Asserts the exit code."""
    p = subprocess.run([sys.executable, str(HERE / "contact_sheet.py"), *map(str, args)], capture_output=True, text=True, timeout=600)
    assert p.returncode == expect, f"exit code {p.returncode}, expected {expect}\nstdout: {p.stdout[-1500:]}\nstderr: {p.stderr[-1500:]}"
    lines = [json.loads(line) for line in p.stdout.splitlines() if line.strip()]  # stdout is JSON lines only
    return [x for x in lines if x["type"] == "posture"], [x for x in lines if x["type"] == "sheet"], p.stderr


def cell_rect(sheet, index):
    """(x, y, w, h) of the 3D square of cell `index` (labels sit above it) in the PNG."""
    c, lab = sheet["cell"], sheet["labelHeight"]
    return (index % sheet["cols"]) * c, (index // sheet["cols"]) * (c + lab) + lab, c, c


def warm(px):  # the skin colour: R > G > B, a few tens apart (the floor, the grid and the text are grey; the centre of mass red, the seat orange, the polygon blue)
    r, g, b = px[:3]
    return 17 <= r - b <= 48 and b <= g <= r and 90 <= r <= 240


def figure_rows(img, rect):
    """First and last row (inside the cell) with a good number of skin-coloured pixels, and the number of such pixels."""
    x0, y0, w, h = rect
    px = img.load()
    rows = [sum(warm(px[x, y]) for x in range(x0 + 3, x0 + w - 3)) for y in range(y0 + 3, y0 + h - 3)]  # inside the frame
    hit = [i + 3 for i, n in enumerate(rows) if n >= 3]
    return (hit[0], hit[-1], sum(rows)) if hit else (None, None, 0)


@pytest.fixture(scope="session")
def library_sheet(outdir):
    """The 3 library postures on two bodies, default views: the main sheet of the tests."""
    out = outdir / "library.png"
    records, sheets, err = cli("--ids", ",".join(LIBRARY), "--body", "united-states/army/M:50", "--body", "united-states/army/F:50", "--out", out)
    return out, records, sheets, err


def test_library_sheet_file_size_and_summary(library_sheet):
    out, records, sheets, err = library_sheet
    assert len(sheets) == 1 and Path(sheets[0]["file"]) == out and out.exists()
    s = sheets[0]
    assert s["cells"] == 3 * 2 * 2  # postures x bodies x views
    img = Image.open(out)
    assert img.size == (s["width"], s["height"])
    # 4 columns of 240 px; 3 rows of a 240 px square plus its label
    assert s["width"] == 4 * 240 and s["height"] == 3 * (240 + s["labelHeight"]) and s["cols"] == 4 and s["rows"] == 3
    # one JSON line per (posture, body), ids and bodies as asked, in the documented shape
    assert [(r["id"], r["body"]) for r in records] == [(i, b) for i in LIBRARY for b in ("united-states/army/M:50", "united-states/army/F:50")]
    for r in records:
        assert r["ok"] is True and r["errors"] == [], r
        assert set(r["gaps"]) == ({"feet"} if r["support"] == "feet" else {"seat", "feet"}), r
        assert all(abs(v) < 0.5 for v in r["gaps"].values()), r  # mm: the library postures touch their supports
        assert isinstance(r["balanceMargin"], (int, float)) and r["balanceMargin"] > 0, r
        assert r["sheet"] == str(out) and r["views"] == ["front", "side"] and r["clamped"] == []
    assert "Traceback" not in err


def test_library_sheet_is_not_blank_and_every_cell_has_a_figure(library_sheet):
    out, _, sheets, _ = library_sheet
    img = Image.open(out).convert("RGB")
    assert len(img.getcolors(maxcolors=10**6)) > 200, "the sheet has hardly any colours: blank"
    for i in range(sheets[0]["cells"]):
        top, bottom, n = figure_rows(img, cell_rect(sheets[0], i))
        assert top is not None and n > 800, f"cell {i} has no figure ({n} skin pixels)"
        assert top >= 2 and bottom <= sheets[0]["cell"] - 3, f"cell {i}: the figure touches the frame (rows {top}..{bottom})"
    # the labels: the dark text of the id and the green OK badges are in the label strip of the first cell
    lab = img.crop((0, 0, sheets[0]["cell"], sheets[0]["labelHeight"]))
    cols = lab.getcolors(10000)
    assert any(c[1][1] > c[1][0] + 60 for c in cols if c[0] > 150), "no green verdict badge in the label"
    assert any(sum(c[1]) < 150 for c in cols), "no dark text in the label"


def test_seat_slab_and_floor_line_are_drawn(library_sheet):
    out, _, sheets, _ = library_sheet
    img = Image.open(out).convert("RGB")
    px = img.load()
    orange = lambda p: p[0] > 200 and 120 < p[1] < 205 and p[2] < 175 and p[0] - p[2] > 60 and p[1] - p[2] > 25  # noqa: E731 - the translucent seat slab over the light cell
    seated, standing = [4, 5, 6, 7], [0, 1, 2, 3]  # cells go posture by posture, then body, then view: 4 cells per posture
    def count(i):
        x0, y0, w, h = cell_rect(sheets[0], i)
        return sum(orange(px[x, y]) for x in range(x0, x0 + w) for y in range(y0, y0 + h))

    assert all(count(i) > 60 for i in seated), [count(i) for i in seated]
    assert all(count(i) < 20 for i in standing), [count(i) for i in standing]


def test_common_scale_between_bodies_and_fit_each(outdir):
    """Default: one scale for the whole sheet, so a 1.90 m body is taller than a 1.50 m one in the picture; --fit-each frames each cell on its own figure."""
    args = ["--ids", "iso-7250-standing", "--body", "stature:1500:F", "--body", "stature:1900:M", "--views", "front", "--cols", "2"]
    heights = {}
    for name, extra in (("common", []), ("each", ["--fit-each"])):
        out = outdir / f"scale-{name}.png"
        _, sheets, _ = cli(*args, *extra, "--out", out)
        img = Image.open(out).convert("RGB")
        hs = []
        for i in range(2):
            top, bottom, _n = figure_rows(img, cell_rect(sheets[0], i))
            hs.append(bottom - top)
        heights[name] = hs
    ratio = heights["common"][1] / heights["common"][0]
    assert 1.15 < ratio < 1.40, f"1.90 m / 1.50 m should be about 1.27 at a common scale, got {ratio:.2f} ({heights['common']})"
    ratio_each = heights["each"][1] / heights["each"][0]
    assert 0.9 < ratio_each < 1.1, f"--fit-each should frame both figures alike, got {ratio_each:.2f} ({heights['each']})"


def test_drafted_postures_from_a_file_are_validated_not_registered(outdir):
    """--file: Posture objects outside the library. A good one passes, a floating one fails with the gap in mm, a clamped one shows its ROM clamp, a broken one has no figure."""
    base = {"category": "Sitting", "tags": ["seat"], "description": "A drafted posture for the contact sheet test.", "source": "illustrative", "support": "seat+feet",
            "grips": {"L": "relaxed", "R": "relaxed"}}
    drafts = [
        {**base, "id": "draft-sit-ok", "name": "Draft seated", "joints": {"hip_LR": [90, 0, 0], "knee_LR": [90, 0]}},
        {**base, "id": "draft-sit-floats", "name": "Draft floating feet", "joints": {"hip_LR": [90, 0, 0], "knee_LR": [60, 0]}},
        {**base, "id": "draft-rom", "name": "Draft out of range", "category": "Standing", "support": "feet", "joints": {"shoulder_R": [200, 0, 0]}},
        {**base, "id": "draft-broken", "name": "Draft broken", "category": "Standing", "support": "feet", "joints": {"hip": [1, 2, 3]}},
        {**base, "id": "iso-7250-sitting", "name": "Same id as the library", "joints": {"hip_LR": [90, 0, 0], "knee_LR": [90, 0]}},
    ]
    f = outdir / "drafts.json"
    f.write_text(json.dumps(drafts))
    out = outdir / "drafts.png"
    records, sheets, _ = cli("--file", f, "--labels", "--out", out)
    by = {r["id"]: r for r in records}
    assert list(by) == [d["id"] for d in drafts] and all(r["source"] == "file" for r in records)
    assert by["draft-sit-ok"]["ok"] and by["draft-sit-ok"]["gaps"] == {"seat": 0, "feet": 0}
    fl = by["draft-sit-floats"]
    assert not fl["ok"] and 40 < fl["gaps"]["feet"] < 70 and "contact set \"feet\"" in fl["errors"][0], fl
    assert not by["draft-rom"]["ok"] and by["draft-rom"]["clamped"] == [{"joint": "shoulder_R", "dof": "flex", "requested": 200, "applied": 180}]
    assert not by["draft-broken"]["ok"] and "unknown joint id" in by["draft-broken"]["errors"][0] and by["draft-broken"]["gaps"] == {}
    assert any("also in the library" in w for w in by["iso-7250-sitting"]["warnings"]), "an id of the library must be flagged, the file is not registered"
    # nothing was added to the library: the same call by id still finds the 3 postures only
    img = Image.open(out).convert("RGB")
    assert img.size == (sheets[0]["width"], sheets[0]["height"])
    # red frames of the failing cells, orange ring of the clamped shoulder
    px = img.load()
    red = sum(1 for x in range(img.width) for y in range(0, img.height, 2) if px[x, y][0] > 180 and px[x, y][1] < 60 and px[x, y][2] < 60)
    assert red > 1500, "failing cells must be framed in red"


def test_lying_postures_are_seen_from_above_not_along_the_body(outdir):
    """support "body": a front or back view would look along the body, so it becomes a top view (head up the page); the side views stay."""
    supine = {"id": "draft-supine", "name": "Draft supine", "category": "Lying", "tags": ["lying"], "description": "Lying on the back, arms at the sides, for the contact sheet test.",
              "source": "illustrative", "support": "body", "root": {"flex": -90}, "grips": {"L": "relaxed", "R": "relaxed"}, "hints": {"dynamic": True}}
    f = outdir / "supine.json"
    f.write_text(json.dumps([supine]))
    out = outdir / "supine.png"
    records, sheets, _ = cli("--file", f, "--views", "front,back,side", "--out", out)
    assert records[0]["views"] == ["top", "side"] and sheets[0]["cells"] == 2, records[0]
    img = Image.open(out).convert("RGB")
    rows = [figure_rows(img, cell_rect(sheets[0], i)) for i in range(2)]
    assert all(r[2] > 500 for r in rows)
    # from above the body is long and narrow along the page (head up), from the side it is long and low: the side view is wider than tall, the top view taller than wide
    px = img.load()
    def cols(i):
        x0, y0, w, h = cell_rect(sheets[0], i)
        hit = [x for x in range(x0 + 3, x0 + w - 3) if sum(warm(px[x, y]) for y in range(y0 + 3, y0 + h - 3)) >= 3]
        return hit[-1] - hit[0]
    assert rows[0][1] - rows[0][0] > cols(0) * 1.5, "top view: the lying body runs up the page"
    assert cols(1) > (rows[1][1] - rows[1][0]) * 3, "side view: the lying body runs along the page"


def test_chunking_and_naming(outdir):
    """More cells than --max-cells: several PNGs, a posture never split when it fits, every record names its sheet."""
    out = outdir / "chunk.png"
    records, sheets, _ = cli("--ids", ",".join(LIBRARY), "--max-cells", 4, "--cols", 2, "--out", out)
    assert [Path(s["file"]).name for s in sheets] == ["chunk-01.png", "chunk-02.png"]
    assert [s["cells"] for s in sheets] == [4, 2]
    for s in sheets:
        assert Path(s["file"]).exists() and Image.open(s["file"]).size == (s["width"], s["height"])
    assert [Path(r["sheet"]).name for r in records] == ["chunk-01.png", "chunk-01.png", "chunk-02.png"]


def test_dark_theme_and_views_from_above(outdir):
    out = outdir / "dark.png"
    records, sheets, _ = cli("--ids", "iso-7250-sitting", "--views", "front,top,iso", "--dark", "--cell", 200, "--out", out)
    img = Image.open(out).convert("RGB")
    assert img.getpixel((6, sheets[0]["labelHeight"] + 6)) == CELL_BG[True], "dark cell background"
    assert sheets[0]["width"] == 3 * 200 and records[0]["views"] == ["front", "top", "iso"]
    for i in range(3):
        assert figure_rows(img, cell_rect(sheets[0], i))[2] > 300, f"cell {i}"


def test_skeleton_fallback_when_the_skin_fails(outdir):
    out = outdir / "fallback.png"
    records, sheets, err = cli("--ids", "iso-7250-standing", "--fail-skin", "--out", out)
    assert "skeleton view" in err and records[0]["ok"]
    img = Image.open(out).convert("RGB")
    assert len(img.getcolors(maxcolors=10**6)) > 100


def test_usage_errors_are_plain(outdir):
    out = outdir / "x.png"
    _, _, err = cli("--out", out, expect=2)
    assert "choose postures" in err
    _, _, err = cli("--ids", "no-such-posture", "--out", out, expect=2)
    assert 'unknown posture id "no-such-posture"' in err and "Traceback" not in err
    _, _, err = cli("--group", "Nothing", "--out", out, expect=2)
    assert "unknown group" in err
    _, _, err = cli("--ids", "t-pose", "--body", "atlantis/army/M:50", "--out", out, expect=2)
    assert "no populations file atlantis/army/M" in err
    _, _, err = cli("--ids", "t-pose", "--views", "sideways", "--out", out, expect=2)
    assert "unknown view" in err
    assert not out.exists()


def test_group_and_all_select_from_the_library(outdir):
    records, sheets, _ = cli("--group", "Reference", "--out", outdir / "group.png")
    assert {r["id"] for r in records} >= set(LIBRARY) and all(r["category"] == "Reference" for r in records)
    all_records, all_sheets, _ = cli("--all", "--out", outdir / "all.png", "--views", "side")
    assert {r["id"] for r in all_records} >= set(LIBRARY)
    assert sum(s["cells"] for s in all_sheets) == len(all_records)
    assert all(s["cells"] <= 12 for s in all_sheets)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
