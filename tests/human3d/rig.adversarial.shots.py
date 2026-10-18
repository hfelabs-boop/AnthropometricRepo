"""Verifier screenshots + GPU leak check for rig.js.  python3 tests/human3d/rig.adversarial.shots.py <outdir> [dark]"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
suffix = "-dark" if dark else ""
FA = [dict(az=0, el=4, dist=3.6), dict(az=90, el=4, dist=3.6)]
FB = [dict(az=180, el=4, dist=3.6), dict(az=0, el=89, dist=3.2, target=[0, 0.5, 0])]

def run(page, name, views, js_opts, cols=2, w=1000, h=650):
    page.evaluate("(a)=>{const [v,o]=a; window.__r=window.A.sheet(v,o);}", [views, js_opts | {"cols": cols}])
    page.wait_for_timeout(200)
    page.locator("#c").screenshot(path=str(out / f"{name}{suffix}.png"))

with browser(1000, 650, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html" + (sys.argv[3] if len(sys.argv) > 3 else ""))
    page.wait_for_function("window.__ready", timeout=60000)
    mode = {"skeleton": True, "joints": False, "axes": False, "landmarks": False}
    for p in (sys.argv[4].split(",") if len(sys.argv) > 4 else ["neutral", "seated", "squat", "armsUp", "bend", "supine", "prone", "twist", "footFlex"]):
        run(page, f"{p}-fs", FA, {"poseName": p, "display": mode})
        run(page, f"{p}-bt", FB, {"poseName": p, "display": mode})
    print("\n".join(logs))
