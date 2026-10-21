"""Ribs vs sternum under thoracic bending.  python3 tests/human3d/rig.adversarial.ribs.py <outdir>"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
with browser(1000, 800) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800")
    page.wait_for_function("window.__ready", timeout=60000)
    cases = {"flex45": {"spine": {"thoracic": [45, 0, 0]}}, "lat25": {"spine": {"thoracic": [0, 25, 0]}}, "rot40": {"spine": {"thoracic": [0, 0, 40]}}}
    for name, pz in cases.items():
        views = [dict(az=90, el=5, dist=1.1, target=[0, 1.25, 0.05]), dict(az=0, el=5, dist=1.1, target=[0, 1.25, 0.05]), dict(az=40, el=20, dist=1.1, target=[0, 1.25, 0.05]), dict(az=0, el=75, dist=1.1, target=[0, 1.3, 0.05])]
        page.evaluate("(a)=>window.A.sheet(a[1],{poseName:a[0],cols:2,display:{skeleton:true,joints:false,axes:false}})", [pz, views])
        page.wait_for_timeout(120)
        page.locator("#c").screenshot(path=str(out / f"ribs-{name}.png"))
    print("\n".join(logs))
