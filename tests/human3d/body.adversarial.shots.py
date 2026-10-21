"""Adversarial figure sheets for body.js, driven through tests/human3d/pages/body-demo.html (window.__demo).
    python3 tests/human3d/body.adversarial.shots.py <job.json> <out.png> [--w 1000] [--h 700] [--dark]
job.json: { "cells": [ { "body": spec, "pose": name|obj, "view": { rect:[x,y,w,h], az, el, dist, target, fov, background } , "label": "..."}, ... ] }
spec/pose/view as in body-demo.html. Cells are drawn in order into one canvas."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser  # noqa: E402


def main():
    job = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    W = int(sys.argv[sys.argv.index("--w") + 1]) if "--w" in sys.argv else 1000
    H = int(sys.argv[sys.argv.index("--h") + 1]) if "--h" in sys.argv else 700
    dark = "--dark" in sys.argv
    with browser(W, H, dark) as (page, logs):
        page.goto(page.base + f"/__pages/body-demo.html?w={W}&h={H}")
        page.wait_for_function("window.__ready", timeout=60000)
        page.evaluate("window.__demo.clear()")
        last = None
        for c in job["cells"]:
            if c.get("body") is not None and c["body"] != last:
                info = page.evaluate(f"(async () => await window.__demo.setBody({json.dumps(c['body'])}))()")
                last = c["body"]
                print(c.get("label", ""), info)
            if c.get("pose") is not None or c.get("body") is not None:
                cl = page.evaluate(f"(() => window.__demo.pose({json.dumps(c.get('pose', 'neutral'))}))()")
                if cl:
                    print("  clamped:", cl)
            v = dict(c["view"])
            tgt = c.get("target_js")
            if tgt:
                v["target"] = page.evaluate(tgt)
            page.evaluate(f"window.__demo.view({json.dumps(v)})")
        page.locator("#c").screenshot(path=out)
        for l in logs:
            print(l)


if __name__ == "__main__":
    main()
