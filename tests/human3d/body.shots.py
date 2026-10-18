"""Figure sheets for the skin generator (body.js): python3 tests/human3d/body.shots.py <sheet> <out.png> [--dark] [--w 1000] [--h 700]
Sheets: people (P50 man and woman, P5 woman, P95 man, heavy, thin: front/side/back), head (close-ups), hands, feet, poses.
Each sheet is one screenshot of tests/human3d/pages/body-demo.html (headless Chromium, SwiftShader)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser  # noqa: E402

PEOPLE = {
    "man50": {"pop": "united-states/army/M", "pct": 50},
    "woman50": {"pop": "united-states/army/F", "pct": 50},
    "woman5": {"pop": "united-states/army/F", "pct": 5},
    "man95": {"pop": "united-states/army/M", "pct": 95},
    "heavy": {"sex": "M", "stature": 1780, "mass": 150},
    "thin": {"sex": "M", "stature": 1780, "mass": 52},
    "tall": {"sex": "M", "stature": 2050, "mass": 120},
    "short": {"sex": "F", "stature": 1450, "mass": 42},
}


def run(page, js):
    return page.evaluate(js)


def sheet(page, name, W, H):
    D = "window.__demo"
    def call(expr):
        return page.evaluate(f"(async () => {{ const r = await ({expr}); return r === undefined ? null : r; }})()")
    if name == "people":
        # rows of people, 3 views each (front, side, back), cell width = W/3 per person
        who = sys.argv[-1].split(",") if sys.argv[-1] in PEOPLE or "," in sys.argv[-1] else ["man50", "woman50", "woman5", "man95", "heavy", "thin"]
        n = len(who)
        cols = 3 if n > 2 else n
        cw, ch = W // cols, H // ((n + cols - 1) // cols)
        for i, k in enumerate(who):
            info = call(f"{D}.setBody({json.dumps(PEOPLE[k])})")
            call(f"{D}.pose('neutral')")
            r, c = divmod(i, cols)
            # one person per cell, three views side by side inside it
            vw = cw // 3
            for j, az in enumerate((0, 90, 180)):
                call(f"{D}.view({{rect: [{c*cw + j*vw}, {r*ch}, {vw}, {ch}], az: {az}, el: 4, dist: 4.6, target: [0, {info['stature']/2}, 0]}})")
            print(k, info)
    elif name == "head":
        who = ["man50", "woman50"]
        for i, k in enumerate(who):
            info = call(f"{D}.setBody({json.dumps(PEOPLE[k])})")
            call(f"{D}.pose('neutral')")
            hy = info["stature"] - 0.1
            for j, az in enumerate((0, 35, 90, 180)):
                call(f"{D}.view({{rect: [{j*W//4}, {i*H//2}, {W//4}, {H//2}], az: {az}, el: 3, dist: 0.9, target: [0, {hy}, 0.02], fov: 25, background: false}})")
    elif name == "hands":
        info = call(f"{D}.setBody({json.dumps(PEOPLE['man50'])})")
        fist = {f"{f}_mcp_L": [85, 0] for f in ("index", "middle", "ring", "little")}
        fist.update({f"{f}_pip_L": [100] for f in ("index", "middle", "ring", "little")})
        fist.update({f"{f}_dip_L": [70] for f in ("index", "middle", "ring", "little")})
        fist.update({"thumb_cmc_L": [30, 20], "thumb_mcp_L": [40], "thumb_ip_L": [50]})
        cases = [("palm up", {"shoulder_L": [90, 0, 0], "forearm_L": [-90]}, 75, 0), ("back of the hand", {"shoulder_L": [90, 0, 0], "forearm_L": [90]}, 75, 0),
                 ("side", {"shoulder_L": [90, 0, 0]}, 5, -90), ("fist, back", {"shoulder_L": [90, 0, 0], "forearm_L": [90], **fist}, 70, 0),
                 ("fist, side", {"shoulder_L": [90, 0, 0], **fist}, 5, -90), ("fist, front", {"shoulder_L": [90, 0, 0], "forearm_L": [90], **fist}, 20, 20)]
        for i, (label, ang, el, az) in enumerate(cases):
            call(f"{D}.pose({json.dumps({'angles': ang})})")
            tgt = call(f"(() => {{ const v = {D}.rig.jointWorld('wrist_L'); return [v.x, v.y, v.z + 0.07]; }})()")
            call(f"{D}.view({{rect: [{(i%3)*W//3}, {(i//3)*H//2}, {W//3}, {H//2}], az: {az}, el: {el}, dist: 0.6, target: {json.dumps(tgt)}, fov: 25, background: false}})")
    elif name == "feet":
        info = call(f"{D}.setBody({json.dumps(PEOPLE['man50'])})")
        call(f"{D}.pose('neutral')")
        views = [(35, 25), (90, 5), (0, 5), (180, 20), (-90, 5), (0, 80)]
        for j, (az, el) in enumerate(views):
            call(f"{D}.view({{rect: [{(j%3)*W//3}, {(j//3)*H//2}, {W//3}, {H//2}], az: {az}, el: {el}, dist: 0.9, target: [0.086, 0.07, 0.07], fov: 25, background: false}})")
    elif name == "poses":
        names = sys.argv[-1].split(",") if not sys.argv[-1].startswith("-") and not sys.argv[-1].isdigit() and len(sys.argv) > 3 else ["squat", "armUp", "elbow140", "bend", "seated", "kneel"]
        info = call(f"{D}.setBody({json.dumps(PEOPLE['man50'])})")
        n = len(names)
        cols = 3 if n > 3 else n
        rows = (n + cols - 1) // cols
        cw, ch = W // cols, H // rows
        for i, p in enumerate(names):
            clamped = call(f"{D}.pose({json.dumps(p)})")
            r, c = divmod(i, cols)
            az = 90 if p in ("squat", "bend", "seated", "kneel", "neck") else 25
            el = 6
            target = "[0, 0.85, 0]"
            call(f"{D}.view({{rect: [{c*cw}, {r*ch}, {cw}, {ch}], az: {az}, el: {el}, dist: 4.4, target: {target}}})")
            print(p, "clamped:", clamped)
    elif name == "closeups":
        # (pose, az, el, dist, target) for the extreme postures; one cell each
        info = call(f"{D}.setBody({json.dumps(PEOPLE['man50'])})")
        table = [("bend", 90, 5, 3.2, [0, 0.8, 0.35]), ("kneel", 90, 5, 2.4, [0, 0.6, 0]), ("lying", 20, 35, 3.6, [0, 0.1, 0.3]), ("neck", 60, 5, 1.0, [0, 1.55, 0.05]),
                 ("wrist", 35, 10, 1.1, [0.2, 0.9, 0.1]), ("plantar", 60, 10, 1.1, [0.09, 0.2, 0.1]), ("seated", 90, 5, 3.0, [0, 0.7, 0.2]), ("pronation", 40, 15, 1.4, [0.2, 1.1, 0.35])]
        cols = 4
        cw, ch = W // cols, H // 2
        for i, (pose, az, el, dist, tgt) in enumerate(table):
            clamped = call(f"{D}.pose({json.dumps(pose)})")
            r, c = divmod(i, cols)
            call(f"{D}.view({{rect: [{c*cw}, {r*ch}, {cw}, {ch}], az: {az}, el: {el}, dist: {dist}, target: {json.dumps(tgt)}, fov: 30}})")
    elif name == "subjects":
        # real people from a JSON file {name: profile} (made by a Node script from the database): front, 3/4 and back of each
        subj = json.load(open(sys.argv[-1]))
        names = list(subj)
        cols = min(len(names), 4)
        rows_ = (len(names) + cols - 1) // cols
        cw, ch = W // cols, H // rows_
        for i, k in enumerate(names):
            info = call(f"{D}.setBody({json.dumps({'profile': subj[k]})})")
            call(f"{D}.pose('neutral')")
            r, c = divmod(i, cols)
            vw = cw // 2
            for j, az in enumerate((0, 150)):
                call(f"{D}.view({{rect: [{c*cw + j*vw}, {r*ch}, {vw}, {ch}], az: {az}, el: 4, dist: 4.4, target: [0, {info['stature']/2}, 0]}})")
            print(k, info)
    elif name == "custom":
        # custom <out> --w --h custom 'JSON' : { body: spec, pose: name|obj, views: [{rect, az, el, dist, target, fov}] }
        cfg = json.loads(sys.argv[-1])
        call(f"{D}.setBody({json.dumps(cfg['body'])})")
        clamped = call(f"{D}.pose({json.dumps(cfg.get('pose', 'neutral'))})")
        print("clamped:", clamped)
        for v in cfg["views"]:
            call(f"{D}.view({json.dumps(v)})")
    else:
        raise SystemExit(f"unknown sheet {name}")


def main():
    name, out = sys.argv[1], sys.argv[2]
    dark = "--dark" in sys.argv
    W = int(sys.argv[sys.argv.index("--w") + 1]) if "--w" in sys.argv else 1000
    H = int(sys.argv[sys.argv.index("--h") + 1]) if "--h" in sys.argv else 700
    with browser(W, H, dark) as (page, logs):
        page.goto(page.base + f"/__pages/body-demo.html?w={W}&h={H}")
        page.wait_for_function("window.__ready", timeout=60000)
        page.evaluate("window.__demo.clear()")
        sheet(page, name, W, H)
        page.locator("#c").screenshot(path=out)
        for l in logs:
            print(l)


if __name__ == "__main__":
    main()
