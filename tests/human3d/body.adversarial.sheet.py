"""Figure sheets: python3 tests/human3d/body.adversarial.sheet.py out.png <body> <az,az,...> [--pose p] [--w 1000] [--h 1000] [--el 4] [--dist 4] [--ty 0.9] [--fov 30] [--spec json]
<body>: a name of PEOPLE below, or 'json:{...}'.  Several bodies: name1+name2 (one row each, all cells same az list)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser  # noqa: E402

PEOPLE = {
    "man50": {"pop": "united-states/army/M", "pct": 50}, "woman50": {"pop": "united-states/army/F", "pct": 50},
    "woman5": {"pop": "united-states/army/F", "pct": 5}, "man95": {"pop": "united-states/army/M", "pct": 95},
    "man5": {"pop": "united-states/army/M", "pct": 5}, "woman95": {"pop": "united-states/army/F", "pct": 95},
    "heavy": {"sex": "M", "stature": 1780, "mass": 150}, "thin": {"sex": "M", "stature": 1780, "mass": 52},
    "heavyF": {"sex": "F", "stature": 1650, "mass": 130}, "thinF": {"sex": "F", "stature": 1700, "mass": 45},
    "tall": {"sex": "M", "stature": 2050, "mass": 120}, "short": {"sex": "F", "stature": 1450, "mass": 42},
    "neutral": {"sex": "both", "stature": 1700, "mass": 70}, "stature-only-M": {"sex": "M", "stature": 1750}, "stature-only-F": {"sex": "F", "stature": 1650},
}


def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def main():
    out, bodies, azs = sys.argv[1], sys.argv[2].split("+"), [float(a) for a in sys.argv[3].split(",")]
    W, H, el, dist, ty, fov = arg("--w", 1000, int), arg("--h", 1000, int), arg("--el", 4, float), arg("--dist", 4.0, float), arg("--ty", 0.9, float), arg("--fov", 30, float)
    poses = arg("--pose", "neutral").split("+")
    dark = "--dark" in sys.argv
    tz = arg("--tz", 0.0, float)
    with browser(W, H, dark) as (page, logs):
        page.goto(page.base + f"/__pages/body-demo.html?w={W}&h={H}")
        page.wait_for_function("window.__ready", timeout=60000)
        page.evaluate("window.__demo.clear()")
        n = len(bodies)
        cw, rh = W // len(azs), H // n
        for i, b in enumerate(bodies):
            spec = json.loads(b[5:]) if b.startswith("json:") else PEOPLE[b]
            if "--quality" in sys.argv: spec = {**spec, "quality": arg("--quality", "high")}
            if "--wire" in sys.argv: spec = {**spec, "wire": True}
            info = page.evaluate(f"(async () => await window.__demo.setBody({json.dumps(spec)}))()")
            p = poses[i % len(poses)]
            p = json.loads(p) if p.startswith("{") else p
            cl = page.evaluate(f"(() => window.__demo.pose({json.dumps(p)}))()")
            print(b, info, "clamped" if cl else "", cl or "")
            for j, az in enumerate(azs):
                tgt = [0, ty, tz]
                if "--tjs" in sys.argv:
                    tgt = page.evaluate(arg("--tjs", ""))
                page.evaluate(f"window.__demo.view({json.dumps({'rect': [j * cw, i * rh, cw, rh], 'az': az, 'el': el, 'dist': dist, 'target': tgt, 'fov': fov, 'background': '--nobg' not in sys.argv})})")
        page.locator("#c").screenshot(path=out)
        for l in logs:
            print(l)


main()
