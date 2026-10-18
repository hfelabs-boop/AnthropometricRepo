"""Contact sheet of the posture library (POSTURES.md): every posture, front and side view, of a 50th-percentile male and female (stature-only bodies of 1.75 m
and 1.62 m, as the demo page builds them), one row per posture: the author must look at it. Renders with tests/human3d/pages/pose-demo.html in headless Chromium.

    python3 tests/human3d/contact_sheet.py out.png [--ids iso-7250-sitting,t-pose] [--category Sitting] [--size 260] [--proxies]
Each cell is labelled with the posture id; a row whose validatePosture result is not ok on either body is marked in red with the first error. Needs Pillow.
Exit code 1 when a posture is not valid or the page raised an error. Prints the verdicts, one line per posture and body.
"""
import argparse
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser  # noqa: E402

BODIES = [("M", 1.75, "man P50"), ("F", 1.62, "woman P50")]
VIEWS = [("front", {"az": 0}), ("side", {"az": 90})]


def render(page, sex, stature, ids, size, proxies):
    """{ id: { "ok", "errors", "cells": [PNG bytes front, PNG bytes side] } } for one body."""
    page.goto(f"{page.base}/__pages/pose-demo.html?sex={sex}&stature={stature}&size={size}")
    page.wait_for_function("window.__ready", timeout=60000)
    out = {}
    for pid in ids:
        cells, verdict = [], None
        for _, view in VIEWS:
            opts = json.dumps({**view, "dist": 4.0, "proxies": proxies})
            verdict = page.evaluate(f"(() => {{ const r = window.__demo.library({json.dumps(pid)}, {opts}); return {{ ok: r.ok, errors: r.errors }}; }})()")
            cells.append(page.locator("#c").screenshot())
        out[pid] = {"ok": verdict["ok"], "errors": verdict["errors"], "cells": cells}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--ids", help="comma-separated posture ids (default: the whole library)")
    ap.add_argument("--category", help="only this category (the name, e.g. Sitting)")
    ap.add_argument("--size", type=int, default=260, help="side of one view in pixels")
    ap.add_argument("--proxies", action="store_true", help="draw the collision capsules as well")
    a = ap.parse_args()
    from PIL import Image, ImageDraw

    with browser(900, 900) as (page, logs):
        page.goto(f"{page.base}/__pages/pose-demo.html?size=64")
        page.wait_for_function("window.__ready", timeout=60000)
        library = page.evaluate("import('/js/human/postures.js').then((m) => m.POSTURES.map((p) => ({ id: p.id, category: p.category })))")
        ids = [p["id"] for p in library if (not a.category or p["category"] == a.category)]
        if a.ids:
            wanted = a.ids.split(",")
            missing = [i for i in wanted if i not in ids]
            if missing:
                sys.exit(f"unknown posture ids: {', '.join(missing)}")
            ids = wanted
        if not ids:
            sys.exit("no postures selected")
        shots = [(label, render(page, sex, stature, ids, a.size, a.proxies)) for sex, stature, label in BODIES]
        bad = 0
        n = len(VIEWS) * len(BODIES)
        label_h = 34
        sheet = Image.new("RGB", (a.size * n, (a.size + label_h) * len(ids)), (236, 235, 230))
        draw = ImageDraw.Draw(sheet)
        for row, pid in enumerate(ids):
            y = row * (a.size + label_h)
            col = 0
            failed = [(label, r[pid]["errors"][0]) for label, r in shots if not r[pid]["ok"]]
            for label, r in shots:
                print(f"{label:10s} {pid:40s} {'ok' if r[pid]['ok'] else 'NOT OK: ' + r[pid]['errors'][0]}")
                for cell in r[pid]["cells"]:
                    sheet.paste(Image.open(io.BytesIO(cell)).convert("RGB").resize((a.size, a.size)), (col * a.size, y + label_h))
                    col += 1
            bad += bool(failed)
            draw.rectangle([0, y, a.size * n, y + label_h - 1], fill=(120, 30, 30) if failed else (60, 60, 56))
            draw.text((6, y + 4), pid + ("   " + failed[0][0] + ": " + failed[0][1][:150] if failed else ""), fill=(255, 255, 255))
            draw.text((6, y + 18), "  |  ".join(f"{label} {v}" for _, _, label in BODIES for v, _ in VIEWS), fill=(200, 200, 195))
        sheet.save(a.out)
        for line in logs:
            print(line)
        print(f"{len(ids)} postures, {bad} not valid -> {a.out}")
        sys.exit(1 if bad or any(l.startswith("[pageerror]") for l in logs) else 0)


if __name__ == "__main__":
    main()
