"""Forearm pronation: the ulna against the wrist.  python3 tests/human3d/rig.adversarial.pron.py <out.png>"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
with browser(1000, 800) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?w=1000&h=800")
    page.wait_for_function("window.__ready", timeout=60000)
    views = []
    for p in (-90, 0, 90):
        page.evaluate("(p)=>window.A.pose({angles:{elbow_L:[10], forearm_L:[p]}})", p)
        t = page.evaluate("()=>{const v=window.A.rig.jointWorld('wrist_L');return [v.x,v.y,v.z]}")
        views.append((p, t))
    # one tile per pronation angle: re-pose before each render
    tiles = []
    for i, (p, t) in enumerate(views):
        page.evaluate("(a)=>{window.A.pose({angles:{elbow_L:[10], forearm_L:[a[0]]}}); window.A.sheet([{az:0,el:0,dist:0.5,target:a[1]}],{cols:1,display:{skeleton:true,joints:false,axes:false}});}", [p, t])
        page.wait_for_timeout(100)
        page.locator("#c").screenshot(path=sys.argv[1].replace(".png", f"-{p}.png"))
    print("\n".join(logs))
