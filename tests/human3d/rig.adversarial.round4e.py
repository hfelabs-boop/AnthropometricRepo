"""Round-4: forearm pronation close-ups (radius / ulna at the wrist). python3 tests/human3d/rig.adversarial.round4e.py <outdir>"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
JS = """(a)=>{const [p, view] = a; window.A.pose({angles:{shoulder_L:[20,0,0], elbow_L:[10], forearm_L:[p], wrist_L:[0,0]}});
  const v=window.A.rig.jointWorld('wrist_L'); const e=window.A.rig.jointWorld('elbow_L');
  const t=[(v.x+e.x)/2,(v.y+e.y)/2,(v.z+e.z)/2];
  window.A.sheet([{...view, target:t}],{cols:1, display:{skeleton:true,joints:false,axes:false,landmarks:false}});}"""
with browser(700, 700) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?fit=1&w=700&h=700")
    page.wait_for_function("window.__ready", timeout=60000)
    for p in (-80, 0, 80):
        for nm, view in (("front", dict(az=0, el=0, dist=0.55)), ("side", dict(az=90, el=10, dist=0.55))):
            page.evaluate(JS, [p, view])
            page.wait_for_timeout(100)
            page.locator("#c").screenshot(path=str(out / f"fa-{nm}-{p}.png"))
    print("\n".join(logs))
