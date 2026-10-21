"""Contact sheet of postures (docs/human3d/CONTACT_SHEETS.md): the tool a posture author uses to LOOK at a posture, on one or several bodies, in several views.

    python3 tests/human3d/contact_sheet.py --ids sit-upright-90,stand-neutral --out sheet.png
    python3 tests/human3d/contact_sheet.py --group Sitting --body united-states/army/M:50 --body united-states/army/F:50 --out sitting.png
    python3 tests/human3d/contact_sheet.py --file my-postures.json --out draft.png        # array of Posture objects, not registered anywhere
    python3 tests/human3d/contact_sheet.py --all --out all.png                            # the whole library: all-01.png, all-02.png, ... (12 cells each)

Selection: --ids a,b (library ids), --group NAME (a category: Sitting, "Lifting & carrying", or its id), --all, --file postures.json; they add up.
Bodies: --body COUNTRY/ROLE/SEX[:PERCENTILE] (a populations file of api/v1, percentile 1..99, default united-states/army/M:50; repeat for several bodies, drawn
side by side) or --body stature:1750[:M|F[:kg]]. The form (male / female) follows the sex of the population.
Layout: --views front,side (front back side left right top iso), --cols 4, --cell 240 (px, the 3D square of one cell; labels are drawn above it), --max-cells 12 (a sheet is
split into several PNGs above that), --elev 10 (camera elevation in degrees for the horizontal views; 0 = true elevations), --fit-each (frame every cell on its own figure;
default: one scale for the whole run, floors on one baseline, so sizes can be compared), --dark, --labels (also name the clamped joints and mark the supporting contacts),
--skeleton (joint and bone view instead of the skin), --quality high|low (skin resolution).
Output: PNGs (--out sheet.png; with several sheets sheet-01.png, sheet-02.png, ...), and on STDOUT one JSON line per (posture, body):
    {"type":"posture","id","body","category","support","ok","errors","warnings","gaps" (mm, per support carrier; + floats, - sinks),"balanceMargin" (mm, + inside the support
     polygon; null when the rule does not apply),"clamped" (ROM clamps),"sheet" (file)}
and one {"type":"sheet","file","width","height","cells"} per PNG. Progress and page messages go to stderr. Exit code 1 if the page raised an error (and, with --strict, if any
posture is not ok); 2 for a usage error.
"""
import argparse
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PAGE = "/__pages/contact-sheet.html"
DEFAULT_BODY = "united-states/army/M:50"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Contact sheet of postures (see the module docstring and docs/human3d/CONTACT_SHEETS.md)")
    ap.add_argument("--out", required=True, help="PNG to write (several sheets: name-01.png, name-02.png, ...)")
    ap.add_argument("--ids", help="comma-separated posture ids of the library")
    ap.add_argument("--group", action="append", help="a category of the library (name or id), repeatable")
    ap.add_argument("--all", action="store_true", help="every posture of the library")
    ap.add_argument("--file", action="append", help="JSON file with an array of Posture objects (validated and drawn without registering them), repeatable")
    ap.add_argument("--body", action="append", help=f"COUNTRY/ROLE/SEX[:PERCENTILE] or stature:MM[:M|F[:KG]]; repeatable (default {DEFAULT_BODY})")
    ap.add_argument("--views", default="front,side", help="comma-separated: front back side left right top iso (default front,side)")
    ap.add_argument("--cols", type=int, default=4, help="cells per row (default 4)")
    ap.add_argument("--cell", type=int, default=240, help="side of the 3D square of a cell in pixels (default 240)")
    ap.add_argument("--max-cells", type=int, default=12, help="cells per PNG (default 12)")
    ap.add_argument("--elev", type=float, default=10, help="camera elevation in degrees for front/back/side views (default 10, 0 = true elevations)")
    ap.add_argument("--fit-each", action="store_true", help="frame every cell on its own figure instead of one common scale")
    ap.add_argument("--dark", action="store_true", help="dark theme")
    ap.add_argument("--labels", action="store_true", help="also name the joints clamped by their range of motion and mark the supporting contacts")
    ap.add_argument("--skeleton", action="store_true", help="draw the skeleton and joints instead of the skin")
    ap.add_argument("--quality", choices=["low", "high"], default="low", help="skin resolution (default low: enough for 240 px cells)")
    ap.add_argument("--fail-skin", action="store_true", help=argparse.SUPPRESS)  # test hook: the skin builder throws, the sheet must fall back to the skeleton view
    ap.add_argument("--strict", action="store_true", help="exit code 1 when a posture is not ok")
    ap.add_argument("--quiet", action="store_true", help="no progress on stderr")
    a = ap.parse_args(argv)
    if not (a.ids or a.group or a.all or a.file):
        ap.error("choose postures: --ids, --group, --all or --file")
    if a.cell < 120 or a.cols < 1 or a.max_cells < 1:
        ap.error("--cell must be at least 120, --cols and --max-cells at least 1")
    a.views = [v.strip() for v in a.views.split(",") if v.strip()]
    if not a.views:
        ap.error("--views is empty")
    return a


def load_files(paths):
    out = []
    for path in paths or []:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            sys.exit(f"cannot read {path}: {e}")
        if isinstance(data, dict) and "postures" in data:
            data = data["postures"]
        if isinstance(data, dict) and "id" in data:
            data = [data]
        if not isinstance(data, list) or not all(isinstance(p, dict) for p in data):
            sys.exit(f"{path}: expected an array of Posture objects")
        out.extend(data)
    return out


def sheet_names(out, n):
    """One name per sheet: out itself for one sheet, name-01.png ... for several."""
    p = Path(out)
    if n == 1:
        return [p]
    width = max(2, len(str(n)))
    return [p.with_name(f"{p.stem}-{i + 1:0{width}d}{p.suffix or '.png'}") for i in range(n)]


def make_config(a, files):
    return {
        "bodies": a.body or [DEFAULT_BODY],
        "ids": [s for s in (a.ids or "").split(",") if s.strip()],
        "group": None, "all": a.all, "file": files, "views": a.views,
        "cell": a.cell, "cols": a.cols, "maxCells": a.max_cells, "elev": a.elev, "fitEach": a.fit_each,
        "dark": a.dark, "labels": a.labels, "skeleton": a.skeleton, "quality": a.quality, "failSkin": a.fail_skin,
    }


def run(a, log=lambda *x: None):
    """Render the sheets; returns { "records": [...], "sheets": [{ file, width, height, cells }], "info": {...} }. Raises RuntimeError with a plain message on failure."""
    from shot import browser

    files = load_files(a.file)
    cfg = make_config(a, files)
    result = {"records": [], "sheets": [], "info": {}, "logs": []}
    with browser(1000, 800, dark=a.dark) as (page, logs):
        page.set_default_timeout(300000)
        page.goto(page.base + PAGE)
        page.wait_for_function("window.__ready === true", timeout=60000)
        t0 = time.time()
        if a.group and len(a.group) > 1:  # the page takes one group: the ids of the others are asked of the library here
            extra = page.evaluate(
                "async (names) => { const m = await import('/js/human/postures.js'); const g = (n) => m.CATEGORIES.find((c) => c.id === n.toLowerCase() || c.name.toLowerCase() === n.toLowerCase());"
                " return names.flatMap((n) => { const c = g(n); if (!c) throw new Error('unknown group ' + n); return m.POSTURES.filter((p) => p.category === c.name).map((p) => p.id); }); }", a.group[1:])
            cfg["ids"] += extra
        cfg["group"] = a.group[0] if a.group else None
        log(f"preparing ({len(cfg['bodies'])} bodies, views {','.join(a.views)})")
        try:
            prep = page.evaluate("(cfg) => window.__sheet.prepare(cfg)", cfg)
        except Exception as e:  # noqa: BLE001 - a bad body spec, view or file reaches us as a page exception: report its first line, not the stack
            first = str(e).strip().splitlines()[0]
            raise RuntimeError(first.removeprefix("Page.evaluate: ").removeprefix("Error: ")) from None
        if prep["errors"]:
            raise RuntimeError("; ".join(prep["errors"]))
        t_prep = time.time() - t0
        names = sheet_names(a.out, len(prep["sheets"]))
        for info, path in zip(prep["sheets"], names):
            ts = time.time()
            url = page.evaluate("(i) => window.__sheet.render(i)", info["index"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(url.split(",", 1)[1]))
            result["sheets"].append({"type": "sheet", "file": str(path), "width": info["width"], "height": info["height"], "cells": info["cells"], "cols": info["cols"], "rows": info["rows"],
                                     "cell": info["cell"], "labelHeight": info["labelHeight"]})
            log(f"{path} ({info['cells']} cells, {info['width']}x{info['height']}) in {time.time() - ts:.1f} s")
        for r in prep["records"]:
            result["records"].append({
                "type": "posture", "id": r["id"], "body": r["body"], "category": r["category"], "support": r["support"], "source": r["source"], "ok": r["ok"],
                "errors": r["errors"], "warnings": r["warnings"], "gaps": r["gaps"], "balanceMargin": r["balanceMargin"], "clamped": r["clamped"], "views": r["views"],
                "sheet": str(names[r["sheet"]]) if r["sheet"] >= 0 else None})
        result["info"] = {k: prep[k] for k in ("bodies", "scalePxPerM", "widestM", "tallestM", "timing", "library", "libraryError") if k in prep}
        result["info"]["totalS"] = round(time.time() - t0, 1)
        result["info"]["prepareS"] = round(t_prep, 1)
        result["logs"] = list(logs)
    return result


def main(argv=None):
    a = parse_args(argv)
    log = (lambda *x: None) if a.quiet else (lambda *x: print(*x, file=sys.stderr, flush=True))
    try:
        res = run(a, log)
    except RuntimeError as e:
        print(f"contact_sheet: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - playwright / page errors: say what and fail
        print(f"contact_sheet: {type(e).__name__}: {str(e)[:600]}", file=sys.stderr)
        return 1
    for r in res["records"]:
        print(json.dumps(r, separators=(",", ":")))
    for s in res["sheets"]:
        print(json.dumps(s, separators=(",", ":")))
    for b in res["info"].get("bodies", []):
        if b.get("note"):
            print(f"note: body {b['spec']}: {b['note']}", file=sys.stderr)
    page_errors = [line for line in res["logs"] if line.startswith("[pageerror]") or line.startswith("[error]")]
    for line in page_errors:
        print(line, file=sys.stderr)
    bad = sum(not r["ok"] for r in res["records"])
    log(f"{len(res['records'])} posture/body pairs, {bad} not ok, {len(res['sheets'])} sheet(s), {res['info']['totalS']} s")
    return 1 if page_errors or (a.strict and bad) else 0


if __name__ == "__main__":
    sys.exit(main())
