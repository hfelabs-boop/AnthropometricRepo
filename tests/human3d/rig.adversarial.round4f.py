"""Round-4: selection / hover visuals close-up. python3 tests/human3d/rig.adversarial.round4f.py <outdir> [dark]"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from shot import browser
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dark = len(sys.argv) > 2 and sys.argv[2] == "dark"
sfx = "-dark" if dark else ""
JS = """(a)=>{const [sel, hov, view] = a; const A = window.A; A.pose({}); A.rig.highlight(hov);
  const v=A.rig.jointWorld(sel); A.sheet([{...view, target:[v.x,v.y,v.z]}],{cols:1, select: sel, display:{skeleton:true,joints:true,axes:true,labels:false,landmarks:false}});}"""
with browser(700, 600, dark=dark) as (page, logs):
    page.goto(page.base + "/__pages/rig.adversarial.html?fit=1&w=700&h=600")
    page.wait_for_function("window.__ready", timeout=60000)
    for sel, hov, view in (("L3", "L4", dict(az=40, el=10, dist=0.7)), ("shoulder_L", "elbow_L", dict(az=30, el=15, dist=0.8)), ("hip_R", "knee_R", dict(az=-30, el=10, dist=0.9)), ("index_pip_L", "index_mcp_L", dict(az=30, el=30, dist=0.35)), ("head", "C1", dict(az=60, el=10, dist=0.8))):
        page.evaluate(JS, [sel, hov, view])
        page.wait_for_timeout(100)
        page.locator("#c").screenshot(path=str(out / f"sel-{sel}{sfx}.png"))
    print("\n".join(logs))
